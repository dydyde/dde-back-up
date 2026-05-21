/** FlowOverviewService - 小地图初始化/销毁、自动缩放、视口同步、指针交互 */
import { Injectable, inject, NgZone } from '@angular/core';
import { LoggerService } from '../../../../services/logger.service';
import { ThemeService } from '../../../../services/theme.service';
import { FlowTemplateService } from './flow-template.service';
import { FlowLinkTemplateService } from './flow-link-template.service';
import { FlowDiagramConfigService } from './flow-diagram-config.service';
import * as go from 'gojs';

@Injectable({
  providedIn: 'root'
})
export class FlowOverviewService {
  private static readonly OVERVIEW_IDLE_UPDATE_DELAY_MS = 150;
  private static readonly OVERVIEW_DRAG_UPDATE_DELAY_MS = 0;
  private static readonly VIEWPORT_BINDINGS_DRAG_THROTTLE_MS = 16;
  private static readonly VIEWPORT_BINDINGS_IDLE_THROTTLE_MS = 96;

  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('FlowOverview');
  private readonly zone = inject(NgZone);
  private readonly themeService = inject(ThemeService);
  private readonly templateService = inject(FlowTemplateService);
  private readonly linkTemplateService = inject(FlowLinkTemplateService);
  private readonly configService = inject(FlowDiagramConfigService);

  // 外部注入
  private diagram: go.Diagram | null = null;
  // 小地图状态
  private overview: go.Overview | null = null;
  private overviewContainer: HTMLDivElement | null = null;
  private lastOverviewScale: number = 0.1;
  private isDestroyed = false;
  // 交互状态
  private isNodeDragging: boolean = false;
  private isOverviewInteracting: boolean = false;
  private isOverviewBoxDragging: boolean = false;
  /**
   * 【2026-05-11】记录当前 box 拖拽周期内用户是否实际产生过位移。
   * - press 时置 false；
   * - 实际触发 applyManualBoxDrag 且产生 doc 位移时置 true；
   * - release 走 resetOverviewInteractionState 时置 false。
   *
   * 用于 `updateScaleTowardTarget`：只有 dragging && hasMovement 时启用
   * smartLerp 平滑动画；否则 snap 到 target，避免 press/release 不动场景
   * 因 lerp 残差产生跳动。
   */
  private hasManualBoxMovement: boolean = false;
  private overviewBoxViewportBounds: go.Rect | null = null;
  private overviewReleaseViewportBounds: go.Rect | null = null;
  private overviewReleaseShouldAnchor = false;
  private overviewPostDragAnchorSuppressionBounds: go.Rect | null = null;
  private overviewSuppressNextViewportAnchor = false;
  private isApplyingOverviewViewportUpdate: boolean = false;
  private overviewUpdateQueuedWhileApplying: boolean = false;
  private overviewScheduleUpdate: ((source: 'viewport' | 'document') => void) | null = null;
  private overviewApplyUpdateNow: ((source: 'viewport' | 'document') => void) | null = null;
  private overviewScheduledUpdateRafId: number | null = null;
  private pendingOverviewUpdateSource: 'viewport' | 'document' | null = null;
  // 缓存与节流
  private overviewBoundsCache: string = '';
  private overviewFixedBounds: go.Rect | null = null;
  private overviewInteractionLastApplyAt = 0;
  private throttledUpdateBindingsTimer: ReturnType<typeof setTimeout> | null = null;
  private throttledUpdateBindingsPending = false;
  // DiagramListener 引用
  private overviewDocumentBoundsChangedHandler: ((e: go.DiagramEvent) => void) | null = null;
  private overviewViewportBoundsChangedHandler: ((e: go.DiagramEvent) => void) | null = null;
  // 视口轮询
  private overviewViewportPollRafId: number | null = null;
  private overviewViewportPollLastKey: string = '';
  private overviewResizeRefreshRafId: number | null = null;
  private overviewInteractionRefreshRafId: number | null = null;
  private overviewIdleUpdateDelayRestoreTimer: ReturnType<typeof setTimeout> | null = null;
  // ResizeObserver
  private overviewResizeObserver: ResizeObserver | null = null;
  // Pointer 事件清理
  private overviewPointerCleanup: (() => void) | null = null;
  // 2026-05-15 A1 根因修复：Diagram 就绪门控
  // 在 documentBounds.isReal() 之前绝不绑定 observed，避免 GoJS 内部
  // ResizeObserver / AnimationManager 异步 tick 读到 null bounds 抛
  // `_getOriginRect: Cannot read properties of null (reading 'width')`。
  private overviewPendingInitialLayoutHandler: ((e: go.DiagramEvent) => void) | null = null;
  // 2026-05-15 A4：全局自愈钩子。GlobalErrorHandler 命中 SILENT 噪声后会调用，
  // 触发一次 overview.requestUpdate() 让下一帧用真实 documentBounds 重新 measure。
  private overviewHealHookInstalled = false;

  get overviewInstance(): go.Overview | null {
    return this.overview;
  }
  
  get isOverviewInitialized(): boolean {
    return this.overview !== null && !this.isDestroyed;
  }

  /** 设置关联的主图实例 */
  setDiagram(diagram: go.Diagram | null): void {
    this.diagram = diagram;
  }
  
  /** 设置节点拖拽状态（用于节流控制） */
  setNodeDragging(isDragging: boolean): void {
    this.isNodeDragging = isDragging;
  }

  /** 初始化小地图 */
  initializeOverview(container: HTMLDivElement, isMobile: boolean = false): void {
    // 重置销毁标记，允许重新初始化（FlowOverviewService 是全局单例，
    // 移动端切换视图会销毁/重建 FlowViewComponent，需要重置状态）
    this.isDestroyed = false;

    if (!this.diagram) {
      this.logger.warn('无法初始化 Overview：主图未就绪');
      return;
    }
    
    this.zone.runOutsideAngular(() => {
      try {
        this.cleanupOverview();
        
        const containerWidth = container.clientWidth;
        const containerHeight = container.clientHeight;
        
        if (containerWidth <= 0 || containerHeight <= 0) {
          this.logger.warn('Overview 容器尺寸无效，延迟初始化');
          return;
        }
        
        this.overviewContainer = container;
        
        // 设置背景色和显示质量优化
        container.style.backgroundColor = this.getOverviewBackgroundColor();

        // 【2026-05-15 性能修复 P2】移除 `image-rendering: -webkit-optimize-contrast`
        // / `crisp-edges` 的强制设置。该属性在 Chromium 上会让小地图 canvas 走
        // 像素化采样路径（关闭 GPU 双线性过滤），在 DPR≥2 + 高分辨率场景下显著
        // 增加单帧 paint 成本，并可能回退到 CPU 软合成 —— 这是拖动小地图预览框
        // 出现「卡顿 + 拖尾」的另一主因。
        //
        // 现仅显式声明 `auto`，让 GPU 走默认双线性合成。视觉锐度差异在 DPR≥2 下
        // 肉眼不可分辨（GoJS 已经按 DPR 渲染，且 P3 还会把 computePixelRatio 限到 2x）。
        container.style.imageRendering = 'auto';
        
        // 提升抗锯齿效果（非标准 vendor-prefixed 属性）
        const vendorStyle = container.style as CSSStyleDeclaration & Record<string, string>;
        vendorStyle['webkitFontSmoothing'] = 'antialiased';
        vendorStyle['mozOsxFontSmoothing'] = 'grayscale';

        // 创建 Overview 实例
        // 【2026-05-10 根因修复】显式关闭 autoScale（默认是 AutoScale.Uniform）。
        //
        // 真正的根因：GoJS Overview 构造函数会执行 `this.autoScale = 2`
        // (= AutoScale.Uniform)。从 GoJS 文档：
        //   "When autoScale is set to a non-AutoScale.None value, ...
        //    setting `scale` will do nothing."
        // 这条规则同样适用于 `centerRect()`（其本质是基于当前 scale 设置 position），
        // 因为 autoScale=Uniform 会在每次 render 时把 documentBounds（=我们设置的
        // `fixedBounds = worldBounds = nodeBounds ∪ viewportBounds extended`）
        // 自动适配并居中到 canvas，覆盖我们显式调用的 scale 与 centerRect。
        //
        // 这意味着此前所有 `applyOverviewUpdate` 中的
        //   - `this.overview.scale = clampScale(smoothedScale)`
        //   - `this.overview.centerRect(viewportBounds)`
        // 都是 **静默 no-op**，真正决定 box 与节点相对位置的是 `worldBounds.center`，
        // 而不是我们期望的 `viewportBounds.center`。
        //
        // 当 viewport 落在节点群内或节点群在 viewport 一侧延展时，
        // `worldBounds.center ≠ viewportBounds.center`，导致：
        //   - 拖拽中：fakeViewportBounds 每帧更新 → fixedBounds 每帧更新 →
        //     autoScale 顺势平滑跟手（视觉上"看起来对"，但其实是巧合）。
        //   - 松手后：进入 deferred bindings 路径，连续多次 render 用同一份
        //     fixedBounds，autoScale 仍以 worldBounds.center 居中 → box 跳到
        //     worldBounds.center 方向；用户看到"缩略块跳动且与主视图脱节"。
        //   - 点击不动：press/release 各触发一次 apply，fixedBounds 在两个路径
        //     之间因 padding/buffer 计算波动产生极微差异，autoScale 重适配 →
        //     按下与松开各跳一次。
        //
        // 历史归因（2026-05-09 注释）把元凶认作 `contentAlignment: Spot.Center`
        // 并将其移除是治标不治本：contentAlignment 仅在 autoScale=None 时生效，
        // 在 autoScale=Uniform 下早就被忽略。真正驱动"重居中"的是 autoScale。
        //
        // 修复：显式 `autoScale: AutoScale.None`，让本服务里完整的手动控制
        // 体系（setOverviewFixedBounds + scale 平滑插值 + centerRect(viewportBounds)
        // + 稳定 view→doc 映射）真正生效，把视觉锚点恒定锁在 viewportBounds.center，
        // 消除 drag/release/idle 三态切换时的"重居中跳变"。
        //
        // 兼容性：spec mock 在 `Object.assign(this, options)` 时仅赋值不处理
        // autoScale 行为，因此现有断言（centerRect 调用次数与参数）保持成立；
        // 已新增 `AutoScale.None` 到 mock 与 ts 类型扩展。
        // 2026-05-15 A1 根因修复：构造时不绑定 observed。
        //
        // 原行为：`new go.Overview(container, { observed: this.diagram, ... })`
        // 会让 GoJS 立即在内部 ResizeObserver / AnimationManager 中持有 diagram
        // 引用并安排首次 tick。如果此时 diagram.documentBounds 是 NaN/0
        // （Diagram 切换、@defer 懒加载、布局首帧），异步 tick 会从
        // `_getOriginRect → transformViewToDoc` 读 documentBounds=null 抛
        // `Cannot read properties of null (reading 'width')`。上层守卫无法
        // 拦截 GoJS 内部异步路径。
        //
        // 修复：构造时显式 `observed: null`，再走 `bindObservedWhenReady` 等
        // documentBounds.isReal() 后再绑定；未就绪期间用 InitialLayoutCompleted
        // 监听器延后到首次布局结束。
        this.overview = new go.Overview(container, {
          'animationManager.isEnabled': false,
          autoScale: go.AutoScale.None,
          // 禁用 Overview 内建 click/drag 交互，避免和手动 box 拖拽竞争。
          isEnabled: false,
          // 【2026-05-15 性能修复 P3】把 `computePixelRatio` 从 `max(DPR, 2)` 改为
          // `min(DPR, 2)`：
          //   - 1x 屏（外接显示器、低 DPI Windows）此前被强制 2x，单帧 paint 像素 4 倍；
          //   - 3x 屏（手机/部分 Retina）此前是 3x，限到 2x 后 paint 减半；
          //   - 视觉锐度差异在小地图这种工具面板尺寸下肉眼不可分辨。
          // 与 P2 联动消除小地图 canvas 单帧 paint 的非必要开销。
          'computePixelRatio': () => Math.min(window.devicePixelRatio || 1, 2)
        });

        // 设置模板
        this.templateService.setupOverviewNodeTemplate(this.overview);
        this.linkTemplateService.setupOverviewLinkTemplate(this.overview);

        // 2026-05-15 A1：门控后绑定 observed。如果 diagram 已就绪，
        // 这里同步完成；否则 listener 会在首次布局完成时回填。
        this.bindObservedWhenReady();

        // 设置视口框样式
        this.templateService.setupOverviewBoxStyle(this.overview, isMobile);

        this.overview.scale = 0.15;
        this.lastOverviewScale = 0.15;

        // 绑定指针监听
        this.attachOverviewPointerListeners(container);

        // 设置自动缩放
        this.setupOverviewAutoScale();

        // 设置 ResizeObserver
        this.setupOverviewResizeObserver(container);

        // 强制刷新
        if (this.diagram) {
          this.diagram.requestUpdate();
        }
        if (this.overview) {
          this.overview.requestUpdate();
        }

        // 2026-05-15 A4：注册全局自愈钩子。GlobalErrorHandler 命中
        // `_getOriginRect` SILENT 噪声后会调用，触发一次 requestUpdate 自愈。
        this.installOverviewHealHook();

        this.logger.info(`Overview 初始化成功`);
      } catch (error) {
        this.logger.error('Overview 初始化失败:', error);
      }
    });
  }
  
