import { ErrorHandler, Injectable, inject, NgZone, signal } from '@angular/core';
import { Router } from '@angular/router';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { TOAST_CONFIG } from '../config/ui.config';
import {
  isGojsOverviewOriginRectNoise,
  extractErrorStack as extractAnyErrorStack,
} from '../utils/gojs-overview-noise';

/**
 * 错误级别
 */
export enum ErrorSeverity {
  /** 静默级：记录日志即可，不打扰用户（如 404 图片、无关紧要的数据获取延迟） */
  SILENT = 'silent',
  /** 提示级：需要 Toast 弹窗告诉用户（如保存失败、网络断开） */
  NOTIFY = 'notify',
  /** 可恢复级：显示恢复对话框，让用户选择处理方式 */
  RECOVERABLE = 'recoverable',
  /** 致命级：需要跳转到错误页面（如 Store 初始化失败导致白屏） */
  FATAL = 'fatal'
}

/**
 * 恢复选项
 */
export interface RecoveryOption {
  id: string;
  label: string;
  style: 'primary' | 'secondary' | 'danger';
}

/**
 * 可恢复错误信息
 */
export interface RecoverableError {
  title: string;
  message: string;
  details?: string;
  options: RecoveryOption[];
  defaultOptionId?: string;
  autoSelectIn?: number;
  resolve: (optionId: string) => void;
}

/**
 * 错误分类规则
 * 用于根据错误信息自动判断严重程度
 */
interface ErrorClassificationRule {
  pattern: RegExp | string;
  severity: ErrorSeverity;
  userMessage?: string;
}

/**
 * 全局错误处理服务
 * 
 * 职责：
 * 1. 捕获所有未处理的错误
 * 2. 根据错误类型进行分级处理
 * 3. 静默级：仅记录日志
 * 4. 提示级：显示 Toast 提示用户
 * 5. 致命级：跳转到错误页面
 * 
 * @example
 * // 手动报告错误
 * errorHandler.handleError(new Error('Something went wrong'), ErrorSeverity.NOTIFY);
 * 
 * // 自动分类
 * errorHandler.handleError(new Error('Failed to load image'));  // 自动识别为 SILENT
 */
@Injectable({
  providedIn: 'root'
})
export class GlobalErrorHandler implements ErrorHandler {
  private readonly loggerService = inject(LoggerService);
  private logger = this.loggerService.category('GlobalErrorHandler');
  private toast = inject(ToastService);
  private router = inject(Router);
  private zone = inject(NgZone);
  
  /** Sentry 懒加载服务 - 用于异步错误上报 */
  private readonly sentryLoader = inject(SentryLazyLoaderService);

  /** 当前可恢复错误（用于显示恢复对话框） */
  readonly recoverableError = signal<RecoverableError | null>(null);

