/**
 * SimpleSyncService - 同步服务（门面模式）
 *
 * 核心原则（来自 AGENTS.md）：
 * - 采用 Last-Write-Wins (LWW) 策略
 * - 用户操作 → 立即写入本地 → 后台推送到 Supabase
 * - 错误处理：失败放入 RetryQueue，网络恢复自动重试
 *
 * 委托拓扑：
 * - 任务同步：TaskSyncOperationsService
 * - 连接同步：ConnectionSyncOperationsService
 * - 项目同步：ProjectDataService
 * - 重试队列：RetryQueueService
 *
 * 【技术债务 · 尺寸红线（2026-04-16 校正）】
 * AGENTS.md §12 规定单文件硬顶 800 行。本文件仍明显越界。
 * 2026-02-01 的重构说明曾声称「≤800 行门面」，但随着 P0 修复持续合并，
 * 门面本身再次膨胀。后续工作必须只做「下切」：
 *   - 抽离 setupXxx/handleXxx 私有方法到独立子服务
 *   - 任何新加的业务分支都应落到子服务，而不是继续堆在这里
 *   - 不得在此处再写「已重构为 X 行」的承诺直到 line count 实际达标
 */

import { Injectable, inject, signal, computed, DestroyRef, Injector } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { SupabaseClientService, type SupabaseConnectivityChange } from '../../../services/supabase-client.service';
import { LoggerService } from '../../../services/logger.service';
import { ToastService } from '../../../services/toast.service';
import { ActionQueueService } from '../../../services/action-queue.service';
import { RequestThrottleService } from '../../../services/request-throttle.service';
import { ClockSyncService } from '../../../services/clock-sync.service';
import { EventBusService } from '../../../services/event-bus.service';
// 拆分的子服务
import {
  TombstoneService,
  RealtimePollingService,
  SessionManagerService,
  SyncOperationHelperService,
  UserPreferencesSyncService,
  FocusConsoleSyncService,
  ProjectDataService,
  BatchSyncService,
  TaskSyncOperationsService,
  ConnectionSyncOperationsService,
  RetryQueueService,
  ConnectivityRecoveryService,
  type RetryableEntityType,
  type RetryableOperation
} from './sync';
import type {
  ProjectListMetadataLoadOptions,
  StartupOfflineSnapshotLoadResult,
} from './sync/project-data.service';
import { Task, Project, Connection, UserPreferences } from '../../../models';
import {
  DockSnapshot,
  FocusSessionRecord,
  RoutineCompletionMutation,
  RoutineTask,
} from '../../../models/parking-dock';
import { ProjectRow, TaskRow, ConnectionRow } from '../../../models/supabase-types';
import { nowISO } from '../../../utils/date';
import {
  supabaseErrorToError,
  type EnhancedError,
  classifySupabaseClientFailure
} from '../../../utils/supabase-error';
import { PermanentFailureError, isPermanentFailureError } from '../../../utils/permanent-failure-error';
import {
  type Result,
  type OperationError,
  ErrorCodes,
  failure,
  success,
} from '../../../utils/result';
import { SYNC_CONFIG, FIELD_SELECT_CONFIG, CACHE_CONFIG } from '../../../config/sync.config';
import { APP_LIFECYCLE_CONFIG } from '../../../config/app-lifecycle.config';
import { FEATURE_FLAGS } from '../../../config/feature-flags.config';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SentryLazyLoaderService } from '../../../services/sentry-lazy-loader.service';
import { SyncRpcClientService, type SyncRpcResult } from '../../../services/sync-rpc-client.service';
import { BlackBoxSyncService } from '../../../services/black-box-sync.service';
import { ChangeTrackerService } from '../../../services/change-tracker.service';
import { BlackBoxEntry } from '../../../models/focus';
import { ProjectStore } from '../state/stores';
import { SyncStateService, type ConflictData } from './sync/sync-state.service';
import {
  getRemainingBrowserNetworkResumeDelayMs,
  isBrowserNetworkSuspendedError,
  isBrowserNetworkSuspendedWindow,
} from '../../../utils/browser-network-suspension';
import {
  getCompatibleTaskSelectFields,
  markTaskCompletedAtColumnUnavailable,
} from '../../../utils/task-schema-compat';
import {
  SyncCursorPersistenceService,
  compareProjectSyncCursor,
  projectCursorFromLegacyTimestamp,
  type ProjectSyncCursor,
  type ProjectSyncCursorEntityType,
} from '../state/persistence';

export type { ProjectSyncCursor, ProjectSyncCursorEntityType } from '../state/persistence';

export interface ProjectDeltaDrift {
  tasks: Task[];
  connections: Connection[];
  nextCursor: ProjectSyncCursor | null;
}

type ProjectSaveResult = {
  success: boolean;
  conflict?: boolean;
  remoteData?: Project;
  newVersion?: number;
  projectPushed?: boolean;
  failedTaskIds?: string[];
  failedConnectionIds?: string[];
  retryEnqueued?: string[];
  failureReason?: string;
  terminal?: boolean;
};

interface QueuedProjectSaveRequest {
  project: Project;
  userId: string;
  signature: string;
  taskIdsToDelete?: string[];
  promise: Promise<ProjectSaveResult>;
  resolve: (result: ProjectSaveResult) => void;
  reject: (error: unknown) => void;
}

interface ProjectSaveFlight {
  activeSignature: string;
  activeTaskIdsToDelete?: string[];
  activePromise: Promise<ProjectSaveResult>;
  queuedRequest: QueuedProjectSaveRequest | null;
}

/** 远程变更回调 */
export type RemoteChangeCallback = (payload: { eventType?: string; projectId?: string } | undefined) => Promise<void>;

/** 任务变更回调 */
export type TaskChangeCallback = (payload: { eventType: string; taskId: string; projectId: string }) => void;

/** 用户偏好变更回调 */
export type UserPreferencesChangeCallback = (payload: { eventType: string; userId: string }) => void;

/** 恢复链路参数 */
export interface ResumeRecoverOptions {
  mode?: 'light' | 'heavy';
  stage?: 'full' | 'compensation';
  allowRemoteProbe?: boolean;
  force?: boolean;
  sessionValidated?: boolean;
  retryProcessing?: 'background' | 'blocking';
  interactionBudgetMs?: number;
  skipSessionValidationWithinMs?: number;
  resumeProbeTimeoutMs?: number;
  backgroundDrainMaxRounds?: number;
  deferBlackBoxPull?: boolean;
  backgroundProbeDelayMs?: number;
  recoveryTicketId?: string;
  skipRetryQueue?: boolean;
  skipRealtimeResume?: boolean;
}

