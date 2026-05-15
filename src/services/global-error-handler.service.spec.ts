/**
 * GlobalErrorHandler 服务测试
 * 使用 Injector 隔离模式，无需 TestBed
 */
import { Injector, NgZone, runInInjectionContext } from '@angular/core';
import { GlobalErrorHandler, ErrorSeverity } from './global-error-handler.service';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { Router } from '@angular/router';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('GlobalErrorHandler', () => {
  let service: GlobalErrorHandler;
  let loggerSpy: any;
  let toastSpy: any;
  let routerSpy: any;
  let sentryLoaderSpy: any;
  let injector: Injector;

  beforeEach(() => {
    loggerSpy = {
      category: vi.fn().mockReturnThis(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };
    
    toastSpy = {
      error: vi.fn()
    };
    
    routerSpy = {
      navigate: vi.fn()
    };

    sentryLoaderSpy = {
      captureException: vi.fn().mockResolvedValue(undefined),
      captureMessage: vi.fn().mockResolvedValue(undefined)
    };

    injector = Injector.create({
      providers: [
        { provide: LoggerService, useValue: loggerSpy },
        { provide: ToastService, useValue: toastSpy },
        { provide: Router, useValue: routerSpy },
        { provide: SentryLazyLoaderService, useValue: sentryLoaderSpy },
        { provide: NgZone, useValue: { run: (fn: () => void) => fn() } }
      ]
    });

    service = runInInjectionContext(injector, () => new GlobalErrorHandler());
    
    // Mock sessionStorage
    const store: {[key: string]: string} = {};
    vi.spyOn(sessionStorage, 'getItem').mockImplementation((key: string) => store[key] || null);
    vi.spyOn(sessionStorage, 'setItem').mockImplementation((key: string, value: string) => store[key] = value + '');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  it('should handle chunk load error by reloading page', () => {
    // Mock window.location.reload
    const reloadSpy = vi.fn();
    
    // We need to handle the fact that window.location might be read-only
    const originalLocation = window.location;
    // @ts-ignore
    delete window.location;
    // @ts-ignore
    window.location = { reload: reloadSpy };

    try {
      const error = new Error('Failed to fetch dynamically imported module: https://example.com/chunk.js');
      service.handleError(error);

      expect(reloadSpy).toHaveBeenCalled();
      expect(sessionStorage.setItem).toHaveBeenCalledWith('chunk_load_error_reload_timestamp', expect.any(String));
    } finally {
      // @ts-ignore
      window.location = originalLocation;
    }
  });

  it('should not reload if reloaded recently (loop protection)', () => {
    // Mock window.location.reload
    const reloadSpy = vi.fn();
    const originalLocation = window.location;
    // @ts-ignore
    delete window.location;
    // @ts-ignore
    window.location = { reload: reloadSpy };

    // Mock sessionStorage to return a recent timestamp
    const recentTime = Date.now() - 5000; // 5 seconds ago
    vi.mocked(sessionStorage.getItem).mockReturnValue(recentTime.toString());

    try {
      const error = new Error('ChunkLoadError: Loading chunk 123 failed.');
      service.handleError(error);

      expect(reloadSpy).not.toHaveBeenCalled();
      // Should have logged error and maybe called handleFatalError (which logs error)
      expect(loggerSpy.error).toHaveBeenCalledWith(expect.stringMatching(/Chunk load error persisted/), expect.any(Object));
    } finally {
      // @ts-ignore
      window.location = originalLocation;
    }
  });

  it('should suppress repeated chunk errors after a recent reload', () => {
    const reloadSpy = vi.fn();
    const originalLocation = window.location;
    // @ts-ignore
    delete window.location;
    // @ts-ignore
    window.location = { reload: reloadSpy };

    const recentTime = Date.now() - 5000;
    vi.mocked(sessionStorage.getItem).mockReturnValue(recentTime.toString());

    try {
      const first = new Error('JIT compiler unavailable');
      first.stack = 'Error: JIT compiler unavailable\n    at ys (https://example.com/chunk-ABC.js:1:1)';
      const second = new Error('JIT compiler unavailable');
      second.stack = first.stack;

      service.handleError(first);
      service.handleError(second);

      const persistedLogs = loggerSpy.error.mock.calls.filter(
        ([message]: [string]) => message === 'Chunk load error persisted after reload'
      );
      const fatalLogs = loggerSpy.error.mock.calls.filter(
        ([message]: [string]) => message === 'FATAL ERROR'
      );
      expect(reloadSpy).not.toHaveBeenCalled();
      expect(persistedLogs).toHaveLength(1);
      expect(fatalLogs).toHaveLength(1);
      expect(loggerSpy.warn).not.toHaveBeenCalledWith(
        'Fatal error already handled, ignoring',
        expect.any(Object)
      );
    } finally {
      // @ts-ignore
      window.location = originalLocation;
    }
  });

  it('should detect Angular DI version skew error and trigger reload', () => {
    const reloadSpy = vi.fn();
    const originalLocation = window.location;
    // @ts-ignore
    delete window.location;
    // @ts-ignore
    window.location = { reload: reloadSpy };

    try {
      // 模拟 SW 缓存不一致导致的 Angular DI 错误
      const error = new TypeError("Cannot read properties of undefined (reading 'factory')");
      // 模拟 Angular 框架堆栈
      error.stack = `TypeError: Cannot read properties of undefined (reading 'factory')
    at e0 (https://example.com/chunk-VLM5U4MR.js:7:114442)
    at vn (https://example.com/chunk-J5YVUOYO.js:1:27525)
    at executeTemplate (https://example.com/chunk-VLM5U4MR.js:7:45648)
    at renderView (https://example.com/chunk-VLM5U4MR.js:7:48086)`;

      service.handleError(error);

      expect(reloadSpy).toHaveBeenCalled();
    } finally {
      // @ts-ignore
      window.location = originalLocation;
    }
  });

  it('should detect Angular DI onDestroy version skew error', () => {
    const reloadSpy = vi.fn();
    const originalLocation = window.location;
    // @ts-ignore
    delete window.location;
    // @ts-ignore
    window.location = { reload: reloadSpy };

    try {
      const error = new TypeError("Cannot read properties of undefined (reading 'onDestroy')");
      error.stack = `TypeError: Cannot read properties of undefined (reading 'onDestroy')
    at e0 (https://example.com/chunk-ABC.js:7:114368)
    at createEmbeddedView (https://example.com/chunk-XYZ.js:7:48701)`;

      service.handleError(error);

      expect(reloadSpy).toHaveBeenCalled();
    } finally {
      // @ts-ignore
      window.location = originalLocation;
    }
  });

  it('should detect Angular JIT facade error and trigger reload', () => {
    const reloadSpy = vi.fn();
    const originalLocation = window.location;
    // @ts-ignore
    delete window.location;
    // @ts-ignore
    window.location = { reload: reloadSpy };

    try {
      const error = new Error('JIT compilation failed for component class TextTaskEditorComponent2');
      error.stack = `Error: JIT compilation failed for component class TextTaskEditorComponent2
    at getCompilerFacade (https://example.com/core.mjs:2477:11)
    at ɵɵngDeclareComponent (https://example.com/chunk-ABC.js:1:1234)`;

      service.handleError(error);

      expect(reloadSpy).toHaveBeenCalled();
    } finally {
      // @ts-ignore
      window.location = originalLocation;
    }
  });

  it('should detect Angular JIT compiler unavailable error and trigger reload', () => {
    const reloadSpy = vi.fn();
    const originalLocation = window.location;
    // @ts-ignore
    delete window.location;
    // @ts-ignore
    window.location = { reload: reloadSpy };

    try {
      const error = new Error('JIT compiler unavailable');
      error.stack = `Error: JIT compiler unavailable
    at ys (https://dde-eight.vercel.app/chunk-MEQCPUNU.js:7:9763)
    at https://dde-eight.vercel.app/chunk-IZPRSPQS.js:17:1234`;

      service.handleError(error);

      expect(reloadSpy).toHaveBeenCalled();
      expect(toastSpy.error).not.toHaveBeenCalled();
    } finally {
      // @ts-ignore
      window.location = originalLocation;
    }
  });

  it('should NOT treat non-Angular TypeError as DI version skew', () => {
    const reloadSpy = vi.fn();
    const originalLocation = window.location;
    // @ts-ignore
    delete window.location;
    // @ts-ignore
    window.location = { reload: reloadSpy };

    try {
      // 非 Angular DI 的普通 TypeError
      const error = new TypeError("Cannot read properties of undefined (reading 'factory')");
      error.stack = `TypeError: Cannot read properties of undefined (reading 'factory')
    at myFunction (https://example.com/app.js:1:100)
    at main (https://example.com/app.js:2:200)`;

      service.handleError(error);

      // 不应触发 reload，因为堆栈不匹配 Angular DI 模式
      expect(reloadSpy).not.toHaveBeenCalled();
    } finally {
      // @ts-ignore
      window.location = originalLocation;
    }
  });

  it('should detect onDestroy error from Angular tick/CD frames as version skew', () => {
    const reloadSpy = vi.fn();
    const originalLocation = window.location;
    // @ts-ignore
    delete window.location;
    // @ts-ignore
    window.location = { reload: reloadSpy };

    try {
      const error = new TypeError("Cannot read properties of undefined (reading 'onDestroy')");
      error.stack = `TypeError: Cannot read properties of undefined (reading 'onDestroy')
    at tickImpl (https://dde-eight.vercel.app/chunk-VLM5U4MR.js:7:55119)
    at _tick (https://dde-eight.vercel.app/chunk-VLM5U4MR.js:7:55000)`;

      service.handleError(error);

      expect(reloadSpy).toHaveBeenCalled();
    } finally {
      // @ts-ignore
      window.location = originalLocation;
    }
  });

  // ============ 离线错误静默降级测试 ============

  it('should classify AbortError with "signal is aborted" message as SILENT', () => {
    const error = new DOMException('signal is aborted without reason', 'AbortError');
    service.handleError(error);

    // SILENT 错误只记录 debug 日志，不弹 Toast
    expect(loggerSpy.debug).toHaveBeenCalledWith('Silent error captured', expect.any(Object));
    expect(toastSpy.error).not.toHaveBeenCalled();
  });

  it('should classify GoJS _getOriginRect null width as SILENT (Overview 未就绪噪声)', () => {
    // 2026-05-15 新增：GoJS Overview 在首次 measure 完成前内部 Rect 为 null，
    // 触发 _getOriginRect → "Cannot read properties of null (reading 'width')"。
    // 已在 flow-overview.service.ts 加 box.actualBounds.isReal() 守卫，
    // 但 GoJS 异步路径仍可能抛出，应当降级为 SILENT 不噪声。
    const error = new TypeError("Cannot read properties of null (reading 'width')");
    error.stack = `TypeError: Cannot read properties of null (reading 'width')
    at pe._getOriginRect (https://nanoflow.pages.dev/chunk-5AK6LAAR.js:7:91730)
    at Overview.transformViewToDoc (https://nanoflow.pages.dev/chunk-5AK6LAAR.js:7:91900)`;

    service.handleError(error);

    expect(loggerSpy.debug).toHaveBeenCalledWith('Silent error captured', expect.any(Object));
    expect(toastSpy.error).not.toHaveBeenCalled();
  });

  it('should suppress network errors as SILENT when device is offline', () => {
    // 模拟离线状态
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);

    const error = new Error('Gateway Timeout');
    service.handleError(error);

    // 离线时网络错误降级为 SILENT
    expect(loggerSpy.debug).toHaveBeenCalledWith('Silent error captured', expect.any(Object));
    expect(toastSpy.error).not.toHaveBeenCalled();
  });

  it('should suppress 401 Unauthorized as SILENT when device is offline', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);

    const error = new Error('401 Unauthorized');
    service.handleError(error);

    expect(loggerSpy.debug).toHaveBeenCalledWith('Silent error captured', expect.any(Object));
    expect(toastSpy.error).not.toHaveBeenCalled();
  });

  it('should classify ErrorEvent-wrapped GoJS _getOriginRect noise as SILENT (A3 根因修复)', () => {
    // 2026-05-15 A3：window.onerror 包装为 ErrorEvent / 字符串 reason 时
    // error 不再是 Error 实例，error.stack 为 undefined。共享 extractErrorStack
    // 工具会去 error.error.stack / error.reason.stack 兜底，保证 SILENT 路径仍命中。
    const innerError = new TypeError("Cannot read properties of null (reading 'width')");
    innerError.stack = `TypeError: Cannot read properties of null (reading 'width')
    at pe._getOriginRect (https://nanoflow.pages.dev/chunk-5AK6LAAR.js:7:91730)`;
    // 模拟 ErrorEvent：本身不是 Error 实例，但 .error 字段持有真正的 TypeError
    const errorEventLike = {
      message: "Cannot read properties of null (reading 'width')",
      error: innerError,
    };

    service.handleError(errorEventLike);

    expect(loggerSpy.debug).toHaveBeenCalledWith('Silent error captured', expect.any(Object));
    expect(toastSpy.error).not.toHaveBeenCalled();
  });

  it('should classify PromiseRejectionEvent.reason GoJS noise as SILENT (A3 根因修复)', () => {
    // 2026-05-15 A3：unhandledrejection 路径，reason 可能是含 stack 的对象（非 Error 实例）
    const reason = {
      message: "Cannot read properties of null (reading 'width')",
      stack: `TypeError: Cannot read properties of null (reading 'width')
    at pe._getOriginRect (https://nanoflow.pages.dev/chunk-5AK6LAAR.js:7:91730)`,
    };

    service.handleError(reason);

    expect(loggerSpy.debug).toHaveBeenCalledWith('Silent error captured', expect.any(Object));
    expect(toastSpy.error).not.toHaveBeenCalled();
  });

  it('should call __NANOFLOW_OVERVIEW_HEAL__ hook when SILENT noise is captured (A4 防御性自愈)', () => {
    // 2026-05-15 A4：命中 SILENT 后通过全局钩子触发 overview.requestUpdate()
    const healSpy = vi.fn();
    type OverviewHealWindow = Window & {
      __NANOFLOW_OVERVIEW_HEAL__?: () => void;
    };
    (window as OverviewHealWindow).__NANOFLOW_OVERVIEW_HEAL__ = healSpy;

    try {
      const error = new TypeError("Cannot read properties of null (reading 'width')");
      error.stack = `TypeError: Cannot read properties of null (reading 'width')
    at pe._getOriginRect (https://nanoflow.pages.dev/chunk-5AK6LAAR.js:7:91730)`;
      service.handleError(error);

      expect(healSpy).toHaveBeenCalledTimes(1);
    } finally {
      delete (window as OverviewHealWindow).__NANOFLOW_OVERVIEW_HEAL__;
    }
  });

  it('should NOT misfire SILENT predicate for unrelated null.width errors (A3 命中面验证)', () => {
    // 2026-05-15 A3：双约束（_getOriginRect + null.width）保证命中面极窄
    // 单一约束（仅 null.width）不应命中
    const error = new TypeError("Cannot read properties of null (reading 'width')");
    error.stack = `TypeError: Cannot read properties of null (reading 'width')
    at someUnrelatedFunction (https://example.com/app.js:1:1)`;

    service.handleError(error);

    // 不应作为 GoJS Overview 噪声静默处理；走默认 NOTIFY/分类（取决于其他规则）
    // 此处至少不能命中 SILENT-by-overview 路径
    // 由于没有命中其他 SILENT 规则，应当弹 Toast 或归类为非 SILENT
    expect(toastSpy.error).toHaveBeenCalled();
  });
});