  /** 销毁小地图 */
  destroyOverview(): void {
    this.cleanupOverview();
    this.isDestroyed = true;
  }
  /** 刷新小地图 */
  refreshOverview(): void {
    if (!this.overview || !this.overviewContainer || this.isDestroyed) return;
    
    try {
      this.overview.requestUpdate();
      
      const containerWidth = this.overviewContainer.clientWidth;
      const containerHeight = this.overviewContainer.clientHeight;
      
      if (containerWidth > 0 && containerHeight > 0 && this.diagram) {
        const docBounds = this.diagram.documentBounds;
        if (docBounds.isReal() && docBounds.width > 0 && docBounds.height > 0) {
          const padding = 0.1;
          const scaleX = (containerWidth * (1 - padding * 2)) / docBounds.width;
          const scaleY = (containerHeight * (1 - padding * 2)) / docBounds.height;
          const newScale = Math.max(0.02, Math.min(0.5, Math.min(scaleX, scaleY)));
          this.overview.scale = newScale;
          this.lastOverviewScale = newScale;
          // 【2026-05-09 根因修复配套】移除 contentAlignment: Spot.Center 后，
          // 必须由我们自己保持容器内的居中。resize 改变 scale 会让上一次
          // centerRect 设置的 position 失真，这里以当前主图视口锚点重新居中，
          // 与 applyOverviewUpdate 路径保持同一锚点（viewportBounds），避免
          // resize 时出现新的"模式切换"型跳变。
          const vb = this.diagram.viewportBounds;
          if (vb.isReal()) {
            this.overview.centerRect(vb);
          } else {
            this.overview.centerRect(docBounds);
          }
          this.logger.debug(`Overview 已刷新 - scale: ${newScale}`);
        }
      }
    } catch (error) {
      this.logger.error('刷新 Overview 失败:', error);
    }
  }
  
  /** 更新主题相关样式 */
  updateTheme(): void {
    if (!this.overview || !this.overviewContainer) return;
    
    this.overview.updateAllTargetBindings();
    this.overviewContainer.style.backgroundColor = this.getOverviewBackgroundColor();
  }

  private cleanupOverview(): void {
    // 2026-05-15 A2 根因修复：销毁顺序必须先停 animation 再解绑 listener，
    // 最后 observed = null → div = null。原顺序仅 `div = null` + `overview = null`
    // 会让 GoJS 内部 AnimationManager.animations / ResizeObserver 在下一帧
    // 仍持有 stale overview 引用，调用 `_getOriginRect` 抛 null.width 错误。
    //
    // 正确顺序：
    //   1) 先停 animation，避免下一帧 tick
    //   2) 清理我们注册的所有 DiagramListener（包含 pending bind handler）
    //   3) observed = null，断开 GoJS 内部对 diagram 的反向引用
    //   4) div = null，触发 GoJS 内部 ResizeObserver 解绑
    //   5) overview = null

    // 1) 先停动画
    if (this.overview) {
      try {
        const overviewAny = this.overview as unknown as {
          animationManager?: { stopAnimation?: () => void };
        };
        overviewAny.animationManager?.stopAnimation?.();
      } catch {
        // GoJS 内部状态异常时 stopAnimation 可能抛错，吞掉避免阻塞清理链路
      }
    }

    // 2a) 清理 pending bind handler（在主 listener 清理前，避免 diagram 被置 null 后丢监听器引用）
    this.removePendingInitialLayoutHandler();

    // 2b) 清理 Pointer 监听
    if (this.overviewPointerCleanup) {
      this.overviewPointerCleanup();
      this.overviewPointerCleanup = null;
    }
    
    // 2c) 清理 ResizeObserver（我们的 container 监听，不是 GoJS 内部的）
    if (this.overviewResizeObserver) {
      this.overviewResizeObserver.disconnect();
      this.overviewResizeObserver = null;
    }
    
    // 2d) 移除 DiagramListener
    if (this.diagram) {
      if (this.overviewDocumentBoundsChangedHandler) {
        this.diagram.removeDiagramListener('DocumentBoundsChanged', this.overviewDocumentBoundsChangedHandler);
        this.overviewDocumentBoundsChangedHandler = null;
      }
      if (this.overviewViewportBoundsChangedHandler) {
        this.diagram.removeDiagramListener('ViewportBoundsChanged', this.overviewViewportBoundsChangedHandler);
        this.overviewViewportBoundsChangedHandler = null;
      }
    }
    
    // 2e) 取消所有 rAF。审计完成：所有 rAF id 均在此一次性 cancel，
    // 销毁后即使有未完成的 rAF 回调，回调内部的 `if (this.isDestroyed || !this.overview) return`
    // 也会兜底 no-op，杜绝异步 tick 持有 stale 引用。
    if (this.overviewViewportPollRafId !== null) {
      cancelAnimationFrame(this.overviewViewportPollRafId);
      this.overviewViewportPollRafId = null;
    }
    if (this.overviewResizeRefreshRafId !== null) {
      cancelAnimationFrame(this.overviewResizeRefreshRafId);
      this.overviewResizeRefreshRafId = null;
    }
    if (this.overviewInteractionRefreshRafId !== null) {
      cancelAnimationFrame(this.overviewInteractionRefreshRafId);
      this.overviewInteractionRefreshRafId = null;
    }
    if (this.overviewScheduledUpdateRafId !== null) {
      cancelAnimationFrame(this.overviewScheduledUpdateRafId);
      this.overviewScheduledUpdateRafId = null;
    }
    
    // 清理节流定时器
    if (this.throttledUpdateBindingsTimer) {
      clearTimeout(this.throttledUpdateBindingsTimer);
      this.throttledUpdateBindingsTimer = null;
    }
    if (this.overviewIdleUpdateDelayRestoreTimer) {
      clearTimeout(this.overviewIdleUpdateDelayRestoreTimer);
      this.overviewIdleUpdateDelayRestoreTimer = null;
    }
    this.isOverviewInteracting = false;
    this.isOverviewBoxDragging = false;
    this.overviewBoxViewportBounds = null;
    this.overviewReleaseViewportBounds = null;
    this.overviewReleaseShouldAnchor = false;
    this.overviewPostDragAnchorSuppressionBounds = null;
    this.overviewSuppressNextViewportAnchor = false;
    this.isApplyingOverviewViewportUpdate = false;
    this.overviewUpdateQueuedWhileApplying = false;
    this.overviewInteractionLastApplyAt = 0;
    this.throttledUpdateBindingsPending = false;
    this.pendingOverviewUpdateSource = null;

    // 移除全局自愈钩子（必须在 overview 置 null 之前，否则 hook 内部判 null 即可，
    // 但保持显式 remove 更直观）
    this.removeOverviewHealHook();

    // 3 + 4 + 5) 断开 observed → div → 置 null
    if (this.overview) {
      try {
        this.overview.observed = null;
      } catch {
        // ignore
      }
      this.overview.div = null;
      this.overview = null;
    }
    
    this.overviewContainer = null;
    this.overviewBoundsCache = '';
    this.overviewFixedBounds = null;
    this.overviewScheduleUpdate = null;
    this.overviewApplyUpdateNow = null;
  }
  
  private getOverviewBackgroundColor(): string {
    const isDark = this.themeService.isDark();
    if (isDark) {
      return '#1f1f1f';
    } else {
      const styles = this.configService.currentStyles();
      return this.readCssColorVar('--theme-text-dark') ?? styles.text.titleColor ?? '#292524';
    }
  }
  
  private readCssColorVar(varName: string): string | null {
    try {
      if (typeof window === 'undefined' || typeof document === 'undefined') return null;
      const value = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
      return value || null;
    } catch {
      // eslint-disable-next-line no-restricted-syntax -- 返回 null 语义正确：CSS 变量读取失败使用默认值
      return null;
    }
  }

  private setOverviewUpdateDelay(delayMs: number): void {
    if (!this.overview) return;
    this.overview.updateDelay = delayMs;
  }

  private scheduleOverviewIdleUpdateDelayRestore(): void {
    if (this.overviewIdleUpdateDelayRestoreTimer) {
      clearTimeout(this.overviewIdleUpdateDelayRestoreTimer);
    }
    this.overviewIdleUpdateDelayRestoreTimer = setTimeout(() => {
      this.overviewIdleUpdateDelayRestoreTimer = null;
      if (this.isDestroyed || !this.overview || this.isOverviewBoxDragging || this.isOverviewInteracting) return;
      this.setOverviewUpdateDelay(FlowOverviewService.OVERVIEW_IDLE_UPDATE_DELAY_MS);
    }, FlowOverviewService.OVERVIEW_IDLE_UPDATE_DELAY_MS);
  }

  private syncOverviewBoxToViewport(viewportBounds: go.Rect): void {
    if (!this.overview || !viewportBounds.isReal()) return;
    const box = this.overview.box;
    if (!box) return;
    const nextPosition = new go.Point(viewportBounds.x, viewportBounds.y);
    if (!box.position.equals(nextPosition)) {
      box.position = nextPosition;
    }
  }
  
  private setupOverviewResizeObserver(container: HTMLDivElement): void {
    this.overviewResizeObserver = new ResizeObserver(() => {
      if (this.overviewResizeRefreshRafId !== null) {
        cancelAnimationFrame(this.overviewResizeRefreshRafId);
      }
      this.overviewResizeRefreshRafId = window.requestAnimationFrame(() => {
        this.overviewResizeRefreshRafId = null;
        if (this.isDestroyed || !this.overview) return;
        this.refreshOverview();
      });
    });
    this.overviewResizeObserver.observe(container);
  }
  
