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

function createScopedQuery<TQuery extends Record<string, unknown>>(
  query: TQuery,
): TQuery & { eq: ReturnType<typeof vi.fn> } {
  const scoped = { ...query } as TQuery & { eq: ReturnType<typeof vi.fn> };
  scoped.eq = vi.fn(() => scoped);
  return scoped;
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
    const upsert = vi.fn();
    const from = vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(async () => ({ data: null, error: null })),
        })),
      })),
      upsert,
    }));
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };
    const saveToLocalSpy = vi.spyOn(service, 'saveToLocal').mockResolvedValue(undefined);
    setBlackBoxEntries([entry]);
    supabase.clientAsync.mockResolvedValue({ from });

    await expect(service.pushToServer(entry)).resolves.toBe(true);

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
    const upsert = vi.fn();
    const from = vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(async () => ({ data: null, error: null })),
        })),
      })),
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
    const upsert = vi.fn();
    const from = vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({ maybeSingle })),
      })),
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

  it('should keep black box retry intent when sync RPC reports remote-newer', async () => {
    const entry = createEntry({
      id: crypto.randomUUID(),
      updatedAt: '2026-03-04T00:00:00.000Z',
      syncStatus: 'pending',
    });
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    mockSyncRpcClient.upsertBlackboxEntry.mockResolvedValueOnce({
      status: 'remote-newer',
      remoteUpdatedAt: '2026-03-04T00:00:05.000Z',
      raw: {},
    });
    const upsert = vi.fn();
    const from = vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(async () => ({ data: null, error: null })),
        })),
      })),
      upsert,
    }));
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };
    setBlackBoxEntries([entry]);
    supabase.clientAsync.mockResolvedValue({ from });

    await expect(service.pushToServer(entry)).resolves.toBe(false);

    expect(upsert).not.toHaveBeenCalled();
    expect(mockSentry.captureMessage).toHaveBeenCalledWith(
      'sync_rpc_blackbox_remote_newer',
      expect.objectContaining({ level: 'warning' }),
    );
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
    const from = vi.fn(() => ({
      upsert: vi.fn(() => ({
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
    }));
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };
    const saveToLocalSpy = vi.spyOn(service, 'saveToLocal').mockResolvedValue(undefined);

    setBlackBoxEntries([olderEntry]);
    supabase.clientAsync.mockResolvedValue({ from });

    await expect(service.pushToServer(olderEntry)).resolves.toBe(true);
    expect(saveToLocalSpy).not.toHaveBeenCalled();
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
    const select = vi.fn(() => ({
      eq: vi.fn(() => ({ maybeSingle })),
    }));
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
});
