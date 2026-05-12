import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ConnectionSyncOperationsService } from './connection-sync-operations.service';
import { SupabaseClientService } from '../../../../services/supabase-client.service';
import { LoggerService } from '../../../../services/logger.service';
import { ToastService } from '../../../../services/toast.service';
import { RequestThrottleService } from '../../../../services/request-throttle.service';
import { ProjectStateService } from '../../../../services/project-state.service';
import { ClockSyncService } from '../../../../services/clock-sync.service';
import { SyncOperationHelperService } from './sync-operation-helper.service';
import { SessionManagerService } from './session-manager.service';
import { RetryQueueService } from './retry-queue.service';
import { SyncStateService } from './sync-state.service';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import { TombstoneService } from './tombstone.service';
import { SyncRpcClientService, type SyncRpcResult } from '../../../../services/sync-rpc-client.service';
import type { Connection } from '../../../../models';
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

const upsertConnectionRpcMock = vi.fn<SyncRpcClientService['upsertConnection']>();
const isConnectionSyncRpcFeatureEnabledMock = vi.fn(() => false);
const isConnectionSyncRpcClientRejectedMock = vi.fn(() => false);

describe('ConnectionSyncOperationsService', () => {
  let service: ConnectionSyncOperationsService;

  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const mockRetryQueue = {
    checkCircuitBreaker: vi.fn(() => true),
    add: vi.fn(() => true),
    recordCircuitFailure: vi.fn(),
    recordCircuitSuccess: vi.fn(),
    length: 0,
  };
  const mockSyncRpcClient: {
    isFeatureEnabled: typeof isConnectionSyncRpcFeatureEnabledMock;
    isClientRejected: typeof isConnectionSyncRpcClientRejectedMock;
    upsertConnection: typeof upsertConnectionRpcMock;
  } = {
    isFeatureEnabled: isConnectionSyncRpcFeatureEnabledMock,
    isClientRejected: isConnectionSyncRpcClientRejectedMock,
    upsertConnection: upsertConnectionRpcMock,
  };

  const mockSessionManager = {
    tryRefreshSession: vi.fn(async () => false),
    handleSessionExpired: vi.fn(),
    isSessionExpiredError: vi.fn(() => false),
    handleAuthErrorWithRefresh: vi.fn(async () => false),
    isRlsPolicyViolation: vi.fn(() => false),
  };

  const mockTombstoneService = {
    getLocalTombstones: vi.fn(() => new Set<string>()),
  };

  let connectionTombstoneResult: { data: { connection_id: string } | null; error: unknown | null };
  let connectionEndpointTombstoneResult: { data: { deleted_at: string } | null; error: unknown | null };
  let legacyConnectionTombstoneResult: { data: { deleted_at: string; source_id: string | null; target_id: string | null } | null; error: unknown | null };
  let taskExistenceResult: { data: Array<{ id: string }>; error: unknown | null };
  let endpointDedupResponses: Array<{ data: Array<{ id: string; deleted_at: string | null; updated_at?: string | null; title?: string | null; description?: string | null }>; error: unknown | null }>;
  let connectionFreshnessResult: { data: { id: string; updated_at: string | null; deleted_at: string | null } | null; error: unknown | null };
  let connectionReadbackQueryCount: number;
  let connectionUpsertResult: { data: { updated_at: string } | null; error: unknown | null };
  let connectionUpdateResult: { data: { updated_at: string } | null; error: unknown | null };
  const mockConnectionsUpsert = vi.fn();
  let mockProjects: Array<{ id: string; connections: Connection[]; tasks: unknown[] }>;

  function buildUpsertQuery(
    rawResult: unknown,
  ): { select: ReturnType<typeof vi.fn> } {
    if (
      rawResult
      && typeof rawResult === 'object'
      && 'select' in rawResult
      && typeof (rawResult as { select?: unknown }).select === 'function'
    ) {
      return rawResult as { select: ReturnType<typeof vi.fn> };
    }

    return {
      select: vi.fn(() => ({
        single: vi.fn(async () => {
          const resolved = await Promise.resolve(rawResult);
          return (resolved ?? { data: null, error: null }) as {
            data: { updated_at: string } | null;
            error: unknown | null;
          };
        }),
      })),
    };
  }

  const mockProjectState = {
    updateProjects: vi.fn((updater: (projects: Array<{ id: string; connections: Connection[]; tasks: unknown[] }>) => Array<{ id: string; connections: Connection[]; tasks: unknown[] }>) => {
      mockProjects = updater(mockProjects);
    }),
  };

  const mockSyncState = {
    isSessionExpired: vi.fn(() => false),
    setPendingCount: vi.fn(),
    setSyncError: vi.fn(),
    setSessionExpired: vi.fn(),
  };

  const mockClient = {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: { user: { id: 'user-1' } } } })),
    },
    from: vi.fn((table: string) => {
      if (table === 'connection_tombstones') {
        return {
          select: vi.fn((columns: string) => {
            if (columns === 'deleted_at,source_id,target_id') {
              return {
                eq: vi.fn(() => ({
                  is: vi.fn(() => ({
                    is: vi.fn(() => ({
                      order: vi.fn(() => ({
                        limit: vi.fn(() => ({
                          maybeSingle: vi.fn(async () => legacyConnectionTombstoneResult),
                        })),
                      })),
                    })),
                  })),
                })),
              };
            }

            if (columns === 'deleted_at') {
              return {
                eq: vi.fn(() => ({
                  eq: vi.fn(() => ({
                    eq: vi.fn(() => ({
                      order: vi.fn(() => ({
                        limit: vi.fn(() => ({
                          maybeSingle: vi.fn(async () => connectionEndpointTombstoneResult),
                        })),
                      })),
                    })),
                  })),
                })),
              };
            }

            return {
              eq: vi.fn(() => ({
                maybeSingle: vi.fn(async () => connectionTombstoneResult),
              })),
            };
          }),
        };
      }

      if (table === 'tasks') {
        return {
          select: vi.fn(() => ({
            in: vi.fn(() => ({
              eq: vi.fn(() => ({
                is: vi.fn(async () => taskExistenceResult),
              })),
            })),
          })),
        };
      }

      if (table === 'connections') {
        return {
          select: vi.fn((columns: string) => {
            if (columns === 'id,updated_at,deleted_at') {
              return {
                eq: vi.fn(() => ({
                  eq: vi.fn(() => ({
                    maybeSingle: vi.fn(async () => connectionFreshnessResult),
                  })),
                })),
              };
            }

            if (columns === 'updated_at') {
              connectionReadbackQueryCount += 1;
              return {
                eq: vi.fn(() => ({
                  maybeSingle: vi.fn(async () => ({ data: null, error: null })),
                })),
              };
            }

            return {
              eq: vi.fn(() => ({
                eq: vi.fn(() => ({
                  eq: vi.fn(async () => {
                    if (endpointDedupResponses.length > 1) {
                      return endpointDedupResponses.shift()!;
                    }

                    return endpointDedupResponses[0] ?? { data: [], error: null };
                  }),
                })),
              })),
            };
          }),
          insert: (payload: unknown) => {
            const rawResult = mockConnectionsUpsert(payload, { onConflict: 'id', ignoreDuplicates: false });
            return buildUpsertQuery(rawResult === undefined ? connectionUpsertResult : rawResult);
          },
          update: (payload: unknown) => {
            const rawResult = mockConnectionsUpsert(payload, { mode: 'cas-update' });
            return {
              eq: vi.fn(() => ({
                eq: vi.fn(() => ({
                  eq: vi.fn(() => ({
                    select: vi.fn(() => ({
                      maybeSingle: vi.fn(async () => {
                        const resolved = await Promise.resolve(rawResult);
                        return (resolved === undefined ? connectionUpdateResult : resolved) as {
                          data: { updated_at: string } | null;
                          error: unknown | null;
                        };
                      }),
                    })),
                  })),
                })),
              })),
            };
          },
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    resetBrowserNetworkSuspensionTrackingForTests();
    setVisibilityState('visible');
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(false);
    mockSyncRpcClient.isClientRejected.mockReturnValue(false);
    const defaultUpsertConnectionRpcResult: SyncRpcResult = createSyncRpcResult({ entityId: 'connection-1' });
    mockSyncRpcClient.upsertConnection.mockImplementation(async () => defaultUpsertConnectionRpcResult);
    connectionTombstoneResult = { data: null, error: null };
    connectionEndpointTombstoneResult = { data: null, error: null };
    legacyConnectionTombstoneResult = { data: null, error: null };
    taskExistenceResult = {
      data: [{ id: 'task-a' }, { id: 'task-b' }],
      error: null,
    };
    endpointDedupResponses = [{ data: [], error: null }];
    connectionFreshnessResult = { data: null, error: null };
    connectionReadbackQueryCount = 0;
    connectionUpsertResult = {
      data: { updated_at: '2026-04-11T00:01:00.000Z' },
      error: null,
    };
    connectionUpdateResult = {
      data: { updated_at: '2026-04-11T00:01:00.000Z' },
      error: null,
    };
    mockConnectionsUpsert.mockImplementation(() => undefined);
    mockProjects = [{ id: 'project-1', connections: [], tasks: [] }];

    TestBed.configureTestingModule({
      providers: [
        ConnectionSyncOperationsService,
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
        { provide: ProjectStateService, useValue: mockProjectState },
        { provide: SyncOperationHelperService, useValue: { retryWithBackoff: vi.fn(async (fn: () => Promise<void>) => await fn()) } },
        {
          provide: SessionManagerService,
          useValue: mockSessionManager,
        },
        { provide: RetryQueueService, useValue: mockRetryQueue },
        { provide: SyncRpcClientService, useValue: mockSyncRpcClient },
        { provide: SyncStateService, useValue: mockSyncState },
        { provide: TombstoneService, useValue: mockTombstoneService },
        {
          provide: SentryLazyLoaderService,
          useValue: {
            captureException: vi.fn(),
            captureMessage: vi.fn(),
          },
        },
      ],
    });

    service = TestBed.inject(ConnectionSyncOperationsService);
  });

  it('sourceUserId 与当前会话不匹配时应拒绝写云端并按原 owner 入队', async () => {
    const connection: Connection = {
      id: 'connection-owner-mismatch',
      source: 'task-a',
      target: 'task-b',
    };
    mockClient.auth.getSession.mockResolvedValueOnce({
      data: { session: { user: { id: 'user-2' } } },
    });

    const result = await service.pushConnection(connection, 'project-1', false, false, false, 'user-1');

    expect(result).toBe(false);
    expect(mockRetryQueue.add).toHaveBeenCalledWith('connection', 'upsert', connection, 'project-1', 'user-1');
  });

  it('pushConnection 在 sync RPC flag 开启时应走 RPC/CAS 而不是直接 table upsert', async () => {
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    const rpcResult: SyncRpcResult = createSyncRpcResult({
      entityId: 'connection-rpc',
      serverUpdatedAt: '2026-04-30T00:02:00.000Z',
    });
    mockSyncRpcClient.upsertConnection.mockImplementationOnce(async () => rpcResult);
    const connection: Connection = {
      id: 'connection-rpc',
      source: 'task-a',
      target: 'task-b',
      updatedAt: '2026-04-30T00:00:00.000Z',
    };

    const result = await service.pushConnection(connection, 'project-1', false, false, false, 'user-1');

    expect(result).toBe(true);
    expect(mockSyncRpcClient.upsertConnection).toHaveBeenCalledWith(expect.objectContaining({
      operationId: expect.any(String),
      connection,
      projectId: 'project-1',
      baseUpdatedAt: '2026-04-30T00:00:00.000Z',
    }));
    expect(mockConnectionsUpsert).not.toHaveBeenCalled();
    expect(mockRetryQueue.recordCircuitSuccess).toHaveBeenCalled();
    expect(connection.updatedAt).toBe('2026-04-30T00:02:00.000Z');
  });

  it('pushConnection sync RPC 遇到 remote-newer 时应保留本地意图并阻止直接 table upsert', async () => {
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    const rpcResult: SyncRpcResult = createSyncRpcResult({
      status: 'remote-newer',
      remoteUpdatedAt: '2026-04-30T00:01:00.000Z',
    });
    mockSyncRpcClient.upsertConnection.mockImplementationOnce(async () => rpcResult);
    const connection: Connection = {
      id: 'connection-rpc-remote-newer',
      source: 'task-a',
      target: 'task-b',
      updatedAt: '2026-04-30T00:00:00.000Z',
    };

    const result = await service.pushConnection(connection, 'project-1', false, false, false, 'user-1');

    expect(result).toBe(false);
    expect(mockConnectionsUpsert).not.toHaveBeenCalled();
    expect(mockRetryQueue.add).toHaveBeenCalledWith('connection', 'upsert', connection, 'project-1', 'user-1');
    expect(mockRetryQueue.recordCircuitSuccess).not.toHaveBeenCalled();
  });

  it('pushConnection 直接 upsert 前若远端连接更新更晚则应抛出版本冲突并阻止覆盖', async () => {
    connectionFreshnessResult = {
      data: {
        id: 'connection-direct-conflict',
        updated_at: '2026-04-30T00:02:00.000Z',
        deleted_at: null,
      },
      error: null,
    };

    const connection: Connection = {
      id: 'connection-direct-conflict',
      source: 'task-a',
      target: 'task-b',
      updatedAt: '2026-04-30T00:00:00.000Z',
    };

    await expect(service.pushConnection(connection, 'project-1', false, false, false, 'user-1'))
      .rejects.toBeInstanceOf(PermanentFailureError);

    expect(mockConnectionsUpsert).not.toHaveBeenCalled();
    expect(mockRetryQueue.add).not.toHaveBeenCalled();
    expect(mockRetryQueue.recordCircuitSuccess).not.toHaveBeenCalled();
  });

  it('pushConnection 直接写入在 preflight 后被并发更新抢先时应抛出版本冲突', async () => {
    connectionFreshnessResult = {
      data: {
        id: 'connection-direct-cas-miss',
        updated_at: '2026-04-30T00:02:00.000Z',
        deleted_at: null,
      },
      error: null,
    };
    connectionUpdateResult = {
      data: null,
      error: null,
    };

    const connection: Connection = {
      id: 'connection-direct-cas-miss',
      source: 'task-a',
      target: 'task-b',
      updatedAt: '2026-04-30T00:02:00.000Z',
    };

    await expect(service.pushConnection(connection, 'project-1', false, false, false, 'user-1'))
      .rejects.toBeInstanceOf(PermanentFailureError);

    expect(mockRetryQueue.add).not.toHaveBeenCalled();
    expect(mockRetryQueue.recordCircuitSuccess).not.toHaveBeenCalled();
  });

  it('引用已本地删除任务的连接不应继续入队', async () => {
    const connection: Connection = {
      id: 'connection-stale-after-task-delete',
      source: 'task-a',
      target: 'task-b',
    };
    taskExistenceResult = {
      data: [{ id: 'task-b' }],
      error: null,
    };
    mockTombstoneService.getLocalTombstones.mockReturnValueOnce(new Set(['task-a']));

    const result = await service.pushConnection(connection, 'project-1');

    expect(result).toBe(false);
    expect(mockRetryQueue.add).not.toHaveBeenCalled();
    expect(mockConnectionsUpsert).not.toHaveBeenCalled();
  });

  it('重试队列回放命中远端 connection tombstone 时应抛永久失败', async () => {
    const connection: Connection = {
      id: 'connection-remote-tombstoned',
      source: 'task-a',
      target: 'task-b',
    };
    connectionTombstoneResult = {
      data: { connection_id: connection.id },
      error: null,
    };

    await expect(service.pushConnection(connection, 'project-1', false, false, true, 'user-1'))
      .rejects.toBeInstanceOf(PermanentFailureError);
    expect(mockConnectionsUpsert).not.toHaveBeenCalled();
  });

  it('connection tombstone 查询失败时应 fail closed 并进入重试', async () => {
    const connection: Connection = {
      id: 'connection-tombstone-query-error',
      source: 'task-a',
      target: 'task-b',
    };
    connectionTombstoneResult = {
      data: null,
      error: { code: '503', message: 'Service unavailable' },
    };

    const result = await service.pushConnection(connection, 'project-1', false, false, false, 'user-1');

    expect(result).toBe(false);
    expect(mockRetryQueue.add).toHaveBeenCalledWith('connection', 'upsert', connection, 'project-1', 'user-1');
    expect(mockConnectionsUpsert).not.toHaveBeenCalled();
  });

  it('刷新后任务存在性查询仍为 RLS 违规时应抛永久失败供重试队列收口', async () => {
    const connection: Connection = {
      id: 'connection-permission-denied-after-refresh',
      source: 'task-a',
      target: 'task-b',
    };
    taskExistenceResult = {
      data: [],
      error: { code: '42501', message: 'RLS Policy Violation' },
    };
    mockSessionManager.isSessionExpiredError.mockImplementation(((error: { code?: string | number }) => error.code === '42501') as any);
    mockSessionManager.handleAuthErrorWithRefresh.mockResolvedValueOnce(true);
    mockSessionManager.isRlsPolicyViolation.mockImplementation(((error: { code?: string | number }) => error.code === '42501') as any);

    await expect(service.pushConnection(connection, 'project-1', false, false, true, 'user-1'))
      .rejects.toBeInstanceOf(PermanentFailureError);
    expect(mockRetryQueue.add).not.toHaveBeenCalled();
    expect(mockConnectionsUpsert).not.toHaveBeenCalled();
  });

  it('session 在浏览器网络挂起窗口内暂不可用时应延后连接同步而非标记过期', async () => {
    const connection: Connection = {
      id: 'connection-browser-suspended-session',
      source: 'task-a',
      target: 'task-b',
    };
    setVisibilityState('hidden');
    mockClient.auth.getSession.mockResolvedValueOnce({ data: { session: null as any } });

    const result = await service.pushConnection(connection, 'project-1', false, false, false, 'user-1');

    expect(result).toBe(false);
    expect(mockSyncState.setSessionExpired).not.toHaveBeenCalled();
    expect(mockRetryQueue.add).toHaveBeenCalledWith('connection', 'upsert', connection, 'project-1', 'user-1');
  });

  it('self-link 连接不应写入云端或进入重试队列', async () => {
    const connection: Connection = {
      id: 'connection-self-link',
      source: 'task-a',
      target: 'task-a',
    };

    const result = await service.pushConnection(connection, 'project-1', false, false, false, 'user-1');

    expect(result).toBe(false);
    expect(mockRetryQueue.add).not.toHaveBeenCalled();
    expect(mockConnectionsUpsert).not.toHaveBeenCalled();
  });

  it('首次缺少 session 时应先尝试 refresh，再继续连接同步', async () => {
    const connection: Connection = {
      id: 'connection-refresh-before-expire',
      source: 'task-a',
      target: 'task-b',
    };
    mockSessionManager.tryRefreshSession.mockResolvedValueOnce(true);
    mockClient.auth.getSession
      .mockResolvedValueOnce({ data: { session: null as any } })
      .mockResolvedValueOnce({ data: { session: { user: { id: 'user-1' } } } });

    const result = await service.pushConnection(connection, 'project-1', false, false, false, 'user-1');

    expect(result).toBe(true);
    expect(mockSessionManager.tryRefreshSession).toHaveBeenCalledWith('pushConnection.getSession');
    expect(mockSyncState.setSessionExpired).not.toHaveBeenCalled();
  });

  it('成功同步后应直接使用 upsert 返回的 updated_at 归一本地连接时间戳，不再额外回读', async () => {
    const connection: Connection = {
      id: 'connection-normalize-updated-at',
      source: 'task-a',
      target: 'task-b',
      updatedAt: '2036-04-11T00:00:00.000Z',
    };
    mockProjects = [{
      id: 'project-1',
      tasks: [],
      connections: [{ ...connection }],
    }];
    connectionUpsertResult = {
      data: { updated_at: '2026-04-11T00:01:00.000Z' },
      error: null,
    };

    const result = await service.pushConnection(connection, 'project-1', false, false, false, 'user-1');

    expect(result).toBe(true);
    expect(connection.updatedAt).toBe('2026-04-11T00:01:00.000Z');
    expect(mockProjects[0].connections[0].updatedAt).toBe('2026-04-11T00:01:00.000Z');
    expect(connectionReadbackQueryCount).toBe(0);
    expect(mockProjectState.updateProjects).toHaveBeenCalled();
  });

  it('远端仅存在软删同端点连接时应复用其 id 执行恢复', async () => {
    const connection: Connection = {
      id: 'connection-local-revive',
      source: 'task-a',
      target: 'task-b',
      updatedAt: '2036-04-11T00:00:00.000Z',
    };
    endpointDedupResponses = [{
      data: [{
        id: 'connection-remote-soft-deleted',
        deleted_at: '2026-04-10T00:00:00.000Z',
      }],
      error: null,
    }];
    mockProjects = [{
      id: 'project-1',
      tasks: [],
      connections: [{ ...connection }],
    }];

    const result = await service.pushConnection(connection, 'project-1', false, false, false, 'user-1');

    expect(result).toBe(true);
    expect(mockConnectionsUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'connection-remote-soft-deleted',
      }),
      expect.any(Object)
    );
    expect(mockProjects[0].connections[0].id).toBe('connection-remote-soft-deleted');
  });

  it('本地活跃连接遇到远端 active+deleted 混排时应优先复用 active id', async () => {
    const connection: Connection = {
      id: 'connection-local-active',
      source: 'task-a',
      target: 'task-b',
      updatedAt: '2036-04-11T00:00:00.000Z',
    };
    endpointDedupResponses = [{
      data: [
        {
          id: 'connection-remote-deleted',
          deleted_at: '2026-04-10T00:00:00.000Z',
          updated_at: '2026-04-10T00:00:00.000Z',
        },
        {
          id: 'connection-remote-active',
          deleted_at: null,
          updated_at: '2026-04-11T00:00:00.000Z',
        },
      ],
      error: null,
    }];
    mockProjects = [{
      id: 'project-1',
      tasks: [],
      connections: [{ ...connection }],
    }];

    const result = await service.pushConnection(connection, 'project-1', false, false, false, 'user-1');

    expect(result).toBe(true);
    expect(mockConnectionsUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'connection-remote-active',
      }),
      expect.any(Object)
    );
    expect(mockProjects[0].connections[0].id).toBe('connection-remote-active');
  });

  it('本地软删连接遇到远端 active 同端点连接时应复用远端 id 完成删除', async () => {
    const connection: Connection = {
      id: 'connection-local-delete',
      source: 'task-a',
      target: 'task-b',
      deletedAt: '2026-04-11T00:02:00.000Z',
      updatedAt: '2036-04-11T00:00:00.000Z',
    };
    endpointDedupResponses = [{
      data: [{
        id: 'connection-remote-active',
        deleted_at: null,
      }],
      error: null,
    }];
    mockProjects = [{
      id: 'project-1',
      tasks: [],
      connections: [{ ...connection }],
    }];

    const result = await service.pushConnection(connection, 'project-1', false, false, false, 'user-1');

    expect(result).toBe(true);
    expect(mockConnectionsUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'connection-remote-active',
        deleted_at: '2026-04-11T00:02:00.000Z',
      }),
      expect.any(Object)
    );
    expect(mockProjects[0].connections[0].id).toBe('connection-remote-active');
  });

  it('同 id 时若服务端 deleted 状态更新更晚则不应被本地旧 active 状态覆盖', async () => {
    const connection: Connection = {
      id: 'connection-same-id-stale-active',
      source: 'task-a',
      target: 'task-b',
      title: 'local title',
      description: 'local description',
      updatedAt: '2026-04-11T00:00:00.000Z',
    };
    endpointDedupResponses = [{
      data: [{
        id: 'connection-same-id-stale-active',
        deleted_at: '2026-04-11T00:03:00.000Z',
        updated_at: '2026-04-11T00:03:00.000Z',
        title: 'server title',
        description: 'server description',
      }],
      error: null,
    }];
    mockProjects = [{
      id: 'project-1',
      tasks: [],
      connections: [{ ...connection }],
    }];

    const result = await service.pushConnection(connection, 'project-1', false, false, false, 'user-1');

    expect(result).toBe(true);
    expect(mockConnectionsUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'connection-same-id-stale-active',
        deleted_at: '2026-04-11T00:03:00.000Z',
        title: 'server title',
        description: 'server description',
      }),
      expect.any(Object)
    );
    expect(mockProjects[0].connections[0]).toEqual(expect.objectContaining({
      id: 'connection-same-id-stale-active',
      deletedAt: '2026-04-11T00:03:00.000Z',
      title: 'server title',
      description: 'server description',
    }));
  });

  it('同 id 时若服务端 active 行更晚且明确清空字段则不应继承本地旧 deletedAt 或 metadata', async () => {
    const connection: Connection = {
      id: 'connection-same-id-stale-deleted',
      source: 'task-a',
      target: 'task-b',
      title: 'old title',
      description: 'old description',
      deletedAt: '2026-04-11T00:00:00.000Z',
      updatedAt: '2026-04-11T00:00:00.000Z',
    };
    endpointDedupResponses = [{
      data: [{
        id: 'connection-same-id-stale-deleted',
        deleted_at: null,
        updated_at: '2026-04-11T00:05:00.000Z',
        title: null,
        description: null,
      }],
      error: null,
    }];

    const result = await service.pushConnection(connection, 'project-1', false, false, false, 'user-1');

    expect(result).toBe(true);
    expect(mockConnectionsUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'connection-same-id-stale-deleted',
        deleted_at: null,
        title: null,
        description: null,
      }),
      expect.any(Object)
    );
  });

  it('canonical id 重绑到本地已存在记录时应合并为单条连接', async () => {
    const connection: Connection = {
      id: 'connection-local-revived',
      source: 'task-a',
      target: 'task-b',
      updatedAt: '2036-04-11T00:00:00.000Z',
    };
    endpointDedupResponses = [{
      data: [{
        id: 'connection-canonical',
        deleted_at: '2026-04-10T00:00:00.000Z',
        updated_at: '2026-04-10T00:00:00.000Z',
      }],
      error: null,
    }];
    mockProjects = [{
      id: 'project-1',
      tasks: [],
      connections: [
        { ...connection },
        {
          id: 'connection-canonical',
          source: 'task-a',
          target: 'task-b',
          title: 'canonical title',
          description: 'canonical description',
          deletedAt: '2026-04-10T00:00:00.000Z',
          updatedAt: '2026-04-10T00:00:00.000Z',
        },
      ],
    }];

    const result = await service.pushConnection(connection, 'project-1', false, false, false, 'user-1');

    expect(result).toBe(true);
    expect(mockProjects[0].connections.filter(item => item.id === 'connection-canonical')).toHaveLength(1);
    expect(mockProjects[0].connections[0]).toEqual(expect.objectContaining({
      id: 'connection-canonical',
      deletedAt: undefined,
      title: 'canonical title',
      description: 'canonical description',
    }));
  });

  it('canonical rebinding 应保留比 old-id 更晚的本地 canonical 删除状态', async () => {
    const connection: Connection = {
      id: 'connection-old-id-stale-active',
      source: 'task-a',
      target: 'task-b',
      updatedAt: '2026-04-11T00:00:00.000Z',
    };
    endpointDedupResponses = [{
      data: [{
        id: 'connection-canonical-fresher-local-delete',
        deleted_at: '2026-04-12T00:00:00.000Z',
        updated_at: '2026-04-12T00:00:00.000Z',
        title: 'server title',
        description: 'server description',
      }],
      error: null,
    }];
    mockProjects = [{
      id: 'project-1',
      tasks: [],
      connections: [
        { ...connection },
        {
          id: 'connection-canonical-fresher-local-delete',
          source: 'task-a',
          target: 'task-b',
          title: 'local canonical title',
          description: 'local canonical description',
          deletedAt: '2026-04-12T00:00:00.000Z',
          updatedAt: '2026-04-12T00:00:00.000Z',
        },
      ],
    }];

    const result = await service.pushConnection(connection, 'project-1', false, false, false, 'user-1');

    expect(result).toBe(true);
    expect(mockConnectionsUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'connection-canonical-fresher-local-delete',
        deleted_at: '2026-04-12T00:00:00.000Z',
        title: 'server title',
        description: 'server description',
      }),
      expect.any(Object)
    );
  });

  it('precheck canonical row 若服务端删除时间更晚则不应被本地旧 active 状态复活', async () => {
    const connection: Connection = {
      id: 'connection-local-stale-active',
      source: 'task-a',
      target: 'task-b',
      updatedAt: '2026-04-11T00:00:00.000Z',
    };
    endpointDedupResponses = [{
      data: [{
        id: 'connection-canonical-deleted-newer',
        deleted_at: '2026-04-11T00:02:00.000Z',
        updated_at: '2026-04-11T00:02:00.000Z',
        title: 'server title',
        description: 'server description',
      }],
      error: null,
    }];
    mockProjects = [{
      id: 'project-1',
      tasks: [],
      connections: [
        { ...connection },
        {
          id: 'connection-canonical-deleted-newer',
          source: 'task-a',
          target: 'task-b',
          title: 'old local title',
          description: 'old local description',
          updatedAt: '2026-04-11T00:00:00.000Z',
        },
      ],
    }];

    const result = await service.pushConnection(connection, 'project-1', false, false, false, 'user-1');

    expect(result).toBe(true);
    expect(mockConnectionsUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'connection-canonical-deleted-newer',
        deleted_at: '2026-04-11T00:02:00.000Z',
        title: 'server title',
        description: 'server description',
      }),
      expect.any(Object)
    );
    expect(mockProjects[0].connections.find(item => item.id === 'connection-canonical-deleted-newer')).toEqual(
      expect.objectContaining({
        deletedAt: '2026-04-11T00:02:00.000Z',
        title: 'server title',
        description: 'server description',
      })
    );
  });

  it('stale replay 在旧 id 已不在本地时也应从 canonical row 回填 metadata', async () => {
    const connection: Connection = {
      id: 'connection-stale-replay-old-id',
      source: 'task-a',
      target: 'task-b',
    };
    endpointDedupResponses = [{
      data: [{
        id: 'connection-canonical-only',
        deleted_at: null,
        updated_at: '2026-04-11T00:00:00.000Z',
      }],
      error: null,
    }];
    mockProjects = [{
      id: 'project-1',
      tasks: [],
      connections: [{
        id: 'connection-canonical-only',
        source: 'task-a',
        target: 'task-b',
        title: 'canonical title',
        description: 'canonical description',
        updatedAt: '2026-04-11T00:00:00.000Z',
      }],
    }];

    const result = await service.pushConnection(connection, 'project-1', false, false, false, 'user-1');

    expect(result).toBe(true);
    expect(mockConnectionsUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'connection-canonical-only',
        title: 'canonical title',
        description: 'canonical description',
      }),
      expect.any(Object)
    );
  });

  it('stale replay 在本地 canonical row 缺失且本地内容更新更晚时不应被远端旧空内容覆盖', async () => {
    const connection: Connection = {
      id: 'connection-stale-replay-local-newer-content',
      source: 'task-a',
      target: 'task-b',
      title: 'fresh title',
      description: 'fresh description',
      updatedAt: '2026-04-11T00:03:00.000Z',
    };
    endpointDedupResponses = [{
      data: [{
        id: 'connection-canonical-older-empty',
        deleted_at: null,
        updated_at: '2026-04-11T00:00:00.000Z',
        title: null,
        description: null,
      }],
      error: null,
    }];
    mockProjects = [{
      id: 'project-1',
      tasks: [],
      connections: [],
    }];

    const result = await service.pushConnection(connection, 'project-1', false, false, false, 'user-1');

    expect(result).toBe(true);
    expect(mockConnectionsUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'connection-canonical-older-empty',
        title: 'fresh title',
        description: 'fresh description',
      }),
      expect.any(Object)
    );
  });

  it('stale replay 在旧 id 已不在本地时不应清空 canonical row 的 deletedAt', async () => {
    const connection: Connection = {
      id: 'connection-stale-replay-delete-old-id',
      source: 'task-a',
      target: 'task-b',
    };
    endpointDedupResponses = [{
      data: [{
        id: 'connection-canonical-deleted',
        deleted_at: '2026-04-11T00:02:00.000Z',
        updated_at: '2026-04-11T00:02:00.000Z',
      }],
      error: null,
    }];
    mockProjects = [{
      id: 'project-1',
      tasks: [],
      connections: [{
        id: 'connection-canonical-deleted',
        source: 'task-a',
        target: 'task-b',
        deletedAt: '2026-04-11T00:02:00.000Z',
        updatedAt: '2026-04-11T00:02:00.000Z',
      }],
    }];

    const result = await service.pushConnection(connection, 'project-1', false, false, false, 'user-1');

    expect(result).toBe(true);
    expect(mockConnectionsUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'connection-canonical-deleted',
        deleted_at: '2026-04-11T00:02:00.000Z',
      }),
      expect.any(Object)
    );
  });

  it('不同 id 的旧连接重放遇到更新的端点 tombstone 时不应复活已删连接', async () => {
    const connection: Connection = {
      id: 'connection-stale-different-id',
      source: 'task-a',
      target: 'task-b',
      updatedAt: '2026-04-11T00:00:00.000Z',
    };
    connectionEndpointTombstoneResult = {
      data: { deleted_at: '2026-04-11T00:02:00.000Z' },
      error: null,
    };

    const result = await service.pushConnection(connection, 'project-1', false, false, false, 'user-1');

    expect(result).toBe(false);
    expect(mockConnectionsUpsert).not.toHaveBeenCalled();
    expect(mockRetryQueue.add).not.toHaveBeenCalled();
  });

  it('历史 endpoint-less tombstone 更晚时应 fail closed，避免 fresh-id replay 复活旧连接', async () => {
    const connection: Connection = {
      id: 'connection-legacy-tombstone-replay',
      source: 'task-a',
      target: 'task-b',
      updatedAt: '2026-04-11T00:00:00.000Z',
    };
    legacyConnectionTombstoneResult = {
      data: {
        deleted_at: '2026-04-11T00:04:00.000Z',
        source_id: null,
        target_id: null,
      },
      error: null,
    };

    const result = await service.pushConnection(connection, 'project-1', false, false, false, 'user-1');

    expect(result).toBe(false);
    expect(mockConnectionsUpsert).not.toHaveBeenCalled();
  });

  it('端点 tombstone 新旧比较应考虑 local deletedAt，避免误丢更晚的删除重放', async () => {
    const connection: Connection = {
      id: 'connection-delete-without-updated-at',
      source: 'task-a',
      target: 'task-b',
      deletedAt: '2026-04-11T00:03:00.000Z',
    };
    connectionEndpointTombstoneResult = {
      data: { deleted_at: '2026-04-11T00:02:00.000Z' },
      error: null,
    };

    const result = await service.pushConnection(connection, 'project-1', false, false, false, 'user-1');

    expect(result).toBe(true);
    expect(mockConnectionsUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'connection-delete-without-updated-at',
        deleted_at: '2026-04-11T00:03:00.000Z',
      }),
      expect.any(Object)
    );
  });

  it('local canonical row 缺失时应使用服务端 canonical metadata 避免清空远端状态', async () => {
    const connection: Connection = {
      id: 'connection-server-only-canonical-old-id',
      source: 'task-a',
      target: 'task-b',
    };
    endpointDedupResponses = [{
      data: [{
        id: 'connection-server-only-canonical',
        deleted_at: '2026-04-11T00:02:00.000Z',
        updated_at: '2026-04-11T00:02:00.000Z',
        title: 'server title',
        description: 'server description',
      }],
      error: null,
    }];
    mockProjects = [{
      id: 'project-1',
      tasks: [],
      connections: [],
    }];

    const result = await service.pushConnection(connection, 'project-1', false, false, false, 'user-1');

    expect(result).toBe(true);
    expect(mockConnectionsUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'connection-server-only-canonical',
        deleted_at: '2026-04-11T00:02:00.000Z',
        title: 'server title',
        description: 'server description',
      }),
      expect.any(Object)
    );
  });

  it('precheck miss 后遇到 23505 时应重绑 canonical id 并重试 upsert 当前变更', async () => {
    const connection: Connection = {
      id: 'connection-local-delete-race',
      source: 'task-a',
      target: 'task-b',
      deletedAt: '2026-04-11T00:02:00.000Z',
      updatedAt: '2036-04-11T00:00:00.000Z',
    };
    endpointDedupResponses = [
      { data: [], error: null },
      {
        data: [{
          id: 'connection-raced-canonical',
          deleted_at: null,
          updated_at: '2026-04-11T00:00:00.000Z',
        }],
        error: null,
      },
    ];
    mockConnectionsUpsert
      .mockResolvedValueOnce({
        error: {
          code: '23505',
          message: 'duplicate key value violates unique constraint "uq_connections_project_source_target_active"',
        },
      })
      .mockResolvedValueOnce({ error: null });
    mockProjects = [{
      id: 'project-1',
      tasks: [],
      connections: [{ ...connection }],
    }];

    const result = await service.pushConnection(connection, 'project-1', false, false, false, 'user-1');

    expect(result).toBe(true);
    expect(mockConnectionsUpsert).toHaveBeenCalledTimes(2);
    expect(mockConnectionsUpsert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        id: 'connection-raced-canonical',
        deleted_at: '2026-04-11T00:02:00.000Z',
      }),
      expect.any(Object)
    );
    expect(mockProjects[0].connections).toEqual([
      expect.objectContaining({
        id: 'connection-raced-canonical',
        deletedAt: '2026-04-11T00:02:00.000Z',
      }),
    ]);
  });

  it('23505 恢复时旧 id 已不在本地也应从 canonical row 回填 metadata 再重试', async () => {
    const connection: Connection = {
      id: 'connection-stale-race-old-id',
      source: 'task-a',
      target: 'task-b',
    };
    endpointDedupResponses = [
      { data: [], error: null },
      {
        data: [{
          id: 'connection-raced-canonical-metadata',
          deleted_at: null,
          updated_at: '2026-04-11T00:00:00.000Z',
        }],
        error: null,
      },
    ];
    mockConnectionsUpsert
      .mockResolvedValueOnce({
        error: {
          code: '23505',
          message: 'duplicate key value violates unique constraint "uq_connections_project_source_target_active"',
        },
      })
      .mockResolvedValueOnce({ error: null });
    mockProjects = [{
      id: 'project-1',
      tasks: [],
      connections: [{
        id: 'connection-raced-canonical-metadata',
        source: 'task-a',
        target: 'task-b',
        title: 'canonical title',
        description: 'canonical description',
        updatedAt: '2026-04-11T00:00:00.000Z',
      }],
    }];

    const result = await service.pushConnection(connection, 'project-1', false, false, false, 'user-1');

    expect(result).toBe(true);
    expect(mockConnectionsUpsert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        id: 'connection-raced-canonical-metadata',
        title: 'canonical title',
        description: 'canonical description',
      }),
      expect.any(Object)
    );
  });

  it('23505 恢复时若服务端 canonical 已删除且更新更晚则不应被本地旧 active 状态复活', async () => {
    const connection: Connection = {
      id: 'connection-stale-race-local-active',
      source: 'task-a',
      target: 'task-b',
      updatedAt: '2026-04-11T00:00:00.000Z',
    };
    endpointDedupResponses = [
      { data: [], error: null },
      {
        data: [{
          id: 'connection-raced-canonical-deleted',
          deleted_at: '2026-04-11T00:03:00.000Z',
          updated_at: '2026-04-11T00:03:00.000Z',
          title: 'server title',
          description: 'server description',
        }],
        error: null,
      },
    ];
    mockConnectionsUpsert
      .mockResolvedValueOnce({
        error: {
          code: '23505',
          message: 'duplicate key value violates unique constraint "uq_connections_project_source_target_active"',
        },
      })
      .mockResolvedValueOnce({ error: null });
    mockProjects = [{
      id: 'project-1',
      tasks: [],
      connections: [
        { ...connection },
        {
          id: 'connection-raced-canonical-deleted',
          source: 'task-a',
          target: 'task-b',
          title: 'old local title',
          description: 'old local description',
          updatedAt: '2026-04-11T00:00:00.000Z',
        },
      ],
    }];

    const result = await service.pushConnection(connection, 'project-1', false, false, false, 'user-1');

    expect(result).toBe(true);
    expect(mockConnectionsUpsert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        id: 'connection-raced-canonical-deleted',
        deleted_at: '2026-04-11T00:03:00.000Z',
        title: 'server title',
        description: 'server description',
      }),
      expect.any(Object)
    );
  });

  it('23505 后重新查询仍拿不到 canonical row 时应按失败入队而不是伪成功', async () => {
    const connection: Connection = {
      id: 'connection-local-delete-race-miss',
      source: 'task-a',
      target: 'task-b',
      deletedAt: '2026-04-11T00:02:00.000Z',
      updatedAt: '2036-04-11T00:00:00.000Z',
    };
    endpointDedupResponses = [
      { data: [], error: null },
      { data: [], error: null },
    ];
    mockConnectionsUpsert.mockResolvedValueOnce({
      error: {
        code: '23505',
        message: 'duplicate key value violates unique constraint "uq_connections_project_source_target_active"',
      },
    });

    const result = await service.pushConnection(connection, 'project-1', false, false, false, 'user-1');

    expect(result).toBe(false);
    expect(mockRetryQueue.add).toHaveBeenCalledWith('connection', 'upsert', connection, 'project-1', 'user-1');
  });

  it('重试队列回放连接遇到浏览器网络挂起时应抛出延后错误，避免消耗 retry budget', async () => {
    const connection: Connection = {
      id: 'connection-browser-suspended-replay',
      source: 'task-a',
      target: 'task-b',
    };
    mockClient.auth.getSession.mockRejectedValueOnce(createBrowserNetworkSuspendedError());

    await expect(service.pushConnection(connection, 'project-1', false, false, true, 'user-1'))
      .rejects.toMatchObject({ name: 'BrowserNetworkSuspendedError' });
    expect(mockRetryQueue.add).not.toHaveBeenCalled();
  });

  it('重试队列回放连接在任务存在性查询遇到浏览器网络挂起时应抛出延后错误', async () => {
    const connection: Connection = {
      id: 'connection-browser-suspended-validation',
      source: 'task-a',
      target: 'task-b',
    };
    taskExistenceResult = {
      data: [],
      error: createBrowserNetworkSuspendedError(),
    };

    await expect(service.pushConnection(connection, 'project-1', false, false, true, 'user-1'))
      .rejects.toMatchObject({ name: 'BrowserNetworkSuspendedError' });
    expect(mockRetryQueue.add).not.toHaveBeenCalled();
    expect(mockConnectionsUpsert).not.toHaveBeenCalled();
  });
});
