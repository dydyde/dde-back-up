/**
 * ActionQueueStorageService — 操作队列存储与辅助服务
 *
 * 职责：
 * - localStorage / IndexedDB 持久化
 * - 死信队列管理（signals + CRUD）
 * - 错误分类与重试调度
 * - 网络状态监听
 *
 * 从 ActionQueueService 拆分，降低单文件复杂度
 */
import { Injectable, inject, signal, WritableSignal } from '@angular/core';
import { QUEUE_CONFIG } from '../config';
import { AUTH_CONFIG } from '../config/auth.config';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { NetworkAwarenessService } from './network-awareness.service';
import { AuthService } from './auth.service';
import { QueueBackupService, type LegacyQueueReviewItem } from './queue-backup.service';
import { DeadLetterItem, QueuedAction, TaskDeletePayload, TaskPayload } from './action-queue.types';
import {
  getRemainingBrowserNetworkResumeDelayMs,
  isBrowserNetworkSuspendedWindow,
} from '../utils/browser-network-suspension';

/**
 * 操作队列本地配置
 */
export const LOCAL_QUEUE_CONFIG = {
  /** 最大重试次数 */
  MAX_RETRIES: 5,
  /** 重试延迟基数（毫秒） */
  RETRY_BASE_DELAY: QUEUE_CONFIG.RETRY_BASE_DELAY,
  /** 队列存储键 */
  QUEUE_STORAGE_KEY: 'nanoflow.action-queue',
  /** 死信队列存储键 */
  DEAD_LETTER_STORAGE_KEY: 'nanoflow.dead-letter-queue',
  /** 最大队列大小 */
  MAX_QUEUE_SIZE: 100,
  /** 死信队列最大大小 */
  MAX_DEAD_LETTER_SIZE: 50,
  /** 死信队列条目最大存活时间（毫秒）- 24小时 */
  DEAD_LETTER_TTL: 24 * 60 * 60 * 1000,
  /** 无处理器操作超时（毫秒）- 5分钟后移入死信队列 */
  NO_PROCESSOR_TIMEOUT: QUEUE_CONFIG.NO_PROCESSOR_TIMEOUT,
  /** 业务错误模式（这些错误不需要重试） */
  BUSINESS_ERROR_PATTERNS: [
    'not found',
    'permission denied',
    'unauthorized',
    'forbidden',
    'row level security',
    'rls',
    'violates',
    'duplicate key',
    'unique constraint',
    'foreign key',
    'invalid input'
  ],
  /** 关键操作失败通知阈值 */
  CRITICAL_FAILURE_NOTIFY_THRESHOLD: 3,
  /** 低优先级队列最大大小 */
  LOW_PRIORITY_MAX_SIZE: 20
} as const;

/**
 * 操作队列上下文 — 由 ActionQueueService 在初始化时提供
 * 避免循环依赖：storage 不注入 ActionQueueService
 */
export interface ActionQueueContext {
  dequeue: (id: string) => void;
  syncSentryContext: () => void;
  processQueue: () => Promise<unknown>;
  pendingActions: WritableSignal<QueuedAction[]>;
  queueSize: WritableSignal<number>;
}

export interface QueueRetryError {
  code?: string;
  message: string;
  details?: Record<string, unknown>;
}

interface LegacyActionReviewItem {
  action: QueuedAction;
  source: 'legacy-global-queue' | 'legacy-idb-backup';
  capturedAt: string;
  ownerUserId: string;
}

const LEGACY_UNKNOWN_OWNER_USER_ID = '__legacy_unknown__';

@Injectable({ providedIn: 'root' })
export class ActionQueueStorageService {
  private readonly logger = inject(LoggerService).category('ActionQueueStorage');
  private readonly toast = inject(ToastService);
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly networkAwareness = inject(NetworkAwarenessService);
  private readonly authService = inject(AuthService);
  private readonly queueBackup = inject(QueueBackupService);

  // ========== 死信队列 ==========
  readonly deadLetterQueue = signal<DeadLetterItem[]>([]);
  readonly deadLetterSize = signal(0);

  // ========== 存储失败状态 ==========
  readonly storageFailure = signal(false);
  readonly queueFrozen = signal(false);
  readonly queueFreezeReason = signal<string | null>(null);
  private storageFailureCallback: ((data: { queue: QueuedAction[]; deadLetter: DeadLetterItem[] }) => void) | null = null;

  // ========== 网络状态 ==========
  private _isOnline = true;
  get isOnline(): boolean { return this._isOnline; }
  set isOnline(v: boolean) { this._isOnline = v; }

  // ========== 失败回调 ==========
  private failureCallbacks: Array<(item: DeadLetterItem) => void> = [];

  // ========== 网络监听器引用 ==========
  private onlineHandler: (() => void) | null = null;
  private offlineHandler: (() => void) | null = null;
  private visibilityChangeHandler: (() => void) | null = null;
  private pageShowHandler: ((event: PageTransitionEvent) => void) | null = null;

  // ========== 重试定时器 ==========
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimerDueAt: number | null = null;

  private readonly LEGACY_QUEUE_BACKUP_RECORD_ID = 'queue';
  private readonly LEGACY_REVIEW_STORAGE_KEY_PREFIX = 'nanoflow.action-queue.legacy-review.';
  private legacyReviewWarningShown = false;
  private queueRestoreGeneration = 0;
  
  /** 冻结期定时重试落盘的定时器 */
  private frozenRetryTimer: ReturnType<typeof setTimeout> | null = null;
  /** 冻结期重试次数 */
  private frozenRetryCount = 0;
  /** 冻结期重试最大次数 */
  private readonly FROZEN_RETRY_MAX = 10;
  /** 冻结期重试初始间隔（毫秒） */
  private readonly FROZEN_RETRY_BASE_DELAY = 30000;
  /** 冻结期重试最大间隔（毫秒） */
  private readonly FROZEN_RETRY_MAX_DELAY = 300000;

  // ========== 来自主服务的上下文引用 ==========
  private _ctx: ActionQueueContext | null = null;
  /** 安全访问上下文，未初始化时抛出明确错误而非 undefined 崩溃 */
  private get ctx(): ActionQueueContext {
    if (!this._ctx) {
      throw new Error('[ActionQueueStorage] ctx 未初始化，请确保 ActionQueueService 已完成构造');
    }
    return this._ctx;
  }

