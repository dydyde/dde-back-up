import { Injectable } from '@angular/core';
import { SIYUAN_CONFIG } from '../../../../config/siyuan.config';
import { isValidSiyuanBlockId } from './siyuan-link-parser';
import { normalizePreview } from './siyuan-preview-utils';
import type { SiyuanBlockPreview, SiyuanChildBlockPreview, SiyuanPreviewErrorCode } from '../external-source.model';
import { SiyuanProviderError, type SiyuanPreviewProvider } from './siyuan-provider.interface';

interface ExtensionResponsePayload {
  blockId?: unknown;
  hpath?: unknown;
  plainText?: unknown;
  kramdown?: unknown;
  sourceUpdatedAt?: unknown;
  childBlocks?: unknown;
  truncated?: unknown;
}

interface ExtensionMessage {
  type?: unknown;
  requestId?: unknown;
  ok?: unknown;
  data?: ExtensionResponsePayload;
  errorCode?: unknown;
  errorMessage?: unknown;
}

const ALLOWED_ERROR_CODES: readonly SiyuanPreviewErrorCode[] = [
  'not-configured',
  'runtime-not-supported',
  'extension-unavailable',
  'kernel-unreachable',
  'token-invalid',
  'block-not-found',
  'render-blocked',
  'unknown',
];

@Injectable({ providedIn: 'root' })
export class SiyuanExtensionProvider implements SiyuanPreviewProvider {
  readonly mode = 'extension-relay' as const;

  async isAvailable(): Promise<boolean> {
    if (typeof window === 'undefined') return false;
    return this.pingExtension();
  }

  async diagnoseConnection(): Promise<{ ok: boolean; errorCode?: SiyuanPreviewErrorCode }> {
    if (typeof window === 'undefined') return { ok: false, errorCode: 'runtime-not-supported' };
    if (!await this.pingExtension()) return { ok: false, errorCode: 'extension-unavailable' };
    try {
      const response = await this.postConnectionTest();
      if (response.ok === true) return { ok: true };
      return { ok: false, errorCode: this.readErrorCode(response.errorCode) };
    } catch (error) {
      if (error instanceof SiyuanProviderError) return { ok: false, errorCode: error.code };
      return { ok: false, errorCode: 'unknown' };
    }
  }

  async getBlockPreview(blockId: string, signal?: AbortSignal): Promise<SiyuanBlockPreview> {
    if (!isValidSiyuanBlockId(blockId)) throw new SiyuanProviderError('block-not-found');
    if (typeof window === 'undefined') throw new SiyuanProviderError('runtime-not-supported');

    const response = await this.postRequest(blockId, signal);
    if (!response.ok) {
      const code = this.readErrorCode(response.errorCode);
      throw new SiyuanProviderError(code, this.truncate(String(response.errorMessage ?? code), 240));
    }

    const data = response.data;
    if (!data || data.blockId !== blockId) throw new SiyuanProviderError('unknown', 'Extension returned mismatched blockId');
    return normalizePreview({
      blockId,
      hpath: this.readBoundedString(data.hpath, SIYUAN_CONFIG.MAX_HPATH_LENGTH),
      plainText: this.readBoundedString(data.plainText, SIYUAN_CONFIG.MAX_PREVIEW_CHARS * 2),
      kramdown: this.readBoundedString(data.kramdown, SIYUAN_CONFIG.MAX_PREVIEW_CHARS * 2),
      sourceUpdatedAt: this.readBoundedString(data.sourceUpdatedAt, 64),
      childBlocks: this.readChildBlocks(data.childBlocks),
      truncated: data.truncated === true,
    });
  }

  private async pingExtension(): Promise<boolean> {
    try {
      const requestId = crypto.randomUUID();
      return await new Promise<boolean>(resolve => {
        const timer = window.setTimeout(() => {
          window.removeEventListener('message', listener);
          resolve(false);
        }, SIYUAN_CONFIG.EXTENSION_PING_TIMEOUT_MS);
        const listener = (event: MessageEvent<unknown>) => {
          if (!this.isTrustedWindowMessage(event)) return;
          const message = event.data as ExtensionMessage;
          if (message.requestId !== requestId) return;
          if (message.type === 'nanoflow.siyuan.pong') {
            window.clearTimeout(timer);
            window.removeEventListener('message', listener);
            resolve(message.ok === true);
            return;
          }
          // 兼容旧 content-script：runtime 异常时可能统一回 preview-result。
          if (message.type === 'nanoflow.siyuan.preview-result' && this.readErrorCode(message.errorCode) === 'extension-unavailable') {
            window.clearTimeout(timer);
            window.removeEventListener('message', listener);
            resolve(false);
          }
        };
        window.addEventListener('message', listener);
        window.postMessage({ type: 'nanoflow.siyuan.ping', requestId }, window.location.origin);
      });
    } catch {
      return false;
    }
  }

