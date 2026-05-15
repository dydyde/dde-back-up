import { Injectable, inject, signal, DestroyRef } from '@angular/core';
import { SupabaseClientService } from './supabase-client.service';
import { EventBusService } from './event-bus.service';
import { 
  Result, OperationError, ErrorCodes, success, failure, humanizeErrorMessage 
} from '../utils/result';
import { supabaseErrorToError } from '../utils/supabase-error';
import { environment } from '../environments/environment';
import { ToastService } from './toast.service';
import { LoggerService } from './logger.service';
import { isLocalModeEnabled, saveAuthCache } from './guards/auth.guard';
import { pushStartupTrace } from '../utils/startup-trace';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { AUTH_CONFIG } from '../config/auth.config';
import { POLLING_CHECK_DELAY } from '../config/timeout.config';
import {
  isBrowserNetworkSuspendedError,
  isBrowserNetworkSuspendedWindow,
} from '../utils/browser-network-suspension';

export interface AuthState {
  isCheckingSession: boolean;
  isLoading: boolean;
  userId: string | null;
  email: string | null;
  error: string | null;
}

/**
 * 认证结果类型
 */
export interface AuthResult {
  userId?: string;
  email?: string;
  needsConfirmation?: boolean;
}

export interface PersistedSessionIdentity {
  userId: string;
  email: string | null;
}

/**
 * 认证服务
 * 负责用户登录、注册、登出
 * 
 * 开发环境自动登录：
 * - 设置 environment.devAutoLogin 后，应用启动时会自动登录
 * - Guard 仍然存在且生效，只是登录过程被自动化
 * - 这避免了"关掉 Guard"的懒惰做法，保持代码路径与生产环境一致
 * 
 * 所有公共方法返回 Result<T> 类型以保持一致性
 */
@Injectable({
  providedIn: 'root'
})
export class AuthService {
  private supabase = inject(SupabaseClientService);
  private toast = inject(ToastService);
  private logger = inject(LoggerService).category('AuthService');
  private destroyRef = inject(DestroyRef);
  private eventBus = inject(EventBusService);
  private sentryLazyLoader = inject(SentryLazyLoaderService);
  
  /** 是否已尝试过开发环境自动登录 */
  private devAutoLoginAttempted = false;
  
  /** 是否为用户主动登出（区分 Token 过期） */
  private isManualSignOut = false;
  
  /** 会话是否已过期 */
  readonly sessionExpired = signal(false);
  
  /**
   * 会话初始化是否完成（首次 checkSession 已执行完毕）
   * 用于区分"尚未检查"与"检查完毕无会话"两种状态，
   * 解决 Guard 与 bootstrap 间的竞态条件导致登录弹窗误弹出
   */
  readonly sessionInitialized = signal(false);
  readonly runtimeState = signal<'idle' | 'pending' | 'ready' | 'failed'>('idle');
  
  /** 认证状态变更订阅的取消函数 */
  private authStateSubscription: { unsubscribe: () => void } | null = null;
  private authRuntimeReady = false;
  private runtimeAuthReadyPromise: Promise<void> | null = null;
  private readonly storageKey = this.supabase.getStorageKey();
  private readonly storageListener = (event: StorageEvent) => this.handleStorageEvent(event);
  private setProvisionalAuthState(state: 'pending' | 'ready' | 'failed'): void {
    this.runtimeState.set(state);
  }
  
  /** Supabase 是否已配置 */
  get isConfigured(): boolean {
    return this.supabase.isConfigured;
  }
  
  /** 
   * 认证状态
   * 【性能优化 2026-01-31】isCheckingSession 初始值改为 false
   * 只有在实际调用 checkSession() 时才设为 true
   * 这样 Guard 不会在应用启动时就开始等待
   */
  readonly authState = signal<AuthState>({
    isCheckingSession: false,
    isLoading: false,
    userId: null,
    email: null,
    error: null
  });

  /** 当前用户 ID */
  readonly currentUserId = signal<string | null>(null);
  /**
   * 【P1 秒开优化 2026-03-31】临时 userId 预设，用于快照预填充阶段。
   * 仅在 currentUserId 为 null 时生效。checkSession 完成后若为同一用户则为 no-op，
   * 若为不同用户则 checkSession 会覆盖。
   */
  setProvisionalCurrentUserId(userId: string): void {
    if (!this.currentUserId()) {
      this.currentUserId.set(userId);
    }
  }
  private readonly persistedOwnerHintState = signal<string | null>(null);
  readonly persistedOwnerHint = this.persistedOwnerHintState.asReadonly();
  private readonly persistedSessionUserIdState = signal<string | null>(null);
  readonly persistedSessionUserId = this.persistedSessionUserIdState.asReadonly();
  
  /** 当前用户邮箱 */
  readonly sessionEmail = signal<string | null>(null);
  private pendingStorageBridgeSessionIdentity: PersistedSessionIdentity | null = null;
  private pendingSessionRestoredNotification = false;
  
  constructor() {
    if (!this.supabase.isConfigured) {
      this.runtimeState.set('ready');
    }
    this.syncPersistedOwnerHintFromStorage();
    this.syncPersistedSessionUserIdFromStorage();
    this.initStorageBridge();
    
    // 组件销毁时清理订阅
    this.destroyRef.onDestroy(() => {
      this.authStateSubscription?.unsubscribe();
      if (typeof window !== 'undefined') {
        window.removeEventListener('storage', this.storageListener);
      }
    });
  }

  async ensureRuntimeAuthReady(): Promise<void> {
    if (!this.supabase.isConfigured || this.authRuntimeReady) {
      this.setProvisionalAuthState('ready');
      return;
    }

    if (this.runtimeAuthReadyPromise) {
      return this.runtimeAuthReadyPromise;
    }

    // 【Bug 修复 2026-03-27】仅当 runtimeState 还是 'idle' 时才降级为 'pending'。
    // FastPath 已提前将 runtimeState 设为 'ready'，此处不能将其回退为 'pending'，
    // 否则 handoff 条件中 runtimeState === 'pending' 会让结果卡在 'pending'。
    if (this.runtimeState() === 'idle') {
      this.setProvisionalAuthState('pending');
    }
    this.runtimeAuthReadyPromise = this.initAuthStateListener()
      .then(() => {
        this.authRuntimeReady = true;
        this.setProvisionalAuthState('ready');
      })
      .catch((error) => {
        this.setProvisionalAuthState('failed');
        throw error;
      })
      .finally(() => {
        this.runtimeAuthReadyPromise = null;
      });

    return this.runtimeAuthReadyPromise;
  }

