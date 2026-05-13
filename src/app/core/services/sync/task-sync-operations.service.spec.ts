/**
 * TaskSyncOperationsService 单元测试
 */

import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TaskSyncOperationsService } from './task-sync-operations.service';
import { SupabaseClientService } from '../../../../services/supabase-client.service';
import { LoggerService } from '../../../../services/logger.service';
import { ToastService } from '../../../../services/toast.service';
import { RequestThrottleService } from '../../../../services/request-throttle.service';
import { ClockSyncService } from '../../../../services/clock-sync.service';
import { SyncOperationHelperService } from './sync-operation-helper.service';
import { SessionManagerService } from './session-manager.service';
import { TombstoneService } from './tombstone.service';
import { ProjectDataService } from './project-data.service';
import { RetryQueueService } from './retry-queue.service';
import { SyncStateService } from './sync-state.service';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import { SyncRpcClientService, type SyncRpcResult } from '../../../../services/sync-rpc-client.service';
import { Task } from '../../../../models';
import { TaskStore } from '../../state/stores';
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

function createSyncRpcResult(overrides: Partial<SyncRpcResult> = {}): SyncRpcResult {
  return {
    status: 'applied',
    raw: {},
    ...overrides,
  };
}

const upsertTaskRpcMock = vi.fn<SyncRpcClientService['upsertTask']>();
const deleteTasksRpcMock = vi.fn<SyncRpcClientService['deleteTasks']>();
const checkProtocolMock = vi.fn<SyncRpcClientService['checkProtocol']>();
const isSyncRpcFeatureEnabledMock = vi.fn(() => false);
const isSyncRpcClientRejectedMock = vi.fn(() => false);

