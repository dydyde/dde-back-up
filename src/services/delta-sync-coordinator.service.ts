/**
 * DeltaSyncCoordinatorService - Delta Sync 增量同步协调器
 * 
 * 职责：
 * - Delta Sync 增量同步逻辑
 * - 项目内容差异检测
 * - LWW 冲突合并
 * 
 * 从 SyncCoordinatorService 提取，作为 Sprint 9 技术债务修复的一部分
 */

import { Injectable, inject } from '@angular/core';
import { SimpleSyncService, TombstoneService } from '../core-bridge';
import { ConflictDetectionService } from './conflict-detection.service';
import { ProjectStateService } from './project-state.service';
import { ChangeTrackerService } from './change-tracker.service';
import { LoggerService } from './logger.service';
import { Project, Task, Connection } from '../models';
import { SYNC_CONFIG } from '../config';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import {
  isBrowserNetworkSuspendedError,
  isBrowserNetworkSuspendedWindow,
} from '../utils/browser-network-suspension';

@Injectable({
  providedIn: 'root'
})
export class DeltaSyncCoordinatorService {
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly syncService = inject(SimpleSyncService);
  private readonly conflictDetection = inject(ConflictDetectionService);
  private readonly projectState = inject(ProjectStateService);
  private readonly changeTracker = inject(ChangeTrackerService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('DeltaSyncCoordinator');
  private readonly tombstoneService = inject(TombstoneService);

  private getConnectionDiffKey(connection: Connection): string {
    return connection.id || `${connection.source}->${connection.target}`;
  }

  private buildConnectionDiffSignature(connection: Connection): string {
    return JSON.stringify([
      connection.source,
      connection.target,
      connection.title ?? '',
      connection.description ?? '',
      connection.deletedAt ?? '',
    ]);
  }

  private parseTimestamp(value: string | undefined | null): number {
    if (!value) {
      return 0;
    }
    const parsed = new Date(value).getTime();
    return Number.isNaN(parsed) ? Number.NaN : parsed;
  }

  private mergeProtectedDeltaTask(localTask: Task, remoteTask: Task, projectId: string): Task {
    const pending = this.changeTracker.getPendingChange(
      projectId,
      'task',
      localTask.id,
      SYNC_CONFIG.DIRTY_PROTECTION_WINDOW_MS,
    );
    const protectedFields = new Set(pending?.changedFields ?? []);
    const lockedFields = this.changeTracker.getLockedFields(localTask.id, projectId);
    for (const field of lockedFields) {
      protectedFields.add(field);
    }

    const mergedTask: Record<string, unknown> = { ...remoteTask };

    const localTime = this.parseTimestamp(localTask.updatedAt);
    const remoteTime = this.parseTimestamp(remoteTask.updatedAt);
    if (!Number.isNaN(localTime) && !Number.isNaN(remoteTime) && localTime >= remoteTime) {
      for (const field of ['status', 'stage', 'parentId', 'rank', 'order', 'title', 'content', 'deletedAt']) {
        protectedFields.add(field);
      }
    }

    const contentLost = Boolean(
      localTask.content && (remoteTask.content === undefined || remoteTask.content === null),
    );
    const titleLost = Boolean(
      localTask.title && (remoteTask.title === undefined || remoteTask.title === null),
    );

    if (contentLost || titleLost) {
      this.logger.warn('Delta Sync: 检测到远程字段缺失，保留本地内容', {
        taskId: remoteTask.id,
        contentLost,
        titleLost,
        localContentLength: localTask.content?.length ?? 0,
      });
      this.sentryLazyLoader.captureMessage('Delta Sync: Content protection triggered', {
        level: 'warning',
        tags: { operation: 'performDeltaSync', taskId: remoteTask.id },
        extra: { localContentLength: localTask.content?.length ?? 0, projectId, contentLost, titleLost },
      });
      if (contentLost) {
        mergedTask.content = localTask.content;
      }
      if (titleLost) {
        mergedTask.title = localTask.title;
      }
    }

    for (const field of protectedFields) {
      mergedTask[field] = localTask[field as keyof Task];
    }

    if (localTask.deletedAt && !remoteTask.deletedAt) {
      const localDeleteTime = this.parseTimestamp(localTask.deletedAt);
      if (!Number.isNaN(localDeleteTime) && localDeleteTime > remoteTime) {
        return localTask;
      }
    }

    if (remoteTask.deletedAt) {
      mergedTask.deletedAt = remoteTask.deletedAt;
    }

    return mergedTask as unknown as Task;
  }

  /**
   * Delta Sync 增量同步
   * 
   * 【核心优化】从 MB 级全量拉取降至 ~1 KB 增量检查
   */
  async performDeltaSync(projectId: string): Promise<{ taskChanges: number; connectionChanges: number }> {
    if (!SYNC_CONFIG.DELTA_SYNC_ENABLED) {
      return { taskChanges: 0, connectionChanges: 0 };
    }

    this.logger.debug('开始 Delta Sync 增量同步', { projectId });

    try {
      const { tasks, connections, nextCursor } = await this.syncService.checkForDrift(projectId);
      
      if (tasks.length === 0 && connections.length === 0) {
        this.logger.debug('Delta Sync 无变更', { projectId });
        return { taskChanges: 0, connectionChanges: 0 };
      }

      const currentProject = this.projectState.getProject(projectId);
      if (!currentProject) {
        this.logger.warn('Delta Sync 项目不存在', { projectId });
        return { taskChanges: 0, connectionChanges: 0 };
      }

      // 合并任务增量
      const mergedTasks = this.mergeTasksDelta(currentProject.tasks, tasks, projectId);
      
      // 合并连接增量
      const mergedConnections = this.mergeConnectionsDelta(
        currentProject.connections ?? [], 
        connections,
        projectId
      );

      // 更新 ProjectStateService
      const projectUpdatedAt = this.pickLatestTimestamp(
        currentProject.updatedAt,
        tasks.map(t => t.updatedAt).filter((v): v is string => !!v),
        connections.map(c => c.updatedAt).filter((v): v is string => !!v)
      );
      this.projectState.updateProjects(ps => ps.map(p => {
        if (p.id === projectId) {
          return {
            ...p,
            tasks: mergedTasks,
            connections: mergedConnections,
            updatedAt: projectUpdatedAt
          };
        }
        return p;
      }));

      if (nextCursor) {
        await this.syncService.saveOfflineSnapshotAndWait(this.projectState.projects());
        await this.syncService.commitProjectSyncCursor(projectId, nextCursor);
      }

      this.logger.info('Delta Sync 完成', {
        projectId,
        taskChanges: tasks.length,
        connectionChanges: connections.length
      });

      return { taskChanges: tasks.length, connectionChanges: connections.length };
    } catch (error) {
      if (isBrowserNetworkSuspendedError(error) || isBrowserNetworkSuspendedWindow()) {
        this.logger.debug('浏览器网络挂起，延后 Delta Sync', { projectId });
        return { taskChanges: 0, connectionChanges: 0 };
      }

      this.logger.error('Delta Sync 失败', { projectId, error });
      this.sentryLazyLoader.captureException(error, {
        tags: { operation: 'performDeltaSync' },
        extra: { projectId }
      });
      return { taskChanges: 0, connectionChanges: 0 };
    }
  }

  /**
   * 合并任务增量
   */
  private mergeTasksDelta(
    existingTasks: Task[], 
    deltaTasks: Task[], 
    projectId: string
  ): Task[] {
    const taskMap = new Map(existingTasks.map(t => [t.id, t]));
    
    for (const deltaTask of deltaTasks) {
      const existing = taskMap.get(deltaTask.id);
      const deltaTime = this.parseTimestamp(deltaTask.updatedAt);
      const existingTime = this.parseTimestamp(existing?.updatedAt);

      // NaN 保护：malformed ISO 字符串会导致 getTime() 返回 NaN
      if (Number.isNaN(deltaTime) || Number.isNaN(existingTime)) {
        this.logger.warn('Delta Sync: 检测到无效时间戳，跳过合并', {
          taskId: deltaTask.id,
          deltaUpdatedAt: deltaTask.updatedAt,
          existingUpdatedAt: existing?.updatedAt
        });
        continue;
      }

      if (!deltaTask.deletedAt && this.tombstoneService.shouldRejectTaskUpsert(projectId, deltaTask.id, deltaTask.updatedAt)) {
        this.logger.info('Delta Sync: 跳过 tombstone 任务', {
          taskId: deltaTask.id,
          candidateUpdatedAt: deltaTask.updatedAt ?? null,
        });
        continue;
      }

      if (!existing) {
        if (!deltaTask.deletedAt) {
          taskMap.set(deltaTask.id, deltaTask);
        }
        continue;
      }

      if (deltaTime > existingTime) {
        const mergedTask = this.mergeProtectedDeltaTask(existing, deltaTask, projectId);
        taskMap.set(deltaTask.id, mergedTask);
      }
    }
    
    return Array.from(taskMap.values());
  }

  /**
   * 合并连接增量
   */
  private mergeConnectionsDelta(
    existingConnections: Connection[],
    deltaConnections: Connection[],
    _projectId: string
  ): Connection[] {
    return this.conflictDetection.mergeConnections(existingConnections, deltaConnections);
  }

  /**
   * 检查两个项目是否有内容差异
   */
  hasProjectContentDifference(project1: Project, project2: Project): boolean {
    if (project1.tasks.length !== project2.tasks.length) return true;
    if ((project1.connections?.length ?? 0) !== (project2.connections?.length ?? 0)) return true;
    
    const tasks1Map = new Map(project1.tasks.map(t => [t.id, t]));
    const tasks2Map = new Map(project2.tasks.map(t => [t.id, t]));
    
    let hasDifference = false;
    tasks1Map.forEach((_task1, id) => {
      if (!tasks2Map.has(id)) {
        hasDifference = true;
      }
    });
    if (hasDifference) return true;
    
    tasks1Map.forEach((task1, id) => {
      const task2 = tasks2Map.get(id);
      if (!task2) {
        hasDifference = true;
        return;
      }
      if (task1.title !== task2.title || task1.content !== task2.content) {
        hasDifference = true;
        return;
      }
      if (task1.parentId !== task2.parentId || task1.stage !== task2.stage) {
        hasDifference = true;
      }
    });
    if (hasDifference) return true;

    const project1Connections = project1.connections ?? [];
    const project2Connections = project2.connections ?? [];
    const project1ConnectionMap = new Map(
      project1Connections.map(connection => [
        this.getConnectionDiffKey(connection),
        this.buildConnectionDiffSignature(connection)
      ])
    );

    for (const connection of project2Connections) {
      const key = this.getConnectionDiffKey(connection);
      if (project1ConnectionMap.get(key) !== this.buildConnectionDiffSignature(connection)) {
        return true;
      }
      project1ConnectionMap.delete(key);
    }

    if (project1ConnectionMap.size > 0) {
      return true;
    }
    
    return false;
  }

  private pickLatestTimestamp(base: string | undefined, ...timestampGroups: string[][]): string {
    let max = base ? new Date(base).getTime() : 0;
    if (Number.isNaN(max)) max = 0;
    for (const group of timestampGroups) {
      for (const ts of group) {
        const t = new Date(ts).getTime();
        if (!Number.isNaN(t)) {
          max = Math.max(max, t);
        }
      }
    }
    return max > 0 ? new Date(max).toISOString() : new Date().toISOString();
  }
}
