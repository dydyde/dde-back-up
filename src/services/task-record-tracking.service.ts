/**
 * TaskRecordTrackingService - 任务操作记录与追踪
 *
 * 从 TaskOperationAdapterService 拆分，负责：
 * - 操作记录（recordAndUpdate / recordAndUpdateDebounced）
 * - 撤销/重做（performUndo / performRedo）
 * - 变更追踪（trackChanges / getChangedTaskFields）
 * - 同步结果处理（setupSyncResultHandler）
 * - Toast 辅助（showUndoToast）
 */
import { Injectable, inject } from '@angular/core';
import { ProjectStateService } from './project-state.service';
import { UndoService } from './undo.service';
import { SyncCoordinatorService } from './sync-coordinator.service';
import { ChangeTrackerService } from './change-tracker.service';
import { LayoutService } from './layout.service';
import { OptimisticStateService } from './optimistic-state.service';
import { ToastService } from './toast.service';
import { UiStateService } from './ui-state.service';
import { LoggerService } from './logger.service';
import { POLLING_CHECK_DELAY } from '../config/timeout.config';
import { Project, Task, Connection } from '../models';
import { softDeleteParentChildDuplicateConnections } from '../utils/parent-child-connection-integrity';

@Injectable({
  providedIn: 'root'
})
export class TaskRecordTrackingService {
  private readonly projectState = inject(ProjectStateService);
  private readonly undoService = inject(UndoService);
  private readonly syncCoordinator = inject(SyncCoordinatorService);
  private readonly changeTracker = inject(ChangeTrackerService);
  private readonly layoutService = inject(LayoutService);
  private readonly optimisticState = inject(OptimisticStateService);
  private readonly toastService = inject(ToastService);
  private readonly uiState = inject(UiStateService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('TaskRecord');

  /** 更新锁：防止快照和更新之间的竞态条件 */
  private isUpdating = false;

  /** 上次更新类型（由 adapter 在调用 core 方法前设置） */
  lastUpdateType: 'content' | 'structure' | 'position' = 'structure';

  private getConnectionTrackingKey(connection: Pick<Connection, 'id' | 'source' | 'target'>): string | null {
    if (!connection.id) {
      this.logger.error('连接缺少 id，已跳过变更追踪', {
        source: connection.source,
        target: connection.target,
      });
      return null;
    }

    return connection.id;
  }

  private normalizeProjectConnections(project: Project): Project {
    if (project.connections.length === 0) {
      return project;
    }

    const now = new Date().toISOString();
    const normalizedConnections = softDeleteParentChildDuplicateConnections(project.tasks, project.connections, now);

    if (normalizedConnections === project.connections) {
      return project;
    }

    const affectedConnectionIds: string[] = [];
    for (let index = 0; index < project.connections.length; index += 1) {
      const beforeConnection = project.connections[index];
      const afterConnection = normalizedConnections[index];
      if (!beforeConnection || !afterConnection) {
        continue;
      }

      if (!beforeConnection.deletedAt && !!afterConnection.deletedAt) {
        affectedConnectionIds.push(afterConnection.id);
      }
    }

    this.logger.warn('检测到与 parentId 重复的 shadow connection，已自动软删', {
      projectId: project.id,
      affectedConnectionIds,
    });

    return {
      ...project,
      connections: normalizedConnections,
    };
  }

  // ========== Toast 辅助 ==========

  /** 显示带撤销按钮的 Toast（移动端带按钮，桌面端纯文字提示） */
  showUndoToast(message: string): void {
    const isMobile = this.uiState.isMobile();
    this.toastService.success(
      message,
      undefined,
      isMobile ? {
        duration: 5000,
        action: {
          label: '撤销',
          onClick: () => this.performUndo()
        }
      } : { duration: 3000 }
    );
  }

  // ========== 撤销/重做 ==========

  /** 执行撤销操作 */
  performUndo(): void {
    const activeProject = this.projectState.activeProject();
    const currentVersion = activeProject?.version;
    const result = this.undoService.undo(currentVersion);

    if (!result) {
      this.logger.warn('没有可撤销的操作');
      return;
    }

    if (result === 'version-mismatch') {
      this.toastService.warning('撤销失败', '远程数据已更新过多，无法撤销。');
      if (activeProject) {
        this.undoService.clearOutdatedHistory(activeProject.id, currentVersion ?? 0);
      }
      return;
    }

    if (typeof result === 'object' && 'type' in result && result.type === 'version-mismatch-forceable') {
      this.toastService.warning(
        '撤销注意',
        `当前内容已被新修改改变 (${result.versionDiff} 个版本)，撤销可能会覆盖最新内容。`
      );
      const action = this.undoService.forceUndo();
      if (action) {
        this.applyProjectSnapshot(action.projectId, action.data.before, {
          kind: 'undo',
          previousSnapshot: action.data.after,
        });
      }
      return;
    }

    const action = result;
    this.applyProjectSnapshot(action.projectId, action.data.before, {
      kind: 'undo',
      previousSnapshot: action.data.after,
    });
    this.logger.info('撤销操作成功', { projectId: action.projectId, type: action.type });
  }

  /** 执行重做操作 */
  performRedo(): void {
    const activeProject = this.projectState.activeProject();
    const currentVersion = activeProject?.version;
    const result = this.undoService.redo(currentVersion);

    if (!result) {
      this.logger.debug('没有可重做的操作');
      return;
    }

    if (result === 'version-mismatch') {
      this.toastService.warning('重做失败', '远程数据已更新，无法重做');
      return;
    }

    if (typeof result === 'object' && 'type' in result && result.type === 'version-mismatch-forceable') {
      this.toastService.warning('重做失败', '远程数据已更新，无法重做');
      return;
    }

    const action = result;
    this.applyProjectSnapshot(action.projectId, action.data.after, {
      kind: 'redo',
      previousSnapshot: action.data.before,
    });
    this.logger.info('重做操作成功', { projectId: action.projectId, type: action.type });
  }

  /** 应用项目快照 */
  private applyProjectSnapshot(
    projectId: string,
    snapshot: Partial<Project>,
    replay?: { kind: 'undo' | 'redo'; previousSnapshot?: Partial<Project> },
  ): void {
    this.projectState.updateProjects(projects => projects.map(p => {
      if (p.id === projectId) {
        return this.layoutService.rebalance(this.normalizeProjectConnections({
          ...p,
          tasks: snapshot.tasks ?? p.tasks,
          connections: snapshot.connections ?? p.connections
        }));
      }
      return p;
    }));
    this.syncCoordinator.markLocalChanges('structure');
    this.syncCoordinator.schedulePersist();
    if (replay) {
      this.undoService.notifyReplayApplied(replay.kind, projectId, snapshot, replay.previousSnapshot);
    }
  }

  // ========== 记录与更新 ==========

  /**
   * 记录操作并更新项目（立即记录撤销历史）
   * 竞态条件保护：通过 isUpdating 锁确保快照和更新的原子性
   */
  recordAndUpdate(mutator: (project: Project) => Project): void {
    if (this.isUpdating) {
      this.logger.warn('[TaskRecord] 检测到并发更新，跳过本次操作');
      return;
    }

    this.isUpdating = true;

    try {
      const project = this.projectState.activeProject();
      if (!project) return;

      const targetProjectId = project.id;
      this.lastUpdateType = 'structure';

      const beforeSnapshot = this.undoService.createProjectSnapshot(project);
      const currentVersion = project.version ?? 0;
      const beforeTaskMap = new Map(project.tasks.map(t => [t.id, t]));
      const beforeConnectionMap = new Map<string, Connection>();
      for (const connection of project.connections) {
        const key = this.getConnectionTrackingKey(connection);
        if (key) {
          beforeConnectionMap.set(key, connection);
        }
      }

      let afterProject: Project | null = null;
      this.projectState.updateProjects(projects => projects.map(p => {
        if (p.id === targetProjectId) {
          afterProject = this.normalizeProjectConnections(mutator(p));
          return afterProject;
        }
        return p;
      }));

      if (afterProject && !this.undoService.isProcessing) {
        const afterSnapshot = this.undoService.createProjectSnapshot(afterProject);
        this.undoService.recordAction({
          type: 'task-update',
          projectId: targetProjectId,
          data: { before: beforeSnapshot, after: afterSnapshot }
        }, currentVersion);

        this.trackChanges(targetProjectId, beforeTaskMap, beforeConnectionMap, afterProject);
      }

      // 【P3-32 修复】仅当实际产生变更时才触发同步
      if (afterProject) {
        this.syncCoordinator.markLocalChanges('structure');
        this.syncCoordinator.schedulePersist();
      }
    } finally {
      this.isUpdating = false;
    }
  }

  /**
   * 记录操作并更新项目（防抖记录撤销历史）
   * 竞态条件保护：与 recordAndUpdate 相同的锁机制
   */
  recordAndUpdateDebounced(mutator: (project: Project) => Project): void {
    if (this.isUpdating) {
      this.logger.warn('[TaskRecord] 检测到并发更新，跳过本次操作');
      return;
    }

    this.isUpdating = true;

    try {
      const project = this.projectState.activeProject();
      if (!project) return;

      const targetProjectId = project.id;
      this.lastUpdateType = 'content';

      const beforeSnapshot = this.undoService.createProjectSnapshot(project);
      const currentVersion = project.version ?? 0;
      const beforeTaskMap = new Map(project.tasks.map(t => [t.id, t]));
      const beforeConnectionMap = new Map<string, Connection>();
      for (const connection of project.connections) {
        const key = this.getConnectionTrackingKey(connection);
        if (key) {
          beforeConnectionMap.set(key, connection);
        }
      }

      let afterProject: Project | null = null;
      this.projectState.updateProjects(projects => projects.map(p => {
        if (p.id === targetProjectId) {
          afterProject = this.normalizeProjectConnections(mutator(p));
          return afterProject;
        }
        return p;
      }));

      if (afterProject && !this.undoService.isProcessing) {
        const afterSnapshot = this.undoService.createProjectSnapshot(afterProject);
        this.undoService.recordActionDebounced({
          type: 'task-update',
          projectId: targetProjectId,
          projectVersion: currentVersion,
          data: { before: beforeSnapshot, after: afterSnapshot }
        });

        this.trackChanges(targetProjectId, beforeTaskMap, beforeConnectionMap, afterProject);
      }

      this.syncCoordinator.markLocalChanges('content');
      this.syncCoordinator.schedulePersist();
    } finally {
      this.isUpdating = false;
    }
  }

  // ========== 同步结果处理 ==========

  /** 监听持久化结果，成功提交快照，失败回滚 */
  setupSyncResultHandler(snapshotId: string): void {
    const checkSync = () => {
      if (!this.optimisticState.hasSnapshot(snapshotId)) return;

      const syncError = this.syncCoordinator.syncError();
      if (syncError) {
        this.logger.warn('同步失败，回滚快照', { snapshotId, error: syncError });
        this.optimisticState.rollbackSnapshot(snapshotId);
        return;
      }

      if (!this.syncCoordinator.hasPendingLocalChanges()) {
        this.logger.debug('同步成功，提交快照', { snapshotId });
        this.optimisticState.commitSnapshot(snapshotId);
        return;
      }

      const snapshot = this.optimisticState['snapshots'].get(snapshotId);
      if (snapshot && Date.now() - snapshot.createdAt < 30000) {
        setTimeout(checkSync, POLLING_CHECK_DELAY.CONDITION_READY);
      } else {
        this.logger.debug('同步超时，假定成功', { snapshotId });
        this.optimisticState.commitSnapshot(snapshotId);
      }
    };

    setTimeout(checkSync, POLLING_CHECK_DELAY.SYNC_READY);
  }

  // ========== 变更追踪 ==========

  /** 追踪项目变更，记录到 ChangeTrackerService */
  private trackChanges(
    projectId: string,
    beforeTaskMap: Map<string, Task>,
    beforeConnectionMap: Map<string, Connection>,
    afterProject: Project
  ): void {
    const afterTaskIds = new Set<string>();

    for (const task of afterProject.tasks) {
      afterTaskIds.add(task.id);
      const beforeTask = beforeTaskMap.get(task.id);

      if (!beforeTask) {
        this.changeTracker.trackTaskCreate(projectId, task);
      } else {
        const changedFields = this.getChangedTaskFields(beforeTask, task);
        if (changedFields.length > 0) {
          this.changeTracker.trackTaskUpdate(projectId, task, changedFields);
        }
      }
    }

    for (const [taskId, _] of beforeTaskMap) {
      if (!afterTaskIds.has(taskId)) {
        this.changeTracker.trackTaskDelete(projectId, taskId);
      }
    }

    const afterConnectionMap = new Map<string, Connection>();
    for (const conn of afterProject.connections) {
      const key = this.getConnectionTrackingKey(conn);
      if (!key) {
        continue;
      }
      afterConnectionMap.set(key, conn);
      const beforeConn = beforeConnectionMap.get(key);

      if (!beforeConn) {
        this.changeTracker.trackConnectionCreate(projectId, conn);
      } else {
        const sourceChanged = beforeConn.source !== conn.source;
        const targetChanged = beforeConn.target !== conn.target;
        const titleChanged = beforeConn.title !== conn.title;
        const deletedAtChanged = beforeConn.deletedAt !== conn.deletedAt;
        const descriptionChanged = beforeConn.description !== conn.description;
        if (sourceChanged || targetChanged || titleChanged || deletedAtChanged || descriptionChanged) {
          this.changeTracker.trackConnectionUpdate(projectId, conn);
        }
      }
    }

    for (const [key, beforeConn] of beforeConnectionMap) {
      if (!afterConnectionMap.has(key)) {
        this.changeTracker.trackConnectionDelete(projectId, beforeConn);
      }
    }
  }

  /** 比较任务字段变更 */
  private getChangedTaskFields(before: Task, after: Task): string[] {
    const fields: string[] = [];
    if (before.title !== after.title) fields.push('title');
    if (before.content !== after.content) fields.push('content');
    if (before.status !== after.status) fields.push('status');
    if (before.stage !== after.stage) fields.push('stage');
    if (before.parentId !== after.parentId) fields.push('parentId');
    if (before.order !== after.order) fields.push('order');
    if (before.rank !== after.rank) fields.push('rank');
    if (before.x !== after.x) fields.push('x');
    if (before.y !== after.y) fields.push('y');
    if (before.priority !== after.priority) fields.push('priority');
    if (before.dueDate !== after.dueDate) fields.push('dueDate');
    if (before.expected_minutes !== after.expected_minutes) fields.push('expected_minutes');
    if (before.cognitive_load !== after.cognitive_load) fields.push('cognitive_load');
    if (before.wait_minutes !== after.wait_minutes) fields.push('wait_minutes');
    if (before.deletedAt !== after.deletedAt) fields.push('deletedAt');

    const tagsChanged = (before.tags?.length ?? 0) !== (after.tags?.length ?? 0) ||
      (before.tags ?? []).some((t, i) => t !== (after.tags ?? [])[i]);
    if (tagsChanged) fields.push('tags');
    const attachmentsChanged = (before.attachments?.length ?? 0) !== (after.attachments?.length ?? 0) ||
      (before.attachments ?? []).some((a, i) => a.id !== (after.attachments ?? [])[i]?.id);
    if (attachmentsChanged) fields.push('attachments');

    return fields;
  }

  // ========== 服务端删除保护 ==========

  /**
   * 触发服务端删除保护（异步）
   * 如果服务端拒绝，回滚本地状态
   */
  async triggerServerSideDelete(
    projectId: string,
    explicitIds: string[],
    snapshotId: string
  ): Promise<void> {
    try {
      const project = this.projectState.activeProject();
      if (!project) return;

      const justDeletedTaskIds = project.tasks
        .filter(t => t.deletedAt && explicitIds.some(id => {
          return t.id === id || this.isDescendantOf(t, id, project.tasks);
        }))
        .map(t => t.id);

      const tombstoneTimestamps = Object.fromEntries(
        project.tasks
          .filter(t => justDeletedTaskIds.includes(t.id))
          .map(t => [t.id, t.deletedAt ?? t.updatedAt ?? new Date().toISOString()])
      );

      if (justDeletedTaskIds.length === 0) return;

      const result = await this.syncCoordinator.softDeleteTasksBatch(projectId, justDeletedTaskIds, tombstoneTimestamps);

      if (result === -1) {
        this.logger.warn('服务端拒绝批量删除，仅回滚被拒任务（保留其它回收站项）', { projectId, taskIds: justDeletedTaskIds });
        // 【根因修复 2026-05-15】不再调用 rollbackSnapshot 整库回滚 ——
        // 整库回滚会把所有"老的回收站项 / 期间新增的合法编辑"一起拖回快照状态，
        // 表象就是"短时间删除大量任务后回收站全部消失"。
        // 这里改为只把这次被服务端拒绝的任务还原回快照中的状态（deletedAt/stage/parking 等），
        // 其它任务保持现状，回收站中既有的旧条目不受影响。
        this.optimisticState.restoreTasksFromSnapshot(snapshotId, justDeletedTaskIds, {
          showToast: false,
        });
        this.toastService.warning('删除被服务端阻止', '批量删除超过安全限制，本次涉及的任务已撤回，回收站中其他内容保持不变');
      }
    } catch (e) {
      this.logger.error('服务端删除保护调用失败', e);
    }
  }

  /** 检查任务是否是某个 ID 的后代 */
  private isDescendantOf(task: Task, ancestorId: string, _allTasks: Task[]): boolean {
    let current = task;
    const visited = new Set<string>();

    while (current.parentId && !visited.has(current.id)) {
      visited.add(current.id);
      if (current.parentId === ancestorId) return true;
      const parent = this.projectState.getTask(current.parentId);
      if (!parent) break;
      current = parent;
    }

    return false;
  }
}
