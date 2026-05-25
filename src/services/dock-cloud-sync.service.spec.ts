import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DockCloudSyncService, type CloudSyncEngineCallbacks } from './dock-cloud-sync.service';
import { SimpleSyncService } from '../core-bridge';
import { ActionQueueService } from './action-queue.service';
import { DockSnapshotPersistenceService } from './dock-snapshot-persistence.service';
import { LoggerService } from './logger.service';
import { SupabaseClientService } from './supabase-client.service';
import type { DockSnapshot } from '../models/parking-dock';
import { AUTH_CONFIG } from '../config/auth.config';
import { TIMEOUT_CONFIG } from '../config/timeout.config';
import {
  ensureBrowserNetworkSuspensionTracking,
  resetBrowserNetworkSuspensionTrackingForTests,
} from '../utils/browser-network-suspension';

// ─── Mocks ──────────────────────────────────

const mockLoggerCategory = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const mockLogger = {
  category: vi.fn(() => mockLoggerCategory),
};

const mockSyncService = {
  loadFocusSession: vi.fn().mockResolvedValue(null),
  listRoutineTasks: vi.fn().mockResolvedValue([]),
  importLegacyDockSnapshot: vi.fn().mockResolvedValue(null),
};

const mockActionQueue = {
  enqueue: vi.fn(() => crypto.randomUUID()),
  enqueueForOwner: vi.fn(() => Promise.resolve(crypto.randomUUID())),
};

const mockSnapshotPersistence = {
  normalizeSnapshot: vi.fn(),
  isSnapshotNewer: vi.fn(),
};

const mockFunctionsInvoke = vi.fn().mockResolvedValue({ data: null, error: null });
const mockSupabaseClient = {
  clientAsync: vi.fn().mockResolvedValue({
    functions: {
      invoke: mockFunctionsInvoke,
    },
  }),
};

function setVisibilityState(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: state,
  });
}

// ─── Helpers ────────────────────────────────

