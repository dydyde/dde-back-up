/**
 * DockCompletionFlowService
 * 从 DockEngineService 中提取的完成/推荐流逻辑。
 * 负责：任务完成后推荐、候选排序、待决策管理、碎片阶段进入、
 * 主控台排序、主任务一致性修复等纯调度流逻辑。
 */
import { Injectable, Signal, WritableSignal, inject, DestroyRef } from '@angular/core';
import { PARKING_CONFIG } from '../config/parking.config';
import {
  CognitiveLoad,
  DockEntry,
  DockPendingDecision,
  DockRuleDecision,
  DockSchedulerPhase,
  DockTaskStatus,
  FocusTaskSlot,
  FragmentDefenseLevel,
  RecommendationGroupType,
} from '../models/parking-dock';
import {
  type DockWaitFitMode,
  computeThreeDimensionalRecommendation,
  createRuleDecision,
  effectiveExecMin,
  evaluateTimeRemaining,
  rankDockCandidates,
} from './dock-scheduler.rules';
import {
  clearSuspendRecommendationFlags,
  clearSystemSelectionFlags,
  deriveBackgroundStatus as deriveBackgroundStatusPure,
  enforceSingleMainInvariant as enforceSingleMainInvariantPure,
  pendingCandidateIds as pendingCandidateIdsPure,
  sortConsoleEntriesForDisplay as sortConsoleForDisplayPure,
} from './dock-completion.utils';
import { DockFragmentRestService } from './dock-fragment-rest.service';
import { DockPromotionService } from './dock-promotion.service';
import { DockZoneService } from './dock-zone.service';
import { LoggerService } from './logger.service';
import {
  entryOrder,
  getWaitRemainingSeconds,
  isAutoPromotableStatus,
  toFocusTaskSlot,
  toSchedulerCandidate,
} from './dock-engine.utils';
import { TimerHandle } from '../utils/timer-handle';

// ---------------------------------------------------------------------------
//  Context interface — engine 在 constructor 中调用 init() 注入信号引用
// ---------------------------------------------------------------------------

export interface DockCompletionContext {
  entries: WritableSignal<DockEntry[]>;
  pendingDecision: WritableSignal<DockPendingDecision | null>;
  highlightedIds: WritableSignal<Set<string>>;
  lastRuleDecision: WritableSignal<DockRuleDecision | null>;
  lastRecommendationGroups: WritableSignal<import('../models/parking-dock').RecommendationGroup[]>;
  schedulerPhase: WritableSignal<DockSchedulerPhase>;
  fragmentDefenseLevel: WritableSignal<FragmentDefenseLevel>;
  lastConsoleDemotedTaskId: WritableSignal<string | null>;
  consoleVisibleOrderHint: Signal<string[]>;
  consoleVisibleEntries: Signal<DockEntry[]>;
  focusingEntry: Signal<DockEntry | null>;
  focusMode: Signal<boolean>;
  suspendChainRootTaskId: Signal<string | null>;
  highlightClearTimer: TimerHandle;
}

@Injectable({
  providedIn: 'root',
})
export class DockCompletionFlowService {
  private readonly zoneService = inject(DockZoneService);
  private readonly fragmentRest = inject(DockFragmentRestService);
  private readonly promotionService = inject(DockPromotionService);
  private readonly logger = inject(LoggerService);
  private readonly destroyRef = inject(DestroyRef);

  /** 推荐候选人数上限 */
  private static readonly RECOMMENDATION_CANDIDATE_LIMIT = 3;
  /** 自动推进最小间隔（防止过快触发） */
  private static readonly MIN_AUTO_PROMOTE_MS = 1_000;

  private _ctx: DockCompletionContext | null = null;

