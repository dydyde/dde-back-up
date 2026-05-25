import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { NgClass, NgStyle } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DockEngineService } from '../../../services/dock-engine.service';
import { DynamicModalService } from '../../../services/dynamic-modal.service';
import { FocusDockLeaderService } from '../../../services/focus-dock-leader.service';
import { GateService } from '../../../services/gate.service';
import { FocusHudWindowService } from '../../../services/focus-hud-window.service';
import { ToastService } from '../../../services/toast.service';
import { ModalLoaderService } from '../../core/services/modal-loader.service';
import { ProjectStore, TaskStore } from '../../core/state/stores';
import { UiStateService } from '../../../services/ui-state.service';
import { PARKING_CONFIG } from '../../../config/parking.config';
import {
  DOCK_TOAST,
  DOCK_GROUP_LABELS,
  DOCK_GROUP_FALLBACK_LABEL,
  DOCK_DEFAULT_TASK_TITLE,
} from '../../../config/dock-i18n.config';
import {
  CognitiveLoad,
  DockExitAction,
  DockLane,
  DockFocusTransitionPhase,
  DockPendingDecisionEntry,
  StatusMachineEntry,
  type RecommendationGroupType,
} from '../../../models/parking-dock';
import { hasTaskDragTypes } from '../../../utils/task-drag-payload';
import { TimerHandle } from '../../../utils/timer-handle';
import {
  loadHudPosition as loadHudPositionUtil,
  persistHudPosition as persistHudPositionUtil,
  defaultHudPosition as defaultHudPositionUtil,
  resolveHudSize as resolveHudSizeUtil,
  clampHudPosition as clampHudPositionUtil,
} from './utils/dock-hud-position';
import { DockConsoleStackComponent } from './components/dock-console-stack.component';
import { DockRadarZoneComponent } from './components/dock-radar-zone.component';
import { DockStatusMachineComponent } from './components/dock-status-machine.component';
import { DockDailySlotComponent } from './components/dock-daily-slot.component';
import { DockZenModeComponent } from './components/dock-zen-mode.component';
import { DockFocusSceneComponent, type DockFocusSceneMode } from './components/dock-focus-scene.component';
import { DockPlannerQuickEditService } from './services/dock-planner-quick-edit.service';
import { DockHelpFeedbackService } from './services/dock-help-feedback.service';
import { DockDragDropService } from './services/dock-drag-drop.service';
import { DockFocusTransitionService } from './services/dock-focus-transition.service';
import { trapDialogFocus } from './utils/dock-focus-trap';
import { formatDockMinutes, parseOptionalMinutes } from './utils/dock-format';
import {
  resolveDockFocusUiPhase,
  type DockFocusUiPhase,
} from '../../../utils/dock-focus-phase';

type FocusExitConfirmAction =
  | 'save-exit'
  | 'clear-exit'
  | 'keep-focus-hide-scrim'
  | 'cancel'
  | 'request-end-focus'
  | 'back';

type FocusExitFlowStep = 'primary' | 'destructive';

const DOCK_CLOSE_TRANSIENT_SURFACES_EVENT = 'dock-close-transient-surfaces';

@Component({
  selector: 'app-parking-dock',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[style.z-index]': 'focusHostZIndex()',
  },
  imports: [
    NgClass,
    NgStyle,
    FormsModule,
    DockConsoleStackComponent,
    DockRadarZoneComponent,
    DockStatusMachineComponent,
    DockDailySlotComponent,
    DockZenModeComponent,
    DockFocusSceneComponent,
  ],
  providers: [DockPlannerQuickEditService, DockHelpFeedbackService, DockDragDropService, DockFocusTransitionService],
  styleUrl: './parking-dock.component.scss',
  templateUrl: './parking-dock.component.html',
})
export class ParkingDockComponent implements OnDestroy {
  private readonly hostElement = inject(ElementRef<HTMLElement>);
  readonly engine = inject(DockEngineService);
  private readonly focusLeader = inject(FocusDockLeaderService);
  private readonly gateService = inject(GateService);
  private readonly modalLoader = inject(ModalLoaderService);
  private readonly dynamicModal = inject(DynamicModalService);
  readonly focusHudWindow = inject(FocusHudWindowService);
  private readonly projectStore = inject(ProjectStore);
  private readonly taskStore = inject(TaskStore);
  private readonly toast = inject(ToastService);
  private readonly uiState = inject(UiStateService);
  readonly planner = inject(DockPlannerQuickEditService);
  readonly helpFeedback = inject(DockHelpFeedbackService);
  readonly dragDrop = inject(DockDragDropService);
  readonly focusTransitionService = inject(DockFocusTransitionService);
  readonly PARKING_CONFIG = PARKING_CONFIG;

