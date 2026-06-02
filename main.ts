import { bootstrapApplication } from '@angular/platform-browser';
import { isDevMode, ErrorHandler, VERSION, NgZone, APP_INITIALIZER } from '@angular/core';
import { provideRouter, withComponentInputBinding, withHashLocation, withRouterConfig } from '@angular/router';
import { provideServiceWorker } from '@angular/service-worker';
import { createPostHandoffSwRegistrationStrategy } from './src/services/sw-registration-strategy';
import { pushStartupTrace } from './src/utils/startup-trace';
import { ensureBrowserNetworkSuspensionTracking } from './src/utils/browser-network-suspension';
import { applyStartupVersionAction, decideStartupVersionAction } from './src/utils/startup-version-policy';
import { forceClearCacheImpl, type ForceClearCacheDeps } from './src/utils/force-clear-cache-impl';
import {
  isGojsOverviewOriginRectNoise,
  extractErrorStack as extractAnyErrorStack,
  extractErrorMessageLoose,
} from './src/utils/gojs-overview-noise';
// ============= 【P0 启动优化 2026-03-26】受控 dynamic import + head modulepreload =============
// 关键模块改回 dynamic import，以缩小 main 静态闭包并通过 perf-startup-guard。
// 配套保障：
// 1. build 后 inject-modulepreload.cjs 会为 main/polyfills 与关键启动 chunk 注入 head 级 preload
// 2. 浏览器能并行下载入口与热路径共享依赖，避免旧版的运行时瀑布
// 3. AppComponent / routes / GlobalErrorHandler / SentryLazyLoaderService 重新脱离 main 静态闭包
// Supabase SDK 仍保持 dynamic import（~50KB，首屏不需要）。

// 简化日志 - 仅在显式 verbose 时输出，避免启动期控制台噪音
const VERBOSE_LOGS = isDevMode() && localStorage.getItem('nanoflow.verbose') === 'true';

// 启动期尽早挂上浏览器后台网络挂起跟踪，避免首次恢复事件被错过。
ensureBrowserNetworkSuspensionTracking();

// ============= BUILD ID =============
// 使用入口 chunk URL 作为构建指纹，确保 outputHashing 变化能触发版本偏移恢复。
const BUILD_ID = (() => {
  try {
    const entryUrl = new URL(import.meta.url, window.location.href);
    return `${VERSION.full}:${entryUrl.pathname}${entryUrl.search}`;
  } catch {
    return `${VERSION.full}:runtime-unknown`;
  }
})();
if (VERBOSE_LOGS) {
  console.log('%c [NanoFlow] Main.ts Loaded: ' + BUILD_ID, 'background: #222; color: #bada55; font-size: 20px');
}
const START_TIME = Date.now();
const VERSION_STORAGE_KEY = 'nanoflow.app-version';
const FORCE_CLEAR_KEY = 'nanoflow.force-clear-cache';
const log = (msg: string, _color = '#0f0') => {
  if (!VERBOSE_LOGS) return;
  const elapsed = Date.now() - START_TIME;
  console.log(`[NanoFlow +${elapsed}ms] ${msg}`);
};
const logError = (msg: string, err?: unknown) => {
  const elapsed = Date.now() - START_TIME;
  console.error(`[NanoFlow +${elapsed}ms] ❌ ${msg}`, err || '');
};

interface StartupSentryReporter {
  captureException(error: unknown, context?: Record<string, unknown>): void;
  isInitialized?: () => boolean;
}

interface StartupSentryEvent {
  error: unknown;
  context: Record<string, unknown>;
}

const STARTUP_SENTRY_QUEUE_MAX = 20;
const startupSentryQueue: StartupSentryEvent[] = [];
let startupSentryReporter: StartupSentryReporter | null = null;

function toSentryError(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) return value;
  return new Error(fallbackMessage);
}

function captureStartupSentryError(error: unknown, context: Record<string, unknown>): void {
  if (startupSentryReporter) {
    if (startupSentryReporter.isInitialized?.()) {
      return;
    }
    startupSentryReporter.captureException(error, context);
    return;
  }

  if (startupSentryQueue.length >= STARTUP_SENTRY_QUEUE_MAX) {
    startupSentryQueue.shift();
  }
  startupSentryQueue.push({ error, context });
}

