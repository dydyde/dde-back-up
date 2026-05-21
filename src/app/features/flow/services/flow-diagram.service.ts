import { Injectable, inject, signal, NgZone, effect, ElementRef } from '@angular/core';
import { UiStateService } from '../../../../services/ui-state.service';
import { LoggerService } from '../../../../services/logger.service';
import { ToastService } from '../../../../services/toast.service';
import { ThemeService } from '../../../../services/theme.service';
import { FlowLayoutService } from './flow-layout.service';
import { FlowSelectionService } from './flow-selection.service';
import { FlowZoomService, type ViewState } from './flow-zoom.service';
import { FlowEventService } from './flow-event.service';
import { FlowTemplateService } from './flow-template.service';
import { FlowLinkTemplateService } from './flow-link-template.service';
import { FlowOverviewService } from './flow-overview.service';
import { FlowDiagramDataService } from './flow-diagram-data.service';
import { flowTemplateEventHandlers } from './flow-template-events';
import { getFlowStyles, FlowTheme } from '../../../../config/flow-styles';
import { Task } from '../../../../models';
import { environment } from '../../../../environments/environment';
import { UI_CONFIG, LAYOUT_CONFIG } from '../../../../config';
import { ProjectStateService } from '../../../../services/project-state.service';
import { readTaskDragPayload } from '../../../../utils/task-drag-payload';
import * as go from 'gojs';
import { AvoidsLinksRouter } from '../vendor/AvoidsLinksRouter';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
/**
 * FlowDiagramService - GoJS 图表核心服务（精简版）
 * 
 * 重构后职责：
 * - GoJS Diagram 实例的生命周期管理
 * - 小地图 (Overview) 管理
 * - 拖放支持
 * 
 * 已委托的职责：
 * - 数据同步/导出/视图状态 → FlowDiagramDataService
 * - 模板配置 → FlowTemplateService
 * - 事件处理 → FlowEventService
 * - 布局操作 → FlowLayoutService
 * - 选择管理 → FlowSelectionService
 * - 缩放控制 → FlowZoomService
 */
