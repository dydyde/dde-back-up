import { Component, inject, input, output, signal, computed, ChangeDetectionStrategy, ChangeDetectorRef, ElementRef, HostListener, effect, OnDestroy, viewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
import { ChangeTrackerService } from '../../../../services/change-tracker.service';
import { UiStateService } from '../../../../services/ui-state.service';
import { ProjectStateService, TaskConnectionInfo } from '../../../../services/project-state.service';
import { UndoService, type UndoAppliedReplay } from '../../../../services/undo.service';
import { AttachmentService } from '../../../../services/attachment.service';
import { ToastService } from '../../../../services/toast.service';
import { Task, Attachment } from '../../../../models';
import { SafeMarkdownPipe } from '../../../shared/pipes/safe-markdown.pipe';
import { TextTaskConnectionsComponent } from './text-task-connections.component';
import { toggleMarkdownTodo, getTodoIndexFromClick, handleMarkdownLinkAction } from '../../../../utils/markdown';
import { clearActiveTextSelection, hasActiveTextSelection, isInteractiveSelectionTarget } from '../../../../utils/text-selection';
import { KnowledgeAnchorComponent } from '../../../shared/components/knowledge-anchor/knowledge-anchor.component';

/**
 * 任务编辑器组件（展开态）
 * 显示任务的完整编辑界面，包括标题、内容、待办、附件和操作按钮
 *
 * 预览模式逻辑：
 * - 默认进入编辑状态时为预览模式
 * - 点击预览区域进入编辑模式
 * - 点击空白区域（组件外部）自动切换回预览模式
 * - 预览模式下隐藏底部操作按钮（添加同级、添加下级、删除）
 */
@Component({
  selector: 'app-text-task-editor',
  standalone: true,
  imports: [CommonModule, SafeMarkdownPipe, TextTaskConnectionsComponent, KnowledgeAnchorComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="animate-collapse-open"
         (click)="$event.stopPropagation()"
         [ngClass]="{'mt-2 flex gap-3': !isMobile(), 'mt-1.5': isMobile()}">

      <!-- 主编辑区域-->
      <div [ngClass]="{'flex-1 min-w-0 space-y-2': !isMobile(), 'space-y-1.5': isMobile()}">

        @if (isPreview()) {
          <button
            type="button"
            data-testid="task-title-preview"
            data-title-preview-trigger
            (click)="enterEditMode('title', $event); $event.stopPropagation()"
            class="block w-full rounded-md text-left font-medium text-retro-dark dark:text-stone-200 leading-snug transition-colors hover:bg-stone-100/70 dark:hover:bg-stone-800/60 line-clamp-2"
            [ngClass]="{'text-sm px-1 py-0.5': !isMobile(), 'text-xs px-0.5 py-0.5': isMobile()}"
            title="点击编辑标题">
            {{ previewTitle() }}
          </button>
        } @else {
          <input
            #titleInput
            data-testid="task-title-input"
            data-title-input
            type="text"
            [value]="localTitle()"
            (input)="onTitleInput(titleInput.value)"
            (focus)="onInputFocus('title')"
            (blur)="onInputBlur('title')"
            (compositionstart)="onCompositionStart('title')"
            (compositionend)="onCompositionEnd('title', titleInput.value)"
            (mousedown)="isSelecting = true"
            (mouseup)="isSelecting = false"
            spellcheck="false"
            class="w-full font-medium text-retro-dark dark:text-stone-200 border rounded-lg focus:ring-1 focus:ring-stone-400 dark:focus:ring-stone-500 focus:border-stone-400 dark:focus:border-stone-500 outline-none touch-manipulation transition-colors"
            [ngClass]="{
              'text-sm p-2': !isMobile(),
              'text-xs p-1.5': isMobile(),
              'bg-white dark:bg-stone-700 border-stone-200 dark:border-stone-600': !isPreview()
            }"
            placeholder="任务名称...">
        }

        <!-- 内容编辑/预览 -->
        <div class="relative">
          <!-- 预览/编辑切换按钮 -->
          <div class="absolute top-1.5 right-1.5 z-10 flex gap-1">
            <button
              (click)="onPreviewToggleButtonClick($event)"
              class="px-1.5 py-0.5 text-[9px] rounded transition-[background-color,color,opacity] opacity-70 hover:opacity-100"
              [ngClass]="{
                'bg-indigo-500 dark:bg-indigo-600 text-white': isPreview(),
                'bg-stone-200 dark:bg-stone-600 text-stone-500 dark:text-stone-300 hover:bg-stone-300 dark:hover:bg-stone-500': !isPreview()
              }"
              title="切换预览/编辑">
              {{ isPreview() ? '编辑' : '预览' }}
            </button>
          </div>

          @if (isPreview()) {
            <!-- Markdown 预览 - 点击切换到编辑模式，点击 checkbox 切换待办状态 -->
            @if (hasPreviewContent()) {
              <div
                data-testid="task-content"
                (click)="onPreviewClick($event)"
                class="w-full rounded-lg border border-transparent overflow-hidden markdown-preview markdown-preview-adaptive cursor-pointer transition-colors hover:bg-stone-50/70 dark:hover:bg-stone-800/50"
                [ngClass]="{'max-h-20 px-1 py-0.5 text-xs': !isMobile(), 'max-h-16 px-0.5 py-0.5 text-[11px]': isMobile()}"
                [innerHTML]="localContent() | safeMarkdown"
                title="点击编辑">
              </div>
            } @else {
              <button
                type="button"
                data-testid="task-content-empty"
                (click)="enterEditMode('content', $event); $event.stopPropagation()"
                class="w-full min-h-[1.25rem] rounded-md text-left text-stone-400 dark:text-stone-500 italic transition-colors hover:bg-stone-50/70 dark:hover:bg-stone-800/50"
                [ngClass]="{'px-1 py-0.5 text-xs': !isMobile(), 'px-0.5 py-0.5 text-[11px]': isMobile()}"
                title="点击输入内容">
                点击输入内容...
              </button>
            }
          } @else {
            <!-- Markdown 编辑 -->
            <textarea
              #contentInput
              data-testid="task-content-editor"
              [value]="localContent()"
              (input)="onContentInput(contentInput.value)"
              (focus)="onInputFocus('content')"
              (blur)="onInputBlur('content')"
              (compositionstart)="onCompositionStart('content')"
              (compositionend)="onCompositionEnd('content', contentInput.value)"
              (mousedown)="isSelecting = true"
              (mouseup)="isSelecting = false"
              spellcheck="false"
              class="w-full border border-stone-200 dark:border-stone-600 rounded-lg focus:ring-1 focus:ring-stone-400 dark:focus:ring-stone-500 focus:border-stone-400 dark:focus:border-stone-500 outline-none font-mono text-stone-600 dark:text-stone-400 bg-white dark:bg-stone-700 resize-none touch-manipulation"
              [ngClass]="{'h-24 text-xs p-2 pr-14': !isMobile(), 'h-28 text-[11px] p-2 pr-14': isMobile()}"
              placeholder="输入 Markdown 内容..."></textarea>
          }
        </div>

        <app-knowledge-anchor
          [taskId]="task().id"
          [isMobile]="isMobile()"
          [editable]="!isPreview()"
          [manageable]="isPreview()"
          [compact]="isPreview()">
        </app-knowledge-anchor>

        <!-- 快速待办输入 - 仅在编辑模式下显示 -->
        @if (!isPreview()) {
          <div class="flex items-center gap-1 bg-retro-rust/5 dark:bg-retro-rust/10 border border-retro-rust/20 dark:border-retro-rust/30 rounded-lg overflow-hidden"
               [ngClass]="{'p-1': !isMobile(), 'p-0.5': isMobile()}">
            <span class="text-retro-rust flex-shrink-0"
                  [ngClass]="{'text-xs pl-2': !isMobile(), 'text-[10px] pl-1.5': isMobile()}">☰</span>
            <input
              #quickTodoInput
              type="text"
              (keydown.enter)="addQuickTodo(quickTodoInput)"
              (focus)="onInputFocus('todo')"
              (blur)="onInputBlur('todo')"
              (mousedown)="isSelecting = true"
              (mouseup)="isSelecting = false"
              spellcheck="false"
              class="flex-1 bg-transparent border-none outline-none text-stone-600 dark:text-stone-400 placeholder-stone-400 dark:placeholder-stone-500"
              [ngClass]="{'text-xs py-1.5 px-2': !isMobile(), 'text-[11px] py-1 px-1.5': isMobile()}"
              placeholder="输入待办内容，按回车添加...">
            <button
              (click)="addQuickTodo(quickTodoInput)"
              class="flex-shrink-0 bg-retro-rust/10 hover:bg-retro-rust text-retro-rust hover:text-white rounded transition-colors flex items-center justify-center"
              [ngClass]="{'p-1.5 mr-0.5': !isMobile(), 'p-1 mr-0.5': isMobile()}"
              title="添加待办">
              <svg [ngClass]="{'w-3.5 h-3.5': !isMobile(), 'w-3 h-3': isMobile()}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <line x1="12" y1="5" x2="12" y2="19"/>
                <line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
            </button>
          </div>
        }

        @if (!isPreview()) {
          <div class="grid grid-cols-3 gap-2">
            <input
              type="number"
              #expectedMinutesInput
              min="1"
              [value]="localExpectedMinutes()"
              (input)="onExpectedMinutesChange(expectedMinutesInput.value)"
              class="w-full text-[11px] px-2 py-1.5 rounded border border-stone-200 dark:border-stone-600 bg-white dark:bg-stone-700 text-stone-700 dark:text-stone-300"
              placeholder="预计(min)">
            <select
              #cognitiveLoadSelect
              [value]="localCognitiveLoad()"
              (change)="onCognitiveLoadChange(cognitiveLoadSelect.value)"
              class="w-full text-[11px] px-2 py-1.5 rounded border border-stone-200 dark:border-stone-600 bg-white dark:bg-stone-700 text-stone-700 dark:text-stone-300">
              <option value="">负荷未设</option>
              <option value="low">低负荷</option>
              <option value="high">高负荷</option>
            </select>
            <input
              type="number"
              #waitMinutesInput
              min="1"
              [value]="localWaitMinutes()"
              (input)="onWaitMinutesChange(waitMinutesInput.value)"
              class="w-full text-[11px] px-2 py-1.5 rounded border border-stone-200 dark:border-stone-600 bg-white dark:bg-stone-700 text-stone-700 dark:text-stone-300"
              placeholder="等待(min)">
          </div>
        }

        <!-- 桌面端：附件管理独立显示 - 暂时隐藏 -->
        <!-- @if (!isMobile() && userId() && projectId()) {
          <app-attachment-manager
            [userId]="userId()"
            [projectId]="projectId()"
            [taskId]="task().id"
            [currentAttachments]="task().attachments"
            [compact]="false"
            (attachmentsChange)="onAttachmentsChange($event)"
            (error)="attachmentError.emit($event)">
          </app-attachment-manager>
        } -->

        <!-- 操作按钮 - 仅在编辑模式下显示 -->
        @if (!isPreview()) {
          <div class="flex flex-wrap border-t border-stone-100 dark:border-stone-700"
               [ngClass]="{'gap-2 pt-2': !isMobile(), 'gap-1.5 pt-1.5': isMobile()}">
            <button
              (click)="addSibling.emit()"
              class="flex-1 bg-retro-teal/10 hover:bg-retro-teal text-retro-teal hover:text-white border border-retro-teal/30 font-medium rounded-md flex items-center justify-center transition-colors"
              [ngClass]="{'px-2 py-1 text-xs gap-1': !isMobile(), 'px-1.5 py-0.5 text-[10px] gap-0.5': isMobile()}"
              title="添加同级">
              <svg [ngClass]="{'w-3 h-3': !isMobile(), 'w-2.5 h-2.5': isMobile()}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="12" y1="5" x2="12" y2="19"/>
                <line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
              同级
            </button>
            <button
              (click)="addChild.emit()"
              data-testid="add-child-task-btn"
              class="flex-1 bg-retro-rust/10 hover:bg-retro-rust text-retro-rust hover:text-white border border-retro-rust/30 font-medium rounded-md flex items-center justify-center transition-colors"
              [ngClass]="{'px-2 py-1 text-xs gap-1': !isMobile(), 'px-1.5 py-0.5 text-[10px] gap-0.5': isMobile()}"
              title="添加下级">
              <svg [ngClass]="{'w-3 h-3': !isMobile(), 'w-2.5 h-2.5': isMobile()}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="15 10 20 15 15 20"/>
                <path d="M4 4v7a4 4 0 0 0 4 4h12"/>
              </svg>
              下级
            </button>
            <!-- 移动端：附件按钮放在同一行 - 暂时隐藏 -->
            <!-- @if (isMobile() && userId() && projectId()) {
              <label
                class="flex-1 cursor-pointer text-[10px] px-1.5 py-0.5 bg-stone-50 hover:bg-stone-100 text-stone-500 hover:text-stone-700 rounded-md border border-stone-200 transition-colors flex items-center justify-center gap-0.5"
                [class.opacity-50]="isUploading()"
                [class.pointer-events-none]="isUploading()">
                <svg class="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                </svg>
                @if (isUploading()) {
                  上传                } @else {
                  附件
                }
                @if (task().attachments && task().attachments.length > 0) {
                  <span class="text-[8px] bg-indigo-100 text-indigo-600 px-0.5 rounded">{{ task().attachments.length }}</span>
                }
                <input
                  type="file"
                  class="hidden"
                  multiple
                  accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.txt,.md"
                  (change)="onMobileFileSelect($event)"
                  [disabled]="isUploading()">
              </label>
            } -->
            <button
              (click)="parkTask.emit()"
              class="flex-1 font-medium rounded-md flex items-center justify-center transition-colors duration-200"
              [ngClass]="{
                'px-2 py-1 text-xs gap-1': !isMobile(), 
                'px-1.5 py-0.5 text-[10px] gap-0.5': isMobile(),
                'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 border border-amber-300 dark:border-amber-600': task().parkingMeta?.state === 'parked',
                'bg-amber-50 dark:bg-amber-900/20 hover:bg-amber-500 text-amber-600 dark:text-amber-400 hover:text-white border border-amber-200 dark:border-amber-700 hover:border-amber-500': task().parkingMeta?.state !== 'parked'
              }"
              [title]="task().parkingMeta?.state === 'parked' ? '任务已在停泊坞中' : '停泊任务，稍后处理'">
              <svg [ngClass]="{'w-3 h-3': !isMobile(), 'w-2.5 h-2.5': isMobile()}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
                <polyline points="17 21 17 13 7 13 7 21"/>
              </svg>
              {{ task().parkingMeta?.state === 'parked' ? '已停泊' : '停泊' }}
            </button>
            <button
              (click)="deleteTask.emit()"
              data-testid="delete-task-btn"
              class="bg-stone-100 dark:bg-stone-700 hover:bg-red-500 text-stone-400 dark:text-stone-500 hover:text-white border border-stone-200 dark:border-stone-600 hover:border-red-500 font-medium rounded-md flex items-center justify-center transition-colors"
              [ngClass]="{'px-2 py-1 text-xs': !isMobile(), 'px-1.5 py-0.5 text-[10px]': isMobile()}"
              title="删除任务">
              <svg [ngClass]="{'w-3 h-3': !isMobile(), 'w-2.5 h-2.5': isMobile()}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </svg>
            </button>
          </div>

          <!-- 移动端：附件列表折叠区（如果有附件）- 暂时隐藏 -->
          <!-- @if (isMobile() && task().attachments && task().attachments.length > 0) {
            <div class="mt-1.5">
              <button
                (click)="toggleAttachmentList()"
                class="w-full flex items-center justify-between px-2 py-1 bg-stone-50 hover:bg-stone-100 rounded text-[10px] text-stone-500 transition-colors">
                <span class="flex items-center gap-1">
                  <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                  </svg>
                  {{ task().attachments.length }} 个附件                </span>
                <svg
                  class="w-3 h-3 transition-transform"
                  [class.rotate-180]="showAttachmentList()"
                  fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              @if (showAttachmentList()) {
                <div class="mt-1 p-1.5 bg-stone-50/50 dark:bg-stone-800/50 rounded border border-stone-100 dark:border-stone-700 space-y-1 animate-collapse-open">
                  @for (attachment of task().attachments; track attachment.id) {
                    <div
                      class="group flex items-center gap-1.5 px-1.5 py-1 bg-white dark:bg-stone-700 hover:bg-stone-50 dark:hover:bg-stone-600 rounded text-[10px] text-stone-600 dark:text-stone-300 border border-stone-100 dark:border-stone-600 transition-colors"
                      [class.cursor-pointer]="attachment.type === 'image'"
                      (click)="attachment.type === 'image' && previewImage(attachment)">
                      @if (attachment.type === 'image' && attachment.thumbnailUrl) {
                        <img [src]="attachment.thumbnailUrl" [alt]="attachment.name" class="w-5 h-5 object-cover rounded">
                      } @else {
                        <span class="w-5 h-5 flex items-center justify-center text-[8px] text-stone-400 dark:text-stone-500 uppercase bg-stone-100 dark:bg-stone-600 rounded">{{ getFileExtension(attachment.name) }}</span>
                      }
                      <span class="flex-1 truncate">{{ attachment.name }}</span>
                      <span class="text-[9px] text-stone-400 dark:text-stone-500">{{ formatFileSize(attachment.size) }}</span>
                      <button
                        (click)="deleteAttachment(attachment, $event)"
                        class="text-stone-400 hover:text-red-500 transition-colors p-0.5"
                        title="删除">
                        <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                          <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  }
                </div>
              }
            </div>
          } -->
        }
      </div>

      <app-text-task-connections
        [connections]="connections()"
        [isMobile]="isMobile()"
        (openTask)="openLinkedTask.emit($event)">
      </app-text-task-connections>
    </div>
  `,
  styles: [`
    .animate-collapse-open {
      animation: collapseOpen 0.15s ease-out;
    }
    @keyframes collapseOpen {
      from { opacity: 0; transform: translateY(-4px); }
      to { opacity: 1; transform: translateY(0); }
    }
  `]
})
export class TextTaskEditorComponent implements OnDestroy {
  private readonly taskOpsAdapter = inject(TaskOperationAdapterService);
  private readonly changeTracker = inject(ChangeTrackerService);
  private readonly uiState = inject(UiStateService);
  private readonly projectState = inject(ProjectStateService);
  private readonly undoService = inject(UndoService);
  private readonly elementRef = inject(ElementRef);
  private readonly attachmentService = inject(AttachmentService);
  private readonly toast = inject(ToastService);
  private readonly cdr = inject(ChangeDetectorRef);

  readonly task = input.required<Task>();
  readonly isMobile = input(false);
  readonly userId = input<string | null>(null);
  readonly projectId = input<string | null>(null);
  readonly connections = input<TaskConnectionInfo | null>(null);
  readonly initialPreview = input(true);

  readonly addSibling = output<void>();
  readonly addChild = output<void>();
  readonly deleteTask = output<void>();
  readonly parkTask = output<void>();
  readonly attachmentError = output<string>();
  readonly openLinkedTask = output<{ taskId: string; event: Event }>();
  readonly previewModeChange = output<boolean>();

  readonly isPreview = signal(true);
  readonly showAttachmentList = signal(false);
  readonly isUploading = signal(false);

  // ========== DOM 引用 ==========
  /** 标题输入框引用 */
  private readonly titleInputRef = viewChild<ElementRef<HTMLInputElement>>('titleInput');
  /** 内容输入框引用 */
  private readonly contentInputRef = viewChild<ElementRef<HTMLTextAreaElement>>('contentInput');

  // ========== Split-Brain 本地状态==========
  /** 本地标题（与 Store 解耦，仅在非聚焦时同步）*/
  protected readonly localTitle = signal('');
  /** 本地内容（与 Store 解耦，仅在非聚焦时同步）*/
  protected readonly localContent = signal('');
  protected readonly previewTitle = computed(() => {
    const title = this.localTitle().trim();
    return title || 'Untitled task';
  });
  protected readonly hasPreviewContent = computed(() => this.localContent().trim().length > 0);
  protected readonly localExpectedMinutes = signal('');
  protected readonly localWaitMinutes = signal('');
  protected readonly localCognitiveLoad = signal<'high' | 'low' | ''>('');
  /** 标题输入框是否聚焦 */
  private isTitleFocused = false;
  /** 内容输入框是否聚焦 */
  private isContentFocused = false;
  /** IME 输入状态追踪 */
  private readonly composingState: Record<'title' | 'content', boolean> = {
    title: false,
    content: false,
  };
  /** 解锁延迟定时器*/
  private unlockTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private lastConsumedReplay: UndoAppliedReplay | null = this.undoService.appliedReplay();

  /** 标记是否正在进行文本选择操作 */
  isSelecting = false;

  private focusRequestTimer: ReturnType<typeof setTimeout> | null = null;
  private suppressNextDocumentClick = false;
  private clearDocumentClickGuardTimer: ReturnType<typeof setTimeout> | null = null;
  private skipNextEditorAutoSelect = false;

  /** 最大附件数量*/
  private readonly maxAttachments = 5;
  /** 最大文件大小 10MB */
  private readonly maxFileSize = 10 * 1024 * 1024;

  constructor() {
    // Split-Brain 核心逻辑：仅在输入框非聚焦时从 Store 同步到本地
    // 这样可避免用户输入时被远程更新覆盖
    try {
      effect(() => {
        const task = this.task();
        if (task) {
          // 仅当标题输入框未聚焦时才同步标题
          if (!this.isTitleFocused) {
            this.localTitle.set(task.title || '');
          }
          // 仅当内容输入框未聚焦时才同步内容
          if (!this.isContentFocused) {
            this.localContent.set(task.content || '');
          }
          // M-10 fix: 规划字段不受 content 焦点状态限制，始终同步
          this.localExpectedMinutes.set(task.expected_minutes == null ? '' : String(task.expected_minutes));
          this.localWaitMinutes.set(task.wait_minutes == null ? '' : String(task.wait_minutes));
          this.localCognitiveLoad.set(task.cognitive_load ?? '');
        }
      });

      effect(() => {
        const replay = this.undoService.appliedReplay();
        if (!replay || replay === this.lastConsumedReplay) {
          return;
        }

        this.lastConsumedReplay = replay;

        const task = this.task();
        if (!task) {
          return;
        }

        const changedFields = replay.taskFieldChanges[task.id];
        if (!changedFields) {
          return;
        }

        if (changedFields.includes('title')) {
          this.localTitle.set(task.title || '');
        }
        if (changedFields.includes('content')) {
          this.localContent.set(task.content || '');
        }
      });
    } catch {
      // 【防御】SW chunk 不一致可能导致 DestroyRef/injection context 丢失
      // 回退：等待 ngOnInit/effect 在可用的输入上下文中完成初始化。
    }
  }

  ngOnDestroy(): void {
    // 【关键】组件销毁前，确保当前编辑的内容被保存
    // 这是修复手机端点击关联块编辑后无法自动保存的核心逻辑
    this.persistCurrentEdits();
    this.clearFocusRequestTimer();
    this.clearDocumentClickGuard();

    // 清理所有未完成的解锁定时器
    for (const timer of this.unlockTimers.values()) {
      clearTimeout(timer);
    }
    this.unlockTimers.clear();
  }

  /**
   * 从 DOM 同步最新值并持久化
   * 确保 IME 输入和快速关闭场景下数据不丢失
   */
  private persistCurrentEdits(): void {
    const task = this.task?.();
    if (!task) return;

    // 从 DOM 直接读取最新值（绕过 Angular 数据绑定的延迟）
    const titleEl = this.titleInputRef()?.nativeElement;
    const contentEl = this.contentInputRef()?.nativeElement;

    const currentTitle = titleEl?.value ?? this.localTitle();
    const currentContent = contentEl?.value ?? this.localContent();

    // 与当前 Store 中的任务比较，只有真正有变化才保存
    if (currentTitle !== task.title) {
      this.taskOpsAdapter.updateTaskTitle(task.id, currentTitle);
    }
    if (currentContent !== task.content) {
      this.taskOpsAdapter.updateTaskContent(task.id, currentContent);
    }
  }

  // ========== Split-Brain 锁定辅助方法 ==========

  /** 锁定任务字段（防止远程更新覆盖本地编辑） */
  private lockTaskFields(taskId: string, fields: string[]): void {
    const projectId = this.projectId() || this.projectState.activeProjectId();
    if (!projectId) return;
    for (const field of fields) {
      this.changeTracker.lockTaskField(taskId, projectId, field);
    }
  }

  /** 解锁任务字段 */
  private unlockTaskFields(taskId: string, fields: string[]): void {
    const projectId = this.projectId() || this.projectState.activeProjectId();
    if (!projectId) return;
    for (const field of fields) {
      this.changeTracker.unlockTaskField(taskId, projectId, field);
    }
  }

  /**
   * 监听 document 点击事件
   * 注意：任务卡片内的点击由 text-task-card 处理
   * 这里只处理点击到组件完全外部的情况（如页面其他区域）
   */
  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent) {
    if (this.suppressNextDocumentClick) {
      this.skipNextEditorAutoSelect = true;
      setTimeout(() => {
        this.skipNextEditorAutoSelect = false;
      }, 0);
      this.clearDocumentClickGuard();
      return;
    }

    const isInteractiveTarget = isInteractiveSelectionTarget(event.target);
    const clickedInside = this.isEventInsideEditor(event);
    const clickedInTaskCard = this.isEventInsideCurrentTaskCard(event);

    // 拖拽选择过程中不打断浏览器原生选区行为。
    if (this.isSelecting) return;

    if (hasActiveTextSelection()) {
      if (clickedInside) {
        return;
      }

      clearActiveTextSelection();
      if (!isInteractiveTarget) {
        return;
      }
    }

    // 如果已经是预览模式，无需处理
    if (this.isPreview()) return;

    // 如果点击在编辑器内部，不做任何处理（允许正常编辑与文本选择）
    if (clickedInside) return;

    if (!clickedInTaskCard) {
      // 点击完全在任务卡片外，切换到预览模式
      this.isPreview.set(true);
      this.previewModeChange.emit(true);
    }
    // 如果点击在任务卡片内但编辑器外（如卡片头部），由 text-task-card 处理
  }

  ngOnInit() {
    this.isPreview.set(this.initialPreview());
    this.localTitle.set(this.task().title || '');
    this.localContent.set(this.task().content || '');
    this.localExpectedMinutes.set(this.task().expected_minutes == null ? '' : String(this.task().expected_minutes));
    this.localWaitMinutes.set(this.task().wait_minutes == null ? '' : String(this.task().wait_minutes));
    this.localCognitiveLoad.set(this.task().cognitive_load ?? '');
  }

  togglePreview() {
    const newValue = !this.isPreview();
    this.isPreview.set(newValue);
    this.previewModeChange.emit(newValue);
    if (newValue) {
      this.clearFocusRequestTimer();
    }
  }

  enterEditMode(field: 'title' | 'content', triggerEvent?: Event) {
    if (this.isPreview()) {
      this.armOutsideClickGuard(triggerEvent);
      this.isPreview.set(false);
      this.previewModeChange.emit(false);
    }

    this.focusEditorField(field);
  }

  onPreviewToggleButtonClick(event: Event) {
    event.stopPropagation();
    if (this.isPreview()) {
      this.enterEditMode('content', event);
      return;
    }
    this.togglePreview();
  }

  /**
   * 外部调用：强制切换到预览模式
   */
  setPreviewMode() {
    if (!this.isPreview()) {
      this.isPreview.set(true);
      this.previewModeChange.emit(true);
      this.clearFocusRequestTimer();
    }
  }



  /**
   * 输入框聚焦处理（Split-Brain 模式核心）   * 1. 标记全局编辑状态   * 2. 锁定对应字段，防止远程更新覆盖
   * 3. 标记本地聚焦状态，阻止 Store->Local 同步
   */
  onInputFocus(field: 'title' | 'content' | 'todo') {
    this.uiState.markEditing();

    if (field === 'title') {
      this.isTitleFocused = true;
      // 清除可能存在的解锁定时器
      const existingTimer = this.unlockTimers.get('title');
      if (existingTimer) {
        clearTimeout(existingTimer);
        this.unlockTimers.delete('title');
      }
      this.lockTaskFields(this.task().id, ['title']);
    } else if (field === 'content') {
      this.isContentFocused = true;
      const existingTimer = this.unlockTimers.get('content');
      if (existingTimer) {
        clearTimeout(existingTimer);
        this.unlockTimers.delete('content');
      }
      this.lockTaskFields(this.task().id, ['content']);
    }
    // todo 字段不需要锁定（不会被远程更新覆盖）
  }

  /**
   * 输入框失焦处理（Split-Brain 模式核心）
   * 1. 从 DOM 读取最新值（确保 IME 输入的最终值）
   * 2. 提交本地内容到 Store
   * 3. 延迟后解锁字段（等待同步完成，防止回声覆盖）
   */
  onInputBlur(field: 'title' | 'content' | 'todo') {
    // 延迟清除选择标记
    setTimeout(() => {
      this.isSelecting = false;
    }, 100);

    if (field === 'title') {
      // 从 DOM 读取最新值（确保 IME 输入完成后的最终值）
      const titleEl = this.titleInputRef()?.nativeElement;
      const currentTitle = titleEl?.value ?? this.localTitle();
      this.localTitle.set(currentTitle);

      // 提交本地内容到 Store
      this.taskOpsAdapter.updateTaskTitle(this.task().id, currentTitle);

      const timer = setTimeout(() => {
        this.isTitleFocused = false;
        this.unlockTaskFields(this.task().id, ['title']);
        this.unlockTimers.delete('title');
      }, 10000);
      this.unlockTimers.set('title', timer);
    } else if (field === 'content') {
      // 从 DOM 读取最新值
      const contentEl = this.contentInputRef()?.nativeElement;
      const currentContent = contentEl?.value ?? this.localContent();
      this.localContent.set(currentContent);

      this.taskOpsAdapter.updateTaskContent(this.task().id, currentContent);

      const timer = setTimeout(() => {
        this.isContentFocused = false;
        this.unlockTaskFields(this.task().id, ['content']);
        this.unlockTimers.delete('content');
      }, 10000);
      this.unlockTimers.set('content', timer);
    }
  }

  /**
   * 标题输入处理
   * 仅更新本地状态，blur 时才提交到 Store
   */
  onTitleInput(value: string) {
    this.localTitle.set(value);
    this.taskOpsAdapter.updateTaskTitle(this.task().id, value);
  }

  /**
   * 内容输入处理
   * 仅更新本地状态，blur 时才提交到 Store
   */
  onContentInput(value: string) {
    this.localContent.set(value);
    this.taskOpsAdapter.updateTaskContent(this.task().id, value);
  }

  // ========== IME Composition 处理 ==========

  /**
   * IME 输入开始（如中文拼音输入）
   * 标记正在进行 composition，避免中间态被提交
   */
  onCompositionStart(field: 'title' | 'content'): void {
    this.composingState[field] = true;
  }

  /**
   * IME 输入完成
   * 立即同步最终值到本地状态并提交到 Store
   */
  onCompositionEnd(field: 'title' | 'content', value: string): void {
    this.composingState[field] = false;
    if (field === 'title') {
      this.localTitle.set(value);
      this.taskOpsAdapter.updateTaskTitle(this.task().id, value);
    } else if (field === 'content') {
      this.localContent.set(value);
      this.taskOpsAdapter.updateTaskContent(this.task().id, value);
    }
  }

  /**
   * 检查是否有任何字段正在 IME 输入中
   */
  private isComposing(): boolean {
    return this.composingState.title || this.composingState.content;
  }

  onExpectedMinutesChange(value: string): void {
    this.localExpectedMinutes.set(value);
    this.taskOpsAdapter.updateTaskExpectedMinutes(this.task().id, this.parseOptionalMinutes(value));
  }

  onWaitMinutesChange(value: string): void {
    this.localWaitMinutes.set(value);
    this.taskOpsAdapter.updateTaskWaitMinutes(this.task().id, this.parseOptionalMinutes(value));
  }

  onCognitiveLoadChange(value: string): void {
    const normalized = value === 'high' || value === 'low' ? value : null;
    this.localCognitiveLoad.set((normalized ?? '') as 'high' | 'low' | '');
    this.taskOpsAdapter.updateTaskCognitiveLoad(this.task().id, normalized);
  }

  /**
   * Markdown 预览区域点击处理
   * 点击待办 checkbox 时切换完成状态；点击其他区域进入编辑模式
   */
  onPreviewClick(event: MouseEvent) {
    if (this.handlePreviewLinkClick(event)) {
      return;
    }

    event.stopPropagation();
    const todoIndex = getTodoIndexFromClick(event);
    if (todoIndex !== null) {
      // 点击了待办 checkbox，切换状态而非进入编辑模式
      const currentContent = this.localContent() || this.task().content || '';
      const newContent = toggleMarkdownTodo(currentContent, todoIndex);
      this.localContent.set(newContent);
      this.taskOpsAdapter.updateTaskContent(this.task().id, newContent);
      // 强制标记组件需要重新检测，确保 OnPush 模式下 UI 刷新
      this.cdr.markForCheck();
    } else {
      this.enterEditMode('content', event);
    }
  }

  private handlePreviewLinkClick(event: MouseEvent): boolean {
    const linkTarget = handleMarkdownLinkAction(event, this.toast);
    if (!linkTarget) {
      return linkTarget === false;
    }

    if (linkTarget.kind === 'task' && linkTarget.taskId) {
      this.openLinkedTask.emit({ taskId: linkTarget.taskId, event });
    }
    return true;
  }

  addQuickTodo(inputElement: HTMLInputElement) {
    const text = inputElement.value.trim();
    if (!text) return;

    this.taskOpsAdapter.addTodoItem(this.task().id, text);
    inputElement.value = '';
    inputElement.focus();
  }

  onAttachmentsChange(attachments: Attachment[]) {
    this.taskOpsAdapter.updateTaskAttachments(this.task().id, attachments);
  }

  // ========== 移动端附件管理方法 ==========

  toggleAttachmentList() {
    this.showAttachmentList.update(v => !v);
  }

  getFileExtension(filename: string): string {
    const ext = filename.split('.').pop() || '';
    return ext.length > 4 ? ext.substring(0, 4) : ext;
  }

  formatFileSize(bytes: number | undefined): string {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }

  async onMobileFileSelect(event: Event) {
    const input = event.target as HTMLInputElement;
    const files = input.files;
    if (!files || files.length === 0 || !this.userId() || !this.projectId()) return;

    const currentCount = this.task().attachments?.length || 0;
    const remaining = this.maxAttachments - currentCount;

    if (remaining <= 0) {
      this.toast.warning('附件数量已达上限', '每个任务最多 ' + this.maxAttachments + ' 个附件');
      input.value = '';
      return;
    }

    const filesToUpload = Array.from(files).slice(0, remaining);

    // 检查文件大小
    for (const file of filesToUpload) {
      if (file.size > this.maxFileSize) {
        this.toast.warning('文件过大', `${file.name} 超过 10MB 限制`);
        input.value = '';
        return;
      }
    }

    this.isUploading.set(true);

    try {
      const newAttachments: Attachment[] = [];

      for (const file of filesToUpload) {
        const result = await this.attachmentService.uploadFile(
          this.userId()!,
          this.projectId()!,
          this.task().id,
          file
        );
        if (result.success && result.attachment) {
          newAttachments.push(result.attachment);
        } else if (result.error) {
          this.attachmentError.emit(result.error);
        }
      }

      if (newAttachments.length > 0) {
        const updatedAttachments = [...(this.task().attachments || []), ...newAttachments];
        this.taskOpsAdapter.updateTaskAttachments(this.task().id, updatedAttachments);
        this.toast.success('上传成功', `${newAttachments.length} 个文件已上传`);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : '上传失败';
      this.attachmentError.emit(errorMsg);
      this.toast.error('上传失败', errorMsg);
    } finally {
      this.isUploading.set(false);
      input.value = '';
    }
  }

  async deleteAttachment(attachment: Attachment, event: Event) {
    event.stopPropagation();

    if (!this.userId() || !this.projectId()) return;

    try {
      const deletedAttachment = this.attachmentService.markAsDeleted(attachment);

      const updatedAttachments = (this.task().attachments || []).map(a =>
        a.id === attachment.id ? deletedAttachment : a
      );
      this.taskOpsAdapter.updateTaskAttachments(this.task().id, updatedAttachments);
      this.toast.success('删除成功', attachment.name + ' 已删除');
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : '删除失败';
      this.attachmentError.emit(errorMsg);
      this.toast.error('删除失败', errorMsg);
    }
  }

  previewImage(attachment: Attachment) {
    if (attachment.url) {
      window.open(attachment.url, '_blank');
    }
  }

  private parseOptionalMinutes(value: string): number | null {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return Math.floor(parsed);
  }

  private focusEditorField(field: 'title' | 'content'): void {
    this.clearFocusRequestTimer();
    this.focusRequestTimer = setTimeout(() => {
      const input = this.resolveEditorFieldElement(field);

      input?.focus();
      if (this.skipNextEditorAutoSelect) {
        this.skipNextEditorAutoSelect = false;
      } else {
        input?.select?.();
      }
      this.focusRequestTimer = null;
    }, 0);
  }

  private resolveEditorFieldElement(field: 'title' | 'content'): HTMLInputElement | HTMLTextAreaElement | null {
    const selector = field === 'title'
      ? '[data-testid="task-title-input"]'
      : '[data-testid="task-content-editor"]';

    const host = this.elementRef.nativeElement as HTMLElement | null;
    if (!host) {
      return null;
    }

    return host.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
  }

  private armOutsideClickGuard(triggerEvent?: Event): void {
    if (!triggerEvent) {
      return;
    }

    this.suppressNextDocumentClick = true;
    if (this.clearDocumentClickGuardTimer) {
      clearTimeout(this.clearDocumentClickGuardTimer);
    }

    this.clearDocumentClickGuardTimer = setTimeout(() => {
      this.clearDocumentClickGuard();
    }, 0);
  }

  private isEventInsideEditor(event: Event): boolean {
    const host = this.elementRef.nativeElement as HTMLElement | null;
    if (!host) {
      return false;
    }

    if (this.eventPathContains(event, node => node === host)) {
      return true;
    }

    const target = event.target;
    return target instanceof Node ? host.contains(target) : false;
  }

  private isEventInsideCurrentTaskCard(event: Event): boolean {
    const currentTaskId = this.task().id;

    if (this.eventPathContains(event, node => {
      return node instanceof HTMLElement && node.getAttribute('data-task-id') === currentTaskId;
    })) {
      return true;
    }

    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return false;
    }

    return !!target.closest(`[data-task-id="${currentTaskId}"]`);
  }

  private eventPathContains(event: Event, predicate: (node: EventTarget) => boolean): boolean {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    return path.some(predicate);
  }

  private clearDocumentClickGuard(): void {
    this.suppressNextDocumentClick = false;
    if (!this.clearDocumentClickGuardTimer) {
      return;
    }

    clearTimeout(this.clearDocumentClickGuardTimer);
    this.clearDocumentClickGuardTimer = null;
  }

  private clearFocusRequestTimer(): void {
    if (!this.focusRequestTimer) {
      return;
    }

    clearTimeout(this.focusRequestTimer);
    this.focusRequestTimer = null;
  }
}




