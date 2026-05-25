/**
 * DockCloudSyncService
 * Cloud push/pull synchronization, focus session record management,
 * routine task & completion sync enqueuing.
 * Extracted from DockEngineService to decouple network/cloud operations
 * from business state logic.
 */
import { Injectable, OnDestroy, inject } from '@angular/core';
import { PARKING_CONFIG } from '../config/parking.config';
import { SYNC_CONFIG } from '../config/sync.config';
import { TIMEOUT_CONFIG } from '../config/timeout.config';
import {
  DailySlotEntry,
  DockSnapshot,
  FocusSessionRecord,
  RoutineCompletionMutation,
  RoutineTask,
} from '../models/parking-dock';
import { SimpleSyncService } from '../core-bridge';
import { ActionQueueService } from './action-queue.service';
import {
  DockSnapshotPersistenceService,
  type SnapshotNormalizeContext,
} from './dock-snapshot-persistence.service';
import { LoggerService } from './logger.service';
import { SupabaseClientService } from './supabase-client.service';
import { withTimeout } from '../utils/timeout';
import { TimerHandle } from '../utils/timer-handle';
import { supabaseErrorToError } from '../utils/supabase-error';
import { AUTH_CONFIG } from '../config/auth.config';
import {
  getRemainingBrowserNetworkResumeDelayMs,
  isBrowserNetworkSuspendedError,
  isBrowserNetworkSuspendedWindow,
} from '../utils/browser-network-suspension';

const CLOUD_PUSH_DEBOUNCE_MS = SYNC_CONFIG.DEBOUNCE_DELAY;
const CLOUD_PULL_DEBOUNCE_MS = PARKING_CONFIG.CLOUD_PULL_DEBOUNCE_MS;
const CLOUD_PULL_MIN_INTERVAL_MS = PARKING_CONFIG.CLOUD_PULL_MIN_INTERVAL_MS;
const LOAD_FOCUS_SESSION_TIMEOUT_MESSAGE = 'loadFocusSession 超时';
const DIRECT_WIDGET_NOTIFY_TIMEOUT_MS = TIMEOUT_CONFIG.QUICK;

/**
 * Callbacks provided by DockEngineService for engine state mutations
 * that must happen during cloud sync operations.
 */
export interface CloudSyncEngineCallbacks {
  exportSnapshot: () => DockSnapshot;
  restoreSnapshot: (snapshot: DockSnapshot) => void;
  scheduleLocalPersist: (snapshot: DockSnapshot, userId: string) => void;
  updateDailySlots: (updater: (prev: DailySlotEntry[]) => DailySlotEntry[]) => void;
  getNonCriticalHoldDelay: () => number;
  getFocusSessionContext: () => { id: string; startedAt: number } | null;
  setFocusSessionContext: (ctx: { id: string; startedAt: number }) => void;
  buildNormalizeContext: () => SnapshotNormalizeContext;
  /** H-3: 获取当前快照用户 ID，用于异步操作后的过期检查 */
  getCurrentSnapshotUserId: () => string | null;
}

@Injectable({
  providedIn: 'root',
})
export class DockCloudSyncService implements OnDestroy {
  private readonly syncService = inject(SimpleSyncService);
  private readonly actionQueue = inject(ActionQueueService);
  private readonly snapshotPersistence = inject(DockSnapshotPersistenceService);
  private readonly supabase = inject(SupabaseClientService);
  private readonly logger = inject(LoggerService).category('DockCloudSync');

  private readonly cloudPushTimer = new TimerHandle();
  private readonly cloudPullTimer = new TimerHandle();
  private cloudPullRetryCount = 0;
  private lastCloudPullAt = 0;
  /** 断路器：连续不可恢复错误（如 401/403）时停止重试 */
  private circuitBreakerOpen = false;
  private circuitBreakerResetTimer = new TimerHandle();
  /** 免费层优化：按 owner 记录上次入队的快照指纹，避免跨账号相互去重 */
  private readonly lastEnqueuedSnapshotFingerprints = new Map<string, string>();
  /**
   * 按 owner 记录上次已调度推送时的 focusMode 布尔值。
   * 用于检测「专注模式切换」这类语义关键的状态转换——
   * 该类转换不走 3s 防抖，直接 0 延迟 flush，确保小组件 / 多设备能瞬时响应。
   */
  private readonly lastScheduledFocusMode = new Map<string, boolean>();

