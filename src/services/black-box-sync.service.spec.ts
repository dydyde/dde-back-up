import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { BlackBoxSyncService } from './black-box-sync.service';
import { SupabaseClientService } from './supabase-client.service';
import { NetworkAwarenessService } from './network-awareness.service';
import { LoggerService } from './logger.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { AuthService } from './auth.service';
import { ClockSyncService } from './clock-sync.service';
import { SyncRpcClientService } from './sync-rpc-client.service';
import { SessionManagerService } from '../app/core/services/sync/session-manager.service';
import { blackBoxEntriesMap, setBlackBoxEntries } from '../state/focus-stores';
import type { BlackBoxEntry } from '../models/focus';
import { AUTH_CONFIG } from '../config/auth.config';

function createEntry(overrides: Partial<BlackBoxEntry> & Pick<BlackBoxEntry, 'id'>): BlackBoxEntry {
  return {
    projectId: null,
    userId: 'user-1',
    content: 'entry',
    date: '2026-03-04',
    createdAt: '2026-03-04T00:00:00.000Z',
    updatedAt: '2026-03-04T00:00:00.000Z',
    isRead: false,
    isCompleted: false,
    isArchived: false,
    deletedAt: null,
    ...overrides,
  };
}

function createLegacyEntryWithUndefinedDeletedAt(entry: BlackBoxEntry): BlackBoxEntry {
  return { ...entry, deletedAt: undefined } as unknown as BlackBoxEntry;
}

async function flushMicrotasks(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await Promise.resolve();
  }
}

// 创建带 user_id 作用域查询能力的模拟查询对象，用于验证黑匣子远端读取不会跨用户。
function createScopedQuery<TQuery extends Record<string, unknown>>(
  query: TQuery,
): TQuery & { eq: ReturnType<typeof vi.fn> } {
  const scoped = { ...query } as TQuery & { eq: ReturnType<typeof vi.fn> };
  scoped.eq = vi.fn(() => scoped);
  return scoped;
}

// 创建支持链式 eq 与 maybeSingle 的预检查询对象，用于覆盖 push 前置对账路径。
function createPreflightQuery(
  maybeSingle: ReturnType<typeof vi.fn>,
): { eq: ReturnType<typeof vi.fn>; maybeSingle: ReturnType<typeof vi.fn> } {
  const query = {
    eq: vi.fn(),
    maybeSingle,
  };
  query.eq.mockReturnValue(query);
  return query;
}