describe('TaskSyncOperationsService', () => {
  let service: TaskSyncOperationsService;
  let upsertPayload: Record<string, unknown> | null;
  let taskFreshnessResult: { data: { id: string; updated_at: string | null; deleted_at: string | null } | null; error: unknown | null };
  let taskInsertResult: { data: { updated_at: string } | null; error: unknown | null };
  let taskUpdateResult: { data: { updated_at: string } | null; error: unknown | null };
  const mockProjectDataService = {
    rowToTask: vi.fn((row: Task) => row),
  };
  const mockTombstoneService = {
    addLocalTombstones: vi.fn(),
    invalidateCache: vi.fn(),
    deleteAttachmentFilesFromStorage: vi.fn().mockResolvedValue(undefined),
    getTombstonesWithCache: vi.fn().mockResolvedValue({ data: [], error: null }),
    getLocalTombstones: vi.fn(() => new Set<string>()),
    getLocalTombstoneTimestamp: vi.fn(() => undefined),
    clearLocalTombstones: vi.fn(),
    shouldMaterializeTaskDeletion: vi.fn((updatedAt: string | undefined | null, tombstoneTimestamp?: number) => {
      if (tombstoneTimestamp === undefined) {
        return false;
      }
      if (!updatedAt) {
        return true;
      }
      return new Date(updatedAt).getTime() <= tombstoneTimestamp;
    }),
  };
  const mockRetryQueue = {
    checkCircuitBreaker: vi.fn(() => true),
    add: vi.fn(() => true),
    length: 0,
    recordCircuitSuccess: vi.fn(),
    recordCircuitFailure: vi.fn(),
    removeByEntities: vi.fn((_entityType: string, _entityIds: string[]): string[] => []),
    removeConnectionsReferencingTasks: vi.fn((_projectId: string, _taskIds: string[]): string[] => []),
  };
  const mockSyncRpcClient: {
    isFeatureEnabled: typeof isSyncRpcFeatureEnabledMock;
    isClientRejected: typeof isSyncRpcClientRejectedMock;
    checkProtocol: typeof checkProtocolMock;
    upsertTask: typeof upsertTaskRpcMock;
    deleteTasks: typeof deleteTasksRpcMock;
  } = {
    isFeatureEnabled: isSyncRpcFeatureEnabledMock,
    isClientRejected: isSyncRpcClientRejectedMock,
    checkProtocol: checkProtocolMock,
    upsertTask: upsertTaskRpcMock,
    deleteTasks: deleteTasksRpcMock,
  };
  const mockSyncState = {
    isSessionExpired: vi.fn(() => false),
    advanceLastSyncTimeIfIdle: vi.fn(() => true),
    setPendingCount: vi.fn(),
    setSyncError: vi.fn(),
    setLastSyncTime: vi.fn(),
  };
  const mockTaskStore = {
    getTask: vi.fn(),
    setTask: vi.fn(),
  };
  const mockSessionManager = {
    tryRefreshSession: vi.fn(async () => false),
    handleSessionExpired: vi.fn(() => {
      throw new Error('Session expired');
    }),
    isSessionExpiredError: vi.fn((_error?: any) => false),
    handleAuthErrorWithRefresh: vi.fn(async () => false),
    isRlsPolicyViolation: vi.fn((_error?: any) => false),
  };

  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const mockClient = {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: { user: { id: 'user-1' } } } })),
    },
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      if (fn === 'purge_tasks_v3') {
        return {
          data: { purged_count: 1, attachment_paths: [] },
          error: null,
          args,
        };
      }

      if (fn === 'purge_tasks_v2') {
        return { data: 1, error: null, args };
      }

      throw new Error(`Unexpected rpc: ${fn}`);
    }),
    from: vi.fn((table: string) => {
      if (table === 'task_tombstones') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn(async () => ({ data: null, error: null })),
            })),
          })),
        };
      }

      if (table === 'tasks') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                maybeSingle: vi.fn(async () => taskFreshnessResult),
              })),
            })),
          })),
          update: vi.fn((payload: Record<string, unknown>) => {
            upsertPayload = payload;
            return {
              eq: vi.fn(() => ({
                eq: vi.fn(() => ({
                  eq: vi.fn(() => ({
                    select: vi.fn(() => ({
                      maybeSingle: vi.fn(async () => taskUpdateResult),
                    })),
                  })),
                })),
              })),
            } as unknown as Record<string, unknown>;
          }),
          insert: vi.fn((payload: Record<string, unknown>) => {
            upsertPayload = payload;
            return {
              select: vi.fn(() => ({
                maybeSingle: vi.fn(async () => taskInsertResult),
              })),
            };
          }),
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    }) as any,
  };

  beforeEach(() => {
    upsertPayload = null;
    vi.clearAllMocks();
    resetBrowserNetworkSuspensionTrackingForTests();
    setVisibilityState('visible');
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(false);
    mockSyncRpcClient.isClientRejected.mockReturnValue(false);
    mockSyncRpcClient.checkProtocol.mockImplementation(async () => null);
    taskFreshnessResult = { data: null, error: null };
    taskInsertResult = { data: { updated_at: new Date().toISOString() }, error: null };
    taskUpdateResult = { data: { updated_at: new Date().toISOString() }, error: null };
    const defaultUpsertTaskRpcResult: SyncRpcResult = createSyncRpcResult({ entityId: 'task-1' });
    mockSyncRpcClient.upsertTask.mockImplementation(async () => defaultUpsertTaskRpcResult);
    mockTaskStore.getTask.mockReturnValue(undefined);
    mockTaskStore.setTask.mockReset();
    const defaultDeleteTasksRpcResult: SyncRpcResult = createSyncRpcResult({
      entityId: 'project-1',
      affectedCount: 1,
      attachmentPaths: [] as string[],
    });
    mockSyncRpcClient.deleteTasks.mockImplementation(async () => defaultDeleteTasksRpcResult);
    mockClient.rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
      if (fn === 'purge_tasks_v3') {
        return {
          data: { purged_count: 1, attachment_paths: [] },
          error: null,
          args,
        };
      }

      if (fn === 'purge_tasks_v2') {
        return { data: 1, error: null, args };
      }

      throw new Error(`Unexpected rpc: ${fn}`);
    });

    TestBed.configureTestingModule({
      providers: [
        TaskSyncOperationsService,
        {
          provide: SupabaseClientService,
          useValue: {
            isConfigured: true,
            client: vi.fn(() => mockClient),
          },
        },
        {
          provide: LoggerService,
          useValue: {
            category: vi.fn(() => mockLogger),
          },
        },
        { provide: ToastService, useValue: { warning: vi.fn() } },
        {
          provide: RequestThrottleService,
          useValue: {
            execute: vi.fn(async (_key: string, fn: () => Promise<void>) => await fn()),
          },
        },
        {
          provide: ClockSyncService,
          useValue: {
            isLocalNewer: vi.fn((left: string, right: string) => new Date(left).getTime() > new Date(right).getTime()),
            compareTimestamps: vi.fn((left: string, right: string) => new Date(left).getTime() - new Date(right).getTime()),
            ensureSynced: vi.fn().mockResolvedValue({ reliable: true }),
            recordServerTimestamp: vi.fn(),
          },
        },
        { provide: TaskStore, useValue: mockTaskStore },
        {
          provide: SyncOperationHelperService,
          useValue: {
            retryWithBackoff: vi.fn(async (fn: () => Promise<void>) => await fn()),
          },
        },
        {
          provide: SessionManagerService,
          useValue: mockSessionManager,
        },
        {
          provide: TombstoneService,
          useValue: mockTombstoneService,
        },
        { provide: ProjectDataService, useValue: mockProjectDataService },
        {
          provide: RetryQueueService,
          useValue: mockRetryQueue,
        },
        { provide: SyncRpcClientService, useValue: mockSyncRpcClient },
        {
          provide: SyncStateService,
          useValue: mockSyncState,
        },
        {
          provide: SentryLazyLoaderService,
          useValue: {
            captureException: vi.fn(),
            captureMessage: vi.fn(),
          },
        },
      ],
    });

    service = TestBed.inject(TaskSyncOperationsService);
  });

  it('pushTask 在浏览器网络挂起导致 session 暂不可用时应延后而非标记过期', async () => {
    const task: Task = {
      id: 'task-browser-suspended-session',
      title: '任务',
      content: '内容',
      stage: 0,
      parentId: null,
      order: 0,
      rank: 10000,
      status: 'active',
      x: 0,
      y: 0,
      displayId: 'T-S',
      createdDate: new Date().toISOString(),
      deletedAt: null,
    };
    setVisibilityState('hidden');
    mockClient.auth.getSession.mockResolvedValueOnce({ data: { session: null } } as any);
    mockSessionManager.tryRefreshSession.mockResolvedValueOnce(false);

    const result = await service.pushTask(task, 'project-1', false, false, 'user-1');

    expect(result).toBe(false);
    expect(mockSessionManager.handleSessionExpired).not.toHaveBeenCalled();
    expect(mockRetryQueue.add).toHaveBeenCalledWith('task', 'upsert', task, 'project-1', 'user-1');
  });

  it('重试队列回放 task upsert 遇到浏览器网络挂起时应抛出延后错误，避免消耗 retry budget', async () => {
    const task: Task = {
      id: 'task-browser-suspended-replay',
      title: '任务',
      content: '内容',
      stage: 0,
      parentId: null,
      order: 0,
      rank: 10000,
      status: 'active',
      x: 0,
      y: 0,
      displayId: 'T-SR',
      createdDate: new Date().toISOString(),
      deletedAt: null,
    };
    setVisibilityState('hidden');
    mockClient.auth.getSession.mockResolvedValueOnce({ data: { session: null } } as any);
    mockSessionManager.tryRefreshSession.mockResolvedValueOnce(false);

    await expect(service.pushTask(task, 'project-1', false, true, 'user-1'))
      .rejects.toMatchObject({ name: 'BrowserNetworkSuspendedError' });
    expect(mockRetryQueue.add).not.toHaveBeenCalled();
  });

  it('pushTaskPosition 在浏览器网络挂起导致 session 暂不可用时不应标记过期', async () => {
    setVisibilityState('hidden');
    mockClient.auth.getSession.mockResolvedValueOnce({ data: { session: null } } as any);
    mockSessionManager.tryRefreshSession.mockResolvedValueOnce(false);

    const result = await service.pushTaskPosition('task-position-suspended', 10, 20, 'project-1', undefined, 'user-1');

    expect(result).toBe(false);
    expect(mockSessionManager.handleSessionExpired).not.toHaveBeenCalled();
  });

  it('pushTaskPosition 在 sync RPC 开启且有任务快照时应走受 CAS 保护的 task upsert', async () => {
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    const rpcResult: SyncRpcResult = createSyncRpcResult({
      entityId: 'task-position-rpc',
      serverUpdatedAt: '2026-04-30T08:00:00.000Z',
    });
    mockSyncRpcClient.upsertTask.mockImplementationOnce(async () => rpcResult);
    const fallbackTask = {
      id: 'task-position-rpc',
      title: 'Position task',
      content: 'Position task',
      x: 1,
      y: 2,
      updatedAt: '2026-04-30T07:00:00.000Z',
    } as Task;
    mockTaskStore.getTask.mockReturnValue({ ...fallbackTask });

    const result = await service.pushTaskPosition(
      'task-position-rpc',
      10,
      20,
      'project-1',
      fallbackTask,
      'user-1',
    );

    expect(result).toBe(true);
    expect(mockSyncRpcClient.upsertTask).toHaveBeenCalledWith(expect.objectContaining({
      task: expect.objectContaining({
        id: 'task-position-rpc',
        x: 10,
        y: 20,
      }),
      projectId: 'project-1',
      baseUpdatedAt: '2026-04-30T07:00:00.000Z',
    }));
    expect(mockClient.from).not.toHaveBeenCalledWith('tasks');
    expect(fallbackTask.x).toBe(10);
    expect(fallbackTask.y).toBe(20);
    expect(fallbackTask.updatedAt).toBe('2026-04-30T08:00:00.000Z');
    expect(mockTaskStore.setTask).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'task-position-rpc',
        x: 10,
        y: 20,
        updatedAt: '2026-04-30T08:00:00.000Z',
      }),
      'project-1',
    );
  });

  it('pushTaskPosition 直接更新成功后应把服务端 canonical updated_at 写回 fallback 任务', async () => {
    const serverUpdatedAt = '2026-04-30T08:10:00.000Z';
    mockClient.from.mockImplementationOnce((table: string) => {
      if (table !== 'tasks') {
        throw new Error(`Unexpected table: ${table}`);
      }

      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn(async () => ({
                data: {
                  id: 'task-position-direct',
                  updated_at: '2026-04-30T07:00:00.000Z',
                  deleted_at: null,
                },
                error: null,
              })),
            })),
          })),
        })),
      };
    });
    mockClient.from.mockImplementationOnce((table: string) => {
      if (table !== 'tasks') {
        throw new Error(`Unexpected table: ${table}`);
      }

      return {
        update: vi.fn((payload: Record<string, unknown>) => ({
          eq: vi.fn((firstColumn: string, firstValue: string) => ({
            eq: vi.fn((secondColumn: string, secondValue: string) => ({
              eq: vi.fn((thirdColumn: string, thirdValue: string) => ({
                select: vi.fn(async () => ({
                  data:
                    firstColumn === 'id'
                    && firstValue === 'task-position-direct'
                    && secondColumn === 'project_id'
                    && secondValue === 'project-1'
                    && thirdColumn === 'updated_at'
                    && thirdValue === '2026-04-30T07:00:00.000Z'
                    && payload['x'] === 10
                    && payload['y'] === 20
                      ? [{ updated_at: serverUpdatedAt }]
                      : [],
                  error: null,
                })),
              })),
            })),
          })),
        })),
      };
    });
    const fallbackTask = {
      id: 'task-position-direct',
      title: 'Position task',
      content: 'Position task',
      x: 1,
      y: 2,
      updatedAt: '2026-04-30T07:00:00.000Z',
    } as Task;
    mockTaskStore.getTask.mockReturnValueOnce({ ...fallbackTask });

    const result = await service.pushTaskPosition(
      'task-position-direct',
      10,
      20,
      'project-1',
      fallbackTask,
      'user-1',
    );

    expect(result).toBe(true);
    expect(fallbackTask.x).toBe(10);
    expect(fallbackTask.y).toBe(20);
    expect(fallbackTask.updatedAt).toBe(serverUpdatedAt);
    expect(mockTaskStore.setTask).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'task-position-direct',
        x: 10,
        y: 20,
        updatedAt: serverUpdatedAt,
      }),
      'project-1',
    );
  });

  it('重试队列回放 task delete 遇到浏览器网络挂起时应抛出延后错误，避免消耗 retry budget', async () => {
    mockClient.auth.getSession.mockRejectedValueOnce(createBrowserNetworkSuspendedError());

    await expect(service.deleteTask('task-delete-suspended', 'project-1', 'user-1', true))
      .rejects.toMatchObject({ name: 'BrowserNetworkSuspendedError' });
    expect(mockRetryQueue.add).not.toHaveBeenCalled();
  });

  it('pushTask 应将 parking_meta 上行到 Supabase', async () => {
    const parkingMeta = {
      state: 'parked' as const,
      parkedAt: new Date().toISOString(),
      lastVisitedAt: new Date().toISOString(),
      contextSnapshot: null,
      reminder: null,
      pinned: false,
    };

    const task: Task = {
      id: 'task-1',
      title: '任务',
      content: '内容',
      stage: 0,
      parentId: null,
      order: 0,
      rank: 10000,
      status: 'active',
      x: 0,
      y: 0,
      displayId: 'T-1',
      createdDate: new Date().toISOString(),
      deletedAt: null,
      parkingMeta,
    };

    const result = await service.pushTask(task, 'project-1');

    expect(result).toBe(true);
    expect(upsertPayload).toBeTruthy();
    expect(upsertPayload?.['parking_meta']).toEqual(parkingMeta);
  });

  it('pushTask 直接 upsert 成功后应把服务端 canonical updated_at 写回本地任务', async () => {
    const serverUpdatedAt = '2026-04-30T08:15:00.000Z';
    mockClient.from.mockImplementation((table: string) => {
      if (table === 'task_tombstones') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn(async () => ({ data: null, error: null })),
            })),
          })),
        };
      }

      if (table === 'tasks') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                maybeSingle: vi.fn(async () => ({ data: null, error: null })),
              })),
            })),
          })),
          insert: vi.fn((payload: Record<string, unknown>) => {
            upsertPayload = payload;
            return {
              select: vi.fn(() => ({
                maybeSingle: vi.fn(async () => ({
                  data: { updated_at: serverUpdatedAt },
                  error: null,
                })),
              })),
            };
          }),
          update: vi.fn(),
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    });
    const task: Task = {
      id: 'task-canonical-direct',
      title: '任务',
      content: '内容',
      stage: 0,
      parentId: null,
      order: 0,
      rank: 10000,
      status: 'active',
      x: 0,
      y: 0,
      displayId: 'T-CD',
      createdDate: '2026-04-30T08:00:00.000Z',
      updatedAt: '2026-04-30T08:00:00.000Z',
      deletedAt: null,
    };
    mockTaskStore.getTask.mockReturnValueOnce({ ...task });

    const result = await service.pushTask(task, 'project-1');

    expect(result).toBe(true);
    expect(task.updatedAt).toBe(serverUpdatedAt);
    expect(mockTaskStore.setTask).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'task-canonical-direct',
        updatedAt: serverUpdatedAt,
      }),
      'project-1',
    );
  });

  it('pushTask 直接 upsert 前若远端任务更新更晚则应抛出版本冲突并阻止覆盖', async () => {
    mockClient.from.mockImplementation((table: string) => {
      if (table === 'task_tombstones') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn(async () => ({ data: null, error: null })),
            })),
          })),
        };
      }

      if (table === 'tasks') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                maybeSingle: vi.fn(async () => ({
                  data: {
                    id: 'task-direct-conflict',
                    updated_at: '2026-04-30T09:00:00.000Z',
                    deleted_at: null,
                  },
                  error: null,
                })),
              })),
            })),
          })),
          insert: vi.fn((payload: Record<string, unknown>) => {
            upsertPayload = payload;
            return {
              select: vi.fn(() => ({
                maybeSingle: vi.fn(async () => ({
                  data: { updated_at: new Date().toISOString() },
                  error: null,
                })),
              })),
            };
          }),
          update: vi.fn(),
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    });

    const task: Task = {
      id: 'task-direct-conflict',
      title: '任务',
      content: '内容',
      stage: 0,
      parentId: null,
      order: 0,
      rank: 10000,
      status: 'active',
      x: 0,
      y: 0,
      displayId: 'T-DCF',
      createdDate: '2026-04-30T08:00:00.000Z',
      updatedAt: '2026-04-30T08:00:00.000Z',
      deletedAt: null,
    };

    await expect(service.pushTask(task, 'project-1')).rejects.toBeInstanceOf(PermanentFailureError);

    expect(upsertPayload).toBeNull();
    expect(mockRetryQueue.add).not.toHaveBeenCalled();
    expect(mockRetryQueue.recordCircuitSuccess).not.toHaveBeenCalled();
  });

  it('pushTask 直接写入在 preflight 后被并发更新抢先时应以版本冲突失败收口', async () => {
    taskFreshnessResult = {
      data: {
        id: 'task-direct-cas-miss',
        updated_at: '2026-04-30T08:00:00.000Z',
        deleted_at: null,
      },
      error: null,
    };
    taskUpdateResult = {
      data: null,
      error: null,
    };

    const task: Task = {
      id: 'task-direct-cas-miss',
      title: '任务',
      content: '内容',
      stage: 0,
      parentId: null,
      order: 0,
      rank: 10000,
      status: 'active',
      x: 0,
      y: 0,
      displayId: 'T-DCM',
      createdDate: '2026-04-30T08:00:00.000Z',
      updatedAt: '2026-04-30T08:00:00.000Z',
      deletedAt: null,
    };

    await expect(service.pushTask(task, 'project-1')).rejects.toBeInstanceOf(PermanentFailureError);

    expect(mockRetryQueue.add).not.toHaveBeenCalled();
    expect(mockRetryQueue.recordCircuitSuccess).not.toHaveBeenCalled();
  });

  it('pushTask 直接 insert 在写回未返回行时应以版本冲突失败收口，避免 406 冒泡', async () => {
    taskFreshnessResult = { data: null, error: null };
    taskInsertResult = { data: null, error: null };

    const task: Task = {
      id: 'task-direct-insert-empty',
      title: '任务',
      content: '内容',
      stage: 0,
      parentId: null,
      order: 0,
      rank: 10000,
      status: 'active',
      x: 0,
      y: 0,
      displayId: 'T-DIE',
      createdDate: '2026-04-30T08:00:00.000Z',
      updatedAt: '2026-04-30T08:00:00.000Z',
      deletedAt: null,
    };

    await expect(service.pushTask(task, 'project-1')).rejects.toBeInstanceOf(PermanentFailureError);

    expect(upsertPayload).not.toBeNull();
    expect(mockRetryQueue.add).not.toHaveBeenCalled();
    expect(mockRetryQueue.recordCircuitSuccess).not.toHaveBeenCalled();
  });

  it('pushTask 在 sync RPC flag 开启时应走 RPC/CAS 而不是直接 table upsert', async () => {
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    const task: Task = {
      id: 'task-rpc',
      title: '任务',
      content: '内容',
      stage: 0,
      parentId: null,
      order: 0,
      rank: 10000,
      status: 'active',
      x: 0,
      y: 0,
      displayId: 'T-RPC',
      createdDate: new Date().toISOString(),
      updatedAt: '2026-04-30T00:00:00.000Z',
      deletedAt: null,
    };

    const result = await service.pushTask(task, 'project-1');

    expect(result).toBe(true);
    expect(mockSyncRpcClient.upsertTask).toHaveBeenCalledWith(expect.objectContaining({
      operationId: expect.any(String),
      task,
      projectId: 'project-1',
      baseUpdatedAt: '2026-04-30T00:00:00.000Z',
    }));
    expect(upsertPayload).toBeNull();
    expect(mockRetryQueue.recordCircuitSuccess).toHaveBeenCalled();
  });

  it('pushTask 在 feature 默认关闭但 probe 成功时仍应走 sync_upsert_task', async () => {
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(false);
    mockSyncRpcClient.checkProtocol.mockImplementationOnce(async () => {
      mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
      return { minProtocolVersion: 1, deploymentEpoch: 0 };
    });
    const task: Task = {
      id: 'task-rpc-probed',
      title: '任务',
      content: '内容',
      stage: 0,
      parentId: null,
      order: 0,
      rank: 10000,
      status: 'active',
      x: 0,
      y: 0,
      displayId: 'T-RPCP',
      createdDate: new Date().toISOString(),
      updatedAt: '2026-05-14T00:00:00.000Z',
      deletedAt: null,
    };

    const result = await service.pushTask(task, 'project-1');

    expect(result).toBe(true);
    expect(mockSyncRpcClient.checkProtocol).toHaveBeenCalledTimes(1);
    expect(mockSyncRpcClient.upsertTask).toHaveBeenCalledWith(expect.objectContaining({
      task,
      projectId: 'project-1',
      baseUpdatedAt: '2026-05-14T00:00:00.000Z',
    }));
    expect(upsertPayload).toBeNull();
  });

  it('pushTask 在 probe 判定客户端已过期时不应回退直接 table upsert', async () => {
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(false);
    mockSyncRpcClient.checkProtocol.mockImplementationOnce(async () => {
      mockSyncRpcClient.isClientRejected.mockReturnValue(true);
      return { minProtocolVersion: 99, deploymentEpoch: 99 };
    });
    const task: Task = {
      id: 'task-rpc-rejected',
      title: '任务',
      content: '内容',
      stage: 0,
      parentId: null,
      order: 0,
      rank: 10000,
      status: 'active',
      x: 0,
      y: 0,
      displayId: 'T-RPCR',
      createdDate: new Date().toISOString(),
      updatedAt: '2026-05-14T00:00:00.000Z',
      deletedAt: null,
    };

    const result = await service.pushTask(task, 'project-1', false, false, 'user-1');

    expect(result).toBe(false);
    expect(mockSyncRpcClient.checkProtocol).toHaveBeenCalledTimes(1);
    expect(mockSyncRpcClient.upsertTask).not.toHaveBeenCalled();
    expect(upsertPayload).toBeNull();
    expect(mockSyncState.setSyncError).toHaveBeenCalledWith('当前客户端同步协议已过期，请刷新后重试');
    expect(mockRetryQueue.add).not.toHaveBeenCalled();
  });

  it('pushTask sync RPC 成功后应把服务端 canonical updated_at 写回本地任务', async () => {
    const serverUpdatedAt = '2026-04-30T08:20:00.000Z';
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    const rpcResult: SyncRpcResult = createSyncRpcResult({
      entityId: 'task-rpc-canonical',
      serverUpdatedAt,
    });
    mockSyncRpcClient.upsertTask.mockImplementationOnce(async () => rpcResult);
    const task: Task = {
      id: 'task-rpc-canonical',
      title: '任务',
      content: '内容',
      stage: 0,
      parentId: null,
      order: 0,
      rank: 10000,
      status: 'active',
      x: 0,
      y: 0,
      displayId: 'T-RPCC',
      createdDate: '2026-04-30T08:00:00.000Z',
      updatedAt: '2026-04-30T08:00:00.000Z',
      deletedAt: null,
    };

    const result = await service.pushTask(task, 'project-1');

    expect(result).toBe(true);
    expect(task.updatedAt).toBe(serverUpdatedAt);
  });

  it('pushTask sync RPC 遇到 remote-newer 时应保留本地意图并阻止直接 table upsert', async () => {
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    const rpcResult: SyncRpcResult = createSyncRpcResult({
      status: 'remote-newer',
      remoteUpdatedAt: '2026-04-30T00:01:00.000Z',
    });
    mockSyncRpcClient.upsertTask.mockImplementationOnce(async () => rpcResult);
    const task: Task = {
      id: 'task-rpc-remote-newer',
      title: '任务',
      content: '内容',
      stage: 0,
      parentId: null,
      order: 0,
      rank: 10000,
      status: 'active',
      x: 0,
      y: 0,
      displayId: 'T-RPC2',
      createdDate: new Date().toISOString(),
      updatedAt: '2026-04-30T00:00:00.000Z',
      deletedAt: null,
    };

    const result = await service.pushTask(task, 'project-1', false, false, 'user-1');

    expect(result).toBe(false);
    expect(upsertPayload).toBeNull();
    expect(mockRetryQueue.add).toHaveBeenCalledWith('task', 'upsert', task, 'project-1', 'user-1');
    expect(mockRetryQueue.recordCircuitSuccess).not.toHaveBeenCalled();
  });

  it('sourceUserId 与当前会话不匹配时应拒绝写云端并按原 owner 入队', async () => {
    const task: Task = {
      id: 'task-owner-mismatch',
      title: '任务 owner mismatch',
      content: '内容',
      stage: 0,
      parentId: null,
      order: 0,
      rank: 10000,
      status: 'active',
      x: 0,
      y: 0,
      displayId: 'T-2',
      createdDate: new Date().toISOString(),
      deletedAt: null,
    };
    mockClient.auth.getSession.mockResolvedValueOnce({
      data: { session: { user: { id: 'user-2' } } },
    });

    const result = await service.pushTask(task, 'project-1', false, false, 'user-1');

    expect(result).toBe(false);
    expect(upsertPayload).toBeNull();
    expect(mockRetryQueue.add).toHaveBeenCalledWith('task', 'upsert', task, 'project-1', 'user-1');
  });

  it('deleteTask 在 sourceUserId 与当前会话不匹配时应拒绝写云端并按原 owner 入队', async () => {
    mockClient.auth.getSession.mockResolvedValueOnce({
      data: { session: { user: { id: 'user-2' } } },
    });

    const result = await service.deleteTask('task-delete-owner-mismatch', 'project-1', 'user-1');

    expect(result).toBe(false);
    expect(mockRetryQueue.add).toHaveBeenCalledWith(
      'task',
      'delete',
      { id: 'task-delete-owner-mismatch' },
      'project-1',
      'user-1',
    );
  });

  it('deleteTask 应优先调用带 project_id 的 purge_tasks_v3', async () => {
    const result = await service.deleteTask('task-delete-scoped', 'project-1', 'user-1');

    expect(result).toBe(true);
    expect(mockClient.rpc).toHaveBeenCalledWith('purge_tasks_v3', {
      p_project_id: 'project-1',
      p_task_ids: ['task-delete-scoped'],
    });
  });

  it('purgeTasksFromCloud 成功后应清理引用已删任务的连接重试项', async () => {
    mockRetryQueue.removeByEntities.mockReturnValueOnce(['task-delete-scoped']);
    mockRetryQueue.removeConnectionsReferencingTasks.mockReturnValueOnce(['conn-stale-a']);

    const result = await service.purgeTasksFromCloud('project-1', ['task-delete-scoped'], 'user-1');

    expect(result).toBe(true);
    expect(mockRetryQueue.removeByEntities).toHaveBeenCalledWith('task', ['task-delete-scoped']);
    expect(mockRetryQueue.removeConnectionsReferencingTasks).toHaveBeenCalledWith('project-1', ['task-delete-scoped']);
  });

  it('purgeTasksFromCloud 在 sync RPC 开启时应走 sync_delete_tasks 并清理附件与依赖重试项', async () => {
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    const rpcResult: SyncRpcResult = createSyncRpcResult({
      entityId: 'project-1',
      affectedCount: 2,
      attachmentPaths: ['user/project/task/file.png'],
    });
    mockSyncRpcClient.deleteTasks.mockImplementationOnce(async () => rpcResult);

    const result = await service.purgeTasksFromCloud('project-1', ['task-rpc-a', 'task-rpc-b'], 'user-1');

    expect(result).toBe(true);
    expect(mockSyncRpcClient.deleteTasks).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-1',
      taskIds: ['task-rpc-a', 'task-rpc-b'],
      baseUpdatedAt: null,
      deleteMode: 'purge',
    }));
    expect(mockClient.rpc).not.toHaveBeenCalledWith('purge_tasks_v3', expect.anything());
    expect(mockTombstoneService.deleteAttachmentFilesFromStorage).toHaveBeenCalledWith(
      mockClient,
      ['user/project/task/file.png'],
    );
    expect(mockRetryQueue.removeConnectionsReferencingTasks).toHaveBeenCalledWith(
      'project-1',
      ['task-rpc-a', 'task-rpc-b'],
    );
  });

  it('purgeTasksFromCloud 在 sync RPC 返回 deleted-remote-newer 时保留删除意图等待拉取合并', async () => {
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    const rpcResult: SyncRpcResult = createSyncRpcResult({
      status: 'deleted-remote-newer',
      remoteUpdatedAt: '2026-04-30T05:00:00.000Z',
    });
    mockSyncRpcClient.deleteTasks.mockImplementationOnce(async () => rpcResult);

    const result = await service.purgeTasksFromCloud('project-1', ['task-rpc-conflict'], 'user-1');

    expect(result).toBe(false);
    expect(mockRetryQueue.add).toHaveBeenCalledWith(
      'task',
      'delete',
      { id: 'task-rpc-conflict' },
      'project-1',
      'user-1',
    );
  });

  it('softDeleteTasksBatch 在 sync RPC 开启时应走 sync_delete_tasks 而不是旧 safe_delete_tasks', async () => {
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    const rpcResult: SyncRpcResult = createSyncRpcResult({
      entityId: 'project-1',
      affectedCount: 2,
      attachmentPaths: [] as string[],
    });
    mockSyncRpcClient.deleteTasks.mockImplementationOnce(async () => rpcResult);

    const result = await service.softDeleteTasksBatch('project-1', ['task-soft-rpc-a', 'task-soft-rpc-b']);

    expect(result).toBe(2);
    expect(mockSyncRpcClient.deleteTasks).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-1',
      taskIds: ['task-soft-rpc-a', 'task-soft-rpc-b'],
      baseUpdatedAt: null,
      deleteMode: 'soft',
    }));
    expect(mockClient.rpc).not.toHaveBeenCalledWith('safe_delete_tasks', expect.anything());
    expect(mockTombstoneService.addLocalTombstones).toHaveBeenCalledWith(
      'project-1',
      ['task-soft-rpc-a', 'task-soft-rpc-b'],
      undefined,
    );
    expect(mockRetryQueue.removeConnectionsReferencingTasks).toHaveBeenCalledWith(
      'project-1',
      ['task-soft-rpc-a', 'task-soft-rpc-b'],
    );
  });

  it('softDeleteTasksBatch 在 feature 默认关闭但 probe 成功时仍应走 sync_delete_tasks', async () => {
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(false);
    mockSyncRpcClient.checkProtocol.mockImplementationOnce(async () => {
      mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
      return { minProtocolVersion: 1, deploymentEpoch: 0 };
    });
    mockSyncRpcClient.deleteTasks.mockImplementationOnce(async () => createSyncRpcResult({
      entityId: 'project-1',
      affectedCount: 2,
      attachmentPaths: [] as string[],
    }));

    const result = await service.softDeleteTasksBatch('project-1', ['task-soft-probed-a', 'task-soft-probed-b']);

    expect(result).toBe(2);
    expect(mockSyncRpcClient.checkProtocol).toHaveBeenCalledTimes(1);
    expect(mockSyncRpcClient.deleteTasks).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-1',
      taskIds: ['task-soft-probed-a', 'task-soft-probed-b'],
      deleteMode: 'soft',
    }));
    expect(mockClient.rpc).not.toHaveBeenCalledWith('safe_delete_tasks', expect.anything());
  });

  it('softDeleteTasksBatch 成功后也应清理引用已删任务的连接重试项', async () => {
    mockClient.rpc.mockImplementationOnce(async (fn: string, args: Record<string, unknown>) => {
      if (fn === 'safe_delete_tasks') {
        return { data: 1, error: null, args };
      }
      throw new Error(`Unexpected rpc: ${fn}`);
    });
    mockRetryQueue.removeByEntities.mockReturnValueOnce(['task-soft-delete-scoped']);
    mockRetryQueue.removeConnectionsReferencingTasks.mockReturnValueOnce(['conn-stale-soft-delete']);

    const result = await service.softDeleteTasksBatch('project-1', ['task-soft-delete-scoped']);

    expect(result).toBe(1);
    expect(mockRetryQueue.removeByEntities).toHaveBeenCalledWith('task', ['task-soft-delete-scoped']);
    expect(mockRetryQueue.removeConnectionsReferencingTasks).toHaveBeenCalledWith('project-1', ['task-soft-delete-scoped']);
  });

  it('pullTasks 不应把 updatedAt 晚于 tombstone deleted_at 的恢复任务重新标记为删除', async () => {
    const restoredTask = {
      id: 'task-restored',
      title: '任务',
      content: '内容',
      stage: 1,
      parentId: null,
      order: 0,
      rank: 10000,
      status: 'active',
      x: 0,
      y: 0,
      updatedAt: '2026-04-23T01:00:00.000Z',
      createdDate: '2026-04-23T00:00:00.000Z',
      deletedAt: null,
      displayId: 'T-RESTORE',
      attachments: [],
      tags: [],
    } satisfies Task;

    mockClient.from.mockImplementationOnce((table: string) => {
      if (table === 'tasks') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(async () => ({
              data: [restoredTask],
              error: null,
            })),
          })),
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    });
    mockTombstoneService.getTombstonesWithCache.mockResolvedValueOnce({
      data: [{ task_id: 'task-restored', deleted_at: '2026-04-23T00:00:00.000Z' }],
      error: null,
    });

    const result = await service.pullTasks('project-1');

    expect(result).toHaveLength(1);
    expect(result[0]?.deletedAt).toBeNull();
  });

  it('pushTask 在 tombstone 查询失败时应 fail closed，避免误复活已删任务', async () => {
    mockClient.from.mockImplementationOnce((table: string) => {
      if (table === 'task_tombstones') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn(async () => ({
                data: null,
                error: { code: '42501', message: 'permission denied' },
              })),
            })),
          })),
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    });

    const task: Task = {
      id: 'task-tombstone-query-error',
      title: '任务',
      content: '内容',
      stage: 0,
      parentId: null,
      order: 0,
      rank: 10000,
      status: 'active',
      x: 0,
      y: 0,
      displayId: 'T-3',
      createdDate: new Date().toISOString(),
      deletedAt: null,
    };

    const result = await service.pushTask(task, 'project-1');

    expect(result).toBe(false);
    expect(upsertPayload).toBeNull();
      expect(mockRetryQueue.add).not.toHaveBeenCalled();
      expect(mockRetryQueue.recordCircuitFailure).toHaveBeenCalled();
  });

    it('重试队列回放 task upsert 遇到会话过期时不应抛出永久失败', async () => {
      mockClient.from.mockImplementationOnce((table: string) => {
        if (table === 'task_tombstones') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                maybeSingle: vi.fn(async () => ({
                  data: null,
                  error: { code: 'PGRST301', message: 'JWT expired' },
                })),
              })),
            })),
          };
        }

        throw new Error(`Unexpected table: ${table}`);
      });
      mockSessionManager.isSessionExpiredError.mockImplementation((error: { code?: string | number }) => error.code === 'PGRST301');
      mockSessionManager.handleAuthErrorWithRefresh.mockResolvedValueOnce(false);

      const task: Task = {
        id: 'task-retry-auth-expired',
        title: '任务',
        content: '内容',
        stage: 0,
        parentId: null,
        order: 0,
        rank: 10000,
        status: 'active',
        x: 0,
        y: 0,
        displayId: 'T-4',
        createdDate: new Date().toISOString(),
        deletedAt: null,
      };

      const result = await service.pushTask(task, 'project-1', false, true, 'user-1');

      expect(result).toBe(false);
      expect(upsertPayload).toBeNull();
      expect(mockRetryQueue.add).not.toHaveBeenCalled();
    });

    it('重试队列回放 task upsert 刷新后仍为 42501 时应抛永久失败', async () => {
      let tombstoneLookupCount = 0;
      mockClient.from.mockImplementation((table: string) => {
        if (table === 'task_tombstones') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                maybeSingle: vi.fn(async () => {
                  tombstoneLookupCount += 1;
                  return tombstoneLookupCount === 1
                    ? { data: null, error: { code: 'PGRST301', message: 'JWT expired' } }
                    : { data: null, error: { code: '42501', message: 'RLS Policy Violation' } };
                }),
              })),
            })),
          };
        }

        if (table === 'tasks') {
          return {
            upsert: vi.fn((payload: Record<string, unknown>) => {
              upsertPayload = payload;
              return {
                select: vi.fn(() => ({
                  maybeSingle: vi.fn(async () => ({
                    data: { updated_at: new Date().toISOString() },
                    error: null,
                  })),
                })),
              };
            }),
          };
        }

        throw new Error(`Unexpected table: ${table}`);
      });
      mockSessionManager.isSessionExpiredError.mockImplementation((error: { code?: string | number }) =>
        error.code === 'PGRST301' || error.code === '42501'
      );
      mockSessionManager.handleAuthErrorWithRefresh.mockResolvedValueOnce(true);
      mockSessionManager.isRlsPolicyViolation.mockImplementation((error: { code?: string | number }) => error.code === '42501');

      const task: Task = {
        id: 'task-retry-rls-denied-after-refresh',
        title: '任务',
        content: '内容',
        stage: 0,
        parentId: null,
        order: 0,
        rank: 10000,
        status: 'active',
        x: 0,
        y: 0,
        displayId: 'T-5',
        createdDate: new Date().toISOString(),
        deletedAt: null,
      };

      await expect(service.pushTask(task, 'project-1', false, true, 'user-1')).rejects.toBeInstanceOf(PermanentFailureError);
      expect(mockRetryQueue.add).not.toHaveBeenCalled();
      expect(upsertPayload).toBeNull();
    });

    it('前台 task upsert 在要求 tombstone 终止时应抛永久失败，供 ActionQueue 丢弃过期项', async () => {
      mockClient.from.mockImplementationOnce((table: string) => {
        if (table === 'task_tombstones') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                maybeSingle: vi.fn(async () => ({
                  data: { task_id: 'task-foreground-tombstoned' },
                  error: null,
                })),
              })),
            })),
          };
        }

        throw new Error(`Unexpected table: ${table}`);
      });

      const task: Task = {
        id: 'task-foreground-tombstoned',
        title: '任务',
        content: '内容',
        stage: 0,
        parentId: null,
        order: 0,
        rank: 10000,
        status: 'active',
        x: 0,
        y: 0,
        displayId: 'T-6',
        createdDate: new Date().toISOString(),
        deletedAt: null,
      };

      await expect(service.pushTask(task, 'project-1', false, false, 'user-1', true)).rejects.toBeInstanceOf(PermanentFailureError);
      expect(mockRetryQueue.add).not.toHaveBeenCalled();
      expect(upsertPayload).toBeNull();
    });

    it('deleteTask 在会话已过期时应保留删除意图到重试队列而不是抛出', async () => {
      mockSyncState.isSessionExpired.mockReturnValueOnce(true);

      const result = await service.deleteTask('task-delete-session-expired', 'project-1', 'user-1');

      expect(result).toBe(false);
      expect(mockRetryQueue.add).toHaveBeenCalledWith(
        'task',
        'delete',
        { id: 'task-delete-session-expired' },
        'project-1',
        'user-1',
      );
    });

    it('重试队列回放 task delete 遇到会话过期时不应重复入队也不应抛出', async () => {
      mockSyncState.isSessionExpired.mockReturnValueOnce(true);

      const result = await service.deleteTask('task-delete-retry-session-expired', 'project-1', 'user-1', true);

      expect(result).toBe(false);
      expect(mockRetryQueue.add).not.toHaveBeenCalled();
    });

    it('重试队列回放单任务 delete 遇到 owner mismatch 时不应重复入队', async () => {
      mockClient.auth.getSession.mockResolvedValueOnce({
        data: { session: { user: { id: 'user-2' } } },
      });

      const result = await service.deleteTask('task-delete-retry-owner-mismatch', 'project-1', 'user-1', true);

      expect(result).toBe(false);
      expect(mockRetryQueue.add).not.toHaveBeenCalled();
    });

    it('重试队列回放批量任务删除遇到 owner mismatch 时不应重复入队', async () => {
      mockClient.auth.getSession.mockResolvedValueOnce({
        data: { session: { user: { id: 'user-2' } } },
      });

      const result = await service.purgeTasksFromCloud('project-1', ['task-delete-retry-owner-mismatch'], 'user-1', true);

      expect(result).toBe(false);
      expect(mockClient.rpc).not.toHaveBeenCalled();
      expect(mockRetryQueue.add).not.toHaveBeenCalled();
    });

    it('重试队列回放批量任务删除在 purge 失败时不应自我重入队', async () => {
      mockClient.rpc.mockImplementationOnce(async () => {
        throw new Error('network unavailable');
      });

      const result = await service.purgeTasksFromCloud('project-1', ['task-delete-retry-rpc-failure'], 'user-1', true);

      expect(result).toBe(false);
      expect(mockRetryQueue.add).not.toHaveBeenCalled();
    });

  it('purgeTasksFromCloud 在 sourceUserId 与当前会话不匹配时应拒绝写云端并按原 owner 入队', async () => {
    mockClient.auth.getSession.mockResolvedValueOnce({
      data: { session: { user: { id: 'user-2' } } },
    });

    const result = await service.purgeTasksFromCloud('project-1', ['task-delete-bulk-owner-mismatch'], 'user-1');

    expect(result).toBe(false);
    expect(mockClient.rpc).not.toHaveBeenCalled();
    expect(mockRetryQueue.add).toHaveBeenCalledWith(
      'task',
      'delete',
      { id: 'task-delete-bulk-owner-mismatch' },
      'project-1',
      'user-1',
    );
  });
});
