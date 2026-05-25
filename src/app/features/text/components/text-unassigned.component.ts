import { Component, inject, input, output, signal, ChangeDetectionStrategy, ChangeDetectorRef, OnDestroy, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
import { ToastService } from '../../../../services/toast.service';
import { UiStateService } from '../../../../services/ui-state.service';
import { ProjectStateService } from '../../../../services/project-state.service';
import { ParkingService } from '../../../../services/parking.service';
import { DockEngineService } from '../../../../services/dock-engine.service';
import { SimpleReminderService } from '../../../../services/simple-reminder.service';
import { UserSessionService } from '../../../../services/user-session.service';
import { PARKING_CONFIG } from '../../../../config/parking.config';
import { Task } from '../../../../models';
import { SafeMarkdownPipe } from '../../../shared/pipes/safe-markdown.pipe';
import { toggleMarkdownTodo, getTodoIndexFromClick, handleMarkdownLinkAction } from '../../../../utils/markdown';
import { readTaskDragPayload } from '../../../../utils/task-drag-payload';
import type { TaskTouchStartPayload } from './text-view.types';

/**
 * 待分配区组件
 * 显示待分配任务列表，支持拖拽和编辑
 */
@Component({
  selector: 'app-text-unassigned',
  standalone: true,
  imports: [CommonModule, SafeMarkdownPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section 
      class="flex-none min-w-0 transition-all duration-300 overflow-hidden"
      [ngClass]="{'mx-4 mt-2 mb-4 max-h-[1000px]': !isMobile() && uiState.isTextSidebarVisible(), 'mx-2 mt-1 mb-2 max-h-[1000px]': isMobile() && uiState.isTextSidebarVisible(), 'max-h-0 opacity-0 m-0 p-0 border-none pointer-events-none': !uiState.isTextSidebarVisible()}">
      
      <div class="px-2 pb-1 rounded-xl bg-retro-teal/10 dark:bg-retro-teal/5 border border-retro-teal/30 dark:border-retro-teal/20">
        <header 
          (click)="uiState.isTextUnassignedOpen.set(!uiState.isTextUnassignedOpen()); $event.stopPropagation()" 
          class="py-2 cursor-pointer flex justify-between items-center group select-none touch-manipulation"
          style="-webkit-tap-highlight-color: transparent;">
          <span class="font-bold text-retro-dark dark:text-stone-200 flex items-center gap-2 tracking-tight pointer-events-none"
                [ngClass]="{'text-sm': !isMobile(), 'text-xs': isMobile()}">
            <span class="w-1.5 h-1.5 rounded-full bg-retro-teal shadow-[0_0_6px_rgba(74,140,140,0.4)]"></span>
            待分配
          </span>
          <div class="flex items-center gap-2">
            <button 
              (click)="onCreateClick($event)"
              data-testid="add-task-btn"
              class="flex items-center gap-1 px-2 py-1 rounded-md border border-retro-teal/50 bg-retro-teal/10 text-retro-teal hover:bg-retro-teal hover:text-white transition-colors"
              [ngClass]="{'text-xs': !isMobile(), 'text-[10px]': isMobile()}">
              <span class="text-base leading-none">+</span>
              新建
            </button>
            <span class="text-stone-300 dark:text-stone-600 text-xs group-hover:text-stone-500 transition-transform pointer-events-none" 
                  [class.rotate-180]="!uiState.isTextUnassignedOpen()">▼</span>
          </div>
        </header>

        @if (uiState.isTextUnassignedOpen()) {
          <div class="pb-2 animate-collapse-open">
            <div class="flex flex-wrap" 
                 [ngClass]="{'gap-2': !isMobile(), 'gap-1.5': isMobile()}"
                 (dragover)="handleDragOverUnassigned($event)"
                 (dragleave)="handleDragLeaveUnassigned($event)"
                 (drop)="handleDropUnassigned($event)">
              @for (task of projectState.unassignedTasks(); track task.id) {
                @if (editingTaskId() === task.id) {
                  <!-- 编辑/预览模式 -->
                  <div 
                    data-testid="task-card"
                    [attr.data-unassigned-task]="task.id"
                    class="w-full rounded-lg shadow-sm animate-collapse-open"
                    [ngClass]="{
                      'p-2 bg-white dark:bg-stone-800 border border-retro-teal dark:border-retro-teal': isEditMode(),
                      'px-2 py-1.5 bg-retro-teal/5 dark:bg-retro-teal/10 border border-retro-teal/20 dark:border-retro-teal/30 hover:border-retro-teal/40': !isEditMode()
                    }">
                    @if (isEditMode()) {
                      <!-- 【修复】编辑容器需要防止事件冒泡导致缩小 -->
                      <div class="space-y-2" (click)="$event.stopPropagation()">
                        <input #editInput
                          data-testid="task-title-input"
                          data-title-input
                          class="w-full bg-transparent border-none focus:ring-0 text-retro-dark dark:text-stone-200 p-0 mb-1"
                          [ngClass]="{'text-sm': !isMobile(), 'text-xs': isMobile()}"
                          [value]="localTitle()"
                          (input)="localTitle.set(editInput.value)"
                          (keydown.enter)="saveTask(task)"
                          (keydown.escape)="cancelEdit()"
                          (blur)="onTitleBlur($event, task)"
                          placeholder="输入任务标题..."
                          (click)="$event.stopPropagation()">
                        <textarea
                          #contentInput
                          data-testid="task-content-editor"
                          class="w-full border border-stone-200 dark:border-stone-700 rounded-md bg-white dark:bg-stone-700 text-stone-700 dark:text-stone-300 focus:ring-1 focus:ring-retro-teal focus:border-retro-teal outline-none resize-none"
                          [ngClass]="{'text-xs p-2 min-h-[90px]': !isMobile(), 'text-[11px] p-1.5 min-h-[100px]': isMobile()}"
                          [value]="localContent()"
                          (input)="localContent.set(contentInput.value)"
                          (keydown.meta.enter)="saveTask(task)"
                          (keydown.ctrl.enter)="saveTask(task)"
                          (click)="$event.stopPropagation()"
                          placeholder="输入任务内容 (Markdown)..."></textarea>
                        <div class="flex justify-end gap-2">
                          <button (click)="cancelEdit(); $event.stopPropagation()" class="text-[10px] text-stone-400 hover:text-stone-600">取消</button>
                          <button data-testid="save-task-btn" (click)="saveTask(task); $event.stopPropagation()" class="text-[10px] text-retro-teal hover:text-retro-teal/80 font-bold">保存</button>
                        </div>
                        <div class="flex gap-2 items-center">
                          <button
                            type="button"
                            data-testid="text-unassigned-park-button"
                            (click)="parkTaskNow(task); $event.stopPropagation()"
                            [disabled]="task.parkingMeta?.state === 'parked'"
                            class="px-2 py-1 text-[10px] rounded border transition-colors"
                            [ngClass]="task.parkingMeta?.state === 'parked'
                              ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 border-amber-300 dark:border-amber-700 opacity-70 cursor-default'
                              : 'bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400 border-amber-200 dark:border-amber-700 hover:bg-amber-500 hover:text-white'">
                            {{ task.parkingMeta?.state === 'parked' ? '已停泊' : '停泊' }}
                          </button>
                          <div class="relative" (mouseleave)="closeReminderMenu()">
                            <button
                              type="button"
                              data-testid="text-unassigned-reminder-trigger"
                              (click)="toggleReminderMenu(task.id); $event.stopPropagation()"
                              [disabled]="task.parkingMeta?.state !== 'parked'"
                              class="px-2 py-1 text-[10px] rounded border transition-colors"
                              [ngClass]="task.parkingMeta?.state === 'parked'
                                ? 'bg-sky-50 dark:bg-sky-900/20 text-sky-600 dark:text-sky-300 border-sky-200 dark:border-sky-700 hover:bg-sky-500 hover:text-white'
                                : 'bg-stone-50 dark:bg-stone-700 text-stone-400 dark:text-stone-500 border-stone-200 dark:border-stone-600 opacity-60 cursor-not-allowed'">
                              {{ task.parkingMeta?.reminder ? '提醒已设' : '提醒' }}
                            </button>
                            @if (reminderMenuTaskId() === task.id && task.parkingMeta?.state === 'parked') {
                              <div
                                class="absolute left-0 top-full mt-1 min-w-[120px] rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-800 shadow-lg p-1.5 z-10"
                                data-testid="text-unassigned-reminder-menu">
                                @for (preset of reminderPresets; track preset.minutes) {
                                  <button
                                    type="button"
                                    [attr.data-testid]="'text-unassigned-reminder-preset-' + preset.minutes"
                                    (click)="setReminderPreset(task.id, preset.minutes); $event.stopPropagation()"
                                    class="w-full text-left px-2 py-1 text-[10px] rounded hover:bg-stone-100 dark:hover:bg-stone-700 text-stone-600 dark:text-stone-300">
                                    {{ preset.label }}
                                  </button>
                                }
                                @if (task.parkingMeta?.reminder) {
                                  <button
                                    type="button"
                                    data-testid="text-unassigned-reminder-clear"
                                    (click)="clearReminder(task.id); $event.stopPropagation()"
                                    class="w-full text-left px-2 py-1 text-[10px] rounded hover:bg-stone-100 dark:hover:bg-stone-700 text-stone-500 dark:text-stone-400">
                                    取消提醒
                                  </button>
                                }
                              </div>
                            }
                          </div>
                        </div>
                      </div>
                    } @else {
                      <div class="flex justify-between items-start gap-2 group/preview">
                        <!-- 【修复】点击内容区域直接进入编辑，不触发卡片切换逻辑 -->
                        <div class="flex-1 min-w-0 cursor-text" (click)="onContentPreviewClick($event, task)">
                          <div class="font-medium text-retro-dark dark:text-stone-200 truncate"
                               data-testid="task-title-label"
                               [ngClass]="{'text-sm': !isMobile(), 'text-xs': isMobile()}">
                            {{task.title}}
                          </div>
                          <div
                            data-testid="text-unassigned-status-badge"
                            class="mt-1 inline-flex rounded px-1 py-0.5 text-[8px] font-medium"
                            [ngClass]="{
                              'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300': task.status === 'completed',
                              'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300': task.status !== 'completed'
                            }">
                            {{ task.status === 'completed' ? 'Completed' : 'Active' }}
                          </div>
                          @if (task.content) {
                            <div data-testid="task-content" class="prose prose-stone dark:prose-invert max-w-none mt-1 opacity-80"
                                 [ngClass]="{'text-xs': !isMobile(), 'text-[10px] line-clamp-2': isMobile()}"
                                 [innerHTML]="task.content | safeMarkdown">
                            </div>
                          }
                        </div>
                        <!-- 操作按钮组 -->
                        <div class="flex gap-1 shrink-0 mt-0.5 opacity-0 group-hover/preview:opacity-100 transition-opacity">
                          <button (click)="enterEdit(task); $event.stopPropagation()" 
                              data-testid="edit-task-btn"
                                  class="p-1 text-stone-400 hover:text-retro-teal transition-colors"
                                  title="编辑任务">
                            <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/></svg>
                          </button>
                          <button (click)="deleteTask(task.id); $event.stopPropagation()" 
                              data-testid="delete-task-btn"
                                  class="p-1 text-stone-400 hover:text-retro-rust transition-colors"
                                  title="删除任务">
                            <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
                          </button>
                        </div>
                      </div>
                    }
                  </div>
                } @else {
                  <!-- 【修复】普通展示模式：卡片外框用于在场景间切换，内容区域专用于编辑 -->
                  <div 
                    data-testid="task-card"
                    [attr.data-unassigned-task]="task.id"
                    (click)="onTaskCardClick(task); $event.stopPropagation()"
                    [attr.draggable]="true"
                    (dragstart)="handleDragStart($event, task)"
                    (dragend)="handleDragEnd()"
                    (touchstart)="handleTouchStart($event, task)"
                    (touchmove)="handleTouchMove($event)"
                    (touchend)="handleTouchEnd($event)"
                    (touchcancel)="handleTouchCancel($event)"
                    class="px-2 py-1 bg-white/60 dark:bg-stone-800/60 rounded-lg border border-retro-teal/20 dark:border-retro-teal/40 hover:border-retro-teal/50 hover:bg-white dark:hover:bg-stone-800 transition-all cursor-move active:scale-[0.98] select-none touch-none"
                    [ngClass]="{
                      'text-xs': !isMobile(), 
                      'text-[10px]': isMobile(),
                      'opacity-40 scale-98 border border-retro-teal border-dashed bg-retro-teal/10': draggingTaskId() === task.id
                    }">
                    <span data-testid="task-title-label" class="text-retro-dark dark:text-stone-300">{{task.title || '未命名任务'}}</span>
                    @if (task.content) {
                      <span class="ml-1 text-[10px] text-stone-400">· 内容</span>
                    }
                  </div>
                }
              }
            </div>
            @if (projectState.unassignedTasks().length === 0) {
              <div class="px-3 py-4 text-center">
                <p class="text-stone-400 italic font-light" [ngClass]="{'text-xs': !isMobile(), 'text-[10px]': isMobile()}">无待分配任务</p>
              </div>
            }
          </div>
        }
      </div>
    </section>
  `,
  styles: [`
    :host { display: block; }
    .animate-collapse-open {
      animation: collapse-open 0.25s cubic-bezier(0.4, 0, 0.2, 1);
      transform-origin: top;
    }
    @keyframes collapse-open {
      from { opacity: 0; transform: scaleY(0.95); }
      to { opacity: 1; transform: scaleY(1); }
    }
  `]
})
export class TextUnassignedComponent implements OnDestroy {
  isMobile = input(false);
  draggingTaskId = input<string | null>(null);

  taskClick = output<Task>();
  createUnassigned = output<void>();
  dragStart = output<{ event: DragEvent; task: Task }>();
  dragEnd = output<void>();
  touchStart = output<TaskTouchStartPayload>();
  touchMove = output<TouchEvent>();
  touchEnd = output<TouchEvent>();
  touchCancel = output<TouchEvent>();
  openLinkedTask = output<{ taskId: string; event: Event }>();
  
  protected taskAdapter = inject(TaskOperationAdapterService);
  protected uiState = inject(UiStateService);
  protected projectState = inject(ProjectStateService);
  protected parkingService = inject(ParkingService);
  protected dockEngine = inject(DockEngineService);
  protected reminderService = inject(SimpleReminderService);
  protected toast = inject(ToastService);
  protected userSession = inject(UserSessionService);
  private cdr = inject(ChangeDetectorRef);

  protected editingTaskId = signal<string | null>(null);
  protected isEditMode = signal(false);
  protected localTitle = signal('');
  protected localContent = signal('');
  protected reminderMenuTaskId = signal<string | null>(null);
  private previousUnassignedTaskCount: number | null = null;
  protected readonly reminderPresets = [
    { label: '5m', minutes: 5 },
    { label: '30m', minutes: 30 },
    { label: '2h', minutes: 120 },
  ] as const;

  constructor() {
    effect(() => {
      if (!this.uiState.isTextSidebarVisible()) {
        this.cancelEdit();
      }
    });

    effect(() => {
      if (this.uiState.isTextSidebarVisible()) {
        this.cdr.markForCheck();
      }
    });

    // 没有待分配任务时自动折叠，减少移动端空白区域
    effect(() => {
      const taskCount = this.projectState.unassignedTasks().length;
      const previousTaskCount = this.previousUnassignedTaskCount;
      this.previousUnassignedTaskCount = taskCount;

      if (taskCount === 0) {
        this.uiState.isTextUnassignedOpen.set(false);
      } else if (previousTaskCount === 0) {
        this.uiState.isTextUnassignedOpen.set(true);
      }
    });
  }

  ngOnDestroy(): void {
    this.cancelEdit();
  }

  private guardHintOnlyMutation(actionLabel: string): boolean {
    if (!this.userSession.isHintOnlyStartupPlaceholderVisible()) {
      return false;
    }

    this.toast.info('会话确认中', `${actionLabel}暂不可用，owner 确认完成前保持只读`);
    return true;
  }

  private beginTaskEdit(task: Task): boolean {
    if (this.guardHintOnlyMutation('编辑任务')) {
      return false;
    }

    this.editingTaskId.set(task.id);
    this.isEditMode.set(true);
    this.localTitle.set(task.title || '');
    this.localContent.set(task.content || '');
    return true;
  }

  /**
   * TextViewComponent 调用的公开方法
   * 设置当前选中的编辑任务
   */
  public async setEditingTask(taskId: string, isEdit: boolean): Promise<void> {
    this.editingTaskId.set(taskId);
    this.isEditMode.set(isEdit);
    this.syncLocalState(taskId);
    this.cdr.markForCheck();
  }

  /**
   * TextViewComponent 调用的公开方法
   * 退出编辑态并重置为预览折叠
   */
  public resetEditState(): void {
    this.cancelEdit();
    this.cdr.markForCheck();
  }

  protected onTaskClick(task: Task): void {
    // 【修复】区分点击源：卡片外框(三段式切换) vs 内容区域(直接编辑)
    // - 点击卡片外框按钮：展开 -> 折叠 -> 展开
    // - 点击内容区域：直接进入编辑模式（符合编辑直觉）
    if (this.editingTaskId() === task.id) {
      if (this.isEditMode()) {
        this.isEditMode.set(false); // 编辑 -> 预览
      } else {
        this.cancelEdit(); // 预览 -> 折叠
      }
    } else {
      this.editingTaskId.set(task.id);
      this.isEditMode.set(false); // 默认进入预览态
      this.syncLocalState(task.id);
    }
    this.taskClick.emit(task);
  }

  /**
   * 【新增】处理普通展示模式卡片的点击
   * 点击卡片显示体验：展开卡片查看内容
   */
  protected onTaskCardClick(task: Task): void {
    // 如果没展开过，展开显示预览
    // 如果已经展开过，再次点击则进行下一步操作
    if (this.editingTaskId() === task.id) {
      // 再次点击已展开的卡片：进入编辑模式（而不是折叠）
      this.beginTaskEdit(task);
    } else {
      // 首次展开：显示预览
      this.editingTaskId.set(task.id);
      this.isEditMode.set(false);
      this.syncLocalState(task.id);
    }
  }

  protected enterEdit(task: Task): void {
    this.beginTaskEdit(task);
  }

  /**
   * 内容预览区域点击处理
   * 点击待办 checkbox 时切换完成状态；点击其他区域进入编辑模式
   */
  protected onContentPreviewClick(event: MouseEvent, task: Task): void {
    const linkTarget = handleMarkdownLinkAction(event, this.toast);
    if (linkTarget) {
      // task 类型链接：跳转到关联任务
      if (linkTarget.kind === 'task' && linkTarget.taskId) {
        this.openLinkedTask.emit({ taskId: linkTarget.taskId, event });
      }
      return;
    }

    // false = 链接已检测到且已内部消化（blocked/internal/local/external）
    if (linkTarget === false) {
      return;
    }

    // null = 非链接点击，继续处理 todo checkbox / 进入编辑模式
    event.stopPropagation();
    const todoIndex = getTodoIndexFromClick(event);
    if (todoIndex !== null) {
      if (this.guardHintOnlyMutation('编辑任务')) {
        return;
      }

      // 点击了待办 checkbox，切换状态
      const newContent = toggleMarkdownTodo(task.content || '', todoIndex);
      this.taskAdapter.updateTaskContent(task.id, newContent);
      // 强制标记组件需要重新检测，确保 OnPush 模式下 UI 刷新
      this.cdr.markForCheck();
    } else {
      // 点击非 checkbox 区域，进入编辑模式
      this.enterEdit(task);
    }
  }

  /**
   * 【修复】标题输入框失焦处理 - 防止在编辑过程中意外保存
   * 只有当用户确实要结束编辑时（点击保存/取消或按 Escape）才保存
   * title 输入框之间的 tab/焦点切换不应触发保存
   */
  protected onTitleBlur(event: FocusEvent, task: Task): void {
    // 检查焦点是否移动到同一编辑框内的其他元素
    const relatedTarget = event.relatedTarget as HTMLElement;
    const editContainer = (event.target as HTMLElement).closest('[data-unassigned-task]');
    
    // 如果焦点仍在编辑容器内（比如移到 textarea），不保存
    if (relatedTarget && editContainer?.contains(relatedTarget)) {
      return;
    }
    
    // 焦点离开了编辑框容器，才进行保存
    this.saveTask(task);
  }

  protected cancelEdit(): void {
    this.editingTaskId.set(null);
    this.isEditMode.set(false);
    this.localTitle.set('');
    this.localContent.set('');
  }

  protected saveTask(task: Task): void {
    if (this.guardHintOnlyMutation('编辑任务')) {
      return;
    }

    const persisted = this.persistTaskDraft(task, { preserveExistingTitleWhenBlank: false });
    if (!persisted) {
      this.cancelEdit();
      return;
    }

    // 保存后默认折叠为最小块，方便继续浏览
    this.cancelEdit();
    this.cdr.markForCheck();
  }

  protected parkTaskNow(task: Task): void {
    if (this.guardHintOnlyMutation('停泊任务')) {
      return;
    }

    if (task.parkingMeta?.state === 'parked') return;

    // 停泊前先落盘当前编辑内容，避免用户点“停泊”丢掉刚输入的标题/正文。
    if (this.editingTaskId() === task.id && this.isEditMode()) {
      this.persistTaskDraft(task, { preserveExistingTitleWhenBlank: true });
    }

    this.parkingService.parkTask(task.id);
    if (PARKING_CONFIG.DOCK_PARK_BUTTON_SYNC_MODE === 'on') {
      this.dockEngine.dockTask(task.id, undefined, {
        sourceSection: 'text',
        zoneSource: 'auto',
      });
    }

    this.reminderMenuTaskId.set(null);
    this.cancelEdit();
    this.cdr.markForCheck();
  }

  protected async deleteTask(taskId: string): Promise<void> {
    if (this.guardHintOnlyMutation('删除任务')) {
      return;
    }

    await this.taskAdapter.deleteTask(taskId);
    if (this.editingTaskId() === taskId) {
      this.cancelEdit();
    }
  }



  protected onCreateClick(event: Event): void {
    event.stopPropagation();
    this.uiState.isTextUnassignedOpen.set(true);
    this.createUnassigned.emit();
  }

  protected handleDragStart(event: DragEvent, task: Task): void {
    this.dragStart.emit({ event, task });
  }

  protected handleDragEnd(): void {
    this.dragEnd.emit();
  }

  protected handleTouchStart(event: TouchEvent, task: Task): void {
    this.touchStart.emit({ event, task });
  }

  protected handleTouchMove(event: TouchEvent): void {
    this.touchMove.emit(event);
  }

  protected handleTouchEnd(event: TouchEvent): void {
    this.touchEnd.emit(event);
  }

  protected handleTouchCancel(event: TouchEvent): void {
    this.touchCancel.emit(event);
  }

  protected toggleReminderMenu(taskId: string): void {
    this.reminderMenuTaskId.update(current => (current === taskId ? null : taskId));
  }

  protected closeReminderMenu(): void {
    this.reminderMenuTaskId.set(null);
  }

  protected setReminderPreset(taskId: string, minutes: number): void {
    if (this.guardHintOnlyMutation('设置提醒')) {
      return;
    }

    const reminderAt = new Date(Date.now() + minutes * 60_000).toISOString();
    this.reminderService.setReminder(taskId, reminderAt);
    this.reminderMenuTaskId.set(null);
    this.cdr.markForCheck();
  }

  protected clearReminder(taskId: string): void {
    if (this.guardHintOnlyMutation('取消提醒')) {
      return;
    }

    this.reminderService.cancelReminder(taskId);
    this.reminderMenuTaskId.set(null);
    this.cdr.markForCheck();
  }

  private persistTaskDraft(
    task: Task,
    options?: { preserveExistingTitleWhenBlank?: boolean },
  ): boolean {
    const title = this.localTitle().trim();
    const content = this.localContent();

    if (!title && !options?.preserveExistingTitleWhenBlank) {
      return false;
    }

    const nextTitle = title || task.title || '';
    const titleChanged = !!nextTitle && nextTitle !== task.title;
    const contentChanged = content !== (task.content || '');

    if (titleChanged) {
      this.taskAdapter.updateTaskTitle(task.id, nextTitle);
    }
    if (contentChanged) {
      this.taskAdapter.updateTaskContent(task.id, content);
    }

    return !!nextTitle;
  }

  /**
   * 待分配区域内的拖放事件处理
   * 支持待分配块之间的重新挂载（改变父子关系）
   */
  protected handleDragOverUnassigned(event: DragEvent): void {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
  }

  protected handleDragLeaveUnassigned(_event: DragEvent): void {
    // 可选：添加视觉反馈
  }

  protected handleDropUnassigned(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();

    const payload = event.dataTransfer ? readTaskDragPayload(event.dataTransfer) : null;
    const fallbackData = event.dataTransfer?.getData("application/json") || event.dataTransfer?.getData("text");
    try {
      const draggedTask = payload
        ? this.projectState.getTask(payload.taskId)
        : fallbackData ? (JSON.parse(fallbackData) as Task) : null;
      
      // 只处理待分配块之间的拖放（都是 stage === null）
      if (draggedTask?.id && draggedTask.stage === null) {
        // 获取所有待分配任务（排除拖动的任务本身）
        const unassignedTasks = this.projectState.unassignedTasks()
          .filter(t => t.id !== draggedTask.id);
        
        if (unassignedTasks.length > 0) {
          // 选择第一个待分配块作为新的父块
          // 实际应用中可以根据鼠标位置选择最近的块
          const targetTask = unassignedTasks[0];
          
          // 使用适配器执行重新挂载操作
          const result = this.taskAdapter.moveTaskToStage(draggedTask.id, null, undefined, targetTask.id);
          
          if (!result.ok) {
            // 操作失败，但不需要显示错误消息（已由适配器处理）
            return;
          }
          
          // 操作成功，emit 事件通知父组件更新视图
          this.dragStart.emit({ event: new DragEvent('drop'), task: draggedTask });
        }
      }
    } catch {
      if (!fallbackData) return;
      // 数据解析失败，尝试按纯任务 ID 解析
      const draggedTask = this.projectState.getTask(fallbackData);
      if (!draggedTask || draggedTask.stage !== null) return;
      const unassignedTasks = this.projectState.unassignedTasks().filter(t => t.id !== draggedTask.id);
      if (unassignedTasks.length === 0) return;
      const targetTask = unassignedTasks[0];
      const result = this.taskAdapter.moveTaskToStage(draggedTask.id, null, undefined, targetTask.id);
      if (result.ok) {
        this.dragStart.emit({ event: new DragEvent('drop'), task: draggedTask });
      }
    }
  }

  private syncLocalState(taskId: string): void {
    const target = this.projectState.getTask(taskId);
    this.localTitle.set(target?.title || '');
    this.localContent.set(target?.content || '');
  }
}