  /** 错误分类规则（顺序敏感，优先匹配前面的规则） */
  private readonly classificationRules: ErrorClassificationRule[] = [
    // === 静默级错误 ===
    // Angular NG0203 错误 — inject() 在注入上下文外调用，属于代码缺陷，应提示修复
    { pattern: /NG0203|inject.*must be called from an injection context/i, severity: ErrorSeverity.NOTIFY, userMessage: '检测到注入上下文错误 (NG0203)，请检查 effect()/inject() 调用位置' },
    // 图片加载失败
    { pattern: /load.*image|image.*load|img.*error|404.*image/i, severity: ErrorSeverity.SILENT },
    // Supabase Auth 多标签页锁争用（不影响功能，但在 Zone.js 下可能被报告为未处理错误）
    { pattern: /Navigator LockManager lock|lock:sb-.*-auth-token|Acquiring an exclusive Navigator LockManager lock/i, severity: ErrorSeverity.SILENT },
    // 字体加载失败
    { pattern: /font.*load|load.*font/i, severity: ErrorSeverity.SILENT },
    // 非关键资源 404
    { pattern: /404.*(?:favicon|icon|manifest)/i, severity: ErrorSeverity.SILENT },
    // ResizeObserver 循环警告（浏览器内部，无需处理）
    { pattern: /ResizeObserver loop/i, severity: ErrorSeverity.SILENT },
    // 用户取消操作 / 信号中止（含 Supabase fetch 超时产生的 AbortError）
    { pattern: /\bAbortError\b|signal is aborted|user.*cancel|request.*abort|fetch.*abort/i, severity: ErrorSeverity.SILENT },
    // Supabase token 刷新失败（离线/休眠唤醒时高频触发，静默处理）
    { pattern: /token.*refresh|refresh.*token|_callRefreshToken|_refreshAccessToken/i, severity: ErrorSeverity.SILENT },
    // 非活动标签页的更新
    { pattern: /not active|inactive tab/i, severity: ErrorSeverity.SILENT },
    // 模态框加载超时（已由 ModalLoaderService 处理，静默记录）
    { pattern: /模态框.*加载超时|modal.*load.*timeout/i, severity: ErrorSeverity.SILENT },
    // Chunk 加载错误（动态导入失败，由重试机制处理）
    // 包括：ChunkLoadError, Failed to fetch chunk, Failed to fetch dynamically imported module
    { pattern: /ChunkLoadError|Failed to fetch.*chunk|Loading chunk.*failed|Failed to fetch dynamically imported module/i, severity: ErrorSeverity.SILENT },
    // Angular DI 版本偏移（SW 缓存不一致）或 @defer 视图拆除竞态，由 handleError 中拦截并触发页面刷新
    // 【P3-24 修复】同时匹配 ASCII 单引号和 Unicode 智能引号，避免不同浏览器/V8 版本的差异
    { pattern: /Cannot read properties of undefined \(reading [\u2018\u2019'](?:factory|onDestroy)[\u2018\u2019']\)/i, severity: ErrorSeverity.SILENT },
    
    // === 提示级错误 ===
    // UUID 格式错误
    { 
      pattern: /invalid input syntax for type uuid/i, 
      severity: ErrorSeverity.NOTIFY,
      userMessage: '数据格式错误：ID 必须是有效的 UUID 格式'
    },
    // 网络错误
    { 
      pattern: /network|offline|fetch.*fail|http.*error|timeout|ECONNREFUSED/i, 
      severity: ErrorSeverity.NOTIFY,
      userMessage: '网络连接失败，请检查网络后重试'
    },
    // 保存/同步失败
    { 
      pattern: /save.*fail|sync.*fail|persist.*fail|upload.*fail/i, 
      severity: ErrorSeverity.NOTIFY,
      userMessage: '保存失败，请稍后重试'
    },
    // 认证错误（非致命）
    { 
      pattern: /unauthorized|401|auth.*error|session.*expir/i, 
      severity: ErrorSeverity.NOTIFY,
      userMessage: '登录状态已过期，请重新登录'
    },
    // 权限错误
    { 
      pattern: /forbidden|403|permission.*denied|access.*denied/i, 
      severity: ErrorSeverity.NOTIFY,
      userMessage: '您没有权限执行此操作'
    },
    // 【P3-14 修复】服务端错误 - 使用更精确的模式避免误匹配非 HTTP 上下文中的数字
    { 
      pattern: /\b(?:status|code|http)\s*[:=]?\s*(?:500|502|503|504)\b|server.*error|internal.*error/i, 
      severity: ErrorSeverity.NOTIFY,
      userMessage: '服务器繁忙，请稍后重试'
    },
    // 数据验证错误
    { 
      pattern: /validation.*fail|invalid.*data|data.*corrupt/i, 
      severity: ErrorSeverity.NOTIFY,
      userMessage: '数据格式错误，请检查输入'
    },
    
    // === 致命级错误 ===
    // Store 初始化失败
    { 
      pattern: /store.*init|init.*store|bootstrap.*fail/i, 
      severity: ErrorSeverity.FATAL,
      userMessage: '应用初始化失败'
    },
    // 路由初始化失败
    { 
      pattern: /router.*init|route.*fail|navigation.*fail.*critical/i, 
      severity: ErrorSeverity.FATAL,
      userMessage: '页面加载失败'
    },
    // 关键模块加载失败（排除可恢复的动态导入错误）
    // 注意：动态导入失败（Failed to fetch dynamically imported module）应由 SILENT 规则处理，
    // 这里只匹配真正的关键模块加载失败
    { 
      pattern: /critical.*module.*fail|core.*module.*fail|bootstrap.*load.*fail/i, 
      severity: ErrorSeverity.FATAL,
      userMessage: '模块加载失败'
    },
    // 内存不足
    { 
      pattern: /out.*memory|memory.*exhausted|heap.*overflow/i, 
      severity: ErrorSeverity.FATAL,
      userMessage: '内存不足'
    },
    // IndexedDB 关键错误
    { 
      pattern: /indexeddb.*fail|idb.*quota|storage.*quota/i, 
      severity: ErrorSeverity.FATAL,
      userMessage: '存储空间不足'
    }
  ];