function flushStartupSentryQueue(reporter: StartupSentryReporter): void {
  startupSentryReporter = reporter;
  const queuedEvents = startupSentryQueue.splice(0);
  for (const event of queuedEvents) {
    reporter.captureException(event.error, {
      ...event.context,
      delayedCapture: true,
      captureDelay: Date.now() - START_TIME,
    });
  }
}

async function flushStartupSentryQueueWithoutInjector(): Promise<void> {
  if (startupSentryReporter) {
    return;
  }

  try {
    const module = await import('./src/services/sentry-lazy-loader.service');
    flushStartupSentryQueue(new module.SentryLazyLoaderService());
  } catch (error) {
    logError('启动失败错误上报初始化失败', error);
  }
}

function isBrowserNetworkSuspendedReason(reason: unknown): boolean {
  const record = reason as { name?: unknown; message?: unknown } | null | undefined;
  const name = typeof record?.name === 'string' ? record.name : '';
  const message = typeof record?.message === 'string' ? record.message : String(reason ?? '');
  return name === 'BrowserNetworkSuspendedError'
    || /network[_ ]io suspended|Browser network IO suspended/i.test(message);
}

// 在浏览器空闲时执行任务，避免阻塞首屏渲染
const scheduleIdleTask = (task: () => void) => {
  if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
    (window as Window & { requestIdleCallback: (cb: () => void) => number }).requestIdleCallback(() => task());
  } else {
    setTimeout(task, 0);
  }
};

const readBootFlag = (key: string, fallback: boolean): boolean => {
  if (typeof window === 'undefined') return fallback;
  const flags = (window as Window & { __NANOFLOW_BOOT_FLAGS__?: Record<string, unknown> }).__NANOFLOW_BOOT_FLAGS__;
  const value = flags?.[key];
  return typeof value === 'boolean' ? value : fallback;
};

function clearRecoveryStorage(): void {
  localStorage.removeItem('nanoflow.offline-cache-v2');
  localStorage.removeItem('nanoflow.escape-pod');
}

async function clearApplicationCaches(): Promise<void> {
  if (!('caches' in window)) {
    return;
  }

  const cacheNames = await caches.keys();
  log(`清理 ${cacheNames.length} 个缓存...`);
  await Promise.all(cacheNames.map(name => {
    log(`  删除缓存: ${name}`);
    return caches.delete(name);
  }));
}

async function unregisterApplicationServiceWorkers(): Promise<void> {
  if (!('serviceWorker' in navigator)) {
    return;
  }

  const registrations = await navigator.serviceWorker.getRegistrations();
  log(`注销 ${registrations.length} 个 Service Worker...`);
  await Promise.all(registrations.map(reg => reg.unregister()));
}

// ========== 版本检测与缓存清理 ==========
async function checkAndClearCacheIfNeeded(): Promise<boolean> {
  try {
    const storedVersion = localStorage.getItem(VERSION_STORAGE_KEY);
    const forceClear = localStorage.getItem(FORCE_CLEAR_KEY) === 'true';
    const action = decideStartupVersionAction({
      storedVersion,
      currentVersion: BUILD_ID,
      forceClear,
    });
    
    log(`当前版本: ${BUILD_ID}, 存储版本: ${storedVersion || '无'}`);

    const maintenanceResult = await applyStartupVersionAction(action, {
      persistCurrentVersion: () => {
        localStorage.setItem(VERSION_STORAGE_KEY, BUILD_ID);
      },
      clearForceClearFlag: () => {
        localStorage.removeItem(FORCE_CLEAR_KEY);
      },
      clearRecoveryStorage: () => {
        clearRecoveryStorage();
      },
      clearCaches: async () => {
        log('🔄 检测到强制清理标记，正在清理缓存...');
        await clearApplicationCaches();
      },
      unregisterServiceWorkers: async () => {
        await unregisterApplicationServiceWorkers();
      },
      reloadCurrentLocation: () => {
        log('✅ 缓存已清理，即将刷新页面...');
        // 使用 replace 避免产生历史记录循环
        setTimeout(() => {
          window.location.replace(window.location.href);
        }, 100);
      },
      onVersionAdvanced: () => {
        log('📦 检测到版本前进，已记录新版本号并保留当前启动实例');
        pushStartupTrace('app.version_advanced', {
          previousBuildId: storedVersion,
          currentBuildId: BUILD_ID,
          recoveryMode: 'non-destructive',
        });
      },
      onFirstLaunch: () => {
        log('首次加载，已保存版本号');
      },
    });
    
    return maintenanceResult === 'reload-scheduled';
  } catch (e) {
    logError('版本检测失败', e);
    // 出错时保存版本号并继续
    try {
      localStorage.setItem(VERSION_STORAGE_KEY, BUILD_ID);
    } catch {}
    return false;
  }
}

