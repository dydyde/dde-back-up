/**
 * SyncCoordinatorService - 同步协调服务
 * 
 * 职责：
 * - 管理同步状态（网络连通性、队列长度、最后同步时间）
 * - 协调离线数据与云端数据的合并
 * - 处理同步冲突
 * - 管理持久化调度
 * 
 * 这是「应用状态」（Application State），与「领域数据」（Domain Data）分离：
 * - 领域数据：Project、Task（由 ProjectStateService 管理）
 * - 应用状态：网络状态、同步状态、冲突状态（由本服务管理）
 * 
 * 分离的好处：
 * - 网络波动更新同步状态时，不会触发任务列表的变更检测
 * - 数据流像电路板上的走线一样清晰，互不干扰
 */
import { Injectable, inject, signal, computed, DestroyRef } from '@angular/core';
import { Subject } from 'rxjs';
import { SimpleSyncService, RetryQueueService, SyncStateService, type SyncConflictData } from '../core-bridge';
import { ActionQueueService } from './action-queue.service';
import { ActionQueueProcessorsService } from './action-queue-processors.service';
import { DeltaSyncCoordinatorService } from './delta-sync-coordinator.service';
import { ProjectSyncOperationsService } from './project-sync-operations.service';
import { ConflictResolutionService } from './conflict-resolution.service';
import { ConflictStorageService } from './conflict-storage.service';
import { type ConflictResolutionPlan } from './conflict-resolution.types';
import { ChangeTrackerService } from './change-tracker.service';
import { ProjectStateService } from './project-state.service';
import { AuthService } from './auth.service';
import { ToastService } from './toast.service';
import { LayoutService } from './layout.service';
import { LoggerService } from './logger.service';
import { SentryAlertService } from './sentry-alert.service';
import { TabSyncService } from './tab-sync.service';
// Sprint 4 技术债务修复：提取的子服务
import { PersistSchedulerService } from './persist-scheduler.service';
// 借鉴思源笔记的同步增强服务
import { SyncModeService, SyncDirection } from './sync-mode.service';
import { Project, Task, Connection } from '../models';
import { AUTH_CONFIG } from '../config/auth.config';
import { SYNC_CONFIG } from '../config/sync.config';
import { STARTUP_PERF_CONFIG } from '../config/startup-performance.config';
import { FEATURE_FLAGS } from '../config/feature-flags.config';
import { TIMEOUT_CONFIG } from '../config/timeout.config';
import { Result, OperationError } from '../utils/result';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { BlackBoxSyncService } from './black-box-sync.service';
/**
 * 冲突事件数据
 * 用于发布-订阅模式的冲突通知
 */
export interface ConflictEvent {
  localProject: Project;
  remoteProject: Project;
  projectId: string;
  pendingTaskDeleteIds?: string[];
}

/**
 * 持久化状态
 */
interface PersistState {
  /** 是否正在持久化 */
  isPersisting: boolean;
  /** 是否有待处理的持久化请求 */
  hasPending: boolean;
  /** 上次持久化时间 */
  lastPersistAt: number;
  /** 是否有本地未同步的变更 */
  hasPendingLocalChanges: boolean;
  /** 上次更新类型 */
  lastUpdateType: 'content' | 'structure' | 'position';
}

interface PersistOutcome {
  remoteConfirmed: boolean;
  projectId?: string;
}

@Injectable({
  providedIn: 'root'
})
export class SyncCoordinatorService {
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('SyncCoordinator');
  
  // ========== 公开子服务（减少代理方法） ==========
  
  /** 
   * 底层同步服务 - 可直接访问以减少代理方法
   * 调用方可使用 sync.core.xxx 替代 sync.proxyMethod()
   */
  readonly core = inject(SimpleSyncService);
  /**
   * 【2026-05-16 单事实源】pendingCount 等同步状态字段必须通过 SyncStateService 公开 setter 写入。
   * 不允许再通过反射式 `core.state.update(...)` 绕过封装，避免与 RetryQueue.onProcessingStateChange
   * 在不同 tick 的竞争写入造成漂移。
   */
  private readonly syncStateService = inject(SyncStateService);
  
  private actionQueue = inject(ActionQueueService);
  // Sprint 9 技术债务修复：提取的处理器服务
  private actionQueueProcessors = inject(ActionQueueProcessorsService);
  // Sprint 9 技术债务修复：Delta Sync 协调器
  private deltaSyncCoordinator = inject(DeltaSyncCoordinatorService);
  // Sprint 9 技术债务修复：项目同步操作服务
  private projectSyncOps = inject(ProjectSyncOperationsService);
  private conflictService = inject(ConflictResolutionService);
  private conflictStorage = inject(ConflictStorageService);
  private changeTracker = inject(ChangeTrackerService);
  private projectState = inject(ProjectStateService);
  private authService = inject(AuthService);
  private toastService = inject(ToastService);
  private layoutService = inject(LayoutService);
  private sentryAlert = inject(SentryAlertService);
  private tabSync = inject(TabSyncService);
  private retryQueue = inject(RetryQueueService);
  private destroyRef = inject(DestroyRef);
  
  // Sprint 4 技术债务修复：提取的持久化调度服务
  private persistScheduler = inject(PersistSchedulerService);
  
  // 借鉴思源笔记的同步增强服务
  private syncModeService = inject(SyncModeService);
  private blackBoxSync = inject(BlackBoxSyncService);
  
  // ========== 同步状态 ==========
  
  /** 是否正在同步 */
  readonly isSyncing = computed(() => this.core.syncState().isSyncing);
  
  /** 是否在线 */
  readonly isOnline = computed(() => this.core.syncState().isOnline);
  
  /** 离线模式 */
  readonly offlineMode = computed(() => this.core.syncState().offlineMode);
  
  /** 会话是否过期 */
  readonly sessionExpired = computed(() => this.core.syncState().sessionExpired);
  
  /** 同步错误 */
  readonly syncError = computed(() => this.core.syncState().syncError);
  
  /** 是否有冲突 */
  readonly hasConflict = computed(() => this.core.syncState().hasConflict);
  
  /** 冲突数据 */
  readonly conflictData = computed(() => this.core.syncState().conflictData);
  
  /** 是否正在加载远程数据 */
  readonly isLoadingRemote = this.core.isLoadingRemote;
  
  /** 待处理的离线操作数量 */
  readonly pendingActionsCount = this.actionQueue.queueSize;
  
  // ========== 借鉴思源笔记的同步增强状态 ==========
  
  /** 当前同步模式 */
  readonly syncMode = computed(() => this.syncModeService.mode());
  
  /** 是否为自动同步模式 */
  readonly isAutoSyncMode = computed(() => this.syncModeService.isAutomatic());
  
  /** 是否启用同步感知（简化：默认 false） */
  readonly perceptionEnabled = computed(() => this.syncModeService.perceptionEnabled());

  // ========== 持久化状态 ==========
  
  private persistState = signal<PersistState>({
    isPersisting: false,
    hasPending: false,
    lastPersistAt: 0,
    hasPendingLocalChanges: false,
    lastUpdateType: 'structure'
  });
  
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private localSnapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private flushPendingPersistPromise: Promise<boolean> | null = null;
  private persistActiveProjectPromise: Promise<void> | null = null;
  private localChangeVersion = 0;
  
  /** 
   * 冲突事件 Subject - 使用发布-订阅模式替代回调
   * 
   * 优势：
   * 1. 解耦：SyncCoordinatorService 不需要知道谁在消费冲突事件
   * 2. 多订阅者：UI、日志、自动解决器可以同时订阅
   * 3. 类型安全：ConflictEvent 接口明确定义事件结构
   * 4. 可测试：Subject 比回调更容易 mock 和验证
   */
  private readonly conflict$ = new Subject<ConflictEvent>();
  private syncAttempts = 0;
  private syncConfirmed = 0;
  
  /** 
   * 冲突事件流（只读）
   * 订阅者应使用此 Observable 而非直接访问 Subject
   */
  readonly onConflict$ = this.conflict$.asObservable();
  
  /** 上次快照哈希，用于脏检查避免无变更写入 */
  private lastSnapshotHash = '';

  /** 是否已初始化（幂等保护） */
  private isInitialized = false;
  /** 跨标签本地回填冷却时间戳（按项目） */
  private tabSyncLocalRefreshAt = new Map<string, number>();
  /** 跨标签本地回填计数（观测用） */
  private tabSyncLocalRefreshCount = 0;
  /** 项目清单水位本地缓存键前缀（按用户隔离） */
  private readonly projectManifestWatermarkKeyPrefix = 'nanoflow.project-manifest-watermark';
  /** 黑匣子同步水位本地缓存键前缀（按用户隔离） */
  private readonly blackBoxManifestWatermarkKeyPrefix = 'nanoflow.blackbox-manifest-watermark';
  private authContextGeneration = 0;
  private lastObservedAuthUserId: string | null | undefined = undefined;

  constructor() {
    // 【性能审计 2026-02-07】延迟初始化：构造函数仅注入依赖，不启动副作用
    // 重型初始化（处理器注册、定时器、回调）延迟到 initialize() 调用
    this.destroyRef.onDestroy(() => {
      if (this.persistTimer) {
        clearTimeout(this.persistTimer);
      }
      if (this.localSnapshotTimer) {
        clearTimeout(this.localSnapshotTimer);
      }
      this.persistScheduler.stopLocalAutosave();
      this.destroy();
    });
  }

