/**
 * RequestThrottleService - 请求限流服务
 * 
 * 解决问题：
 * - 并发 Supabase API 调用耗尽连接池
 * - 浏览器 HTTP 连接数限制（Chrome 对同一域名最多 6 个并发）
 * - "Failed to fetch" NetworkError
 * 
 * 功能：
 * 1. 限制同时进行的请求数量（默认 4 个）
 * 2. 请求去重（相同 key 的请求复用结果）
 * 3. 指数退避重试（网络错误时）
 * 4. 请求超时保护
 * 
 * 使用示例：
 * ```typescript
 * const result = await throttle.execute(
 *   'fetch-tasks-' + projectId,
 *   () => supabase.from('tasks').select('*').eq('project_id', projectId),
 *   { deduplicate: true }
 * );
 * ```
 */
import { Injectable, inject, signal, DestroyRef } from '@angular/core';
import { LoggerService } from './logger.service';
import { REQUEST_THROTTLE_CONFIG } from '../config';
import {
  createBrowserNetworkSuspendedError,
  isBrowserNetworkSuspendedError,
  isBrowserNetworkSuspendedWindow,
} from '../utils/browser-network-suspension';

/** 请求配置选项 */
export interface ThrottleOptions {
  /** 是否启用去重（相同 key 的请求复用结果）*/
  deduplicate?: boolean;
  /** 请求超时时间（毫秒），默认 30000 */
  timeout?: number;
  /** 请求优先级：high=插队，normal=普通，low=队尾 */
  priority?: 'high' | 'normal' | 'low';
  /** 重试次数，默认 3 */
  retries?: number;
  /** 是否为后台请求（失败时静默处理）*/
  silent?: boolean;
}

/** 队列中的请求项 */
interface QueuedRequest<T> {
  id: string;
  key: string;
  executor: () => Promise<T>;
  options: Required<ThrottleOptions>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  retryCount: number;
  createdAt: number;
}

/** 请求限流配置 - 使用全局常量 */
const THROTTLE_CONFIG = REQUEST_THROTTLE_CONFIG;

@Injectable({
  providedIn: 'root'
})
export class RequestThrottleService {
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('RequestThrottle');
  private readonly destroyRef = inject(DestroyRef);
  
  /** 请求队列 */
  private queue: QueuedRequest<unknown>[] = [];
  
  /** 当前正在执行的请求数 */
  private activeCount = 0;
  
  /** 去重缓存：key -> { promise, expiresAt } */
  private dedupeCache = new Map<string, { 
    promise: Promise<unknown>; 
    expiresAt: number 
  }>();

  /** 去重缓存最大容量，防止长时间运行后内存持续增长 */
  private readonly MAX_DEDUPE_CACHE_SIZE = 500;
  
  /** 当前活跃请求数（可观察） */
  readonly activeRequests = signal(0);
  
  /** 队列长度（可观察） */
  readonly queueLength = signal(0);
  
  constructor() {
    // 定期清理过期的去重缓存
    const cleanupInterval = setInterval(() => this.cleanupDedupeCache(), 10000);
    
    this.destroyRef.onDestroy(() => {
      clearInterval(cleanupInterval);
      this.clearAll();
    });
  }
  
  /**
   * 执行受限流保护的请求
   * 
   * @param key 请求标识（用于去重和日志）
   * @param executor 实际执行请求的函数
   * @param options 配置选项
   * @returns Promise 请求结果
   */
  async execute<T>(
    key: string,
    executor: () => Promise<T>,
    options: ThrottleOptions = {}
  ): Promise<T> {
    const opts: Required<ThrottleOptions> = {
      deduplicate: options.deduplicate ?? false,
      timeout: options.timeout ?? THROTTLE_CONFIG.DEFAULT_TIMEOUT,
      priority: options.priority ?? 'normal',
      retries: options.retries ?? THROTTLE_CONFIG.DEFAULT_RETRIES,
      silent: options.silent ?? false,
    };
    
    // 去重：检查是否有相同 key 的请求正在进行
    if (opts.deduplicate) {
      const cached = this.dedupeCache.get(key);
      if (cached && cached.expiresAt > Date.now()) {
        this.logger.debug('请求去重命中', { key });
        return cached.promise as Promise<T>;
      }
    }
    
    // 队列已满时拒绝低优先级请求
    if (this.queue.length >= THROTTLE_CONFIG.MAX_QUEUE_SIZE) {
      if (opts.priority === 'low') {
        throw new Error(`请求队列已满 (${THROTTLE_CONFIG.MAX_QUEUE_SIZE})，低优先级请求被丢弃`);
      }
      // 高优先级请求移除队尾的低优先级请求
      const lowPriorityIndex = this.queue.findIndex(r => r.options.priority === 'low');
      if (lowPriorityIndex >= 0) {
        const removed = this.queue.splice(lowPriorityIndex, 1)[0];
        removed.reject(new Error('被更高优先级请求抢占'));
        this.logger.debug('移除低优先级请求', { key: removed.key });
      }
    }
    
    // 创建请求 Promise
    const promise = new Promise<T>((resolve, reject) => {
      const request: QueuedRequest<T> = {
        id: crypto.randomUUID(),
        key,
        executor,
        options: opts,
        resolve: resolve as (value: unknown) => void,
        reject,
        retryCount: 0,
        createdAt: Date.now(),
      };
      
      // 根据优先级插入队列
      if (opts.priority === 'high') {
        this.queue.unshift(request as QueuedRequest<unknown>);
      } else {
        this.queue.push(request as QueuedRequest<unknown>);
      }
      
      this.queueLength.set(this.queue.length);
      this.processQueue();
    });

    let cacheablePromise = promise;
    if (opts.deduplicate) {
      cacheablePromise = promise.catch(error => {
        const cached = this.dedupeCache.get(key);
        if (cached?.promise === cacheablePromise) {
          this.dedupeCache.delete(key);
        }
        throw error;
      });
    }
    
    // 如果启用去重，缓存 Promise
    if (opts.deduplicate) {
      this.dedupeCache.set(key, {
        promise: cacheablePromise,
        expiresAt: Date.now() + THROTTLE_CONFIG.DEDUPE_TTL,
      });
    }
    
    return cacheablePromise;
  }
  