  /** 设置小地图自动缩放 */
  private setupOverviewAutoScale(): void {
    if (!this.diagram || !this.overview) return;
    
    // 使用 documentBounds（O(1)）替代遍历节点
    const getNodesBounds = (): go.Rect => {
      if (!this.diagram) return new go.Rect(0, 0, 500, 500);
      
      const docBounds = this.diagram.documentBounds;
      if (!docBounds.isReal() || (docBounds.width === 0 && docBounds.height === 0)) {
        return new go.Rect(-250, -250, 500, 500);
      }
      
      const padding = 80;
      return new go.Rect(
        docBounds.x - padding,
        docBounds.y - padding,
        docBounds.width + padding * 2,
        docBounds.height + padding * 2
      );
    };
    
    const calculateBaseScale = (): number => {
      if (!this.overviewContainer || !this.diagram) return 0.15;
      
      const containerWidth = this.overviewContainer.clientWidth;
      const containerHeight = this.overviewContainer.clientHeight;
      const nodeBounds = getNodesBounds();
      
      if (containerWidth <= 0 || containerHeight <= 0) return 0.15;
      
      const padding = 0.1;
      const scaleX = (containerWidth * (1 - padding * 2)) / nodeBounds.width;
      const scaleY = (containerHeight * (1 - padding * 2)) / nodeBounds.height;
      
      return Math.min(scaleX, scaleY, 0.35);
    };

    const clampScale = (scale: number): number => {
      return Math.max(1e-4, Math.min(0.5, scale));
    };
    

    /**
     * 【2026-05-11 根因修复】scale 更新策略：仅在「真正发生持续 box 拖拽位移」时
     * 才用 smartLerp 平滑动画；其它所有路径（idle、按下不动、松开、release 同步）
     * 一律直接 snap 到 target。
     *
     * 真正的根因：`smartLerp` 是异步收敛函数（每帧 18%/45% 向 target 推进），
     * 而 IF 守卫 `|target - current| > 0.002` 意味着 scale 永远停在 "距离 target
     * ≤ 0.002 的某个值"。每次离散事件（pointerdown / pointerup / 来自外部的
     * ViewportBoundsChanged）触发 apply 都会让 smartLerp 再推进一步，引发节点
     * 与 overview.box 在 canvas 上的像素级位移（位置 = (docPos - position) × scale，
     * scale 变化时全画面重新映射），叠加 `scrollMode: Document` 对 centerRect
     * 的钳制，呈现为"按下/松开瞬间缩略块跃动且与主视图脱节"。
     *
     * 修复：用 `updateScaleTowardTarget` 替换所有 smartLerp 直接调用：
     *   - 主动拖拽 box **且**实际产生过位移（hasManualBoxMovement === true）
     *     → 保留 smartLerp 平滑感（与历史 18%/45% 行为一致）；
     *   - 其它所有路径 → snap 到 target，使 apply 对稳定输入幂等：相同
     *     viewportBounds + 相同 nodeBounds/container ⇒ 相同 target ⇒ 不再变化。
     *
     * 影响面：
     *   1) 点击不动（press → release）：两次 apply 都 snap 到同一 target，
     *      scale 不变 ⇒ centerRect 输入相同 ⇒ overview.position 不变 ⇒ 0 跳动。
     *   2) 真实拖拽（press → 多次 move → release）：press apply 走 snap
     *      （hasManualBoxMovement=false），后续 move apply 走 smartLerp，release
     *      apply 已被 resetOverviewInteractionState 置回 false，走 snap。
     *   3) 外部 idle ViewportBoundsChanged：snap，使 scale 在一次 apply 内即
     *      收敛于 target，无残差。
     *
     * 因此 idle 期保持 scale === target，press apply 自然 no-op（target 未变）。
     */
    const updateScaleTowardTarget = (current: number, target: number, smoothStep: boolean): number => {
      if (!smoothStep) {
        return target;
      }

      const maxStep = current * 0.12;
      const delta = target - current;
      if (Math.abs(delta) <= Math.max(0.0001, current * 0.015)) {
        return target;
      }

      const step = Math.min(Math.abs(delta), maxStep);
      return current + Math.sign(delta) * step;
    };
    
    let baseScale = calculateBaseScale();
    let lastNodeDataCount = ((this.diagram.model as go.Model & { nodeDataArray?: go.ObjectData[] })?.nodeDataArray?.length ?? 0);
    this.lastOverviewScale = clampScale(baseScale);
    this.overview.scale = this.lastOverviewScale;
    
    const nodeBounds = getNodesBounds();
    this.overview.centerRect(nodeBounds);
    
    // 动态扩展边界（无限画布核心）
    const viewportBoundsAlmostEqual = (left: go.Rect, right: go.Rect): boolean => {
      const epsilon = 1;
      return Math.abs(left.x - right.x) < epsilon
        && Math.abs(left.y - right.y) < epsilon
        && Math.abs(left.width - right.width) < epsilon
        && Math.abs(left.height - right.height) < epsilon;
    };

    const viewportPositionAlmostEqual = (left: go.Rect, right: go.Rect): boolean => {
      const epsilon = 1;
      return Math.abs(left.x - right.x) < epsilon
        && Math.abs(left.y - right.y) < epsilon;
    };

    const calculateExtendedBounds = (baseBounds: go.Rect, viewportBounds: go.Rect): go.Rect => {
      const overflowLeft = Math.max(0, baseBounds.x - viewportBounds.x);
      const overflowRight = Math.max(0, viewportBounds.right - baseBounds.right);
      const overflowTop = Math.max(0, baseBounds.y - viewportBounds.y);
      const overflowBottom = Math.max(0, viewportBounds.bottom - baseBounds.bottom);

      const containerW = this.overviewContainer?.clientWidth ?? 200;
      const containerH = this.overviewContainer?.clientHeight ?? 150;
      const dynamicBufferW = Math.max(400, containerW * 0.3);
      const dynamicBufferH = Math.max(400, containerH * 0.3);
      const overflowBufferLeft = overflowLeft > 0 ? dynamicBufferW : 0;
      const overflowBufferRight = overflowRight > 0 ? dynamicBufferW : 0;
      const overflowBufferTop = overflowTop > 0 ? dynamicBufferH : 0;
      const overflowBufferBottom = overflowBottom > 0 ? dynamicBufferH : 0;

      const extended = new go.Rect(
        baseBounds.x - overflowLeft - overflowBufferLeft,
        baseBounds.y - overflowTop - overflowBufferTop,
        baseBounds.width + overflowLeft + overflowRight + overflowBufferLeft + overflowBufferRight,
        baseBounds.height + overflowTop + overflowBottom + overflowBufferTop + overflowBufferBottom
      );
      
      const minWidth = viewportBounds.width + dynamicBufferW;
      if (extended.width < minWidth) {
        const pad = (minWidth - extended.width) / 2;
        extended.x -= pad;
        extended.width = minWidth;
      }
      
      const minHeight = viewportBounds.height + dynamicBufferH;
      if (extended.height < minHeight) {
        const pad = (minHeight - extended.height) / 2;
        extended.y -= pad;
        extended.height = minHeight;
      }

      return extended;
    };

    const ensureViewportEdgeBuffer = (
      bounds: go.Rect,
      viewportBounds: go.Rect,
      mode: 'default' | 'passive-pan' = 'default',
    ): go.Rect => {
      const containerW = this.overviewContainer?.clientWidth ?? 200;
      const containerH = this.overviewContainer?.clientHeight ?? 150;
      // 【2026-05-20 生产复发修复 - 主图持续 pan 残影】
      // 默认 buffer ~400 world-px：用户持续拖动主图时只要每次 pan 越过 fixedBounds
      // ~400px 就触发一次 setOverviewFixedBounds → GoJS Overview remeasure 所有节点
      // → 缩略任务块全量重映射 → 视觉上呈现"快速移动残影"。
      // 在 isPassiveObservedViewportUpdate 进入此路径时使用 passive-pan 模式：
      // 用 viewport 自身尺寸（再带 1x 余量）作为最小 buffer，让一次扩边后
      // 至少能覆盖再走一个完整 viewport 的连续 pan，从而把 setOverviewFixedBounds
      // 频率从"每帧"降到"每过一整屏才一次"。
      // 注意：scale 自适应链路（smoothManualScale / 远拖缩小 / 拖回放大）只在
      // usingFakeViewportBounds && hasManualBoxMovement 时启用，不依赖此 buffer，
      // 所以这里放大 buffer 不会影响 box drag 的远拖语义。
      const baseBufferW = Math.max(400, containerW * 0.3);
      const baseBufferH = Math.max(400, containerH * 0.3);
      const bufferW = mode === 'passive-pan'
        ? Math.max(baseBufferW, viewportBounds.width)
        : baseBufferW;
      const bufferH = mode === 'passive-pan'
        ? Math.max(baseBufferH, viewportBounds.height)
        : baseBufferH;
      const buffered = bounds.copy();

      const leftGap = viewportBounds.x - buffered.x;
      if (leftGap < bufferW) {
        const expandLeft = bufferW - leftGap;
        buffered.x -= expandLeft;
        buffered.width += expandLeft;
      }

      const rightGap = buffered.right - viewportBounds.right;
      if (rightGap < bufferW) {
        buffered.width += bufferW - rightGap;
      }

      const topGap = viewportBounds.y - buffered.y;
      if (topGap < bufferH) {
        const expandTop = bufferH - topGap;
        buffered.y -= expandTop;
        buffered.height += expandTop;
      }

      const bottomGap = buffered.bottom - viewportBounds.bottom;
      if (bottomGap < bufferH) {
        buffered.height += bufferH - bottomGap;
      }

      return buffered;
    };

    const viewportFitsInsideStableBounds = (bounds: go.Rect, viewportBounds: go.Rect): boolean => {
      if (!bounds.isReal() || !viewportBounds.isReal()) return false;
      const margin = Math.max(120, Math.min(viewportBounds.width, viewportBounds.height) * 0.2);
      if (bounds.width <= viewportBounds.width + margin * 2 || bounds.height <= viewportBounds.height + margin * 2) {
        return false;
      }
      return viewportBounds.x >= bounds.x + margin
        && viewportBounds.y >= bounds.y + margin
        && viewportBounds.right <= bounds.right - margin
        && viewportBounds.bottom <= bounds.bottom - margin;
    };

    const viewportIsInsideBounds = (bounds: go.Rect, viewportBounds: go.Rect): boolean => {
      if (!bounds.isReal() || !viewportBounds.isReal()) return false;
      const epsilon = 1;
      return viewportBounds.x >= bounds.x - epsilon
        && viewportBounds.y >= bounds.y - epsilon
        && viewportBounds.right <= bounds.right + epsilon
        && viewportBounds.bottom <= bounds.bottom + epsilon;
    };

    const resolveWorldBoundsForViewport = (
      candidateBounds: go.Rect,
      viewportBounds: go.Rect,
      preferStableBounds: boolean,
      reuseWhenInsideBounds = false,
    ): { bounds: go.Rect; reusedStableBounds: boolean } => {
      const currentBounds = this.overviewFixedBounds;
      if (!preferStableBounds || !currentBounds?.isReal()) {
        return { bounds: candidateBounds, reusedStableBounds: false };
      }

      const canReuseCurrentBounds = reuseWhenInsideBounds
        ? viewportIsInsideBounds(currentBounds, viewportBounds)
        : viewportFitsInsideStableBounds(currentBounds, viewportBounds);
      if (canReuseCurrentBounds) {
        return { bounds: currentBounds, reusedStableBounds: true };
      }

      return { bounds: currentBounds.copy().unionRect(candidateBounds), reusedStableBounds: false };
    };

    let lastBindingsUpdateMode: 'immediate' | 'deferred' | null = null;

    const cancelPendingViewportBindingsRefresh = (): void => {
      if (this.throttledUpdateBindingsTimer) {
        clearTimeout(this.throttledUpdateBindingsTimer);
        this.throttledUpdateBindingsTimer = null;
      }
      this.throttledUpdateBindingsPending = false;
      lastBindingsUpdateMode = null;
    };

    const cancelPendingOverviewInteractionRefresh = (): void => {
      if (this.overviewInteractionRefreshRafId !== null) {
        cancelAnimationFrame(this.overviewInteractionRefreshRafId);
        this.overviewInteractionRefreshRafId = null;
      }
    };

    const clearStaleReleaseViewportForObservedPan = (): void => {
      if (this.isOverviewBoxDragging || this.isOverviewInteracting || !this.overviewReleaseViewportBounds || !this.diagram) {
        return;
      }

      const observedViewportBounds = this.diagram.viewportBounds;
      if (!observedViewportBounds.isReal() || viewportPositionAlmostEqual(observedViewportBounds, this.overviewReleaseViewportBounds)) {
        return;
      }

      const currentPosition = this.diagram.position;
      const diagramHasMovedAway = !currentPosition
        || !Number.isFinite(currentPosition.x)
        || !Number.isFinite(currentPosition.y)
        || Math.abs(currentPosition.x - this.overviewReleaseViewportBounds.x) > 1
        || Math.abs(currentPosition.y - this.overviewReleaseViewportBounds.y) > 1;

      const observedHasCaughtUpToDiagramPosition = !!currentPosition
        && Number.isFinite(currentPosition.x)
        && Number.isFinite(currentPosition.y)
        && Math.abs(observedViewportBounds.x - currentPosition.x) < 1
        && Math.abs(observedViewportBounds.y - currentPosition.y) < 1;

      if (!diagramHasMovedAway && !observedHasCaughtUpToDiagramPosition) {
        return;
      }

      this.overviewReleaseViewportBounds = null;
      this.overviewReleaseShouldAnchor = false;
      this.overviewPostDragAnchorSuppressionBounds = null;
      this.overviewSuppressNextViewportAnchor = false;
      cancelPendingOverviewInteractionRefresh();
      cancelPendingViewportBindingsRefresh();
    };

    // 节流绑定更新
    const scheduleViewportBindingsUpdate = (mode: 'immediate' | 'deferred'): void => {
      if (!this.overview) return;

      if (mode === 'immediate') {
        if (this.throttledUpdateBindingsPending && lastBindingsUpdateMode === 'immediate') {
          return;
        }

        if (this.throttledUpdateBindingsTimer) {
          clearTimeout(this.throttledUpdateBindingsTimer);
          this.throttledUpdateBindingsTimer = null;
        }

        this.throttledUpdateBindingsPending = true;
        lastBindingsUpdateMode = 'immediate';
        this.overview.updateAllTargetBindings();
        this.overview.requestUpdate();
        this.throttledUpdateBindingsTimer = setTimeout(() => {
          this.throttledUpdateBindingsPending = false;
          this.throttledUpdateBindingsTimer = null;
          lastBindingsUpdateMode = null;
        }, FlowOverviewService.VIEWPORT_BINDINGS_DRAG_THROTTLE_MS);
        return;
      }

      if (this.throttledUpdateBindingsPending) {
        return;
      }

      this.throttledUpdateBindingsPending = true;
      lastBindingsUpdateMode = 'deferred';
      this.throttledUpdateBindingsTimer = setTimeout(() => {
        if (!this.overview) {
          this.throttledUpdateBindingsPending = false;
          this.throttledUpdateBindingsTimer = null;
          lastBindingsUpdateMode = null;
          return;
        }

        this.overview.updateAllTargetBindings();
        this.overview.requestUpdate();
        this.throttledUpdateBindingsPending = false;
        this.throttledUpdateBindingsTimer = null;
        lastBindingsUpdateMode = null;
      }, FlowOverviewService.VIEWPORT_BINDINGS_IDLE_THROTTLE_MS);
    };

    // 核心更新逻辑
    const applyOverviewUpdate = (source: 'viewport' | 'document'): void => {
      if (this.isApplyingOverviewViewportUpdate) {
        this.overviewUpdateQueuedWhileApplying = true;
        return;
      }
      
      this.isApplyingOverviewViewportUpdate = true;
      
      try {
        if (!this.diagram || !this.overview) return;

        // 【2026-04-20 精准回归修复】Sprint 5 清理（commit 6cbb7c6）只误删了
        // 对 overviewBoxViewportBounds 的赋值写入，导致 fakeViewportBounds 永远为 null，
        // usingFakeViewportBounds=false，拖动时只能拿到实时 diagram.viewportBounds，
        // 时序上滞后一帧且没能驱动原有 lerp + setOverviewFixedBounds 的缩放逻辑。
        // 修复：在 beginManualBoxDrag / applyManualBoxDrag 中按「box.actualBounds.center
        // + diagram.viewportBounds 尺寸」写入 overviewBoxViewportBounds。其它逻辑不动，
        // 原有 smartLerp (18%/45%) + setOverviewFixedBounds 就能像回归前那样平滑工作，
        // task blocks 保持可见、随 box 拖动相对位移，不会跳到亚像素尺寸。
        const fakeViewportBounds = this.overviewBoxViewportBounds;
        const releaseViewportBounds = this.overviewReleaseViewportBounds;
        const usingFakeViewportBounds = !!(this.isOverviewBoxDragging && fakeViewportBounds && fakeViewportBounds.isReal());
        const usingReleaseViewportBounds = !!(!this.isOverviewBoxDragging && releaseViewportBounds && releaseViewportBounds.isReal());
        const usingManualViewportBounds = usingFakeViewportBounds || usingReleaseViewportBounds;
        const viewportBounds: go.Rect = usingFakeViewportBounds
          ? fakeViewportBounds
          : usingReleaseViewportBounds
            ? releaseViewportBounds
            : this.diagram.viewportBounds;
        if (!viewportBounds.isReal()) {
          if (usingReleaseViewportBounds) {
            this.overviewReleaseViewportBounds = null;
          }
          return;
        }

        const pendingSuppressionBounds = this.overviewPostDragAnchorSuppressionBounds;
        const shouldSuppressNextViewportAnchor = source === 'viewport'
          && !usingManualViewportBounds
          && this.overviewSuppressNextViewportAnchor
          && !!pendingSuppressionBounds?.isReal()
          && viewportPositionAlmostEqual(viewportBounds, pendingSuppressionBounds);
        if (this.overviewSuppressNextViewportAnchor) {
          this.overviewSuppressNextViewportAnchor = false;
          if (!shouldSuppressNextViewportAnchor) {
            this.overviewPostDragAnchorSuppressionBounds = null;
          }
        }

        const isPassiveObservedViewportUpdate = source === 'viewport' && !usingManualViewportBounds;
        const viewportIsInsideCurrentOverviewBounds = !!this.overviewFixedBounds
          && viewportIsInsideBounds(this.overviewFixedBounds, viewportBounds);

        if (isPassiveObservedViewportUpdate && viewportIsInsideCurrentOverviewBounds) {
          const suppressedPostDragBounds = this.overviewPostDragAnchorSuppressionBounds;
          const shouldSuppressSettledPostDragAnchor = shouldSuppressNextViewportAnchor || !!suppressedPostDragBounds
            && viewportPositionAlmostEqual(viewportBounds, suppressedPostDragBounds);
          if (suppressedPostDragBounds && !shouldSuppressSettledPostDragAnchor) {
            this.overviewPostDragAnchorSuppressionBounds = null;
          }
          const overviewVisibleBounds = this.overview.viewportBounds;
          if (!shouldSuppressSettledPostDragAnchor
            && (!overviewVisibleBounds.isReal() || !overviewVisibleBounds.containsPoint(viewportBounds.center))) {
            this.overview.centerRect(viewportBounds);
          }
          cancelPendingOverviewInteractionRefresh();
          cancelPendingViewportBindingsRefresh();
          this.setOverviewUpdateDelay(FlowOverviewService.OVERVIEW_DRAG_UPDATE_DELAY_MS);
          this.scheduleOverviewIdleUpdateDelayRestore();
          this.syncOverviewBoxToViewport(viewportBounds);
          this.overview.requestUpdate();
          // 【2026-05-19 根因修复 - 主图拖动残影】
          // 原代码在此处 `scheduleViewportBindingsUpdate('deferred')`，导致用户持续拖动
          // 主图（>96ms）时，到期 timer 会强制 `updateAllTargetBindings()` 重算所有
          // overview 节点 binding（location/color/width）；这一同步重算会在 GoJS
          // Overview 上以"全节点同帧重映射"形式表现，加上 requestUpdate 已经在每帧
          // 推进 box / observed canvas，肉眼看到的就是"任务块快速移动的残影"。
          //
          // 纯 viewport 平移阶段没有任何 binding 数据源（location/color/width）发生变化，
          // 所以无需主动 updateAllTargetBindings。document source 路径（节点真正改动）
          // 仍走 'deferred' 兜底，节点几何/颜色变更不会丢失刷新。
          return;
        }

        const clearReleaseViewportBoundsIfCaughtUp = (): void => {
          if (!usingReleaseViewportBounds || !releaseViewportBounds) return;
          const observedViewportBounds = this.diagram?.viewportBounds;
          const observedCaughtUp = observedViewportBounds?.isReal()
            && Math.abs(observedViewportBounds.x - releaseViewportBounds.x) < 1
            && Math.abs(observedViewportBounds.y - releaseViewportBounds.y) < 1;
          if (!observedCaughtUp) return;

          if (!this.overviewReleaseShouldAnchor) {
            this.overviewPostDragAnchorSuppressionBounds = releaseViewportBounds.copy();
          }
          this.overviewReleaseViewportBounds = null;
          this.overviewReleaseShouldAnchor = false;
        };

        const nodeBounds = getNodesBounds();
        const docBounds = this.diagram.documentBounds;
        let totalBounds: go.Rect;
        if (!docBounds.isReal() || (docBounds.width === 0 && docBounds.height === 0)) {
          totalBounds = viewportBounds.copy();
        } else {
          const minX = Math.min(docBounds.x, viewportBounds.x);
          const minY = Math.min(docBounds.y, viewportBounds.y);
          const maxX = Math.max(docBounds.x + docBounds.width, viewportBounds.x + viewportBounds.width);
          const maxY = Math.max(docBounds.y + docBounds.height, viewportBounds.y + viewportBounds.height);
          totalBounds = new go.Rect(minX, minY, maxX - minX, maxY - minY);
        }

        // 节点数量变化时重新计算 baseScale（非拖拽路径才需要）
        const currentNodeDataCount = ((this.diagram.model as go.Model & { nodeDataArray?: go.ObjectData[] })?.nodeDataArray?.length ?? 0);
        if (currentNodeDataCount !== lastNodeDataCount) {
          baseScale = calculateBaseScale();
          lastNodeDataCount = currentNodeDataCount;
        }
      
        const isViewportOutside = 
          viewportBounds.x < nodeBounds.x - 50 ||
          viewportBounds.y < nodeBounds.y - 50 ||
          viewportBounds.right > nodeBounds.right + 50 ||
          viewportBounds.bottom > nodeBounds.bottom + 50;
        const viewportContainsNodeCenter = viewportBounds.x <= nodeBounds.center.x
          && viewportBounds.y <= nodeBounds.center.y
          && viewportBounds.right >= nodeBounds.center.x
          && viewportBounds.bottom >= nodeBounds.center.y;
      
        if (this.overviewContainer) {
          const containerWidth = this.overviewContainer.clientWidth;
          const containerHeight = this.overviewContainer.clientHeight;
        
          if (containerWidth > 0 && containerHeight > 0 && totalBounds.width > 0 && totalBounds.height > 0) {
            const suppressedPostDragBounds = this.overviewPostDragAnchorSuppressionBounds;
            const shouldSuppressSettledPostDragAnchor = source === 'viewport'
              && !usingManualViewportBounds
              && (shouldSuppressNextViewportAnchor || !!suppressedPostDragBounds
                && suppressedPostDragBounds.isReal()
                && viewportPositionAlmostEqual(viewportBounds, suppressedPostDragBounds));
            if (!usingManualViewportBounds && suppressedPostDragBounds && !shouldSuppressSettledPostDragAnchor) {
              this.overviewPostDragAnchorSuppressionBounds = null;
            }

            const manualMovementViewport = usingFakeViewportBounds
              || (usingReleaseViewportBounds && !this.overviewReleaseShouldAnchor)
              || shouldSuppressSettledPostDragAnchor;
            const useNodeCenteredStableBounds = manualMovementViewport && viewportContainsNodeCenter;
            const boundsViewport = useNodeCenteredStableBounds
              ? new go.Rect(
                  nodeBounds.center.x - viewportBounds.width / 2,
                  nodeBounds.center.y - viewportBounds.height / 2,
                  viewportBounds.width,
                  viewportBounds.height,
                )
              : viewportBounds;
            const shouldReuseStableBoundsForMainPan = source === 'viewport'
              && !usingManualViewportBounds
              && viewportIsInsideCurrentOverviewBounds;
            // 【2026-05-19 根因修复】小地图拖拽残影：拖拽 box 时即使 viewport
            // 仍位于当前 overviewFixedBounds 内（不需要扩边），原代码仍按
            // `calculateExtendedBounds(node ∪ boundsViewport)` 每帧重新生成
            // candidateWorldBounds。boundsViewport 来源是 fakeViewportBounds
            // （随光标移动），结果是 worldBoundsKey 每帧变化、setOverviewFixedBounds
            // 每帧写入，GoJS Overview 因此 remeasure 整个 canvas，每个缩略任务块
            // 都被映射到不同 canvas 像素位置 —— 用户看到的就是"任务块快速移动残影"。
            //
            // 修复：当 box drag 的 viewport 仍位于当前稳定 fixedBounds 内时，
            // 走 reuse 路径，避免每帧 fixedBounds 写入。scale 计算保持原样，
            // smartLerp（12% 限幅）继续承担"远拖缩小 / 拖回放大"的平滑过渡，
            // 不破坏既有 scale 行为。仅当 box drag 越过 fixedBounds 边界时
            // 才回到正常 extend 分支，按需扩边并刷新 fixedBounds。
            const shouldReuseStableBoundsForBoxDrag = usingFakeViewportBounds
              && !!this.overviewFixedBounds?.isReal()
              && viewportIsInsideBounds(this.overviewFixedBounds, viewportBounds);
            let candidateWorldBounds = calculateExtendedBounds(nodeBounds.copy().unionRect(boundsViewport), boundsViewport);
            if (isPassiveObservedViewportUpdate && !viewportIsInsideCurrentOverviewBounds) {
              candidateWorldBounds = ensureViewportEdgeBuffer(candidateWorldBounds, viewportBounds, 'passive-pan');
            }
            const { bounds: worldBounds, reusedStableBounds } = resolveWorldBoundsForViewport(
              candidateWorldBounds,
              viewportBounds,
              isPassiveObservedViewportUpdate
                || shouldReuseStableBoundsForMainPan
                || shouldReuseStableBoundsForBoxDrag
                || (manualMovementViewport && isViewportOutside && !viewportContainsNodeCenter),
              shouldReuseStableBoundsForMainPan || shouldReuseStableBoundsForBoxDrag,
            );
            const freezeScaleForStableManualBounds = isPassiveObservedViewportUpdate
              || (usingFakeViewportBounds && !this.hasManualBoxMovement)
              || shouldSuppressSettledPostDragAnchor
              || usingReleaseViewportBounds
              || (!usingFakeViewportBounds && manualMovementViewport && reusedStableBounds);
            const smoothManualScale = usingFakeViewportBounds && this.hasManualBoxMovement;

            // 【2026-05-15 性能修复 P6】激活 `overviewBoundsCache` 真实去重。
            //
            // 之前 `overviewBoundsCache` 只赋值不读，setOverviewFixedBounds 每帧都被
            // 调用，触发 GoJS Overview 内部 `documentBounds` 重算 + invalidate 级联。
            // 拖拽 box 时 worldBounds 每帧都变化（因为它包含 viewportBounds），所以拖拽
            // 期内 dedup 不命中是预期的；但 idle 状态、resize 后多次 render、节点静止
            // 时的 ViewportBoundsChanged 重放等场景下 worldBounds 不变，去重能避免
            // 无意义的 invalidate。
            //
            // Key 用 worldBounds 而非 viewportBounds（原代码的字段名误用）：worldBounds
            // 才是真正传给 setOverviewFixedBounds 的值。`q = round` 把亚像素抖动归并到
            // 整数桶，避免浮点尾数不命中。
            const q = (v: number) => Math.round(v);
            const worldBoundsKey = `${q(worldBounds.x)}|${q(worldBounds.y)}|${q(worldBounds.width)}|${q(worldBounds.height)}`;

            if (worldBoundsKey !== this.overviewBoundsCache) {
              this.setOverviewFixedBounds(worldBounds);
              this.overviewBoundsCache = worldBoundsKey;
            }

            const currentScale = this.overview.scale;
            const viewportBoxWidth = viewportBounds.width * currentScale;
            const viewportBoxHeight = viewportBounds.height * currentScale;
          
            const boxPadding = Math.max(20, Math.min(containerWidth, containerHeight) * 0.1);
            const needsShrinkForBox = 
              viewportBoxWidth > containerWidth - boxPadding ||
              viewportBoxHeight > containerHeight - boxPadding;
          
            if (!freezeScaleForStableManualBounds && (isViewportOutside || needsShrinkForBox)) {
              const padding = 0.15;
              const scaleX = (containerWidth * (1 - padding * 2)) / totalBounds.width;
              const scaleY = (containerHeight * (1 - padding * 2)) / totalBounds.height;
              let targetScale = clampScale(Math.min(scaleX, scaleY, 0.5));
            
              const newViewportBoxWidth = viewportBounds.width * targetScale;
              const newViewportBoxHeight = viewportBounds.height * targetScale;
            
              if (newViewportBoxWidth > containerWidth - boxPadding) {
                targetScale = Math.min(targetScale, (containerWidth - boxPadding) / viewportBounds.width);
              }
              if (newViewportBoxHeight > containerHeight - boxPadding) {
                targetScale = Math.min(targetScale, (containerHeight - boxPadding) / viewportBounds.height);
              }
            
              targetScale = clampScale(targetScale);
            
              if (Math.abs(targetScale - this.overview.scale) > 0.002) {
                const smoothedScale = updateScaleTowardTarget(this.overview.scale, targetScale, smoothManualScale);
                this.overview.scale = clampScale(smoothedScale);
                this.lastOverviewScale = this.overview.scale;
              }
            } else if (!freezeScaleForStableManualBounds) {
              const targetScale = clampScale(baseScale);
            
              const testBoxWidth = viewportBounds.width * targetScale;
              const testBoxHeight = viewportBounds.height * targetScale;
            
              let finalScale = targetScale;
              if (testBoxWidth > containerWidth - boxPadding) {
                finalScale = Math.min(finalScale, (containerWidth - boxPadding) / viewportBounds.width);
              }
              if (testBoxHeight > containerHeight - boxPadding) {
                finalScale = Math.min(finalScale, (containerHeight - boxPadding) / viewportBounds.height);
              }
            
              finalScale = clampScale(finalScale);
            
              if (Math.abs(finalScale - currentScale) > 0.002) {
                const smoothedScale = updateScaleTowardTarget(currentScale, finalScale, smoothManualScale);
                this.overview.scale = clampScale(smoothedScale);
                this.lastOverviewScale = this.overview.scale;
              }
            }

            // 拖拽中和实际拖动刚释放后的同位置刷新都不重居中，避免底图
            // 追着白框跑或在异步 ViewportBoundsChanged 中把白框拉回。
            // 当主图 viewport 真正改变时再恢复普通锚定，保留非拖拽同步能力。
            const shouldAnchorOverviewOnViewport = !usingFakeViewportBounds
              && !shouldSuppressSettledPostDragAnchor
              && (!usingReleaseViewportBounds || this.overviewReleaseShouldAnchor)
              && (source === 'document' || usingReleaseViewportBounds || !viewportIsInsideCurrentOverviewBounds);
            if (shouldAnchorOverviewOnViewport) {
              this.overview.centerRect(viewportBounds);
            }
          }
        }
        
        if (this.overview) {
          // 【2026-05-15 性能修复 P5】手动拖拽路径不再直接调用
          // `updateAllTargetBindings()`，统一走 `scheduleViewportBindingsUpdate('immediate')`
          // 复用 16ms 节流窗口。
          //
          // 原因：拖拽 box 时 applyOverviewUpdate 每帧（120Hz 输入下甚至更频繁）执行，
          // `updateAllTargetBindings()` 会遍历所有 Overview 节点的所有 Binding
          // (location/color/width 等)，百节点级即可成为稳定 6-12ms 的主线程长任务，
          // 导致拖动手感「阻滞」。box 拖拽期间节点本身的数据（位置/颜色）不会变，
          // 16ms 节流肉眼无差异。
          //
          // requestUpdate 仍每次同步触发，保证视图框/缩略块每帧重绘跟手。
          this.overview.requestUpdate();
          if (usingFakeViewportBounds) {
            if (this.throttledUpdateBindingsTimer) {
              clearTimeout(this.throttledUpdateBindingsTimer);
              this.throttledUpdateBindingsTimer = null;
            }
            this.throttledUpdateBindingsPending = false;
            lastBindingsUpdateMode = null;
            return;
          }

          if (usingManualViewportBounds) {
            if (usingReleaseViewportBounds && !this.overviewReleaseShouldAnchor) {
              cancelPendingViewportBindingsRefresh();
            } else {
              scheduleViewportBindingsUpdate('immediate');
            }
          } else if (source === 'document') {
            // 普通数据刷新阶段仅做轻量 requestUpdate，把全量绑定刷新合并到延后窗口，
            // 避免 remote refresh -> Flow 重算 -> overview bindings 同帧叠加成主线程长任务。
            scheduleViewportBindingsUpdate('deferred');
          } else {
            // 【2026-05-19 根因修复 - 主图拖动残影】
            // 进入此分支意味着是被动 viewport 更新且 viewport 离开了当前
            // overviewFixedBounds（早返回路径不命中）。此时只需要 requestUpdate 推进
            // 几何同步即可，不应再触发 updateAllTargetBindings —— 主图 pan 不会改变
            // 任何 binding 源（location/color/width），periodic updateAllTargetBindings 反而会
            // 让所有 overview 缩略任务块在 ~96ms 节奏上呈现"全节点重映射闪烁"，
            // 也就是用户报告的"快速移动残影"。
            cancelPendingViewportBindingsRefresh();
          }
        }

        clearReleaseViewportBoundsIfCaughtUp();
      } finally {
        this.isApplyingOverviewViewportUpdate = false;
        
        if (this.overviewUpdateQueuedWhileApplying) {
          this.overviewUpdateQueuedWhileApplying = false;
          this.overviewScheduleUpdate?.('viewport');
        }
      }
    };

    // 保存调度函数引用
    this.overviewScheduleUpdate = (source: 'viewport' | 'document') => {
      if (this.isDestroyed || !this.overview) return;
      
      // 节点拖拽期间更强的节流
      if (this.isNodeDragging) {
        const now = Date.now();
        if (now - this.overviewInteractionLastApplyAt < 32) return;
        this.overviewInteractionLastApplyAt = now;
      }

      if (source === 'document' || this.pendingOverviewUpdateSource !== 'document') {
        this.pendingOverviewUpdateSource = source;
      }

      if (this.overviewScheduledUpdateRafId !== null) {
        return;
      }

      this.overviewScheduledUpdateRafId = requestAnimationFrame(() => {
        this.overviewScheduledUpdateRafId = null;
        const nextSource = this.pendingOverviewUpdateSource ?? source;
        this.pendingOverviewUpdateSource = null;
        applyOverviewUpdate(nextSource);
      });
    };

    this.overviewApplyUpdateNow = (source: 'viewport' | 'document') => {
      if (this.isDestroyed || !this.overview) return;

      if (this.overviewScheduledUpdateRafId !== null) {
        cancelAnimationFrame(this.overviewScheduledUpdateRafId);
        this.overviewScheduledUpdateRafId = null;
      }
      this.pendingOverviewUpdateSource = null;
      applyOverviewUpdate(source);
    };

    // 绑定 DiagramListener
    this.overviewDocumentBoundsChangedHandler = () => {
      this.overviewScheduleUpdate?.('document');
    };
    this.overviewViewportBoundsChangedHandler = () => {
      clearStaleReleaseViewportForObservedPan();
      this.overviewScheduleUpdate?.('viewport');
    };
    
    this.diagram.addDiagramListener('DocumentBoundsChanged', this.overviewDocumentBoundsChangedHandler);
    this.diagram.addDiagramListener('ViewportBoundsChanged', this.overviewViewportBoundsChangedHandler);
  }
  