  /** 致命错误状态（用于防止重复跳转） */
  private hasFatalError = false;

  /** Chunk/JIT 恢复过程状态，避免同一轮异常把控制台刷爆 */
  private chunkReloadInProgress = false;
  private persistentChunkLoadErrorReported = false;

  /** 错误去重（防止同一错误短时间内重复提示） */
  private recentErrors = new Map<string, number>();
  private readonly ERROR_DEDUP_INTERVAL = TOAST_CONFIG.ERROR_DEDUP_INTERVAL;

  /**
   * Angular ErrorHandler 接口实现
   * 捕获所有未处理的错误
   */
  handleError(error: unknown, forceSeverity?: ErrorSeverity): void {
    // 提取错误信息
    const errorMessage = this.extractErrorMessage(error);

    // 特殊处理：Chunk 加载失败（通常是版本更新导致），尝试刷新页面
    if (/ChunkLoadError|Failed to fetch.*chunk|Loading chunk.*failed|Failed to fetch dynamically imported module/i.test(errorMessage)) {
      this.handleChunkLoadError(errorMessage);
      return;
    }

    // 特殊处理：Angular DI 版本偏移（SW 缓存不一致导致 tView.data 槽位为 undefined）
    // 典型错误：Cannot read properties of undefined (reading 'factory'/'onDestroy')
    if (this.isAngularDIVersionSkewError(errorMessage, error)) {
      this.handleChunkLoadError(`[DI-version-skew] ${errorMessage}`);
      return;
    }

    // 特殊处理：Angular 触发运行时 JIT 编译（常见于 SW 缓存混用导致的版本偏移）
    // 典型报错：JIT compilation failed for component class ... / getCompilerFacade
    if (this.isAngularJITVersionSkewError(errorMessage, error)) {
      this.handleChunkLoadError(`[JIT-version-skew] ${errorMessage}`);
      return;
    }

    const errorStack = extractAnyErrorStack(error);

    // 2026-05-15 根因修复：GoJS Overview 在首次 measure 完成前调用 `_getOriginRect` /
    // `transformViewToDoc` 触发 "Cannot read properties of null (reading 'width')"。
    // 上层（flow-overview.service.ts）已加 box.actualBounds.isReal() 守卫，但内嵌
    // GoJS 仍可能在 ResizeObserver / AnimationManager.tick / requestAnimationFrame
    // 等异步路径上抛出。属于已知非致命噪声，降级 SILENT，并通过 window 钩子
    // 触发一次 overview.requestUpdate() 防御性自愈。
    //
    // 共享 `isGojsOverviewOriginRectNoise`：与 main.ts 的 window.onerror /
    // unhandledrejection 两路保持同一语义，避免一路吞、一路弹 Toast。
    if (isGojsOverviewOriginRectNoise(errorMessage, errorStack)) {
      this.handleSilentError(errorMessage, errorStack);
      this.requestOverviewSelfHeal();
      return;
    }

    // 确定错误级别
    let severity = forceSeverity ?? this.classifyError(errorMessage);

    // 离线降级：设备离线时所有非致命错误（网络/认证/保存/同步）降为 SILENT
    // 离线模式下用户应能无感编辑，Toast 风暴只会制造焦虑
    if (this.isDeviceOffline && severity === ErrorSeverity.NOTIFY) {
      severity = ErrorSeverity.SILENT;
    }

    // 错误去重检查
    if (severity !== ErrorSeverity.FATAL && this.isDuplicateError(errorMessage)) {
      this.logger.debug('Duplicate error suppressed', { error: errorMessage });
      return;
    }

    // 根据级别处理
    switch (severity) {
      case ErrorSeverity.SILENT:
        this.handleSilentError(errorMessage, errorStack);
        break;
      case ErrorSeverity.NOTIFY:
        this.handleNotifyError(errorMessage, errorStack, error);
        break;
      case ErrorSeverity.RECOVERABLE:
        // 可恢复错误会被特殊处理，这里只记录日志
        this.logger.warn('Recoverable error', { message: errorMessage, stack: errorStack });
        break;
      case ErrorSeverity.FATAL:
        this.handleFatalError(errorMessage, errorStack, error);
        break;
    }
  }

