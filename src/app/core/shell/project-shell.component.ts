import { 
  Component, 
  inject, 
  signal, 
  computed,
  OnInit, 
  OnDestroy,
  HostListener,
  DestroyRef,
  ChangeDetectionStrategy
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router, RouterOutlet, NavigationEnd } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter, startWith } from 'rxjs/operators';
import { UiStateService } from '../../../services/ui-state.service';
import { ProjectStateService } from '../../../services/project-state.service';
import { TaskOperationAdapterService } from '../../../services/task-operation-adapter.service';
import { SyncCoordinatorService } from '../../../services/sync-coordinator.service';
import { ToastService } from '../../../services/toast.service';
import { TabSyncService } from '../../../services/tab-sync.service';
import { UserSessionService } from '../../../services/user-session.service';
import { FlowCommandService } from '../../features/flow/services/flow-command.service';
import { ModalLoaderService } from '../services/modal-loader.service';
import { LoggerService } from '../../../services/logger.service';
import { DynamicModalService } from '../../../services/dynamic-modal.service';
import { AppProjectCoordinatorService } from '../services/app-project-coordinator.service';
import { DockEngineService } from '../../../services/dock-engine.service';
import { LocalBackupService } from '../../../services/local-backup.service';
// 【重要】@defer 使用的组件必须直接引用源文件，禁止走 barrel（index.ts）
// barrel 会把所有子组件一起 re-export，导致 esbuild 代码分割时 AOT 元数据丢失，
// 触发运行时 JIT 编译失败（TextStageCardComponent / FlowView 等）
import { TextViewComponent } from '../../features/text/components/text-view.component';
import { FlowViewComponent } from '../../features/flow/components/flow-view.component';
// @defer 使用的组件：直接引用源文件（同上理由）
import { ParkingDockComponent } from '../../features/parking/parking-dock.component';
import { ParkingNoticeComponent } from '../../features/parking/parking-notice.component';
import { FEATURE_FLAGS } from '../../../config/feature-flags.config';
import { STARTUP_PERF_CONFIG } from '../../../config/startup-performance.config';
import { PARKING_CONFIG } from '../../../config/parking.config';
import { HandoffCoordinatorService, shouldDegradeMobileStartupRoute } from '../../../services/handoff-coordinator.service';
import { LaunchSnapshotService } from '../../../services/launch-snapshot.service';
import { reloadViaForceClearCache } from '../../../utils/force-clear-cache';
import { resolveStartupEntryIntent } from '../../../utils/startup-entry-intent';
import {
  type DockFocusChromePhase,
} from '../../../utils/dock-focus-phase';
import {
  resolveProjectShellTakeoverFilter,
  resolveProjectShellTakeoverOpacity,
  resolveProjectShellTakeoverTransition,
  resolveProjectShellTakeoverTransform,
  resolveProjectShellTakeoverVisibility,
} from './project-shell-focus-motion';

interface NetworkInformationLike {
  effectiveType?: '4g' | '3g' | '2g' | 'slow-2g';
  saveData?: boolean;
  downlink?: number;
  rtt?: number;
}

/**
 * 项目视图外壳组件
 * 负责管理 text-view 和 flow-view 的切换显示
 * 对应路由: /projects/:projectId, /projects/:projectId/text, /projects/:projectId/flow
 * 
 * 【移动端策略】
 * 使用 @if 条件渲染完全销毁/重建 FlowView 组件。
 * 好处：
 * - 释放 GoJS canvas 占用的内存
 * - 避免僵尸模式下的 canvas 渲染问题
 * - 简化代码，无需手动 suspend/resume
 * 
 * 【Flow 加载策略】
 * 桌面端直接渲染 FlowView，避免流程图 chunk 偶发加载失败。
 * 移动端仍通过 @defer 按需挂载/销毁 FlowView，保持 GoJS 移动端资源释放策略。
 * Shell 通过 FlowCommandService 与 FlowView 解耦通信。
 */
