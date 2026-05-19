import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LoggerService } from '../../../../services/logger.service';
import { ExternalSourceCacheService } from '../external-source-cache.service';
import type { ExternalSourceLink, LocalSiyuanPreviewCache } from '../external-source.model';
import { SiyuanDirectProvider } from './siyuan-direct-provider';
import { SiyuanExtensionProvider } from './siyuan-extension-provider';
import { SiyuanPreviewService } from './siyuan-preview.service';

describe('SiyuanPreviewService', () => {
  const link: ExternalSourceLink = {
    id: 'link-1',
    taskId: 'task-1',
    sourceType: 'siyuan-block',
    targetId: '20260426123456-abc1234',
    uri: 'siyuan://blocks/20260426123456-abc1234?focus=1',
    sortOrder: 0,
    deletedAt: null,
    createdAt: '2026-05-18T00:00:00.000Z',
    updatedAt: '2026-05-18T00:00:00.000Z',
  };

  let cachedPreview: LocalSiyuanPreviewCache | null;
  let savePreview: ReturnType<typeof vi.fn>;
  let getBlockPreview: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    cachedPreview = null;
    savePreview = vi.fn().mockResolvedValue(undefined);
    getBlockPreview = vi.fn().mockResolvedValue({
      blockId: link.targetId,
      plainText: 'preview text',
      excerpt: 'preview text',
      truncated: false,
    });

    TestBed.configureTestingModule({
      providers: [
        SiyuanPreviewService,
        {
          provide: ExternalSourceCacheService,
          useValue: {
            ownerId: () => 'user-1',
            loadConfig: vi.fn().mockResolvedValue({ runtimeMode: 'extension-relay' }),
            getPreview: vi.fn().mockImplementation(() => Promise.resolve(cachedPreview)),
            savePreview,
          },
        },
        {
          provide: SiyuanExtensionProvider,
          useValue: {
            isAvailable: vi.fn().mockResolvedValue(true),
            getBlockPreview,
          },
        },
        {
          provide: SiyuanDirectProvider,
          useValue: { isAvailable: vi.fn().mockResolvedValue(false) },
        },
        {
          provide: LoggerService,
          useValue: { category: () => ({ debug: vi.fn(), warn: vi.fn() }) },
        },
      ],
    });
  });

  it('dedupes concurrent preview refreshes for the same user/link/block key', async () => {
    const service = TestBed.inject(SiyuanPreviewService);

    const [first, second] = await Promise.all([
      service.preview(link),
      service.preview(link),
    ]);

    expect(getBlockPreview).toHaveBeenCalledTimes(1);
    expect(savePreview).toHaveBeenCalledTimes(1);
    expect(first.status).toBe('ready');
    expect(second.status).toBe('ready');
  });

  it('keeps force refresh separate from normal cached refresh requests', async () => {
    const service = TestBed.inject(SiyuanPreviewService);

    await Promise.all([
      service.preview(link),
      service.preview(link, { forceRefresh: true }),
    ]);

    expect(getBlockPreview).toHaveBeenCalledTimes(2);
  });
});