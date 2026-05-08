import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { AppLifecycleOrchestratorService } from './app-lifecycle-orchestrator.service';
import { LoggerService } from './logger.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { ToastService } from './toast.service';
import { NetworkAwarenessService } from './network-awareness.service';
import { SimpleSyncService } from '../app/core/services/simple-sync.service';
import { SessionManagerService } from '../app/core/services/sync/session-manager.service';
import { SyncCoordinatorService } from './sync-coordinator.service';
import { APP_LIFECYCLE_CONFIG } from '../config';
import { FEATURE_FLAGS } from '../config/feature-flags.config';
import { FocusStartupProbeService } from './focus-startup-probe.service';
import { FOCUS_CONFIG } from '../config/focus.config';

describe('AppLifecycleOrchestratorService', () => {
  let service: AppLifecycleOrchestratorService;
  let mockNetwork: { refresh: ReturnType<typeof vi.fn> };
  let mockSessionManager: {
    validateOrRefreshOnResume: ReturnType<typeof vi.fn>;
    getRecentValidationSnapshot: ReturnType<typeof vi.fn>;
  };
  let mockSimpleSync: {
    recoverAfterResume: ReturnType<typeof vi.fn>;
    suspendRemoteTransport: ReturnType<typeof vi.fn>;
  };
  let mockFocusStartupProbe: {
    recheckGate: ReturnType<typeof vi.fn>;
    hasPendingGateWork: ReturnType<typeof vi.fn>;
  };
  let mockSyncCoordinator: {
    hasPendingLocalChanges: ReturnType<typeof vi.fn>;
    flushPendingPersistToCloud: ReturnType<typeof vi.fn>;
    refreshBlackBoxWatermarkIfNeeded: ReturnType<typeof vi.fn>;
  };
  let mockToast: {
    info: ReturnType<typeof vi.fn>;
    warning: ReturnType<typeof vi.fn>;
  };
  let originalRequestIdleCallbackDescriptor: PropertyDescriptor | undefined;
  const originalResumeInteractionFirst = FEATURE_FLAGS.RESUME_INTERACTION_FIRST_V1;
  const originalPulseDedup = FEATURE_FLAGS.RESUME_PULSE_DEDUP_V1;

  const setVisibilityState = (state: DocumentVisibilityState): void => {
    Object.defineProperty(document, 'visibilityState', {
      value: state,
      configurable: true,
    });
  };

  const flushResumeWithoutDrainingLongTimers = async (): Promise<void> => {
    for (let i = 0; i < 10; i += 1) {
      await Promise.resolve();
    }
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-14T00:00:00.000Z'));
    originalRequestIdleCallbackDescriptor = Object.getOwnPropertyDescriptor(window, 'requestIdleCallback');
    Object.defineProperty(window, 'requestIdleCallback', {
      configurable: true,
      writable: true,
      value: vi.fn((callback: IdleRequestCallback) => {
        queueMicrotask(() => callback({
          didTimeout: false,
          timeRemaining: () => 50,
        } as IdleDeadline));
        return 1;
      }),
    });
    (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_INTERACTION_FIRST_V1 = originalResumeInteractionFirst;
    (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_PULSE_DEDUP_V1 = originalPulseDedup;

    mockNetwork = {
      refresh: vi.fn(),
    };

    mockSessionManager = {
      getRecentValidationSnapshot: vi.fn().mockReturnValue(null),
      validateOrRefreshOnResume: vi.fn().mockResolvedValue({
        ok: true,
        refreshed: false,
        deferred: false,
      }),
    };

    mockSimpleSync = {
      recoverAfterResume: vi.fn().mockResolvedValue(undefined),
      suspendRemoteTransport: vi.fn().mockResolvedValue(undefined),
    };

    mockFocusStartupProbe = {
      recheckGate: vi.fn().mockResolvedValue(undefined),
      hasPendingGateWork: vi.fn().mockReturnValue(false),
    };

    mockSyncCoordinator = {
      hasPendingLocalChanges: vi.fn().mockReturnValue(false),
      flushPendingPersistToCloud: vi.fn().mockResolvedValue(false),
      refreshBlackBoxWatermarkIfNeeded: vi.fn().mockResolvedValue({ skipped: true }),
    };

    mockToast = {
      info: vi.fn(),
      warning: vi.fn(),
    };

    const mockLoggerCategory = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    TestBed.configureTestingModule({
      providers: [
        AppLifecycleOrchestratorService,
        { provide: NetworkAwarenessService, useValue: mockNetwork },
        { provide: SessionManagerService, useValue: mockSessionManager },
        { provide: SimpleSyncService, useValue: mockSimpleSync },
        { provide: FocusStartupProbeService, useValue: mockFocusStartupProbe },
        { provide: SyncCoordinatorService, useValue: mockSyncCoordinator },
        { provide: ToastService, useValue: mockToast },
        {
          provide: SentryLazyLoaderService,
          useValue: {
            addBreadcrumb: vi.fn(),
            setMeasurement: vi.fn(),
            captureException: vi.fn(),
            captureMessage: vi.fn(),
          },
        },
        {
          provide: LoggerService,
          useValue: {
            category: vi.fn().mockReturnValue(mockLoggerCategory),
          },
        },
      ],
    });

    service = TestBed.inject(AppLifecycleOrchestratorService);
  });

  afterEach(() => {
    (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_INTERACTION_FIRST_V1 = originalResumeInteractionFirst;
    (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_PULSE_DEDUP_V1 = originalPulseDedup;
    TestBed.resetTestingModule();
    if (originalRequestIdleCallbackDescriptor) {
      Object.defineProperty(window, 'requestIdleCallback', originalRequestIdleCallbackDescriptor);
    } else {
      Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'requestIdleCallback');
    }
    vi.useRealTimers();
  });

  it('should single-flight concurrent resume requests', async () => {
    let resolveRecovery: (() => void) | null = null;
    mockSimpleSync.recoverAfterResume.mockReturnValue(
      new Promise<void>(resolve => {
        resolveRecovery = resolve;
      })
    );

    const p1 = service.triggerResume('visibility-threshold');
    const p2 = service.triggerResume('visibility-threshold');

    await Promise.resolve();
    await Promise.resolve();

    expect(mockSimpleSync.recoverAfterResume).toHaveBeenCalledTimes(1);

    resolveRecovery!();
    await Promise.all([p1, p2]);
  });

  it('should run heavy recovery when hidden duration exceeds threshold', async () => {
    service.initialize();

    setVisibilityState('hidden');
    document.dispatchEvent(new Event('visibilitychange'));

    expect(mockSimpleSync.suspendRemoteTransport).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date(Date.now() + APP_LIFECYCLE_CONFIG.RESUME_THRESHOLD_MS + 1));

    setVisibilityState('visible');
    document.dispatchEvent(new Event('visibilitychange'));

    await flushResumeWithoutDrainingLongTimers();

    expect(mockSessionManager.validateOrRefreshOnResume).toHaveBeenCalled();
    expect(mockSimpleSync.recoverAfterResume).toHaveBeenCalledTimes(2);
    const heavyCalls = mockSimpleSync.recoverAfterResume.mock.calls.filter(
      ([, options]) => options?.mode === 'heavy'
    );
    expect(heavyCalls).toHaveLength(1);
    expect(mockSyncCoordinator.refreshBlackBoxWatermarkIfNeeded).toHaveBeenCalledTimes(1);
  });

  it('should only do lightweight checks for quick resume', async () => {
    await service.triggerResume('visibility-quick');

    expect(mockSessionManager.validateOrRefreshOnResume).toHaveBeenCalledTimes(1);
    expect(mockSimpleSync.recoverAfterResume).toHaveBeenCalledTimes(1);
    expect(mockSimpleSync.recoverAfterResume).toHaveBeenCalledWith('visibility-quick', expect.objectContaining({
      mode: 'light',
      allowRemoteProbe: false,
      sessionValidated: true,
      retryProcessing: 'background',
    }));
    expect(mockSyncCoordinator.refreshBlackBoxWatermarkIfNeeded).not.toHaveBeenCalled();
    expect(mockFocusStartupProbe.recheckGate).not.toHaveBeenCalled();
  });

  it('应在恢复时自动补发尚未完成的本地持久化', async () => {
    mockSyncCoordinator.hasPendingLocalChanges.mockReturnValue(true);

    await service.triggerResume('visibility-quick');
    await Promise.resolve();

    expect(mockSyncCoordinator.flushPendingPersistToCloud).toHaveBeenCalledWith('resume:visibility-quick');
  });

  it('online 恢复命中会话快照时也应异步补发 pending persist', async () => {
    mockSyncCoordinator.hasPendingLocalChanges.mockReturnValue(true);
    mockSessionManager.getRecentValidationSnapshot.mockReturnValue({
      valid: true,
      userId: 'user-1',
      at: Date.now(),
    });

    await service.triggerResume('online');
    await Promise.resolve();

    expect(mockSyncCoordinator.flushPendingPersistToCloud).toHaveBeenCalledWith('resume:online');
  });

  it('应为恢复流程生成 ticket 并传递给 recoverAfterResume', async () => {
    const before = service.getCurrentRecoveryTicket();
    expect(before).toBeNull();

    await service.triggerResume('visibility-threshold');

    const calls = mockSimpleSync.recoverAfterResume.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const [, options] of calls) {
      expect(options?.recoveryTicketId).toBeTypeOf('string');
    }
    expect(service.getCurrentRecoveryTicket()).toBeNull();
  });

  it('snapshot 命中时应跳过 validateOrRefreshOnResume', async () => {
    mockSessionManager.getRecentValidationSnapshot.mockReturnValue({
      valid: true,
      userId: 'user-1',
      at: Date.now(),
    });

    await service.triggerResume('visibility-threshold');
    await flushResumeWithoutDrainingLongTimers();

    expect(mockSessionManager.validateOrRefreshOnResume).not.toHaveBeenCalled();
  });

  it('应产出恢复指标快照（interaction + background）', async () => {
    await service.triggerResume('visibility-threshold');
    await flushResumeWithoutDrainingLongTimers();

    const metrics = service.getLastRecoveryMetrics();
    expect(metrics).toBeTruthy();
    expect(metrics?.ticketId).toBeTypeOf('string');
    expect(metrics?.interactionReadyMs).toBeGreaterThanOrEqual(0);
    expect(metrics?.backgroundRefreshMs).toBeGreaterThanOrEqual(0);
  });

  it('应优先使用高精度时钟计算 interactionReadyMs（避免同毫秒 0ms 抖动）', async () => {
    let clock = 1000;
    const perfNowSpy = vi.spyOn(performance, 'now').mockImplementation(() => {
      clock += 0.35;
      return clock;
    });

    try {
      await service.triggerResume('visibility-quick');
      await flushResumeWithoutDrainingLongTimers();

      const metrics = service.getLastRecoveryMetrics();
      expect(metrics).toBeTruthy();
      expect(metrics?.interactionReadyMs ?? 0).toBeGreaterThan(0);
    } finally {
      perfNowSpy.mockRestore();
    }
  });

  it('should ignore non-persisted pageshow events on cold startup', async () => {
    service.initialize();

    const pageshow = new Event('pageshow') as PageTransitionEvent;
    Object.defineProperty(pageshow, 'persisted', { value: false });
    window.dispatchEvent(pageshow);
    await flushResumeWithoutDrainingLongTimers();

    expect(mockSessionManager.validateOrRefreshOnResume).not.toHaveBeenCalled();
    expect(mockSimpleSync.recoverAfterResume).not.toHaveBeenCalled();
  });

  it('should stop recovery without failure when session validation is deferred', async () => {
    mockSessionManager.validateOrRefreshOnResume.mockResolvedValueOnce({
      ok: false,
      refreshed: false,
      deferred: true,
      reason: 'client-unready',
    });
    mockSessionManager.validateOrRefreshOnResume.mockResolvedValueOnce({
      ok: true,
      refreshed: false,
      deferred: false,
    });

    await service.triggerResume('visibility-threshold');

    expect(mockSimpleSync.recoverAfterResume).not.toHaveBeenCalled();
    expect(mockSyncCoordinator.refreshBlackBoxWatermarkIfNeeded).not.toHaveBeenCalled();
    expect(mockToast.warning).not.toHaveBeenCalled();
    expect(service.isResuming()).toBe(false);

    await vi.advanceTimersByTimeAsync(200);

    expect(mockSessionManager.validateOrRefreshOnResume).toHaveBeenCalledTimes(2);
    expect(mockSimpleSync.recoverAfterResume).toHaveBeenCalled();
  });

  it('hidden 状态下 online 触发 deferred 后不应以 100ms 自旋重试', async () => {
    service.initialize();
    mockSessionManager.validateOrRefreshOnResume.mockResolvedValueOnce({
      ok: false,
      refreshed: false,
      deferred: true,
      reason: 'client-unready',
    });
    mockSessionManager.validateOrRefreshOnResume.mockResolvedValueOnce({
      ok: true,
      refreshed: false,
      deferred: false,
    });

    setVisibilityState('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('online'));
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(1000);
    expect(mockSessionManager.validateOrRefreshOnResume).toHaveBeenCalledTimes(1);

    setVisibilityState('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await flushResumeWithoutDrainingLongTimers();

    expect(mockSessionManager.validateOrRefreshOnResume).toHaveBeenCalledTimes(2);
    expect(mockSimpleSync.recoverAfterResume).toHaveBeenCalled();
  });

  it('should stop resume pipeline after timeout without blocking UI state', async () => {
    mockSimpleSync.recoverAfterResume.mockReturnValue(new Promise<void>(() => {
      // hold forever to trigger timeout
    }));

    const promise = service.triggerResume('visibility-threshold');

    await vi.advanceTimersByTimeAsync(APP_LIFECYCLE_CONFIG.RESUME_TIMEOUT_MS + 10);
    await promise;

    expect(service.isResuming()).toBe(false);
  });

  it('heavy 恢复冷却窗口内应只执行一次 heavy 恢复', async () => {
    (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_INTERACTION_FIRST_V1 = true;
    (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_PULSE_DEDUP_V1 = true;

    await service.triggerResume('visibility-threshold');
    await flushResumeWithoutDrainingLongTimers();
    await service.triggerResume('visibility-threshold');
    await flushResumeWithoutDrainingLongTimers();

    const heavyCalls = mockSimpleSync.recoverAfterResume.mock.calls.filter(
      ([, options]) => options?.mode === 'heavy'
    );
    expect(heavyCalls).toHaveLength(1);
  });

  it('hidden>threshold 后 visible/focus/online 连续事件应仅触发一次 heavy', async () => {
    (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_INTERACTION_FIRST_V1 = true;
    (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_PULSE_DEDUP_V1 = true;

    service.initialize();

    setVisibilityState('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    vi.setSystemTime(new Date(Date.now() + APP_LIFECYCLE_CONFIG.RESUME_THRESHOLD_MS + 10));
    setVisibilityState('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await flushResumeWithoutDrainingLongTimers();

    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('online'));
    await flushResumeWithoutDrainingLongTimers();

    const heavyCalls = mockSimpleSync.recoverAfterResume.mock.calls.filter(
      ([, options]) => options?.mode === 'heavy'
    );
    expect(heavyCalls).toHaveLength(1);
  });

  it('后台闲置超过大门阈值后恢复若本地已命中 gate，不应在黑匣子刷新后重复复核', async () => {
    mockFocusStartupProbe.hasPendingGateWork.mockReturnValue(true);

    service.initialize();

    setVisibilityState('hidden');
    document.dispatchEvent(new Event('visibilitychange'));

    vi.setSystemTime(new Date(Date.now() + FOCUS_CONFIG.GATE.IDLE_RECHECK_THRESHOLD + 1));

    setVisibilityState('visible');
    document.dispatchEvent(new Event('visibilitychange'));

    await flushResumeWithoutDrainingLongTimers();

    expect(mockFocusStartupProbe.recheckGate).toHaveBeenCalledTimes(1);
    expect(mockFocusStartupProbe.recheckGate).toHaveBeenCalledWith({
      source: 'resume-local',
      reloadLocal: true,
    });
  });

  it('后台闲置超过大门阈值后恢复若本地已命中 gate，即使远端黑匣子刷新拉到新数据也不应重复复核', async () => {
    mockFocusStartupProbe.hasPendingGateWork.mockReturnValue(true);
    mockSyncCoordinator.refreshBlackBoxWatermarkIfNeeded.mockResolvedValue({ skipped: false });

    service.initialize();

    setVisibilityState('hidden');
    document.dispatchEvent(new Event('visibilitychange'));

    vi.setSystemTime(new Date(Date.now() + FOCUS_CONFIG.GATE.IDLE_RECHECK_THRESHOLD + 1));

    setVisibilityState('visible');
    document.dispatchEvent(new Event('visibilitychange'));

    await flushResumeWithoutDrainingLongTimers();

    expect(mockFocusStartupProbe.recheckGate).toHaveBeenCalledTimes(1);
    expect(mockFocusStartupProbe.recheckGate).toHaveBeenCalledWith({
      source: 'resume-local',
      reloadLocal: true,
    });
  });

  it('后台闲置超过大门阈值后恢复若本地未命中 gate，应在黑匣子刷新后再次复核', async () => {
    service.initialize();

    setVisibilityState('hidden');
    document.dispatchEvent(new Event('visibilitychange'));

    vi.setSystemTime(new Date(Date.now() + FOCUS_CONFIG.GATE.IDLE_RECHECK_THRESHOLD + 1));

    setVisibilityState('visible');
    document.dispatchEvent(new Event('visibilitychange'));

    await flushResumeWithoutDrainingLongTimers();

    expect(mockFocusStartupProbe.recheckGate).toHaveBeenCalledTimes(2);
    expect(mockFocusStartupProbe.recheckGate).toHaveBeenNthCalledWith(1, {
      source: 'resume-local',
      reloadLocal: true,
    });
    expect(mockFocusStartupProbe.recheckGate).toHaveBeenNthCalledWith(2, {
      source: 'resume-remote',
      reloadLocal: false,
    });
  });
});
