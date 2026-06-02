import { Injectable, inject, signal } from '@angular/core';
import type { AuthResponse, Session, SupabaseClient } from '@supabase/supabase-js';
import { LoggerService } from './logger.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { environment } from '../environments/environment';
import type { Database } from '../types/supabase';
import { FEATURE_FLAGS } from '../config/feature-flags.config';
import { SUPABASE_CLIENT_FETCH_MAX_MS, NETWORK_OFFLINE_DEBOUNCE_MS } from '../config/timeout.config';
import {
  createBrowserNetworkSuspendedError,
  ensureBrowserNetworkSuspensionTracking,
  getRemainingBrowserNetworkResumeDelayMs,
  isBrowserNetworkSuspendedError,
  isBrowserNetworkSuspendedWindow,
} from '../utils/browser-network-suspension';

export interface SupabaseConnectivityChange {
  offline: boolean;
  source: 'probe' | 'request' | 'manual';
}

type SupabaseConnectivityListener = (change: SupabaseConnectivityChange) => void;
type RealtimeHeartbeatPayload = string | {
  status?: string;
  event?: string;
  reason?: string;
};

/**
 * 敏感密钥检测模式
 * 用于防止 SERVICE_ROLE_KEY 意外泄露到前端
 */
const SENSITIVE_KEY_PATTERNS = ['service_role', 'secret', 'private', 'admin'];

const READ_ONLY_RPC_FUNCTIONS = new Set([
  'batch_get_tombstones',
  'get_accessible_project_probe',
  'get_black_box_sync_watermark',
  'get_full_project_data',
  'get_project_sync_watermark',
  'get_resume_recovery_probe',
  'get_server_time',
  'get_user_projects_watermark',
  'list_project_heads_since',
  'sync_check_protocol',
]);

function decodeBase64UrlJson(segment: string): Record<string, unknown> | null {
  if (!segment) return null;

  const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
  const paddingLength = normalized.length % 4;
  const padded = paddingLength === 0 ? normalized : `${normalized}${'='.repeat(4 - paddingLength)}`;

  try {
    const decoded = atob(padded);
    return JSON.parse(decoded) as Record<string, unknown>;
  } catch {
     return null; // eslint-disable-line no-restricted-syntax -- JWT payload 解析边界：atob/JSON.parse 失败等同于"无效 token"，null 是正确语义
  }
}

function extractSupabaseProjectRefFromUrl(url: string): string | null {
  if (!url) return null;

  try {
    const hostname = new URL(url).hostname;
    if (!hostname.endsWith('.supabase.co')) {
      return null;
    }

    return hostname.split('.')[0] || null;
  } catch {
    return null;
  }
}

function extractLegacyAnonProjectRef(key: string): string | null {
  if (!key) return null;

  const parts = key.split('.');
  if (parts.length !== 3) {
    return null;
  }

  const payload = decodeBase64UrlJson(parts[1]);
  return typeof payload?.['ref'] === 'string' ? payload['ref'] : null;
}

@Injectable({
  providedIn: 'root'
})
export class SupabaseClientService {
  private readonly logger = inject(LoggerService).category('SupabaseClient');
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private supabase: SupabaseClient<Database> | null = null;
  private initPromise: Promise<SupabaseClient<Database> | null> | null = null;

  // 【鲁棒性 3】fetch 层 401 重试计数，防止无限重试
  // key: 请求 URL + method，value: 已重试次数
  private readonly fetch401RetryCount = new Map<string, number>();
  private readonly MAX_FETCH_401_RETRIES = 1; // 最多重试一次（总共 2 次请求）

  // 【根因修复 2026-04-20】Supabase 网关瞬时 5xx（502/503/504）静默重试。
  // 背景：用户控制台频繁出现 "Access-Control-Allow-Origin ... blocked by CORS"，
  // 实为 Supabase edge 返回 502 时未携带 CORS 头，被浏览器错报为 CORS 错误。
  // 这类 5xx 几乎都是上游 PostgREST 瞬时波动，重试一次即可恢复。
  // 仅对幂等方法（GET/HEAD）启用，写操作由上层 RetryQueue 负责。
  private readonly MAX_FETCH_GATEWAY_RETRIES = 2; // 最多额外重试 2 次（总共 3 次请求）
  private readonly FETCH_GATEWAY_RETRY_BASE_MS = 300; // 指数退避基数：300ms → 600ms
  private readonly FETCH_GATEWAY_RETRY_JITTER_MS = 150; // 抖动上限，避免雷鸣群效应

  // 【鲁棒性 5】token 续签指标收集
  private readonly proactiveRefreshMetrics = {
    totalAttempts: 0,
    successCount: 0,
    failureCount: 0,
    nearingExpiryCount: 0, // 发现即将过期的次数
    lastRefreshAt: 0,
    lastFailureAt: 0
  };

  // 【鲁棒性 8】请求去重缓存 - 防止网络不稳定时同一请求重复发送
  // key: 请求签名（method+url+body hash），value: { promise, createdAt, response }
  private readonly requestDeduplicationCache = new Map<string, {
    promise: Promise<Response>;
    createdAt: number;
    response?: Response;
  }>();
  private readonly REQUEST_DEDUP_TTL_MS = 5000; // 5s 内去重
  
  private reachabilityProbePromise: Promise<boolean> | null = null;
  private readonly connectivityListeners = new Set<SupabaseConnectivityListener>();
  private lastReachabilityProbeAt = 0;
  private lastReachabilityProbeResult = true;
  private authAutoRefreshTakenOver = false;
  private authAutoRefreshRunning = false;
  private authAutoRefreshResumeTimer: ReturnType<typeof setTimeout> | null = null;
  private authAutoRefreshSyncChain: Promise<void> = Promise.resolve();
  private authAutoRefreshLifecycleBound = false;
  private authVisibilityChangeHandler: (() => void) | null = null;
  private authPageShowHandler: ((event: PageTransitionEvent) => void) | null = null;
  private authOnlineHandler: (() => void) | null = null;
  private authOfflineHandler: (() => void) | null = null;

