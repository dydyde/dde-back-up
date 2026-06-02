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
  let bindSiyuanBlock: ReturnType<typeof vi.fn>;
  let openLink: ReturnType<typeof vi.fn>;
  let preview: ReturnType<typeof vi.fn>;
  let removeLink: ReturnType<typeof vi.fn>;
  let replaceSiyuanBlock: ReturnType<typeof vi.fn>;
  let activeLinks: ExternalSourceLink[];
  let editableInput: WritableSignal<boolean>;
  let manageableInput: WritableSignal<boolean>;
  let linksVersion: WritableSignal<number>;
  let previewModeInput: WritableSignal<'full' | 'deep-link-only'>;

  beforeEach(async () => {
    activeLinks = [link];
    bindSiyuanBlock = vi.fn().mockResolvedValue(link);
    openLink = vi.fn();
    removeLink = vi.fn().mockResolvedValue(undefined);
    replaceSiyuanBlock = vi.fn().mockResolvedValue({
      ...link,
      targetId: '20260426123456-def5678',
      uri: 'siyuan://blocks/20260426123456-def5678?focus=1',
    });
    linksVersion = signal(0);
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
            links: linksVersion,
            activeLinksForTask: vi.fn().mockImplementation(() => activeLinks),
            bindSiyuanBlock,
            openLink,
            removeLink,
            replaceSiyuanBlock,
          },
        },
        { provide: SiyuanPreviewService, useValue: { preview, abortActive: vi.fn() } },
        { provide: LoggerService, useValue: { category: () => ({ debug: vi.fn(), warn: vi.fn() }) } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(KnowledgeAnchorComponent);
    editableInput = signal(false);
    manageableInput = signal(false);
    previewModeInput = signal<'full' | 'deep-link-only'>('full');
    Object.assign(fixture.componentInstance as unknown as Record<string, unknown>, {
      taskId: signal('task-1'),
      isMobile: signal(true),
      editable: editableInput,
      manageable: manageableInput,
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

  it('shows task-block edit and delete actions when the anchor is editable', async () => {
    editableInput.set(true);
    fixture.detectChanges();

    const editButton = fixture.nativeElement.querySelector('[data-testid="knowledge-anchor-edit"]') as HTMLButtonElement;
    const removeButton = fixture.nativeElement.querySelector('[data-testid="knowledge-anchor-remove"]') as HTMLButtonElement;

    expect(editButton).not.toBeNull();
    expect(removeButton).not.toBeNull();

    removeButton.click();
    await fixture.whenStable();

    expect(removeLink).toHaveBeenCalledWith(link.id);
  });

  it('shows every active anchor with management actions only when editable', () => {
    activeLinks = [
      link,
      {
        ...link,
        id: 'link-2',
        targetId: '20260426123456-def5678',
        uri: 'siyuan://blocks/20260426123456-def5678?focus=1',
        label: '思源 def5678',
        sortOrder: 1,
      },
    ];
    linksVersion.set(1);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelectorAll('[data-testid="knowledge-anchor-chip"]')).toHaveLength(1);

    editableInput.set(true);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelectorAll('[data-testid="knowledge-anchor-chip"]')).toHaveLength(2);
    expect(fixture.nativeElement.querySelectorAll('[data-testid="knowledge-anchor-edit"]')).toHaveLength(2);
    expect(fixture.nativeElement.querySelectorAll('[data-testid="knowledge-anchor-remove"]')).toHaveLength(2);
  });

  it('allows preview management without exposing the add-link form', async () => {
    manageableInput.set(true);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="knowledge-anchor-edit"]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="knowledge-anchor-remove"]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="knowledge-anchor-input"]')).toBeNull();

    const editButton = fixture.nativeElement.querySelector('[data-testid="knowledge-anchor-edit"]') as HTMLButtonElement;
    editButton.click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="knowledge-anchor-input"]')).not.toBeNull();
  });

  it('keeps the editable form as an add-link path until edit mode is selected', async () => {
    editableInput.set(true);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const input = fixture.nativeElement.querySelector('[data-testid="knowledge-anchor-input"]') as HTMLInputElement;
    input.value = '20260426123456-ghi9012';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const submitButton = input.form?.querySelector('button[type="submit"]') as HTMLButtonElement | null;
    submitButton?.click();
    await fixture.whenStable();

    expect(bindSiyuanBlock).toHaveBeenCalledWith('task-1', '20260426123456-ghi9012');
    expect(replaceSiyuanBlock).not.toHaveBeenCalled();
  });

  it('replaces the current visible SiYuan link instead of adding a hidden second link', async () => {
    editableInput.set(true);
    fixture.detectChanges();

    const editButton = fixture.nativeElement.querySelector('[data-testid="knowledge-anchor-edit"]') as HTMLButtonElement;
    editButton.click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const input = fixture.nativeElement.querySelector('[data-testid="knowledge-anchor-input"]') as HTMLInputElement;
    expect(input.value).toBe(link.uri);
    input.value = '20260426123456-def5678';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const submitButton = input.form?.querySelector('button[type="submit"]') as HTMLButtonElement | null;
    submitButton?.click();
    await fixture.whenStable();

    expect(replaceSiyuanBlock).toHaveBeenCalledWith(link.id, '20260426123456-def5678');
    expect(bindSiyuanBlock).not.toHaveBeenCalled();
  });
});