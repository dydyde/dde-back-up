import { Component, signal, Output, EventEmitter, input, computed, ChangeDetectionStrategy, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Project, Task } from '../../../models';
import { ConflictTaskDiffComponent, TaskResolutionMap } from '../components/conflict-task-diff.component';
import { ConflictAutoResolverService } from '../../../services/conflict-auto-resolver.service';
import { type ConflictResolutionPlan, type TaskResolutionChoice } from '../../../services/conflict-resolution.types';

/**
 * 冲突解决模态框组件
 * 提供本地/远程版本选择及智能合并功能
 * 包含字段级别的差异对比视图和逐任务选择性保留
 */
@Component({
  selector: 'app-conflict-modal',
  standalone: true,
  imports: [CommonModule, ConflictTaskDiffComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      data-testid="conflict-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="conflict-modal-title"
      aria-describedby="conflict-modal-description"
      class="bg-white dark:bg-stone-900 rounded-xl shadow-2xl w-[min(100vw-2rem,48rem)] p-6 animate-scale-in max-h-[90vh] overflow-y-auto"
      (click)="$event.stopPropagation()">
        <div class="flex items-center gap-3 mb-4">
          <div class="w-10 h-10 rounded-full bg-amber-100 dark:bg-amber-900/50 flex items-center justify-center flex-shrink-0">
            <svg class="w-5 h-5 text-amber-600 dark:text-amber-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
            </svg>
          </div>
          <div>
            <h3 id="conflict-modal-title" class="text-lg font-semibold text-stone-800 dark:text-stone-100">数据冲突</h3>
            <p id="conflict-modal-description" class="text-xs text-stone-500 dark:text-stone-400">本地和云端数据存在差异，请选择解决方案</p>
          </div>
        </div>

        <!-- 差异概览 -->
        <div class="mb-4 p-3 bg-stone-50 dark:bg-stone-800 rounded-lg border border-stone-200 dark:border-stone-700">
          <div class="text-xs font-medium text-stone-600 dark:text-stone-300 mb-2 flex items-center gap-1.5">
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
            </svg>
            差异概览
          </div>
          <div class="grid grid-cols-3 gap-2 text-[10px]">
            <div class="p-2 bg-white dark:bg-stone-700 rounded border border-stone-100 dark:border-stone-600">
              <div class="text-stone-400 dark:text-stone-400 mb-0.5">项目名称</div>
              <div class="font-medium text-stone-700 dark:text-stone-200">{{ conflictData()?.localProject?.name || conflictData()?.remoteProject?.name }}</div>
            </div>
            <div class="p-2 bg-white dark:bg-stone-700 rounded border border-stone-100 dark:border-stone-600">
              <div class="text-stone-400 dark:text-stone-400 mb-0.5">本地任务数</div>
              <div class="font-medium text-indigo-600 dark:text-indigo-400">{{ conflictData()?.localProject?.tasks?.length || 0 }}</div>
            </div>
            <div class="p-2 bg-white dark:bg-stone-700 rounded border border-stone-100 dark:border-stone-600">
              <div class="text-stone-400 dark:text-stone-400 mb-0.5">云端任务数</div>
              <div class="font-medium text-teal-600 dark:text-teal-400">{{ conflictData()?.remoteProject?.tasks?.length || 0 }}</div>
            </div>
          </div>
        </div>

        <!-- 字段级差异对比（使用新的差异组件，支持逐任务展开和选择性保留） -->
        <div class="mb-4">
          <app-conflict-task-diff
            [localTasks]="localTasks()"
            [remoteTasks]="remoteTasks()"
            [selectable]="selectiveMode()"
            [recommendations]="recommendations()"
            (selectionChange)="onSelectionChange($event)" />
        </div>

        <!-- 解决模式切换 -->
        <div class="mb-4 flex items-center gap-2">
          <button
            data-testid="conflict-selective-toggle"
            (click)="selectiveMode.set(!selectiveMode())"
            class="text-[10px] font-medium px-2.5 py-1 rounded-md transition-colors"
            [ngClass]="{
              'bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300 border border-violet-300 dark:border-violet-600': selectiveMode(),
              'bg-stone-100 dark:bg-stone-800 text-stone-500 dark:text-stone-400 border border-stone-200 dark:border-stone-600 hover:bg-stone-200 dark:hover:bg-stone-700': !selectiveMode()
            }">
            {{ selectiveMode() ? '✓ 逐任务选择模式' : '开启逐任务选择' }}
          </button>
          @if (selectiveMode()) {
            <span class="text-[9px] text-stone-400 dark:text-stone-500">对冲突任务逐个指定保留本地或云端版本</span>
          }
        </div>

        <!-- 解决方案选项 -->
        <div class="grid grid-cols-2 gap-3 mb-4">
          <!-- 本地版本 -->
          <div class="p-3 rounded-lg border-2 border-stone-200 dark:border-stone-600 hover:border-indigo-400 dark:hover:border-indigo-500 transition-colors cursor-pointer group"
               (click)="resolveLocal.emit()">
            <div class="flex items-center gap-2 mb-2">
              <svg class="w-4 h-4 text-indigo-500 dark:text-indigo-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 8h10M7 12h6"/>
              </svg>
              <span class="text-sm font-medium text-stone-700 dark:text-stone-200 group-hover:text-indigo-700 dark:group-hover:text-indigo-400">本地版本</span>
            </div>
            <div class="text-xs text-stone-500 dark:text-stone-400 space-y-1">
              <p class="flex items-center gap-1.5">
                <span class="w-1.5 h-1.5 rounded-full bg-indigo-400"></span>
                任务数：<span class="font-medium text-indigo-600 dark:text-indigo-400">{{ conflictData()?.localProject?.tasks?.length || 0 }}</span>
              </p>
              <p class="flex items-center gap-1.5">
                <span class="w-1.5 h-1.5 rounded-full bg-stone-300 dark:bg-stone-500"></span>
                修改：{{ conflictData()?.localProject?.updatedAt | date:'yyyy-MM-dd HH:mm' }}
              </p>
            </div>
            <div class="mt-2 text-[10px] text-indigo-600 dark:text-indigo-300 bg-indigo-50 dark:bg-indigo-900/50 px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity">
              点击选择本地版本
            </div>
          </div>

          <!-- 云端版本 -->
          <div class="p-3 rounded-lg border-2 border-stone-200 dark:border-stone-600 hover:border-teal-400 dark:hover:border-teal-500 transition-colors cursor-pointer group"
               (click)="resolveRemote.emit()">
            <div class="flex items-center gap-2 mb-2">
              <svg class="w-4 h-4 text-teal-500 dark:text-teal-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M18 10h-1.26A8 8 0 109 20h9a5 5 0 000-10z"/>
              </svg>
              <span class="text-sm font-medium text-stone-700 dark:text-stone-200 group-hover:text-teal-700 dark:group-hover:text-teal-400">云端版本</span>
            </div>
            <div class="text-xs text-stone-500 dark:text-stone-400 space-y-1">
              <p class="flex items-center gap-1.5">
                <span class="w-1.5 h-1.5 rounded-full bg-teal-400"></span>
                任务数：<span class="font-medium text-teal-600 dark:text-teal-400">{{ conflictData()?.remoteProject?.tasks?.length || 0 }}</span>
              </p>
              <p class="flex items-center gap-1.5">
                <span class="w-1.5 h-1.5 rounded-full bg-stone-300 dark:bg-stone-500"></span>
                修改：{{ conflictData()?.remoteProject?.updatedAt | date:'yyyy-MM-dd HH:mm' }}
              </p>
            </div>
            <div class="mt-2 text-[10px] text-teal-600 dark:text-teal-300 bg-teal-50 dark:bg-teal-900/50 px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity">
              点击选择云端版本
            </div>
          </div>
        </div>

        <!-- 系统建议 -->
        <div class="mb-4 p-3 bg-gradient-to-r from-violet-50 to-indigo-50 dark:from-violet-900/30 dark:to-indigo-900/30 rounded-lg border border-violet-200 dark:border-violet-700">
          <div class="flex items-start gap-2">
            <svg class="w-4 h-4 text-violet-500 dark:text-violet-400 mt-0.5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M13 10V3L4 14h7v7l9-11h-7z"/>
            </svg>
            <div class="flex-1">
              <div class="text-xs font-medium text-violet-700 dark:text-violet-300 mb-1">系统建议（推荐）</div>
              <p class="text-[10px] text-violet-600 dark:text-violet-400 mb-1">{{ overallSuggestion() }}</p>
              <p class="text-[10px] text-violet-500 dark:text-violet-400 mb-2">{{ suggestedResolutionSummary() }}</p>
              <div class="flex flex-wrap items-center gap-2 mb-2 text-[9px]">
                @if (autoReport()?.autoCount) {
                  <span class="px-1.5 py-0.5 bg-green-100 dark:bg-green-900/40 text-green-600 dark:text-green-400 rounded">{{ autoReport()?.autoCount }} 自动</span>
                }
                @if (autoReport()?.suggestCount) {
                  <span class="px-1.5 py-0.5 bg-sky-100 dark:bg-sky-900/40 text-sky-600 dark:text-sky-400 rounded">{{ autoReport()?.suggestCount }} 建议</span>
                }
                @if (autoReport()?.manualCount) {
                  <span class="px-1.5 py-0.5 bg-orange-100 dark:bg-orange-900/40 text-orange-600 dark:text-orange-400 rounded">{{ autoReport()?.manualCount }} 需确认</span>
                }
              </div>
              <div class="flex flex-wrap gap-2">
                @if (canApplySuggestedResolution()) {
                  <button
                    data-testid="conflict-apply-suggested"
                    (click)="applySuggestedResolution()"
                    class="px-3 py-1.5 bg-violet-500 text-white text-xs font-medium rounded-lg hover:bg-violet-600 transition-colors flex items-center gap-1.5">
                    <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/>
                    </svg>
                    {{ suggestedResolutionLabel() }}
                  </button>
                }
                <button
                  data-testid="conflict-merge"
                  (click)="resolveMerge.emit()"
                  class="px-3 py-1.5 bg-white/70 dark:bg-stone-800/80 text-violet-700 dark:text-violet-300 text-xs font-medium rounded-lg border border-violet-200 dark:border-violet-700 hover:bg-violet-100/60 dark:hover:bg-violet-900/40 transition-colors flex items-center gap-1.5">
                  <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M8 3v3a2 2 0 01-2 2H3m18 0h-3a2 2 0 01-2-2V3m0 18v-3a2 2 0 012-2h3M3 16h3a2 2 0 012 2v3"/>
                  </svg>
                  保留两者
                </button>
              </div>
            </div>
          </div>
        </div>

        <div class="text-xs text-stone-400 dark:text-stone-500 mb-4 p-2 bg-stone-50 dark:bg-stone-800 rounded-lg">
          💡 <span class="font-medium">提示：</span>展开任务可查看具体字段的变更详情。
          选择「本地版本」将覆盖云端数据；选择「云端版本」将丢弃本地未同步的更改；
          「智能合并」会尝试保留双方的修改。
        </div>

        <div class="flex justify-between items-center">
          <button
            data-testid="conflict-cancel"
            (click)="cancel.emit()"
            class="px-3 py-1.5 text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 text-xs transition-colors">
            稍后解决
          </button>
          <div class="flex gap-2">
            <button data-testid="conflict-resolve-remote" (click)="resolveRemote.emit()" class="px-4 py-2 text-stone-600 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-700 rounded-lg transition-colors text-sm font-medium border border-stone-200 dark:border-stone-600">
              使用云端
            </button>
            <button data-testid="conflict-resolve-local" (click)="resolveLocal.emit()" class="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors text-sm font-medium">
              使用本地
            </button>
          </div>
        </div>
    </div>
  `
})
export class ConflictModalComponent {
  private readonly autoResolver = inject(ConflictAutoResolverService);

  /** 冲突数据（本地和远程项目信息） */
  conflictData = input<{
    localProject: Project;
    remoteProject: Project;
    projectId: string;
  } | null>(null);

  @Output() resolveLocal = new EventEmitter<void>();
  @Output() resolveRemote = new EventEmitter<void>();
  @Output() resolveMerge = new EventEmitter<void>();
  @Output() applyPlan = new EventEmitter<ConflictResolutionPlan>();
  @Output() cancel = new EventEmitter<void>();

  /** 是否启用逐任务选择模式 */
  selectiveMode = signal(false);
  /** 用户逐任务选择结果 */
  taskResolutions = signal<TaskResolutionMap>(new Map());

  /** 计算本地任务列表 */
  localTasks = computed<Task[]>(() => {
    const data = this.conflictData();
    return data?.localProject?.tasks || [];
  });

  /** 计算云端任务列表 */
  remoteTasks = computed<Task[]>(() => {
    const data = this.conflictData();
    return data?.remoteProject?.tasks || [];
  });

  autoReport = computed(() => {
    const data = this.conflictData();
    if (!data) {
      return null;
    }

    return this.autoResolver.analyze(
      data.projectId,
      data.localProject?.tasks || [],
      data.remoteProject?.tasks || [],
    );
  });

  recommendations = computed(() => this.autoReport()?.recommendations || []);
  overallSuggestion = computed(() => this.autoReport()?.overallSuggestion || '系统已完成冲突诊断');

  onSelectionChange(selections: TaskResolutionMap): void {
    this.taskResolutions.set(selections);
  }

  canApplySuggestedResolution(): boolean {
    const report = this.autoReport();
    return !!report && report.recommendations.length > 0 && this.getPendingManualSelections() === 0;
  }

  suggestedResolutionLabel(): string {
    const selectedCount = this.taskResolutions().size;
    return selectedCount > 0 ? `应用系统建议与 ${selectedCount} 项选择` : '应用系统建议';
  }

  suggestedResolutionSummary(): string {
    const report = this.autoReport();
    if (!report) {
      return '系统建议不可用';
    }

    const manualPending = this.getPendingManualSelections();
    const selectedCount = this.taskResolutions().size;
    if (manualPending > 0) {
      return `系统已完成 ${report.autoCount + report.suggestCount} 项判断，仍有 ${manualPending} 项需要您确认。`;
    }

    if (selectedCount > 0) {
      return `将优先采用您的 ${selectedCount} 项明确选择，其余 ${Math.max(report.recommendations.length - selectedCount, 0)} 项按系统建议处理。`;
    }

    return '系统已完成逐任务判断，应用后会按任务分别保留本地或云端版本。';
  }

  applySuggestedResolution(): void {
    this.applyPlan.emit(this.buildResolutionPlan());
  }

  private getPendingManualSelections(): number {
    const report = this.autoReport();
    if (!report) {
      return 0;
    }

    return report.recommendations.filter(rec => rec.confidence === 'manual' && !this.taskResolutions().has(rec.taskId)).length;
  }

  private buildResolutionPlan(): ConflictResolutionPlan {
    const taskChoices: Record<string, TaskResolutionChoice> = {};
    const selections = this.taskResolutions();

    for (const recommendation of this.autoReport()?.recommendations || []) {
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
}
