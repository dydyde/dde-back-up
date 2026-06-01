/* eslint-disable max-lines -- Legacy workspace shell still coordinates startup/auth/sync lifecycles until the remaining shell extraction is completed. */
import { Component, ChangeDetectionStrategy, inject, signal, HostListener, computed, OnInit, OnDestroy, DestroyRef, effect, Type, NgZone, Injector, AfterViewInit, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router, NavigationEnd, RouterOutlet } from '@angular/router';
import { UiStateService } from './services/ui-state.service';
import { ProjectStateService } from './services/project-state.service';
import { TaskOperationAdapterService } from './services/task-operation-adapter.service';
import { PreferenceService } from './services/preference.service';
import { UserSessionService } from './services/user-session.service';
import { ProjectOperationService } from './services/project-operation.service';
import { UndoService } from './services/undo.service';
import { ToastService } from './services/toast.service';
import { ActionQueueService } from './services/action-queue.service';
import { LoggerService } from './services/logger.service';
import { GlobalErrorHandler } from './services/global-error-handler.service';
import { ModalService, type DeleteProjectData, type LoginData } from './services/modal.service';
import {
  WorkspaceModalCoordinatorService,
  type ModalCallbacks,
} from './services/workspace-modal-coordinator.service';
import { SyncCoordinatorService } from './services/sync-coordinator.service';
import { SupabaseClientService } from './services/supabase-client.service';
import { SimpleSyncService } from './app/core/services/simple-sync.service';
import { SearchService } from './services/search.service';
import { ParkingService } from './services/parking.service';
import { BlackBoxService } from './services/black-box.service';
import { FocusPreferenceService } from './services/focus-preference.service';
import { BeforeUnloadManagerService } from './services/before-unload-manager.service';
import { BeforeUnloadGuardService, isLocalModeEnabled } from './services/guards';
import { AppAuthCoordinatorService } from './app/core/services/app-auth-coordinator.service';
import { AppProjectCoordinatorService } from './app/core/services/app-project-coordinator.service';
import { ToastContainerComponent } from './app/shared/components/toast-container.component';
import { SyncStatusComponent } from './app/shared/components/sync-status.component';
import { OfflineBannerComponent } from './app/shared/components/offline-banner.component';
import { DemoBannerComponent } from './app/shared/components/demo-banner.component';
import { PwaInstallPromptBannerComponent } from './app/shared/components/pwa-install-prompt-banner.component';
import { WorkspaceShellCoreComponent } from './app/core/shell/workspace-shell-core.component';
import { WorkspaceSidebarComponent } from './app/core/shell/workspace-sidebar.component';
import { WorkspaceOverlaysComponent } from './app/core/shell/workspace-overlays.component';
import type { StorageEscapeData } from './app/shared/modals';
import { SwUpdate, VersionReadyEvent } from '@angular/service-worker';
import { filter, map, startWith } from 'rxjs/operators';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { ThemeType, Project } from './models';
import { UI_CONFIG } from './config/ui.config';
import { FEATURE_FLAGS, validateCriticalFlags } from './config/feature-flags.config';
import { AUTH_CONFIG } from './config/auth.config';
import { FocusModeComponent } from './app/features/focus/focus-mode.component';
import { showBlackBoxPanel, gateState } from './state/focus-stores';
import { shouldAutoCloseSidebarOnViewportChange } from './utils/layout-stability';
import { ExportService } from './services/export.service';
import { AppLifecycleOrchestratorService } from './services/app-lifecycle-orchestrator.service';
import { NetworkAwarenessService } from './services/network-awareness.service';
import { FocusStartupProbeService } from './services/focus-startup-probe.service';
import { SentryLazyLoaderService } from './services/sentry-lazy-loader.service';
import { StartupTierOrchestratorService } from './services/startup-tier-orchestrator.service';
import { AuthService } from './services/auth.service';
import { EventBusService } from './services/event-bus.service';
import { BootStageService } from './services/boot-stage.service';
import { HandoffCoordinatorService } from './services/handoff-coordinator.service';
import { LaunchSnapshotService } from './services/launch-snapshot.service';
import { TaskStore } from './services/stores';
import { DockEngineService } from './services/dock-engine.service';
import { WidgetBindingService, type AndroidWidgetBootstrapCallbackResult } from './services/widget-binding.service';
import { reloadViaForceClearCache } from './utils/force-clear-cache';
import {
  hasAndroidWidgetBootstrapFlag,
  normalizeAndroidWidgetBootstrapRequest,
  normalizeStartupEntryIntent,
  resolveAndroidWidgetBootstrapRequest,
  resolveStartupEntryIntent,
  resolveStartupEntryRouteIntent,
  type AndroidWidgetBootstrapRequest,
  type StartupEntryIntent,
} from './utils/startup-entry-intent';
import { APP_LIFECYCLE_CONFIG } from './config/app-lifecycle.config';
import { STARTUP_PERF_CONFIG } from './config/startup-performance.config';
import {
  resolveDockFocusChromeLayoutLocked,
  type DockFocusChromePhase,
} from './utils/dock-focus-phase';
import { readRuntimePlatformSnapshot } from './utils/runtime-platform';

function readTextInputValue(event: Event | string): string {
  if (typeof event === 'string') return event;
  const target = event.target as { value?: unknown } | null;
  return typeof target?.value === 'string' ? target.value : '';
}

type RemoteChangeHandlerLike = {
  setupCallbacks: (callbacks: {
    onLoadProjects?: () => Promise<void>;
    onRefreshActiveProject?: (reason: string) => Promise<void>;
  }) => void;
};

type EventDrivenSyncPulseLike = {
  initialize: () => void;
  destroy: () => void;
  triggerNow: (reason: 'focus-entry' | 'manual' | 'focus' | 'visible' | 'pageshow' | 'online' | 'heartbeat') => Promise<{
    status: 'success' | 'failed' | 'skipped';
    skipReason?: 'disabled' | 'cooldown' | 'offline' | 'hidden' | 'unauthenticated' | 'resuming' | 'compensating' | 'post-heavy-cooldown' | 'same-ticket';
    retryAfterMs?: number;
  }>;
};

type StartupDiagnosticsLike = {
  initialize: () => Promise<void> | void;
};

type SwUpdateCheckReason = 'startup' | 'periodic' | 'visibility' | 'focus' | 'online';

const DATA_PROTECTION_REMINDER_TITLE = '数据备份提醒';
const DATA_PROTECTION_REMINDER_MESSAGE = '已超过 7 天未完成数据备份，建议前往设置执行导出或本地备份。';
const ANDROID_WIDGET_BOOTSTRAP_STORAGE_KEY = 'nanoflow.android-widget-bootstrap';
const ANDROID_WIDGET_STARTUP_INTENT_STORAGE_KEY = 'nanoflow.android-widget-startup-intent';
const SIDEBAR_SEARCH_FOCUS_DELAY_MS = 50;

/**
 * 应用根组件
 * 
 * 认证逻辑委托到 AppAuthCoordinatorService
 */
