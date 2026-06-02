import { Component, ChangeDetectionStrategy, input, output, computed, inject, OnDestroy, HostListener, ElementRef, effect, untracked, ViewChild, ChangeDetectorRef, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { UiStateService } from '../../../../services/ui-state.service';
import { ProjectStateService } from '../../../../services/project-state.service';
import { UserSessionService } from '../../../../services/user-session.service';
import { ToastService } from '../../../../services/toast.service';
import { Task, Attachment } from '../../../../models';
import { SafeMarkdownPipe } from '../../../shared/pipes/safe-markdown.pipe';
import { FlowTaskDetailFormService } from '../services/flow-task-detail-form.service';
import { FlowTaskOperationsService } from '../services/flow-task-operations.service';
import { toggleMarkdownTodo, getTodoIndexFromClick, handleMarkdownLinkAction } from '../../../../utils/markdown';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
import { SimpleReminderService } from '../../../../services/simple-reminder.service';
import { KnowledgeAnchorComponent } from '../../../shared/components/knowledge-anchor/knowledge-anchor.component';

const IGNORE_PREVIEW_CLICK_AFTER_TASK_SWITCH_MS = 180;

/** 任务详情面板 - 桌面端：浮动面板, 移动端：底部抽屉, 默认预览模式 */
@Component({
  selector: 'app-flow-task-detail',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, SafeMarkdownPipe, KnowledgeAnchorComponent],
  providers: [FlowTaskDetailFormService],
  // Host defaults to pointer-events none; interactive children explicitly opt in.
  host: { style: 'pointer-events: none' },
  template: `
    <!-- 桌面端可拖动浮动面板 -->
    @if (!uiState.isMobile() && uiState.isFlowDetailOpen()) {
      <div class="absolute z-20 pointer-events-auto"
           draggable="false"
           (dragstart)="$event.preventDefault(); $event.stopPropagation()"
           [style.right.px]="position().x < 0 ? 0 : null"
           [style.top.px]="position().y < 0 ? 24 : position().y"
           [style.left.px]="position().x >= 0 ? position().x : null">
         <div class="w-64 max-h-96 bg-white/95 dark:bg-stone-800/95 backdrop-blur-xl border border-stone-200/50 dark:border-stone-600/50 shadow-xl overflow-hidden flex flex-col rounded-xl">
             <!-- 可拖动标题栏 - 双击重置位置 -->
             <div class="px-3 py-2 border-b border-stone-100 dark:border-stone-700 flex justify-between items-center cursor-move select-none bg-gradient-to-r from-stone-50 dark:from-stone-700 to-white dark:to-stone-800"
                  (mousedown)="startDrag($event)"
                  (touchstart)="startDrag($event)"
                  (dblclick)="resetPosition()"
                   title="拖动移动面板，双击重置位置">
                 <div class="flex items-center gap-1.5">
                      <span class="text-[8px] text-stone-400 dark:text-stone-500">☰</span>
                      <h3 class="font-bold text-stone-700 dark:text-stone-200 text-xs">任务详情</h3>
                 </div>
                 <button (click)="uiState.isFlowDetailOpen.set(false)" class="text-stone-400 dark:text-stone-500 hover:text-stone-600 dark:hover:text-stone-300 p-1">
                   <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                     <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                   </svg>
                 </button>
             </div>
                 
             <div class="flex-1 overflow-y-auto px-3 py-2 space-y-2 select-none">
                 @if (task(); as t) {
                     <ng-container *ngTemplateOutlet="taskContent; context: { $implicit: t }"></ng-container>
                 } @else if (projectState.activeProject()) {
                     <div class="text-[11px] space-y-1">
                         <div class="font-bold text-stone-800 dark:text-stone-100">{{projectState.activeProject()?.name}}</div>
                         <div class="text-stone-400 dark:text-stone-500 font-mono text-[10px]">{{projectState.activeProject()?.createdDate | date:'yyyy-MM-dd'}}</div>
                         <div class="text-stone-500 dark:text-stone-400 mt-1">{{projectState.activeProject()?.description}}</div>
                     </div>
                 } @else {
                     <div class="py-4 text-center text-stone-400 dark:text-stone-500 text-[10px]">
                         双击节点查看详情
                     </div>
                 }
             </div>
         </div>
      </div>
    }
    
    <!-- 桌面端详情开启按钮 -->
    @if (!uiState.isMobile() && !uiState.isFlowDetailOpen()) {
      <button (click)="uiState.isFlowDetailOpen.set(true)" 
              class="absolute top-6 right-2 z-20 pointer-events-auto bg-white/90 dark:bg-stone-800/90 backdrop-blur border border-stone-200 dark:border-stone-600 rounded-lg p-2 shadow-sm hover:bg-white dark:hover:bg-stone-700 text-stone-400 dark:text-stone-500 hover:text-stone-600 dark:hover:text-stone-300 transition-all flex items-center gap-1">
          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span class="text-[10px] font-medium">详情</span>
      </button>
    }

    <!-- 移动端顶部小型标签触发器 -->
    @if (uiState.isMobile() && !uiState.isFlowDetailOpen()) {
      <button 
        (click)="uiState.isFlowDetailOpen.set(true)"
        class="absolute top-2 right-2 z-25 pointer-events-auto bg-white/90 dark:bg-stone-800/90 backdrop-blur rounded-lg shadow-sm border border-stone-200 dark:border-stone-600 px-2 py-1 flex items-center gap-1 text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200">
        <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <span class="text-[10px] font-medium">详情</span>
      </button>
    }
    
    <!-- 移动端顶部下拉抽屉面板 -->
    @if (uiState.isMobile() && uiState.isFlowDetailOpen()) {
       <div
         #mobileDrawer
         draggable="false"
         (dragstart)="$event.preventDefault(); $event.stopPropagation()"
         class="absolute left-0 right-0 z-30 pointer-events-auto bg-white/95 dark:bg-stone-800/95 backdrop-blur-xl border-b border-stone-200 dark:border-stone-700 shadow-[0_4px_20px_rgba(0,0,0,0.1)] rounded-b-2xl flex flex-col transition-all duration-100"
           [style.top.px]="0"
           [style.height.vh]="drawerHeight()"
           style="transform: translateZ(0); backface-visibility: hidden;">
        <!-- 标题栏 - 左边留出空间避开导航按钮，紧凑布局 -->
         <div
           #mobileDrawerTitle
           class="pr-3 pl-3 pt-0.5 pb-0 flex justify-between items-center flex-shrink-0">
          <h3 class="font-bold text-stone-700 dark:text-stone-200 text-xs">任务详情</h3>
        </div>
        
        <!-- 内容区域 - 更紧凑 -->
        <div
             #mobileDrawerContent
             class="mobile-drawer-content flex-1 overflow-y-auto px-3 pb-1 overscroll-contain"
             (touchstart)="onContentTouchStart($event)"
             (touchmove)="onContentTouchMove($event)"
             style="-webkit-overflow-scrolling: touch; touch-action: pan-y; transform: translateZ(0); contain: layout style paint;">
          @if (task(); as t) {
            <ng-container *ngTemplateOutlet="mobileTaskContent; context: { $implicit: t }"></ng-container>
          } @else {
            <div class="text-center text-stone-400 text-xs py-1">双击节点查看详情</div>
          }
        </div>
        
        <!-- 拖动条 - 紧凑 -->
           <div
             #mobileDrawerHandle
             class="relative flex justify-center py-1 cursor-grab active:cursor-grabbing touch-none flex-shrink-0"
             (touchstart)="startDrawerResize($event)"
             (mousedown)="startDrawerResize($event)"
             style="transform: translateZ(0); will-change: transform;">
          <div class="w-10 h-1 bg-stone-300 rounded-full"></div>
          <button (click)="uiState.isFlowDetailOpen.set(false); $event.stopPropagation()" 
                  (touchstart)="$event.stopPropagation()"
                  (mousedown)="$event.stopPropagation()"
                  class="absolute right-3 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-600 transition-all pointer-events-auto">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" class="transition-all h-3 w-3">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
            </svg>
          </button>
        </div>
      </div>
    }
    
    <!-- 桌面端任务内容模板 -->
    <ng-template #taskContent let-task>
      <div class="space-y-2">
          <div class="flex items-center justify-between">
              <div class="flex items-center gap-2 text-[10px]">
                  <span class="font-bold text-retro-muted dark:text-stone-400 bg-stone-100 dark:bg-stone-700 px-1.5 py-0.5 rounded">{{projectState.compressDisplayId(task.displayId)}}</span>
                  <span class="text-stone-400">{{task.createdDate | date:'MM-dd'}}</span>
                @if (task.parkingMeta?.state === 'parked') {
                  <span class="px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 font-medium" title="已停泊">⛵ 停泊</span>
                }
                <span data-testid="flow-task-status-badge" class="px-1.5 py-0.5 rounded"
                        [ngClass]="{
                          'bg-emerald-100': task.status === 'completed',
                          'dark:bg-emerald-900/30': task.status === 'completed',
                          'text-emerald-700': task.status === 'completed',
                          'dark:text-emerald-300': task.status === 'completed',
                          'bg-amber-100': task.status !== 'completed',
                          'dark:bg-amber-900/30': task.status !== 'completed',
                          'text-amber-700': task.status !== 'completed',
                          'dark:text-amber-300': task.status !== 'completed'
                        }">
                    {{task.status === 'completed' ? '完成' : '进行中'}}
                  </span>
              </div>
              <button 
                  (click)="onEditToggleClick()"
                data-testid="flow-edit-toggle-btn"
                  class="text-[9px] px-1.5 py-0.5 rounded transition-all duration-200"
                  [ngClass]="{
                    'bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-300': isEditMode(),
                    'bg-stone-100 dark:bg-stone-700 text-stone-500 dark:text-stone-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/20': !isEditMode(),
                    'scale-95 opacity-70': isTogglingMode()
                  }"
                  [disabled]="isTogglingMode()">
                  {{ isEditMode() ? '预览' : '编辑' }}
              </button>
          </div>

          @if (!isEditMode()) {
              <div class="cursor-pointer" (click)="onPreviewClick($event)">
                <h4 data-testid="flow-task-title" class="text-xs font-medium text-stone-800 dark:text-stone-200 mb-1">{{ task.title || '无标题' }}</h4>
                  @if (localContent() || task.content) {
                      <div 
                          class="text-[11px] text-stone-600 dark:text-stone-300 leading-relaxed markdown-preview bg-retro-muted/5 border border-retro-muted/20 rounded-lg p-2 max-h-32 overflow-y-auto overflow-x-hidden"
                          [innerHTML]="(localContent() || task.content) | safeMarkdown:'raw'">
                      </div>
                  } @else {
                      <div class="text-[11px] text-stone-400 dark:text-stone-500 italic">点击编辑内容...</div>
                  }
              </div>
           } @else {
               <input data-testid="flow-task-title-input" type="text" 
                  [ngModel]="localTitle()" 
                  (ngModelChange)="onLocalTitleChange($event)"
                  (focus)="onInputFocus('title')"
                  (blur)="onInputBlur('title')"
                  (mousedown)="formService.isSelecting = true"
                  (mouseup)="formService.isSelecting = false"
                  spellcheck="false"
                  class="w-full text-xs font-medium text-stone-800 dark:text-stone-100 border border-stone-200 dark:border-stone-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-300 dark:focus:ring-indigo-500 bg-white dark:bg-stone-700"
                  placeholder="任务标题">
              
              <textarea 
                  [ngModel]="localContent()" 
                  (ngModelChange)="onLocalContentChange($event)" 
                  rows="4"
                  (focus)="onInputFocus('content')"
                  (blur)="onInputBlur('content')"
                  (mousedown)="formService.isSelecting = true"
                  (mouseup)="formService.isSelecting = false"
                  spellcheck="false"
                  class="w-full text-[11px] text-stone-600 dark:text-stone-300 border border-stone-200 dark:border-stone-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-300 dark:focus:ring-indigo-500 bg-white dark:bg-stone-700 resize-none font-mono leading-relaxed"
                  placeholder="输入内容（支持 Markdown）..."></textarea>
              <div class="grid grid-cols-3 gap-1.5">
                <input
                  type="number"
                  min="1"
                  [ngModel]="task.expected_minutes ?? ''"
                  (ngModelChange)="onExpectedMinutesChange(task.id, $event)"
                  class="w-full text-[10px] border border-stone-200 dark:border-stone-600 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-indigo-300 dark:focus:ring-indigo-500 bg-white dark:bg-stone-700"
                  placeholder="预计(min)">
                <select
                  [ngModel]="task.cognitive_load ?? ''"
                  (ngModelChange)="onCognitiveLoadChange(task.id, $event)"
                  class="w-full text-[10px] border border-stone-200 dark:border-stone-600 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-indigo-300 dark:focus:ring-indigo-500 bg-white dark:bg-stone-700 text-stone-600 dark:text-stone-300">
                  <option value="">负荷未设</option>
                  <option value="low">低负荷</option>
                  <option value="high">高负荷</option>
                </select>
                <input
                  type="number"
                  min="1"
                  [ngModel]="task.wait_minutes ?? ''"
                  (ngModelChange)="onWaitMinutesChange(task.id, $event)"
                  class="w-full text-[10px] border border-stone-200 dark:border-stone-600 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-indigo-300 dark:focus:ring-indigo-500 bg-white dark:bg-stone-700"
                  placeholder="等待(min)">
               </div>
           }

           <app-knowledge-anchor
             [taskId]="task.id"
             [isMobile]="false"
             [editable]="isEditMode()"
             [manageable]="!isEditMode()"
             [compact]="!isEditMode()">
           </app-knowledge-anchor>

           <div class="flex gap-1.5 pt-1">
              <button (click)="addSibling.emit(task)"
                  class="flex-1 px-2 py-1 bg-retro-teal/10 hover:bg-retro-teal text-retro-teal hover:text-white border border-retro-teal/30 text-[10px] font-medium rounded transition-all">
                  +同级
              </button>
              <button (click)="addChild.emit(task)"
                  class="flex-1 px-2 py-1 bg-retro-rust/10 hover:bg-retro-rust text-retro-rust hover:text-white border border-retro-rust/30 text-[10px] font-medium rounded transition-all">
                  +下级
              </button>
              <button (click)="toggleStatus.emit(task)"
                  data-testid="toggle-task-status-btn"
                  class="flex-1 px-2 py-1 text-[10px] font-medium rounded transition-all border"
                  [ngClass]="{
                    'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-700': task.status !== 'completed',
                    'bg-stone-50 dark:bg-stone-700 text-stone-600 dark:text-stone-300 border-stone-200 dark:border-stone-600': task.status === 'completed'
                  }">
                  {{task.status === 'completed' ? '撤销' : '完成'}}
              </button>
          </div>
          <div class="flex gap-1.5">
              <button (click)="archiveTask.emit(task)"
                  class="flex-1 px-2 py-1 text-[10px] font-medium rounded transition-all border"
                  [ngClass]="{
                    'bg-violet-50 dark:bg-violet-900/30 text-violet-600 dark:text-violet-300 border-violet-200 dark:border-violet-700': task.status !== 'archived',
                    'bg-stone-50 dark:bg-stone-700 text-stone-600 dark:text-stone-300 border-stone-200 dark:border-stone-600': task.status === 'archived'
                  }"
                  title="归档后任务将从主视图隐藏，可在回收站恢复">
                  {{task.status === 'archived' ? '取消归档' : '归档'}}
              </button>
              <button data-testid="flow-task-park-button" (click)="onParkTaskClick(task, $event)"
                  class="flex-1 px-2 py-1 bg-amber-50 dark:bg-amber-900/20 hover:bg-amber-500 text-amber-600 dark:text-amber-400 hover:text-white border border-amber-200 dark:border-amber-700 hover:border-amber-500 text-[10px] font-medium rounded transition-all"
                  title="停泊任务，稍后处理">
                  停泊
              </button>
              <div class="relative flex-1" (mouseleave)="closeReminderMenu()">
                <button
                  type="button"
                  data-testid="flow-task-reminder-trigger"
                  (click)="onReminderTriggerClick(task, $event)"
                  class="w-full px-2 py-1 text-[10px] font-medium rounded transition-all border"
                  [ngClass]="task.parkingMeta?.state === 'parked'
                    ? 'bg-sky-50 dark:bg-sky-900/20 hover:bg-sky-500 text-sky-600 dark:text-sky-300 hover:text-white border-sky-200 dark:border-sky-700'
                    : 'bg-sky-50/70 dark:bg-sky-900/15 text-sky-600 dark:text-sky-300 border-sky-200 dark:border-sky-700 hover:bg-sky-100 dark:hover:bg-sky-900/25'">
                  {{ task.parkingMeta?.reminder ? '提醒已设' : '提醒' }}
                </button>
                @if (showReminderMenu()) {
                  <div
                    class="absolute bottom-full right-0 mb-2 min-w-[120px] rounded-lg border border-stone-200 dark:border-stone-700 bg-white/95 dark:bg-stone-800/95 shadow-lg p-1.5 z-10"
                    data-testid="flow-task-reminder-menu">
                    @for (preset of reminderPresets; track preset.minutes) {
                      <button
                        type="button"
                        [attr.data-testid]="'flow-task-reminder-preset-' + preset.minutes"
                        (click)="setReminderPreset(task.id, preset.minutes); $event.stopPropagation()"
                        class="w-full text-left px-2 py-1 text-[10px] rounded hover:bg-stone-100 dark:hover:bg-stone-700 text-stone-600 dark:text-stone-300">
                        {{ preset.label }}
                      </button>
                    }
                    @if (task.parkingMeta?.reminder) {
                      <button
                        type="button"
                        data-testid="flow-task-reminder-clear"
                        (click)="clearReminder(task.id); $event.stopPropagation()"
                        class="w-full text-left px-2 py-1 text-[10px] rounded hover:bg-stone-100 dark:hover:bg-stone-700 text-stone-500 dark:text-stone-400">
                        取消提醒
                      </button>
                    }
                  </div>
                }
              </div>
              <button data-testid="delete-task-btn" (click)="deleteTask.emit(task)"
                  class="px-2 py-1 bg-stone-50 dark:bg-stone-700 hover:bg-red-500 dark:hover:bg-red-600 text-stone-400 dark:text-stone-500 hover:text-white border border-stone-200 dark:border-stone-600 text-[10px] font-medium rounded transition-all">
                  删除
              </button>
          </div>
      </div>
    </ng-template>
    
    <!-- 移动端任务内容模式-->
    <ng-template #mobileTaskContent let-task>
      <div class="flex items-center gap-1.5 mb-1 flex-wrap">
        <span class="font-bold text-retro-muted dark:text-stone-400 text-[8px] tracking-wider bg-stone-100 dark:bg-stone-700 px-1.5 py-0.5 rounded">{{projectState.compressDisplayId(task.displayId)}}</span>
        <span class="text-[9px] text-stone-400">{{task.createdDate | date:'MM-dd'}}</span>
        @if (task.parkingMeta?.state === 'parked') {
          <span class="text-[8px] px-1 py-0.5 rounded bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 font-medium" title="已停泊">⛵ 停泊</span>
        }
        <span class="text-[9px] px-1 py-0.5 rounded"
              [ngClass]="{
                'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300': task.status === 'completed',
                'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300': task.status !== 'completed'
              }">
          {{task.status === 'completed' ? '完成' : '进行中'}}
        </span>
        <button 
          (click)="onEditToggleClick()"
          class="ml-auto text-[9px] px-1.5 py-0.5 rounded transition-all duration-200"
          [ngClass]="{
            'bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-300': !isEditMode(),
            'bg-stone-100 dark:bg-stone-700 text-stone-500 dark:text-stone-400': isEditMode(),
            'scale-95 opacity-70': isTogglingMode()
          }"
          [disabled]="isTogglingMode()">
          {{ isEditMode() ? '预览' : '编辑' }}
        </button>
      </div>

      @if (!isEditMode()) {
        <div class="cursor-pointer space-y-1" (click)="onPreviewClick($event)">
          <h4 class="text-xs font-medium text-stone-800 dark:text-stone-100 leading-tight" [class.line-clamp-1]="isCompactMode()">{{ task.title || '无标题' }}</h4>
          @if (localContent() || task.content) {
            <div class="text-[11px] text-stone-600 leading-relaxed markdown-preview overflow-hidden max-h-28" [innerHTML]="(localContent() || task.content) | safeMarkdown:'raw'"></div>
          }
        </div>
      } @else {
        <div class="space-y-1.5">
          <input type="text" 
            [ngModel]="localTitle()" 
            (ngModelChange)="onLocalTitleChange($event)"
            (focus)="onInputFocus('title')"
            (blur)="onInputBlur('title')"
            (mousedown)="formService.isSelecting = true"
            (mouseup)="formService.isSelecting = false"
            spellcheck="false"
            class="w-full text-xs font-medium text-stone-800 dark:text-stone-100 border border-stone-200 dark:border-stone-600 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-indigo-300 dark:focus:ring-indigo-500 bg-white dark:bg-stone-700"
            placeholder="任务标题">
          <textarea 
            [ngModel]="localContent()" 
            (ngModelChange)="onLocalContentChange($event)" 
            rows="3"
            (focus)="onInputFocus('content')"
            (blur)="onInputBlur('content')"
            (mousedown)="formService.isSelecting = true"
            (mouseup)="formService.isSelecting = false"
            spellcheck="false"
            class="w-full text-[11px] text-stone-600 dark:text-stone-300 border border-stone-200 dark:border-stone-600 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-indigo-300 dark:focus:ring-indigo-500 bg-white dark:bg-stone-700 resize-none font-mono"
            placeholder="任务内容（支持 Markdown）..."></textarea>
          <div class="grid grid-cols-3 gap-1">
            <input
              type="number"
              min="1"
              [ngModel]="task.expected_minutes ?? ''"
              (ngModelChange)="onExpectedMinutesChange(task.id, $event)"
              class="w-full text-[10px] border border-stone-200 dark:border-stone-600 rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-indigo-300 dark:focus:ring-indigo-500 bg-white dark:bg-stone-700"
              placeholder="预计(min)">
            <select
              [ngModel]="task.cognitive_load ?? ''"
              (ngModelChange)="onCognitiveLoadChange(task.id, $event)"
              class="w-full text-[10px] border border-stone-200 dark:border-stone-600 rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-indigo-300 dark:focus:ring-indigo-500 bg-white dark:bg-stone-700 text-stone-600 dark:text-stone-300">
              <option value="">负荷未设</option>
              <option value="low">低负荷</option>
              <option value="high">高负荷</option>
            </select>
            <input
              type="number"
              min="1"
              [ngModel]="task.wait_minutes ?? ''"
              (ngModelChange)="onWaitMinutesChange(task.id, $event)"
              class="w-full text-[10px] border border-stone-200 dark:border-stone-600 rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-indigo-300 dark:focus:ring-indigo-500 bg-white dark:bg-stone-700"
              placeholder="等待(min)">
          </div>
          <div class="flex items-center gap-1 bg-retro-rust/5 border border-retro-rust/20 rounded overflow-hidden p-0.5">
            <span class="text-retro-rust flex-shrink-0 text-[10px] pl-1">☰</span>
            <input
              #quickTodoInput
              type="text"
              (keydown.enter)="addQuickTodo(task.id, quickTodoInput)"
              spellcheck="false"
              class="flex-1 bg-transparent border-none outline-none text-stone-600 placeholder-stone-400 text-[10px] py-0.5 px-1"
              placeholder="待办，回车添加...">
            <button
              (click)="addQuickTodo(task.id, quickTodoInput)"
              class="flex-shrink-0 bg-retro-rust/10 hover:bg-retro-rust text-retro-rust hover:text-white rounded p-0.5 mr-0.5 transition-all">
              <svg class="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            </button>
          </div>
        </div>
      }

      <app-knowledge-anchor
        class="mt-1 block"
        [taskId]="task.id"
        [isMobile]="true"
        [editable]="isEditMode()"
        [manageable]="!isEditMode()"
        [compact]="!isEditMode()">
      </app-knowledge-anchor>
       
      <!-- 操作按钮 -->
      <div
           #mobileActionSection
           data-mobile-action-section
           class="overflow-hidden transition-all duration-150"
           [class.max-h-0]="isCompactMode()"
           [class.opacity-0]="isCompactMode()"
           [class.pointer-events-none]="isCompactMode()"
           [class.max-h-32]="!isCompactMode()"
           [class.opacity-100]="!isCompactMode()">
        <div class="flex gap-1 mt-2">
          <button (click)="addSibling.emit(task)"
            class="flex-1 px-1.5 py-1 bg-retro-teal/10 text-retro-teal border border-retro-teal/30 text-[9px] font-medium rounded transition-all">
            +同级
          </button>
          <button (click)="addChild.emit(task)"
            class="flex-1 px-1.5 py-1 bg-retro-rust/10 text-retro-rust border border-retro-rust/30 text-[9px] font-medium rounded transition-all">
            +下级
          </button>
          <button (click)="toggleStatus.emit(task)"
            class="flex-1 px-1.5 py-1 text-[9px] font-medium rounded border transition-all"
            [ngClass]="{
              'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-700': task.status !== 'completed',
              'bg-stone-50 dark:bg-stone-700 text-stone-600 dark:text-stone-300 border-stone-200 dark:border-stone-600': task.status === 'completed'
            }">
            {{task.status === 'completed' ? '撤销' : '完成'}}
          </button>
        </div>
        <div class="flex gap-1 mt-1">
          <button (click)="archiveTask.emit(task)"
            class="flex-1 px-1.5 py-1 text-[9px] font-medium rounded transition-all border"
            [ngClass]="{
              'bg-violet-50 dark:bg-violet-900/30 text-violet-600 dark:text-violet-300 border-violet-200 dark:border-violet-700': task.status !== 'archived',
              'bg-stone-50 dark:bg-stone-700 text-stone-600 dark:text-stone-300 border-stone-200 dark:border-stone-600': task.status === 'archived'
            }">
            {{task.status === 'archived' ? '取消归档' : '归档'}}
          </button>
          <button (click)="onParkTaskClick(task, $event)"
            class="flex-1 px-1.5 py-1 bg-amber-50 dark:bg-amber-900/20 hover:bg-amber-500 text-amber-600 dark:text-amber-400 hover:text-white border border-amber-200 dark:border-amber-700 hover:border-amber-500 text-[9px] font-medium rounded transition-all"
            title="停泊任务，稍后处理">
            停泊
          </button>
          <button
            #mobileDeleteButton
            data-mobile-delete-button
            (click)="deleteTask.emit(task)"
            class="px-1.5 py-1 bg-stone-50 dark:bg-stone-700 text-stone-400 dark:text-stone-500 border border-stone-200 dark:border-stone-600 hover:bg-red-500 dark:hover:bg-red-600 hover:text-white hover:border-red-500 text-[9px] font-medium rounded transition-all">
            删除
          </button>
        </div>
      </div>
    </ng-template>
  `
})
export class FlowTaskDetailComponent implements OnDestroy {
  // P2-1 迁移：直接注入子服务
  readonly uiState = inject(UiStateService);
  readonly projectState = inject(ProjectStateService);
  readonly userSession = inject(UserSessionService);
  private readonly toast = inject(ToastService);
  private readonly elementRef = inject(ElementRef);
  private readonly cdr = inject(ChangeDetectorRef);
  readonly formService = inject(FlowTaskDetailFormService);
  private readonly flowTaskOps = inject(FlowTaskOperationsService);
  private readonly taskOpsAdapter = inject(TaskOperationAdapterService);
  private readonly reminderService = inject(SimpleReminderService);