@Injectable({
  providedIn: 'root'
})
export class FlowDiagramService {
  private static readonly MIN_SAFE_DIAGRAM_WIDTH = 220;
  private static readonly MIN_SAFE_DIAGRAM_HEIGHT = 160;
  private static readonly MAX_HARD_RECOVERY_ATTEMPTS = 2;

  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly uiState = inject(UiStateService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('FlowDiagram');
  private readonly toast = inject(ToastService);
  private readonly zone = inject(NgZone);
  private readonly themeService = inject(ThemeService);
  private readonly projectState = inject(ProjectStateService);
  
  // ========== 委托的子服务 ==========
  private readonly layoutService = inject(FlowLayoutService);
  private readonly selectionService = inject(FlowSelectionService);
  private readonly zoomService = inject(FlowZoomService);
  private readonly eventService = inject(FlowEventService);
  private readonly templateService = inject(FlowTemplateService);
  private readonly linkTemplateService = inject(FlowLinkTemplateService);
  private readonly overviewService = inject(FlowOverviewService);
  private readonly dataService = inject(FlowDiagramDataService);
  
  // ========== 内部状态 ==========
  private diagram: go.Diagram | null = null;
  private diagramDiv: HTMLDivElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private isDestroyed = false;
  

  /** Idle 小地图初始化句柄 */
  private idleOverviewInitHandle: number | null = null;

  // ========== 定时器 ==========
  private resizeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private resizeRecoveryRafId: number | null = null;
  private resizeRecoveryArmed = false;
  private lastRecoverableViewState: ViewState | null = null;
  private lastStableViewState: ViewState | null = null;
  private lastKnownDevicePixelRatio = 1;
  private hardRecoveryAttemptCount = 0;
  private hardRecoveryInProgress = false;
  private overviewContainer: HTMLDivElement | null = null;
  private shouldRestoreOverview = false;
  private pendingOverviewRestore = false;
  private recoveryFitFallbackUsed = false;
  
  // ========== 僵尸模式 ==========
  private isSuspended = false;
  private suspendedResizeObserver: ResizeObserver | null = null;

  // ========== 事件处理器引用（用于销毁时清理） ==========
  /** ViewportBoundsChanged 监听器引用，防止泄漏 */
  private viewportBoundsHandler: ((e: go.DiagramEvent) => void) | null = null;
  /** rAF 合并 ViewportBoundsChanged 的调度句柄（避免 panning 时每帧都跑视图持久化） */
  private viewportBoundsRafId: number | null = null;

  // ========== 字体加载重绘 ==========
  /** 字体加载完成事件的回调引用，用于销毁时清理 */
  private fontLoadingDoneHandler: (() => void) | null = null;
  /** 防止 loadingdone 事件短时间内多次触发 GoJS 重绘 */
  private fontRedrawDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  
  // ========== 主题变化监听 ==========
  private themeChangeEffect = effect(() => {
    // 监听颜色模式变化，触发 GoJS 重绘
    const isDark = this.themeService.isDark();
    const theme = this.themeService.theme();
    
    // 只在 diagram 已初始化时重绘
    if (this.diagram && !this.isDestroyed && !this.isSuspended) {
      this.zone.runOutsideAngular(() => {
        // 重新设置模板并更新绑定
        this.templateService.setupNodeTemplate(this.diagram!);
        this.linkTemplateService.setupLinkTemplate(this.diagram!);
        
        // 更新所有节点和连接线的绑定
        this.diagram!.updateAllTargetBindings();
        
        // 更新画布背景色
        const flowStyles = getFlowStyles(theme as FlowTheme, isDark ? 'dark' : 'light');
        this.diagram!.div!.style.backgroundColor = flowStyles.canvas.background;
        
        // 更新 Overview（委托给 FlowOverviewService）
        this.overviewService.updateTheme();
        
        this.logger.debug('主题变化触发 GoJS 重绘', { isDark, theme });
      });
    }
  });
  
  // ========== 公开信号 ==========
  readonly error = signal<string | null>(null);
  
  // ========== 公开属性 ==========
  
  get diagramInstance(): go.Diagram | null {
    return this.diagram;
  }
  
  get isInitialized(): boolean {
    return this.diagram !== null && !this.isDestroyed;
  }
  
  get isSuspendedMode(): boolean {
    return this.isSuspended;
  }
  
  // ========== 生命周期方法 ==========
  
  /**
   * 初始化 GoJS Diagram
   * 
   * 【2026-02-25 性能优化】整个初始化在 NgZone 外部执行
   * GoJS 内部所有鼠标移动、画布重绘、工具激活（拖拽/平移/连线）
   * 都不再触发 Angular 变更检测，显著降低 50+ 节点时的交互卡顿。
   * 需要触发 CD 的回调（节点点击等）在 FlowEventService 中显式 zone.run()。
   */
  initialize(container: HTMLDivElement): boolean {
    if (typeof go === 'undefined') {
      this.handleError('GoJS 库未加载', 'GoJS library not loaded');
      return false;
    }

    this.hardRecoveryAttemptCount = 0;
    this.hardRecoveryInProgress = false;
    
    // 【性能关键】在 Angular Zone 外部创建和配置 GoJS Diagram
    // 避免 GoJS 内部事件（鼠标移动、canvas 重绘、工具切换等）触发不必要的变更检测
    return this.zone.runOutsideAngular(() => this._initializeOutsideZone(container));
  }

  /**
   * 在 NgZone 外部执行的 Diagram 初始化逻辑
   */
  private _initializeOutsideZone(container: HTMLDivElement): boolean {
    try {
      this.isDestroyed = false;
      this.diagramDiv = container;
      this.resizeRecoveryArmed = !this.isSafeDiagramSize(container.clientWidth, container.clientHeight);
      this.lastRecoverableViewState = null;
      this.lastStableViewState = null;
      this.lastKnownDevicePixelRatio = this.getDevicePixelRatio();
      
      if (environment.gojsLicenseKey) {
        (go.Diagram as unknown as { licenseKey: string }).licenseKey = environment.gojsLicenseKey;
      }
      
      const $ = go.GraphObject.make;
      
      // 创建 Diagram 实例
      this.diagram = $(go.Diagram, container, {
        "undoManager.isEnabled": false,
        "animationManager.isEnabled": false,
        "allowDrop": true,
        layout: $(go.Layout),
        "autoScale": go.Diagram.None,
        "initialAutoScale": go.Diagram.None,
        // 无限画布：使用 InfiniteScroll 模式，允许视口自由移动到任何位置
        "scrollMode": go.Diagram.InfiniteScroll,
        "scrollMargin": new go.Margin(Infinity, Infinity, Infinity, Infinity),
        "draggingTool.isGridSnapEnabled": false,
        "fixedBounds": new go.Rect(NaN, NaN, NaN, NaN),
        "computePixelRatio": () => window.devicePixelRatio || 1,
        // 减少 tooltip 悬停延迟（默认 850ms，改为 200ms）
        "toolManager.hoverDelay": 200
      });

      const isMobile = this.uiState.isMobile();

      // 【关键】在设置模板之前先配置 ToolManager
      // 某些移动端环境（Android 6.0 / Chrome Mobile）在 setupLinkTemplate 创建 contextMenu 时
      // 会内部访问 contextMenuTool.isEnabled，如果此时未初始化会抛出错误
      // 参见 Sentry: "Trying to set undefined property contextMenuTool.isEnabled"
      if (this.diagram.toolManager.contextMenuTool) {
        this.diagram.toolManager.contextMenuTool.isEnabled = false;
      }
      
      // 委托给 FlowTemplateService / FlowLinkTemplateService 设置图层和模板
      this.templateService.ensureDiagramLayers(this.diagram);
      this.templateService.setupNodeTemplate(this.diagram);
      this.linkTemplateService.setupLinkTemplate(this.diagram);
      
      // 配置工具行为：桌面端左键平移、右键框选；移动端保持原策略
      if (isMobile) {
        this.diagram.toolManager.dragSelectingTool.isEnabled = false;
        this.diagram.toolManager.panningTool.isEnabled = true;
      } else {
        this.setupDesktopPanAndSelectTools(this.diagram);
      }
      this.setupMultiSelectClickTool(this.diagram);

      // 【2026-03-04】自定义 DraggingTool：检测节点拖出画布边界，触发拖入停泊坞流程
      if (!isMobile) {
        this.setupDragOutOfBoundsTool(this.diagram);
      }
      
      // 初始化模型
      this.diagram!.model = new go.GraphLinksModel([], [], {
        linkKeyProperty: 'key',
        nodeKeyProperty: 'key',
        linkFromPortIdProperty: 'fromPortId',
        linkToPortIdProperty: 'toPortId',
        // 【2026-02-25 性能优化】启用 link 分类模板
        // 父子链接使用默认模板（无 label panel），跨树链接使用 'crossTree' 模板（含 label）
        linkCategoryProperty: 'category'
      });
      
      // 【补丁 A 2026-04-23】按配置装配 AvoidsLinksRouter（vendored 自 GoJS 官方扩展）。
      // 仅在 LAYOUT_CONFIG.AUTO_LAYOUT_ENABLE_AVOIDS_LINKS_ROUTER 打开时生效，
      // 且 router 内部会过滤 `!link.isOrthogonal` 的连线（默认 Bezier/Normal cross-tree 连线不受影响）。
      // 打开此开关需配合把 cross-tree link template 的 routing 切到 go.Link.Orthogonal。
      if (LAYOUT_CONFIG.AUTO_LAYOUT_ENABLE_AVOIDS_LINKS_ROUTER) {
        this.diagram.routers.add(new AvoidsLinksRouter({
          linkSpacing: LAYOUT_CONFIG.AUTO_LAYOUT_ROUTER_LINK_SPACING_PX,
          avoidsNodes: true,
        }));
        this.logger.info('AvoidsLinksRouter 已装配', {
          linkSpacing: LAYOUT_CONFIG.AUTO_LAYOUT_ROUTER_LINK_SPACING_PX,
        });
      }

      // 【关键】拦截 GoJS 默认删除行为，强制单向数据流 (Store -> Signal -> Diagram)
      // 这可以防止“脑裂”——GoJS 认为节点删了，但 Store 还没反应过来
      this.setupDeleteKeyInterception();
      
      // 委托给 FlowEventService 设置事件监听
      this.eventService.setDiagram(this.diagram, this.diagramDiv);
      
      // 添加视口变化监听（用于保存视图状态）
      // 【修复 C-07】存储 handler 引用，dispose() 时显式移除，防止监听器泄漏
      this.viewportBoundsHandler = () => {
        this.handleViewportBoundsChanged();
      };
      this.diagram.addDiagramListener('ViewportBoundsChanged', this.viewportBoundsHandler);
      
      // 设置 ResizeObserver
      this.setupResizeObserver();

      // 将 diagram 实例传递给其他子服务
      this.dataService.setDiagram(this.diagram);
      this.layoutService.setDiagram(this.diagram);
      this.selectionService.setDiagram(this.diagram);
      this.zoomService.setDiagram(this.diagram);
      this.zoomService.setViewStatePersistenceGuard(() => this.canPersistViewState());

      // 恢复视图状态
      this.dataService.restoreViewState();
      
      // 初始化时设置正确的画布背景色
      this.applyCanvasBackground();
      
      // 【修复 2026-02-20】字体加载完成后强制重绘 GoJS Canvas
      // Canvas 文本不受 CSS font-display: swap 影响，必须手动触发重绘
      // 确保 LXGW WenKai Screen 字体就绪后 GoJS 使用正确字体度量渲染
      this.schedulePostFontLoadRedraw();
      
      this.error.set(null);
      this.logger.info('GoJS Diagram 初始化成功');
      return true;
      
    } catch (error) {
      this.sentryLazyLoader.captureException(error, { tags: { operation: 'initDiagram' } });
      this.handleError('流程图初始化失败', error);
      return false;
    }
  }

  /**
   * 桌面端交互：左键平移视口、右键框选
   */
  private setupDesktopPanAndSelectTools(diagram: go.Diagram): void {
    const panningTool = diagram.toolManager.panningTool;
    const dragSelectTool = diagram.toolManager.dragSelectingTool;

    // 左键在空白处拖拽视口
    panningTool.isEnabled = true;
    panningTool.canStart = function () {
      if (!this.diagram || !this.isEnabled || this.diagram.isReadOnly) return false;

      const e = this.diagram.lastInput;
      if (!e || !e.left) return false;
      // 允许 Ctrl/Cmd 按下时仍可拖动画布（常见“按住 Ctrl 临时平移/查看”的习惯）
      // 保留 Shift/Alt：避免与其他修饰键交互冲突
      if (e.shift || e.alt) return false;
      if (e.targetDiagram !== this.diagram) return false;

      // 避免拦截节点/连线的拖动
      const part = this.diagram.findPartAt(e.documentPoint, true);
      if (part && (part instanceof go.Node || part instanceof go.Link)) {
        return false;
      }

      return this.diagram.allowHorizontalScroll || this.diagram.allowVerticalScroll;
    };

    // 右键拖拽框选
    dragSelectTool.isEnabled = true;
    dragSelectTool.isPartialInclusion = true;
    dragSelectTool.canStart = function () {
      if (!this.diagram || !this.isEnabled || this.diagram.isReadOnly) return false;

      const e = this.diagram.lastInput;
      if (!e || !e.right) return false;
      if (e.targetDiagram !== this.diagram) return false;

      const part = this.diagram.findPartAt(e.documentPoint, true);
      if (part && (part instanceof go.Node || part instanceof go.Link)) {
        return false;
      }

      return true;
    };
  }

  /**
   * 自定义点击选择行为
   * - 在 GoJS 默认选择逻辑之前处理多选（Shift/Ctrl/Cmd 或移动端框选模式）
   * - 解决默认 ClickSelectingTool 先清空选择、再触发节点 click 导致无法多选的问题
   */
  private setupMultiSelectClickTool(diagram: go.Diagram): void {
    const clickTool = diagram.toolManager.clickSelectingTool;
    const isMobileMode = this.uiState.isMobile();
    // GoJS 类型声明将 standardMouseSelect 定义为无参方法，但实际会以 (e, obj) 调用
    const originalStandardMouseSelect = (clickTool.standardMouseSelect as (e?: go.InputEvent, obj?: go.GraphObject | null) => void).bind(clickTool);
    const originalStandardTouchSelect = ((clickTool as unknown as { standardTouchSelect?: (e?: go.InputEvent, obj?: go.GraphObject | null) => void }).standardTouchSelect)?.bind(clickTool);

    (clickTool as unknown as { standardMouseSelect: (e?: go.InputEvent, obj?: go.GraphObject | null) => void }).standardMouseSelect = (e?: go.InputEvent, obj?: go.GraphObject | null) => {
      // 如果事件已经被模板 click（或其他工具）处理过，避免重复切换导致“选中闪烁/失效”
      if (e?.handled) return;

      const dragSelectTool = diagram.toolManager.dragSelectingTool;
      const lastInput = diagram.lastInput as go.InputEvent | null;
      const domEvent = (e as go.InputEvent & { event?: MouseEvent | PointerEvent | KeyboardEvent })?.event;

      // 移动端框选模式：点击节点时禁用默认单选，交给节点模板或下方逻辑处理
      const isSelectModeActive = isMobileMode && Boolean(dragSelectTool && dragSelectTool.isEnabled);
      if (isSelectModeActive && obj?.part instanceof go.Node) {
        this.logger.debug('[standardMouseSelect] 框选模式激活', { nodeKey: obj.part.key, isSelected: obj.part.isSelected });
        if (e) {
          e.handled = true;
        } else {
          this.logger.warn('[FlowDiagram] 事件对象为 undefined，无法标记为已处理');
        }
        // 在事务中切换选中状态
        diagram.startTransaction('toggle-selection');
        obj.part.isSelected = !obj.part.isSelected;
        diagram.commitTransaction('toggle-selection');
        // 手动触发 ChangedSelection 事件
        diagram.raiseDiagramEvent('ChangedSelection');
        this.logger.debug('[toggle-selection] 切换选中状态完成', { 
          nodeKey: obj.part.key, 
          newState: obj.part.isSelected,
          totalSelected: diagram.selection.count
        });
        return;
      }

      const shift = Boolean(e?.shift || lastInput?.shift || domEvent?.shiftKey);
      const ctrl = Boolean(e?.control || lastInput?.control || (domEvent as MouseEvent | undefined)?.ctrlKey);
      const meta = Boolean(e?.meta || lastInput?.meta || (domEvent as MouseEvent | undefined)?.metaKey);
      // 桌面端：仅修饰键触发多选；移动端框选模式的点选在模板事件中处理
      const wantsMultiSelect = shift || ctrl || meta;

      if (wantsMultiSelect && obj?.part instanceof go.Node) {
        if (e) {
          e.handled = true;
        } else {
          this.logger.warn('[FlowDiagram] 多选模式下事件对象为 undefined');
        }
        diagram.startTransaction('multi-select');
        obj.part.isSelected = !obj.part.isSelected;
        diagram.commitTransaction('multi-select');
        // 显式触发 ChangedSelection，确保 FlowSelectionService 同步（避免某些路径下事件不触发）
        diagram.raiseDiagramEvent('ChangedSelection');
        return;
      }

      // 防御性检查：避免将 undefined 传递给 GoJS 原始方法
      if (e) {
        originalStandardMouseSelect(e, obj);
      } else {
        // 某些编程式调用场景下事件可能为 undefined，这是可接受的
        this.logger.debug('[FlowDiagram] 跳过 originalStandardMouseSelect 调用（事件为 undefined）');
      }
    };

    // 移动端：触摸点击也会走 standardTouchSelect（不重写会导致先清空 selection，从而无法“点击追加多选”）
    if (typeof originalStandardTouchSelect === 'function') {
      (clickTool as unknown as { standardTouchSelect: (e?: go.InputEvent, obj?: go.GraphObject | null) => void }).standardTouchSelect = (e?: go.InputEvent, obj?: go.GraphObject | null) => {
        const dragSelectTool = diagram.toolManager.dragSelectingTool;
        const isSelectModeActive = isMobileMode && Boolean(dragSelectTool && dragSelectTool.isEnabled);

        // 仅在移动端框选模式下启用"点选多选"
        if (isSelectModeActive && obj?.part instanceof go.Node) {
          if (e) {
            e.handled = true;
          } else {
            this.logger.warn('[FlowDiagram] Touch 事件对象为 undefined');
          }
          // 在事务中切换选中状态
          diagram.startTransaction('toggle-selection');
          obj.part.isSelected = !obj.part.isSelected;
          diagram.commitTransaction('toggle-selection');
          // 手动触发 ChangedSelection 事件
          diagram.raiseDiagramEvent('ChangedSelection');
          this.logger.debug('[Touch toggle] 切换完成', { 
            nodeKey: obj.part.key, 
            newState: obj.part.isSelected,
            totalSelected: diagram.selection.count
          });
          return;
        }
        // 防御性检查：避免将 undefined 传递给 GoJS 原始方法
        if (e) {
          originalStandardTouchSelect(e, obj);
        } else {
          this.logger.warn('[FlowDiagram] 跳过 originalStandardTouchSelect 调用（事件为 undefined）');
        }
      };
    }
  }

  /**
   * 【2026-03-04】自定义 DraggingTool：检测节点拖出画布边界
   * 
   * 问题根因：GoJS DraggingTool 在内部处理拖拽，节点始终保持在 Canvas 内部，
   * 无法跨越到 HTML DOM 元素（如停泊坞 drop-zone）。
   * 用户 Ctrl+Click 选中多个节点后拖动，节点向下移动但永远到不了停泊坞。
   * 
   * 解决方案：
   * 1. 覆盖 DraggingTool.doMouseMove，在每次拖拽移动时检测鼠标是否超出画布边界
   * 2. 当鼠标移出画布底部/左/右边界时，取消 GoJS 内部拖拽（doCancel）
   * 3. 收集当前选中的所有节点 task ID，启动指针跟踪式拖入停泊坞流程
   * 4. 还原节点原始位置，避免 GoJS 内部状态与 Store 不一致
   */
  private setupDragOutOfBoundsTool(diagram: go.Diagram): void {
    const draggingTool = diagram.toolManager.draggingTool;
    const self = this;

    // 保存拖拽开始时各节点的初始位置，用于还原
    let savedPositions: Map<string, go.Point> = new Map();
    // 标志位：防止 dragOutOfBounds 重复触发
    let hasFiredDragOut = false;

    const originalDoActivate = draggingTool.doActivate.bind(draggingTool);
    draggingTool.doActivate = function () {
      savedPositions = new Map();
      hasFiredDragOut = false;
      // 记录所有选中节点的初始位置
      diagram.selection.each((part: go.Part) => {
        if (part instanceof go.Node && typeof part.key === 'string') {
          savedPositions.set(part.key, part.location.copy());
        }
      });
      originalDoActivate();
    };

    const originalDoMouseMove = draggingTool.doMouseMove.bind(draggingTool);
    draggingTool.doMouseMove = function () {
      if (hasFiredDragOut) return;

      const e = diagram.lastInput;
      if (!e || !self.diagramDiv) {
        originalDoMouseMove();
        return;
      }

      // 获取鼠标在浏览器窗口中的坐标
      const divRect = self.diagramDiv.getBoundingClientRect();
      const mouseClientX = divRect.left + e.viewPoint.x;
      const mouseClientY = divRect.top + e.viewPoint.y;

      // 检测鼠标是否超出画布边界（底部、左侧或右侧超出 40px 才触发，避免误触）
      const outOfBoundsThreshold = 40;
      const isOutBottom = mouseClientY > divRect.bottom + outOfBoundsThreshold;
      const isOutLeft = mouseClientX < divRect.left - outOfBoundsThreshold;
      const isOutRight = mouseClientX > divRect.right + outOfBoundsThreshold;
      const isOutTop = mouseClientY < divRect.top - outOfBoundsThreshold;

      if (isOutBottom || isOutLeft || isOutRight || isOutTop) {
        hasFiredDragOut = true;

        // 收集选中的任务 ID
        const selectedTaskIds: string[] = [];
        diagram.selection.each((part: go.Part) => {
          if (part instanceof go.Node && typeof part.key === 'string') {
            selectedTaskIds.push(part.key);
          }
        });

        if (selectedTaskIds.length > 0) {
          self.logger.info('节点拖出画布边界，启动拖入停泊坞流程', {
            taskIds: selectedTaskIds,
            count: selectedTaskIds.length,
            direction: isOutBottom ? 'bottom' : isOutTop ? 'top' : isOutLeft ? 'left' : 'right',
          });

          // 取消 GoJS 内部拖拽
          draggingTool.doCancel();

          // 还原节点到原始位置（防止 GoJS 拖拽中途把节点位移了）
          diagram.startTransaction('restore-drag-positions');
          savedPositions.forEach((pos, key) => {
            const node = diagram.findNodeForKey(key);
            if (node) {
              node.location = pos;
            }
          });
          diagram.commitTransaction('restore-drag-positions');

          // 触发拖入停泊坞流程（通过事件总线解耦）
          flowTemplateEventHandlers.onNodesDragOutOfBounds?.(selectedTaskIds, mouseClientX, mouseClientY);
        }
        return;
      }

      originalDoMouseMove();
    };

    this.logger.debug('DraggingTool 边界检测已配置');
  }
  
  /**
   * 暂停图表（僵尸模式）
   */
  suspend(): void {
    if (!this.diagram || this.isSuspended) return;
    
    try {
      this.logger.info('进入僵尸模式');
      
      this.diagram.isReadOnly = true;
      this.diagram.animationManager.isEnabled = false;
      
      if (this.resizeObserver) {
        this.suspendedResizeObserver = this.resizeObserver;
        this.resizeObserver.disconnect();
        this.resizeObserver = null;
      }
      
      this.clearAllTimers();

      this.isSuspended = true;
    } catch (error) {
      this.logger.error('暂停图表失败:', error);
    }
  }
  
  /**
   * 恢复图表
   */
  resume(): void {
    if (!this.diagram || !this.isSuspended) return;
    
    try {
      this.logger.info('退出僵尸模式');
      
      this.isSuspended = false;
      this.diagram.isReadOnly = false;
      this.diagram.animationManager.isEnabled = false;
      
      if (this.suspendedResizeObserver && this.diagramDiv) {
        this.resizeObserver = this.suspendedResizeObserver;
        this.resizeObserver.observe(this.diagramDiv);
        this.suspendedResizeObserver = null;
      } else if (!this.resizeObserver && this.diagramDiv) {
        this.setupResizeObserver();
      }
      
      this.diagram.requestUpdate();

      // 【2026-02-25 性能优化】恢复时仅请求一次更新，不再全量 invalidateRoute
      // GoJS 在 requestUpdate() 时会自动重新路由需要更新的链接
      this.zone.runOutsideAngular(() => {
        requestAnimationFrame(() => {
          if (!this.diagram || this.isDestroyed) return;
          this.diagram.requestUpdate();
        });
      });
    } catch (error) {
      this.logger.error('恢复图表失败:', error);
    }
  }
  
  // ========== 小地图 ==========
  
  /**
   * 初始化小地图
   * 
   * 【重构完成】完全委托给 FlowOverviewService
   * 内部保留的重复代码将在下一个 Sprint 中删除
   */
  initializeOverview(container: HTMLDivElement): void {
    if (!this.diagram || this.isDestroyed) return;

    this.overviewContainer = container;
    this.shouldRestoreOverview = true;
    this.pendingOverviewRestore = false;
    
    // 设置 OverviewService 的主图引用
    this.overviewService.setDiagram(this.diagram);
    
    // 完全委托给 FlowOverviewService
    const isMobile = this.uiState.isMobile();
    this.overviewService.initializeOverview(container, isMobile);
  }
  
  /**
   * 应用画布背景色（根据当前主题）
   */
  private applyCanvasBackground(): void {
    if (!this.diagram || !this.diagram.div) return;
    
    const theme = this.themeService.theme() as FlowTheme;
    const isDark = this.themeService.isDark();
    const flowStyles = getFlowStyles(theme, isDark ? 'dark' : 'light');
    this.diagram.div.style.backgroundColor = flowStyles.canvas.background;
  }

  /**
   * 【修复 2026-02-20】字体加载完成后强制重绘 GoJS Canvas
   *
   * 问题：GoJS 渲染到 <canvas>，Canvas 文本不受 CSS font-display: swap 影响。
   * 当 GoJS 初始渲染时自定义字体 LXGW WenKai Screen 可能尚未加载完成，
   * Canvas 会使用 fallback 字体（sans-serif）的度量绘制文本。
   * 即使字体后续加载成功，已绘制的 Canvas 文本也不会自动更新。
   *
   * 解决方案（双保险）：
   * 1. document.fonts.ready：等待首屏初始字体全部就绪后重绘
   * 2. document.fonts loadingdone 事件：监听后续按需加载的字体子集就绪后重绘
   *    （例如用户输入了罕用汉字，触发新的 unicode-range 子集下载）
   */
  private schedulePostFontLoadRedraw(): void {
    if (typeof document === 'undefined' || !document.fonts) return;

    // 1. 首屏字体就绪后立即重绘
    document.fonts.ready.then(() => {
      this.redrawForFontChange();
    });

    // 2. 持续监听后续字体子集加载完成事件（带防抖）
    this.fontLoadingDoneHandler = () => {
      // 防抖：500ms 内的多次 loadingdone 事件只触发一次重绘
      if (this.fontRedrawDebounceTimer) {
        clearTimeout(this.fontRedrawDebounceTimer);
      }
      this.fontRedrawDebounceTimer = setTimeout(() => {
        this.redrawForFontChange();
        this.fontRedrawDebounceTimer = null;
      }, 500);
    };
    document.fonts.addEventListener('loadingdone', this.fontLoadingDoneHandler);
  }

  /**
   * 字体变化后强制 GoJS Canvas 重绘
   * 让 TextBlock 重新度量并使用新加载的字体渲染
   */
  private redrawForFontChange(): void {
    if (!this.diagram || this.isDestroyed || this.isSuspended) return;

    this.zone.runOutsideAngular(() => {
      this.diagram!.updateAllTargetBindings();
      this.diagram!.requestUpdate();
      this.logger.debug('字体变化，GoJS Canvas 已重绘');
    });
  }

  /**
   * 清理字体加载事件监听
   */
  private cleanupFontLoadListener(): void {
    if (this.fontLoadingDoneHandler && typeof document !== 'undefined' && document.fonts) {
      document.fonts.removeEventListener('loadingdone', this.fontLoadingDoneHandler);
      this.fontLoadingDoneHandler = null;
    }
    if (this.fontRedrawDebounceTimer) {
      clearTimeout(this.fontRedrawDebounceTimer);
      this.fontRedrawDebounceTimer = null;
    }
  }
  
  /**
   * 销毁小地图
   * 
   * 【重构完成】完全委托给 FlowOverviewService
   */
  disposeOverview(): void {
    this.shouldRestoreOverview = false;
    this.pendingOverviewRestore = false;
    // 完全委托给 FlowOverviewService
    this.overviewService.destroyOverview();
  }
  
  refreshOverview(): void {
    this.overviewService.refreshOverview();
  }

  public syncViewportMetrics(): void {
    if (!this.diagram || !this.diagramDiv || this.isDestroyed || this.hardRecoveryInProgress) {
      return;
    }

    const pixelRatioChanged = this.updateDevicePixelRatio();
    this.handleDiagramContainerResize(
      this.diagramDiv.clientWidth,
      this.diagramDiv.clientHeight,
      pixelRatioChanged,
    );
    this.attemptPendingOverviewRestore();
  }

  /** 调度小地图初始化（idle 优先） */
  scheduleOverviewInit(
    overviewDiv: ElementRef | undefined,
    isVisible: boolean,
    isCollapsed: boolean,
    zone: NgZone,
    scheduleTimer: (cb: () => void, delay: number) => void,
    immediate = false
  ): void {
    if (!isVisible || isCollapsed) {
      this.shouldRestoreOverview = false;
      return;
    }

    if (overviewDiv?.nativeElement) {
      this.overviewContainer = overviewDiv.nativeElement;
      this.shouldRestoreOverview = true;
    }

    const runInit = () => {
      if (overviewDiv?.nativeElement && this.isInitialized) {
        this.initializeOverview(overviewDiv.nativeElement);
      }
    };
    if (immediate) { scheduleTimer(() => runInit(), 0); return; }
    if (typeof requestIdleCallback !== 'undefined') {
      if (typeof cancelIdleCallback !== 'undefined' && this.idleOverviewInitHandle !== null) {
        cancelIdleCallback(this.idleOverviewInitHandle);
      }
      this.idleOverviewInitHandle = requestIdleCallback(() => {
        this.idleOverviewInitHandle = null;
        zone.run(() => runInit());
      }, { timeout: 3000 });
    } else {
      scheduleTimer(() => runInit(), 300);
    }
  }

  cancelIdleOverviewInit(): void {
    if (this.idleOverviewInitHandle !== null && typeof cancelIdleCallback !== 'undefined') {
      cancelIdleCallback(this.idleOverviewInitHandle);
      this.idleOverviewInitHandle = null;
    }
  }

  dispose(): void {
    this.isDestroyed = true;
    this.resizeRecoveryArmed = false;
    this.lastRecoverableViewState = null;
    this.lastStableViewState = null;
    this.lastKnownDevicePixelRatio = 1;
    this.hardRecoveryAttemptCount = 0;
    this.hardRecoveryInProgress = false;
    this.overviewContainer = null;
    this.shouldRestoreOverview = false;
    this.pendingOverviewRestore = false;
    this.recoveryFitFallbackUsed = false;
    
    // 清理数据服务
    this.dataService.dispose();
    this.templateService.closeSiyuanPopover();
    
    this.disposeOverview();
    this.clearAllTimers();
    // 【修复 2026-02-20】清理字体加载事件监听
    this.cleanupFontLoadListener();
    
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    
    // 【P1-11 修复】清理 drop 事件监听器
    this.dropHandlerCleanup?.();
    this.dropHandlerCleanup = null;
    this.diagramDropHandler = null;
    
    // 清理事件服务
    this.eventService.dispose();
    
    if (this.diagram) {
      // 【修复 C-07】显式移除 ViewportBoundsChanged 监听器，防止泄漏
      if (this.viewportBoundsHandler) {
        this.diagram.removeDiagramListener('ViewportBoundsChanged', this.viewportBoundsHandler);
        this.viewportBoundsHandler = null;
      }
      if (this.viewportBoundsRafId !== null) {
        cancelAnimationFrame(this.viewportBoundsRafId);
        this.viewportBoundsRafId = null;
      }
      // 顺序：先移除监听器 → clear 清除数据 → div = null 断开 DOM
      this.diagram.clear();
      this.diagram.div = null;
      this.diagram = null;
    }
    
    this.diagramDiv = null;
    
    // 清理子服务
    this.layoutService.dispose();
    this.selectionService.setDiagram(null);
    this.zoomService.setViewStatePersistenceGuard(null);
    this.zoomService.dispose();
    
    this.logger.info('GoJS Diagram 已销毁');
  }
  
  // ========== 导出功能（委托给 FlowDiagramDataService） ==========
  
  async exportToPng(): Promise<Blob | null> {
    return this.dataService.exportToPng();
  }
  
  async exportToSvg(): Promise<Blob | null> {
    return this.dataService.exportToSvg();
  }
  
  // ========== 图表操作 ==========
  
  /**
   * 移除连接线
   */
  removeLink(link: go.Link): void {
    if (this.diagram && link) {
      const model = this.diagram.model as go.GraphLinksModel;
      if (link.data && model.linkDataArray) {
        this.diagram.startTransaction('remove-link');
        model.removeLinkData(link.data);
        this.diagram.commitTransaction('remove-link');
      } else {
        this.diagram.remove(link);
      }
    }
  }
  
  /**
   * 选中指定节点
   */
  selectNode(nodeKey: string): void {
    this.selectionService.selectNode(nodeKey, true);
  }
  
  /**
   * 获取最后的输入点
   */
  getLastInputViewPoint(): go.Point | null {
    return this.diagram?.lastInput?.viewPoint || null;
  }
  
  /**
   * 由外部在 Flow 视图激活时调用（委托给 FlowDiagramDataService）
   */
  onFlowActivated(): void {
    this.dataService.onFlowActivated();
  }
  
  // ========== 图表数据更新（委托给 FlowDiagramDataService） ==========

  /**
   * 更新图表数据
   */
  updateDiagram(tasks: Task[], forceRefresh: boolean = false): void {
    this.dataService.updateDiagram(tasks, forceRefresh);
  }
  
  // ========== 拖放支持 ==========
  
  // 【P1-11 修复】保存事件监听器引用，用于 dispose 时清理
  private dropHandlerCleanup: (() => void) | null = null;
  private diagramDropHandler: ((taskData: Task, docPoint: go.Point) => void) | null = null;

  setupDropHandler(onDrop: (taskData: Task, docPoint: go.Point) => void): void {
    if (!this.diagramDiv) return;

    this.diagramDropHandler = onDrop;
    
    // 【P1-11 修复】先清理旧的监听器，防止重复注册
    this.dropHandlerCleanup?.();
    
    const dragoverHandler = (e: DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'move';
      }
    };
    
    const dropHandler = (e: DragEvent) => {
      e.preventDefault();
      if (!e.dataTransfer || !this.diagram || !this.diagramDiv) return;

      try {
        const payload = readTaskDragPayload(e.dataTransfer);
        let task: Task | null = payload ? this.projectState.getTask(payload.taskId) ?? null : null;

        if (!task) {
          const jsonData = e.dataTransfer.getData("application/json");
          const textData = e.dataTransfer.getData("text");
          const data = jsonData || textData;
          if (!data) return;

          const trimmed = data.trim();
          if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            const raw = JSON.parse(data) as Partial<Task> & { id?: unknown };
            const candidateId = typeof raw.id === 'string' ? raw.id : null;
            task = candidateId ? this.projectState.getTask(candidateId) ?? (raw as Task) : null;
          } else {
            task = this.projectState.getTask(trimmed) ?? null;
          }
        }

        if (!task) return;

        // 使用 DragEvent 的坐标计算准确的拖放位置
        // diagram.lastInput.viewPoint 在拖放场景下可能不准确
        const rect = this.diagramDiv.getBoundingClientRect();
        const viewX = e.clientX - rect.left;
        const viewY = e.clientY - rect.top;
        const pt = new go.Point(viewX, viewY);
        const loc = this.diagram.transformViewToDoc(pt);
        onDrop(task, loc);
      } catch (err) {
        this.logger.error('Drop error:', err);
        this.sentryLazyLoader.captureException(err, { tags: { operation: 'drop' } });
      }
    };
    
