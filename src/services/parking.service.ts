/**
 * ParkingService — 停泊功能核心服务
 *
 * 策划桌 A5.1 对外契约
 * 职责：停泊/取消停泊、衰老清理、可撤回、Undo 集成
 *
 * 依赖注入规则：
 * - 禁止 inject(StoreService)，直接注入 TaskStore
 * - 不暴露 switchFocus() 给 UI 层直接调用
 */

import { Injectable, inject, signal, computed, OnDestroy } from '@angular/core';
import { TaskStore, ProjectStore } from '../app/core/state/stores';
import {
  Task,
  TaskParkingMeta,
  EvictionToken,
  EvictionTokenMap,
  ParkingNotice,
  ParkingNoticeEvictionItem,
  ParkingSnapshot,
  Project,
} from '../models';
import { PARKING_CONFIG } from '../config/parking.config';
import { POLLING_CHECK_DELAY } from '../config/timeout.config';
import { ToastService } from './toast.service';
import { UndoService } from './undo.service';
import { LoggerService } from './logger.service';
import { BeforeUnloadManagerService } from './before-unload-manager.service';
import { StartupTierOrchestratorService } from './startup-tier-orchestrator.service';
import { GateService } from './gate.service';
import { ContextRestoreService } from './context-restore.service';
import { AuthService } from './auth.service';
import { isLocalModeEnabled } from './guards/auth.guard';
import { ProjectDataService } from '../core-bridge';
import {
  getRemainingBrowserNetworkResumeDelayMs,
  isBrowserNetworkSuspendedWindow,
} from '../utils/browser-network-suspension';

interface SnapshotDraft {
  taskId: string;
  contentHash: string;
  cursorPosition: { line: number; column: number } | null;
  structuralAnchor: ParkingSnapshot['structuralAnchor'];
  savedAt: string;
}

@Injectable({
  providedIn: 'root'
})
export class ParkingService implements OnDestroy {
  // ─── 依赖注入 ───
  private readonly taskStore = inject(TaskStore);
  private readonly projectStore = inject(ProjectStore);
  private readonly toastService = inject(ToastService);
  private readonly undoService = inject(UndoService);
  private readonly logger = inject(LoggerService);
  private readonly beforeUnloadManager = inject(BeforeUnloadManagerService);
  private readonly startupOrchestrator = inject(StartupTierOrchestratorService);
  private readonly gateService = inject(GateService);
  private readonly contextRestoreService = inject(ContextRestoreService);
  private readonly projectDataService = inject(ProjectDataService);
  private readonly authService = inject(AuthService);

  // ─── 内部状态 ───
  /** 衰老清理 token Map（仅内存，不持久化） */
  private readonly evictionTokens: EvictionTokenMap = new Map();

  /** 通知队列（Gate 激活时暂存） */
  private readonly _pendingNotices = signal<ParkingNotice[]>([]);

  /** H-6: Gate 激活时延迟的驱逐通知 */
  private readonly _deferredEvictionNotices: ParkingNotice[] = [];

  /** 对外只读的通知队列 */
  readonly pendingNotices = this._pendingNotices.asReadonly();

  /** 当前预览中的任务 ID */
  readonly previewingTaskId = signal<string | null>(null);

  /** 衰老清理是否已初始化*/
  private evictionInitialized = false;
  /** 停泊轻量数据初始化 Promise（防并发：多次调用返回同一 Promise） */
  private parkedLightweightInitPromise: Promise<void> | null = null;
  /** 衰老检查轮询定时器 */
  private evictionIntervalTimer: ReturnType<typeof setInterval> | null = null;
  /** 停泊轻量增量拉取定时器 */
  private parkedDeltaTimer: ReturnType<typeof setInterval> | null = null;
  /** 启动延迟执行 timer */
  private startupEvictionTimer: ReturnType<typeof setTimeout> | null = null;
  /** 挂起恢复后的停泊增量补拉 timer */
  private parkedDeltaRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  /** M-13: initEviction 递归 ready-check 定时器 */
  private evictionReadyCheckTimer: ReturnType<typeof setTimeout> | null = null;
  /** 在线事件监听器 */
  private onlineListener: (() => void) | null = null;
  private parkedSyncOnlineListener: (() => void) | null = null;
  private visibilityChangeHandler: (() => void) | null = null;
  /** 首次交互监听器 */
  private firstInteractionHandler: (() => void) | null = null;
  /** 停泊轻量同步游标 */
  private parkedCursor: string | null = null;
  /** 衰老清理固定巡检周期 */
  private static readonly EVICTION_CHECK_INTERVAL_MS = 60_000;

  /** 提醒淡出计数（Key: taskId） */
  private readonly reminderFadeoutCounts = new Map<string, number>();

  /** 需要显示红点的任务 ID 集合 */
  readonly badgedTaskIds = signal<Set<string>>(new Set(), { equal: () => false });

