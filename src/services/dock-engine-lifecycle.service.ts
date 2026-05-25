/**
 * DockEngineLifecycleService
 * 从 DockEngineService 提取的生命周期管理逻辑（C-2 分解）。
 * 负责：Angular effects 注册、tick 定时器、页面可见性监听、
 * 开关维护调度（switch maintenance）、清理回调、本地持久化调度。
 *
 * 使用与其他 Dock 子服务一致的 init(ctx) 上下文注入模式。
 */
import { DestroyRef, Injectable, WritableSignal, effect, inject, untracked } from '@angular/core';
import { PARKING_CONFIG } from '../config/parking.config';
import { DOCK_NOTIFICATION } from '../config/dock-i18n.config';
import { IDLE_SCHEDULE_CONFIG } from '../config/timeout.config';
import {
  DockEntry,
  DockPendingDecision,
  DockSnapshot,
  isStatusMachineEntryExpired,
  StatusMachineEntry,
} from '../models/parking-dock';
import { AuthService } from './auth.service';
import { FocusPreferenceService } from './focus-preference.service';
import { GateService } from './gate.service';
import { LoggerService } from './logger.service';
import { FocusAttentionService } from './focus-attention.service';
import { FocusHudWindowService } from './focus-hud-window.service';
import {
  DockSnapshotPersistenceService,
  type SnapshotNormalizeContext,
} from './dock-snapshot-persistence.service';
import { DockCloudSyncService } from './dock-cloud-sync.service';
import { DockCompletionFlowService } from './dock-completion-flow.service';
import { DockDailySlotService } from './dock-daily-slot.service';
import { DockFragmentRestService } from './dock-fragment-rest.service';
import { DockZoneService } from './dock-zone.service';
import { IntervalHandle, TimerHandle } from '../utils/timer-handle';
import { DockAudioPlayer } from './dock-audio.utils';
import { isWaitExpired, isWaitingLike, patchAllEntries } from './dock-engine.utils';
import { TaskStore } from '../core-bridge';
import { AUTH_CONFIG } from '../config/auth.config';
import { isLocalModeEnabled } from './guards/auth.guard';

const EMPTY_LOCAL_SNAPSHOT_SAVED_AT = '1970-01-01T00:00:00.000Z';

// ---------------------------------------------------------------------------
//  Context interface — engine 在 constructor 中调用 init() 注入运行时引用
// ---------------------------------------------------------------------------

export interface DockEngineLifecycleContext {
  // Signals（来自 engine）
  entries: WritableSignal<DockEntry[]>;
  focusMode: WritableSignal<boolean>;
  muteWaitTone: WritableSignal<boolean>;
  pendingDecision: WritableSignal<DockPendingDecision | null>;
  highlightedIds: WritableSignal<Set<string>>;
  editLock: WritableSignal<boolean>;
  suspendRecommendationLocked: WritableSignal<boolean>;
  suspendChainRootTaskId: WritableSignal<string | null>;
  softLimitNoticeShown: WritableSignal<boolean>;
  restoringSnapshot: WritableSignal<boolean>;
  blankPeriodNotified: WritableSignal<boolean>;
  fragmentCountdownNotified: WritableSignal<boolean>;
  tick: WritableSignal<number>;

  // Computed 读取
  persistenceDeps: () => unknown[];
  dockedCount: () => number;
  statusMachineEntries: () => StatusMachineEntry[];
  pendingDecisionEntries: () => { taskId: string }[];
  focusingEntry: () => DockEntry | null;
  fragmentEntryCountdown: () => number | null;

  // Mutable state 引用
  waitEndNotifiedIds: Set<string>;
  getCurrentSnapshotUserId: () => string | null;
  setCurrentSnapshotUserId: (userId: string | null) => void;

