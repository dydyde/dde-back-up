import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  Input,
  OnDestroy,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { NgClass, NgStyle } from '@angular/common';
import { PARKING_CONFIG } from '../../../../config/parking.config';
import { WAIT_PRESETS, type DockEntry } from '../../../../models/parking-dock';
import { DockEngineService } from '../../../../services/dock-engine.service';
import {
  buildCompleteConsoleMotionBatch,
  buildRadarConsoleMotionBatch,
  buildSuspendConsoleMotionBatch,
  buildSwitchConsoleMotionBatch,
  createConsoleMotionMap,
  createStableConsoleRenderCards,
  resolveConsoleCardStablePoseKey,
  toConsoleCardFilter,
  toConsoleCardOpacity,
  toConsoleCardTransform,
  toConsoleCardZIndex,
  type ConsoleCardMotionBatch,
  type ConsoleCardMotionState,
  type ConsoleCardPoseKey,
  type ConsoleRenderCard,
} from '../utils/dock-console-motion';
import { formatDockMinutes } from '../utils/dock-format';
import { KnowledgeAnchorComponent } from '../../../shared/components/knowledge-anchor/knowledge-anchor.component';

const consoleMotion = PARKING_CONFIG.MOTION.console;

/**
 * 主控台卡片堆叠 — 停泊坞专注模式的绝对 C 位区域。
 *
 * 物理逻辑统一为「姿态表 + 批处理运动」：
 * - 稳态只认 4 个静止姿态：focus / depth-1 / depth-2 / depth-3
 * - 过渡只认 4 个离场/入场姿态：offstage-top / offstage-bottom / offstage-back / radar-entry
 * - 每次操作生成一整个 batch，所有受影响卡片一起结算，避免局部跳相位
 */