  /** 停泊坞和半圆入口的水平中心点：桌面端有侧边栏时向右偏移半个侧边栏宽度 */
  readonly sidebarEffectiveWidth = computed(() => {
    if (this.uiState.isMobile() || !this.uiState.sidebarOpen()) return 0;
    return this.uiState.sidebarWidth();
  });
  readonly dockCenterLeft = computed(() => {
    const offset = this.sidebarEffectiveWidth();
    return offset === 0 ? '50%' : `calc(50% + ${offset / 2}px)`;
  });

  /** 移动端流程图视图时隐藏半圆按钮，避免遮挡底部功能按键 */
  readonly hideSemicircleOnMobileFlow = computed(
    () => this.uiState.isMobile() && this.uiState.activeView() === 'flow',
  );

  readonly showNewTaskForm = signal(false);
  readonly focusHostZIndex = computed<string | null>(() => {
    if (this.engine.focusMode() || this.engine.focusTransition() !== null || this.focusTransitionService.flipGhost() !== null) {
      return '60';
    }
    return null;
  });
  readonly focusSessionPhase = computed<DockFocusUiPhase>(() =>
    resolveDockFocusUiPhase(this.engine.focusMode(), this.engine.focusTransition()),
  );
  readonly focusSessionMounted = computed(() => this.focusSessionPhase() !== 'idle');
  readonly focusSessionInteractive = computed(() => this.focusSessionPhase() === 'focused');
  readonly focusSceneTransitionPhase = computed<DockFocusTransitionPhase | null>(() => {
    const phase = this.focusSessionPhase();
    return phase === 'idle' ? null : phase;
  });
  readonly focusConsoleStageMounted = computed(
    () => this.focusSessionMounted() && this.focusSessionPhase() !== 'exiting',
  );
  readonly focusFloatingUiMounted = computed(
    () => this.focusSessionPhase() === 'focused' || this.focusTransitionService.floatingUiVisible(),
  );
  readonly exitVisualSnapshot = computed(() => this.focusTransitionService.exitVisualSnapshot());
  readonly exitConsoleEntries = computed(() =>
    this.focusSessionPhase() === 'exiting'
      ? (this.exitVisualSnapshot()?.consoleEntries ?? null)
      : null,
  );
  readonly exitStatusMachineEntries = computed<StatusMachineEntry[] | null>(() =>
    this.focusSessionPhase() === 'exiting'
      ? (this.exitVisualSnapshot()?.statusMachineEntries ?? null)
      : null,
  );
  readonly dockExpanded = this.engine.dockExpanded;
  readonly semicircleExpanded = computed(() => this.dockExpanded() || this.dragDrop.semicircleHoverExpanded());
  readonly hudSize = signal<{ width: number; height: number }>({
    width: PARKING_CONFIG.HUD_FULL_MAX_WIDTH_PX,
    height: PARKING_CONFIG.HUD_FULL_MAX_HEIGHT_PX,
  });
  readonly hudPosition = signal<{ x: number; y: number } | null>(loadHudPositionUtil(this.hudSize()));
  readonly hudDragging = signal(false);
  readonly showExitConfirm = signal(false);
  readonly exitFlowStep = signal<FocusExitFlowStep>('primary');
  readonly takeoverBannerVisible = computed(
    () => this.focusSessionMounted() && this.focusLeader.isReadOnlyFollower(),
  );
  readonly gateActive = computed(() => this.gateService.isActive());
  readonly canMutateDock = computed(() => !this.gateActive() && !this.focusLeader.isReadOnlyFollower());
  readonly canUseInlineDockCreate = computed(
    () => this.canMutateDock() && !(this.focusSessionMounted() && this.engine.focusScrimOn()),
  );
  readonly showInlineDockCreate = computed(
    () => !this.focusSessionMounted() || !this.engine.focusScrimOn(),
  );
  readonly canCreateBackupTask = computed(() => this.canMutateDock());
  readonly canUsePlannerQuickEdit = computed(() => this.canMutateDock());
  readonly canReorderDockCards = computed(() => this.dragDrop.canReorderDockCards());
  readonly canAcceptExternalDrop = computed(() => this.dragDrop.canAcceptExternalDrop());
  readonly canToggleScrim = computed(
    () => this.focusSessionInteractive() && this.canMutateDock(),
  );
  readonly dockSecondaryRailActive = computed(
    () => this.focusSessionMounted() && this.engine.focusScrimOn(),
  );
  readonly focusMotionProfile = PARKING_CONFIG.FOCUS_MOTION_PROFILE;
  readonly motion = PARKING_CONFIG.MOTION;
  readonly reducedMotion = signal(this.focusTransitionService.prefersReducedMotion());
  readonly strictSampleMode = PARKING_CONFIG.DOCK_V3_STRICT_SAMPLE_UI;
  readonly showAdvancedUi = PARKING_CONFIG.DOCK_V3_SHOW_ADVANCED_UI;
  readonly blankPeriodActive = computed(() => this.engine.blankPeriodActive());
  readonly focusSceneMode = computed<DockFocusSceneMode>(() => {
    if (this.focusSessionMounted() && this.engine.fragmentDefenseLevel() >= 4) {
      return 'zen';
    }
    if (this.engine.isBurnoutActive()) {
      return 'burnout';
    }
    if (this.engine.isFragmentPhase() || this.blankPeriodActive()) {
      return 'fragment';
    }
    if (this.engine.pendingDecision()) {
      return 'decision';
    }
    return 'steady';
  });
  readonly showZenMode = computed(
    () => this.focusSessionMounted() && this.engine.fragmentDefenseLevel() >= 4,
  );
  readonly firstMainSelectionPending = computed(() => this.engine.firstMainSelectionPending());
  readonly hudMinimalMode = computed(
    () => this.focusSessionPhase() === 'focused' && (!this.engine.focusScrimOn() || this.focusHudWindow.isActive()),
  );
  readonly hudMinimalPassThrough = computed(
    () => this.uiState.isMobile() && this.hudMinimalMode(),
  );
  readonly canOpenPipHud = computed(
    () => this.focusSessionPhase() === 'focused' && !this.uiState.isMobile() && this.focusHudWindow.isSupported(),
  );
  readonly focusStageTransform = computed(() => {
    if (this.uiState.isMobile()) {
      return this.dockExpanded() ? 'translateY(-128px)' : 'translateY(calc(50vh - 260px))';
    }
    return this.dockExpanded() ? 'translateY(-80px)' : 'translateY(calc(50vh - 240px))';
  });
  readonly hudContainerStyle = computed<Record<string, string>>(() => {
    if (this.hudMinimalMode()) {
      const minimalTop = this.uiState.isMobile()
        ? `calc(env(safe-area-inset-top) + ${PARKING_CONFIG.HUD_MINIMAL_MOBILE_TOP_PX}px)`
        : `${PARKING_CONFIG.HUD_MINIMAL_TOP_PX}px`;
      return {
        top: minimalTop,
        left: '50%',
        right: 'auto',
        transform: 'translateX(-50%)',
        cursor: 'default',
        width: `${PARKING_CONFIG.HUD_MINIMAL_WIDTH_PX}px`,
      };
    }
    const position = this.hudPosition() ?? defaultHudPositionUtil(this.hudSize());
    return {
      top: `${position.y}px`,
      left: `${position.x}px`,
      right: 'auto',
      transform: 'none',
      cursor: this.hudDragging() ? 'grabbing' : 'default',
      width: 'auto',
    };
  });

