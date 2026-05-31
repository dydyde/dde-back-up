/**
 * TaskSyncOperationsService - 任务同步操作服务
 * 
 * 职责：
 * - 推送任务到云端（pushTask, pushTaskPosition）
 * - 拉取任务（pullTasks）
 * - 删除任务（deleteTask, softDeleteTasksBatch, purgeTasksFromCloud）
 * - Tombstone 管理（本地缓存 + 云端查询）
 * 
 * 从 SimpleSyncService 提取，作为技术债务修复的一部分
 * 目标：将 SimpleSyncService 从 3499 行减少到 ≤800 行
 */

import { Injectable, inject } from '@angular/core';
import { SupabaseClientService } from '../../../../services/supabase-client.service';
import { LoggerService } from '../../../../services/logger.service';
import { ToastService } from '../../../../services/toast.service';
import { RequestThrottleService } from '../../../../services/request-throttle.service';
import { ClockSyncService } from '../../../../services/clock-sync.service';
import { SyncOperationHelperService } from './sync-operation-helper.service';
import { SessionManagerService } from './session-manager.service';
import { TombstoneService } from './tombstone.service';
import { ProjectDataService } from './project-data.service';
import { RetryQueueService } from './retry-queue.service';
import { SyncStateService } from './sync-state.service';
import { TaskStore } from '../../state/stores';
import { Task } from '../../../../models';
import { TaskRow } from '../../../../models/supabase-types';
import { nowISO } from '../../../../utils/date';
import {
  supabaseErrorToError,
  EnhancedError,
  classifySupabaseClientFailure
} from '../../../../utils/supabase-error';
import { isPermanentFailureError, PermanentFailureError } from '../../../../utils/permanent-failure-error';
import { REQUEST_THROTTLE_CONFIG, FIELD_SELECT_CONFIG, FLOATING_TREE_CONFIG } from '../../../../config';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import { SyncRpcClientService, type SyncRpcResult } from '../../../../services/sync-rpc-client.service';
import {
  createBrowserNetworkSuspendedError,
  isBrowserNetworkSuspendedWindow,
} from '../../../../utils/browser-network-suspension';
import {
  getCompatibleTaskSelectFields,
  getCompatibleTaskWriteRow,
  markTaskCompletedAtColumnUnavailable,
  omitTaskCompletedAtColumn,
} from '../../../../utils/task-schema-compat';

const MISSING_TASK_TIMESTAMP_REASON = 'missing_task_timestamp';

/** Tombstone 查询结果 */
export interface TombstoneQueryResult {
  ids: Set<string>;
  fromRemote: boolean;
  localCacheOnly: boolean;
  timestamp: number;
}

@Injectable({
  providedIn: 'root'
})
export class TaskSyncOperationsService {
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly supabase = inject(SupabaseClientService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('TaskSyncOps');
  private readonly toast = inject(ToastService);
  private readonly throttle = inject(RequestThrottleService);
  private readonly clockSync = inject(ClockSyncService);
  private readonly syncOpHelper = inject(SyncOperationHelperService);
  private readonly sessionManager = inject(SessionManagerService);
  private readonly tombstoneService = inject(TombstoneService);
  private readonly projectDataService = inject(ProjectDataService);
  private readonly retryQueueService = inject(RetryQueueService);
  private readonly syncStateService = inject(SyncStateService);
  private readonly taskStore = inject(TaskStore, { optional: true });
  private readonly syncRpcClient = inject(SyncRpcClientService, { optional: true });
  
  /**
   * 安全添加到重试队列（含会话和数据有效性检查）
   * 替代之前的 setCallbacks 回调模式，直接使用注入的服务
   */
  private safeAddToRetryQueue(
    type: 'task' | 'project' | 'connection',
    operation: 'upsert' | 'delete',
    data: Task | { id: string },
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
  
  /** 获取 Supabase 客户端，离线返回 null */
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
      // eslint-disable-next-line no-restricted-syntax -- 调用方以 null 识别客户端不可用并走重试/降级路径
      return null;
    }
  }
  
  /** Sentry 异常捕获（自动清洗 PII） */
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

  private settleDeletedTaskDependencies(projectId: string, taskIds: string[]): void {
    const removedTaskIds = this.retryQueueService.removeByEntities('task', taskIds);
    const removedConnectionIds = this.retryQueueService.removeConnectionsReferencingTasks(projectId, taskIds);
    if (removedTaskIds.length === 0 && removedConnectionIds.length === 0) {
      return;
    }

    this.logger.info('任务删除成功后已清理关联重试项', {
      projectId,
      taskCount: taskIds.length,
      removedTaskRetryCount: removedTaskIds.length,
      removedConnectionCount: removedConnectionIds.length,
    });
  }

  private normalizeLocalTaskUpdatedAt(task: Task, projectId: string, serverUpdatedAt?: string | null): void {
    if (!serverUpdatedAt) {
      return;
    }

    const currentTask = this.taskStore?.getTask(task.id);
    if (currentTask) {
      this.taskStore?.setTask({ ...currentTask, updatedAt: serverUpdatedAt }, projectId);
    }
    task.updatedAt = serverUpdatedAt;
    this.clockSync.recordServerTimestamp(serverUpdatedAt, task.id);
  }

  private createRemoteNewerConflictError(
    taskId: string,
    projectId: string,
    remoteUpdatedAt: string | null,
    reason: 'remote-newer' | 'remote-tombstone',
  ): EnhancedError {
    return Object.assign(
      new Error('版本冲突：数据已被修改，请刷新后重试'),
      {
        name: 'VersionConflictError',
        errorType: 'VersionConflictError',
        code: reason === 'remote-tombstone' ? 'TASK_REMOTE_TOMBSTONE_NEWER' : 'TASK_REMOTE_NEWER',
        isRetryable: false,
        details: `taskId=${taskId}, projectId=${projectId}, remoteUpdatedAt=${remoteUpdatedAt ?? 'unknown'}`,
      },
    ) as EnhancedError;
  }

  private createMissingTaskTimestampConflictError(
    taskId: string,
    projectId: string,
    remoteUpdatedAt: string | null,
  ): EnhancedError {
    return Object.assign(
      new Error('任务缺少本地更新时间，已放弃旧写入并等待远端权威数据覆盖'),
      {
        name: 'VersionConflictError',
        errorType: 'VersionConflictError',
        code: 'TASK_REMOTE_NEWER',
        isRetryable: false,
        details: `taskId=${taskId}, projectId=${projectId}, remoteUpdatedAt=${remoteUpdatedAt ?? 'unknown'}, reason=${MISSING_TASK_TIMESTAMP_REASON}`,
      },
    ) as EnhancedError;
  }

  private isMissingTaskTimestampRejection(result: SyncRpcResult): boolean {
    return result.status === 'remote-newer' && result.reason === MISSING_TASK_TIMESTAMP_REASON;
  }

  private throwMissingTaskTimestampPermanentFailure(
    task: Task,
    projectId: string,
    result: SyncRpcResult,
  ): never {
    this.logger.info('pushTask: 丢弃缺少 updatedAt 的旧任务写入，等待远端权威数据覆盖', {
      taskId: task.id,
      projectId,
      remoteUpdatedAt: result.remoteUpdatedAt,
      reason: result.reason,
    });

    throw new PermanentFailureError(
      'Task missing local updatedAt rejected by sync RPC',
      this.createMissingTaskTimestampConflictError(task.id, projectId, result.remoteUpdatedAt ?? null),
      {
        operation: 'pushTask',
        taskId: task.id,
        projectId,
        reason: MISSING_TASK_TIMESTAMP_REASON,
        remoteUpdatedAt: result.remoteUpdatedAt ?? null,
      },
    );
  }