@Component({
  selector: 'app-dock-console-stack',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgClass, NgStyle, KnowledgeAnchorComponent],
  styles: [`
    :host {
      display: block;
      position: relative;
    }

    .stack-perspective {
      perspective: 1000px;
      perspective-origin: center 60%;
    }

    .console-card {
      transition:
        transform var(--console-stack-settle-ms) var(--console-motion-default-ease),
        opacity var(--console-stack-settle-ms) var(--console-motion-default-ease),
        filter var(--console-stack-settle-ms) var(--console-motion-default-ease),
        box-shadow var(--console-stack-settle-ms) ease;
      transform-style: preserve-3d;
      backface-visibility: hidden;
      contain: layout paint style;
    }

    .console-card.is-animating {
      will-change: transform, opacity, filter;
      animation:
        consoleCardMotion var(--console-motion-duration) var(--console-motion-ease) both;
      pointer-events: none;
      transition: none;
    }

    @keyframes consoleCardMotion {
      from {
        transform: var(--console-motion-from-transform);
        opacity: var(--console-motion-from-opacity);
        filter: var(--console-motion-from-filter);
      }
      to {
        transform: var(--console-motion-to-transform);
        opacity: var(--console-motion-to-opacity);
        filter: var(--console-motion-to-filter);
      }
    }

    .console-card.depth-card {
      cursor: pointer;
      pointer-events: auto;
      transform-origin: top right;
    }

    .console-card.depth-card:hover,
    .console-card.depth-card:focus-visible {
      box-shadow:
        0 16px 34px rgba(2, 6, 23, 0.28),
        0 0 0 1px rgba(129, 140, 248, 0.14);
    }

    .console-card.depth-card:focus-visible {
      outline: 2px solid rgba(129, 140, 248, 0.72);
      outline-offset: 3px;
    }

    .glass-card {
      background:
        linear-gradient(165deg, rgba(30, 36, 46, 0.95), rgba(17, 23, 32, 0.92)),
        radial-gradient(circle at 50% 0%, rgba(99, 102, 241, 0.08), transparent 58%);
      border: 1px solid rgba(255, 255, 255, 0.09);
      box-shadow:
        0 14px 36px rgba(0, 0, 0, 0.42),
        0 3px 10px rgba(0, 0, 0, 0.18),
        inset 0 1px 0 rgba(255, 255, 255, 0.05);
    }

    .glass-card-bg {
      background:
        linear-gradient(165deg, rgba(26, 32, 42, 0.74), rgba(16, 21, 30, 0.68)),
        radial-gradient(circle at 50% 0%, rgba(255, 255, 255, 0.03), transparent 62%);
      border: 1px solid rgba(255, 255, 255, 0.05);
      box-shadow:
        0 10px 22px rgba(0, 0, 0, 0.24),
        inset 0 1px 0 rgba(255, 255, 255, 0.02);
    }

    .load-bar {
      position: absolute;
      left: 0;
      top: 32px;
      bottom: 32px;
      width: 6px;
      border-radius: 0 4px 4px 0;
      transition: background-color 0.3s ease, box-shadow 0.3s ease;
    }

    .load-high {
      background-color: #ef4444;
      box-shadow: 0 0 10px rgba(239, 68, 68, 0.55);
    }

    .load-low {
      background-color: #10b981;
      box-shadow: 0 0 10px rgba(16, 185, 129, 0.55);
    }

    @keyframes detailFadeIn {
      from {
        opacity: 0;
        transform: translateY(12px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    .detail-fade {
      animation: detailFadeIn 220ms ease-out both;
    }

    .focus-glow {
      box-shadow:
        0 8px 32px rgba(0, 0, 0, 0.4),
        0 0 0 1px rgba(99, 102, 241, 0.15),
        0 0 40px -10px rgba(99, 102, 241, 0.1);
    }

    .wait-menu {
      display: none;
      flex-direction: column;
      gap: 2px;
    }

    .wait-menu.visible {
      display: flex;
    }

    @keyframes swipeHint {
      0%, 100% {
        opacity: 0.3;
        transform: translateY(0);
      }
      50% {
        opacity: 0.6;
        transform: translateY(-6px);
      }
    }

    .swipe-hint {
      animation: swipeHint 2s ease-in-out infinite;
    }

    @media (prefers-reduced-motion: reduce) {
      .console-card,
      .console-card.is-animating,
      .detail-fade,
      .swipe-hint {
        animation: none;
        transition: none;
      }
    }
  `],
  template: `
    <div
      class="relative stack-perspective"
      [style.width.px]="cardSize().width"
      [style.height.px]="cardSize().height"
      [ngStyle]="motionStyle">

      @for (card of renderCards(); track card.renderId) {
        @let motion = motionState(card.renderId);
        @let isAnimating = motion !== null;
        @let showFocusChrome = isFocusChrome(card, motion);
        @let showFocusDetail = isFocusDetailVisible(card, motion);
        <div
          class="console-card absolute inset-0 rounded-3xl flex flex-col justify-between shadow-2xl"
          [class.is-animating]="isAnimating"
          [class.depth-card]="card.interactionEnabled && !showFocusChrome"
          [ngClass]="{
            'glass-card focus-glow': showFocusChrome,
            'glass-card-bg': !showFocusChrome
          }"
          [style.z-index]="getRenderCardZIndex(card, motion)"
          [style.opacity]="getRenderCardOpacity(card, motion)"
          [style.transform]="getRenderCardTransform(card, motion)"
          [style.filter]="getRenderCardFilter(card, motion)"
          [style.padding]="showFocusChrome ? '24px' : '20px 24px'"
          [style.--console-motion-duration]="motion ? motion.durationMs + 'ms' : null"
          [style.--console-motion-ease]="motion ? motion.easing : null"
          [style.--console-motion-from-transform]="motion ? poseTransform(motion.fromPoseKey) : null"
          [style.--console-motion-to-transform]="motion ? poseTransform(motion.toPoseKey) : null"
          [style.--console-motion-from-opacity]="motion ? poseOpacity(motion.fromPoseKey) : null"
          [style.--console-motion-to-opacity]="motion ? poseOpacity(motion.toPoseKey) : null"
          [style.--console-motion-from-filter]="motion ? poseFilter(motion.fromPoseKey) : null"
          [style.--console-motion-to-filter]="motion ? poseFilter(motion.toPoseKey) : null"
          (wheel)="onTaskWheel($event, card.taskId)"
          (click)="card.interactionEnabled && !isAnimating ? onCardClick(card.entry) : null"
          (keydown.enter)="card.interactionEnabled && !isAnimating ? onCardClick(card.entry) : null"
          (keydown.space)="card.interactionEnabled && !isAnimating ? onBackgroundCardSpace($event, card.entry) : null"
          (touchstart)="showFocusDetail ? onSwipeStart($event) : null"
          (touchmove)="showFocusDetail ? onSwipeMove($event) : null"
          (touchend)="showFocusDetail ? onSwipeEnd(card.taskId) : null"
          (pointerdown)="showFocusDetail ? onPointerDown($event) : null"
          (pointermove)="showFocusDetail ? onPointerMove($event) : null"
          (pointerup)="showFocusDetail ? onPointerUp(card.taskId) : null"
          (pointercancel)="onPointerCancel()"
          [attr.role]="card.interactionEnabled && !isAnimating ? 'button' : null"
          [attr.tabindex]="card.interactionEnabled && !isAnimating ? 0 : null"
          [attr.aria-label]="card.interactionEnabled ? ('切换到任务：' + card.entry.title) : null"
          data-testid="dock-v3-console-card">

          <div
            class="load-bar"
            [class.load-high]="card.entry.load === 'high'"
            [class.load-low]="card.entry.load === 'low'">
          </div>

          <div class="ml-3">
            <h2
              class="font-bold leading-tight"
              [class.text-2xl]="showFocusChrome"
              [class.text-stone-100]="showFocusChrome"
              [class.text-lg]="!showFocusChrome"
              [class.text-stone-300]="!showFocusChrome">
              {{ card.entry.title }}
            </h2>
            <div class="text-stone-400 text-xs mt-2 font-mono flex items-center gap-2">
              <span>{{ card.entry.expectedMinutes ? formatTime(card.entry.expectedMinutes) : '未设置时间' }}</span>
              @if (card.entry.waitMinutes && !showFocusChrome) {
                <span class="text-amber-500/60">⏳ {{ formatTime(card.entry.waitMinutes) }}</span>
              }
            </div>
          </div>

          @if (showFocusDetail) {
            <div class="detail-fade ml-3 mb-2 flex flex-col gap-4 flex-1 min-h-0">
              <div class="flex-1 text-sm text-stone-300 leading-relaxed border-l-2 border-stone-700 pl-3 overflow-auto hide-scrollbar">
                @if (card.entry.detail) {
                  {{ card.entry.detail }}
                } @else {
                  <span class="text-stone-500">
                    把任务写成能马上开始的下一步动作。
                  </span>
                }
              </div>
              <app-knowledge-anchor
                class="ml-3 block"
                [taskId]="card.taskId"
                [isMobile]="viewportSize().width <= 640"
                [editable]="false"
                [compact]="true"
                previewMode="deep-link-only">
              </app-knowledge-anchor>

              <div class="flex items-center justify-between pt-4 border-t border-stone-800">
                <button
                  type="button"
                  (click)="onComplete(card.taskId)"
                  class="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-xl transition-all shadow-lg shadow-indigo-500/20 hover:shadow-indigo-500/30 active:scale-95"
                  style="min-height: 44px;"
                  data-testid="dock-v3-complete-btn">
                  完成任务
                </button>

                <div class="flex items-center gap-2 relative" (mouseleave)="closeWaitPresets()">
                  <button
                    type="button"
                    (click)="toggleWaitPresets(card.taskId)"
                    class="px-3 py-2 rounded-xl bg-stone-800 hover:bg-stone-700 text-stone-400 hover:text-stone-300 transition-colors text-sm"
                    style="min-height: 46px; min-width: 46px;"
                    data-testid="dock-v3-wait-trigger">
                    ⏱ 等待
                  </button>

                  <div
                    class="wait-menu absolute bottom-full right-0 mb-2 min-w-[180px] rounded-2xl border border-stone-700 bg-stone-800/95 p-2 shadow-2xl backdrop-blur-sm"
                    [class.visible]="isWaitPresetVisible(card.taskId)"
                    data-testid="dock-v3-wait-menu">
                    <div class="mb-2 flex items-center justify-between px-1">
                      <span class="text-[10px] font-semibold tracking-wide text-stone-200">先挂起多久？</span>
                      <button
                        type="button"
                        class="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl px-2 py-2 text-[10px] text-stone-400 hover:bg-stone-700 hover:text-stone-200"
                        (click)="closeWaitPresets()"
                        data-testid="dock-v3-wait-close">
                        关闭
                      </button>
                    </div>
                    @for (preset of waitPresets; track preset.minutes) {
                      <button
                        type="button"
                        (click)="onWait(card.taskId, preset.minutes)"
                        class="w-full rounded-xl px-3 py-2 text-left text-[11px] text-stone-300 transition-colors hover:bg-stone-700 whitespace-nowrap"
                        style="min-height: 44px;"
                        data-testid="dock-v3-wait-preset">
                        {{ preset.label }}
                      </button>
                    }
                  </div>
                </div>
              </div>

              <div class="text-[10px] text-stone-500">
                仍支持专家快捷方式：上滑快速完成，Alt + 滚轮切换负荷。
              </div>
            </div>
          }
        </div>
      }

      @if (renderCards().length === 0) {
        <div class="absolute inset-0 flex flex-col items-center justify-center text-stone-500 text-sm gap-3">
          <svg class="w-8 h-8 opacity-30" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
              d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
          </svg>
          将任务拖入停泊坞开始专注
        </div>
      }
    </div>
  `,
})
export class DockConsoleStackComponent implements OnDestroy {
  readonly engine = inject(DockEngineService);
  readonly motionStyle: Record<string, string> = {
    '--console-stack-settle-ms': `${Math.max(
      consoleMotion.durationMs.completeShift,
      consoleMotion.durationMs.suspendReturn,
      consoleMotion.durationMs.switch,
      consoleMotion.durationMs.radar,
    )}ms`,
    '--console-motion-default-ease': PARKING_CONFIG.MOTION.easing.enter,
  };
  private readonly viewportSize = signal(this.readViewportSize());
  readonly cardSize = computed(() => {
    const viewport = this.viewportSize();
    const compact = viewport.width <= 640;
    const width = compact
      ? Math.min(PARKING_CONFIG.CONSOLE_CARD_WIDTH, Math.max(280, viewport.width - 40))
      : PARKING_CONFIG.CONSOLE_CARD_WIDTH;
    const height = compact
      ? Math.min(PARKING_CONFIG.CONSOLE_CARD_HEIGHT, Math.max(336, viewport.height - 440))
      : PARKING_CONFIG.CONSOLE_CARD_HEIGHT;
    return { width, height };
  });