  private readonly canInitialize: boolean;
  private readonly supabaseUrl: string;
  private readonly supabaseAnonKey: string;

  // 配置状态信号，UI 可以响应式订阅
  readonly configurationError = signal<string | null>(null);
  readonly isOfflineMode = signal(false);

  constructor() {
    const supabaseUrl = environment.supabaseUrl;
    const supabaseAnonKey = environment.supabaseAnonKey;

    // 检查是否为模板占位符
    const isPlaceholder = (val: string) =>
      !val || val === 'YOUR_SUPABASE_URL' || val === 'YOUR_SUPABASE_ANON_KEY';

    if (isPlaceholder(supabaseUrl) || isPlaceholder(supabaseAnonKey)) {
      const errorMsg = 'Supabase 环境变量未配置。请运行 npm run config 或手动配置 .env.local 文件。';

      if (environment.production) {
        // 生产环境：记录严重错误
        this.logger.error('[CRITICAL] 环境变量未配置', errorMsg);
        this.configurationError.set(errorMsg);
      } else {
        // 开发环境：信息提示并进入离线模式（这是预期行为，不是警告）
        this.logger.info('开发环境离线模式已启用', errorMsg);
        this.isOfflineMode.set(true);
      }
      this.canInitialize = false;
      this.supabaseUrl = '';
      this.supabaseAnonKey = '';
      return;
    }

    // 🔒 安全检查：确保不会意外使用 SERVICE_ROLE_KEY
    if (this.isSensitiveKey(supabaseAnonKey)) {
      const securityError = '[SECURITY] 检测到敏感密钥！前端不应使用 SERVICE_ROLE_KEY，请使用 ANON_KEY。';
      this.logger.error(securityError);
      this.configurationError.set('安全配置错误：请使用公开的 ANON_KEY 而非 SERVICE_ROLE_KEY');
      this.isOfflineMode.set(true);
      this.canInitialize = false;
      this.supabaseUrl = '';
      this.supabaseAnonKey = '';
      return;
    }

    const urlProjectRef = extractSupabaseProjectRefFromUrl(supabaseUrl);
    const legacyKeyProjectRef = extractLegacyAnonProjectRef(supabaseAnonKey);
    if (urlProjectRef && legacyKeyProjectRef && urlProjectRef !== legacyKeyProjectRef) {
      const configError = `Supabase 配置错误：URL 指向项目 ${urlProjectRef}，但 ANON_KEY 属于项目 ${legacyKeyProjectRef}。请保持 NG_APP_SUPABASE_URL 与 NG_APP_SUPABASE_ANON_KEY 来自同一项目。`;
      this.logger.error('[CRITICAL] Supabase URL / ANON_KEY 项目不一致', {
        urlProjectRef,
        legacyKeyProjectRef,
      });
      this.configurationError.set(configError);
      this.isOfflineMode.set(true);
      this.canInitialize = false;
      this.supabaseUrl = '';
      this.supabaseAnonKey = '';
      return;
    }

    this.canInitialize = true;
    this.supabaseUrl = supabaseUrl;
    this.supabaseAnonKey = supabaseAnonKey;

    // 兼容开关：关闭延迟装载时维持启动期初始化
    if (!FEATURE_FLAGS.SUPABASE_DEFERRED_SDK_V1) {
      void this.ensureClientReady().catch((error) => {
        this.logger.warn('启动期 Supabase 初始化失败，降级为离线模式', error);
      });
    }
  }

  /**
   * 检测是否为敏感密钥
   * 通过 JWT payload 分析或密钥命名模式检测
   */
  private isSensitiveKey(key: string): boolean {
    if (!key) return false;

    // JWT 格式：header.payload.signature
    const parts = key.split('.');
    if (parts.length === 3) {
      const payload = decodeBase64UrlJson(parts[1]);
      const role = typeof payload?.['role'] === 'string' ? payload['role'] : null;

      if (role === 'anon') {
        return false;
      }

      if (role) {
        this.logger.error('检测到非匿名角色密钥，已阻止使用', { role });
        return true;
      }
    }

    // 字符串模式检测（备用）
    const lowerKey = key.toLowerCase();
    return SENSITIVE_KEY_PATTERNS.some(pattern => lowerKey.includes(pattern));
  }

  get isConfigured(): boolean {
    return this.canInitialize;
  }

  /**
   * 返回 Supabase auth token 在 localStorage 中的存储键名。
   * 供本地会话快速路径读取（避免重复硬编码 key 格式）。
   */
  getStorageKey(): string | null {
    if (!this.canInitialize || !this.supabaseUrl) return null;
    try {
      return `sb-${new URL(this.supabaseUrl).hostname.split('.')[0]}-auth-token`;
    } catch {
        return null; // eslint-disable-line no-restricted-syntax -- URL 解析失败时 auth token key 不可用，null 是正确语义
    }
  }

  async clientAsync(): Promise<SupabaseClient<Database> | null> {
    if (!this.canInitialize) return null;
    if (this.supabase) return this.supabase;
    if (this.initPromise) return this.initPromise;

    this.initPromise = import('@supabase/supabase-js')
      .then(({ createClient }) => {
        this.supabase = createClient<Database>(
          this.supabaseUrl,
          this.supabaseAnonKey,
          this.buildClientOptions()
        );
        this.ensureAuthAutoRefreshLifecycle();
        void this.syncAuthAutoRefresh('client-init');
        return this.supabase;
      })
      .catch((error) => {
        this.logger.error('Supabase 客户端初始化失败', error);
        this.configurationError.set('Supabase 客户端初始化失败');
        this.supabase = null;
        return null;
      })
      .finally(() => {
        this.initPromise = null;
      });

    return this.initPromise;
  }