    this.diagramDiv.addEventListener('dragover', dragoverHandler);
    this.diagramDiv.addEventListener('drop', dropHandler);
    
    // 保存清理函数
    const div = this.diagramDiv;
    this.dropHandlerCleanup = () => {
      div.removeEventListener('dragover', dragoverHandler);
      div.removeEventListener('drop', dropHandler);
    };
  }
  
  // ========== 私有方法 ==========
  
  /**
   * 【关键】拦截 GoJS 默认命令行为
   * 
   * 设计原则：强制单向数据流 (Store -> Signal -> Diagram)
   * - 禁止 GoJS 直接删除/复制/粘贴节点，避免"脑裂"问题
   * - Delete/Backspace 键触发自定义事件，由 Angular Service 处理
   * - 所有数据操作必须先更新 Store，再由 Store 变化驱动 GoJS 刷新
   * 
   * 【2026-03-04 修复】禁用 GoJS 默认复制粘贴
   * 根因：GoJS copy-paste 会创建带自动生成数字 key（如 -13）的幽灵节点，
   * 这些节点不存在于 Store 中，选中后执行删除会导致 "任务不存在: -13" 错误。
   */
  private setupDeleteKeyInterception(): void {
    if (!this.diagram) return;
    
    const diagram = this.diagram;
    const originalDoKeyDown = diagram.commandHandler.doKeyDown.bind(diagram.commandHandler);
    
    // 禁止 GoJS 默认的删除选中项行为
    diagram.commandHandler.canDeleteSelection = () => false;
    
    // 禁止 GoJS 默认的复制粘贴行为——防止创建幽灵节点
    diagram.commandHandler.canCopySelection = () => false;
    diagram.commandHandler.canPasteSelection = () => false;
    
    // 拦截 Delete/Backspace 键
    diagram.commandHandler.doKeyDown = () => {
      const e = diagram.lastInput;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        // 触发自定义删除事件，由 FlowEventService 处理
        // 通过事件总线解耦，避免循环依赖
        this.logger.debug('拦截 Delete 键，触发自定义删除事件');
        flowTemplateEventHandlers.onDeleteKeyPressed?.();
        return; // 阻止 GoJS 默认删除
      }
      // 其他按键走默认逻辑
      originalDoKeyDown();
    };
    
    this.logger.info('GoJS 命令拦截已配置：删除/复制/粘贴行为已禁用');
  }
  
  private setupResizeObserver(): void {
    if (!this.diagramDiv) return;
    
    this.resizeObserver = new ResizeObserver((entries) => {
      if (this.isDestroyed || this.hardRecoveryInProgress) {
        return;
      }

      const latestEntry = entries[entries.length - 1];
      const entryWidth = latestEntry?.contentRect.width ?? this.diagramDiv?.clientWidth ?? 0;
      const entryHeight = latestEntry?.contentRect.height ?? this.diagramDiv?.clientHeight ?? 0;
      const pixelRatioChanged = this.updateDevicePixelRatio();

      if (pixelRatioChanged || !this.isSafeDiagramSize(entryWidth, entryHeight)) {
        this.armResizeRecovery();
      }

      if (this.resizeDebounceTimer) {
        clearTimeout(this.resizeDebounceTimer);
      }
      
      this.resizeDebounceTimer = setTimeout(() => {
        this.syncViewportMetrics();
      }, UI_CONFIG.RESIZE_DEBOUNCE_DELAY);
    });
    
    this.resizeObserver.observe(this.diagramDiv);
  }
  
  private clearAllTimers(): void {
    if (this.resizeDebounceTimer) {
      clearTimeout(this.resizeDebounceTimer);
      this.resizeDebounceTimer = null;
    }
    if (this.resizeRecoveryRafId !== null) {
      cancelAnimationFrame(this.resizeRecoveryRafId);
      this.resizeRecoveryRafId = null;
    }
    this.dataService.clearTimers();
  }

  private handleViewportBoundsChanged(): void {
    // 【2026-04-24 性能优化】panning 期间此事件按 ~60Hz 触发，
    // 原实现每帧都 captureStableViewState + saveViewState(内部 clear/set setTimeout)
    // 会放大 Angular Zone setTimeout 的 patch 开销，造成 30+ 节点拖拽时的"拖尾"。
    // 使用 rAF 合并同帧内多次触发，只在真正有新帧时落地。
    if (this.viewportBoundsRafId !== null) return;
    this.viewportBoundsRafId = requestAnimationFrame(() => {
      this.viewportBoundsRafId = null;
      this.captureStableViewState();
      if (!this.canPersistViewState()) {
        return;
      }
      this.dataService.saveViewState();
    });
  }

  private handleDiagramContainerResize(width: number, height: number, forceRecovery: boolean = false): void {
    if (!this.diagram || !this.diagramDiv || this.isDestroyed) {
      return;
    }

    if (forceRecovery) {
      this.armResizeRecovery();
    }

    if (width <= 0 || height <= 0) {
      this.armResizeRecovery();
      return;
    }

    if (!this.isSafeDiagramSize(width, height)) {
      this.armResizeRecovery();
      return;
    }

    this.diagram.requestUpdate();

    if (this.resizeRecoveryArmed || forceRecovery) {
      this.scheduleResizeRecovery();
      return;
    }

    this.captureStableViewState();
  }

  private scheduleResizeRecovery(): void {
    if (!this.diagram || !this.diagramDiv || this.isDestroyed) {
      return;
    }

    if (this.resizeRecoveryRafId !== null) {
      cancelAnimationFrame(this.resizeRecoveryRafId);
      this.resizeRecoveryRafId = null;
    }

    this.zone.runOutsideAngular(() => {
      this.resizeRecoveryRafId = requestAnimationFrame(() => {
        this.resizeRecoveryRafId = requestAnimationFrame(() => {
          this.resizeRecoveryRafId = null;
          this.recoverDiagramAfterUnsafeResize();
        });
      });
    });
  }

  private recoverDiagramAfterUnsafeResize(): void {
    if (!this.diagram || !this.diagramDiv || this.isDestroyed) {
      return;
    }

    const width = this.diagramDiv.clientWidth;
    const height = this.diagramDiv.clientHeight;
    if (!this.isSafeDiagramSize(width, height)) {
      return;
    }

    this.diagram.updateAllTargetBindings();
    this.diagram.requestUpdate();

    if (!this.restoreBestKnownViewState()) {
      this.zoomService.fitToContents();
    }

    this.diagram.requestUpdate();
    this.scheduleRecoveryVerification(true);
  }

  private captureStableViewState(): void {
    if (!this.diagram || !this.canPersistViewState()) {
      return;
    }

    const viewState: ViewState = {
      scale: this.diagram.scale,
      positionX: this.diagram.position.x,
      positionY: this.diagram.position.y,
    };

    this.lastRecoverableViewState = viewState;

    if (this.hasVisibleDiagramContent()) {
      this.lastStableViewState = viewState;
    }
  }

  private restoreBestKnownViewState(): boolean {
    const stableViewState = this.normalizeViewState(this.lastStableViewState);

    if (stableViewState) {
      this.applyViewState(stableViewState);
      return true;
    }

    const recoverableViewState = this.normalizeViewState(this.lastRecoverableViewState);
    if (recoverableViewState) {
      this.applyViewState(recoverableViewState);
      return true;
    }

    const persistedViewState = this.normalizeViewState(this.projectState.getViewState() as ViewState | null);
    if (persistedViewState) {
      this.applyViewState(persistedViewState);
      return true;
    }

    return false;
  }

  private armResizeRecovery(): void {
    this.resizeRecoveryArmed = true;
    this.recoveryFitFallbackUsed = false;
    this.dataService.cancelPendingViewStateSave();
    this.zoomService.cancelPendingViewStateSave();
  }

  private tryHardDiagramRecovery(): boolean {
    if (!this.diagramDiv || !this.diagram || this.isDestroyed || this.hardRecoveryInProgress) {
      return false;
    }

    if (typeof (this.diagram as go.Diagram & { clear?: unknown }).clear !== 'function') {
      return false;
    }

    if (this.hardRecoveryAttemptCount >= FlowDiagramService.MAX_HARD_RECOVERY_ATTEMPTS) {
      this.logger.warn('流程图原地重建次数已达上限，停止继续重试');
      return false;
    }

    this.hardRecoveryAttemptCount += 1;
    this.hardRecoveryInProgress = true;

    const container = this.diagramDiv;
    const selectionKeys = this.selectionService.getSelectedNodeKeys();
    const recoveryViewState = this.getPreferredRecoveryViewState();
    const shouldRestoreOverview = this.shouldRestoreOverview;
    const overviewContainer = shouldRestoreOverview ? this.overviewContainer : null;

    try {
      this.logger.warn('普通恢复失败，开始原地重建 GoJS Diagram', {
        attempt: this.hardRecoveryAttemptCount,
      });

      this.teardownDiagramForRecovery();

      const initialized = this._initializeOutsideZone(container);
      if (!initialized || !this.diagram) {
        this.dataService.setDiagram(null);
        this.layoutService.setDiagram(null);
        this.selectionService.setDiagram(null);
        this.zoomService.setDiagram(null);
        this.hardRecoveryInProgress = false;
        return false;
      }

      this.resizeRecoveryArmed = true;

      this.updateDiagram(this.projectState.tasks(), true);

      if (recoveryViewState) {
        this.applyViewState(recoveryViewState);
      } else {
        this.zoomService.fitToContents();
      }

      this.diagram.requestUpdate();

      if (selectionKeys.length > 0) {
        this.selectionService.selectMultiple(selectionKeys);
      }

      if (this.diagramDropHandler) {
        this.setupDropHandler(this.diagramDropHandler);
      }

      if (shouldRestoreOverview && overviewContainer) {
        this.restoreOverviewAfterRecovery(overviewContainer);
      }

      this.scheduleRecoveryVerification(false);
      return true;
    } catch (error) {
      this.hardRecoveryInProgress = false;
      this.logger.error('流程图原地重建失败', error);
      this.sentryLazyLoader.captureException(error, { tags: { operation: 'hardResizeRecovery' } });
      return false;
    }
  }

  private scheduleRecoveryVerification(allowHardRecovery: boolean): void {
    if (!this.diagram || !this.diagramDiv || this.isDestroyed) {
      return;
    }

    if (this.resizeRecoveryRafId !== null) {
      cancelAnimationFrame(this.resizeRecoveryRafId);
      this.resizeRecoveryRafId = null;
    }

    this.zone.runOutsideAngular(() => {
      this.resizeRecoveryRafId = requestAnimationFrame(() => {
        this.resizeRecoveryRafId = null;
        this.completeRecoveryVerification(allowHardRecovery);
      });
    });
  }

  private completeRecoveryVerification(allowHardRecovery: boolean): void {
    if (!this.diagram || !this.diagramDiv || this.isDestroyed) {
      return;
    }

    if (!this.isSafeDiagramSize(this.diagramDiv.clientWidth, this.diagramDiv.clientHeight)) {
      if (this.hardRecoveryInProgress) {
        this.hardRecoveryInProgress = false;
      }
      return;
    }

    if (this.hasVisibleDiagramContent()) {
      this.finishResizeRecovery();
      return;
    }

    if (allowHardRecovery && this.tryHardDiagramRecovery()) {
      return;
    }

    if (!allowHardRecovery && !this.recoveryFitFallbackUsed) {
      this.recoveryFitFallbackUsed = true;
      this.zoomService.fitToContents();
      this.diagram.requestUpdate();
      this.scheduleRecoveryVerification(false);
      return;
    }

    this.resizeRecoveryArmed = true;
    this.hardRecoveryInProgress = false;
    this.recoveryFitFallbackUsed = false;
    this.logger.warn('流程图在容器恢复后仍不可见，等待下一次恢复机会');
  }

  private teardownDiagramForRecovery(): void {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }

    this.suspendedResizeObserver = null;
    this.clearAllTimers();
    this.cleanupFontLoadListener();
    this.dropHandlerCleanup?.();
    this.dropHandlerCleanup = null;
    this.cancelIdleOverviewInit();
    this.overviewService.destroyOverview();
    this.overviewService.setDiagram(null);
    this.dataService.clearTimers();
    this.zoomService.cancelPendingViewStateSave();
    this.zoomService.setViewStatePersistenceGuard(null);

    if (!this.diagram) {
      return;
    }

    if (this.viewportBoundsHandler) {
      this.diagram.removeDiagramListener('ViewportBoundsChanged', this.viewportBoundsHandler);
      this.viewportBoundsHandler = null;
    }

    this.eventService.setDiagram(null);
    this.selectionService.setDiagram(null);
    this.layoutService.setDiagram(null);
    this.zoomService.setDiagram(null);

    this.diagram.clear();
    this.diagram.div = null;
    this.diagram = null;
  }

  private getPreferredRecoveryViewState(): ViewState | null {
    return this.normalizeViewState(this.lastStableViewState)
      ?? this.normalizeViewState(this.lastRecoverableViewState)
      ?? this.getCurrentViewStateSnapshot()
      ?? this.normalizeViewState(this.projectState.getViewState() as ViewState | null);
  }

  private getCurrentViewStateSnapshot(): ViewState | null {
    if (!this.diagram) {
      return null;
    }

    return this.normalizeViewState({
      scale: this.diagram.scale,
      positionX: this.diagram.position.x,
      positionY: this.diagram.position.y,
    });
  }

  private finishResizeRecovery(): void {
    if (!this.diagram || this.isDestroyed) {
      return;
    }

    this.attemptPendingOverviewRestore();
    this.overviewService.refreshOverview();
    this.resizeRecoveryArmed = false;
    this.hardRecoveryInProgress = false;
    this.hardRecoveryAttemptCount = 0;
    this.recoveryFitFallbackUsed = false;
    this.captureStableViewState();

    if (this.canPersistViewState()) {
      this.dataService.saveViewState();
    }
  }

  private updateDevicePixelRatio(): boolean {
    const nextRatio = this.getDevicePixelRatio();
    if (Math.abs(nextRatio - this.lastKnownDevicePixelRatio) < 0.001) {
      return false;
    }

    const previousRatio = this.lastKnownDevicePixelRatio;
    this.lastKnownDevicePixelRatio = nextRatio;
    this.logger.info('检测到设备像素比变化，触发流程图恢复', {
      previousRatio,
      nextRatio,
    });
    return true;
  }

  private getDevicePixelRatio(): number {
    if (typeof window === 'undefined') {
      return 1;
    }

    const ratio = window.devicePixelRatio;
    return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  }

  private restoreOverviewAfterRecovery(container: HTMLDivElement, retriesLeft: number = 3): void {
    this.zone.runOutsideAngular(() => {
      requestAnimationFrame(() => {
        if (this.isDestroyed || !this.shouldRestoreOverview) {
          return;
        }

        if (container.clientWidth <= 0 || container.clientHeight <= 0) {
          this.pendingOverviewRestore = true;
          if (retriesLeft > 0) {
            this.restoreOverviewAfterRecovery(container, retriesLeft - 1);
          }
          return;
        }

        this.pendingOverviewRestore = false;
        this.initializeOverview(container);
      });
    });
  }

  private attemptPendingOverviewRestore(): void {
    if (!this.pendingOverviewRestore || !this.shouldRestoreOverview || !this.overviewContainer) {
      return;
    }

    if (this.overviewService.isOverviewInitialized) {
      this.pendingOverviewRestore = false;
      return;
    }

    if (this.overviewContainer.clientWidth <= 0 || this.overviewContainer.clientHeight <= 0) {
      return;
    }

    this.pendingOverviewRestore = false;
    this.initializeOverview(this.overviewContainer);
  }

  private applyViewState(viewState: ViewState): void {
    if (!this.diagram) {
      return;
    }

    this.diagram.scale = viewState.scale;
    this.diagram.position = new go.Point(viewState.positionX, viewState.positionY);
  }

  private normalizeViewState(viewState: ViewState | null | undefined): ViewState | null {
    if (!viewState) {
      return null;
    }

    if (
      !Number.isFinite(viewState.scale) ||
      viewState.scale <= 0 ||
      viewState.scale > 4 ||
      !Number.isFinite(viewState.positionX) ||
      !Number.isFinite(viewState.positionY)
    ) {
      return null;
    }

    return {
      scale: viewState.scale,
      positionX: viewState.positionX,
      positionY: viewState.positionY,
    };
  }

  private canPersistViewState(): boolean {
    if (!this.diagram || this.resizeRecoveryArmed || this.hardRecoveryInProgress) {
      return false;
    }

    return this.isSafeDiagramSize(this.diagramDiv?.clientWidth ?? 0, this.diagramDiv?.clientHeight ?? 0)
      && Number.isFinite(this.diagram.scale)
      && this.diagram.scale > 0
      && Number.isFinite(this.diagram.position.x)
      && Number.isFinite(this.diagram.position.y);
  }

  private hasVisibleDiagramContent(): boolean {
    if (!this.diagram) {
      return false;
    }

    const viewportBounds = this.diagram.viewportBounds;
    if (!viewportBounds.isReal() || viewportBounds.width <= 0 || viewportBounds.height <= 0) {
      return false;
    }

    const nodeCount = this.getDiagramNodeCount();
    if (nodeCount === 0) {
      return true;
    }

    const documentBounds = this.diagram.documentBounds;
    if (!documentBounds.isReal() || documentBounds.width <= 0 || documentBounds.height <= 0) {
      return false;
    }

    return viewportBounds.intersectsRect(documentBounds);
  }

  private getDiagramNodeCount(): number {
    if (!this.diagram) {
      return 0;
    }

    const diagramWithNodes = this.diagram as go.Diagram & { nodes?: { count?: number } };
    return typeof diagramWithNodes.nodes?.count === 'number' ? diagramWithNodes.nodes.count : 0;
  }

  private isSafeDiagramSize(width: number, height: number): boolean {
    return width >= FlowDiagramService.MIN_SAFE_DIAGRAM_WIDTH
      && height >= FlowDiagramService.MIN_SAFE_DIAGRAM_HEIGHT;
  }
  
  private handleError(userMessage: string, error: unknown): void {
    const _errorStr = error instanceof Error ? error.message : String(error);
    this.logger.error(`❌ Flow diagram error: ${userMessage}`, error);
    this.error.set(userMessage);
    this.toast.error('流程图错误', `${userMessage}。请刷新页面重试。`);
  }

  /**
   * 获取当前流程图停泊快照（A5.2.5）
   * 用于 ContextRestoreService 保存 flow 视图状态
   */
  getFlowParkingSnapshot(): { scale: number; selectedNodeId: string | null } | null {
    if (!this.diagram || this.isDestroyed) return null;
    const scale = this.zoomService.getZoom();
    const selectedKeys = this.selectionService.getSelectedNodeKeys();
    return {
      scale,
      selectedNodeId: selectedKeys.length === 1 ? selectedKeys[0] : null,
    };
  }
}
