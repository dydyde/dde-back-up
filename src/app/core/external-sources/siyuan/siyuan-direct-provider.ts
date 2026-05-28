import { Injectable, inject } from '@angular/core';
import { SIYUAN_CONFIG } from '../../../../config/siyuan.config';
import { ExternalSourceCacheService } from '../external-source-cache.service';
import { isValidSiyuanBlockId } from './siyuan-link-parser';
import { mapSiyuanError, normalizePreview } from './siyuan-preview-utils';
import type { SiyuanBlockPreview, SiyuanChildBlockPreview } from '../external-source.model';
import { SiyuanProviderError, type SiyuanPreviewProvider } from './siyuan-provider.interface';

interface SiyuanApiResponse<T> {
  code?: number;
  msg?: string;
  data?: T;
}

interface KramdownData { id?: string; kramdown?: string; }
interface HPathData { hPath?: string; }
interface AttrData { title?: string; updated?: string; updatedAt?: string; }
interface ChildBlockData { id?: string; content?: string; markdown?: string; type?: string; }

/**
 * 直连模式 baseUrl 校验。
 *
 * `pageLocation` 必填：传 `null` 表示显式放弃 page-origin 校验
 * （仅在没有 DOM 上下文的环境，例如单元测试或 SSR 启动期），
 * 防止默认值悄无声息地放过 HTTPS 公网页面发起的直连请求。
 */
export function isTrustedSiyuanDirectBaseUrl(baseUrl: string, pageLocation: Location | null): boolean {
  try {
    const url = new URL(baseUrl);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return false;
    const originAllowed = (SIYUAN_CONFIG.ALLOWED_DIRECT_BASE_URLS as readonly string[]).includes(url.origin);
    if (!originAllowed) return false;
    if (!pageLocation) return true;
    const isLocalPage = pageLocation.hostname === 'localhost' || pageLocation.hostname === '127.0.0.1';
    return isLocalPage || pageLocation.protocol === 'file:';
  } catch {
    return false;
  }
}

/** 浏览器可用时返回 window.location，否则返回 null。集中托管运行时检测，避免散落在各处。 */
function currentPageLocation(): Location | null {
  return typeof location === 'undefined' ? null : location;
}

@Injectable({ providedIn: 'root' })
export class SiyuanDirectProvider implements SiyuanPreviewProvider {
  readonly mode = 'direct' as const;
  private readonly cache = inject(ExternalSourceCacheService);

  async isAvailable(): Promise<boolean> {
    const config = await this.cache.loadConfig();
    return config.runtimeMode === 'direct' && isTrustedSiyuanDirectBaseUrl(config.baseUrl, currentPageLocation()) && Boolean(config.token);
  }

  async getBlockPreview(blockId: string, signal?: AbortSignal): Promise<SiyuanBlockPreview> {
    if (!isValidSiyuanBlockId(blockId)) throw new SiyuanProviderError('block-not-found');
    const config = await this.cache.loadConfig();
    if (config.runtimeMode !== 'direct' || !isTrustedSiyuanDirectBaseUrl(config.baseUrl, currentPageLocation())) {
      throw new SiyuanProviderError('runtime-not-supported');
    }
    if (!config.token) throw new SiyuanProviderError('not-configured');

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), SIYUAN_CONFIG.PREVIEW_FETCH_TIMEOUT_MS);
    const abortListener = () => controller.abort();
    signal?.addEventListener('abort', abortListener, { once: true });
    try {
      const [kramdown, hpath, attrs, children] = await Promise.all([
        this.call<KramdownData>(config.baseUrl, config.token, '/api/block/getBlockKramdown', { id: blockId }, controller.signal),
        this.call<HPathData | string>(config.baseUrl, config.token, '/api/filetree/getHPathByID', { id: blockId }, controller.signal).catch(() => undefined),
        this.call<AttrData>(config.baseUrl, config.token, '/api/attr/getBlockAttrs', { id: blockId }, controller.signal).catch(() => undefined),
        this.call<ChildBlockData[]>(config.baseUrl, config.token, '/api/block/getChildBlocks', { id: blockId }, controller.signal).catch(() => []),
      ]);
      if (!kramdown) throw new SiyuanProviderError('block-not-found');
      if (kramdown.id && kramdown.id !== blockId) throw new SiyuanProviderError('unknown', 'SiYuan returned mismatched blockId');
      return normalizePreview({
        blockId,
        title: this.readTitle(attrs),
        hpath: this.readHPath(hpath),
        kramdown: kramdown.kramdown ?? '',
        sourceUpdatedAt: attrs?.updatedAt ?? attrs?.updated,
        childBlocks: this.mapChildren(children ?? []),
      });
    } catch (error) {
      if (error instanceof SiyuanProviderError) throw error;
      throw new SiyuanProviderError(mapSiyuanError(error));
    } finally {
      window.clearTimeout(timeout);
      signal?.removeEventListener('abort', abortListener);
    }
  }

  private async call<T>(baseUrl: string, token: string, path: string, body: Record<string, string>, signal: AbortSignal): Promise<T | undefined> {
    const response = await fetch(new URL(path, baseUrl).toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Token ${token}` },
      body: JSON.stringify(body),
      signal,
    });
    if (response.status === 401 || response.status === 403) throw new SiyuanProviderError('token-invalid');
    if (!response.ok) throw new Error(`SiYuan API ${response.status}`);
    const json = await response.json() as SiyuanApiResponse<T>;
    if (json.code && json.code !== 0) throw new Error(json.msg ?? `SiYuan code ${json.code}`);
    return json.data;
  }

  private readHPath(value: HPathData | string | undefined): string | undefined {
    if (typeof value === 'string') return value;
    return value?.hPath;
  }

  private readTitle(value: AttrData | undefined): string | undefined {
    if (typeof value?.title !== 'string') return undefined;
    const title = value.title.trim();
    return title ? title.slice(0, SIYUAN_CONFIG.MAX_LABEL_LENGTH) : undefined;
  }

  private mapChildren(children: ChildBlockData[]): SiyuanChildBlockPreview[] {
    return children
      .filter(child => typeof child.id === 'string')
      .map(child => ({ id: child.id!, type: child.type ?? 'unknown', content: child.content ?? child.markdown ?? '' }));
  }
}