  private handleRemoteNewerTaskSyncRpcResult(
    result: SyncRpcResult,
    task: Task,
    projectId: string,
    fromRetryQueue: boolean,
    sourceUserId: string | undefined,
  ): boolean {
    if (this.isMissingTaskTimestampRejection(result)) {
      this.throwMissingTaskTimestampPermanentFailure(task, projectId, result);
    }

    this.logger.warn('pushTask: sync RPC CAS 拒绝，远端版本更新', {
      taskId: task.id,
      projectId,
      remoteUpdatedAt: result.remoteUpdatedAt,
      reason: result.reason,
    });
    this.sentryLazyLoader.captureMessage('sync_rpc_task_remote_newer', {
      level: 'warning',
      tags: { operation: 'pushTask', entityType: 'task', status: result.status },
      extra: { taskId: task.id, projectId, remoteUpdatedAt: result.remoteUpdatedAt, reason: result.reason },
    });
    if (!fromRetryQueue) {
      this.safeAddToRetryQueue('task', 'upsert', task, projectId, sourceUserId);
    }
    return false;
  }

  private createClockUncertainError(
    taskId: string,
    projectId: string,
    localUpdatedAt: string | null,
    remoteUpdatedAt: string | null,
  ): EnhancedError {
    return Object.assign(
      new Error('无法确认本地时间基线，已延后同步以避免覆盖远端更新'),
      {
        name: 'ClockSyncUncertainError',
        errorType: 'ClockSyncUncertainError',
        code: 'TASK_CLOCK_SYNC_UNCERTAIN',
        isRetryable: true,
        details: `taskId=${taskId}, projectId=${projectId}, localUpdatedAt=${localUpdatedAt ?? 'unknown'}, remoteUpdatedAt=${remoteUpdatedAt ?? 'unknown'}`,
      },
    ) as EnhancedError;
  }

  private async loadRemoteTaskFreshness(
    client: SupabaseClient,
    taskId: string,
    projectId: string,
  ): Promise<{ updatedAt: string | null; deletedAt: string | null } | null> {
    const { data, error } = await client
      .from('tasks')
      .select('id,updated_at,deleted_at')
      .eq('id', taskId)
      .eq('project_id', projectId)
      .maybeSingle();

    if (error) {
      throw supabaseErrorToError(error);
    }

    if (!data) {
      return null;
    }

    const row = data as { updated_at?: string | null; deleted_at?: string | null };
    return {
      updatedAt: typeof row.updated_at === 'string' ? row.updated_at : null,
      deletedAt: typeof row.deleted_at === 'string' ? row.deleted_at : null,
    };
  }

  private applyTaskPositionSnapshot(
    taskId: string,
    projectId: string | undefined,
    fallbackTask: Task | undefined,
    x: number,
    y: number,
    serverUpdatedAt?: string | null,
  ): void {
    if (projectId) {
      const currentTask = this.taskStore?.getTask(taskId);
      if (currentTask) {
        this.taskStore?.setTask({
          ...currentTask,
          x,
          y,
          ...(serverUpdatedAt ? { updatedAt: serverUpdatedAt } : {}),
        }, projectId);
      }
    }

    if (!fallbackTask) {
      return;
    }

    fallbackTask.x = x;
    fallbackTask.y = y;
    if (serverUpdatedAt) {
      fallbackTask.updatedAt = serverUpdatedAt;
    }
  }