@Component({
  selector: 'app-project-shell',
  standalone: true,
  // 【P2-22 修复】添加 OnPush 变更检测策略
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, TextViewComponent, FlowViewComponent, RouterOutlet, ParkingDockComponent, ParkingNoticeComponent],
  styles: [`
    :host {
      display: flex;
      flex: 1;
      width: 100%;
      height: 100%;
      min-height: 0;
    }
    /* 文本栏折叠时内容隐藏：收起时立即隐藏，展开时延迟显示，避免内容在窄宽度下崩坏 */
    .text-col-inner {
      opacity: 1;
      transition: opacity 50ms ease-out 250ms;
    }
    .text-col-inner--hidden {
      opacity: 0 !important;
      transition: opacity 0ms ease-out 0ms;
      pointer-events: none;
    }
    /*
     * dock-main-content 动效改进：
     * 1. 移除永久 will-change：常态下不需要 GPU 层，避免过渡前 composite 层污染
     * 2. 改用 data-dock-takeover-phase 属性动态激活 will-change，仅在过渡期间启用 GPU
     * 3. visibility 由 0ms 立即响应，去掉 delay — 原先 delay=var(--pk-shell-enter) 导致
     *    opacity 开始渐变但 visibility 仍为 hidden，造成入场帧闪烁
     * 4. opacity/filter 分层错开：opacity 比 filter 快 40ms，视觉上内容先现后虚化，
     *    符合"先感知内容、再加深专注氛围"的认知节奏
     */
    .dock-main-content {
      transform-origin: center center;
      backface-visibility: hidden;
      contain: paint;
    }
    /* 仅在专注模式接管期间激活 GPU 合成层，避免常态多余层占用 */
    .dock-main-content[data-dock-takeover-phase="entering"],
    .dock-main-content[data-dock-takeover-phase="focused"],
    .dock-main-content[data-dock-takeover-phase="exiting"],
    .dock-main-content[data-dock-takeover-phase="restoring"] {
      will-change: opacity, transform, filter;
    }
  `],
  template: `
    <!-- 隐藏的 router-outlet：子路由（text/flow/task）无组件，仅用于 URL 匹配 -->
    <router-outlet style="display:none"></router-outlet>
    <div class="relative flex h-full w-full min-h-0 overflow-hidden" style="background-color: var(--theme-bg);">
      @if (projectState.activeProjectId()) {
        <div
          class="flex flex-1 min-h-0 w-full dock-main-content"
          data-testid="project-shell-main-content"
          [attr.data-dock-takeover-phase]="dockTakeoverPhase()"
          [class.pointer-events-none]="dockTakeoverMainNonInteractive()"
          [style.opacity]="dockTakeoverMainOpacity()"
          [style.transform]="dockTakeoverMainTransform()"
          [style.filter]="dockTakeoverMainFilter()"
          [style.transition]="dockTakeoverMainTransition()"
          [style.visibility]="dockTakeoverMainVisibility()"
          [attr.aria-hidden]="dockTakeoverMainHidden() ? 'true' : null">
        <!-- Text Column - 允许滑动手势切换 -->
        <!-- min-w-0 确保文本栏可被正确压缩 -->
        <div class="flex flex-col min-h-0 min-w-0 overflow-hidden"
             [class.transition-all]="!uiState.isResizing() || collapseAnimating()"
             [class.duration-300]="!uiState.isResizing() || collapseAnimating()"
             [class.ease-in-out]="!uiState.isResizing() || collapseAnimating()" 
             style="background-color: var(--theme-bg); border-color: var(--theme-border);"
             [class.border-r]="!uiState.isMobile() && !uiState.isTextColumnCollapsed()"
             [class.absolute]="uiState.isMobile()"
             [class.inset-0]="uiState.isMobile()"
             [class.w-full]="uiState.isMobile()"
             [class.flex-1]="uiState.isMobile()"
             [class.opacity-0]="uiState.isMobile() && uiState.activeView() !== 'text'"
             [class.opacity-100]="uiState.isMobile() && uiState.activeView() === 'text'"
             [class.pointer-events-none]="uiState.isMobile() && uiState.activeView() !== 'text'"
             [class.z-10]="uiState.isMobile() && uiState.activeView() === 'text'"
             [class.z-0]="uiState.isMobile() && uiState.activeView() !== 'text'"
             [style.width.%]="uiState.isMobile() ? 100 : (uiState.isTextColumnCollapsed() ? 0 : uiState.textColumnRatio())"
             [style.min-width.px]="uiState.isMobile() ? 0 : (uiState.isTextColumnCollapsed() || uiState.isResizing() ? 0 : 300)"
             (touchstart)="onTextViewTouchStart($event)"
             (touchmove)="onTextViewTouchMove($event)"
             (touchend)="onTextViewTouchEnd($event)">
          
          <!-- 内容包装：折叠时立即隐藏内容，避免窄宽度下内容崩坏 -->
          <!-- min-w-0 关键：允许 flex 容器在父容器压缩时正确收缩，防止内容撑宽导致布局崩坏 -->
          <div class="text-col-inner flex flex-col flex-1 min-h-0 min-w-0"
               [class.text-col-inner--hidden]="!uiState.isMobile() && uiState.isTextColumnCollapsed()">
          <!-- Header for Text Column -->
          <div class="shrink-0 z-10"
               [ngClass]="{'h-6 mx-6 mt-4': !uiState.isMobile(), 'mx-2 mt-1 mb-1': uiState.isMobile()}">
             
             <!-- Desktop Layout -->
             @if (!uiState.isMobile()) {
               <div class="h-full flex items-center justify-between min-w-0 gap-2">
                 <div class="flex items-center gap-3 min-w-0">
                   <button (click)="toggleSidebar()" 
                           class="text-stone-400 dark:text-stone-500 hover:text-stone-600 dark:hover:text-stone-300 transition-colors p-2 hover:bg-stone-200/50 dark:hover:bg-stone-700/50 rounded-full" 
                           aria-label="切换侧边栏">
                      <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" />
                      </svg>
                   </button>
                   <span class="font-bold text-stone-800 dark:text-stone-200 text-lg tracking-tight truncate max-w-[7rem] lg:max-w-none">文本视图</span>
                 </div>
                 
                 <!-- 折叠文本栏按钮 -->
                 <button (click)="toggleTextColumn()" 
                         class="text-stone-400 dark:text-stone-500 hover:text-stone-600 dark:hover:text-stone-300 transition-colors p-1.5 hover:bg-stone-200/50 dark:hover:bg-stone-700/50 rounded-lg ml-auto mr-2" 
                         aria-label="折叠文本栏"
                         title="折叠文本栏">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
                    </svg>
                 </button>
                 
                 <!-- Filter -->
                  <div class="relative flex items-center gap-2 min-w-0">
                   <button 
                      (click)="isFilterOpen.set(!isFilterOpen()); $event.stopPropagation()"
                      [attr.aria-expanded]="isFilterOpen()"
                      aria-haspopup="listbox"
                      aria-label="任务过滤器"
                     class="flex items-center gap-2 min-w-0 max-w-[8rem] xl:max-w-none bg-transparent text-xs font-medium text-stone-500 dark:text-stone-400 hover:text-indigo-800 dark:hover:text-indigo-400 transition-colors py-1.5 px-3 rounded-lg hover:bg-indigo-50 dark:hover:bg-indigo-900/20 border border-transparent active:bg-indigo-100 dark:active:bg-indigo-900/30">
                      <span class="truncate">{{ currentFilterLabel() }}</span>
                      <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3 shrink-0 transition-transform duration-200" [class.rotate-180]="isFilterOpen()" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
                       </svg>
                   </button>
                   
                   @if (isFilterOpen()) {
                      <div class="fixed inset-0 z-40" (click)="isFilterOpen.set(false)"></div>
                      <div class="absolute right-0 top-full mt-1 w-48 bg-white/90 dark:bg-stone-800/95 backdrop-blur-xl border border-stone-100 dark:border-stone-700 rounded-xl shadow-lg z-50 py-1 animate-dropdown overflow-hidden" role="listbox" aria-label="过滤选项">
                          <div 
                              (click)="uiState.filterMode.set('all'); isFilterOpen.set(false)"
                              class="px-4 py-2.5 text-xs text-stone-600 dark:text-stone-300 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 hover:text-indigo-900 dark:hover:text-indigo-300 cursor-pointer flex items-center justify-between group transition-colors">
                              <span>全部任务</span>
                              @if (uiState.filterMode() === 'all') { <span class="text-indigo-600 dark:text-indigo-400 font-bold">✓</span> }
                          </div>
                          <div class="h-px bg-stone-100 dark:bg-stone-700 my-1"></div>
                          @for(root of projectState.rootTasks(); track root.id) {
                              <div 
                                  (click)="uiState.filterMode.set(root.id); isFilterOpen.set(false)"
                                  class="px-4 py-2.5 text-xs text-stone-600 dark:text-stone-300 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 hover:text-indigo-900 dark:hover:text-indigo-300 cursor-pointer flex items-center justify-between group transition-colors">
                                  <span class="truncate">{{root.title || root.displayId || '未命名任务'}}</span>
                                  @if (uiState.filterMode() === root.id) { <span class="text-indigo-600 dark:text-indigo-400 font-bold">✓</span> }
                              </div>
                          }
                      </div>
                   }
                 </div>
               </div>
             }
             
             <!-- Mobile Layout: Compact -->
             @if (uiState.isMobile()) {
               <div class="flex items-center justify-between gap-2">
                 <div class="flex items-center gap-2 min-w-0">
                   <button (click)="toggleSidebar()" class="btn-compact text-stone-400 dark:text-stone-500 p-1 rounded-lg active:bg-stone-200/50 dark:active:bg-stone-700/50 shrink-0" aria-label="菜单">
                      <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" />
                      </svg>
                   </button>
                   <span data-testid="mobile-text-view-label" class="font-bold text-stone-700 dark:text-stone-200 text-base">文本</span>
                 </div>
                 
                 <div class="flex items-center gap-1 shrink-0">
                   <button 
                      (click)="isFilterOpen.set(!isFilterOpen()); $event.stopPropagation()"
                      [attr.aria-expanded]="isFilterOpen()"
                      aria-haspopup="listbox"
                      aria-label="任务过滤器"
                      class="btn-compact flex items-center gap-1 text-[10px] text-stone-500 dark:text-stone-400 py-0.5 px-1.5 rounded bg-stone-100/80 dark:bg-stone-700/80 active:bg-stone-200 dark:active:bg-stone-600 max-w-[80px]">
                       <span class="truncate">{{ currentFilterLabel() }}</span>
                       <svg class="h-2 w-2 shrink-0" [class.rotate-180]="isFilterOpen()" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
                       </svg>
                   </button>
                   
                   <button data-testid="flow-view-tab" (click)="switchToFlow()" class="btn-compact bg-indigo-500 text-white px-2 py-0.5 rounded text-[10px] font-medium active:bg-indigo-600">
                      流程图
                   </button>
                 </div>
               </div>
               
               @if (isFilterOpen()) {
                  <div class="fixed inset-0 z-40" (click)="isFilterOpen.set(false)"></div>
                  <div class="absolute right-3 top-12 w-44 bg-white/95 dark:bg-stone-800/95 backdrop-blur-xl border border-stone-200 dark:border-stone-700 rounded-lg shadow-xl z-50 py-1 animate-dropdown overflow-hidden" role="listbox" aria-label="过滤选项">
                      <div 
                          (click)="uiState.filterMode.set('all'); isFilterOpen.set(false)"
                          class="px-3 py-2 text-xs text-stone-600 dark:text-stone-300 active:bg-indigo-50 dark:active:bg-indigo-900/30 cursor-pointer flex items-center justify-between">
                          <span>全部任务</span>
                          @if (uiState.filterMode() === 'all') { <span class="text-indigo-600 dark:text-indigo-400 font-bold">✓</span> }
                      </div>
                      <div class="h-px bg-stone-100 dark:bg-stone-700"></div>
                      @for(root of projectState.rootTasks(); track root.id) {
                          <div 
                              (click)="uiState.filterMode.set(root.id); isFilterOpen.set(false)"
                              class="px-3 py-2 text-xs text-stone-600 dark:text-stone-300 active:bg-indigo-50 dark:active:bg-indigo-900/30 cursor-pointer flex items-center justify-between">
                              <span class="truncate">{{root.title || root.displayId || '未命名任务'}}</span>
                              @if (uiState.filterMode() === root.id) { <span class="text-indigo-600 dark:text-indigo-400 font-bold">✓</span> }
                          </div>
                      }
                  </div>
               }
             }
          </div>
          
          <!-- @defer 块用于懒加载视图组件 -->
          @defer (on immediate) {
            <app-text-view class="flex-1 min-h-0 overflow-hidden" (focusFlowNode)="onFocusFlowNode($event)"></app-text-view>
          } @placeholder {
            <div class="flex-1 flex items-center justify-center text-stone-400">
              <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600"></div>
            </div>
          } @error {
            <div class="flex-1 flex flex-col items-center justify-center text-stone-500 p-4 gap-4">
              <svg xmlns="http://www.w3.org/2000/svg" class="h-12 w-12 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <p class="text-sm text-center">文本视图加载失败</p>
              <button (click)="reloadPage()" class="px-4 py-2 bg-indigo-500 text-white rounded-lg text-sm hover:bg-indigo-600 transition-colors">
                刷新页面
              </button>
            </div>
          }
          </div><!-- /text-col-inner -->
        </div>

        <!-- Content Resizer（文本栏折叠时隐藏） -->
        @if(!uiState.isMobile() && !uiState.isTextColumnCollapsed()) {
          <div class="w-1 hover:w-1.5 bg-transparent hover:bg-stone-300 dark:hover:bg-stone-600 cursor-col-resize z-20 flex-shrink-0 relative group"
               (mousedown)="startContentResize($event)">
               <div class="absolute inset-y-0 left-0 w-px bg-stone-200 dark:bg-stone-700 group-hover:bg-stone-400 dark:group-hover:bg-stone-500 transition-colors"></div>
          </div>
        }

        <!-- 文本栏折叠时：一条细分界线 + 居中小箭头按钮 -->
        @if (!uiState.isMobile() && uiState.isTextColumnCollapsed()) {
          <div class="w-px flex-shrink-0 relative z-50 group"
               style="background-color: var(--theme-border);">
            <!-- 居中非实心箭头按钮，z-50 确保按钮浮于 flow-palette(z-40) 之上 -->
            <button (click)="expandTextColumnToMin()"
                    class="absolute top-1/3 -translate-y-1/2 -right-3 w-6 h-8 flex items-center justify-center rounded-r-md
                           bg-white dark:bg-stone-800 border border-l-0 border-stone-200 dark:border-stone-700
                           hover:bg-stone-50 dark:hover:bg-stone-700 hover:border-stone-300 dark:hover:border-stone-600
                           shadow-sm cursor-pointer transition-colors"
                    aria-label="展开文本栏"
                    title="展开文本栏">
              <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5 text-stone-400 dark:text-stone-500 group-hover:text-stone-600 dark:group-hover:text-stone-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </div>
        }

        <!-- Flow Column - 移动端条件渲染，桌面端始终显示 -->
        <!-- 桌面端直接渲染 FlowView，避免流程图 chunk 偶发加载失败进入错误占位；移动端仍保留 @defer 按需挂载 -->
        @if (!uiState.isMobile() || uiState.activeView() === 'flow') {
           <div class="flex-1 flex flex-col min-w-[300px] min-h-0" 
             style="background-color: var(--theme-bg);"
             [class.absolute]="uiState.isMobile()"
             [class.inset-0]="uiState.isMobile()"
             [class.w-full]="uiState.isMobile()"
             [class.z-10]="uiState.isMobile()"
             (click)="activateFlowIntent('click')">
           <div class="flex items-center justify-between shrink-0 z-10"
                [ngClass]="{'h-12 mx-4 mt-2': !uiState.isMobile(), 'mx-2 mt-1 mb-0.5': uiState.isMobile()}">
              <span class="text-stone-700 dark:text-stone-200" [ngClass]="{'text-lg font-bold text-stone-800 dark:text-stone-200 tracking-tight': !uiState.isMobile(), 'text-base font-bold': uiState.isMobile()}">
                @if (uiState.isMobile()) { 流程图 } @else { 流程视图 }
              </span>
              @if(uiState.isMobile()) {
                  <button data-testid="text-view-tab" (click)="switchToText()" class="btn-compact bg-indigo-500 text-white px-2 py-0.5 rounded text-[10px] font-medium active:bg-indigo-600">
                      文本
                  </button>
              }
           </div>

           @if (!uiState.isMobile()) {
             <app-flow-view class="flex-1 min-h-0 overflow-hidden relative" (goBackToText)="switchToText()"></app-flow-view>
           } @else {
             <!-- 移动端保留 @defer 懒加载：只在用户切到流程图时才挂载 GoJS，切回文本时销毁 -->
             @defer (when shouldLoadFlowNow(); prefetch when shouldPrefetchFlowChunk()) {
               <app-flow-view class="flex-1 min-h-0 overflow-hidden relative" (goBackToText)="switchToText()"></app-flow-view>
             } @placeholder {
               <div class="flex-1 flex items-center justify-center text-stone-400">
                 @if (shouldLoadFlowNow()) {
                   <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600"></div>
                 } @else {
                   <button
                     data-testid="flow-view-tab"
                     (click)="switchToFlow()"
                     class="px-3 py-1.5 rounded-lg border border-stone-300/80 dark:border-stone-600/80 text-xs text-stone-600 dark:text-stone-300 hover:bg-stone-100/80 dark:hover:bg-stone-800/80 transition-colors">
                     进入流程图
                   </button>
                 }
               </div>
             } @error {
               <div class="flex-1 flex flex-col items-center justify-center text-stone-500 p-4 gap-4">
                 <svg xmlns="http://www.w3.org/2000/svg" class="h-12 w-12 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                   <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                 </svg>
                 <p class="text-sm text-center">流程图加载失败</p>
                 <button (click)="reloadPage()" class="px-4 py-2 bg-indigo-500 text-white rounded-lg text-sm hover:bg-indigo-600 transition-colors">
                   刷新页面
                 </button>
               </div>
             }
           }
           </div>
        }

        </div>

        <!-- 停泊坞：底部弹出面板（A6.9）——定时触发确保组件及时加载 -->
        @defer (on timer(300)) {
          <app-parking-dock></app-parking-dock>
        } @placeholder { } @error { }

        <!-- 停泊通知（A3.13）-->
        @defer (on idle) {
          <app-parking-notice></app-parking-notice>
        } @placeholder { } @error { }
      } @else {
        <!-- 无活动项目时的占位 - 点击可创建新项目 -->
        <button 
          (click)="openNewProjectModal()"
          class="flex-1 flex items-center justify-center text-stone-300 dark:text-stone-600 flex-col gap-6 p-4 w-full cursor-pointer group"
          aria-label="创建新项目">
          <div class="w-24 h-24 rounded-full bg-stone-100 dark:bg-stone-800 flex items-center justify-center shadow-md transition-all duration-200 ease-out transform will-change-transform group-hover:-translate-y-1 group-hover:scale-105 group-hover:bg-stone-50 dark:group-hover:bg-stone-700/70 group-hover:shadow-xl group-active:scale-95 group-active:shadow-lg group-active:bg-stone-200 dark:group-active:bg-stone-700">
              <svg xmlns="http://www.w3.org/2000/svg" class="h-10 w-10 opacity-40" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
          </div>
          <p class="font-light tracking-widest text-sm text-center">请选择或创建一个项目</p>
        </button>
      }
    </div>
  `
})
export class ProjectShellComponent implements OnInit, OnDestroy {
  readonly uiState = inject(UiStateService);
  readonly projectState = inject(ProjectStateService);
  private readonly dockEngine = inject(DockEngineService);
  readonly dockTakeoverPhase = computed<DockFocusChromePhase>(() => this.resolveDockTakeoverPhase());
  readonly dockTakeoverMainHidden = computed(
    () =>
      PARKING_CONFIG.DOCK_FOCUS_CONTENT_EFFECT === 'hide'
      && (this.dockTakeoverPhase() === 'entering' || this.dockTakeoverPhase() === 'focused'),
  );
  readonly dockTakeoverMainVisibility = computed<'visible' | 'hidden'>(() => {
    return this.resolveDockTakeoverMainVisibility();
  });
  readonly dockTakeoverMainDimmed = computed(
    () =>
      PARKING_CONFIG.DOCK_FOCUS_CONTENT_EFFECT === 'dim'
      && this.dockEngine.focusMode()
      && this.dockEngine.focusScrimOn(),
  );
  readonly dockTakeoverMainNonInteractive = computed(
    () => this.dockTakeoverPhase() !== 'idle',
  );
  readonly dockTakeoverMainOpacity = computed(() => {
    return this.resolveDockTakeoverMainOpacity();
  });
  readonly dockTakeoverMainFilter = computed(() => {
    return this.resolveDockTakeoverMainFilter();
  });
  readonly dockTakeoverMainTransform = computed(() => {
    return this.resolveDockTakeoverMainTransform();
  });
  readonly dockTakeoverMainTransition = computed(() => {
    return this.resolveDockTakeoverMainTransition();
  });
  private readonly taskOpsAdapter = inject(TaskOperationAdapterService);
  private readonly syncCoordinator = inject(SyncCoordinatorService);
  private toast = inject(ToastService);
  private tabSync = inject(TabSyncService);
  private readonly userSession = inject(UserSessionService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private readonly modalLoader = inject(ModalLoaderService);
  private readonly dynamicModal = inject(DynamicModalService);
  private readonly projectCoord = inject(AppProjectCoordinatorService);
  private readonly localBackupService = inject(LocalBackupService);
  private readonly handoffCoordinator = inject(HandoffCoordinatorService);
  private readonly launchSnapshot = inject(LaunchSnapshotService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('ProjectShell');
  private readonly destroyRef = inject(DestroyRef);
  private readonly startupLaunchSnapshot = this.launchSnapshot.read();
  
  // 使用 FlowCommandService 替代 ViewChild，保持 Shell 与 FlowView 解耦
  // Shell 通过命令服务发布意图，FlowView 订阅并响应
  private readonly flowCommand = inject(FlowCommandService);
  private readonly flowIntentLazyLoadEnabled = FEATURE_FLAGS.FLOW_INTENT_LAZYLOAD_V1;
  private readonly flowStateAwareRestoreEnabled = FEATURE_FLAGS.FLOW_STATE_AWARE_RESTORE_V2;
  
  // UI 状态
  isFilterOpen = signal(false);
  readonly flowIntentActivated = signal(!FEATURE_FLAGS.FLOW_INTENT_LAZYLOAD_V1);
  readonly flowPrefetchOnlyActivated = signal(false);
  readonly shouldLoadFlowNow = computed(() =>
    !this.flowIntentLazyLoadEnabled || this.flowIntentActivated()
  );
  readonly shouldPrefetchFlowChunk = computed(() =>
    this.shouldLoadFlowNow() || this.flowPrefetchOnlyActivated()
  );
  // 使用 uiState.activeView 代替本地的 mobileActiveView，使其他组件可以访问当前视图状态
  
  // 内容调整状态
  private isResizingContent = false;
  private startX = 0;
  private startRatio = 0;
  private mainContentWidth = 0;
  
  // 手机端滑动手势状态 - 用于文本视图切换到流程图
  private textViewSwipeState = {
    startX: 0,
    startY: 0,
    isSwiping: false
  };
  
  // 组件销毁标志 - 用于取消待执行的递归 setTimeout
  private isDestroyed = false;
  // 任务深链接重试定时器 - 用于组件销毁时取消
  private deepLinkRetryTimer: ReturnType<typeof setTimeout> | null = null;
  // Flow 智能恢复定时器
  private flowRestoreTimer: ReturnType<typeof setTimeout> | null = null;
  private flowIdlePreloadTimer: ReturnType<typeof setTimeout> | null = null;
  private startupRouteDecisionResolved = false;
  private flowRestoreIdleCallbackId: number | null = null;
  private flowPreloadIdleCallbackId: number | null = null;
  private lastFlowRestoreProjectId: string | null = null;
  
  // 【P2-23 修复】从普通方法改为 computed() 避免每次变更检测重复遍历
  currentFilterLabel = computed(() => {
    const filterId = this.uiState.filterMode();
    if (filterId === 'all') return '全部任务';
    const task = this.projectState.getTask(filterId);
    if (!task) return '全部任务';
    return task.title || task.displayId || '未命名任务';
  });
  
  ngOnInit() {
    this.localBackupService.setProjectsProvider(() => this.projectState.getProjectsWithCurrentData());
    // 【P2-38 修复】使用 NavigationEnd 事件统一处理路由变化
    // 父子路由结构下，projectId 在 this.route.params，taskId 在 firstChild.params
    // 通过 Router.events 可以同时捕获父路由和子路由的变化
    this.router.events.pipe(
      filter(event => event instanceof NavigationEnd),
      startWith(null), // 初始化时也触发一次
      takeUntilDestroyed(this.destroyRef)
    ).subscribe(() => {
      this.handleRouteChange();
    });
  }

  private resolveDockTakeoverPhase(): DockFocusChromePhase {
    return this.dockEngine.focusChromePhase();
  }

  private resolveDockTakeoverMainVisibility(): 'visible' | 'hidden' {
    return resolveProjectShellTakeoverVisibility(this.resolveDockTakeoverVisualState());
  }

  private resolveDockTakeoverMainOpacity(): number {
    return resolveProjectShellTakeoverOpacity(this.resolveDockTakeoverVisualState());
  }

  private resolveDockTakeoverMainFilter(): string {
    return resolveProjectShellTakeoverFilter(this.resolveDockTakeoverVisualState());
  }

  private resolveDockTakeoverMainTransform(): string {
    return resolveProjectShellTakeoverTransform(this.resolveDockTakeoverVisualState());
  }

  private resolveDockTakeoverMainTransition(): string {
    return resolveProjectShellTakeoverTransition(this.dockTakeoverPhase());
  }

  private resolveDockTakeoverVisualState() {
    return {
      phase: this.dockTakeoverPhase(),
      hiddenMode: this.dockTakeoverMainHidden(),
      scrimOn: this.dockEngine.focusScrimOn(),
    };
  }

  /**
   * Flow 视图意图触发器
   * 默认只在用户有明确意图时加载 GoJS 大块代码
   */
  activateFlowIntent(source: 'click' | 'route' | 'deeplink' | 'restore-idle'): void {
    if (!this.flowIntentLazyLoadEnabled || this.flowIntentActivated()) {
      return;
    }

    this.flowIntentActivated.set(true);
    this.flowPrefetchOnlyActivated.set(false);
    this.logger.debug('Flow lazy-load intent activated', { source });
  }
  
  /**
   * 统一处理路由变化：解析参数 + 确定视图模式
   * 父子路由结构：
   *   /projects/:projectId         → route.snapshot.params['projectId']
   *   /projects/:projectId/task/:taskId → route.snapshot.firstChild?.params['taskId']
   */
  private handleRouteChange() {
    const snapshot = this.route.snapshot;
    const projectId = snapshot.params['projectId'];
    const childSnapshot = snapshot.firstChild;
    const taskId = childSnapshot?.params['taskId'];
    const currentUrl = this.router.url;
    const startupEntryIntent = resolveStartupEntryIntent(currentUrl);
    const handoffResult = this.handoffCoordinator.result();
    const snapshotRouteIntent = startupEntryIntent ? null : this.startupLaunchSnapshot?.routeIntent;
    const snapshotMatchesCurrentRoute =
      !!snapshotRouteIntent
      && snapshotRouteIntent.projectId === projectId
      && (
        (snapshotRouteIntent.kind === 'task' && snapshotRouteIntent.taskId === taskId)
        || (snapshotRouteIntent.kind === 'flow' && currentUrl.endsWith('/flow'))
        || (snapshotRouteIntent.kind === 'text' && currentUrl.endsWith('/text'))
        || snapshotRouteIntent.kind === 'project'
      );
    const degradeMobileStartupRoute =
      FEATURE_FLAGS.SNAPSHOT_HANDOFF_V2 &&
      !this.startupRouteDecisionResolved &&
      !startupEntryIntent &&
      (
        handoffResult.kind === 'degraded-to-text'
        || (this.startupLaunchSnapshot?.mobileDegraded === true && snapshotMatchesCurrentRoute)
        || shouldDegradeMobileStartupRoute(currentUrl, this.uiState.isMobile())
      );
    
    // 处理项目切换
    if (projectId && projectId !== this.projectState.activeProjectId()) {
        this.userSession.switchActiveProject(projectId);
      const project = this.projectState.getProject(projectId);
      if (project) {
        this.tabSync.notifyProjectOpen(projectId, project.name);
      }
    }
    
    // 处理任务深链接定位
    const taskDeepLinkResult = taskId && !degradeMobileStartupRoute
      ? this.handleTaskDeepLink(taskId, { degradeToWorkspaceOnMissing: startupEntryIntent !== null })
      : null;
    
    // 根据 URL 确定视图模式
    const isFlowRoute = currentUrl.endsWith('/flow');
    const isTaskDeepLink = currentUrl.includes('/task/');

    this.startupRouteDecisionResolved = true;

    if (degradeMobileStartupRoute) {
      this.cancelFlowStateAwareTimers();
      this.setActiveView('text');
      this.toast.info(
        '已切换到文本视图',
        this.startupLaunchSnapshot?.degradeReason === 'mobile-default-text'
          ? '手机端启动默认进入文本视图，可稍后手动切换流程图'
          : '启动阶段已回退到更稳定的文本视图'
      );
      if (handoffResult.kind === 'degraded-to-project' && !this.projectState.activeProjectId()) {
        const fallbackProjectId = this.projectState.projects()[0]?.id ?? null;
        if (fallbackProjectId) {
          this.userSession.switchActiveProject(fallbackProjectId);
        }
      }
      return;
    }

    if (isFlowRoute || (isTaskDeepLink && taskDeepLinkResult !== 'workspace' && taskDeepLinkResult !== 'flow')) {
      this.cancelFlowStateAwareTimers();
      this.activateFlowIntent(isTaskDeepLink ? 'deeplink' : 'route');
      this.setActiveView('flow');
      return;
    }

    if (currentUrl.endsWith('/text')) {
      this.cancelFlowStateAwareTimers();
      this.setActiveView('text');
      return;
    }

    this.applyStateAwareFlowRestore(currentUrl, projectId);
  }

  private applyStateAwareFlowRestore(currentUrl: string, projectId?: string): void {
    if (!this.flowStateAwareRestoreEnabled || !projectId) {
      return;
    }
    this.flowPrefetchOnlyActivated.set(false);

    if (this.uiState.isMobile()) {
      this.uiState.activeView.set('text');
      this.reportFlowRestoreMode('degraded', {
        reason: 'mobile-default-text',
        projectId,
      });
      return;
    }

    // 仅在 /projects/:projectId 根路由应用智能恢复矩阵
    if (!/^\/projects\/[^/?#]+$/.test(currentUrl)) {
      return;
    }

    if (this.lastFlowRestoreProjectId === projectId) {
      return;
    }
    this.lastFlowRestoreProjectId = projectId;
    this.cancelFlowStateAwareTimers();

    const lastView = this.uiState.getLastActiveView();
    if (lastView !== 'flow') {
      this.setActiveView('text');
      this.reportFlowRestoreMode('degraded', {
        reason: 'last-view-text',
        projectId,
      });
      return;
    }

    const weakNetwork = this.isWeakNetworkForFlowRestore();
    if (weakNetwork) {
      this.uiState.activeView.set('text');
      this.scheduleWeakNetworkIdlePreload(projectId);
      this.reportFlowRestoreMode('degraded', {
        reason: 'weak-network-preload-only',
        projectId,
      });
      return;
    }

    this.scheduleFlowIdleRestore(projectId);
  }

  private scheduleFlowIdleRestore(projectId: string): void {
    const triggerRestore = () => {
      if (this.isDestroyed) return;
      this.activateFlowIntent('restore-idle');
      this.setActiveView('flow');
      this.reportFlowRestoreMode('applied', {
        reason: 'desktop-idle-restore',
        projectId,
      });
    };

    if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
      const requestIdle = (window as Window & {
        requestIdleCallback: (cb: IdleRequestCallback, options?: IdleRequestOptions) => number;
      }).requestIdleCallback;

      this.flowRestoreIdleCallbackId = requestIdle(() => {
        this.flowRestoreIdleCallbackId = null;
        triggerRestore();
      }, { timeout: STARTUP_PERF_CONFIG.FLOW_RESTORE_IDLE_DELAY_MS });
      return;
    }

    this.flowRestoreTimer = setTimeout(() => {
      this.flowRestoreTimer = null;
      triggerRestore();
    }, STARTUP_PERF_CONFIG.FLOW_RESTORE_IDLE_DELAY_MS);
  }

  private scheduleWeakNetworkIdlePreload(projectId: string): void {
    const triggerPreload = () => {
      if (this.isDestroyed || this.flowIntentActivated()) return;
      this.flowPrefetchOnlyActivated.set(true);
      this.reportFlowRestoreMode('degraded', {
        reason: 'weak-network-idle-preload',
        projectId,
      });
    };

    this.flowIdlePreloadTimer = setTimeout(() => {
      this.flowIdlePreloadTimer = null;

      if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
        const requestIdle = (window as Window & {
          requestIdleCallback: (cb: IdleRequestCallback, options?: IdleRequestOptions) => number;
        }).requestIdleCallback;
        this.flowPreloadIdleCallbackId = requestIdle(() => {
          this.flowPreloadIdleCallbackId = null;
          triggerPreload();
        }, { timeout: STARTUP_PERF_CONFIG.FLOW_RESTORE_IDLE_DELAY_MS });
        return;
      }

      triggerPreload();
    }, STARTUP_PERF_CONFIG.FLOW_IDLE_PRELOAD_DELAY_MS);
  }

  private isWeakNetworkForFlowRestore(): boolean {
    if (typeof navigator === 'undefined') {
      return false;
    }

    const nav = navigator as Navigator & {
      connection?: NetworkInformationLike;
      mozConnection?: NetworkInformationLike;
      webkitConnection?: NetworkInformationLike;
    };
    const connection = nav.connection ?? nav.mozConnection ?? nav.webkitConnection;
    if (!connection) {
      return false;
    }

    if (connection.saveData) {
      return true;
    }

    const effectiveType = connection.effectiveType ?? '';
    if (effectiveType === '2g' || effectiveType === 'slow-2g') {
      return true;
    }

    const rtt = typeof connection.rtt === 'number' ? connection.rtt : 0;
    if (rtt > STARTUP_PERF_CONFIG.FLOW_RESTORE_MAX_RTT_MS) {
      return true;
    }

    const downlink = typeof connection.downlink === 'number' ? connection.downlink : 0;
    if (
      downlink > 0 &&
      downlink < STARTUP_PERF_CONFIG.FLOW_IDLE_PRELOAD_MIN_DOWNLINK_MBPS
    ) {
      return true;
    }

    return false;
  }

  private setActiveView(view: 'text' | 'flow'): void {
    this.flowPrefetchOnlyActivated.set(false);
    this.uiState.activeView.set(view);
    this.uiState.persistActiveView(view);
  }

  private cancelFlowStateAwareTimers(): void {
    if (this.flowRestoreTimer) {
      clearTimeout(this.flowRestoreTimer);
      this.flowRestoreTimer = null;
    }
    if (this.flowIdlePreloadTimer) {
      clearTimeout(this.flowIdlePreloadTimer);
      this.flowIdlePreloadTimer = null;
    }
    if (
      this.flowRestoreIdleCallbackId !== null &&
      typeof window !== 'undefined' &&
      'cancelIdleCallback' in window
    ) {
      (window as Window & { cancelIdleCallback: (handle: number) => void })
        .cancelIdleCallback(this.flowRestoreIdleCallbackId);
      this.flowRestoreIdleCallbackId = null;
    }
    if (
      this.flowPreloadIdleCallbackId !== null &&
      typeof window !== 'undefined' &&
      'cancelIdleCallback' in window
    ) {
      (window as Window & { cancelIdleCallback: (handle: number) => void })
        .cancelIdleCallback(this.flowPreloadIdleCallbackId);
      this.flowPreloadIdleCallbackId = null;
    }
  }

  private reportFlowRestoreMode(
    mode: 'applied' | 'degraded',
    data: Record<string, unknown>
  ): void {
    if (typeof window === 'undefined') {
      return;
    }
    window.dispatchEvent(new CustomEvent('nanoflow:flow-restore-status', {
      detail: {
        mode,
        ...data,
      },
    }));
  }
  
  /**
   * 处理任务深链接定位
   * 等待任务数据加载后定位到指定任务
   * 使用指数退避策略减少不必要的等待
   */
  private handleTaskDeepLink(
    taskId: string,
    options?: { degradeToWorkspaceOnMissing?: boolean }
  ): 'flow' | 'workspace' | 'pending' {
    const maxRetries = 10;
    const baseDelay = 100;
    const maxDelay = 2000;
    let retries = 0;

    const maybeDegradeToWorkspace = (): boolean => {
      if (!options?.degradeToWorkspaceOnMissing) {
        return false;
      }

      this.toast.warning('任务不存在', '请求的任务已失效，已返回工作区');
      this.navigateToProjectList();
      return true;
    };

    const tryFocusTask = (): void => {
      // 检查组件是否已销毁，停止递归
      if (this.isDestroyed) {
        return;
      }

      retries++;
      const tasks = this.projectState.tasks();
      const task = this.projectState.getTask(taskId);
      const isLoading = this.syncCoordinator.isLoadingRemote?.() ?? (tasks.length === 0);

      if (task) {
        // 任务存在，通过命令服务发送居中请求
        // FlowCommandService 会缓存命令直到 FlowView 就绪
        this.activateFlowIntent('deeplink');
        this.setActiveView('flow');

        // 等待图表渲染后定位
        this.deepLinkRetryTimer = setTimeout(() => {
          if (this.isDestroyed) {
            return;
          }
          this.flowCommand.centerOnNode(taskId, true);

          // 🔥 不再更新 URL - 避免触发路由导航销毁组件
          // 僵尸模式需要组件保持存活
        }, 100);
        return;
      }

      if (!isLoading && !task && maybeDegradeToWorkspace()) {
        return;
      }

      if (retries < maxRetries && isLoading) {
        // 数据尚未加载，继续重试，使用指数退避
        const delay = Math.min(baseDelay * Math.pow(1.5, retries - 1), maxDelay);
        this.deepLinkRetryTimer = setTimeout(tryFocusTask, delay);
        return;
      }

      // 超时未找到任务，导航到流程图视图并提示用户
      // 🔥 不再更新 URL - 避免触发路由导航销毁组件
      this.activateFlowIntent('deeplink');
      this.setActiveView('flow');

      if (!isLoading && !task) {
        // 任务确实不存在 - 提供创建新任务的选项
        this.toast.warning(
          '任务不存在',
          '请求的任务可能已被删除或您没有访问权限',
          {
            duration: 10000,
            action: {
              label: '新建任务',
              onClick: () => {
                this.taskOpsAdapter.addFloatingTask('新任务', '', 100, 100);
                this.toast.success('已创建新任务');
              }
            }
          }
        );
        return;
      }

      this.toast.info(
        '加载超时',
        '数据仍在加载中',
        {
          duration: 8000,
          action: {
            label: '刷新页面',
            onClick: () => reloadViaForceClearCache()
          }
        }
      );
    };

    const initialTasks = this.projectState.tasks();
    const initialTask = this.projectState.getTask(taskId);
    const initialIsLoading = this.syncCoordinator.isLoadingRemote?.() ?? (initialTasks.length === 0);
    const initialResult: 'flow' | 'workspace' | 'pending' = initialTask
      ? 'flow'
      : (!initialIsLoading ? (options?.degradeToWorkspaceOnMissing ? 'workspace' : 'flow') : 'pending');

    tryFocusTask();
    return initialResult;
  }
  
  ngOnDestroy() {
    // 设置销毁标志，停止所有递归 setTimeout
    this.isDestroyed = true;
    this.cancelFlowStateAwareTimers();
    
    // 清理待执行的定时器
    if (this.deepLinkRetryTimer) {
      clearTimeout(this.deepLinkRetryTimer);
      this.deepLinkRetryTimer = null;
    }
    
    // DestroyRef 自动处理取消订阅，无需手动触发
  }
  
  // ========== 视图切换 ==========
  
  /**
   * 切换到流程图视图
   * 移动端：使用条件渲染，FlowView 组件会被完全销毁/重建
   */
  switchToFlow() {
    this.cancelFlowStateAwareTimers();
    this.activateFlowIntent('click');
    this.setActiveView('flow');
  }
  
  switchToText() {
    this.logger.debug('switchToText 被调用');
    this.cancelFlowStateAwareTimers();
    this.setActiveView('text');
  }
  
  // ========== 侧边栏控制 ==========
  
  toggleSidebar() {
    // 通过事件通知父组件切换侧边栏
    // 移动端和桌面端都使用全局事件来控制侧边栏
    window.dispatchEvent(new CustomEvent('toggle-sidebar'));
  }

  toggleDockFocusSession(): void {
    window.dispatchEvent(new CustomEvent('dock-focus-session-toggle'));
  }

  // ========== 文本栏折叠控制（桌面端） ==========

  /** 切换文本栏的折叠/展开状态 */
  toggleTextColumn() {
    this.uiState.isTextColumnCollapsed.update(v => !v);
  }

  /** 从折叠状态展开文本栏到最小可用宽度（25%） */
  expandTextColumnToMin() {
    this.uiState.textColumnRatio.set(25);
    this.uiState.isTextColumnCollapsed.set(false);
  }
  
  private navigateToProjectList() {
    void this.router.navigate(['/projects']);
  }
  
  // ========== 流程图节点定位 ==========
  
  onFocusFlowNode(taskId: string) {
    if (!this.uiState.isMobile()) {
      this.activateFlowIntent('click');
      // 通过命令服务发送居中请求，无需检查 flowView 实例
      this.flowCommand.centerOnNode(taskId, false);
    }
  }
  
  // ========== 内容区域调整 ==========
  
  private resizeRafId = 0;

  startContentResize(e: MouseEvent) {
    e.preventDefault();
    this.isResizingContent = true;
    this.uiState.isResizing.set(true);
    this.startX = e.clientX;
    this.startRatio = this.uiState.textColumnRatio();
    
    const mainEl = document.querySelector('main');
    this.mainContentWidth = mainEl ? mainEl.clientWidth : 1000;
    
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }
  
  /** 拖拽到最小阈值以下时自动折叠的百分比 */
  private static readonly COLLAPSE_THRESHOLD = 15;
  /** 拖拽过程中是否处于"临时折叠"状态（鼠标未松开） */
  private isDragCollapsed = false;
  /** 折叠/展开动画进行中（临时恢复 CSS transition） */
  readonly collapseAnimating = signal(false);
  private collapseAnimTimer: ReturnType<typeof setTimeout> | null = null;

  /** 临时启用 CSS 过渡动画（300ms 后自动关闭） */
  private enableCollapseAnimation(): void {
    if (this.collapseAnimTimer) clearTimeout(this.collapseAnimTimer);
    this.collapseAnimating.set(true);
    this.collapseAnimTimer = setTimeout(() => {
      this.collapseAnimating.set(false);
      this.collapseAnimTimer = null;
    }, 320); // 略大于 CSS duration-300
  }

  @HostListener('document:mousemove', ['$event'])
  onMouseMove(e: MouseEvent) {
    if (!this.isResizingContent) return;
    e.preventDefault();
    // 使用 rAF 节流，避免每个 mousemove 都触发布局计算
    if (this.resizeRafId) return;
    const clientX = e.clientX;
    this.resizeRafId = requestAnimationFrame(() => {
      this.resizeRafId = 0;
      const delta = clientX - this.startX;
      const deltaPercent = (delta / this.mainContentWidth) * 100;
      const rawRatio = this.startRatio + deltaPercent;

      if (rawRatio < ProjectShellComponent.COLLAPSE_THRESHOLD) {
        // 低于阈值 → 临时折叠（启用过渡动画做丝滑收缩）
        if (!this.isDragCollapsed) {
          this.isDragCollapsed = true;
          this.enableCollapseAnimation();
          this.uiState.textColumnRatio.set(0);
          this.uiState.isTextColumnCollapsed.set(true);
        }
        return;
      }

      // 回到阈值之上 → 取消折叠，启用过渡动画做丝滑展开
      if (this.isDragCollapsed) {
        this.isDragCollapsed = false;
        this.enableCollapseAnimation();
        this.uiState.isTextColumnCollapsed.set(false);
        // 从最小可用值开始，而非跳到 rawRatio
        const newRatio = Math.max(25, Math.min(75, rawRatio));
        this.uiState.textColumnRatio.set(newRatio);
        return;
      }

      const newRatio = Math.max(25, Math.min(75, rawRatio));
      this.uiState.textColumnRatio.set(newRatio);
    });
  }
  
  @HostListener('document:mouseup')
  onMouseUp() {
    if (this.isResizingContent) {
      if (this.resizeRafId) {
        cancelAnimationFrame(this.resizeRafId);
        this.resizeRafId = 0;
      }
      // 松开时若处于临时折叠 → 保持折叠并启用过渡动画
      if (this.isDragCollapsed) {
        this.enableCollapseAnimation();
      }
      this.isDragCollapsed = false;
      this.isResizingContent = false;
      this.uiState.isResizing.set(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  }
  
  // ========== 文本视图滑动手势 ==========
  // 允许从文本视图向左滑动切换到流程图
  // 流程图视图不处理滑动手势，避免与画布操作冲突
  
  onTextViewTouchStart(e: TouchEvent) {
    if (!this.uiState.isMobile()) return;
    if (e.touches.length !== 1) return;
    
    this.textViewSwipeState = {
      startX: e.touches[0].clientX,
      startY: e.touches[0].clientY,
      isSwiping: false
    };
  }
  
  onTextViewTouchMove(e: TouchEvent) {
    if (!this.uiState.isMobile()) return;
    if (e.touches.length !== 1) return;
    
    const deltaX = e.touches[0].clientX - this.textViewSwipeState.startX;
    const deltaY = Math.abs(e.touches[0].clientY - this.textViewSwipeState.startY);
    
    // 只有水平滑动距离大于垂直滑动时才认为是切换手势
    // 向左滑动（deltaX < 0）切换到流程图
    if (deltaX < -30 && Math.abs(deltaX) > deltaY * 1.5) {
      this.textViewSwipeState.isSwiping = true;

      // 重要：一旦判断为“切换手势”，立刻阻止默认滚动/事件穿透。
      // 否则在切换到 Flow 后，同一触摸事件的后续阶段可能被 GoJS 捕获，引发画布抖动/跳位。
      if (e.cancelable) {
        e.preventDefault();
      }
      e.stopPropagation();
    }
  }
  
  onTextViewTouchEnd(e: TouchEvent) {
    if (!this.uiState.isMobile()) return;
    if (!this.textViewSwipeState.isSwiping) return;
    
    const deltaX = e.changedTouches[0].clientX - this.textViewSwipeState.startX;
    const threshold = 50; // 滑动阈值
    
    // 向左滑动切换到流程图
    if (deltaX < -threshold) {
      // 只在事件可取消时才阻止默认行为（避免浏览器警告）
      if (e.cancelable) {
        e.preventDefault();
      }
      e.stopPropagation();

      setTimeout(() => {
        if (this.isDestroyed) return;
        this.switchToFlow();
      }, 0);
    }
    
    this.textViewSwipeState.isSwiping = false;
  }
  
  // ========== 错误边界重试回调 ==========
  
  /**
   * 重试加载文本视图
   */
  retryTextView(): void {
    // 强制刷新当前视图
    this.setActiveView('text');
  }
  
  /**
   * 重试加载流程图视图
   * 移动端 FlowViewComponent 通过 @defer 延迟加载；桌面端直接向已挂载的 FlowView 发送重试命令。
   */
  retryFlowView(): void {
    // 触发流程图重新初始化
    this.activateFlowIntent('click');
    this.setActiveView('flow');
    // 通过命令服务发送重试命令
    // 命令会被缓存直到 FlowView 就绪
    this.flowCommand.retryDiagram();
  }
  
  /**
   * 打开新建项目模态框
   * 当没有活动项目时，点击占位区域触发
   */
  async openNewProjectModal(): Promise<void> {
    try {
      const component = await this.modalLoader.loadNewProjectModal();
      this.dynamicModal.open(component, {
        outputs: {
          close: () => this.dynamicModal.close(),
          confirm: (data: unknown) => {
            const { name, description } = data as { name: string; description: string };
            this.dynamicModal.close();
            void this.projectCoord.confirmCreateProject(name, description);
          }
        }
      });
    } catch (error) {
      this.toast.error('新建项目组件加载失败', '请检查网络连接后重试');
      this.logger.error('Failed to load new project modal', error);
    }
  }
  
  /**
   * 刷新页面 - 用于 @defer 加载失败时的恢复
   * 强制清除所有缓存并刷新，避免 Service Worker 再次返回过期/损坏的 chunk
   */
  reloadPage(): void {
    this.logger.warn('Triggering force cache clear due to @defer error');
    
    // 优先使用全局强制清缓存工具（彻底清除 SW + caches API）
    type ForceClearCacheWindow = Window & {
      __NANOFLOW_FORCE_CLEAR_CACHE__?: () => Promise<void> | void;
    };
    const forceClearCache = (window as ForceClearCacheWindow).__NANOFLOW_FORCE_CLEAR_CACHE__;

    if (typeof forceClearCache === 'function') {
      void Promise.resolve(forceClearCache()).catch(() => {
        window.location.reload();
      });
      return;
    }

    // 回退：手动清理缓存后刷新
    void this.forceClearCacheFallback();
  }

  /**
   * 回退缓存清理逻辑（当全局工具不可用时）
   */
  private async forceClearCacheFallback(): Promise<void> {
    try {
      // 清除所有 caches API 缓存
      if ('caches' in window) {
        const cacheNames = await caches.keys();
        await Promise.all(cacheNames.map(name => caches.delete(name)));
      }
      // 注销所有 Service Worker
      if ('serviceWorker' in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map(reg => reg.unregister()));
      }
    } catch (e) {
      this.logger.error('Force clear cache fallback failed', e);
    }
    window.location.reload();
  }
}
