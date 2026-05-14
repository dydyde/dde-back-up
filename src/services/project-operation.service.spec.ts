import { describe, expect, it, beforeEach, vi } from 'vitest';
import { Injector, runInInjectionContext } from '@angular/core';
import { ProjectOperationService } from './project-operation.service';
import { ProjectStateService } from './project-state.service';
import { SyncCoordinatorService } from './sync-coordinator.service';
import { UserSessionService } from './user-session.service';
import { ActionQueueService } from './action-queue.service';
import { ConflictStorageService } from './conflict-storage.service';
import { OptimisticStateService } from './optimistic-state.service';
import { LayoutService } from './layout.service';
import { UndoService } from './undo.service';
import { ToastService } from './toast.service';
import { LoggerService } from './logger.service';
import { ChangeTrackerService } from './change-tracker.service';
import { WriteGuardService } from './write-guard.service';
import { RetryQueueService } from '../app/core/services/sync/retry-queue.service';
import { AUTH_CONFIG } from '../config/auth.config';
import type { Project } from '../models';
import type { ConflictData } from '../app/core/services/sync';

function createProject(overrides: Partial<Project> = {}): Project {
  const now = '2026-03-30T00:00:00.000Z';
  return {
    id: overrides.id ?? 'proj-1',
    name: overrides.name ?? 'Project',
    description: overrides.description ?? '',
    createdDate: overrides.createdDate ?? now,
    updatedAt: overrides.updatedAt ?? now,
    version: overrides.version ?? 1,
    tasks: overrides.tasks ?? [],
    connections: overrides.connections ?? [],
    ...overrides,
  };
}

