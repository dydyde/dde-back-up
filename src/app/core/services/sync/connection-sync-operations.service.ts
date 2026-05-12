/**
 * ConnectionSyncOperationsService - 连接同步操作服务
 * 
 * 职责：
 * - 推送连接到云端（pushConnection）
 * - 连接 Tombstone 管理
 * - 连接验证（任务存在性检查）
 * 
 * 从 SimpleSyncService 提取，作为技术债务修复的一部分
 * 目标：将 SimpleSyncService 从 3499 行减少到 ≤800 行
 */

import { Injectable, inject } from '@angular/core';
import { SupabaseClientService } from '../../../../services/supabase-client.service';
import { LoggerService } from '../../../../services/logger.service';
import { ToastService } from '../../../../services/toast.service';
import { RequestThrottleService } from '../../../../services/request-throttle.service';
import { ProjectStateService } from '../../../../services/project-state.service';
import { ClockSyncService } from '../../../../services/clock-sync.service';
import { SyncOperationHelperService } from './sync-operation-helper.service';
import { SessionManagerService } from './session-manager.service';
import { RetryQueueService } from './retry-queue.service';
import { SyncStateService } from './sync-state.service';
import { Connection, Project } from '../../../../models';
import {
  supabaseErrorToError,
  EnhancedError,
  classifySupabaseClientFailure
} from '../../../../utils/supabase-error';
import { supabaseWithRetry } from '../../../../utils/timeout';
import { isPermanentFailureError, PermanentFailureError } from '../../../../utils/permanent-failure-error';
import { REQUEST_THROTTLE_CONFIG } from '../../../../config';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import { SyncRpcClientService, type SyncRpcResult } from '../../../../services/sync-rpc-client.service';
import { TombstoneService } from './tombstone.service';
import {
  createBrowserNetworkSuspendedError,
  isBrowserNetworkSuspendedError,
  isBrowserNetworkSuspendedWindow,
} from '../../../../utils/browser-network-suspension';

type TaskValidationFailureReason = 'missing-task' | 'query-error' | 'permission-denied';

type TaskValidationResult =
  | { valid: true }
  | {
      valid: false;
      shouldRetry: boolean;
      reason: TaskValidationFailureReason;
      error?: EnhancedError;
      sourceExists?: boolean;
      targetExists?: boolean;
    };

type ConnectionTombstoneCheckResult =
  | { ok: true; tombstoneFound: boolean }
  | { ok: false; shouldRetry: boolean; error: EnhancedError };

interface EndpointConnectionMatch {
  id: string;
  deleted_at: string | null;
  updated_at?: string | null;
  title?: string | null;
  description?: string | null;
}