// ========== 强制清理缓存工具函数（仅在错误页面按钮中使用，防止外部脚本滥用）==========
// 同步注册：保证 toast「立即刷新」点击时 window.__NANOFLOW_FORCE_CLEAR_CACHE__ 必然就绪。
// 历史上这里挂在 scheduleIdleTask，但长时间后台/隐藏 tab 中 requestIdleCallback 会被 throttle，
// 导致用户从后台返回点击 toast 时函数尚未注册，落到 fallback `location.reload()` —— 旧 SW
// 仍是 controller，直接命中 ngsw 缓存返回旧 HTML/JS，UI 看起来「没反应」。
function registerForceClearCacheTool(): void {
  const deps: ForceClearCacheDeps = {
    clearRecoveryStorage: () => {
      clearRecoveryStorage();
    },
    clearApplicationCaches: () => clearApplicationCaches(),
    unregisterApplicationServiceWorkers: () => unregisterApplicationServiceWorkers(),
    setForceClearFlag: () => {
      localStorage.setItem(FORCE_CLEAR_KEY, 'true');
    },
    clearForceClearFlag: () => {
      // 当前页已完成清理，移除标记避免下一次启动再次触发恢复刷新。
      localStorage.removeItem(FORCE_CLEAR_KEY);
    },
    replaceLocation: (href) => {
      window.location.replace(href);
    },
    reloadLocation: () => {
      window.location.reload();
    },
    assignHref: (href) => {
      window.location.href = href;
    },
    getCurrentHref: () => window.location.href,
    getOriginRoot: () => `${window.location.origin}/`,
    logInfo: (message, extra) => {
      log(`${message}${extra ? ' ' + JSON.stringify(extra) : ''}`);
    },
    logError: (message, err) => {
      logError(message, err);
    },
  };

  (window as Window & { __NANOFLOW_FORCE_CLEAR_CACHE__?: () => Promise<void> }).__NANOFLOW_FORCE_CLEAR_CACHE__ = async function() {
    await forceClearCacheImpl(deps);
  };
}

// 同步注册：开销仅为一次对象属性赋值，没有 idle 化必要。
registerForceClearCacheTool();

log('Build: ' + BUILD_ID);
log('🚀 main.ts 开始执行');
log('Angular 版本: ' + VERSION.full);
log('当前 URL: ' + window.location.href);
log('User Agent: ' + navigator.userAgent.substring(0, 80) + '...');

// 检查 Zone.js 是否已加载
const zoneLoaded = typeof (window as Window & { Zone?: unknown }).Zone !== 'undefined';
log('Zone.js: ' + (zoneLoaded ? '✅已加载' : '❌未加载'));

if (!zoneLoaded) {
  logError('Zone.js 未加载！Angular 无法工作！');
}

// 检测浏览器能力
const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
log('设备: ' + (isMobile ? (isIOS ? 'iOS' : 'Android') : 'Desktop'));

