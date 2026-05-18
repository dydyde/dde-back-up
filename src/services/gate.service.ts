/**
 * 大门服务
 *
 * 负责大门机制的状态管理和交互逻辑
 * 每日首次打开应用时，强制处理昨日遗留条目
 */

import { Injectable, inject, signal, NgZone, effect, DestroyRef } from '@angular/core';
import { BlackBoxEntry } from '../models/focus';
import { Result, success, failure, ErrorCodes, ErrorMessages } from '../utils/result';
import { FOCUS_CONFIG } from '../config/focus.config';
import { SYNC_CONFIG } from '../config/sync.config';
import { BlackBoxService } from './black-box.service';
import { LoggerService } from './logger.service';
import {
  gateState,
  gatePendingItems,
  gateCurrentIndex,
  gateSnoozeCount,
  gateCurrentEntry,
  gateProgress,
  canSnooze,
  isGateActive,
  pendingBlackBoxEntries,
  refreshGateReviewClock,
  focusPreferences,
  resetGateState,
  getTodayDate,
  getTomorrowDate,
  updateBlackBoxEntry
} from '../state/focus-stores';

interface OperationError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

type DeferredGateMutation =
  | { kind: 'mark-read'; entryId: string }
  | { kind: 'mark-completed'; entryId: string }
  | { kind: 'snooze'; entryId: string; snoozeUntil: string };

/** LocalStorage 键：上次大门检查日期 */
const GATE_LAST_CHECK_DATE_KEY = 'focus_gate_last_check_date';
/** LocalStorage 键：当日跳过次数重置日期 */
const GATE_SNOOZE_RESET_DATE_KEY = 'focus_gate_snooze_reset_date';

/**
 * 动画两阶段超时保护
 * 
 * 【2026-04-20 根因修复】
 * 单一 1200ms wall-clock 超时无法区分两种失败模式：
 *  1) animationstart 迟迟不触发（元素未渲染 / 主线程阻塞 / CD 延迟）
 *  2) animationstart 已触发但 animationend 丢失（浏览器 tab 后台节流等）
 * 
 * 并且当 visibilitychange 等处理器占用主线程 200+ms 时，实际 CSS 动画（620-660ms）
 * 开始时已消耗掉大半预算，导致 fallback 误触发 "forcing idle" 警告。
 * 
 * 正确做法：以真实 DOM `animationstart` 事件为计时锚点。
 */
/** 阶段一：从信号设置到 animationstart 的最长允许时间（覆盖主线程阻塞/CD 延迟） */
const ANIMATION_START_GRACE_MS = 800;
/** 阶段二：animationstart 到 animationend 的最长允许时间（覆盖浏览器节流/丢事件） */
const ANIMATION_DURATION_MAX_MS = 1500;
const GATE_REVIEW_SYNC_INTERVAL_MS = Math.max(30_000, SYNC_CONFIG.BLACKBOX_PULL_FRESHNESS_WINDOW);

export type GateMotionState =
  | 'idle'
  | 'entering'
  | 'heave_read'
  | 'heavy_drop'
  | 'settling';

@Injectable({
  providedIn: 'root'
})
export class GateService {
  private readonly blackBoxService = inject(BlackBoxService);
  private readonly logger = inject(LoggerService);
  private readonly ngZone = inject(NgZone);
  private readonly destroyRef = inject(DestroyRef);

  // 暴露状态给组件
  readonly state = gateState;
  readonly pendingItems = gatePendingItems;
  readonly currentIndex = gateCurrentIndex;
  readonly snoozeCount = gateSnoozeCount;
  readonly currentEntry = gateCurrentEntry;
  readonly progress = gateProgress;
  readonly canSnooze = canSnooze;

  /** 门体动效状态 */
  readonly cardAnimation = signal<GateMotionState>('idle');

  /** 完成落地冲击节拍（用于触发 Overlay 震动） */
  readonly impactTick = signal(0);

  // 是否显示完成提示
  readonly showCompletionMessage = signal<boolean>(false);

  /**
   * [DEV] 开发模式强制显示标志
   * 为 true 时，FocusModeComponent 跳过 loadFromLocal + checkGate，
   * 防止模拟数据被 IndexedDB 空数据覆盖
   */
  readonly devForceActive = signal<boolean>(false);

