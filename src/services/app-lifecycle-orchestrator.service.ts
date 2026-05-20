import { DestroyRef, Injectable, Injector, inject, signal } from '@angular/core';
import { SwUpdate } from '@angular/service-worker';
import { APP_LIFECYCLE_CONFIG } from '../config/app-lifecycle.config';
import { FEATURE_FLAGS } from '../config/feature-flags.config';
import { LoggerService } from './logger.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { ToastService } from './toast.service';
import { NetworkAwarenessService } from './network-awareness.service';
import { SimpleSyncService, SessionManagerService } from '../core-bridge';
import { SyncCoordinatorService } from './sync-coordinator.service';
import { FocusStartupProbeService } from './focus-startup-probe.service';
import { FOCUS_CONFIG } from '../config/focus.config';
import { reloadViaForceClearCache } from '../utils/force-clear-cache';
import { getRemainingBrowserNetworkResumeDelayMs } from '../utils/browser-network-suspension';
import { readRuntimePlatformSnapshot } from '../utils/runtime-platform';

export type AppResumeReason =
  | 'visibility-threshold'
  | 'visibility-quick'
  | 'pageshow'
  | 'online'
  | 'manual';

export interface RecoveryMetricsSnapshot {
  ticketId: string;
  reason: string;
  interactionReadyMs: number;
  backgroundRefreshMs?: number;
  fastPathHit?: boolean;
}

