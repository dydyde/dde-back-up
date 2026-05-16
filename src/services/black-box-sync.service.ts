/**
 * 黑匣子同步服务
 *
 * 负责黑匣子条目的离线同步
 * 遵循 Offline-first：IndexedDB 持久化 + RetryQueue 集成
 * 冲突解决：LWW (Last-Write-Wins)
 *
 * 【数据安全设计】
 * - 所有条目先写入 IndexedDB，再推送到服务器
 * - 通过 retryQueueHandler 集成到主同步体系的 RetryQueue（持久化队列）
 * - 推送失败时自动进入 RetryQueue，浏览器崩溃/刷新后不丢失
 * - 启动时扫描 IndexedDB 中 syncStatus=pending 的条目，恢复未完成的同步
 */

import { Injectable, inject, DestroyRef, effect } from '@angular/core';
import type { RealtimeChannel } from '@supabase/supabase-js';
import type { Json } from '../types/supabase';
import { BlackBoxEntry } from '../models/focus';
import { FOCUS_CONFIG } from '../config/focus.config';
import { SYNC_CONFIG } from '../config/sync.config';
import { APP_LIFECYCLE_CONFIG } from '../config/app-lifecycle.config';
import { FEATURE_FLAGS } from '../config/feature-flags.config';
import { isValidUUID } from '../utils/validation';
import { supabaseErrorToError } from '../utils/supabase-error';
import { openIndexedDBAdaptive } from '../utils/indexeddb-open';
import {
  isBrowserNetworkSuspendedError,
  isBrowserNetworkSuspendedWindow,
} from '../utils/browser-network-suspension';
import {
  blackBoxEntriesMap,
  gateState,
  setBlackBoxEntries,
  updateBlackBoxEntry,
} from '../state/focus-stores';
import { SupabaseClientService } from './supabase-client.service';
import { NetworkAwarenessService } from './network-awareness.service';
import { LoggerService } from './logger.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { AuthService } from './auth.service';
import { ClockSyncService } from './clock-sync.service';
import { SyncRpcClientService, type SyncRpcResult } from './sync-rpc-client.service';
import { SessionManagerService } from '../core-bridge';
import { AUTH_CONFIG } from '../config/auth.config';

/**
 * IndexedDB 中的黑匣子条目格式
 */
interface IDBBlackBoxEntry extends BlackBoxEntry {
  /** 本地版本号，用于冲突检测 */
  _localVersion?: number;
}

interface BlackBoxSyncCursor {
  updatedAt: string;
  id: string;
}

/**
 * RetryQueue 回调接口
 * 由 SimpleSyncService 通过 setRetryQueueHandler 注入
 */
type RetryQueueHandler = (entry: BlackBoxEntry) => void;
const BLACKBOX_RPC_REMOTE_NEWER_RECONCILE_REASON = 'rpc-remote-newer';
const BLACKBOX_RPC_STALE_PAYLOAD_RECONCILE_REASON = 'rpc-stale-payload';
type BlackBoxRemoteReconcileReason =
  | typeof BLACKBOX_RPC_REMOTE_NEWER_RECONCILE_REASON
  | typeof BLACKBOX_RPC_STALE_PAYLOAD_RECONCILE_REASON;

export interface PullChangesOptions {
  reason?: 'startup' | 'resume' | 'manual' | 'panel-open' | 'gate-review';
  force?: boolean;
  expectedUserId?: string;
  expectedRealtimeGeneration?: number;
}

@Injectable({
  providedIn: 'root'
})
export class BlackBoxSyncService {
  private static readonly REALTIME_CIRCUIT_STORAGE_KEY = 'nanoflow.realtime-transport-circuit';
  private static readonly REALTIME_CIRCUIT_TTL_MS = 30 * 60 * 1000;
  private static readonly REALTIME_MAX_CONSECUTIVE_ERRORS = 3;

  private supabase = inject(SupabaseClientService);
  private network = inject(NetworkAwarenessService);
  private auth = inject(AuthService);
  private readonly clockSync = inject(ClockSyncService);
  private readonly sessionManager = inject(SessionManagerService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('BlackBoxSync');
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly syncRpcClient = inject(SyncRpcClientService, { optional: true });
  private readonly destroyRef = inject(DestroyRef);

  private db: IDBDatabase | null = null;
  private lastSyncTime: string | null = null;
  private lastSyncCursor: BlackBoxSyncCursor | null = null;

  /** RetryQueue 集成回调，由 SimpleSyncService 注入 */
  private retryQueueHandler: RetryQueueHandler | null = null;

  /** 防抖定时器（合并短时间内的多次写入） */
  private pushDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingPushEntries: Map<string, BlackBoxEntry> = new Map();
  private shouldRecoverAfterAuthSettles = false;

  // 防重保护：single-flight + freshness window
  private pullInFlight: Promise<boolean> | null = null;
  private activePullOptions: PullChangesOptions | null = null;
  private queuedForcedGateReviewPullPromise: Promise<void> | null = null;
  private queuedForcedGateReviewPullGuard: Pick<PullChangesOptions, 'expectedUserId' | 'expectedRealtimeGeneration'> | null = null;
  private queuedForcedGateReviewPullVersion = 0;
  /** 上次成功拉取的时间戳（毫秒），用于 freshness window 判断 */
  private lastPullTime = 0;
  private lastResumePullAt = 0;
  private currentSyncUserId: string | null = null;

  private readonly IDB_NAME = FOCUS_CONFIG.SYNC.IDB_NAME;
  private readonly IDB_VERSION = FOCUS_CONFIG.SYNC.IDB_VERSION;
  private readonly STORE_NAME = FOCUS_CONFIG.IDB_STORES.BLACK_BOX_ENTRIES;
  private readonly DEBOUNCE_DELAY = SYNC_CONFIG.DEBOUNCE_DELAY;
  private readonly BLACKBOX_PULL_PAGE_SIZE = 200;
  private readonly BLACKBOX_PULL_MAX_PAGES = 10;
  private readonly BLACKBOX_PULL_MAX_DURATION_MS = 20_000;
  private readonly BLACKBOX_ENTRY_SELECT_COLUMNS =
    'id, project_id, user_id, content, focus_meta, date, created_at, updated_at, is_read, is_completed, is_archived, snooze_until, snooze_count, deleted_at';
  private initIndexedDBPromise: Promise<void> | null = null;
  private realtimeChannel: RealtimeChannel | null = null;
  private realtimeSubscribedUserId: string | null = null;
  private realtimeDesiredUserId: string | null = null;
  private realtimeSubscriptionGeneration = 0;
  private realtimeConsecutiveErrors = 0;
  private realtimeCircuitRetryTimer: ReturnType<typeof setTimeout> | null = null;

  private isRemoteUnavailable(): boolean {
    const maybeSignal = (this.supabase as unknown as { isOfflineMode?: (() => boolean) | boolean }).isOfflineMode;
    if (typeof maybeSignal === 'function') {
      try {
        return Boolean(maybeSignal());
      } catch {
        return false;
      }
    }
    return Boolean(maybeSignal);
  }

  private getRealtimeCircuitSnapshot(userId: string): {
    remainingMs: number;
    failures: number;
    lastError: string | null;
  } {
    if (typeof window === 'undefined' || typeof window.sessionStorage === 'undefined') {
      return { remainingMs: 0, failures: 0, lastError: null };
    }

    try {
      const stored = window.sessionStorage.getItem(BlackBoxSyncService.REALTIME_CIRCUIT_STORAGE_KEY);
      if (!stored) {
        return { remainingMs: 0, failures: 0, lastError: null };
      }

      const parsed = JSON.parse(stored) as {
        until?: number;
        ownerUserId?: string | null;
        failures?: number;
        lastError?: string | null;
      };

      if (typeof parsed.until !== 'number' || parsed.until <= Date.now()) {
        window.sessionStorage.removeItem(BlackBoxSyncService.REALTIME_CIRCUIT_STORAGE_KEY);
        return { remainingMs: 0, failures: 0, lastError: null };
      }

      if (typeof parsed.ownerUserId === 'string' && parsed.ownerUserId !== userId) {
        return { remainingMs: 0, failures: 0, lastError: null };
      }

      return {
        remainingMs: Math.max(0, parsed.until - Date.now()),
        failures: typeof parsed.failures === 'number' ? parsed.failures : 0,
        lastError: typeof parsed.lastError === 'string' ? parsed.lastError : null,
      };
    } catch {
      return { remainingMs: 0, failures: 0, lastError: null };
    }
  }

  private armRealtimeCircuit(userId: string, errorMessage: string | undefined, consecutiveErrors: number): number {
    const now = Date.now();
    const current = this.getRealtimeCircuitSnapshot(userId);
    const until = now + Math.max(current.remainingMs, BlackBoxSyncService.REALTIME_CIRCUIT_TTL_MS);

    if (typeof window !== 'undefined' && typeof window.sessionStorage !== 'undefined') {
      try {
        window.sessionStorage.setItem(BlackBoxSyncService.REALTIME_CIRCUIT_STORAGE_KEY, JSON.stringify({
          until,
          ownerUserId: userId,
          failures: Math.max(current.failures, consecutiveErrors),
          lastError: errorMessage ?? current.lastError,
          lastToastAt: 0,
        }));
      } catch {
        // sessionStorage 不可写时保留内存态退化即可。
      }
    }

    return until - now;
  }

  private clearRealtimeCircuitRetryTimer(): void {
    if (this.realtimeCircuitRetryTimer === null) {
      return;
    }

    clearTimeout(this.realtimeCircuitRetryTimer);
    this.realtimeCircuitRetryTimer = null;
  }

  private scheduleRealtimeCircuitRetry(
    userId: string,
    delayMs: number,
    generation: number,
  ): void {
    this.clearRealtimeCircuitRetryTimer();
    this.realtimeCircuitRetryTimer = setTimeout(() => {
      this.realtimeCircuitRetryTimer = null;
      if (this.realtimeDesiredUserId !== userId) {
        return;
      }

      if (generation != this.realtimeSubscriptionGeneration) {
        return;
      }

      const retryGeneration = ++this.realtimeSubscriptionGeneration;
      queueMicrotask(() => {
        void this.syncRealtimeSubscription(userId, retryGeneration);
      });
    }, Math.max(0, delayMs));
  }

  constructor() {
    // 初始化 IndexedDB
    void this.initIndexedDB().catch(error => {
      this.logger.warn('Initial IndexedDB setup deferred', error instanceof Error ? error.message : String(error));
    });

    // 监听网络状态变化
    this.setupNetworkListener();

    effect(() => {
      const authSettling = this.isAuthSettling();
      const currentUserId = this.auth.currentUserId();

      if (authSettling) {
        this.shouldRecoverAfterAuthSettles = true;
        return;
      }

      if (!this.retryQueueHandler || !this.shouldRecoverAfterAuthSettles || !currentUserId) {
        return;
      }

      this.shouldRecoverAfterAuthSettles = false;
      this.logger.debug('Auth settled, replay pending black box recovery');
      void this.recoverPendingEntries();
    });

    effect(() => {
      const nextSyncUserId = this.resolveRemoteSessionUserId();
      if (this.currentSyncUserId === nextSyncUserId) {
        return;
      }

      queueMicrotask(() => {
        void this.syncCursorScope(nextSyncUserId);
      });
    });

    effect(() => {
      const authSettling = this.isAuthSettling();
      const currentUserId = this.auth.currentUserId();
      const gateReviewing = gateState() === 'reviewing';
      const online = this.network.isOnline();
      const shouldSubscribe = FEATURE_FLAGS.REALTIME_ENABLED
        && gateReviewing
        && online
        && this.supabase.isConfigured
        && !this.isRemoteUnavailable()
        && !authSettling
        && !!currentUserId;
      const nextRealtimeUserId = shouldSubscribe ? currentUserId : null;

      if (this.realtimeDesiredUserId === nextRealtimeUserId) {
        return;
      }

      this.realtimeDesiredUserId = nextRealtimeUserId;
      const generation = ++this.realtimeSubscriptionGeneration;

      queueMicrotask(() => {
        void this.syncRealtimeSubscription(
          nextRealtimeUserId,
          generation,
        );
      });
    });
  }
  private readonly SYNC_METADATA_STORE = FOCUS_CONFIG.IDB_STORES.SYNC_METADATA;
  private readonly LAST_SYNC_TIME_KEY_PREFIX = 'black_box_last_sync_time';

  private getLastSyncTimeKey(userId: string): string {
    return `${this.LAST_SYNC_TIME_KEY_PREFIX}:${userId}`;
  }

  private parseStoredSyncCursor(value: unknown): BlackBoxSyncCursor | null {
    if (typeof value === 'string' && value) {
      return { updatedAt: value, id: '' };
    }
    if (value && typeof value === 'object') {
      const record = value as { updatedAt?: unknown; id?: unknown };
      if (typeof record.updatedAt === 'string' && typeof record.id === 'string') {
        return { updatedAt: record.updatedAt, id: record.id };
      }
    }
    return null;
  }

  private compareBlackBoxCursor(left: BlackBoxSyncCursor, right: BlackBoxSyncCursor): number {
    const leftTime = new Date(left.updatedAt).getTime();
    const rightTime = new Date(right.updatedAt).getTime();
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
      return leftTime - rightTime;
    }
    return left.id.localeCompare(right.id);
  }

  private computeBlackBoxCursorFromRows(rows: Array<Record<string, unknown>>): BlackBoxSyncCursor | null {
    let nextCursor: BlackBoxSyncCursor | null = null;
    for (const row of rows) {
      if (typeof row['updated_at'] !== 'string' || typeof row['id'] !== 'string') {
        continue;
      }
      const candidate = { updatedAt: row['updated_at'], id: row['id'] };
      if (!nextCursor || this.compareBlackBoxCursor(candidate, nextCursor) > 0) {
        nextCursor = candidate;
      }
    }

    return nextCursor;
  }

  private async commitBlackBoxCursorFromRows(rows: Array<Record<string, unknown>>): Promise<void> {
    const nextCursor = this.computeBlackBoxCursorFromRows(rows);
    await this.commitBlackBoxCursor(nextCursor);
  }

