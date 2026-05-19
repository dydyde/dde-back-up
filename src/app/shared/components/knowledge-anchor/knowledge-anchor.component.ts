import { ChangeDetectionStrategy, Component, ElementRef, EnvironmentInjector, HostListener, OnDestroy, computed, inject, input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { A11yModule } from '@angular/cdk/a11y';
import { SIYUAN_ERROR_MESSAGES } from '../../../../config/siyuan.config';
import { LoggerService } from '../../../../services/logger.service';
import type { ExternalSourceLink, SiyuanPreviewResult } from '../../../core/external-sources/external-source.model';
import { ExternalSourceLinkService } from '../../../core/external-sources/external-source-link.service';
import { SiyuanPreviewService } from '../../../core/external-sources/siyuan/siyuan-preview.service';
import { shortenSiyuanBlockId } from '../../../core/external-sources/siyuan/siyuan-link-parser';
import type { KnowledgeAnchorPopoverService } from './knowledge-anchor-popover.service';

const SHEET_PREVIEW_FALLBACK: SiyuanPreviewResult = { status: 'error', errorCode: 'unknown' };
const LONG_PRESS_DELAY_MS = 450;
const LONG_PRESS_MOVE_TOLERANCE_PX = 8;

type KnowledgeAnchorPreviewMode = 'full' | 'deep-link-only';

/**
 * 懒加载 popover service：CDK Overlay + ConnectedPositionStrategy 仅在桌面端 hover/focus 时需要，
 * 移动端只用底部 sheet（无 overlay）。通过动态 import + EnvironmentInjector.get 把 Overlay 相关
 * 字节移出初始 bundle。模块 promise 全局缓存，多实例共享同一份下载；导入失败时清除缓存以便后续 hover 重试。
 */
let popoverModulePromise: Promise<typeof import('./knowledge-anchor-popover.service')> | null = null;
function loadPopoverModule(): Promise<typeof import('./knowledge-anchor-popover.service')> {
  popoverModulePromise ??= import('./knowledge-anchor-popover.service').catch((error) => {
    popoverModulePromise = null;
    throw error;
  });
  return popoverModulePromise;
}

@Component({
  selector: 'app-knowledge-anchor',
  standalone: true,
  imports: [CommonModule, FormsModule, A11yModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="knowledge-anchor" [class.knowledge-anchor--compact]="compact()">
      @if (firstLink(); as link) {
        <button
          type="button"
          data-testid="knowledge-anchor-chip"
          class="knowledge-anchor-chip"
          [attr.aria-label]="'思源锚点：' + displayLabel(link)"
          (mouseenter)="onMouseEnter($event, link)"
          (mouseleave)="onMouseLeave()"
          (focus)="onFocus($event, link)"
          (blur)="onMouseLeave()"
          (contextmenu)="onContextMenu($event, link)"
          (pointerdown)="onPointerDown($event, link)"
          (pointermove)="onPointerMove($event)"
          (pointerup)="onPointerEnd()"
          (pointercancel)="onPointerEnd()"
          (click)="onChipClick($event, link)">
          <span aria-hidden="true">📎</span>
          <span class="truncate">思源 {{ displayLabel(link) }}</span>
        </button>
      }

      @if (editable()) {
        <form class="mt-1 flex gap-1" (submit)="bind($event)">
          <input
            name="siyuanLink"
            [(ngModel)]="pendingInput"
            data-testid="knowledge-anchor-input"
            class="min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-600 outline-none focus:border-indigo-400 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-200"
            placeholder="粘贴思源块链接" />
          <button type="submit" class="rounded-md bg-indigo-600 px-2 py-1 text-[10px] font-bold text-white hover:bg-indigo-500">关联</button>
        </form>
      }

      @if (sheetOpen() && activeLink(); as link) {
        <div class="fixed inset-0 z-[60] bg-black/30" aria-hidden="true" (click)="closeSheet()"></div>
        <section
          role="dialog"
          aria-modal="true"
          aria-labelledby="knowledge-anchor-sheet-title"
          cdkTrapFocus
          cdkTrapFocusAutoCapture
          class="fixed inset-x-0 bottom-0 z-[61] max-h-[70vh] rounded-t-2xl border-t border-slate-200 bg-white p-4 shadow-2xl dark:border-stone-700 dark:bg-stone-900"
          data-testid="knowledge-anchor-sheet">
          <div class="mx-auto mb-3 h-1 w-10 rounded-full bg-slate-200 dark:bg-stone-700" aria-hidden="true"></div>
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <div id="knowledge-anchor-sheet-title" class="text-sm font-bold text-slate-800 dark:text-stone-100">思源上下文</div>
              <div class="truncate text-[11px] text-slate-500 dark:text-stone-400">{{ displayLabel(link) }}</div>
            </div>
            <button type="button" class="text-xs text-slate-400" aria-label="关闭思源上下文" (click)="closeSheet()">关闭</button>
          </div>
          <div class="mt-3 max-h-[42vh] overflow-y-auto text-xs text-slate-600 dark:text-stone-300">
            @if (sheetResult().status === 'loading') {
              <div>正在读取思源块…</div>
            } @else {
              @if (sheetResult().preview; as preview) {
                <p class="whitespace-pre-wrap">{{ preview.excerpt || preview.plainText || '该块暂无可预览文本' }}</p>
                @if (preview.childBlocks?.length) {
                  <ul class="mt-2 list-disc pl-4">
                    @for (child of preview.childBlocks; track child.id) { <li>{{ child.content }}</li> }
                  </ul>
                }
                @if (preview.truncated) { <div class="mt-2 text-[10px] text-slate-400">更多内容请打开思源</div> }
              } @else {
                <div class="rounded-lg bg-slate-50 p-2 text-slate-500 dark:bg-stone-800 dark:text-stone-400">{{ sheetErrorMessage() }}</div>
              }
            }
          </div>
          <div class="mt-4 grid grid-cols-3 gap-2">
            <button type="button" class="sheet-action" (click)="open(link)">打开思源</button>
            <button type="button" class="sheet-action" (click)="refreshSheet(link)">刷新缓存</button>
            @if (editable()) { <button type="button" class="sheet-action sheet-action-danger" (click)="remove(link)">解除关联</button> }
          </div>
        </section>
      }

      @if (actionMenuOpen() && menuLink(); as link) {
        <div class="fixed inset-0 z-[62] bg-black/20" aria-hidden="true" (click)="closeActionMenu()"></div>
        <section
          role="dialog"
          aria-modal="true"
          aria-label="思源锚点操作"
          class="fixed inset-x-4 bottom-4 z-[63] rounded-xl border border-slate-200 bg-white p-2 shadow-2xl dark:border-stone-700 dark:bg-stone-900"
          data-testid="knowledge-anchor-action-menu">
          @if (previewMode() === 'full') {
            <button type="button" class="menu-action" (click)="previewFromMenu(link)">预览</button>
          }
          <button type="button" class="menu-action" (click)="openFromMenu(link)">打开思源</button>
          @if (previewMode() === 'full') {
            <button type="button" class="menu-action" (click)="refreshFromMenu(link)">刷新缓存</button>
          }
          @if (editable()) {
            <button type="button" class="menu-action menu-action-danger" (click)="removeFromMenu(link)">解除关联</button>
          }
        </section>
      }
    </div>
  `,
  styles: [`
    .knowledge-anchor-chip { display: inline-flex; max-width: 100%; align-items: center; gap: 0.25rem; border-radius: 999px; border: 1px solid rgba(99,102,241,.18); background: rgba(99,102,241,.06); padding: .18rem .45rem; font-size: 10px; color: rgb(79 70 229); transition: box-shadow .15s ease, border-color .15s ease, background .15s ease; }
    .knowledge-anchor-chip:hover, .knowledge-anchor-chip:focus-visible { border-color: rgba(99,102,241,.45); background: rgba(99,102,241,.1); box-shadow: 0 4px 14px rgba(79,70,229,.12); outline: none; }
    :host-context(.dark) .knowledge-anchor-chip { color: rgb(165 180 252); background: rgba(99,102,241,.14); border-color: rgba(129,140,248,.25); }
    .knowledge-anchor--compact .knowledge-anchor-chip { padding: .12rem .35rem; font-size: 9px; }
    .sheet-action { border-radius: .6rem; border: 1px solid rgb(226 232 240); padding: .5rem .25rem; font-size: 11px; font-weight: 700; color: rgb(71 85 105); }
    .sheet-action-danger { color: rgb(225 29 72); }
    .menu-action { display: block; width: 100%; border-radius: .625rem; padding: .7rem .85rem; text-align: left; font-size: 13px; font-weight: 700; color: rgb(51 65 85); }
    .menu-action:hover, .menu-action:focus-visible { background: rgb(248 250 252); outline: none; }
    :host-context(.dark) .menu-action { color: rgb(231 229 228); }
    :host-context(.dark) .menu-action:hover, :host-context(.dark) .menu-action:focus-visible { background: rgb(41 37 36); }
    .menu-action-danger { color: rgb(225 29 72); }
  `],
})
export class KnowledgeAnchorComponent implements OnDestroy {
  private readonly linkService = inject(ExternalSourceLinkService);
  private readonly previewService = inject(SiyuanPreviewService);
  private readonly logger = inject(LoggerService).category('KnowledgeAnchor');
  private readonly envInjector = inject(EnvironmentInjector);
  private readonly host = inject(ElementRef<HTMLElement>);

  readonly taskId = input.required<string>();
  readonly isMobile = input(false);
  readonly editable = input(false);
  readonly compact = input(false);
  readonly previewMode = input<KnowledgeAnchorPreviewMode>('full');
  readonly linksVersion = this.linkService.links;
  readonly links = computed(() => {
    this.linksVersion();
    return this.linkService.activeLinksForTask(this.taskId());
  });
  readonly firstLink = computed(() => this.links()[0] ?? null);
  readonly sheetOpen = signal(false);
  readonly activeLink = signal<ExternalSourceLink | null>(null);
  readonly sheetResult = signal<SiyuanPreviewResult>({ status: 'loading' });
  readonly actionMenuOpen = signal(false);
  readonly menuLink = signal<ExternalSourceLink | null>(null);
  pendingInput = '';
  /**
   * 触发底部 sheet 的元素引用，关闭后将焦点 restore 回原位，符合 dialog/aria-modal 规范。
   * cdkTrapFocusAutoCapture 也能恢复焦点，但当用户中途切换 chip 时，这个手动引用更稳。
   */
  private originChip: HTMLElement | null = null;
  private menuOriginChip: HTMLElement | null = null;
  private longPressTimer: ReturnType<typeof setTimeout> | null = null;
  private longPressStart: { x: number; y: number; link: ExternalSourceLink; origin: HTMLElement | null } | null = null;
  private suppressNextClick = false;
  /**
   * 已加载的 popover service 实例缓存。仅在 ngOnDestroy 时触发清理时短路使用，
   * 不主动 await 以避免 destroy 阻塞。
   */
  private popoverInstance: KnowledgeAnchorPopoverService | null = null;

  ngOnDestroy(): void {
    this.cancelLongPress();
    // popover 仅在桌面 hover 路径加载，未加载即未使用，无需清理。
    this.popoverInstance?.closeForHost(this.host.nativeElement);
    this.previewService.abortActive();
  }

  /**
   * sheetOpen 时全局拦截 Esc：dialog 内 cdkTrapFocus 已限制 Tab，但点击 backdrop 后焦点
   * 可能落到 body，document 级别监听确保 Esc 在任意情况下都能关闭。
   */
  @HostListener('document:keydown.escape')
  onDocumentEscape(): void {
    if (this.actionMenuOpen()) {
      this.closeActionMenu();
      return;
    }
    if (this.sheetOpen()) this.closeSheet();
  }

  async bind(event: Event): Promise<void> {
    event.preventDefault();
    const input = this.pendingInput.trim();
    if (!input) return;
    const link = await this.linkService.bindSiyuanBlock(this.taskId(), input);
    if (link) this.pendingInput = '';
  }

  onMouseEnter(event: MouseEvent, link: ExternalSourceLink): void {
    if (this.isMobile() || this.previewMode() === 'deep-link-only') return;
    void this.withPopover((p) => p.scheduleOpen(link, event.currentTarget as HTMLElement))
      .catch((error) => {
        this.previewService.abortActive();
        this.logger.debug('桌面预览浮层加载失败（mouseenter）', {
          linkId: link.id,
          message: error instanceof Error ? error.message : 'unknown',
        });
      });
  }

  onFocus(event: FocusEvent, link: ExternalSourceLink): void {
    if (this.isMobile() || this.previewMode() === 'deep-link-only') return;
    void this.withPopover((p) => p.scheduleOpen(link, event.currentTarget as HTMLElement))
      .catch((error) => {
        this.previewService.abortActive();
        this.logger.debug('桌面预览浮层加载失败（focus）', {
          linkId: link.id,
          message: error instanceof Error ? error.message : 'unknown',
        });
      });
  }

  onMouseLeave(): void {
    if (this.isMobile()) return;
    // popover 未加载意味着从未打开过，直接忽略 leave；避免无谓地拉起 chunk。
    this.popoverInstance?.scheduleClose();
  }

  onChipClick(event: Event, link: ExternalSourceLink): void {
    event.stopPropagation();
    if (this.suppressNextClick) {
      event.preventDefault();
      this.suppressNextClick = false;
      return;
    }
    if (this.previewMode() === 'deep-link-only') {
      this.open(link);
      return;
    }
    if (this.isMobile()) {
      this.openSheet(link, event.currentTarget as HTMLElement);
      return;
    }
    this.open(link);
  }

  onContextMenu(event: MouseEvent, link: ExternalSourceLink): void {
    if (!this.isMobile()) return;
    event.preventDefault();
    event.stopPropagation();
    this.cancelLongPress();
    this.openActionMenu(link, event.currentTarget as HTMLElement);
  }

  onPointerDown(event: PointerEvent, link: ExternalSourceLink): void {
    if (!this.isMobile() || event.pointerType === 'mouse') return;
    this.cancelLongPress();
    const origin = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    this.longPressStart = { x: event.clientX, y: event.clientY, link, origin };
    this.longPressTimer = setTimeout(() => {
      const start = this.longPressStart;
      if (!start) return;
      this.suppressNextClick = true;
      this.openActionMenu(start.link, start.origin);
      this.cancelLongPress();
    }, LONG_PRESS_DELAY_MS);
  }

  onPointerMove(event: PointerEvent): void {
    if (!this.longPressStart) return;
    const distanceX = Math.abs(event.clientX - this.longPressStart.x);
    const distanceY = Math.abs(event.clientY - this.longPressStart.y);
    if (distanceX > LONG_PRESS_MOVE_TOLERANCE_PX || distanceY > LONG_PRESS_MOVE_TOLERANCE_PX) {
      this.cancelLongPress();
    }
  }

  onPointerEnd(): void {
    this.cancelLongPress();
  }

  open(link: ExternalSourceLink): void {
    this.linkService.openLink(link);
  }

  async remove(link: ExternalSourceLink): Promise<void> {
    await this.linkService.removeLink(link.id);
    this.closeSheet();
  }

  displayLabel(link: ExternalSourceLink): string {
    return link.hpath || link.label || shortenSiyuanBlockId(link.targetId);
  }

  closeSheet(): void {
    this.sheetOpen.set(false);
    this.activeLink.set(null);
    this.previewService.abortActive();
    if (this.originChip instanceof HTMLElement && this.originChip.isConnected) {
      this.originChip.focus();
    }
    this.originChip = null;
  }

  closeActionMenu(): void {
    this.actionMenuOpen.set(false);
    this.menuLink.set(null);
    if (this.menuOriginChip instanceof HTMLElement && this.menuOriginChip.isConnected) {
      this.menuOriginChip.focus();
    }
    this.menuOriginChip = null;
  }

  async refreshSheet(link: ExternalSourceLink): Promise<void> {
    this.sheetResult.set({ status: 'loading' });
    try {
      this.sheetResult.set(await this.previewService.preview(link, { forceRefresh: true }));
    } catch (error) {
      this.logger.warn('移动端思源预览刷新失败，降级为安全错误态', {
        linkId: link.id,
        message: error instanceof Error ? error.message : 'unknown',
      });
      this.sheetResult.set(SHEET_PREVIEW_FALLBACK);
    }
  }

  sheetErrorMessage(): string {
    const code = this.sheetResult().errorCode ?? 'extension-unavailable';
    return SIYUAN_ERROR_MESSAGES[code] ?? SIYUAN_ERROR_MESSAGES.unknown;
  }

  previewFromMenu(link: ExternalSourceLink): void {
    const origin = this.menuOriginChip ?? undefined;
    this.closeActionMenu();
    this.openSheet(link, origin);
  }

  openFromMenu(link: ExternalSourceLink): void {
    this.closeActionMenu();
    this.open(link);
  }

  refreshFromMenu(link: ExternalSourceLink): void {
    const origin = this.menuOriginChip ?? undefined;
    this.closeActionMenu();
    this.openSheet(link, origin, true);
  }

  async removeFromMenu(link: ExternalSourceLink): Promise<void> {
    this.closeActionMenu();
    await this.remove(link);
  }

  private openSheet(link: ExternalSourceLink, origin?: HTMLElement, forceRefresh = false): void {
    this.originChip = origin ?? null;
    this.activeLink.set(link);
    this.sheetOpen.set(true);
    this.sheetResult.set({ status: 'loading' });
    void this.previewService.preview(link, { forceRefresh })
      .then(result => {
        if (this.activeLink()?.id === link.id) this.sheetResult.set(result);
      })
      .catch(() => {
        if (this.activeLink()?.id === link.id) this.sheetResult.set(SHEET_PREVIEW_FALLBACK);
      });
  }

  private openActionMenu(link: ExternalSourceLink, origin?: HTMLElement | null): void {
    this.closeSheet();
    this.menuOriginChip = origin ?? null;
    this.menuLink.set(link);
    this.actionMenuOpen.set(true);
  }

  private cancelLongPress(): void {
    if (this.longPressTimer) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
    this.longPressStart = null;
  }

  /**
   * 懒解析 popover service：首次 hover/focus 触发 dynamic import，后续复用缓存实例。
   * 通过 EnvironmentInjector.get 复用 root 注入器（service 仍是 providedIn: 'root' 单例），
   * 避免 ManualBootstrapping 或 createEnvironmentInjector 的额外开销。
   */
  private async withPopover(action: (popover: KnowledgeAnchorPopoverService) => void): Promise<void> {
    if (this.popoverInstance) {
      action(this.popoverInstance);
      return;
    }
    const mod = await loadPopoverModule();
    this.popoverInstance ??= this.envInjector.get(mod.KnowledgeAnchorPopoverService);
    action(this.popoverInstance);
  }
}