  /**
   * 初始化同步服务（延迟调用）
   *
   * 【性能审计 2026-02-07】从构造函数提取，避免阻塞首屏渲染
   * 由 AppComponent.ngOnInit 在首屏渲染后调用
   * 幂等：重复调用安全
   */
  initialize(): void {
    if (this.isInitialized) return;
    this.isInitialized = true;

    this.actionQueueProcessors.setProjectConflictHandler((localProject, remoteProject, ownerUserId, pendingTaskDeleteIds) => {
      this.publishConflict(localProject, remoteProject, ownerUserId, pendingTaskDeleteIds);
    });
    this.actionQueueProcessors.setupProcessors();
    this.validateRequiredProcessors();
    this.startLocalAutosave();
    this.setupSyncModeCallback();
    this.setupTabSyncLocalRefresh();
  }
  
  // ========== 借鉴思源笔记的同步增强方法 ==========
  
  /**
   * 设置同步模式回调
   * 当同步模式服务需要执行同步时，调用此回调
   */
  private setupSyncModeCallback(): void {
    this.syncModeService.setSyncCallback(async (direction: SyncDirection) => {
      await this.executeSyncByDirection(direction);
    });
  }

  /**
   * 根据方向执行同步（简化版）
   */
  private async executeSyncByDirection(direction: SyncDirection): Promise<void> {
    const userId = this.authService.currentUserId();
    if (!userId) return;
    
    switch (direction) {
      case 'upload':
        // 仅上传：保存活动项目到云端
        await this.persistActiveProject();
        break;
        
      case 'download':
        // 仅下载：从云端加载最新数据并智能合并
        await this.downloadAndMerge(userId);
        break;
        
      case 'both':
        // 双向同步：先上传本地变更，再下载远程变更并合并
        await this.persistActiveProject();
        await this.downloadAndMerge(userId);
        break;
    }
  }
  
  /**
   * 下载云端数据并智能合并到本地
   * 确保本地的软删除状态不会被远程数据覆盖
   */
  private async downloadAndMerge(userId: string): Promise<void> {
    const remoteProjectMetas = await this.core.loadProjectListMetadataFromCloud(userId, {
      timeout: TIMEOUT_CONFIG.STANDARD,
      retries: 1,
      silent: true,
      purpose: 'sync-download-merge',
      treatTransientFailureAsSoft: true,
    });

    if (remoteProjectMetas === null) {
      this.logger.info('远端项目元数据暂不可用，已跳过 download merge', { userId });
      return;
    }

    const accessibleProjectIds = new Set(remoteProjectMetas.map(project => project.id));
    const remoteProjects = remoteProjectMetas.length > 0
      ? await this.core.loadProjectsFromCloud(userId, true)
      : [];

    if (remoteProjectMetas.length > 0 && remoteProjects.length === 0) {
      this.logger.warn('远端项目元数据存在，但完整项目下载为空，已跳过 download merge', {
        userId,
        remoteCount: remoteProjectMetas.length,
      });
      return;
    }

    // 使用 getProjectsWithCurrentData 确保本地项目包含 TaskStore 中最新的任务数据
    const localProjects = this.projectState.getProjectsWithCurrentData();
    const localProjectMap = new Map(localProjects.map(p => [p.id, p]));
    const remoteProjectMap = new Map(remoteProjects.map(p => [p.id, p]));
    const missingRemoteProjectMetas = remoteProjectMetas.filter(project => !remoteProjectMap.has(project.id));

    if (missingRemoteProjectMetas.length > 0) {
      this.logger.warn('远端完整项目下载不完整，缺失项目将保留本地或回退为 metadata 壳', {
        userId,
        missingProjectIds: missingRemoteProjectMetas.map(project => project.id),
        remoteMetaCount: remoteProjectMetas.length,
        remoteLoadedCount: remoteProjects.length,
      });
    }
    
    // 智能合并每个项目
    const mergedProjects: Project[] = [];

    // 批量预热 tombstone 缓存：1 次 RPC 替代 N 次查询
    const projectIdsNeedingTombstones = remoteProjects
      .filter(rp => localProjectMap.has(rp.id))
      .map(rp => rp.id);
    if (projectIdsNeedingTombstones.length > 0) {
      await this.core.batchPreloadTombstones(projectIdsNeedingTombstones);
    }

    for (const remoteProject of remoteProjects) {
      const localProject = localProjectMap.get(remoteProject.id);
      if (!localProject) {
        // 远程新增的项目，直接使用
        mergedProjects.push(this.validateAndRebalance({
          ...remoteProject,
          syncSource: 'synced',
          pendingSync: false
        }));
        continue;
      }
      // 【关键修复】获取 tombstoneIds 防止已删除任务在合并时复活
      const tombstoneIds = await this.getTombstoneIds(remoteProject.id);
      const mergeResult = this.smartMerge(localProject, remoteProject, tombstoneIds);
      mergedProjects.push(this.validateAndRebalance({
        ...mergeResult.project,
        syncSource: 'synced',
        pendingSync: this.changeTracker.hasProjectChanges(remoteProject.id)
      }));
    }

    for (const remoteMeta of missingRemoteProjectMetas) {
      if (localProjectMap.has(remoteMeta.id)) {
        continue;
      }

      mergedProjects.push(this.validateAndRebalance({
        ...remoteMeta,
        tasks: Array.isArray(remoteMeta.tasks) ? remoteMeta.tasks : [],
        connections: Array.isArray(remoteMeta.connections) ? remoteMeta.connections : [],
        syncSource: 'synced',
        pendingSync: false,
      }));
    }

    // 保留 local-only 项目，禁止下载覆盖丢失
    for (const localProject of localProjects) {
      if (remoteProjectMap.has(localProject.id)) {
        continue;
      }

      const hasPendingChanges = localProject.pendingSync === true
        || this.changeTracker.hasProjectChanges(localProject.id)
        || this.hasPendingChangesForProject(localProject.id);

      if (accessibleProjectIds.has(localProject.id)) {
        mergedProjects.push(this.validateAndRebalance({
          ...localProject,
          syncSource: 'synced',
          pendingSync: hasPendingChanges,
        }));
        continue;
      }

      if (!hasPendingChanges && localProject.syncSource !== 'local-only') {
        this.logger.info('远端缺席且无待同步改动，已裁剪本地 synced 项目', {
          projectId: localProject.id
        });
        continue;
      }

      mergedProjects.push(this.validateAndRebalance({
        ...localProject,
        syncSource: 'local-only',
        pendingSync: true
      }));
    }
    
    // 更新本地状态
    this.projectState.setProjects(mergedProjects);

    const activeProjectId = this.projectState.activeProjectId() ?? this.projectState.activeProject()?.id ?? null;
    if (activeProjectId && !mergedProjects.some(project => project.id === activeProjectId)) {
      this.projectState.setActiveProjectId(mergedProjects[0]?.id ?? null);
    }

    this.core.saveOfflineSnapshot(mergedProjects);
  }

  /** 初始化同步感知（LWW 简化：空实现） */
  async initSyncPerception(_userId: string): Promise<void> { /* no-op */ }
  
  /** 停止同步感知（LWW 简化：空实现） */
  async stopSyncPerception(): Promise<void> { /* no-op */ }
  
  /** 创建同步检查点（LWW 简化：空实现） */
  async createSyncCheckpoint(_memo?: string): Promise<void> { /* no-op */ }
  
  /** 记录冲突到历史（LWW 简化：仅日志） */
  async recordConflictToHistory(projectId: string, _l: Project, _r: Project, reason: string): Promise<void> {
    this.logger.info('检测到冲突（LWW 自动处理）', { projectId, reason });
  }
  
  /** 设置同步模式 */
  setSyncMode(mode: 'automatic' | 'manual' | 'completely-manual'): void {
    this.syncModeService.setMode(mode);
  }
  
  /** 设置是否启用感知（LWW 简化：空实现） */
  async setPerceptionEnabled(_enabled: boolean): Promise<void> { /* no-op */ }
  
  /** 手动触发同步（所有模式下可用） */
  async triggerManualSync(direction: SyncDirection = 'both'): Promise<void> {
    await this.syncModeService.triggerSync(direction);
  }
  
  /**
   * 仅上传（完全手动模式下使用）
   */
  async uploadOnly(): Promise<void> {
    await this.syncModeService.uploadOnly();
  }
  
  /**
   * 仅下载（完全手动模式下使用）
   */
  async downloadOnly(): Promise<void> {
    await this.syncModeService.downloadOnly();
  }
  
  /**
   * 获取冲突历史统计（简化：返回空统计）
   */
  async getConflictStats(): Promise<{
    total: number;
    resolved: number;
    unresolved: number;
  }> {
    // LWW 简化：不再保存冲突历史
    return { total: 0, resolved: 0, unresolved: 0 };
  }
  
  /**
   * 获取检查点历史（简化：返回空数组）
   */
  async getCheckpointHistory(_limit = 20): Promise<unknown[]> {
    // LWW 简化：不再保存检查点历史
    return [];
  }

  // ========== 公共方法 ==========
  