describe('BlackBoxSyncService', () => {
  let service: BlackBoxSyncService;
  let initDbSpy: ReturnType<typeof vi.spyOn>;
  let setupNetworkSpy: ReturnType<typeof vi.spyOn>;
  let mockSentry: { addBreadcrumb: ReturnType<typeof vi.fn>; captureMessage: ReturnType<typeof vi.fn> };
  let mockSyncRpcClient: {
    isFeatureEnabled: ReturnType<typeof vi.fn>;
    isClientRejected: ReturnType<typeof vi.fn>;
    upsertBlackboxEntry: ReturnType<typeof vi.fn>;
  };
  let authSignals: {
    sessionInitialized: ReturnType<typeof signal<boolean>>;
    runtimeState: ReturnType<typeof signal<'idle' | 'pending' | 'ready' | 'failed'>>;
    authState: ReturnType<typeof signal<{ isCheckingSession: boolean; isLoading: boolean; userId: string | null; email: string | null; error: string | null }>>;
    currentUserId: ReturnType<typeof signal<string | null>>;
  };

  beforeEach(() => {
    initDbSpy = vi.spyOn(
      BlackBoxSyncService.prototype as unknown as { initIndexedDB: () => Promise<void> },
      'initIndexedDB'
    ).mockResolvedValue(undefined);
    setupNetworkSpy = vi.spyOn(
      BlackBoxSyncService.prototype as unknown as { setupNetworkListener: () => void },
      'setupNetworkListener'
    ).mockImplementation(() => {});

    mockSentry = {
      addBreadcrumb: vi.fn(),
      captureMessage: vi.fn(),
    };
    mockSyncRpcClient = {
      isFeatureEnabled: vi.fn(() => false),
      isClientRejected: vi.fn(() => false),
      upsertBlackboxEntry: vi.fn(async () => ({ status: 'applied', serverUpdatedAt: '2026-03-04T00:00:01.000Z', raw: {} })),
    };

    authSignals = {
      sessionInitialized: signal(true),
      runtimeState: signal<'idle' | 'pending' | 'ready' | 'failed'>('ready'),
      authState: signal({
        isCheckingSession: false,
        isLoading: false,
        userId: 'user-1',
        email: null,
        error: null,
      }),
      currentUserId: signal<string | null>('user-1'),
    };

    TestBed.configureTestingModule({
      providers: [
        BlackBoxSyncService,
        {
          provide: SupabaseClientService,
          useValue: {
            isConfigured: true,
            isOfflineMode: vi.fn(() => false),
            clientAsync: vi.fn().mockResolvedValue({}),
          },
        },
        {
          provide: NetworkAwarenessService,
          useValue: {
            isOnline: vi.fn(() => true),
          },
        },
        {
          provide: LoggerService,
          useValue: {
            category: vi.fn(() => ({
              debug: vi.fn(),
              info: vi.fn(),
              warn: vi.fn(),
              error: vi.fn(),
            })),
          },
        },
        {
          provide: AuthService,
          useValue: {
            currentUserId: authSignals.currentUserId,
            isConfigured: true,
            sessionInitialized: authSignals.sessionInitialized,
            authState: authSignals.authState,
            runtimeState: authSignals.runtimeState,
            peekPersistedSessionIdentity: vi.fn(() => ({ userId: 'user-1' })),
          },
        },
        {
          provide: ClockSyncService,
          useValue: {
            isLocalNewer: vi.fn((left: string, right: string) => new Date(left).getTime() > new Date(right).getTime()),
            compareTimestamps: vi.fn((left: string, right: string) => new Date(left).getTime() - new Date(right).getTime()),
            recordServerTimestamp: vi.fn(),
            lastSyncResult: vi.fn(() => ({ reliable: true })),
            needsResync: vi.fn(() => false),
            checkClockDrift: vi.fn().mockResolvedValue({ reliable: true }),
            ensureSynced: vi.fn().mockResolvedValue({ reliable: true }),
          },
        },
        {
          provide: SessionManagerService,
          useValue: {
            isSessionExpiredError: vi.fn(() => false),
            tryRefreshSessionWithSession: vi.fn().mockResolvedValue({ refreshed: false }),
            validateOrRefreshOnResume: vi.fn().mockResolvedValue({
              ok: true,
              refreshed: false,
              deferred: false,
            }),
            getRecentValidationSnapshot: vi.fn(() => null),
          },
        },
        {
          provide: SentryLazyLoaderService,
          useValue: mockSentry,
        },
        { provide: SyncRpcClientService, useValue: mockSyncRpcClient },
      ],
    });

    service = TestBed.inject(BlackBoxSyncService);
  });

  afterEach(() => {
    initDbSpy.mockRestore();
    setupNetworkSpy.mockRestore();
    setBlackBoxEntries([]);
    localStorage.removeItem(AUTH_CONFIG.LOCAL_MODE_CACHE_KEY);
  });

  it('should apply resume pull cooldown by default', async () => {
    const doPullSpy = vi.spyOn(
      service as unknown as { doPullChanges: () => Promise<boolean> },
      'doPullChanges'
    ).mockResolvedValue(true);

    await service.pullChanges({ reason: 'resume' });
    await service.pullChanges({ reason: 'resume' });

    expect(doPullSpy).toHaveBeenCalledTimes(1);
  });

  it('should bypass cooldown when force=true', async () => {
    const doPullSpy = vi.spyOn(
      service as unknown as { doPullChanges: () => Promise<boolean> },
      'doPullChanges'
    ).mockResolvedValue(true);

    await service.pullChanges({ reason: 'resume' });
    await service.pullChanges({ reason: 'resume', force: true });

    expect(doPullSpy).toHaveBeenCalledTimes(2);
  });

  it('should reuse in-flight pull promise (single-flight)', async () => {
    let resolvePull: (() => void) | null = null;
    const doPullSpy = vi.spyOn(
      service as unknown as { doPullChanges: () => Promise<boolean> },
      'doPullChanges'
    ).mockReturnValue(new Promise<boolean>(resolve => {
      resolvePull = () => resolve(true);
    }));

    const p1 = service.pullChanges({ reason: 'resume', force: true });
    const p2 = service.pullChanges({ reason: 'resume', force: true });

    await flushMicrotasks();

    expect(doPullSpy).toHaveBeenCalledTimes(1);

    resolvePull!();
    await Promise.all([p1, p2]);
  });

  it('should fall back to local cache when remote transport is marked unavailable', async () => {
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      isOfflineMode: ReturnType<typeof vi.fn>;
    };
    supabase.isOfflineMode.mockReturnValue(true);

    const doPullSpy = vi.spyOn(
      service as unknown as { doPullChanges: () => Promise<boolean> },
      'doPullChanges'
    ).mockResolvedValue(true);
    const loadLocalSpy = vi.spyOn(
      service as unknown as { loadFromLocal: () => Promise<unknown[]> },
      'loadFromLocal'
    ).mockResolvedValue([]);

    await service.pullChanges({ reason: 'resume', force: true });

    expect(doPullSpy).not.toHaveBeenCalled();
    expect(loadLocalSpy).toHaveBeenCalledTimes(1);
  });

  it('should defer resume pull until session validation is ready', async () => {
    const sessionManager = TestBed.inject(SessionManagerService) as unknown as {
      validateOrRefreshOnResume: ReturnType<typeof vi.fn>;
    };
    const doPullSpy = vi.spyOn(
      service as unknown as { doPullChanges: () => Promise<boolean> },
      'doPullChanges'
    ).mockResolvedValue(true);

    sessionManager.validateOrRefreshOnResume.mockResolvedValueOnce({
      ok: false,
      refreshed: false,
      deferred: true,
      reason: 'client-unready',
    });

    await service.pullChanges({ reason: 'resume', force: true });

    expect(sessionManager.validateOrRefreshOnResume).toHaveBeenCalledWith('blackbox:resume');
    expect(doPullSpy).not.toHaveBeenCalled();
  });

  it('should defer gate-review pull until session validation is ready', async () => {
    const sessionManager = TestBed.inject(SessionManagerService) as unknown as {
      validateOrRefreshOnResume: ReturnType<typeof vi.fn>;
    };
    const doPullSpy = vi.spyOn(
      service as unknown as { doPullChanges: () => Promise<boolean> },
      'doPullChanges'
    ).mockResolvedValue(true);

    sessionManager.validateOrRefreshOnResume.mockResolvedValueOnce({
      ok: false,
      refreshed: false,
      deferred: true,
      reason: 'client-unready',
    });

    await service.pullChanges({ reason: 'gate-review', force: true });

    expect(sessionManager.validateOrRefreshOnResume).toHaveBeenCalledWith('blackbox:gate-review');
    expect(doPullSpy).not.toHaveBeenCalled();
  });

  it('should reuse a recent valid session snapshot before resume pull', async () => {
    const sessionManager = TestBed.inject(SessionManagerService) as unknown as {
      getRecentValidationSnapshot: ReturnType<typeof vi.fn>;
      validateOrRefreshOnResume: ReturnType<typeof vi.fn>;
    };
    const doPullSpy = vi.spyOn(
      service as unknown as { doPullChanges: () => Promise<boolean> },
      'doPullChanges'
    ).mockResolvedValue(true);

    sessionManager.getRecentValidationSnapshot.mockReturnValueOnce({
      valid: true,
      userId: 'user-1',
      at: Date.now(),
    });

    await service.pullChanges({ reason: 'resume', force: true });

    expect(sessionManager.validateOrRefreshOnResume).not.toHaveBeenCalled();
    expect(doPullSpy).toHaveBeenCalledTimes(1);
  });

  it('should block duplicate pull by freshness window and report to Sentry', async () => {
    const doPullSpy = vi.spyOn(
      service as unknown as { doPullChanges: () => Promise<boolean> },
      'doPullChanges'
    ).mockResolvedValue(true);

    // 首次拉取成功
    await service.pullChanges({ reason: 'manual', force: true });
    expect(doPullSpy).toHaveBeenCalledTimes(1);

    // 窗口内第二次调用应被阻断
    await service.pullChanges({ reason: 'manual' });
    expect(doPullSpy).toHaveBeenCalledTimes(1);

    // 验证结构化 Sentry 上报
    expect(mockSentry.captureMessage).toHaveBeenCalledWith(
      'BlackBox duplicate pull blocked',
      expect.objectContaining({
        level: 'info',
        tags: expect.objectContaining({
          classification: 'duplicate_blocked',
        }),
      })
    );
  });

  it('should bypass freshness window when pending entries need authoritative reconcile', async () => {
    const doPullSpy = vi.spyOn(
      service as unknown as { doPullChanges: () => Promise<boolean> },
      'doPullChanges'
    ).mockResolvedValue(true);
    const pendingEntry = createEntry({
      id: crypto.randomUUID(),
      syncStatus: 'pending',
    });

    setBlackBoxEntries([pendingEntry]);
    (service as unknown as { lastPullTime: number }).lastPullTime = Date.now();

    await service.pullChanges({ reason: 'panel-open' });

    expect(doPullSpy).toHaveBeenCalledTimes(1);
    expect(mockSentry.captureMessage).not.toHaveBeenCalled();
  });

  it('should bypass resume cooldown when pending entries need authoritative reconcile', async () => {
    const doPullSpy = vi.spyOn(
      service as unknown as { doPullChanges: () => Promise<boolean> },
      'doPullChanges'
    ).mockResolvedValue(true);
    const pendingEntry = createEntry({
      id: crypto.randomUUID(),
      syncStatus: 'pending',
    });

    setBlackBoxEntries([pendingEntry]);
    (service as unknown as { lastResumePullAt: number }).lastResumePullAt = Date.now();

    await service.pullChanges({ reason: 'resume' });

    expect(doPullSpy).toHaveBeenCalledTimes(1);
  });

  it('should not report passive view refresh duplicates to Sentry', async () => {
    const doPullSpy = vi.spyOn(
      service as unknown as { doPullChanges: () => Promise<boolean> },
      'doPullChanges'
    ).mockResolvedValue(true);

    await service.pullChanges({ reason: 'panel-open', force: true });
    mockSentry.captureMessage.mockClear();

    await service.pullChanges({ reason: 'panel-open' });

    expect(doPullSpy).toHaveBeenCalledTimes(1);
    expect(mockSentry.captureMessage).not.toHaveBeenCalled();
  });

  it('should resubscribe after realtime circuit window elapses when desired user is unchanged', async () => {
    vi.useFakeTimers();
    try {
      const syncRealtimeSpy = vi.spyOn(
        service as unknown as {
          syncRealtimeSubscription: (userId: string | null, generation: number) => Promise<void>;
        },
        'syncRealtimeSubscription'
      ).mockResolvedValue(undefined);

      (service as unknown as {
        realtimeDesiredUserId: string | null;
        realtimeSubscriptionGeneration: number;
      }).realtimeDesiredUserId = 'user-1';
      (service as unknown as {
        realtimeDesiredUserId: string | null;
        realtimeSubscriptionGeneration: number;
      }).realtimeSubscriptionGeneration = 7;

      (service as unknown as {
        scheduleRealtimeCircuitRetry: (userId: string, delayMs: number, generation: number) => void;
      }).scheduleRealtimeCircuitRetry('user-1', 1_000, 7);

      vi.advanceTimersByTime(1_000);
      await flushMicrotasks();

      expect(syncRealtimeSpy).toHaveBeenCalledWith('user-1', 8);
    } finally {
      vi.useRealTimers();
    }
  });

  it('should not resubscribe after realtime circuit window when desired user changed', async () => {
    vi.useFakeTimers();
    try {
      const syncRealtimeSpy = vi.spyOn(
        service as unknown as {
          syncRealtimeSubscription: (userId: string | null, generation: number) => Promise<void>;
        },
        'syncRealtimeSubscription'
      ).mockResolvedValue(undefined);

      (service as unknown as {
        realtimeDesiredUserId: string | null;
        realtimeSubscriptionGeneration: number;
      }).realtimeDesiredUserId = 'user-1';
      (service as unknown as {
        realtimeDesiredUserId: string | null;
        realtimeSubscriptionGeneration: number;
      }).realtimeSubscriptionGeneration = 3;

      (service as unknown as {
        scheduleRealtimeCircuitRetry: (userId: string, delayMs: number, generation: number) => void;
      }).scheduleRealtimeCircuitRetry('user-1', 1_000, 3);
      (service as unknown as {
        realtimeDesiredUserId: string | null;
      }).realtimeDesiredUserId = 'user-2';

      vi.advanceTimersByTime(1_000);
      await flushMicrotasks();

      expect(syncRealtimeSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('should skip stale push payloads when a newer local snapshot already exists', async () => {
    const entryId = crypto.randomUUID();
    const olderEntry = createEntry({
      id: entryId,
      updatedAt: '2026-03-04T00:00:00.000Z',
      isCompleted: false,
    });
    const newerEntry = createEntry({
      id: entryId,
      updatedAt: '2026-03-04T00:00:05.000Z',
      isCompleted: true,
    });
    const from = vi.fn();
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };

    setBlackBoxEntries([newerEntry]);
    supabase.clientAsync.mockResolvedValue({ from });

    await expect(service.pushToServer(olderEntry)).resolves.toBe(true);
    expect(from).not.toHaveBeenCalled();
  });

  it('should re-enqueue newer pending local snapshot when stale queued payload is skipped', async () => {
    const entryId = crypto.randomUUID();
    const olderEntry = createEntry({
      id: entryId,
      updatedAt: '2026-03-04T00:00:00.000Z',
      syncStatus: 'pending',
    });
    const newerPendingEntry = createEntry({
      id: entryId,
      content: 'newer pending edit',
      updatedAt: '2026-03-04T00:00:05.000Z',
      syncStatus: 'pending',
    });
    const from = vi.fn();
    const enqueue = vi.fn();
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };
    const saveToLocalSpy = vi.spyOn(service, 'saveToLocal').mockResolvedValue(undefined);

    setBlackBoxEntries([newerPendingEntry]);
    (service as unknown as { retryQueueHandler: ((entry: BlackBoxEntry) => void) | null }).retryQueueHandler = enqueue;
    supabase.clientAsync.mockResolvedValue({ from });

    await expect(service.pushToServer(olderEntry)).resolves.toBe(true);

    expect(from).not.toHaveBeenCalled();
    expect(saveToLocalSpy).toHaveBeenCalledWith(expect.objectContaining({
      id: entryId,
      content: 'newer pending edit',
      syncStatus: 'pending',
    }));
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      id: entryId,
      content: 'newer pending edit',
      syncStatus: 'pending',
    }));
  });

  it('should use sync RPC for black box pushes when the feature flag is enabled', async () => {
    const entry = createEntry({
      id: crypto.randomUUID(),
      updatedAt: '2026-03-04T00:00:00.000Z',
      syncStatus: 'pending',
    });
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    mockSyncRpcClient.upsertBlackboxEntry.mockResolvedValueOnce({
      status: 'applied',
      serverUpdatedAt: '2026-03-04T00:00:01.000Z',
      raw: {},
    });
    const maybeSingle = vi.fn(async () => ({ data: null, error: null }));
    const preflightQuery = createPreflightQuery(maybeSingle);
    const upsert = vi.fn();
    const from = vi.fn(() => ({
      select: vi.fn(() => preflightQuery),
      upsert,
    }));
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };
    const saveToLocalSpy = vi.spyOn(service, 'saveToLocal').mockResolvedValue(undefined);
    setBlackBoxEntries([entry]);
    supabase.clientAsync.mockResolvedValue({ from });

    await expect(service.pushToServer(entry)).resolves.toBe(true);

    expect(preflightQuery.eq).toHaveBeenCalledWith('user_id', 'user-1');
    expect(preflightQuery.eq).toHaveBeenCalledWith('id', entry.id);
    expect(mockSyncRpcClient.upsertBlackboxEntry).toHaveBeenCalledWith(expect.objectContaining({
      operationId: expect.any(String),
      entry,
      baseUpdatedAt: null,
    }));
    expect(upsert).not.toHaveBeenCalled();
    expect(saveToLocalSpy).toHaveBeenCalledWith(expect.objectContaining({
      id: entry.id,
      updatedAt: '2026-03-04T00:00:01.000Z',
      syncStatus: 'synced',
    }));
  });

  it('should hydrate a blank retry payload from the latest local black box content before RPC push', async () => {
    const entryId = crypto.randomUUID();
    const queuedEntry = createEntry({
      id: entryId,
      content: '',
      updatedAt: '2026-03-04T00:00:00.000Z',
      syncStatus: 'pending',
    });
    const latestLocalEntry = createEntry({
      id: entryId,
      content: 'local full content',
      updatedAt: queuedEntry.updatedAt,
      syncStatus: 'pending',
    });
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    mockSyncRpcClient.upsertBlackboxEntry.mockResolvedValueOnce({
      status: 'applied',
      serverUpdatedAt: '2026-03-04T00:00:01.000Z',
      raw: {},
    });
    const maybeSingle = vi.fn(async () => ({ data: null, error: null }));
    const preflightQuery = createPreflightQuery(maybeSingle);
    const upsert = vi.fn();
    const from = vi.fn(() => ({
      select: vi.fn(() => preflightQuery),
      upsert,
    }));
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };
    const saveToLocalSpy = vi.spyOn(service, 'saveToLocal').mockResolvedValue(undefined);
    setBlackBoxEntries([latestLocalEntry]);
    supabase.clientAsync.mockResolvedValue({ from });

    await expect(service.pushToServer(queuedEntry)).resolves.toBe(true);

    expect(mockSyncRpcClient.upsertBlackboxEntry).toHaveBeenCalledWith(expect.objectContaining({
      entry: expect.objectContaining({
        id: entryId,
        content: 'local full content',
      }),
    }));
    expect(upsert).not.toHaveBeenCalled();
    expect(saveToLocalSpy).toHaveBeenCalledWith(expect.objectContaining({
      id: entryId,
      content: 'local full content',
      syncStatus: 'synced',
    }));
  });

  it('should preserve existing server black box content when a blank retry payload is replayed', async () => {
    const entryId = crypto.randomUUID();
    const queuedEntry = createEntry({
      id: entryId,
      content: '',
      updatedAt: '2026-03-04T00:00:05.000Z',
      isCompleted: true,
      syncStatus: 'pending',
    });
    const serverRow = {
      id: entryId,
      project_id: null,
      user_id: 'user-1',
      content: 'server full content',
      focus_meta: null,
      date: '2026-03-04',
      created_at: '2026-03-04T00:00:00.000Z',
      updated_at: '2026-03-04T00:00:00.000Z',
      is_read: false,
      is_completed: false,
      is_archived: false,
      snooze_until: null,
      snooze_count: 0,
      deleted_at: null,
    };
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    mockSyncRpcClient.upsertBlackboxEntry.mockResolvedValueOnce({
      status: 'applied',
      serverUpdatedAt: '2026-03-04T00:00:06.000Z',
      raw: {},
    });
    const maybeSingle = vi.fn(async () => ({ data: serverRow, error: null }));
    const preflightQuery = createPreflightQuery(maybeSingle);
    const upsert = vi.fn();
    const from = vi.fn(() => ({
      select: vi.fn(() => preflightQuery),
      upsert,
    }));
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };
    const saveToLocalSpy = vi.spyOn(service, 'saveToLocal').mockResolvedValue(undefined);
    setBlackBoxEntries([queuedEntry]);
    supabase.clientAsync.mockResolvedValue({ from });

    await expect(service.pushToServer(queuedEntry)).resolves.toBe(true);

    expect(mockSyncRpcClient.upsertBlackboxEntry).toHaveBeenCalledWith(expect.objectContaining({
      entry: expect.objectContaining({
        id: entryId,
        content: 'server full content',
        isCompleted: true,
      }),
      baseUpdatedAt: serverRow.updated_at,
    }));
    expect(upsert).not.toHaveBeenCalled();
    expect(saveToLocalSpy).toHaveBeenCalledWith(expect.objectContaining({
      id: entryId,
      content: 'server full content',
      syncStatus: 'synced',
    }));
  });

  it('should reconcile local pending state when sync RPC reports remote-newer', async () => {
    const entry = createEntry({
      id: crypto.randomUUID(),
      updatedAt: '2026-03-04T00:00:00.000Z',
      syncStatus: 'pending',
    });
    const remoteRow = {
      id: entry.id,
      project_id: null,
      user_id: 'user-1',
      content: 'entry',
      focus_meta: null,
      date: '2026-03-04',
      created_at: '2026-03-04T00:00:00.000Z',
      updated_at: '2026-03-04T00:00:05.000Z',
      is_read: false,
      is_completed: true,
      is_archived: false,
      snooze_until: null,
      snooze_count: 0,
      deleted_at: null,
    };
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    mockSyncRpcClient.upsertBlackboxEntry.mockResolvedValueOnce({
      status: 'remote-newer',
      remoteUpdatedAt: '2026-03-04T00:00:05.000Z',
      raw: {},
    });
    const maybeSingle = vi.fn()
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: remoteRow, error: null });
    const preflightQuery = createPreflightQuery(maybeSingle);
    const upsert = vi.fn();
    const from = vi.fn(() => ({
      select: vi.fn(() => preflightQuery),
      upsert,
    }));
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };
    const saveToLocalSpy = vi.spyOn(service, 'saveToLocal').mockResolvedValue(undefined);
    setBlackBoxEntries([entry]);
    supabase.clientAsync.mockResolvedValue({ from });

    await expect(service.pushToServer(entry)).resolves.toBe(true);

    expect(upsert).not.toHaveBeenCalled();
    expect(saveToLocalSpy).toHaveBeenCalledWith(expect.objectContaining({
      id: entry.id,
      isCompleted: true,
      syncStatus: 'synced',
    }));
    expect(blackBoxEntriesMap().get(entry.id)).toEqual(expect.objectContaining({
      isCompleted: true,
      syncStatus: 'synced',
    }));
    expect(mockSentry.captureMessage).toHaveBeenCalledWith(
      'sync_rpc_blackbox_remote_newer',
      expect.objectContaining({ level: 'warning' }),
    );
  });

  it('should reconcile server authority instead of marking stale RPC payload as synced', async () => {
    const entry = createEntry({
      id: crypto.randomUUID(),
      updatedAt: '2026-03-04T00:00:00.000Z',
      isCompleted: false,
      syncStatus: 'pending',
    });
    const remoteRow = {
      id: entry.id,
      project_id: null,
      user_id: 'user-1',
      content: 'entry',
      focus_meta: null,
      date: '2026-03-04',
      created_at: '2026-03-04T00:00:00.000Z',
      updated_at: '2026-03-04T00:00:08.000Z',
      is_read: false,
      is_completed: true,
      is_archived: false,
      snooze_until: null,
      snooze_count: 0,
      deleted_at: null,
    };
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    mockSyncRpcClient.upsertBlackboxEntry.mockResolvedValueOnce({
      status: 'applied',
      serverUpdatedAt: '2026-03-04T00:00:08.000Z',
      stalePayload: true,
      raw: { stale_payload: true },
    });
    const maybeSingle = vi.fn()
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: remoteRow, error: null });
    const preflightQuery = createPreflightQuery(maybeSingle);
    const upsert = vi.fn();
    const from = vi.fn(() => ({
      select: vi.fn(() => preflightQuery),
      upsert,
    }));
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };
    const saveToLocalSpy = vi.spyOn(service, 'saveToLocal').mockResolvedValue(undefined);
    setBlackBoxEntries([entry]);
    supabase.clientAsync.mockResolvedValue({ from });

    await expect(service.pushToServer(entry)).resolves.toBe(true);

    expect(upsert).not.toHaveBeenCalled();
    expect(saveToLocalSpy).toHaveBeenCalledWith(expect.objectContaining({
      id: entry.id,
      isCompleted: true,
      syncStatus: 'synced',
    }));
    expect(saveToLocalSpy).not.toHaveBeenCalledWith(expect.objectContaining({
      id: entry.id,
      isCompleted: false,
      syncStatus: 'synced',
    }));
  });

  it('should defer push when preflight cannot be scoped by user id', async () => {
    const entry = createEntry({
      id: crypto.randomUUID(),
      updatedAt: '2026-03-04T00:00:00.000Z',
      syncStatus: 'pending',
    });
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    const select = vi.fn(() => ({
      maybeSingle: vi.fn(async () => ({ data: null, error: null })),
    }));
    const upsert = vi.fn();
    const from = vi.fn(() => ({ select, upsert }));
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };
    setBlackBoxEntries([entry]);
    supabase.clientAsync.mockResolvedValue({ from });

    await expect(service.pushToServer(entry)).resolves.toBe(false);

    expect(mockSyncRpcClient.upsertBlackboxEntry).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(blackBoxEntriesMap().get(entry.id)).toEqual(expect.objectContaining({
      id: entry.id,
      syncStatus: 'pending',
    }));
  });

  it('should not overwrite a newer local snapshot that arrives while an older push is in flight', async () => {
    const entryId = crypto.randomUUID();
    const olderEntry = createEntry({
      id: entryId,
      updatedAt: '2026-03-04T00:00:00.000Z',
      isCompleted: false,
    });
    const newerEntry = createEntry({
      id: entryId,
      updatedAt: '2026-03-04T00:00:05.000Z',
      isCompleted: true,
    });
    const preflightQuery = createPreflightQuery(vi.fn(async () => ({ data: null, error: null })));
    const from = vi.fn(() => ({
      select: vi.fn(() => preflightQuery),
      insert: vi.fn(() => ({
        select: vi.fn(() => ({
          single: vi.fn(async () => {
            setBlackBoxEntries([newerEntry]);
            return {
              data: { updated_at: olderEntry.updatedAt },
              error: null,
            };
          }),
        })),
      })),
      update: vi.fn(),
    }));
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };
    const saveToLocalSpy = vi.spyOn(service, 'saveToLocal').mockResolvedValue(undefined);

    setBlackBoxEntries([olderEntry]);
    supabase.clientAsync.mockResolvedValue({ from });

    await expect(service.pushToServer(olderEntry)).resolves.toBe(true);
    // 【2026-05-18 根因修复·阶段 2】更晚的内存快照必须被持久化到 IDB，否则新会话冷启动
    // 时仍会看到旧的 olderEntry 并继续把"待同步"标签挂在 UI 上。
    // 但绝对不能用 olderEntry 覆盖 IDB——那才是这个测试要守住的本质不变量。
    expect(saveToLocalSpy).not.toHaveBeenCalledWith(expect.objectContaining({
      updatedAt: olderEntry.updatedAt,
    }));
    expect(blackBoxEntriesMap().get(entryId)).toEqual(expect.objectContaining({
      updatedAt: newerEntry.updatedAt,
      isCompleted: true,
    }));
  });

  it('should not overwrite a newer local pending snapshot when preflight sees a newer server row', async () => {
    const entryId = crypto.randomUUID();
    const olderEntry = createEntry({
      id: entryId,
      updatedAt: '2026-03-04T00:00:00.000Z',
      isCompleted: false,
    });
    const newerLocalEntry = createEntry({
      id: entryId,
      updatedAt: '2026-03-04T00:00:05.000Z',
      isCompleted: true,
      syncStatus: 'pending',
    });
    const serverRow = {
      id: entryId,
      project_id: null,
      user_id: 'user-1',
      content: 'entry',
      focus_meta: null,
      date: '2026-03-04',
      created_at: '2026-03-04T00:00:00.000Z',
      updated_at: '2026-03-04T00:00:03.000Z',
      is_read: false,
      is_completed: false,
      is_archived: false,
      snooze_until: null,
      snooze_count: 0,
      deleted_at: null,
    };
    const maybeSingle = vi.fn(async () => {
      setBlackBoxEntries([newerLocalEntry]);
      return { data: serverRow, error: null };
    });
    const preflightQuery = createPreflightQuery(maybeSingle);
    const select = vi.fn(() => preflightQuery);
    const upsert = vi.fn();
    const from = vi.fn(() => ({ select, upsert }));
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };
    const saveToLocalSpy = vi.spyOn(service, 'saveToLocal').mockResolvedValue(undefined);

    setBlackBoxEntries([olderEntry]);
    supabase.clientAsync.mockResolvedValue({ from });

    await expect(service.pushToServer(olderEntry)).resolves.toBe(true);

    expect(upsert).not.toHaveBeenCalled();
    expect(saveToLocalSpy).not.toHaveBeenCalledWith(expect.objectContaining({
      updatedAt: serverRow.updated_at,
    }));
    expect(blackBoxEntriesMap().get(entryId)).toEqual(expect.objectContaining({
      updatedAt: newerLocalEntry.updatedAt,
      isCompleted: true,
      syncStatus: 'pending',
    }));
  });
  it('should map focus_meta from database row into focusMeta', () => {
    const mapRowToEntry = (service as unknown as {
      mapRowToEntry: (row: Record<string, unknown>) => { focusMeta?: unknown };
    }).mapRowToEntry.bind(service);

    const mapped = mapRowToEntry({
      id: 'entry-1',
      project_id: null,
      user_id: 'user-1',
      content: 'inline detail',
      focus_meta: {
        source: 'focus-console-inline',
        sessionId: 'session-1',
        title: 'Inline task',
        detail: 'inline detail',
        lane: 'backup',
        expectedMinutes: 20,
        waitMinutes: 10,
        cognitiveLoad: 'low',
        dockEntryId: 'dock-entry-1',
      },
      date: '2026-03-04',
      created_at: '2026-03-04T00:00:00.000Z',
      updated_at: '2026-03-04T00:00:00.000Z',
      is_read: false,
      is_completed: false,
      is_archived: false,
      snooze_until: null,
      snooze_count: 0,
      deleted_at: null,
    });

    expect(mapped.focusMeta).toEqual({
      source: 'focus-console-inline',
      sessionId: 'session-1',
      title: 'Inline task',
      detail: 'inline detail',
      lane: 'backup',
      expectedMinutes: 20,
      waitMinutes: 10,
      cognitiveLoad: 'low',
      dockEntryId: 'dock-entry-1',
    });
  });

  it('should reconcile pending local entries against server rows even when delta pull returns empty', async () => {
    const entryId = crypto.randomUUID();
    const pendingEntry = createEntry({
      id: entryId,
      updatedAt: '2026-03-04T00:00:00.000Z',
      isRead: true,
      syncStatus: 'pending',
    });
    const remoteRow = {
      id: entryId,
      project_id: null,
      user_id: 'user-1',
      content: 'entry',
      focus_meta: null,
      date: '2026-03-04',
      created_at: '2026-03-04T00:00:00.000Z',
      updated_at: '2026-03-04T00:00:00.000Z',
      is_read: true,
      is_completed: false,
      is_archived: false,
      snooze_until: null,
      snooze_count: 0,
      deleted_at: null,
    };
    const inQuery = vi.fn().mockResolvedValue({ data: [remoteRow], error: null });
    const orderedResult = {
      data: [],
      error: null,
      order: vi.fn(() => orderedResult),
    };
    const gtQuery = vi.fn(() => orderedResult);
    const scopedQuery = createScopedQuery({
      gt: gtQuery,
      in: inQuery,
    });
    const selectQuery = vi.fn(() => scopedQuery);
    const from = vi.fn(() => ({ select: selectQuery }));
    const rpc = vi.fn().mockResolvedValue({ data: '2026-03-05T00:00:00.000Z', error: null });
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };
    vi.spyOn(service, 'saveToLocal').mockResolvedValue(undefined);
    (service as unknown as { lastSyncTime: string | null }).lastSyncTime = '2026-03-05T00:00:00.000Z';
    supabase.clientAsync.mockResolvedValue({ from, rpc });
    setBlackBoxEntries([pendingEntry]);

    await service.pullChanges({ reason: 'panel-open', force: true });

    expect(scopedQuery.eq).toHaveBeenCalledWith('user_id', 'user-1');
    expect(inQuery).toHaveBeenCalledWith('id', [entryId]);
    expect(blackBoxEntriesMap().get(entryId)?.syncStatus).toBe('synced');
  });

  it('should preserve local black box content when pulling a newer blank remote row', async () => {
    const entryId = crypto.randomUUID();
    const localEntry = createEntry({
      id: entryId,
      content: 'local full content',
      updatedAt: '2026-03-04T00:00:00.000Z',
      syncStatus: 'synced',
    });
    const remoteRow = {
      id: entryId,
      project_id: null,
      user_id: 'user-1',
      content: '',
      focus_meta: null,
      date: '2026-03-04',
      created_at: '2026-03-04T00:00:00.000Z',
      updated_at: '2026-03-04T00:00:05.000Z',
      is_read: false,
      is_completed: true,
      is_archived: false,
      snooze_until: null,
      snooze_count: 0,
      deleted_at: null,
    };
    const orderedResult = {
      data: [remoteRow],
      error: null,
      order: vi.fn(() => orderedResult),
    };
    const gtQuery = vi.fn(() => orderedResult);
    const selectQuery = vi.fn(() => createScopedQuery({
      gt: gtQuery,
    }));
    const from = vi.fn(() => ({ select: selectQuery }));
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };
    const saveToLocalSpy = vi.spyOn(service, 'saveToLocal').mockResolvedValue(undefined);
    setBlackBoxEntries([localEntry]);
    supabase.clientAsync.mockResolvedValue({ from, rpc });

    await service.pullChanges({ reason: 'panel-open', force: true });

    expect(saveToLocalSpy).toHaveBeenCalledWith(expect.objectContaining({
      id: entryId,
      content: 'local full content',
      isCompleted: true,
      syncStatus: 'synced',
    }));
    expect(blackBoxEntriesMap().get(entryId)).toEqual(expect.objectContaining({
      content: 'local full content',
      isCompleted: true,
      syncStatus: 'synced',
    }));
  });

  it('should pull black box deltas with a safety lookback and stable id ordering', async () => {
    const orderedResult = {
      data: [],
      error: null,
      order: vi.fn(() => orderedResult),
    };
    const gtQuery = vi.fn(() => orderedResult);
    const scopedQuery = createScopedQuery({
      gt: gtQuery,
    });
    const selectQuery = vi.fn(() => scopedQuery);
    const from = vi.fn(() => ({ select: selectQuery }));
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };
    vi.spyOn(service, 'saveToLocal').mockResolvedValue(undefined);
    (service as unknown as { currentSyncUserId: string | null }).currentSyncUserId = 'user-1';
    (service as unknown as { lastSyncTime: string | null }).lastSyncTime = '2026-03-05T00:00:30.000Z';
    supabase.clientAsync.mockResolvedValue({ from, rpc });

    await service.pullChanges({ reason: 'panel-open', force: true });

    expect(scopedQuery.eq).toHaveBeenCalledWith('user_id', 'user-1');
    expect(gtQuery).toHaveBeenCalledWith('updated_at', '2026-03-05T00:00:00.000Z');
    expect(orderedResult.order).toHaveBeenCalledWith('updated_at', { ascending: true });
    expect(orderedResult.order).toHaveBeenCalledWith('id', { ascending: true });
  });

  it('should scope delta pull with resolved session user when caller has no expected user', async () => {
    const orderedResult = {
      data: [],
      error: null,
      order: vi.fn(() => orderedResult),
    };
    const gtQuery = vi.fn(() => orderedResult);
    const scopedQuery = createScopedQuery({
      gt: gtQuery,
    });
    const selectQuery = vi.fn(() => scopedQuery);
    const from = vi.fn(() => ({ select: selectQuery }));
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };
    vi.spyOn(service, 'saveToLocal').mockResolvedValue(undefined);
    supabase.clientAsync.mockResolvedValue({ from, rpc });

    await (service as unknown as {
      doPullChanges: (preferRemoteForSyncedLocalDuringPull: boolean, expectedUserId?: string) => Promise<boolean>;
    }).doPullChanges(false, undefined);

    expect(scopedQuery.eq).toHaveBeenCalledWith('user_id', 'user-1');
    expect(gtQuery).toHaveBeenCalledWith('updated_at', '1970-01-01T00:00:00Z');
  });

  it('should not mark pull fresh when delta query cannot be user scoped', async () => {
    const gtQuery = vi.fn(() => ({
      data: [],
      error: null,
      order: vi.fn(),
    }));
    const selectQuery = vi.fn(() => ({
      gt: gtQuery,
    }));
    const from = vi.fn(() => ({ select: selectQuery }));
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };
    vi.spyOn(service, 'loadFromLocal').mockResolvedValue([]);
    supabase.clientAsync.mockResolvedValue({ from, rpc });

    await service.pullChanges({ reason: 'panel-open', force: true });

    expect(gtQuery).not.toHaveBeenCalled();
    expect((service as unknown as { lastPullTime: number }).lastPullTime).toBe(0);
  });

  it('should page black box delta pulls to avoid unbounded Supabase reads', async () => {
    const rows = [0, 1, 2].map(index => ({
      id: crypto.randomUUID(),
      project_id: null,
      user_id: 'user-1',
      content: `entry ${index}`,
      focus_meta: null,
      date: '2026-03-04',
      created_at: '2026-03-04T00:00:00.000Z',
      updated_at: `2026-03-05T00:00:0${index}.000Z`,
      is_read: false,
      is_completed: false,
      is_archived: false,
      snooze_until: null,
      snooze_count: 0,
      deleted_at: null,
    }));
    let page = 0;
    const limit = vi.fn(() => Promise.resolve({
      data: page++ === 0 ? rows.slice(0, 2) : rows.slice(2),
      error: null,
    }));
    const orderedResult = {
      limit,
      order: vi.fn(() => orderedResult),
    };
    const gtQuery = vi.fn(() => orderedResult);
    const orQuery = vi.fn(() => orderedResult);
    const selectQuery = vi.fn(() => createScopedQuery({
      gt: gtQuery,
      or: orQuery,
    }));
    const from = vi.fn(() => ({ select: selectQuery }));
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };
    vi.spyOn(service, 'saveToLocal').mockResolvedValue(undefined);
    (service as unknown as { currentSyncUserId: string | null }).currentSyncUserId = 'user-1';
    (service as unknown as { BLACKBOX_PULL_PAGE_SIZE: number }).BLACKBOX_PULL_PAGE_SIZE = 2;
    supabase.clientAsync.mockResolvedValue({ from, rpc });

    await service.pullChanges({ reason: 'panel-open', force: true });

    expect(limit).toHaveBeenCalledWith(2);
    expect(limit).toHaveBeenCalledTimes(2);
    expect(gtQuery).toHaveBeenCalledWith('updated_at', '1970-01-01T00:00:00Z');
    expect(orQuery).toHaveBeenCalledWith(expect.stringContaining(`id.gt.${rows[1].id}`));
    expect(blackBoxEntriesMap().size).toBe(3);
  });

  it('should not advance the black box cursor in memory when cursor persistence fails', async () => {
    const entryId = crypto.randomUUID();
    const remoteRow = {
      id: entryId,
      project_id: null,
      user_id: 'user-1',
      content: 'entry',
      focus_meta: null,
      date: '2026-03-04',
      created_at: '2026-03-04T00:00:00.000Z',
      updated_at: '2026-03-05T00:00:30.000Z',
      is_read: false,
      is_completed: false,
      is_archived: false,
      snooze_until: null,
      snooze_count: 0,
      deleted_at: null,
    };
    const orderedResult = {
      data: [remoteRow],
      error: null,
      order: vi.fn(() => orderedResult),
    };
    const gtQuery = vi.fn(() => orderedResult);
    const selectQuery = vi.fn(() => createScopedQuery({
      gt: gtQuery,
    }));
    const from = vi.fn(() => ({ select: selectQuery }));
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };
    const tx = {
      objectStore: vi.fn(() => ({
        get: vi.fn(() => {
          const request = {
            result: null,
            onsuccess: null as ((ev: Event) => void) | null,
            onerror: null as ((ev: Event) => void) | null,
          };
          queueMicrotask(() => request.onsuccess?.(new Event('success')));
          return request;
        }),
        put: vi.fn(() => queueMicrotask(() => tx.onerror?.(new Event('error')))),
      })),
      oncomplete: null as ((ev: Event) => void) | null,
      onerror: null as ((ev: Event) => void) | null,
      onabort: null as ((ev: Event) => void) | null,
      error: new Error('cursor write failed'),
    };

    vi.spyOn(service, 'saveToLocal').mockResolvedValue(undefined);
    (service as unknown as { currentSyncUserId: string | null }).currentSyncUserId = 'user-1';
    (service as unknown as { db: unknown }).db = {
      transaction: vi.fn(() => tx),
    };
    supabase.clientAsync.mockResolvedValue({ from, rpc });

    await service.pullChanges({ reason: 'panel-open', force: true });

    expect((service as unknown as { lastSyncCursor: unknown }).lastSyncCursor).toBeNull();
    expect((service as unknown as { lastSyncTime: unknown }).lastSyncTime).toBeNull();
  });

  it('should clear pending when server already reflects the same newer-local mutation', async () => {
    const entryId = crypto.randomUUID();
    const pendingEntry = createEntry({
      id: entryId,
      updatedAt: '2026-03-05T00:00:00.000Z',
      isRead: true,
      syncStatus: 'pending',
    });
    const remoteRow = {
      id: entryId,
      project_id: null,
      user_id: 'user-1',
      content: 'entry',
      focus_meta: null,
      date: '2026-03-04',
      created_at: '2026-03-04T00:00:00.000Z',
      updated_at: '2026-03-04T00:00:00.000Z',
      is_read: true,
      is_completed: false,
      is_archived: false,
      snooze_until: null,
      snooze_count: 0,
      deleted_at: null,
    };
    const inQuery = vi.fn().mockResolvedValue({ data: [remoteRow], error: null });
    const orderedResult = {
      data: [],
      error: null,
      order: vi.fn(() => orderedResult),
    };
    const gtQuery = vi.fn(() => orderedResult);
    const selectQuery = vi.fn(() => createScopedQuery({
      gt: gtQuery,
      in: inQuery,
    }));
    const from = vi.fn(() => ({ select: selectQuery }));
    const rpc = vi.fn().mockResolvedValue({ data: '2026-03-05T00:00:00.000Z', error: null });
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };
    vi.spyOn(service, 'saveToLocal').mockResolvedValue(undefined);
    (service as unknown as { lastSyncTime: string | null }).lastSyncTime = '2026-03-05T00:00:00.000Z';
    supabase.clientAsync.mockResolvedValue({ from, rpc });
    setBlackBoxEntries([pendingEntry]);

    await service.pullChanges({ reason: 'panel-open', force: true });

    expect(inQuery).toHaveBeenCalledWith('id', [entryId]);
    expect(blackBoxEntriesMap().get(entryId)).toEqual(
      expect.objectContaining({
        id: entryId,
        syncStatus: 'synced',
        updatedAt: remoteRow.updated_at,
      })
    );
  });

  it('should reconcile pending entries with equivalent focusMeta even when json key order differs', async () => {
    const entryId = crypto.randomUUID();
    const pendingEntry = createEntry({
      id: entryId,
      updatedAt: '2026-03-05T00:00:00.000Z',
      syncStatus: 'pending',
      focusMeta: {
        source: 'focus-console-inline',
        sessionId: 'session-1',
        title: 'Inline task',
        detail: 'inline detail',
        lane: 'backup',
        expectedMinutes: 20,
        waitMinutes: 10,
        cognitiveLoad: 'low',
        dockEntryId: 'dock-entry-1',
      },
    });
    const remoteRow = {
      id: entryId,
      project_id: null,
      user_id: 'user-1',
      content: 'entry',
      focus_meta: {
        dockEntryId: 'dock-entry-1',
        cognitiveLoad: 'low',
        waitMinutes: 10,
        expectedMinutes: 20,
        lane: 'backup',
        detail: 'inline detail',
        title: 'Inline task',
        sessionId: 'session-1',
        source: 'focus-console-inline',
      },
      date: '2026-03-04',
      created_at: '2026-03-04T00:00:00.000Z',
      updated_at: '2026-03-04T00:00:00.000Z',
      is_read: false,
      is_completed: false,
      is_archived: false,
      snooze_until: null,
      snooze_count: 0,
      deleted_at: null,
    };
    const inQuery = vi.fn().mockResolvedValue({ data: [remoteRow], error: null });
    const orderedResult = {
      data: [],
      error: null,
      order: vi.fn(() => orderedResult),
    };
    const gtQuery = vi.fn(() => orderedResult);
    const selectQuery = vi.fn(() => createScopedQuery({
      gt: gtQuery,
      in: inQuery,
    }));
    const from = vi.fn(() => ({ select: selectQuery }));
    const rpc = vi.fn().mockResolvedValue({ data: '2026-03-05T00:00:00.000Z', error: null });
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };
    vi.spyOn(service, 'saveToLocal').mockResolvedValue(undefined);
    (service as unknown as { lastSyncTime: string | null }).lastSyncTime = '2026-03-05T00:00:00.000Z';
    supabase.clientAsync.mockResolvedValue({ from, rpc });
    setBlackBoxEntries([pendingEntry]);

    await service.pullChanges({ reason: 'panel-open', force: true });

    expect(blackBoxEntriesMap().get(entryId)).toEqual(
      expect.objectContaining({
        id: entryId,
        syncStatus: 'synced',
        focusMeta: expect.objectContaining({
          sessionId: 'session-1',
          dockEntryId: 'dock-entry-1',
        }),
      })
    );
  });

  it('should clear stale pending when server row only differs by timestamp/null formatting', async () => {
    const entryId = crypto.randomUUID();
    const pendingEntry = createLegacyEntryWithUndefinedDeletedAt(
      createEntry({
        id: entryId,
        createdAt: '2026-04-23T22:46:00.000Z',
        updatedAt: '2026-04-23T22:46:30.000Z',
        isRead: true,
        syncStatus: 'pending',
      })
    );
    const remoteRow = {
      id: entryId,
      project_id: null,
      user_id: 'user-1',
      content: 'entry',
      focus_meta: null,
      date: '2026-03-04',
      created_at: '2026-04-23T22:46:00+00:00',
      updated_at: '2026-04-23T22:46:30+00:00',
      is_read: true,
      is_completed: false,
      is_archived: false,
      snooze_until: null,
      snooze_count: null,
      deleted_at: null,
    };
    const inQuery = vi.fn().mockResolvedValue({ data: [remoteRow], error: null });
    const orderedResult = {
      data: [],
      error: null,
      order: vi.fn(() => orderedResult),
    };
    const gtQuery = vi.fn(() => orderedResult);
    const selectQuery = vi.fn(() => createScopedQuery({
      gt: gtQuery,
      in: inQuery,
    }));
    const from = vi.fn(() => ({ select: selectQuery }));
    const rpc = vi.fn().mockResolvedValue({ data: '2026-04-24T00:00:00.000Z', error: null });
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };
    vi.spyOn(service, 'saveToLocal').mockResolvedValue(undefined);
    (service as unknown as { lastSyncTime: string | null }).lastSyncTime = '2026-04-24T00:00:00.000Z';
    supabase.clientAsync.mockResolvedValue({ from, rpc });
    setBlackBoxEntries([pendingEntry]);

    await service.pullChanges({ reason: 'panel-open', force: true });

    expect(inQuery).toHaveBeenCalledWith('id', [entryId]);
    expect(blackBoxEntriesMap().get(entryId)).toEqual(
      expect.objectContaining({
        id: entryId,
        syncStatus: 'synced',
        createdAt: remoteRow.created_at,
        deletedAt: null,
      })
    );
  });

  it('should reconcile pending deleted tombstones against server tombstones', async () => {
    const entryId = crypto.randomUUID();
    const pendingEntry = createEntry({
      id: entryId,
      updatedAt: '2026-03-05T00:00:00.000Z',
      syncStatus: 'pending',
      deletedAt: '2026-03-05T00:00:00.000Z',
    });
    const remoteRow = {
      id: entryId,
      project_id: null,
      user_id: 'user-1',
      content: 'entry',
      focus_meta: null,
      date: '2026-03-04',
      created_at: '2026-03-04T00:00:00.000Z',
      updated_at: '2026-03-04T00:00:00.000Z',
      is_read: false,
      is_completed: false,
      is_archived: false,
      snooze_until: null,
      snooze_count: 0,
      deleted_at: '2026-03-05T00:00:00.000Z',
    };
    const inQuery = vi.fn().mockResolvedValue({ data: [remoteRow], error: null });
    const orderedResult = {
      data: [],
      error: null,
      order: vi.fn(() => orderedResult),
    };
    const gtQuery = vi.fn(() => orderedResult);
    const selectQuery = vi.fn(() => createScopedQuery({
      gt: gtQuery,
      in: inQuery,
    }));
    const from = vi.fn(() => ({ select: selectQuery }));
    const rpc = vi.fn().mockResolvedValue({ data: '2026-03-05T00:00:00.000Z', error: null });
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };
    vi.spyOn(service, 'saveToLocal').mockResolvedValue(undefined);
    (service as unknown as { lastSyncTime: string | null }).lastSyncTime = '2026-03-05T00:00:00.000Z';
    supabase.clientAsync.mockResolvedValue({ from, rpc });
    setBlackBoxEntries([pendingEntry]);

    await service.pullChanges({ reason: 'panel-open', force: true });

    expect(blackBoxEntriesMap().get(entryId)).toEqual(
      expect.objectContaining({
        id: entryId,
        syncStatus: 'synced',
        deletedAt: remoteRow.deleted_at,
      })
    );
  });

  it('should skip startup retry recovery when server already has a newer authoritative row', async () => {
    const entryId = crypto.randomUUID();
    const pendingEntry = createEntry({
      id: entryId,
      updatedAt: '2026-03-04T00:00:00.000Z',
      isCompleted: false,
      syncStatus: 'pending',
    });
    const remoteRow = {
      id: entryId,
      project_id: null,
      user_id: 'user-1',
      content: 'entry',
      focus_meta: null,
      date: '2026-03-04',
      created_at: '2026-03-04T00:00:00.000Z',
      updated_at: '2026-03-04T00:00:05.000Z',
      is_read: false,
      is_completed: true,
      is_archived: false,
      snooze_until: null,
      snooze_count: 0,
      deleted_at: null,
    };
    const enqueue = vi.fn();
    const inQuery = vi.fn().mockResolvedValue({ data: [remoteRow], error: null });
    const scopedQuery = createScopedQuery({ in: inQuery });
    const selectQuery = vi.fn(() => scopedQuery);
    const from = vi.fn(() => ({ select: selectQuery }));
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };
    vi.spyOn(service, 'loadFromLocal').mockResolvedValue([pendingEntry]);
    vi.spyOn(service, 'saveToLocal').mockResolvedValue(undefined);
    supabase.clientAsync.mockResolvedValue({ from });
    setBlackBoxEntries([pendingEntry]);
    (service as unknown as { retryQueueHandler: ((entry: BlackBoxEntry) => void) | null }).retryQueueHandler = enqueue;

    await (service as unknown as { recoverPendingEntries: () => Promise<void> }).recoverPendingEntries();

    expect(scopedQuery.eq).toHaveBeenCalledWith('user_id', 'user-1');
    expect(inQuery).toHaveBeenCalledWith('id', [entryId]);
    expect(enqueue).not.toHaveBeenCalled();
    expect(blackBoxEntriesMap().get(entryId)).toEqual(
      expect.objectContaining({
        id: entryId,
        isCompleted: true,
        syncStatus: 'synced',
        updatedAt: remoteRow.updated_at,
      })
    );
  });

  it('should keep startup pending recovery local-only when network is offline', async () => {
    const entryId = crypto.randomUUID();
    const pendingEntry = createEntry({
      id: entryId,
      syncStatus: 'pending',
    });
    const enqueue = vi.fn();
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };
    const network = TestBed.inject(NetworkAwarenessService) as unknown as {
      isOnline: ReturnType<typeof vi.fn>;
    };
    vi.spyOn(service, 'loadFromLocal').mockResolvedValue([pendingEntry]);
    setBlackBoxEntries([pendingEntry]);
    network.isOnline.mockReturnValue(false);
    (service as unknown as { retryQueueHandler: ((entry: BlackBoxEntry) => void) | null }).retryQueueHandler = enqueue;

    await (service as unknown as { recoverPendingEntries: () => Promise<void> }).recoverPendingEntries();

    expect(supabase.clientAsync).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(pendingEntry);
  });

  it('should rerun pending recovery after auth settles and suppress stale startup pending rows', async () => {
    const entryId = crypto.randomUUID();
    const pendingEntry = createEntry({
      id: entryId,
      updatedAt: '2026-03-04T00:00:00.000Z',
      isCompleted: false,
      syncStatus: 'pending',
    });
    const remoteRow = {
      id: entryId,
      project_id: null,
      user_id: 'user-1',
      content: 'entry',
      focus_meta: null,
      date: '2026-03-04',
      created_at: '2026-03-04T00:00:00.000Z',
      updated_at: '2026-03-04T00:00:05.000Z',
      is_read: false,
      is_completed: true,
      is_archived: false,
      snooze_until: null,
      snooze_count: 0,
      deleted_at: null,
    };
    const enqueue = vi.fn();
    const inQuery = vi.fn().mockResolvedValue({ data: [remoteRow], error: null });
    const scopedQuery = createScopedQuery({ in: inQuery });
    const selectQuery = vi.fn(() => scopedQuery);
    const from = vi.fn(() => ({ select: selectQuery }));
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };
    vi.spyOn(service, 'loadFromLocal').mockResolvedValue([pendingEntry]);
    vi.spyOn(service, 'saveToLocal').mockResolvedValue(undefined);
    supabase.clientAsync.mockResolvedValue({ from });
    setBlackBoxEntries([pendingEntry]);

    authSignals.sessionInitialized.set(false);
    authSignals.runtimeState.set('pending');
    authSignals.currentUserId.set(null);

    service.setRetryQueueHandler(enqueue);
    await flushMicrotasks();

    expect(enqueue).not.toHaveBeenCalled();
    expect(supabase.clientAsync).not.toHaveBeenCalled();

    authSignals.currentUserId.set('user-1');
    authSignals.authState.update(state => ({ ...state, userId: 'user-1', isCheckingSession: false }));
    authSignals.sessionInitialized.set(true);
    authSignals.runtimeState.set('ready');

    await vi.waitFor(() => {
      expect(inQuery).toHaveBeenCalledWith('id', [entryId]);
    });

    expect(enqueue).not.toHaveBeenCalled();
    expect(blackBoxEntriesMap().get(entryId)).toEqual(
      expect.objectContaining({
        id: entryId,
        isCompleted: true,
        syncStatus: 'synced',
        updatedAt: remoteRow.updated_at,
      })
    );
  });

  it('loadFromLocal 应只恢复当前用户的黑匣子条目', async () => {
    const foreignEntry = {
      id: 'entry-foreign',
      projectId: null,
      userId: 'user-2',
      content: 'foreign',
      date: '2026-03-04',
      createdAt: '2026-03-04T00:00:00.000Z',
      updatedAt: '2026-03-04T00:00:00.000Z',
      isRead: false,
      isCompleted: false,
      isArchived: false,
      deletedAt: null,
    };
    const ownEntry = {
      ...foreignEntry,
      id: 'entry-own',
      userId: 'user-1',
      content: 'own',
    };
    const getAll = vi.fn();
    const transaction = vi.fn(() => ({
      objectStore: vi.fn(() => ({
        getAll: () => {
          const request = {
            result: [ownEntry, foreignEntry],
            onsuccess: null as ((this: IDBRequest<unknown[]>, ev: Event) => unknown) | null,
            onerror: null as ((this: IDBRequest<unknown[]>, ev: Event) => unknown) | null,
          };
          queueMicrotask(() => request.onsuccess?.call(request as unknown as IDBRequest<unknown[]>, new Event('success')));
          getAll();
          return request;
        },
      })),
    }));
    (service as unknown as { db: unknown }).db = { transaction };

    const entries = await service.loadFromLocal();

    expect(getAll).toHaveBeenCalledTimes(1);
    expect(entries).toEqual([expect.objectContaining({ id: 'entry-own', userId: 'user-1' })]);
  });

  it('loadFromLocal 应把历史本地模式 pending 条目归一为本地已保存', async () => {
    authSignals.currentUserId.set(null);
    localStorage.setItem(AUTH_CONFIG.LOCAL_MODE_CACHE_KEY, 'true');
    const localEntry = {
      id: 'entry-local-only',
      projectId: null,
      userId: AUTH_CONFIG.LOCAL_MODE_USER_ID,
      content: 'local',
      date: '2026-03-04',
      createdAt: '2026-03-04T00:00:00.000Z',
      updatedAt: '2026-03-04T00:00:00.000Z',
      isRead: false,
      isCompleted: false,
      isArchived: false,
      deletedAt: null,
      syncStatus: 'pending',
    };
    const put = vi.fn(() => {
      const request = {
        onsuccess: null as ((this: IDBRequest<unknown>, ev: Event) => unknown) | null,
        onerror: null as ((this: IDBRequest<unknown>, ev: Event) => unknown) | null,
        error: null,
      };
      queueMicrotask(() => request.onsuccess?.call(request as unknown as IDBRequest<unknown>, new Event('success')));
      return request;
    });
    const transaction = vi.fn((_storeName: string, mode?: IDBTransactionMode) => ({
      objectStore: vi.fn(() => ({
        getAll: () => {
          const request = {
            result: [localEntry],
            onsuccess: null as ((this: IDBRequest<unknown[]>, ev: Event) => unknown) | null,
            onerror: null as ((this: IDBRequest<unknown[]>, ev: Event) => unknown) | null,
          };
          queueMicrotask(() => request.onsuccess?.call(request as unknown as IDBRequest<unknown[]>, new Event('success')));
          return request;
        },
        get: () => {
          const request = {
            result: mode === 'readwrite' ? localEntry : null,
            onsuccess: null as ((this: IDBRequest<unknown>, ev: Event) => unknown) | null,
            onerror: null as ((this: IDBRequest<unknown>, ev: Event) => unknown) | null,
            error: null,
          };
          queueMicrotask(() => request.onsuccess?.call(request as unknown as IDBRequest<unknown>, new Event('success')));
          return request;
        },
        put,
      })),
    }));
    (service as unknown as { db: unknown }).db = { transaction };

    const entries = await service.loadFromLocal();
    await flushMicrotasks();

    expect(entries).toEqual([expect.objectContaining({
      id: 'entry-local-only',
      userId: AUTH_CONFIG.LOCAL_MODE_USER_ID,
      syncStatus: 'synced',
    })]);
    expect(blackBoxEntriesMap().get('entry-local-only')?.syncStatus).toBe('synced');
    expect(put).toHaveBeenCalledWith(expect.objectContaining({
      id: 'entry-local-only',
      userId: AUTH_CONFIG.LOCAL_MODE_USER_ID,
      syncStatus: 'synced',
    }));
  });

  it('loadFromLocal 不应让 IDB 中更旧的 pending 回退内存里已收敛的 synced 条目', async () => {
    const entryId = 'entry-stale-pending';
    const idbPendingEntry = {
      id: entryId,
      projectId: null,
      userId: 'user-1',
      content: 'entry',
      date: '2026-03-04',
      createdAt: '2026-03-04T00:00:00.000Z',
      updatedAt: '2026-03-04T00:00:00.000Z',
      isRead: false,
      isCompleted: false,
      isArchived: false,
      deletedAt: null,
      syncStatus: 'pending',
    };
    const inMemorySyncedEntry = createEntry({
      id: entryId,
      updatedAt: '2026-03-04T00:00:05.000Z',
      syncStatus: 'synced',
    });
    const put = vi.fn(() => {
      const request = {
        onsuccess: null as ((this: IDBRequest<unknown>, ev: Event) => unknown) | null,
        onerror: null as ((this: IDBRequest<unknown>, ev: Event) => unknown) | null,
        error: null,
      };
      queueMicrotask(() => request.onsuccess?.call(request as unknown as IDBRequest<unknown>, new Event('success')));
      return request;
    });
    const transaction = vi.fn((_storeName: string, mode?: IDBTransactionMode) => ({
      objectStore: vi.fn(() => ({
        getAll: () => {
          const request = {
            result: [idbPendingEntry],
            onsuccess: null as ((this: IDBRequest<unknown[]>, ev: Event) => unknown) | null,
            onerror: null as ((this: IDBRequest<unknown[]>, ev: Event) => unknown) | null,
          };
          queueMicrotask(() => request.onsuccess?.call(request as unknown as IDBRequest<unknown[]>, new Event('success')));
          return request;
        },
        get: () => {
          const request = {
            result: mode === 'readwrite' ? idbPendingEntry : null,
            onsuccess: null as ((this: IDBRequest<unknown>, ev: Event) => unknown) | null,
            onerror: null as ((this: IDBRequest<unknown>, ev: Event) => unknown) | null,
            error: null,
          };
          queueMicrotask(() => request.onsuccess?.call(request as unknown as IDBRequest<unknown>, new Event('success')));
          return request;
        },
        put,
      })),
    }));
    (service as unknown as { db: unknown }).db = { transaction };
    setBlackBoxEntries([inMemorySyncedEntry]);

    const entries = await service.loadFromLocal();
    await flushMicrotasks();

    expect(entries).toEqual([expect.objectContaining({
      id: entryId,
      syncStatus: 'synced',
      updatedAt: '2026-03-04T00:00:05.000Z',
    })]);
    expect(blackBoxEntriesMap().get(entryId)).toEqual(expect.objectContaining({
      id: entryId,
      syncStatus: 'synced',
      updatedAt: '2026-03-04T00:00:05.000Z',
    }));
    expect(put).toHaveBeenCalledWith(expect.objectContaining({
      id: entryId,
      syncStatus: 'synced',
      updatedAt: '2026-03-04T00:00:05.000Z',
    }));
  });

  it('loadFromLocal 不应让业务等价但本地时间更晚的 pending 回退已收敛 synced 条目', async () => {
    const entryId = 'entry-fast-clock-pending';
    const idbPendingEntry = createEntry({
      id: entryId,
      updatedAt: '2026-03-04T00:00:10.000Z',
      syncStatus: 'pending',
    });
    const inMemorySyncedEntry = createEntry({
      id: entryId,
      updatedAt: '2026-03-04T00:00:05.000Z',
      syncStatus: 'synced',
    });
    const put = vi.fn(() => {
      const request = {
        onsuccess: null as ((this: IDBRequest<unknown>, ev: Event) => unknown) | null,
        onerror: null as ((this: IDBRequest<unknown>, ev: Event) => unknown) | null,
        error: null,
      };
      queueMicrotask(() => request.onsuccess?.call(request as unknown as IDBRequest<unknown>, new Event('success')));
      return request;
    });
    const transaction = vi.fn((_storeName: string, mode?: IDBTransactionMode) => ({
      objectStore: vi.fn(() => ({
        getAll: () => {
          const request = {
            result: [idbPendingEntry],
            onsuccess: null as ((this: IDBRequest<unknown[]>, ev: Event) => unknown) | null,
            onerror: null as ((this: IDBRequest<unknown[]>, ev: Event) => unknown) | null,
          };
          queueMicrotask(() => request.onsuccess?.call(request as unknown as IDBRequest<unknown[]>, new Event('success')));
          return request;
        },
        get: () => {
          const request = {
            result: mode === 'readwrite' ? idbPendingEntry : null,
            onsuccess: null as ((this: IDBRequest<unknown>, ev: Event) => unknown) | null,
            onerror: null as ((this: IDBRequest<unknown>, ev: Event) => unknown) | null,
            error: null,
          };
          queueMicrotask(() => request.onsuccess?.call(request as unknown as IDBRequest<unknown>, new Event('success')));
          return request;
        },
        put,
      })),
    }));
    (service as unknown as { db: unknown }).db = { transaction };
    setBlackBoxEntries([inMemorySyncedEntry]);

    const entries = await service.loadFromLocal();
    await flushMicrotasks();

    expect(entries).toEqual([expect.objectContaining({
      id: entryId,
      syncStatus: 'synced',
      updatedAt: '2026-03-04T00:00:05.000Z',
    })]);
    expect(blackBoxEntriesMap().get(entryId)).toEqual(expect.objectContaining({
      id: entryId,
      syncStatus: 'synced',
      updatedAt: '2026-03-04T00:00:05.000Z',
    }));
    expect(put).toHaveBeenCalledWith(expect.objectContaining({
      id: entryId,
      syncStatus: 'synced',
      updatedAt: '2026-03-04T00:00:05.000Z',
    }));
  });

  it('markEntrySyncConflict 应把可见条目回写为 conflict 并持久化到本地', async () => {
    const entry = createEntry({
      id: 'entry-conflict',
      syncStatus: 'pending',
    });
    const saveSpy = vi.spyOn(service, 'saveToLocal').mockResolvedValue(undefined);
    setBlackBoxEntries([entry]);

    await service.markEntrySyncConflict(entry);

    expect(saveSpy).toHaveBeenCalledWith(expect.objectContaining({
      id: 'entry-conflict',
      syncStatus: 'conflict',
    }));
    expect(blackBoxEntriesMap().get('entry-conflict')?.syncStatus).toBe('conflict');
  });

  it('markEntrySyncConflict 遇到更新且已同步的本地快照时不应回退为 conflict', async () => {
    const stalePending = createEntry({
      id: 'entry-conflict-stale',
      syncStatus: 'pending',
      updatedAt: '2026-03-04T00:00:00.000Z',
    });
    const latestSynced = createEntry({
      id: 'entry-conflict-stale',
      syncStatus: 'synced',
      updatedAt: '2026-03-04T00:00:10.000Z',
    });
    const saveSpy = vi.spyOn(service, 'saveToLocal').mockResolvedValue(undefined);
    setBlackBoxEntries([latestSynced]);

    await service.markEntrySyncConflict(stalePending);

    expect(saveSpy).not.toHaveBeenCalled();
    expect(blackBoxEntriesMap().get('entry-conflict-stale')?.syncStatus).toBe('synced');
  });

  // ============= Fix 1 回归：pushToServer owner-mismatch 必须自愈本地 syncStatus =============

  it('pushToServer owner-mismatch (local-user owner) → 改写 owner 后通过 retryQueueHandler 续推，且 pending 已落到合法 owner', async () => {
    const entryId = crypto.randomUUID();
    const legacyLocalEntry = createEntry({
      id: entryId,
      userId: AUTH_CONFIG.LOCAL_MODE_USER_ID,
      updatedAt: '2026-03-04T00:00:00.000Z',
      syncStatus: 'pending',
    });
    const enqueue = vi.fn();
    const saveToLocalSpy = vi.spyOn(service, 'saveToLocal').mockResolvedValue(undefined);
    setBlackBoxEntries([legacyLocalEntry]);
    (service as unknown as { retryQueueHandler: ((entry: BlackBoxEntry) => void) | null }).retryQueueHandler = enqueue;

    await expect(service.pushToServer(legacyLocalEntry)).resolves.toBe(true);

    // 持久化前后的 syncStatus 仍是 pending，但 owner 已经改写到 sessionUserId
    expect(saveToLocalSpy).toHaveBeenCalledWith(expect.objectContaining({
      id: entryId,
      userId: 'user-1',
      syncStatus: 'pending',
    }));
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      id: entryId,
      userId: 'user-1',
      syncStatus: 'pending',
    }));
    // 内存 Map 也已被同步成新 owner，不会继续被当作 owner-mismatch 反复触发
    expect(blackBoxEntriesMap().get(entryId)).toEqual(expect.objectContaining({
      id: entryId,
      userId: 'user-1',
    }));
  });

  it('pushToServer owner-mismatch (非法 UUID owner) → 物理删除脏数据，UI Map 同步移除', async () => {
    const entryId = crypto.randomUUID();
    const dirtyEntry = createEntry({
      id: entryId,
      userId: 'not-a-uuid-owner',
      updatedAt: '2026-03-04T00:00:00.000Z',
      syncStatus: 'pending',
    });
    const enqueue = vi.fn();
    const deleteSpy = vi.spyOn(service, 'deleteFromLocal').mockResolvedValue(undefined);
    setBlackBoxEntries([dirtyEntry]);
    (service as unknown as { retryQueueHandler: ((entry: BlackBoxEntry) => void) | null }).retryQueueHandler = enqueue;

    await expect(service.pushToServer(dirtyEntry)).resolves.toBe(true);

    expect(deleteSpy).toHaveBeenCalledWith(entryId);
    expect(blackBoxEntriesMap().has(entryId)).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('pushToServer owner-mismatch (合法跨账号 UUID) → markEntrySyncConflict 让 syncStatus 收敛为 conflict', async () => {
    const entryId = crypto.randomUUID();
    const foreignUserId = crypto.randomUUID();
    const foreignEntry = createEntry({
      id: entryId,
      userId: foreignUserId,
      updatedAt: '2026-03-04T00:00:00.000Z',
      syncStatus: 'pending',
    });
    const enqueue = vi.fn();
    const saveToLocalSpy = vi.spyOn(service, 'saveToLocal').mockResolvedValue(undefined);
    setBlackBoxEntries([foreignEntry]);
    (service as unknown as { retryQueueHandler: ((entry: BlackBoxEntry) => void) | null }).retryQueueHandler = enqueue;

    await expect(service.pushToServer(foreignEntry)).resolves.toBe(true);

    // markEntrySyncConflict 路径会把 entry 改写为 conflict 并持久化
    expect(saveToLocalSpy).toHaveBeenCalledWith(expect.objectContaining({
      id: entryId,
      userId: foreignUserId,
      syncStatus: 'conflict',
    }));
    expect(blackBoxEntriesMap().get(entryId)?.syncStatus).toBe('conflict');
    // 跨账号条目不应被重新入队
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('recoverPendingEntries 检测到 owner-mismatch pending 时不再灌入 RetryQueue，而是走 selfHeal 路径', async () => {
    const foreignOwnerId = crypto.randomUUID();
    const foreignPending = createEntry({
      id: crypto.randomUUID(),
      userId: foreignOwnerId,
      updatedAt: '2026-03-04T00:00:00.000Z',
      syncStatus: 'pending',
    });
    const enqueue = vi.fn();
    const saveToLocalSpy = vi.spyOn(service, 'saveToLocal').mockResolvedValue(undefined);
    vi.spyOn(service, 'loadFromLocal').mockResolvedValue([foreignPending]);
    // 让前置远端对账分支短路（不依赖 supabase 请求），直接拿原始 validPending
    vi.spyOn(
      service as unknown as { resolvePendingEntriesForRecovery: (entries: BlackBoxEntry[]) => Promise<BlackBoxEntry[]> },
      'resolvePendingEntriesForRecovery',
    ).mockResolvedValue([foreignPending]);

    setBlackBoxEntries([foreignPending]);
    (service as unknown as { retryQueueHandler: ((entry: BlackBoxEntry) => void) | null }).retryQueueHandler = enqueue;

    await (service as unknown as { recoverPendingEntries: () => Promise<void> }).recoverPendingEntries();

    expect(enqueue).not.toHaveBeenCalled();
    expect(saveToLocalSpy).toHaveBeenCalledWith(expect.objectContaining({
      id: foreignPending.id,
      syncStatus: 'conflict',
    }));
  });

  // ============= Fix 2 回归：mergeWithLocal 保留 pending 后必须重新调度推送 =============

  it('mergeWithLocal 把远端单调真值合并进本地 pending 后，retryQueueHandler 应被 merged entry 调用一次', async () => {
    const entryId = crypto.randomUUID();
    const localPending = createEntry({
      id: entryId,
      isCompleted: false,
      isRead: false,
      updatedAt: '2026-03-04T00:00:10.000Z', // 比 remote 新 → LWW 本地胜
      syncStatus: 'pending',
    });
    const remote = createEntry({
      id: entryId,
      isCompleted: true,
      isRead: true,
      updatedAt: '2026-03-04T00:00:05.000Z',
      syncStatus: 'synced',
    });

    const saveToLocalSpy = vi.spyOn(service, 'saveToLocal').mockResolvedValue(undefined);
    const enqueue = vi.fn();
    setBlackBoxEntries([localPending]);
    (service as unknown as { retryQueueHandler: ((entry: BlackBoxEntry) => void) | null }).retryQueueHandler = enqueue;

    await (service as unknown as {
      mergeWithLocal: (
        remoteEntry: BlackBoxEntry,
        preferRemoteForSyncedLocalDuringPull: boolean,
        repairingFutureCursor: boolean,
      ) => Promise<void>;
    }).mergeWithLocal(remote, false, false);

    // 单调真值被合并到 local，但 syncStatus 仍是 pending
    const mergedSaveCall = saveToLocalSpy.mock.calls.find(args => {
      const arg = args[0] as BlackBoxEntry;
      return arg.id === entryId && arg.isCompleted === true && arg.isRead === true && arg.syncStatus === 'pending';
    });
    expect(mergedSaveCall).toBeDefined();

    // 合并后必须重新入队，否则没有任何机制再次触发这条 pending 的 push
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      id: entryId,
      isCompleted: true,
      isRead: true,
      syncStatus: 'pending',
    }));
  });

  // ============= Fix 3 回归：upsert 完成但 latestLocalAfterPush 业务等价 → 升级 synced =============

  it('pushToServer 直接 upsert 完成、latestLocalAfterPush 业务字段等价但 updatedAt 更晚时，应升级为 synced 而不是长期 pending', async () => {
    const entryId = crypto.randomUUID();
    const entry = createEntry({
      id: entryId,
      updatedAt: '2026-03-04T00:00:00.000Z',
      isCompleted: false,
      syncStatus: 'pending',
    });
    // 并发路径在 upsert 期间又把 pending 写了一遍（业务字段完全等价、只 bump updatedAt）
    const concurrentlyBumped: BlackBoxEntry = {
      ...entry,
      updatedAt: '2026-03-04T00:00:02.000Z',
      syncStatus: 'pending',
    };
    const serverUpdatedAt = '2026-03-04T00:00:03.000Z';

    const preflightQuery = createPreflightQuery(vi.fn(async () => ({ data: null, error: null })));
    const from = vi.fn(() => ({
      select: vi.fn(() => preflightQuery),
      insert: vi.fn(() => ({
        select: vi.fn(() => ({
          single: vi.fn(async () => {
            // 在 upsert 返回前，把内存 Map 升到等价但更晚的快照
            setBlackBoxEntries([concurrentlyBumped]);
            return {
              data: { updated_at: serverUpdatedAt },
              error: null,
            };
          }),
        })),
      })),
      update: vi.fn(),
    }));
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };
    const saveToLocalSpy = vi.spyOn(service, 'saveToLocal').mockResolvedValue(undefined);

    setBlackBoxEntries([entry]);
    supabase.clientAsync.mockResolvedValue({ from });

    await expect(service.pushToServer(entry)).resolves.toBe(true);

    // 关键断言：等价的更晚本地快照应被升级为 synced，并采纳服务端 updatedAt。
    // UI 因此立刻从"待同步"收敛。
    const syncedCall = saveToLocalSpy.mock.calls.find(args => {
      const arg = args[0] as BlackBoxEntry;
      return arg.id === entryId && arg.syncStatus === 'synced' && arg.updatedAt === serverUpdatedAt;
    });
    expect(syncedCall).toBeDefined();
    expect(blackBoxEntriesMap().get(entryId)).toEqual(expect.objectContaining({
      id: entryId,
      syncStatus: 'synced',
      updatedAt: serverUpdatedAt,
    }));
  });

  it('pushToServer 直接写入在 preflight 后被并发更新抢先时应返回 false 而不是覆盖远端', async () => {
    const entry = createEntry({
      id: crypto.randomUUID(),
      updatedAt: '2026-03-04T00:00:00.000Z',
      syncStatus: 'pending',
    });
    const preflightQuery = createPreflightQuery(vi.fn(async () => ({
      data: {
        id: entry.id,
        project_id: entry.projectId,
        user_id: entry.userId,
        content: entry.content,
        focus_meta: null,
        date: entry.date,
        created_at: entry.createdAt,
        updated_at: entry.updatedAt,
        is_read: entry.isRead,
        is_completed: entry.isCompleted,
        is_archived: entry.isArchived,
        snooze_until: null,
        snooze_count: 0,
        deleted_at: null,
      },
      error: null,
    })));
    const update = vi.fn(() => ({
      eq: vi.fn(() => ({
        eq: vi.fn(() => ({
          eq: vi.fn(() => ({
            select: vi.fn(() => ({
              maybeSingle: vi.fn(async () => ({ data: null, error: null })),
            })),
          })),
        })),
      })),
    }));
    const from = vi.fn(() => ({
      select: vi.fn(() => preflightQuery),
      update,
      insert: vi.fn(),
    }));
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };

    setBlackBoxEntries([entry]);
    supabase.clientAsync.mockResolvedValue({ from });

    await expect(service.pushToServer(entry)).resolves.toBe(false);
    expect(update).toHaveBeenCalled();
  });

  // ============= 2026-05-16 回归：B4 非等价 latestLocal 必须主动入队，避免孤儿 pending =============

  it('pushToServer 直接 upsert 完成、latestLocalAfterPush 业务字段不等价时，应主动入队 latestLocal 避免孤儿 pending', async () => {
    const entryId = crypto.randomUUID();
    const entry = createEntry({
      id: entryId,
      content: '初稿',
      updatedAt: '2026-03-04T00:00:00.000Z',
      isCompleted: false,
      syncStatus: 'pending',
    });
    // 并发路径在 upsert 期间把 content 改了——业务字段不等价
    const concurrentlyEditedNotEquivalent: BlackBoxEntry = {
      ...entry,
      content: '增补内容',
      updatedAt: '2026-03-04T00:00:02.000Z',
      syncStatus: 'pending',
    };
    const serverUpdatedAt = '2026-03-04T00:00:03.000Z';

    const preflightQuery = createPreflightQuery(vi.fn(async () => ({ data: null, error: null })));
    const from = vi.fn(() => ({
      select: vi.fn(() => preflightQuery),
      insert: vi.fn(() => ({
        select: vi.fn(() => ({
          single: vi.fn(async () => {
            // 在 upsert 返回前把内存 Map 升到不等价的更晚快照
            setBlackBoxEntries([concurrentlyEditedNotEquivalent]);
            return {
              data: { updated_at: serverUpdatedAt },
              error: null,
            };
          }),
        })),
      })),
      update: vi.fn(),
    }));
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };
    vi.spyOn(service, 'saveToLocal').mockResolvedValue(undefined);
    const enqueue = vi.fn();
    (service as unknown as {
      retryQueueHandler: ((entry: BlackBoxEntry) => void) | null;
    }).retryQueueHandler = enqueue;

    setBlackBoxEntries([entry]);
    supabase.clientAsync.mockResolvedValue({ from });

    await expect(service.pushToServer(entry)).resolves.toBe(true);

    // 关键断言：业务字段不等价的更晚本地快照必须被显式重新入队，
    // 否则会成为孤儿 pending（UI 永远显示 待同步）。
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      id: entryId,
      content: '增补内容',
      syncStatus: 'pending',
    }));
    // 内存里不应被回写成 synced（业务字段不等价时仅保留 pending）
    const inMemory = blackBoxEntriesMap().get(entryId);
    expect(inMemory?.syncStatus).toBe('pending');
    expect(inMemory?.content).toBe('增补内容');
  });

  it('upgradeEquivalentLatestLocalToSynced 非等价分支在缺少 retryQueueHandler 时应降级为内联 pushToServer', async () => {
    const entryId = crypto.randomUUID();
    const pushedEntry = createEntry({
      id: entryId,
      content: '旧',
      updatedAt: '2026-03-04T00:00:00.000Z',
      syncStatus: 'pending',
    });
    const latestLocal = createEntry({
      id: entryId,
      content: '新内容',
      updatedAt: '2026-03-04T00:00:02.000Z',
      syncStatus: 'pending',
    });

    (service as unknown as {
      retryQueueHandler: ((entry: BlackBoxEntry) => void) | null;
    }).retryQueueHandler = null;
    const pushSpy = vi.spyOn(service, 'pushToServer').mockResolvedValue(true);

    await (service as unknown as {
      upgradeEquivalentLatestLocalToSynced: (
        latestLocal: BlackBoxEntry,
        pushedEntry: BlackBoxEntry,
        serverUpdatedAt: string,
        pushPath: 'rpc' | 'upsert',
      ) => Promise<void>;
    }).upgradeEquivalentLatestLocalToSynced(
      latestLocal,
      pushedEntry,
      '2026-03-04T00:00:03.000Z',
      'upsert',
    );

    // 微任务结算（ensureLatestLocalEnqueued 走 void this.pushToServer().catch(...)）
    await flushMicrotasks();

    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(pushSpy).toHaveBeenCalledWith(expect.objectContaining({
      id: entryId,
      content: '新内容',
    }));
  });
});
