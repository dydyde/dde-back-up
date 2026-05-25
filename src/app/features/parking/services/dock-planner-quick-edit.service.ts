import { Injectable, OnDestroy, computed, inject, signal } from '@angular/core';
import { DockEngineService } from '../../../../services/dock-engine.service';
import { UiStateService } from '../../../../services/ui-state.service';
import { CognitiveLoad } from '../../../../models/parking-dock';
import type { DockPlannerQuickEditPresentation } from '../components/dock-planner-quick-edit.component';

/**
 * Manages the planner quick-edit panel state, computeds, and mutation
 * methods that were previously inlined in ParkingDockComponent.
 *
 * Provided at the component level (not root) so each dock instance
 * gets its own planner state.
 */
@Injectable()
export class DockPlannerQuickEditService implements OnDestroy {
  private readonly engine = inject(DockEngineService);
  private readonly uiState = inject(UiStateService);

  // ── Presets (constants) ─────────────────────────────────────
  readonly expectedPresets = [15, 30, 45, 60, 90, 120];
  readonly waitPresets = [5, 10, 15, 30, 45, 60];

  // ── Signals ─────────────────────────────────────────────────
  readonly plannerQuickEditTaskId = signal<string | null>(null);
  readonly recentlyDockedTaskId = signal<string | null>(null);

  // ── Computeds ───────────────────────────────────────────────

  /** Mobile shows bottom sheet; desktop shows popover */
  readonly presentation = computed<DockPlannerQuickEditPresentation>(
    () => this.uiState.isMobile() ? 'sheet' : 'popover',
  );

  /** The dock entry that matches the currently-open planner, or null */
  readonly activeEntry = computed(() => {
    const taskId = this.plannerQuickEditTaskId();
    if (!taskId) return null;
    return this.engine.orderedDockEntries().find(entry => entry.taskId === taskId) ?? null;
  });

  /** Whether a bottom-sheet backdrop should be rendered */
  readonly backdropVisible = computed(
    () => this.activeEntry() !== null && this.presentation() === 'sheet',
  );

  /** Number of required fields still missing on the active planner entry */
  readonly missingFieldCount = computed(() => {
    const entry = this.activeEntry();
    if (!entry) return 0;
    let count = 0;
    if (entry.expectedMinutes === null) count += 1;
    return count;
  });

  /**
   * 专注模式背景操作轨激活时为 true（用于 bannerTarget 跟随前台任务）
   */
  private readonly dockSecondaryRailActive = computed(
    () => this.engine.focusMode() && this.engine.focusScrimOn(),
  );

  /**
   * 第一个存在必填属性缺失的停泊坞条目（不含 waitMinutes）。
   * 专注模式背景操作轨里，banner 始终跟随当前前台任务，避免"打开编辑"指向旧任务。
   */
  readonly bannerTarget = computed(() => {
    if (this.activeEntry()) return null;
    // 专注 + scrim 时跟随前台 focusing entry
    const focusEntry = this.dockSecondaryRailActive() ? this.engine.focusingEntry() : null;
    if (focusEntry) return focusEntry;
    const entries = this.engine.orderedDockEntries();
    const main = entries.find(e => e.isMain && e.expectedMinutes === null);
    if (main) return main;
    return entries.find(e => e.expectedMinutes === null) ?? null;
  });

  /** Missing-field count for the banner target */
  readonly bannerMissingCount = computed(() => {
    const entry = this.bannerTarget();
    if (!entry) return 0;
    let count = 0;
    if (entry.expectedMinutes === null) count += 1;
    return count;
  });

  /** CSS class string for the planner panel（内联展开，从 banner 原位延伸） */
  readonly panelClasses = computed(() => {
    const presentation = this.presentation();
    return [
      'pointer-events-auto',
      'overflow-y-auto',
      'hide-scrollbar',
      'rounded-2xl',
      'border',
      'border-amber-500/20',
      'bg-slate-950/97',
      'p-3.5',
      'shadow-[0_8px_32px_rgba(2,6,23,0.36)]',
      'backdrop-blur-md',
      'animate-[plannerInlineExpand_300ms_cubic-bezier(0.22,0.61,0.36,1)]',
      presentation === 'popover'
        ? 'mx-2 mt-1 max-h-[min(340px,calc(100dvh-180px))]'
        : 'fixed inset-x-3 bottom-3 z-[70] max-h-[min(72dvh,560px)]',
    ].join(' ');
  });

  // ── Timers ──────────────────────────────────────────────────
  private recentlyDockedTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Public methods ──────────────────────────────────────────

  isPlannerQuickEditOpen(taskId: string): boolean {
    return this.plannerQuickEditTaskId() === taskId;
  }

  togglePlannerQuickEdit(taskId: string): void {
    if (this.plannerQuickEditTaskId() === taskId) {
      this.closePlannerQuickEdit();
      return;
    }
    this.plannerQuickEditTaskId.set(taskId);
    this.engine.setDockExpanded(true, { persistPreference: false });
  }

  closePlannerQuickEdit(): string | null {
    const taskId = this.plannerQuickEditTaskId();
    this.plannerQuickEditTaskId.set(null);
    return taskId;
  }

  setPlannerQuickEditLoad(taskId: string, nextLoad: CognitiveLoad): void {
    const entry = this.engine.orderedDockEntries().find(item => item.taskId === taskId) ?? null;
    if (!entry || entry.load === nextLoad) return;
    this.engine.toggleLoad(taskId, nextLoad === 'high' ? 'up' : 'down');
  }

  setPlannerQuickEditExpected(taskId: string, minutes: number | null): void {
    this.engine.setExpectedTime(taskId, minutes);
  }

  setPlannerQuickEditWait(taskId: string, minutes: number | null): void {
    this.engine.setWaitTime(taskId, minutes);
  }

  markRecentlyDocked(taskId: string): void {
    this.recentlyDockedTaskId.set(taskId);
    if (this.recentlyDockedTimer) {
      clearTimeout(this.recentlyDockedTimer);
    }
    this.recentlyDockedTimer = setTimeout(() => {
      this.recentlyDockedTaskId.set(null);
      this.recentlyDockedTimer = null;
    }, 3000);
    this.plannerQuickEditTaskId.update(current => (current === taskId ? null : current));
  }

  closeIfEntryGone(): void {
    if (!this.plannerQuickEditTaskId()) return;
    if (this.activeEntry()) return;
    this.closePlannerQuickEdit();
  }

  ngOnDestroy(): void {
    if (this.recentlyDockedTimer) clearTimeout(this.recentlyDockedTimer);
  }
}
