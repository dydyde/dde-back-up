import { Injectable, inject, DestroyRef } from '@angular/core';
import { Task, Project, Attachment } from '../models';
import { LayoutService } from './layout.service';
import { LoggerService } from './logger.service';
import { TaskTrashService } from './task-trash.service';
import { SubtreeOperationsService } from './subtree-operations.service';
import { TaskCreationService, CreateTaskParams } from './task-creation.service';
import { TaskMoveService, MoveTaskParams } from './task-move.service';
import { TaskAttributeService } from './task-attribute.service';
import { TaskConnectionService } from './task-connection.service';
import { ProjectStateService } from './project-state.service';
import { TaskRecordTrackingService } from './task-record-tracking.service';
import { LAYOUT_CONFIG } from '../config';
import {
  Result, OperationError, ErrorCodes, success, failure
} from '../utils/result';



/**
 * 任务插入参数
 */
export interface InsertBetweenParams {
  taskId: string;
  sourceId: string;
  targetId: string;
}

/**
 * 任务操作服务
 * 从 StoreService 拆分出来，专注于任务的 CRUD 操作
 * 
 * 【职责边界】
 * ✓ 任务创建、更新、删除
 * ✓ 任务移动、排序
 * ✓ 任务属性更新（标题、内容、优先级、标签等）
 * ✓ 回收站管理（软删除、恢复、永久删除）
 * ✓ 父子关系管理
 * ✓ Rank 计算和重平衡
 * ✗ 数据持久化 → SyncCoordinatorService
 * ✗ 撤销/重做 → UndoService（通过回调通知）
 */
@Injectable({
  providedIn: 'root'
})
export class TaskOperationService {
  private layoutService = inject(LayoutService);
  private destroyRef = inject(DestroyRef);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('TaskOperation');
  private readonly trashService = inject(TaskTrashService);
  private readonly subtreeOps = inject(SubtreeOperationsService);
  private readonly taskCreation = inject(TaskCreationService);
  private readonly taskMove = inject(TaskMoveService);
  private readonly taskAttr = inject(TaskAttributeService);
  private readonly taskConn = inject(TaskConnectionService);
  
  private projectState = inject(ProjectStateService);
  private recorder = inject(TaskRecordTrackingService);
  
  /** 需要重平衡的阶段 */
  private stagesNeedingRebalance = new Set<number>();
  
  /** 重平衡定时器 */
  private rebalanceTimer: ReturnType<typeof setTimeout> | null = null;
  
  constructor() {
    // 注册清理逻辑，防止定时器内存泄漏
    this.destroyRef.onDestroy(() => {
      if (this.rebalanceTimer) {
        clearTimeout(this.rebalanceTimer);
        this.rebalanceTimer = null;
      }
    });
  }
  

  
  // ========== 查询方法 ==========
  
  /**
   * 检查指定阶段是否正在重平衡
   */
  isStageRebalancing(stage: number): boolean {
    return this.layoutService.isStageRebalancing(stage);
  }
  
  /**
   * 获取任务的关联连接
   */
  getTaskConnections(project: Project | null, taskId: string): { 
    outgoing: { targetId: string; targetTask: Task | undefined; description?: string }[];
    incoming: { sourceId: string; sourceTask: Task | undefined; description?: string }[];
  } {
    if (!project) return { outgoing: [], incoming: [] };
    
    const tasks = project.tasks;
    const connections = project.connections;
    const taskMap = new Map(tasks.map(t => [t.id, t] as const));

    // 排除父子关系的连接
    const parentChildPairs = new Set<string>();
    tasks.filter(t => t.parentId).forEach(t => {
      parentChildPairs.add(`${t.parentId}->${t.id}`);
    });

    const outgoing = connections
      .filter(c => c.source === taskId && !parentChildPairs.has(`${c.source}->${c.target}`))
      .map(c => ({
        targetId: c.target,
        targetTask: taskMap.get(c.target),
        description: c.description
      }));

    const incoming = connections
      .filter(c => c.target === taskId && !parentChildPairs.has(`${c.source}->${c.target}`))
      .map(c => ({
        sourceId: c.source,
        sourceTask: taskMap.get(c.source),
        description: c.description
      }));
    
    return { outgoing, incoming };
  }
  
