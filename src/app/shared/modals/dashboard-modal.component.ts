import { Component, inject, Output, EventEmitter, computed, signal, OnInit, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActionQueueService } from '../../../services/action-queue.service';
import { SimpleSyncService } from '../../core/services/simple-sync.service';
import { RetryQueueService } from '../../core/services/sync/retry-queue.service';
import { AuthService } from '../../../services/auth.service';
import { ConflictStorageService, ConflictRecord } from '../../../services/conflict-storage.service';
import { ProjectOperationService } from '../../../services/project-operation.service';
import { ToastService } from '../../../services/toast.service';
import { SyncCoordinatorService } from '../../../services/sync-coordinator.service';
import { ConflictAutoResolverService, AutoResolutionReport } from '../../../services/conflict-auto-resolver.service';
import { type ConflictResolutionPlan, type TaskResolutionChoice } from '../../../services/conflict-resolution.types';
import { Task } from '../../../models';
import { ConflictTaskDiffComponent, TaskResolutionMap } from '../components/conflict-task-diff.component';

type TabKey = 'status' | 'conflicts' | 'queue';
type ConflictAction = 'local' | 'remote' | 'merge' | 'plan';

interface ConflictItem {
  projectId: string; projectName: string; reason: string; reasonLabel: string;
  conflictedAt: string; localTaskCount: number; remoteTaskCount: number;
  /** 本地任务原始数组（供 ConflictTaskDiff 组件使用） */
  localTasks: Task[];
  /** 云端任务原始数组 */
  remoteTasks: Task[];
  isResolving: boolean;
  /** 自动解决报告 */
  autoReport?: AutoResolutionReport;
  /** 当前云端快照是否为本轮冲突中新鲜抓取的版本 */
  remoteSnapshotFresh: boolean;
  /** 用户逐任务选择结果 */
  taskResolutions?: TaskResolutionMap;
  /** 是否启用了逐任务选择模式 */
  selectiveMode?: boolean;
  /** 当前正在执行的冲突处理动作 */
  activeResolution?: ConflictAction | null;
}

