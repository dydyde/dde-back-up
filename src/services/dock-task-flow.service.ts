/**
 * DockTaskFlowService
 * 从 DockEngineService 中提取的任务流程操作逻辑。
 * 负责：专注模式切换、任务完成流程、任务挂起/切换、决策处理、从坞区移除等。
 * 包含完成队列的 FIFO 序列化管理，防止并发完成操作产生竞态。
 */
import { Injectable, WritableSignal, inject } from '@angular/core';
import { PARKING_CONFIG } from '../config/parking.config';
import { 
  DockEntry, 
  DockSchedulerPhase, 
  DockFocusTransitionState,
  DockPendingDecision,
  DockRuleDecision,
  HighLoadCounter
} from '../models/parking-dock';
import { TaskStore } from '../core-bridge';
import { LoggerService } from './logger.service';
import { ProjectStateService } from './project-state.service';
import { TaskOperationAdapterService } from './task-operation-adapter.service';
import { DockCompletionFlowService } from './dock-completion-flow.service';
import { DockPromotionService } from './dock-promotion.service';
import { DockTaskSyncService } from './dock-task-sync.service';
import { DockFragmentRestService } from './dock-fragment-rest.service';
import { DockEngineLifecycleService } from './dock-engine-lifecycle.service';
import { 
  buildConsoleVisibleOrderHint, 
  isAutoPromotableStatus,
  patchEntryByTaskId,
  isWaitingLike
} from './dock-engine.utils';
import { 
  createRuleDecision,
  updateHighLoadCounter,
  checkBurnoutThreshold
} from './dock-scheduler.rules';
import { TimerHandle } from '../utils/timer-handle';

// ---------------------------------------------------------------------------
//  Context interface — engine 在 constructor 中调用 init() 注入信号引用
// ---------------------------------------------------------------------------

export interface DockTaskFlowContext {
  entries: WritableSignal<DockEntry[]>;
  focusMode: WritableSignal<boolean>;
  focusScrimOn: WritableSignal<boolean>;
  schedulerPhase: WritableSignal<DockSchedulerPhase>;
  focusSessionContext: WritableSignal<{ id: string; startedAt: number } | null>;
  lastRuleDecision: WritableSignal<DockRuleDecision | null>;
  lastRecommendationGroups: WritableSignal<import('../models/parking-dock').RecommendationGroup[]>;
  focusTransition: WritableSignal<DockFocusTransitionState | null>;
  pendingDecision: WritableSignal<DockPendingDecision | null>;
  highlightedIds: WritableSignal<Set<string>>;
  suspendRecommendationLocked: WritableSignal<boolean>;
  suspendChainRootTaskId: WritableSignal<string | null>;
  highLoadCounter: WritableSignal<HighLoadCounter>;
  burnoutTriggeredAt: WritableSignal<number | null>;
  lastConsoleDemotedTaskId: WritableSignal<string | null>;
  consoleVisibleOrderHint: WritableSignal<string[]>;
  waitEndNotifiedIds: Set<string>;
  
  // Computed signal readers
  focusingEntry: () => DockEntry | null;
  consoleEntries: () => DockEntry[];
  consoleVisibleEntries: () => DockEntry[];
  
  // Callbacks
  rebalanceAutoZones: () => void;
  clearFirstMainSelectionWindow: () => void;
  startFirstMainSelectionWindow: (taskId: string) => void;
}

@Injectable({
  providedIn: 'root',
})
export class DockTaskFlowService {
  private readonly taskStore = inject(TaskStore);
  private readonly logger = inject(LoggerService).category('DockTaskFlow');
  private readonly projectState = inject(ProjectStateService);
  private readonly taskOps = inject(TaskOperationAdapterService);
  private readonly completionFlow = inject(DockCompletionFlowService);
  private readonly promotionService = inject(DockPromotionService);
  private readonly taskSync = inject(DockTaskSyncService);
  private readonly fragmentRest = inject(DockFragmentRestService);
  private readonly lifecycle = inject(DockEngineLifecycleService);

  private _ctx: DockTaskFlowContext | null = null;

  // 完成队列状态（从 DockEngineService 迁移）
  private static readonly MAX_COMPLETION_QUEUE_DEPTH = 50;
  private completionQueue: string[] = [];
  private isProcessingCompletion = false;
  private readonly completionDrain = new TimerHandle();

  /**
   * 获取上下文——必须在 DockEngineService 构造期间调用 init() 注入。
   * 如未初始化则抛出明确错误，便于定位 DI 顺序问题。
   */
  private get ctx(): DockTaskFlowContext {
    if (!this._ctx) {
      throw new Error(
        'DockTaskFlowService.init() must be called before use. ' +
        'Ensure DockEngineService is constructed before accessing this service.',
      );
    }
    return this._ctx;
  }