  // ========== 任务创建（委托给 TaskCreationService）==========
  
  /**
   * 添加新任务
   * @see TaskCreationService.addTask
   */
  addTask(params: CreateTaskParams): Result<string, OperationError> {
    return this.taskCreation.addTask(params);
  }
  
  /**
   * 添加浮动任务（未分配阶段的任务）
   * @see TaskCreationService.addFloatingTask
   */
  addFloatingTask(title: string, content: string, x: number, y: number): void {
    this.taskCreation.addFloatingTask(title, content, x, y);
  }
  
  // ========== 任务内容更新 ==========
  
  // ========== 任务属性更新（委托给 TaskAttributeService）==========
  
  /**
   * 更新任务内容
   * @see TaskAttributeService.updateTaskContent
   */
  updateTaskContent(taskId: string, newContent: string): void {
    this.taskAttr.updateTaskContent(taskId, newContent);
  }
  
  /**
   * 更新任务标题
   * @see TaskAttributeService.updateTaskTitle
   */
  updateTaskTitle(taskId: string, title: string): void {
    this.taskAttr.updateTaskTitle(taskId, title);
  }
  
  /**
   * 更新任务位置
   * @see TaskAttributeService.updateTaskPosition
   */
  updateTaskPosition(taskId: string, x: number, y: number): void {
    this.taskAttr.updateTaskPosition(taskId, x, y);
  }
  
  /**
   * 更新任务位置并同步 Rank
   */
  updateTaskPositionWithRankSync(taskId: string, x: number, y: number): void {
    const project = this.getActiveProject();
    if (!project) return;
    
    const task = this.projectState.getTask(taskId);
    if (!task || task.stage === null) {
      this.updateTaskPosition(taskId, x, y);
      return;
    }
    
    // 获取同一阶段的所有任务（排除自身）
    const stageTasks = project.tasks
      .filter(t => t.stage === task.stage && t.id !== taskId && !t.deletedAt)
      .sort((a, b) => (a.y ?? 0) - (b.y ?? 0));
    
    // 根据新的 Y 坐标计算新的 rank
    let newRank: number;
    const RANK_STEP = LAYOUT_CONFIG.RANK_STEP;
    
    if (stageTasks.length === 0) {
      newRank = task.rank;
    } else {
      const insertIndex = stageTasks.findIndex(t => (t.y ?? 0) > y);
      
      if (insertIndex === -1) {
        const lastTask = stageTasks[stageTasks.length - 1];
        newRank = lastTask.rank + RANK_STEP;
      } else if (insertIndex === 0) {
        const firstTask = stageTasks[0];
        newRank = firstTask.rank - RANK_STEP;
      } else {
        const prevTask = stageTasks[insertIndex - 1];
        const nextTask = stageTasks[insertIndex];
        newRank = (prevTask.rank + nextTask.rank) / 2;
        
        if (Math.abs(prevTask.rank - newRank) < 50) {
          this.recordAndUpdate(p => this.layoutService.rebalance({
            ...p,
            tasks: p.tasks.map(t => t.id === taskId ? { ...t, x, y, rank: newRank } : t)
          }));
          return;
        }
      }
    }
    
    this.updateActiveProjectRaw(p => ({
      ...p,
      tasks: p.tasks.map(t => t.id === taskId ? { ...t, x, y, rank: newRank } : t)
    }));
  }
  
  /**
   * 更新任务状态
   * @see TaskAttributeService.updateTaskStatus
   */
  updateTaskStatus(taskId: string, status: Task['status']): void {
    this.taskAttr.updateTaskStatus(taskId, status);
  }
  
  // ========== 任务扩展属性（委托给 TaskAttributeService）==========
  
  /**
   * 更新任务附件
   * @see TaskAttributeService.updateTaskAttachments
   */
  updateTaskAttachments(taskId: string, attachments: Attachment[]): void {
    this.taskAttr.updateTaskAttachments(taskId, attachments);
  }
  
