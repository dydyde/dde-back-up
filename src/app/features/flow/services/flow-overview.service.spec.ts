import { TestBed } from '@angular/core/testing';
import { NgZone } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as go from 'gojs';

import { FlowOverviewService } from './flow-overview.service';
import { LoggerService } from '../../../../services/logger.service';
import { ThemeService } from '../../../../services/theme.service';
import { FlowTemplateService } from './flow-template.service';
import { FlowLinkTemplateService } from './flow-link-template.service';
import { FlowDiagramConfigService } from './flow-diagram-config.service';

vi.mock('gojs', () => {
  class Point {
    constructor(
      public x = 0,
      public y = 0
    ) {}

    copy(): Point {
      return new Point(this.x, this.y);
    }

    equals(point: Point): boolean {
      return this.x === point.x && this.y === point.y;
    }
  }

  class Rect {
    constructor(
      public x = 0,
      public y = 0,
      public width = 0,
      public height = 0
    ) {}

    get right(): number {
      return this.x + this.width;
    }

    get bottom(): number {
      return this.y + this.height;
    }

    get center(): Point {
      return new Point(this.x + this.width / 2, this.y + this.height / 2);
    }

    isReal(): boolean {
      return [this.x, this.y, this.width, this.height].every(Number.isFinite);
    }

    containsPoint(point: Point): boolean {
      return point.x >= this.x && point.x <= this.right && point.y >= this.y && point.y <= this.bottom;
    }

    copy(): Rect {
      return new Rect(this.x, this.y, this.width, this.height);
    }

    unionRect(rect: Rect): Rect {
      const minX = Math.min(this.x, rect.x);
      const minY = Math.min(this.y, rect.y);
      const maxX = Math.max(this.right, rect.right);
      const maxY = Math.max(this.bottom, rect.bottom);
      this.x = minX;
      this.y = minY;
      this.width = maxX - minX;
      this.height = maxY - minY;
      return this;
    }
  }

  class Overview {
    box = { actualBounds: new Rect(10, 10, 100, 80) };
    centerRect = vi.fn();
    requestUpdate = vi.fn();
    transformViewToDoc = vi.fn((point: Point) => point);
    updateAllTargetBindings = vi.fn();
    div: HTMLDivElement | null;
    fixedBounds: Rect | undefined;
    observed: unknown;
    scale = 1;
    updateDelay = 0;

    constructor(div: HTMLDivElement, options: Record<string, unknown>) {
      this.div = div;
      Object.assign(this, options);
    }
  }

  return {
    Overview,
    Point,
    Rect,
    Spot: { Center: new Point(0.5, 0.5) },
    AutoScale: { None: 1, Uniform: 2, UniformToFill: 3 },
  };
});