  // Callback delegates（来自 engine 的方法引用）
  exportSnapshot: () => DockSnapshot;
  restoreSnapshot: (snapshot: DockSnapshot) => void;
  reset: () => void;
  reconcileExternallyCompletedTasks: (taskIds: string[]) => void;
  buildNormalizeContext: () => SnapshotNormalizeContext;
  getNonCriticalHoldDelay: () => number;
  scheduleLocalPersist: (snapshot: DockSnapshot | null, userId: string | null) => void;
  setSnapshotSavedAt: (savedAt: string) => void;
}

@Injectable({
  providedIn: 'root',
})
export class DockEngineLifecycleService {
  private readonly auth = inject(AuthService);
  private readonly focusPreferenceService = inject(FocusPreferenceService);
  private readonly gateService = inject(GateService);
  private readonly logger = inject(LoggerService).category('DockLifecycle');
  private readonly focusAttention = inject(FocusAttentionService);
  private readonly focusHudWindow = inject(FocusHudWindowService);
  private readonly snapshotPersistence = inject(DockSnapshotPersistenceService);
  private readonly cloudSync = inject(DockCloudSyncService);
  private readonly completionFlow = inject(DockCompletionFlowService);
  private readonly dailySlotService = inject(DockDailySlotService);
  private readonly fragmentRest = inject(DockFragmentRestService);
  private readonly zoneService = inject(DockZoneService);
  private readonly taskStore = inject(TaskStore);
  private readonly destroyRef = inject(DestroyRef);

  private _ctx: DockEngineLifecycleContext | null = null;

  /** ARCH-C3 fix: 安全 getter 模式，与其他子服务一致 */
  private get ctx(): DockEngineLifecycleContext {
    if (!this._ctx) {
      throw new Error(
        'DockEngineLifecycleService.init() must be called before use. ' +
        'Ensure DockEngineService is constructed before accessing this service.',
      );
    }
    return this._ctx;
  }

  // 生命周期内部状态
  private readonly tickInterval = new IntervalHandle();
  private readonly audioPlayer = new DockAudioPlayer();
  private switchMaintenanceIdleId: number | null = null;
  private readonly switchMaintenanceFallback = new TimerHandle();
  private switchMaintenanceToken = 0;
  private snapshotRestoreToken = 0;
  private nonCriticalWorkHoldUntil = 0;
  private visibilityListener: (() => void) | null = null;
  private lastPersistenceFingerprint: string | null = null;
  private preserveNextEmptyRestoreForUnconfirmedInMemoryState = false;

  // ---------------------------------------------------------------------------
  //  Init
  // ---------------------------------------------------------------------------

  init(ctx: DockEngineLifecycleContext): void {
    this._ctx = ctx;
  }

  // ---------------------------------------------------------------------------
  //  Tick Timer（10 秒一次，驱动等待过期、待决策超时等周期性检查）
  // ---------------------------------------------------------------------------

  startTickTimer(): void {
    this.tickInterval.start(() => {
      this.ctx.tick.update(value => value + 1);
      this.checkWaitExpiry();
      this.checkPendingDecisionExpiry();
      this.dailySlotService.resetDailySlotsIfNeeded();
      this.fragmentRest.checkBurnoutCooldown();
      if (this.ctx.focusMode()) {
        this.fragmentRest.updateFragmentDefenseLevel();
      }
      this.fragmentRest.tickRestReminderAccumulator(
        this.ctx.focusMode(),
        this.ctx.focusingEntry()?.load ?? null,
      );
    }, 10_000);
  }

  // ---------------------------------------------------------------------------
  //  Initial Snapshot Restore
  // ---------------------------------------------------------------------------

  restoreInitialSnapshot(): void {
    const ownerUserId = this.resolveConfirmedRestoreOwnerUserId();
    if (this.shouldDeferRestoreUntilAuthConfirmed(ownerUserId)) {
      this.clearSnapshotStateForUnconfirmedOwner();
      return;
    }
    if (ownerUserId === null) {
      this.clearSnapshotStateForUnconfirmedOwner();
      return;
    }
    this.ctx.setCurrentSnapshotUserId(ownerUserId);
    this.startSnapshotRestore(ownerUserId, { cloudPullMode: 'idle' });
  }

