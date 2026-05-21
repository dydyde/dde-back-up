import { DestroyRef, Injectable, inject } from '@angular/core';
import { Overlay, OverlayRef, type ConnectedPosition, type FlexibleConnectedPositionStrategyOrigin } from '@angular/cdk/overlay';
import { ComponentPortal } from '@angular/cdk/portal';
import { SIYUAN_CONFIG } from '../../../../config/siyuan.config';
import type { ExternalSourceLink } from '../../../core/external-sources/external-source.model';
import { SiyuanPreviewService } from '../../../core/external-sources/siyuan/siyuan-preview.service';
import { KnowledgeAnchorPopoverComponent } from './knowledge-anchor-popover.component';

type PopoverOrigin = FlexibleConnectedPositionStrategyOrigin;

@Injectable({ providedIn: 'root' })
export class KnowledgeAnchorPopoverService {
  private readonly overlay = inject(Overlay);
  private readonly previewService = inject(SiyuanPreviewService);
  private overlayRef?: OverlayRef;
  private originRef?: HTMLElement;
  private openTimer?: ReturnType<typeof setTimeout>;
  private closeTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    // 单例 service 在 root 注入器销毁时（HMR/SSR teardown）一并 dispose 掉 OverlayRef，避免内存与 DOM 泄漏。
    inject(DestroyRef).onDestroy(() => this.dispose());
  }

  readonly positions: ConnectedPosition[] = [
    { originX: 'start', originY: 'bottom', overlayX: 'start', overlayY: 'top', offsetY: 8 },
    { originX: 'start', originY: 'top', overlayX: 'start', overlayY: 'bottom', offsetY: -8 },
    { originX: 'end', originY: 'center', overlayX: 'start', overlayY: 'center', offsetX: 8 },
    { originX: 'start', originY: 'center', overlayX: 'end', overlayY: 'center', offsetX: -8 },
  ];

  scheduleOpen(link: ExternalSourceLink, origin: PopoverOrigin): void {
    this.cancelClose();
    this.cancelOpen();
    this.openTimer = setTimeout(() => this.open(link, origin), SIYUAN_CONFIG.HOVER_OPEN_DELAY_MS);
  }

  openNow(link: ExternalSourceLink, origin: PopoverOrigin): void {
    this.cancelClose();
    this.cancelOpen();
    this.open(link, origin);
  }

  scheduleClose(): void {
    this.cancelOpen();
    this.cancelClose();
    this.closeTimer = setTimeout(() => this.close(), SIYUAN_CONFIG.HOVER_CLOSE_GRACE_MS);
  }

  keepOpen(): void {
    this.cancelClose();
  }

  close(options: { restoreFocus?: boolean } = {}): void {
    this.cancelOpen();
    this.cancelClose();
    this.previewService.abortActive();
    this.overlayRef?.detach();
    if (options.restoreFocus && this.originRef instanceof HTMLElement) {
      this.originRef.focus();
    }
    this.originRef = undefined;
  }

  closeForHost(host: HTMLElement): void {
    if (!this.originRef || !host.contains(this.originRef)) return;
    this.close();
  }

  dispose(): void {
    this.close();
    this.overlayRef?.dispose();
    this.overlayRef = undefined;
  }

  private open(link: ExternalSourceLink, origin: PopoverOrigin): void {
    this.originRef = origin instanceof HTMLElement ? origin : undefined;
    const positionStrategy = this.overlay.position()
      .flexibleConnectedTo(origin)
      .withPositions(this.positions)
      .withPush(true)
      .withViewportMargin(8);

    if (!this.overlayRef) {
      this.overlayRef = this.overlay.create({
        positionStrategy,
        scrollStrategy: this.overlay.scrollStrategies.reposition(),
        hasBackdrop: false,
        panelClass: 'knowledge-anchor-overlay-panel',
      });
      this.overlayRef.keydownEvents().subscribe(event => {
        if (event.key === 'Escape') this.close({ restoreFocus: true });
      });
    } else {
      this.overlayRef.updatePositionStrategy(positionStrategy);
      this.overlayRef.detach();
    }

    const componentRef = this.overlayRef.attach(new ComponentPortal(KnowledgeAnchorPopoverComponent));
    componentRef.setInput('link', link);
    componentRef.instance.hoverInside.subscribe(() => this.keepOpen());
    componentRef.instance.hoverOutside.subscribe(() => this.scheduleClose());
    componentRef.instance.closeRequested.subscribe(() => this.close());
  }

  private cancelOpen(): void {
    if (!this.openTimer) return;
    clearTimeout(this.openTimer);
    this.openTimer = undefined;
  }

  private cancelClose(): void {
    if (!this.closeTimer) return;
    clearTimeout(this.closeTimer);
    this.closeTimer = undefined;
  }
}
