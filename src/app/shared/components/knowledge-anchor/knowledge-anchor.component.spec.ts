import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal, type WritableSignal } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LoggerService } from '../../../../services/logger.service';
import type { ExternalSourceLink } from '../../../core/external-sources/external-source.model';
import { ExternalSourceLinkService } from '../../../core/external-sources/external-source-link.service';
import { SiyuanPreviewService } from '../../../core/external-sources/siyuan/siyuan-preview.service';
import { KnowledgeAnchorComponent } from './knowledge-anchor.component';

describe('KnowledgeAnchorComponent', () => {
  const link: ExternalSourceLink = {
    id: 'link-1',
    taskId: 'task-1',
    sourceType: 'siyuan-block',
    targetId: '20260426123456-abc1234',
    uri: 'siyuan://blocks/20260426123456-abc1234?focus=1',
    label: '思源 abc1234',
    sortOrder: 0,
    deletedAt: null,
    createdAt: '2026-05-18T00:00:00.000Z',
    updatedAt: '2026-05-18T00:00:00.000Z',
  };

  let fixture: ComponentFixture<KnowledgeAnchorComponent>;
  let openLink: ReturnType<typeof vi.fn>;
  let preview: ReturnType<typeof vi.fn>;
  let previewModeInput: WritableSignal<'full' | 'deep-link-only'>;

  beforeEach(async () => {
    openLink = vi.fn();
    preview = vi.fn().mockResolvedValue({
      status: 'ready',
      preview: {
        linkId: link.id,
        blockId: link.targetId,
        excerpt: 'preview text',
        fetchedAt: '2026-05-18T00:00:00.000Z',
        fetchStatus: 'ready',
      },
    });

    await TestBed.configureTestingModule({
      imports: [KnowledgeAnchorComponent],
      providers: [
        {
          provide: ExternalSourceLinkService,
          useValue: {
            links: signal(0),
            activeLinksForTask: vi.fn().mockReturnValue([link]),
            bindSiyuanBlock: vi.fn(),
            openLink,
            removeLink: vi.fn().mockResolvedValue(undefined),
          },
        },
        { provide: SiyuanPreviewService, useValue: { preview, abortActive: vi.fn() } },
        { provide: LoggerService, useValue: { category: () => ({ debug: vi.fn(), warn: vi.fn() }) } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(KnowledgeAnchorComponent);
    previewModeInput = signal<'full' | 'deep-link-only'>('full');
    Object.assign(fixture.componentInstance as unknown as Record<string, unknown>, {
      taskId: signal('task-1'),
      isMobile: signal(true),
      editable: signal(false),
      compact: signal(false),
      previewMode: previewModeInput,
    });
    fixture.detectChanges();
  });

  it('uses deep-link-only mode without opening the mobile preview sheet', () => {
    previewModeInput.set('deep-link-only');
    fixture.detectChanges();

    const chip = fixture.nativeElement.querySelector('[data-testid="knowledge-anchor-chip"]') as HTMLButtonElement;
    chip.click();
    fixture.detectChanges();

    expect(openLink).toHaveBeenCalledWith(link);
    expect(preview).not.toHaveBeenCalled();
    expect(fixture.nativeElement.querySelector('[data-testid="knowledge-anchor-sheet"]')).toBeNull();
  });

  it('opens a mobile action menu after long press and suppresses the follow-up chip click', () => {
    vi.useFakeTimers();
    try {
      const chip = fixture.nativeElement.querySelector('[data-testid="knowledge-anchor-chip"]') as HTMLButtonElement;
      fixture.componentInstance.onPointerDown({
        pointerType: 'touch',
        clientX: 10,
        clientY: 10,
        currentTarget: chip,
      } as unknown as PointerEvent, link);

      vi.advanceTimersByTime(450);
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('[data-testid="knowledge-anchor-action-menu"]')).not.toBeNull();

      const preventDefault = vi.fn();
      fixture.componentInstance.onChipClick({
        stopPropagation: vi.fn(),
        preventDefault,
      } as unknown as Event, link);

      expect(preventDefault).toHaveBeenCalled();
      expect(openLink).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels mobile long press when the pointer moves beyond tolerance', () => {
    vi.useFakeTimers();
    try {
      const chip = fixture.nativeElement.querySelector('[data-testid="knowledge-anchor-chip"]') as HTMLButtonElement;
      fixture.componentInstance.onPointerDown({
        pointerType: 'touch',
        clientX: 10,
        clientY: 10,
        currentTarget: chip,
      } as unknown as PointerEvent, link);
      fixture.componentInstance.onPointerMove({ clientX: 30, clientY: 10 } as PointerEvent);

      vi.advanceTimersByTime(450);
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('[data-testid="knowledge-anchor-action-menu"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});