  /**
   * 初始化上下文引用（由 ActionQueueService 构造时调用）
   */
  init(ctx: ActionQueueContext): void {
    this._ctx = ctx;
  }

  // ========== 回调注册 ==========

  /** 注册失败通知回调，返回取消订阅函数 */
  onFailure(callback: (item: DeadLetterItem) => void): () => void {
    this.failureCallbacks.push(callback);
    return () => {
      const idx = this.failureCallbacks.indexOf(callback);
      if (idx >= 0) this.failureCallbacks.splice(idx, 1);
    };
  }

  /** 注册存储失败回调（逃生模式） */
  onStorageFailure(callback: (data: { queue: QueuedAction[]; deadLetter: DeadLetterItem[] }) => void): void {
    this.storageFailureCallback = callback;
  }

  private getCurrentOwnerUserId(): string {
    return this.authService.currentUserId() ?? AUTH_CONFIG.LOCAL_MODE_USER_ID;
  }

  private getScopedStorageKey(baseKey: string, ownerUserId = this.getCurrentOwnerUserId()): string {
    return `${baseKey}.${ownerUserId}`;
  }

  private getLegacyReviewStorageKey(ownerUserId = this.getCurrentOwnerUserId()): string {
    return `${this.LEGACY_REVIEW_STORAGE_KEY_PREFIX}${ownerUserId}`;
  }

  private invalidateLocalQueueSnapshot(ownerUserId = this.getCurrentOwnerUserId()): void {
    if (typeof localStorage === 'undefined') {
      return;
    }

    try {
      localStorage.removeItem(this.getScopedStorageKey(LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY, ownerUserId));
      if (ownerUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
        localStorage.removeItem(LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY);
      }
    } catch (error) {
      this.logger.warn('清理失效的 localStorage 队列快照失败', { ownerUserId, error });
    }
  }

  private readQueueSnapshotFromLocalStorage(ownerUserId: string): {
    found: boolean;
    queue: QueuedAction[];
  } {
    if (typeof localStorage === 'undefined') {
      return { found: false, queue: [] };
    }

    const scopedKey = this.getScopedStorageKey(LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY, ownerUserId);
    const scopedValue = localStorage.getItem(scopedKey);
    if (scopedValue !== null) {
      try {
        const queue = JSON.parse(scopedValue) as QueuedAction[];
        return { found: true, queue: Array.isArray(queue) ? queue : [] };
      } catch (error) {
        this.logger.warn('读取 owner-scoped 队列失败，按空队列处理', { ownerUserId, error });
        return { found: true, queue: [] };
      }
    }

    return { found: false, queue: [] };
  }

  private readDeadLetterSnapshotFromLocalStorage(ownerUserId: string): DeadLetterItem[] {
    if (typeof localStorage === 'undefined') {
      return [];
    }

    const scopedKey = this.getScopedStorageKey(LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY, ownerUserId);
    const scopedValue = localStorage.getItem(scopedKey);
    if (scopedValue !== null) {
      try {
        const queue = JSON.parse(scopedValue) as DeadLetterItem[];
        return Array.isArray(queue) ? queue : [];
      } catch (error) {
        this.logger.warn('读取 owner-scoped dead-letter 失败，按空队列处理', { ownerUserId, error });
        return [];
      }
    }

    return [];
  }

  private async loadPersistedQueueForOwner(ownerUserId: string): Promise<QueuedAction[]> {
    const localSnapshot = this.readQueueSnapshotFromLocalStorage(ownerUserId);
    if (localSnapshot.found) {
      return localSnapshot.queue;
    }

    const backupQueue = await this.queueBackup.restoreQueue(ownerUserId, (legacyItems) => {
      this.quarantineLegacyQueueForReview(
        legacyItems.map((item) => item.action),
        'legacy-idb-backup'
      );
    });
    return backupQueue ?? [];
  }