  newTaskTitle = '';
  newTaskLane: DockLane = 'backup';
  newTaskLoad: CognitiveLoad = 'low';
  newTaskExpectedMinutes: string | number = '';
  newTaskWaitMinutes: string | number = '';
  newTaskDetail = '';

  readonly dockMaxWidth = PARKING_CONFIG.DOCK_EXPANDED_MAX_WIDTH;
  readonly focusContentEffect = PARKING_CONFIG.DOCK_FOCUS_CONTENT_EFFECT;
  readonly focusBackgroundUrl = PARKING_CONFIG.DOCK_FOCUS_BG_IMAGE_URL;
  readonly dockBottomInset =
    `calc(${PARKING_CONFIG.DOCK_BOTTOM_OFFSET_PX}px + env(safe-area-inset-bottom))`;
  readonly dockSemicircleBottomInset = computed(() =>
    this.uiState.isMobile() ? this.dockBottomInset : 'env(safe-area-inset-bottom)',
  );
  private readonly plannerPanel = viewChild<ElementRef<HTMLElement>>('plannerPanel');
  private readonly consoleStack = viewChild(DockConsoleStackComponent);
  private plannerPanelOriginalParent: Node | null = null;
  private plannerPanelOriginalNextSibling: ChildNode | null = null;
  private portaledPlannerPanel: HTMLElement | null = null;
  private hudDragPointerId: number | null = null;
  private hudDragOffset: { x: number; y: number } | null = null;
  /** planner 面板自动聚焦定时器 */
  private readonly plannerAutoFocus = new TimerHandle();
  /** 退出确认对话框主按钮自动聚焦 */
  private readonly exitFocusTimer = new TimerHandle();