  private async commitBlackBoxCursor(nextCursor: BlackBoxSyncCursor | null): Promise<void> {
    if (!nextCursor) return;
    if (this.lastSyncCursor && this.compareBlackBoxCursor(nextCursor, this.lastSyncCursor) < 0) {
      this.sentryLazyLoader.addBreadcrumb({
        category: 'sync',
        message: 'blackbox.cursor_commit_ignored_stale',
        level: 'info',
        data: { existing: this.lastSyncCursor, candidate: nextCursor },
      });
      return;
    }

    const committed = await this.persistBlackBoxCursorIfNewer(nextCursor);
    if (!committed) return;

    this.lastSyncCursor = committed;
    this.lastSyncTime = committed.updatedAt;
  }

  // ==================== RetryQueue 集成 ====================

  /**
   * 设置 RetryQueue 处理器
   * 由 SimpleSyncService 在初始化时调用，将黑匣子同步集成到主同步体系
   */
  setRetryQueueHandler(handler: RetryQueueHandler): void {
    this.retryQueueHandler = handler;

    // 处理器就绪后，恢复 IndexedDB 中未同步的条目到 RetryQueue
    void this.recoverPendingEntries();
  }

  /**
   * 从 IndexedDB 恢复 syncStatus=pending 的条目到 RetryQueue
   * 防止浏览器崩溃/刷新导致数据丢失
   */
  private async recoverPendingEntries(): Promise<void> {
    if (!this.retryQueueHandler) return;

    if (this.supabase.isConfigured && this.network.isOnline() && this.isAuthSettling()) {
      this.shouldRecoverAfterAuthSettles = true;
      this.logger.debug('Auth still settling, defer black box pending recovery');
      return;
    }

    try {
      const entries = await this.loadFromLocal();

      // 第一步：主动扫描并删除所有含非法 UUID 字段的条目（不限 syncStatus）
      for (const entry of entries) {
        const hasInvalidId = !entry.id || !isValidUUID(entry.id);
        const hasInvalidProjectId =
          entry.projectId !== null &&
          entry.projectId !== undefined &&
          !isValidUUID(entry.projectId);
        if (hasInvalidId || hasInvalidProjectId) {
          this.logger.warn(`启动清理：删除非法 UUID 条目 id="${entry.id}", projectId="${entry.projectId}"`);
          try { await this.deleteFromLocal(entry.id); } catch { /* 忽略 */ }
        }
      }

      // 第二步：先对账远端权威状态，再只恢复真正仍待补推的 pending 条目。
      // 否则 stale tab / 旧设备遗留的本地 pending 会在启动瞬间整批灌入 RetryQueue，
      // 既抬高“待同步”数字，也会在缺少并发保护时把旧状态重新推回云端。
      const validPending = await this.resolvePendingEntriesForRecovery(entries);

      // 【2026-05-11 根因修复·路径 A·配套】先按当前会话过滤掉 owner-mismatch 的 pending，
      // 同样走 selfHealOwnerMismatchedEntry，避免它们在 RetryQueue 里被静默吞掉后 IDB
      // 一直挂着 pending，UI 长期显示 待同步。
      const sessionUserId = this.resolveRemoteSessionUserId();
      const recoverable: BlackBoxEntry[] = [];
      for (const entry of validPending) {
        if (sessionUserId && entry.userId !== sessionUserId) {
          await this.selfHealOwnerMismatchedEntry(entry, sessionUserId, undefined);
          continue;
        }
        recoverable.push(entry);
      }

      if (recoverable.length > 0) {
        this.logger.info(`Recovering ${recoverable.length} pending entries to RetryQueue`);
        for (const entry of recoverable) {
          this.retryQueueHandler(entry);
        }
      }
    } catch (e) {
      this.logger.error('Failed to recover pending entries', e instanceof Error ? e.message : String(e));
    }
  }

  private getValidPendingEntries(entries: BlackBoxEntry[]): BlackBoxEntry[] {
    return entries.filter(
      entry =>
        entry.syncStatus === 'pending' &&
        entry.id &&
        isValidUUID(entry.id) &&
        (entry.projectId == null || isValidUUID(entry.projectId))
    );
  }

  private async resolvePendingEntriesForRecovery(entries: BlackBoxEntry[]): Promise<BlackBoxEntry[]> {
    const validPending = this.getValidPendingEntries(entries);
    if (validPending.length === 0) {
      return validPending;
    }

    const expectedUserId = this.resolveRemoteSessionUserId();

    if (
      !this.supabase.isConfigured
      || this.isRemoteUnavailable()
      || !this.network.isOnline()
      || this.isAuthSettling()
      || !expectedUserId
    ) {
      return validPending;
    }

    try {
      const client = await this.supabase.clientAsync();
      if (!client) {
        return validPending;
      }

      await this.reconcilePendingEntriesWithServer(
        client,
        false,
        false,
        expectedUserId,
        undefined,
        validPending,
      );
      return this.getValidPendingEntries(
        validPending.map(entry => blackBoxEntriesMap().get(entry.id) ?? entry),
      );
    } catch (error) {
      this.logger.debug('启动前置黑匣子 pending 对账失败，降级为原始恢复路径', {
        error: error instanceof Error ? error.message : String(error),
        pendingCount: validPending.length,
      });
      return validPending;
    }
  }

  /**
   * 初始化 IndexedDB
   */
  private async initIndexedDB(): Promise<void> {
    if (this.db) return;
    if (this.initIndexedDBPromise) return this.initIndexedDBPromise;

    this.initIndexedDBPromise = (async () => {
      try {
        this.db = await openIndexedDBAdaptive({
          dbName: this.IDB_NAME,
          targetVersion: this.IDB_VERSION,
          requiredStores: [
            this.STORE_NAME,
            FOCUS_CONFIG.IDB_STORES.OFFLINE_AUDIO_CACHE,
            FOCUS_CONFIG.IDB_STORES.FOCUS_PREFERENCES,
            FOCUS_CONFIG.IDB_STORES.SYNC_METADATA,
            FOCUS_CONFIG.IDB_STORES.PARKED_TASKS
          ],
          ensureStores: db => this.ensureFocusModeStores(db),
        });
        this.logger.debug('IndexedDB opened for focus mode', { version: this.db.version });
        await this.loadLastSyncTime(this.currentSyncUserId);
      } catch (error) {
        // 【H-13】Only null out the cached promise on failure so that a
        // subsequent call retries initialization. On success, keep the
        // resolved promise cached to avoid redundant open attempts
        // (the old `finally` block nulled it unconditionally, creating a
        // race where concurrent callers would each trigger a new open).
        this.initIndexedDBPromise = null;
        this.logger.error('Failed to open IndexedDB for focus mode', error instanceof Error ? error.message : String(error));
        throw error;
      }
    })();

    return this.initIndexedDBPromise;
  }

  private ensureFocusModeStores(db: IDBDatabase): void {
    if (!db.objectStoreNames.contains(this.STORE_NAME)) {
      const store = db.createObjectStore(this.STORE_NAME, { keyPath: 'id' });
      store.createIndex('by-date', 'date', { unique: false });
      store.createIndex('by-updated', 'updatedAt', { unique: false });
      store.createIndex('by-sync-status', 'syncStatus', { unique: false });
    }

    if (!db.objectStoreNames.contains(FOCUS_CONFIG.IDB_STORES.OFFLINE_AUDIO_CACHE)) {
      db.createObjectStore(FOCUS_CONFIG.IDB_STORES.OFFLINE_AUDIO_CACHE, { keyPath: 'id' });
    }

    if (!db.objectStoreNames.contains(FOCUS_CONFIG.IDB_STORES.FOCUS_PREFERENCES)) {
      db.createObjectStore(FOCUS_CONFIG.IDB_STORES.FOCUS_PREFERENCES, { keyPath: 'key' });
    }

    if (!db.objectStoreNames.contains(FOCUS_CONFIG.IDB_STORES.SYNC_METADATA)) {
      db.createObjectStore(FOCUS_CONFIG.IDB_STORES.SYNC_METADATA, { keyPath: 'key' });
    }

    if (!db.objectStoreNames.contains(FOCUS_CONFIG.IDB_STORES.PARKED_TASKS)) {
      const parkedStore = db.createObjectStore(FOCUS_CONFIG.IDB_STORES.PARKED_TASKS, { keyPath: 'taskId' });
      parkedStore.createIndex('by-parkedAt', 'parkedAt', { unique: false });
    }
  }

  /**
   * 从 IndexedDB 加载上次同步时间
   */
  private async loadLastSyncTime(userId: string | null = this.currentSyncUserId): Promise<void> {
    if (!this.db) return;

    if (!userId) {
      this.lastSyncTime = null;
      return;
    }

    return new Promise((resolve) => {
      try {
        const tx = this.db!.transaction(this.SYNC_METADATA_STORE, 'readonly');
        const store = tx.objectStore(this.SYNC_METADATA_STORE);
        const request = store.get(this.getLastSyncTimeKey(userId));

        request.onsuccess = () => {
          if (this.currentSyncUserId !== userId) {
            resolve();
            return;
          }

          if (request.result) {
            this.lastSyncCursor = this.parseStoredSyncCursor(request.result.value);
            this.lastSyncTime = this.lastSyncCursor?.updatedAt ?? null;
            this.logger.debug(`Loaded lastSyncTime: ${this.lastSyncTime}`);
          } else {
            this.lastSyncCursor = null;
            this.lastSyncTime = null;
          }
          resolve();
        };

        request.onerror = () => {
          this.logger.warn('Failed to load lastSyncTime');
          resolve();
        };
      } catch (e) {
        // 降级处理：Store 可能不存在（首次升级前）
        this.logger.debug('IndexedDB store 不存在', { error: e });
        resolve();
      }
    });
  }

  private async persistBlackBoxCursorIfNewer(cursor: BlackBoxSyncCursor): Promise<BlackBoxSyncCursor | null> {
    if (!this.db || !this.currentSyncUserId) return null;

    const cursorMs = new Date(cursor.updatedAt).getTime();
    if (!Number.isFinite(cursorMs)) return null;

    const currentSyncUserId = this.currentSyncUserId;
    const key = this.getLastSyncTimeKey(currentSyncUserId);

    return new Promise((resolve) => {
      try {
        const tx = this.db!.transaction(this.SYNC_METADATA_STORE, 'readwrite');
        const store = tx.objectStore(this.SYNC_METADATA_STORE);
        let committedCursor: BlackBoxSyncCursor = cursor;

        tx.oncomplete = () => resolve(committedCursor);
        tx.onerror = () => {
          this.logger.debug('保存黑匣子同步游标失败', { userId: currentSyncUserId, error: tx.error });
          resolve(null);
        };
        tx.onabort = () => {
          this.logger.debug('保存黑匣子同步游标中止', { userId: currentSyncUserId, error: tx.error });
          resolve(null);
        };

        const request = store.get(key);
        request.onsuccess = () => {
          const existing = this.parseStoredSyncCursor(request.result?.value);
          if (existing && this.compareBlackBoxCursor(cursor, existing) < 0) {
            this.sentryLazyLoader.addBreadcrumb({
              category: 'sync',
              message: 'blackbox.cursor_persist_ignored_stale',
              level: 'info',
              data: { existing, candidate: cursor },
            });
            committedCursor = existing;
            return;
          }

          store.put({ key, value: cursor });
        };
        request.onerror = () => {
          this.logger.debug('读取黑匣子同步游标失败', { userId: currentSyncUserId, error: request.error });
          resolve(null);
        };
      } catch (e) {
        this.logger.debug('保存黑匣子同步游标失败', { error: e });
        resolve(null);
      }
    });
  }

  private async syncCursorScope(userId: string | null): Promise<void> {
    this.currentSyncUserId = userId;
    this.lastSyncTime = null;
    this.lastSyncCursor = null;
    this.lastPullTime = 0;
    this.lastResumePullAt = 0;
    await this.loadLastSyncTime(userId);
  }

  /**
   * 设置网络状态监听
   * 网络恢复时，扫描并恢复未同步条目
   * 【2026-02-15 修复】保存监听器引用并在 DestroyRef 中清理
   */
  private setupNetworkListener(): void {
    if (typeof window === 'undefined') return;
    const onOnline = () => {
      this.logger.info('Network restored, recovering pending entries');
      this.recoverPendingEntries();
    };
    window.addEventListener('online', onOnline);
    this.destroyRef.onDestroy(() => {
      window.removeEventListener('online', onOnline);
      void this.teardownRealtimeSubscription();
      // 清理防抖定时器
      if (this.pushDebounceTimer) {
        clearTimeout(this.pushDebounceTimer);
        this.pushDebounceTimer = null;
      }
    });
  }

  /**
   * 调度同步（防抖 3s）
   *
   * 数据安全保证：
   * 1. 立即写入 IndexedDB（syncStatus=pending）
   * 2. 防抖结束后通过 RetryQueue 推送（持久化队列）
   * 3. 即使浏览器崩溃，下次启动时 recoverPendingEntries 会恢复
   */
  async scheduleSync(entry: BlackBoxEntry): Promise<void> {
    // 校验 ID，拦截脏数据进入同步流程
    if (!entry.id || !isValidUUID(entry.id)) {
      this.logger.warn(`scheduleSync: 拦截非法 ID "${entry.id}"，不进入同步`);
      return;
    }

    // 1. 立即保存到本地 IndexedDB（syncStatus=pending）
    const pendingEntry: BlackBoxEntry = { ...entry, syncStatus: 'pending' };
    // 【修复 P1-01】await IDB 写入，确保 crash 时不丢数据
    try {
      await this.saveToLocal(pendingEntry);
    } catch (e) {
      this.logger.error('scheduleSync: IDB 写入失败，条目加入内存队列等待重试', e instanceof Error ? e.message : String(e));
    }

    // 2. 加入防抖批次
    this.pendingPushEntries.set(entry.id, pendingEntry);

    // 3. 防抖处理
    if (this.pushDebounceTimer) {
      clearTimeout(this.pushDebounceTimer);
    }

    this.pushDebounceTimer = setTimeout(() => {
      this.flushPendingToRetryQueue();
    }, this.DEBOUNCE_DELAY);
  }