  /**
   * 启动本地自动保存
   * 委托给 PersistSchedulerService 统一管理，消除双重定时器
   */
  private startLocalAutosave(): void {
    // 【双重写入修复】使用 PersistSchedulerService 统一管理自动保存定时器
    this.persistScheduler.setCallbacks({
      saveSnapshot: () => {
        const projects = this.projectState.projects();
        if (projects.length === 0) return;

        // 【P0 守卫 2026-03-27】当前用户为空或是本地模式兜底生成的种子数据时，
        // 禁止自动保存覆盖离线快照，防止 auth 失败降级场景下种子数据吞掉真实数据。
        const userId = this.authService.currentUserId();
        if (!userId) return;

        // 脏检查：计算简易哈希，跳过无变更的写入
        const hash = projects.map(p => `${p.id}:${p.updatedAt ?? ''}:${p.version ?? 0}`).join('|');
        if (hash === this.lastSnapshotHash) return;

        this.lastSnapshotHash = hash;
        this.core.saveOfflineSnapshot(projects);
      },
      doPersist: async () => {
        // 持久化交由 saveSnapshot 逻辑统一处理
      }
    });
    this.persistScheduler.startLocalAutosave();

    this.logger.info('本地自动保存已启动（委托 PersistSchedulerService）', {
      interval: `${SYNC_CONFIG.LOCAL_AUTOSAVE_INTERVAL}ms`,
      dirtyCheck: true
    });
  }
  
  // ========== 公共方法 ==========
  
  /**
   * 验证必需的处理器是否已注册
   * 在构造函数中调用，确保启动时就能发现配置问题
   */
  private validateRequiredProcessors(): void {
    const requiredProcessors = [
      'project:create',
      'project:update',
      'project:delete',
      'task:create',
      'task:update',
      'task:delete',
      'preference:update'
    ];
    
    const missing = this.actionQueue.validateProcessors(requiredProcessors);
    if (missing.length > 0) {
      // 开发环境下抛出错误，便于早期发现问题
      if (typeof ngDevMode !== 'undefined' && ngDevMode) {
        this.logger.error('缺少必需的 ActionQueue 处理器', {
          missing: missing.join(', '),
          registered: this.actionQueue.getRegisteredProcessorTypes()
        });
      }
    }
  }
  
  /**
   * 标记有本地变更待同步
   */
  markLocalChanges(updateType: 'content' | 'structure' | 'position' = 'structure') {
    this.localChangeVersion += 1;
    this.persistState.update(s => ({
      ...s,
      hasPendingLocalChanges: true,
      lastUpdateType: updateType
    }));

    this.markActiveProjectPendingSync();
    this.scheduleLocalSnapshotSave();
  }

  private markActiveProjectPendingSync(): void {
    const activeProjectId = this.projectState.activeProjectId() ?? this.projectState.activeProject()?.id ?? null;
    if (!activeProjectId) {
      return;
    }

    this.projectState.updateProjects(projects => projects.map(project => {
      if (project.id !== activeProjectId || project.pendingSync === true) {
        return project;
      }

      return {
        ...project,
        pendingSync: true,
      };
    }));
  }

  private scheduleLocalSnapshotSave(): void {
    if (this.localSnapshotTimer) {
      clearTimeout(this.localSnapshotTimer);
    }

    const debounceMs = Math.max(250, Math.min(SYNC_CONFIG.LOCAL_AUTOSAVE_INTERVAL, 1000));
    this.localSnapshotTimer = setTimeout(() => {
      this.localSnapshotTimer = null;
      // 【P0 修复】使用 getProjectsWithCurrentData 确保快照包含 TaskStore 最新数据
      const projects = this.projectState.getProjectsWithCurrentData();
      if (projects.length === 0) {
        return;
      }

      this.core.saveOfflineSnapshot(projects);
      this.logger.debug('本地快照已提前保存', { projectCount: projects.length });
    }, debounceMs);
  }
  
  /**
   * 获取上次更新类型
   */
  getLastUpdateType(): 'content' | 'structure' | 'position' {
    return this.persistState().lastUpdateType;
  }
  
  /**
   * 检查是否有待处理的本地变更
   */
  hasPendingLocalChanges(): boolean {
    return this.persistState().hasPendingLocalChanges;
  }
  
  /**
   * 获取上次持久化时间
   */
  getLastPersistAt(): number {
    return this.persistState().lastPersistAt;
  }
  
