import { Injectable, inject } from '@angular/core';
import { SIYUAN_CONFIG } from '../../../../config/siyuan.config';
import { LoggerService } from '../../../../services/logger.service';
import { ExternalSourceCacheService } from '../external-source-cache.service';
import type { ExternalSourceLink, LocalSiyuanPreviewCache, SiyuanPreviewErrorCode, SiyuanPreviewResult } from '../external-source.model';
import { SiyuanDirectProvider } from './siyuan-direct-provider';
import { SiyuanExtensionProvider } from './siyuan-extension-provider';
import {
  SiyuanProviderError,
  type SiyuanExtensionConfigProbeResult,
  type SiyuanExtensionConfigStatus,
  type SiyuanPreviewProvider,
  type SiyuanPushConfigInput,
  type SiyuanPushConfigResult,
} from './siyuan-provider.interface';

interface ActivePreviewRequest {
  linkId: string;
  blockId: string;
  controller: AbortController;
  requestSeq: number;
}

@Injectable({ providedIn: 'root' })
export class SiyuanPreviewService {
  private readonly cache = inject(ExternalSourceCacheService);
  private readonly extensionProvider = inject(SiyuanExtensionProvider);
  private readonly directProvider = inject(SiyuanDirectProvider);
  private readonly logger = inject(LoggerService).category('SiyuanPreview');
  private activeRequest?: ActivePreviewRequest;
  private requestSeq = 0;
  private readonly inFlight = new Map<string, Promise<SiyuanPreviewResult>>();

  async diagnoseConnection(): Promise<{ ok: boolean; mode: 'extension-relay' | 'direct' | 'cache-only'; errorCode?: SiyuanPreviewErrorCode }> {
    const config = await this.cache.loadConfig();
    if (config.runtimeMode === 'cache-only') return { ok: true, mode: 'cache-only' };
    if (config.runtimeMode === 'direct') {
      if (!config.token) return { ok: false, mode: 'direct', errorCode: 'not-configured' };
      return await this.directProvider.isAvailable()
        ? { ok: true, mode: 'direct' }
        : { ok: false, mode: 'direct', errorCode: 'runtime-not-supported' };
    }
    const diagnosis = await this.extensionProvider.diagnoseConnection();
    if (diagnosis.ok) return { ok: true, mode: 'extension-relay' };
    return { ok: false, mode: 'extension-relay', errorCode: diagnosis.errorCode ?? 'unknown' };
  }

  /**
   * relay 模式专用：把 baseUrl/token 单向写入扩展。
   * 其它模式直接返回 runtime-not-supported，避免把 token 误推到错误的通道。
   */
  async pushExtensionConfig(input: SiyuanPushConfigInput): Promise<SiyuanPushConfigResult> {
    const config = await this.cache.loadConfig();
    if (config.runtimeMode !== 'extension-relay') {
      return { ok: false, errorCode: 'runtime-not-supported' };
    }
    return this.extensionProvider.pushConfig(input);
  }

  /**
   * relay 模式专用：读取扩展中已保存的配置状态。
   * 返回 null 表示扩展不支持该消息（旧扩展）或不可用，UI 应据此提示用户更新扩展。
   * 其它模式始终返回 null。
   */
  async getExtensionConfigStatus(): Promise<SiyuanExtensionConfigStatus | null> {
    const config = await this.cache.loadConfig();
    if (config.runtimeMode !== 'extension-relay') return null;
    return this.extensionProvider.getConfigStatus();
  }

  async probeExtensionConfigStatus(): Promise<SiyuanExtensionConfigProbeResult> {
    const config = await this.cache.loadConfig();
    if (config.runtimeMode !== 'extension-relay') return { kind: 'unavailable' };
    return this.extensionProvider.probeConfigStatus();
  }

