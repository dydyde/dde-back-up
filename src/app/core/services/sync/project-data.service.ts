/**
 * ProjectDataService - 项目数据加载服务
 * 
 * 职责：
 * - 完整项目加载 (loadFullProject, loadFullProjectOptimized)
 * - 项目列表加载 (loadProjectsFromCloud)
 * - 轻量项目元数据加载 (loadProjectListMetadataFromCloud)
 * - 单个项目加载 (loadSingleProject)
 * - 离线快照管理 (saveOfflineSnapshot, loadOfflineSnapshot)
 * 
 * 从 SimpleSyncService 提取，Sprint 9 技术债务修复
 */

import { Injectable, inject } from '@angular/core';
import { SupabaseClientService } from '../../../../services/supabase-client.service';
import { AuthService } from '../../../../services/auth.service';
import { LoggerService } from '../../../../services/logger.service';
import { RequestThrottleService } from '../../../../services/request-throttle.service';
import { SyncStateService } from './sync-state.service';
import { SessionManagerService } from './session-manager.service';
import { TombstoneService } from './tombstone.service';
import { Task, Project, Connection } from '../../../../models';
import { TaskRow, ProjectRow, ConnectionRow } from '../../../../models/supabase-types';
import { supabaseErrorToError, classifySupabaseClientFailure } from '../../../../utils/supabase-error';
import { openIndexedDBAdaptive } from '../../../../utils/indexeddb-open';
import { REQUEST_THROTTLE_CONFIG, FIELD_SELECT_CONFIG, CACHE_CONFIG } from '../../../../config/sync.config';
import { AUTH_CONFIG } from '../../../../config/auth.config';
import { FOCUS_CONFIG } from '../../../../config/focus.config';
import { TIMEOUT_CONFIG } from '../../../../config/timeout.config';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import { StartupPlaceholderStateService } from '../../../../services/startup-placeholder-state.service';
import {
  createBrowserNetworkSuspendedError,
  getRemainingBrowserNetworkResumeDelayMs,
  isBrowserNetworkSuspendedError,
  isBrowserNetworkSuspendedWindow,
} from '../../../../utils/browser-network-suspension';
import {
  getCompatibleTaskSelectFields,
  markTaskCompletedAtColumnUnavailable,
} from '../../../../utils/task-schema-compat';

interface ParkedTaskCacheRecord {
  taskId: string;
  projectId: string;
  task: Task;
  updatedAt: string;
}

interface ParkedTaskDeltaRow extends Partial<TaskRow> {
  project_id?: string;
}

export interface ParkedTaskEntry {
  task: Task;
  projectId: string;
}

export interface ParkedTaskCacheSnapshot {
  entries: ParkedTaskEntry[];
  cursor: string | null;
}

export interface ParkedTaskDeltaResult {
  entries: ParkedTaskEntry[];
  removedTaskIds: string[];
  nextCursor: string | null;
}

export interface ProjectListMetadataLoadOptions {
  timeout?: number;
  retries?: number;
  silent?: boolean;
  purpose?: string;
  treatTransientFailureAsSoft?: boolean;
}

export type StartupOfflineSnapshotSource = 'idb' | 'localStorage' | 'none';

export interface StartupOfflineSnapshotLoadResult {
  source: StartupOfflineSnapshotSource;
  projectCount: number;
  bytes: number;
  migratedLegacy: boolean;
  projects: Project[];
  ownerUserId?: string | null;
}

interface ParsedOfflineSnapshotEnvelope {
  projects: Project[];
  ownerUserId: string | null;
  savedAt: string | null;
}

interface OfflineSnapshotLoadOptions {
  allowOwnerHint?: boolean;
  ownerUserId?: string | null;
}

@Injectable({
  providedIn: 'root'
})
export class ProjectDataService {
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly startupPlaceholderState = inject(StartupPlaceholderStateService, { optional: true });
  private readonly supabase = inject(SupabaseClientService);
  private readonly authService = inject(AuthService, { optional: true });
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('ProjectData');
  private readonly throttle = inject(RequestThrottleService);
  private readonly syncState = inject(SyncStateService);
  private readonly sessionManager = inject(SessionManagerService, { optional: true });
  private readonly tombstoneService = inject(TombstoneService);
  
  /**
   * 是否正在从远程加载
   *
   * 【根因修复 2026-05-15】此前 ProjectDataService、SimpleSyncService 各持一份 signal，
   * 且 SimpleSyncService 的 signal 从未被写入（孤儿信号），导致 SyncCoordinator/
   * project.guard/mobile-todo-drawer/sync-status 等所有上游消费者读到的"远程加载中"
   * 永久为 false。这里统一以 SyncStateService.isLoadingRemote 为单一事实源，
   * 写入通过 setLoadingRemote(...)，所有消费者从同一 signal 读取。
   */
  readonly isLoadingRemote = this.syncState.isLoadingRemote;
  
  /** 离线缓存配置 */
  private readonly OFFLINE_CACHE_KEY = CACHE_CONFIG.OFFLINE_CACHE_KEY;
  private readonly CACHE_VERSION = CACHE_CONFIG.CACHE_VERSION;
  private readonly LEGACY_OFFLINE_SNAPSHOT_RECORD_ID = 'offline-snapshot';
  /** 停泊任务轻量缓存游标键（A3.4） */
  private readonly PARKING_SYNC_CURSOR_KEY = 'parking_last_sync_time';
  /** 避免本地离线模式重复打印“未配置”告警 */
  private hasLoggedSupabaseMissingConfig = false;
  /** 会话级熔断：当批量 RPC 不存在时，后续直接走顺序加载 */
  private batchRpcUnavailable = false;

  private isSupabaseOfflineMode(): boolean {
    const maybeSignal = (this.supabase as unknown as { isOfflineMode?: (() => boolean) | boolean }).isOfflineMode;
    if (typeof maybeSignal === 'function') {
      try {
        return Boolean(maybeSignal());
      } catch {
        return false;
      }
    }
    return Boolean(maybeSignal);
  }

  private isSyncStateOfflineMode(): boolean {
    const maybeSyncState = (this.syncState as unknown as {
      syncState?: (() => { offlineMode?: boolean }) | { offlineMode?: boolean };
    }).syncState;

    if (typeof maybeSyncState === 'function') {
      try {
        return Boolean(maybeSyncState()?.offlineMode);
      } catch {
        return false;
      }
    }

    if (typeof maybeSyncState === 'object' && maybeSyncState !== null) {
      return Boolean(maybeSyncState.offlineMode);
    }

    return false;
  }

  private isBatchRpcMissingError(error: {
    code?: string;
    message?: string;
    details?: string;
    hint?: string;
  }): boolean {
    const normalized = [error.message, error.details, error.hint]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .join(' ')
      .toLowerCase();

    return (
      error.code === '42883' ||
      error.code === 'PGRST202' ||
      normalized.includes('does not exist') ||
      normalized.includes('could not find the function') ||
      normalized.includes('schema cache')
    );
  }

  private resolveRemoteSessionUserId(): string | null {
    const currentUserId = this.authService?.currentUserId() ?? null;
    if (typeof currentUserId === 'string' && currentUserId.length > 0) {
      return currentUserId;
    }

    const authSettling = !!this.authService
      && (!this.authService.sessionInitialized()
        || this.authService.authState().isCheckingSession
        || this.authService.runtimeState() === 'pending');

    if (!authSettling) {
      return null;
    }

    const persistedSessionUserId = this.authService?.peekPersistedSessionIdentity?.()?.userId ?? null;
    return typeof persistedSessionUserId === 'string' && persistedSessionUserId.length > 0
      ? persistedSessionUserId
      : null;
  }

  private isSessionExpiredError(error: ReturnType<typeof supabaseErrorToError>): boolean {
    return this.sessionManager?.isSessionExpiredError(error) ?? false;
  }

  private async tryRefreshSessionWithSession(context: string): Promise<{ refreshed: boolean }> {
    return this.sessionManager?.tryRefreshSessionWithSession(context) ?? { refreshed: false };
  }
  
  /**
   * 获取 Supabase 客户端
   */
  private async getSupabaseClient(expectedUserId?: string): Promise<SupabaseClient | null> {
    if (!this.supabase.isConfigured) {
      const failure = classifySupabaseClientFailure(false);
      if (!this.hasLoggedSupabaseMissingConfig) {
        if (this.isSupabaseOfflineMode()) {
          this.logger.info('Supabase 未配置，保持离线模式', failure);
        } else {
          this.logger.warn('无法获取 Supabase 客户端', failure);
          this.syncState.setSyncError(failure.message);
        }
        this.hasLoggedSupabaseMissingConfig = true;
      }
      return null;
    }
    if (this.isSyncStateOfflineMode() || this.isSupabaseOfflineMode()) {
      this.logger.debug('连接中断模式下跳过 ProjectData 远端读取');
      return null;
    }
    const hasExpectedRemoteUser = typeof expectedUserId === 'string'
      && expectedUserId.length > 0
      && expectedUserId !== AUTH_CONFIG.LOCAL_MODE_USER_ID;
    if (!this.resolveRemoteSessionUserId() && !hasExpectedRemoteUser) {
      this.logger.debug('会话不可用，跳过 ProjectData 远端读取');
      return null;
    }
    try {
      return await this.supabase.clientAsync();
    } catch (error) {
      const failure = classifySupabaseClientFailure(true, error);
      this.logger.warn('无法获取 Supabase 客户端', {
        category: failure.category,
        message: failure.message
      });
      this.syncState.setSyncError(failure.message);
      // eslint-disable-next-line no-restricted-syntax -- 按既有契约返回 null，调用方据此切换到本地快照分支
      return null;
    }
  }