  /**
   * 手动报告错误（供业务代码使用）
   */
  reportError(error: unknown, severity: ErrorSeverity, customMessage?: string): void {
    if (customMessage) {
      const wrappedError = new Error(customMessage);
      if (error instanceof Error) {
        wrappedError.stack = error.stack;
      }
      this.handleError(wrappedError, severity);
    } else {
      this.handleError(error, severity);
    }
  }

  /**
   * 重置致命错误状态（从错误页面恢复时调用）
   */
  resetFatalState(): void {
    this.hasFatalError = false;
    this.chunkReloadInProgress = false;
    this.persistentChunkLoadErrorReported = false;
  }

  /**
   * 检查是否处于致命错误状态
   */
  get isFatalState(): boolean {
    return this.hasFatalError;
  }

  /**
   * 显示可恢复错误对话框
   * 返回 Promise，等待用户选择后 resolve
   * 
   * @example
   * const choice = await errorHandler.showRecoveryDialog({
   *   title: '同步失败',
   *   message: '无法将更改同步到云端',
   *   options: [
   *     { id: 'retry', label: '重试', style: 'primary' },
   *     { id: 'offline', label: '离线模式', style: 'secondary' },
   *     { id: 'discard', label: '丢弃更改', style: 'danger' }
   *   ]
   * });
   * 
   * if (choice === 'retry') { ... }
   */
  showRecoveryDialog(config: {
    title: string;
    message: string;
    details?: string;
    options: RecoveryOption[];
    defaultOptionId?: string;
    autoSelectIn?: number;
  }): Promise<string> {
    return new Promise((resolve) => {
      this.zone.run(() => {
        this.recoverableError.set({
          ...config,
          resolve: (optionId: string) => {
            this.recoverableError.set(null);
            resolve(optionId);
          }
        });
      });
    });
  }

  /**
   * 关闭恢复对话框（不选择任何选项）
   * 返回 null
   */
  dismissRecoveryDialog(): void {
    const current = this.recoverableError();
    if (current) {
      current.resolve('dismiss');
      this.recoverableError.set(null);
    }
  }

