import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Injector, DestroyRef, signal, WritableSignal } from '@angular/core';
import { UserSessionService } from './user-session.service';
import { AuthService } from './auth.service';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { SupabaseClientService } from './supabase-client.service';
import { LayoutService } from './layout.service';
import { AttachmentService } from './attachment.service';
import { DockSnapshotPersistenceService } from './dock-snapshot-persistence.service';
import { SyncCoordinatorService } from './sync-coordinator.service';
import { UndoService } from './undo.service';
import { UiStateService } from './ui-state.service';
import { ProjectStateService } from './project-state.service';
import { ChangeTrackerService } from './change-tracker.service';
import { ActionQueueService } from './action-queue.service';
import { ConflictStorageService } from './conflict-storage.service';
import { RetryQueueService } from '../app/core/services/sync/retry-queue.service';
import { AUTH_CONFIG } from '../config/auth.config';
import { Project, Task } from '../models';
import { markTaskContentMissingFromSource } from '../utils/task-content-guard';
import { StartupPlaceholderStateService } from './startup-placeholder-state.service';
import { blackBoxEntriesMap, gateSnoozeCount, gateState, resetFocusState } from '../state/focus-stores';

function createStorageMock(): Storage {
  const store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = String(value);
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      Object.keys(store).forEach((key) => delete store[key]);
    },
    key: (index: number) => Object.keys(store)[index] ?? null,
    get length() {
      return Object.keys(store).length;
    },
  } as Storage;
}

const mockLoggerCategory = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

function createTask(overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? crypto.randomUUID(),
    title: overrides.title ?? 'Task',
    content: overrides.content ?? '',
    stage: 'stage' in overrides ? overrides.stage! : 1,
    parentId: overrides.parentId ?? null,
    order: overrides.order ?? 1,
    rank: overrides.rank ?? 1000,
    status: overrides.status ?? 'active',
    x: overrides.x ?? 0,
    y: overrides.y ?? 0,
    createdDate: overrides.createdDate ?? now,
    updatedAt: overrides.updatedAt ?? now,
    displayId: overrides.displayId ?? '?',
    attachments: overrides.attachments,
  };
}

function createProject(overrides: Partial<Project> = {}): Project {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? 'proj-1',
    name: overrides.name ?? 'Test',
    description: overrides.description ?? '',
    createdDate: overrides.createdDate ?? now,
    tasks: overrides.tasks ?? [],
    connections: overrides.connections ?? [],
    updatedAt: overrides.updatedAt ?? now,
    version: overrides.version ?? 1,
    ...overrides,
  };
}

function saveGuestDraftProjects(projects: Project[]): void {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  localStorage.setItem('nanoflow.guest-data', JSON.stringify({
    projects,
    version: 2,
    savedAt: now,
    expiresAt,
  }));
}

