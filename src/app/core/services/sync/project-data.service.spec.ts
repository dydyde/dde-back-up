import { Injector } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectDataService, PROJECT_BATCH_RPC_PROBE_GRACE_MS } from './project-data.service';
import { SupabaseClientService } from '../../../../services/supabase-client.service';
import { AuthService } from '../../../../services/auth.service';
import { LoggerService } from '../../../../services/logger.service';
import { RequestThrottleService } from '../../../../services/request-throttle.service';
import { SyncStateService } from './sync-state.service';
import { TombstoneService } from './tombstone.service';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import { StartupPlaceholderStateService } from '../../../../services/startup-placeholder-state.service';
import { AUTH_CONFIG } from '../../../../config/auth.config';
import { TIMEOUT_CONFIG } from '../../../../config/timeout.config';
import { FIELD_SELECT_CONFIG } from '../../../../config/sync.config';
import { resetBrowserNetworkSuspensionTrackingForTests } from '../../../../utils/browser-network-suspension';
import { hasTaskContentMissingFromSource } from '../../../../utils/task-content-guard';
import { resetTaskSchemaCompatibilityForTests } from '../../../../utils/task-schema-compat';

const OFFLINE_SNAPSHOT_DB_NAME = 'nanoflow-offline-snapshots';
const OFFLINE_SNAPSHOT_STORE_NAME = 'snapshots';
const OFFLINE_SNAPSHOT_RECORD_ID = 'offline-snapshot';
const OFFLINE_SNAPSHOT_LOCAL_STORAGE_KEY = 'nanoflow.offline-cache-v2';

function getOfflineSnapshotRecordId(ownerUserId?: string | null): string {
  return typeof ownerUserId === 'string' && ownerUserId.length > 0
    ? `${OFFLINE_SNAPSHOT_RECORD_ID}:${ownerUserId}`
    : OFFLINE_SNAPSHOT_RECORD_ID;
}

function getOfflineSnapshotStorageKey(ownerUserId?: string | null): string {
  return typeof ownerUserId === 'string' && ownerUserId.length > 0
    ? `${OFFLINE_SNAPSHOT_LOCAL_STORAGE_KEY}.${ownerUserId}`
    : OFFLINE_SNAPSHOT_LOCAL_STORAGE_KEY;
}

function setVisibilityState(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: state,
  });
}

async function writeOfflineSnapshotToIdb(payload: string, ownerUserId?: string | null): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(OFFLINE_SNAPSHOT_DB_NAME, 1);

    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(OFFLINE_SNAPSHOT_STORE_NAME)) {
        db.createObjectStore(OFFLINE_SNAPSHOT_STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(OFFLINE_SNAPSHOT_STORE_NAME, 'readwrite');
      tx.objectStore(OFFLINE_SNAPSHOT_STORE_NAME).put({
        id: getOfflineSnapshotRecordId(ownerUserId),
        data: payload,
      });
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    };
  });
}

async function readOfflineSnapshotFromIdb(ownerUserId?: string | null): Promise<string | null> {
  return await new Promise<string | null>((resolve) => {
    try {
      const request = indexedDB.open(OFFLINE_SNAPSHOT_DB_NAME, 1);

      request.onerror = () => resolve(null);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(OFFLINE_SNAPSHOT_STORE_NAME)) {
          db.createObjectStore(OFFLINE_SNAPSHOT_STORE_NAME, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction(OFFLINE_SNAPSHOT_STORE_NAME, 'readonly');
        const req = tx.objectStore(OFFLINE_SNAPSHOT_STORE_NAME).get(getOfflineSnapshotRecordId(ownerUserId));
        req.onsuccess = () => {
          db.close();
          resolve(req.result?.data ?? null);
        };
        req.onerror = () => {
          db.close();
          resolve(null);
        };
        tx.onerror = () => {
          db.close();
          resolve(null);
        };
      };
    } catch {
      resolve(null);
    }
  });
}

async function clearOfflineSnapshotIdb(ownerUserId?: string | null): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(OFFLINE_SNAPSHOT_DB_NAME, 1);

    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(OFFLINE_SNAPSHOT_STORE_NAME)) {
        db.createObjectStore(OFFLINE_SNAPSHOT_STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(OFFLINE_SNAPSHOT_STORE_NAME, 'readwrite');
      tx.objectStore(OFFLINE_SNAPSHOT_STORE_NAME).delete(getOfflineSnapshotRecordId(ownerUserId));
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    };
  });
}

async function clearAllOfflineSnapshotsIdb(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(OFFLINE_SNAPSHOT_DB_NAME, 1);

    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(OFFLINE_SNAPSHOT_STORE_NAME)) {
        db.createObjectStore(OFFLINE_SNAPSHOT_STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(OFFLINE_SNAPSHOT_STORE_NAME, 'readwrite');
      tx.objectStore(OFFLINE_SNAPSHOT_STORE_NAME).clear();
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    };
  });
}