  /**
   * 添加单个附件
   * @see TaskAttributeService.addTaskAttachment
   */
  addTaskAttachment(taskId: string, attachment: Attachment): void {
    this.taskAttr.addTaskAttachment(taskId, attachment);
  }
  
  /**
   * 移除单个附件
   * @see TaskAttributeService.removeTaskAttachment
   */
  removeTaskAttachment(taskId: string, attachmentId: string): void {
    this.taskAttr.removeTaskAttachment(taskId, attachmentId);
  }
  
  /**
   * 更新任务优先级
   * @see TaskAttributeService.updateTaskPriority
   */
  updateTaskPriority(taskId: string, priority: 'low' | 'medium' | 'high' | 'urgent' | undefined): void {
    this.taskAttr.updateTaskPriority(taskId, priority);
  }
  
  /**
   * 更新任务截止日期
   * @see TaskAttributeService.updateTaskDueDate
   */
  updateTaskDueDate(taskId: string, dueDate: string | null): void {
    this.taskAttr.updateTaskDueDate(taskId, dueDate);
  }

  /**
   * 更新任务预计时长（分钟）
   * @see TaskAttributeService.updateTaskExpectedMinutes
   */
  updateTaskExpectedMinutes(taskId: string, expectedMinutes: number | null): void {
    this.taskAttr.updateTaskExpectedMinutes(taskId, expectedMinutes);
  }

  /**
   * 更新任务认知负荷
   * @see TaskAttributeService.updateTaskCognitiveLoad
   */
  updateTaskCognitiveLoad(taskId: string, load: 'high' | 'low' | null): void {
    this.taskAttr.updateTaskCognitiveLoad(taskId, load);
  }

  /**
   * 更新任务等待时长（分钟）
   * @see TaskAttributeService.updateTaskWaitMinutes
   */
  updateTaskWaitMinutes(taskId: string, waitMinutes: number | null): void {
    this.taskAttr.updateTaskWaitMinutes(taskId, waitMinutes);
  }
  
  /**
   * 更新任务标签
   * @see TaskAttributeService.updateTaskTags
   */
  updateTaskTags(taskId: string, tags: string[]): void {
    this.taskAttr.updateTaskTags(taskId, tags);
  }
  
  /**
   * 添加单个标签
   * @see TaskAttributeService.addTaskTag
   */
  addTaskTag(taskId: string, tag: string): void {
    this.taskAttr.addTaskTag(taskId, tag);
  }
  
  /**
   * 移除单个标签
   * @see TaskAttributeService.removeTaskTag
   */
  removeTaskTag(taskId: string, tag: string): void {
    this.taskAttr.removeTaskTag(taskId, tag);
  }
  
  // ========== 待办项操作（委托给 TaskAttributeService）==========
  
  /**
   * 添加待办项
   * @see TaskAttributeService.addTodoItem
   */
  addTodoItem(taskId: string, itemText: string): void {
    this.taskAttr.addTodoItem(taskId, itemText);
  }
  
  /**
   * 完成待办项
   * @see TaskAttributeService.completeUnfinishedItem
   */
  completeUnfinishedItem(taskId: string, todoIndex: number): void {
    this.taskAttr.completeUnfinishedItem(taskId, todoIndex);
  }
  
  // ========== 任务删除与恢复（委托给 TaskTrashService） ==========
  
  /**
   * 软删除任务（移动到回收站）
   * @see TaskTrashService.deleteTask
   */
  deleteTask(taskId: string): void {
    this.trashService.deleteTask(taskId);
  }
  
  /**
   * 批量软删除任务（原子操作）
   * 
   * 【核心算法】
   * 1. 级联收集：从显式选中的 ID 出发，收集所有后代任务 ID
   * 2. 去重：使用 Set 防止"选中父节点 + 选中子节点"导致的重复处理
   * 3. 一次性更新：合并为单个 Store 更新，避免同步风暴
   * 
   * @param explicitIds 用户显式选中的任务 ID 列表
   * @returns 实际删除的任务数量（含级联子任务）
   * @see TaskTrashService.deleteTasksBatch
   */
  deleteTasksBatch(explicitIds: string[]): number {
    const result = this.trashService.deleteTasksBatch(explicitIds);
    return result.deletedTaskIds.size;
  }
  