  /**
   * 检查并恢复会话
   * 添加超时保护，防止网络异常时无限阻塞
   * 【P2-07 修复】添加并发调用防护，避免多个 checkSession 竞争
   * 
   * 【P3-10 说明】返回 userId=null 时，通过 authState 区分两种情况：
   * - 无会话（正常）：authState().error === null
   * - 检查失败（异常）：authState().error 包含错误信息
   * 
   * 开发环境：如果没有现有会话且配置了 devAutoLogin，会自动登录
   */
  private checkSessionPromise: Promise<{ userId: string | null; email: string | null }> | null = null;
  
  async checkSession(): Promise<{ userId: string | null; email: string | null }> {
    pushStartupTrace('auth.check_session', {
      runtimeState: this.runtimeState(),
      sessionInitialized: this.sessionInitialized(),
      currentUserId: this.currentUserId(),
    });
    // 如果已有进行中的 checkSession，直接复用
    if (this.checkSessionPromise) {
      return this.checkSessionPromise;
    }
    
    this.checkSessionPromise = this.doCheckSession();
    try {
      return await this.checkSessionPromise;
    } finally {
      this.checkSessionPromise = null;
    }
  }
  
  /**
   * 【性能优化 2026-03-24】本地会话快速路径
   * 
   * 优化策略：
   * 1. 优先读取 index.html 预热脚本的刷新结果（window.__NANOFLOW_SESSION_PREWARM__）
   * 2. 其次读取 localStorage 中 Supabase 缓存的会话 token
   * 3. 只要 token 未过期（>60s 缓冲），直接使用本地数据，跳过网络调用
   * 4. 后台异步触发 SDK getSession() 确保 token 最终刷新
   * 
   * 预期收益：冷启动节省 1-3s（跳过 getSession 网络往返）
   */
  peekPersistedSessionIdentity(): PersistedSessionIdentity | null {
    return this.readPersistedSessionIdentity(false);
  }

  /**
   * 仅用于本地 owner 匹配的 userId 提示，不代表当前会话已经通过认证校验。
   * 当 access token 临近过期、但 refresh token 仍可恢复时，冷启动预填充依赖此提示命中正确的 owner-scoped 快照。
   */
  peekPersistedOwnerHint(): string | null {
    const persistedIdentity = this.readPersistedSessionIdentity(false);
    if (persistedIdentity?.userId) {
      return persistedIdentity.userId;
    }

    return this.readPersistedOwnerHintFromStorage();
  }

  private setPersistedOwnerHint(userId: string | null): void {
    this.persistedOwnerHintState.set(userId);
  }

  private syncPersistedOwnerHintFromStorage(): void {
    this.persistedOwnerHintState.set(this.peekPersistedOwnerHint());
  }

  private setPersistedSessionUserId(userId: string | null): void {
    this.persistedSessionUserIdState.set(userId);
  }

  private syncPersistedSessionUserIdFromStorage(): void {
    this.persistedSessionUserIdState.set(this.peekPersistedSessionIdentity()?.userId ?? null);
  }

  private tryLocalSessionFastPath(): PersistedSessionIdentity | null {
    return this.readPersistedSessionIdentity(true);
  }

  private getDeferredSessionFallback(): { userId: string | null; email: string | null } {
    return {
      userId: this.currentUserId(),
      email: this.sessionEmail(),
    };
  }

  private deferSessionCheckForBrowserResume(
    source: 'preflight' | 'catch',
  ): { userId: string | null; email: string | null } {
    const fallback = this.getDeferredSessionFallback();

    this.logger.info('[CheckSession] 浏览器网络挂起窗口内延后会话检查', {
      source,
      hasCachedUser: !!fallback.userId,
    });

    this.authState.update(s => ({
      ...s,
      userId: fallback.userId,
      email: fallback.email,
      error: null,
    }));

    this.scheduleBackgroundSessionRefresh();

    const ensureRuntimeReady = () => {
      void this.ensureRuntimeAuthReady().catch(() => {
        // 恢复窗口内 runtime listener 初始化失败不阻断当前会话兜底。
      });
    };

    if (typeof queueMicrotask === 'function') {
      queueMicrotask(ensureRuntimeReady);
    } else {
      void Promise.resolve().then(ensureRuntimeReady);
    }

    return fallback;
  }

  private readPersistedOwnerHintFromStorage(): string | null {
    try {
      const storageKey = this.supabase.getStorageKey();
      if (!storageKey) return null;

      const raw = localStorage.getItem(storageKey);
      if (!raw) return null;

      const authData: unknown = JSON.parse(raw);
      const sessionRecord = this.resolvePersistedSessionRecord(authData);
      if (!sessionRecord) return null;

      const refreshToken = sessionRecord['refresh_token'];
      const accessToken = sessionRecord['access_token'];
      if ((typeof refreshToken !== 'string' || !refreshToken)
        && (typeof accessToken !== 'string' || !accessToken)) {
        return null;
      }

      const user = sessionRecord['user'];
      if (!user || typeof user !== 'object') {
        return null;
      }

      const userId = (user as Record<string, unknown>)['id'];
      return typeof userId === 'string' && userId.length > 0 ? userId : null;
    } catch {
        return null; // eslint-disable-line no-restricted-syntax -- localStorage 读取/JSON 解析失败时"无会话"语义正确，null 触发调用方降级
    }
  }

  private resolvePersistedSessionRecord(authData: unknown): Record<string, unknown> | null {
    if (!authData || typeof authData !== 'object') {
      return null;
    }

    const rootRecord = authData as Record<string, unknown>;
    const currentSession = rootRecord['currentSession'];
    if (currentSession && typeof currentSession === 'object') {
      return currentSession as Record<string, unknown>;
    }

    const session = rootRecord['session'];
    if (session && typeof session === 'object') {
      return session as Record<string, unknown>;
    }

    return rootRecord;
  }