  // ---------------------------------------------------------------------------
  //  Effects Registration
  // ---------------------------------------------------------------------------

  registerEffects(): void {
    this.registerCoreEffects();
    this.registerReconciliationEffects();
    this.registerNotificationEffects();
  }

  /** 核心状态同步 effects：用户切换、持久化、软限制重置、每日重置 */
  private registerCoreEffects(): void {
    // DATA-C2 fix: cloud pull 必须在 local restore 完成后调度，避免竞态覆盖
    effect(() => {
      const userId = this.resolveConfirmedRestoreOwnerUserId();
      if (this.shouldDeferRestoreUntilAuthConfirmed(userId)) {
        this.clearSnapshotStateForUnconfirmedOwner();
        return;
      }
      if (userId === null) {
        this.clearSnapshotStateForUnconfirmedOwner();
        return;
      }
      if (userId === this.ctx.getCurrentSnapshotUserId()) return;
      this.ctx.setCurrentSnapshotUserId(userId);
      this.startSnapshotRestore(userId, { cloudPullMode: 'immediate' });
    });

    // 状态变更时触发本地持久化和云端推送（通过 persistenceDeps 聚合信号，避免冗余触发）
    effect(() => {
      const persistenceFingerprint = this.buildPersistenceFingerprint(this.ctx.persistenceDeps());
      const confirmedOwnerUserId = this.resolveConfirmedRestoreOwnerUserId();
      if (this.shouldDeferRestoreUntilAuthConfirmed(confirmedOwnerUserId)) {
        this.cancelSnapshotPersistenceWork();
        return;
      }

      if (confirmedOwnerUserId === null) {
        this.cancelSnapshotPersistenceWork();
        return;
      }

      if (this.ctx.restoringSnapshot()) {
        this.lastPersistenceFingerprint = persistenceFingerprint;
        return;
      }
      if (this.lastPersistenceFingerprint === persistenceFingerprint) return;
      this.lastPersistenceFingerprint = persistenceFingerprint;

      this.ctx.setSnapshotSavedAt(new Date().toISOString());
      const snapshot = this.ctx.exportSnapshot();
      this.ctx.scheduleLocalPersist(snapshot, confirmedOwnerUserId);
      this.cloudSync.scheduleCloudPush(confirmedOwnerUserId, snapshot);
    });

    // 软限制通知重置
    effect(() => {
      if (this.ctx.dockedCount() < PARKING_CONFIG.DOCK_CONSOLE_SOFT_LIMIT && this.ctx.softLimitNoticeShown()) {
        this.ctx.softLimitNoticeShown.set(false);
      }
    });

    // 每日重置时间偏好变更
    effect(() => {
      this.focusPreferenceService.preferences().routineResetHourLocal;
      this.dailySlotService.resetDailySlotsIfNeeded();
    });
  }

  /** 外部状态协调 effect：检测外部完成的任务并同步 */
  private registerReconciliationEffects(): void {
    effect(() => {
      const taskMap = this.taskStore.tasksMap();
      if (!taskMap) return;
      const externallyCompletedIds = this.ctx.entries()
        .filter(entry => {
          if (entry.sourceKind !== 'project-task' || entry.status === 'completed') return false;
          return taskMap.get(entry.taskId)?.status === 'completed';
        })
        .map(entry => entry.taskId);
      if (externallyCompletedIds.length === 0) return;
      queueMicrotask(() => {
        this.ctx.reconcileExternallyCompletedTasks(externallyCompletedIds);
      });
    });
  }