  async ensureClientReady(): Promise<void> {
    const client = await this.clientAsync();
    if (!client) {
      throw new Error('Supabase 客户端未就绪（可能是配置缺失或初始化失败）');
    }
  }

  onConnectivityChange(listener: SupabaseConnectivityListener): () => void {
    this.connectivityListeners.add(listener);
    return () => {
      this.connectivityListeners.delete(listener);
    };
  }

  private setOfflineModeState(
    offline: boolean,
    source: SupabaseConnectivityChange['source']
  ): void {
    const changed = this.isOfflineMode() !== offline;
    this.isOfflineMode.set(offline);

    if (!changed) {
      return;
    }

    void this.syncAuthAutoRefresh(offline ? 'offline' : 'resume-timer');

    for (const listener of this.connectivityListeners) {
      try {
        listener({ offline, source });
      } catch (error) {
        this.logger.debug('Supabase 连通性监听器执行失败', { source, error });
      }
    }
  }

  async probeReachability(options?: { timeoutMs?: number; force?: boolean }): Promise<boolean> {
    if (!this.canInitialize) {
      this.setOfflineModeState(true, 'probe');
      this.lastReachabilityProbeResult = false;
      this.lastReachabilityProbeAt = Date.now();
      return false;
    }

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      this.setOfflineModeState(true, 'probe');
      this.lastReachabilityProbeResult = false;
      this.lastReachabilityProbeAt = Date.now();
      return false;
    }

    if (isBrowserNetworkSuspendedWindow()) {
      this.logger.debug('浏览器网络挂起窗口内跳过 Supabase 连通性探测');
      return false;
    }

    const now = Date.now();
    const force = options?.force === true;
    const timeoutMs = Math.max(250, options?.timeoutMs ?? 5000);
    const cacheTtlMs = 15_000;

    if (!force && this.reachabilityProbePromise) {
      return this.reachabilityProbePromise;
    }

    if (!force && now - this.lastReachabilityProbeAt < cacheTtlMs) {
      return this.lastReachabilityProbeResult;
    }

    if (typeof fetch !== 'function') {
      this.setOfflineModeState(false, 'probe');
      this.lastReachabilityProbeResult = true;
      this.lastReachabilityProbeAt = now;
      return true;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const authProbeUrl = new URL('/auth/v1/health', this.supabaseUrl).toString();

    // 可达性探测：只用 Auth health 端点判断（公开，不需要认证）
    // REST /rest/v1/ 端点可能因 anon key 权限不足返回 401，这不代表服务不可达
    this.reachabilityProbePromise = fetch(authProbeUrl, {
        method: 'GET',
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          apikey: this.supabaseAnonKey,
        },
      })
      .then((authResponse) => {
        // 收到 HTTP 响应即表示网络可达
        // 仅 502-504 网关错误可能表示 Supabase 后端不可用
        const isGatewayError = authResponse.status >= 502 && authResponse.status <= 504;
        const reachable = !isGatewayError;
        this.setOfflineModeState(!reachable, 'probe');
        this.lastReachabilityProbeResult = reachable;
        this.lastReachabilityProbeAt = Date.now();

        if (!reachable) {
          this.logger.info('Supabase 连通性探测返回网关错误', {
            authStatus: authResponse.status,
          });
        }

        return reachable;
      })
      .catch((error: unknown) => {
        this.setOfflineModeState(true, 'probe');
        this.lastReachabilityProbeResult = false;
        this.lastReachabilityProbeAt = Date.now();
        this.logger.info('Supabase 连通性探测失败，进入连接中断模式', {
          message: error instanceof Error ? error.message : String(error),
        });
        return false;
      })
      .finally(() => {
        clearTimeout(timeoutId);
        this.reachabilityProbePromise = null;
      });