// 全局错误捕获 - 在 Angular 启动前就开始捕获
window.onerror = (message, source, lineno, colno, error) => {
  // Supabase Auth 多标签页/多实例场景的 LockManager 锁争用：
  // 不影响功能，但 Zone.js/浏览器默认处理会在控制台打印堆栈，造成噪音。
  const messageText = String(message ?? '');
  const isSupabaseAuthLockContention =
    /Navigator LockManager lock/i.test(messageText) ||
    /Acquiring an exclusive Navigator LockManager lock/i.test(messageText) ||
    /lock:sb-.*-auth-token/i.test(messageText);

  if (isSupabaseAuthLockContention) {
    return true; // 阻止默认处理（避免控制台噪音）
  }

  if (isBrowserNetworkSuspendedReason(error ?? message)) {
    return true;
  }

  // 2026-05-15 根因修复：GoJS Overview 异步 tick（ResizeObserver / AnimationManager）
  // 在 documentBounds 未就绪时抛 "Cannot read properties of null (reading 'width')"
  // 上层守卫无法拦截，必须在浏览器层就吞掉避免控制台红框 + Angular Toast 风暴。
  // 与 GlobalErrorHandler.handleError 共享同一个谓词，确保两路语义一致。
  {
    const noiseMessage = extractErrorMessageLoose(error ?? message);
    const noiseStack = extractAnyErrorStack(error);
    if (isGojsOverviewOriginRectNoise(noiseMessage, noiseStack)) {
      return true; // 阻止默认处理
    }
  }

  logError(`全局错误: ${message}`, { source, lineno, colno, error });
  captureStartupSentryError(
    toSentryError(error, messageText || 'window.onerror'),
    {
      component: 'main',
      mechanism: 'window.onerror',
      source,
      lineno,
      colno,
    },
  );
  return false; // 继续默认处理
};

window.addEventListener('unhandledrejection', (event) => {
  // Supabase Auth 在多标签页/多实例场景会用 Navigator LockManager 做互斥。
  // 当锁被其他实例占用时会出现立即失败的 rejection；这通常不影响登录态本身，
  // 但 Zone.js + 浏览器默认行为会把它打印成“未处理错误”，造成噪音。
  const reason: unknown = (event as PromiseRejectionEvent).reason;
  const reasonText = String(
    (reason != null && typeof reason === 'object' && 'message' in reason ? (reason as { message: string }).message : null)
    ?? reason
    ?? '',
  );
  const isSupabaseAuthLockContention =
    /Navigator LockManager lock/i.test(reasonText) ||
    /Acquiring an exclusive Navigator LockManager lock/i.test(reasonText) ||
    /lock:sb-.*-auth-token/i.test(reasonText);

  if (isSupabaseAuthLockContention) {
    event.preventDefault();
    return;
  }

  if (isBrowserNetworkSuspendedReason(reason)) {
    event.preventDefault();
    return;
  }

  // 2026-05-15 根因修复：unhandledrejection 路径同样兜底 GoJS Overview 噪声
  {
    const noiseMessage = extractErrorMessageLoose(reason);
    const noiseStack = extractAnyErrorStack(reason);
    if (isGojsOverviewOriginRectNoise(noiseMessage, noiseStack)) {
      event.preventDefault();
      return;
    }
  }

  logError('未处理的 Promise 拒绝', event.reason);
  captureStartupSentryError(
    toSentryError(reason, reasonText || 'Unhandled promise rejection'),
    {
      component: 'main',
      mechanism: 'unhandledrejection',
    },
  );
});

// ========== Supabase SDK 预热（启动壳优先） ==========
// 冷启动阶段优先让系统 splash 尽快交棒给应用自己的启动壳，
// 因此不再在 Angular bootstrap 前争抢首波网络/主线程。
let supabaseSdkPrewarmPromise: Promise<unknown> | null = null;
let supabaseSdkPrewarmScheduled = false;

const ensureSupabaseSdkPrewarm = () =>
  (supabaseSdkPrewarmPromise ??= import('@supabase/supabase-js').catch(() => null));

function scheduleSupabaseSdkPrewarmAfterShell(): void {
  const deferredSdkEnabled = readBootFlag('SUPABASE_DEFERRED_SDK_V1', true);
  if (!deferredSdkEnabled) {
    void ensureSupabaseSdkPrewarm();
    return;
  }

  if (supabaseSdkPrewarmScheduled || typeof window === 'undefined') {
    return;
  }

  supabaseSdkPrewarmScheduled = true;
  let fallbackTimer: number | null = null;

  const kickoff = () => {
    cleanup();
    scheduleIdleTask(() => {
      void ensureSupabaseSdkPrewarm();
    });
  };

  const handleBootReady = () => kickoff();
  const handleBootStage = (event: Event) => {
    const detail = (event as CustomEvent<{ stage?: string }>).detail;
    if (detail?.stage === 'launch-shell' || detail?.stage === 'handoff' || detail?.stage === 'ready') {
      kickoff();
    }
  };

  const cleanup = () => {
    window.removeEventListener('nanoflow:boot-stage', handleBootStage as EventListener);
    window.removeEventListener('nanoflow:bootstrap-complete', handleBootReady as EventListener);
    if (fallbackTimer !== null) {
      window.clearTimeout(fallbackTimer);
      fallbackTimer = null;
    }
  };

  window.addEventListener('nanoflow:boot-stage', handleBootStage as EventListener);
  window.addEventListener('nanoflow:bootstrap-complete', handleBootReady as EventListener, { once: true });
  fallbackTimer = window.setTimeout(() => kickoff(), 4000);
}