describe('FlowOverviewService', () => {
  let service: FlowOverviewService;
  let container: HTMLDivElement;
  let diagramPosition: InstanceType<typeof go.Point>;
  let observedViewportPosition: InstanceType<typeof go.Point>;
  let documentBounds: InstanceType<typeof go.Rect>;
  let delayViewportCommit: boolean;
  let viewportListener: (() => void) | null;
  let originalRequestAnimationFrame: typeof globalThis.requestAnimationFrame | undefined;
  let originalCancelAnimationFrame: typeof globalThis.cancelAnimationFrame | undefined;

  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    diagramPosition = new go.Point(0, 0);
    observedViewportPosition = new go.Point(0, 0);
    documentBounds = new go.Rect(0, 0, 400, 300);
    delayViewportCommit = false;
    viewportListener = null;

    originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback): number =>
      setTimeout(() => callback(0), 0) as unknown as number) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = ((id: number): void => {
      clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
    }) as typeof cancelAnimationFrame;

    TestBed.configureTestingModule({
      providers: [
        FlowOverviewService,
        { provide: LoggerService, useValue: { category: () => logger } },
        { provide: ThemeService, useValue: { isDark: () => false } },
        { provide: FlowTemplateService, useValue: { setupOverviewNodeTemplate: vi.fn(), setupOverviewBoxStyle: vi.fn() } },
        { provide: FlowLinkTemplateService, useValue: { setupOverviewLinkTemplate: vi.fn() } },
        { provide: FlowDiagramConfigService, useValue: { currentStyles: () => ({ text: { titleColor: '#292524' } }) } },
        { provide: NgZone, useValue: new NgZone({ enableLongStackTrace: false }) },
      ],
    });

    service = TestBed.inject(FlowOverviewService);
    container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', { configurable: true, value: 180 });
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 140 });
    container.setPointerCapture = vi.fn();
    container.releasePointerCapture = vi.fn();
    document.body.appendChild(container);

    service.setDiagram(createDiagramMock());
    service.initializeOverview(container, false);
    vi.runOnlyPendingTimers();
  });

  afterEach(() => {
    service.destroyOverview();
    container.remove();
    if (originalRequestAnimationFrame) {
      globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    } else {
      Reflect.deleteProperty(globalThis as unknown as Record<string, unknown>, 'requestAnimationFrame');
    }
    if (originalCancelAnimationFrame) {
      globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
    } else {
      Reflect.deleteProperty(globalThis as unknown as Record<string, unknown>, 'cancelAnimationFrame');
    }
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  it('Overview 必须显式 autoScale=None 以保证 scale/centerRect 不被 GoJS 默认 Uniform 自动重居中（根因回归）', () => {
    // 【2026-05-10 根因回归】GoJS Overview 默认 autoScale=Uniform 会让所有
    // `overview.scale = X` 与 `overview.centerRect(rect)` 调用变成静默 no-op，
    // 改由 autoScale 把 documentBounds(=fixedBounds) 自动适配并居中到 canvas，
    // 锚点会变成 worldBounds.center 而非我们想要的 viewportBounds.center —
    // 这直接导致 press/release 状态切换时缩略块相对 box 跳变（与主视图脱节）。
    // 本用例守护 Overview 实例的 autoScale 必须为 None，避免回归。
    const overview = service.overviewInstance as unknown as { autoScale: number };
    expect(overview.autoScale).toBe(go.AutoScale.None);
  });

  it('Overview 必须禁用内建交互，避免与手动 box 拖拽竞争', () => {
    const overview = service.overviewInstance as unknown as { isEnabled: boolean };
    expect(overview.isEnabled).toBe(false);
  });

  it('松开小地图预览框后仍按最后拖拽视口重绘，避免内容弹跳', () => {
    const overview = service.overviewInstance as unknown as {
      centerRect: ReturnType<typeof vi.fn>;
    };

    dispatchPointer('pointerdown', 20, 20);
    vi.runOnlyPendingTimers();
    dispatchPointer('pointermove', 120, 90);
    vi.runOnlyPendingTimers();
    const callsBeforeRelease = overview.centerRect.mock.calls.length;

    dispatchPointer('pointerup', 120, 90);
    vi.runOnlyPendingTimers();

    expect(overview.centerRect.mock.calls.length).toBe(callsBeforeRelease + 1);
    const finalCenteredBounds = overview.centerRect.mock.calls.at(-1)?.[0] as InstanceType<typeof go.Rect>;
    expectCenteredBoundsToContainViewport(finalCenteredBounds, diagramPosition.x, diagramPosition.y);
  });

  it('pointerup 后的 lostpointercapture 不应清空待同步的释放视口', () => {
    const overview = service.overviewInstance as unknown as {
      centerRect: ReturnType<typeof vi.fn>;
    };

    dispatchPointer('pointerdown', 20, 20);
    vi.runOnlyPendingTimers();
    dispatchPointer('pointermove', 120, 90);
    vi.runOnlyPendingTimers();
    const callsBeforeRelease = overview.centerRect.mock.calls.length;

    dispatchPointer('pointerup', 120, 90);
    dispatchPointer('lostpointercapture', 120, 90);
    vi.runOnlyPendingTimers();

    expect(overview.centerRect.mock.calls.length).toBe(callsBeforeRelease + 1);
    const finalCenteredBounds = overview.centerRect.mock.calls.at(-1)?.[0] as InstanceType<typeof go.Rect>;
    expectCenteredBoundsToContainViewport(finalCenteredBounds, diagramPosition.x, diagramPosition.y);
  });

  it('observed viewport 延迟追上前不应提前丢失释放锁', () => {
    const overview = service.overviewInstance as unknown as {
      centerRect: ReturnType<typeof vi.fn>;
    };

    dispatchPointer('pointerdown', 20, 20);
    vi.runOnlyPendingTimers();
    dispatchPointer('pointermove', 80, 60);
    vi.runOnlyPendingTimers();

    delayViewportCommit = true;
    dispatchPointer('pointerup', 120, 90);
    vi.runOnlyPendingTimers();

    const callsAfterRelease = overview.centerRect.mock.calls.length;
    const releaseCall = overview.centerRect.mock.calls.at(-1)?.[0] as InstanceType<typeof go.Rect>;
    expectCenteredBoundsToContainViewport(releaseCall, diagramPosition.x, diagramPosition.y);

    viewportListener?.();
    vi.runOnlyPendingTimers();

    expect(overview.centerRect.mock.calls.length).toBeGreaterThan(callsAfterRelease);
    const staleObservedCall = overview.centerRect.mock.calls.at(-1)?.[0] as InstanceType<typeof go.Rect>;
    expectCenteredBoundsToContainViewport(staleObservedCall, diagramPosition.x, diagramPosition.y);

    delayViewportCommit = false;
    commitObservedViewportPosition();
    vi.runOnlyPendingTimers();

    const caughtUpCall = overview.centerRect.mock.calls.at(-1)?.[0] as InstanceType<typeof go.Rect>;
    expectCenteredBoundsToContainViewport(caughtUpCall, diagramPosition.x, diagramPosition.y);
  });

  it('点击小地图预览框但不移动时不应改变主视图位置', () => {
    const overview = service.overviewInstance as unknown as {
      centerRect: ReturnType<typeof vi.fn>;
    };

    dispatchPointer('pointerdown', 20, 20);
    vi.runOnlyPendingTimers();
    dispatchPointer('pointerup', 20, 20);
    vi.runOnlyPendingTimers();

    expect(diagramPosition.x).toBe(0);
    expect(diagramPosition.y).toBe(0);
    const finalCenteredBounds = overview.centerRect.mock.calls.at(-1)?.[0] as InstanceType<typeof go.Rect>;
    expectCenteredBoundsToContainViewport(finalCenteredBounds, 0, 0);
  });

  it('松开后续视口刷新仍以 viewport 中心为锚（避免方向不定的跳变）', () => {
    const overview = service.overviewInstance as unknown as {
      centerRect: ReturnType<typeof vi.fn>;
    };

    // 拖拽预览框，让 diagram.position 远离节点群，使 viewportBounds 落在 nodeBounds 之外
    dispatchPointer('pointerdown', 20, 20);
    vi.runOnlyPendingTimers();
    dispatchPointer('pointermove', 500, 400);
    vi.runOnlyPendingTimers();
    dispatchPointer('pointerup', 500, 400);
    vi.runOnlyPendingTimers();

    const callsAfterRelease = overview.centerRect.mock.calls.length;
    const releaseX = diagramPosition.x;
    const releaseY = diagramPosition.y;

    // 模拟松手后第二帧的 ViewportBoundsChanged（位置不再变，但 GoJS 会再触发一次）
    viewportListener?.();
    vi.runOnlyPendingTimers();

    expect(overview.centerRect.mock.calls.length).toBeGreaterThan(callsAfterRelease);
    const followUpCall = overview.centerRect.mock.calls.at(-1)?.[0] as InstanceType<typeof go.Rect>;
    expectCenteredBoundsToContainViewport(followUpCall, releaseX, releaseY);
  });

  it('viewport 在节点群内点击不动并回放后续刷新时，预览框始终以 viewport 为锚（消除根因型跳变）', () => {
    // 【2026-05-09 根因回归】用户报告：viewport 落在节点群内时点击预览框，
    // - 点击瞬间预览框居中（apply 走 manual/centerRect viewportBounds 分支）→ 正确
    // - 松手 + 后续 ViewportBoundsChanged 重绘 → 旧逻辑 usingManualViewportBounds=false
    //   且 isViewportOutside=false，跳过 centerRect，落到 contentAlignment: Spot.Center
    //   把 worldBounds=nodeBounds∪vb 的几何中心对准容器中心，与 viewportBounds.center
    //   错位 → 预览框相对容器跳到不同位置，缩略块和主视图脱节。
    // 修复后：apply 路径无条件 centerRect(viewportBounds)，contentAlignment 也已移除，
    // 后续刷新仍以 viewport 中心为锚，无跳变。
    documentBounds = new go.Rect(-2000, -2000, 5000, 4000); // 节点群远大于 viewport，确保 viewport 处于节点群内
    viewportListener?.(); // 让服务感知 documentBounds 变化
    vi.runOnlyPendingTimers();

    const overview = service.overviewInstance as unknown as {
      centerRect: ReturnType<typeof vi.fn>;
    };

    dispatchPointer('pointerdown', 20, 20);
    vi.runOnlyPendingTimers();
    // 不移动，直接松手
    dispatchPointer('pointerup', 20, 20);
    vi.runOnlyPendingTimers();

    const callsAfterRelease = overview.centerRect.mock.calls.length;

    // 模拟松手后第二帧的 ViewportBoundsChanged（GoJS 渲染过程中可能再触发一次）
    viewportListener?.();
    vi.runOnlyPendingTimers();

    expect(overview.centerRect.mock.calls.length).toBeGreaterThan(callsAfterRelease);
    const followUpCall = overview.centerRect.mock.calls.at(-1)?.[0] as InstanceType<typeof go.Rect>;
    expectCenteredBoundsToContainViewport(followUpCall, 0, 0);
    // 主视图位置也未受影响。
    expect(diagramPosition.x).toBe(0);
    expect(diagramPosition.y).toBe(0);
  });

  it('should intercept default pointerup to prevent GoJS double-centering on release', () => {
    const overview = service.overviewInstance as unknown as {
      centerRect: ReturnType<typeof vi.fn>;
    };
    const bubblePointerUp = vi.fn();
    container.addEventListener('pointerup', bubblePointerUp);

    dispatchPointer('pointerdown', 20, 20);
    vi.runOnlyPendingTimers();
    dispatchPointer('pointerup', 120, 90);
    vi.runOnlyPendingTimers();

    expect(bubblePointerUp).not.toHaveBeenCalled();
    const finalCenteredBounds = overview.centerRect.mock.calls.at(-1)?.[0] as InstanceType<typeof go.Rect>;
    expectCenteredBoundsToContainViewport(finalCenteredBounds, 100, 70);
  });

  it('should apply pointerup coordinates when the final pointermove is missing', () => {
    const overview = service.overviewInstance as unknown as {
      centerRect: ReturnType<typeof vi.fn>;
    };

    dispatchPointer('pointerdown', 20, 20);
    vi.runOnlyPendingTimers();
    dispatchPointer('pointerup', 120, 90);
    vi.runOnlyPendingTimers();

    const finalCenteredBounds = overview.centerRect.mock.calls.at(-1)?.[0] as InstanceType<typeof go.Rect>;
    expectCenteredBoundsToContainViewport(finalCenteredBounds, 100, 70);
    expect(diagramPosition.x).toBe(100);
    expect(diagramPosition.y).toBe(70);
  });

  it('支持 Pointer Events 时不应再响应兼容 mouse 拖拽事件', () => {
    dispatchPointer('pointerdown', 20, 20);
    vi.runOnlyPendingTimers();

    dispatchMouse(container, 'mousedown', 20, 20);
    dispatchMouse(window, 'mousemove', 120, 90);
    dispatchMouse(window, 'mouseup', 120, 90);
    vi.runOnlyPendingTimers();

    expect(diagramPosition.x).toBe(0);
    expect(diagramPosition.y).toBe(0);

    dispatchPointer('pointerup', 20, 20);
    vi.runOnlyPendingTimers();
  });

  it('拖拽移动时应把 Overview 重绘合并到调度帧，而不是同步重绘', () => {
    const overview = service.overviewInstance as unknown as {
      requestUpdate: ReturnType<typeof vi.fn>;
    };

    dispatchPointer('pointerdown', 20, 20);
    vi.runOnlyPendingTimers();
    const callsBeforeMove = overview.requestUpdate.mock.calls.length;

    dispatchPointer('pointermove', 120, 90);
    expect(overview.requestUpdate.mock.calls.length).toBe(callsBeforeMove);

    vi.runOnlyPendingTimers();

    expect(overview.requestUpdate.mock.calls.length).toBeGreaterThan(callsBeforeMove);
  });

  it('远距离拖拽后松手不应再触发 scale 回弹', () => {
    const overview = service.overviewInstance as unknown as {
      scale: number;
    };

    dispatchPointer('pointerdown', 20, 20);
    vi.runOnlyPendingTimers();

    dispatchPointer('pointermove', 500, 400);
    vi.runOnlyPendingTimers();
    const scaleAfterMove = overview.scale;

    dispatchPointer('pointerup', 500, 400);
    vi.runOnlyPendingTimers();

    expect(overview.scale).toBe(scaleAfterMove);
  });

  it('松开后位置不受拖拽中途 overview.scale 变化影响（稳定 view→doc 映射）', () => {
    // 【2026-05-09 根因回归】拖拽过程中如果 transformViewToDoc 依赖的
    // overview.scale 变化（applyOverviewUpdate 通过 smartLerp 修改 scale），
    // 会让同一 client 坐标在不同帧映射到不同 doc 点，松手时累计漂移。
    // 本用例显式在 pointermove 之间修改 overview.scale，验证最终
    // diagram.position 仍只与 (起始点 → 释放点) 的 client 位移成比例。
    const overview = service.overviewInstance as unknown as {
      centerRect: ReturnType<typeof vi.fn>;
      scale: number;
      transformViewToDoc: (point: InstanceType<typeof go.Point>) => InstanceType<typeof go.Point>;
    };
    // 让 transformViewToDoc 反映 scale（更接近真实 GoJS 行为）：
    // doc = viewPt / overview.scale（假设 overview.position=0）。
    overview.transformViewToDoc = (point) =>
      new go.Point(point.x / overview.scale, point.y / overview.scale);
    overview.scale = 1;

    dispatchPointer('pointerdown', 20, 20);
    vi.runOnlyPendingTimers();
    const positionBeforeMove = diagramPosition.copy();

    dispatchPointer('pointermove', 80, 60);
    vi.runOnlyPendingTimers();

    // 在中途模拟 applyOverviewUpdate 修改 overview.scale —— 在出现该修复前，
    // 这会让后续帧 transformViewToDoc 给出不同的 doc 坐标，导致松手位置漂移。
    overview.scale = 0.5;

    dispatchPointer('pointermove', 120, 90);
    vi.runOnlyPendingTimers();

    dispatchPointer('pointerup', 120, 90);
    vi.runOnlyPendingTimers();

    // 起始中心来自主图 viewportBounds.center (400, 300)，view 映射因子=1。
    // client 位移 (100, 70) → viewport center 推到 (500, 370)，
    // viewport 大小 800x600 → diagram.position = (100, 70)。
    expect(diagramPosition.x).toBe(100);
    expect(diagramPosition.y).toBe(70);
    expect(diagramPosition.x).not.toBe(positionBeforeMove.x);

    // 松手帧 centerRect 也应锚定到与 diagram.position 一致的 viewportBounds，
    // 不出现"小地图缩略块在某区域、主视图却看不到那些块"的脱节现象。
    const finalCenteredBounds = overview.centerRect.mock.calls.at(-1)?.[0] as InstanceType<typeof go.Rect>;
    expectCenteredBoundsToContainViewport(finalCenteredBounds, 100, 70);
  });

  it('【根因回归 2026-05-11】press → release（不移动）后 overview.scale 必须严格保持稳定（消除 smartLerp 残差跳动）', () => {
    // 真正的根因：旧实现在 applyOverviewUpdate 中无条件用 smartLerp（18%/45%）
    // 推进 overview.scale 向 target 收敛。终止条件 `|target - current| > 0.002`
    // 意味着 idle 状态 scale 长期停在"接近但不等于 target"的位置。
    //   - press 触发一次 apply → smartLerp 推进一小步 → scale 变化 1 次。
    //   - release 触发一次 apply → smartLerp 再推进一小步 → scale 变化 2 次。
    //   - 每次 scale 变化都让节点位置 `(loc - position) * scale` 重新映射到不同
    //     canvas 像素 → 视觉上即"缩略块跃动且与主视图脱节"。
    // 修复后：仅当 box 正被实际拖拽（hasManualBoxMovement）才走 smartLerp，
    // press/release 不动场景一律 snap 到 target，apply 对稳定输入严格幂等。
    const overview = service.overviewInstance as unknown as {
      scale: number;
    };

    // 模拟真实使用场景：用户已经看过流程图，scale 已收敛到 target。
    // 这里通过先回放一次 ViewportBoundsChanged 让 idle apply 把 scale snap 到 target。
    viewportListener?.();
    vi.runOnlyPendingTimers();
    const scaleAfterIdle = overview.scale;

    // press 不动
    dispatchPointer('pointerdown', 20, 20);
    vi.runOnlyPendingTimers();
    const scaleAfterPress = overview.scale;

    // release 不动
    dispatchPointer('pointerup', 20, 20);
    vi.runOnlyPendingTimers();
    const scaleAfterRelease = overview.scale;

    // 关键断言：稳定输入 ⇒ 稳定 scale ⇒ 缩略块无跃动。
    // 严格相等（snap 实现保证完全幂等，而非"近似相等"）。
    expect(scaleAfterPress).toBe(scaleAfterIdle);
    expect(scaleAfterRelease).toBe(scaleAfterIdle);

    // 主视图位置同样不应变化。
    expect(diagramPosition.x).toBe(0);
    expect(diagramPosition.y).toBe(0);
  });

  it('【回归保护】实际拖拽 box（press → move → release）仍能正常驱动主视图位置变化', () => {
    // 修复 smartLerp 残差不应破坏真实拖拽行为：当用户产生实际位移时，
    // hasManualBoxMovement=true，smartLerp 平滑动画照常生效，diagram.position
    // 按 client 位移成比例更新。
    dispatchPointer('pointerdown', 20, 20);
    vi.runOnlyPendingTimers();
    dispatchPointer('pointermove', 120, 90);
    vi.runOnlyPendingTimers();
    dispatchPointer('pointerup', 120, 90);
    vi.runOnlyPendingTimers();

    // client 位移 (100, 70) 应反映到 diagram.position（mock 中 view→doc 因子=1）。
    expect(diagramPosition.x).toBe(100);
    expect(diagramPosition.y).toBe(70);
  });

  function createDiagramMock(): go.Diagram {
    const listeners = new Map<string, () => void>();
    const diagram = {
      get documentBounds(): InstanceType<typeof go.Rect> {
        return documentBounds;
      },
      model: { nodeDataArray: [{ key: 'a' }] },
      skipsUndoManager: false,
      requestUpdate: vi.fn(),
      addDiagramListener: vi.fn((name: string, handler: () => void) => {
        listeners.set(name, handler);
        if (name === 'ViewportBoundsChanged') {
          viewportListener = handler;
        }
      }),
      removeDiagramListener: vi.fn((name: string) => listeners.delete(name)),
      get position(): InstanceType<typeof go.Point> {
        return diagramPosition;
      },
      set position(value: InstanceType<typeof go.Point>) {
        diagramPosition = value.copy();
        if (!delayViewportCommit) {
          observedViewportPosition = value.copy();
        }
        viewportListener?.();
      },
      get viewportBounds(): InstanceType<typeof go.Rect> {
        return new go.Rect(observedViewportPosition.x, observedViewportPosition.y, 800, 600);
      },
    };

    return diagram as unknown as go.Diagram;
  }

  function dispatchPointer(type: string, clientX: number, clientY: number): void {
    container.dispatchEvent(new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      clientX,
      clientY,
    }));
  }

  function dispatchMouse(target: EventTarget, type: string, clientX: number, clientY: number): void {
    target.dispatchEvent(new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
    }));
  }

  function commitObservedViewportPosition(): void {
    observedViewportPosition = diagramPosition.copy();
    viewportListener?.();
  }

  function expectCenteredBoundsToContainViewport(
    bounds: InstanceType<typeof go.Rect>,
    x: number,
    y: number,
  ): void {
    expect(bounds.x).toBeLessThanOrEqual(x);
    expect(bounds.y).toBeLessThanOrEqual(y);
    expect(bounds.right).toBeGreaterThanOrEqual(x + 800);
    expect(bounds.bottom).toBeGreaterThanOrEqual(y + 600);
  }

  it('overview.box.actualBounds 未就绪时 pointerdown 应安全 no-op，不修改 diagramPosition（_getOriginRect 守卫）', () => {
    // 【2026-05-15 根因回归】GoJS Overview 在首次 measure 完成前
    // `overview.box.actualBounds` 内部 Rect 为 null，再调 `transformViewToDoc`
    // 会触发 "Cannot read properties of null (reading 'width')" at _getOriginRect。
    // 这里把 box.actualBounds 替换为 NaN Rect（isReal=false）来模拟 overview 未就绪场景，
    // beginManualBoxDrag 应当早出，整个拖拽周期不应抛错，diagram.position 也不应被修改。
    const overview = service.overviewInstance as unknown as {
      box: { actualBounds: InstanceType<typeof go.Rect> };
    };
    overview.box.actualBounds = new go.Rect(NaN, NaN, NaN, NaN);

    const beforeX = diagramPosition.x;
    const beforeY = diagramPosition.y;

    // 不应抛任何异常
    expect(() => {
      dispatchPointer('pointerdown', 20, 20);
      vi.runOnlyPendingTimers();
      dispatchPointer('pointermove', 120, 90);
      vi.runOnlyPendingTimers();
      dispatchPointer('pointerup', 120, 90);
      vi.runOnlyPendingTimers();
    }).not.toThrow();

    // 由于 beginManualBoxDrag 早出，diagram.position 完全没被改动
    expect(diagramPosition.x).toBe(beforeX);
    expect(diagramPosition.y).toBe(beforeY);
  });
});
