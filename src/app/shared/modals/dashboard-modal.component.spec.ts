import { Injector, computed, runInInjectionContext, signal } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardModalComponent } from './dashboard-modal.component';
import { ActionQueueService } from '../../../services/action-queue.service';
import { SimpleSyncService } from '../../core/services/simple-sync.service';
import { RetryQueueService } from '../../core/services/sync/retry-queue.service';
import { AuthService } from '../../../services/auth.service';
import { ConflictStorageService } from '../../../services/conflict-storage.service';
import { ProjectOperationService } from '../../../services/project-operation.service';
import { ToastService } from '../../../services/toast.service';
import { SyncCoordinatorService } from '../../../services/sync-coordinator.service';
import { ConflictAutoResolverService } from '../../../services/conflict-auto-resolver.service';
import { LoggerService } from '../../../services/logger.service';
import { ProjectStore } from '../../core/state/stores';

function createConflictRecord(remoteSnapshotFresh = false) {
  const now = '2026-03-30T00:00:00.000Z';
  return {
    projectId: 'proj-1',
    localProject: {
      id: 'proj-1',
      name: 'Local Project',
      description: '',
      createdDate: now,
      updatedAt: now,
      version: 2,
      tasks: [],
      connections: [],
    },
    remoteProject: {
      id: 'proj-1',
      name: 'Remote Project',
      description: '',
      createdDate: now,
      updatedAt: now,
      version: 3,
      tasks: [],
      connections: [],
    },
    remoteSnapshotFresh,
    conflictedAt: now,
    localVersion: 2,
    remoteVersion: 3,
    reason: 'version_mismatch',
    acknowledged: false,
  };
}

