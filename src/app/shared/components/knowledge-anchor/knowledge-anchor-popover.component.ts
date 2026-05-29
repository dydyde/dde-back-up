import { ChangeDetectionStrategy, Component, inject, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SIYUAN_CONFIG, SIYUAN_ERROR_MESSAGES } from '../../../../config/siyuan.config';
import { LoggerService } from '../../../../services/logger.service';
import type { ExternalSourceLink, LocalSiyuanPreviewCache, SiyuanPreviewResult } from '../../../core/external-sources/external-source.model';
import { ExternalSourceLinkService } from '../../../core/external-sources/external-source-link.service';
import { SiyuanPreviewService } from '../../../core/external-sources/siyuan/siyuan-preview.service';
import { shortenSiyuanBlockId } from '../../../core/external-sources/siyuan/siyuan-link-parser';

@Component({
  selector: 'app-knowledge-anchor-popover',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section
      class="knowledge-anchor-popover rounded-xl border border-slate-200 bg-white text-slate-700 shadow-xl dark:border-stone-700 dark:bg-stone-900 dark:text-stone-200"
      [style.max-width.px]="maxWidth"
      [style.max-height.px]="maxHeight"
      (mouseenter)="hoverInside.emit()"
      (mouseleave)="hoverOutside.emit()">
      <header class="flex items-start justify-between gap-3 border-b border-slate-100 px-3 pt-2 pb-1.5 dark:border-stone-800">
        <div class="min-w-0">
          <div class="truncate text-[11px] font-bold text-slate-800 dark:text-stone-100" data-testid="knowledge-anchor-popover-title">{{ headerTitle() }}</div>
        </div>
        <div class="flex shrink-0 gap-1">
          <button type="button" class="anchor-popover-action" (click)="open()">打开思源</button>
          <button type="button" class="anchor-popover-action" (click)="load(true)">刷新</button>
        </div>
      </header>

      <div class="max-h-[300px] overflow-y-auto px-3 pt-1.5 pb-2 text-xs leading-relaxed">
        @if (result().status === 'loading') {
          <div class="animate-pulse space-y-2" data-testid="knowledge-anchor-loading">
            <div class="h-3 w-4/5 rounded bg-slate-100 dark:bg-stone-800"></div>
            <div class="h-3 w-3/5 rounded bg-slate-100 dark:bg-stone-800"></div>
          </div>
        } @else {
          @if (result().preview; as preview) {
            @if (result().status === 'cache-only') {
              <div class="mb-2 rounded-md bg-amber-50 px-2 py-1 text-[10px] text-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
                {{ errorMessage() }}，已显示本机缓存
              </div>
            }
            <p class="whitespace-pre-wrap">{{ preview.excerpt || preview.plainText || '该块暂无可预览文本' }}</p>
            @if (preview.childBlocks?.length) {
              <ul class="mt-2 list-disc space-y-1 pl-4 text-[11px] text-slate-500 dark:text-stone-400">
                @for (child of preview.childBlocks; track child.id) {
                  <li>{{ child.content || child.id }}</li>
                }
              </ul>
            }
            @if (preview.truncated) {
              <div class="mt-2 text-[10px] text-slate-400 dark:text-stone-500">更多内容请打开思源</div>
            }
          } @else {
            <div class="rounded-md bg-slate-50 px-2 py-2 text-[11px] text-slate-500 dark:bg-stone-800 dark:text-stone-400" data-testid="knowledge-anchor-error">
              {{ errorMessage() }}。任务仍可继续操作，也可直接打开思源原块。
            </div>
          }

          <div class="mt-2 flex items-end justify-between gap-3 text-[10px] text-slate-400 dark:text-stone-500">
            <div data-testid="knowledge-anchor-linked-at">关联于：{{ link().createdAt | date:'MM/dd HH:mm' }}</div>
            @if (absoluteLocation(); as location) {
              <button
                type="button"
                class="anchor-absolute-location"
                data-testid="knowledge-anchor-absolute-location"
                [title]="location"
                (click)="open()">{{ location }}</button>
            }
          </div>
        }
      </div>
    </section>
  `,
  styles: [`
    .knowledge-anchor-popover { width: min(420px, calc(100vw - 24px)); overflow: hidden; }
    .anchor-popover-action { border-radius: 0.375rem; padding: 0.25rem 0.4rem; font-size: 10px; font-weight: 700; color: rgb(79 70 229); }
    .anchor-popover-action:hover { background: rgba(99, 102, 241, 0.08); }
    .anchor-absolute-location {
      max-width: 52%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      text-align: right;
      color: inherit;
    }
    .anchor-absolute-location:hover { color: rgb(79 70 229); }
  `],
})
export class KnowledgeAnchorPopoverComponent {
  private readonly previewService = inject(SiyuanPreviewService);
  private readonly linkService = inject(ExternalSourceLinkService);
  private readonly logger = inject(LoggerService).category('KnowledgeAnchorPopover');

  readonly link = input.required<ExternalSourceLink>();
  readonly hoverInside = output<void>();
  readonly hoverOutside = output<void>();
  readonly closeRequested = output<void>();
  readonly result = signal<SiyuanPreviewResult>({ status: 'loading' });
  readonly maxWidth = SIYUAN_CONFIG.POPOVER_MAX_WIDTH_PX;
  readonly maxHeight = SIYUAN_CONFIG.POPOVER_MAX_HEIGHT_PX;

  ngOnInit(): void {
    void this.load(false);
  }

  async load(forceRefresh: boolean): Promise<void> {
    this.result.set({ status: 'loading' });
    try {
      const result = await this.previewService.preview(this.link(), { forceRefresh });
      this.result.set(result);
      this.syncResolvedMetadata(result);
    } catch (error) {
      this.logger.warn('桌面思源预览加载失败，降级为安全错误态', {
        linkId: this.link().id,
        message: error instanceof Error ? error.message : 'unknown',
      });
      this.result.set({ status: 'error', errorCode: 'unknown' });
    }
  }

  open(): void {
    this.linkService.openLink(this.link());
    this.closeRequested.emit();
  }

  headerTitle(): string {
    const preview = this.result().preview;
    const link = this.link();
    return this.normalizeText(preview?.title)
      || this.extractHPathTitle(preview?.hpath)
      || this.extractHPathTitle(link.hpath)
      || this.normalizeText(link.label)
      || shortenSiyuanBlockId(link.targetId);
  }

  absoluteLocation(): string | null {
    return this.normalizeText(this.result().preview?.hpath)
      || this.normalizeText(this.link().hpath)
      || null;
  }

  errorMessage(): string {
    const code = this.result().errorCode ?? 'extension-unavailable';
    return SIYUAN_ERROR_MESSAGES[code] ?? SIYUAN_ERROR_MESSAGES.unknown;
  }

  private syncResolvedMetadata(result: SiyuanPreviewResult): void {
    if (result.status !== 'ready' || result.origin !== 'network') {
      return;
    }

    const preview = result.preview;
    if (!preview) return;

    const label = this.normalizeText(preview.title);
    const hpath = this.normalizeText(preview.hpath);
    const currentLink = this.link();
    const patch: Pick<Partial<ExternalSourceLink>, 'label' | 'hpath'> = {};

    if (label && label !== currentLink.label) patch.label = label;
    if (hpath && hpath !== currentLink.hpath) patch.hpath = hpath;
    if (Object.keys(patch).length === 0) return;

    void this.linkService.updateMetadata(currentLink.id, patch).catch((error: unknown) => {
      this.logger.warn('思源预览元数据回写失败，保留当前悬浮展示', {
        linkId: currentLink.id,
        message: error instanceof Error ? error.message : 'unknown',
      });
    });
  }

  private extractHPathTitle(hpath: string | undefined): string | undefined {
    const normalized = this.normalizeText(hpath);
    if (!normalized) return undefined;
    const segments = normalized.split('/').filter(Boolean);
    return segments.at(-1) ?? normalized;
  }

  private normalizeText(value: string | undefined): string | undefined {
    if (typeof value !== 'string') return undefined;
    const text = value.trim();
    return text || undefined;
  }
}
