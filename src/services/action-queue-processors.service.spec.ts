/**
 * ActionQueueProcessorsService 单元测试
 *
 * 验证 setupProcessors 注册了正确数量的处理器（13 个），
 * 并逐类型验证处理器的行为（通过捕获 registerProcessor mock 调用的 handler）。
 */
import { Injector, runInInjectionContext } from '@angular/core';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ActionQueueProcessorsService } from './action-queue-processors.service';
import { ActionQueueService, type ActionQueueProcessorResult } from './action-queue.service';
import { QueuedAction as QueuedActionModel } from './action-queue.types';
import { RetryQueueService, SimpleSyncService } from '../core-bridge';
import { ProjectStateService } from './project-state.service';
import { AuthService } from './auth.service';
import { LoggerService } from './logger.service';
import { ConflictStorageService } from './conflict-storage.service';
import { ToastService } from './toast.service';
import { AUTH_CONFIG } from '../config/auth.config';
import { PermanentFailureError } from '../utils/permanent-failure-error';

type QueuedAction = Omit<Partial<QueuedActionModel>, 'payload'> & { payload: unknown };
type RegisteredProcessor = (action: QueuedActionModel) => Promise<ActionQueueProcessorResult>;
type MockRetryQueueProjectItem = {
  type: 'project';
  data: { id: string; syncSource?: string; name?: string };
  sourceUserId: string;
  taskIdsToDelete: string[];
};

// ── Mock factories ───────────────────────────────────────────

const mockLoggerCategory = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
const mockLoggerService = { category: vi.fn(() => mockLoggerCategory) };

const mockActionQueueService = {
  registerProcessor: vi.fn(),
  setQueueProcessCallbacks: vi.fn(),
  markActionSyncedRemotely: vi.fn(),
  markActionResolvedWithoutRemote: vi.fn(),
  moveToDeadLetter: vi.fn(),
  deferRetry: vi.fn((error) => ({ outcome: 'defer-retry', error })),
  failRetry: vi.fn((error) => ({ outcome: 'failed', error })),
  discardActions: vi.fn(),
  settleProjectDeleteSuccessForOwner: vi.fn().mockResolvedValue(1),
  enqueueForOwner: vi.fn().mockResolvedValue('queued-owner-action'),
  getCurrentQueueViewGeneration: vi.fn(() => 1),
  getProjectMutationViewGeneration: vi.fn(() => 0),
  isQueueViewCurrent: vi.fn(() => true),
};

const mockRetryQueueService = {
  removeByProjectId: vi.fn(),
  getItems: vi.fn(() => []),
  findItemForOwner: vi.fn<(...args: unknown[]) => MockRetryQueueProjectItem | undefined>(() => undefined),
};

const mockSyncService = {
  pauseRealtimeUpdates: vi.fn(),
  resumeRealtimeUpdates: vi.fn(),
  hasPendingRetryRecovery: vi.fn(() => false),
  markSyncRecoveredIfIdle: vi.fn(),
  saveProjectSmart: vi.fn().mockResolvedValue({ success: true, newVersion: 2 }),
  loadFullProjectOptimized: vi.fn().mockResolvedValue(null),
  deleteProjectFromCloud: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
  pushTask: vi.fn().mockResolvedValue(true),
  deleteTask: vi.fn().mockResolvedValue(true),
  saveUserPreferences: vi.fn().mockResolvedValue(true),
  saveFocusSession: vi.fn().mockResolvedValue({ ok: true }),
  upsertRoutineTask: vi.fn().mockResolvedValue({ ok: true }),
  incrementRoutineCompletion: vi.fn().mockResolvedValue({ ok: true }),
};

const mockProjectStateService = {
  updateProjects: vi.fn(),
  getProject: vi.fn<(projectId: string) => { id: string; syncSource?: string } | undefined>(() => undefined),
};
const mockAuthService = { currentUserId: vi.fn<() => string | null>(() => 'test-user') };
const mockConflictStorageService = { saveConflict: vi.fn().mockResolvedValue(true) };
const mockToastService = { warning: vi.fn(), info: vi.fn(), error: vi.fn(), success: vi.fn() };

// ── Helpers ──────────────────────────────────────────────────

/** Retrieve the handler registered for a given action type */
function getProcessor(type: string): (action: QueuedAction) => Promise<ActionQueueProcessorResult> {
  const call = mockActionQueueService.registerProcessor.mock.calls.find(
    (c: unknown[]) => c[0] === type,
  ) as [string, RegisteredProcessor] | undefined;
  if (!call) throw new Error(`No processor registered for "${type}"`);
  return call[1] as unknown as (action: QueuedAction) => Promise<ActionQueueProcessorResult>;
}