  /**
   * 由 DockEngineService 在其构造函数中调用，注入共享信号引用。
   * 此服务使用手动上下文注入而非 Angular DI，因为所需信号是 DockEngineService 的私有成员，
   * 无法通过常规注入获取。这是有意的架构权衡：以运行时初始化检查换取信号封装性。
   */
  init(ctx: DockTaskFlowContext): void {
    if (this._ctx) {
      this.logger.warn('init() called again — overwriting previous context');
    }
    this._ctx = ctx;
  }

  /**
   * 清理资源——在 DockEngineService 析构时调用
   */
  destroy(): void {
    this.completionDrain.cancel();
    this.completionQueue.length = 0;
    this.isProcessingCompletion = false;
  }

  // ---------------------------------------------------------------------------
  //  Focus Mode Management
  // ---------------------------------------------------------------------------

  toggleFocusMode(): void {
    const next = !this.ctx.focusMode();
    this.ctx.focusMode.set(next);
    if (next) {
      this.enterFocusMode();
    } else {
      this.exitFocusMode();
    }
  }

  /** 进入专注模式：初始化会话、自动推入候选、启动首选窗口 */
  private enterFocusMode(): void {
    this.ctx.focusScrimOn.set(true);
    this.ctx.focusSessionContext.set({
      id: crypto.randomUUID(),
      startedAt: Date.now(),
    });
    this.ctx.schedulerPhase.set('active');
    const focused = this.ctx.focusingEntry();
    if (!focused) {
      const candidate = this.ctx.consoleEntries().find(entry => isAutoPromotableStatus(entry.status));
      if (candidate) {
        this.promotionService.promoteCandidate(candidate.taskId);
        this.ctx.lastRuleDecision.set(
          createRuleDecision({
            type: 'idle_promote',
            reason: '进入专注模式后自动将首个可运行任务推入主控台',
            recommendedTaskIds: [candidate.taskId],
          }),
        );
      }
    }

    const initialTaskId =
      this.ctx.focusingEntry()?.taskId ??
      this.ctx.entries().find(entry => entry.isMain && entry.status !== 'completed')?.taskId ??
      null;
    if (initialTaskId) {
      this.ctx.startFirstMainSelectionWindow(initialTaskId);
    }
    this.fragmentRest.updateFragmentDefenseLevel();
  }

  /**
   * 退出专注模式：同步批量重置所有专注相关状态信号。
   * 所有重置必须在同一同步帧内完成，避免 focusMode=false 与其他信号
   * 之间出现不一致窗口（effects 在下一个 microtask 才能感知变更）。
   */
  private exitFocusMode(): void {
    this.taskSync.syncCompletedInlineEntries(this.ctx.entries());
    this.ctx.clearFirstMainSelectionWindow();
    this.ctx.suspendRecommendationLocked.set(false);
    this.ctx.suspendChainRootTaskId.set(null);
    this.ctx.pendingDecision.set(null);
    this.ctx.lastRuleDecision.set(null);
    this.ctx.highlightedIds.set(new Set());
    // 过渡中的 exiting 状态需要保留到动画协调器收尾，
    // 否则退出计时器会丢失 phase，导致 flip ghost 无法清理。
    // 仅在非过渡场景下清掉已落稳的 focused 标记，兼容直接退出路径（如 PiP 关闭）。
    if (this.ctx.focusTransition()?.phase === 'focused') {
      this.ctx.focusTransition.set(null);
    }
    this.ctx.lastRecommendationGroups.set([]);
    this.ctx.schedulerPhase.set('active');
    this.fragmentRest.resetRestState();
    this.fragmentRest.stopFragmentEntryCountdown();
    this.fragmentRest.setFragmentDismissed(false);
  }

  // ---------------------------------------------------------------------------
  //  Task Completion Flow
  // ---------------------------------------------------------------------------

  completeTask(taskId: string): void {
    // FIFO 队列序列化（策划案 §18.1）：防止快速连续完成导致竞态
    if (this.completionQueue.length >= DockTaskFlowService.MAX_COMPLETION_QUEUE_DEPTH) {
      this.logger.warn('完成队列已满，丢弃新请求', { taskId, queueSize: this.completionQueue.length });
      return;
    }
    this.completionQueue.push(taskId);
    if (this.isProcessingCompletion) return;
    this.drainCompletionQueue();
  }

