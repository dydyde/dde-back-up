import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SIYUAN_CONFIG } from '../../../../config/siyuan.config';
import { ExternalSourceCacheService } from '../external-source-cache.service';
import { SiyuanDirectProvider } from './siyuan-direct-provider';

const BLOCK_ID = '20260426123456-abc1234';

describe('SiyuanDirectProvider', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const path = new URL(readFetchUrl(input)).pathname;
      const body = readJsonBody(init);
      switch (path) {
        case '/api/block/getBlockKramdown':
          return siyuanResponse({ id: BLOCK_ID, kramdown: '对于细菌选择光能还是化能……' });
        case '/api/filetree/getHPathByID':
          return siyuanResponse('/细菌能量来源');
        case '/api/filetree/getPathByID':
          expect(body).toEqual({ id: BLOCK_ID });
          return siyuanResponse({ notebook: 'notebook-1', path: '/biology/microbe/doc.sy' });
        case '/api/filetree/getHPathByPath':
          expect(body).toEqual({ notebook: 'notebook-1', path: '/biology/microbe/doc.sy' });
          return siyuanResponse('/生物/微生物/细菌能量来源');
        case '/api/attr/getBlockAttrs':
          return siyuanResponse({ title: '细菌能量来源', updated: '20260531120000' });
        case '/api/block/getChildBlocks':
          return siyuanResponse([]);
        default:
          throw new Error(`Unexpected SiYuan API path: ${path}`);
      }
    });
    vi.stubGlobal('fetch', fetchMock);

    TestBed.configureTestingModule({
      providers: [
        SiyuanDirectProvider,
        {
          provide: ExternalSourceCacheService,
          useValue: {
            loadConfig: vi.fn().mockResolvedValue({
              runtimeMode: 'direct',
              baseUrl: 'http://127.0.0.1:6806',
              token: 'test-token',
            }),
          },
        },
      ],
    });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.unstubAllGlobals();
  });

  it('prefers the document-tree absolute hpath resolved from storage path', async () => {
    const provider = TestBed.inject(SiyuanDirectProvider);

    const preview = await provider.getBlockPreview(BLOCK_ID);

    expect(preview.hpath).toBe('/生物/微生物/细菌能量来源');
    expect(preview.title).toBe('细菌能量来源');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:6806/api/filetree/getHPathByPath',
      expect.objectContaining({ body: JSON.stringify({ notebook: 'notebook-1', path: '/biology/microbe/doc.sy' }) }),
    );
  });

  it('falls back to getHPathByID when the absolute path lookup is slow', async () => {
    fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const path = new URL(readFetchUrl(input)).pathname;
      switch (path) {
        case '/api/block/getBlockKramdown':
          return siyuanResponse({ id: BLOCK_ID, kramdown: '对于细菌选择光能还是化能……' });
        case '/api/filetree/getHPathByID':
          return siyuanResponse('/细菌能量来源');
        case '/api/filetree/getPathByID':
          return abortablePendingResponse(init?.signal);
        case '/api/attr/getBlockAttrs':
          return siyuanResponse({ title: '细菌能量来源' });
        case '/api/block/getChildBlocks':
          return siyuanResponse([]);
        default:
          throw new Error(`Unexpected SiYuan API path: ${path}`);
      }
    });
    vi.useFakeTimers();
    try {
      const provider = TestBed.inject(SiyuanDirectProvider);

      const previewPromise = provider.getBlockPreview(BLOCK_ID);
      await vi.advanceTimersByTimeAsync(SIYUAN_CONFIG.ABSOLUTE_HPATH_FETCH_TIMEOUT_MS);
      const preview = await previewPromise;

      expect(preview.hpath).toBe('/细菌能量来源');
      expect(fetchMock).not.toHaveBeenCalledWith(
        'http://127.0.0.1:6806/api/filetree/getHPathByPath',
        expect.anything(),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

function readFetchUrl(input: string | URL | Request): string {
  return input instanceof Request ? input.url : input.toString();
}

function readJsonBody(init: RequestInit | undefined): Record<string, string> {
  if (typeof init?.body !== 'string') return {};
  return JSON.parse(init.body) as Record<string, string>;
}

function siyuanResponse(data: unknown): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify({ code: 0, msg: '', data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }));
}

function abortablePendingResponse(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });
}