    return this.reachabilityProbePromise;
  }

  clearOfflineMode(): void {
    this.setOfflineModeState(false, 'manual');
    this.lastReachabilityProbeResult = true;
    this.lastReachabilityProbeAt = Date.now();
  }

  private shouldMarkOfflineFromFetchFailure(error: unknown): boolean {
    if (isBrowserNetworkSuspendedError(error)) {
      return false;
    }

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return true;
    }

    if (error instanceof DOMException) {
      return error.name === 'NetworkError';
    }

    if (error instanceof TypeError) {
      const message = error.message.toLowerCase();
      return message.includes('failed to fetch') || message.includes('network');
    }

    return false;
  }

  /**
   * 同步客户端获取仅用于“已就绪路径”。
   * 未就绪时抛出可诊断错误，调用方应改用 clientAsync/ensureClientReady。
   */
  client(): SupabaseClient<Database> {
    if (!this.canInitialize) {
      throw new Error('Supabase 未配置，请提供 NG_APP_SUPABASE_URL 与 NG_APP_SUPABASE_ANON_KEY');
    }
    if (!this.supabase) {
      throw new Error('Supabase 客户端尚未就绪，请先调用 ensureClientReady() 或 clientAsync()');
    }
    return this.supabase;
  }

  reset(): void {
    const client = this.supabase;
    this.clearAuthAutoRefreshResumeTimer();
    this.teardownAuthAutoRefreshLifecycle();
    this.authAutoRefreshTakenOver = false;
    this.authAutoRefreshRunning = false;
    this.authAutoRefreshSyncChain = Promise.resolve();
    if (client) {
      void client.auth.stopAutoRefresh().catch((error: unknown) => {
        this.logger.debug('重置时停止 Supabase Auth 自动刷新失败', { error });
      });
    }
    this.supabase = null;
    this.initPromise = null;
  }

  private ensureAuthAutoRefreshLifecycle(): void {
    if (this.authAutoRefreshLifecycleBound || typeof window === 'undefined' || typeof document === 'undefined') {
      return;
    }

    ensureBrowserNetworkSuspensionTracking();

    this.authVisibilityChangeHandler = () => {
      void this.syncAuthAutoRefresh('visibilitychange');
    };
    this.authPageShowHandler = () => {
      void this.syncAuthAutoRefresh('pageshow');
    };
    this.authOnlineHandler = () => {
      void this.syncAuthAutoRefresh('online');
    };
    this.authOfflineHandler = () => {
      void this.syncAuthAutoRefresh('offline');
    };

    document.addEventListener('visibilitychange', this.authVisibilityChangeHandler);
    window.addEventListener('pageshow', this.authPageShowHandler as EventListener);
    window.addEventListener('online', this.authOnlineHandler);
    window.addEventListener('offline', this.authOfflineHandler);
    this.authAutoRefreshLifecycleBound = true;
  }

  private teardownAuthAutoRefreshLifecycle(): void {
    if (typeof document !== 'undefined' && this.authVisibilityChangeHandler) {
      document.removeEventListener('visibilitychange', this.authVisibilityChangeHandler);
    }

    if (typeof window !== 'undefined' && this.authPageShowHandler) {
      window.removeEventListener('pageshow', this.authPageShowHandler as EventListener);
    }

    if (typeof window !== 'undefined' && this.authOnlineHandler) {
      window.removeEventListener('online', this.authOnlineHandler);
    }

    if (typeof window !== 'undefined' && this.authOfflineHandler) {
      window.removeEventListener('offline', this.authOfflineHandler);
    }

    this.authVisibilityChangeHandler = null;
    this.authPageShowHandler = null;
    this.authOnlineHandler = null;
    this.authOfflineHandler = null;
    this.authAutoRefreshLifecycleBound = false;
  }

  private clearAuthAutoRefreshResumeTimer(): void {
    if (!this.authAutoRefreshResumeTimer) {
      return;
    }

    clearTimeout(this.authAutoRefreshResumeTimer);
    this.authAutoRefreshResumeTimer = null;
  }

  private shouldPauseAuthAutoRefresh(): boolean {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
      return true;
    }

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return true;
    }

    if (this.isOfflineMode()) {
      return true;
    }

    return false;
  }

  private syncAuthAutoRefresh(
    reason: 'client-init' | 'visibilitychange' | 'pageshow' | 'online' | 'offline' | 'resume-timer'
  ): Promise<void> {
    if (!this.supabase) {
      return Promise.resolve();
    }

    this.authAutoRefreshSyncChain = this.authAutoRefreshSyncChain
      .catch(() => undefined)
      .then(async () => {
        const client = this.supabase;
        if (!client) {
          return;
        }

        if (this.shouldPauseAuthAutoRefresh()) {
          this.clearAuthAutoRefreshResumeTimer();
          await this.stopAuthAutoRefresh(client, reason);
          return;
        }

        if (isBrowserNetworkSuspendedWindow()) {
          const delayMs = Math.max(getRemainingBrowserNetworkResumeDelayMs(), 50);
          this.clearAuthAutoRefreshResumeTimer();
          await this.stopAuthAutoRefresh(client, reason);
          this.authAutoRefreshResumeTimer = setTimeout(() => {
            this.authAutoRefreshResumeTimer = null;
            void this.syncAuthAutoRefresh('resume-timer');
          }, delayMs);
          return;
        }

        this.clearAuthAutoRefreshResumeTimer();
        // 【根本修复】页面恢复/网络恢复瞬间主动检查 token 是否已过期 / 即将过期，
        // 是则立即 await refreshSession，确保之后发出的首批业务请求不会带过期 token。
        // 这从源头消除了"恢复后控制台刷 401 → 重试恢复"的可见错误窗口。
        if (reason === 'visibilitychange' || reason === 'pageshow' || reason === 'online' || reason === 'resume-timer') {
          await this.proactivelyRefreshIfNearingExpiry(client, reason);
        }
        await this.startAuthAutoRefresh(client, reason);
      });

    return this.authAutoRefreshSyncChain;
  }

  /**
   * 【根本修复】在页面/网络恢复时，若当前 session 已过期或 60s 内即将过期，
   * 主动 await refreshSession 强制刷新，避免业务请求带过期 token 后再触发 401 自愈。
   * autoRefreshToken 的 setTimeout 在浏览器挂起时会停摆，恢复后来不及触发——这里填补这个空档。
   */
  private async proactivelyRefreshIfNearingExpiry(
    client: SupabaseClient<Database>,
    reason: 'client-init' | 'visibilitychange' | 'pageshow' | 'online' | 'offline' | 'resume-timer'
  ): Promise<void> {
    try {
      const { data, error } = await client.auth.getSession();
      if (error || !data.session) {
        return;
      }
      const expiresAt = data.session.expires_at;
      if (!expiresAt) {
        return;
      }
      const expiresAtMs = expiresAt * 1000;
      const remainingMs = expiresAtMs - Date.now();
      // token 已过期或 60 秒内即将过期 → 主动刷新
      const REFRESH_THRESHOLD_MS = 60_000;
      if (remainingMs > REFRESH_THRESHOLD_MS) {
        return;
      }
      // 仅在真正触发刷新时才计入指标，避免分母虚高导致成功率失真
      this.proactiveRefreshMetrics.totalAttempts++;
      this.proactiveRefreshMetrics.nearingExpiryCount++;
      this.logger.debug('浏览器恢复时 token 临近/已过期，主动刷新', {
        reason,
        remainingMs,
      });
      try {
        const { error: refreshError } = await client.auth.refreshSession();
        if (refreshError) {
          this.logger.warn('恢复时主动刷新 session 失败', { reason, error: refreshError.message });
          this.proactiveRefreshMetrics.failureCount++;
          this.proactiveRefreshMetrics.lastFailureAt = Date.now();
        } else {
          this.logger.debug('恢复时主动刷新 session 成功', { reason });
          this.proactiveRefreshMetrics.successCount++;
          this.proactiveRefreshMetrics.lastRefreshAt = Date.now();
        }
      } catch (refreshError) {
        // refreshSession 本身抛出（网络异常等），计入失败（totalAttempts 已递增，保证分母一致）
        this.logger.debug('恢复时主动刷新 session 抛出异常', { reason, error: refreshError });
        this.proactiveRefreshMetrics.failureCount++;
        this.proactiveRefreshMetrics.lastFailureAt = Date.now();
      }
    } catch (error) {
      // getSession() 等早期步骤抛出，未到达阈值判断，不计入刷新指标
      this.logger.debug('恢复时主动校验 session 异常', { reason, error });
    }
  }

  /**
   * 【鲁棒性 5】获取 token 续签指标（供调试/监控使用）
   */
  getProactiveRefreshMetrics() {
    return {
      ...this.proactiveRefreshMetrics,
      successRate: this.proactiveRefreshMetrics.totalAttempts > 0
        ? (this.proactiveRefreshMetrics.successCount / this.proactiveRefreshMetrics.totalAttempts * 100).toFixed(2) + '%'
        : 'N/A'
    };
  }

  private async stopAuthAutoRefresh(
    client: SupabaseClient<Database>,
    reason: 'client-init' | 'visibilitychange' | 'pageshow' | 'online' | 'offline' | 'resume-timer'
  ): Promise<void> {
    if (this.authAutoRefreshTakenOver && !this.authAutoRefreshRunning) {
      return;
    }

    try {
      await client.auth.stopAutoRefresh();
      this.authAutoRefreshTakenOver = true;
      this.authAutoRefreshRunning = false;
      this.logger.debug('Supabase Auth 自动刷新已暂停', { reason });
    } catch (error) {
      this.logger.warn('暂停 Supabase Auth 自动刷新失败', { reason, error });
    }
  }

  private async startAuthAutoRefresh(
    client: SupabaseClient<Database>,
    reason: 'client-init' | 'visibilitychange' | 'pageshow' | 'online' | 'offline' | 'resume-timer'
  ): Promise<void> {
    if (this.authAutoRefreshTakenOver && this.authAutoRefreshRunning) {
      return;
    }

    try {
      await client.auth.startAutoRefresh();
      this.authAutoRefreshTakenOver = true;
      this.authAutoRefreshRunning = true;
      this.logger.debug('Supabase Auth 自动刷新已启动', { reason });
    } catch (error) {
      this.logger.warn('启动 Supabase Auth 自动刷新失败', { reason, error });
    }
  }

  async getSession(): Promise<{ data: { session: Session | null }; error: null | { message: string; status?: number; name?: string } }> {
    const client = await this.clientAsync();
    if (!client) {
      // 客户端不可用时返回 error，而非 { session: null, error: null }。
      // 后者会被误判为"用户确实未登录"，导致 FastPath 乐观状态被清除。
      return { data: { session: null }, error: { message: 'Supabase 客户端不可用', name: 'ClientUnavailable' } };
    }
    return client.auth.getSession();
  }

  async signInWithPassword(email: string, password: string): Promise<AuthResponse> {
    const client = await this.clientAsync();
    if (!client) {
      throw new Error('Supabase 未配置，无法登录');
    }
    return client.auth.signInWithPassword({ email, password });
  }

  async signOut(): Promise<void> {
    const client = await this.clientAsync();
    if (!client) return;
    await client.auth.signOut();
  }

  /**
   * 【根本修复】Supabase 客户端 fetch 层 401 自愈拦截器。
   *
   * 问题：REST/Functions/Storage 端点收到 401（JWT expired）后，Supabase JS 自身不会
   * 自动刷新+重试，而是把错误抛回调用方；各调用点必须自行实现 withAuthRetry。这种
   * 分散式自愈容易遗漏路径（如未经测试的冷门端点），造成控制台刷 401。
   *
   * 方案：把自愈逻辑下沉到 fetch 层——所有经 Supabase 客户端发出的请求都透明地获得
   *   "401 → refreshSession → retry once" 能力。Refresh token 自身请求（/auth/v1/token）
   *   绕过本逻辑以避免递归。每个请求最多重试一次，避免风暴。
   *
   * 这是三层防御的最内层：预防（proactivelyRefreshIfNearingExpiry）+ 拦截（本方法）
   * + 兜底（上层的 withAuthRetry 仍保留）。任何一层单独都能解决大部分问题，三层叠加
   *   逼近零可见 401 错误。
   */
  private async supabaseFetch(url: RequestInfo | URL, options: RequestInit = {}): Promise<Response> {
    if (isBrowserNetworkSuspendedWindow()) {
      return Promise.reject(createBrowserNetworkSuspendedError());
    }

    // 离线时直接拒绝，避免等待超时产生 AbortError
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      return Promise.reject(new DOMException('Device is offline', 'NetworkError'));
    }

    if (this.isOfflineMode()) {
      return Promise.reject(createBrowserNetworkSuspendedError());
    }

    // 【鲁棒性 8】请求去重：5s 内的重复读取请求复用前一个结果（GET/HEAD + 只读 RPC，写操作不去重）
    const httpMethod = this.getRequestMethod(url, options);
    const isGatewayRetrySafeRequest = this.isGatewayRetrySafeRequest(url, options, httpMethod);

    if (isGatewayRetrySafeRequest) {
      const signature = this.buildRequestSignature(url, options);
      const cached = this.requestDeduplicationCache.get(signature);

      if (cached && Date.now() - cached.createdAt < this.REQUEST_DEDUP_TTL_MS) {
        this.logger.debug('请求去重命中，复用缓存结果', { signature });
        if (cached.response) {
          return cached.response.clone();
        }
        // 【根因修复】cached.response 未就绪时，多个并发 awaiter 会拿到同一个原始
        // Response 实例；一旦下游（如 Supabase JS）消费 body，其他 awaiter 再读就会
        // 抛 "Failed to execute 'text' on 'Response': body stream already read"。
        // 必须 clone 后再返回，保证每个 awaiter 独占 body 流。
        const sharedResponse = await cached.promise;
        return sharedResponse.clone();
      }

      // 清理过期缓存
      this.cleanupDeduplicationCache();

      // 缓存本次请求的 promise，后续请求会 await 它而不是重新发送
      const fetchPromise = (async () => {
        try {
          // 【根因修复 2026-04-20】读取请求启用网关 5xx 静默重试，吸收 Supabase edge
          // 瞬时 502/503/504（浏览器常误报为 CORS 错误），避免上抛到 UI。
          const response = await this.fetchWithGatewayRetry(url, options);
          const cacheEntry = this.requestDeduplicationCache.get(signature);
          if (cacheEntry) {
            cacheEntry.response = response.clone();
          }
          return response;
        } catch (err) {
          // 请求失败时主动清除缓存，允许后续请求立即重试而非复用失败的 promise
          this.requestDeduplicationCache.delete(signature);
          throw err;
        }
      })();

      this.requestDeduplicationCache.set(signature, {
        promise: fetchPromise,
        createdAt: Date.now()
      });

      // 【根因修复】首个调用方也必须 clone：若并发 awaiter 同时存在，双方拿到的都是
      // 同一个原始 Response；这里 clone 后再交给 handle401Retry 与下游消费。
      const dedupResponse = (await fetchPromise).clone();
      return await this.handle401Retry(url, options, dedupResponse);
    }

    // 非幂等请求（POST/PATCH/PUT/DELETE 等）：直接发送，不去重
    const directResponse = await this.fetchWithTimeout(url, options);
    return await this.handle401Retry(url, options, directResponse);
  }

  private getRequestMethod(url: RequestInfo | URL, options: RequestInit): string {
    if (typeof options.method === 'string' && options.method.length > 0) {
      return options.method.toUpperCase();
    }

    if (this.isRequestObject(url) && typeof url.method === 'string' && url.method.length > 0) {
      return url.method.toUpperCase();
    }

    return 'GET';
  }

  private isGatewayRetrySafeRequest(url: RequestInfo | URL, options: RequestInit, httpMethod: string): boolean {
    return httpMethod === 'GET'
      || httpMethod === 'HEAD'
      || this.isReadOnlyRpcRequest(url, options, httpMethod);
  }

  private isReadOnlyRpcRequest(url: RequestInfo | URL, options: RequestInit, httpMethod: string): boolean {
    if (httpMethod !== 'POST') {
      return false;
    }

    if (this.isRequestObject(url) && options.body === undefined) {
      return false;
    }

    const rpcFunctionName = this.extractRpcFunctionName(url);
    return rpcFunctionName !== null && READ_ONLY_RPC_FUNCTIONS.has(rpcFunctionName);
  }

  private isRequestObject(url: RequestInfo | URL): url is Request {
    return typeof Request !== 'undefined' && url instanceof Request;
  }

  private extractRpcFunctionName(url: RequestInfo | URL): string | null {
    const raw = typeof url === 'string'
      ? url
      : url instanceof URL
        ? url.href
        : (url as Request).url;

    if (!raw) {
      return null;
    }

    try {
      const parsed = new URL(raw, 'http://localhost');
      const pathSegments = parsed.pathname.split('/').filter(Boolean);
      const rpcIndex = pathSegments.lastIndexOf('rpc');
      const functionName = rpcIndex >= 0 ? pathSegments[rpcIndex + 1] : undefined;
      return functionName ? this.safeDecodeURIComponent(functionName) : null;
    } catch {
      const match = raw.match(/\/rpc\/([^/?#]+)/);
      return match?.[1] ? this.safeDecodeURIComponent(match[1]) : null;
    }
  }

  private safeDecodeURIComponent(value: string): string | null {
    try {
      return decodeURIComponent(value);
    } catch {
      return null;
    }
  }

  /**
   * 【精准自愈策略】处理 401 响应的重试逻辑：
   * 1. 401 + JWT 问题特征 + 未超过重试上限 → 刷新重试
   * 2. 5xx 网关错误 → 不刷新（与认证无关）
   * 3. 其他 4xx / 3xx / 2xx → 直接返回（非自愈场景）
   */
  private async handle401Retry(
    url: RequestInfo | URL,
    options: RequestInit,
    response: Response
  ): Promise<Response> {
    const retryKey = this.buildFetch401RetryKey(url, options);
    const currentRetryCount = this.fetch401RetryCount.get(retryKey) ?? 0;

    if (response.status === 401 &&
        this.shouldAttemptJwtRefreshForFetch(url) &&
        this.looksLikeJwtAuthFailure(response) &&
        currentRetryCount < this.MAX_FETCH_401_RETRIES) {
      try {
        const client = this.supabase;
        if (client) {
          const { data, error } = await client.auth.refreshSession();
          if (!error && data.session) {
            this.logger.debug('fetch 层捕获 401，已主动刷新 session，重试一次', {
              url: this.redactSupabaseUrl(url),
            });
            this.fetch401RetryCount.set(retryKey, currentRetryCount + 1);
            const retryOptions = this.replaceAuthorizationHeader(options, data.session.access_token);
            try {
              const retryMethod = this.getRequestMethod(url, retryOptions);
              const retryResponse = this.isGatewayRetrySafeRequest(url, retryOptions, retryMethod)
                ? await this.fetchWithGatewayRetry(url, retryOptions)
                : await this.fetchWithTimeout(url, retryOptions);
              this.fetch401RetryCount.delete(retryKey);
              return retryResponse;
            } catch (retryError) {
              // 重试请求本身抛出（如网络断开），清除计数器让下次请求重新尝试
              this.fetch401RetryCount.delete(retryKey);
              throw retryError;
            }
          }
        }
      } catch (refreshError) {
        this.logger.debug('fetch 层 401 自愈刷新异常，沿用原 401 响应', { error: refreshError });
      }
    }

    return response;
  }

  /**
   * 通过 response headers 判断 401 是否由 JWT 问题引起（而非 RLS 权限）。
   * 优势：不消费 body（下游 Supabase JS 仍能正常解析），且精准识别——避免对真正的
   * 权限错误做无意义的 refresh 浪费网络 / 触发 Supabase 速率限制。
   *
   * PostgREST/GoTrue 的约定：
   *   - JWT 相关 401 返回 WWW-Authenticate: Bearer error="invalid_token"
   *   - 某些 Edge Function / Storage 实现直接返回 401 无 header → 为保守起见放行
   */
  private looksLikeJwtAuthFailure(response: Response): boolean {
    const wwwAuth = response.headers.get('www-authenticate') ?? '';
    if (wwwAuth.toLowerCase().includes('invalid_token') || wwwAuth.toLowerCase().includes('expired_token')) {
      return true;
    }
    // 没有 WWW-Authenticate 头时保守视为可能的 JWT 问题；若刷新后仍 401 也只多一次请求，成本可控
    if (!wwwAuth) {
      return true;
    }
    // 有 WWW-Authenticate 但不含 JWT 相关字眼（如 "Bearer realm=..." 无 error）→ 疑似权限问题，跳过刷新
    return false;
  }

  /**
   * 判断一个请求是否应该参与 401 自愈拦截。
   * 排除 /auth/v1/ 自身的请求（refresh token、signIn 等）以防递归。
   */
  private shouldAttemptJwtRefreshForFetch(url: RequestInfo | URL): boolean {
    const urlStr = typeof url === 'string'
      ? url
      : url instanceof URL
        ? url.href
        : (url as Request).url;
    if (!urlStr) return false;
    // 排除 auth 端点避免递归
    if (urlStr.includes('/auth/v1/')) return false;
    return true;
  }

  private replaceAuthorizationHeader(options: RequestInit, accessToken: string): RequestInit {
    const headers = new Headers(options.headers ?? {});
    headers.set('Authorization', `Bearer ${accessToken}`);
    return { ...options, headers };
  }

  private redactSupabaseUrl(url: RequestInfo | URL): string {
    const raw = typeof url === 'string'
      ? url
      : url instanceof URL
        ? url.href
        : (url as Request).url;
    if (!raw) return '';
    // 去除 query 里可能的敏感信息
    const qIndex = raw.indexOf('?');
    return qIndex >= 0 ? raw.slice(0, qIndex) : raw;
  }

  private buildFetch401RetryKey(url: RequestInfo | URL, options: RequestInit): string {
    const urlStr = typeof url === 'string'
      ? url
      : url instanceof URL
        ? url.href
        : (url as Request).url;
    const method = this.getRequestMethod(url, options);
    // 基于 URL + HTTP method 作为重试计数的 key，粒度更细致
    return `${method}:${urlStr}`;
  }

  /**
   * 【鲁棒性 8】生成请求签名用于去重
   */
  private buildRequestSignature(url: RequestInfo | URL, options: RequestInit): string {
    const urlStr = typeof url === 'string'
      ? url
      : url instanceof URL
        ? url.href
        : (url as Request).url;
    const method = options.method?.toUpperCase() ?? 'GET';
    const body = typeof options.body === 'string' ? options.body : '';
    
    // 简单签名：method + url + body 前 100 字符哈希
    const bodyHash = body.substring(0, 100);
    return `${method}:${urlStr}:${bodyHash}`;
  }

  /**
   * 【鲁棒性 8】清理过期的去重缓存
   */
  private cleanupDeduplicationCache(): void {
    const now = Date.now();
    for (const [key, entry] of this.requestDeduplicationCache) {
      if (now - entry.createdAt > this.REQUEST_DEDUP_TTL_MS) {
        this.requestDeduplicationCache.delete(key);
      }
    }
  }

  /**
   * 【根因修复 2026-04-20】读取请求的网关 5xx 瞬时错误静默重试。
   *
   * 问题链条：
   *  1. Supabase edge 偶发返回 502/503/504（上游 PostgREST 扩缩容 / 连接池抖动）。
   *  2. 这些 5xx 响应经常缺失 `Access-Control-Allow-Origin`，被浏览器升级为
   *     刺眼的 CORS 错误刷屏。
   *  3. 单次失败直接上抛会破坏本地同步流水（batch-sync / canonical-match 等）。
   *    目前 401 与 5xx 互斥（401 不会被 5xx 判定捕获），层级清晰。
   */
  private async fetchWithGatewayRetry(url: RequestInfo | URL, options: RequestInit): Promise<Response> {
    let attempt = 0;
    while (true) {
      try {
        const response = await this.fetchWithTimeout(url, options);
        const isGatewayError = response.status === 502 || response.status === 503 || response.status === 504;
        if (!isGatewayError || attempt >= this.MAX_FETCH_GATEWAY_RETRIES) {
          return response;
        }

        // 离线 / 网络挂起时放弃重试，保持原响应
        if (isBrowserNetworkSuspendedWindow()) {
          return response;
        }
        if (typeof navigator !== 'undefined' && !navigator.onLine) {
          return response;
        }

        // 释放本次响应流（虽然未读 body，某些浏览器仍可能占用底层连接槽位）
        try {
          await response.body?.cancel();
        } catch {
           // 忽略 cancel 异常，继续重试 // eslint-disable-line no-restricted-syntax
        }

        attempt++;
        const backoff = this.FETCH_GATEWAY_RETRY_BASE_MS * Math.pow(2, attempt - 1);
        const jitter = Math.floor(Math.random() * this.FETCH_GATEWAY_RETRY_JITTER_MS);
        this.logger.debug('Supabase 网关 5xx 瞬时错误，延迟后重试', {
          url: this.redactSupabaseUrl(url),
          status: response.status,
          attempt,
          delayMs: backoff + jitter,
        });
        await new Promise(resolve => setTimeout(resolve, backoff + jitter));
      } catch (error: unknown) {
        if (!this.shouldRetryGatewayFetchRejection(error) || attempt >= this.MAX_FETCH_GATEWAY_RETRIES) {
          throw error;
        }

        attempt++;
        const backoff = this.FETCH_GATEWAY_RETRY_BASE_MS * Math.pow(2, attempt - 1);
        const jitter = Math.floor(Math.random() * this.FETCH_GATEWAY_RETRY_JITTER_MS);
        this.logger.debug('Supabase 请求被浏览器按网络错误拒绝，按网关瞬时故障路径重试', {
          url: this.redactSupabaseUrl(url),
          attempt,
          delayMs: backoff + jitter,
          message: error instanceof Error ? error.message : String(error),
        });
        await new Promise(resolve => setTimeout(resolve, backoff + jitter));
      }
    }
  }

  private shouldRetryGatewayFetchRejection(error: unknown): boolean {
    if (isBrowserNetworkSuspendedError(error) || isBrowserNetworkSuspendedWindow()) {
      return false;
    }

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return false;
    }

    if (error instanceof DOMException) {
      return error.name === 'NetworkError';
    }

    if (error instanceof TypeError) {
      const message = error.message.toLowerCase();
      return message.includes('failed to fetch')
        || message.includes('networkerror')
        || message.includes('load failed');
    }

    return false;
  }

  /**
   * 从原 fetch 包装中抽出：承担「超时 + 离线探测 + 错误分级」等副作用。
   */
  private async fetchWithTimeout(url: RequestInfo | URL, options: RequestInit): Promise<Response> {
    const callerSignal = options.signal;
    const controller = new AbortController();
    // 【超时治理 2026-04-16】原先写死 120_000 魔数；改用 SUPABASE_CLIENT_FETCH_MAX_MS
    // 语义保持不变：整个客户端 fetch 的「最后防线」超时
    const timeoutId = setTimeout(() => controller.abort(), SUPABASE_CLIENT_FETCH_MAX_MS);

    let mergedSignal: AbortSignal;
    if (callerSignal && typeof AbortSignal !== 'undefined' && 'any' in AbortSignal) {
      mergedSignal = (AbortSignal as unknown as { any: (signals: AbortSignal[]) => AbortSignal }).any([
        callerSignal,
        controller.signal
      ]);
    } else {
      mergedSignal = callerSignal ?? controller.signal;
    }

    try {
      const response = await fetch(url, {
        ...options,
        signal: mergedSignal,
      });
      // 收到 HTTP 响应表示网络可达，但 502-504 网关错误不清除离线模式
      const isGatewayError = response.status >= 502 && response.status <= 504;
      if (this.isOfflineMode() && !isGatewayError) {
        this.setOfflineModeState(false, 'request');
      }
      return response;
    } catch (error: unknown) {
      // 【鲁棒性增强】在标记离线前，再次检查当前网络状态，避免瞬时波动误报
      if (this.shouldMarkOfflineFromFetchFailure(error)) {
        // 延迟 100ms 再次确认，过滤一次性网络波动
        await new Promise(r => setTimeout(r, NETWORK_OFFLINE_DEBOUNCE_MS));
        if (!isBrowserNetworkSuspendedWindow()) {
          this.setOfflineModeState(true, 'request');
        }
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private buildClientOptions() {
    return {
      auth: {
        // 使用 localStorage 存储 session（更稳定，减少锁竞争）
        storage: typeof window !== 'undefined' ? window.localStorage : undefined,
        // Navigator Lock: 在支持的浏览器中使用原生锁，防止多标签页 token 刷新竞争
        // 不支持的浏览器优雅降级为直接执行
        storageKey: `sb-${new URL(this.supabaseUrl).hostname.split('.')[0]}-auth-token`,
        lock: typeof navigator !== 'undefined' && navigator.locks
          ? async <T>(name: string, acquireTimeout: number, fn: () => Promise<T>): Promise<T> => {
              const abortController = new AbortController();
              const timeoutId = acquireTimeout > 0
                ? setTimeout(() => abortController.abort(), acquireTimeout)
                : undefined;
              try {
                return await navigator.locks.request(
                  name,
                  { mode: 'exclusive', signal: abortController.signal },
                  async () => fn()
                );
              } catch (err: unknown) {
                if (err instanceof DOMException && err.name === 'AbortError') {
                  throw new Error(`Lock acquisition timed out after ${acquireTimeout}ms`);
                }
                throw err;
              } finally {
                if (timeoutId !== undefined) clearTimeout(timeoutId);
              }
            }
          : async <T>(_name: string, _acquireTimeout: number, fn: () => Promise<T>): Promise<T> => {
              // Fallback: 不支持 Navigator Lock 的环境直接执行
              return await fn();
            },
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: true,
        flowType: 'pkce' as const
      },
      global: {
        // 保留请求超时保护，并优先复用调用方 signal
        // 离线时快速失败，避免 120s 超时爆出 AbortError
        fetch: (url: RequestInfo | URL, options: RequestInit = {}) => this.supabaseFetch(url, options),
      },
      db: {
        schema: 'public' as const,
      },
      realtime: {
        params: {
          eventsPerSecond: 10,
        },
        heartbeatIntervalMs: 30000,
        timeout: 10000,
        worker: true,
        workerUrl: '/worker-basic.min.js',
        heartbeatCallback: (payload: RealtimeHeartbeatPayload) => this.handleRealtimeHeartbeat(payload),
      },
    };
  }

  private handleRealtimeHeartbeat(payload: RealtimeHeartbeatPayload): void {
    const status = typeof payload === 'string'
      ? payload
      : payload.status ?? payload.event ?? payload.reason ?? 'unknown';
    if (/timeout|disconnect|closed|error/i.test(status)) {
      this.logger.warn('Supabase Realtime heartbeat unhealthy', { status });
      this.sentryLazyLoader.addBreadcrumb({
        category: 'realtime',
        level: 'warning',
        message: 'supabase_realtime_heartbeat_unhealthy',
        data: { status },
      });
      return;
    }
    this.logger.debug('Supabase Realtime heartbeat', { status });
  }
}
