import { Component, ElementRef, inject, input, output, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ProjectStateService } from '../../../../services/project-state.service';
import { Task } from '../../../../models';
import { StageData, DropTargetInfo, TaskTouchStartPayload } from './text-view.types';
import { TextTaskCardComponent } from './text-task-card.component';

const NESTED_SCROLL_EDGE_THRESHOLD_PX = 144;
const NESTED_SCROLL_MIN_DELTA_PX = 0.5;
const NESTED_SCROLL_PREVIEW_MAX_OUTER_SHARE = 0.42;
const NESTED_SCROLL_BOUNDARY_EPSILON_PX = 1;
const WHEEL_DELTA_LINE_MODE = 1;
const WHEEL_DELTA_PAGE_MODE = 2;
const WHEEL_DELTA_LINE_PX = 16;

/**
 * 阶段卡片组件
 * 显示单个阶段及其任务列表，支持折叠和拖拽放置
 */
@Component({
  selector: 'app-text-stage-card',
  standalone: true,
  imports: [CommonModule, TextTaskCardComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <article 
      [attr.data-stage-number]="stage().stageNumber"
      class="text-stage-card flex flex-col min-w-0 bg-retro-cream/70 dark:bg-stone-800/70 backdrop-blur border border-retro-muted/20 dark:border-stone-700/50 rounded-xl shadow-sm overflow-hidden transition-all flex-shrink-0"
      [ngClass]="{
        'rounded-2xl': !isMobile(), 
        'w-full': isMobile(),
        'border-retro-teal dark:border-retro-teal border-2 bg-retro-teal/5 dark:bg-retro-teal/10': isDragOver()
      }"
      (dragover)="onStageDragOver($event)"
      (dragleave)="onStageDragLeave($event)"
      (drop)="onStageDrop($event)">
      
      <!-- 阶段标题 -->
      <header 
        class="px-3 py-2 flex justify-between items-center cursor-pointer hover:bg-retro-cream/90 dark:hover:bg-stone-700/50 transition-colors select-none"
        [ngClass]="{'px-4 py-3': !isMobile()}"
        (click)="toggleCollapse()">
        <h3 class="font-bold text-retro-olive dark:text-retro-olive tracking-tight flex items-center"
            [ngClass]="{'text-sm gap-2': !isMobile(), 'text-xs gap-1.5': isMobile()}">
          <span class="rounded-full bg-retro-olive dark:bg-retro-olive" 
                [ngClass]="{'w-1 h-4': !isMobile(), 'w-0.5 h-3': isMobile()}"></span>
          阶段 {{stage().stageNumber}}
        </h3>
        <div class="flex items-center" [ngClass]="{'gap-2': !isMobile(), 'gap-1.5': isMobile()}">
          <span class="text-retro-olive dark:text-retro-olive font-mono bg-canvas/60 dark:bg-stone-700/60 rounded-full"
                [ngClass]="{'text-[10px] px-2': !isMobile(), 'text-[9px] px-1.5 py-0.5': isMobile()}">
            {{stage().tasks.length}}
          </span>
          <span class="text-stone-400 dark:text-stone-500 text-[10px] transition-transform" 
                [class.rotate-180]="!isExpanded()">▼</span>
        </div>
      </header>

      <!-- 任务列表 -->
      <div class="flex-1 min-h-0 overflow-y-auto custom-scrollbar task-stack transition-all duration-150 ease-out"
           [attr.data-stage-task-list]="stage().stageNumber"
           [attr.inert]="!isExpanded() ? '' : null"
           (wheel)="onTaskListWheel($event)"
           (touchstart)="onTaskListTouchStart($event)"
           (touchmove)="onTaskListTouchMove($event)"
           (touchend)="resetTaskListTouch()"
           (touchcancel)="resetTaskListTouch()"
           [ngClass]="{
             'space-y-2 px-3 pb-3 max-h-[60vh] opacity-100 animate-collapse-open': isExpanded() && !isMobile(),
             'space-y-1.5 px-2 pb-2 max-h-[40vh] opacity-100 animate-collapse-open': isExpanded() && isMobile(),
             'max-h-0 opacity-0 pointer-events-none overflow-hidden py-0 px-0 collapsed-section': !isExpanded()
           }"
           [attr.aria-hidden]="!isExpanded()">
          @for (task of stage().tasks; track task.id) {
            <!-- 放置指示线（任务前） -->
            @if (dropTargetInfo()?.stageNumber === stage().stageNumber && dropTargetInfo()?.beforeTaskId === task.id) {
              <div class="h-0.5 bg-retro-teal rounded-full mx-1 animate-pulse"></div>
            }
            
            <app-text-task-card
              [task]="task"
              [isMobile]="isMobile()"
              [isSelected]="selectedTaskId() === task.id"
              [isDragging]="draggingTaskId() === task.id"
              [userId]="userId()"
              [projectId]="projectId()"
              [connections]="getConnections(task.id)"
              [stageNumber]="stage().stageNumber"
              (select)="taskSelect.emit($event)"
              (addSibling)="addSibling.emit(task)"
              (addChild)="addChild.emit(task)"
              (deleteTask)="deleteTask.emit(task)"
              (parkTask)="parkTask.emit(task)"
              (attachmentError)="attachmentError.emit($event)"
              (openLinkedTask)="openLinkedTask.emit($event)"
              (dragStart)="taskDragStart.emit($event)"
              (dragEnd)="taskDragEnd.emit()"
              (dragOver)="taskDragOver.emit($event)"
              (touchStart)="taskTouchStart.emit($event)"
              (touchMove)="taskTouchMove.emit($event)"
              (touchEnd)="taskTouchEnd.emit($event)"
              (touchCancel)="taskTouchCancel.emit($event)">
            </app-text-task-card>
          }
          
          <!-- 放置指示线（末尾） -->
          @if (dropTargetInfo()?.stageNumber === stage().stageNumber && dropTargetInfo()?.beforeTaskId === null) {
            <div class="h-0.5 bg-retro-teal rounded-full mx-1 animate-pulse"></div>
          }
      </div>
    </article>
  `,
  styles: [`
    .task-stack {
      touch-action: pan-y;
      overscroll-behavior-y: auto;
      -webkit-overflow-scrolling: touch;
    }

    .animate-collapse-open { 
      animation: collapseOpen 0.15s ease-out; 
    }
    @keyframes collapseOpen { 
      from { opacity: 0; transform: translateY(-4px); } 
      to { opacity: 1; transform: translateY(0); } 
    }
  `]
})
export class TextStageCardComponent {
  private readonly projectState = inject(ProjectStateService);
  private readonly hostElement = inject(ElementRef<HTMLElement>);
  private taskListTouchLastY: number | null = null;
  
  readonly stage = input.required<StageData>();
  readonly isMobile = input(false);
  readonly isExpanded = input(true);
  readonly selectedTaskId = input<string | null>(null);
  readonly draggingTaskId = input<string | null>(null);
  readonly isDragOver = input(false);
  readonly dropTargetInfo = input<DropTargetInfo | null>(null);
  readonly userId = input<string | null>(null);
  readonly projectId = input<string | null>(null);
  
  // 阶段事件
  readonly toggleExpand = output<number>();
  readonly stageDragOver = output<{ event: DragEvent; stageNumber: number }>();
  readonly stageDragLeave = output<{ event: DragEvent; stageNumber: number }>();
  readonly stageDrop = output<{ event: DragEvent; stageNumber: number }>();
  
  // 任务事件
  readonly taskSelect = output<Task>();
  readonly addSibling = output<Task>();
  readonly addChild = output<Task>();
  readonly deleteTask = output<Task>();
  readonly parkTask = output<Task>();
  readonly attachmentError = output<string>();
  readonly openLinkedTask = output<{ taskId: string; event: Event }>();
  
  // 拖拽事件
  readonly taskDragStart = output<{ event: DragEvent; task: Task }>();
  readonly taskDragEnd = output<void>();
  readonly taskDragOver = output<{ event: DragEvent; task: Task; stageNumber: number }>();
  readonly taskTouchStart = output<TaskTouchStartPayload>();
  readonly taskTouchMove = output<TouchEvent>();
  readonly taskTouchEnd = output<TouchEvent>();
  readonly taskTouchCancel = output<TouchEvent>();

  onTaskListWheel(event: WheelEvent): void {
    if (event.ctrlKey || this.shouldIgnoreScrollHandoff(event.target)) {
      return;
    }

    const taskList = this.readCurrentTaskList(event.currentTarget);
    const outerStageList = taskList ? this.findOuterStageList(taskList) : null;
    if (!taskList || !outerStageList) {
      return;
    }

    const shouldPreventDefault = this.applyNestedScrollHandoff(taskList, outerStageList, this.normalizeWheelDeltaY(event, taskList));
    if (shouldPreventDefault && event.cancelable) {
      event.preventDefault();
    }
  }

  onTaskListTouchStart(event: TouchEvent): void {
    if (event.touches.length !== 1 || this.shouldIgnoreScrollHandoff(event.target)) {
      this.resetTaskListTouch();
      return;
    }

    this.taskListTouchLastY = event.touches[0]?.clientY ?? null;
  }

  onTaskListTouchMove(event: TouchEvent): void {
    if (event.touches.length !== 1 || this.taskListTouchLastY === null || this.shouldIgnoreScrollHandoff(event.target)) {
      this.resetTaskListTouch();
      return;
    }

    const currentY = event.touches[0]?.clientY ?? this.taskListTouchLastY;
    const deltaY = this.taskListTouchLastY - currentY;
    this.taskListTouchLastY = currentY;

    const taskList = this.readCurrentTaskList(event.currentTarget);
    const outerStageList = taskList ? this.findOuterStageList(taskList) : null;
    if (!taskList || !outerStageList) {
      return;
    }

    const shouldPreventDefault = this.applyNestedScrollHandoff(taskList, outerStageList, deltaY);
    if (shouldPreventDefault && event.cancelable) {
      event.preventDefault();
    }
  }

  resetTaskListTouch(): void {
    this.taskListTouchLastY = null;
  }

  // 保留原生内层滚动惯性；只在边缘预滚外层，并在真正跨界时接管一次。
  private applyNestedScrollHandoff(taskList: HTMLElement, outerStageList: HTMLElement, deltaY: number): boolean {
    if (!this.isExpanded() || Math.abs(deltaY) < NESTED_SCROLL_MIN_DELTA_PX) {
      return false;
    }

    const innerRoom = this.getScrollRoom(taskList, deltaY);
    const outerRoom = this.getScrollRoom(outerStageList, deltaY);
    if (outerRoom <= NESTED_SCROLL_BOUNDARY_EPSILON_PX) {
      return false;
    }

    if (innerRoom <= NESTED_SCROLL_BOUNDARY_EPSILON_PX) {
      return Math.abs(this.applyScrollDelta(outerStageList, deltaY)) >= NESTED_SCROLL_MIN_DELTA_PX;
    }

    const deltaMagnitude = Math.abs(deltaY);
    if (deltaMagnitude > innerRoom + NESTED_SCROLL_BOUNDARY_EPSILON_PX) {
      const innerDelta = Math.sign(deltaY) * innerRoom;
      const consumedInnerDelta = this.applyScrollDelta(taskList, innerDelta);
      const consumedOuterDelta = this.applyScrollDelta(outerStageList, deltaY - consumedInnerDelta);
      return Math.abs(consumedInnerDelta + consumedOuterDelta) >= NESTED_SCROLL_MIN_DELTA_PX;
    }

    this.applyScrollDelta(outerStageList, this.computeOuterPreviewDelta(taskList, outerStageList, deltaY, innerRoom));
    return false;
  }

  private computeOuterPreviewDelta(
    taskList: HTMLElement,
    outerStageList: HTMLElement,
    deltaY: number,
    innerRoom: number,
  ): number {
    const outerRoom = this.getScrollRoom(outerStageList, deltaY);
    if (outerRoom <= NESTED_SCROLL_BOUNDARY_EPSILON_PX) {
      return 0;
    }

    const threshold = Math.min(NESTED_SCROLL_EDGE_THRESHOLD_PX, Math.max(48, taskList.clientHeight * 0.42));
    if (innerRoom >= threshold) {
      return 0;
    }

    const edgeProgress = 1 - innerRoom / threshold;
    const easedProgress = edgeProgress * edgeProgress * (3 - 2 * edgeProgress);
    const requestedDelta = deltaY * easedProgress * NESTED_SCROLL_PREVIEW_MAX_OUTER_SHARE;
    return Math.sign(deltaY) * Math.min(Math.abs(requestedDelta), outerRoom);
  }

  private getScrollRoom(element: HTMLElement, deltaY: number): number {
    const scrollTop = this.getClampedScrollTop(element);
    if (deltaY > 0) {
      return Math.max(0, this.getMaxScrollTop(element) - scrollTop);
    }

    return scrollTop;
  }

  private applyScrollDelta(element: HTMLElement, deltaY: number): number {
    if (Math.abs(deltaY) < NESTED_SCROLL_MIN_DELTA_PX) {
      return 0;
    }

    const previousScrollTop = this.getClampedScrollTop(element);
    const maxScrollTop = this.getMaxScrollTop(element);
    element.scrollTop = Math.min(maxScrollTop, Math.max(0, previousScrollTop + deltaY));
    return this.getClampedScrollTop(element) - previousScrollTop;
  }

  private getMaxScrollTop(element: HTMLElement): number {
    return Math.max(0, element.scrollHeight - element.clientHeight);
  }

  private getClampedScrollTop(element: HTMLElement): number {
    return Math.min(this.getMaxScrollTop(element), Math.max(0, element.scrollTop));
  }

  private normalizeWheelDeltaY(event: WheelEvent, taskList: HTMLElement): number {
    if (event.deltaMode === WHEEL_DELTA_LINE_MODE) {
      return event.deltaY * WHEEL_DELTA_LINE_PX;
    }

    if (event.deltaMode === WHEEL_DELTA_PAGE_MODE) {
      return event.deltaY * taskList.clientHeight;
    }

    return event.deltaY;
  }

  private readCurrentTaskList(currentTarget: EventTarget | null): HTMLElement | null {
    return currentTarget instanceof HTMLElement ? currentTarget : null;
  }

  private findOuterStageList(taskList: HTMLElement): HTMLElement | null {
    const closestStageList = taskList.closest('[data-stage-scroll-container]');
    if (closestStageList instanceof HTMLElement) {
      return closestStageList;
    }

    const hostParent = this.hostElement.nativeElement.parentElement;
    return hostParent?.closest('[data-stage-scroll-container]') ?? null;
  }

  private shouldIgnoreScrollHandoff(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) {
      return false;
    }

    return !!target.closest('input, textarea, select, [contenteditable="true"], [data-drag-handle], app-text-task-editor');
  }
  
  getConnections(taskId: string) {
    return this.projectState.getTaskConnections(taskId);
  }
  
  toggleCollapse() {
    this.toggleExpand.emit(this.stage().stageNumber);
  }
  
  onStageDragOver(event: DragEvent) {
    event.preventDefault();
    this.stageDragOver.emit({ event, stageNumber: this.stage().stageNumber });
  }
  
  onStageDragLeave(event: DragEvent) {
    this.stageDragLeave.emit({ event, stageNumber: this.stage().stageNumber });
  }
  
  onStageDrop(event: DragEvent) {
    event.preventDefault();
    this.stageDrop.emit({ event, stageNumber: this.stage().stageNumber });
  }
}
