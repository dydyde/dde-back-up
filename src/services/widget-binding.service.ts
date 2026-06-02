import { Injectable, inject } from '@angular/core';
import { TIMEOUT_CONFIG } from '../config/timeout.config';
import { environment } from '../environments/environment';
import {
  ErrorCodes,
  extractErrorMessage,
  failure,
  humanizeErrorMessage,
  success,
  type OperationError,
  type Result,
} from '../utils/result';
import type { AndroidWidgetBootstrapRequest } from '../utils/startup-entry-intent';
import { withTimeout } from '../utils/timeout';
import { LoggerService } from './logger.service';
import { SupabaseClientService } from './supabase-client.service';

const ANDROID_WIDGET_HOST_PACKAGE = 'app.nanoflow.twa';

export interface WidgetRevokeAllResult {
  revokedCount: number;
}

export interface WidgetRegisterResult {
  deviceId: string;
  bindingGeneration: number;
  expiresAt: string;
  widgetToken: string;
  instanceId: string | null;
}

export interface AndroidWidgetBootstrapCallbackResult extends WidgetRegisterResult {
  callbackUrl: string;
  callbackIntentUrl: string;
}

@Injectable({ providedIn: 'root' })
export class WidgetBindingService {
  private readonly logger = inject(LoggerService).category('WidgetBinding');
  private readonly supabase = inject(SupabaseClientService);

  async revokeAllBindings(): Promise<Result<WidgetRevokeAllResult, OperationError>> {
    if (!this.supabase.isConfigured) {
      return success({ revokedCount: 0 });
    }

    try {
      const client = await this.supabase.clientAsync();
      if (!client) {
        return failure(ErrorCodes.SYNC_AUTH_EXPIRED, 'Supabase 客户端未就绪，无法吊销 Widget 绑定');
      }

      const { data, error } = await withTimeout(
        client.functions.invoke('widget-register', {
          body: { action: 'revoke-all' },
        }),
        {
          timeout: TIMEOUT_CONFIG.QUICK,
          timeoutMessage: 'Widget revoke-all 超时',
        },
      );

      if (error) {
        const message = humanizeErrorMessage(error.message ?? 'Widget revoke-all 调用失败');
        this.logger.warn('Widget revoke-all 调用失败', { message });
        return failure(ErrorCodes.OPERATION_FAILED, message);
      }

      const revokedCount = this.extractRevokedCount(data);
      // OBS-11: widget_account_switch_cleanup — 记录 Web 端登出/换号清理结果
      this.logger.info('[WidgetTelemetry] widget_account_switch_cleanup', {
        surface: 'web',
        revokedCount,
      });
      return success({ revokedCount });
    } catch (error) {
      const message = humanizeErrorMessage(extractErrorMessage(error));
      this.logger.warn('Widget revoke-all 异常', { message, error });
      return failure(ErrorCodes.OPERATION_FAILED, message);
    }
  }

  /**
   * 注册 Widget 设备绑定并返回宿主后续所需的只读 token / binding 元数据。
   */
  async registerDevice(params: {
    deviceId: string;
    installationId: string;
    deviceSecret: string;
    platform: string;
    pushToken?: string | null;
    clientVersion?: string | null;
    clientSurface?: string | null;
    persistRuntimeBinding?: boolean;
    instance?: { id: string; hostInstanceId: string; sizeBucket: string };
  }): Promise<Result<WidgetRegisterResult, OperationError>> {
    if (!this.supabase.isConfigured) {
      return failure(ErrorCodes.OPERATION_FAILED, 'Supabase 未配置');
    }

    try {
      const client = await this.supabase.clientAsync();
      if (!client) {
        return failure(ErrorCodes.SYNC_AUTH_EXPIRED, 'Supabase 客户端未就绪');
      }

      const clientVersion = this.normalizeOptionalText(params.clientVersion);
      const clientSurface = this.normalizeOptionalText(params.clientSurface, 128)
        ?? (params.platform === 'android-widget'
          ? (clientVersion ? 'android-host' : null)
          : 'web-app');
      const capabilities = clientVersion || clientSurface
        ? {
            clientContext: {
              clientVersion,
              clientSurface,
            },
          }
        : undefined;

      const { data, error } = await withTimeout(
        client.functions.invoke('widget-register', {
          body: {
            action: 'register',
            deviceId: params.deviceId,
            installationId: params.installationId,
            deviceSecret: params.deviceSecret,
            platform: params.platform,
            pushToken: params.pushToken,
            ...(capabilities ? { capabilities } : {}),
            instance: params.instance ?? null,
          },
        }),
        {
          timeout: TIMEOUT_CONFIG.STANDARD,
          timeoutMessage: 'Widget register 超时',
        },
      );

      if (error) {
        const message = humanizeErrorMessage(error.message ?? 'Widget register 调用失败');
        this.logger.warn('Widget register 调用失败', { message });
        return failure(ErrorCodes.OPERATION_FAILED, message);
      }

      const response = data as Record<string, unknown> | null;
      if (!response || typeof response.widgetToken !== 'string') {
        return failure(ErrorCodes.OPERATION_FAILED, 'Widget register 响应格式异常');
      }

      const result: WidgetRegisterResult = {
        deviceId: response.deviceId as string,
        bindingGeneration: response.bindingGeneration as number,
        expiresAt: response.expiresAt as string,
        widgetToken: response.widgetToken as string,
        instanceId: response.instance
          ? (response.instance as { id: string }).id
          : null,
      };

      return success(result);
    } catch (error) {
      const message = humanizeErrorMessage(extractErrorMessage(error));
      this.logger.warn('Widget register 异常', { message, error });
      return failure(ErrorCodes.OPERATION_FAILED, message);
    }
  }

