import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DockEngineLifecycleService,
  type DockEngineLifecycleContext,
} from './dock-engine-lifecycle.service';
import { AuthService } from './auth.service';
import { FocusPreferenceService } from './focus-preference.service';
import { GateService } from './gate.service';
import { LoggerService } from './logger.service';
import { FocusAttentionService } from './focus-attention.service';
import { FocusHudWindowService } from './focus-hud-window.service';
import { DockSnapshotPersistenceService } from './dock-snapshot-persistence.service';
import { DockCloudSyncService } from './dock-cloud-sync.service';
import { DockCompletionFlowService } from './dock-completion-flow.service';
import { DockDailySlotService } from './dock-daily-slot.service';
import { DockFragmentRestService } from './dock-fragment-rest.service';
import { DockZoneService } from './dock-zone.service';
import { TaskStore } from '../core-bridge';
import { AUTH_CONFIG } from '../config/auth.config';
import type { DockEntry } from '../models/parking-dock';

const mockLoggerCategory = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const mockCloudSync = {
  cancelTimers: vi.fn(),
  seedFocusModeBaseline: vi.fn(),
  scheduleCloudPull: vi.fn(),
  scheduleCloudPush: vi.fn(),
};

const mockSnapshotPersistence = {
  restoreLocalSnapshot: vi.fn(),
  cancelPendingPersist: vi.fn(),
};

const mockFocusAttention = {
  updateBadge: vi.fn(),
  notify: vi.fn().mockResolvedValue(undefined),
};

const mockFocusHudWindow = {
  isActive: signal(false),
};

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });

  return { promise, resolve };
}

function createDockEntry(overrides: Partial<DockEntry> = {}): DockEntry {
  return {
    taskId: 'task-a',
    title: 'Task A',
    sourceProjectId: null,
    status: 'focusing',
    load: 'low',
    expectedMinutes: null,
    waitMinutes: null,
    waitStartedAt: null,
    lane: 'backup',
    zoneSource: 'manual',
    isMain: true,
    dockedOrder: 0,
    detail: '',
    sourceKind: 'dock-created',
    systemSelected: false,
    recommendedScore: null,
    ...overrides,
  };
}

async function flushEffects(): Promise<void> {
  await Promise.resolve();
  TestBed.flushEffects();
  await Promise.resolve();
}

function createContext(currentSnapshotUserId: string | null): DockEngineLifecycleContext & {
  __setPersistenceDeps: (deps: unknown[]) => void;
} {
  let currentUserId = currentSnapshotUserId;
  const entries = signal<DockEntry[]>([]);
  const focusMode = signal(false);
  const persistenceDeps = signal<unknown[]>([]);

  return {
    entries,
    focusMode,
    muteWaitTone: signal(false),
    pendingDecision: signal(null),
    highlightedIds: signal(new Set<string>()),
    editLock: signal(false),
    suspendRecommendationLocked: signal(false),
    suspendChainRootTaskId: signal(null),
    softLimitNoticeShown: signal(false),
    restoringSnapshot: signal(false),
    blankPeriodNotified: signal(false),
    fragmentCountdownNotified: signal(false),
    tick: signal(0),
    persistenceDeps: () => persistenceDeps(),
    dockedCount: () => 0,
    statusMachineEntries: () => [],
    pendingDecisionEntries: () => [],
    focusingEntry: () => null,
    fragmentEntryCountdown: () => null,
    waitEndNotifiedIds: new Set<string>(),
    getCurrentSnapshotUserId: () => currentUserId,
    setCurrentSnapshotUserId: (userId: string | null) => {
      currentUserId = userId;
    },
    exportSnapshot: () => ({
      version: 1,
      entries: entries(),
      focusMode: focusMode(),
      isDockExpanded: false,
      muteWaitTone: false,
      session: {
        firstDragIntervened: false,
        focusBlurOn: false,
        focusScrimOn: false,
        mainTaskId: null,
        comboSelectIds: [],
        backupIds: [],
      },
      dailySlots: [],
      suspendChainRootTaskId: null,
      suspendRecommendationLocked: false,
      pendingDecision: null,
      dailyResetDate: '2026-03-31',
      savedAt: '2026-03-31T00:00:00.000Z',
    }),
    restoreSnapshot: vi.fn(),
    reset: vi.fn(),
    reconcileExternallyCompletedTasks: vi.fn(),
    buildNormalizeContext: () => ({
      muteWaitTone: false,
      todayDateKey: '2026-03-31',
      buildOverflowMeta: () => ({ comboSelectOverflow: 0, backupOverflow: 0 }),
    }),
    getNonCriticalHoldDelay: () => 0,
    scheduleLocalPersist: vi.fn(),
    setSnapshotSavedAt: vi.fn(),
    __setPersistenceDeps: (deps: unknown[]) => persistenceDeps.set(deps),
  };
}