  private setOverviewFixedBounds(bounds: go.Rect | null): void {
    // 2026-05-15 A2：销毁后所有 setter 必须 no-op，避免 cleanupOverview 进行中
    // 残留路径继续操作已解绑的 overview 引用。
    if (this.isDestroyed || !this.overview) return;
    this.overviewFixedBounds = bounds?.copy() ?? null;
    (this.overview as unknown as { fixedBounds: go.Rect | undefined }).fixedBounds = bounds ?? undefined;
  }

  /**
   * 2026-05-15 A1：Diagram 就绪门控。
   *
   * GoJS `Overview.observed` 文档要求 observed Diagram 的 documentBounds 必须
   * 是 real Rect 才能安全 measure。在 Diagram 刚构造、@defer 视图懒加载、
   * 项目切换等场景下，documentBounds 可能是 NaN/0 的非 real Rect。
   *
   * 本方法做两件事：
   *   1) 若 diagram 已就绪 → 立即赋值 observed；
   *   2) 否则注册一次性 InitialLayoutCompleted 监听器，待首次布局结束后绑定。
   *
   * 未就绪期间 overview.observed 保持 null，GoJS 内部的 ResizeObserver /
   * AnimationManager tick 在读 observed === null 时直接 return，不会触发
   * `_getOriginRect` 抛错。
   */
  private bindObservedWhenReady(): void {
    if (this.isDestroyed || !this.overview || !this.diagram) return;

    const diagram = this.diagram;
    const overview = this.overview;

    // 清理可能存在的旧 listener，幂等
    this.removePendingInitialLayoutHandler();

    if (diagram.documentBounds.isReal()) {
      overview.observed = diagram;
      return;
    }

    this.logger.debug('Overview observed 延后绑定：documentBounds 尚未就绪');

    const handler = (_e: go.DiagramEvent): void => {
      if (this.isDestroyed) return;
      if (!this.overview || !this.diagram) return;
      if (!this.diagram.documentBounds.isReal()) return;

      this.overview.observed = this.diagram;
      this.removePendingInitialLayoutHandler();
      // 首次绑定后请求一次 update，确保即时 measure
      this.overview.requestUpdate();
    };

    this.overviewPendingInitialLayoutHandler = handler;
    diagram.addDiagramListener('InitialLayoutCompleted', handler);
    // 兜底：LayoutCompleted 在 GoJS 中可能先于 InitialLayoutCompleted 触发，
    // 监听两者任一即可，绑定成功后会自行解除。
    diagram.addDiagramListener('LayoutCompleted', handler);
  }