  /**
   * 获取上下文——必须在 DockEngineService 构造期间调用 init() 注入。
   * 如未初始化则抛出明确错误，便于定位 DI 顺序问题。
   */
  private get ctx(): DockCompletionContext {
    if (!this._ctx) {
      throw new Error(
        'DockCompletionFlowService.init() must be called before use. ' +
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
  init(ctx: DockCompletionContext): void {
    if (this._ctx) {
      this.logger.category('DockCompletionFlow').warn('init() called again — overwriting previous context');
    }
    this._ctx = ctx;
    this.promotionService.init({
      entries: ctx.entries,
      pendingDecision: ctx.pendingDecision,
      highlightedIds: ctx.highlightedIds,
      schedulerPhase: ctx.schedulerPhase,
      lastRuleDecision: ctx.lastRuleDecision,
      lastConsoleDemotedTaskId: ctx.lastConsoleDemotedTaskId,
      focusingEntry: ctx.focusingEntry,
      focusMode: ctx.focusMode,
      highlightClearTimer: ctx.highlightClearTimer,
    });
  }

  // ---------------------------------------------------------------------------
  //  Private helpers — 减少 createRuleDecision + signal.set 的重复仪式
  // ---------------------------------------------------------------------------

  /**
   * 封装 lastRuleDecision 的更新：创建决策记录并写入信号。
   * 所有需要更新 lastRuleDecision 的调用点应使用此方法，
   * 以确保 createRuleDecision 参数格式一致且不遗漏。
   */
  private setLastDecision(params: {
    type: Parameters<typeof createRuleDecision>[0]['type'];
    reason: string;
    rootTaskId?: string;
    recommendedTaskIds?: string[];
    remainingMinutes?: number;
    ratio?: number | null;
  }): void {
    this.ctx.lastRuleDecision.set(createRuleDecision(params));
  }

  // ---------------------------------------------------------------------------
  //  Conversion helpers (M-1: 委托至 dock-engine.utils.toSchedulerCandidate)
  // ---------------------------------------------------------------------------

  toSchedulerCandidate(entry: DockEntry) {
    return toSchedulerCandidate(entry, this.zoneService.resolveSourceProjectId(entry));
  }

  toFocusTaskSlot(entry: DockEntry, zone: 'command' | 'combo-select' | 'backup' = 'command', idx = 0): FocusTaskSlot {
    return toFocusTaskSlot(entry, zone, idx);
  }

  getWaitRemainingSeconds(entry: DockEntry): number | null {
    return getWaitRemainingSeconds(entry);
  }

  deriveBackgroundStatus(
    entry: DockEntry,
    nextTarget: DockEntry | null = null,
    currentFocus: DockEntry | null = null,
  ): DockTaskStatus {
    return deriveBackgroundStatusPure(entry, nextTarget, currentFocus);
  }

  // ---------------------------------------------------------------------------
  //  Core completion/recommendation flow
  // ---------------------------------------------------------------------------

  resolveAfterCompletion(completedTaskId: string): void {
    const rootTaskId = this.ctx.suspendChainRootTaskId();
    const rootEntry = rootTaskId ? this.ctx.entries().find(entry => entry.taskId === rootTaskId) ?? null : null;
    const rootRemainingSeconds = rootEntry ? this.getWaitRemainingSeconds(rootEntry) : null;

    // 主路径：主任务仍在等待中，尝试推荐候选或碎片倒计时
    if (rootEntry && rootRemainingSeconds !== null && rootRemainingSeconds > 0) {
      if (this.resolveWithActiveRoot(completedTaskId, rootTaskId, rootEntry, rootRemainingSeconds)) {
        return;
      }
    }

    // 恢复路径：有 wait_finished 的主任务，高亮等待用户恢复
    if (this.resolveWithRecoveredMain(rootRemainingSeconds)) {
      return;
    }

    // 兜底路径：无主任务等待，自动推进下一候选
    this.resolveFallbackPromotion(rootTaskId, rootRemainingSeconds);
  }

  // ---------------------------------------------------------------------------
  //  resolveAfterCompletion 子流程
  // ---------------------------------------------------------------------------

  /** 主任务仍在等待时，按时间分支推荐候选。返回 true 表示已处理。 */
  private resolveWithActiveRoot(
    completedTaskId: string,
    rootTaskId: string | null,
    rootEntry: DockEntry,
    rootRemainingSeconds: number,
  ): boolean {
    const rootRemainingMinutes = rootRemainingSeconds / 60;
    const excluded = [completedTaskId, rootTaskId].filter((id): id is string => id !== null);
    const recommendation = this.buildTwoStageRecommendationCandidateGroups(
      rootEntry, excluded, rootRemainingMinutes,
    );
    const waitFitMode: DockWaitFitMode = recommendation.mode === 'strict' ? 'strict' : 'relaxed';
    const primaryCandidate = this.pickPrimaryCandidate(
      excluded, rootRemainingMinutes, rootEntry, waitFitMode,
    );
    const branch = evaluateTimeRemaining(
      rootRemainingMinutes,
      primaryCandidate ? effectiveExecMin(this.toFocusTaskSlot(primaryCandidate)) : null,
    );
    const hasCandidates =
      recommendation.groups.some(g => g.taskIds.length > 0) || primaryCandidate !== null;

    if (!hasCandidates) {
      this.fragmentRest.startFragmentEntryCountdown({
        reason: '主任务仍在等待且暂无合适候选，进入碎片时间倒计时',
        rootTaskId: rootTaskId ?? undefined,
        remainingMinutes: rootRemainingMinutes,
      });
      return true;
    }

    if (branch === 'tight-blank') {
      this.handleTightBlankBranch(rootTaskId, rootEntry, rootRemainingMinutes);
      return true;
    }

    if (branch === 'mismatch-recompute' && recommendation.groups.length > 0) {
      this.handleMismatchRecompute(rootTaskId, rootEntry, rootRemainingMinutes, recommendation);
      return true;
    }

    if (primaryCandidate) {
      this.handlePrimaryCandidate(rootTaskId, rootEntry, rootRemainingMinutes, primaryCandidate, branch, recommendation);
      return true;
    }

    return false;
  }

  /** tight-blank 分支：留白窗口紧张，5s 后进入留白期 */
  private handleTightBlankBranch(
    rootTaskId: string | null,
    rootEntry: DockEntry,
    rootRemainingMinutes: number,
  ): void {
    const chainRootTaskId = rootTaskId ?? rootEntry.taskId;
    this.setPendingDecision(
      chainRootTaskId, rootRemainingMinutes, [],
      'tight-blank: 留白窗口紧张，5s 后进入留白期', 5000,
    );
    this.setLastDecision({
      type: 'pending_decision',
      reason: 'tight-blank: 留白窗口紧张，等待用户取消或确认',
      rootTaskId: rootTaskId ?? undefined,
      recommendedTaskIds: [],
      remainingMinutes: rootRemainingMinutes,
    });
  }

  /** mismatch-recompute 分支：时间偏差过大，展示重算候选并启动碎片过渡倒计时 */
  private handleMismatchRecompute(
    rootTaskId: string | null,
    rootEntry: DockEntry,
    rootRemainingMinutes: number,
    recommendation: { mode: string; groups: { type: RecommendationGroupType; taskIds: string[] }[] },
  ): void {
    const chainRootTaskId = rootTaskId ?? rootEntry.taskId;
    const candidateGroups = recommendation.groups;
    const reason =
      recommendation.mode === 'strict'
        ? 'mismatch-recompute: 时间偏差过大，触发三组重算'
        : recommendation.mode === 'relaxed'
          ? 'mismatch-recompute: 放宽时窗后触发候选重算'
          : 'mismatch-recompute: 规则引擎回退候选重算';
    this.setPendingDecision(chainRootTaskId, rootRemainingMinutes, candidateGroups, reason);
    this.ctx.highlightedIds.set(new Set(candidateGroups.flatMap(group => group.taskIds)));
    this.setLastDecision({
      type: 'pending_decision',
      reason:
        recommendation.mode === 'strict'
          ? 'mismatch-recompute: 三组候选已重算，等待用户手动决策'
          : recommendation.mode === 'relaxed'
            ? 'mismatch-recompute: 已放宽时窗并重算候选，等待用户手动决策'
            : 'mismatch-recompute: 回退候选已生成，等待用户手动决策',
      rootTaskId: rootTaskId ?? undefined,
      recommendedTaskIds: candidateGroups.flatMap(group => group.taskIds),
      remainingMinutes: rootRemainingMinutes,
    });
    this.startFragmentTransitionCountdown(rootTaskId, rootRemainingMinutes);
  }

  /** 单一最优候选分支：高亮候选并启动碎片过渡倒计时 */
  private handlePrimaryCandidate(
    rootTaskId: string | null,
    rootEntry: DockEntry,
    rootRemainingMinutes: number,
    primaryCandidate: DockEntry,
    branch: string,
    recommendation: { mode: string; groups: { type: RecommendationGroupType; taskIds: string[] }[] },
  ): void {
    this.setPendingDecision(
      rootTaskId ?? rootEntry.taskId,
      rootRemainingMinutes,
      [{ type: 'homologous-advancement' as RecommendationGroupType, taskIds: [primaryCandidate.taskId] }],
      branch === 'time-match'
        ? 'time-match: 候选时长匹配，等待用户决定是否切换'
        : recommendation.mode === 'strict'
          ? '候选不足，保留最优下一步供用户手动选择'
          : '候选不足，已放宽时窗后保留最优下一步供用户手动选择',
    );
    this.ctx.highlightedIds.set(new Set([primaryCandidate.taskId]));
    this.setLastDecision({
      type: 'completion_followup',
      reason:
        branch === 'time-match'
          ? 'time-match: 候选时长匹配，保持高亮等待用户切换'
          : recommendation.mode === 'strict'
            ? '候选不足，保留最优下一步'
            : '候选不足，已放宽时窗后保留最优下一步',
      rootTaskId: rootTaskId ?? undefined,
      recommendedTaskIds: [primaryCandidate.taskId],
      remainingMinutes: rootRemainingMinutes,
    });
    this.startFragmentTransitionCountdown(rootTaskId, rootRemainingMinutes);
  }

  /** 恢复路径：高亮 wait_finished 的主任务。返回 true 表示已处理。 */
  private resolveWithRecoveredMain(rootRemainingSeconds: number | null): boolean {
    const recoveredMain = this.ctx.entries()
      .filter(entry => entry.isMain && entry.status === 'wait_finished')
      .sort((a, b) => entryOrder(a) - entryOrder(b))[0];
    if (!recoveredMain) return false;

    this.ctx.pendingDecision.set(null);
    this.ctx.highlightedIds.set(new Set([recoveredMain.taskId]));
    this.setLastDecision({
      type: 'completion_followup',
      reason: '主任务等待结束，置顶高亮等待用户恢复',
      rootTaskId: recoveredMain.taskId,
      recommendedTaskIds: [recoveredMain.taskId],
      remainingMinutes: rootRemainingSeconds !== null ? rootRemainingSeconds / 60 : undefined,
    });
    return true;
  }

  /** 兜底路径：清除待决策，自动推进下一候选 */
  private resolveFallbackPromotion(rootTaskId: string | null, rootRemainingSeconds: number | null): void {
    this.ctx.pendingDecision.set(null);
    const commandCenterSuccessor = this.findCommandCenterSuccessor();
    if (commandCenterSuccessor) {
      this.promoteCandidate(commandCenterSuccessor.taskId);
      this.setLastDecision({
        type: 'completion_followup',
        reason: '主任务完成后恢复主控台后续任务',
        rootTaskId: rootTaskId ?? undefined,
        recommendedTaskIds: [commandCenterSuccessor.taskId],
        remainingMinutes: rootRemainingSeconds !== null ? rootRemainingSeconds / 60 : undefined,
      });
      return;
    }

    const floatingCandidates = this.findFloatingBackupCandidates(rootTaskId);
    if (floatingCandidates.length > 0) {
      const recommendedTaskIds = floatingCandidates.map(entry => entry.taskId);
      this.setPendingDecision(
        rootTaskId ?? recommendedTaskIds[0],
        rootRemainingSeconds !== null ? rootRemainingSeconds / 60 : 0,
        [{ type: 'homologous-advancement', taskIds: recommendedTaskIds }],
        'C 位任务已完成，悬浮备选任务等待用户选择主任务',
      );
      this.ctx.highlightedIds.set(new Set(recommendedTaskIds));
      this.setLastDecision({
        type: 'completion_followup',
        reason: 'C 位已清空，悬浮三个备选任务等待用户选择其一为主任务',
        rootTaskId: rootTaskId ?? undefined,
        recommendedTaskIds,
        remainingMinutes: rootRemainingSeconds !== null ? rootRemainingSeconds / 60 : undefined,
      });
      return;
    }

    this.setLastDecision({
      type: 'completion_followup',
      reason: '停泊坞任务已全部完成，专注模式可切换到大门',
      rootTaskId: rootTaskId ?? undefined,
      recommendedTaskIds: [],
      remainingMinutes: rootRemainingSeconds !== null ? rootRemainingSeconds / 60 : undefined,
    });
  }

  /** 主任务完成时只允许已经进入 C 位的副任务接班；未点选的备选任务继续留在备选区。 */
  private findCommandCenterSuccessor(): DockEntry | null {
    const focusedSuccessor = this.ctx.focusingEntry();
    if (focusedSuccessor && focusedSuccessor.status !== 'completed' && !focusedSuccessor.isMain) {
      return focusedSuccessor;
    }

    const stalledSuccessor = this.ctx.entries()
      .filter(entry => entry.status === 'stalled')
      .sort((a, b) => entryOrder(a) - entryOrder(b))[0];
    if (stalledSuccessor) return stalledSuccessor;

    const commandCenterCandidates = this.ctx.consoleVisibleEntries().filter(entry =>
      entry.status !== 'completed'
      && !entry.isMain
      && (entry.lane === 'combo-select' || entry.status === 'focusing'),
    );
    return this.sortConsoleEntriesForDisplay(commandCenterCandidates)[0] ?? null;
  }

  /** C 位全空后，最多悬浮三个备选任务，让用户显式选择下一任主任务。 */
  private findFloatingBackupCandidates(rootTaskId: string | null): DockEntry[] {
    const excluded = new Set([rootTaskId].filter((id): id is string => typeof id === 'string' && id.length > 0));
    return this.ctx.entries()
      .filter(entry =>
        entry.status !== 'completed'
        && !entry.isMain
        && entry.lane === 'backup'
        && isAutoPromotableStatus(entry.status)
        && !excluded.has(entry.taskId),
      )
      .sort((a, b) => entryOrder(a) - entryOrder(b))
      .slice(0, DockCompletionFlowService.RECOMMENDATION_CANDIDATE_LIMIT);
  }

  /** GAP-A: 碎片过渡倒计时，不以绝对任务饱和为目标，保留推荐同时给用户休息选择 */
  private startFragmentTransitionCountdown(rootTaskId: string | null, rootRemainingMinutes: number): void {
    this.fragmentRest.startFragmentEntryCountdown({
      reason: '组合任务完成，碎片过渡期，可选择休息或切换任务',
      rootTaskId: rootTaskId ?? undefined,
      remainingMinutes: rootRemainingMinutes,
      preservePendingDecision: true,
      countdownSeconds: PARKING_CONFIG.FRAGMENT_TRANSITION_COUNTDOWN_S,
    });
  }

  pickPrimaryCandidate(
    excludedIds: string[],
    remainingMinutes: number,
    rootEntry: DockEntry | null,
    waitFitMode: DockWaitFitMode = 'strict',
  ): DockEntry | null {
    const excluded = new Set(excludedIds.filter(Boolean));
    const mainIdle = this.ctx.entries()
      .filter(entry => entry.isMain && isAutoPromotableStatus(entry.status) && !excluded.has(entry.taskId))
      .sort((a, b) => entryOrder(a) - entryOrder(b));
    if (mainIdle.length > 0) return mainIdle[0];

    const stalled = this.ctx.entries()
      .filter(entry => entry.status === 'stalled' && !excluded.has(entry.taskId))
      .sort((a, b) => entryOrder(a) - entryOrder(b));
    if (stalled.length > 0) return stalled[0];

    return this.pickBestCandidate(
      remainingMinutes,
      excludedIds,
      {
        rootLoad: rootEntry?.load ?? null,
        rootProjectId: rootEntry ? this.zoneService.resolveSourceProjectId(rootEntry) : null,
      },
      waitFitMode,
    );
  }

  pickBestCandidate(
    remainingMinutes: number,
    excludedIds: string[],
    context: { rootLoad?: CognitiveLoad | null; rootProjectId?: string | null } = {},
    waitFitMode: DockWaitFitMode = 'strict',
  ): DockEntry | null {
    const excluded = new Set(excludedIds.filter(Boolean));
    const candidates = this.ctx.entries().filter(
      entry => isAutoPromotableStatus(entry.status) && !excluded.has(entry.taskId),
    );
    if (candidates.length === 0) return null;

    const ranked = rankDockCandidates(
      candidates.map(entry => this.toSchedulerCandidate(entry)),
      remainingMinutes,
      {
        ...context,
        waitFitMode,
      },
    );
    return ranked.length > 0
      ? candidates.find(entry => entry.taskId === ranked[0].taskId) ?? null
      : null;
  }

  scoreCandidate(entry: DockEntry, waitMinutes: number): number {
    const ranked = rankDockCandidates([this.toSchedulerCandidate(entry)], waitMinutes);
    return ranked[0]?.score ?? 0;
  }

  buildRecommendationCandidateGroups(
    rootEntry: DockEntry,
    excludedTaskIds: string[],
    remainingMinutes: number,
    waitFitMode: DockWaitFitMode = 'strict',
  ): Array<{ type: RecommendationGroupType; taskIds: string[] }> {
    const excluded = new Set(excludedTaskIds.filter(Boolean));
    const mainSlot = this.toFocusTaskSlot(rootEntry, 'command', 0);
    const pendingEntries = this.ctx.entries().filter(
      entry => isAutoPromotableStatus(entry.status) && !excluded.has(entry.taskId),
    );
    const pendingSlots = pendingEntries.map((entry, idx) =>
      this.toFocusTaskSlot(entry, entry.lane, idx),
    );
    const groups = computeThreeDimensionalRecommendation(mainSlot, pendingSlots, remainingMinutes, waitFitMode);
    this.ctx.lastRecommendationGroups.set(groups);

    return groups
      .map(group => ({
        type: group.type,
        taskIds: group.candidates
          .map(candidate => candidate.taskId)
          .filter((taskId): taskId is string => typeof taskId === 'string' && taskId.length > 0),
      }))
      .filter(group => group.taskIds.length > 0);
  }

  buildTwoStageRecommendationCandidateGroups(
    rootEntry: DockEntry,
    excludedTaskIds: string[],
    remainingMinutes: number,
  ): {
    groups: Array<{ type: RecommendationGroupType; taskIds: string[] }>;
    mode: DockWaitFitMode | 'ranked-fallback' | 'none';
  } {
    const strictGroups = this.buildRecommendationCandidateGroups(
      rootEntry,
      excludedTaskIds,
      remainingMinutes,
      'strict',
    );
    if (strictGroups.length > 0) {
      return { groups: strictGroups, mode: 'strict' };
    }

    const relaxedGroups = this.buildRecommendationCandidateGroups(
      rootEntry,
      excludedTaskIds,
      remainingMinutes,
      'relaxed',
    );
    if (relaxedGroups.length > 0) {
      return { groups: relaxedGroups, mode: 'relaxed' };
    }

    // 策划案：等待时间完全不匹配时忽略 wait 属性进行三维推荐组合挑选
    const ignoreWaitGroups = this.buildRecommendationCandidateGroups(
      rootEntry,
      excludedTaskIds,
      remainingMinutes,
      'ignore-wait',
    );
    if (ignoreWaitGroups.length > 0) {
      return { groups: ignoreWaitGroups, mode: 'ignore-wait' };
    }

    const fallbackGroups = this.buildRankedFallbackGroups(rootEntry, excludedTaskIds, remainingMinutes);
    if (fallbackGroups.length > 0) {
      return { groups: fallbackGroups, mode: 'ranked-fallback' };
    }

    return { groups: [], mode: 'none' };
  }

  buildRankedFallbackGroups(
    rootEntry: DockEntry,
    excludedTaskIds: string[],
    remainingMinutes: number,
  ): Array<{ type: RecommendationGroupType; taskIds: string[] }> {
    const ranked = this.rankRecommendedCandidates(
      rootEntry,
      excludedTaskIds,
      remainingMinutes,
      // GAP-3: 完全忽略等待时间匹配，仅按其他属性排序
      'ignore-wait',
    );
    const candidateIds = ranked.slice(0, DockCompletionFlowService.RECOMMENDATION_CANDIDATE_LIMIT).map(item => item.taskId);
    if (candidateIds.length === 0) return [];
    return [{ type: 'homologous-advancement', taskIds: candidateIds }];
  }

  rankRecommendedCandidates(
    rootEntry: DockEntry,
    excludedTaskIds: string[],
    remainingMinutes: number,
    waitFitMode: DockWaitFitMode = 'strict',
  ) {
    const excluded = new Set(excludedTaskIds.filter(Boolean));
    const candidateEntries = this.ctx.entries().filter(
      entry => isAutoPromotableStatus(entry.status) && !excluded.has(entry.taskId),
    );
    return rankDockCandidates(
      candidateEntries.map(entry => this.toSchedulerCandidate(entry)),
      remainingMinutes,
      {
        rootLoad: rootEntry.load,
        rootProjectId: this.zoneService.resolveSourceProjectId(rootEntry),
        waitFitMode,
      },
    );
  }

  promoteNext(): void {
    this.promotionService.promoteNext();
  }

  promoteCandidate(taskId: string, clearDecision: boolean = true): void {
    this.promotionService.promoteCandidate(taskId, clearDecision);
  }

  promoteFocusedTaskToMaster(): void {
    this.promotionService.promoteFocusedTaskToMaster();
  }

  scheduleFirstSuspendRecommendation(suspendedTaskId: string, waitMinutes: number): void {
    const suspendedEntry = this.ctx.entries().find(entry => entry.taskId === suspendedTaskId) ?? null;
    if (!suspendedEntry) {
      this.promoteNext();
      return;
    }

    const recommendation = this.buildTwoStageRecommendationCandidateGroups(
      suspendedEntry,
      [suspendedTaskId],
      waitMinutes,
    );
    const rankedFallback = this.rankRecommendedCandidates(
      suspendedEntry,
      [suspendedTaskId],
      waitMinutes,
      'relaxed',
    );
    const recommendationIds = recommendation.groups.flatMap(group => group.taskIds);
    if (recommendationIds.length === 0) {
      this.ctx.pendingDecision.set(null);
      this.ctx.highlightedIds.set(new Set());
      return;
    }

    const scoreByTaskId = new Map(rankedFallback.map(item => [item.taskId, item.score]));
    this.applyRecommendationEntries(suspendedTaskId, recommendationIds, scoreByTaskId);
    this.recordSuspendRecommendation(
      suspendedTaskId, waitMinutes, recommendation, recommendationIds,
    );
  }

  /** 推荐 entries 更新：标记挂起任务、候选任务、非候选任务 */
  private applyRecommendationEntries(
    suspendedTaskId: string,
    recommendationIds: string[],
    scoreByTaskId: Map<string, number>,
  ): void {
    this.ctx.entries.update(prev =>
      prev.map(entry => {
        if (entry.taskId === suspendedTaskId) {
          return {
            ...entry,
            status: 'suspended_waiting',
            systemSelected: false,
            recommendationLocked: false,
            recommendedScore: null,
          };
        }
        if (recommendationIds.includes(entry.taskId)) {
          return {
            ...entry,
            status: 'pending_start',
            systemSelected: true,
            recommendationLocked: true,
            recommendedScore: scoreByTaskId.get(entry.taskId) ?? null,
          };
        }
        return {
          ...entry,
          systemSelected: false,
          recommendationLocked: false,
          recommendedScore: scoreByTaskId.get(entry.taskId) ?? null,
        };
      }),
    );
  }

  /** 记录首次挂起推荐的 pendingDecision 和 ruleDecision */
  private recordSuspendRecommendation(
    suspendedTaskId: string,
    waitMinutes: number,
    recommendation: { mode: string; groups: Array<{ type: RecommendationGroupType; taskIds: string[] }> },
    recommendationIds: string[],
  ): void {
    const pendingGroups = recommendation.groups.map(group => ({ type: group.type, taskIds: group.taskIds }));
    this.setPendingDecision(
      suspendedTaskId,
      waitMinutes,
      pendingGroups,
      recommendation.mode === 'strict'
        ? '首次挂起触发三维推荐阵列'
        : recommendation.mode === 'relaxed'
          ? '首次挂起触发放宽时窗推荐，等待用户手动决策'
          : '首次挂起触发回退推荐，等待用户手动决策',
    );
    this.ctx.highlightedIds.set(new Set(recommendationIds));
    this.setLastDecision({
      type: 'first_suspend_recommendation',
      reason: recommendation.mode === 'strict'
        ? '首次挂起触发三维推荐阵列'
        : recommendation.mode === 'relaxed'
          ? '首次挂起触发放宽时窗推荐'
          : '首次挂起触发规则引擎回退推荐',
      rootTaskId: suspendedTaskId,
      recommendedTaskIds: recommendationIds,
      remainingMinutes: waitMinutes,
    });
  }

  setPendingDecision(
    rootTaskId: string,
    rootRemainingMinutes: number,
    candidateGroups: Array<{ type: RecommendationGroupType; taskIds: string[] }>,
    reason: string,
    autoPromoteAfterMs?: number,
  ): void {
    const nowDate = new Date();
    const now = nowDate.toISOString();
    const expiresAtMs =
      typeof autoPromoteAfterMs === 'number'
        ? Math.max(DockCompletionFlowService.MIN_AUTO_PROMOTE_MS, autoPromoteAfterMs)
        : null;
    const candidateIds = candidateGroups.flatMap(group => group.taskIds);
    this.ctx.pendingDecision.set({
      rootTaskId,
      rootRemainingMinutes,
      candidateGroups,
      reason,
      expiresAt: expiresAtMs === null ? undefined : new Date(nowDate.getTime() + expiresAtMs).toISOString(),
      autoPromoteAfterMs: expiresAtMs ?? undefined,
      createdAt: now,
    });

    this.ctx.entries.update(prev =>
      prev.map(entry => {
        if (candidateIds.includes(entry.taskId)) {
          return {
            ...entry,
            // 策划案 §2.8 G-38c：isMain 仅标记唯一主任务，推荐候选不应设 isMain
            systemSelected: true,
            recommendationLocked: true,
            recommendedScore: this.scoreCandidate(entry, rootRemainingMinutes),
          };
        }
        return {
          ...entry,
          systemSelected: false,
          recommendationLocked: false,
        };
      }),
    );

    this.ctx.highlightedIds.set(new Set(candidateIds));
    this.setLastDecision({
      type: 'pending_decision',
      reason,
      rootTaskId,
      recommendedTaskIds: candidateIds,
      remainingMinutes: rootRemainingMinutes,
    });
  }

  enterFragmentPhase(reason: string, rootTaskId?: string, remainingMinutes?: number): void {
    this.fragmentRest.setFragmentDismissed(false);
    this.ctx.schedulerPhase.set('paused');
    if (this.ctx.fragmentDefenseLevel() < 2) {
      this.ctx.fragmentDefenseLevel.set(2);
    }
    // M-19 fix: fragmentDefenseLevel 始终 >= 2（上方已保证），直接触发
    this.fragmentRest.getFragmentEventRecommendation();
    this.setLastDecision({
      type: 'fragment_phase',
      reason,
      rootTaskId,
      recommendedTaskIds: [],
      remainingMinutes,
    });
  }

  clearSystemSelectionOnEntries(entries: DockEntry[]): DockEntry[] {
    return clearSystemSelectionFlags(entries);
  }

  clearSuspendRecommendationStateOnEntries(entries: DockEntry[]): DockEntry[] {
    return clearSuspendRecommendationFlags(entries);
  }

  clearPendingDecisionIfMatched(taskId: string): void {
    this.promotionService.clearPendingDecisionIfMatched(taskId);
  }

  enforceSingleMainInvariant(
    entries: DockEntry[],
    preferredTaskId: string | null = null,
  ): DockEntry[] {
    return enforceSingleMainInvariantPure(entries, preferredTaskId);
  }

  pendingCandidateIds(pending: DockPendingDecision): string[] {
    return pendingCandidateIdsPure(pending);
  }

  sortConsoleEntriesForDisplay(entries: DockEntry[]): DockEntry[] {
    return sortConsoleForDisplayPure(
      entries,
      this.ctx.lastConsoleDemotedTaskId(),
      this.ctx.consoleVisibleOrderHint(),
    );
  }

}