/** 仪表盘模态框 - 展示数据冲突、同步状态，支持内联冲突解决 */
@Component({
  selector: 'app-dashboard-modal',
  standalone: true,
  imports: [CommonModule, ConflictTaskDiffComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="fixed inset-0 bg-black/30 z-50 flex items-center justify-center backdrop-blur-sm animate-fade-in p-4" (click)="close.emit()">
      <div class="bg-white dark:bg-stone-900 rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden animate-scale-in flex flex-col" (click)="$event.stopPropagation()">

        <!-- 标题栏 -->
        <div class="px-4 py-3 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between bg-slate-50/50 dark:bg-slate-800/50">
          <div class="flex items-center gap-2.5">
            <div class="w-8 h-8 rounded-lg bg-indigo-500 flex items-center justify-center shadow-sm">
              <svg class="w-4.5 h-4.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
              </svg>
            </div>
            <div>
              <h2 class="text-sm font-bold text-slate-800 dark:text-slate-100">系统仪表盘</h2>
              <p class="text-[10px] text-slate-500 dark:text-slate-400">监控同步状态与数据冲突</p>
            </div>
          </div>
          <div class="flex items-center gap-2">
            <button
              (click)="resyncProject()"
              [disabled]="isResyncing()"
              class="px-2.5 py-1.5 text-[10px] font-medium bg-indigo-50 dark:bg-indigo-900/40 hover:bg-indigo-100 dark:hover:bg-indigo-800/40 text-indigo-600 dark:text-indigo-300 rounded-lg transition-colors disabled:opacity-50 flex items-center gap-1.5 border border-indigo-200 dark:border-indigo-700">
              @if (isResyncing()) {
                <svg class="animate-spin h-3 w-3" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
              } @else {
                <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
              }
              {{ isResyncing() ? '同步中' : '同步' }}
            </button>
            <button (click)="close.emit()" class="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-slate-200/60 dark:hover:bg-slate-700/60 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors">
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
            </button>
          </div>
        </div>

        <!-- Tab 导航栏 -->
        <div class="flex border-b border-slate-200 dark:border-slate-700 bg-slate-50/30 dark:bg-slate-800/30 px-4">
          <!-- 状态 -->
          <button (click)="activeTab.set('status')"
            class="relative px-3 py-2.5 text-xs font-medium transition-colors flex items-center gap-1.5"
            [ngClass]="{ 'text-indigo-600 dark:text-indigo-400': activeTab() === 'status', 'text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-300': activeTab() !== 'status' }">
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2"/></svg>
            状态
            @if (activeTab() === 'status') { <span class="absolute bottom-0 left-2 right-2 h-0.5 bg-indigo-500 dark:bg-indigo-400 rounded-full"></span> }
          </button>
          <!-- 冲突 -->
          <button (click)="activeTab.set('conflicts')"
            class="relative px-3 py-2.5 text-xs font-medium transition-colors flex items-center gap-1.5"
            [ngClass]="{ 'text-indigo-600 dark:text-indigo-400': activeTab() === 'conflicts', 'text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-300': activeTab() !== 'conflicts' }">
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>
            冲突
            @if (conflictCount() > 0) {
              <span class="px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-red-100 dark:bg-red-900/50 text-red-600 dark:text-red-400">{{ conflictCount() }}</span>
            }
            @if (activeTab() === 'conflicts') { <span class="absolute bottom-0 left-2 right-2 h-0.5 bg-indigo-500 dark:bg-indigo-400 rounded-full"></span> }
          </button>
          <!-- 队列 -->
          <button (click)="activeTab.set('queue')"
            class="relative px-3 py-2.5 text-xs font-medium transition-colors flex items-center gap-1.5"
            [ngClass]="{ 'text-indigo-600 dark:text-indigo-400': activeTab() === 'queue', 'text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-300': activeTab() !== 'queue' }">
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
            队列
            @if (pendingCount() > 0 || deadLetterCount() > 0) {
              <span class="px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-amber-100 dark:bg-amber-900/50 text-amber-600 dark:text-amber-400">{{ pendingCount() + deadLetterCount() }}</span>
            }
            @if (activeTab() === 'queue') { <span class="absolute bottom-0 left-2 right-2 h-0.5 bg-indigo-500 dark:bg-indigo-400 rounded-full"></span> }
          </button>
        </div>

        <!-- 内容区域 -->
        <div class="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar">

          <!-- ========== Tab: 状态概览 ========== -->
          @if (activeTab() === 'status') {
            <!-- 状态概览卡片 -->
            <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
              <!-- 同步状态 -->
              <div class="p-3 rounded-xl border transition-all"
                   [class.border-green-200]="isLoggedIn() && isOnline() && !offlineMode() && !hasIssues()"
                   [class.bg-green-50]="isLoggedIn() && isOnline() && !offlineMode() && !hasIssues()"
                   [class.border-amber-200]="!isOnline() || offlineMode() || !isLoggedIn()"
                   [class.bg-amber-50]="!isOnline() || offlineMode() || !isLoggedIn()"
                   [class.border-blue-200]="isSyncing()"
                   [class.bg-blue-50]="isSyncing()">
                <div class="flex items-center gap-2 mb-1.5">
                  <div class="w-2 h-2 rounded-full"
                       [class.bg-green-500]="isLoggedIn() && isOnline() && !offlineMode() && !hasIssues()"
                       [class.bg-amber-500]="!isOnline() || offlineMode() || !isLoggedIn()"
                       [class.bg-blue-500]="isSyncing()" [class.animate-pulse]="isSyncing()"></div>
                  <span class="text-[10px] font-bold text-slate-500 uppercase tracking-wider">同步状态</span>
                </div>
                <div class="text-xs font-semibold"
                     [class.text-green-700]="isLoggedIn() && isOnline() && !offlineMode() && !hasIssues()"
                     [class.text-amber-700]="!isOnline() || offlineMode() || !isLoggedIn()"
                     [class.text-blue-700]="isSyncing()">
                  {{ detailedStatus() }}
                </div>
              </div>

              <!-- 待处理操作（点击跳转队列 tab） -->
              <div class="p-3 rounded-xl border transition-all cursor-pointer"
                   (click)="pendingCount() > 0 ? activeTab.set('queue') : null"
                   [ngClass]="{ 'border-slate-200 dark:border-stone-700 bg-slate-50 dark:bg-stone-800': pendingCount() === 0, 'border-amber-200 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/30 hover:border-amber-300': pendingCount() > 0 }">
                <div class="flex items-center gap-2 mb-1.5">
                  <svg class="w-3.5 h-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
                  <span class="text-[10px] font-bold text-slate-500 uppercase tracking-wider">待处理操作</span>
                </div>
                <div class="flex items-center justify-between">
                  <span class="text-xl font-bold" [class.text-slate-300]="pendingCount() === 0" [class.text-amber-600]="pendingCount() > 0">{{ pendingCount() }}</span>
                  @if (pendingCount() > 0) {
                    <button (click)="$event.stopPropagation(); retryAll()" [disabled]="isProcessing()"
                      class="px-2 py-1 text-[10px] font-bold bg-amber-100 dark:bg-amber-800 hover:bg-amber-200 dark:hover:bg-amber-700 text-amber-700 dark:text-amber-200 rounded-lg transition-colors disabled:opacity-50 shadow-sm">
                      {{ isProcessing() ? '同步中...' : '立即同步' }}
                    </button>
                  }
                </div>
              </div>

              <!-- 数据冲突（点击跳转冲突 tab） -->
              <div class="p-3 rounded-xl border transition-all cursor-pointer"
                   (click)="conflictCount() > 0 ? activeTab.set('conflicts') : null"
                   [ngClass]="{ 'border-slate-200 dark:border-stone-700 bg-slate-50 dark:bg-stone-800': conflictCount() === 0, 'border-red-200 dark:border-red-700 bg-red-50 dark:bg-red-900/30 hover:border-red-300': conflictCount() > 0 }">
                <div class="flex items-center gap-2 mb-1.5">
                  <svg class="w-3.5 h-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>
                  <span class="text-[10px] font-bold text-slate-500 uppercase tracking-wider">数据冲突</span>
                </div>
                <div class="flex items-center justify-between">
                  <span class="text-xl font-bold" [class.text-slate-300]="conflictCount() === 0" [class.text-red-600]="conflictCount() > 0">{{ conflictCount() }}</span>
                  @if (conflictCount() > 0) { <span class="text-[10px] text-red-500 font-medium">点击查看 →</span> }
                </div>
              </div>
            </div>

            <!-- 离线模式提示（安心感设计） -->
            @if (!isOnline()) {
              <div class="p-3 bg-sky-50 dark:bg-sky-900/30 border border-sky-200 dark:border-sky-800/50 rounded-lg flex items-start gap-2">
                <svg class="w-4 h-4 text-sky-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
                <div>
                  <h3 class="text-xs font-semibold text-sky-800 dark:text-sky-200 mb-0.5">离线模式 · 数据安全</h3>
                  <p class="text-[11px] text-sky-700 dark:text-sky-300">您可以继续正常编辑，所有更改都安全地保存在本地。网络恢复后将自动同步到云端，无需手动操作。</p>
                </div>
              </div>
            }

            <!-- 同步错误 -->
            @if (syncError()) {
              <div class="p-3 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800/50 rounded-lg flex items-start gap-2">
                <svg class="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>
                <div>
                  <h3 class="text-xs font-semibold text-red-800 dark:text-red-200 mb-0.5">同步错误</h3>
                  <p class="text-[11px] text-red-700 dark:text-red-300">{{ syncError() }}</p>
                </div>
              </div>
            }
          }

          <!-- ========== Tab: 冲突解决 ========== -->
          @if (activeTab() === 'conflicts') {
            @if (conflictCount() > 0) {
              <div class="space-y-4">
                @for (conflict of conflictItems(); track conflict.projectId) {
                  <div class="border border-stone-200 dark:border-stone-700 rounded-lg overflow-hidden bg-white dark:bg-stone-900">
                    <!-- 冲突头部：项目名 + 原因 + 操作按钮 -->
                    <div class="p-3 bg-stone-50/80 dark:bg-stone-800/50 border-b border-stone-200 dark:border-stone-700">
                      <div class="flex items-center justify-between gap-3 mb-2">
                        <div class="flex items-center gap-2 min-w-0">
                          <span class="text-sm font-semibold text-stone-800 dark:text-stone-100 truncate">{{ conflict.projectName }}</span>
                          <span class="px-1.5 py-0.5 text-[9px] font-medium rounded flex-shrink-0"
                                [ngClass]="{
                                  'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300': conflict.reason === 'concurrent_edit',
                                  'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300': conflict.reason === 'network_recovery',
                                  'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300': conflict.reason === 'version_mismatch',
                                  'bg-stone-100 text-stone-600 dark:bg-stone-700 dark:text-stone-300': conflict.reason !== 'concurrent_edit' && conflict.reason !== 'network_recovery' && conflict.reason !== 'version_mismatch'
                                }">
                            {{ conflict.reasonLabel }}
                          </span>
                        </div>
                        <div class="text-[10px] text-stone-400 dark:text-stone-500 whitespace-nowrap flex items-center gap-2">
                          <span>本地 {{ conflict.localTaskCount }}</span>
                          <span>·</span>
                          <span>云端 {{ conflict.remoteTaskCount }}</span>
                          <span>·</span>
                          <span>{{ formatRelativeTime(conflict.conflictedAt) }}</span>
                        </div>
                      </div>

                      <!-- 系统诊断摘要 -->
                      @if (conflict.autoReport) {
                        <div class="mb-3 p-2.5 bg-white dark:bg-stone-800 rounded-lg border border-stone-100 dark:border-stone-700">
                          <div class="flex items-center gap-2 mb-1.5">
                            <svg class="w-3.5 h-3.5 text-violet-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                              <path stroke-linecap="round" stroke-linejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                            </svg>
                            <span class="text-[11px] font-semibold text-stone-700 dark:text-stone-200">智能诊断</span>
                            <span class="flex-1"></span>
                            <div class="flex gap-1.5 text-[9px]">
                              @if (conflict.autoReport.autoCount > 0) {
                                <span class="px-1.5 py-0.5 bg-green-100 dark:bg-green-900/40 text-green-600 dark:text-green-400 rounded">{{ conflict.autoReport.autoCount }} 自动</span>
                              }
                              @if (conflict.autoReport.suggestCount > 0) {
                                <span class="px-1.5 py-0.5 bg-sky-100 dark:bg-sky-900/40 text-sky-600 dark:text-sky-400 rounded">{{ conflict.autoReport.suggestCount }} 建议</span>
                              }
                              @if (conflict.autoReport.manualCount > 0) {
                                <span class="px-1.5 py-0.5 bg-orange-100 dark:bg-orange-900/40 text-orange-600 dark:text-orange-400 rounded">{{ conflict.autoReport.manualCount }} 需确认</span>
                              }
                            </div>
                          </div>
                          <p class="text-[10px] text-stone-500 dark:text-stone-400">{{ conflict.autoReport.overallSuggestion }}</p>
                          <p class="text-[10px] text-violet-600 dark:text-violet-400 mt-1">{{ getSuggestedResolutionSummary(conflict) }}</p>
                        </div>
                      }

                      @if (conflict.isResolving) {
                        <div class="mb-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-[10px] text-amber-700 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200">
                          <div class="flex items-center gap-1.5 font-medium">
                            <svg class="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                              <circle cx="12" cy="12" r="9" class="opacity-30" />
                              <path d="M21 12a9 9 0 00-9-9" />
                            </svg>
                            {{ getActiveResolutionLabel(conflict) }}
                          </div>
                          <p class="mt-1 text-[10px] text-amber-600 dark:text-amber-300">处理完成前会暂时锁定本项目的冲突按钮，避免重复提交。</p>
                        </div>
                      }

                      <p class="mb-2 text-[10px] text-stone-500 dark:text-stone-400">操作语义：本地覆盖云端 / 云端覆盖本地 / 合并保留两边。选择后会立即执行。</p>

                      <!-- 操作按钮 -->
                      <div class="flex flex-wrap gap-2">
                        @if (canApplySuggestedResolution(conflict)) {
                          <button (click)="applyAutoResolution(conflict)" [disabled]="conflict.isResolving"
                            class="flex-1 min-w-[100px] px-3 py-2 text-xs font-medium bg-violet-500 hover:bg-violet-600 text-white rounded-lg transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5">
                            @if (conflict.isResolving && conflict.activeResolution === 'plan') {
                              <svg class="animate-spin h-3 w-3" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                            } @else {
                              <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" /></svg>
                            }
                            {{ conflict.isResolving && conflict.activeResolution === 'plan' ? '正在按系统建议处理' : getSuggestedResolutionLabel(conflict) }}
                          </button>
                        }
                        <button (click)="toggleSelectiveMode(conflict.projectId)" [disabled]="conflict.isResolving"
                          class="px-3 py-2 text-xs font-medium rounded-lg transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5 border"
                          [ngClass]="{
                            'bg-violet-50 dark:bg-violet-900/30 border-violet-300 dark:border-violet-600 text-violet-700 dark:text-violet-300': conflict.selectiveMode,
                            'bg-white dark:bg-stone-800 border-stone-200 dark:border-stone-600 text-stone-600 dark:text-stone-300 hover:bg-stone-50 dark:hover:bg-stone-700': !conflict.selectiveMode
                          }">
                          {{ conflict.selectiveMode ? '✓ 逐任务选择中' : '逐任务选择' }}
                        </button>
                        <button (click)="resolveUseLocal(conflict.projectId)" [disabled]="conflict.isResolving"
                          class="px-3 py-2 text-xs font-medium bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5">
                          @if (conflict.isResolving && conflict.activeResolution === 'local') {
                            <svg class="animate-spin h-3 w-3" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                          }
                          {{ conflict.isResolving && conflict.activeResolution === 'local' ? '正在本地覆盖云端' : '本地覆盖云端' }}
                        </button>
                        <button (click)="resolveUseRemote(conflict.projectId)" [disabled]="conflict.isResolving"
                          class="px-3 py-2 text-xs font-medium bg-teal-500 hover:bg-teal-600 text-white rounded-lg transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5">
                          @if (conflict.isResolving && conflict.activeResolution === 'remote') {
                            <svg class="animate-spin h-3 w-3" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                          }
                          {{ conflict.isResolving && conflict.activeResolution === 'remote' ? '正在云端覆盖本地' : '云端覆盖本地' }}
                        </button>
                        <button (click)="resolveKeepBoth(conflict.projectId)" [disabled]="conflict.isResolving"
                          class="px-3 py-2 text-xs font-medium bg-stone-500 hover:bg-stone-600 text-white rounded-lg transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5">
                          @if (conflict.isResolving && conflict.activeResolution === 'merge') {
                            <svg class="animate-spin h-3 w-3" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                          }
                          {{ conflict.isResolving && conflict.activeResolution === 'merge' ? '正在合并两边修改' : '合并保留两边' }}
                        </button>
                      </div>
                    </div>
                    <!-- 字段级差异对比（含系统推荐） -->
                    <div class="p-3">
                      <app-conflict-task-diff
                        [localTasks]="conflict.localTasks"
                        [remoteTasks]="conflict.remoteTasks"
                        [selectable]="!!conflict.selectiveMode"
                        [recommendations]="conflict.autoReport?.recommendations || []"
                        (selectionChange)="onTaskSelectionChange(conflict.projectId, $event)" />
                    </div>
                  </div>
                }
                <div class="text-[10px] text-stone-400 dark:text-stone-500 p-2 bg-stone-50 dark:bg-stone-800 rounded-lg space-y-1">
                  <p>💡 <span class="font-medium">系统建议说明：</span></p>
                  <p><span class="px-1 py-0.5 bg-green-100 dark:bg-green-900/40 text-green-600 dark:text-green-400 rounded text-[9px]">自动</span> 系统可安全地自动处理（如仅布局变化）</p>
                  <p><span class="px-1 py-0.5 bg-sky-100 dark:bg-sky-900/40 text-sky-600 dark:text-sky-400 rounded text-[9px]">建议</span> 系统有推荐，建议您确认后应用</p>
                  <p><span class="px-1 py-0.5 bg-orange-100 dark:bg-orange-900/40 text-orange-600 dark:text-orange-400 rounded text-[9px]">需确认</span> 需要您手动选择保留哪个版本</p>
                  <p class="mt-1">您的手动选择始终拥有最高优先级，系统建议仅供参考。</p>
                </div>
              </div>
            } @else {
              <div class="py-12 text-center">
                <svg class="w-10 h-10 mx-auto mb-3 text-green-300 dark:text-green-700" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
                <p class="text-sm font-medium text-stone-500 dark:text-stone-400">没有数据冲突</p>
                <p class="text-[10px] text-stone-400 dark:text-stone-500 mt-1">所有数据已同步一致</p>
              </div>
            }
          }

          <!-- ========== Tab: 操作队列 ========== -->
          @if (activeTab() === 'queue') {
            <!-- 待处理操作 -->
            @if (pendingCount() > 0) {
              <div class="p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/50 rounded-lg flex items-center justify-between">
                <div>
                  <span class="text-xs font-semibold text-amber-700 dark:text-amber-300">{{ pendingCount() }} 个操作等待同步</span>
                  <p class="text-[10px] text-amber-600 dark:text-amber-400 mt-0.5">网络恢复后将自动同步</p>
                </div>
                <button (click)="retryAll()" [disabled]="isProcessing()"
                  class="px-3 py-1.5 text-[10px] font-bold bg-amber-500 hover:bg-amber-600 text-white rounded-lg transition-colors disabled:opacity-50">
                  {{ isProcessing() ? '同步中...' : '立即同步' }}
                </button>
              </div>
            } @else if (deadLetterCount() === 0) {
              <div class="py-12 text-center">
                <svg class="w-10 h-10 mx-auto mb-3 text-green-300 dark:text-green-700" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
                <p class="text-sm font-medium text-stone-500 dark:text-stone-400">队列为空</p>
                <p class="text-[10px] text-stone-400 dark:text-stone-500 mt-1">所有操作已同步完成</p>
              </div>
            }

            <!-- 死信队列（失败操作） -->
            @if (deadLetterCount() > 0) {
              <div class="space-y-3">
                <div class="flex items-center justify-between">
                  <h3 class="text-sm font-semibold text-stone-700 dark:text-stone-200">失败的操作 ({{ deadLetterCount() }})</h3>
                  <button (click)="clearAllDeadLetters()"
                    class="text-xs text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 font-medium">
                    全部清空
                  </button>
                </div>
                <div class="space-y-2 max-h-64 overflow-y-auto">
                  @for (item of deadLetters(); track item.id) {
                    <div class="p-3 bg-red-50 dark:bg-red-900/30 border border-red-100 dark:border-red-800/50 rounded-lg">
                      <div class="flex items-start justify-between gap-2 mb-2">
                        <div class="flex-1 min-w-0">
                          <div class="text-xs font-medium text-red-800 dark:text-red-200 mb-1">{{ getActionLabel(item.action) }}</div>
                          <div class="text-[10px] text-red-600 dark:text-red-300 break-all">{{ item.error }}</div>
                        </div>
                        <span class="text-[9px] text-red-400 dark:text-red-500 whitespace-nowrap">{{ formatDate(item.timestamp) }}</span>
                      </div>
                      <div class="flex gap-2">
                        <button (click)="retryDeadLetter(item.id)"
                          class="flex-1 px-2 py-1 text-[10px] font-medium bg-red-100 dark:bg-red-800/50 hover:bg-red-200 dark:hover:bg-red-700/50 text-red-700 dark:text-red-200 rounded transition-colors">
                          重试
                        </button>
                        <button (click)="dismissDeadLetter(item.id)"
                          class="flex-1 px-2 py-1 text-[10px] font-medium bg-stone-100 dark:bg-stone-700 hover:bg-stone-200 dark:hover:bg-stone-600 text-stone-600 dark:text-stone-300 rounded transition-colors">
                          忽略
                        </button>
                      </div>
                    </div>
                  }
                </div>
              </div>
            }
          }

        </div>
      </div>
    </div>
  `
})
export class DashboardModalComponent implements OnInit {
  private actionQueue = inject(ActionQueueService);
  private syncService = inject(SimpleSyncService);
  private retryQueue = inject(RetryQueueService);
  private authService = inject(AuthService);
  private conflictStorage = inject(ConflictStorageService);
  private projectOps = inject(ProjectOperationService);
  private syncCoordinator = inject(SyncCoordinatorService);
  private autoResolver = inject(ConflictAutoResolverService);
  private toastService = inject(ToastService);

  @Output() close = new EventEmitter<void>();
  @Output() openConflictCenter = new EventEmitter<void>();

  readonly isLoggedIn = computed(() => !!this.authService.currentUserId());

  /** 当前活跃的 Tab */
  activeTab = signal<TabKey>('status');
  showDeadLetters = signal(false);
  isRetrying = signal(false);
  isResyncing = signal(false);

  conflictItems = signal<ConflictItem[]>([]);
  readonly pendingCount = this.actionQueue.queueSize;
  readonly deadLetterCount = this.actionQueue.deadLetterSize;
  readonly deadLetters = this.actionQueue.deadLetterQueue;

  /**
   * 队列是否正在处理（原型方法）
   *
   * 【Bug Fix】从 class field 改为原型方法，与 gate-actions.component.ts 保持一致。
   * 原因：SW 缓存导致 chunk 不一致时，class field 可能未初始化，
   * 模板调用 isProcessing() 报 "n.isProcessing is not a function"。
   */
  isProcessing(): boolean {
    try {
      return this.actionQueue?.isProcessing?.() ?? false;
    } catch {
      return false;
    }
  }

  readonly conflictCount = this.conflictStorage.conflictCount;
  readonly hasUnresolvedConflicts = this.conflictStorage.hasUnresolvedConflicts;
  readonly isOnline = computed(() => this.syncService.syncState().isOnline);
  readonly isSyncing = computed(() => this.syncService.syncState().isSyncing);
  readonly syncError = computed(() => this.syncService.syncState().syncError);
  readonly offlineMode = computed(() => this.syncService.syncState().offlineMode);
  readonly hasIssues = computed(() =>
    this.deadLetterCount() > 0 || this.pendingCount() > 0 || !!this.syncError() || this.offlineMode() || this.conflictCount() > 0
  );

  readonly detailedStatus = computed(() => {
    if (this.isSyncing()) return '正在同步数据...';
    if (this.deadLetterCount() > 0) return `${this.deadLetterCount()} 个操作失败`;
    if (this.pendingCount() > 0) return `${this.pendingCount()} 个操作待同步`;
    if (!this.isOnline()) return '离线模式 - 数据保存在本地';
    if (this.offlineMode()) return '连接中断 - 恢复后自动同步';
    if (this.syncError()) return '同步错误';
    if (!this.isLoggedIn()) return '数据保存在本地 - 登录后可同步到云端';
    return '数据已保存到云端';
  });

  async retryAll(): Promise<void> {
    if (this.isRetrying() || this.isProcessing()) return;
    this.isRetrying.set(true);
    try {
      await this.retryQueue.processQueue(undefined, true);
      await this.actionQueue.processQueue();
      this.toastService.success('同步完成', '所有待处理操作已成功同步');
    } catch {
      this.toastService.error('同步失败', '部分操作同步失败，请稍后重试');
    } finally {
      this.isRetrying.set(false);
    }
  }

  retryDeadLetter(itemId: string): void { this.actionQueue.retryDeadLetter(itemId); }
  dismissDeadLetter(itemId: string): void { this.actionQueue.dismissDeadLetter(itemId); }

  clearAllDeadLetters(): void {
    this.actionQueue.clearDeadLetterQueue();
    this.toastService.success('已清空', '所有失败记录已清空');
  }

  async resyncProject(): Promise<void> {
    if (this.isResyncing()) return;
    this.isResyncing.set(true);
    try {
      const result = await this.syncCoordinator.resyncActiveProject();
      if (result.success) {
        result.conflictDetected
          ? this.toastService.warning('同步完成', result.message, { duration: 5000 })
          : this.toastService.success('同步完成', result.message);
      } else {
        this.toastService.error('同步失败', result.message);
      }
    } catch {
      this.toastService.error('同步错误', '重新同步时发生意外错误');
    } finally {
      this.isResyncing.set(false);
    }
  }

  getActionLabel(action: { type: string; entityType: string; entityId: string }): string {
    const typeLabels: Record<string, string> = { create: '创建', update: '更新', delete: '删除' };
    const entityLabels: Record<string, string> = { project: '项目', task: '任务', preference: '设置' };
    return `${typeLabels[action.type] || action.type} ${entityLabels[action.entityType] || action.entityType}`;
  }

  formatDate(isoString: string): string {
    const diffMs = Date.now() - new Date(isoString).getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return '刚刚';
    if (diffMins < 60) return `${diffMins} 分钟前`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours} 小时前`;
    return `${Math.floor(diffHours / 24)} 天前`;
  }

  formatRelativeTime(isoString: string): string { return this.formatDate(isoString); }

  ngOnInit(): void {
    this.loadConflicts();
  }

  async loadConflicts(): Promise<void> {
    const conflicts = await this.conflictStorage.getAllConflicts();
    const items: ConflictItem[] = conflicts.map(conflict => this.mapConflictToItem(conflict));
    this.conflictItems.set(items);

    // 有冲突时自动跳转到冲突 tab
    if (items.length > 0) {
      this.activeTab.set('conflicts');
    }
  }

  private mapConflictToItem(record: ConflictRecord): ConflictItem {
    const localTasks: Task[] = Array.isArray(record.localProject?.tasks) ? record.localProject!.tasks : [];
    const remoteTasks: Task[] = Array.isArray(record.remoteProject?.tasks) ? record.remoteProject!.tasks : [];

    // 生成自动解决报告
    const autoReport = this.autoResolver.analyze(record.projectId, localTasks, remoteTasks);

    return {
      projectId: record.projectId,
      projectName: record.localProject?.name || record.remoteProject?.name || '未知项目',
      reason: record.reason,
      reasonLabel: this.getReasonLabel(record.reason),
      conflictedAt: record.conflictedAt,
      localTaskCount: localTasks.length,
      remoteTaskCount: remoteTasks.length,
      localTasks,
      remoteTasks,
      isResolving: false,
      activeResolution: null,
      autoReport,
      remoteSnapshotFresh: record.remoteSnapshotFresh === true,
      selectiveMode: false,
    };
  }

  private getReasonLabel(reason: string): string {
    const labels: Record<string, string> = {
      version_mismatch: '版本不匹配', concurrent_edit: '并发编辑',
      network_recovery: '网络恢复', status_conflict: '状态冲突', field_conflict: '字段冲突',
    };
    return labels[reason] || reason;
  }

  async resolveUseLocal(projectId: string): Promise<void> { await this.resolveConflictWithStrategy(projectId, 'local'); }
  async resolveUseRemote(projectId: string): Promise<void> { await this.resolveConflictWithStrategy(projectId, 'remote'); }

  /** 切换逐任务选择模式 */
  toggleSelectiveMode(projectId: string): void {
    this.conflictItems.update(items =>
      items.map(item => item.projectId === projectId
        ? { ...item, selectiveMode: !item.selectiveMode }
        : item
      )
    );
  }

  /** 接收逐任务选择变更 */
  onTaskSelectionChange(projectId: string, selections: TaskResolutionMap): void {
    this.conflictItems.update(items =>
      items.map(item => item.projectId === projectId
        ? { ...item, taskResolutions: selections }
        : item
      )
    );
  }

  /**
   * 应用系统自动解决建议
   * 将 auto/suggest 的推荐直接应用，manual 的保留用户已有选择
   */
  async applyAutoResolution(conflict: ConflictItem): Promise<void> {
    if (!conflict.autoReport) return;
    if (!conflict.remoteSnapshotFresh) {
      this.toastService.warning('建议暂不可直接应用', '当前云端快照不是本轮最新结果，请先重新同步或逐项确认后再处理');
      return;
    }

    this.setResolving(conflict.projectId, true, 'plan');
    try {
      const plan = this.buildResolutionPlan(conflict);
      const counts = this.countResolutionChoices(plan);
      const resolved = await this.projectOps.resolveConflictWithPlan(conflict.projectId, plan, { backgroundPersist: true });
      await this.loadConflicts();

      if (!resolved) {
        return;
      }

      const totalResolved = Object.keys(plan.taskChoices).length;
      const userSelectionCount = conflict.taskResolutions?.size ?? 0;
      this.toastService.success(
        '智能解决完成',
        `已按逐任务方案处理 ${totalResolved} 个冲突（${counts.local} 项保留本地，${counts.remote} 项采用云端${userSelectionCount > 0 ? `；其中 ${userSelectionCount} 项来自您的明确选择` : ''}）`
      );
    } catch {
      this.toastService.error('错误', '应用系统建议时发生意外错误');
    } finally {
      this.setResolving(conflict.projectId, false);
    }
  }

  async resolveKeepBoth(projectId: string): Promise<void> {
    this.setResolving(projectId, true, 'merge');
    try {
      const conflict = await this.conflictStorage.getConflict(projectId);
      if (!conflict) { this.toastService.error('错误', '未找到冲突数据'); return; }
      const resolved = await this.projectOps.resolveConflict(projectId, 'merge', { backgroundPersist: true });
      await this.loadConflicts();
      if (resolved) { this.toastService.success('已保留两者', '云端版本的任务已作为副本添加'); }
    } catch {
      this.toastService.error('错误', '解决冲突时发生意外错误');
    } finally {
      this.setResolving(projectId, false);
    }
  }

  private async resolveConflictWithStrategy(projectId: string, strategy: 'local' | 'remote'): Promise<void> {
    this.setResolving(projectId, true, strategy);
    try {
      const conflict = await this.conflictStorage.getConflict(projectId);
      if (!conflict) { this.toastService.error('错误', '未找到冲突数据'); return; }
      const resolved = await this.projectOps.resolveConflict(projectId, strategy, { backgroundPersist: true });
      await this.loadConflicts();
      if (!resolved) {
        return;
      }

      if (strategy === 'local') {
        this.toastService.success('已保留本地修改', '当前项目已按本地版本解决冲突');
      } else {
        this.toastService.success('已采用云端版本', '当前项目已切换到云端结果');
      }
    } catch {
      this.toastService.error('错误', '解决冲突时发生意外错误');
    } finally {
      this.setResolving(projectId, false);
    }
  }

  private setResolving(projectId: string, isResolving: boolean, activeResolution: ConflictAction | null = null): void {
    this.conflictItems.update(items =>
      items.map(item => item.projectId === projectId ? { ...item, isResolving, activeResolution } : item)
    );
  }

  getActiveResolutionLabel(conflict: ConflictItem): string {
    switch (conflict.activeResolution) {
      case 'local':
        return '正在使用本地结果覆盖云端…';
      case 'remote':
        return '正在使用云端结果覆盖本地…';
      case 'merge':
        return '正在合并两边修改…';
      case 'plan':
        return '正在按系统建议逐任务处理…';
      default:
        return '正在处理冲突…';
    }
  }

  canApplySuggestedResolution(conflict: ConflictItem): boolean {
    if (!conflict.remoteSnapshotFresh) {
      return false;
    }

    return !!conflict.autoReport
      && conflict.autoReport.recommendations.length > 0
      && this.getPendingManualSelections(conflict) === 0;
  }

  getSuggestedResolutionLabel(conflict: ConflictItem): string {
    const userSelectionCount = conflict.taskResolutions?.size ?? 0;
    return userSelectionCount > 0 ? `应用系统建议与 ${userSelectionCount} 项选择` : '应用系统建议';
  }

  getSuggestedResolutionSummary(conflict: ConflictItem): string {
    if (!conflict.autoReport) {
      return '';
    }

    if (!conflict.remoteSnapshotFresh) {
      return '当前展示的云端快照不是本轮冲突中的最新结果，系统建议仅供参考；请先重新同步或逐项确认。';
    }

    const manualPending = this.getPendingManualSelections(conflict);
    const userSelectionCount = conflict.taskResolutions?.size ?? 0;
    if (manualPending > 0) {
      return `系统已完成 ${conflict.autoReport.autoCount + conflict.autoReport.suggestCount} 项判断，仍有 ${manualPending} 项高风险冲突需要您确认。`;
    }

    if (userSelectionCount > 0) {
      return `将优先采用您的 ${userSelectionCount} 项明确选择，其余 ${Math.max(conflict.autoReport.recommendations.length - userSelectionCount, 0)} 项按系统建议处理。`;
    }

    return '系统已完成逐任务判断，应用后会按任务分别保留本地或云端版本。';
  }

  private getPendingManualSelections(conflict: ConflictItem): number {
    const report = conflict.autoReport;
    if (!report) {
      return 0;
    }

    const selections = conflict.taskResolutions ?? new Map<string, 'local' | 'remote'>();
    return report.recommendations.filter(rec => rec.confidence === 'manual' && !selections.has(rec.taskId)).length;
  }

  private buildResolutionPlan(conflict: ConflictItem): ConflictResolutionPlan {
    const taskChoices: Record<string, TaskResolutionChoice> = {};
    const selections = conflict.taskResolutions ?? new Map<string, 'local' | 'remote'>();

    for (const recommendation of conflict.autoReport?.recommendations ?? []) {
      const userChoice = selections.get(recommendation.taskId);
      if (userChoice) {
        taskChoices[recommendation.taskId] = userChoice;
        continue;
      }

      taskChoices[recommendation.taskId] = recommendation.recommendation === 'remote' ? 'remote' : 'local';
    }

    return {
      taskChoices,
      appliedBy: selections.size === 0 ? 'system' : 'mixed',
    };
  }

  private countResolutionChoices(plan: ConflictResolutionPlan): { local: number; remote: number } {
    const counts = { local: 0, remote: 0 };

    for (const choice of Object.values(plan.taskChoices)) {
      if (choice === 'local') {
        counts.local++;
      } else {
        counts.remote++;
      }
    }

    return counts;
  }
}