  @ViewChild('mobileDrawer') private mobileDrawer?: ElementRef<HTMLDivElement>;
  @ViewChild('mobileDrawerTitle') private mobileDrawerTitle?: ElementRef<HTMLDivElement>;
  @ViewChild('mobileDrawerContent') private mobileDrawerContent?: ElementRef<HTMLDivElement>;
  @ViewChild('mobileDrawerHandle') private mobileDrawerHandle?: ElementRef<HTMLDivElement>;

  private static readonly MOBILE_DRAWER_GUARD_PX = 4;
  private static readonly MOBILE_DRAWER_MIN_VH = 8;
  private static readonly MOBILE_DRAWER_MAX_VH = 70;
  private static readonly MOBILE_DRAWER_HEIGHT_EPSILON_VH = 0.3;
  readonly showReminderMenu = signal(false);
  readonly reminderPresets = [
    { label: '5m', minutes: 5 },
    { label: '30m', minutes: 30 },
    { label: '2h', minutes: 120 },
  ] as const;
  
  // 输入
  readonly task = input<Task | null>(null);
  readonly position = input<{ x: number; y: number }>({ x: -1, y: -1 });
  readonly drawerHeight = input<number>(35); // vh unit
  readonly autoHeightEnabled = input<boolean>(true);
  readonly layoutTick = input<number>(0);

