import { Component, inject, signal, computed, ElementRef, viewChild, AfterViewInit, OnDestroy, NgZone, HostListener, output, ChangeDetectionStrategy, Injector, effect, EffectRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { UiStateService } from '../../../../services/ui-state.service';
import { ProjectStateService } from '../../../../services/project-state.service';
import { ToastService } from '../../../../services/toast.service';
import { LoggerService } from '../../../../services/logger.service';
import { FlowCommandService } from '../services/flow-command.service';
import { FlowDiagramService } from '../services/flow-diagram.service';
import { FlowLogicExportService } from '../services/flow-logic-export.service';
import { FlowZoomService } from '../services/flow-zoom.service';
import { FlowSelectionService } from '../services/flow-selection.service';
import { FlowLayoutService } from '../services/flow-layout.service';
import { FlowDragDropService, InsertPositionInfo } from '../services/flow-drag-drop.service';
import { FlowTouchService } from '../services/flow-touch.service';
import { FlowLinkService } from '../services/flow-link.service';
import { FlowTaskOperationsService } from '../services/flow-task-operations.service';
import { FlowSwipeGestureService } from '../services/flow-swipe-gesture.service';
import { FlowCascadeAssignService } from '../services/flow-cascade-assign.service';
import { FlowKeyboardService } from '../services/flow-keyboard.service';
import { FlowPaletteResizeService } from '../services/flow-palette-resize.service';
import { FlowBatchDeleteService } from '../services/flow-batch-delete.service';
import { FlowSelectModeService } from '../services/flow-select-mode.service';
import { FlowMobileDrawerService } from '../services/flow-mobile-drawer.service';
import { FlowDiagramEffectsService } from '../services/flow-diagram-effects.service';
import { FlowEventRegistrationService } from '../services/flow-event-registration.service';
import { FlowViewCleanupService, CleanupResources } from '../services/flow-view-cleanup.service';
import { FlowDiagramRetryService } from '../services/flow-diagram-retry.service';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
import { SimpleSyncService } from '../../../core/services/simple-sync.service';
import { AuthService } from '../../../../services/auth.service';
import { Task } from '../../../../models';
import { UI_CONFIG, TIMEOUT_CONFIG } from '../../../../config';
import { FlowToolbarComponent } from './flow-toolbar.component';
import { FlowPaletteComponent } from './flow-palette.component';
import { FlowTaskDetailComponent } from './flow-task-detail.component';
import { FlowDeleteConfirmComponent } from './flow-delete-confirm.component';
import { FlowLinkTypeDialogComponent } from './flow-link-type-dialog.component';
import { FlowConnectionEditorComponent, ConnectionEditorSavePayload } from './flow-connection-editor.component';
import { FlowLinkDeleteHintComponent } from './flow-link-delete-hint.component';
import { FlowLinkActionMenuComponent } from './flow-link-action-menu.component';
import { FlowCascadeAssignDialogComponent } from './flow-cascade-assign-dialog.component';
import { FlowBatchDeleteDialogComponent } from './flow-batch-delete-dialog.component';
import { MobileDrawerContainerComponent } from './mobile-drawer-container.component';
import { MobileTodoDrawerComponent } from './mobile-todo-drawer.component';
import { MobileBlackBoxDrawerComponent } from './mobile-black-box-drawer.component';
import { FlowRightPanelComponent } from './flow-right-panel.component';
import { FlowBatchToolbarComponent } from './flow-batch-toolbar.component';

import * as go from 'gojs';

function isNavigableFlowTask(task: Task | undefined | null): task is Task {
  return !!task && !task.deletedAt && task.status !== 'archived';
}

/** 流程图视图组件 —— 模板渲染 + 子组件通信 + 服务协调 + 生命周期管理 */
@Component({
  selector: 'app-flow-view',
  standalone: true,
  imports: [
    CommonModule, 
    FormsModule,
    FlowToolbarComponent, 
    FlowPaletteComponent, 
    FlowTaskDetailComponent,
    FlowDeleteConfirmComponent,
    FlowLinkTypeDialogComponent,
    FlowConnectionEditorComponent,
    FlowLinkDeleteHintComponent,
    FlowLinkActionMenuComponent,
    FlowCascadeAssignDialogComponent,
    FlowBatchDeleteDialogComponent,
    MobileDrawerContainerComponent,
    MobileTodoDrawerComponent,
    MobileBlackBoxDrawerComponent,
    FlowRightPanelComponent,
    FlowBatchToolbarComponent
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['./flow-view.component.scss'],
  templateUrl: './flow-view.component.html'
})
export class FlowViewComponent implements AfterViewInit, OnDestroy {
  readonly diagramDiv = viewChild<ElementRef>('diagramDiv');
  readonly overviewDiv = viewChild<ElementRef>('overviewDiv');
  readonly goBackToText = output<void>();
  
  // ========== P2-1 迁移：直接注入子服务 ==========
  readonly uiState = inject(UiStateService);
  readonly projectState = inject(ProjectStateService);
  private readonly toast = inject(ToastService);
  private readonly logger = inject(LoggerService).category('FlowView');
  private readonly zone = inject(NgZone);
  private readonly elementRef = inject(ElementRef);
  private readonly injector = inject(Injector);
  
  // 命令服务（解耦与 ProjectShellComponent 的通信）
  private readonly flowCommand = inject(FlowCommandService);
  
  // 核心服务
  readonly diagram = inject(FlowDiagramService);
  private readonly logicExport = inject(FlowLogicExportService);
  private readonly zoomService = inject(FlowZoomService);
  readonly selectionService = inject(FlowSelectionService);
  private readonly layoutService = inject(FlowLayoutService);
  readonly dragDrop = inject(FlowDragDropService);
  readonly touch = inject(FlowTouchService);
  readonly link = inject(FlowLinkService);
  readonly taskOps = inject(FlowTaskOperationsService);
  private readonly swipeGesture = inject(FlowSwipeGestureService);
  readonly cascadeAssign = inject(FlowCascadeAssignService);
  private readonly keyboard = inject(FlowKeyboardService);
  private readonly paletteResize = inject(FlowPaletteResizeService);
  readonly batchDelete = inject(FlowBatchDeleteService);
  readonly selectMode = inject(FlowSelectModeService);
  private readonly mobileDrawer = inject(FlowMobileDrawerService);
  private readonly taskOpsAdapter = inject(TaskOperationAdapterService);
  private readonly diagramEffects = inject(FlowDiagramEffectsService);
  private readonly eventRegistration = inject(FlowEventRegistrationService);
  private readonly cleanup = inject(FlowViewCleanupService);
  private readonly diagramRetry = inject(FlowDiagramRetryService);
  private readonly syncService = inject(SimpleSyncService);
  private readonly authService = inject(AuthService);
  
  // ========== 组件状态 ==========
  
  /** 选中的任务ID */
  readonly selectedTaskId = signal<string | null>(null);
  
  /** 删除确认状态 */
  readonly deleteConfirmTask = signal<Task | null>(null);
  readonly deleteKeepChildren = signal(false);
  
  /** 任务详情面板位置 */
  readonly taskDetailPos = signal<{ x: number; y: number }>({ x: -1, y: -1 });
  
  /** 调色板高度 - 移动端默认更小 */
  readonly paletteHeight = signal(this.uiState.isMobile() ? 80 : 180);
  
  /** 底部抽屉高度（vh） - 移动端顶部抽屉 */
  // 默认给一个安全值，真正的“最佳高度”由下面的 effect 在移动端动态校准。
  readonly drawerHeight = signal(this.uiState.isMobile() ? 8.62 : 25);
  /** 用户手动拖拽后，阻止预设高度覆盖，直到详情关闭 */
  readonly drawerManualOverride = signal(false);
  readonly isResizingDrawerSignal = signal(false);
  
  /** 是否正在重试加载图表（委托给 diagramRetry 服务） */
  readonly isRetryingDiagram = computed(() => this.diagramRetry.isRetrying());
  
  /** 是否已达到重试上限（委托给 diagramRetry 服务） */
  readonly hasReachedRetryLimit = computed(() => this.diagramRetry.hasReachedRetryLimit());
  
  /** 小地图状态 */
  readonly isOverviewVisible = signal(true);
  readonly isOverviewCollapsed = signal(false);
  
  /** 侧边栏（调色板）展开状态 */
  readonly isPaletteOpen = signal(true);
  
  /** 右侧滑出面板状态（移动端） */
  readonly isRightPanelOpen = signal(false);
  /** 详情面板布局版本：移动端页面/层切换后递增，驱动详情高度重测 */
  readonly detailLayoutTick = signal(0);
  
  readonly overviewSize = computed(() =>
    this.uiState.isMobile() ? { width: 100, height: 80 } : { width: 180, height: 140 }
  );

  readonly overviewBottomPosition = computed(() =>
    this.uiState.isMobile() ? '8px' : '16px'
  );

  /** 图表初始化重试次数 - 委托给 diagramRetry 服务管理 */
  
  /** 选中的任务对象 */
  readonly selectedTask = computed(() => {
    const id = this.selectedTaskId();
    if (!id) return null;
    return this.projectState.getTask(id) || null;
  });

  /** 移动端待分配拖拽会话是否仍处于活动状态。 */
  readonly hasPendingUnassignedTouchDrag = computed(() =>
    this.touch.hasActiveTouchSession || !!this.touch.draggingId()
  );
  
  // ========== 私有状态 ==========
  private isDestroyed = false;

  /** 【2026-02-24】所有通过组件 injector 创建的 EffectRef，ngOnDestroy 时主动销毁 */
  private readonly managedEffectRefs: EffectRef[] = [];

  /** 绑定的 saveToCloud 回调，传递给 toolbar 组件 */
  readonly saveToCloudBound = () => this.saveToCloud();
  
  /** 待清理的定时器 */
  private pendingTimers: ReturnType<typeof setTimeout>[] = [];
  /** 移动端待分配拖拽的 document 级兜底监听。 */
  private readonly boundGlobalTouchMove = this.handleGlobalTouchMove.bind(this);
  private readonly boundGlobalTouchEnd = this.handleGlobalTouchEnd.bind(this);
  private readonly boundGlobalTouchCancel = this.handleGlobalTouchCancel.bind(this);
  private readonly boundGlobalPointerMove = this.handleGlobalPointerMove.bind(this);
  private readonly boundGlobalPointerUp = this.handleGlobalPointerUp.bind(this);
  private readonly boundGlobalPointerCancel = this.handleGlobalPointerCancel.bind(this);
  
  /** Overview 刷新定时器（防抖） */
  private overviewResizeTimer: ReturnType<typeof setTimeout> | null = null;
  /** 移动端视图切换追踪（用于入/出 flow 时的状态回收） */
  private lastMobileActiveView: 'text' | 'flow' | null = null;
  
  @HostListener('window:resize')
  onWindowResize(): void {
    this.bumpDetailLayoutTick();
    if (this.overviewResizeTimer) clearTimeout(this.overviewResizeTimer);
    this.overviewResizeTimer = setTimeout(() => {
      if (!this.isDestroyed) {
        this.syncDiagramViewportMetrics();
        if (!this.isOverviewCollapsed()) {
          this.diagram.refreshOverview();
        }
      }
    }, 300);
  }
  
  @HostListener('window:orientationchange')
  onOrientationChange(): void {
    this.bumpDetailLayoutTick();
    this.scheduleTimer(() => {
      if (!this.isDestroyed) {
        this.syncDiagramViewportMetrics();
        if (!this.isOverviewCollapsed()) {
          this.diagram.refreshOverview();
        }
      }
    }, 500);
  }
  
  constructor() {
    // 【2026-02-24 修复】isDestroyed 使用 getter 函数，避免 rAF 回调捕获过期布尔值
    const scheduleRaf = (tasks: Task[], forceUpdate: boolean) =>
      this.diagramEffects.scheduleRafDiagramUpdate(tasks, forceUpdate, () => this.isDestroyed);
    
    // 【2026-02-24 修复】收集所有 EffectRef，ngOnDestroy 中主动销毁以避免 @defer 拆除时竞态
    this.managedEffectRefs.push(
      this.diagramEffects.createTasksEffect(this.injector, scheduleRaf),
      this.diagramEffects.createConnectionsEffect(this.injector, scheduleRaf),
      this.diagramEffects.createExternalSourceLinksEffect(this.injector, scheduleRaf),
      this.diagramEffects.createSearchEffect(this.injector, scheduleRaf),
      this.diagramEffects.createThemeEffect(this.injector, scheduleRaf),
      this.diagramEffects.createSelectionSyncEffect(
        this.injector,
        this.selectedTaskId,
        (taskId: string) => this.selectionService.selectNodeWithRetry(taskId, this.scheduleTimer.bind(this))
      ),
      this.diagramEffects.createCenterCommandEffect(this.injector, this.executeCenterOnNode.bind(this)),
      this.diagramEffects.createRetryCommandEffect(this.injector, this.retryInitDiagram.bind(this)),
    );
    
    this.managedEffectRefs.push(
      ...this.mobileDrawer.setupDrawerEffects(this.injector, {
        paletteHeight: () => this.paletteHeight(),
        drawerHeight: () => this.drawerHeight(),
        drawerManualOverride: this.drawerManualOverride,
        isResizingDrawerSignal: () => this.isResizingDrawerSignal(),
        selectedTaskId: () => this.selectedTaskId(),
        scheduleDrawerHeightUpdate: (vh) => this.mobileDrawer.scheduleDrawerHeightUpdate(this.drawerHeight, vh)
      })
    );

    // 移动端视图切换：离开 flow 清理选中与手动高度；返回 flow 后重置到最小提示态。
    this.managedEffectRefs.push(effect(() => {
      const isMobile = this.uiState.isMobile();
      const activeView = this.uiState.activeView();

      if (!isMobile) {
        this.lastMobileActiveView = activeView;
        return;
      }

      const previousView = this.lastMobileActiveView;
      this.lastMobileActiveView = activeView;

      if (previousView === activeView) return;

      if (activeView !== 'flow') {
        this.selectedTaskId.set(null);
        this.drawerManualOverride.set(false);
        return;
      }

      // 进入 flow：默认回到"未选中提示"状态，抽屉直接设为最小高度（不触发 layoutTick 以避免自动测量覆盖）。
      this.selectedTaskId.set(null);
      this.drawerManualOverride.set(false);
      this.drawerHeight.set(8);

      // 视图切换后延迟触发布局刷新，确保容器尺寸已稳定
      this.scheduleTimer(() => {
        if (!this.isDestroyed) {
          this.bumpDetailLayoutTick();
          this.diagram.diagramInstance?.requestUpdate();
        }
      }, 150);
    }, { injector: this.injector }));
  }

  private syncDiagramViewportMetrics(): void {
    const diagramService = this.diagram as FlowDiagramService & {
      syncViewportMetrics: () => void;
    };
    diagramService.syncViewportMetrics();
  }
  
  // ========== 生命周期 ==========
  
  ngAfterViewInit() {
    this.touch.activate();
    this.scheduleDiagramInit();
    this.bumpDetailLayoutTick();
    this.zone.runOutsideAngular(() => {
      document.addEventListener('touchmove', this.boundGlobalTouchMove, { capture: true, passive: false });
      document.addEventListener('touchend', this.boundGlobalTouchEnd, { capture: true, passive: false });
      document.addEventListener('touchcancel', this.boundGlobalTouchCancel, { capture: true, passive: false });
      document.addEventListener('pointermove', this.boundGlobalPointerMove, { capture: true, passive: false });
      document.addEventListener('pointerup', this.boundGlobalPointerUp, { capture: true });
      document.addEventListener('pointercancel', this.boundGlobalPointerCancel, { capture: true });
    });
  }
  
  ngOnDestroy() {
    this.isDestroyed = true;

    // 【2026-02-24 修复】主动销毁所有 effect，避免 @defer 拆除时 Angular 内部清理竞态
    // 必须在 Angular 拆除视图内部数据结构（LView/tView）之前完成
    for (const ref of this.managedEffectRefs) {
      ref.destroy();
    }
    this.managedEffectRefs.length = 0;

    // 通知服务组件销毁
    this.selectionService.markDestroyed();
    this.diagramRetry.resetState();

    const resources: CleanupResources = {
      pendingTimers: this.pendingTimers,
      pendingRetryRafIds: [],
      overviewResizeTimer: this.overviewResizeTimer,
      idleInitHandle: this.diagramRetry.getIdleInitHandle()
    };

    this.cleanup.performCleanup(
      resources,
      () => this.touch.uninstallDiagramDragGhostListeners(this.diagram.diagramInstance)
    );

    this.zone.runOutsideAngular(() => {
      document.removeEventListener('touchmove', this.boundGlobalTouchMove, { capture: true } as EventListenerOptions);
      document.removeEventListener('touchend', this.boundGlobalTouchEnd, { capture: true } as EventListenerOptions);
      document.removeEventListener('touchcancel', this.boundGlobalTouchCancel, { capture: true } as EventListenerOptions);
      document.removeEventListener('pointermove', this.boundGlobalPointerMove, { capture: true } as EventListenerOptions);
      document.removeEventListener('pointerup', this.boundGlobalPointerUp, { capture: true } as EventListenerOptions);
      document.removeEventListener('pointercancel', this.boundGlobalPointerCancel, { capture: true } as EventListenerOptions);
    });

    this.overviewResizeTimer = null;
  }
  
  // ========== 图表初始化 ==========

  private scheduleDiagramInit(): void {
    this.diagramRetry.scheduleDiagramInit(
      () => this.initDiagram(),
      () => this.onDiagramInitialized(),
      this.scheduleTimer.bind(this),
      () => this.isDestroyed
    );
  }

  private onDiagramInitialized(delayMs: number = UI_CONFIG.MEDIUM_DELAY): void {
    // 初始化完成后加载图表数据
    this.scheduleTimer(() => {
      if (this.diagram.isInitialized) {
        this.diagram.updateDiagram(this.projectState.tasks());

        // 标记 View 已就绪
        this.flowCommand.markViewReady();

        // 检查并执行待处理的命令
        const pendingCmd = this.flowCommand.consumePendingCenterCommand();
        if (pendingCmd) {
          // 延迟执行，确保图表完全渲染
          this.scheduleTimer(() => {
            this.executeCenterOnNode(pendingCmd.taskId, pendingCmd.openDetail);
            this.flowCommand.clearCenterCommand();
          }, 100);
        }
      }
    }, delayMs);
  }
  
  private initDiagram(): void {
    const divRef = this.diagramDiv();
    if (!divRef?.nativeElement) {
      this.logger.warn('[FlowView] diagramDiv 未准备好，跳过初始化');
      return;
    }

    // 若重复初始化，先移除旧监听并清理幽灵
    this.touch.uninstallDiagramDragGhostListeners(this.diagram.diagramInstance);
    this.touch.endDiagramNodeDragGhost();

    const success = this.diagram.initialize(divRef.nativeElement);
    if (!success) return;
    
    this.eventRegistration.registerAllEvents({
      isSelectMode: () => this.selectMode.isSelectMode(),
      selectedTaskId: this.selectedTaskId,
      refreshDiagram: () => this.refreshDiagram(),
      expandDrawerToOptimalHeight: () => this.expandDrawerToOptimalHeight(),
      handleNodeMoved: (key, loc, isUnassigned, diagram) => 
        this.dragDrop.handleNodeMoved(key, loc, isUnassigned, diagram),
      isPaletteOpen: this.isPaletteOpen,
      handleDeleteKeyPressed: () => this.handleDeleteKeyPressed()
    });

    this.touch.installDiagramDragGhostListeners(this.diagram.diagramInstance, this.uiState.isMobile());
    
    this.diagram.setupDropHandler((taskData, docPoint) => {
      this.handleDiagramDrop(taskData, docPoint);
    });
    
    this.diagram.scheduleOverviewInit(
      this.overviewDiv(), this.isOverviewVisible(), this.isOverviewCollapsed(),
      this.zone, this.scheduleTimer.bind(this)
    );
  }
  
  // ========== 小地图 ==========

  toggleOverviewCollapse(): void {
    const wasCollapsed = this.isOverviewCollapsed();
    this.isOverviewCollapsed.set(!wasCollapsed);
    
    if (wasCollapsed) {
      // 展开：确保 DOM 渲染后再初始化
      requestAnimationFrame(() => {
        this.scheduleTimer(() => {
          this.diagram.scheduleOverviewInit(
            this.overviewDiv(), this.isOverviewVisible(), false,
            this.zone, this.scheduleTimer.bind(this), true
          );
        }, 100);
      });
    } else {
      this.diagram.disposeOverview();
    }
  }

  onOverviewTogglePointerDown(e: PointerEvent): void {
    // 重要：GoJS 会在 canvas 上处理指针事件；这里提前截断，避免事件被 Overview 抢走导致按钮无响应。
    e.preventDefault();
    e.stopPropagation();
    this.toggleOverviewCollapse();
  }

  retryInitDiagram(): void {
    // 先清空错误态，确保模板重新渲染 diagramDiv 容器
    this.diagram.error.set(null);

    this.diagramRetry.retryInitDiagram(
      () => this.diagramDiv(),
      () => this.initDiagram(),
      (delayMs) => this.onDiagramInitialized(delayMs ?? 0),
      this.scheduleTimer.bind(this)
    );
  }
  
  /** 完全重置图表并重新初始化 */
  resetAndRetryDiagram(): void {
    // 先清空错误态，确保模板重新渲染 diagramDiv 容器
    this.diagram.error.set(null);

    this.diagramRetry.resetAndRetryDiagram(
      () => this.diagramDiv(),
      () => this.initDiagram(),
      (delayMs) => this.onDiagramInitialized(delayMs ?? 0),
      this.scheduleTimer.bind(this)
    );
  }
  
  // ========== 图表操作 ==========
  
  zoomIn(): void {
    this.zoomService.zoomIn();
  }
  
  zoomOut(): void {
    this.zoomService.zoomOut();
  }
  
  applyAutoLayout(): void {
    this.layoutService.applyAutoLayout();
  }
  
  exportToPng(): void {
    this.diagram.exportToPng();
  }
  
  exportToSvg(): void {
    this.diagram.exportToSvg();
  }

  /** 导出 AI 战略审查 Markdown（主任务中心 + 洞察师 prompt） */
  exportStrategicReview(): void {
    this.logicExport.exportStrategicReview();
  }
  
  /** 保存到云端的结果 Promise，供 toolbar 回调使用 */
  private saveToCloudPromise: Promise<{ ok: boolean; message?: string }> | null = null;

  /**
   * 保存当前项目到云端
   * 返回 Promise 供 toolbar 组件获取结果并复位按钮状态
   */
  async saveToCloud(): Promise<{ ok: boolean; message?: string }> {
    const userId = this.authService.currentUserId();
    const activeProject = this.projectState.activeProject();

    // 离线时直接提示
    if (!this.syncService.syncState().isOnline) {
      this.toast.info('当前处于离线模式', '数据已安全保存在本地，联网后自动同步');
      return { ok: true, message: '离线模式' };
    }

    if (!userId || !activeProject) {
      this.toast.warning('无法保存', '请先登录并打开一个项目');
      return { ok: false, message: '未登录或无活动项目' };
    }

    // 使用 AbortController + setTimeout 实现超时保护
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_CONFIG.HEAVY);

    try {
      const result = await Promise.race([
        this.syncService.saveProjectToCloud(activeProject, userId),
        new Promise<never>((_resolve, reject) => {
          controller.signal.addEventListener('abort', () => reject(new Error('TIMEOUT')));
        })
      ]);

      clearTimeout(timeoutId);

      if (result.success) {
        const now = new Date().toLocaleTimeString();
        this.toast.success('已保存到云端', `最后同步: ${now}`);
        return { ok: true };
      } else if (result.conflict) {
        this.toast.warning('存在同步冲突', '请在同步面板中解决冲突后重试');
        return { ok: false, message: '同步冲突' };
      } else {
        this.toast.error('保存失败', '请检查网络连接后重试');
        return { ok: false, message: '保存失败' };
      }
    } catch (e: unknown) {
      clearTimeout(timeoutId);
      const errorMsg = e instanceof Error ? e.message : '未知错误';

      if (errorMsg === 'TIMEOUT') {
        this.toast.warning('保存超时', '数据已缓存，将在连接恢复后自动同步');
        return { ok: false, message: '超时' };
      }

      this.toast.error('保存失败', errorMsg);
      this.logger.error('saveToCloud 异常', e);
      return { ok: false, message: errorMsg };
    }
  }

  /** 居中到指定节点 */
  centerOnNode(taskId: string, openDetail: boolean = true): void {
    const task = taskId ? this.projectState.getTask(taskId) : undefined;
    if (!isNavigableFlowTask(task)) {
      this.logger.warn('目标任务不存在，忽略流程图链接跳转', { taskId });
      return;
    }

    this.flowCommand.centerOnNode(taskId, openDetail);
  }
  
  private executeCenterOnNode(taskId: string, openDetail: boolean): void {
    if (!this.diagram.isInitialized) {
      this.logger.warn('图表未初始化，无法居中到节点', { taskId });
      return;
    }
    this.zoomService.centerOnNode(taskId);
    this.selectedTaskId.set(taskId);
    if (openDetail) {
      this.uiState.isFlowDetailOpen.set(true);
    }
  }
  
  refreshLayout(): void {
    // 视图切换到 flow 后，触发一次“延后 auto-fit”的落地（若有）。
    this.diagram.onFlowActivated();
    this.zoomService.requestUpdate();
  }
  
  private refreshDiagram(): void {
    this.scheduleTimer(() => {
      this.diagram.updateDiagram(this.projectState.tasks());
    }, 50);
  }
  
  // ========== 拖放处理 ==========
  
  onDragStart(event: DragEvent, task: Task): void {
    this.dragDrop.startDrag(event, task);
  }
  
  onUnassignedDrop(event: DragEvent): void {
    if (this.dragDrop.handleFullUnassignedDrop(event)) {
      this.refreshDiagram();
    }
  }
  
  private handleDiagramDrop(taskData: Task, docPoint: go.Point): void {
    const diagramInstance = this.diagram.diagramInstance;
    if (!diagramInstance) return;

    const insertInfo = this.dragDrop.findInsertPosition(docPoint, diagramInstance);
    this.dragDrop.processDrop(taskData, insertInfo, docPoint, 100);
  }
  
  // ========== 触摸处理 ==========
  
  onUnassignedTouchStart(event: TouchEvent, task: Task): void {
    this.touch.startTouch(event, task);
  }
  
  onUnassignedTouchMove(event: TouchEvent): void {
    const shouldPrevent = this.touch.handleTouchMove(event);
    if (shouldPrevent) {
      event.preventDefault();
      event.stopPropagation();
    }
  }
  
  onUnassignedTouchEnd(event: TouchEvent): void {
    this.finishUnassignedTouchDrop(false, event);
  }

  onUnassignedTouchCancel(_event: TouchEvent): void {
    if (this.touch.deferCancelForPointerFallback()) {
      return;
    }
    this.cancelUnassignedTouchDrop();
  }

  private finishUnassignedTouchDrop(useLastKnownPosition: boolean, event?: TouchEvent): void {
    const diagramElement = this.diagramDiv()?.nativeElement ?? null;
    const diagramInstance = this.diagram.diagramInstance;
    const onDrop = (task: Task, insertInfo: InsertPositionInfo, docPoint: go.Point) => {
      this.dragDrop.processDrop(task, insertInfo, docPoint, UI_CONFIG.MEDIUM_DELAY);
    };

    if (useLastKnownPosition) {
      this.touch.endTouchFromLastPosition(diagramElement, diagramInstance, onDrop);
      return;
    }

    if (!event) return;
    this.touch.endTouch(event, diagramElement, diagramInstance, onDrop);
  }

  private hasPendingUnassignedTouch(): boolean {
    return this.hasPendingUnassignedTouchDrag();
  }

  private cancelUnassignedTouchDrop(): void {
    const diagramElement = this.diagramDiv()?.nativeElement ?? null;
    const diagramInstance = this.diagram.diagramInstance;
    this.touch.cancelTouch(
      diagramElement,
      diagramInstance,
      (task, insertInfo, docPoint) => {
        this.dragDrop.processDrop(task, insertInfo, docPoint, UI_CONFIG.MEDIUM_DELAY);
      },
    );
  }

  private handleGlobalTouchMove(event: TouchEvent): void {
    if (this.touch.isPointerSessionActive) return;
    if (!this.hasPendingUnassignedTouch()) return;

    const shouldPrevent = this.touch.handleTouchMove(event);
    if (!shouldPrevent) return;

    if (event.cancelable) {
      event.preventDefault();
    }
    event.stopPropagation();
  }

  private handleGlobalTouchEnd(event: TouchEvent): void {
    if (this.touch.isPointerSessionActive) return;
    if (!this.hasPendingUnassignedTouch()) return;
    this.zone.run(() => this.finishUnassignedTouchDrop(false, event));
  }

  private handleGlobalPointerMove(event: PointerEvent): void {
    if (event.pointerType !== 'touch') return;
    if (!event.isPrimary) return;
    if (!this.hasPendingUnassignedTouch()) return;

    const shouldPrevent = this.touch.handlePointerMove(event);
    if (shouldPrevent) {
      if (event.cancelable) {
        event.preventDefault();
      }
      event.stopPropagation();
      return;
    }

    const shouldKeepDragging = this.touch.handlePointerFallbackMove(event.clientX, event.clientY);
    if (!shouldKeepDragging) return;

    event.stopPropagation();
  }

  private handleGlobalTouchCancel(_event: TouchEvent): void {
    if (this.touch.isPointerSessionActive) return;
    if (!this.hasPendingUnassignedTouch()) return;
    this.zone.run(() => {
      if (this.touch.deferCancelForPointerFallback()) {
        return;
      }
      this.cancelUnassignedTouchDrop();
    });
  }

  private handleGlobalPointerUp(event: PointerEvent): void {
    if (event.pointerType !== 'touch') return;
    if (!event.isPrimary) return;
    if (!this.hasPendingUnassignedTouch()) return;
    this.zone.run(() => {
      if (this.touch.isPointerSessionActive) {
        this.touch.endPointer(
          event,
          this.diagramDiv()?.nativeElement ?? null,
          this.diagram.diagramInstance,
          (task, insertInfo, docPoint) => {
            this.dragDrop.processDrop(task, insertInfo, docPoint, UI_CONFIG.MEDIUM_DELAY);
          },
        );
        return;
      }

      const diagramElement = this.diagramDiv()?.nativeElement ?? null;
      const diagramInstance = this.diagram.diagramInstance;
      this.touch.endTouchAtPosition(
        diagramElement,
        diagramInstance,
        (task, insertInfo, docPoint) => {
          this.dragDrop.processDrop(task, insertInfo, docPoint, UI_CONFIG.MEDIUM_DELAY);
        },
        event.clientX,
        event.clientY,
      );
    });
  }

  private handleGlobalPointerCancel(event: PointerEvent): void {
    if (event.pointerType !== 'touch') return;
    if (!event.isPrimary) return;
    if (!this.hasPendingUnassignedTouch()) return;
    this.zone.run(() => {
      if (this.touch.isPointerSessionActive) {
        this.touch.cancelPointer(
          this.diagramDiv()?.nativeElement ?? null,
          this.diagram.diagramInstance,
          (task, insertInfo, docPoint) => {
            this.dragDrop.processDrop(task, insertInfo, docPoint, UI_CONFIG.MEDIUM_DELAY);
          },
        );
        return;
      }

      if (this.touch.isAwaitingPointerFallback) {
        this.finishUnassignedTouchDrop(true);
        return;
      }

      this.cancelUnassignedTouchDrop();
    });
  }
  
  // ========== 待分配任务点击 ==========
  
  onUnassignedTaskClick(task: Task): void {
    // 待分配任务也会在流程图中显示，直接定位到该节点
    this.centerOnNode(task.id);
  }
  
  // ========== 连接线操作 ==========
  
  confirmParentChildLink(): void {
    if (this.link.confirmParentChildLink()) {
      this.refreshDiagram();
    }
  }
  
  confirmCrossTreeLink(): void {
    if (this.link.confirmCrossTreeLink()) {
      this.refreshDiagram();
    }
  }
  
  // ========== 级联分配 ==========

  showCascadeAssignDialog(
    taskId: string,
    targetStage: number,
    targetParentId: string | null
  ): void {
    this.cascadeAssign.showDialog(taskId, targetStage, targetParentId);
  }
  
  /** 确认级联分配 */
  confirmCascadeAssign(): void {
    if (this.cascadeAssign.confirm()) {
      this.refreshDiagram();
    }
  }
  
  /** 取消级联分配 */
  cancelCascadeAssign(): void {
    this.cascadeAssign.cancel();
  }
  
  /** 保存联系块的标题和描述 */
  saveConnectionDescription(data: ConnectionEditorSavePayload): void {
    if (this.link.saveConnectionContent(data.sourceId, data.targetId, data.title, data.description)) {
      this.refreshDiagram();
    }
  }
  
  deleteConnection(): void {
    this.logger.debug('deleteConnection 被调用');
    const result = this.link.deleteCurrentConnection();
    this.logger.debug('删除结果:', result);
    if (result) {
      this.refreshDiagram();
    }
  }
  
  confirmLinkDelete(): void {
    this.logger.debug('confirmLinkDelete 被调用');
    const result = this.link.confirmLinkDelete();
    this.logger.debug('删除连接线结果:', result);
    if (result) {
      this.refreshDiagram();
    }
  }
  
  // ========== 移动端连接线操作菜单处理 ==========
  
  /** 从操作菜单编辑连接 */
  handleLinkActionEdit(): void {
    this.logger.debug('handleLinkActionEdit 被调用');
    this.link.openEditorFromActionMenu();
  }
  
  /** 从操作菜单查看父子关系 */
  handleLinkActionView(): void {
    this.logger.debug('handleLinkActionView 被调用');
    this.link.viewFromActionMenu();
  }
  
  /** 从操作菜单删除连接 */
  handleLinkActionDelete(): void {
    this.logger.debug('handleLinkActionDelete 被调用');
    const result = this.link.deleteFromActionMenu();
    this.logger.debug('从操作菜单删除连接结果:', result);
    if (result) {
      this.refreshDiagram();
    }
  }
  
  // ========== 任务操作 ==========
  
  createUnassigned(): void {
    this.taskOps.createUnassignedTask('新任务');
  }
  
  addSiblingTask(_eventTask: Task): void {
    // 使用当前 selectedTask 信号值，避免模板变量在快速切换时可能的过期引用
    const task = this.selectedTask() ?? _eventTask;
    const newTaskId = this.taskOps.addSiblingTask(task);
    if (newTaskId) {
      // 设置 selectedTaskId 会触发 effect 自动选中节点（包含重试逻辑）
      this.selectedTaskId.set(newTaskId);
      this.taskOps.focusTitleInput(this.elementRef);
    }
  }
  
  addChildTask(_eventTask: Task): void {
    // 使用当前 selectedTask 信号值，避免模板变量在快速切换时可能的过期引用
    const task = this.selectedTask() ?? _eventTask;
    const newTaskId = this.taskOps.addChildTask(task);
    if (newTaskId) {
      // 设置 selectedTaskId 会触发 effect 自动选中节点（包含重试逻辑）
      this.selectedTaskId.set(newTaskId);
      this.taskOps.focusTitleInput(this.elementRef);
    }
  }
  
  archiveTask(task: Task): void {
    const newStatus = this.taskOps.archiveTask(task);
    if (newStatus === 'archived') {
      this.selectedTaskId.set(null);
    }
  }
  
  deleteTask(task: Task): void {
    this.deleteConfirmTask.set(task);
  }

  confirmDelete(keepChildren: boolean): void {
    const task = this.deleteConfirmTask();
    if (task) {
      this.selectedTaskId.set(null);
      this.taskOps.deleteTask(task.id, keepChildren);
      this.deleteConfirmTask.set(null);
      this.deleteKeepChildren.set(false);
      
      // 强制刷新图表
      if (this.diagram.isInitialized) {
        this.diagram.updateDiagram(this.projectState.tasks(), true);
      }
    }
  }
  
  // ========== 移动端抽屉 ==========

  private expandDrawerToOptimalHeight(): void {
    // 用户双击节点时强制回到自动高度模式，确保高度按内容重新收敛。
    this.drawerManualOverride.set(false);
    // 确保最小可操作高度，然后让 layoutTick 触发内容自动测量
    const minVh = 8;
    if (this.drawerHeight() < minVh) {
      this.drawerHeight.set(minVh);
    }
    this.bumpDetailLayoutTick();
  }
  
  // ========== 批量删除 ==========

  requestBatchDelete(): void {
    const singleTask = this.batchDelete.requestBatchDelete();
    if (singleTask) {
      // 单选时走单任务删除流程
      this.deleteTask(singleTask);
    }
  }
  
  confirmBatchDelete(): void {
    const deletedCount = this.batchDelete.confirmBatchDelete(() => {
      this.selectedTaskId.set(null);
    });
    
    // 强制刷新图表
    if (deletedCount > 0 && this.diagram.isInitialized) {
      this.diagram.updateDiagram(this.projectState.tasks(), true);
    }
  }
  
  /** Delete 键处理 */
  private handleDeleteKeyPressed(): void {
    const singleTask = this.batchDelete.handleDeleteKeyPressed();
    if (singleTask) {
      this.deleteTask(singleTask);
    }
  }
  
  // ========== 框选模式 ==========

  toggleSelectMode(): void {
    this.selectMode.toggleSelectMode();
  }
  
  // ========== 调色板拖动 ==========

  startPaletteResize(e: MouseEvent): void {
    this.paletteResize.bindHeightSignal(this.paletteHeight);
    this.paletteResize.startMouseResize(e);
  }
  
  startPaletteResizeTouch(e: TouchEvent): void {
    this.paletteResize.bindHeightSignal(this.paletteHeight);
    this.paletteResize.startTouchResize(e);
  }
  
  // ========== 快捷键 ==========

  @HostListener('window:keydown', ['$event'])
  handleDiagramShortcut(event: KeyboardEvent): void {
    const result = this.keyboard.handleShortcut(event);
    if (result === 'handled') {
      this.refreshDiagram();
    }
  }
  
  // ========== 其他 ==========
  
  emitToggleSidebar(): void {
    window.dispatchEvent(new CustomEvent('toggle-sidebar'));
  }

  /** 处理调色板展开状态变更 */
  onPaletteOpenChange(isOpen: boolean): void {
    this.isPaletteOpen.set(isOpen);
    // 互斥逻辑：左侧展开时，收起右侧面板
    if (isOpen && this.uiState.isMobile()) {
      this.isRightPanelOpen.set(false);
    }
  }
  
  /** 处理抽屉状态变化 (移动端双向抽屉) */
  onDrawerStateChange(event: { previousLayer: string; currentLayer: string; triggeredBy: string }): void {
    this.logger.debug('Drawer state change:', event);
    // 顶/中/底层切换后恢复自动模式
    this.drawerManualOverride.set(false);

    // 回到中层（flow）时，重置详情到"最小 + 提示语"态，直接设置高度避免 tick 覆盖
    if (event.currentLayer === 'middle' && event.previousLayer !== 'middle') {
      this.selectedTaskId.set(null);
      this.drawerHeight.set(8);
      // 返回中层时触发图表重绘
      requestAnimationFrame(() => {
        const diagramInstance = this.diagram.diagramInstance;
        if (diagramInstance) {
          diagramInstance.requestUpdate();
        }
      });
      return;
    }

    // 其他层切换后，详情抽屉按新布局重测一次
    this.bumpDetailLayoutTick();
  }
  
  /** 移动端抽屉内点击节点定位（关闭抽屉后定位） */
  onMobileDrawerCenterOnNode(taskId: string): void {
    // 【修复 H-28】使用 scheduleTimer 替代原始 setTimeout，确保组件销毁时自动清理
    this.scheduleTimer(() => {
      this.centerOnNode(taskId);
    }, 350);
  }
  
  /**
   * 流程图区域滑动手势
   * - 向右：切换到文本视图
   * - 向左：打开项目侧边栏
   */
  onDrawerSwipeToSwitch(direction: 'left' | 'right'): void {
    if (direction === 'right') {
      // 向右滑动 → 切换到文本视图
      this.goBackToText.emit();
    } else if (direction === 'left') {
      // 向左滑动 → 打开项目侧边栏
      this.toggleRightPanel();
    }
  }
  
  /** 切换右侧面板（移动端） */
  toggleRightPanel(): void {
    if (this.uiState.isMobile()) {
      const willOpen = !this.isRightPanelOpen();
      // 互斥逻辑：先收起左侧调色板，再展开右侧面板（丝滑过渡）
      if (willOpen && this.isPaletteOpen()) {
        this.isPaletteOpen.set(false);
      }
      this.isRightPanelOpen.set(willOpen);
    }
  }
  
  // ========== 流程图区域滑动手势 ==========

  onDiagramAreaTouchStart(e: TouchEvent): void {
    this.swipeGesture.handleDiagramAreaTouchStart(e);
  }
  
  onDiagramAreaTouchMove(e: TouchEvent): void {
    this.swipeGesture.handleDiagramAreaTouchMove(e);
  }
  
  onDiagramAreaTouchEnd(e: TouchEvent): void {
    const result = this.swipeGesture.handleDiagramAreaTouchEnd(e);
    if (result === 'right') {
      this.isRightPanelOpen.set(true);
    } else if (result === 'left') {
      this.logger.debug('滑动触发 goBackToText');
      this.goBackToText.emit();
    }
  }
  
  // ========== 私有辅助方法 ==========

  private bumpDetailLayoutTick(delayMs: number = 0): void {
    if (!this.uiState.isMobile()) return;
    if (delayMs <= 0) {
      this.detailLayoutTick.update((v) => v + 1);
      return;
    }
    this.scheduleTimer(() => {
      this.detailLayoutTick.update((v) => v + 1);
    }, delayMs);
  }
  
  /**
   * 安全调度定时器，自动追踪并在组件销毁时清理
   */
  private scheduleTimer(callback: () => void, delay: number): ReturnType<typeof setTimeout> {
    const timerId = setTimeout(() => {
      // 从列表中移除已执行的定时器
      const index = this.pendingTimers.indexOf(timerId);
      if (index > -1) {
        this.pendingTimers.splice(index, 1);
      }
      // 如果组件已销毁，不执行回调
      if (this.isDestroyed) return;
      callback();
    }, delay);
    
    this.pendingTimers.push(timerId);
    return timerId;
  }
}