  /**
   * 检测 Angular DI 版本偏移或视图生命周期竞态错误
   * 当 SW 缓存导致不同版本的 chunk 混用时，Angular 的 tView.data 中
   * provider 定义可能为 undefined，导致访问 .factory 或 .onDestroy 失败。
   * 同样在 @defer 块重建/拆除时，如果 effect 清理与视图销毁竞态，
   * 也会在 tick/CD 链路中触发相同的 TypeError。
   */
  private isAngularDIVersionSkewError(message: string, error: unknown): boolean {
    // 必须是 TypeError 且涉及典型 DI/视图属性读取
    if (!(error instanceof TypeError)) return false;
    if (!/Cannot read properties of undefined \(reading [\u2018\u2019'](?:factory|onDestroy|type|providers|viewProviders|ngMetadataName)[\u2018\u2019']\)/i.test(message)) {
      return false;
    }
    // 二次确认：堆栈应来自 Angular 框架内部 DI/CD/tick 链路
    const stack = error.stack ?? '';
    return /executeTemplate|getOrCreateInjectable|renderView|createEmbeddedView|refreshView|tickImpl|_tick\b|detectChangesInAttachedViews/i.test(stack)
      || /\be0\b.*chunk-.*\.js/.test(stack);
  }

  /**
   * 检测 Angular 运行时 JIT 编译错误（通常由缓存版本偏移触发）
   * 典型关键字：
   * - JIT compilation failed for component class
   * - JIT compiler unavailable
   * - getCompilerFacade
   * - needs to be compiled using the JIT compiler
   */
  private isAngularJITVersionSkewError(message: string, error: unknown): boolean {
    // 先用 message 快速匹配
    if (!/JIT compilation failed for component class|JIT compiler unavailable|getCompilerFacade|needs to be compiled using the JIT compiler/i.test(message)) {
      return false;
    }

    // 再用堆栈确认是 Angular core 链路，避免误判业务异常
    const stack = error instanceof Error ? (error.stack ?? '') : '';
    if (!stack) {
      // 某些运行时无法提供 stack，只要 message 命中也按版本偏移处理
      return true;
    }

    return /core\.mjs|getCompilerFacade|ɵɵngDeclareComponent|ngDeclareComponent|chunk-.*\.js/i.test(stack);
  }

  /**
   * 处理 Chunk 加载失败
   * 尝试强制清除缓存后刷新页面，防止 SW 继续返回旧 chunk
   */
  private handleChunkLoadError(errorMessage: string): void {
    if (this.chunkReloadInProgress) {
      return;
    }

    const KEY = 'chunk_load_error_reload_timestamp';
    const lastReload = parseInt(sessionStorage.getItem(KEY) || '0', 10);
    const now = Date.now();

    // 如果 30 秒内已经尝试过清缓存刷新，不再刷新，避免死循环
    if (now - lastReload < 30000) {
      if (this.persistentChunkLoadErrorReported) {
        return;
      }
      this.persistentChunkLoadErrorReported = true;
      this.logger.error('Chunk load error persisted after reload', { message: errorMessage });
      // 降级为 FATAL 错误，提示用户
      this.handleFatalError('应用版本过旧或文件丢失，请尝试清除缓存后刷新页面', undefined, new Error(errorMessage));
      return;
    }

    this.logger.warn('Chunk load error detected, clearing cache and reloading...', { message: errorMessage });
    this.chunkReloadInProgress = true;
    this.persistentChunkLoadErrorReported = false;
    sessionStorage.setItem(KEY, now.toString());

    // 优先走全局“强制清缓存并刷新”工具，避免继续命中旧 SW/HTTP 缓存
    type ForceClearCacheWindow = Window & {
      __NANOFLOW_FORCE_CLEAR_CACHE__?: () => Promise<void> | void;
    };
    const forceClearCache = (window as ForceClearCacheWindow).__NANOFLOW_FORCE_CLEAR_CACHE__;

    if (typeof forceClearCache === 'function') {
      void Promise.resolve(forceClearCache()).catch(() => {
        // 如果全局工具失败，使用回退方案
        void this.forceClearCacheFallback();
      });
      return;
    }

    // 全局工具不可用时使用回退方案
    void this.forceClearCacheFallback();
  }