  async preview(link: ExternalSourceLink, options?: { forceRefresh?: boolean }): Promise<SiyuanPreviewResult> {
    const cached = await this.cache.getPreview(link.id, link.targetId);
    if (cached && !options?.forceRefresh) {
      const stale = Date.now() - new Date(cached.fetchedAt).getTime() > SIYUAN_CONFIG.CACHE_STALE_MS;
      // 只在缓存过期时触发后台刷新，遵守 CACHE_STALE_MS 预算并避免每次悬停都打 API。
      if (stale) {
        void this.refreshDeduped(link, undefined, false).catch(error => {
          this.logger.debug('后台刷新思源预览失败，继续使用本机缓存', {
            linkId: link.id,
            blockId: link.targetId,
            message: error instanceof Error ? error.message : 'unknown',
          });
        });
      }
      return { status: 'ready', preview: cached, stale };
    }
    return this.refreshDeduped(link, cached ?? undefined, options?.forceRefresh === true);
  }

  abortActive(): void {
    this.activeRequest?.controller.abort();
    this.activeRequest = undefined;
  }

  private refreshDeduped(
    link: ExternalSourceLink,
    fallback: LocalSiyuanPreviewCache | undefined,
    forceRefresh: boolean,
  ): Promise<SiyuanPreviewResult> {
    const key = this.previewRequestKey(link, forceRefresh);
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const request = this.refresh(link, fallback).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, request);
    return request;
  }

  async refresh(link: ExternalSourceLink, fallback?: LocalSiyuanPreviewCache): Promise<SiyuanPreviewResult> {
    const requestSeq = ++this.requestSeq;
    this.activeRequest?.controller.abort();
    const controller = new AbortController();
    this.activeRequest = { linkId: link.id, blockId: link.targetId, controller, requestSeq };

    try {
      const provider = await this.selectProvider();
      if (!provider) {
        return fallback
          ? { status: 'cache-only', preview: fallback, errorCode: 'extension-unavailable', stale: true }
          : { status: 'error', errorCode: 'extension-unavailable' };
      }
      const preview = await provider.getBlockPreview(link.targetId, controller.signal);
      if (!this.isCurrent(link, controller, requestSeq, preview.blockId)) {
        return fallback ? { status: 'cache-only', preview: fallback, stale: true } : { status: 'loading' };
      }
      const cache: LocalSiyuanPreviewCache = {
        ...preview,
        linkId: link.id,
        fetchedAt: new Date().toISOString(),
        fetchStatus: 'ready',
      };
      await this.cache.savePreview(cache);
      return { status: 'ready', preview: cache };
    } catch (error) {
      const errorCode = error instanceof SiyuanProviderError ? error.code : 'unknown';
      return fallback
        ? { status: 'cache-only', preview: fallback, errorCode, stale: true }
        : { status: 'error', errorCode };
    }
  }

  private async selectProvider(): Promise<SiyuanPreviewProvider | null> {
    const config = await this.cache.loadConfig();
    if (config.runtimeMode === 'cache-only') return null;
    if (config.runtimeMode === 'direct') return await this.directProvider.isAvailable() ? this.directProvider : null;
    // 显式选择 extension-relay 的用户可能正是为了避免 token 落到 direct 模式的 fetch 流量里，
    // 因此扩展不可用时不再静默 fallback；直接告知扩展不可用，让用户在设置里改 runtimeMode。
    return await this.extensionProvider.isAvailable() ? this.extensionProvider : null;
  }

  private previewRequestKey(link: ExternalSourceLink, forceRefresh: boolean): string {
    return `${this.cache.ownerId()}:${link.id}:${link.targetId}:${forceRefresh ? 'force' : 'normal'}`;
  }

  private isCurrent(link: ExternalSourceLink, controller: AbortController, requestSeq: number, blockId: string): boolean {
    return this.activeRequest?.linkId === link.id
      && this.activeRequest.blockId === link.targetId
      && this.activeRequest.controller === controller
      && this.activeRequest.requestSeq === requestSeq
      && blockId === link.targetId;
  }
}