  /**
   * 将防抖批次中的条目提交到 RetryQueue
   */
  private flushPendingToRetryQueue(): void {
    const entries = Array.from(this.pendingPushEntries.values());
    this.pendingPushEntries.clear();

    for (const entry of entries) {
      // 校验所有 UUID 字段
      if (!entry.id || !isValidUUID(entry.id)) {
        this.logger.warn(`flushPending: 跳过非法 ID "${entry.id}"`);
        continue;
      }
      if (entry.projectId != null && !isValidUUID(entry.projectId)) {
        this.logger.warn(`flushPending: 跳过非法 projectId "${entry.projectId}"，id="${entry.id}"`);
        continue;
      }
      if (this.retryQueueHandler) {
        // 通过主同步体系的 RetryQueue（持久化）
        this.retryQueueHandler(entry);
      } else {
        // 降级：直接推送（不经过 RetryQueue）
        // 【M-03】Must not fire-and-forget — attach .catch() to log errors
        this.pushToServer(entry).catch(err => {
          this.logger.error(
            'Fire-and-forget pushToServer failed',
            err instanceof Error ? err.message : String(err)
          );
        });
      }
    }
  }

  private async syncRealtimeSubscription(userId: string | null, generation: number): Promise<void> {
    this.clearRealtimeCircuitRetryTimer();

    if (generation !== this.realtimeSubscriptionGeneration) {
      return;
    }

    if (!userId) {
      await this.teardownRealtimeSubscription();
      return;
    }

    if (this.realtimeChannel && this.realtimeSubscribedUserId === userId) {
      return;
    }

    await this.teardownRealtimeSubscription();
    this.realtimeConsecutiveErrors = 0;

    if (generation !== this.realtimeSubscriptionGeneration) {
      return;
    }

    const realtimeCircuit = this.getRealtimeCircuitSnapshot(userId);
    if (realtimeCircuit.remainingMs > 0) {
      this.scheduleRealtimeCircuitRetry(userId, realtimeCircuit.remainingMs, generation);
      this.logger.info('黑匣子 Realtime 熔断窗口内跳过订阅，继续使用 gate-review 定时拉取兜底', {
        remainingMs: realtimeCircuit.remainingMs,
        failures: realtimeCircuit.failures,
        lastError: realtimeCircuit.lastError,
      });
      return;
    }

    const client = await this.supabase.clientAsync().catch(() => null);
    if (!client || generation !== this.realtimeSubscriptionGeneration) {
      return;
    }

    const channelName = `blackbox:${userId.substring(0, 8)}`;
    const channel = client.channel(channelName);

    channel.on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'black_box_entries',
        filter: `user_id=eq.${userId}`,
      },
      (payload) => {
        if (generation !== this.realtimeSubscriptionGeneration || this.realtimeSubscribedUserId !== userId) {
          return;
        }

        const row = (payload.new || payload.old) as { user_id?: string } | undefined;
        if (row?.user_id && row.user_id !== userId) {
          return;
        }

        this.logger.debug('收到黑匣子实时变更', {
          event: payload.eventType,
        });

        void this.pullChanges({
          reason: 'gate-review',
          force: true,
          expectedUserId: userId,
          expectedRealtimeGeneration: generation,
        }).catch((error: unknown) => {
          this.logger.debug('黑匣子实时变更拉取失败', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      },
    ).subscribe((status, error) => {
      if (generation !== this.realtimeSubscriptionGeneration) {
        client.removeChannel(channel).catch(() => undefined);
        return;
      }

      if (this.realtimeChannel !== channel) {
        return;
      }

      if (status === 'SUBSCRIBED') {
        this.realtimeConsecutiveErrors = 0;
        this.logger.info('黑匣子 Realtime 订阅已启用', {
          channel: channelName,
        });
        return;
      }

      if ((status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') && isBrowserNetworkSuspendedWindow()) {
        this.logger.debug('浏览器网络挂起期间忽略黑匣子 Realtime 通道中断', {
          channel: channelName,
          status,
          error: error?.message,
        });
        return;
      }

      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        this.realtimeConsecutiveErrors += 1;

        if (this.realtimeConsecutiveErrors < BlackBoxSyncService.REALTIME_MAX_CONSECUTIVE_ERRORS) {
          this.logger.debug('黑匣子 Realtime 通道瞬时错误，等待连续失败阈值', {
            channel: channelName,
            status,
            consecutiveErrors: this.realtimeConsecutiveErrors,
            error: error?.message,
          });
          return;
        }

        const realtimeCircuitMs = this.armRealtimeCircuit(
          userId,
          error?.message,
          this.realtimeConsecutiveErrors,
        );
        this.logger.warn('黑匣子 Realtime 连续失败，熔断当前会话 websocket 并保留 gate-review 定时拉取兜底', {
          channel: channelName,
          status,
          consecutiveErrors: this.realtimeConsecutiveErrors,
          realtimeCircuitMs,
          error: error?.message,
        });
        this.scheduleRealtimeCircuitRetry(userId, realtimeCircuitMs, this.realtimeSubscriptionGeneration);
        void this.teardownRealtimeSubscription();
      }
    });

    this.realtimeChannel = channel;
    this.realtimeSubscribedUserId = userId;
  }

  private async teardownRealtimeSubscription(): Promise<void> {
    const channel = this.realtimeChannel;
    this.realtimeChannel = null;
    this.realtimeSubscribedUserId = null;
    this.realtimeConsecutiveErrors = 0;

    if (!channel) {
      return;
    }

    const client = await this.supabase.clientAsync().catch(() => null);
    if (!client) {
      return;
    }

    await client.removeChannel(channel).catch(() => undefined);
  }

  /**
   * 保存到本地 IndexedDB
   */
  async saveToLocal(entry: BlackBoxEntry): Promise<void> {
    if (!this.db) {
      await this.initIndexedDB();
    }

    return new Promise((resolve, reject) => {
      if (!this.db) {
        reject(new Error('IndexedDB not initialized'));
        return;
      }

      const tx = this.db.transaction(this.STORE_NAME, 'readwrite');
      const store = tx.objectStore(this.STORE_NAME);

      const putEntry = (entryToPersist: BlackBoxEntry) => {
        const idbEntry: IDBBlackBoxEntry = {
          ...entryToPersist,
          _localVersion: Date.now()
        };

        const request = store.put(idbEntry);

        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      };

      const existingRequest = store.get(entry.id);
      existingRequest.onsuccess = () => {
        const result = existingRequest.result as IDBBlackBoxEntry | undefined;
        const existing = result
          ? (({ _localVersion: _localVersion, ...rest }) => rest)(result)
          : null;
        putEntry(this.hydrateBlankContentFromSource(entry, existing, 'local-idb'));
      };
      existingRequest.onerror = () => {
        if (this.isBlankOrMissingContent(entry.content)) {
          reject(existingRequest.error ?? new Error('Unable to read existing BlackBox entry before blank-content write'));
          return;
        }
        putEntry(entry);
      };
    });
  }

  /**
   * 将已被终止云端重放的本地条目标记为 conflict。
   * 仅修正同步元数据，不改变业务字段，避免 UI 长期误报“待同步”。
   */
  async markEntrySyncConflict(entry: BlackBoxEntry): Promise<void> {
    const latestLocal = await this.resolveLatestLocalEntry(entry.id);
    const latestSameOwner = latestLocal?.userId === entry.userId ? latestLocal : null;

    if (latestSameOwner?.syncStatus === 'synced' || latestSameOwner?.syncStatus === 'conflict') {
      return;
    }

    if (latestSameOwner && this.isEntryNewer(latestSameOwner, entry)) {
      this.logger.debug('跳过过期的黑匣子 conflict 修复：本地已有更新快照', {
        entryId: entry.id,
        repairUpdatedAt: entry.updatedAt,
        latestLocalUpdatedAt: latestSameOwner.updatedAt,
      });
      return;
    }

    const baseEntry = latestSameOwner ?? entry;
    const conflictEntry = this.hydrateBlankContentFromSource(
      {
        ...baseEntry,
        syncStatus: 'conflict',
      },
      baseEntry === entry ? latestSameOwner : entry,
      'latest-local',
    );

    await this.saveToLocal(conflictEntry);

    const visibleEntry = blackBoxEntriesMap().get(entry.id);
    if (visibleEntry?.userId === conflictEntry.userId) {
      updateBlackBoxEntry({
        ...visibleEntry,
        ...conflictEntry,
        syncStatus: 'conflict',
      });
    }
  }

  /**
   * 处理 owner-mismatch 的本地 pending 条目，避免 UI 长期显示 待同步。
   * 见 pushToServer / recoverPendingEntries 的调用点。
   *
   * 处理策略：
   * 1. entry.userId === LOCAL_MODE_USER_ID 且当前会话是合法云端 UUID → 改写 owner 后
   *    通过 retryQueueHandler / pushToServer 续推（保护 local→cloud 数据迁移）；
   * 2. entry.userId 不是合法 UUID（"dev-preview" 等历史脏数据） → 物理删除；
   * 3. entry.userId 是合法 UUID 但与当前会话不一致（跨账号残留） → markEntrySyncConflict
   *    把 syncStatus 由 pending 降级为 conflict，让 UI 立即收敛。
   */
  private async selfHealOwnerMismatchedEntry(
    entry: BlackBoxEntry,
    sessionUserId: string,
    sourceUserId: string | undefined,
  ): Promise<void> {
    // Case 1: 历史 local-mode 条目登录云账号后未迁移 owner → 改写并续推。
    // 若 sourceUserId 与 sessionUserId 不一致（罕见），说明 RetryQueue 持久化的归属和当前会话冲突，
    // 此时不安全地直接改写，留给 Case 3 走 conflict 路径。
    if (
      entry.userId === AUTH_CONFIG.LOCAL_MODE_USER_ID
      && (!sourceUserId || sourceUserId === sessionUserId)
    ) {
      const rebranded: BlackBoxEntry = {
        ...entry,
        userId: sessionUserId,
        syncStatus: 'pending',
      };
      try {
        await this.saveToLocal(rebranded);
      } catch (error) {
        this.logger.warn('黑匣子 owner 改写持久化失败，跳过续推，保留下次启动时再恢复', {
          entryId: entry.id,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      const visibleEntry = blackBoxEntriesMap().get(entry.id);
      if (!visibleEntry || visibleEntry.userId === entry.userId) {
        updateBlackBoxEntry(rebranded);
      }

      if (this.retryQueueHandler) {
        this.retryQueueHandler(rebranded);
      } else {
        // 没接入 RetryQueue 时降级为内联推送，确保不留 pending 残留。
        void this.pushToServer(rebranded, sessionUserId).catch(err => {
          this.logger.error(
            '黑匣子 owner 改写后内联续推失败',
            err instanceof Error ? err.message : String(err),
          );
        });
      }
      return;
    }

    // Case 2: 非法 UUID owner（含空串）—— 纯脏数据，本地物理清理。
    if (!entry.userId || !isValidUUID(entry.userId)) {
      try {
        await this.deleteFromLocal(entry.id);
      } catch (error) {
        this.logger.debug('黑匣子非法 owner 条目本地删除失败，忽略错误', {
          entryId: entry.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      // 同步把内存 Map 里的副本移除，避免 UI 继续展示这条孤儿
      const inMemory = blackBoxEntriesMap();
      if (inMemory.has(entry.id)) {
        const next = new Map(inMemory);
        next.delete(entry.id);
        setBlackBoxEntries(Array.from(next.values()));
      }
      return;
    }

    // Case 3: 合法 UUID 但与当前会话不一致 → 标 conflict，UI 收敛
    try {
      await this.markEntrySyncConflict(entry);
    } catch (error) {
      this.logger.warn('黑匣子 owner 冲突标记失败，保留 pending 由后续循环重试', {
        entryId: entry.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * 当 push 完成时发现 latestLocalAfterPush 比 entry 更晚，按业务字段等价性决定：
   *   - 等价（差异只是 updatedAt 这种同步元数据）→ 升级为 synced，避免 UI 长期 待同步；
   *   - 不等价（latestLocal 含未推送的真实编辑）→ 保留 pending，等下次同步循环承接。
   * 这是「Fix 3·路径 B」的核心收敛点，RPC / 直接 upsert 两条路径共用。
   */
  private async upgradeEquivalentLatestLocalToSynced(
    latestLocal: BlackBoxEntry,
    pushedEntry: BlackBoxEntry,
    serverUpdatedAt: string,
    pushPath: 'rpc' | 'upsert',
  ): Promise<void> {
    if (this.hasEquivalentEntryState(latestLocal, pushedEntry)) {
      const synced: BlackBoxEntry = {
        ...latestLocal,
        updatedAt: serverUpdatedAt,
        syncStatus: 'synced',
      };
      await this.saveToLocal(synced);
      updateBlackBoxEntry(synced);
      this.logger.debug('黑匣子 push 完成后业务字段等价的更晚本地快照已升级为 synced', {
        entryId: pushedEntry.id,
        pushedUpdatedAt: pushedEntry.updatedAt,
        latestLocalUpdatedAt: latestLocal.updatedAt,
        serverUpdatedAt,
        pushPath,
      });
      return;
    }

    this.logger.debug('黑匣子推送完成时检测到更晚的本地快照，跳过旧状态回写，等待 latestLocal 自身续推', {
      entryId: pushedEntry.id,
      pushedUpdatedAt: pushedEntry.updatedAt,
      latestLocalUpdatedAt: latestLocal.updatedAt,
      pushPath,
    });
  }

  /**
   * 从本地 IndexedDB 删除指定条目
   * 用于清理脏数据（如非法 ID 的条目）
   */
  async deleteFromLocal(id: string): Promise<void> {
    if (!this.db) {
      await this.initIndexedDB();
    }

    return new Promise((resolve, reject) => {
      if (!this.db) {
        reject(new Error('IndexedDB not initialized'));
        return;
      }

      const tx = this.db.transaction(this.STORE_NAME, 'readwrite');
      const store = tx.objectStore(this.STORE_NAME);
      const request = store.delete(id);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  private async loadEntryFromLocal(id: string): Promise<BlackBoxEntry | null> {
    let initFailed = false;
    try {
      if (!this.db) {
        await this.initIndexedDB();
      }
    } catch {
      initFailed = true;
    }

    if (initFailed) {
      return null;
    }

    if (!this.db) {
      return null;
    }

    return new Promise((resolve) => {
      const tx = this.db!.transaction(this.STORE_NAME, 'readonly');
      const store = tx.objectStore(this.STORE_NAME);
      const request = store.get(id);

      request.onsuccess = () => {
        const result = request.result as IDBBlackBoxEntry | undefined;
        if (!result) {
          resolve(null);
          return;
        }

        const { _localVersion, ...entry } = result;
        resolve(entry);
      };
      request.onerror = () => resolve(null);
    });
  }

  private isEntryNewer(
    candidate: Pick<BlackBoxEntry, 'updatedAt'> | null | undefined,
    baseline: Pick<BlackBoxEntry, 'updatedAt'> | null | undefined,
  ): boolean {
    if (!candidate?.updatedAt || !baseline?.updatedAt) {
      return false;
    }

    return this.clockSync.isLocalNewer(candidate.updatedAt, baseline.updatedAt);
  }

  private async resolveLatestLocalEntry(id: string): Promise<BlackBoxEntry | null> {
    const inMemory = blackBoxEntriesMap().get(id) ?? null;
    const persisted = await this.loadEntryFromLocal(id);

    if (!persisted) {
      return inMemory;
    }

    if (!inMemory || this.isEntryNewer(persisted, inMemory)) {
      return persisted;
    }

    return inMemory;
  }

  private hasMeaningfulContent(content: unknown): content is string {
    return typeof content === 'string' && content.trim().length > 0;
  }

  private isBlankOrMissingContent(content: unknown): boolean {
    return typeof content !== 'string' || content.trim().length === 0;
  }

  private hydrateBlankContentFromSource(
    entry: BlackBoxEntry,
    source: BlackBoxEntry | null | undefined,
    sourceLabel: 'latest-local' | 'server-preflight' | 'local-merge' | 'local-idb',
  ): BlackBoxEntry {
    if (!this.isBlankOrMissingContent(entry.content) || !this.hasMeaningfulContent(source?.content)) {
      return entry;
    }

    this.logger.warn('黑匣子推送检测到空正文 payload，已从权威快照补回正文以避免覆盖数据库内容', {
      entryId: entry.id,
      source: sourceLabel,
      entryUpdatedAt: entry.updatedAt,
      sourceUpdatedAt: source?.updatedAt,
    });

    return {
      ...entry,
      content: source.content,
    };
  }

  private isExpectedRealtimeContextCurrent(
    expectedUserId?: string,
    expectedRealtimeGeneration?: number,
  ): boolean {
    if (!expectedUserId && expectedRealtimeGeneration == null) {
      return true;
    }

    if (
      expectedRealtimeGeneration != null
      && expectedRealtimeGeneration !== this.realtimeSubscriptionGeneration
    ) {
      return false;
    }

    if (expectedUserId && this.resolveRemoteSessionUserId() !== expectedUserId) {
      return false;
    }

    return true;
  }

  private getPendingEntriesForRemoteReconciliation(entries?: BlackBoxEntry[]): BlackBoxEntry[] {
    const remoteSessionUserId = this.resolveRemoteSessionUserId();
    if (!remoteSessionUserId) {
      return [];
    }

    return (entries ?? Array.from(blackBoxEntriesMap().values())).filter(entry => {
      return entry.syncStatus === 'pending'
        && entry.userId === remoteSessionUserId
        && isValidUUID(entry.id);
    });
  }

  private hasSameInstant(left: string | null | undefined, right: string | null | undefined): boolean {
    const normalizedLeft = left ?? null;
    const normalizedRight = right ?? null;
    if (normalizedLeft === normalizedRight) {
      return true;
    }

    if (!normalizedLeft || !normalizedRight) {
      return false;
    }

    const leftMs = new Date(normalizedLeft).getTime();
    const rightMs = new Date(normalizedRight).getTime();
    const leftValid = Number.isFinite(leftMs);
    const rightValid = Number.isFinite(rightMs);
    if (!leftValid || !rightValid) {
      this.logger.debug('黑匣子时间戳等价比较失败：时间格式无效', {
        left: normalizedLeft,
        right: normalizedRight,
      });
      return false;
    }

    return leftMs === rightMs;
  }

  private hasEquivalentEntryState(local: BlackBoxEntry, remote: BlackBoxEntry): boolean {
    const localFocusMeta = local.focusMeta ?? null;
    const remoteFocusMeta = remote.focusMeta ?? null;
    const focusMetaMatches = !localFocusMeta || !remoteFocusMeta
      ? localFocusMeta === remoteFocusMeta
      : localFocusMeta.source === remoteFocusMeta.source
        && localFocusMeta.sessionId === remoteFocusMeta.sessionId
        && localFocusMeta.title === remoteFocusMeta.title
        && (localFocusMeta.detail ?? null) === (remoteFocusMeta.detail ?? null)
        && localFocusMeta.lane === remoteFocusMeta.lane
        && (localFocusMeta.expectedMinutes ?? null) === (remoteFocusMeta.expectedMinutes ?? null)
        && (localFocusMeta.waitMinutes ?? null) === (remoteFocusMeta.waitMinutes ?? null)
        && localFocusMeta.cognitiveLoad === remoteFocusMeta.cognitiveLoad
        && localFocusMeta.dockEntryId === remoteFocusMeta.dockEntryId;

    return local.id === remote.id
      && (local.projectId ?? null) === (remote.projectId ?? null)
      && local.userId === remote.userId
      && local.content === remote.content
      && local.date === remote.date
      && this.hasSameInstant(local.createdAt, remote.createdAt)
      && local.isRead === remote.isRead
      && local.isCompleted === remote.isCompleted
      && local.isArchived === remote.isArchived
      && (local.snoozeUntil ?? null) === (remote.snoozeUntil ?? null)
      && (local.snoozeCount ?? 0) === (remote.snoozeCount ?? 0)
      && this.hasSameInstant(local.deletedAt, remote.deletedAt)
      && focusMetaMatches;
  }

  private async reconcilePendingEntriesWithServer(
    client: Awaited<ReturnType<SupabaseClientService['clientAsync']>>,
    preferRemoteForSyncedLocalDuringPull: boolean,
    repairingFutureCursor: boolean,
    expectedUserId?: string,
    expectedRealtimeGeneration?: number,
    sourcePendingEntries?: BlackBoxEntry[],
  ): Promise<void> {
    if (!client) {
      return;
    }

    if (!expectedUserId) {
      this.logger.warn('黑匣子 pending 对账缺少用户作用域，跳过远端对账以避免跨用户误判');
      return;
    }

    if (!this.isExpectedRealtimeContextCurrent(expectedUserId, expectedRealtimeGeneration)) {
      this.logger.info('黑匣子 pending 对账在会话切换后取消，避免旧用户数据写回当前会话');
      return;
    }

    const pendingEntries = this.getPendingEntriesForRemoteReconciliation(sourcePendingEntries);
    if (pendingEntries.length === 0) {
      return;
    }

    const pendingIds = pendingEntries.map(entry => entry.id);
    const batchSize = 50;
    const sourcePendingEntryMap = sourcePendingEntries
      ? new Map(sourcePendingEntries.map(entry => [entry.id, entry]))
      : null;

    this.logger.debug('黑匣子存在 pending 本地条目，开始按 ID 对账远端权威状态', {
      pendingCount: pendingIds.length,
    });

    for (let offset = 0; offset < pendingIds.length; offset += batchSize) {
      if (!this.isExpectedRealtimeContextCurrent(expectedUserId, expectedRealtimeGeneration)) {
        this.logger.info('黑匣子 pending 对账中止：Realtime 订阅上下文已变化');
        return;
      }

      const batchIds = pendingIds.slice(offset, offset + batchSize);
      let query = client
        .from('black_box_entries')
        .select('*');
      const eqQuery = this.getOptionalQueryMethod<[string, string]>(query, 'eq');
      if (!eqQuery) {
        this.logger.warn('黑匣子 pending 对账缺少 user_id 查询能力，跳过远端对账以避免跨用户误判', {
          batchSize: batchIds.length,
        });
        return;
      }
      query = eqQuery('user_id', expectedUserId) as typeof query;

      const inQuery = this.getOptionalQueryMethod<[string, string[]]>(query, 'in');
      if (!inQuery) {
        this.logger.warn('黑匣子 pending 对账缺少 in 查询能力，保留本地 pending 状态', {
          batchSize: batchIds.length,
        });
        return;
      }

      const { data, error } = await inQuery('id', batchIds) as { data: unknown[] | null; error: unknown };

      if (error) {
        const enhanced = supabaseErrorToError(error);
        this.logger.warn('黑匣子 pending 对账失败，保留本地 pending 状态', {
          message: enhanced.message,
          batchSize: batchIds.length,
        });
        return;
      }

      for (const row of data ?? []) {
        if (!this.isExpectedRealtimeContextCurrent(expectedUserId, expectedRealtimeGeneration)) {
          this.logger.info('黑匣子 pending 对账停止写入：Realtime 订阅上下文已变化');
          return;
        }

        const remoteEntry = this.mapRowToEntry(row as Record<string, unknown>);

        const localEntry = sourcePendingEntryMap?.get(remoteEntry.id) ?? blackBoxEntriesMap().get(remoteEntry.id);
        if (localEntry?.syncStatus === 'pending' && this.hasEquivalentEntryState(localEntry, remoteEntry)) {
          await this.saveToLocal(remoteEntry);
          updateBlackBoxEntry(remoteEntry);
          continue;
        }

        await this.mergeWithLocal(remoteEntry, preferRemoteForSyncedLocalDuringPull, repairingFutureCursor);
      }
    }
  }

  /**
   * 从本地 IndexedDB 加载
   */
  async loadFromLocal(): Promise<BlackBoxEntry[]> {
    if (!this.db) {
      await this.initIndexedDB();
    }

    return new Promise((resolve, reject) => {
      if (!this.db) {
        reject(new Error('IndexedDB not initialized'));
        return;
      }

      const tx = this.db.transaction(this.STORE_NAME, 'readonly');
      const store = tx.objectStore(this.STORE_NAME);
      const request = store.getAll();

      request.onsuccess = () => {
        const visibleUserId = this.resolveVisibleUserId();
        const entries = (request.result as IDBBlackBoxEntry[]).map(e => {

          const { _localVersion, ...entry } = e;
          return entry;
        });

        if (!visibleUserId) {
          // root fix: auth 恢复窗口内 owner 可能暂时不可见；此时保留当前内存快照，
          // 绝不能把黑匣子 UI 清空成 []，否则用户会误以为内容已经丢失。
          this.logger.info('黑匣子本地水合延后：owner 未决，保留当前内存快照', {
            authSettling: this.isAuthSettling(),
            sessionInitialized: this.auth.sessionInitialized(),
            currentUserId: this.auth.currentUserId(),
            inMemoryEntryCount: blackBoxEntriesMap().size,
          });
          resolve(Array.from(blackBoxEntriesMap().values()));
          return;
        }

        const syncStatusRepairs: BlackBoxEntry[] = [];
        const visibleEntries = entries
          .filter(entry => entry.userId === visibleUserId)
          .map(entry => {
            const normalized = this.normalizeLocalOnlySyncStatus(entry, visibleUserId);
            if (normalized !== entry) {
              syncStatusRepairs.push(normalized);
            }
            return normalized;
          });

        // 【2026-04-23 根因修复】“手机端内容业务不同步”的关键兼防：
        // IDB 内实际有条目，但过滤器 visibleUserId 与所有条目 user_id 都不匹配，
        // 说明 visibleUserId 很可能是残留 LOCAL_MODE_USER_ID 或旧账号的 ownerHint，
        // 此时硬切会把云端切实拉到的条目从内存 Map 清空，造成 “电脑端有、手机端没有”。
        // 充当安全网：包含条目时这条分支不覆盖 Map，只警告，语义上等同 visibleUserId=null。
        if (entries.length > 0 && visibleEntries.length === 0) {
          this.logger.warn('黑匣子 IDB 现存条目被当前 visibleUserId 全量滤除，保留内存快照以免误清', {
            visibleUserId,
            idbEntryCount: entries.length,
            inMemoryEntryCount: blackBoxEntriesMap().size,
            firstIdbEntryUserId: entries[0]?.userId,
            currentUserId: this.auth.currentUserId(),
            localModeCacheKey: this.readLocalModeCacheKey(),
          });
          resolve(Array.from(blackBoxEntriesMap().values()));
          return;
        }

        // 更新状态
        setBlackBoxEntries(visibleEntries);
        if (syncStatusRepairs.length > 0) {
          this.persistLocalOnlySyncStatusRepairs(syncStatusRepairs)
            .then(() => resolve(visibleEntries))
            .catch((error: unknown) => {
              this.logger.debug('黑匣子本地缓存同步状态修复流程失败，保留内存归一化结果', {
                error: error instanceof Error ? error.message : String(error),
              });
              resolve(visibleEntries);
            });
          return;
        }

        resolve(visibleEntries);
      };

      request.onerror = () => reject(request.error);
    });
  }

  private resolveVisibleUserId(): string | null {
    const currentUserId = this.auth.currentUserId();
    if (currentUserId) {
      return currentUserId;
    }

    if (!this.auth.isConfigured) {
      return AUTH_CONFIG.LOCAL_MODE_USER_ID;
    }

    if (typeof window === 'undefined') {
      return null;
    }

    // 【2026-04-23 根因修复】auth 恢复窗口内，优先使用持久化的“远端会话身份”提示（UUID），
    // 避免被 LOCAL_MODE_CACHE_KEY 残留或早期 local 模式的 localStorage 标志度到 ‘local-user’——
    // 这是“电脑端有、手机端没有”调用 loadFromLocal 时给实际 user_id=UUID 的条目全部滤除的根因。
    // 原顺序先看 LOCAL_MODE_CACHE_KEY 导致在云账号登录后的从未刷新场景依然返回 ‘local-user’，
    // 现在改为先看 persistedSession / ownerHint 这些更权威的云端身份来源。
    if (this.isAuthSettling()) {
      const persistedSessionUserId = this.auth.peekPersistedSessionIdentity()?.userId ?? null;
      if (persistedSessionUserId) {
        return persistedSessionUserId;
      }

      const ownerHint = this.auth.peekPersistedOwnerHint();
      if (ownerHint) {
        return ownerHint;
      }
    }

    // 没有任何远端身份线索时，才认可 LOCAL_MODE_CACHE_KEY 作为真正的本地模式标记。
    if (this.readLocalModeCacheKey() === 'true') {
      return AUTH_CONFIG.LOCAL_MODE_USER_ID;
    }

    return null;
  }

  private normalizeLocalOnlySyncStatus(entry: BlackBoxEntry, visibleUserId: string): BlackBoxEntry {
    if (visibleUserId !== AUTH_CONFIG.LOCAL_MODE_USER_ID || entry.syncStatus !== 'pending') {
      return entry;
    }

    // 仅修正本地同步元数据，不 bump updatedAt，避免本地模式水合被误判为业务内容变更。
    return {
      ...entry,
      syncStatus: 'synced',
    };
  }

  private async persistLocalOnlySyncStatusRepairs(entries: BlackBoxEntry[]): Promise<void> {
    for (const entry of entries) {
      try {
        await this.saveToLocal(entry);
      } catch (error) {
        this.logger.debug('黑匣子本地缓存同步状态修复持久化失败，保留内存归一化结果', {
          entryId: entry.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * 读取 LOCAL_MODE_CACHE_KEY，封装 try/catch 以在 storage 禁用时沉默返回 null。
   * 单独抽出便于 loadFromLocal 警告日志复用和测试驱动。
   */
  private readLocalModeCacheKey(): string | null {
    try {
      return localStorage.getItem(AUTH_CONFIG.LOCAL_MODE_CACHE_KEY);
    } catch {
      // eslint-disable-next-line no-restricted-syntax -- localStorage 访问异常时静默返回 null
      return null;
    }
  }

  private isAuthSettling(): boolean {
    return !this.auth.sessionInitialized()
      || this.auth.authState().isCheckingSession
      || this.auth.runtimeState() === 'pending';
  }

  private resolveRemoteSessionUserId(): string | null {
    const currentUserId = this.auth.currentUserId();
    if (currentUserId) {
      return currentUserId;
    }

    return this.isAuthSettling()
      ? (this.auth.peekPersistedSessionIdentity()?.userId ?? null)
      : null;
  }

  private shouldUseSyncRpc(): boolean {
    return this.syncRpcClient?.isFeatureEnabled() === true && this.syncRpcClient.isClientRejected() === false;
  }

  private createSyncRpcOperationId(): string {
    return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  private async handleBlackBoxSyncRpcResult(
    result: SyncRpcResult,
    entry: BlackBoxEntry,
    client: Awaited<ReturnType<SupabaseClientService['clientAsync']>>,
    sessionUserId: string,
  ): Promise<boolean> {
    if (result.status === 'applied' || result.status === 'idempotent-replay') {
      const serverUpdatedAt = result.serverUpdatedAt ?? entry.updatedAt;
      if (serverUpdatedAt) {
        this.clockSync.recordServerTimestamp(serverUpdatedAt, entry.id);
      }

      // stale_payload 由 sync_upsert_blackbox_entry 在 applied 结果中返回：
      // 表示写入已被接收，但服务端保留了远端权威状态，客户端必须先对账再清 pending。
      if (result.stalePayload) {
        const reconciled = await this.reconcileAuthoritativeRemoteEntry(
          client,
          entry,
          sessionUserId,
          BLACKBOX_RPC_STALE_PAYLOAD_RECONCILE_REASON,
        );
        if (reconciled) {
          return true;
        }
        this.logger.warn('黑匣子 RPC stale payload 已应用但远端权威状态未能对账，保留 pending 等待重试', {
          entryId: entry.id,
        });
        return false;
      }

      const latestLocalAfterPush = await this.resolveLatestLocalEntry(entry.id);
      if (latestLocalAfterPush && this.isEntryNewer(latestLocalAfterPush, entry)) {
        // 【2026-05-11 根因修复·路径 B】upsert 已完成、远端权威状态等于 entry，但本地这一小段
        // 时间又被并发路径（pull merge / 另一次 scheduleSync 自身的 saveToLocal(pending)）
        // bump 了 updatedAt。若两边业务字段完全等价，单纯是同步元数据的"叠写"，安全地把
        // syncStatus 推到 synced，避免 UI 长期"待同步"；否则保留 pending 让 latestLocal
        // 自身的 scheduleSync / RetryQueue 继续承接。
        await this.upgradeEquivalentLatestLocalToSynced(
          latestLocalAfterPush,
          entry,
          serverUpdatedAt,
          'rpc',
        );
        return true;
      }

      const synced: BlackBoxEntry = {
        ...entry,
        updatedAt: serverUpdatedAt,
        syncStatus: 'synced',
      };
      await this.saveToLocal(synced);
      updateBlackBoxEntry(synced);
      this.logger.debug(`Entry synced to server via RPC: ${entry.id}`);
      return true;
    }

    if (result.status === 'remote-newer') {
      this.logger.warn('黑匣子 RPC CAS 拒绝，远端版本更新', {
        entryId: entry.id,
        remoteUpdatedAt: result.remoteUpdatedAt,
        reason: result.reason,
      });
      this.sentryLazyLoader.captureMessage('sync_rpc_blackbox_remote_newer', {
        level: 'warning',
        tags: { operation: 'pushBlackBoxEntry', entityType: 'blackbox', status: result.status },
        extra: { entryId: entry.id, remoteUpdatedAt: result.remoteUpdatedAt, reason: result.reason },
      });
      return await this.reconcileAuthoritativeRemoteEntry(
        client,
        entry,
        sessionUserId,
        BLACKBOX_RPC_REMOTE_NEWER_RECONCILE_REASON,
      );
    }

    this.logger.warn('黑匣子 RPC 拒绝写入', {
      entryId: entry.id,
      status: result.status,
      reason: result.reason,
      minProtocolVersion: result.minProtocolVersion,
    });
    this.sentryLazyLoader.captureMessage('sync_rpc_blackbox_rejected', {
      level: 'warning',
      tags: { operation: 'pushBlackBoxEntry', entityType: 'blackbox', status: result.status },
      extra: { entryId: entry.id, reason: result.reason, minProtocolVersion: result.minProtocolVersion },
    });
    return false;
  }

  private async reconcileAuthoritativeRemoteEntry(
    client: Awaited<ReturnType<SupabaseClientService['clientAsync']>>,
    entry: BlackBoxEntry,
    sessionUserId: string,
    reason: BlackBoxRemoteReconcileReason,
  ): Promise<boolean> {
    const remoteEntry = await this.fetchRemoteEntryById(client, entry.id, sessionUserId, reason);
    if (!remoteEntry) {
      return false;
    }

    await this.mergeWithLocal(remoteEntry, false, false);
    const latestLocal = await this.resolveLatestLocalEntry(entry.id);
    const clearedPending = latestLocal?.syncStatus !== 'pending';
    if (!clearedPending) {
      this.logger.debug('黑匣子远端权威对账后仍保留 pending，等待最新本地快照续推', {
        entryId: entry.id,
        reason,
        localUpdatedAt: latestLocal?.updatedAt,
        remoteUpdatedAt: remoteEntry.updatedAt,
      });
    }
    return clearedPending;
  }

  private async fetchRemoteEntryById(
    client: Awaited<ReturnType<SupabaseClientService['clientAsync']>>,
    entryId: string,
    sessionUserId: string,
    reason: string,
  ): Promise<BlackBoxEntry | null> {
    if (!client) {
      return null;
    }

    try {
      let query = client
        .from('black_box_entries')
        .select(this.BLACKBOX_ENTRY_SELECT_COLUMNS);
      const userEqQuery = this.getOptionalQueryMethod<[string, string]>(query, 'eq');
      if (!userEqQuery) {
        this.logger.warn('黑匣子远端权威对账缺少 eq 查询能力，保留 pending 状态', {
          entryId,
          reason,
        });
        return null;
      }
      query = userEqQuery('user_id', sessionUserId) as typeof query;
      const idEqQuery = this.getOptionalQueryMethod<[string, string]>(query, 'eq');
      if (!idEqQuery) {
        this.logger.warn('黑匣子远端权威对账缺少 id 查询能力，保留 pending 状态', {
          entryId,
          reason,
        });
        return null;
      }
      query = idEqQuery('id', entryId) as typeof query;

      const maybeSingle = this.getOptionalQueryMethod<[]>(query, 'maybeSingle');
      if (!maybeSingle) {
        this.logger.warn('黑匣子远端权威对账缺少 maybeSingle 查询能力，保留 pending 状态', {
          entryId,
          reason,
        });
        return null;
      }

      const { data, error } = await maybeSingle() as { data: unknown | null; error: unknown };
      if (error) {
        this.logger.warn('黑匣子远端权威对账失败，保留 pending 状态', {
          entryId,
          reason,
          message: supabaseErrorToError(error).message,
        });
        return null;
      }
      if (!data) {
        this.logger.warn('黑匣子远端权威对账未找到服务端行，保留 pending 状态', {
          entryId,
          reason,
        });
        return null;
      }

      return this.mapRowToEntry(data as Record<string, unknown>);
    } catch (error) {
      this.logger.warn('黑匣子远端权威对账异常，保留 pending 状态', {
        entryId,
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * 推送到服务器
   *
   * 公开方法：由 RetryQueue 处理器回调调用
   * 返回 boolean 表示是否成功（供 RetryQueue 决定是否重试）
   */
  async pushToServer(entry: BlackBoxEntry, sourceUserId?: string): Promise<boolean> {
    if (!this.supabase.isConfigured) {
      this.logger.debug('Supabase 未配置，跳过推送');
      return false;
    }
    if (this.isRemoteUnavailable()) {
      this.logger.debug('连接中断模式下跳过黑匣子推送');
      return false;
    }

    const sessionUserId = this.resolveRemoteSessionUserId();
    if (!sessionUserId) {
      this.logger.warn('BlackBox push deferred: session owner unavailable', {
        entryId: entry.id,
        hasEntryUserId: !!entry.userId,
        hasSourceUserId: !!sourceUserId,
      });
      return false;
    }

    if (entry.userId !== sessionUserId || (sourceUserId && sourceUserId !== sessionUserId)) {
      this.logger.warn('BlackBox push rejected: owner mismatch', {
        entryId: entry.id,
        hasSessionUserId: !!sessionUserId,
        hasEntryUserId: !!entry.userId,
        hasSourceUserId: !!sourceUserId,
      });
      // 【2026-05-11 根因修复·路径 A】不能只是 return true 让 RetryQueue 丢弃这条任务——
      // 否则本地 IDB 里 `syncStatus='pending'` 的脏数据永远没人改正，UI 长期显示 待同步。
      // 这里按 owner 形态做"自愈"：
      //   1) entry.userId === LOCAL_MODE_USER_ID 且当前会话是合法云端 UUID → 改写 owner，
      //      再通过同步通道续推（保护 local→cloud 迁移期间的数据）；
      //   2) entry.userId 不是合法 UUID（"dev-preview" 等历史脏数据）→ 物理删除；
      //   3) entry.userId 是合法 UUID 但与当前会话不一致（跨账号残留）→ 标 conflict，
      //      让 UI 立即收敛，不再误报 待同步。
      await this.selfHealOwnerMismatchedEntry(entry, sessionUserId, sourceUserId);
      return true;
    }

    // 校验所有 UUID 字段，跳过 IndexedDB 中的脏数据（如 "dev-preview"、"dev-test"）
    if (!entry.id || !isValidUUID(entry.id)) {
      this.logger.warn(`跳过非法 ID 的条目: "${entry.id}"，从本地清理`);
      try {
        await this.deleteFromLocal(entry.id);
      } catch { /* 清理失败不阻塞 */ }
      return true; // 返回 true 让 RetryQueue 不再重试
    }

    // 共享黑匣子仓允许 projectId=null；非空时必须是合法 UUID。
    if (entry.projectId != null && !isValidUUID(entry.projectId)) {
      this.logger.warn(`跳过非法 projectId 的条目: id="${entry.id}", projectId="${entry.projectId}"，从本地清理`);
      try {
        await this.deleteFromLocal(entry.id);
      } catch { /* 清理失败不阻塞 */ }
      return true;
    }

    try {
      const client = await this.supabase.clientAsync();
      if (!client) {
        return false;
      }

      // 【终极防线】upsert 前再次内联校验所有 UUID 字段
      const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      if (!uuidPattern.test(entry.id) || (entry.projectId != null && !uuidPattern.test(entry.projectId))) {
        this.logger.warn(`终极防线拦截非法 UUID 字段: id="${entry.id}", projectId="${entry.projectId}"`);
        try { await this.deleteFromLocal(entry.id); } catch { /* ignore */ }
        return true;
      }

      const latestLocalBeforePush = await this.resolveLatestLocalEntry(entry.id);
      if (this.isEntryNewer(latestLocalBeforePush, entry)) {
        this.logger.debug('跳过过期黑匣子推送：本地已有更新快照', {
          entryId: entry.id,
          queuedUpdatedAt: entry.updatedAt,
          latestLocalUpdatedAt: latestLocalBeforePush?.updatedAt,
        });
        return true;
      }
      entry = this.hydrateBlankContentFromSource(entry, latestLocalBeforePush, 'latest-local');

      let syncRpcBaseUpdatedAt: string | null = entry.updatedAt ?? null;
      let preflightServerEntry: BlackBoxEntry | null = null;

      // 【2026-04-22 根因修复】服务端状态预检：防止陈旧本地 pending 快照反向压盖远端
      // 权威状态。典型场景：Device B（移动端 / PWA / 久未刷新的标签页）IDB 中仍保留着
      // 早期未完成的 pending 快照，Device A 已在服务端将其标记为 is_completed=true；
      // 若直接 upsert，服务端触发器会盖上新的 updated_at，使陈旧状态反向传播到所有设备，
      // 表现为"已完成的任务过一会儿又出现在大门里"。
      // 修复策略：若服务端现存状态的 updated_at 晚于本地 pending 的 updatedAt，认为本地
      // 已过时；将服务端权威状态写回本地并清除 pending 标记,放弃这次推送。
      //
      // 【2026-04-23 根因修复·加强版】仅按 updated_at LWW 判定仍不足以守住语义：若本地
      // pending 的 updatedAt 恰好晚于服务端（典型成因：Device B 时钟偏快、或该条目在
      // 本地被再次触碰 bump 了 updatedAt），即便服务端早已是 is_read=true / is_completed=true
      // / 已软删除的权威状态，原 preflight 也会放行本轮 upsert，把这些单调位压回 false /
      // 复活，继而被触发器盖上新的 NOW() 反向污染全站。
      // 新策略：对 is_read / is_completed / deletedAt 施加"只进不退"的单调合并。
      //   * 若本地与服务端对这些单调位的并集等于服务端现状 → 本地没有真正新增意图，直接
      //     采用服务端权威状态并清 pending；
      //   * 否则把服务端单调真值 OR 进本地 entry（保留本地 content / snoozeUntil /
      //     isArchived 等非单调编辑），以合并后的 entry 继续后续 upsert，绝不让已经被
      //     完成/已读/软删除的条目悄悄回潮。
      try {
        let preflightQuery = client
          .from('black_box_entries')
          .select('id, project_id, user_id, content, focus_meta, date, created_at, updated_at, is_read, is_completed, is_archived, snooze_until, snooze_count, deleted_at');
        const eqUserQuery = this.getOptionalQueryMethod<[string, string]>(preflightQuery, 'eq');
        if (!eqUserQuery) {
          this.logger.warn('黑匣子推送预检缺少 user_id 查询能力，延后推送以避免覆盖未对账的服务端状态', {
            entryId: entry.id,
          });
          return false;
        }
        preflightQuery = eqUserQuery('user_id', sessionUserId) as typeof preflightQuery;

        const eqIdQuery = this.getOptionalQueryMethod<[string, string]>(preflightQuery, 'eq');
        if (!eqIdQuery) {
          this.logger.warn('黑匣子推送预检缺少 id 查询能力，延后推送以避免覆盖未对账的服务端状态', {
            entryId: entry.id,
          });
          return false;
        }
        preflightQuery = eqIdQuery('id', entry.id) as typeof preflightQuery;

        const maybeSingleQuery = this.getOptionalQueryMethod<[]>(preflightQuery, 'maybeSingle');
        if (!maybeSingleQuery) {
          this.logger.warn('黑匣子推送预检缺少 maybeSingle 查询能力，延后推送以避免覆盖未对账的服务端状态', {
            entryId: entry.id,
          });
          return false;
        }

        const { data: serverRow, error: preflightError } = await maybeSingleQuery() as { data: unknown; error: unknown };

        if (!preflightError && serverRow) {
          const serverEntry = this.mapRowToEntry(serverRow as Record<string, unknown>);
          preflightServerEntry = serverEntry;
          syncRpcBaseUpdatedAt = serverEntry.updatedAt;
          entry = this.hydrateBlankContentFromSource(entry, serverEntry, 'server-preflight');
          const rawServerMs = new Date(serverEntry.updatedAt).getTime();
          const rawLocalMs = new Date(entry.updatedAt).getTime();
          const timestampsDiffer = Number.isFinite(rawServerMs)
            && Number.isFinite(rawLocalMs)
            && rawLocalMs !== rawServerMs;
          const clockSyncResult = timestampsDiffer
            ? await this.clockSync.ensureSynced().catch(() => null)
            : null;

          if (timestampsDiffer && !clockSyncResult?.reliable) {
            this.logger.warn('黑匣子推送预检检测到不可信时间基线，延后本轮推送避免误判覆盖或回退本地更新', {
              entryId: entry.id,
              localUpdatedAt: entry.updatedAt,
              serverUpdatedAt: serverEntry.updatedAt,
            });
            return false;
          }

          const serverIsNewer = clockSyncResult?.reliable
            ? this.clockSync.compareTimestamps(entry.updatedAt, serverEntry.updatedAt) < 0
            : rawServerMs > rawLocalMs;
          const wouldRegressRead = serverEntry.isRead && !entry.isRead;
          const wouldRegressCompleted = serverEntry.isCompleted && !entry.isCompleted;
          const wouldResurrectDeleted = Boolean(serverEntry.deletedAt) && !entry.deletedAt;
          const hasMonotonicRegression =
            wouldRegressRead || wouldRegressCompleted || wouldResurrectDeleted;

          if (serverIsNewer || hasMonotonicRegression) {
            // 服务端更晚 → 直接采用服务端；否则在本地 entry 上合并服务端单调真值。
            const mergedEntry: BlackBoxEntry = serverIsNewer
              ? serverEntry
              : {
                  ...entry,
                  isRead: entry.isRead || serverEntry.isRead,
                  isCompleted: entry.isCompleted || serverEntry.isCompleted,
                  deletedAt: entry.deletedAt ?? serverEntry.deletedAt,
                };

            if (this.hasEquivalentEntryState(mergedEntry, serverEntry)) {
              this.logger.warn('黑匣子 pending 推送预检：跳过对服务端权威状态的回退覆盖', {
                entryId: entry.id,
                reason: serverIsNewer ? 'server-newer-lww' : 'monotonic-regression',
                localPendingUpdatedAt: entry.updatedAt,
                serverUpdatedAt: serverEntry.updatedAt,
                localIsRead: entry.isRead,
                serverIsRead: serverEntry.isRead,
                localIsCompleted: entry.isCompleted,
                serverIsCompleted: serverEntry.isCompleted,
                localDeletedAt: entry.deletedAt,
                serverDeletedAt: serverEntry.deletedAt,
              });
              const latestLocalBeforeApply = await this.resolveLatestLocalEntry(entry.id);
              if (this.isEntryNewer(latestLocalBeforeApply, serverEntry)) {
                this.logger.debug('黑匣子预检命中更晚本地快照，跳过服务端权威状态回写', {
                  entryId: entry.id,
                  latestLocalUpdatedAt: latestLocalBeforeApply?.updatedAt,
                  serverUpdatedAt: serverEntry.updatedAt,
                });
                return true;
              }
              this.clockSync.recordServerTimestamp(serverEntry.updatedAt, entry.id);
              // 服务端权威状态覆盖本地，清除 pending；LWW 最终收敛到远端最新值
              await this.saveToLocal(serverEntry);
              updateBlackBoxEntry(serverEntry);
              return true; // 告知 RetryQueue 此条已处理完毕，不必重试
            }

            if (hasMonotonicRegression && !serverIsNewer) {
              // 本地仍有服务端未见的新编辑，把服务端 monotonic 真值合并进来再推送。
              this.logger.warn('黑匣子 pending 推送预检：合并远端单调真值后继续推送本地独有变更', {
                entryId: entry.id,
                localPendingUpdatedAt: entry.updatedAt,
                serverUpdatedAt: serverEntry.updatedAt,
                mergedIsRead: mergedEntry.isRead,
                mergedIsCompleted: mergedEntry.isCompleted,
                mergedDeletedAt: mergedEntry.deletedAt,
              });
              entry = mergedEntry;
              const pendingMerged: BlackBoxEntry = { ...mergedEntry, syncStatus: 'pending' };
              await this.saveToLocal(pendingMerged);
              updateBlackBoxEntry(pendingMerged);
              // fall through to upsert with merged entry
            }
          }
        } else if (!preflightError && !serverRow) {
          preflightServerEntry = null;
          syncRpcBaseUpdatedAt = null;
        } else if (preflightError) {
          this.logger.debug('黑匣子推送预检 SELECT 失败，延后推送等待下次对账', {
            entryId: entry.id,
            message: supabaseErrorToError(preflightError).message,
          });
          return false;
        }
      } catch (preflightException) {
        this.logger.debug('黑匣子推送预检异常，延后推送等待下次对账', {
          entryId: entry.id,
          error: preflightException instanceof Error ? preflightException.message : String(preflightException),
        });
        return false;
      }

      if (this.shouldUseSyncRpc()) {
        const result = await this.syncRpcClient!.upsertBlackboxEntry({
          operationId: this.createSyncRpcOperationId(),
          entry,
          baseUpdatedAt: syncRpcBaseUpdatedAt,
        });
        return await this.handleBlackBoxSyncRpcResult(result, entry, client, sessionUserId);
      }

      // 让数据库触发器生成权威 updated_at，避免客户端时钟偏差把跨设备完成状态盖回去。
      const blackBoxInsertPayload = {
        id: entry.id,
        project_id: entry.projectId,
        user_id: entry.userId,
        content: entry.content,
        focus_meta: (entry.focusMeta ?? null) as unknown as Json | null,
        date: entry.date,
        created_at: entry.createdAt,
        is_read: entry.isRead,
        is_completed: entry.isCompleted,
        is_archived: entry.isArchived,
        snooze_until: entry.snoozeUntil,
        snooze_count: entry.snoozeCount,
        deleted_at: entry.deletedAt,
      };
      const blackBoxUpdatePayload = {
        project_id: entry.projectId,
        content: entry.content,
        focus_meta: (entry.focusMeta ?? null) as unknown as Json | null,
        date: entry.date,
        created_at: entry.createdAt,
        is_read: entry.isRead,
        is_completed: entry.isCompleted,
        is_archived: entry.isArchived,
        snooze_until: entry.snoozeUntil,
        snooze_count: entry.snoozeCount,
        deleted_at: entry.deletedAt,
      };

      let savedRow: { id?: string; updated_at?: string | null } | null = null;
      let error: unknown | null = null;

      if (preflightServerEntry?.updatedAt) {
        ({ data: savedRow, error } = await client
          .from('black_box_entries')
          .update(blackBoxUpdatePayload)
          .eq('id', entry.id)
          .eq('user_id', sessionUserId)
          .eq('updated_at', preflightServerEntry.updatedAt)
          .select('id, updated_at')
          .maybeSingle());

        if (!error && !savedRow) {
          this.logger.warn('黑匣子 CAS 写入被并发更新打断，延后到下一轮重试', {
            entryId: entry.id,
            baseUpdatedAt: preflightServerEntry.updatedAt,
          });
          return false;
        }
      } else if (preflightServerEntry) {
        this.logger.warn('黑匣子预检命中缺失 updated_at 的远端行，放弃本轮写入避免覆盖未对账状态', {
          entryId: entry.id,
        });
        return false;
      } else {
        ({ data: savedRow, error } = await client
          .from('black_box_entries')
          .insert(blackBoxInsertPayload)
          .select('id, updated_at')
          .single());

        const code = (error as { code?: string | number } | null)?.code;
        if (error && (code === '23505' || code === 23505)) {
          this.logger.warn('黑匣子 insert 命中并发主键冲突，延后到下一轮重试', {
            entryId: entry.id,
          });
          return false;
        }
      }

      if (error) {
        const enhanced = supabaseErrorToError(error);
        this.logger.error('Failed to push entry to server', enhanced.message);
        return false;
      }

      const serverUpdatedAt = typeof savedRow?.updated_at === 'string'
        ? savedRow.updated_at
        : entry.updatedAt;
      if (serverUpdatedAt) {
        this.clockSync.recordServerTimestamp(serverUpdatedAt, entry.id);
      }

      const latestLocalAfterPush = await this.resolveLatestLocalEntry(entry.id);
      if (latestLocalAfterPush && this.isEntryNewer(latestLocalAfterPush, entry)) {
        // 【2026-05-11 根因修复·路径 B】upsert 完成但本地 latestLocal 比 entry 更晚。
        // 与 RPC 路径同策：业务字段等价则升级为 synced；否则保留 pending 等 latestLocal
        // 自己的同步链路续推。
        await this.upgradeEquivalentLatestLocalToSynced(
          latestLocalAfterPush,
          entry,
          serverUpdatedAt,
          'upsert',
        );
      } else {
        const synced: BlackBoxEntry = {
          ...entry,
          updatedAt: serverUpdatedAt,
          syncStatus: 'synced',
        };
        await this.saveToLocal(synced);
        updateBlackBoxEntry(synced);
      }

      this.logger.debug(`Entry synced to server: ${entry.id}`);
      return true;
    } catch (error) {
      this.logger.error('Sync error', error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  /**
   * 从服务器拉取变更（增量同步）
   */
  async pullChanges(options?: PullChangesOptions): Promise<void> {
    const reason = options?.reason ?? 'manual';
    const force = options?.force ?? false;
    const expectedUserId = options?.expectedUserId ?? this.resolveRemoteSessionUserId() ?? undefined;
    const expectedRealtimeGeneration = options?.expectedRealtimeGeneration;
    let preferRemoteForSyncedLocalDuringPull = false;

    if (options?.expectedUserId && this.resolveRemoteSessionUserId() !== options.expectedUserId) {
      this.logger.info('黑匣子拉取在会话切换后跳过，避免旧回调先切回旧用户游标作用域');
      return;
    }

    if (this.currentSyncUserId !== (expectedUserId ?? null)) {
      await this.syncCursorScope(expectedUserId ?? null);
    }

    if (!this.isExpectedRealtimeContextCurrent(expectedUserId, expectedRealtimeGeneration)) {
      this.logger.info('黑匣子拉取在 Realtime 订阅切换后跳过，避免旧会话覆盖当前视图');
      return;
    }

    if (reason === 'resume' || reason === 'gate-review') {
      const sessionSnapshot = FEATURE_FLAGS.RESUME_SESSION_SNAPSHOT_V1
        ? this.sessionManager.getRecentValidationSnapshot(10_000)
        : null;
      if (!sessionSnapshot?.valid) {
        const session = await this.sessionManager.validateOrRefreshOnResume(`blackbox:${reason}`);
        if (session.deferred) {
          this.logger.info('黑匣子远端拉取延后：等待会话稳定后重试', {
            reason,
            deferredReason: session.reason ?? 'client-unready',
          });
          return;
        }

        if (!session.ok) {
          this.logger.info('黑匣子远端拉取跳过：当前会话不可用', {
            reason,
            failureReason: session.reason,
          });
          return;
        }
      }
    }

    if (reason === 'gate-review') {
      const clockResult = this.clockSync.lastSyncResult();
      const shouldRefreshClock = !clockResult || !clockResult.reliable || this.clockSync.needsResync();
      let effectiveClockResult = clockResult;

      const syncClock = shouldRefreshClock
        ? this.clockSync.checkClockDrift.bind(this.clockSync)
        : this.clockSync.ensureSynced.bind(this.clockSync);

      effectiveClockResult = await syncClock().catch((error: unknown) => {
        this.logger.debug('Gate review 时钟预同步失败，降级继续拉取', {
          error: error instanceof Error ? error.message : String(error),
        });
        return effectiveClockResult ?? null;
      });

      preferRemoteForSyncedLocalDuringPull = !effectiveClockResult?.reliable;
    }

    const pendingEntriesNeedRemoteReconciliation = this.getPendingEntriesForRemoteReconciliation().length > 0;

    if (
      FEATURE_FLAGS.BLACKBOX_PULL_COOLDOWN_V1 &&
      reason === 'resume' &&
      !force &&
      !pendingEntriesNeedRemoteReconciliation &&
      this.lastResumePullAt > 0 &&
      Date.now() - this.lastResumePullAt < APP_LIFECYCLE_CONFIG.RESUME_PULL_COOLDOWN_MS
    ) {
      this.logger.debug('Resume pull skipped by cooldown');
      return;
    }

    // 【性能优化 2026-02-14】freshness window 守卫：窗口内已拉取过则跳过
    const freshnessWindow = SYNC_CONFIG.BLACKBOX_PULL_FRESHNESS_WINDOW;
    if (!force && !pendingEntriesNeedRemoteReconciliation && this.lastPullTime > 0 && Date.now() - this.lastPullTime < freshnessWindow) {
      const elapsedSec = Math.round((Date.now() - this.lastPullTime) / 1000);
      this.logger.debug(`Freshness window 内跳过拉取 (${elapsedSec}s < ${freshnessWindow / 1000}s)`);
      // 【监控 2026-02-14】记录被阻断的重复拉取，用于 Sentry 告警观测
      this.sentryLazyLoader.addBreadcrumb({
        category: 'sync.blackbox',
        message: `Duplicate pull blocked by freshness window (${elapsedSec}s)`,
        level: 'info',
        data: { reason, elapsedSec, freshnessWindow: freshnessWindow / 1000 },
      });
      // 仅对真正的手动刷新保留事件上报；面板挂载/门禁轮询等被动刷新只记 breadcrumb，避免制造告警噪音。
      if (reason === 'manual') {
        this.sentryLazyLoader.captureMessage('BlackBox duplicate pull blocked', {
          level: 'info',
          tags: {
            operation: 'pullChanges',
            classification: 'duplicate_blocked'
          },
          extra: {
            reason,
            elapsedSec,
            freshnessWindowSec: freshnessWindow / 1000
          }
        });
      }
      return;
    }

    // 防重保护：single-flight 复用进行中的拉取
    if (this.pullInFlight) {
      const inFlightReason = this.activePullOptions?.reason ?? 'manual';
      const inFlightForce = this.activePullOptions?.force ?? false;
      const inFlightExpectedUserId = this.activePullOptions?.expectedUserId;
      const inFlightExpectedRealtimeGeneration = this.activePullOptions?.expectedRealtimeGeneration;
      const hasGuardMismatch = inFlightExpectedUserId !== expectedUserId
        || (
          expectedRealtimeGeneration != null
          && inFlightExpectedRealtimeGeneration !== expectedRealtimeGeneration
        );

      if (hasGuardMismatch) {
        await this.queueForcedGateReviewPull({ expectedUserId, expectedRealtimeGeneration });
        return;
      }

      if ((reason === 'gate-review' || force) && (inFlightReason !== 'gate-review' || !inFlightForce)) {
        await this.queueForcedGateReviewPull({ expectedUserId, expectedRealtimeGeneration });
        return;
      }

      this.logger.debug('Pull already in progress, reusing promise');
      await this.pullInFlight;
      return;
    }

    if (!this.supabase.isConfigured || !this.network.isOnline() || this.isRemoteUnavailable()) {
      this.logger.debug('Offline or unconfigured, loading from local');
      await this.loadFromLocal();
      return;
    }

    this.activePullOptions = { reason, force, expectedUserId, expectedRealtimeGeneration };
    this.pullInFlight = this.doPullChanges(
      preferRemoteForSyncedLocalDuringPull,
      expectedUserId,
      expectedRealtimeGeneration,
    )
      .then((didAttemptRemoteRead) => {
        if (!this.isExpectedRealtimeContextCurrent(expectedUserId, expectedRealtimeGeneration)) {
          this.logger.info('黑匣子拉取完成后跳过 freshness 更新：Realtime 订阅上下文已变化');
          return false;
        }

        if (didAttemptRemoteRead) {
          const now = Date.now();
          this.lastPullTime = now;
          if (reason === 'resume') {
            this.lastResumePullAt = now;
          }
        }
        return didAttemptRemoteRead;
      })
      .catch((err) => {
        // 【监控 2026-02-14】拉取失败记录 Sentry breadcrumb，便于事后排查
        this.sentryLazyLoader.addBreadcrumb({
          category: 'sync.blackbox',
          message: 'Pull failed',
          level: 'warning',
          data: { reason, error: err instanceof Error ? err.message : String(err) },
        });
        throw err;
      })
      .finally(() => {
        this.pullInFlight = null;
        this.activePullOptions = null;
      });

    await this.pullInFlight;
  }

  private queueForcedGateReviewPull(guard?: Pick<PullChangesOptions, 'expectedUserId' | 'expectedRealtimeGeneration'>): Promise<void> {
    const previousGuard = this.queuedForcedGateReviewPullGuard;
    const nextExpectedUserId = guard?.expectedUserId ?? previousGuard?.expectedUserId;
    const shouldResetGeneration = guard !== undefined
      && guard.expectedRealtimeGeneration == null;
    this.queuedForcedGateReviewPullGuard = {
      expectedUserId: nextExpectedUserId,
      expectedRealtimeGeneration: shouldResetGeneration
        ? guard?.expectedRealtimeGeneration
        : (guard?.expectedRealtimeGeneration ?? previousGuard?.expectedRealtimeGeneration),
    };
    this.queuedForcedGateReviewPullVersion += 1;

    if (this.queuedForcedGateReviewPullPromise) {
      return this.queuedForcedGateReviewPullPromise;
    }

    const currentPull = this.pullInFlight;
    this.queuedForcedGateReviewPullPromise = (async () => {
      if (currentPull) {
        await currentPull.catch((error: unknown) => {
          this.logger.debug('排队中的 gate-review 强制拉取忽略前序失败并继续执行', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
      let processedVersion = 0;
      while (processedVersion !== this.queuedForcedGateReviewPullVersion) {
        processedVersion = this.queuedForcedGateReviewPullVersion;
        const queuedGuard = this.queuedForcedGateReviewPullGuard;
        await this.pullChanges({
          reason: 'gate-review',
          force: true,
          expectedUserId: queuedGuard?.expectedUserId,
          expectedRealtimeGeneration: queuedGuard?.expectedRealtimeGeneration,
        });
      }
    })().finally(() => {
      this.queuedForcedGateReviewPullPromise = null;
      this.queuedForcedGateReviewPullGuard = null;
      this.queuedForcedGateReviewPullVersion = 0;
    });

    return this.queuedForcedGateReviewPullPromise;
  }

  /**
   * 实际执行拉取变更的内部方法
   */
  private async doPullChanges(
    preferRemoteForSyncedLocalDuringPull: boolean,
    expectedUserId?: string,
    expectedRealtimeGeneration?: number,
  ): Promise<boolean> {
    try {
      if (!this.isExpectedRealtimeContextCurrent(expectedUserId, expectedRealtimeGeneration)) {
        this.logger.info('黑匣子明细拉取在 Realtime 订阅切换后中止');
        return false;
      }

      if (this.isRemoteUnavailable()) {
        await this.loadFromLocal();
        return false;
      }

      const sessionUserId = this.resolveRemoteSessionUserId();
      if (!sessionUserId) {
        this.logger.info('BlackBox 会话不可用，跳过远端增量拉取并保留本地快照');
        await this.loadFromLocal();
        return false;
      }
      const scopedUserId = expectedUserId ?? sessionUserId;
      if (scopedUserId !== sessionUserId) {
        this.logger.info('黑匣子拉取用户上下文不一致，跳过远端读取');
        return false;
      }

      const client = await this.supabase.clientAsync();
      if (!client) {
        await this.loadFromLocal();
        return false;
      }

      if (!this.isExpectedRealtimeContextCurrent(expectedUserId, expectedRealtimeGeneration)) {
        this.logger.info('黑匣子拉取在获取客户端后中止：Realtime 订阅上下文已变化');
        return false;
      }

      // 首次拉取只信任已持久化的服务端游标；不要从本地 updatedAt 反推，避免快时钟把增量窗口推到未来。
      let effectiveLastSync = this.lastSyncCursor?.updatedAt ?? this.lastSyncTime ?? '1970-01-01T00:00:00Z';
      let repairingFutureCursor = false;
      const pendingEntriesNeedRemoteReconciliation = this.getPendingEntriesForRemoteReconciliation().length > 0;

      if (FEATURE_FLAGS.BLACKBOX_WATERMARK_PROBE_V1) {
        const remoteWatermark = await this.getRemoteBlackBoxWatermark(client);
        if (!this.isExpectedRealtimeContextCurrent(expectedUserId, expectedRealtimeGeneration)) {
          this.logger.info('黑匣子 watermark 快路在 RPC 返回后中止：Realtime 订阅上下文已变化');
          return false;
        }
        const remoteMs = remoteWatermark ? new Date(remoteWatermark).getTime() : NaN;
        const localMs = new Date(effectiveLastSync).getTime();

        if (
          remoteWatermark &&
          Number.isFinite(remoteMs) &&
          Number.isFinite(localMs) &&
          localMs > remoteMs
        ) {
          this.logger.warn('检测到未来黑匣子游标，回退到安全全量拉取', {
            localCursor: effectiveLastSync,
            remoteWatermark,
          });
          effectiveLastSync = '1970-01-01T00:00:00Z';
          repairingFutureCursor = true;
        }

        if (
          remoteWatermark &&
          Number.isFinite(remoteMs) &&
          Number.isFinite(localMs) &&
          this.lastSyncCursor?.id &&
          remoteMs <= localMs &&
          effectiveLastSync !== '1970-01-01T00:00:00Z' &&
          !pendingEntriesNeedRemoteReconciliation
        ) {
          if (!this.isExpectedRealtimeContextCurrent(expectedUserId, expectedRealtimeGeneration)) {
            this.logger.info('黑匣子 watermark 快路在保存游标前中止：Realtime 订阅上下文已变化');
            return false;
          }
          await this.commitBlackBoxCursor(this.lastSyncCursor ?? { updatedAt: remoteWatermark, id: '' });
          this.logger.debug('BlackBox watermark 快路命中，跳过明细拉取', {
            remoteWatermark,
            localCursor: effectiveLastSync
          });
          return true;
        }
      }

      const effectiveLastSyncMs = new Date(effectiveLastSync).getTime();
      if (Number.isFinite(effectiveLastSyncMs) && effectiveLastSync !== '1970-01-01T00:00:00Z') {
        effectiveLastSync = new Date(Math.max(0, effectiveLastSyncMs - SYNC_CONFIG.CURSOR_SAFETY_LOOKBACK_MS)).toISOString();
      }

      this.logger.debug(`Pulling changes since: ${effectiveLastSync}`);

      let pulledRowCount = 0;
      let error: unknown = null;
      let pageCursor: BlackBoxSyncCursor = { updatedAt: effectiveLastSync, id: '' };
      const upperWatermark = FEATURE_FLAGS.BLACKBOX_WATERMARK_PROBE_V1
        ? await this.getRemoteBlackBoxWatermark(client)
        : null;
      const pullStartedAt = Date.now();
      let pulledPageCount = 0;

      while (true) {
        if (
          pulledPageCount >= this.BLACKBOX_PULL_MAX_PAGES
          || Date.now() - pullStartedAt >= this.BLACKBOX_PULL_MAX_DURATION_MS
        ) {
          this.logger.info('黑匣子分页拉取达到本轮预算，已保存当前游标，等待后续拉取继续', {
            pulledPageCount,
            pulledRowCount,
          });
          break;
        }

        const page = await this.fetchBlackBoxDeltaPage(client, pageCursor, upperWatermark, scopedUserId);
        error = page.error;

        if (
          error
          && this.sessionManager.isSessionExpiredError(supabaseErrorToError(error))
        ) {
          const refreshResult = await this.sessionManager.tryRefreshSessionWithSession('BlackBoxSync.pullChanges');
          if (refreshResult.refreshed) {
            this.logger.info('BlackBox pullChanges 会话已刷新，重试增量拉取');
            const retry = await this.fetchBlackBoxDeltaPage(client, pageCursor, upperWatermark, scopedUserId);
            error = retry.error;
            page.data = retry.data;
          }
        }

        if (error) break;

        const pageRows = (page.data ?? []) as Record<string, unknown>[];
        pulledPageCount += 1;
        pulledRowCount += pageRows.length;

        if (!this.isExpectedRealtimeContextCurrent(expectedUserId, expectedRealtimeGeneration)) {
          this.logger.info('黑匣子拉取在分页远端返回后中止：Realtime 订阅上下文已变化');
          return false;
        }

        for (const row of pageRows) {
          if (!this.isExpectedRealtimeContextCurrent(expectedUserId, expectedRealtimeGeneration)) {
            this.logger.info('黑匣子明细合并中止：Realtime 订阅上下文已变化');
            return false;
          }

          const entry = this.mapRowToEntry(row);
          await this.mergeWithLocal(entry, preferRemoteForSyncedLocalDuringPull, repairingFutureCursor);
        }

        if (pageRows.length > 0) {
          await this.commitBlackBoxCursorFromRows(pageRows);
        }

        if (pageRows.length < this.BLACKBOX_PULL_PAGE_SIZE) {
          break;
        }
        const lastRow = pageRows[pageRows.length - 1];
        if (!this.isBlackBoxCursorRow(lastRow)) {
          this.logger.warn('黑匣子分页游标缺少关键字段，停止本轮拉取以避免跳页', {
            hasUpdatedAt: typeof lastRow?.['updated_at'] === 'string',
            hasId: typeof lastRow?.['id'] === 'string',
          });
          break;
        }
        pageCursor = { updatedAt: lastRow['updated_at'], id: lastRow['id'] };
      }

      if (!this.isExpectedRealtimeContextCurrent(expectedUserId, expectedRealtimeGeneration)) {
        this.logger.info('黑匣子拉取在远端返回后中止：Realtime 订阅上下文已变化');
        return false;
      }

      if (error) {
        if (this.isBlackBoxScopedQueryUnavailable(error)) {
          this.logger.warn('BlackBox 远端拉取缺少用户作用域查询能力，保留本地快照并等待下次重试');
          await this.loadFromLocal();
          return false;
        }

        const finalErr = supabaseErrorToError(error);
        // 【鲁棒性 2026-04-16】浏览器网络挂起属瞬时错误，降级为 debug，回退到本地快照但不报 ERROR
        if (isBrowserNetworkSuspendedError(finalErr) || isBrowserNetworkSuspendedWindow()) {
          this.logger.debug('BlackBox 浏览器网络挂起，跳过增量拉取', { message: finalErr.message });
          await this.loadFromLocal();
          return true;
        }

        if (this.sessionManager.isSessionExpiredError(finalErr)) {
          this.logger.warn('BlackBox 会话失效，已保留本地快照并等待重新认证', {
            code: finalErr.code,
            message: finalErr.message,
          });
          await this.loadFromLocal();
          return true;
        }

        this.logger.error('Failed to pull changes', finalErr.message);
        await this.loadFromLocal();
        return true;
      }

      await this.reconcilePendingEntriesWithServer(
        client,
        preferRemoteForSyncedLocalDuringPull,
        repairingFutureCursor,
        scopedUserId,
        expectedRealtimeGeneration,
      );

      this.logger.info(`Pulled changes from server: ${pulledRowCount} entries`);
      return true;
    } catch (error) {
      // 【鲁棒性 2026-04-16】浏览器网络挂起：debug，不污染错误日志
      if (isBrowserNetworkSuspendedError(error) || isBrowserNetworkSuspendedWindow()) {
        this.logger.debug('BlackBox 浏览器网络挂起，跳过本轮增量拉取');
        await this.loadFromLocal();
        return false;
      }
      this.logger.error('Pull changes error', error instanceof Error ? error.message : String(error));
      await this.loadFromLocal();
      return false;
    }
  }

  private async fetchBlackBoxDeltaPage(
    client: Awaited<ReturnType<SupabaseClientService['clientAsync']>>,
    cursor: BlackBoxSyncCursor,
    upperWatermark: string | null,
    expectedUserId: string,
  ): Promise<{ data: unknown[] | null; error: unknown }> {
    if (!client) return { data: null, error: null };
    if (!expectedUserId) {
      this.logger.warn('黑匣子增量拉取缺少用户作用域，跳过远端读取');
      return { data: null, error: this.createBlackBoxScopedQueryUnavailableError() };
    }

    if (!this.isValidBlackBoxCursor(cursor)) {
      this.logger.warn('黑匣子分页游标无效，回退到安全全量窗口', {
        hasUpdatedAt: typeof cursor.updatedAt === 'string',
        hasId: typeof cursor.id === 'string',
      });
      cursor = { updatedAt: '1970-01-01T00:00:00Z', id: '' };
    }

    let baseQuery = client
        .from('black_box_entries')
        .select('*');
    const eqQuery = this.getOptionalQueryMethod<[string, string]>(baseQuery, 'eq');
    if (!eqQuery) {
      this.logger.warn('黑匣子增量拉取缺少 user_id 查询能力，跳过远端读取以避免跨用户误拉', {
        hasCursorId: Boolean(cursor.id),
      });
      return { data: null, error: this.createBlackBoxScopedQueryUnavailableError() };
    }
    baseQuery = eqQuery('user_id', expectedUserId) as typeof baseQuery;

    const keysetFilter = this.createSafeBlackBoxKeysetFilter(cursor);
    let query = keysetFilter
      ? baseQuery.or(keysetFilter)
      : baseQuery.gt('updated_at', cursor.updatedAt);

    const lteQuery = this.getOptionalQueryMethod<[string, string]>(query, 'lte');
    if (upperWatermark && typeof lteQuery === 'function') {
      query = lteQuery('updated_at', upperWatermark) as typeof query;
    }

    const orderedQuery = query
      .order('updated_at', { ascending: true })
      .order('id', { ascending: true });

    const limitQuery = this.getOptionalQueryMethod<[number]>(orderedQuery, 'limit');

    if (typeof limitQuery !== 'function') {
      return orderedQuery as unknown as Promise<{ data: unknown[] | null; error: unknown }>;
    }

    return limitQuery(this.BLACKBOX_PULL_PAGE_SIZE) as Promise<{ data: unknown[] | null; error: unknown }>;
  }

  private createBlackBoxScopedQueryUnavailableError(): Error {
    return new Error('blackbox_delta_missing_user_scope_query');
  }

  private isBlackBoxScopedQueryUnavailable(error: unknown): boolean {
    return error instanceof Error && error.message === 'blackbox_delta_missing_user_scope_query';
  }

  private getOptionalQueryMethod<TArgs extends unknown[]>(
    target: unknown,
    methodName: string,
  ): ((...args: TArgs) => unknown) | undefined {
    const targetObject = target as Record<string, unknown>;
    const candidate = targetObject[methodName];
    if (typeof candidate !== 'function') {
      return undefined;
    }

    return (...args: TArgs) => Reflect.apply(candidate, target as object, args);
  }

  private isValidBlackBoxCursor(cursor: BlackBoxSyncCursor): boolean {
    const updatedAtMs = Date.parse(cursor.updatedAt);
    return Number.isFinite(updatedAtMs) && (!cursor.id || isValidUUID(cursor.id));
  }

  private createSafeBlackBoxKeysetFilter(cursor: BlackBoxSyncCursor): string | null {
    if (!cursor.id || !this.isValidBlackBoxCursor(cursor)) return null;
    return `updated_at.gt.${cursor.updatedAt},and(updated_at.eq.${cursor.updatedAt},id.gt.${cursor.id})`;
  }

  private isBlackBoxCursorRow(row: Record<string, unknown> | undefined): row is Record<string, unknown> & {
    id: string;
    updated_at: string;
  } {
    return typeof row?.['id'] === 'string'
      && isValidUUID(row['id'])
      && typeof row['updated_at'] === 'string'
      && Number.isFinite(Date.parse(row['updated_at']));
  }

  private async getRemoteBlackBoxWatermark(
    client: Awaited<ReturnType<SupabaseClientService['clientAsync']>>
  ): Promise<string | null> {
    if (!client) return null;
    try {
      const { data, error } = await client.rpc('get_black_box_sync_watermark');
      if (error) {
        this.logger.debug('BlackBox watermark RPC 失败，降级为明细拉取', { message: error.message });
        return null;
      }
      if (typeof data === 'string') {
        return data;
      }
      // RPC 返回类型可能为数组形式，需要 unknown 过渡处理
      const raw = data as unknown;
      if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === 'string') {
        return raw[0];
      }
      return null;
    } catch (error) {
      this.logger.debug('BlackBox watermark RPC 异常，降级为明细拉取', {
        error: error instanceof Error ? error.message : String(error)
      });
      // eslint-disable-next-line no-restricted-syntax -- RPC 不可用时降级为明细拉取（返回 null 触发 fallback 路径）
      return null;
    }
  }

  /**
   * 合并远程数据到本地（LWW 冲突解决）
   */
  private async mergeWithLocal(
    remote: BlackBoxEntry,
    preferRemoteForSyncedLocalDuringPull: boolean,
    repairingFutureCursor: boolean,
  ): Promise<void> {
    const local = blackBoxEntriesMap().get(remote.id);
    const localWinsByLww = Boolean(local)
      && Boolean(local?.updatedAt)
      && Boolean(remote.updatedAt)
      && this.clockSync.isLocalNewer(local!.updatedAt, remote.updatedAt);
    const preferRemoteForSyncedLocal = (preferRemoteForSyncedLocalDuringPull || repairingFutureCursor)
      && local?.syncStatus !== 'pending';

    const shouldUseRemote = !local || preferRemoteForSyncedLocal || !localWinsByLww;

    if (shouldUseRemote) {
      const safeRemote = this.hydrateBlankContentFromSource(remote, local, 'local-merge');
      await this.saveToLocal(safeRemote);
      updateBlackBoxEntry(safeRemote);
      return;
    }

    // 【2026-04-23 根因修复·加强版】即便本地 pending 在 LWW 上赢过远端，也要把远端的单调
    // 真值(is_read / is_completed / deletedAt)立刻合并进本地 pending，避免 UI 继续把一个
    // 服务端早已完成/已读/已删的条目展示在大门里，同时保留本地仍未推送的 content /
    // snoozeUntil / isArchived 等编辑。pushToServer 的 preflight 还会再守一道门，这里只是
    // 提前让 UI 收敛。
    if (local && local.syncStatus === 'pending') {
      const wouldRegressRead = remote.isRead && !local.isRead;
      const wouldRegressCompleted = remote.isCompleted && !local.isCompleted;
      const wouldResurrectDeleted = Boolean(remote.deletedAt) && !local.deletedAt;

      if (wouldRegressRead || wouldRegressCompleted || wouldResurrectDeleted) {
        const merged: BlackBoxEntry = {
          ...local,
          isRead: local.isRead || remote.isRead,
          isCompleted: local.isCompleted || remote.isCompleted,
          deletedAt: local.deletedAt ?? remote.deletedAt,
          // 保持 pending 状态，后续 push 会带着合并后的真值再次与服务端对齐
          syncStatus: 'pending',
        };
        this.logger.warn('黑匣子 pull 合并：本地 pending 胜出 LWW，但合并远端单调真值以免大门继续展示已完成条目', {
          entryId: remote.id,
          localUpdatedAt: local.updatedAt,
          remoteUpdatedAt: remote.updatedAt,
          mergedIsRead: merged.isRead,
          mergedIsCompleted: merged.isCompleted,
          mergedDeletedAt: merged.deletedAt,
        });
        await this.saveToLocal(merged);
        updateBlackBoxEntry(merged);

        // 【2026-05-11 根因修复·路径 C】保留 pending 后必须主动把 merged 重新入队，
        // 否则没有任何机制会再次触发这条 entry 的 push，直到用户下次手动 update，
        // 表现就是 UI 长期"待同步"。优先走 retryQueueHandler 享受主同步通道的
        // 持久化 + 指数回退；没有 handler 时降级为内联 pushToServer。
        if (this.retryQueueHandler) {
          this.retryQueueHandler(merged);
        } else {
          void this.pushToServer(merged).catch(err => {
            this.logger.error(
              '黑匣子 mergeWithLocal 续推失败',
              err instanceof Error ? err.message : String(err),
            );
          });
        }
        return;
      }
    }

    this.logger.debug('保留更晚的本地黑匣子快照，跳过远端覆盖', {
      entryId: remote.id,
      syncStatus: local?.syncStatus ?? 'unknown',
      localUpdatedAt: local?.updatedAt,
      remoteUpdatedAt: remote.updatedAt,
    });
  }

  /**
   * 映射数据库行到条目
   */
  private mapRowToEntry(row: Record<string, unknown>): BlackBoxEntry {
    return {
      id: row['id'] as string,
      projectId: (row['project_id'] as string | null) ?? null,
      userId: (row['user_id'] as string) || '',
      content: (row['content'] as string) || '',  // 防止 content 为 null/undefined
      focusMeta: (row['focus_meta'] as BlackBoxEntry['focusMeta']) ?? null,
      date: (row['date'] as string) || new Date().toISOString().split('T')[0],
      createdAt: (row['created_at'] as string) || new Date().toISOString(),
      updatedAt: (row['updated_at'] as string) || new Date().toISOString(),
      isRead: (row['is_read'] as boolean) ?? false,
      isCompleted: (row['is_completed'] as boolean) ?? false,
      isArchived: (row['is_archived'] as boolean) ?? false,
      snoozeUntil: row['snooze_until'] as string | undefined,
      snoozeCount: row['snooze_count'] as number | undefined,
      deletedAt: row['deleted_at'] as string | null,
      syncStatus: 'synced'
    };
  }

  /**
   * 获取待同步条目数量
   */
  getPendingSyncCount(): number {
    return this.pendingPushEntries.size;
  }

  /**
   * 强制同步
   */
  async forceSync(): Promise<void> {
    // 立即刷新防抖中的条目
    if (this.pushDebounceTimer) {
      clearTimeout(this.pushDebounceTimer);
      this.pushDebounceTimer = null;
    }
    this.flushPendingToRetryQueue();

    await this.pullChanges({ reason: 'manual', force: true });
  }
}