  /**
   * 回退缓存清理逻辑（当全局工具不可用时）
   */
  private async forceClearCacheFallback(): Promise<void> {
    try {
      if ('caches' in window) {
        const cacheNames = await caches.keys();
        await Promise.all(cacheNames.map(name => caches.delete(name)));
      }
      if ('serviceWorker' in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map(reg => reg.unregister()));
      }
    } catch (e) {
      this.logger.error('Force clear cache fallback failed', e);
    }
    window.location.reload();
  }

  // ========== 私有方法 ==========

  /**
   * 防御性自愈：GoJS Overview `_getOriginRect` 噪声命中 SILENT 后，触发一次
   * `overview.requestUpdate()`，让下一帧用真实 documentBounds 重新 measure。
   *
   * FlowOverviewService 在初始化时会把自己挂到 `window.__NANOFLOW_OVERVIEW_HEAL__`，
   * 这里通过全局函数指针解耦（避免 GlobalErrorHandler 直接依赖 features/flow）。
   */
  private requestOverviewSelfHeal(): void {
    try {
      type OverviewHealWindow = Window & {
        __NANOFLOW_OVERVIEW_HEAL__?: () => void;
      };
      const heal = (window as OverviewHealWindow).__NANOFLOW_OVERVIEW_HEAL__;
      if (typeof heal === 'function') {
        heal();
      }
    } catch (e) {
      // 自愈本身失败不能再触发错误处理链路
      this.logger.debug('Overview self-heal hook failed', { error: e });
    }
  }

  /**
   * 提取错误消息
   * 同时包含 error.name 以便分类规则能匹配 AbortError 等 DOMException 名称
   */
  private extractErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      // 将 error.name 拼入消息，确保 AbortError / TypeError 等分类规则能命中
      const name = error.name && error.name !== 'Error' ? `${error.name}: ` : '';
      return `${name}${error.message}`;
    }
    if (typeof error === 'string') {
      return error;
    }
    if (error && typeof error === 'object') {
      // 处理 HTTP 错误响应
      const errObj = error as { message?: string; error?: { message?: string }; statusText?: string };
      if (errObj.message) return String(errObj.message);
      if (errObj.error?.message) return String(errObj.error.message);
      if (errObj.statusText) return String(errObj.statusText);
    }
    return 'Unknown error';
  }

  /**
   * 根据错误消息自动分类
   * 离线时网络/认证类错误降级为 SILENT，避免 Toast 风暴
   */
  private classifyError(errorMessage: string): ErrorSeverity {
    for (const rule of this.classificationRules) {
      const pattern = typeof rule.pattern === 'string' 
        ? new RegExp(rule.pattern, 'i') 
        : rule.pattern;
      
      if (pattern.test(errorMessage)) {
        return rule.severity;
      }
    }
    
    // 默认为提示级（保守策略，未知错误告知用户）
    return ErrorSeverity.NOTIFY;
  }

  /**
   * 判断当前是否处于离线状态
   * 使用 navigator.onLine 快速判断，避免注入 NetworkAwarenessService 造成循环依赖
   */
  private get isDeviceOffline(): boolean {
    return typeof navigator !== 'undefined' && !navigator.onLine;
  }

  /** 离线时应被静默的网络/认证相关错误模式 */
  private static readonly NETWORK_RELATED_PATTERN =
    /network|offline|fetch.*fail|http.*error|timeout|ECONNREFUSED|unauthorized|401|auth.*error|session.*expir|forbidden|403|\b(?:status|code|http)\s*[:=]?\s*(?:500|502|503|504)\b|server.*error|Gateway Timeout|net::ERR_/i;

  /**
   * 判断错误是否与网络/认证相关（离线时应降级为 SILENT）
   */
  private isNetworkRelatedError(errorMessage: string): boolean {
    return GlobalErrorHandler.NETWORK_RELATED_PATTERN.test(errorMessage);
  }

  /**
   * 获取用户友好的错误消息
   */
  private getUserMessage(errorMessage: string): string {
    for (const rule of this.classificationRules) {
      const pattern = typeof rule.pattern === 'string' 
        ? new RegExp(rule.pattern, 'i') 
        : rule.pattern;
      
      if (pattern.test(errorMessage) && rule.userMessage) {
        return rule.userMessage;
      }
    }
    return '操作失败，请稍后重试';
  }

  /**
   * 检查是否为重复错误
   */
  private isDuplicateError(errorMessage: string): boolean {
    const key = errorMessage.substring(0, 100); // 截取前100字符作为key
    const now = Date.now();
    const lastTime = this.recentErrors.get(key);
    
    if (lastTime && now - lastTime < this.ERROR_DEDUP_INTERVAL) {
      return true;
    }
    
    this.recentErrors.set(key, now);
    
    // 清理过期的错误记录
    if (this.recentErrors.size > 100) {
      const cutoff = now - this.ERROR_DEDUP_INTERVAL;
      for (const [k, v] of this.recentErrors) {
        if (v < cutoff) {
          this.recentErrors.delete(k);
        }
      }
    }
    
    return false;
  }

  /**
   * 处理静默级错误
   */
  private handleSilentError(message: string, stack?: string): void {
    // 仅记录日志，不打扰用户
    this.logger.debug('Silent error captured', { message, stack });
    
    // 静默级错误也上报到 Sentry（用于后续分析）
    this.sentryLoader.captureException(new Error(message), {
      severity: 'silent',
      component: 'GlobalErrorHandler',
    });
  }

  /**
   * 处理提示级错误
   */
  private handleNotifyError(message: string, stack?: string, originalError?: unknown): void {
    // 记录详细日志
    this.logger.warn('Notify-level error', { message, stack });
    
    // 上报到 Sentry
    this.sentryLoader.captureException(originalError ?? new Error(message), {
      severity: 'notify',
      component: 'GlobalErrorHandler',
      userMessage: this.getUserMessage(message),
    });
    
    // 获取用户友好的消息
    const userMessage = this.getUserMessage(message);
    
    // 在 Angular zone 内显示 Toast
    this.zone.run(() => {
      this.toast.error('出错了', userMessage);
    });
  }

  /**
   * 处理致命级错误
   */
  private handleFatalError(message: string, stack?: string, originalError?: unknown): void {
    // 防止重复处理
    if (this.hasFatalError) {
      return;
    }
    
    this.hasFatalError = true;
    
    // 记录错误日志
    this.logger.error('FATAL ERROR', { message, stack, originalError });
    
    // 上报到 Sentry（高优先级）
    this.sentryLoader.captureException(originalError ?? new Error(message), {
      severity: 'fatal',
      component: 'GlobalErrorHandler',
      userMessage: this.getUserMessage(message),
      isFatal: true,
    });
    
    // 保存错误信息到 sessionStorage（用于错误页面显示）
    try {
      // 【P2-14 修复】不在 sessionStorage 存储堆栈信息，防止敏感信息泄露
      sessionStorage.setItem('nanoflow.fatal-error', JSON.stringify({
        message: this.getUserMessage(message),
        userMessage: this.getUserMessage(message),
        timestamp: new Date().toISOString(),
      }));
    } catch (e) {
      // 降级处理：sessionStorage 不可用，忽略
      this.logger.debug('sessionStorage 写入失败', { error: e });
    }
    
    // 在 Angular zone 内导航到错误页面
    // 【安全】仅传递用户安全消息，避免原始错误信息（含堆栈/内部细节）泄露到 UI
    const safeMessage = this.getUserMessage(message);
    this.zone.run(() => {
      void this.router.navigate(['/error'], {
        skipLocationChange: true,
        state: {
          errorMessage: safeMessage,
          userMessage: safeMessage
        }
      });
    });
  }
}
