import { Injector, runInInjectionContext } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { environment } from '../environments/environment';
import { success } from '../utils/result';
import { LoggerService } from './logger.service';
import { SupabaseClientService } from './supabase-client.service';
import { WidgetBindingService } from './widget-binding.service';

function setup(options?: {
  isConfigured?: boolean;
  clientAsyncResult?: unknown;
}) {
  const logger = {
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  };

  const invoke = vi.fn();
  const clientAsync = vi.fn().mockResolvedValue(options?.clientAsyncResult ?? {
    functions: {
      invoke,
    },
  });

  const injector = Injector.create({
    providers: [
      { provide: WidgetBindingService, useClass: WidgetBindingService },
      {
        provide: LoggerService,
        useValue: {
          category: vi.fn(() => logger),
        },
      },
      {
        provide: SupabaseClientService,
        useValue: {
          isConfigured: options?.isConfigured ?? true,
          clientAsync,
        },
      },
    ],
  });

  return {
    service: runInInjectionContext(injector, () => injector.get(WidgetBindingService)),
    invoke,
    clientAsync,
    logger,
  };
}

describe('WidgetBindingService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('Supabase 未配置时应直接跳过远端吊销', async () => {
    const { service, clientAsync } = setup({ isConfigured: false });

    await expect(service.revokeAllBindings()).resolves.toEqual({
      ok: true,
      value: { revokedCount: 0 },
    });
    expect(clientAsync).not.toHaveBeenCalled();
  });

  it('应调用 widget-register revoke-all 并返回吊销数量', async () => {
    const { service, invoke } = setup();
    invoke.mockResolvedValueOnce({
      data: { revokedCount: 3 },
      error: null,
    });

    const result = await service.revokeAllBindings();

    expect(invoke).toHaveBeenCalledWith('widget-register', {
      body: { action: 'revoke-all' },
    });
    expect(result).toEqual({
      ok: true,
      value: { revokedCount: 3 },
    });
  });

  it('Edge Function 调用失败时应返回失败结果', async () => {
    const { service, invoke, logger } = setup();
    invoke.mockResolvedValueOnce({
      data: null,
      error: { message: 'Function not found' },
    });

    const result = await service.revokeAllBindings();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('OPERATION_FAILED');
      expect(result.error.message).toContain('资源不存在');
    }
    expect(logger.warn).toHaveBeenCalled();
  });

  it('Android bootstrap 注册时应仅提交原生宿主所需字段', async () => {
    const { service, invoke } = setup();

    invoke.mockResolvedValueOnce({
      data: {
        deviceId: '22222222-2222-4222-8222-222222222222',
        bindingGeneration: 2,
        expiresAt: '2026-04-20T00:00:00.000Z',
        widgetToken: 'android-token',
        instance: { id: '33333333-3333-4333-8333-333333333333' },
      },
      error: null,
    });

    const result = await service.registerDevice({
      deviceId: '22222222-2222-4222-8222-222222222222',
      installationId: '11111111-1111-4111-8111-111111111111',
      deviceSecret: 'super-secret-device-key',
      platform: 'android-widget',
      pushToken: 'fcm-token',
      instance: {
        id: '33333333-3333-4333-8333-333333333333',
        hostInstanceId: '42',
        sizeBucket: '4x2',
      },
    });

    expect(invoke).toHaveBeenCalledWith('widget-register', {
      body: {
        action: 'register',
        deviceId: '22222222-2222-4222-8222-222222222222',
        installationId: '11111111-1111-4111-8111-111111111111',
        deviceSecret: 'super-secret-device-key',
        platform: 'android-widget',
        pushToken: 'fcm-token',
        instance: {
          id: '33333333-3333-4333-8333-333333333333',
          hostInstanceId: '42',
          sizeBucket: '4x2',
        },
      },
    });
    expect(result).toEqual({
      ok: true,
      value: {
        deviceId: '22222222-2222-4222-8222-222222222222',
        bindingGeneration: 2,
        expiresAt: '2026-04-20T00:00:00.000Z',
        widgetToken: 'android-token',
        instanceId: '33333333-3333-4333-8333-333333333333',
      },
    });
  });

  it('应构造 Android bootstrap 回调 URL 并保持 native host 所需字段', async () => {
    const { service } = setup();
    const registerDevice = vi.spyOn(service, 'registerDevice').mockResolvedValue(success({
      deviceId: '22222222-2222-4222-8222-222222222222',
      bindingGeneration: 4,
      expiresAt: '2026-04-20T00:00:00.000Z',
      widgetToken: 'android-token',
      instanceId: '55555555-5555-4555-8555-555555555555',
    }));

    const result = await service.completeAndroidBootstrap({
      callbackUri: 'nanoflow-widget://bootstrap',
      installationId: '11111111-1111-4111-8111-111111111111',
      deviceId: '22222222-2222-4222-8222-222222222222',
      deviceSecret: 'super-secret-device-key',
      clientVersion: 'android-widget/0.1.0',
      instanceId: '33333333-3333-4333-8333-333333333333',
      hostInstanceId: '42',
      sizeBucket: '4x2',
      bootstrapNonce: '44444444-4444-4444-8444-444444444444',
      pendingPushToken: 'fcm-token',
    });

    expect(registerDevice).toHaveBeenCalledWith({
      deviceId: '22222222-2222-4222-8222-222222222222',
      installationId: '11111111-1111-4111-8111-111111111111',
      deviceSecret: 'super-secret-device-key',
      platform: 'android-widget',
      pushToken: 'fcm-token',
      clientVersion: 'android-widget/0.1.0',
      clientSurface: 'android-host',
      instance: {
        id: '33333333-3333-4333-8333-333333333333',
        hostInstanceId: '42',
        sizeBucket: '4x2',
      },
      persistRuntimeBinding: false,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const encodedSupabaseUrl = encodeURIComponent(environment.supabaseUrl);
      expect(result.value.callbackUrl).toBe(
        `nanoflow-widget://bootstrap?widgetToken=android-token&widgetInstallationId=11111111-1111-4111-8111-111111111111&widgetDeviceId=22222222-2222-4222-8222-222222222222&widgetSupabaseUrl=${encodedSupabaseUrl}&bindingGeneration=4&expiresAt=2026-04-20T00%3A00%3A00.000Z&widgetInstanceId=55555555-5555-4555-8555-555555555555&widgetHostInstanceId=42&widgetBootstrapNonce=44444444-4444-4444-8444-444444444444`,
      );
      expect(result.value.callbackIntentUrl).toBe(
        `intent://bootstrap?widgetToken=android-token&widgetInstallationId=11111111-1111-4111-8111-111111111111&widgetDeviceId=22222222-2222-4222-8222-222222222222&widgetSupabaseUrl=${encodedSupabaseUrl}&bindingGeneration=4&expiresAt=2026-04-20T00%3A00%3A00.000Z&widgetInstanceId=55555555-5555-4555-8555-555555555555&widgetHostInstanceId=42&widgetBootstrapNonce=44444444-4444-4444-8444-444444444444#Intent;scheme=nanoflow-widget;package=app.nanoflow.twa;end`,
      );
    }
  });

});