  async completeAndroidBootstrap(
    request: AndroidWidgetBootstrapRequest,
  ): Promise<Result<AndroidWidgetBootstrapCallbackResult, OperationError>> {
    const registerResult = await this.registerDevice({
      deviceId: request.deviceId,
      installationId: request.installationId,
      deviceSecret: request.deviceSecret,
      platform: 'android-widget',
      pushToken: request.pendingPushToken,
      clientVersion: request.clientVersion,
      clientSurface: request.clientVersion ? 'android-host' : null,
      persistRuntimeBinding: false,
      instance: {
        id: request.instanceId,
        hostInstanceId: request.hostInstanceId,
        sizeBucket: request.sizeBucket,
      },
    });

    if (!registerResult.ok) {
      return registerResult;
    }

    const callbackUrls = this.buildAndroidBootstrapCallbackUrls(request, registerResult.value);
    if (!callbackUrls) {
      return failure(ErrorCodes.OPERATION_FAILED, 'Android Widget bootstrap 回调地址无效');
    }

    return success({
      ...registerResult.value,
      ...callbackUrls,
    });
  }

  private extractRevokedCount(value: unknown): number {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return 0;
    }

    const revokedCount = (value as { revokedCount?: unknown }).revokedCount;
    return typeof revokedCount === 'number' && Number.isFinite(revokedCount)
      ? Math.max(0, Math.trunc(revokedCount))
      : 0;
  }

  private buildAndroidBootstrapCallbackUrls(
    request: AndroidWidgetBootstrapRequest,
    registerResult: WidgetRegisterResult,
  ): { callbackUrl: string; callbackIntentUrl: string } | null {
    try {
      const callbackBaseUrl = new URL(request.callbackUri);
      const callbackParams = new URLSearchParams({
        widgetToken: registerResult.widgetToken,
        widgetInstallationId: request.installationId,
        widgetDeviceId: registerResult.deviceId,
        widgetSupabaseUrl: environment.supabaseUrl,
        bindingGeneration: String(registerResult.bindingGeneration),
        expiresAt: registerResult.expiresAt,
        widgetInstanceId: registerResult.instanceId ?? request.instanceId,
        widgetHostInstanceId: request.hostInstanceId,
        widgetBootstrapNonce: request.bootstrapNonce,
      });
      const callbackUrl = new URL(callbackBaseUrl.toString());
      callbackUrl.search = callbackParams.toString();
      callbackUrl.hash = '';
      return {
        callbackUrl: callbackUrl.toString(),
        callbackIntentUrl: this.buildAndroidBootstrapIntentUrl(callbackBaseUrl, callbackParams),
      };
    } catch {
      return null; // eslint-disable-line no-restricted-syntax -- 回调 URL 构造失败时无法继续回跳，返回 null 交由上层失败处理
    }
  }

  private buildAndroidBootstrapIntentUrl(
    callbackBaseUrl: URL,
    callbackParams: URLSearchParams,
  ): string {
    const callbackScheme = callbackBaseUrl.protocol.replace(/:$/, '');
    const callbackPath = callbackBaseUrl.pathname && callbackBaseUrl.pathname !== '/'
      ? callbackBaseUrl.pathname
      : '';
    const queryString = callbackParams.toString();
    return `intent://${callbackBaseUrl.host}${callbackPath}${queryString ? `?${queryString}` : ''}#Intent;scheme=${callbackScheme};package=${ANDROID_WIDGET_HOST_PACKAGE};end`;
  }

  private normalizeOptionalText(value: string | null | undefined, maxLength = 256): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : null;
  }

}