  // ─── 派生状态 ───

  /** 当前 focused 任务（同一时刻最多 1 个，A4 不变量） */
  readonly focusedTask = computed(() => {
    const parked = this.taskStore.parkedTasks();
    return parked.find(t => t.parkingMeta?.state === 'focused') ?? null;
  });

  /** 停泊任务数量 */
  readonly parkedCount = computed(() => this.taskStore.parkedTaskIds().size);

  /** 是否有即将到期的提醒（< 1h） */
  readonly hasUpcomingReminder = computed(() => {
    const now = Date.now();
    const oneHour = 60 * 60 * 1000;
    return this.taskStore.parkedTasks().some(t => {
      const reminderAt = t.parkingMeta?.reminder?.reminderAt;
      if (!reminderAt) return false;
      const diff = new Date(reminderAt).getTime() - now;
      return diff > 0 && diff < oneHour;
    });
  });

  constructor() {
    // Register beforeunload snapshot save.
    this.beforeUnloadManager.register(
      'parking-snapshot',
      () => this.saveSnapshotToLocalStorage(),
      PARKING_CONFIG.BEFORE_UNLOAD_PRIORITY
    );

    // Save full snapshot into IndexedDB when page becomes hidden.
    if (typeof document !== 'undefined') {
      this.visibilityChangeHandler = () => {
        if (document.visibilityState === 'hidden') {
          void this.saveSnapshotToIndexedDB();
          return;
        }

        this.scheduleParkedDeltaRefresh('visible');
      };
      document.addEventListener('visibilitychange', this.visibilityChangeHandler);
    }

    if (typeof window !== 'undefined') {
      this.parkedSyncOnlineListener = () => {
        this.scheduleParkedDeltaRefresh('online');
      };
      window.addEventListener('online', this.parkedSyncOnlineListener);
    }

    // Start stale parked-task eviction flow.
    this.initEviction();

    // Start lightweight parked-task sync.
    void this.initParkedLightweightSync();
  }