@Injectable({ providedIn: 'root' })
export class AppLifecycleOrchestratorService {
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('LifecycleOrchestrator');
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly toast = inject(ToastService);
  private readonly networkAwareness = inject(NetworkAwarenessService);
  private readonly simpleSync = inject(SimpleSyncService);
  private readonly sessionManager = inject(SessionManagerService);
  private readonly syncCoordinator = inject(SyncCoordinatorService);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);
  /**
   * SwUpdate 在禁用 SW 的本地开发环境下不可用。
   * 用 `{ optional: true }` 注入，调用前再检查 isEnabled。
   */
  private readonly swUpdate = inject(SwUpdate, { optional: true });

  private readonly isResumingSignal = signal(false);
  private readonly lastResumeAtSignal = signal<number | null>(null);
  private readonly lastHeavyRecoveryAtSignal = signal<number | null>(null);
  private readonly lastRecoveryMetricsSignal = signal<RecoveryMetricsSnapshot | null>(null);
  private readonly compensationTicketIdSignal = signal<string | null>(null);
  private readonly currentRecoveryTicketSignal = signal<{
    id: string;
    startedAt: number;
    mode: 'light' | 'heavy';
  } | null>(null);

  private initialized = false;
  private resumePromise: Promise<void> | null = null;
  private hiddenAt: number | null = null;
  private lastBackgroundDurationMs = 0;
  private consecutiveFailures = 0;
  // 仅用于诊断：会话失败计数永远不会触发 auto-reload（reload 无法修复 no-session 状态）。
  private consecutiveSessionFailures = 0;
  private autoReloadScheduled = false;
  private deferredResumeTimer: ReturnType<typeof setTimeout> | null = null;

  private hasPendingVersion = false;
  private hasShownResumeVersionPrompt = false;

  private visibilityHandler: (() => void) | null = null;
  private focusHandler: (() => void) | null = null;
  private blurHandler: (() => void) | null = null;
  private pageshowHandler: ((event: PageTransitionEvent) => void) | null = null;
  private onlineHandler: (() => void) | null = null;
  private _focusStartupProbe?: FocusStartupProbeService;

  private static readonly AUTO_RELOAD_COUNTER_KEY = 'nanoflow.lifecycle.auto-reload';

  private get focusStartupProbe(): FocusStartupProbeService {
    return (this._focusStartupProbe ??= this.injector.get(FocusStartupProbeService));
  }

  constructor() {
    this.destroyRef.onDestroy(() => this.cleanup());
  }

  /**
   * Initialize the lifecycle orchestrator by registering browser event listeners
   * for visibility changes, BFCache restoration, and network reconnection.
   *
   * This service manages the resume/recovery lifecycle and MUST be initialized
   * first among all startup services. The full service initialization order,
   * orchestrated by {@link WorkspaceShellComponent}, is:
   *
   * 1. **AppLifecycleOrchestratorService.initialize()** (constructor, synchronous)
   *    - Registers visibilitychange, pageshow, and online listeners.
   *    - Must be first so that resume/recovery orchestration is active before
   *      any async work begins.
   *
   * 2. **StartupTierOrchestratorService.initialize()** (ngOnInit, synchronous)
   *    - Sets up the P0/P1/P2 tiered startup state machine.
   *    - P0 = critical render path, P1 = interaction readiness, P2 = background
   *      sync hydration. Gated by {@link FEATURE_FLAGS.TIERED_STARTUP_HYDRATION_V1}.
   *
   * 3. **StartupFontSchedulerService.initialize()** (ngOnInit, synchronous)
   *    - Schedules non-critical font loading via requestIdleCallback / setTimeout
   *      to avoid blocking first paint.
   *
   * 4. **FocusStartupProbeService.initialize()** (signal effect, async-reactive)
   *    - Runs a local-only gate check to determine whether Focus mode has
   *      pending work. Fires after coreDataLoaded() becomes true and the user
   *      is authenticated. Gated by {@link FEATURE_FLAGS.FOCUS_STARTUP_THROTTLED_CHECK_V1}.
   *
   * 5. **EventDrivenSyncPulseService.initialize()** (signal effect, async-reactive)
   *    - Activates event-driven sync pulses (replaces fixed-interval polling).
   *      Depends on authentication, coreDataLoaded, and P2 tier readiness.
   *      Gated by {@link FEATURE_FLAGS.EVENT_DRIVEN_SYNC_PULSE_V1}.
   *
   * 6. **PwaInstallPromptService.initialize()** (deferred, lowest priority)
   *    - Captures the beforeinstallprompt event and exposes install affordance.
   *      Deferred to first user interaction or requestIdleCallback to avoid
   *      competing with critical startup work.
   *      Gated by {@link FEATURE_FLAGS.PWA_PROMPT_DEFER_V2}.
   *
   * Idempotent: subsequent calls after the first are no-ops.
   * SSR-safe: returns immediately when `window` or `document` is unavailable.
   */
  initialize(): void {
    if (this.initialized || typeof window === 'undefined' || typeof document === 'undefined') {
      return;
    }

    this.visibilityHandler = () => {
      if (document.visibilityState === 'hidden') {
        this.hiddenAt ??= Date.now();
        void this.simpleSync.suspendRemoteTransport();
        return;
      }

      if (document.visibilityState === 'visible' && this.hiddenAt) {
        const duration = Date.now() - this.hiddenAt;
        this.hiddenAt = null;
        this.lastBackgroundDurationMs = duration;

        const reason: AppResumeReason = duration >= APP_LIFECYCLE_CONFIG.RESUME_THRESHOLD_MS
          ? 'visibility-threshold'
          : 'visibility-quick';

        void this.triggerResume(reason);
      }
    };

    this.blurHandler = () => {
      if (!this.shouldUseWindowFocusResumeFallback()) {
        return;
      }

      if (this.hiddenAt !== null) {
        return;
      }

      this.hiddenAt = Date.now();
      void this.simpleSync.suspendRemoteTransport();
    };

    this.focusHandler = () => {
      if (document.visibilityState === 'hidden' || !this.hiddenAt) {
        return;
      }

      const duration = Date.now() - this.hiddenAt;
      this.hiddenAt = null;
      this.lastBackgroundDurationMs = duration;

      const reason: AppResumeReason = duration >= APP_LIFECYCLE_CONFIG.RESUME_THRESHOLD_MS
        ? 'visibility-threshold'
        : 'visibility-quick';

      void this.triggerResume(reason);
    };

    this.pageshowHandler = (event: PageTransitionEvent) => {
      // BFCache 恢复场景优先触发恢复编排
      if (!event.persisted) {
        return;
      }

      this.lastBackgroundDurationMs = Math.max(
        this.lastBackgroundDurationMs,
        APP_LIFECYCLE_CONFIG.RESUME_THRESHOLD_MS
      );
      void this.triggerResume('pageshow');
    };

    this.onlineHandler = () => {
      if (document.visibilityState === 'hidden' || this.hiddenAt !== null) {
        return;
      }

      void this.triggerResume('online');
    };

    document.addEventListener('visibilitychange', this.visibilityHandler);
    window.addEventListener('blur', this.blurHandler);
    window.addEventListener('focus', this.focusHandler);
    window.addEventListener('pageshow', this.pageshowHandler as EventListener);
    window.addEventListener('online', this.onlineHandler);

    this.initialized = true;
    this.logger.info('Lifecycle orchestrator initialized');
  }

  private shouldUseWindowFocusResumeFallback(): boolean {
    const platform = readRuntimePlatformSnapshot();
    return platform.isAndroid || platform.os === 'ios' || platform.isStandalone;
  }

  markVersionReady(): void {
    this.hasPendingVersion = true;
    this.hasShownResumeVersionPrompt = false;
  }

  isResuming(): boolean {
    return this.isResumingSignal();
  }

  lastResumeAt(): number | null {
    return this.lastResumeAtSignal();
  }

  lastHeavyRecoveryAt(): number | null {
    return this.lastHeavyRecoveryAtSignal();
  }

  getLastRecoveryMetrics(): RecoveryMetricsSnapshot | null {
    return this.lastRecoveryMetricsSignal();
  }

  getCurrentRecoveryTicket(): { id: string; startedAt: number; mode: 'light' | 'heavy' } | null {
    return this.currentRecoveryTicketSignal();
  }

  isRecoveryCompensationInFlight(ticketId?: string): boolean {
    const compensatingTicketId = this.compensationTicketIdSignal();
    if (!compensatingTicketId) {
      return false;
    }
    if (!ticketId) {
      return true;
    }
    return compensatingTicketId === ticketId;
  }

  isHeavyRecoveryInCooldown(windowMs = APP_LIFECYCLE_CONFIG.RESUME_HEAVY_COOLDOWN_MS): boolean {
    const lastHeavy = this.lastHeavyRecoveryAtSignal();
    if (!lastHeavy) {
      return false;
    }
    return Date.now() - lastHeavy < windowMs;
  }

  async triggerResume(reason: AppResumeReason): Promise<void> {
    if (!FEATURE_FLAGS.LIFECYCLE_RECOVERY_V1) {
      return;
    }

    if (this.resumePromise) {
      return this.resumePromise;
    }

    this.resumePromise = this.executeResume(reason);

    try {
      await this.resumePromise;
    } finally {
      this.resumePromise = null;
    }
  }

  /**
   * 执行 resume 流程。
   *
   * 失败分类（重要）：
   * 1. `pipelineResult.reason === 'no-session' | 'refresh-failed'` —— 会话状态失败：
   *    不计入 `consecutiveFailures`，也不会触发 `maybeScheduleAutoReload`。
   *    原因：reload 不修复 no-session（refresh token 仍在 localStorage；终态失效后重载只会
   *    再次走同一断路），强刷反而破坏未登录用户的当前 UI 状态。这类失败由 `SessionManager`
   *    自身的断路 + "登录已过期" toast 处理。
   * 2. pipeline 抛出运行时异常（catch 分支）—— 真异常：累加 `consecutiveFailures`，
   *    达到阈值后通过 `maybeScheduleAutoReload` 兜底刷新页面。
   */
  private async executeResume(reason: AppResumeReason): Promise<void> {
    const startAt = Date.now();
    const runHeavyRecovery = reason !== 'visibility-quick';
    const recoveryTicket = {
      id: this.createRecoveryTicketId(runHeavyRecovery ? 'heavy' : 'light'),
      startedAt: startAt,
      mode: runHeavyRecovery ? 'heavy' as const : 'light' as const,
    };
    this.currentRecoveryTicketSignal.set(recoveryTicket);
    const perfPrefix = `nanoflow:resume:${recoveryTicket.id}`;
    this.markPerformance(`${perfPrefix}:start`);

    this.isResumingSignal.set(true);
    this.addLifecycleBreadcrumb('lifecycle.resume.start', reason, {
      runHeavyRecovery,
      backgroundDurationMs: this.lastBackgroundDurationMs,
      recoveryTicketId: recoveryTicket.id,
    });
    this.addLifecycleBreadcrumb('lifecycle.resume.reason', reason);

    try {
      const pipelineResult = await this.withTimeout(
        this.executeRecoveryPipeline(reason, runHeavyRecovery, recoveryTicket),
        APP_LIFECYCLE_CONFIG.RESUME_TIMEOUT_MS
      );

      if (pipelineResult.deferred) {
        const deferredDelayMs = this.scheduleDeferredResumeRetry(reason);
        this.addLifecycleBreadcrumb('lifecycle.resume.success', reason, {
          elapsedMs: Date.now() - startAt,
          deferred: true,
          deferredReason: pipelineResult.reason ?? 'unknown',
          deferredDelayMs,
        });
        return;
      }

      if (pipelineResult.reason === 'no-session' || pipelineResult.reason === 'refresh-failed') {
        this.handleSessionFailure(reason, pipelineResult.reason, startAt);
        return;
      }

      this.consecutiveFailures = 0;
      this.consecutiveSessionFailures = 0;
      this.lastResumeAtSignal.set(Date.now());
      if (typeof pipelineResult.interactionReadyMs === 'number') {
        this.reportRecoveryMetrics({
          ticketId: recoveryTicket.id,
          reason,
          interactionReadyMs: pipelineResult.interactionReadyMs,
          fastPathHit: pipelineResult.fastPathHit,
        });
      }

      if (
        this.hasPendingVersion &&
        !this.hasShownResumeVersionPrompt &&
        this.lastBackgroundDurationMs >= APP_LIFECYCLE_CONFIG.NEW_VERSION_PROMPT_THRESHOLD_MS
      ) {
        // 关键修复（2026-05-15）：
        // - onClick 异步化，先 activateUpdate() 让 waiting SW 真正切到 active，再清缓存刷新；
        // - 抑制 flag 在「点击实际开始」之前设置；若点击后两条路径都失败，复位 flag 让
        //   下一次 resume 仍能弹出，避免用户只剩一个无效 toast。
        this.hasShownResumeVersionPrompt = true;
        this.toast.info(
          '检测到新版本',
          '页面后台停留较久，建议刷新以获得最新稳定版本',
          {
            duration: 0,
            action: {
              label: '立即刷新',
              pendingLabel: '正在刷新…',
              onClick: () => this.triggerVersionReload(),
            },
          }
        );
      }

      this.addLifecycleBreadcrumb('lifecycle.resume.success', reason, {
        elapsedMs: Date.now() - startAt,
      });
    } catch (error) {
      this.handlePipelineException(reason, error, startAt);
    } finally {
      this.currentRecoveryTicketSignal.set(null);
      this.isResumingSignal.set(false);
    }
  }

  /**
   * 处理会话校验/刷新失败（no-session / refresh-failed）。
   *
   * 重要：不计入 `consecutiveFailures`，不会触发 auto-reload。
   * 仅维护 `consecutiveSessionFailures` 用于诊断，并写入 breadcrumb。
   */
  private handleSessionFailure(
    reason: AppResumeReason,
    failureKind: 'no-session' | 'refresh-failed',
    startAt: number
  ): void {
    this.consecutiveSessionFailures += 1;
    this.addLifecycleBreadcrumb('lifecycle.resume.fail', reason, {
      elapsedMs: Date.now() - startAt,
      failureKind,
      // 保留 sessionFailureReason 以兼容已存在的 Sentry 查询/告警；新代码应优先使用 failureKind。
      sessionFailureReason: failureKind,
      consecutiveSessionFailures: this.consecutiveSessionFailures,
    });
  }

  /**
   * 处理 resume pipeline 抛出的运行时异常（真异常）。
   * 累加 `consecutiveFailures`，达到阈值时通过 `maybeScheduleAutoReload` 兜底刷新。
   */
  private handlePipelineException(
    reason: AppResumeReason,
    error: unknown,
    startAt: number
  ): void {
    this.consecutiveFailures += 1;

    this.addLifecycleBreadcrumb('lifecycle.resume.fail', reason, {
      elapsedMs: Date.now() - startAt,
      failureKind: 'pipeline-exception',
      consecutiveFailures: this.consecutiveFailures,
    });

    this.sentryLazyLoader.captureException(error, {
      operation: 'lifecycle.resume',
      reason,
      consecutiveFailures: this.consecutiveFailures,
    });

    this.logger.warn('Resume pipeline failed', {
      reason,
      consecutiveFailures: this.consecutiveFailures,
      error,
    });

    this.maybeScheduleAutoReload(reason, error);
  }

  private async executeRecoveryPipeline(
    reason: AppResumeReason,
    heavy: boolean,
    recoveryTicket: { id: string; startedAt: number; mode: 'light' | 'heavy' }
  ): Promise<{
    deferred: boolean;
    reason?: 'client-unready' | 'no-session' | 'refresh-failed';
    interactionReadyMs?: number;
    fastPathHit?: boolean;
  }> {
    const recoveryTicketId = recoveryTicket.id;
    const perfPrefix = recoveryTicketId ? `nanoflow:resume:${recoveryTicketId}` : null;

    this.recordRecoveryStep('network-refresh', reason);
    this.networkAwareness.refresh();

    this.recordRecoveryStep('session-validate', reason);
    const sessionSnapshot = FEATURE_FLAGS.RESUME_SESSION_SNAPSHOT_V1
      ? this.sessionManager.getRecentValidationSnapshot(10_000)
      : null;
    const session = sessionSnapshot?.valid
      ? { ok: true, refreshed: false, deferred: false, reason: undefined as ('client-unready' | 'no-session' | 'refresh-failed' | undefined) }
      : await this.sessionManager.validateOrRefreshOnResume(`resume:${reason}`);

    if (session.deferred) {
      this.logger.info('Session validation deferred during resume', { reason, deferredReason: session.reason });
      return { deferred: true, reason: session.reason };
    }

    if (!session.ok) {
      this.logger.warn('Session validation failed during resume', { reason, failureReason: session.reason });
      return { deferred: false, reason: session.reason };
    }

    this.kickPendingPersistRecovery(reason);

    const interactionStartAt = this.monotonicNow();
    if (FEATURE_FLAGS.RESUME_INTERACTION_FIRST_V1) {
      this.recordRecoveryStep('sync-recovery-light', reason);
      await this.simpleSync.recoverAfterResume(reason, {
        mode: 'light',
        stage: 'full',
        allowRemoteProbe: false,
        sessionValidated: true,
        retryProcessing: 'background',
        deferBlackBoxPull: true,
        recoveryTicketId: recoveryTicketId ?? undefined,
      });
    }
    const interactionReadyMs = this.monotonicNow() - interactionStartAt;
    if (perfPrefix) {
      this.markPerformance(`${perfPrefix}:interaction-ready`);
      this.measurePerformance('resume.interaction_ready_ms', `${perfPrefix}:start`, `${perfPrefix}:interaction-ready`);
    }

    await this.recheckFocusGateIfNeeded(reason, 'resume-local');

    if (!heavy) {
      return { deferred: false, interactionReadyMs };
    }

    if (
      FEATURE_FLAGS.RESUME_INTERACTION_FIRST_V1 &&
      FEATURE_FLAGS.RESUME_PULSE_DEDUP_V1 &&
      this.isHeavyRecoveryInCooldown()
    ) {
      this.recordRecoveryStep('sync-recovery-heavy-suppressed', reason);
      if (this.shouldRecheckFocusGate(reason)) {
        this.recordRecoveryStep('blackbox-recovery', reason);
        await this.syncCoordinator.refreshBlackBoxWatermarkIfNeeded('resume');
        await this.recheckFocusGateIfNeeded(reason, 'resume-remote');
      }
      return { deferred: false, interactionReadyMs };
    }

    if (FEATURE_FLAGS.RESUME_INTERACTION_FIRST_V1) {
      this.scheduleRecoveryCompensation(reason, {
        id: recoveryTicketId ?? this.createRecoveryTicketId('heavy'),
        startedAt: Date.now(),
        mode: 'heavy',
      }, interactionReadyMs);
      this.lastHeavyRecoveryAtSignal.set(Date.now());
      return { deferred: false, interactionReadyMs };
    }

    this.recordRecoveryStep('sync-recovery', reason);
    await this.simpleSync.recoverAfterResume(reason, {
      sessionValidated: true,
      retryProcessing: 'background',
      deferBlackBoxPull: true,
      recoveryTicketId: recoveryTicketId ?? undefined,
      backgroundProbeDelayMs: 180,
    });

    this.recordRecoveryStep('blackbox-recovery', reason);
    const blackBoxResult = await this.syncCoordinator.refreshBlackBoxWatermarkIfNeeded('resume');
    await this.recheckFocusGateIfNeeded(reason, 'resume-remote');

    this.recordRecoveryStep('ui-correction', reason);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('nanoflow:lifecycle-resumed', {
        detail: {
          reason,
          resumedAt: Date.now(),
        },
      }));
    }

    this.lastHeavyRecoveryAtSignal.set(Date.now());

    return { deferred: false, interactionReadyMs, fastPathHit: blackBoxResult.skipped };
  }

  private kickPendingPersistRecovery(reason: AppResumeReason): void {
    if (!this.syncCoordinator.hasPendingLocalChanges()) {
      return;
    }

    this.sentryLazyLoader.addBreadcrumb({
      category: 'lifecycle',
      message: 'recovery.step',
      level: 'info',
      data: {
        step: 'resume-pending-persist-recovery',
        reason,
      }
    });

    const runRecovery = () => {
      void this.syncCoordinator.flushPendingPersistToCloud(`resume:${reason}`).catch((error) => {
        this.logger.warn('Resume pending persist recovery failed', { reason, error });
        this.sentryLazyLoader.captureException(error, {
          operation: 'lifecycle.resume.pending-persist',
          reason,
        });
      });
    };

    if (typeof queueMicrotask === 'function') {
      queueMicrotask(runRecovery);
      return;
    }

    void Promise.resolve().then(runRecovery);
  }

  private scheduleRecoveryCompensation(
    reason: AppResumeReason,
    recoveryTicket: { id: string; startedAt: number; mode: 'light' | 'heavy' },
    interactionReadyMs: number
  ): void {
    if (this.isRecoveryCompensationInFlight(recoveryTicket.id)) {
      return;
    }
    this.compensationTicketIdSignal.set(recoveryTicket.id);

    const runCompensation = async () => {
      const backgroundStartAt = this.monotonicNow();
      const perfPrefix = `nanoflow:resume:${recoveryTicket.id}`;
      this.markPerformance(`${perfPrefix}:background-start`);
      let fastPathHit: boolean | undefined;

      try {
        this.recordRecoveryStep('sync-recovery-heavy-compensation', reason);
        await this.simpleSync.recoverAfterResume(reason, {
          mode: 'heavy',
          stage: 'compensation',
          allowRemoteProbe: true,
          sessionValidated: true,
          retryProcessing: 'background',
          deferBlackBoxPull: true,
          recoveryTicketId: recoveryTicket.id,
          backgroundProbeDelayMs: 180,
          skipRetryQueue: true,
          skipRealtimeResume: true,
        });

        this.recordRecoveryStep('blackbox-recovery', reason);
        const blackboxRefresh = await this.syncCoordinator.refreshBlackBoxWatermarkIfNeeded('resume');
        fastPathHit = blackboxRefresh.skipped;
        await this.recheckFocusGateIfNeeded(reason, 'resume-remote');

        this.recordRecoveryStep('ui-correction', reason);
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('nanoflow:lifecycle-resumed', {
            detail: {
              reason,
              resumedAt: Date.now(),
            },
          }));
        }

        this.lastHeavyRecoveryAtSignal.set(Date.now());
      } catch (error) {
        this.logger.warn('Resume background compensation failed', { reason, recoveryTicketId: recoveryTicket.id, error });
        this.sentryLazyLoader.captureException(error, {
          operation: 'lifecycle.resume.compensation',
          reason,
          recoveryTicketId: recoveryTicket.id,
        });
      } finally {
        const backgroundRefreshMs = this.monotonicNow() - backgroundStartAt;
        this.markPerformance(`${perfPrefix}:background-end`);
        this.measurePerformance(
          'resume.background_refresh_ms',
          `${perfPrefix}:background-start`,
          `${perfPrefix}:background-end`
        );
        this.reportRecoveryMetrics({
          ticketId: recoveryTicket.id,
          reason,
          interactionReadyMs,
          backgroundRefreshMs,
          fastPathHit,
        });
        this.compensationTicketIdSignal.set(null);
      }
    };

    if (typeof queueMicrotask === 'function') {
      queueMicrotask(() => {
        this.runIdleTask(() => {
          void runCompensation();
        });
      });
      return;
    }

    this.runIdleTask(() => {
      void runCompensation();
    });
  }

  private shouldRecheckFocusGate(reason: AppResumeReason): boolean {
    if (!FEATURE_FLAGS.FOCUS_STARTUP_THROTTLED_CHECK_V1) {
      return false;
    }

    if (reason === 'manual' || reason === 'online') {
      return false;
    }

    if (reason === 'pageshow') {
      return true;
    }

    return this.lastBackgroundDurationMs >= FOCUS_CONFIG.GATE.IDLE_RECHECK_THRESHOLD;
  }

  private async recheckFocusGateIfNeeded(
    reason: AppResumeReason,
    source: 'resume-local' | 'resume-remote'
  ): Promise<void> {
    if (!this.shouldRecheckFocusGate(reason)) {
      return;
    }

    if (source === 'resume-remote' && this.focusStartupProbe.hasPendingGateWork()) {
      this.logger.debug('Skip resume-remote gate recheck because local resume already found pending gate work');
      return;
    }

    await this.focusStartupProbe.recheckGate({
      source,
      reloadLocal: source === 'resume-local',
    });
  }

  private runIdleTask(task: () => void): void {
    const requestIdleCallback = typeof window !== 'undefined'
      ? (
          window as Window & {
            requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
          }
        ).requestIdleCallback
      : undefined;
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(() => task(), { timeout: 1200 });
      return;
    }
    setTimeout(task, 0);
  }

  private reportRecoveryMetrics(metrics: RecoveryMetricsSnapshot): void {
    const current = this.lastRecoveryMetricsSignal();
    const next = current && current.ticketId === metrics.ticketId
      ? { ...current, ...metrics }
      : metrics;
    this.lastRecoveryMetricsSignal.set(next);

    if (FEATURE_FLAGS.RESUME_METRICS_GATE_V1) {
      this.sentryLazyLoader.setMeasurement('resume.interaction_ready_ms', next.interactionReadyMs, 'millisecond');
      if (typeof next.backgroundRefreshMs === 'number') {
        this.sentryLazyLoader.setMeasurement('resume.background_refresh_ms', next.backgroundRefreshMs, 'millisecond');
      }
      if (typeof next.fastPathHit === 'boolean') {
        this.sentryLazyLoader.setMeasurement('resume.fast_path_hit', next.fastPathHit ? 1 : 0, 'none');
      }
    }

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('nanoflow:resume-metrics', {
        detail: next,
      }));
    }
  }

  private markPerformance(markName: string): void {
    if (typeof performance === 'undefined' || typeof performance.mark !== 'function') {
      return;
    }
    performance.mark(markName);
  }

  /**
   * 使用高精度单调时钟计算阶段耗时，避免 Date.now() 同毫秒下出现 0ms 抖动误判。
   */
  private monotonicNow(): number {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now();
    }
    return Date.now();
  }

  private measurePerformance(measureName: string, startMark: string, endMark: string): void {
    if (typeof performance === 'undefined' || typeof performance.measure !== 'function') {
      return;
    }
    try {
      performance.measure(measureName, { start: startMark, end: endMark });
    } catch {
      try {
        performance.measure(measureName, startMark, endMark);
      } catch {
        // ignored
      }
    }
  }

  private createRecoveryTicketId(mode: 'light' | 'heavy'): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `${mode}:${crypto.randomUUID()}`;
    }
    return `${mode}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(new Error(`Lifecycle resume timeout after ${timeoutMs}ms`));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  private recordRecoveryStep(step: string, reason: AppResumeReason): void {
    this.addLifecycleBreadcrumb('recovery.step', reason, { step });
  }

  private addLifecycleBreadcrumb(
    message: 'lifecycle.resume.start' | 'lifecycle.resume.reason' | 'lifecycle.resume.success' | 'lifecycle.resume.fail' | 'recovery.step' | 'lifecycle.version-reload.activate-ok' | 'lifecycle.version-reload.activate-failed',
    reason: AppResumeReason | 'manual',
    extra?: Record<string, unknown>
  ): void {
    this.sentryLazyLoader.addBreadcrumb({
      category: 'lifecycle',
      message,
      level: 'info',
      data: {
        reason,
        ...extra,
      },
    });
  }

  private scheduleDeferredResumeRetry(reason: AppResumeReason): number {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
      this.logger.info('页面仍处于后台，跳过 deferred resume 定时器，等待下一次可见恢复事件', { reason });
      return 0;
    }

    const delayMs = Math.max(100, getRemainingBrowserNetworkResumeDelayMs() + 50);

    if (this.deferredResumeTimer) {
      return delayMs;
    }

    this.logger.info('Resume recovery deferred, scheduling retry', { reason, delayMs });
    this.deferredResumeTimer = setTimeout(() => {
      this.deferredResumeTimer = null;
      void this.triggerResume(reason);
    }, delayMs);

    return delayMs;
  }

  /**
   * 「检测到新版本」toast 的「立即刷新」点击处理。
   *
   * 流程：
   * 1. 若可用，先 `swUpdate.activateUpdate()` 让 waiting SW 真正进入 active；
   * 2. 然后 `reloadViaForceClearCache()` 触发清缓存 + 导航。
   * 3. 任一步抛错都不会传出（让 toast 容器的 finally 解锁 UI）；
   *    若导航没有真正发生（catch 命中），flag 会复位，下一次 resume 仍能再次弹出
   *    prompt（避免「点了没反应」+「不再提示」双重糟糕体验）。
   *
   * 注：成功路径下 `reloadViaForceClearCache()` 会触发 `location.replace` 导航，
   * 当前文档被卸载，本函数后续代码与 `finally` 块都不会被执行；因此 flag 复位
   * 只在异常路径才有意义。
   */
  private async triggerVersionReload(): Promise<void> {
    try {
      if (this.swUpdate?.isEnabled) {
        try {
          await this.swUpdate.activateUpdate();
          this.addLifecycleBreadcrumb('lifecycle.version-reload.activate-ok', 'manual', {});
        } catch (err) {
          this.addLifecycleBreadcrumb('lifecycle.version-reload.activate-failed', 'manual', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      reloadViaForceClearCache();
      // 正常路径下文档已被 location.replace 卸载，此后代码不会执行。
    } catch (err) {
      // 仅在 reloadViaForceClearCache 同步抛错（极端环境）时复位 flag。
      this.logger.warn('triggerVersionReload failed', err);
      this.hasShownResumeVersionPrompt = false;
    }
  }

  private maybeScheduleAutoReload(reason: AppResumeReason, error: unknown): void {
    if (this.autoReloadScheduled) {
      return;
    }

    if (this.consecutiveFailures < APP_LIFECYCLE_CONFIG.AUTO_RELOAD_FAILURE_THRESHOLD) {
      return;
    }

    if (!this.consumeAutoReloadQuota()) {
      return;
    }

    this.autoReloadScheduled = true;

    this.toast.warning(
      '恢复失败',
      '系统将自动刷新页面以恢复稳定状态',
      { duration: 2500 }
    );

    this.sentryLazyLoader.captureMessage('Lifecycle auto reload scheduled', {
      level: 'warning',
      tags: {
        operation: 'lifecycle.auto-reload',
        reason,
        failureKind: 'pipeline-exception',
      },
      extra: {
        error: error instanceof Error ? error.message : String(error),
        consecutiveFailures: this.consecutiveFailures,
      },
    });

    setTimeout(() => {
      reloadViaForceClearCache();
    }, 1500);
  }

  private consumeAutoReloadQuota(): boolean {
    if (typeof localStorage === 'undefined') {
      return false;
    }

    const today = new Date().toISOString().slice(0, 10);

    try {
      const raw = localStorage.getItem(AppLifecycleOrchestratorService.AUTO_RELOAD_COUNTER_KEY);
      const parsed = raw ? JSON.parse(raw) as { date?: string; count?: number } : {};

      const date = parsed.date === today ? today : today;
      const count = parsed.date === today ? (parsed.count ?? 0) : 0;

      if (count >= APP_LIFECYCLE_CONFIG.MAX_AUTO_RELOAD_PER_DAY) {
        return false;
      }

      localStorage.setItem(
        AppLifecycleOrchestratorService.AUTO_RELOAD_COUNTER_KEY,
        JSON.stringify({ date, count: count + 1 })
      );

      return true;
    } catch {
      return false;
    }
  }

  private cleanup(): void {
    if (this.deferredResumeTimer) {
      clearTimeout(this.deferredResumeTimer);
      this.deferredResumeTimer = null;
    }

    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return;
    }

    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }

    if (this.blurHandler) {
      window.removeEventListener('blur', this.blurHandler);
      this.blurHandler = null;
    }

    if (this.focusHandler) {
      window.removeEventListener('focus', this.focusHandler);
      this.focusHandler = null;
    }

    if (this.pageshowHandler) {
      window.removeEventListener('pageshow', this.pageshowHandler as EventListener);
      this.pageshowHandler = null;
    }

    if (this.onlineHandler) {
      window.removeEventListener('online', this.onlineHandler);
      this.onlineHandler = null;
    }

    this.initialized = false;
  }
}