@Injectable({
  providedIn: 'root'
})
export class ConnectionSyncOperationsService {
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly supabase = inject(SupabaseClientService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('ConnectionSyncOps');
  private readonly toast = inject(ToastService);
  private readonly throttle = inject(RequestThrottleService);
  private readonly projectState = inject(ProjectStateService);
  private readonly clockSync = inject(ClockSyncService);
  private readonly syncOpHelper = inject(SyncOperationHelperService);
  private readonly sessionManager = inject(SessionManagerService);
  private readonly retryQueueService = inject(RetryQueueService);
  private readonly syncStateService = inject(SyncStateService);
  private readonly tombstoneService = inject(TombstoneService);
  private readonly syncRpcClient = inject(SyncRpcClientService, { optional: true });

  private updateProjectsFromCurrentData(mutator: (projects: Project[]) => Project[]): void {
    const projectState = this.projectState as ProjectStateService & {
      getProjectsWithCurrentData?: () => Project[];
      setProjects?: (projects: Project[]) => void;
    };

    if (typeof projectState.getProjectsWithCurrentData === 'function' && typeof projectState.setProjects === 'function') {
      projectState.setProjects(mutator(projectState.getProjectsWithCurrentData()));
      return;
    }

    this.projectState.updateProjects(mutator);
  }

  private normalizeLocalConnectionUpdatedAt(projectId: string, connection: Connection, serverUpdatedAt?: string | null): void {
    if (!serverUpdatedAt) {
      return;
    }

    connection.updatedAt = serverUpdatedAt;
    const connectionId = connection.id;

    this.updateProjectsFromCurrentData(projects => projects.map(project => {
      if (project.id !== projectId) {
        return project;
      }

      let changed = false;
      const connections = (project.connections || []).map(connection => {
        if (connection.id !== connectionId || connection.updatedAt === serverUpdatedAt) {
          return connection;
        }

        changed = true;
        return {
          ...connection,
          updatedAt: serverUpdatedAt,
        };
      });

      return changed
        ? {
            ...project,
            connections,
          }
        : project;
    }));
  }

  private createRemoteNewerConflictError(
    connectionId: string,
    projectId: string,
    remoteUpdatedAt: string | null,
    reason: 'remote-newer' | 'remote-tombstone',
  ): EnhancedError {
    return Object.assign(
      new Error('版本冲突：数据已被修改，请刷新后重试'),
      {
        name: 'VersionConflictError',
        errorType: 'VersionConflictError',
        code: reason === 'remote-tombstone' ? 'CONNECTION_REMOTE_TOMBSTONE_NEWER' : 'CONNECTION_REMOTE_NEWER',
        isRetryable: false,
        details: `connectionId=${connectionId}, projectId=${projectId}, remoteUpdatedAt=${remoteUpdatedAt ?? 'unknown'}`,
      },
    ) as EnhancedError;
  }

  private createClockUncertainError(
    connectionId: string,
    projectId: string,
    localUpdatedAt: string | null,
    remoteUpdatedAt: string | null,
  ): EnhancedError {
    return Object.assign(
      new Error('无法确认本地时间基线，已延后同步以避免覆盖远端更新'),
      {
        name: 'ClockSyncUncertainError',
        errorType: 'ClockSyncUncertainError',
        code: 'CONNECTION_CLOCK_SYNC_UNCERTAIN',
        isRetryable: true,
        details: `connectionId=${connectionId}, projectId=${projectId}, localUpdatedAt=${localUpdatedAt ?? 'unknown'}, remoteUpdatedAt=${remoteUpdatedAt ?? 'unknown'}`,
      },
    ) as EnhancedError;
  }

  private async loadRemoteConnectionFreshness(
    client: SupabaseClient,
    connectionId: string,
    projectId: string,
  ): Promise<Pick<EndpointConnectionMatch, 'id' | 'updated_at' | 'deleted_at'> | null> {
    const { data, error } = await client
      .from('connections')
      .select('id,updated_at,deleted_at')
      .eq('id', connectionId)
      .eq('project_id', projectId)
      .maybeSingle();

    if (error) {
      throw supabaseErrorToError(error);
    }

    if (!data) {
      return null;
    }

    const row = data as { id: string; updated_at?: string | null; deleted_at?: string | null };
    return {
      id: row.id,
      updated_at: typeof row.updated_at === 'string' ? row.updated_at : null,
      deleted_at: typeof row.deleted_at === 'string' ? row.deleted_at : null,
    };
  }

  private applyCanonicalConnectionPatchToLocalStore(
    projectId: string,
    connectionId: string,
    canonicalMatch: EndpointConnectionMatch,
  ): void {
    this.updateProjectsFromCurrentData(projects => projects.map(project => {
      if (project.id !== projectId) {
        return project;
      }

      let changed = false;
      const connections = (project.connections || []).map(connection => {
        if (connection.id !== connectionId) {
          return connection;
        }

        changed = true;
        return {
          ...connection,
          title: Object.prototype.hasOwnProperty.call(canonicalMatch, 'title')
            ? canonicalMatch.title ?? undefined
            : connection.title,
          description: Object.prototype.hasOwnProperty.call(canonicalMatch, 'description')
            ? canonicalMatch.description ?? undefined
            : connection.description,
          deletedAt: canonicalMatch.deleted_at ?? undefined,
          updatedAt: canonicalMatch.updated_at ?? connection.updatedAt,
        };
      });

      return changed
        ? {
            ...project,
            connections,
          }
        : project;
    }));
  }

  private rebindLocalConnectionIdentity(projectId: string, previousId: string, nextId: string): {
    connection: Connection | null;
    previousFound: boolean;
  } {
    if (!previousId || !nextId || previousId === nextId) {
      return { connection: null, previousFound: false };
    }

    let reboundConnection: Connection | null = null;
    let previousFound = false;

    this.updateProjectsFromCurrentData(projects => projects.map(project => {
      if (project.id !== projectId) {
        return project;
      }

      const previousConnection = (project.connections || []).find(connection => connection.id === previousId);
      const nextConnection = (project.connections || []).find(connection => connection.id === nextId);

      if (!previousConnection) {
        reboundConnection = nextConnection ?? null;
        return project;
      }
      previousFound = true;
      const previousFreshness = this.getConnectionFreshnessTimestamp(
        previousConnection.updatedAt,
        previousConnection.deletedAt,
      );
      const nextFreshness = this.getConnectionFreshnessTimestamp(
        nextConnection?.updatedAt,
        nextConnection?.deletedAt,
      );
      const preferredLocalConnection = nextConnection && nextFreshness >= previousFreshness
        ? nextConnection
        : previousConnection;
      const fallbackLocalConnection = preferredLocalConnection === previousConnection
        ? nextConnection
        : previousConnection;
      const mergedConnection = nextConnection
        ? {
            ...nextConnection,
            ...previousConnection,
            id: nextId,
            source: previousConnection.source,
            target: previousConnection.target,
            title: preferredLocalConnection.title ?? fallbackLocalConnection?.title,
            description: preferredLocalConnection.description ?? fallbackLocalConnection?.description,
            deletedAt: preferredLocalConnection.deletedAt,
            updatedAt: preferredLocalConnection.updatedAt ?? fallbackLocalConnection?.updatedAt,
          }
        : {
            ...previousConnection,
            id: nextId,
          };
      reboundConnection = mergedConnection;

      const connections = (project.connections || []).filter(connection => (
        connection.id !== previousId && connection.id !== nextId
      ));
      connections.push(mergedConnection);

      return {
        ...project,
        connections,
      };
    }));

    return {
      connection: reboundConnection,
      previousFound,
    };
  }

  private buildConnectionUpsertPayload(connection: Connection, projectId: string): {
    id: string;
    project_id: string;
    source_id: string;
    target_id: string;
    title: string | null;
    description: string | null;
    deleted_at: string | null;
  } {
    return {
      id: connection.id,
      project_id: projectId,
      source_id: connection.source,
      target_id: connection.target,
      title: connection.title || null,
      description: connection.description || null,
      deleted_at: connection.deletedAt || null,
    };
  }

  private async upsertConnectionReturningUpdatedAt(
    client: SupabaseClient,
    connection: Connection,
    projectId: string,
    remoteConnection: Pick<EndpointConnectionMatch, 'updated_at' | 'deleted_at'> | null,
  ): Promise<string | null> {
    if (remoteConnection?.updated_at) {
      const { data, error } = await client
        .from('connections')
        .update(this.buildConnectionUpsertPayload(connection, projectId))
        .eq('id', connection.id)
        .eq('project_id', projectId)
        .eq('updated_at', remoteConnection.updated_at)
        .select('updated_at')
        .maybeSingle();

      if (error) {
        throw supabaseErrorToError(error);
      }

      if (!data) {
        throw this.createRemoteNewerConflictError(
          connection.id,
          projectId,
          remoteConnection.updated_at,
          'remote-newer',
        );
      }

      const updatedAt = (data as { updated_at?: string | null } | null)?.updated_at;
      return typeof updatedAt === 'string' ? updatedAt : null;
    }

    if (remoteConnection) {
      throw this.createRemoteNewerConflictError(
        connection.id,
        projectId,
        remoteConnection.deleted_at ?? null,
        'remote-newer',
      );
    }

    const { data, error } = await client
      .from('connections')
      .insert(this.buildConnectionUpsertPayload(connection, projectId))
      .select('updated_at')
      .maybeSingle();

    if (error) {
      throw supabaseErrorToError(error);
    }

    if (!data) {
      throw this.createRemoteNewerConflictError(
        connection.id,
        projectId,
        connection.updatedAt ?? null,
        'remote-newer',
      );
    }

    const updatedAt = (data as { updated_at?: string | null } | null)?.updated_at;
    return typeof updatedAt === 'string' ? updatedAt : null;
  }

  private pickNewestDeletedEndpointMatch(matches: EndpointConnectionMatch[]): EndpointConnectionMatch | null {
    const deletedMatches = matches.filter(match => !!match.deleted_at);
    if (deletedMatches.length === 0) {
      return null;
    }

    const toTimestamp = (value?: string | null): number => {
      if (!value) {
        return 0;
      }

      const timestamp = new Date(value).getTime();
      return Number.isNaN(timestamp) ? 0 : timestamp;
    };

    return deletedMatches.reduce((latest, current) => {
      const latestTimestamp = Math.max(toTimestamp(latest.updated_at), toTimestamp(latest.deleted_at));
      const currentTimestamp = Math.max(toTimestamp(current.updated_at), toTimestamp(current.deleted_at));
      return currentTimestamp >= latestTimestamp ? current : latest;
    });
  }

  private getConnectionFreshnessTimestamp(updatedAt?: string | null, deletedAt?: string | null): number {
    const toTimestamp = (value?: string | null): number => {
      if (!value) {
        return 0;
      }

      const timestamp = new Date(value).getTime();
      return Number.isNaN(timestamp) ? 0 : timestamp;
    };

    return Math.max(toTimestamp(updatedAt), toTimestamp(deletedAt));
  }

  private async lookupCanonicalEndpointMatch(
    client: SupabaseClient,
    projectId: string,
    connection: Connection,
  ): Promise<EndpointConnectionMatch | null> {
    // 【根因修复 2026-04-20】canonical-match 查询是 upsert 前的「软优化」：
    //   命中 → 复用远端已存在的 id，避免创建重复行；
    //   未命中 → 走普通 upsert，DB 层的复合唯一约束
    //   `connections_project_id_source_id_target_id` 会在真的重复时抛 23505，
    //   由上层 (line 712+) 捕获并 rebind。
    // 因此当 Supabase edge 瞬时 5xx 导致 fetch 抛出（常见为 502 + 缺失 CORS 头，
    // 浏览器升级为 "CORS blocked" 错误）时，我们不应让异常上抛毁掉整次 upsert；
    // 应该降级为「未找到匹配」让 upsert 携 ON CONFLICT 兜底，真有冲突走 23505 分支。
    // 这样即使在 Supabase 边缘抖动期间，同步也能自愈而不在 UI 弹 "部分同步失败"。
    let data: EndpointConnectionMatch[] | null = null;
    try {
      const response = await client
        .from('connections')
        .select('id,deleted_at,updated_at,title,description')
        .eq('project_id', projectId)
        .eq('source_id', connection.source)
        .eq('target_id', connection.target);

      if (response.error) {
        return null;
      }
      data = response.data as EndpointConnectionMatch[] | null;
    } catch {
       return null; // eslint-disable-line no-restricted-syntax -- 网络/CORS 抛错降级为「未匹配」，交由 upsert ON CONFLICT 兜底
    }

    if (!Array.isArray(data) || data.length === 0) {
      return null;
    }

    const activeMatch = data.find(match => !match.deleted_at) ?? null;
    return activeMatch ?? this.pickNewestDeletedEndpointMatch(data);
  }

  private hydrateConnectionFromCanonicalMatch(
    connection: Connection,
    canonicalMatch: EndpointConnectionMatch,
    fallbackConnection?: Connection | null,
  ): void {
    connection.title = Object.prototype.hasOwnProperty.call(canonicalMatch, 'title')
      ? canonicalMatch.title ?? undefined
      : fallbackConnection?.title ?? connection.title;
    connection.description = Object.prototype.hasOwnProperty.call(canonicalMatch, 'description')
      ? canonicalMatch.description ?? undefined
      : fallbackConnection?.description ?? connection.description;
    connection.deletedAt = canonicalMatch.deleted_at ?? undefined;
    connection.updatedAt = canonicalMatch.updated_at ?? fallbackConnection?.updatedAt ?? connection.updatedAt;
  }

  private applyCanonicalConnectionIdentity(
    projectId: string,
    connection: Connection,
    canonicalMatch: EndpointConnectionMatch,
  ): void {
    if (!canonicalMatch.id || canonicalMatch.id === connection.id) {
      return;
    }

    const previousConnectionId = connection.id;
    const reboundResult = this.rebindLocalConnectionIdentity(projectId, previousConnectionId, canonicalMatch.id);
    connection.id = canonicalMatch.id;
    if (reboundResult.connection) {
      connection.source = reboundResult.connection.source;
      connection.target = reboundResult.connection.target;

      const localFreshness = this.getConnectionFreshnessTimestamp(
        reboundResult.connection.updatedAt,
        reboundResult.connection.deletedAt,
      );
      const canonicalFreshness = this.getConnectionFreshnessTimestamp(
        canonicalMatch.updated_at,
        canonicalMatch.deleted_at,
      );
      const serverCanonicalIsNewer = canonicalFreshness >= localFreshness && canonicalFreshness > 0;

      if (serverCanonicalIsNewer) {
        this.hydrateConnectionFromCanonicalMatch(connection, canonicalMatch, reboundResult.connection);
        this.applyCanonicalConnectionPatchToLocalStore(projectId, canonicalMatch.id, canonicalMatch);
        return;
      }

      if (reboundResult.previousFound) {
        connection.title = reboundResult.connection.title;
        connection.description = reboundResult.connection.description;
        connection.deletedAt = reboundResult.connection.deletedAt;
        connection.updatedAt = reboundResult.connection.updatedAt;
        return;
      }

      connection.title = reboundResult.connection.title;
      connection.description = reboundResult.connection.description;
      connection.deletedAt = reboundResult.connection.deletedAt;
      connection.updatedAt = reboundResult.connection.updatedAt;
      return;
    }

    const localFreshness = this.getConnectionFreshnessTimestamp(
      connection.updatedAt,
      connection.deletedAt,
    );
    const canonicalFreshness = this.getConnectionFreshnessTimestamp(
      canonicalMatch.updated_at,
      canonicalMatch.deleted_at,
    );

    if (canonicalFreshness >= localFreshness && canonicalFreshness > 0) {
      this.hydrateConnectionFromCanonicalMatch(connection, canonicalMatch);
      this.applyCanonicalConnectionPatchToLocalStore(projectId, canonicalMatch.id, canonicalMatch);
    }
  }
  
  /**
   * 安全添加到重试队列（含会话和数据有效性检查）
   * 替代之前的 setCallbacks 回调模式，直接使用注入的服务
   */
  private safeAddToRetryQueue(
    type: 'task' | 'project' | 'connection',
    operation: 'upsert' | 'delete',
    data: Connection | { id: string },
    projectId?: string,
    sourceUserId?: string,
    allowWhenSessionExpired = false,
  ): void {
    if (this.syncStateService.isSessionExpired() && !allowWhenSessionExpired) return;
    if (!data?.id) {
      this.logger.warn('safeAddToRetryQueue: 跳过无效数据（缺少 id）', { type, operation });
      return;
    }
    if ((type === 'task' || type === 'connection') && !projectId) {
      this.logger.warn('safeAddToRetryQueue: 跳过无效数据（缺少 projectId）', { type, operation, id: data.id });
      return;
    }
    const enqueued = this.retryQueueService.add(type, operation, data, projectId, sourceUserId);
    if (enqueued) {
      this.syncStateService.setPendingCount(this.retryQueueService.length);
    } else {
      this.syncStateService.setSyncError('同步队列已满，暂未写入重试队列');
    }
  }

  private recordRetryableConnectionFailure(error?: EnhancedError): void {
    if (!error?.isRetryable) {
      return;
    }

    this.retryQueueService.recordCircuitFailure(error.errorType);
  }

  private ensureEnhancedError(error: unknown): EnhancedError {
    if (
      error instanceof Error
      && 'isRetryable' in error
      && 'errorType' in error
    ) {
      return error as EnhancedError;
    }

    return supabaseErrorToError(error);
  }

  private preserveConnectionUpsertForBrowserSuspension(
    connection: Connection,
    projectId: string,
    fromRetryQueue: boolean,
    sourceUserId?: string,
    context?: string,
  ): boolean {
    if (fromRetryQueue) {
      throw createBrowserNetworkSuspendedError();
    }

    if (!fromRetryQueue) {
      this.safeAddToRetryQueue('connection', 'upsert', connection, projectId, sourceUserId, true);
    }

    this.logger.info('浏览器网络挂起，延后连接同步', {
      connectionId: connection.id,
      projectId,
      context,
    });
    return false;
  }
  
  /**
   * 获取 Supabase 客户端，离线模式返回 null
   */
  private getSupabaseClient(): SupabaseClient | null {
    if (!this.supabase.isConfigured) {
      const failure = classifySupabaseClientFailure(false);
      this.logger.warn('无法获取 Supabase 客户端', failure);
      this.syncStateService.setSyncError(failure.message);
      return null;
    }
    try {
      return this.supabase.client();
    } catch (error) {
      const failure = classifySupabaseClientFailure(true, error);
      this.logger.warn('无法获取 Supabase 客户端', {
        category: failure.category,
        message: failure.message
      });
      this.syncStateService.setSyncError(failure.message);
      // eslint-disable-next-line no-restricted-syntax -- 维持调用方约定：客户端不可用时返回 null 走降级链路
      return null;
    }
  }
  
  /**
   * 增强的 Sentry 异常捕获（自动清洗 PII）
   */
  private captureExceptionWithContext(
    error: unknown,
    operation: string,
    extra?: Record<string, unknown>
  ): void {
    const sanitizedExtra: Record<string, unknown> = {};
    if (extra) {
      for (const [key, value] of Object.entries(extra)) {
        if (['title', 'content', 'description', 'name'].includes(key)) {
          continue;
        }
        sanitizedExtra[key] = value;
      }
    }
    
    this.sentryLazyLoader.captureException(error, {
      tags: { operation },
      extra: sanitizedExtra
    });
  }
  
  // ==================== 连接同步操作 ====================
  
  /**
   * 推送连接到云端
   * 
   * @param skipTombstoneCheck 跳过 tombstone 检查（调用方已批量过滤时使用）
   * @param skipTaskExistenceCheck 跳过任务存在性检查（调用方已验证时使用）
   * @param fromRetryQueue 是否从 processRetryQueue 调用，为 true 时不自动入队
   */
  async pushConnection(
    connection: Connection, 
    projectId: string, 
    skipTombstoneCheck = false, 
    skipTaskExistenceCheck = false, 
    fromRetryQueue = false,
    sourceUserId?: string,
  ): Promise<boolean> {
    // 会话过期检查 — 【P0-06 修复】会话过期时入重试队列，防止数据丢失
    if (this.syncStateService.isSessionExpired()) {
      this.logger.warn('会话已过期，连接同步被阻止', { connectionId: connection.id });
      if (!fromRetryQueue) {
        this.safeAddToRetryQueue('connection', 'upsert', connection, projectId, sourceUserId, true);
      }
      return false;
    }
    
    // 【P1-18 修复】添加 CircuitBreaker 检查，与 pushTask 行为一致
    if (!this.retryQueueService.checkCircuitBreaker()) {
      this.logger.debug('Circuit Breaker: 熔断中，跳过连接推送', { connectionId: connection.id });
      if (!fromRetryQueue) {
        this.safeAddToRetryQueue('connection', 'upsert', connection, projectId, sourceUserId);
      }
      return false;
    }
    
    const client = this.getSupabaseClient();
    if (!client) {
      if (!fromRetryQueue) {
        this.safeAddToRetryQueue('connection', 'upsert', connection, projectId, sourceUserId);
      }
      return false;
    }
    
    try {
      // 验证用户会话
      const { data: { session } } = await client.auth.getSession();
      let sessionUserId = session?.user?.id ?? null;
      if (!sessionUserId) {
        const refreshed = await this.sessionManager.tryRefreshSession('pushConnection.getSession');
        if (refreshed) {
          const { data: { session: newSession } } = await client.auth.getSession();
          sessionUserId = newSession?.user?.id ?? null;
        }
      }

      if (!sessionUserId) {
        if (isBrowserNetworkSuspendedWindow()) {
          return this.preserveConnectionUpsertForBrowserSuspension(
            connection,
            projectId,
            fromRetryQueue,
            sourceUserId,
            'pushConnection.getSession'
          );
        }

        this.syncStateService.setSessionExpired(true);
        this.logger.warn('检测到会话丢失', { connectionId: connection.id, operation: 'pushConnection' });
        this.toast.warning('登录已过期', '请重新登录以继续同步数据');
        // 【P0-06 修复】会话丢失时入队重试，防止连接数据永久丢失
        if (!fromRetryQueue) {
          this.safeAddToRetryQueue('connection', 'upsert', connection, projectId, sourceUserId, true);
        }
        return false;
      }

      if (sourceUserId && sessionUserId !== sourceUserId) {
        this.logger.warn('检测到连接同步归属与当前会话不匹配，已拒绝云端写入', {
          connectionId: connection.id,
          projectId,
          sourceUserId,
          sessionUserId,
        });
        if (!fromRetryQueue) {
          this.safeAddToRetryQueue('connection', 'upsert', connection, projectId, sourceUserId);
        }
        return false;
      }

      if (connection.source === connection.target) {
        this.logger.warn('检测到无效自连接，已拒绝云端写入', {
          connectionId: connection.id,
          projectId,
          taskId: connection.source,
        });
        if (fromRetryQueue) {
          throw new PermanentFailureError(
            'Invalid self-link connection',
            undefined,
            { operation: 'pushConnection.invalidSelfLink', connectionId: connection.id, projectId }
          );
        }
        return false;
      }
      
      // 防御层：tombstone 检查
      if (!skipTombstoneCheck) {
        const tombstoneStatus = await this.checkConnectionTombstone(
          client,
          projectId,
          connection,
          fromRetryQueue,
        );

        if (tombstoneStatus.ok === false) {
          if (!tombstoneStatus.shouldRetry) {
            if (fromRetryQueue) {
              throw new PermanentFailureError(
                'Connection tombstone lookup denied',
                tombstoneStatus.error,
                { operation: 'pushConnection.connectionTombstoneLookup', connectionId: connection.id, projectId }
              );
            }
            return false;
          }

          if (fromRetryQueue && tombstoneStatus.error.errorType === 'BrowserNetworkSuspendedError') {
            throw tombstoneStatus.error;
          }

          if (!fromRetryQueue) {
            this.safeAddToRetryQueue('connection', 'upsert', connection, projectId, sourceUserId);
          }
          return false;
        }
        
        if (tombstoneStatus.tombstoneFound) {
          this.logger.info('pushConnection: 跳过已删除连接（tombstone 防护）', { 
            connectionId: connection.id, 
            projectId 
          });
          if (fromRetryQueue) {
            throw new PermanentFailureError(
              'Connection remote tombstoned',
              undefined,
              { operation: 'pushConnection.remoteTombstone', connectionId: connection.id, projectId }
            );
          }
          return false;
        }
      }
      
      // 任务存在性验证
      if (!skipTaskExistenceCheck) {
        const validationResult = await this.validateTasksExist(
          client, 
          projectId, 
          connection,
          fromRetryQueue,
        );
        
        if (validationResult.valid === false) {
          if (!validationResult.shouldRetry) {
            if (fromRetryQueue) {
              throw new PermanentFailureError(
                validationResult.reason === 'permission-denied'
                  ? 'Connection task validation denied'
                  : 'Connection references deleted tasks',
                validationResult.error,
                {
                  operation: 'pushConnection.validateTasksExist',
                  connectionId: connection.id,
                  projectId,
                  source: connection.source,
                  target: connection.target,
                  reason: validationResult.reason,
                }
              );
            }
            return false;
          }

          if (fromRetryQueue && validationResult.error?.errorType === 'BrowserNetworkSuspendedError') {
            throw validationResult.error;
          }

          if (!fromRetryQueue) {
            this.safeAddToRetryQueue('connection', 'upsert', connection, projectId, sourceUserId);
          }
          return false;
        }
      }

      // 预检查：同一 source/target 已存在不同 id 时视为幂等成功，避免 409 冲突刷屏
      const canonicalEndpointMatch = await this.lookupCanonicalEndpointMatch(client, projectId, connection);

      if (canonicalEndpointMatch && canonicalEndpointMatch.id !== connection.id) {
          this.logger.info('检测到远端同端点连接，复用既有 id 继续同步', {
            connectionId: connection.id,
            existingConnectionId: canonicalEndpointMatch.id,
            projectId,
            source: connection.source,
            target: connection.target,
            remoteDeletedAt: canonicalEndpointMatch.deleted_at,
            localDeletedAt: connection.deletedAt,
          });
        this.applyCanonicalConnectionIdentity(projectId, connection, canonicalEndpointMatch);
      } else if (canonicalEndpointMatch) {
        const localFreshness = this.getConnectionFreshnessTimestamp(connection.updatedAt, connection.deletedAt);
        const canonicalFreshness = this.getConnectionFreshnessTimestamp(
          canonicalEndpointMatch.updated_at,
          canonicalEndpointMatch.deleted_at,
        );

        if (canonicalFreshness >= localFreshness && canonicalFreshness > 0) {
          this.hydrateConnectionFromCanonicalMatch(connection, canonicalEndpointMatch);
          this.applyCanonicalConnectionPatchToLocalStore(projectId, canonicalEndpointMatch.id, canonicalEndpointMatch);
        }
      }
      
      // 执行 upsert
      let persistedUpdatedAt: string | null = null;
      let pushed = false;
      let blockedBySyncRpc = false;

      await this.throttle.execute(
        `push-connection:${connection.id}`,
        async () => {
          await this.syncOpHelper.retryWithBackoff(async () => {
            if (this.shouldUseSyncRpc()) {
              const result = await this.syncRpcClient!.upsertConnection({
                operationId: this.createSyncRpcOperationId(),
                connection,
                projectId,
                baseUpdatedAt: connection.updatedAt ?? null,
              });
              pushed = this.handleConnectionSyncRpcResult(
                result,
                connection,
                projectId,
                fromRetryQueue,
                sourceUserId,
              );
              blockedBySyncRpc = !pushed;
              return;
            }

            const remoteConnection = await this.loadRemoteConnectionFreshness(client, connection.id, projectId);
            const remoteHasTombstone = !!(remoteConnection?.deleted_at && !connection.deletedAt);
            const remoteUpdatedAt = remoteConnection?.updated_at ?? null;
            const localUpdatedAt = connection.updatedAt ?? null;
            const rawRemoteMs = remoteUpdatedAt ? new Date(remoteUpdatedAt).getTime() : Number.NaN;
            const rawLocalMs = localUpdatedAt ? new Date(localUpdatedAt).getTime() : Number.NaN;
            const timestampsDiffer = Number.isFinite(rawRemoteMs)
              && Number.isFinite(rawLocalMs)
              && rawLocalMs !== rawRemoteMs;
            const clockSyncResult = timestampsDiffer
              ? await this.clockSync.ensureSynced().catch(() => null)
              : null;

            if (timestampsDiffer && !clockSyncResult?.reliable) {
              throw this.createClockUncertainError(
                connection.id,
                projectId,
                localUpdatedAt,
                remoteUpdatedAt,
              );
            }

            const remoteIsNewer = !!(
              remoteUpdatedAt
              && localUpdatedAt
              && (
                clockSyncResult?.reliable
                  ? this.clockSync.compareTimestamps(localUpdatedAt, remoteUpdatedAt) < 0
                  : rawRemoteMs > rawLocalMs
              )
            );

            if (remoteHasTombstone || remoteIsNewer) {
              throw this.createRemoteNewerConflictError(
                connection.id,
                projectId,
                remoteConnection?.updated_at ?? remoteConnection?.deleted_at ?? null,
                remoteHasTombstone ? 'remote-tombstone' : 'remote-newer',
              );
            }

            try {
              persistedUpdatedAt = await this.upsertConnectionReturningUpdatedAt(
                client,
                connection,
                projectId,
                remoteConnection,
              );
              pushed = true;
              return;
            } catch (upsertError) {
              const enhancedError = this.ensureEnhancedError(upsertError);
            
              // 处理复合唯一约束冲突
              const code = enhancedError.code || (enhancedError as { code?: string }).code;
              if (
                code === '23505'
                && (
                  enhancedError.message?.includes('connections_project_id_source_id_target_id')
                  || enhancedError.message?.includes('uq_connections_project_source_target_active')
                )
              ) {
                const racedCanonicalMatch = await this.lookupCanonicalEndpointMatch(client, projectId, connection);
                if (!racedCanonicalMatch) {
                  const conflictRecoveryError = new Error('Unknown Supabase error: canonical connection lookup missed after 23505 conflict');
                  conflictRecoveryError.name = 'UnknownServerError';
                  throw conflictRecoveryError;
                }

                this.applyCanonicalConnectionIdentity(projectId, connection, racedCanonicalMatch);
                const canonicalRemoteConnection = await this.loadRemoteConnectionFreshness(client, connection.id, projectId);
                const canonicalHasTombstone = !!(canonicalRemoteConnection?.deleted_at && !connection.deletedAt);
                const canonicalRemoteUpdatedAt = canonicalRemoteConnection?.updated_at ?? null;
                const canonicalLocalUpdatedAt = connection.updatedAt ?? null;
                const canonicalRawRemoteMs = canonicalRemoteUpdatedAt ? new Date(canonicalRemoteUpdatedAt).getTime() : Number.NaN;
                const canonicalRawLocalMs = canonicalLocalUpdatedAt ? new Date(canonicalLocalUpdatedAt).getTime() : Number.NaN;
                const canonicalTimestampsDiffer = Number.isFinite(canonicalRawRemoteMs)
                  && Number.isFinite(canonicalRawLocalMs)
                  && canonicalRawLocalMs !== canonicalRawRemoteMs;
                const canonicalClockSyncResult = canonicalTimestampsDiffer
                  ? await this.clockSync.ensureSynced().catch(() => null)
                  : null;

                if (canonicalTimestampsDiffer && !canonicalClockSyncResult?.reliable) {
                  throw this.createClockUncertainError(
                    connection.id,
                    projectId,
                    canonicalLocalUpdatedAt,
                    canonicalRemoteUpdatedAt,
                  );
                }

                const canonicalIsNewer = !!(
                  canonicalRemoteUpdatedAt
                  && canonicalLocalUpdatedAt
                  && (
                    canonicalClockSyncResult?.reliable
                      ? this.clockSync.compareTimestamps(canonicalLocalUpdatedAt, canonicalRemoteUpdatedAt) < 0
                      : canonicalRawRemoteMs > canonicalRawLocalMs
                  )
                );

                if (canonicalHasTombstone || canonicalIsNewer) {
                  throw this.createRemoteNewerConflictError(
                    connection.id,
                    projectId,
                    canonicalRemoteConnection?.updated_at ?? canonicalRemoteConnection?.deleted_at ?? null,
                    canonicalHasTombstone ? 'remote-tombstone' : 'remote-newer',
                  );
                }

                persistedUpdatedAt = await this.upsertConnectionReturningUpdatedAt(
                  client,
                  connection,
                  projectId,
                  canonicalRemoteConnection,
                );
                pushed = true;
                this.logger.info('连接已存在（幂等成功）', {
                  connectionId: connection.id,
                  source: connection.source,
                  target: connection.target
                });
                return;
              }
              if (code === '23505' || code === 23505) {
                throw this.createRemoteNewerConflictError(
                  connection.id,
                  projectId,
                  connection.updatedAt ?? null,
                  'remote-newer',
                );
              }
              throw enhancedError;
            }
          });
        },
        { priority: 'normal', retries: 0, timeout: REQUEST_THROTTLE_CONFIG.INDIVIDUAL_OPERATION_TIMEOUT }
      );

      if (blockedBySyncRpc || !pushed) {
        return false;
      }

      if (persistedUpdatedAt) {
        this.normalizeLocalConnectionUpdatedAt(
          projectId,
          connection,
          persistedUpdatedAt,
        );
      }

      this.retryQueueService.recordCircuitSuccess();
      
      return true;
    } catch (e) {
      if (isBrowserNetworkSuspendedError(e) || isBrowserNetworkSuspendedWindow()) {
        return this.preserveConnectionUpsertForBrowserSuspension(
          connection,
          projectId,
          fromRetryQueue,
          sourceUserId,
          'pushConnection'
        );
      }

      return this.handlePushConnectionError(e, connection, projectId, fromRetryQueue, sourceUserId);
    }
  }

  private shouldUseSyncRpc(): boolean {
    return this.syncRpcClient?.isFeatureEnabled() === true && this.syncRpcClient.isClientRejected() === false;
  }

  private createSyncRpcOperationId(): string {
    return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  private handleConnectionSyncRpcResult(
    result: SyncRpcResult,
    connection: Connection,
    projectId: string,
    fromRetryQueue: boolean,
    sourceUserId: string | undefined,
  ): boolean {
    if (result.status === 'applied' || result.status === 'idempotent-replay') {
      if (result.serverUpdatedAt) {
        this.normalizeLocalConnectionUpdatedAt(projectId, connection, result.serverUpdatedAt);
      }
      this.logger.debug('pushConnection: sync RPC 写入成功', {
        connectionId: connection.id,
        projectId,
        status: result.status,
      });
      return true;
    }

    if (result.status === 'remote-newer') {
      this.logger.warn('pushConnection: sync RPC CAS 拒绝，远端版本更新', {
        connectionId: connection.id,
        projectId,
        remoteUpdatedAt: result.remoteUpdatedAt,
        reason: result.reason,
      });
      this.sentryLazyLoader.captureMessage('sync_rpc_connection_remote_newer', {
        level: 'warning',
        tags: { operation: 'pushConnection', entityType: 'connection', status: result.status },
        extra: { connectionId: connection.id, projectId, remoteUpdatedAt: result.remoteUpdatedAt, reason: result.reason },
      });
      if (!fromRetryQueue) {
        this.safeAddToRetryQueue('connection', 'upsert', connection, projectId, sourceUserId);
      }
      return false;
    }

    const message = result.status === 'client-version-rejected'
      ? '当前客户端同步协议已过期，请刷新后重试'
      : '同步写入被服务端拒绝，已保留本地变更等待重试';
    this.syncStateService.setSyncError(message);
    this.logger.warn('pushConnection: sync RPC 拒绝写入', {
      connectionId: connection.id,
      projectId,
      status: result.status,
      reason: result.reason,
      minProtocolVersion: result.minProtocolVersion,
    });
    this.sentryLazyLoader.captureMessage('sync_rpc_connection_rejected', {
      level: 'warning',
      tags: { operation: 'pushConnection', entityType: 'connection', status: result.status },
      extra: { connectionId: connection.id, projectId, reason: result.reason, minProtocolVersion: result.minProtocolVersion },
    });
    if (!fromRetryQueue) {
      this.safeAddToRetryQueue('connection', 'upsert', connection, projectId, sourceUserId);
    }
    return false;
  }
  
  /**
   * 验证连接引用的任务是否存在
   */
  private async validateTasksExist(
    client: SupabaseClient,
    projectId: string,
    connection: Connection,
    fromRetryQueue: boolean,
  ): Promise<TaskValidationResult> {
    let queryResult = await this.queryExistingTaskIds(client, projectId, connection);
    let retriedAfterRefresh = false;

    if (queryResult.error && this.sessionManager.isSessionExpiredError(queryResult.error)) {
      const refreshed = await this.sessionManager.handleAuthErrorWithRefresh('pushConnection.validateTasksExist', {
        connectionId: connection.id,
        projectId,
        source: connection.source,
        target: connection.target,
        errorCode: queryResult.error.code,
      });
      if (refreshed) {
        retriedAfterRefresh = true;
        queryResult = await this.queryExistingTaskIds(client, projectId, connection);
      }
    }

    if (queryResult.error) {
      const error = queryResult.error;
      if (retriedAfterRefresh && this.sessionManager.isRlsPolicyViolation(error)) {
        this.logger.info('刷新会话后任务存在性查询仍无权限，停止重放陈旧连接', {
          connectionId: connection.id,
          projectId,
          source: connection.source,
          target: connection.target,
          errorCode: error.code,
        });
        return {
          valid: false,
          shouldRetry: false,
          reason: 'permission-denied',
          error,
        };
      }

      const logLevel: 'debug' | 'warn' = fromRetryQueue ? 'debug' : 'warn';
      this.logger[logLevel]('任务存在性查询失败，跳过连接推送', {
        connectionId: connection.id,
        projectId,
        source: connection.source,
        target: connection.target,
        errorCode: error.code,
        errorType: error.errorType,
        message: error.message,
        retriedAfterRefresh,
      });

      this.sentryLazyLoader.captureMessage('任务存在性查询失败', {
        level: 'warning',
        tags: {
          operation: 'pushConnection',
          errorType: error.errorType,
        },
        extra: {
          connectionId: connection.id,
          projectId,
          source: connection.source,
          target: connection.target,
          errorCode: error.code,
          message: error.message,
        }
      });

      this.recordRetryableConnectionFailure(error);

      return {
        valid: false,
        shouldRetry: true,
        reason: 'query-error',
        error,
      };
    }

    const existingTaskIds = new Set(queryResult.data.map(task => task.id));
    const sourceExists = existingTaskIds.has(connection.source);
    const targetExists = existingTaskIds.has(connection.target);

    if (!sourceExists || !targetExists) {
      const localTombstones = this.tombstoneService.getLocalTombstones(projectId);
      const referencesDeletedTask = localTombstones.has(connection.source) || localTombstones.has(connection.target);
      const logLevel: 'debug' | 'info' = referencesDeletedTask
        ? 'info'
        : (fromRetryQueue ? 'debug' : 'info');

      this.logger[logLevel](
        referencesDeletedTask
          ? '连接引用已删除任务，停止重放并收口'
          : '连接依赖的任务尚未同步完成，延后连接推送',
        {
          connectionId: connection.id,
          projectId,
          source: connection.source,
          target: connection.target,
          sourceExists,
          targetExists,
        }
      );

      return {
        valid: false,
        shouldRetry: !referencesDeletedTask,
        reason: 'missing-task',
        sourceExists,
        targetExists,
      };
    }

    return { valid: true };
  }

  private async checkConnectionTombstone(
    client: SupabaseClient,
    projectId: string,
    connection: Connection,
    fromRetryQueue: boolean,
  ): Promise<ConnectionTombstoneCheckResult> {
    let queryResult = await this.queryConnectionTombstone(client, projectId, connection);
    let retriedAfterRefresh = false;

    if (queryResult.error && this.sessionManager.isSessionExpiredError(queryResult.error)) {
      const refreshed = await this.sessionManager.handleAuthErrorWithRefresh('pushConnection.connectionTombstoneLookup', {
        connectionId: connection.id,
        projectId,
        errorCode: queryResult.error.code,
      });
      if (refreshed) {
        retriedAfterRefresh = true;
        queryResult = await this.queryConnectionTombstone(client, projectId, connection);
      }
    }

    if (queryResult.error) {
      if (retriedAfterRefresh && this.sessionManager.isRlsPolicyViolation(queryResult.error)) {
        this.logger.info('刷新会话后 connection tombstone 查询仍无权限，停止重放陈旧连接', {
          connectionId: connection.id,
          projectId,
          errorCode: queryResult.error.code,
        });
        return { ok: false, shouldRetry: false, error: queryResult.error };
      }

      const logLevel: 'debug' | 'warn' = fromRetryQueue ? 'debug' : 'warn';
      this.logger[logLevel]('connection tombstone 查询失败，停止本次连接推送', {
        connectionId: connection.id,
        projectId,
        errorCode: queryResult.error.code,
        errorType: queryResult.error.errorType,
        message: queryResult.error.message,
        retriedAfterRefresh,
      });
      this.recordRetryableConnectionFailure(queryResult.error);
      return { ok: false, shouldRetry: true, error: queryResult.error };
    }

    return { ok: true, tombstoneFound: queryResult.tombstoneFound };
  }

  private async queryConnectionTombstone(
    client: SupabaseClient,
    projectId: string,
    connection: Connection,
  ): Promise<{ tombstoneFound: boolean; error: EnhancedError | null }> {
    try {
      const { data, error } = await client
        .from('connection_tombstones')
        .select('connection_id')
        .eq('connection_id', connection.id)
        .maybeSingle();

      if (error) {
        return { tombstoneFound: false, error: supabaseErrorToError(error) };
      }

      if (data) {
        return { tombstoneFound: true, error: null };
      }

      const endpointTombstoneResult = await client
        .from('connection_tombstones')
        .select('deleted_at')
        .eq('project_id', projectId)
        .eq('source_id', connection.source)
        .eq('target_id', connection.target)
        .order('deleted_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (endpointTombstoneResult.error) {
        return { tombstoneFound: false, error: supabaseErrorToError(endpointTombstoneResult.error) };
      }

      const endpointDeletedAt = endpointTombstoneResult.data?.deleted_at;
      const localFreshnessTimestamp = this.getConnectionFreshnessTimestamp(connection.updatedAt, connection.deletedAt);
      const tombstoneFound = !!endpointDeletedAt && (() => {
        const deletedAtTimestamp = new Date(endpointDeletedAt).getTime();
        return !Number.isNaN(deletedAtTimestamp)
          && (localFreshnessTimestamp === 0 || deletedAtTimestamp >= localFreshnessTimestamp);
      })();

      if (tombstoneFound) {
        return { tombstoneFound: true, error: null };
      }

      const legacyEndpointlessTombstoneResult = await client
        .from('connection_tombstones')
        .select('deleted_at,source_id,target_id')
        .eq('project_id', projectId)
        .is('source_id', null)
        .is('target_id', null)
        .order('deleted_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (legacyEndpointlessTombstoneResult.error) {
        return { tombstoneFound: false, error: supabaseErrorToError(legacyEndpointlessTombstoneResult.error) };
      }

      const legacyDeletedAt = legacyEndpointlessTombstoneResult.data?.deleted_at;
      if (!legacyDeletedAt) {
        return { tombstoneFound: false, error: null };
      }

      const legacyDeletedAtTimestamp = new Date(legacyDeletedAt).getTime();
      const legacyGuardTriggered = Number.isNaN(legacyDeletedAtTimestamp)
        ? false
        : localFreshnessTimestamp === 0 || legacyDeletedAtTimestamp >= localFreshnessTimestamp;

      return { tombstoneFound: legacyGuardTriggered, error: null };
    } catch (error) {
      return { tombstoneFound: false, error: supabaseErrorToError(error) };
    }
  }

  private async queryExistingTaskIds(
    client: SupabaseClient,
    projectId: string,
    connection: Connection,
  ): Promise<{ data: Array<{ id: string }>; error: EnhancedError | null }> {
    try {
      const result = await supabaseWithRetry(
        () => client
          .from('tasks')
          .select('id')
          .in('id', [connection.source, connection.target])
          .eq('project_id', projectId)
          .is('deleted_at', null),
        {
          timeout: 'QUICK',
          maxRetries: 2
        }
      ) as { data: Array<{ id: string }> | null; error: unknown | null };

      if (result.error) {
        return { data: [], error: supabaseErrorToError(result.error) };
      }

      return { data: result.data ?? [], error: null };
    } catch (error) {
      return { data: [], error: supabaseErrorToError(error) };
    }
  }
  
  /**
   * 处理 pushConnection 错误
   */
  private handlePushConnectionError(
    e: unknown,
    connection: Connection,
    projectId: string,
    fromRetryQueue: boolean,
    sourceUserId?: string,
  ): boolean {
    if (isPermanentFailureError(e)) {
      throw e;
    }

    const enhanced = this.ensureEnhancedError(e);
    this.recordRetryableConnectionFailure(enhanced);

    if (enhanced.errorType === 'BrowserNetworkSuspendedError') {
      if (fromRetryQueue) {
        throw enhanced;
      }

      this.logger.info('浏览器网络挂起，延后连接同步', {
        connectionId: connection.id,
        projectId,
      });
      this.safeAddToRetryQueue('connection', 'upsert', connection, projectId, sourceUserId, true);
      return false;
    }
    
    // 版本冲突错误
    if (enhanced.errorType === 'VersionConflictError') {
      this.logger.warn('推送连接版本冲突', { connectionId: connection.id, projectId });
      this.toast.warning('版本冲突', '数据已被修改，请刷新后重试');
      this.sentryLazyLoader.captureMessage('Optimistic lock conflict in pushConnection', {
        level: 'warning',
        tags: { operation: 'pushConnection', connectionId: connection.id, projectId }
      });
      throw new PermanentFailureError(
        'Version conflict',
        enhanced,
        { operation: 'pushConnection', connectionId: connection.id, projectId }
      );
    }
    
    // 外键约束错误
    const isForeignKeyError = enhanced.errorType === 'ForeignKeyError' ||
                             enhanced.message?.includes('foreign key constraint') || 
                             enhanced.message?.includes('violates foreign key') ||
                             enhanced.code === '23503' || enhanced.code === 23503;
    
    if (isForeignKeyError) {
      this.logger.error('连接推送失败（外键约束违规）', {
        connectionId: connection.id,
        projectId,
        source: connection.source,
        target: connection.target,
        error: enhanced.message,
        errorCode: enhanced.code
      });
      
      this.captureExceptionWithContext(enhanced, 'pushConnection_fk_violation', {
        connectionId: connection.id,
        projectId,
        source: connection.source,
        target: connection.target,
        errorCode: enhanced.code
      });

      if (!fromRetryQueue) {
        this.safeAddToRetryQueue('connection', 'upsert', connection, projectId, sourceUserId);
      }
      
      return false;
    }
    
    // 日志记录
    if (enhanced.isRetryable) {
      this.logger.debug(`推送连接失败 (${enhanced.errorType})，已加入重试队列`, {
        message: enhanced.message,
        connectionId: connection.id
      });
    } else {
      this.logger.error('推送连接失败', {
        error: enhanced,
        connectionId: connection.id,
        projectId,
        source: connection.source,
        target: connection.target,
        isRetryable: enhanced.isRetryable,
        errorType: enhanced.errorType
      });
    }
    
    this.captureExceptionWithContext(enhanced, 'pushConnection', {
      connectionId: connection.id,
      projectId,
      source: connection.source,
      target: connection.target,
      errorType: enhanced.errorType,
      isRetryable: enhanced.isRetryable
    });
    
    // 加入重试队列
    if (enhanced.isRetryable && !fromRetryQueue) {
      this.safeAddToRetryQueue('connection', 'upsert', connection, projectId, sourceUserId);
    } else if (!enhanced.isRetryable) {
      this.logger.warn('不可重试的错误，不加入重试队列', {
        connectionId: connection.id,
        errorType: enhanced.errorType,
        message: enhanced.message
      });
    }
    return false;
  }
  
  /**
   * 获取项目的所有 connection tombstone ID
   * 【免费层优化】优先使用 TombstoneService 缓存，避免每次独立查询
   */
  async getConnectionTombstoneIds(projectId: string): Promise<Set<string>> {
    // 优先走缓存（由 batchPreloadTombstones 或之前查询写入）
    const cached = this.tombstoneService.getConnectionTombstoneCache(projectId);
    if (cached) {
      return cached;
    }

    const tombstoneIds = new Set<string>();
    
    const client = this.getSupabaseClient();
    if (!client) {
      this.logger.info('getConnectionTombstoneIds: 离线模式，返回空集', { projectId });
      return tombstoneIds;
    }
    
    try {
      const { data, error } = await client
        .from('connection_tombstones')
        .select('connection_id')
        .eq('project_id', projectId);
      
      if (error) {
        this.logger.warn('获取连接 tombstones 失败', error);
        return tombstoneIds;
      }
      
      for (const t of (data || [])) {
        tombstoneIds.add(t.connection_id);
      }

      // 写入缓存，后续在 TTL 内直接命中
      this.tombstoneService.updateConnectionTombstoneCache(projectId, tombstoneIds);
      
      if (tombstoneIds.size > 0) {
        this.logger.debug('getConnectionTombstoneIds: 获取完成', {
          projectId,
          count: tombstoneIds.size
        });
      }
      
      return tombstoneIds;
    } catch (e) {
      this.logger.warn('获取连接 tombstones 异常', e);
      return tombstoneIds;
    }
  }
}