  private postConnectionTest(signal?: AbortSignal): Promise<ExtensionMessage> {
    return this.postRelayRequest({
      requestType: 'nanoflow.siyuan.test-connection',
      responseType: 'nanoflow.siyuan.test-connection-result',
      signal,
    });
  }

  private postRequest(blockId: string, signal?: AbortSignal): Promise<ExtensionMessage> {
    return this.postRelayRequest({
      requestType: 'nanoflow.siyuan.get-preview',
      responseType: 'nanoflow.siyuan.preview-result',
      payload: { blockId, includeChildren: true, maxChildren: SIYUAN_CONFIG.MAX_PREVIEW_CHILDREN, maxChars: SIYUAN_CONFIG.MAX_PREVIEW_CHARS },
      signal,
    });
  }

  private postRelayRequest(args: {
    requestType: 'nanoflow.siyuan.get-preview' | 'nanoflow.siyuan.test-connection';
    responseType: 'nanoflow.siyuan.preview-result' | 'nanoflow.siyuan.test-connection-result';
    payload?: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<ExtensionMessage> {
    const { requestType, responseType, payload, signal } = args;
    const requestId = crypto.randomUUID();
    return new Promise<ExtensionMessage>((resolve, reject) => {
      // 提前返回：调用方在我们准备 timer/listener 之前就已 abort，避免无谓的事件订阅。
      if (signal?.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      const cleanup = () => {
        window.clearTimeout(timer);
        window.removeEventListener('message', listener);
        signal?.removeEventListener('abort', abortListener);
      };
      const abortListener = () => {
        cleanup();
        reject(new DOMException('Aborted', 'AbortError'));
      };
      const timer = window.setTimeout(() => {
        cleanup();
        reject(new SiyuanProviderError('extension-unavailable'));
      }, SIYUAN_CONFIG.PREVIEW_FETCH_TIMEOUT_MS);
      const listener = (event: MessageEvent<unknown>) => {
        if (!this.isTrustedWindowMessage(event)) return;
        const message = event.data as ExtensionMessage;
        if (message.type !== responseType || message.requestId !== requestId) return;
        cleanup();
        resolve(message);
      };
      signal?.addEventListener('abort', abortListener, { once: true });
      window.addEventListener('message', listener);
      const request: Record<string, unknown> = { type: requestType, requestId };
      if (payload) request.payload = payload;
      window.postMessage(request, window.location.origin);
    });
  }

  private isTrustedWindowMessage(event: MessageEvent<unknown>): boolean {
    return event.source === window && event.origin === window.location.origin && typeof event.data === 'object' && event.data !== null;
  }

  private readChildBlocks(value: unknown): SiyuanChildBlockPreview[] | undefined {
    if (!Array.isArray(value)) return undefined;
    return value
      .slice(0, SIYUAN_CONFIG.MAX_PREVIEW_CHILDREN)
      .filter(item => typeof item?.id === 'string' && typeof item?.content === 'string' && typeof item?.type === 'string')
      .map(item => ({
        id: this.truncate(item.id, SIYUAN_CONFIG.MAX_LINK_ID_LENGTH),
        content: this.truncate(item.content, SIYUAN_CONFIG.MAX_PREVIEW_CHARS),
        type: this.truncate(item.type, 32),
      }));
  }

  private readErrorCode(value: unknown): SiyuanPreviewErrorCode {
    return ALLOWED_ERROR_CODES.includes(value as SiyuanPreviewErrorCode) ? value as SiyuanPreviewErrorCode : 'unknown';
  }

  private readBoundedString(value: unknown, maxLength: number): string | undefined {
    return typeof value === 'string' ? this.truncate(value, maxLength) : undefined;
  }

  private truncate(value: string, maxLength: number): string {
    return value.length > maxLength ? value.slice(0, maxLength) : value;
  }
}