  /**
   * 计算批量删除将影响的任务数量（含级联子任务）
   * @see TaskTrashService.calculateBatchDeleteImpact
   */
  calculateBatchDeleteImpact(explicitIds: string[]): { total: number; explicit: number; cascaded: number } {
    return this.trashService.calculateBatchDeleteImpact(explicitIds);
  }
  
  /**
   * 永久删除任务
   * @see TaskTrashService.permanentlyDeleteTask
   */
  permanentlyDeleteTask(taskId: string): void {
    this.trashService.permanentlyDeleteTask(taskId);
  }
  
  /**
   * 从回收站恢复任务
   * @see TaskTrashService.restoreTask
   */
  restoreTask(taskId: string): void {
    this.trashService.restoreTask(taskId);
  }
  
  /**
   * 清空回收站
   * @see TaskTrashService.emptyTrash
   */
  emptyTrash(): void {
    this.trashService.emptyTrash();
  }
  
  /**
   * 清理超过保留期限的回收站项目
   * @see TaskTrashService.cleanupOldTrashItems
   */
  cleanupOldTrashItems(): number {
    return this.trashService.cleanupOldTrashItems();
  }

  /** 阶段 1 缺失时触发布局补偿，将最早的可见阶段恢复为根层。 */
  repairMissingStageOne(): boolean {
    const activeP = this.getActiveProject();
    if (!activeP) return false;

    const visibleAssignedTasks = activeP.tasks.filter(task =>
      task.stage !== null && !task.deletedAt && task.status !== 'archived'
    );
    if (visibleAssignedTasks.length === 0 || visibleAssignedTasks.some(task => task.stage === 1)) {
      return false;
    }

    this.recordAndUpdate(project => this.layoutService.rebalance(project));
    return true;
  }
  
  // ========== 任务移动（委托给 TaskMoveService）==========
  
  /**
   * 移动任务到指定阶段
   * @see TaskMoveService.moveTaskToStage
   */
  moveTaskToStage(params: MoveTaskParams): Result<void, OperationError> {
    return this.taskMove.moveTaskToStage(params);
  }
  
  /**
   * 将任务插入到两个已有节点之间
   */
  insertTaskBetween(params: InsertBetweenParams): Result<void, OperationError> {
    const { taskId, sourceId, targetId } = params;
    
    const activeP = this.getActiveProject();
    if (!activeP) {
      return failure(ErrorCodes.DATA_NOT_FOUND, '没有活动项目');
    }

    const sourceTask = this.projectState.getTask(sourceId);
    const targetTask = this.projectState.getTask(targetId);
    const insertTask = this.projectState.getTask(taskId);

    if (!sourceTask || !targetTask || !insertTask) {
      return failure(ErrorCodes.DATA_NOT_FOUND, '找不到相关任务');
    }

    if (targetTask.parentId !== sourceId) {
      return failure(ErrorCodes.VALIDATION_ERROR, '目标任务不是源任务的直接子节点');
    }

    if (this.subtreeOps.wouldCreateCycle(taskId, sourceId, targetId, activeP.tasks)) {
      return failure(ErrorCodes.LAYOUT_CYCLE_DETECTED, '操作会产生循环依赖');
    }
    
    this.recordAndUpdate(p => {
      const tasks = p.tasks.map(t => ({ ...t }));
      const taskMap = new Map(tasks.map(t => [t.id, t] as const));

      const source = taskMap.get(sourceId)!;
      const target = taskMap.get(targetId)!;
      const newTask = taskMap.get(taskId)!;

      const targetSubtreeIds = this.subtreeOps.collectSubtreeIds(targetId, tasks);

      const newTaskStage = (source.stage || 1) + 1;
      newTask.parentId = sourceId;
      newTask.stage = newTaskStage;

      target.parentId = taskId;

      targetSubtreeIds.forEach(id => {
        const t = taskMap.get(id);
        if (t && t.stage !== null) {
          t.stage = t.stage + 1;
        }
      });
      
      const targetOriginalRank = target.rank;
      newTask.rank = targetOriginalRank;
      target.rank = newTask.rank + LAYOUT_CONFIG.RANK_STEP / 2;
      
      return this.layoutService.rebalance({ ...p, tasks });
    });
    
    return success(undefined);
  }
  
