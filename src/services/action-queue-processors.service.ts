/**
 * ActionQueueProcessorsService - Action Queue 处理器服务
 *
 * 职责：
 * - 注册和管理所有 Action Queue 处理器
 * - 处理项目、任务、用户偏好的同步操作
 *
 * Sprint 9 技术债务修复：从 SyncCoordinatorService 提取
 *
 * NOTE: The `as` payload casts throughout this file are intentional.
 * Each processor knows the shape of its own action payload by contract
 * (enforced by the action type discriminant at enqueue time), so the
 * casts are safe within the processor-registration pattern.
 */
import { Injectable, inject } from '@angular/core';
import { RetryQueueService, SimpleSyncService } from '../core-bridge';
import { ActionQueueService } from './action-queue.service';
import { ProjectStateService } from './project-state.service';
import { AuthService } from './auth.service';
import { LoggerService } from './logger.service';
import { ConflictStorageService } from './conflict-storage.service';
import { ToastService } from './toast.service';
import { Project } from '../models';
import { AUTH_CONFIG } from '../config/auth.config';
import { isPermanentFailureError } from '../utils/permanent-failure-error';
import {
  FocusSessionPayload,
  PreferencePayload,
  ProjectDeletePayload,
  ProjectPayload,
  QueuedAction,
  RoutineCompletionPayload,
  RoutineTaskPayload,
  TaskDeletePayload,
  TaskPayload,
} from './action-queue.types';
import {
  FocusSessionRecord,
  RoutineCompletionMutation,
} from '../models/parking-dock';

type ProjectSyncResult = {
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
};

type ProjectMutationContext = {
  actionType: 'project:create' | 'project:update';
  ownerUserId: string;
  projectId: string;
  queueViewGeneration: number;
  projectMutationViewGeneration: number;
};

type ProjectMutationStaleness = 'current' | 'queue-view-stale' | 'project-view-stale';

@Injectable({
  providedIn: 'root'
})
export class ActionQueueProcessorsService {
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('ActionQueueProcessors');
  private readonly actionQueue = inject(ActionQueueService);
  private readonly syncService = inject(SimpleSyncService);
  private readonly retryQueue = inject(RetryQueueService);
  private readonly projectState = inject(ProjectStateService);
  private readonly authService = inject(AuthService);
  private readonly conflictStorage = inject(ConflictStorageService);
  private readonly toast = inject(ToastService);
  private projectConflictHandler: ((
    localProject: Project,
    remoteProject: Project,
    ownerUserId?: string | null,
    taskIdsToDelete?: string[],
  ) => void) | null = null;
  private legacyQueueWarningShown = false;
  private processorsInitialized = false;

  constructor() {
    // 恢复/联网事件可能早于 SyncCoordinator.initialize()，处理器必须先注册。
    this.setupProcessors();
  }

  /** 初始化所有处理器 */
  setupProcessors(): void {
    if (this.processorsInitialized) {
      return;
    }

    this.setupQueueSyncCoordination();
    this.setupProjectProcessors();
    this.setupTaskProcessors();
    this.setupPreferenceProcessors();
    this.setupFocusConsoleProcessors();
    this.processorsInitialized = true;
  }

  setProjectConflictHandler(
    handler: (
      localProject: Project,
      remoteProject: Project,
      ownerUserId?: string | null,
      taskIdsToDelete?: string[],
    ) => void
  ): void {
    this.projectConflictHandler = handler;
  }

