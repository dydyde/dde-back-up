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
  };
});

describe('FlowOverviewService', () => {
  let service: FlowOverviewService;
  let container: HTMLDivElement;
  let diagramPosition: InstanceType<typeof go.Point>;
  let documentBounds: InstanceType<typeof go.Rect>;
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
    documentBounds = new go.Rect(0, 0, 400, 300);
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
    expect(finalCenteredBounds.x).toBe(diagramPosition.x);
    expect(finalCenteredBounds.y).toBe(diagramPosition.y);
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
    expect(finalCenteredBounds.x).toBe(diagramPosition.x);
    expect(finalCenteredBounds.y).toBe(diagramPosition.y);
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
    expect(finalCenteredBounds.x).toBe(0);
    expect(finalCenteredBounds.y).toBe(0);
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
    // 关键断言：后续帧仍以 viewport 中心为锚（x/y 与释放时的 diagram.position 一致），
    // 而不是回退到 contentAlignment 的 fixedBounds 几何中心导致的偏移。
    expect(followUpCall.x).toBe(releaseX);
    expect(followUpCall.y).toBe(releaseY);
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
    expect(finalCenteredBounds.x).toBe(100);
    expect(finalCenteredBounds.y).toBe(70);
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
    expect(finalCenteredBounds.x).toBe(100);
    expect(finalCenteredBounds.y).toBe(70);
    expect(diagramPosition.x).toBe(100);
    expect(diagramPosition.y).toBe(70);
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
    expect(finalCenteredBounds.x).toBe(100);
    expect(finalCenteredBounds.y).toBe(70);
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
        viewportListener?.();
      },
      get viewportBounds(): InstanceType<typeof go.Rect> {
        return new go.Rect(diagramPosition.x, diagramPosition.y, 800, 600);
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
});
