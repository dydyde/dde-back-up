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

  it('松开预览框时拦截默认 pointerup，避免 GoJS 再按鼠标点二次居中', () => {
    const bubblePointerUp = vi.fn();
    container.addEventListener('pointerup', bubblePointerUp);

    dispatchPointer('pointerdown', 20, 20);
    vi.runOnlyPendingTimers();
    dispatchPointer('pointerup', 120, 90);
    vi.runOnlyPendingTimers();

    expect(bubblePointerUp).not.toHaveBeenCalled();
  });

  it('没有最终 pointermove 时仍按 pointerup 坐标提交释放视口', () => {
    const overview = service.overviewInstance as unknown as {
      centerRect: ReturnType<typeof vi.fn>;
    };

    dispatchPointer('pointerdown', 20, 20);
    vi.runOnlyPendingTimers();
    dispatchPointer('pointerup', 120, 90);
    vi.runOnlyPendingTimers();

    const finalCenteredBounds = overview.centerRect.mock.calls.at(-1)?.[0] as InstanceType<typeof go.Rect>;
    expect(finalCenteredBounds.x).toBe(-240);
    expect(finalCenteredBounds.y).toBe(-180);
    expect(diagramPosition.x).toBe(-240);
    expect(diagramPosition.y).toBe(-180);
  });

  function createDiagramMock(): go.Diagram {
    const listeners = new Map<string, () => void>();
    const diagram = {
      documentBounds: new go.Rect(0, 0, 400, 300),
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