  private markSessionExpiredWithoutThrow(
    context: string,
    details?: Record<string, unknown>,
  ): void {
    try {
      this.sessionManager.handleSessionExpired(context, details);
    } catch (error) {
      this.logger.debug('会话已标记为过期，保留当前变更等待恢复后重试', {
        context,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private preserveTaskUpsertForSessionExpiry(
    task: Task,
    projectId: string,
    fromRetryQueue: boolean,
    sourceUserId: string | undefined,
    context: string,
    details?: Record<string, unknown>,
  ): boolean {
    if (isBrowserNetworkSuspendedWindow()) {
      if (fromRetryQueue) {
        throw createBrowserNetworkSuspendedError();
      }

      if (!fromRetryQueue) {
        this.safeAddToRetryQueue('task', 'upsert', task, projectId, sourceUserId, true);
      }
      this.logger.info('浏览器网络挂起，延后任务同步', {
        taskId: task.id,
        projectId,
        context,
        ...details,
      });
      return false;
    }

    if (!fromRetryQueue) {
      this.safeAddToRetryQueue('task', 'upsert', task, projectId, sourceUserId, true);
    }
    this.markSessionExpiredWithoutThrow(context, details);
    return false;
  }

  private queueTaskDeletesForRetry(
    taskIds: string[],
    projectId: string,
    fromRetryQueue: boolean,
    sourceUserId: string | undefined,
    allowWhenSessionExpired = false,
  ): void {
    if (fromRetryQueue) {
      return;
    }

    for (const taskId of taskIds) {
      this.safeAddToRetryQueue('task', 'delete', { id: taskId }, projectId, sourceUserId, allowWhenSessionExpired);
    }
  }

  private preserveTaskDeleteForSessionExpiry(
    taskIds: string[],
    projectId: string,
    fromRetryQueue: boolean,
    sourceUserId: string | undefined,
    context: string,
    details?: Record<string, unknown>,
  ): boolean {
    if (isBrowserNetworkSuspendedWindow()) {
      if (fromRetryQueue) {
        throw createBrowserNetworkSuspendedError();
      }

      this.queueTaskDeletesForRetry(taskIds, projectId, fromRetryQueue, sourceUserId, true);
      this.logger.info('浏览器网络挂起，延后任务删除同步', {
        taskIds,
        projectId,
        context,
        ...details,
      });
      return false;
    }

    this.queueTaskDeletesForRetry(taskIds, projectId, fromRetryQueue, sourceUserId, true);
    this.markSessionExpiredWithoutThrow(context, details);
    return false;
  }
  
  // 任务同步操作

  /** 推送任务到云端（LWW upsert，支持 tombstone 检查和重试队列） */
  async pushTask(
    task: Task,
    projectId: string,
    skipTombstoneCheck = false,
    fromRetryQueue = false,
    sourceUserId?: string,
    treatTombstoneAsPermanent = false,
  ): Promise<boolean> {
    // 会话过期检查
    if (this.syncStateService.isSessionExpired()) {
      return this.preserveTaskUpsertForSessionExpiry(
        task,
        projectId,
        fromRetryQueue,
        sourceUserId,
        'pushTask',
        { taskId: task.id, projectId },
      );
    }
    
    // Circuit Breaker 检查
    if (!this.retryQueueService.checkCircuitBreaker()) {
      this.logger.debug('Circuit Breaker: 熔断中，跳过推送', { taskId: task.id });
      if (!fromRetryQueue) {
        this.safeAddToRetryQueue('task', 'upsert', task, projectId, sourceUserId);
      }
      return false;
    }
    
    const client = this.getSupabaseClient();
    if (!client) {
      if (!fromRetryQueue) {
        this.safeAddToRetryQueue('task', 'upsert', task, projectId, sourceUserId);
      }
      return false;
    }
    
    // 支持自动刷新后重试的内部执行函数
    const executeTaskPush = async (): Promise<boolean> => {
      const { data: { session } } = await client.auth.getSession();
      let sessionUserId = session?.user?.id ?? null;
      if (!sessionUserId) {
        const refreshed = await this.sessionManager.tryRefreshSession('pushTask.getSession');
        if (refreshed) {
          const { data: { session: newSession } } = await client.auth.getSession();
          sessionUserId = newSession?.user?.id ?? null;
        }
      }

      if (!sessionUserId) {
        return this.preserveTaskUpsertForSessionExpiry(
          task,
          projectId,
          fromRetryQueue,
          sourceUserId,
          'pushTask.getSession',
          { taskId: task.id, projectId },
        );
      }

      if (sourceUserId && sessionUserId !== sourceUserId) {
        this.logger.warn('检测到任务同步归属与当前会话不匹配，已拒绝云端写入', {
          taskId: task.id,
          projectId,
          sourceUserId,
          sessionUserId,
        });
        if (!fromRetryQueue) {
          this.safeAddToRetryQueue('task', 'upsert', task, projectId, sourceUserId);
        }
        return false;
      }
      
      return await this.doTaskPush(
        client,
        task,
        projectId,
        skipTombstoneCheck,
        fromRetryQueue,
        sourceUserId,
        treatTombstoneAsPermanent,
      );
    };
    
    try {
      return await executeTaskPush();
    } catch (e) {
      if (isPermanentFailureError(e)) {
        throw e;
      }

      const enhanced = e && typeof e === 'object' && 'errorType' in e
        ? e as EnhancedError
        : supabaseErrorToError(e);
      
      // 检测到认证错误时先尝试刷新 session
      if (this.sessionManager.isSessionExpiredError(enhanced)) {
        this.logger.info('检测到认证错误，尝试刷新会话后重试', { 
          taskId: task.id, 
          projectId,
          errorCode: enhanced.code 
        });
        
        const canRetry = await this.sessionManager.handleAuthErrorWithRefresh('pushTask', { 
          taskId: task.id, 
          projectId, 
          errorCode: enhanced.code 
        });
        
        if (canRetry) {
          try {
            return await executeTaskPush();
          } catch (retryError) {
            const retryEnhanced = retryError && typeof retryError === 'object' && 'errorType' in retryError
              ? retryError as EnhancedError
              : supabaseErrorToError(retryError);
            if (this.sessionManager.isSessionExpiredError(retryEnhanced)) {
              // 会话刷新成功后重试仍然失败
              if (this.sessionManager.isRlsPolicyViolation(retryEnhanced)) {
                // 42501: RLS 策略违规，真正的权限不足，非会话过期
                this.logger.warn('刷新会话后重试仍获 RLS 违规，判定为权限不足', {
                  taskId: task.id, projectId, errorCode: retryEnhanced.code,
                });
                if (fromRetryQueue) {
                  throw new PermanentFailureError(
                    'Task tombstone lookup denied after refresh',
                    retryEnhanced,
                    { operation: 'pushTask.retryAfterRefresh', taskId: task.id, projectId }
                  );
                }
                return false;
              }
              return this.preserveTaskUpsertForSessionExpiry(
                task,
                projectId,
                fromRetryQueue,
                sourceUserId,
                'pushTask.retryAfterRefresh',
                {
                  taskId: task.id,
                  projectId,
                  errorCode: retryEnhanced.code,
                },
              );
            }
            return this.handlePushTaskError(retryEnhanced, task, projectId, fromRetryQueue, sourceUserId);
          }
        } else {
          return this.preserveTaskUpsertForSessionExpiry(
            task,
            projectId,
            fromRetryQueue,
            sourceUserId,
            'pushTask',
            { taskId: task.id, projectId, errorCode: enhanced.code },
          );
        }
      }
      
      return this.handlePushTaskError(enhanced, task, projectId, fromRetryQueue, sourceUserId);
    }
  }
  
  /** 执行任务推送操作 */
  private async doTaskPush(
    client: SupabaseClient, 
    task: Task, 
    projectId: string, 
    skipTombstoneCheck: boolean,
    fromRetryQueue: boolean,
    sourceUserId: string | undefined,
    treatTombstoneAsPermanent: boolean,
  ): Promise<boolean> {
    let blockedByTombstone = false;
    let pushed = false;
    let blockedBySyncRpc = false;

    await this.throttle.execute(
      `push-task:${task.id}`,
      async () => {
        // 防御层：tombstone 检查
        if (!skipTombstoneCheck) {
          const { data: tombstone, error: tombstoneError } = await client
            .from('task_tombstones')
            .select('task_id')
            .eq('task_id', task.id)
            .maybeSingle();

          if (tombstoneError) {
            throw supabaseErrorToError(tombstoneError);
          }
          
          if (tombstone) {
            this.logger.info('pushTask: 跳过已删除任务（tombstone 防护）', { 
              taskId: task.id, 
              projectId 
            });
            blockedByTombstone = true;
            return;
          }
        }
        
        await this.syncOpHelper.retryWithBackoff(async () => {
          await this.primeTaskSyncRpcCapability();

          if (this.syncRpcClient?.isClientRejected() === true) {
            this.reportTaskSyncRpcClientRejected('pushTask', {
              taskId: task.id,
              projectId,
            });
            blockedBySyncRpc = true;
            return;
          }

          if (this.shouldUseSyncRpc()) {
            const operationId = this.createSyncRpcOperationId();
            const result = await this.syncRpcClient!.upsertTask({
              operationId,
              task,
              projectId,
              baseUpdatedAt: task.updatedAt ?? null,
            });

            pushed = this.handleTaskSyncRpcResult(
              result,
              task,
              projectId,
              fromRetryQueue,
              sourceUserId,
            );
            blockedBySyncRpc = !pushed;
            return;
          }

          const remoteTask = await this.loadRemoteTaskFreshness(client, task.id, projectId);
          const remoteHasTombstone = !!remoteTask?.deletedAt;
          const remoteUpdatedAt = remoteTask?.updatedAt ?? null;
          const localUpdatedAt = task.updatedAt ?? null;
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
              task.id,
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
              task.id,
              projectId,
              remoteTask?.updatedAt ?? remoteTask?.deletedAt ?? null,
              remoteHasTombstone ? 'remote-tombstone' : 'remote-newer',
            );
          }

          const row = {
            id: task.id,
            project_id: projectId,
            title: task.title,
            content: task.content,
            stage: task.stage,
            parent_id: task.parentId,
            order: task.order,
            rank: task.rank,
            status: task.status,
            x: task.x,
            y: task.y,
            short_id: task.shortId,
            priority: task.priority ?? null,
            due_date: task.dueDate ?? null,
            expected_minutes: task.expected_minutes ?? null,
            cognitive_load: task.cognitive_load ?? null,
            wait_minutes: task.wait_minutes ?? null,
            tags: task.tags ?? [],
            completed_at: task.completedAt ?? null,
            deleted_at: task.deletedAt || null,
            attachments: task.attachments ?? [],
            // State Overlap 停泊元数据（A3.2/A3.6）
            parking_meta: task.parkingMeta ?? null,
          };
          const writeTask = async (payload: typeof row | Omit<typeof row, 'completed_at'>) => {
            if (remoteTask?.updatedAt) {
              const { data, error } = await client
                .from('tasks')
                .update(payload)
                .eq('id', task.id)
                .eq('project_id', projectId)
                .eq('updated_at', remoteTask.updatedAt)
                .select('updated_at')
                .maybeSingle();

              if (!error && !data) {
                throw this.createRemoteNewerConflictError(
                  task.id,
                  projectId,
                  remoteTask.updatedAt,
                  'remote-newer',
                );
              }

              return { data, error };
            }

            if (remoteTask) {
              throw this.createRemoteNewerConflictError(
                task.id,
                projectId,
                remoteTask.updatedAt ?? remoteTask.deletedAt ?? null,
                'remote-newer',
              );
            }

            const result = await client
              .from('tasks')
              .insert(payload)
              .select('updated_at')
              .maybeSingle();

            const code = (result.error as { code?: string | number } | null)?.code;
            if (result.error && (code === '23505' || code === 23505)) {
              throw this.createRemoteNewerConflictError(
                task.id,
                projectId,
                task.updatedAt ?? null,
                'remote-newer',
              );
            }

            if (!result.error && !result.data) {
              throw this.createRemoteNewerConflictError(
                task.id,
                projectId,
                task.updatedAt ?? null,
                'remote-newer',
              );
            }

            return result;
          };

          let { data: upsertedData, error } = await writeTask(getCompatibleTaskWriteRow(row));
          if (error && markTaskCompletedAtColumnUnavailable(error)) {
            this.logger.warn('tasks.completed_at 缺失，任务推送已降级为旧 schema 写入', {
              taskId: task.id,
              projectId,
              error,
            });
            ({ data: upsertedData, error } = await writeTask(omitTaskCompletedAtColumn(row)));
          }
          
          if (error) throw supabaseErrorToError(error);
          
          if (upsertedData?.updated_at) {
            this.normalizeLocalTaskUpdatedAt(task, projectId, upsertedData.updated_at);
          }
          pushed = true;
        });
      },
      { priority: 'normal', retries: 0, timeout: REQUEST_THROTTLE_CONFIG.INDIVIDUAL_OPERATION_TIMEOUT }
    );

    if (blockedByTombstone) {
      if (fromRetryQueue || treatTombstoneAsPermanent) {
        throw new PermanentFailureError(
          'Task tombstone prevented remote upsert',
          new Error('Task tombstone prevented remote upsert'),
          { operation: 'pushTaskTombstone', taskId: task.id, projectId }
        );
      }
      return false;
    }

    if (blockedBySyncRpc || !pushed) {
      return false;
    }
    
    this.retryQueueService.recordCircuitSuccess();
    this.syncStateService.advanceLastSyncTimeIfIdle(nowISO());
    return true;
  }

  private shouldUseSyncRpc(): boolean {
    return this.syncRpcClient?.isFeatureEnabled() === true && this.syncRpcClient.isClientRejected() === false;
  }

  private async primeTaskSyncRpcCapability(): Promise<void> {
    if (!this.syncRpcClient) {
      return;
    }

    if (this.shouldUseSyncRpc() || this.syncRpcClient.isClientRejected() === true) {
      return;
    }

    await this.syncRpcClient.checkProtocol();
  }

  private reportTaskSyncRpcClientRejected(
    operation: 'pushTask' | 'pushTaskPosition' | 'softDeleteTasksBatch' | 'purgeTasksFromCloud',
    extra: Record<string, unknown>,
  ): void {
    const message = '当前客户端同步协议已过期，请刷新后重试';

    this.syncStateService.setSyncError(message);
    this.logger.warn(`${operation}: sync RPC 探测判定客户端已过期`, extra);
    this.sentryLazyLoader.captureMessage('sync_rpc_task_probe_rejected', {
      level: 'warning',
      tags: { operation, entityType: 'task', status: 'client-version-rejected' },
      extra,
    });
  }

  private createSyncRpcOperationId(): string {
    return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  private handleTaskSyncRpcResult(
    result: SyncRpcResult,
    task: Task,
    projectId: string,
    fromRetryQueue: boolean,
    sourceUserId: string | undefined,
  ): boolean {
    if (result.status === 'applied' || result.status === 'idempotent-replay') {
      if (result.serverUpdatedAt) {
        this.normalizeLocalTaskUpdatedAt(task, projectId, result.serverUpdatedAt);
      }
      this.logger.debug('pushTask: sync RPC 写入成功', {
        taskId: task.id,
        projectId,
        status: result.status,
      });
      return true;
    }

    if (result.status === 'remote-newer') {
      return this.handleRemoteNewerTaskSyncRpcResult(result, task, projectId, fromRetryQueue, sourceUserId);
    }

    const message = result.status === 'client-version-rejected'
      ? '当前客户端同步协议已过期，请刷新后重试'
      : '同步写入被服务端拒绝，已保留本地变更等待重试';
    this.syncStateService.setSyncError(message);
    this.logger.warn('pushTask: sync RPC 拒绝写入', {
      taskId: task.id,
      projectId,
      status: result.status,
      reason: result.reason,
      minProtocolVersion: result.minProtocolVersion,
    });
    this.sentryLazyLoader.captureMessage('sync_rpc_task_rejected', {
      level: 'warning',
      tags: { operation: 'pushTask', entityType: 'task', status: result.status },
      extra: { taskId: task.id, projectId, reason: result.reason, minProtocolVersion: result.minProtocolVersion },
    });
    if (!fromRetryQueue) {
      this.safeAddToRetryQueue('task', 'upsert', task, projectId, sourceUserId);
    }
    return false;
  }
  
  /** 处理 pushTask 错误 */
  private handlePushTaskError(
    enhanced: EnhancedError,
    task: Task,
    projectId: string,
    fromRetryQueue = false,
    sourceUserId?: string,
  ): boolean {
    if (enhanced.errorType === 'BrowserNetworkSuspendedError') {
      if (fromRetryQueue) {
        throw enhanced;
      }

      this.logger.info('浏览器网络挂起，延后任务同步', {
        taskId: task.id,
        projectId,
      });
      this.safeAddToRetryQueue('task', 'upsert', task, projectId, sourceUserId, true);
      return false;
    }

    if (enhanced.errorType === 'VersionConflictError') {
      this.logger.warn('推送任务版本冲突', { taskId: task.id, projectId });
      this.toast.warning('版本冲突', '数据已被修改，请刷新后重试');
      this.sentryLazyLoader.captureMessage('Optimistic lock conflict in pushTask', {
        level: 'warning',
        tags: { operation: 'pushTask', taskId: task.id, projectId },
        extra: { taskUpdatedAt: task.updatedAt }
      });
      throw new PermanentFailureError(
        'Version conflict',
        enhanced,
        { operation: 'pushTask', taskId: task.id, projectId }
      );
    }
    
    this.retryQueueService.recordCircuitFailure(enhanced.errorType);
    
    if (enhanced.isRetryable) {
      this.logger.debug(`推送任务失败 (${enhanced.errorType})，已加入重试队列`, enhanced.message);
    } else {
      this.logger.error('推送任务失败', enhanced);
    }
    
    this.captureExceptionWithContext(enhanced, 'pushTask', {
      taskId: task.id,
      projectId,
      errorType: enhanced.errorType,
      isRetryable: enhanced.isRetryable
    });
    
    if (enhanced.isRetryable && !fromRetryQueue) {
      this.safeAddToRetryQueue('task', 'upsert', task, projectId, sourceUserId);
    } else if (!enhanced.isRetryable) {
      this.logger.warn('不可重试的错误，不加入重试队列', {
        taskId: task.id,
        errorType: enhanced.errorType,
        message: enhanced.message
      });
    }
    return false;
  }
  
  /** 推送任务位置到云端（仅更新 x,y 坐标） */
  async pushTaskPosition(
    taskId: string,
    x: number,
    y: number,
    projectId?: string,
    fallbackTask?: Task,
    sourceUserId?: string,
  ): Promise<boolean> {
    if (this.syncStateService.isSessionExpired()) {
      this.logger.debug('pushTaskPosition: 会话已过期，跳过推送');
      return false;
    }
    
    if (!this.retryQueueService.checkCircuitBreaker()) {
      this.logger.debug('Circuit Breaker: 熔断中，跳过位置推送', { taskId });
      return false;
    }
    
    const client = this.getSupabaseClient();
    if (!client) {
      return false;
    }

    if (sourceUserId) {
      const { data: { session } } = await client.auth.getSession();
      let sessionUserId = session?.user?.id ?? null;
      if (!sessionUserId) {
        const refreshed = await this.sessionManager.tryRefreshSession('pushTaskPosition.getSession');
        if (refreshed) {
          const { data: { session: newSession } } = await client.auth.getSession();
          sessionUserId = newSession?.user?.id ?? null;
        }
      }

      if (!sessionUserId) {
        if (isBrowserNetworkSuspendedWindow()) {
          this.logger.info('浏览器网络挂起，延后任务位置同步', { taskId, projectId });
          return false;
        }

        this.sessionManager.handleSessionExpired('pushTaskPosition.getSession', { taskId, projectId });
        return false;
      }

      if (sessionUserId !== sourceUserId) {
        this.logger.warn('检测到任务位置同步归属与当前会话不匹配，已拒绝云端写入', {
          taskId,
          projectId,
          sourceUserId,
          sessionUserId,
        });
        return false;
      }
    }

    await this.primeTaskSyncRpcCapability();

    if (this.syncRpcClient?.isClientRejected() === true) {
      this.reportTaskSyncRpcClientRejected('pushTaskPosition', {
        taskId,
        projectId: projectId ?? null,
      });
      return false;
    }

    if (this.shouldUseSyncRpc()) {
      if (!projectId || !fallbackTask) {
        this.logger.warn('pushTaskPosition: sync RPC 开启但缺少任务快照，跳过未受保护的位置直写', {
          taskId,
          projectId: projectId ?? null,
        });
        return false;
      }

      try {
        const taskForRpc = {
          ...fallbackTask,
          x,
          y,
        };
        const result = await this.syncRpcClient!.upsertTask({
          operationId: this.createSyncRpcOperationId(),
          task: taskForRpc,
          projectId,
          baseUpdatedAt: fallbackTask.updatedAt ?? null,
        });

        const pushed = this.handleTaskSyncRpcResult(
          result,
          taskForRpc,
          projectId,
          false,
          sourceUserId,
        );
        if (pushed) {
          this.applyTaskPositionSnapshot(
            taskId,
            projectId,
            fallbackTask,
            x,
            y,
            taskForRpc.updatedAt ?? result.serverUpdatedAt ?? null,
          );
        }
        return pushed;
      } catch (e) {
        if (isBrowserNetworkSuspendedWindow()) {
          this.logger.info('浏览器网络挂起，延后任务位置同步', { taskId, projectId });
          return false;
        }

        this.logger.debug('pushTaskPosition sync RPC 异常', { taskId, error: e });
        return false;
      }
    }

    if (!projectId || !fallbackTask) {
      this.logger.warn('pushTaskPosition: 缺少任务快照或 projectId，跳过未受保护的位置直写', {
        taskId,
        projectId: projectId ?? null,
      });
      return false;
    }
    
    try {
      const remoteTask = await this.loadRemoteTaskFreshness(client, taskId, projectId);
      const remoteHasTombstone = !!remoteTask?.deletedAt;
      const remoteUpdatedAt = remoteTask?.updatedAt ?? null;
      const localUpdatedAt = fallbackTask.updatedAt ?? null;
      const rawRemoteMs = remoteUpdatedAt ? new Date(remoteUpdatedAt).getTime() : Number.NaN;
      const rawLocalMs = localUpdatedAt ? new Date(localUpdatedAt).getTime() : Number.NaN;
      const timestampsDiffer = Number.isFinite(rawRemoteMs)
        && Number.isFinite(rawLocalMs)
        && rawLocalMs !== rawRemoteMs;
      const clockSyncResult = timestampsDiffer
        ? await this.clockSync.ensureSynced().catch(() => null)
        : null;

      if (timestampsDiffer && !clockSyncResult?.reliable) {
        this.logger.warn('pushTaskPosition 时钟基线不可靠，延后位置同步避免洗白陈旧快照', {
          taskId,
          projectId,
          localUpdatedAt,
          remoteUpdatedAt,
        });
        return false;
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

      if (remoteHasTombstone || remoteIsNewer || !remoteUpdatedAt) {
        this.logger.warn('pushTaskPosition 预检阻止未受保护的位置直写，需回退完整推送', {
          taskId,
          projectId,
          remoteHasTombstone,
          remoteUpdatedAt,
          localUpdatedAt,
          reason: remoteHasTombstone ? 'remote-tombstone' : remoteIsNewer ? 'remote-newer' : 'remote-missing',
        });
        return false;
      }

      const { data, error } = await client
        .from('tasks')
        .update({ x, y })
        .eq('id', taskId)
        .eq('project_id', projectId)
        .eq('updated_at', remoteUpdatedAt)
        .select('updated_at');
      
      if (error) {
        this.logger.debug('pushTaskPosition 失败', { taskId, error: error.message });
        return false;
      }

      // 未命中远端行时返回 false，让调用方回退到完整任务 upsert
      const updatedAt = Array.isArray(data) && data.length > 0
        ? String((data[0] as { updated_at?: string | null }).updated_at ?? '')
        : '';
      if (!updatedAt) {
        this.logger.warn('pushTaskPosition 未命中远端任务，需回退完整推送', {
          taskId,
          projectId: projectId ?? null
        });
        return false;
      }

      // 记录服务端时间戳，保持时钟同步
      this.clockSync.recordServerTimestamp(updatedAt, taskId);
      this.applyTaskPositionSnapshot(taskId, projectId, fallbackTask, x, y, updatedAt);
      
      this.retryQueueService.recordCircuitSuccess();
      return true;
    } catch (e) {
      if (isBrowserNetworkSuspendedWindow()) {
        this.logger.info('浏览器网络挂起，延后任务位置同步', { taskId, projectId });
        return false;
      }

      this.logger.debug('pushTaskPosition 异常', { taskId, error: e });
      return false;
    }
  }
  
  /** 从云端拉取任务 */
  async pullTasks(projectId: string, since?: string): Promise<Task[]> {
    const client = this.getSupabaseClient();
    if (!client) return [];
    
    try {
      let tasksQuery = client
        .from('tasks')
        .select(getCompatibleTaskSelectFields(FIELD_SELECT_CONFIG.TASK_LIST_FIELDS))
        .eq('project_id', projectId);
      
      if (since) {
        tasksQuery = tasksQuery.gt('updated_at', since);
      }
      
      const [initialTasksResult, tombstonesResult] = await Promise.all([
        tasksQuery,
        this.tombstoneService.getTombstonesWithCache(projectId, client)
      ]);
      let tasksResult = initialTasksResult;

      if (tasksResult.error && markTaskCompletedAtColumnUnavailable(tasksResult.error)) {
        this.logger.warn('tasks.completed_at 缺失，任务拉取已降级为旧 schema 字段', {
          projectId,
          since,
          error: tasksResult.error,
        });
        let fallbackTasksQuery = client
          .from('tasks')
          .select(getCompatibleTaskSelectFields(FIELD_SELECT_CONFIG.TASK_LIST_FIELDS))
          .eq('project_id', projectId);
        if (since) {
          fallbackTasksQuery = fallbackTasksQuery.gt('updated_at', since);
        }
        tasksResult = await fallbackTasksQuery;
      }
      
      if (tasksResult.error) throw supabaseErrorToError(tasksResult.error);
      
      const remoteTombstoneTimestamps = new Map<string, number>();
      if (!tombstonesResult.error && tombstonesResult.data) {
        for (const t of tombstonesResult.data) {
          if (!t.deleted_at) {
            continue;
          }
          const deletedAt = new Date(t.deleted_at).getTime();
          if (!Number.isNaN(deletedAt)) {
            remoteTombstoneTimestamps.set(t.task_id, deletedAt);
          }
        }
      }
      
      const allTasks = ((tasksResult.data || []) as unknown as TaskRow[]).map(row => this.projectDataService.rowToTask(row));
      
      return allTasks.map(task => {
        const remoteDeletedAt = remoteTombstoneTimestamps.get(task.id);
        if (this.tombstoneService.shouldMaterializeTaskDeletion(task.updatedAt, remoteDeletedAt)) {
          this.logger.debug('pullTasks: 标记 tombstone 任务', { taskId: task.id });
          return { ...task, deletedAt: task.deletedAt || new Date(remoteDeletedAt!).toISOString() };
        }

        const localDeletedAt = this.tombstoneService.getLocalTombstoneTimestamp(projectId, task.id);
        if (this.tombstoneService.shouldMaterializeTaskDeletion(task.updatedAt, localDeletedAt)) {
          this.logger.debug('pullTasks: 标记本地 tombstone 任务', { taskId: task.id });
          return { ...task, deletedAt: task.deletedAt || new Date(localDeletedAt!).toISOString() };
        }

        if (localDeletedAt !== undefined) {
          this.tombstoneService.clearLocalTombstones(projectId, [task.id]);
        }

        return task;
      });
    } catch (e) {
      this.logger.error('拉取任务失败', e);
      return [];
    }
  }
  
  /** 删除云端任务（优先 purge RPC 写入 tombstone，降级为软删除） */
  async deleteTask(taskId: string, projectId: string, sourceUserId?: string, fromRetryQueue = false): Promise<boolean> {
    if (this.syncStateService.isSessionExpired()) {
      return this.preserveTaskDeleteForSessionExpiry(
        [taskId],
        projectId,
        fromRetryQueue,
        sourceUserId,
        'deleteTask',
        { taskId, projectId },
      );
    }
    
    const client = this.getSupabaseClient();
    if (!client) {
      this.queueTaskDeletesForRetry([taskId], projectId, fromRetryQueue, sourceUserId);
      return false;
    }
    
    try {
      const { data: { session } } = await client.auth.getSession();
      let sessionUserId = session?.user?.id ?? null;
      if (!sessionUserId) {
        const refreshed = await this.sessionManager.tryRefreshSession('deleteTask.getSession');
        if (refreshed) {
          const { data: { session: newSession } } = await client.auth.getSession();
          sessionUserId = newSession?.user?.id ?? null;
        }
      }

      if (!sessionUserId) {
        return this.preserveTaskDeleteForSessionExpiry(
          [taskId],
          projectId,
          fromRetryQueue,
          sourceUserId,
          'deleteTask.getSession',
          { taskId, projectId },
        );
      }

      if (sourceUserId && sessionUserId !== sourceUserId) {
        this.logger.warn('检测到任务删除归属与当前会话不匹配，已拒绝云端写入', {
          taskId,
          projectId,
          sourceUserId,
          sessionUserId,
        });
        this.queueTaskDeletesForRetry([taskId], projectId, fromRetryQueue, sourceUserId);
        return false;
      }

      const purgeSuccess = await this.purgeTasksFromCloud(projectId, [taskId], sourceUserId, fromRetryQueue);
      if (purgeSuccess) {
        this.tombstoneService.invalidateCache(projectId);
      }
      return purgeSuccess;
    } catch (e) {
      const enhanced = supabaseErrorToError(e);

      if (enhanced.errorType === 'BrowserNetworkSuspendedError') {
        if (fromRetryQueue) {
          throw enhanced;
        }

        this.logger.info('浏览器网络挂起，延后任务删除同步', {
          taskId,
          projectId,
        });
        this.queueTaskDeletesForRetry([taskId], projectId, fromRetryQueue, sourceUserId, true);
        return false;
      }
      
      if (this.sessionManager.isSessionExpiredError(enhanced)) {
        return this.preserveTaskDeleteForSessionExpiry(
          [taskId],
          projectId,
          fromRetryQueue,
          sourceUserId,
          'deleteTask',
          { taskId, projectId, errorCode: enhanced.code },
        );
      }
      
      this.logger.error('删除任务失败', enhanced);
      this.captureExceptionWithContext(enhanced, 'deleteTask', {
        taskId,
        projectId,
        errorType: enhanced.errorType,
        isRetryable: enhanced.isRetryable
      });
      
      if (enhanced.isRetryable) {
        this.queueTaskDeletesForRetry([taskId], projectId, fromRetryQueue, sourceUserId);
      }
      return false;
    }
  }
  
  /** 安全批量软删除任务 */
  async softDeleteTasksBatch(
    projectId: string,
    taskIds: string[],
    tombstoneTimestamps?: Record<string, string | number | null | undefined>,
  ): Promise<number> {
    if (taskIds.length === 0) return 0;

    const client = this.getSupabaseClient();
    if (!client) {
      this.logger.warn('softDeleteTasksBatch: 离线模式，跳过服务端删除', { taskIds });
      // 【NEW-5 修复】离线时添加本地 tombstone，防止下次同步拉取时任务复活
      this.tombstoneService.addLocalTombstones(projectId, taskIds, tombstoneTimestamps);
      this.settleDeletedTaskDependencies(projectId, taskIds);
      return taskIds.length;
    }

    try {
      await this.primeTaskSyncRpcCapability();

      if (this.syncRpcClient?.isClientRejected() === true) {
        this.reportTaskSyncRpcClientRejected('softDeleteTasksBatch', {
          projectId,
          taskIds,
        });
        this.tombstoneService.addLocalTombstones(projectId, taskIds, tombstoneTimestamps);
        this.settleDeletedTaskDependencies(projectId, taskIds);
        return -1;
      }

      if (this.shouldUseSyncRpc()) {
        const result = await this.syncRpcClient!.deleteTasks({
          operationId: this.createSyncRpcOperationId(),
          projectId,
          taskIds,
          baseUpdatedAt: null,
          deleteMode: 'soft',
          baseUpdatedAtMap: this.buildTaskBaseUpdatedAtMap(taskIds),
        });

        if (result.status === 'applied' || result.status === 'idempotent-replay') {
          await this.applySuccessfulTaskDeleteRpc(client, result, projectId, taskIds, tombstoneTimestamps);
          this.requeueStaleTaskDeletes(result, projectId, false, undefined, 'softDeleteTasksBatch');
          return result.affectedCount ?? taskIds.length;
        }

        this.handleRejectedTaskDeleteRpc(result, projectId, taskIds, false, undefined, 'softDeleteTasksBatch');
        this.tombstoneService.addLocalTombstones(projectId, taskIds, tombstoneTimestamps);
        return -1;
      }

      this.logger.debug('softDeleteTasksBatch: 调用 safe_delete_tasks RPC', {
        projectId,
        taskIds,
        taskCount: taskIds.length
      });

      const { data, error } = await client.rpc('safe_delete_tasks', {
        p_task_ids: taskIds,
        p_project_id: projectId
      });

      if (error) {
        if (error.message?.includes('Bulk delete blocked')) {
          this.logger.warn('softDeleteTasksBatch: 服务端熔断阻止删除', {
            projectId,
            taskIds,
            error: error.message
          });
          this.toast.warning('删除被阻止', error.message);
          this.sentryLazyLoader.captureMessage('Server circuit breaker blocked delete', {
            level: 'warning',
            tags: { operation: 'softDeleteTasksBatch', projectId },
            extra: { taskIds, error: error.message }
          });
          return -1;
        }

        throw supabaseErrorToError(error);
      }

      // 【NEW-5 修复】服务端删除成功后添加本地 tombstone，防止同步窗口期内任务复活
      this.tombstoneService.addLocalTombstones(projectId, taskIds, tombstoneTimestamps);
      this.settleDeletedTaskDependencies(projectId, taskIds);

      this.logger.info('softDeleteTasksBatch: 删除成功', {
        projectId,
        requestedCount: taskIds.length,
        affectedCount: data
      });

      return data ?? 0;
    } catch (e) {
      this.logger.error('softDeleteTasksBatch 失败', e);
      this.captureExceptionWithContext(e, 'softDeleteTasksBatch', {
        projectId,
        taskCount: taskIds.length
      });

      // RPC 失败时降级为逐个软删除
      this.logger.warn('softDeleteTasksBatch: RPC 失败，降级为逐个更新');
      try {
        const { error } = await client
          .from('tasks')
          .update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq('project_id', projectId)
          .in('id', taskIds);

        if (error) {
          this.logger.error('softDeleteTasksBatch: 降级也失败', error);
          throw supabaseErrorToError(error);
        }

        // 【NEW-5 修复】降级路径成功后同样添加本地 tombstone
        this.tombstoneService.addLocalTombstones(projectId, taskIds, tombstoneTimestamps);
        this.settleDeletedTaskDependencies(projectId, taskIds);

        return taskIds.length;
      } catch (fallbackError) {
        this.logger.error('softDeleteTasksBatch: 完全失败', fallbackError);
        // 完全失败时仍添加本地 tombstone 作为最后防线
        this.tombstoneService.addLocalTombstones(projectId, taskIds, tombstoneTimestamps);
        return -1;
      }
    }
  }
  
  /** 永久删除云端任务（tombstone + 物理删除，v3→v2→v1 降级） */
  async purgeTasksFromCloud(projectId: string, taskIds: string[], sourceUserId?: string, fromRetryQueue = false): Promise<boolean> {
    if (taskIds.length === 0) return true;
    
    const client = this.getSupabaseClient();
    if (!client) {
      this.logger.warn('purgeTasksFromCloud: 离线模式，稍后重试', { taskIds });
      this.queueTaskDeletesForRetry(taskIds, projectId, fromRetryQueue, sourceUserId);
      return false;
    }
    
    try {
      if (sourceUserId) {
        const { data: { session } } = await client.auth.getSession();
        let sessionUserId = session?.user?.id ?? null;
        if (!sessionUserId) {
          const refreshed = await this.sessionManager.tryRefreshSession('purgeTasksFromCloud.getSession');
          if (refreshed) {
            const { data: { session: newSession } } = await client.auth.getSession();
            sessionUserId = newSession?.user?.id ?? null;
          }
        }

        if (!sessionUserId) {
          return this.preserveTaskDeleteForSessionExpiry(
            taskIds,
            projectId,
            fromRetryQueue,
            sourceUserId,
            'purgeTasksFromCloud.getSession',
            { projectId, taskCount: taskIds.length },
          );
        }

        if (sessionUserId !== sourceUserId) {
          this.logger.warn('检测到批量任务删除归属与当前会话不匹配，已拒绝云端写入', {
            projectId,
            taskCount: taskIds.length,
            sourceUserId,
            sessionUserId,
          });
          this.queueTaskDeletesForRetry(taskIds, projectId, fromRetryQueue, sourceUserId);
          return false;
        }
      }

      await this.primeTaskSyncRpcCapability();

      if (this.syncRpcClient?.isClientRejected() === true) {
        this.reportTaskSyncRpcClientRejected('purgeTasksFromCloud', {
          projectId,
          taskIds,
        });
        return false;
      }

      if (this.shouldUseSyncRpc()) {
        const result = await this.syncRpcClient!.deleteTasks({
          operationId: this.createSyncRpcOperationId(),
          projectId,
          taskIds,
          baseUpdatedAt: null,
          deleteMode: 'purge',
          baseUpdatedAtMap: this.buildTaskBaseUpdatedAtMap(taskIds),
        });

        if (result.status === 'applied' || result.status === 'idempotent-replay') {
          await this.applySuccessfulTaskDeleteRpc(client, result, projectId, taskIds);
          this.requeueStaleTaskDeletes(result, projectId, fromRetryQueue, sourceUserId, 'purgeTasksFromCloud');
          return true;
        }

        this.handleRejectedTaskDeleteRpc(result, projectId, taskIds, fromRetryQueue, sourceUserId, 'purgeTasksFromCloud');
        return false;
      }

      // 优先使用 purge_tasks_v3
      this.logger.debug('purgeTasksFromCloud: 调用 purge_tasks_v3', { projectId, taskIds });
      const purgeV3Result = await client.rpc('purge_tasks_v3', {
        p_project_id: projectId,
        p_task_ids: taskIds
      });
      
      if (!purgeV3Result.error && purgeV3Result.data) {
        const { purged_count, attachment_paths } = purgeV3Result.data as { 
          purged_count: number; 
          attachment_paths: string[] 
        };
        
        this.logger.info('purge_tasks_v3 成功', { projectId, purgedCount: purged_count });
        
        if (attachment_paths && attachment_paths.length > 0) {
          this.tombstoneService.deleteAttachmentFilesFromStorage(client, attachment_paths).catch(err => {
            this.logger.warn('purgeTasksFromCloud: 附件文件删除失败（任务已删除）', err);
          });
        }
        
        this.addLocalTombstones(projectId, taskIds);
        this.settleDeletedTaskDependencies(projectId, taskIds);
        return true;
      }
      
      // v3 失败，降级到 v2
      this.logger.warn('purgeTasksFromCloud: purge_tasks_v3 失败，尝试 v2', purgeV3Result.error);
      const purgeV2Result = await client.rpc('purge_tasks_v2', {
        p_project_id: projectId,
        p_task_ids: taskIds
      });
      
      if (!purgeV2Result.error) {
        this.logger.info('purge_tasks_v2 成功', { projectId, purgedCount: purgeV2Result.data });
        this.addLocalTombstones(projectId, taskIds);
        this.settleDeletedTaskDependencies(projectId, taskIds);
        return true;
      }
      
      // 降级为软删除（保留 project_id 边界，禁止退回旧的 owner-only purge_tasks）
      this.logger.warn('purgeTasksFromCloud: purge_tasks_v2 失败，降级为软删除', { 
        v2Error: purgeV2Result.error,
      });
      
      const { error } = await client
        .from('tasks')
        .update({ deleted_at: new Date().toISOString() })
        .eq('project_id', projectId)
        .in('id', taskIds);
      
      if (error) {
        this.logger.error('purgeTasksFromCloud: 软删除也失败', error);
        throw supabaseErrorToError(error);
      }
      
      this.addLocalTombstones(projectId, taskIds);
      this.settleDeletedTaskDependencies(projectId, taskIds);
      this.logger.warn('purgeTasksFromCloud: 已降级为软删除（已添加本地 tombstone 保护）', { 
        projectId, 
        taskIds 
      });
      
      return true;
    } catch (e) {
      const enhanced = supabaseErrorToError(e);
      if (enhanced.errorType === 'BrowserNetworkSuspendedError') {
        if (fromRetryQueue) {
          throw enhanced;
        }

        this.logger.info('浏览器网络挂起，延后批量任务删除同步', {
          projectId,
          taskCount: taskIds.length,
        });
        this.queueTaskDeletesForRetry(taskIds, projectId, fromRetryQueue, sourceUserId, true);
        return false;
      }

      this.logger.error('purgeTasksFromCloud 失败', e);
      this.captureExceptionWithContext(e, 'purgeTasksFromCloud', {
        projectId,
        taskCount: taskIds.length
      });
      this.queueTaskDeletesForRetry(taskIds, projectId, fromRetryQueue, sourceUserId);
      return false;
    }
  }

  private async applySuccessfulTaskDeleteRpc(
    client: SupabaseClient,
    result: SyncRpcResult,
    projectId: string,
    taskIds: string[],
    tombstoneTimestamps?: Record<string, string | number | null | undefined>,
  ): Promise<void> {
    if (result.attachmentPaths && result.attachmentPaths.length > 0) {
      await this.tombstoneService.deleteAttachmentFilesFromStorage(client, result.attachmentPaths);
    }

    // 服务端因 stale-write 保护跳过的 task 不应被加入 tombstone（避免本地误判为已删除）
    const skipped = new Set(result.skippedIds ?? []);
    const actuallyDeleted = skipped.size > 0
      ? taskIds.filter(id => !skipped.has(id))
      : taskIds;

    this.tombstoneService.addLocalTombstones(projectId, actuallyDeleted, tombstoneTimestamps);
    this.settleDeletedTaskDependencies(projectId, actuallyDeleted);
    this.logger.info('sync_delete_tasks 成功', {
      projectId,
      taskCount: taskIds.length,
      deletedCount: actuallyDeleted.length,
      skippedCount: skipped.size,
      affectedCount: result.affectedCount ?? null,
      status: result.status,
    });
  }

  /**
   * 构造 `sync_delete_tasks.base_updated_at_map`：从 TaskStore 取每个 task 的本地 updated_at 快照。
   * 服务端据此识别"已被远端改动"的 task 并跳过删除，保护用户在新设备上做过的合法变更。
   */
  private buildTaskBaseUpdatedAtMap(taskIds: string[]): Record<string, string> | undefined {
    if (!this.taskStore || taskIds.length === 0) return undefined;
    const map: Record<string, string> = {};
    let count = 0;
    for (const id of taskIds) {
      const task = this.taskStore.getTask(id);
      const updatedAt = task?.updatedAt;
      if (typeof updatedAt === 'string' && updatedAt.length > 0) {
        map[id] = updatedAt;
        count++;
      }
    }
    return count > 0 ? map : undefined;
  }

  /**
   * 服务端因 stale-write 保护跳过的 task：客户端要把它们重排回 RetryQueue，
   * 走 pull+merge 路径而不是用陈旧 delete payload 反复打。
   */
  private requeueStaleTaskDeletes(
    result: SyncRpcResult,
    projectId: string,
    fromRetryQueue: boolean,
    sourceUserId: string | undefined,
    operation: string,
  ): void {
    const skipped = result.skippedIds ?? [];
    if (skipped.length === 0) return;

    this.logger.warn('sync_delete_tasks 跳过陈旧 task 删除（远端版本更新）', {
      projectId,
      operation,
      skippedIds: skipped,
    });
    this.sentryLazyLoader.captureMessage('sync_rpc_task_delete_skipped_stale', {
      level: 'warning',
      tags: { operation, entityType: 'task', status: result.status },
      extra: { projectId, skippedIds: skipped },
    });

    this.queueTaskDeletesForRetry(skipped, projectId, fromRetryQueue, sourceUserId);
  }

  private handleRejectedTaskDeleteRpc(
    result: SyncRpcResult,
    projectId: string,
    taskIds: string[],
    fromRetryQueue: boolean,
    sourceUserId: string | undefined,
    operation: string,
  ): void {
    const isConflict = result.status === 'remote-newer' || result.status === 'deleted-remote-newer';
    const message = result.status === 'client-version-rejected'
      ? '当前客户端同步协议已过期，请刷新后重试'
      : isConflict
        ? '远端版本更新，删除意图已保留等待拉取合并'
        : '任务删除被服务端拒绝，已保留本地变更等待重试';

    this.syncStateService.setSyncError(message);
    this.sentryLazyLoader.captureMessage(
      isConflict ? 'sync_rpc_task_delete_remote_newer' : 'sync_rpc_task_delete_rejected',
      {
        level: 'warning',
        tags: { operation, entityType: 'task', status: result.status },
        extra: {
          projectId,
          taskIds,
          remoteUpdatedAt: result.remoteUpdatedAt,
          reason: result.reason,
          minProtocolVersion: result.minProtocolVersion,
        },
      },
    );

    this.queueTaskDeletesForRetry(taskIds, projectId, fromRetryQueue, sourceUserId);
  }
  
  // Tombstone 管理

  /** 获取项目的所有 tombstone 任务 ID */
  async getTombstoneIds(projectId: string): Promise<Set<string>> {
    const result = await this.getTombstoneIdsWithStatus(projectId);
    return result.ids;
  }
  
  /** 获取 tombstone ID（带查询状态） */
  async getTombstoneIdsWithStatus(projectId: string): Promise<TombstoneQueryResult> {
    const tombstoneIds = new Set<string>();
    let fromRemote = false;
    
    const localTombstones = this.tombstoneService.getLocalTombstones(projectId);
    localTombstones.forEach(id => {
      tombstoneIds.add(id);
    });
    
    const client = this.getSupabaseClient();
    if (!client) {
      this.logger.info('getTombstoneIds: 离线模式，仅使用本地缓存', { 
        projectId, 
        localCount: localTombstones.size 
      });
      return { ids: tombstoneIds, fromRemote: false, localCacheOnly: true, timestamp: Date.now() };
    }
    
    try {
      const { data, error } = await this.tombstoneService.getTombstonesWithCache(projectId, client);
      
      if (error) {
        this.logger.warn('获取云端 tombstones 失败，使用本地缓存', error);
        return { ids: tombstoneIds, fromRemote: false, localCacheOnly: true, timestamp: Date.now() };
      }
      
      for (const t of (data || [])) {
        tombstoneIds.add(t.task_id);
      }
      
      fromRemote = true;
      
      if (localTombstones.size > 0 || tombstoneIds.size > localTombstones.size) {
        this.logger.debug('getTombstoneIds: 合并完成', {
          projectId,
          localCount: localTombstones.size,
          cloudCount: tombstoneIds.size - localTombstones.size,
          totalCount: tombstoneIds.size
        });
      }
      
      return { ids: tombstoneIds, fromRemote, localCacheOnly: false, timestamp: Date.now() };
    } catch (e) {
      this.logger.warn('获取 tombstones 异常，使用本地缓存', e);
      return { ids: tombstoneIds, fromRemote: false, localCacheOnly: true, timestamp: Date.now() };
    }
  }
  
  /** 获取本地 tombstone 缓存 */
  getLocalTombstones(projectId: string): Set<string> {
    return this.tombstoneService.getLocalTombstones(projectId);
  }
  
  /** 添加本地 tombstones */
  addLocalTombstones(
    projectId: string,
    taskIds: string[],
    timestampsByTaskId?: Record<string, string | number | null | undefined>,
  ): void {
    this.tombstoneService.addLocalTombstones(projectId, taskIds, timestampsByTaskId);
    this.logger.debug('添加本地 tombstones', { projectId, count: taskIds.length });
  }
  
  /** 导出本地 tombstones（用于 SimpleSyncService 兼容） */
  exportLocalTombstones(): Record<string, string[]> {
    return this.tombstoneService.exportLocalTombstones();
  }
  
  /** 拓扑排序任务，确保父任务在子任务之前 */
  topologicalSortTasks(tasks: Task[]): Task[] {
    const taskMap = new Map(tasks.map(t => [t.id, t]));
    const sorted: Task[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();

    type StackFrame = { taskId: string; expanded: boolean; depth: number };

    for (const task of tasks) {
      if (visited.has(task.id)) {
        continue;
      }

      const stack: StackFrame[] = [{ taskId: task.id, expanded: false, depth: 0 }];

      while (stack.length > 0) {
        const frame = stack.pop()!;
        const current = taskMap.get(frame.taskId);
        if (!current) {
          continue;
        }

        if (frame.expanded) {
          visiting.delete(frame.taskId);
          if (!visited.has(frame.taskId)) {
            visited.add(frame.taskId);
            sorted.push(current);
          }
          continue;
        }

        if (visited.has(frame.taskId)) {
          continue;
        }

        if (frame.depth > FLOATING_TREE_CONFIG.MAX_SUBTREE_DEPTH) {
          this.logger.error('拓扑排序深度超限，已降级为当前节点优先', {
            taskId: frame.taskId,
            depth: frame.depth,
            maxDepth: FLOATING_TREE_CONFIG.MAX_SUBTREE_DEPTH
          });
          visited.add(frame.taskId);
          sorted.push(current);
          continue;
        }

        if (visiting.has(frame.taskId)) {
          this.logger.warn('检测到任务循环依赖，已降级断开循环', { taskId: frame.taskId });
          visited.add(frame.taskId);
          sorted.push(current);
          continue;
        }

        visiting.add(frame.taskId);
        stack.push({ taskId: frame.taskId, expanded: true, depth: frame.depth });

        if (current.parentId && taskMap.has(current.parentId) && !visited.has(current.parentId)) {
          stack.push({
            taskId: current.parentId,
            expanded: false,
            depth: frame.depth + 1
          });
        }
      }
    }
    
    this.logger.debug('拓扑排序完成', {
      original: tasks.length,
      sorted: sorted.length
    });
    
    return sorted;
  }
}