  // Form state delegated to FlowTaskDetailFormService
  readonly localTitle = this.formService.localTitle;
  readonly localContent = this.formService.localContent;
  readonly isEditMode = this.formService.isEditMode;
  readonly isTogglingMode = this.formService.isTogglingMode;

  readonly isCompactMode = computed(() => !this.autoHeightEnabled() && this.drawerHeight() < 12);
  readonly contentMaxHeight = computed(() => {
    const height = this.drawerHeight();
    if (height < 15) return 'max-h-8';
    if (height < 25) return 'max-h-16';
    if (height < 35) return 'max-h-24';
    return 'max-h-28';
  });

  // Outputs
  readonly positionChange = output<{ x: number; y: number }>();
  readonly drawerHeightChange = output<number>();
  readonly isResizingChange = output<boolean>();
  
  // 任务操作输出
  readonly titleChange = output<{ taskId: string; title: string }>();
  readonly contentChange = output<{ taskId: string; content: string }>();
  readonly addSibling = output<Task>();
  readonly addChild = output<Task>();
  readonly toggleStatus = output<Task>();
  readonly archiveTask = output<Task>();
  readonly deleteTask = output<Task>();
  readonly parkTask = output<Task>();
  readonly openLinkedTask = output<string>();
  readonly quickTodoAdd = output<{ taskId: string; text: string }>();
  