  /**
   * 批量执行请求（自动限流）
   * 
   * @param requests 请求列表
   * @param concurrency 并发数（可覆盖默认值）
   * @returns Promise 所有请求结果
   */
  async executeAll<T>(
    requests: Array<{
      key: string;
      executor: () => Promise<T>;
      options?: ThrottleOptions;
    }>,
    concurrency = THROTTLE_CONFIG.MAX_CONCURRENT
  ): Promise<T[]> {
    const results: T[] = [];
    const executing: Promise<void>[] = [];
    
    for (const req of requests) {
      const p = this.execute(req.key, req.executor, req.options)
        .then(result => {
          results.push(result);
        });
      
      executing.push(p);
      
      if (executing.length >= concurrency) {
        await Promise.race(executing);
        // 移除已完成的 Promise
        for (let i = executing.length - 1; i >= 0; i--) {
          Promise.resolve(executing[i]).then(() => {
            const index = executing.indexOf(executing[i]);
            if (index > -1) executing.splice(index, 1);
          }).catch(() => {
            const index = executing.indexOf(executing[i]);
            if (index > -1) executing.splice(index, 1);
          });
        }
      }
    }
    
    await Promise.all(executing);
    return results;
  }
  
  /**
   * 处理请求队列
   */
  private processQueue(): void {
    while (
      this.activeCount < THROTTLE_CONFIG.MAX_CONCURRENT &&
      this.queue.length > 0
    ) {
      const request = this.queue.shift()!;
      this.queueLength.set(this.queue.length);
      this.executeRequest(request);
    }
  }
  
