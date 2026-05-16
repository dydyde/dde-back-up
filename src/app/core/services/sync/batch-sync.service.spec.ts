import { Injector, runInInjectionContext } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BatchSyncService, type BatchSyncCallbacks } from './batch-sync.service';
import { SupabaseClientService } from '../../../../services/supabase-client.service';
import { LoggerService } from '../../../../services/logger.service';
import { ToastService } from '../../../../services/toast.service';
import { CircuitBreakerService } from '../../../../services/circuit-breaker.service';
import { ChangeTrackerService } from '../../../../services/change-tracker.service';
import { MobileSyncStrategyService } from '../../../../services/mobile-sync-strategy.service';
import { SyncStateService } from './sync-state.service';
import { RetryQueueService } from './retry-queue.service';
import { SessionManagerService } from './session-manager.service';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import { RECOVERABLE_SYNC_ERROR_MESSAGES } from '../../../../config/sync.config';
import type { Connection, Project, Task } from '../../../../models';
import { PermanentFailureError } from '../../../../utils/permanent-failure-error';
import {
  createBrowserNetworkSuspendedError,
  resetBrowserNetworkSuspensionTrackingForTests,
} from '../../../../utils/browser-network-suspension';

function setVisibilityState(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: state,
  });
}

function createProject(overrides: Partial<Project> = {}): Project {
  const now = '2026-03-31T00:00:00.000Z';
  return {
    id: overrides.id ?? 'project-1',
    name: overrides.name ?? 'Project 1',
    description: overrides.description ?? '',
    createdDate: overrides.createdDate ?? now,
    updatedAt: overrides.updatedAt ?? now,
    version: overrides.version ?? 1,
    tasks: overrides.tasks ?? [],
    connections: overrides.connections ?? [],
    ...overrides,
  };
}