  private resolvePersistedSessionIdentityFromAuthData(authData: unknown): PersistedSessionIdentity | null {
    const sessionRecord = this.resolvePersistedSessionRecord(authData);
    if (!sessionRecord) {
      return null;
    }

    const refreshToken = sessionRecord['refresh_token'];
    const accessToken = sessionRecord['access_token'];
    if ((typeof refreshToken !== 'string' || !refreshToken)
      && (typeof accessToken !== 'string' || !accessToken)) {
      return null;
    }

    const user = sessionRecord['user'];
    if (!user || typeof user !== 'object') {
      return null;
    }

    const userRecord = user as Record<string, unknown>;
    const userId = userRecord['id'];
    if (typeof userId !== 'string' || !userId) {
      return null;
    }

    return {
      userId,
      email: typeof userRecord['email'] === 'string' ? userRecord['email'] : null,
    };
  }

  private readPersistedSessionIdentity(shouldLog: boolean): PersistedSessionIdentity | null {
    try {
      // 阶段 1：检查 index.html 预热脚本是否已拿到新鲜 session
      const prewarm = (window as Window & { __NANOFLOW_SESSION_PREWARM__?: {
        status: string;
        session?: { access_token: string; expires_at: number; user?: { id: string; email?: string | null } | null };
      } }).__NANOFLOW_SESSION_PREWARM__;

      if (prewarm?.status === 'refreshed' && prewarm.session) {
        const { session } = prewarm;
        // 预热拿到的 session 包含 user 字段（从 /auth/v1/token 返回）
        if (session.user?.id) {
          if (shouldLog) {
            this.logger.debug('[FastPath] 使用 index.html 预热 session', {
              userId: session.user.id.substring(0, 8) + '...',
              expiresAt: session.expires_at
            });
          }
          return { userId: session.user.id, email: session.user.email ?? null };
        }
        // 预热成功但没有 user 字段 → 回退到 localStorage 解析
      }

      // 阶段 2：从 localStorage 读取 Supabase 缓存的 auth token
      const storageKey = this.supabase.getStorageKey();
      if (!storageKey) return null;

      const raw = localStorage.getItem(storageKey);
      if (!raw) return null;

      const authData: unknown = JSON.parse(raw);
  const record = this.resolvePersistedSessionRecord(authData);
  if (!record) return null;

      // Supabase JS SDK v2 存储格式：{ access_token, refresh_token, expires_at, user }
      const accessToken = record['access_token'];
      if (typeof accessToken !== 'string' || !accessToken) return null;

      // 过期时间检查（秒级时间戳），保留 60s 缓冲避免边界竞争
      const rawExpiresAt = record['expires_at'];
      if (typeof rawExpiresAt === 'number') {
        // 兼容毫秒和秒级时间戳
        const expiresAt = rawExpiresAt > 1e12 ? Math.floor(rawExpiresAt / 1000) : rawExpiresAt;
        const nowSec = Math.floor(Date.now() / 1000);
        if (expiresAt <= nowSec + 60) {
          if (shouldLog) {
            this.logger.debug('[FastPath] 本地 token 即将过期，回退到网络检查');
          }
          return null;
        }
      }

      // 提取 user 信息
      const user = record['user'];
      if (user && typeof user === 'object') {
        const userRecord = user as Record<string, unknown>;
        const userId = userRecord['id'];
        if (typeof userId === 'string' && userId) {
          const email = typeof userRecord['email'] === 'string' ? userRecord['email'] : null;
          if (shouldLog) {
            this.logger.debug('[FastPath] 使用 localStorage 缓存 session', {
              userId: userId.substring(0, 8) + '...',
              expiresAt: rawExpiresAt
            });
          }
          return { userId, email };
        }
      }

      return null;
    } catch (e) {
      if (shouldLog) {
        this.logger.debug('[FastPath] 本地会话读取失败，回退到网络检查', e);
      }
        return null; // eslint-disable-line no-restricted-syntax -- 本地会话读取失败降级为网络检查，null 是正确语义
    }
  }

