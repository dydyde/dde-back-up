import { Component, input, output, signal, inject, OnDestroy, ChangeDetectionStrategy, computed, ElementRef, viewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { UiStateService } from '../../../../services/ui-state.service';
import { ProjectStateService } from '../../../../services/project-state.service';
import { BlackBoxService } from '../../../../services/black-box.service';
import { FocusPreferenceService } from '../../../../services/focus-preference.service';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
import { Task } from '../../../../models';
import { blackBoxEntriesMap } from '../../../../state/focus-stores';
import { BlackBoxPanelComponent } from '../../focus/components/black-box/black-box-panel.component';
import { StrataViewComponent } from '../../focus/components/strata/strata-view.component';
import { readTaskDragPayload, writeTaskDragPayload } from '../../../../utils/task-drag-payload';

/**
 * 流程图侧边栏组件 (原 Palette/Strata Panel)
 * 职责：项目概览、任务列表、待分配池、历史回溯
 */
@Component({
  selector: 'app-flow-palette',
  standalone: true,
  imports: [CommonModule, BlackBoxPanelComponent, StrataViewComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    :host {
      position: absolute;
      top: 0;
      left: 0;
      bottom: 0;
      z-index: 40;
      pointer-events: none;
      display: flex;
      flex-direction: row;
    }

    /* 侧边栏容器 */
    .sidebar-container {
      @apply bg-white dark:bg-stone-900 border-r border-stone-200 dark:border-stone-700 shadow-xl flex flex-col h-full overflow-hidden transition-all duration-300;
      pointer-events: auto;
    }

    /* 通用滚动条 */
    .custom-scroll::-webkit-scrollbar {
      width: 4px;
    }
    .custom-scroll::-webkit-scrollbar-track {
      background: transparent;
    }
    .custom-scroll::-webkit-scrollbar-thumb {
      @apply bg-stone-300 dark:bg-stone-600 rounded-full;
    }
    .custom-scroll::-webkit-scrollbar-thumb:hover {
      @apply bg-stone-400 dark:bg-stone-500;
    }

    /* 选项卡按钮 */
    .tab-btn {
      @apply flex-1 py-2.5 text-xs font-medium text-stone-500 dark:text-stone-400 border-b-2 border-transparent transition-colors hover:text-stone-700 dark:hover:text-stone-300 bg-stone-50 dark:bg-stone-900 overflow-hidden whitespace-nowrap text-ellipsis;
    }
    .tab-btn.active {
      @apply text-indigo-600 dark:text-indigo-400 border-indigo-600 dark:border-indigo-400 bg-white dark:bg-stone-800;
    }

    /* 统计卡片 */
    .stat-card {
      @apply flex flex-col p-2 rounded-lg bg-stone-50 dark:bg-stone-800/50 border border-stone-100 dark:border-stone-800 transition-all hover:bg-white dark:hover:bg-stone-800 hover:shadow-sm cursor-pointer hover:border-stone-200 dark:hover:border-stone-700 overflow-hidden min-w-0;
    }

    /* 列表项 - 待办 */
    .task-item {
      @apply relative flex items-center gap-3 p-2.5 rounded-lg border border-transparent hover:bg-stone-50 dark:hover:bg-stone-800/80 transition-all cursor-pointer hover:border-stone-200 dark:hover:border-stone-700 hover:shadow-sm;
    }
    
    /* 拖拽相关 */
    .draggable-item {
      @apply cursor-grab active:cursor-grabbing select-none;
    }
    .dragging-over {
      @apply bg-indigo-50 dark:bg-indigo-900/20 border-indigo-300 dark:border-indigo-700 border-dashed !important;
    }

    /* 动画 */
    .animate-slide-in-bottom {
      animation: slideInBottom 0.3s ease-out;
    }
    @keyframes slideInBottom {
      from { transform: translateY(100%); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }

    /* Resize 边界线 */
    .resize-handle {
      position: absolute;
      right: 0;
      top: 0;
      bottom: 0;
      width: 4px;
      cursor: col-resize;
      z-index: 10;
      transition: background-color 0.15s ease;
    }
    .resize-handle:hover,
    .resize-handle.resizing {
      @apply bg-indigo-400/50;
    }
  `],
  template: `
    <div
      class="sidebar-container"
      [style.width]="isOpen() ? sidebarWidth() + 'px' : '0px'"
      [class.w-0]="!isOpen()"
      [class.opacity-0]="!isOpen()"
      [class.transition-none]="isResizing()">

      <!-- 侧边栏内容 -->
      <div class="flex-1 flex flex-col w-full h-full min-w-0 min-h-0">
        
        <!-- 1. 项目头部 -->
        <div class="shrink-0 px-3 py-2 border-b border-stone-100 dark:border-stone-800 bg-white dark:bg-stone-900">
          @if (projectState.activeProject(); as project) {
            <div class="flex items-start justify-between gap-2 mb-2">
              <div class="min-w-0 flex-1 overflow-hidden">
                <div class="flex items-center gap-1.5 min-w-0">
                  <button
                    type="button"
                    class="flex h-[22px] w-[22px] items-center justify-center rounded-md border border-stone-200 bg-stone-50 text-stone-500 shadow-sm transition-colors hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-600 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-400 dark:hover:border-indigo-500/70 dark:hover:bg-indigo-950/40 dark:hover:text-indigo-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 shrink-0"
                    (click)="toggleSidebar()"
                    [attr.aria-label]="isOpen() ? '收起侧边栏' : '展开侧边栏'"
                    [attr.aria-expanded]="isOpen()"
                    [title]="isOpen() ? '收起侧边栏' : '展开侧边栏'">
                    <svg xmlns="http://www.w3.org/2000/svg" class="w-3 h-3 transition-transform duration-300" [class.rotate-180]="isOpen()" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
                    </svg>
                  </button>
                  <h2 class="min-w-0 flex-1 text-base font-bold text-stone-800 dark:text-stone-100 leading-tight truncate" [title]="project.name">
                    {{ project.name || '未命名项目' }}
                  </h2>
                </div>
                <div class="flex items-center gap-2 mt-0.5">
                  <span class="text-[9px] text-stone-400 font-mono">{{ (project.updatedAt || project.createdDate) | date:'MM-dd HH:mm' }}</span>
                  <span class="text-[9px] px-1 py-0.5 rounded-full bg-stone-100 dark:bg-stone-800 text-stone-500 dark:text-stone-400 font-medium">
                   {{ projectStatusLabel() }}
                  </span>
                </div>
              </div>
              <button class="p-1 text-stone-400 hover:text-stone-600 dark:hover:text-stone-200 transition-colors rounded-md hover:bg-stone-100 dark:hover:bg-stone-800 shrink-0">
                <svg xmlns="http://www.w3.org/2000/svg" class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
                </svg>
              </button>
            </div>
          } @else {
             <div class="text-center py-2 text-stone-400 text-xs">暂无选中项目</div>
          }
        </div>

        <!-- 2. 仪表盘 (关键指标) -->
        <div class="shrink-0 px-3 py-3 grid grid-cols-3 gap-1.5 border-b border-stone-100 dark:border-stone-800 bg-stone-50/30 dark:bg-stone-900/30 overflow-hidden">
          <button (click)="focusDashboardSection('unfinished')" 
             class="stat-card"
             [class.ring-1]="focusedSection() === 'unfinished'"
             [class.ring-indigo-400]="focusedSection() === 'unfinished'">
             <span class="text-[10px] text-stone-500 uppercase tracking-wider font-semibold">进行中</span>
             <span class="text-xl font-bold text-indigo-600 dark:text-indigo-400 mt-0.5 font-mono">{{ unfinishedCount() }}</span>
          </button>
          
          <button (click)="focusDashboardSection('unassigned')" 
             class="stat-card"
             [class.ring-1]="focusedSection() === 'unassigned'"
             [class.ring-teal-400]="focusedSection() === 'unassigned'">
             <span class="text-[10px] text-stone-500 uppercase tracking-wider font-semibold">待分配</span>
             <span class="text-xl font-bold text-teal-600 dark:text-teal-400 mt-0.5 font-mono">{{ unassignedCount() }}</span>
          </button>
          
          <button (click)="focusDashboardSection('blackbox')" 
             class="stat-card"
             [class.ring-1]="focusedSection() === 'blackbox'"
             [class.ring-stone-400]="focusedSection() === 'blackbox'">
             <span class="text-[10px] text-stone-500 uppercase tracking-wider font-semibold">完成率</span>
             <span class="text-xl font-bold text-stone-600 dark:text-stone-300 mt-0.5 font-mono">{{ completionRate() }}%</span>
          </button>
        </div>

        <!-- 3.主要工作区 (Tab切页) -->
        <div class="flex-1 flex flex-col min-h-0 bg-stone-50/50 dark:bg-stone-900/50">
          <div class="flex border-b border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 sticky top-0 z-10 shadow-sm">
            <button class="tab-btn" 
              data-testid="flow-palette-tab-unfinished"
              [class.active]="activeWorkbenchTab() === 'unfinished'"
              (click)="setWorkbenchTab('unfinished')">
              任务列表
            </button>
            <button class="tab-btn" 
              data-testid="flow-palette-tab-unassigned"
              [class.active]="activeWorkbenchTab() === 'unassigned'"
              (click)="setWorkbenchTab('unassigned')">
              待分配区
            </button>
             @if (focusPrefs.isBlackBoxEnabled()) {
              <button class="tab-btn" 
                data-testid="flow-palette-tab-blackbox"
                [class.active]="activeWorkbenchTab() === 'blackbox'"
                (click)="setWorkbenchTab('blackbox')">
                黑匣子
               <span class="ml-1 px-1.5 py-0.5 rounded bg-stone-100 dark:bg-stone-800 text-[9px] text-stone-500">{{ blackBoxPendingCount() }}</span>
              </button>
            }
          </div>

          <div class="flex-1 min-h-0 overflow-y-auto custom-scroll p-3" #workbenchSection>
            @if (activeWorkbenchTab() === 'unfinished') {
              <ul class="space-y-2">
                @for (item of projectState.unfinishedItems(); track item.taskId + '-' + item.todoIndex) {
                  <li class="task-item bg-white dark:bg-stone-800"
                      (click)="centerOnNode.emit(item.taskId)">
                    <div class="w-1.5 self-stretch rounded-full bg-indigo-500/80 mr-1"></div>
                    <div class="min-w-0 flex-1">
                      <div class="flex items-center justify-between mb-0.5">
                        <span class="text-xs font-medium text-stone-700 dark:text-stone-200 truncate pr-2" [title]="item.text">{{ item.text || '无标题任务' }}</span>
                        <span class="text-[9px] font-mono text-stone-400 bg-stone-100 dark:bg-stone-700 px-1 rounded">{{ projectState.compressDisplayId(item.taskDisplayId) }}</span>
                      </div>
                      <div class="text-[10px] text-stone-400 truncate flex items-center gap-2">
                         <span class="flex items-center gap-1">
                           <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                           点击定位
                         </span>
                      </div>
                    </div>
                  </li>
                } @empty {
                  <div class="flex flex-col items-center justify-center py-10 text-stone-400 opacity-60">
                    <svg class="w-12 h-12 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                    </svg>
                    <span class="text-xs">暂无进行中任务</span>
                  </div>
                }
              </ul>
            } @else if (activeWorkbenchTab() === 'unassigned') {
               <div class="space-y-3 h-full flex flex-col">
                 <!-- 拖放区域（可滚动，防止大量任务撑爆布局） -->
                 <div
                   class="flex-1 rounded-xl border-2 border-dashed border-stone-200 dark:border-stone-700 bg-stone-100/50 dark:bg-stone-800/20 p-3 transition-colors grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-2 content-start min-h-[150px] overflow-y-auto custom-scroll"
                   [class.dragging-over]="isDropTargetActive()"
                   (dragover)="onDragOver($event)"
                   (drop)="onDrop($event)">
                    
                   @if (projectState.unassignedTasks().length === 0 && !isDropTargetActive()) {
                      <div class="col-span-full min-h-[120px] flex flex-col items-center justify-center text-stone-400/60 pointer-events-none">
                        <span class="text-2xl mb-2">📥</span>
                        <span class="text-xs">拖放任务至此解除分配</span>
                      </div>
                   }

                   @for (task of displayedUnassignedTasks(); track task.id) {
                     <div
                        draggable="true"
                        (dragstart)="onDragStart($event, task)"
                        (touchstart)="onTouchStart($event, task)"
                        (touchmove)="onTouchMove($event)"
                        (touchend)="onTouchEnd($event)"
                        (click)="taskClick.emit(task)"
                        class="draggable-item w-full min-w-0 px-3 py-2 bg-white dark:bg-stone-800 border border-stone-200 dark:border-stone-600 rounded-lg shadow-sm text-xs text-stone-700 dark:text-stone-300 hover:border-teal-400 dark:hover:border-teal-500 hover:shadow transition-all truncate flex items-center gap-1.5"
                        [attr.data-testid]="'flow-palette-task-' + task.id"
                        [ngClass]="{ 'opacity-50': draggingId() === task.id }">
                        <span class="w-1.5 h-1.5 rounded-full bg-teal-400 shrink-0"></span>
                        <span class="truncate">{{ task.title || '无标题' }}</span>
                     </div>
                   }

                   <!-- 加载更多（超过展示上限时显示） -->
                   @if (hasMoreUnassigned()) {
                     <button
                       class="col-span-full w-full py-2 text-[11px] text-teal-600 dark:text-teal-400 hover:bg-teal-50 dark:hover:bg-teal-900/20 rounded-lg transition-colors font-medium"
                       (click)="loadMoreUnassigned()">
                       还有 {{ remainingUnassignedCount() }} 项，点击加载更多
                     </button>
                   }
                 </div>
                 
                 <button
                    data-testid="create-unassigned-btn"
                    (click)="createUnassigned.emit()"
                    class="w-full py-3 bg-white dark:bg-stone-800 border border-stone-200 dark:border-stone-700 hover:border-teal-500 text-stone-500 hover:text-teal-600 dark:text-stone-400 dark:hover:text-teal-400 rounded-lg text-xs font-medium transition-all flex items-center justify-center gap-2 shadow-sm group shrink-0">
                    <span class="w-5 h-5 rounded-full bg-stone-100 dark:bg-stone-700 group-hover:bg-teal-50 dark:group-hover:bg-teal-900/30 flex items-center justify-center text-sm leading-none transition-colors">+</span> 
                    新建待分配任务
                 </button>
               </div>
            } @else if (activeWorkbenchTab() === 'blackbox') {
               <div class="min-h-0" #blackboxSection>
                 <app-black-box-panel [expandToken]="blackBoxExpandToken()"></app-black-box-panel>
               </div>
            }
          </div>
        </div>
        
        <!-- 4. 底部: 沉积岩层历史回顾 -->
        <div class="shrink-0 bg-stone-950/50 dark:bg-stone-950/80 border-t border-amber-500/10 dark:border-amber-400/10 shadow-[0_-4px_12px_-1px_rgba(244,192,37,0.06)]">
           <button class="w-full px-4 py-3 flex items-center justify-between hover:bg-stone-900/40 dark:hover:bg-stone-900/60 transition-colors group"
                   (click)="toggleHistory()">
              <span class="text-xs font-bold text-stone-600 dark:text-stone-300 flex items-center gap-2">
                <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 text-amber-500/60 group-hover:text-amber-400/80 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                </svg>
                <span class="tracking-wide">项目历史回顾</span>
                <span class="text-[9px] font-mono text-amber-500/40 tracking-widest uppercase ml-1">Strata</span>
              </span>
              <span class="transform transition-transform duration-300" [class.rotate-180]="isHistoryExpanded()">
                <svg xmlns="http://www.w3.org/2000/svg" class="w-3 h-3 text-stone-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
                </svg>
              </span>
           </button>
           
           @if (isHistoryExpanded()) {
             <div class="h-72 border-t border-stone-800/50 dark:border-stone-800/70 bg-stone-950/40 dark:bg-stone-950/60 animate-slide-in-bottom">
               <app-strata-view class="block h-full w-full" [alwaysShow]="true" (restoreItem)="onRestoreFromHistory($event)"></app-strata-view>
             </div>
           }
        </div>

      </div>

      <!-- Resize handle：可拖拽调整宽度的边界线 -->
      <div 
        class="resize-handle"
        [class.resizing]="isResizing()"
        (mousedown)="onResizeStart($event)"
        (touchstart)="onResizeTouchStart($event)">
      </div>
    </div>
    
    <!-- 折叠切换按钮 (悬浮在侧边栏边缘) -->
    <div class="pointer-events-auto absolute top-1/2 left-full z-50 transform -translate-y-1/2 -ml-0.5">
      <button
        (click)="toggleSidebar()"
        class="flex items-center justify-center w-5 h-16 bg-white dark:bg-stone-800 border border-l-0 border-stone-200 dark:border-stone-700 rounded-r-lg shadow-md text-stone-400 hover:text-indigo-600 hover:w-6 transition-all focus:outline-none"
        [title]="isOpen() ? '收起侧边栏' : '展开侧边栏'">
        <svg xmlns="http://www.w3.org/2000/svg" class="w-3 h-3 transition-transform duration-300" [class.rotate-180]="isOpen()" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
        </svg>
      </button>
    </div>
  `,
  providers: []
})
export class FlowPaletteComponent implements OnDestroy {
  readonly uiState = inject(UiStateService);
  readonly projectState = inject(ProjectStateService);
  readonly blackBoxService = inject(BlackBoxService);
  readonly focusPrefs = inject(FocusPreferenceService);
  private readonly taskOpsAdapter = inject(TaskOperationAdapterService);
  readonly workbenchSectionRef = viewChild<ElementRef<HTMLElement>>('workbenchSection');
  readonly blackboxSectionRef = viewChild<ElementRef<HTMLElement>>('blackboxSection');

  // 输入
  readonly height = input<number>(200);
  readonly isDropTargetActive = input<boolean>(false);

  // 输出事件
  readonly heightChange = output<number>();
  readonly centerOnNode = output<string>();
  readonly createUnassigned = output<void>();
  readonly taskClick = output<Task>();
  readonly taskDragStart = output<{ event: DragEvent; task: Task }>();
  readonly taskDrop = output<{ event: DragEvent }>();
  readonly taskTouchStart = output<{ event: TouchEvent; task: Task }>();
  readonly taskTouchMove = output<{ event: TouchEvent }>();
  readonly taskTouchEnd = output<{ event: TouchEvent }>();

  // 手势滑动事件
  readonly swipeToText = output<void>();
  readonly swipeToSidebar = output<void>();

  // 内部状态
  readonly draggingId = signal<string | null>(null);
  readonly isOpen = signal<boolean>(true);
  readonly isHistoryExpanded = signal<boolean>(false);
  readonly focusedSection = signal<'unfinished' | 'unassigned' | 'blackbox' | null>(null);
  readonly blackBoxExpandToken = signal(0);
  readonly activeWorkbenchTab = signal<'unfinished' | 'unassigned' | 'blackbox'>('unfinished');

  /** 待分配区每次展示的任务上限，防止 DOM 节点过多导致 UI 崩溃 */
  private readonly UNASSIGNED_PAGE_SIZE = 50;
  readonly unassignedDisplayLimit = signal(50);

  /** 限量展示的待分配任务列表 */
  readonly displayedUnassignedTasks = computed(() =>
    this.projectState.unassignedTasks().slice(0, this.unassignedDisplayLimit())
  );

  /** 是否还有更多未展示的待分配任务 */
  readonly hasMoreUnassigned = computed(() =>
    this.projectState.unassignedTasks().length > this.unassignedDisplayLimit()
  );

  /** 剩余未展示数量 */
  readonly remainingUnassignedCount = computed(() =>
    Math.max(0, this.projectState.unassignedTasks().length - this.unassignedDisplayLimit())
  );

  // 与 FlowToolbar 保持一致，但侧边栏默认展开
  readonly isOpenChange = output<boolean>();

  /** 侧边栏宽度限制：最小 280px，最大 600px */
  private readonly MIN_WIDTH = 280;
  private readonly MAX_WIDTH = 600;
  private readonly DEFAULT_WIDTH = 320;

  /** 可调整的侧边栏宽度 */
  readonly sidebarWidth = signal(this.DEFAULT_WIDTH);
  /** 是否正在拖拽调整宽度 */
  readonly isResizing = signal(false);

  /** 保留兼容（暂不移除），实际使用 sidebarWidth() */
  readonly expandedWidth = '320px';

  readonly livingTasks = computed(() => this.projectState.tasks().filter(task => !task.deletedAt));
  readonly totalTaskCount = computed(() => this.livingTasks().length);
  readonly activeTaskCount = computed(() => this.livingTasks().filter(task => task.status === 'active').length);
  readonly completedTaskCount = computed(() => this.livingTasks().filter(task => task.status === 'completed').length);
  readonly unfinishedCount = computed(() => this.projectState.unfinishedItems().length);
  readonly unassignedCount = computed(() => this.projectState.unassignedTasks().length);

  readonly blackBoxPendingCount = this.blackBoxService.pendingCount;

  /**
   * 所有黑匣子条目（未软删除）
   * 包含已完成（在项目历史回顾中）和未完成（在黑匣子待处理仓中）的条目
   * 【修复 2026-02-20】不按 projectId 过滤，与黑匣子面板和项目历史回顾保持一致。
   * 用户要求完成率基数 = 所有录音内容，分子 = 已完成的录音内容（项目历史回顾中的）
   */
  readonly allBlackBoxEntries = computed(() => {
    return Array.from(blackBoxEntriesMap().values())
      .filter(e => !e.deletedAt && !e.isArchived);
  });

  /**
   * 完成率基数只包含两类可独立完成的内容：
   * 1. 任务块中的 Markdown 待办事项
   * 2. 黑匣子条目
   *
   * 任务块本身可独立设为 completed 并进入沉积层，但不作为完成率分母。
   */
  readonly completionBasis = computed(() => {
    const todoStats = this.projectState.taskTodoStats();
    const blackBoxEntries = this.allBlackBoxEntries();
    const completedBlackBoxCount = blackBoxEntries.filter(entry => entry.isCompleted).length;

    return {
      total: todoStats.total + blackBoxEntries.length,
      completed: todoStats.completed + completedBlackBoxCount,
    };
  });

  /**
   * 完成率 = (已完成待办事项 + 已完成黑匣子条目) / (待办事项总数 + 黑匣子条目总数)
   * 任务块只是容器，不直接进入完成率计算。
   */
  readonly completionRate = computed(() => {
    if (!this.projectState.activeProject()) {
      return 0;
    }

    const basis = this.completionBasis();
    return this.calculatePercent(basis.completed, basis.total);
  });

  readonly projectStatusLabel = computed(() => {
    const total = this.completionBasis().total;
    if (total === 0) return '初始化';
    if (this.completionRate() >= 70) return '稳态推进';
    if (this.completionRate() >= 35) return '高效执行';
    return '启动阶段';
  });

  toggleSidebar() {
    this.isOpen.set(!this.isOpen());
    this.isOpenChange.emit(this.isOpen());
  }

  toggleHistory() {
    this.isHistoryExpanded.set(!this.isHistoryExpanded());
  }

  /**
   * 从沉积层历史中恢复条目
   * - task → 状态设回 active，切换到任务列表并定位节点
   * - black_box → 取消完成标记，切换到黑匣子 tab
   */
  onRestoreFromHistory(event: { id: string; type: 'task' | 'black_box' }): void {
    if (event.type === 'task') {
      this.taskOpsAdapter.updateTaskStatus(event.id, 'active');
      this.setWorkbenchTab('unfinished');
      this.centerOnNode.emit(event.id);
    } else {
      // black_box：取消完成，恢复为待处理
      this.blackBoxService.update(event.id, { isCompleted: false });
      this.setWorkbenchTab('blackbox');
    }
  }

  setWorkbenchTab(tab: 'unfinished' | 'unassigned' | 'blackbox'): void {
    this.activeWorkbenchTab.set(tab);
    // 切换到待分配 tab 时重置展示上限，避免残留超量 DOM
    if (tab === 'unassigned') {
      this.unassignedDisplayLimit.set(this.UNASSIGNED_PAGE_SIZE);
    }
    // 兼容原有状态逻辑，但不强制绑定
    if (tab === 'unfinished') this.uiState.isFlowUnfinishedOpen.set(true);
    if (tab === 'unassigned') this.uiState.isFlowUnassignedOpen.set(true);
  }

  /** 加载更多待分配任务 */
  loadMoreUnassigned(): void {
    this.unassignedDisplayLimit.update(v => v + this.UNASSIGNED_PAGE_SIZE);
  }

  focusDashboardSection(section: 'unfinished' | 'unassigned' | 'blackbox'): void {
    this.setWorkbenchTab(section);
    
    if (section === 'blackbox') {
      this.blackBoxExpandToken.update(v => v + 1);
    }

    this.focusedSection.set(section);
    
    if (this.sectionFocusTimer) {
      clearTimeout(this.sectionFocusTimer);
    }

    this.sectionFocusTimer = setTimeout(() => {
      this.focusedSection.set(null);
      this.sectionFocusTimer = null;
    }, 1000);
  }

  // 触摸拖动状态
  private touchState = {
    task: null as Task | null,
    startX: 0,
    startY: 0,
    isDragging: false,
    longPressTimer: null as ReturnType<typeof setTimeout> | null,
    ghost: null as HTMLElement | null
  };

  private sectionFocusTimer: ReturnType<typeof setTimeout> | null = null;

  /** Resize 状态：起始宽度和起始鼠标位置 */
  private resizeState = {
    startWidth: 0,
    startX: 0,
  };

  /** 绑定的 resize 事件处理器，用于移除监听 */
  private boundResizeMove = this.onResizeMove.bind(this);
  private boundResizeEnd = this.onResizeEnd.bind(this);
  private boundResizeTouchMove = this.onResizeTouchMove.bind(this);
  private boundResizeTouchEnd = this.onResizeTouchEnd.bind(this);

  ngOnDestroy() {
    // 清理 resize 监听
    this.cleanupResizeListeners();

    if (this.touchState.longPressTimer) {
      clearTimeout(this.touchState.longPressTimer);
      this.touchState.longPressTimer = null;
    }

    if (this.touchState.ghost) {
      this.touchState.ghost.remove();
      this.touchState.ghost = null;
    }

    if (this.sectionFocusTimer) {
      clearTimeout(this.sectionFocusTimer);
      this.sectionFocusTimer = null;
    }
  }

  // ============ Resize 宽度调整逻辑 ============

  /** 鼠标按下开始 resize */
  onResizeStart(event: MouseEvent) {
    event.preventDefault();
    this.resizeState.startWidth = this.sidebarWidth();
    this.resizeState.startX = event.clientX;
    this.isResizing.set(true);

    document.addEventListener('mousemove', this.boundResizeMove);
    document.addEventListener('mouseup', this.boundResizeEnd);
  }

  /** 鼠标移动中调整宽度 */
  private onResizeMove(event: MouseEvent) {
    if (!this.isResizing()) return;
    const delta = event.clientX - this.resizeState.startX;
    const newWidth = Math.max(this.MIN_WIDTH, Math.min(this.MAX_WIDTH, this.resizeState.startWidth + delta));
    this.sidebarWidth.set(newWidth);
  }

  /** 鼠标释放结束 resize */
  private onResizeEnd() {
    this.isResizing.set(false);
    document.removeEventListener('mousemove', this.boundResizeMove);
    document.removeEventListener('mouseup', this.boundResizeEnd);
  }

  /** 触摸开始 resize */
  onResizeTouchStart(event: TouchEvent) {
    if (event.touches.length !== 1) return;
    event.preventDefault();
    const touch = event.touches[0];
    this.resizeState.startWidth = this.sidebarWidth();
    this.resizeState.startX = touch.clientX;
    this.isResizing.set(true);

    document.addEventListener('touchmove', this.boundResizeTouchMove, { passive: false });
    document.addEventListener('touchend', this.boundResizeTouchEnd);
    document.addEventListener('touchcancel', this.boundResizeTouchEnd);
  }

  /** 触摸移动中调整宽度 */
  private onResizeTouchMove(event: TouchEvent) {
    if (!this.isResizing() || event.touches.length !== 1) return;
    event.preventDefault();
    const touch = event.touches[0];
    const delta = touch.clientX - this.resizeState.startX;
    const newWidth = Math.max(this.MIN_WIDTH, Math.min(this.MAX_WIDTH, this.resizeState.startWidth + delta));
    this.sidebarWidth.set(newWidth);
  }

  /** 触摸结束 resize */
  private onResizeTouchEnd() {
    this.isResizing.set(false);
    document.removeEventListener('touchmove', this.boundResizeTouchMove);
    document.removeEventListener('touchend', this.boundResizeTouchEnd);
    document.removeEventListener('touchcancel', this.boundResizeTouchEnd);
  }

  /** 清理 resize 监听器 */
  private cleanupResizeListeners() {
    document.removeEventListener('mousemove', this.boundResizeMove);
    document.removeEventListener('mouseup', this.boundResizeEnd);
    document.removeEventListener('touchmove', this.boundResizeTouchMove);
    document.removeEventListener('touchend', this.boundResizeTouchEnd);
    document.removeEventListener('touchcancel', this.boundResizeTouchEnd);
  }

  // 拖动事件
  onDragStart(event: DragEvent, task: Task) {
    if (event.dataTransfer) {
      writeTaskDragPayload(event.dataTransfer, {
        v: 1,
        type: 'task',
        taskId: task.id,
        projectId: this.projectState.activeProjectId(),
        fromProjectId: this.projectState.activeProjectId(),
        source: 'flow',
      });
      event.dataTransfer.effectAllowed = 'move';
    }
    this.taskDragStart.emit({ event, task });
  }

  onDragOver(event: DragEvent) {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
  }

  onDrop(event: DragEvent) {
    event.preventDefault();

    const payload = event.dataTransfer ? readTaskDragPayload(event.dataTransfer) : null;
    const fallbackData = event.dataTransfer?.getData('application/json') || event.dataTransfer?.getData('text');
    if (!payload && !fallbackData) {
      this.taskDrop.emit({ event });
      return;
    }

    try {
      const draggedTask = payload
        ? this.projectState.getTask(payload.taskId)
        : (JSON.parse(fallbackData ?? '') as { id?: string; stage?: number | null });

      if (draggedTask?.id && draggedTask.stage === null) {
        this.taskDrop.emit({ event });
        return;
      }
    } catch (_err) {
      // 数据解析失败时，回落到通用 drop 处理
    }

    this.taskDrop.emit({ event });
  }

  // 触摸事件
  onTouchStart(event: TouchEvent, task: Task) {
    if (event.touches.length !== 1) return;

    const touch = event.touches[0];
    this.touchState = {
      task,
      startX: touch.clientX,
      startY: touch.clientY,
      isDragging: false,
      longPressTimer: null,
      ghost: null
    };

    this.touchState.longPressTimer = setTimeout(() => {
      this.touchState.isDragging = true;
      this.draggingId.set(task.id);
      this.createGhost(task, touch.clientX, touch.clientY);
      if (navigator.vibrate) navigator.vibrate(50);
    }, 250);

    this.taskTouchStart.emit({ event, task });
  }

  onTouchMove(event: TouchEvent) {
    if (!this.touchState.task || event.touches.length !== 1) return;

    const touch = event.touches[0];
    const deltaX = Math.abs(touch.clientX - this.touchState.startX);
    const deltaY = Math.abs(touch.clientY - this.touchState.startY);

    if (!this.touchState.isDragging && (deltaX > 15 || deltaY > 15)) {
      if (this.touchState.longPressTimer) {
        clearTimeout(this.touchState.longPressTimer);
        this.touchState.longPressTimer = null;
      }
      return;
    }

    if (this.touchState.isDragging) {
      if (event.cancelable) {
        event.preventDefault();
      }
      event.stopPropagation();

      if (this.touchState.ghost) {
        this.touchState.ghost.style.left = `${touch.clientX - 40}px`;
        this.touchState.ghost.style.top = `${touch.clientY - 20}px`;
      }
    }

    this.taskTouchMove.emit({ event });
  }

  onTouchEnd(event: TouchEvent) {
    if (this.touchState.longPressTimer) {
      clearTimeout(this.touchState.longPressTimer);
    }

    if (this.touchState.ghost) {
      this.touchState.ghost.remove();
    }

    this.draggingId.set(null);
    this.taskTouchEnd.emit({ event });

    this.touchState = {
      task: null,
      startX: 0,
      startY: 0,
      isDragging: false,
      longPressTimer: null,
      ghost: null
    };
  }

  private createGhost(task: Task, x: number, y: number) {
    const ghost = document.createElement('div');
    ghost.className = 'fixed z-[9999] px-3 py-2 bg-indigo-500/90 text-white rounded-lg shadow-xl text-xs font-medium pointer-events-none whitespace-nowrap';
    ghost.textContent = task.title || '未命名';
    ghost.style.left = `${x - 40}px`;
    ghost.style.top = `${y - 20}px`;
    document.body.appendChild(ghost);
    this.touchState.ghost = ghost;
  }

  private calculatePercent(value: number, total: number): number {
    if (total <= 0) return 0;
    return this.clamp(Math.round((value / total) * 100), 0, 100);
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
  }
}