@Injectable({
  providedIn: 'root'
})
export class SimpleSyncService {
  private readonly supabase = inject(SupabaseClientService);
  private readonly injector = inject(Injector);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('SimpleSync');
  private readonly toast = inject(ToastService);
  private readonly throttle = inject(RequestThrottleService);
  private readonly clockSync = inject(ClockSyncService);
  private readonly eventBus = inject(EventBusService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly changeTracker = inject(ChangeTrackerService);
  
  // 子服务注入
  private readonly tombstoneService = inject(TombstoneService);
  private readonly realtimePollingService = inject(RealtimePollingService);
  private readonly sessionManager = inject(SessionManagerService);
  private readonly syncOpHelper = inject(SyncOperationHelperService);
  private readonly userPrefsSync = inject(UserPreferencesSyncService);
  private readonly focusConsoleSync = inject(FocusConsoleSyncService);
  private readonly projectDataService = inject(ProjectDataService);
  private readonly batchSyncService = inject(BatchSyncService);
  private readonly taskSyncOps = inject(TaskSyncOperationsService);
  private readonly connectionSyncOps = inject(ConnectionSyncOperationsService);
  private readonly syncStateService = inject(SyncStateService);
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly retryQueueService = inject(RetryQueueService);
  private readonly blackBoxSync = inject(BlackBoxSyncService);
  private readonly syncCursorPersistence = inject(SyncCursorPersistenceService);
  private readonly syncRpcClient = inject(SyncRpcClientService, { optional: true });
  private readonly projectStore = inject(ProjectStore, { optional: true });
  private readonly connectivityRecovery = inject(ConnectivityRecoveryService);

  private getActionQueue(): ActionQueueService | null {
    return this.injector.get(ActionQueueService, null);
  }
  
  /**
   * 获取 Supabase 客户端
   */
  private async getSupabaseClient(): Promise<SupabaseClient | null> {
    if (!this.supabase.isConfigured) {
      const failure = classifySupabaseClientFailure(false);
      this.syncStateService.setSyncError(failure.message);
      this.logger.warn('无法获取 Supabase 客户端', failure);
      return null;
    }
    if (this.supabase.isOfflineMode()) {
      this.syncStateService.setOfflineMode(true);
      this.logger.debug('Supabase 远端暂不可达，已跳过云端客户端获取');
      return null;
    }
    try {
      return await this.supabase.clientAsync();
    } catch (error) {
      const failure = classifySupabaseClientFailure(true, error);
      this.syncStateService.setSyncError(failure.message);
      this.logger.warn('无法获取 Supabase 客户端', {
        category: failure.category,
        message: failure.message
      });
      this.sentryLazyLoader.captureMessage('Sync client unavailable', {
        level: 'warning',
        tags: {
          operation: 'SimpleSync.getSupabaseClient',
          category: failure.category
        }
      });
      // eslint-disable-next-line no-restricted-syntax -- 需保持历史接口语义，客户端不可用时返回 null 触发离线降级分支
      return null;
    }
  }
  
  /** 同步状态（委托给 SyncStateService 统一管理，解决双源进度不一致问题） */
  readonly syncState = this.syncStateService.syncState;
  
  /** 兼容旧接口 */
  readonly state = this.syncState;
  
  /** 便捷 computed 属性 */
  readonly isOnline = computed(() => this.syncState().isOnline);
  readonly isSyncing = computed(() => this.syncState().isSyncing);
  readonly hasConflict = computed(() => this.syncState().hasConflict);
  readonly isLoadingRemote = signal(false);
  
  /** 最后一次同步时间 */
  private lastSyncTimeByProject: Map<string, string> = new Map();
  private readonly syncCursorByProject: Map<string, ProjectSyncCursor> = new Map();
  /**
   * 项目云端持久化单飞 gate。
   * 恢复窗口里 AutoPersist / RetryQueue / ActionQueue 可能同时推同一项目，这里统一串行并折叠为最新快照。
   */
  private readonly projectSaveFlights = new Map<string, ProjectSaveFlight>();
  
  /** 配置常量 */
  private readonly RETRY_INTERVAL = 5000;
  private readonly OFFLINE_CACHE_KEY = CACHE_CONFIG.OFFLINE_CACHE_KEY;
  /** 恢复 ticket 状态缓存（防止同 ticket 重复 heavy/light） */
  private readonly recoveryTicketState = new Map<
    string,
    { createdAt: number; modes: Set<'light' | 'heavy'>; probeCompleted: boolean }
  >();
  private runtimeStarted = false;
  // 连接恢复状态已迁移到 ConnectivityRecoveryService (2026-05-13)
  private readonly handleOnline = () => {
    this.logger.info('网络恢复');
    this.syncStateService.setOnline(true);
    void this.connectivityRecovery.restoreRemoteConnectivity('online-event');
  };
  private readonly handleOffline = () => {
    this.logger.info('网络断开');
    this.syncStateService.setOnline(false);
    this.syncStateService.setOfflineMode(true);
    void this.realtimePollingService.suspendTransport();
  };
  
  constructor() {
    // 订阅会话恢复事件
    this.eventBus.onSessionRestored$.pipe(
      takeUntilDestroyed(this.destroyRef)
    ).subscribe(() => {
      this.resetSessionExpired();
      void this.realtimePollingService.resetRealtimeCircuit('session-restored');
    });

    // 【2026-04-21 根因修复】注册 lastSyncTime 空闲门禁：
    // 仅当 ActionQueue 与 RetryQueue 均为空时才允许推进"最后同步时间"，
    // 否则单条成功会错误刷出"刚刚"，与仍残留的 86 待同步形成 UI 矛盾。
    this.syncStateService.registerIdleChecker(() => {
      if (this.retryQueueService.length > 0) {
        return false;
      }
      const actionQueue = this.getActionQueue();
      if (actionQueue && actionQueue.queueSize() > 0) {
        return false;
      }
      return true;
    });

    this.syncStateService.registerSyncErrorListener((syncError) => {
      if (syncError) {
        this.retryQueueService.clearSuccessfulDrainFlag?.();
      }
    });

    // 初始化 BatchSyncService 回调
    this.batchSyncService.setCallbacks({
      pushProject: (p, f, sourceUserId, taskIdsToDelete) => this.pushProjectWithResult(p, f, sourceUserId, taskIdsToDelete),
      pushTask: (t, pid, s, f, sourceUserId) => this.pushTaskWithResult(t, pid, s, f, sourceUserId),
      pushTaskPosition: (tid, x, y, pid, fallbackTask, sourceUserId) =>
        this.pushTaskPosition(tid, x, y, pid, fallbackTask, sourceUserId),
      pushConnection: (c, pid, s, te, f, sourceUserId) => this.pushConnectionWithResult(c, pid, s, te, f, sourceUserId),
      getTombstoneIds: (pid) => this.getTombstoneIds(pid),
      getConnectionTombstoneIds: (pid) => this.getConnectionTombstoneIds(pid),
      purgeTasksFromCloud: (pid, tids, sourceUserId) => this.purgeTasksFromCloudWithResult(pid, tids, sourceUserId),
      topologicalSortTasks: (tasks) => this.topologicalSortTasks(tasks),
      addToRetryQueue: (t, o, d, p, sourceUserId, taskIdsToDelete) => this.addToRetryQueue(
        t,
        o,
        d as Task | Project | Connection | { id: string },
        p,
        sourceUserId,
        taskIdsToDelete,
      ),
      addToRetryQueueDurably: (t, o, d, p, sourceUserId, taskIdsToDelete) => this.addToRetryQueueDurably(
        t,
        o,
        d as Task | Project | Connection | { id: string },
        p,
        sourceUserId,
        taskIdsToDelete,
      ),
      confirmRetryQueuePersistence: () => this.confirmRetryQueuePersistence(),
    });
    
    // 设置重试队列操作处理器
    this.retryQueueService.setOperationHandler({
      pushTask: (task, pid, sourceUserId) => this.pushTask(task, pid, false, true, sourceUserId),
      deleteTask: (tid, pid, sourceUserId) => this.deleteTask(tid, pid, sourceUserId, true),
      pushProject: async (project, sourceUserId, taskIdsToDelete) => {
        const actionQueue = this.getActionQueue();
        if (!actionQueue) {
          this.logger.warn('ActionQueueService 不可用，项目重试保持在 RetryQueue 中等待后续回放', {
            projectId: project.id,
            sourceUserId,
            pendingTaskDeleteCount: taskIdsToDelete?.length ?? 0,
          });
          return false;
        }

        if (!sourceUserId) {
          this.logger.warn('项目重试缺少 sourceUserId，拒绝转交 ActionQueue 以避免 owner bucket 错位', {
            projectId: project.id,
            pendingTaskDeleteCount: taskIdsToDelete?.length ?? 0,
          });
          return false;
        }

        const actionId = await actionQueue.enqueueDurablyForOwner(sourceUserId, {
          type: 'update',
          entityType: 'project',
          entityId: project.id,
          payload: {
            project,
            sourceUserId,
            taskIdsToDelete,
          },
        });

        if (!actionId) {
          this.logger.warn('项目重试转交 ActionQueue 失败，保留在 RetryQueue 中等待后续回放', {
            projectId: project.id,
            sourceUserId,
            pendingTaskDeleteCount: taskIdsToDelete?.length ?? 0,
          });
          return false;
        }

        return true;
      },
      // 重试连接时保留 tombstone + 任务存在性校验，避免陈旧连接重放与 23503 外键错误风暴
      pushConnection: (conn, pid, sourceUserId) => this.pushConnection(conn, pid, false, false, true, sourceUserId),
      pushBlackBoxEntry: (entry: BlackBoxEntry, sourceUserId?: string) => {
        if (!sourceUserId) {
          this.logger.warn('BlackBox retry deferred: missing queued owner', {
            entryId: entry.id,
          });
          return Promise.resolve(false);
        }

        if (entry.userId !== sourceUserId) {
          this.logger.warn('BlackBox retry rejected: entry owner mismatch', {
            entryId: entry.id,
            hasSourceUserId: !!sourceUserId,
            hasEntryUserId: !!entry.userId,
          });
          return Promise.resolve(true);
        }
        return this.blackBoxSync.pushToServer(entry, sourceUserId);
      },
      isSessionExpired: () => this.syncState().sessionExpired,
      // 离线模式下返回 false，避免 RetryQueue 尝试处理未配置的 Supabase
      isOnline: () => this.state().isOnline && !this.supabase.isOfflineMode(),
      onProcessingStateChange: (processing, pendingCount) => {
        this.syncStateService.update({ isSyncing: processing, pendingCount });
        // 【2026-04-21 根因修复】只有成功回放后真正见底，才允许收口清理旧错误文案；
        // 永久失败移除、切账号清空视图等都不应误判为“同步已恢复”。
        if (!processing && pendingCount === 0 && this.retryQueueService.hasSuccessfulDrainFlag()) {
          this.markSyncRecoveredIfIdle(nowISO());
        }
      }
    });

    // 将黑匣子同步集成到主同步体系的 RetryQueue
    this.blackBoxSync.setRetryQueueHandler((entry: BlackBoxEntry) => {
      const ownerUserId = entry.userId?.trim();
      if (!ownerUserId) {
        this.logger.warn('BlackBox retry enqueue skipped: missing owner userId', {
          entryId: entry.id,
        });
        return;
      }

      this.retryQueueService.add('blackbox', 'upsert', entry, entry.projectId ?? undefined, ownerUserId);
    });

    const detachConnectivityListener = this.supabase.onConnectivityChange((change) => {
      this.handleSupabaseConnectivityChange(change);
    });

    this.destroyRef.onDestroy(() => {
      detachConnectivityListener();
      this.cleanup();
    });
  }

  startRuntime(): void {
    if (this.runtimeStarted) {
      return;
    }

    this.runtimeStarted = true;
    this.connectivityRecovery.startRuntime();
    this.realtimePollingService.initializeRuntime();
    this.setupNetworkListeners();
    this.retryQueueService.startLoop(this.RETRY_INTERVAL);

    if (this.supabase.isConfigured && this.supabase.isOfflineMode()) {
      this.syncStateService.setOfflineMode(true);
      this.connectivityRecovery.scheduleConnectivityRecovery('runtime-start', SYNC_CONFIG.CONNECTIVITY_PROBE_INTERVAL);
    }
  }

  stopRuntime(): void {
    if (!this.runtimeStarted) {
      return;
    }

    this.runtimeStarted = false;
    this.connectivityRecovery.stopRuntime();
    this.teardownNetworkListeners();
    this.retryQueueService.stopLoop();
    this.realtimePollingService.teardownRuntime();
  }
  
  // ==================== 网络与生命周期 ====================
  
  private setupNetworkListeners(): void {
    if (typeof window === 'undefined') return;

    window.addEventListener('online', this.handleOnline);
    window.addEventListener('offline', this.handleOffline);
  }

  private teardownNetworkListeners(): void {
    if (typeof window === 'undefined') return;

    window.removeEventListener('online', this.handleOnline);
    window.removeEventListener('offline', this.handleOffline);
  }
  
  private cleanup(): void {
    this.stopRuntime();
    this.realtimePollingService.unsubscribeFromProject();
  }

  async suspendRemoteTransport(): Promise<void> {
    await this.realtimePollingService.suspendTransport();
  }

  async restoreRemoteConnectivity(reason: string): Promise<void> {
    await this.connectivityRecovery.restoreRemoteConnectivity(reason);
  }

  private handleSupabaseConnectivityChange(change: SupabaseConnectivityChange): void {
    this.connectivityRecovery.handleSupabaseConnectivityChange(change, this.syncState().isOnline);
  }

  flushRetryQueueSync(): void {
    this.retryQueueService.flushSync();
  }

  /**
   * 页面恢复后的同步自愈流程
   * 顺序：重试队列 -> 远程增量/全量拉取回调 -> 恢复实时更新
   */
  async recoverAfterResume(reason: string, options: ResumeRecoverOptions = {}): Promise<void> {
    const startedAt = Date.now();
    const mode = options.mode ?? 'heavy';
    const stage = options.stage ?? 'full';
    const interactionFirstEnabled = FEATURE_FLAGS.RESUME_INTERACTION_FIRST_V1 || options.force === true;
    const allowRemoteProbe = options.allowRemoteProbe ?? mode === 'heavy';
    const force = options.force === true;
    const retryProcessing = options.retryProcessing ?? 'background';
    const skipRetryQueue = options.skipRetryQueue ?? stage === 'compensation';
    const skipRealtimeResume = options.skipRealtimeResume ?? stage === 'compensation';
    const recoveryTicketId = options.recoveryTicketId?.trim() || null;
    const recoveryTicketDedupEnabled = FEATURE_FLAGS.RECOVERY_TICKET_DEDUP_V1;
    const deferBlackBoxPull = options.deferBlackBoxPull ?? true;
    const interactionBudgetMs = Math.max(
      80,
      options.interactionBudgetMs ?? APP_LIFECYCLE_CONFIG.RESUME_INTERACTION_BUDGET_MS
    );
    const skipSessionValidationWithinMs = Math.max(
      0,
      options.skipSessionValidationWithinMs ?? (FEATURE_FLAGS.RESUME_SESSION_SNAPSHOT_V1 ? 10_000 : 0)
    );
    const resumeProbeTimeoutMs = Math.max(200, options.resumeProbeTimeoutMs ?? 1500);
    const backgroundProbeDelayMs = Math.max(0, options.backgroundProbeDelayMs ?? 150);
    const backgroundDrainMaxRounds = Math.max(1, options.backgroundDrainMaxRounds ?? 5);
    const onlineNow = typeof navigator !== 'undefined' ? navigator.onLine : this.state().isOnline;
    this.syncStateService.update({ isOnline: onlineNow });

    this.cleanupRecoveryTicketState(startedAt);
    let ticketState: { createdAt: number; modes: Set<'light' | 'heavy'>; probeCompleted: boolean } | null = null;
    let duplicateModeInSameTicket = false;
    if (recoveryTicketId && recoveryTicketDedupEnabled) {
      ticketState = this.recoveryTicketState.get(recoveryTicketId) ?? {
        createdAt: startedAt,
        modes: new Set<'light' | 'heavy'>(),
        probeCompleted: false,
      };
      duplicateModeInSameTicket = ticketState.modes.has(mode);
      this.recoveryTicketState.set(recoveryTicketId, ticketState);
    }

    this.sentryLazyLoader.addBreadcrumb({
      category: 'lifecycle',
      message: 'recovery.step',
      level: 'info',
      data: {
        step: 'sync-recovery-start',
        reason,
        mode,
        stage,
        isOnline: onlineNow,
        interactionFirstEnabled,
        recoveryTicketId,
        deferBlackBoxPull,
        skipRetryQueue,
        skipRealtimeResume
      }
    });

    if (!onlineNow && !force) {
      this.logger.info('页面恢复时处于离线状态，跳过恢复同步', { reason });
      return;
    }

    let session: { valid: boolean; userId?: string; deferred?: boolean; reason?: 'client-unready' } | null = null;
    if (options.sessionValidated !== true) {
      if (skipSessionValidationWithinMs > 0) {
        const snapshot = this.sessionManager.getRecentValidationSnapshot(skipSessionValidationWithinMs);
        if (snapshot?.valid) {
          session = { valid: true, userId: snapshot.userId };
        }
      }

      // light/heavy 都执行会话校验，确保恢复链路在无效会话下快速退出
      session = session ?? await this.sessionManager.validateSession();
      if (session.deferred) {
        const delayMs = Math.max(100, getRemainingBrowserNetworkResumeDelayMs() + 50);
        this.connectivityRecovery.scheduleConnectivityRecovery(`${reason}:session-deferred`, delayMs);
        this.logger.info('页面恢复时会话校验延后，跳过本轮远端恢复链路', {
          reason,
          mode,
          delayMs,
          deferredReason: session.reason ?? 'client-unready',
        });
        return;
      }

      if (!session.valid && !force) {
        this.logger.info('页面恢复时会话无效，跳过远端恢复链路', { reason, mode });
        return;
      }
    }

    this.connectivityRecovery.cancelScheduledRecovery();

    const remoteReady = await this.connectivityRecovery.probeRemoteReachability(
      reason,
      Math.max(SYNC_CONFIG.CONNECTIVITY_PROBE_TIMEOUT, resumeProbeTimeoutMs),
      true
    );
    if (!remoteReady) {
      this.connectivityRecovery.scheduleConnectivityRecovery(reason);
      return;
    }

    // 1) 先处理离线积压队列
    if (!skipRetryQueue && this.retryQueueService.length > 0) {
      const retrySlice = Math.max(1, APP_LIFECYCLE_CONFIG.RESUME_RETRY_SLICE_MAX_ITEMS);
      this.sentryLazyLoader.addBreadcrumb({
        category: 'lifecycle',
        message: 'recovery.step',
        level: 'info',
        data: {
          step: 'retry-queue-process',
          reason,
          mode,
          stage,
          pendingCount: this.retryQueueService.length,
          retrySlice,
          retryProcessing,
          interactionBudgetMs
        }
      });

      if (retryProcessing === 'blocking') {
        await this.retryQueueService.processQueueSlice({
          maxItems: retrySlice,
          maxDurationMs: interactionBudgetMs
        });
      } else {
        const firstSlice = await this.retryQueueService.processQueueSlice({
          maxItems: retrySlice,
          maxDurationMs: interactionBudgetMs
        });
        if (!firstSlice.completed) {
          this.scheduleRetryQueueContinuation(
            reason,
            mode,
            retrySlice,
            interactionBudgetMs,
            backgroundDrainMaxRounds
          );
        }
      }
    }

    // 2) 恢复实时更新状态（若之前被暂停），并在 heavy 下探测远端变更
    if (!skipRealtimeResume) {
      await this.realtimePollingService.resumeTransport();
      this.realtimePollingService.resumeRealtimeUpdates();
    }

    if (duplicateModeInSameTicket) {
      this.sentryLazyLoader.addBreadcrumb({
        category: 'lifecycle',
        message: 'recovery.step',
        level: 'info',
        data: {
          step: 'ticket-duplicate-mode-skipped',
          reason,
          mode,
          stage,
          recoveryTicketId,
        }
      });
      this.logger.debug('同一 recovery ticket 重复恢复已跳过主流程', { reason, mode, stage, recoveryTicketId });
    }

    if (ticketState && !duplicateModeInSameTicket) {
      ticketState.modes.add(mode);
    }

    // light 模式只做本地状态恢复，不触发远端探测
    if (mode === 'heavy' && allowRemoteProbe && !duplicateModeInSameTicket && !(ticketState?.probeCompleted)) {
      const currentProjectId = this.realtimePollingService.getCurrentProjectId();
      const payload = {
        eventType: 'resume',
        projectId: currentProjectId ?? undefined
      };
      const firstProbe = await this.triggerRemoteProbeWithTimeout(payload, resumeProbeTimeoutMs);
      let triggered = firstProbe.triggered;
      const hasCallback = this.realtimePollingService.hasRemoteChangeCallback();

      if (!triggered && hasCallback && !firstProbe.timedOut) {
        this.sentryLazyLoader.addBreadcrumb({
          category: 'lifecycle',
          message: 'recovery.step',
          level: 'info',
          data: { step: 'remote-probe-retry', reason, mode }
        });
        const retryProbe = await this.triggerRemoteProbeWithTimeout(payload, resumeProbeTimeoutMs);
        triggered = retryProbe.triggered;
      }

      if (!triggered && firstProbe.timedOut && hasCallback) {
        setTimeout(() => {
          void this.realtimePollingService.triggerRemoteChange(payload);
        }, backgroundProbeDelayMs);
        this.sentryLazyLoader.addBreadcrumb({
          category: 'lifecycle',
          message: 'recovery.step',
          level: 'info',
          data: {
            step: 'remote-probe-timeout-background-fallback',
            reason,
            mode,
            stage,
            recoveryTicketId,
            backgroundProbeDelayMs
          }
        });
      }

      // 3) 灰度开关关闭时保留旧兜底；开启后禁止全量 loadProjectsFromCloud
      if (!triggered) {
        if (!interactionFirstEnabled) {
          this.sentryLazyLoader.addBreadcrumb({
            category: 'lifecycle',
            message: 'recovery.step',
            level: 'info',
            data: { step: 'fallback-cloud-load', reason, mode }
          });

          const fallbackSession = session ?? await this.sessionManager.validateSession();
          if (fallbackSession.valid && fallbackSession.userId) {
            await this.loadProjectsFromCloud(fallbackSession.userId, true);
          }
        } else if (!hasCallback) {
          this.sentryLazyLoader.addBreadcrumb({
            category: 'lifecycle',
            message: 'recovery.step',
            level: 'info',
            data: {
              step: 'skip-fallback-no-callback',
              reason,
              mode,
              stage
            }
          });
          this.logger.info('恢复链路未注册远端回调，已跳过全量云端加载兜底', { reason, mode });
        }
      }

      if (ticketState) {
        ticketState.probeCompleted = triggered || firstProbe.timedOut;
      }
    } else if (mode === 'heavy' && ticketState?.probeCompleted) {
      this.sentryLazyLoader.addBreadcrumb({
        category: 'lifecycle',
        message: 'recovery.step',
        level: 'info',
        data: {
          step: 'remote-probe-skipped-ticket-probed',
          reason,
          mode,
          stage,
          recoveryTicketId
        }
      });
    }

    this.sentryLazyLoader.addBreadcrumb({
      category: 'lifecycle',
      message: 'recovery.step',
      level: 'info',
      data: {
        step: 'sync-recovery-complete',
        reason,
        mode,
        stage,
        elapsedMs: Date.now() - startedAt
      }
    });
  }

  private cleanupRecoveryTicketState(nowMs: number): void {
    if (this.recoveryTicketState.size === 0) {
      return;
    }

    const ttlMs = APP_LIFECYCLE_CONFIG.RESUME_HEAVY_COOLDOWN_MS * 4;
    const expiredTicketIds: string[] = [];
    this.recoveryTicketState.forEach((state, ticketId) => {
      if (nowMs - state.createdAt > ttlMs) {
        expiredTicketIds.push(ticketId);
      }
    });
    expiredTicketIds.forEach(ticketId => {
      this.recoveryTicketState.delete(ticketId);
    });
  }

  private scheduleRetryQueueContinuation(
    reason: string,
    mode: 'light' | 'heavy',
    retrySlice: number,
    maxDurationMs: number,
    maxRounds: number,
    round = 1
  ): void {
    if (round > maxRounds) {
      this.sentryLazyLoader.addBreadcrumb({
        category: 'lifecycle',
        message: 'recovery.step',
        level: 'warning',
        data: {
          step: 'retry-queue-background-drain-max-rounds',
          reason,
          mode,
          maxRounds
        }
      });
      return;
    }

    const backoffDelaysMs = [200, 500, 1000, 1000, 1000];
    const backoffMs = backoffDelaysMs[Math.min(round - 1, backoffDelaysMs.length - 1)];
    const runSlice = () => {
      void this.retryQueueService.processQueueSlice({
        maxItems: retrySlice,
        maxDurationMs
      }).then((result) => {
        if (!result.completed && result.remaining > 0) {
          this.scheduleRetryQueueContinuation(reason, mode, retrySlice, maxDurationMs, maxRounds, round + 1);
          return;
        }

        this.sentryLazyLoader.addBreadcrumb({
          category: 'lifecycle',
          message: 'recovery.step',
          level: 'info',
          data: {
            step: 'retry-queue-background-drain',
            reason,
            mode,
            remaining: result.remaining,
            processed: result.processed,
            durationMs: result.durationMs,
            round
          }
        });
      }).catch((error) => {
        this.logger.warn('恢复链路后台重试切片失败', { reason, mode, error });
        this.scheduleRetryQueueContinuation(reason, mode, retrySlice, maxDurationMs, maxRounds, round + 1);
      });
    };

    if (typeof window !== 'undefined' && typeof (window as Window & { requestIdleCallback?: unknown }).requestIdleCallback === 'function') {
      (
        window as Window & {
          requestIdleCallback: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
        }
      ).requestIdleCallback(() => runSlice(), { timeout: backoffMs });
      return;
    }
    setTimeout(runSlice, backoffMs);
  }

  private async triggerRemoteProbeWithTimeout(
    payload: { eventType?: string; projectId?: string },
    timeoutMs: number
  ): Promise<{ triggered: boolean; timedOut: boolean }> {
    try {
      const result = await Promise.race([
        this.realtimePollingService.triggerRemoteChange(payload).then(triggered => ({
          triggered,
          timedOut: false
        })),
        new Promise<{ triggered: false; timedOut: true }>((resolve) =>
          setTimeout(() => resolve({ triggered: false, timedOut: true }), timeoutMs)
        )
      ]);
      return result;
    } catch {
      return { triggered: false, timedOut: false };
    }
  }
  
  // ==================== 任务同步（委托） ====================
  
  async pushTask(
    task: Task,
    projectId: string,
    skipTombstoneCheck = false,
    fromRetryQueue = false,
    sourceUserId?: string,
    treatTombstoneAsPermanent = false,
  ): Promise<boolean> {
    return this.taskSyncOps.pushTask(
      task,
      projectId,
      skipTombstoneCheck,
      fromRetryQueue,
      sourceUserId,
      treatTombstoneAsPermanent,
    );
  }
  
  async pushTaskPosition(
    taskId: string,
    x: number,
    y: number,
    projectId?: string,
    fallbackTask?: Task,
    sourceUserId?: string,
  ): Promise<boolean> {
    return this.taskSyncOps.pushTaskPosition(taskId, x, y, projectId, fallbackTask, sourceUserId);
  }
  
  async pullTasks(projectId: string, since?: string): Promise<Task[]> {
    return this.taskSyncOps.pullTasks(projectId, since);
  }
  
  async deleteTask(taskId: string, projectId: string, sourceUserId?: string, fromRetryQueue = false): Promise<boolean> {
    return this.taskSyncOps.deleteTask(taskId, projectId, sourceUserId, fromRetryQueue);
  }
  
  async softDeleteTasksBatch(
    projectId: string,
    taskIds: string[],
    tombstoneTimestamps?: Record<string, string | number | null | undefined>,
  ): Promise<number> {
    return this.taskSyncOps.softDeleteTasksBatch(projectId, taskIds, tombstoneTimestamps);
  }
  
  async purgeTasksFromCloud(projectId: string, taskIds: string[], sourceUserId?: string): Promise<boolean> {
    return this.taskSyncOps.purgeTasksFromCloud(projectId, taskIds, sourceUserId);
  }
  
  async getTombstoneIds(projectId: string): Promise<Set<string>> {
    return this.taskSyncOps.getTombstoneIds(projectId);
  }
  
  async getTombstoneIdsWithStatus(projectId: string): Promise<{ ids: Set<string>; fromRemote: boolean; localCacheOnly: boolean; timestamp: number }> {
    return this.taskSyncOps.getTombstoneIdsWithStatus(projectId);
  }
  
  getLocalTombstones(projectId: string): Set<string> {
    return this.taskSyncOps.getLocalTombstones(projectId);
  }
  
  addLocalTombstones(
    projectId: string,
    taskIds: string[],
    timestampsByTaskId?: Record<string, string | number | null | undefined>,
  ): void {
    this.taskSyncOps.addLocalTombstones(projectId, taskIds, timestampsByTaskId);
  }
  
  private topologicalSortTasks(tasks: Task[]): Task[] {
    return this.taskSyncOps.topologicalSortTasks(tasks);
  }
  
  invalidateTombstoneCache(projectId: string): void {
    this.tombstoneService.invalidateCache(projectId);
  }
  
  // ==================== 连接同步（委托） ====================
  
  async pushConnection(
    connection: Connection,
    projectId: string,
    skipTombstoneCheck = false,
    skipTaskExistenceCheck = false,
    fromRetryQueue = false,
    sourceUserId?: string,
  ): Promise<boolean> {
    return this.connectionSyncOps.pushConnection(
      connection,
      projectId,
      skipTombstoneCheck,
      skipTaskExistenceCheck,
      fromRetryQueue,
      sourceUserId,
    );
  }
  
  async getConnectionTombstoneIds(projectId: string): Promise<Set<string>> {
    return this.connectionSyncOps.getConnectionTombstoneIds(projectId);
  }

  private async pushTaskWithResult(
    task: Task,
    projectId: string,
    skipTombstoneCheck = false,
    fromRetryQueue = false,
    sourceUserId?: string,
  ): Promise<{ success: boolean; retryEnqueued?: boolean }> {
    const success = await this.pushTask(task, projectId, skipTombstoneCheck, fromRetryQueue, sourceUserId);
    return {
      success,
      retryEnqueued: !success && this.hasRetryQueueEntity('task', task.id),
    };
  }

  private async pushConnectionWithResult(
    connection: Connection,
    projectId: string,
    skipTombstoneCheck = false,
    skipTaskExistenceCheck = false,
    fromRetryQueue = false,
    sourceUserId?: string,
  ): Promise<{ success: boolean; retryEnqueued?: boolean }> {
    const success = await this.pushConnection(
      connection,
      projectId,
      skipTombstoneCheck,
      skipTaskExistenceCheck,
      fromRetryQueue,
      sourceUserId,
    );
    return {
      success,
      retryEnqueued: !success && this.hasRetryQueueEntity('connection', connection.id),
    };
  }

  private async purgeTasksFromCloudWithResult(
    projectId: string,
    taskIds: string[],
    sourceUserId?: string,
  ): Promise<{ success: boolean; retriedTaskIds?: string[] }> {
    const success = await this.purgeTasksFromCloud(projectId, taskIds, sourceUserId);
    if (success) {
      return { success: true, retriedTaskIds: [] };
    }

    return {
      success: false,
      retriedTaskIds: taskIds.filter(taskId =>
        this.hasRetryQueueEntity('task', taskId)
      ),
    };
  }

  /** 批量预热所有项目的 tombstone 缓存（单次 RPC 替代 N 次查询） */
  async batchPreloadTombstones(projectIds: string[]): Promise<boolean> {
    const client = await this.getSupabaseClient();
    if (!client) return false;
    return this.tombstoneService.batchPreloadTombstones(projectIds, client);
  }
  
  // ==================== 项目同步 ====================
  
  async pushProject(
    project: Project,
    fromRetryQueue = false,
    sourceUserId?: string,
    taskIdsToDelete?: string[],
  ): Promise<boolean> {
    const result = await this.pushProjectWithStatus(project, fromRetryQueue, sourceUserId, taskIdsToDelete);
    return result.success;
  }

  private async pushProjectWithStatus(
    project: Project,
    fromRetryQueue = false,
    sourceUserId?: string,
    taskIdsToDelete?: string[],
  ): Promise<{ success: boolean; retryEnqueued: boolean; failureReason?: string }> {
    let retryEnqueued = false;

    const enqueueRetry = async (): Promise<boolean> => {
      if (fromRetryQueue) {
        return false;
      }

      retryEnqueued = await this.addToRetryQueueDurably('project', 'upsert', project, undefined, sourceUserId, taskIdsToDelete);
      return retryEnqueued;
    };

    if (this.syncState().sessionExpired) {
      this.sessionManager.handleSessionExpired('pushProject', { projectId: project.id });
      return {
        success: false,
        retryEnqueued,
        failureReason: 'project sync session expired',
      };
    }
    
    const client = await this.getSupabaseClient();
    if (!client) {
      await enqueueRetry();
      return {
        success: false,
        retryEnqueued,
        failureReason: 'supabase client unavailable for project sync',
      };
    }
    
    // 【#95057880 修复】支持自动刷新后重试的内部执行函数（与 pushTask 对齐）
    const executeProjectPush = async (): Promise<boolean> => {
      const { data: { session } } = await client.auth.getSession();
      let sessionUserId = session?.user?.id ?? null;
      if (!sessionUserId) {
        // 先尝试刷新会话，而非立即标记永久失败
        const refreshed = await this.sessionManager.tryRefreshSession('pushProject.getSession');
        if (refreshed) {
          const { data: { session: newSession } } = await client.auth.getSession();
          sessionUserId = newSession?.user?.id ?? null;
        }
      }

      if (!sessionUserId) {
        await enqueueRetry();
        this.sessionManager.handleSessionExpired('pushProject.getSession', { projectId: project.id });
        return false;
      }

      if (sourceUserId && sessionUserId !== sourceUserId) {
        this.logger.warn('检测到项目重试归属与当前会话不匹配，已拒绝云端写入', {
          projectId: project.id,
          sourceUserId,
          sessionUserId,
        });
        await enqueueRetry();
        return false;
      }

      return await this.doProjectPush(
        client,
        project,
        sourceUserId ?? sessionUserId,
        fromRetryQueue,
        enqueueRetry,
        sourceUserId,
        taskIdsToDelete,
      );
    };
    
    try {
      const success = await this.throttle.execute(
        `push-project:${project.id}`,
        executeProjectPush,
        { priority: 'high', retries: 2 }
      );
      return {
        success,
        retryEnqueued,
        failureReason: success
          ? undefined
          : (retryEnqueued ? 'project sync queued for retry' : 'project push returned false'),
      };
    } catch (e) {
      // 【#95057880 修复】PermanentFailureError 直接向上冒泡，不做二次处理
      if (isPermanentFailureError(e)) {
        throw e;
      }
      
      const enhanced = e && typeof e === 'object' && 'errorType' in e
        ? e as EnhancedError
        : supabaseErrorToError(e);
      
      // 【#95057880 修复】检测到认证错误时先尝试刷新 session（与 pushTask 对齐）
      if (this.sessionManager.isSessionExpiredError(enhanced)) {
        const canRetry = await this.sessionManager.handleAuthErrorWithRefresh('pushProject', {
          projectId: project.id,
          errorCode: enhanced.code
        });
        if (canRetry) {
          try {
            const success = await executeProjectPush();
            return {
              success,
              retryEnqueued,
              failureReason: success
                ? undefined
                : (retryEnqueued ? 'project sync queued for retry after session refresh' : 'project push returned false after session refresh'),
            };
          } catch (retryError) {
            if (isPermanentFailureError(retryError)) throw retryError;
            const retryEnhanced = retryError && typeof retryError === 'object' && 'errorType' in retryError
              ? retryError as EnhancedError
              : supabaseErrorToError(retryError);
            if (this.sessionManager.isSessionExpiredError(retryEnhanced)) {
              // 会话刷新成功后重试仍然失败
              if (this.sessionManager.isRlsPolicyViolation(retryEnhanced)) {
                // 42501: RLS 策略违规，真正的权限不足，非会话过期
                this.logger.warn('刷新会话后重试仍获 RLS 违规，判定为权限不足', {
                  projectId: project.id,
                  errorCode: retryEnhanced.code,
                });
                throw this.createProjectPersistenceTerminalError(
                  project.id,
                  '项目同步权限校验失败，请重新登录后重试',
                  'PermissionError',
                  'SYNC_PROJECT_PERMISSION_DENIED',
                );
              }
              await enqueueRetry();
              this.sessionManager.handleSessionExpired('pushProject.retryAfterRefresh', {
                projectId: project.id,
                errorCode: retryEnhanced.code
              });
              return {
                success: false,
                retryEnqueued,
                failureReason: 'project sync session expired after refresh',
              };
            }

            if (retryEnhanced.errorType === 'VersionConflictError') {
              this.toast.warning('版本冲突', '数据已被修改，请刷新后重试');
              throw new PermanentFailureError('Version conflict', retryEnhanced, { operation: 'pushProject', projectId: project.id });
            }

            if (retryEnhanced.isRetryable) {
              await enqueueRetry();
              return {
                success: false,
                retryEnqueued,
                failureReason: retryEnhanced.message,
              };
            }

            const isPermissionDenied = retryEnhanced.errorType === 'PermissionError';
            const terminalMessage = isPermissionDenied
              ? '项目同步权限校验失败，请重新登录后重试'
              : retryEnhanced.message;
            const terminalErrorType = isPermissionDenied ? 'PermissionError' : 'BusinessRuleError';
            const terminalCode = isPermissionDenied
              ? 'SYNC_PROJECT_PERMISSION_DENIED'
              : (retryEnhanced.code ? String(retryEnhanced.code) : 'SYNC_PROJECT_PERSISTENCE_FAILED');
            throw this.createProjectPersistenceTerminalError(
              project.id,
              terminalMessage,
              terminalErrorType,
              terminalCode,
            );
          }
        } else {
          await enqueueRetry();
          this.sessionManager.handleSessionExpired('pushProject', { projectId: project.id, errorCode: enhanced.code });
          return {
            success: false,
            retryEnqueued,
            failureReason: 'project sync session expired',
          };
        }
      }
      
      if (enhanced.errorType === 'VersionConflictError') {
        this.toast.warning('版本冲突', '数据已被修改，请刷新后重试');
        throw new PermanentFailureError('Version conflict', enhanced, { operation: 'pushProject', projectId: project.id });
      }
      
      if (enhanced.isRetryable) {
        await enqueueRetry();
      } else {
        const isPermissionDenied = enhanced.errorType === 'PermissionError';
        throw this.createProjectPersistenceTerminalError(
          project.id,
          isPermissionDenied ? '项目同步权限校验失败，请重新登录后重试' : enhanced.message,
          isPermissionDenied ? 'PermissionError' : 'BusinessRuleError',
          isPermissionDenied
            ? 'SYNC_PROJECT_PERMISSION_DENIED'
            : (enhanced.code ? String(enhanced.code) : 'SYNC_PROJECT_PERSISTENCE_FAILED'),
        );
      }
      return {
        success: false,
        retryEnqueued,
        failureReason: enhanced.message,
      };
    }
  }

  private shouldUseSyncRpc(): boolean {
    return this.syncRpcClient?.isFeatureEnabled() === true && this.syncRpcClient.isClientRejected() === false;
  }

  private async primeProjectSyncRpcCapability(): Promise<void> {
    if (!this.syncRpcClient) {
      return;
    }

    if (this.shouldUseSyncRpc() || this.syncRpcClient.isClientRejected() === true) {
      return;
    }

    await this.syncRpcClient.checkProtocol();
  }

  private throwProjectSyncRpcClientRejected(projectId: string): never {
    const message = '当前客户端同步协议已过期，请刷新后重试';
    const result: SyncRpcResult = {
      status: 'client-version-rejected',
      raw: null,
    };

    this.syncStateService.setSyncError(message);
    this.sentryLazyLoader.captureMessage('sync_rpc_project_rejected', {
      level: 'warning',
      tags: { operation: 'pushProject', entityType: 'project', status: result.status },
      extra: { projectId },
    });

    throw this.createProjectRpcTerminalError(projectId, result, message);
  }

  private buildProjectDeleteClientRejectedFailure(
    projectId: string,
    userId: string,
  ): Result<void, OperationError> {
    const message = '当前客户端同步协议已过期，请刷新后重试';

    this.syncStateService.setSyncError(message);
    this.sentryLazyLoader.captureMessage('sync_rpc_project_delete_rejected', {
      level: 'warning',
      tags: { operation: 'deleteProjectFromCloud', entityType: 'project', status: 'client-version-rejected' },
      extra: { projectId },
    });

    return failure(ErrorCodes.OPERATION_FAILED, message, {
      projectId,
      userId,
      retryable: false,
      reason: 'client_version_rejected',
    });
  }

  private createSyncRpcOperationId(): string {
    return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  private normalizeLocalProjectUpdatedAt(project: Project, serverUpdatedAt?: string | null): void {
    if (!serverUpdatedAt) return;

    const currentProject = this.projectStore?.getProject(project.id);
    if (currentProject && currentProject.updatedAt !== serverUpdatedAt) {
      this.projectStore?.setProject({
        ...currentProject,
        updatedAt: serverUpdatedAt,
      });
    }

    project.updatedAt = serverUpdatedAt;
    this.clockSync.recordServerTimestamp(serverUpdatedAt, project.id);
  }

  private createProjectDirectConflictError(
    projectId: string,
    remoteUpdatedAt: string | null,
    reason: 'remote-newer' | 'remote-tombstone',
  ): Error {
    return Object.assign(
      new Error('版本冲突：数据已被修改，请刷新后重试'),
      {
        name: 'VersionConflictError',
        errorType: 'VersionConflictError',
        code: reason === 'remote-tombstone' ? 'PROJECT_REMOTE_TOMBSTONE_NEWER' : 'PROJECT_REMOTE_NEWER',
        isRetryable: false,
        details: `projectId=${projectId}, remoteUpdatedAt=${remoteUpdatedAt ?? 'unknown'}`,
      },
    );
  }

  private createProjectClockUncertainError(
    projectId: string,
    localUpdatedAt: string | null,
    remoteUpdatedAt: string | null,
  ): Error {
    return Object.assign(
      new Error('无法确认本地时间基线，已延后同步以避免覆盖远端更新'),
      {
        name: 'ClockSyncUncertainError',
        errorType: 'ClockSyncUncertainError',
        code: 'PROJECT_CLOCK_SYNC_UNCERTAIN',
        isRetryable: true,
        details: `projectId=${projectId}, localUpdatedAt=${localUpdatedAt ?? 'unknown'}, remoteUpdatedAt=${remoteUpdatedAt ?? 'unknown'}`,
      },
    );
  }

  private async loadRemoteProjectFreshness(
    client: SupabaseClient,
    projectId: string,
    userId: string,
  ): Promise<{ updatedAt: string | null; deletedAt: string | null } | null> {
    const { data, error } = await client
      .from('projects')
      .select('id,updated_at,deleted_at')
      .eq('id', projectId)
      .eq('owner_id', userId)
      .maybeSingle();

    if (error) {
      throw supabaseErrorToError(error);
    }

    if (!data) {
      return null;
    }

    const row = data as { updated_at?: string | null; deleted_at?: string | null };
    return {
      updatedAt: typeof row.updated_at === 'string' ? row.updated_at : null,
      deletedAt: typeof row.deleted_at === 'string' ? row.deleted_at : null,
    };
  }

  private createProjectRpcConflictError(
    projectId: string,
    result: SyncRpcResult,
  ): PermanentFailureError {
    const originalError = Object.assign(
      new Error('版本冲突：数据已被修改，请刷新后重试'),
      {
        name: 'VersionConflictError',
        errorType: 'VersionConflictError',
        code: 'SYNC_RPC_REMOTE_NEWER',
      },
    );

    return new PermanentFailureError('Version conflict', originalError, {
      operation: 'pushProject',
      projectId,
      status: result.status,
      remoteUpdatedAt: result.remoteUpdatedAt,
      reason: result.reason,
    });
  }

  private createProjectRpcTerminalError(
    projectId: string,
    result: SyncRpcResult,
    message: string,
  ): PermanentFailureError {
    const isPermissionDenied = result.status === 'unauthorized';
    const originalError = Object.assign(
      new Error(message),
      {
        name: isPermissionDenied ? 'PermissionError' : 'BusinessRuleError',
        errorType: isPermissionDenied ? 'PermissionError' : 'BusinessRuleError',
        code: isPermissionDenied ? 'SYNC_RPC_UNAUTHORIZED' : 'SYNC_RPC_PROTOCOL_REJECTED',
      },
    );

    return new PermanentFailureError(
      isPermissionDenied ? 'Project sync unauthorized' : 'Project sync protocol rejected',
      originalError,
      {
        operation: 'pushProject',
        projectId,
        status: result.status,
        reason: result.reason,
        minProtocolVersion: result.minProtocolVersion,
      },
    );
  }

  private createProjectPersistenceTerminalError(
    projectId: string,
    message: string,
    errorType: 'PermissionError' | 'BusinessRuleError' = 'BusinessRuleError',
    code = 'SYNC_PROJECT_PERSISTENCE_FAILED',
  ): PermanentFailureError {
    const originalError = Object.assign(
      new Error(message),
      {
        name: errorType,
        errorType,
        code,
      },
    );

    return new PermanentFailureError('Project sync terminal failure', originalError, {
      operation: 'pushProject',
      projectId,
      code,
    });
  }

  private async handleProjectSyncRpcResult(
    result: SyncRpcResult,
    project: Project,
    fromRetryQueue: boolean,
    enqueueRetry: (() => Promise<boolean>) | undefined,
    sourceUserId: string | undefined,
    taskIdsToDelete: string[] | undefined,
  ): Promise<boolean> {
    if (result.status === 'applied' || result.status === 'idempotent-replay') {
      this.normalizeLocalProjectUpdatedAt(project, result.serverUpdatedAt);
      this.logger.debug('pushProject: sync RPC 写入成功', {
        projectId: project.id,
        status: result.status,
      });
      return true;
    }

    if (result.status === 'remote-newer' || result.status === 'deleted-remote-newer') {
      this.logger.warn('pushProject: sync RPC CAS 拒绝，远端版本更新', {
        projectId: project.id,
        status: result.status,
        remoteUpdatedAt: result.remoteUpdatedAt,
        reason: result.reason,
      });
      this.sentryLazyLoader.captureMessage('sync_rpc_project_remote_newer', {
        level: 'warning',
        tags: { operation: 'pushProject', entityType: 'project', status: result.status },
        extra: { projectId: project.id, remoteUpdatedAt: result.remoteUpdatedAt, reason: result.reason },
      });
      this.toast.warning('版本冲突', '数据已被修改，请刷新后重试');
      throw this.createProjectRpcConflictError(project.id, result);
    }

    if (result.status === 'unauthorized' && result.reason === 'supabase_client_unavailable') {
      this.logger.warn('pushProject: sync RPC client 不可用，回退重试队列', {
        projectId: project.id,
        reason: result.reason,
      });
      if (!fromRetryQueue) {
        if (enqueueRetry) {
          await enqueueRetry();
        } else {
          await this.addToRetryQueueDurably('project', 'upsert', project, undefined, sourceUserId, taskIdsToDelete);
        }
      }
      return false;
    }

    const message = result.status === 'client-version-rejected'
      ? '当前客户端同步协议已过期，请刷新后重试'
      : '项目同步权限校验失败，请重新登录后重试';
    this.syncStateService.setSyncError(message);
    this.sentryLazyLoader.captureMessage('sync_rpc_project_rejected', {
      level: 'warning',
      tags: { operation: 'pushProject', entityType: 'project', status: result.status },
      extra: { projectId: project.id, reason: result.reason, minProtocolVersion: result.minProtocolVersion },
    });
    throw this.createProjectRpcTerminalError(project.id, result, message);
  }

  private async confirmRetryQueuePersistence(): Promise<boolean> {
    return this.retryQueueService.persistNow();
  }

  private async pushProjectWithResult(
    project: Project,
    fromRetryQueue = false,
    sourceUserId?: string,
    taskIdsToDelete?: string[],
  ): Promise<{ success: boolean; conflict?: boolean; remoteData?: Project; retryEnqueued?: boolean; failureReason?: string; terminal?: boolean }> {
    try {
      const result = await this.pushProjectWithStatus(project, fromRetryQueue, sourceUserId, taskIdsToDelete);
      return {
        success: result.success,
        retryEnqueued: result.retryEnqueued,
        failureReason: result.failureReason,
      };
    } catch (error) {
      if (!isPermanentFailureError(error)) {
        throw error;
      }

      const enhanced = error.originalError
        ? supabaseErrorToError(error.originalError)
        : null;
      if (enhanced?.errorType === 'VersionConflictError') {
        const remoteData = await this.loadFullProjectOptimized(project.id).catch(() => null);
        return {
          success: false,
          conflict: true,
          remoteData: remoteData ?? undefined,
          retryEnqueued: false,
          failureReason: 'project sync version conflict',
        };
      }

      return {
        success: false,
        retryEnqueued: false,
        failureReason: enhanced?.message ?? error.message,
        terminal: true,
      };
    }
  }
  
  /**
   * 执行项目 upsert 操作（内部方法，由 pushProject 调用）
   */
  private async doProjectPush(
    client: SupabaseClient,
    project: Project,
    userId: string,
    fromRetryQueue = false,
    enqueueRetry?: () => Promise<boolean>,
    sourceUserId?: string,
    taskIdsToDelete?: string[],
  ): Promise<boolean> {
    await this.primeProjectSyncRpcCapability();

    if (this.syncRpcClient?.isClientRejected() === true) {
      this.throwProjectSyncRpcClientRejected(project.id);
    }

    if (this.shouldUseSyncRpc()) {
      const result = await this.syncRpcClient!.upsertProject({
        operationId: this.createSyncRpcOperationId(),
        project,
        ownerId: userId,
        baseUpdatedAt: project.updatedAt ?? null,
      });

      return await this.handleProjectSyncRpcResult(
        result,
        project,
        fromRetryQueue,
        enqueueRetry,
        sourceUserId,
        taskIdsToDelete,
      );
    }

    const remoteProject = await this.loadRemoteProjectFreshness(client, project.id, userId);
    const remoteHasTombstone = !!(remoteProject?.deletedAt && !project.deletedAt);
    const remoteUpdatedAt = remoteProject?.updatedAt ?? null;
    const localUpdatedAt = project.updatedAt ?? null;
    const rawRemoteMs = remoteUpdatedAt ? new Date(remoteUpdatedAt).getTime() : Number.NaN;
    const rawLocalMs = localUpdatedAt ? new Date(localUpdatedAt).getTime() : Number.NaN;
    const timestampsDiffer = Number.isFinite(rawRemoteMs)
      && Number.isFinite(rawLocalMs)
      && rawLocalMs !== rawRemoteMs;
    const clockSyncResult = timestampsDiffer
      ? await this.clockSync.ensureSynced().catch(() => null)
      : null;

    if (timestampsDiffer && !clockSyncResult?.reliable) {
      throw this.createProjectClockUncertainError(
        project.id,
        localUpdatedAt,
        remoteUpdatedAt,
      );
    }

    const remoteIsNewer = !!(
      remoteUpdatedAt
      && localUpdatedAt
      && (
        clockSyncResult?.reliable
          ? this.clockSync.compareTimestamps(localUpdatedAt, remoteUpdatedAt) < 0
          : rawRemoteMs > rawLocalMs
      )
    );

    if (remoteHasTombstone || remoteIsNewer) {
      throw this.createProjectDirectConflictError(
        project.id,
        remoteProject?.updatedAt ?? remoteProject?.deletedAt ?? null,
        remoteHasTombstone ? 'remote-tombstone' : 'remote-newer',
      );
    }

    const projectInsertPayload = {
      id: project.id,
      owner_id: userId,
      title: project.name,
      description: project.description,
      version: project.version || 1,
      migrated_to_v2: true,
      deleted_at: project.deletedAt ?? null,
    };
    const projectUpdatePayload = {
      title: project.name,
      description: project.description,
      version: project.version || 1,
      migrated_to_v2: true,
      deleted_at: project.deletedAt ?? null,
    };

    let data: { updated_at?: string | null } | null = null;
    let error: unknown | null = null;

    if (remoteProject?.updatedAt) {
      ({ data, error } = await client
        .from('projects')
        .update(projectUpdatePayload)
        .eq('id', project.id)
        .eq('owner_id', userId)
        .eq('updated_at', remoteProject.updatedAt)
        .select('updated_at')
        .maybeSingle());

      if (!error && !data) {
        throw this.createProjectDirectConflictError(
          project.id,
          remoteProject.updatedAt,
          'remote-newer',
        );
      }
    } else if (remoteProject) {
      throw this.createProjectDirectConflictError(
        project.id,
        remoteProject.updatedAt ?? remoteProject.deletedAt ?? null,
        'remote-newer',
      );
    } else {
      ({ data, error } = await client
        .from('projects')
        .insert(projectInsertPayload)
        .select('updated_at')
        .maybeSingle());

      const code = (error as { code?: string | number } | null)?.code;
      if (error && (code === '23505' || code === 23505)) {
        throw this.createProjectDirectConflictError(
          project.id,
          project.updatedAt ?? null,
          'remote-newer',
        );
      }

      if (!error && !data) {
        throw this.createProjectDirectConflictError(
          project.id,
          project.updatedAt ?? null,
          'remote-newer',
        );
      }
    }
    
    if (error) throw supabaseErrorToError(error);
    this.normalizeLocalProjectUpdatedAt(
      project,
      typeof data?.updated_at === 'string' ? data.updated_at : null,
    );
    return true;
  }
  
  async pullProjects(since?: string): Promise<Project[]> {
    const client = await this.getSupabaseClient();
    if (!client) return [];

    try {
      const userId = this.sessionManager.getRecentValidationSnapshot(60_000)?.userId;
      let query = client
        .from('projects')
        .select(FIELD_SELECT_CONFIG.PROJECT_LIST_FIELDS)
        .is('deleted_at', null);
      if (userId) query = query.eq('owner_id', userId);
      if (since) query = query.gt('updated_at', since);

      const { data, error } = await query;
      if (error) throw supabaseErrorToError(error);
      
      return (data || []).map(row => this.projectDataService.rowToProject(row as ProjectRow));
    } catch (e) {
      this.logger.error('拉取项目失败', e);
      return [];
    }
  }
  
  // ==================== 重试队列（委托 RetryQueueService） ====================
  
  /**
   * 添加项目到重试队列（含会话和数据有效性检查）
   */
  addToRetryQueue(
    type: RetryableEntityType,
    operation: RetryableOperation,
    data: Task | Project | Connection | { id: string },
    projectId?: string,
    sourceUserId?: string,
    taskIdsToDelete?: string[],
  ): boolean {
    if (this.syncState().sessionExpired && type !== 'project') return false;
    if (!data?.id) {
      this.logger.warn('addToRetryQueue: 跳过无效数据（缺少 id）', { type, operation });
      return false;
    }
    if ((type === 'task' || type === 'connection') && !projectId) {
      this.logger.warn('addToRetryQueue: 跳过无效数据（缺少 projectId）', { type, operation, id: data.id });
      return false;
    }
    const enqueued = this.retryQueueService.add(type, operation, data, projectId, sourceUserId, taskIdsToDelete);
    if (enqueued) {
      this.syncStateService.update({ pendingCount: this.retryQueueService.length });
    } else {
      this.syncStateService.setSyncError('同步队列已满，暂未写入重试队列');
    }

    return enqueued;
  }

  async addToRetryQueueDurably(
    type: RetryableEntityType,
    operation: RetryableOperation,
    data: Task | Project | Connection | { id: string },
    projectId?: string,
    sourceUserId?: string,
    taskIdsToDelete?: string[],
  ): Promise<boolean> {
    if (this.syncState().sessionExpired && type !== 'project') return false;
    if (!data?.id) {
      this.logger.warn('addToRetryQueueDurably: 跳过无效数据（缺少 id）', { type, operation });
      return false;
    }
    if ((type === 'task' || type === 'connection') && !projectId) {
      this.logger.warn('addToRetryQueueDurably: 跳过无效数据（缺少 projectId）', { type, operation, id: data.id });
      return false;
    }

    const enqueued = await this.retryQueueService.addDurably(type, operation, data, projectId, sourceUserId, taskIdsToDelete);
    if (enqueued) {
      this.syncStateService.update({ pendingCount: this.retryQueueService.length });
    } else {
      this.syncStateService.setSyncError('同步队列已满，暂未写入重试队列');
    }

    return enqueued;
  }
  
  clearRetryQueue(): void {
    const count = this.retryQueueService.length;
    this.retryQueueService.clear();
    this.syncStateService.update({ pendingCount: 0 });
    this.logger.info(`已清理 ${count} 个重试项`);
    this.toast.info(`已清理 ${count} 个待同步项`);
  }

  private hasRetryQueueEntity(type: RetryableEntityType, entityId: string): boolean {
    const retryQueue = this.retryQueueService as RetryQueueService & {
      hasEntity?: (entityType: RetryableEntityType, targetEntityId: string) => boolean;
    };

    return typeof retryQueue.hasEntity === 'function'
      ? retryQueue.hasEntity(type, entityId)
      : false;
  }
  
  // ==================== Realtime / 轮询 ====================
  
  isRealtimeEnabled(): boolean {
    return this.realtimePollingService.isRealtimeEnabled();
  }
  
  setOnRemoteChange(callback: RemoteChangeCallback): void {
    this.realtimePollingService.setOnRemoteChange(callback);
  }

  setUserPreferencesChangeCallback(callback: UserPreferencesChangeCallback | null): void {
    this.realtimePollingService.setUserPreferencesChangeCallback(callback);
  }
  
  setRealtimeEnabled(enabled: boolean): void {
    this.realtimePollingService.setRealtimeEnabled(enabled);
  }
  
  async subscribeToProject(projectId: string, userId: string): Promise<void> {
    await this.realtimePollingService.subscribeToProject(projectId, userId);
  }
  
  async unsubscribeFromProject(): Promise<void> {
    await this.realtimePollingService.unsubscribeFromProject();
  }
  
  setRemoteChangeCallback(callback: RemoteChangeCallback): void {
    this.realtimePollingService.setOnRemoteChange(callback);
  }
  
  setTaskChangeCallback(callback: TaskChangeCallback): void {
    this.realtimePollingService.setTaskChangeCallback(callback);
  }
  
  async initRealtimeSubscription(userId: string): Promise<void> {
    this.logger.debug('Realtime 订阅已初始化', { userId: userId.substring(0, 8) });
  }
  
  teardownRealtimeSubscription(): void {
    this.realtimePollingService.unsubscribeFromProject();
  }
  
  pauseRealtimeUpdates(): void {
    this.realtimePollingService.pauseRealtimeUpdates();
  }
  
  resumeRealtimeUpdates(): void {
    this.realtimePollingService.resumeRealtimeUpdates();
  }
  
  // ==================== 用户偏好 ====================
  
  async loadUserPreferences(userId: string): Promise<UserPreferences | null> {
    return this.userPrefsSync.loadUserPreferences(userId);
  }
  
  async saveUserPreferences(userId: string, preferences: Partial<UserPreferences>): Promise<boolean> {
    return this.userPrefsSync.saveUserPreferences(userId, preferences);
  }

  async loadFocusSession(userId: string, localUpdatedAt?: string): Promise<Result<DockSnapshot | null, OperationError>> {
    return this.focusConsoleSync.loadFocusSession(userId, localUpdatedAt);
  }

  async saveFocusSession(record: FocusSessionRecord): Promise<Result<void, OperationError>> {
    return this.focusConsoleSync.saveFocusSession(record);
  }

  async listRoutineTasks(userId: string): Promise<Result<RoutineTask[], OperationError>> {
    return this.focusConsoleSync.listRoutineTasks(userId);
  }

  async upsertRoutineTask(userId: string, task: RoutineTask): Promise<Result<void, OperationError>> {
    return this.focusConsoleSync.upsertRoutineTask(userId, task);
  }

  async incrementRoutineCompletion(mutation: RoutineCompletionMutation): Promise<Result<void, OperationError>> {
    return this.focusConsoleSync.incrementRoutineCompletion(mutation);
  }

  // ==================== Delta Sync ====================
  
  async checkForDrift(projectId: string): Promise<ProjectDeltaDrift> {
    const client = await this.getSupabaseClient();
    if (!client || !SYNC_CONFIG.DELTA_SYNC_ENABLED) {
      return { tasks: [], connections: [], nextCursor: null };
    }
    
    const lastCursor = await this.ensureProjectSyncCursorLoaded(projectId);
    const lastSyncTime = lastCursor?.updatedAt ?? this.lastSyncTimeByProject.get(projectId);
    if (!lastSyncTime) {
      return { tasks: [], connections: [], nextCursor: null };
    }
    
    try {
      const driftMs = Math.abs(this.clockSync.currentDriftMs());
      const lookbackMs = Math.max(SYNC_CONFIG.CURSOR_SAFETY_LOOKBACK_MS, driftMs);
      const sinceMs = new Date(lastSyncTime).getTime() - lookbackMs;
      const effectiveSince = new Date(Math.max(0, sinceMs)).toISOString();

      const loadDeltaTasks = async () => await client
        .from('tasks')
        .select(getCompatibleTaskSelectFields(FIELD_SELECT_CONFIG.TASK_LIST_FIELDS))
        .eq('project_id', projectId)
        .gt('updated_at', effectiveSince)
        .order('updated_at', { ascending: true })
        .order('id', { ascending: true });
      const [initialTasksResult, connectionsResult] = await Promise.all([
        loadDeltaTasks(),
        client.from('connections')
          .select(FIELD_SELECT_CONFIG.CONNECTION_FIELDS)
          .eq('project_id', projectId)
          .gt('updated_at', effectiveSince)
          .order('updated_at', { ascending: true })
          .order('id', { ascending: true })
      ]);
      let tasksResult = initialTasksResult;

      if (tasksResult.error && markTaskCompletedAtColumnUnavailable(tasksResult.error)) {
        this.logger.warn('tasks.completed_at 缺失，Delta Sync 已降级为旧 schema 任务字段', {
          projectId,
          effectiveSince,
          error: tasksResult.error,
        });
        tasksResult = await loadDeltaTasks();
      }
      
      if (tasksResult.error || connectionsResult.error) {
        throw supabaseErrorToError(tasksResult.error || connectionsResult.error);
      }
      
      const rawTaskRows = ((tasksResult.data || []) as unknown) as TaskRow[];
      const rawConnectionRows = ((connectionsResult.data || []) as unknown) as ConnectionRow[];
      const taskRows = rawTaskRows.filter(row => this.isProjectRowAfterCursor('task', row.id, row.updated_at, lastCursor));
      const connectionRows = rawConnectionRows.filter(row => this.isProjectRowAfterCursor('connection', row.id, row.updated_at, lastCursor));
      const deltaTasks = this.dedupeTasksByLatest(
        taskRows.map(row => this.projectDataService.rowToTask(row))
      );
      const deltaConnections = this.dedupeConnectionsByLatest(
        connectionRows.map(row => this.projectDataService.rowToConnection(row))
      );
      const nextCursor = this.computeProjectSyncCursor(taskRows, connectionRows);
      const maxUpdatedAt = nextCursor?.updatedAt ?? null;
      
      this.sentryLazyLoader.setContext('sync_delta', {
        project_id: projectId,
        cursor_lag_ms: maxUpdatedAt ? Math.max(0, Date.now() - new Date(maxUpdatedAt).getTime()) : null,
        lookback_ms: lookbackMs,
        cursor_candidate: nextCursor
      });
      
      return {
        tasks: deltaTasks,
        connections: deltaConnections,
        nextCursor
      };
    } catch (e) {
      this.logger.error('Delta Sync 检查失败', e);
      throw e;
    }
  }

  private dedupeTasksByLatest(tasks: Task[]): Task[] {
    const byId = new Map<string, Task>();
    for (const task of tasks) {
      const existing = byId.get(task.id);
      if (!existing) {
        byId.set(task.id, task);
        continue;
      }
      const existingTs = existing.updatedAt ? new Date(existing.updatedAt).getTime() : 0;
      const nextTs = task.updatedAt ? new Date(task.updatedAt).getTime() : 0;
      if (nextTs >= existingTs) {
        byId.set(task.id, task);
      }
    }
    return Array.from(byId.values());
  }

  private dedupeConnectionsByLatest(connections: Connection[]): Connection[] {
    const byId = new Map<string, Connection>();
    for (const connection of connections) {
      const existing = byId.get(connection.id);
      if (!existing) {
        byId.set(connection.id, connection);
        continue;
      }
      const existingTs = existing.updatedAt ? new Date(existing.updatedAt).getTime() : 0;
      const nextTs = connection.updatedAt ? new Date(connection.updatedAt).getTime() : 0;
      if (nextTs >= existingTs) {
        byId.set(connection.id, connection);
      }
    }
    return Array.from(byId.values());
  }

  private computeProjectSyncCursor(taskRows: TaskRow[], connectionRows: ConnectionRow[]): ProjectSyncCursor | null {
    let cursor: ProjectSyncCursor | null = null;
    const consider = (entityType: ProjectSyncCursorEntityType, id: unknown, updatedAt: unknown): void => {
      if (typeof id !== 'string' || typeof updatedAt !== 'string') return;
      const candidate: ProjectSyncCursor = { updatedAt, entityType, id };
      if (!cursor || compareProjectSyncCursor(candidate, cursor) > 0) {
        cursor = candidate;
      }
    };

    for (const row of taskRows) {
      consider('task', row.id, row.updated_at);
    }
    for (const row of connectionRows) {
      consider('connection', row.id, row.updated_at);
    }
    return cursor;
  }

  private isProjectRowAfterCursor(
    entityType: ProjectSyncCursorEntityType,
    id: unknown,
    updatedAt: unknown,
    cursor: ProjectSyncCursor | null,
  ): boolean {
    if (!cursor) return true;
    if (typeof id !== 'string' || typeof updatedAt !== 'string') return false;
    return compareProjectSyncCursor({ updatedAt, entityType, id }, cursor) > 0;
  }

  buildProjectSyncCursorFromProject(project: Project): ProjectSyncCursor | null {
    let cursor: ProjectSyncCursor | null = null;
    const consider = (entityType: ProjectSyncCursorEntityType, id: unknown, updatedAt: unknown): void => {
      if (typeof id !== 'string' || typeof updatedAt !== 'string') return;
      const candidate: ProjectSyncCursor = { updatedAt, entityType, id };
      if (!cursor || compareProjectSyncCursor(candidate, cursor) > 0) {
        cursor = candidate;
      }
    };

    consider('project', project.id, project.updatedAt);
    for (const task of project.tasks ?? []) {
      consider('task', task.id, task.updatedAt);
    }
    for (const connection of project.connections ?? []) {
      consider('connection', connection.id, connection.updatedAt);
    }
    return cursor;
  }

  private getSyncCursorUserId(): string | null {
    return this.sessionManager.getRecentValidationSnapshot(60_000)?.userId ?? null;
  }

  private async ensureProjectSyncCursorLoaded(projectId: string): Promise<ProjectSyncCursor | null> {
    const cached = this.syncCursorByProject.get(projectId);
    if (cached) return cached;

    const persisted = await this.syncCursorPersistence.loadProjectCursor(projectId, this.getSyncCursorUserId());
    if (persisted) {
      this.syncCursorByProject.set(projectId, persisted);
      this.lastSyncTimeByProject.set(projectId, persisted.updatedAt);
      return persisted;
    }

    const legacy = this.lastSyncTimeByProject.get(projectId);
    return legacy ? projectCursorFromLegacyTimestamp(legacy) : null;
  }
  
  setLastSyncTime(projectId: string, timestamp: string): void {
    this.lastSyncTimeByProject.set(projectId, timestamp);
    this.syncCursorByProject.delete(projectId);
  }
  
  getLastSyncTime(projectId: string): string | null {
    return this.lastSyncTimeByProject.get(projectId) || null;
  }

  getProjectSyncCursor(projectId: string): ProjectSyncCursor | null {
    return this.syncCursorByProject.get(projectId) ?? null;
  }

  async commitProjectSyncCursor(projectId: string, cursor: ProjectSyncCursor | null | undefined): Promise<void> {
    if (!cursor) return;
    const cursorMs = new Date(cursor.updatedAt).getTime();
    if (!Number.isFinite(cursorMs)) return;

    const existing = this.syncCursorByProject.get(projectId);
    if (existing && compareProjectSyncCursor(cursor, existing) < 0) {
      this.sentryLazyLoader.addBreadcrumb({
        category: 'sync',
        message: 'delta.cursor_commit_ignored_stale',
        level: 'info',
        data: { projectId, existing, candidate: cursor },
      });
      return;
    }

    const committed = await this.syncCursorPersistence.commitProjectCursor(
      projectId,
      this.getSyncCursorUserId(),
      cursor,
    );
    this.syncCursorByProject.set(projectId, committed);
    this.lastSyncTimeByProject.set(projectId, committed.updatedAt);
  }

  async commitProjectSyncTimestamp(projectId: string, timestamp: string): Promise<void> {
    await this.commitProjectSyncCursor(projectId, projectCursorFromLegacyTimestamp(timestamp));
  }

  markSyncRecoveredIfIdle(timestamp = nowISO()): boolean {
    const recovered = this.syncStateService.markSyncRecoveredIfIdle(timestamp);
    if (recovered) {
      this.retryQueueService.clearSuccessfulDrainFlag();
    }
    return recovered;
  }

  hasPendingRetryRecovery(): boolean {
    return this.retryQueueService.hasSuccessfulDrainFlag();
  }
  
  clearLastSyncTime(projectId: string): void {
    this.lastSyncTimeByProject.delete(projectId);
    this.syncCursorByProject.delete(projectId);
    void this.syncCursorPersistence.clearProjectCursor(projectId, this.getSyncCursorUserId());
  }
  
  // ==================== 冲突解决 ====================
  
  resolveConflict(projectId: string, resolvedProject: Project, strategy: 'local' | 'remote'): void {
    this.logger.info('解决冲突', { projectId, strategy });
    this.syncStateService.update({ hasConflict: false, conflictData: null });
  }
  
  setConflict(conflictData: ConflictData): void {
    this.syncStateService.update({ hasConflict: true, conflictData });
  }

  clearConflict(): void {
    this.syncStateService.update({ hasConflict: false, conflictData: null });
  }

  private buildProjectSaveFlightKey(projectId: string, userId: string): string {
    return `${userId}:${projectId}`;
  }

  private captureEffectiveTaskIdsToDelete(
    projectId: string,
    taskIdsToDelete?: string[],
    fallbackTaskIdsToDelete?: string[],
  ): string[] | undefined {
    if (taskIdsToDelete !== undefined) {
      return [...taskIdsToDelete];
    }

    const trackedTaskIdsToDelete = this.changeTracker.getProjectChanges(projectId).taskIdsToDelete;
    if (trackedTaskIdsToDelete.length > 0) {
      return [...trackedTaskIdsToDelete];
    }

    if (fallbackTaskIdsToDelete !== undefined) {
      return [...fallbackTaskIdsToDelete];
    }

    return undefined;
  }

  private getExistingProjectRetryTaskIdsToDelete(projectId: string, sourceUserId?: string): string[] | undefined {
    const retryQueue = this.retryQueueService as RetryQueueService & {
      getProjectRetryTaskIdsToDeleteForOwner?: (targetProjectId: string, targetSourceUserId?: string) => string[] | undefined;
    };

    return typeof retryQueue.getProjectRetryTaskIdsToDeleteForOwner === 'function'
      ? retryQueue.getProjectRetryTaskIdsToDeleteForOwner(projectId, sourceUserId)
      : undefined;
  }

  private buildProjectSaveSignature(project: Project, taskIdsToDelete?: string[]): string {
    const normalizedTaskIdsToDelete = [...(taskIdsToDelete ?? [])].sort();
    return JSON.stringify({ project, taskIdsToDelete: normalizedTaskIdsToDelete });
  }

  private createQueuedProjectSaveRequest(
    project: Project,
    userId: string,
    signature: string,
    taskIdsToDelete?: string[],
  ): QueuedProjectSaveRequest {
    let resolve!: (result: ProjectSaveResult) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<ProjectSaveResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    return {
      project,
      userId,
      signature,
      taskIdsToDelete,
      promise,
      resolve,
      reject,
    };
  }

  private hasProjectRetryMarker(projectId: string, sourceUserId?: string, retryEnqueued?: string[]): boolean {
    const retryQueue = this.retryQueueService as RetryQueueService & {
      hasProjectRetryForOwner?: (targetProjectId: string, targetSourceUserId?: string) => boolean;
    };

    return retryEnqueued?.includes(`project:${projectId}`) === true
      || (typeof retryQueue.hasProjectRetryForOwner === 'function'
        ? retryQueue.hasProjectRetryForOwner(projectId, sourceUserId)
        : this.hasRetryQueueEntity('project', projectId));
  }

  private clearProjectRetryMarker(projectId: string, sourceUserId?: string): void {
    const retryQueue = this.retryQueueService as RetryQueueService & {
      removeByProjectIdForOwner?: (projectId: string, sourceUserId?: string) => number;
    };
    const removedCount = typeof retryQueue.removeByProjectIdForOwner === 'function'
      ? retryQueue.removeByProjectIdForOwner(projectId, sourceUserId)
      : 0;

    if (removedCount === 0) {
      return;
    }

    this.syncStateService.update({ pendingCount: this.retryQueueService.length });
    this.logger.debug('项目云端持久化已终止，已清理遗留 project retry marker', {
      projectId,
      sourceUserId: sourceUserId ?? null,
      removedCount,
    });
  }

  private async refreshQueuedProjectRetryPayload(
    queuedRequest: QueuedProjectSaveRequest,
    retryEnqueued?: string[],
  ): Promise<boolean> {
    if (!this.hasProjectRetryMarker(queuedRequest.project.id, queuedRequest.userId, retryEnqueued)) {
      return false;
    }

    const latestTaskIdsToDelete = queuedRequest.taskIdsToDelete
      ?? this.getExistingProjectRetryTaskIdsToDelete(queuedRequest.project.id, queuedRequest.userId)
      ?? (queuedRequest.userId === this.sessionManager.getRecentValidationSnapshot(60_000)?.userId
        ? this.captureEffectiveTaskIdsToDelete(queuedRequest.project.id)
        : undefined);
    const refreshed = await this.addToRetryQueueDurably(
      'project',
      'upsert',
      queuedRequest.project,
      undefined,
      queuedRequest.userId,
      latestTaskIdsToDelete,
    );
    if (!refreshed) {
      return false;
    }

    this.logger.debug('项目云端持久化失败后已刷新重试队列为最新折叠快照', {
      projectId: queuedRequest.project.id,
      userId: queuedRequest.userId,
      taskDeleteCount: latestTaskIdsToDelete?.length ?? 0,
    });

    return true;
  }

  private getProjectSaveFreshness(project: Project): { updatedAtMs: number; version: number } {
    let updatedAtMs = project.updatedAt ? Date.parse(project.updatedAt) : 0;
    updatedAtMs = Number.isFinite(updatedAtMs) ? updatedAtMs : 0;

    for (const task of project.tasks) {
      const taskUpdatedAtMs = task.updatedAt ? Date.parse(task.updatedAt) : 0;
      const taskDeletedAtMs = task.deletedAt ? Date.parse(task.deletedAt) : 0;
      updatedAtMs = Math.max(
        updatedAtMs,
        Number.isFinite(taskUpdatedAtMs) ? taskUpdatedAtMs : 0,
        Number.isFinite(taskDeletedAtMs) ? taskDeletedAtMs : 0,
      );
    }

    for (const connection of project.connections) {
      const connectionUpdatedAtMs = connection.updatedAt ? Date.parse(connection.updatedAt) : 0;
      const connectionDeletedAtMs = connection.deletedAt ? Date.parse(connection.deletedAt) : 0;
      updatedAtMs = Math.max(
        updatedAtMs,
        Number.isFinite(connectionUpdatedAtMs) ? connectionUpdatedAtMs : 0,
        Number.isFinite(connectionDeletedAtMs) ? connectionDeletedAtMs : 0,
      );
    }

    return {
      updatedAtMs,
      version: project.version ?? 0,
    };
  }

  private isProjectSaveNewer(candidate: Project, current: Project): boolean {
    const candidateFreshness = this.getProjectSaveFreshness(candidate);
    const currentFreshness = this.getProjectSaveFreshness(current);

    if (candidateFreshness.updatedAtMs !== currentFreshness.updatedAtMs) {
      return candidateFreshness.updatedAtMs > currentFreshness.updatedAtMs;
    }

    if (candidateFreshness.version !== currentFreshness.version) {
      return candidateFreshness.version > currentFreshness.version;
    }

    return true;
  }

  private startProjectSaveFlight(
    key: string,
    project: Project,
    userId: string,
    signature: string,
    taskIdsToDelete?: string[],
    flight?: ProjectSaveFlight,
    queuedRequest?: QueuedProjectSaveRequest,
  ): Promise<ProjectSaveResult> {
    const targetFlight = flight ?? {
      activeSignature: signature,
      activeTaskIdsToDelete: taskIdsToDelete ?? queuedRequest?.taskIdsToDelete,
      activePromise: Promise.resolve({ success: false }),
      queuedRequest: null,
    };
    const basePromise = this.batchSyncService.saveProjectToCloud(
      project,
      userId,
      taskIdsToDelete ?? queuedRequest?.taskIdsToDelete,
    );
    const activePromise = queuedRequest
      ? basePromise.then(
          (result) => {
            queuedRequest.resolve(result);
            return result;
          },
          (error) => {
            queuedRequest.reject(error);
            throw error;
          }
        )
      : basePromise;

    targetFlight.activeSignature = signature;
  targetFlight.activeTaskIdsToDelete = taskIdsToDelete ?? queuedRequest?.taskIdsToDelete;
    targetFlight.activePromise = activePromise;
    this.projectSaveFlights.set(key, targetFlight);

    void activePromise
      .then(
        (result) => this.settleProjectSaveFlight(key, targetFlight, result),
        (error) => this.abortProjectSaveFlight(key, targetFlight, error),
      )
      .catch((error) => {
        this.logger.warn('推进项目云端持久化单飞队列失败', { error, key });
      });

    return activePromise;
  }

  private async settleProjectSaveFlight(
    key: string,
    flight: ProjectSaveFlight,
    result: ProjectSaveResult,
  ): Promise<void> {
    if (this.projectSaveFlights.get(key) !== flight) {
      return;
    }

    if (!result.success) {
      if (result.conflict || result.terminal) {
        const separatorIndex = key.indexOf(':');
        const userId = separatorIndex >= 0 ? key.slice(0, separatorIndex) : undefined;
        const projectId = separatorIndex >= 0 ? key.slice(separatorIndex + 1) : key;
        this.clearProjectRetryMarker(projectId, userId);
      }

      const queuedRequest = flight.queuedRequest;
      if (!queuedRequest) {
        this.projectSaveFlights.delete(key);
        return;
      }

      if (result.conflict || result.terminal) {
        flight.queuedRequest = null;
        this.projectSaveFlights.delete(key);
        queuedRequest.resolve(result);
        this.logger.debug(result.terminal
          ? '项目云端持久化命中终止失败，折叠队列停止自动重放'
          : '项目云端持久化冲突，折叠队列等待显式冲突解决', {
          projectId: queuedRequest.project.id,
          userId: queuedRequest.userId,
          failureReason: result.failureReason ?? null,
        });
        return;
      }

      if (await this.refreshQueuedProjectRetryPayload(queuedRequest, result.retryEnqueued)) {
        flight.queuedRequest = null;
        this.projectSaveFlights.delete(key);
        queuedRequest.resolve(result);
        this.logger.debug('项目级重试已接管，折叠队列与当前失败结果一起结算', {
          projectId: queuedRequest.project.id,
          userId: queuedRequest.userId,
          failureReason: result.failureReason ?? null,
        });
        return;
      }

      this.logger.debug('项目级失败未覆盖最新折叠快照，继续执行排队中的项目云端持久化', {
        projectId: queuedRequest.project.id,
        userId: queuedRequest.userId,
        failureReason: result.failureReason ?? null,
      });
      await this.advanceProjectSaveFlight(key, flight);
      return;
    }

    await this.advanceProjectSaveFlight(key, flight);
  }

  private async abortProjectSaveFlight(
    key: string,
    flight: ProjectSaveFlight,
    error: unknown,
  ): Promise<void> {
    if (this.projectSaveFlights.get(key) !== flight) {
      return;
    }

    const queuedRequest = flight.queuedRequest;
    flight.queuedRequest = null;
    this.projectSaveFlights.delete(key);

    if (queuedRequest) {
      await this.refreshQueuedProjectRetryPayload(queuedRequest);
      queuedRequest.reject(error);
      this.logger.debug('项目云端持久化异常，取消排队中的折叠快照', {
        projectId: queuedRequest.project.id,
        userId: queuedRequest.userId,
      });
    }
  }

  private async advanceProjectSaveFlight(key: string, flight: ProjectSaveFlight): Promise<void> {
    if (this.projectSaveFlights.get(key) !== flight) {
      return;
    }

    const queuedRequest = flight.queuedRequest;
    if (!queuedRequest) {
      this.projectSaveFlights.delete(key);
      return;
    }

    flight.queuedRequest = null;
    this.logger.debug('执行折叠后的项目云端持久化', {
      projectId: queuedRequest.project.id,
      userId: queuedRequest.userId,
    });
    this.startProjectSaveFlight(
      key,
      queuedRequest.project,
      queuedRequest.userId,
      queuedRequest.signature,
      queuedRequest.taskIdsToDelete,
      flight,
      queuedRequest,
    );
  }

  private saveProjectToCloudSingleFlight(project: Project, userId: string, taskIdsToDelete?: string[]): Promise<ProjectSaveResult> {
    const key = this.buildProjectSaveFlightKey(project.id, userId);
    const existingFlight = this.projectSaveFlights.get(key);

    if (!existingFlight) {
      const effectiveTaskIdsToDelete = this.captureEffectiveTaskIdsToDelete(project.id, taskIdsToDelete);
      const signature = this.buildProjectSaveSignature(project, effectiveTaskIdsToDelete);
      return this.startProjectSaveFlight(key, project, userId, signature, effectiveTaskIdsToDelete);
    }

    const effectiveTaskIdsToDelete = this.captureEffectiveTaskIdsToDelete(
      project.id,
      taskIdsToDelete,
      existingFlight.activeTaskIdsToDelete,
    );
    const signature = this.buildProjectSaveSignature(project, effectiveTaskIdsToDelete);

    if (existingFlight.activeSignature === signature) {
      this.logger.debug('复用进行中的项目云端持久化', {
        projectId: project.id,
        userId,
      });
      return existingFlight.activePromise;
    }

    if (existingFlight.queuedRequest) {
      if (existingFlight.queuedRequest.signature === signature) {
        return existingFlight.queuedRequest.promise;
      }

      const queuedRequestTaskIdsToDelete = this.captureEffectiveTaskIdsToDelete(
        project.id,
        taskIdsToDelete,
        existingFlight.queuedRequest.taskIdsToDelete ?? existingFlight.activeTaskIdsToDelete,
      );
      const queuedRequestSignature = this.buildProjectSaveSignature(project, queuedRequestTaskIdsToDelete);

      if (this.isProjectSaveNewer(project, existingFlight.queuedRequest.project)) {
        existingFlight.queuedRequest.project = project;
        existingFlight.queuedRequest.userId = userId;
        existingFlight.queuedRequest.signature = queuedRequestSignature;
        existingFlight.queuedRequest.taskIdsToDelete = queuedRequestTaskIdsToDelete;
        this.logger.debug('合并项目云端持久化请求到更新/同等新鲜度的后到快照', {
          projectId: project.id,
          userId,
        });
      } else {
        this.logger.debug('保留排队中的更新快照，忽略更旧的项目云端持久化请求', {
          projectId: project.id,
          userId,
        });
      }
      return existingFlight.queuedRequest.promise;
    }

    const queuedRequest = this.createQueuedProjectSaveRequest(
      project,
      userId,
      signature,
      effectiveTaskIdsToDelete,
    );
    existingFlight.queuedRequest = queuedRequest;
    this.logger.debug('项目云端持久化排队等待单飞窗口结束', {
      projectId: project.id,
      userId,
    });
    return queuedRequest.promise;
  }
  
  // ==================== 项目加载 ====================
  
  async saveProjectToCloud(project: Project, userId: string, taskIdsToDelete?: string[]): Promise<ProjectSaveResult> {
    return this.saveProjectToCloudSingleFlight(project, userId, taskIdsToDelete);
  }

  async saveProjectSmart(project: Project, userId: string, taskIdsToDelete?: string[]): Promise<{ success: boolean; conflict?: boolean; remoteData?: Project; newVersion?: number; validationWarnings?: string[]; projectPushed?: boolean; failedTaskIds?: string[]; failedConnectionIds?: string[]; retryEnqueued?: string[]; failureReason?: string; terminal?: boolean }> {
    const result = await this.saveProjectToCloud(project, userId, taskIdsToDelete);
    return { ...result, newVersion: result.newVersion ?? project.version };
  }
  
  async loadFullProjectOptimized(projectId: string): Promise<Project | null> {
    return this.projectDataService.loadFullProjectOptimized(projectId);
  }
  
  async loadFullProject(projectId: string, _userId: string): Promise<Project | null> {
    return this.projectDataService.loadFullProject(projectId);
  }
  
  async loadProjectsFromCloud(userId: string, _silent?: boolean): Promise<Project[]> {
    return this.projectDataService.loadProjectsFromCloud(userId);
  }

  async loadProjectListMetadataFromCloud(
    userId: string,
    options: ProjectListMetadataLoadOptions = {}
  ): Promise<Project[] | null> {
    return this.projectDataService.loadProjectListMetadataFromCloud(userId, options);
  }

  private buildProjectDeleteRetryableFailure(
    message: string,
    details: Record<string, unknown>,
  ): Result<void, OperationError> {
    return failure(ErrorCodes.SYNC_OFFLINE, message, {
      retryable: true,
      ...details,
    });
  }

  private buildProjectDeleteAuthExpiredFailure(
    context: string,
    details: Record<string, unknown>,
  ): Result<void, OperationError> {
    try {
      this.sessionManager.handleSessionExpired(context, details);
    } catch {
      // handleSessionExpired 约定会抛出以中断上层流程；此处已转为 Result 语义返回。
    }

    return failure(ErrorCodes.SYNC_AUTH_EXPIRED, '登录已过期，请重新登录', details);
  }

  private async executeProjectDelete(
    client: SupabaseClient,
    projectId: string,
    userId: string,
  ): Promise<Result<void, OperationError>> {
    const { data: { session } } = await client.auth.getSession();
    let sessionUserId = session?.user?.id ?? null;

    if (!sessionUserId) {
      const refreshed = await this.sessionManager.tryRefreshSession('deleteProjectFromCloud.getSession');
      if (refreshed) {
        const { data: { session: refreshedSession } } = await client.auth.getSession();
        sessionUserId = refreshedSession?.user?.id ?? null;
      }
    }

    if (!sessionUserId) {
      if (isBrowserNetworkSuspendedWindow()) {
        return this.buildProjectDeleteRetryableFailure('浏览器恢复连接中，请稍后重试', {
          projectId,
          userId,
          reason: 'browser-network-suspended',
          resumeDelayMs: getRemainingBrowserNetworkResumeDelayMs(),
        });
      }

      return this.buildProjectDeleteAuthExpiredFailure('deleteProjectFromCloud.getSession', {
        projectId,
        userId,
      });
    }

    if (sessionUserId !== userId) {
      this.logger.warn('检测到项目删除归属与当前会话不匹配，已拒绝云端删除', {
        projectId,
        userId,
        sessionUserId,
      });
      return this.buildProjectDeleteAuthExpiredFailure('deleteProjectFromCloud.userMismatch', {
        projectId,
        expectedUserId: userId,
        sessionUserId,
      });
    }

    await this.primeProjectSyncRpcCapability();

    if (this.syncRpcClient?.isClientRejected() === true) {
      return this.buildProjectDeleteClientRejectedFailure(projectId, userId);
    }

    if (this.shouldUseSyncRpc()) {
      const result = await this.syncRpcClient!.deleteProject({
        operationId: this.createSyncRpcOperationId(),
        projectId,
        baseUpdatedAt: this.projectStore?.getProject(projectId)?.updatedAt ?? null,
      });

      if (result.status === 'applied' || result.status === 'idempotent-replay') {
        if (result.serverUpdatedAt) {
          this.clockSync.recordServerTimestamp(result.serverUpdatedAt, projectId);
        }
        return success(undefined);
      }

      const isConflict = result.status === 'remote-newer' || result.status === 'deleted-remote-newer';
      const message = result.status === 'client-version-rejected'
        ? '当前客户端同步协议已过期，请刷新后重试'
        : isConflict
          ? '远端项目版本更新，请先同步后重试删除'
          : '项目删除被服务端拒绝';
      this.syncStateService.setSyncError(message);
      this.sentryLazyLoader.captureMessage(
        isConflict ? 'sync_rpc_project_delete_remote_newer' : 'sync_rpc_project_delete_rejected',
        {
          level: 'warning',
          tags: { operation: 'deleteProjectFromCloud', entityType: 'project', status: result.status },
          extra: {
            projectId,
            remoteUpdatedAt: result.remoteUpdatedAt,
            reason: result.reason,
            minProtocolVersion: result.minProtocolVersion,
          },
        },
      );

      if (result.status === 'unauthorized') {
        return failure(ErrorCodes.PERMISSION_DENIED, message, {
          projectId,
          userId,
          retryable: false,
          reason: result.reason,
        });
      }

      return failure(isConflict ? ErrorCodes.SYNC_CONFLICT : ErrorCodes.OPERATION_FAILED, message, {
        projectId,
        userId,
        retryable: false,
        reason: result.reason,
      });
    }

    const { error } = await client.rpc('soft_delete_project', {
      p_project_id: projectId,
    });
    if (error) throw supabaseErrorToError(error);

    return success(undefined);
  }
  
  async deleteProjectFromCloud(projectId: string, userId: string): Promise<Result<void, OperationError>> {
    if (this.syncState().sessionExpired) {
      return this.buildProjectDeleteAuthExpiredFailure('deleteProjectFromCloud.preflight', {
        projectId,
        userId,
      });
    }

    if (isBrowserNetworkSuspendedWindow()) {
      return this.buildProjectDeleteRetryableFailure('浏览器恢复连接中，请稍后重试', {
        projectId,
        userId,
        reason: 'browser-network-suspended',
        resumeDelayMs: getRemainingBrowserNetworkResumeDelayMs(),
      });
    }

    const client = await this.getSupabaseClient();
    if (!client) {
      return this.buildProjectDeleteRetryableFailure('当前离线，删除将在恢复连接后重试', {
        projectId,
        userId,
        reason: 'client-unavailable',
      });
    }
    
    try {
      return await this.executeProjectDelete(client, projectId, userId);
    } catch (e) {
      if (isBrowserNetworkSuspendedError(e)) {
        return this.buildProjectDeleteRetryableFailure('浏览器恢复连接中，请稍后重试', {
          projectId,
          userId,
          reason: 'browser-network-suspended',
          resumeDelayMs: getRemainingBrowserNetworkResumeDelayMs(),
        });
      }

      const enhanced = supabaseErrorToError(e);

      if (this.sessionManager.isSessionExpiredError(enhanced)) {
        const canRetry = await this.sessionManager.handleAuthErrorWithRefresh('deleteProjectFromCloud', {
          projectId,
          userId,
          errorCode: enhanced.code,
        });

        if (canRetry) {
          try {
            return await this.executeProjectDelete(client, projectId, userId);
          } catch (retryError) {
            if (isBrowserNetworkSuspendedError(retryError) || isBrowserNetworkSuspendedWindow()) {
              return this.buildProjectDeleteRetryableFailure('浏览器恢复连接中，请稍后重试', {
                projectId,
                userId,
                reason: 'browser-network-suspended',
                resumeDelayMs: getRemainingBrowserNetworkResumeDelayMs(),
              });
            }

            const retryEnhanced = supabaseErrorToError(retryError);
            if (this.sessionManager.isSessionExpiredError(retryEnhanced)) {
              // 会话刷新成功后重试仍然失败：
              // - 若为 42501 (RLS 违规)，说明是真正的权限不足，非会话过期
              // - 若为 401，说明刷新未能完全恢复，标记为会话过期
              if (this.sessionManager.isRlsPolicyViolation(retryEnhanced)) {
                this.logger.warn('刷新会话后重试仍获 RLS 违规，判定为权限不足', {
                  projectId, userId, errorCode: retryEnhanced.code,
                });
                return failure(ErrorCodes.PERMISSION_DENIED, '权限不足，无法删除此项目', {
                  projectId,
                  userId,
                  retryable: false,
                  errorCode: retryEnhanced.code,
                  errorType: retryEnhanced.errorType,
                });
              }
              return this.buildProjectDeleteAuthExpiredFailure('deleteProjectFromCloud.retryAfterRefresh', {
                projectId,
                userId,
                errorCode: retryEnhanced.code,
              });
            }

            return failure(
              retryEnhanced.errorType === 'PermissionError' ? ErrorCodes.PERMISSION_DENIED : ErrorCodes.OPERATION_FAILED,
              retryEnhanced.message,
              {
                projectId,
                userId,
                retryable: retryEnhanced.isRetryable,
                errorCode: retryEnhanced.code,
                errorType: retryEnhanced.errorType,
              },
            );
          }
        }

        if (isBrowserNetworkSuspendedWindow()) {
          return this.buildProjectDeleteRetryableFailure('浏览器恢复连接中，请稍后重试', {
            projectId,
            userId,
            reason: 'browser-network-suspended',
            resumeDelayMs: getRemainingBrowserNetworkResumeDelayMs(),
          });
        }

        return this.buildProjectDeleteAuthExpiredFailure('deleteProjectFromCloud', {
          projectId,
          userId,
          errorCode: enhanced.code,
        });
      }

      if (enhanced.errorType === 'PermissionError') {
        this.logger.warn('删除项目权限不足', {
          projectId,
          userId,
          error: enhanced,
        });
        return failure(ErrorCodes.PERMISSION_DENIED, enhanced.message, {
          projectId,
          userId,
          retryable: false,
          errorCode: enhanced.code,
          errorType: enhanced.errorType,
        });
      }

      const retryable = enhanced.isRetryable || enhanced.errorType === 'OfflineError' || enhanced.errorType === 'NetworkError';
      const errorCode = retryable ? ErrorCodes.SYNC_OFFLINE : ErrorCodes.OPERATION_FAILED;

      this.logger.error('删除项目失败', {
        projectId,
        userId,
        error: enhanced,
      });
      return failure(errorCode, enhanced.message, {
        projectId,
        userId,
        retryable,
        errorCode: enhanced.code,
        errorType: enhanced.errorType,
      });
    }
  }
  
  async loadSingleProject(projectId: string, userId: string): Promise<Project | null> {
    return this.loadFullProject(projectId, userId);
  }

  async getProjectSyncWatermark(projectId: string): Promise<string | null> {
    return this.projectDataService.getProjectSyncWatermark(projectId);
  }

  async getUserProjectsWatermark(): Promise<string | null> {
    return this.projectDataService.getUserProjectsWatermark();
  }

  async listProjectHeadsSince(
    watermark: string | null
  ): Promise<Array<{ id: string; updatedAt: string; version: number }>> {
    return this.projectDataService.listProjectHeadsSince(watermark);
  }

  async getAccessibleProjectProbe(projectId: string): Promise<{
    projectId: string;
    accessible: boolean;
    watermark: string | null;
  } | null> {
    return this.projectDataService.getAccessibleProjectProbe(projectId);
  }

  async getBlackBoxSyncWatermark(): Promise<string | null> {
    return this.projectDataService.getBlackBoxSyncWatermark();
  }

  async getResumeRecoveryProbe(projectId?: string): Promise<{
    activeProjectId: string | null;
    activeAccessible: boolean;
    activeWatermark: string | null;
    projectsWatermark: string | null;
    blackboxWatermark: string | null;
    serverNow: string | null;
  } | null> {
    return this.projectDataService.getResumeRecoveryProbe(projectId);
  }
  
  async tryReloadConflictData(userId: string, _findProject?: (id: string) => Project | undefined): Promise<Project | undefined> {
    const state = this.syncState();
    if (!state.hasConflict || !state.conflictData) return undefined;
    const project = await this.loadFullProject(state.conflictData.projectId, userId);
    return project ?? undefined;
  }
  
  clearOfflineCache(): void {
    this.projectDataService.clearOfflineSnapshot();
    this.retryQueueService.clear();
    this.syncStateService.update({ pendingCount: 0 });
    this.logger.info('离线缓存已清除');
  }

  clearOfflineSnapshot(): void {
    this.projectDataService.clearOfflineSnapshot();
  }
  
  saveOfflineSnapshot(projects: Project[], ownerUserId?: string | null): void {
    this.projectDataService.saveOfflineSnapshot(projects, ownerUserId);
  }

  async saveOfflineSnapshotAndWait(projects: Project[], ownerUserId?: string | null): Promise<void> {
    await this.projectDataService.saveOfflineSnapshotAndWait(projects, ownerUserId);
  }
  
  loadOfflineSnapshot(options?: { allowOwnerHint?: boolean }): Project[] | null {
    return this.projectDataService.loadOfflineSnapshot(options);
  }

  async loadStartupOfflineSnapshot(): Promise<StartupOfflineSnapshotLoadResult> {
    return this.projectDataService.loadStartupOfflineSnapshot();
  }

  async loadOfflineSnapshotAsync(): Promise<Project[] | null> {
    return this.projectDataService.loadOfflineSnapshotAsync();
  }
  
  // ==================== 会话管理 ====================
  
  resetSessionExpired(): void {
    if (!this.syncState().sessionExpired) return;
    
    const previousQueueLength = this.retryQueueService.length;
    this.syncStateService.update({ sessionExpired: false });
    
    this.logger.info('会话状态已重置', { previousQueueLength });
    
    if (this.state().isOnline && this.retryQueueService.length > 0) {
      this.logger.info('会话恢复，触发重试队列处理');
      this.retryQueueService.processQueue();
    }
  }
  
  destroy(): void {
    this.cleanup();
    this.unsubscribeFromProject();
    this.retryQueueService.clear();
    this.logger.info('SimpleSyncService 已销毁');
  }
}