  private async saveQueueSnapshotForOwner(ownerUserId: string, queue: QueuedAction[]): Promise<void> {
    let localSnapshotSaved = false;
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(
          this.getScopedStorageKey(LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY, ownerUserId),
          JSON.stringify(queue)
        );
        if (ownerUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
          localStorage.removeItem(LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY);
        }
        localSnapshotSaved = true;
      } catch (error) {
        this.logger.warn('保存 owner-scoped 队列快照失败，降级写入 IndexedDB 备份', {
          ownerUserId,
          error,
        });
      }
    }

    const backupSucceeded = await this.queueBackup.backupQueue(queue, ownerUserId);
    if (!localSnapshotSaved && backupSucceeded) {
      this.invalidateLocalQueueSnapshot(ownerUserId);
      return;
    }

    if (localSnapshotSaved || backupSucceeded) {
      return;
    }

    this.freezeQueueWrites('storage_failure');
    this.triggerStorageFailureEscapeMode();
    throw new Error(`owner-scoped 队列保存失败: ${ownerUserId}`);
  }

  async persistQueueSnapshotForOwner(ownerUserId: string, queue: QueuedAction[]): Promise<boolean> {
    try {
      await this.saveQueueSnapshotForOwner(ownerUserId, queue);
      return true;
    } catch (error) {
      this.logger.warn('持久化 owner-scoped 队列快照失败', {
        ownerUserId,
        error,
      });
      return false;
    }
  }

  private saveDeadLetterSnapshotForOwner(ownerUserId: string, queue: DeadLetterItem[]): void {
    if (typeof localStorage === 'undefined') {
      return;
    }

    try {
      localStorage.setItem(
        this.getScopedStorageKey(LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY, ownerUserId),
        JSON.stringify(queue)
      );
      if (ownerUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
        localStorage.removeItem(LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY);
      }
    } catch (error) {
      this.logger.warn('保存 owner-scoped dead-letter 快照失败', { ownerUserId, error });
    }
  }

  async settleSuccessfulActionForOwner(ownerUserId: string, actionId: string): Promise<boolean> {
    const queue = await this.loadPersistedQueueForOwner(ownerUserId);
    const nextQueue = queue.filter(action => action.id !== actionId);
    if (nextQueue.length === queue.length) {
      this.logger.debug('旧 owner 队列中未找到待收口的成功 action', { ownerUserId, actionId });
      return false;
    }
    await this.saveQueueSnapshotForOwner(ownerUserId, nextQueue);
    return true;
  }

  async loadQueueSnapshotForOwner(ownerUserId: string): Promise<QueuedAction[]> {
    return this.loadPersistedQueueForOwner(ownerUserId);
  }

  async settleProjectDeleteSuccessForOwner(
    ownerUserId: string,
    projectId: string,
    actionId?: string,
  ): Promise<number> {
    const queue = await this.loadPersistedQueueForOwner(ownerUserId);
    const nextQueue = queue.filter(action => {
      if (actionId && action.id === actionId) {
        return false;
      }

      if (action.entityType === 'project' && action.entityId === projectId) {
        return false;
      }

      if (action.entityType === 'task') {
        const payload = action.payload as TaskPayload | TaskDeletePayload;
        return payload.projectId !== projectId;
      }

      return true;
    });

    const removedCount = queue.length - nextQueue.length;
    if (removedCount === 0) {
      this.logger.debug('旧 owner 队列中未找到待收口的项目删除关联 action', {
        ownerUserId,
        projectId,
        actionId,
      });
      return 0;
    }

    await this.saveQueueSnapshotForOwner(ownerUserId, nextQueue);
    return removedCount;
  }

  async settleFailedActionForOwner(
    ownerUserId: string,
    action: QueuedAction,
    error: string | QueueRetryError
  ): Promise<'retry' | 'dead-letter' | 'missing'> {
    const queue = await this.loadPersistedQueueForOwner(ownerUserId);
    const existingAction = queue.find(item => item.id === action.id);
    if (!existingAction) {
      this.logger.debug('旧 owner 队列中未找到待收口的失败 action', {
        ownerUserId,
        actionId: action.id,
      });
      return 'missing';
    }

    const normalizedError = this.normalizeRetryError(error);
    const errorMessage = this.formatRetryError(normalizedError);
    const errorType = this.classifyError(normalizedError);
    if (errorType === 'business' || errorType === 'permission' || existingAction.retryCount >= LOCAL_QUEUE_CONFIG.MAX_RETRIES) {
      const nextQueue = queue.filter(item => item.id !== action.id);
      const deadLetterItem: DeadLetterItem = {
        action: {
          ...existingAction,
          lastError: errorMessage,
          errorType,
        },
        failedAt: new Date().toISOString(),
        reason: errorType === 'business' || errorType === 'permission'
          ? `${errorType === 'business' ? '业务' : '权限'}错误: ${errorMessage}`
          : `超过最大重试次数 (${LOCAL_QUEUE_CONFIG.MAX_RETRIES}): ${errorMessage}`,
      };

      const deadLetters = this.readDeadLetterSnapshotFromLocalStorage(ownerUserId)
        .filter(item => item.action.id !== action.id);
      deadLetters.push(deadLetterItem);

      await this.saveQueueSnapshotForOwner(ownerUserId, nextQueue);
      this.saveDeadLetterSnapshotForOwner(
        ownerUserId,
        deadLetters.slice(-LOCAL_QUEUE_CONFIG.MAX_DEAD_LETTER_SIZE)
      );
      return 'dead-letter';
    }

    const nextQueue = queue.map(item => item.id === action.id
      ? {
          ...item,
          retryCount: errorType === 'deferred' ? item.retryCount : item.retryCount + 1,
          lastError: errorMessage,
          errorType,
        }
      : item
    );
    await this.saveQueueSnapshotForOwner(ownerUserId, nextQueue);
    return 'retry';
  }

  async appendActionForOwner(ownerUserId: string, action: QueuedAction): Promise<void> {
    const queue = await this.loadPersistedQueueForOwner(ownerUserId);
    await this.saveQueueSnapshotForOwner(ownerUserId, [
      ...queue.filter(existing => existing.id !== action.id),
      action,
    ]);
  }

  private clearLegacyGlobalStorageIfLocalOwner(baseKey: string): void {
    if (this.getCurrentOwnerUserId() !== AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      return;
    }

    localStorage.removeItem(baseKey);
  }

  private readScopedDeadLetterQueueFromStorage(): DeadLetterItem[] {
    if (typeof localStorage === 'undefined') {
      return [];
    }

    try {
      const raw = localStorage.getItem(this.getScopedStorageKey(LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY));
      if (!raw) {
        return [];
      }

      const parsed = JSON.parse(raw) as DeadLetterItem[];
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      this.logger.warn('读取 scoped dead-letter 失败，已退回内存态合并', { error });
      return [];
    }
  }

  private mergeLegacyDeadLetters(deadLetters: DeadLetterItem[], ownerUserId: string): void {
    if (deadLetters.length === 0) {
      return;
    }

    const mergedByActionId = new Map<string, DeadLetterItem>();
    const existingDeadLetters = ownerUserId === this.getCurrentOwnerUserId()
      ? [
          ...this.readScopedDeadLetterQueueFromStorage(),
          ...this.deadLetterQueue(),
        ]
      : this.readDeadLetterSnapshotFromLocalStorage(ownerUserId);

    for (const item of [...existingDeadLetters, ...deadLetters]) {
      mergedByActionId.set(item.action.id, item);
    }

    const mergedQueue = Array.from(mergedByActionId.values()).slice(-LOCAL_QUEUE_CONFIG.MAX_DEAD_LETTER_SIZE);
    this.saveDeadLetterSnapshotForOwner(ownerUserId, mergedQueue);

    if (ownerUserId === this.getCurrentOwnerUserId()) {
      this.deadLetterQueue.set(mergedQueue);
      this.deadLetterSize.set(mergedQueue.length);
      this.ctx.syncSentryContext();
    }
  }

  private quarantineLegacyQueueForReview(
    actions: QueuedAction[],
    source: 'legacy-global-queue' | 'legacy-idb-backup'
  ): void {
    if (typeof localStorage === 'undefined' || actions.length === 0) {
      return;
    }

    const ownerUserId = LEGACY_UNKNOWN_OWNER_USER_ID;
    const key = this.getLegacyReviewStorageKey(ownerUserId);

    try {
      const existing = localStorage.getItem(key);
      const records = existing ? JSON.parse(existing) as LegacyActionReviewItem[] : [];
      const deduped = records.filter(record => !actions.some(action => action.id === record.action.id));
      const nextRecords = [
        ...deduped,
        ...actions.map(action => ({
          action,
          source,
          capturedAt: new Date().toISOString(),
          ownerUserId,
        } satisfies LegacyActionReviewItem)),
      ];
      localStorage.setItem(key, JSON.stringify(nextRecords));
      this.mergeLegacyDeadLetters(actions.map(action => ({
        action,
        failedAt: new Date().toISOString(),
        reason: source === 'legacy-global-queue'
          ? '旧版全局离线队列已隔离待确认'
          : '旧版离线备份队列已隔离待确认',
      })), ownerUserId);

      if (!this.legacyReviewWarningShown) {
        this.legacyReviewWarningShown = true;
        this.toast.warning('检测到待确认的离线操作', '旧版离线队列已隔离保留，不会在当前账号下自动执行');
      }

      this.logger.warn('检测到 legacy ActionQueue 数据，已隔离保留待人工确认', {
        ownerUserId,
        source,
        count: actions.length,
      });
    } catch (error) {
      this.logger.warn('隔离 legacy ActionQueue 数据失败，已保留原始存储键', { source, error });
    }
  }

  private quarantineLegacyDeadLetters(deadLetters: DeadLetterItem[]): void {
    if (deadLetters.length === 0) {
      return;
    }

    const ownerUserId = LEGACY_UNKNOWN_OWNER_USER_ID;

    const migratedDeadLetters = deadLetters.map(item => ({
      ...item,
      reason: `旧版全局死信已隔离待确认: ${item.reason}`,
    }));
    this.mergeLegacyDeadLetters(migratedDeadLetters, ownerUserId);

    if (!this.legacyReviewWarningShown) {
      this.legacyReviewWarningShown = true;
      this.toast.warning('检测到待确认的离线操作', '旧版离线死信已隔离保留，不会并入当前账号的失败队列');
    }

    this.logger.warn('检测到 legacy dead-letter 数据，已隔离到未知 owner 桶', {
      ownerUserId,
      count: deadLetters.length,
    });
  }

  private loadScopedOrLegacyStorage(baseKey: string): string | null {
    const scopedKey = this.getScopedStorageKey(baseKey);
    const scopedValue = localStorage.getItem(scopedKey);
    if (scopedValue !== null) {
      return scopedValue;
    }

    const legacyValue = localStorage.getItem(baseKey);
    if (legacyValue === null) {
      return null;
    }

    if (baseKey === LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY) {
      try {
        const legacyQueue = JSON.parse(legacyValue) as QueuedAction[];
        if (Array.isArray(legacyQueue) && legacyQueue.length > 0) {
          try {
            this.quarantineLegacyQueueForReview(legacyQueue, 'legacy-global-queue');
          } finally {
            localStorage.removeItem(baseKey);
          }
        }
      } catch (error) {
        this.logger.warn('读取 legacy 全局队列失败，已保留原始存储键', { error });
      }
      return null;
    }

    if (baseKey === LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY) {
      try {
        const legacyDeadLetters = JSON.parse(legacyValue) as DeadLetterItem[];
        if (Array.isArray(legacyDeadLetters) && legacyDeadLetters.length > 0) {
          try {
            this.quarantineLegacyDeadLetters(legacyDeadLetters);
          } finally {
            localStorage.removeItem(baseKey);
          }
        }
      } catch (error) {
        this.logger.warn('读取 legacy 全局死信失败，已保留原始存储键', { error });
      }
      return null;
    }

    return null;
  }

  // ========== 死信队列公共操作 ==========

  clearDeadLetterQueue(): void {
    this.deadLetterQueue.set([]);
    this.deadLetterSize.set(0);
    this.saveDeadLetterToStorage();
    this.ctx.syncSentryContext();
  }

  retryDeadLetter(itemId: string): void {
    const item = this.deadLetterQueue().find(d => d.action.id === itemId);
    if (!item) return;

    const resetAction: QueuedAction = {
      ...item.action,
      retryCount: 0,
      lastError: undefined,
      errorType: undefined
    };

    // 从死信移除
    this.deadLetterQueue.update(q => q.filter(d => d.action.id !== itemId));
    this.deadLetterSize.set(this.deadLetterQueue().length);
    this.saveDeadLetterToStorage();

    // 重新加入主队列
    this.ctx.pendingActions.update(q => [...q, resetAction]);
    this.ctx.queueSize.set(this.ctx.pendingActions().length);
    this.saveQueueToStorage();
    this.ctx.syncSentryContext();

    if (this._isOnline) {
      void this.ctx.processQueue();
    }
  }

  dismissDeadLetter(itemId: string): void {
    this.deadLetterQueue.update(q => q.filter(d => d.action.id !== itemId));
    this.deadLetterSize.set(this.deadLetterQueue().length);
    this.saveDeadLetterToStorage();
    this.ctx.syncSentryContext();
  }

  hasDeadLetters(): boolean {
    return this.deadLetterQueue().length > 0;
  }

  // ========== 死信队列内部操作 ==========

  /**
   * 移动操作到死信队列
   * 按优先级策略：low 静默丢弃，normal 正常入队，critical 通知用户
   */
  moveToDeadLetter(action: QueuedAction, reason: string): void {
    const deadLetterItem: DeadLetterItem = {
      action,
      failedAt: new Date().toISOString(),
      reason
    };

    this.ctx.dequeue(action.id);

    this.deadLetterQueue.update(queue => {
      const updated = [...queue, deadLetterItem];
      // 限制死信队列大小，移除最老的条目
      if (updated.length > LOCAL_QUEUE_CONFIG.MAX_DEAD_LETTER_SIZE) {
        const overflow = updated.length - LOCAL_QUEUE_CONFIG.MAX_DEAD_LETTER_SIZE;
        this.logger.warn('死信队列超出上限，移除最旧的条目', { overflow, maxSize: LOCAL_QUEUE_CONFIG.MAX_DEAD_LETTER_SIZE });
        return updated.slice(overflow);
      }
      return updated;
    });

    this.deadLetterSize.set(this.deadLetterQueue().length);
    this.saveDeadLetterToStorage();
    this.ctx.syncSentryContext();

    // 通知监听者
    this.failureCallbacks.forEach(cb => {
      try { cb(deadLetterItem); } catch (e) { this.logger.error('Dead letter callback error', { error: e }); }
    });

    // 关键操作失败通知
    if (action.priority === 'critical') {
      const criticalFailures = this.deadLetterQueue().filter(d => d.action.priority === 'critical');
      if (criticalFailures.length === 1) {
        this.toast.warning('操作未能同步', `"${this.getActionDescription(action)}" 同步失败，稍后将自动重试`);
        this.logger.warn('首次关键操作失败，已通知用户', {
          actionId: action.id, entityType: action.entityType, type: action.type
        });
      } else if (criticalFailures.length >= LOCAL_QUEUE_CONFIG.CRITICAL_FAILURE_NOTIFY_THRESHOLD) {
        this.toast.error('同步失败', `有 ${criticalFailures.length} 个重要操作无法完成同步，请检查网络或稍后重试`);
        this.logger.warn('关键操作失败超过阈值，已通知用户', {
          count: criticalFailures.length, threshold: LOCAL_QUEUE_CONFIG.CRITICAL_FAILURE_NOTIFY_THRESHOLD
        });
      }
    }

    this.sentryLazyLoader.addBreadcrumb({
      category: 'sync',
      message: `Action moved to dead letter`,
      level: 'warning',
      data: {
        actionId: action.id, entityType: action.entityType, entityId: action.entityId,
        type: action.type, priority: action.priority, reason,
        deadLetterSize: this.deadLetterQueue().length
      }
    });

    this.logger.warn('Action moved to dead letter queue:', {
      actionId: action.id, type: action.type, entityType: action.entityType,
      entityId: action.entityId, priority: action.priority, reason
    });
  }

  /**
   * 暂停依赖于失败 Create 的操作
   */
  pauseDependentActions(entityType: string, entityId: string, queue: QueuedAction[]): void {
    const dependentActions = queue.filter(a =>
      a.entityType === entityType && a.entityId === entityId && a.type !== 'create'
    );

    if (dependentActions.length > 0) {
      this.logger.warn('Create 失败，暂停依赖操作', {
        entityType, entityId,
        dependentCount: dependentActions.length,
        dependentTypes: dependentActions.map(a => a.type)
      });

      this.sentryLazyLoader.captureMessage('Create failed, dependent actions paused', {
        level: 'warning',
        tags: { operation: 'pauseDependentActions', entityType },
        extra: {
          entityId, dependentCount: dependentActions.length,
          dependentActions: dependentActions.map(a => ({ id: a.id, type: a.type }))
        }
      });

      const hasCriticalBlocked = dependentActions.some(a => a.priority === 'critical');
      if (hasCriticalBlocked) {
        this.toast.warning('同步受阻', '有操作因前置操作失败而暂停，请检查网络连接');
      }
    }
  }

  // ========== 重试逻辑 ==========

  /**
   * 处理重试逻辑
   * 根据错误分类决定：重试 or 移入死信队列
   */
  handleRetry(action: QueuedAction, error: string | QueueRetryError): 'retry' | 'dead-letter' {
    const normalizedError = this.normalizeRetryError(error);
    const errorMessage = this.formatRetryError(normalizedError);
    const errorType = this.classifyError(normalizedError);

    // 业务/权限错误不可重试
    if (errorType === 'business' || errorType === 'permission') {
      this.logger.warn(`${errorType === 'business' ? '业务' : '权限'}错误，不可重试`, {
        actionId: action.id,
        error: errorMessage,
      });
      this.moveToDeadLetter(action, `${errorType === 'business' ? '业务' : '权限'}错误: ${errorMessage}`);
      return 'dead-letter';
    }

    if (errorType === 'deferred') {
      const delay = this.resolveBrowserSuspensionDelay(normalizedError);
      this.ctx.pendingActions.update(queue =>
        queue.map(a => a.id === action.id
          ? { ...a, lastError: errorMessage, errorType }
          : a
        )
      );
      this.saveQueueToStorage();

      this.logger.info('浏览器网络挂起，延后队列重试且不消耗 retry budget', {
        actionId: action.id,
        type: action.type,
        entityType: action.entityType,
        entityId: action.entityId,
        delay,
      });
      this.scheduleRetry(delay);
      return 'retry';
    }

    // 超过最大重试次数
    if (action.retryCount >= LOCAL_QUEUE_CONFIG.MAX_RETRIES) {
      this.logger.error('超过最大重试次数，移入死信队列', {
        actionId: action.id, type: action.type,
        entityType: action.entityType, entityId: action.entityId, error: errorMessage
      });
      this.moveToDeadLetter(action, `超过最大重试次数 (${LOCAL_QUEUE_CONFIG.MAX_RETRIES}): ${errorMessage}`);

      if (action.priority === 'critical') {
        this.toast.error('重要操作失败', `${this.getActionLabel(action)} 失败，请检查网络后重试`);
      }
      return 'dead-letter';
    }

    // 更新重试次数
    this.ctx.pendingActions.update(queue =>
      queue.map(a => a.id === action.id
        ? { ...a, retryCount: a.retryCount + 1, lastError: errorMessage, errorType }
        : a
      )
    );
    this.saveQueueToStorage();

    // 动态重试延迟策略
    let delay: number;
    if (errorType === 'network') {
      delay = Math.min(QUEUE_CONFIG.RETRY_BASE_DELAY * (action.retryCount + 1), 5000);
    } else if (errorType === 'timeout') {
      delay = QUEUE_CONFIG.RETRY_BASE_DELAY * Math.pow(1.5, action.retryCount);
    } else {
      delay = QUEUE_CONFIG.RETRY_BASE_DELAY * Math.pow(2, action.retryCount);
    }

    this.logger.debug(`调度重试`, {
      actionId: action.id, errorType,
      retryCount: action.retryCount + 1, delay: `${delay}ms`
    });

    this.scheduleRetry(delay);
    return 'retry';
  }

  // ========== 错误分类（纯函数） ==========

  classifyError(error: string | QueueRetryError): 'network' | 'timeout' | 'permission' | 'business' | 'deferred' | 'unknown' {
    const normalizedError = this.normalizeRetryError(error);

    if (this.isBrowserSuspensionError(normalizedError)) {
      return 'deferred';
    }

    const msg = normalizedError.message.toLowerCase();

    if (msg.includes('network') || msg.includes('failed to fetch') ||
        msg.includes('networkerror') || msg.includes('connection') || msg.includes('offline') ||
        msg.includes('browsernetworksuspendederror') || msg.includes('network io suspended') ||
        msg.includes('离线') || msg.includes('网络')) {
      return 'network';
    }
    if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('deadline exceeded') ||
        msg.includes('超时')) {
      return 'timeout';
    }
    if (msg.includes('permission') || msg.includes('unauthorized') || msg.includes('forbidden') ||
        msg.includes('401') || msg.includes('403') || msg.includes('jwt') ||
        msg.includes('token') || msg.includes('policy') || msg.includes('42501') ||
        msg.includes('autherror') || msg.includes('expired') || msg.includes('权限不足') ||
        msg.includes('登录已过期') || msg.includes('未授权') || msg.includes('重新登录')) {
      return 'permission';
    }
    for (const pattern of LOCAL_QUEUE_CONFIG.BUSINESS_ERROR_PATTERNS) {
      if (msg.includes(pattern.toLowerCase())) return 'business';
    }
    return 'unknown';
  }

  private normalizeRetryError(error: string | QueueRetryError): QueueRetryError {
    if (typeof error === 'string') {
      return this.parseRetryErrorMessage(error);
    }

    const message = typeof error.message === 'string' ? error.message : String(error.message ?? '');
    const parsed = this.parseRetryErrorMessage(message);
    return {
      code: typeof error.code === 'string' ? error.code : parsed.code,
      message: parsed.message,
      details: error.details && typeof error.details === 'object'
        ? error.details
        : undefined,
    };
  }

  private parseRetryErrorMessage(message: string): QueueRetryError {
    const parts = message.split('|').map(part => part.trim()).filter(part => part.length > 0);
    const firstPart = parts[0] ?? '';
    const looksLikeErrorCode = /^[A-Z0-9_]+$/.test(firstPart);

    if (!looksLikeErrorCode) {
      return { message };
    }

    return {
      code: firstPart,
      message: parts.slice(1).join(' | ') || message,
    };
  }

  private formatRetryError(error: QueueRetryError): string {
    return [error.code, error.message].filter((part): part is string => typeof part === 'string' && part.length > 0).join(' | ');
  }

  private isBrowserSuspensionError(error: QueueRetryError): boolean {
    if (error.details?.['reason'] === 'browser-network-suspended') {
      return true;
    }

    const msg = `${error.code ?? ''} ${error.message}`.toLowerCase();
    return msg.includes('browser-network-suspended')
      || msg.includes('browsernetworksuspendederror')
      || msg.includes('network io suspended')
      || (error.code === 'SYNC_OFFLINE' && error.message.includes('浏览器恢复连接中'))
      || msg.includes('resuming connection');
  }

  private resolveBrowserSuspensionDelay(error?: QueueRetryError): number {
    const requestedDelay = error?.details?.['resumeDelayMs'];
    if (typeof requestedDelay === 'number' && Number.isFinite(requestedDelay)) {
      return Math.max(0, requestedDelay);
    }

    return Math.max(100, getRemainingBrowserNetworkResumeDelayMs() + 50);
  }

  getActionDescription(action: QueuedAction): string {
    const typeMap: Record<string, string> = { 'create': '创建', 'update': '更新', 'delete': '删除' };
    const entityMap: Record<string, string> = {
      'project': '项目',
      'task': '任务',
      'preference': '设置',
      'focus-session': '专注会话',
      'routine-task': '日常任务',
      'routine-completion': '日常计数',
    };
    return `${typeMap[action.type] || action.type}${entityMap[action.entityType] || action.entityType}`;
  }

  getActionLabel(action: QueuedAction): string {
    const typeLabels: Record<string, string> = { create: '创建', update: '更新', delete: '删除' };
    const entityLabels: Record<string, string> = {
      project: '项目',
      task: '任务',
      preference: '偏好设置',
      'focus-session': '专注会话',
      'routine-task': '日常任务',
      'routine-completion': '日常计数',
    };
    return `${typeLabels[action.type]}${entityLabels[action.entityType]}`;
  }

  // ========== 网络管理 ==========

  setupNetworkListeners(): void {
    if (typeof window === 'undefined') return;

    this.onlineHandler = () => {
      this._isOnline = true;
      this.requestQueueProcessing('online');
    };
    this.offlineHandler = () => {
      this._isOnline = false;
    };
    this.visibilityChangeHandler = () => {
      if (typeof document === 'undefined' || document.visibilityState !== 'visible') {
        return;
      }
      this.requestQueueProcessing('visibilitychange');
    };
    this.pageShowHandler = (_event: PageTransitionEvent) => {
      this.requestQueueProcessing('pageshow');
    };

    window.addEventListener('online', this.onlineHandler);
    window.addEventListener('offline', this.offlineHandler);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.visibilityChangeHandler);
    }
    window.addEventListener('pageshow', this.pageShowHandler as EventListener);
    this._isOnline = navigator.onLine;
  }

  removeNetworkListeners(): void {
    if (typeof window === 'undefined') return;
    if (this.onlineHandler) { window.removeEventListener('online', this.onlineHandler); this.onlineHandler = null; }
    if (this.offlineHandler) { window.removeEventListener('offline', this.offlineHandler); this.offlineHandler = null; }
    if (typeof document !== 'undefined' && this.visibilityChangeHandler) {
      document.removeEventListener('visibilitychange', this.visibilityChangeHandler);
      this.visibilityChangeHandler = null;
    }
    if (this.pageShowHandler) {
      window.removeEventListener('pageshow', this.pageShowHandler as EventListener);
      this.pageShowHandler = null;
    }
  }

  // ========== 重试调度 ==========

  shouldDeferQueueProcessing(): boolean {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
      return true;
    }

    return isBrowserNetworkSuspendedWindow();
  }

  requestQueueProcessing(reason: string): void {
    if (!this._isOnline) {
      return;
    }

    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
      this.logger.debug('页面仍处于后台，延后队列处理直到重新可见', { reason });
      return;
    }

    if (isBrowserNetworkSuspendedWindow()) {
      this.scheduleDeferredQueueProcessing(reason);
      return;
    }

    this.clearRetryTimer();
    void this.ctx.processQueue();
  }

  scheduleDeferredQueueProcessing(reason: string, explicitDelay?: number): void {
    if (!this._isOnline) {
      return;
    }

    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
      this.logger.debug('页面仍处于后台，跳过 defer 队列定时器，等待可见恢复事件', { reason });
      return;
    }

    const delay = Math.max(0, explicitDelay ?? this.resolveBrowserSuspensionDelay());
    this.logger.debug('浏览器恢复窗口未结束，延后队列处理', { reason, delay });
    this.scheduleRetry(delay);
  }

  scheduleRetry(delay: number): void {
    const normalizedDelay = Math.max(0, delay);
    const nextDueAt = Date.now() + normalizedDelay;

    if (this.retryTimer && this.retryTimerDueAt !== null && this.retryTimerDueAt <= nextDueAt) {
      return;
    }

    this.clearRetryTimer();
    this.retryTimerDueAt = nextDueAt;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.retryTimerDueAt = null;
      this.requestQueueProcessing('retry-timer');
    }, normalizedDelay);
  }

  clearRetryTimer(): void {
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.retryTimerDueAt = null;
  }

  // ========== 存储操作 ==========

  /**
   * 保存队列到 localStorage
   * 处理 QuotaExceededError：尝试 IndexedDB 备份 → 逃生模式
   */
  saveQueueToStorage(): void {
    if (typeof localStorage === 'undefined') return;

    try {
      const queueStorageKey = this.getScopedStorageKey(LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY);
      localStorage.setItem(
        queueStorageKey,
        JSON.stringify(this.ctx.pendingActions())
      );
      this.clearLegacyGlobalStorageIfLocalOwner(LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY);
      this.clearQueueFreeze();
    } catch (e: unknown) {
      const isQuotaError =
        (e instanceof DOMException && (e.name === 'QuotaExceededError' || e.code === 22)) ||
        (e instanceof Error && e.name === 'QuotaExceededError');

      if (isQuotaError) {
        const currentQueue = this.ctx.pendingActions();
        this.logger.warn('LocalStorage 配额不足，启用队列冻结保护');
        // 同步冻结写入，防止后续操作在备份完成前继续写入
        this.freezeQueueWrites('quota_exceeded');
        void this.queueBackup.backupQueue(currentQueue, this.getCurrentOwnerUserId()).then(success => {
          if (success) {
            this.invalidateLocalQueueSnapshot();
            this.toast.warning('存储空间不足', '同步队列已冻结。请释放浏览器存储后继续写入。', {
              duration: 10000
            });
          } else {
            this.freezeQueueWrites('backup_failed');
            this.triggerStorageFailureEscapeMode();
          }
        });
      } else {
        this.logger.warn('Failed to save action queue to storage', e);
      }
    }
  }

  /**
   * 从 localStorage 加载队列（含 IndexedDB 回退）
   */
  loadQueueFromStorage(): void {
    if (typeof localStorage === 'undefined') return;

    try {
      const restoreGeneration = ++this.queueRestoreGeneration;
      const restoreOwnerUserId = this.getCurrentOwnerUserId();
      const saved = this.loadScopedOrLegacyStorage(LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY);
      if (saved) {
        const queue = JSON.parse(saved) as QueuedAction[];
        if (Array.isArray(queue)) {
          this.ctx.pendingActions.set(queue);
          this.ctx.queueSize.set(queue.length);
          this.ctx.syncSentryContext();
          return;
        }
      }

      // localStorage 为空，尝试从 IndexedDB 恢复
      void this.queueBackup.restoreQueue(this.getCurrentOwnerUserId(), (legacyItems) => {
        this.quarantineLegacyQueueForReview(
          legacyItems.map((item) => item.action),
          'legacy-idb-backup'
        );
      }).then(backupQueue => {
        if (restoreGeneration !== this.queueRestoreGeneration || restoreOwnerUserId !== this.getCurrentOwnerUserId()) {
          this.logger.debug('忽略过期的队列备份恢复结果', { restoreOwnerUserId });
          return;
        }

        if (backupQueue && backupQueue.length > 0) {
          this.ctx.pendingActions.set(backupQueue);
          this.ctx.queueSize.set(backupQueue.length);
          this.ctx.syncSentryContext();
          this.toast.info('队列恢复', `从备用存储恢复了 ${backupQueue.length} 个待处理操作`);
          this.clearQueueFreeze();
          this.saveQueueToStorage();
        }
      });
    } catch (e) {
      this.logger.warn('Failed to load action queue from storage', { error: e });
    }
  }

  /** 保存死信队列到 localStorage */
  saveDeadLetterToStorage(): void {
    if (typeof localStorage === 'undefined') return;

    try {
      const deadLetterStorageKey = this.getScopedStorageKey(LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY);
      localStorage.setItem(
        deadLetterStorageKey,
        JSON.stringify(this.deadLetterQueue())
      );
      this.clearLegacyGlobalStorageIfLocalOwner(LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY);
    } catch (e) {
      this.logger.warn('Failed to save dead letter queue to storage', { error: e });
    }
  }

  /**
   * 从 localStorage 加载死信队列（含 TTL 清理）
   */
  loadDeadLetterFromStorage(): void {
    if (typeof localStorage === 'undefined') return;

    try {
      const saved = this.loadScopedOrLegacyStorage(LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY);
      if (saved) {
        const queue = JSON.parse(saved) as DeadLetterItem[];
        if (Array.isArray(queue)) {
          const now = Date.now();
          const validQueue = queue.filter(item => {
            const failedTime = new Date(item.failedAt).getTime();
            return (now - failedTime) < LOCAL_QUEUE_CONFIG.DEAD_LETTER_TTL;
          });

          this.deadLetterQueue.set(validQueue);
          this.deadLetterSize.set(validQueue.length);
          this.ctx.syncSentryContext();

          if (validQueue.length < queue.length) {
            this.saveDeadLetterToStorage();
            this.logger.info(`清理了 ${queue.length - validQueue.length} 个过期的死信队列条目`);
          }
        }
      }
    } catch (e) {
      this.logger.warn('Failed to load dead letter queue from storage', { error: e });
    }
  }

  // ========== 存储失败逃生模式 ==========

  private triggerStorageFailureEscapeMode(): void {
    this.logger.error('【存储灾难】localStorage 和 IndexedDB 均不可用，进入逃生模式');
    this.storageFailure.set(true);
    this.freezeQueueWrites('storage_failure');
    this.toast.error(
      '🚨 存储失败 - 数据可能丢失',
      '浏览器存储不可用。请立即复制下方数据进行备份！',
      { duration: 0 }
    );

    if (this.storageFailureCallback) {
      try {
        this.storageFailureCallback({
          queue: this.ctx.pendingActions(),
          deadLetter: this.deadLetterQueue()
        });
      } catch (e) {
        this.logger.error('存储失败回调执行异常', e);
      }
    }
  }

  // ========== 状态重置 ==========

  /**
   * 冻结期定时重试落盘
   * 冻结后每 30s 重试一次 localStorage 写入，成功则自动解冻
   * 失败则指数退避（30s → 60s → 120s → max 5min），最多重试 10 次
   */
  startFrozenRetryTimer(): void {
    if (this.frozenRetryTimer) return;
    this.frozenRetryCount = 0;
    this.scheduleFrozenRetry();
  }

  private scheduleFrozenRetry(): void {
    if (this.frozenRetryCount >= this.FROZEN_RETRY_MAX) {
      this.logger.warn('冻结期重试已达上限，停止自动重试', { count: this.frozenRetryCount });
      return;
    }

    const delay = Math.min(
      this.FROZEN_RETRY_BASE_DELAY * Math.pow(2, this.frozenRetryCount),
      this.FROZEN_RETRY_MAX_DELAY
    );

    this.frozenRetryTimer = setTimeout(() => {
      this.frozenRetryTimer = null;
      if (!this.queueFrozen()) return; // 已解冻，无需重试

      this.frozenRetryCount++;
      this.logger.info('冻结期定时重试落盘', { attempt: this.frozenRetryCount });

      try {
        // 尝试写入 localStorage
        const testKey = 'nanoflow.freeze-probe';
        localStorage.setItem(testKey, '1');
        localStorage.removeItem(testKey);
        
        // 写入成功，尝试保存队列
        this.saveQueueToStorage();
        
        if (!this.queueFrozen()) {
          this.logger.info('存储恢复，队列自动解冻');
          this.toast.success('存储恢复', '同步队列已自动解冻');
        } else {
          // 保存失败重新触发了冻结，继续重试
          this.scheduleFrozenRetry();
        }
      } catch (_e) {
        this.logger.debug('冻结期重试写入仍然失败', { attempt: this.frozenRetryCount });
        this.scheduleFrozenRetry();
      }
    }, delay);
  }

  private stopFrozenRetryTimer(): void {
    if (this.frozenRetryTimer) {
      clearTimeout(this.frozenRetryTimer);
      this.frozenRetryTimer = null;
    }
    this.frozenRetryCount = 0;
  }

  /**
   * 导出待同步操作为 JSON（逃生导出）
   * 用于队列冻结时用户手动下载备份
   */
  exportPendingActionsAsJson(): string {
    const data = {
      exportedAt: new Date().toISOString(),
      pendingActions: this.ctx.pendingActions(),
      deadLetterQueue: this.deadLetterQueue(),
      frozenState: this.queueFrozen(),
      freezeReason: this.queueFreezeReason(),
      metadata: { version: 1, source: 'action-queue-escape' }
    };
    return JSON.stringify(data, null, 2);
  }

  /**
   * 触发逃生导出下载
   */
  downloadEscapeExport(): void {
    try {
      const json = this.exportPendingActionsAsJson();
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `nanoflow-pending-sync-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      this.toast.success('导出成功', '待同步数据已下载');
    } catch (e) {
      this.logger.error('逃生导出失败', e);
      this.toast.error('导出失败', '无法创建备份文件');
    }
  }

  reset(): void {
    this.removeNetworkListeners();
    this.clearRetryTimer();
    this.stopFrozenRetryTimer();
    this.deadLetterQueue.set([]);
    this.deadLetterSize.set(0);
    this.storageFailure.set(false);
    this.queueFrozen.set(false);
    this.queueFreezeReason.set(null);
    this.networkAwareness.setStoragePressure(false, null);
    this.failureCallbacks.length = 0;
    this.storageFailureCallback = null;
    this._isOnline = true;

    // 清除 localStorage 中的持久化数据
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.removeItem(LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY);
        localStorage.removeItem(LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY);
      } catch (e) {
        this.logger.warn('清除 localStorage 队列数据失败', { error: e });
      }
    }
  }

  private freezeQueueWrites(reason: string): void {
    this.queueFrozen.set(true);
    this.queueFreezeReason.set(reason);
    this.networkAwareness.setStoragePressure(true, reason);
    this.sentryLazyLoader.captureMessage('Action queue frozen', {
      level: 'warning',
      tags: { reason }
    });
    // 启动冻结期定时重试
    this.startFrozenRetryTimer();
  }

  private clearQueueFreeze(): void {
    if (!this.queueFrozen()) {
      return;
    }
    this.queueFrozen.set(false);
    this.queueFreezeReason.set(null);
    this.networkAwareness.setStoragePressure(false, null);
    // 停止冻结期重试
    this.stopFrozenRetryTimer();
  }
}