function readStartupTraceLocationSummary(): Record<string, unknown> {
  const searchParams = new URLSearchParams(window.location.search || '');
  const rawHash = window.location.hash || '';
  const routeHash = rawHash.startsWith('#/') ? rawHash : '';
  const routeHashQueryIndex = routeHash.indexOf('?');
  const hashPath = routeHash
    ? routeHash.slice(0, routeHashQueryIndex >= 0 ? routeHashQueryIndex : routeHash.length)
    : '';
  const hashParams = new URLSearchParams(
    routeHashQueryIndex >= 0 ? routeHash.slice(routeHashQueryIndex + 1) : ''
  );
  const searchEntry = searchParams.get('entry');
  const hashEntry = hashParams.get('entry');
  const searchIntent = searchParams.get('intent');
  const hashIntent = hashParams.get('intent');

  return {
    pathname: window.location.pathname,
    hashPath,
    hasSearch: Boolean(window.location.search),
    hasOpaqueHash: Boolean(rawHash) && !routeHash,
    entryCarrier: hashEntry ? 'hash' : (searchEntry ? 'search' : null),
    entry: hashEntry ?? searchEntry ?? null,
    intent: hashIntent ?? searchIntent ?? null,
    projectIdPresent: Boolean(hashParams.get('projectId') ?? searchParams.get('projectId')),
    taskIdPresent: Boolean(hashParams.get('taskId') ?? searchParams.get('taskId')),
  };
}

