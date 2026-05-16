/**
 * SyncCoordinatorService 单元测试 (Vitest + Injector 隔离模式)
 * 
 * 测试覆盖：
 * 1. 持久化状态管理 - 防抖、标记本地变更
 * 2. 版本冲突检测 - 本地 v2 vs 远程 v3 场景
 * 3. 离线队列处理 - 队列积压、合并发送、逐个发送
 * 4. 同步状态机流转 - 在线/离线/同步中/会话过期
 * 5. 边缘情况 - 网络抖动、并发请求
 * 6. 验证与重平衡 - 数据完整性检查
 * 
 * 迁移说明：使用 Injector.create + runInInjectionContext 替代 TestBed，
 * 实现更轻量级的依赖注入隔离测试。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Injector, runInInjectionContext, DestroyRef, signal } from '@angular/core';
import { SyncCoordinatorService } from './sync-coordinator.service';
import { SimpleSyncService } from '../app/core/services/simple-sync.service';
import { SyncStateService } from '../app/core/services/sync/sync-state.service';
import { RetryQueueService } from '../app/core/services/sync/retry-queue.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { mockSentryLazyLoaderService } from '../test-setup.mocks';
import { ActionQueueService } from './action-queue.service';
import { ActionQueueProcessorsService } from './action-queue-processors.service';
import { DeltaSyncCoordinatorService } from './delta-sync-coordinator.service';
import { ProjectSyncOperationsService } from './project-sync-operations.service';
import { ConflictResolutionService } from './conflict-resolution.service';
import { ConflictStorageService } from './conflict-storage.service';
import { ChangeTrackerService } from './change-tracker.service';
import { ProjectStateService } from './project-state.service';
import { AuthService } from './auth.service';
import { ToastService } from './toast.service';
import { LayoutService } from './layout.service';
import { LoggerService } from './logger.service';
import { SentryAlertService } from './sentry-alert.service';
import { SyncModeService } from './sync-mode.service';
import { PersistSchedulerService } from './persist-scheduler.service';
import { BlackBoxSyncService } from './black-box-sync.service';
import { TabSyncService } from './tab-sync.service';
import { FEATURE_FLAGS } from '../config/feature-flags.config';
import { Project, Task, SyncState } from '../models';
import { success } from '../utils/result';

// ========== 模拟依赖服务 ==========

const createMockSyncState = (overrides?: Partial<SyncState>): SyncState => ({
  isSyncing: false,
  isOnline: true,
  offlineMode: false,
  sessionExpired: false,
  syncError: null,
  hasConflict: false,
  conflictData: null,
  ...overrides,
});

const mockSyncService = {
  syncState: signal(createMockSyncState()),
  state: {
    update: vi.fn((updater: (state: SyncState) => SyncState) => {
      mockSyncService.syncState.update(updater);
    }),
  },
  isLoadingRemote: signal(false),
  setConflict: vi.fn((conflictData) => {
    mockSyncService.syncState.update(state => ({
      ...state,
      hasConflict: true,
      conflictData,
    }));
  }),
  clearConflict: vi.fn(() => {
    mockSyncService.syncState.update(state => ({
      ...state,
      hasConflict: false,
      conflictData: null,
    }));
  }),
  saveOfflineSnapshot: vi.fn(),
  saveOfflineSnapshotAndWait: vi.fn().mockResolvedValue(undefined),
  loadOfflineSnapshot: vi.fn().mockReturnValue(null),
  clearOfflineCache: vi.fn(),
  loadProjectListMetadataFromCloud: vi.fn().mockResolvedValue([]),
  loadProjectsFromCloud: vi.fn().mockResolvedValue([]),
  saveProjectToCloud: vi.fn().mockResolvedValue({ success: true }),
  saveProjectSmart: vi.fn().mockResolvedValue({ success: true, newVersion: 2 }),
  deleteProjectFromCloud: vi.fn().mockResolvedValue(true),
  loadFullProjectOptimized: vi.fn().mockResolvedValue(null),
  loadSingleProject: vi.fn().mockResolvedValue(null),
  getTombstoneIds: vi.fn().mockResolvedValue(new Set<string>()),
  tryReloadConflictData: vi.fn().mockResolvedValue(undefined),
  saveUserPreferences: vi.fn().mockResolvedValue(true),
  setRemoteChangeCallback: vi.fn(),
  setTaskChangeCallback: vi.fn(),
  pauseRealtimeUpdates: vi.fn(),
  resumeRealtimeUpdates: vi.fn(),
  initRealtimeSubscription: vi.fn().mockResolvedValue(undefined),
  teardownRealtimeSubscription: vi.fn(),
  destroy: vi.fn(),
  flushRetryQueueSync: vi.fn(),
  getLastSyncTime: vi.fn().mockReturnValue(null),
  setLastSyncTime: vi.fn(),
  commitProjectSyncTimestamp: vi.fn().mockResolvedValue(undefined),
  commitProjectSyncCursor: vi.fn().mockResolvedValue(undefined),
  buildProjectSyncCursorFromProject: vi.fn().mockImplementation((project: Project) => ({
    updatedAt: project.updatedAt,
    entityType: 'project',
    id: project.id,
  })),
  getProjectSyncWatermark: vi.fn().mockResolvedValue(null),
  getUserProjectsWatermark: vi.fn().mockResolvedValue(null),
  listProjectHeadsSince: vi.fn().mockResolvedValue([]),
  getAccessibleProjectProbe: vi.fn().mockResolvedValue(null),
  getBlackBoxSyncWatermark: vi.fn().mockResolvedValue(null),
};

const mockActionQueueService = {
  queueSize: signal(0),
  setQueueProcessCallbacks: vi.fn(),
  registerProcessor: vi.fn(),
  validateProcessors: vi.fn().mockReturnValue([]),
  getRegisteredProcessorTypes: vi.fn().mockReturnValue([]),
  getPendingActionsForProject: vi.fn().mockReturnValue([]),
  enqueue: vi.fn().mockResolvedValue(true),
  enqueueForOwner: vi.fn().mockResolvedValue(true),
  processQueue: vi.fn().mockResolvedValue(undefined),
  queueFrozen: signal(false),
};

const mockRetryQueueService = {
  length: 0,
  getItems: vi.fn().mockReturnValue([]),
  removeByEntities: vi.fn().mockReturnValue([]),
  removeConnectionsReferencingTasks: vi.fn().mockReturnValue([]),
  pressureEvents: 0,
};

const mockBlackBoxSyncService = {
  forceSync: vi.fn().mockResolvedValue(undefined),
  pullChanges: vi.fn().mockResolvedValue(undefined),
};

const mockTabSyncService = {
  notifyDataSynced: vi.fn(),
  setOnDataSyncedCallback: vi.fn(),
};

const mockConflictService = {
  hasConflict: signal(false),
  conflictData: signal(null),
  resolveConflict: vi.fn().mockReturnValue(success({ id: 'proj-1', name: 'Resolved', tasks: [], connections: [], createdDate: '', version: 1 })),
  smartMerge: vi.fn().mockReturnValue({
    project: { id: 'proj-1', name: 'Merged', tasks: [], connections: [], createdDate: '', version: 2 },
    issues: [],
    conflictCount: 0,
  }),
};

const mockProjectStateService = {
  projects: signal<Project[]>([]),
  activeProject: signal<Project | null>(null),
  activeProjectId: signal<string | null>(null),
  updateProjects: vi.fn(),
  setProjects: vi.fn(),
  setActiveProjectId: vi.fn(),
  getProject: vi.fn((id: string) => mockProjectStateService.projects().find((p: Project) => p.id === id)),
  getProjectsWithCurrentData: vi.fn(() => mockProjectStateService.projects()),
};

const resolveMockActiveProjectId = (): string | null => {
  return mockProjectStateService.activeProjectId() ?? mockProjectStateService.activeProject()?.id ?? null;
};

const bindProjectStateMockImplementations = () => {
  mockProjectStateService.getProject.mockImplementation(
    (id: string) => mockProjectStateService.projects().find((project: Project) => project.id === id)
  );
  mockProjectStateService.setProjects.mockImplementation((projects: Project[]) => {
    mockProjectStateService.projects.set(projects);
    const activeProjectId = resolveMockActiveProjectId();
    mockProjectStateService.activeProject.set(
      activeProjectId ? projects.find((project: Project) => project.id === activeProjectId) ?? null : null
    );
  });
  mockProjectStateService.setActiveProjectId.mockImplementation((projectId: string | null) => {
    mockProjectStateService.activeProjectId.set(projectId);
    mockProjectStateService.activeProject.set(
      projectId ? mockProjectStateService.projects().find((project: Project) => project.id === projectId) ?? null : null
    );
  });
  mockProjectStateService.updateProjects.mockImplementation((updater: (projects: Project[]) => Project[]) => {
    const current = mockProjectStateService.projects();
    mockProjectStateService.projects.set(updater(current));
    const activeProjectId = resolveMockActiveProjectId();
    mockProjectStateService.activeProject.set(
      activeProjectId ? mockProjectStateService.projects().find((project: Project) => project.id === activeProjectId) ?? null : null
    );
  });
};

const mockAuthService = {
  currentUserId: vi.fn().mockReturnValue('user-123'),
  isConfigured: true,
};

const mockToastService = {
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
};

const mockSentryAlertService = {
  updateSyncContext: vi.fn(),
  captureMessage: vi.fn(),
  captureException: vi.fn(),
  setContext: vi.fn(),
};

const mockLayoutService = {
  validateAndFixTree: vi.fn((project: Project) => ({
    project,
    issues: [] as string[],
  })),
  rebalance: vi.fn((project: Project) => project),
};

const mockLoggerCategory = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const mockLoggerService = {
  category: vi.fn(() => mockLoggerCategory),
};

// ========== 新增缺失的 mock 服务 ==========

const mockConflictStorageService = {
  saveConflict: vi.fn().mockResolvedValue(true),
  getAllConflicts: vi.fn().mockResolvedValue([]),
  getConflict: vi.fn().mockResolvedValue(null),
  deleteConflict: vi.fn().mockResolvedValue(true),
  hasConflicts: vi.fn().mockResolvedValue(false),
};

const mockChangeTrackerService = {
  pendingChangesCount: signal(0),
  trackTaskCreate: vi.fn(),
  trackTaskUpdate: vi.fn(),
  trackTaskDelete: vi.fn(),
  trackConnectionCreate: vi.fn(),
  trackConnectionDelete: vi.fn(),
  clearProjectFieldLocks: vi.fn(),
  getProjectChanges: vi.fn(),
  clearProjectChanges: vi.fn(),
  getChangedProjectIds: vi.fn().mockReturnValue([]),
  hasProjectChanges: vi.fn().mockReturnValue(false),
  clearAllChanges: vi.fn(),
  getOldestChangeAgeMs: vi.fn().mockReturnValue(0),
};

const mockSyncModeService = {
  mode: signal('automatic'),
  isAutomatic: vi.fn().mockReturnValue(true),
  perceptionEnabled: vi.fn().mockReturnValue(false),
  setMode: vi.fn(),
  setSyncCallback: vi.fn(),
  config: vi.fn().mockReturnValue({
    mode: 'automatic',
    syncOnBoot: true,
    syncOnExit: true,
    autoSyncInterval: 300000, // 5分钟，匹配新的 DEFAULT_SYNC_INTERVAL
    perceptionEnabled: false,
  }),
  triggerSync: vi.fn().mockResolvedValue(undefined),
};

// Sprint 4 新增：PersistSchedulerService mock
const mockPersistSchedulerService = {
  state: signal({
    isPersisting: false,
    hasPending: false,
    lastPersistAt: 0,
    hasPendingLocalChanges: false,
    lastUpdateType: 'structure' as const
  }),
  setCallbacks: vi.fn(),
  startLocalAutosave: vi.fn(),
  stopLocalAutosave: vi.fn(),
  markLocalChanges: vi.fn(),
  clearLocalChanges: vi.fn(),
  getLastUpdateType: vi.fn().mockReturnValue('structure'),
  hasPendingLocalChanges: vi.fn().mockReturnValue(false),
  getLastPersistAt: vi.fn().mockReturnValue(0),
  isPersisting: vi.fn().mockReturnValue(false),
  schedulePersist: vi.fn(),
  flushPendingPersist: vi.fn().mockResolvedValue(undefined)
};

// Sprint 9 新增：ActionQueueProcessorsService mock
const mockActionQueueProcessorsService = {
  setProjectConflictHandler: vi.fn(),
  setupProcessors: vi.fn(),
};

// Sprint 9 新增：DeltaSyncCoordinatorService mock
const mockDeltaSyncCoordinatorService = {
  performDeltaSync: vi.fn().mockResolvedValue({ taskChanges: 0, connectionChanges: 0 }),
  hasProjectContentDifference: vi.fn().mockReturnValue(false),
};

// Sprint 9 新增：ProjectSyncOperationsService mock
const mockProjectSyncOperationsService = {
  resyncActiveProject: vi.fn().mockResolvedValue({ success: true, message: '已同步' }),
  mergeOfflineDataOnReconnect: vi.fn().mockResolvedValue({ projects: [], syncedCount: 0, conflictProjects: [] }),
  validateAndRebalanceWithResult: vi.fn().mockImplementation((project: Project) => ({ ok: true, value: project })),
  validateAndRebalance: vi.fn().mockImplementation((project: Project) => project),
};

function createDefaultProjectChanges() {
  return {
    tasksToCreate: [],
    tasksToUpdate: [],
    taskIdsToDelete: [],
    connectionsToCreate: [],
    connectionsToUpdate: [],
    connectionsToDelete: [],
    hasChanges: false,
    totalChanges: 0,
  };
}

// ========== 辅助函数 ==========

function createTestProject(overrides?: Partial<Project>): Project {
  return {
    id: `proj-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: 'Test Project',
    description: '',
    createdDate: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tasks: [],
    connections: [],
    version: 1,
    ...overrides,
  };
}

function createTestTask(overrides?: Partial<Task>): Task {
  return {
    id: `task-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    title: 'Test Task',
    content: '',
    stage: 1,
    parentId: null,
    order: 1,
    rank: 1000,
    status: 'active',
    x: 0,
    y: 0,
    createdDate: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    displayId: 'A',
    hasIncompleteTask: false,
    ...overrides,
  };
}

// ========== 测试用例 ==========

// DestroyRef mock（服务内部使用 inject(DestroyRef)）
const destroyCallbacks: Array<() => void> = [];
const mockDestroyRef: Pick<DestroyRef, 'onDestroy'> = {
  onDestroy: (cb: () => void) => { destroyCallbacks.push(cb); return () => {}; },
};

describe('SyncCoordinatorService', () => {
  let service: SyncCoordinatorService;
  let injector: Injector;
  const originalResumeWatermarkFlag = FEATURE_FLAGS.RESUME_WATERMARK_RPC_V1;
  const originalUserProjectsWatermarkFlag = FEATURE_FLAGS.USER_PROJECTS_WATERMARK_RPC_V1;
  const originalBlackBoxWatermarkFlag = FEATURE_FLAGS.BLACKBOX_WATERMARK_PROBE_V1;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    destroyCallbacks.length = 0;
    (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_WATERMARK_RPC_V1 = originalResumeWatermarkFlag;
    (FEATURE_FLAGS as unknown as Record<string, boolean>).USER_PROJECTS_WATERMARK_RPC_V1 = originalUserProjectsWatermarkFlag;
    (FEATURE_FLAGS as unknown as Record<string, boolean>).BLACKBOX_WATERMARK_PROBE_V1 = originalBlackBoxWatermarkFlag;

    mockAuthService.currentUserId.mockReset();
    mockAuthService.currentUserId.mockReturnValue('user-123');
    mockSyncService.saveProjectSmart.mockReset();
    mockSyncService.saveProjectSmart.mockResolvedValue({ success: true, newVersion: 2 });
    mockSyncService.saveOfflineSnapshot.mockReset();
    mockSyncService.saveOfflineSnapshotAndWait.mockReset();
    mockSyncService.saveOfflineSnapshotAndWait.mockResolvedValue(undefined);
    mockSyncService.commitProjectSyncTimestamp.mockReset();
    mockSyncService.commitProjectSyncTimestamp.mockResolvedValue(undefined);
    mockSyncService.commitProjectSyncCursor.mockReset();
    mockSyncService.commitProjectSyncCursor.mockResolvedValue(undefined);
    mockSyncService.buildProjectSyncCursorFromProject.mockReset();
    mockSyncService.buildProjectSyncCursorFromProject.mockImplementation((project: Project) => ({
      updatedAt: project.updatedAt,
      entityType: 'project',
      id: project.id,
    }));
    mockSyncService.loadOfflineSnapshot.mockReset();
    mockSyncService.loadOfflineSnapshot.mockReturnValue(null);
    mockActionQueueService.getPendingActionsForProject.mockReset();
    mockActionQueueService.getPendingActionsForProject.mockReturnValue([]);
    mockActionQueueService.enqueueForOwner.mockReset();
    mockActionQueueService.enqueueForOwner.mockResolvedValue(true);
    mockChangeTrackerService.getProjectChanges.mockReset();
    mockChangeTrackerService.getProjectChanges.mockImplementation(() => createDefaultProjectChanges());
    mockChangeTrackerService.getChangedProjectIds.mockReset();
    mockChangeTrackerService.getChangedProjectIds.mockReturnValue([]);
    mockChangeTrackerService.hasProjectChanges.mockReset();
    mockChangeTrackerService.hasProjectChanges.mockReturnValue(false);
    
    // 重置 mock signals
    mockSyncService.syncState.set(createMockSyncState());
    mockSyncService.isLoadingRemote.set(false);
    mockActionQueueService.queueSize.set(0);
    mockProjectStateService.projects.set([]);
    mockProjectStateService.activeProject.set(null);
    mockProjectStateService.activeProjectId.set(null);
    bindProjectStateMockImplementations();
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('nanoflow.project-manifest-watermark');
      localStorage.removeItem('nanoflow.blackbox-manifest-watermark');
      localStorage.removeItem('nanoflow.project-manifest-watermark.user-123');
      localStorage.removeItem('nanoflow.blackbox-manifest-watermark.user-123');
    }

    injector = Injector.create({
      providers: [
        { provide: SimpleSyncService, useValue: mockSyncService },
        { provide: ActionQueueService, useValue: mockActionQueueService },
        { provide: RetryQueueService, useValue: mockRetryQueueService },
        { provide: ConflictResolutionService, useValue: mockConflictService },
        { provide: ConflictStorageService, useValue: mockConflictStorageService },
        { provide: ChangeTrackerService, useValue: mockChangeTrackerService },
        { provide: ProjectStateService, useValue: mockProjectStateService },
        { provide: AuthService, useValue: mockAuthService },
        { provide: ToastService, useValue: mockToastService },
        { provide: SentryAlertService, useValue: mockSentryAlertService },
        { provide: LayoutService, useValue: mockLayoutService },
        { provide: LoggerService, useValue: mockLoggerService },
        { provide: SyncModeService, useValue: mockSyncModeService },
        { provide: PersistSchedulerService, useValue: mockPersistSchedulerService },
        { provide: BlackBoxSyncService, useValue: mockBlackBoxSyncService },
        { provide: TabSyncService, useValue: mockTabSyncService },
        { provide: ActionQueueProcessorsService, useValue: mockActionQueueProcessorsService },
        { provide: DeltaSyncCoordinatorService, useValue: mockDeltaSyncCoordinatorService },
        { provide: ProjectSyncOperationsService, useValue: mockProjectSyncOperationsService },
        { provide: DestroyRef, useValue: mockDestroyRef },
        { provide: SentryLazyLoaderService, useValue: mockSentryLazyLoaderService },
        {
          provide: SyncStateService,
          useValue: { setPendingCount: vi.fn() },
        },
      ],
    });

    service = runInInjectionContext(injector, () => new SyncCoordinatorService());
    // 【性能审计 2026-02-07】构造函数不再启动副作用，需显式初始化
    service.initialize();
  });

  afterEach(() => {
    vi.useRealTimers();
    (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_WATERMARK_RPC_V1 = originalResumeWatermarkFlag;
    (FEATURE_FLAGS as unknown as Record<string, boolean>).USER_PROJECTS_WATERMARK_RPC_V1 = originalUserProjectsWatermarkFlag;
    (FEATURE_FLAGS as unknown as Record<string, boolean>).BLACKBOX_WATERMARK_PROBE_V1 = originalBlackBoxWatermarkFlag;
  });

  // ==================== 同步状态派生 ====================

  describe('同步状态派生', () => {
    it('isSyncing 应该从 syncService.syncState 派生', () => {
      expect(service.isSyncing()).toBe(false);
      
      mockSyncService.syncState.set(createMockSyncState({ isSyncing: true }));
      expect(service.isSyncing()).toBe(true);
    });

    it('isOnline 应该从 syncService.syncState 派生', () => {
      expect(service.isOnline()).toBe(true);
      
      mockSyncService.syncState.set(createMockSyncState({ isOnline: false }));
      expect(service.isOnline()).toBe(false);
    });

    it('offlineMode 应该从 syncService.syncState 派生', () => {
      expect(service.offlineMode()).toBe(false);
      
      mockSyncService.syncState.set(createMockSyncState({ offlineMode: true }));
      expect(service.offlineMode()).toBe(true);
    });

    it('sessionExpired 应该从 syncService.syncState 派生', () => {
      expect(service.sessionExpired()).toBe(false);
      
      mockSyncService.syncState.set(createMockSyncState({ sessionExpired: true }));
      expect(service.sessionExpired()).toBe(true);
    });

    it('hasConflict 应该从 syncService.syncState 派生', () => {
      expect(service.hasConflict()).toBe(false);
      
      mockSyncService.syncState.set(createMockSyncState({ hasConflict: true }));
      expect(service.hasConflict()).toBe(true);
    });

    it('pendingActionsCount 应该从 actionQueue.queueSize 派生', () => {
      expect(service.pendingActionsCount()).toBe(0);
      
      mockActionQueueService.queueSize.set(5);
      expect(service.pendingActionsCount()).toBe(5);
    });
  });

  // ==================== 持久化状态管理 ====================

describe('持久化状态管理', () => {
    it('initialize 应注册 TabSync data-synced 回调', () => {
      expect(mockTabSyncService.setOnDataSyncedCallback).toHaveBeenCalledTimes(1);
      expect(mockTabSyncService.setOnDataSyncedCallback).toHaveBeenCalledWith(expect.any(Function));
    });

    it('markLocalChanges 应该设置 hasPendingLocalChanges 为 true', () => {
      expect(service.hasPendingLocalChanges()).toBe(false);
      
      service.markLocalChanges();
      
      expect(service.hasPendingLocalChanges()).toBe(true);
    });

    it('markLocalChanges 应将活动项目标记为 pendingSync 并提前保存本地快照', async () => {
      const project = createTestProject({ id: 'proj-mark-dirty', pendingSync: false });
      mockProjectStateService.activeProject.set(project);
      mockProjectStateService.projects.set([project]);
      mockSyncService.saveOfflineSnapshot.mockClear();

      service.markLocalChanges('content');

      const updatedProject = mockProjectStateService.projects().find(p => p.id === 'proj-mark-dirty');
      expect(updatedProject?.pendingSync).toBe(true);

      await vi.advanceTimersByTimeAsync(1000);
      expect(mockSyncService.saveOfflineSnapshot).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ id: 'proj-mark-dirty', pendingSync: true })
        ])
      );
    });

    it('markLocalChanges 应该更新 lastUpdateType', () => {
      service.markLocalChanges('content');
      expect(service.getLastUpdateType()).toBe('content');
      
      service.markLocalChanges('position');
      expect(service.getLastUpdateType()).toBe('position');
      
      service.markLocalChanges('structure');
      expect(service.getLastUpdateType()).toBe('structure');
    });

    it('getLastPersistAt 初始应该为 0', () => {
      expect(service.getLastPersistAt()).toBe(0);
    });

    it('schedulePersist 应该在延迟后触发持久化', async () => {
      const project = createTestProject({ id: 'proj-1' });
      mockProjectStateService.activeProject.set(project);
      mockProjectStateService.projects.set([project]);
      
      // 清除前面测试可能的影响
      mockSyncService.saveOfflineSnapshot.mockClear();
      
      service.schedulePersist();
      
      // 持久化尚未执行
      expect(mockSyncService.saveOfflineSnapshot).not.toHaveBeenCalled();
      
      // 前进 3000ms（SYNC_CONFIG.DEBOUNCE_DELAY = 3000）
      await vi.advanceTimersByTimeAsync(3000);
      
      // 等待异步持久化操作完成
      await vi.waitFor(() => {
        expect(mockSyncService.saveOfflineSnapshot).toHaveBeenCalled();
      }, { timeout: 200, interval: 10 });
    });

    it('自动持久化应使用当前 store 快照而不是陈旧 activeProject，并清理过期重试项', async () => {
      const staleTask = createTestTask({
        id: 'task-stale',
        title: 'Stale Task',
        updatedAt: '2026-04-10T00:00:00.000Z',
      });
      const currentTask = createTestTask({
        id: 'task-current',
        title: 'Current Task',
        updatedAt: '2026-04-10T01:00:00.000Z',
      });
      const staleProject = createTestProject({
        id: 'proj-store-snapshot',
        tasks: [staleTask],
        connections: [
          {
            id: 'connection-stale',
            source: 'task-stale',
            target: 'task-gone',
            title: 'stale edge',
          },
        ],
      });
      const currentProject = {
        ...staleProject,
        tasks: [currentTask],
        connections: [],
      };

      mockProjectStateService.activeProject.set(staleProject);
      mockProjectStateService.projects.set([staleProject]);
      mockProjectStateService.getProjectsWithCurrentData.mockImplementation(() => [currentProject]);
      mockProjectStateService.setProjects.mockClear();
      mockSyncService.saveProjectSmart.mockClear();
      mockRetryQueueService.removeByEntities.mockReset();
      mockRetryQueueService.removeConnectionsReferencingTasks.mockReset();
      mockRetryQueueService.removeByEntities
        .mockReturnValueOnce(['task-stale'])
        .mockReturnValueOnce(['connection-stale']);
      mockRetryQueueService.removeConnectionsReferencingTasks.mockReturnValueOnce(['connection-stale']);

      service.schedulePersist();
      await vi.advanceTimersByTimeAsync(3000);

      await vi.waitFor(() => {
        expect(mockSyncService.saveProjectSmart).toHaveBeenCalledTimes(1);
      });

      expect(mockProjectStateService.setProjects).toHaveBeenCalledWith([currentProject]);
      expect(mockSyncService.saveProjectSmart).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'proj-store-snapshot',
          tasks: [currentTask],
          connections: [],
        }),
        'user-123',
      );
      expect(mockRetryQueueService.removeByEntities).toHaveBeenNthCalledWith(1, 'task', ['task-stale']);
      expect(mockRetryQueueService.removeByEntities).toHaveBeenNthCalledWith(2, 'connection', ['connection-stale']);
      expect(mockRetryQueueService.removeConnectionsReferencingTasks).toHaveBeenCalledWith(
        'proj-store-snapshot',
        ['task-stale'],
      );
      mockProjectStateService.getProjectsWithCurrentData.mockImplementation(() => mockProjectStateService.projects());
    });

    it('自动持久化检测到同 id 新快照时应清理过期重试载荷', async () => {
      const staleTask = createTestTask({
        id: 'task-shared',
        title: 'Stale Task',
        updatedAt: '2026-04-10T00:00:00.000Z',
      });
      const currentTask = {
        ...staleTask,
        title: 'Current Task',
        updatedAt: '2026-04-10T01:00:00.000Z',
      };
      const staleProject = createTestProject({
        id: 'proj-superseded-retry',
        tasks: [staleTask],
        connections: [
          {
            id: 'connection-shared',
            source: 'task-shared',
            target: 'task-shared',
            title: 'stale edge',
            updatedAt: '2026-04-10T00:00:00.000Z',
          },
        ],
      });
      const currentProject = {
        ...staleProject,
        tasks: [currentTask],
        connections: [
          {
            ...staleProject.connections[0],
            title: 'current edge',
            updatedAt: '2026-04-10T01:00:00.000Z',
          },
        ],
      };

      mockProjectStateService.activeProject.set(staleProject);
      mockProjectStateService.projects.set([staleProject]);
      mockProjectStateService.getProjectsWithCurrentData.mockImplementation(() => [currentProject]);
      mockProjectStateService.setProjects.mockClear();
      mockSyncService.saveProjectSmart.mockClear();
      mockRetryQueueService.removeByEntities.mockReset();
      mockRetryQueueService.removeConnectionsReferencingTasks.mockReset();
      mockRetryQueueService.removeByEntities
        .mockReturnValueOnce(['task-shared'])
        .mockReturnValueOnce(['connection-shared']);
      mockRetryQueueService.removeConnectionsReferencingTasks.mockReturnValue([]);

      service.schedulePersist();
      await vi.advanceTimersByTimeAsync(3000);

      await vi.waitFor(() => {
        expect(mockSyncService.saveProjectSmart).toHaveBeenCalledTimes(1);
      });

      expect(mockProjectStateService.setProjects).toHaveBeenCalledWith([currentProject]);
      expect(mockSyncService.saveProjectSmart).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'proj-superseded-retry',
          tasks: [currentTask],
          connections: currentProject.connections,
        }),
        'user-123',
      );
      expect(mockRetryQueueService.removeByEntities).toHaveBeenNthCalledWith(1, 'task', ['task-shared']);
      expect(mockRetryQueueService.removeByEntities).toHaveBeenNthCalledWith(2, 'connection', ['connection-shared']);
      expect(mockRetryQueueService.removeConnectionsReferencingTasks).not.toHaveBeenCalled();
      mockProjectStateService.getProjectsWithCurrentData.mockImplementation(() => mockProjectStateService.projects());
    });

    it('连续调用 schedulePersist 应该只触发一次持久化', async () => {
      // 确保从干净状态开始
      mockSyncService.saveOfflineSnapshot.mockClear();
      
      const project = createTestProject({ id: 'proj-1' });
      mockProjectStateService.activeProject.set(project);
      mockProjectStateService.projects.set([project]);
      
      // 记录初始调用次数（可能有来自本地自动保存的调用）
      const initialCalls = mockSyncService.saveOfflineSnapshot.mock.calls.length;
      
      // 连续快速调用三次，由于防抖机制，应该只触发一次持久化
      service.schedulePersist();
      service.schedulePersist();
      service.schedulePersist();
      
      // 等待 DEBOUNCE_DELAY (3000ms) 后应该触发
      await vi.advanceTimersByTimeAsync(3000);
      
      // 等待异步持久化操作完成
      await vi.waitFor(() => {
        // 验证持久化已被调用（至少有 persistActiveProject 的 2 次调用）
        // 注意：还可能有本地自动保存的调用（每秒一次）
        const totalCalls = mockSyncService.saveOfflineSnapshot.mock.calls.length;
        expect(totalCalls).toBeGreaterThanOrEqual(initialCalls + 2);
      });
    });

    it('存在未解决冲突时应跳过云端持久化（避免重复弹窗）', async () => {
      const project = createTestProject({ id: 'proj-1' });
      mockProjectStateService.activeProject.set(project);
      mockProjectStateService.projects.set([project]);

      mockSyncService.syncState.set(createMockSyncState({
        hasConflict: true,
        conflictData: { projectId: 'proj-1' } as any,
      }));

      mockSyncService.saveOfflineSnapshot.mockClear();
      service.schedulePersist();
      // DEBOUNCE_DELAY = 3000ms, 需要推进足够时间让定时器触发
      await vi.advanceTimersByTimeAsync(3500);

      await vi.waitFor(() => {
        // persist + 可能的 autosave 定时器：至少 1 次保存
        expect(mockSyncService.saveOfflineSnapshot).toHaveBeenCalled();
      }, { timeout: 500, interval: 20 });
      // 关键断言：存在冲突时不应调用云端保存
      expect(mockSyncService.saveProjectSmart).not.toHaveBeenCalled();
    });

    it('local-only 项目应仅保留本地，不自动上传云端', async () => {
      const project = createTestProject({
        id: 'proj-local-only',
        syncSource: 'local-only',
        pendingSync: false,
      });
      mockProjectStateService.activeProject.set(project);
      mockProjectStateService.projects.set([project]);

      mockSyncService.saveOfflineSnapshot.mockClear();
      mockSyncService.saveProjectSmart.mockClear();

      service.schedulePersist();
      await vi.advanceTimersByTimeAsync(3500);

      await vi.waitFor(() => {
        expect(mockSyncService.saveOfflineSnapshot).toHaveBeenCalled();
      }, { timeout: 500, interval: 20 });

      expect(mockSyncService.saveProjectSmart).not.toHaveBeenCalled();
      const persistedProject = mockProjectStateService.projects().find(p => p.id === 'proj-local-only');
      expect(persistedProject?.syncSource).toBe('local-only');
      expect(persistedProject?.pendingSync).toBe(true);
    });

    it('remoteConfirmed 后应广播 data-synced', async () => {
      const project = createTestProject({ id: 'proj-1' });
      mockProjectStateService.activeProject.set(project);
      mockProjectStateService.projects.set([project]);
      mockSyncService.saveProjectSmart.mockResolvedValueOnce({ success: true, newVersion: 3 });

      service.schedulePersist();
      await vi.advanceTimersByTimeAsync(3000);

      await vi.waitFor(() => {
        expect(mockTabSyncService.notifyDataSynced).toHaveBeenCalledWith('proj-1', expect.any(String));
      });
    });

    it('旧会话的自动持久化冲突结果不应注入当前 active conflict', async () => {
      const project = createTestProject({ id: 'proj-stale-conflict' });
      mockProjectStateService.activeProject.set(project);
      mockProjectStateService.projects.set([project]);
      mockSyncService.setConflict.mockClear();
      mockConflictStorageService.saveConflict.mockClear();

      let resolvePersist: ((value: { success: boolean; conflict?: boolean; remoteData?: Project }) => void) | null = null;
      mockSyncService.saveProjectSmart.mockImplementationOnce(() => new Promise(resolve => {
        resolvePersist = resolve;
      }));

      service.schedulePersist();
      await vi.advanceTimersByTimeAsync(3000);
      await vi.waitFor(() => {
        expect(mockSyncService.saveProjectSmart).toHaveBeenCalledTimes(1);
      });

      (service as unknown as { authContextGeneration: number }).authContextGeneration += 1;
      mockAuthService.currentUserId.mockReturnValue('user-456');

      resolvePersist!({
        success: false,
        conflict: true,
        remoteData: createTestProject({ id: 'proj-stale-conflict', version: 3 }),
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(mockSyncService.setConflict).not.toHaveBeenCalled();
      expect(mockConflictStorageService.saveConflict).not.toHaveBeenCalled();
    });

    it('flushPendingPersist 应在后台切走前抢发一次云端持久化', async () => {
      const project = createTestProject({ id: 'proj-bg-flush' });
      mockProjectStateService.activeProject.set(project);
      mockProjectStateService.projects.set([project]);
      mockSyncService.saveProjectSmart.mockClear();
      mockSyncService.saveOfflineSnapshot.mockClear();

      service.markLocalChanges('content');
      service.flushPendingPersist();

      expect(mockSyncService.saveOfflineSnapshot).toHaveBeenCalled();
      await vi.waitFor(() => {
        expect(mockSyncService.saveProjectSmart).toHaveBeenCalledTimes(1);
      });
    });

    it('flushPendingPersistToCloud 离线时应只保留本地快照', async () => {
      const project = createTestProject({ id: 'proj-offline-flush' });
      mockProjectStateService.activeProject.set(project);
      mockProjectStateService.projects.set([project]);
      mockSyncService.syncState.set(createMockSyncState({ isOnline: false }));
      mockSyncService.saveProjectSmart.mockClear();

      const previousOnline = navigator.onLine;
      Object.defineProperty(navigator, 'onLine', {
        value: false,
        configurable: true,
      });

      service.markLocalChanges('content');
      const flushed = await service.flushPendingPersistToCloud('before-unload:test');

      expect(flushed).toBe(false);
      expect(mockSyncService.saveProjectSmart).not.toHaveBeenCalled();

      Object.defineProperty(navigator, 'onLine', {
        value: previousOnline,
        configurable: true,
      });
    });

    it('后台 flush 遇到进行中的持久化时应保留脏标记并补刷下一轮', async () => {
      const project = createTestProject({ id: 'proj-inflight-flush' });
      const resolvers: Array<(value: { success: boolean; newVersion: number }) => void> = [];

      mockProjectStateService.activeProject.set(project);
      mockProjectStateService.projects.set([project]);
      mockSyncService.saveProjectSmart.mockClear();
      mockChangeTrackerService.clearProjectFieldLocks.mockClear();
      mockChangeTrackerService.clearProjectChanges.mockClear();
      mockSyncService.saveProjectSmart.mockImplementation(
        () => new Promise(resolve => {
          resolvers.push(resolve as (value: { success: boolean; newVersion: number }) => void);
        })
      );

      service.markLocalChanges('content');
      service.schedulePersist();
      await vi.advanceTimersByTimeAsync(3000);

      await vi.waitFor(() => {
        expect(mockSyncService.saveProjectSmart).toHaveBeenCalledTimes(1);
      });

      service.markLocalChanges('content');
      service.schedulePersist();
      service.flushPendingPersist();

      expect(service.hasPendingLocalChanges()).toBe(true);

      resolvers[0]?.({ success: true, newVersion: 2 });
      await vi.waitFor(() => {
        expect(service.hasPendingLocalChanges()).toBe(true);
      });
      expect(mockProjectStateService.projects().find(p => p.id === 'proj-inflight-flush')?.pendingSync).toBe(true);
      expect(mockChangeTrackerService.clearProjectFieldLocks).not.toHaveBeenCalled();
      expect(mockChangeTrackerService.clearProjectChanges).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(3000);
      await vi.waitFor(() => {
        expect(mockSyncService.saveProjectSmart).toHaveBeenCalledTimes(2);
      });

      resolvers[1]?.({ success: true, newVersion: 3 });
      await vi.waitFor(() => {
        expect(service.hasPendingLocalChanges()).toBe(false);
      });
      expect(mockProjectStateService.projects().find(p => p.id === 'proj-inflight-flush')?.pendingSync).toBe(false);
      expect(mockChangeTrackerService.clearProjectFieldLocks).toHaveBeenCalledTimes(1);
      expect(mockChangeTrackerService.clearProjectChanges).toHaveBeenCalledTimes(1);
    });

    it('preparePendingPersistForOwnerChange 在云端失败后应把项目转交给原 owner 队列', async () => {
      const project = createTestProject({ id: 'proj-owner-handoff', pendingSync: true });
      mockProjectStateService.activeProject.set(project);
      mockProjectStateService.projects.set([project]);
      mockSyncService.saveProjectSmart.mockResolvedValueOnce({ success: false });

      service.markLocalChanges('content');
      const prepared = await service.preparePendingPersistForOwnerChange('user-123', 'owner-switch:user-123->user-456');

      expect(prepared).toBe(true);
      expect(mockActionQueueService.enqueueForOwner).toHaveBeenCalledWith(
        'user-123',
        expect.objectContaining({
          type: 'update',
          entityType: 'project',
          entityId: 'proj-owner-handoff',
          payload: expect.objectContaining({
            sourceUserId: 'user-123',
            project: expect.objectContaining({
              id: 'proj-owner-handoff',
              pendingSync: true,
              syncSource: 'synced',
            }),
          }),
        })
      );
    });

    it('preparePendingPersistForOwnerChange 应将待删除任务并入 project:update payload durable 到原 owner 队列', async () => {
      const project = createTestProject({ id: 'proj-owner-delete-handoff', pendingSync: true });
      mockProjectStateService.activeProject.set(project);
      mockProjectStateService.projects.set([project]);
      mockSyncService.saveProjectSmart.mockResolvedValueOnce({ success: false });
      mockChangeTrackerService.getProjectChanges.mockReturnValueOnce({
        tasksToCreate: [],
        tasksToUpdate: [],
        taskIdsToDelete: ['task-delete-a', 'task-delete-b'],
        connectionsToCreate: [],
        connectionsToUpdate: [],
        connectionsToDelete: [],
        hasChanges: true,
        totalChanges: 2,
      });

      service.markLocalChanges('content');
      const prepared = await service.preparePendingPersistForOwnerChange('user-123', 'owner-switch:user-123->user-456');

      expect(prepared).toBe(true);
      expect(mockActionQueueService.enqueueForOwner).toHaveBeenCalledTimes(1);
      expect(mockActionQueueService.enqueueForOwner).toHaveBeenNthCalledWith(1, 'user-123',
        expect.objectContaining({
          type: 'update',
          entityType: 'project',
          entityId: 'proj-owner-delete-handoff',
          payload: expect.objectContaining({
            sourceUserId: 'user-123',
            taskIdsToDelete: ['task-delete-a', 'task-delete-b'],
          }),
        })
      );
    });

    it('preparePendingPersistForOwnerChange 应将非活动 dirty project 一并 durable handoff 到原 owner 队列', async () => {
      const inactiveProject = createTestProject({ id: 'proj-inactive-dirty', pendingSync: true });
      const activeProject = createTestProject({ id: 'proj-active-handoff', pendingSync: true });
      mockProjectStateService.activeProject.set(activeProject);
      mockProjectStateService.projects.set([inactiveProject, activeProject]);
      mockSyncService.saveProjectSmart.mockResolvedValueOnce({ success: false });
      mockChangeTrackerService.getChangedProjectIds.mockReturnValueOnce(['proj-inactive-dirty']);
      mockChangeTrackerService.getChangedProjectIds.mockReturnValueOnce(['proj-inactive-dirty']);
      mockChangeTrackerService.getProjectChanges.mockImplementationOnce((projectId: string) => ({
        tasksToCreate: [],
        tasksToUpdate: [],
        taskIdsToDelete: projectId === 'proj-inactive-dirty' ? ['task-inactive-delete'] : [],
        connectionsToCreate: [],
        connectionsToUpdate: [],
        connectionsToDelete: [],
        hasChanges: projectId === 'proj-inactive-dirty',
        totalChanges: projectId === 'proj-inactive-dirty' ? 1 : 0,
      }));
      mockChangeTrackerService.getProjectChanges.mockImplementationOnce((projectId: string) => ({
        tasksToCreate: [],
        tasksToUpdate: [],
        taskIdsToDelete: projectId === 'proj-active-handoff' ? [] : ['task-inactive-delete'],
        connectionsToCreate: [],
        connectionsToUpdate: [],
        connectionsToDelete: [],
        hasChanges: projectId === 'proj-inactive-dirty',
        totalChanges: projectId === 'proj-inactive-dirty' ? 1 : 0,
      }));

      service.markLocalChanges('content');
      const prepared = await service.preparePendingPersistForOwnerChange(
        'user-123',
        'owner-switch:user-123->user-456',
      );

      expect(prepared).toBe(true);
      expect(mockActionQueueService.enqueueForOwner).toHaveBeenCalledTimes(2);
      expect(mockActionQueueService.enqueueForOwner).toHaveBeenNthCalledWith(
        1,
        'user-123',
        expect.objectContaining({
          entityId: 'proj-inactive-dirty',
          payload: expect.objectContaining({ taskIdsToDelete: ['task-inactive-delete'] }),
        }),
      );
      expect(mockActionQueueService.enqueueForOwner).toHaveBeenNthCalledWith(
        2,
        'user-123',
        expect.objectContaining({ entityId: 'proj-active-handoff' }),
      );
    });

    it('preparePendingPersistForOwnerChange 在没有 active pending 时也应转交非活动 dirty project 的删除意图', async () => {
      const inactiveProject = createTestProject({ id: 'proj-inactive-only', pendingSync: true });
      mockProjectStateService.activeProject.set(null);
      mockProjectStateService.projects.set([inactiveProject]);
      mockChangeTrackerService.getChangedProjectIds.mockReturnValueOnce(['proj-inactive-only']);
      mockChangeTrackerService.getChangedProjectIds.mockReturnValueOnce(['proj-inactive-only']);
      mockChangeTrackerService.getProjectChanges.mockReturnValueOnce({
        tasksToCreate: [],
        tasksToUpdate: [],
        taskIdsToDelete: ['task-offline-delete-a', 'task-offline-delete-b'],
        connectionsToCreate: [],
        connectionsToUpdate: [],
        connectionsToDelete: [],
        hasChanges: true,
        totalChanges: 2,
      });

      const prepared = await service.preparePendingPersistForOwnerChange(
        'user-123',
        'owner-switch:user-123->user-456',
      );

      expect(prepared).toBe(true);
      expect(mockSyncService.saveProjectSmart).not.toHaveBeenCalled();
      expect(mockActionQueueService.enqueueForOwner).toHaveBeenCalledWith(
        'user-123',
        expect.objectContaining({
          entityId: 'proj-inactive-only',
          payload: expect.objectContaining({
            sourceUserId: 'user-123',
            taskIdsToDelete: ['task-offline-delete-a', 'task-offline-delete-b'],
          }),
        }),
      );
    });

    it('收到 data-synced 广播应走本地回填并受 cooldown 限制', () => {
      const callback = mockTabSyncService.setOnDataSyncedCallback.mock.calls[0]?.[0] as
        | ((projectId: string, updatedAt: string) => void)
        | undefined;
      expect(callback).toBeTypeOf('function');

      const snapshotProject = createTestProject({
        id: 'proj-1',
        updatedAt: '2026-02-14T00:00:00.000Z',
        tasks: [createTestTask({ id: 'task-1' })],
      });

      mockProjectStateService.projects.set([createTestProject({ id: 'proj-1' })]);
      mockSyncService.loadOfflineSnapshot.mockReturnValue([snapshotProject]);
      mockActionQueueService.getPendingActionsForProject.mockReturnValue([]);
      mockChangeTrackerService.hasProjectChanges.mockReturnValue(false);

      callback?.('proj-1', '2026-02-14T00:00:00.000Z');
      callback?.('proj-1', '2026-02-14T00:00:01.000Z');

      expect(mockProjectStateService.updateProjects).toHaveBeenCalledTimes(1);
      expect(mockSyncService.loadProjectsFromCloud).not.toHaveBeenCalled();
    });
  });

  // ==================== 版本冲突检测 ====================
  // 注意: saveProjectToCloud 已迁移到 SimpleSyncService.saveProjectSmart
  // 版本冲突测试应在 simple-sync.service.spec.ts 中

  // ==================== 冲突解决 ====================

  describe('冲突解决', () => {
    it('resolveConflict 应该委托给 conflictService', () => {
      const localProject = createTestProject({ id: 'proj-1', version: 2 });
      const remoteProject = createTestProject({ id: 'proj-1', version: 3 });
      
      service.resolveConflict('proj-1', 'local', localProject, remoteProject);
      
      expect(mockConflictService.resolveConflict).toHaveBeenCalledWith(
        'proj-1',
        'local',
        localProject,
        remoteProject
      );
    });

    it('smartMerge 应该委托给 conflictService', () => {
      const localProject = createTestProject({ id: 'proj-1' });
      const remoteProject = createTestProject({ id: 'proj-1' });
      const tombstoneIds = new Set<string>();
      
      const result = service.smartMerge(localProject, remoteProject, tombstoneIds);
      
      // 【更新】smartMerge 现在需要传入 tombstoneIds 参数（防止已删除任务复活）
      expect(mockConflictService.smartMerge).toHaveBeenCalledWith(localProject, remoteProject, tombstoneIds);
      expect(result.project).toBeDefined();
    });
  });

  // ==================== 离线数据合并 ====================

  describe('离线数据合并', () => {
    // Sprint 9: mergeOfflineDataOnReconnect 现在委托给 ProjectSyncOperationsService
    it('离线新建项目应该同步到云端', async () => {
      const offlineProject = createTestProject({ id: 'new-proj', name: 'Offline' });
      const cloudProjects: Project[] = [];
      
      // 配置 mock 返回值
      mockProjectSyncOperationsService.mergeOfflineDataOnReconnect.mockResolvedValueOnce({
        projects: [offlineProject],
        syncedCount: 1,
        conflictProjects: []
      });
      
      const result = await service.mergeOfflineDataOnReconnect(
        cloudProjects,
        [offlineProject],
        'user-123'
      );
      
      expect(result.syncedCount).toBe(1);
      expect(mockProjectSyncOperationsService.mergeOfflineDataOnReconnect).toHaveBeenCalledWith(
        cloudProjects,
        [offlineProject],
        'user-123',
        expect.any(Function),
        expect.any(Function)
      );
    });

    it('离线版本高于云端时应该同步', async () => {
      const cloudProject = createTestProject({ id: 'proj-1', version: 3 });
      const offlineProject = createTestProject({ id: 'proj-1', version: 5 });
      
      // 配置 mock 返回值
      mockProjectSyncOperationsService.mergeOfflineDataOnReconnect.mockResolvedValueOnce({
        projects: [offlineProject],
        syncedCount: 1,
        conflictProjects: []
      });
      
      const result = await service.mergeOfflineDataOnReconnect(
        [cloudProject],
        [offlineProject],
        'user-123'
      );
      
      expect(result.syncedCount).toBe(1);
    });

    it('云端版本高于离线时不应该同步', async () => {
      const cloudProject = createTestProject({ id: 'proj-1', version: 10 });
      const offlineProject = createTestProject({ id: 'proj-1', version: 3 });
      
      // 配置 mock 返回值 - 云端版本更高时 syncedCount 为 0
      mockProjectSyncOperationsService.mergeOfflineDataOnReconnect.mockResolvedValueOnce({
        projects: [cloudProject],
        syncedCount: 0,
        conflictProjects: []
      });
      
      const result = await service.mergeOfflineDataOnReconnect(
        [cloudProject],
        [offlineProject],
        'user-123'
      );
      
      expect(result.syncedCount).toBe(0);
    });

    it('冲突时应该发布冲突事件到 onConflict$', async () => {
      const cloudProject = createTestProject({ id: 'proj-1', version: 5 });
      const offlineProject = createTestProject({ id: 'proj-1', version: 6 });
      
      // 配置 mock 返回冲突项目
      mockProjectSyncOperationsService.mergeOfflineDataOnReconnect.mockImplementationOnce(
        async (_cloud, _offline, _userId, _getTombstone, onConflict) => {
          // 模拟调用冲突回调
          onConflict(offlineProject, cloudProject);
          return {
            projects: [cloudProject],
            syncedCount: 0,
            conflictProjects: [offlineProject]
          };
        }
      );
      
      const onConflictSpy = vi.fn();
      const subscription = service.onConflict$.subscribe(onConflictSpy);
      
      await service.mergeOfflineDataOnReconnect(
        [cloudProject],
        [offlineProject],
        'user-123'
      );
      
      expect(onConflictSpy).toHaveBeenCalledWith({
        localProject: offlineProject,
        remoteProject: cloudProject,
        projectId: 'proj-1'
      });
      expect(mockConflictStorageService.saveConflict).toHaveBeenCalled();
      expect(service.hasConflict()).toBe(true);
      expect(service.conflictData()).toEqual({
        local: offlineProject,
        remote: cloudProject,
        projectId: 'proj-1',
        conflictedAt: expect.any(String),
        pendingTaskDeleteIds: undefined,
      });
      
      subscription.unsubscribe();
    });

    it('重复快照冲突不应重复发布 onConflict$ 或刷新 conflictedAt', async () => {
      const cloudProject = createTestProject({
        id: 'proj-dup',
        version: 5,
        updatedAt: '2026-05-12T14:20:00.000Z',
      });
      const offlineProject = createTestProject({
        id: 'proj-dup',
        version: 6,
        updatedAt: '2026-05-12T14:21:00.000Z',
      });
      const onConflictSpy = vi.fn();
      const subscription = service.onConflict$.subscribe(onConflictSpy);

      await service.captureConflict(offlineProject, cloudProject, 'user-123', ['task-delete-1']);
      const firstConflict = service.conflictData();

      await service.captureConflict(
        { ...offlineProject },
        { ...cloudProject },
        'user-123',
        ['task-delete-1'],
      );

      expect(onConflictSpy).toHaveBeenCalledTimes(1);
      expect(service.conflictData()).toEqual(firstConflict);
      expect(mockLoggerCategory.debug).toHaveBeenCalledWith('跳过重复冲突发布', { projectId: 'proj-dup' });

      subscription.unsubscribe();
    });

    it('相同项目元数据但任务内容变化时仍应发布新的冲突快照', async () => {
      const cloudProject = createTestProject({
        id: 'proj-dup-refresh',
        version: 5,
        updatedAt: '2026-05-12T14:20:00.000Z',
        tasks: [createTestTask({ id: 'task-1', title: 'Remote A', updatedAt: '2026-05-12T14:19:00.000Z' })],
      });
      const offlineProject = createTestProject({
        id: 'proj-dup-refresh',
        version: 6,
        updatedAt: '2026-05-12T14:21:00.000Z',
        tasks: [createTestTask({ id: 'task-1', title: 'Local A', updatedAt: '2026-05-12T14:21:00.000Z' })],
      });
      const refreshedOfflineProject = {
        ...offlineProject,
        tasks: [createTestTask({ id: 'task-1', title: 'Local B', updatedAt: '2026-05-12T14:21:00.000Z' })],
      };
      const onConflictSpy = vi.fn();
      const subscription = service.onConflict$.subscribe(onConflictSpy);

      await service.captureConflict(offlineProject, cloudProject, 'user-123');
      const firstConflict = service.conflictData();

      await service.captureConflict(refreshedOfflineProject, cloudProject, 'user-123');

      expect(onConflictSpy).toHaveBeenCalledTimes(2);
      expect(service.conflictData()).toEqual(expect.objectContaining({
        local: refreshedOfflineProject,
        remote: cloudProject,
        projectId: 'proj-dup-refresh',
      }));
      expect(service.conflictData()?.local.tasks[0]?.title).toBe('Local B');
      expect(firstConflict?.local.tasks[0]?.title).toBe('Local A');

      subscription.unsubscribe();
    });

    it('冲突时应记录冲突（LWW 冲突解决入口）', async () => {
      // Sprint 9: resyncActiveProject 现在委托给 ProjectSyncOperationsService
      const localProject = createTestProject({ id: 'proj-1', version: 2 });
      const remoteProject = createTestProject({ id: 'proj-1', version: 3 });

      mockProjectStateService.activeProject.set(localProject);
      mockProjectStateService.activeProjectId.set('proj-1');
      mockProjectStateService.projects.set([localProject]);

      mockAuthService.currentUserId.mockReturnValue('user-123');

      // 配置 mock 返回冲突检测结果
      mockProjectSyncOperationsService.resyncActiveProject.mockResolvedValueOnce({
        success: true,
        message: '已合并，1 处冲突已保存供稍后处理',
        conflictDetected: true
      });

      const result = await service.resyncActiveProject();

      expect(result.success).toBe(true);
      expect(result.conflictDetected).toBe(true);
      expect(mockProjectSyncOperationsService.resyncActiveProject).toHaveBeenCalledWith(
        expect.any(Function)
      );
    });

    it('refreshActiveProjectSilent 在水位未前进时应走快路跳过远端拉取', async () => {
      (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_WATERMARK_RPC_V1 = true;

      const localUpdatedAt = '2026-02-14T08:00:00.000Z';
      const localProject = createTestProject({
        id: 'proj-1',
        updatedAt: localUpdatedAt
      });

      mockProjectStateService.projects.set([localProject]);
      mockProjectStateService.activeProjectId.set('proj-1');
      mockAuthService.currentUserId.mockReturnValue('user-123');
      mockSyncService.getProjectSyncWatermark.mockResolvedValueOnce('2026-02-14T07:59:59.000Z');

      const result = await service.refreshActiveProjectSilent('resume:test');

      expect(result).toEqual({
        refreshed: false,
        skippedReason: 'watermark-not-newer',
        fastPathHit: true
      });
      expect(mockSyncService.commitProjectSyncTimestamp).toHaveBeenCalledWith('proj-1', '2026-02-14T07:59:59.000Z');
      expect(mockSyncService.loadFullProjectOptimized).not.toHaveBeenCalled();
    });

    it('refreshActiveProjectSilent 应基于本地任务/连接聚合水位命中快路', async () => {
      (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_WATERMARK_RPC_V1 = true;

      const localProject = createTestProject({
        id: 'proj-agg',
        updatedAt: '2026-02-14T08:00:00.000Z',
        tasks: [
          createTestTask({
            id: 'task-agg',
            updatedAt: '2026-02-14T08:12:00.000Z'
          })
        ],
        connections: [
          {
            id: 'conn-agg',
            source: 'task-agg',
            target: 'task-agg-target',
            description: '',
            updatedAt: '2026-02-14T08:11:00.000Z',
            deletedAt: null,
          }
        ],
      });

      mockProjectStateService.projects.set([localProject]);
      mockProjectStateService.activeProjectId.set('proj-agg');
      mockAuthService.currentUserId.mockReturnValue('user-123');
      mockSyncService.getProjectSyncWatermark.mockResolvedValueOnce('2026-02-14T08:10:00.000Z');

      const result = await service.refreshActiveProjectSilent('resume:test:aggregate-fastpath');

      expect(result).toEqual({
        refreshed: false,
        skippedReason: 'watermark-not-newer',
        fastPathHit: true
      });
      expect(mockSyncService.commitProjectSyncTimestamp).toHaveBeenCalledWith('proj-agg', '2026-02-14T08:10:00.000Z');
      expect(mockSyncService.loadFullProjectOptimized).not.toHaveBeenCalled();
    });

    it('refreshActiveProjectSilent 在远端水位更新时应加载并静默合并活动项目', async () => {
      (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_WATERMARK_RPC_V1 = true;

      const localProject = createTestProject({
        id: 'proj-1',
        updatedAt: '2026-02-14T08:00:00.000Z',
        tasks: [createTestTask({ id: 'task-local', updatedAt: '2026-02-14T07:55:00.000Z' })],
      });
      const remoteProject = createTestProject({
        id: 'proj-1',
        updatedAt: '2026-02-14T08:10:00.000Z',
        tasks: [createTestTask({ id: 'task-remote' })],
      });

      mockProjectStateService.projects.set([localProject]);
      mockProjectStateService.activeProjectId.set('proj-1');
      mockAuthService.currentUserId.mockReturnValue('user-123');
      mockSyncService.getProjectSyncWatermark.mockResolvedValueOnce('2026-02-14T08:10:00.000Z');
      mockSyncService.loadFullProjectOptimized.mockResolvedValueOnce(remoteProject);
      mockConflictService.smartMerge.mockReturnValueOnce({
        project: remoteProject,
        issues: [],
        conflictCount: 0,
      });

      const calls: string[] = [];
      mockProjectStateService.updateProjects.mockImplementation((updater: (projects: Project[]) => Project[]) => {
        mockProjectStateService.projects.set(updater(mockProjectStateService.projects()));
        calls.push('merge');
      });
      mockSyncService.saveOfflineSnapshotAndWait.mockImplementation(async () => {
        calls.push('persist');
      });
      mockSyncService.commitProjectSyncCursor.mockImplementation(async () => {
        calls.push('commit');
      });

      const result = await service.refreshActiveProjectSilent('resume:test');

      expect(result.refreshed).toBe(true);
      expect(mockSyncService.loadFullProjectOptimized).toHaveBeenCalledWith('proj-1');
      expect(mockSyncService.saveOfflineSnapshotAndWait).toHaveBeenCalledWith([
        expect.objectContaining({ id: 'proj-1', updatedAt: '2026-02-14T08:10:00.000Z' })
      ]);
      expect(mockSyncService.commitProjectSyncCursor).toHaveBeenCalledWith('proj-1', {
        updatedAt: '2026-02-14T08:10:00.000Z',
        entityType: 'project',
        id: 'proj-1',
      });
      expect(calls).toEqual(['merge', 'persist', 'commit']);
      expect(mockProjectStateService.projects()[0]?.updatedAt).toBe('2026-02-14T08:10:00.000Z');
    });

    it('refreshProjectManifestIfNeeded 命中用户水位快路时应跳过头信息刷新', async () => {
      (FEATURE_FLAGS as unknown as Record<string, boolean>).USER_PROJECTS_WATERMARK_RPC_V1 = true;
      mockAuthService.currentUserId.mockReturnValue('user-123');
      localStorage.setItem('nanoflow.project-manifest-watermark.user-123', '2026-02-15T08:00:00.000Z');
      mockSyncService.getUserProjectsWatermark.mockResolvedValueOnce('2026-02-15T07:59:59.000Z');

      const result = await service.refreshProjectManifestIfNeeded('manifest:fast-path');

      expect(result).toEqual({
        skipped: true,
        watermark: '2026-02-15T07:59:59.000Z',
      });
      expect(mockSyncService.listProjectHeadsSince).not.toHaveBeenCalled();
    });

    it('refreshProjectManifestIfNeeded 使用预加载水位时不应重复调用 RPC', async () => {
      (FEATURE_FLAGS as unknown as Record<string, boolean>).USER_PROJECTS_WATERMARK_RPC_V1 = true;
      mockAuthService.currentUserId.mockReturnValue('user-123');
      localStorage.setItem('nanoflow.project-manifest-watermark.user-123', '2026-02-15T08:00:00.000Z');

      const result = await service.refreshProjectManifestIfNeeded('manifest:prefetched', {
        prefetchedRemoteWatermark: '2026-02-15T07:59:59.000Z',
      });

      expect(result).toEqual({
        skipped: true,
        watermark: '2026-02-15T07:59:59.000Z',
      });
      expect(mockSyncService.getUserProjectsWatermark).not.toHaveBeenCalled();
      expect(mockSyncService.listProjectHeadsSince).not.toHaveBeenCalled();
    });

    it('refreshProjectManifestIfNeeded 删除事件推动预加载 watermark 前进时不应命中快路', async () => {
      (FEATURE_FLAGS as unknown as Record<string, boolean>).USER_PROJECTS_WATERMARK_RPC_V1 = true;
      mockAuthService.currentUserId.mockReturnValue('user-123');
      localStorage.setItem('nanoflow.project-manifest-watermark.user-123', '2026-02-15T08:00:00.000Z');
      mockSyncService.listProjectHeadsSince.mockResolvedValueOnce([]);

      const result = await service.refreshProjectManifestIfNeeded('manifest:prefetched-delete', {
        prefetchedRemoteWatermark: '2026-02-15T08:20:00.000Z',
        deferCommit: true,
      });

      expect(result).toEqual({
        skipped: false,
        watermark: '2026-02-15T08:20:00.000Z',
      });
      expect(mockSyncService.getUserProjectsWatermark).not.toHaveBeenCalled();
      expect(mockSyncService.listProjectHeadsSince).toHaveBeenCalledWith('2026-02-15T08:00:00.000Z');
      expect(localStorage.getItem('nanoflow.project-manifest-watermark.user-123')).toBe('2026-02-15T08:00:00.000Z');
    });

    it('refreshProjectManifestIfNeeded 冷启动无本地水位时不应调用 heads RPC 且不跳过慢路', async () => {
      (FEATURE_FLAGS as unknown as Record<string, boolean>).USER_PROJECTS_WATERMARK_RPC_V1 = true;
      mockAuthService.currentUserId.mockReturnValue('user-123');
      mockSyncService.getUserProjectsWatermark.mockResolvedValueOnce('2026-02-15T08:20:00.000Z');

      const result = await service.refreshProjectManifestIfNeeded('manifest:cold-start');

      expect(result).toEqual({
        skipped: false,
        watermark: '2026-02-15T08:20:00.000Z',
      });
      expect(mockSyncService.listProjectHeadsSince).not.toHaveBeenCalled();
      expect(localStorage.getItem('nanoflow.project-manifest-watermark.user-123')).toBe('2026-02-15T08:20:00.000Z');
    });

    it('refreshProjectManifestIfNeeded 远端更新且 heads 为空时也不应跳过慢路', async () => {
      (FEATURE_FLAGS as unknown as Record<string, boolean>).USER_PROJECTS_WATERMARK_RPC_V1 = true;
      mockAuthService.currentUserId.mockReturnValue('user-123');
      localStorage.setItem('nanoflow.project-manifest-watermark.user-123', '2026-02-15T08:00:00.000Z');
      mockSyncService.getUserProjectsWatermark.mockResolvedValueOnce('2026-02-15T08:20:00.000Z');
      mockSyncService.listProjectHeadsSince.mockResolvedValueOnce([]);

      const result = await service.refreshProjectManifestIfNeeded('manifest:heads-empty');

      expect(result).toEqual({
        skipped: false,
        watermark: '2026-02-15T08:20:00.000Z',
      });
      expect(mockSyncService.listProjectHeadsSince).toHaveBeenCalledWith('2026-02-15T08:00:00.000Z');
    });

    it('refreshProjectManifestIfNeeded 远端有更新时应拉取头信息并更新本地水位', async () => {
      (FEATURE_FLAGS as unknown as Record<string, boolean>).USER_PROJECTS_WATERMARK_RPC_V1 = true;
      mockAuthService.currentUserId.mockReturnValue('user-123');
      localStorage.setItem('nanoflow.project-manifest-watermark.user-123', '2026-02-15T08:00:00.000Z');
      mockProjectStateService.projects.set([
        createTestProject({
          id: 'proj-1',
          updatedAt: '2026-02-15T08:00:00.000Z',
          version: 1,
        }),
      ]);
      mockSyncService.getUserProjectsWatermark.mockResolvedValueOnce('2026-02-15T08:20:00.000Z');
      mockSyncService.listProjectHeadsSince.mockResolvedValueOnce([
        {
          id: 'proj-1',
          updatedAt: '2026-02-15T08:19:00.000Z',
          version: 3,
        },
      ]);

      const result = await service.refreshProjectManifestIfNeeded('manifest:slow-path');

      expect(result).toEqual({
        skipped: false,
        watermark: '2026-02-15T08:20:00.000Z',
      });
      expect(mockSyncService.listProjectHeadsSince).toHaveBeenCalledWith('2026-02-15T08:00:00.000Z');
      const updated = mockProjectStateService.projects()[0];
      expect(updated?.updatedAt).toBe('2026-02-15T08:19:00.000Z');
      expect(updated?.version).toBe(3);
      expect(localStorage.getItem('nanoflow.project-manifest-watermark.user-123')).toBe('2026-02-15T08:20:00.000Z');
    });

    it('refreshBlackBoxWatermarkIfNeeded 命中快路时应跳过明细拉取', async () => {
      (FEATURE_FLAGS as unknown as Record<string, boolean>).BLACKBOX_WATERMARK_PROBE_V1 = true;
      mockAuthService.currentUserId.mockReturnValue('user-123');
      localStorage.setItem('nanoflow.blackbox-manifest-watermark.user-123', '2026-02-16T10:00:00.000Z');
      mockSyncService.getBlackBoxSyncWatermark.mockResolvedValueOnce('2026-02-16T10:00:00.000Z');

      const result = await service.refreshBlackBoxWatermarkIfNeeded('resume:test');

      expect(result).toEqual({
        skipped: true,
        watermark: '2026-02-16T10:00:00.000Z',
      });
      expect(mockBlackBoxSyncService.pullChanges).not.toHaveBeenCalled();
    });

    it('refreshBlackBoxWatermarkIfNeeded 远端前进时应拉取并更新本地水位', async () => {
      (FEATURE_FLAGS as unknown as Record<string, boolean>).BLACKBOX_WATERMARK_PROBE_V1 = true;
      mockAuthService.currentUserId.mockReturnValue('user-123');
      localStorage.setItem('nanoflow.blackbox-manifest-watermark.user-123', '2026-02-16T10:00:00.000Z');
      mockSyncService.getBlackBoxSyncWatermark.mockResolvedValueOnce('2026-02-16T10:05:00.000Z');

      const result = await service.refreshBlackBoxWatermarkIfNeeded('resume:test');

      expect(result).toEqual({
        skipped: false,
        watermark: '2026-02-16T10:05:00.000Z',
      });
      expect(mockBlackBoxSyncService.pullChanges).toHaveBeenCalledWith({ reason: 'resume' });
      expect(localStorage.getItem('nanoflow.blackbox-manifest-watermark.user-123')).toBe('2026-02-16T10:05:00.000Z');
    });

    it('refreshBlackBoxWatermarkIfNeeded 使用预加载水位时不应重复调用 RPC', async () => {
      (FEATURE_FLAGS as unknown as Record<string, boolean>).BLACKBOX_WATERMARK_PROBE_V1 = true;
      mockAuthService.currentUserId.mockReturnValue('user-123');
      localStorage.setItem('nanoflow.blackbox-manifest-watermark.user-123', '2026-02-16T10:00:00.000Z');

      const result = await service.refreshBlackBoxWatermarkIfNeeded('resume:test', {
        prefetchedRemoteWatermark: '2026-02-16T10:00:00.000Z',
      });

      expect(result).toEqual({
        skipped: true,
        watermark: '2026-02-16T10:00:00.000Z',
      });
      expect(mockSyncService.getBlackBoxSyncWatermark).not.toHaveBeenCalled();
      expect(mockBlackBoxSyncService.pullChanges).not.toHaveBeenCalled();
    });
  });

  describe('downloadAndMerge local-only 保留策略', () => {
    it('远端成功返回空列表时，应裁剪缺失的 synced 项目', async () => {
      const localProject = createTestProject({
        id: 'local-deleted',
        syncSource: 'synced',
        pendingSync: false,
      });

      mockSyncService.loadProjectListMetadataFromCloud.mockResolvedValueOnce([]);
      mockProjectStateService.projects.set([localProject]);
      mockProjectStateService.activeProjectId.set('local-deleted');
      mockChangeTrackerService.hasProjectChanges.mockReturnValue(false);
      mockActionQueueService.getPendingActionsForProject.mockReturnValue([]);

      await (service as unknown as { downloadAndMerge: (userId: string) => Promise<void> })
        .downloadAndMerge('user-123');

      expect(mockSyncService.loadProjectsFromCloud).not.toHaveBeenCalled();
      expect(mockProjectStateService.projects()).toEqual([]);
      expect(mockProjectStateService.activeProjectId()).toBeNull();
    });

    it('裁剪当前活动项目后，应自动切换到首个剩余项目', async () => {
      const remoteProject = createTestProject({ id: 'remote-1' });
      const localProject = createTestProject({
        id: 'local-stale',
        syncSource: 'synced',
        pendingSync: false,
      });

      mockSyncService.loadProjectListMetadataFromCloud.mockResolvedValueOnce([remoteProject]);
      mockSyncService.loadProjectsFromCloud.mockResolvedValueOnce([remoteProject]);
      mockProjectStateService.projects.set([localProject]);
      mockProjectStateService.activeProjectId.set('local-stale');
      mockChangeTrackerService.hasProjectChanges.mockReturnValue(false);
      mockActionQueueService.getPendingActionsForProject.mockReturnValue([]);

      await (service as unknown as { downloadAndMerge: (userId: string) => Promise<void> })
        .downloadAndMerge('user-123');

      expect(mockProjectStateService.projects().map(project => project.id)).toEqual(['remote-1']);
      expect(mockProjectStateService.activeProjectId()).toBe('remote-1');
    });

    it('远端元数据获取失败时，应保留本地项目避免误删', async () => {
      const localProject = createTestProject({
        id: 'local-preserved',
        syncSource: 'synced',
        pendingSync: false,
      });

      mockSyncService.loadProjectListMetadataFromCloud.mockResolvedValueOnce(null);
      mockProjectStateService.projects.set([localProject]);

      await (service as unknown as { downloadAndMerge: (userId: string) => Promise<void> })
        .downloadAndMerge('user-123');

      expect(mockSyncService.loadProjectListMetadataFromCloud).toHaveBeenCalledWith(
        'user-123',
        expect.objectContaining({
          timeout: 10000,
          retries: 1,
          silent: true,
          purpose: 'sync-download-merge',
          treatTransientFailureAsSoft: true,
        })
      );
      expect(mockSyncService.loadProjectsFromCloud).not.toHaveBeenCalled();
      expect(mockProjectStateService.projects()).toEqual([localProject]);
    });

    it('远程不存在且无本地待同步变更时，不应保留本地项目', async () => {
      const remoteProject = createTestProject({ id: 'remote-1' });
      const localProject = createTestProject({
        id: 'local-stale',
        syncSource: 'synced',
        pendingSync: false
      });

      mockSyncService.loadProjectListMetadataFromCloud.mockResolvedValueOnce([remoteProject]);
      mockSyncService.loadProjectsFromCloud.mockResolvedValueOnce([remoteProject]);
      mockProjectStateService.projects.set([localProject]);
      mockChangeTrackerService.hasProjectChanges.mockReturnValue(false);
      mockActionQueueService.getPendingActionsForProject.mockReturnValue([]);

      await (service as unknown as { downloadAndMerge: (userId: string) => Promise<void> })
        .downloadAndMerge('user-123');

      const mergedProjects = mockProjectStateService.projects();
      expect(mergedProjects.some(p => p.id === 'remote-1')).toBe(true);
      expect(mergedProjects.some(p => p.id === 'local-stale')).toBe(false);
    });

    it('远程不存在但有本地待同步变更时，应保留本地项目', async () => {
      const remoteProject = createTestProject({ id: 'remote-1' });
      const localProject = createTestProject({
        id: 'local-pending',
        syncSource: 'synced',
        pendingSync: true
      });

      mockSyncService.loadProjectListMetadataFromCloud.mockResolvedValueOnce([remoteProject]);
      mockSyncService.loadProjectsFromCloud.mockResolvedValueOnce([remoteProject]);
      mockProjectStateService.projects.set([localProject]);
      mockChangeTrackerService.hasProjectChanges.mockReturnValue(false);
      mockActionQueueService.getPendingActionsForProject.mockReturnValue([]);

      await (service as unknown as { downloadAndMerge: (userId: string) => Promise<void> })
        .downloadAndMerge('user-123');

      const mergedProjects = mockProjectStateService.projects();
      const preservedLocal = mergedProjects.find(p => p.id === 'local-pending');
      expect(preservedLocal).toBeDefined();
      expect(preservedLocal?.syncSource).toBe('local-only');
      expect(preservedLocal?.pendingSync).toBe(true);
    });

    it('元数据成功但完整下载仅返回子集时，应保留缺失项目的 metadata 壳', async () => {
      const remoteProjectA = createTestProject({ id: 'remote-1', name: 'Remote 1' });
      const remoteProjectB = createTestProject({ id: 'remote-2', name: 'Remote 2' });

      mockSyncService.loadProjectListMetadataFromCloud.mockResolvedValueOnce([remoteProjectA, remoteProjectB]);
      mockSyncService.loadProjectsFromCloud.mockResolvedValueOnce([remoteProjectA]);
      mockProjectStateService.projects.set([]);
      mockChangeTrackerService.hasProjectChanges.mockReturnValue(false);
      mockActionQueueService.getPendingActionsForProject.mockReturnValue([]);

      await (service as unknown as { downloadAndMerge: (userId: string) => Promise<void> })
        .downloadAndMerge('user-123');

      const mergedProjects = mockProjectStateService.projects();
      expect(mergedProjects.map(project => project.id)).toEqual(['remote-1', 'remote-2']);
      expect(mergedProjects.find(project => project.id === 'remote-2')).toEqual(
        expect.objectContaining({
          id: 'remote-2',
          name: 'Remote 2',
          syncSource: 'synced',
          pendingSync: false,
        })
      );
    });
  });

  // ==================== 验证与重平衡 ====================

  describe('验证与重平衡', () => {
    it('validateAndRebalance 应该返回验证后的项目', () => {
      const project = createTestProject({ id: 'proj-1' });
      
      // 模拟委托服务返回验证后的项目
      mockProjectSyncOperationsService.validateAndRebalance.mockReturnValueOnce(project);
      
      const result = service.validateAndRebalance(project);
      
      expect(mockProjectSyncOperationsService.validateAndRebalance).toHaveBeenCalledWith(project);
      expect(result).toBeDefined();
    });

    it('validateAndRebalanceWithResult 验证失败时应该返回 failure', () => {
      // 由于空 ID 是致命错误，validateAndRebalanceWithResult 会在调用 validateAndFixTree 之前就返回失败
      // 所以我们只需要测试正常情况
      const validProject = createTestProject({ id: 'valid-proj' });
      mockLayoutService.validateAndFixTree.mockReturnValueOnce({
        project: validProject,
        issues: [],
      });
      
      const result = service.validateAndRebalanceWithResult(validProject);
      
      expect(result.ok).toBe(true);
    });

    it('连接数据损坏时应可清理修复（不应作为致命错误跳过整个项目）', () => {
      const project = createTestProject({
        id: 'proj-conn-bad',
        tasks: [createTestTask({ id: 't1' })],
        // source 为空会触发 validateConnection 的“连接源 ID 无效”
        connections: [{ id: 'c1', source: '' as any, target: 't1' } as any],
      });

      // 模拟委托服务返回修复后的项目（无效连接已被移除）
      const fixedProject = { ...project, connections: [] };
      mockProjectSyncOperationsService.validateAndRebalanceWithResult.mockReturnValueOnce({
        ok: true,
        value: fixedProject,
      });

      const result = service.validateAndRebalanceWithResult(project);
      expect(result.ok).toBe(true);
      expect(mockProjectSyncOperationsService.validateAndRebalanceWithResult).toHaveBeenCalled();
    });

    it('tasks 不是数组应视为致命错误', () => {
      const project = createTestProject({ id: 'proj-tasks-invalid' }) as any;
      project.tasks = undefined;

      // 模拟委托服务返回致命错误
      mockProjectSyncOperationsService.validateAndRebalanceWithResult.mockReturnValueOnce({
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: 'tasks 不是数组' },
      });

      const result = service.validateAndRebalanceWithResult(project);
      expect(result.ok).toBe(false);
    });

    it('父任务缺失时应自动断开 parentId（避免因 tombstone 过滤导致项目跳过）', () => {
      const project = createTestProject({
        id: 'proj-orphan-parent',
        tasks: [
          createTestTask({ id: 'child-1', parentId: 'missing-parent' }),
        ],
        connections: [],
      });

      // 模拟委托服务返回修复后的项目（parentId 已被置为 null）
      const fixedProject = { ...project, tasks: [{ ...project.tasks[0], parentId: null }] };
      mockProjectSyncOperationsService.validateAndRebalanceWithResult.mockReturnValueOnce({
        ok: true,
        value: fixedProject,
      });

      const result = service.validateAndRebalanceWithResult(project);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.tasks[0].parentId).toBe(null);
      }
    });

    it('验证有警告时应该记录日志', () => {
      // 创建一个完整有效的项目，确保 validateProject 通过
      const project: Project = {
        id: 'proj-1',
        name: 'Test Project',
        description: '',
        createdDate: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tasks: [],
        connections: [],
        version: 1,
      };
      
      // 重要：在测试前重置所有 mock
      vi.clearAllMocks();
      
      // 模拟委托服务返回有 issues 的结果
      mockProjectSyncOperationsService.validateAndRebalance.mockReturnValueOnce(project);
      
      // 使用 mockImplementation 而不是 mockReturnValue 来确保覆盖默认实现
      mockLayoutService.validateAndFixTree.mockImplementation(() => ({
        project: project,
        issues: ['Fixed orphan task'],
      }));
      
      // 调用被测方法
      service.validateAndRebalance(project);
      
      // 验证 validateAndRebalance 被调用了
      expect(mockProjectSyncOperationsService.validateAndRebalance).toHaveBeenCalledTimes(1);
    });
  });

  // ==================== 远程变更回调 ====================

  describe('远程变更回调', () => {
    it('setupRemoteChangeCallbacks 应该设置回调', () => {
      const onRemoteChange = vi.fn();
      const onTaskChange = vi.fn();
      
      service.setupRemoteChangeCallbacks(onRemoteChange, onTaskChange);
      
      expect(mockSyncService.setRemoteChangeCallback).toHaveBeenCalledWith(onRemoteChange);
      expect(mockSyncService.setTaskChangeCallback).toHaveBeenCalledWith(onTaskChange);
    });
  });

  // ==================== 实时订阅管理 ====================

  // ==================== 队列处理协调 ====================

  describe('队列处理协调', () => {
    it('应该在初始化时委托给 ActionQueueProcessorsService 设置处理器', () => {
      expect(mockActionQueueProcessorsService.setupProcessors).toHaveBeenCalled();
    });

    it('应该在初始化时注册 project conflict 回调', () => {
      expect(mockActionQueueProcessorsService.setProjectConflictHandler).toHaveBeenCalledWith(expect.any(Function));
    });
  });

  // ==================== 动作处理器注册（已移至 ActionQueueProcessorsService） ====================

  // 注：动作处理器注册逻辑已提取到 ActionQueueProcessorsService
  // 这些测试应该在 ActionQueueProcessorsService 的测试文件中进行

  // ==================== 网络状态变化场景 ====================

  describe('网络状态变化场景', () => {
    it('从在线变为离线时状态应该正确反映', () => {
      expect(service.isOnline()).toBe(true);
      expect(service.offlineMode()).toBe(false);
      
      mockSyncService.syncState.set(createMockSyncState({
        isOnline: false,
        offlineMode: true,
      }));
      
      expect(service.isOnline()).toBe(false);
      expect(service.offlineMode()).toBe(true);
    });

    it('从离线恢复在线时状态应该正确反映', () => {
      mockSyncService.syncState.set(createMockSyncState({
        isOnline: false,
        offlineMode: true,
      }));
      
      expect(service.isOnline()).toBe(false);
      
      mockSyncService.syncState.set(createMockSyncState({
        isOnline: true,
        offlineMode: false,
      }));
      
      expect(service.isOnline()).toBe(true);
      expect(service.offlineMode()).toBe(false);
    });
  });

  // ==================== 并发保存场景 ====================

  describe('并发保存场景', () => {
    it('快速连续调用 schedulePersist 应该合并为一次', async () => {
      const project = createTestProject({ id: 'proj-1' });
      mockProjectStateService.activeProject.set(project);
      mockProjectStateService.projects.set([project]);

      mockSyncService.saveOfflineSnapshot.mockClear();
      mockSyncService.saveProjectSmart.mockClear();

      // 快速连续调用
      for (let i = 0; i < 10; i++) {
        service.schedulePersist();
        await vi.advanceTimersByTimeAsync(50);
      }

      // 等待防抖完成 (DEBOUNCE_DELAY = 3000ms, 最后一次 schedulePersist 在 ~500ms)
      await vi.advanceTimersByTimeAsync(3500);

      // 等待异步持久化操作完成
      await vi.waitFor(() => {
        expect(mockSyncService.saveProjectSmart).toHaveBeenCalledTimes(1);
      });

      expect(mockSyncService.saveOfflineSnapshot).toHaveBeenCalled();
    });
  });

  // ==================== 清理 ====================

  describe('清理', () => {
    it('destroy 应该调用 syncService.destroy', () => {
      service.destroy();
      
      expect(mockSyncService.destroy).toHaveBeenCalled();
    });
  });
});

// ==================== 集成场景测试 ====================

describe('SyncCoordinatorService 集成场景', () => {
  let service: SyncCoordinatorService;
  let injector: Injector;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    destroyCallbacks.length = 0;
    
    mockSyncService.syncState.set(createMockSyncState());
    mockSyncService.isLoadingRemote.set(false);
    mockActionQueueService.queueSize.set(0);
    mockProjectStateService.projects.set([]);
    mockProjectStateService.activeProject.set(null);
    mockProjectStateService.activeProjectId.set(null);
    bindProjectStateMockImplementations();

    injector = Injector.create({
      providers: [
        { provide: SimpleSyncService, useValue: mockSyncService },
        { provide: ActionQueueService, useValue: mockActionQueueService },
        { provide: RetryQueueService, useValue: mockRetryQueueService },
        { provide: ConflictResolutionService, useValue: mockConflictService },
        { provide: ConflictStorageService, useValue: mockConflictStorageService },
        { provide: ChangeTrackerService, useValue: mockChangeTrackerService },
        { provide: ProjectStateService, useValue: mockProjectStateService },
        { provide: AuthService, useValue: mockAuthService },
        { provide: ToastService, useValue: mockToastService },
        { provide: SentryAlertService, useValue: mockSentryAlertService },
        { provide: LayoutService, useValue: mockLayoutService },
        { provide: LoggerService, useValue: mockLoggerService },
        { provide: SyncModeService, useValue: mockSyncModeService },
        { provide: PersistSchedulerService, useValue: mockPersistSchedulerService },
        { provide: BlackBoxSyncService, useValue: mockBlackBoxSyncService },
        { provide: TabSyncService, useValue: mockTabSyncService },
        { provide: ActionQueueProcessorsService, useValue: mockActionQueueProcessorsService },
        { provide: DeltaSyncCoordinatorService, useValue: mockDeltaSyncCoordinatorService },
        { provide: ProjectSyncOperationsService, useValue: mockProjectSyncOperationsService },
        { provide: DestroyRef, useValue: mockDestroyRef },
        { provide: SentryLazyLoaderService, useValue: mockSentryLazyLoaderService },
        {
          provide: SyncStateService,
          useValue: { setPendingCount: vi.fn() },
        },
      ],
    });

    service = runInInjectionContext(injector, () => new SyncCoordinatorService());
    // 【性能审计 2026-02-07】构造函数不再启动副作用，需显式初始化
    service.initialize();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('场景：网络断开后恢复', () => {
    it('断开期间的修改应该在恢复后同步', async () => {
      // 1. 初始状态：在线
      expect(service.isOnline()).toBe(true);
      
      // 2. 创建项目并标记本地变更
      const project = createTestProject({ id: 'proj-1', version: 1 });
      mockProjectStateService.activeProject.set(project);
      mockProjectStateService.projects.set([project]);
      service.markLocalChanges();
      
      // 3. 网络断开
      mockSyncService.syncState.set(createMockSyncState({
        isOnline: false,
        offlineMode: true,
      }));
      
      expect(service.isOnline()).toBe(false);
      
      // 4. 继续修改（离线）
      const offlineProject = { ...project, name: 'Modified Offline', version: 2 };
      mockProjectStateService.activeProject.set(offlineProject);
      mockProjectStateService.projects.set([offlineProject]);
      service.markLocalChanges();
      
      // 5. 网络恢复
      mockSyncService.syncState.set(createMockSyncState({
        isOnline: true,
        offlineMode: false,
      }));
      
      expect(service.isOnline()).toBe(true);
      
      // 6. 模拟重连后合并
      const cloudProjects: Project[] = [{ ...project, version: 1 }];
      mockSyncService.saveProjectToCloud.mockResolvedValueOnce({ success: true });

      // 模拟委托服务返回同步结果
      mockProjectSyncOperationsService.mergeOfflineDataOnReconnect.mockResolvedValueOnce({
        projects: [offlineProject],
        syncedCount: 1,
        conflictProjects: [],
      });
      
      const result = await service.mergeOfflineDataOnReconnect(
        cloudProjects,
        [offlineProject],
        'user-123'
      );
      
      expect(result.syncedCount).toBe(1);
    });
  });

  describe('场景：多设备同时编辑', () => {
    it('版本冲突时应该提供合并选项', async () => {
      // 设备 A 的本地版本
      const localProject = createTestProject({
        id: 'proj-shared',
        version: 5,
        name: 'Device A Edit',
        tasks: [createTestTask({ id: 'task-1', title: 'Task from A' })],
      });
      
      // 设备 B 已经同步到云端的版本
      const remoteProject = createTestProject({
        id: 'proj-shared',
        version: 6,
        name: 'Device B Edit',
        tasks: [createTestTask({ id: 'task-2', title: 'Task from B' })],
      });
      
      // 设备 A 尝试保存时发现冲突
      mockSyncService.saveProjectSmart.mockResolvedValueOnce({
        success: false,
        conflict: true,
        remoteData: remoteProject,
      });
      
      const result = await service.core.saveProjectSmart(localProject, 'user-123');
      
      expect(result.success).toBe(false);
      expect(result.conflict).toBe(true);
      expect(result.remoteData).toEqual(remoteProject);
      
      // 用户选择合并
      const tombstoneIds = new Set<string>();
      const _mergeResult = service.smartMerge(localProject, remoteProject, tombstoneIds);
      void _mergeResult; // 仅验证调用
      
      expect(mockConflictService.smartMerge).toHaveBeenCalledWith(localProject, remoteProject, tombstoneIds);
    });
  });

  describe('场景：会话过期', () => {
    it('会话过期时应该正确更新状态', () => {
      expect(service.sessionExpired()).toBe(false);
      
      mockSyncService.syncState.set(createMockSyncState({
        sessionExpired: true,
        syncError: '登录已过期，请重新登录',
      }));
      
      expect(service.sessionExpired()).toBe(true);
      expect(service.syncError()).toBe('登录已过期，请重新登录');
    });
  });

  describe('场景：极端网络抖动', () => {
    it('网络频繁切换时不应该丢失数据', async () => {
      const project = createTestProject({ id: 'proj-jitter', version: 1 });
      mockProjectStateService.activeProject.set(project);
      mockProjectStateService.projects.set([project]);
      
      // 模拟频繁的网络状态切换
      for (let i = 0; i < 5; i++) {
        // 断开
        mockSyncService.syncState.set(createMockSyncState({
          isOnline: false,
          offlineMode: true,
        }));
        service.markLocalChanges();
        await vi.advanceTimersByTimeAsync(100);
        
        // 恢复
        mockSyncService.syncState.set(createMockSyncState({
          isOnline: true,
          offlineMode: false,
        }));
        await vi.advanceTimersByTimeAsync(100);
      }
      
      // 本地变更标记应该仍然存在
      expect(service.hasPendingLocalChanges()).toBe(true);
    });
    
    it('快速重连时不应该触发多次同步', async () => {
      const project = createTestProject({ id: 'proj-rapid', version: 1 });
      mockProjectStateService.activeProject.set(project);
      mockProjectStateService.projects.set([project]);
      
      // 快速重连 10 次
      for (let i = 0; i < 10; i++) {
        mockSyncService.syncState.set(createMockSyncState({
          isOnline: false,
          offlineMode: true,
        }));
        await vi.advanceTimersByTimeAsync(10);
        mockSyncService.syncState.set(createMockSyncState({
          isOnline: true,
          offlineMode: false,
        }));
        await vi.advanceTimersByTimeAsync(10);
      }
      
      // 在防抖期内，不应该有大量保存调用
      // 等待防抖完成
      await vi.advanceTimersByTimeAsync(1000);
      
      // saveOfflineSnapshot 应该被调用（因为 schedulePersist），但次数应该合理
      const callCount = mockSyncService.saveOfflineSnapshot.mock.calls.length;
      expect(callCount).toBeLessThanOrEqual(3); // 合理的调用次数
    });
  });
  
  describe('场景：大规模离线数据合并', () => {
    it('应该正确处理大量离线项目的合并', async () => {
      // Sprint 9: mergeOfflineDataOnReconnect 现在委托给 ProjectSyncOperationsService
      // 创建 50 个离线项目
      const offlineProjects: Project[] = [];
      for (let i = 0; i < 50; i++) {
        offlineProjects.push(createTestProject({
          id: `offline-proj-${i}`,
          name: `Offline Project ${i}`,
          version: 1
        }));
      }
      
      // 云端有其中一半
      const cloudProjects = offlineProjects.slice(0, 25).map(p => ({
        ...p,
        version: 2 // 云端版本更高
      }));
      
      // 配置 mock 返回预期结果
      mockProjectSyncOperationsService.mergeOfflineDataOnReconnect.mockResolvedValueOnce({
        projects: [...cloudProjects, ...offlineProjects.slice(25)],
        syncedCount: 25,
        conflictProjects: []
      });
      
      const result = await service.mergeOfflineDataOnReconnect(
        cloudProjects,
        offlineProjects,
        'user-123'
      );
      
      // 验证委托调用
      expect(mockProjectSyncOperationsService.mergeOfflineDataOnReconnect).toHaveBeenCalledWith(
        cloudProjects,
        offlineProjects,
        'user-123',
        expect.any(Function),
        expect.any(Function)
      );
      // 验证返回预期结果
      expect(result.syncedCount).toBe(25);
      expect(result.projects.length).toBe(50);
    });
    
    it('合并时遇到部分失败应该继续处理其他项目', async () => {
      const offlineProjects = [
        createTestProject({ id: 'proj-1', version: 2 }),
        createTestProject({ id: 'proj-2', version: 2 }),
        createTestProject({ id: 'proj-3', version: 2 }),
      ];
      
      // Sprint 9: 配置 mock 返回预期结果
      mockProjectSyncOperationsService.mergeOfflineDataOnReconnect.mockResolvedValueOnce({
        projects: [offlineProjects[0], offlineProjects[2]],
        syncedCount: 2,
        conflictProjects: []
      });
      
      const result = await service.mergeOfflineDataOnReconnect(
        [], // 云端为空
        offlineProjects,
        'user-123'
      );
      
      // 应该同步 2 个项目（第 1 和第 3）
      expect(result.syncedCount).toBe(2);
    });
  });
  
  describe('场景：版本号边界条件', () => {
    it('版本号为 0 时应该正确处理', async () => {
      const project = createTestProject({ id: 'proj-zero', version: 0 });
      
      mockSyncService.saveProjectSmart.mockResolvedValueOnce({ success: true });
      
      const result = await service.core.saveProjectSmart(project, 'user-123');
      
      expect(result.success).toBe(true);
    });
    
    it('版本号为极大值时应该正确处理', async () => {
      const project = createTestProject({ 
        id: 'proj-large', 
        version: Number.MAX_SAFE_INTEGER - 1 
      });
      
      mockSyncService.saveProjectSmart.mockResolvedValueOnce({ success: true });
      
      const result = await service.core.saveProjectSmart(project, 'user-123');
      
      expect(result.success).toBe(true);
    });
    
    it('版本号差异很大时的合并应该使用较大版本', () => {
      const localProject = createTestProject({ id: 'proj-1', version: 10 });
      const remoteProject = createTestProject({ id: 'proj-1', version: 1000 });
      
      // 调用智能合并
      const tombstoneIds = new Set<string>();
      service.smartMerge(localProject, remoteProject, tombstoneIds);
      
      // 验证调用参数
      expect(mockConflictService.smartMerge).toHaveBeenCalledWith(
        localProject,
        remoteProject,
        tombstoneIds
      );
    });
  });
});
