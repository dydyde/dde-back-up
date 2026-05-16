/**
 * BatchSyncService - 批量同步服务
 * 
 * 职责：
 * - 批量保存项目到云端 (saveProjectToCloud)
 * - 处理任务拓扑排序和批量推送
 * - 处理连接验证和批量推送
 * 
 * 从 SimpleSyncService 提取，Sprint 9 技术债务修复
 */

import { Injectable, inject } from '@angular/core';
import { SupabaseClientService } from '../../../../services/supabase-client.service';
import { LoggerService } from '../../../../services/logger.service';
import { ToastService } from '../../../../services/toast.service';
import { CircuitBreakerService } from '../../../../services/circuit-breaker.service';
import { ChangeTrackerService } from '../../../../services/change-tracker.service';
import { MobileSyncStrategyService } from '../../../../services/mobile-sync-strategy.service';
import { SyncStateService } from './sync-state.service';
import { RetryQueueService } from './retry-queue.service';
import { SessionManagerService } from './session-manager.service';
import { Task, Project, Connection } from '../../../../models';
import { nowISO } from '../../../../utils/date';
import { isPermanentFailureError } from '../../../../utils/permanent-failure-error';
import { classifySupabaseClientFailure, supabaseErrorToError } from '../../../../utils/supabase-error';
import { AUTH_CONFIG, RECOVERABLE_SYNC_ERROR_MESSAGES, SYNC_CONFIG } from '../../../../config';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import {
  getRemainingBrowserNetworkResumeDelayMs,
  isBrowserNetworkSuspendedError,
  isBrowserNetworkSuspendedWindow,
} from '../../../../utils/browser-network-suspension';

interface RemoteExistingTaskIdsResult {
  existingIds: Set<string>;
  deferredBySuspension: boolean;
}
/** 批量同步结果 */
export interface BatchSyncResult {
  success: boolean;
  conflict?: boolean;
  remoteData?: Project;
  newVersion?: number;
  projectPushed?: boolean;
  failedTaskIds?: string[];
  failedConnectionIds?: string[];
  retryEnqueued?: string[];
  failureReason?: string;
  terminal?: boolean;
  /**
   * 中文注释：部分失败但未全部转交 RetryQueue 的语义标记。
   * - true：存在被记入 failedTaskIds / failedConnectionIds 的项未进入 RetryQueue（容量已满 /
   *   purge 部分失败 / 浏览器挂起 continue 等），下游不应以 "已转交" 视之，也不应抛 ERROR。
   * - false / undefined：要么完全成功，要么所有失败项都已转交 RetryQueue（"fullyResolved"）。
   * 引入该字段是为了避免下游通过匹配 failureReason 字符串来推断同步事实。
   */
  partialRetryHandoff?: boolean;
}

/** 批量同步回调函数类型 */
export interface BatchSyncCallbacks {
  pushProject: (
    project: Project,
    fromRetryQueue?: boolean,
    sourceUserId?: string,
    taskIdsToDelete?: string[],
  ) => Promise<{ success: boolean; conflict?: boolean; remoteData?: Project; retryEnqueued?: boolean; failureReason?: string; terminal?: boolean }>;
  pushTask: (
    task: Task,
    projectId: string,
    skipTombstoneCheck?: boolean,
    fromRetryQueue?: boolean,
    sourceUserId?: string,
  ) => Promise<{ success: boolean; retryEnqueued?: boolean }>;
  pushTaskPosition: (
    taskId: string,
    x: number,
    y: number,
    projectId?: string,
    fallbackTask?: Task,
    sourceUserId?: string,
  ) => Promise<boolean>;
  pushConnection: (
    connection: Connection,
    projectId: string,
    skipTombstoneCheck?: boolean,
    skipTaskExistenceCheck?: boolean,
    fromRetryQueue?: boolean,
    sourceUserId?: string,
  ) => Promise<{ success: boolean; retryEnqueued?: boolean }>;
  getTombstoneIds: (projectId: string) => Promise<Set<string>>;
  getConnectionTombstoneIds: (projectId: string) => Promise<Set<string>>;
  purgeTasksFromCloud: (projectId: string, taskIds: string[], sourceUserId?: string) => Promise<{ success: boolean; retriedTaskIds?: string[] }>;
  topologicalSortTasks: (tasks: Task[]) => Task[];
  addToRetryQueue: (
    type: 'task' | 'project' | 'connection',
    operation: 'upsert' | 'delete',
    data: unknown,
    projectId?: string,
    sourceUserId?: string,
    taskIdsToDelete?: string[],
  ) => boolean;
  addToRetryQueueDurably: (
    type: 'task' | 'project' | 'connection',
    operation: 'upsert' | 'delete',
    data: unknown,
    projectId?: string,
    sourceUserId?: string,
    taskIdsToDelete?: string[],
  ) => Promise<boolean>;
  confirmRetryQueuePersistence: () => Promise<boolean>;
}