describe('DashboardModalComponent conflict resolution', () => {
  let component: DashboardModalComponent;

  const actionQueueMock = {
    queueSize: signal(0),
    deadLetterSize: signal(0),
    deadLetterQueue: signal([]),
    isProcessing: signal(false),
    processQueue: vi.fn().mockResolvedValue(undefined),
    retryDeadLetter: vi.fn(),
    dismissDeadLetter: vi.fn(),
    clearDeadLetterQueue: vi.fn(),
  };

  const syncState = signal({
    isOnline: true,
    isSyncing: false,
    syncError: null,
    offlineMode: false,
  });

  const syncServiceMock = {
    syncState,
  };

  const retryQueueMock = {
    processQueue: vi.fn().mockResolvedValue(undefined),
  };

  const authUserId = signal<string | null>('user-1');
  const authServiceMock = {
    currentUserId: authUserId,
  };

  const conflictStorageCount = signal(1);
  const conflictStorageMock = {
    getConflict: vi.fn(),
    getAllConflicts: vi.fn().mockResolvedValue([]),
    conflictCount: conflictStorageCount.asReadonly(),
    hasUnresolvedConflicts: computed(() => conflictStorageCount() > 0),
  };

  const projectOpsMock = {
    resolveConflict: vi.fn().mockResolvedValue(true),
    resolveConflictWithPlan: vi.fn().mockResolvedValue(true),
  };

  const syncCoordinatorMock = {
    resyncActiveProject: vi.fn(),
    captureConflict: vi.fn(),
  };

  const toastMock = {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  };

  const loggerMock = {
    category: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    conflictStorageCount.set(1);
    conflictStorageMock.getAllConflicts.mockResolvedValue([]);
    projectOpsMock.resolveConflict.mockResolvedValue(true);
    projectOpsMock.resolveConflictWithPlan.mockResolvedValue(true);

    const injector = Injector.create({
      providers: [
        { provide: ActionQueueService, useValue: actionQueueMock },
        { provide: SimpleSyncService, useValue: syncServiceMock },
        { provide: RetryQueueService, useValue: retryQueueMock },
        { provide: AuthService, useValue: authServiceMock },
        { provide: ConflictStorageService, useValue: conflictStorageMock },
        { provide: ProjectOperationService, useValue: projectOpsMock },
        { provide: ToastService, useValue: toastMock },
        { provide: SyncCoordinatorService, useValue: syncCoordinatorMock },
        { provide: LoggerService, useValue: loggerMock },
        { provide: ConflictAutoResolverService, useClass: ConflictAutoResolverService, deps: [LoggerService] },
        { provide: ProjectStore, useValue: { getProject: vi.fn(() => undefined) } },
      ],
    });

    component = runInInjectionContext(injector, () => new DashboardModalComponent());
  });

  it('resolveUseRemote 不应把存储中的 stale remote 重新注入 active conflict', async () => {
    conflictStorageMock.getConflict.mockResolvedValueOnce(createConflictRecord(false));
    const loadConflictsSpy = vi.spyOn(component, 'loadConflicts').mockResolvedValue(undefined);

    await component.resolveUseRemote('proj-1');

    expect(projectOpsMock.resolveConflict).toHaveBeenCalledWith('proj-1', 'remote', { backgroundPersist: true });
    expect(syncCoordinatorMock.captureConflict).not.toHaveBeenCalled();
    expect(loadConflictsSpy).toHaveBeenCalled();
    expect(toastMock.success).toHaveBeenCalledWith('已采用云端版本', '当前项目已切换到云端结果');
  });

  it('resolveUseLocal 失败时不应误报成功', async () => {
    conflictStorageMock.getConflict.mockResolvedValueOnce(createConflictRecord(true));
    projectOpsMock.resolveConflict.mockResolvedValueOnce(false);
    const loadConflictsSpy = vi.spyOn(component, 'loadConflicts').mockResolvedValue(undefined);

    await component.resolveUseLocal('proj-1');

    expect(projectOpsMock.resolveConflict).toHaveBeenCalledWith('proj-1', 'local', { backgroundPersist: true });
    expect(loadConflictsSpy).toHaveBeenCalled();
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it('resolveKeepBoth 失败时不应提示成功', async () => {
    conflictStorageMock.getConflict.mockResolvedValueOnce(createConflictRecord(true));
    projectOpsMock.resolveConflict.mockResolvedValueOnce(false);
    const loadConflictsSpy = vi.spyOn(component, 'loadConflicts').mockResolvedValue(undefined);

    await component.resolveKeepBoth('proj-1');

    expect(projectOpsMock.resolveConflict).toHaveBeenCalledWith('proj-1', 'merge', { backgroundPersist: true });
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(loadConflictsSpy).toHaveBeenCalled();
  });

  it('applyAutoResolution 应按逐任务计划调用 resolveConflictWithPlan，并优先采用用户选择', async () => {
    const loadConflictsSpy = vi.spyOn(component, 'loadConflicts').mockResolvedValue(undefined);
    const conflict = {
      projectId: 'proj-1',
      projectName: 'Local Project',
      reason: 'version_mismatch',
      reasonLabel: '版本不匹配',
      conflictedAt: '2026-03-30T00:00:00.000Z',
      localTaskCount: 2,
      remoteTaskCount: 2,
      localTasks: [],
      remoteTasks: [],
      remoteSnapshotFresh: true,
      isResolving: false,
      autoReport: {
        projectId: 'proj-1',
        recommendations: [
          {
            taskId: 'task-1',
            title: 'Task 1',
            recommendation: 'remote',
            confidence: 'suggest',
            reason: '云端版本较新',
            reasoning: ['云端更新时间更晚'],
            conflictedFields: ['content'],
          },
          {
            taskId: 'task-2',
            title: 'Task 2',
            recommendation: 'remote',
            confidence: 'auto',
            reason: '任务仅存在于云端',
            reasoning: ['其他设备新建'],
            conflictedFields: [],
          },
        ],
        autoCount: 1,
        suggestCount: 1,
        manualCount: 0,
        generatedAt: '2026-03-30T00:00:00.000Z',
        overallSuggestion: '可直接应用系统建议',
      },
      taskResolutions: new Map([['task-1', 'local']]),
      selectiveMode: true,
    } as unknown as Parameters<DashboardModalComponent['applyAutoResolution']>[0];

    await component.applyAutoResolution(conflict);

    expect(projectOpsMock.resolveConflictWithPlan).toHaveBeenCalledWith(
      'proj-1',
      expect.objectContaining({
        taskChoices: expect.objectContaining({
          'task-1': 'local',
          'task-2': 'remote',
        }),
        appliedBy: 'mixed',
      }),
      { backgroundPersist: true },
    );
    expect(projectOpsMock.resolveConflict).not.toHaveBeenCalled();
    expect(loadConflictsSpy).toHaveBeenCalled();
    expect(toastMock.success).toHaveBeenCalledWith(
      '智能解决完成',
      expect.stringContaining('其中 1 项来自您的明确选择'),
    );
  });

  it('远端快照过期时不应允许直接应用系统建议', async () => {
    const loadConflictsSpy = vi.spyOn(component, 'loadConflicts').mockResolvedValue(undefined);
    const staleConflict = {
      projectId: 'proj-1',
      projectName: 'Local Project',
      reason: 'version_mismatch',
      reasonLabel: '版本不匹配',
      conflictedAt: '2026-03-30T00:00:00.000Z',
      localTaskCount: 1,
      remoteTaskCount: 1,
      localTasks: [],
      remoteTasks: [],
      remoteSnapshotFresh: false,
      isResolving: false,
      autoReport: {
        projectId: 'proj-1',
        recommendations: [
          {
            taskId: 'task-1',
            title: 'Task 1',
            recommendation: 'remote',
            confidence: 'suggest',
            reason: '云端版本较新',
            reasoning: ['云端更新时间更晚'],
            conflictedFields: ['content'],
          },
        ],
        autoCount: 0,
        suggestCount: 1,
        manualCount: 0,
        generatedAt: '2026-03-30T00:00:00.000Z',
        overallSuggestion: '建议先确认后再处理',
      },
      taskResolutions: new Map(),
      selectiveMode: false,
    } as unknown as Parameters<DashboardModalComponent['applyAutoResolution']>[0];

    expect(component.canApplySuggestedResolution(staleConflict)).toBe(false);
    expect(component.getSuggestedResolutionSummary(staleConflict)).toContain('不是本轮冲突中的最新结果');

    await component.applyAutoResolution(staleConflict);

    expect(projectOpsMock.resolveConflictWithPlan).not.toHaveBeenCalled();
    expect(loadConflictsSpy).not.toHaveBeenCalled();
    expect(toastMock.warning).toHaveBeenCalledWith(
      '建议暂不可直接应用',
      '当前云端快照不是本轮最新结果，请先重新同步或逐项确认后再处理',
    );
  });

  it('retryAll 应先重放 RetryQueue，再处理 ActionQueue', async () => {
    await component.retryAll();

    expect(actionQueueMock.processQueue).toHaveBeenCalledOnce();
    expect(retryQueueMock.processQueue).toHaveBeenCalledWith(undefined, true);
    expect(retryQueueMock.processQueue.mock.invocationCallOrder[0]).toBeLessThan(
      actionQueueMock.processQueue.mock.invocationCallOrder[0],
    );
    expect(toastMock.success).toHaveBeenCalledOnce();
  });
});