  /**
   * 大门是否激活（正在审查条目）
   */
  readonly isActive = isGateActive;

  /** 动画超时定时器 - 用于防止动画卡死 */
  private animationTimeoutId: ReturnType<typeof setTimeout> | null = null;

  /** 当前等待 animationstart 的状态（两阶段超时的锚点） */
  private pendingAnimationState: GateMotionState | null = null;
  /** 当前阶段一/二共用的超时回调 */
  private pendingAnimationTimeout: (() => void) | null = null;
  /** 当前是否已进入阶段二（animationstart 已触发） */
  private animationStarted = false;

  /** 当前动作动画（用于防止 timeout + animationend 双触发） */
  private actionInFlight: 'heave_read' | 'heavy_drop' | null = null;
  /**
   * Gate 动画期延迟提交的黑匣子 mutation。
   * 这样点击完成时不会在同一帧把全局黑匣子面板、pending 计数和同步卡片一起抖起来。
   */
  private deferredMutation: DeferredGateMutation | null = null;
  private reviewSyncTimerId: ReturnType<typeof setInterval> | null = null;
  private reviewSyncInFlight = false;
  /** 【修复 L-21/M-08】matchMedia 监听器引用，用于销毁时移除 */
  private reducedMotionMediaQuery: MediaQueryList | null = null;
  private reducedMotionHandler: ((e: MediaQueryListEvent) => void) | null = null;
  private reviewVisibilityHandler: (() => void) | null = null;

  /**
   * 检测用户是否启用了减少动画（prefers-reduced-motion）
   * 使用响应式 signal 支持运行时变化
   */
  private readonly prefersReducedMotionSignal = signal<boolean>(
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  );

  /** 向后兼容的只读访问器 */
  private get prefersReducedMotion(): boolean {
    return this.prefersReducedMotionSignal();
  }

  constructor() {
    this.setupReducedMotionListener();
    this.setupLivePendingEntrySync();

    // 【修复 M-13】DestroyRef 清理：停止 reviewSync 定时器和移除 matchMedia 监听器
    this.destroyRef.onDestroy(() => {
      this.stopReviewingRemoteSync();
      this.clearAnimationTimeout();
      if (this.reducedMotionMediaQuery && this.reducedMotionHandler) {
        this.reducedMotionMediaQuery.removeEventListener('change', this.reducedMotionHandler);
        this.reducedMotionMediaQuery = null;
        this.reducedMotionHandler = null;
      }
      if (typeof document !== 'undefined' && this.reviewVisibilityHandler) {
        document.removeEventListener('visibilitychange', this.reviewVisibilityHandler);
        this.reviewVisibilityHandler = null;
      }
    });
  }

  private setupLivePendingEntrySync(): void {
    if (typeof document !== 'undefined' && !this.reviewVisibilityHandler) {
      this.reviewVisibilityHandler = () => {
        if (document.visibilityState === 'visible' && gateState() === 'reviewing') {
          this.refreshReviewingQueueFromRemote(true);
        }
      };
      document.addEventListener('visibilitychange', this.reviewVisibilityHandler);
    }

    effect(() => {
      const state = gateState();
      const pending = pendingBlackBoxEntries();

      if (state !== 'reviewing') {
        this.stopReviewingRemoteSync();
        return;
      }

      this.syncReviewingQueueWithPending(pending, 'signal');
      this.ensureReviewingRemoteSync();
    });
  }

  private ensureReviewingRemoteSync(): void {
    if (typeof window === 'undefined') return;
    if (this.reviewSyncTimerId) return;

    this.refreshReviewingQueueFromRemote(true);

    this.reviewSyncTimerId = setInterval(() => {
      if (gateState() !== 'reviewing') {
        this.stopReviewingRemoteSync();
        return;
      }

      this.refreshReviewingQueueFromRemote(true);
    }, GATE_REVIEW_SYNC_INTERVAL_MS);
  }

  private refreshReviewingQueueFromRemote(force = false): void {
    if (gateState() !== 'reviewing') {
      return;
    }

    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
      return;
    }