  /**
   * 调度持久化
   */
  schedulePersist() {
    this.scheduleLocalSnapshotSave();
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persistActiveProject();
    }, SYNC_CONFIG.DEBOUNCE_DELAY);
  }
  
  /**
   * 立即刷新待处理的持久化
   * 用于页面卸载前确保数据已保存
   * 注意：这是同步方法，只保存到本地缓存
   */
  flushPendingPersist(): void {
    const hadScheduledPersist = this.persistTimer !== null;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (this.localSnapshotTimer) {
      clearTimeout(this.localSnapshotTimer);
      this.localSnapshotTimer = null;
    }
    
    // 同步保存到本地缓存（不等待云端）
    // 【P0 修复】使用 getProjectsWithCurrentData 确保快照包含 TaskStore 最新数据
    const projects = this.projectState.getProjectsWithCurrentData();
    if (projects.length > 0) {
      this.core.saveOfflineSnapshot(projects);
      this.logger.info('页面卸载前已保存本地缓存', { projectCount: projects.length });
    }

    const shouldAttemptRemoteFlush = hadScheduledPersist || this.persistState().hasPendingLocalChanges;
    if (!shouldAttemptRemoteFlush) {
      return;
    }

    void this.flushPendingPersistToCloud('before-unload', { force: true });
  }

  async preparePendingPersistForOwnerChange(ownerUserId: string | null, reason: string): Promise<boolean> {
    const hadScheduledPersist = this.persistTimer !== null || this.localSnapshotTimer !== null;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (this.localSnapshotTimer) {
      clearTimeout(this.localSnapshotTimer);
      this.localSnapshotTimer = null;
    }

    // 【P0 修复】使用 getProjectsWithCurrentData 确保快照包含 TaskStore 最新数据
    const projects = this.projectState.getProjectsWithCurrentData();
    if (projects.length > 0) {
      this.core.saveOfflineSnapshot(projects, ownerUserId);
      this.logger.info('切换账号前已保存本地快照', {
        projectCount: projects.length,
        ownerUserId,
        reason,
      });
    }

    if (this.persistActiveProjectPromise) {
      await this.persistActiveProjectPromise;
    }

    const activeProjectId = this.projectState.activeProject()?.id ?? null;
    const pendingOwnerHandoffProjectIds = this.getPendingOwnerHandoffProjectIds(activeProjectId);

    const hasPendingLocalChanges = this.persistState().hasPendingLocalChanges;
    if (!hadScheduledPersist && !hasPendingLocalChanges && pendingOwnerHandoffProjectIds.size === 0) {
      return !this.hasProtectedOfflineProjects();
    }

    if (hadScheduledPersist || hasPendingLocalChanges) {
      await this.flushPendingPersistToCloud(reason, { force: true });
    }

    const remainingOwnerHandoffProjectIds = this.getPendingOwnerHandoffProjectIds(activeProjectId);
    if (remainingOwnerHandoffProjectIds.size === 0) {
      return !this.hasProtectedOfflineProjects();
    }

    const handedOffProjectIds = await this.handoffPendingProjectsToOwnerQueue(
      ownerUserId,
      reason,
      remainingOwnerHandoffProjectIds,
    );

    return !this.hasProtectedOfflineProjects(handedOffProjectIds);
  }

  private getPendingOwnerHandoffProjectIds(activeProjectId: string | null): Set<string> {
    const projectIds = new Set(this.changeTracker.getChangedProjectIds());

    // 中文注释：active project 的本轮本地编辑并不一定都会进入 ChangeTracker，owner switch 时必须一起转交。
    if (activeProjectId && this.persistState().hasPendingLocalChanges) {
      projectIds.add(activeProjectId);
    }

    return projectIds;
  }

  private hasProtectedOfflineProjects(excludedProjectIds?: Set<string>): boolean {
    return this.projectState.projects().some(project => {
      if (excludedProjectIds?.has(project.id)) {
        return false;
      }

      return project.pendingSync === true || project.syncSource === 'local-only';
    });
  }

  private async handoffPendingProjectsToOwnerQueue(
    ownerUserId: string | null,
    reason: string,
    projectIds: Set<string>,
  ): Promise<Set<string>> {
    const handedOffProjectIds = new Set<string>();

    for (const projectId of Array.from(projectIds)) {
      const activeProject = this.projectState.activeProject();
      const project = this.projectState.getProjectWithCurrentData(projectId)
        ?? (activeProject?.id === projectId ? activeProject : null);
      if (!project) {
        this.logger.error('切换账号前未找到待转交项目，拒绝继续 owner handoff', {
          projectId,
          ownerUserId,
          reason,
        });
        throw new Error(`Missing project for owner handoff: ${projectId}`);
      }

      if (!ownerUserId || ownerUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID || project.syncSource === 'local-only') {
        this.logger.info('切换账号前保留 owner 隔离快照作为最后副本', {
          projectId: project.id,
          ownerUserId,
          syncSource: project.syncSource,
          reason,
        });
        continue;
      }

      const changes = this.changeTracker.getProjectChanges(project.id);
      await this.actionQueue.enqueueForOwner(ownerUserId, {
        type: 'update',
        entityType: 'project',
        entityId: project.id,
        payload: {
          project: {
            ...project,
            syncSource: 'synced',
            pendingSync: true,
          },
          sourceUserId: ownerUserId,
          taskIdsToDelete: changes.taskIdsToDelete,
        }
      });
      handedOffProjectIds.add(project.id);
      this.logger.info('切换账号前已将待持久化项目转交原 owner 队列', {
        projectId: project.id,
        ownerUserId,
        taskDeleteCount: changes.taskIdsToDelete.length,
        reason,
      });
    }

    return handedOffProjectIds;
  }

  /**
   * 在页面切入后台/卸载前抢发一次云端持久化。
   * 同步本地快照仍是第一优先级；此方法仅在有待同步改动且在线时尝试补齐跨设备可见性。
   */
  async flushPendingPersistToCloud(reason: string, options?: { force?: boolean }): Promise<boolean> {
    if (this.flushPendingPersistPromise) {
      return this.flushPendingPersistPromise;
    }

    const state = this.persistState();
    const force = options?.force === true;
    const hasPendingTimer = this.persistTimer !== null;
    const hasPendingLocalChanges = state.hasPendingLocalChanges;
    if (!force && !hasPendingTimer && !hasPendingLocalChanges) {
      return false;
    }

    if (state.isPersisting) {
      this.persistState.update(s => ({
        ...s,
        hasPending: true,
        hasPendingLocalChanges: true,
      }));
      this.logger.debug('后台刷盘时已有持久化在进行，跳过重复触发', { reason });
      return false;
    }

    const userId = this.authService.currentUserId();
    if (!userId) {
      this.logger.debug('后台刷盘缺少有效用户，仅保留本地快照', { reason });
      return false;
    }

    const browserOnline = typeof navigator === 'undefined' ? this.core.syncState().isOnline : navigator.onLine;
    if (!this.core.syncState().isOnline && !browserOnline) {
      this.logger.debug('后台刷盘时当前离线，等待重试队列后续补齐', { reason });
      return false;
    }

    this.flushPendingPersistPromise = this.persistActiveProject()
      .then(() => !this.persistState().hasPendingLocalChanges)
      .finally(() => {
        this.flushPendingPersistPromise = null;
      });

    return this.flushPendingPersistPromise;
  }
  
  /**
   * 设置远程变更回调
   */
  setupRemoteChangeCallbacks(
    onRemoteChange: (payload: { eventType?: string; projectId?: string } | undefined) => Promise<void>,
    onTaskChange: (payload: { eventType: string; taskId: string; projectId: string }) => void
  ) {
    this.core.setRemoteChangeCallback(onRemoteChange);
    this.core.setTaskChangeCallback(onTaskChange);
  }

  /**
   * 跨标签页本地回填：
   * 收到 data-synced 广播后优先使用本地快照刷新内存，不触发网络请求。
   */
  private setupTabSyncLocalRefresh(): void {
    if (!FEATURE_FLAGS.TAB_SYNC_LOCAL_REFRESH_V1) {
      return;
    }

    this.tabSync.setOnDataSyncedCallback((projectId, updatedAt) => {
      this.handleTabSyncLocalRefresh(projectId, updatedAt);
    });
  }

  private handleTabSyncLocalRefresh(projectId: string, updatedAt: string): void {
    const now = Date.now();
    const lastRefreshAt = this.tabSyncLocalRefreshAt.get(projectId) ?? 0;
    if (now - lastRefreshAt < STARTUP_PERF_CONFIG.TAB_SYNC_LOCAL_REFRESH_COOLDOWN_MS) {
      return;
    }
    this.tabSyncLocalRefreshAt.set(projectId, now);

    if (this.hasPendingChangesForProject(projectId) || this.changeTracker.hasProjectChanges(projectId)) {
      return;
    }

    const snapshot = this.core.loadOfflineSnapshot();
    if (!snapshot || snapshot.length === 0) {
      return;
    }

    const snapshotProject = snapshot.find((project) => project.id === projectId);
    if (!snapshotProject) {
      return;
    }

    const currentProjects = this.projectState.projects();
    if (!currentProjects.some((project) => project.id === projectId)) {
      return;
    }

    this.projectState.updateProjects((projects) => projects.map((project) => {
      if (project.id !== projectId) {
        return project;
      }

      return this.validateAndRebalance({
        ...snapshotProject,
        pendingSync: false,
        syncSource: 'synced',
      });
    }));

    this.tabSyncLocalRefreshCount += 1;
    this.sentryLazyLoader.addBreadcrumb({
      category: 'tabsync',
      message: 'tabsync.local_refresh.count',
      level: 'info',
      data: {
        projectId,
        updatedAt,
        count: this.tabSyncLocalRefreshCount,
      },
    });
  }
  
  // ============================================================
  // 【按需加载优化 2026-01-27】单项目加载与待同步检测
  // ============================================================
  
  /**
   * 从云端加载单个项目（按需加载策略）
   * 
   * 【优化目的】避免加载所有项目，只加载用户需要的
   * - 首次同步只加载当前项目
   * - 用户切换项目时再加载目标项目
   * 
   * @param projectId 项目 ID
   * @returns 完整的项目数据
   */
  async loadSingleProjectFromCloud(projectId: string): Promise<Project | null> {
    return this.core.loadFullProjectOptimized(projectId);
  }
  
  /**
   * 检查项目是否有待同步的本地修改
   * 
   * 【LWW 竞态保护】如果有未同步的本地修改，合并时需要使用 LWW 策略
   * 避免云端旧数据覆盖本地新编辑
   * 
   * @param projectId 项目 ID
   * @returns 是否有待同步修改
   */
  hasPendingChangesForProject(projectId: string): boolean {
    // 检查 ActionQueue 中是否有该项目的待处理操作
    const pendingActions = this.actionQueue.getPendingActionsForProject(projectId);
    return pendingActions.length > 0;
  }

  private hasPendingProjectQueueReplay(projectId: string): boolean {
    return this.actionQueue.getPendingActionsForProject(projectId).some(action =>
      action.entityType === 'project' && action.entityId === projectId
    );
  }

  // ============================================================
  // 【Stingy Hoarder Protocol】Delta Sync 增量同步入口
  // @see docs/plan_save.md Phase 3
  // ============================================================

  /**
   * Delta Sync 增量同步
   * 
   * 【核心优化】从 MB 级全量拉取降至 ~1 KB 增量检查
   * 
   * 流程：
   * 1. 调用 SimpleSyncService.checkForDrift() 获取增量变更
   * 2. 将增量数据合并到当前项目
   * 3. 更新 ProjectStateService
   * 
   * @param projectId 项目 ID
   * @returns 变更数量，0 表示无变更
   */
  async performDeltaSync(projectId: string): Promise<{ taskChanges: number; connectionChanges: number }> {
    // Sprint 9 技术债务修复：委托给 DeltaSyncCoordinatorService
    return this.deltaSyncCoordinator.performDeltaSync(projectId);
  }
  
  /**
   * 安全批量软删除任务（服务端防护）
   * 
   * 【P0 熔断层】使用 safe_delete_tasks RPC 确保批量删除不会超过限制：
   * - 单次删除不能超过 50% 或 50 条任务
   * - 项目任务数 > 10 时，不允许删到 0
   * 
   * @param projectId 项目 ID
   * @param taskIds 要删除的任务 ID 列表
   * @returns 实际删除的任务数量，-1 表示被服务端拒绝
   */
  async softDeleteTasksBatch(
    projectId: string,
    taskIds: string[],
    tombstoneTimestamps?: Record<string, string | number | null | undefined>,
  ): Promise<number> {
    return this.core.softDeleteTasksBatch(projectId, taskIds, tombstoneTimestamps);
  }
  
  /**
   * 重新同步当前活动项目
   * 
   * 【设计哲学】
   * 这不是暴力的 Force Push/Pull，而是智能的重新同步：
   * 1. 从云端拉取最新数据
   * 2. 与本地数据进行智能合并（使用现有的 smartMerge 逻辑）
   * 3. 如果发现真正的冲突，静默保存到冲突仓库
   * 4. 更新本地状态
   * 
   * @returns 同步结果
   */
  async resyncActiveProject(): Promise<{
    success: boolean;
    message: string;
    conflictDetected?: boolean;
  }> {
    // Sprint 9 技术债务修复：委托给 ProjectSyncOperationsService
    return this.projectSyncOps.resyncActiveProject(
      (projectId) => this.getTombstoneIds(projectId)
    );
  }

  /**
   * 静默刷新当前活动项目
   *
   * 恢复链路专用：优先走水位快路，只有检测到远端更新时才拉取完整项目。
   */
  async refreshActiveProjectSilent(reason: string): Promise<{
    refreshed: boolean;
    skippedReason?: string;
    fastPathHit?: boolean;
  }> {
    const projectId = this.projectState.activeProjectId();
    if (!projectId) {
      return { refreshed: false, skippedReason: 'no-active-project' };
    }

    const userId = this.authService.currentUserId();
    if (!userId) {
      return { refreshed: false, skippedReason: 'unauthenticated' };
    }

    const localProject = this.projectState.getProject(projectId);
    const localWatermarkMs = this.computeLocalProjectWatermark(localProject);
    let remoteWatermark: string | null = null;

    if (FEATURE_FLAGS.RESUME_WATERMARK_RPC_V1) {
      const probe = await this.core.getAccessibleProjectProbe(projectId);
      if (probe) {
        if (!probe.accessible) {
          return { refreshed: false, skippedReason: 'remote-project-missing' };
        }
        remoteWatermark = probe.watermark;
      } else {
        // probe 不可用时回退到旧水位 RPC
        remoteWatermark = await this.core.getProjectSyncWatermark(projectId);
      }

      if (remoteWatermark) {
        const remoteUpdatedAtMs = new Date(remoteWatermark).getTime();
        if (Number.isFinite(remoteUpdatedAtMs) && remoteUpdatedAtMs <= localWatermarkMs) {
          await this.core.commitProjectSyncTimestamp(projectId, remoteWatermark);
          this.sentryLazyLoader.addBreadcrumb({
            category: 'sync',
            message: 'resume.refresh.fast_path_hit',
            level: 'info',
            data: {
              reason,
              projectId,
              remoteWatermark,
              localWatermark: localWatermarkMs > 0 ? new Date(localWatermarkMs).toISOString() : null
            }
          });
          return {
            refreshed: false,
            skippedReason: 'watermark-not-newer',
            fastPathHit: true
          };
        }
      }
    }

    const remoteProject = await this.loadSingleProjectFromCloud(projectId);
    if (!remoteProject) {
      return { refreshed: false, skippedReason: 'remote-project-missing' };
    }

    const mergedProject = localProject
      ? this.smartMerge(localProject, remoteProject, await this.getTombstoneIds(projectId)).project
      : remoteProject;

    const validatedProject = this.validateAndRebalance(mergedProject);

    this.projectState.updateProjects((projects) => {
      const exists = projects.some(project => project.id === validatedProject.id);
      if (!exists) {
        return [...projects, validatedProject];
      }
      return projects.map(project => project.id === validatedProject.id ? validatedProject : project);
    });

    await this.core.saveOfflineSnapshotAndWait(this.projectState.projects());

    const validatedWatermarkMs = this.computeLocalProjectWatermark(validatedProject);
    const nextCursor = this.core.buildProjectSyncCursorFromProject(remoteProject);
    if (nextCursor) {
      await this.core.commitProjectSyncCursor(projectId, nextCursor);
    } else {
      const cursorWatermark = remoteWatermark
        ?? (validatedWatermarkMs > 0 ? new Date(validatedWatermarkMs).toISOString() : null);
      if (cursorWatermark) {
        await this.core.commitProjectSyncTimestamp(projectId, cursorWatermark);
      }
    }
    this.sentryLazyLoader.addBreadcrumb({
      category: 'sync',
      message: 'resume.refresh.applied',
      level: 'info',
      data: {
        reason,
        projectId,
        taskCount: validatedProject.tasks.length,
        connectionCount: validatedProject.connections.length
      }
    });

    return { refreshed: true, fastPathHit: false };
  }

  /**
   * 刷新项目清单元数据（恢复/后台同步快路）
   *
   * 仅在远端用户项目水位更新时才同步项目头信息，避免无效项目列表重拉。
   */
  async refreshProjectManifestIfNeeded(
    reason: string,
    options?: { prefetchedRemoteWatermark?: string | null; deferCommit?: boolean }
  ): Promise<{ skipped: boolean; watermark?: string }> {
    if (!FEATURE_FLAGS.USER_PROJECTS_WATERMARK_RPC_V1) {
      return { skipped: false };
    }

    const userId = this.authService.currentUserId();
    if (!userId) {
      return { skipped: true };
    }

    const hasPrefetchedWatermark = options
      ? Object.prototype.hasOwnProperty.call(options, 'prefetchedRemoteWatermark')
      : false;
    const remoteWatermark = hasPrefetchedWatermark
      ? (options?.prefetchedRemoteWatermark ?? null)
      : await this.core.getUserProjectsWatermark();
    if (!remoteWatermark) {
      return { skipped: false };
    }

    const localWatermark = this.readProjectManifestWatermark(userId);
    const remoteMs = new Date(remoteWatermark).getTime();
    const localMs = localWatermark ? new Date(localWatermark).getTime() : Number.NaN;
    const hasValidLocalWatermark = !!localWatermark && Number.isFinite(localMs);

    if (
      Number.isFinite(remoteMs) &&
      hasValidLocalWatermark &&
      remoteMs <= localMs
    ) {
      this.sentryLazyLoader.addBreadcrumb({
        category: 'sync',
        message: 'manifest.refresh.fast_path_hit',
        level: 'info',
        data: { reason, localWatermark, remoteWatermark }
      });
      return { skipped: true, watermark: remoteWatermark };
    }

    // 冷启动/本地无水位时，不执行头信息 RPC，直接交由慢路元数据同步。
    if (!hasValidLocalWatermark) {
      if (!options?.deferCommit) {
        this.writeProjectManifestWatermark(remoteWatermark, userId);
      }
      this.sentryLazyLoader.addBreadcrumb({
        category: 'sync',
        message: 'manifest.refresh.cold_start_deferred',
        level: 'info',
        data: { reason, remoteWatermark }
      });
      return { skipped: false, watermark: remoteWatermark };
    }

    const heads = await this.core.listProjectHeadsSince(localWatermark);
    if (heads.length > 0) {
      const headsById = new Map(heads.map(head => [head.id, head]));
      this.projectState.updateProjects((projects) => projects.map((project) => {
        const head = headsById.get(project.id);
        if (!head) return project;

        return {
          ...project,
          updatedAt: head.updatedAt || project.updatedAt,
          version: Number.isFinite(head.version) ? head.version : (project.version ?? 1),
        };
      }));
    }

    if (!options?.deferCommit) {
      this.writeProjectManifestWatermark(remoteWatermark, userId);
    }
    this.sentryLazyLoader.addBreadcrumb({
      category: 'sync',
      message: 'manifest.refresh.applied',
      level: 'info',
      data: {
        reason,
        changedProjects: heads.length,
        localWatermark,
        remoteWatermark
      }
    });
    // heads 为空并不代表远端无变更，不允许据此跳过后续慢路。
    return { skipped: false, watermark: remoteWatermark };
  }

  commitProjectManifestWatermark(watermark: string, userId?: string | null): void {
    this.writeProjectManifestWatermark(watermark, userId ?? this.authService.currentUserId());
  }

  /**
   * 刷新黑匣子域水位（恢复链路快路）
   *
   * 无变更时仅 watermark RPC；有变更时再拉取明细。
   */
  async refreshBlackBoxWatermarkIfNeeded(
    reason: string,
    options?: { prefetchedRemoteWatermark?: string | null }
  ): Promise<{ skipped: boolean; watermark?: string }> {
    if (!FEATURE_FLAGS.BLACKBOX_WATERMARK_PROBE_V1) {
      await this.blackBoxSync.pullChanges({ reason: reason.includes('resume') ? 'resume' : 'startup' });
      return { skipped: false };
    }

    const hasPrefetchedWatermark = options
      ? Object.prototype.hasOwnProperty.call(options, 'prefetchedRemoteWatermark')
      : false;
    const remoteWatermark = hasPrefetchedWatermark
      ? (options?.prefetchedRemoteWatermark ?? null)
      : await this.core.getBlackBoxSyncWatermark();
    if (!remoteWatermark) {
      await this.blackBoxSync.pullChanges({ reason: reason.includes('resume') ? 'resume' : 'startup' });
      return { skipped: false };
    }

    const userId = this.authService.currentUserId();
    const localWatermark = this.readBlackBoxManifestWatermark(userId);
    const remoteMs = new Date(remoteWatermark).getTime();
    const localMs = localWatermark ? new Date(localWatermark).getTime() : 0;

    if (
      Number.isFinite(remoteMs) &&
      Number.isFinite(localMs) &&
      remoteMs <= localMs
    ) {
      this.sentryLazyLoader.addBreadcrumb({
        category: 'sync',
        message: 'blackbox.refresh.fast_path_hit',
        level: 'info',
        data: { reason, remoteWatermark, localWatermark }
      });
      return { skipped: true, watermark: remoteWatermark };
    }

    await this.blackBoxSync.pullChanges({ reason: reason.includes('resume') ? 'resume' : 'startup' });
    this.writeBlackBoxManifestWatermark(remoteWatermark, userId);
    this.sentryLazyLoader.addBreadcrumb({
      category: 'sync',
      message: 'blackbox.refresh.applied',
      level: 'info',
      data: { reason, remoteWatermark, localWatermark }
    });
    return { skipped: false, watermark: remoteWatermark };
  }

  private computeLocalProjectWatermark(project: Project | undefined): number {
    if (!project) return 0;

    let maxUpdatedAtMs = 0;
    const track = (value?: string | null) => {
      if (!value) return;
      const ts = new Date(value).getTime();
      if (Number.isFinite(ts)) {
        maxUpdatedAtMs = Math.max(maxUpdatedAtMs, ts);
      }
    };

    track(project.updatedAt);
    for (const task of project.tasks ?? []) {
      track(task.updatedAt);
      track(task.deletedAt);
    }
    for (const connection of project.connections ?? []) {
      track(connection.updatedAt);
      track(connection.deletedAt);
    }

    return maxUpdatedAtMs;
  }

  private resolveScopedWatermarkKey(prefix: string, userId: string | null | undefined): string | null {
    const normalizedUserId = userId?.trim();
    if (!normalizedUserId) {
      return null;
    }
    return `${prefix}.${normalizedUserId}`;
  }

  private readProjectManifestWatermark(userId: string | null): string | null {
    if (typeof localStorage === 'undefined') {
      return null;
    }

    const scopedKey = this.resolveScopedWatermarkKey(this.projectManifestWatermarkKeyPrefix, userId);
    if (!scopedKey) {
      return null;
    }

    try {
      return localStorage.getItem(scopedKey);
    } catch {
      // eslint-disable-next-line no-restricted-syntax -- localStorage 读取在隐私模式/存储满时可能抛异常，此处降级返回 null 触发全量拉取
      return null;
    }
  }

  private writeProjectManifestWatermark(watermark: string, userId: string | null): void {
    if (typeof localStorage === 'undefined') {
      return;
    }

    const scopedKey = this.resolveScopedWatermarkKey(this.projectManifestWatermarkKeyPrefix, userId);
    if (!scopedKey) {
      return;
    }

    try {
      localStorage.setItem(scopedKey, watermark);
    } catch (error) {
      this.logger.debug('写入项目清单水位失败', { error });
    }
  }

  private readBlackBoxManifestWatermark(userId: string | null): string | null {
    if (typeof localStorage === 'undefined') {
      return null;
    }
    const scopedKey = this.resolveScopedWatermarkKey(this.blackBoxManifestWatermarkKeyPrefix, userId);
    if (!scopedKey) {
      return null;
    }
    try {
      return localStorage.getItem(scopedKey);
    } catch {
      // eslint-disable-next-line no-restricted-syntax -- localStorage 读取在隐私模式/存储满时可能抛异常，此处降级返回 null 触发全量拉取
      return null;
    }
  }

  private writeBlackBoxManifestWatermark(watermark: string, userId: string | null): void {
    if (typeof localStorage === 'undefined') {
      return;
    }
    const scopedKey = this.resolveScopedWatermarkKey(this.blackBoxManifestWatermarkKeyPrefix, userId);
    if (!scopedKey) {
      return;
    }
    try {
      localStorage.setItem(scopedKey, watermark);
    } catch (error) {
      this.logger.debug('写入黑匣子水位失败', { error });
    }
  }
  
  /**
   * 静默保存冲突到仓库（不弹窗）
   */
  private async saveConflictSilently(
    localProject: Project, 
    remoteProject: Project | undefined,
    conflictedFields: string[],
    ownerUserId?: string | null,
    pendingTaskDeleteIds?: string[],
    conflictedAt?: string,
  ): Promise<void> {
    await this.conflictStorage.saveConflict({
      projectId: localProject.id,
      localProject,
      remoteProject,
      ownerUserId: ownerUserId ?? undefined,
      remoteSnapshotFresh: !!remoteProject,
      conflictedAt: conflictedAt ?? new Date().toISOString(),
      localVersion: localProject.version ?? 0,
      remoteVersion: remoteProject?.version ?? 0,
      reason: 'version_mismatch',
      conflictedFields,
      pendingTaskDeleteIds,
      acknowledged: false
    });
  }

  private publishConflict(
    localProject: Project,
    remoteProject: Project,
    ownerUserId?: string | null,
    pendingTaskDeleteIds?: string[],
  ): void {
    const activeConflict = this.conflictData();
    if (this.isDuplicateActiveConflict(activeConflict, localProject, remoteProject, pendingTaskDeleteIds)) {
      void this.saveConflictSilently(
        localProject,
        remoteProject,
        [],
        ownerUserId,
        pendingTaskDeleteIds,
        activeConflict?.conflictedAt,
      ).catch(error => {
        this.logger.warn('保存重复冲突隔离区记录失败', { error, projectId: localProject.id });
      });
      this.logger.debug('跳过重复冲突发布', { projectId: localProject.id });
      return;
    }

    const conflictedAt = new Date().toISOString();
    void this.saveConflictSilently(localProject, remoteProject, [], ownerUserId, pendingTaskDeleteIds, conflictedAt).catch(error => {
      this.logger.warn('保存冲突隔离区记录失败', { error, projectId: localProject.id });
    });
    const conflictData: SyncConflictData = {
      local: localProject,
      remote: remoteProject,
      projectId: localProject.id,
      conflictedAt,
      pendingTaskDeleteIds,
    };
    this.core.setConflict(conflictData);
    this.conflict$.next({
      localProject,
      remoteProject,
      projectId: localProject.id,
      pendingTaskDeleteIds,
    });
  }

  private isDuplicateActiveConflict(
    activeConflict: SyncConflictData | null,
    localProject: Project,
    remoteProject: Project,
    pendingTaskDeleteIds?: string[],
  ): boolean {
    if (!activeConflict || activeConflict.projectId !== localProject.id) {
      return false;
    }

    return this.buildConflictSnapshotSignature(
      activeConflict.local,
      activeConflict.remote,
      activeConflict.pendingTaskDeleteIds,
    ) === this.buildConflictSnapshotSignature(localProject, remoteProject, pendingTaskDeleteIds);
  }

  private buildConflictSnapshotSignature(
    localProject: Project | undefined,
    remoteProject: Project | undefined,
    pendingTaskDeleteIds?: string[],
  ): string {
    return JSON.stringify({
      localProject: localProject ?? null,
      remoteProject: remoteProject ?? null,
      pendingTaskDeleteIds: [...(pendingTaskDeleteIds ?? [])].sort(),
    });
  }
  
  /**
   * 尝试重新加载冲突数据
   */
  async tryReloadConflictData(
    userId: string, 
    findProject: (id: string) => Project | undefined
  ) {
    return this.core.tryReloadConflictData(userId, findProject);
  }
  
  /**
   * 解决数据冲突
   */
  async resolveConflict(
    projectId: string,
    choice: 'local' | 'remote' | 'merge',
    localProject: Project,
    remoteProject: Project | undefined
  ): Promise<Result<Project, OperationError>> {
    return this.conflictService.resolveConflict(
      projectId,
      choice,
      localProject,
      remoteProject
    );
  }

  async resolveConflictWithPlan(
    projectId: string,
    plan: ConflictResolutionPlan,
    localProject: Project,
    remoteProject: Project | undefined,
  ): Promise<Result<Project, OperationError>> {
    return this.conflictService.resolveConflictWithPlan(
      projectId,
      plan,
      localProject,
      remoteProject,
    );
  }

  async captureConflict(
    localProject: Project,
    remoteProject?: Project,
    ownerUserId?: string | null,
    pendingTaskDeleteIds?: string[],
  ): Promise<void> {
    if (remoteProject) {
      this.publishConflict(localProject, remoteProject, ownerUserId, pendingTaskDeleteIds);
      return;
    }

    await this.saveConflictSilently(localProject, undefined, [], ownerUserId, pendingTaskDeleteIds);
  }

  clearActiveConflict(): void {
    this.core.clearConflict();
  }
  
  /**
   * 智能合并项目
   * 
   * @param localProject 本地项目
   * @param remoteProject 远程项目  
   * @param tombstoneIds 已永久删除的任务 ID 集合（必需参数）
   */
  smartMerge(localProject: Project, remoteProject: Project, tombstoneIds: Set<string>) {
    return this.conflictService.smartMerge(localProject, remoteProject, tombstoneIds);
  }
  
  /**
   * 获取项目的 tombstone IDs
   */
  async getTombstoneIds(projectId: string): Promise<Set<string>> {
    return this.core.getTombstoneIds(projectId);
  }
  
  /**
   * 合并离线数据
   * 返回冲突项目列表供调用者处理
   * 
   * 合并策略：
   * 1. 云端不存在的项目 → 直接上传
   * 2. 离线版本号 > 云端版本号 → 上传离线数据
   * 3. 版本号相同时 → 比较 updatedAt 时间戳和任务内容
   * 4. 版本号相同但内容不同 → 保留本地数据（用户最近编辑的）
   */
  async mergeOfflineDataOnReconnect(
    cloudProjects: Project[],
    offlineProjects: Project[],
    userId: string
  ): Promise<{ projects: Project[]; syncedCount: number; conflictProjects: Project[] }> {
    // Sprint 9 技术债务修复：委托给 ProjectSyncOperationsService
    const result = await this.projectSyncOps.mergeOfflineDataOnReconnect(
      cloudProjects,
      offlineProjects,
      userId,
      (projectId) => this.getTombstoneIds(projectId),
      (local, remote) => this.publishConflict(local, remote)
    );

    // 同时同步黑匣子数据（不阻塞主流程）
    this.blackBoxSync.forceSync().catch(e => {
      this.logger.warn('黑匣子重连同步失败（非阻塞）', e);
    });

    return result;
  }
  
  /**
   * 验证并重新平衡项目
   */
  validateAndRebalanceWithResult(project: Project): Result<Project, OperationError> {
    // Sprint 9 技术债务修复：委托给 ProjectSyncOperationsService
    return this.projectSyncOps.validateAndRebalanceWithResult(project);
  }
  
  /**
   * 验证并重新平衡项目（简化版，出错时返回清理后的项目）
   */
  validateAndRebalance(project: Project): Project {
    // Sprint 9 技术债务修复：委托给 ProjectSyncOperationsService
    return this.projectSyncOps.validateAndRebalance(project);
  }

  
  /**
   * 销毁服务
   */
  destroy() {
    // 完成冲突事件 Subject
    this.conflict$.complete();
    this.tabSyncLocalRefreshAt.clear();
    if (FEATURE_FLAGS.TAB_SYNC_LOCAL_REFRESH_V1) {
      this.tabSync.setOnDataSyncedCallback(() => {});
    }
    this.core.destroy();
  }
  
  // ========== 私有方法 ==========
  
  private async persistActiveProject() {
    const state = this.persistState();
    if (state.isPersisting) {
      this.persistState.update(s => ({ ...s, hasPending: true }));
      return;
    }
    const runPersist = async () => {
      const persistVersion = this.localChangeVersion;

      this.persistState.update(s => ({ ...s, isPersisting: true }));
      let outcome: PersistOutcome = { remoteConfirmed: false };

      try {
        outcome = await this.doPersistActiveProject(persistVersion);
      } finally {
        const currentState = this.persistState();
        const shouldClearPendingLocalChanges = outcome.remoteConfirmed
          && this.shouldClearProjectDirtyState(persistVersion);
        this.persistState.update(s => ({ 
          ...s, 
          isPersisting: false,
          lastPersistAt: Date.now(),
          hasPendingLocalChanges: shouldClearPendingLocalChanges
            ? false
            : currentState.hasPendingLocalChanges
        }));

        if (currentState.hasPending) {
          this.persistState.update(s => ({ ...s, hasPending: false }));
          this.schedulePersist();
        }

        this.updateSyncObservability(outcome);
      }
    };

    this.persistActiveProjectPromise = runPersist().finally(() => {
      this.persistActiveProjectPromise = null;
    });
    await this.persistActiveProjectPromise;
  }

  private shouldClearProjectDirtyState(persistVersion: number): boolean {
    const state = this.persistState();
    return this.localChangeVersion === persistVersion && !state.hasPending;
  }

  private syncAuthContextGeneration(): void {
    const currentUserId = this.authService.currentUserId();
    if (this.lastObservedAuthUserId === undefined) {
      this.lastObservedAuthUserId = currentUserId;
      this.authContextGeneration = 1;
      return;
    }

    if (this.lastObservedAuthUserId !== currentUserId) {
      this.lastObservedAuthUserId = currentUserId;
      this.authContextGeneration += 1;
    }
  }

  private captureAuthContext(userId: string | null): { userId: string | null; generation: number } {
    this.syncAuthContextGeneration();
    return {
      userId,
      generation: this.authContextGeneration,
    };
  }

  private isAuthContextCurrent(
    context: { userId: string | null; generation: number },
    stage: string,
    projectId: string
  ): boolean {
    this.syncAuthContextGeneration();
    if (context.generation === this.authContextGeneration && this.authService.currentUserId() === context.userId) {
      return true;
    }

    this.logger.debug('忽略过期的自动持久化结果', {
      stage,
      projectId,
      expectedUserId: context.userId,
      currentUserId: this.authService.currentUserId(),
      generation: context.generation,
      currentGeneration: this.authContextGeneration,
    });
    return false;
  }

  private buildPersistTaskSignature(task: Task): string {
    return JSON.stringify([
      task.id,
      task.updatedAt ?? '',
      task.parentId ?? '',
      task.stage ?? '',
      task.order,
      task.rank,
      task.displayId,
      task.x,
      task.y,
      task.status,
      task.deletedAt ?? '',
      task.shortId ?? '',
    ]);
  }

  private buildPersistConnectionSignature(connection: Connection): string {
    return JSON.stringify([
      connection.id,
      connection.source,
      connection.target,
      connection.title ?? '',
      connection.description ?? '',
      connection.updatedAt ?? '',
      connection.deletedAt ?? '',
    ]);
  }

  private buildPersistDataSignature(project: Project): string {
    const taskSignature = [...project.tasks]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(task => this.buildPersistTaskSignature(task));
    const connectionSignature = [...project.connections]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(connection => this.buildPersistConnectionSignature(connection));

    return JSON.stringify({ taskSignature, connectionSignature });
  }

  private reconcileStaleRetryEntries(
    projectId: string,
    supersededTaskIds: string[],
    supersededConnectionIds: string[],
    deletedTaskIds: string[],
  ): void {
    const removedTaskIds = supersededTaskIds.length > 0
      ? this.retryQueue.removeByEntities('task', supersededTaskIds)
      : [];
    const removedConnectionIds = supersededConnectionIds.length > 0
      ? this.retryQueue.removeByEntities('connection', supersededConnectionIds)
      : [];
    const removedConnectionIdsByTask = deletedTaskIds.length > 0
      ? this.retryQueue.removeConnectionsReferencingTasks(projectId, deletedTaskIds)
      : [];

    if (
      removedTaskIds.length === 0
      && removedConnectionIds.length === 0
      && removedConnectionIdsByTask.length === 0
    ) {
      return;
    }

    const coreState = this.core.state as unknown as {
      update?: (
        updater: (state: Record<string, unknown> & { pendingCount: number }) => Record<string, unknown> & { pendingCount: number },
      ) => void;
    };
    // 【2026-05-16 单事实源化】保留反射式 update 作为向后兼容路径（避免影响仍在使用旧 mock 的测试），
    // 但优先通过 SyncStateService 公开 setter 写入，保证 pendingCount 写入路径统一。
    this.syncStateService.setPendingCount(this.retryQueue.length);
    coreState.update?.(state => ({
      ...state,
      pendingCount: this.retryQueue.length,
    }));

    this.logger.info('自动持久化前已清理陈旧重试项', {
      projectId,
      removedTaskRetryCount: removedTaskIds.length,
      removedConnectionRetryCount: removedConnectionIds.length + removedConnectionIdsByTask.length,
    });
  }
  
  private async doPersistActiveProject(persistVersion: number): Promise<PersistOutcome> {
    const activeProject = this.projectState.activeProject();
    const activeProjectId = this.projectState.activeProjectId() ?? activeProject?.id ?? null;
    // 【P0 修复】使用 getProjectsWithCurrentData 确保快照包含 TaskStore 最新数据
    const projects = this.projectState.getProjectsWithCurrentData();
    const currentProject = activeProjectId
      ? projects.find(candidate => candidate.id === activeProjectId) ?? activeProject ?? null
      : activeProject;
    const now = new Date().toISOString();

    if (activeProject && currentProject && activeProject.id === currentProject.id) {
      const activeSignature = this.buildPersistDataSignature(activeProject);
      const currentSignature = this.buildPersistDataSignature(currentProject);
      if (activeSignature !== currentSignature) {
        const activeTasksById = new Map(activeProject.tasks.map(task => [task.id, task]));
        const activeConnectionsById = new Map(activeProject.connections.map(connection => [connection.id, connection]));
        const currentTaskIds = new Set(currentProject.tasks.map(task => task.id));
        const currentConnectionIds = new Set(currentProject.connections.map(connection => connection.id));
        const staleTaskIds = activeProject.tasks
          .filter(task => !currentTaskIds.has(task.id))
          .map(task => task.id);
        const changedTaskIds = currentProject.tasks
          .filter(task => {
            const activeTask = activeTasksById.get(task.id);
            return activeTask !== undefined
              && this.buildPersistTaskSignature(activeTask) !== this.buildPersistTaskSignature(task);
          })
          .map(task => task.id);
        const staleConnectionIds = activeProject.connections
          .filter(connection => !currentConnectionIds.has(connection.id))
          .map(connection => connection.id);
        const changedConnectionIds = currentProject.connections
          .filter(connection => {
            const activeConnection = activeConnectionsById.get(connection.id);
            return activeConnection !== undefined
              && this.buildPersistConnectionSignature(activeConnection) !== this.buildPersistConnectionSignature(connection);
          })
          .map(connection => connection.id);
        const supersededTaskIds = Array.from(new Set([...staleTaskIds, ...changedTaskIds]));
        const supersededConnectionIds = Array.from(new Set([...staleConnectionIds, ...changedConnectionIds]));

        this.projectState.setProjects(projects);
        this.reconcileStaleRetryEntries(
          currentProject.id,
          supersededTaskIds,
          supersededConnectionIds,
          staleTaskIds,
        );

        this.logger.info('自动持久化改用当前 store 快照，已修复 ProjectStore 陈旧任务/连接', {
          projectId: currentProject.id,
          staleTaskCount: staleTaskIds.length,
          staleConnectionCount: staleConnectionIds.length,
          changedTaskCount: changedTaskIds.length,
          changedConnectionCount: changedConnectionIds.length,
        });
      }
    }

    const project = currentProject
      ? { ...currentProject, updatedAt: now }
      : null;
    
    // 更新活动项目的 updatedAt 时间戳
    const updatedProjects = projects.map(p => 
      p.id === project?.id ? { ...p, updatedAt: now } : p
    );
    
    // 始终先保存到本地离线快照（防止任何情况下的数据丢失）
    // 注意：这里使用更新后的项目列表，确保 updatedAt 被保存
    this.core.saveOfflineSnapshot(updatedProjects);
    
    if (!project) {
      return { remoteConfirmed: false };
    }

    const userId = this.authService.currentUserId();
    if (!userId) {
      // 未登录时仅保存到本地，但需要更新本地状态的 updatedAt
      this.projectState.updateProjects(ps =>
        ps.map(p => p.id === project.id ? { ...p, updatedAt: now } : p)
      );
      return { remoteConfirmed: false, projectId: project.id };
    }

    // 若该项目已有未解决的冲突：
    // - 只做本地快照（上面已做），不再反复触发云端保存与冲突弹窗；
    // - 让用户在合适时机进入冲突解决流程。
    const existingConflict = this.conflictData();
    if (this.hasConflict() && existingConflict && (existingConflict as { projectId?: string }).projectId === project.id) {
      this.logger.info('存在未解决冲突，跳过云端持久化', { projectId: project.id });
      return { remoteConfirmed: false, projectId: project.id };
    }

    if (project.syncSource === 'local-only') {
      this.logger.info('local-only 项目跳过自动云端持久化，等待用户迁移决策', {
        projectId: project.id,
      });
      this.projectState.updateProjects(ps =>
        ps.map(p =>
          p.id === project.id
            ? {
                ...p,
                updatedAt: now,
                syncSource: 'local-only',
                pendingSync: userId === AUTH_CONFIG.LOCAL_MODE_USER_ID
                  ? (p.pendingSync ?? false)
                  : true,
              }
            : p
        )
      );
      this.core.saveOfflineSnapshot(this.projectState.getProjectsWithCurrentData());
      return { remoteConfirmed: false, projectId: project.id };
    }

    const authContext = this.captureAuthContext(userId);

    try {
      // 使用智能同步：根据变更量自动选择增量或全量同步
      const result = await this.core.saveProjectSmart(
        { ...project, updatedAt: now },
        userId
      );
      if (!this.isAuthContextCurrent(authContext, 'doPersistActiveProject:saveProjectSmart', project.id)) {
        return { remoteConfirmed: false, projectId: project.id };
      }
      
      if (result.success) {
        const shouldClearProjectDirtyState = this.shouldClearProjectDirtyState(persistVersion);
        // 更新本地状态：updatedAt 和 version（如果有返回）
        this.projectState.updateProjects(ps =>
          ps.map(p => 
            p.id === project.id 
              ? {
                  ...p,
                  updatedAt: p.updatedAt && p.updatedAt > now ? p.updatedAt : now,
                  version: result.newVersion ?? p.version,
                  syncSource: 'synced',
                  pendingSync: shouldClearProjectDirtyState ? false : true
                }
              : p
          )
        );
        // 同步成功后，再次保存快照以确保版本号同步
        this.core.saveOfflineSnapshot(this.projectState.getProjectsWithCurrentData());
        
        if (shouldClearProjectDirtyState) {
          // 【关键】仅当本轮之后没有新增本地编辑时，才清理项目级 dirty 标记
          this.changeTracker.clearProjectFieldLocks(project.id);
          this.changeTracker.clearProjectChanges(project.id);
        }

        if (shouldClearProjectDirtyState && FEATURE_FLAGS.TAB_SYNC_LOCAL_REFRESH_V1) {
          this.tabSync.notifyDataSynced(project.id, now);
        }
        
        // 如果有验证警告，记录日志但不打扰用户
        if (result.validationWarnings && result.validationWarnings.length > 0) {
          this.logger.warn('同步完成但有警告', {
            projectId: project.id,
            warnings: result.validationWarnings
          });
        }
        return { remoteConfirmed: true, projectId: project.id };
      } else if (result.conflict) {
        // 版本冲突：通知用户手动解决，而非静默保存
        this.logger.warn('检测到数据冲突，展示冲突解决界面', { projectId: project.id });
        if (result.remoteData) {
          this.publishConflict({ ...project, updatedAt: now }, result.remoteData, authContext.userId);
        } else {
          await this.saveConflictSilently({ ...project, updatedAt: now }, undefined, [], authContext.userId);
          if (!this.isAuthContextCurrent(authContext, 'doPersistActiveProject:save-conflict', project.id)) {
            return { remoteConfirmed: false, projectId: project.id };
          }
          this.toastService.warning('检测到数据冲突', '已保留本地版本，远端详情可稍后在冲突中心查看');
        }
        return { remoteConfirmed: false, projectId: project.id };
      } else if (result.validationWarnings && result.validationWarnings.length > 0) {
        // 验证失败导致同步中止
        this.logger.error('同步验证失败', {
          projectId: project.id,
          warnings: result.validationWarnings
        });
        this.toastService.error(
          '同步验证失败',
          '检测到潜在的数据丢失风险，已中止同步。数据已保存到本地。'
        );
        return { remoteConfirmed: false, projectId: project.id };
      }
      if (!result.success) {
        const failedTaskIds = result.failedTaskIds ?? [];
        const failedConnectionIds = result.failedConnectionIds ?? [];
        const failedTasks = failedTaskIds.length;
        const failedConnections = failedConnectionIds.length;
        if (failedTasks > 0 || failedConnections > 0) {
          // 中文注释：BatchSyncService 已经把每个失败项入重试队列并设置了 syncState.syncError，
          // 若所有失败都已入队则属于"正常重试"闭环，不再复弹 toast；仅当存在未入队的真正风险项
          // 时才升级为 WARN + toast，避免浏览器恢复/会话刷新等临时状态造成用户侧重复告警。
          const retryMarkers = new Set(result.retryEnqueued ?? []);
          const uncoveredTasks = failedTaskIds.filter(id => !retryMarkers.has(`task:${id}`));
          const uncoveredConnections = failedConnectionIds.filter(id => !retryMarkers.has(`connection:${id}`));
          const hasDataAtRisk = uncoveredTasks.length > 0 || uncoveredConnections.length > 0;
          const actionQueueReplayPending =
            result.partialRetryHandoff === true && this.hasPendingProjectQueueReplay(project.id);

          if (hasDataAtRisk && !actionQueueReplayPending) {
            this.logger.warn('远端未完全确认，存在未入重试队列的风险项', {
              projectId: project.id,
              failedTasks,
              failedConnections,
              uncoveredTaskCount: uncoveredTasks.length,
              uncoveredConnectionCount: uncoveredConnections.length,
              failureReason: result.failureReason,
            });
            this.toastService.warning(
              '同步未完成',
              `任务失败 ${failedTasks} 项，连接失败 ${failedConnections} 项，已保留待同步标记`
            );
          } else if (hasDataAtRisk) {
            this.logger.info('远端未完全确认，未入重试队列的项仍由 ActionQueue 保底回放', {
              projectId: project.id,
              failedTasks,
              failedConnections,
              uncoveredTaskCount: uncoveredTasks.length,
              uncoveredConnectionCount: uncoveredConnections.length,
              failureReason: result.failureReason,
            });
          } else {
            this.logger.info('远端未完全确认，所有失败项已入重试队列，等待自动重试', {
              projectId: project.id,
              failedTasks,
              failedConnections,
              failureReason: result.failureReason,
            });
          }
        }
      }
      return { remoteConfirmed: false, projectId: project.id };
    } catch (error) {
      if (!this.isAuthContextCurrent(authContext, 'doPersistActiveProject:saveProjectSmart-error', project.id)) {
        return { remoteConfirmed: false, projectId: project.id };
      }
      this.logger.error('持久化项目时发生异常', { error });
      // 乐观UI：静默记录错误，不阻塞用户操作
      // 数据已保存到本地离线快照，网络恢复后会自动重试
      this.logger.warn('自动保存失败，更改已保存到本地', { error });
      
      // 增强：在离线模式下提示用户
      if (!navigator.onLine) {
        this.toastService.info('离线模式', '更改已保存到本地，联网后将自动同步');
      }
      return { remoteConfirmed: false, projectId: project.id };
    }
  }

  private updateSyncObservability(outcome: PersistOutcome): void {
    this.syncAttempts += 1;
    if (outcome.remoteConfirmed) {
      this.syncConfirmed += 1;
    }
    const successRate = this.syncAttempts === 0
      ? null
      : Number((this.syncConfirmed / this.syncAttempts).toFixed(4));
    const dirtyAgeMs = outcome.projectId
      ? this.changeTracker.getOldestChangeAgeMs(outcome.projectId)
      : this.changeTracker.getOldestChangeAgeMs();
    const lastSync = outcome.projectId ? this.core.getLastSyncTime(outcome.projectId) : null;
    const cursorLagMs = lastSync ? Math.max(0, Date.now() - new Date(lastSync).getTime()) : 0;
    const queuePressureEvents =
      this.retryQueue.pressureEvents +
      (this.actionQueue.queueFrozen() ? 1 : 0);

    this.sentryAlert.updateSyncContext({
      lastSyncTimestamp: this.core.syncState().lastSyncTime,
      pendingActions: this.pendingActionsCount(),
      syncSuccessRate: successRate,
      queuePressureEvents,
      dirtyAgeMs,
      cursorLagMs
    });
  }
}
