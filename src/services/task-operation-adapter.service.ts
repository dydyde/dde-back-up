/**
 * TaskOperationAdapterService - 任务操作适配器
 *
 * 桥接 TaskOperationService 与 SyncCoordinatorService，
 * 处理撤销/重做、乐观更新、Toast 反馈。
 *
 * @see TaskRecordTrackingService - 记录/追踪/撤销/重做实现
 */
import { Injectable, inject } from '@angular/core';
import { TaskOperationService } from './task-operation.service';
import { TaskRecordTrackingService } from './task-record-tracking.service';
import { SyncCoordinatorService } from './sync-coordinator.service';
import { ChangeTrackerService } from './change-tracker.service';
import { UndoService } from './undo.service';
import { UiStateService } from './ui-state.service';
import { ProjectStateService } from './project-state.service';
import { OptimisticStateService } from './optimistic-state.service';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { UserSessionService } from './user-session.service';
import { ConnectionAdapterService } from './connection-adapter.service';
import { WriteGuardService } from './write-guard.service';
import { Task, Attachment } from '../models';
import { ErrorCodes, failure, Result, OperationError } from '../utils/result';

@Injectable({
  providedIn: 'root'
})
export class TaskOperationAdapterService {
  /** 底层任务操作服务 - 直接访问纯 CRUD 方法（不触发撤销/乐观更新/Toast） */
  readonly core = inject(TaskOperationService);
  /** 连接操作适配器 */
  readonly connectionAdapter = inject(ConnectionAdapterService);
  /** 记录/追踪/撤销/重做服务 */
  readonly recorder = inject(TaskRecordTrackingService);

