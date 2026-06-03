import { Injector } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectDataService } from './project-data.service';
import { SupabaseClientService } from '../../../../services/supabase-client.service';
import { AuthService } from '../../../../services/auth.service';
import { LoggerService } from '../../../../services/logger.service';
import { RequestThrottleService } from '../../../../services/request-throttle.service';
import { SyncStateService } from './sync-state.service';
import { TombstoneService } from './tombstone.service';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import { resetBrowserNetworkSuspensionTrackingForTests } from '../../../../utils/browser-network-suspension';
import { FEATURE_FLAGS } from '../../../../config/feature-flags.config';

const OFFLINE_SNAPSHOT_LOCAL_STORAGE_KEY = 'nanoflow.offline-cache-v2';

type MutableProjectDataFeatureFlags = {
  PROJECT_FULL_DATA_RPC_V1: boolean;
};

const projectDataFeatureFlags = FEATURE_FLAGS as unknown as MutableProjectDataFeatureFlags;
const initialProjectFullDataRpcFlag = FEATURE_FLAGS.PROJECT_FULL_DATA_RPC_V1;

function createProjectDataService(options: {
  client?: unknown;
  currentUserId?: string | null;
} = {}): ProjectDataService {
  const clientAsync = vi.fn(async () => options.client ?? null);

  const injector = Injector.create({
    providers: [
      { provide: ProjectDataService, useClass: ProjectDataService },
      {
        provide: SupabaseClientService,
        useValue: {
          isConfigured: Boolean(options.client),
          clientAsync,
        },
      },
      {
        provide: AuthService,
        useValue: {
          currentUserId: vi.fn(() => options.currentUserId ?? 'user-1'),
        },
      },
      {
        provide: LoggerService,
        useValue: {
          category: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
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

  return injector.get(ProjectDataService);
}

describe('ProjectDataService connection delete regressions', () => {
  beforeEach(() => {
    projectDataFeatureFlags.PROJECT_FULL_DATA_RPC_V1 = false;
    localStorage.clear();
    resetBrowserNetworkSuspensionTrackingForTests();
  });

  afterEach(() => {
    projectDataFeatureFlags.PROJECT_FULL_DATA_RPC_V1 = initialProjectFullDataRpcFlag;
  });

  it('loadFullProject fallback 应保留 soft-deleted connections', async () => {
    const projectRow = {
      id: 'proj-1',
      owner_id: 'user-1',
      title: 'Project 1',
      description: '',
      created_date: '2026-04-11T00:00:00.000Z',
      updated_at: '2026-04-11T00:00:00.000Z',
      deleted_at: null,
      version: 1,
    };
    const deletedConnectionRow = {
      id: 'conn-1',
      source_id: 'task-1',
      target_id: 'task-2',
      title: 'Cross tree link',
      description: 'deleted on desktop',
      deleted_at: '2026-04-11T01:00:00.000Z',
      updated_at: '2026-04-11T01:00:00.000Z',
    };

    const projectMaybeSingle = vi.fn().mockResolvedValue({ data: projectRow, error: null });
    const projectIs = vi.fn().mockReturnValue({ maybeSingle: projectMaybeSingle });
    const projectEq = vi.fn().mockReturnValue({ is: projectIs });
    const taskEq = vi.fn().mockResolvedValue({ data: [], error: null });
    const connectionEq = vi.fn().mockResolvedValue({ data: [deletedConnectionRow], error: null });

    const client = {
      from: vi.fn((table: string) => {
        if (table === 'projects') {
          return {
            select: vi.fn().mockReturnValue({ eq: projectEq }),
          };
        }

        if (table === 'tasks') {
          return {
            select: vi.fn().mockReturnValue({ eq: taskEq }),
          };
        }

        if (table === 'connections') {
          return {
            select: vi.fn().mockReturnValue({ eq: connectionEq }),
          };
        }

        throw new Error(`Unexpected table: ${table}`);
      }),
    };

    const service = createProjectDataService({ client });
    const project = await service.loadFullProject('proj-1');

    expect(project?.connections).toEqual([
      expect.objectContaining({
        id: 'conn-1',
        source: 'task-1',
        target: 'task-2',
        deletedAt: '2026-04-11T01:00:00.000Z',
        updatedAt: '2026-04-11T01:00:00.000Z',
      }),
    ]);
    expect(connectionEq).toHaveBeenCalledWith('project_id', 'proj-1');
  });

  it('loadFullProjectOptimized 主 RPC 路径应保留未 tombstone 的 soft-deleted connection', async () => {
    projectDataFeatureFlags.PROJECT_FULL_DATA_RPC_V1 = true;

    const deletedConnectionRow = {
      id: 'conn-rpc-1',
      source_id: 'task-1',
      target_id: 'task-2',
      title: 'Cross tree link',
      description: 'deleted on desktop',
      deleted_at: '2026-04-11T01:00:00.000Z',
      updated_at: '2026-04-11T01:00:00.000Z',
    };
    const client = {
      rpc: vi.fn().mockResolvedValue({
        data: {
          project: {
            id: 'proj-1',
            owner_id: 'user-1',
            title: 'Project 1',
            description: '',
            created_date: '2026-04-11T00:00:00.000Z',
            updated_at: '2026-04-11T00:00:00.000Z',
            deleted_at: null,
            version: 1,
          },
          tasks: [],
          connections: [deletedConnectionRow],
          task_tombstones: [],
          connection_tombstones: [],
        },
        error: null,
      }),
    };

    const service = createProjectDataService({ client });
    const project = await service.loadFullProjectOptimized('proj-1');

    expect(project?.connections).toEqual([
      expect.objectContaining({
        id: 'conn-rpc-1',
        deletedAt: '2026-04-11T01:00:00.000Z',
        updatedAt: '2026-04-11T01:00:00.000Z',
      }),
    ]);
    expect((client.rpc as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('get_full_project_data', {
      p_project_id: 'proj-1',
    });
  });

  it('saveOfflineSnapshot 应保留活跃任务之间的已删连接', async () => {
    const service = createProjectDataService({ currentUserId: 'user-connection-delete' });

    await service.saveOfflineSnapshotAndWait([
      {
        id: 'proj-1',
        name: 'Project 1',
        description: '',
        createdDate: '2026-04-11T00:00:00.000Z',
        tasks: [
          { id: 'task-1', deletedAt: null },
          { id: 'task-2', deletedAt: null },
        ],
        connections: [
          {
            id: 'conn-1',
            source: 'task-1',
            target: 'task-2',
            description: 'deleted on desktop',
            deletedAt: '2026-04-11T01:00:00.000Z',
            updatedAt: '2026-04-11T01:00:00.000Z',
          },
        ],
      },
    ] as never[], 'user-connection-delete');

    const payload = JSON.parse(
      localStorage.getItem(`${OFFLINE_SNAPSHOT_LOCAL_STORAGE_KEY}.user-connection-delete`) || 'null'
    );
    const offlineSnapshot = service.loadOfflineSnapshot();
    const startupSnapshot = await service.loadStartupOfflineSnapshot();

    expect(payload.projects[0].connections).toEqual([
      expect.objectContaining({
        id: 'conn-1',
        deletedAt: '2026-04-11T01:00:00.000Z',
      }),
    ]);
    expect(offlineSnapshot?.[0].connections).toEqual([
      expect.objectContaining({
        id: 'conn-1',
        deletedAt: '2026-04-11T01:00:00.000Z',
        updatedAt: '2026-04-11T01:00:00.000Z',
      }),
    ]);
    expect(startupSnapshot.projects[0].connections).toEqual([
      expect.objectContaining({
        id: 'conn-1',
        deletedAt: '2026-04-11T01:00:00.000Z',
        updatedAt: '2026-04-11T01:00:00.000Z',
      }),
    ]);
  });
});