describe('BatchSyncService owner isolation', () => {
  let service: BatchSyncService;
  let callbacks: BatchSyncCallbacks;
  let taskLookupRows: Array<{ id: string }>;

  const mockClient = {
    auth: {
      getSession: vi.fn(),
    },
    from: vi.fn((table: string) => {
      if (table === 'tasks') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              in: vi.fn(() => ({
                is: vi.fn(async () => ({ data: taskLookupRows as { id: string }[] | null, error: null as Error | null })),
              })),
            })),
          })),
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    }),
  };

  const mockSupabase = {
    isConfigured: true,
    client: vi.fn(() => mockClient),
  };

  const loggerCategory = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  const mockLogger = {
    category: vi.fn(() => loggerCategory),
  };

  const mockToast = {
    warning: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  };

  const mockCircuitBreaker = {
    validateBeforeSync: vi.fn(() => ({ passed: true, shouldBlock: false })),
    updateLastKnownTaskCount: vi.fn(),
  };

  const mockChangeTracker = {
    getProjectChanges: vi.fn(() => ({
      taskIdsToDelete: [] as string[],
      taskUpdateFieldsById: {},
    })),
    clearTaskChange: vi.fn(),
    clearTaskChangeIfFresh: vi.fn(() => true),
    clearConnectionChangeIfFresh: vi.fn(() => true),
  };

  const mockMobileSync = {
    shouldAllowSync: vi.fn(() => true),
  };

  const mockSyncState = {
    setSyncError: vi.fn(),
    scheduleRecoverableSyncError: vi.fn(),
    clearPendingRecoverableSyncError: vi.fn(),
    setSyncing: vi.fn(),
    advanceLastSyncTimeIfIdle: vi.fn(),
    setSessionExpired: vi.fn(),
  };

  const mockSessionManager = {
    tryRefreshSession: vi.fn(async () => false),
    handleAuthErrorWithRefresh: vi.fn(async () => false),
    isSessionExpiredError: vi.fn((_error: unknown) => false),
  };

  const mockSentry = {
    captureMessage: vi.fn(),
    captureException: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    resetBrowserNetworkSuspensionTrackingForTests();
    setVisibilityState('visible');
    taskLookupRows = [];
    mockClient.auth.getSession.mockReset();
    mockSessionManager.tryRefreshSession.mockReset();
    mockSessionManager.tryRefreshSession.mockImplementation(async () => false);
    mockSessionManager.handleAuthErrorWithRefresh.mockReset();
    mockSessionManager.handleAuthErrorWithRefresh.mockImplementation(async () => false);
    mockSessionManager.isSessionExpiredError.mockReset();
    mockSessionManager.isSessionExpiredError.mockImplementation(() => false);

    const injector = Injector.create({
      providers: [
        { provide: BatchSyncService, useClass: BatchSyncService },
        { provide: SupabaseClientService, useValue: mockSupabase },
        { provide: LoggerService, useValue: mockLogger },
        { provide: ToastService, useValue: mockToast },
        { provide: CircuitBreakerService, useValue: mockCircuitBreaker },
        { provide: ChangeTrackerService, useValue: mockChangeTracker },
        { provide: MobileSyncStrategyService, useValue: mockMobileSync },
        { provide: SyncStateService, useValue: mockSyncState },
        { provide: RetryQueueService, useValue: { removeByEntity: vi.fn() } },
        { provide: SessionManagerService, useValue: mockSessionManager },
        { provide: SentryLazyLoaderService, useValue: mockSentry },
      ],
    });

    service = runInInjectionContext(injector, () => injector.get(BatchSyncService));

    callbacks = {
      pushProject: vi.fn().mockResolvedValue({ success: true }),
      pushTask: vi.fn().mockResolvedValue({ success: true, retryEnqueued: false }),
      pushTaskPosition: vi.fn().mockResolvedValue(true),
      pushConnection: vi.fn().mockResolvedValue({ success: true, retryEnqueued: false }),
      getTombstoneIds: vi.fn().mockResolvedValue(new Set<string>()),
      getConnectionTombstoneIds: vi.fn().mockResolvedValue(new Set<string>()),
      purgeTasksFromCloud: vi.fn().mockResolvedValue({ success: true, retriedTaskIds: [] }),
      topologicalSortTasks: vi.fn((tasks) => tasks),
      addToRetryQueue: vi.fn().mockReturnValue(true),
      addToRetryQueueDurably: vi.fn().mockResolvedValue(true),
      confirmRetryQueuePersistence: vi.fn().mockResolvedValue(true),
    };

    service.setCallbacks(callbacks);
  });

  it('session owner 不匹配时不应调用 pushProject，而应回退到原 owner 重试队列', async () => {
    const project = createProject({ id: 'project-owner-mismatch' });
    mockChangeTracker.getProjectChanges.mockReturnValueOnce({
      taskIdsToDelete: ['task-delete-a'],
      taskUpdateFieldsById: {},
    });
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-b' } } },
    });

    const result = await service.saveProjectToCloud(project, 'user-a');

    expect(result.success).toBe(false);
    expect(callbacks.pushProject).not.toHaveBeenCalled();
    expect(callbacks.addToRetryQueueDurably).toHaveBeenCalledWith(
      'project',
      'upsert',
      project,
      undefined,
      'user-a',
      ['task-delete-a'],
    );
    expect(result.retryEnqueued).toContain('project:project-owner-mismatch');
    expect(mockSyncState.setSessionExpired).not.toHaveBeenCalled();
    expect(mockToast.warning).not.toHaveBeenCalled();
  });

  it('saveProjectToCloud 在首次无 session 时应先尝试 refresh，再继续同步', async () => {
    const project = createProject({ id: 'project-refresh-before-expire' });
    mockSessionManager.tryRefreshSession.mockImplementationOnce(async () => true);
    mockClient.auth.getSession
      .mockResolvedValueOnce({ data: { session: null } })
      .mockResolvedValueOnce({ data: { session: { user: { id: 'user-a' } } } });

    const result = await service.saveProjectToCloud(project, 'user-a');

    expect(result.success).toBe(true);
    expect(mockSessionManager.tryRefreshSession).toHaveBeenCalledWith('saveProjectToCloud.getSession');
    expect(mockSyncState.setSessionExpired).not.toHaveBeenCalled();
    expect(callbacks.addToRetryQueue).not.toHaveBeenCalled();
  });

  it('saveProjectToCloud 在 getSession 抛认证错误后 refresh 成功时应继续同步', async () => {
    const project = createProject({ id: 'project-refresh-after-auth-error' });
    let getSessionCallCount = 0;
    mockSessionManager.isSessionExpiredError.mockImplementation((error: unknown) => (error as { code?: string | number }).code === 'PGRST301');
    mockSessionManager.tryRefreshSession.mockImplementationOnce(async () => true);
    mockClient.auth.getSession.mockImplementation(async () => {
      getSessionCallCount += 1;
      if (getSessionCallCount === 1) {
        throw { code: 'PGRST301', message: 'JWT expired' };
      }

      return { data: { session: { user: { id: 'user-a' } } } };
    });

    const result = await service.saveProjectToCloud(project, 'user-a');

    expect(result.success).toBe(true);
    expect(mockSessionManager.tryRefreshSession).toHaveBeenCalledWith('saveProjectToCloud.getSession');
    expect(callbacks.pushProject).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'project-refresh-after-auth-error' }),
      false,
      'user-a',
      [],
    );
    expect(callbacks.addToRetryQueue).not.toHaveBeenCalled();
  });

  it('saveProjectToCloud 应将 sourceUserId 透传给 pushProject 回调', async () => {
    const project = createProject({ id: 'project-owner-pass-through' });
    mockChangeTracker.getProjectChanges.mockReturnValueOnce({
      taskIdsToDelete: ['task-delete-a'],
      taskUpdateFieldsById: {},
    });
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });

    const result = await service.saveProjectToCloud(project, 'user-a');

    expect(result.success).toBe(true);
    expect(callbacks.pushProject).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'project-owner-pass-through' }),
      false,
      'user-a',
      ['task-delete-a'],
    );
  });

  it('项目元数据失败时应停止整批 task/connection 推送', async () => {
    const task: Task = {
      id: 'task-1',
      title: 'Task 1',
      content: '',
      stage: 0,
      parentId: null,
      order: 0,
      rank: 0,
      status: 'active',
      x: 0,
      y: 0,
      displayId: '1',
      createdDate: '2026-03-31T00:00:00.000Z',
    };
    const connection: Connection = {
      id: 'connection-1',
      source: 'task-1',
      target: 'task-1',
    };
    const project = createProject({ id: 'project-stop-batch', tasks: [task], connections: [connection] });
    callbacks.pushProject = vi.fn().mockResolvedValue({ success: false });
    service.setCallbacks(callbacks);
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });

    const result = await service.saveProjectToCloud(project, 'user-a');

    expect(result.success).toBe(false);
    expect(callbacks.pushTask).not.toHaveBeenCalled();
    expect(callbacks.pushConnection).not.toHaveBeenCalled();
  });

  it('项目元数据失败但未真正入 RetryQueue 时，不应伪造 project retryEnqueued', async () => {
    const project = createProject({ id: 'project-no-retry-transfer' });
    callbacks.pushProject = vi.fn().mockResolvedValue({
      success: false,
      retryEnqueued: false,
      failureReason: 'permission denied',
    });
    service.setCallbacks(callbacks);
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });

    const result = await service.saveProjectToCloud(project, 'user-a');

    expect(result.success).toBe(false);
    expect(result.retryEnqueued).not.toContain('project:project-no-retry-transfer');
    expect(result.failureReason).toBe('permission denied');
  });

  it('项目元数据失败但已安全转交 RetryQueue 时，应清理红色 syncError 并保留 project retry marker', async () => {
    const project = createProject({ id: 'project-retry-handoff' });
    callbacks.pushProject = vi.fn().mockResolvedValue({
      success: false,
      retryEnqueued: true,
      failureReason: 'supabase client unavailable for project sync',
    });
    service.setCallbacks(callbacks);
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });

    const result = await service.saveProjectToCloud(project, 'user-a');

    expect(result.success).toBe(false);
    expect(result.retryEnqueued).toContain('project:project-retry-handoff');
    expect(mockSyncState.setSyncError).toHaveBeenCalledWith(null);
    expect(mockSyncState.setSyncError).not.toHaveBeenCalledWith('项目元数据同步失败，已停止批量同步并等待重试');
  });

  it('项目元数据 terminal failure 时应透传 terminal 标记并保留失败原因', async () => {
    const project = createProject({ id: 'project-terminal-failure' });
    callbacks.pushProject = vi.fn().mockResolvedValue({
      success: false,
      terminal: true,
      failureReason: '当前客户端同步协议已过期，请刷新后重试',
    });
    service.setCallbacks(callbacks);
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });

    const result = await service.saveProjectToCloud(project, 'user-a');

    expect(result.success).toBe(false);
    expect(result.terminal).toBe(true);
    expect(result.retryEnqueued).not.toContain('project:project-terminal-failure');
    expect(result.failureReason).toBe('当前客户端同步协议已过期，请刷新后重试');
    expect(mockSyncState.setSyncError).toHaveBeenCalledWith('当前客户端同步协议已过期，请刷新后重试');
  });

  it('saveProjectToCloud 应将 sourceUserId 透传给 task 与 connection 回调', async () => {
    const task: Task = {
      id: 'task-owner-pass-through',
      title: 'Task Owner Pass Through',
      content: '',
      stage: 0,
      parentId: null,
      order: 0,
      rank: 0,
      status: 'active',
      x: 0,
      y: 0,
      displayId: '1',
      createdDate: '2026-03-31T00:00:00.000Z',
    };
    const connection: Connection = {
      id: 'connection-owner-pass-through',
      source: 'task-owner-pass-through',
      target: 'task-owner-pass-through',
    };
    const project = createProject({
      id: 'project-owner-pass-through-batch',
      tasks: [task],
      connections: [connection],
    });
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });

    const result = await service.saveProjectToCloud(project, 'user-a');

    expect(result.success).toBe(true);
    expect(callbacks.pushTask).toHaveBeenCalledWith(task, 'project-owner-pass-through-batch', true, false, 'user-a');
    expect(callbacks.pushConnection).toHaveBeenCalledWith(
      connection,
      'project-owner-pass-through-batch',
      true,
      true,
      false,
      'user-a',
    );
  });

  it('连接通过批量远端任务校验后应跳过逐条任务存在性查询', async () => {
    const sourceTask: Task = {
      id: 'task-remote-source',
      title: 'Task Remote Source',
      content: '',
      stage: 0,
      parentId: null,
      order: 0,
      rank: 0,
      status: 'active',
      x: 0,
      y: 0,
      displayId: '1',
      createdDate: '2026-03-31T00:00:00.000Z',
    };
    const targetTask: Task = {
      ...sourceTask,
      id: 'task-remote-target',
      title: 'Task Remote Target',
      displayId: '2',
    };
    const connection: Connection = {
      id: 'connection-remote-validated',
      source: sourceTask.id,
      target: targetTask.id,
    };
    const project = createProject({
      id: 'project-remote-task-validation',
      tasks: [sourceTask, targetTask],
      connections: [connection],
    });
    taskLookupRows = [{ id: sourceTask.id }, { id: targetTask.id }];
    callbacks.pushTask = vi.fn().mockResolvedValue({ success: false, retryEnqueued: false });
    service.setCallbacks(callbacks);
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });

    const result = await service.saveProjectToCloud(project, 'user-a');

    expect(result.success).toBe(false);
    expect(result.failedTaskIds).toEqual([sourceTask.id, targetTask.id]);
    expect(result.failedConnectionIds).toEqual([]);
    expect(callbacks.pushConnection).toHaveBeenCalledWith(
      connection,
      'project-remote-task-validation',
      true,
      true,
      false,
      'user-a',
    );
  });

  it('远端任务校验缺失任一端点时不应推送连接', async () => {
    const sourceTask: Task = {
      id: 'task-missing-target-source',
      title: 'Task Missing Target Source',
      content: '',
      stage: 0,
      parentId: null,
      order: 0,
      rank: 0,
      status: 'active',
      x: 0,
      y: 0,
      displayId: '1',
      createdDate: '2026-03-31T00:00:00.000Z',
    };
    const targetTask: Task = {
      ...sourceTask,
      id: 'task-missing-target',
      title: 'Task Missing Target',
      displayId: '2',
    };
    const connection: Connection = {
      id: 'connection-missing-target',
      source: sourceTask.id,
      target: targetTask.id,
    };
    const project = createProject({
      id: 'project-missing-target-validation',
      tasks: [sourceTask, targetTask],
      connections: [connection],
    });
    taskLookupRows = [{ id: sourceTask.id }];
    callbacks.pushTask = vi.fn().mockResolvedValue({ success: false, retryEnqueued: false });
    service.setCallbacks(callbacks);
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });

    const result = await service.saveProjectToCloud(project, 'user-a');

    expect(result.success).toBe(false);
    expect(result.failedConnectionIds).toEqual([connection.id]);
    expect(callbacks.pushConnection).not.toHaveBeenCalled();
    expect(callbacks.addToRetryQueue).toHaveBeenCalledWith(
      'connection',
      'upsert',
      connection,
      'project-missing-target-validation',
      'user-a',
    );
  });

  it('saveProjectToCloud 应回放 deletedAt 连接，避免 owner handoff 后丢失连接删除', async () => {
    const deletedConnection: Connection = {
      id: 'connection-deleted-handoff',
      source: 'task-1',
      target: 'task-2',
      deletedAt: '2026-03-31T01:00:00.000Z',
    };
    const project = createProject({
      id: 'project-deleted-connection-handoff',
      connections: [deletedConnection],
    });
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });

    const result = await service.saveProjectToCloud(project, 'user-a');

    expect(result.success).toBe(true);
    expect(callbacks.pushConnection).toHaveBeenCalledWith(
      deletedConnection,
      'project-deleted-connection-handoff',
      true,
      true,
      false,
      'user-a',
    );
  });

  it('project 冲突时不应先回放 deletedAt 连接', async () => {
    const deletedConnection: Connection = {
      id: 'connection-deleted-conflict-guard',
      source: 'task-1',
      target: 'task-2',
      deletedAt: '2026-03-31T01:00:00.000Z',
    };
    const remoteProject = createProject({ id: 'project-deleted-connection-conflict', version: 99 });
    const project = createProject({
      id: 'project-deleted-connection-conflict',
      connections: [deletedConnection],
    });
    callbacks.pushProject = vi.fn().mockResolvedValue({
      success: false,
      conflict: true,
      remoteData: remoteProject,
    });
    service.setCallbacks(callbacks);
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });

    const result = await service.saveProjectToCloud(project, 'user-a');

    expect(result.conflict).toBe(true);
    expect(callbacks.pushConnection).not.toHaveBeenCalled();
  });

  it('project 冲突时不应先执行 task purge', async () => {
    const project = createProject({ id: 'project-task-purge-conflict' });
    mockChangeTracker.getProjectChanges.mockReturnValueOnce({
      taskIdsToDelete: ['task-delete-a'],
      taskUpdateFieldsById: {},
    });
    callbacks.pushProject = vi.fn().mockResolvedValue({
      success: false,
      conflict: true,
      remoteData: createProject({ id: 'project-task-purge-conflict', version: 9 }),
    });
    service.setCallbacks(callbacks);
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });

    const result = await service.saveProjectToCloud(project, 'user-a');

    expect(result.conflict).toBe(true);
    expect(callbacks.purgeTasksFromCloud).not.toHaveBeenCalled();
  });

  it('saveProjectToCloud 应将 sourceUserId 透传给 task purge 回调', async () => {
    const project = createProject({ id: 'project-task-purge-owner-pass-through' });
    mockChangeTracker.getProjectChanges.mockReturnValueOnce({
      taskIdsToDelete: ['task-delete-a'],
      taskUpdateFieldsById: {},
    });
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });

    const result = await service.saveProjectToCloud(project, 'user-a');

    expect(result.success).toBe(true);
    expect(callbacks.purgeTasksFromCloud).toHaveBeenCalledWith(
      'project-task-purge-owner-pass-through',
      ['task-delete-a'],
      'user-a',
    );
  });

  it('task purge 失败时不应将整批同步视为成功', async () => {
    const project = createProject({ id: 'project-task-purge-failed' });
    mockChangeTracker.getProjectChanges.mockReturnValueOnce({
      taskIdsToDelete: ['task-delete-a'],
      taskUpdateFieldsById: {},
    });
    callbacks.purgeTasksFromCloud = vi.fn().mockResolvedValue({ success: false, retriedTaskIds: ['task-delete-a'] });
    service.setCallbacks(callbacks);
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });

    const result = await service.saveProjectToCloud(project, 'user-a');

    expect(result.success).toBe(false);
    expect(result.failedTaskIds).toEqual(['task-delete-a']);
    expect(result.retryEnqueued).toContain('task:task-delete-a');
  });

  it('批内 child retry marker 仅在 RetryQueue 持久化确认成功后才返回', async () => {
    const task: Task = {
      id: 'task-retry-confirmation',
      title: 'Task Retry Confirmation',
      content: '',
      stage: 0,
      parentId: null,
      order: 0,
      rank: 0,
      status: 'active',
      x: 0,
      y: 0,
      displayId: '1',
      createdDate: '2026-03-31T00:00:00.000Z',
    };
    const project = createProject({
      id: 'project-child-retry-confirmation',
      tasks: [task],
    });
    callbacks.pushTask = vi.fn().mockResolvedValue({ success: false, retryEnqueued: true });
    callbacks.confirmRetryQueuePersistence = vi.fn().mockResolvedValue(false);
    service.setCallbacks(callbacks);
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });

    const result = await service.saveProjectToCloud(project, 'user-a');

    expect(result.success).toBe(false);
    expect(result.failedTaskIds).toEqual(['task-retry-confirmation']);
    expect(result.retryEnqueued).not.toContain('task:task-retry-confirmation');
    expect(callbacks.confirmRetryQueuePersistence).toHaveBeenCalled();
  });

  it('task 版本冲突永久失败后应清理对应脏标记，避免下一轮重复推送', async () => {
    const task: Task = {
      id: 'task-terminal-conflict',
      title: 'Task Terminal Conflict',
      content: '',
      stage: 0,
      parentId: null,
      order: 0,
      rank: 0,
      status: 'active',
      x: 0,
      y: 0,
      displayId: '1',
      createdDate: '2026-03-31T00:00:00.000Z',
    };
    const project = createProject({
      id: 'project-task-terminal-conflict',
      tasks: [task],
    });
    callbacks.pushTask = vi.fn().mockRejectedValue(
      new PermanentFailureError(
        'Version conflict',
        Object.assign(new Error('版本冲突'), {
          name: 'VersionConflictError',
          errorType: 'VersionConflictError',
          code: 'TASK_REMOTE_NEWER',
        }),
        { operation: 'pushTask', taskId: task.id, projectId: project.id },
      ),
    );
    service.setCallbacks(callbacks);
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });

    const result = await service.saveProjectToCloud(project, 'user-a');
    const secondResult = await service.saveProjectToCloud(project, 'user-a');

    expect(result.success).toBe(false);
    expect(secondResult.success).toBe(false);
    expect(result.failedTaskIds).toEqual([task.id]);
    expect(secondResult.failedTaskIds).toEqual([task.id]);
    expect(mockChangeTracker.clearTaskChangeIfFresh).toHaveBeenCalledWith(
      project.id,
      task.id,
      expect.any(Number),
    );
    expect(callbacks.pushTask).toHaveBeenCalledTimes(1);
    expect(mockSyncState.setSyncError).toHaveBeenCalledWith('检测到版本冲突，请刷新后重试');
    expect(result.retryEnqueued).not.toContain(`task:${task.id}`);
  });

  it('刷新后的新任务快照应解除冲突抑制并允许后续批同步恢复', async () => {
    const task: Task = {
      id: 'task-terminal-conflict-recovered',
      title: 'Task Terminal Conflict Recovered',
      content: '',
      stage: 0,
      parentId: null,
      order: 0,
      rank: 0,
      status: 'active',
      x: 0,
      y: 0,
      displayId: '1',
      createdDate: '2026-03-31T00:00:00.000Z',
      updatedAt: '2026-03-31T00:00:00.000Z',
    };
    const project = createProject({
      id: 'project-task-terminal-conflict-recovered',
      tasks: [task],
    });
    callbacks.pushTask = vi.fn().mockRejectedValueOnce(
      new PermanentFailureError(
        'Version conflict',
        Object.assign(new Error('版本冲突'), {
          name: 'VersionConflictError',
          errorType: 'VersionConflictError',
          code: 'TASK_REMOTE_NEWER',
        }),
        { operation: 'pushTask', taskId: task.id, projectId: project.id },
      ),
    ).mockResolvedValue({ success: true, retryEnqueued: false });
    service.setCallbacks(callbacks);
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });

    const firstResult = await service.saveProjectToCloud(project, 'user-a');
    const refreshedProject = createProject({
      id: project.id,
      tasks: [{ ...task, updatedAt: '2026-03-31T01:00:00.000Z' }],
    });
    const secondResult = await service.saveProjectToCloud(refreshedProject, 'user-a');

    expect(firstResult.success).toBe(false);
    expect(secondResult.success).toBe(true);
    expect(callbacks.pushTask).toHaveBeenCalledTimes(2);
    expect(secondResult.failedTaskIds).toEqual([]);
  });

  it('connection 版本冲突永久失败后应清理对应脏标记，避免下一轮重复推送', async () => {
    const sourceTask: Task = {
      id: 'task-connection-conflict-source',
      title: 'Task Connection Conflict Source',
      content: '',
      stage: 0,
      parentId: null,
      order: 0,
      rank: 0,
      status: 'active',
      x: 0,
      y: 0,
      displayId: '1',
      createdDate: '2026-03-31T00:00:00.000Z',
    };
    const targetTask: Task = {
      ...sourceTask,
      id: 'task-connection-conflict-target',
      title: 'Task Connection Conflict Target',
      displayId: '2',
    };
    const connection: Connection = {
      id: 'connection-terminal-conflict',
      source: sourceTask.id,
      target: targetTask.id,
    };
    const project = createProject({
      id: 'project-connection-terminal-conflict',
      tasks: [sourceTask, targetTask],
      connections: [connection],
    });
    callbacks.pushConnection = vi.fn().mockRejectedValue(
      new PermanentFailureError(
        'Version conflict',
        Object.assign(new Error('版本冲突'), {
          name: 'VersionConflictError',
          errorType: 'VersionConflictError',
          code: 'CONNECTION_REMOTE_NEWER',
        }),
        { operation: 'pushConnection', connectionId: connection.id, projectId: project.id },
      ),
    );
    service.setCallbacks(callbacks);
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });

    const result = await service.saveProjectToCloud(project, 'user-a');
    const secondResult = await service.saveProjectToCloud(project, 'user-a');

    expect(result.success).toBe(false);
    expect(secondResult.success).toBe(false);
    expect(result.failedConnectionIds).toEqual([connection.id]);
    expect(secondResult.failedConnectionIds).toEqual([connection.id]);
    expect(mockChangeTracker.clearConnectionChangeIfFresh).toHaveBeenCalledWith(
      project.id,
      connection.id,
      expect.any(Number),
    );
    expect(callbacks.pushConnection).toHaveBeenCalledTimes(1);
    expect(mockSyncState.setSyncError).toHaveBeenCalledWith('检测到版本冲突，请刷新后重试');
    expect(result.retryEnqueued).not.toContain(`connection:${connection.id}`);
  });

  it('已删除连接遇到版本冲突永久失败后不应重复推送，但应保持未解决冲突状态', async () => {
    const deletedConnection: Connection = {
      id: 'connection-deleted-terminal-conflict',
      source: 'task-1',
      target: 'task-2',
      deletedAt: '2026-03-31T01:00:00.000Z',
    };
    const project = createProject({
      id: 'project-deleted-connection-terminal-conflict',
      connections: [deletedConnection],
    });
    callbacks.pushConnection = vi.fn().mockRejectedValue(
      new PermanentFailureError(
        'Version conflict',
        Object.assign(new Error('版本冲突'), {
          name: 'VersionConflictError',
          errorType: 'VersionConflictError',
          code: 'CONNECTION_REMOTE_TOMBSTONE_NEWER',
        }),
        { operation: 'pushConnection.remoteTombstone', connectionId: deletedConnection.id, projectId: project.id },
      ),
    );
    service.setCallbacks(callbacks);
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });

    const result = await service.saveProjectToCloud(project, 'user-a');
    const secondResult = await service.saveProjectToCloud(project, 'user-a');

    expect(result.success).toBe(false);
    expect(secondResult.success).toBe(false);
    expect(result.failedConnectionIds).toEqual([deletedConnection.id]);
    expect(secondResult.failedConnectionIds).toEqual([deletedConnection.id]);
    expect(mockChangeTracker.clearConnectionChangeIfFresh).toHaveBeenCalledWith(
      project.id,
      deletedConnection.id,
      expect.any(Number),
    );
    expect(callbacks.pushConnection).toHaveBeenCalledTimes(1);
    expect(mockSyncState.setSyncError).toHaveBeenCalledWith('检测到版本冲突，请刷新后重试');
  });

  it('task purge 成功后不应为引用已 purge 任务的连接创建无意义重试', async () => {
    const project = createProject({
      id: 'project-task-purge-skips-connection-retry',
      connections: [
        {
          id: 'connection-covered-by-purge',
          source: 'task-delete-a',
          target: 'task-still-local',
        },
      ],
    });
    mockChangeTracker.getProjectChanges.mockReturnValueOnce({
      taskIdsToDelete: ['task-delete-a'],
      taskUpdateFieldsById: {},
    });
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });

    const result = await service.saveProjectToCloud(project, 'user-a');

    expect(result.success).toBe(true);
    expect(result.failedConnectionIds).toEqual([]);
    expect(result.retryEnqueued).not.toContain('connection:connection-covered-by-purge');
    expect(callbacks.addToRetryQueue).not.toHaveBeenCalledWith(
      'connection',
      'upsert',
      expect.objectContaining({ id: 'connection-covered-by-purge' }),
      'project-task-purge-skips-connection-retry',
      'user-a',
    );
  });

  it('远端任务存在性查询遇到浏览器挂起时应整体延后连接同步，而不是降级为未同步依赖', async () => {
    const task: Task = {
      id: 'task-browser-suspended',
      title: 'Task Browser Suspended',
      content: '',
      stage: 0,
      parentId: null,
      order: 0,
      rank: 0,
      status: 'active',
      x: 0,
      y: 0,
      displayId: '1',
      createdDate: '2026-03-31T00:00:00.000Z',
    };
    const connection: Connection = {
      id: 'connection-browser-suspended',
      source: task.id,
      target: task.id,
    };
    const project = createProject({
      id: 'project-browser-suspended-connections',
      tasks: [task],
      connections: [connection],
    });
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });
    mockClient.from.mockImplementation((table: string) => {
      if (table === 'tasks') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              in: vi.fn(() => ({
                is: vi.fn(async () => ({ data: null, error: createBrowserNetworkSuspendedError() })),
              })),
            })),
          })),
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    });

    const result = await service.saveProjectToCloud(project, 'user-a');

    expect(result.success).toBe(false);
    expect(result.failedConnectionIds).toEqual(['connection-browser-suspended']);
    expect(result.retryEnqueued).toContain('connection:connection-browser-suspended');
    expect(callbacks.pushConnection).not.toHaveBeenCalled();
    expect(callbacks.addToRetryQueue).toHaveBeenCalledWith(
      'connection',
      'upsert',
      connection,
      'project-browser-suspended-connections',
      'user-a',
    );
  });

  it('session 在浏览器网络挂起窗口内暂不可用时应延后项目批同步而非标记过期', async () => {
    const project = createProject({ id: 'project-browser-suspended-session' });
    setVisibilityState('hidden');
    mockClient.auth.getSession.mockResolvedValueOnce({ data: { session: null } });
    mockSessionManager.tryRefreshSession.mockResolvedValueOnce(false);

    const result = await service.saveProjectToCloud(project, 'user-a');

    expect(result.success).toBe(false);
    expect(result.failureReason).toBe('project sync deferred by browser suspension');
    expect(mockSyncState.setSessionExpired).not.toHaveBeenCalled();
    expect(mockToast.warning).not.toHaveBeenCalled();
    expect(callbacks.addToRetryQueueDurably).toHaveBeenCalledWith(
      'project',
      'upsert',
      project,
      undefined,
      'user-a',
      [],
    );
  });

  it('saveProjectToCloud 在 purgeTasksFromCloud 部分失败且未全部入队时应标注 partialRetryHandoff', async () => {
    const project = createProject({ id: 'project-partial-retry-handoff' });
    mockChangeTracker.getProjectChanges.mockReturnValueOnce({
      taskIdsToDelete: ['task-delete-a', 'task-delete-b'],
      taskUpdateFieldsById: {},
    });
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });
    // 中文注释：purge 失败但 RPC 只回放了 task-delete-a；task-delete-b 没进 RetryQueue。
    callbacks.purgeTasksFromCloud = vi.fn().mockResolvedValue({
      success: false,
      retriedTaskIds: ['task-delete-a'],
    });
    service.setCallbacks(callbacks);

    const result = await service.saveProjectToCloud(project, 'user-a');

    expect(result.success).toBe(false);
    expect(result.failedTaskIds).toEqual(['task-delete-a', 'task-delete-b']);
    // 中文注释：task-delete-a 已入队，task-delete-b 未入队 —— 部分交接。
    expect(result.retryEnqueued).toContain('task:task-delete-a');
    expect(result.retryEnqueued).not.toContain('task:task-delete-b');
    expect(result.partialRetryHandoff).toBe(true);
    expect(result.failureReason).toBe(
      'project batch sync partially delegated; some failures did not enter retry queue',
    );
    expect(mockSyncState.scheduleRecoverableSyncError).toHaveBeenCalledWith(
      RECOVERABLE_SYNC_ERROR_MESSAGES.PARTIAL_RETRY_HANDOFF,
    );
    expect(mockSyncState.setSyncError).not.toHaveBeenCalledWith(RECOVERABLE_SYNC_ERROR_MESSAGES.PARTIAL_RETRY_HANDOFF);
  });

  it('saveProjectToCloud 在所有失败项均已入 RetryQueue 时应保持 fullyResolved 语义', async () => {
    const project = createProject({ id: 'project-fully-resolved-handoff' });
    mockChangeTracker.getProjectChanges.mockReturnValueOnce({
      taskIdsToDelete: ['task-delete-a'],
      taskUpdateFieldsById: {},
    });
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });
    // 中文注释：purge 失败但所有失败任务都已回放入队 —— fullyResolved 路径。
    callbacks.purgeTasksFromCloud = vi.fn().mockResolvedValue({
      success: false,
      retriedTaskIds: ['task-delete-a'],
    });
    service.setCallbacks(callbacks);

    const result = await service.saveProjectToCloud(project, 'user-a');

    expect(result.success).toBe(false);
    expect(result.failedTaskIds).toEqual(['task-delete-a']);
    expect(result.retryEnqueued).toContain('task:task-delete-a');
    expect(result.partialRetryHandoff).toBe(false);
    expect(result.failureReason).toBe(
      'project batch sync delegated remaining work to retry queue',
    );
  });
});