  readonly waitPresets = WAIT_PRESETS.filter(preset => preset.minutes !== null && preset.minutes > 0);
  readonly waitPresetTaskId = signal<string | null>(null);
  readonly interactionLocked = signal(false);
  readonly renderCards = signal<ConsoleRenderCard[]>([]);
  readonly motionStateMap = signal<Record<string, ConsoleCardMotionState>>({});
  private readonly overrideEntriesState = signal<DockEntry[] | null>(null);

  @Input({ alias: 'overrideEntries' })
  set overrideEntries(value: DockEntry[] | null) {
    this.overrideEntriesState.set(value ? value.map((entry) => ({ ...entry })) : null);
  }

  private touchStartY = 0;
  private swipeActive = false;
  private pointerTracking = false;
  private pointerStartY = 0;
  private pointerDeltaY = 0;
  private pointerId: number | null = null;
  private interactionLockTimer: ReturnType<typeof setTimeout> | null = null;
  private motionTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Monotonically increasing counter used both as a cancellation token
   * (applyMotionBatch) and for unique key generation (nextBatchKey).
   *
   * NOTE: Both applyMotionBatch (++counter) and nextBatchKey (counter += 1)
   * increment this value, so it may advance by 2 within a single tick if
   * both paths run. This is intentional — nextBatchKey only needs a unique
   * key, and applyMotionBatch only needs its token to match at settle time.
   */
  private motionBatchCounter = 0;
  private lastHandledRadarInsertId: string | null = null;