  private drainCompletionQueue(): void {
    if (this.completionQueue.length === 0) {
      this.isProcessingCompletion = false;
      return;
    }
    this.isProcessingCompletion = true;
    const taskId = this.completionQueue.shift()!;
    try {
      this.executeCompleteTask(taskId);
    } catch (error) {
      // 防止 executeCompleteTask 异常导致队列永久卡死
      this.logger.error('executeCompleteTask 抛出异常，跳过该任务继续处理队列', { taskId, error });
    }
    // C-3 fix: 始终通过异步调度处理下一个任务——即使队列在 executeCompleteTask
    // 执行期间被同步追加了新条目，也确保当前调用栈先退出，让信号传播完成后
    // 再处理下一个，避免 re-entrancy 导致的状态竞态。
    if (this.completionQueue.length > 0) {
      this.completionDrain.schedule(() => this.drainCompletionQueue(), PARKING_CONFIG.COMPLETION_DRAIN_INTERVAL_MS);
    } else {
      // 延迟重置标志：如果 executeCompleteTask 的 effect 在同一 microtask 内
      // 触发了 completeTask，此时 isProcessingCompletion 仍为 true，新任务会
      // 正确入队而非启动第二个 drain 循环。queueMicrotask 在所有同步 effect
      // 处理完成后才执行，保证最终一致。
      queueMicrotask(() => {
        if (this.completionQueue.length > 0) {
          this.drainCompletionQueue();
        } else {
          this.isProcessingCompletion = false;
        }
      });
    }
  }

  private executeCompleteTask(taskId: string): void {
    const entry = this.ctx.entries().find(item => item.taskId === taskId);
    if (!entry || entry.status === 'completed') return;
    const wasMaster = entry.isMain;

    this.trackBurnoutIfHighLoad(entry);

    this.ctx.entries.update(prev =>
      patchEntryByTaskId(prev, taskId, {
        status: 'completed',
        isMain: false,
        systemSelected: false,
        recommendedScore: null,
      }),
    );

    this.syncTaskCompletion(taskId, entry);
    this.completionFlow.resolveAfterCompletion(taskId);
    if (wasMaster && !this.ctx.pendingDecision()) {
      this.promotionService.promoteFocusedTaskToMaster();
    }
    if (!this.ctx.pendingDecision()) {
      this.ctx.entries.update(prev => this.completionFlow.enforceSingleMainInvariant(prev));
    }
    if (!this.ctx.entries().some(item => item.status !== 'completed')) {
      this.ctx.focusMode.set(false);
      this.exitFocusMode();
    }
    this.ctx.rebalanceAutoZones();
    if (!this.ctx.pendingDecision()) {
      this.lifecycle.refreshSuspendRecommendationLock();
    }
    this.ctx.waitEndNotifiedIds.delete(taskId);
  }

  /** 倦怠检测：高负荷任务完成时更新计数器（§7.8 NG-16b） */
  private trackBurnoutIfHighLoad(entry: DockEntry): void {
    if (entry.load !== 'high') return;
    const now = Date.now();
    const updated = updateHighLoadCounter(this.ctx.highLoadCounter(), now);
    this.ctx.highLoadCounter.set(updated);
    if (checkBurnoutThreshold(updated, now)) {
      this.ctx.burnoutTriggeredAt.set(now);
      this.logger.info('倦怠熔断触发：2h 内完成 ≥ 3 个高负荷任务');
    }
  }