@Injectable({
  providedIn: 'root'
})
export class BatchSyncService {
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly supabase = inject(SupabaseClientService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('BatchSync');
  private readonly toast = inject(ToastService);
  private readonly circuitBreaker = inject(CircuitBreakerService);
  private readonly changeTracker = inject(ChangeTrackerService);
  private readonly mobileSync = inject(MobileSyncStrategyService);
  private readonly syncState = inject(SyncStateService);
  private readonly retryQueue = inject(RetryQueueService);
  private readonly sessionManager = inject(SessionManagerService);
  
  /** 同步计数器（用于数据漂移检测） */
  private syncCounter = 0;

  private readonly suppressedTaskIds = new Map<string, Map<string, string>>();

  private readonly suppressedConnectionIds = new Map<string, Map<string, string>>();
  
  /** 回调函数（由 SimpleSyncService 注入） */
  private callbacks: BatchSyncCallbacks | null = null;
  
  /**
   * 获取 Supabase 客户端
   */
  private getSupabaseClient(): SupabaseClient | null {
    if (!this.supabase.isConfigured) {
      const failure = classifySupabaseClientFailure(false);
      this.logger.warn('无法获取 Supabase 客户端', failure);
      this.syncState.setSyncError(failure.message);
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
      this.syncState.setSyncError(failure.message);
      this.sentryLazyLoader.captureMessage('Sync client unavailable', {
        level: 'warning',
        tags: {
          operation: 'BatchSync.getSupabaseClient',
          category: failure.category
        }
      });
      // eslint-disable-next-line no-restricted-syntax -- 需保持离线降级契约，调用方使用 null 判定客户端不可用
      return null;
    }
  }
  
  /**
   * 延迟工具函数
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async deferProjectSyncForBrowserSuspension(
    project: Project,
    userId: string,
    pendingTaskIdsToDelete: string[],
    retryEnqueued: string[],
    failedTaskIds: string[],
    failedConnectionIds: string[],
    projectPushed: boolean,
    context: string,
  ): Promise<BatchSyncResult> {
    if (this.callbacks && !retryEnqueued.includes(`project:${project.id}`)) {
      const confirmed = await this.callbacks.addToRetryQueueDurably('project', 'upsert', project, undefined, userId, pendingTaskIdsToDelete);
      if (confirmed) {
        retryEnqueued.push(`project:${project.id}`);
      }
    }

    this.logger.info('浏览器网络挂起，延后项目批同步', {
      projectId: project.id,
      userId,
      context,
      resumeDelayMs: getRemainingBrowserNetworkResumeDelayMs(),
    });
    this.syncState.setSyncError('浏览器恢复连接中，项目稍后继续同步');

    return {
      success: false,
      failedTaskIds,
      failedConnectionIds,
      retryEnqueued,
      projectPushed,
      failureReason: 'project sync deferred by browser suspension',
    };
  }

  private getBatchChangeRevision(): number {
    const tracker = this.changeTracker as unknown as {
      getCurrentChangeRevision?: () => number;
    };

    if (typeof tracker.getCurrentChangeRevision === 'function') {
      return tracker.getCurrentChangeRevision();
    }

    this.logger.warn('ChangeTracker revision API unavailable; falling back to conservative dirty cleanup');
    return Number.POSITIVE_INFINITY;
  }

  private clearTaskChangeAfterSuccessfulPush(
    projectId: string,
    taskId: string,
    batchChangeRevision: number,
  ): void {
    const tracker = this.changeTracker as unknown as {
      clearTaskChangeIfFresh?: (projectId: string, taskId: string, notNewerThanRevision: number) => boolean;
      clearTaskChange?: (projectId: string, taskId: string) => void;
    };

    if (typeof tracker.clearTaskChangeIfFresh === 'function') {
      tracker.clearTaskChangeIfFresh(projectId, taskId, batchChangeRevision);
      return;
    }

    tracker.clearTaskChange?.(projectId, taskId);
  }

  private clearConnectionChangeAfterSuccessfulPush(
    projectId: string,
    connectionId: string,
    batchChangeRevision: number,
  ): void {
    const tracker = this.changeTracker as unknown as {
      clearConnectionChangeIfFresh?: (projectId: string, connectionId: string, notNewerThanRevision: number) => boolean;
    };

    tracker.clearConnectionChangeIfFresh?.(projectId, connectionId, batchChangeRevision);
  }

  private createTaskConflictFingerprint(task: Task): string {
    return `${task.updatedAt ?? ''}|${task.deletedAt ?? ''}`;
  }

  private createConnectionConflictFingerprint(connection: Connection): string {
    return `${connection.updatedAt ?? ''}|${connection.deletedAt ?? ''}`;
  }

  private suppressEntityUntilFingerprintChanges(
    registry: Map<string, Map<string, string>>,
    projectId: string,
    entityId: string,
    fingerprint: string,
  ): void {
    const suppressedIds = registry.get(projectId) ?? new Map<string, string>();
    suppressedIds.set(entityId, fingerprint);
    registry.set(projectId, suppressedIds);
  }

  private isEntitySuppressedUntilFreshEdit(
    registry: Map<string, Map<string, string>>,
    projectId: string,
    entityId: string,
    changedEntityIds: Set<string>,
  ): boolean {
    const suppressedIds = registry.get(projectId);
    if (!suppressedIds?.has(entityId)) {
      return false;
    }

    if (changedEntityIds.has(entityId)) {
      suppressedIds.delete(entityId);
      if (suppressedIds.size === 0) {
        registry.delete(projectId);
      }
      return false;
    }

    return true;
  }

  private reconcileSuppressedEntities(
    registry: Map<string, Map<string, string>>,
    projectId: string,
    shouldKeepSuppressed: (entityId: string, fingerprint: string) => boolean,
  ): string[] {
    const suppressedIds = registry.get(projectId);
    if (!suppressedIds) {
      return [];
    }

    for (const [entityId, fingerprint] of Array.from(suppressedIds.entries())) {
      if (!shouldKeepSuppressed(entityId, fingerprint)) {
        suppressedIds.delete(entityId);
      }
    }

    if (suppressedIds.size === 0) {
      registry.delete(projectId);
      return [];
    }

    return Array.from(suppressedIds.keys());
  }

  private shouldClearDirtyMarkerAfterPermanentFailure(error: unknown): boolean {
    if (!isPermanentFailureError(error)) {
      return false;
    }

    const permanentError = error as {
      originalError?: { code?: unknown; errorType?: unknown; name?: unknown };
      context?: Record<string, unknown>;
    };
    const originalError = permanentError.originalError;
    const code = typeof originalError?.code === 'string' ? originalError.code : null;
    const errorType = typeof originalError?.errorType === 'string' ? originalError.errorType : null;
    const name = typeof originalError?.name === 'string' ? originalError.name : null;
    const operation = typeof permanentError.context?.['operation'] === 'string'
      ? permanentError.context['operation']
      : null;

    if (errorType === 'VersionConflictError' || name === 'VersionConflictError') {
      return true;
    }

    if (code?.endsWith('_REMOTE_NEWER') || code?.endsWith('_REMOTE_TOMBSTONE_NEWER')) {
      return true;
    }

    return operation === 'pushTaskTombstone' || operation === 'pushConnection.remoteTombstone';
  }

  private markBatchSyncSuccess(): void {
    this.syncState.clearPendingRecoverableSyncError();
    const syncTime = nowISO();

    this.syncState.advanceLastSyncTimeIfIdle(syncTime);
  }

  private scheduleRecoverableSyncError(message: string, context: {
    projectId: string;
    failedTaskCount: number;
    failedConnectionCount: number;
    retryEnqueuedCount: number;
  }): void {
    this.logger.info('部分同步失败已进入宽限观察窗，等待 RetryQueue 自愈收口', {
      ...context,
      graceMs: SYNC_CONFIG.DEBOUNCE_DELAY,
    });
    this.syncState.scheduleRecoverableSyncError(message, SYNC_CONFIG.DEBOUNCE_DELAY);
  }

  /**
   * 查询远端已存在的任务 ID。
   * 仅用于连接推送前做依赖校验，避免外键约束错误风暴。
   */
  private async fetchRemoteExistingTaskIds(
    client: SupabaseClient,
    projectId: string,
    taskIds: string[]
  ): Promise<RemoteExistingTaskIdsResult> {
    const existingIds = new Set<string>();
    if (taskIds.length === 0) {
      return { existingIds, deferredBySuspension: false };
    }

    if (isBrowserNetworkSuspendedWindow()) {
      this.logger.info('浏览器网络挂起，延后远端任务存在性查询', {
        projectId,
        taskCount: taskIds.length,
        resumeDelayMs: getRemainingBrowserNetworkResumeDelayMs(),
      });
      return { existingIds, deferredBySuspension: true };
    }

    const CHUNK_SIZE = 100;
    for (let offset = 0; offset < taskIds.length; offset += CHUNK_SIZE) {
      const chunk = taskIds.slice(offset, offset + CHUNK_SIZE);
      let data: Array<{ id: string }> | null = null;
      let error: unknown | null = null;

      try {
        // 中文注释：必须排除软删除任务，避免为已删除任务同步连接
        ({ data, error } = await client
          .from('tasks')
          .select('id')
          .eq('project_id', projectId)
          .in('id', chunk)
          .is('deleted_at', null));
      } catch (queryError) {
        error = queryError;
      }

      if (error) {
        if (isBrowserNetworkSuspendedError(error) || isBrowserNetworkSuspendedWindow()) {
          this.logger.info('浏览器网络挂起，延后连接依赖校验', {
            projectId,
            chunkSize: chunk.length,
            resumeDelayMs: getRemainingBrowserNetworkResumeDelayMs(),
          });
          return { existingIds, deferredBySuspension: true };
        }

        const enhanced = supabaseErrorToError(error);
        this.logger.warn('查询远端任务存在性失败，连接依赖校验降级为本地成功集', {
          projectId,
          chunkSize: chunk.length,
          error: enhanced.message,
          errorType: enhanced.errorType,
        });
        return { existingIds, deferredBySuspension: false };
      }

      for (const row of (data || [])) {
        if (row.id) existingIds.add(String(row.id));
      }
    }

    return { existingIds, deferredBySuspension: false };
  }
  
  /**
   * 设置回调函数（由 SimpleSyncService 调用）
   */
  setCallbacks(callbacks: BatchSyncCallbacks): void {
    this.callbacks = callbacks;
  }
  
  /**
   * 批量保存项目到云端
   * 
   * 【关键修复】推送前检查 tombstones，防止已删除任务复活
   * 【P0 熔断层】推送前进行熔断校验
   */
  async saveProjectToCloud(
    project: Project,
    userId: string,
    taskIdsToDelete?: string[],
  ): Promise<BatchSyncResult> {
    const failedTaskIds: string[] = [];
    const failedConnectionIds: string[] = [];
    const retryEnqueued: string[] = [];
    let projectPushed = false;
    let taskPurgeSucceeded = true;

    if (!this.callbacks) {
      this.logger.error('BatchSyncService: 回调未初始化');
      return {
        success: false,
        failedTaskIds,
        failedConnectionIds,
        retryEnqueued,
        projectPushed,
        failureReason: 'BatchSync callbacks not initialized',
      };
    }

    const rawChanges = this.changeTracker.getProjectChanges(project.id);
    const changes = {
      tasksToCreate: rawChanges.tasksToCreate ?? [],
      tasksToUpdate: rawChanges.tasksToUpdate ?? [],
      taskIdsToDelete: rawChanges.taskIdsToDelete ?? [],
      connectionsToCreate: rawChanges.connectionsToCreate ?? [],
      connectionsToUpdate: rawChanges.connectionsToUpdate ?? [],
      connectionsToDelete: rawChanges.connectionsToDelete ?? [],
      taskUpdateFieldsById: rawChanges.taskUpdateFieldsById ?? {},
    };
    const pendingTaskIdsToDelete = taskIdsToDelete ?? changes.taskIdsToDelete;
    const durablyConfirmedRetryMarkers = new Set<string>();
    const recordRetryMarker = (marker: string): void => {
      if (!retryEnqueued.includes(marker)) {
        retryEnqueued.push(marker);
      }
    };
    const enqueueProjectRetry = async (): Promise<boolean> => {
      const confirmed = await this.callbacks!.addToRetryQueueDurably('project', 'upsert', project, undefined, userId, pendingTaskIdsToDelete);
      if (!confirmed) {
        return false;
      }

      const marker = `project:${project.id}`;
      recordRetryMarker(marker);
      durablyConfirmedRetryMarkers.add(marker);
      return true;
    };
    const confirmAccumulatedRetryMarkers = async (): Promise<void> => {
      const pendingMarkers = retryEnqueued.filter(marker => !durablyConfirmedRetryMarkers.has(marker));
      if (pendingMarkers.length === 0) {
        return;
      }

      const confirmed = await this.callbacks!.confirmRetryQueuePersistence();
      if (confirmed) {
        pendingMarkers.forEach(marker => durablyConfirmedRetryMarkers.add(marker));
        return;
      }

      const durableMarkers = retryEnqueued.filter(marker => durablyConfirmedRetryMarkers.has(marker));
      retryEnqueued.splice(0, retryEnqueued.length, ...durableMarkers);
    };
    
    // 本地模式快速退出
    if (userId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      this.logger.debug('本地模式，跳过云端同步');
      return {
        success: false,
        failedTaskIds,
        failedConnectionIds,
        retryEnqueued,
        projectPushed,
        failureReason: 'project sync skipped in local mode',
      };
    }

    // 网络感知检查
    if (!this.mobileSync.shouldAllowSync()) {
      this.logger.debug('网络感知: 同步被延迟', { projectId: project.id });
      await enqueueProjectRetry();
      return {
        success: false,
        failedTaskIds,
        failedConnectionIds,
        retryEnqueued,
        projectPushed,
        failureReason: 'project sync deferred by network awareness',
      };
    }

    // 熔断层校验
    const circuitValidation = this.circuitBreaker.validateBeforeSync(project);
    if (!circuitValidation.passed && circuitValidation.shouldBlock) {
      this.logger.error('熔断: 同步被阻止', { projectId: project.id });
      this.sentryLazyLoader.captureMessage('CircuitBreaker: Sync blocked', {
        level: 'error',
        tags: { operation: 'saveProjectToCloud', projectId: project.id }
      });
      return {
        success: false,
        failedTaskIds,
        failedConnectionIds,
        retryEnqueued,
        projectPushed,
        failureReason: 'project sync blocked by circuit breaker',
      };
    }
    
    const client = this.getSupabaseClient();
    if (!client) {
      await enqueueProjectRetry();
      return {
        success: false,
        failedTaskIds,
        failedConnectionIds,
        retryEnqueued,
        projectPushed,
        failureReason: 'supabase client unavailable for project sync',
      };
    }
    
    // Session 验证
    try {
      let { data: { session } } = await client.auth.getSession();
      let sessionUserId = session?.user?.id ?? null;

      if (!sessionUserId) {
        const refreshed = await this.sessionManager.tryRefreshSession('saveProjectToCloud.getSession');
        if (refreshed) {
          ({ data: { session } } = await client.auth.getSession());
          sessionUserId = session?.user?.id ?? null;
        }
      }

      if (!sessionUserId) {
        if (isBrowserNetworkSuspendedWindow()) {
          return this.deferProjectSyncForBrowserSuspension(
            project,
            userId,
            pendingTaskIdsToDelete,
            retryEnqueued,
            failedTaskIds,
            failedConnectionIds,
            projectPushed,
            'saveProjectToCloud.getSession'
          );
        }

        this.syncState.setSessionExpired(true);
        // 【NEW-3 修复】Session 过期时将项目数据入队，防止浏览器崩溃导致数据丢失
        await enqueueProjectRetry();
        this.logger.warn('Session 过期，项目数据已入重试队列', { projectId: project.id });
        this.toast.warning('登录已过期', '请重新登录以继续同步数据');
        return {
          success: false,
          failedTaskIds,
          failedConnectionIds,
          retryEnqueued,
          projectPushed,
          failureReason: 'project sync session expired',
        };
      }

      if (sessionUserId !== userId) {
        await enqueueProjectRetry();
        this.logger.warn('检测到项目批量同步 owner 与当前会话不匹配，已拒绝云端写入', {
          projectId: project.id,
          expectedUserId: userId,
          sessionUserId,
        });
        this.syncState.setSyncError('账号已切换，项目稍后将按原 owner 重试');
        return {
          success: false,
          failedTaskIds,
          failedConnectionIds,
          retryEnqueued,
          projectPushed,
          failureReason: 'project sync owner mismatch',
        };
      }
    } catch (e) {
      const enhanced = supabaseErrorToError(e);
      if (this.sessionManager.isSessionExpiredError(enhanced)) {
        this.logger.info('Session 预检命中认证错误，尝试刷新后继续项目批量同步', {
          projectId: project.id,
          userId,
          errorCode: enhanced.code,
        });
        const refreshed = await this.sessionManager.tryRefreshSession('saveProjectToCloud.getSession');

        if (refreshed) {
          try {
            const { data: { session } } = await client.auth.getSession();
            const sessionUserId = session?.user?.id ?? null;
            if (sessionUserId === userId) {
              this.logger.info('Session 刷新成功，继续项目批量同步', { projectId: project.id, userId });
            } else if (!sessionUserId) {
              if (isBrowserNetworkSuspendedWindow()) {
                return this.deferProjectSyncForBrowserSuspension(
                  project,
                  userId,
                  pendingTaskIdsToDelete,
                  retryEnqueued,
                  failedTaskIds,
                  failedConnectionIds,
                  projectPushed,
                  'saveProjectToCloud.getSession.afterRefresh'
                );
              }

              this.syncState.setSessionExpired(true);
              await enqueueProjectRetry();
              this.logger.warn('Session 刷新后仍无有效会话，项目数据已入重试队列', { projectId: project.id });
              this.toast.warning('登录已过期', '请重新登录以继续同步数据');
              return {
                success: false,
                failedTaskIds,
                failedConnectionIds,
                retryEnqueued,
                projectPushed,
                failureReason: 'project sync session expired after refresh',
              };
            } else {
              await enqueueProjectRetry();
              this.logger.warn('Session 刷新后项目同步 owner 与当前会话不匹配，已回退到原 owner 重试队列', {
                projectId: project.id,
                expectedUserId: userId,
                sessionUserId,
              });
              this.syncState.setSyncError('账号已切换，项目稍后将按原 owner 重试');
              return {
                success: false,
                failedTaskIds,
                failedConnectionIds,
                retryEnqueued,
                projectPushed,
                failureReason: 'project sync owner mismatch after refresh',
              };
            }
          } catch (retrySessionError) {
            if (isBrowserNetworkSuspendedError(retrySessionError) || isBrowserNetworkSuspendedWindow()) {
              return this.deferProjectSyncForBrowserSuspension(
                project,
                userId,
                pendingTaskIdsToDelete,
                retryEnqueued,
                failedTaskIds,
                failedConnectionIds,
                projectPushed,
                'saveProjectToCloud.getSession.retry'
              );
            }

            const retryEnhanced = supabaseErrorToError(retrySessionError);
            this.logger.warn('Session 刷新后再次校验失败，项目数据已入重试队列', {
              projectId: project.id,
              errorCode: retryEnhanced.code,
              errorType: retryEnhanced.errorType,
            });
            await enqueueProjectRetry();
            this.syncState.setSyncError(retryEnhanced.message);
            return {
              success: false,
              failedTaskIds,
              failedConnectionIds,
              retryEnqueued,
              projectPushed,
              failureReason: 'project sync session validation retried and deferred',
            };
          }

          // 刷新成功且会话校验通过时，继续后续批量同步逻辑。
        } else {
          if (isBrowserNetworkSuspendedWindow()) {
            return this.deferProjectSyncForBrowserSuspension(
              project,
              userId,
              pendingTaskIdsToDelete,
              retryEnqueued,
              failedTaskIds,
              failedConnectionIds,
              projectPushed,
              'saveProjectToCloud.getSession.refreshDeferred'
            );
          }

          this.logger.error('Session 验证失败', enhanced);
          this.syncState.setSessionExpired(true);
          await enqueueProjectRetry();
          this.logger.warn('Session 验证异常，项目数据已入重试队列', { projectId: project.id });
          this.toast.warning('登录已过期', '请重新登录以继续同步数据');
          return {
            success: false,
            failedTaskIds,
            failedConnectionIds,
            retryEnqueued,
            projectPushed,
            failureReason: 'project sync session validation failed',
          };
        }
      } else {
        this.logger.warn('Session 预检暂不可用，项目数据已入重试队列等待恢复', {
          projectId: project.id,
          errorCode: enhanced.code,
          errorType: enhanced.errorType,
        });
        await enqueueProjectRetry();
        this.syncState.setSyncError(enhanced.message);
        return {
          success: false,
          failedTaskIds,
          failedConnectionIds,
          retryEnqueued,
          projectPushed,
          failureReason: 'project sync session validation deferred',
        };
      }
    }
    
    this.syncState.setSyncing(true);
    
    // 【P2-16 修复】在推送前创建数据快照，防止推送期间 store 被用户编辑导致数据不一致
    // 【根因修复 2026-04-21】用 ChangeTracker 单调 revision 做清理水位：
    // 只清理不晚于 batchChangeRevision 的脏记录，保留期间用户产生的新编辑，避免同一毫秒碰撞。
    const batchChangeRevision = this.getBatchChangeRevision();
    const projectSnapshot: Project = {
      ...project,
      tasks: project.tasks.map(t => ({ ...t })),
      connections: project.connections.map(c => ({ ...c })),
    };
    
    try {
      // 1. 获取 tombstones，过滤已永久删除的任务
      const tombstoneIds = await this.callbacks.getTombstoneIds(projectSnapshot.id);
      const changedTaskIds = new Set([
        ...changes.tasksToCreate.map(task => task.id),
        ...changes.tasksToUpdate.map(task => task.id),
        ...changes.taskIdsToDelete,
      ]);
      const changedConnectionIds = new Set([
        ...changes.connectionsToCreate.map(connection => connection.id),
        ...changes.connectionsToUpdate.map(connection => connection.id),
        ...changes.connectionsToDelete.map(connection => connection.id),
      ]);
      const taskSnapshotById = new Map(projectSnapshot.tasks.map(task => [task.id, task]));
      const connectionSnapshotById = new Map(projectSnapshot.connections.map(connection => [connection.id, connection]));
      failedTaskIds.push(
        ...this.reconcileSuppressedEntities(
          this.suppressedTaskIds,
          project.id,
          (id, fingerprint) => {
            if (changedTaskIds.has(id)) {
              return false;
            }

            const task = taskSnapshotById.get(id);
            return !!task && this.createTaskConflictFingerprint(task) === fingerprint;
          },
        )
      );
      failedConnectionIds.push(
        ...this.reconcileSuppressedEntities(
          this.suppressedConnectionIds,
          project.id,
          (id, fingerprint) => {
            if (changedConnectionIds.has(id)) {
              return false;
            }

            const connection = connectionSnapshotById.get(id);
            return !!connection && this.createConnectionConflictFingerprint(connection) === fingerprint;
          },
        )
      );
      const tasksToSync = projectSnapshot.tasks.filter(task => {
        if (tombstoneIds.has(task.id)) {
          return false;
        }

        return !this.isEntitySuppressedUntilFreshEdit(
          this.suppressedTaskIds,
          projectSnapshot.id,
          task.id,
          changedTaskIds,
        );
      });
      const connectionTombstoneIds = await this.callbacks.getConnectionTombstoneIds(projectSnapshot.id);
      
      // 2. 保存项目元数据
      const projectPushResult = await this.callbacks.pushProject(
        projectSnapshot,
        false,
        userId,
        pendingTaskIdsToDelete,
      );
      projectPushed = projectPushResult.success;
      if (projectPushResult.conflict) {
        this.syncState.setSyncing(false);
        this.syncState.setSyncError('检测到版本冲突');
        return {
          success: false,
          conflict: true,
          remoteData: projectPushResult.remoteData,
          projectPushed,
          failedTaskIds,
          failedConnectionIds,
          retryEnqueued,
          failureReason: projectPushResult.failureReason ?? 'project sync version conflict',
        };
      }
      if (!projectPushed) {
        if (projectPushResult.retryEnqueued) {
          const marker = `project:${projectSnapshot.id}`;
          recordRetryMarker(marker);
          durablyConfirmedRetryMarkers.add(marker);
        }
        const failureReason = projectPushResult.failureReason ?? 'project metadata sync failed';
        this.syncState.setSyncing(false);
        if (projectPushResult.terminal) {
          this.syncState.setSyncError(failureReason);
        } else if (projectPushResult.retryEnqueued) {
          this.syncState.setSyncError(null);
        } else {
          this.syncState.setSyncError('项目元数据同步失败，已停止批量同步并等待重试');
        }
        return {
          success: false,
          projectPushed,
          failedTaskIds,
          failedConnectionIds,
          retryEnqueued,
          failureReason,
          terminal: projectPushResult.terminal,
        };
      }

      // 3. 处理永久删除的任务
      if (changes.taskIdsToDelete.length > 0) {
        for (const taskId of changes.taskIdsToDelete) {
          this.retryQueue.removeByEntity('task', taskId);
        }
        const purgeResult = await this.callbacks.purgeTasksFromCloud(projectSnapshot.id, changes.taskIdsToDelete, userId);
        taskPurgeSucceeded = purgeResult.success;
        if (taskPurgeSucceeded) {
          for (const taskId of changes.taskIdsToDelete) {
            this.changeTracker.clearTaskChange(projectSnapshot.id, taskId);
          }
        } else {
          failedTaskIds.push(...changes.taskIdsToDelete);
          retryEnqueued.push(...(purgeResult.retriedTaskIds ?? []).map(taskId => `task:${taskId}`));
        }
      }

      const deletedConnections = projectSnapshot.connections.filter(conn => {
        if (!conn.deletedAt) return false;
        if (connectionTombstoneIds.has(conn.id)) return false;
        if (this.isEntitySuppressedUntilFreshEdit(
          this.suppressedConnectionIds,
          projectSnapshot.id,
          conn.id,
          changedConnectionIds,
        )) {
          return false;
        }
        return true;
      });

      // 中文注释：批内挂起快速失败工具 —— tab 后台恢复或网络中断时一次性把剩余项整批入重试队列，
      // 避免 24/14 次逐项 RPC 都走 handlePushTaskError/BrowserNetworkSuspendedError 分支。
      const deferRemainingConnectionsOnSuspension = (
        connections: Connection[],
        startIndex: number,
        context: string
      ): boolean => {
        if (!isBrowserNetworkSuspendedWindow()) return false;
        const remaining = connections.slice(startIndex);
        if (remaining.length === 0) return true;
        this.logger.info('浏览器网络挂起，连接批同步中断并整批入重试队列', {
          projectId: projectSnapshot.id,
          context,
          remaining: remaining.length,
          resumeDelayMs: getRemainingBrowserNetworkResumeDelayMs(),
        });
        for (const conn of remaining) {
          failedConnectionIds.push(conn.id);
          if (this.callbacks!.addToRetryQueue('connection', 'upsert', conn, projectSnapshot.id, userId)) {
            retryEnqueued.push(`connection:${conn.id}`);
          }
        }
        return true;
      };

      for (let i = 0; i < deletedConnections.length; i++) {
        if (deferRemainingConnectionsOnSuspension(deletedConnections, i, 'deletedConnections')) {
          break;
        }
        if (i > 0) await this.delay(200);

        try {
          const connection = deletedConnections[i];
          this.retryQueue.removeByEntity('connection', connection.id);
          const connectionResult = await this.callbacks.pushConnection(
            connection,
            projectSnapshot.id,
            true,
            true,
            false,
            userId,
          );
          if (!connectionResult.success) {
            failedConnectionIds.push(connection.id);
            if (connectionResult.retryEnqueued) {
              retryEnqueued.push(`connection:${connection.id}`);
            }
          } else {
            // 【根因修复 2026-04-20】软删除连接上行成功即清脏记录，避免重推死循环。
            this.clearConnectionChangeAfterSuccessfulPush(projectSnapshot.id, connection.id, batchChangeRevision);
          }
        } catch (e) {
          if (isPermanentFailureError(e)) {
            const connectionId = deletedConnections[i].id;
            const clearedDirtyMarker = this.shouldClearDirtyMarkerAfterPermanentFailure(e);
            failedConnectionIds.push(connectionId);
            if (clearedDirtyMarker) {
              this.suppressEntityUntilFingerprintChanges(
                this.suppressedConnectionIds,
                projectSnapshot.id,
                connectionId,
                this.createConnectionConflictFingerprint(deletedConnections[i]),
              );
              this.clearConnectionChangeAfterSuccessfulPush(projectSnapshot.id, connectionId, batchChangeRevision);
            }
            this.logger.warn('跳过永久失败的已删除连接', { connectionId, clearedDirtyMarker });
            continue;
          }
          if (isBrowserNetworkSuspendedError(e)) {
            deferRemainingConnectionsOnSuspension(deletedConnections, i, 'deletedConnections.error');
            break;
          }
          throw e;
        }
      }
      
      // 4. 批量保存任务（拓扑排序）
      const sortedTasks = this.callbacks.topologicalSortTasks(tasksToSync);
      const taskUpdateFieldsById = changes.taskUpdateFieldsById;
      const successfulTaskIds = new Set<string>();

      // 中文注释：任务批内挂起快速失败 —— 与 deletedConnections 相同思路。
      const deferRemainingTasksOnSuspension = (startIndex: number, context: string): boolean => {
        if (!isBrowserNetworkSuspendedWindow()) return false;
        const remaining = sortedTasks.slice(startIndex);
        if (remaining.length === 0) return true;
        this.logger.info('浏览器网络挂起，任务批同步中断并整批入重试队列', {
          projectId: projectSnapshot.id,
          context,
          remaining: remaining.length,
          resumeDelayMs: getRemainingBrowserNetworkResumeDelayMs(),
        });
        for (const t of remaining) {
          failedTaskIds.push(t.id);
          if (this.callbacks!.addToRetryQueue('task', 'upsert', t, projectSnapshot.id, userId)) {
            retryEnqueued.push(`task:${t.id}`);
          }
        }
        return true;
      };

      for (let i = 0; i < sortedTasks.length; i++) {
        if (deferRemainingTasksOnSuspension(i, 'sortedTasks')) {
          break;
        }
        if (i > 0) await this.delay(200);
        
        try {
          const task = sortedTasks[i];
          this.retryQueue.removeByEntity('task', task.id);
          const changedFields = taskUpdateFieldsById[task.id];
          
          // 位置增量更新优化
          const isPositionOnlyUpdate = changedFields && 
            changedFields.length > 0 &&
            changedFields.every(f => f === 'x' || f === 'y' || f === 'rank');
          
          let taskResult: { success: boolean; retryEnqueued?: boolean };
          if (isPositionOnlyUpdate) {
            const positionSuccess = await this.callbacks.pushTaskPosition(
              task.id,
              task.x,
              task.y,
              projectSnapshot.id,
              task,
              userId,
            );
            // 位置增量更新失败时，立即回退到完整 upsert，避免 406 导致依赖断裂
            if (!positionSuccess) {
              // 【鲁棒性 2026-04-16】浏览器网络挂起：降级为 debug，避免控制台刷屏
              if (isBrowserNetworkSuspendedWindow()) {
                this.logger.debug('浏览器网络挂起，跳过位置增量回退', {
                  projectId: projectSnapshot.id,
                  taskId: task.id
                });
                failedTaskIds.push(task.id);
                continue;
              }
              this.logger.warn('任务位置增量推送失败，回退完整任务推送', {
                projectId: projectSnapshot.id,
                taskId: task.id
              });
              taskResult = await this.callbacks.pushTask(task, projectSnapshot.id, true, false, userId);
            } else {
              taskResult = { success: true };
            }
          } else {
            taskResult = await this.callbacks.pushTask(task, projectSnapshot.id, true, false, userId);
          }
          
          if (taskResult.success) {
            successfulTaskIds.add(task.id);
            // 【根因修复 2026-04-20】上行成功即清单项脏记录，解除"全或无"清理策略导致的
            // 无限重推循环：过去只在 batch 整体成功时才 clearProjectChanges，只要一项失败就
            // 永久保留所有成功项的 pending 记录，下一轮又整批重推（API 200 但 UI 待同步数永
            // 远不降）。使用 batchStartedAt 水位保护并发编辑：同步期间用户产生的新 edit 保留。
            this.clearTaskChangeAfterSuccessfulPush(projectSnapshot.id, task.id, batchChangeRevision);
          } else {
            failedTaskIds.push(task.id);
            if (taskResult.retryEnqueued) {
              retryEnqueued.push(`task:${task.id}`);
            }
          }
        } catch (e) {
          if (isPermanentFailureError(e)) {
            const taskId = sortedTasks[i].id;
            const clearedDirtyMarker = this.shouldClearDirtyMarkerAfterPermanentFailure(e);
            failedTaskIds.push(taskId);
            if (clearedDirtyMarker) {
              this.suppressEntityUntilFingerprintChanges(
                this.suppressedTaskIds,
                projectSnapshot.id,
                taskId,
                this.createTaskConflictFingerprint(sortedTasks[i]),
              );
              this.clearTaskChangeAfterSuccessfulPush(projectSnapshot.id, taskId, batchChangeRevision);
            }
            this.logger.warn('跳过永久失败的任务', { taskId, clearedDirtyMarker });
            continue;
          }
          if (isBrowserNetworkSuspendedError(e)) {
            deferRemainingTasksOnSuspension(i, 'sortedTasks.error');
            break;
          }
          throw e;
        }
      }
      
      // 5. 批量保存连接
      const activeConnections = projectSnapshot.connections.filter(conn => {
        if (conn.deletedAt) return false;
        if (connectionTombstoneIds.has(conn.id)) return false;
        if (this.isEntitySuppressedUntilFreshEdit(
          this.suppressedConnectionIds,
          projectSnapshot.id,
          conn.id,
          changedConnectionIds,
        )) {
          return false;
        }
        return true;
      });

      const referencedTaskIds = Array.from(
        new Set(activeConnections.flatMap(conn => [conn.source, conn.target]))
      );
      const remoteTaskLookup = await this.fetchRemoteExistingTaskIds(
        client,
        projectSnapshot.id,
        referencedTaskIds
      );
      const remoteExistingTaskIds = remoteTaskLookup.existingIds;
      const allSyncedTaskIds = new Set<string>(successfulTaskIds);
      remoteExistingTaskIds.forEach(taskId => {
        allSyncedTaskIds.add(taskId);
      });
      const purgedTaskIds = taskPurgeSucceeded
        ? new Set(changes.taskIdsToDelete)
        : new Set<string>();

      if (remoteTaskLookup.deferredBySuspension) {
        this.logger.info('浏览器网络挂起，延后连接批同步到重试队列', {
          projectId: projectSnapshot.id,
          connectionCount: activeConnections.length,
          resumeDelayMs: getRemainingBrowserNetworkResumeDelayMs(),
        });

        for (const connection of activeConnections) {
          const coveredByTaskPurge =
            purgedTaskIds.has(connection.source) || purgedTaskIds.has(connection.target);
          if (coveredByTaskPurge) {
            this.logger.info('连接已随 task purge 在云端删除，跳过无意义重试', {
              connectionId: connection.id,
              projectId: projectSnapshot.id,
              source: connection.source,
              target: connection.target,
            });
            // 【根因修复 2026-04-20】引用任务已在云端 purge，连接无需再推，直接清脏记录收口。
            this.clearConnectionChangeAfterSuccessfulPush(projectSnapshot.id, connection.id, batchChangeRevision);
            continue;
          }

          failedConnectionIds.push(connection.id);
          if (this.callbacks.addToRetryQueue('connection', 'upsert', connection, projectSnapshot.id, userId)) {
            retryEnqueued.push(`connection:${connection.id}`);
          }
        }
      } else {

      const blockedConnections: Connection[] = [];
      const connectionsToSync = activeConnections.filter(conn => {
        const ready =
          allSyncedTaskIds.has(conn.source) &&
          allSyncedTaskIds.has(conn.target);
        if (!ready) {
          blockedConnections.push(conn);
        }
        return ready;
      });

      for (const blocked of blockedConnections) {
        const coveredByTaskPurge =
          purgedTaskIds.has(blocked.source) || purgedTaskIds.has(blocked.target);
        if (coveredByTaskPurge) {
          this.logger.info('连接已随 task purge 在云端删除，跳过无意义重试', {
            connectionId: blocked.id,
            projectId: projectSnapshot.id,
            source: blocked.source,
            target: blocked.target,
          });
          // 【根因修复 2026-04-20】引用任务已 purge，连接无需再推，清脏记录收口避免无限重推。
          this.clearConnectionChangeAfterSuccessfulPush(projectSnapshot.id, blocked.id, batchChangeRevision);
          continue;
        }

        this.logger.warn('跳过连接（引用任务未同步）', {
          connectionId: blocked.id,
          projectId: projectSnapshot.id,
          source: blocked.source,
          target: blocked.target,
          sourceReady: allSyncedTaskIds.has(blocked.source),
          targetReady: allSyncedTaskIds.has(blocked.target)
        });
        failedConnectionIds.push(blocked.id);
        if (this.callbacks.addToRetryQueue('connection', 'upsert', blocked, projectSnapshot.id, userId)) {
          retryEnqueued.push(`connection:${blocked.id}`);
        }
      }
      
      for (let i = 0; i < connectionsToSync.length; i++) {
        if (deferRemainingConnectionsOnSuspension(connectionsToSync, i, 'connectionsToSync')) {
          break;
        }
        if (i > 0) await this.delay(200);
        
        try {
          const connection = connectionsToSync[i];
          this.retryQueue.removeByEntity('connection', connection.id);
          // 中文注释：此处已用批量查询构建 allSyncedTaskIds，避免 pushConnection 再次逐条查询 tasks 造成 N+1 校验风暴。
          const connectionResult = await this.callbacks.pushConnection(connection, projectSnapshot.id, true, true, false, userId);
          if (!connectionResult.success) {
            failedConnectionIds.push(connection.id);
            if (connectionResult.retryEnqueued) {
              retryEnqueued.push(`connection:${connection.id}`);
            }
          } else {
            // 【根因修复 2026-04-20】连接上行成功即清脏记录，解除"全或无"清理策略。
            this.clearConnectionChangeAfterSuccessfulPush(projectSnapshot.id, connection.id, batchChangeRevision);
          }
        } catch (e) {
          if (isPermanentFailureError(e)) {
            const connectionId = connectionsToSync[i].id;
            const clearedDirtyMarker = this.shouldClearDirtyMarkerAfterPermanentFailure(e);
            failedConnectionIds.push(connectionId);
            if (clearedDirtyMarker) {
              this.suppressEntityUntilFingerprintChanges(
                this.suppressedConnectionIds,
                projectSnapshot.id,
                connectionId,
                this.createConnectionConflictFingerprint(connectionsToSync[i]),
              );
              this.clearConnectionChangeAfterSuccessfulPush(projectSnapshot.id, connectionId, batchChangeRevision);
            }
            this.logger.warn('跳过永久失败的连接', { connectionId, clearedDirtyMarker });
            continue;
          }
          if (isBrowserNetworkSuspendedError(e)) {
            deferRemainingConnectionsOnSuspension(connectionsToSync, i, 'connectionsToSync.error');
            break;
          }
          throw e;
        }
      }
      }

      const success =
        projectPushed &&
        taskPurgeSucceeded &&
        failedTaskIds.length === 0 &&
        failedConnectionIds.length === 0;

      if (!success) {
        await confirmAccumulatedRetryMarkers();
      }

      // 中文注释：purge 失败会把 taskIdsToDelete 全部记录一次，而这些任务若仍在 projectSnapshot.tasks
      // 中（deletedAt 置位但 tombstone 未落地），可能又在 upsert 循环被记第二次，需要在对外返回前去重，
      // 防止"24 项任务失败"类聚合计数虚高、误导用户与重试队列观测。
      const dedupedFailedTaskIds = Array.from(new Set(failedTaskIds));
      const dedupedFailedConnectionIds = Array.from(new Set(failedConnectionIds));
      const dedupedRetryEnqueued = Array.from(new Set(retryEnqueued));
      const terminalTaskIds = new Set<string>(
        Array.from((this.suppressedTaskIds.get(project.id) ?? new Map<string, string>()).keys())
      );
      const terminalConnectionIds = new Set<string>(
        Array.from((this.suppressedConnectionIds.get(project.id) ?? new Map<string, string>()).keys())
      );
      const hasTerminalConflicts =
        dedupedFailedTaskIds.some(id => terminalTaskIds.has(id)) ||
        dedupedFailedConnectionIds.some(id => terminalConnectionIds.has(id));
      
      const retryEnqueuedSet = new Set(dedupedRetryEnqueued);
      const allTasksResolved = dedupedFailedTaskIds.every(
        id => retryEnqueuedSet.has(`task:${id}`) || terminalTaskIds.has(id)
      );
      const allConnectionsResolved = dedupedFailedConnectionIds.every(
        id => retryEnqueuedSet.has(`connection:${id}`) || terminalConnectionIds.has(id)
      );
      const projectHandedOff = projectPushed || retryEnqueuedSet.has(`project:${project.id}`);
      const fullyResolved =
        projectHandedOff && allTasksResolved && allConnectionsResolved;

      this.syncState.setSyncing(false);
      if (success) {
        this.markBatchSyncSuccess();
        this.syncState.setSyncError(null);
      } else {
        // 【根因修复 2026-04-22】失败分支此前无条件写 syncError，即使所有失败项都已入
        // RetryQueue（后续回放会推 markSyncRecoveredIfIdle 收口），红错条也会停留到下一
        // 次成功 batch 为止。重新评估失败归宿：
        //  - 所有失败（包括 project 自身）都进了 RetryQueue → 视为"已自愈"交接，不写
        //    syncError（保留 pendingCount 提示足矣）；RetryQueue 回放成功后会自动清错。
        //  - 存在未入队失败（RetryQueue 已满/存储冻结/project 重试入队失败）→ 才写红错。
        if (fullyResolved) {
          this.syncState.setSyncError(hasTerminalConflicts ? '检测到版本冲突，请刷新后重试' : null);
        } else {
          if (hasTerminalConflicts) {
            this.syncState.setSyncError('部分同步失败，且存在版本冲突，请刷新后重试');
          } else {
            this.scheduleRecoverableSyncError(RECOVERABLE_SYNC_ERROR_MESSAGES.PARTIAL_RETRY_HANDOFF, {
              projectId: project.id,
              failedTaskCount: dedupedFailedTaskIds.length,
              failedConnectionCount: dedupedFailedConnectionIds.length,
              retryEnqueuedCount: dedupedRetryEnqueued.length,
            });
          }
        }
      }
      
      // 更新熔断器已知任务数
      this.circuitBreaker.updateLastKnownTaskCount(project.id, tasksToSync.length);
      
      return {
        success,
        newVersion: project.version,
        projectPushed,
        failedTaskIds: dedupedFailedTaskIds,
        failedConnectionIds: dedupedFailedConnectionIds,
        retryEnqueued: dedupedRetryEnqueued,
        partialRetryHandoff: success ? undefined : !fullyResolved,
        failureReason: success
          ? undefined
          : hasTerminalConflicts
            ? fullyResolved
              ? 'project batch sync finished with terminal conflicts'
              : 'project batch sync finished with terminal conflicts and partial retry handoff'
            : fullyResolved
              ? 'project batch sync delegated remaining work to retry queue'
              : 'project batch sync partially delegated; some failures did not enter retry queue'
      };
    } catch (e) {
      if (!retryEnqueued.includes(`project:${project.id}`)) {
        await enqueueProjectRetry();
      }
      await confirmAccumulatedRetryMarkers();
      this.logger.error('保存项目失败', e);
      this.sentryLazyLoader.captureException(e, {
        tags: { operation: 'saveProjectToCloud' },
        extra: { projectId: project.id }
      });
      this.syncState.setSyncing(false);
      this.syncState.setSyncError('保存失败');
      return {
        success: false,
        projectPushed,
        failedTaskIds: Array.from(new Set(failedTaskIds)),
        failedConnectionIds: Array.from(new Set(failedConnectionIds)),
        retryEnqueued: Array.from(new Set(retryEnqueued)),
        failureReason: e instanceof Error ? e.message : 'project batch sync failed unexpectedly'
      };
    }
  }
}