  // 附件操作输出
  readonly attachmentAdd = output<{ taskId: string; attachment: Attachment }>();
  readonly attachmentRemove = output<{ taskId: string; attachmentId: string }>();
  readonly attachmentsChange = output<{ taskId: string; attachments: Attachment[] }>();
  readonly attachmentError = output<string>();
  
  // 拖动状态
  private dragState = { isDragging: false, startX: 0, startY: 0, offsetX: 0, offsetY: 0 };
  private isResizingDrawer = false;
  private drawerStartY = 0;
  private drawerStartHeight = 0;
  private autoHeightRafId: number | null = null;
  private autoHeightTimer: ReturnType<typeof setTimeout> | null = null;
  private lastAutoHeightSignature = '';
  private lastEmittedVh = -1;
  private isComponentDestroyed = false;
  private ignorePreviewClicksUntil = 0;
  private suppressedDocumentClickStamp: number | null = null;
  
  constructor() {
    // Split-Brain 核心逻辑：委托给 formService
    this.formService.initSyncEffect(() => this.task());

    // 任务切换或详情面板重新打开后，短时间内忽略预览区点击，避免选择任务的同一击穿透到编辑态。
    effect(() => {
      const taskId = this.task()?.id ?? null;
      const isOpen = this.uiState.isFlowDetailOpen();

      if (!isOpen) {
        this.ignorePreviewClicksUntil = 0;
        return;
      }

      if (taskId) {
        untracked(() => this.armPreviewEntryGuard());
      }
    });

    // 🔴 移动端自动高度：统一的触发入口（任务/编辑模式变化 + layoutTick 变化）    // 合并为单一 effect，通过签名去重，避免多个 effect 并发触发导致抖动
    effect(() => {
      const task = this.task();
      const isEdit = this.isEditMode();
      const isOpen = this.uiState.isFlowDetailOpen();
      const tick = this.layoutTick();
      
      if (this.uiState.isMobile() && isOpen) {
        const signature = task
          ? `${task.id}|${task.title}|${task.content}|${task.status}|${isEdit ? '1' : '0'}|${tick}`
          : `empty|${isEdit ? '1' : '0'}|${tick}`;
        if (signature === this.lastAutoHeightSignature) return;
        this.lastAutoHeightSignature = signature;
        // 重置发射缓存，允许新一轮测量
        this.lastEmittedVh = -1;
        untracked(() => this.requestAutoHeight());
      } else {
        this.lastAutoHeightSignature = '';
        this.lastEmittedVh = -1;
      }
    });
  }

