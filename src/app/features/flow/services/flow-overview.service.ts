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
  private isApplyingOverviewViewportUpdate: boolean = false;
  private overviewUpdateQueuedWhileApplying: boolean = false;
  private overviewScheduleUpdate: ((source: 'viewport' | 'document') => void) | null = null;
  private overviewScheduledUpdateRafId: number | null = null;
  private pendingOverviewUpdateSource: 'viewport' | 'document' | null = null;
  // 缓存与节流
  private overviewBoundsCache: string = '';
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
  // ResizeObserver
  private overviewResizeObserver: ResizeObserver | null = null;
  // Pointer 事件清理
  private overviewPointerCleanup: (() => void) | null = null;

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
        
        // 优化渲染：强制浏览器使用更高对比度和锐利度的图像渲染算法
        container.style.imageRendering = 'auto'; // 基础回退
        if ('imageRendering' in container.style) {
          // 尝试各种浏览器的锐化选项（非标准属性需类型断言）
          const style = container.style as CSSStyleDeclaration & Record<string, string>;
          style.imageRendering = '-webkit-optimize-contrast';
          if (style.imageRendering !== '-webkit-optimize-contrast') {
             style.imageRendering = 'crisp-edges';
          }
        }
        
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
        this.overview = new go.Overview(container, {
          observed: this.diagram,
          'animationManager.isEnabled': false,
          autoScale: go.AutoScale.None,
          // 禁用 Overview 内建 click/drag 交互，避免和手动 box 拖拽竞争。
          isEnabled: false,
          // 强制使用高像素比渲染（至少为 2），大幅提升小地图的清晰度和视网膜屏幕支持
          'computePixelRatio': () => Math.max(window.devicePixelRatio || 1, 2)
        });

        // 设置模板
        this.templateService.setupOverviewNodeTemplate(this.overview);
        this.linkTemplateService.setupOverviewLinkTemplate(this.overview);

        this.overview.observed = this.diagram;

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
    // 清理 Pointer 监听
    if (this.overviewPointerCleanup) {
      this.overviewPointerCleanup();
      this.overviewPointerCleanup = null;
    }
    
    // 清理 ResizeObserver
    if (this.overviewResizeObserver) {
      this.overviewResizeObserver.disconnect();
      this.overviewResizeObserver = null;
    }
    
    // 移除 DiagramListener
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
    
    // 取消视口轮询
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
    this.isOverviewInteracting = false;
    this.isOverviewBoxDragging = false;
    this.overviewBoxViewportBounds = null;
    this.overviewReleaseViewportBounds = null;
    this.isApplyingOverviewViewportUpdate = false;
    this.overviewUpdateQueuedWhileApplying = false;
    this.overviewInteractionLastApplyAt = 0;
    this.throttledUpdateBindingsPending = false;
    this.pendingOverviewUpdateSource = null;
    
    // 销毁 Overview
    if (this.overview) {
      this.overview.div = null;
      this.overview = null;
    }
    
    this.overviewContainer = null;
    this.overviewBoundsCache = '';
    this.overviewScheduleUpdate = null;
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
    
    const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
    
    const SCALE_LERP_FACTOR_SHRINK = 0.45;
    const SCALE_LERP_FACTOR_GROW = 0.18;
    
    const smartLerp = (current: number, target: number): number => {
      if (current / target > 2 || target / current > 2) {
        return target;
      }
      const t = target < current ? SCALE_LERP_FACTOR_SHRINK : SCALE_LERP_FACTOR_GROW;
      return lerp(current, target, t);
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
    const updateScaleTowardTarget = (current: number, target: number): number => {
      if (this.isOverviewBoxDragging && this.hasManualBoxMovement) {
        return smartLerp(current, target);
      }
      return target;
    };
    
    let baseScale = calculateBaseScale();
    let lastNodeDataCount = ((this.diagram.model as go.Model & { nodeDataArray?: go.ObjectData[] })?.nodeDataArray?.length ?? 0);
    this.lastOverviewScale = clampScale(baseScale);
    this.overview.scale = this.lastOverviewScale;
    
    const nodeBounds = getNodesBounds();
    this.overview.centerRect(nodeBounds);
    
    // 动态扩展边界（无限画布核心）
    const calculateExtendedBounds = (baseBounds: go.Rect, viewportBounds: go.Rect): go.Rect => {
      const overflowLeft = Math.max(0, baseBounds.x - viewportBounds.x);
      const overflowRight = Math.max(0, viewportBounds.right - baseBounds.right);
      const overflowTop = Math.max(0, baseBounds.y - viewportBounds.y);
      const overflowBottom = Math.max(0, viewportBounds.bottom - baseBounds.bottom);

      const extended = new go.Rect(
        baseBounds.x - overflowLeft,
        baseBounds.y - overflowTop,
        baseBounds.width + overflowLeft + overflowRight,
        baseBounds.height + overflowTop + overflowBottom
      );

      const containerW = this.overviewContainer?.clientWidth ?? 200;
      const containerH = this.overviewContainer?.clientHeight ?? 150;
      const dynamicBufferW = Math.max(400, containerW * 0.3);
      const dynamicBufferH = Math.max(400, containerH * 0.3);
      
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

    let lastBindingsUpdateMode: 'immediate' | 'deferred' | null = null;

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
      
        if (this.overviewContainer) {
          const containerWidth = this.overviewContainer.clientWidth;
          const containerHeight = this.overviewContainer.clientHeight;
        
          if (containerWidth > 0 && containerHeight > 0 && totalBounds.width > 0 && totalBounds.height > 0) {
            const worldBounds = calculateExtendedBounds(nodeBounds.copy().unionRect(viewportBounds), viewportBounds);

            const q = (v: number) => Math.round(v);
            const boundsKey = `${q(viewportBounds.x)}|${q(viewportBounds.y)}|${q(viewportBounds.width)}|${q(viewportBounds.height)}`;
            
            this.setOverviewFixedBounds(worldBounds);

            if (boundsKey !== this.overviewBoundsCache) {
              this.overviewBoundsCache = boundsKey;
            }

            const currentScale = this.overview.scale;
            const viewportBoxWidth = viewportBounds.width * currentScale;
            const viewportBoxHeight = viewportBounds.height * currentScale;
          
            const boxPadding = Math.max(20, Math.min(containerWidth, containerHeight) * 0.1);
            const needsShrinkForBox = 
              viewportBoxWidth > containerWidth - boxPadding ||
              viewportBoxHeight > containerHeight - boxPadding;
          
            if (isViewportOutside || needsShrinkForBox) {
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
                const smoothedScale = updateScaleTowardTarget(this.overview.scale, targetScale);
                this.overview.scale = clampScale(smoothedScale);
                this.lastOverviewScale = this.overview.scale;
              }
            } else {
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
                const smoothedScale = updateScaleTowardTarget(currentScale, finalScale);
                this.overview.scale = clampScale(smoothedScale);
                this.lastOverviewScale = this.overview.scale;
              }
            }

            // 【2026-05-09 根因修复】统一用 viewportBounds 作为唯一居中锚点。
            //
            // 之前条件 `usingManualViewportBounds || isViewportOutside` 假设：
            //   "viewport 在节点群内时，worldBounds≈nodeBounds，几何中心和
            //    viewportBounds.center 几乎重合，可以交给 contentAlignment: Spot.Center"
            // 但 worldBounds = nodeBounds ∪ viewportBounds 在节点群非对称延展时
            // 与 viewportBounds.center 偏差很大，导致：
            //   - 拖拽/点击：apply 这里调 centerRect(viewportBounds) → 概览相对
            //     viewport 居中；
            //   - 松手后 rAF 触发 render：Spot.Center 把 worldBounds 重新居中 →
            //     概览整体偏移 → 概览框相对容器跳到 worldBounds.center 与
            //     viewportBounds.center 的差值方向 → "松手跳回去 / 缩略块和主
            //     视图脱节" 的视觉跳变。
            // 修复：构造函数已移除 contentAlignment: Spot.Center；这里也无条件
            // 以 viewportBounds 为锚点，让拖拽中、释放帧、稳态、resize 全程
            // 共享同一居中规则，从根源消除模式切换。
            this.overview.centerRect(viewportBounds);
          }
        }
        
        if (this.overview) {
          if (source === 'document') {
            this.overview.requestUpdate();
            if (usingManualViewportBounds) {
              this.overview.updateAllTargetBindings();
            } else {
              // 普通数据刷新阶段仅做轻量 requestUpdate，把全量绑定刷新合并到延后窗口，
              // 避免 remote refresh -> Flow 重算 -> overview bindings 同帧叠加成主线程长任务。
              scheduleViewportBindingsUpdate('deferred');
            }
          } else {
            this.overview.requestUpdate();
            if (usingManualViewportBounds) {
              this.overview.updateAllTargetBindings();
            } else {
              scheduleViewportBindingsUpdate(this.isOverviewBoxDragging ? 'immediate' : 'deferred');
            }
          }
        }

        if (usingReleaseViewportBounds) {
          this.overviewReleaseViewportBounds = null;
        }
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

    // 绑定 DiagramListener
    this.overviewDocumentBoundsChangedHandler = () => {
      this.overviewScheduleUpdate?.('document');
    };
    this.overviewViewportBoundsChangedHandler = () => {
      this.overviewScheduleUpdate?.('viewport');
    };
    
    this.diagram.addDiagramListener('DocumentBoundsChanged', this.overviewDocumentBoundsChangedHandler);
    this.diagram.addDiagramListener('ViewportBoundsChanged', this.overviewViewportBoundsChangedHandler);
  }
  
  private setOverviewFixedBounds(bounds: go.Rect | null): void {
    if (!this.overview) return;
    (this.overview as unknown as { fixedBounds: go.Rect | undefined }).fixedBounds = bounds ?? undefined;
  }

  /** 绑定 Overview 的 Pointer 事件监听 */
  private attachOverviewPointerListeners(container: HTMLDivElement): void {
    if (this.overviewPointerCleanup) {
      this.overviewPointerCleanup();
      this.overviewPointerCleanup = null;
    }

    const prevTouchAction = container.style.touchAction;
    container.style.touchAction = 'none';

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

    const onClick = (ev: MouseEvent): void => {
      if (!suppressNextOverviewClick) return;
      stopEventForManualDrag(ev);
    };

    /**
     * 【2026-04-20 回归修复】推导拖拽期间的"假 viewportBounds"。
     *
     * 起因：Sprint 5 死代码清理（commit 6cbb7c6）误删了
     * `_updateOverviewBoxViewportBounds`。该辅助函数原本负责在拖拽概览框时，
     * 基于 overview.box.actualBounds.center（白框当前视觉中心）推导一个
     * viewportBounds 矩形，供 applyOverviewUpdate() 中 fakeViewportBounds
     * 路径使用。
     *
     * 缺了它会导致：
     *   - `this.overviewBoxViewportBounds` 永远 null
     *   - `usingFakeViewportBounds` 永远 false
     *   - `applyOverviewUpdate` 依赖 `this.diagram.viewportBounds`
     *   - 部分浏览器（Chrome/Safari 某些版本）直接写 diagram.position 不会
     *     逐帧触发 ViewportBoundsChanged，小地图 scale/fixedBounds 没法跟手
     *   - 用户视觉：拖动概览框时小地图里的任务块"卡住不动"或在松手后才突变
     *
     * 现恢复该辅助函数，并在 applyManualBoxDrag 同步调用，让 fakeViewportBounds
     * 每帧都反映白框最新位置。
     */
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

    const beginManualBoxDrag = (pt: go.Point, clientX: number, clientY: number): void => {
      if (!this.diagram || !this.overview) return;
      const vb = this.diagram.viewportBounds;
      if (!vb.isReal()) return;

      // 【2026-05-11 根因修复】新拖拽周期开始：重置位移标记。
      // 配合 updateScaleTowardTarget 仅在 dragging && hasMovement 时使用 smartLerp，
      // 保证 press 不动场景的 apply snap 到 target，消除 scale 残差跳动。
      this.hasManualBoxMovement = false;

      manualDragViewportSize = { w: vb.width, h: vb.height };
      const viewportCenter = vb.center;

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
      // 【2026-04-20 回归修复】起始帧先写入一次，确保 isOverviewBoxDragging 生效
      // 的那一拍 applyOverviewUpdate 已经能读到有效的 fakeViewportBounds。
      updateOverviewBoxViewportBounds(viewportCenter, pt);
    };

    const applyManualBoxDrag = (clientX: number, clientY: number): void => {
      if (!this.diagram || !isManualBoxDrag || !manualDragViewportSize || !manualDragStartBoxCenterDoc) return;

      // 【2026-05-09 根因修复】使用稳定 transform 推导 box 中心。
      // 之前 const centerX = pt.x - offset.dx 中 pt 由 transformViewToDoc 实时计算，
      // 而 transformViewToDoc 用的是 overview 当前 scale/position（在拖拽中被
      // applyOverviewUpdate 同步修改），导致同一 clientX 在不同帧映射到不同
      // document 点 —— 拖拽过程被白框跟手反馈掩盖，但松手时累计漂移让
      // diagram.position 和小地图实际显示的视口位置不一致，主视图与预览框脱节。
      const stableCenter = computeStableDocCenterFromClient(clientX, clientY);
      if (!stableCenter) return;

      const centerX = stableCenter.x;
      const centerY = stableCenter.y;
      const boxCenter = new go.Point(centerX, centerY);
      const desiredPos = new go.Point(
        centerX - manualDragViewportSize.w / 2,
        centerY - manualDragViewportSize.h / 2
      );

      if (!this.diagram.position.equals(desiredPos)) {
        this.diagram.position = desiredPos;
        this.diagram.requestUpdate();
        // 【2026-05-11】检测到实际位移，启用 smartLerp 平滑动画（仅在真实拖拽中）。
        this.hasManualBoxMovement = true;
      }

      // 【2026-04-20 回归修复】同步推导 fakeViewportBounds，确保 applyOverviewUpdate
      // 在部分浏览器 ViewportBoundsChanged 被合并/延迟的情况下仍能跟手刷新 scale
      // 与 fixedBounds，让小地图里的任务块随预览框位置实时重新排布。
      // 这里直接传 boxCenter 作为 centerOverride，第二参（fallbackDocPt）用不到 ——
      // 拖拽中我们已知准确白框中心，无需 fallback。
      updateOverviewBoxViewportBounds(boxCenter);

      if (this.overview) {
        this.overview.updateAllTargetBindings();
        this.overview.requestUpdate();
      }
    };

    const endManualBoxDrag = (): void => {
      if (!isManualBoxDrag) return;
      isManualBoxDrag = false;
      manualDragViewportSize = null;
      manualDragStartBoxCenterDoc = null;
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
        this.overviewBoundsCache = '';
        this.overviewScheduleUpdate?.('viewport');
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

    const applyManualBoxDragFromEvent = (ev: PointerEvent | MouseEvent): void => {
      if (!isManualBoxDrag) return;
      // 【2026-05-09 根因修复】直接传 client 坐标，让 applyManualBoxDrag 内部使用
      // 拖拽起始时捕获的稳定 transform 计算 document 位移，避免依赖
      // overview.transformViewToDoc（其结果会随 overview.scale/position 漂移）。
      applyManualBoxDrag(ev.clientX, ev.clientY);
    };

    const onPointerMove = (ev: PointerEvent): void => {
      if (!isDraggingBox || !this.overview) return;

      if (isManualBoxDrag) {
        stopEventForManualDrag(ev);
      }

      if (capturedPointerId !== null && ev.pointerId !== capturedPointerId) return;
      applyManualBoxDragFromEvent(ev);
      this.overviewScheduleUpdate?.('viewport');
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
        this.overviewReleaseViewportBounds = this.overviewBoxViewportBounds?.isReal()
          ? this.overviewBoxViewportBounds.copy()
          : null;
      }
      this.isOverviewBoxDragging = false;
      this.isOverviewInteracting = false;
      this.overviewInteractionLastApplyAt = 0;
      this.overviewBoxViewportBounds = null;

      if (this.throttledUpdateBindingsTimer) {
        clearTimeout(this.throttledUpdateBindingsTimer);
        this.throttledUpdateBindingsTimer = null;
      }
      this.throttledUpdateBindingsPending = false;

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

      resetOverviewInteractionState();
      
      if (wasDraggingBox) {
        this.overviewBoundsCache = '';
        this.overviewScheduleUpdate?.('viewport');

        if (this.overviewInteractionRefreshRafId !== null) {
          cancelAnimationFrame(this.overviewInteractionRefreshRafId);
        }
        this.overviewInteractionRefreshRafId = requestAnimationFrame(() => {
          this.overviewInteractionRefreshRafId = null;
          if (this.isDestroyed || !this.overview) return;
          this.overview.updateAllTargetBindings();
          this.overview.requestUpdate();
        });
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
      applyManualBoxDragFromEvent(ev);
      this.overviewScheduleUpdate?.('viewport');
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
        this.overviewBoundsCache = '';
        this.overviewScheduleUpdate?.('viewport');
      }
    };
    const onMouseMove = (ev: MouseEvent): void => {
      if (!isMouseDraggingBox) return;
      applyManualBoxDragFromEvent(ev);
      this.overviewScheduleUpdate?.('viewport');
    };
    const onMouseUp = (ev: MouseEvent): void => {
      if (!isMouseDraggingBox) return;
      if (isManualBoxDrag) {
        stopEventForManualDrag(ev);
        applyManualBoxDragFromEvent(ev);
      }
      resetOverviewInteractionState();
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

      container.addEventListener('mousedown', onMouseDown, { passive: false, capture: true });
      window.addEventListener('mousemove', onMouseMove, { passive: true });
      window.addEventListener('mouseup', onMouseUp, { passive: true });
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

      container.removeEventListener('mousedown', onMouseDown, { capture: true } as EventListenerOptions);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }
}