describe('DockEngineLifecycleService', () => {
  let service: DockEngineLifecycleService;
  let currentUserId: ReturnType<typeof signal<string | null>>;
  let persistedOwnerHint: ReturnType<typeof signal<string | null>>;
  let persistedSessionUserId: ReturnType<typeof signal<string | null>>;
  let authServiceMock: {
    currentUserId: typeof currentUserId;
    persistedOwnerHint: typeof persistedOwnerHint;
    persistedSessionUserId: typeof persistedSessionUserId;
    peekPersistedOwnerHint: ReturnType<typeof vi.fn>;
    peekPersistedSessionIdentity: ReturnType<typeof vi.fn>;
    isConfigured: boolean;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.removeItem(AUTH_CONFIG.LOCAL_MODE_CACHE_KEY);
    mockSnapshotPersistence.restoreLocalSnapshot.mockResolvedValue(null);
    mockCloudSync.seedFocusModeBaseline.mockClear();
    currentUserId = signal('user-a');
    persistedOwnerHint = signal<string | null>(null);
    persistedSessionUserId = signal<string | null>(null);
    mockFocusHudWindow.isActive.set(false);
    authServiceMock = {
      currentUserId,
      persistedOwnerHint,
      persistedSessionUserId,
      peekPersistedOwnerHint: vi.fn(() => persistedOwnerHint()),
      peekPersistedSessionIdentity: vi.fn(() => {
        const userId = persistedSessionUserId();
        return userId ? { userId, email: null } : null;
      }),
      isConfigured: true,
    };

    TestBed.configureTestingModule({
      providers: [
        DockEngineLifecycleService,
        {
          provide: AuthService,
          useValue: authServiceMock,
        },
        { provide: FocusPreferenceService, useValue: { preferences: vi.fn(() => ({ routineResetHourLocal: 0 })) } },
        { provide: GateService, useValue: {} },
        { provide: LoggerService, useValue: { category: () => mockLoggerCategory } },
        { provide: FocusAttentionService, useValue: mockFocusAttention },
        { provide: FocusHudWindowService, useValue: mockFocusHudWindow },
        { provide: DockSnapshotPersistenceService, useValue: mockSnapshotPersistence },
        { provide: DockCloudSyncService, useValue: mockCloudSync },
        { provide: DockCompletionFlowService, useValue: {} },
        { provide: DockDailySlotService, useValue: { resetDailySlotsIfNeeded: vi.fn() } },
        { provide: DockFragmentRestService, useValue: { resetAll: vi.fn() } },
        { provide: DockZoneService, useValue: {} },
        { provide: TaskStore, useValue: { tasksMap: vi.fn(() => new Map()) } },
      ],
    });

    service = TestBed.inject(DockEngineLifecycleService);
  });

  it('restoreLocalSnapshot 开始前应取消旧的 cloud sync timers', async () => {
    service.init(createContext('user-b'));

    await service.restoreLocalSnapshot('user-b');

    expect(mockCloudSync.cancelTimers).toHaveBeenCalledTimes(1);
    expect(mockSnapshotPersistence.cancelPendingPersist).toHaveBeenCalledTimes(1);
  });

  it('restoreLocalSnapshot 应把恢复出的 focusMode 种到云同步基线，保证首次关闭专注可直推 widget', async () => {
    const context = createContext('user-b');
    const restoredSnapshot = {
      ...context.exportSnapshot(),
      focusMode: true,
      savedAt: '2026-03-31T10:00:00.000Z',
      session: {
        ...context.exportSnapshot().session,
        focusSessionId: 'restored-focus-session',
        focusSessionStartedAt: 1774951200000,
        mainTaskId: 'task-main',
      },
    };
    mockSnapshotPersistence.restoreLocalSnapshot.mockResolvedValueOnce(restoredSnapshot);
    service.init(context);

    await service.restoreLocalSnapshot('user-b');

    expect(mockCloudSync.seedFocusModeBaseline).toHaveBeenCalledWith('user-b', restoredSnapshot);
    expect(context.restoreSnapshot).toHaveBeenCalledWith(restoredSnapshot);
  });

  it('空快照晚到时不应覆盖恢复窗口内新增的内存 Dock 状态', async () => {
    const context = createContext(null);
    const restore = createDeferred<null>();
    mockSnapshotPersistence.restoreLocalSnapshot.mockReturnValueOnce(restore.promise);
    service.init(context);

    service.restoreInitialSnapshot();
    await flushEffects();

    context.entries.set([createDockEntry()]);
    context.focusMode.set(true);
    context.__setPersistenceDeps(['dock-created-after-restore-start']);

    restore.resolve(null);
    await flushEffects();

    expect(context.reset).not.toHaveBeenCalled();
    expect(context.scheduleLocalPersist).toHaveBeenCalledWith(
      expect.objectContaining({ entries: [expect.objectContaining({ taskId: 'task-a' })], focusMode: true }),
      'user-a',
    );
    expect(mockCloudSync.scheduleCloudPush).toHaveBeenCalledWith(
      'user-a',
      expect.objectContaining({ entries: [expect.objectContaining({ taskId: 'task-a' })], focusMode: true }),
    );
  });

  it('owner 短暂未确认时不应清空活跃内存 Dock 状态，并在 owner 恢复后落盘', async () => {
    const context = createContext(null);
    currentUserId.set(null);
    context.entries.set([createDockEntry()]);
    context.focusMode.set(true);
    context.__setPersistenceDeps(['active-before-owner-confirmed']);
    service.init(context);

    TestBed.runInInjectionContext(() => {
      service.registerEffects();
    });
    await flushEffects();

    expect(context.reset).not.toHaveBeenCalled();
    expect(context.getCurrentSnapshotUserId()).toBeNull();

    currentUserId.set(AUTH_CONFIG.LOCAL_MODE_USER_ID);
    await flushEffects();

    expect(context.reset).not.toHaveBeenCalled();
    expect(context.scheduleLocalPersist).toHaveBeenCalledWith(
      expect.objectContaining({ entries: [expect.objectContaining({ taskId: 'task-a' })], focusMode: true }),
      AUTH_CONFIG.LOCAL_MODE_USER_ID,
    );
    expect(mockCloudSync.scheduleCloudPush).toHaveBeenCalledWith(
      AUTH_CONFIG.LOCAL_MODE_USER_ID,
      expect.objectContaining({ entries: [expect.objectContaining({ taskId: 'task-a' })], focusMode: true }),
    );
  });

  it('乱序完成的旧 restore 不应提前解锁 restoringSnapshot 或调度过期 cloud pull', async () => {
    const context = createContext('user-a');
    const restoreForB = createDeferred<null>();
    const restoreForC = createDeferred<null>();
    mockSnapshotPersistence.restoreLocalSnapshot.mockImplementation((userId: string | null) => {
      if (userId === 'user-b') {
        return restoreForB.promise;
      }

      if (userId === 'user-c') {
        return restoreForC.promise;
      }

      return Promise.resolve(null);
    });
    service.init(context);
    TestBed.runInInjectionContext(() => {
      service.registerEffects();
    });

    currentUserId.set('user-b');
    await flushEffects();
    currentUserId.set('user-c');
    await flushEffects();

    restoreForB.resolve(null);
    await flushEffects();

    expect(context.restoringSnapshot()).toBe(true);
    expect(mockCloudSync.scheduleCloudPull).not.toHaveBeenCalled();

    restoreForC.resolve(null);
    await flushEffects();

    expect(context.restoringSnapshot()).toBe(false);
    expect(mockCloudSync.scheduleCloudPull).toHaveBeenCalledTimes(1);
    expect(mockCloudSync.scheduleCloudPull).toHaveBeenCalledWith('user-c', true);
  });

  it('restoreInitialSnapshot 应在本地 restore 完成后才触发 idle cloud pull', async () => {
    const context = createContext('user-a');
    const initialRestore = createDeferred<null>();
    const hadRequestIdleCallback = 'requestIdleCallback' in window;
    const originalRequestIdleCallback = (window as Window & {
      requestIdleCallback?: (cb: () => void) => number;
    }).requestIdleCallback;
    let idleCallback: (() => void) | null = null;
    (window as Window & {
      requestIdleCallback?: (cb: () => void) => number;
    }).requestIdleCallback = vi.fn((cb: () => void) => {
      idleCallback = cb;
      return 1;
    });
    mockSnapshotPersistence.restoreLocalSnapshot.mockImplementationOnce(() => initialRestore.promise);
    service.init(context);

    try {
      service.restoreInitialSnapshot();
      await flushEffects();

      expect(mockCloudSync.scheduleCloudPull).not.toHaveBeenCalled();

      initialRestore.resolve(null);
      await flushEffects();

      expect(mockCloudSync.scheduleCloudPull).not.toHaveBeenCalled();
      expect(idleCallback).not.toBeNull();

      idleCallback!();

      expect(mockCloudSync.scheduleCloudPull).toHaveBeenCalledTimes(1);
      expect(mockCloudSync.scheduleCloudPull).toHaveBeenCalledWith('user-a', true);
    } finally {
      if (hadRequestIdleCallback) {
        (window as Window & {
          requestIdleCallback?: (cb: () => void) => number;
        }).requestIdleCallback = originalRequestIdleCallback;
      } else {
        delete (window as unknown as { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
      }
    }
  });

  it('恢复期水化的 Dock 状态在解锁后不应作为本地新状态回写云端', async () => {
    const context = createContext('user-a') as DockEngineLifecycleContext & {
      __setPersistenceDeps: (deps: unknown[]) => void;
    };
    service.init(context);

    TestBed.runInInjectionContext(() => {
      service.registerEffects();
    });
    await flushEffects();

    vi.mocked(context.scheduleLocalPersist).mockClear();
    mockCloudSync.scheduleCloudPush.mockClear();

    context.restoringSnapshot.set(true);
    context.__setPersistenceDeps(['restored-widget-order']);
    await flushEffects();

    expect(context.scheduleLocalPersist).not.toHaveBeenCalled();
    expect(mockCloudSync.scheduleCloudPush).not.toHaveBeenCalled();

    context.restoringSnapshot.set(false);
    await flushEffects();

    expect(context.scheduleLocalPersist).not.toHaveBeenCalled();
    expect(mockCloudSync.scheduleCloudPush).not.toHaveBeenCalled();
  });

  it('restoreInitialSnapshot 在只有 owner hint 时不应恢复真实 Dock 快照', async () => {
    const context = createContext(null);
    currentUserId.set(null);
    persistedOwnerHint.set('user-hint');
    service.init(context);

    service.restoreInitialSnapshot();
    await flushEffects();

    expect(mockSnapshotPersistence.restoreLocalSnapshot).not.toHaveBeenCalled();
  });

  it('无 confirmed owner 时 restoreInitialSnapshot 不应恢复 anonymous Dock 快照', async () => {
    const context = createContext(null);
    currentUserId.set(null);
    service.init(context);

    service.restoreInitialSnapshot();
    await flushEffects();

    expect(mockSnapshotPersistence.restoreLocalSnapshot).not.toHaveBeenCalled();
    expect(context.getCurrentSnapshotUserId()).toBeNull();
    expect(context.reset).toHaveBeenCalled();
  });

  it('仅有 owner hint 时 registerEffects 不应恢复任何真实快照', async () => {
    const context = createContext('user-hint');
    currentUserId.set(null);
    persistedOwnerHint.set('user-hint');
    service.init(context);

    TestBed.runInInjectionContext(() => {
      service.registerEffects();
    });
    await flushEffects();

    expect(mockSnapshotPersistence.restoreLocalSnapshot).not.toHaveBeenCalled();
    expect(context.getCurrentSnapshotUserId()).toBeNull();
  });

  it('仅有 owner hint 时 registerEffects 也不应向 anonymous bucket 落盘', async () => {
    const context = createContext(null);
    currentUserId.set(null);
    persistedOwnerHint.set('user-hint');
    service.init(context);

    TestBed.runInInjectionContext(() => {
      service.registerEffects();
    });
    await flushEffects();

    expect(context.scheduleLocalPersist).not.toHaveBeenCalled();
    expect(mockCloudSync.scheduleCloudPush).not.toHaveBeenCalled();
    expect(mockSnapshotPersistence.cancelPendingPersist).toHaveBeenCalled();
    expect(mockCloudSync.cancelTimers).toHaveBeenCalled();
  });

  it('persisted owner hint 被清空后应保持空态而不是恢复真实快照', async () => {
    const context = createContext('user-hint');
    currentUserId.set(null);
    persistedOwnerHint.set('user-hint');
    service.init(context);

    TestBed.runInInjectionContext(() => {
      service.registerEffects();
    });
    await flushEffects();

    mockSnapshotPersistence.restoreLocalSnapshot.mockClear();
    persistedOwnerHint.set(null);
    await flushEffects();

    expect(mockSnapshotPersistence.restoreLocalSnapshot).not.toHaveBeenCalled();
    expect(context.getCurrentSnapshotUserId()).toBeNull();
  });

  it('session invalidated 后 registerEffects 不应恢复或落盘 anonymous bucket', async () => {
    const context = createContext('user-a');
    service.init(context);

    TestBed.runInInjectionContext(() => {
      service.registerEffects();
    });
    await flushEffects();

    mockSnapshotPersistence.restoreLocalSnapshot.mockClear();
    mockSnapshotPersistence.cancelPendingPersist.mockClear();
    mockCloudSync.cancelTimers.mockClear();
    mockCloudSync.scheduleCloudPush.mockClear();
    vi.mocked(context.scheduleLocalPersist).mockClear();
    currentUserId.set(null);
    await flushEffects();

    expect(mockSnapshotPersistence.restoreLocalSnapshot).not.toHaveBeenCalled();
    expect(context.scheduleLocalPersist).not.toHaveBeenCalled();
    expect(mockCloudSync.scheduleCloudPush).not.toHaveBeenCalled();
    expect(mockSnapshotPersistence.cancelPendingPersist).toHaveBeenCalled();
    expect(mockCloudSync.cancelTimers).toHaveBeenCalled();
    expect(context.getCurrentSnapshotUserId()).toBeNull();
    expect(context.reset).toHaveBeenCalled();
  });

  it('存在 confirmed persisted session user 时应恢复对应 owner 的 Dock 快照', async () => {
    const context = createContext(null);
    currentUserId.set(null);
    persistedOwnerHint.set('user-hint');
    persistedSessionUserId.set('user-confirmed');
    service.init(context);

    service.restoreInitialSnapshot();
    await flushEffects();

    expect(mockSnapshotPersistence.restoreLocalSnapshot).toHaveBeenCalledWith(
      'user-confirmed',
      expect.any(Object),
    );
  });

  it('存在 confirmed persisted session user 时不应被 local mode 标志抢占为 local-user', async () => {
    const context = createContext(null);
    currentUserId.set(null);
    persistedSessionUserId.set('user-confirmed');
    localStorage.setItem(AUTH_CONFIG.LOCAL_MODE_CACHE_KEY, 'true');
    service.init(context);

    service.restoreInitialSnapshot();
    await flushEffects();

    expect(mockSnapshotPersistence.restoreLocalSnapshot).toHaveBeenCalledWith(
      'user-confirmed',
      expect.any(Object),
    );
  });

  it('本地模式下应恢复 local-user 的 Dock 快照而不是 anonymous bucket', async () => {
    const context = createContext(null);
    currentUserId.set(null);
    localStorage.setItem(AUTH_CONFIG.LOCAL_MODE_CACHE_KEY, 'true');
    service.init(context);

    service.restoreInitialSnapshot();
    await flushEffects();

    expect(mockSnapshotPersistence.restoreLocalSnapshot).toHaveBeenCalledWith(
      AUTH_CONFIG.LOCAL_MODE_USER_ID,
      expect.any(Object),
    );
  });

  it('纯离线配置下应恢复 local-user 的 Dock 快照', async () => {
    const context = createContext(null);
    currentUserId.set(null);
    authServiceMock.isConfigured = false;
    service.init(context);

    service.restoreInitialSnapshot();
    await flushEffects();

    expect(mockSnapshotPersistence.restoreLocalSnapshot).toHaveBeenCalledWith(
      AUTH_CONFIG.LOCAL_MODE_USER_ID,
      expect.any(Object),
    );
  });
});