describe('ActionQueueProcessorsService', () => {
  let service: ActionQueueProcessorsService;
  let injector: Injector;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthService.currentUserId.mockReturnValue('test-user');
    mockProjectStateService.getProject.mockReturnValue(undefined);
    mockSyncService.saveProjectSmart.mockResolvedValue({ success: true, newVersion: 2 });
    mockSyncService.loadFullProjectOptimized.mockResolvedValue(null);
    mockSyncService.deleteProjectFromCloud.mockResolvedValue({ ok: true, value: undefined });
    mockSyncService.pushTask.mockResolvedValue(true);
    mockSyncService.deleteTask.mockResolvedValue(true);
    mockSyncService.saveUserPreferences.mockResolvedValue(true);
    mockSyncService.saveFocusSession.mockResolvedValue({ ok: true });
    mockSyncService.upsertRoutineTask.mockResolvedValue({ ok: true });
    mockSyncService.incrementRoutineCompletion.mockResolvedValue({ ok: true });
    mockSyncService.hasPendingRetryRecovery.mockReset();
    mockSyncService.hasPendingRetryRecovery.mockReturnValue(false);
    mockSyncService.markSyncRecoveredIfIdle.mockReset();
    mockConflictStorageService.saveConflict.mockResolvedValue(true);
    mockActionQueueService.getCurrentQueueViewGeneration.mockReturnValue(1);
    mockActionQueueService.getProjectMutationViewGeneration.mockReset();
    mockActionQueueService.getProjectMutationViewGeneration.mockReturnValue(0);
    mockActionQueueService.isQueueViewCurrent.mockReturnValue(true);
    mockActionQueueService.settleProjectDeleteSuccessForOwner.mockResolvedValue(1);

    injector = Injector.create({
      providers: [
        { provide: ActionQueueProcessorsService, useClass: ActionQueueProcessorsService },
        { provide: LoggerService, useValue: mockLoggerService },
        { provide: ActionQueueService, useValue: mockActionQueueService },
        { provide: SimpleSyncService, useValue: mockSyncService },
        { provide: RetryQueueService, useValue: mockRetryQueueService },
        { provide: ProjectStateService, useValue: mockProjectStateService },
        { provide: AuthService, useValue: mockAuthService },
        { provide: ConflictStorageService, useValue: mockConflictStorageService },
        { provide: ToastService, useValue: mockToastService },
      ],
    });

    service = runInInjectionContext(injector, () => injector.get(ActionQueueProcessorsService));
    service.setProjectConflictHandler(vi.fn());
    service.setupProcessors();
  });

  // ── Registration ───────────────────────────────────────────

  it('should register 13 processors', () => {
    expect(mockActionQueueService.registerProcessor).toHaveBeenCalledTimes(13);
  });

  it('setupProcessors should stay idempotent after eager bootstrap', () => {
    mockActionQueueService.registerProcessor.mockClear();

    service.setupProcessors();

    expect(mockActionQueueService.registerProcessor).not.toHaveBeenCalled();
  });

  it('should set queue sync callbacks', () => {
    expect(mockActionQueueService.setQueueProcessCallbacks).toHaveBeenCalledOnce();
  });

  it('should mark sync recovered only when queue settles with pure remote success', () => {
    const settledCallback = mockActionQueueService.setQueueProcessCallbacks.mock.calls[0]?.[2] as
      | ((summary: { processed: number; failed: number; movedToDeadLetter: number; remaining: number; remoteSuccessCount: number; resolvedNoOpCount: number }) => void)
      | undefined;

    expect(settledCallback).toBeTypeOf('function');

    settledCallback?.({
      processed: 2,
      failed: 0,
      movedToDeadLetter: 0,
      remaining: 0,
      remoteSuccessCount: 2,
      resolvedNoOpCount: 0,
    });

    expect(mockSyncService.markSyncRecoveredIfIdle).toHaveBeenCalledOnce();
  });

  it('should not mark sync recovered when queue settlement includes local-only completion', () => {
    const settledCallback = mockActionQueueService.setQueueProcessCallbacks.mock.calls[0]?.[2] as
      | ((summary: { processed: number; failed: number; movedToDeadLetter: number; remaining: number; remoteSuccessCount: number; resolvedNoOpCount: number }) => void)
      | undefined;

    expect(settledCallback).toBeTypeOf('function');

    settledCallback?.({
      processed: 2,
      failed: 0,
      movedToDeadLetter: 0,
      remaining: 0,
      remoteSuccessCount: 1,
      resolvedNoOpCount: 0,
    });

    expect(mockSyncService.markSyncRecoveredIfIdle).not.toHaveBeenCalled();
  });

  it('should mark sync recovered when ActionQueue only settles a tombstone no-op after RetryQueue already recovered', () => {
    mockSyncService.hasPendingRetryRecovery.mockReturnValueOnce(true);
    const settledCallback = mockActionQueueService.setQueueProcessCallbacks.mock.calls[0]?.[2] as
      | ((summary: { processed: number; failed: number; movedToDeadLetter: number; remaining: number; remoteSuccessCount: number; resolvedNoOpCount: number }) => void)
      | undefined;

    expect(settledCallback).toBeTypeOf('function');

    settledCallback?.({
      processed: 1,
      failed: 0,
      movedToDeadLetter: 0,
      remaining: 0,
      remoteSuccessCount: 0,
      resolvedNoOpCount: 1,
    });

    expect(mockSyncService.markSyncRecoveredIfIdle).toHaveBeenCalledOnce();
  });

  it('should mark sync recovered when RetryQueue already recovered and ActionQueue only drains local-only completions', () => {
    mockSyncService.hasPendingRetryRecovery.mockReturnValueOnce(true);
    const settledCallback = mockActionQueueService.setQueueProcessCallbacks.mock.calls[0]?.[2] as
      | ((summary: { processed: number; failed: number; movedToDeadLetter: number; remaining: number; remoteSuccessCount: number; resolvedNoOpCount: number }) => void)
      | undefined;

    expect(settledCallback).toBeTypeOf('function');

    settledCallback?.({
      processed: 2,
      failed: 0,
      movedToDeadLetter: 0,
      remaining: 0,
      remoteSuccessCount: 0,
      resolvedNoOpCount: 0,
    });

    expect(mockSyncService.markSyncRecoveredIfIdle).toHaveBeenCalledOnce();
  });

  it('should not mark sync recovered for pure authoritative no-op without retry recovery signal', () => {
    const settledCallback = mockActionQueueService.setQueueProcessCallbacks.mock.calls[0]?.[2] as
      | ((summary: { processed: number; failed: number; movedToDeadLetter: number; remaining: number; remoteSuccessCount: number; resolvedNoOpCount: number }) => void)
      | undefined;

    expect(settledCallback).toBeTypeOf('function');

    settledCallback?.({
      processed: 1,
      failed: 0,
      movedToDeadLetter: 0,
      remaining: 0,
      remoteSuccessCount: 0,
      resolvedNoOpCount: 1,
    });

    expect(mockSyncService.markSyncRecoveredIfIdle).not.toHaveBeenCalled();
  });

  it('focus-session:update should preserve browser-suspension details for the queue layer', async () => {
    mockSyncService.saveFocusSession.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'SYNC_OFFLINE',
        message: '浏览器恢复连接中，请稍后重试',
        details: {
          reason: 'browser-network-suspended',
          resumeDelayMs: 321,
        },
      },
    });
    const handler = getProcessor('focus-session:update');

    await expect(handler({
      payload: {
        record: {
          id: 'focus-1',
          userId: 'test-user',
          startedAt: '2026-04-08T00:00:00.000Z',
          endedAt: null,
          updatedAt: '2026-04-08T00:00:01.000Z',
          snapshot: { version: 6 },
        },
        sourceUserId: 'test-user',
      },
    } as QueuedAction)).rejects.toMatchObject({
      message: expect.stringContaining('SYNC_OFFLINE'),
      code: 'SYNC_OFFLINE',
      details: expect.objectContaining({
        reason: 'browser-network-suspended',
        resumeDelayMs: 321,
      }),
    });
  });

  it('focus-session:update should not log browser resume deferrals as errors', async () => {
    mockSyncService.saveFocusSession.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'SYNC_OFFLINE',
        message: '浏览器恢复连接中，请稍后重试',
        details: {
          reason: 'browser-network-suspended',
          resumeDelayMs: 321,
        },
      },
    });
    const handler = getProcessor('focus-session:update');

    await expect(handler({
      payload: {
        record: {
          id: 'focus-1',
          userId: 'test-user',
          startedAt: '2026-04-08T00:00:00.000Z',
          endedAt: null,
          updatedAt: '2026-04-08T00:00:01.000Z',
          snapshot: { version: 6 },
        },
        sourceUserId: 'test-user',
      },
    } as QueuedAction)).rejects.toMatchObject({
      code: 'SYNC_OFFLINE',
    });

    expect(mockLoggerCategory.error).not.toHaveBeenCalledWith(
      'focus-session:update 异常',
      expect.anything(),
    );
    expect(mockLoggerCategory.debug).toHaveBeenCalledWith(
      'focus-session:update 延后重试（浏览器恢复中）',
      expect.objectContaining({
        error: expect.objectContaining({
          code: 'SYNC_OFFLINE',
          details: expect.objectContaining({
            reason: 'browser-network-suspended',
          }),
        }),
      }),
    );
  });

  // ── project:update ─────────────────────────────────────────

  it('project:update should call saveProjectSmart and update version', async () => {
    const handler = getProcessor('project:update');
    const project = { id: 'p-1', name: 'Test' };

    const result = await handler({ payload: { project, sourceUserId: 'test-user' } } as QueuedAction);

    expect(mockSyncService.saveProjectSmart).toHaveBeenCalledWith(project, 'test-user', undefined);
    expect(mockProjectStateService.updateProjects).toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it('project:update should replay deferred task deletes only after project save succeeds', async () => {
    const handler = getProcessor('project:update');
    const project = { id: 'p-delete-after-project', name: 'Test' };

    const result = await handler({
      payload: {
        project,
        sourceUserId: 'test-user',
        taskIdsToDelete: ['task-a', 'task-b'],
      },
    } as QueuedAction);

    expect(mockSyncService.saveProjectSmart).toHaveBeenCalledWith(project, 'test-user', ['task-a', 'task-b']);
    expect(mockSyncService.deleteTask).toHaveBeenNthCalledWith(1, 'task-a', 'p-delete-after-project', 'test-user');
    expect(mockSyncService.deleteTask).toHaveBeenNthCalledWith(2, 'task-b', 'p-delete-after-project', 'test-user');
    expect(result).toBe(true);
  });

  it('project:update should not replay deferred task deletes when project save conflicts', async () => {
    mockSyncService.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      conflict: true,
      remoteData: { id: 'p-conflict', syncSource: 'synced' },
    });
    const handler = getProcessor('project:update');

    const result = await handler({
      payload: {
        project: { id: 'p-conflict', syncSource: 'synced' },
        sourceUserId: 'test-user',
        taskIdsToDelete: ['task-a'],
      },
    } as QueuedAction);

    expect(result).toBe(true);
    expect(mockSyncService.deleteTask).not.toHaveBeenCalled();
  });

  it('project:update should hand off remaining task deletes when queue view becomes stale mid-replay', async () => {
    const handler = getProcessor('project:update');
    const project = { id: 'p-stale-delete-handoff', name: 'Test' };
    mockActionQueueService.isQueueViewCurrent
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);

    const result = await handler({
      payload: {
        project,
        sourceUserId: 'test-user',
        taskIdsToDelete: ['task-a', 'task-b'],
      },
    } as QueuedAction);

    expect(result).toBe(true);
    expect(mockSyncService.deleteTask).toHaveBeenCalledTimes(1);
    expect(mockSyncService.deleteTask).toHaveBeenCalledWith('task-a', 'p-stale-delete-handoff', 'test-user');
    expect(mockActionQueueService.enqueueForOwner).toHaveBeenCalledWith('test-user', expect.objectContaining({
      type: 'update',
      entityType: 'project',
      entityId: 'p-stale-delete-handoff',
      payload: expect.objectContaining({
        taskIdsToDelete: ['task-b'],
      }),
    }));
  });

  it('project:update should drop remaining task deletes when only this project mutation view becomes stale', async () => {
    const handler = getProcessor('project:update');
    const project = { id: 'p-project-view-stale', name: 'Test' };
    mockActionQueueService.getProjectMutationViewGeneration
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(1)
      .mockReturnValueOnce(1);

    const result = await handler({
      id: 'action-project-view-stale',
      payload: {
        project,
        sourceUserId: 'test-user',
        taskIdsToDelete: ['task-a', 'task-b'],
      },
    } as QueuedAction);

    expect(result).toBe(true);
    expect(mockSyncService.deleteTask).toHaveBeenCalledTimes(1);
    expect(mockSyncService.deleteTask).toHaveBeenCalledWith('task-a', 'p-project-view-stale', 'test-user');
    expect(mockActionQueueService.enqueueForOwner).not.toHaveBeenCalled();
    expect(mockActionQueueService.markActionResolvedWithoutRemote).toHaveBeenCalledWith('action-project-view-stale');
  });

  it('project:update should defer without retry budget when userId is missing', async () => {
    mockAuthService.currentUserId.mockReturnValueOnce(null);
    const handler = getProcessor('project:update');

    const result = await handler({ payload: { project: { id: 'p-1' } } });

    expect(result).toEqual({
      outcome: 'defer-retry',
      error: expect.objectContaining({
        code: 'SYNC_AUTH_PENDING',
        details: expect.objectContaining({
          reason: 'auth-pending',
          actionType: 'project:update',
          projectId: 'p-1',
        }),
      }),
    });
    expect(mockActionQueueService.deferRetry).toHaveBeenCalledWith(expect.objectContaining({
      code: 'SYNC_AUTH_PENDING',
    }));
    expect(mockLoggerCategory.warn).toHaveBeenCalled();
  });

  it('project:update should discard local-only project queue items', async () => {
    const handler = getProcessor('project:update');

    const result = await handler({ payload: { project: { id: 'p-local', syncSource: 'local-only' } } });

    expect(result).toBe(true);
    expect(mockSyncService.saveProjectSmart).not.toHaveBeenCalled();
  });

  it('project:update should move ambiguous legacy queue items to dead letter', async () => {
    const handler = getProcessor('project:update');

    const result = await handler({ payload: { project: { id: 'p-legacy' } } } as QueuedAction);

    expect(result).toBe(true);
    expect(mockSyncService.saveProjectSmart).not.toHaveBeenCalled();
    expect(mockActionQueueService.moveToDeadLetter).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { project: { id: 'p-legacy' } } }),
      expect.stringContaining('legacy 队列项缺少来源元数据')
    );
    expect(mockToastService.warning).toHaveBeenCalled();
  });

  it('project:update should move legacy synced queue items without owner to dead letter', async () => {
    const handler = getProcessor('project:update');
    mockProjectStateService.getProject.mockReturnValueOnce({ id: 'p-legacy-synced', syncSource: 'synced' });
    const action = {
      payload: { project: { id: 'p-legacy-synced', syncSource: 'synced' } },
    } as QueuedAction;

    const result = await handler(action);

    expect(result).toBe(true);
    expect(mockSyncService.saveProjectSmart).not.toHaveBeenCalled();
    expect(mockActionQueueService.moveToDeadLetter).toHaveBeenCalledWith(
      action,
      expect.stringContaining('legacy 队列项缺少来源元数据')
    );
  });

  it('project:update should move mixed-state legacy queue items without owner to dead letter', async () => {
    const handler = getProcessor('project:update');
    mockProjectStateService.getProject.mockReturnValueOnce({ id: 'p-promoted', syncSource: 'synced' });
    const action = {
      payload: { project: { id: 'p-promoted', syncSource: 'local-only' } },
    } as QueuedAction;

    const result = await handler(action);

    expect(result).toBe(true);
    expect(mockSyncService.saveProjectSmart).not.toHaveBeenCalled();
    expect(mockActionQueueService.moveToDeadLetter).toHaveBeenCalledWith(
      action,
      expect.stringContaining('legacy 队列项缺少来源元数据')
    );
  });

  it('project:update should move queue items from another user to dead letter', async () => {
    const handler = getProcessor('project:update');

    const result = await handler({
      payload: {
        project: { id: 'p-foreign', syncSource: 'synced' },
        sourceUserId: 'other-user',
      },
    } as QueuedAction);

    expect(result).toBe(true);
    expect(mockSyncService.saveProjectSmart).not.toHaveBeenCalled();
    expect(mockActionQueueService.moveToDeadLetter).toHaveBeenCalled();
  });

  it('project:update should surface conflicts to the registered handler', async () => {
    const onConflict = vi.fn();
    service.setProjectConflictHandler(onConflict);
    mockSyncService.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      conflict: true,
      remoteData: { id: 'p-1', syncSource: 'synced' },
    });
    const handler = getProcessor('project:update');

    const result = await handler({
      payload: {
        project: { id: 'p-1', syncSource: 'synced' },
        sourceUserId: 'test-user',
      },
    } as QueuedAction);

    expect(result).toBe(true);
    expect(onConflict).toHaveBeenCalledWith(
      { id: 'p-1', syncSource: 'synced' },
      { id: 'p-1', syncSource: 'synced' },
      'test-user',
      undefined,
    );
  });

  it('project:update should preserve deferred task deletes when surfacing conflicts', async () => {
    const onConflict = vi.fn();
    service.setProjectConflictHandler(onConflict);
    mockSyncService.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      conflict: true,
      remoteData: { id: 'p-delete-conflict', syncSource: 'synced' },
    });
    const handler = getProcessor('project:update');

    const result = await handler({
      payload: {
        project: { id: 'p-delete-conflict', syncSource: 'synced' },
        sourceUserId: 'test-user',
        taskIdsToDelete: ['task-a'],
      },
    } as QueuedAction);

    expect(result).toBe(true);
    expect(onConflict).toHaveBeenCalledWith(
      { id: 'p-delete-conflict', syncSource: 'synced' },
      { id: 'p-delete-conflict', syncSource: 'synced' },
      'test-user',
      ['task-a'],
    );
  });

  it('project:update should acknowledge failures already transferred to RetryQueue', async () => {
    mockSyncService.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      projectPushed: true,
      failedTaskIds: ['task-a'],
      failedConnectionIds: ['connection-a'],
      retryEnqueued: ['task:task-a', 'connection:connection-a'],
      failureReason: 'project batch sync delegated remaining work to retry queue',
    });
    const handler = getProcessor('project:update');

    const result = await handler({
      payload: {
        project: { id: 'p-retry-handoff', syncSource: 'synced' },
        sourceUserId: 'test-user',
      },
    } as QueuedAction);

    expect(result).toBe(true);
    expect(mockLoggerCategory.info).toHaveBeenCalledWith(
      'project:update 已转交 RetryQueue，当前 ActionQueue 项视为完成',
      expect.objectContaining({
        projectId: 'p-retry-handoff',
      })
    );
  });

  it('project:update should return a classified failure when failed entities were not transferred to RetryQueue', async () => {
    mockSyncService.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      projectPushed: true,
      failedTaskIds: ['task-a'],
      retryEnqueued: [],
      failureReason: 'permanent task failure',
    });
    const handler = getProcessor('project:update');

    const result = await handler({
      payload: {
        project: { id: 'p-permanent-failure', syncSource: 'synced' },
        sourceUserId: 'test-user',
      },
    } as QueuedAction);

    expect(result).toEqual({
      outcome: 'failed',
      error: expect.objectContaining({
        code: 'SYNC_PROJECT_WRITE_FAILED',
        message: 'permanent task failure',
        details: expect.objectContaining({
          reason: 'project-sync-failed',
          actionType: 'project:update',
          projectId: 'p-permanent-failure',
          failedTaskIds: ['task-a'],
        }),
      }),
    });
    expect(mockActionQueueService.failRetry).toHaveBeenCalledWith(expect.objectContaining({
      message: 'permanent task failure',
    }));
    expect(mockLoggerCategory.warn).toHaveBeenCalledWith(
      'project:update 同步未完成，保留 ActionQueue 重试',
      expect.objectContaining({ projectId: 'p-permanent-failure' }),
    );
  });

  it('project:update should log info and defer retry without consuming queue failure budget when partialRetryHandoff is set', async () => {
    mockSyncService.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      projectPushed: true,
      failedTaskIds: ['task-a', 'task-b'],
      // 中文注释：仅 task-a 入队，task-b 没进 RetryQueue —— batch-sync 把这种情况标注为 partial。
      retryEnqueued: ['task:task-a'],
      partialRetryHandoff: true,
      failureReason: 'project batch sync partially delegated; some failures did not enter retry queue',
    });
    const handler = getProcessor('project:update');

    const result = await handler({
      payload: {
        project: { id: 'p-partial-handoff', syncSource: 'synced' },
        sourceUserId: 'test-user',
      },
    } as QueuedAction);

    expect(result).toEqual({
      outcome: 'defer-retry',
      error: expect.objectContaining({
        code: 'SYNC_RETRY_HANDOFF_PENDING',
        details: expect.objectContaining({
          reason: 'partial-retry-handoff',
          failedTaskCount: 2,
          failedConnectionCount: 0,
        }),
      }),
    });
    expect(mockActionQueueService.deferRetry).toHaveBeenCalledWith(expect.objectContaining({
      code: 'SYNC_RETRY_HANDOFF_PENDING',
    }));
    expect(mockLoggerCategory.info).toHaveBeenCalledWith(
      'project:update 部分转交 RetryQueue，等待下一轮回放',
      expect.objectContaining({
        projectId: 'p-partial-handoff',
        retryEnqueued: ['task:task-a'],
        failedTaskIds: ['task-a', 'task-b'],
      }),
    );
    expect(mockLoggerCategory.error).not.toHaveBeenCalled();
  });

  it('project:update should not acknowledge project metadata failures when pushProject did not enqueue RetryQueue', async () => {
    mockSyncService.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      projectPushed: false,
      retryEnqueued: [],
      failureReason: 'permission denied',
    });
    const handler = getProcessor('project:update');

    const result = await handler({
      payload: {
        project: { id: 'p-no-retry-transfer', syncSource: 'synced' },
        sourceUserId: 'test-user',
      },
    } as QueuedAction);

    expect(result).toEqual({
      outcome: 'failed',
      error: expect.objectContaining({
        code: 'SYNC_PROJECT_WRITE_FAILED',
        message: 'permission denied',
        details: expect.objectContaining({
          actionType: 'project:update',
          projectId: 'p-no-retry-transfer',
        }),
      }),
    });
  });

  it('project:update should move terminal project sync failures to dead letter', async () => {
    mockSyncService.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      terminal: true,
      failureReason: '当前客户端同步协议已过期，请刷新后重试',
    });
    const action = {
      payload: {
        project: { id: 'p-terminal-failure', syncSource: 'synced' },
        sourceUserId: 'test-user',
      },
    } as QueuedAction;
    const handler = getProcessor('project:update');

    const result = await handler(action);

    expect(result).toBe(true);
    expect(mockActionQueueService.moveToDeadLetter).toHaveBeenCalledWith(
      action,
      '当前客户端同步协议已过期，请刷新后重试',
    );
    expect(mockLoggerCategory.warn).toHaveBeenCalledWith(
      'project:update 永久失败，已转入死信',
      expect.objectContaining({
        projectId: 'p-terminal-failure',
        failureReason: '当前客户端同步协议已过期，请刷新后重试',
      }),
    );
  });

  it('project:update should acknowledge RetryQueue handoff even after queue view becomes stale', async () => {
    const project = { id: 'p-stale-retry-transfer', syncSource: 'synced' };
    mockSyncService.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      projectPushed: false,
      retryEnqueued: ['project:p-stale-retry-transfer'],
      failureReason: 'offline sync deferred',
    });
    mockRetryQueueService.findItemForOwner.mockReturnValueOnce({
      type: 'project',
      data: project,
      sourceUserId: 'test-user',
      taskIdsToDelete: [],
    });
    mockActionQueueService.isQueueViewCurrent.mockReturnValueOnce(false);
    const handler = getProcessor('project:update');

    const result = await handler({
      payload: {
        project,
        sourceUserId: 'test-user',
      },
    } as QueuedAction);

    expect(result).toBe(true);
  });

  it('project:update should quietly discard stale terminal task-conflict results', async () => {
    mockSyncService.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      projectPushed: true,
      failedTaskIds: ['task-stale-a'],
      retryEnqueued: [],
      failureReason: 'project batch sync finished with terminal conflicts',
    });
    mockActionQueueService.getProjectMutationViewGeneration
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(1);
    const handler = getProcessor('project:update');

    const result = await handler({
      id: 'action-stale-terminal',
      payload: {
        project: { id: 'p-stale-terminal', syncSource: 'synced' },
        sourceUserId: 'test-user',
      },
    } as QueuedAction);

    expect(result).toBe(true);
    expect(mockActionQueueService.markActionResolvedWithoutRemote).toHaveBeenCalledWith('action-stale-terminal');
    expect(mockLoggerCategory.error).not.toHaveBeenCalledWith(
      'project:update 异常',
      expect.objectContaining({ projectId: 'p-stale-terminal' }),
    );
  });

  it('project:update should keep stale owner-handoff failures retryable', async () => {
    mockSyncService.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      projectPushed: true,
      failedTaskIds: ['task-owner-handoff'],
      retryEnqueued: [],
      failureReason: 'transient network failure',
    });
    mockActionQueueService.isQueueViewCurrent.mockReturnValueOnce(false);
    const handler = getProcessor('project:update');

    const result = await handler({
      id: 'action-owner-handoff-failure',
      payload: {
        project: { id: 'p-owner-handoff', syncSource: 'synced' },
        sourceUserId: 'test-user',
      },
    } as QueuedAction);

    expect(result).toEqual({
      outcome: 'failed',
      error: expect.objectContaining({
        code: 'SYNC_PROJECT_WRITE_FAILED',
        message: 'transient network failure',
        details: expect.objectContaining({
          actionType: 'project:update',
          projectId: 'p-owner-handoff',
        }),
      }),
    });
    expect(mockActionQueueService.markActionResolvedWithoutRemote).not.toHaveBeenCalledWith('action-owner-handoff-failure');
  });

  it('project:update should acknowledge RetryQueue handoff when the retry item is hidden under the source owner', async () => {
    const project = { id: 'p-hidden-owner-retry-transfer', syncSource: 'synced' };
    mockAuthService.currentUserId.mockReturnValue('old-owner');
    mockSyncService.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      projectPushed: false,
      retryEnqueued: ['project:p-hidden-owner-retry-transfer'],
      failureReason: 'offline sync deferred',
    });
    mockRetryQueueService.findItemForOwner.mockReturnValueOnce({
      type: 'project',
      data: project,
      sourceUserId: 'old-owner',
      taskIdsToDelete: [],
    });
    const handler = getProcessor('project:update');

    const result = await handler({
      payload: {
        project,
        sourceUserId: 'old-owner',
      },
    } as QueuedAction);

    expect(mockRetryQueueService.findItemForOwner).toHaveBeenCalledWith(
      'project',
      'p-hidden-owner-retry-transfer',
      'old-owner',
    );
    expect(result).toBe(true);
  });

  it('project:update should keep failing when persisted project retry payload loses deferred task deletes', async () => {
    mockSyncService.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      projectPushed: false,
      retryEnqueued: ['project:p-mismatched-delete-payload'],
      failureReason: 'offline sync deferred',
    });
    mockRetryQueueService.findItemForOwner.mockReturnValueOnce({
      type: 'project',
      data: { id: 'p-mismatched-delete-payload' },
      sourceUserId: 'test-user',
      taskIdsToDelete: ['task-delete-stale'],
    });
    const handler = getProcessor('project:update');

    const result = await handler({
      payload: {
        project: { id: 'p-mismatched-delete-payload', syncSource: 'synced' },
        sourceUserId: 'test-user',
        taskIdsToDelete: ['task-delete-current'],
      },
    } as QueuedAction);

    expect(result).toEqual({
      outcome: 'failed',
      error: expect.objectContaining({
        code: 'SYNC_PROJECT_WRITE_FAILED',
        message: 'offline sync deferred',
      }),
    });
  });

  it('project:update should keep classified failure when persisted project retry snapshot differs from the action snapshot', async () => {
    mockSyncService.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      projectPushed: false,
      retryEnqueued: ['project:p-mismatched-project-snapshot'],
      failureReason: 'offline sync deferred',
    });
    mockRetryQueueService.findItemForOwner.mockReturnValueOnce({
      type: 'project',
      data: { id: 'p-mismatched-project-snapshot', syncSource: 'synced', name: 'stale-project' },
      sourceUserId: 'test-user',
      taskIdsToDelete: ['task-delete-current'],
    });
    const handler = getProcessor('project:update');

    const result = await handler({
      payload: {
        project: { id: 'p-mismatched-project-snapshot', syncSource: 'synced', name: 'fresh-project' },
        sourceUserId: 'test-user',
        taskIdsToDelete: ['task-delete-current'],
      },
    } as QueuedAction);

    expect(result).toEqual({
      outcome: 'failed',
      error: expect.objectContaining({
        code: 'SYNC_PROJECT_WRITE_FAILED',
        message: 'offline sync deferred',
      }),
    });
  });

  it('project:update should persist conflict when remote snapshot is unavailable', async () => {
    mockSyncService.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      conflict: true,
    });
    const handler = getProcessor('project:update');

    const result = await handler({
      payload: {
        project: { id: 'p-1', syncSource: 'synced', version: 3, tasks: [], connections: [] },
        sourceUserId: 'test-user',
      },
    } as QueuedAction);

    expect(result).toBe(true);
    expect(mockConflictStorageService.saveConflict).toHaveBeenCalled();
    expect(mockToastService.warning).toHaveBeenCalled();
  });

  it('project:update should reload remote snapshot before persisting fallback conflict', async () => {
    const onConflict = vi.fn();
    service.setProjectConflictHandler(onConflict);
    mockSyncService.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      conflict: true,
    });
    mockSyncService.loadFullProjectOptimized.mockResolvedValueOnce({
      id: 'p-1',
      syncSource: 'synced',
      version: 4,
      tasks: [],
      connections: [],
    });
    const handler = getProcessor('project:update');

    const result = await handler({
      payload: {
        project: { id: 'p-1', syncSource: 'synced', version: 3, tasks: [], connections: [] },
        sourceUserId: 'test-user',
      },
    } as QueuedAction);

    expect(result).toBe(true);
    expect(onConflict).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p-1', version: 3 }),
      expect.objectContaining({ id: 'p-1', version: 4 }),
      'test-user',
      undefined,
    );
    expect(mockConflictStorageService.saveConflict).not.toHaveBeenCalled();
  });

  it('project:update 在队列视图失效后不应再向当前会话注入冲突回调', async () => {
    const onConflict = vi.fn();
    service.setProjectConflictHandler(onConflict);
    mockSyncService.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      conflict: true,
      remoteData: { id: 'p-stale', syncSource: 'synced' },
    });
    mockActionQueueService.isQueueViewCurrent.mockReturnValueOnce(false);
    const handler = getProcessor('project:update');

    const result = await handler({
      payload: {
        project: { id: 'p-stale', syncSource: 'synced' },
        sourceUserId: 'test-user',
      },
    } as QueuedAction);

    expect(result).toBe(true);
    expect(onConflict).not.toHaveBeenCalled();
    expect(mockConflictStorageService.saveConflict).not.toHaveBeenCalled();
  });

  it('project:create 在补拉远端快照期间若队列视图失效，不应再写入冲突存储', async () => {
    const onConflict = vi.fn();
    service.setProjectConflictHandler(onConflict);
    mockSyncService.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      conflict: true,
    });
    mockSyncService.loadFullProjectOptimized.mockResolvedValueOnce({
      id: 'p-create-stale',
      syncSource: 'synced',
      version: 2,
      tasks: [],
      connections: [],
    });
    mockActionQueueService.isQueueViewCurrent
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    const handler = getProcessor('project:create');

    const result = await handler({
      payload: {
        project: { id: 'p-create-stale', syncSource: 'synced', version: 1, tasks: [], connections: [] },
        sourceUserId: 'test-user',
      },
    } as QueuedAction);

    expect(result).toBe(true);
    expect(onConflict).not.toHaveBeenCalled();
    expect(mockConflictStorageService.saveConflict).not.toHaveBeenCalled();
    expect(mockToastService.warning).not.toHaveBeenCalledWith('检测到数据冲突', expect.any(String));
  });

  it('project:create should acknowledge failures already transferred to RetryQueue', async () => {
    mockSyncService.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      projectPushed: true,
      failedTaskIds: ['task-a'],
      retryEnqueued: ['task:task-a'],
      failureReason: 'project batch sync delegated remaining work to retry queue',
    });
    mockRetryQueueService.getItems.mockReturnValueOnce([]);
    const handler = getProcessor('project:create');

    const result = await handler({
      payload: {
        project: { id: 'p-create-retry-handoff', syncSource: 'synced' },
        sourceUserId: 'test-user',
      },
    } as QueuedAction);

    expect(result).toBe(true);
  });

  it('project:create should return a classified failure when failed entities were not transferred to RetryQueue', async () => {
    mockSyncService.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      projectPushed: true,
      failedTaskIds: ['task-a'],
      retryEnqueued: [],
      failureReason: 'permanent task failure',
    });
    const handler = getProcessor('project:create');

    const result = await handler({
      payload: {
        project: { id: 'p-create-permanent-failure', syncSource: 'synced' },
        sourceUserId: 'test-user',
      },
    } as QueuedAction);

    expect(result).toEqual({
      outcome: 'failed',
      error: expect.objectContaining({
        code: 'SYNC_PROJECT_WRITE_FAILED',
        message: 'permanent task failure',
        details: expect.objectContaining({
          reason: 'project-sync-failed',
          actionType: 'project:create',
          projectId: 'p-create-permanent-failure',
          failedTaskIds: ['task-a'],
        }),
      }),
    });
  });

  it('project:create should log info and defer retry without consuming queue failure budget when partialRetryHandoff is set', async () => {
    mockSyncService.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      projectPushed: true,
      failedTaskIds: ['task-a', 'task-b'],
      retryEnqueued: ['task:task-a'],
      partialRetryHandoff: true,
      failureReason: 'project batch sync partially delegated; some failures did not enter retry queue',
    });
    const handler = getProcessor('project:create');

    const result = await handler({
      payload: {
        project: { id: 'p-create-partial-handoff', syncSource: 'synced' },
        sourceUserId: 'test-user',
      },
    } as QueuedAction);

    expect(result).toEqual({
      outcome: 'defer-retry',
      error: expect.objectContaining({
        code: 'SYNC_RETRY_HANDOFF_PENDING',
        details: expect.objectContaining({
          reason: 'partial-retry-handoff',
          failedTaskCount: 2,
          failedConnectionCount: 0,
        }),
      }),
    });
    expect(mockActionQueueService.deferRetry).toHaveBeenCalledWith(expect.objectContaining({
      code: 'SYNC_RETRY_HANDOFF_PENDING',
    }));
    expect(mockLoggerCategory.info).toHaveBeenCalledWith(
      'project:create 部分转交 RetryQueue，等待下一轮回放',
      expect.objectContaining({
        projectId: 'p-create-partial-handoff',
        retryEnqueued: ['task:task-a'],
        failedTaskIds: ['task-a', 'task-b'],
      }),
    );
    expect(mockLoggerCategory.error).not.toHaveBeenCalled();
  });

  it('project:create should not acknowledge project metadata failures when pushProject did not enqueue RetryQueue', async () => {
    mockSyncService.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      projectPushed: false,
      retryEnqueued: [],
      failureReason: 'permission denied',
    });
    const handler = getProcessor('project:create');

    const result = await handler({
      payload: {
        project: { id: 'p-create-no-retry-transfer', syncSource: 'synced' },
        sourceUserId: 'test-user',
      },
    } as QueuedAction);

    expect(result).toEqual({
      outcome: 'failed',
      error: expect.objectContaining({
        code: 'SYNC_PROJECT_WRITE_FAILED',
        message: 'permission denied',
        details: expect.objectContaining({
          actionType: 'project:create',
          projectId: 'p-create-no-retry-transfer',
        }),
      }),
    });
  });

  it('project:create should persist conflict when remote snapshot is unavailable', async () => {
    mockSyncService.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      conflict: true,
    });
    const handler = getProcessor('project:create');

    const result = await handler({
      payload: {
        project: { id: 'p-create', syncSource: 'synced', version: 1, tasks: [], connections: [] },
        sourceUserId: 'test-user',
      },
    } as QueuedAction);

    expect(result).toBe(true);
    expect(mockConflictStorageService.saveConflict).toHaveBeenCalled();
    expect(mockToastService.warning).toHaveBeenCalled();
  });

  // ── project:delete ─────────────────────────────────────────

  it('project:delete should call deleteProjectFromCloud', async () => {
    const handler = getProcessor('project:delete');

    const result = await handler({
      entityId: 'p-1',
      payload: { projectId: 'p-1', userId: 'test-user', sourceUserId: 'test-user' },
    } as QueuedAction);

    expect(mockSyncService.deleteProjectFromCloud).toHaveBeenCalledWith('p-1', 'test-user');
    expect(result).toBe(true);
    expect(mockActionQueueService.settleProjectDeleteSuccessForOwner).toHaveBeenCalledWith('test-user', 'p-1', undefined);
    expect(mockRetryQueueService.removeByProjectId).toHaveBeenCalledWith('p-1');
  });

  it('project:delete should throw typed sync errors so queue can classify them', async () => {
    const handler = getProcessor('project:delete');
    mockSyncService.deleteProjectFromCloud.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'PERMISSION_DENIED',
        message: '没有权限执行此操作',
        details: { errorType: 'PermissionError', errorCode: '42501' },
      },
    });

    await expect(handler({
      entityId: 'p-1',
      payload: { projectId: 'p-1', userId: 'test-user', sourceUserId: 'test-user' },
    } as QueuedAction)).rejects.toThrow('PERMISSION_DENIED');
  });

  it('project:delete should move queue items from another user to dead letter', async () => {
    const handler = getProcessor('project:delete');

    const result = await handler({
      entityId: 'p-1',
      payload: { projectId: 'p-1', userId: 'other-user', sourceUserId: 'other-user' },
    } as QueuedAction);

    expect(result).toBe(true);
    expect(mockSyncService.deleteProjectFromCloud).not.toHaveBeenCalled();
    expect(mockActionQueueService.moveToDeadLetter).toHaveBeenCalled();
  });

  it('project:delete should move split owner hints to dead letter', async () => {
    const handler = getProcessor('project:delete');

    const result = await handler({
      entityId: 'p-1',
      payload: { projectId: 'p-1', userId: 'other-user', sourceUserId: 'test-user' },
    } as QueuedAction);

    expect(result).toBe(true);
    expect(mockSyncService.deleteProjectFromCloud).not.toHaveBeenCalled();
    expect(mockActionQueueService.moveToDeadLetter).toHaveBeenCalled();
  });

  it('project:create should discard queue items while running in local mode', async () => {
    mockAuthService.currentUserId.mockReturnValueOnce(AUTH_CONFIG.LOCAL_MODE_USER_ID);
    const handler = getProcessor('project:create');

    const result = await handler({ payload: { project: { id: 'p-local' } } });

    expect(result).toBe(true);
    expect(mockSyncService.saveProjectSmart).not.toHaveBeenCalled();
  });

  // ── task:create ────────────────────────────────────────────

  it('task:create should call pushTask', async () => {
    const handler = getProcessor('task:create');
    const task = { id: 't-1', title: 'Task' };

    const result = await handler({ payload: { task, projectId: 'p-1', sourceUserId: 'test-user' } });

    expect(mockSyncService.pushTask).toHaveBeenCalledWith(task, 'p-1', false, false, 'test-user', true);
    expect(result).toBe(true);
  });

  it('task:update should call pushTask with sourceUserId', async () => {
    const handler = getProcessor('task:update');
    const task = { id: 't-2', title: 'Task update' };

    const result = await handler({ payload: { task, projectId: 'p-2', sourceUserId: 'test-user' } } as QueuedAction);

    expect(mockSyncService.pushTask).toHaveBeenCalledWith(task, 'p-2', false, false, 'test-user', true);
    expect(result).toBe(true);
  });

  it('task:update should discard stale upserts when remote tombstone already exists', async () => {
    mockSyncService.pushTask.mockRejectedValueOnce(
      new PermanentFailureError(
        'Task tombstone prevented remote upsert',
        undefined,
        { operation: 'pushTaskTombstone', taskId: 'task-tombstoned', projectId: 'project-1' },
      ),
    );
    const handler = getProcessor('task:update');

    const result = await handler({
      payload: {
        task: { id: 'task-tombstoned' },
        projectId: 'project-1',
        sourceUserId: 'test-user',
      },
    } as QueuedAction);

    expect(result).toBe(true);
    expect(mockActionQueueService.markActionSyncedRemotely).not.toHaveBeenCalled();
    expect(mockActionQueueService.markActionResolvedWithoutRemote).toHaveBeenCalledOnce();
  });

  it('task:delete should call deleteTask with sourceUserId', async () => {
    const handler = getProcessor('task:delete');

    const result = await handler({
      payload: { taskId: 't-1', projectId: 'p-1', sourceUserId: 'test-user' },
    } as QueuedAction);

    expect(mockSyncService.deleteTask).toHaveBeenCalledWith('t-1', 'p-1', 'test-user');
    expect(result).toBe(true);
  });

  it('task:create should move queue items from another user to dead letter', async () => {
    const handler = getProcessor('task:create');

    const result = await handler({
      payload: {
        task: { id: 't-foreign', title: 'Foreign Task' },
        projectId: 'p-1',
        sourceUserId: 'other-user',
      },
    } as QueuedAction);

    expect(result).toBe(true);
    expect(mockSyncService.pushTask).not.toHaveBeenCalled();
    expect(mockActionQueueService.moveToDeadLetter).toHaveBeenCalled();
  });

  it('task:create should move legacy queue items without owner to dead letter', async () => {
    const handler = getProcessor('task:create');
    mockProjectStateService.getProject.mockReturnValueOnce({ id: 'p-1', syncSource: 'synced' });
    const action = {
      payload: {
        task: { id: 't-legacy', title: 'Legacy Task' },
        projectId: 'p-1',
      },
    } as QueuedAction;

    const result = await handler(action);

    expect(result).toBe(true);
    expect(mockSyncService.pushTask).not.toHaveBeenCalled();
    expect(mockActionQueueService.moveToDeadLetter).toHaveBeenCalledWith(
      action,
      expect.stringContaining('legacy 队列项缺少来源元数据')
    );
  });

  it('preference:update should move queue items from another user to dead letter', async () => {
    const handler = getProcessor('preference:update');

    const result = await handler({
      payload: {
        userId: 'other-user',
        preferences: { theme: 'dark' },
      },
    } as QueuedAction);

    expect(result).toBe(true);
    expect(mockSyncService.saveUserPreferences).not.toHaveBeenCalled();
    expect(mockActionQueueService.moveToDeadLetter).toHaveBeenCalled();
  });

  it('preference:update should call saveUserPreferences with explicit source user', async () => {
    const handler = getProcessor('preference:update');

    const result = await handler({
      payload: {
        userId: 'test-user',
        sourceUserId: 'test-user',
        preferences: { theme: 'dark' },
      },
    } as QueuedAction);

    expect(result).toBe(true);
    expect(mockSyncService.saveUserPreferences).toHaveBeenCalledWith('test-user', { theme: 'dark' });
  });

  // ── focus-session:create ───────────────────────────────────

  it('focus-session:create should return result.ok', async () => {
    const handler = getProcessor('focus-session:create');
    const record = { userId: 'test-user', sessionId: 's-1' };

    const result = await handler({ payload: { record } });

    expect(mockSyncService.saveFocusSession).toHaveBeenCalledWith(record);
    expect(result).toBe(true);
  });

  it('focus-session:create should move queue items from another user to dead letter', async () => {
    const handler = getProcessor('focus-session:create');

    const result = await handler({
      payload: {
        record: { userId: 'other-user', sessionId: 's-foreign' },
        sourceUserId: 'other-user',
      },
    } as QueuedAction);

    expect(result).toBe(true);
    expect(mockSyncService.saveFocusSession).not.toHaveBeenCalled();
    expect(mockActionQueueService.moveToDeadLetter).toHaveBeenCalled();
  });

  // ── routine-task:create ────────────────────────────────────

  it('routine-task:create should return result.ok', async () => {
    const handler = getProcessor('routine-task:create');
    const routineTask = { id: 'rt-1', title: 'Routine' };

    const result = await handler({ payload: { userId: 'test-user', routineTask } });

    expect(mockSyncService.upsertRoutineTask).toHaveBeenCalledWith('test-user', routineTask);
    expect(result).toBe(true);
  });

  it('routine-task:create should move queue items from another user to dead letter', async () => {
    const handler = getProcessor('routine-task:create');

    const result = await handler({
      payload: {
        userId: 'other-user',
        sourceUserId: 'other-user',
        routineTask: { id: 'rt-foreign', title: 'Foreign Routine' },
      },
    } as QueuedAction);

    expect(result).toBe(true);
    expect(mockSyncService.upsertRoutineTask).not.toHaveBeenCalled();
    expect(mockActionQueueService.moveToDeadLetter).toHaveBeenCalled();
  });

  // ── routine-completion:create ──────────────────────────────

  it('routine-completion:create should return result.ok', async () => {
    const handler = getProcessor('routine-completion:create');
    const completion = { userId: 'test-user', routineTaskId: 'rt-1' };

    const result = await handler({ payload: { completion } });

    expect(mockSyncService.incrementRoutineCompletion).toHaveBeenCalledWith(completion);
    expect(result).toBe(true);
  });

  it('routine-completion:create should move queue items from another user to dead letter', async () => {
    const handler = getProcessor('routine-completion:create');

    const result = await handler({
      payload: {
        completion: { userId: 'other-user', routineTaskId: 'rt-foreign' },
        sourceUserId: 'other-user',
      },
    } as QueuedAction);

    expect(result).toBe(true);
    expect(mockSyncService.incrementRoutineCompletion).not.toHaveBeenCalled();
    expect(mockActionQueueService.moveToDeadLetter).toHaveBeenCalled();
  });

  // ── Error handling ─────────────────────────────────────────

  it('processor should catch exceptions and return false', async () => {
    mockSyncService.pushTask.mockRejectedValueOnce(new Error('network error'));
    const handler = getProcessor('task:create');

      const result = await handler({
        payload: { task: { id: 't-1' }, projectId: 'p-1', sourceUserId: 'test-user' },
      });

    expect(result).toBe(false);
    expect(mockLoggerCategory.error).toHaveBeenCalled();
  });
});