  /** 通知类 effects：Badge 更新、留白期通知、碎片倒计时通知 */
  private registerNotificationEffects(): void {
    effect(() => {
      const expiredCount = this.ctx.statusMachineEntries().filter(entry => isStatusMachineEntryExpired(entry)).length;
      const pendingDecisionCount = this.ctx.pendingDecision() ? 1 : 0;
      const fragmentCountdownCount = this.ctx.fragmentEntryCountdown() !== null ? 1 : 0;
      this.focusAttention.updateBadge(expiredCount + pendingDecisionCount + fragmentCountdownCount);
    });

    effect(() => {
      const blankPeriodActive =
        this.ctx.fragmentEntryCountdown() === null
        && this.ctx.pendingDecision() !== null
        && this.ctx.pendingDecisionEntries().length === 0;
      if (!blankPeriodActive) {
        this.ctx.blankPeriodNotified.set(false);
        return;
      }
      if (this.ctx.blankPeriodNotified() || !this.shouldSendAttentionNotification()) return;
      this.ctx.blankPeriodNotified.set(true);
      void this.focusAttention.notify({
        title: DOCK_NOTIFICATION.TITLE,
        body: DOCK_NOTIFICATION.TIGHT_BLANK_BODY,
        tag: 'nanoflow-focus-blank-period',
      });
    });

    effect(() => {
      const countdown = this.ctx.fragmentEntryCountdown();
      if (countdown === null) {
        this.ctx.fragmentCountdownNotified.set(false);
        return;
      }
      if (this.ctx.fragmentCountdownNotified() || !this.shouldSendAttentionNotification()) return;
      this.ctx.fragmentCountdownNotified.set(true);
      void this.focusAttention.notify({
        title: DOCK_NOTIFICATION.TITLE,
        body: DOCK_NOTIFICATION.fragmentCountdownBody(countdown),
        tag: 'nanoflow-focus-fragment-countdown',
      });
    });
  }

  // ---------------------------------------------------------------------------
  //  Visibility Listener
  // ---------------------------------------------------------------------------

  registerVisibilityListener(): void {
    if (typeof document !== 'undefined') {
      this.visibilityListener = () => {
        if (document.visibilityState !== 'visible') return;
        const userId = this.ctx.getCurrentSnapshotUserId();
        if (!userId) return;
        this.cloudSync.scheduleCloudPull(userId, false);
      };
      document.addEventListener('visibilitychange', this.visibilityListener);
    }
  }

  private buildPersistenceFingerprint(deps: unknown[]): string {
    try {
      return JSON.stringify(deps);
    } catch {
      return deps.map((item, index) => `${index}:${typeof item}`).join('|');
    }
  }