    if (this.reviewSyncInFlight) {
      return;
    }

    this.reviewSyncInFlight = true;
    const expectedUserId = this.blackBoxService.getExpectedSyncUserId() ?? undefined;

    this.blackBoxService.loadFromServer({ reason: 'gate-review', force, expectedUserId })
      .then(() => {
        this.ngZone.run(() => {
          if (gateState() !== 'reviewing') return;
          this.syncReviewingQueueWithPending(pendingBlackBoxEntries(), 'remote');
        });
      })
      .catch((error: unknown) => {
        this.logger.debug('Gate', 'Remote pull while gate reviewing failed', {
          error: error instanceof Error ? error.message : String(error)
        });
      })
      .finally(() => {
        this.reviewSyncInFlight = false;
      });
  }

  private stopReviewingRemoteSync(): void {
    if (this.reviewSyncTimerId) {
      clearInterval(this.reviewSyncTimerId);
      this.reviewSyncTimerId = null;
    }
    this.reviewSyncInFlight = false;
  }

  private syncReviewingQueueWithPending(
    latestPending: BlackBoxEntry[],
    source: 'checkGate' | 'signal' | 'remote'
  ): void {
    const currentItems = gatePendingItems();
    const currentIndex = gateCurrentIndex();
    const safeIndex = Math.min(Math.max(currentIndex, 0), currentItems.length);

    if (safeIndex !== currentIndex) {
      gateCurrentIndex.set(safeIndex);
    }

    // 【修复 2026-04-20】保留 safeIndex+1 的前缀（包含“当前正在展示/动画中的条目”）。
    // 之前的实现只保留 slice(0, safeIndex)，当用户在当前条目触发 markAsCompleted 时，
    // pendingBlackBoxEntries 计算信号会同步剔除该条目，effect 立即重算队列，
    // 把当前位置的条目从 gatePendingItems 中移除；随后 finalizeActionTransition
    // 仍然执行 currentIndex + 1，导致跳过一条未审查的条目，并使总数提前归零、
    // 表现为“只滑一次大门就直接进入项目”。
    // 这里显式锁定 handled + current（正在飞出的条目），让增量合并只影响尾部未审查项。
    const inFlightCount = this.actionInFlight ? 1 : 0;
    const preserveCount = Math.min(safeIndex + inFlightCount, currentItems.length);
    const preservedPrefix = currentItems.slice(0, preserveCount);
    const preservedIds = new Set(preservedPrefix.map(item => item.id));
    const nextUnprocessed = latestPending.filter(item => !preservedIds.has(item.id));
    const nextItems = [...preservedPrefix, ...nextUnprocessed];

    if (!this.isSameQueue(currentItems, nextItems)) {
      gatePendingItems.set(nextItems);
      this.logger.debug('Gate', `Gate queue refreshed from ${source}`, {
        before: currentItems.length,
        after: nextItems.length,
        handled: safeIndex,
        inFlight: inFlightCount
      });
    }

    // 仅当队列彻底空（没有保留项也没有未处理项）时才判定完成，
    // 避免在动画进行中因同步信号剔除导致的误判。
    // 【修复 2026-04-21】同时排除 deferredMutation：finalizeActionTransition 会先
    // 把 actionInFlight 置 null 再进入 settling 阶段，真正的 mark-read /
    // mark-completed 要等到 onSettlingComplete -> flushDeferredMutation 才落库。
    // 在这两步之间，远端 pull / BlackBox LWW 升级可能让 pendingBlackBoxEntries
    // 短暂归零，从而触发 queue-empty 误判，造成「大门瞬间消失」并把未提交的条目
    // 留在 pending 列表里，之后被其他路径重新唤起大门。
    if (
      nextItems.length === 0
      && !this.actionInFlight
      && !this.deferredMutation
    ) {
      this.completeGateSession('queue-empty');
    }
  }

  private isSameQueue(a: BlackBoxEntry[], b: BlackBoxEntry[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i].id !== b[i].id) return false;
      if (a[i].updatedAt !== b[i].updatedAt) return false;
    }
    return true;
  }

  private completeGateSession(reason: 'all-processed' | 'queue-empty'): void {
    this.flushDeferredMutation();
    gateState.set('completed');
    this.showCompletionMessage.set(true);
    this.cardAnimation.set('idle');
    this.actionInFlight = null;
    this.deferredMutation = null;
    this.clearAnimationTimeout();
    this.stopReviewingRemoteSync();

    // 【根因修复 2026-05-09】标记今日大门已处理，避免后台闲置恢复时
    // FocusStartupProbe 的 local→remote 两阶段探针（或 pullChanges 带回的新 pending）
    // 让 checkGate() 重新进入 'reviewing' 状态而出现二次弹门。
    this.persistGateHandledToday();

    this.logger.info('Gate', `Gate completed (${reason})`);

    setTimeout(() => {
      this.showCompletionMessage.set(false);
    }, 1500);
  }

  /**
   * 监听 prefers-reduced-motion 变化
   * 当用户在运行时切换减少动画偏好时，立即响应
   */
  private setupReducedMotionListener(): void {
    if (typeof window === 'undefined') return;

    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

    // 【修复 L-21/M-08】存储 mediaQuery 和 handler 引用，以便 DestroyRef 清理
    this.reducedMotionMediaQuery = mediaQuery;
    this.reducedMotionHandler = (e: MediaQueryListEvent) => {
      this.prefersReducedMotionSignal.set(e.matches);
      this.logger.debug('Gate', `prefers-reduced-motion changed to: ${e.matches}`);

      if (e.matches && this.cardAnimation() !== 'idle') {
        this.logger.info('Gate', 'Reduced motion enabled, forcing idle state');
        const currentAnimation = this.cardAnimation();

        if (currentAnimation === 'heave_read') {
          this.onHeaveReadComplete();
          return;
        }

        if (currentAnimation === 'heavy_drop') {
          this.onHeavyDropComplete();
          return;
        }

        if (currentAnimation === 'settling') {
          this.onSettlingComplete();
          return;
        }

        this.cardAnimation.set('idle');
        this.actionInFlight = null;
        this.clearAnimationTimeout();
      }
    };

    mediaQuery.addEventListener('change', this.reducedMotionHandler);
  }

  /**
   * 设置动画状态并启动两阶段超时保护
   * 
   * 阶段一：signal set → 等待 animationstart 在 ANIMATION_START_GRACE_MS 内触发。
   *         若超时，视为动画未实际启动（元素未渲染 / reduced motion CSS 介入等），
   *         直接切回 idle 并执行回调。
   * 阶段二：animationstart 触发后（由 GateCard 通过 onAnimationStart 通知），
   *         等待 animationend 在 ANIMATION_DURATION_MAX_MS 内触发。
   *         若超时，视为浏览器节流/丢事件，兜底切 idle。
   */
  private setCardAnimationWithTimeout(
    state: GateMotionState,
    onTimeout?: () => void
  ): void {
    this.clearAnimationTimeout();

    if (state !== 'idle' && this.prefersReducedMotion) {
      this.cardAnimation.set('idle');
      this.logger.debug('Gate', `Reduced motion: skipping animation state '${state}'`);
      onTimeout?.();
      return;
    }

    this.cardAnimation.set(state);

    if (state === 'idle') {
      return;
    }

    this.pendingAnimationState = state;
    this.pendingAnimationTimeout = onTimeout ?? null;
    this.animationStarted = false;

    // 阶段一：等待 animationstart
    this.animationTimeoutId = setTimeout(() => {
      this.ngZone.run(() => {
        if (this.cardAnimation() !== state) return;
        if (this.animationStarted) return;

        this.logger.warn(
          'Gate',
          `Animation did not start within ${ANIMATION_START_GRACE_MS}ms, forcing idle from '${state}'`
        );
        // 【修复 2026-04-21】先调用 cb 再置 idle：onSettlingComplete 等回调依赖
        // cardAnimation() === state 的守卫来判定是否兜底执行 flushDeferredMutation。
        // 旧顺序（先 set idle 再 cb）会让回调早返回，导致延迟提交的 mark-read /
        // mark-completed 被静默丢弃，表现为大门项被消费但实际仍 pending。
        const cb = this.pendingAnimationTimeout;
        this.resetPendingAnimation();
        cb?.();
        if (this.cardAnimation() === state) {
          this.cardAnimation.set('idle');
        }
      });
    }, ANIMATION_START_GRACE_MS);
  }

  /**
   * GateCard 组件在真实 DOM animationstart 触发时调用。
   * 将超时计时从阶段一切换到阶段二（animationend 兜底）。
   */
  notifyAnimationStarted(state: GateMotionState): void {
    if (this.pendingAnimationState !== state) return;
    if (this.cardAnimation() !== state) return;
    if (this.animationStarted) return;

    this.animationStarted = true;
    this.clearAnimationTimeoutOnly();

    // 阶段二：等待 animationend 真正触发
    this.animationTimeoutId = setTimeout(() => {
      this.ngZone.run(() => {
        if (this.cardAnimation() !== state) return;

        this.logger.warn(
          'Gate',
          `Animation duration exceeded ${ANIMATION_DURATION_MAX_MS}ms, forcing idle from '${state}'`
        );
        // 【修复 2026-04-21】先调用 cb 再置 idle，原因同阶段一兜底注释。
        const cb = this.pendingAnimationTimeout;
        this.resetPendingAnimation();
        cb?.();
        if (this.cardAnimation() === state) {
          this.cardAnimation.set('idle');
        }
      });
    }, ANIMATION_DURATION_MAX_MS);
  }

  private resetPendingAnimation(): void {
    this.pendingAnimationState = null;
    this.pendingAnimationTimeout = null;
    this.animationStarted = false;
  }

  /** 仅清理 setTimeout，不重置 pending 状态（用于阶段切换） */
  private clearAnimationTimeoutOnly(): void {
    if (!this.animationTimeoutId) return;
    clearTimeout(this.animationTimeoutId);
    this.animationTimeoutId = null;
  }

  /** 清除动画超时定时器 */
  private clearAnimationTimeout(): void {
    this.clearAnimationTimeoutOnly();
    this.resetPendingAnimation();
  }

  /**
   * 检查是否需要显示大门
   * 在应用启动时调用
   */
  checkGate(): void {
    refreshGateReviewClock();

    // 如果大门已经在审查中，不要重复初始化（避免动画叠加和状态重置）
    if (gateState() === 'reviewing') {
      this.syncReviewingQueueWithPending(pendingBlackBoxEntries(), 'checkGate');
      this.logger.debug('Gate', 'Gate already reviewing, queue refreshed');
      return;
    }

    // 【根因修复 2026-05-09】今日大门已处理（completeGateSession / forceBypass）则短路。
    // 避免后台闲置恢复时 FocusStartupProbe 的 local→remote 两阶段探针在用户刚审完
    // 之后再次把 gateState 推回 'reviewing'，出现"两次大门"。手机端和电脑端共享
    // 同一条 visibility/pageshow 恢复链路，因此修复一处即覆盖两端。
    if (this.isGateHandledToday()) {
      // 短路时无论原状态是 'completed' / 'bypassed' / 其他都清掉缓存的 pendingItems，
      // 它们仅在 reviewing 期间用于显示，非激活态保留只会让外部观察到陈旧数据。
      gatePendingItems.set([]);
      gateCurrentIndex.set(0);
      if (gateState() !== 'completed' && gateState() !== 'bypassed') {
        gateState.set('bypassed');
      }
      this.logger.debug('Gate', 'Gate already handled today, skip re-check');
      return;
    }

    this.devForceActive.set(false);
    this.showCompletionMessage.set(false);
    this.actionInFlight = null;
    this.deferredMutation = null;

    const preferences = focusPreferences();

    if (!preferences.gateEnabled) {
      gatePendingItems.set([]);
      gateCurrentIndex.set(0);
      gateState.set('disabled');
      this.logger.debug('Gate', 'Gate disabled by user preference');
      return;
    }

    this.resetDailySnoozeCount();

    const pending = pendingBlackBoxEntries();

    if (pending.length > 0) {
      gatePendingItems.set(pending);
      gateCurrentIndex.set(0);
      gateState.set('reviewing');
      this.setCardAnimationWithTimeout('entering', () => this.onEnteringComplete());
      this.logger.info('Gate', `Gate activated with ${pending.length} pending items`);
      return;
    }

    gatePendingItems.set([]);
    gateCurrentIndex.set(0);
    gateState.set('bypassed');
    this.logger.debug('Gate', 'No pending items, gate bypassed');
  }

  /** 标记当前条目为已读 */
  markAsRead(): Result<void, OperationError> {
    if (this.isActionLocked()) {
      return failure(ErrorCodes.OPERATION_FAILED, '动画处理中，请稍后');
    }

    const current = this.getCurrentEntry();
    if (!current) {
      return failure(ErrorCodes.FOCUS_ENTRY_NOT_FOUND, '当前没有待处理条目');
    }

    this.deferredMutation = { kind: 'mark-read', entryId: current.id };
    this.startActionTransition('heave_read');
    return success(undefined);
  }

  /** 标记当前条目为完成 */
  markAsCompleted(): Result<void, OperationError> {
    if (this.isActionLocked()) {
      return failure(ErrorCodes.OPERATION_FAILED, '动画处理中，请稍后');
    }

    const current = this.getCurrentEntry();
    if (!current) {
      return failure(ErrorCodes.FOCUS_ENTRY_NOT_FOUND, '当前没有待处理条目');
    }

    this.deferredMutation = { kind: 'mark-completed', entryId: current.id };
    this.startActionTransition('heavy_drop');
    return success(undefined);
  }

  /**
   * 跳过当前条目（稍后提醒）
   * 兼容保留：UI 已隐藏此动作
   */
  snooze(): Result<void, OperationError> {
    if (this.isActionLocked()) {
      return failure(ErrorCodes.OPERATION_FAILED, '动画处理中，请稍后');
    }

    if (!canSnooze()) {
      return failure(
        ErrorCodes.FOCUS_SNOOZE_LIMIT_EXCEEDED,
        ErrorMessages[ErrorCodes.FOCUS_SNOOZE_LIMIT_EXCEEDED]
      );
    }

    const current = this.getCurrentEntry();
    if (!current) {
      return failure(ErrorCodes.FOCUS_ENTRY_NOT_FOUND, '当前没有待处理条目');
    }

    const tomorrow = getTomorrowDate();
    this.deferredMutation = { kind: 'snooze', entryId: current.id, snoozeUntil: tomorrow };
    gateSnoozeCount.update(c => c + 1);

    // 兼容路径：在新门体里统一使用 heave_read 过渡
    this.startActionTransition('heave_read');

    return success(undefined);
  }

  /**
   * 启动动作动画并在结束后推进到下一条
   */
  private startActionTransition(state: 'heave_read' | 'heavy_drop'): void {
    this.actionInFlight = state;
    this.setCardAnimationWithTimeout(state, () => this.finalizeActionTransition(state));
  }

  /**
   * 动作动画结束（含 timeout 兜底）
   */
  private finalizeActionTransition(state: 'heave_read' | 'heavy_drop'): void {
    if (this.actionInFlight !== state) return;

    this.actionInFlight = null;
    this.clearAnimationTimeout();

    if (state === 'heavy_drop') {
      this.impactTick.update(v => v + 1);
    }

    const nextIndex = gateCurrentIndex() + 1;
    const total = gatePendingItems().length;

    if (nextIndex >= total) {
      this.completeGateSession('all-processed');
      return;
    }

    gateCurrentIndex.set(nextIndex);
    this.setCardAnimationWithTimeout('settling', () => this.onSettlingComplete());
  }

  /** 入场动画完成回调 */
  onEnteringComplete(): void {
    if (this.cardAnimation() !== 'entering') return;
    this.clearAnimationTimeout();
    this.cardAnimation.set('idle');
  }

  /** 已读抛掷动画完成回调 */
  onHeaveReadComplete(): void {
    // 【修复 P2-02】修正逻辑运算符：reducedMotion 启用时应放行而非拦截
    if (this.cardAnimation() !== 'heave_read' && !this.prefersReducedMotion) return;
    this.finalizeActionTransition('heave_read');
  }

  /** 完成重落动画完成回调 */
  onHeavyDropComplete(): void {
    // 【修复 P2-02】同上
    if (this.cardAnimation() !== 'heavy_drop' && !this.prefersReducedMotion) return;
    this.finalizeActionTransition('heavy_drop');
  }

  /** 新条目沉降动画完成回调 */
  onSettlingComplete(): void {
    if (this.cardAnimation() !== 'settling' && !this.prefersReducedMotion) return;
    this.clearAnimationTimeout();
    this.cardAnimation.set('idle');
    this.flushDeferredMutation();
  }

  /**
   * 兼容旧 GateCard 回调名称
   * @deprecated 请使用 onHeavyDropComplete
   */
  onSinkingComplete(): void {
    this.onHeavyDropComplete();
  }

  /**
   * 兼容旧 GateCard 回调名称
   * @deprecated 请使用 onSettlingComplete
   */
  onEmergingComplete(): void {
    this.onSettlingComplete();
  }

  /** 获取当前条目 */
  getCurrentEntry(): BlackBoxEntry | null {
    const items = gatePendingItems();
    const index = gateCurrentIndex();
    return items[index] ?? null;
  }

  /** 重置每日跳过次数 */
  private resetDailySnoozeCount(): void {
    const today = getTodayDate();
    const lastResetDate = localStorage.getItem(GATE_SNOOZE_RESET_DATE_KEY);

    if (lastResetDate !== today) {
      gateSnoozeCount.set(0);
      localStorage.setItem(GATE_SNOOZE_RESET_DATE_KEY, today);
      this.logger.debug('Gate', 'Daily snooze count reset');
    }
  }

  /**
   * 今日大门是否已经被处理过（completeGateSession 或 forceBypass）
   * 用于阻止后台恢复链路里 local→remote 两次 checkGate 造成的二次弹门
   */
  private isGateHandledToday(): boolean {
    if (typeof localStorage === 'undefined') return false;
    try {
      return localStorage.getItem(GATE_LAST_CHECK_DATE_KEY) === getTodayDate();
    } catch (error) {
      this.logger.debug(
        'Gate',
        'Read GATE_LAST_CHECK_DATE_KEY failed, fall through to normal check',
        error instanceof Error ? error.message : String(error)
      );
      return false;
    }
  }

  /** 标记今日大门已处理 */
  private persistGateHandledToday(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(GATE_LAST_CHECK_DATE_KEY, getTodayDate());
    } catch (error) {
      // 隐私模式 / 配额耗尽时仅影响下一次 checkGate 的短路兜底，不会引起数据错误。
      this.logger.debug(
        'Gate',
        'Persist GATE_LAST_CHECK_DATE_KEY failed, dedup will fall back to in-memory state',
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  /**
   * 强制跳过大门（用于紧急情况）
   * 注意：这不会标记条目为已处理
   */
  forceBypass(): void {
    this.devForceActive.set(false);
    this.deferredMutation = null;
    this.stopReviewingRemoteSync();
    gateState.set('bypassed');
    this.persistGateHandledToday();
    this.logger.warn('Gate', 'Gate force bypassed');
  }

  /** 重置大门状态（用于测试或用户重新触发） */
  reset(): void {
    this.devForceActive.set(false);
    this.showCompletionMessage.set(false);
    this.actionInFlight = null;
    this.deferredMutation = null;
    this.stopReviewingRemoteSync();
    this.clearAnimationTimeout();
    this.cardAnimation.set('idle');
    resetGateState();
    localStorage.removeItem(GATE_LAST_CHECK_DATE_KEY);
    this.logger.debug('Gate', 'Gate state reset');
  }

  /** 处理键盘快捷键 */
  handleKeydown(event: KeyboardEvent): boolean {
    if (!this.isActive()) return false;

    const key = event.key;
    const config = FOCUS_CONFIG.KEYBOARD;

    if ((config.GATE_MARK_READ as readonly string[]).includes(key)) {
      event.preventDefault();
      this.markAsRead();
      return true;
    }

    if ((config.GATE_MARK_COMPLETED as readonly string[]).includes(key)) {
      event.preventDefault();
      this.markAsCompleted();
      return true;
    }

    return false;
  }

  // ============================================
  // 开发环境测试方法
  // ============================================

  /**
   * [DEV] 强制显示大门（用于开发测试）
   * 创建模拟的待处理条目并激活大门
   */
  devForceShowGate(): void {
    this.devForceActive.set(true);
    this.stopReviewingRemoteSync();
    localStorage.removeItem(GATE_LAST_CHECK_DATE_KEY);

    if (!focusPreferences().gateEnabled) {
      focusPreferences.update(p => ({ ...p, gateEnabled: true }));
      this.logger.info('Gate', '[DEV] Auto-enabled gateEnabled for testing');
    }

    const mockProjectId = crypto.randomUUID();
    const mockUserId = crypto.randomUUID();
    const mockEntries = [
      {
        id: crypto.randomUUID(),
        projectId: mockProjectId,
        userId: mockUserId,
        content: '这是一条测试遗留条目 - 先做A模块，然后连B数据库，不对，那个接口有问题，要先弄C...',
        date: this.getYesterdayDate(),
        createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        updatedAt: new Date().toISOString(),
        isRead: false,
        isCompleted: false,
        isArchived: false,
        deletedAt: null,
        syncStatus: 'synced' as const,
        localCreatedAt: new Date().toISOString(),
        snoozeCount: 0,
        snoozeUntil: undefined
      },
      {
        id: crypto.randomUUID(),
        projectId: mockProjectId,
        userId: mockUserId,
        content: '第二条测试条目 - 需要修复支付接口的bug，客户反馈订单状态没有正确更新',
        date: this.getYesterdayDate(),
        createdAt: new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString(),
        updatedAt: new Date().toISOString(),
        isRead: false,
        isCompleted: false,
        isArchived: false,
        deletedAt: null,
        syncStatus: 'synced' as const,
        localCreatedAt: new Date().toISOString(),
        snoozeCount: 1,
        snoozeUntil: undefined
      },
      {
        id: crypto.randomUUID(),
        projectId: mockProjectId,
        userId: mockUserId,
        content: '第三条 - 优化首页加载速度，现在太慢了',
        date: this.getYesterdayDate(),
        createdAt: new Date(Date.now() - 22 * 60 * 60 * 1000).toISOString(),
        updatedAt: new Date().toISOString(),
        isRead: false,
        isCompleted: false,
        isArchived: false,
        deletedAt: null,
        syncStatus: 'synced' as const,
        localCreatedAt: new Date().toISOString(),
        snoozeCount: 0,
        snoozeUntil: undefined
      }
    ];

    for (const entry of mockEntries) {
      updateBlackBoxEntry(entry);
    }

    gatePendingItems.set(mockEntries);
    gateCurrentIndex.set(0);
    gateSnoozeCount.set(0);
    gateState.set('reviewing');
    this.showCompletionMessage.set(false);
    this.actionInFlight = null;
    this.deferredMutation = null;

    this.setCardAnimationWithTimeout('entering', () => this.onEnteringComplete());

    this.logger.info('Gate', '[DEV] Gate force shown with mock entries');
  }

  /** 动画/延迟提交进行中时锁定新动作，避免覆盖 deferred mutation */
  private isActionLocked(): boolean {
    return this.cardAnimation() !== 'idle'
      || this.actionInFlight !== null
      || this.deferredMutation !== null;
  }

  /** 在动画安全点提交延迟的黑匣子 mutation */
  private flushDeferredMutation(): void {
    const mutation = this.deferredMutation;
    if (!mutation) {
      return;
    }

    this.deferredMutation = null;

    let result: Result<BlackBoxEntry, OperationError>;

    if (mutation.kind === 'mark-read') {
      result = this.blackBoxService.markAsRead(mutation.entryId);
    } else if (mutation.kind === 'mark-completed') {
      result = this.blackBoxService.markAsCompleted(mutation.entryId);
    } else {
      result = this.blackBoxService.snooze(mutation.entryId, mutation.snoozeUntil);
    }

    if (!result.ok) {
      this.logger.warn('Gate', 'Deferred gate mutation failed', {
        kind: mutation.kind,
        entryId: mutation.entryId,
        message: result.error.message,
      });
    }
  }

  /** 获取昨天日期 */
  private getYesterdayDate(): string {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    return yesterday.toISOString().split('T')[0];
  }
}