  private resolveActionSourceUserId(...candidates: Array<string | null | undefined>): string | null {
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.length > 0) {
        return candidate;
      }
    }

    return null;
  }

  private buildOperationErrorMessage(error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  }): string {
    const parts = [error.code, error.message];
    const errorType = typeof error.details?.['errorType'] === 'string'
      ? String(error.details['errorType'])
      : null;
    const errorCode = error.details?.['errorCode'];

    if (errorType || errorCode) {
      parts.push(`[${[errorType, errorCode].filter(Boolean).join(':')}]`);
    }

    return parts.filter(part => typeof part === 'string' && part.length > 0).join(' | ');
  }

  private buildOperationError(error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  }): Error & { code: string; details?: Record<string, unknown> } {
    const queueError = new Error(this.buildOperationErrorMessage(error)) as Error & {
      code: string;
      details?: Record<string, unknown>;
    };
    queueError.code = error.code;
    queueError.details = error.details;
    return queueError;
  }

  private isDeferredQueueError(error: unknown): boolean {
    const details = (error as { details?: Record<string, unknown> } | null)?.details;
    if (details?.['reason'] === 'browser-network-suspended') {
      return true;
    }

    const code = (error as { code?: unknown } | null)?.code;
    const message = error instanceof Error
      ? error.message
      : String((error as { message?: unknown } | null)?.message ?? error ?? '');
    const normalized = `${String(code ?? '')} ${message}`.toLowerCase();

    return normalized.includes('browser-network-suspended')
      || normalized.includes('browsernetworksuspendederror')
      || normalized.includes('network io suspended')
      || (String(code ?? '') === 'SYNC_OFFLINE' && message.includes('浏览器恢复连接中'))
      || normalized.includes('sync_offline') && message.includes('浏览器恢复连接中');
  }

  private logProcessorFailure(actionType: string, error: unknown, context?: Record<string, unknown>): void {
    if (this.isDeferredQueueError(error)) {
      this.logger.debug(`${actionType} 延后重试（浏览器恢复中）`, { error, ...context });
      return;
    }

    this.logger.error(`${actionType} 异常`, { error, ...context });
  }

  private markRemoteActionSuccess(actionId: string): true {
    this.actionQueue.markActionSyncedRemotely(actionId);
    return true;
  }

  private isTaskTombstoneNoOp(error: unknown): boolean {
    return isPermanentFailureError(error)
      && error.context?.['operation'] === 'pushTaskTombstone';
  }

  private hasConflictingOwnerHints(
    action: QueuedAction,
    actionType: string,
    ...candidates: Array<string | null | undefined>
  ): boolean {
    const ownerHints = [...new Set(candidates.filter((candidate): candidate is string =>
      typeof candidate === 'string' && candidate.length > 0
    ))];
    if (ownerHints.length <= 1) {
      return false;
    }

    this.quarantineLegacyQueueAction(
      action,
      `${actionType} 队列 owner 元数据冲突 (${ownerHints.join(' vs ')})，已转入失败记录`
    );
    return true;
  }

  private async replayDeferredTaskDeletes(
    project: Project,
    taskIdsToDelete: string[] | undefined,
    sourceUserId: string | undefined,
    mutationContext?: ProjectMutationContext,
  ): Promise<void> {
    if (!taskIdsToDelete || taskIdsToDelete.length === 0) {
      return;
    }

    const uniqueTaskIds = [...new Set(taskIdsToDelete.filter(taskId => typeof taskId === 'string' && taskId.length > 0))];
    const replayOwnerUserId = sourceUserId ?? mutationContext?.ownerUserId;

    for (let index = 0; index < uniqueTaskIds.length; index++) {
      const remainingTaskIds = uniqueTaskIds.slice(index);
      if (mutationContext) {
        const staleness = this.getProjectMutationStaleness(mutationContext);
        if (staleness === 'queue-view-stale') {
          await this.handoffDeferredTaskDeletes(replayOwnerUserId, project, remainingTaskIds);
          return;
        }
        if (staleness === 'project-view-stale') {
          return;
        }
      }

      const currentUserId = this.authService.currentUserId();
      if (!currentUserId || (replayOwnerUserId && currentUserId !== replayOwnerUserId)) {
        await this.handoffDeferredTaskDeletes(replayOwnerUserId, project, remainingTaskIds);
        return;
      }

      const taskId = remainingTaskIds[0];
      const deleted = await this.syncService.deleteTask(taskId, project.id, sourceUserId);
      if (!deleted) {
        this.logger.warn('project 持久化成功，但后置 task:delete 未立即完成，已交给补偿链路', {
          projectId: project.id,
          taskId,
          sourceUserId,
        });
      }
    }
  }

  private async handoffDeferredTaskDeletes(
    ownerUserId: string | undefined,
    project: Project,
    taskIdsToDelete: string[],
  ): Promise<void> {
    if (!ownerUserId || ownerUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID || taskIdsToDelete.length === 0) {
      return;
    }

    await this.actionQueue.enqueueForOwner(ownerUserId, {
      type: 'update',
      entityType: 'project',
      entityId: project.id,
      payload: {
        project,
        sourceUserId: ownerUserId,
        taskIdsToDelete,
      },
    });
    this.logger.info('project 后置删除已写回原 owner 队列', {
      ownerUserId,
      projectId: project.id,
      pendingTaskDeleteCount: taskIdsToDelete.length,
    });
  }

  private shouldStopUserScopedQueueAction(
    action: QueuedAction,
    currentUserId: string,
    actionType: string,
    sourceUserId: string | null,
  ): boolean {
    if (currentUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      this.logger.warn(`${actionType} 跳过：本地模式不进入云端队列`);
      return true;
    }

    if (sourceUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      this.quarantineLegacyQueueAction(
        action,
        `${actionType} legacy local-user 队列项禁止自动上云，请人工确认后重试`
      );
      return true;
    }

    if (!sourceUserId) {
      this.quarantineLegacyQueueAction(
        action,
        `${actionType} legacy 队列项缺少来源元数据，无法安全判断归属，已转入失败记录`
      );
      return true;
    }

    if (sourceUserId !== currentUserId) {
      this.quarantineLegacyQueueAction(
        action,
        `${actionType} 队列来源用户 ${sourceUserId} 与当前账号 ${currentUserId} 不匹配，已转入失败记录`
      );
      return true;
    }

    return false;
  }

  private captureProjectMutationContext(
    ownerUserId: string,
    projectId: string,
    actionType: 'project:create' | 'project:update',
  ): ProjectMutationContext {
    return {
      actionType,
      ownerUserId,
      projectId,
      queueViewGeneration: this.actionQueue.getCurrentQueueViewGeneration(),
      projectMutationViewGeneration: this.actionQueue.getProjectMutationViewGeneration(projectId, ownerUserId),
    };
  }

  private getProjectMutationStaleness(context: ProjectMutationContext): ProjectMutationStaleness {
    if (!this.actionQueue.isQueueViewCurrent(context.queueViewGeneration, context.ownerUserId)) {
      this.logger.debug(`${context.actionType} 结果已过期，跳过本地副作用`, {
        projectId: context.projectId,
        ownerUserId: context.ownerUserId,
        queueViewGeneration: context.queueViewGeneration,
        staleReason: 'queue-view-stale',
      });
      return 'queue-view-stale';
    }

    const currentProjectMutationViewGeneration = this.actionQueue.getProjectMutationViewGeneration(
      context.projectId,
      context.ownerUserId,
    );
    if (currentProjectMutationViewGeneration !== context.projectMutationViewGeneration) {
      this.logger.debug(`${context.actionType} 结果已过期，跳过本地副作用`, {
        projectId: context.projectId,
        ownerUserId: context.ownerUserId,
        projectMutationViewGeneration: context.projectMutationViewGeneration,
        currentProjectMutationViewGeneration,
        staleReason: 'project-view-stale',
      });
      return 'project-view-stale';
    }

    return 'current';
  }

  private setupQueueSyncCoordination(): void {
    this.actionQueue.setQueueProcessCallbacks(
      () => this.syncService.pauseRealtimeUpdates(),
      () => this.syncService.resumeRealtimeUpdates(),
      ({ processed, failed, movedToDeadLetter, remaining, remoteSuccessCount, resolvedNoOpCount }) => {
        // 【根因修复 2026-04-22】这里需要同时兼容两类恢复来源：
        //   1) ActionQueue 自己产生了真实远端成功；
        //   2) RetryQueue 已先成功见底，但 ActionQueue 此轮只是在收口 local-only / legacy / tombstone
        //      之类的本地完成项。后一类不能要求 processed === resolvedCount，否则 stale syncError
        //      会在“两个队列都空了”的情况下继续卡住。
        const resolvedCount = remoteSuccessCount + resolvedNoOpCount;
        const cleanSettle = failed === 0 && movedToDeadLetter === 0 && remaining === 0;
        const hasPendingRetryRecovery = this.syncService.hasPendingRetryRecovery();
        const actionQueueRecovered = remoteSuccessCount > 0 && processed === resolvedCount;

        if (cleanSettle && (hasPendingRetryRecovery || actionQueueRecovered)) {
          this.syncService.markSyncRecoveredIfIdle();
        }
      }
    );
  }

  private setupProjectProcessors(): void {
    // 项目更新
    this.actionQueue.registerProcessor('project:update', async (action) => {
      const userId = this.authService.currentUserId();
      if (!userId) { this.logger.warn('project:update 失败：用户未登录'); return false; }
      
      const payload = action.payload as ProjectPayload;
      const mutationContext = this.captureProjectMutationContext(userId, payload.project.id, 'project:update');
      if (this.shouldStopProjectMutation(action, userId, payload, 'update')) {
        return true;
      }
      try {
        const result = await this.syncService.saveProjectSmart(payload.project, userId, payload.taskIdsToDelete);
        const failureTransferred = this.wasProjectFailureTransferredToRetryQueue(result, payload);
        const persistedProject = result.newVersion !== undefined
          ? { ...payload.project, version: result.newVersion }
          : payload.project;
        if (result.success) {
          await this.replayDeferredTaskDeletes(persistedProject, payload.taskIdsToDelete, payload.sourceUserId, mutationContext);
        }
        const staleness = this.getProjectMutationStaleness(mutationContext);
        if (staleness === 'project-view-stale') {
          this.actionQueue.markActionResolvedWithoutRemote(action.id);
          return true;
        }
        if (staleness === 'queue-view-stale') {
          return result.success || result.conflict === true || failureTransferred || result.terminal === true;
        }
        if (result.success && result.newVersion !== undefined) {
          this.projectState.updateProjects(ps => ps.map(p =>
            p.id === payload.project.id ? { ...p, version: result.newVersion } : p
          ));
        }
        if (result.success) {
          return this.markRemoteActionSuccess(action.id);
        }
        if (result.conflict) {
          this.logger.warn('project:update 冲突', { projectId: payload.project.id });
          if (result.remoteData) {
            this.projectConflictHandler?.(
              payload.project,
              result.remoteData,
              mutationContext.ownerUserId,
              payload.taskIdsToDelete,
            );
          } else {
            return await this.persistConflictWithoutRemote(
              payload.project,
              mutationContext,
              'project:update',
              payload.taskIdsToDelete,
            );
          }
          return true; // 冲突由冲突解决流程处理
        }
        if (result.terminal) {
          this.logger.warn('project:update 永久失败，已转入死信', {
            projectId: payload.project.id,
            failureReason: result.failureReason,
          });
          this.actionQueue.moveToDeadLetter(action, result.failureReason ?? '项目同步失败');
          return true;
        }
        if (failureTransferred) {
          this.logger.info('project:update 已转交 RetryQueue，当前 ActionQueue 项视为完成', {
            projectId: payload.project.id,
            retryEnqueued: result.retryEnqueued,
            failedTaskIds: result.failedTaskIds,
            failedConnectionIds: result.failedConnectionIds,
          });
          return true;
        }
        throw new Error(result.failureReason ?? 'project:update 未提供失败原因');
      } catch (error) {
        const staleness = this.getProjectMutationStaleness(mutationContext);
        if (staleness === 'project-view-stale') {
          this.actionQueue.markActionResolvedWithoutRemote(action.id);
          return true;
        }
        if (staleness === 'queue-view-stale') {
          return false;
        }
        this.logger.error('project:update 异常', { error, projectId: payload.project.id });
        return false;
      }
    });

    // 项目删除
    this.actionQueue.registerProcessor('project:delete', async (action) => {
      const userId = this.authService.currentUserId();
      if (!userId) { this.logger.warn('project:delete 失败：用户未登录'); return false; }
      const payload = action.payload as ProjectDeletePayload;
      if (this.hasConflictingOwnerHints(action, 'project:delete', payload.sourceUserId, payload.userId)) {
        return true;
      }
      const sourceUserId = this.resolveActionSourceUserId(payload.sourceUserId, payload.userId);
      if (this.shouldStopProjectDelete(action, userId, payload, sourceUserId)) {
        return true;
      }
      if (!sourceUserId) {
        return false;
      }
      try {
        const result = await this.syncService.deleteProjectFromCloud(payload.projectId, sourceUserId);
        if (result.ok) {
          await this.discardProjectDependentMutations(sourceUserId, payload.projectId, action.id);
          return this.markRemoteActionSuccess(action.id);
        }

        throw this.buildOperationError(result.error);
      } catch (error) {
        this.logger.error('project:delete 异常', { error, projectId: action.entityId });
        throw error instanceof Error ? error : new Error(String(error));
      }
    });

    // 项目创建
    this.actionQueue.registerProcessor('project:create', async (action) => {
      const userId = this.authService.currentUserId();
      if (!userId) { this.logger.warn('project:create 失败：用户未登录'); return false; }
      
      const payload = action.payload as ProjectPayload;
      const mutationContext = this.captureProjectMutationContext(userId, payload.project.id, 'project:create');
      if (this.shouldStopProjectMutation(action, userId, payload, 'create')) {
        return true;
      }
      try {
        const result = await this.syncService.saveProjectSmart(payload.project, userId, payload.taskIdsToDelete);
        const failureTransferred = this.wasProjectFailureTransferredToRetryQueue(result, payload);
        const persistedProject = result.newVersion !== undefined
          ? { ...payload.project, version: result.newVersion }
          : payload.project;
        if (result.success) {
          await this.replayDeferredTaskDeletes(persistedProject, payload.taskIdsToDelete, payload.sourceUserId, mutationContext);
        }
        const staleness = this.getProjectMutationStaleness(mutationContext);
        if (staleness === 'project-view-stale') {
          this.actionQueue.markActionResolvedWithoutRemote(action.id);
          return true;
        }
        if (staleness === 'queue-view-stale') {
          return result.success || result.conflict === true || failureTransferred || result.terminal === true;
        }
        if (result.success && result.newVersion !== undefined) {
          this.projectState.updateProjects(ps => ps.map(p =>
            p.id === payload.project.id ? { ...p, version: result.newVersion } : p
          ));
        }
        if (result.success) {
          return this.markRemoteActionSuccess(action.id);
        }
        if (result.conflict) {
          this.logger.warn('project:create 冲突', { projectId: payload.project.id });
          if (result.remoteData) {
            this.projectConflictHandler?.(
              payload.project,
              result.remoteData,
              mutationContext.ownerUserId,
              payload.taskIdsToDelete,
            );
          } else {
            return await this.persistConflictWithoutRemote(
              payload.project,
              mutationContext,
              'project:create',
              payload.taskIdsToDelete,
            );
          }
          return true;
        }
        if (result.terminal) {
          this.logger.warn('project:create 永久失败，已转入死信', {
            projectId: payload.project.id,
            failureReason: result.failureReason,
          });
          this.actionQueue.moveToDeadLetter(action, result.failureReason ?? '项目同步失败');
          return true;
        }
        if (failureTransferred) {
          this.logger.info('project:create 已转交 RetryQueue，当前 ActionQueue 项视为完成', {
            projectId: payload.project.id,
            retryEnqueued: result.retryEnqueued,
            failedTaskIds: result.failedTaskIds,
            failedConnectionIds: result.failedConnectionIds,
          });
          return true;
        }
        throw new Error(result.failureReason ?? 'project:create 未提供失败原因');
      } catch (error) {
        const staleness = this.getProjectMutationStaleness(mutationContext);
        if (staleness === 'project-view-stale') {
          this.actionQueue.markActionResolvedWithoutRemote(action.id);
          return true;
        }
        if (staleness === 'queue-view-stale') {
          return false;
        }
        this.logger.error('project:create 异常', { error, projectId: payload.project.id });
        return false;
      }
    });
  }

  private async discardProjectDependentMutations(
    ownerUserId: string,
    projectId: string,
    currentActionId?: string,
  ): Promise<void> {
    await this.actionQueue.settleProjectDeleteSuccessForOwner(ownerUserId, projectId, currentActionId);
    this.retryQueue.removeByProjectId(projectId);
  }

  private wasProjectFailureTransferredToRetryQueue(
    result: ProjectSyncResult,
    payload: ProjectPayload,
  ): boolean {
    const retryEntries = new Set(result.retryEnqueued ?? []);
    if (retryEntries.size === 0) {
      return false;
    }

    if (result.projectPushed === false) {
      if (!retryEntries.has(`project:${payload.project.id}`)) {
        return false;
      }

      if (!this.doesProjectRetryPayloadMatch(payload)) {
        return false;
      }
    }

    const allFailedTasksTransferred = (result.failedTaskIds ?? [])
      .every(taskId => retryEntries.has(`task:${taskId}`));
    if (!allFailedTasksTransferred) {
      return false;
    }

    return (result.failedConnectionIds ?? [])
      .every(connectionId => retryEntries.has(`connection:${connectionId}`));
  }

  private doesProjectRetryPayloadMatch(payload: ProjectPayload): boolean {
    const ownerUserId = payload.sourceUserId
      ?? this.authService.currentUserId()
      ?? AUTH_CONFIG.LOCAL_MODE_USER_ID;
    const queuedProjectRetry = this.retryQueue.findItemForOwner(
      'project',
      payload.project.id,
      ownerUserId,
    );
    if (!queuedProjectRetry) {
      return false;
    }

    return this.buildProjectRetryPayloadSignature(
      queuedProjectRetry.data as Project,
      queuedProjectRetry.sourceUserId,
      queuedProjectRetry.taskIdsToDelete,
    ) === this.buildProjectRetryPayloadSignature(
      payload.project,
      payload.sourceUserId,
      payload.taskIdsToDelete,
    );
  }

  private buildProjectRetryPayloadSignature(
    project: Project,
    sourceUserId?: string,
    taskIdsToDelete?: string[],
  ): string {
    return JSON.stringify({
      project,
      sourceUserId: sourceUserId ?? null,
      taskIdsToDelete: [...(taskIdsToDelete ?? [])].sort(),
    });
  }

  private shouldStopProjectMutation(
    action: QueuedAction,
    userId: string,
    payload: ProjectPayload,
    actionType: 'create' | 'update'
  ): boolean {
    if (userId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      this.logger.warn(`project:${actionType} 跳过：本地模式不进入云端队列`, {
        projectId: payload.project.id,
      });
      return true;
    }

    const currentProject = this.projectState.getProject(payload.project.id);
    const currentProjectSynced = currentProject?.syncSource === 'synced';
    if ((payload.project.syncSource === 'local-only' || currentProject?.syncSource === 'local-only') && !currentProjectSynced) {
      this.logger.warn(`project:${actionType} 跳过：local-only 项目不进入云端队列`, {
        projectId: payload.project.id,
      });
      return true;
    }

    if (payload.sourceUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      this.quarantineLegacyQueueAction(
        action,
        `project:${actionType} legacy local-user 队列项禁止自动上云，请人工确认后重试`
      );
      return true;
    }

    if (payload.sourceUserId && payload.sourceUserId !== userId) {
      this.quarantineLegacyQueueAction(
        action,
        `project:${actionType} 队列来源用户 ${payload.sourceUserId} 与当前账号 ${userId} 不匹配，已转入失败记录`
      );
      return true;
    }

    if (typeof payload.sourceUserId !== 'string') {
      this.quarantineLegacyQueueAction(
        action,
        `project:${actionType} legacy 队列项缺少来源元数据，无法安全判断归属，已转入失败记录`
      );
      return true;
    }

    return false;
  }

  private async persistConflictWithoutRemote(
    localProject: Project,
    mutationContext: ProjectMutationContext,
    actionType: 'project:create' | 'project:update',
    pendingTaskDeleteIds?: string[],
  ): Promise<boolean> {
    const remoteProject = await this.syncService.loadFullProjectOptimized(localProject.id).catch(() => null);
    if (this.getProjectMutationStaleness(mutationContext) !== 'current') {
      return true;
    }

    if (remoteProject) {
      if (this.projectConflictHandler) {
        this.projectConflictHandler(localProject, remoteProject, mutationContext.ownerUserId, pendingTaskDeleteIds);
        return true;
      }

      await this.conflictStorage.saveConflict({
        projectId: localProject.id,
        localProject,
        remoteProject,
        ownerUserId: mutationContext.ownerUserId,
        remoteSnapshotFresh: true,
        conflictedAt: new Date().toISOString(),
        localVersion: localProject.version ?? 0,
        remoteVersion: remoteProject.version ?? 0,
        reason: 'version_mismatch',
        pendingTaskDeleteIds,
        acknowledged: false,
      });
      this.toast.warning('检测到数据冲突', '已补拉远端版本，冲突详情已转入冲突中心');
      return true;
    }

    await this.conflictStorage.saveConflict({
      projectId: localProject.id,
      localProject,
      ownerUserId: mutationContext.ownerUserId,
      conflictedAt: new Date().toISOString(),
      localVersion: localProject.version ?? 0,
      reason: 'version_mismatch',
      pendingTaskDeleteIds,
      acknowledged: false,
    });
    this.toast.warning('检测到数据冲突', '远端详情暂不可用，已转入冲突中心等待处理');
    return true;
  }

  private shouldStopProjectDelete(
    action: QueuedAction,
    userId: string,
    payload: ProjectDeletePayload,
    sourceUserId: string | null,
  ): boolean {
    if (userId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      this.logger.warn('project:delete 跳过：本地模式不进入云端队列', {
        projectId: payload.projectId,
      });
      return true;
    }

    if (sourceUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      this.quarantineLegacyQueueAction(
        action,
        'project:delete legacy local-user 删除队列项禁止自动上云，请人工确认后重试'
      );
      return true;
    }

    if (!sourceUserId) {
      this.quarantineLegacyQueueAction(
        action,
        'project:delete legacy 队列项缺少来源元数据，无法安全判断归属，已转入失败记录'
      );
      return true;
    }

    if (sourceUserId !== userId) {
      this.quarantineLegacyQueueAction(
        action,
        `project:delete 队列来源用户 ${sourceUserId} 与当前账号 ${userId} 不匹配，已转入失败记录`
      );
      return true;
    }

    return false;
  }

  private setupTaskProcessors(): void {
    // 任务创建
    this.actionQueue.registerProcessor('task:create', async (action) => {
      const userId = this.authService.currentUserId();
      if (!userId) { this.logger.warn('task:create 失败：用户未登录'); return false; }
      const payload = action.payload as TaskPayload;
      if (this.shouldStopTaskMutation(action, userId, payload, 'create')) {
        return true;
      }
      try {
        const success = await this.syncService.pushTask(
          payload.task,
          payload.projectId,
          false,
          false,
          payload.sourceUserId,
          true,
        );
        if (success) {
          this.actionQueue.markActionSyncedRemotely(action.id);
        }
        return success;
      } catch (error) {
        if (this.isTaskTombstoneNoOp(error)) {
          this.actionQueue.markActionResolvedWithoutRemote(action.id);
          this.logger.info('task:create 命中远端 tombstone，丢弃过期 upsert', { taskId: payload.task.id });
          return true;
        }
        this.logger.error('task:create 异常', { error, taskId: payload.task.id });
        return false;
      }
    });

    // 任务更新
    this.actionQueue.registerProcessor('task:update', async (action) => {
      const userId = this.authService.currentUserId();
      if (!userId) { this.logger.warn('task:update 失败：用户未登录'); return false; }
      const payload = action.payload as TaskPayload;
      if (this.shouldStopTaskMutation(action, userId, payload, 'update')) {
        return true;
      }
      try {
        const success = await this.syncService.pushTask(
          payload.task,
          payload.projectId,
          false,
          false,
          payload.sourceUserId,
          true,
        );
        if (success) {
          this.actionQueue.markActionSyncedRemotely(action.id);
        }
        return success;
      } catch (error) {
        if (this.isTaskTombstoneNoOp(error)) {
          this.actionQueue.markActionResolvedWithoutRemote(action.id);
          this.logger.info('task:update 命中远端 tombstone，丢弃过期 upsert', { taskId: payload.task.id });
          return true;
        }
        this.logger.error('task:update 异常', { error, taskId: payload.task.id });
        return false;
      }
    });

    // 任务删除
    this.actionQueue.registerProcessor('task:delete', async (action) => {
      const userId = this.authService.currentUserId();
      if (!userId) { this.logger.warn('task:delete 失败：用户未登录'); return false; }
      const payload = action.payload as TaskDeletePayload;
      if (this.shouldStopTaskDelete(action, userId, payload)) {
        return true;
      }
      try {
        const success = await this.syncService.deleteTask(payload.taskId, payload.projectId, payload.sourceUserId);
        if (success) {
          this.actionQueue.markActionSyncedRemotely(action.id);
        }
        return success;
      } catch (error) {
        this.logger.error('task:delete 异常', { error, taskId: payload.taskId });
        return false;
      }
    });
  }

  private shouldStopTaskMutation(
    action: QueuedAction,
    userId: string,
    payload: TaskPayload,
    actionType: 'create' | 'update'
  ): boolean {
    if (userId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      this.logger.warn(`task:${actionType} 跳过：本地模式不进入云端队列`, {
        taskId: payload.task.id,
        projectId: payload.projectId,
      });
      return true;
    }

    if (payload.sourceUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      this.quarantineLegacyQueueAction(
        action,
        `task:${actionType} legacy local-user 队列项禁止自动上云，请人工确认后重试`
      );
      return true;
    }

    if (payload.sourceUserId && payload.sourceUserId !== userId) {
      this.quarantineLegacyQueueAction(
        action,
        `task:${actionType} 队列来源用户 ${payload.sourceUserId} 与当前账号 ${userId} 不匹配，已转入失败记录`
      );
      return true;
    }

    const currentProject = this.projectState.getProject(payload.projectId);
    if (currentProject?.syncSource === 'local-only') {
      this.logger.warn(`task:${actionType} 跳过：local-only 项目不进入云端队列`, {
        taskId: payload.task.id,
        projectId: payload.projectId,
      });
      return true;
    }

    if (typeof payload.sourceUserId !== 'string') {
      this.quarantineLegacyQueueAction(
        action,
        `task:${actionType} legacy 队列项缺少来源元数据，无法安全判断归属，已转入失败记录`
      );
      return true;
    }

    return false;
  }

  private shouldStopTaskDelete(action: QueuedAction, userId: string, payload: TaskDeletePayload): boolean {
    if (userId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      this.logger.warn('task:delete 跳过：本地模式不进入云端队列', {
        taskId: payload.taskId,
        projectId: payload.projectId,
      });
      return true;
    }

    if (payload.sourceUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      this.quarantineLegacyQueueAction(
        action,
        'task:delete legacy local-user 队列项禁止自动上云，请人工确认后重试'
      );
      return true;
    }

    if (payload.sourceUserId && payload.sourceUserId !== userId) {
      this.quarantineLegacyQueueAction(
        action,
        `task:delete 队列来源用户 ${payload.sourceUserId} 与当前账号 ${userId} 不匹配，已转入失败记录`
      );
      return true;
    }

    const currentProject = this.projectState.getProject(payload.projectId);
    if (currentProject?.syncSource === 'local-only') {
      this.logger.warn('task:delete 跳过：local-only 项目不进入云端队列', {
        taskId: payload.taskId,
        projectId: payload.projectId,
      });
      return true;
    }

    if (typeof payload.sourceUserId !== 'string') {
      this.quarantineLegacyQueueAction(
        action,
        'task:delete legacy 队列项缺少来源元数据，无法安全判断归属，已转入失败记录'
      );
      return true;
    }

    return false;
  }

  private setupPreferenceProcessors(): void {
    this.actionQueue.registerProcessor('preference:update', async (action) => {
      const userId = this.authService.currentUserId();
      if (!userId) { this.logger.warn('preference:update 失败：用户未登录'); return false; }
      if (userId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
        this.logger.warn('preference:update 跳过：本地模式不进入云端队列');
        return true;
      }
      
      const payload = action.payload as PreferencePayload;
      if (this.hasConflictingOwnerHints(action, 'preference:update', payload.sourceUserId, payload.userId)) {
        return true;
      }

      const sourceUserId = this.resolveActionSourceUserId(payload.sourceUserId, payload.userId);
      if (this.shouldStopUserScopedQueueAction(action, userId, 'preference:update', sourceUserId)) {
        return true;
      }
      if (!sourceUserId) {
        return false;
      }
      try {
        const success = await this.syncService.saveUserPreferences(sourceUserId, payload.preferences);
        if (success) {
          this.actionQueue.markActionSyncedRemotely(action.id);
        }
        return success;
      } catch (error) {
        this.logger.error('preference:update 异常', { error });
        return false;
      }
    });
  }

  private quarantineLegacyQueueAction(action: QueuedAction, reason: string): void {
    this.logger.warn('检测到需人工确认的离线队列项，已转入失败记录', {
      actionId: action.id,
      entityType: action.entityType,
      entityId: action.entityId,
      reason,
    });
    this.actionQueue.moveToDeadLetter(action, reason);
    if (!this.legacyQueueWarningShown) {
      this.legacyQueueWarningShown = true;
      this.toast.warning('检测到待确认的离线变更', '旧版或跨账号的队列项已转入失败记录，请确认后再重试');
    }
  }

  private setupFocusConsoleProcessors(): void {
    this.actionQueue.registerProcessor('focus-session:create', async action => {
      const userId = this.authService.currentUserId();
      if (!userId) { this.logger.warn('focus-session:create 失败：用户未登录'); return false; }

      const payload = action.payload as FocusSessionPayload;
      if (!payload.record) { this.logger.warn('focus-session:create 失败：缺少 record'); return false; }
      if (this.hasConflictingOwnerHints(action, 'focus-session:create', payload.sourceUserId, payload.record.userId)) {
        return true;
      }

      const sourceUserId = this.resolveActionSourceUserId(payload.sourceUserId, payload.record.userId);
      if (this.shouldStopUserScopedQueueAction(action, userId, 'focus-session:create', sourceUserId)) {
        return true;
      }
      if (!sourceUserId) {
        return false;
      }

      try {
        const record: FocusSessionRecord = payload.record.userId
          ? payload.record
          : { ...payload.record, userId: sourceUserId };
        const result = await this.syncService.saveFocusSession(record);
        if (!result.ok) {
          throw this.buildOperationError(result.error);
        }
        return this.markRemoteActionSuccess(action.id);
      } catch (error) {
        this.logProcessorFailure('focus-session:create', error);
        throw error;
      }
    });

    this.actionQueue.registerProcessor('focus-session:update', async action => {
      const userId = this.authService.currentUserId();
      if (!userId) { this.logger.warn('focus-session:update 失败：用户未登录'); return false; }

      const payload = action.payload as FocusSessionPayload;
      if (!payload.record) { this.logger.warn('focus-session:update 失败：缺少 record'); return false; }
      if (this.hasConflictingOwnerHints(action, 'focus-session:update', payload.sourceUserId, payload.record.userId)) {
        return true;
      }

      const sourceUserId = this.resolveActionSourceUserId(payload.sourceUserId, payload.record.userId);
      if (this.shouldStopUserScopedQueueAction(action, userId, 'focus-session:update', sourceUserId)) {
        return true;
      }
      if (!sourceUserId) {
        return false;
      }

      try {
        const record: FocusSessionRecord = payload.record.userId
          ? payload.record
          : { ...payload.record, userId: sourceUserId };
        const result = await this.syncService.saveFocusSession(record);
        if (!result.ok) {
          throw this.buildOperationError(result.error);
        }
        return this.markRemoteActionSuccess(action.id);
      } catch (error) {
        this.logProcessorFailure('focus-session:update', error);
        throw error;
      }
    });

    this.actionQueue.registerProcessor('routine-task:create', async action => {
      const userId = this.authService.currentUserId();
      if (!userId) { this.logger.warn('routine-task:create 失败：用户未登录'); return false; }

      const payload = action.payload as RoutineTaskPayload;
      if (this.hasConflictingOwnerHints(action, 'routine-task:create', payload.sourceUserId, payload.userId)) {
        return true;
      }

      const sourceUserId = this.resolveActionSourceUserId(payload.sourceUserId, payload.userId);
      if (this.shouldStopUserScopedQueueAction(action, userId, 'routine-task:create', sourceUserId)) {
        return true;
      }
      if (!sourceUserId) {
        return false;
      }

      try {
        const result = await this.syncService.upsertRoutineTask(sourceUserId, payload.routineTask);
        if (!result.ok) {
          throw this.buildOperationError(result.error);
        }
        return this.markRemoteActionSuccess(action.id);
      } catch (error) {
        this.logger.error('routine-task:create 异常', { error });
        throw error;
      }
    });

    this.actionQueue.registerProcessor('routine-task:update', async action => {
      const userId = this.authService.currentUserId();
      if (!userId) { this.logger.warn('routine-task:update 失败：用户未登录'); return false; }

      const payload = action.payload as RoutineTaskPayload;
      if (this.hasConflictingOwnerHints(action, 'routine-task:update', payload.sourceUserId, payload.userId)) {
        return true;
      }

      const sourceUserId = this.resolveActionSourceUserId(payload.sourceUserId, payload.userId);
      if (this.shouldStopUserScopedQueueAction(action, userId, 'routine-task:update', sourceUserId)) {
        return true;
      }
      if (!sourceUserId) {
        return false;
      }

      try {
        const result = await this.syncService.upsertRoutineTask(sourceUserId, payload.routineTask);
        if (!result.ok) {
          throw this.buildOperationError(result.error);
        }
        return this.markRemoteActionSuccess(action.id);
      } catch (error) {
        this.logger.error('routine-task:update 异常', { error });
        throw error;
      }
    });

    this.actionQueue.registerProcessor('routine-completion:create', async action => {
      const userId = this.authService.currentUserId();
      if (!userId) { this.logger.warn('routine-completion:create 失败：用户未登录'); return false; }

      const payload = action.payload as RoutineCompletionPayload;
      if (!payload.completion) { this.logger.warn('routine-completion:create 失败：缺少 completion'); return false; }
      if (this.hasConflictingOwnerHints(action, 'routine-completion:create', payload.sourceUserId, payload.completion.userId)) {
        return true;
      }

      const sourceUserId = this.resolveActionSourceUserId(payload.sourceUserId, payload.completion.userId);
      if (this.shouldStopUserScopedQueueAction(action, userId, 'routine-completion:create', sourceUserId)) {
        return true;
      }
      if (!sourceUserId) {
        return false;
      }

      try {
        const completion: RoutineCompletionMutation = payload.completion.userId
          ? payload.completion
          : { ...payload.completion, userId: sourceUserId };
        const result = await this.syncService.incrementRoutineCompletion(completion);
        if (!result.ok) {
          throw this.buildOperationError(result.error);
        }
        return this.markRemoteActionSuccess(action.id);
      } catch (error) {
        this.logger.error('routine-completion:create 异常', { error });
        throw error;
      }
    });

    this.actionQueue.registerProcessor('routine-completion:update', async action => {
      const userId = this.authService.currentUserId();
      if (!userId) { this.logger.warn('routine-completion:update 失败：用户未登录'); return false; }

      const payload = action.payload as RoutineCompletionPayload;
      if (!payload.completion) { this.logger.warn('routine-completion:update 失败：缺少 completion'); return false; }
      if (this.hasConflictingOwnerHints(action, 'routine-completion:update', payload.sourceUserId, payload.completion.userId)) {
        return true;
      }

      const sourceUserId = this.resolveActionSourceUserId(payload.sourceUserId, payload.completion.userId);
      if (this.shouldStopUserScopedQueueAction(action, userId, 'routine-completion:update', sourceUserId)) {
        return true;
      }
      if (!sourceUserId) {
        return false;
      }

      try {
        const completion: RoutineCompletionMutation = payload.completion.userId
          ? payload.completion
          : { ...payload.completion, userId: sourceUserId };
        const result = await this.syncService.incrementRoutineCompletion(completion);
        if (!result.ok) {
          throw this.buildOperationError(result.error);
        }
        return this.markRemoteActionSuccess(action.id);
      } catch (error) {
        this.logger.error('routine-completion:update 异常', { error });
        throw error;
      }
    });
  }
}