  @HostListener('window:resize')
  onViewportResize(): void {
    this.viewportSize.set(this.readViewportSize());
  }

  @HostListener('window:dock-close-transient-surfaces')
  onCloseTransientSurfaces(): void {
    this.closeWaitPresets();
  }

  readonly stackEntries = computed(() => this.overrideEntriesState() ?? this.engine.consoleVisibleEntries());
  readonly visibleStackEntries = this.stackEntries;

  private readonly stableRenderSyncEffect = effect(() => {
    const entries = this.stackEntries();
    const currentRadarInsertId = this.engine.lastRadarInsertedTaskId();
    const hasActiveMotion = Object.keys(this.motionStateMap()).length > 0;
    if (hasActiveMotion) return;
    if (currentRadarInsertId && currentRadarInsertId !== this.lastHandledRadarInsertId) return;
    untracked(() => {
      this.renderCards.set(createStableConsoleRenderCards(entries));
    });
  });

  private readonly radarInsertEffect = effect(() => {
    if (this.overrideEntriesState()) return;
    const insertedId = this.engine.lastRadarInsertedTaskId();
    const postEntries = this.stackEntries();
    const hasActiveMotion = Object.keys(this.motionStateMap()).length > 0;
    if (!insertedId || hasActiveMotion || insertedId === this.lastHandledRadarInsertId) return;

    untracked(() => {
      // H-7 fix: 提前设置标记，防止动画中断后重复触发
      this.lastHandledRadarInsertId = insertedId;
      const pendingEviction = this.engine.pendingRadarEviction();
      const batch = buildRadarConsoleMotionBatch(
        this.snapshotStableEntries(),
        postEntries,
        insertedId,
        this.nextBatchKey('radar'),
      );
      this.applyMotionBatch(batch, () => {
        // H-7 fix: afterSettle 仅负责 eviction，标记已提前设置
        if (pendingEviction) {
          this.engine.flushRadarEviction(pendingEviction);
        }
      });
    });
  });

