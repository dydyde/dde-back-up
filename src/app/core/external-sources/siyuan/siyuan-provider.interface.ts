import type { SiyuanBlockPreview, SiyuanPreviewErrorCode } from '../external-source.model';

export interface SiyuanPreviewProvider {
  readonly mode: 'extension-relay' | 'direct' | 'cache-only';
  isAvailable(): Promise<boolean>;
  getBlockPreview(blockId: string, signal?: AbortSignal): Promise<SiyuanBlockPreview>;
}

/** 扩展中转 provider 的扩展能力：把 NanoFlow 设置页填写的 baseUrl/token 单向写入扩展，并回读已配置状态。 */
export interface SiyuanExtensionConfigStatus {
  baseUrl?: string;
  hasToken: boolean;
}

export interface SiyuanPushConfigInput {
  baseUrl: string;
  /** undefined 表示不改动 token；空字符串表示清除扩展中已保存的 token。 */
  token?: string;
}

export interface SiyuanPushConfigResult {
  ok: boolean;
  errorCode?: SiyuanPreviewErrorCode;
}

export class SiyuanProviderError extends Error {
  constructor(readonly code: SiyuanPreviewErrorCode, message?: string) {
    super(message ?? code);
  }
}