  private armPreviewEntryGuard(): void {
    this.ignorePreviewClicksUntil = Date.now() + IGNORE_PREVIEW_CLICK_AFTER_TASK_SWITCH_MS;
  }

  // ========== 表单事件委托 ==========

  /**
   * 移动端：请求自动调整高度以适应内容。   *
   * 核心算法：targetPx = titleH + intrinsicContentH + handleH + guard
   * 只使用内容子元素的固有高度，不引入 containerH > contentClientH，
   * 从而确保算法幂等，无论当前抽屉多高，计算结果都一致。
   */
  private requestAutoHeight(): void {
    if (this.isComponentDestroyed) return;
    if (!this.uiState.isMobile() || !this.uiState.isFlowDetailOpen()) return;
    if (!this.autoHeightEnabled()) return;

    // 取消先前的挂起测量，避免多次 emit
    this.cancelPendingAutoHeight();

    this.autoHeightRafId = requestAnimationFrame(() => {
      this.autoHeightRafId = null;
      if (this.isComponentDestroyed) return;
      this.measureAndEmitHeight();
      // 一次延迟收敛：等字段样式稳定后再校验
      this.autoHeightTimer = setTimeout(() => {
        this.autoHeightTimer = null;
        if (!this.isComponentDestroyed) this.measureAndEmitHeight();
      }, 150);
    });
  }

