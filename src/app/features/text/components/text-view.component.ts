import { Component, inject, signal, computed, Output, EventEmitter, OnInit, OnDestroy, ElementRef, ViewChild, NgZone, ChangeDetectionStrategy, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { LoggerService } from '../../../../services/logger.service';
import { UiStateService } from '../../../../services/ui-state.service';
import { ProjectStateService } from '../../../../services/project-state.service';
import { UserSessionService } from '../../../../services/user-session.service';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
import { SyncCoordinatorService } from '../../../../services/sync-coordinator.service';
import { Task } from '../../../../models';
import { getErrorMessage, isFailure } from '../../../../utils/result';
import { readTaskDragPayload, writeTaskDragPayload } from '../../../../utils/task-drag-payload';
import type { TaskTouchStartPayload } from './text-view.types';

// 子组件导入
import { TextViewLoadingComponent } from './text-view-loading.component';
import { TextUnfinishedComponent } from './text-unfinished.component';
import { TextUnassignedComponent } from './text-unassigned.component';
import { TextStagesComponent } from './text-stages.component';
import { TextDeleteDialogComponent } from './text-delete-dialog.component';
import { TextViewDragDropService } from '../services/text-view-drag-drop.service';
import { TextViewTaskOpsService } from '../services/text-view-task-ops.service';

/**
 * 文本视图容器组件
 * 作为纯粹的协调组件，管理子组件间的通信和状态
 */
@Component({
  selector: 'app-text-view',
  standalone: true,
  imports: [
    CommonModule,
    TextViewLoadingComponent,
    TextUnfinishedComponent,
    TextUnassignedComponent,
    TextStagesComponent,
    TextDeleteDialogComponent,
  ],
  providers: [TextViewTaskOpsService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div #scrollContainer class="flex flex-col h-full min-h-0 min-w-0 theme-bg overflow-y-auto overflow-x-hidden text-view-scroll-container"
         (click)="ops.onContainerClick($event)"
         (touchend)="onGlobalTouchEnd($event)"
         (touchcancel)="onGlobalTouchCancel($event)">
      
      <!-- 只在首次加载（无本地数据）时显示骨架屏，增量同步时保留现有内容 -->
      @if (showLoadingSkeleton()) {
        <app-text-view-loading [isMobile]="isMobile()" />
      } @else {
        
        <!-- 待办事项区 -->
        <app-text-unfinished
          [isMobile]="isMobile()"
          (jumpToTask)="ops.onJumpToTask($event)"
        />
        
        <!-- 待分配区 -->
        <app-text-unassigned
          #unassignedRef
          [isMobile]="isMobile()"
          [draggingTaskId]="dragDropService.draggingTaskId()"
          (taskClick)="ops.onUnassignedTaskClick($event)"
          (openLinkedTask)="ops.onOpenLinkedTask($event)"
          (createUnassigned)="ops.onCreateUnassigned()"
          (dragStart)="onDragStart($event)"
          (dragEnd)="onDragEnd()"
          (touchStart)="onTouchStart($event)"
          (touchMove)="onTouchMove($event)"
          (touchEnd)="onTouchEnd($event)"
          (touchCancel)="onTouchCancel($event)"
        />
        
        <!-- 阶段区 -->
        <app-text-stages
          #stagesRef
          [isMobile]="isMobile()"
          [selectedTaskId]="selectedTaskId()"
          [draggingTaskId]="dragDropService.draggingTaskId()"
          [dragOverStage]="dragDropService.dragOverStage()"
          [dropTargetInfo]="dragDropService.dropTargetInfo()"
          [userId]="userSession.currentUserId()"
          [projectId]="projectState.activeProjectId()"
          (addNewStage)="ops.onAddNewStage()"
          (stageDragOver)="onStageDragOver($event)"
          (stageDragLeave)="onStageDragLeave($event)"
          (stageDrop)="onStageDrop($event)"
          (taskSelect)="ops.onTaskSelect($event)"
          (addSibling)="ops.onAddSibling($event)"
          (addChild)="ops.onAddChild($event)"
          (deleteTask)="ops.onDeleteTask($event)"
          (parkTask)="ops.onParkTask($event)"
          (attachmentError)="ops.onAttachmentError($event)"
          (openLinkedTask)="ops.onOpenLinkedTask($event)"
          (taskDragStart)="onDragStart($event)"
          (taskDragEnd)="onDragEnd()"
          (taskDragOver)="onTaskDragOver($event)"
          (taskTouchStart)="onTaskTouchStart($event)"
          (taskTouchMove)="onTouchMove($event)"
          (taskTouchEnd)="onTouchEnd($event)"
          (taskTouchCancel)="onTouchCancel($event)"
        />
        
        <!-- 删除确认弹窗 -->
        @if (deleteConfirmTask()) {
          <app-text-delete-dialog
            [task]="deleteConfirmTask()!"
            [isMobile]="isMobile()"
            [hasChildren]="ops.hasChildren(deleteConfirmTask()!)"
            [keepChildren]="deleteKeepChildren()"
            (confirm)="ops.onConfirmDelete($event)"
            (cancel)="ops.onCancelDelete()"
            (keepChildrenChange)="deleteKeepChildren.set($event)"
          />
        }
        
      }
    </div>
  `
})
export class TextViewComponent implements OnInit, OnDestroy {
  readonly uiState = inject(UiStateService);
  readonly projectState = inject(ProjectStateService);
  readonly userSession = inject(UserSessionService);
  private readonly taskOpsAdapter = inject(TaskOperationAdapterService);
  private readonly syncCoordinator = inject(SyncCoordinatorService);
  readonly dragDropService = inject(TextViewDragDropService);
  readonly ops = inject(TextViewTaskOpsService);
  private readonly ngZone = inject(NgZone);
  private readonly logger = inject(LoggerService).category('TextView');
  
  /** 全局触摸事件监听器的绑定引用 */
  private boundGlobalTouchMove = this.handleGlobalTouchMove.bind(this);
  private boundGlobalTouchEnd = this.handleGlobalTouchEnd.bind(this);
  private boundGlobalTouchCancel = this.handleGlobalTouchCancel.bind(this);
  /** pointer/click/自定义事件监听器绑定引用（必须复用同一函数引用，否则无法移除监听器） */
  private boundGlobalPointerUp = this.handleGlobalPointerUp.bind(this);
  private boundEmergencyCleanup = this.handleEmergencyCleanup.bind(this);
  private boundTouchDragTimeout = this.handleTouchDragTimeout.bind(this) as EventListener;

  /** 移动端视图切换追踪（用于切换时收起编辑态） */
  private lastMobileActiveView: 'text' | 'flow' | null = null;
  private isGlobalTouchMoveListening = false;
  
  @ViewChild('scrollContainer', { static: true }) scrollContainerRef!: ElementRef<HTMLElement>;
  @ViewChild('stagesRef') stagesRef!: TextStagesComponent;
  @ViewChild('unassignedRef') unassignedRef!: TextUnassignedComponent;
  
  @Output() focusFlowNode = new EventEmitter<string>();
  
  // UI 状态
  readonly selectedTaskId = signal<string | null>(null);
  readonly deleteConfirmTask = signal<Task | null>(null);
  readonly deleteKeepChildren = signal(false);
  
  // 计算属性
  readonly isMobile = this.uiState.isMobile;
  
  /**
   * 是否显示加载骨架屏
   * 只在首次加载（无本地数据）时显示，增量同步时保留现有内容
   */
  readonly showLoadingSkeleton = computed(() => {
    const isLoading = this.syncCoordinator.isLoadingRemote();
    const hasLocalData = this.projectState.tasks().length > 0 || this.projectState.stages().length > 0;
    return isLoading && !hasLocalData;
  });
  
  constructor() {
    // effect() 必须在注入上下文中调用（构造函数），否则抛 NG0203
    this.setupSignalEffects();
  }
  
  /**
   * 信号 effect 集中注册（必须在构造函数中调用以确保注入上下文可用）
   */
  private setupSignalEffects(): void {
    // 移动端视图切换：离开文本视图时收起所有展开/编辑态
    effect(() => {
      const isMobile = this.uiState.isMobile();
      const activeView = this.uiState.activeView();

      if (!isMobile) {
        this.lastMobileActiveView = activeView;
        return;
      }

      const previousView = this.lastMobileActiveView;
      this.lastMobileActiveView = activeView;

      if (previousView === activeView) return;

      if (activeView !== 'text') {
        this.resetTextEditingState();
        return;
      }

      this.resetTextEditingState();
    });
    
    // 监听项目切换：切换项目时重置编辑状态
    effect(() => {
      const projectId = this.projectState.activeProjectId();
      
      // 项目切换时重置所有编辑状态
      // 避免带着上一个项目的编辑状态进入新项目
      if (projectId) {
        this.resetTextEditingState();
      }
    });
  }
  
  ngOnInit() {
    // 重置所有编辑状态
    this.selectedTaskId.set(null);
    
    // 初始化任务操作服务
    this.ops.init({
      selectedTaskId: this.selectedTaskId,
      deleteConfirmTask: this.deleteConfirmTask,
      deleteKeepChildren: this.deleteKeepChildren,
      focusFlowNode: this.focusFlowNode,
      isMobile: this.isMobile,
      getStagesRef: () => this.stagesRef,
      getUnassignedRef: () => this.unassignedRef,
    });
    this.ops.attachNestedScrollHandoff(this.scrollContainerRef.nativeElement);
    
    // 在 document 上注册全局触摸事件监听器
    document.addEventListener('touchend', this.boundGlobalTouchEnd, { capture: true, passive: false });
    document.addEventListener('touchcancel', this.boundGlobalTouchCancel, { capture: true, passive: false });
    document.addEventListener('pointerup', this.boundGlobalPointerUp, { capture: true });
    document.addEventListener('pointercancel', this.boundGlobalPointerUp, { capture: true });
    document.addEventListener('click', this.boundEmergencyCleanup, { capture: true });
    document.addEventListener('touchDragTimeout', this.boundTouchDragTimeout);
  }
  
  /** 处理 pointerup 事件 - 作为 touchend 的备用 */
  private handleGlobalPointerUp(event: PointerEvent) {
    if (event.pointerType !== 'touch') return;
    if (this.dragDropService.isDOMUpdating) return;
    
    const hasTask = !!this.dragDropService.touchDragTask;
    const isDragging = this.dragDropService.isTouchDragging;
    if (!hasTask && !isDragging) return;
    
    const dragActivationTime = this.dragDropService.getDragActivationTime();
    if (dragActivationTime && Date.now() - dragActivationTime < 500) return;
    
    if (!event.isPrimary) return;
    
    this.ngZone.run(() => {
      this.onTouchEnd(event as unknown as TouchEvent);
    });
  }
  
  /** 处理拖拽超时 - 当 touchend 丢失时自动完成拖拽 */
  private handleTouchDragTimeout(_event: CustomEvent) {
    this.ngZone.run(() => {
      const dragResult = this.cleanupTouchGestureState();
      this.applyTouchDropResult(dragResult, message => {
        this.logger.error('[TouchDragTimeout] Move failed', { error: message });
      });
    });
  }
  
  /** 紧急清理处理器 */
  private handleEmergencyCleanup(_event: MouseEvent) {
    if (this.dragDropService.isTouchDragging) return;
    
    const isDragging = this.dragDropService.draggingTaskId();
    const hasGhost = !!this.dragDropService['touchState']?.dragGhost;
    
    if (isDragging || hasGhost) {
      this.logger.warn('[TextView] Emergency cleanup triggered');
      const touchEndResult = this.dragDropService.endTouchDrag();
      const mouseExpandedStages = this.dragDropService.endDrag();
      this.ops.collapseAutoExpandedStages(touchEndResult.autoExpandedStages, mouseExpandedStages);
      this.ops.restoreAutoCollapsedSourceStage();
    }
  }
  
  ngOnDestroy() {
    this.resetTextEditingState();
    
    document.removeEventListener('touchend', this.boundGlobalTouchEnd, { capture: true } as EventListenerOptions);
    document.removeEventListener('touchcancel', this.boundGlobalTouchCancel, { capture: true } as EventListenerOptions);
    this.removeGlobalTouchMoveListener();
    document.removeEventListener('pointerup', this.boundGlobalPointerUp, { capture: true } as EventListenerOptions);
    document.removeEventListener('pointercancel', this.boundGlobalPointerUp, { capture: true } as EventListenerOptions);
    document.removeEventListener('click', this.boundEmergencyCleanup, { capture: true } as EventListenerOptions);
    document.removeEventListener('touchDragTimeout', this.boundTouchDragTimeout);
    
    this.dragDropService.cleanup();
    this.ops.destroy();
  }

  private resetTextEditingState(): void {
    this.selectedTaskId.set(null);
    this.deleteConfirmTask.set(null);
    this.deleteKeepChildren.set(false);
    this.unassignedRef?.resetEditState();
  }
  
  // ========== 鼠标拖拽处理 ==========

  onDragStart(data: { event: DragEvent; task: Task }) {
    const { event, task } = data;
    this.dragDropService.startDrag(task);
    if (event.dataTransfer) {
      writeTaskDragPayload(event.dataTransfer, {
        v: 1,
        type: 'task',
        taskId: task.id,
        projectId: this.projectState.activeProjectId(),
        fromProjectId: this.projectState.activeProjectId(),
        source: 'text',
      });
      event.dataTransfer.effectAllowed = 'move';
    }
    
    const container = this.ops.resolveAutoScrollContainer(task.stage, event.clientY);
    if (container) {
      this.dragDropService.startAutoScroll(container, event.clientY);
    }
  }
  
  onDragEnd() {
    if (this.dragDropService.isTouchDragging) return;
    const mouseExpandedStages = this.dragDropService.endDrag();
    this.ops.collapseAutoExpandedStages(mouseExpandedStages);
    this.ops.restoreAutoCollapsedSourceStage();
  }
  
  onTaskDragOver(data: { event: DragEvent; task: Task; stageNumber: number }) {
    const { event, task, stageNumber } = data;
    event.preventDefault();
    event.stopPropagation();
    
    const isCollapsed = !this.stagesRef?.isStageExpanded(stageNumber);
    const result = this.dragDropService.handleStageDragOver(stageNumber, isCollapsed);
    
    if (result.collapse !== undefined) this.stagesRef?.collapseStage(result.collapse);
    if (result.expand !== undefined) this.stagesRef?.expandStage(result.expand);

    this.ops.collapseSourceStageIfNeeded(stageNumber);
    
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const isAbove = event.clientY < rect.top + rect.height / 2;
    
    if (isAbove) {
      this.dragDropService.updateDropTarget(stageNumber, task.id);
    } else {
      const stages = this.projectState.stages();
      const stage = stages.find(s => s.stageNumber === stageNumber);
      const idx = stage?.tasks.findIndex(t => t.id === task.id) ?? -1;
      const nextTask = stage?.tasks[idx + 1];
      this.dragDropService.updateDropTarget(stageNumber, nextTask?.id ?? null);
    }

    this.dragDropService.updateAutoScrollContainer(this.ops.resolveAutoScrollContainer(stageNumber, event.clientY), event.clientY);
  }
  
  onStageDragOver(data: { event: DragEvent; stageNumber: number }) {
    const { event, stageNumber } = data;
    event.preventDefault();
    
    const isCollapsed = !this.stagesRef?.isStageExpanded(stageNumber);
    const result = this.dragDropService.handleStageDragOver(stageNumber, isCollapsed);
    
    if (result.collapse !== undefined) this.stagesRef?.collapseStage(result.collapse);
    if (result.expand !== undefined) this.stagesRef?.expandStage(result.expand);

    this.ops.collapseSourceStageIfNeeded(stageNumber);
    this.dragDropService.updateAutoScrollContainer(this.ops.resolveAutoScrollContainer(stageNumber, event.clientY), event.clientY);
  }
  
  onStageDragLeave(data: { event: DragEvent; stageNumber: number }) {
    const { event, stageNumber } = data;
    const relatedTarget = event.relatedTarget as HTMLElement;
    const currentTarget = event.currentTarget as HTMLElement;
    
    if (!relatedTarget || !currentTarget.contains(relatedTarget)) {
      const collapseStage = this.dragDropService.handleStageDragLeave(stageNumber);
      if (collapseStage !== null) this.stagesRef?.collapseStage(collapseStage);
      this.ops.collapseSourceStageIfNeeded(null);
      this.dragDropService.updateAutoScrollContainer(this.ops.resolveAutoScrollContainer(null, event.clientY), event.clientY);
    }
  }
  
  onStageDrop(data: { event: DragEvent; stageNumber: number }) {
    const { event, stageNumber } = data;
    event.preventDefault();
    
    if (this.dragDropService.isTouchDragging) return;

    const payload = event.dataTransfer ? readTaskDragPayload(event.dataTransfer) : null;
    const jsonData = event.dataTransfer?.getData('application/json');
    let fallbackTask: Task | null = null;
    if (jsonData) {
      try {
        fallbackTask = JSON.parse(jsonData) as Task;
      } catch {
        fallbackTask = null;
      }
    }
    const taskId = payload?.taskId ?? fallbackTask?.id ?? null;
    if (taskId) {
      const task = this.projectState.getTask(taskId);
      if (task) {
        const dropInfo = this.dragDropService.dropTargetInfo();
        const beforeTaskId = dropInfo?.beforeTaskId ?? null;
        const inferredParentId = this.ops.inferParentIdForDrop(stageNumber, beforeTaskId);

        const result = this.taskOpsAdapter.moveTaskToStage(task.id, stageNumber, beforeTaskId, inferredParentId);
        
        if (isFailure(result)) {
          this.ops.onAttachmentError(`无法将任务移动到阶段 ${stageNumber}：${getErrorMessage(result.error)}`);
        } else {
          this.stagesRef?.expandStage(stageNumber);
        }

        this.ops.collapseSourceStageIfNeeded(stageNumber);
      }
    }
    
    const mouseExpandedStages = this.dragDropService.endDrag();
    this.ops.collapseAutoExpandedStages(mouseExpandedStages);
    this.ops.restoreAutoCollapsedSourceStage();
  }
  
  // ========== 触摸拖拽处理 ==========
  
  onTouchStart(data: TaskTouchStartPayload) {
    const { event, task } = data;
    if (event.touches.length !== 1) return;
    const touch = event.touches[0];
    this.dragDropService.startTouchDrag(task, touch, () => {}, { gestureMode: data.gestureMode });
    this.addGlobalTouchMoveListener();
  }
  
  onTaskTouchStart(data: TaskTouchStartPayload) {
    const { event, task } = data;
    if (event.touches.length !== 1) return;
    if (!task || this.selectedTaskId() === task.id) return;
    const touch = event.touches[0];
    this.dragDropService.startTouchDrag(task, touch, () => {}, { gestureMode: data.gestureMode });
    this.addGlobalTouchMoveListener();
  }
  
  onTouchMove(event: TouchEvent) {
    if (event.touches.length !== 1) return;
    
    const touch = event.touches[0];
    const isDragging = this.dragDropService.handleTouchMove(touch);
    const isActiveDragging = isDragging || this.dragDropService.isTouchDragging;
    
    if (!isActiveDragging) {
      if (!this.dragDropService.touchDragTask) {
        this.removeGlobalTouchMoveListener();
      }
      return;
    }
    
    if (event.cancelable) event.preventDefault();
    let activeScrollStage: number | null = null;
    
    // 查找目标阶段
    const elements = document.elementsFromPoint(touch.clientX, touch.clientY);
    let foundStage = false;
    const draggingTaskId = this.dragDropService.draggingTaskId();
    const currentHoverStage = this.dragDropService.dragOverStage();
    
    for (const el of elements) {
      const stageEl = el.closest('[data-stage-number]');
      if (!stageEl) continue;
      
      const stageNum = parseInt(stageEl.getAttribute('data-stage-number') || '0', 10);
      if (stageNum <= 0) continue;
      
      // 当进入新阶段时：展开目标阶段，折叠之前的阶段
      if (currentHoverStage !== stageNum) {
        const wasCollapsed = this.stagesRef ? !this.stagesRef.isStageExpanded(stageNum) : false;
        this.dragDropService.beginDOMUpdate();
        const collapseStage = this.dragDropService.switchToStage(stageNum, { autoExpanded: wasCollapsed });
        
        if (collapseStage !== null) this.stagesRef?.collapseStage(collapseStage);
        
        if (wasCollapsed) {
          requestAnimationFrame(() => {
            this.stagesRef?.expandStage(stageNum);
            setTimeout(() => this.dragDropService.endDOMUpdate(), 50);
          });
        } else {
          this.dragDropService.endDOMUpdate();
        }
      }

      this.ops.collapseSourceStageIfNeeded(stageNum);
      
      // 检查是否在某个任务上方
      const taskEl = el.closest('[data-task-id]');
      if (taskEl) {
        const taskId = taskEl.getAttribute('data-task-id');
        if (taskId && taskId !== draggingTaskId) {
          const rect = taskEl.getBoundingClientRect();
          const isAbove = touch.clientY < rect.top + rect.height / 2;
          
          if (isAbove) {
            this.dragDropService.updateTouchTarget(stageNum, taskId);
          } else {
            const stages = this.projectState.stages();
            const stage = stages.find(s => s.stageNumber === stageNum);
            const idx = stage?.tasks.findIndex(t => t.id === taskId) ?? -1;
            const nextTask = stage?.tasks[idx + 1];
            this.dragDropService.updateTouchTarget(stageNum, nextTask?.id ?? null);
          }
        } else if (taskId === draggingTaskId) {
          this.dragDropService.updateTouchTarget(stageNum, null);
        }
      } else {
        this.dragDropService.updateTouchTarget(stageNum, null);
      }
      
      this.dragDropService.updateGhostVisualFeedback(true);
      this.dragDropService.clearUnassignedTarget();
      activeScrollStage = stageNum;
      foundStage = true;
      break;
    }
    
    if (!foundStage) {
      // 检查是否在待分配区域
      let foundUnassigned = false;
      for (const el of elements) {
        const unassignedEl = el.closest('[data-unassigned-task]');
        if (unassignedEl) {
          const targetTaskId = unassignedEl.getAttribute('data-unassigned-task');
          if (targetTaskId && targetTaskId !== draggingTaskId) {
            this.dragDropService.updateUnassignedTarget(targetTaskId);
            this.dragDropService.updateGhostVisualFeedback(true);
            foundUnassigned = true;
            break;
          }
        }
      }
      
      if (!foundUnassigned) {
        this.dragDropService.clearUnassignedTarget();
        this.dragDropService.updateGhostVisualFeedback(false);
        this.dragDropService.beginDOMUpdate();
        const collapseStage = this.dragDropService.updateTouchTarget(null, null);
        if (collapseStage !== null) {
          requestAnimationFrame(() => {
            this.stagesRef?.collapseStage(collapseStage);
            setTimeout(() => this.dragDropService.endDOMUpdate(), 50);
          });
        } else {
          this.dragDropService.endDOMUpdate();
        }
        this.ops.collapseSourceStageIfNeeded(null);
      }
    }

    const container = this.ops.resolveAutoScrollContainer(activeScrollStage, touch.clientY);
    if (container) {
      this.dragDropService.performTouchAutoScroll(container, touch.clientY);
    }
  }
  
  private cleanupTouchGestureState() {
    const touchEndResult = this.dragDropService.endTouchDrag();
    const mouseExpandedStages = this.dragDropService.endDrag();
    this.removeGlobalTouchMoveListener();
    const { autoExpandedStages } = touchEndResult;
    this.ops.collapseAutoExpandedStages(autoExpandedStages, mouseExpandedStages);
    this.ops.restoreAutoCollapsedSourceStage();
    return touchEndResult;
  }

  private applyTouchDropResult(
    dragResult: ReturnType<TextViewDragDropService['endTouchDrag']>,
    onFailure: (message: string) => void,
  ): void {
    const { task, targetStage, targetBeforeId, targetUnassignedId, wasDragging } = dragResult;

    if (!task || !wasDragging) {
      return;
    }

    if (targetUnassignedId !== null && targetUnassignedId !== undefined && task.stage === null) {
      const result = this.taskOpsAdapter.moveTaskToStage(task.id, null, undefined, targetUnassignedId);
      if (isFailure(result)) {
        onFailure(`重新挂载失败：${getErrorMessage(result.error)}`);
      }
      return;
    }

    if (targetStage !== null) {
      const inferredParentId = this.ops.inferParentIdForDrop(targetStage, targetBeforeId ?? null);
      const result = this.taskOpsAdapter.moveTaskToStage(task.id, targetStage, targetBeforeId, inferredParentId);
      if (isFailure(result)) {
        onFailure(`无法将任务移动到阶段 ${targetStage}：${getErrorMessage(result.error)}`);
      }
    }
  }

  onTouchEnd(_event: TouchEvent) {
    const dragResult = this.cleanupTouchGestureState();
    this.applyTouchDropResult(dragResult, message => this.ops.onAttachmentError(message));
  }

  onTouchCancel(_event: TouchEvent) {
    this.cleanupTouchGestureState();
  }
  
  // ========== 全局触摸处理 ==========
  
  onGlobalTouchMove(event: TouchEvent) {
    if (!this.dragDropService.draggingTaskId() && !this.dragDropService.touchDragTask) return;
    this.onTouchMove(event);
  }
  
  onGlobalTouchEnd(event: TouchEvent) {
    if (!this.dragDropService.draggingTaskId() && !this.dragDropService.touchDragTask) return;
    this.onTouchEnd(event);
  }
  
  onGlobalTouchCancel(event: TouchEvent) {
    if (!this.dragDropService.draggingTaskId() && !this.dragDropService.touchDragTask) return;
    this.onTouchCancel(event);
  }
  
  /** document 级别的全局 touchend 处理器 */
  private handleGlobalTouchEnd(event: TouchEvent) {
    if (this.dragDropService.isDOMUpdating) return;
    if (!this.dragDropService.touchDragTask) return;
    this.ngZone.run(() => this.onTouchEnd(event));
  }
  
  /** document 级别的全局 touchcancel 处理器 */
  private handleGlobalTouchCancel(event: TouchEvent) {
    if (this.dragDropService.isDOMUpdating) return;
    if (!this.dragDropService.draggingTaskId() && !this.dragDropService.touchDragTask) return;
    this.ngZone.run(() => this.onTouchCancel(event));
  }

  private addGlobalTouchMoveListener(): void {
    if (this.isGlobalTouchMoveListening) return;
    document.addEventListener('touchmove', this.boundGlobalTouchMove, { capture: true, passive: false });
    this.isGlobalTouchMoveListening = true;
  }

  private removeGlobalTouchMoveListener(): void {
    if (!this.isGlobalTouchMoveListening) return;
    document.removeEventListener('touchmove', this.boundGlobalTouchMove, { capture: true } as EventListenerOptions);
    this.isGlobalTouchMoveListening = false;
  }

  /** document 级别 touchmove 只在拖拽准备/拖拽期间存在，普通滚动保持原生被动路径 */
  private handleGlobalTouchMove(event: TouchEvent): void {
    if (!this.dragDropService.draggingTaskId() && !this.dragDropService.touchDragTask) {
      this.removeGlobalTouchMoveListener();
      return;
    }

    this.ngZone.run(() => this.onTouchMove(event));
  }
}