  private removePendingInitialLayoutHandler(): void {
    if (!this.overviewPendingInitialLayoutHandler) return;
    if (this.diagram) {
      this.diagram.removeDiagramListener('InitialLayoutCompleted', this.overviewPendingInitialLayoutHandler);
      this.diagram.removeDiagramListener('LayoutCompleted', this.overviewPendingInitialLayoutHandler);
    }
    this.overviewPendingInitialLayoutHandler = null;
  }

  /**
   * 2026-05-15 A4：注册全局自愈钩子。
   *
   * GlobalErrorHandler 命中 GoJS `_getOriginRect` SILENT 噪声后会调用
   * `window.__NANOFLOW_OVERVIEW_HEAL__()`。本方法把当前 overview 实例的
   * `requestUpdate()` 暴露到全局，由错误处理路径触发一次 measure 自愈。
   *
   * 解耦理由：避免 GlobalErrorHandler 直接依赖 features/flow 服务（循环依赖）。
   */
  private installOverviewHealHook(): void {
    if (this.overviewHealHookInstalled) return;
    try {
      type OverviewHealWindow = Window & {
        __NANOFLOW_OVERVIEW_HEAL__?: () => void;
      };
      (window as OverviewHealWindow).__NANOFLOW_OVERVIEW_HEAL__ = () => {
        if (this.isDestroyed || !this.overview) return;
        try {
          this.overview.requestUpdate();
        } catch {
          // 自愈过程中再抛错只会回到 GlobalErrorHandler 制造死循环，吞掉
        }
      };
      this.overviewHealHookInstalled = true;
    } catch {
      // window 不可用（SSR/测试环境）忽略
    }
  }