  /**
   * 纯测量 + 发射：不依赖当前容器高度，只用子元素固有尺寸。   * 幂等：同样的内容调用 N 次结果一致，第二次不会 emit。   */
  private measureAndEmitHeight(): void {
    const container = this.mobileDrawer?.nativeElement
      ?? this.elementRef.nativeElement.querySelector('.absolute.left-0.right-0.z-30');
    const title = this.mobileDrawerTitle?.nativeElement
      ?? container?.querySelector('.flex-shrink-0');
    const content = this.mobileDrawerContent?.nativeElement
      ?? container?.querySelector('.overflow-y-auto');
    const handle = this.mobileDrawerHandle?.nativeElement
      ?? container?.querySelector('.touch-none.flex-shrink-0');

    if (!container || !title || !content || !handle) return;
    const viewportHeight = this.getViewportHeight();
    if (viewportHeight <= 0) return;

    const titleH = (title as HTMLElement).offsetHeight || 0;
    const handleH = (handle as HTMLElement).offsetHeight || 0;
    const intrinsicContentH = this.measureIntrinsicContentHeight(content as HTMLElement);

    const targetPx = titleH + intrinsicContentH + handleH
      + FlowTaskDetailComponent.MOBILE_DRAWER_GUARD_PX;
    const maxPx = (FlowTaskDetailComponent.MOBILE_DRAWER_MAX_VH / 100) * viewportHeight;
    const clampedPx = Math.max(titleH + handleH + 10, Math.min(targetPx, maxPx));
    const targetVh = Math.max(
      FlowTaskDetailComponent.MOBILE_DRAWER_MIN_VH,
      Math.min((clampedPx / viewportHeight) * 100, FlowTaskDetailComponent.MOBILE_DRAWER_MAX_VH)
    );

    // 只在与上一次发射值有显著差异时 emit
    if (Math.abs(this.lastEmittedVh - targetVh) > FlowTaskDetailComponent.MOBILE_DRAWER_HEIGHT_EPSILON_VH) {
      this.lastEmittedVh = targetVh;
      this.drawerHeightChange.emit(targetVh);
    }
  }

  private getViewportHeight(): number {
    if (typeof window === 'undefined') return 0;
    const visualHeight = window.visualViewport?.height ?? 0;
    return visualHeight > 0 ? visualHeight : window.innerHeight;
  }

  /**
   * 测量内容区所有子元素的固有高度总和（含 padding/margin）。   * 不依赖 scrollHeight/clientHeight（它们会随容器尺寸变化）。   */
  private measureIntrinsicContentHeight(contentEl: HTMLElement): number {
    if (typeof window === 'undefined') return 0;
    const children = Array.from(contentEl.children) as HTMLElement[];
    if (children.length === 0) return 0;

    const contentStyle = window.getComputedStyle(contentEl);
    const paddingTop = Number.parseFloat(contentStyle.paddingTop || '0') || 0;
    const paddingBottom = Number.parseFloat(contentStyle.paddingBottom || '0') || 0;

    let totalChildrenHeight = 0;
    for (const child of children) {
      const rect = child.getBoundingClientRect();
      const style = window.getComputedStyle(child);
      const marginTop = Number.parseFloat(style.marginTop || '0') || 0;
      const marginBottom = Number.parseFloat(style.marginBottom || '0') || 0;
      totalChildrenHeight += rect.height + marginTop + marginBottom;
    }

    return Math.max(0, totalChildrenHeight + paddingTop + paddingBottom);
  }

  private cancelPendingAutoHeight(): void {
    if (this.autoHeightRafId !== null) {
      cancelAnimationFrame(this.autoHeightRafId);
      this.autoHeightRafId = null;
    }
    if (this.autoHeightTimer !== null) {
      clearTimeout(this.autoHeightTimer);
      this.autoHeightTimer = null;
    }
  }
  
  /** 输入框聚焦处理 */
  onInputFocus(field: 'title' | 'content') {
    this.uiState.markEditing();
    this.formService.onInputFocus(field, this.task());
  }

  /** 输入框失焦处理 */
  onInputBlur(field: 'title' | 'content') {
    const result = this.formService.onInputBlur(field, this.task());
    if (result) {
      if (result.field === 'title') {
        this.titleChange.emit({ taskId: result.taskId, title: result.value });
      } else {
        this.contentChange.emit({ taskId: result.taskId, content: result.value });
      }
    }
  }
  
  /** 本地标题变更 */
  onLocalTitleChange(value: string) {
    const result = this.formService.onLocalTitleChange(value, this.task());
    if (result) {
      this.titleChange.emit(result);
    }
  }