  /**
   * 【修复 P1-08】清理所有定时器和事件监听器，防止内存泄漏
   */
  ngOnDestroy(): void {
    if (this.evictionIntervalTimer) {
      clearInterval(this.evictionIntervalTimer);
      this.evictionIntervalTimer = null;
    }
    if (this.parkedDeltaTimer) {
      clearInterval(this.parkedDeltaTimer);
      this.parkedDeltaTimer = null;
    }
    if (this.startupEvictionTimer) {
      clearTimeout(this.startupEvictionTimer);
      this.startupEvictionTimer = null;
    }
    if (this.parkedDeltaRecoveryTimer) {
      clearTimeout(this.parkedDeltaRecoveryTimer);
      this.parkedDeltaRecoveryTimer = null;
    }
    if (this.evictionReadyCheckTimer) {
      clearTimeout(this.evictionReadyCheckTimer);
      this.evictionReadyCheckTimer = null;
    }
    if (this.onlineListener) {
      window.removeEventListener('online', this.onlineListener);
      this.onlineListener = null;
    }
    if (this.parkedSyncOnlineListener) {
      window.removeEventListener('online', this.parkedSyncOnlineListener);
      this.parkedSyncOnlineListener = null;
    }
    if (this.visibilityChangeHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityChangeHandler);
      this.visibilityChangeHandler = null;
    }
    if (this.firstInteractionHandler) {
      document.removeEventListener('keydown', this.firstInteractionHandler);
      document.removeEventListener('click', this.firstInteractionHandler);
      document.removeEventListener('scroll', this.firstInteractionHandler);
      this.firstInteractionHandler = null;
    }
  }

  // ─── 对外 API（A5.1 契约）───

  /**
   * 预览任务——不切换 Focus，仅打开详情
   * 刷新 lastVisitedAt 防止衰老清理（A6.1b.5）   */
  previewTask(taskId: string): void {
    const task = this.taskStore.getTask(taskId);
    if (!task?.parkingMeta) return;

    // At any moment only one previewing task.
    this.previewingTaskId.set(taskId);

    // 刷新 lastVisitedAt
    this.updateParkingMeta(taskId, {
      ...task.parkingMeta,
      lastVisitedAt: new Date().toISOString(),
    });
  }

  /**
   * 切换到目标任务——保存当前→切换→恢复上下文   * 对外唯一切换入口（A5.1.2）   */
  startWork(taskId: string): void {
    const targetTask = this.taskStore.getTask(taskId);
    if (!targetTask) {
      this.logger.warn('ParkingService', 'startWork: target task not found', { taskId });
      return;
    }

    // 目标必须是 active 状态（A4 不变量）
    if (targetTask.status !== 'active') {
      this.logger.warn('ParkingService', 'startWork: 只能对 active 任务执行', { taskId, status: targetTask.status });
      return;
    }

    const currentFocused = this.focusedTask();
    const undoSnapshots = this.captureParkUndoSnapshots([taskId, currentFocused?.id ?? null]);

    // 1) Snapshot current focused task then park it.
    if (currentFocused && currentFocused.id !== taskId) {
      void this.contextRestoreService.saveSnapshot(currentFocused.id);

      // 当前 focused → parked
      this.updateParkingMeta(currentFocused.id, {
        ...currentFocused.parkingMeta!,
        state: 'parked',
        parkedAt: new Date().toISOString(),
        lastVisitedAt: new Date().toISOString(),
      });
    }

    // 2. 目标任务 → focused
    const now = new Date().toISOString();
    const newMeta: TaskParkingMeta = targetTask.parkingMeta
      ? { ...targetTask.parkingMeta, state: 'focused', lastVisitedAt: now }
      : {
        state: 'focused',
        parkedAt: null,
        lastVisitedAt: now,
        contextSnapshot: null,
        reminder: null,
        pinned: false,
      };
    this.updateParkingMeta(taskId, newMeta);

    // 3) Restore context snapshot for target task when available.
    if (targetTask.parkingMeta?.contextSnapshot) {
      this.contextRestoreService.restore(taskId, targetTask.parkingMeta.contextSnapshot);
    }

    // 4. 关闭预览
    this.previewingTaskId.set(null);

    // 5) Record undo action.
    this.recordParkUndoAction(undoSnapshots);
  }

  /**
   * 从停泊列表移除——移回普通任务列表   * 5s 可撤回（A6.2b）   */
  removeParkedTask(taskId: string): void {
    const task = this.taskStore.getTask(taskId);
    if (!task?.parkingMeta) return;

    const previousMeta = { ...task.parkingMeta };

    // 清除 parkingMeta
    this.clearParkingMeta(taskId);

    // Close preview if we were previewing this task.
    if (this.previewingTaskId() === taskId) {
      this.previewingTaskId.set(null);
    }

    // 5s 可撤回 Snackbar
    this.toastService.info(
      `「${task.title}」已移回任务列表`,
      undefined,
      {
        duration: PARKING_CONFIG.REMOVE_UNDO_TIMEOUT_MS,
        action: {
          label: '撤回',
          onClick: () => this.restoreParkingMeta(taskId, previousMeta),
        },
      }
    );
  }

  /**
   * 撤回衰老清理（A5.1.4）   */
  undoEviction(tokenId: string): void {
    const evictionToken = this.evictionTokens.get(tokenId);
    if (!evictionToken) {
      this.logger.warn('ParkingService', 'undoEviction: token not found', { tokenId });
      return;
    }
    if (this.isEvictionTokenExpired(evictionToken)) {
      this.evictionTokens.delete(tokenId);
      this.logger.warn('ParkingService', 'undoEviction: token expired', {
        tokenId,
        expiresAt: evictionToken.expiresAt,
      });
      return;
    }
    if (evictionToken.usedAt !== null) {
      this.logger.warn('ParkingService', 'undoEviction: token already used', { tokenId });
      return;
    }

    evictionToken.usedAt = Date.now();
    this.evictionTokens.set(tokenId, evictionToken);
    this.restoreParkingMeta(evictionToken.taskId, evictionToken.previousParkingMeta);
  }

  /**
   * 停泊当前任务——用户主动将任务放入「稍后处理」
   */
  parkTask(taskId: string): void {
    const task = this.taskStore.getTask(taskId);
    if (!task || task.status !== 'active') return;

    const now = new Date().toISOString();
    const meta: TaskParkingMeta = task.parkingMeta
      ? { ...task.parkingMeta, state: 'parked', parkedAt: now, lastVisitedAt: now }
      : {
        state: 'parked',
        parkedAt: now,
        lastVisitedAt: now,
        contextSnapshot: null,
        reminder: null,
        pinned: false,
      };

    // 保存快照然后停泊
    void this.contextRestoreService.saveSnapshot(taskId);
    this.updateParkingMeta(taskId, meta);

    // 全局统一视觉反馈
    this.toastService.success('已停泊', `「${task.title || '未命名任务'}」已移至稍后处理`);
  }

  /**
   * 切换 pinned 状态（A6.4.7）
   */
  togglePinned(taskId: string): void {
    const task = this.taskStore.getTask(taskId);
    if (!task?.parkingMeta) return;

    this.updateParkingMeta(taskId, {
      ...task.parkingMeta,
      pinned: !task.parkingMeta.pinned,
    });
  }

  /**
   * 快速回切——切回最近停泊任务，跳过预览（A6.1.4）
   */
  quickSwitch(): void {
    const parked = this.taskStore.parkedTasks();
    const mostRecent = parked.find(t => t.parkingMeta?.state === 'parked');
    if (mostRecent) {
      this.startWork(mostRecent.id);
    }
  }

  // ─── 停泊轻量增量同步（A3.4）───

  private async initParkedLightweightSync(): Promise<void> {
    if (this.parkedLightweightInitPromise) return this.parkedLightweightInitPromise;
    this.parkedLightweightInitPromise = this.doInitParkedLightweightSync();
    return this.parkedLightweightInitPromise;
  }

  private async doInitParkedLightweightSync(): Promise<void> {
    try {
      // 1) 先读缓存（冷启动快速可见）
      const cached = await this.projectDataService.loadParkedTasksCache();
      this.parkedCursor = cached.cursor;
      for (const entry of cached.entries) {
        this.applyRemoteParkedEntry(entry.task, entry.projectId);
      }

      // 2) Pull one incremental delta in background.
      await this.syncParkedDelta();

      // 3) 启动恢复时：优先使用 IDB 已恢复快照，降级读取草稿并清理草稿键
      this.restoreSnapshotDraftFromLocalStorage();

      // 4) Start periodic incremental refresh.
      this.parkedDeltaTimer = setInterval(() => {
        void this.syncParkedDelta();
      }, ParkingService.EVICTION_CHECK_INTERVAL_MS);
    } catch (error: unknown) {
      // H-5 fix: 初始化失败时清除缓存的 Promise，允许后续重试
      this.parkedLightweightInitPromise = null;
      this.logger.warn('ParkingService', 'doInitParkedLightweightSync failed, will allow retry', error);
    }
  }

  private async syncParkedDelta(): Promise<void> {
    // M-24 fix: 离线时跳过增量拉取，避免不必要的网络错误
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;
    if (!this.authService.currentUserId() || isLocalModeEnabled()) return;
    if (isBrowserNetworkSuspendedWindow()) {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        this.scheduleParkedDeltaRefresh('network-suspended');
      }
      return;
    }

    const knownParkedTaskIds = Array.from(this.taskStore.parkedTaskIds());
    const knownProjectIds = this.getProjectIdsForParkedSync();
    if (knownProjectIds.length === 0) {
      this.logger.debug('ParkingService', '项目列表未就绪，跳过停泊任务增量同步');
      this.scheduleParkedDeltaProjectRetry();
      return;
    }

    const delta = await this.projectDataService.pullParkedTasksDelta(
      this.parkedCursor,
      knownParkedTaskIds,
      knownProjectIds,
    );

    if (delta.entries.length === 0 && delta.removedTaskIds.length === 0) {
      this.parkedCursor = delta.nextCursor ?? this.parkedCursor;
      return;
    }

    for (const entry of delta.entries) {
      this.applyRemoteParkedEntry(entry.task, entry.projectId);
    }

    for (const taskId of delta.removedTaskIds) {
      this.applyRemoteParkingRemoval(taskId);
    }

    this.parkedCursor = delta.nextCursor ?? this.parkedCursor;

    // 增量结果回写缓存（覆盖式，数据量小）
    const entries = this.taskStore.parkedTasks()
      .map((task) => ({
        task,
        projectId: this.findProjectId(task.id),
      }))
      .filter((entry): entry is { task: Task; projectId: string } => !!entry.projectId);

    await this.projectDataService.saveParkedTasksCache({
      entries,
      cursor: this.parkedCursor,
    });
  }

  private getProjectIdsForParkedSync(): string[] {
    const projectIds = new Set<string>();
    const projects = this.projectStore.projects();
    if (projects.length === 0) {
      return [];
    }

    for (const project of projects) {
      if (!project.deletedAt) {
        projectIds.add(project.id);
      }
    }

    return Array.from(projectIds);
  }

  private scheduleParkedDeltaRefresh(reason: 'visible' | 'online' | 'network-suspended'): void {
    if (this.parkedDeltaRecoveryTimer) return;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;
    if (!this.authService.currentUserId() || isLocalModeEnabled()) return;

    const delayMs = Math.max(100, getRemainingBrowserNetworkResumeDelayMs() + 50);
    this.parkedDeltaRecoveryTimer = setTimeout(() => {
      this.parkedDeltaRecoveryTimer = null;
      void this.syncParkedDelta();
    }, delayMs);

    this.logger.debug('ParkingService', '延后停泊任务增量同步以避开浏览器网络挂起窗口', {
      reason,
      delayMs,
    });
  }

  private scheduleParkedDeltaProjectRetry(): void {
    if (this.parkedDeltaRecoveryTimer) return;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;
    if (!this.authService.currentUserId() || isLocalModeEnabled()) return;

    this.parkedDeltaRecoveryTimer = setTimeout(() => {
      this.parkedDeltaRecoveryTimer = null;
      void this.syncParkedDelta();
    }, POLLING_CHECK_DELAY.CONDITION_READY);

    this.logger.debug('ParkingService', '项目列表未就绪，延后重试停泊任务增量同步', {
      delayMs: POLLING_CHECK_DELAY.CONDITION_READY,
    });
  }

  private applyRemoteParkedEntry(task: Task, projectId: string): void {
    const local = this.taskStore.getTask(task.id);
    // C-3 fix: LWW 检查 — 本地版本更新时跳过远端覆盖
    if (local && local.updatedAt && task.updatedAt && local.updatedAt > task.updatedAt) {
      return;
    }
    const nextTask = local
      ? {
        ...local,
        ...task,
        // Keep local displayId maintained by layout logic.
        displayId: local.displayId || task.displayId,
      }
      : task;

    this.taskStore.setTask(nextTask, projectId);
  }

  private applyRemoteParkingRemoval(taskId: string): void {
    const task = this.taskStore.getTask(taskId);
    if (!task?.parkingMeta) return;
    const projectId = this.findProjectId(taskId);
    if (!projectId) return;
    this.taskStore.setTask({ ...task, parkingMeta: undefined }, projectId);
  }

  // ─── 衰老清理（A6.4）───

  /**
   * 初始化衰老清理——延迟到 p1 就绪 + 首次交互后 3s（A5.1.6 / A6.4.5）   */
  initEviction(): void {
    if (this.evictionInitialized) return;
    this.evictionInitialized = true;

    const maxReadyChecks = 120;
    let readyChecks = 0;

    const checkReady = () => {
      readyChecks += 1;
      const tierReady = this.startupOrchestrator.isTierReady('p1');
      if (tierReady || readyChecks >= maxReadyChecks) {
        this.evictionReadyCheckTimer = null;
        this.armFirstInteractionForEviction();
      } else {
        this.evictionReadyCheckTimer = setTimeout(checkReady, POLLING_CHECK_DELAY.CONDITION_READY);
      }
    };
    checkReady();
  }
  private armFirstInteractionForEviction(): void {
    if (typeof document === 'undefined') return;
    if (this.firstInteractionHandler) return;

    this.firstInteractionHandler = () => {
      if (!this.firstInteractionHandler) return;
      document.removeEventListener('keydown', this.firstInteractionHandler);
      document.removeEventListener('click', this.firstInteractionHandler);
      document.removeEventListener('scroll', this.firstInteractionHandler);
      this.firstInteractionHandler = null;

      this.scheduleEvictionStartup();
    };

    document.addEventListener('keydown', this.firstInteractionHandler);
    document.addEventListener('click', this.firstInteractionHandler);
    document.addEventListener('scroll', this.firstInteractionHandler);

    // Skip eviction while offline; re-check immediately when back online.
    if (typeof window !== 'undefined' && !this.onlineListener) {
      this.onlineListener = () => this.runEvictionCheck();
      window.addEventListener('online', this.onlineListener);
    }

    // 首次交互监听器可能在用户早已完成首轮操作后才挂上；兜底启动避免整条清理链永远不上电。
    this.scheduleEvictionStartup();
  }

  private scheduleEvictionStartup(): void {
    if (this.startupEvictionTimer) return;
    this.startupEvictionTimer = setTimeout(() => {
      this.runEvictionCheck();
      // After startup, switch to fixed interval checks.
      if (!this.evictionIntervalTimer) {
        this.evictionIntervalTimer = setInterval(
          () => this.runEvictionCheck(),
          ParkingService.EVICTION_CHECK_INTERVAL_MS
        );
      }
      this.startupEvictionTimer = null;
    }, PARKING_CONFIG.EVICTION_STARTUP_DELAY_MS);
  }

  /**
   * 执行衰老清理检查   */
  private runEvictionCheck(): void {
    if (!this.canRunEvictionNow()) return;

    this.pruneExpiredEvictionTokens();

    const now = Date.now();
    const tasks = this.taskStore.parkedTasks();
    const evictedItems: ParkingNoticeEvictionItem[] = [];

    for (const task of tasks) {
      if (!task.parkingMeta || task.parkingMeta.state === 'focused') continue;
      if (task.parkingMeta.pinned) continue; // 豁免

      const lastVisited = task.parkingMeta.lastVisitedAt
        ? new Date(task.parkingMeta.lastVisitedAt).getTime()
        : task.parkingMeta.parkedAt
          ? new Date(task.parkingMeta.parkedAt).getTime()
          : now;

      const elapsed = now - lastVisited;

      if (elapsed >= PARKING_CONFIG.PARKED_TASK_STALE_THRESHOLD) {
        const token = this.evictTask(task);
        if (token) {
          evictedItems.push({
            taskId: token.taskId,
            taskTitle: token.taskTitle,
            evictionTokenId: token.tokenId,
          });
        }
      }
    }

    if (evictedItems.length === 0) return;
    this.showNotice(this.createEvictionNotice(evictedItems));
  }

  private canRunEvictionNow(): boolean {
    if (typeof navigator === 'undefined') return true;
    return navigator.onLine;
  }

  private evictTask(task: Task): EvictionToken | null {
    if (!task.parkingMeta) return null;

    // Save token with id and expiry window.
    const now = Date.now();
    const tokenId = crypto.randomUUID();
    const token: EvictionToken = {
      tokenId,
      taskId: task.id,
      taskTitle: task.title,
      previousParkingMeta: { ...task.parkingMeta },
      createdAt: now,
      expiresAt: now + PARKING_CONFIG.EVICTION_UNDO_TIMEOUT_MS,
      usedAt: null,
    };
    this.evictionTokens.set(tokenId, token);

    // 清除 parkingMeta
    this.clearParkingMeta(task.id);
    return token;
  }

  private pruneExpiredEvictionTokens(): void {
    if (this.evictionTokens.size === 0) return;
    const now = Date.now();
    for (const [tokenId, token] of this.evictionTokens.entries()) {
      if (token.expiresAt <= now || token.usedAt !== null) {
        this.evictionTokens.delete(tokenId);
      }
    }
  }

  private isEvictionTokenExpired(token: EvictionToken): boolean {
    return token.expiresAt <= Date.now();
  }

  /**
   * 批量清理通知：汇总入口 + 逐条撤回
   */
  private createEvictionNotice(items: ParkingNoticeEvictionItem[]): ParkingNotice {
    if (items.length === 1) {
      const item = items[0];
      return {
        id: crypto.randomUUID(),
        type: 'eviction',
        taskId: item.taskId,
        taskTitle: item.taskTitle,
        minVisibleMs: PARKING_CONFIG.NOTICE_MIN_VISIBLE_MS,
        fallbackTimeoutMs: PARKING_CONFIG.NOTICE_FALLBACK_TIMEOUT_MS,
        reason: '72 小时未访问，已自动移回任务列表。',
        evictionTokenId: item.evictionTokenId,
        actions: [
          { key: 'undo-eviction', label: '撤回' },
          { key: 'keep-parked', label: '关闭' },
        ],
      };
    }

    return {
      id: crypto.randomUUID(),
      type: 'eviction',
      taskId: items[0].taskId,
      taskTitle: `${items.length} 个停泊任务已移回任务列表`,
      minVisibleMs: PARKING_CONFIG.NOTICE_MIN_VISIBLE_MS,
      fallbackTimeoutMs: PARKING_CONFIG.NOTICE_FALLBACK_TIMEOUT_MS,
      reason: '72 小时未访问，已自动清理，可逐条撤回。',
      evictionItems: items,
      actions: [
        { key: 'keep-parked', label: '关闭' },
      ],
    };
  }

  /**
   * 获取单个清理 token（用于组件判断按钮状态）
   */
  getEvictionToken(tokenId: string): EvictionToken | null {
    const token = this.evictionTokens.get(tokenId) ?? null;
    if (!token) return null;
    if (this.isEvictionTokenExpired(token)) {
      this.evictionTokens.delete(tokenId);
      return null;
    }
    return token;
  }

  /**
   * Gate 激活时驱逐通知延迟入队；关闭后由组件消费展示
   */
  showNotice(notice: ParkingNotice): void {
    // H-6 fix: Gate 激活时驱逐通知延迟到 Gate 关闭后再展示
    if (notice.type === 'eviction' && this.gateService.isActive()) {
      this._deferredEvictionNotices.push(notice);
      return;
    }
    this._pendingNotices.update(list => [...list, notice]);
  }

  /** H-6: Gate 关闭后刷出延迟的驱逐通知 */
  flushDeferredNotices(): void {
    if (this._deferredEvictionNotices.length === 0) return;
    const batch = this._deferredEvictionNotices.splice(0);
    this._pendingNotices.update(list => [...list, ...batch]);
  }

  // ─── 停泊任务被软删除联动（A5.1.5）───

  /**
   * 处理任务被软删除——从停泊列表移除
   * 由 TaskTrashService 在 deleteTask 内调用   */
  handleTaskSoftDelete(taskId: string): void {
    const task = this.taskStore.getTask(taskId);
    if (task?.parkingMeta) {
      this.clearParkingMeta(taskId);
      if (this.previewingTaskId() === taskId) {
        this.previewingTaskId.set(null);
      }
    }
  }

  /**
   * 处理任务标记完成/归档——清除 parkingMeta（A3.9）   */
  handleTaskStatusChange(taskId: string, newStatus: string): void {
    if (newStatus === 'completed' || newStatus === 'archived') {
      const task = this.taskStore.getTask(taskId);
      if (task?.parkingMeta) {
        this.clearParkingMeta(taskId);
      }
    }
  }

  // ─── 提醒红点（A5.3.5）───

  /**
   * 记录提醒通知被从底部淡出   */
  recordReminderFadeout(taskId: string): void {
    const count = (this.reminderFadeoutCounts.get(taskId) || 0) + 1;
    this.reminderFadeoutCounts.set(taskId, count);
    if (count >= PARKING_CONFIG.REMINDER_BADGE_THRESHOLD) {
      this.badgedTaskIds.update(s => { s.add(taskId); return s; });
    }
  }

  /**
   * 清除提醒红点
   */
  clearBadge(taskId: string): void {
    this.reminderFadeoutCounts.delete(taskId);
    this.badgedTaskIds.update(s => { s.delete(taskId); return s; });
  }

  // ─── 轻量编辑（A6.1b.3）───

  /**
   * 在预览状态追加备注   * 以「\n---\n> 备注（停泊时）: {content}」格式追加到 content 末尾
   */
  addNote(taskId: string, noteContent: string): void {
    const task = this.taskStore.getTask(taskId);
    if (!task) return;

    const separator = '\n---\n';
    const noteBlock = `> 备注（停泊时）: ${noteContent}`;
    const updatedContent = (task.content ?? '') + separator + noteBlock;

    // Resolve project id for target task.
    const projectId = this.findProjectId(taskId);
    if (!projectId) return;

    // Update content through normal debounced sync path.
    this.taskStore.setTask(
      { ...task, content: updatedContent, updatedAt: new Date().toISOString() },
      projectId
    );
  }

  // ─── SOFT_LIMIT 警告（A2.4 / P-21）───

  /** 是否超过软上限 */
  readonly isOverSoftLimit = computed(() =>
    this.parkedCount() >= PARKING_CONFIG.PARKED_TASK_SOFT_LIMIT
  );

  // ─── 内部辅助 ───

  private updateParkingMeta(taskId: string, meta: TaskParkingMeta): void {
    const task = this.taskStore.getTask(taskId);
    if (!task) return;

    const projectId = this.findProjectId(taskId);
    if (!projectId) return;

    this.taskStore.setTask(
      { ...task, parkingMeta: meta, updatedAt: new Date().toISOString() },
      projectId
    );
  }

  private clearParkingMeta(taskId: string): void {
    const task = this.taskStore.getTask(taskId);
    if (!task) return;

    const projectId = this.findProjectId(taskId);
    if (!projectId) return;

    this.taskStore.setTask(
      { ...task, parkingMeta: undefined, updatedAt: new Date().toISOString() },
      projectId
    );
  }

  private restoreParkingMeta(taskId: string, meta: TaskParkingMeta): void {
    const task = this.taskStore.getTask(taskId);
    if (!task) return;

    const projectId = this.findProjectId(taskId);
    if (!projectId) return;

    this.taskStore.setTask(
      { ...task, parkingMeta: meta, updatedAt: new Date().toISOString() },
      projectId
    );
  }

  /**
   * 查找任务所属项目 ID
   */
  private findProjectId(taskId: string): string | null {
    return this.taskStore.getTaskProjectId(taskId)
      ?? this.projectStore.activeProjectId()
      ?? null;
  }

  /**
   * 记录 Undo 操作（A3.7）
   */
  private captureParkUndoSnapshots(taskIds: Array<string | null>): Map<string, Partial<Project>> {
    const snapshots = new Map<string, Partial<Project>>();
    for (const taskId of taskIds) {
      if (!taskId) continue;
      const projectId = this.findProjectId(taskId);
      if (!projectId || snapshots.has(projectId)) continue;
      const project = this.projectStore.getProject(projectId);
      if (!project) continue;
      snapshots.set(projectId, this.undoService.createProjectSnapshot(project));
    }
    return snapshots;
  }

  private recordParkUndoAction(beforeSnapshots: Map<string, Partial<Project>>): void {
    for (const [projectId, before] of beforeSnapshots.entries()) {
      const project = this.projectStore.getProject(projectId);
      if (!project) continue;
      const after = this.undoService.createProjectSnapshot(project);
      if (!this.hasProjectSnapshotChanged(before, after)) continue;
      this.undoService.recordAction({
        type: 'task-park',
        projectId,
        data: { before, after },
      });
    }
  }

  private hasProjectSnapshotChanged(before: Partial<Project>, after: Partial<Project>): boolean {
    const beforeTasks = before.tasks ?? [];
    const afterTasks = after.tasks ?? [];
    if (beforeTasks.length !== afterTasks.length) return true;
    const beforeConnections = before.connections ?? [];
    const afterConnections = after.connections ?? [];
    if (beforeConnections.length !== afterConnections.length) return true;
    return JSON.stringify(beforeTasks) !== JSON.stringify(afterTasks)
      || JSON.stringify(beforeConnections) !== JSON.stringify(afterConnections);
  }

  /**
   * 消费并移除队首通知
   */
  consumeNotice(noticeId: string): void {
    this._pendingNotices.update(list => list.filter(n => n.id !== noticeId));
  }

  /**
   * 保留停泊任务——重置 lastVisitedAt，清除即将清理状态（A6.4.2）   */
  keepParked(taskId: string): void {
    const task = this.taskStore.getTask(taskId);
    if (!task?.parkingMeta) return;
    this.updateParkingMeta(taskId, {
      ...task.parkingMeta,
      lastVisitedAt: new Date().toISOString(),
    });
    this.toastService.info('已保留，不会被自动清理');
  }

  // ─── BeforeUnload 快照（A3.12）───

  /**
   * 同步写入 localStorage 紧急快照   */
  private saveSnapshotToLocalStorage(): void {
    const focused = this.focusedTask();
    if (!focused?.parkingMeta?.contextSnapshot) return;

    try {
      const draft: SnapshotDraft = {
        taskId: focused.id,
        contentHash: focused.parkingMeta.contextSnapshot.contentHash,
        cursorPosition: focused.parkingMeta.contextSnapshot.cursorPosition,
        structuralAnchor: focused.parkingMeta.contextSnapshot.structuralAnchor,
        savedAt: new Date().toISOString(),
      };
      localStorage.setItem(PARKING_CONFIG.SNAPSHOT_DRAFT_KEY, JSON.stringify(draft));
    } catch {
      // localStorage 写入失败（容量不足/隐私模式），静默忽略
    }
  }

  /**
   * 异步写入 IndexedDB 完整快照
   */
  private async saveSnapshotToIndexedDB(): Promise<void> {
    const focused = this.focusedTask();
    if (focused) {
      // 触发 ContextRestoreService 保存完整快照
      void this.contextRestoreService.saveSnapshot(focused.id);
    }
    await this.persistParkedTasksToIndexedDB();
  }

  private async persistParkedTasksToIndexedDB(): Promise<void> {
    const entries = this.taskStore.parkedTasks()
      .map((task) => ({
        task,
        projectId: this.findProjectId(task.id),
      }))
      .filter((entry): entry is { task: Task; projectId: string } => !!entry.projectId);

    await this.projectDataService.saveParkedTasksCache({
      entries,
      cursor: this.parkedCursor,
    });
  }

  private restoreSnapshotDraftFromLocalStorage(): void {
    const draft = this.readSnapshotDraft();
    if (!draft) return;

    try {
      const task = this.taskStore.getTask(draft.taskId);
      if (!task?.parkingMeta) return;

      const idbSavedAt = this.parseSavedAt(task.parkingMeta.contextSnapshot?.savedAt);
      const draftSavedAt = this.parseSavedAt(draft.savedAt);
      if (draftSavedAt <= idbSavedAt) return;

      const existing = task.parkingMeta.contextSnapshot;
      const merged: ParkingSnapshot = {
        savedAt: draft.savedAt,
        contentHash: draft.contentHash || existing?.contentHash || '',
        viewMode: existing?.viewMode ?? 'text',
        cursorPosition: draft.cursorPosition ?? existing?.cursorPosition ?? null,
        scrollAnchor: existing?.scrollAnchor ?? null,
        structuralAnchor: draft.structuralAnchor ?? existing?.structuralAnchor ?? null,
        flowViewport: existing?.flowViewport ?? null,
      };

      this.updateParkingMeta(task.id, {
        ...task.parkingMeta,
        contextSnapshot: merged,
      });
    } finally {
      try {
        localStorage.removeItem(PARKING_CONFIG.SNAPSHOT_DRAFT_KEY);
      } catch {
        // 忽略 localStorage 清理失败
      }
    }
  }

  private readSnapshotDraft(): SnapshotDraft | null {
    if (typeof localStorage === 'undefined') return null;
    try {
      const raw = localStorage.getItem(PARKING_CONFIG.SNAPSHOT_DRAFT_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<SnapshotDraft>;
      if (
        typeof parsed?.taskId !== 'string'
        || typeof parsed?.savedAt !== 'string'
        || typeof parsed?.contentHash !== 'string'
      ) {
        return null;
      }
      return {
        taskId: parsed.taskId,
        contentHash: parsed.contentHash,
        cursorPosition: parsed.cursorPosition ?? null,
        structuralAnchor: parsed.structuralAnchor ?? null,
        savedAt: parsed.savedAt,
      };
    } catch {
      // eslint-disable-next-line no-restricted-syntax -- JSON.parse 失败时无法构造有效结果，返回 null 表示解析失败
      return null;
    }
  }

  private parseSavedAt(value: string | null | undefined): number {
    if (!value) return 0;
    const ts = Date.parse(value);
    return Number.isNaN(ts) ? 0 : ts;
  }
}