function makeSnapshot(overrides?: Partial<DockSnapshot>): DockSnapshot {
  return {
    version: 1,
    entries: [],
    focusMode: false,
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
    dailyResetDate: '2025-01-01',
    savedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeCallbacks(overrides?: Partial<CloudSyncEngineCallbacks>): CloudSyncEngineCallbacks {
  return {
    exportSnapshot: vi.fn(() => makeSnapshot()),
    restoreSnapshot: vi.fn(),
    scheduleLocalPersist: vi.fn(),
    updateDailySlots: vi.fn(),
    getNonCriticalHoldDelay: vi.fn(() => 0),
    getFocusSessionContext: vi.fn(() => ({ id: 'session-1', startedAt: Date.now() })),
    setFocusSessionContext: vi.fn(),
    buildNormalizeContext: vi.fn(() => ({
      muteWaitTone: false,
      todayDateKey: '2025-01-01',
      buildOverflowMeta: () => ({ comboSelectOverflow: 0, backupOverflow: 0 }),
    })),
    getCurrentSnapshotUserId: vi.fn(() => null),
    ...overrides,
  };
}

// ─── Test Suite ─────────────────────────────

describe('DockCloudSyncService', () => {
  let service: DockCloudSyncService;

  beforeEach(() => {
    vi.useFakeTimers();
    resetBrowserNetworkSuspensionTrackingForTests();
    ensureBrowserNetworkSuspensionTracking();
    setVisibilityState('visible');

    mockActionQueue.enqueue.mockClear();
    mockActionQueue.enqueueForOwner.mockClear();
    mockSyncService.loadFocusSession.mockClear();
    mockSyncService.listRoutineTasks.mockClear();
    mockSyncService.importLegacyDockSnapshot.mockClear();
    mockSnapshotPersistence.normalizeSnapshot.mockClear();
    mockSnapshotPersistence.isSnapshotNewer.mockClear();
    mockLoggerCategory.warn.mockClear();
    mockLoggerCategory.debug.mockClear();
    mockSupabaseClient.clientAsync.mockClear();
    mockFunctionsInvoke.mockClear();
    mockFunctionsInvoke.mockResolvedValue({ data: null, error: null });

    TestBed.configureTestingModule({
      providers: [
        DockCloudSyncService,
        { provide: SimpleSyncService, useValue: mockSyncService },
        { provide: ActionQueueService, useValue: mockActionQueue },
        { provide: DockSnapshotPersistenceService, useValue: mockSnapshotPersistence },
        { provide: LoggerService, useValue: mockLogger },
        { provide: SupabaseClientService, useValue: mockSupabaseClient },
      ],
    });

    service = TestBed.inject(DockCloudSyncService);
  });

  afterEach(() => {
    service.cancelTimers();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    resetBrowserNetworkSuspensionTrackingForTests();
    setVisibilityState('visible');
  });

  // ─── init ───────────────────────────────────

  describe('init', () => {
    it('should store callbacks so subsequent operations work', () => {
      const callbacks = makeCallbacks();
      service.init(callbacks);

      // Verify callbacks are stored by triggering an operation that uses them.
      // scheduleCloudPush returns early when callbacks are null.
      const snapshot = makeSnapshot();
      service.scheduleCloudPush('user-1', snapshot);

      // Advance past debounce (CLOUD_PUSH_DEBOUNCE_MS = SYNC_CONFIG.DEBOUNCE_DELAY = 3000)
      vi.advanceTimersByTime(3000);

      // If callbacks were stored, owner-scoped enqueue would have been called
      expect(mockActionQueue.enqueueForOwner).toHaveBeenCalled();
    });

    it('should not trigger cloud push when init was never called', () => {
      // Do NOT call init — callbacks remain null
      const snapshot = makeSnapshot();
      service.scheduleCloudPush('user-1', snapshot);

      vi.advanceTimersByTime(5000);

      expect(mockActionQueue.enqueueForOwner).not.toHaveBeenCalled();
    });
  });

  // ─── cancelTimers ───────────────────────────

  describe('cancelTimers', () => {
    it('should clear pending cloud push timer', () => {
      service.init(makeCallbacks());
      service.scheduleCloudPush('user-1', makeSnapshot());

      // Timer is pending but not yet fired
      service.cancelTimers();
      vi.advanceTimersByTime(5000);

      expect(mockActionQueue.enqueueForOwner).not.toHaveBeenCalled();
    });

    it('should clear pending cloud pull timer', () => {
      service.init(makeCallbacks());
      service.scheduleCloudPull('user-1', true);

      service.cancelTimers();
      vi.advanceTimersByTime(5000);

      expect(mockSyncService.loadFocusSession).not.toHaveBeenCalled();
    });

    it('should be safe to call when no timers are pending', () => {
      expect(() => service.cancelTimers()).not.toThrow();
    });

    it('should reset cloud pull circuit breaker so owner switch can force a new pull', async () => {
      service.init(makeCallbacks());
      mockSyncService.loadFocusSession.mockRejectedValueOnce({ status: 401, message: 'unauthorized' });

      service.scheduleCloudPull('user-1', true);
      await vi.advanceTimersByTimeAsync(250);
      expect(mockSyncService.loadFocusSession).toHaveBeenCalledTimes(1);

      service.cancelTimers();

      mockSyncService.loadFocusSession.mockResolvedValueOnce({ ok: true, value: null });
      mockSyncService.listRoutineTasks.mockResolvedValueOnce({ ok: true, value: [] });

      service.scheduleCloudPull('user-1', true);
      await vi.advanceTimersByTimeAsync(250);

      expect(mockSyncService.loadFocusSession).toHaveBeenCalledTimes(2);
    });
  });

  // ─── scheduleCloudPush ──────────────────────

  describe('scheduleCloudPush', () => {
    it('should skip cloud push scheduling for local-user', () => {
      const callbacks = makeCallbacks();
      service.init(callbacks);

      service.scheduleCloudPush(AUTH_CONFIG.LOCAL_MODE_USER_ID, makeSnapshot());
      vi.advanceTimersByTime(5000);

      expect(callbacks.scheduleLocalPersist).not.toHaveBeenCalled();
      expect(mockActionQueue.enqueueForOwner).not.toHaveBeenCalled();
    });

    it('should debounce: calling twice quickly triggers enqueue only once', () => {
      const callbacks = makeCallbacks();
      service.init(callbacks);

      service.scheduleCloudPush('user-1', makeSnapshot());
      vi.advanceTimersByTime(1000); // partial advance, timer not yet fired
      service.scheduleCloudPush('user-1', makeSnapshot());

      // Now advance past the full debounce from the second call
      vi.advanceTimersByTime(3000);

      expect(mockActionQueue.enqueueForOwner).toHaveBeenCalledTimes(1);
    });

    it('should fire after debounce delay elapses', () => {
      service.init(makeCallbacks());
      service.scheduleCloudPush('user-1', makeSnapshot());

      // Not yet
      vi.advanceTimersByTime(2999);
      expect(mockActionQueue.enqueueForOwner).not.toHaveBeenCalled();

      // Now
      vi.advanceTimersByTime(1);
      expect(mockActionQueue.enqueueForOwner).toHaveBeenCalledTimes(1);
    });

    it('should defer when getNonCriticalHoldDelay returns positive value', () => {
      let holdDelay = 500;
      const callbacks = makeCallbacks({
        getNonCriticalHoldDelay: vi.fn(() => {
          const d = holdDelay;
          holdDelay = 0; // next call returns 0 so push proceeds
          return d;
        }),
      });
      service.init(callbacks);
      service.scheduleCloudPush('user-1', makeSnapshot());

      // Advance past initial debounce
      vi.advanceTimersByTime(3000);
      // holdDelay was 500, so enqueue should not fire yet
      expect(mockActionQueue.enqueueForOwner).not.toHaveBeenCalled();

      // Advance past the hold delay
      vi.advanceTimersByTime(500);
      expect(mockActionQueue.enqueueForOwner).toHaveBeenCalledTimes(1);
    });

    it('should use exportSnapshot when snapshot argument is null', () => {
      const exportedSnapshot = makeSnapshot({ focusMode: true });
      const callbacks = makeCallbacks({
        exportSnapshot: vi.fn(() => exportedSnapshot),
      });
      service.init(callbacks);

      service.scheduleCloudPush('user-1', null);
      vi.advanceTimersByTime(3000);

      expect(callbacks.exportSnapshot).toHaveBeenCalled();
      expect(mockActionQueue.enqueueForOwner).toHaveBeenCalledTimes(1);
    });

    it('首次观测到专注已开启时不应绕过防抖或直推 widget', async () => {
      const baseSession = makeSnapshot().session;
      service.init(makeCallbacks());

      service.scheduleCloudPush('user-1', makeSnapshot({
        focusMode: true,
        session: {
          ...baseSession,
          focusSessionId: 'focus-session-1',
          focusSessionStartedAt: Date.now(),
          mainTaskId: 'task-main',
        },
      }));

      await Promise.resolve();
      await Promise.resolve();

      expect(mockFunctionsInvoke).not.toHaveBeenCalled();

      vi.advanceTimersByTime(2999);

      expect(mockActionQueue.enqueueForOwner).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);

      expect(mockActionQueue.enqueueForOwner).toHaveBeenCalledTimes(1);
    });

    it('已知专注态从 false 翻到 true 时应立即写云并直推 widget', async () => {
      const baseSession = makeSnapshot().session;
      service.init(makeCallbacks());

      service.scheduleCloudPush('user-1', makeSnapshot({ focusMode: false }));
      vi.advanceTimersByTime(3000);

      service.scheduleCloudPush('user-1', makeSnapshot({
        focusMode: true,
        session: {
          ...baseSession,
          focusSessionId: 'focus-session-1',
          focusSessionStartedAt: Date.now(),
          mainTaskId: 'task-main',
        },
      }));

      await Promise.resolve();
      await Promise.resolve();

      expect(mockFunctionsInvoke).toHaveBeenCalledWith(
        'widget-notify',
        expect.objectContaining({
          body: expect.objectContaining({
            directNotify: true,
            focusActive: true,
            focusSessionId: 'focus-session-1',
          }),
        }),
      );

      vi.advanceTimersByTime(0);

      expect(mockActionQueue.enqueueForOwner).toHaveBeenCalledTimes(2);
    });

    it('后台或恢复保护窗口内专注翻转不应直推 widget', async () => {
      const baseSession = makeSnapshot().session;
      service.init(makeCallbacks());

      service.scheduleCloudPush('user-1', makeSnapshot({ focusMode: false }));
      vi.advanceTimersByTime(3000);
      mockSupabaseClient.clientAsync.mockClear();
      mockFunctionsInvoke.mockClear();

      setVisibilityState('hidden');
      service.scheduleCloudPush('user-1', makeSnapshot({
        focusMode: true,
        session: {
          ...baseSession,
          focusSessionId: 'focus-session-hidden',
          focusSessionStartedAt: Date.now(),
          mainTaskId: 'task-main',
        },
      }));

      await Promise.resolve();
      await Promise.resolve();

      expect(mockSupabaseClient.clientAsync).not.toHaveBeenCalled();
      expect(mockFunctionsInvoke).not.toHaveBeenCalled();

      vi.advanceTimersByTime(0);
      expect(mockActionQueue.enqueueForOwner).toHaveBeenCalledTimes(2);
    });

    it('online 刚恢复的保护窗口内专注翻转不应直推 widget', async () => {
      const baseSession = makeSnapshot().session;
      service.init(makeCallbacks());

      service.scheduleCloudPush('user-1', makeSnapshot({ focusMode: false }));
      vi.advanceTimersByTime(3000);
      mockSupabaseClient.clientAsync.mockClear();
      mockFunctionsInvoke.mockClear();

      window.dispatchEvent(new Event('online'));
      service.scheduleCloudPush('user-1', makeSnapshot({
        focusMode: true,
        session: {
          ...baseSession,
          focusSessionId: 'focus-session-online',
          focusSessionStartedAt: Date.now(),
          mainTaskId: 'task-main',
        },
      }));

      await Promise.resolve();
      await Promise.resolve();

      expect(mockSupabaseClient.clientAsync).not.toHaveBeenCalled();
      expect(mockFunctionsInvoke).not.toHaveBeenCalled();

      vi.advanceTimersByTime(0);
      expect(mockActionQueue.enqueueForOwner).toHaveBeenCalledTimes(2);
    });

    it('缺少真实 focusSessionId 时不应生成临时 id 直推 widget', async () => {
      const baseSession = makeSnapshot().session;
      service.init(makeCallbacks());

      service.scheduleCloudPush('user-1', makeSnapshot({ focusMode: false }));
      vi.advanceTimersByTime(3000);
      mockSupabaseClient.clientAsync.mockClear();
      mockFunctionsInvoke.mockClear();

      service.scheduleCloudPush('user-1', makeSnapshot({
        focusMode: true,
        session: {
          ...baseSession,
          mainTaskId: 'task-main',
        },
      }));

      await Promise.resolve();
      await Promise.resolve();

      expect(mockSupabaseClient.clientAsync).not.toHaveBeenCalled();
      expect(mockFunctionsInvoke).not.toHaveBeenCalled();

      vi.advanceTimersByTime(0);
      expect(mockActionQueue.enqueueForOwner).toHaveBeenCalledTimes(2);
    });

    it('恢复出已开启专注态后，首次关闭专注也应立即写云并直推 widget', async () => {
      const baseSession = makeSnapshot().session;
      service.init(makeCallbacks());
      service.seedFocusModeBaseline('user-1', makeSnapshot({
        focusMode: true,
        session: {
          ...baseSession,
          focusSessionId: 'focus-session-restored',
          focusSessionStartedAt: Date.now(),
          mainTaskId: 'task-main',
        },
      }));

      service.scheduleCloudPush('user-1', makeSnapshot({
        focusMode: false,
        session: {
          ...baseSession,
          focusSessionId: 'focus-session-restored',
          focusSessionStartedAt: Date.now(),
          mainTaskId: null,
        },
      }));

      await Promise.resolve();
      await Promise.resolve();

      expect(mockFunctionsInvoke).toHaveBeenCalledWith(
        'widget-notify',
        expect.objectContaining({
          body: expect.objectContaining({
            directNotify: true,
            focusActive: false,
            focusSessionId: 'focus-session-restored',
          }),
        }),
      );

      vi.advanceTimersByTime(0);

      expect(mockActionQueue.enqueueForOwner).toHaveBeenCalledTimes(1);
    });

    it('should freeze snapshot at schedule time instead of reading the latest snapshot on timer fire', () => {
      const baseSession = makeSnapshot().session;
      const snapshotA = makeSnapshot({
        focusMode: false,
        session: { ...baseSession, mainTaskId: 'task-a' },
      });
      const snapshotB = makeSnapshot({
        focusMode: true,
        session: { ...baseSession, mainTaskId: 'task-b' },
      });
      let currentSnapshot = snapshotA;
      const callbacks = makeCallbacks({
        exportSnapshot: vi.fn(() => currentSnapshot),
      });
      service.init(callbacks);

      service.scheduleCloudPush('user-a', null);
      currentSnapshot = snapshotB;
      vi.advanceTimersByTime(3000);

      expect(mockActionQueue.enqueueForOwner).toHaveBeenCalledWith(
        'user-a',
        expect.objectContaining({
          payload: expect.objectContaining({
            record: expect.objectContaining({
              snapshot: expect.objectContaining({
                focusMode: false,
                session: expect.objectContaining({ mainTaskId: 'task-a' }),
              }),
            }),
          }),
        }),
      );
    });

    it('should enqueue again when C-slot order changes without count changes', () => {
      const baseSession = makeSnapshot().session;
      service.init(makeCallbacks());

      service.scheduleCloudPush('user-1', makeSnapshot({
        focusMode: true,
        session: {
          ...baseSession,
          mainTaskId: 'A',
          comboSelectIds: ['B', 'C', 'D'],
          backupIds: [],
        },
      }));
      vi.advanceTimersByTime(3000);

      service.scheduleCloudPush('user-1', makeSnapshot({
        focusMode: true,
        session: {
          ...baseSession,
          mainTaskId: 'A',
          comboSelectIds: ['D', 'B', 'C'],
          backupIds: [],
        },
      }));
      vi.advanceTimersByTime(3000);

      expect(mockActionQueue.enqueueForOwner).toHaveBeenCalledTimes(2);
    });
  });

  // ─── scheduleCloudPull ──────────────────────

  describe('scheduleCloudPull', () => {
    it('should skip cloud pull scheduling for local-user', () => {
      service.init(makeCallbacks());

      service.scheduleCloudPull(AUTH_CONFIG.LOCAL_MODE_USER_ID, true);
      vi.advanceTimersByTime(5000);

      expect(mockSyncService.loadFocusSession).not.toHaveBeenCalled();
    });

    it('should respect minimum interval between pulls', () => {
      service.init(makeCallbacks());

      // First pull — should schedule
      service.scheduleCloudPull('user-1', false);
      vi.advanceTimersByTime(250); // CLOUD_PULL_DEBOUNCE_MS
      expect(mockSyncService.loadFocusSession).toHaveBeenCalledTimes(1);

      // Second pull immediately — should be throttled (within 5s min interval)
      service.scheduleCloudPull('user-1', false);
      vi.advanceTimersByTime(250);
      expect(mockSyncService.loadFocusSession).toHaveBeenCalledTimes(1);
    });

    it('should allow forced pull regardless of interval', () => {
      service.init(makeCallbacks());

      // First pull
      service.scheduleCloudPull('user-1', false);
      vi.advanceTimersByTime(250);
      expect(mockSyncService.loadFocusSession).toHaveBeenCalledTimes(1);

      // Force pull immediately — should go through
      service.scheduleCloudPull('user-1', true);
      vi.advanceTimersByTime(250);
      expect(mockSyncService.loadFocusSession).toHaveBeenCalledTimes(2);
    });

    it('should debounce rapid pull requests', () => {
      service.init(makeCallbacks());

      service.scheduleCloudPull('user-1', true);
      service.scheduleCloudPull('user-1', true);
      service.scheduleCloudPull('user-1', true);

      vi.advanceTimersByTime(250);

      // Only the last scheduled timer fires
      expect(mockSyncService.loadFocusSession).toHaveBeenCalledTimes(1);
    });

    it('should not fallback to legacy dock snapshot import when no remote focus session exists', async () => {
      service.init(makeCallbacks());
      mockSyncService.loadFocusSession.mockResolvedValueOnce({ ok: true, value: null });
      mockSyncService.listRoutineTasks.mockResolvedValueOnce({ ok: true, value: [] });

      service.scheduleCloudPull('user-1', true);
      await vi.advanceTimersByTimeAsync(250);

      expect(mockSyncService.importLegacyDockSnapshot).not.toHaveBeenCalled();
    });

    it('should defer cloud pull until browser resume grace window ends', async () => {
      service.init(makeCallbacks());
      mockSyncService.loadFocusSession.mockResolvedValueOnce({ ok: true, value: null });
      mockSyncService.listRoutineTasks.mockResolvedValueOnce({ ok: true, value: [] });

      setVisibilityState('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      setVisibilityState('visible');
      document.dispatchEvent(new Event('visibilitychange'));

      service.scheduleCloudPull('user-1', true);
      await vi.advanceTimersByTimeAsync(250);

      expect(mockSyncService.loadFocusSession).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1500);

      expect(mockSyncService.loadFocusSession).toHaveBeenCalledTimes(1);
    });

    it('should reschedule pull when focus sync returns a browser-suspended Result', async () => {
      service.init(makeCallbacks());
      mockSyncService.loadFocusSession
        .mockResolvedValueOnce({
          ok: false,
          error: {
            code: 'SYNC_OFFLINE',
            message: '浏览器恢复连接中，请稍后重试',
            details: { reason: 'browser-network-suspended', retryable: true },
          },
        })
        .mockResolvedValueOnce({ ok: true, value: null });
      mockSyncService.listRoutineTasks.mockResolvedValueOnce({ ok: true, value: [] });

      service.scheduleCloudPull('user-1', true);
      await vi.advanceTimersByTimeAsync(250);

      expect(mockSyncService.loadFocusSession).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(250);

      expect(mockSyncService.loadFocusSession).toHaveBeenCalledTimes(2);
    });

    it('should keep local snapshot and avoid warning noise when focus session pull times out', async () => {
      service.init(makeCallbacks());
      mockSyncService.loadFocusSession.mockReturnValueOnce(new Promise(() => undefined));

      service.scheduleCloudPull('user-1', true);
      await vi.advanceTimersByTimeAsync(250);
      await vi.advanceTimersByTimeAsync(TIMEOUT_CONFIG.STANDARD);

      expect(mockLoggerCategory.warn).not.toHaveBeenCalledWith(
        'Failed to pull focus session from cloud',
        expect.anything(),
      );
      expect(mockLoggerCategory.debug).toHaveBeenCalledWith(
        'pullCloudSnapshot: loadFocusSession timed out, keeping local focus snapshot',
        expect.anything(),
      );
    });
  });

  // ─── enqueue helpers ────────────────────────

  describe('enqueueFocusSessionSync', () => {
    it('should enqueue a focus-session action', () => {
      service.init(makeCallbacks());
      const snapshot = makeSnapshot();
      service.enqueueFocusSessionSync('user-1', snapshot);

      expect(mockActionQueue.enqueueForOwner).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          type: 'update',
          entityType: 'focus-session',
          payload: expect.objectContaining({
            sourceUserId: 'user-1',
            record: expect.objectContaining({ userId: 'user-1' }),
          }),
          priority: 'critical',
        }),
      );
    });

    it('相同快照仅在同一 owner 下去重，不应跨 owner 共享指纹', () => {
      service.init(makeCallbacks());
      const snapshot = makeSnapshot();

      service.enqueueFocusSessionSync('user-1', snapshot);
      service.enqueueFocusSessionSync('user-1', snapshot);
      service.enqueueFocusSessionSync('user-2', snapshot);

      expect(mockActionQueue.enqueueForOwner).toHaveBeenCalledTimes(2);
      expect(mockActionQueue.enqueueForOwner).toHaveBeenNthCalledWith(
        1,
        'user-1',
        expect.objectContaining({ entityType: 'focus-session' }),
      );
      expect(mockActionQueue.enqueueForOwner).toHaveBeenNthCalledWith(
        2,
        'user-2',
        expect.objectContaining({ entityType: 'focus-session' }),
      );
    });
  });

  describe('enqueueRoutineTaskSync', () => {
    it('should skip routine-task enqueue for local-user', () => {
      service.init(makeCallbacks());
      const routineTask = {
        routineId: 'r-local',
        title: 'Local only',
        triggerCondition: 'any-blank-period' as const,
        maxTimesPerDay: 1,
        isEnabled: true,
      };

      service.enqueueRoutineTaskSync(AUTH_CONFIG.LOCAL_MODE_USER_ID, routineTask);

      expect(mockActionQueue.enqueueForOwner).not.toHaveBeenCalled();
    });

    it('should enqueue a routine-task action', () => {
      service.init(makeCallbacks());
      const routineTask = {
        routineId: 'r-1',
        title: 'Stretch',
        triggerCondition: 'any-blank-period' as const,
        maxTimesPerDay: 3,
        isEnabled: true,
      };
      service.enqueueRoutineTaskSync('user-1', routineTask);

      expect(mockActionQueue.enqueueForOwner).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          type: 'update',
          entityType: 'routine-task',
          entityId: 'r-1',
          payload: expect.objectContaining({
            userId: 'user-1',
            sourceUserId: 'user-1',
          }),
          priority: 'normal',
        }),
      );
    });
  });

  describe('enqueueRoutineCompletionSync', () => {
    it('should skip routine-completion enqueue for local-user', () => {
      service.init(makeCallbacks());
      const completion = {
        completionId: 'c-local',
        userId: AUTH_CONFIG.LOCAL_MODE_USER_ID,
        routineId: 'r-1',
        dateKey: '2025-01-01',
      };

      service.enqueueRoutineCompletionSync(completion);

      expect(mockActionQueue.enqueueForOwner).not.toHaveBeenCalled();
    });

    it('should enqueue a routine-completion action', () => {
      service.init(makeCallbacks());
      const completion = {
        completionId: 'c-1',
        userId: 'user-1',
        routineId: 'r-1',
        dateKey: '2025-01-01',
      };
      service.enqueueRoutineCompletionSync(completion);

      expect(mockActionQueue.enqueueForOwner).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          type: 'create',
          entityType: 'routine-completion',
          entityId: 'c-1',
          payload: expect.objectContaining({
            completion: expect.objectContaining({ userId: 'user-1' }),
            sourceUserId: 'user-1',
          }),
          priority: 'normal',
        }),
      );
    });
  });

  // =========================================================================
  //  Error paths — rejection / failure scenarios
  // =========================================================================

  describe('error paths', () => {
    it('should not throw when cancelTimers is called before any push/pull', () => {
      expect(() => service.cancelTimers()).not.toThrow();
    });

    it('should not throw when scheduleCloudPush receives null snapshot', () => {
      expect(() => service.scheduleCloudPush('user-1', null)).not.toThrow();
    });
  });
});