  /** 本地内容变更 */
  onLocalContentChange(value: string) {
    const result = this.formService.onLocalContentChange(value, this.task());
    if (result) {
      this.contentChange.emit(result);
    }
  }
  onExpectedMinutesChange(taskId: string, raw: string | number | null): void {
    this.taskOpsAdapter.updateTaskExpectedMinutes(taskId, this.parseOptionalMinutes(raw));
  }

  onWaitMinutesChange(taskId: string, raw: string | number | null): void {
    this.taskOpsAdapter.updateTaskWaitMinutes(taskId, this.parseOptionalMinutes(raw));
  }

  onCognitiveLoadChange(taskId: string, raw: string | null): void {
    const normalized = raw === 'high' || raw === 'low' ? raw : null;
    this.taskOpsAdapter.updateTaskCognitiveLoad(taskId, normalized);
  }

  onParkTaskClick(task: Task, event?: Event): void {
    event?.stopPropagation();
    this.flowTaskOps.parkTask(task);
    this.parkTask.emit(task);
    this.cdr.markForCheck();
  }

  toggleReminderMenu(): void {
    this.showReminderMenu.update(value => !value);
  }

  closeReminderMenu(): void {
    this.showReminderMenu.set(false);
  }

  onReminderTriggerClick(task: Task, event?: Event): void {
    event?.stopPropagation();
    if (task.parkingMeta?.state !== 'parked') {
      this.flowTaskOps.parkTask(task);
      this.parkTask.emit(task);
    }
    this.toggleReminderMenu();
  }

  setReminderPreset(taskId: string, minutes: number): void {
    const currentTask = this.task();
    if (currentTask?.id === taskId && currentTask.parkingMeta?.state !== 'parked') {
      this.flowTaskOps.parkTask(currentTask);
      this.parkTask.emit(currentTask);
    }
    const reminderAt = new Date(Date.now() + minutes * 60_000).toISOString();
    this.reminderService.setReminder(taskId, reminderAt);
    this.showReminderMenu.set(false);
    this.cdr.markForCheck();
  }

  clearReminder(taskId: string): void {
    this.reminderService.cancelReminder(taskId);
    this.showReminderMenu.set(false);
    this.cdr.markForCheck();
  }

  onEditToggleClick(): void {
    if (Date.now() < this.ignorePreviewClicksUntil && this.isEditMode()) {
      if (this.isTogglingMode()) {
        this.isTogglingMode.set(false);
      }
      return;
    }
    this.toggleEditMode();
  }

  /** 切换编辑模式 */
  toggleEditMode(): void { this.formService.toggleEditMode(); }

  /**
   * Markdown 预览区域点击处理
   * 点击待办 checkbox 时切换完成状态；点击其他区域进入编辑模式
   */
  onPreviewClick(event: MouseEvent): void {
    if (this.handlePreviewLinkClick(event)) {
      return;
    }

    event.stopPropagation();
    const todoIndex = getTodoIndexFromClick(event);
    if (todoIndex !== null) {
      const currentTask = this.task();
      if (!currentTask) return;
      const currentContent = this.formService.localContent() || currentTask.content || '';
      const newContent = toggleMarkdownTodo(currentContent, todoIndex);
      this.formService.localContent.set(newContent);
      // 直接更新 Store，确保顺序同步，避免父组件 Output 延迟
      this.taskOpsAdapter.updateTaskContent(currentTask.id, newContent);
      // 强制标记组件需要重新检测，确保 OnPush 模式下 UI 刷新
      this.cdr.markForCheck();
    } else {
      if (Date.now() < this.ignorePreviewClicksUntil) {
        return;
      }
      this.suppressedDocumentClickStamp = event.timeStamp;
      this.toggleEditMode();
    }
  }

  private handlePreviewLinkClick(event: MouseEvent): boolean {
    const linkTarget = handleMarkdownLinkAction(event, this.toast);
    if (!linkTarget) {
      return linkTarget === false;
    }

    if (linkTarget.kind === 'task' && linkTarget.taskId) {
      this.openLinkedTask.emit(linkTarget.taskId);
    }
    return true;
  }
  