  constructor() {
    effect(() => {
      const activeEntry = this.planner.activeEntry();
      const presentation = this.planner.presentation();
      if (!activeEntry) {
        this.restorePlannerPanel();
        return;
      }

      this.plannerAutoFocus.schedule(() => {
        this.syncPlannerPanelPortal(presentation);
        this.focusPlannerPanel();
        this.scrollPlannerPanelIntoView();
      }, 0);
    });

    effect(() => {
      this.planner.closeIfEntryGone();
    });

    effect(() => {
      if (this.showInlineDockCreate()) return;
      if (!this.showNewTaskForm()) return;
      this.showNewTaskForm.set(false);
    });

    effect(() => {
      if (this.engine.focusMode()) return;
      if (!this.focusHudWindow.isActive()) return;
      void this.focusHudWindow.close();
    });
  }

  @HostListener('document:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Tab' && this.planner.backdropVisible()) {
      trapDialogFocus(event, '[data-testid="dock-v3-planner-panel"]');
      return;
    }

    if (event.key === 'Tab' && this.showExitConfirm()) {
      trapDialogFocus(event, '[data-testid="dock-v3-exit-confirm"]');
      return;
    }

    // 抑制重复按键事件（按住键时操作系统会持续触发 keydown）。
    // Tab 焦点陷阱不受影响，因为 Tab 的处理在此行之前已提前 return。
    if (event.repeat) return;

    if (event.key === 'Escape') {
      this.handleEscapeKey(event);
      return;
    }