  private callbacks: CloudSyncEngineCallbacks | null = null;

  private isBrowserSuspendedResult(error: { details?: Record<string, unknown> } | null | undefined): boolean {
    return error?.details?.['reason'] === 'browser-network-suspended';
  }

  private getDirectFocusSessionId(snapshot: DockSnapshot): string | null {
    const candidates = [
      snapshot.session?.focusSessionId,
      snapshot.focusSessionState?.sessionId,
    ];

    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim().length > 0) {
        return candidate.trim();
      }
    }

    return null;
  }

  private shouldSkipDirectWidgetNotify(context: Record<string, unknown>): boolean {
    if (!isBrowserNetworkSuspendedWindow()) {
      return false;
    }

    this.logger.debug('direct widget-notify skipped during browser network suspension', {
      ...context,
      resumeDelayMs: getRemainingBrowserNetworkResumeDelayMs(),
    });
    return true;
  }

  /**
   * 由 DockEngineService 在其构造函数中调用，注入引擎回调。
   * 此服务使用手动上下文注入而非 Angular DI，因为所需回调引用的是 DockEngineService 的私有成员
   * （如 exportSnapshot、restoreSnapshot 等），无法通过常规注入获取。
   *
   * 注意：与 DockCompletionFlowService 等服务不同，本服务对未初始化状态采用「静默跳过」策略
   * （而非 throw），因为云同步调用可能在 init 前就被触发（如快照恢复期间的防抖定时器）。
   */
  init(callbacks: CloudSyncEngineCallbacks): void {
    if (this.callbacks) {
      this.logger.warn('init() called again — overwriting previous callbacks');
    }
    this.callbacks = callbacks;
  }

  seedFocusModeBaseline(userId: string | null, snapshot: DockSnapshot | null): void {
    if (!userId || userId === AUTH_CONFIG.LOCAL_MODE_USER_ID || !snapshot) {
      return;
    }

    this.lastScheduledFocusMode.set(userId, snapshot.focusMode === true);
  }

  /** H-3: 异步操作后检查用户是否仍为当前用户，防止跨用户数据污染 */
  private isCurrentUser(userId: string): boolean {
    return this.callbacks?.getCurrentSnapshotUserId() === userId;
  }

  // ─── Cloud Push ───────────────────────────────

  scheduleCloudPush(userId: string, snapshot: DockSnapshot | null): void {
    if (userId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      return;
    }

    const cb = this.callbacks;
    if (!cb) {
      // H-4 fix: 未初始化时记录警告而非静默吞掉，防止 init 顺序变更后
      // 云同步静默失效而无任何可观测信号。
      this.logger.warn('scheduleCloudPush called before init() — skipping', { userId });
      return;
    }
    const frozenSnapshot = snapshot ?? cb.exportSnapshot();

    const runPush = () => {
      const holdDelay = cb.getNonCriticalHoldDelay();
      if (holdDelay > 0) {
        this.cloudPushTimer.schedule(runPush, holdDelay);
        return;
      }
      // 保证本地持久化先于云端推送，维护 offline-first 不变式
      cb.scheduleLocalPersist(frozenSnapshot, userId);
      this.enqueueFocusSessionSync(userId, frozenSnapshot);
    };

    // 专注模式切换 fast-path：focusMode 翻转是语义关键状态转换
    // （widget/多设备需要瞬时感知），跳过 3s 防抖直接 0ms 调度。
    // 其它类型改动（entry 增删、标题编辑等）仍走防抖，避免高频写入冲击 FCM 配额。
    const nextFocusMode = frozenSnapshot.focusMode === true;
    const prevFocusMode = this.lastScheduledFocusMode.get(userId);
    const isFocusModeTransition = prevFocusMode !== undefined && prevFocusMode !== nextFocusMode;
    const shouldFastTrackWidgetSync = isFocusModeTransition;
    this.lastScheduledFocusMode.set(userId, nextFocusMode);

    const delayMs = shouldFastTrackWidgetSync ? 0 : CLOUD_PUSH_DEBOUNCE_MS;
    this.cloudPushTimer.schedule(runPush, delayMs);

    // 2026-04-22 颠覆性压缩 (plan D)：focusMode 翻转瞬间并行直调 widget-notify 绕过
    // 「ActionQueue → DB upsert → pg_net 轮询 → widget-notify」的 3-8s 链路。
    // 直调路径用用户 JWT 认证，edge function 在同一张 widget_notify_events 表上做幂等，
    // 若 pg_net 后续仍送达则会被去重 kind='duplicate' 静默丢弃，不会导致双推。
    if (shouldFastTrackWidgetSync) {
      void this.sendDirectFocusNotify(userId, frozenSnapshot, nextFocusMode);
    }
  }

  /**
   * 直接调用 widget-notify Edge Function，不等 DB trigger + pg_net。
   * 失败无副作用——DB 仍会通过 ActionQueue 正常写入并触发 fallback 通知路径。
   */
  private async sendDirectFocusNotify(
    userId: string,
    snapshot: DockSnapshot,
    focusActive: boolean,
  ): Promise<void> {
    if (this.shouldSkipDirectWidgetNotify({ userId, focusActive, source: 'focus' })) {
      return;
    }

    const focusSessionId = this.getDirectFocusSessionId(snapshot);
    if (!focusSessionId) {
      this.logger.debug('direct widget-notify skipped without focus session id', { userId, focusActive });
      return;
    }

    try {
      const client = await this.supabase.clientAsync();
      if (!client) {
        return;
      }
      // 幂等键 = focus session id + 状态 hash，让同一次翻转在 trigger fallback 到达时命中去重。
      const webhookId = `pwa-direct-${focusSessionId}-${focusActive ? 'on' : 'off'}-${Math.floor(Date.now() / 1000)}`;
      const updatedAt = snapshot.savedAt ?? new Date().toISOString();

      const { error } = await client.functions.invoke('widget-notify', {
        timeout: DIRECT_WIDGET_NOTIFY_TIMEOUT_MS,
        body: {
          directNotify: true,
          webhookId,
          focusActive,
          focusSessionId,
          updatedAt,
        },
      });
      if (error) {
        // 401/409 在直调路径是可接受的（jwt 过期或重复事件），不升级为错误——
        // DB trigger fallback 仍会在几秒内把事件送达 widget。
        this.logger.debug('direct widget-notify skipped', {
          userId,
          focusActive,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } catch (error) {
      this.logger.debug('direct widget-notify threw', {
        userId,
        focusActive,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ─── Cloud Pull ───────────────────────────────

  scheduleCloudPull(userId: string, force: boolean): void {
    if (userId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      return;
    }

    if (!force && Date.now() - this.lastCloudPullAt < CLOUD_PULL_MIN_INTERVAL_MS) return;
    // H-4 fix: 强制拉取时重置重试计数（用户切换场景）
    if (force) this.cloudPullRetryCount = 0;
    this.cloudPullTimer.schedule(() => {
      void this.pullCloudSnapshot(userId);
    }, CLOUD_PULL_DEBOUNCE_MS);
  }

  private deferCloudPullForBrowserResume(userId: string, reason: 'preflight' | 'error'): void {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
      this.logger.debug('pullCloudSnapshot: 页面不可见，跳过当前云拉取', { userId, reason });
      return;
    }

    const delayMs = Math.max(getRemainingBrowserNetworkResumeDelayMs(), CLOUD_PULL_DEBOUNCE_MS);
    this.logger.debug('pullCloudSnapshot: 浏览器网络挂起窗口内延后云拉取', {
      userId,
      reason,
      delayMs,
    });
    this.cloudPullTimer.schedule(() => {
      this.lastCloudPullAt = 0;
      void this.pullCloudSnapshot(userId);
    }, delayMs);
  }

  private async pullCloudSnapshot(userId: string): Promise<void> {
    const cb = this.callbacks;
    if (!cb) {
      this.logger.warn('pullCloudSnapshot called before init() — skipping', { userId });
      return;
    }

    // 断路器开启时跳过拉取
    if (this.circuitBreakerOpen) {
      this.logger.warn('pullCloudSnapshot: circuit breaker open — skipping');
      return;
    }

    if (isBrowserNetworkSuspendedWindow()) {
      this.deferCloudPullForBrowserResume(userId, 'preflight');
      return;
    }

    this.lastCloudPullAt = Date.now();
    const ctx = cb.buildNormalizeContext();
    try {
      // H-1 fix: 传递本地快照的 savedAt 用于服务端 LWW 短路优化
      const local = cb.exportSnapshot();
      const localSavedAt = typeof local?.savedAt === 'string' && local.savedAt
        ? local.savedAt
        : undefined;

      const loadResult = await withTimeout(
        this.syncService.loadFocusSession(userId, localSavedAt),
        { timeout: TIMEOUT_CONFIG.STANDARD, timeoutMessage: LOAD_FOCUS_SESSION_TIMEOUT_MESSAGE },
      );

      // H-2 fix: 显式检查 Result.ok，区分错误和"无数据"
      if (!loadResult.ok) {
        if (this.isBrowserSuspendedResult(loadResult.error)) {
          this.deferCloudPullForBrowserResume(userId, 'error');
          return;
        }

        this.logger.warn('loadFocusSession returned error, skipping legacy fallback', loadResult.error);
        await this.hydrateRoutineSlots(userId);
        return;
      }
      const remoteRaw = loadResult.value;

      // H-3 fix: 异步点后检查用户是否已切换
      if (!this.isCurrentUser(userId)) return;

      if (!remoteRaw) {
        await this.hydrateRoutineSlots(userId);
        return;
      }

      const remote = this.snapshotPersistence.normalizeSnapshot(remoteRaw, ctx);
      if (!remote) {
        await this.hydrateRoutineSlots(userId);
        return;
      }
      // H-3 补充: isSnapshotNewer 也需验证用户一致性，防止跨用户数据覆盖
      if (!this.isCurrentUser(userId)) return;
      if (!this.snapshotPersistence.isSnapshotNewer(remote, local)) {
        await this.hydrateRoutineSlots(userId);
        return;
      }

      // H-3 fix: 恢复前最终检查用户是否仍然一致
      if (!this.isCurrentUser(userId)) return;
      cb.restoreSnapshot(remote);
      // C-4 fix: 恢复远端快照后取消待执行的云推送，防止旧数据覆盖刚拉取的新快照
      this.cloudPushTimer.cancel();
      cb.scheduleLocalPersist(remote, userId);
      await this.hydrateRoutineSlots(userId);
      this.cloudPullRetryCount = 0; // reset on success
      this.resetCircuitBreaker();
    } catch (rawError) {
      if (isBrowserNetworkSuspendedError(rawError)) {
        this.deferCloudPullForBrowserResume(userId, 'error');
        return;
      }

      const error = supabaseErrorToError(rawError);
      if (this.isLoadFocusSessionTimeout(rawError)) {
        this.logger.debug('pullCloudSnapshot: loadFocusSession timed out, keeping local focus snapshot', error);
      } else {
        this.logger.warn('Failed to pull focus session from cloud', error);
      }

      // 对不可恢复错误（认证/权限）开启断路器，避免无限重试风暴
      const statusCode = (rawError as { status?: number })?.status;
      if (statusCode === 401 || statusCode === 403) {
        this.openCircuitBreaker();
        return;
      }

      this.cloudPullRetryCount += 1;
      if (this.cloudPullRetryCount > PARKING_CONFIG.CLOUD_PULL_MAX_RETRIES) {
        this.logger.warn(`pullCloudSnapshot: max retries (${PARKING_CONFIG.CLOUD_PULL_MAX_RETRIES}) reached, giving up`);
        this.cloudPullRetryCount = 0;
        return;
      }
      // 拉取失败后延迟重试（指数退避 + 随机抖动），避免多客户端同时重试造成雷群效应
      const baseMs = SYNC_CONFIG.DEBOUNCE_DELAY * 2 * Math.pow(2, this.cloudPullRetryCount - 1);
      const jitterMs = Math.floor(Math.random() * SYNC_CONFIG.DEBOUNCE_DELAY);
      const backoffMs = baseMs + jitterMs;
      this.cloudPullTimer.schedule(() => {
        this.lastCloudPullAt = 0; // 允许下次立即拉取
        this.scheduleCloudPull(userId, false);
      }, backoffMs);
    }
  }

  private isLoadFocusSessionTimeout(error: unknown): boolean {
    const message = String((error as { message?: string })?.message ?? error ?? '');
    return message.includes(LOAD_FOCUS_SESSION_TIMEOUT_MESSAGE);
  }

  // ─── Routine Slot Hydration ───────────────────

  private async hydrateRoutineSlots(userId: string): Promise<void> {
    const cb = this.callbacks;
    if (!cb) return;

    try {
      const listResult = await withTimeout(
        this.syncService.listRoutineTasks(userId),
        { timeout: TIMEOUT_CONFIG.QUICK, timeoutMessage: 'listRoutineTasks 超时' },
      );
      // DATA-C5 fix: async 边界后检查用户是否仍为当前用户，防止跨用户数据污染
      if (!this.isCurrentUser(userId)) return;
      if (!listResult.ok) {
        if (this.isBrowserSuspendedResult(listResult.error)) {
          this.deferCloudPullForBrowserResume(userId, 'error');
          return;
        }

        this.logger.warn('hydrateRoutineSlots: listRoutineTasks returned error', listResult.error);
        return;
      }

      const routineTasks = listResult.ok ? listResult.value : [];
      if (routineTasks.length === 0) return;
      cb.updateDailySlots(prev => {
        const byId = new Map(prev.map(slot => [slot.id, slot]));
        const next = [...prev];
        for (const routine of routineTasks) {
          const existing = byId.get(routine.routineId);
          if (existing) {
            const merged: DailySlotEntry = {
              ...existing,
              title: routine.title,
              maxDailyCount: routine.maxTimesPerDay,
              isEnabled: routine.isEnabled,
            };
            const idx = next.findIndex(slot => slot.id === existing.id);
            if (idx >= 0) next[idx] = merged;
            continue;
          }
          next.push({
            id: routine.routineId,
            title: routine.title,
            maxDailyCount: routine.maxTimesPerDay,
            todayCompletedCount: 0,
            isEnabled: routine.isEnabled,
            createdAt: new Date().toISOString(),
          });
        }
        return next;
      });
    } catch (rawError) {
      if (isBrowserNetworkSuspendedError(rawError)) {
        this.logger.debug('hydrateRoutineSlots: 浏览器网络挂起窗口内跳过远端读取', { userId });
        return;
      }

      const error = supabaseErrorToError(rawError);
      this.logger.warn('hydrateRoutineSlots failed', error);
    }
  }

  // ─── Focus Session Records ────────────────────

  buildFocusSessionRecord(
    userId: string,
    snapshot: DockSnapshot,
  ): FocusSessionRecord {
    const cb = this.callbacks;
    if (!cb) {
      this.logger.error('buildFocusSessionRecord called before init() — returning fallback record');
      const now = new Date().toISOString();
      return {
        id: crypto.randomUUID(),
        userId,
        startedAt: now,
        endedAt: null,
        snapshot,
        updatedAt: now,
      };
    }

    const currentContext = cb.getFocusSessionContext();
    const resolvedSessionId =
      snapshot.session.focusSessionId ??
      snapshot.focusSessionState?.sessionId ??
      currentContext?.id ??
      crypto.randomUUID();
    const resolvedSessionStartedAt =
      snapshot.session.focusSessionStartedAt ??
      snapshot.focusSessionState?.sessionStartedAt ??
      currentContext?.startedAt ??
      Date.now();

    cb.setFocusSessionContext({
      id: resolvedSessionId,
      startedAt: resolvedSessionStartedAt,
    });

    const updatedAt = snapshot.savedAt || new Date().toISOString();
    return {
      id: resolvedSessionId,
      userId,
      startedAt: new Date(resolvedSessionStartedAt).toISOString(),
      endedAt: snapshot.focusMode ? null : updatedAt,
      snapshot,
      updatedAt,
    };
  }

  // ─── Action Queue Enqueue Helpers ─────────────

  enqueueFocusSessionSync(userId: string, snapshot: DockSnapshot): void {
    // 免费层优化：生成快照指纹，跳过无变化的写入（日均节省 ~100 次 focus_sessions UPDATE）
    const fingerprint = this.computeSnapshotFingerprint(snapshot);
    if (fingerprint === this.lastEnqueuedSnapshotFingerprints.get(userId)) {
      return;
    }
    this.lastEnqueuedSnapshotFingerprints.set(userId, fingerprint);

    const record = this.buildFocusSessionRecord(userId, snapshot);
    void this.actionQueue.enqueueForOwner(userId, {
      type: 'update',
      entityType: 'focus-session',
      entityId: record.id,
      payload: { record, sourceUserId: userId },
      priority: 'critical',
    });
  }

  /** 计算快照业务指纹（忽略 savedAt 等时间戳，仅关注业务状态变化） */
  private computeSnapshotFingerprint(snapshot: DockSnapshot): string {
    return JSON.stringify({
      fm: snapshot.focusMode,
      mt: snapshot.session?.mainTaskId ?? null,
      cs: snapshot.session?.comboSelectIds ?? [],
      bs: snapshot.session?.backupIds ?? [],
      entries: snapshot.entries?.map(entry => ({
        id: entry.taskId,
        lane: entry.lane,
        status: entry.status,
        main: entry.isMain === true,
        order: entry.manualOrder ?? entry.dockedOrder,
      })) ?? [],
      ver: snapshot.version ?? 0,
      fs: snapshot.focusSessionState?.sessionId ?? null,
    });
  }

  enqueueRoutineTaskSync(userId: string, routineTask: RoutineTask): void {
    if (userId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      return;
    }

    void this.actionQueue.enqueueForOwner(userId, {
      type: 'update',
      entityType: 'routine-task',
      entityId: routineTask.routineId,
      payload: { userId, routineTask, sourceUserId: userId },
      priority: 'normal',
    });
  }

  enqueueRoutineCompletionSync(completion: RoutineCompletionMutation): void {
    if (completion.userId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      return;
    }

    void this.actionQueue.enqueueForOwner(completion.userId, {
      type: 'create',
      entityType: 'routine-completion',
      entityId: completion.completionId,
      payload: { completion, sourceUserId: completion.userId },
      priority: 'normal',
    });
  }

  // ─── Cleanup ──────────────────────────────────

  ngOnDestroy(): void {
    this.cancelTimers();
  }

  cancelTimers(): void {
    this.cloudPushTimer.cancel();
    this.cloudPullTimer.cancel();
    this.circuitBreakerResetTimer.cancel();
    this.circuitBreakerOpen = false;
    this.cloudPullRetryCount = 0;
    this.lastCloudPullAt = 0;
    this.lastScheduledFocusMode.clear();
  }

  /** 断路器：不可恢复错误时停止重试，30 秒后自动半开 */
  private openCircuitBreaker(): void {
    this.circuitBreakerOpen = true;
    this.cloudPullRetryCount = 0;
    this.logger.warn('Circuit breaker opened — halting cloud pull retries for 30s');
    this.circuitBreakerResetTimer.schedule(() => {
      this.circuitBreakerOpen = false;
      this.logger.info('Circuit breaker half-open — next pull attempt allowed');
    }, PARKING_CONFIG.CLOUD_CIRCUIT_BREAKER_RESET_MS);
  }

  private resetCircuitBreaker(): void {
    if (this.circuitBreakerOpen) {
      this.circuitBreakerOpen = false;
      this.circuitBreakerResetTimer.cancel();
    }
  }
}