@Component({
  selector: 'app-workspace-shell',
  standalone: true,
  imports: [
    CommonModule,
    RouterOutlet,
    ToastContainerComponent,
    SyncStatusComponent,
    OfflineBannerComponent,
    DemoBannerComponent,
    PwaInstallPromptBannerComponent,
    WorkspaceShellCoreComponent,
    WorkspaceSidebarComponent,
    WorkspaceOverlaysComponent,
    // Focus 覆盖层仍走模板 defer
    FocusModeComponent,
  ],
  templateUrl: './workspace-shell.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})

export class WorkspaceShellComponent implements OnInit, OnDestroy, AfterViewInit {
  private static readonly DEMO_BANNER_DISMISS_STORAGE_KEY = 'nanoflow.demo-banner-dismissed';
  
  public throwTestError(): void {
    throw new Error("Sentry Test Error");
  }

  private readonly logger = inject(LoggerService).category('App');
  private readonly injector = inject(Injector);
  private readonly uiState = inject(UiStateService);
  private readonly ngZone = inject(NgZone);

  private readonly projectState = inject(ProjectStateService);
  private readonly taskStore = inject(TaskStore);
  private readonly taskOpsAdapter = inject(TaskOperationAdapterService);
  private readonly preferenceService = inject(PreferenceService);
  private readonly userSession = inject(UserSessionService);
  private readonly projectOps = inject(ProjectOperationService);

  // ========== 延迟注入服务（P0-3 性能优化 2026-03-24）==========
  // 以下服务不在首屏渲染路径上，改为按需获取以减少首次 DI 解析耗时。
  // 权衡说明：
  // - 优点：推迟非关键服务构造函数执行，减少 WorkspaceShell 初始化阻塞
  // - 缺点：绕过 Angular 编译期 DI 检查，需靠测试覆盖保障正确性
  // TODO: 长期方案是将这些服务的 UI 消费方改用 @defer 延迟渲染，
  //       届时可恢复为标准 inject()。参见 Angular RFC: Deferred Views。
  private _searchService?: SearchService;
  private get searchService(): SearchService {
    return (this._searchService ??= this.injector.get(SearchService));
  }
  private _parkingService?: ParkingService;
  private get parkingService(): ParkingService {
    return (this._parkingService ??= this.injector.get(ParkingService));
  }
  private _blackBoxService?: BlackBoxService;
  private get blackBoxService(): BlackBoxService {
    return (this._blackBoxService ??= this.injector.get(BlackBoxService));
  }
  private _exportService?: ExportService;
  private get exportService(): ExportService {
    return (this._exportService ??= this.injector.get(ExportService));
  }
  private _focusStartupProbe?: FocusStartupProbeService;
  private get focusStartupProbe(): FocusStartupProbeService {
    return (this._focusStartupProbe ??= this.injector.get(FocusStartupProbeService));
  }
  private _simpleSync?: SimpleSyncService;
  private get simpleSync(): SimpleSyncService {
    return (this._simpleSync ??= this.injector.get(SimpleSyncService));
  }
  readonly focusPrefs = inject(FocusPreferenceService);
  private readonly authService = inject(AuthService);
  private readonly widgetBinding = inject(WidgetBindingService);

  /** 认证协调器 — 管理所有认证相关状态和操作 */
  readonly authCoord = inject(AppAuthCoordinatorService);
  /** 项目 UI 协调器 — 管理项目列表 UI 状态和操作 */
  readonly projectCoord = inject(AppProjectCoordinatorService);

  // ========== 模板所需的公共 getter（暴露给 HTML 模板）==========
  
  /** UI 状态 */
  get isMobile() { return this.uiState.isMobile; }
  get sidebarWidth() { return this.uiState.sidebarWidth; }
  
  /** 项目/任务数据 */
  get projects() { return this.projectState.projects; }
  get activeProject() { return this.projectState.activeProject; }
  // 直接暴露 signal，而不是 getter - 模板中需要调用 activeProjectId()
  readonly activeProjectId = this.projectState.activeProjectId;
  get deletedTasks() { return this.projectState.deletedTasks; }
  get currentUserId() { return this.userSession.currentUserId; }
  hintOnlyStartupPlaceholderVisible(): boolean {
    return this.userSession.isHintOnlyStartupPlaceholderVisible();
  }

  showBlockingStartupHintOverlay(): boolean {
    return this.hintOnlyStartupPlaceholderVisible() && !this.isMobile();
  }

  showCompactStartupHintBanner(): boolean {
    return this.hintOnlyStartupPlaceholderVisible() && this.isMobile();
  }

  isMobileOfflineNoticeVisible(): boolean {
    return this.isMobile() && (
      !this.networkAwareness.isOnline()
      || this.offlineMode()
      || this.actionQueue.queueFrozen()
    );
  }

  showMobileDemoBanner(): boolean {
    if (!this.isMobile()) {
      return false;
    }

    if (this.isDemoBannerDismissed()) {
      return false;
    }

    return isLocalModeEnabled()
      || this.currentUserId() === AUTH_CONFIG.LOCAL_MODE_USER_ID
      || (FEATURE_FLAGS.DEMO_MODE_ENABLED ?? false);
  }

  resolveMobileFloatingNoticeBaseTopOffsetPx(): number {
    const demoOffset = this.showMobileDemoBanner() ? 104 : 0;
    if (this.isMobileOfflineNoticeVisible()) {
      const offlineTopOffset = demoOffset > 0 ? demoOffset : 42;
      return offlineTopOffset + 42;
    }

    return demoOffset;
  }

  installPromptTop(): string {
    const topOffset = this.isMobile()
      ? Math.max(12, this.resolveMobileFloatingNoticeBaseTopOffsetPx())
      : 12;
    return `calc(env(safe-area-inset-top, 0px) + ${topOffset}px)`;
  }

  compactStartupHintBannerTop(): string {
    let topOffset = 56;

    if (this.isMobile()) {
      if (this.isMobileOfflineNoticeVisible()) {
        topOffset = Math.max(topOffset, 84);
      }

      topOffset = Math.max(topOffset, this.resolveMobileFloatingNoticeBaseTopOffsetPx());

      if (this.showInstallPrompt()) {
        topOffset = Math.max(topOffset, Math.max(12, this.resolveMobileFloatingNoticeBaseTopOffsetPx()) + 44);
      }
    }

    return `calc(env(safe-area-inset-top, 0px) + ${topOffset}px)`;
  }

  private isDemoBannerDismissed(): boolean {
    if (typeof localStorage === 'undefined') {
      return false;
    }

    try {
      const raw = localStorage.getItem(WorkspaceShellComponent.DEMO_BANNER_DISMISS_STORAGE_KEY);
      if (!raw) {
        return false;
      }

      const data = JSON.parse(raw) as { timestamp?: unknown } | null;
      if (!data || typeof data.timestamp !== 'number') {
        localStorage.removeItem(WorkspaceShellComponent.DEMO_BANNER_DISMISS_STORAGE_KEY);
        return false;
      }

      const dismissExpiryMs = 7 * 24 * 60 * 60 * 1000;
      if (Date.now() - data.timestamp < dismissExpiryMs) {
        return true;
      }

      localStorage.removeItem(WorkspaceShellComponent.DEMO_BANNER_DISMISS_STORAGE_KEY);
      return false;
    } catch {
      return false;
    }
  }

  private blockHintOnlyMutation(actionLabel: string): boolean {
    if (!this.userSession.isHintOnlyStartupPlaceholderVisible()) {
      return false;
    }

    this.toast.info('会话确认中', `${actionLabel}暂不可用，owner 确认完成前保持只读`);
    return true;
  }
  
  /** 同步状态 */
  get offlineMode() { return this.syncCoordinator.offlineMode; }
  get sessionExpired() { return this.syncCoordinator.sessionExpired; }
  
  /** 搜索结果 */
  get searchResults() { return this.searchService.searchResults; }
  get filteredProjects() { return this.searchService.filteredProjects; }
  
  /** 辅助方法 */
  compressDisplayId(displayId: string): string {
    return this.projectState.compressDisplayId(displayId);
  }
  
  setActiveProjectId(id: string | null): void {
    this.userSession.switchActiveProject(id);
  }
  private readonly undoService = inject(UndoService);
  private readonly swUpdate = inject(SwUpdate);
  private readonly toast = inject(ToastService);
  private readonly actionQueue = inject(ActionQueueService);
  private readonly errorHandler = inject(GlobalErrorHandler);
  private readonly modal = inject(ModalService);
  readonly modalCoord = inject(WorkspaceModalCoordinatorService);
  private readonly syncCoordinator = inject(SyncCoordinatorService);
  readonly supabaseClient = inject(SupabaseClientService);
  private readonly beforeUnloadManager = inject(BeforeUnloadManagerService);
  private readonly beforeUnloadGuard = inject(BeforeUnloadGuardService);
  
  /** 数据保护服务（延迟注入，见上方 getter） */
  private readonly appLifecycle = inject(AppLifecycleOrchestratorService);
  private readonly networkAwareness = inject(NetworkAwarenessService);
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly startupTier = inject(StartupTierOrchestratorService);
  private readonly eventBus = inject(EventBusService);
  readonly bootStage = inject(BootStageService);
  private readonly handoffCoordinator = inject(HandoffCoordinatorService);
  private readonly launchSnapshot = inject(LaunchSnapshotService);
  private readonly startupLaunchSnapshot = this.launchSnapshot.read();
  
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  /** 路由 URL 信号化 — 保证 effect 内可响应导航变化 */
  private readonly routeUrl = toSignal(
    this.router.events.pipe(
      filter((event): event is NavigationEnd => event instanceof NavigationEnd),
      map((event) => event.urlAfterRedirects),
      startWith(this.router.url),
    ),
    { initialValue: this.router.url },
  );

  /** 代理 UiStateService.sidebarOpen，所有 .set()/.update() 调用均作用于服务层信号 */
  get isSidebarOpen() { return this.uiState.sidebarOpen; }
  isFilterOpen = signal(false);
  readonly focusSessionTriggerComponent = signal<Type<unknown> | null>(null);
  readonly blackBoxRecorderComponent = signal<Type<unknown> | null>(null);
  readonly blackBoxRecorderOutletInputs = {
    appearance: 'obsidian' as const,
    onTranscribed: (text: string) => this.onSidebarVoiceTranscribed(text),
  };

  private focusSessionTriggerLoadPromise: Promise<Type<unknown> | null> | null = null;
  private blackBoxRecorderLoadPromise: Promise<Type<unknown> | null> | null = null;
  private focusModePreloadPromise: Promise<void> | null = null;
  private startupFontSchedulerInitPromise: Promise<void> | null = null;
  private focusModePreloadScheduled = false;

  /**
   * 核心数据是否已加载完毕
   *
   * 【性能优化 2026-02-14】用于 FocusMode @defer 条件守卫
   * 首屏核心数据加载完成后才触发 FocusMode 及其 BlackBox 同步
   * 避免登录后前 5-10s 并发请求峰值
   */
  readonly coreDataLoaded = computed(() => {
    // 会话检查完成（无论成功或失败）
    const sessionCheckDone = !this.authCoord.isCheckingSession();
    // 用户已认证（有 userId）
    const hasUser = !!this.currentUserId();
    // 不在认证加载中
    const notAuthLoading = !this.authCoord.isAuthLoading();
    return sessionCheckDone && hasUser && notAuthLoading;
  });

  private readonly dockEngine = inject(DockEngineService);
  /** 专注虚化激活：专注模式开启且虚化开关打开时，对背景内容施加模糊 */
  readonly focusBlurActive = computed(
    () => this.dockEngine.focusMode() && this.dockEngine.focusScrimOn(),
  );
  /**
   * 专注接管激活：进入/退出专注的整个接管窗口内，
   * 工作区外层 chrome（侧边栏、分隔条）统一退场。
   *
   * 根因：
   * - 左侧项目栏曾单独做 filter blur，右侧项目内容又走另一套 blur；
   * - 两个 stacking context 叠在一起，导致左侧虚影类型、透明度、高度都与右侧不一致；
   * - HUD 拖到左侧时，会被更外层的 sidebar blur 面盖住。
   *
   * 处理：外层 chrome 不再单独 blur，而是在接管期直接收起并禁用交互，
   * 让右侧 ProjectShell 的统一 focus content effect 成为唯一背景层。
   */
  readonly focusWorkspaceTakeoverActive = computed(() => this.resolveFocusWorkspaceTakeoverActive());
  readonly focusWorkspaceTakeoverPhase = computed(() => this.resolveFocusWorkspaceTakeoverPhase());
  readonly workspaceSidebarWidthPx = computed(() => this.resolveWorkspaceSidebarWidth());
  readonly mobileSidebarBackdropVisible = computed(
    () => this.uiState.isMobile() && this.uiState.sidebarOpen() && !this.focusWorkspaceTakeoverActive(),
  );
  readonly workspaceSidebarOpacity = computed(() => this.resolveWorkspaceSidebarOpacity());
  readonly workspaceSidebarTransform = computed(() => this.resolveWorkspaceSidebarTransform());
  readonly workspaceSidebarPointerEvents = computed(() => this.resolveWorkspaceSidebarPointerEvents());
  readonly workspaceSidebarTransition = computed(() => this.resolveWorkspaceSidebarTransition());
  readonly workspaceSidebarContentOpacity = computed(() => this.resolveWorkspaceSidebarContentOpacity());
  readonly workspaceSidebarContentTransform = computed(() => this.resolveWorkspaceSidebarContentTransform());
  readonly workspaceSidebarContentTransition = computed(() => this.resolveWorkspaceSidebarContentTransition());

  private resolveFocusWorkspaceTakeoverActive(): boolean {
    return this.resolveFocusWorkspaceTakeoverPhase() !== 'idle';
  }

  private resolveFocusWorkspaceTakeoverPhase(): DockFocusChromePhase {
    return this.dockEngine.focusChromePhase();
  }

  private resolveWorkspaceSidebarWidth(): number {
    if (this.uiState.isMobile()) return 240;
    if (!this.uiState.sidebarOpen()) return 0;
    return this.uiState.sidebarWidth();
  }

  private resolveWorkspaceSidebarOpacity(): string {
    const phase = this.resolveFocusWorkspaceTakeoverPhase();
    if (phase === 'entering' || phase === 'focused') return '0';
    if (phase === 'exiting') return this.uiState.isMobile() ? '0' : '1';
    return '1';
  }

  private resolveWorkspaceSidebarTransform(): string {
    const isMobile = this.uiState.isMobile();
    const phase = this.resolveFocusWorkspaceTakeoverPhase();
    if (resolveDockFocusChromeLayoutLocked(phase)) {
      if (phase === 'restoring') {
        return isMobile ? 'translateX(calc(-100% - 12px))' : 'translateX(0) scale(1)';
      }
      if (phase === 'exiting') {
        return isMobile ? 'translateX(calc(-100% - 12px))' : 'translateX(0) scale(1)';
      }
      return isMobile ? 'translateX(calc(-100% - 12px))' : 'translateX(-8px) scale(0.992)';
    }
    if (isMobile) {
      return this.uiState.sidebarOpen() ? 'translateX(0)' : 'translateX(calc(-100% - 12px))';
    }
    return 'translateX(0) scale(1)';
  }

  private resolveWorkspaceSidebarPointerEvents(): 'none' | 'auto' {
    if (this.resolveFocusWorkspaceTakeoverPhase() !== 'idle') return 'none';
    if (this.uiState.isMobile() && !this.uiState.sidebarOpen()) return 'none';
    return 'auto';
  }

  private resolveWorkspaceSidebarTransition(): string {
    const phase = this.resolveFocusWorkspaceTakeoverPhase();
    if (this.uiState.isMobile()) {
      // 移动端：使用完整的 smooth-restore 时长
      return 'opacity var(--pk-shell-smooth-restore) var(--pk-ease-standard),'
        + ' transform var(--pk-shell-smooth-restore) var(--pk-ease-restore)';
    }
    if (phase === 'restoring') {
      // 恢复阶段：宽度先恢复（使用 snappy 曲线防止弹出感），opacity/transform 跟随
      // 宽度用稍短时长+ snappy 曲线，避免「慢慢打开」的疲惫感
      return 'width var(--pk-shell-smooth-restore) var(--pk-ease-restore-snappy),'
        + ' opacity var(--pk-shell-smooth-restore) var(--pk-ease-restore),'
        + ' transform var(--pk-shell-smooth-restore) var(--pk-ease-restore)';
    }
    if (phase === 'exiting') {
      // 退出阶段：快速收起（入场时长但用 standard 曲线，感觉更利落）
      return 'width var(--pk-shell-enter) var(--pk-ease-standard),'
        + ' opacity var(--pk-shell-enter) var(--pk-ease-standard),'
        + ' transform var(--pk-shell-enter) var(--pk-ease-standard)';
    }
    // entering / focused / idle：入场时快速隐藏侧边栏，exit 时用 overlay-exit 给予短促退场感
    return 'width var(--pk-shell-enter) var(--pk-ease-standard),'
      + ' opacity var(--pk-overlay-exit) var(--pk-ease-exit),'
      + ' transform var(--pk-shell-enter) var(--pk-ease-enter)';
  }

  private resolveWorkspaceSidebarContentOpacity(): string {
    const phase = this.resolveFocusWorkspaceTakeoverPhase();
    if (phase === 'entering' || phase === 'focused') return '0';
    if (phase === 'exiting') return this.uiState.isMobile() ? '0' : '1';
    return '1';
  }

  private resolveWorkspaceSidebarContentTransform(): string {
    const phase = this.resolveFocusWorkspaceTakeoverPhase();
    if (phase === 'entering' || phase === 'focused') {
      return this.uiState.isMobile() ? 'translateX(-8px)' : 'translateX(-8px)';
    }
    if (phase === 'exiting') {
      return this.uiState.isMobile() ? 'translateX(-4px)' : 'translateX(0)';
    }
    if (phase === 'restoring') {
      return 'translateX(0)';
    }
    return 'translateX(0)';
  }

  private resolveWorkspaceSidebarContentTransition(): string {
    if (this.uiState.isMobile()) {
      return 'opacity var(--pk-shell-smooth-restore) var(--pk-ease-restore),'
        + ' transform var(--pk-shell-smooth-restore) var(--pk-ease-restore)';
    }

    const phase = this.resolveFocusWorkspaceTakeoverPhase();
    if (phase === 'restoring') {
      // content 延迟 120ms 显示：让侧边栏宽度先展开，再显示文字内容，避免文字在窄宽度下挤压
      return 'opacity var(--pk-shell-smooth-restore) var(--pk-ease-restore) 120ms,'
        + ' transform var(--pk-shell-smooth-restore) var(--pk-ease-restore)';
    }

    return 'opacity var(--pk-overlay-exit) var(--pk-ease-standard),'
      + ' transform var(--pk-shell-exit) var(--pk-ease-standard)';
  }

  /** FocusMode 用户明确交互信号（点击/按键后激活） */
  readonly focusModeIntentActivated = signal(!FEATURE_FLAGS.FOCUS_STARTUP_THROTTLED_CHECK_V1);
  /** FocusMode 挂载条件：探针命中待处理 gate 或用户交互 或 dev 强制显示 */
  readonly shouldMountFocusMode = computed(() => {
    // 开发测试强制显示大门时，gateState 会直接设为 'reviewing'，绕过 coreDataLoaded 检查
    if (gateState() === 'reviewing') return true;

    // Focus 覆盖层在本地模式/纯离线模式下也需要按需挂载，
    // 不能把“存在云端 userId”误当成唯一的数据就绪条件。
    const sessionCheckDone = !this.authCoord.isCheckingSession();
    const notAuthLoading = !this.authCoord.isAuthLoading();
    const hasFocusModeAccess =
      !!this.currentUserId()
      || isLocalModeEnabled()
      || !this.authService.isConfigured;

    if (!sessionCheckDone || !notAuthLoading || !hasFocusModeAccess) return false;
    if (!FEATURE_FLAGS.FOCUS_STARTUP_THROTTLED_CHECK_V1) return true;
    return this.focusStartupProbe.hasPendingGateWork() || this.focusModeIntentActivated();
  });
  readonly shouldMountDeferredSyncStatus = computed(() => {
    if (!FEATURE_FLAGS.SYNC_STATUS_DEFERRED_MOUNT_V1) {
      return true;
    }

    // 会话检查完成后直接挂载同步状态（SyncStatusComponent 无副作用，安全挂载）
    const sessionCheckDone = !this.authCoord.isCheckingSession();
    if (sessionCheckDone) {
      return true;
    }

    // 会话检查进行中时，若有同步异常或 p2 层已就绪也提前挂载
    const hasSyncIssue =
      this.syncCoordinator.pendingActionsCount() > 0 ||
      this.syncCoordinator.offlineMode() ||
      !this.syncCoordinator.isOnline() ||
      !!this.syncCoordinator.syncError();

    return this.startupTier.isTierReady('p2') || hasSyncIssue;
  });
  
  /** 模态框加载中状态。Modal 协调器动态加载前由壳层先承接按钮反馈。 */
  readonly modalLoading = signal<Record<string, boolean>>({});

  /** 检查指定类型的模态框是否正在加载 */
  isModalLoading(type: string): boolean {
    return this.modalLoading()[type] ?? this.modalCoordRef?.isModalLoading(type) ?? this.modalCoord.isModalLoading(type);
  }

  private setModalLoading(type: string, loading: boolean): void {
    this.modalLoading.update(state => {
      const next = { ...state };
      if (loading) {
        next[type] = true;
      } else {
        delete next[type];
      }
      return next;
    });
  }

  private async getModalCoord(): Promise<WorkspaceModalCoordinatorService> {
    if (this.modalCoordRef) {
      return this.modalCoordRef;
    }

    if (!this.modalCoordPromise) {
      this.modalCoordPromise = import('./services/workspace-modal-coordinator.service')
        .then((module) => {
          const modalCoord = this.injector.get(module.WorkspaceModalCoordinatorService);
          if (!this.destroyed) {
            modalCoord.initCallbacks(this.createModalCallbacks());
          }
          this.modalCoordRef = modalCoord;
          return modalCoord;
        })
        .finally(() => {
          this.modalCoordPromise = null;
        });
    }

    return this.modalCoordPromise;
  }

  private createModalCallbacks(): ModalCallbacks {
    return {
      signOut: () => this.signOut(),
      updateTheme: (theme: ThemeType) => this.updateTheme(theme),
      handleImportComplete: (project: Project) => void this.handleImportComplete(project),
      handleLoginFromModal: (data) => void this.handleLoginFromModal(data),
      handleSignupFromModal: (data) => void this.handleSignupFromModal(data),
      handleResetPasswordFromModal: (email) => void this.handleResetPasswordFromModal(email),
      handleLocalModeFromModal: () => this.handleLocalModeFromModal(),
      confirmCreateProject: (name, desc) => void this.confirmCreateProject(name, desc),
      handleMigrationComplete: () => this.handleMigrationComplete(),
      closeMigrationModal: () => this.closeMigrationModal(),
    };
  }

  private async runModalAction(
    loadingType: string | null,
    action: (modalCoord: WorkspaceModalCoordinatorService) => Promise<void> | void,
  ): Promise<void> {
    if (loadingType && this.isModalLoading(loadingType)) {
      return;
    }

    if (loadingType) {
      this.setModalLoading(loadingType, true);
    }

    try {
      const modalCoord = await this.getModalCoord();
      await action(modalCoord);
    } finally {
      if (loadingType) {
        this.setModalLoading(loadingType, false);
      }
    }
  }

  // 手机端滑动切换状态
  private touchStartX = 0;
  private touchStartY = 0;
  private isSwiping = false;
  
  // 侧边栏滑动状态
  private sidebarTouchStartX = 0;
  private sidebarTouchStartY = 0;
  private isSidebarSwiping = false;
  
  // 侧边栏滑动手势处理
  onSidebarTouchStart(e: TouchEvent) {
    if (!this.uiState.isMobile()) return;
    if (e.touches.length !== 1) return;
    
    this.sidebarTouchStartX = e.touches[0].clientX;
    this.sidebarTouchStartY = e.touches[0].clientY;
    this.isSidebarSwiping = false;
  }
  
  onSidebarTouchMove(e: TouchEvent) {
    if (!this.uiState.isMobile()) return;
    if (e.touches.length !== 1) return;
    
    const deltaX = e.touches[0].clientX - this.sidebarTouchStartX;
    const deltaY = Math.abs(e.touches[0].clientY - this.sidebarTouchStartY);
    
    // 向左滑动且水平距离大于垂直距离（使用配置常量）
    if (deltaX < -UI_CONFIG.GESTURE_MIN_DISTANCE && Math.abs(deltaX) > deltaY * UI_CONFIG.GESTURE_DIRECTION_RATIO) {
      this.isSidebarSwiping = true;
    }
  }
  
  onSidebarTouchEnd(e: TouchEvent) {
    if (!this.uiState.isMobile()) return;
    if (!this.isSidebarSwiping) return;
    
    const deltaX = e.changedTouches[0].clientX - this.sidebarTouchStartX;
    const threshold = 50; // 滑动阈值（从60减小到50）
    
    // 向左滑动关闭侧边栏
    if (deltaX < -threshold) {
      this.isSidebarOpen.set(false);
    }
    
    this.isSidebarSwiping = false;
  }
  
  // 手机端滑动手势处理
  onMainTouchStart(e: TouchEvent) {
    if (!this.uiState.isMobile()) return;
    if (e.touches.length !== 1) return;
    
    this.touchStartX = e.touches[0].clientX;
    this.touchStartY = e.touches[0].clientY;
    this.isSwiping = false;
  }
  
  onMainTouchMove(e: TouchEvent) {
    if (!this.uiState.isMobile()) return;
    if (e.touches.length !== 1) return;
    
    const deltaX = e.touches[0].clientX - this.touchStartX;
    const deltaY = Math.abs(e.touches[0].clientY - this.touchStartY);
    
    // 只有水平滑动距离大于垂直滑动时才认为是切换手势（使用配置常量）
    if (Math.abs(deltaX) > UI_CONFIG.GESTURE_MIN_DISTANCE && Math.abs(deltaX) > deltaY * UI_CONFIG.GESTURE_DIRECTION_RATIO) {
      this.isSwiping = true;
    }
  }
  
  onMainTouchEnd(e: TouchEvent) {
    if (!this.uiState.isMobile()) return;
    if (!this.isSwiping) return;
    
    const deltaX = e.changedTouches[0].clientX - this.touchStartX;
    const threshold = 50; // 滑动阈值
    
    // 向右滑动打开侧边栏
    // 但在流程图视图中不响应，避免与画布操作冲突
    if (deltaX > threshold && this.uiState.activeView() !== 'flow') {
      this.isSidebarOpen.set(true);
    }
    
    this.isSwiping = false;
  }

  readonly showSettingsAuthForm = this.authCoord.showSettingsAuthForm;
  
  // ========== 模态框状态（代理到 ModalService）==========
  // 使用 ModalService 统一管理，以下为便捷访问器
  
  /** 冲突数据已迁移到 _pendingConflict 字段（命令式模态框方案） */
  
  currentFilterLabel = computed(() => {
    const filterId = this.uiState.filterMode();
    if (filterId === 'all') return '全部任务';
    const task = this.projectState.getTask(filterId);
    if (!task) return '全部任务';
    return task.title || task.displayId || '未命名任务';
  });

  /**
   * 侧边栏录音转写结果写入黑匣子
   */
  onSidebarVoiceTranscribed(text: string): void {
    const content = text.trim();
    if (!content) return;

    const result = this.blackBoxService.create({ content });
    if (!result.ok) {
      this.toast.warning('录音保存失败', result.error.message);
    }
  }

  onSidebarToolsIntent(): void {
    if (!FEATURE_FLAGS.SIDEBAR_TOOLS_DYNAMIC_LOAD_V1) {
      return;
    }
    this.preloadSidebarTools('intent');
  }

  private preloadSidebarTools(reason: 'startup' | 'p1' | 'intent'): void {
    void this.loadFocusSessionTriggerComponent();
    void this.preloadFocusModeAssets(reason);

    if (this.focusPrefs.isBlackBoxEnabled()) {
      void this.loadBlackBoxRecorderComponent();
    }

    this.sentryLazyLoader.addBreadcrumb({
      category: 'startup',
      message: 'sidebar.tools.preload',
      level: 'info',
      data: { reason },
    });
  }

  private loadFocusSessionTriggerComponent(): Promise<Type<unknown> | null> {
    const current = this.focusSessionTriggerComponent();
    if (current) return Promise.resolve(current);
    if (this.focusSessionTriggerLoadPromise) return this.focusSessionTriggerLoadPromise;

    this.focusSessionTriggerLoadPromise = import('./app/features/focus/components/focus-session-trigger.component')
      .then((module) => {
        const component = module.FocusSessionTriggerComponent as Type<unknown>;
        // 防御性校验：确保动态导入的组件是有效的构造函数
        // 在 SW 缓存不一致时，导入可能成功但导出值为 undefined
        if (typeof component !== 'function') {
          this.logger.warn('FocusSessionTriggerComponent 导入值无效（疑似 chunk 版本偏移）', { type: typeof component });
          return null;
        }
        this.focusSessionTriggerComponent.set(component);
        return component;
      })
      .catch((error: unknown) => {
        this.logger.warn('FocusSessionTriggerComponent 懒加载失败', error);
        return null;
      })
      .finally(() => {
        this.focusSessionTriggerLoadPromise = null;
      });

    return this.focusSessionTriggerLoadPromise;
  }

  private loadBlackBoxRecorderComponent(): Promise<Type<unknown> | null> {
    const current = this.blackBoxRecorderComponent();
    if (current) return Promise.resolve(current);
    if (this.blackBoxRecorderLoadPromise) return this.blackBoxRecorderLoadPromise;

    this.blackBoxRecorderLoadPromise = import('./app/features/focus/components/black-box/black-box-recorder.component')
      .then((module) => {
        const component = module.BlackBoxRecorderComponent as Type<unknown>;
        // 防御性校验：确保动态导入的组件是有效的构造函数
        // 在 SW 缓存不一致时，导入可能成功但导出值为 undefined
        if (typeof component !== 'function') {
          this.logger.warn('BlackBoxRecorderComponent 导入值无效（疑似 chunk 版本偏移）', { type: typeof component });
          return null;
        }
        this.blackBoxRecorderComponent.set(component);
        return component;
      })
      .catch((error: unknown) => {
        this.logger.warn('BlackBoxRecorderComponent 懒加载失败', error);
        return null;
      })
      .finally(() => {
        this.blackBoxRecorderLoadPromise = null;
      });

    return this.blackBoxRecorderLoadPromise;
  }

  private preloadFocusModeAssets(reason: 'startup' | 'p1' | 'intent'): Promise<void> {
    if (this.focusModePreloadPromise) return this.focusModePreloadPromise;

    this.focusModePreloadPromise = import('./app/features/focus/focus-mode.component')
      .then(async (module) => {
        const focusModeComponent = module.FocusModeComponent;
        if (typeof focusModeComponent?.preloadAssets === 'function') {
          await focusModeComponent.preloadAssets();
        }
        this.sentryLazyLoader.addBreadcrumb({
          category: 'startup',
          message: 'focus-mode.preload',
          level: 'info',
          data: { reason },
        });
      })
      .catch((error: unknown) => {
        this.logger.warn('FocusMode 懒预热失败', error);
      })
      .finally(() => {
        this.focusModePreloadPromise = null;
      });

    return this.focusModePreloadPromise;
  }

  private scheduleFocusModePreload(reason: 'startup' | 'p1'): void {
    if (this.focusModePreloadScheduled) return;
    this.focusModePreloadScheduled = true;

    const runPreload = () => {
      void this.preloadFocusModeAssets(reason);
    };

    if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
      const requestIdle = (window as Window & {
        requestIdleCallback: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
      }).requestIdleCallback;
      requestIdle(() => runPreload(), { timeout: 1800 });
      return;
    }

    setTimeout(runPreload, 1200);
  }

  // 模态框开关状态 - 保留删除项目用（其余已迁移到命令式渲染）
  readonly showDeleteProjectModal = computed(() => this.modal.isOpen('deleteProject'));
  
  readonly showLoginRequired = computed(() =>
    this.authCoord.showLoginRequired() && this.handoffCoordinator.result().kind === 'login-required'
  );
  readonly pwaPromptVisible = signal(false);
  
  /** 删除项目目标 - 从 ModalService 获取 */
  readonly deleteProjectTarget = computed(() => {
    const data = this.modal.getData('deleteProject') as DeleteProjectData | undefined;
    return data ? { id: data.projectId, name: data.projectName } : null;
  });
  
  // 统一搜索查询
  unifiedSearchQuery = signal<string>('');
  /** 记录上一次视口断点状态，避免移动端 resize 抖动触发误收起 */
  private previousViewportIsMobile = this.uiState.isMobile();

  // 搜索防抖定时器
  private searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly SEARCH_DEBOUNCE_DELAY = 300; // 300ms 搜索防抖
  private focusProbeInitializedForUser: string | null = null;
  private focusEntryOwnerScope: string | null | undefined = undefined;
  private focusEntryPulseGeneration = 0;
  private focusEntryPulseDispatched = false;
  private focusEntryPulsePending = false;
  private focusEntryPulseRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private interactionWarmupDone = false;
  private syncHydrationDone = false;
  private remoteCallbacksInitialized = false;
  private remoteCallbacksInitializing = false;
  private subscribedProjectId: string | null = null;
  private remoteChangeHandlerPromise: Promise<RemoteChangeHandlerLike | null> | null = null;
  private eventDrivenSyncPulseRef: EventDrivenSyncPulseLike | null = null;
  private eventDrivenSyncPulsePromise: Promise<EventDrivenSyncPulseLike | null> | null = null;
  private startupDiagnosticsPromise: Promise<StartupDiagnosticsLike[] | null> | null = null;
  private workspaceHandoffSignaled = false;
  private workspaceReadyCommitted = false;
  private rootStartupTextNavigationApplied = false;
  private handledStartupEntryIntentKey: string | null = null;
  private primedWidgetWorkspaceGateSyncKey: string | null = null;
  private pendingWidgetWorkspaceGateRecheckKey: string | null = null;
  private readonly pendingAndroidWidgetBootstrap = signal<AndroidWidgetBootstrapRequest | null>(null);
  readonly pendingAndroidWidgetManualCallback = signal<AndroidWidgetBootstrapCallbackResult | null>(null);
  private readonly deferredStartupEntryIntent = signal<StartupEntryIntent | null>(null);
  /** Android Widget 主回跳未接管时，切换 intent fallback 的等待时间 */
  private readonly ANDROID_WIDGET_CALLBACK_FALLBACK_MS = 800;
  private androidWidgetManualCallbackFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private swUpdateInitialCheckTimer: ReturnType<typeof setTimeout> | null = null;
  private swUpdatePollTimer: ReturnType<typeof setInterval> | null = null;
  private swUpdateCheckInFlight = false;
  private lastSwUpdateCheckAt = 0;
  private androidWidgetBootstrapCaptureKey: string | null = null;
  private androidWidgetBootstrapInFlight = false;
  private destroyed = false;
  private modalCoordRef: WorkspaceModalCoordinatorService | null = null;
  private modalCoordPromise: Promise<WorkspaceModalCoordinatorService> | null = null;
  private readonly launchSnapshotWriteBlocked = signal(false);
  private readonly handleSwUpdateVisibilityCheck = () => {
    if (document.visibilityState === 'visible') {
      void this.checkForSwUpdate('visibility');
    }
  };
  private readonly handleSwUpdateFocusCheck = () => {
    void this.checkForSwUpdate('focus');
  };
  private readonly handleSwUpdateOnlineCheck = () => {
    void this.checkForSwUpdate('online');
  };

  constructor() {
    // 启动流程：仅执行必要的同步初始化
    // 关键：bootstrapSession 移到 ngOnInit + setTimeout，避免阻塞 TTFB
    if (this.previousViewportIsMobile) {
      this.isSidebarOpen.set(false);
    }
    this.setupSwUpdateListener();
    // 主题初始化在 StoreService 构造函数中完成
    // 不再在此重复应用主题
    this.setupConflictHandler();
    this.setupSidebarToggleListener();
    this.setupStorageFailureHandler();
    this.setupBeforeUnloadHandler();
    this.modalCoord.initCallbacks(this.createModalCallbacks());

    // ── Service Initialization Order ──────────────────────────────────────
    // The six startup services are initialized in a strict sequence to
    // respect dependency constraints and avoid competing for resources.
    // See AppLifecycleOrchestratorService.initialize() JSDoc for the full
    // rationale behind each step.
    //
    // Step 1 (here, constructor): AppLifecycleOrchestratorService
    //   - Must be first: resume/recovery listeners must be active before
    //     any async startup work begins.
    // Step 2 (ngOnInit): StartupTierOrchestratorService.initialize()
    // Step 3 (ngOnInit): lazy StartupFontSchedulerService.initialize()
    // Step 4 (signal effect): FocusStartupProbeService.initialize()
    //   - Fires reactively after coreDataLoaded() && authenticated.
    // Step 5 (signal effect): EventDrivenSyncPulseService.initialize()
    //   - Fires reactively after auth + P2 tier readiness.
    // Step 6 (deferred): PwaInstallPromptService.initialize()
    //   - Deferred to first user interaction or requestIdleCallback.
    // ──────────────────────────────────────────────────────────────────────
    this.appLifecycle.initialize();

    // 【P0 新增 2026-03-27】快照预填充 Store
    // 从 launch-snapshot 预填充项目状态，使 hasProjects=true 立即成立，
    // 解除 handoff 对 auth + 数据加载的串行阻塞依赖。
    this.userSession.prehydrateFromSnapshot();
    this.restorePendingAndroidWidgetBootstrapFromStorage();
    
    // effect() 必须在注入上下文中调用（构造函数），否则抛 NG0203
    this.setupSignalEffects();
  }

  /**
   * 全局撤销/重做快捷键（capture 阶段）
   *
   * 背景：某些聚焦组件（如 GoJS Canvas / 第三方控件）会在 bubble 阶段 stopPropagation，
   * 导致 HostListener('document:keydown') 偶发收不到 Ctrl/Cmd+Z，从而表现为“撤回失效”。
   *
   * 解决：在 capture 阶段优先处理快捷键，并在 bubble 阶段用 defaultPrevented 去重。
   */
  private readonly keyboardShortcutCaptureListener = (event: KeyboardEvent) => {
    if (this.shouldIgnoreKeyboardShortcut(event)) return;

    const key = event.key.toLowerCase();
    if (this.handleUndoRedoShortcut(event, key)) return;
    if (this.handleSearchShortcut(event, key)) return;
    this.handleBlackBoxShortcut(event, key);
  };

  private readonly focusMountIntentListener = () => {
    if (!FEATURE_FLAGS.FOCUS_STARTUP_THROTTLED_CHECK_V1) return;
    this.focusModeIntentActivated.set(true);
    this.dispatchFocusEntrySyncPulseIfReady();
    this.teardownFocusMountIntentListener();
  };

  private readonly flowRestoreBreadcrumbListener = (event: Event) => {
    const detail = (event as CustomEvent<{ mode?: 'applied' | 'degraded'; reason?: string; projectId?: string }>).detail;
    const mode = detail?.mode === 'applied' ? 'applied' : 'degraded';
    this.sentryLazyLoader.addBreadcrumb({
      category: 'startup',
      message: mode === 'applied' ? 'flow.restore.applied' : 'flow.restore.degraded',
      level: 'info',
      data: {
        mode,
        reason: detail?.reason ?? 'unknown',
        projectId: detail?.projectId ?? null,
      },
    });
  };

  private readonly syncPulseBreadcrumbListener = (event: Event) => {
    const detail = (event as CustomEvent<{ status?: string; reason?: string; skipReason?: string }>).detail;
    this.sentryLazyLoader.addBreadcrumb({
      category: 'sync',
      message: 'sync.pulse.reason',
      level: 'info',
      data: {
        status: detail?.status ?? 'unknown',
        reason: detail?.reason ?? 'unknown',
        skipReason: detail?.skipReason ?? null,
      },
    });
  };
  
  ngOnInit() {
    this.setupRouteSync();

    // capture 阶段注册全局快捷键，避免被聚焦组件吞掉
    document.addEventListener('keydown', this.keyboardShortcutCaptureListener, { capture: true });

    // ⚡ 性能优化：延迟会话检查到浏览器空闲时段
    this.authCoord.scheduleSessionBootstrap();
    this.scheduleStartupFontInitialization();
    this.startupTier.initialize();
    this.scheduleFocusModePreload('startup');
    if (!FEATURE_FLAGS.SIDEBAR_TOOLS_DYNAMIC_LOAD_V1) {
      this.preloadSidebarTools('startup');
    }
    this.setupFocusMountIntentListener();
    this.recordStartupPreloadBreadcrumb();
    this.recordModulePreloadModeBreadcrumb();
    this.setupFlowRestoreBreadcrumbListener();
    this.setupSyncPulseBreadcrumbListener();

    if (!FEATURE_FLAGS.TIERED_STARTUP_HYDRATION_V1) {
      // 旧策略兜底：未开启分层启动时维持原有初始化节奏
      setTimeout(() => {
        this.syncCoordinator.initialize();
        this.simpleSync.startRuntime();
      }, 100);
    }
    
    // 🚀 空闲时预加载常用模态框（消除首次点击延迟）
    this.modalCoord.preloadCommonModals();
    
    // 🛡️ 数据保护：延迟初始化存储配额监控和 IndexedDB 健康检查
    setTimeout(() => {
      this.initializeStartupDiagnosticsLazy();
    }, 5000); // 延迟 5 秒，避免阻塞启动
    
    // 🛡️ 安全校验：验证关键 Feature Flags 是否处于安全状态
    this.validateCriticalFeatureFlags();
  }

  ngAfterViewInit(): void {
    this.signalWorkspaceHandoffReady();
  }

  private shouldIgnoreKeyboardShortcut(event: KeyboardEvent): boolean {
    return event.defaultPrevented || !event.key || (!event.ctrlKey && !event.metaKey);
  }

  private handleUndoRedoShortcut(event: KeyboardEvent, key: string): boolean {
    if (key === 'z' && !event.shiftKey) {
      event.preventDefault();
      this.taskOpsAdapter.performUndo();
      return true;
    }

    if ((key === 'z' && event.shiftKey) || key === 'y') {
      event.preventDefault();
      this.taskOpsAdapter.performRedo();
      return true;
    }

    return false;
  }

  private handleSearchShortcut(event: KeyboardEvent, key: string): boolean {
    if (event.shiftKey || key !== 'f') return false;

    event.preventDefault();
    this.focusGlobalSearchInput();
    return true;
  }

  private focusGlobalSearchInput(): void {
    this.isSidebarOpen.set(true);
    setTimeout(() => {
      const searchInput = document.querySelector<HTMLInputElement>('aside input[aria-label="搜索项目或任务"]');
      searchInput?.focus();
      searchInput?.select();
    }, SIDEBAR_SEARCH_FOCUS_DELAY_MS);
  }

  private handleBlackBoxShortcut(event: KeyboardEvent, key: string): boolean {
    if (event.shiftKey || key !== 'b') return false;

    event.preventDefault();
    showBlackBoxPanel.update(v => !v);
    return true;
  }

  showInstallPrompt(): boolean {
    return this.pwaPromptVisible();
  }

  onPwaPromptVisibleChange(visible: boolean): void {
    this.pwaPromptVisible.set(visible);
  }

  /**
   * 启动时校验关键 Feature Flags
   * 
   * 【NEW-8】使用集中式校验函数，覆盖全部关键保护性开关（7 项）
   * 如果数据保护相关的开关被意外关闭，发出 Sentry 警告 + 开发者 Toast
   */
  private validateCriticalFeatureFlags(): void {
    const disabledFlags = validateCriticalFlags();
    
    if (disabledFlags.length > 0) {
      const names = disabledFlags.map(f => f.flag).join('、');
      this.logger.warn('关键安全开关被禁用', { 
        flags: disabledFlags.map(f => f.flag),
        risks: disabledFlags.map(f => f.risk),
      });
      
      // 开发环境显示 Toast 提醒
      const isDev = typeof window !== 'undefined' && window.location?.hostname === 'localhost';
      if (isDev) {
        this.toast.warning(
          '安全开关警告', 
          `${disabledFlags.length} 个关键开关被禁用：${names}`, 
          { duration: 10000 }
        );
      }
    }
  }
  
  /**
   * 信号 effect 集中注册（必须在构造函数中调用以确保注入上下文可用）
   * 
   * 背景：effect() 内部需要 inject(Injector)，若在 ngOnInit 等生命周期钩子中调用
   * 会抛出 NG0203: inject() must be called from an injection context
   */
  private setupSignalEffects(): void {
    this.setupModalEffects();
    this.setupDataProtectionEffect();
    this.setupLaunchSnapshotEffect();
    this.setupRouteProjectSelectionEffect();
    this.setupAndroidWidgetBootstrapCaptureEffect();
    this.setupAndroidWidgetBootstrapProcessingEffect();
    this.setupStartupEntryIntentEffect();
    this.setupHandoffEffect();
    this.setupWorkspaceReadyEffect();
    this.setupFocusProbeEffect();
    this.setupStartupTierEffects();
    this.setupRemoteCallbackEffect();
    this.setupSubscriptionEffect();
    this.setupFocusEntryOwnerEffect();
    this.setupSyncPulseEffect();
    this.setupSessionRestoredHandler();
    this.setupSessionInvalidatedHandler();
  }

  /** 模态框请求信号监听（可恢复错误 / 登录 / 迁移） */
  private setupModalEffects(): void {
    // 监听可恢复错误信号，命令式打开错误恢复模态框
    effect(() => {
      const error = this.errorHandler.recoverableError();
      if (error) {
        void this.openErrorRecoveryModal({
          title: error.title,
          message: error.message,
          details: error.details,
          options: error.options,
          defaultOptionId: error.defaultOptionId,
          autoSelectIn: error.autoSelectIn,
          resolve: (result: { optionId: string }) => error.resolve(result.optionId)
        });
      }
    });
    
    // 监听登录模态框请求（从 ModalService 的 show('login') 迁移）
    effect(() => {
      const loginRequested = this.modal.isOpen('login');
      if (loginRequested) {
        const loginData = this.modal.getData('login') as LoginData | undefined;
        this.modalCoord.loginReturnUrl = loginData?.returnUrl ?? null;
        this.modal.closeByType('login');
        if (!this.modalCoord.loginModalRef) {
          void this.openLoginModal();
        }
      }
    });
    
    // 监听迁移模态框请求
    effect(() => {
      const migrationRequested = this.modal.isOpen('migration');
      if (migrationRequested) {
        this.modal.closeByType('migration');
        void this.openMigrationModal();
      }
    });
  }

  /** 📦 数据保护：导出提醒（7 天未导出时 Toast 提示） */
  private setupDataProtectionEffect(): void {
    effect(() => {
      const needsReminder = this.exportService.needsExportReminder();
      const userId = this.userSession.currentUserId();
      this.syncDataProtectionReminderToast(Boolean(needsReminder && userId));
    });
  }

  private syncDataProtectionReminderToast(shouldShowReminder: boolean): void {
    const reminderToast = untracked(() =>
      this.toast.messages().find(message =>
        message.type === 'info' &&
        message.title === DATA_PROTECTION_REMINDER_TITLE &&
        message.message === DATA_PROTECTION_REMINDER_MESSAGE,
      )
    );

    if (shouldShowReminder) {
      if (!reminderToast) {
        this.toast.info(
          DATA_PROTECTION_REMINDER_TITLE,
          DATA_PROTECTION_REMINDER_MESSAGE,
          { duration: 10000 },
        );
      }
      return;
    }

    if (reminderToast) {
      this.toast.dismiss(reminderToast.id);
    }
  }

  /** 启动快照：将最近项目摘要写入轻量快照，供下次冷启动直接显示。 */
  private setupLaunchSnapshotEffect(): void {
    // capture() 含 sort/slice/map，避免每次信号变化都执行。
    // 仅将原始数据传递给 schedulePersist，在防抖回调内部做 capture。
    effect(() => {
      if (this.launchSnapshotWriteBlocked() || this.hintOnlyStartupPlaceholderVisible()) {
        this.launchSnapshot.cancelPendingPersist();
        return;
      }

      const projects = this.projectState.projects();
      const userId = this.resolveLaunchSnapshotUserId();
      const activeProjectId = this.projectState.activeProjectId();
      const lastActiveView = this.uiState.activeView();
      const theme = this.preferenceService.theme();
      const colorMode = this.readCurrentColorMode();
      const routeUrl = this.routeUrl();
      const resolvedLaunchView = lastActiveView ?? 'text';
      const mobileDegraded = this.uiState.isMobile() && (routeUrl.endsWith('/flow') || routeUrl.includes('/task/')) && resolvedLaunchView === 'text';
      const degradeReason = mobileDegraded ? 'mobile-default-text' : null;

      this.launchSnapshot.schedulePersistDeferred(projects, {
        userId,
        activeProjectId,
        lastActiveView,
        routeUrl,
        resolvedLaunchView,
        mobileDegraded,
        degradeReason,
        theme,
        colorMode,
      });
    });
  }

  private readCurrentColorMode(): 'light' | 'dark' | 'system' {
    if (typeof document === 'undefined') {
      return 'system';
    }

    const mode = document.documentElement.getAttribute('data-color-mode');
    if (mode === 'light' || mode === 'dark') {
      return mode;
    }
    return 'system';
  }

  private resolveLaunchSnapshotUserId(): string | null {
    const currentUserId = this.currentUserId();
    if (currentUserId) {
      return currentUserId;
    }

    const authSettling = !this.authService.sessionInitialized() || this.authCoord.isCheckingSession();
    if (!authSettling) {
      return null;
    }

    const prehydratedOwnerUserId = this.userSession?.getLaunchSnapshotPersistOwnerDuringAuthSettle?.() ?? null;
    if (prehydratedOwnerUserId) {
      return prehydratedOwnerUserId;
    }

    return null;
  }

  private signalWorkspaceHandoffReady(): void {
    if (this.workspaceHandoffSignaled) {
      return;
    }

    this.workspaceHandoffSignaled = true;

    // 真实布局树已挂载完成，但是否允许交接仍交由 HandoffCoordinator 判断。
    // 这样 loader 隐藏、handoff、ready 三者会严格串联，避免秒开阶段直接暴露半稳定 UI。
    if (!FEATURE_FLAGS.SNAPSHOT_HANDOFF_V2) {
      this.bootStage.markWorkspaceHandoffReady();
      return;
    }

    this.handoffCoordinator.markLayoutStable();
  }

  private setupRouteProjectSelectionEffect(): void {
    effect(() => {
      this.routeUrl();
      this.projectState.projects();
      this.projectState.activeProjectId();
      this.syncStateFromRoute();
    });
  }

  private setupStartupEntryIntentEffect(): void {
    effect(() => {
      const startupEntryIntent = this.getCurrentStartupEntryIntent() ?? this.deferredStartupEntryIntent();
      if (!startupEntryIntent) {
        this.handledStartupEntryIntentKey = null;
        this.primedWidgetWorkspaceGateSyncKey = null;
        return;
      }

      this.primeWidgetWorkspaceGateSync(startupEntryIntent);

      if (!this.bootStage.isApplicationReady()) {
        return;
      }

      const startupEntryIntentKey = `${startupEntryIntent.entry}:${startupEntryIntent.rawIntent ?? ''}:${this.routeUrl()}`;
      if (this.handledStartupEntryIntentKey === startupEntryIntentKey) {
        return;
      }

      this.handledStartupEntryIntentKey = startupEntryIntentKey;
      this.applyStartupEntryIntent(startupEntryIntent);
      this.deferredStartupEntryIntent.set(null);
      this.persistDeferredStartupEntryIntentToStorage(null);
      if (this.getCurrentStartupEntryIntent()) {
        this.consumeStartupEntryIntent();
      }
    });
  }

  private setupAndroidWidgetBootstrapCaptureEffect(): void {
    effect(() => {
      const routeUrl = typeof this.routeUrl === 'function' ? this.routeUrl() : null;
      this.captureAndroidWidgetBootstrapFromRoute(typeof routeUrl === 'string' ? routeUrl : null);
    });
  }

  private setupAndroidWidgetBootstrapProcessingEffect(): void {
    effect(() => {
      const bootstrapRequest = this.pendingAndroidWidgetBootstrap();
      const currentUserId = this.currentUserId();
      const sessionInitialized = this.authService.sessionInitialized();

      if (!bootstrapRequest || !sessionInitialized || !currentUserId || this.androidWidgetBootstrapInFlight) {
        return;
      }

      this.androidWidgetBootstrapInFlight = true;
      void this.completeAndroidWidgetBootstrap(bootstrapRequest);
    });
  }

  private isTrustedAndroidWidgetBootstrapSurface(
    bootstrapRequest: AndroidWidgetBootstrapRequest,
    routeUrl: string | null,
  ): boolean {
    const runtimePlatform = readRuntimePlatformSnapshot();
    if (runtimePlatform.isTwa) {
      return true;
    }

    // 2026-04-19: 放宽 Android 浏览器 fallback 的判定。widget 点击冷启动时 URL 会携带 entry=widget；
    // 当 Chrome 以 Custom Tab 接管（isTwa=false）时，原仅接受 entry=twa 的判定会把合法 widget
    // bootstrap 请求误判为不可信，导致 widget 永远停留在 binding-missing 状态。
    const entryKind = resolveStartupEntryIntent(routeUrl)?.entry;
    if (
      runtimePlatform.isAndroid
      && (entryKind === 'twa' || entryKind === 'widget')
      && hasAndroidWidgetBootstrapFlag(routeUrl)
    ) {
      return true;
    }

    const pendingBootstrap = this.pendingAndroidWidgetBootstrap();
    if (!pendingBootstrap) {
      return false;
    }

    const expectedCaptureKey = `${pendingBootstrap.installationId}:${pendingBootstrap.deviceId}:${pendingBootstrap.hostInstanceId}:${pendingBootstrap.bootstrapNonce}:${routeUrl}`;
    const nextCaptureKey = `${bootstrapRequest.installationId}:${bootstrapRequest.deviceId}:${bootstrapRequest.hostInstanceId}:${bootstrapRequest.bootstrapNonce}:${routeUrl}`;
    return expectedCaptureKey === nextCaptureKey;
  }

  private getCurrentStartupEntryIntent(): StartupEntryIntent | null {
    const routeUrl = typeof this.routeUrl === 'function' ? this.routeUrl() : null;
    return resolveStartupEntryIntent(typeof routeUrl === 'string' ? routeUrl : null);
  }

  private applyStartupEntryIntent(startupEntryIntent: StartupEntryIntent): void {
    this.primeWidgetWorkspaceGateSync(startupEntryIntent);

    // 蓝图 UI 小组件的 1-tap 标记：大门按钮直接对指定条目执行 markAsRead / markAsCompleted。
    if (
      startupEntryIntent.intent === 'mark-gate-read'
      || startupEntryIntent.intent === 'mark-gate-complete'
    ) {
      this.applyWidgetGateMutation(startupEntryIntent);
      return;
    }

    if (
      startupEntryIntent.intent !== 'open-focus-tools'
      && startupEntryIntent.intent !== 'open-blackbox-recorder'
    ) {
      return;
    }

    this.isSidebarOpen.set(true);
    this.preloadSidebarTools('intent');

    if (startupEntryIntent.intent === 'open-blackbox-recorder' && this.focusPrefs.isBlackBoxEnabled()) {
      void this.loadBlackBoxRecorderComponent();
    }
  }

  private primeWidgetWorkspaceGateSync(startupEntryIntent: StartupEntryIntent): void {
    const isAndroidWidgetBootstrapOpen = startupEntryIntent.entry === 'twa'
      && startupEntryIntent.androidWidgetBootstrap === true;
    const isTwaWorkspaceOpen = startupEntryIntent.entry === 'twa';
    if (
      startupEntryIntent.intent !== 'open-workspace'
      || (startupEntryIntent.entry !== 'widget' && !isAndroidWidgetBootstrapOpen && !isTwaWorkspaceOpen)
    ) {
      return;
    }

    const primeSource = isAndroidWidgetBootstrapOpen
      ? 'android-widget-bootstrap'
      : startupEntryIntent.entry === 'twa'
        ? 'twa-open-workspace'
        : startupEntryIntent.entry;
    const primeKey = `${primeSource}:${startupEntryIntent.rawIntent ?? ''}:${this.routeUrl()}`;
    if (this.primedWidgetWorkspaceGateSyncKey === primeKey) {
      return;
    }

    this.primedWidgetWorkspaceGateSyncKey = primeKey;
    this.focusStartupProbe.primeWidgetWorkspaceGateSync();
    this.dockEngine.refreshFocusSessionFromCloud(this.currentUserId());

    this.pendingWidgetWorkspaceGateRecheckKey = primeKey;

    this.flushWidgetWorkspaceGateRecheck();
  }

  private flushWidgetWorkspaceGateRecheck(): void {
    if (!this.pendingWidgetWorkspaceGateRecheckKey) {
      return;
    }

    if (!this.bootStage.isApplicationReady()) {
      return;
    }

    const currentUserId = this.currentUserId();
    if (!currentUserId) {
      return;
    }

    this.pendingWidgetWorkspaceGateRecheckKey = null;
    void this.focusStartupProbe.recheckGate({
      source: 'widget-open-workspace',
      reloadLocal: false,
    });
  }

  /** 小组件大门按钮 → 应用侧直接调用 BlackBoxService 对指定条目执行标记。 */
  private applyWidgetGateMutation(startupEntryIntent: StartupEntryIntent): void {
    const entryId = startupEntryIntent.widgetGateEntryId;
    if (!entryId) {
      // 没有条目 ID 时回退为打开 Focus Tools，保证 widget 侧用户仍可进入应用处理。
      this.isSidebarOpen.set(true);
      this.preloadSidebarTools('intent');
      return;
    }

    const result = startupEntryIntent.intent === 'mark-gate-read'
      ? this.blackBoxService.markAsRead(entryId)
      : this.blackBoxService.markAsCompleted(entryId);

    if (!result.ok) {
      // 条目不存在或已处理：静默回退，不打断 workspace 启动流程。
      this.logger.warn('Widget gate mutation failed', {
        intent: startupEntryIntent.intent,
        entryId,
        code: result.error.code,
        message: result.error.message,
      });
    } else {
      this.logger.info('Widget gate mutation applied', {
        intent: startupEntryIntent.intent,
        entryId,
      });
    }
  }

  private consumeStartupEntryIntent(): void {
    const routeUrl = typeof this.routeUrl === 'function' ? this.routeUrl() : null;
    const routeIntent = resolveStartupEntryRouteIntent(typeof routeUrl === 'string' ? routeUrl : null);

    if (!routeIntent?.projectId) {
      const mobileRootProjectId = this.resolveMobileRootStartupProjectId();
      if (mobileRootProjectId) {
        void this.router.navigate(['/projects', mobileRootProjectId, 'text'], {
          replaceUrl: true,
        });
        return;
      }

      void this.router.navigate(['/projects'], {
        replaceUrl: true,
      });
      return;
    }

    switch (routeIntent.kind) {
      case 'task':
        if (routeIntent.taskId) {
          void this.router.navigate(['/projects', routeIntent.projectId, 'task', routeIntent.taskId], {
            replaceUrl: true,
          });
          return;
        }
        break;
      case 'flow':
        void this.router.navigate(['/projects', routeIntent.projectId, 'flow'], {
          replaceUrl: true,
        });
        return;
      case 'text':
        void this.router.navigate(['/projects', routeIntent.projectId, 'text'], {
          replaceUrl: true,
        });
        return;
      case 'project':
        void this.router.navigate(['/projects', routeIntent.projectId], {
          replaceUrl: true,
        });
        return;
      default:
        break;
    }

    void this.router.navigate(['/projects'], {
      replaceUrl: true,
    });
  }

  private captureAndroidWidgetBootstrapFromRoute(routeUrl: string | null): boolean {
    const bootstrapRequest = resolveAndroidWidgetBootstrapRequest(routeUrl);
    const hasBootstrapFlag = hasAndroidWidgetBootstrapFlag(routeUrl);

    if (!bootstrapRequest) {
      if (hasBootstrapFlag && routeUrl && this.androidWidgetBootstrapCaptureKey !== routeUrl) {
        this.androidWidgetBootstrapCaptureKey = routeUrl;
        this.persistPendingAndroidWidgetBootstrapToStorage(null);
        const startupEntryIntent = resolveStartupEntryIntent(routeUrl);
        this.deferredStartupEntryIntent.set(startupEntryIntent);
        this.persistDeferredStartupEntryIntentToStorage(startupEntryIntent);
        this.logger.warn('忽略损坏的 Android widget bootstrap 参数');
        this.consumeStartupEntryIntent();
        return true;
      }

      if (!hasBootstrapFlag) {
        this.androidWidgetBootstrapCaptureKey = null;
      }
      return false;
    }

    const captureKey = `${bootstrapRequest.installationId}:${bootstrapRequest.deviceId}:${bootstrapRequest.hostInstanceId}:${bootstrapRequest.bootstrapNonce}:${routeUrl}`;
    if (!this.isTrustedAndroidWidgetBootstrapSurface(bootstrapRequest, routeUrl)) {
      if (routeUrl && this.androidWidgetBootstrapCaptureKey !== routeUrl) {
        this.androidWidgetBootstrapCaptureKey = routeUrl;
        this.persistPendingAndroidWidgetBootstrapToStorage(null);
        const startupEntryIntent = resolveStartupEntryIntent(routeUrl);
        this.deferredStartupEntryIntent.set(startupEntryIntent);
        this.persistDeferredStartupEntryIntentToStorage(startupEntryIntent);
        this.logger.warn('忽略不可信环境中的 Android widget bootstrap 请求');
        this.consumeStartupEntryIntent();
        return true;
      }

      return false;
    }

    if (this.androidWidgetBootstrapCaptureKey === captureKey) {
      return false;
    }

    this.androidWidgetBootstrapCaptureKey = captureKey;
    this.pendingAndroidWidgetBootstrap.set(bootstrapRequest);
    this.persistPendingAndroidWidgetBootstrapToStorage(bootstrapRequest);
    const startupEntryIntent = resolveStartupEntryIntent(routeUrl);
    this.deferredStartupEntryIntent.set(startupEntryIntent);
    this.persistDeferredStartupEntryIntentToStorage(startupEntryIntent);
    this.consumeStartupEntryIntent();
    return true;
  }

  private async completeAndroidWidgetBootstrap(bootstrapRequest: AndroidWidgetBootstrapRequest): Promise<void> {
    const result = await this.widgetBinding.completeAndroidBootstrap(bootstrapRequest);
    this.androidWidgetBootstrapInFlight = false;
    this.deferredStartupEntryIntent.set(null);
    this.persistDeferredStartupEntryIntentToStorage(null);

    if (!result.ok) {
      this.pendingAndroidWidgetBootstrap.set(null);
      this.persistPendingAndroidWidgetBootstrapToStorage(null);
      this.logger.warn('Android widget bootstrap 失败', {
        code: result.error.code,
        message: result.error.message,
        hostInstanceId: bootstrapRequest.hostInstanceId,
      });
      this.toast.warning('Android 小组件初始化失败', '绑定未完成，请重新打开 NanoFlow 小组件');
      return;
    }

    this.pendingAndroidWidgetBootstrap.set(null);
    this.persistPendingAndroidWidgetBootstrapToStorage(null);

    this.navigateToAndroidWidgetCallback(result.value);
  }

  private navigateToAndroidWidgetCallback(callback: AndroidWidgetBootstrapCallbackResult): void {
    if (typeof window === 'undefined') {
      return;
    }

    const runtimePlatform = readRuntimePlatformSnapshot();
    const requiresManualCallback = runtimePlatform.isAndroid && !runtimePlatform.isTwa && typeof document !== 'undefined';
    if (!requiresManualCallback) {
      window.location.assign(callback.callbackUrl);
      return;
    }

    this.logger.warn('Android widget callback 改为等待用户显式回跳');
    this.pendingAndroidWidgetManualCallback.set(callback);
  }

  continueAndroidWidgetManualCallback(): void {
    const callback = this.pendingAndroidWidgetManualCallback();
    if (!callback || typeof window === 'undefined') {
      return;
    }

    this.logger.warn('Android widget callback 使用显式确认回跳');
    this.pendingAndroidWidgetManualCallback.set(null);
    this.beforeUnloadManager.suppressNextConfirmation();
    this.scheduleAndroidWidgetManualCallbackIntentFallback(callback);
    window.location.assign(callback.callbackUrl);
  }

  useAndroidWidgetIntentFallback(): void {
    const callback = this.pendingAndroidWidgetManualCallback();
    if (!callback || typeof window === 'undefined') {
      return;
    }

    this.logger.warn('Android widget callback 使用显式 intent fallback');
    this.pendingAndroidWidgetManualCallback.set(null);
    this.beforeUnloadManager.suppressNextConfirmation();
    this.clearAndroidWidgetManualCallbackFallbackTimer();
    window.location.replace(callback.callbackIntentUrl);
  }

  dismissAndroidWidgetManualCallback(): void {
    this.clearAndroidWidgetManualCallbackFallbackTimer();
    this.pendingAndroidWidgetManualCallback.set(null);
  }

  private scheduleAndroidWidgetManualCallbackIntentFallback(
    callback: AndroidWidgetBootstrapCallbackResult,
  ): void {
    this.clearAndroidWidgetManualCallbackFallbackTimer();

    this.androidWidgetManualCallbackFallbackTimer = setTimeout(() => {
      this.androidWidgetManualCallbackFallbackTimer = null;
      if (typeof window === 'undefined') {
        return;
      }

      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return;
      }

      this.logger.warn('Android widget callback 主回跳未接管，自动切换 intent fallback');
      this.beforeUnloadManager.suppressNextConfirmation();
      window.location.replace(callback.callbackIntentUrl);
    }, this.ANDROID_WIDGET_CALLBACK_FALLBACK_MS);
  }

  private clearAndroidWidgetManualCallbackFallbackTimer(): void {
    if (this.androidWidgetManualCallbackFallbackTimer) {
      clearTimeout(this.androidWidgetManualCallbackFallbackTimer);
      this.androidWidgetManualCallbackFallbackTimer = null;
    }
  }

  private restorePendingAndroidWidgetBootstrapFromStorage(): void {
    if (typeof window === 'undefined' || typeof window.sessionStorage === 'undefined') {
      return;
    }

    this.restoreDeferredStartupEntryIntentFromStorage();

    try {
      const raw = window.sessionStorage.getItem(ANDROID_WIDGET_BOOTSTRAP_STORAGE_KEY);
      if (!raw) {
        return;
      }

      const parsed = normalizeAndroidWidgetBootstrapRequest(JSON.parse(raw));
      if (!parsed) {
        this.persistPendingAndroidWidgetBootstrapToStorage(null);
        return;
      }

      this.pendingAndroidWidgetBootstrap.set(parsed);
    } catch {
      this.persistPendingAndroidWidgetBootstrapToStorage(null);
    }
  }

  private restoreDeferredStartupEntryIntentFromStorage(): void {
    if (typeof window === 'undefined' || typeof window.sessionStorage === 'undefined') {
      return;
    }

    try {
      const raw = window.sessionStorage.getItem(ANDROID_WIDGET_STARTUP_INTENT_STORAGE_KEY);
      if (!raw) {
        return;
      }

      const parsed = normalizeStartupEntryIntent(JSON.parse(raw));
      if (!parsed) {
        this.persistDeferredStartupEntryIntentToStorage(null);
        return;
      }

      this.deferredStartupEntryIntent.set(parsed);
    } catch {
      this.persistDeferredStartupEntryIntentToStorage(null);
    }
  }

  private persistPendingAndroidWidgetBootstrapToStorage(request: AndroidWidgetBootstrapRequest | null): void {
    if (typeof window === 'undefined' || typeof window.sessionStorage === 'undefined') {
      return;
    }

    if (!request) {
      window.sessionStorage.removeItem(ANDROID_WIDGET_BOOTSTRAP_STORAGE_KEY);
      return;
    }

    window.sessionStorage.setItem(ANDROID_WIDGET_BOOTSTRAP_STORAGE_KEY, JSON.stringify(request));
  }

  private persistDeferredStartupEntryIntentToStorage(startupEntryIntent: StartupEntryIntent | null): void {
    if (typeof window === 'undefined' || typeof window.sessionStorage === 'undefined') {
      return;
    }

    if (!startupEntryIntent) {
      window.sessionStorage.removeItem(ANDROID_WIDGET_STARTUP_INTENT_STORAGE_KEY);
      return;
    }

    window.sessionStorage.setItem(ANDROID_WIDGET_STARTUP_INTENT_STORAGE_KEY, JSON.stringify(startupEntryIntent));
  }

  private resolveStartupProjectFallbackId(projects: Project[]): string | null {
    if (projects.length === 0) {
      return null;
    }

    const snapshotProjectId =
      this.startupLaunchSnapshot?.currentProject?.id
      ?? this.startupLaunchSnapshot?.activeProjectId
      ?? null;

    if (snapshotProjectId && projects.some((project) => project.id === snapshotProjectId)) {
      return snapshotProjectId;
    }

    return projects[0]?.id ?? null;
  }

  private resolveMobileRootStartupProjectId(): string | null {
    if (!this.uiState.isMobile()) {
      return null;
    }

    const activeProjectId = this.projectState.activeProjectId();
    if (activeProjectId) {
      return activeProjectId;
    }

    return this.resolveStartupProjectFallbackId(this.projectState.projects());
  }

  private shouldNavigateRootStartupToTextProject(): boolean {
    if (this.rootStartupTextNavigationApplied || !this.uiState.isMobile()) {
      return false;
    }

    const routeUrl = this.routeUrl();
    const routePath = routeUrl.split('?')[0] ?? routeUrl;
    if (routePath !== '/projects') {
      return false;
    }

    const startupEntryIntent = this.getCurrentStartupEntryIntent();
    return !startupEntryIntent || startupEntryIntent.intent === 'open-workspace';
  }

  private navigateRootStartupToTextProject(projectId: string): void {
    if (!this.shouldNavigateRootStartupToTextProject()) {
      return;
    }

    this.rootStartupTextNavigationApplied = true;
    void this.router.navigate(['/projects', projectId, 'text'], {
      replaceUrl: true,
      queryParamsHandling: 'preserve',
    });
  }

  private setupHandoffEffect(): void {
    // HandoffCoordinator.resolve() 驱动移动端路由降级和登录检测。
    // 启动壳已移除，但 resolve 结果仍影响：
    // 1. 移动端文本视图回退（degraded-to-text / degraded-to-project）
    // 2. showLoginRequired 条件判断
    effect(() => {
      if (!FEATURE_FLAGS.SNAPSHOT_HANDOFF_V2) {
        return;
      }

      const currentRouteUrl = this.routeUrl();
      const projects = this.projectState.projects();
      const activeProjectId = this.projectState.activeProjectId();
      const startupProjectCatalogStage = this.userSession.startupProjectCatalogStage();
      const trustedStartupSnapshot =
        this.userSession.trustedPrehydratedSnapshotVisible() && startupProjectCatalogStage === 'partial'
          ? this.startupLaunchSnapshot
          : null;
      const result = this.handoffCoordinator.resolve({
        routeUrl: currentRouteUrl,
        isMobile: this.uiState.isMobile(),
        hasProjects: projects.length > 0,
        activeProjectId,
        authConfigured: this.authService.isConfigured,
        authRuntimeState: this.authService.runtimeState(),
        isCheckingSession: this.authCoord.isCheckingSession(),
        showLoginRequired: this.authCoord.showLoginRequired(),
        bootstrapFailed: this.authCoord.bootstrapFailed(),
        snapshot: trustedStartupSnapshot,
        snapshotProjectsTrusted: trustedStartupSnapshot !== null,
      });

      if (result.kind === 'degraded-to-project' && !activeProjectId && projects.length > 0) {
        const snapshotProjectId = trustedStartupSnapshot?.currentProject?.id ?? null;
        const fallbackProjectId = projects.some((project) => project.id === snapshotProjectId)
          ? snapshotProjectId
          : projects[0].id;
        this.userSession.switchActiveProject(fallbackProjectId);
      }
    });
  }

  private setupWorkspaceReadyEffect(): void {
    effect(() => {
      if (!this.bootStage.isWorkspaceHandoffReady()) {
        return;
      }

      this.commitWorkspaceHandoff();
    });
  }

  private commitWorkspaceHandoff(): void {
    if (this.workspaceReadyCommitted || !this.bootStage.isWorkspaceHandoffReady()) {
      return;
    }

    this.workspaceReadyCommitted = true;

    // handoff 真正生效后再移除初始 loader，避免移动端在视图切换与布局计算之间出现空白或崩坏。
    if (typeof document !== 'undefined') {
      const loader = document.getElementById('initial-loader');
      if (loader) {
        loader.style.display = 'none';
      }
    }

    this.bootStage.noteLoaderHidden();
    this.startupTier.markHandoffReady();
    this.bootStage.markApplicationReady();
    this.flushWidgetWorkspaceGateRecheck();
  }

  /** Focus 启动探针：登录后尽早执行本地 gate 检查 */
  private setupFocusProbeEffect(): void {
    effect(() => {
      if (!FEATURE_FLAGS.FOCUS_STARTUP_THROTTLED_CHECK_V1) return;

      const userId = this.currentUserId();
      if (!userId) {
        this.focusProbeInitializedForUser = null;
        return;
      }

      this.flushWidgetWorkspaceGateRecheck();

      if (!this.coreDataLoaded()) return;
      if (this.focusProbeInitializedForUser === userId) return;

      this.focusProbeInitializedForUser = userId;
      this.focusStartupProbe.initialize();
      this.flushWidgetWorkspaceGateRecheck();
    });
  }

  /** 分层启动补水：auth → p1 warmup → p2 sync */
  private setupStartupTierEffects(): void {
    effect(() => {
      if (!FEATURE_FLAGS.TIERED_STARTUP_HYDRATION_V1) return;
      if (!this.currentUserId()) return;
      if (!this.coreDataLoaded()) return;

      this.startupTier.markAuthReady();
    });

    effect(() => {
      if (!FEATURE_FLAGS.TIERED_STARTUP_HYDRATION_V1) return;
      if (!this.startupTier.isTierReady('p1')) return;
      if (this.interactionWarmupDone) return;

      this.interactionWarmupDone = true;
      void this.taskOpsAdapter.warmup();
      if (FEATURE_FLAGS.SIDEBAR_TOOLS_DYNAMIC_LOAD_V1) {
        this.preloadSidebarTools('p1');
      }
    });

    effect(() => {
      if (!FEATURE_FLAGS.TIERED_STARTUP_HYDRATION_V1) return;
      if (!this.startupTier.isTierReady('p2')) return;
      if (this.syncHydrationDone) return;

      this.syncHydrationDone = true;
      this.syncCoordinator.initialize();
      this.simpleSync.startRuntime();
    });
  }

  /** 远程变更回调初始化 */
  private setupRemoteCallbackEffect(): void {
    effect(() => {
      if (!FEATURE_FLAGS.RESUME_INTERACTION_FIRST_V1) return;

      const userId = this.currentUserId();
      if (!userId || !this.coreDataLoaded()) {
        return;
      }

      if (FEATURE_FLAGS.TIERED_STARTUP_HYDRATION_V1 && !this.startupTier.isTierReady('p2')) {
        return;
      }

      if (this.remoteCallbacksInitialized || this.remoteCallbacksInitializing) {
        return;
      }

      this.remoteCallbacksInitializing = true;
      void this.getRemoteChangeHandlerLazy().then((handler) => {
        if (!handler) {
          this.remoteCallbacksInitializing = false;
          return;
        }

        handler.setupCallbacks({
          onRefreshActiveProject: async (reason) => { await this.syncCoordinator.refreshActiveProjectSilent(reason); },
          onLoadProjects: async () => {
            await this.syncCoordinator.refreshActiveProjectSilent('remote:fallback-load-projects');
          }
        });

        this.remoteCallbacksInitialized = true;
        this.remoteCallbacksInitializing = false;
      }).catch((error) => {
        this.logger.warn('恢复回调初始化失败', error);
        this.remoteCallbacksInitializing = false;
      });
    });
  }

  /** 项目订阅管理 */
  private setupSubscriptionEffect(): void {
    effect(() => {
      if (!FEATURE_FLAGS.RESUME_INTERACTION_FIRST_V1) return;

      const userId = this.currentUserId();
      const projectId = this.activeProjectId();
      const readyForSubscription = !!userId &&
        this.coreDataLoaded() &&
        (!FEATURE_FLAGS.TIERED_STARTUP_HYDRATION_V1 || this.startupTier.isTierReady('p2'));

      if (!readyForSubscription || !userId) {
        if (this.subscribedProjectId !== null) {
          this.subscribedProjectId = null;
          void this.simpleSync.unsubscribeFromProject();
        }
        return;
      }

      if (!projectId) {
        if (this.subscribedProjectId !== null) {
          this.subscribedProjectId = null;
          void this.simpleSync.unsubscribeFromProject();
        }
        return;
      }

      if (this.subscribedProjectId === projectId) {
        return;
      }

      this.subscribedProjectId = projectId;
      void this.simpleSync.subscribeToProject(projectId, userId);
    });
  }

  private setupFocusEntryOwnerEffect(): void {
    effect(() => {
      const ownerId = this.currentUserId();
      if (this.focusEntryOwnerScope === undefined) {
        this.focusEntryOwnerScope = ownerId;
        return;
      }

      if (this.focusEntryOwnerScope === ownerId) {
        return;
      }

      this.focusEntryOwnerScope = ownerId;
      this.resetFocusEntrySyncPulseState(ownerId !== null);
    });
  }

  /** 同步心跳管理 */
  private setupSyncPulseEffect(): void {
    effect(() => {
      if (!FEATURE_FLAGS.EVENT_DRIVEN_SYNC_PULSE_V1) {
        this.destroySyncPulse();
        return;
      }

      const userId = this.currentUserId();
      if (!userId || !this.coreDataLoaded()) {
        this.destroySyncPulse();
        return;
      }

      if (FEATURE_FLAGS.TIERED_STARTUP_HYDRATION_V1 && !this.startupTier.isTierReady('p2')) {
        this.destroySyncPulse();
        return;
      }

      this.initializeSyncPulse();
      this.dispatchFocusEntrySyncPulseIfReady();
    });
  }

  /**
   * 跨标签页登录恢复：先完成 owner 切换，再允许同步运行时恢复到新会话。
   */
  private setupSessionRestoredHandler(): void {
    this.eventBus.onSessionRestored$.pipe(
      takeUntilDestroyed(this.destroyRef)
    ).subscribe((event) => {
      if (event.source !== 'AuthService.storageBridge') {
        return;
      }

      if (this.currentUserId() === event.userId) {
        this.authService.completeCrossTabSessionRestore(event.userId);
        return;
      }

      this.logger.warn('跨标签页会话恢复，切换 owner 视图', {
        restoredUserId: event.userId,
        source: event.source,
      });
      this.resetFocusEntrySyncPulseState(false);
      this.launchSnapshotWriteBlocked.set(true);
      this.launchSnapshot.cancelPendingPersist();
      this.simpleSync.stopRuntime();
      if (this.subscribedProjectId !== null) {
        this.subscribedProjectId = null;
        void this.simpleSync.unsubscribeFromProject();
      }
      this.destroySyncPulse();
      void (async () => {
        try {
          await this.userSession.setCurrentUser(event.userId, {
            forceLoad: true,
          });

          if (this.currentUserId() !== event.userId) {
            return;
          }

          this.authService.completeCrossTabSessionRestore(event.userId);
          if (!FEATURE_FLAGS.TIERED_STARTUP_HYDRATION_V1 || this.startupTier.isTierReady('p2')) {
            this.simpleSync.startRuntime();
          }
        } catch (error) {
          this.logger.warn('跨标签页会话恢复失败，已保持同步运行时暂停', {
            restoredUserId: event.userId,
            source: event.source,
            error,
          });
        } finally {
          this.launchSnapshotWriteBlocked.set(false);
        }
      })();
    });
  }

  /**
   * 会话失效处理：后台刷新发现 FastPath 乐观身份无效时，
   * 立即停止同步运行时和重试队列，防止以失效 token 推送数据。
   */
  private setupSessionInvalidatedHandler(): void {
    this.eventBus.onSessionInvalidated$.pipe(
      takeUntilDestroyed(this.destroyRef)
    ).subscribe((event) => {
      this.logger.warn('会话失效，停止同步运行时并清空旧 owner 视图', {
        invalidatedUserId: event.userId,
        source: event.source,
      });
      this.resetFocusEntrySyncPulseState(false);
      this.launchSnapshotWriteBlocked.set(true);
      this.launchSnapshot.cancelPendingPersist();
      this.simpleSync.stopRuntime();
      if (this.subscribedProjectId !== null) {
        this.subscribedProjectId = null;
        void this.simpleSync.unsubscribeFromProject();
      }
      this.destroySyncPulse();
      void this.userSession.setCurrentUser(null, {
        skipPersistentReload: true,
        previousUserIdHint: event.userId,
        preserveOfflineSnapshot: true,
      }).finally(() => {
        this.launchSnapshotWriteBlocked.set(false);
      });
    });
  }

  ngOnDestroy() {
    this.destroyed = true;
    // DestroyRef 自动处理取消订阅，无需手动触发
    
    // 确保待处理的撤销操作被保存
    this.undoService.flushPendingAction();
    
    // 释放模态框协调器的回调引用，避免持有过期组件引用
    this.modalCoord.clearCallbacks();
    
    // 移除全局事件监听器
    window.removeEventListener('toggle-sidebar', this.handleToggleSidebar);
    document.removeEventListener('keydown', this.keyboardShortcutCaptureListener, { capture: true } as AddEventListenerOptions);
    this.teardownFocusMountIntentListener();
    this.clearFocusEntrySyncPulseRetry();
    this.teardownFlowRestoreBreadcrumbListener();
    this.teardownSyncPulseBreadcrumbListener();
    this.teardownSwUpdateChecks();
    this.destroySyncPulse();
    this.startupTier.destroy();
    if (FEATURE_FLAGS.RESUME_INTERACTION_FIRST_V1) {
      this.subscribedProjectId = null;
      void this.simpleSync.unsubscribeFromProject();
    }
    
    // 取消注册 beforeunload 回调
    // 注意：BeforeUnloadManagerService 是 providedIn: 'root'，不会随组件销毁
    // 但我们仍需取消注册此组件的回调
    this.beforeUnloadManager.unregister('app-core-save');
    this.beforeUnloadGuard.disable();
    
    // 清理搜索防抖定时器
    if (this.searchDebounceTimer) {
      clearTimeout(this.searchDebounceTimer);
      this.searchDebounceTimer = null;
    }
    // M-12 fix: 清理窗口 resize 防抖定时器
    if (this.resizeDebounceTimer) {
      clearTimeout(this.resizeDebounceTimer);
      this.resizeDebounceTimer = null;
    }
    this.clearAndroidWidgetManualCallbackFallbackTimer();
  }

  private scheduleStartupFontInitialization(): void {
    if (this.startupFontSchedulerInitPromise) {
      return;
    }

    this.startupFontSchedulerInitPromise = import('./services/startup-font-scheduler.service')
      .then(({ StartupFontSchedulerService }) => {
        this.injector.get(StartupFontSchedulerService).initialize();
      })
      .catch((error: unknown) => {
        this.startupFontSchedulerInitPromise = null;
        this.logger.warn('延迟初始化字体调度器失败', error);
      });
  }

  private async getRemoteChangeHandlerLazy(): Promise<RemoteChangeHandlerLike | null> {
    if (this.remoteChangeHandlerPromise) {
      return this.remoteChangeHandlerPromise;
    }

    this.remoteChangeHandlerPromise = import('./services/remote-change-handler.service')
      .then((module) => this.injector.get(module.RemoteChangeHandlerService))
      .catch((error) => {
        this.logger.warn('RemoteChangeHandlerService 懒加载失败，降级为无回调恢复路径', error);
        return null;
      })
      .finally(() => {
        this.remoteChangeHandlerPromise = null;
      });

    return this.remoteChangeHandlerPromise;
  }

  private async getEventDrivenSyncPulseLazy(): Promise<EventDrivenSyncPulseLike | null> {
    if (this.eventDrivenSyncPulseRef) {
      return this.eventDrivenSyncPulseRef;
    }
    if (this.eventDrivenSyncPulsePromise) {
      return this.eventDrivenSyncPulsePromise;
    }

    this.eventDrivenSyncPulsePromise = import('./services/event-driven-sync-pulse.service')
      .then((module) => {
        const service = this.injector.get(module.EventDrivenSyncPulseService) as EventDrivenSyncPulseLike;
        this.eventDrivenSyncPulseRef = service;
        return service;
      })
      .catch((error) => {
        this.logger.warn('EventDrivenSyncPulseService 懒加载失败，降级关闭 pulse', error);
        return null;
      })
      .finally(() => {
        this.eventDrivenSyncPulsePromise = null;
      });

    return this.eventDrivenSyncPulsePromise;
  }

  private isSyncPulseReady(): boolean {
    if (!FEATURE_FLAGS.EVENT_DRIVEN_SYNC_PULSE_V1) {
      return false;
    }

    if (!this.currentUserId() || !this.coreDataLoaded()) {
      return false;
    }

    if (!this.networkAwareness.isOnline()) {
      return false;
    }

    if (this.appLifecycle.isResuming() || this.appLifecycle.isRecoveryCompensationInFlight()) {
      return false;
    }

    if (FEATURE_FLAGS.RECOVERY_TICKET_DEDUP_V1 && this.appLifecycle.getCurrentRecoveryTicket()) {
      return false;
    }

    if (FEATURE_FLAGS.TIERED_STARTUP_HYDRATION_V1 && !this.startupTier.isTierReady('p2')) {
      return false;
    }

    return true;
  }

  private resetFocusEntrySyncPulseState(rearmIntentListener = true): void {
    this.focusEntryPulseGeneration += 1;
    this.clearFocusEntrySyncPulseRetry();
    this.focusEntryPulsePending = false;
    this.focusEntryPulseDispatched = false;
    this.focusModeIntentActivated.set(!FEATURE_FLAGS.FOCUS_STARTUP_THROTTLED_CHECK_V1);
    this.teardownFocusMountIntentListener();
    if (rearmIntentListener) {
      this.setupFocusMountIntentListener();
    }
  }

  private dispatchFocusEntrySyncPulseIfReady(): void {
    if (
      !this.focusModeIntentActivated()
      || this.focusEntryPulseDispatched
      || this.focusEntryPulsePending
      || !this.isSyncPulseReady()
    ) {
      return;
    }

    this.clearFocusEntrySyncPulseRetry();
    const generation = this.focusEntryPulseGeneration;
    this.focusEntryPulsePending = true;
    void this.triggerSyncPulse('focus-entry')
      .then((result) => {
        if (generation !== this.focusEntryPulseGeneration || !result) {
          return;
        }

        if (result.status === 'success') {
          this.focusEntryPulseDispatched = true;
          return;
        }

        if (result.status === 'skipped') {
          this.scheduleFocusEntrySyncPulseRetry(result.skipReason, result.retryAfterMs);
        }
      })
      .finally(() => {
        if (generation === this.focusEntryPulseGeneration) {
          this.focusEntryPulsePending = false;
        }
      });
  }

  private checkGateForMobileProjectEntry(): void {
    if (!FEATURE_FLAGS.FOCUS_STARTUP_THROTTLED_CHECK_V1 || !this.uiState.isMobile()) {
      return;
    }

    this.focusModeIntentActivated.set(true);
    this.dispatchFocusEntrySyncPulseIfReady();
    this.teardownFocusMountIntentListener();
    this.focusStartupProbe.checkGateForProjectEntry();
  }

  private async triggerSyncPulse(
    reason: 'focus-entry' | 'manual' | 'focus' | 'visible' | 'pageshow' | 'online' | 'heartbeat'
  ): Promise<Awaited<ReturnType<EventDrivenSyncPulseLike['triggerNow']>> | null> {
    if (!this.isSyncPulseReady()) {
      return null;
    }

    const service = await this.getEventDrivenSyncPulseLazy();
    if (!service) {
      return null;
    }

    return service.triggerNow(reason);
  }

  private initializeSyncPulse(): void {
    void this.getEventDrivenSyncPulseLazy().then((service) => service?.initialize());
  }

  private clearFocusEntrySyncPulseRetry(): void {
    if (!this.focusEntryPulseRetryTimer) {
      return;
    }

    clearTimeout(this.focusEntryPulseRetryTimer);
    this.focusEntryPulseRetryTimer = null;
  }

  private scheduleFocusEntrySyncPulseRetry(
    skipReason?: Awaited<ReturnType<EventDrivenSyncPulseLike['triggerNow']>>['skipReason'],
    retryAfterMs?: Awaited<ReturnType<EventDrivenSyncPulseLike['triggerNow']>>['retryAfterMs']
  ): void {
    const delay = retryAfterMs ?? (
      skipReason === 'cooldown'
        ? STARTUP_PERF_CONFIG.SYNC_EVENT_COOLDOWN_MS
        : skipReason === 'post-heavy-cooldown'
          ? APP_LIFECYCLE_CONFIG.PULSE_SUPPRESS_AFTER_HEAVY_MS
          : null
    );

    if (delay === null) {
      return;
    }

    this.clearFocusEntrySyncPulseRetry();
    this.focusEntryPulseRetryTimer = setTimeout(() => {
      this.focusEntryPulseRetryTimer = null;
      this.dispatchFocusEntrySyncPulseIfReady();
    }, delay);
  }

  private destroySyncPulse(): void {
    if (this.eventDrivenSyncPulseRef) {
      this.eventDrivenSyncPulseRef.destroy();
      return;
    }
    if (this.eventDrivenSyncPulsePromise) {
      void this.eventDrivenSyncPulsePromise.then((service) => service?.destroy());
    }
  }

  private initializeStartupDiagnosticsLazy(): void {
    if (this.startupDiagnosticsPromise) {
      return;
    }

    this.startupDiagnosticsPromise = Promise.all([
      import('./services/storage-quota.service'),
      import('./services/indexeddb-health.service'),
    ]).then(([quotaModule, healthModule]) => {
      const quota = this.injector.get(quotaModule.StorageQuotaService) as StartupDiagnosticsLike;
      const health = this.injector.get(healthModule.IndexedDBHealthService) as unknown as StartupDiagnosticsLike;
      return [quota, health];
    }).catch((error) => {
      this.logger.warn('启动诊断服务懒加载失败，已跳过', error);
      return null;
    });

    void this.startupDiagnosticsPromise.then((services) => {
      if (!services) return;
      for (const service of services) {
        void Promise.resolve(service.initialize());
      }
    });
  }

  private setupFocusMountIntentListener(): void {
    if (typeof window === 'undefined' || !FEATURE_FLAGS.FOCUS_STARTUP_THROTTLED_CHECK_V1) {
      return;
    }
    window.addEventListener('pointerdown', this.focusMountIntentListener, { once: true, passive: true });
    window.addEventListener('keydown', this.focusMountIntentListener, { once: true });
    window.addEventListener('touchstart', this.focusMountIntentListener, { once: true, passive: true });
  }

  private teardownFocusMountIntentListener(): void {
    if (typeof window === 'undefined') return;
    window.removeEventListener('pointerdown', this.focusMountIntentListener);
    window.removeEventListener('keydown', this.focusMountIntentListener);
    window.removeEventListener('touchstart', this.focusMountIntentListener);
  }

  private setupFlowRestoreBreadcrumbListener(): void {
    if (typeof window === 'undefined') return;
    window.addEventListener('nanoflow:flow-restore-status', this.flowRestoreBreadcrumbListener as EventListener);
  }

  private teardownFlowRestoreBreadcrumbListener(): void {
    if (typeof window === 'undefined') return;
    window.removeEventListener('nanoflow:flow-restore-status', this.flowRestoreBreadcrumbListener as EventListener);
  }

  private setupSyncPulseBreadcrumbListener(): void {
    if (typeof window === 'undefined') return;
    window.addEventListener('nanoflow:sync-pulse', this.syncPulseBreadcrumbListener as EventListener);
  }

  private teardownSyncPulseBreadcrumbListener(): void {
    if (typeof window === 'undefined') return;
    window.removeEventListener('nanoflow:sync-pulse', this.syncPulseBreadcrumbListener as EventListener);
  }

  private recordStartupPreloadBreadcrumb(): void {
    if (typeof window === 'undefined') return;
    const preloadDisabled = (window as { __NANOFLOW_PRELOAD_DISABLED__?: boolean }).__NANOFLOW_PRELOAD_DISABLED__ !== false;
    this.sentryLazyLoader.addBreadcrumb({
      category: 'startup',
      message: preloadDisabled ? 'startup.preload.disabled' : 'startup.preload.enabled',
      level: 'info',
      data: { preloadDisabled },
    });
  }

  private recordModulePreloadModeBreadcrumb(): void {
    if (typeof window === 'undefined') return;

    const strictModulepreload =
      (window as Window).__NANOFLOW_BOOT_FLAGS__?.STRICT_MODULEPRELOAD_V2 !== false;

    this.sentryLazyLoader.addBreadcrumb({
      category: 'startup',
      message: strictModulepreload
        ? 'startup.modulepreload.strict'
        : 'startup.modulepreload.relaxed',
      level: 'info',
      data: { strictModulepreload },
    });
  }
  
  /** 设置页面卸载前的数据保存处理器 */
  private setupBeforeUnloadHandler(): void {
    if (typeof window === 'undefined') return;
    this.beforeUnloadManager.initialize();
    this.beforeUnloadGuard.enable();
    this.beforeUnloadManager.register('app-core-save', () => {
      this.syncCoordinator.flushPendingPersist();
      this.undoService.flushPendingAction();
      this.simpleSync.flushRetryQueueSync();
      // 【NEW-6 修复】同步刷盘 ActionQueue 待处理操作到 localStorage
      // ActionQueue 内存中的操作若未持久化，页面关闭后将丢失
      this.actionQueue.storage.saveQueueToStorage();
      this.actionQueue.storage.saveDeadLetterToStorage();
      return false;
    }, 1);
  }
  
  /**
   * 监听子组件发出的 toggle-sidebar 事件
   * 箭头函数确保 this 绑定正确
   */
  private handleToggleSidebar = () => {
    this.isSidebarOpen.update(v => !v);
  };
  
  private setupSidebarToggleListener() {
    window.removeEventListener('toggle-sidebar', this.handleToggleSidebar);
    window.addEventListener('toggle-sidebar', this.handleToggleSidebar);
  }
  
  /**
   * 设置存储失败处理器
   * 
   * 当 localStorage 和 IndexedDB 都失败时，显示逃生模态框
   * 让用户手动复制数据进行备份
   */
  private setupStorageFailureHandler(): void {
    this.actionQueue.onStorageFailure((data) => {
      // 构造逃生数据
      const escapeData: StorageEscapeData = {
        queue: data.queue,
        deadLetter: data.deadLetter,
        projects: this.projectState.projects(), // 附加当前项目数据
        timestamp: new Date().toISOString()
      };

      this.modalCoord.storageEscapeData.set(escapeData);
      // 使用命令式方式打开存储逃生模态框
      void this.modalCoord.openStorageEscapeModalImperative();
    });
  }

  /**
   * 关闭存储逃生模态框
   */
  closeStorageEscapeModal(): void {
    this.modalCoord.closeStorageEscapeModal();
  }
  
  /**
   * 设置路由参数与状态的同步
   * 监听 URL 变化并更新 activeProjectId
   */
  private setupRouteSync() {
    // 监听路由参数变化
    this.router.events.pipe(
      filter(event => event instanceof NavigationEnd),
      takeUntilDestroyed(this.destroyRef)
    ).subscribe(() => {
      this.syncStateFromRoute();
    });
    
    // 初始同步
    this.syncStateFromRoute();
    
    // 监听 activeProjectId 变化，更新 URL
    // 使用 effect 或手动订阅
  }
  
  /**
   * 从路由参数同步状态
   */
  private syncStateFromRoute() {
    // 获取当前完整路由
    let currentRoute = this.route;
    while (currentRoute.firstChild) {
      currentRoute = currentRoute.firstChild;
    }
    
    const params = currentRoute.snapshot.params;
    const projectId = params['projectId'];
    const projects = this.projectState.projects();
    const canAuthoritativelyRejectProjectRoute = this.userSession.canAuthoritativelyRejectProjectRoute();

    if (!projectId) {
      const activeProjectId = this.projectState.activeProjectId();
      if (activeProjectId) {
        this.navigateRootStartupToTextProject(activeProjectId);
        return;
      }

      if (projects.length === 0) {
        return;
      }

      const fallbackProjectId = this.resolveStartupProjectFallbackId(projects);
      if (fallbackProjectId) {
        this.userSession.switchActiveProject(fallbackProjectId);
        this.navigateRootStartupToTextProject(fallbackProjectId);
      }
      return;
    }

    const projectExists = projects.some(p => p.id === projectId);
    const isAuthoritativelyAccessible = !canAuthoritativelyRejectProjectRoute
      || this.userSession.isProjectAuthoritativelyAccessible(projectId);
    if (projectExists && isAuthoritativelyAccessible) {
      this.userSession.switchActiveProject(projectId);
      return;
    }

    if (!canAuthoritativelyRejectProjectRoute || isAuthoritativelyAccessible) {
      // 预填充阶段只有最近项目摘要，不能据此判定 deep-link 项目不存在。
      return;
    }

    // 项目不存在，重定向到默认路由
    void this.router.navigate(['/projects']);
    
    // taskId 的定位由 ProjectShellComponent 处理
  }
  
  /**
   * 更新 URL 以反映当前状态（可选调用）
   */
  updateUrlForProject(projectId: string) {
    void this.router.navigate(['/projects', projectId], { 
      replaceUrl: true,
      queryParamsHandling: 'preserve'
    });
  }
  
  private setupConflictHandler() {
    // 订阅冲突事件流 - 使用命令式模态框
    this.syncCoordinator.onConflict$.pipe(
      takeUntilDestroyed(this.destroyRef)
    ).subscribe(({ localProject, remoteProject, projectId, pendingTaskDeleteIds }) => {
      // 存储冲突数据供解决方法使用
      this.modalCoord.setPendingConflict({ localProject, remoteProject, projectId, pendingTaskDeleteIds });
      void this.modalCoord.openConflictModal({ localProject, remoteProject, projectId, pendingTaskDeleteIds });
    });
  }

  // 解决冲突：使用本地版本
  async resolveConflictLocal() {
    await this.modalCoord.resolveConflictLocal();
  }

  // 解决冲突：使用远程版本
  async resolveConflictRemote() {
    await this.modalCoord.resolveConflictRemote();
  }

  // 解决冲突：智能合并
  async resolveConflictMerge() {
    await this.modalCoord.resolveConflictMerge();
  }

  // 取消冲突解决（稍后处理）
  cancelConflictResolution() {
    this.modalCoord.cancelConflictResolution();
  }
  
  private setupSwUpdateListener() {
    if (this.swUpdate.isEnabled) {
      this.swUpdate.versionUpdates
        .pipe(
          filter((evt): evt is VersionReadyEvent => evt.type === 'VERSION_READY'),
          takeUntilDestroyed(this.destroyRef)
        )
        .subscribe(() => {
          this.appLifecycle.markVersionReady();
          // 使用 ToastService 显示更新通知，带操作按钮。
          //
          // 关键修复（2026-05-15）：onClick 现在先调用 swUpdate.activateUpdate()
          // 让 waiting SW 真正进入 active 状态，然后再走 reloadViaForceClearCache。
          // 历史实现只清缓存 + reload，在 cache 清理超时被跳过时旧 SW 仍是 controller，
          // reload 会命中旧 ngsw 缓存返回旧 HTML/JS，UI 看起来「没反应」。
          this.toast.info(
            '🚀 发现新版本',
            '软件有更新可用，点击刷新获取最新功能',
            {
              duration: 0, // 不自动关闭
              action: {
                label: '立即刷新',
                pendingLabel: '正在刷新…',
                onClick: async () => {
                  try {
                    await this.swUpdate.activateUpdate();
                    this.logger.info('SwUpdate activateUpdate succeeded');
                  } catch (err) {
                    // activateUpdate 在跨域 / 第三方 SW 拦截下可能失败；仍兜底走 reload。
                    this.logger.warn('SwUpdate activateUpdate failed; falling back to force-clear-cache', err);
                  }
                  reloadViaForceClearCache();
                }
              }
            }
          );
        });
      this.setupSwUpdateChecks();
    }
  }

  private setupSwUpdateChecks(): void {
    this.scheduleSwUpdateCheck('startup', APP_LIFECYCLE_CONFIG.SW_UPDATE_INITIAL_CHECK_DELAY_MS, true);

    if (!this.swUpdatePollTimer) {
      this.swUpdatePollTimer = setInterval(() => {
        void this.checkForSwUpdate('periodic');
      }, APP_LIFECYCLE_CONFIG.SW_UPDATE_VISIBLE_POLL_INTERVAL_MS);
    }

    document.addEventListener('visibilitychange', this.handleSwUpdateVisibilityCheck);
    window.addEventListener('focus', this.handleSwUpdateFocusCheck);
    window.addEventListener('online', this.handleSwUpdateOnlineCheck);
  }

  private scheduleSwUpdateCheck(reason: SwUpdateCheckReason, delayMs: number, force = false): void {
    if (this.swUpdateInitialCheckTimer) {
      clearTimeout(this.swUpdateInitialCheckTimer);
    }

    this.swUpdateInitialCheckTimer = setTimeout(() => {
      this.swUpdateInitialCheckTimer = null;
      void this.checkForSwUpdate(reason, force);
    }, delayMs);
  }

  private async checkForSwUpdate(reason: SwUpdateCheckReason, force = false): Promise<void> {
    if (!this.swUpdate.isEnabled || this.destroyed || this.swUpdateCheckInFlight) {
      return;
    }

    if (document.visibilityState === 'hidden') {
      return;
    }

    const now = Date.now();
    if (!force && now - this.lastSwUpdateCheckAt < APP_LIFECYCLE_CONFIG.SW_UPDATE_RESUME_CHECK_COOLDOWN_MS) {
      return;
    }

    this.lastSwUpdateCheckAt = now;
    this.swUpdateCheckInFlight = true;
    try {
      const updateFound = await this.swUpdate.checkForUpdate();
      if (updateFound) {
        this.logger.info('SwUpdate checkForUpdate detected a deploy version', { reason });
      } else {
        this.logger.debug('SwUpdate checkForUpdate completed without new version', { reason });
      }
    } catch (error) {
      this.logger.warn('SwUpdate checkForUpdate failed', {
        reason,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.swUpdateCheckInFlight = false;
    }
  }

  private teardownSwUpdateChecks(): void {
    if (this.swUpdateInitialCheckTimer) {
      clearTimeout(this.swUpdateInitialCheckTimer);
      this.swUpdateInitialCheckTimer = null;
    }
    if (this.swUpdatePollTimer) {
      clearInterval(this.swUpdatePollTimer);
      this.swUpdatePollTimer = null;
    }
    document.removeEventListener('visibilitychange', this.handleSwUpdateVisibilityCheck);
    window.removeEventListener('focus', this.handleSwUpdateFocusCheck);
    window.removeEventListener('online', this.handleSwUpdateOnlineCheck);
  }

  // Resizing State
  isResizingSidebar = false;
  isResizingContent = false;
  /** 模板绑定：是否正在拖拽分栏 */
  get isResizingAny() { return this.isResizingSidebar || this.isResizingContent; }
  private startX = 0;
  private startWidth = 0;
  private startRatio = 0;
  private mainContentWidth = 0;
  private resizeRafId = 0;

  toggleSidebar() {
    this.isSidebarOpen.update(v => !v);
  }

  // --- Resizing Logic ---

  startSidebarResize(e: MouseEvent) {
      e.preventDefault();
      this.isResizingSidebar = true;
      this.uiState.isResizing.set(true);
      this.startX = e.clientX;
      this.startWidth = this.uiState.sidebarWidth();
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
  }

  startContentResize(e: MouseEvent) {
      e.preventDefault();
      this.isResizingContent = true;
      this.startX = e.clientX;
      this.startRatio = this.uiState.textColumnRatio();
      
      // Get current main content width
      const mainEl = document.querySelector('main');
      this.mainContentWidth = mainEl ? mainEl.clientWidth : 1000;
      
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
  }

  @HostListener('document:mousemove', ['$event'])
  onMouseMove(e: MouseEvent) {
      if (!this.isResizingSidebar && !this.isResizingContent) return;
      e.preventDefault();
      // 使用 rAF 节流，避免每个 mousemove 都触发布局计算
      if (this.resizeRafId) return;
      const clientX = e.clientX;
      this.resizeRafId = requestAnimationFrame(() => {
          this.resizeRafId = 0;
          if (this.isResizingSidebar) {
              const delta = clientX - this.startX;
              const newWidth = Math.max(200, Math.min(600, this.startWidth + delta));
              this.uiState.sidebarWidth.set(newWidth);
          } else if (this.isResizingContent) {
              const delta = clientX - this.startX;
              const deltaPercent = (delta / this.mainContentWidth) * 100;
              const newRatio = Math.max(25, Math.min(75, this.startRatio + deltaPercent));
              this.uiState.textColumnRatio.set(newRatio);
          }
      });
  }

  @HostListener('document:mouseup')
  onMouseUp() {
      if (this.isResizingSidebar || this.isResizingContent) {
          if (this.resizeRafId) {
              cancelAnimationFrame(this.resizeRafId);
              this.resizeRafId = 0;
          }
          this.isResizingSidebar = false;
          this.isResizingContent = false;
          this.uiState.isResizing.set(false);
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
      }
  }

  /** 重试启动会话 */
  retryBootstrap() {
    this.authCoord.retryBootstrap();
  }

  async handleLogin(event?: Event, opts?: { closeSettings?: boolean }) {
    await this.authCoord.handleLogin(event, opts);
  }

  async handleSignup(event?: Event) {
    await this.authCoord.handleSignup(event);
  }

  async handleResetPassword(event?: Event) {
    await this.authCoord.handleResetPassword(event);
  }

  switchToSignup() { this.authCoord.switchToSignup(); }
  switchToLogin() { this.authCoord.switchToLogin(); }
  switchToResetPassword() { this.authCoord.switchToResetPassword(); }

async signOut() {
    const signedOut = await this.authCoord.signOut();
    if (!signedOut) {
      return;
    }

    this.resetFocusEntrySyncPulseState(false);
    this.destroySyncPulse();
    this.projectCoord.clearState();
    this.unifiedSearchQuery.set('');
  }

  startRelogin() {
    this.authCoord.startRelogin();
  }

  selectProject(id: string) {
    this.projectCoord.selectProject(id, this.isSidebarOpen);
    this.checkGateForMobileProjectEntry();
  }
  onProjectCardClick(event: MouseEvent, projectId: string) { this.projectCoord.onProjectCardClick(event, projectId); }
  @HostListener('document:click', ['$event'])
  onGlobalClick(event: MouseEvent) { this.projectCoord.handleGlobalClick(event); }
  enterProject(id: string) {
    this.projectCoord.enterProject(id, this.isSidebarOpen);
    this.checkGateForMobileProjectEntry();
  }
  handleProjectDoubleClick(id: string, event: MouseEvent) {
    if (this.userSession.isHintOnlyStartupPlaceholderVisible()) {
      event.preventDefault();
      event.stopPropagation();
      this.projectCoord.enterProject(id, this.isSidebarOpen);
      this.checkGateForMobileProjectEntry();
      return;
    }

    this.projectCoord.handleProjectDoubleClick(id, event, this.isSidebarOpen);
    this.checkGateForMobileProjectEntry();
  }
  startProjectDescriptionEdit(event: Event) {
    event.stopPropagation();
    if (this.blockHintOnlyMutation('编辑项目简介')) return;
    this.projectCoord.isEditingDescription.set(true);
  }
  startRenameProject(projectId: string, currentName: string, event: Event) {
    if (this.blockHintOnlyMutation('重命名项目')) return;
    this.projectCoord.startRenameProject(projectId, currentName, event);
  }
  executeRenameProject() {
    this.projectCoord.executeRenameProject();
  }
  cancelRenameProject() { this.projectCoord.cancelRenameProject(); }
  onRenameKeydown(event: KeyboardEvent) { this.projectCoord.onRenameKeydown(event); }
  projectDraft(projectId: string) { return this.projectCoord.projectDraft(projectId); }
  updateProjectDraft(projectId: string, field: 'description' | 'createdDate', value: string) {
    if (this.userSession.isHintOnlyStartupPlaceholderVisible()) return;
    this.projectCoord.updateProjectDraft(projectId, field, value);
  }
  saveProjectDetails(projectId: string) {
    this.projectCoord.saveProjectDetails(projectId);
  }
  createNewProject() {
    if (this.blockHintOnlyMutation('创建项目')) return;
    void this.openNewProjectModal();
  }
  onFocusFlowNode(taskId: string) { this.projectCoord.onFocusFlowNode(taskId); }
  onSearchTaskClick(taskId: string, isParked: boolean): void {
    const projectId = this.taskStore.getTaskProjectId(taskId)
      ?? this.projectState.activeProjectId();
    if (projectId && projectId !== this.projectState.activeProjectId()) {
      // 通过 UserSessionService 切换，触发空壳项目按需加载
      this.userSession.switchActiveProject(projectId);
    }

    if (isParked) {
      this.dockEngine.setDockExpanded(true, { persistPreference: false });
      this.parkingService.previewTask(taskId);
      return;
    }

    this.onFocusFlowNode(taskId);
  }
  async confirmCreateProject(name: string, desc: string) { await this.projectCoord.confirmCreateProject(name, desc); }
  async confirmDeleteProject(projectId: string, projectName: string, event: Event) {
    if (this.blockHintOnlyMutation('删除项目')) return;
    await this.projectCoord.confirmDeleteProject(projectId, projectName, event);
  }
  async handleImportComplete(project: Project) {
    if (this.blockHintOnlyMutation('导入项目')) return;
    await this.projectCoord.handleImportComplete(project);
  }
  
  // ========== Modal methods (delegated to WorkspaceModalCoordinatorService) ==========

  async openSettings(): Promise<void> { await this.modalCoord.openSettings(); }
  closeSettings() { this.modalCoord.closeSettings(); }
  async openDashboardFromSettings(): Promise<void> { await this.modalCoord.openDashboardFromSettings(); }
  async openDashboard(): Promise<void> { await this.modalCoord.openDashboard(); }
  /**
   * 打开仪表盘并直接落在"冲突" Tab，用于 sync-status 入口。
   * 2026-05-15 修复：之前侧边栏"X 个冲突待处理"无任何点击响应，导致已持久化的冲突
   * 记录在没有实时同步触发时永远无法手动处理。
   */
  async openDashboardAtConflicts(): Promise<void> { await this.modalCoord.openDashboard({ initialTab: 'conflicts' }); }
  openConflictCenterFromDashboard() { this.modalCoord.openConflictCenterFromDashboard(); }
  async openLoginModal(): Promise<void> { await this.modalCoord.openLoginModal(); }
  async openTrashModal(): Promise<void> { await this.modalCoord.openTrashModal(); }
  async openConfigHelpModal(): Promise<void> { await this.modalCoord.openConfigHelpModal(); }
  async openNewProjectModal(): Promise<void> { await this.modalCoord.openNewProjectModal(); }
  async openMigrationModal(): Promise<void> { await this.modalCoord.openMigrationModal(); }
  async openErrorRecoveryModal(error: {
    title: string;
    message: string;
    details?: string;
    options: unknown[];
    defaultOptionId?: string;
    autoSelectIn?: number | null;
    resolve: (result: { optionId: string }) => void;
  }): Promise<void> { await this.modalCoord.openErrorRecoveryModal(error); }
  async openStorageEscapeModalImperative(): Promise<void> { await this.modalCoord.openStorageEscapeModalImperative(); }

  updateLayoutDirection(e: Event) {
    const val = (e.target as HTMLSelectElement).value as 'ltr' | 'rtl';
    this.uiState.layoutDirection.set(val);
  }
  
  updateFloatPref(e: Event) {
      const val = (e.target as HTMLSelectElement).value as 'auto' | 'fixed';
      this.uiState.floatingWindowPref.set(val);
  }
  
  updateTheme(theme: ThemeType) {
    // 使用 store 的 setTheme 方法，统一主题管理和云端同步
    void this.preferenceService.setTheme(theme);
  }

  updateFilter(e: Event) {
      this.uiState.filterMode.set((e.target as HTMLSelectElement).value);
  }

  private completeAuthModalSuccess(fallbackUrl: string | null = null): void {
    const postAuthTargetUrl = this.authCoord.resolveSafePostAuthNavigationUrl(
      this.modalCoord.loginReturnUrl,
    ) ?? fallbackUrl;
    this.modalCoord.closeLoginModal();
    if (postAuthTargetUrl) {
      void this.router.navigateByUrl(postAuthTargetUrl);
    }
  }
  
  // 适配 LoginModalComponent 事件 — 委托到 authCoord
  async handleLoginFromModal(data: { email: string; password: string }) {
    this.modalCoord.loginModalRef?.componentRef.setInput('isLoading', true);
    this.modalCoord.loginModalRef?.componentRef.setInput('authError', null);

    await this.authCoord.handleLoginFromModal(data);

    if (!this.authCoord.authError()) {
      // 登录成功：关闭模态框并导航
      this.completeAuthModalSuccess();
    } else {
      // 登录失败：回显错误并恢复按钮
      this.modalCoord.loginModalRef?.componentRef.setInput('isLoading', false);
      this.modalCoord.loginModalRef?.componentRef.setInput('authError', this.authCoord.authError());
    }
  }
  async handleSignupFromModal(data: { email: string; password: string; confirmPassword: string }) {
    this.modalCoord.loginModalRef?.componentRef.setInput('isLoading', true);
    this.modalCoord.loginModalRef?.componentRef.setInput('authError', null);

    await this.authCoord.handleSignupFromModal(data);

    if (!this.authCoord.authError() && this.currentUserId()) {
      // 注册成功（无需确认）：关闭模态框
      this.completeAuthModalSuccess();
    } else {
      // 注册失败或需要邮件确认：回显状态
      this.modalCoord.loginModalRef?.componentRef.setInput('isLoading', false);
      this.modalCoord.loginModalRef?.componentRef.setInput('authError', this.authCoord.authError());
    }
  }
  async handleResetPasswordFromModal(email: string) {
    this.modalCoord.loginModalRef?.componentRef.setInput('isLoading', true);
    this.modalCoord.loginModalRef?.componentRef.setInput('authError', null);

    await this.authCoord.handleResetPasswordFromModal(email);

    this.modalCoord.loginModalRef?.componentRef.setInput('isLoading', false);
    this.modalCoord.loginModalRef?.componentRef.setInput('authError', this.authCoord.authError());
    this.modalCoord.loginModalRef?.componentRef.setInput('resetPasswordSent', this.authCoord.resetPasswordSent());
  }
  handleLocalModeFromModal() {
    this.authCoord.handleLocalModeFromModal();
    this.completeAuthModalSuccess('/projects');
  }

  handleMigrationComplete() {
    this.authCoord.handleMigrationComplete();
  }
  closeMigrationModal() {
    this.authCoord.closeMigrationModal();
  }

  // 【P2-31 修复】resize 防抖定时器
  private resizeDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  @HostListener('window:resize')
  checkMobile() {
    if (typeof window === 'undefined') return;
    
    if (this.resizeDebounceTimer) clearTimeout(this.resizeDebounceTimer);
    this.resizeDebounceTimer = setTimeout(() => {
      const nextIsMobile = window.innerWidth < 768; // Tailwind md breakpoint
      const shouldCloseSidebar = shouldAutoCloseSidebarOnViewportChange(
        this.previousViewportIsMobile,
        nextIsMobile
      );

      if (this.uiState.isMobile() !== nextIsMobile) {
        this.uiState.isMobile.set(nextIsMobile);
      }

      if (shouldCloseSidebar) {
        this.isSidebarOpen.set(false);
      }

      this.previousViewportIsMobile = nextIsMobile;
    }, 150);
  }
  
  // ========== 统一搜索方法 ==========
  
  /**
   * 处理统一搜索输入变化
   * 同时更新项目和任务搜索（带防抖）
   */
  onUnifiedSearchInput(event: Event): void {
    this.onUnifiedSearchChange(readTextInputValue(event));
  }

  onRenameProjectNameInput(event: Event): void {
    this.projectCoord.renameProjectName.set(readTextInputValue(event));
  }

  onProjectDescriptionInput(projectId: string, event: Event): void {
    this.updateProjectDraft(projectId, 'description', readTextInputValue(event));
  }

  onUnifiedSearchChange(query: string) {
    // 立即更新显示值
    this.unifiedSearchQuery.set(query);
    
    // 防抖更新实际搜索
    if (this.searchDebounceTimer) {
      clearTimeout(this.searchDebounceTimer);
    }
    
    this.searchDebounceTimer = setTimeout(() => {
      // 同步到两个搜索 signal
      this.uiState.projectSearchQuery.set(query);
      this.uiState.searchQuery.set(query);
      this.searchDebounceTimer = null;
    }, this.SEARCH_DEBOUNCE_DELAY);
  }
  
  /**
   * 清除统一搜索
   */
  clearUnifiedSearch() {
    this.unifiedSearchQuery.set('');
    this.uiState.clearSearch();
  }
}