describe('ProjectOperationService', () => {
  let service: ProjectOperationService;

  const mockProjectState = {
    projects: vi.fn((): Project[] => []),
    updateProjects: vi.fn(),
    setActiveProjectId: vi.fn(),
    activeProjectId: vi.fn((): string | null => null),
    getProject: vi.fn((): Project | undefined => undefined),
  };

  const mockSyncCoordinator = {
    core: {
      saveProjectSmart: vi.fn().mockResolvedValue({ success: false, conflict: false }),
      deleteProjectFromCloud: vi.fn().mockResolvedValue({
        ok: false,
        error: {
          code: 'SYNC_OFFLINE',
          message: '当前离线，删除将在恢复连接后重试',
          details: { retryable: true },
        },
      }),
      deleteTask: vi.fn().mockResolvedValue(true),
      saveOfflineSnapshot: vi.fn(),
    },
    conflictData: vi.fn((): (Omit<ConflictData, 'remote'> & { remote?: Project }) | null => null),
    resolveConflict: vi.fn().mockResolvedValue({ ok: true, value: createProject({ id: 'proj-1' }) }),
    resolveConflictWithPlan: vi.fn().mockResolvedValue({ ok: true, value: createProject({ id: 'proj-1' }) }),
    validateAndRebalance: vi.fn((project: Project) => project),
    captureConflict: vi.fn().mockResolvedValue(undefined),
    clearActiveConflict: vi.fn(),
    loadSingleProjectFromCloud: vi.fn().mockResolvedValue(null),
    markLocalChanges: vi.fn(),
    schedulePersist: vi.fn(),
  };

  const mockUserSession = {
    currentUserId: vi.fn((): string => AUTH_CONFIG.LOCAL_MODE_USER_ID),
    getCurrentSessionGeneration: vi.fn(() => 1),
    isSessionContextCurrent: vi.fn(() => true),
    isHintOnlyStartupPlaceholderVisible: vi.fn(() => false),
  };

  const mockWriteGuard = {
    isExportOnly: vi.fn(() => false),
  };

  const mockActionQueue = {
    enqueue: vi.fn(),
    enqueueForOwner: vi.fn().mockResolvedValue('queued-old-owner'),
    discardActions: vi.fn(),
    settleProjectDeleteSuccessForOwner: vi.fn().mockResolvedValue(1),
  };

  const mockRetryQueue = {
    removeByProjectIdForOwner: vi.fn(),
    removeByProjectId: vi.fn(),
  };

  const mockConflictStorage = {
    getConflict: vi.fn().mockResolvedValue(null),
    saveConflict: vi.fn().mockResolvedValue(true),
    deleteConflict: vi.fn().mockResolvedValue(true),
  };

  const mockOptimisticState = {
    createSnapshot: vi.fn(() => ({ id: 'snap-1' })),
    commitSnapshot: vi.fn(),
    rollbackSnapshot: vi.fn(),
  };

  const mockLayout = {
    rebalance: vi.fn((project: Project) => project),
  };

  const mockUndo = { clearHistory: vi.fn() };

  const mockChangeTracker = {
    clearProjectFieldLocks: vi.fn(),
    clearProjectChanges: vi.fn(),
  };

  const mockToast = {
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  };

  const mockLoggerService = {
    category: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    })),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockProjectState.projects.mockReturnValue([]);
    mockUserSession.currentUserId.mockReturnValue(AUTH_CONFIG.LOCAL_MODE_USER_ID);
    mockUserSession.getCurrentSessionGeneration.mockReturnValue(1);
    mockUserSession.isSessionContextCurrent.mockReturnValue(true);
    mockUserSession.isHintOnlyStartupPlaceholderVisible.mockReturnValue(false);
    mockWriteGuard.isExportOnly.mockReturnValue(false);
    mockSyncCoordinator.core.saveProjectSmart.mockReset();
    mockSyncCoordinator.core.deleteTask.mockReset();
    mockSyncCoordinator.resolveConflict.mockReset();
    mockSyncCoordinator.resolveConflictWithPlan.mockReset();
    mockSyncCoordinator.captureConflict.mockReset();
    mockSyncCoordinator.loadSingleProjectFromCloud.mockReset();
    mockConflictStorage.getConflict.mockReset();
    mockConflictStorage.saveConflict.mockReset();
    mockConflictStorage.deleteConflict.mockReset();
    mockSyncCoordinator.core.saveProjectSmart.mockResolvedValue({ success: false, conflict: false });
    mockSyncCoordinator.core.deleteTask.mockResolvedValue(true);
    mockSyncCoordinator.resolveConflict.mockResolvedValue({ ok: true, value: createProject({ id: 'proj-1' }) });
    mockSyncCoordinator.resolveConflictWithPlan.mockResolvedValue({ ok: true, value: createProject({ id: 'proj-1' }) });
    mockSyncCoordinator.captureConflict.mockResolvedValue(undefined);
    mockSyncCoordinator.loadSingleProjectFromCloud.mockResolvedValue(null);
    mockConflictStorage.getConflict.mockResolvedValue(null);
    mockConflictStorage.saveConflict.mockResolvedValue(true);
    mockConflictStorage.deleteConflict.mockResolvedValue(true);

    const injector = Injector.create({
      providers: [
        { provide: ProjectOperationService, useClass: ProjectOperationService },
        { provide: ProjectStateService, useValue: mockProjectState },
        { provide: SyncCoordinatorService, useValue: mockSyncCoordinator },
        { provide: UserSessionService, useValue: mockUserSession },
        { provide: ActionQueueService, useValue: mockActionQueue },
        { provide: RetryQueueService, useValue: mockRetryQueue },
        { provide: ConflictStorageService, useValue: mockConflictStorage },
        { provide: OptimisticStateService, useValue: mockOptimisticState },
        { provide: LayoutService, useValue: mockLayout },
        { provide: UndoService, useValue: mockUndo },
        { provide: ToastService, useValue: mockToast },
        { provide: LoggerService, useValue: mockLoggerService },
        { provide: ChangeTrackerService, useValue: mockChangeTracker },
        { provide: WriteGuardService, useValue: mockWriteGuard },
      ],
    });

    service = runInInjectionContext(injector, () => injector.get(ProjectOperationService));
  });

  it('resolveConflict 在 backgroundPersist 模式下不应等待 saveProjectSmart 完成', async () => {
    const deferred = (() => {
      let resolve: ((value: unknown) => void) | null = null;
      const promise = new Promise((res) => {
        resolve = res as (value: unknown) => void;
      });
      return { promise, resolve: resolve! };
    })();

    mockConflictStorage.getConflict.mockResolvedValueOnce({
      projectId: 'proj-bg',
      localProject: createProject({ id: 'proj-bg', name: 'Local Conflict' }),
      remoteProject: createProject({ id: 'proj-bg', name: 'Remote Conflict', version: 3 }),
      conflictedAt: '2026-03-30T00:00:00.000Z',
      localVersion: 1,
      remoteVersion: 3,
    });
    mockProjectState.getProject.mockReturnValue(createProject({ id: 'proj-bg', name: 'Local Conflict' }));
    mockSyncCoordinator.resolveConflict.mockResolvedValueOnce({
      ok: true,
      value: createProject({ id: 'proj-bg', name: 'Resolved Conflict', version: 4 }),
    });
    mockUserSession.currentUserId.mockReturnValue('user-1');
    mockSyncCoordinator.core.saveProjectSmart.mockReturnValueOnce(deferred.promise as never);

    const resolved = await service.resolveConflict('proj-bg', 'local', { backgroundPersist: true });

    expect(resolved).toBe(true);
    expect(mockSyncCoordinator.core.saveProjectSmart).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'proj-bg', name: 'Resolved Conflict' }),
      'user-1',
    );

    deferred.resolve({ success: true, newVersion: 10 });
    await Promise.resolve();
  });

  it('本地模式创建项目失败时不应写入云端 ActionQueue', async () => {
    await service.addProject(createProject({ id: 'proj-local-only' }));

    expect(mockSyncCoordinator.core.saveProjectSmart).not.toHaveBeenCalled();
    expect(mockActionQueue.enqueue).not.toHaveBeenCalled();
    expect(mockOptimisticState.commitSnapshot).toHaveBeenCalled();
    expect(mockSyncCoordinator.markLocalChanges).toHaveBeenCalledWith('structure');
    expect(mockSyncCoordinator.schedulePersist).toHaveBeenCalled();
  });

  it('hint-only 启动占位下创建项目应被只读门控阻止', async () => {
    mockUserSession.isHintOnlyStartupPlaceholderVisible.mockReturnValue(true);

    const result = await service.addProject(createProject({ id: 'proj-hint-only' }));

    expect(result).toEqual({ success: false, error: '会话确认中，owner 确认完成前暂时只读' });
    expect(mockProjectState.updateProjects).not.toHaveBeenCalled();
    expect(mockOptimisticState.createSnapshot).not.toHaveBeenCalled();
    expect(mockToast.info).toHaveBeenCalledWith('会话确认中', '创建项目暂不可用，owner 确认完成前保持只读');
  });

  it('export-only 旧入口下应阻止本地项目写入', async () => {
    mockWriteGuard.isExportOnly.mockReturnValue(true);

    const result = await service.addProject(createProject({ id: 'proj-export-only' }));
    service.updateProjectMetadata('proj-export-only', { description: 'blocked' });

    expect(result).toEqual({ success: false, error: '导出模式下禁止本地写入' });
    expect(mockProjectState.updateProjects).not.toHaveBeenCalled();
    expect(mockOptimisticState.createSnapshot).not.toHaveBeenCalled();
    expect(mockSyncCoordinator.markLocalChanges).not.toHaveBeenCalled();
    expect(mockToast.info).toHaveBeenCalledWith(
      '导出模式',
      '创建项目暂不可用，旧入口仅允许导出，请前往 https://nanoflow.pages.dev 继续编辑'
    );
    expect(mockToast.info).toHaveBeenCalledWith(
      '导出模式',
      '保存项目设置暂不可用，旧入口仅允许导出，请前往 https://nanoflow.pages.dev 继续编辑'
    );
  });

  it('认证用户离线创建项目时应保留 synced 标记并进入 create 队列', async () => {
    mockUserSession.currentUserId.mockReturnValue('user-1');
    mockSyncCoordinator.core.saveProjectSmart.mockResolvedValueOnce({ success: false, conflict: false });

    await service.addProject(createProject({ id: 'proj-cloud-offline' }));

    const updater = mockProjectState.updateProjects.mock.calls[0]?.[0] as ((projects: Project[]) => Project[]);
    const updatedProjects = updater([]);
    expect(updatedProjects[0]).toEqual(expect.objectContaining({
      id: 'proj-cloud-offline',
      syncSource: 'synced',
      pendingSync: true,
    }));
    expect(mockActionQueue.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      type: 'create',
      entityType: 'project',
      entityId: 'proj-cloud-offline',
      payload: expect.objectContaining({
        sourceUserId: 'user-1',
        project: expect.objectContaining({
          syncSource: 'synced',
          pendingSync: true,
        }),
      }),
    }));
  });

  it('认证用户直连创建项目成功后应清除 pendingSync 并回写新版本', async () => {
    mockUserSession.currentUserId.mockReturnValue('user-1');
    mockSyncCoordinator.core.saveProjectSmart.mockResolvedValueOnce({ success: true, newVersion: 5 });

    const result = await service.addProject(createProject({ id: 'proj-cloud-success' }));

    expect(result).toEqual({ success: true });
    const updater = mockProjectState.updateProjects.mock.calls.at(-1)?.[0] as ((projects: Project[]) => Project[]);
    expect(updater([createProject({ id: 'proj-cloud-success', pendingSync: true, syncSource: 'synced', version: 1 })])).toEqual([
      expect.objectContaining({
        id: 'proj-cloud-success',
        pendingSync: false,
        syncSource: 'synced',
        version: 5,
      }),
    ]);
  });

  it('认证用户创建项目命中 terminal 同步失败时不应进入 create 队列', async () => {
    mockUserSession.currentUserId.mockReturnValue('user-1');
    mockSyncCoordinator.core.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      terminal: true,
      failureReason: '当前客户端同步协议已过期，请刷新后重试',
    });

    const result = await service.addProject(createProject({ id: 'proj-terminal-create' }));

    expect(result).toEqual({ success: true });
    const updater = mockProjectState.updateProjects.mock.calls.at(-1)?.[0] as ((projects: Project[]) => Project[]);
    expect(mockActionQueue.enqueue).not.toHaveBeenCalled();
    expect(mockActionQueue.enqueueForOwner).not.toHaveBeenCalled();
    expect(mockActionQueue.discardActions).toHaveBeenCalled();
    expect(mockRetryQueue.removeByProjectIdForOwner).toHaveBeenCalledWith('proj-terminal-create', 'user-1');
    expect(mockToast.error).toHaveBeenCalledWith('同步已停止', '当前客户端同步协议已过期，请刷新后重试');
    expect(mockOptimisticState.commitSnapshot).toHaveBeenCalledWith('snap-1');
    expect(mockSyncCoordinator.markLocalChanges).not.toHaveBeenCalled();
    expect(mockSyncCoordinator.schedulePersist).not.toHaveBeenCalled();
    expect(mockSyncCoordinator.core.saveOfflineSnapshot).toHaveBeenCalled();
    expect(updater([createProject({ id: 'proj-terminal-create', pendingSync: true, syncSource: 'synced' })])).toEqual([
      expect.objectContaining({
        id: 'proj-terminal-create',
        pendingSync: false,
        syncSource: 'synced',
      }),
    ]);
  });

  it('导入项目命中 terminal 同步失败时不应进入任何同步队列', async () => {
    mockUserSession.currentUserId.mockReturnValue('user-1');
    mockProjectState.getProject.mockReturnValue(createProject({ id: 'proj-import-terminal', name: 'Existing Import', pendingSync: true }));
    mockSyncCoordinator.core.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      terminal: true,
      failureReason: '当前客户端同步协议已过期，请刷新后重试',
    });

    const result = await service.upsertImportedProject(createProject({ id: 'proj-import-terminal' }));

    expect(result).toEqual({ success: true });
    const updater = mockProjectState.updateProjects.mock.calls.at(-1)?.[0] as ((projects: Project[]) => Project[]);
    expect(mockActionQueue.enqueue).not.toHaveBeenCalled();
    expect(mockActionQueue.enqueueForOwner).not.toHaveBeenCalled();
    expect(mockActionQueue.discardActions).toHaveBeenCalled();
    expect(mockRetryQueue.removeByProjectIdForOwner).toHaveBeenCalledWith('proj-import-terminal', 'user-1');
    expect(mockToast.error).toHaveBeenCalledWith('同步已停止', '当前客户端同步协议已过期，请刷新后重试');
    expect(mockSyncCoordinator.core.saveOfflineSnapshot).toHaveBeenCalled();
    expect(updater([createProject({ id: 'proj-import-terminal', name: 'Newest Local Title', pendingSync: true, syncSource: 'synced' })])).toEqual([
      expect.objectContaining({
        id: 'proj-import-terminal',
        name: 'Newest Local Title',
        pendingSync: false,
        syncSource: 'synced',
      }),
    ]);
    expect(updater([])).toEqual([]);
  });

  it('导入项目的旧会话非冲突失败结果应写回原 owner 队列', async () => {
    mockUserSession.currentUserId.mockReturnValue('user-1');
    mockProjectState.getProject.mockReturnValue(undefined);
    mockSyncCoordinator.core.saveProjectSmart.mockResolvedValueOnce({ success: false, conflict: false });
    mockUserSession.isSessionContextCurrent.mockReturnValueOnce(false);

    const result = await service.upsertImportedProject(createProject({ id: 'proj-import-stale-failure' }));

    expect(result).toEqual({ success: true });
    expect(mockActionQueue.enqueueForOwner).toHaveBeenCalledWith('user-1', expect.objectContaining({
      type: 'create',
      entityType: 'project',
      entityId: 'proj-import-stale-failure',
      payload: expect.objectContaining({
        sourceUserId: 'user-1',
        project: expect.objectContaining({
          id: 'proj-import-stale-failure',
          syncSource: 'synced',
          pendingSync: true,
        }),
      }),
    }));
    expect(mockActionQueue.enqueue).not.toHaveBeenCalled();
  });

  it('导入项目的旧会话成功结果在同 owner 下应回写 pendingSync=false 与新版本', async () => {
    mockUserSession.currentUserId.mockReturnValue('user-1');
    mockProjectState.getProject.mockReturnValue(createProject({ id: 'proj-import-stale-success', name: 'Imported Success', pendingSync: true, syncSource: 'synced' }));
    mockSyncCoordinator.core.saveProjectSmart.mockResolvedValueOnce({ success: true, newVersion: 9 });
    mockUserSession.isSessionContextCurrent.mockReturnValueOnce(false);

    const result = await service.upsertImportedProject(createProject({ id: 'proj-import-stale-success', name: 'Imported Success' }));

    expect(result).toEqual({ success: true });
    const updater = mockProjectState.updateProjects.mock.calls.at(-1)?.[0] as ((projects: Project[]) => Project[]);
    expect(mockActionQueue.enqueueForOwner).not.toHaveBeenCalled();
    expect(mockActionQueue.discardActions).toHaveBeenCalled();
    expect(mockRetryQueue.removeByProjectIdForOwner).toHaveBeenCalledWith('proj-import-stale-success', 'user-1');
    expect(updater([createProject({ id: 'proj-import-stale-success', name: 'Imported Success', version: 1, pendingSync: true, syncSource: 'synced' })])).toEqual([
      expect.objectContaining({
        id: 'proj-import-stale-success',
        version: 9,
        pendingSync: false,
        syncSource: 'synced',
      }),
    ]);
  });

  it('导入项目的旧会话 terminal 结果在同 owner 下应清理 pendingSync 并清空旧队列', async () => {
    mockUserSession.currentUserId.mockReturnValue('user-1');
    mockProjectState.getProject.mockReturnValue(createProject({ id: 'proj-import-stale-terminal', name: 'Imported Terminal', pendingSync: true, syncSource: 'synced' }));
    mockSyncCoordinator.core.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      terminal: true,
      failureReason: '当前客户端同步协议已过期，请刷新后重试',
    });
    mockUserSession.isSessionContextCurrent.mockReturnValueOnce(false);

    const result = await service.upsertImportedProject(createProject({ id: 'proj-import-stale-terminal', name: 'Imported Terminal' }));

    expect(result).toEqual({ success: true });
    const updater = mockProjectState.updateProjects.mock.calls.at(-1)?.[0] as ((projects: Project[]) => Project[]);
    expect(mockActionQueue.enqueueForOwner).not.toHaveBeenCalled();
    expect(mockActionQueue.discardActions).toHaveBeenCalled();
    expect(mockRetryQueue.removeByProjectIdForOwner).toHaveBeenCalledWith('proj-import-stale-terminal', 'user-1');
    expect(updater([createProject({ id: 'proj-import-stale-terminal', name: 'Newest Local Import', pendingSync: true, syncSource: 'synced' })])).toEqual([
      expect.objectContaining({
        id: 'proj-import-stale-terminal',
        name: 'Newest Local Import',
        pendingSync: false,
      }),
    ]);
  });

  it('导入项目的旧会话 terminal 结果在当前项目已继续演化时不应清空新队列', async () => {
    mockUserSession.currentUserId.mockReturnValue('user-1');
    mockProjectState.getProject.mockReturnValue(createProject({ id: 'proj-import-stale-terminal-diverged', name: 'Diverged Local Import', pendingSync: true, syncSource: 'synced' }));
    mockSyncCoordinator.core.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      terminal: true,
      failureReason: '当前客户端同步协议已过期，请刷新后重试',
    });
    mockUserSession.isSessionContextCurrent.mockReturnValueOnce(false);

    const result = await service.upsertImportedProject(createProject({ id: 'proj-import-stale-terminal-diverged', name: 'Imported Terminal' }));

    expect(result).toEqual({ success: true });
    expect(mockActionQueue.discardActions).not.toHaveBeenCalled();
    expect(mockRetryQueue.removeByProjectIdForOwner).not.toHaveBeenCalledWith('proj-import-stale-terminal-diverged', 'user-1');
  });

  it('导入项目的旧会话异常结果应写回原 owner 的 update 队列', async () => {
    mockUserSession.currentUserId.mockReturnValue('user-1');
    mockProjectState.getProject.mockReturnValue(createProject({ id: 'proj-import-stale-error', name: 'Existing Import' }));
    mockSyncCoordinator.core.saveProjectSmart.mockRejectedValueOnce(new Error('network down'));
    mockUserSession.isSessionContextCurrent.mockReturnValueOnce(false);

    const result = await service.upsertImportedProject(createProject({ id: 'proj-import-stale-error', name: 'Imported Error' }));

    expect(result).toEqual({ success: true });
    expect(mockActionQueue.enqueueForOwner).toHaveBeenCalledWith('user-1', expect.objectContaining({
      type: 'update',
      entityType: 'project',
      entityId: 'proj-import-stale-error',
      payload: expect.objectContaining({
        sourceUserId: 'user-1',
        project: expect.objectContaining({
          id: 'proj-import-stale-error',
          syncSource: 'synced',
          pendingSync: true,
        }),
      }),
    }));
    expect(mockActionQueue.enqueue).not.toHaveBeenCalled();
  });

  it('创建项目的旧会话失败结果应写回原 owner 队列而不是当前会话', async () => {
    mockUserSession.currentUserId.mockReturnValue('user-1');
    mockSyncCoordinator.core.saveProjectSmart.mockResolvedValueOnce({ success: false, conflict: false });
    mockUserSession.isSessionContextCurrent.mockReturnValueOnce(false);

    const result = await service.addProject(createProject({ id: 'proj-stale-create' }));

    expect(result).toEqual({ success: true });
    expect(mockActionQueue.enqueueForOwner).toHaveBeenCalledWith('user-1', expect.objectContaining({
      type: 'create',
      entityType: 'project',
      entityId: 'proj-stale-create',
      payload: expect.objectContaining({
        sourceUserId: 'user-1',
        project: expect.objectContaining({
          id: 'proj-stale-create',
          syncSource: 'synced',
          pendingSync: true,
        }),
      }),
    }));
    expect(mockActionQueue.enqueue).not.toHaveBeenCalled();
  });

  it('创建项目的旧会话成功结果在同 owner 下应回写 pendingSync=false 与新版本', async () => {
    mockUserSession.currentUserId.mockReturnValue('user-1');
    mockProjectState.getProject.mockReturnValue(createProject({ id: 'proj-stale-create-success', pendingSync: true, syncSource: 'synced' }));
    mockSyncCoordinator.core.saveProjectSmart.mockResolvedValueOnce({ success: true, newVersion: 7 });
    mockUserSession.isSessionContextCurrent.mockReturnValueOnce(false);

    const result = await service.addProject(createProject({ id: 'proj-stale-create-success' }));

    expect(result).toEqual({ success: true });
    const updater = mockProjectState.updateProjects.mock.calls.at(-1)?.[0] as ((projects: Project[]) => Project[]);
    expect(mockActionQueue.enqueueForOwner).not.toHaveBeenCalled();
    expect(mockActionQueue.discardActions).toHaveBeenCalled();
    expect(mockRetryQueue.removeByProjectIdForOwner).toHaveBeenCalledWith('proj-stale-create-success', 'user-1');
    expect(updater([createProject({ id: 'proj-stale-create-success', version: 1, pendingSync: true, syncSource: 'synced' })])).toEqual([
      expect.objectContaining({
        id: 'proj-stale-create-success',
        version: 7,
        pendingSync: false,
        syncSource: 'synced',
      }),
    ]);
  });

  it('创建项目的旧会话 terminal 结果在同 owner 下应清理 pendingSync', async () => {
    mockUserSession.currentUserId.mockReturnValue('user-1');
    mockProjectState.getProject.mockReturnValue(createProject({ id: 'proj-stale-create-terminal', pendingSync: true, syncSource: 'synced' }));
    mockSyncCoordinator.core.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      terminal: true,
      failureReason: '当前客户端同步协议已过期，请刷新后重试',
    });
    mockUserSession.isSessionContextCurrent.mockReturnValueOnce(false);

    const result = await service.addProject(createProject({ id: 'proj-stale-create-terminal' }));

    expect(result).toEqual({ success: true });
    const updater = mockProjectState.updateProjects.mock.calls.at(-1)?.[0] as ((projects: Project[]) => Project[]);
    expect(mockActionQueue.enqueueForOwner).not.toHaveBeenCalled();
    expect(mockActionQueue.discardActions).toHaveBeenCalled();
    expect(mockRetryQueue.removeByProjectIdForOwner).toHaveBeenCalledWith('proj-stale-create-terminal', 'user-1');
    expect(updater([createProject({ id: 'proj-stale-create-terminal', pendingSync: true, syncSource: 'synced' })])).toEqual([
      expect.objectContaining({
        id: 'proj-stale-create-terminal',
        pendingSync: false,
        syncSource: 'synced',
      }),
    ]);
  });

  it('删除项目的旧会话异常结果应写回原 owner 队列而不是当前会话', async () => {
    mockUserSession.currentUserId.mockReturnValue('user-1');
    mockSyncCoordinator.core.deleteProjectFromCloud.mockRejectedValueOnce(new Error('network down'));
    mockUserSession.isSessionContextCurrent.mockReturnValueOnce(false);

    const result = await service.deleteProject('proj-stale-delete');

    expect(result).toEqual({ success: true });
    expect(mockActionQueue.enqueueForOwner).toHaveBeenCalledWith('user-1', expect.objectContaining({
      type: 'delete',
      entityType: 'project',
      entityId: 'proj-stale-delete',
      payload: expect.objectContaining({
        projectId: 'proj-stale-delete',
        userId: 'user-1',
        sourceUserId: 'user-1',
      }),
    }));
    expect(mockActionQueue.enqueue).not.toHaveBeenCalled();
  });

  it('删除项目遇到可重试失败时应保留本地删除并进入队列', async () => {
    mockUserSession.currentUserId.mockReturnValue('user-1');
    mockSyncCoordinator.core.deleteProjectFromCloud.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'SYNC_OFFLINE',
        message: '当前离线，删除将在恢复连接后重试',
        details: { retryable: true },
      },
    });

    const result = await service.deleteProject('proj-retry-delete');

    expect(result).toEqual({ success: true });
    expect(mockActionQueue.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      type: 'delete',
      entityId: 'proj-retry-delete',
    }));
    expect(mockOptimisticState.commitSnapshot).toHaveBeenCalledWith('snap-1');
    expect(mockOptimisticState.rollbackSnapshot).not.toHaveBeenCalled();
  });

  it('删除项目在云端成功后应清理同项目的挂起 mutation', async () => {
    mockUserSession.currentUserId.mockReturnValue('user-1');
    mockSyncCoordinator.core.deleteProjectFromCloud.mockResolvedValueOnce({
      ok: true,
      value: undefined,
    });

    const result = await service.deleteProject('proj-success-delete');

    expect(result).toEqual({ success: true });
    expect(mockActionQueue.settleProjectDeleteSuccessForOwner).toHaveBeenCalledWith('user-1', 'proj-success-delete');
    expect(mockRetryQueue.removeByProjectIdForOwner).toHaveBeenCalledWith('proj-success-delete', 'user-1');
    expect(mockOptimisticState.commitSnapshot).toHaveBeenCalledWith('snap-1');
  });

  it('删除项目的旧会话成功结果应清理原 owner 的挂起 mutation', async () => {
    mockUserSession.currentUserId.mockReturnValue('user-1');
    mockSyncCoordinator.core.deleteProjectFromCloud.mockResolvedValueOnce({
      ok: true,
      value: undefined,
    });
    mockUserSession.isSessionContextCurrent.mockReturnValueOnce(false);

    const result = await service.deleteProject('proj-stale-success-delete');

    expect(result).toEqual({ success: true });
    expect(mockActionQueue.settleProjectDeleteSuccessForOwner).toHaveBeenCalledWith('user-1', 'proj-stale-success-delete');
    expect(mockRetryQueue.removeByProjectIdForOwner).toHaveBeenCalledWith('proj-stale-success-delete', 'user-1');
    expect(mockOptimisticState.commitSnapshot).toHaveBeenCalledWith('snap-1');
  });

  it('删除项目遇到权限错误时应回滚本地状态而不是进入队列', async () => {
    mockUserSession.currentUserId.mockReturnValue('user-1');
    mockSyncCoordinator.core.deleteProjectFromCloud.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'PERMISSION_DENIED',
        message: '没有权限执行此操作',
      },
    });

    const result = await service.deleteProject('proj-permission-denied');

    expect(result).toEqual({ success: false, error: '没有权限执行此操作' });
    expect(mockOptimisticState.rollbackSnapshot).toHaveBeenCalledWith('snap-1', false);
    expect(mockActionQueue.enqueue).not.toHaveBeenCalled();
    expect(mockOptimisticState.commitSnapshot).not.toHaveBeenCalled();
  });

  it('导入现有项目在云端保存失败时应进入 project:update 队列', async () => {
    mockUserSession.currentUserId.mockReturnValue('user-1');
    mockProjectState.getProject.mockReturnValue(createProject({ id: 'proj-1', name: 'Existing' }));
    mockSyncCoordinator.core.saveProjectSmart.mockResolvedValueOnce({ success: false, conflict: false });

    const result = await service.upsertImportedProject(createProject({ id: 'proj-1', name: 'Imported' }));

    expect(result.success).toBe(true);
    expect(mockActionQueue.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      type: 'update',
      entityType: 'project',
      entityId: 'proj-1',
      payload: expect.objectContaining({ sourceUserId: 'user-1' }),
    }));
  });

  it('导入现有项目遇到冲突时应接入统一冲突链', async () => {
    mockUserSession.currentUserId.mockReturnValue('user-1');
    mockProjectState.getProject.mockReturnValue(createProject({ id: 'proj-1', name: 'Existing' }));
    mockSyncCoordinator.core.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      conflict: true,
      remoteData: createProject({ id: 'proj-1', name: 'Remote Existing', version: 2 }),
    });

    const result = await service.upsertImportedProject(createProject({ id: 'proj-1', name: 'Imported' }));

    expect(result.success).toBe(false);
    expect(mockSyncCoordinator.captureConflict).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'proj-1', name: 'Imported' }),
      expect.objectContaining({ id: 'proj-1', name: 'Remote Existing', version: 2 }),
      'user-1',
      undefined,
    );
    expect(mockActionQueue.enqueue).not.toHaveBeenCalled();
  });

  it('导入冲突缺少 remoteData 时应补拉远端版本再进入冲突链', async () => {
    mockUserSession.currentUserId.mockReturnValue('user-1');
    mockProjectState.getProject.mockReturnValue(createProject({ id: 'proj-1', name: 'Existing' }));
    mockSyncCoordinator.core.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      conflict: true,
    });
    mockSyncCoordinator.loadSingleProjectFromCloud.mockResolvedValueOnce(
      createProject({ id: 'proj-1', name: 'Remote Existing', version: 2 })
    );

    const result = await service.upsertImportedProject(createProject({ id: 'proj-1', name: 'Imported' }));

    expect(result.success).toBe(false);
    expect(mockSyncCoordinator.loadSingleProjectFromCloud).toHaveBeenCalledWith('proj-1');
    expect(mockSyncCoordinator.captureConflict).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'proj-1', name: 'Imported' }),
      expect.objectContaining({ id: 'proj-1', name: 'Remote Existing', version: 2 }),
      'user-1',
      undefined,
    );
  });

  it('导入项目的冲突结果若已属于旧会话，不应注入当前冲突链', async () => {
    mockUserSession.currentUserId.mockReturnValue('user-1');
    mockProjectState.getProject.mockReturnValue(createProject({ id: 'proj-1', name: 'Existing' }));
    mockSyncCoordinator.core.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      conflict: true,
      remoteData: createProject({ id: 'proj-1', name: 'Remote Existing', version: 2 }),
    });
    mockUserSession.isSessionContextCurrent.mockReturnValueOnce(false);

    const result = await service.upsertImportedProject(createProject({ id: 'proj-1', name: 'Imported' }));

    expect(result.success).toBe(true);
    expect(mockSyncCoordinator.captureConflict).not.toHaveBeenCalled();
    expect(mockConflictStorage.saveConflict).not.toHaveBeenCalled();
    expect(mockToast.warning).not.toHaveBeenCalledWith('导入存在冲突', expect.any(String));
  });

  it('冲突解决时若项目不在当前列表，应将 resolvedProject upsert 回本地状态', async () => {
    mockConflictStorage.getConflict.mockResolvedValueOnce({
      projectId: 'proj-missing',
      localProject: createProject({ id: 'proj-missing', name: 'Local Missing' }),
      remoteProject: createProject({ id: 'proj-missing', name: 'Remote Missing' }),
    });
    mockProjectState.getProject.mockReturnValue(undefined);
    mockSyncCoordinator.resolveConflict.mockResolvedValueOnce({
      ok: true,
      value: createProject({ id: 'proj-missing', name: 'Resolved Missing' }),
    });

    await service.resolveConflict('proj-missing', 'local');

    const finalProjects = mockProjectState.updateProjects.mock.calls.reduce((projects, call) => {
      const updater = call[0] as ((items: Project[]) => Project[]);
      return updater(projects);
    }, [] as Project[]);
    expect(finalProjects).toEqual([
      expect.objectContaining({ id: 'proj-missing', name: 'Resolved Missing' }),
    ]);
  });

  it('remote 解决冲突前应尝试补拉远端版本', async () => {
    mockSyncCoordinator.conflictData.mockReturnValue({
      projectId: 'proj-remote',
      local: createProject({ id: 'proj-remote', name: 'Local Only Conflict' }),
      remote: undefined,
    });
    mockConflictStorage.getConflict.mockResolvedValueOnce({
      projectId: 'proj-remote',
      localProject: createProject({ id: 'proj-remote', name: 'Local Only Conflict' }),
    });
    mockProjectState.getProject.mockReturnValue(undefined);
    mockSyncCoordinator.loadSingleProjectFromCloud.mockResolvedValueOnce(
      createProject({ id: 'proj-remote', name: 'Remote Reloaded', version: 5 })
    );
    mockSyncCoordinator.resolveConflict.mockResolvedValueOnce({
      ok: true,
      value: createProject({ id: 'proj-remote', name: 'Remote Reloaded', version: 5 }),
    });

    await service.resolveConflict('proj-remote', 'remote');

    expect(mockSyncCoordinator.loadSingleProjectFromCloud).toHaveBeenCalledWith('proj-remote');
    expect(mockSyncCoordinator.resolveConflict).toHaveBeenCalledWith(
      'proj-remote',
      'remote',
      expect.objectContaining({ id: 'proj-remote', name: 'Local Only Conflict' }),
      expect.objectContaining({ id: 'proj-remote', name: 'Remote Reloaded', version: 5 })
    );
    expect(mockSyncCoordinator.captureConflict).not.toHaveBeenCalled();
    expect(mockSyncCoordinator.clearActiveConflict).toHaveBeenCalled();
  });

  it('remote reload 刷新 stored conflict 后仍应清理最新冲突记录', async () => {
    const localProject = createProject({ id: 'proj-remote-refresh-cleanup', name: 'Local Reload Cleanup' });
    const refreshedRemote = createProject({ id: 'proj-remote-refresh-cleanup', name: 'Remote Reloaded Cleanup', version: 5 });
    mockUserSession.currentUserId.mockReturnValue('user-1');
    mockSyncCoordinator.conflictData.mockReturnValue({
      projectId: 'proj-remote-refresh-cleanup',
      local: localProject,
      remote: undefined,
      conflictedAt: '2026-03-30T00:00:00.000Z',
    });
    mockConflictStorage.getConflict
      .mockResolvedValueOnce({
        projectId: 'proj-remote-refresh-cleanup',
        localProject,
        conflictedAt: '2026-03-30T00:00:00.000Z',
        localVersion: 1,
        remoteVersion: 0,
      })
      .mockResolvedValueOnce({
        projectId: 'proj-remote-refresh-cleanup',
        localProject,
        remoteProject: refreshedRemote,
        remoteSnapshotFresh: true,
        ownerUserId: 'user-1',
        conflictedAt: '2026-03-30T00:01:00.000Z',
        localVersion: 1,
        remoteVersion: 5,
      })
      .mockResolvedValueOnce({
        projectId: 'proj-remote-refresh-cleanup',
        localProject,
        remoteProject: refreshedRemote,
        remoteSnapshotFresh: true,
        ownerUserId: 'user-1',
        conflictedAt: '2026-03-30T00:01:00.000Z',
        localVersion: 1,
        remoteVersion: 5,
      });
    mockProjectState.getProject.mockReturnValue(localProject);
    mockSyncCoordinator.loadSingleProjectFromCloud.mockResolvedValueOnce(refreshedRemote);
    mockSyncCoordinator.resolveConflict.mockResolvedValueOnce({
      ok: true,
      value: refreshedRemote,
    });

    const resolved = await service.resolveConflict('proj-remote-refresh-cleanup', 'remote');

    expect(resolved).toBe(true);
    expect(mockSyncCoordinator.loadSingleProjectFromCloud).toHaveBeenCalledWith('proj-remote-refresh-cleanup');
    expect(mockConflictStorage.deleteConflict).toHaveBeenCalledWith('proj-remote-refresh-cleanup', 'user-1');
  });

  it('cleanup 前若冲突已被更新版本替换，不应删除新的 stored 或 active conflict', async () => {
    const localProject = createProject({ id: 'proj-remote-refresh-guard', name: 'Local Reload Guard' });
    const refreshedRemote = createProject({ id: 'proj-remote-refresh-guard', name: 'Remote Reloaded Guard', version: 5 });
    const newerRemote = createProject({ id: 'proj-remote-refresh-guard', name: 'Remote Newer Guard', version: 6 });
    mockUserSession.currentUserId.mockReturnValue('user-1');
    mockSyncCoordinator.conflictData
      .mockReturnValueOnce({
        projectId: 'proj-remote-refresh-guard',
        local: localProject,
        remote: undefined,
        conflictedAt: '2026-03-30T00:00:00.000Z',
      })
      .mockReturnValue({
        projectId: 'proj-remote-refresh-guard',
        local: localProject,
        remote: newerRemote,
        conflictedAt: '2026-03-30T00:02:00.000Z',
      });
    mockConflictStorage.getConflict
      .mockResolvedValueOnce({
        projectId: 'proj-remote-refresh-guard',
        localProject,
        conflictedAt: '2026-03-30T00:00:00.000Z',
        localVersion: 1,
        remoteVersion: 0,
      })
      .mockResolvedValueOnce({
        projectId: 'proj-remote-refresh-guard',
        localProject,
        remoteProject: refreshedRemote,
        remoteSnapshotFresh: true,
        ownerUserId: 'user-1',
        conflictedAt: '2026-03-30T00:01:00.000Z',
        localVersion: 1,
        remoteVersion: 5,
      })
      .mockResolvedValueOnce({
        projectId: 'proj-remote-refresh-guard',
        localProject,
        remoteProject: newerRemote,
        remoteSnapshotFresh: true,
        ownerUserId: 'user-1',
        conflictedAt: '2026-03-30T00:02:00.000Z',
        localVersion: 1,
        remoteVersion: 6,
      });
    mockProjectState.getProject.mockReturnValue(localProject);
    mockSyncCoordinator.loadSingleProjectFromCloud.mockResolvedValueOnce(refreshedRemote);
    mockSyncCoordinator.resolveConflict.mockResolvedValueOnce({
      ok: true,
      value: refreshedRemote,
    });

    const resolved = await service.resolveConflict('proj-remote-refresh-guard', 'remote');

    expect(resolved).toBe(true);
    expect(mockConflictStorage.deleteConflict).not.toHaveBeenCalledWith('proj-remote-refresh-guard', 'user-1');
    expect(mockSyncCoordinator.clearActiveConflict).not.toHaveBeenCalled();
  });

  it('resolveConflictWithPlan 应委托逐任务计划并清理冲突状态', async () => {
    const localProject = createProject({
      id: 'proj-plan',
      name: 'Local Plan',
      tasks: [{ id: 'task-delete-1' } as Project['tasks'][number]],
    });
    const remoteProject = createProject({
      id: 'proj-plan',
      name: 'Remote Plan',
      version: 3,
      tasks: [{ id: 'task-delete-1' } as Project['tasks'][number]],
    });

    mockSyncCoordinator.conflictData.mockReturnValue({
      projectId: 'proj-plan',
      conflictedAt: '2026-03-30T00:00:00.000Z',
      local: localProject,
      remote: remoteProject,
      pendingTaskDeleteIds: ['task-delete-1'],
    });
    mockConflictStorage.getConflict.mockResolvedValue({
      projectId: 'proj-plan',
      localProject,
      remoteProject,
      conflictedAt: '2026-03-30T00:00:00.000Z',
      localVersion: localProject.version ?? 0,
      remoteVersion: remoteProject.version ?? 0,
      pendingTaskDeleteIds: ['task-delete-1'],
    });
    mockProjectState.getProject.mockReturnValue(localProject);
    mockSyncCoordinator.resolveConflictWithPlan.mockResolvedValueOnce({
      ok: true,
      value: createProject({
        id: 'proj-plan',
        name: 'Resolved Plan',
        version: 4,
        tasks: [{ id: 'task-delete-1' } as Project['tasks'][number]],
      }),
    });

    const resolved = await service.resolveConflictWithPlan('proj-plan', {
      taskChoices: { 'task-delete-1': 'remote' },
      appliedBy: 'mixed',
    });

    const finalProjects = mockProjectState.updateProjects.mock.calls.reduce((projects, call) => {
      const updater = call[0] as ((items: Project[]) => Project[]);
      return updater(projects);
    }, [] as Project[]);

    expect(resolved).toBe(true);
    expect(mockSyncCoordinator.resolveConflictWithPlan).toHaveBeenCalledWith(
      'proj-plan',
      { taskChoices: { 'task-delete-1': 'remote' }, appliedBy: 'mixed' },
      expect.objectContaining({ id: 'proj-plan', name: 'Local Plan' }),
      expect.objectContaining({ id: 'proj-plan', name: 'Remote Plan', version: 3 }),
    );
    expect(mockSyncCoordinator.resolveConflict).not.toHaveBeenCalled();
    expect(finalProjects[0]?.tasks.some((task: { id: string }) => task.id === 'task-delete-1')).toBe(true);
    expect(mockConflictStorage.deleteConflict).toHaveBeenCalled();
    expect(mockSyncCoordinator.clearActiveConflict).toHaveBeenCalled();
  });

  it('resolveConflict 若会话已切换，不应继续回写本地状态或删除冲突', async () => {
    mockConflictStorage.getConflict.mockResolvedValueOnce({
      projectId: 'proj-switched',
      localProject: createProject({ id: 'proj-switched', name: 'Local Switched' }),
      remoteProject: createProject({ id: 'proj-switched', name: 'Remote Switched', version: 2 }),
    });
    mockUserSession.isSessionContextCurrent.mockReturnValueOnce(false);

    const result = await service.resolveConflict('proj-switched', 'local');

    expect(result).toBe(false);
    expect(mockSyncCoordinator.resolveConflict).not.toHaveBeenCalled();
    expect(mockProjectState.updateProjects).not.toHaveBeenCalled();
    expect(mockConflictStorage.deleteConflict).not.toHaveBeenCalled();
  });

  it('冲突解决成功后应回写同步状态并清理脏标记', async () => {
    mockSyncCoordinator.conflictData.mockReturnValueOnce({
      projectId: 'proj-success',
      local: createProject({ id: 'proj-success', name: 'Local Conflict', pendingSync: true }),
      remote: createProject({ id: 'proj-success', name: 'Remote Conflict', version: 3 }),
    });
    mockConflictStorage.getConflict.mockResolvedValueOnce({
      projectId: 'proj-success',
      localProject: createProject({ id: 'proj-success', name: 'Local Conflict', pendingSync: true }),
      remoteProject: createProject({ id: 'proj-success', name: 'Remote Conflict', version: 3 }),
      pendingTaskDeleteIds: ['task-delete-1'],
    });
    mockProjectState.getProject.mockReturnValue(createProject({ id: 'proj-success', name: 'Local Conflict', pendingSync: true }));
    mockSyncCoordinator.resolveConflict.mockResolvedValueOnce({
      ok: true,
      value: createProject({ id: 'proj-success', name: 'Resolved Success', version: 4, pendingSync: true }),
    });
    mockUserSession.currentUserId.mockReturnValue('user-1');
    mockSyncCoordinator.core.saveProjectSmart.mockResolvedValueOnce({
      success: true,
      newVersion: 9,
    });

    await service.resolveConflict('proj-success', 'local');

    const updater = mockProjectState.updateProjects.mock.calls.at(-1)?.[0] as ((projects: Project[]) => Project[]);
    expect(updater([createProject({ id: 'proj-success', name: 'Resolved Success', pendingSync: true })])).toEqual([
      expect.objectContaining({
        id: 'proj-success',
        version: 9,
        syncSource: 'synced',
        pendingSync: false,
      }),
    ]);
    expect(mockActionQueue.discardActions).toHaveBeenCalled();
    expect(mockRetryQueue.removeByProjectIdForOwner).toHaveBeenCalledWith('proj-success', 'user-1');
    expect(mockChangeTracker.clearProjectFieldLocks).toHaveBeenCalledWith('proj-success');
    expect(mockChangeTracker.clearProjectChanges).toHaveBeenCalledWith('proj-success');
    expect(mockSyncCoordinator.core.deleteTask).toHaveBeenCalledWith('task-delete-1', 'proj-success', 'user-1');
  });

  it('resolveConflict 命中 terminal 同步失败时不应重新进入 ActionQueue', async () => {
    mockConflictStorage.getConflict.mockResolvedValue({
      projectId: 'proj-terminal-resolve',
      localProject: createProject({ id: 'proj-terminal-resolve', name: 'Local Conflict', pendingSync: true }),
      remoteProject: createProject({ id: 'proj-terminal-resolve', name: 'Remote Conflict', version: 3 }),
      pendingTaskDeleteIds: ['task-delete-1'],
    });
    mockProjectState.getProject
      .mockReturnValueOnce(createProject({ id: 'proj-terminal-resolve', name: 'Local Conflict', pendingSync: true }))
      .mockReturnValue(createProject({ id: 'proj-terminal-resolve', name: 'Resolved Terminal', version: 4, pendingSync: true, syncSource: 'synced' }));
    mockSyncCoordinator.resolveConflict.mockResolvedValueOnce({
      ok: true,
      value: createProject({ id: 'proj-terminal-resolve', name: 'Resolved Terminal', version: 4, pendingSync: true }),
    });
    mockUserSession.currentUserId.mockReturnValue('user-1');
    mockSyncCoordinator.core.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      terminal: true,
      failureReason: '当前客户端同步协议已过期，请刷新后重试',
    });

    const resolved = await service.resolveConflict('proj-terminal-resolve', 'local');

    expect(resolved).toBe(true);
    const updater = mockProjectState.updateProjects.mock.calls.at(-1)?.[0] as ((projects: Project[]) => Project[]);
    expect(mockActionQueue.enqueue).not.toHaveBeenCalled();
    expect(mockToast.warning).toHaveBeenCalledWith('同步已停止', '当前客户端同步协议已过期，请刷新后重试');
    expect(mockConflictStorage.deleteConflict).toHaveBeenCalledWith('proj-terminal-resolve', 'user-1');
    expect(mockChangeTracker.clearProjectFieldLocks).toHaveBeenCalledWith('proj-terminal-resolve');
    expect(mockChangeTracker.clearProjectChanges).toHaveBeenCalledWith('proj-terminal-resolve');
    expect(updater([createProject({ id: 'proj-terminal-resolve', pendingSync: true, syncSource: 'synced' })])).toEqual([
      expect.objectContaining({
        id: 'proj-terminal-resolve',
        pendingSync: false,
        syncSource: 'synced',
      }),
    ]);
  });

  it('resolveConflict live session terminal 且当前项目已继续演化时不应清空新变更', async () => {
    mockConflictStorage.getConflict.mockResolvedValue({
      projectId: 'proj-terminal-resolve-diverged',
      localProject: createProject({ id: 'proj-terminal-resolve-diverged', name: 'Local Conflict', pendingSync: true }),
      remoteProject: createProject({ id: 'proj-terminal-resolve-diverged', name: 'Remote Conflict', version: 3 }),
    });
    mockProjectState.getProject
      .mockReturnValueOnce(createProject({ id: 'proj-terminal-resolve-diverged', name: 'Local Conflict', pendingSync: true }))
      .mockReturnValue(createProject({ id: 'proj-terminal-resolve-diverged', name: 'Newest Local Conflict', version: 7, pendingSync: true, syncSource: 'synced' }));
    mockSyncCoordinator.resolveConflict.mockResolvedValueOnce({
      ok: true,
      value: createProject({ id: 'proj-terminal-resolve-diverged', name: 'Resolved Conflict', version: 4, pendingSync: true }),
    });
    mockUserSession.currentUserId.mockReturnValue('user-1');
    mockSyncCoordinator.core.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      terminal: true,
      failureReason: '当前客户端同步协议已过期，请刷新后重试',
    });

    const resolved = await service.resolveConflict('proj-terminal-resolve-diverged', 'local');

    expect(resolved).toBe(true);
    const updater = mockProjectState.updateProjects.mock.calls.at(-1)?.[0] as ((projects: Project[]) => Project[]);
    expect(mockActionQueue.discardActions).toHaveBeenCalledTimes(1);
    expect(mockRetryQueue.removeByProjectIdForOwner).toHaveBeenCalledTimes(1);
    expect(mockConflictStorage.deleteConflict).toHaveBeenCalledWith('proj-terminal-resolve-diverged', 'user-1');
    expect(mockChangeTracker.clearProjectFieldLocks).toHaveBeenCalledWith('proj-terminal-resolve-diverged');
    expect(mockChangeTracker.clearProjectChanges).not.toHaveBeenCalledWith('proj-terminal-resolve-diverged');
    expect(updater([createProject({ id: 'proj-terminal-resolve-diverged', name: 'Newest Local Conflict', version: 7, pendingSync: true, syncSource: 'synced' })])).toEqual([
      expect.objectContaining({
        id: 'proj-terminal-resolve-diverged',
        name: 'Newest Local Conflict',
        version: 7,
        pendingSync: true,
        syncSource: 'synced',
      }),
    ]);
  });

  it('后置待删任务回放遇到会话切换时应把剩余删除意图写回原 owner 队列', async () => {
    mockUserSession.isSessionContextCurrent
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);

    const replayPendingTaskDeletes = service as unknown as {
      replayPendingTaskDeletes: (
        project: Project,
        pendingTaskDeleteIds: string[],
        sessionContext: { ownerUserId: string | null; sessionGeneration: number },
      ) => Promise<void>;
    };

    await replayPendingTaskDeletes.replayPendingTaskDeletes(
      createProject({ id: 'proj-replay-handoff', version: 9 }),
      ['task-delete-1', 'task-delete-2'],
      { ownerUserId: 'user-1', sessionGeneration: 1 },
    );

    expect(mockSyncCoordinator.core.deleteTask).toHaveBeenCalledTimes(1);
    expect(mockSyncCoordinator.core.deleteTask).toHaveBeenCalledWith('task-delete-1', 'proj-replay-handoff', 'user-1');
    expect(mockActionQueue.enqueueForOwner).toHaveBeenCalledWith('user-1', expect.objectContaining({
      type: 'update',
      entityType: 'project',
      entityId: 'proj-replay-handoff',
      payload: expect.objectContaining({
        taskIdsToDelete: ['task-delete-2'],
      }),
    }));
  });

  it('resolveConflict 应优先使用 active conflict 中的 pendingTaskDeleteIds', async () => {
    mockSyncCoordinator.conflictData.mockReturnValueOnce({
      projectId: 'proj-active-pending-delete',
      local: createProject({ id: 'proj-active-pending-delete', name: 'Local Conflict' }),
      remote: createProject({ id: 'proj-active-pending-delete', name: 'Remote Conflict', version: 3 }),
      pendingTaskDeleteIds: ['task-delete-fast-click'],
    });
    mockConflictStorage.getConflict.mockResolvedValueOnce({
      projectId: 'proj-active-pending-delete',
      localProject: createProject({ id: 'proj-active-pending-delete', name: 'Local Conflict' }),
      remoteProject: createProject({ id: 'proj-active-pending-delete', name: 'Remote Conflict', version: 3 }),
    });
    mockProjectState.getProject.mockReturnValue(createProject({ id: 'proj-active-pending-delete', name: 'Local Conflict' }));
    mockSyncCoordinator.resolveConflict.mockResolvedValueOnce({
      ok: true,
      value: createProject({ id: 'proj-active-pending-delete', name: 'Resolved Conflict', version: 4 }),
    });
    mockUserSession.currentUserId.mockReturnValue('user-1');
    mockSyncCoordinator.core.saveProjectSmart.mockResolvedValueOnce({
      success: true,
      newVersion: 10,
    });

    const resolved = await service.resolveConflict('proj-active-pending-delete', 'local');

    expect(resolved).toBe(true);
    expect(mockSyncCoordinator.core.deleteTask).toHaveBeenCalledWith('task-delete-fast-click', 'proj-active-pending-delete', 'user-1');
  });

  it('resolveConflict 在 saveProjectSmart 成功后若会话已过期，应先回写 pendingTaskDeleteIds 到原 owner 队列', async () => {
    mockSyncCoordinator.conflictData.mockReturnValueOnce({
      projectId: 'proj-stale-after-save',
      conflictedAt: '2026-03-30T00:00:00.000Z',
      local: createProject({ id: 'proj-stale-after-save', name: 'Local Conflict' }),
      remote: createProject({ id: 'proj-stale-after-save', name: 'Remote Conflict', version: 3 }),
      pendingTaskDeleteIds: ['task-delete-stale'],
    });
    mockConflictStorage.getConflict.mockResolvedValue({
      projectId: 'proj-stale-after-save',
      localProject: createProject({ id: 'proj-stale-after-save', name: 'Local Conflict' }),
      remoteProject: createProject({ id: 'proj-stale-after-save', name: 'Remote Conflict', version: 3 }),
      conflictedAt: '2026-03-30T00:00:00.000Z',
      localVersion: 1,
      remoteVersion: 3,
      pendingTaskDeleteIds: ['task-delete-stale'],
    });
    mockProjectState.getProject.mockReturnValue(createProject({ id: 'proj-stale-after-save', name: 'Local Conflict' }));
    mockSyncCoordinator.resolveConflict.mockResolvedValueOnce({
      ok: true,
      value: createProject({ id: 'proj-stale-after-save', name: 'Resolved Conflict', version: 4 }),
    });
    mockUserSession.currentUserId.mockReturnValue('user-1');
    mockSyncCoordinator.core.saveProjectSmart.mockResolvedValueOnce({
      success: true,
      newVersion: 10,
    });

    const isProjectSessionContextCurrent = service as unknown as {
      isProjectSessionContextCurrent: (
        context: { ownerUserId: string | null; sessionGeneration: number },
        stage: string,
        projectId: string,
      ) => boolean;
    };
    vi.spyOn(isProjectSessionContextCurrent, 'isProjectSessionContextCurrent').mockImplementation(
      (_context, stage) => stage !== 'resolveConflict:saveProjectSmart',
    );

    const resolved = await service.resolveConflict('proj-stale-after-save', 'local');

    expect(resolved).toBe(true);
    const updater = mockProjectState.updateProjects.mock.calls.at(-1)?.[0] as ((projects: Project[]) => Project[]);
    expect(mockActionQueue.enqueueForOwner).toHaveBeenCalledWith('user-1', expect.objectContaining({
      type: 'update',
      entityType: 'project',
      entityId: 'proj-stale-after-save',
      payload: expect.objectContaining({
        taskIdsToDelete: ['task-delete-stale'],
      }),
    }));
    expect(mockConflictStorage.deleteConflict).toHaveBeenCalledWith('proj-stale-after-save', 'user-1');
    expect(mockChangeTracker.clearProjectFieldLocks).toHaveBeenCalledWith('proj-stale-after-save');
    expect(mockChangeTracker.clearProjectChanges).not.toHaveBeenCalledWith('proj-stale-after-save');
    expect(mockSyncCoordinator.core.deleteTask).not.toHaveBeenCalled();
    expect(updater([createProject({ id: 'proj-stale-after-save', name: 'Newest Local Conflict', pendingSync: false, syncSource: 'synced' })])).toEqual([
      expect.objectContaining({
        id: 'proj-stale-after-save',
        name: 'Newest Local Conflict',
        version: 10,
        pendingSync: true,
        syncSource: 'synced',
      }),
    ]);
  });

  it('resolveConflict 在 saveProjectSmart terminal 且同 owner stale 时仍应清理冲突记录和锁', async () => {
    mockSyncCoordinator.conflictData.mockReturnValueOnce({
      projectId: 'proj-stale-terminal-resolve',
      conflictedAt: '2026-03-30T00:00:00.000Z',
      local: createProject({ id: 'proj-stale-terminal-resolve', name: 'Local Conflict', pendingSync: true }),
      remote: createProject({ id: 'proj-stale-terminal-resolve', name: 'Remote Conflict', version: 3 }),
    });
    mockConflictStorage.getConflict.mockResolvedValue({
      projectId: 'proj-stale-terminal-resolve',
      localProject: createProject({ id: 'proj-stale-terminal-resolve', name: 'Local Conflict', pendingSync: true }),
      remoteProject: createProject({ id: 'proj-stale-terminal-resolve', name: 'Remote Conflict', version: 3 }),
      conflictedAt: '2026-03-30T00:00:00.000Z',
      localVersion: 1,
      remoteVersion: 3,
    });
    mockProjectState.getProject
      .mockReturnValueOnce(createProject({ id: 'proj-stale-terminal-resolve', name: 'Local Conflict', pendingSync: true }))
      .mockReturnValue(createProject({ id: 'proj-stale-terminal-resolve', name: 'Resolved Conflict', version: 4, pendingSync: true, syncSource: 'synced' }));
    mockSyncCoordinator.resolveConflict.mockResolvedValueOnce({
      ok: true,
      value: createProject({ id: 'proj-stale-terminal-resolve', name: 'Resolved Conflict', version: 4, pendingSync: true }),
    });
    mockUserSession.currentUserId.mockReturnValue('user-1');
    mockSyncCoordinator.core.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      terminal: true,
      failureReason: '当前客户端同步协议已过期，请刷新后重试',
    });

    const isProjectSessionContextCurrent = service as unknown as {
      isProjectSessionContextCurrent: (
        context: { ownerUserId: string | null; sessionGeneration: number },
        stage: string,
        projectId: string,
      ) => boolean;
    };
    vi.spyOn(isProjectSessionContextCurrent, 'isProjectSessionContextCurrent').mockImplementation(
      (_context, stage) => stage !== 'resolveConflict:saveProjectSmart',
    );

    const resolved = await service.resolveConflict('proj-stale-terminal-resolve', 'local');

    expect(resolved).toBe(true);
    const updater = mockProjectState.updateProjects.mock.calls.at(-1)?.[0] as ((projects: Project[]) => Project[]);
    expect(mockConflictStorage.deleteConflict).toHaveBeenCalledWith('proj-stale-terminal-resolve', 'user-1');
    expect(mockChangeTracker.clearProjectFieldLocks).toHaveBeenCalledWith('proj-stale-terminal-resolve');
    expect(mockChangeTracker.clearProjectChanges).toHaveBeenCalledWith('proj-stale-terminal-resolve');
    expect(mockActionQueue.enqueue).not.toHaveBeenCalled();
    expect(updater([createProject({ id: 'proj-stale-terminal-resolve', name: 'Newest Local Conflict', pendingSync: true, syncSource: 'synced' })])).toEqual([
      expect.objectContaining({
        id: 'proj-stale-terminal-resolve',
        name: 'Newest Local Conflict',
        pendingSync: false,
        syncSource: 'synced',
      }),
    ]);
  });

  it('resolveConflict 在 delete-conflict gate 才变 stale 且同 owner 时仍应清理冲突记录', async () => {
    mockSyncCoordinator.conflictData.mockReturnValueOnce({
      projectId: 'proj-late-stale-cleanup',
      conflictedAt: '2026-03-30T00:00:00.000Z',
      local: createProject({ id: 'proj-late-stale-cleanup', name: 'Local Conflict', pendingSync: true }),
      remote: createProject({ id: 'proj-late-stale-cleanup', name: 'Remote Conflict', version: 3 }),
    });
    mockConflictStorage.getConflict.mockResolvedValue({
      projectId: 'proj-late-stale-cleanup',
      localProject: createProject({ id: 'proj-late-stale-cleanup', name: 'Local Conflict', pendingSync: true }),
      remoteProject: createProject({ id: 'proj-late-stale-cleanup', name: 'Remote Conflict', version: 3 }),
      conflictedAt: '2026-03-30T00:00:00.000Z',
      localVersion: 1,
      remoteVersion: 3,
    });
    mockProjectState.getProject.mockReturnValue(createProject({ id: 'proj-late-stale-cleanup', name: 'Local Conflict', pendingSync: true }));
    mockSyncCoordinator.resolveConflict.mockResolvedValueOnce({
      ok: true,
      value: createProject({ id: 'proj-late-stale-cleanup', name: 'Resolved Conflict', version: 4, pendingSync: true }),
    });
    mockUserSession.currentUserId.mockReturnValue('user-1');
    mockSyncCoordinator.core.saveProjectSmart.mockResolvedValueOnce({
      success: true,
      newVersion: 11,
    });

    const isProjectSessionContextCurrent = service as unknown as {
      isProjectSessionContextCurrent: (
        context: { ownerUserId: string | null; sessionGeneration: number },
        stage: string,
        projectId: string,
      ) => boolean;
    };
    vi.spyOn(isProjectSessionContextCurrent, 'isProjectSessionContextCurrent').mockImplementation(
      (_context, stage) => stage !== 'resolveConflict:delete-conflict',
    );

    const resolved = await service.resolveConflict('proj-late-stale-cleanup', 'local');

    expect(resolved).toBe(true);
    expect(mockConflictStorage.deleteConflict).toHaveBeenCalledWith('proj-late-stale-cleanup', 'user-1');
    expect(mockChangeTracker.clearProjectFieldLocks).toHaveBeenCalledWith('proj-late-stale-cleanup');
    expect(mockChangeTracker.clearProjectChanges).toHaveBeenCalledWith('proj-late-stale-cleanup');
  });

  it('解决冲突后二次冲突且缺少 remoteData 时应降级为 stale 冲突记录', async () => {
    const existingRemote = createProject({ id: 'proj-conflict', name: 'Remote Existing', version: 4 });
    mockSyncCoordinator.conflictData.mockReturnValueOnce({
      projectId: 'proj-conflict',
      local: createProject({ id: 'proj-conflict', name: 'Local Existing' }),
      remote: existingRemote,
    });
    mockConflictStorage.getConflict.mockResolvedValueOnce({
      projectId: 'proj-conflict',
      localProject: createProject({ id: 'proj-conflict', name: 'Local Existing' }),
      remoteProject: existingRemote,
      pendingTaskDeleteIds: ['task-delete-1'],
    });
    mockProjectState.getProject.mockReturnValue(createProject({ id: 'proj-conflict', name: 'Local Existing' }));
    mockProjectState.activeProjectId.mockReturnValue('proj-conflict');
    mockSyncCoordinator.resolveConflict.mockResolvedValueOnce({
      ok: true,
      value: createProject({ id: 'proj-conflict', name: 'Resolved Local', version: 5 }),
    });
    mockUserSession.currentUserId.mockReturnValue('user-1');
    mockSyncCoordinator.core.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      conflict: true,
    });

    await service.resolveConflict('proj-conflict', 'local');

    expect(mockConflictStorage.saveConflict).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'proj-conflict',
      localProject: expect.objectContaining({ id: 'proj-conflict', name: 'Resolved Local', version: 5 }),
      remoteProject: expect.objectContaining({ id: 'proj-conflict', name: 'Remote Existing', version: 4 }),
      remoteSnapshotFresh: false,
      pendingTaskDeleteIds: ['task-delete-1'],
    }));
    expect(mockSyncCoordinator.captureConflict).not.toHaveBeenCalled();
    expect(mockSyncCoordinator.clearActiveConflict).toHaveBeenCalled();
  });

  it('解决冲突后的二次冲突若已属于旧会话，不应写入当前冲突链', async () => {
    mockSyncCoordinator.conflictData.mockReturnValueOnce({
      projectId: 'proj-conflict-stale',
      local: createProject({ id: 'proj-conflict-stale', name: 'Local Existing' }),
      remote: createProject({ id: 'proj-conflict-stale', name: 'Remote Existing', version: 4 }),
    });
    mockConflictStorage.getConflict.mockResolvedValueOnce({
      projectId: 'proj-conflict-stale',
      localProject: createProject({ id: 'proj-conflict-stale', name: 'Local Existing' }),
      remoteProject: createProject({ id: 'proj-conflict-stale', name: 'Remote Existing', version: 4 }),
    });
    mockProjectState.getProject.mockReturnValue(createProject({ id: 'proj-conflict-stale', name: 'Local Existing' }));
    mockSyncCoordinator.resolveConflict.mockResolvedValueOnce({
      ok: true,
      value: createProject({ id: 'proj-conflict-stale', name: 'Resolved Local', version: 5 }),
    });
    mockUserSession.currentUserId.mockReturnValue('user-1');
    mockSyncCoordinator.core.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      conflict: true,
      remoteData: createProject({ id: 'proj-conflict-stale', name: 'Remote Existing', version: 6 }),
    });
    mockUserSession.isSessionContextCurrent.mockReturnValueOnce(false);

    const result = await service.resolveConflict('proj-conflict-stale', 'local');

    expect(result).toBe(false);
    expect(mockSyncCoordinator.captureConflict).not.toHaveBeenCalled();
    expect(mockConflictStorage.saveConflict).not.toHaveBeenCalled();
    expect(mockToast.error).not.toHaveBeenCalledWith('同步冲突', expect.any(String));
  });

  it('冲突 fallback 落盘后若会话已切换，不应清空当前 active conflict', async () => {
    const fallbackRemote = createProject({ id: 'proj-conflict-fallback-stale', name: 'Remote Existing', version: 4 });
    mockSyncCoordinator.conflictData.mockReturnValueOnce({
      projectId: 'proj-conflict-fallback-stale',
      local: createProject({ id: 'proj-conflict-fallback-stale', name: 'Local Existing' }),
      remote: fallbackRemote,
    });
    mockConflictStorage.getConflict.mockResolvedValueOnce({
      projectId: 'proj-conflict-fallback-stale',
      localProject: createProject({ id: 'proj-conflict-fallback-stale', name: 'Local Existing' }),
      remoteProject: fallbackRemote,
    });
    mockProjectState.getProject.mockReturnValue(createProject({ id: 'proj-conflict-fallback-stale', name: 'Local Existing' }));
    mockSyncCoordinator.resolveConflict.mockResolvedValueOnce({
      ok: true,
      value: createProject({ id: 'proj-conflict-fallback-stale', name: 'Resolved Local', version: 5 }),
    });
    mockUserSession.currentUserId.mockReturnValue('user-1');
    mockSyncCoordinator.core.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      conflict: true,
    });
    mockSyncCoordinator.loadSingleProjectFromCloud.mockResolvedValueOnce(null);

    const sessionStates = [true, true, true, true, true, true, false];
    mockUserSession.isSessionContextCurrent.mockImplementation(() => sessionStates.shift() ?? false);

    const result = await service.resolveConflict('proj-conflict-fallback-stale', 'local');

    expect(result).toBe(true);
    expect(mockConflictStorage.saveConflict).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'proj-conflict-fallback-stale',
      remoteSnapshotFresh: false,
    }));
    expect(mockSyncCoordinator.clearActiveConflict).not.toHaveBeenCalled();
    expect(mockToast.error).not.toHaveBeenCalledWith('同步冲突', expect.any(String));
  });

  it('stale remote 快照不应直接用于下一次 remote 解决', async () => {
    mockSyncCoordinator.conflictData.mockReturnValueOnce({
      projectId: 'proj-stale',
      local: createProject({ id: 'proj-stale', name: 'Local Stale' }),
      remote: undefined,
    });
    mockConflictStorage.getConflict.mockResolvedValueOnce({
      projectId: 'proj-stale',
      localProject: createProject({ id: 'proj-stale', name: 'Local Stale' }),
      remoteProject: createProject({ id: 'proj-stale', name: 'Old Remote', version: 4 }),
      remoteSnapshotFresh: false,
    });
    mockProjectState.getProject.mockReturnValue(createProject({ id: 'proj-stale', name: 'Local Stale' }));
    mockSyncCoordinator.loadSingleProjectFromCloud.mockResolvedValueOnce(null);

    await service.resolveConflict('proj-stale', 'remote');

    expect(mockSyncCoordinator.resolveConflict).not.toHaveBeenCalled();
    expect(mockToast.error).toHaveBeenCalledWith('冲突解决失败', '远端版本暂不可用，请稍后重试，或先保留本地版本');
  });

  it('缺少 freshness 标记的存量 remote 快照也应重新拉取', async () => {
    mockSyncCoordinator.conflictData.mockReturnValueOnce({
      projectId: 'proj-unknown-freshness',
      local: createProject({ id: 'proj-unknown-freshness', name: 'Local Unknown' }),
      remote: undefined,
    });
    mockConflictStorage.getConflict.mockResolvedValueOnce({
      projectId: 'proj-unknown-freshness',
      localProject: createProject({ id: 'proj-unknown-freshness', name: 'Local Unknown' }),
      remoteProject: createProject({ id: 'proj-unknown-freshness', name: 'Old Remote', version: 4 }),
    });
    mockProjectState.getProject.mockReturnValue(createProject({ id: 'proj-unknown-freshness', name: 'Local Unknown' }));
    mockSyncCoordinator.loadSingleProjectFromCloud.mockResolvedValueOnce(null);

    await service.resolveConflict('proj-unknown-freshness', 'remote');

    expect(mockSyncCoordinator.loadSingleProjectFromCloud).toHaveBeenCalledWith('proj-unknown-freshness');
    expect(mockSyncCoordinator.resolveConflict).not.toHaveBeenCalled();
  });

  it('active conflict 自带 remote 快照时应优先使用，不受存量 freshness 标记影响', async () => {
    mockSyncCoordinator.conflictData.mockReturnValueOnce({
      projectId: 'proj-active-remote',
      local: createProject({ id: 'proj-active-remote', name: 'Local Active' }),
      remote: createProject({ id: 'proj-active-remote', name: 'Fresh Active Remote', version: 6 }),
    });
    mockConflictStorage.getConflict.mockResolvedValueOnce({
      projectId: 'proj-active-remote',
      localProject: createProject({ id: 'proj-active-remote', name: 'Local Active' }),
      remoteProject: createProject({ id: 'proj-active-remote', name: 'Stale Stored Remote', version: 3 }),
    });
    mockProjectState.getProject.mockReturnValue(createProject({ id: 'proj-active-remote', name: 'Local Active' }));
    mockSyncCoordinator.resolveConflict.mockResolvedValueOnce({
      ok: true,
      value: createProject({ id: 'proj-active-remote', name: 'Fresh Active Remote', version: 6 }),
    });

    await service.resolveConflict('proj-active-remote', 'remote');

    expect(mockSyncCoordinator.loadSingleProjectFromCloud).not.toHaveBeenCalled();
    expect(mockSyncCoordinator.resolveConflict).toHaveBeenCalledWith(
      'proj-active-remote',
      'remote',
      expect.objectContaining({ id: 'proj-active-remote', name: 'Local Active' }),
      expect.objectContaining({ id: 'proj-active-remote', name: 'Fresh Active Remote', version: 6 })
    );
  });

  it('fresh remoteData 仍应直接进入统一冲突链', async () => {
    mockUserSession.currentUserId.mockReturnValue('user-1');
    mockProjectState.getProject.mockReturnValue(createProject({ id: 'proj-1', name: 'Existing' }));
    mockSyncCoordinator.core.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      conflict: true,
      remoteData: createProject({ id: 'proj-1', name: 'Remote Existing', version: 2 }),
    });

    const result = await service.upsertImportedProject(createProject({ id: 'proj-1', name: 'Imported' }));

    expect(result.success).toBe(false);
    expect(mockSyncCoordinator.captureConflict).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'proj-1', name: 'Imported' }),
      expect.objectContaining({ id: 'proj-1', name: 'Remote Existing', version: 2 }),
      'user-1',
      undefined,
    );
  });
});