  /** 同步任务完成状态到项目数据层 */
  private syncTaskCompletion(taskId: string, entry: DockEntry): void {
    this.taskSync.syncInlineCompletion(entry);
    const task = this.taskStore.getTask(taskId);
    const projectId = this.taskSync.resolveTaskProjectId(taskId);
    if (task && projectId) {
      if (this.projectState.activeProjectId() === projectId) {
        this.taskOps.updateTaskStatus(taskId, 'completed');
      } else {
        this.taskSync.applyCrossProjectTaskPatch(taskId, projectId, {
          status: 'completed',
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  //  Task Suspend/Switch Operations
  // ---------------------------------------------------------------------------

  suspendTask(taskId: string, waitMinutes: number): void {
    const normalizedWait = Math.max(1, Math.floor(waitMinutes));
    const firstSuspendInChain = !this.ctx.suspendRecommendationLocked();

    this.ctx.entries.update(prev =>
      prev.map(entry => {
        if (entry.taskId !== taskId) return entry;
        const suspended: DockEntry = {
          ...entry,
          status: 'suspended_waiting',
          waitMinutes: normalizedWait,
          waitStartedAt: new Date().toISOString(),
          isMain: entry.isMain,
          systemSelected: false,
        };
        return suspended;
      }),
    );
    this.taskSync.syncTaskPlannerFields(taskId, { wait_minutes: normalizedWait });

    // 多层挂起嵌套检测（策划案 §7.9）：≥3 层同时挂起 → 直接进入碎片阶段
    const suspendNestingDepth = this.ctx.entries().filter(
      e => e.status === 'suspended_waiting' || e.status === 'wait_finished',
    ).length;
    if (suspendNestingDepth >= 3) {
      this.logger.info(`挂起嵌套深度 ${suspendNestingDepth} ≥ 3，自动进入碎片阶段`);
      this.completionFlow.enterFragmentPhase('挂起嵌套 ≥ 3 层，自动进入碎片阶段', taskId, normalizedWait);
      return;
    }

    if (firstSuspendInChain) {
      this.ctx.suspendChainRootTaskId.set(taskId);
      this.ctx.suspendRecommendationLocked.set(true);
      this.completionFlow.scheduleFirstSuspendRecommendation(taskId, normalizedWait);
      return;
    }

    this.promotionService.promoteNext();
  }

  switchToTask(taskId: string): void {
    this.fragmentRest.stopFragmentEntryCountdown();
    this.fragmentRest.setFragmentDismissed(false);
    const target = this.ctx.entries().find(entry => entry.taskId === taskId && entry.status !== 'completed');
    if (!target) return;

    const preVisible = this.ctx.consoleVisibleEntries();
    const currentFocusId = this.ctx.focusingEntry()?.taskId ?? null;
    const currentFocus = currentFocusId
      ? this.ctx.entries().find(entry => entry.taskId === currentFocusId) ?? null
      : null;
    const pending = this.ctx.pendingDecision();
    const shouldClearPending = !!pending && this.completionFlow.pendingCandidateIds(pending).includes(taskId);

    const result = this.applySwitchEntries(taskId, currentFocusId, currentFocus, target, shouldClearPending);
    if (!result.committed) return;

    if (currentFocusId && currentFocusId !== taskId) {
      this.ctx.lastConsoleDemotedTaskId.set(currentFocusId);
    }
    this.ctx.consoleVisibleOrderHint.set(buildConsoleVisibleOrderHint(preVisible, taskId));
    this.lifecycle.scheduleSwitchMaintenance();

    if (result.unlockSuspendChain) {
      this.ctx.suspendRecommendationLocked.set(false);
      this.ctx.suspendChainRootTaskId.set(null);
      this.ctx.pendingDecision.set(null);
      this.ctx.highlightedIds.set(new Set());
      return;
    }

    if (shouldClearPending) {
      this.ctx.pendingDecision.set(null);
      this.ctx.highlightedIds.set(new Set());
    }
  }

  /** 切换任务 entries 更新逻辑（从 switchToTask 提取，降低方法体积） */
  private applySwitchEntries(
    taskId: string,
    currentFocusId: string | null,
    currentFocus: DockEntry | null,
    target: DockEntry,
    shouldClearPending: boolean,
  ): { committed: boolean; unlockSuspendChain: boolean } {
    let unlockSuspendChain = false;
    let committed = false;

    this.ctx.entries.update(prev => {
      let changed = false;
      let next = prev.map(entry => {
        if (entry.taskId === taskId) {
          changed = true;
          const focused: DockEntry = {
            ...entry,
            isMain: entry.isMain,
            status: 'focusing',
            waitMinutes: null,
            waitStartedAt: null,
            systemSelected: false,
            recommendationLocked: false,
            manualMainSelected: entry.manualMainSelected,
          };
          return focused;
        }
        if (currentFocusId && entry.taskId === currentFocusId) {
          const backgroundStatus = this.completionFlow.deriveBackgroundStatus(entry, target, currentFocus);
          if (entry.status === backgroundStatus) return entry;
          changed = true;
          return { ...entry, status: backgroundStatus };
        }
        return entry;
      });

      if (shouldClearPending) {
        const cleared = this.completionFlow.clearSystemSelectionOnEntries(next);
        if (cleared !== next) { next = cleared; changed = true; }
      }

      const hasSuspended = next.some(entry => isWaitingLike(entry.status));
      if (!hasSuspended) {
        unlockSuspendChain = true;
        const unlocked = this.completionFlow.clearSuspendRecommendationStateOnEntries(next);
        if (unlocked !== next) { next = unlocked; changed = true; }
      }

      committed = changed;
      return changed ? next : prev;
    });

    return { committed, unlockSuspendChain: unlockSuspendChain };
  }

  // ---------------------------------------------------------------------------
  //  Pending Decision Management
  // ---------------------------------------------------------------------------

  choosePendingDecisionCandidate(taskId: string): void {
    const pending = this.ctx.pendingDecision();
    if (!pending) return;
    const candidateIds = this.completionFlow.pendingCandidateIds(pending);
    if (!candidateIds.includes(taskId)) return;

    const rejectedIds = candidateIds.filter(id => id !== taskId);
    this.promotionService.promoteCandidate(taskId, false);
    this.ctx.pendingDecision.set(null);
    this.ctx.highlightedIds.set(new Set());

    this.clearCandidateSelectionFlags(taskId, rejectedIds);
    this.ctx.lastRuleDecision.set(
      createRuleDecision({
        type: 'completion_followup',
        reason: '异常时长分叉由用户手动决策',
        rootTaskId: pending.rootTaskId,
        recommendedTaskIds: [taskId],
        remainingMinutes: pending.rootRemainingMinutes,
      }),
    );
  }

  /** 清除候选推荐标记：选中/拒绝/其余条目分别处理 */
  private clearCandidateSelectionFlags(selectedId: string, rejectedIds: string[]): void {
    this.ctx.entries.update(prev =>
      prev.map(entry => {
        if (entry.taskId === selectedId || rejectedIds.includes(entry.taskId)) {
          return {
            ...entry,
            isMain: entry.isMain,
            systemSelected: false,
            recommendationLocked: false,
            ...(entry.taskId === selectedId ? { manualMainSelected: entry.manualMainSelected } : {}),
            recommendedScore: null,
          };
        }
        return {
          ...entry,
          systemSelected: false,
          recommendationLocked: false,
          recommendedScore: entry.systemSelected ? null : entry.recommendedScore,
        };
      }),
    );
  }

  cancelPendingDecisionAutoPromote(): void {
    const pending = this.ctx.pendingDecision();
    if (!pending) return;
    this.ctx.pendingDecision.set(null);
    this.ctx.highlightedIds.set(new Set());
    this.ctx.entries.update(prev => {
      const cleared = this.completionFlow.clearSystemSelectionOnEntries(prev);
      const rootStillActive = cleared.some(
        entry => entry.taskId === pending.rootTaskId && entry.status !== 'completed',
      );
      if (!rootStillActive) {
        return this.completionFlow.enforceSingleMainInvariant(cleared);
      }
      return cleared.map(entry => {
        const nextIsMain = entry.taskId === pending.rootTaskId && entry.status !== 'completed';
        return entry.isMain === nextIsMain ? entry : { ...entry, isMain: nextIsMain };
      });
    });
    this.ctx.lastRuleDecision.set(
      createRuleDecision({
        type: 'completion_followup',
        reason: '用户收起推荐提示，保持当前状态',
        rootTaskId: pending.rootTaskId,
        recommendedTaskIds: [],
        remainingMinutes: pending.rootRemainingMinutes,
      }),
    );
  }

  // ---------------------------------------------------------------------------
  //  Remove from Dock
  // ---------------------------------------------------------------------------

  removeFromDock(taskId: string): void {
    // 从完成队列中移除该任务，防止 removeFromDock 后 drainCompletionQueue 操作已移除的幽灵条目
    const queueIdx = this.completionQueue.indexOf(taskId);
    if (queueIdx !== -1) {
      this.completionQueue.splice(queueIdx, 1);
    }
    const removed = this.ctx.entries().find(entry => entry.taskId === taskId) ?? null;
    this.ctx.entries.update(prev => prev.filter(entry => entry.taskId !== taskId));
    if (removed?.isMain) {
      this.promotionService.promoteFocusedTaskToMaster();
    }
    this.ctx.entries.update(prev => this.completionFlow.enforceSingleMainInvariant(prev));
    this.ctx.rebalanceAutoZones();
    this.ctx.waitEndNotifiedIds.delete(taskId);
    if (this.ctx.entries().length === 0) {
      this.ctx.pendingDecision.set(null);
      this.ctx.highlightedIds.set(new Set());
      // 约束：停泊坞无任务时不允许保持专注模式。
      // 若此时 focusMode=true，会导致向云端发布 focusMode=true + entries=[] 的
      // 快照（mainTaskId=null），widget-summary 将返回 focus.valid=false，
      // 小组件显示「今日大门已清空」—— 与专注灯亮的状态矛盾。
      // 见 docs/focus-console-design.md：停泊坞无任务则灯泡置灰。
      if (this.ctx.focusMode()) {
        this.logger.info('removeFromDock 清空停泊坞，自动退出专注模式以维持快照一致性');
        this.ctx.focusMode.set(false);
        this.exitFocusMode();
      }
    }
    this.lifecycle.refreshSuspendRecommendationLock();
  }
}