  /** 监听 document 点击事件，编辑模式下点击非交互区域退出编辑 */
  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (this.suppressedDocumentClickStamp !== null) {
      const isSuppressedClick = Math.abs(event.timeStamp - this.suppressedDocumentClickStamp) < 1;
      this.suppressedDocumentClickStamp = null;
      if (isSuppressedClick) {
        return;
      }
    }
    if (this.formService.shouldExitEditMode(event.target as HTMLElement, this.elementRef.nativeElement)) {
      this.isEditMode.set(false);
      if (this.isTogglingMode()) {
        this.isTogglingMode.set(false);
      }
    }
  }

  /** 监听 document 触摸事件（移动端），编辑模式下触摸非交互区域退出编辑 */
  @HostListener('document:touchstart', ['$event'])
  onDocumentTouchStart(event: TouchEvent): void {
    const activeElement = document.activeElement;
    if (activeElement && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA')) {
      return;
    }
    if (this.formService.shouldExitEditMode(event.target as HTMLElement, this.elementRef.nativeElement)) {
      this.isEditMode.set(false);
      if (this.isTogglingMode()) {
        this.isTogglingMode.set(false);
      }
    }
  }


  
  startDrag(event: MouseEvent | TouchEvent) {
    event.preventDefault();
    const _pos = this.position();
    const clientX = event instanceof MouseEvent ? event.clientX : event.touches[0].clientX;
    const clientY = event instanceof MouseEvent ? event.clientY : event.touches[0].clientY;
    
    const target = event.target as HTMLElement;
    const panelEl = target.closest('.absolute') as HTMLElement;
    if (!panelEl) return;
    
    const parentEl = panelEl.parentElement;
    if (!parentEl) return;
    
    const parentRect = parentEl.getBoundingClientRect();
    const panelRect = panelEl.getBoundingClientRect();
    
    // 计算面板相对父容器的当前位置
    const currentX = panelRect.left - parentRect.left;
    const currentY = panelRect.top - parentRect.top;
    
    this.dragState = {
      isDragging: true,
      startX: clientX,
      startY: clientY,
      offsetX: currentX,
      offsetY: currentY
    };
    
    document.addEventListener('mousemove', this.onDrag);
    document.addEventListener('mouseup', this.stopDrag);
    document.addEventListener('touchmove', this.onDrag);
    document.addEventListener('touchend', this.stopDrag);
    window.addEventListener('blur', this.stopDrag);
  }
  
  private onDrag = (event: MouseEvent | TouchEvent) => {
    if (!this.dragState.isDragging) return;
    if (event instanceof MouseEvent && event.buttons === 0) {
      this.stopDrag();
      return;
    }
    if (event instanceof TouchEvent && event.touches.length === 0) {
      this.stopDrag();
      return;
    }
    
    const clientX = event instanceof MouseEvent ? event.clientX : event.touches[0].clientX;
    const clientY = event instanceof MouseEvent ? event.clientY : event.touches[0].clientY;
    
    const deltaX = clientX - this.dragState.startX;
    const deltaY = clientY - this.dragState.startY;
    
    // 限制面板不能被拖出可视区域    // 面板宽度 256px，高度最大 384px (max-h-96)
    const panelWidth = 256;
    const panelHeight = 384;
    const maxX = Math.max(0, window.innerWidth - panelWidth - 20); // 留 20px 边距
    const maxY = Math.max(0, window.innerHeight - panelHeight - 20);
    
    const newX = Math.max(0, Math.min(maxX, this.dragState.offsetX + deltaX));
    const newY = Math.max(0, Math.min(maxY, this.dragState.offsetY + deltaY));
    
    this.positionChange.emit({ x: newX, y: newY });
  };
  
  private stopDrag = () => {
    this.dragState.isDragging = false;
    document.removeEventListener('mousemove', this.onDrag);
    document.removeEventListener('mouseup', this.stopDrag);
    document.removeEventListener('touchmove', this.onDrag);
    document.removeEventListener('touchend', this.stopDrag);
    window.removeEventListener('blur', this.stopDrag);
  };

  /** 重置面板位置到默认位置（右上角） */
  resetPosition() { this.positionChange.emit({ x: -1, y: -1 }); }
  
  startDrawerResize(event: TouchEvent | MouseEvent) {
    event.preventDefault();
    
    // 获取起始位置
    let startY: number;
    if (event instanceof TouchEvent) {
      if (event.touches.length !== 1) return;
      startY = event.touches[0].clientY;
    } else {
      startY = event.clientY;
    }
    
    this.isResizingDrawer = true;
    this.isResizingChange.emit(true);
    this.drawerStartY = startY;
    this.drawerStartHeight = this.drawerHeight();

    // 固定最小高度为 8vh，避免频繁的 DOM 查询
    const minHeight = 8;
    
    const drawerEl = this.elementRef.nativeElement.querySelector('.absolute.z-30') as HTMLElement;
    if (drawerEl) {
      drawerEl.style.willChange = 'height';
    }
    
    let rafId: number | null = null;
    let _lastCalculatedHeight: number = this.drawerStartHeight;
    
    const onMove = (ev: TouchEvent | MouseEvent) => {
      if (!this.isResizingDrawer) return;
      ev.preventDefault();
      
      // 获取当前位置
      let currentY: number;
      if (ev instanceof TouchEvent) {
        if (ev.touches.length !== 1) return;
        currentY = ev.touches[0].clientY;
      } else {
        currentY = ev.clientY;
      }
      
      if (rafId) return;
      
      rafId = requestAnimationFrame(() => {
        rafId = null;
        if (!this.isResizingDrawer) return;

        const deltaY = currentY - this.drawerStartY;
        const viewportHeight = this.getViewportHeight();
        if (viewportHeight <= 0) return;
        const deltaVh = (deltaY / viewportHeight) * 100;
        
        const newHeight = Math.max(minHeight, Math.min(70, this.drawerStartHeight + deltaVh));
        _lastCalculatedHeight = newHeight;
        this.drawerHeightChange.emit(newHeight);
      });
    };
    
    const onEnd = () => {
      this.isResizingDrawer = false;
      this.isResizingChange.emit(false);
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      
      if (drawerEl) {
        drawerEl.style.willChange = 'auto';
      }
      
      // 移除自动关闭逻辑，允许用户自由调整到最小高度      // 最小高度由 Math.max(8, ...) 控制
      window.removeEventListener('touchmove', onMove as EventListener);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('touchcancel', onEnd);
      window.removeEventListener('mousemove', onMove as EventListener);
      window.removeEventListener('mouseup', onEnd);
    };
    
    window.addEventListener('touchmove', onMove as EventListener, { passive: false });
    window.addEventListener('touchend', onEnd);
    window.addEventListener('touchcancel', onEnd);
    window.addEventListener('mousemove', onMove as EventListener);
    window.addEventListener('mouseup', onEnd);
  }
  
  // 内容区域触摸处理 - 防止无限下拉
  onContentTouchStart(event: TouchEvent): void {
    const target = event.target as HTMLElement;
    // 检查是否是内容区域本身或可滚动的子元素
    const scrollableParent = target.closest('.overflow-y-auto') as HTMLElement;
    if (scrollableParent) {
      // 记录初始滚动位置
      scrollableParent.dataset['touchStartScrollTop'] = String(scrollableParent.scrollTop);
    }
  }

  onContentTouchMove(event: TouchEvent): void {
    const target = event.target as HTMLElement;
    const scrollableParent = target.closest('.overflow-y-auto') as HTMLElement;
    
    if (scrollableParent && !this.isResizingDrawer) {
      const scrollTop = scrollableParent.scrollTop;
      const scrollHeight = scrollableParent.scrollHeight;
      const clientHeight = scrollableParent.clientHeight;
      
      const touchStartScrollTop = Number(scrollableParent.dataset['touchStartScrollTop']) || 0;
      const _touch = event.touches[0];
      
      if ((scrollTop === 0 && scrollTop >= touchStartScrollTop) || 
          (scrollTop + clientHeight >= scrollHeight && scrollTop <= touchStartScrollTop)) {
        // 允许内部滚动，不阻止事件
        return;
      }
      
      // 更新滚动位置记录
      scrollableParent.dataset['touchStartScrollTop'] = String(scrollTop);
    }
  }

  addQuickTodo(taskId: string, inputEl: HTMLInputElement) {
    const text = inputEl.value.trim();
    if (text) {
      this.quickTodoAdd.emit({ taskId, text });
      inputEl.value = '';
      inputEl.focus();
    }
  }
  

  private parseOptionalMinutes(raw: string | number | null): number | null {
    if (raw === null || raw === undefined) return null;
    const value = String(raw).trim();
    if (!value) return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return Math.floor(parsed);
  }

  // ========== 生命周期管理 ==========
  ngOnDestroy(): void {
    this.isComponentDestroyed = true;
    this.cancelPendingAutoHeight();
    this.stopDrag();
    this.dragState.isDragging = false;
    this.isResizingDrawer = false;
    this.formService.cleanup();
  }
}