  /**
   * 远端读请求执行器：在检测到 JWT 过期/401 时自动刷新 session 并重试一次。
   *
   * 背景：Supabase JS 的 autoRefreshToken 在长时间页面挂起或设备休眠恢复后
   * 可能未能及时刷新，导致读请求 401 刷屏。写路径已统一在失败时主动
   * 刷新，读路径此前缺失该能力——本 helper 补齐读路径自愈。
   *
   * 关键：使用 tryRefreshSessionWithSession (allowWhenExpired: true)，即使
   * syncState.sessionExpired 已被其他写路径设为 true，仍能执行刷新，
   * 刷新成功后 SessionManager 会自动重置 flag，避免“flag 死锁”导致后续
   * 读请求永远不再尝试刷新。
   *
   * 约定：fn 中抛出的错误由 helper 拦截并尝试刷新；刷新成功则重试一次，
   * 否则原样抛出，交由调用方既有 catch 分支处理（warn + 降级）。
   */
  private async withAuthRetry<T>(context: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      const enhanced = supabaseErrorToError(error);
      if (!this.isSessionExpiredError(enhanced)) {
        throw error;
      }

      const refreshResult = await this.tryRefreshSessionWithSession(context);
      if (!refreshResult.refreshed) {
        throw error;
      }

      this.logger.info('会话已刷新，重试远端读请求', { context });
      return await fn();
    }
  }
  
  /**
   * 使用 RPC 批量加载完整项目数据
   * 
   * 优化效果：
   * - 将 4+ 个 API 请求合并为 1 个 RPC 调用
   * - 减少 ~70% 的网络往返时间
   */
  async loadFullProjectOptimized(projectId: string): Promise<Project | null> {
    const client = await this.getSupabaseClient();
    if (!client) return null;

    if (this.batchRpcUnavailable) {
      this.logger.debug('批量 RPC 已熔断，直接走顺序加载', { projectId });
      return this.loadFullProject(projectId);
    }

    try {
      this.logger.debug('使用 RPC 批量加载项目', { projectId });
      
      let { data, error } = await client.rpc('get_full_project_data', {
        p_project_id: projectId
      });

      // 【JWT 自愈】RPC 返回 401/JWT expired 时主动刷新并重试一次，避免徒劳走
      // fallback 链路再次触发 401。使用 tryRefreshSessionWithSession 绕过
      // syncState.sessionExpired 短路。
      if (error) {
        const enhanced = supabaseErrorToError(error);
        if (this.isSessionExpiredError(enhanced)) {
          const refreshResult = await this.tryRefreshSessionWithSession('loadFullProjectOptimized');
          if (refreshResult.refreshed) {
            this.logger.info('loadFullProjectOptimized 会话已刷新，重试 RPC', { projectId });
            const retry = await client.rpc('get_full_project_data', {
              p_project_id: projectId
            });
            data = retry.data;
            error = retry.error;
          }
        }
      }

      if (error) {
        const isBatchRpcMissing = this.isBatchRpcMissingError(error);
        if (isBatchRpcMissing) {
          this.batchRpcUnavailable = true;
          this.logger.warn('批量 RPC 不可用，切换到顺序加载并启用会话熔断', {
            projectId,
            errorCode: error.code,
            error: error.message,
          });
          this.sentryLazyLoader.captureMessage('RPC get_full_project_data unavailable, fallback enabled', {
            level: 'warning',
            tags: {
              operation: 'loadFullProjectOptimized',
              classification: 'rpc_missing',
            },
            extra: {
              projectId,
              errorCode: error.code ?? 'unknown',
              errorMessage: error.message ?? '',
            }
          });
          return this.loadFullProject(projectId);
        }

        // 【性能优化 2026-02-14】区分 Access Denied 与其他错误
        // Access Denied（P0001）说明 projectId 无效或无权限，无需 fallback
        const isAccessDenied = error.code === 'P0001' || error.message?.includes('Access denied');
        if (isAccessDenied) {
          this.logger.warn('项目访问被拒绝，跳过该项目（不走 fallback）', { projectId, errorCode: error.code });
          // 【监控 2026-02-14】上报 RPC 400 Access Denied，用于 Sentry 告警
          this.sentryLazyLoader.addBreadcrumb({
            category: 'sync.rpc',
            message: `RPC Access Denied: projectId=${projectId}`,
            level: 'warning',
            data: { projectId, errorCode: error.code },
          });
          this.sentryLazyLoader.captureMessage('RPC Access Denied (P0001, no fallback)', {
            level: 'warning',
            tags: {
              operation: 'loadFullProjectOptimized',
              classification: 'access_denied'
            },
            extra: {
              projectId,
              errorCode: error.code ?? 'P0001'
            }
          });
          return null;
        }
        // 【鲁棒性 2026-04-16】浏览器网络 IO 挂起属瞬时错误（后台/节流/切页），
        // 不走 fallback，否则顺序加载也会命中同样异常，累积 ERROR 风暴。
        const rpcErrEnhanced = supabaseErrorToError(error);
        if (isBrowserNetworkSuspendedError(rpcErrEnhanced) || isBrowserNetworkSuspendedWindow()) {
          this.logger.debug('浏览器网络挂起，跳过 RPC 回退', { projectId });
          return null;
        }
        // 其他错误（网络、超时等）仍走 fallback 顺序加载
        this.logger.warn('RPC 调用失败，回退到顺序加载', { error: error.message });
        return this.loadFullProject(projectId);
      }
      
      if (!data?.project) {
        this.logger.warn('RPC 返回空数据', { projectId });
        return null;
      }

      // 转换 RPC 返回的数据格式
      const project = this.rowToProject(data.project);
      
      // 过滤 tombstones 中的已删除项
      const taskTombstoneSet = new Set<string>(data.task_tombstones || []);
      const connectionTombstoneSet = new Set<string>(data.connection_tombstones || []);
      
      project.tasks = (data.tasks || [])
        .filter((t: TaskRow) => !taskTombstoneSet.has(t.id))
        .map((t: TaskRow) => this.rowToTask(t));
      
      project.connections = (data.connections || [])
        .filter((c: ConnectionRow) => !connectionTombstoneSet.has(c.id))
        .map((c: ConnectionRow) => this.rowToConnection(c));

      this.logger.info('RPC 批量加载成功', { 
        projectId, 
        tasksCount: project.tasks.length,
        connectionsCount: project.connections.length
      });

      return project;
    } catch (e) {
      const err = supabaseErrorToError(e);
      // 【鲁棒性 2026-04-16】浏览器网络挂起错误降级为 debug，不上报 Sentry，不走 fallback
      if (isBrowserNetworkSuspendedError(err) || isBrowserNetworkSuspendedWindow()) {
        this.logger.debug('浏览器网络挂起，跳过批量加载', { projectId });
        return null;
      }
      this.logger.error('批量加载项目失败', err);
      this.sentryLazyLoader.captureException(err, {
        tags: { operation: 'loadFullProjectOptimized' },
        extra: { projectId }
      });
      return this.loadFullProject(projectId);
    }
  }
  
  /**
   * 加载完整项目（包含任务和连接）
   * 使用请求限流避免连接池耗尽
   */
  async loadFullProject(projectId: string): Promise<Project | null> {
    const client = await this.getSupabaseClient();
    if (!client) return null;

    if (isBrowserNetworkSuspendedWindow()) {
      this.logger.debug('浏览器网络挂起，跳过顺序加载', {
        projectId,
        resumeDelayMs: getRemainingBrowserNetworkResumeDelayMs(),
      });
      return null;
    }
    
    try {
      // 1. 加载项目元数据
      const projectData = await this.throttle.execute(
        `project-meta:${projectId}`,
        async () => this.withAuthRetry('loadFullProject.meta', async () => {
          const { data, error } = await client
            .from('projects')
            .select(FIELD_SELECT_CONFIG.PROJECT_LIST_FIELDS)
            .eq('id', projectId)
            .is('deleted_at', null)
            .maybeSingle();
          if (error) throw supabaseErrorToError(error);
          return data;
        }),
        { 
          deduplicate: true, 
          priority: 'normal',
          timeout: REQUEST_THROTTLE_CONFIG.BATCH_SYNC_TIMEOUT
        }
      );
      
      if (!projectData) {
        this.logger.warn('项目不存在或无权访问', { projectId });
        return null;
      }

      // 2. 顺序加载任务和连接
      const tasks = await this.pullTasksThrottled(projectId, client);
      const connectionsData = await this.throttle.execute(
        `connections:${projectId}`,
        async () => {
          if (isBrowserNetworkSuspendedWindow()) {
            this.logger.debug('浏览器网络挂起，延后连接查询', {
              projectId,
              resumeDelayMs: getRemainingBrowserNetworkResumeDelayMs(),
            });
            throw createBrowserNetworkSuspendedError();
          }

          const { data, error } = await client
            .from('connections')
            .select(FIELD_SELECT_CONFIG.CONNECTION_FIELDS)
            .eq('project_id', projectId);
          if (error) {
            const enhanced = supabaseErrorToError(error);
            if (isBrowserNetworkSuspendedError(enhanced) || isBrowserNetworkSuspendedWindow()) {
              this.logger.debug('浏览器网络挂起，延后连接查询', {
                projectId,
                resumeDelayMs: getRemainingBrowserNetworkResumeDelayMs(),
              });
              throw createBrowserNetworkSuspendedError();
            }

            this.logger.error('连接查询失败', { projectId, error: enhanced.message });
            return [];
          }
          return data || [];
        },
        { 
          deduplicate: true, 
          priority: 'normal',
          timeout: REQUEST_THROTTLE_CONFIG.BATCH_SYNC_TIMEOUT
        }
      );
      
      // 3. 转换连接数据
      const connections: Connection[] = connectionsData.map((row: Record<string, unknown>) => ({
        id: String(row.id),
        source: String(row.source_id),
        target: String(row.target_id),
        title: row.title ? String(row.title) : undefined,
        description: String(row.description || ''),
        deletedAt: row.deleted_at ? String(row.deleted_at) : null,
        updatedAt: row.updated_at ? String(row.updated_at) : undefined
      }));
      
      const project = this.rowToProject(projectData);
      project.tasks = tasks;
      project.connections = connections;
      
      return project;
    } catch (e) {
      const err = supabaseErrorToError(e);
      // 【鲁棒性 2026-04-16】浏览器网络挂起：降级为 debug，不上报 Sentry
      if (isBrowserNetworkSuspendedError(err) || isBrowserNetworkSuspendedWindow()) {
        this.logger.debug('浏览器网络挂起，跳过顺序加载', { projectId });
        // eslint-disable-next-line no-restricted-syntax -- 瞬时挂起：返回 null 让上层沿用本地快照
        return null;
      }
      this.logger.error('加载项目失败', err);
      this.sentryLazyLoader.captureException(err, {
        tags: { operation: 'loadFullProject' },
        extra: { projectId }
      });
      // eslint-disable-next-line no-restricted-syntax -- 保持 API 契约：异常时返回 null 交由调用方进行回退处理
      return null;
    }
  }
  
  /**
   * 轻量加载项目列表元数据
   *
   * 仅返回迁移判断所需的项目壳数据；拉取失败时返回 null，
   * 让上层能区分“云端已确认为空”和“当前无法确认云端状态”。
   */
  async loadProjectListMetadataFromCloud(
    userId: string,
    options: ProjectListMetadataLoadOptions = {}
  ): Promise<Project[] | null> {
    if (userId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      this.logger.debug('本地模式，跳过云端项目元数据加载');
      return [];
    }

    const client = await this.getSupabaseClient(userId);
    if (!client) return null;

    const timeout = Math.max(TIMEOUT_CONFIG.QUICK, options.timeout ?? TIMEOUT_CONFIG.QUICK);
    const retries = Math.max(0, options.retries ?? 0);

    try {
      const projectList = await this.throttle.execute(
        this.buildProjectListMetadataRequestKey(userId, timeout, retries),
        async () => this.withAuthRetry('loadProjectListMetadataFromCloud', async () => {
          const { data, error } = await client
            .from('projects')
            .select(FIELD_SELECT_CONFIG.PROJECT_LIST_FIELDS)
            .eq('owner_id', userId)
            .is('deleted_at', null)
            .order('updated_at', { ascending: false });

          if (error) throw supabaseErrorToError(error);
          return data || [];
        }),
        {
          deduplicate: true,
          priority: 'high',
          timeout,
          retries,
          silent: options.silent ?? false,
        }
      );

      return projectList.map(row => this.rowToProject(row));
    } catch (e) {
      const err = supabaseErrorToError(e);

      if (options.treatTransientFailureAsSoft && this.isTransientMetadataLoadFailure(err)) {
        this.logger.info('项目元数据列表拉取暂时不可用，已降级为软失败', {
          userId,
          purpose: options.purpose ?? 'default',
          message: err.message,
        });
        return null;
      }

      this.logger.warn('加载项目元数据列表失败', err);
      this.sentryLazyLoader.captureException(err, {
        tags: {
          operation: 'loadProjectListMetadataFromCloud',
          ...(options.purpose ? { purpose: options.purpose } : {}),
        }
      });
      // eslint-disable-next-line no-restricted-syntax -- 元数据加载失败时返回 null 触发调用方降级到本地快照
      return null;
    }
  }

  private buildProjectListMetadataRequestKey(
    userId: string,
    timeout: number,
    retries: number
  ): string {
    return `project-list-metadata:${userId}:${timeout}:${retries}`;
  }

  private isTransientMetadataLoadFailure(error: Error): boolean {
    const retryableError = error as Error & { isRetryable?: boolean; errorType?: string; code?: string | number };
    if (retryableError.isRetryable === true) {
      return true;
    }

    const message = error.message.toLowerCase();

    return (
      message.includes('请求超时') ||
      message.includes('timeout') ||
      message.includes('failed to fetch') ||
      message.includes('network') ||
      message.includes('429') ||
      message.includes('503') ||
      message.includes('504')
    );
  }

  /**
   * 加载项目列表
   */
  async loadProjectsFromCloud(userId: string): Promise<Project[]> {
    // 本地模式不查询 Supabase
    if (userId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      this.logger.debug('本地模式，跳过云端加载');
      return [];
    }

    // 【鲁棒性 2026-04-16】浏览器网络挂起窗口内短路，避免整批进入失败级联
    if (isBrowserNetworkSuspendedWindow()) {
      this.logger.debug('浏览器网络挂起，跳过云端项目列表加载', { userId });
      return [];
    }

    const client = await this.getSupabaseClient();
    if (!client) return [];
    
    this.syncState.setLoadingRemote(true);
    
    try {
      // 1. 加载项目列表
      const projectList = await this.throttle.execute(
        `project-list:${userId}`,
        async () => this.withAuthRetry('loadProjectsFromCloud', async () => {
          const { data, error } = await client
            .from('projects')
            .select(FIELD_SELECT_CONFIG.PROJECT_LIST_FIELDS)
            .eq('owner_id', userId)
            .is('deleted_at', null)
            .order('updated_at', { ascending: false });
          
          if (error) throw supabaseErrorToError(error);
          return data || [];
        }),
        { 
          deduplicate: true, 
          priority: 'high',
          timeout: REQUEST_THROTTLE_CONFIG.BATCH_SYNC_TIMEOUT, 
          retries: 5 
        }
      );
      
      // 2. 批量加载完整项目数据
      this.logger.debug('开始批量加载项目', { count: projectList.length });
      
      const loadPromises = projectList.map(row => 
        this.loadFullProjectOptimized(row.id)
      );
      
      const results = await Promise.allSettled(loadPromises);
      
      const projects: Project[] = [];
      let failedCount = 0;
      let suspendedCount = 0;
      
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (result.status === 'fulfilled' && result.value) {
          projects.push(result.value);
        } else if (result.status === 'fulfilled') {
          // 【鲁棒性 2026-04-16】网络挂起导致的 null 不计失败，仅降级调试
          if (isBrowserNetworkSuspendedWindow()) {
            suspendedCount++;
            continue;
          }
          failedCount++;
          this.logger.warn('加载项目返回空结果', {
            projectId: projectList[i]?.id,
          });
        } else if (result.status === 'rejected') {
          // 【鲁棒性 2026-04-16】分类浏览器网络挂起：debug 级别，不计失败
          if (isBrowserNetworkSuspendedError(result.reason) || isBrowserNetworkSuspendedWindow()) {
            suspendedCount++;
            continue;
          }
          failedCount++;
          this.logger.warn('加载项目失败', { 
            projectId: projectList[i]?.id,
            error: result.reason 
          });
        }
      }
      
      if (suspendedCount > 0) {
        this.logger.debug('部分项目因浏览器网络挂起跳过', {
          total: projectList.length,
          suspended: suspendedCount,
          success: projects.length,
        });
      }
      if (failedCount > 0) {
        this.logger.warn('部分项目加载失败', { 
          total: projectList.length, 
          failed: failedCount,
          success: projects.length 
        });
      }
      
      return projects;
    } catch (e) {
      // 【鲁棒性 2026-04-16】浏览器网络挂起：debug，不上报 Sentry
      if (isBrowserNetworkSuspendedError(e) || isBrowserNetworkSuspendedWindow()) {
        this.logger.debug('浏览器网络挂起，跳过云端项目列表加载');
        return [];
      }
      this.logger.error('加载项目列表失败', e);
      this.sentryLazyLoader.captureException(e, {
        tags: { operation: 'loadProjectsFromCloud' }
      });
      return [];
    } finally {
      this.syncState.setLoadingRemote(false);
    }
  }
  
  /**
   * 加载单个项目
   */
  async loadSingleProject(projectId: string): Promise<Project | null> {
    return this.loadFullProjectOptimized(projectId);
  }

  /**
   * 获取项目同步水位（远端聚合最大更新时间）
   *
   * 用于恢复链路先判变更再决定是否拉取完整项目。
   */
  async getProjectSyncWatermark(projectId: string): Promise<string | null> {
    if (isBrowserNetworkSuspendedWindow()) {
      // eslint-disable-next-line no-restricted-syntax -- 挂起窗口：静默返回 null 触发调用方降级
      return null;
    }
    const client = await this.getSupabaseClient();
    if (!client) return null;

    try {
      return await this.withAuthRetry('getProjectSyncWatermark', async () => {
        const { data, error } = await client.rpc('get_project_sync_watermark', {
          p_project_id: projectId
        });

        if (error) {
          throw supabaseErrorToError(error);
        }

        if (typeof data === 'string') {
          return data;
        }

        if (Array.isArray(data) && data.length > 0 && typeof data[0] === 'string') {
          return data[0];
        }

        return null;
      });
    } catch (e) {
      if (isBrowserNetworkSuspendedError(e) || isBrowserNetworkSuspendedWindow()) {
        // eslint-disable-next-line no-restricted-syntax -- 挂起窗口：静默返回 null
        return null;
      }
      this.logger.warn('获取项目同步水位失败', {
        projectId,
        error: supabaseErrorToError(e).message
      });
      // eslint-disable-next-line no-restricted-syntax -- 水位 RPC 失败时降级为慢路拉取，由调用方决定后续策略
      return null;
    }
  }

  /**
   * 获取当前用户项目域聚合同步水位
   */
  async getUserProjectsWatermark(): Promise<string | null> {
    if (isBrowserNetworkSuspendedWindow()) {
      // eslint-disable-next-line no-restricted-syntax -- 挂起窗口：静默降级
      return null;
    }
    const client = await this.getSupabaseClient();
    if (!client) return null;

    try {
      return await this.withAuthRetry('getUserProjectsWatermark', async () => {
        const { data, error } = await client.rpc('get_user_projects_watermark');
        if (error) {
          throw supabaseErrorToError(error);
        }

        if (typeof data === 'string') {
          return data;
        }
        if (Array.isArray(data) && data.length > 0 && typeof data[0] === 'string') {
          return data[0];
        }
        return null;
      });
    } catch (e) {
      if (isBrowserNetworkSuspendedError(e) || isBrowserNetworkSuspendedWindow()) {
        // eslint-disable-next-line no-restricted-syntax -- 挂起窗口：静默降级
        return null;
      }
      this.logger.warn('获取用户项目域同步水位失败', {
        error: supabaseErrorToError(e).message
      });
      // eslint-disable-next-line no-restricted-syntax -- RPC 失败时降级为全量拉取（null 触发 fallback）
      return null;
    }
  }

  /**
   * 拉取给定水位之后发生变化的项目头信息
   */
  async listProjectHeadsSince(
    watermark: string | null
  ): Promise<Array<{ id: string; updatedAt: string; version: number }>> {
    if (isBrowserNetworkSuspendedWindow()) {
      return [];
    }
    const client = await this.getSupabaseClient();
    if (!client) return [];

    try {
      return await this.withAuthRetry('listProjectHeadsSince', async () => {
        const { data, error } = await client.rpc('list_project_heads_since', {
          p_since: watermark
        });
        if (error) {
          throw supabaseErrorToError(error);
        }

        const rows = Array.isArray(data) ? data : [];
        return rows
          .map((row) => ({
            id: String((row as Record<string, unknown>)['project_id'] ?? ''),
            updatedAt: String((row as Record<string, unknown>)['updated_at'] ?? ''),
            version: Number((row as Record<string, unknown>)['version'] ?? 1),
          }))
          .filter((row) => !!row.id && !!row.updatedAt);
      });
    } catch (e) {
      if (isBrowserNetworkSuspendedError(e) || isBrowserNetworkSuspendedWindow()) {
        return [];
      }
      this.logger.warn('拉取项目头信息失败', {
        watermark,
        error: supabaseErrorToError(e).message
      });
      return [];
    }
  }

  /**
   * 获取当前 activeProject 的访问性与聚合水位
   *
   * 单次 RPC 完成“可访问性 + 是否有更新”探测，避免恢复链路多步串行请求。
   */
  async getAccessibleProjectProbe(projectId: string): Promise<{
    projectId: string;
    accessible: boolean;
    watermark: string | null;
  } | null> {
    if (isBrowserNetworkSuspendedWindow()) {
      // eslint-disable-next-line no-restricted-syntax -- 挂起窗口：静默降级
      return null;
    }
    const client = await this.getSupabaseClient();
    if (!client) return null;

    try {
      return await this.withAuthRetry('getAccessibleProjectProbe', async () => {
        const { data, error } = await client.rpc('get_accessible_project_probe', {
          p_project_id: projectId
        });
        if (error) {
          throw supabaseErrorToError(error);
        }

        const row = Array.isArray(data) ? data[0] : data;
        if (!row || typeof row !== 'object') {
          return null;
        }
        const record = row as Record<string, unknown>;
        return {
          projectId: String(record['project_id'] ?? projectId),
          accessible: Boolean(record['accessible']),
          watermark: record['watermark'] ? String(record['watermark']) : null,
        };
      });
    } catch (e) {
      if (isBrowserNetworkSuspendedError(e) || isBrowserNetworkSuspendedWindow()) {
        // eslint-disable-next-line no-restricted-syntax -- 挂起窗口：静默降级
        return null;
      }
      this.logger.warn('获取项目访问探测失败', {
        projectId,
        error: supabaseErrorToError(e).message
      });
      // eslint-disable-next-line no-restricted-syntax -- RPC 失败时返回 null 触发调用方降级逻辑
      return null;
    }
  }

  /**
   * 获取黑匣子域聚合同步水位（当前用户）
   */
  async getBlackBoxSyncWatermark(): Promise<string | null> {
    if (isBrowserNetworkSuspendedWindow()) {
      // eslint-disable-next-line no-restricted-syntax -- 挂起窗口：静默降级
      return null;
    }
    const client = await this.getSupabaseClient();
    if (!client) return null;

    try {
      return await this.withAuthRetry('getBlackBoxSyncWatermark', async () => {
        const { data, error } = await client.rpc('get_black_box_sync_watermark');
        if (error) {
          throw supabaseErrorToError(error);
        }

        if (typeof data === 'string') {
          return data;
        }
        if (Array.isArray(data) && data.length > 0 && typeof data[0] === 'string') {
          return data[0];
        }
        return null;
      });
    } catch (e) {
      if (isBrowserNetworkSuspendedError(e) || isBrowserNetworkSuspendedWindow()) {
        // eslint-disable-next-line no-restricted-syntax -- 挂起窗口：静默降级
        return null;
      }
      this.logger.warn('获取黑匣子同步水位失败', {
        error: supabaseErrorToError(e).message
      });
      // eslint-disable-next-line no-restricted-syntax -- RPC 失败时降级为明细拉取（null 触发 fallback）
      return null;
    }
  }

  /**
   * 恢复链路聚合探测：一次 RPC 返回 activeProject + 项目域 + 黑匣子域水位
   */
  async getResumeRecoveryProbe(projectId?: string): Promise<{
    activeProjectId: string | null;
    activeAccessible: boolean;
    activeWatermark: string | null;
    projectsWatermark: string | null;
    blackboxWatermark: string | null;
    serverNow: string | null;
  } | null> {
    if (isBrowserNetworkSuspendedWindow()) {
      // eslint-disable-next-line no-restricted-syntax -- 挂起窗口：静默降级
      return null;
    }
    const client = await this.getSupabaseClient();
    if (!client) return null;

    try {
      return await this.withAuthRetry('getResumeRecoveryProbe', async () => {
        const { data, error } = await client.rpc('get_resume_recovery_probe', {
          p_project_id: projectId ?? null,
        });
        if (error) {
          throw supabaseErrorToError(error);
        }

        const row = Array.isArray(data) ? data[0] : data;
        if (!row || typeof row !== 'object') {
          return null;
        }
        const record = row as Record<string, unknown>;
        return {
          activeProjectId: record['active_project_id'] ? String(record['active_project_id']) : null,
          activeAccessible: Boolean(record['active_accessible']),
          activeWatermark: record['active_watermark'] ? String(record['active_watermark']) : null,
          projectsWatermark: record['projects_watermark'] ? String(record['projects_watermark']) : null,
          blackboxWatermark: record['blackbox_watermark'] ? String(record['blackbox_watermark']) : null,
          serverNow: record['server_now'] ? String(record['server_now']) : null,
        };
      });
    } catch (e) {
      if (isBrowserNetworkSuspendedError(e) || isBrowserNetworkSuspendedWindow()) {
        // eslint-disable-next-line no-restricted-syntax -- 挂起窗口：静默降级
        return null;
      }
      this.logger.warn('恢复链路聚合探测失败，降级为分步探测', {
        projectId,
        error: supabaseErrorToError(e).message
      });
      // eslint-disable-next-line no-restricted-syntax -- 聚合 RPC 失败时降级为分步探测（null 触发调用方 fallback）
      return null;
    }
  }
  
  /**
   * 拉取任务（带限流和 tombstone 处理）
   */
  private async pullTasksThrottled(projectId: string, client: SupabaseClient): Promise<Task[]> {
    this.sentryLazyLoader.addBreadcrumb({
      category: 'sync',
      message: 'Loading tasks with tombstones',
      level: 'info',
      data: { projectId }
    });
    
    const tasksResult = await this.throttle.execute(
      `tasks-data:${projectId}`,
      async () => {
        const loadTasks = async () => await client
          .from('tasks')
          .select(getCompatibleTaskSelectFields(FIELD_SELECT_CONFIG.TASK_LIST_FIELDS))
          .eq('project_id', projectId);

        let result = await loadTasks();
        if (result.error && markTaskCompletedAtColumnUnavailable(result.error)) {
          this.logger.warn('tasks.completed_at 缺失，已降级为旧 schema 任务字段', {
            projectId,
            error: result.error,
          });
          result = await loadTasks();
        }

        return result;
      },
      { 
        deduplicate: true,
        timeout: REQUEST_THROTTLE_CONFIG.BATCH_SYNC_TIMEOUT 
      }
    );
    
    const tombstonesResult = await this.tombstoneService.getTombstonesWithCache(projectId, client);
    
    if (tasksResult.error) throw supabaseErrorToError(tasksResult.error);
    
    // 构建远端 tombstone 水位
    const remoteTombstoneTimestamps = new Map<string, number>();
    
    if (!tombstonesResult.error) {
      for (const t of (tombstonesResult.data || [])) {
        if (!t.deleted_at) {
          continue;
        }
        const deletedAt = new Date(t.deleted_at).getTime();
        if (!Number.isNaN(deletedAt)) {
          remoteTombstoneTimestamps.set(t.task_id, deletedAt);
        }
      }
    }

    // 转换任务并标记 tombstone
    const allTasks = ((tasksResult.data || []) as unknown as TaskRow[]).map(row => this.rowToTask(row));
    
    return allTasks.map(task => {
      const remoteDeletedAt = remoteTombstoneTimestamps.get(task.id);
      if (this.tombstoneService.shouldMaterializeTaskDeletion(task.updatedAt, remoteDeletedAt)) {
        return { ...task, deletedAt: task.deletedAt || new Date(remoteDeletedAt!).toISOString() };
      }

      const localDeletedAt = this.tombstoneService.getLocalTombstoneTimestamp(projectId, task.id);
      if (this.tombstoneService.shouldMaterializeTaskDeletion(task.updatedAt, localDeletedAt)) {
        return { ...task, deletedAt: task.deletedAt || new Date(localDeletedAt!).toISOString() };
      }

      if (localDeletedAt !== undefined) {
        this.tombstoneService.clearLocalTombstones(projectId, [task.id]);
      }

      return task;
    });
  }
  
  addLocalTombstones(
    projectId: string,
    taskIds: string[],
    timestampsByTaskId?: Record<string, string | number | null | undefined>,
  ): void {
    this.tombstoneService.addLocalTombstones(projectId, taskIds, timestampsByTaskId);
  }
  
  /**
   * 清除 tombstone 缓存
   */
  invalidateTombstoneCache(projectId: string): void {
    this.tombstoneService.invalidateTombstoneCache(projectId);
  }
  
  // ==================== 离线快照 ====================
  
  /**
   * 保存离线快照
   *
   * 先写 IndexedDB，再保留 localStorage 作为迁移兼容兜底。
   */
  saveOfflineSnapshot(projects: Project[], ownerUserId?: string | null): void {
    void this.persistOfflineSnapshot(projects, ownerUserId);
  }

  async saveOfflineSnapshotAndWait(projects: Project[], ownerUserId?: string | null): Promise<void> {
    await this.persistOfflineSnapshot(projects, ownerUserId);
  }

  private async persistOfflineSnapshot(projects: Project[], ownerUserId?: string | null): Promise<void> {
    if (this.startupPlaceholderState?.isHintOnlyActive()) {
      this.logger.debug('跳过 hint-only 启动占位快照持久化，等待 owner 确认后再写入真实离线快照');
      return;
    }

    const cleanedProjects = projects.map(project => this.normalizeOfflineSnapshotProject(project));

    const snapshotOwnerUserId = ownerUserId
      ?? this.authService?.currentUserId()
      ?? this.authService?.peekPersistedSessionIdentity?.()?.userId
      ?? AUTH_CONFIG.LOCAL_MODE_USER_ID;
    
    const payload = JSON.stringify({
      projects: cleanedProjects,
      version: this.CACHE_VERSION,
      ownerUserId: snapshotOwnerUserId,
      savedAt: new Date().toISOString(),
    });
    
    const sizeKB = Math.round(payload.length / 1024);
    this.logger.debug('离线快照大小', { sizeKB, projectCount: projects.length });
    
    // 快照超过 4MB 时发出 Sentry 警告（接近 localStorage 5MB 上限）
    if (sizeKB > 4096) {
      this.sentryLazyLoader.captureMessage('Offline snapshot exceeds 4MB', {
        level: 'warning',
        tags: { sizeKB: String(sizeKB), projectCount: String(projects.length) }
      });
    }

    // 先同步写 localStorage，再等待 IDB 落盘，避免 owner 改写后的首次恢复读到旧快照。
    this.saveSnapshotToLocalStorage(payload, snapshotOwnerUserId);

    try {
      await this.saveSnapshotToIDB(payload, snapshotOwnerUserId);
    } catch (error) {
      this.logger.warn('离线快照保存失败（IndexedDB）', error);
    }
  }

  private normalizeSnapshotOwnerUserId(ownerUserId?: string | null): string {
    return typeof ownerUserId === 'string' && ownerUserId.length > 0
      ? ownerUserId
      : AUTH_CONFIG.LOCAL_MODE_USER_ID;
  }

  private getOfflineSnapshotStorageKey(ownerUserId: string = AUTH_CONFIG.LOCAL_MODE_USER_ID): string {
    return `${this.OFFLINE_CACHE_KEY}.${ownerUserId}`;
  }

  private getOfflineSnapshotRecordId(ownerUserId: string = AUTH_CONFIG.LOCAL_MODE_USER_ID): string {
    return `${this.LEGACY_OFFLINE_SNAPSHOT_RECORD_ID}:${ownerUserId}`;
  }
  
  /** localStorage 保存快照 */
  private saveSnapshotToLocalStorage(payload: string, ownerUserId: string): void {
    if (typeof localStorage === 'undefined') return;
    try {
      const normalizedOwnerUserId = this.normalizeSnapshotOwnerUserId(ownerUserId);
      localStorage.setItem(this.getOfflineSnapshotStorageKey(normalizedOwnerUserId), payload);
      if (normalizedOwnerUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
        localStorage.removeItem(this.OFFLINE_CACHE_KEY);
      }
    } catch (e) {
      this.logger.warn('离线快照保存失败（localStorage）', e);
    }
  }
  
  /** IndexedDB 保存快照 */
  private async saveSnapshotToIDB(payload: string, ownerUserId: string): Promise<void> {
    const db = await this.openSnapshotDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('snapshots', 'readwrite');
      tx.objectStore('snapshots').put({
        id: this.getOfflineSnapshotRecordId(this.normalizeSnapshotOwnerUserId(ownerUserId)),
        ownerUserId: this.normalizeSnapshotOwnerUserId(ownerUserId),
        data: payload,
      });
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  }

  /** IndexedDB 加载快照 */
  private async loadSnapshotFromIDB(options?: OfflineSnapshotLoadOptions): Promise<string | null> {
    const db = await this.openSnapshotDB();
    const ownerUserId = this.resolveSnapshotVisibleOwnerUserId(options);
    return new Promise((resolve, reject) => {
      const tx = db.transaction('snapshots', 'readonly');
      const store = tx.objectStore('snapshots');
      const scopedReq = store.get(this.getOfflineSnapshotRecordId(ownerUserId));
      scopedReq.onsuccess = () => {
        const scopedPayload = scopedReq.result?.data ?? null;
        if (scopedPayload || ownerUserId !== AUTH_CONFIG.LOCAL_MODE_USER_ID) {
          db.close();
          resolve(scopedPayload);
          return;
        }

        const legacyReq = store.get(this.LEGACY_OFFLINE_SNAPSHOT_RECORD_ID);
        legacyReq.onsuccess = () => {
          db.close();
          resolve(legacyReq.result?.data ?? null);
        };
        legacyReq.onerror = () => {
          db.close();
          reject(legacyReq.error);
        };
      };
      scopedReq.onerror = () => {
        db.close();
        reject(scopedReq.error);
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  }
  
  /** 打开快照 IndexedDB */
  private openSnapshotDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('nanoflow-offline-snapshots', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('snapshots')) {
          db.createObjectStore('snapshots', { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  
  /**
   * 加载离线快照
   * 兼容旧调用方：同步路径仍然只读 localStorage。
   */
  loadOfflineSnapshot(options?: OfflineSnapshotLoadOptions): Project[] | null {
    return this.loadOfflineSnapshotFromLocalStorage(options);
  }

  /**
   * 启动恢复快照加载
   *
   * 优先读取 IndexedDB；如果只有 legacy localStorage 快照，则加载后写回 IDB。
   */
  async loadStartupOfflineSnapshot(options?: OfflineSnapshotLoadOptions): Promise<StartupOfflineSnapshotLoadResult> {
    const startupOptions: OfflineSnapshotLoadOptions = {
      allowOwnerHint: true,
      ...options,
    };

    // 快照 JSON 中可能缺少 ownerUserId（旧版本保存的快照），
    // 但 IDB/localStorage key 本身就是按 userId 分区的，
    // 因此可安全使用查找时的 userId 作为 fallback。
    const resolvedOwnerUserId = this.resolveSnapshotVisibleOwnerUserId(startupOptions);

    const idbPayload = await this.loadSnapshotFromIDB(startupOptions).catch((error) => {
      this.logger.warn('启动快照加载失败（IndexedDB）', error);
      return null;
    });
    const idbSnapshot = idbPayload ? this.parseSnapshotEnvelope(idbPayload) : null;
    const localStoragePayload = this.loadSnapshotFromLocalStorageRaw(startupOptions);
    const localStorageSnapshot = localStoragePayload ? this.parseSnapshotEnvelope(localStoragePayload) : null;

    this.hydrateParsedSnapshotOwner(idbSnapshot, resolvedOwnerUserId);
    this.hydrateParsedSnapshotOwner(localStorageSnapshot, resolvedOwnerUserId);

    const preferredSnapshot = this.pickPreferredStartupSnapshot(
      idbPayload,
      idbSnapshot,
      localStoragePayload,
      localStorageSnapshot,
    );

    const alternateSnapshot = this.pickAlternateStartupSnapshot(
      preferredSnapshot,
      idbPayload,
      idbSnapshot,
      localStoragePayload,
      localStorageSnapshot,
    );

    const selectedSnapshot = this.selectVisibleStartupSnapshot(
      preferredSnapshot,
      alternateSnapshot,
      startupOptions,
    );

    if (selectedSnapshot?.snapshot) {
      if (selectedSnapshot.source === 'idb' && selectedSnapshot.raw) {
        return this.buildStartupSnapshotResult('idb', selectedSnapshot.raw, selectedSnapshot.snapshot, false);
      }

      if (selectedSnapshot.source === 'localStorage' && selectedSnapshot.raw) {
        const migratedLegacy = await this.migrateLegacySnapshotToIDB(
          selectedSnapshot.raw,
          resolvedOwnerUserId
        );
        return this.buildStartupSnapshotResult('localStorage', selectedSnapshot.raw, selectedSnapshot.snapshot, migratedLegacy);
      }
    }

    if (!localStoragePayload) {
      return {
        source: 'none',
        projectCount: 0,
        bytes: 0,
        migratedLegacy: false,
        projects: [],
      };
    }

    return {
      source: 'none',
      projectCount: 0,
      bytes: 0,
      migratedLegacy: false,
      projects: [],
      ownerUserId: null,
    };
  }

  /**
   * 异步加载离线快照（支持 IDB）
   */
  async loadOfflineSnapshotAsync(options?: OfflineSnapshotLoadOptions): Promise<Project[] | null> {
    const snapshot = await this.loadStartupOfflineSnapshot(options);
    return snapshot.projectCount > 0 ? snapshot.projects : null;
  }

  /** 从 localStorage 读取快照原始内容 */
  private loadSnapshotFromLocalStorageRaw(options?: OfflineSnapshotLoadOptions): string | null {
    if (typeof localStorage === 'undefined') return null;
    try {
      const ownerUserId = this.resolveSnapshotVisibleOwnerUserId(options);
      const scopedPayload = localStorage.getItem(this.getOfflineSnapshotStorageKey(ownerUserId));
      if (scopedPayload !== null) {
        return scopedPayload;
      }

      if (ownerUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
        return localStorage.getItem(this.OFFLINE_CACHE_KEY);
      }

      return null;
    } catch (e) {
      this.logger.warn('离线快照加载失败（localStorage）', e);
      // eslint-disable-next-line no-restricted-syntax -- localStorage 访问异常时返回 null 触发上层降级
      return null;
    }
  }

  /** 从 localStorage 加载快照 */
  private loadOfflineSnapshotFromLocalStorage(options?: OfflineSnapshotLoadOptions): Project[] | null {
    const cached = this.loadSnapshotFromLocalStorageRaw(options);
    if (!cached) {
      return null;
    }

    const snapshot = this.parseSnapshotEnvelope(cached);
    if (!snapshot) {
      return null;
    }

    if (!this.isSnapshotVisibleToCurrentOwner(snapshot.ownerUserId, 'sync-load', options)) {
      return null;
    }

    return snapshot.projects;
  }

  private resolveSnapshotVisibleOwnerUserId(options?: OfflineSnapshotLoadOptions): string {
    if (typeof options?.ownerUserId === 'string' && options.ownerUserId.length > 0) {
      return options.ownerUserId;
    }

    const currentOwnerUserId = this.authService?.currentUserId();
    if (typeof currentOwnerUserId === 'string' && currentOwnerUserId.length > 0) {
      return currentOwnerUserId;
    }

    const persistedSessionUserId = this.authService?.peekPersistedSessionIdentity?.()?.userId ?? null;
    if (typeof persistedSessionUserId === 'string' && persistedSessionUserId.length > 0) {
      return persistedSessionUserId;
    }

    if (options?.allowOwnerHint) {
      // owner hint 只用于非 trusted 的占位预填充，不应默认放宽同步读取的可见性边界。
      const persistedOwnerHint = typeof this.authService?.peekPersistedOwnerHint === 'function'
        ? this.authService.peekPersistedOwnerHint()
        : null;
      if (typeof persistedOwnerHint === 'string' && persistedOwnerHint.length > 0) {
        return persistedOwnerHint;
      }
    }

    return AUTH_CONFIG.LOCAL_MODE_USER_ID;
  }

  private isSnapshotVisibleToCurrentOwner(
    ownerUserId: string | null,
    stage: 'sync-load',
    options?: OfflineSnapshotLoadOptions,
  ): boolean {
    const currentOwnerUserId = this.resolveSnapshotVisibleOwnerUserId(options);

    if (!ownerUserId) {
      this.logger.warn('同步快照缺少 owner 元数据，已忽略本次读取', {
        stage,
        currentOwnerUserId,
      });
      return false;
    }

    if (ownerUserId !== currentOwnerUserId) {
      this.logger.warn('同步快照 owner 不匹配，已忽略本次读取', {
        stage,
        snapshotOwnerUserId: ownerUserId,
        currentOwnerUserId,
      });
      return false;
    }

    return true;
  }

  private normalizeOfflineSnapshotProject(project: Project): Project {
    const allTasks = project.tasks || [];
    const activeTaskIds = new Set(
      allTasks
        .filter(task => !task.deletedAt)
        .map(task => task.id)
    );

    return {
      ...project,
      // 软删除任务仍属于回收站保留窗口，离线快照恢复不能把它们误当作已永久销毁。
      tasks: allTasks,
      // 主视图只恢复活跃任务之间的连接，避免 deleted task 在图上重新挂回可见边。
      connections: (project.connections || []).filter(connection =>
        activeTaskIds.has(connection.source) && activeTaskIds.has(connection.target)
      ),
    };
  }

  private parseSnapshotEnvelope(raw: string): ParsedOfflineSnapshotEnvelope | null {
    try {
      const parsed = JSON.parse(raw) as { projects?: Project[]; ownerUserId?: unknown; savedAt?: unknown };
      if (Array.isArray(parsed?.projects)) {
        return {
          projects: parsed.projects.map((project: Project) => this.normalizeOfflineSnapshotProject(project)),
          ownerUserId: typeof parsed.ownerUserId === 'string' && parsed.ownerUserId.trim().length > 0
            ? parsed.ownerUserId
            : null,
          savedAt: typeof parsed.savedAt === 'string' && parsed.savedAt.trim().length > 0
            ? parsed.savedAt
            : null,
        };
      }
    } catch (e) {
      this.logger.warn('快照数据解析失败', e);
    }
    return null;
  }

  /** 解析快照 JSON 数据 */
  private parseSnapshotData(raw: string): Project[] | null {
    return this.parseSnapshotEnvelope(raw)?.projects ?? null;
  }

  private buildStartupSnapshotResult(
    source: StartupOfflineSnapshotSource,
    raw: string,
    snapshot: ParsedOfflineSnapshotEnvelope,
    migratedLegacy: boolean
  ): StartupOfflineSnapshotLoadResult {
    return {
      source,
      projectCount: snapshot.projects.length,
      bytes: this.getSnapshotByteSize(raw),
      migratedLegacy,
      projects: snapshot.projects,
      ownerUserId: snapshot.ownerUserId,
    };
  }

  private getSnapshotByteSize(raw: string): number {
    try {
      return new TextEncoder().encode(raw).byteLength;
    } catch {
      return raw.length;
    }
  }

  private getSnapshotSavedAtTimestamp(snapshot: ParsedOfflineSnapshotEnvelope | null): number {
    if (!snapshot?.savedAt) {
      return 0;
    }

    const timestamp = new Date(snapshot.savedAt).getTime();
    return Number.isNaN(timestamp) ? 0 : timestamp;
  }

  private hydrateParsedSnapshotOwner(snapshot: ParsedOfflineSnapshotEnvelope | null, resolvedOwnerUserId: string): void {
    if (snapshot && !snapshot.ownerUserId && resolvedOwnerUserId) {
      snapshot.ownerUserId = resolvedOwnerUserId;
    }
  }

  private pickPreferredStartupSnapshot(
    idbRaw: string | null,
    idbSnapshot: ParsedOfflineSnapshotEnvelope | null,
    localStorageRaw: string | null,
    localStorageSnapshot: ParsedOfflineSnapshotEnvelope | null,
  ): { source: 'idb' | 'localStorage'; raw: string; snapshot: ParsedOfflineSnapshotEnvelope } | null {
    if (idbSnapshot && localStorageSnapshot && idbRaw && localStorageRaw) {
      const idbSavedAt = this.getSnapshotSavedAtTimestamp(idbSnapshot);
      const localStorageSavedAt = this.getSnapshotSavedAtTimestamp(localStorageSnapshot);

      if (localStorageSavedAt > idbSavedAt) {
        return {
          source: 'localStorage',
          raw: localStorageRaw,
          snapshot: localStorageSnapshot,
        };
      }

      return {
        source: 'idb',
        raw: idbRaw,
        snapshot: idbSnapshot,
      };
    }

    if (idbSnapshot && idbRaw) {
      return {
        source: 'idb',
        raw: idbRaw,
        snapshot: idbSnapshot,
      };
    }

    if (localStorageSnapshot && localStorageRaw) {
      return {
        source: 'localStorage',
        raw: localStorageRaw,
        snapshot: localStorageSnapshot,
      };
    }

    return null;
  }

  private pickAlternateStartupSnapshot(
    preferredSnapshot: { source: 'idb' | 'localStorage'; raw: string; snapshot: ParsedOfflineSnapshotEnvelope } | null,
    idbRaw: string | null,
    idbSnapshot: ParsedOfflineSnapshotEnvelope | null,
    localStorageRaw: string | null,
    localStorageSnapshot: ParsedOfflineSnapshotEnvelope | null,
  ): { source: 'idb' | 'localStorage'; raw: string; snapshot: ParsedOfflineSnapshotEnvelope } | null {
    if (!preferredSnapshot) {
      return null;
    }

    if (preferredSnapshot.source === 'idb' && localStorageRaw && localStorageSnapshot) {
      return {
        source: 'localStorage',
        raw: localStorageRaw,
        snapshot: localStorageSnapshot,
      };
    }

    if (preferredSnapshot.source === 'localStorage' && idbRaw && idbSnapshot) {
      return {
        source: 'idb',
        raw: idbRaw,
        snapshot: idbSnapshot,
      };
    }

    return null;
  }

  private selectVisibleStartupSnapshot(
    preferredSnapshot: { source: 'idb' | 'localStorage'; raw: string; snapshot: ParsedOfflineSnapshotEnvelope } | null,
    alternateSnapshot: { source: 'idb' | 'localStorage'; raw: string; snapshot: ParsedOfflineSnapshotEnvelope } | null,
    options?: OfflineSnapshotLoadOptions,
  ): { source: 'idb' | 'localStorage'; raw: string; snapshot: ParsedOfflineSnapshotEnvelope } | null {
    if (
      preferredSnapshot
      && this.isSnapshotVisibleToCurrentOwner(preferredSnapshot.snapshot.ownerUserId, 'sync-load', options)
    ) {
      return preferredSnapshot;
    }

    if (
      alternateSnapshot
      && this.isSnapshotVisibleToCurrentOwner(alternateSnapshot.snapshot.ownerUserId, 'sync-load', options)
    ) {
      return alternateSnapshot;
    }

    return null;
  }

  private async migrateLegacySnapshotToIDB(payload: string, ownerUserId: string): Promise<boolean> {
    try {
      await this.saveSnapshotToIDB(payload, ownerUserId);
      return true;
    } catch (error) {
      this.logger.warn('legacy 离线快照迁移到 IndexedDB 失败', error);
      return false;
    }
  }
  
  /**
   * 清除离线快照
   */
  clearOfflineSnapshot(ownerUserId?: string | null): void {
    const resolvedOwnerUserId = this.normalizeSnapshotOwnerUserId(
      ownerUserId ?? this.authService?.currentUserId()
    );
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(this.getOfflineSnapshotStorageKey(resolvedOwnerUserId));
        if (resolvedOwnerUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
          localStorage.removeItem(this.OFFLINE_CACHE_KEY);
        }
      }
      this.logger.info('离线快照已清除', { ownerUserId: resolvedOwnerUserId });
    } catch (e) {
      this.logger.warn('清除离线快照失败', e);
    }

    void this.clearSnapshotFromIDB(resolvedOwnerUserId).catch((error) => {
      this.logger.warn('清除离线快照失败（IndexedDB）', error);
    });
  }

  private async clearSnapshotFromIDB(ownerUserId: string): Promise<void> {
    const db = await this.openSnapshotDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('snapshots', 'readwrite');
      const store = tx.objectStore('snapshots');
      store.delete(this.getOfflineSnapshotRecordId(ownerUserId));
      if (ownerUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
        store.delete(this.LEGACY_OFFLINE_SNAPSHOT_RECORD_ID);
      }
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  }

  // ==================== 停泊任务轻量缓存与增量拉取 ====================

  /**
   * 从 IndexedDB 读取停泊任务轻量缓存与同步游标
   */
  async loadParkedTasksCache(): Promise<ParkedTaskCacheSnapshot> {
    if (typeof indexedDB === 'undefined') {
      return { entries: [], cursor: null };
    }

    try {
      const db = await this.openFocusModeDB();
      return await new Promise<ParkedTaskCacheSnapshot>((resolve, reject) => {
        const tx = db.transaction(
          [FOCUS_CONFIG.IDB_STORES.PARKED_TASKS, FOCUS_CONFIG.IDB_STORES.SYNC_METADATA],
          'readonly'
        );

        const parkedStore = tx.objectStore(FOCUS_CONFIG.IDB_STORES.PARKED_TASKS);
        const metaStore = tx.objectStore(FOCUS_CONFIG.IDB_STORES.SYNC_METADATA);

        const parkedReq = parkedStore.getAll();
        const cursorReq = metaStore.get(this.PARKING_SYNC_CURSOR_KEY);

        tx.oncomplete = () => {
          const rows = Array.isArray(parkedReq.result) ? parkedReq.result : [];
          const entries: ParkedTaskEntry[] = rows
            .filter((row): row is ParkedTaskCacheRecord =>
              !!row &&
              typeof row === 'object' &&
              'taskId' in row &&
              'projectId' in row &&
              'task' in row
            )
            .map((row) => ({
              task: row.task,
              projectId: row.projectId,
            }));

          const cursor = cursorReq.result?.value
            ? String(cursorReq.result.value)
            : null;

          resolve({ entries, cursor });
        };

        tx.onerror = () => reject(tx.error);
      });
    } catch (error) {
      this.logger.warn('读取停泊任务缓存失败，降级为空缓存', { error });
      return { entries: [], cursor: null };
    }
  }

  /**
   * 保存停泊任务轻量缓存与同步游标
   */
  async saveParkedTasksCache(snapshot: ParkedTaskCacheSnapshot): Promise<void> {
    if (typeof indexedDB === 'undefined') return;

    try {
      const db = await this.openFocusModeDB();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(
          [FOCUS_CONFIG.IDB_STORES.PARKED_TASKS, FOCUS_CONFIG.IDB_STORES.SYNC_METADATA],
          'readwrite'
        );
        const parkedStore = tx.objectStore(FOCUS_CONFIG.IDB_STORES.PARKED_TASKS);
        const metaStore = tx.objectStore(FOCUS_CONFIG.IDB_STORES.SYNC_METADATA);

        parkedStore.clear();
        for (const entry of snapshot.entries) {
          const updatedAt = entry.task.updatedAt ?? new Date().toISOString();
          parkedStore.put({
            taskId: entry.task.id,
            projectId: entry.projectId,
            task: entry.task,
            updatedAt,
          } as ParkedTaskCacheRecord);
        }
        metaStore.put({
          key: this.PARKING_SYNC_CURSOR_KEY,
          value: snapshot.cursor ?? null,
        });

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (error) {
      this.logger.warn('保存停泊任务缓存失败（不阻断主流程）', { error });
    }
  }

  /**
   * 轻量增量拉取停泊任务（仅 parking_meta 非空任务）
   *
   * 返回：
   * - entries: 新增/更新的停泊任务
   * - removedTaskIds: 已从停泊状态移除的任务 ID（由已知停泊任务集合推导）
   * - nextCursor: 下一次增量拉取游标
   */
  async pullParkedTasksDelta(
    since: string | null,
    knownParkedTaskIds: string[]
  ): Promise<ParkedTaskDeltaResult> {
    if (isBrowserNetworkSuspendedWindow()) {
      this.logger.debug('浏览器网络挂起窗口内跳过停泊任务增量拉取', { since });
      return { entries: [], removedTaskIds: [], nextCursor: since };
    }

    const client = await this.getSupabaseClient();
    if (!client) {
      return { entries: [], removedTaskIds: [], nextCursor: since };
    }

    const updatedRows: ParkedTaskDeltaRow[] = [];
    const entryMap = new Map<string, ParkedTaskEntry>();
    const removedTaskIds = new Set<string>();

    try {
      return await this.withAuthRetry('pullParkedTasksDelta', async () => {
        const selectFields = getCompatibleTaskSelectFields(`project_id,${FIELD_SELECT_CONFIG.TASK_LIST_FIELDS}`);
        const loadParkedRows = async () => {
          let parkedQuery = client
            .from('tasks')
            .select(selectFields)
            .not('parking_meta', 'is', null);

          if (since) {
            parkedQuery = parkedQuery.gt('updated_at', since);
          }

          return await parkedQuery;
        };

        let parkedResult = await loadParkedRows();
        if (parkedResult.error && markTaskCompletedAtColumnUnavailable(parkedResult.error)) {
          this.logger.warn('tasks.completed_at 缺失，停泊任务增量拉取已降级为旧 schema 字段', {
            since,
            error: parkedResult.error,
          });
          parkedResult = await loadParkedRows();
        }

        if (parkedResult.error) {
          throw supabaseErrorToError(parkedResult.error);
        }

        for (const rawRow of (parkedResult.data ?? []) as ParkedTaskDeltaRow[]) {
          const projectId = rawRow.project_id ? String(rawRow.project_id) : '';
          if (!projectId || !rawRow.id) continue;
          const task = this.rowToTask(rawRow);
          entryMap.set(task.id, { task, projectId });
          updatedRows.push(rawRow);
        }

        // 仅对“已知停泊任务”做增量核验，找出已移出停泊的任务
        if (since && knownParkedTaskIds.length > 0) {
          for (const chunk of this.chunkTaskIds(knownParkedTaskIds, 100)) {
            const { data: changedRows, error: changedError } = await client
              .from('tasks')
              .select(selectFields)
              .in('id', chunk)
              .gt('updated_at', since);

            if (changedError) {
              throw supabaseErrorToError(changedError);
            }

            for (const rawRow of (changedRows ?? []) as ParkedTaskDeltaRow[]) {
              updatedRows.push(rawRow);
              if (!rawRow.id) continue;

              const isParked = (rawRow as { parking_meta?: unknown }).parking_meta !== null
                && (rawRow as { parking_meta?: unknown }).parking_meta !== undefined;
              if (!isParked) {
                removedTaskIds.add(String(rawRow.id));
                entryMap.delete(String(rawRow.id));
                continue;
              }

              const projectId = rawRow.project_id ? String(rawRow.project_id) : '';
              if (!projectId) continue;
              const task = this.rowToTask(rawRow);
              entryMap.set(task.id, { task, projectId });
            }
          }
        }

        const nextCursor = this.computeParkedCursor(since, updatedRows);
        return {
          entries: Array.from(entryMap.values()),
          removedTaskIds: Array.from(removedTaskIds),
          nextCursor,
        };
      });
    } catch (error) {
      if (isBrowserNetworkSuspendedError(error)) {
        this.logger.debug('浏览器网络挂起期间已跳过停泊任务增量拉取', { since });
        return { entries: [], removedTaskIds: [], nextCursor: since };
      }

      this.logger.warn('增量拉取停泊任务失败，保持现有缓存', { error, since });
      return { entries: [], removedTaskIds: [], nextCursor: since };
    }
  }

  private computeParkedCursor(since: string | null, rows: ParkedTaskDeltaRow[]): string | null {
    let maxTs = since ? Date.parse(since) : 0;
    for (const row of rows) {
      if (!row.updated_at) continue;
      const ts = Date.parse(String(row.updated_at));
      if (!Number.isNaN(ts)) {
        maxTs = Math.max(maxTs, ts);
      }
    }
    if (!maxTs) return since;
    return new Date(maxTs).toISOString();
  }

  private chunkTaskIds(taskIds: string[], size: number): string[][] {
    if (taskIds.length <= size) return [taskIds];
    const chunks: string[][] = [];
    for (let i = 0; i < taskIds.length; i += size) {
      chunks.push(taskIds.slice(i, i + size));
    }
    return chunks;
  }

  private async openFocusModeDB(): Promise<IDBDatabase> {
    return openIndexedDBAdaptive({
      dbName: FOCUS_CONFIG.SYNC.IDB_NAME,
      targetVersion: FOCUS_CONFIG.SYNC.IDB_VERSION,
      requiredStores: [
        FOCUS_CONFIG.IDB_STORES.PARKED_TASKS,
        FOCUS_CONFIG.IDB_STORES.SYNC_METADATA,
      ],
      ensureStores: db => {
        if (!db.objectStoreNames.contains(FOCUS_CONFIG.IDB_STORES.PARKED_TASKS)) {
          const parkedStore = db.createObjectStore(FOCUS_CONFIG.IDB_STORES.PARKED_TASKS, { keyPath: 'taskId' });
          parkedStore.createIndex('by-updatedAt', 'updatedAt', { unique: false });
        }
        if (!db.objectStoreNames.contains(FOCUS_CONFIG.IDB_STORES.SYNC_METADATA)) {
          db.createObjectStore(FOCUS_CONFIG.IDB_STORES.SYNC_METADATA, { keyPath: 'key' });
        }
      }
    });
  }
  
  // ==================== 数据转换（Public API）====================
  
  /**
   * 数据库行转换为 Project 模型
   */
  rowToProject(row: ProjectRow | Partial<ProjectRow>): Project {
    return {
      id: row.id || '',
      name: row.title || '',
      description: row.description || '',
      createdDate: row.created_date || '',
      updatedAt: row.updated_at || undefined,
      deletedAt: row.deleted_at || undefined,
      version: row.version || 1,
      syncSource: 'synced',
      pendingSync: false,
      tasks: [],
      connections: []
    };
  }
  
  /**
   * 数据库行转换为 Task 模型
   * 【P0 防护】检测 content 字段是否缺失
   */
  rowToTask(row: TaskRow | Partial<TaskRow>): Task {
    // 【P0 防护】检测 content 字段是否缺失
    if (!('content' in row)) {
      this.logger.warn('rowToTask: content 字段缺失，可能导致数据丢失！', { 
        taskId: row.id,
        hasTitle: 'title' in row,
        hasStage: 'stage' in row
      });
      
      // 【Sentry 监控】采样率 10% 上报
      const isDev = typeof window !== 'undefined' && window.location?.hostname === 'localhost';
      if (isDev || Math.random() < 0.1) {
        this.sentryLazyLoader.captureMessage('Sync Warning: Task content field missing', {
          level: 'warning',
          tags: { operation: 'rowToTask', taskId: row.id || 'unknown' },
          extra: { rowKeys: Object.keys(row) }
        });
      }
    }
    
    return {
      id: row.id || '',
      title: row.title || '',
      content: row.content ?? '',
      stage: row.stage ?? null,
      parentId: row.parent_id ?? null,
      order: row.order || 0,
      rank: row.rank || 0,
      status: (row.status as 'active' | 'completed' | 'archived') || 'active',
      x: row.x || 0,
      y: row.y || 0,
      createdDate: row.created_at || '',
      updatedAt: row.updated_at,
      completedAt: row.completed_at ?? null,
      displayId: '',
      shortId: row.short_id || undefined,
      deletedAt: row.deleted_at || undefined,
      // 【修复】同步层必须映射所有持久化字段，防止增量同步覆盖丢失
      attachments: (row.attachments as unknown as import('../../../../models').Attachment[]) ?? [],
      tags: (row.tags as unknown as string[]) ?? [],
      priority: (row.priority as 'low' | 'medium' | 'high' | 'urgent') ?? undefined,
      dueDate: row.due_date ?? undefined,
      expected_minutes: row.expected_minutes ?? null,
      cognitive_load: row.cognitive_load ?? null,
      wait_minutes: row.wait_minutes ?? null,
      // State Overlap 停泊元数据
      parkingMeta: (row as { parking_meta?: unknown }).parking_meta as import('../../../../models/parking').TaskParkingMeta | undefined ?? undefined,
    };
  }
  
  /**
   * 数据库行转换为 Connection 模型
   */
  rowToConnection(row: ConnectionRow | Partial<ConnectionRow>): Connection {
    return {
      id: row.id || '',
      source: row.source_id || '',
      target: row.target_id || '',
      title: row.title || undefined,
      description: row.description || undefined,
      deletedAt: row.deleted_at || undefined,
      updatedAt: row.updated_at || undefined
    };
  }
}