  private removeOverviewHealHook(): void {
    if (!this.overviewHealHookInstalled) return;
    try {
      type OverviewHealWindow = Window & {
        __NANOFLOW_OVERVIEW_HEAL__?: () => void;
      };
      delete (window as OverviewHealWindow).__NANOFLOW_OVERVIEW_HEAL__;
    } catch {
      // ignore
    }
    this.overviewHealHookInstalled = false;
  }

  /** 绑定 Overview 的 Pointer 事件监听 */
  private attachOverviewPointerListeners(container: HTMLDivElement): void {
    if (this.overviewPointerCleanup) {
      this.overviewPointerCleanup();
      this.overviewPointerCleanup = null;
    }

    const prevTouchAction = container.style.touchAction;
    container.style.touchAction = 'none';
    const supportsPointerEvents = typeof PointerEvent !== 'undefined';

    let capturedPointerId: number | null = null;
    let hasPointerCapture = false;
    let isDraggingBox = false;
    let isManualBoxDrag = false;
    let isMouseDraggingBox = false;
    let isResettingOverviewInteraction = false;
    let suppressNextOverviewClick = false;
    /**
     * 【2026-05-09 根因修复】拖拽开始时捕获的稳定映射参数。
     *
     * 起因：拖拽期间 applyOverviewUpdate 会同步修改 overview.scale / overview.position
     * （smartLerp、setOverviewFixedBounds、centerRect(viewportBounds)），而
     * `transformViewToDoc` 依赖 overview 的当前 scale + position 做反变换，
     * 导致同一个 clientX/Y 在不同帧映射到不同的 document 点。这种漂移在拖拽
     * 过程中被白框跟随光标的视觉反馈掩盖（每帧 updateAllTargetBindings 强制
     * 同步），但松手时累计的漂移就显现为：白框落点 ≠ 用户期望的 document 位置，
     * 主视图实际滚到的位置和小地图缩略块呈现的内容不一致。
     *
     * 修复：在 beginManualBoxDrag 一次性捕获 dragStartScale + dragStartBoxCenterDoc
     * + dragStartClientPt + dragStartContainerRect。后续帧基于 client 空间的
     * 鼠标位移（除以稳定 scale）累加到起始 box 中心，得到 document 空间的目标
     * box 中心。如此 client → doc 的映射在整个拖拽周期内恒定，不受 overview
     * 自身 scale/position 变化影响，松手时位置和鼠标位置精确对应。
     */
    let manualDragStartClientX = 0;
    let manualDragStartClientY = 0;
    let manualDragStartViewToDocFactorX = 1;
    let manualDragStartViewToDocFactorY = 1;
    let manualDragStartBoxCenterDoc: go.Point | null = null;
    let manualDragViewportSize: { w: number; h: number } | null = null;
    type RejectedDragDirection = -1 | 0 | 1;
    let rejectedDragBoundary: {
      acceptedPosition: go.Point;
      blockX: RejectedDragDirection;
      blockY: RejectedDragDirection;
    } | null = null;

    const getOverviewDocPointFromClient = (clientX: number, clientY: number): go.Point | null => {
      if (!this.overview) return null;
      const rect = container.getBoundingClientRect();
      const viewX = clientX - rect.left;
      const viewY = clientY - rect.top;
      return this.overview.transformViewToDoc(new go.Point(viewX, viewY));
    };

    /**
     * 【2026-05-09 根因修复】使用拖拽起始时捕获的稳定 transform 计算 document 点。
     * 不依赖 overview 当前 scale/position，避免拖拽期间 overview 自适应缩放/居中
     * 导致同一 client 坐标在不同帧映射到不同 document 点的漂移。
     *
     * 通过 (clientX/Y - 起始 client) 在 view 空间得到位移，再乘以起始时刻的
     * view→doc 因子（由 transformViewToDoc 在 (0,0)/(1,0)/(0,1) 三点反推），
     * 等价于"用拖拽起始一刻的 transformViewToDoc 处理当前坐标"，但不会被
     * 后续 overview transform 变化污染。
     */
    const computeStableDocCenterFromClient = (clientX: number, clientY: number): go.Point | null => {
      if (!manualDragStartBoxCenterDoc) return null;
      const viewDeltaX = (clientX - manualDragStartClientX);
      const viewDeltaY = (clientY - manualDragStartClientY);
      const docDeltaX = viewDeltaX * manualDragStartViewToDocFactorX;
      const docDeltaY = viewDeltaY * manualDragStartViewToDocFactorY;
      return new go.Point(
        manualDragStartBoxCenterDoc.x + docDeltaX,
        manualDragStartBoxCenterDoc.y + docDeltaY
      );
    };

    const stopEventForManualDrag = (ev: Event): void => {
      try { (ev as Event & { stopImmediatePropagation?: () => void }).stopImmediatePropagation?.(); } catch { /* noop */ }
      try { ev.stopPropagation(); } catch { /* noop */ }
      try { (ev as Event & { preventDefault?: () => void }).preventDefault?.(); } catch { /* noop */ }
    };

    const moveOverviewBoxToCenter = (center: go.Point, viewportSize?: { w: number; h: number } | null): void => {
      if (!this.overview) return;
      const box = this.overview.box;
      const bounds = box?.actualBounds;
      if (!box || !bounds?.isReal()) return;
      const width = viewportSize?.w ?? bounds.width;
      const height = viewportSize?.h ?? bounds.height;

      const nextPosition = new go.Point(
        center.x - width / 2,
        center.y - height / 2,
      );
      if (!box.position.equals(nextPosition)) {
        box.position = nextPosition;
      }
    };

    const onClick = (ev: MouseEvent): void => {
      if (!suppressNextOverviewClick) return;
      stopEventForManualDrag(ev);
    };

    const updateOverviewBoxViewportBounds = (centerOverride?: go.Point, fallbackDocPt?: go.Point): void => {
      if (!this.diagram || !this.overview) return;
      const vb = this.diagram.viewportBounds;
      if (!vb.isReal()) return;

      const boxBounds = this.overview.box?.actualBounds;
      const center = centerOverride ?? (boxBounds?.isReal() ? boxBounds.center : fallbackDocPt);
      if (!center) return;

      this.overviewBoxViewportBounds = new go.Rect(
        center.x - vb.width / 2,
        center.y - vb.height / 2,
        vb.width,
        vb.height
      );
    };

    const cancelRejectedViewportWriteUpdate = (): void => {
      if (this.overviewScheduledUpdateRafId !== null) {
        cancelAnimationFrame(this.overviewScheduledUpdateRafId);
        this.overviewScheduledUpdateRafId = null;
      }
      this.pendingOverviewUpdateSource = null;
    };

    const readRejectedDirection = (desiredValue: number, acceptedValue: number): RejectedDragDirection => {
      const epsilon = 1;
      if (desiredValue > acceptedValue + epsilon) return 1;
      if (desiredValue < acceptedValue - epsilon) return -1;
      return 0;
    };

    const axisStillRejected = (
      desiredValue: number,
      acceptedValue: number,
      direction: RejectedDragDirection,
    ): boolean => {
      const epsilon = 1;
      if (direction > 0) return desiredValue > acceptedValue + epsilon;
      if (direction < 0) return desiredValue < acceptedValue - epsilon;
      return Math.abs(desiredValue - acceptedValue) < epsilon;
    };

    const shouldSkipRejectedPositionWrite = (desiredPos: go.Point, currentPosition: go.Point): boolean => {
      if (!rejectedDragBoundary || !currentPosition.equals(rejectedDragBoundary.acceptedPosition)) {
        return false;
      }

      return axisStillRejected(desiredPos.x, rejectedDragBoundary.acceptedPosition.x, rejectedDragBoundary.blockX)
        && axisStillRejected(desiredPos.y, rejectedDragBoundary.acceptedPosition.y, rejectedDragBoundary.blockY);
    };

    const beginManualBoxDrag = (pt: go.Point, clientX: number, clientY: number): void => {
      if (!this.diagram || !this.overview) return;
      const vb = this.diagram.viewportBounds;
      if (!vb.isReal()) return;

      // 【2026-05-11 根因修复】新拖拽周期开始：重置位移标记。
      // 配合 updateScaleTowardTarget 仅在 dragging && hasMovement 时使用 smartLerp，
      // 保证 press 不动场景的 apply snap 到 target，消除 scale 残差跳动。
      this.hasManualBoxMovement = false;
      rejectedDragBoundary = null;

        manualDragViewportSize = { w: vb.width, h: vb.height };

      // 使用 diagram.position (+ vb 宽高折中) 计算无延迟的实时视口中心，
      // 避免 diagram.viewportBounds 异步更新滞后导致紧随主图拖拽后点击小地图发生的"概率回跳"。
      const viewportCenter = new go.Point(
        this.diagram.position.x + vb.width / 2,
        this.diagram.position.y + vb.height / 2
      );

      // 【2026-05-09 根因修复】捕获稳定 transform 参数。
      // 这些值在整个拖拽周期内保持不变，确保 client → doc 映射恒定，
      // 不受 applyOverviewUpdate 中途修改 overview.scale/position 影响。
      manualDragStartClientX = clientX;
      manualDragStartClientY = clientY;
      // 通过 transformViewToDoc 在 (0,0)/(1,0)/(0,1) 三点反推 view→doc 线性因子，
      // 拖拽全程使用这套起始映射，避免 overview.scale 变化造成 client 同坐标在
      // 不同帧映射到不同 doc 点的累计漂移。
      // 假设：GoJS Overview 的 view→doc 变换为「平移 + 等比缩放」，无旋转、
      // 无非均匀缩放（factor.y 仅看 y 分量、factor.x 仅看 x 分量足够还原）。
      // 这是 Overview 在所有现行模板下的实际行为，flow-overview 没有自定义
      // angle/transform 的代码路径。
      const startOrigin = this.overview.transformViewToDoc(new go.Point(0, 0));
      const startUnitX = this.overview.transformViewToDoc(new go.Point(1, 0));
      const startUnitY = this.overview.transformViewToDoc(new go.Point(0, 1));
      const factorX = startUnitX.x - startOrigin.x;
      const factorY = startUnitY.y - startOrigin.y;
      // factor 退化为 0 / 非有限数（overview 未就绪 / scale 极端）时不进入手动拖拽，
      // 避免回退到 1 掩盖 0 缩放导致的错误位移。
      if (!Number.isFinite(factorX) || !Number.isFinite(factorY) || factorX === 0 || factorY === 0) {
        this.logger.debug('beginManualBoxDrag: 退化的 view→doc 映射，跳过手动拖拽初始化');
        return;
      }
      manualDragStartViewToDocFactorX = factorX;
      manualDragStartViewToDocFactorY = factorY;
      // 拖拽的文档坐标源头必须来自主图 viewport，而不是 overview.box.actualBounds。
      // box 的实际边界会受 Overview 自身缩放/居中重算影响；点击不移动时若用它作为
      // 起点，松手会把主图滚到小地图的临时视觉位置，造成预览框内容与主视图不一致。
      manualDragStartBoxCenterDoc = viewportCenter.copy();

      try { this.diagram.skipsUndoManager = true; } catch { /* noop */ }
      this.setOverviewUpdateDelay(FlowOverviewService.OVERVIEW_DRAG_UPDATE_DELAY_MS);

      isManualBoxDrag = true;
      updateOverviewBoxViewportBounds(viewportCenter, pt);
    };

    const applyManualBoxDrag = (clientX: number, clientY: number): boolean => {
      if (!this.diagram || !isManualBoxDrag || !manualDragViewportSize || !manualDragStartBoxCenterDoc) return false;

      // 【2026-05-09 根因修复】使用稳定 transform 推导 box 中心。
      // 之前 const centerX = pt.x - offset.dx 中 pt 由 transformViewToDoc 实时计算，
      // 而 transformViewToDoc 用的是 overview 当前 scale/position（在拖拽中被
      // applyOverviewUpdate 同步修改），导致同一 clientX 在不同帧映射到不同
      // document 点 —— 拖拽过程被白框跟手反馈掩盖，但松手时累计漂移让
      // diagram.position 和小地图实际显示的视口位置不一致，主视图与预览框脱节。
      const stableCenter = computeStableDocCenterFromClient(clientX, clientY);
      if (!stableCenter) return false;

      const desiredPos = new go.Point(
        stableCenter.x - manualDragViewportSize.w / 2,
        stableCenter.y - manualDragViewportSize.h / 2
      );

      let acceptedPosition = this.diagram.position;

      // Pre-clamp desiredPos against any active rejected drag boundary to prevent jitter/out-of-bounds writes
      if (rejectedDragBoundary && acceptedPosition.equals(rejectedDragBoundary.acceptedPosition)) {
        if (axisStillRejected(desiredPos.x, acceptedPosition.x, rejectedDragBoundary.blockX)) {
          desiredPos.x = acceptedPosition.x;
        }
        if (axisStillRejected(desiredPos.y, acceptedPosition.y, rejectedDragBoundary.blockY)) {
          desiredPos.y = acceptedPosition.y;
        }
      }

      let acceptedMovement = false;
      let attemptedPositionWrite = false;
      if (shouldSkipRejectedPositionWrite(desiredPos, acceptedPosition)) {
        return false;
      }

      if (!acceptedPosition.equals(desiredPos)) {
        attemptedPositionWrite = true;
        const previousPosition = acceptedPosition.copy();
        this.diagram.position = desiredPos;
        acceptedPosition = this.diagram.position;
        // 【2026-05-11】检测到实际位移，启用 smartLerp 平滑动画（仅在真实拖拽中）。
        acceptedMovement = !acceptedPosition.equals(previousPosition);
        this.hasManualBoxMovement = this.hasManualBoxMovement || acceptedMovement;
      }

      if (!acceptedMovement) {
        if (attemptedPositionWrite) {
          const blockX = readRejectedDirection(desiredPos.x, acceptedPosition.x);
          const blockY = readRejectedDirection(desiredPos.y, acceptedPosition.y);
          rejectedDragBoundary = blockX !== 0 || blockY !== 0
            ? { acceptedPosition: acceptedPosition.copy(), blockX, blockY }
            : null;
          const acceptedBoxCenter = new go.Point(
            acceptedPosition.x + manualDragViewportSize.w / 2,
            acceptedPosition.y + manualDragViewportSize.h / 2,
          );
          moveOverviewBoxToCenter(acceptedBoxCenter, manualDragViewportSize);
          updateOverviewBoxViewportBounds(acceptedBoxCenter);
          cancelRejectedViewportWriteUpdate();
        }
        return false;
      }

      rejectedDragBoundary = null;

      const acceptedBoxCenter = new go.Point(
        acceptedPosition.x + manualDragViewportSize.w / 2,
        acceptedPosition.y + manualDragViewportSize.h / 2,
      );
      moveOverviewBoxToCenter(acceptedBoxCenter, manualDragViewportSize);
      updateOverviewBoxViewportBounds(acceptedBoxCenter);
      return true;
    };

    const endManualBoxDrag = (): void => {
      if (!isManualBoxDrag) return;
      isManualBoxDrag = false;
      manualDragViewportSize = null;
      manualDragStartBoxCenterDoc = null;
      rejectedDragBoundary = null;
      // 【2026-05-11】清除位移标记，下次 press 由 beginManualBoxDrag 重置。
      this.hasManualBoxMovement = false;
      this.setOverviewUpdateDelay(FlowOverviewService.OVERVIEW_IDLE_UPDATE_DELAY_MS);
      if (this.diagram) {
        try { this.diagram.skipsUndoManager = false; } catch { /* noop */ }
      }
    };

    const onPointerDown = (ev: PointerEvent): void => {
      if (!this.overview) return;
      
      const pt = getOverviewDocPointFromClient(ev.clientX, ev.clientY);
      if (!pt) return;
      
      const boxBounds = this.overview.box?.actualBounds;
      if (boxBounds?.isReal() && boxBounds.containsPoint(pt)) {
        isDraggingBox = true;
        this.isOverviewBoxDragging = true;
        suppressNextOverviewClick = true;

        stopEventForManualDrag(ev);

        try {
          container.setPointerCapture(ev.pointerId);
          capturedPointerId = ev.pointerId;
          hasPointerCapture = true;
        } catch (e) {
          capturedPointerId = ev.pointerId;
          this.logger.debug('Overview box setPointerCapture 不可用:', e);
        }

        beginManualBoxDrag(pt, ev.clientX, ev.clientY);
        if (this.throttledUpdateBindingsTimer) {
          clearTimeout(this.throttledUpdateBindingsTimer);
          this.throttledUpdateBindingsTimer = null;
        }
        this.throttledUpdateBindingsPending = false;
        return;
      }
      
      isDraggingBox = false;
      suppressNextOverviewClick = false;
      this.isOverviewInteracting = true;
      
      try {
        container.setPointerCapture(ev.pointerId);
        capturedPointerId = ev.pointerId;
        hasPointerCapture = true;
      } catch (e) {
        this.logger.debug('setPointerCapture 不可用:', e);
      }
    };

    /**
     * 【2026-05-15 性能修复 P4】输入侧 rAF 合流。
     *
     * 起因：原 `onPointerMove` 同步调用 `applyManualBoxDrag`，内部立即
     * 写入 `diagram.position` 并 `diagram.requestUpdate()`，紧接着再调度
     * 一次 overview rAF。120Hz 鼠标/触控板每秒触发 120 次 pointermove，
     * 60Hz 屏每帧只能消化 1 次，多余 1 次的工作变成「上一帧没画完，下一
     * 帧又开了一次」的主线程拥堵；同时主图重绘走同步路径、overview 走 rAF，
     * 两者周期错位进一步加重合成层 ghost。
     *
     * 修复：在拖拽周期内维护单一 rAF —— pointermove 仅记录最新 client 坐标
     * 并调度一次 rAF；rAF 回调 flush 最新坐标。同一帧内多次 pointermove 自动
     * 折叠为一次主图位移 + 一次 overview 调度，主图与 overview 进入同一 rAF
     * 周期，消除两帧错位。
     *
     * 配合 2026-05-09 稳定 view→doc 映射：rAF 内仍使用 `manualDragStart*`
     * 起始映射，几何精度不变；rAF 用 latestClientX/Y 即可正确反映最终位置。
     *
     * pointerup 路径不走 rAF：必须取消 pending rAF 并同步 flush，确保松手
     * 帧 `diagram.position` 与 `centerRect` 都用最终 client 坐标。
     */
    let pendingDragClientX: number | null = null;
    let pendingDragClientY: number | null = null;
    let pendingDragRafId: number | null = null;

    const cancelPendingDragRaf = (): void => {
      if (pendingDragRafId !== null) {
        cancelAnimationFrame(pendingDragRafId);
        pendingDragRafId = null;
      }
      pendingDragClientX = null;
      pendingDragClientY = null;
    };

    const applyManualBoxDragFromEvent = (ev: PointerEvent | MouseEvent): void => {
      if (!isManualBoxDrag) return;
      // 【2026-05-15 性能修复 P4 配套】同步 flush 路径前先取消任何 pending 输入 rAF，
      // 避免松手后 rAF 用旧坐标覆盖最终位置。
      cancelPendingDragRaf();
      // 【2026-05-09 根因修复】直接传 client 坐标，让 applyManualBoxDrag 内部使用
      // 拖拽起始时捕获的稳定 transform 计算 document 位移，避免依赖
      // overview.transformViewToDoc（其结果会随 overview.scale/position 漂移）。
      const acceptedMovement = applyManualBoxDrag(ev.clientX, ev.clientY);
      if (acceptedMovement) {
        this.overviewApplyUpdateNow?.('viewport');
      }
    };

    const scheduleManualBoxDrag = (clientX: number, clientY: number): void => {
      pendingDragClientX = clientX;
      pendingDragClientY = clientY;
      if (pendingDragRafId !== null) return;
      pendingDragRafId = requestAnimationFrame(() => {
        pendingDragRafId = null;
        if (pendingDragClientX === null || pendingDragClientY === null) return;
        const x = pendingDragClientX;
        const y = pendingDragClientY;
        pendingDragClientX = null;
        pendingDragClientY = null;
        if (!isManualBoxDrag) return;
        const acceptedMovement = applyManualBoxDrag(x, y);
        if (acceptedMovement) {
          if (this.overviewApplyUpdateNow) {
            this.overviewApplyUpdateNow('viewport');
          } else {
            this.overviewScheduleUpdate?.('viewport');
          }
        }
      });
    };

    const onPointerMove = (ev: PointerEvent): void => {
      if (!isDraggingBox || !this.overview) return;

      if (isManualBoxDrag) {
        stopEventForManualDrag(ev);
      }

      if (capturedPointerId !== null && ev.pointerId !== capturedPointerId) return;
      scheduleManualBoxDrag(ev.clientX, ev.clientY);
    };

    const resetOverviewInteractionState = (): void => {
      if (isResettingOverviewInteraction) {
        return;
      }

      isResettingOverviewInteraction = true;
      const pointerIdToRelease = hasPointerCapture ? capturedPointerId : null;
      const wasBoxDragReset = isDraggingBox || isMouseDraggingBox || this.isOverviewBoxDragging;

      capturedPointerId = null;
      hasPointerCapture = false;
      isDraggingBox = false;
      isMouseDraggingBox = false;
      if (wasBoxDragReset) {
        const shouldAnchorRelease = !this.hasManualBoxMovement;
        const actualViewportBounds = this.diagram?.viewportBounds;
        const actualPosition = this.diagram?.position;
        const hasActualPosition = !!actualPosition
          && Number.isFinite(actualPosition.x)
          && Number.isFinite(actualPosition.y);
        this.overviewReleaseViewportBounds = actualViewportBounds?.isReal() && hasActualPosition
          ? new go.Rect(actualPosition.x, actualPosition.y, actualViewportBounds.width, actualViewportBounds.height)
          : this.overviewBoxViewportBounds?.isReal()
            ? this.overviewBoxViewportBounds.copy()
            : null;
        this.overviewReleaseShouldAnchor = shouldAnchorRelease;
        this.overviewPostDragAnchorSuppressionBounds = this.overviewReleaseViewportBounds?.copy() ?? null;
      }
      this.isOverviewBoxDragging = false;
              if (this.throttledUpdateBindingsTimer) {
                clearTimeout(this.throttledUpdateBindingsTimer);
                this.throttledUpdateBindingsTimer = null;
              }
              this.throttledUpdateBindingsPending = false;
      this.isOverviewInteracting = false;
      this.overviewInteractionLastApplyAt = 0;
      this.overviewBoxViewportBounds = null;

      if (this.throttledUpdateBindingsTimer) {
        clearTimeout(this.throttledUpdateBindingsTimer);
        this.throttledUpdateBindingsTimer = null;
      }
      this.throttledUpdateBindingsPending = false;

      // 【2026-05-15 性能修复 P4】拖拽周期结束时必须清掉任何尚未 flush 的输入 rAF，
      // 避免在 endManualBoxDrag 把状态清零后 rAF 仍然触发 applyManualBoxDrag。
      cancelPendingDragRaf();

      endManualBoxDrag();

      if (pointerIdToRelease !== null) {
        try { container.releasePointerCapture(pointerIdToRelease); } catch { /* noop */ }
      }

      isResettingOverviewInteraction = false;
    };
    
    const onPointerUpLike = (ev?: PointerEvent): void => {
      const wasDraggingBox = isDraggingBox;
      const wasInteracting = this.isOverviewInteracting;

      if (wasDraggingBox && ev && capturedPointerId !== null && ev.pointerId !== capturedPointerId) return;
      if (wasDraggingBox && ev && isManualBoxDrag) {
        stopEventForManualDrag(ev);
        applyManualBoxDragFromEvent(ev);
      }

      const hadManualBoxMovement = this.hasManualBoxMovement;

      resetOverviewInteractionState();
      
      if (wasDraggingBox) {
        if (!hadManualBoxMovement) {
          const viewportBounds = this.diagram?.viewportBounds;
          this.overviewPostDragAnchorSuppressionBounds = viewportBounds?.isReal()
            ? viewportBounds.copy()
            : null;
          this.overviewSuppressNextViewportAnchor = true;
          this.overviewReleaseViewportBounds = null;
          this.overviewReleaseShouldAnchor = false;
          return;
        }
        this.overviewBoundsCache = '';
        this.overviewScheduleUpdate?.('viewport');
        return;
      }
      
      if (!wasInteracting) return;

      this.overviewBoundsCache = '';
      this.overviewScheduleUpdate?.('viewport');

      if (this.overviewInteractionRefreshRafId !== null) {
        cancelAnimationFrame(this.overviewInteractionRefreshRafId);
      }
      this.overviewInteractionRefreshRafId = requestAnimationFrame(() => {
        this.overviewInteractionRefreshRafId = null;
        if (this.isDestroyed || !this.diagram || !this.overview) return;
        this.overview.requestUpdate();
        this.diagram.requestUpdate();
      });
    };

    const onWindowPointerMove = (ev: PointerEvent): void => {
      if (!isDraggingBox) return;
      if (hasPointerCapture) return;
      if (capturedPointerId !== null && ev.pointerId !== capturedPointerId) return;
      if (isManualBoxDrag) {
        stopEventForManualDrag(ev);
      }
      // 【2026-05-15 性能修复 P4】走 rAF 合流，避免 120Hz 输入下同步刷主图。
      scheduleManualBoxDrag(ev.clientX, ev.clientY);
    };

    const onMouseDown = (ev: MouseEvent): void => {
      if (!this.overview) return;
      const pt = getOverviewDocPointFromClient(ev.clientX, ev.clientY);
      if (!pt) return;
      const boxBounds = this.overview.box?.actualBounds;
      if (boxBounds?.isReal() && boxBounds.containsPoint(pt)) {
        isMouseDraggingBox = true;
        this.isOverviewBoxDragging = true;
        stopEventForManualDrag(ev);
        beginManualBoxDrag(pt, ev.clientX, ev.clientY);
        if (this.throttledUpdateBindingsTimer) {
          clearTimeout(this.throttledUpdateBindingsTimer);
          this.throttledUpdateBindingsTimer = null;
        }
        this.throttledUpdateBindingsPending = false;
      }
    };
    const onMouseMove = (ev: MouseEvent): void => {
      if (!isMouseDraggingBox) return;
      // 【2026-05-15 性能修复 P4】走 rAF 合流。
      scheduleManualBoxDrag(ev.clientX, ev.clientY);
    };
    const onMouseUp = (ev: MouseEvent): void => {
      if (!isMouseDraggingBox) return;
      if (isManualBoxDrag) {
        stopEventForManualDrag(ev);
        applyManualBoxDragFromEvent(ev);
      }
      const hadManualBoxMovement = this.hasManualBoxMovement;
      resetOverviewInteractionState();
      if (!hadManualBoxMovement) {
        const viewportBounds = this.diagram?.viewportBounds;
        this.overviewPostDragAnchorSuppressionBounds = viewportBounds?.isReal()
          ? viewportBounds.copy()
          : null;
        this.overviewSuppressNextViewportAnchor = true;
        this.overviewReleaseViewportBounds = null;
        this.overviewReleaseShouldAnchor = false;
        return;
      }
      this.overviewBoundsCache = '';
      this.overviewScheduleUpdate?.('viewport');
    };

    const onWindowPointerUp = (ev: PointerEvent): void => {
      if (capturedPointerId !== null && ev.pointerId === capturedPointerId) {
        onPointerUpLike(ev);
      }
    };

    this.zone.runOutsideAngular(() => {
      container.addEventListener('pointerdown', onPointerDown, { passive: false, capture: true });
      container.addEventListener('pointermove', onPointerMove, { passive: false, capture: true });
      container.addEventListener('pointerup', onPointerUpLike, { passive: false, capture: true });
      container.addEventListener('pointercancel', onPointerUpLike, { passive: false, capture: true });
      container.addEventListener('lostpointercapture', onPointerUpLike, { passive: false, capture: true });
      container.addEventListener('click', onClick, { passive: false, capture: true });
      window.addEventListener('pointermove', onWindowPointerMove, { passive: false });
      window.addEventListener('pointerup', onWindowPointerUp, { passive: false });
      window.addEventListener('pointercancel', onWindowPointerUp, { passive: false });
      if (!supportsPointerEvents) {
        container.addEventListener('mousedown', onMouseDown, { passive: false, capture: true });
        window.addEventListener('mousemove', onMouseMove, { passive: true });
        window.addEventListener('mouseup', onMouseUp, { passive: true });
      }
    });

    this.overviewPointerCleanup = () => {
      container.style.touchAction = prevTouchAction;

      resetOverviewInteractionState();
      
      container.removeEventListener('pointerdown', onPointerDown, { capture: true } as EventListenerOptions);
      container.removeEventListener('pointermove', onPointerMove, { capture: true } as EventListenerOptions);
      container.removeEventListener('pointerup', onPointerUpLike, { capture: true } as EventListenerOptions);
      container.removeEventListener('pointercancel', onPointerUpLike, { capture: true } as EventListenerOptions);
      container.removeEventListener('lostpointercapture', onPointerUpLike, { capture: true } as EventListenerOptions);
      container.removeEventListener('click', onClick, { capture: true } as EventListenerOptions);
      window.removeEventListener('pointermove', onWindowPointerMove);
      window.removeEventListener('pointerup', onWindowPointerUp);
      window.removeEventListener('pointercancel', onWindowPointerUp);
      if (!supportsPointerEvents) {
        container.removeEventListener('mousedown', onMouseDown, { capture: true } as EventListenerOptions);
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
      }
    };
  }
}