describe('ProjectDataService', () => {
  beforeEach(async () => {
    resetTaskSchemaCompatibilityForTests();
    localStorage.clear();
    setVisibilityState('visible');
    await clearAllOfflineSnapshotsIdb();
  });

  afterEach(() => {
    resetBrowserNetworkSuspensionTrackingForTests();
    setVisibilityState('visible');
  });

  it('挂起窗口内 pullParkedTasksDelta 应直接跳过远端请求', async () => {
    setVisibilityState('hidden');
    const clientAsync = vi.fn(async () => ({
      from: vi.fn(),
    }));

    const injector = Injector.create({
      providers: [
        { provide: ProjectDataService, useClass: ProjectDataService },
        {
          provide: SupabaseClientService,
          useValue: {
            isConfigured: true,
            clientAsync,
          },
        },
        {
          provide: AuthService,
          useValue: {
            currentUserId: vi.fn(() => 'user-1'),
          },
        },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              debug: vi.fn(),
              info: vi.fn(),
              warn: vi.fn(),
              error: vi.fn(),
            }),
          },
        },
        {
          provide: RequestThrottleService,
          useValue: {
            execute: vi.fn(),
          },
        },
        {
          provide: SyncStateService,
          useValue: {
            setSyncError: vi.fn(),
          },
        },
        {
          provide: TombstoneService,
          useValue: {
            getTombstonesWithCache: vi.fn().mockResolvedValue({ data: [], error: null }),
            getLocalTombstones: vi.fn().mockReturnValue(new Set()),
          },
        },
        {
          provide: SentryLazyLoaderService,
          useValue: {
            addBreadcrumb: vi.fn(),
            captureException: vi.fn(),
            captureMessage: vi.fn(),
          },
        },
      ],
    });

    const service = injector.get(ProjectDataService);
    const result = await service.pullParkedTasksDelta(null, []);

    expect(result).toEqual({ entries: [], removedTaskIds: [], nextCursor: null });
    expect(clientAsync).not.toHaveBeenCalled();
  });

  it('P0001 Access Denied 时不应 fallback 到 loadFullProject', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: {
        code: 'P0001',
        message: 'Access denied',
      },
    });

    const injector = Injector.create({
      providers: [
        { provide: ProjectDataService, useClass: ProjectDataService },
        {
          provide: SupabaseClientService,
          useValue: {
            isConfigured: true,
            clientAsync: vi.fn(async () => ({ rpc })),
          },
        },
        {
          provide: AuthService,
          useValue: {
            currentUserId: vi.fn(() => 'user-1'),
          },
        },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              debug: vi.fn(),
              info: vi.fn(),
              warn: vi.fn(),
              error: vi.fn(),
            }),
          },
        },
        {
          provide: RequestThrottleService,
          useValue: {
            execute: vi.fn(),
          },
        },
        {
          provide: SyncStateService,
          useValue: {
            setSyncError: vi.fn(),
          },
        },
        {
          provide: TombstoneService,
          useValue: {
            getTombstonesWithCache: vi.fn().mockResolvedValue({ data: [], error: null }),
            getLocalTombstones: vi.fn().mockReturnValue(new Set()),
          },
        },
        {
          provide: SentryLazyLoaderService,
          useValue: {
            addBreadcrumb: vi.fn(),
            captureException: vi.fn(),
            captureMessage: vi.fn(),
          },
        },
      ],
    });

    const service = injector.get(ProjectDataService);
    const fallbackSpy = vi.spyOn(
      service as unknown as { loadFullProject: (projectId: string) => Promise<unknown> },
      'loadFullProject'
    ).mockResolvedValue(null);

    const result = await service.loadFullProjectOptimized('proj-denied');

    expect(result).toBeNull();
    expect(fallbackSpy).not.toHaveBeenCalled();
  });

  it('getProjectSyncWatermark 应返回远端聚合水位', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: '2026-02-14T08:10:00.000Z',
      error: null,
    });

    const injector = Injector.create({
      providers: [
        { provide: ProjectDataService, useClass: ProjectDataService },
        {
          provide: SupabaseClientService,
          useValue: {
            isConfigured: true,
            clientAsync: vi.fn(async () => ({ rpc })),
          },
        },
        {
          provide: AuthService,
          useValue: {
            currentUserId: vi.fn(() => 'user-1'),
          },
        },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              debug: vi.fn(),
              info: vi.fn(),
              warn: vi.fn(),
              error: vi.fn(),
            }),
          },
        },
        {
          provide: RequestThrottleService,
          useValue: {
            execute: vi.fn(),
          },
        },
        {
          provide: SyncStateService,
          useValue: {
            setSyncError: vi.fn(),
          },
        },
        {
          provide: TombstoneService,
          useValue: {
            getTombstonesWithCache: vi.fn().mockResolvedValue({ data: [], error: null }),
            getLocalTombstones: vi.fn().mockReturnValue(new Set()),
          },
        },
        {
          provide: SentryLazyLoaderService,
          useValue: {
            addBreadcrumb: vi.fn(),
            captureException: vi.fn(),
            captureMessage: vi.fn(),
          },
        },
      ],
    });

    const service = injector.get(ProjectDataService);
    const watermark = await service.getProjectSyncWatermark('proj-1');

    expect(rpc).toHaveBeenCalledWith('get_project_sync_watermark', { p_project_id: 'proj-1' });
    expect(watermark).toBe('2026-02-14T08:10:00.000Z');
  });

  it('Supabase 未配置且处于离线模式时应仅记录一次 info 且不设置同步错误', async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const syncState = {
      setSyncError: vi.fn(),
    };

    const injector = Injector.create({
      providers: [
        { provide: ProjectDataService, useClass: ProjectDataService },
        {
          provide: SupabaseClientService,
          useValue: {
            isConfigured: false,
            isOfflineMode: () => true,
            clientAsync: vi.fn(),
          },
        },
        {
          provide: AuthService,
          useValue: {
            currentUserId: vi.fn(() => null),
          },
        },
        {
          provide: LoggerService,
          useValue: {
            category: () => logger,
          },
        },
        {
          provide: RequestThrottleService,
          useValue: {
            execute: vi.fn(),
          },
        },
        {
          provide: SyncStateService,
          useValue: syncState,
        },
        {
          provide: TombstoneService,
          useValue: {
            getTombstonesWithCache: vi.fn().mockResolvedValue({ data: [], error: null }),
            getLocalTombstones: vi.fn().mockReturnValue(new Set()),
          },
        },
        {
          provide: SentryLazyLoaderService,
          useValue: {
            addBreadcrumb: vi.fn(),
            captureException: vi.fn(),
            captureMessage: vi.fn(),
          },
        },
      ],
    });

    const service = injector.get(ProjectDataService);
    const getSupabaseClient = (service as unknown as { getSupabaseClient: () => Promise<unknown> }).getSupabaseClient.bind(service);

    await getSupabaseClient();
    await getSupabaseClient();

    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(syncState.setSyncError).not.toHaveBeenCalled();
  });

  it('RPC 函数不存在时应回退并熔断后续 RPC 调用', async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({
        data: null,
        error: {
          code: '42883',
          message: 'function public.get_full_project_data(uuid) does not exist',
        },
      })
      .mockResolvedValue({
        data: {
          id: 'proj-1',
          owner_id: 'user-1',
          title: 'Project 1',
          created_at: '2026-03-22T00:00:00.000Z',
          updated_at: '2026-03-22T00:00:00.000Z',
        },
        error: null,
      });

    const maybeSingle = vi.fn().mockResolvedValue({
      data: {
        id: 'proj-1',
        owner_id: 'user-1',
        title: 'Project 1',
        created_at: '2026-03-22T00:00:00.000Z',
        updated_at: '2026-03-22T00:00:00.000Z',
      },
      error: null,
    });
    const isProjectAvailable = vi.fn().mockReturnValue({ maybeSingle });
    const select = vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({ is: isProjectAvailable }),
    });

    const from = vi.fn((table: string) => {
      if (table === 'projects') {
        return { select };
      }
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            is: vi.fn().mockResolvedValue({ data: [], error: null }),
          }),
        }),
      };
    });

    const injector = Injector.create({
      providers: [
        { provide: ProjectDataService, useClass: ProjectDataService },
        {
          provide: SupabaseClientService,
          useValue: {
            isConfigured: true,
            clientAsync: vi.fn(async () => ({ rpc, from })),
          },
        },
        {
          provide: AuthService,
          useValue: {
            currentUserId: vi.fn(() => 'user-1'),
          },
        },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              debug: vi.fn(),
              info: vi.fn(),
              warn: vi.fn(),
              error: vi.fn(),
            }),
          },
        },
        {
          provide: RequestThrottleService,
          useValue: {
            execute: vi.fn(async (_key: string, work: () => Promise<unknown>) => work()),
          },
        },
        {
          provide: SyncStateService,
          useValue: {
            setSyncError: vi.fn(),
          },
        },
        {
          provide: TombstoneService,
          useValue: {
            getTombstonesWithCache: vi.fn().mockResolvedValue({ data: [], error: null }),
            getLocalTombstones: vi.fn().mockReturnValue(new Set()),
          },
        },
        {
          provide: SentryLazyLoaderService,
          useValue: {
            addBreadcrumb: vi.fn(),
            captureException: vi.fn(),
            captureMessage: vi.fn(),
          },
        },
      ],
    });

    const service = injector.get(ProjectDataService);

    const first = await service.loadFullProjectOptimized('proj-1');
    const second = await service.loadFullProjectOptimized('proj-1');

    expect(first?.id).toBe('proj-1');
    expect(second?.id).toBe('proj-1');
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledWith('projects');
    expect(isProjectAvailable).toHaveBeenCalledWith('deleted_at', null);
  });

  it('PGRST202 schema cache miss 时应识别为 RPC 缺失并回退', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: {
        code: 'PGRST202',
        message: 'Could not find the function public.get_full_project_data(p_project_id) in the schema cache',
      },
    });

    const from = vi.fn((table: string) => ({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue(
          table === 'projects'
            ? { maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) }
            : Promise.resolve({ data: [], error: null })
        ),
      }),
    }));

    const injector = Injector.create({
      providers: [
        { provide: ProjectDataService, useClass: ProjectDataService },
        {
          provide: SupabaseClientService,
          useValue: {
            isConfigured: true,
            clientAsync: vi.fn(async () => ({ rpc, from })),
          },
        },
        {
          provide: AuthService,
          useValue: {
            currentUserId: vi.fn(() => 'user-1'),
          },
        },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              debug: vi.fn(),
              info: vi.fn(),
              warn: vi.fn(),
              error: vi.fn(),
            }),
          },
        },
        {
          provide: RequestThrottleService,
          useValue: {
            execute: vi.fn(async (_key: string, work: () => Promise<unknown>) => work()),
          },
        },
        {
          provide: SyncStateService,
          useValue: {
            setSyncError: vi.fn(),
          },
        },
        {
          provide: TombstoneService,
          useValue: {
            getTombstonesWithCache: vi.fn().mockResolvedValue({ data: [], error: null }),
            getLocalTombstones: vi.fn().mockReturnValue(new Set()),
          },
        },
        {
          provide: SentryLazyLoaderService,
          useValue: {
            addBreadcrumb: vi.fn(),
            captureException: vi.fn(),
            captureMessage: vi.fn(),
          },
        },
      ],
    });

    const service = injector.get(ProjectDataService);
    const result = await service.loadFullProjectOptimized('proj-missing-rpc');

    expect(result).toBeNull();
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('RPC 504 时应短时熔断批量 RPC，并在冷却期内直接走顺序加载', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: {
        code: '504',
        message: '504 Gateway Timeout',
      },
    });

    const injector = Injector.create({
      providers: [
        { provide: ProjectDataService, useClass: ProjectDataService },
        {
          provide: SupabaseClientService,
          useValue: {
            isConfigured: true,
            clientAsync: vi.fn(async () => ({ rpc })),
          },
        },
        {
          provide: AuthService,
          useValue: {
            currentUserId: vi.fn(() => 'user-1'),
          },
        },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              debug: vi.fn(),
              info: vi.fn(),
              warn: vi.fn(),
              error: vi.fn(),
            }),
          },
        },
        {
          provide: RequestThrottleService,
          useValue: {
            execute: vi.fn(),
          },
        },
        {
          provide: SyncStateService,
          useValue: {
            setSyncError: vi.fn(),
          },
        },
        {
          provide: TombstoneService,
          useValue: {
            getTombstonesWithCache: vi.fn().mockResolvedValue({ data: [], error: null }),
            getLocalTombstones: vi.fn().mockReturnValue(new Set()),
          },
        },
        {
          provide: SentryLazyLoaderService,
          useValue: {
            addBreadcrumb: vi.fn(),
            captureException: vi.fn(),
            captureMessage: vi.fn(),
          },
        },
      ],
    });

    const service = injector.get(ProjectDataService);
    const fallbackSpy = vi.spyOn(
      service as unknown as { loadFullProject: (projectId: string) => Promise<unknown> },
      'loadFullProject'
    ).mockResolvedValue(null);

    await service.loadFullProjectOptimized('proj-timeout');
    await service.loadFullProjectOptimized('proj-timeout');

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(fallbackSpy).toHaveBeenCalledTimes(2);
  });

  it('loadProjectsFromCloud 应将 owner hint 传递给完整项目加载链路', async () => {
    const projectsOrder = {
      order: vi.fn().mockResolvedValue({
        data: [{ id: 'proj-owner-hint' }],
        error: null,
      }),
    };
    const projectsDeleted = {
      is: vi.fn().mockReturnValue(projectsOrder),
    };
    const projectsOwner = {
      eq: vi.fn().mockReturnValue(projectsDeleted),
    };
    const projectsSelect = {
      select: vi.fn().mockReturnValue(projectsOwner),
    };
    const from = vi.fn((table: string) => {
      if (table === 'projects') {
        return projectsSelect;
      }
      throw new Error(`unexpected table ${table}`);
    });

    const injector = Injector.create({
      providers: [
        { provide: ProjectDataService, useClass: ProjectDataService },
        {
          provide: SupabaseClientService,
          useValue: {
            isConfigured: true,
            clientAsync: vi.fn(async () => ({ from })),
          },
        },
        {
          provide: AuthService,
          useValue: {
            currentUserId: vi.fn(() => null),
            sessionInitialized: vi.fn(() => false),
            authState: vi.fn(() => ({ isCheckingSession: false })),
            runtimeState: vi.fn(() => 'idle'),
            peekPersistedSessionIdentity: vi.fn(() => null),
          },
        },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              debug: vi.fn(),
              info: vi.fn(),
              warn: vi.fn(),
              error: vi.fn(),
            }),
          },
        },
        {
          provide: RequestThrottleService,
          useValue: {
            execute: vi.fn(async (_key: string, work: () => Promise<unknown>) => work()),
          },
        },
        {
          provide: SyncStateService,
          useValue: {
            setSyncError: vi.fn(),
            setLoadingRemote: vi.fn(),
            isLoadingRemote: vi.fn(() => false),
          },
        },
        {
          provide: TombstoneService,
          useValue: {
            getTombstonesWithCache: vi.fn().mockResolvedValue({ data: [], error: null }),
            getLocalTombstones: vi.fn().mockReturnValue(new Set()),
          },
        },
        {
          provide: SentryLazyLoaderService,
          useValue: {
            addBreadcrumb: vi.fn(),
            captureException: vi.fn(),
            captureMessage: vi.fn(),
          },
        },
      ],
    });

    const service = injector.get(ProjectDataService);
    const loadSpy = vi.spyOn(
      service as unknown as { loadFullProjectOptimized: (projectId: string, expectedUserId?: string) => Promise<Project | null> },
      'loadFullProjectOptimized'
    ).mockResolvedValue(null);

    await service.loadProjectsFromCloud('user-owner-hint');

    expect(loadSpy).toHaveBeenCalledWith('proj-owner-hint', 'user-owner-hint');
  });

  it('loadProjectsFromCloud 首个项目触发 RPC 504 后，后续项目应命中短熔断不再重复调用 batch RPC', async () => {
    const projectsOrder = {
      order: vi.fn().mockResolvedValue({
        data: [
          { id: 'proj-rpc-timeout-1' },
          { id: 'proj-rpc-timeout-2' },
          { id: 'proj-rpc-timeout-3' },
        ],
        error: null,
      }),
    };
    const projectsDeleted = {
      is: vi.fn().mockReturnValue(projectsOrder),
    };
    const projectsOwner = {
      eq: vi.fn().mockReturnValue(projectsDeleted),
    };
    const projectsSelect = {
      select: vi.fn().mockReturnValue(projectsOwner),
    };
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: {
        code: '504',
        message: '504 Gateway Timeout',
      },
    });
    const from = vi.fn((table: string) => {
      if (table === 'projects') {
        return projectsSelect;
      }
      throw new Error(`unexpected table ${table}`);
    });

    const injector = Injector.create({
      providers: [
        { provide: ProjectDataService, useClass: ProjectDataService },
        {
          provide: SupabaseClientService,
          useValue: {
            isConfigured: true,
            clientAsync: vi.fn(async () => ({ from, rpc })),
          },
        },
        {
          provide: AuthService,
          useValue: {
            currentUserId: vi.fn(() => null),
            sessionInitialized: vi.fn(() => false),
            authState: vi.fn(() => ({ isCheckingSession: false })),
            runtimeState: vi.fn(() => 'idle'),
            peekPersistedSessionIdentity: vi.fn(() => null),
          },
        },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              debug: vi.fn(),
              info: vi.fn(),
              warn: vi.fn(),
              error: vi.fn(),
            }),
          },
        },
        {
          provide: RequestThrottleService,
          useValue: {
            execute: vi.fn(async (_key: string, work: () => Promise<unknown>) => work()),
          },
        },
        {
          provide: SyncStateService,
          useValue: {
            setSyncError: vi.fn(),
            setLoadingRemote: vi.fn(),
            isLoadingRemote: vi.fn(() => false),
          },
        },
        {
          provide: TombstoneService,
          useValue: {
            getTombstonesWithCache: vi.fn().mockResolvedValue({ data: [], error: null }),
            getLocalTombstones: vi.fn().mockReturnValue(new Set()),
          },
        },
        {
          provide: SentryLazyLoaderService,
          useValue: {
            addBreadcrumb: vi.fn(),
            captureException: vi.fn(),
            captureMessage: vi.fn(),
          },
        },
      ],
    });

    const service = injector.get(ProjectDataService);
    const fallbackSpy = vi.spyOn(
      service as unknown as { loadFullProject: (projectId: string, expectedUserId?: string) => Promise<Project | null> },
      'loadFullProject'
    ).mockResolvedValue(null);

    const result = await service.loadProjectsFromCloud('user-batch-timeout');

    expect(result).toEqual([]);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(fallbackSpy).toHaveBeenCalledTimes(3);
    expect(fallbackSpy).toHaveBeenNthCalledWith(1, 'proj-rpc-timeout-1', 'user-batch-timeout');
    expect(fallbackSpy).toHaveBeenNthCalledWith(2, 'proj-rpc-timeout-2', 'user-batch-timeout');
    expect(fallbackSpy).toHaveBeenNthCalledWith(3, 'proj-rpc-timeout-3', 'user-batch-timeout');
  });

  it('loadProjectsFromCloud 不应等待首个项目完整结束后才启动剩余项目加载', async () => {
    vi.useFakeTimers();

    const projectsOrder = {
      order: vi.fn().mockResolvedValue({
        data: [
          { id: 'proj-parallel-1' },
          { id: 'proj-parallel-2' },
          { id: 'proj-parallel-3' },
        ],
        error: null,
      }),
    };
    const projectsDeleted = {
      is: vi.fn().mockReturnValue(projectsOrder),
    };
    const projectsOwner = {
      eq: vi.fn().mockReturnValue(projectsDeleted),
    };
    const projectsSelect = {
      select: vi.fn().mockReturnValue(projectsOwner),
    };
    const from = vi.fn((table: string) => {
      if (table === 'projects') {
        return projectsSelect;
      }
      throw new Error(`unexpected table ${table}`);
    });

    const injector = Injector.create({
      providers: [
        { provide: ProjectDataService, useClass: ProjectDataService },
        {
          provide: SupabaseClientService,
          useValue: {
            isConfigured: true,
            clientAsync: vi.fn(async () => ({ from })),
          },
        },
        {
          provide: AuthService,
          useValue: {
            currentUserId: vi.fn(() => null),
            sessionInitialized: vi.fn(() => false),
            authState: vi.fn(() => ({ isCheckingSession: false })),
            runtimeState: vi.fn(() => 'idle'),
            peekPersistedSessionIdentity: vi.fn(() => null),
          },
        },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              debug: vi.fn(),
              info: vi.fn(),
              warn: vi.fn(),
              error: vi.fn(),
            }),
          },
        },
        {
          provide: RequestThrottleService,
          useValue: {
            execute: vi.fn(async (_key: string, work: () => Promise<unknown>) => work()),
          },
        },
        {
          provide: SyncStateService,
          useValue: {
            setSyncError: vi.fn(),
            setLoadingRemote: vi.fn(),
            isLoadingRemote: vi.fn(() => false),
          },
        },
        {
          provide: TombstoneService,
          useValue: {
            getTombstonesWithCache: vi.fn().mockResolvedValue({ data: [], error: null }),
            getLocalTombstones: vi.fn().mockReturnValue(new Set()),
          },
        },
        {
          provide: SentryLazyLoaderService,
          useValue: {
            addBreadcrumb: vi.fn(),
            captureException: vi.fn(),
            captureMessage: vi.fn(),
          },
        },
      ],
    });

    const service = injector.get(ProjectDataService);
    let resolveFirstLoad: (() => void) | null = null;
    const loadSpy = vi.spyOn(
      service as unknown as { loadFullProjectOptimized: (projectId: string, expectedUserId?: string) => Promise<Project | null> },
      'loadFullProjectOptimized'
    ).mockImplementation((projectId: string) => {
      if (projectId === 'proj-parallel-1') {
        return new Promise<Project | null>((resolve) => {
          resolveFirstLoad = () => resolve(null);
        });
      }

      return Promise.resolve(null);
    });

    const pendingLoad = service.loadProjectsFromCloud('user-parallel-hint');

    try {
      await vi.waitFor(() => expect(loadSpy).toHaveBeenCalledTimes(1));

      await vi.advanceTimersByTimeAsync(PROJECT_BATCH_RPC_PROBE_GRACE_MS);
      expect(loadSpy).toHaveBeenCalledTimes(3);
      expect(loadSpy).toHaveBeenNthCalledWith(2, 'proj-parallel-2', 'user-parallel-hint');
      expect(loadSpy).toHaveBeenNthCalledWith(3, 'proj-parallel-3', 'user-parallel-hint');
    } finally {
      resolveFirstLoad?.();
      await pendingLoad;
      vi.useRealTimers();
    }
  });

  it('startup snapshot 应优先读取 IndexedDB 并返回元数据', async () => {
    const idbPayload = JSON.stringify({
      projects: [
        {
          id: 'idb-project',
          name: 'IDB Project',
          description: 'from idb',
          createdDate: '2026-03-26T00:00:00.000Z',
          tasks: [],
          connections: [],
        },
      ],
      version: 7,
      savedAt: '2026-04-11T00:00:00.000Z',
    });
    const localStoragePayload = JSON.stringify({
      projects: [
        {
          id: 'legacy-project',
          name: 'Legacy Project',
          description: 'from localStorage',
          createdDate: '2026-03-25T00:00:00.000Z',
          tasks: [],
          connections: [],
        },
      ],
      version: 6,
      savedAt: '2026-04-10T00:00:00.000Z',
    });

    localStorage.setItem(getOfflineSnapshotStorageKey('user-1'), localStoragePayload);
    await writeOfflineSnapshotToIdb(idbPayload, 'user-1');

    const injector = Injector.create({
      providers: [
        { provide: ProjectDataService, useClass: ProjectDataService },
        {
          provide: SupabaseClientService,
          useValue: {
            isConfigured: false,
            clientAsync: vi.fn(),
          },
        },
        {
          provide: AuthService,
          useValue: {
            currentUserId: vi.fn(() => 'user-1'),
          },
        },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              debug: vi.fn(),
              info: vi.fn(),
              warn: vi.fn(),
              error: vi.fn(),
            }),
          },
        },
        {
          provide: RequestThrottleService,
          useValue: {
            execute: vi.fn(),
          },
        },
        {
          provide: SyncStateService,
          useValue: {
            setSyncError: vi.fn(),
          },
        },
        {
          provide: TombstoneService,
          useValue: {
            getTombstonesWithCache: vi.fn().mockResolvedValue({ data: [], error: null }),
            getLocalTombstones: vi.fn().mockReturnValue(new Set()),
          },
        },
        {
          provide: SentryLazyLoaderService,
          useValue: {
            addBreadcrumb: vi.fn(),
            captureException: vi.fn(),
            captureMessage: vi.fn(),
          },
        },
      ],
    });

    const service = injector.get(ProjectDataService) as unknown as {
      loadStartupOfflineSnapshot: () => Promise<{
        source: 'idb' | 'localStorage' | 'none';
        projectCount: number;
        bytes: number;
        migratedLegacy: boolean;
        projects: unknown[];
        ownerUserId?: string | null;
      }>;
    };

    const snapshot = await service.loadStartupOfflineSnapshot();

    expect(snapshot.source).toBe('idb');
    expect(snapshot.projectCount).toBe(1);
    expect(snapshot.migratedLegacy).toBe(false);
    expect(snapshot.ownerUserId).toBe('user-1');
    expect(snapshot.bytes).toBeGreaterThan(0);
    expect(snapshot.projects).toHaveLength(1);
    expect((snapshot.projects[0] as { id?: string }).id).toBe('idb-project');
  }, 10000);

  it('startup snapshot 在 localStorage 更新时应优先恢复较新的 localStorage 快照', async () => {
    const idbPayload = JSON.stringify({
      projects: [
        {
          id: 'idb-project-old',
          name: 'IDB Project Old',
          description: 'older idb snapshot',
          createdDate: '2026-03-26T00:00:00.000Z',
          tasks: [],
          connections: [],
        },
      ],
      version: 7,
      savedAt: '2026-04-10T00:00:00.000Z',
    });
    const localStoragePayload = JSON.stringify({
      projects: [
        {
          id: 'local-storage-project-new',
          name: 'LocalStorage Project New',
          description: 'newer localStorage snapshot',
          createdDate: '2026-03-27T00:00:00.000Z',
          tasks: [],
          connections: [],
        },
      ],
      version: 7,
      savedAt: '2026-04-11T00:00:00.000Z',
    });

    localStorage.setItem(getOfflineSnapshotStorageKey('user-1'), localStoragePayload);
    await writeOfflineSnapshotToIdb(idbPayload, 'user-1');

    const injector = Injector.create({
      providers: [
        { provide: ProjectDataService, useClass: ProjectDataService },
        {
          provide: SupabaseClientService,
          useValue: {
            isConfigured: false,
            clientAsync: vi.fn(),
          },
        },
        {
          provide: AuthService,
          useValue: {
            currentUserId: vi.fn(() => 'user-1'),
          },
        },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              debug: vi.fn(),
              info: vi.fn(),
              warn: vi.fn(),
              error: vi.fn(),
            }),
          },
        },
        {
          provide: RequestThrottleService,
          useValue: {
            execute: vi.fn(),
          },
        },
        {
          provide: SyncStateService,
          useValue: {
            setSyncError: vi.fn(),
          },
        },
        {
          provide: TombstoneService,
          useValue: {
            getTombstonesWithCache: vi.fn().mockResolvedValue({ data: [], error: null }),
            getLocalTombstones: vi.fn().mockReturnValue(new Set()),
          },
        },
        {
          provide: SentryLazyLoaderService,
          useValue: {
            addBreadcrumb: vi.fn(),
            captureException: vi.fn(),
            captureMessage: vi.fn(),
          },
        },
      ],
    });

    const service = injector.get(ProjectDataService) as unknown as {
      loadStartupOfflineSnapshot: () => Promise<{
        source: 'idb' | 'localStorage' | 'none';
        projectCount: number;
        bytes: number;
        migratedLegacy: boolean;
        projects: unknown[];
        ownerUserId?: string | null;
      }>;
    };

    const snapshot = await service.loadStartupOfflineSnapshot();
    const migratedPayload = await readOfflineSnapshotFromIdb('user-1');

    expect(snapshot.source).toBe('localStorage');
    expect(snapshot.projectCount).toBe(1);
    expect((snapshot.projects[0] as { id?: string }).id).toBe('local-storage-project-new');
    expect(migratedPayload).toBe(localStoragePayload);
  }, 10000);

  it('startup snapshot 选择较新 localStorage 时若 owner 不匹配应回退到可见的 IndexedDB 快照', async () => {
    const idbPayload = JSON.stringify({
      projects: [
        {
          id: 'idb-visible-project',
          name: 'IDB Visible Project',
          description: 'visible idb snapshot',
          createdDate: '2026-03-26T00:00:00.000Z',
          tasks: [],
          connections: [],
        },
      ],
      version: 7,
      savedAt: '2026-04-10T00:00:00.000Z',
      ownerUserId: 'user-1',
    });
    const localStoragePayload = JSON.stringify({
      projects: [
        {
          id: 'local-storage-foreign-project',
          name: 'LocalStorage Foreign Project',
          description: 'should not overwrite idb',
          createdDate: '2026-03-27T00:00:00.000Z',
          tasks: [],
          connections: [],
        },
      ],
      version: 7,
      savedAt: '2026-04-11T00:00:00.000Z',
      ownerUserId: 'user-2',
    });

    localStorage.setItem(getOfflineSnapshotStorageKey('user-1'), localStoragePayload);
    await writeOfflineSnapshotToIdb(idbPayload, 'user-1');

    const injector = Injector.create({
      providers: [
        { provide: ProjectDataService, useClass: ProjectDataService },
        {
          provide: SupabaseClientService,
          useValue: {
            isConfigured: false,
            clientAsync: vi.fn(),
          },
        },
        {
          provide: AuthService,
          useValue: {
            currentUserId: vi.fn(() => 'user-1'),
            peekPersistedSessionIdentity: vi.fn(() => null),
            peekPersistedOwnerHint: vi.fn(() => 'user-1'),
          },
        },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              debug: vi.fn(),
              info: vi.fn(),
              warn: vi.fn(),
              error: vi.fn(),
            }),
          },
        },
        {
          provide: RequestThrottleService,
          useValue: {
            execute: vi.fn(),
          },
        },
        {
          provide: SyncStateService,
          useValue: {
            setSyncError: vi.fn(),
          },
        },
        {
          provide: TombstoneService,
          useValue: {
            getTombstonesWithCache: vi.fn().mockResolvedValue({ data: [], error: null }),
            getLocalTombstones: vi.fn().mockReturnValue(new Set()),
          },
        },
        {
          provide: SentryLazyLoaderService,
          useValue: {
            addBreadcrumb: vi.fn(),
            captureException: vi.fn(),
            captureMessage: vi.fn(),
          },
        },
      ],
    });

    const service = injector.get(ProjectDataService) as unknown as {
      loadStartupOfflineSnapshot: () => Promise<{
        source: 'idb' | 'localStorage' | 'none';
        projectCount: number;
        bytes: number;
        migratedLegacy: boolean;
        projects: unknown[];
        ownerUserId?: string | null;
      }>;
    };

    const snapshot = await service.loadStartupOfflineSnapshot();
    const persistedPayload = await readOfflineSnapshotFromIdb('user-1');

    expect(snapshot.source).toBe('idb');
    expect((snapshot.projects[0] as { id?: string }).id).toBe('idb-visible-project');
    expect(persistedPayload).toBe(idbPayload);
  }, 10000);

  it('startup snapshot 仅有 legacy localStorage 时应回迁到 IndexedDB', async () => {
    const legacyPayload = JSON.stringify({
      projects: [
        {
          id: 'legacy-project',
          name: 'Legacy Project',
          description: 'from localStorage',
          createdDate: '2026-03-25T00:00:00.000Z',
          tasks: [],
          connections: [],
        },
      ],
      version: 6,
    });

    localStorage.setItem(OFFLINE_SNAPSHOT_LOCAL_STORAGE_KEY, legacyPayload);

    const injector = Injector.create({
      providers: [
        { provide: ProjectDataService, useClass: ProjectDataService },
        {
          provide: SupabaseClientService,
          useValue: {
            isConfigured: false,
            clientAsync: vi.fn(),
          },
        },
        {
          provide: AuthService,
          useValue: {
            currentUserId: vi.fn(() => null),
          },
        },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              debug: vi.fn(),
              info: vi.fn(),
              warn: vi.fn(),
              error: vi.fn(),
            }),
          },
        },
        {
          provide: RequestThrottleService,
          useValue: {
            execute: vi.fn(),
          },
        },
        {
          provide: SyncStateService,
          useValue: {
            setSyncError: vi.fn(),
          },
        },
        {
          provide: TombstoneService,
          useValue: {
            getTombstonesWithCache: vi.fn().mockResolvedValue({ data: [], error: null }),
            getLocalTombstones: vi.fn().mockReturnValue(new Set()),
          },
        },
        {
          provide: SentryLazyLoaderService,
          useValue: {
            addBreadcrumb: vi.fn(),
            captureException: vi.fn(),
            captureMessage: vi.fn(),
          },
        },
      ],
    });

    const service = injector.get(ProjectDataService) as unknown as {
      loadStartupOfflineSnapshot: () => Promise<{
        source: 'idb' | 'localStorage' | 'none';
        projectCount: number;
        bytes: number;
        migratedLegacy: boolean;
        projects: unknown[];
        ownerUserId?: string | null;
      }>;
    };

    const snapshot = await service.loadStartupOfflineSnapshot();
    const migratedPayload = await readOfflineSnapshotFromIdb(AUTH_CONFIG.LOCAL_MODE_USER_ID);

    expect(snapshot.source).toBe('localStorage');
    expect(snapshot.projectCount).toBe(1);
    expect(snapshot.migratedLegacy).toBe(true);
    expect(snapshot.ownerUserId).toBe(AUTH_CONFIG.LOCAL_MODE_USER_ID);
    expect(snapshot.bytes).toBeGreaterThan(0);
    expect(snapshot.projects).toHaveLength(1);
    expect((snapshot.projects[0] as { id?: string }).id).toBe('legacy-project');
    expect(migratedPayload).toBe(legacyPayload);
  }, 10000);

  it('saveOfflineSnapshot 应写入 ownerUserId，并在启动恢复时返回该元数据', async () => {
    localStorage.removeItem(OFFLINE_SNAPSHOT_LOCAL_STORAGE_KEY);
    await clearOfflineSnapshotIdb();

    const injector = Injector.create({
      providers: [
        { provide: ProjectDataService, useClass: ProjectDataService },
        {
          provide: SupabaseClientService,
          useValue: {
            isConfigured: false,
            clientAsync: vi.fn(),
          },
        },
        {
          provide: AuthService,
          useValue: {
            currentUserId: vi.fn(() => 'owner-user'),
          },
        },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              debug: vi.fn(),
              info: vi.fn(),
              warn: vi.fn(),
              error: vi.fn(),
            }),
          },
        },
        {
          provide: RequestThrottleService,
          useValue: {
            execute: vi.fn(),
          },
        },
        {
          provide: SyncStateService,
          useValue: {
            setSyncError: vi.fn(),
          },
        },
        {
          provide: TombstoneService,
          useValue: {
            getTombstonesWithCache: vi.fn().mockResolvedValue({ data: [], error: null }),
            getLocalTombstones: vi.fn().mockReturnValue(new Set()),
          },
        },
        {
          provide: SentryLazyLoaderService,
          useValue: {
            addBreadcrumb: vi.fn(),
            captureException: vi.fn(),
            captureMessage: vi.fn(),
          },
        },
      ],
    });

    const service = injector.get(ProjectDataService);
    service.saveOfflineSnapshot([
      {
        id: 'owner-project',
        name: 'Owner Project',
        description: '',
        createdDate: '2026-03-31T00:00:00.000Z',
        tasks: [],
        connections: [],
      },
    ] as any);
    await new Promise(resolve => setTimeout(resolve, 0));

    const snapshot = await service.loadStartupOfflineSnapshot();

    expect(snapshot.ownerUserId).toBe('owner-user');
    expect(snapshot.projects).toHaveLength(1);
  }, 10000);

  it('saveOfflineSnapshot 在 currentUserId 为空但 confirmed session 已知时应写入真实 owner', async () => {
    localStorage.removeItem(OFFLINE_SNAPSHOT_LOCAL_STORAGE_KEY);
    await clearOfflineSnapshotIdb();

    const injector = Injector.create({
      providers: [
        { provide: ProjectDataService, useClass: ProjectDataService },
        {
          provide: SupabaseClientService,
          useValue: {
            isConfigured: false,
            clientAsync: vi.fn(),
          },
        },
        {
          provide: AuthService,
          useValue: {
            currentUserId: vi.fn(() => null),
            peekPersistedSessionIdentity: vi.fn(() => ({
              userId: 'confirmed-owner',
              email: 'confirmed@example.com',
            })),
          },
        },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              debug: vi.fn(),
              info: vi.fn(),
              warn: vi.fn(),
              error: vi.fn(),
            }),
          },
        },
        {
          provide: RequestThrottleService,
          useValue: {
            execute: vi.fn(),
          },
        },
        {
          provide: SyncStateService,
          useValue: {
            setSyncError: vi.fn(),
          },
        },
        {
          provide: TombstoneService,
          useValue: {
            getTombstonesWithCache: vi.fn().mockResolvedValue({ data: [], error: null }),
            getLocalTombstones: vi.fn().mockReturnValue(new Set()),
          },
        },
        {
          provide: SentryLazyLoaderService,
          useValue: {
            addBreadcrumb: vi.fn(),
            captureException: vi.fn(),
            captureMessage: vi.fn(),
          },
        },
      ],
    });

    const service = injector.get(ProjectDataService);
    service.saveOfflineSnapshot([
      {
        id: 'confirmed-session-project',
        name: 'Confirmed Session Project',
        description: '',
        createdDate: '2026-03-31T00:00:00.000Z',
        tasks: [],
        connections: [],
      },
    ] as any);
    await new Promise(resolve => setTimeout(resolve, 0));

    const snapshot = await service.loadStartupOfflineSnapshot();
    expect(snapshot.ownerUserId).toBe('confirmed-owner');
  }, 10000);

  it('hint-only 启动占位态下不应覆盖真实离线快照', async () => {
    const injector = Injector.create({
      providers: [
        { provide: ProjectDataService, useClass: ProjectDataService },
        {
          provide: StartupPlaceholderStateService,
          useValue: {
            isHintOnlyActive: vi.fn(() => true),
          },
        },
        {
          provide: SupabaseClientService,
          useValue: {
            isConfigured: false,
            clientAsync: vi.fn(),
          },
        },
        {
          provide: AuthService,
          useValue: {
            currentUserId: vi.fn(() => null),
          },
        },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              debug: vi.fn(),
              info: vi.fn(),
              warn: vi.fn(),
              error: vi.fn(),
            }),
          },
        },
        {
          provide: RequestThrottleService,
          useValue: {
            execute: vi.fn(),
          },
        },
        {
          provide: SyncStateService,
          useValue: {
            setSyncError: vi.fn(),
          },
        },
        {
          provide: TombstoneService,
          useValue: {
            getTombstonesWithCache: vi.fn().mockResolvedValue({ data: [], error: null }),
            getLocalTombstones: vi.fn().mockReturnValue(new Set()),
          },
        },
        {
          provide: SentryLazyLoaderService,
          useValue: {
            addBreadcrumb: vi.fn(),
            captureException: vi.fn(),
            captureMessage: vi.fn(),
          },
        },
      ],
    });

    const service = injector.get(ProjectDataService);
    service.saveOfflineSnapshot([
      {
        id: 'placeholder-project',
        name: 'Project 1',
        description: '',
        createdDate: '2026-03-31T00:00:00.000Z',
        tasks: [],
        connections: [],
      },
    ] as any);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(localStorage.getItem(OFFLINE_SNAPSHOT_LOCAL_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(getOfflineSnapshotStorageKey(AUTH_CONFIG.LOCAL_MODE_USER_ID))).toBeNull();
    const snapshot = await service.loadStartupOfflineSnapshot();
    expect(snapshot.projectCount).toBe(0);
  }, 10000);

  it('loadOfflineSnapshot 默认不应因 persisted owner hint 放宽 owner 可见性', () => {
    localStorage.setItem(getOfflineSnapshotStorageKey('user-1'), JSON.stringify({
      projects: [
        {
          id: 'persisted-owner-project',
          name: 'Persisted Owner Project',
          description: 'from scoped snapshot',
          createdDate: '2026-03-25T00:00:00.000Z',
          updatedAt: '2026-03-25T00:00:00.000Z',
          tasks: [],
          connections: [],
        },
      ],
      version: 6,
      ownerUserId: 'user-1',
    }));

    const injector = Injector.create({
      providers: [
        { provide: ProjectDataService, useClass: ProjectDataService },
        {
          provide: SupabaseClientService,
          useValue: {
            isConfigured: false,
            clientAsync: vi.fn(),
          },
        },
        {
          provide: AuthService,
          useValue: {
            currentUserId: vi.fn(() => null),
            peekPersistedSessionIdentity: vi.fn(() => null),
            peekPersistedOwnerHint: vi.fn(() => 'user-1'),
          },
        },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              debug: vi.fn(),
              info: vi.fn(),
              warn: vi.fn(),
              error: vi.fn(),
            }),
          },
        },
        {
          provide: RequestThrottleService,
          useValue: {
            execute: vi.fn(),
          },
        },
        {
          provide: SyncStateService,
          useValue: {
            setSyncError: vi.fn(),
          },
        },
        {
          provide: TombstoneService,
          useValue: {
            getTombstonesWithCache: vi.fn().mockResolvedValue({ data: [], error: null }),
            getLocalTombstones: vi.fn().mockReturnValue(new Set()),
          },
        },
        {
          provide: SentryLazyLoaderService,
          useValue: {
            addBreadcrumb: vi.fn(),
            captureException: vi.fn(),
            captureMessage: vi.fn(),
          },
        },
      ],
    });

    const service = injector.get(ProjectDataService);
    const safeSnapshot = service.loadOfflineSnapshot();
    const hintedSnapshot = service.loadOfflineSnapshot({ allowOwnerHint: true });

    expect(safeSnapshot).toBeNull();
    expect(hintedSnapshot).toEqual([
      expect.objectContaining({ id: 'persisted-owner-project', name: 'Persisted Owner Project' }),
    ]);
  });

  it('loadOfflineSnapshot 在当前 owner 与快照 owner 不匹配时应直接丢弃', () => {
    localStorage.setItem(getOfflineSnapshotStorageKey('user-1'), JSON.stringify({
      projects: [
        {
          id: 'foreign-owner-project',
          name: 'Foreign Owner Project',
          description: 'should stay isolated',
          createdDate: '2026-03-25T00:00:00.000Z',
          updatedAt: '2026-03-25T00:00:00.000Z',
          tasks: [],
          connections: [],
        },
      ],
      version: 6,
      ownerUserId: 'user-1',
    }));

    const injector = Injector.create({
      providers: [
        { provide: ProjectDataService, useClass: ProjectDataService },
        {
          provide: SupabaseClientService,
          useValue: {
            isConfigured: false,
            clientAsync: vi.fn(),
          },
        },
        {
          provide: AuthService,
          useValue: {
            currentUserId: vi.fn(() => 'user-2'),
            peekPersistedSessionIdentity: vi.fn(() => null),
            peekPersistedOwnerHint: vi.fn(() => 'user-1'),
          },
        },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              debug: vi.fn(),
              info: vi.fn(),
              warn: vi.fn(),
              error: vi.fn(),
            }),
          },
        },
        {
          provide: RequestThrottleService,
          useValue: {
            execute: vi.fn(),
          },
        },
        {
          provide: SyncStateService,
          useValue: {
            setSyncError: vi.fn(),
          },
        },
        {
          provide: TombstoneService,
          useValue: {
            getTombstonesWithCache: vi.fn().mockResolvedValue({ data: [], error: null }),
            getLocalTombstones: vi.fn().mockReturnValue(new Set()),
          },
        },
        {
          provide: SentryLazyLoaderService,
          useValue: {
            addBreadcrumb: vi.fn(),
            captureException: vi.fn(),
            captureMessage: vi.fn(),
          },
        },
      ],
    });

    const service = injector.get(ProjectDataService);

    expect(service.loadOfflineSnapshot()).toBeNull();
    expect(service.loadOfflineSnapshot({ allowOwnerHint: true })).toBeNull();
  });

  it('loadOfflineSnapshot 缺少 owner 元数据时应直接丢弃', () => {
    localStorage.setItem(getOfflineSnapshotStorageKey('user-1'), JSON.stringify({
      projects: [
        {
          id: 'ownerless-project',
          name: 'Ownerless Project',
          description: 'legacy payload without owner',
          createdDate: '2026-03-25T00:00:00.000Z',
          updatedAt: '2026-03-25T00:00:00.000Z',
          tasks: [],
          connections: [],
        },
      ],
      version: 6,
    }));

    const injector = Injector.create({
      providers: [
        { provide: ProjectDataService, useClass: ProjectDataService },
        {
          provide: SupabaseClientService,
          useValue: {
            isConfigured: false,
            clientAsync: vi.fn(),
          },
        },
        {
          provide: AuthService,
          useValue: {
            currentUserId: vi.fn(() => 'user-1'),
          },
        },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              debug: vi.fn(),
              info: vi.fn(),
              warn: vi.fn(),
              error: vi.fn(),
            }),
          },
        },
        {
          provide: RequestThrottleService,
          useValue: {
            execute: vi.fn(),
          },
        },
        {
          provide: SyncStateService,
          useValue: {
            setSyncError: vi.fn(),
          },
        },
        {
          provide: TombstoneService,
          useValue: {
            getTombstonesWithCache: vi.fn().mockResolvedValue({ data: [], error: null }),
            getLocalTombstones: vi.fn().mockReturnValue(new Set()),
          },
        },
        {
          provide: SentryLazyLoaderService,
          useValue: {
            addBreadcrumb: vi.fn(),
            captureException: vi.fn(),
            captureMessage: vi.fn(),
          },
        },
      ],
    });

    const service = injector.get(ProjectDataService);

    expect(service.loadOfflineSnapshot()).toBeNull();
  });

  it('loadProjectListMetadataFromCloud 应仅返回项目壳数据，不触发完整项目展开', async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const throttleExecute = vi.fn(async (_key: string, operation: () => Promise<unknown>) => operation());
    const order = vi.fn().mockResolvedValue({
      data: [{
        id: 'proj-remote',
        title: '云端项目',
        description: '只需要壳数据',
        created_date: '2026-03-30T00:00:00.000Z',
        updated_at: '2026-03-30T01:00:00.000Z',
        deleted_at: null,
        version: 3,
      }],
      error: null,
    });
    const is = vi.fn(() => ({ order }));
    const eq = vi.fn(() => ({ is }));
    const select = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ select }));

    const injector = Injector.create({
      providers: [
        { provide: ProjectDataService, useClass: ProjectDataService },
        {
          provide: SupabaseClientService,
          useValue: {
            isConfigured: true,
            clientAsync: vi.fn(async () => ({ from })),
          },
        },
        {
          provide: LoggerService,
          useValue: {
            category: () => logger,
          },
        },
        {
          provide: RequestThrottleService,
          useValue: {
            execute: throttleExecute,
          },
        },
        {
          provide: SyncStateService,
          useValue: {
            setSyncError: vi.fn(),
          },
        },
        {
          provide: TombstoneService,
          useValue: {
            getTombstonesWithCache: vi.fn().mockResolvedValue({ data: [], error: null }),
            getLocalTombstones: vi.fn().mockReturnValue(new Set()),
          },
        },
        {
          provide: SentryLazyLoaderService,
          useValue: {
            addBreadcrumb: vi.fn(),
            captureException: vi.fn(),
            captureMessage: vi.fn(),
          },
        },
      ],
    });

    const service = injector.get(ProjectDataService);
    const loadFullProjectSpy = vi.spyOn(service, 'loadFullProjectOptimized');

    const result = await service.loadProjectListMetadataFromCloud('user-1');

    expect(result).toEqual([
      {
        id: 'proj-remote',
        name: '云端项目',
        description: '只需要壳数据',
        createdDate: '2026-03-30T00:00:00.000Z',
        updatedAt: '2026-03-30T01:00:00.000Z',
        version: 3,
        syncSource: 'synced',
        pendingSync: false,
        tasks: [],
        connections: [],
      },
    ]);
    expect(loadFullProjectSpy).not.toHaveBeenCalled();
    expect(throttleExecute).toHaveBeenCalledOnce();
    expect(is).toHaveBeenCalledWith('deleted_at', null);
  });

  it('rowToProject 应映射 deleted_at 字段', () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const injector = Injector.create({
      providers: [
        { provide: ProjectDataService, useClass: ProjectDataService },
        {
          provide: SupabaseClientService,
          useValue: {
            isConfigured: false,
            clientAsync: vi.fn(),
          },
        },
        {
          provide: LoggerService,
          useValue: {
            category: () => logger,
          },
        },
        {
          provide: RequestThrottleService,
          useValue: {
            execute: vi.fn(),
          },
        },
        {
          provide: SyncStateService,
          useValue: {
            setSyncError: vi.fn(),
          },
        },
        {
          provide: TombstoneService,
          useValue: {
            getTombstonesWithCache: vi.fn().mockResolvedValue({ data: [], error: null }),
            getLocalTombstones: vi.fn().mockReturnValue(new Set()),
          },
        },
        {
          provide: SentryLazyLoaderService,
          useValue: {
            addBreadcrumb: vi.fn(),
            captureException: vi.fn(),
            captureMessage: vi.fn(),
          },
        },
      ],
    });

    const service = injector.get(ProjectDataService);
    const project = service.rowToProject({
      id: 'proj-deleted',
      title: '已删除项目',
      description: 'soft delete tombstone',
      created_date: '2026-04-03T00:00:00.000Z',
      updated_at: '2026-04-03T00:05:00.000Z',
      deleted_at: '2026-04-03T00:06:00.000Z',
      version: 7,
    });

    expect(project).toMatchObject({
      id: 'proj-deleted',
      deletedAt: '2026-04-03T00:06:00.000Z',
      version: 7,
    });
  });

  it('loadProjectListMetadataFromCloud 遇到错误时应返回 null，避免把失败误判为空列表', async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const sentry = {
      addBreadcrumb: vi.fn(),
      captureException: vi.fn(),
      captureMessage: vi.fn(),
    };
    const throttleExecute = vi.fn().mockRejectedValue(new Error('network unavailable'));

    const injector = Injector.create({
      providers: [
        { provide: ProjectDataService, useClass: ProjectDataService },
        {
          provide: SupabaseClientService,
          useValue: {
            isConfigured: true,
            clientAsync: vi.fn(async () => ({ from: vi.fn() })),
          },
        },
        {
          provide: LoggerService,
          useValue: {
            category: () => logger,
          },
        },
        {
          provide: RequestThrottleService,
          useValue: {
            execute: throttleExecute,
          },
        },
        {
          provide: SyncStateService,
          useValue: {
            setSyncError: vi.fn(),
          },
        },
        {
          provide: TombstoneService,
          useValue: {
            getTombstonesWithCache: vi.fn().mockResolvedValue({ data: [], error: null }),
            getLocalTombstones: vi.fn().mockReturnValue(new Set()),
          },
        },
        {
          provide: SentryLazyLoaderService,
          useValue: sentry,
        },
      ],
    });

    const service = injector.get(ProjectDataService);

    const result = await service.loadProjectListMetadataFromCloud('user-1');

    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith('加载项目元数据列表失败', expect.any(Error));
    expect(sentry.captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { operation: 'loadProjectListMetadataFromCloud' }
    });
  });

  it('loadProjectListMetadataFromCloud 在瞬时超时时应降级为软失败而非告警', async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const sentry = {
      addBreadcrumb: vi.fn(),
      captureException: vi.fn(),
      captureMessage: vi.fn(),
    };
    const throttleExecute = vi.fn().mockRejectedValue(
      new Error('请求超时 (10000ms): project-list-metadata:user-1')
    );

    const injector = Injector.create({
      providers: [
        { provide: ProjectDataService, useClass: ProjectDataService },
        {
          provide: SupabaseClientService,
          useValue: {
            isConfigured: true,
            clientAsync: vi.fn(async () => ({ from: vi.fn() })),
          },
        },
        {
          provide: LoggerService,
          useValue: {
            category: () => logger,
          },
        },
        {
          provide: RequestThrottleService,
          useValue: {
            execute: throttleExecute,
          },
        },
        {
          provide: SyncStateService,
          useValue: {
            setSyncError: vi.fn(),
          },
        },
        {
          provide: TombstoneService,
          useValue: {
            getTombstonesWithCache: vi.fn().mockResolvedValue({ data: [], error: null }),
            getLocalTombstones: vi.fn().mockReturnValue(new Set()),
          },
        },
        {
          provide: SentryLazyLoaderService,
          useValue: sentry,
        },
      ],
    });

    const service = injector.get(ProjectDataService);

    const result = await service.loadProjectListMetadataFromCloud('user-1', {
      timeout: TIMEOUT_CONFIG.STANDARD,
      retries: 1,
      purpose: 'sync-download-merge',
      treatTransientFailureAsSoft: true,
    });

    expect(result).toBeNull();
    expect(logger.info).toHaveBeenCalledWith(
      '项目元数据列表拉取暂时不可用，已降级为软失败',
      expect.objectContaining({
        userId: 'user-1',
        purpose: 'sync-download-merge',
      })
    );
    expect(logger.warn).not.toHaveBeenCalled();
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it('loadProjectListMetadataFromCloud 不同执行策略应使用不同去重 key', async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const order = vi.fn().mockResolvedValue({ data: [], error: null });
    const is = vi.fn().mockReturnValue({ order });
    const eq = vi.fn().mockReturnValue({ is });
    const select = vi.fn().mockReturnValue({ eq });
    const from = vi.fn().mockReturnValue({ select });
    const throttleExecute = vi.fn(async (_key: string, executor: () => Promise<unknown>) => executor());

    const injector = Injector.create({
      providers: [
        { provide: ProjectDataService, useClass: ProjectDataService },
        {
          provide: SupabaseClientService,
          useValue: {
            isConfigured: true,
            clientAsync: vi.fn(async () => ({ from })),
          },
        },
        {
          provide: LoggerService,
          useValue: {
            category: () => logger,
          },
        },
        {
          provide: RequestThrottleService,
          useValue: {
            execute: throttleExecute,
          },
        },
        {
          provide: SyncStateService,
          useValue: {
            setSyncError: vi.fn(),
          },
        },
        {
          provide: TombstoneService,
          useValue: {
            getTombstonesWithCache: vi.fn().mockResolvedValue({ data: [], error: null }),
            getLocalTombstones: vi.fn().mockReturnValue(new Set()),
          },
        },
        {
          provide: SentryLazyLoaderService,
          useValue: {
            addBreadcrumb: vi.fn(),
            captureException: vi.fn(),
            captureMessage: vi.fn(),
          },
        },
      ],
    });

    const service = injector.get(ProjectDataService);

    await service.loadProjectListMetadataFromCloud('user-1');
    await service.loadProjectListMetadataFromCloud('user-1', {
      timeout: TIMEOUT_CONFIG.STANDARD,
      retries: 1,
      purpose: 'sync-download-merge',
    });

    expect(throttleExecute).toHaveBeenNthCalledWith(
      1,
      'project-list-metadata:user-1:5000:0',
      expect.any(Function),
      expect.objectContaining({ timeout: 5000, retries: 0 })
    );
    expect(throttleExecute).toHaveBeenNthCalledWith(
      2,
      'project-list-metadata:user-1:10000:1',
      expect.any(Function),
      expect.objectContaining({ timeout: 10000, retries: 1 })
    );
  });

  it('rowToTask 遇到缺失 content 字段时应告警并上报采样监控', () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const sentry = {
      addBreadcrumb: vi.fn(),
      captureException: vi.fn(),
      captureMessage: vi.fn(),
    };

    const injector = Injector.create({
      providers: [
        { provide: ProjectDataService, useClass: ProjectDataService },
        {
          provide: SupabaseClientService,
          useValue: {
            isConfigured: false,
            clientAsync: vi.fn(),
          },
        },
        {
          provide: LoggerService,
          useValue: {
            category: () => logger,
          },
        },
        {
          provide: RequestThrottleService,
          useValue: {
            execute: vi.fn(),
          },
        },
        {
          provide: SyncStateService,
          useValue: {
            setSyncError: vi.fn(),
          },
        },
        {
          provide: TombstoneService,
          useValue: {
            getTombstonesWithCache: vi.fn().mockResolvedValue({ data: [], error: null }),
            getLocalTombstones: vi.fn().mockReturnValue(new Set()),
          },
        },
        {
          provide: SentryLazyLoaderService,
          useValue: sentry,
        },
      ],
    });

    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.01);
    const service = injector.get(ProjectDataService);

    const task = service.rowToTask({
      id: 'task-missing-content',
      title: '缺少正文',
      stage: 1,
      updated_at: '2026-03-29T00:00:00.000Z',
    } as never);

    expect(task.content).toBe('');
    expect(hasTaskContentMissingFromSource(task)).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      'rowToTask: content 字段缺失，可能导致数据丢失！',
      expect.objectContaining({
        taskId: 'task-missing-content',
        hasTitle: true,
        hasStage: true,
      })
    );
    expect(sentry.captureMessage).toHaveBeenCalledWith(
      'Sync Warning: Task content field missing',
      expect.objectContaining({
        level: 'warning',
        tags: expect.objectContaining({
          operation: 'rowToTask',
          taskId: 'task-missing-content',
        }),
      })
    );

    randomSpy.mockRestore();
  });

  it('pullTasksThrottled 遇到 completed_at 缺列时应降级重试并继续加载项目任务', async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const missingCompletedAtError = {
      code: '42703',
      message: 'column tasks.completed_at does not exist',
      details: null,
      hint: null,
    };
    const taskRow = {
      id: 'task-legacy-schema',
      title: '旧 schema 任务',
      content: '项目必须能继续加载',
      stage: 1,
      parent_id: null,
      order: 0,
      rank: 10000,
      status: 'active',
      x: 0,
      y: 0,
      updated_at: '2026-04-28T00:00:00.000Z',
      deleted_at: null,
      short_id: null,
      attachments: [],
      tags: [],
      priority: null,
      due_date: null,
      expected_minutes: null,
      cognitive_load: null,
      wait_minutes: null,
      created_at: '2026-04-27T00:00:00.000Z',
      parking_meta: null,
    };
    const eq = vi
      .fn()
      .mockResolvedValueOnce({ data: null, error: missingCompletedAtError })
      .mockResolvedValueOnce({ data: [taskRow], error: null });
    const select = vi.fn(() => ({ eq }));
    const client = {
      from: vi.fn(() => ({ select })),
    };
    const throttleExecute = vi.fn(async (_key: string, operation: () => Promise<unknown>) => operation());

    const injector = Injector.create({
      providers: [
        { provide: ProjectDataService, useClass: ProjectDataService },
        {
          provide: SupabaseClientService,
          useValue: {
            isConfigured: false,
            clientAsync: vi.fn(),
          },
        },
        {
          provide: LoggerService,
          useValue: {
            category: () => logger,
          },
        },
        {
          provide: RequestThrottleService,
          useValue: {
            execute: throttleExecute,
          },
        },
        {
          provide: SyncStateService,
          useValue: {
            setSyncError: vi.fn(),
          },
        },
        {
          provide: TombstoneService,
          useValue: {
            getTombstonesWithCache: vi.fn().mockResolvedValue({ data: [], error: null }),
            shouldMaterializeTaskDeletion: vi.fn().mockReturnValue(false),
            getLocalTombstoneTimestamp: vi.fn().mockReturnValue(undefined),
            clearLocalTombstones: vi.fn(),
          },
        },
        {
          provide: SentryLazyLoaderService,
          useValue: {
            addBreadcrumb: vi.fn(),
            captureException: vi.fn(),
            captureMessage: vi.fn(),
          },
        },
      ],
    });

    const service = injector.get(ProjectDataService);
    const result = await (service as unknown as {
      pullTasksThrottled: (projectId: string, client: unknown) => Promise<unknown[]>;
    }).pullTasksThrottled('project-legacy-schema', client);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'task-legacy-schema',
      title: '旧 schema 任务',
      completedAt: null,
    });
    expect(select).toHaveBeenNthCalledWith(1, FIELD_SELECT_CONFIG.TASK_LIST_FIELDS);
    expect(select).toHaveBeenNthCalledWith(
      2,
      expect.not.stringContaining('completed_at')
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'tasks.completed_at 缺失，已降级为旧 schema 任务字段',
      expect.objectContaining({ projectId: 'project-legacy-schema' })
    );
  });

  it('pullTasksThrottled materialize tombstone 时应保留缺失 content marker', async () => {
    const taskRow = {
      id: 'task-missing-content-tombstone',
      title: '缺失正文但被 tombstone 物化',
      stage: 1,
      parent_id: null,
      order: 0,
      rank: 10000,
      status: 'active',
      x: 0,
      y: 0,
      updated_at: '2026-04-28T00:00:00.000Z',
      deleted_at: null,
      short_id: null,
      attachments: [],
      tags: [],
      priority: null,
      due_date: null,
      expected_minutes: null,
      cognitive_load: null,
      wait_minutes: null,
      created_at: '2026-04-27T00:00:00.000Z',
      parking_meta: null,
    };
    const eq = vi.fn().mockResolvedValue({ data: [taskRow], error: null });
    const select = vi.fn(() => ({ eq }));
    const client = {
      from: vi.fn(() => ({ select })),
    };
    const throttleExecute = vi.fn(async (_key: string, operation: () => Promise<unknown>) => operation());

    const injector = Injector.create({
      providers: [
        { provide: ProjectDataService, useClass: ProjectDataService },
        {
          provide: SupabaseClientService,
          useValue: {
            isConfigured: false,
            clientAsync: vi.fn(),
          },
        },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              debug: vi.fn(),
              info: vi.fn(),
              warn: vi.fn(),
              error: vi.fn(),
            }),
          },
        },
        {
          provide: RequestThrottleService,
          useValue: {
            execute: throttleExecute,
          },
        },
        {
          provide: SyncStateService,
          useValue: {
            setSyncError: vi.fn(),
          },
        },
        {
          provide: TombstoneService,
          useValue: {
            getTombstonesWithCache: vi.fn().mockResolvedValue({ data: [], error: null }),
            shouldMaterializeTaskDeletion: vi.fn().mockImplementation((_updatedAt: string | undefined, deletedAt?: number) => deletedAt !== undefined),
            getLocalTombstoneTimestamp: vi.fn().mockReturnValue(Date.parse('2026-04-29T00:00:00.000Z')),
            clearLocalTombstones: vi.fn(),
          },
        },
        {
          provide: SentryLazyLoaderService,
          useValue: {
            addBreadcrumb: vi.fn(),
            captureException: vi.fn(),
            captureMessage: vi.fn(),
          },
        },
      ],
    });

    const service = injector.get(ProjectDataService);
    const result = await (service as unknown as {
      pullTasksThrottled: (projectId: string, client: unknown) => Promise<Task[]>;
    }).pullTasksThrottled('project-marker-clone', client);

    expect(result).toHaveLength(1);
    expect(result[0]?.deletedAt).toBe('2026-04-29T00:00:00.000Z');
    expect(hasTaskContentMissingFromSource(result[0])).toBe(true);
  });
});