  ngOnDestroy(): void {
    this.clearMotionTimer();
    if (this.interactionLockTimer) {
      clearTimeout(this.interactionLockTimer);
      this.interactionLockTimer = null;
    }
  }

  motionState(renderId: string): ConsoleCardMotionState | null {
    return this.motionStateMap()[renderId] ?? null;
  }

  isFocusChrome(card: ConsoleRenderCard, motion: ConsoleCardMotionState | null): boolean {
    if (card.entry.status === 'focusing' && card.transient === 'stable') {
      return true;
    }
    return card.transient === 'exit-clone' && motion?.fromPoseKey === 'focus';
  }

  isFocusDetailVisible(card: ConsoleRenderCard, motion: ConsoleCardMotionState | null): boolean {
    return card.transient === 'stable' && card.entry.status === 'focusing' && motion === null;
  }

  getRenderCardTransform(
    card: ConsoleRenderCard,
    motion: ConsoleCardMotionState | null,
  ): string {
    return toConsoleCardTransform(motion?.toPoseKey ?? card.poseKey);
  }

  getRenderCardOpacity(
    card: ConsoleRenderCard,
    motion: ConsoleCardMotionState | null,
  ): number {
    return toConsoleCardOpacity(motion?.toPoseKey ?? card.poseKey);
  }

  getRenderCardFilter(
    card: ConsoleRenderCard,
    motion: ConsoleCardMotionState | null,
  ): string {
    return toConsoleCardFilter(motion?.toPoseKey ?? card.poseKey);
  }

  getRenderCardZIndex(
    card: ConsoleRenderCard,
    motion: ConsoleCardMotionState | null,
  ): number {
    return toConsoleCardZIndex(motion?.toPoseKey ?? card.poseKey);
  }

  poseTransform(poseKey: ConsoleCardPoseKey): string {
    return toConsoleCardTransform(poseKey);
  }

  poseOpacity(poseKey: ConsoleCardPoseKey): string {
    return toConsoleCardOpacity(poseKey).toString();
  }

  poseFilter(poseKey: ConsoleCardPoseKey): string {
    return toConsoleCardFilter(poseKey);
  }

  getCardTransform(entry: DockEntry, index: number): string {
    return toConsoleCardTransform(resolveConsoleCardStablePoseKey(entry, index));
  }

  getCardOpacity(entry: DockEntry, index: number): number {
    return toConsoleCardOpacity(resolveConsoleCardStablePoseKey(entry, index));
  }

  getCardFilter(entry: DockEntry, index: number): string {
    return toConsoleCardFilter(resolveConsoleCardStablePoseKey(entry, index));
  }

  getCardZIndex(entry: DockEntry, index: number): number {
    return toConsoleCardZIndex(resolveConsoleCardStablePoseKey(entry, index));
  }

  onComplete(taskId: string): void {
    if (this.interactionLocked()) return;
    this.closeWaitPresets();
    const preEntries = this.snapshotStableEntries();
    this.engine.completeTask(taskId);
    const batch = buildCompleteConsoleMotionBatch(
      preEntries,
      this.stackEntries(),
      taskId,
      this.nextBatchKey('complete'),
    );
    this.applyMotionBatch(batch);
  }

  onWait(taskId: string, minutes: number): void {
    if (this.interactionLocked()) return;
    this.closeWaitPresets();
    const preEntries = this.snapshotStableEntries();
    this.engine.suspendTask(taskId, minutes);
    const batch = buildSuspendConsoleMotionBatch(
      preEntries,
      this.stackEntries(),
      taskId,
      this.nextBatchKey('suspend'),
    );
    this.applyMotionBatch(batch);
  }

  onCardClick(entry: DockEntry): void {
    if (this.interactionLocked()) return;
    const preEntries = this.snapshotStableEntries();
    this.engine.switchToTask(entry.taskId);
    const batch = buildSwitchConsoleMotionBatch(preEntries, this.stackEntries(), entry.taskId);
    this.applyMotionBatch(batch);
  }