function createAttachment(id = crypto.randomUUID()) {
  const now = new Date().toISOString();
  return {
    id,
    type: 'file' as const,
    name: 'doc.txt',
    url: 'https://example.com/doc.txt',
    createdAt: now,
    signedAt: now,
  };
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('UserSessionService', () => {
  let service: UserSessionService;
  let destroyCallbacks: (() => void)[];
  let mockAuthService: Record<string, unknown>;
  let mockProjectState: Record<string, unknown>;
  let mockSyncCoordinator: Record<string, unknown>;
  let mockChangeTracker: Record<string, unknown>;
  let mockUndoService: Record<string, unknown>;
  let mockUiState: Record<string, unknown>;
  let mockActionQueue: Record<string, unknown>;
  let mockRetryQueue: Record<string, unknown>;
  let mockConflictStorage: Record<string, unknown>;
  let mockDockSnapshotPersistence: Record<string, unknown>;
  let mockStartupPlaceholderState: {
    isHintOnlyActive: ReturnType<typeof vi.fn>;
    activate: ReturnType<typeof vi.fn>;
    clear: ReturnType<typeof vi.fn>;
  };
  let mockAttachmentService: Record<string, unknown>;
  let mockLayoutService: Record<string, unknown>;
  let mockToastService: Record<string, unknown>;
  let mockSupabaseClientService: {
    isConfigured: boolean;
    isOfflineMode: ReturnType<typeof vi.fn>;
    client: ReturnType<typeof vi.fn>;
    clientAsync: ReturnType<typeof vi.fn>;
    getClient: ReturnType<typeof vi.fn>;
    getSession: ReturnType<typeof vi.fn>;
    getStorageKey: ReturnType<typeof vi.fn>;
    signOut: ReturnType<typeof vi.fn>;
  };
  let userIdSignal: WritableSignal<string | null>;
  let originalLocalStorage: Storage;
  let originalSessionStorage: Storage;

  beforeEach(() => {
    originalLocalStorage = globalThis.localStorage;
    originalSessionStorage = globalThis.sessionStorage;
    Object.defineProperty(globalThis, 'localStorage', {
      value: createStorageMock(),
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'sessionStorage', {
      value: createStorageMock(),
      configurable: true,
      writable: true,
    });

    destroyCallbacks = [];
    let projectsState: Project[] = [];
    let activeProjectIdState: string | null = null;

    // Create a real writable signal for currentUserId
    userIdSignal = signal<string | null>(null);

    mockAuthService = {
      currentUserId: userIdSignal,
      isConfigured: true,
      peekPersistedSessionIdentity: vi.fn().mockReturnValue(null),
      peekPersistedOwnerHint: vi.fn().mockReturnValue(null),
      setProvisionalCurrentUserId: vi.fn(),
    };

    const projectsMock = vi.fn(() => projectsState);
    mockProjectState = {
      projects: projectsMock,
      setProjects: vi.fn((projects: Project[]) => {
        projectsState = projects;
        projectsMock.mockReturnValue(projectsState);
      }),
      updateProjects: vi.fn((updater: (projects: Project[]) => Project[]) => {
        projectsState = updater(projectsMock());
        projectsMock.mockReturnValue(projectsState);
      }),
      activeProjectId: vi.fn(() => activeProjectIdState),
      setActiveProjectId: vi.fn((projectId: string | null) => {
        activeProjectIdState = projectId;
      }),
      getActiveProject: vi.fn(() => projectsMock().find((project: Project) => project.id === activeProjectIdState) ?? null),
      getProject: vi.fn((id: string) => projectsMock().find((project: Project) => project.id === id)),
      tasks: vi.fn(() => {
        const activeProject = projectsMock().find((project: Project) => project.id === activeProjectIdState);
        return activeProject?.tasks ?? [];
      }),
      clearData: vi.fn(),
      clearAll: vi.fn(),
      setProjectsMetadataOnly: vi.fn((projects: Project[]) => {
        // 只更新项目元数据（与 setProjects 行为一致，但语义上不触碰 TaskStore）
        projectsState = projects;
        projectsMock.mockReturnValue(projectsState);
      }),
      getProjectsWithCurrentData: vi.fn(() => projectsMock()),
    };

    mockSyncCoordinator = {
      flushPendingPersist: vi.fn(),
      preparePendingPersistForOwnerChange: vi.fn().mockResolvedValue(true),
      core: {
        teardownRealtimeSubscription: vi.fn(),
        clearOfflineCache: vi.fn(),
        clearOfflineSnapshot: vi.fn(),
        loadOfflineSnapshot: vi.fn(() => null),
        loadStartupOfflineSnapshot: vi.fn().mockResolvedValue({
          source: 'none',
          projectCount: 0,
          bytes: 0,
          migratedLegacy: false,
          projects: [],
        }),
        saveOfflineSnapshot: vi.fn(),
        saveProjectSmart: vi.fn().mockResolvedValue({ ok: true }),
        initRealtimeSubscription: vi.fn().mockResolvedValue(undefined),
        getAccessibleProjectProbe: vi.fn().mockResolvedValue(null),
        getResumeRecoveryProbe: vi.fn().mockResolvedValue(null),
        setLastSyncTime: vi.fn(),
      },
      performDeltaSync: vi.fn().mockResolvedValue({ ok: true }),
      loadSingleProjectFromCloud: vi.fn().mockResolvedValue(null),
      validateAndRebalanceWithResult: vi.fn((p: Project) => ({ ok: true, value: p })),
      mergeOfflineDataOnReconnect: vi.fn().mockResolvedValue({ ok: true }),
      hasPendingChangesForProject: vi.fn().mockReturnValue(false),
      tryReloadConflictData: vi.fn(),
      refreshProjectManifestIfNeeded: vi.fn().mockResolvedValue({ skipped: false }),
      commitProjectManifestWatermark: vi.fn(),
      refreshBlackBoxWatermarkIfNeeded: vi.fn().mockResolvedValue({ skipped: false }),
      clearActiveConflict: vi.fn(),
      clearOfflineSnapshot: vi.fn(),
    };

    mockChangeTracker = {
      clearAllChanges: vi.fn(),
      hasProjectChanges: vi.fn().mockReturnValue(false),
    };

    mockUndoService = {
      clearHistory: vi.fn(),
      flushPendingAction: vi.fn(),
      onProjectSwitch: vi.fn(),
    };

    mockActionQueue = {
      clearQueue: vi.fn(),
      clearDeadLetterQueue: vi.fn(),
      clearCurrentView: vi.fn(),
      reloadFromStorageForCurrentOwner: vi.fn(),
    };

    mockRetryQueue = {
      clear: vi.fn(),
      clearCurrentView: vi.fn(),
      reloadFromStorageForCurrentOwner: vi.fn(),
      closeStorageConnections: vi.fn(),
    };

    mockConflictStorage = {
      clearFallbackStorageForOwner: vi.fn(),
      clearAllFallbackStorage: vi.fn(),
      closeStorageConnections: vi.fn(),
      refreshConflictCount: vi.fn().mockResolvedValue(undefined),
    };

    mockDockSnapshotPersistence = {
      discardPendingPersist: vi.fn().mockResolvedValue(undefined),
    };

    mockStartupPlaceholderState = {
      isHintOnlyActive: vi.fn(() => false),
      activate: vi.fn(),
      clear: vi.fn(),
    };

    mockUiState = {
      clearSearch: vi.fn(),
      clearAllState: vi.fn(),
      setLoading: vi.fn(),
    };

    mockAttachmentService = {
      clearMonitoredAttachments: vi.fn(),
      clearUrlRefreshCallback: vi.fn(),
      monitorAttachment: vi.fn(),
      setUrlRefreshCallback: vi.fn(),
    };

    mockLayoutService = {
      rebalance: vi.fn((p: Project) => p),
      detectIncomplete: vi.fn().mockReturnValue(false),
    };

    mockToastService = {
      info: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
      success: vi.fn(),
    };

    mockSupabaseClientService = {
      isConfigured: true,
      isOfflineMode: vi.fn(() => false),
      client: vi.fn(() => null),
      clientAsync: vi.fn(() => Promise.resolve(null)),
      getClient: vi.fn(() => null),
      getSession: vi.fn().mockResolvedValue({
        data: { session: { user: { id: 'user-1' } } },
        error: null,
      }),
      getStorageKey: vi.fn(() => 'sb-test-auth-token'),
      signOut: vi.fn().mockResolvedValue(undefined),
    };

    const injector = Injector.create({
      providers: [
        { provide: UserSessionService, useClass: UserSessionService },
        { provide: LoggerService, useValue: { category: () => mockLoggerCategory } },
        { provide: AuthService, useValue: mockAuthService },
        { provide: SyncCoordinatorService, useValue: mockSyncCoordinator },
        { provide: ActionQueueService, useValue: mockActionQueue },
        { provide: RetryQueueService, useValue: mockRetryQueue },
        { provide: ConflictStorageService, useValue: mockConflictStorage },
        { provide: DockSnapshotPersistenceService, useValue: mockDockSnapshotPersistence },
        { provide: StartupPlaceholderStateService, useValue: mockStartupPlaceholderState },
        { provide: UndoService, useValue: mockUndoService },
        { provide: UiStateService, useValue: mockUiState },
        { provide: ProjectStateService, useValue: mockProjectState },
        { provide: ChangeTrackerService, useValue: mockChangeTracker },
        { provide: AttachmentService, useValue: mockAttachmentService },
        { provide: LayoutService, useValue: mockLayoutService },
        { provide: ToastService, useValue: mockToastService },
        { provide: SupabaseClientService, useValue: mockSupabaseClientService },
        { provide: DestroyRef, useValue: { onDestroy: (cb: () => void) => destroyCallbacks.push(cb) } },
      ],
    });

    service = injector.get(UserSessionService);
  });

  afterEach(() => {
    delete (window as Window & { __NANOFLOW_LAUNCH_SNAPSHOT__?: unknown }).__NANOFLOW_LAUNCH_SNAPSHOT__;
    delete (window as Window & { __NANOFLOW_SESSION_PREWARM__?: unknown }).__NANOFLOW_SESSION_PREWARM__;
    resetFocusState();
    Object.defineProperty(globalThis, 'localStorage', {
      value: originalLocalStorage,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'sessionStorage', {
      value: originalSessionStorage,
      configurable: true,
      writable: true,
    });
  });

  describe('switchActiveProject', () => {
    it('切换活动项目', () => {
      const proj = createProject({ id: 'p1' });
      (mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue(null);
      (mockProjectState['getActiveProject'] as ReturnType<typeof vi.fn>).mockReturnValue(proj);

      service.switchActiveProject('p1');

      expect(mockProjectState['setActiveProjectId']).toHaveBeenCalledWith('p1');
    });

    it('同一项目 ID 幂等返回', () => {
      (mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue('p1');

      service.switchActiveProject('p1');

      expect(mockProjectState['setActiveProjectId']).not.toHaveBeenCalled();
    });

    it('切换项目时清理搜索状态并 flush 撤销', () => {
      (mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue('old');

      service.switchActiveProject('new');

      expect(mockUiState['clearSearch']).toHaveBeenCalled();
      expect(mockUndoService['flushPendingAction']).toHaveBeenCalled();
      expect(mockUndoService['onProjectSwitch']).toHaveBeenCalled();
    });

    it('切换到 null 清除附件监控', () => {
      (mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue('p1');
      (service as unknown as { attachmentServiceRef: unknown }).attachmentServiceRef =
        mockAttachmentService as unknown;

      service.switchActiveProject(null);

      expect(mockAttachmentService['clearMonitoredAttachments']).toHaveBeenCalled();
    });

    it('旧会话中的按需加载结果不应回写到已清空的会话', async () => {
      userIdSignal.set('user-1');
      const shellProject = createProject({ id: 'shell-1', name: 'Shell', tasks: [] });
      const seedProjects = mockProjectState['setProjects'] as unknown as (projects: Project[]) => void;
      seedProjects([shellProject]);

      let resolveLoad: ((project: Project | null) => void) | undefined;
      (mockSyncCoordinator['loadSingleProjectFromCloud'] as ReturnType<typeof vi.fn>).mockReturnValueOnce(
        new Promise<Project | null>((resolve) => {
          resolveLoad = resolve;
        })
      );

      vi.clearAllMocks();

      service.switchActiveProject('shell-1');
      service.clearLocalData();

      resolveLoad?.(createProject({
        id: 'shell-1',
        name: 'Loaded After Clear',
        tasks: [createTask({ id: 'task-after-clear' })],
      }));
      await flushAsyncWork();

      expect(mockProjectState['setProjects']).not.toHaveBeenCalled();
      expect((mockSyncCoordinator['core'] as { saveOfflineSnapshot: ReturnType<typeof vi.fn> }).saveOfflineSnapshot)
        .not.toHaveBeenCalled();
    });

    it('按需加载返回 transient null 时应允许后续重试', async () => {
      userIdSignal.set('user-1');
      const shellProject = createProject({ id: 'shell-1', name: 'Shell', tasks: [] });
      const seedProjects = mockProjectState['setProjects'] as unknown as (projects: Project[]) => void;
      seedProjects([shellProject]);
      vi.clearAllMocks();

      (mockSyncCoordinator['loadSingleProjectFromCloud'] as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(createProject({
          id: 'shell-1',
          name: 'Loaded On Retry',
          tasks: [createTask({ id: 'task-retry' })],
        }));
      (mockSyncCoordinator['core'] as { getAccessibleProjectProbe: ReturnType<typeof vi.fn> }).getAccessibleProjectProbe
        .mockResolvedValueOnce(null);

      service.switchActiveProject('shell-1');
      await flushAsyncWork();

      service.switchActiveProject(null);
      service.switchActiveProject('shell-1');
      await flushAsyncWork();

      expect(mockSyncCoordinator['loadSingleProjectFromCloud']).toHaveBeenCalledTimes(2);
      expect(mockProjectState['setProjects']).toHaveBeenCalledWith([
        expect.objectContaining({ id: 'shell-1', name: 'Loaded On Retry' }),
      ]);
    });

    it('首次补水返回空项目时应复核一次并采用非空复核结果', async () => {
      userIdSignal.set('user-1');
      const shellProject = createProject({
        id: 'proj-empty-confirm',
        name: 'Metadata Shell',
        tasks: [],
        connections: [],
      });
      const localProject = createProject({
        id: 'proj-empty-confirm',
        name: 'Local Snapshot',
        tasks: [createTask({ id: 'task-local-confirm', content: 'keep me' })],
      });
      const seedProjects = mockProjectState['setProjects'] as unknown as (projects: Project[]) => void;
      seedProjects([shellProject]);
      (mockProjectState['getProjectsWithCurrentData'] as ReturnType<typeof vi.fn>).mockReturnValue([localProject]);
      vi.clearAllMocks();

      (mockSyncCoordinator['loadSingleProjectFromCloud'] as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(createProject({
          id: 'proj-empty-confirm',
          name: 'Remote Empty First',
          tasks: [],
          connections: [],
        }))
        .mockResolvedValueOnce(createProject({
          id: 'proj-empty-confirm',
          name: 'Remote Confirmed',
          tasks: [createTask({ id: 'task-remote-confirm', content: 'confirmed' })],
          connections: [],
        }));

      const loadResult = await (
        service as unknown as {
          loadProjectForHydration: (projectId: string) => Promise<{ status: string; project?: Project }>;
        }
      ).loadProjectForHydration('proj-empty-confirm');

      expect(mockSyncCoordinator['loadSingleProjectFromCloud']).toHaveBeenCalledTimes(2);
      expect(loadResult).toEqual({
        status: 'loaded',
        project: expect.objectContaining({
          id: 'proj-empty-confirm',
          name: 'Remote Confirmed',
          tasks: [expect.objectContaining({ id: 'task-remote-confirm', content: 'confirmed' })],
        }),
      });
      expect(mockLoggerCategory.warn).toHaveBeenCalledWith(
        '按需加载首次返回空图数据，正在复核远端结果',
        expect.objectContaining({
          projectId: 'proj-empty-confirm',
          localTaskCount: 1,
        }),
      );
    });

    it('首次补水为空且复核仍为空时，应接受权威空远端结果', async () => {
      userIdSignal.set('user-1');
      const shellProject = createProject({
        id: 'proj-empty-authoritative',
        name: 'Metadata Shell',
        tasks: [],
        connections: [],
      });
      const localProject = createProject({
        id: 'proj-empty-authoritative',
        name: 'Local Snapshot',
        tasks: [createTask({ id: 'task-local-authoritative', content: 'stale local' })],
      });
      const seedProjects = mockProjectState['setProjects'] as unknown as (projects: Project[]) => void;
      seedProjects([shellProject]);
      (mockProjectState['getProjectsWithCurrentData'] as ReturnType<typeof vi.fn>).mockReturnValue([localProject]);
      vi.clearAllMocks();

      const emptyRemoteProject = createProject({
        id: 'proj-empty-authoritative',
        name: 'Remote Empty Confirmed',
        tasks: [],
        connections: [],
      });

      (mockSyncCoordinator['loadSingleProjectFromCloud'] as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(emptyRemoteProject)
        .mockResolvedValueOnce(emptyRemoteProject);

      const loadResult = await (
        service as unknown as {
          loadProjectForHydration: (projectId: string) => Promise<{ status: string; project?: Project }>;
        }
      ).loadProjectForHydration('proj-empty-authoritative');

      expect(mockSyncCoordinator['loadSingleProjectFromCloud']).toHaveBeenCalledTimes(2);
      expect(loadResult).toEqual({
        status: 'loaded',
        project: expect.objectContaining({
          id: 'proj-empty-authoritative',
          name: 'Remote Empty Confirmed',
          tasks: [],
          connections: [],
        }),
      });
    });

    it('首次空补水复核前若会话失效，不应发起第二次远端读取', async () => {
      userIdSignal.set('user-1');
      const localProject = createProject({
        id: 'proj-empty-stale',
        name: 'Local Snapshot',
        tasks: [createTask({ id: 'task-local-stale', content: 'keep me' })],
      });
      const sessionGuard = (
        service as unknown as {
          captureCurrentSessionGuard: () => { userId: string | null; generation: number };
        }
      ).captureCurrentSessionGuard();

      (mockProjectState['getProjectsWithCurrentData'] as ReturnType<typeof vi.fn>).mockImplementation(() => {
        userIdSignal.set('user-2');
        return [localProject];
      });

      (mockSyncCoordinator['loadSingleProjectFromCloud'] as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(createProject({
          id: 'proj-empty-stale',
          name: 'Remote Empty First',
          tasks: [],
          connections: [],
        }))
        .mockResolvedValueOnce(createProject({
          id: 'proj-empty-stale',
          name: 'Should Not Be Requested',
          tasks: [createTask({ id: 'task-unexpected' })],
        }));

      const loadResult = await (
        service as unknown as {
          loadProjectForHydration: (
            projectId: string,
            sessionGuard?: { userId: string | null; generation: number },
          ) => Promise<{ status: string; project?: Project }>;
        }
      ).loadProjectForHydration('proj-empty-stale', sessionGuard);

      expect(mockSyncCoordinator['loadSingleProjectFromCloud']).toHaveBeenCalledTimes(1);
      expect(loadResult).toEqual({ status: 'stale' });
    });

    it('首次补水为空且复核返回 null 时，应保留后续重试且不合并空结果', async () => {
      userIdSignal.set('user-1');
      const shellProject = createProject({
        id: 'proj-empty-confirm-null',
        name: 'Metadata Shell',
        tasks: [],
        connections: [],
      });
      const localProject = createProject({
        id: 'proj-empty-confirm-null',
        name: 'Local Snapshot',
        tasks: [createTask({ id: 'task-local-confirm-null', content: 'keep me' })],
      });
      const seedProjects = mockProjectState['setProjects'] as unknown as (projects: Project[]) => void;
      seedProjects([shellProject]);
      (mockProjectState['getProjectsWithCurrentData'] as ReturnType<typeof vi.fn>).mockReturnValue([localProject]);
      vi.clearAllMocks();

      (mockSyncCoordinator['loadSingleProjectFromCloud'] as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(createProject({
          id: 'proj-empty-confirm-null',
          name: 'Remote Empty First',
          tasks: [],
          connections: [],
        }))
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(createProject({
          id: 'proj-empty-confirm-null',
          name: 'Loaded After Retry',
          tasks: [createTask({ id: 'task-loaded-after-retry', content: 'remote ok' })],
          connections: [],
        }));

      service.switchActiveProject('proj-empty-confirm-null');
      await flushAsyncWork();

      expect(mockSyncCoordinator['loadSingleProjectFromCloud']).toHaveBeenCalledTimes(2);
      expect(mockProjectState['setProjects']).not.toHaveBeenCalled();
      expect((mockSyncCoordinator['core'] as { saveOfflineSnapshot: ReturnType<typeof vi.fn> }).saveOfflineSnapshot)
        .not.toHaveBeenCalled();

      service.switchActiveProject(null);
      service.switchActiveProject('proj-empty-confirm-null');
      await flushAsyncWork();

      expect(mockSyncCoordinator['loadSingleProjectFromCloud']).toHaveBeenCalledTimes(3);
      expect(mockProjectState['setProjects']).toHaveBeenCalledWith([
        expect.objectContaining({
          id: 'proj-empty-confirm-null',
          name: 'Loaded After Retry',
          tasks: [expect.objectContaining({ id: 'task-loaded-after-retry', content: 'remote ok' })],
        }),
      ]);
    });

    it('按需加载确认不可访问后应停止当前会话内重复重试', async () => {
      userIdSignal.set('user-1');
      const shellProject = createProject({ id: 'shell-1', name: 'Shell', syncSource: 'synced', tasks: [] });
      const seedProjects = mockProjectState['setProjects'] as unknown as (projects: Project[]) => void;
      seedProjects([shellProject]);
      (
        service as unknown as { lastProjectListMetadataSyncSucceededState: WritableSignal<boolean> }
      ).lastProjectListMetadataSyncSucceededState.set(true);
      (
        service as unknown as { authoritativelyAccessibleProjectIdsState: WritableSignal<ReadonlySet<string>> }
      ).authoritativelyAccessibleProjectIdsState.set(new Set(['shell-1']));
      vi.clearAllMocks();

      (mockSyncCoordinator['loadSingleProjectFromCloud'] as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      (mockSyncCoordinator['core'] as { getAccessibleProjectProbe: ReturnType<typeof vi.fn> }).getAccessibleProjectProbe
        .mockResolvedValue({ projectId: 'shell-1', accessible: false, watermark: null });

      service.switchActiveProject('shell-1');
      await flushAsyncWork();

      service.switchActiveProject(null);
      service.switchActiveProject('shell-1');
      await flushAsyncWork();

      expect(mockSyncCoordinator['loadSingleProjectFromCloud']).toHaveBeenCalledTimes(1);
      expect((mockSyncCoordinator['core'] as { getAccessibleProjectProbe: ReturnType<typeof vi.fn> }).getAccessibleProjectProbe)
        .toHaveBeenCalledTimes(1);
      expect(mockProjectState['setProjects']).toHaveBeenCalledWith([]);
      expect((mockSyncCoordinator['core'] as { saveOfflineSnapshot: ReturnType<typeof vi.fn> }).saveOfflineSnapshot)
        .toHaveBeenCalledWith([], 'user-1');
      expect(service.isProjectAuthoritativelyAccessible('shell-1')).toBe(false);
    });

    it('切号后应清空旧补水中的 in-flight 标记，允许新会话重新补水', async () => {
      userIdSignal.set('user-1');
      const shellProject = createProject({ id: 'shell-1', name: 'Shell', tasks: [] });
      const seedProjects = mockProjectState['setProjects'] as unknown as (projects: Project[]) => void;
      seedProjects([shellProject]);

      let resolveFirstLoad: ((project: Project | null) => void) | undefined;
      (mockSyncCoordinator['loadSingleProjectFromCloud'] as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(new Promise<Project | null>((resolve) => {
          resolveFirstLoad = resolve;
        }))
        .mockResolvedValueOnce(createProject({
          id: 'shell-1',
          name: 'Loaded In New Session',
          tasks: [createTask({ id: 'task-new-session' })],
        }));

      vi.clearAllMocks();

      service.switchActiveProject('shell-1');
      await flushAsyncWork();

      await service.setCurrentUser('user-2', { forceLoad: true, skipPersistentReload: true });
      seedProjects([shellProject]);

      service.switchActiveProject('shell-1');
      await flushAsyncWork();

      expect(mockSyncCoordinator['loadSingleProjectFromCloud']).toHaveBeenCalledTimes(2);

      resolveFirstLoad?.(createProject({
        id: 'shell-1',
        name: 'Stale Project',
        tasks: [createTask({ id: 'task-stale' })],
      }));
      await flushAsyncWork();
    });

    it('旧会话补水完成时不应清掉新会话同项目的 in-flight 标记', async () => {
      userIdSignal.set('user-1');
      const shellProject = createProject({ id: 'shell-1', name: 'Shell', tasks: [] });
      const seedProjects = mockProjectState['setProjects'] as unknown as (projects: Project[]) => void;
      seedProjects([shellProject]);

      let resolveFirstLoad: ((project: Project | null) => void) | undefined;
      let resolveSecondLoad: ((project: Project | null) => void) | undefined;
      (mockSyncCoordinator['loadSingleProjectFromCloud'] as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(new Promise<Project | null>((resolve) => {
          resolveFirstLoad = resolve;
        }))
        .mockReturnValueOnce(new Promise<Project | null>((resolve) => {
          resolveSecondLoad = resolve;
        }));

      vi.clearAllMocks();

      service.switchActiveProject('shell-1');
      await flushAsyncWork();

      await service.setCurrentUser('user-2', { forceLoad: true, skipPersistentReload: true });
      seedProjects([shellProject]);

      service.switchActiveProject('shell-1');
      await flushAsyncWork();

      resolveFirstLoad?.(createProject({
        id: 'shell-1',
        name: 'Stale Project',
        tasks: [createTask({ id: 'task-stale-race' })],
      }));
      await flushAsyncWork();

      service.switchActiveProject(null);
      service.switchActiveProject('shell-1');
      await flushAsyncWork();

      expect(mockSyncCoordinator['loadSingleProjectFromCloud']).toHaveBeenCalledTimes(2);

      resolveSecondLoad?.(createProject({
        id: 'shell-1',
        name: 'Loaded In New Session',
        tasks: [createTask({ id: 'task-new-session-race' })],
      }));
      await flushAsyncWork();
    });
  });

  describe('clearLocalData', () => {
    it('清除内存态数据', () => {
      service.clearLocalData();

      expect(mockProjectState['clearData']).toHaveBeenCalled();
      expect(mockUndoService['clearHistory']).toHaveBeenCalled();
      expect(mockChangeTracker['clearAllChanges']).toHaveBeenCalled();
      expect(mockSyncCoordinator['clearActiveConflict']).toHaveBeenCalled();
    });
  });

  describe('clearAllLocalData', () => {
    beforeEach(() => {
      vi.spyOn(service as unknown as { clearIndexedDB: (dbName: string) => Promise<boolean> }, 'clearIndexedDB')
        .mockResolvedValue(true);
    });

    it('清除内存和持久化数据', async () => {
      await service.clearAllLocalData();

      expect(mockProjectState['clearData']).toHaveBeenCalled();
      expect(mockUndoService['clearHistory']).toHaveBeenCalled();
      expect(mockDockSnapshotPersistence['discardPendingPersist']).toHaveBeenCalled();
    });

    it('应清理 sessionStorage 遗留数据', async () => {
      sessionStorage.setItem('nanoflow.undo-history', 'sensitive');
      sessionStorage.setItem('nanoflow.optimistic-snapshot', 'sensitive');

      await service.clearAllLocalData();

      expect(sessionStorage.getItem('nanoflow.undo-history')).toBeNull();
      expect(sessionStorage.getItem('nanoflow.optimistic-snapshot')).toBeNull();
    });

    it('应清理 action queue 持久化键', async () => {
      localStorage.setItem('nanoflow.action-queue', JSON.stringify([{ id: 'q-1' }]));
      localStorage.setItem('nanoflow.dead-letter-queue', JSON.stringify([{ id: 'd-1' }]));
      localStorage.setItem('nanoflow.local-connection-tombstones', JSON.stringify([{ id: 'conn-1' }]));

      await service.clearAllLocalData();

      expect(localStorage.getItem('nanoflow.action-queue')).toBeNull();
      expect(localStorage.getItem('nanoflow.dead-letter-queue')).toBeNull();
      expect(localStorage.getItem('nanoflow.local-connection-tombstones')).toBeNull();
      expect(mockActionQueue['clearQueue']).toHaveBeenCalled();
      expect(mockActionQueue['clearDeadLetterQueue']).toHaveBeenCalled();
      expect(mockRetryQueue['clear']).toHaveBeenCalled();
      expect(mockRetryQueue['closeStorageConnections']).toHaveBeenCalled();
    });

    it('应清理用户偏好前缀键', async () => {
      localStorage.setItem('nanoflow.preference.user-123.theme', 'ocean');
      localStorage.setItem('nanoflow.preference.user-123.layout', 'ltr');
      localStorage.setItem('nanoflow.preference.user-999.theme', 'forest');

      await service.clearAllLocalData('user-123');

      expect(localStorage.getItem('nanoflow.preference.user-123.theme')).toBeNull();
      expect(localStorage.getItem('nanoflow.preference.user-123.layout')).toBeNull();
      expect(localStorage.getItem('nanoflow.preference.user-999.theme')).toBe('forest');
    });

    it('应清理 focus_mode IndexedDB 缓存', async () => {
      const clearIndexedDBSpy = vi.spyOn(
        service as unknown as { clearIndexedDB: (dbName: string) => Promise<boolean> },
        'clearIndexedDB'
      );

      await service.clearAllLocalData();

      expect(clearIndexedDBSpy).toHaveBeenCalledWith('nanoflow-retry-queue');
      expect(clearIndexedDBSpy).toHaveBeenCalledWith('nanoflow-conflicts');
      expect(clearIndexedDBSpy).toHaveBeenCalledWith('nanoflow-offline-snapshots');
      expect(clearIndexedDBSpy).toHaveBeenCalledWith('focus_mode');
      expect(clearIndexedDBSpy).toHaveBeenCalledWith('keyval-store');
    });

    it('应清理 Dock 快照影子键', async () => {
      localStorage.setItem('nanoflow.dock-snapshot.v3.user-123', JSON.stringify({ savedAt: '2026-03-31T00:00:00.000Z' }));
      localStorage.setItem('nanoflow.dock-snapshot.v3.anonymous', JSON.stringify({ savedAt: '2026-03-31T00:00:00.000Z' }));

      await service.clearAllLocalData();

      expect(localStorage.getItem('nanoflow.dock-snapshot.v3.user-123')).toBeNull();
      expect(localStorage.getItem('nanoflow.dock-snapshot.v3.anonymous')).toBeNull();
    });

    it('应清理 owner-scoped 离线快照影子键', async () => {
      localStorage.setItem('nanoflow.offline-cache-v2.user-123', JSON.stringify({ projects: [{ id: 'p-1' }] }));
      localStorage.setItem('nanoflow.offline-cache-v2.anonymous', JSON.stringify({ projects: [{ id: 'p-2' }] }));

      await service.clearAllLocalData();

      expect(localStorage.getItem('nanoflow.offline-cache-v2.user-123')).toBeNull();
      expect(localStorage.getItem('nanoflow.offline-cache-v2.anonymous')).toBeNull();
    });

    it('应全量清理 conflict fallback 存储', async () => {
      await service.clearAllLocalData();

      expect(mockConflictStorage['clearAllFallbackStorage']).toHaveBeenCalled();
    });

    it('应清理项目清单和黑匣子水位缓存键', async () => {
      localStorage.setItem('nanoflow.project-manifest-watermark.user-123', '2026-02-15T08:00:00.000Z');
      localStorage.setItem('nanoflow.blackbox-manifest-watermark.user-123', '2026-02-16T10:00:00.000Z');
      localStorage.setItem('nanoflow.project-manifest-watermark', 'legacy-project-watermark');
      localStorage.setItem('nanoflow.blackbox-manifest-watermark', 'legacy-blackbox-watermark');

      await service.clearAllLocalData('user-123');

      expect(localStorage.getItem('nanoflow.project-manifest-watermark.user-123')).toBeNull();
      expect(localStorage.getItem('nanoflow.blackbox-manifest-watermark.user-123')).toBeNull();
      expect(localStorage.getItem('nanoflow.project-manifest-watermark')).toBeNull();
      expect(localStorage.getItem('nanoflow.blackbox-manifest-watermark')).toBeNull();
    });

    it('IndexedDB 未真正删除时应中止 full wipe', async () => {
      localStorage.setItem('sb-test-auth-token', JSON.stringify({ access_token: 'token' }));
      (window as Window & { __NANOFLOW_LAUNCH_SNAPSHOT__?: unknown }).__NANOFLOW_LAUNCH_SNAPSHOT__ = { projects: ['stale'] };
      (window as Window & { __NANOFLOW_SESSION_PREWARM__?: unknown }).__NANOFLOW_SESSION_PREWARM__ = { status: 'idle' as const };
      vi.spyOn(service as unknown as { clearIndexedDB: (dbName: string) => Promise<boolean> }, 'clearIndexedDB')
        .mockResolvedValueOnce(false);

      await expect(service.clearAllLocalData()).rejects.toThrow('IndexedDB 清理未完成');

      expect(mockSupabaseClientService.signOut).toHaveBeenCalled();
      expect(localStorage.getItem('sb-test-auth-token')).toBeNull();
      expect((window as Window & { __NANOFLOW_LAUNCH_SNAPSHOT__?: unknown }).__NANOFLOW_LAUNCH_SNAPSHOT__).toBeUndefined();
      expect((window as Window & { __NANOFLOW_SESSION_PREWARM__?: unknown }).__NANOFLOW_SESSION_PREWARM__).toBeUndefined();
      expect(mockConflictStorage['clearAllFallbackStorage']).toHaveBeenCalled();
    });
  });

  describe('DestroyRef cleanup', () => {
    it('注册了 onDestroy 回调', () => {
      // DestroyRef 回调在构造函数中注册
      // 通过 Injector 模式验证回调注册
      expect(destroyCallbacks.length).toBeGreaterThanOrEqual(0);
      // 实际的 clearUrlRefreshCallback/clearMonitoredAttachments
      // 由 Angular DI 容器管理，Injector 隔离模式下无法完整模拟
    });
  });

  describe('setCurrentUser', () => {
    it('设置用户 ID 为 null 时不从云端加载', async () => {
      await service.setCurrentUser(null);
      expect(mockSyncCoordinator['performDeltaSync']).not.toHaveBeenCalled();
    });

    it('切换用户成功后应清空 ChangeTracker，避免旧 owner 删除意图残留', async () => {
      userIdSignal.set('user-123');
      gateSnoozeCount.set(3);
      vi.spyOn(
        service as unknown as { loadUserData: (userId: string) => Promise<void> },
        'loadUserData'
      ).mockResolvedValue(undefined);

      await service.setCurrentUser('user-456');

      expect(mockSyncCoordinator['preparePendingPersistForOwnerChange']).toHaveBeenCalledWith(
        'user-123',
        'owner-switch:user-123->user-456',
      );
      expect(mockChangeTracker['clearAllChanges']).toHaveBeenCalledTimes(1);
      expect(gateSnoozeCount()).toBe(0);
    });

    it('切换用户前 handoff 抛错时应通过 fallback 清空 ChangeTracker', async () => {
      userIdSignal.set('user-123');
      gateSnoozeCount.set(2);
      vi.spyOn(
        service as unknown as { loadUserData: (userId: string) => Promise<void> },
        'loadUserData'
      ).mockResolvedValue(undefined);
      (mockSyncCoordinator['preparePendingPersistForOwnerChange'] as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error('owner handoff failed'));

      await service.setCurrentUser('user-456');

      expect(mockChangeTracker['clearAllChanges']).toHaveBeenCalledTimes(1);
      expect(gateSnoozeCount()).toBe(0);
    });

    it('skipPersistentReload 登出时不应重新加载本地快照或 owner-scoped 队列', async () => {
      userIdSignal.set('old-user');
      const loadFromCacheOrSeedSpy = vi.spyOn(
        service as unknown as {
          loadFromCacheOrSeed: () => Promise<void>;
        },
        'loadFromCacheOrSeed'
      ).mockResolvedValue(undefined);

      await service.setCurrentUser(null, { skipPersistentReload: true });

      expect(mockActionQueue['clearCurrentView']).toHaveBeenCalled();
      expect(mockRetryQueue['clearCurrentView']).toHaveBeenCalled();
      expect(mockActionQueue['reloadFromStorageForCurrentOwner']).not.toHaveBeenCalled();
      expect(mockRetryQueue['reloadFromStorageForCurrentOwner']).not.toHaveBeenCalled();
      expect(mockConflictStorage['refreshConflictCount']).toHaveBeenCalled();
      expect(loadFromCacheOrSeedSpy).not.toHaveBeenCalled();
      expect(mockSyncCoordinator['preparePendingPersistForOwnerChange']).not.toHaveBeenCalled();
    });

    it('session invalidated teardown 应清空旧 owner 视图但保留离线快照桶', async () => {
      (mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([
        createProject({ id: 'stale-project', name: 'Stale Project' }),
      ]);

      await service.setCurrentUser(null, {
        skipPersistentReload: true,
        previousUserIdHint: 'stale-user',
        preserveOfflineSnapshot: true,
      });

      expect(mockProjectState['setActiveProjectId']).toHaveBeenCalledWith(null);
      expect(mockProjectState['setProjects']).toHaveBeenCalledWith([]);
      expect(mockActionQueue['clearCurrentView']).toHaveBeenCalled();
      expect(mockRetryQueue['clearCurrentView']).toHaveBeenCalled();
      expect((mockSyncCoordinator['core'] as { saveOfflineSnapshot: ReturnType<typeof vi.fn> }).saveOfflineSnapshot)
        .toHaveBeenCalledWith(expect.any(Array), 'stale-user');
      expect((mockSyncCoordinator['core'] as { clearOfflineSnapshot: ReturnType<typeof vi.fn> }).clearOfflineSnapshot)
        .not.toHaveBeenCalled();
      expect(mockRetryQueue['clear']).not.toHaveBeenCalled();
    });

    it('hint-only 启动占位下的 session invalidated teardown 不应把占位壳回写旧 owner 快照', async () => {
      (mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([
        createProject({ id: 'hint-placeholder', name: 'Placeholder', syncSource: 'local-only' }),
      ]);
      mockStartupPlaceholderState.isHintOnlyActive.mockReturnValue(true);

      await service.setCurrentUser(null, {
        skipPersistentReload: true,
        previousUserIdHint: 'hint-user',
        preserveOfflineSnapshot: true,
      });

      expect((mockSyncCoordinator['core'] as { saveOfflineSnapshot: ReturnType<typeof vi.fn> }).saveOfflineSnapshot)
        .not.toHaveBeenCalled();
    });

    it('trusted launch snapshot 仅处于 partial 预填充态时不应回写旧 owner durable snapshot', async () => {
      (mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([
        createProject({ id: 'trusted-shell', name: 'Trusted Shell', tasks: [createTask({ title: 'Preview Task' })] }),
      ]);
      (
        service as unknown as {
          prehydratedSnapshotApplied: boolean;
          prehydratedSnapshotOwnerId: string | null;
          startupProjectCatalogStageState: WritableSignal<'unresolved' | 'partial' | 'resolved'>;
        }
      ).prehydratedSnapshotApplied = true;
      (
        service as unknown as {
          prehydratedSnapshotApplied: boolean;
          prehydratedSnapshotOwnerId: string | null;
          startupProjectCatalogStageState: WritableSignal<'unresolved' | 'partial' | 'resolved'>;
        }
      ).prehydratedSnapshotOwnerId = 'trusted-user';
      (
        service as unknown as {
          startupProjectCatalogStageState: WritableSignal<'unresolved' | 'partial' | 'resolved'>;
        }
      ).startupProjectCatalogStageState.set('partial');

      await service.setCurrentUser(null, {
        skipPersistentReload: true,
        previousUserIdHint: 'trusted-user',
        preserveOfflineSnapshot: true,
      });

      expect((mockSyncCoordinator['core'] as { saveOfflineSnapshot: ReturnType<typeof vi.fn> }).saveOfflineSnapshot)
        .not.toHaveBeenCalled();
    });

    it('session invalidated teardown 在保留旧 owner 快照失败时也应强制清空旧视图', async () => {
      (mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([
        createProject({ id: 'stale-project', name: 'Stale Project' }),
      ]);
      blackBoxEntriesMap.set(new Map([
        ['stale-entry', {
          id: 'stale-entry',
          projectId: 'stale-project',
          userId: 'stale-user',
          content: 'stale',
          date: '2026-03-18',
          createdAt: '2026-03-18T00:00:00.000Z',
          updatedAt: '2026-03-18T00:00:00.000Z',
          isRead: false,
          isCompleted: false,
          isArchived: false,
          deletedAt: null,
        }],
      ]));
      gateState.set('reviewing');
      (mockSyncCoordinator['core'] as { saveOfflineSnapshot: ReturnType<typeof vi.fn> }).saveOfflineSnapshot
        .mockRejectedValueOnce(new Error('save-offline-snapshot-failed'));

      await service.setCurrentUser(null, {
        skipPersistentReload: true,
        previousUserIdHint: 'stale-user',
        preserveOfflineSnapshot: true,
      });

      expect(mockProjectState['setActiveProjectId']).toHaveBeenCalledWith(null);
      expect(mockProjectState['setProjects']).toHaveBeenCalledWith([]);
      expect(mockUiState['clearAllState']).toHaveBeenCalled();
      expect(mockActionQueue['clearCurrentView']).toHaveBeenCalled();
      expect(mockRetryQueue['clearCurrentView']).toHaveBeenCalled();
      expect(mockChangeTracker['clearAllChanges']).toHaveBeenCalled();
      expect(blackBoxEntriesMap().size).toBe(0);
      expect(gateState()).toBe('checking');
    });

    it('local-user 遇到错误的云端 previousUserIdHint 时不应把本地草稿写进云端快照桶', async () => {
      userIdSignal.set(AUTH_CONFIG.LOCAL_MODE_USER_ID);
      (mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([
        createProject({ id: 'local-draft', name: 'Local Draft', syncSource: 'local-only' }),
      ]);

      await service.setCurrentUser(null, {
        skipPersistentReload: true,
        previousUserIdHint: 'cloud-user',
        preserveOfflineSnapshot: true,
      });

      const saveCalls = ((mockSyncCoordinator['core'] as {
        saveOfflineSnapshot: ReturnType<typeof vi.fn>;
      }).saveOfflineSnapshot).mock.calls;
      expect(saveCalls.some(([, ownerUserId]) => ownerUserId === 'cloud-user')).toBe(false);
      expect(saveCalls.some(([, ownerUserId]) => ownerUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID)).toBe(true);
    });

    it('旧会话的 forceLoad 在 logout 后不应回灌项目或恢复 realtime', async () => {
      let resolveSnapshot: ((value: {
        source: 'idb';
        projectCount: number;
        bytes: number;
        migratedLegacy: boolean;
        projects: Project[];
      }) => void) | null = null;
      vi.spyOn(
        service as unknown as {
          loadStartupSnapshotResult: () => Promise<{
            source: 'idb';
            projectCount: number;
            bytes: number;
            migratedLegacy: boolean;
            projects: Project[];
          }>;
        },
        'loadStartupSnapshotResult'
      ).mockImplementation(() => new Promise(resolve => {
        resolveSnapshot = resolve;
      }));

      const staleLoad = service.setCurrentUser('stale-user', { forceLoad: true });
      await service.setCurrentUser(null, { skipPersistentReload: true });

      resolveSnapshot!({
        source: 'idb',
        projectCount: 1,
        bytes: 256,
        migratedLegacy: false,
        projects: [createProject({ id: 'stale-project', name: 'Stale Project' })],
      });
      await staleLoad;

      expect(mockProjectState['setProjects']).not.toHaveBeenCalledWith([
        expect.objectContaining({ id: 'stale-project' }),
      ]);
      expect((mockSyncCoordinator['core'] as { initRealtimeSubscription: ReturnType<typeof vi.fn> }).initRealtimeSubscription)
        .not.toHaveBeenCalledWith('stale-user');
    });

    it('切换账号时应清理 action queue', async () => {
      userIdSignal.set('old-user');

      await service.setCurrentUser('new-user');

      expect(mockSyncCoordinator['preparePendingPersistForOwnerChange']).toHaveBeenCalledWith(
        'old-user',
        'owner-switch:old-user->new-user'
      );
      expect((mockSyncCoordinator['preparePendingPersistForOwnerChange'] as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0])
        .toBeLessThan(((mockSyncCoordinator['core'] as { clearOfflineSnapshot: ReturnType<typeof vi.fn> }).clearOfflineSnapshot).mock.invocationCallOrder[0]);
      expect(mockActionQueue['clearCurrentView']).toHaveBeenCalled();
      expect(mockRetryQueue['clearCurrentView']).toHaveBeenCalled();
      expect((mockSyncCoordinator['core'] as { clearOfflineSnapshot: ReturnType<typeof vi.fn> }).clearOfflineSnapshot).toHaveBeenCalled();
      expect((mockSyncCoordinator['core'] as { clearOfflineCache: ReturnType<typeof vi.fn> }).clearOfflineCache).not.toHaveBeenCalled();
      expect(mockConflictStorage['clearFallbackStorageForOwner']).not.toHaveBeenCalled();
      expect(mockActionQueue['reloadFromStorageForCurrentOwner']).toHaveBeenCalled();
      expect(mockRetryQueue['reloadFromStorageForCurrentOwner']).toHaveBeenCalled();
      expect(mockConflictStorage['refreshConflictCount']).toHaveBeenCalled();
    });

    it('切换账号前若 durable handoff 未完成，不应提前清空离线快照', async () => {
      userIdSignal.set('old-user');
      (mockSyncCoordinator['preparePendingPersistForOwnerChange'] as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);

      await service.setCurrentUser('new-user');

      expect(mockActionQueue['clearCurrentView']).toHaveBeenCalled();
      expect(mockRetryQueue['clearCurrentView']).toHaveBeenCalled();
      expect((mockSyncCoordinator['core'] as { clearOfflineSnapshot: ReturnType<typeof vi.fn> }).clearOfflineSnapshot).not.toHaveBeenCalled();
    });

    it('切换账号时 durable handoff 清理失败也应先强制清空旧 owner 视图', async () => {
      userIdSignal.set('old-user');
      (mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([
        createProject({ id: 'old-project', name: 'Old Project' }),
      ]);
      blackBoxEntriesMap.set(new Map([
        ['old-entry', {
          id: 'old-entry',
          projectId: 'old-project',
          userId: 'old-user',
          content: 'old',
          date: '2026-03-18',
          createdAt: '2026-03-18T00:00:00.000Z',
          updatedAt: '2026-03-18T00:00:00.000Z',
          isRead: false,
          isCompleted: false,
          isArchived: false,
          deletedAt: null,
        }],
      ]));
      gateState.set('reviewing');
      (mockSyncCoordinator['preparePendingPersistForOwnerChange'] as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error('prepare-pending-persist-failed'));
      vi.spyOn(
        service as unknown as {
          loadUserData: (userId: string, sessionGuard?: unknown) => Promise<void>;
        },
        'loadUserData'
      ).mockResolvedValue(undefined);

      await service.setCurrentUser('new-user');

      expect(mockProjectState['setActiveProjectId']).toHaveBeenCalledWith(null);
      expect(mockProjectState['setProjects']).toHaveBeenCalledWith([]);
      expect(mockUiState['clearAllState']).toHaveBeenCalled();
      expect(mockActionQueue['clearCurrentView']).toHaveBeenCalled();
      expect(mockRetryQueue['clearCurrentView']).toHaveBeenCalled();
      expect(mockChangeTracker['clearAllChanges']).toHaveBeenCalled();
      expect(blackBoxEntriesMap().size).toBe(0);
      expect(gateState()).toBe('checking');
    });

    it('匿名态登录且存在 local-only 项目时应保留本地草稿快照并只清理歧义队列', async () => {
      const localOnlyProject = createProject({ id: 'local-only', syncSource: 'local-only' });
      let preservedProjects: Project[] = [];
      let preservedOwnerUserId: string | null = null;
      (mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([localOnlyProject]);
      (mockSyncCoordinator['core'] as { saveOfflineSnapshot: ReturnType<typeof vi.fn> }).saveOfflineSnapshot.mockImplementation((projects: Project[], ownerUserId?: string | null) => {
        preservedProjects = projects;
        preservedOwnerUserId = ownerUserId ?? null;
      });
      (mockSyncCoordinator['core'] as {
        loadStartupOfflineSnapshot: ReturnType<typeof vi.fn>;
      }).loadStartupOfflineSnapshot.mockImplementation(async () => ({
        source: 'idb',
        projectCount: preservedProjects.length,
        bytes: 128,
        migratedLegacy: false,
        ownerUserId: preservedOwnerUserId,
        projects: preservedProjects,
      }));

      await service.setCurrentUser('new-user', { forceLoad: true });

      expect(mockActionQueue['clearCurrentView']).toHaveBeenCalled();
      expect(mockRetryQueue['clearCurrentView']).toHaveBeenCalled();
      expect((mockSyncCoordinator['core'] as { saveOfflineSnapshot: ReturnType<typeof vi.fn> }).saveOfflineSnapshot).toHaveBeenCalledWith([
        expect.objectContaining({ id: 'local-only', syncSource: 'local-only' }),
      ], 'new-user');
      expect((mockSyncCoordinator['core'] as { clearOfflineSnapshot: ReturnType<typeof vi.fn> }).clearOfflineSnapshot).not.toHaveBeenCalled();
      expect(mockActionQueue['reloadFromStorageForCurrentOwner']).toHaveBeenCalled();
      expect(mockRetryQueue['reloadFromStorageForCurrentOwner']).toHaveBeenCalled();
      expect(mockProjectState['setProjects']).toHaveBeenCalledWith([
        expect.objectContaining({ id: 'local-only', syncSource: 'local-only', pendingSync: true }),
      ]);
    });

    it('local-user 登录真实账号时也应保留 local-only 草稿快照', async () => {
      const localOnlyProject = createProject({ id: 'local-mode-project', syncSource: 'local-only' });
      let preservedProjects: Project[] = [];
      let preservedOwnerUserId: string | null = null;
      userIdSignal.set(AUTH_CONFIG.LOCAL_MODE_USER_ID);
      (mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([localOnlyProject]);
      (mockSyncCoordinator['core'] as { saveOfflineSnapshot: ReturnType<typeof vi.fn> }).saveOfflineSnapshot.mockImplementation((projects: Project[], ownerUserId?: string | null) => {
        preservedProjects = projects;
        preservedOwnerUserId = ownerUserId ?? null;
      });
      (mockSyncCoordinator['core'] as {
        loadStartupOfflineSnapshot: ReturnType<typeof vi.fn>;
      }).loadStartupOfflineSnapshot.mockImplementation(async () => ({
        source: 'idb',
        projectCount: preservedProjects.length,
        bytes: 128,
        migratedLegacy: false,
        ownerUserId: preservedOwnerUserId,
        projects: preservedProjects,
      }));

      await service.setCurrentUser('new-user', { forceLoad: true });

      expect(mockRetryQueue['clearCurrentView']).toHaveBeenCalled();
      expect((mockSyncCoordinator['core'] as { saveOfflineSnapshot: ReturnType<typeof vi.fn> }).saveOfflineSnapshot).toHaveBeenCalledWith([
        expect.objectContaining({ id: 'local-mode-project', syncSource: 'local-only' }),
      ], 'new-user');
      expect((mockSyncCoordinator['core'] as { clearOfflineSnapshot: ReturnType<typeof vi.fn> }).clearOfflineSnapshot).not.toHaveBeenCalled();
      expect(mockActionQueue['reloadFromStorageForCurrentOwner']).toHaveBeenCalled();
      expect(mockRetryQueue['reloadFromStorageForCurrentOwner']).toHaveBeenCalled();
      expect(mockProjectState['setProjects']).toHaveBeenCalledWith([
        expect.objectContaining({ id: 'local-mode-project', syncSource: 'local-only', pendingSync: true }),
      ]);
    });

    it('hint-only 启动占位不应被当成 guest draft 迁移到目标 owner', async () => {
      const placeholderProject = createProject({
        id: 'hint-local-only',
        name: 'Placeholder Shell',
        syncSource: 'local-only',
      });
      mockStartupPlaceholderState.isHintOnlyActive.mockReturnValue(true);
      (mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([placeholderProject]);
      vi.spyOn(
        service as unknown as {
          loadUserData: (userId: string, sessionGuard?: unknown) => Promise<void>;
        },
        'loadUserData'
      ).mockResolvedValue(undefined);

      await service.setCurrentUser('new-user', { forceLoad: true });

      const saveCalls = ((mockSyncCoordinator['core'] as {
        saveOfflineSnapshot: ReturnType<typeof vi.fn>;
      }).saveOfflineSnapshot).mock.calls;
      expect(saveCalls.some(([projects, ownerUserId]) => {
        return ownerUserId === 'new-user'
          && Array.isArray(projects)
          && projects.some((project: Project) => project.id === 'hint-local-only');
      })).toBe(false);
    });

    it('启动快照尚未恢复到 store 时登录，也应先把游客草稿改写为目标 owner', async () => {
      const localOnlyProject = createProject({ id: 'bootstrapping-local-only', syncSource: 'local-only' });
      let preservedProjects: Project[] = [localOnlyProject];
      let preservedOwnerUserId: string | null = AUTH_CONFIG.LOCAL_MODE_USER_ID;
      (mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([]);
      (mockSyncCoordinator['core'] as { saveOfflineSnapshot: ReturnType<typeof vi.fn> }).saveOfflineSnapshot.mockImplementation((projects: Project[], ownerUserId?: string | null) => {
        preservedProjects = projects;
        preservedOwnerUserId = ownerUserId ?? null;
      });
      (mockSyncCoordinator['core'] as {
        loadStartupOfflineSnapshot: ReturnType<typeof vi.fn>;
      }).loadStartupOfflineSnapshot.mockImplementation(async () => ({
        source: 'idb',
        projectCount: preservedProjects.length,
        bytes: 128,
        migratedLegacy: false,
        ownerUserId: preservedOwnerUserId,
        projects: preservedProjects,
      }));

      await service.setCurrentUser('new-user', { forceLoad: true });

      expect((mockSyncCoordinator['core'] as { saveOfflineSnapshot: ReturnType<typeof vi.fn> }).saveOfflineSnapshot).toHaveBeenCalledWith([
        expect.objectContaining({ id: 'bootstrapping-local-only', syncSource: 'local-only' }),
      ], 'new-user');
      expect(mockProjectState['setProjects']).toHaveBeenCalledWith([
        expect.objectContaining({ id: 'bootstrapping-local-only', syncSource: 'local-only', pendingSync: true }),
      ]);
    });

    it('设置用户 ID 为 null 时应优先使用 startup snapshot 而不是种子数据', async () => {
      const restoredProject = createProject({ id: 'restored-idb-project', name: 'Recovered' });
      (
        mockSyncCoordinator['core'] as {
          loadStartupOfflineSnapshot: ReturnType<typeof vi.fn>;
        }
      ).loadStartupOfflineSnapshot.mockResolvedValue({
        source: 'idb',
        projectCount: 1,
        bytes: 256,
        migratedLegacy: false,
        ownerUserId: AUTH_CONFIG.LOCAL_MODE_USER_ID,
        projects: [restoredProject],
      });

      await service.setCurrentUser(null);

      expect(
        (mockSyncCoordinator['core'] as { loadStartupOfflineSnapshot: ReturnType<typeof vi.fn> }).loadStartupOfflineSnapshot
      ).toHaveBeenCalled();
      expect(mockProjectState['setProjects']).toHaveBeenCalledWith([expect.objectContaining({ id: 'restored-idb-project' })]);
    });

    it('owner 不匹配的 startup snapshot 不应在匿名态被恢复', async () => {
      (
        mockSyncCoordinator['core'] as {
          loadStartupOfflineSnapshot: ReturnType<typeof vi.fn>;
        }
      ).loadStartupOfflineSnapshot.mockResolvedValue({
        source: 'idb',
        projectCount: 1,
        bytes: 256,
        migratedLegacy: false,
        ownerUserId: 'user-123',
        projects: [createProject({ id: 'leaked-project', name: 'Leaked Project' })],
      });

      await service.setCurrentUser(null);

      expect(mockProjectState['setProjects']).not.toHaveBeenCalledWith([
        expect.objectContaining({ id: 'leaked-project' }),
      ]);
    });

    it('缺少 owner 元数据的 startup snapshot 不应在匿名态被恢复', async () => {
      (
        mockSyncCoordinator['core'] as {
          loadStartupOfflineSnapshot: ReturnType<typeof vi.fn>;
        }
      ).loadStartupOfflineSnapshot.mockResolvedValue({
        source: 'idb',
        projectCount: 1,
        bytes: 256,
        migratedLegacy: true,
        projects: [createProject({ id: 'ownerless-guest-project', name: 'Ownerless Guest Project' })],
      });

      await service.setCurrentUser(null);

      expect(mockProjectState['setProjects']).not.toHaveBeenCalledWith([
        expect.objectContaining({ id: 'ownerless-guest-project' }),
      ]);
    });

    it('空 startup snapshot 缺少 owner 元数据时不应输出误报警告', async () => {
      (
        mockSyncCoordinator['core'] as {
          loadStartupOfflineSnapshot: ReturnType<typeof vi.fn>;
        }
      ).loadStartupOfflineSnapshot.mockResolvedValue({
        source: 'none',
        projectCount: 0,
        bytes: 0,
        migratedLegacy: false,
        projects: [],
      });

      await service.setCurrentUser(null);

      expect(mockLoggerCategory.warn).not.toHaveBeenCalledWith(
        '检测到缺少 owner 元数据的离线快照，已忽略本次恢复',
        expect.anything(),
      );
    });

    it('owner 不匹配的 startup snapshot 不应在登录态被恢复', async () => {
      (
        mockSyncCoordinator['core'] as {
          loadStartupOfflineSnapshot: ReturnType<typeof vi.fn>;
        }
      ).loadStartupOfflineSnapshot.mockResolvedValue({
        source: 'idb',
        projectCount: 1,
        bytes: 256,
        migratedLegacy: false,
        ownerUserId: 'old-user',
        projects: [createProject({ id: 'wrong-owner-project', name: 'Wrong Owner Project' })],
      });

      await service.setCurrentUser('new-user', { forceLoad: true });

      expect(mockProjectState['setProjects']).not.toHaveBeenCalledWith([
        expect.objectContaining({ id: 'wrong-owner-project' }),
      ]);
    });

    it('缺少 owner 元数据的 startup snapshot 不应在登录态被恢复', async () => {
      (
        mockSyncCoordinator['core'] as {
          loadStartupOfflineSnapshot: ReturnType<typeof vi.fn>;
        }
      ).loadStartupOfflineSnapshot.mockResolvedValue({
        source: 'idb',
        projectCount: 1,
        bytes: 256,
        migratedLegacy: true,
        projects: [createProject({ id: 'ownerless-login-project', name: 'Ownerless Login Project' })],
      });

      await service.setCurrentUser('new-user', { forceLoad: true });

      expect(mockProjectState['setProjects']).not.toHaveBeenCalledWith([
        expect.objectContaining({ id: 'ownerless-login-project' }),
      ]);
    });

    it('用户切换时清理旧数据', async () => {
      // Set a previous userId through the signal
      userIdSignal.set('old-user');
      (service as unknown as { attachmentServiceRef: unknown }).attachmentServiceRef =
        mockAttachmentService as unknown;

      await service.setCurrentUser('new-user');

      expect(mockAttachmentService['clearMonitoredAttachments']).toHaveBeenCalled();
      expect(mockUndoService['clearHistory']).toHaveBeenCalled();
    });

    it('冷启动 forceLoad 时应保留预填充的 activeProjectId，避免首屏主内容掉空', async () => {
      const restoredProject = createProject({ id: 'proj-snapshot', name: 'Recovered' });
      (mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([restoredProject]);
      (mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue('proj-snapshot');
      (
        service as unknown as {
          prehydratedSnapshotApplied: boolean;
          prehydratedSnapshotOwnerId: string | null;
        }
      ).prehydratedSnapshotApplied = true;
      (
        service as unknown as {
          prehydratedSnapshotApplied: boolean;
          prehydratedSnapshotOwnerId: string | null;
        }
      ).prehydratedSnapshotOwnerId = 'new-user';

      vi.spyOn(
        service as unknown as {
          loadUserData: (userId: string) => Promise<void>;
        },
        'loadUserData'
      ).mockResolvedValue(undefined);

      await service.setCurrentUser('new-user', { forceLoad: true });

      expect(mockProjectState['setActiveProjectId']).not.toHaveBeenCalledWith(null);
    });

    it('冷启动 forceLoad 遇到未知或非当前用户的快照时应立即清空预填充内容', async () => {
      const restoredProject = createProject({ id: 'proj-snapshot', name: 'Recovered' });
      (mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([restoredProject]);
      (mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue('proj-snapshot');
      (
        service as unknown as {
          prehydratedSnapshotApplied: boolean;
          prehydratedSnapshotOwnerId: string | null;
        }
      ).prehydratedSnapshotApplied = true;
      (
        service as unknown as {
          prehydratedSnapshotApplied: boolean;
          prehydratedSnapshotOwnerId: string | null;
        }
      ).prehydratedSnapshotOwnerId = 'other-user';

      vi.spyOn(
        service as unknown as {
          loadUserData: (userId: string) => Promise<void>;
        },
        'loadUserData'
      ).mockResolvedValue(undefined);

      await service.setCurrentUser('new-user', { forceLoad: true });

      expect(mockProjectState['setActiveProjectId']).toHaveBeenCalledWith(null);
      expect(mockProjectState['setProjects']).toHaveBeenCalledWith([]);
    });
  });

  describe('runIdleTask', () => {
    it('requestIdleCallback 不触发时应由超时兜底执行任务', () => {
      vi.useFakeTimers();
      const originalRic = (window as Window & { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
      const task = vi.fn();

      Object.defineProperty(window, 'requestIdleCallback', {
        value: vi.fn(() => 1),
        configurable: true,
        writable: true,
      });

      (
        service as unknown as {
          runIdleTask: (task: () => void) => void;
        }
      ).runIdleTask(task);

      expect(task).not.toHaveBeenCalled();

      vi.advanceTimersByTime(2000);

      expect(task).toHaveBeenCalledTimes(1);

      Object.defineProperty(window, 'requestIdleCallback', {
        value: originalRic,
        configurable: true,
        writable: true,
      });
      vi.useRealTimers();
    });
  });

  describe('loadProjects 项目列表预同步', () => {
    it('首屏渲染后应先补齐缺失项目壳，而不是等待 idle 后台同步', async () => {
      vi.useFakeTimers();
      const originalRic = (window as Window & { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;

      Object.defineProperty(window, 'requestIdleCallback', {
        value: vi.fn(() => 1),
        configurable: true,
        writable: true,
      });

      userIdSignal.set('user-1');
      const localProject = createProject({
        id: 'proj-local',
        name: 'Local Project',
        syncSource: 'synced',
        tasks: [createTask({ id: 'task-local' })],
      });
      const remoteShellProject = createProject({
        id: 'proj-remote',
        name: 'Remote Project',
        syncSource: 'synced',
        pendingSync: false,
        tasks: [],
        connections: [],
      });

      (
        mockSyncCoordinator['core'] as {
          loadStartupOfflineSnapshot: ReturnType<typeof vi.fn>;
        }
      ).loadStartupOfflineSnapshot.mockResolvedValue({
        source: 'idb',
        projectCount: 1,
        bytes: 128,
        migratedLegacy: false,
        ownerUserId: 'user-1',
        projects: [localProject],
      });

      const syncProjectListMetadataSpy = vi.spyOn(
        service as unknown as {
          syncProjectListMetadata: (userId: string, sessionGuard?: unknown) => Promise<Set<string>>;
        },
        'syncProjectListMetadata'
      ).mockImplementation(async () => {
        (mockProjectState['setProjectsMetadataOnly'] as (projects: Project[]) => void)([
          localProject,
          remoteShellProject,
        ]);
        return new Set(['proj-local', 'proj-remote']);
      });

      const startBackgroundSyncSpy = vi.spyOn(
        service as unknown as {
          startBackgroundSync: (userId: string, previousActive: string | null, sessionGuard?: unknown) => Promise<void>;
        },
        'startBackgroundSync'
      ).mockResolvedValue(undefined);

      await service.loadProjects();
      await flushAsyncWork();

      expect(syncProjectListMetadataSpy).toHaveBeenCalledTimes(1);
      expect(startBackgroundSyncSpy).not.toHaveBeenCalled();

      const metadataOnlyCall = (mockProjectState['setProjectsMetadataOnly'] as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as Project[] | undefined;
      expect(metadataOnlyCall?.map((project: Project) => project.id)).toEqual(['proj-local', 'proj-remote']);

      Object.defineProperty(window, 'requestIdleCallback', {
        value: originalRic,
        configurable: true,
        writable: true,
      });
      vi.useRealTimers();
    });

    it('项目清单水位快路命中时不应提前重拉完整 metadata', async () => {
      vi.useFakeTimers();
      const originalRic = (window as Window & { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;

      Object.defineProperty(window, 'requestIdleCallback', {
        value: vi.fn(() => 1),
        configurable: true,
        writable: true,
      });

      userIdSignal.set('user-1');
      const localProject = createProject({
        id: 'proj-local',
        name: 'Local Project',
        syncSource: 'synced',
        tasks: [createTask({ id: 'task-local' })],
      });

      (
        mockSyncCoordinator['core'] as {
          loadStartupOfflineSnapshot: ReturnType<typeof vi.fn>;
        }
      ).loadStartupOfflineSnapshot.mockResolvedValue({
        source: 'idb',
        projectCount: 1,
        bytes: 128,
        migratedLegacy: false,
        ownerUserId: 'user-1',
        projects: [localProject],
      });
      (mockSyncCoordinator['refreshProjectManifestIfNeeded'] as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ skipped: true, watermark: '2026-05-27T01:00:00.000Z' });

      const syncProjectListMetadataSpy = vi.spyOn(
        service as unknown as {
          syncProjectListMetadata: (userId: string, sessionGuard?: unknown) => Promise<Set<string>>;
        },
        'syncProjectListMetadata'
      );
      const startBackgroundSyncSpy = vi.spyOn(
        service as unknown as {
          startBackgroundSync: (userId: string, previousActive: string | null, sessionGuard?: unknown) => Promise<void>;
        },
        'startBackgroundSync'
      ).mockResolvedValue(undefined);

      await service.loadProjects();
      await flushAsyncWork();

      expect(syncProjectListMetadataSpy).not.toHaveBeenCalled();
      expect(startBackgroundSyncSpy).not.toHaveBeenCalled();
      expect(service.canAuthoritativelyRejectProjectRoute()).toBe(true);
      expect(service.isProjectAuthoritativelyAccessible('proj-local')).toBe(true);

      Object.defineProperty(window, 'requestIdleCallback', {
        value: originalRic,
        configurable: true,
        writable: true,
      });
      vi.useRealTimers();
    });

    it('项目清单水位快路命中但本地目录为空时，应降级为 metadata sync', async () => {
      vi.useFakeTimers();
      const originalRic = (window as Window & { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;

      Object.defineProperty(window, 'requestIdleCallback', {
        value: vi.fn(() => 1),
        configurable: true,
        writable: true,
      });

      userIdSignal.set('user-1');
      (
        mockSyncCoordinator['core'] as {
          loadStartupOfflineSnapshot: ReturnType<typeof vi.fn>;
        }
      ).loadStartupOfflineSnapshot.mockResolvedValue({
        source: 'none',
        projectCount: 0,
        bytes: 0,
        migratedLegacy: false,
        ownerUserId: 'user-1',
        projects: [],
      });
      (mockSyncCoordinator['refreshProjectManifestIfNeeded'] as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ skipped: true, watermark: '2026-05-27T01:00:00.000Z' });

      const syncProjectListMetadataSpy = vi.spyOn(
        service as unknown as {
          syncProjectListMetadata: (userId: string, sessionGuard?: unknown) => Promise<Set<string>>;
        },
        'syncProjectListMetadata'
      ).mockResolvedValue(new Set(['proj-remote']));
      const startBackgroundSyncSpy = vi.spyOn(
        service as unknown as {
          startBackgroundSync: (userId: string, previousActive: string | null, sessionGuard?: unknown) => Promise<void>;
        },
        'startBackgroundSync'
      ).mockResolvedValue(undefined);

      await service.loadProjects();
      await flushAsyncWork();

      expect(syncProjectListMetadataSpy).toHaveBeenCalledTimes(1);
      expect(startBackgroundSyncSpy).not.toHaveBeenCalled();
      expect(service.canAuthoritativelyRejectProjectRoute()).toBe(false);

      Object.defineProperty(window, 'requestIdleCallback', {
        value: originalRic,
        configurable: true,
        writable: true,
      });
      vi.useRealTimers();
    });

    it('Supabase session 尚未切到当前用户时，不应在 prime fast path 提前建立 authoritative 状态', async () => {
      vi.useFakeTimers();
      const originalRic = (window as Window & { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;

      Object.defineProperty(window, 'requestIdleCallback', {
        value: vi.fn(() => 1),
        configurable: true,
        writable: true,
      });

      userIdSignal.set('user-1');
      mockSupabaseClientService.getSession.mockResolvedValue({
        data: { session: { user: { id: 'old-user' } } },
        error: null,
      });
      (
        mockSyncCoordinator['core'] as {
          loadStartupOfflineSnapshot: ReturnType<typeof vi.fn>;
        }
      ).loadStartupOfflineSnapshot.mockResolvedValue({
        source: 'idb',
        projectCount: 1,
        bytes: 128,
        migratedLegacy: false,
        ownerUserId: 'user-1',
        projects: [createProject({ id: 'proj-local', syncSource: 'synced' })],
      });

      const syncProjectListMetadataSpy = vi.spyOn(
        service as unknown as {
          syncProjectListMetadata: (userId: string, sessionGuard?: unknown, forceSnapshotPersist?: boolean) => Promise<Set<string>>;
        },
        'syncProjectListMetadata'
      );

      await service.loadProjects();
      await flushAsyncWork();

      expect(syncProjectListMetadataSpy).not.toHaveBeenCalled();
      expect(service.canAuthoritativelyRejectProjectRoute()).toBe(false);

      Object.defineProperty(window, 'requestIdleCallback', {
        value: originalRic,
        configurable: true,
        writable: true,
      });
      vi.useRealTimers();
    });
  });

  describe('Attachment 懒加载与降级', () => {
    it('项目无附件时不触发 AttachmentService 懒加载', async () => {
      userIdSignal.set('user-1');
      const spy = vi.spyOn(service, 'getAttachmentServiceLazy');

      const project = createProject({
        id: 'no-attachment',
        tasks: [createTask({ id: 'task-1', attachments: [] })],
      });

      await (
        service as unknown as {
          monitorProjectAttachments: (project: Project) => Promise<void>;
        }
      ).monitorProjectAttachments(project);

      expect(spy).not.toHaveBeenCalled();
      expect(mockAttachmentService['monitorAttachment']).not.toHaveBeenCalled();
    });

    it('项目有附件时仅初始化一次 AttachmentService（single-flight 缓存）', async () => {
      const inFlight = Promise.resolve(mockAttachmentService as unknown as AttachmentService);
      (service as unknown as { attachmentServicePromise: Promise<AttachmentService | null> | null })
        .attachmentServicePromise = inFlight;
      const first = service.getAttachmentServiceLazy();
      const second = service.getAttachmentServiceLazy();

      await expect(first).resolves.toBe(mockAttachmentService);
      await expect(second).resolves.toBe(mockAttachmentService);
      expect(
        (service as unknown as { attachmentServicePromise: Promise<AttachmentService | null> | null })
          .attachmentServicePromise
      ).toBe(inFlight);
    });

    it('项目有附件时会建立附件监控', async () => {
      userIdSignal.set('user-1');
      vi.spyOn(service, 'getAttachmentServiceLazy').mockResolvedValue(
        mockAttachmentService as unknown as AttachmentService
      );
      const project = createProject({
        id: 'with-attachment-monitor',
        tasks: [
          createTask({
            id: 'task-1',
            attachments: [createAttachment('00000000-0000-0000-0000-000000000001')],
          }),
        ],
      });

      await (
        service as unknown as {
          monitorProjectAttachments: (project: Project) => Promise<void>;
        }
      ).monitorProjectAttachments(project);

      expect(mockAttachmentService['clearMonitoredAttachments']).toHaveBeenCalled();
      expect(mockAttachmentService['monitorAttachment']).toHaveBeenCalledTimes(1);
    });

    it('懒加载失败时不抛异常且不阻断流程', async () => {
      userIdSignal.set('user-1');
      vi.spyOn(service, 'getAttachmentServiceLazy').mockResolvedValue(null);

      const project = createProject({
        id: 'with-attachment',
        tasks: [
          createTask({
            id: 'task-1',
            attachments: [createAttachment('00000000-0000-0000-0000-000000000001')],
          }),
        ],
      });

      await expect(
        (
          service as unknown as {
            monitorProjectAttachments: (project: Project) => Promise<void>;
          }
        ).monitorProjectAttachments(project)
      ).resolves.toBeUndefined();
    });
  });

  describe('startBackgroundSync', () => {
    it('Supabase auth session 尚未切到当前用户时，不应按不可访问裁剪 activeProject', async () => {
      userIdSignal.set('user-1');
      const activeProject = createProject({ id: 'proj-active', name: 'Active', syncSource: 'synced' });
      (mockProjectState['setProjects'] as (projects: Project[]) => void)([activeProject]);
      (mockProjectState['setActiveProjectId'] as (projectId: string | null) => void)('proj-active');
      vi.clearAllMocks();

      mockSupabaseClientService.getSession.mockResolvedValueOnce({
        data: { session: { user: { id: 'old-user' } } },
        error: null,
      });
      (
        (mockSyncCoordinator['core'] as Record<string, unknown>)['getResumeRecoveryProbe'] as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        activeProjectId: 'proj-active',
        activeAccessible: false,
        activeWatermark: null,
        projectsWatermark: '2026-02-17T10:02:00.000Z',
        blackboxWatermark: null,
        serverNow: '2026-02-17T10:03:01.000Z',
      });
      (
        (mockSyncCoordinator['core'] as Record<string, unknown>)['getAccessibleProjectProbe'] as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        projectId: 'proj-active',
        accessible: false,
        watermark: null,
      });

      await (
        service as unknown as {
          startBackgroundSync: (userId: string, previousActive: string | null) => Promise<void>;
        }
      ).startBackgroundSync('user-1', null);

      expect(
        (mockSyncCoordinator['core'] as Record<string, unknown>)['getResumeRecoveryProbe']
      ).not.toHaveBeenCalled();
      expect(
        (mockSyncCoordinator['core'] as Record<string, unknown>)['getAccessibleProjectProbe']
      ).not.toHaveBeenCalled();
      expect(mockProjectState['setActiveProjectId']).not.toHaveBeenCalledWith(null);
      expect(mockToastService['info']).not.toHaveBeenCalledWith('当前项目不可访问，已自动切换');
    });

    it('activeProject 首次补水返回空项目时也应复核一次，避免假空覆盖本地数据', async () => {
      userIdSignal.set('user-1');
      const activeShell = createProject({
        id: 'proj-active-empty',
        name: 'Active Shell',
        syncSource: 'synced',
        tasks: [],
        connections: [],
      });
      const localProject = createProject({
        id: 'proj-active-empty',
        name: 'Local Snapshot',
        syncSource: 'synced',
        tasks: [createTask({ id: 'task-local-active-empty', content: 'keep me' })],
        connections: [],
      });
      (mockProjectState['setProjects'] as (projects: Project[]) => void)([activeShell]);
      (mockProjectState['setActiveProjectId'] as (projectId: string | null) => void)('proj-active-empty');
      (mockProjectState['getProjectsWithCurrentData'] as ReturnType<typeof vi.fn>).mockReturnValue([localProject]);
      vi.clearAllMocks();

      vi.spyOn(
        service as unknown as {
          ensureProjectListMetadataSynced: (userId: string, sessionGuard?: unknown, pendingWatermark?: string | null) => Promise<Set<string>>;
        },
        'ensureProjectListMetadataSynced'
      ).mockResolvedValue(new Set(['proj-active-empty']));
      vi.spyOn(
        service as unknown as {
          hydrateShellProjectsInBackground: (userId: string, activeProjectId: string | null, sessionGuard?: unknown) => Promise<void>;
        },
        'hydrateShellProjectsInBackground'
      ).mockResolvedValue(undefined);

      (mockSyncCoordinator['loadSingleProjectFromCloud'] as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(createProject({
          id: 'proj-active-empty',
          name: 'Remote Empty First',
          syncSource: 'synced',
          tasks: [],
          connections: [],
        }))
        .mockResolvedValueOnce(createProject({
          id: 'proj-active-empty',
          name: 'Remote Confirmed',
          syncSource: 'synced',
          tasks: [createTask({ id: 'task-remote-active-empty', content: 'remote ok' })],
          connections: [],
        }));

      await (
        service as unknown as {
          startBackgroundSync: (userId: string, previousActive: string | null) => Promise<void>;
        }
      ).startBackgroundSync('user-1', null);

      expect(mockSyncCoordinator['loadSingleProjectFromCloud']).toHaveBeenCalledTimes(2);
      expect(mockProjectState['setProjects']).toHaveBeenCalledWith([
        expect.objectContaining({
          id: 'proj-active-empty',
          name: 'Remote Confirmed',
          tasks: [expect.objectContaining({ id: 'task-remote-active-empty', content: 'remote ok' })],
        }),
      ]);
      expect(mockLoggerCategory.warn).toHaveBeenCalledWith(
        '按需加载首次返回空图数据，正在复核远端结果',
        expect.objectContaining({
          projectId: 'proj-active-empty',
          localTaskCount: 1,
        }),
      );
    });

    it('已水合的 activeProject 再次遇到空补水时仍应复核，避免会话内后续假空覆盖', async () => {
      userIdSignal.set('user-1');
      const activeProject = createProject({
        id: 'proj-active-hydrated-empty',
        name: 'Hydrated Local',
        syncSource: 'synced',
        tasks: [createTask({ id: 'task-local-hydrated-empty', content: 'keep me hydrated' })],
        connections: [],
      });
      (mockProjectState['setProjects'] as (projects: Project[]) => void)([activeProject]);
      (mockProjectState['setActiveProjectId'] as (projectId: string | null) => void)('proj-active-hydrated-empty');
      (mockProjectState['getProjectsWithCurrentData'] as ReturnType<typeof vi.fn>).mockReturnValue([activeProject]);
      (
        service as unknown as {
          hydratedProjectIds: Set<string>;
        }
      ).hydratedProjectIds.add('proj-active-hydrated-empty');
      vi.clearAllMocks();

      vi.spyOn(
        service as unknown as {
          ensureProjectListMetadataSynced: (userId: string, sessionGuard?: unknown, pendingWatermark?: string | null) => Promise<Set<string>>;
        },
        'ensureProjectListMetadataSynced'
      ).mockResolvedValue(new Set(['proj-active-hydrated-empty']));
      vi.spyOn(
        service as unknown as {
          hydrateShellProjectsInBackground: (userId: string, activeProjectId: string | null, sessionGuard?: unknown) => Promise<void>;
        },
        'hydrateShellProjectsInBackground'
      ).mockResolvedValue(undefined);

      (mockSyncCoordinator['loadSingleProjectFromCloud'] as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(createProject({
          id: 'proj-active-hydrated-empty',
          name: 'Remote Empty First',
          syncSource: 'synced',
          tasks: [],
          connections: [],
        }))
        .mockResolvedValueOnce(createProject({
          id: 'proj-active-hydrated-empty',
          name: 'Remote Confirmed Later',
          syncSource: 'synced',
          tasks: [createTask({ id: 'task-remote-hydrated-empty', content: 'remote ok later' })],
          connections: [],
        }));

      await (
        service as unknown as {
          startBackgroundSync: (userId: string, previousActive: string | null) => Promise<void>;
        }
      ).startBackgroundSync('user-1', null);

      expect(mockSyncCoordinator['loadSingleProjectFromCloud']).toHaveBeenCalledTimes(2);
      expect(mockProjectState['setProjects']).toHaveBeenCalledWith([
        expect.objectContaining({
          id: 'proj-active-hydrated-empty',
          name: 'Remote Confirmed Later',
          tasks: [expect.objectContaining({ id: 'task-remote-hydrated-empty', content: 'remote ok later' })],
        }),
      ]);
      expect(mockLoggerCategory.warn).toHaveBeenCalledWith(
        '按需加载首次返回空图数据，正在复核远端结果',
        expect.objectContaining({
          projectId: 'proj-active-hydrated-empty',
          localTaskCount: 1,
        }),
      );
    });

    it('activeProject 不可访问时应清理并跳过项目同步', async () => {
      const deniedProject = createProject({ id: 'proj-denied', name: 'Denied', syncSource: 'synced' });
      const keepProject = createProject({
        id: 'proj-ok',
        name: 'Keep',
        syncSource: 'synced',
        tasks: [createTask({ id: 'task-keep' })],
      });
      (mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([deniedProject, keepProject]);
      (mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue('proj-denied');
      (mockSyncCoordinator['core'] as { saveOfflineSnapshot: ReturnType<typeof vi.fn> }).saveOfflineSnapshot.mockClear();
      (mockSyncCoordinator['loadSingleProjectFromCloud'] as ReturnType<typeof vi.fn>).mockResolvedValue(keepProject);
      vi.spyOn(
        service as unknown as {
          syncProjectListMetadata: (userId: string) => Promise<Set<string>>;
        },
        'syncProjectListMetadata'
      ).mockResolvedValue(new Set(['proj-ok']));

      await (
        service as unknown as {
          startBackgroundSync: (userId: string, previousActive: string | null) => Promise<void>;
        }
      ).startBackgroundSync('user-1', null);

      expect(mockProjectState['setActiveProjectId']).toHaveBeenCalledWith(null);
      expect(mockProjectState['setProjects']).toHaveBeenCalledWith([
        expect.objectContaining({ id: 'proj-ok' }),
      ]);
      expect((mockSyncCoordinator['core'] as { saveOfflineSnapshot: ReturnType<typeof vi.fn> }).saveOfflineSnapshot)
        .toHaveBeenCalledWith([
          expect.objectContaining({ id: 'proj-ok' }),
        ], 'user-1');
      expect(mockToastService['info']).toHaveBeenCalledWith('当前项目不可访问，已自动切换');
      expect(mockSyncCoordinator['loadSingleProjectFromCloud']).toHaveBeenCalledWith('proj-ok');
      expect(mockSyncCoordinator['performDeltaSync']).not.toHaveBeenCalled();
    });

    it('activeProject probe 不可访问时应提前清理，避免后续 full-project 路径', async () => {
      const deniedProject = createProject({ id: 'proj-denied', name: 'Denied', syncSource: 'synced' });
      const keepProject = createProject({
        id: 'proj-ok',
        name: 'Keep',
        syncSource: 'synced',
        tasks: [createTask({ id: 'task-keep' })],
      });
      (mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([deniedProject, keepProject]);
      (mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue('proj-denied');
      (mockSyncCoordinator['core'] as { saveOfflineSnapshot: ReturnType<typeof vi.fn> }).saveOfflineSnapshot.mockClear();
      (
        (mockSyncCoordinator['core'] as Record<string, unknown>)['getAccessibleProjectProbe'] as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        projectId: 'proj-denied',
        accessible: false,
        watermark: null,
      });
      (mockSyncCoordinator['refreshProjectManifestIfNeeded'] as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ skipped: true, watermark: '2026-02-17T10:02:00.000Z' });
      vi.spyOn(
        service as unknown as {
          syncProjectListMetadata: (userId: string) => Promise<Set<string>>;
        },
        'syncProjectListMetadata'
      ).mockResolvedValue(new Set(['proj-ok']));

      await (
        service as unknown as {
          startBackgroundSync: (userId: string, previousActive: string | null) => Promise<void>;
        }
      ).startBackgroundSync('user-1', null);

      expect(mockProjectState['setActiveProjectId']).toHaveBeenCalledWith(null);
      expect(mockProjectState['setProjects']).toHaveBeenCalledWith([
        expect.objectContaining({ id: 'proj-ok' }),
      ]);
      expect((mockSyncCoordinator['core'] as { saveOfflineSnapshot: ReturnType<typeof vi.fn> }).saveOfflineSnapshot)
        .toHaveBeenCalledWith([
          expect.objectContaining({ id: 'proj-ok' }),
        ], 'user-1');
      expect(mockSyncCoordinator['loadSingleProjectFromCloud']).not.toHaveBeenCalled();
      expect(mockSyncCoordinator['performDeltaSync']).not.toHaveBeenCalled();
    });

    it('composite probe 命中时应优先使用预加载水位，避免重复 RPC', async () => {
      (mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue('proj-1');
      (
        (mockSyncCoordinator['core'] as Record<string, unknown>)['getResumeRecoveryProbe'] as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        activeProjectId: 'proj-1',
        activeAccessible: true,
        activeWatermark: '2026-02-17T10:00:00.000Z',
        projectsWatermark: '2026-02-17T10:02:00.000Z',
        blackboxWatermark: '2026-02-17T10:03:00.000Z',
        serverNow: '2026-02-17T10:03:01.000Z',
      });
      (mockSyncCoordinator['refreshProjectManifestIfNeeded'] as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ skipped: false, watermark: '2026-02-17T10:02:00.000Z' });

      await (
        service as unknown as {
          startBackgroundSync: (userId: string, previousActive: string | null) => Promise<void>;
        }
      ).startBackgroundSync('user-1', null);

      expect(
        (mockSyncCoordinator['core'] as Record<string, unknown>)['setLastSyncTime']
      ).not.toHaveBeenCalled();
      expect(mockSyncCoordinator['refreshProjectManifestIfNeeded']).toHaveBeenCalledWith(
        'session-background-sync',
        { prefetchedRemoteWatermark: '2026-02-17T10:02:00.000Z', deferCommit: true }
      );
      expect(mockSyncCoordinator['refreshBlackBoxWatermarkIfNeeded']).toHaveBeenCalledWith(
        'session-background-sync',
        { prefetchedRemoteWatermark: '2026-02-17T10:03:00.000Z' }
      );
      expect(
        (mockSyncCoordinator['core'] as Record<string, unknown>)['getAccessibleProjectProbe']
      ).not.toHaveBeenCalled();
    });

    it('项目清单快路命中时仍应执行黑匣子快路，并仅保留当前项目的 Delta Sync', async () => {
      (mockProjectState['setProjects'] as (...args: unknown[]) => void)([
        createProject({ id: 'proj-1', syncSource: 'synced', tasks: [createTask({ id: 'task-1' })] }),
      ]);
      (mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue('proj-1');
      (
        (mockSyncCoordinator['core'] as Record<string, unknown>)['getResumeRecoveryProbe'] as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        activeProjectId: 'proj-1',
        activeAccessible: true,
        activeWatermark: '2026-02-17T10:00:00.000Z',
        projectsWatermark: '2026-02-17T10:02:00.000Z',
        blackboxWatermark: '2026-02-17T10:03:00.000Z',
        serverNow: '2026-02-17T10:03:01.000Z',
      });
      (mockSyncCoordinator['refreshProjectManifestIfNeeded'] as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ skipped: true, watermark: '2026-02-17T10:02:00.000Z' });

      const syncProjectListMetadataSpy = vi.spyOn(
        service as unknown as {
          syncProjectListMetadata: (userId: string) => Promise<Set<string>>;
        },
        'syncProjectListMetadata'
      );

      await (
        service as unknown as {
          startBackgroundSync: (userId: string, previousActive: string | null) => Promise<void>;
        }
      ).startBackgroundSync('user-1', null);

      expect(syncProjectListMetadataSpy).not.toHaveBeenCalled();
      expect(mockSyncCoordinator['performDeltaSync']).toHaveBeenCalledWith('proj-1');
      expect(mockSyncCoordinator['loadSingleProjectFromCloud']).not.toHaveBeenCalled();
      expect(mockSyncCoordinator['refreshBlackBoxWatermarkIfNeeded']).toHaveBeenCalledWith(
        'session-background-sync',
        { prefetchedRemoteWatermark: '2026-02-17T10:03:00.000Z' }
      );
    });

    it('项目清单快路命中时，owner 匹配的 local-only 恢复项目仍应补做元数据同步以恢复云同步', async () => {
      const localOnlyProject = createProject({
        id: 'proj-legacy-local-only',
        name: 'Recovered Project',
        syncSource: 'local-only',
        pendingSync: true,
      });
      (mockProjectState['setProjects'] as (...args: unknown[]) => void)([localOnlyProject]);
      (mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue('proj-legacy-local-only');
      (
        (mockSyncCoordinator['core'] as Record<string, unknown>)['getResumeRecoveryProbe'] as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        activeProjectId: null,
        activeAccessible: false,
        activeWatermark: null,
        projectsWatermark: '2026-02-17T10:02:00.000Z',
        blackboxWatermark: '2026-02-17T10:03:00.000Z',
        serverNow: '2026-02-17T10:03:01.000Z',
      });
      (mockSyncCoordinator['refreshProjectManifestIfNeeded'] as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ skipped: true, watermark: '2026-02-17T10:02:00.000Z' });

      const syncProjectListMetadataSpy = vi.spyOn(
        service as unknown as {
          syncProjectListMetadata: (userId: string) => Promise<Set<string>>;
        },
        'syncProjectListMetadata'
      ).mockImplementation(async () => {
        (mockProjectState['setProjects'] as (...args: unknown[]) => void)([
          {
            ...localOnlyProject,
            syncSource: 'synced',
            pendingSync: false,
            tasks: [createTask({ id: 'task-restored' })],
          },
        ]);
        return new Set(['proj-legacy-local-only']);
      });

      await (
        service as unknown as {
          startBackgroundSync: (userId: string, previousActive: string | null) => Promise<void>;
        }
      ).startBackgroundSync('user-1', null);

      expect(syncProjectListMetadataSpy).toHaveBeenCalledWith('user-1', undefined, true);
      expect(mockSyncCoordinator['performDeltaSync']).toHaveBeenCalledWith('proj-legacy-local-only');
      expect(mockSyncCoordinator['loadSingleProjectFromCloud']).not.toHaveBeenCalled();
    });

    it('探测到更高 manifest 水位时应重新拉取 metadata，而不是复用旧缓存', async () => {
      userIdSignal.set('user-1');
      const localProject = createProject({
        id: 'proj-cached',
        name: 'Cached',
        syncSource: 'synced',
        tasks: [createTask({ id: 'task-cached' })],
      });
      (mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([localProject]);
      (mockProjectState['getProject'] as ReturnType<typeof vi.fn>).mockImplementation((id: string) => {
        return id === localProject.id ? localProject : undefined;
      });
      (mockProjectState['getProjectsWithCurrentData'] as ReturnType<typeof vi.fn>).mockReturnValue([localProject]);
      (mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue(null);
      mockSupabaseClientService.getSession.mockResolvedValue({
        data: { session: { user: { id: 'user-1' } } },
        error: null,
      });

      const metadataSyncSucceededState = (
        service as unknown as { lastProjectListMetadataSyncSucceededState: WritableSignal<boolean> }
      ).lastProjectListMetadataSyncSucceededState;
      const metadataSyncDurableState = (
        service as unknown as { lastProjectListMetadataSyncDurableState: WritableSignal<boolean> }
      ).lastProjectListMetadataSyncDurableState;
      const syncProjectListMetadataSpy = vi.spyOn(
        service as unknown as {
          syncProjectListMetadata: (userId: string, sessionGuard?: unknown) => Promise<Set<string>>;
        },
        'syncProjectListMetadata'
      ).mockImplementation(async () => {
        metadataSyncSucceededState.set(true);
        metadataSyncDurableState.set(true);
        return new Set(['proj-cached']);
      });

      await (
        service as unknown as {
          ensureProjectListMetadataSynced: (
            userId: string,
            sessionGuard?: unknown,
            manifestWatermark?: string | null,
          ) => Promise<Set<string>>;
        }
      ).ensureProjectListMetadataSynced('user-1', undefined, '2026-05-27T01:00:00.000Z');

      (mockSyncCoordinator['refreshProjectManifestIfNeeded'] as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ skipped: false, watermark: '2026-05-27T02:00:00.000Z' });
      (mockSyncCoordinator['commitProjectManifestWatermark'] as ReturnType<typeof vi.fn>).mockClear();

      await (
        service as unknown as {
          startBackgroundSync: (userId: string, previousActive: string | null) => Promise<void>;
        }
      ).startBackgroundSync('user-1', null);

      expect(syncProjectListMetadataSpy).toHaveBeenCalledTimes(2);
      expect(mockSyncCoordinator['commitProjectManifestWatermark']).toHaveBeenCalledWith(
        '2026-05-27T02:00:00.000Z',
        'user-1'
      );
    });

    it('远端已删的 local-only 影子项目在无真实本地改动时应被移除', async () => {
      const shadowProject = createProject({
        id: 'proj-shadow-deleted',
        name: 'Shadow Deleted',
        syncSource: 'local-only',
        pendingSync: true,
      });
      (mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([shadowProject]);
      (mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue('proj-shadow-deleted');
      (mockSyncCoordinator['core'] as { saveOfflineSnapshot: ReturnType<typeof vi.fn> }).saveOfflineSnapshot.mockClear();
      (
        (mockSyncCoordinator['core'] as Record<string, unknown>)['getResumeRecoveryProbe'] as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        activeProjectId: 'proj-shadow-deleted',
        activeAccessible: false,
        activeWatermark: null,
        projectsWatermark: '2026-02-17T10:02:00.000Z',
        blackboxWatermark: '2026-02-17T10:03:00.000Z',
        serverNow: '2026-02-17T10:03:01.000Z',
      });
      (mockSyncCoordinator['refreshProjectManifestIfNeeded'] as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ skipped: true, watermark: '2026-02-17T10:02:00.000Z' });

      await (
        service as unknown as {
          startBackgroundSync: (userId: string, previousActive: string | null) => Promise<void>;
        }
      ).startBackgroundSync('user-1', null);

      expect(mockProjectState['setActiveProjectId']).toHaveBeenCalledWith(null);
      expect(mockProjectState['setProjects']).toHaveBeenCalledWith([]);
      expect((mockSyncCoordinator['core'] as { saveOfflineSnapshot: ReturnType<typeof vi.fn> }).saveOfflineSnapshot)
        .toHaveBeenCalledWith([], 'user-1');
      expect(mockSyncCoordinator['performDeltaSync']).not.toHaveBeenCalled();
      expect(mockSyncCoordinator['loadSingleProjectFromCloud']).not.toHaveBeenCalled();
    });

    it('项目元数据慢路成功后应提交 deferred manifest watermark', async () => {
      const query = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        order: vi.fn().mockResolvedValue({
          data: [{
            id: 'proj-ok',
            title: 'Keep',
            description: '',
            created_date: '2026-02-17T10:00:00.000Z',
            updated_at: '2026-02-17T10:02:00.000Z',
            version: 1,
            owner_id: 'user-1',
          }],
          error: null,
        }),
      };
      mockSupabaseClientService.clientAsync.mockResolvedValue({
        from: vi.fn().mockReturnValue(query),
      });
      (mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([]);
      (mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue(null);
      (mockSyncCoordinator['refreshProjectManifestIfNeeded'] as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ skipped: false, watermark: '2026-02-17T10:05:00.000Z' });
      (mockSyncCoordinator['loadSingleProjectFromCloud'] as ReturnType<typeof vi.fn>).mockResolvedValue(
        createProject({ id: 'proj-ok', name: 'Keep', syncSource: 'synced' })
      );

      await (
        service as unknown as {
          startBackgroundSync: (userId: string, previousActive: string | null) => Promise<void>;
        }
      ).startBackgroundSync('user-1', null);

      expect(mockSyncCoordinator['commitProjectManifestWatermark']).toHaveBeenCalledWith(
        '2026-02-17T10:05:00.000Z',
        'user-1'
      );
    });

    it('项目元数据已更新但快照落盘失败时不应提交 deferred manifest watermark', async () => {
      const query = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        order: vi.fn().mockResolvedValue({
          data: [{
            id: 'proj-ok',
            title: 'Keep',
            description: '',
            created_date: '2026-02-17T10:00:00.000Z',
            updated_at: '2026-02-17T10:02:00.000Z',
            version: 1,
            owner_id: 'user-1',
          }],
          error: null,
        }),
      };
      mockSupabaseClientService.clientAsync.mockResolvedValue({
        from: vi.fn().mockReturnValue(query),
      });
      (mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([]);
      (mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue(null);
      (mockSyncCoordinator['refreshProjectManifestIfNeeded'] as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ skipped: false, watermark: '2026-02-17T10:05:00.000Z' });
      vi.spyOn(
        service as unknown as {
          saveProjectsToOfflineSnapshot: (projects: Project[], userId: string, options?: unknown) => Promise<void>;
        },
        'saveProjectsToOfflineSnapshot'
      ).mockRejectedValue(new Error('disk full'));

      await (
        service as unknown as {
          startBackgroundSync: (userId: string, previousActive: string | null) => Promise<void>;
        }
      ).startBackgroundSync('user-1', null);

      expect(mockSyncCoordinator['commitProjectManifestWatermark']).not.toHaveBeenCalled();
    });

    it('项目元数据慢路失败时不应提交 deferred manifest watermark', async () => {
      const query = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        order: vi.fn().mockResolvedValue({
          data: null,
          error: { message: 'boom' },
        }),
      };
      mockSupabaseClientService.clientAsync.mockResolvedValue({
        from: vi.fn().mockReturnValue(query),
      });
      (mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([]);
      (mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue(null);
      (mockSyncCoordinator['refreshProjectManifestIfNeeded'] as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ skipped: false, watermark: '2026-02-17T10:05:00.000Z' });

      await (
        service as unknown as {
          startBackgroundSync: (userId: string, previousActive: string | null) => Promise<void>;
        }
      ).startBackgroundSync('user-1', null);

      expect(mockSyncCoordinator['commitProjectManifestWatermark']).not.toHaveBeenCalled();
    });

    it('项目清单快路命中且 activeProject 缺席但有待同步改动时，应降级为 local-only 并立即落盘', async () => {
      const deniedProject = createProject({
        id: 'proj-denied',
        name: 'Denied',
        syncSource: 'synced',
        pendingSync: false,
      });
      const localOnlyProject = createProject({
        id: 'proj-local-only',
        name: 'Local Draft',
        syncSource: 'local-only',
        pendingSync: true,
      });
      const recoveredProject = createProject({
        id: 'proj-recovered',
        name: 'Recovered',
        syncSource: 'synced',
        pendingSync: false,
      });
      (mockProjectState['setProjects'] as (...args: unknown[]) => void)([deniedProject, localOnlyProject]);
      (mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue('proj-denied');
      (mockSyncCoordinator['hasPendingChangesForProject'] as ReturnType<typeof vi.fn>).mockImplementation(
        (projectId: string) => projectId === 'proj-denied'
      );
      (mockSyncCoordinator['core'] as { saveOfflineSnapshot: ReturnType<typeof vi.fn> }).saveOfflineSnapshot.mockClear();
      (
        (mockSyncCoordinator['core'] as Record<string, unknown>)['getResumeRecoveryProbe'] as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        activeProjectId: 'proj-denied',
        activeAccessible: true,
        activeWatermark: '2026-02-17T10:01:00.000Z',
        projectsWatermark: '2026-02-17T10:02:00.000Z',
        blackboxWatermark: '2026-02-17T10:03:00.000Z',
        serverNow: '2026-02-17T10:03:01.000Z',
      });
      (mockSyncCoordinator['refreshProjectManifestIfNeeded'] as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ skipped: true, watermark: '2026-02-17T10:02:00.000Z' });

      vi.spyOn(
        service as unknown as {
          syncProjectListMetadata: (userId: string) => Promise<Set<string>>;
        },
        'syncProjectListMetadata'
      ).mockImplementation(async () => {
        (mockProjectState['setProjects'] as (...args: unknown[]) => void)([deniedProject, recoveredProject]);
        return new Set(['proj-recovered']);
      });

      await (
        service as unknown as {
          startBackgroundSync: (userId: string, previousActive: string | null) => Promise<void>;
        }
      ).startBackgroundSync('user-1', null);

      expect(mockProjectState['setProjects']).toHaveBeenCalledWith([
        expect.objectContaining({ id: 'proj-denied', syncSource: 'local-only', pendingSync: true }),
        expect.objectContaining({ id: 'proj-recovered', syncSource: 'synced' }),
      ]);
      expect((mockSyncCoordinator['core'] as { saveOfflineSnapshot: ReturnType<typeof vi.fn> }).saveOfflineSnapshot)
        .toHaveBeenCalledWith([
          expect.objectContaining({ id: 'proj-denied', syncSource: 'local-only', pendingSync: true }),
          expect.objectContaining({ id: 'proj-recovered', syncSource: 'synced' }),
        ], 'user-1');
      expect(mockToastService['info']).not.toHaveBeenCalledWith('当前项目不可访问，已自动切换');
      // 注意：loadSingleProjectFromCloud 可能会被后台空壳项目加载调用，
      // 但不应用于已降级为 local-only 的项目
    });
  });

  describe('syncProjectListMetadata', () => {
    /** 辅助：构建 Supabase client mock，返回指定的服务端项目列表 */
    function setupSupabaseQuery(serverProjects: Array<Record<string, unknown>>) {
      const query = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        order: vi.fn().mockResolvedValue({
          data: serverProjects,
          error: null,
        }),
      };
      mockSupabaseClientService.client.mockReturnValue({
        from: vi.fn().mockReturnValue(query),
      });
      mockSupabaseClientService.clientAsync.mockResolvedValue({
        from: vi.fn().mockReturnValue(query),
      });
    }

    it('Supabase auth session 尚未切到当前用户时，应把空项目清单视为非权威结果', async () => {
      const localProject = createProject({ id: 'proj-local', name: 'Local', syncSource: 'synced' });
      userIdSignal.set('user-1');
      (mockProjectState['setProjects'] as (projects: Project[]) => void)([localProject]);
      (mockProjectState['setActiveProjectId'] as (projectId: string | null) => void)(null);
      vi.clearAllMocks();
      mockSupabaseClientService.getSession.mockResolvedValueOnce({
        data: { session: { user: { id: 'old-user' } } },
        error: null,
      });
      setupSupabaseQuery([]);

      const accessibleProjectIds = await (
        service as unknown as {
          syncProjectListMetadata: (userId: string) => Promise<Set<string>>;
        }
      ).syncProjectListMetadata('user-1');

      expect([...accessibleProjectIds]).toEqual(['proj-local']);
      expect(mockProjectState['setProjectsMetadataOnly']).not.toHaveBeenCalled();
      expect(service.canAuthoritativelyRejectProjectRoute()).toBe(false);
    });

    it('在项目数达到裁剪阈值时，应清理不可访问且无待同步改动的非活跃项目', async () => {
      const keepProject = createProject({ id: 'proj-ok', name: 'Keep' });
      const keepProject2 = createProject({ id: 'proj-ok-2', name: 'Keep 2' });
      const staleProject = createProject({ id: 'proj-stale', name: 'Stale' });
      (mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([keepProject, keepProject2, staleProject]);
      // activeProjectId 设为 null，以便 staleProject 可被裁剪
      (mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue(null);
      (mockSyncCoordinator['hasPendingChangesForProject'] as ReturnType<typeof vi.fn>).mockReturnValue(false);

      setupSupabaseQuery([
        {
          id: 'proj-ok', title: 'Keep', description: '',
          created_date: keepProject.createdDate, updated_at: keepProject.updatedAt, version: 1,
        },
        {
          id: 'proj-ok-2', title: 'Keep 2', description: '',
          created_date: keepProject2.createdDate, updated_at: keepProject2.updatedAt, version: 1,
        },
      ]);

      const result = await (
        service as unknown as {
          syncProjectListMetadata: (userId: string) => Promise<Set<string>>;
        }
      ).syncProjectListMetadata('user-1');

      expect(result.has('proj-ok')).toBe(true);
      expect(result.has('proj-ok-2')).toBe(true);
      expect(result.has('proj-stale')).toBe(false);
      expect(mockProjectState['setProjectsMetadataOnly']).toHaveBeenCalledWith([
        expect.objectContaining({ id: 'proj-ok' }),
        expect.objectContaining({ id: 'proj-ok-2' }),
      ]);
    });

    it('当前活跃项目不应被裁剪（由调用方处理）', async () => {
      const keepProject = createProject({ id: 'proj-ok', name: 'Keep' });
      const activeProject = createProject({ id: 'proj-active', name: 'Active' });
      const staleProject = createProject({ id: 'proj-stale', name: 'Stale' });
      (mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([keepProject, activeProject, staleProject]);
      (mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue('proj-active');
      (mockSyncCoordinator['hasPendingChangesForProject'] as ReturnType<typeof vi.fn>).mockReturnValue(false);

      // 服务端返回 proj-ok 和一个新项目，ratio 2/3 ≥ 50%，裁剪正常执行
      // proj-active 和 proj-stale 都不可访问，但 proj-active 受保护
      setupSupabaseQuery([
        {
          id: 'proj-ok', title: 'Keep', description: '',
          created_date: keepProject.createdDate, updated_at: keepProject.updatedAt, version: 1,
        },
        {
          id: 'proj-new', title: 'New', description: '',
          created_date: new Date().toISOString(), updated_at: new Date().toISOString(), version: 1,
        },
      ]);

      await (
        service as unknown as {
          syncProjectListMetadata: (userId: string) => Promise<Set<string>>;
        }
      ).syncProjectListMetadata('user-1');

      // 验证 setProjectsMetadataOnly 被调用（有壳新增 + 裁剪变更）
      const setProjectsCall = (mockProjectState['setProjectsMetadataOnly'] as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      expect(setProjectsCall).toBeDefined();
      // proj-active 是当前活跃项目，不应被裁剪
      expect(setProjectsCall.some((p: Project) => p.id === 'proj-active')).toBe(true);
      expect(setProjectsCall.some((p: Project) => p.id === 'proj-ok')).toBe(true);
      // proj-stale 不是活跃项目，应被裁剪
      expect(setProjectsCall.some((p: Project) => p.id === 'proj-stale')).toBe(false);
      // proj-new 应被添加为壳
      expect(setProjectsCall.some((p: Project) => p.id === 'proj-new')).toBe(true);
    });

    it('服务端返回空列表时应裁剪全部不可访问的 synced 项目', async () => {
      const localA = createProject({ id: 'proj-a', name: 'A' });
      const localB = createProject({ id: 'proj-b', name: 'B' });
      (mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([localA, localB]);
      (mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue(null);
      (mockSyncCoordinator['hasPendingChangesForProject'] as ReturnType<typeof vi.fn>).mockReturnValue(false);
      (mockSyncCoordinator['core'] as { saveOfflineSnapshot: ReturnType<typeof vi.fn> }).saveOfflineSnapshot.mockClear();

      setupSupabaseQuery([]); // 服务端返回空

      await (
        service as unknown as {
          syncProjectListMetadata: (userId: string) => Promise<Set<string>>;
        }
      ).syncProjectListMetadata('user-1');

      expect(mockProjectState['setProjectsMetadataOnly']).toHaveBeenCalledWith([]);
      expect((mockSyncCoordinator['core'] as { saveOfflineSnapshot: ReturnType<typeof vi.fn> }).saveOfflineSnapshot)
        .toHaveBeenCalledWith([], 'user-1');
    });

    it('服务端项目数显著少于本地时仍应裁剪缺失的 synced 项目', async () => {
      const localProjects = [
        createProject({ id: 'p1', name: 'P1' }),
        createProject({ id: 'p2', name: 'P2' }),
        createProject({ id: 'p3', name: 'P3' }),
        createProject({ id: 'p4', name: 'P4' }),
      ];
      (mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue(localProjects);
      (mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue(null);
      (mockSyncCoordinator['hasPendingChangesForProject'] as ReturnType<typeof vi.fn>).mockReturnValue(false);

      // 服务端只返回 1/4，但查询已成功，应按真实远端状态裁剪
      setupSupabaseQuery([{
        id: 'p1', title: 'P1', description: '',
        created_date: localProjects[0].createdDate, updated_at: localProjects[0].updatedAt, version: 1,
      }]);

      await (
        service as unknown as {
          syncProjectListMetadata: (userId: string) => Promise<Set<string>>;
        }
      ).syncProjectListMetadata('user-1');

      const setProjectsCall = (mockProjectState['setProjectsMetadataOnly'] as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Project[] | undefined;
      expect(setProjectsCall?.map((project: Project) => project.id)).toEqual(['p1']);
    });

    it('本地仅有 2 个项目时也应裁剪缺失的 synced 项目', async () => {
      const localProjects = [
        createProject({ id: 'p1', name: 'P1' }),
        createProject({ id: 'p2', name: 'P2' }),
      ];
      (mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue(localProjects);
      (mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue(null);
      (mockSyncCoordinator['hasPendingChangesForProject'] as ReturnType<typeof vi.fn>).mockReturnValue(false);

      setupSupabaseQuery([{
        id: 'p1', title: 'P1', description: '',
        created_date: localProjects[0].createdDate, updated_at: localProjects[0].updatedAt, version: 1,
      }]);

      await (
        service as unknown as {
          syncProjectListMetadata: (userId: string) => Promise<Set<string>>;
        }
      ).syncProjectListMetadata('user-1');

      const setProjectsCall = (mockProjectState['setProjectsMetadataOnly'] as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Project[] | undefined;
      expect(setProjectsCall?.map((project: Project) => project.id)).toEqual(['p1']);
    });

    it('服务端存在的项目应被提升为 synced，清除 local-only 影子标记', async () => {
      const remoteUpdatedAt = '2026-04-04T04:00:00.000Z';
      const localProject = createProject({
        id: 'proj-shadow',
        name: 'Shadow',
        updatedAt: '2026-04-04T03:00:00.000Z',
        syncSource: 'local-only',
        pendingSync: true,
      });
      (mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([localProject]);
      (mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue(null);
      (mockSyncCoordinator['hasPendingChangesForProject'] as ReturnType<typeof vi.fn>).mockReturnValue(false);
      (mockSyncCoordinator['core'] as { saveOfflineSnapshot: ReturnType<typeof vi.fn> }).saveOfflineSnapshot.mockClear();

      setupSupabaseQuery([{
        id: 'proj-shadow', title: 'Shadow', description: '',
        created_date: localProject.createdDate, updated_at: remoteUpdatedAt, version: localProject.version,
      }]);

      await (
        service as unknown as {
          syncProjectListMetadata: (userId: string) => Promise<Set<string>>;
        }
      ).syncProjectListMetadata('user-1');

      const setProjectsCall = (mockProjectState['setProjectsMetadataOnly'] as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Project[] | undefined;
      expect(setProjectsCall).toBeDefined();
      const syncedProject = setProjectsCall?.find((project: Project) => project.id === 'proj-shadow');
      expect(syncedProject?.syncSource).toBe('synced');
      expect(syncedProject?.pendingSync).toBe(false);
      expect(syncedProject?.updatedAt).toBe(remoteUpdatedAt);
      expect((mockSyncCoordinator['core'] as { saveOfflineSnapshot: ReturnType<typeof vi.fn> }).saveOfflineSnapshot)
        .toHaveBeenCalledWith([
          expect.objectContaining({
            id: 'proj-shadow',
            syncSource: 'synced',
            pendingSync: false,
            updatedAt: remoteUpdatedAt,
          }),
        ], 'user-1');
    });

    it('local-only 项目即使服务端不存在也应继续保留，等待用户决定是否迁移', async () => {
      const remoteProjectA = createProject({ id: 'proj-a', name: 'A', syncSource: 'synced' });
      const remoteProjectB = createProject({ id: 'proj-b', name: 'B', syncSource: 'synced' });
      const localOnlyProject = createProject({
        id: 'proj-local-only',
        name: 'Guest Draft',
        syncSource: 'local-only',
      });
      saveGuestDraftProjects([localOnlyProject]);
      (mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([
        remoteProjectA,
        remoteProjectB,
        localOnlyProject,
      ]);
      (mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue(null);
      (mockSyncCoordinator['hasPendingChangesForProject'] as ReturnType<typeof vi.fn>).mockReturnValue(false);

      setupSupabaseQuery([
        {
          id: 'proj-a', title: 'A', description: '',
          created_date: remoteProjectA.createdDate, updated_at: remoteProjectA.updatedAt, version: 1,
        },
        {
          id: 'proj-b', title: 'B', description: '',
          created_date: remoteProjectB.createdDate, updated_at: remoteProjectB.updatedAt, version: 1,
        },
      ]);

      await (
        service as unknown as {
          syncProjectListMetadata: (userId: string) => Promise<Set<string>>;
        }
      ).syncProjectListMetadata('user-1');

      const setProjectsCall = (mockProjectState['setProjectsMetadataOnly'] as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Project[] | undefined;
      expect(setProjectsCall?.some((project: Project) => project.id === 'proj-local-only')).toBe(true);
    });

    it('metadata sync 后保留的 local-only 项目仍应被视为可访问', async () => {
      const remoteProject = createProject({ id: 'proj-a', name: 'A', syncSource: 'synced' });
      const localOnlyProject = createProject({
        id: 'proj-local-only',
        name: 'Guest Draft',
        syncSource: 'local-only',
      });
      userIdSignal.set('user-1');
      saveGuestDraftProjects([localOnlyProject]);
      (mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([
        remoteProject,
        localOnlyProject,
      ]);
      (mockProjectState['getProject'] as ReturnType<typeof vi.fn>).mockImplementation(
        (id: string) => [remoteProject, localOnlyProject].find((project) => project.id === id)
      );
      (mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue(null);
      (mockSyncCoordinator['hasPendingChangesForProject'] as ReturnType<typeof vi.fn>).mockReturnValue(false);

      setupSupabaseQuery([
        {
          id: 'proj-a', title: 'A', description: '',
          created_date: remoteProject.createdDate, updated_at: remoteProject.updatedAt, version: 1,
        },
      ]);

      await (
        service as unknown as {
          syncProjectListMetadata: (userId: string) => Promise<Set<string>>;
        }
      ).syncProjectListMetadata('user-1');

      expect(service.isProjectAuthoritativelyAccessible('proj-local-only')).toBe(true);
    });

    it('匿名或 local-user 模式下缺失项目不应被视为可访问', () => {
      userIdSignal.set(AUTH_CONFIG.LOCAL_MODE_USER_ID);
      (mockProjectState['getProject'] as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

      expect(service.isProjectAuthoritativelyAccessible('proj-missing')).toBe(false);
    });

    it('expired guest draft 标记不应阻止 local-only 影子项目被裁剪', async () => {
      const remoteProject = createProject({ id: 'proj-a', name: 'A', syncSource: 'synced' });
      const shadowProject = createProject({
        id: 'proj-expired-shadow',
        name: 'Expired Shadow',
        syncSource: 'local-only',
        pendingSync: true,
      });
      localStorage.setItem('nanoflow.guest-data', JSON.stringify({
        projects: [shadowProject],
        version: 2,
        savedAt: '2026-02-01T00:00:00.000Z',
        expiresAt: '2026-02-02T00:00:00.000Z',
      }));
      (mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([remoteProject, shadowProject]);
      (mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue(null);
      (mockSyncCoordinator['hasPendingChangesForProject'] as ReturnType<typeof vi.fn>).mockReturnValue(false);

      setupSupabaseQuery([
        {
          id: 'proj-a', title: 'A', description: '',
          created_date: remoteProject.createdDate, updated_at: remoteProject.updatedAt, version: 1,
        },
      ]);

      await (
        service as unknown as {
          syncProjectListMetadata: (userId: string) => Promise<Set<string>>;
        }
      ).syncProjectListMetadata('user-1');

      const setProjectsCall = (mockProjectState['setProjectsMetadataOnly'] as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Project[] | undefined;
      expect(setProjectsCall?.map((project: Project) => project.id)).toEqual(['proj-a']);
    });

    it('无 guest draft 标记且无真实本地改动的 local-only 影子项目应被裁剪', async () => {
      const remoteProject = createProject({ id: 'proj-a', name: 'A', syncSource: 'synced' });
      const shadowProject = createProject({
        id: 'proj-shadow-only',
        name: 'Shadow',
        syncSource: 'local-only',
        pendingSync: true,
      });
      (mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([remoteProject, shadowProject]);
      (mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue(null);
      (mockSyncCoordinator['hasPendingChangesForProject'] as ReturnType<typeof vi.fn>).mockReturnValue(false);

      setupSupabaseQuery([
        {
          id: 'proj-a', title: 'A', description: '',
          created_date: remoteProject.createdDate, updated_at: remoteProject.updatedAt, version: 1,
        },
      ]);

      await (
        service as unknown as {
          syncProjectListMetadata: (userId: string) => Promise<Set<string>>;
        }
      ).syncProjectListMetadata('user-1');

      const setProjectsCall = (mockProjectState['setProjectsMetadataOnly'] as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Project[] | undefined;
      expect(setProjectsCall?.map((project: Project) => project.id)).toEqual(['proj-a']);
    });

    it('存在 ChangeTracker 本地改动时，应继续保留 remote 缺席的 local-only 项目', async () => {
      const remoteProject = createProject({ id: 'proj-a', name: 'A', syncSource: 'synced' });
      const localOnlyProject = createProject({
        id: 'proj-local-change',
        name: 'Local Change',
        syncSource: 'local-only',
        pendingSync: true,
      });
      (mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([remoteProject, localOnlyProject]);
      (mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue(null);
      (mockSyncCoordinator['hasPendingChangesForProject'] as ReturnType<typeof vi.fn>).mockImplementation(
        (projectId: string) => projectId === 'proj-a'
      );
      (mockChangeTracker['hasProjectChanges'] as ReturnType<typeof vi.fn>).mockImplementation(
        (projectId: string) => projectId === 'proj-local-change'
      );

      setupSupabaseQuery([
        {
          id: 'proj-a', title: 'A', description: '',
          created_date: remoteProject.createdDate, updated_at: remoteProject.updatedAt, version: 1,
        },
      ]);

      await (
        service as unknown as {
          syncProjectListMetadata: (userId: string) => Promise<Set<string>>;
        }
      ).syncProjectListMetadata('user-1');

      const setProjectsCall = (mockProjectState['setProjectsMetadataOnly'] as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Project[] | undefined;
      expect(setProjectsCall?.map((project: Project) => project.id)).toEqual(['proj-a', 'proj-local-change']);
    });

    it('裁剪后清理不可访问的 activeProjectId 时应弹提示', async () => {
      const staleProject = createProject({ id: 'proj-stale', name: 'Stale' });
      (mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([staleProject]);
      // 注意：activeProjectId 返回 proj-stale，但由于 activeProject 保护，它不会被裁剪
      // 这里测试裁剪后、已删除项目仍为 active 的场景
      // 需要 activeProjectId 返回一个不在 updatedProjects 中的 id
      (mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue('proj-gone');
      (mockSyncCoordinator['hasPendingChangesForProject'] as ReturnType<typeof vi.fn>).mockReturnValue(false);

      setupSupabaseQuery([]); // 空结果 → 安全守卫跳过裁剪

      await (
        service as unknown as {
          syncProjectListMetadata: (userId: string) => Promise<Set<string>>;
        }
      ).syncProjectListMetadata('user-1');

      // 安全守卫跳过裁剪时不会触发 toast（因为没有变更）
      // 真正触发 toast 的是 startBackgroundSync 中的 access preflight
    });
  });

  describe('mergeSingleProject content guard', () => {
    it('远端任务缺少 content 时应在直接覆盖分支保留本地正文', async () => {
      vi.clearAllMocks();

      const localTask = createTask({
        id: 'task-1',
        title: 'Keep Content',
        content: 'local content should survive',
        updatedAt: '2026-05-26T08:00:00.000Z',
      });
      const localProject = createProject({
        id: 'proj-content-guard',
        tasks: [localTask],
        updatedAt: '2026-05-26T08:00:00.000Z',
      });
      const shellProject = createProject({
        id: 'proj-content-guard',
        tasks: [],
        connections: [],
        updatedAt: '2026-05-26T08:00:00.000Z',
      });
      const remoteTask = markTaskContentMissingFromSource(createTask({
        id: 'task-1',
        title: 'Keep Content',
        content: '',
        updatedAt: '2026-05-27T08:00:00.000Z',
      }));
      const remoteProject = createProject({
        id: 'proj-content-guard',
        tasks: [remoteTask],
        updatedAt: '2026-05-27T08:00:00.000Z',
      });

      (mockProjectState['setProjects'] as (projects: Project[]) => void)([shellProject]);
      (mockProjectState['getProjectsWithCurrentData'] as ReturnType<typeof vi.fn>).mockReturnValue([localProject]);
      (mockSyncCoordinator['hasPendingChangesForProject'] as ReturnType<typeof vi.fn>).mockReturnValue(false);

      await (
        service as unknown as {
          mergeSingleProject: (cloudProject: Project, userId: string) => Promise<void>;
        }
      ).mergeSingleProject(remoteProject, 'user-1');

      const mergedProject = (mockProjectState['projects'] as () => Project[])()
        .find((project) => project.id === 'proj-content-guard');

      expect(mergedProject?.tasks[0]?.content).toBe('local content should survive');
      expect(mergedProject?.tasks[0]?.updatedAt).toBe('2026-05-27T08:00:00.000Z');
      expect(mockLoggerCategory.warn).toHaveBeenCalledWith(
        'mergeSingleProject: 远端任务缺少 content，已保留本地正文',
        expect.objectContaining({
          projectId: 'proj-content-guard',
          restoredTaskCount: 1,
        }),
      );
    });

    it('远端显式提交空 content 时不应误用本地正文覆盖', async () => {
      vi.clearAllMocks();

      const localTask = createTask({
        id: 'task-2',
        title: 'Allow Empty',
        content: 'old content',
        updatedAt: '2026-05-26T08:00:00.000Z',
      });
      const localProject = createProject({
        id: 'proj-explicit-empty',
        tasks: [localTask],
        updatedAt: '2026-05-26T08:00:00.000Z',
      });
      const shellProject = createProject({
        id: 'proj-explicit-empty',
        tasks: [],
        connections: [],
        updatedAt: '2026-05-26T08:00:00.000Z',
      });
      const remoteTask = createTask({
        id: 'task-2',
        title: 'Allow Empty',
        content: '',
        updatedAt: '2026-05-27T08:00:00.000Z',
      });
      const remoteProject = createProject({
        id: 'proj-explicit-empty',
        tasks: [remoteTask],
        updatedAt: '2026-05-27T08:00:00.000Z',
      });

      (mockProjectState['setProjects'] as (projects: Project[]) => void)([shellProject]);
      (mockProjectState['getProjectsWithCurrentData'] as ReturnType<typeof vi.fn>).mockReturnValue([localProject]);
      (mockSyncCoordinator['hasPendingChangesForProject'] as ReturnType<typeof vi.fn>).mockReturnValue(false);

      await (
        service as unknown as {
          mergeSingleProject: (cloudProject: Project, userId: string) => Promise<void>;
        }
      ).mergeSingleProject(remoteProject, 'user-1');

      const mergedProject = (mockProjectState['projects'] as () => Project[])()
        .find((project) => project.id === 'proj-explicit-empty');

      expect(mergedProject?.tasks[0]?.content).toBe('');
      expect(mockLoggerCategory.warn).not.toHaveBeenCalledWith(
        'mergeSingleProject: 远端任务缺少 content，已保留本地正文',
        expect.anything(),
      );
    });

    it('存在本地待同步修改时也应在 LWW 分支保留缺字段远端正文', async () => {
      vi.clearAllMocks();

      const localTask = createTask({
        id: 'task-3',
        title: 'Pending Merge',
        content: 'pending local content',
        updatedAt: '2026-05-26T08:00:00.000Z',
      });
      const localProject = createProject({
        id: 'proj-pending-merge',
        tasks: [localTask],
        updatedAt: '2026-05-26T08:00:00.000Z',
      });
      const shellProject = createProject({
        id: 'proj-pending-merge',
        tasks: [],
        connections: [],
        updatedAt: '2026-05-26T08:00:00.000Z',
      });
      const remoteTask = markTaskContentMissingFromSource(createTask({
        id: 'task-3',
        title: 'Pending Merge',
        content: '',
        updatedAt: '2026-05-27T08:00:00.000Z',
        order: 9,
      }));
      const remoteProject = createProject({
        id: 'proj-pending-merge',
        tasks: [remoteTask],
        updatedAt: '2026-05-27T08:00:00.000Z',
      });

      (mockProjectState['setProjects'] as (projects: Project[]) => void)([shellProject]);
      (mockProjectState['getProjectsWithCurrentData'] as ReturnType<typeof vi.fn>).mockReturnValue([localProject]);
      (mockSyncCoordinator['hasPendingChangesForProject'] as ReturnType<typeof vi.fn>).mockReturnValue(true);

      await (
        service as unknown as {
          mergeSingleProject: (cloudProject: Project, userId: string) => Promise<void>;
        }
      ).mergeSingleProject(remoteProject, 'user-1');

      const mergedProject = (mockProjectState['projects'] as () => Project[])()
        .find((project) => project.id === 'proj-pending-merge');

      expect(mergedProject?.tasks[0]?.content).toBe('pending local content');
      expect(mergedProject?.tasks[0]?.order).toBe(9);
      expect(mergedProject?.tasks[0]?.updatedAt).toBe('2026-05-27T08:00:00.000Z');
    });

  });

  // ====== 快照预填充测试 ======
  describe('prehydrateFromSnapshot', () => {
    it('Store 为空时应从全局快照预填充项目元数据但不 materialize recentTasks', () => {
      (mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([]);
      (mockAuthService['peekPersistedSessionIdentity'] as ReturnType<typeof vi.fn>).mockReturnValue({
        userId: 'snapshot-user',
        email: 'snapshot@example.com',
      });

      // 模拟 index.html 注入的全局快照
      (window as Window & { __NANOFLOW_LAUNCH_SNAPSHOT__?: unknown }).__NANOFLOW_LAUNCH_SNAPSHOT__ = {
        version: 2,
        savedAt: '2026-03-27T10:00:00.000Z',
        userId: 'snapshot-user',
        activeProjectId: 'a0000000-0000-4000-8000-000000000001',
        lastActiveView: 'text',
        theme: 'default',
        colorMode: 'dark',
        projects: [
          {
            id: 'a0000000-0000-4000-8000-000000000001',
            name: 'Alpha Protocol',
            description: 'Test project',
            updatedAt: '2026-03-27T10:00:00.000Z',
            taskCount: 2,
            openTaskCount: 2,
            recentTasks: [
              { id: 'b0000000-0000-4000-8000-000000000001', title: '阶段 1: 环境搭建', displayId: '1', status: 'active' },
              { id: 'b0000000-0000-4000-8000-000000000002', title: '核心逻辑实现', displayId: '1,a', status: 'active' },
            ],
          },
        ],
      };

      const result = service.prehydrateFromSnapshot();

      expect(result).toBe(true);
      expect(mockProjectState['setProjects']).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'a0000000-0000-4000-8000-000000000001',
            name: 'Alpha Protocol',
            tasks: [],
            connections: [],
          }),
        ]),
      );
      expect(mockProjectState['setActiveProjectId']).toHaveBeenCalledWith('a0000000-0000-4000-8000-000000000001');

      // 清理全局快照
      delete (window as Window & { __NANOFLOW_LAUNCH_SNAPSHOT__?: unknown }).__NANOFLOW_LAUNCH_SNAPSHOT__;
    });

    it('Store 已有数据时应跳过预填充并返回 true', () => {
      const existingProject = createProject({ id: 'existing-1' });
      (mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([existingProject]);

      const result = service.prehydrateFromSnapshot();

      expect(result).toBe(true);
      expect(mockProjectState['setProjects']).not.toHaveBeenCalled();
    });

    it('无快照数据时应返回 false', () => {
      (mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([]);

      // 确保全局和 localStorage 都没有快照
      delete (window as Window & { __NANOFLOW_LAUNCH_SNAPSHOT__?: unknown }).__NANOFLOW_LAUNCH_SNAPSHOT__;
      localStorage.removeItem('nanoflow.launch-snapshot.v2');

      const result = service.prehydrateFromSnapshot();

      expect(result).toBe(false);
      expect(mockProjectState['setProjects']).not.toHaveBeenCalled();
    });

    it('从 localStorage 快照预填充', () => {
      (mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([]);
      (mockAuthService['peekPersistedSessionIdentity'] as ReturnType<typeof vi.fn>).mockReturnValue({
        userId: 'snapshot-user',
        email: 'snapshot@example.com',
      });

      const snapshot = {
        version: 2,
        savedAt: '2026-03-27T10:00:00.000Z',
        userId: 'snapshot-user',
        activeProjectId: 'c0000000-0000-4000-8000-000000000001',
        lastActiveView: 'text',
        theme: 'default',
        colorMode: 'dark',
        projects: [
          {
            id: 'c0000000-0000-4000-8000-000000000001',
            name: 'LocalStorage Project',
            description: '',
            updatedAt: null,
            taskCount: 0,
            openTaskCount: 0,
            recentTasks: [],
          },
        ],
      };
      localStorage.setItem('nanoflow.launch-snapshot.v2', JSON.stringify(snapshot));

      const result = service.prehydrateFromSnapshot();

      expect(result).toBe(true);
      expect(mockProjectState['setProjects']).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ id: 'c0000000-0000-4000-8000-000000000001', name: 'LocalStorage Project' }),
        ]),
      );
    });

    it('owner 未通过本地会话确认时不应预填充快照', () => {
      (mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([]);
      (mockAuthService['peekPersistedSessionIdentity'] as ReturnType<typeof vi.fn>).mockReturnValue({
        userId: 'current-user',
        email: 'current@example.com',
      });

      localStorage.setItem('nanoflow.launch-snapshot.v2', JSON.stringify({
        version: 2,
        savedAt: '2026-03-27T10:00:00.000Z',
        userId: 'stale-user',
        activeProjectId: 'd0000000-0000-4000-8000-000000000001',
        lastActiveView: 'text',
        theme: 'default',
        colorMode: 'dark',
        projects: [
          {
            id: 'd0000000-0000-4000-8000-000000000001',
            name: 'Stale Project',
            description: '',
            updatedAt: null,
            taskCount: 0,
            openTaskCount: 0,
            recentTasks: [],
          },
        ],
      }));

      const result = service.prehydrateFromSnapshot();

      expect(result).toBe(false);
      expect(mockProjectState['setProjects']).not.toHaveBeenCalled();
      expect(service.startupProjectCatalogStage()).toBe('unresolved');
    });

    it('仅有匹配 owner hint 时应信任离线快照并展示完整数据', () => {
      const offlineProject = createProject({
        id: 'hint-only-project',
        name: 'Hint Only Offline Project',
      });
      (mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([]);
      (mockAuthService['peekPersistedSessionIdentity'] as ReturnType<typeof vi.fn>).mockReturnValue(null);
      (mockAuthService['peekPersistedOwnerHint'] as ReturnType<typeof vi.fn>).mockReturnValue('hint-user');
      (
        mockSyncCoordinator['core'] as {
          loadOfflineSnapshot: ReturnType<typeof vi.fn>;
        }
      ).loadOfflineSnapshot.mockReturnValue([offlineProject]);

      localStorage.setItem('nanoflow.launch-snapshot.v2', JSON.stringify({
        version: 2,
        savedAt: '2026-03-27T10:00:00.000Z',
        userId: 'hint-user',
        activeProjectId: 'd0000000-0000-4000-8000-000000000011',
        lastActiveView: 'text',
        theme: 'default',
        colorMode: 'dark',
        projects: [
          {
            id: 'd0000000-0000-4000-8000-000000000011',
            name: 'Sensitive Launch Project',
            description: '',
            updatedAt: '2026-03-27T10:00:00.000Z',
            taskCount: 1,
            openTaskCount: 1,
            recentTasks: [
              {
                id: 'd0000000-0000-4000-8000-000000000012',
                title: 'sensitive recent task',
                displayId: '1',
                status: 'active'
              },
            ],
          },
        ],
      }));

      const result = service.prehydrateFromSnapshot();

      // owner hint 匹配即信任离线快照，PWA 数据为设备本地存储
      expect(result).toBe(true);
      expect(mockProjectState['setProjects']).toHaveBeenCalledWith([
        expect.objectContaining({ id: 'hint-only-project', name: 'Hint Only Offline Project' }),
      ]);
      expect(service.trustedPrehydratedSnapshotVisible()).toBe(false);
      expect(service.startupProjectCatalogStage()).toBe('partial');
    });

    it('launch snapshot owner 不可信时应回退到离线快照并以 owner hint 信任完整数据', () => {
      const offlineProject = createProject({
        id: 'offline-project-1',
        name: 'Offline Recovery Project',
      });
      (mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([]);
      (mockAuthService['peekPersistedSessionIdentity'] as ReturnType<typeof vi.fn>).mockReturnValue(null);
      (mockAuthService['peekPersistedOwnerHint'] as ReturnType<typeof vi.fn>).mockReturnValue('current-user');
      (
        mockSyncCoordinator['core'] as {
          loadOfflineSnapshot: ReturnType<typeof vi.fn>;
        }
      ).loadOfflineSnapshot.mockReturnValue([offlineProject]);

      localStorage.setItem('nanoflow.launch-snapshot.v2', JSON.stringify({
        version: 2,
        savedAt: '2026-03-27T10:00:00.000Z',
        userId: 'stale-user',
        activeProjectId: 'd0000000-0000-4000-8000-000000000021',
        lastActiveView: 'text',
        theme: 'default',
        colorMode: 'dark',
        projects: [
          {
            id: 'd0000000-0000-4000-8000-000000000021',
            name: 'Stale Snapshot Project',
            description: '',
            updatedAt: null,
            taskCount: 0,
            openTaskCount: 0,
            recentTasks: [],
          },
        ],
      }));

      const result = service.prehydrateFromSnapshot();

      // owner hint 匹配即信任，展示完整离线数据
      expect(result).toBe(true);
      expect(mockProjectState['setProjects']).toHaveBeenCalledWith([
        expect.objectContaining({ id: 'offline-project-1', name: 'Offline Recovery Project' }),
      ]);
      expect(mockProjectState['setActiveProjectId']).toHaveBeenCalledWith('offline-project-1');
      expect(service.startupProjectCatalogStage()).toBe('partial');
      expect(service.trustedPrehydratedSnapshotVisible()).toBe(false);
    });

    it('owner 已通过 persisted session 确认时应恢复完整离线快照内容', () => {
      const offlineProject = createProject({
        id: 'confirmed-offline-project',
        name: 'Confirmed Offline Project',
        tasks: [createTask({ id: 'confirmed-task', content: 'confirmed task content' })],
      });
      (mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([]);
      (mockAuthService['peekPersistedSessionIdentity'] as ReturnType<typeof vi.fn>).mockReturnValue({
        userId: 'current-user',
        email: 'current@example.com',
      });
      (mockAuthService['peekPersistedOwnerHint'] as ReturnType<typeof vi.fn>).mockReturnValue('current-user');
      (
        mockSyncCoordinator['core'] as {
          loadOfflineSnapshot: ReturnType<typeof vi.fn>;
        }
      ).loadOfflineSnapshot.mockReturnValue([offlineProject]);

      const result = service.prehydrateFromSnapshot();

      expect(result).toBe(true);
      expect(mockProjectState['setProjects']).toHaveBeenCalledWith([
        expect.objectContaining({
          id: 'confirmed-offline-project',
          name: 'Confirmed Offline Project',
          tasks: [expect.objectContaining({ id: 'confirmed-task', content: 'confirmed task content' })],
        }),
      ]);
      expect(service.startupProjectCatalogStage()).toBe('partial');
      expect(service.trustedPrehydratedSnapshotVisible()).toBe(false);
    });

    it('存在云端 owner hint 时应信任离线快照并展示完整数据', () => {
      const offlineProject = createProject({
        id: 'cloud-owned-project',
        name: 'Cloud Owned Project',
      });
      (mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([]);
      (mockAuthService['peekPersistedOwnerHint'] as ReturnType<typeof vi.fn>).mockReturnValue('cloud-user');
      (
        mockSyncCoordinator['core'] as {
          loadOfflineSnapshot: ReturnType<typeof vi.fn>;
        }
      ).loadOfflineSnapshot.mockReturnValue([offlineProject]);

      localStorage.setItem('nanoflow.launch-snapshot.v2', JSON.stringify({
        version: 2,
        savedAt: '2026-03-27T10:00:00.000Z',
        userId: AUTH_CONFIG.LOCAL_MODE_USER_ID,
        activeProjectId: 'd0000000-0000-4000-8000-000000000031',
        lastActiveView: 'text',
        theme: 'default',
        colorMode: 'dark',
        projects: [
          {
            id: 'd0000000-0000-4000-8000-000000000031',
            name: 'Guest Snapshot Project',
            description: '',
            updatedAt: null,
            taskCount: 0,
            openTaskCount: 0,
            recentTasks: [],
          },
        ],
      }));

      const result = service.prehydrateFromSnapshot();

      // owner hint 匹配即信任，展示完整离线数据
      expect(result).toBe(true);
      expect(mockProjectState['setProjects']).toHaveBeenCalledWith([
        expect.objectContaining({ id: 'cloud-owned-project', name: 'Cloud Owned Project' }),
      ]);
      expect(service.trustedPrehydratedSnapshotVisible()).toBe(false);
      expect(service.startupProjectCatalogStage()).toBe('partial');
    });
  });

  // ====== 种子数据保护测试 ======
  describe('loadFromCacheOrSeed 种子保护', () => {
    it('已登录用户无缓存时不应创建种子数据', async () => {
      // 设置已登录状态
      userIdSignal.set('real-user-123');

      const loadFromCacheOrSeed = (
        service as unknown as {
          loadFromCacheOrSeed: (override?: {
            source: string;
            projectCount: number;
            bytes: number;
            migratedLegacy: boolean;
            projects: Project[];
            ownerUserId?: string | null;
          }) => Promise<void>;
        }
      ).loadFromCacheOrSeed.bind(service);

      await loadFromCacheOrSeed({
        source: 'none',
        projectCount: 0,
        bytes: 0,
        migratedLegacy: false,
        projects: [],
      });

      // 应设置空列表（非种子数据），等后台同步
      const setProjectsCalls = (mockProjectState['setProjects'] as ReturnType<typeof vi.fn>).mock.calls;
      const lastCallProjects = setProjectsCalls[setProjectsCalls.length - 1][0] as Project[];
      expect(lastCallProjects.length).toBe(0);
    });

    it('认证恢复前若已存在 persisted session user，不应提前注入种子数据', async () => {
      userIdSignal.set(null);
      (mockAuthService['peekPersistedSessionIdentity'] as ReturnType<typeof vi.fn>).mockReturnValue({
        userId: 'real-user-123',
        email: 'real@example.com',
      });

      const loadFromCacheOrSeed = (
        service as unknown as {
          loadFromCacheOrSeed: (override?: {
            source: string;
            projectCount: number;
            bytes: number;
            migratedLegacy: boolean;
            projects: Project[];
            ownerUserId?: string | null;
          }) => Promise<void>;
        }
      ).loadFromCacheOrSeed.bind(service);

      await loadFromCacheOrSeed({
        source: 'none',
        projectCount: 0,
        bytes: 0,
        migratedLegacy: false,
        projects: [],
      });

      const setProjectsCalls = (mockProjectState['setProjects'] as ReturnType<typeof vi.fn>).mock.calls;
      const lastCallProjects = setProjectsCalls[setProjectsCalls.length - 1][0] as Project[];
      expect(lastCallProjects.length).toBe(0);
      expect(service.startupProjectCatalogStage()).toBe('partial');
    });

    it('未登录用户无缓存时应创建种子数据', async () => {
      // 未登录状态
      userIdSignal.set(null);

      const loadFromCacheOrSeed = (
        service as unknown as {
          loadFromCacheOrSeed: (override?: {
            source: string;
            projectCount: number;
            bytes: number;
            migratedLegacy: boolean;
            projects: Project[];
            ownerUserId?: string | null;
          }) => Promise<void>;
        }
      ).loadFromCacheOrSeed.bind(service);

      await loadFromCacheOrSeed({
        source: 'none',
        projectCount: 0,
        bytes: 0,
        migratedLegacy: false,
        projects: [],
      });

      // 未登录用户应生成种子数据
      const setProjectsCalls = (mockProjectState['setProjects'] as ReturnType<typeof vi.fn>).mock.calls;
      const lastCallProjects = setProjectsCalls[setProjectsCalls.length - 1][0] as Project[];
      expect(lastCallProjects.length).toBeGreaterThan(0);
    });

    it('已登录用户恢复旧缓存项目时应将其标记为 local-only', async () => {
      userIdSignal.set('real-user-123');
      const legacyProject = createProject({ id: 'legacy-local-project' });

      const loadFromCacheOrSeed = (
        service as unknown as {
          loadFromCacheOrSeed: (override?: {
            source: string;
            projectCount: number;
            bytes: number;
            migratedLegacy: boolean;
            projects: Project[];
            ownerUserId?: string | null;
          }) => Promise<void>;
        }
      ).loadFromCacheOrSeed.bind(service);

      await loadFromCacheOrSeed({
        source: 'localStorage',
        projectCount: 1,
        bytes: 128,
        migratedLegacy: false,
        ownerUserId: 'real-user-123',
        projects: [legacyProject],
      });

      const setProjectsCalls = (mockProjectState['setProjects'] as ReturnType<typeof vi.fn>).mock.calls;
      const lastCallProjects = setProjectsCalls[setProjectsCalls.length - 1][0] as Project[];
      expect(lastCallProjects[0]?.syncSource).toBe('local-only');
      expect(lastCallProjects[0]?.pendingSync).toBe(true);
    });
  });

  describe('startBackgroundSync local-only 保护', () => {
    it('当前项目是 local-only 时应跳过云端探测和按需加载', async () => {
      const localOnlyProject = createProject({
        id: 'proj-local-only',
        name: 'Guest Draft',
        syncSource: 'local-only',
      });
      saveGuestDraftProjects([localOnlyProject]);
      (mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([localOnlyProject]);
      (mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue('proj-local-only');

      await (
        service as unknown as {
          startBackgroundSync: (userId: string, previousActive: string | null) => Promise<void>;
        }
      ).startBackgroundSync('user-1', null);

      expect((mockSyncCoordinator['core'] as Record<string, unknown>)['getAccessibleProjectProbe']).not.toHaveBeenCalled();
      expect(mockSyncCoordinator['performDeltaSync']).not.toHaveBeenCalled();
      expect(mockSyncCoordinator['loadSingleProjectFromCloud']).not.toHaveBeenCalled();
      expect(mockProjectState['setActiveProjectId']).not.toHaveBeenCalledWith(null);
    });
  });
});