  /**
   * 延迟触发初始云端拉取，避免在启动热路径上与关键 API 请求竞争带宽。
   * 仅最新 restore token 且 owner 未切换时才允许真正调度。
   */
  private scheduleIdleCloudPull(userId: string, restoreToken: number): void {
    const scheduleIdle = (cb: () => void) => {
      const requestIdleCallback = typeof window !== 'undefined'
        ? (window as Window & { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback
        : undefined;
      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(cb);
      } else {
        // 【超时治理 2026-04-16】常量化为 IDLE_SCHEDULE_CONFIG.STANDARD_MS
        setTimeout(cb, IDLE_SCHEDULE_CONFIG.STANDARD_MS);
      }
    };
    scheduleIdle(() => {
      if (restoreToken !== this.snapshotRestoreToken) {
        return;
      }

      if (userId !== this.ctx.getCurrentSnapshotUserId() || this.ctx.restoringSnapshot()) {
        return;
      }

      this.cloudSync.scheduleCloudPull(userId, true);
    });
  }

  // ---------------------------------------------------------------------------
  //  Destroy Cleanup
  // ---------------------------------------------------------------------------

  /**
   * 注册 DestroyRef 清理回调。
   * @param extraCleanup engine 侧需要清理的额外资源（completionDrain、highlightClearTimer 等）
   */
  registerDestroyCleanup(extraCleanup: () => void): void {
    this.destroyRef.onDestroy(() => {
      this.tickInterval.stop();
      this.audioPlayer.dispose();
      this.cloudSync.cancelTimers();
      this.fragmentRest.resetAll();
      this.cancelSwitchMaintenance();
      this.snapshotPersistence.cancelPendingPersist();
      if (this.visibilityListener && typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', this.visibilityListener);
        this.visibilityListener = null;
      }
      extraCleanup();
    });
  }

  // ---------------------------------------------------------------------------
  //  Switch Maintenance（延迟区域重平衡 + 挂起推荐锁刷新）
  // ---------------------------------------------------------------------------

  scheduleSwitchMaintenance(): void {
    this.cancelSwitchMaintenance();
    const token = ++this.switchMaintenanceToken;
    // ARCH-C1 fix: 添加 deadline，防止无限重调度
    const deadline = Date.now() + 30_000;

    const execute = () => {
      if (token !== this.switchMaintenanceToken) return;
      this.switchMaintenanceIdleId = null;
      this.ctx.entries.update(prev => this.zoneService.rebalanceAutoZonesEntries(prev));
      this.refreshSuspendRecommendationLock();
    };

    const schedule = () => {
      if (token !== this.switchMaintenanceToken) return;
      const holdDelay = this.ctx.getNonCriticalHoldDelay();
      if (holdDelay > 0 && Date.now() < deadline) {
        this.switchMaintenanceFallback.schedule(schedule, holdDelay);
        return;
      }

      const g = globalThis as typeof globalThis & {
        requestIdleCallback?: (
          cb: (deadline: { didTimeout: boolean; timeRemaining: () => number }) => void,
          options?: { timeout: number },
        ) => number;
      };

      if (typeof g.requestIdleCallback === 'function') {
        this.switchMaintenanceIdleId = g.requestIdleCallback(() => execute(), { timeout: PARKING_CONFIG.MAINTENANCE_IDLE_TIMEOUT_MS });
      } else {
        this.switchMaintenanceFallback.schedule(execute, 0);
      }
    };

    schedule();
  }

  cancelSwitchMaintenance(): void {
    ++this.switchMaintenanceToken;

    const g = globalThis as typeof globalThis & {
      cancelIdleCallback?: (handle: number) => void;
    };

    if (this.switchMaintenanceIdleId !== null && typeof g.cancelIdleCallback === 'function') {
      g.cancelIdleCallback(this.switchMaintenanceIdleId);
    }
    this.switchMaintenanceIdleId = null;

    this.switchMaintenanceFallback.cancel();
  }

  // ---------------------------------------------------------------------------
  //  Hold non-critical work
  // ---------------------------------------------------------------------------

  holdNonCriticalWork(durationMs: number): void {
    if (!Number.isFinite(durationMs)) return;
    const clamped = Math.max(0, Math.floor(durationMs));
    if (clamped === 0) return;
    const until = Date.now() + clamped;
    if (until > this.nonCriticalWorkHoldUntil) {
      this.nonCriticalWorkHoldUntil = until;
    }
  }

  getNonCriticalHoldDelay(nowMs: number = Date.now()): number {
    return Math.max(0, this.nonCriticalWorkHoldUntil - nowMs);
  }

  // ---------------------------------------------------------------------------
  //  Tick-driven checks
  // ---------------------------------------------------------------------------

  checkWaitExpiry(): void {
    let shouldPlaySound = false;
    const newlyExpiredTitles: string[] = [];
    // MEM-H1 fix: 清理不再存于 entries 中的过期通知 ID
    const currentIds = new Set(this.ctx.entries().map(e => e.taskId));
    for (const id of this.ctx.waitEndNotifiedIds) {
      if (!currentIds.has(id)) this.ctx.waitEndNotifiedIds.delete(id);
    }
    this.ctx.entries.update(prev => {
      let changed = false;
      const next = [...prev];
      for (let index = 0; index < prev.length; index += 1) {
        const entry = prev[index];
        if (entry.status !== 'suspended_waiting' || !entry.waitStartedAt || !entry.waitMinutes) continue;
        if (!isWaitExpired(entry)) continue;
        changed = true;
        if (!this.ctx.waitEndNotifiedIds.has(entry.taskId)) {
          this.ctx.waitEndNotifiedIds.add(entry.taskId);
          shouldPlaySound = true;
          newlyExpiredTitles.push(entry.title);
        }
        const finished: DockEntry = { ...entry, status: 'wait_finished' };
        next[index] = finished;
      }
      return changed ? next : prev;
    });
    if (shouldPlaySound && !this.ctx.muteWaitTone()) {
      this.audioPlayer.playWaitEndSound();
    }
    if (newlyExpiredTitles.length > 0 && this.shouldSendAttentionNotification()) {
      const body = newlyExpiredTitles.length === 1
        ? `${newlyExpiredTitles[0]} 的等待已结束，可以恢复处理。`
        : `${newlyExpiredTitles.length} 个任务的等待已结束，可以回到主窗口处理。`;
      void this.focusAttention.notify({
        title: 'NanoFlow 专注提示',
        body,
        tag: 'nanoflow-focus-wait-finished',
      });
    }
  }

  checkPendingDecisionExpiry(): void {
    const pending = this.ctx.pendingDecision();
    if (!pending?.expiresAt) return;
    // 编辑锁持有期间、Gate 审查中不执行待决策超时分支（策划案 §4.1 + §7.5）
    if (this.ctx.editLock()) return;
    if (this.gateService.isActive()) return;
    if (this.completionFlow.pendingCandidateIds(pending).length > 0) return;
    const expiresAt = Date.parse(pending.expiresAt);
    if (Number.isNaN(expiresAt)) return;
    if (Date.now() < expiresAt) return;
    this.ctx.pendingDecision.set(null);
    this.ctx.highlightedIds.set(new Set());
    this.ctx.entries.update(prev =>
      patchAllEntries(prev, { systemSelected: false, recommendationLocked: false }),
    );

    // pendingCandidateIds is guaranteed empty here (early-returned above otherwise)
    this.completionFlow.enterFragmentPhase('tight-blank 超时，自动进入留白期', pending.rootTaskId, pending.rootRemainingMinutes);
  }

  refreshSuspendRecommendationLock(): void {
    const hasSuspended = this.ctx.entries().some(entry => isWaitingLike(entry.status));
    if (hasSuspended) return;

    this.ctx.suspendRecommendationLocked.set(false);
    this.ctx.suspendChainRootTaskId.set(null);
    this.ctx.pendingDecision.set(null);
    this.ctx.highlightedIds.set(new Set());
    this.ctx.entries.update(prev => this.completionFlow.clearSuspendRecommendationStateOnEntries(prev));
  }

  shouldSendAttentionNotification(): boolean {
    if (typeof document === 'undefined') return !this.focusHudWindow.isActive();
    return document.visibilityState !== 'visible' && !this.focusHudWindow.isActive();
  }

  // ---------------------------------------------------------------------------
  //  Local snapshot persistence delegation
  // ---------------------------------------------------------------------------

  async restoreLocalSnapshot(
    userId: string | null,
    emptyRestoreBaselineFingerprint: string | null = null,
    preserveCurrentOnEmptyRestore = false,
  ): Promise<void> {
    // 中文注释：切账号或恢复本地快照前先废弃旧的云同步防抖任务，防止旧 owner 定时器回写新快照。
    this.snapshotPersistence.cancelPendingPersist();
    this.cloudSync.cancelTimers();
    const ctx = this.ctx.buildNormalizeContext();
    const normalized = await this.snapshotPersistence.restoreLocalSnapshot(userId, ctx);
    // C-2 fix: 丢弃过期的异步恢复（用户已切换到其他账户）
    if (userId !== this.ctx.getCurrentSnapshotUserId()) return;
    if (normalized) {
      this.cloudSync.seedFocusModeBaseline(userId, normalized);
      this.ctx.restoreSnapshot(normalized);
      return;
    }
    if (this.shouldPreserveInMemoryStateOnEmptyRestore(emptyRestoreBaselineFingerprint)
      || (preserveCurrentOnEmptyRestore && this.hasActiveInMemorySnapshot())) {
      const currentSnapshot = this.ctx.exportSnapshot();
      this.cloudSync.seedFocusModeBaseline(userId, currentSnapshot);
      this.ctx.scheduleLocalPersist(currentSnapshot, userId);
      if (userId) {
        this.cloudSync.scheduleCloudPush(userId, currentSnapshot);
      }
      return;
    }
    this.ctx.reset();
    this.ctx.setSnapshotSavedAt(EMPTY_LOCAL_SNAPSHOT_SAVED_AT);
    this.cloudSync.seedFocusModeBaseline(userId, this.ctx.exportSnapshot());
  }

  private startSnapshotRestore(
    userId: string | null,
    options: { cloudPullMode: 'none' | 'immediate' | 'idle' },
  ): void {
    const restoreToken = ++this.snapshotRestoreToken;
    const emptyRestoreBaselineFingerprint = this.buildPersistenceFingerprint(this.ctx.persistenceDeps());
    const preserveCurrentOnEmptyRestore = this.preserveNextEmptyRestoreForUnconfirmedInMemoryState;
    this.preserveNextEmptyRestoreForUnconfirmedInMemoryState = false;
    this.ctx.restoringSnapshot.set(true);
    void this.restoreLocalSnapshot(userId, emptyRestoreBaselineFingerprint, preserveCurrentOnEmptyRestore).finally(() => {
      if (restoreToken !== this.snapshotRestoreToken) {
        return;
      }

      if (userId !== this.ctx.getCurrentSnapshotUserId()) {
        return;
      }

      this.ctx.restoringSnapshot.set(false);
      if (options.cloudPullMode === 'immediate' && userId) {
        this.cloudSync.scheduleCloudPull(userId, true);
      }

      if (options.cloudPullMode === 'idle' && userId) {
        this.scheduleIdleCloudPull(userId, restoreToken);
      }
    });
  }

  private shouldPreserveInMemoryStateOnEmptyRestore(baselineFingerprint: string | null): boolean {
    if (!baselineFingerprint) {
      return false;
    }

    const currentFingerprint = this.buildPersistenceFingerprint(this.ctx.persistenceDeps());
    if (currentFingerprint === baselineFingerprint) {
      return false;
    }

    return this.hasActiveInMemorySnapshot();
  }

  private hasActiveInMemorySnapshot(): boolean {
    const snapshot = this.ctx.exportSnapshot();
    return snapshot.entries.some(entry => entry.status !== 'completed') || snapshot.focusMode;
  }

  private clearSnapshotStateForUnconfirmedOwner(): void {
    ++this.snapshotRestoreToken;
    this.cancelSnapshotPersistenceWork();
    this.ctx.restoringSnapshot.set(false);
    const currentSnapshotUserId = this.ctx.getCurrentSnapshotUserId();
    if (currentSnapshotUserId === null && untracked(() => this.hasActiveInMemorySnapshot())) {
      this.preserveNextEmptyRestoreForUnconfirmedInMemoryState = true;
      return;
    }
    if (currentSnapshotUserId !== null) {
      this.ctx.setCurrentSnapshotUserId(null);
    }
    this.ctx.reset();
  }

  private cancelSnapshotPersistenceWork(): void {
    this.snapshotPersistence.cancelPendingPersist();
    this.cloudSync.cancelTimers();
  }

  private resolveConfirmedRestoreOwnerUserId(): string | null {
    const currentUserId = this.auth.currentUserId();
    if (currentUserId) {
      return currentUserId;
    }

    const persistedSessionUserId = this.auth.persistedSessionUserId?.()
      ?? this.auth.peekPersistedSessionIdentity?.()?.userId
      ?? null;
    if (persistedSessionUserId) {
      return persistedSessionUserId;
    }

    if (!this.auth.isConfigured || isLocalModeEnabled()) {
      return AUTH_CONFIG.LOCAL_MODE_USER_ID;
    }

    return null;
  }

  private shouldDeferRestoreUntilAuthConfirmed(ownerUserId: string | null): boolean {
    if (ownerUserId !== null) {
      return false;
    }

    return Boolean(this.auth.persistedOwnerHint?.() ?? this.auth.peekPersistedOwnerHint?.());
  }
}