  private syncCoordinator = inject(SyncCoordinatorService);
  private changeTracker = inject(ChangeTrackerService);
  private undoService = inject(UndoService);
  private uiState = inject(UiStateService);
  private projectState = inject(ProjectStateService);
  private optimisticState = inject(OptimisticStateService);
  private toastService = inject(ToastService);
  private userSession = inject(UserSessionService);
  private writeGuard = inject(WriteGuardService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('TaskOpsAdapter');
  private warmupPromise: Promise<void> | null = null;

  constructor() {
    // Callbacks eliminated: TaskOperationService now uses direct DI
  }

  /**
   * 交互层预热（P1）
   * 仅触发轻量依赖访问，不阻断业务操作。
   */
  async warmup(): Promise<void> {
    if (this.warmupPromise) return this.warmupPromise;

    this.warmupPromise = Promise.resolve().then(() => {
      void this.projectState.activeProjectId();
      void this.uiState.isEditing;
      void this.syncCoordinator.hasPendingLocalChanges();
      void this.undoService.clearHistory();
    }).finally(() => {
      this.warmupPromise = null;
    });

    return this.warmupPromise;
  }
  
  // ========== 公共方法 ==========

  getLastUpdateType(): 'content' | 'structure' | 'position' {
    return this.recorder.lastUpdateType;
  }

  isHintOnlyStartupReadOnly(): boolean {
    return this.userSession.isHintOnlyStartupPlaceholderVisible?.() ?? false;
  }

  private blockHintOnlyMutation(actionLabel: string, options?: { toast?: boolean }): boolean {
    if (!this.isHintOnlyStartupReadOnly()) {
      return false;
    }

    if (options?.toast !== false) {
      this.toastService.info('会话确认中', `${actionLabel}暂不可用，owner 确认完成前保持只读`);
    }
    return true;
  }

  private blockHintOnlyMutationResult<T>(actionLabel: string): Result<T, OperationError> | null {
    if (!this.blockHintOnlyMutation(actionLabel)) {
      return null;
    }

    return failure(ErrorCodes.PERMISSION_DENIED, '会话确认中，owner 确认完成前暂时只读');
  }

  private blockExportOnlyMutation(actionLabel: string, options?: { toast?: boolean }): boolean {
    if (!this.writeGuard.isExportOnly()) {
      return false;
    }

    if (options?.toast !== false) {
      this.toastService.info(
        '导出模式',
        `${actionLabel}暂不可用，旧入口仅允许导出，请前往 https://nanoflow.pages.dev 继续编辑`
      );
    }
    return true;
  }

  private blockExportOnlyMutationResult<T>(actionLabel: string): Result<T, OperationError> | null {
    if (!this.blockExportOnlyMutation(actionLabel)) {
      return null;
    }

    return failure(ErrorCodes.PERMISSION_DENIED, '导出模式下禁止本地写入');
  }

  private blockLocalMutation(actionLabel: string, options?: { toast?: boolean }): boolean {
    return this.blockExportOnlyMutation(actionLabel, options)
      || this.blockHintOnlyMutation(actionLabel, options);
  }

  private blockLocalMutationResult<T>(actionLabel: string): Result<T, OperationError> | null {
    return this.blockExportOnlyMutationResult<T>(actionLabel)
      ?? this.blockHintOnlyMutationResult<T>(actionLabel);
  }

  markEditing(): void {
    this.uiState.markEditing();
    this.syncCoordinator.markLocalChanges(this.recorder.lastUpdateType);
  }

  get isUserEditing(): boolean {
    return this.uiState.isEditing || this.syncCoordinator.hasPendingLocalChanges();
  }

  /** 执行撤销操作 */
  performUndo(): void {
    if (this.blockLocalMutation('撤销操作')) {
      return;
    }

    this.recorder.performUndo();
  }
  /** 执行重做操作 */
  performRedo(): void {
    if (this.blockLocalMutation('重做操作')) {
      return;
    }

    this.recorder.performRedo();
  }
  
  // ========== 任务内容操作 ==========

  updateTaskContent(taskId: string, newContent: string): void {
    if (this.blockLocalMutation('编辑任务')) {
      return;
    }

    this.markEditing();
    this.recorder.lastUpdateType = 'content';
    this.core.updateTaskContent(taskId, newContent);
  }

  updateTaskTitle(taskId: string, title: string): void {
    if (this.blockLocalMutation('编辑任务')) {
      return;
    }

    this.markEditing();
    this.recorder.lastUpdateType = 'content';
    this.core.updateTaskTitle(taskId, title);
  }

  addTodoItem(taskId: string, itemText: string): void {
    if (this.blockLocalMutation('编辑任务')) {
      return;
    }

    this.markEditing();
    this.core.addTodoItem(taskId, itemText);
  }


  
  // ========== 任务位置操作 ==========

  updateTaskPosition(taskId: string, x: number, y: number): void {
    if (this.blockLocalMutation('移动任务', { toast: false })) {
      return;
    }

    this.recorder.lastUpdateType = 'position';
    this.core.updateTaskPosition(taskId, x, y);
  }

  beginPositionBatch(): void {
    if (this.blockLocalMutation('移动任务')) {
      return;
    }

    const project = this.projectState.activeProject();
    if (project) this.undoService.beginBatch(project);
  }

  endPositionBatch(): void {
    if (this.writeGuard.isExportOnly() || this.isHintOnlyStartupReadOnly()) {
      return;
    }

    const project = this.projectState.activeProject();
    if (project) {
      this.undoService.endBatch(project);
      this.syncCoordinator.markLocalChanges('position');
      this.syncCoordinator.schedulePersist();
    }
  }

  cancelPositionBatch(): void {
    this.undoService.cancelBatch();
  }

  updateTaskPositionWithUndo(taskId: string, x: number, y: number): void {
    if (this.blockLocalMutation('移动任务')) {
      return;
    }

    this.recorder.lastUpdateType = 'position';
    const task = this.projectState.getTask(taskId);
    if (!task) return;
    if (Math.abs(task.x - x) < 1 && Math.abs(task.y - y) < 1) return;

    const now = new Date().toISOString();
    this.recorder.recordAndUpdate(p => ({
      ...p,
      tasks: p.tasks.map(t =>
        t.id === taskId ? { ...t, x, y, updatedAt: now } : t
      )
    }));
  }

  updateTaskPositionWithRankSync(taskId: string, x: number, y: number, options?: { toast?: boolean }): void {
    if (this.blockLocalMutation('移动任务', options)) {
      return;
    }

    this.recorder.lastUpdateType = 'position';
    this.core.updateTaskPositionWithRankSync(taskId, x, y);
  }
  
  // ========== 任务状态操作 ==========

  updateTaskStatus(taskId: string, status: Task['status']): void {
    if (this.blockLocalMutation('更新任务状态')) {
      return;
    }

    this.markEditing();
    this.recorder.lastUpdateType = 'content';
    const project = this.projectState.activeProject();
    if (project) {
      const task = this.projectState.getTask(taskId);
      if (task) this.changeTracker.lockTaskField(taskId, project.id, 'status');
    }
    this.core.updateTaskStatus(taskId, status);
  }

  // ========== 任务扩展属性 ==========

  updateTaskAttachments(taskId: string, attachments: Attachment[]): void {
    if (this.blockLocalMutation('更新任务附件')) {
      return;
    }

    this.markEditing();
    this.recorder.lastUpdateType = 'content';
    this.core.updateTaskAttachments(taskId, attachments);
  }

  addTaskAttachment(taskId: string, attachment: Attachment): void {
    if (this.blockLocalMutation('添加任务附件')) {
      return;
    }

    this.markEditing();
    this.recorder.lastUpdateType = 'content';
    this.core.addTaskAttachment(taskId, attachment);
  }

  removeTaskAttachment(taskId: string, attachmentId: string): void {
    if (this.blockLocalMutation('移除任务附件')) {
      return;
    }

    this.markEditing();
    this.recorder.lastUpdateType = 'content';
    this.core.removeTaskAttachment(taskId, attachmentId);
  }

  updateTaskPriority(taskId: string, priority: 'low' | 'medium' | 'high' | 'urgent' | undefined): void {
    if (this.blockLocalMutation('更新任务优先级')) {
      return;
    }

    this.markEditing();
    this.recorder.lastUpdateType = 'content';
    this.core.updateTaskPriority(taskId, priority);
  }

  updateTaskDueDate(taskId: string, dueDate: string | null): void {
    if (this.blockLocalMutation('更新任务截止时间')) {
      return;
    }

    this.markEditing();
    this.recorder.lastUpdateType = 'content';
    this.core.updateTaskDueDate(taskId, dueDate);
  }

  updateTaskExpectedMinutes(taskId: string, expectedMinutes: number | null): void {
    if (this.blockLocalMutation('更新任务预估时长')) {
      return;
    }

    this.markEditing();
    this.recorder.lastUpdateType = 'content';
    this.core.updateTaskExpectedMinutes(taskId, expectedMinutes);
  }

  updateTaskCognitiveLoad(taskId: string, load: 'high' | 'low' | null): void {
    if (this.blockLocalMutation('更新任务认知负荷')) {
      return;
    }

    this.markEditing();
    this.recorder.lastUpdateType = 'content';
    this.core.updateTaskCognitiveLoad(taskId, load);
  }

  updateTaskWaitMinutes(taskId: string, waitMinutes: number | null): void {
    if (this.blockLocalMutation('更新任务等待时长')) {
      return;
    }

    this.markEditing();
    this.recorder.lastUpdateType = 'content';
    this.core.updateTaskWaitMinutes(taskId, waitMinutes);
  }

  updateTaskTags(taskId: string, tags: string[]): void {
    if (this.blockLocalMutation('更新任务标签')) {
      return;
    }

    this.markEditing();
    this.recorder.lastUpdateType = 'content';
    this.core.updateTaskTags(taskId, tags);
  }


  
  // ========== 任务 CRUD ==========

  /** 添加任务（带乐观更新） */
  addTask(
    title: string,
    content: string,
    targetStage: number | null,
    parentId: string | null,
    isSibling: boolean
  ): Result<string, OperationError> {
    const blocked = this.blockLocalMutationResult<string>('创建任务');
    if (blocked) return blocked;

    this.markEditing();
    this.recorder.lastUpdateType = 'structure';
    const snapshot = this.optimisticState.createTaskSnapshot('', '创建');
    const result = this.core.addTask({ title, content, targetStage, parentId, isSibling });

    if (result.ok) {
      this.recorder.showUndoToast(`已创建 "${title || '新任务'}"`);
      this.recorder.setupSyncResultHandler(snapshot.id);
    } else {
      this.optimisticState.rollbackSnapshot(snapshot.id);
    }
    return result;
  }

  /** 添加浮动任务（Flow 视图中双击创建） */
  addFloatingTask(title: string, content: string, x: number, y: number): void {
    if (this.blockLocalMutation('创建任务')) {
      return;
    }

    this.markEditing();
    this.recorder.lastUpdateType = 'structure';
    const snapshot = this.optimisticState.createTaskSnapshot('', '创建');
    this.core.addFloatingTask(title, content, x, y);
    this.recorder.showUndoToast(`已创建 "${title || '新任务'}"`);
    this.recorder.setupSyncResultHandler(snapshot.id);
  }

  /** 删除任务（带乐观更新） */
  deleteTask(taskId: string): void {
    if (this.blockLocalMutation('删除任务')) {
      return;
    }

    this.markEditing();
    this.recorder.lastUpdateType = 'structure';
    const task = this.projectState.getTask(taskId);
    const taskTitle = task?.title || '任务';
    const snapshot = this.optimisticState.createTaskSnapshot(taskId, '删除');
    this.core.deleteTask(taskId);
    this.recorder.showUndoToast(`已删除 "${taskTitle}"`);
    this.recorder.setupSyncResultHandler(snapshot.id);
  }

  /** 永久删除任务（从回收站中删除） */
  permanentlyDeleteTask(taskId: string): void {
    if (this.blockLocalMutation('删除任务')) {
      return;
    }

    this.markEditing();
    this.recorder.lastUpdateType = 'structure';
    const snapshot = this.optimisticState.createTaskSnapshot(taskId, '删除');
    this.core.permanentlyDeleteTask(taskId);
    this.recorder.setupSyncResultHandler(snapshot.id);
  }

  /** 批量删除任务（原子操作，P0 熔断层） */
  deleteTasksBatch(explicitIds: string[]): number {
    if (explicitIds.length === 0) return 0;
    const projectId = this.projectState.activeProjectId();
    if (!projectId) return 0;
    if (this.blockLocalMutation('删除任务')) {
      return 0;
    }

    this.markEditing();
    this.recorder.lastUpdateType = 'structure';
    const snapshot = this.optimisticState.createTaskSnapshot(explicitIds[0], '删除');
    const deletedCount = this.core.deleteTasksBatch(explicitIds);

    // 后台异步调用服务端保护
    this.recorder.triggerServerSideDelete(projectId, explicitIds, snapshot.id);
    this.recorder.showUndoToast(`已删除 ${deletedCount} 个任务`);
    this.recorder.setupSyncResultHandler(snapshot.id);
    return deletedCount;
  }

  calculateBatchDeleteImpact(explicitIds: string[]): { total: number; explicit: number; cascaded: number } {
    return this.core.calculateBatchDeleteImpact(explicitIds);
  }

  /** 恢复已删除的任务 */
  restoreTask(taskId: string): void {
    if (this.blockLocalMutation('恢复任务')) {
      return;
    }

    this.markEditing();
    this.recorder.lastUpdateType = 'structure';
    this.core.restoreTask(taskId);
  }

  /** 清空回收站 */
  emptyTrash(): void {
    if (this.blockLocalMutation('清空回收站')) {
      return;
    }

    this.markEditing();
    this.recorder.lastUpdateType = 'structure';
    const snapshot = this.optimisticState.createTaskSnapshot('', '删除');
    this.core.emptyTrash();
    this.recorder.setupSyncResultHandler(snapshot.id);
  }
  
  // ========== 任务结构操作 ==========

  /** 移动任务到指定阶段 */
  moveTaskToStage(
    taskId: string,
    newStage: number | null,
    beforeTaskId?: string | null,
    newParentId?: string | null
  ): Result<void, OperationError> {
    const blocked = this.blockLocalMutationResult<void>('移动任务');
    if (blocked) return blocked;

    this.markEditing();
    this.recorder.lastUpdateType = 'structure';

    const projectIdBefore = this.projectState.activeProjectId();
    const taskBefore = this.projectState.getTask(taskId);
    const stageBefore = taskBefore?.stage ?? null;
    const parentIdBefore = taskBefore?.parentId ?? null;
    const snapshot = this.optimisticState.createTaskSnapshot(taskId, '移动');
    const result = this.core.moveTaskToStage({ taskId, newStage, beforeTaskId, newParentId });

    if (result.ok) {
      const projectIdAfter = this.projectState.activeProjectId();
      if (projectIdAfter !== projectIdBefore) {
        this.logger.warn('项目在操作期间被切换', { projectIdBefore, projectIdAfter, taskId });
        this.optimisticState.discardSnapshot(snapshot.id);
        return result;
      }

      const taskAfter = this.projectState.getTask(taskId);
      const stageAfter = taskAfter?.stage ?? null;
      const parentIdAfter = taskAfter?.parentId ?? null;
      const actuallyMoved = stageAfter !== stageBefore || parentIdAfter !== parentIdBefore;

      if (actuallyMoved) {
        const stageName = newStage === null ? '待分配区' : `阶段 ${newStage}`;
        this.recorder.showUndoToast(`已移动到${stageName}`);
        this.recorder.setupSyncResultHandler(snapshot.id);
      } else {
        this.optimisticState.discardSnapshot(snapshot.id);
      }
    } else {
      this.optimisticState.rollbackSnapshot(snapshot.id);
    }
    return result;
  }

  /** 将任务插入到两个任务之间 */
  insertTaskBetween(taskId: string, sourceId: string, targetId: string): Result<void, OperationError> {
    const blocked = this.blockLocalMutationResult<void>('移动任务');
    if (blocked) return blocked;

    this.markEditing();
    this.recorder.lastUpdateType = 'structure';
    const snapshot = this.optimisticState.createTaskSnapshot(taskId, '移动');
    const result = this.core.insertTaskBetween({ taskId, sourceId, targetId });

    if (result.ok) {
      this.recorder.setupSyncResultHandler(snapshot.id);
    } else {
      this.optimisticState.rollbackSnapshot(snapshot.id);
    }
    return result;
  }

  /** 将整个子任务树迁移到新的父任务下 */
  moveSubtreeToNewParent(taskId: string, newParentId: string | null): Result<void, OperationError> {
    const blocked = this.blockLocalMutationResult<void>('移动子树');
    if (blocked) return blocked;

    this.markEditing();
    this.recorder.lastUpdateType = 'structure';
    const snapshot = this.optimisticState.createTaskSnapshot(taskId, '移动');
    const result = this.core.moveSubtreeToNewParent(taskId, newParentId);

    if (result.ok) {
      this.recorder.showUndoToast('已移动子树');
      this.recorder.setupSyncResultHandler(snapshot.id);
    } else {
      this.optimisticState.rollbackSnapshot(snapshot.id);
    }
    return result;
  }

  /** 重排阶段内任务顺序 */
  reorderStage(stage: number, orderedIds: string[]): void {
    if (this.blockLocalMutation('重排任务')) {
      return;
    }

    this.markEditing();
    this.recorder.lastUpdateType = 'structure';
    this.core.reorderStage(stage, orderedIds);
  }

  /** 分离任务（移回待分配区） */
  detachTask(taskId: string): void {
    if (this.blockLocalMutation('移动任务')) {
      return;
    }

    this.markEditing();
    this.recorder.lastUpdateType = 'structure';
    this.core.detachTask(taskId);
  }

  /** 分离任务及其整个子树（移回待分配区） */
  detachTaskWithSubtree(taskId: string) {
    const blocked = this.blockLocalMutationResult<void>('移动子树');
    if (blocked) return blocked;

    this.markEditing();
    this.recorder.lastUpdateType = 'structure';
    const result = this.core.detachTaskWithSubtree(taskId);
    this.recorder.showUndoToast('已移动到待分配区');
    return result;
  }

  // ========== 子树替换操作（流程图逻辑链条功能） ==========

  /** 将任务块的子树替换为待分配块子树 */
  replaceChildSubtreeWithUnassigned(
    sourceTaskId: string,
    targetUnassignedId: string,
    specificChildId?: string
  ): Result<{ detachedSubtreeRootId: string | null }, OperationError> {
    const blocked = this.blockLocalMutationResult<{ detachedSubtreeRootId: string | null }>('重新挂载任务');
    if (blocked) return blocked;

    this.markEditing();
    this.recorder.lastUpdateType = 'structure';
    const snapshot = this.optimisticState.createTaskSnapshot(sourceTaskId, '移动');
    const result = this.core.replaceChildSubtreeWithUnassigned(sourceTaskId, targetUnassignedId, specificChildId);

    if (result.ok) {
      const detachedInfo = result.value.detachedSubtreeRootId ? '，原子任务已移到待分配区' : '';
      this.recorder.showUndoToast(`已分配待分配块${detachedInfo}`);
      this.recorder.setupSyncResultHandler(snapshot.id);
    } else {
      this.optimisticState.rollbackSnapshot(snapshot.id);
    }
    return result;
  }

  /** 将待分配块分配为任务块的子节点 */
  assignUnassignedToTask(
    sourceTaskId: string,
    targetUnassignedId: string
  ): Result<void, OperationError> {
    const blocked = this.blockLocalMutationResult<void>('重新挂载任务');
    if (blocked) return blocked;

    this.markEditing();
    this.recorder.lastUpdateType = 'structure';
    const snapshot = this.optimisticState.createTaskSnapshot(sourceTaskId, '移动');
    const result = this.core.assignUnassignedToTask(sourceTaskId, targetUnassignedId);

    if (result.ok) {
      this.recorder.showUndoToast('已分配待分配块');
      this.recorder.setupSyncResultHandler(snapshot.id);
    } else {
      this.optimisticState.rollbackSnapshot(snapshot.id);
    }
    return result;
  }

  /** 检查待分配块是否有父待分配块 */
  getUnassignedParent(taskId: string): string | null {
    return this.core.getUnassignedParent(taskId);
  }

  /** 获取任务的直接子任务 */
  getDirectChildren(taskId: string): Task[] {
    return this.core.getDirectChildren(taskId);
  }

  /** 删除任务但保留子任务 */
  deleteTaskKeepChildren(taskId: string): void {
    if (this.blockLocalMutation('删除任务')) {
      return;
    }

    this.markEditing();
    this.recorder.lastUpdateType = 'structure';
    const task = this.projectState.getTask(taskId);
    const taskTitle = task?.title || '任务';
    const snapshot = this.optimisticState.createTaskSnapshot(taskId, '删除');
    this.core.deleteTaskKeepChildren(taskId);
    this.recorder.showUndoToast(`已删除 "${taskTitle}"（保留子任务）`);
    this.recorder.setupSyncResultHandler(snapshot.id);
  }

  /** 修复阶段 1 缺失导致的阶段链漂移。 */
  repairMissingStageOne(): boolean {
    if (this.blockLocalMutation('恢复阶段')) {
      return false;
    }

    this.markEditing();
    this.recorder.lastUpdateType = 'structure';
    const snapshot = this.optimisticState.createTaskSnapshot('', '移动');
    const repaired = this.core.repairMissingStageOne();

    if (repaired) {
      this.recorder.showUndoToast('已补回阶段 1');
      this.recorder.setupSyncResultHandler(snapshot.id);
    } else {
      this.optimisticState.discardSnapshot(snapshot.id);
    }

    return repaired;
  }

  // ========== 查询方法 ==========

  isStageRebalancing(stage: number): boolean {
    return this.core.isStageRebalancing(stage);
  }

  cleanupOldTrashItems(): number {
    return this.core.cleanupOldTrashItems();
  }
}
