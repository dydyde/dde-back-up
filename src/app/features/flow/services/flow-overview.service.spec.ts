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
    box = { actualBounds: new Rect(10, 10, 100, 80), position: new Point(10, 10) };
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
  let diagramRequestUpdate: ReturnType<typeof vi.fn>;
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
    diagramRequestUpdate = vi.fn();

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

  it('Overview 不应设置 contentAlignment，避免按容器居中后让预览框与主视图脱节', () => {
    const overview = service.overviewInstance as unknown as { contentAlignment?: unknown };
    expect(overview.contentAlignment).toBeUndefined();
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

  // ============ 2026-05-15 A1/A2/A4 根因修复回归（PR #64）============

  it('A1：documentBounds 未就绪时初始化必须保持 overview.observed 为 null', () => {
    // 销毁 beforeEach 创建的实例，重新走未就绪路径
    service.destroyOverview();
    container.remove();

    container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', { configurable: true, value: 180 });
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 140 });
    container.setPointerCapture = vi.fn();
    container.releasePointerCapture = vi.fn();
    document.body.appendChild(container);

    // 让 documentBounds.isReal() 返回 false（width/height 为 NaN）
    documentBounds = new go.Rect(0, 0, NaN, NaN);
    const diagramMock = createDiagramMock();
    service.setDiagram(diagramMock);
    service.initializeOverview(container, false);
    vi.runOnlyPendingTimers();

    const overview = service.overviewInstance as unknown as { observed: unknown };
    expect(overview).toBeTruthy();
    // 未就绪：observed 必须不是 diagram
    expect(overview.observed).not.toBe(diagramMock);
  });

  it('A1：documentBounds 就绪后通过 InitialLayoutCompleted 回填 observed', () => {
    service.destroyOverview();
    container.remove();
    container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', { configurable: true, value: 180 });
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 140 });
    container.setPointerCapture = vi.fn();
    container.releasePointerCapture = vi.fn();
    document.body.appendChild(container);

    documentBounds = new go.Rect(0, 0, NaN, NaN);

    // 自建 diagram，捕获 InitialLayoutCompleted listener 引用
    let initialLayoutHandler: (() => void) | null = null;
    const diagramMock = {
      get documentBounds(): InstanceType<typeof go.Rect> {
        return documentBounds;
      },
      model: { nodeDataArray: [{ key: 'a' }] },
      skipsUndoManager: false,
      requestUpdate: vi.fn(),
      addDiagramListener: vi.fn((name: string, handler: () => void) => {
        if (name === 'InitialLayoutCompleted') initialLayoutHandler = handler;
        if (name === 'ViewportBoundsChanged') viewportListener = handler;
      }),
      removeDiagramListener: vi.fn(),
      get position(): InstanceType<typeof go.Point> {
        return diagramPosition;
      },
      set position(value: InstanceType<typeof go.Point>) {
        diagramPosition = value.copy();
        viewportListener?.();
      },
      get viewportBounds(): InstanceType<typeof go.Rect> {
        return new go.Rect(0, 0, 800, 600);
      },
    } as unknown as go.Diagram;

    service.setDiagram(diagramMock);
    service.initializeOverview(container, false);
    vi.runOnlyPendingTimers();

    const overview = service.overviewInstance as unknown as { observed: unknown };
    expect(overview.observed).not.toBe(diagramMock);
    expect(initialLayoutHandler).toBeTruthy();

    // 模拟首次布局完成
    documentBounds = new go.Rect(0, 0, 400, 300);
    initialLayoutHandler!();

    expect(overview.observed).toBe(diagramMock);
  });

  it('A2：销毁后所有 setter 必须 no-op，不抛错', () => {
    // 销毁后再调用任何 public 方法都不能抛错
    service.destroyOverview();

    expect(() => service.refreshOverview()).not.toThrow();
    expect(() => service.updateTheme()).not.toThrow();
    expect(service.overviewInstance).toBeNull();
    expect(service.isOverviewInitialized).toBe(false);
  });

  it('A2：销毁时必须 observed=null 再 div=null，杜绝异步 tick 持有 stale 引用', () => {
    const overview = service.overviewInstance as unknown as {
      observed: unknown;
      div: HTMLDivElement | null;
    };
    expect(overview.observed).toBeTruthy();
    expect(overview.div).toBe(container);

    service.destroyOverview();

    // 销毁后 service 内部引用被释放，overviewInstance 应为 null
    expect(service.overviewInstance).toBeNull();
    // GoJS Overview 实例本身的 observed / div 应已被解除
    expect(overview.observed).toBeNull();
    expect(overview.div).toBeNull();
  });

  it('A4：注册全局自愈钩子 __NANOFLOW_OVERVIEW_HEAL__，调用时触发 requestUpdate', () => {
    type HealWindow = Window & { __NANOFLOW_OVERVIEW_HEAL__?: () => void };
    const heal = (window as HealWindow).__NANOFLOW_OVERVIEW_HEAL__;
    expect(typeof heal).toBe('function');

    const overview = service.overviewInstance as unknown as {
      requestUpdate: ReturnType<typeof vi.fn>;
    };
    const before = overview.requestUpdate.mock.calls.length;

    heal!();

    expect(overview.requestUpdate.mock.calls.length).toBe(before + 1);
  });

  it('A4：销毁后调用自愈钩子必须 no-op（不能再触发 stale overview）', () => {
    type HealWindow = Window & { __NANOFLOW_OVERVIEW_HEAL__?: () => void };
    const heal = (window as HealWindow).__NANOFLOW_OVERVIEW_HEAL__;

    service.destroyOverview();

    // 销毁后自愈钩子应被卸载，或调用时安全 no-op
    expect(() => heal?.()).not.toThrow();
    expect((window as HealWindow).__NANOFLOW_OVERVIEW_HEAL__).toBeUndefined();
  });

  // ============ 2026-05-15 性能修复回归（PR #65）============

  it('【2026-05-15 性能修复 P4】拖拽时 pointermove 必须 rAF 合流：同一帧内多次 pointermove 不同步写主图，且只保留最后一次坐标', () => {
    dispatchPointer('pointerdown', 20, 20);
    vi.runOnlyPendingTimers();
    const positionBeforeMove = diagramPosition.copy();

    // 同一帧（fake timers 未运行）内连续三次 pointermove
    dispatchPointer('pointermove', 30, 30);
    dispatchPointer('pointermove', 60, 50);
    dispatchPointer('pointermove', 100, 80);

    // rAF 尚未 flush：position 不应被同步写入（消除每个 pointermove 的同步主图重绘）
    expect(diagramPosition.x).toBe(positionBeforeMove.x);
    expect(diagramPosition.y).toBe(positionBeforeMove.y);

    // 推进 rAF：3 次 pointermove 应合流为一次 apply，diagramPosition 直接跳到最后一次坐标
    // （client 位移 100-20=80, 80-20=60，view→doc factor=1）
    vi.runOnlyPendingTimers();
    expect(diagramPosition.x).toBe(80);
    expect(diagramPosition.y).toBe(60);

    dispatchPointer('pointerup', 100, 80);
    vi.runOnlyPendingTimers();
  });

  it('【性能修复】拖拽帧直接移动 overview.box，且不强制 requestUpdate 主图', () => {
    const overview = service.overviewInstance as unknown as {
      box: { position: InstanceType<typeof go.Point> };
    };

    dispatchPointer('pointerdown', 20, 20);
    vi.runOnlyPendingTimers();
    diagramRequestUpdate.mockClear();

    dispatchPointer('pointermove', 120, 90);
    expect(diagramPosition.x).toBe(0);
    expect(diagramPosition.y).toBe(0);

    vi.runOnlyPendingTimers();

    expect(overview.box.position.x).toBe(450);
    expect(overview.box.position.y).toBe(330);
    expect(diagramPosition.x).toBe(100);
    expect(diagramPosition.y).toBe(70);
    expect(diagramRequestUpdate).not.toHaveBeenCalled();

    dispatchPointer('pointerup', 120, 90);
    vi.runOnlyPendingTimers();
  });

  it('【性能修复】拖拽期间必须复用 overview 容器 rect，避免每次 pointermove 触发布局读', () => {
    const rectSpy = vi.fn(() => ({
      left: 0,
      top: 0,
      right: 180,
      bottom: 140,
      width: 180,
      height: 140,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect));
    Object.defineProperty(container, 'getBoundingClientRect', {
      configurable: true,
      value: rectSpy,
    });

    dispatchPointer('pointerdown', 20, 20);
    vi.runOnlyPendingTimers();
    const callsAfterDragStart = rectSpy.mock.calls.length;

    dispatchPointer('pointermove', 30, 30);
    dispatchPointer('pointermove', 60, 50);
    dispatchPointer('pointermove', 100, 80);

    expect(rectSpy.mock.calls.length).toBe(callsAfterDragStart);

    vi.runOnlyPendingTimers();
    dispatchPointer('pointerup', 100, 80);
    vi.runOnlyPendingTimers();

    const callsAfterRelease = rectSpy.mock.calls.length;
    dispatchPointer('pointerdown', 20, 20);

    expect(rectSpy.mock.calls.length).toBeGreaterThan(callsAfterRelease);
  });

  it('【2026-05-15 性能修复 P5】拖拽期间 updateAllTargetBindings 必须经过 16ms 节流（不再每帧调用）', () => {
    const overview = service.overviewInstance as unknown as {
      updateAllTargetBindings: ReturnType<typeof vi.fn>;
    };

    dispatchPointer('pointerdown', 20, 20);
    vi.runOnlyPendingTimers();
    const baseline = overview.updateAllTargetBindings.mock.calls.length;

    // 在 16ms 节流窗口内触发多次 pointermove + rAF flush
    for (let i = 0; i < 5; i += 1) {
      dispatchPointer('pointermove', 30 + i * 10, 30 + i * 10);
      vi.runOnlyPendingTimers(); // rAF flush + overview schedule
    }

    // 节流路径在 16ms 内最多触发 1 次 updateAllTargetBindings；
    // 这里 fake timer 还没推进 16ms，断言 ≤ 1 次新增。
    const dragCalls = overview.updateAllTargetBindings.mock.calls.length - baseline;
    expect(dragCalls).toBeLessThanOrEqual(1);

    dispatchPointer('pointerup', 100, 100);
    vi.runOnlyPendingTimers();
  });

  it('【2026-05-15 性能修复 P6】worldBounds 不变时 setFixedBounds 必须被去重（避免每帧 documentBounds invalidate）', () => {
    const overview = service.overviewInstance as unknown as {
      fixedBounds: InstanceType<typeof go.Rect> | undefined;
    };
    // 包装 fixedBounds 的 setter 以计数
    let fixedBoundsWriteCount = 0;
    let stored: InstanceType<typeof go.Rect> | undefined = overview.fixedBounds;
    Object.defineProperty(overview, 'fixedBounds', {
      configurable: true,
      get(): InstanceType<typeof go.Rect> | undefined {
        return stored;
      },
      set(value: InstanceType<typeof go.Rect> | undefined) {
        fixedBoundsWriteCount += 1;
        stored = value;
      },
    });

    // 触发多次 idle apply（documentBounds 不变）
    viewportListener?.();
    vi.runOnlyPendingTimers();
    const firstWrite = fixedBoundsWriteCount;

    viewportListener?.();
    vi.runOnlyPendingTimers();
    viewportListener?.();
    vi.runOnlyPendingTimers();

    // 后续 idle apply 因 worldBoundsKey 命中缓存而跳过 setFixedBounds
    expect(fixedBoundsWriteCount).toBe(firstWrite);

    // documentBounds 真实变化时必须重新写入
    documentBounds = new go.Rect(0, 0, 800, 600);
    viewportListener?.();
    vi.runOnlyPendingTimers();
    expect(fixedBoundsWriteCount).toBeGreaterThan(firstWrite);
  });

  function createDiagramMock(): go.Diagram {
    const listeners = new Map<string, () => void>();
    const diagram = {
      get documentBounds(): InstanceType<typeof go.Rect> {
        return documentBounds;
      },
      model: { nodeDataArray: [{ key: 'a' }] },
      skipsUndoManager: false,
      requestUpdate: diagramRequestUpdate,
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
});