// ========== 应用启动函数 ==========
async function startApplication() {
  log('🏗️ 准备启动 Angular...');
  pushStartupTrace('app.start', {
    startTime: START_TIME,
    ...readStartupTraceLocationSummary(),
  });
  
  // 添加启动超时保护（15秒）
  const startupTimeout = setTimeout(() => {
    logError('Angular 启动超时！');
    captureStartupSentryError(new Error('Startup timeout'), {
      component: 'main',
      mechanism: 'startup-timeout',
      isFatal: true,
    });
    showStartupError('启动超时', '应用启动时间过长，可能是缓存问题导致。', new Error('Startup timeout'));
  }, 15000);
  
  try {
    const [
      appComponentModule,
      appRoutesModule,
      globalErrorHandlerModule,
      sentryLoaderModule,
    ] = await Promise.all([
      import('./src/app.component'),
      import('./src/app.routes'),
      import('./src/services/global-error-handler.service'),
      import('./src/services/sentry-lazy-loader.service'),
    ]);
    const AppComponent = appComponentModule.AppComponent;
    const routes = appRoutesModule.routes;
    const GlobalErrorHandler = globalErrorHandlerModule.GlobalErrorHandler;
    const SentryLazyLoaderService = sentryLoaderModule.SentryLazyLoaderService;

    const appRef = await bootstrapApplication(AppComponent, {
      providers: [
        // ============= 错误处理器（使用 GlobalErrorHandler）=============
        // 【优化 2026-02-01】改用 GlobalErrorHandler 集成 SentryLazyLoaderService
        // GlobalErrorHandler 会在 Sentry 初始化完成后自动上报错误
        {
          provide: ErrorHandler,
          useClass: GlobalErrorHandler,
        },
        // ============= Sentry 懒加载初始化（非阻塞）=============
        // 【性能优化 2026-02-01】使用 APP_INITIALIZER + queueMicrotask 实现非阻塞初始化
        // 返回立即 resolve 的 Promise，不阻塞应用启动
        // Sentry 将在浏览器空闲时通过 requestIdleCallback 初始化
        {
          provide: APP_INITIALIZER,
          useFactory: (sentryLoader: { isConfigured: () => boolean; triggerLazyInit: () => void }) => () => {
            if (!sentryLoader.isConfigured()) {
              return Promise.resolve();
            }

            // 使用 queueMicrotask 确保不阻塞当前任务
            queueMicrotask(() => sentryLoader.triggerLazyInit());
            return Promise.resolve();
          },
          deps: [SentryLazyLoaderService],
          multi: true,
        },
        provideRouter(
          routes,
          withComponentInputBinding(),
          withHashLocation(),
          withRouterConfig({
            // 关键修复：Guard 取消导航后同步 Router/URL 状态，避免登录后同路径导航被误判为已在目标页
            canceledNavigationResolution: 'computed',
            // 【P2-38】子路由继承父路由参数，ProjectShellComponent 可直接读取子路由 taskId
            paramsInheritanceStrategy: 'always'
          })
        ),
        // Service Worker: 继续通过组合入口承接标准 NGSW，并保留旧桌面 widget 的退役兼容层。
        provideServiceWorker('sw-composed.js', {
          enabled: !isDevMode(),
          registrationStrategy: createPostHandoffSwRegistrationStrategy({
            delayMs: 250,
            fallbackMs: 4_000,
          })
        })
      ]
    });
    
    clearTimeout(startupTimeout);
    flushStartupSentryQueue(appRef.injector.get(SentryLazyLoaderService));
    
    const elapsed = Date.now() - START_TIME;
    log('✅ Angular 启动成功! 耗时: ' + elapsed + 'ms');

    window.dispatchEvent(new CustomEvent('nanoflow:bootstrap-complete', {
      detail: { elapsed },
    }));
    pushStartupTrace('app.bootstrap_complete', { elapsed });

    // 检查 Zone.js 是否正常工作 - 尝试触发变更检测
    try {
      const zone = appRef.injector.get(NgZone);
      zone.run(() => {
        log('🎉 应用完全就绪，Zone.js 正常工作');
      });
    } catch (e) {
      logError('Zone.js 运行时检查失败', e);
      captureStartupSentryError(toSentryError(e, 'Zone.js runtime check failed'), {
        component: 'main',
        mechanism: 'zone-runtime-check',
      });
    }

    const initWebVitals = () => {
      void import('./src/services/web-vitals.service')
        .then((module) => {
          const webVitals = appRef.injector.get(module.WebVitalsService);
          webVitals.init();
        })
        .catch((error) => {
          logError('Web Vitals 延迟初始化失败', error);
          captureStartupSentryError(toSentryError(error, 'Web Vitals lazy init failed'), {
            component: 'main',
            mechanism: 'web-vitals-lazy-init',
          });
        });
    };
    const webVitalsIdleBootEnabled = readBootFlag('WEB_VITALS_IDLE_BOOT_V2', true);
    if (webVitalsIdleBootEnabled) {
      // Web Vitals 监控下沉到 idle 阶段，避免主路径静态依赖膨胀。
      scheduleIdleTask(initWebVitals);
    } else {
      void initWebVitals();
    }

    // 启动后维护任务：同步版本标记，显式 force-clear 才执行破坏性恢复
    scheduleIdleTask(() => {
      void runPostBootstrapMaintenance();
    });
  } catch (err: unknown) {
    clearTimeout(startupTimeout);
    logError('❌ 启动失败', err);
    captureStartupSentryError(toSentryError(err, 'Bootstrap failed'), {
      component: 'main',
      mechanism: 'bootstrap-failed',
      isFatal: true,
    });
    void flushStartupSentryQueueWithoutInjector();
    pushStartupTrace('app.bootstrap_failed', {
      message: err instanceof Error ? err.message : String(err),
    });
    showStartupError('启动失败', '应用无法正常启动', err);
  }
}

async function runPostBootstrapMaintenance(): Promise<void> {
  try {
    const needsRefresh = await checkAndClearCacheIfNeeded();
    if (needsRefresh) {
      log('等待页面刷新...');
      return;
    }
    // 【性能审计 2026-02-07】移除 unregisterAllServiceWorkers() 调用
    // SW 注册由 provideServiceWorker() 统一管理，不再每次启动时注销
  } catch (e) {
    logError('启动后维护任务失败', e);
  }
}