  onBackgroundCardSpace(event: KeyboardEvent, entry: DockEntry): void {
    event.preventDefault();
    this.onCardClick(entry);
  }

  onTaskWheel(event: WheelEvent, taskId: string): void {
    if (!event.altKey) return;
    event.preventDefault();
    this.engine.toggleLoad(taskId, event.deltaY > 0 ? 'down' : 'up');
  }

  setLoad(taskId: string, nextLoad: DockEntry['load']): void {
    const entry = this.stackEntries().find(item => item.taskId === taskId) ?? null;
    if (!entry || entry.load === nextLoad) return;
    this.engine.toggleLoad(taskId, nextLoad === 'high' ? 'up' : 'down');
  }

  onSwipeStart(event: TouchEvent): void {
    this.touchStartY = event.touches?.[0]?.clientY ?? 0;
    this.swipeActive = false;
  }

  onSwipeMove(event: TouchEvent): void {
    const delta = this.touchStartY - (event.touches?.[0]?.clientY ?? 0);
    if (delta > 60) this.swipeActive = true;
  }

  onSwipeEnd(taskId: string): void {
    if (this.swipeActive) this.onComplete(taskId);
    this.swipeActive = false;
  }

  onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    this.pointerTracking = true;
    this.pointerStartY = event.clientY;
    this.pointerDeltaY = 0;
    this.pointerId = event.pointerId;
  }

  onPointerMove(event: PointerEvent): void {
    if (!this.pointerTracking || this.pointerId !== event.pointerId) return;
    this.pointerDeltaY = this.pointerStartY - event.clientY;
  }

  onPointerUp(taskId: string): void {
    if (!this.pointerTracking) return;
    if (this.pointerDeltaY > 70) {
      this.onComplete(taskId);
    }
    this.onPointerCancel();
  }

  onPointerCancel(): void {
    this.pointerTracking = false;
    this.pointerDeltaY = 0;
    this.pointerStartY = 0;
    this.pointerId = null;
  }

  toggleWaitPresets(taskId: string): void {
    this.waitPresetTaskId.update(current => (current === taskId ? null : taskId));
  }

  closeWaitPresets(): void {
    this.waitPresetTaskId.set(null);
  }

  isWaitPresetVisible(taskId: string): boolean {
    return this.waitPresetTaskId() === taskId;
  }

  /** ARCH-H1 fix: 委托给共享工具函数，保持全局显示一致 */
  formatTime(minutes: number): string {
    return formatDockMinutes(minutes);
  }

  private snapshotStableEntries(): DockEntry[] {
    return this.renderCards()
      .filter(card => card.transient === 'stable')
      .map(card => card.entry);
  }

  private applyMotionBatch(
    batch: ConsoleCardMotionBatch,
    afterSettle?: () => void,
  ): void {
    if (batch.motions.length === 0) {
      this.renderCards.set(batch.renderCards);
      this.motionStateMap.set({});
      afterSettle?.();
      return;
    }

    this.renderCards.set(batch.renderCards);
    this.motionStateMap.set(createConsoleMotionMap(batch.motions));
    this.lockInteractions(batch.durationMs);
    const batchToken = ++this.motionBatchCounter;

    this.clearMotionTimer();
    this.motionTimer = setTimeout(() => {
      if (batchToken !== this.motionBatchCounter) return;
      this.motionStateMap.set({});
      this.renderCards.set(createStableConsoleRenderCards(this.stackEntries()));
      afterSettle?.();
      this.motionTimer = null;
    }, batch.durationMs);
  }

  private nextBatchKey(kind: string): string {
    this.motionBatchCounter += 1;
    return `${kind}-${this.motionBatchCounter}`;
  }

  private clearMotionTimer(): void {
    if (!this.motionTimer) return;
    clearTimeout(this.motionTimer);
    this.motionTimer = null;
  }

  private readViewportSize(): { width: number; height: number } {
    if (typeof window === 'undefined') {
      return {
        width: PARKING_CONFIG.CONSOLE_CARD_WIDTH + 64,
        height: PARKING_CONFIG.CONSOLE_CARD_HEIGHT + 360,
      };
    }

    return {
      width: window.innerWidth,
      height: window.innerHeight,
    };
  }

  private lockInteractions(durationMs: number): void {
    this.interactionLocked.set(true);
    if (this.interactionLockTimer) {
      clearTimeout(this.interactionLockTimer);
    }
    this.interactionLockTimer = setTimeout(() => {
      this.interactionLocked.set(false);
      this.interactionLockTimer = null;
    }, durationMs + 40);
  }
}