  /**
   * 执行单个请求（带超时和重试）
   */
  private async executeRequest<T>(request: QueuedRequest<T>): Promise<void> {
    this.activeCount++;
    this.activeRequests.set(this.activeCount);
    
    try {
      if (isBrowserNetworkSuspendedWindow()) {
        request.reject(createBrowserNetworkSuspendedError());
        return;
      }

      // 添加超时保护
      const result = await this.withTimeout(
        request.executor(),
        request.options.timeout,
        request.key
      );
      
      request.resolve(result);
    } catch (error) {
      const shouldRetry = this.shouldRetry(error);
      
      if (shouldRetry && request.retryCount < request.options.retries) {
        // 重试：指数退避
        request.retryCount++;
        const delay = this.calculateRetryDelay(request.retryCount);
        
        if (!request.options.silent) {
          this.logger.debug('请求重试', { 
            key: request.key, 
            attempt: request.retryCount,
            delay 
          });
        }
        
        // 延迟后重新加入队列
        setTimeout(() => {
          // 重试请求优先级提升到 high
          this.queue.unshift(request as unknown as QueuedRequest<unknown>);
          this.queueLength.set(this.queue.length);
          this.processQueue();
        }, delay);
      } else {
        // 不再重试，返回错误
        request.reject(error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      this.activeCount--;
      this.activeRequests.set(this.activeCount);
      
      // 继续处理队列
      this.processQueue();
    }
  }
  
  /**
   * 添加超时保护
   */
  private withTimeout<T>(
    promise: Promise<T>,
    timeout: number,
    key: string
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (isBrowserNetworkSuspendedWindow()) {
          reject(createBrowserNetworkSuspendedError());
          return;
        }

        // 【2026-05-16 根因修复】
        // 必须设置 name='TimeoutError'，否则下游 supabaseErrorToError 会因
        // 中文 message 不匹配英文 'timeout' 模式而落入 fallback 分支，把超时
        // 误判为 isRetryable=false，导致 ConnectionSyncOps/TaskSyncOps 把超时
        // 走到「不可重试的错误，不加入重试队列」分支 — 数据直到下次手动编辑
        // 才会重试同步（用户截图复现）。
        // name='TimeoutError' 命中 supabase-error.ts RETRYABLE_ERROR_TYPES 与
        // utils/timeout.ts isRetryableError 的正向集合。
        const timeoutError = new Error(`请求超时 (${timeout}ms): ${key}`);
        timeoutError.name = 'TimeoutError';
        reject(timeoutError);
      }, timeout);
      
      promise
        .then(result => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch(error => {
          clearTimeout(timer);
          if (isBrowserNetworkSuspendedError(error) || isBrowserNetworkSuspendedWindow()) {
            reject(createBrowserNetworkSuspendedError());
            return;
          }

          reject(error);
        });
    });
  }
  
  /**
   * 判断是否应该重试
   */
  private shouldRetry(error: unknown): boolean {
    // 【#95057880 修复】PermanentFailureError 绝不重试（会话过期、版本冲突等）
    if (error instanceof Error && 
        ('isPermanentFailure' in error && (error as { isPermanentFailure?: boolean }).isPermanentFailure === true)) {
      return false;
    }

    if (isBrowserNetworkSuspendedError(error)) {
      return false;
    }

    if (isBrowserNetworkSuspendedWindow()) {
      return false;
    }
    
    // Supabase 错误是普通对象 {code, message, details}，非 Error 实例
    if (!(error instanceof Error)) {
      const errObj = error as { code?: string; message?: string };
      const code = errObj?.code;
      // PostgREST 业务错误码不应重试
      if (code === 'PGRST116' || code === '42501' || code === '23503' || code === '42P01') {
        return false;
      }
      return true;
    }
    
    const message = error.message.toLowerCase();
    
    // 网络错误：应该重试
    if (
      message.includes('failed to fetch') ||
      message.includes('network') ||
      message.includes('timeout') ||
      message.includes('429') ||
      message.includes('503') ||
      message.includes('504')
    ) {
      return true;
    }
    
    // 业务错误：不应该重试
    if (
      message.includes('not found') ||
      message.includes('not acceptable') ||
      message.includes('406') ||
      message.includes('permission denied') ||
      message.includes('unauthorized') ||
      message.includes('forbidden') ||
      message.includes('row level security') ||
      message.includes('unique constraint') ||
      message.includes('foreign key') ||
      message.includes('23503')
    ) {
      return false;
    }
    
    // 默认重试
    return true;
  }
  
  /**
   * 计算重试延迟（指数退避 + 抖动）
   */
  private calculateRetryDelay(retryCount: number): number {
    // 指数退避：1s, 2s, 4s, 8s...
    const exponentialDelay = THROTTLE_CONFIG.RETRY_BASE_DELAY * Math.pow(2, retryCount - 1);
    
    // 添加随机抖动（±20%）
    const jitter = exponentialDelay * 0.2 * (Math.random() * 2 - 1);
    
    // 限制最大延迟
    return Math.min(
      exponentialDelay + jitter,
      THROTTLE_CONFIG.RETRY_MAX_DELAY
    );
  }
  
  /**
   * 清理过期的去重缓存
   * 【2026-02-15 修复】增加容量上限保护，防止长时间运行后 Map 无限增长
   */
  private cleanupDedupeCache(): void {
    const now = Date.now();
    const expiredKeys: string[] = [];
    this.dedupeCache.forEach((value, key) => {
      if (value.expiresAt < now) {
        expiredKeys.push(key);
      }
    });
    expiredKeys.forEach(key => {
      this.dedupeCache.delete(key);
    });
    // 容量保护：超过上限时按过期时间排序淘汰最旧的条目
    if (this.dedupeCache.size > this.MAX_DEDUPE_CACHE_SIZE) {
      const entries = Array.from(this.dedupeCache.entries())
        .sort((a, b) => a[1].expiresAt - b[1].expiresAt);
      const toRemove = entries.length - this.MAX_DEDUPE_CACHE_SIZE;
      for (let i = 0; i < toRemove; i++) {
        this.dedupeCache.delete(entries[i][0]);
      }
    }
  }
  
  /**
   * 清除所有待处理请求
   */
  clearAll(): void {
    for (const request of this.queue) {
      request.reject(new Error('请求被取消'));
    }
    this.queue = [];
    this.queueLength.set(0);
    this.dedupeCache.clear();
  }
  
  /**
   * 获取当前状态（调试用）
   */
  getStatus(): {
    activeCount: number;
    queueLength: number;
    dedupeCacheSize: number;
  } {
    return {
      activeCount: this.activeCount,
      queueLength: this.queue.length,
      dedupeCacheSize: this.dedupeCache.size,
    };
  }
}