  /**
   * 重新排序阶段内的任务
   */
  reorderStage(stage: number, orderedIds: string[]): void {
    this.recordAndUpdate(p => {
      const tasks = p.tasks.map(t => ({ ...t }));
      let cursorRank = tasks.filter(t => t.stage === stage).sort((a, b) => a.rank - b.rank)[0]?.rank 
        ?? this.layoutService.stageBase(stage);
      
      orderedIds.forEach(id => {
        const task = tasks.find(t => t.id === id && t.stage === stage);
        if (!task) return;
        
        const parentRank = this.layoutService.maxParentRank(task, tasks);
        const minChildRank = this.layoutService.minChildRank(task.id, tasks);
        const candidate = cursorRank;
        const placed = this.applyRefusalStrategy(task, candidate, parentRank, minChildRank, tasks);
        if (!placed.ok) return;
        task.rank = placed.rank;
        cursorRank = placed.rank + LAYOUT_CONFIG.RANK_STEP;
      });
      
      return this.layoutService.rebalance({ ...p, tasks });
    });
  }
  
  /**
   * 分离任务（从树中移除但保留子节点）
   * @see TaskMoveService.detachTask
   */
  detachTask(taskId: string): void {
    this.taskMove.detachTask(taskId);
  }
  
  /**
   * 分离任务及其整个子树（移回待分配区）
   * @see TaskMoveService.moveTaskToStage (with newStage = null)
   */
  detachTaskWithSubtree(taskId: string): Result<void, OperationError> {
    return this.taskMove.moveTaskToStage({ taskId, newStage: null });
  }
  
  /**
   * 删除任务但保留子节点
   * @see TaskMoveService.deleteTaskKeepChildren
   */
  deleteTaskKeepChildren(taskId: string): void {
    this.taskMove.deleteTaskKeepChildren(taskId);
  }
  
  // ========== 子树迁移操作 ==========

  /**
   * 将整个子任务树迁移到新的父任务下
   * @see TaskMoveService.moveSubtreeToNewParent
   */
  moveSubtreeToNewParent(taskId: string, newParentId: string | null): Result<void, OperationError> {
    return this.taskMove.moveSubtreeToNewParent(taskId, newParentId);
  }


  // ========== 连接操作（委托给 TaskConnectionService）==========

  /**
   * 添加跨树连接
   * @see TaskConnectionService.addCrossTreeConnection
   */
  addCrossTreeConnection(sourceId: string, targetId: string): void {
    this.taskConn.addCrossTreeConnection(sourceId, targetId);
  }
  
  /**
   * 重连跨树连接（原子操作）
   * @see TaskConnectionService.relinkCrossTreeConnection
   */
  relinkCrossTreeConnection(
    oldSourceId: string,
    oldTargetId: string,
    newSourceId: string,
    newTargetId: string
  ): void {
    this.taskConn.relinkCrossTreeConnection(oldSourceId, oldTargetId, newSourceId, newTargetId);
  }
  
  /**
   * 移除连接（使用软删除策略）
   * @see TaskConnectionService.removeConnection
   */
  removeConnection(sourceId: string, targetId: string): void {
    this.taskConn.removeConnection(sourceId, targetId);
  }
  
  /**
   * 更新连接内容（标题和描述）
   * @see TaskConnectionService.updateConnectionContent
   */
  updateConnectionContent(sourceId: string, targetId: string, title: string, description: string): void {
    this.taskConn.updateConnectionContent(sourceId, targetId, title, description);
  }
  
  // ========== 私有辅助方法 ==========
  