  private async doCheckSession(): Promise<{ userId: string | null; email: string | null }> {
    this.logger.debug('========== checkSession 开始 ==========');
    
    if (!this.supabase.isConfigured) {
      this.logger.debug('Supabase 未配置，跳过会话检查');
      this.authState.update(s => ({ ...s, isCheckingSession: false }));
      this.sessionInitialized.set(true);
      return { userId: null, email: null };
    }
    
    this.authState.update(s => ({ ...s, isCheckingSession: true }));
    
    // 【性能优化 2026-03-24】先尝试本地快速路径，避免网络往返
    const localSession = this.tryLocalSessionFastPath();
    if (localSession) {
      this.logger.debug('[FastPath] 本地会话命中，跳过网络 getSession()');
      this.currentUserId.set(localSession.userId);
      this.setPersistedOwnerHint(localSession.userId);
      this.setPersistedSessionUserId(localSession.userId);
      this.sessionEmail.set(localSession.email);
      this.authState.update(s => ({
        ...s,
        userId: localSession.userId,
        email: localSession.email,
        error: null,
        isCheckingSession: false,
      }));

      // 设置 Sentry 用户上下文（FastPath 也需要）
      this.sentryLazyLoader.setUser({ id: localSession.userId, email: localSession.email ?? undefined });
      // 【Bug 修复 2026-03-26】FastPath 必须完成与 finally 块相同的状态收尾，
      // 否则 sessionInitialized 永远为 false → handoff 永远 pending → 界面空白。
      this.sessionInitialized.set(true);
      this.setProvisionalAuthState('ready');
      pushStartupTrace('auth.fast_path_hit', {
        userId: localSession.userId,
        runtimeState: this.runtimeState(),
      });

      // 后台异步刷新 SDK session 状态，确保 token 最终同步
      this.scheduleBackgroundSessionRefresh();

      // 【Bug 修复 2026-03-27】FastPath 跳过了 ensureRuntimeAuthReady()，
      // 导致 onAuthStateChange 监听器从未注册 → TOKEN_REFRESHED / SIGNED_OUT
      // 事件无法被处理 → token 可能过期而不刷新、跨标签登出不同步。
      // 在后台延迟初始化，不阻塞 FastPath 的即时返回。
      queueMicrotask(() => {
        void this.ensureRuntimeAuthReady().catch(() => {
          // initAuthStateListener 失败不影响当前已登录状态
        });
      });

      return localSession;
    }

    if (isBrowserNetworkSuspendedWindow()) {
      return this.deferSessionCheckForBrowserResume('preflight');
    }
    
    // 网络回退路径：超时保护 5 秒（原 10 秒，移动端体验优化）
    const SESSION_TIMEOUT = 5000;
    
    try {
      await this.ensureRuntimeAuthReady();
      this.logger.debug('正在调用 supabase.getSession()...');
      const callStartTime = Date.now();
      
      let sessionResult: { data: { session: { user?: { id: string; email?: string | null } } | null } | null; error: { message: string; status?: number; name?: string } | null };
      
      try {
        const sessionPromise = this.supabase.getSession();
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('会话检查超时')), SESSION_TIMEOUT);
        });
        
        sessionResult = await Promise.race([sessionPromise, timeoutPromise]);
        const callElapsed = Date.now() - callStartTime;
        this.logger.debug(`getSession() 返回 (耗时 ${callElapsed}ms)`);
      } catch (e) {
        throw e;
      }
      
      const { data, error } = sessionResult;
      
      if (error) {
        this.logger.error('getSession() 返回错误', {
          message: error.message,
          status: error.status,
          name: error.name
        });
        throw supabaseErrorToError(error);
      }
      
      const session = data?.session;
      this.logger.debug('会话状态', { exists: !!session });
      
      if (session?.user) {
        const userId = session.user.id;
        const email = session.user.email ?? null;
        this.logger.debug('用户已登录', { 
          userId: userId.substring(0, 8) + '...', 
          email 
        });
        
        this.currentUserId.set(userId);
        this.setPersistedOwnerHint(userId);
        this.setPersistedSessionUserId(userId);
        this.sessionEmail.set(email);
        this.authState.update(s => ({
          ...s,
          userId,
          email,
          error: null
        }));

        // 设置 Sentry 用户上下文（网络路径）
        this.sentryLazyLoader.setUser({ id: userId, email: email ?? undefined });
        
        this.logger.debug('========== checkSession 成功 ==========');
        return { userId, email };
      }
      
      // 没有现有会话，尝试开发环境自动登录
      this.logger.debug('无现有会话，尝试开发环境自动登录...');
      const autoLoginResult = await this.tryDevAutoLogin();
      if (autoLoginResult) {
        this.logger.debug('========== 自动登录成功 ==========');
        return autoLoginResult;
      }
      
      this.logger.debug('========== 无会话，未登录 ==========');
      this.setPersistedOwnerHint(null);
      this.setPersistedSessionUserId(null);
      return { userId: null, email: null };
    } catch (e: unknown) {
      if (isBrowserNetworkSuspendedError(e) || isBrowserNetworkSuspendedWindow()) {
        return this.deferSessionCheckForBrowserResume('catch');
      }

      const err = e as Error | undefined;
      this.logger.error('========== checkSession 异常 ==========', {
        message: err?.message,
        stack: err?.stack?.split('\n')?.slice(0, 3)?.join('\n'),
        isTimeout: err?.message?.includes('超时')
      });
      
      // 超时不是致命错误，只是记录并继续
      const isTimeout = err?.message?.includes('超时');
      if (!isTimeout) {
        this.authState.update(s => ({
          ...s,
          error: err?.message ?? String(e)
        }));
      }
      
      // 注意：这里不抛出异常，而是返回 null
      this.logger.debug('返回空会话，不阻断应用启动');
      return { userId: null, email: null };
    } finally {
      this.logger.debug('设置 isCheckingSession = false, sessionInitialized = true');
      this.authState.update(s => ({ ...s, isCheckingSession: false }));
      this.sessionInitialized.set(true);
    }
  }

  /**
   * 后台异步刷新 SDK session，确保 Supabase 客户端状态与本地缓存同步。
   * 不阻塞 UI，不影响用户操作。
   *
   * 【Bug 修复 2026-03-26】当后台刷新发现会话实际无效时（getSession 返回错误
   * 或无 user），清除 currentUserId 等状态，触发 showLoginRequired 兜底。
   * 否则用户看到"已登录"但所有 API 调用失败 → 永远无数据。
   */
  private scheduleBackgroundSessionRefresh(): void {
    const scheduleTask = (task: () => void) => {
      if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
        (window as Window & { requestIdleCallback: (cb: () => void, opts?: { timeout: number }) => number })
          .requestIdleCallback(() => task(), { timeout: 3000 });
      } else {
        setTimeout(task, POLLING_CHECK_DELAY.CONDITION_READY);
      }
    };

    scheduleTask(() => {
      void this.supabase.getSession()
        .then(result => {
          if (result.error) {
            // 区分"SDK 不可用"和"会话真的无效"：
            // SDK 不可用（动态 import 失败、客户端初始化失败）时不清除状态，
            // 与网络失败同等对待 — 本地缓存可能仍然有效。
            const errorName = (result.error as { name?: string }).name;
            if (errorName === 'ClientUnavailable') {
              this.logger.debug('[BackgroundRefresh] SDK 客户端不可用，保留本地状态（稍后重试）');
              pushStartupTrace('auth.background_refresh_client_unavailable', {
                runtimeState: this.runtimeState(),
                currentUserId: this.currentUserId(),
              });
              return;
            }
            this.logger.warn('[BackgroundRefresh] SDK getSession 返回错误，清除本地会话', result.error);
            this.handleBackgroundSessionInvalid();
            return;
          }
          const session = result.data?.session;
          if (!session?.user) {
            this.logger.warn('[BackgroundRefresh] SDK 返回空会话，本地缓存已失效');
            pushStartupTrace('auth.background_refresh_invalid_session', {
              runtimeState: this.runtimeState(),
              currentUserId: this.currentUserId(),
            });
            this.handleBackgroundSessionInvalid();
            return;
          }
          // 用 SDK 返回的最新 user 信息更新状态（可能 userId/email 有变化）
          this.currentUserId.set(session.user.id);
          this.setPersistedOwnerHint(session.user.id);
          this.setPersistedSessionUserId(session.user.id);
          this.sessionEmail.set(session.user.email ?? null);
          this.authState.update(s => ({
            ...s,
            userId: session.user!.id,
            email: session.user!.email ?? null,
            error: null,
          }));
          this.logger.debug('[BackgroundRefresh] SDK session 已同步');
          pushStartupTrace('auth.background_refresh_synced', {
            userId: session.user.id,
          });
        })
        .catch((e: unknown) => {
          // 区分认证错误和网络错误：
          // - 认证错误（401/403/token-related）→ 会话已失效，必须清除本地状态
          // - 网络错误（timeout/dns/offline）→ 临时离线，保留本地缓存
          const isAuthError = this.isAuthenticationError(e);
          if (isAuthError) {
            this.logger.warn('[BackgroundRefresh] SDK 抛出认证异常，清除本地会话', e);
            pushStartupTrace('auth.background_refresh_auth_error', {
              currentUserId: this.currentUserId(),
            });
            this.handleBackgroundSessionInvalid();
          } else {
            this.logger.debug('[BackgroundRefresh] SDK session 刷新失败（网络问题，保留本地状态）', e);
            pushStartupTrace('auth.background_refresh_network_preserved', {
              currentUserId: this.currentUserId(),
            });
          }
        });
    });
  }

  /**
   * 后台刷新发现会话确实无效时，清除 FastPath 乐观设置的状态。
   * 这会让 showLoginRequired 生效，触发登录兜底 UI。
   */
  private handleBackgroundSessionInvalid(): void {
    const invalidatedUserId = this.currentUserId();
    pushStartupTrace('auth.background_refresh_clear_local_session', {
      currentUserId: invalidatedUserId,
    });
    this.teardownInvalidatedSession('AuthService.backgroundRefresh');
  }

  /**
   * 区分认证错误和网络错误
   * 认证错误（会话失效）：必须清除本地状态
   * 网络错误（暂时离线）：保留本地缓存
   */
  private isAuthenticationError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const err = error as { status?: number; message?: string; code?: string; name?: string };
    // HTTP 401/403 明确表示认证失效
    if (err.status === 401 || err.status === 403) return true;
    // Supabase SDK 的特定错误码
    if (err.code === 'session_not_found' || err.code === 'refresh_token_not_found') return true;
    // 错误消息中包含认证相关关键词
    const msg = (err.message ?? '').toLowerCase();
    if (msg.includes('refresh token') || msg.includes('invalid token') ||
        msg.includes('invalid refresh token') || msg.includes('token expired') ||
        msg.includes('session expired') || msg.includes('session missing') ||
        msg.includes('invalid claim') || msg.includes('jwt expired')) {
      return true;
    }
    return false;
  }

  /**
   * 尝试开发环境自动登录
   * 
   * 设计理念：
   * - 保留 Guard 的存在，确保代码路径与生产环境一致
   * - 只是自动化登录过程，不是跳过登录
   * - 便于开发调试，同时不污染生产代码
   * 
   * @returns 登录成功返回用户信息，否则返回 null
   */
  private async tryDevAutoLogin(): Promise<{ userId: string | null; email: string | null } | null> {
    // 防止重复尝试
    if (this.devAutoLoginAttempted) {
      return null;
    }
    this.devAutoLoginAttempted = true;
    
    // 检查是否配置了开发环境自动登录
    const envWithDevLogin = environment as {
      devAutoLogin?: { email: string; password: string } | null;
      production?: boolean;
    };
    const devAutoLogin = envWithDevLogin.devAutoLogin;
    if (!devAutoLogin || !devAutoLogin.email || !devAutoLogin.password) {
      return null;
    }
    
    // 仅在非生产环境启用
    if (envWithDevLogin.production) {
      this.logger.warn('⚠️ devAutoLogin 不应在生产环境使用，已忽略');
      return null;
    }
    
    // 开发环境日志：不泄露凭据
    this.logger.debug('🔐 开发环境自动登录中...');
    
    try {
      const result = await this.signIn(devAutoLogin.email, devAutoLogin.password);
      
      if (result.ok && result.value.userId) {
        // 安全：只记录登录成功，不记录具体邮箱
        this.logger.info('✅ 开发环境自动登录成功');
        return { 
          userId: result.value.userId, 
          email: result.value.email ?? null 
        };
      } else {
        // 开发环境凭据问题：使用 info 而非 warn，避免在控制台产生混淆
        // 这是预期的静默降级，不是真正的错误
        this.logger.info('ℹ️ 开发环境自动登录未成功，将以未登录状态运行');
        return null;
      }
    } catch (e) {
      // 网络异常等：静默降级为未登录状态
      this.logger.info('ℹ️ 开发环境自动登录异常，静默降级', e);
      // eslint-disable-next-line no-restricted-syntax -- 返回 null 语义正确：自动登录失败静默降级
      return null;
    }
  }

  /**
   * 登录
   * @returns Result 类型，成功时包含用户信息
   */
  /** 登录超时时间（ms） */
  private readonly SIGN_IN_TIMEOUT = 15000;

  async signIn(email: string, password: string): Promise<Result<AuthResult, OperationError>> {
    if (!this.supabase.isConfigured) {
      return failure(
        ErrorCodes.SYNC_AUTH_EXPIRED,
        'Supabase 未配置。请设置 NG_APP_SUPABASE_URL 和 NG_APP_SUPABASE_ANON_KEY。'
      );
    }
    
    this.authState.update(s => ({ ...s, isLoading: true, error: null }));
    
    try {
      // 【P0 修复 2026-02-08】给 signInWithPassword 加超时保护
      // 防止网络异常时无限挂起，导致 UI 卡在 "登录中..." 无法操作
      const signInPromise = this.supabase.signInWithPassword(email, password);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('登录请求超时，请检查网络连接后重试')), this.SIGN_IN_TIMEOUT)
      );
      const { data, error } = await Promise.race([signInPromise, timeoutPromise]);
      
      if (error || !data.session?.user) {
        const errorMsg = humanizeErrorMessage(error?.message || '登录失败');
        this.authState.update(s => ({ ...s, error: errorMsg }));
        return failure(ErrorCodes.SYNC_AUTH_EXPIRED, errorMsg);
      }
      
      const userId = data.session.user.id;
      const userEmail = data.session.user.email ?? null;
      
      // 【P0 修复 2026-02-08】不在此处设置 currentUserId
      // 原因：signIn() 提前设置会导致后续 setCurrentUser() 判断 isUserChange=false，
      // 从而跳过 loadUserData()，用户看到的是种子数据而非真实云端数据。
      // currentUserId 统一由 handleLogin → setCurrentUser(userId, { forceLoad: true }) 设置。
      this.sessionEmail.set(userEmail);
      this.authState.update(s => ({
        ...s,
        userId,
        email: userEmail,
        error: null
      }));
      
      return success({ userId, email: userEmail ?? undefined });
    } catch (e: unknown) {
      const err = e as Error | undefined;
      const isTimeout = err?.message?.includes('超时');
      const errorMsg = isTimeout
        ? err!.message
        : humanizeErrorMessage(err?.message ?? String(e));
      this.authState.update(s => ({ ...s, error: errorMsg }));
      return failure(ErrorCodes.UNKNOWN, errorMsg);
    } finally {
      this.authState.update(s => ({ ...s, isLoading: false }));
    }
  }

  /**
   * 注册
   * @returns Result 类型，成功时可能包含 needsConfirmation 标志
   */
  async signUp(email: string, password: string): Promise<Result<AuthResult, OperationError>> {
    if (!this.supabase.isConfigured) {
      return failure(
        ErrorCodes.SYNC_AUTH_EXPIRED,
        'Supabase 未配置。请设置 NG_APP_SUPABASE_URL 和 NG_APP_SUPABASE_ANON_KEY。'
      );
    }
    
    this.authState.update(s => ({ ...s, isLoading: true, error: null }));
    
    try {
      await this.ensureRuntimeAuthReady();
      const client = await this.supabase.clientAsync();
      if (!client) {
        const errorMsg = 'Supabase 客户端未就绪，请稍后重试';
        this.authState.update(s => ({ ...s, error: errorMsg }));
        return failure(ErrorCodes.SYNC_AUTH_EXPIRED, errorMsg);
      }

      // 【P0 修复 2026-02-08】给注册加超时保护
      const signUpPromise = client.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: `${this.getAuthRedirectOrigin()}/auth/callback`
        }
      });
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('注册请求超时，请检查网络连接后重试')), this.SIGN_IN_TIMEOUT)
      );
      const { data, error } = await Promise.race([signUpPromise, timeoutPromise]);
      
      if (error) {
        const errorMsg = humanizeErrorMessage(error.message);
        this.authState.update(s => ({ ...s, error: errorMsg }));
        return failure(ErrorCodes.UNKNOWN, errorMsg);
      }
      
      // 检查是否需要邮箱确认
      if (data.user && !data.session) {
        return success({ needsConfirmation: true });
      }
      
      // 如果直接获得 session（禁用了邮箱确认的情况）
      if (data.session?.user) {
        const userId = data.session.user.id;
        const userEmail = data.session.user.email ?? null;
        
        // 【P0 修复 2026-02-08】不在此处设置 currentUserId，由 setCurrentUser 统一管理
        this.sessionEmail.set(userEmail);
        this.authState.update(s => ({
          ...s,
          userId,
          email: userEmail,
          error: null
        }));
        
        return success({ userId, email: userEmail ?? undefined });
      }
      
      return success({});
    } catch (e: unknown) {
      const err = e as Error | undefined;
      const errorMsg = humanizeErrorMessage(err?.message ?? String(e));
      this.authState.update(s => ({ ...s, error: errorMsg }));
      return failure(ErrorCodes.UNKNOWN, errorMsg);
    } finally {
      this.authState.update(s => ({ ...s, isLoading: false }));
    }
  }

  /**
   * 重置密码（发送重置邮件）
   * @returns Result 类型
   */
  async resetPassword(email: string): Promise<Result<void, OperationError>> {
    if (!this.supabase.isConfigured) {
      return failure(ErrorCodes.SYNC_AUTH_EXPIRED, 'Supabase 未配置');
    }
    
    this.authState.update(s => ({ ...s, isLoading: true, error: null }));
    
    try {
      await this.ensureRuntimeAuthReady();
      const client = await this.supabase.clientAsync();
      if (!client) {
        const errorMsg = 'Supabase 客户端未就绪，请稍后重试';
        this.authState.update(s => ({ ...s, error: errorMsg }));
        return failure(ErrorCodes.SYNC_AUTH_EXPIRED, errorMsg);
      }

      // 【P1 修复 2026-02-08】给重置密码加超时保护
      const resetPromise = client.auth.resetPasswordForEmail(email, {
        redirectTo: `${this.getAuthRedirectOrigin()}/reset-password`
      });
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('请求超时，请检查网络连接后重试')), this.SIGN_IN_TIMEOUT)
      );
      const { error } = await Promise.race([resetPromise, timeoutPromise]);
      
      if (error) {
        const errorMsg = humanizeErrorMessage(error.message);
        this.authState.update(s => ({ ...s, error: errorMsg }));
        return failure(ErrorCodes.UNKNOWN, errorMsg);
      }
      
      return success(undefined);
    } catch (e: unknown) {
      const err = e as Error | undefined;
      const errorMsg = humanizeErrorMessage(err?.message ?? String(e));
      this.authState.update(s => ({ ...s, error: errorMsg }));
      return failure(ErrorCodes.UNKNOWN, errorMsg);
    } finally {
      this.authState.update(s => ({ ...s, isLoading: false }));
    }
  }

  private getAuthRedirectOrigin(): string {
    const env = environment as unknown as {
      production?: boolean;
      canonicalOrigin?: string;
      deploymentTarget?: string;
    };
    const canonicalOrigin = typeof env.canonicalOrigin === 'string'
      ? env.canonicalOrigin.trim().replace(/\/+$/, '')
      : '';

    if (
      canonicalOrigin
      && /^https?:\/\//i.test(canonicalOrigin)
      && (env.production === true || env.deploymentTarget === 'production')
    ) {
      return canonicalOrigin;
    }

    return window.location.origin;
  }

  /**
   * 登出
    * 注意：先清理内存态 UI，再尝试 Supabase 远端登出，最后在 finally 中兜底清理本地缓存
    * 这样可以同时保留 refresh token 远端撤销机会，并确保本地状态最终一定被清理
   */
  async signOut(): Promise<void> {
    // 标记为手动登出，避免触发 sessionExpired 提示
    this.isManualSignOut = true;
    
    // 先清理本地状态
    this.currentUserId.set(null);
    this.setPersistedOwnerHint(null);
    this.setPersistedSessionUserId(null);
    this.sessionEmail.set(null);
    this.sessionExpired.set(false);
    this.authState.update(s => ({
      ...s,
      userId: null,
      email: null,
      error: null
    }));

    // 清除 Sentry 用户上下文
    this.sentryLazyLoader.setUser(null);
    
    // 再调用 Supabase 登出
    try {
      if (this.supabase.isConfigured) {
        await this.supabase.signOut();
      }
    } catch (e) {
      if (this.supabase.isConfigured) {
        this.logger.warn('Supabase signOut failed', { error: e });
      }
    } finally {
      this.clearCachedSessionArtifacts();
    }
  }

  /**
   * 清除错误
   */
  clearError() {
    this.authState.update(s => ({ ...s, error: null }));
  }
  
  // ========== 显式状态重置（用于测试和 HMR）==========
  
  /**
   * 显式重置服务状态
   * 用于测试环境的 afterEach 或 HMR 重载
   */
  reset(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('storage', this.storageListener);
    }
    this.pendingStorageBridgeSessionIdentity = null;
    this.currentUserId.set(null);
    this.setPersistedOwnerHint(null);
    this.setPersistedSessionUserId(null);
    this.sessionEmail.set(null);
    this.sessionExpired.set(false);
    this.sessionInitialized.set(false);
    this.isManualSignOut = false;
    this.devAutoLoginAttempted = false;
    this.authRuntimeReady = false;
    this.pendingSessionRestoredNotification = false;
    this.authStateSubscription?.unsubscribe();
    this.authStateSubscription = null;
    this.runtimeAuthReadyPromise = null;
    this.runtimeState.set(this.supabase.isConfigured ? 'idle' : 'ready');
    this.authState.set({
      isCheckingSession: false,
      isLoading: false,
      userId: null,
      email: null,
      error: null
    });
  }
  
  // ==================== 私有方法 ====================
  
  /**
   * 初始化认证状态监听
   * 
   * 监听 Supabase 的 onAuthStateChange 事件：
   * - SIGNED_OUT: 用户登出（检测是否为 Token 过期）
   * - TOKEN_REFRESHED: Token 刷新成功
   * - SIGNED_IN: 用户登录
   * - USER_UPDATED: 用户信息更新
   */
  private async initAuthStateListener(): Promise<void> {
    if (!this.supabase.isConfigured) {
      this.logger.debug('Supabase 未配置，跳过认证状态监听');
      return;
    }

    if (this.authStateSubscription) {
      return;
    }
    
    const client = await this.supabase.clientAsync();
    if (!client) {
      this.logger.warn('Supabase 客户端未就绪，跳过认证状态监听初始化');
      return;
    }
    
    const { data } = client.auth.onAuthStateChange((event, session) => {
      this.logger.debug('认证状态变更', { event, hasSession: !!session });
      
      switch (event) {
        case 'SIGNED_OUT':
          this.handleSignedOut();
          break;
          
        case 'TOKEN_REFRESHED':
          this.handleTokenRefreshed(session);
          break;
          
        case 'SIGNED_IN':
          this.handleSignedIn(session);
          break;
          
        case 'USER_UPDATED':
          if (session?.user) {
            this.logger.debug('用户信息已更新', { userId: session.user.id });
          }
          break;
      }
    });
    
    this.authStateSubscription = data.subscription;
  }

  private initStorageBridge(): void {
    if (typeof window === 'undefined' || !this.storageKey) {
      return;
    }

    window.addEventListener('storage', this.storageListener);
  }

  private handleStorageEvent(event: StorageEvent): void {
    if (!this.storageKey || event.key !== this.storageKey) {
      return;
    }

    // 登出（token 被清除）在任何阶段都应立即响应
    if (!event.newValue) {
      this.teardownInvalidatedSession('AuthService.storageBridge');
      return;
    }

    // Auth runtime 未就绪时忽略登入事件，避免与 onAuthStateChange 竞态
    if (!this.authRuntimeReady) {
      return;
    }

    if (isLocalModeEnabled() || this.currentUserId() === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      this.logger.debug('Storage bridge 忽略 local-user 模式下的跨标签页登入事件');
      return;
    }

    try {
      const parsed = JSON.parse(event.newValue) as unknown;
      const sessionIdentity = this.resolvePersistedSessionIdentityFromAuthData(parsed);
      const userId = sessionIdentity?.userId ?? null;
      const email = sessionIdentity?.email ?? null;

      if (!userId) {
        this.syncPersistedOwnerHintFromStorage();
        this.syncPersistedSessionUserIdFromStorage();
        return;
      }

      if (this.currentUserId() === userId) {
        this.pendingStorageBridgeSessionIdentity = null;
        this.applyConfirmedSessionIdentity(userId, email, {
          publishSessionRestored: this.sessionExpired(),
          source: 'AuthService.storageBridge',
        });
        return;
      }

      const previousPendingUserId = this.pendingStorageBridgeSessionIdentity?.userId ?? null;
      this.pendingStorageBridgeSessionIdentity = { userId, email };
      this.setPersistedOwnerHint(userId);

      if (previousPendingUserId === userId) {
        return;
      }

      this.eventBus.publishSessionRestored(userId, 'AuthService.storageBridge');
    } catch (error) {
      this.syncPersistedOwnerHintFromStorage();
      this.syncPersistedSessionUserIdFromStorage();
      this.logger.debug('Storage bridge 解析 auth token 失败，已忽略', error);
    }
  }

  private resolveInvalidatedOwnerUserId(currentUserId = this.currentUserId()): string | null {
    if (currentUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      return null;
    }

    const candidates = [
      currentUserId,
      this.persistedSessionUserId(),
      this.persistedOwnerHint(),
    ];

    for (const candidate of candidates) {
      if (candidate && candidate !== AUTH_CONFIG.LOCAL_MODE_USER_ID) {
        return candidate;
      }
    }

    return null;
  }

  private clearCachedSessionArtifacts(): void {
    this.pendingStorageBridgeSessionIdentity = null;

    try {
      const storageKey = this.supabase.getStorageKey();
      if (storageKey) {
        localStorage.removeItem(storageKey);
      }
      saveAuthCache(null);
    } catch {
      // localStorage 不可用时静默降级
    }

    if (typeof window === 'undefined') {
      return;
    }

    try {
      delete (window as Window & { __NANOFLOW_SESSION_PREWARM__?: unknown }).__NANOFLOW_SESSION_PREWARM__;
    } catch {
      // window 只读异常时静默降级
    }
  }

  private teardownInvalidatedSession(source: string): { invalidatedUserId: string | null; keepLocalModeUser: boolean } {
    const currentUserId = this.currentUserId();
    const keepLocalModeUser = currentUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID;
    const invalidatedUserId = this.resolveInvalidatedOwnerUserId(currentUserId);

    // 中文注释：先同步广播 teardown，让 WorkspaceShell 立即停写 launch snapshot，
    // 再清空 auth signal，避免旧 owner 项目摘要落进 anonymous bucket。
    if (invalidatedUserId) {
      this.pendingSessionRestoredNotification = true;
      this.eventBus.publishSessionInvalidated(source, invalidatedUserId);
    }

    if (!keepLocalModeUser) {
      this.currentUserId.set(null);
    }
    this.setPersistedOwnerHint(null);
    this.setPersistedSessionUserId(null);
    this.sessionEmail.set(null);
    this.authState.update((state) => ({
      ...state,
      userId: keepLocalModeUser ? AUTH_CONFIG.LOCAL_MODE_USER_ID : null,
      email: null,
      error: null,
      isCheckingSession: false,
    }));

    this.clearCachedSessionArtifacts();

    this.sentryLazyLoader.setUser(null);

    return { invalidatedUserId, keepLocalModeUser };
  }
  
  /**
   * 处理登出事件
   * 区分用户主动登出和 Token 过期
   */
  private handleSignedOut(): void {
    if (this.isManualSignOut) {
      this.logger.info('用户主动登出');
      // 重置标志
      this.isManualSignOut = false;
    } else if (this.currentUserId() && this.currentUserId() !== AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      // 仅当之前存在已登录用户时，才视为会话过期
      // 防止启动阶段 Supabase 触发的初始 SIGNED_OUT 事件被误判为过期
      this.logger.warn('检测到非主动登出，Token 过期');
      this.handleSessionExpired();
    } else {
      // 未登录状态下收到 SIGNED_OUT，非真正过期，仅记录日志
      this.logger.debug('忽略 SIGNED_OUT 事件：当前无已登录用户，非会话过期');
    }
  }
  
  /**
   * 处理会话过期
   * 
   * 【Week 8-9 数据保护 - JWT 刷新失败监听】
   */
  private handleSessionExpired(): void {
    this.teardownInvalidatedSession('AuthService.signedOut');
    this.sessionExpired.set(true);
    
    // 显示重新登录提示
    this.toast.warning('登录已过期', '请重新登录以继续同步数据', { duration: 0 });
    
    this.logger.warn('会话已过期，需要重新登录');
  }
  
  /**
   * 处理 Token 刷新成功
   */
  private handleTokenRefreshed(session: { user?: { id: string; email?: string | null } } | null): void {
    this.logger.debug('Token 刷新成功');

    // 更新会话信息
    if (session?.user) {
      this.applyConfirmedSessionIdentity(session.user.id, session.user.email ?? null, {
        publishSessionRestored: true,
        source: 'AuthService',
      });
    }
  }
  
  /**
   * 处理登录成功
   */
  private handleSignedIn(session: { user?: { id: string; email?: string | null } } | null): void {
    if (session?.user) {
      this.logger.info('用户已登录', { userId: session.user.id });
      if (this.pendingStorageBridgeSessionIdentity?.userId === session.user.id && this.currentUserId() !== session.user.id) {
        this.pendingStorageBridgeSessionIdentity = {
          userId: session.user.id,
          email: session.user.email ?? null,
        };
        this.setPersistedOwnerHint(session.user.id);
        return;
      }

      this.pendingStorageBridgeSessionIdentity = null;
      this.applyConfirmedSessionIdentity(session.user.id, session.user.email ?? null, {
        publishSessionRestored: true,
        source: 'AuthService',
      });
    }
  }

  completeCrossTabSessionRestore(userId: string): void {
    if (this.currentUserId() !== userId) {
      return;
    }

    const sessionIdentity = this.peekPersistedSessionIdentity();
    if (!sessionIdentity || sessionIdentity.userId !== userId) {
      return;
    }

    this.pendingStorageBridgeSessionIdentity = null;
    this.applyConfirmedSessionIdentity(userId, sessionIdentity.email ?? null);
  }

  private applyConfirmedSessionIdentity(
    userId: string,
    email: string | null,
    options?: {
      publishSessionRestored?: boolean;
      source?: string;
    },
  ): void {
    this.currentUserId.set(userId);
    this.setPersistedOwnerHint(userId);
    this.setPersistedSessionUserId(userId);
    this.sessionEmail.set(email);
    this.sentryLazyLoader.setUser({ id: userId, email: email ?? undefined });

    const shouldPublishSessionRestored = options?.publishSessionRestored
      && (this.sessionExpired() || this.pendingSessionRestoredNotification);

    if (this.sessionExpired()) {
      this.sessionExpired.set(false);
    }

    if (shouldPublishSessionRestored) {
      this.pendingSessionRestoredNotification = false;
      this.notifySyncServiceSessionRestored(userId, options?.source ?? 'AuthService');
    }

    this.authState.update(s => ({
      ...s,
      userId,
      email,
      error: null,
      isCheckingSession: false,
    }));
  }
  
  /**
   * 通知会话已恢复
   * 
   * 【技术债务修复 2026-01-31】
   * 使用 EventBusService 替代 injector hack，彻底解决循环依赖
   */
  private notifySyncServiceSessionRestored(userId = this.authState().userId, source = 'AuthService'): void {
    if (userId) {
      this.eventBus.publishSessionRestored(userId, source);
    }
  }
}