    this.handleShortcutKey(event);
  }

  @HostListener('document:pointerdown', ['$event'])
  onDocumentPointerDown(event: PointerEvent): void {
    if (this.planner.presentation() !== 'popover' || !this.planner.activeEntry()) return;

    const target = event.target;
    if (!(target instanceof Element)) return;

    if (target.closest('[data-testid="dock-v3-planner-panel"]')) return;
    if (target.closest('[data-testid="dock-v3-planner-toggle"]')) return;

    this.closePlannerQuickEdit(false);
  }

  /** Escape 键分级处理：先关闭当前临时表面，再处理虚化与退出。 */
  private handleEscapeKey(event: KeyboardEvent): void {
    if (this.closeTransientSurface()) {
      event.preventDefault();
      return;
    }
    if (this.showZenMode()) {
      event.preventDefault();
      this.onZenExit();
      return;
    }
    if (this.engine.pendingDecision()) {
      event.preventDefault();
      this.engine.cancelPendingDecisionAutoPromote();
      return;
    }
    if (this.engine.focusMode() && this.engine.focusScrimOn()) {
      event.preventDefault();
      this.engine.setFocusScrim(false);
      this.helpFeedback.showRestoreHintToast();
      return;
    }
    // 遮罩已关闭时再按 Escape，弹出退出确认对话框
    if (this.engine.focusMode() && !this.engine.focusScrimOn()) {
      event.preventDefault();
      this.onFocusSessionToggle();
    }
  }

  /** Alt+Shift 快捷键分发 */
  private handleShortcutKey(event: KeyboardEvent): void {
    const key = typeof event.key === 'string' ? event.key.toLowerCase() : '';
    if (!key) return;

    if (event.altKey && event.shiftKey) {
      if (key === 'l') { event.preventDefault(); this.onFocusSessionToggle(); return; }
      if (key === 'f') { if (!this.engine.focusMode()) return; event.preventDefault(); this.onScrimToggle(); return; }
      if (key === 'd') { event.preventDefault(); this.toggleDockExpanded(); return; }
    }
    if (event.altKey && !event.shiftKey && key === 'h') {
      event.preventDefault();
      this.helpFeedback.toggleHelpOverlay();
    }
  }

  @HostListener('window:dock-focus-session-toggle')
  onExternalFocusSessionToggle(): void {
    if (this.gateActive()) return;
    this.onFocusSessionToggle();
  }

  @HostListener('window:pointermove', ['$event'])
  onHudPointerMove(event: PointerEvent): void {
    if (!this.hudDragging()) return;
    if (this.hudDragPointerId !== null && event.pointerId !== this.hudDragPointerId) return;
    if (!this.hudDragOffset) return;
    const next = clampHudPositionUtil({
      x: event.clientX - this.hudDragOffset.x,
      y: event.clientY - this.hudDragOffset.y,
    }, this.hudSize());
    this.hudPosition.set(next);
  }

  @HostListener('window:pointerup', ['$event'])
  @HostListener('window:pointercancel', ['$event'])
  onHudPointerUp(event: PointerEvent): void {
    if (!this.hudDragging()) return;
    if (this.hudDragPointerId !== null && event.pointerId !== this.hudDragPointerId) return;
    this.hudDragging.set(false);
    this.hudDragPointerId = null;
    this.hudDragOffset = null;
    persistHudPositionUtil(this.hudPosition());
  }

  ngOnDestroy(): void {
    this.restorePlannerPanel();
    this.plannerAutoFocus.cancel();
    this.exitFocusTimer.cancel();
    persistHudPositionUtil(this.hudPosition());
    this.focusTransitionService.transitionPerformanceTierLock.set(null);
    this.engine.endFocusTransition();
    void this.focusHudWindow.close();
  }

  async togglePipHud(): Promise<void> {
    if (!this.canOpenPipHud()) return;
    if (this.focusHudWindow.isActive()) {
      await this.focusHudWindow.close();
      return;
    }
    const opened = await this.focusHudWindow.open();
    if (!opened) {
      this.toast.warning(DOCK_TOAST.PIP_OPEN_FAIL_TITLE, DOCK_TOAST.PIP_OPEN_FAIL_BODY);
    }
  }

  toggleNewTaskForm(): void {
    if (!this.showAdvancedUi) return;
    if (!this.canUseInlineDockCreate()) return;
    this.showNewTaskForm.update(value => !value);
  }

  toggleDockExpanded(): void {
    if (this.gateActive()) return;
    const next = !this.engine.dockExpanded();
    this.engine.setDockExpanded(next, { persistPreference: true });
    if (next) {
      this.dragDrop.semicircleHoverExpanded.set(true);
      this.dragDrop.cancelAutoCollapse();
      return;
    }
    this.planner.closePlannerQuickEdit();
    this.dragDrop.scheduleSemicircleAutoCollapse();
  }

  onSemicircleMouseEnter(): void {
    if (this.gateActive()) return;
    this.dragDrop.semicircleHoverExpanded.set(true);
    this.dragDrop.cancelAutoCollapse();
  }

  onSemicircleMouseLeave(): void {
    if (this.gateActive()) return;
    this.dragDrop.scheduleSemicircleAutoCollapse();
  }

  /**
   * 半圆入口拖拽悬停处理 — 拖拽任务悬停在半圆上时自动展开停泊坞，
   * 使坞栏 drop-zone 可见，用户可继续将任务拖入。
   */
  onSemicircleDragOver(event: DragEvent): void {
    if (!this.canAcceptExternalDrop()) return;
    if (!hasTaskDragTypes(event.dataTransfer)) return;
    event.preventDefault();
    if (this.dragDrop.dropState() !== 'reject') {
      this.dragDrop.dropState.set('canDrop');
    }
    if (!this.dockExpanded()) {
      this.dragDrop.scheduleSemicircleDragExpand();
    }
  }

  onSemicircleDragLeave(): void {
    if (this.dragDrop.dropState() !== 'reject') {
      this.dragDrop.dropState.set('idle');
    }
  }

  onHudPointerDown(event: PointerEvent): void {
    if (this.hudMinimalMode()) return;
    if (event.button !== 0) return;
    if (this.shouldIgnoreHudPointerDown(event.target)) return;
    const container = (event.currentTarget as HTMLElement)
      .closest('[data-testid=\"dock-v3-status-machine-container\"]') as HTMLElement | null;
    const rect = container?.getBoundingClientRect();
    const size = resolveHudSizeUtil(rect, this.hudSize());
    this.hudSize.set(size);
    const current = this.hudPosition() ?? defaultHudPositionUtil(size);
    const clamped = clampHudPositionUtil(current, size);
    this.hudPosition.set(clamped);
    this.hudDragging.set(true);
    this.hudDragPointerId = event.pointerId;
    this.hudDragOffset = {
      x: event.clientX - clamped.x,
      y: event.clientY - clamped.y,
    };
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  private shouldIgnoreHudPointerDown(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    return target.closest(
      [
        'button',
        'a',
        'input',
        'textarea',
        'select',
        'label',
        'summary',
        '[role="button"]',
        '[contenteditable="true"]',
        '[data-hud-drag-ignore]',
      ].join(','),
    ) !== null;
  }

  onBackdropClick(): void {
    if (!this.engine.focusMode()) return;
    this.closeTransientSurface();
  }

  onFocusTransitionSettled(phase: DockFocusTransitionPhase): void {
    const transition = this.engine.focusTransition();
    if (!transition) return;
    if (phase === 'entering' && transition.phase === 'entering') {
      this.focusTransitionService.finalizeEnterFocusTransition(transition);
      return;
    }
    if (phase === 'exiting' && transition.phase === 'exiting') {
      this.focusTransitionService.finalizeExitFocusTransition();
    }
  }

  onFocusSessionToggle(): void {
    if (this.gateActive()) return;
    if (this.focusLeader.isReadOnlyFollower()) return;
    const transition = this.engine.focusTransition();
    if (transition?.phase === 'entering' || transition?.phase === 'exiting') return;

    if (this.engine.focusMode()) {
      this.exitFlowStep.set('primary');
      this.showExitConfirm.set(true);
      this.focusExitConfirmPrimaryAction();
      return;
    }

    if (this.focusTransitionService.prefersReducedMotion()) {
      if (this.engine.dockExpanded()) {
        this.engine.setDockExpanded(false, { persistPreference: false });
        this.dragDrop.scheduleSemicircleAutoCollapse();
      }
      this.focusTransitionService.clearExitVisualSnapshot();
      this.engine.endFocusTransition();
      this.engine.toggleFocusMode();
      this.helpFeedback.showFocusHelpNudgeOnce();
      return;
    }
    this.helpFeedback.showFocusHelpNudgeOnce();
    this.focusTransitionService.runEnterFocusTransition();
    // 先捕获 enter 几何，再让停泊坞下沉，避免源卡片首帧抖动。
    if (this.engine.dockExpanded()) {
      this.engine.setDockExpanded(false, { persistPreference: false });
      this.dragDrop.scheduleSemicircleAutoCollapse();
    }
  }

  confirmExitFocus(action: FocusExitConfirmAction): void {
    if (action === 'cancel') {
      this.resetExitFlow();
      return;
    }

    if (action === 'back') {
      this.exitFlowStep.set('primary');
      this.focusExitConfirmPrimaryAction();
      return;
    }

    if (action === 'request-end-focus') {
      this.exitFlowStep.set('destructive');
      this.focusExitConfirmPrimaryAction();
      return;
    }

    if (action === 'keep-focus-hide-scrim') {
      this.engine.markExitAction('keep_focus_hide_scrim');
      this.engine.setFocusScrim(false);
      this.engine.beginFocusChromeRestore(this.motion.shell.enterMs);
      this.resetExitFlow();
      this.helpFeedback.showRestoreHintToast();
      return;
    }

    const exitAction: DockExitAction = action === 'clear-exit' ? 'clear_exit' : 'save_exit';
    this.engine.markExitAction(exitAction);
    this.resetExitFlow();
    if (exitAction === 'clear_exit') {
      this.captureExitVisualSnapshot();
      this.engine.clearDockForExit();
    } else {
      this.focusTransitionService.clearExitVisualSnapshot();
    }
    if (this.focusTransitionService.prefersReducedMotion()) {
      if (exitAction === 'clear_exit') {
        this.engine.finalizeClearDockForExit();
      }
      this.focusTransitionService.clearExitVisualSnapshot();
      this.engine.endFocusTransition();
      this.engine.toggleFocusMode();
      return;
    }
    this.focusTransitionService.runExitFocusTransition();
  }

  takeOverFocusControl(): void {
    this.focusLeader.tryTakeover();
  }

  onScrimToggle(): void {
    if (!this.engine.focusMode()) return;
    if (this.gateActive()) return;
    if (this.focusLeader.isReadOnlyFollower()) return;
    const nextScrimOn = !this.engine.focusScrimOn();
    this.engine.toggleFocusScrim();
    this.helpFeedback.showDockFeedback(
      nextScrimOn ? DOCK_TOAST.SCRIM_ON : DOCK_TOAST.SCRIM_OFF,
      'info',
    );
  }

  onZenExit(): void {
    if (!this.engine.focusMode()) return;
    if (this.focusLeader.isReadOnlyFollower()) return;
    this.engine.fragmentRest.dismissZenMode();
  }

  createTask(): void {
    if (!this.showAdvancedUi) return;
    if (!this.canUseInlineDockCreate()) return;
    const title = this.newTaskTitle.trim();
    if (!title) return;

    const detail = this.newTaskDetail.trim();
    const expectedMinutes = parseOptionalMinutes(this.newTaskExpectedMinutes);
    const waitMinutes = parseOptionalMinutes(this.newTaskWaitMinutes);
    const createdId = this.engine.createInDock(title, this.newTaskLane, this.newTaskLoad, {
      expectedMinutes,
      waitMinutes,
      detail,
    });
    if (!createdId) return;

    this.planner.markRecentlyDocked(createdId);
    this.newTaskTitle = '';
    this.newTaskExpectedMinutes = '';
    this.newTaskWaitMinutes = '';
    this.newTaskDetail = '';
    this.showNewTaskForm.set(false);
  }

  togglePlannerQuickEdit(taskId: string): void {
    if (!this.canUsePlannerQuickEdit()) return;
    if (this.planner.isPlannerQuickEditOpen(taskId)) {
      this.closePlannerQuickEdit(false);
      return;
    }
    this.planner.togglePlannerQuickEdit(taskId);
    this.plannerAutoFocus.schedule(() => {
      this.syncPlannerPanelPortal(this.planner.presentation());
      this.focusPlannerPanel();
      this.scrollPlannerPanelIntoView();
    }, 50);
  }

  closePlannerQuickEdit(restoreFocus = true): void {
    this.restorePlannerPanel();
    const taskId = this.planner.closePlannerQuickEdit();
    if (restoreFocus && taskId) {
      const trigger = this.hostElement.nativeElement.querySelector(
        `[data-testid="dock-v3-planner-toggle"][data-planner-task-id="${CSS.escape(taskId)}"]`,
      ) as HTMLButtonElement | null;
      trigger?.focus();
    }
  }

  isPlannerQuickEditOpen(taskId: string): boolean {
    return this.planner.isPlannerQuickEditOpen(taskId);
  }

  setPlannerQuickEditExpected(taskId: string, minutes: number | null): void {
    this.planner.setPlannerQuickEditExpected(taskId, minutes);
  }

  setPlannerQuickEditWait(taskId: string, minutes: number | null): void {
    this.planner.setPlannerQuickEditWait(taskId, minutes);
  }

  setPlannerQuickEditLoad(taskId: string, nextLoad: CognitiveLoad): void {
    this.planner.setPlannerQuickEditLoad(taskId, nextLoad);
  }

  toggleHelpOverlay(): void {
    this.helpFeedback.toggleHelpOverlay();
  }

  createBackupTaskFromFab(): void {
    if (!this.canCreateBackupTask()) return;
    const createdId = this.engine.createInDock(DOCK_DEFAULT_TASK_TITLE, 'backup', 'low');
    if (!createdId) return;
    this.engine.setDockExpanded(true, { persistPreference: true });
    this.dragDrop.semicircleHoverExpanded.set(true);
    this.planner.markRecentlyDocked(createdId);
    if (this.engine.focusMode()) {
      this.helpFeedback.showDockFeedback(DOCK_TOAST.BACKUP_CREATED_BODY, 'success');
    }
  }

  async openFocusRoutineSettings(): Promise<void> {
    try {
      const component = await this.modalLoader.loadSettingsModal();
      this.dynamicModal.open(component, {
        inputs: {
          sessionEmail: null,
          projects: this.projectStore.projects(),
          initialSection: 'focus-routines',
        },
        outputs: {
          close: () => this.dynamicModal.close(),
        },
      });
    } catch {
      this.toast.error(DOCK_TOAST.SETTINGS_LOAD_FAIL_TITLE, DOCK_TOAST.SETTINGS_LOAD_FAIL_BODY);
    }
  }

  onDockCardClick(taskId: string): void {
    if (this.isDockSelectionBlocked()) return;
    const entry = this.engine.orderedDockEntries().find(item => item.taskId === taskId) ?? null;
    if (!entry) return;
    const currentFrontTaskId = this.engine.focusMode()
      ? (this.engine.focusingEntry()?.taskId ?? null)
      : (this.engine.orderedDockEntries().find(item => item.isMain)?.taskId ?? null);

    // 前台判定要看当前 C 位，而不是是否主任务；主任务在专注中可能暂时退居后台。
    if (!this.firstMainSelectionPending() && currentFrontTaskId === taskId) {
      if (this.dockSecondaryRailActive()) {
        this.helpFeedback.showDockFeedback(`当前已在前台：${entry.title}`, 'info');
      }
      return;
    }

    if (this.firstMainSelectionPending()) {
      this.engine.overrideFirstMainTask(taskId);
      if (this.engine.focusMode()) {
        this.helpFeedback.showDockFeedback(`已改选前台任务：${entry.title}`, 'success');
      }
      return;
    }
    this.engine.setMainTask(taskId);
    if (this.engine.focusMode()) {
      this.helpFeedback.showDockFeedback(`已切换到前台：${entry.title}`, 'success');
    }
  }

  onDrop(event: DragEvent): void {
    this.dragDrop.onDrop(event, (taskId) => this.planner.markRecentlyDocked(taskId));
  }

  private isDockSelectionBlocked(): boolean {
    return this.gateActive() || this.focusLeader.isReadOnlyFollower();
  }

  private resetExitFlow(): void {
    this.showExitConfirm.set(false);
    this.exitFlowStep.set('primary');
  }

  private closeTransientSurface(): boolean {
    if (this.planner.plannerQuickEditTaskId()) {
      this.closePlannerQuickEdit();
      return true;
    }

    if (this.hasVisibleWaitMenu()) {
      this.dispatchCloseTransientSurfaceEvent();
      return true;
    }

    if (this.helpFeedback.showHelpOverlay()) {
      this.helpFeedback.closeHelpOverlay();
      return true;
    }

    if (this.showExitConfirm()) {
      if (this.exitFlowStep() === 'destructive') {
        this.exitFlowStep.set('primary');
        this.focusExitConfirmPrimaryAction();
      } else {
        this.showExitConfirm.set(false);
      }
      return true;
    }

    return false;
  }

  private dispatchCloseTransientSurfaceEvent(): void {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent(DOCK_CLOSE_TRANSIENT_SURFACES_EVENT));
  }

  private hasVisibleWaitMenu(): boolean {
    return this.consoleStack()?.waitPresetTaskId() != null;
  }

  private focusExitConfirmPrimaryAction(): void {
    if (typeof document === 'undefined') return;
    this.exitFocusTimer.schedule(() => {
      const selector = this.exitFlowStep() === 'destructive'
        ? '[data-testid="dock-v3-exit-save"]'
        : '[data-testid="dock-v3-exit-cancel"]';
      const primary = document.querySelector<HTMLElement>(selector);
      primary?.focus();
    }, 0);
  }

  private syncPlannerPanelPortal(presentation: 'popover' | 'sheet'): void {
    if (typeof document === 'undefined') return;

    const panel = this.plannerPanel()?.nativeElement ?? null;
    if (!panel) {
      this.restorePlannerPanel();
      return;
    }

    if (presentation !== 'sheet') {
      this.restorePlannerPanel();
      return;
    }

    if (panel.parentElement === document.body) return;

    this.plannerPanelOriginalParent = panel.parentNode;
    this.plannerPanelOriginalNextSibling = panel.nextSibling;
    this.portaledPlannerPanel = panel;
    document.body.appendChild(panel);
  }

  private restorePlannerPanel(): void {
    const panel = this.portaledPlannerPanel;
    if (!panel) return;

    const parent = this.plannerPanelOriginalParent;
    if (parent instanceof HTMLElement && parent.isConnected) {
      const nextSibling = this.plannerPanelOriginalNextSibling?.parentNode === parent
        ? this.plannerPanelOriginalNextSibling
        : null;
      parent.insertBefore(panel, nextSibling);
    } else if (panel.isConnected) {
      panel.remove();
    }

    this.portaledPlannerPanel = null;
    this.plannerPanelOriginalParent = null;
    this.plannerPanelOriginalNextSibling = null;
  }

  private focusPlannerPanel(): void {
    this.plannerPanel()?.nativeElement.focus();
  }

  /** 桌面内联面板打开后自动滚动到可见区域 */
  private scrollPlannerPanelIntoView(): void {
    if (this.planner.presentation() !== 'popover') return;
    this.plannerPanel()?.nativeElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  formatTime(minutes: number): string {
    return formatDockMinutes(minutes);
  }

  /** 待决策候选任务（computed 避免模板每次 CD 重复调用） */
  readonly pendingDecisionRemainingMinutes = computed(() => {
    const remaining = this.engine.pendingDecision()?.rootRemainingMinutes ?? 0;
    return remaining > 0 ? Math.ceil(remaining) : 0;
  });

  groupLabel(group: DockPendingDecisionEntry['group']): string {
    return DOCK_GROUP_LABELS[group as RecommendationGroupType] ?? DOCK_GROUP_FALLBACK_LABEL;
  }

  private captureExitVisualSnapshot(): void {
    this.focusTransitionService.captureExitVisualSnapshot({
      consoleEntries: this.engine.consoleVisibleEntries().map((entry) => ({ ...entry })),
      statusMachineEntries: this.engine.statusMachineEntries().map((entry) => ({ ...entry })),
    });
  }
}