  private getActiveProject(): Project | null {
    return this.projectState.activeProject();
  }
  
  private recordAndUpdate(mutator: (project: Project) => Project): void {
    this.recorder.recordAndUpdate(mutator);
  }
  
  private recordAndUpdateDebounced(mutator: (project: Project) => Project): void {
    this.recorder.recordAndUpdateDebounced(mutator);
  }
  
  /**
   * 【P2-40 修复】更正注释：此方法实际上会记录撤销历史
   * 与 recordAndUpdateDebounced 的区别在于无防抖（立即执行）
   */
  private updateActiveProjectRaw(mutator: (project: Project) => Project): void {
    this.recorder.recordAndUpdate(mutator);
  }
  
  /**
   * 计算插入位置的 rank 值
   */
  private computeInsertRank(stage: number, siblings: Task[], beforeId?: string | null, parentRank?: number | null): number {
    const result = this.layoutService.computeInsertRank(stage, siblings, beforeId, parentRank);
    if (result.needsRebalance) {
      this.markStageForRebalance(stage);
    }
    return result.rank;
  }
  
  /**
   * 标记某阶段需要重平衡
   */
  private markStageForRebalance(stage: number): void {
    this.stagesNeedingRebalance.add(stage);
    if (this.rebalanceTimer) {
      clearTimeout(this.rebalanceTimer);
    }
    this.rebalanceTimer = setTimeout(() => {
      this.performStageRebalance();
      this.rebalanceTimer = null;
    }, 100);
  }
  
  /**
   * 执行阶段内的 rank 重平衡
   */
  private performStageRebalance(): void {
    const activeP = this.getActiveProject();
    if (!activeP || this.stagesNeedingRebalance.size === 0) return;
    
    const stages = Array.from(this.stagesNeedingRebalance);
    this.stagesNeedingRebalance.clear();
    
    stages.forEach(s => this.layoutService.markStageRebalancing(s));
    
    try {
      const rebalancedTasks = this.layoutService.rebalanceStageRanks(activeP.tasks, stages);
      
      if (rebalancedTasks !== activeP.tasks) {
        this.recordAndUpdate(p => this.layoutService.rebalance({ ...p, tasks: rebalancedTasks }));
      }
    } finally {
      stages.forEach(s => this.layoutService.clearStageRebalancing(s));
    }
  }
  
  /**
   * 应用拒绝策略
   */
  private applyRefusalStrategy(
    target: Task, 
    candidateRank: number, 
    parentRank: number | null, 
    minChildRank: number,
    _allTasks: Task[]
  ): { ok: boolean; rank: number } {
    return this.layoutService.applyRefusalStrategy(target, candidateRank, parentRank, minChildRank);
  }
  

  // ========== 子树替换操作（流程图逻辑链条功能） ==========

  /**
   * 将任务块的特定子任务替换为待分配块子树
   * @see TaskMoveService.replaceChildSubtreeWithUnassigned
   */
  replaceChildSubtreeWithUnassigned(
    sourceTaskId: string,
    targetUnassignedId: string,
    specificChildId?: string
  ): Result<{ detachedSubtreeRootId: string | null }, OperationError> {
    return this.taskMove.replaceChildSubtreeWithUnassigned(sourceTaskId, targetUnassignedId, specificChildId);
  }

  /**
   * 将待分配块分配为任务块的子节点
   * @see TaskMoveService.assignUnassignedToTask
   */
  assignUnassignedToTask(
    sourceTaskId: string,
    targetUnassignedId: string
  ): Result<void, OperationError> {
    return this.taskMove.assignUnassignedToTask(sourceTaskId, targetUnassignedId);
  }

  /**
   * 检查待分配块是否有父待分配块
   * @see TaskMoveService.getUnassignedParent
   */
  getUnassignedParent(taskId: string): string | null {
    return this.taskMove.getUnassignedParent(taskId);
  }

  /**
   * 获取任务的直接子任务
   * @see TaskMoveService.getDirectChildren
   */
  getDirectChildren(taskId: string): Task[] {
    return this.taskMove.getDirectChildren(taskId);
  }
}