// 【性能审计 2026-02-07】unregisterAllServiceWorkers 已移除
// SW 生命周期由 Angular provideServiceWorker() + ngsw-config.json 统一管理
// 版本升级时的缓存清理仍保留在 checkAndClearCacheIfNeeded() 中

// ========== XSS 安全：HTML 转义 ==========
function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ========== 显示启动错误界面 ==========
function showStartupError(title: string, _description: string, err: unknown) {
  // 详细错误分析
  const errObj = err as Record<string, unknown> | null | undefined;
  const errStr = String(errObj?.message || err);
  let diagnosis = '未知错误';
  let suggestion = '请尝试清除浏览器缓存并刷新';
  
  if (errStr.includes('NG0908')) {
    diagnosis = 'Zone.js 冲突 (NG0908) - 可能存在多个 Zone.js 实例';
    suggestion = '请确保只有一个 Zone.js 加载';
  } else if (errStr.includes('inject') || errStr.includes('NullInjector')) {
    diagnosis = '依赖注入错误 - 某个服务无法注入';
    suggestion = '检查所有服务是否正确配置';
  } else if (errStr.includes('chunk') || errStr.includes('Loading chunk')) {
    diagnosis = '代码块加载失败 - 网络问题或文件缺失';
    suggestion = '检查网络连接，或清除缓存重试';
  } else if (errStr.includes('Template') || errStr.includes('template')) {
    diagnosis = '模板编译错误';
    suggestion = '请检查组件模板语法';
  } else if (errStr.includes('Cannot read') || errStr.includes('undefined')) {
    diagnosis = '运行时空指针错误';
    suggestion = '某个对象为 undefined';
  } else if (errStr.includes('timeout') || errStr.includes('Timeout')) {
    diagnosis = '加载超时 - 可能是旧缓存导致';
    suggestion = '点击下方按钮清除缓存';
  }
  
  log('📋 诊断: ' + diagnosis);
  log('💡 建议: ' + suggestion);

  // 所有动态内容必须 escapeHtml 转义，防止 XSS（SEC-1 修复）
  const safeTitle = escapeHtml(title);
  const safeBuildId = escapeHtml(BUILD_ID);
  const safeDiagnosis = escapeHtml(diagnosis);
  const safeSuggestion = escapeHtml(suggestion);
  const safeError = escapeHtml(String(errObj?.stack || errObj?.message || err));
  
  // 显示用户可见的错误界面
  const errorDiv = document.createElement('div');
  errorDiv.style.cssText = 'position:fixed;inset:0;background:#fff;color:#333;padding:2rem;font-family:"LXGW WenKai Screen", sans-serif;z-index:99998;overflow:auto;';
  errorDiv.innerHTML = `
    <div style="max-width:600px;margin:0 auto;">
      <h1 style="color:#dc2626;margin-bottom:1rem;font-size:1.5rem;">${safeTitle}</h1>
      <p style="margin-bottom:0.5rem;color:#666;">Build: ${safeBuildId}</p>
      <p style="margin-bottom:1rem;color:#666;">诊断: ${safeDiagnosis}</p>
      <div style="background:#fef2f2;border:1px solid #fecaca;padding:1rem;border-radius:8px;margin-bottom:1rem;">
        <p style="font-size:0.9rem;color:#991b1b;margin:0;">💡 ${safeSuggestion}</p>
      </div>
      <pre style="background:#f5f5f5;padding:1rem;overflow:auto;font-size:11px;max-height:200px;margin-bottom:1rem;white-space:pre-wrap;word-break:break-all;border-radius:8px;">${safeError}</pre>
      <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">
        <button onclick="location.reload()" style="padding:0.75rem 1.5rem;background:#4f46e5;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:1rem;">刷新页面</button>
        <button onclick="window.__NANOFLOW_FORCE_CLEAR_CACHE__()" style="padding:0.75rem 1.5rem;background:#dc2626;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:1rem;">清除缓存并刷新</button>
      </div>
      <p style="margin-top:1rem;font-size:0.8rem;color:#999;">如果问题持续，请检查浏览器控制台获取更多信息</p>
    </div>
  `;
  document.body.appendChild(errorDiv);
}

// 启动应用
scheduleSupabaseSdkPrewarmAfterShell();
startApplication();
