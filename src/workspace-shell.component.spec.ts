import {
  Injector,
  runInInjectionContext,
  signal,
  ɵChangeDetectionScheduler as ChangeDetectionScheduler,
  ɵEffectScheduler as EffectScheduler,
} from '@angular/core';
import { vi, describe, it, expect } from 'vitest';
import { Subject } from 'rxjs';
import { WorkspaceShellComponent } from './workspace-shell.component';
import { FEATURE_FLAGS } from './config/feature-flags.config';
import { AUTH_CONFIG } from './config/auth.config';
import { APP_LIFECYCLE_CONFIG } from './config/app-lifecycle.config';

type SwUpdateCheckReason = 'startup' | 'periodic' | 'visibility' | 'focus' | 'online';

type WorkspaceShellPrivate = {
  setupSwUpdateChecks: () => void;
  teardownSwUpdateChecks: () => void;
  checkForSwUpdate: (reason: SwUpdateCheckReason, force?: boolean) => Promise<void>;
  swUpdateInitialCheckTimer: ReturnType<typeof setTimeout> | null;
  swUpdatePollTimer: ReturnType<typeof setInterval> | null;
  swUpdateCheckInFlight: boolean;
  lastSwUpdateCheckAt: number;
  destroyed: boolean;
  swUpdate: { isEnabled: boolean; checkForUpdate: ReturnType<typeof vi.fn> };
  logger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
  };
};

function createSwUpdateCheckContext(checkForUpdate = vi.fn().mockResolvedValue(false)): WorkspaceShellPrivate {
  const context = Object.create(WorkspaceShellComponent.prototype) as WorkspaceShellPrivate;
  context.swUpdateInitialCheckTimer = null;
  context.swUpdatePollTimer = null;
  context.swUpdateCheckInFlight = false;
  context.lastSwUpdateCheckAt = 0;
  context.destroyed = false;
  context.swUpdate = { isEnabled: true, checkForUpdate };
  context.logger = {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  };
  return context;
}

function setDocumentVisibilityState(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: state,
  });
}

describe('WorkspaceShellComponent 版本更新检查', () => {
  it('应在启动延迟后主动检查 Service Worker 更新', async () => {
    vi.useFakeTimers();
    setDocumentVisibilityState('visible');
    const checkForUpdate = vi.fn().mockResolvedValue(false);
    const context = createSwUpdateCheckContext(checkForUpdate);

    try {
      context.setupSwUpdateChecks();

      await vi.advanceTimersByTimeAsync(APP_LIFECYCLE_CONFIG.SW_UPDATE_INITIAL_CHECK_DELAY_MS);

      expect(checkForUpdate).toHaveBeenCalledTimes(1);
      expect(context.logger.debug).toHaveBeenCalledWith(
        'SwUpdate checkForUpdate completed without new version',
        { reason: 'startup' },
      );
    } finally {
      context.teardownSwUpdateChecks();
      vi.useRealTimers();
    }
  });

  it('应对 focus/visibility/online 触发的版本检查做冷却去重', async () => {
    vi.useFakeTimers();
    setDocumentVisibilityState('visible');
    const checkForUpdate = vi.fn().mockResolvedValue(true);
    const context = createSwUpdateCheckContext(checkForUpdate);

    try {
      await context.checkForSwUpdate('focus');
      await context.checkForSwUpdate('online');
      await vi.advanceTimersByTimeAsync(APP_LIFECYCLE_CONFIG.SW_UPDATE_RESUME_CHECK_COOLDOWN_MS);
      await context.checkForSwUpdate('visibility');

      expect(checkForUpdate).toHaveBeenCalledTimes(2);
      expect(context.logger.info).toHaveBeenCalledWith(
        'SwUpdate checkForUpdate detected a deploy version',
        { reason: 'focus' },
      );
    } finally {
      context.teardownSwUpdateChecks();
      vi.useRealTimers();
    }
  });
});

describe('WorkspaceShellComponent 数据保护提醒', () => {
  it('应在没有现存提醒时展示备份提醒', () => {
    const info = vi.fn();
    const dismiss = vi.fn();
    const context = {
      toast: {
        messages: () => [],
        info,
        dismiss,
      },
    } as unknown as WorkspaceShellComponent;

    (WorkspaceShellComponent.prototype as unknown as {
      syncDataProtectionReminderToast: (this: WorkspaceShellComponent, shouldShowReminder: boolean) => void;
    }).syncDataProtectionReminderToast.call(context, true);

    expect(info).toHaveBeenCalledWith(
      '数据备份提醒',
      '已超过 7 天未完成数据备份，建议前往设置执行导出或本地备份。',
      { duration: 10000 },
    );
    expect(dismiss).not.toHaveBeenCalled();
  });

  it('应在提醒条件解除后关闭现有备份提醒', () => {
    const info = vi.fn();
    const dismiss = vi.fn();
    const context = {
      toast: {
        messages: () => [
          {
            id: 'backup-reminder',
            type: 'info',
            title: '数据备份提醒',
            message: '已超过 7 天未完成数据备份，建议前往设置执行导出或本地备份。',
          },
        ],
        info,
        dismiss,
      },
    } as unknown as WorkspaceShellComponent;

    (WorkspaceShellComponent.prototype as unknown as {
      syncDataProtectionReminderToast: (this: WorkspaceShellComponent, shouldShowReminder: boolean) => void;
    }).syncDataProtectionReminderToast.call(context, false);

    expect(dismiss).toHaveBeenCalledWith('backup-reminder');
    expect(info).not.toHaveBeenCalled();
  });
});

describe('WorkspaceShellComponent Android widget bootstrap', () => {
  type AndroidWidgetBootstrapContext = {
    widgetBinding: {
      completeAndroidBootstrap: ReturnType<typeof vi.fn>;
    };
    pendingAndroidWidgetBootstrap: { set: ReturnType<typeof vi.fn> };
    pendingAndroidWidgetManualCallback?: { set: ReturnType<typeof vi.fn> };
    deferredStartupEntryIntent: { set: ReturnType<typeof vi.fn> };
    navigateToAndroidWidgetCallback?: unknown;
    persistPendingAndroidWidgetBootstrapToStorage: ReturnType<typeof vi.fn>;
    persistDeferredStartupEntryIntentToStorage: ReturnType<typeof vi.fn>;
    logger: { warn: ReturnType<typeof vi.fn> };
    toast: { warning: ReturnType<typeof vi.fn> };
    beforeUnloadManager?: { suppressNextConfirmation: ReturnType<typeof vi.fn> };
    androidWidgetBootstrapInFlight: boolean;
  };

  function restoreDocumentProperty(
    key: 'referrer' | 'visibilityState',
    originalDescriptor: PropertyDescriptor | undefined,
  ): void {
    if (originalDescriptor) {
      Object.defineProperty(document, key, originalDescriptor);
      return;
    }

    Reflect.deleteProperty(document, key);
  }

  function restoreWindowProperty<T extends keyof Window>(
    key: T,
    originalValue: Window[T] | undefined,
  ): void {
    if (originalValue === undefined) {
      Reflect.deleteProperty(window, key);
      return;
    }

    Object.defineProperty(window, key, {
      configurable: true,
      value: originalValue,
    });
  }

  it('应接受 Android 浏览器中的 widget bootstrap fallback', () => {
    const originalReferrer = Object.getOwnPropertyDescriptor(document, 'referrer');
    const originalMatchMedia = window.matchMedia;

    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Linux; Android 14; 24018RPACC) AppleWebKit/537.36 Chrome/123.0.0.0 Mobile Safari/537.36',
    });
    Object.defineProperty(document, 'referrer', {
      configurable: true,
      get: () => '',
    });
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({
        matches: false,
        media: '',
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });

    try {
      const context = {
        pendingAndroidWidgetBootstrap: signal<unknown>(null),
      } as unknown as WorkspaceShellComponent;

      const result = (WorkspaceShellComponent.prototype as unknown as {
        isTrustedAndroidWidgetBootstrapSurface: (
          this: WorkspaceShellComponent,
          bootstrapRequest: {
            callbackUri: string;
            installationId: string;
            deviceId: string;
            deviceSecret: string;
            instanceId: string;
            hostInstanceId: string;
            sizeBucket: string;
            bootstrapNonce: string;
            pendingPushToken: string | null;
            clientVersion: string | null;
          },
          routeUrl: string | null,
        ) => boolean;
      }).isTrustedAndroidWidgetBootstrapSurface.call(
        context,
        {
          callbackUri: 'nanoflow-widget://bootstrap',
          clientVersion: 'android-widget/0.1.1',
          installationId: '11111111-1111-4111-8111-111111111111',
          deviceId: '22222222-2222-4222-8222-222222222222',
          deviceSecret: 'super-secret-device-key',
          instanceId: '33333333-3333-4333-8333-333333333333',
          hostInstanceId: '42',
          sizeBucket: '4x2',
          bootstrapNonce: '44444444-4444-4444-8444-444444444444',
          pendingPushToken: null,
        },
        '/projects?entry=twa&intent=open-workspace&widgetBootstrap=1'
        + '&widgetBootstrapReturnUri=nanoflow-widget%3A%2F%2Fbootstrap'
        + '&widgetInstallationId=11111111-1111-4111-8111-111111111111'
        + '&widgetDeviceId=22222222-2222-4222-8222-222222222222'
        + '&widgetDeviceSecret=super-secret-device-key'
        + '&widgetClientVersion=android-widget%2F0.1.1'
        + '&widgetInstanceId=33333333-3333-4333-8333-333333333333'
        + '&widgetHostInstanceId=42'
        + '&widgetSizeBucket=4x2'
        + '&widgetBootstrapNonce=44444444-4444-4444-8444-444444444444',
      );

      expect(result).toBe(true);
    } finally {
      restoreDocumentProperty('referrer', originalReferrer);
      restoreWindowProperty('matchMedia', originalMatchMedia);
      vi.unstubAllGlobals();
    }
  });

  it('应继续拒绝桌面浏览器中的非 TWA bootstrap 请求', () => {
    const originalReferrer = Object.getOwnPropertyDescriptor(document, 'referrer');
    const originalMatchMedia = window.matchMedia;

    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/123.0.0.0 Safari/537.36',
    });
    Object.defineProperty(document, 'referrer', {
      configurable: true,
      get: () => '',
    });
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({
        matches: false,
        media: '',
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });

    try {
      const context = {
        pendingAndroidWidgetBootstrap: signal<unknown>(null),
      } as unknown as WorkspaceShellComponent;

      const result = (WorkspaceShellComponent.prototype as unknown as {
        isTrustedAndroidWidgetBootstrapSurface: (
          this: WorkspaceShellComponent,
          bootstrapRequest: {
            callbackUri: string;
            installationId: string;
            deviceId: string;
            deviceSecret: string;
            instanceId: string;
            hostInstanceId: string;
            sizeBucket: string;
            bootstrapNonce: string;
            pendingPushToken: string | null;
            clientVersion: string | null;
          },
          routeUrl: string | null,
        ) => boolean;
      }).isTrustedAndroidWidgetBootstrapSurface.call(
        context,
        {
          callbackUri: 'nanoflow-widget://bootstrap',
          clientVersion: 'android-widget/0.1.1',
          installationId: '11111111-1111-4111-8111-111111111111',
          deviceId: '22222222-2222-4222-8222-222222222222',
          deviceSecret: 'super-secret-device-key',
          instanceId: '33333333-3333-4333-8333-333333333333',
          hostInstanceId: '42',
          sizeBucket: '4x2',
          bootstrapNonce: '44444444-4444-4444-8444-444444444444',
          pendingPushToken: null,
        },
        '/projects?entry=twa&intent=open-workspace&widgetBootstrap=1'
        + '&widgetBootstrapReturnUri=nanoflow-widget%3A%2F%2Fbootstrap'
        + '&widgetInstallationId=11111111-1111-4111-8111-111111111111'
        + '&widgetDeviceId=22222222-2222-4222-8222-222222222222'
        + '&widgetDeviceSecret=super-secret-device-key'
        + '&widgetClientVersion=android-widget%2F0.1.1'
        + '&widgetInstanceId=33333333-3333-4333-8333-333333333333'
        + '&widgetHostInstanceId=42'
        + '&widgetSizeBucket=4x2'
        + '&widgetBootstrapNonce=44444444-4444-4444-8444-444444444444',
      );

      expect(result).toBe(false);
    } finally {
      restoreDocumentProperty('referrer', originalReferrer);
      restoreWindowProperty('matchMedia', originalMatchMedia);
      vi.unstubAllGlobals();
    }
  });

  it('应捕获有效的 Android bootstrap 路由并清掉敏感 query', () => {
    const pendingAndroidWidgetBootstrap = signal<unknown>(null);
    const deferredStartupEntryIntent = signal<unknown>(null);
    const consumeStartupEntryIntent = vi.fn();
    const persistPendingAndroidWidgetBootstrapToStorage = vi.fn();
    const persistDeferredStartupEntryIntentToStorage = vi.fn();
    const context = {
      androidWidgetBootstrapCaptureKey: null,
      pendingAndroidWidgetBootstrap,
      deferredStartupEntryIntent,
      isTrustedAndroidWidgetBootstrapSurface: vi.fn(() => true),
      persistPendingAndroidWidgetBootstrapToStorage,
      persistDeferredStartupEntryIntentToStorage,
      consumeStartupEntryIntent,
      logger: { warn: vi.fn() },
    } as unknown as WorkspaceShellComponent & { androidWidgetBootstrapCaptureKey: string | null };

    const result = (WorkspaceShellComponent.prototype as unknown as {
      captureAndroidWidgetBootstrapFromRoute: (this: WorkspaceShellComponent, routeUrl: string | null) => boolean;
    }).captureAndroidWidgetBootstrapFromRoute.call(
      context,
      '/projects?entry=twa&intent=open-workspace&widgetBootstrap=1'
      + '&widgetBootstrapReturnUri=nanoflow-widget%3A%2F%2Fbootstrap'
      + '&widgetInstallationId=11111111-1111-4111-8111-111111111111'
      + '&widgetDeviceId=22222222-2222-4222-8222-222222222222'
      + '&widgetDeviceSecret=super-secret-device-key'
      + '&widgetInstanceId=33333333-3333-4333-8333-333333333333'
      + '&widgetHostInstanceId=42'
      + '&widgetSizeBucket=4x2'
      + '&widgetBootstrapNonce=44444444-4444-4444-8444-444444444444',
    );

    expect(result).toBe(true);
    expect(pendingAndroidWidgetBootstrap()).toEqual({
      callbackUri: 'nanoflow-widget://bootstrap',
      clientVersion: null,
      installationId: '11111111-1111-4111-8111-111111111111',
      deviceId: '22222222-2222-4222-8222-222222222222',
      deviceSecret: 'super-secret-device-key',
      instanceId: '33333333-3333-4333-8333-333333333333',
      hostInstanceId: '42',
      sizeBucket: '4x2',
      bootstrapNonce: '44444444-4444-4444-8444-444444444444',
      pendingPushToken: null,
    });
    expect(deferredStartupEntryIntent()).toEqual({
      entry: 'twa',
      intent: 'open-workspace',
      rawIntent: 'open-workspace',
      androidWidgetBootstrap: true,
      widgetGateEntryId: null,
    });
    expect(persistPendingAndroidWidgetBootstrapToStorage).toHaveBeenCalledWith({
      callbackUri: 'nanoflow-widget://bootstrap',
      clientVersion: null,
      installationId: '11111111-1111-4111-8111-111111111111',
      deviceId: '22222222-2222-4222-8222-222222222222',
      deviceSecret: 'super-secret-device-key',
      instanceId: '33333333-3333-4333-8333-333333333333',
      hostInstanceId: '42',
      sizeBucket: '4x2',
      bootstrapNonce: '44444444-4444-4444-8444-444444444444',
      pendingPushToken: null,
    });
    expect(persistDeferredStartupEntryIntentToStorage).toHaveBeenCalledWith({
      entry: 'twa',
      intent: 'open-workspace',
      rawIntent: 'open-workspace',
      androidWidgetBootstrap: true,
      widgetGateEntryId: null,
    });
    expect(consumeStartupEntryIntent).toHaveBeenCalledTimes(1);
  });

  it('应在不可信环境中忽略 Android bootstrap 请求', () => {
    const deferredStartupEntryIntent = signal<unknown>(null);
    const consumeStartupEntryIntent = vi.fn();
    const persistPendingAndroidWidgetBootstrapToStorage = vi.fn();
    const persistDeferredStartupEntryIntentToStorage = vi.fn();
    const warn = vi.fn();
    const context = {
      androidWidgetBootstrapCaptureKey: null,
      pendingAndroidWidgetBootstrap: signal<unknown>(null),
      deferredStartupEntryIntent,
      isTrustedAndroidWidgetBootstrapSurface: vi.fn(() => false),
      persistPendingAndroidWidgetBootstrapToStorage,
      persistDeferredStartupEntryIntentToStorage,
      consumeStartupEntryIntent,
      logger: { warn },
    } as unknown as WorkspaceShellComponent & { androidWidgetBootstrapCaptureKey: string | null };

    const result = (WorkspaceShellComponent.prototype as unknown as {
      captureAndroidWidgetBootstrapFromRoute: (this: WorkspaceShellComponent, routeUrl: string | null) => boolean;
    }).captureAndroidWidgetBootstrapFromRoute.call(
      context,
      '/projects?entry=twa&intent=open-workspace&widgetBootstrap=1'
      + '&widgetBootstrapReturnUri=nanoflow-widget%3A%2F%2Fbootstrap'
      + '&widgetInstallationId=11111111-1111-4111-8111-111111111111'
      + '&widgetDeviceId=22222222-2222-4222-8222-222222222222'
      + '&widgetDeviceSecret=super-secret-device-key'
      + '&widgetInstanceId=33333333-3333-4333-8333-333333333333'
      + '&widgetHostInstanceId=42'
      + '&widgetSizeBucket=4x2'
      + '&widgetBootstrapNonce=44444444-4444-4444-8444-444444444444',
    );

    expect(result).toBe(true);
    expect(persistPendingAndroidWidgetBootstrapToStorage).toHaveBeenCalledWith(null);
    expect(persistDeferredStartupEntryIntentToStorage).toHaveBeenCalledWith({
      entry: 'twa',
      intent: 'open-workspace',
      rawIntent: 'open-workspace',
      androidWidgetBootstrap: true,
      widgetGateEntryId: null,
    });
    expect(warn).toHaveBeenCalledWith('忽略不可信环境中的 Android widget bootstrap 请求');
    expect(consumeStartupEntryIntent).toHaveBeenCalledTimes(1);
  });

  it('应在 bootstrap 参数损坏时仍清掉敏感 query 并记录告警', () => {
    const deferredStartupEntryIntent = signal<unknown>(null);
    const consumeStartupEntryIntent = vi.fn();
    const persistPendingAndroidWidgetBootstrapToStorage = vi.fn();
    const persistDeferredStartupEntryIntentToStorage = vi.fn();
    const warn = vi.fn();
    const context = {
      androidWidgetBootstrapCaptureKey: null,
      pendingAndroidWidgetBootstrap: signal<unknown>(null),
      deferredStartupEntryIntent,
      persistPendingAndroidWidgetBootstrapToStorage,
      persistDeferredStartupEntryIntentToStorage,
      consumeStartupEntryIntent,
      logger: { warn },
    } as unknown as WorkspaceShellComponent & { androidWidgetBootstrapCaptureKey: string | null };

    const result = (WorkspaceShellComponent.prototype as unknown as {
      captureAndroidWidgetBootstrapFromRoute: (this: WorkspaceShellComponent, routeUrl: string | null) => boolean;
    }).captureAndroidWidgetBootstrapFromRoute.call(
      context,
      '/projects?entry=twa&intent=open-workspace&widgetBootstrap=1'
      + '&widgetBootstrapReturnUri=https%3A%2F%2Fevil.invalid%2Fcallback'
      + '&widgetInstallationId=11111111-1111-4111-8111-111111111111',
    );

    expect(result).toBe(true);
    expect(deferredStartupEntryIntent()).toEqual({
      entry: 'twa',
      intent: 'open-workspace',
      rawIntent: 'open-workspace',
      androidWidgetBootstrap: true,
      widgetGateEntryId: null,
    });
    expect(persistPendingAndroidWidgetBootstrapToStorage).toHaveBeenCalledWith(null);
    expect(persistDeferredStartupEntryIntentToStorage).toHaveBeenCalledWith({
      entry: 'twa',
      intent: 'open-workspace',
      rawIntent: 'open-workspace',
      androidWidgetBootstrap: true,
      widgetGateEntryId: null,
    });
    expect(warn).toHaveBeenCalledWith('忽略损坏的 Android widget bootstrap 参数');
    expect(consumeStartupEntryIntent).toHaveBeenCalledTimes(1);
  });

  it('应从 sessionStorage 恢复 pending Android bootstrap 和 startup intent', () => {
    window.sessionStorage.setItem('nanoflow.android-widget-bootstrap', JSON.stringify({
      callbackUri: 'nanoflow-widget://bootstrap',
      clientVersion: null,
      installationId: '11111111-1111-4111-8111-111111111111',
      deviceId: '22222222-2222-4222-8222-222222222222',
      deviceSecret: 'super-secret-device-key',
      instanceId: '33333333-3333-4333-8333-333333333333',
      hostInstanceId: '42',
      sizeBucket: '4x2',
      bootstrapNonce: '44444444-4444-4444-8444-444444444444',
      pendingPushToken: 'fcm-token',
    }));
    window.sessionStorage.setItem('nanoflow.android-widget-startup-intent', JSON.stringify({
      entry: 'twa',
      intent: 'open-focus-tools',
      rawIntent: 'open-focus-tools',
    }));

    const pendingAndroidWidgetBootstrap = signal<unknown>(null);
    const deferredStartupEntryIntent = signal<unknown>(null);
    const context = {
      pendingAndroidWidgetBootstrap,
      deferredStartupEntryIntent,
      persistPendingAndroidWidgetBootstrapToStorage: vi.fn(),
      persistDeferredStartupEntryIntentToStorage: vi.fn(),
      restoreDeferredStartupEntryIntentFromStorage: (WorkspaceShellComponent.prototype as unknown as {
        restoreDeferredStartupEntryIntentFromStorage: (this: WorkspaceShellComponent) => void;
      }).restoreDeferredStartupEntryIntentFromStorage,
    } as unknown as WorkspaceShellComponent;

    try {
      (WorkspaceShellComponent.prototype as unknown as {
        restorePendingAndroidWidgetBootstrapFromStorage: (this: WorkspaceShellComponent) => void;
      }).restorePendingAndroidWidgetBootstrapFromStorage.call(context);

      expect(pendingAndroidWidgetBootstrap()).toEqual({
        callbackUri: 'nanoflow-widget://bootstrap',
        clientVersion: null,
        installationId: '11111111-1111-4111-8111-111111111111',
        deviceId: '22222222-2222-4222-8222-222222222222',
        deviceSecret: 'super-secret-device-key',
        instanceId: '33333333-3333-4333-8333-333333333333',
        hostInstanceId: '42',
        sizeBucket: '4x2',
        bootstrapNonce: '44444444-4444-4444-8444-444444444444',
        pendingPushToken: 'fcm-token',
      });
      expect(deferredStartupEntryIntent()).toEqual({
        entry: 'twa',
        intent: 'open-focus-tools',
        rawIntent: 'open-focus-tools',
        widgetGateEntryId: null,
      });
    } finally {
      window.sessionStorage.removeItem('nanoflow.android-widget-bootstrap');
      window.sessionStorage.removeItem('nanoflow.android-widget-startup-intent');
    }
  });

  it('bootstrap 失败时应清理 pending 状态并提示重新打开小组件', async () => {
    const setPending = vi.fn();
    const setDeferredStartupEntryIntent = vi.fn();
    const warn = vi.fn();
    const warning = vi.fn();
    const persistPendingAndroidWidgetBootstrapToStorage = vi.fn();
    const persistDeferredStartupEntryIntentToStorage = vi.fn();
    const context: AndroidWidgetBootstrapContext = {
      widgetBinding: {
        completeAndroidBootstrap: vi.fn().mockResolvedValue({
          ok: false,
          error: {
            code: 'OPERATION_FAILED',
            message: 'network down',
          },
        }),
      },
      pendingAndroidWidgetBootstrap: { set: setPending },
      deferredStartupEntryIntent: { set: setDeferredStartupEntryIntent },
      persistPendingAndroidWidgetBootstrapToStorage,
      persistDeferredStartupEntryIntentToStorage,
      logger: { warn },
      toast: { warning },
      androidWidgetBootstrapInFlight: true,
    };

    await (WorkspaceShellComponent.prototype as unknown as {
      completeAndroidWidgetBootstrap: (this: WorkspaceShellComponent, bootstrapRequest: {
        callbackUri: string;
        installationId: string;
        deviceId: string;
        deviceSecret: string;
        instanceId: string;
        hostInstanceId: string;
        sizeBucket: string;
        bootstrapNonce: string;
        pendingPushToken: string | null;
      }) => Promise<void>;
    }).completeAndroidWidgetBootstrap.call(context as unknown as WorkspaceShellComponent, {
      callbackUri: 'nanoflow-widget://bootstrap',
      clientVersion: null,
      installationId: '11111111-1111-4111-8111-111111111111',
      deviceId: '22222222-2222-4222-8222-222222222222',
      deviceSecret: 'super-secret-device-key',
      instanceId: '33333333-3333-4333-8333-333333333333',
      hostInstanceId: '42',
      sizeBucket: '4x2',
      bootstrapNonce: '44444444-4444-4444-8444-444444444444',
      pendingPushToken: null,
    });

    expect(context.androidWidgetBootstrapInFlight).toBe(false);
    expect(setPending).toHaveBeenCalledWith(null);
    expect(setDeferredStartupEntryIntent).toHaveBeenCalledWith(null);
    expect(persistPendingAndroidWidgetBootstrapToStorage).toHaveBeenCalledWith(null);
    expect(persistDeferredStartupEntryIntentToStorage).toHaveBeenCalledWith(null);
    expect(warn).toHaveBeenCalledWith('Android widget bootstrap 失败', {
      code: 'OPERATION_FAILED',
      message: 'network down',
      hostInstanceId: '42',
    });
    expect(warning).toHaveBeenCalledWith('Android 小组件初始化失败', '绑定未完成，请重新打开 NanoFlow 小组件');
  });

  it('bootstrap 成功时应清理 pending 状态并跳转到 native callback', async () => {
    const originalLocation = window.location;
    const assign = vi.fn();
    const replace = vi.fn();

    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, assign, replace } as Location,
    });

    try {
      const setPending = vi.fn();
      const setDeferredStartupEntryIntent = vi.fn();
      const setPendingManualCallback = vi.fn();
      const persistPendingAndroidWidgetBootstrapToStorage = vi.fn();
      const persistDeferredStartupEntryIntentToStorage = vi.fn();
      const context: AndroidWidgetBootstrapContext = {
        widgetBinding: {
          completeAndroidBootstrap: vi.fn().mockResolvedValue({
            ok: true,
            value: {
              callbackUrl: 'nanoflow-widget://bootstrap?widgetToken=android-token',
              callbackIntentUrl: 'intent://bootstrap?widgetToken=android-token#Intent;scheme=nanoflow-widget;package=app.nanoflow.twa;end',
            },
          }),
        },
        pendingAndroidWidgetBootstrap: { set: setPending },
        pendingAndroidWidgetManualCallback: { set: setPendingManualCallback },
        deferredStartupEntryIntent: { set: setDeferredStartupEntryIntent },
        navigateToAndroidWidgetCallback: (WorkspaceShellComponent.prototype as unknown as Record<string, unknown>)['navigateToAndroidWidgetCallback'],
        persistPendingAndroidWidgetBootstrapToStorage,
        persistDeferredStartupEntryIntentToStorage,
        logger: { warn: vi.fn() },
        toast: { warning: vi.fn() },
        androidWidgetBootstrapInFlight: true,
      };

      await (WorkspaceShellComponent.prototype as unknown as {
        completeAndroidWidgetBootstrap: (this: WorkspaceShellComponent, bootstrapRequest: {
          callbackUri: string;
          installationId: string;
          deviceId: string;
          deviceSecret: string;
          instanceId: string;
          hostInstanceId: string;
          sizeBucket: string;
          bootstrapNonce: string;
          pendingPushToken: string | null;
        }) => Promise<void>;
      }).completeAndroidWidgetBootstrap.call(context as unknown as WorkspaceShellComponent, {
        callbackUri: 'nanoflow-widget://bootstrap',
        clientVersion: null,
        installationId: '11111111-1111-4111-8111-111111111111',
        deviceId: '22222222-2222-4222-8222-222222222222',
        deviceSecret: 'super-secret-device-key',
        instanceId: '33333333-3333-4333-8333-333333333333',
        hostInstanceId: '42',
        sizeBucket: '4x2',
        bootstrapNonce: '44444444-4444-4444-8444-444444444444',
        pendingPushToken: null,
      });

      expect(context.androidWidgetBootstrapInFlight).toBe(false);
      expect(setPending).toHaveBeenCalledWith(null);
      expect(setDeferredStartupEntryIntent).toHaveBeenCalledWith(null);
      expect(persistPendingAndroidWidgetBootstrapToStorage).toHaveBeenCalledWith(null);
      expect(persistDeferredStartupEntryIntentToStorage).toHaveBeenCalledWith(null);
      expect(setPendingManualCallback).not.toHaveBeenCalled();
      expect(assign).toHaveBeenCalledWith('nanoflow-widget://bootstrap?widgetToken=android-token');
      expect(replace).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: originalLocation,
      });
    }
  });

  it('bootstrap 成功时 TWA 环境应直接回跳 native callback', async () => {
    const originalLocation = window.location;
    const originalReferrer = Object.getOwnPropertyDescriptor(document, 'referrer');
    const originalMatchMedia = window.matchMedia;
    const assign = vi.fn();
    const replace = vi.fn();

    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Linux; Android 14; 24018RPACC) AppleWebKit/537.36 Chrome/123.0.0.0 Mobile Safari/537.36',
    });
    Object.defineProperty(document, 'referrer', {
      configurable: true,
      get: () => 'android-app://app.nanoflow.twa',
    });
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn((query: string) => ({
        matches: query === '(display-mode: standalone)',
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        ...originalLocation,
        href: 'https://dde-eight.vercel.app/#/projects?entry=twa&intent=open-workspace',
        assign,
        replace,
      } as Location,
    });

    try {
      const setPending = vi.fn();
      const setDeferredStartupEntryIntent = vi.fn();
      const setPendingManualCallback = vi.fn();
      const persistPendingAndroidWidgetBootstrapToStorage = vi.fn();
      const persistDeferredStartupEntryIntentToStorage = vi.fn();
      const warn = vi.fn();
      const context: AndroidWidgetBootstrapContext = {
        widgetBinding: {
          completeAndroidBootstrap: vi.fn().mockResolvedValue({
            ok: true,
            value: {
              callbackUrl: 'nanoflow-widget://bootstrap?widgetToken=android-token',
              callbackIntentUrl: 'intent://bootstrap?widgetToken=android-token#Intent;scheme=nanoflow-widget;package=app.nanoflow.twa;end',
            },
          }),
        },
        pendingAndroidWidgetBootstrap: { set: setPending },
        pendingAndroidWidgetManualCallback: { set: setPendingManualCallback },
        deferredStartupEntryIntent: { set: setDeferredStartupEntryIntent },
        navigateToAndroidWidgetCallback: (WorkspaceShellComponent.prototype as unknown as Record<string, unknown>)['navigateToAndroidWidgetCallback'],
        persistPendingAndroidWidgetBootstrapToStorage,
        persistDeferredStartupEntryIntentToStorage,
        logger: { warn },
        toast: { warning: vi.fn() },
        androidWidgetBootstrapInFlight: true,
      };

      await (WorkspaceShellComponent.prototype as unknown as {
        completeAndroidWidgetBootstrap: (this: WorkspaceShellComponent, bootstrapRequest: {
          callbackUri: string;
          installationId: string;
          deviceId: string;
          deviceSecret: string;
          instanceId: string;
          hostInstanceId: string;
          sizeBucket: string;
          bootstrapNonce: string;
          pendingPushToken: string | null;
        }) => Promise<void>;
      }).completeAndroidWidgetBootstrap.call(context as unknown as WorkspaceShellComponent, {
        callbackUri: 'nanoflow-widget://bootstrap',
        clientVersion: null,
        installationId: '11111111-1111-4111-8111-111111111111',
        deviceId: '22222222-2222-4222-8222-222222222222',
        deviceSecret: 'super-secret-device-key',
        instanceId: '33333333-3333-4333-8333-333333333333',
        hostInstanceId: '42',
        sizeBucket: '4x2',
        bootstrapNonce: '44444444-4444-4444-8444-444444444444',
        pendingPushToken: null,
      });

      expect(context.androidWidgetBootstrapInFlight).toBe(false);
      expect(setPending).toHaveBeenCalledWith(null);
      expect(setDeferredStartupEntryIntent).toHaveBeenCalledWith(null);
      expect(persistPendingAndroidWidgetBootstrapToStorage).toHaveBeenCalledWith(null);
      expect(persistDeferredStartupEntryIntentToStorage).toHaveBeenCalledWith(null);
      expect(setPendingManualCallback).not.toHaveBeenCalled();
      expect(assign).toHaveBeenCalledWith('nanoflow-widget://bootstrap?widgetToken=android-token');
      expect(replace).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalledWith('Android widget callback 改为等待用户显式回跳');
    } finally {
      restoreDocumentProperty('referrer', originalReferrer);
      restoreWindowProperty('matchMedia', originalMatchMedia);
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: originalLocation,
      });
      vi.unstubAllGlobals();
    }
  });

  it('bootstrap 成功时 Android 浏览器应改为等待用户显式回跳', async () => {
    const originalLocation = window.location;
    const originalMatchMedia = window.matchMedia;
    const originalReferrer = Object.getOwnPropertyDescriptor(document, 'referrer');
    const originalVisibilityState = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    const assign = vi.fn();
    const replace = vi.fn();

    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Linux; Android 14; 24018RPACC) AppleWebKit/537.36 Chrome/123.0.0.0 Mobile Safari/537.36',
    });
    Object.defineProperty(document, 'referrer', {
      configurable: true,
      get: () => '',
    });
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn((query: string) => ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        ...originalLocation,
        href: 'https://dde-eight.vercel.app/#/projects',
        assign,
        replace,
      } as Location,
    });

    try {
      const setPending = vi.fn();
      const setDeferredStartupEntryIntent = vi.fn();
      const setPendingManualCallback = vi.fn();
      const persistPendingAndroidWidgetBootstrapToStorage = vi.fn();
      const persistDeferredStartupEntryIntentToStorage = vi.fn();
      const warn = vi.fn();
      const context: AndroidWidgetBootstrapContext = {
        widgetBinding: {
          completeAndroidBootstrap: vi.fn().mockResolvedValue({
            ok: true,
            value: {
              callbackUrl: 'nanoflow-widget://bootstrap?widgetToken=android-token',
              callbackIntentUrl: 'intent://bootstrap?widgetToken=android-token#Intent;scheme=nanoflow-widget;package=app.nanoflow.twa;end',
            },
          }),
        },
        pendingAndroidWidgetBootstrap: { set: setPending },
        pendingAndroidWidgetManualCallback: { set: setPendingManualCallback },
        deferredStartupEntryIntent: { set: setDeferredStartupEntryIntent },
        navigateToAndroidWidgetCallback: (WorkspaceShellComponent.prototype as unknown as Record<string, unknown>)['navigateToAndroidWidgetCallback'],
        persistPendingAndroidWidgetBootstrapToStorage,
        persistDeferredStartupEntryIntentToStorage,
        logger: { warn },
        toast: { warning: vi.fn() },
        androidWidgetBootstrapInFlight: true,
      };

      await (WorkspaceShellComponent.prototype as unknown as {
        completeAndroidWidgetBootstrap: (this: WorkspaceShellComponent, bootstrapRequest: {
          callbackUri: string;
          installationId: string;
          deviceId: string;
          deviceSecret: string;
          instanceId: string;
          hostInstanceId: string;
          sizeBucket: string;
          bootstrapNonce: string;
          pendingPushToken: string | null;
        }) => Promise<void>;
      }).completeAndroidWidgetBootstrap.call(context as unknown as WorkspaceShellComponent, {
        callbackUri: 'nanoflow-widget://bootstrap',
        clientVersion: null,
        installationId: '11111111-1111-4111-8111-111111111111',
        deviceId: '22222222-2222-4222-8222-222222222222',
        deviceSecret: 'super-secret-device-key',
        instanceId: '33333333-3333-4333-8333-333333333333',
        hostInstanceId: '42',
        sizeBucket: '4x2',
        bootstrapNonce: '44444444-4444-4444-8444-444444444444',
        pendingPushToken: null,
      });

      expect(context.androidWidgetBootstrapInFlight).toBe(false);
      expect(setPending).toHaveBeenCalledWith(null);
      expect(setDeferredStartupEntryIntent).toHaveBeenCalledWith(null);
      expect(persistPendingAndroidWidgetBootstrapToStorage).toHaveBeenCalledWith(null);
      expect(persistDeferredStartupEntryIntentToStorage).toHaveBeenCalledWith(null);
      expect(setPendingManualCallback).toHaveBeenCalledWith({
        callbackUrl: 'nanoflow-widget://bootstrap?widgetToken=android-token',
        callbackIntentUrl: 'intent://bootstrap?widgetToken=android-token#Intent;scheme=nanoflow-widget;package=app.nanoflow.twa;end',
      });
      expect(assign).not.toHaveBeenCalled();
      expect(replace).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith('Android widget callback 改为等待用户显式回跳');
    } finally {
      restoreDocumentProperty('referrer', originalReferrer);
      restoreDocumentProperty('visibilityState', originalVisibilityState);
      restoreWindowProperty('matchMedia', originalMatchMedia);
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: originalLocation,
      });
      vi.unstubAllGlobals();
    }
  });

  it('显式 callback 回跳应在用户手势内直接使用 package-scoped intent URL', () => {
    const originalLocation = window.location;
    const assign = vi.fn();
    const replace = vi.fn();
    const suppressNextConfirmation = vi.fn();
    const setPendingManualCallback = vi.fn();
    const pendingAndroidWidgetManualCallback = Object.assign(
      vi.fn(() => ({
        callbackUrl: 'nanoflow-widget://bootstrap?widgetToken=android-token',
        callbackIntentUrl: 'intent://bootstrap?widgetToken=android-token#Intent;scheme=nanoflow-widget;package=app.nanoflow.twa;end',
      })),
      { set: setPendingManualCallback },
    );

    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, assign, replace } as Location,
    });

    try {
      const context = {
        pendingAndroidWidgetManualCallback,
        beforeUnloadManager: { suppressNextConfirmation },
        logger: { warn: vi.fn() },
      } as unknown as WorkspaceShellComponent;

      WorkspaceShellComponent.prototype.continueAndroidWidgetManualCallback.call(context);

      expect(suppressNextConfirmation).toHaveBeenCalledTimes(1);
      expect(setPendingManualCallback).toHaveBeenCalledWith(null);
      expect(assign).toHaveBeenCalledWith('intent://bootstrap?widgetToken=android-token#Intent;scheme=nanoflow-widget;package=app.nanoflow.twa;end');
      expect(replace).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: originalLocation,
      });
    }
  });

  it('intent fallback 回跳前应跳过一次 beforeunload 确认', () => {
    const originalLocation = window.location;
    const replace = vi.fn();
    const suppressNextConfirmation = vi.fn();
    const setPendingManualCallback = vi.fn();
    const pendingAndroidWidgetManualCallback = Object.assign(
      vi.fn(() => ({
        callbackUrl: 'nanoflow-widget://bootstrap?widgetToken=android-token',
        callbackIntentUrl: 'intent://bootstrap?widgetToken=android-token#Intent;scheme=nanoflow-widget;package=app.nanoflow.twa;end',
      })),
      { set: setPendingManualCallback },
    );

    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, replace } as Location,
    });

    try {
      const context = {
        pendingAndroidWidgetManualCallback,
        beforeUnloadManager: { suppressNextConfirmation },
        logger: { warn: vi.fn() },
      } as unknown as WorkspaceShellComponent;

      WorkspaceShellComponent.prototype.useAndroidWidgetIntentFallback.call(context);

      expect(suppressNextConfirmation).toHaveBeenCalledTimes(1);
      expect(setPendingManualCallback).toHaveBeenCalledWith(null);
      expect(replace).toHaveBeenCalledWith('intent://bootstrap?widgetToken=android-token#Intent;scheme=nanoflow-widget;package=app.nanoflow.twa;end');
    } finally {
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: originalLocation,
      });
    }
  });
});

describe('WorkspaceShellComponent 输入事件处理', () => {
  it('onUnifiedSearchInput 应转发输入值到 onUnifiedSearchChange', () => {
    const onUnifiedSearchChange = vi.fn();
    const context = { onUnifiedSearchChange } as unknown as WorkspaceShellComponent;
    const event = { target: { value: 'roadmap' } } as unknown as Event;

    WorkspaceShellComponent.prototype.onUnifiedSearchInput.call(context, event);

    expect(onUnifiedSearchChange).toHaveBeenCalledWith('roadmap');
  });

  it('onRenameProjectNameInput 应更新 renameProjectName signal', () => {
    const set = vi.fn();
    const context = {
      projectCoord: {
        renameProjectName: { set },
      },
    } as unknown as WorkspaceShellComponent;
    const event = { target: { value: 'New Name' } } as unknown as Event;

    WorkspaceShellComponent.prototype.onRenameProjectNameInput.call(context, event);

    expect(set).toHaveBeenCalledWith('New Name');
  });

  it('onProjectDescriptionInput 应调用 updateProjectDraft 写入 description', () => {
    const updateProjectDraft = vi.fn();
    const context = { updateProjectDraft } as unknown as WorkspaceShellComponent;
    const event = { target: { value: 'Project intro' } } as unknown as Event;

    WorkspaceShellComponent.prototype.onProjectDescriptionInput.call(context, 'proj-1', event);

    expect(updateProjectDraft).toHaveBeenCalledWith('proj-1', 'description', 'Project intro');
  });

  it('onProjectDescriptionInput 在 hint-only 期间不应继续写入本地草稿', () => {
    const updateProjectDraft = vi.fn();
    const context = {
      userSession: {
        isHintOnlyStartupPlaceholderVisible: () => true,
      },
      projectCoord: {
        updateProjectDraft,
      },
      updateProjectDraft: WorkspaceShellComponent.prototype.updateProjectDraft,
    } as unknown as WorkspaceShellComponent;
    const event = { target: { value: 'Project intro' } } as unknown as Event;

    WorkspaceShellComponent.prototype.onProjectDescriptionInput.call(context, 'proj-1', event);

    expect(updateProjectDraft).not.toHaveBeenCalled();
  });

  it('onSearchTaskClick 命中停泊任务时应直接展开停泊坞并预览任务', () => {
    const switchActiveProject = vi.fn();
    const setDockExpanded = vi.fn();
    const previewTask = vi.fn();
    const context = {
      taskStore: {
        getTaskProjectId: () => 'project-1',
      },
      projectState: {
        activeProjectId: () => 'project-2',
      },
      userSession: {
        switchActiveProject,
      },
      dockEngine: {
        setDockExpanded,
      },
      parkingService: {
        previewTask,
      },
    } as unknown as WorkspaceShellComponent;

    WorkspaceShellComponent.prototype.onSearchTaskClick.call(context, 'task-1', true);

    expect(switchActiveProject).toHaveBeenCalledWith('project-1');
    expect(setDockExpanded).toHaveBeenCalledWith(true, { persistPreference: false });
    expect(previewTask).toHaveBeenCalledWith('task-1');
  });

  it('triggerSyncPulse 在同步层未就绪时不应提前懒加载 pulse 服务', async () => {
    const getEventDrivenSyncPulseLazy = vi.fn();
    const context = {
      isSyncPulseReady: () => false,
      getEventDrivenSyncPulseLazy,
    } as unknown as WorkspaceShellComponent;

    await (WorkspaceShellComponent.prototype as unknown as {
      triggerSyncPulse: (
        this: WorkspaceShellComponent,
        reason: 'focus-entry' | 'manual' | 'focus' | 'visible' | 'pageshow' | 'online' | 'heartbeat'
      ) => Promise<unknown>;
    }).triggerSyncPulse.call(context, 'focus-entry');

    expect(getEventDrivenSyncPulseLazy).not.toHaveBeenCalled();
  });

  it('dispatchFocusEntrySyncPulseIfReady 应在 pulse 成功后标记为已派发', async () => {
    const triggerSyncPulse = vi.fn().mockResolvedValue({ status: 'success' });
    const clearFocusEntrySyncPulseRetry = vi.fn();
    const scheduleFocusEntrySyncPulseRetry = vi.fn();
    const context = {
      focusModeIntentActivated: () => true,
      focusEntryPulseDispatched: false,
      focusEntryPulsePending: false,
      isSyncPulseReady: () => true,
      clearFocusEntrySyncPulseRetry,
      scheduleFocusEntrySyncPulseRetry,
      triggerSyncPulse,
    } as unknown as {
      focusEntryPulseDispatched: boolean;
      focusEntryPulsePending: boolean;
    };

    (WorkspaceShellComponent.prototype as unknown as {
      dispatchFocusEntrySyncPulseIfReady: (this: unknown) => void;
    }).dispatchFocusEntrySyncPulseIfReady.call(context);

    await Promise.resolve();
    await Promise.resolve();

    expect(clearFocusEntrySyncPulseRetry).toHaveBeenCalledTimes(1);
    expect(triggerSyncPulse).toHaveBeenCalledWith('focus-entry');
    expect(context.focusEntryPulseDispatched).toBe(true);
    expect(context.focusEntryPulsePending).toBe(false);
    expect(scheduleFocusEntrySyncPulseRetry).not.toHaveBeenCalled();
  });

  it('dispatchFocusEntrySyncPulseIfReady 在 pulse 被 cooldown 跳过时应保留补发机会', async () => {
    const triggerSyncPulse = vi.fn().mockResolvedValue({
      status: 'skipped',
      skipReason: 'cooldown',
      retryAfterMs: 250,
    });
    const clearFocusEntrySyncPulseRetry = vi.fn();
    const scheduleFocusEntrySyncPulseRetry = vi.fn();
    const context = {
      focusModeIntentActivated: () => true,
      focusEntryPulseDispatched: false,
      focusEntryPulsePending: false,
      isSyncPulseReady: () => true,
      clearFocusEntrySyncPulseRetry,
      scheduleFocusEntrySyncPulseRetry,
      triggerSyncPulse,
    } as unknown as {
      focusEntryPulseDispatched: boolean;
      focusEntryPulsePending: boolean;
    };

    (WorkspaceShellComponent.prototype as unknown as {
      dispatchFocusEntrySyncPulseIfReady: (this: unknown) => void;
    }).dispatchFocusEntrySyncPulseIfReady.call(context);

    await Promise.resolve();
    await Promise.resolve();

    expect(clearFocusEntrySyncPulseRetry).toHaveBeenCalledTimes(1);
    expect(triggerSyncPulse).toHaveBeenCalledWith('focus-entry');
    expect(context.focusEntryPulseDispatched).toBe(false);
    expect(context.focusEntryPulsePending).toBe(false);
    expect(scheduleFocusEntrySyncPulseRetry).toHaveBeenCalledWith('cooldown', 250);
  });

  it('resetFocusEntrySyncPulseState 应重置会话级 focus-entry 状态并重新挂回首个交互监听', () => {
    const set = vi.fn();
    const clearFocusEntrySyncPulseRetry = vi.fn();
    const teardownFocusMountIntentListener = vi.fn();
    const setupFocusMountIntentListener = vi.fn();
    const context = {
      clearFocusEntrySyncPulseRetry,
      focusEntryPulsePending: true,
      focusEntryPulseDispatched: true,
      focusModeIntentActivated: { set },
      teardownFocusMountIntentListener,
      setupFocusMountIntentListener,
    } as unknown as {
      focusEntryPulsePending: boolean;
      focusEntryPulseDispatched: boolean;
    };

    (WorkspaceShellComponent.prototype as unknown as {
      resetFocusEntrySyncPulseState: (this: unknown) => void;
    }).resetFocusEntrySyncPulseState.call(context);

    expect(clearFocusEntrySyncPulseRetry).toHaveBeenCalledTimes(1);
    expect(context.focusEntryPulsePending).toBe(false);
    expect(context.focusEntryPulseDispatched).toBe(false);
    expect(set).toHaveBeenCalledWith(!FEATURE_FLAGS.FOCUS_STARTUP_THROTTLED_CHECK_V1);
    expect(teardownFocusMountIntentListener).toHaveBeenCalledTimes(1);
    expect(setupFocusMountIntentListener).toHaveBeenCalledTimes(1);
  });

  it('手机端项目入口应立即触发 Focus 大门检查', () => {
    const set = vi.fn();
    const preloadFocusModeAssets = vi.fn().mockResolvedValue(undefined);
    const dispatchFocusEntrySyncPulseIfReady = vi.fn();
    const teardownFocusMountIntentListener = vi.fn();
    const checkGateForProjectEntry = vi.fn();
    const context = {
      uiState: { isMobile: () => true },
      currentUserId: () => 'user-1',
      focusModeIntentActivated: { set },
      preloadFocusModeAssets,
      dispatchFocusEntrySyncPulseIfReady,
      teardownFocusMountIntentListener,
      focusStartupProbe: { checkGateForProjectEntry },
      pendingMobileProjectGateCheck: false,
    } as unknown as WorkspaceShellComponent;

    (WorkspaceShellComponent.prototype as unknown as {
      checkGateForMobileProjectEntry: (this: WorkspaceShellComponent) => void;
    }).checkGateForMobileProjectEntry.call(context);

    expect(set).toHaveBeenCalledWith(true);
    expect(preloadFocusModeAssets).toHaveBeenCalledWith('intent');
    expect(dispatchFocusEntrySyncPulseIfReady).toHaveBeenCalledTimes(1);
    expect(teardownFocusMountIntentListener).toHaveBeenCalledTimes(1);
    expect(checkGateForProjectEntry).toHaveBeenCalledTimes(1);
    expect((context as unknown as { pendingMobileProjectGateCheck: boolean }).pendingMobileProjectGateCheck).toBe(false);
  });

  it('手机端启动应预热项目入口 Gate 本地快照', () => {
    const warmProjectEntryGateSnapshot = vi.fn();
    const context = {
      uiState: { isMobile: () => true },
      focusStartupProbe: { warmProjectEntryGateSnapshot },
    } as unknown as WorkspaceShellComponent;

    (WorkspaceShellComponent.prototype as unknown as {
      warmMobileProjectGateSnapshot: (this: WorkspaceShellComponent) => void;
    }).warmMobileProjectGateSnapshot.call(context);

    expect(warmProjectEntryGateSnapshot).toHaveBeenCalledTimes(1);
  });

  it('手机端项目入口在用户未确认时应挂起 Gate 检查', () => {
    const context = {
      uiState: { isMobile: () => true },
      currentUserId: () => null,
      focusModeIntentActivated: { set: vi.fn() },
      preloadFocusModeAssets: vi.fn().mockResolvedValue(undefined),
      dispatchFocusEntrySyncPulseIfReady: vi.fn(),
      teardownFocusMountIntentListener: vi.fn(),
      focusStartupProbe: { checkGateForProjectEntry: vi.fn() },
      pendingMobileProjectGateCheck: false,
    } as {
      pendingMobileProjectGateCheck: boolean;
      focusStartupProbe: { checkGateForProjectEntry: ReturnType<typeof vi.fn> };
    } & Record<string, unknown>;

    (WorkspaceShellComponent.prototype as unknown as {
      checkGateForMobileProjectEntry: (this: WorkspaceShellComponent) => void;
    }).checkGateForMobileProjectEntry.call(context as unknown as WorkspaceShellComponent);

    expect(context.pendingMobileProjectGateCheck).toBe(true);
    expect(context.focusStartupProbe.checkGateForProjectEntry).not.toHaveBeenCalled();
  });

  it('手机端用户确认后应补跑挂起的项目入口 Gate 检查', () => {
    const checkGateForProjectEntry = vi.fn();
    const context = {
      uiState: { isMobile: () => true },
      currentUserId: () => 'user-1',
      focusStartupProbe: { checkGateForProjectEntry },
      pendingMobileProjectGateCheck: true,
    } as {
      pendingMobileProjectGateCheck: boolean;
      focusStartupProbe: { checkGateForProjectEntry: ReturnType<typeof vi.fn> };
    } & Record<string, unknown>;

    (WorkspaceShellComponent.prototype as unknown as {
      flushPendingMobileProjectGateCheck: (this: WorkspaceShellComponent) => void;
    }).flushPendingMobileProjectGateCheck.call(context as unknown as WorkspaceShellComponent);

    expect(context.pendingMobileProjectGateCheck).toBe(false);
    expect(checkGateForProjectEntry).toHaveBeenCalledTimes(1);
  });

  it('桌面端项目入口不应触发手机 Gate 快速检查', () => {
    const set = vi.fn();
    const preloadFocusModeAssets = vi.fn().mockResolvedValue(undefined);
    const dispatchFocusEntrySyncPulseIfReady = vi.fn();
    const teardownFocusMountIntentListener = vi.fn();
    const checkGateForProjectEntry = vi.fn();
    const context = {
      uiState: { isMobile: () => false },
      focusModeIntentActivated: { set },
      preloadFocusModeAssets,
      dispatchFocusEntrySyncPulseIfReady,
      teardownFocusMountIntentListener,
      focusStartupProbe: { checkGateForProjectEntry },
    } as unknown as WorkspaceShellComponent;

    (WorkspaceShellComponent.prototype as unknown as {
      checkGateForMobileProjectEntry: (this: WorkspaceShellComponent) => void;
    }).checkGateForMobileProjectEntry.call(context);

    expect(set).not.toHaveBeenCalled();
    expect(preloadFocusModeAssets).not.toHaveBeenCalled();
    expect(dispatchFocusEntrySyncPulseIfReady).not.toHaveBeenCalled();
    expect(teardownFocusMountIntentListener).not.toHaveBeenCalled();
    expect(checkGateForProjectEntry).not.toHaveBeenCalled();
  });

  it('dispatchFocusEntrySyncPulseIfReady 在 owner 切换后不应让旧 promise 回写新会话状态', async () => {
    let resolvePulse: ((value: { status: 'success' }) => void) | null = null;
    const triggerSyncPulse = vi.fn().mockImplementation(() => new Promise((resolve) => {
      resolvePulse = resolve as (value: { status: 'success' }) => void;
    }));
    const clearFocusEntrySyncPulseRetry = vi.fn();
    const teardownFocusMountIntentListener = vi.fn();
    const setupFocusMountIntentListener = vi.fn();
    const set = vi.fn();
    const focusModeIntentActivated = Object.assign(() => true, { set });
    const context = {
      focusModeIntentActivated,
      focusEntryPulseGeneration: 0,
      focusEntryPulseDispatched: false,
      focusEntryPulsePending: false,
      isSyncPulseReady: () => true,
      clearFocusEntrySyncPulseRetry,
      scheduleFocusEntrySyncPulseRetry: vi.fn(),
      triggerSyncPulse,
      teardownFocusMountIntentListener,
      setupFocusMountIntentListener,
    } as unknown as {
      focusEntryPulseGeneration: number;
      focusEntryPulseDispatched: boolean;
      focusEntryPulsePending: boolean;
    };

    (WorkspaceShellComponent.prototype as unknown as {
      dispatchFocusEntrySyncPulseIfReady: (this: unknown) => void;
    }).dispatchFocusEntrySyncPulseIfReady.call(context);

    expect(context.focusEntryPulsePending).toBe(true);

    (WorkspaceShellComponent.prototype as unknown as {
      resetFocusEntrySyncPulseState: (this: unknown, rearmIntentListener?: boolean) => void;
    }).resetFocusEntrySyncPulseState.call(context, true);

    resolvePulse!({ status: 'success' });
    await Promise.resolve();
    await Promise.resolve();

    expect(context.focusEntryPulseDispatched).toBe(false);
    expect(context.focusEntryPulsePending).toBe(false);
    expect(context.focusEntryPulseGeneration).toBe(1);
  });

  it('dispatchFocusEntrySyncPulseIfReady 应在同步层就绪后只补发一次 focus-entry', async () => {
    const triggerSyncPulse = vi.fn().mockResolvedValue({ status: 'success' });
    const clearFocusEntrySyncPulseRetry = vi.fn();
    const scheduleFocusEntrySyncPulseRetry = vi.fn();
    const context = {
      focusModeIntentActivated: () => true,
      focusEntryPulseDispatched: false,
      focusEntryPulsePending: false,
      isSyncPulseReady: () => true,
      clearFocusEntrySyncPulseRetry,
      scheduleFocusEntrySyncPulseRetry,
      triggerSyncPulse,
    } as unknown as {
      focusEntryPulseDispatched: boolean;
      focusEntryPulsePending: boolean;
    };

    (WorkspaceShellComponent.prototype as unknown as {
      dispatchFocusEntrySyncPulseIfReady: (this: unknown) => void;
    }).dispatchFocusEntrySyncPulseIfReady.call(context);

    await Promise.resolve();
    await Promise.resolve();

    expect(triggerSyncPulse).toHaveBeenCalledTimes(1);

    triggerSyncPulse.mockClear();
    (WorkspaceShellComponent.prototype as unknown as {
      dispatchFocusEntrySyncPulseIfReady: (this: unknown) => void;
    }).dispatchFocusEntrySyncPulseIfReady.call(context);

    await Promise.resolve();
    await Promise.resolve();

    expect(triggerSyncPulse).not.toHaveBeenCalled();
  });

  it('focus workspace takeover 应覆盖进入与退出过渡', () => {
    const enteringContext = {
      resolveFocusWorkspaceTakeoverPhase: () => 'entering',
    } as unknown as WorkspaceShellComponent;
    const exitingContext = {
      resolveFocusWorkspaceTakeoverPhase: () => 'exiting',
    } as unknown as WorkspaceShellComponent;
    const idleContext = {
      resolveFocusWorkspaceTakeoverPhase: () => 'idle',
    } as unknown as WorkspaceShellComponent;
    const restoringContext = {
      resolveFocusWorkspaceTakeoverPhase: () => 'restoring',
    } as unknown as WorkspaceShellComponent;

    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        resolveFocusWorkspaceTakeoverActive: (this: WorkspaceShellComponent) => boolean;
      }).resolveFocusWorkspaceTakeoverActive.call(enteringContext),
    ).toBe(true);
    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        resolveFocusWorkspaceTakeoverActive: (this: WorkspaceShellComponent) => boolean;
      }).resolveFocusWorkspaceTakeoverActive.call(exitingContext),
    ).toBe(true);
    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        resolveFocusWorkspaceTakeoverActive: (this: WorkspaceShellComponent) => boolean;
      }).resolveFocusWorkspaceTakeoverActive.call(idleContext),
    ).toBe(false);
    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        resolveFocusWorkspaceTakeoverActive: (this: WorkspaceShellComponent) => boolean;
      }).resolveFocusWorkspaceTakeoverActive.call(restoringContext),
    ).toBe(true);
  });

  it('resolveWorkspaceSidebarWidth 应在专注切换全程保持桌面侧栏宽度稳定', () => {
    const enteringContext = {
      resolveFocusWorkspaceTakeoverPhase: () => 'entering',
      uiState: {
        sidebarOpen: () => true,
        isMobile: () => false,
        sidebarWidth: () => 320,
      },
    } as unknown as WorkspaceShellComponent;
    const focusedContext = {
      resolveFocusWorkspaceTakeoverPhase: () => 'focused',
      uiState: {
        sidebarOpen: () => true,
        isMobile: () => false,
        sidebarWidth: () => 320,
      },
    } as unknown as WorkspaceShellComponent;
    const exitingContext = {
      resolveFocusWorkspaceTakeoverPhase: () => 'exiting',
      uiState: {
        sidebarOpen: () => true,
        isMobile: () => false,
        sidebarWidth: () => 320,
      },
    } as unknown as WorkspaceShellComponent;
    const desktopContext = {
      resolveFocusWorkspaceTakeoverPhase: () => 'idle',
      uiState: {
        sidebarOpen: () => true,
        isMobile: () => false,
        sidebarWidth: () => 320,
      },
    } as unknown as WorkspaceShellComponent;
    const restoringContext = {
      resolveFocusWorkspaceTakeoverPhase: () => 'restoring',
      uiState: {
        sidebarOpen: () => true,
        isMobile: () => false,
        sidebarWidth: () => 320,
      },
    } as unknown as WorkspaceShellComponent;
    const mobileContext = {
      resolveFocusWorkspaceTakeoverPhase: () => 'idle',
      uiState: {
        sidebarOpen: () => true,
        isMobile: () => true,
        sidebarWidth: () => 320,
      },
    } as unknown as WorkspaceShellComponent;

    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        resolveWorkspaceSidebarWidth: (this: WorkspaceShellComponent) => number;
      }).resolveWorkspaceSidebarWidth.call(enteringContext),
    ).toBe(320);
    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        resolveWorkspaceSidebarWidth: (this: WorkspaceShellComponent) => number;
      }).resolveWorkspaceSidebarWidth.call(focusedContext),
    ).toBe(320);
    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        resolveWorkspaceSidebarWidth: (this: WorkspaceShellComponent) => number;
      }).resolveWorkspaceSidebarWidth.call(exitingContext),
    ).toBe(320);
    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        resolveWorkspaceSidebarWidth: (this: WorkspaceShellComponent) => number;
      }).resolveWorkspaceSidebarWidth.call(desktopContext),
    ).toBe(320);
    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        resolveWorkspaceSidebarWidth: (this: WorkspaceShellComponent) => number;
      }).resolveWorkspaceSidebarWidth.call(restoringContext),
    ).toBe(320);
    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        resolveWorkspaceSidebarWidth: (this: WorkspaceShellComponent) => number;
      }).resolveWorkspaceSidebarWidth.call(mobileContext),
    ).toBe(240);
  });

  it('restore 期应延后项目栏内容显现，避免宽度恢复时内容挤压', () => {
    const restoringContext = {
      resolveFocusWorkspaceTakeoverPhase: () => 'restoring',
      uiState: {
        isMobile: () => false,
      },
    } as unknown as WorkspaceShellComponent;
    const focusedContext = {
      resolveFocusWorkspaceTakeoverPhase: () => 'focused',
      uiState: {
        isMobile: () => false,
      },
    } as unknown as WorkspaceShellComponent;

    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        resolveWorkspaceSidebarContentOpacity: (this: WorkspaceShellComponent) => string;
      }).resolveWorkspaceSidebarContentOpacity.call(restoringContext),
    ).toBe('1');
    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        resolveWorkspaceSidebarContentOpacity: (this: WorkspaceShellComponent) => string;
      }).resolveWorkspaceSidebarContentOpacity.call(focusedContext),
    ).toBe('0');
    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        resolveWorkspaceSidebarContentTransition: (this: WorkspaceShellComponent) => string;
      }).resolveWorkspaceSidebarContentTransition.call(restoringContext),
    ).toContain('var(--pk-shell-smooth-restore)');
  });

  it('桌面端退出专注时项目栏应直接回到完整视觉态，而不是先缩成 ghost 再恢复', () => {
    const exitingContext = {
      resolveFocusWorkspaceTakeoverPhase: () => 'exiting',
      uiState: {
        isMobile: () => false,
        sidebarOpen: () => true,
        sidebarWidth: () => 320,
      },
    } as unknown as WorkspaceShellComponent;

    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        resolveWorkspaceSidebarOpacity: (this: WorkspaceShellComponent) => string;
      }).resolveWorkspaceSidebarOpacity.call(exitingContext),
    ).toBe('1');
    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        resolveWorkspaceSidebarTransform: (this: WorkspaceShellComponent) => string;
      }).resolveWorkspaceSidebarTransform.call(exitingContext),
    ).toBe('translateX(0) scale(1)');
    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        resolveWorkspaceSidebarContentOpacity: (this: WorkspaceShellComponent) => string;
      }).resolveWorkspaceSidebarContentOpacity.call(exitingContext),
    ).toBe('1');
    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        resolveWorkspaceSidebarContentTransform: (this: WorkspaceShellComponent) => string;
      }).resolveWorkspaceSidebarContentTransform.call(exitingContext),
    ).toBe('translateX(0)');
  });

  it('移动端侧栏应改为 overlay transform 开合，而不是依赖主布局挤压', () => {
    const openContext = {
      resolveFocusWorkspaceTakeoverPhase: () => 'idle',
      uiState: {
        isMobile: () => true,
        sidebarOpen: () => true,
      },
    } as unknown as WorkspaceShellComponent;
    const closedContext = {
      resolveFocusWorkspaceTakeoverPhase: () => 'idle',
      uiState: {
        isMobile: () => true,
        sidebarOpen: () => false,
      },
    } as unknown as WorkspaceShellComponent;
    const takeoverContext = {
      resolveFocusWorkspaceTakeoverPhase: () => 'entering',
      uiState: {
        isMobile: () => true,
        sidebarOpen: () => true,
      },
    } as unknown as WorkspaceShellComponent;

    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        resolveWorkspaceSidebarTransform: (this: WorkspaceShellComponent) => string;
      }).resolveWorkspaceSidebarTransform.call(openContext),
    ).toBe('translateX(0)');
    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        resolveWorkspaceSidebarTransform: (this: WorkspaceShellComponent) => string;
      }).resolveWorkspaceSidebarTransform.call(closedContext),
    ).toBe('translateX(calc(-100% - 12px))');
    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        resolveWorkspaceSidebarTransform: (this: WorkspaceShellComponent) => string;
      }).resolveWorkspaceSidebarTransform.call(takeoverContext),
    ).toBe('translateX(calc(-100% - 12px))');
  });

  it('移动端侧栏关闭时应禁用命中，避免隐藏 overlay 挡住主内容', () => {
    const hiddenOverlayContext = {
      resolveFocusWorkspaceTakeoverPhase: () => 'idle',
      uiState: {
        isMobile: () => true,
        sidebarOpen: () => false,
      },
    } as unknown as WorkspaceShellComponent;
    const visibleOverlayContext = {
      resolveFocusWorkspaceTakeoverPhase: () => 'idle',
      uiState: {
        isMobile: () => true,
        sidebarOpen: () => true,
      },
    } as unknown as WorkspaceShellComponent;
    const restoringContext = {
      resolveFocusWorkspaceTakeoverPhase: () => 'restoring',
      uiState: {
        isMobile: () => true,
        sidebarOpen: () => true,
      },
    } as unknown as WorkspaceShellComponent;

    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        resolveWorkspaceSidebarPointerEvents: (this: WorkspaceShellComponent) => 'none' | 'auto';
      }).resolveWorkspaceSidebarPointerEvents.call(hiddenOverlayContext),
    ).toBe('none');
    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        resolveWorkspaceSidebarPointerEvents: (this: WorkspaceShellComponent) => 'none' | 'auto';
      }).resolveWorkspaceSidebarPointerEvents.call(visibleOverlayContext),
    ).toBe('auto');
    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        resolveWorkspaceSidebarPointerEvents: (this: WorkspaceShellComponent) => 'none' | 'auto';
      }).resolveWorkspaceSidebarPointerEvents.call(restoringContext),
    ).toBe('none');
  });

  it('showBlockingStartupHintOverlay 应只在桌面端保留全屏启动遮罩', () => {
    const desktopContext = {
      hintOnlyStartupPlaceholderVisible: () => true,
      isMobile: () => false,
    } as unknown as WorkspaceShellComponent;
    const mobileContext = {
      hintOnlyStartupPlaceholderVisible: () => true,
      isMobile: () => true,
    } as unknown as WorkspaceShellComponent;
    const inactiveContext = {
      hintOnlyStartupPlaceholderVisible: () => false,
      isMobile: () => false,
    } as unknown as WorkspaceShellComponent;

    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        showBlockingStartupHintOverlay: (this: WorkspaceShellComponent) => boolean;
      }).showBlockingStartupHintOverlay.call(desktopContext),
    ).toBe(true);
    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        showBlockingStartupHintOverlay: (this: WorkspaceShellComponent) => boolean;
      }).showBlockingStartupHintOverlay.call(mobileContext),
    ).toBe(false);
    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        showBlockingStartupHintOverlay: (this: WorkspaceShellComponent) => boolean;
      }).showBlockingStartupHintOverlay.call(inactiveContext),
    ).toBe(false);
  });

  it('showCompactStartupHintBanner 应在移动端降级为非阻塞提示', () => {
    const mobileContext = {
      hintOnlyStartupPlaceholderVisible: () => true,
      isMobile: () => true,
    } as unknown as WorkspaceShellComponent;
    const desktopContext = {
      hintOnlyStartupPlaceholderVisible: () => true,
      isMobile: () => false,
    } as unknown as WorkspaceShellComponent;
    const inactiveContext = {
      hintOnlyStartupPlaceholderVisible: () => false,
      isMobile: () => true,
    } as unknown as WorkspaceShellComponent;

    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        showCompactStartupHintBanner: (this: WorkspaceShellComponent) => boolean;
      }).showCompactStartupHintBanner.call(mobileContext),
    ).toBe(true);
    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        showCompactStartupHintBanner: (this: WorkspaceShellComponent) => boolean;
      }).showCompactStartupHintBanner.call(desktopContext),
    ).toBe(false);
    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        showCompactStartupHintBanner: (this: WorkspaceShellComponent) => boolean;
      }).showCompactStartupHintBanner.call(inactiveContext),
    ).toBe(false);
  });

  it('compactStartupHintBannerTop 应在移动端顶部已有状态提示时自动下移', () => {
    const stackedContext = {
      isMobile: () => true,
      isMobileOfflineNoticeVisible: () => true,
      resolveMobileFloatingNoticeBaseTopOffsetPx: () => 72,
      showInstallPrompt: () => false,
    } as unknown as WorkspaceShellComponent;
    const clearContext = {
      isMobile: () => true,
      isMobileOfflineNoticeVisible: () => false,
      resolveMobileFloatingNoticeBaseTopOffsetPx: () => 0,
      showInstallPrompt: () => false,
    } as unknown as WorkspaceShellComponent;
    const installPromptContext = {
      isMobile: () => true,
      isMobileOfflineNoticeVisible: () => false,
      resolveMobileFloatingNoticeBaseTopOffsetPx: () => 0,
      showInstallPrompt: () => true,
    } as unknown as WorkspaceShellComponent;
    const demoBannerContext = {
      isMobile: () => true,
      isMobileOfflineNoticeVisible: () => false,
      resolveMobileFloatingNoticeBaseTopOffsetPx: () => 104,
      showInstallPrompt: () => false,
    } as unknown as WorkspaceShellComponent;
    const demoOfflineContext = {
      isMobile: () => true,
      isMobileOfflineNoticeVisible: () => true,
      resolveMobileFloatingNoticeBaseTopOffsetPx: () => 146,
      showInstallPrompt: () => false,
    } as unknown as WorkspaceShellComponent;
    const stackedInstallContext = {
      isMobile: () => true,
      isMobileOfflineNoticeVisible: () => true,
      resolveMobileFloatingNoticeBaseTopOffsetPx: () => 146,
      showInstallPrompt: () => true,
    } as unknown as WorkspaceShellComponent;

    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        compactStartupHintBannerTop: (this: WorkspaceShellComponent) => string;
      }).compactStartupHintBannerTop.call(stackedContext),
    ).toBe('calc(env(safe-area-inset-top, 0px) + 84px)');
    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        compactStartupHintBannerTop: (this: WorkspaceShellComponent) => string;
      }).compactStartupHintBannerTop.call(clearContext),
    ).toBe('calc(env(safe-area-inset-top, 0px) + 56px)');
    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        compactStartupHintBannerTop: (this: WorkspaceShellComponent) => string;
      }).compactStartupHintBannerTop.call(installPromptContext),
    ).toBe('calc(env(safe-area-inset-top, 0px) + 56px)');
    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        compactStartupHintBannerTop: (this: WorkspaceShellComponent) => string;
      }).compactStartupHintBannerTop.call(demoBannerContext),
    ).toBe('calc(env(safe-area-inset-top, 0px) + 104px)');
    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        compactStartupHintBannerTop: (this: WorkspaceShellComponent) => string;
      }).compactStartupHintBannerTop.call(demoOfflineContext),
    ).toBe('calc(env(safe-area-inset-top, 0px) + 146px)');
    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        compactStartupHintBannerTop: (this: WorkspaceShellComponent) => string;
      }).compactStartupHintBannerTop.call(stackedInstallContext),
    ).toBe('calc(env(safe-area-inset-top, 0px) + 190px)');
  });

  it('installPromptTop 应在移动端顶部已有提示时自动避让', () => {
    const stackedContext = {
      isMobile: () => true,
      resolveMobileFloatingNoticeBaseTopOffsetPx: () => 104,
    } as unknown as WorkspaceShellComponent;
    const stackedOfflineContext = {
      isMobile: () => true,
      resolveMobileFloatingNoticeBaseTopOffsetPx: () => 146,
    } as unknown as WorkspaceShellComponent;
    const desktopContext = {
      isMobile: () => false,
      resolveMobileFloatingNoticeBaseTopOffsetPx: () => 0,
    } as unknown as WorkspaceShellComponent;

    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        installPromptTop: (this: WorkspaceShellComponent) => string;
      }).installPromptTop.call(stackedContext),
    ).toBe('calc(env(safe-area-inset-top, 0px) + 104px)');
    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        installPromptTop: (this: WorkspaceShellComponent) => string;
      }).installPromptTop.call(stackedOfflineContext),
    ).toBe('calc(env(safe-area-inset-top, 0px) + 146px)');
    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        installPromptTop: (this: WorkspaceShellComponent) => string;
      }).installPromptTop.call(desktopContext),
    ).toBe('calc(env(safe-area-inset-top, 0px) + 12px)');
  });

  it('showMobileDemoBanner 在横幅已关闭时不应继续预留顶部空间', () => {
    localStorage.setItem('nanoflow.demo-banner-dismissed', JSON.stringify({ timestamp: Date.now() }));

    const context = {
      isMobile: () => true,
      currentUserId: () => AUTH_CONFIG.LOCAL_MODE_USER_ID,
      isDemoBannerDismissed: (WorkspaceShellComponent.prototype as unknown as {
        isDemoBannerDismissed: (this: WorkspaceShellComponent) => boolean;
      }).isDemoBannerDismissed,
    } as unknown as WorkspaceShellComponent;

    try {
      expect(
        (WorkspaceShellComponent.prototype as unknown as {
          showMobileDemoBanner: (this: WorkspaceShellComponent) => boolean;
        }).showMobileDemoBanner.call(context),
      ).toBe(false);
    } finally {
      localStorage.removeItem('nanoflow.demo-banner-dismissed');
    }
  });

  it('blockHintOnlyMutation 应在 hint-only 启动占位期间提示只读并阻止写操作', () => {
    const info = vi.fn();
    const context = {
      userSession: {
        isHintOnlyStartupPlaceholderVisible: () => true,
      },
      toast: {
        info,
      },
    } as unknown as WorkspaceShellComponent;

    const blocked = (WorkspaceShellComponent.prototype as unknown as {
      blockHintOnlyMutation: (this: WorkspaceShellComponent, actionLabel: string) => boolean;
    }).blockHintOnlyMutation.call(context, '创建项目');

    expect(blocked).toBe(true);
    expect(info).toHaveBeenCalledWith('会话确认中', '创建项目暂不可用，owner 确认完成前保持只读');
  });

  it('executeRenameProject 应继续交给 coordinator 完成 UI 收尾，即使 hint-only 期间最终写入会被服务层阻止', () => {
    const executeRenameProject = vi.fn();
    const context = {
      projectCoord: {
        executeRenameProject,
      },
      userSession: {
        isHintOnlyStartupPlaceholderVisible: () => true,
      },
    } as unknown as WorkspaceShellComponent;

    WorkspaceShellComponent.prototype.executeRenameProject.call(context);

    expect(executeRenameProject).toHaveBeenCalledTimes(1);
  });

  it('saveProjectDetails 应继续交给 coordinator 收起编辑态，即使 hint-only 期间最终写入会被服务层阻止', () => {
    const saveProjectDetails = vi.fn();
    const context = {
      projectCoord: {
        saveProjectDetails,
      },
      userSession: {
        isHintOnlyStartupPlaceholderVisible: () => true,
      },
    } as unknown as WorkspaceShellComponent;

    WorkspaceShellComponent.prototype.saveProjectDetails.call(context, 'proj-1');

    expect(saveProjectDetails).toHaveBeenCalledWith('proj-1');
  });

  it('updateProjectDraft 应在 hint-only 期间静默忽略草稿写入', () => {
    const updateProjectDraft = vi.fn();
    const context = {
      projectCoord: {
        updateProjectDraft,
      },
      userSession: {
        isHintOnlyStartupPlaceholderVisible: () => true,
      },
    } as unknown as WorkspaceShellComponent;

    WorkspaceShellComponent.prototype.updateProjectDraft.call(context, 'proj-1', 'description', 'draft');

    expect(updateProjectDraft).not.toHaveBeenCalled();
  });

  it('startProjectDescriptionEdit 应在 hint-only 启动占位期间阻止进入简介编辑态', () => {
    const info = vi.fn();
    const set = vi.fn();
    const stopPropagation = vi.fn();
    const context = {
      userSession: {
        isHintOnlyStartupPlaceholderVisible: () => true,
      },
      toast: {
        info,
      },
      projectCoord: {
        isEditingDescription: { set },
      },
      blockHintOnlyMutation: WorkspaceShellComponent.prototype['blockHintOnlyMutation'],
    } as unknown as WorkspaceShellComponent;

    WorkspaceShellComponent.prototype.startProjectDescriptionEdit.call(context, { stopPropagation } as unknown as Event);

    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(set).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith('会话确认中', '编辑项目简介暂不可用，owner 确认完成前保持只读');
  });

  it('handleProjectDoubleClick 在 hint-only 期间应仅进入项目而不进入简介编辑态', () => {
    const enterProject = vi.fn();
    const handleProjectDoubleClick = vi.fn();
    const checkGateForMobileProjectEntry = vi.fn();
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    const context = {
      userSession: {
        isHintOnlyStartupPlaceholderVisible: () => true,
      },
      projectCoord: {
        enterProject,
        handleProjectDoubleClick,
      },
      isSidebarOpen: signal(false),
      checkGateForMobileProjectEntry,
    } as unknown as WorkspaceShellComponent;

    WorkspaceShellComponent.prototype.handleProjectDoubleClick.call(context, 'proj-1', {
      preventDefault,
      stopPropagation,
    } as unknown as MouseEvent);

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(enterProject).toHaveBeenCalledWith('proj-1', context.isSidebarOpen);
    expect(checkGateForMobileProjectEntry).toHaveBeenCalledTimes(1);
    expect(handleProjectDoubleClick).not.toHaveBeenCalled();
  });

  it('signalWorkspaceHandoffReady 应只通知一次布局稳定，真正 handoff 交给协调器触发', () => {
    const markWorkspaceHandoffReady = vi.fn();
    const markApplicationReady = vi.fn();
    const markLayoutStable = vi.fn();
    const context = {
      bootStage: { markWorkspaceHandoffReady, markApplicationReady },
      handoffCoordinator: { markLayoutStable },
      workspaceHandoffSignaled: false,
    } as unknown as WorkspaceShellComponent;

    (WorkspaceShellComponent.prototype as unknown as {
      signalWorkspaceHandoffReady: (this: WorkspaceShellComponent) => void;
    }).signalWorkspaceHandoffReady.call(context);
    (WorkspaceShellComponent.prototype as unknown as {
      signalWorkspaceHandoffReady: (this: WorkspaceShellComponent) => void;
    }).signalWorkspaceHandoffReady.call(context);

    expect(markWorkspaceHandoffReady).not.toHaveBeenCalled();
    expect(markApplicationReady).not.toHaveBeenCalled();
    expect(markLayoutStable).toHaveBeenCalledTimes(1);
  });

  it('commitWorkspaceHandoff 应在 handoff 后隐藏 loader、记录指标并推进 ready', () => {
    const loader = document.createElement('div');
    loader.id = 'initial-loader';
    loader.style.display = 'flex';
    document.body.appendChild(loader);

    const noteLoaderHidden = vi.fn();
    const markApplicationReady = vi.fn();
    const markHandoffReady = vi.fn();
    const context = {
      bootStage: {
        isWorkspaceHandoffReady: () => true,
        noteLoaderHidden,
        markApplicationReady,
      },
      startupTier: { markHandoffReady },
      workspaceReadyCommitted: false,
      flushWidgetWorkspaceGateRecheck: vi.fn(),
    } as unknown as WorkspaceShellComponent;

    try {
      (WorkspaceShellComponent.prototype as unknown as {
        commitWorkspaceHandoff: (this: WorkspaceShellComponent) => void;
      }).commitWorkspaceHandoff.call(context);
      (WorkspaceShellComponent.prototype as unknown as {
        commitWorkspaceHandoff: (this: WorkspaceShellComponent) => void;
      }).commitWorkspaceHandoff.call(context);

      expect(loader.style.display).toBe('none');
      expect(noteLoaderHidden).toHaveBeenCalledTimes(1);
      expect(markHandoffReady).toHaveBeenCalledTimes(1);
      expect(markApplicationReady).toHaveBeenCalledTimes(1);
    } finally {
      loader.remove();
    }
  });

  it('resolveLaunchSnapshotUserId 应在认证仍未完成但没有已确认 owner 时暂停写入', () => {
    const context = {
      currentUserId: () => null,
      authService: {
        sessionInitialized: () => false,
      },
      authCoord: {
        isCheckingSession: () => false,
      },
      startupLaunchSnapshot: {
        userId: 'snapshot-user',
      },
    } as unknown as WorkspaceShellComponent;

    const result = (WorkspaceShellComponent.prototype as unknown as {
      resolveLaunchSnapshotUserId: (this: WorkspaceShellComponent) => string | null;
    }).resolveLaunchSnapshotUserId.call(context);

    expect(result).toBeNull();
  });

  it('resolveLaunchSnapshotUserId 应在认证未完成但已确认预填充 owner 时优先使用该 owner', () => {
    const context = {
      currentUserId: () => null,
      authService: {
        sessionInitialized: () => false,
      },
      authCoord: {
        isCheckingSession: () => false,
      },
      userSession: {
        getLaunchSnapshotPersistOwnerDuringAuthSettle: () => 'offline-owner',
      },
      startupLaunchSnapshot: {
        userId: 'snapshot-user',
      },
    } as unknown as WorkspaceShellComponent;

    const result = (WorkspaceShellComponent.prototype as unknown as {
      resolveLaunchSnapshotUserId: (this: WorkspaceShellComponent) => string | null;
    }).resolveLaunchSnapshotUserId.call(context);

    expect(result).toBe('offline-owner');
  });

  it('resolveLaunchSnapshotUserId 应在认证已稳定且无用户时返回 null', () => {
    const context = {
      currentUserId: () => null,
      authService: {
        sessionInitialized: () => true,
      },
      authCoord: {
        isCheckingSession: () => false,
      },
      startupLaunchSnapshot: {
        userId: 'snapshot-user',
      },
    } as unknown as WorkspaceShellComponent;

    const result = (WorkspaceShellComponent.prototype as unknown as {
      resolveLaunchSnapshotUserId: (this: WorkspaceShellComponent) => string | null;
    }).resolveLaunchSnapshotUserId.call(context);

    expect(result).toBeNull();
  });

  it('setupLaunchSnapshotEffect 在 hint-only 占位期间应取消 pending persist 且不继续写入', () => {
    const cancelPendingPersist = vi.fn();
    const schedulePersistDeferred = vi.fn();
    const injector = Injector.create({
      providers: [
        {
          provide: ChangeDetectionScheduler,
          useValue: {
            notify: vi.fn(),
            runningTick: false,
          } satisfies ChangeDetectionScheduler,
        },
        {
          provide: EffectScheduler,
          useValue: {
            schedule: (effect: { run: () => void }) => {
              effect.run();
            },
            flush: vi.fn(),
            remove: vi.fn(),
          } satisfies EffectScheduler,
        },
      ],
    });
    const context = {
      hintOnlyStartupPlaceholderVisible: signal(true),
      launchSnapshotWriteBlocked: signal(false),
      launchSnapshot: {
        cancelPendingPersist,
        schedulePersistDeferred,
      },
      projectState: {
        projects: signal([]),
        activeProjectId: signal<string | null>(null),
      },
      uiState: {
        activeView: signal<'text' | 'flow'>('text'),
        isMobile: () => false,
      },
      preferenceService: {
        theme: () => 'default',
      },
      readCurrentColorMode: () => 'light',
      routeUrl: () => '/projects',
      resolveLaunchSnapshotUserId: () => 'user-1',
    } as unknown as WorkspaceShellComponent;

    runInInjectionContext(injector, () => {
      (WorkspaceShellComponent.prototype as unknown as {
        setupLaunchSnapshotEffect: (this: WorkspaceShellComponent) => void;
      }).setupLaunchSnapshotEffect.call(context);
    });

    expect(cancelPendingPersist).toHaveBeenCalledTimes(1);
    expect(schedulePersistDeferred).not.toHaveBeenCalled();
  });

  it('setupLaunchSnapshotEffect 在 owner 切换写屏障期间应取消 pending persist 且不继续写入', () => {
    const cancelPendingPersist = vi.fn();
    const schedulePersistDeferred = vi.fn();
    const injector = Injector.create({
      providers: [
        {
          provide: ChangeDetectionScheduler,
          useValue: {
            notify: vi.fn(),
            runningTick: false,
          } satisfies ChangeDetectionScheduler,
        },
        {
          provide: EffectScheduler,
          useValue: {
            schedule: (effect: { run: () => void }) => {
              effect.run();
            },
            flush: vi.fn(),
            remove: vi.fn(),
          } satisfies EffectScheduler,
        },
      ],
    });
    const context = {
      hintOnlyStartupPlaceholderVisible: signal(false),
      launchSnapshotWriteBlocked: signal(true),
      launchSnapshot: {
        cancelPendingPersist,
        schedulePersistDeferred,
      },
      projectState: {
        projects: signal([]),
        activeProjectId: signal<string | null>(null),
      },
      uiState: {
        activeView: signal<'text' | 'flow'>('text'),
        isMobile: () => false,
      },
      preferenceService: {
        theme: () => 'default',
      },
      readCurrentColorMode: () => 'light',
      routeUrl: () => '/projects',
      resolveLaunchSnapshotUserId: () => 'user-1',
    } as unknown as WorkspaceShellComponent;

    runInInjectionContext(injector, () => {
      (WorkspaceShellComponent.prototype as unknown as {
        setupLaunchSnapshotEffect: (this: WorkspaceShellComponent) => void;
      }).setupLaunchSnapshotEffect.call(context);
    });

    expect(cancelPendingPersist).toHaveBeenCalledTimes(1);
    expect(schedulePersistDeferred).not.toHaveBeenCalled();
  });

  it('setupFocusEntryOwnerEffect 应在 owner 切换后再复位并重挂 focus-entry 监听', () => {
    const currentUserId = signal<string | null>(null);
    const resetFocusEntrySyncPulseState = vi.fn();
    const scheduledEffects: Array<{ run: () => void }> = [];
    const injector = Injector.create({
      providers: [
        {
          provide: ChangeDetectionScheduler,
          useValue: {
            notify: vi.fn(),
            runningTick: false,
          } satisfies ChangeDetectionScheduler,
        },
        {
          provide: EffectScheduler,
          useValue: {
            schedule: (effect: { run: () => void }) => {
              scheduledEffects.push(effect);
            },
            flush: () => {
              while (scheduledEffects.length > 0) {
                scheduledEffects.shift()?.run();
              }
            },
            remove: vi.fn(),
          } satisfies EffectScheduler,
        },
      ],
    });
    const context = {
      currentUserId,
      focusEntryOwnerScope: undefined,
      resetFocusEntrySyncPulseState,
    } as unknown as WorkspaceShellComponent & {
      focusEntryOwnerScope: string | null | undefined;
    };

    runInInjectionContext(injector, () => {
      (WorkspaceShellComponent.prototype as unknown as {
        setupFocusEntryOwnerEffect: (this: WorkspaceShellComponent) => void;
      }).setupFocusEntryOwnerEffect.call(context);
    });
    injector.get(EffectScheduler).flush();

    expect(resetFocusEntrySyncPulseState).not.toHaveBeenCalled();

    currentUserId.set('user-1');
    injector.get(EffectScheduler).flush();
    expect(resetFocusEntrySyncPulseState).toHaveBeenCalledWith(true);

    currentUserId.set(null);
    injector.get(EffectScheduler).flush();
    expect(resetFocusEntrySyncPulseState).toHaveBeenLastCalledWith(false);
  });

  it('setupSessionInvalidatedHandler 应取消 launch snapshot 写入并清空旧 owner 视图', async () => {
    const sessionInvalidated$ = new Subject<{ type: 'session-invalidated'; source: string; userId: string | null }>();
    const cancelPendingPersist = vi.fn();
    const stopRuntime = vi.fn();
    const unsubscribeFromProject = vi.fn().mockResolvedValue(undefined);
    const setCurrentUser = vi.fn().mockResolvedValue(undefined);
    const destroySyncPulse = vi.fn();
    const resetFocusEntrySyncPulseState = vi.fn();
    const destroyCallbacks: Array<() => void> = [];
    const context = {
      eventBus: {
        onSessionInvalidated$: sessionInvalidated$.asObservable(),
      },
      launchSnapshotWriteBlocked: signal(false),
      destroyRef: {
        onDestroy: (callback: () => void) => {
          destroyCallbacks.push(callback);
        },
      },
      logger: {
        warn: vi.fn(),
      },
      launchSnapshot: {
        cancelPendingPersist,
      },
      simpleSync: {
        stopRuntime,
        unsubscribeFromProject,
      },
      userSession: {
        setCurrentUser,
      },
      destroySyncPulse,
      resetFocusEntrySyncPulseState,
      subscribedProjectId: 'project-1',
    } as unknown as WorkspaceShellComponent;

    (WorkspaceShellComponent.prototype as unknown as {
      setupSessionInvalidatedHandler: (this: WorkspaceShellComponent) => void;
    }).setupSessionInvalidatedHandler.call(context);

    sessionInvalidated$.next({
      type: 'session-invalidated',
      source: 'AuthService.backgroundRefresh',
      userId: 'stale-user',
    });
    await Promise.resolve();

    expect(cancelPendingPersist).toHaveBeenCalledTimes(1);
    expect(stopRuntime).toHaveBeenCalledTimes(1);
    expect(unsubscribeFromProject).toHaveBeenCalledTimes(1);
    expect(destroySyncPulse).toHaveBeenCalledTimes(1);
    expect(resetFocusEntrySyncPulseState).toHaveBeenCalledWith(false);
    expect(setCurrentUser).toHaveBeenCalledWith(null, {
      skipPersistentReload: true,
      previousUserIdHint: 'stale-user',
      preserveOfflineSnapshot: true,
    });
    expect((context as unknown as { launchSnapshotWriteBlocked: ReturnType<typeof signal<boolean>> }).launchSnapshotWriteBlocked()).toBe(false);
    expect((context as unknown as { subscribedProjectId: string | null }).subscribedProjectId).toBeNull();
  });

  it('setupSessionRestoredHandler 应先完成 owner 切换再确认跨标签页登录态', async () => {
    const sessionRestored$ = new Subject<{ type: 'session-restored'; source: string; userId: string }>();
    const cancelPendingPersist = vi.fn();
    const stopRuntime = vi.fn();
    const startRuntime = vi.fn();
    const unsubscribeFromProject = vi.fn().mockResolvedValue(undefined);
    const completeCrossTabSessionRestore = vi.fn();
    let currentUserId = 'old-user';
    const setCurrentUser = vi.fn().mockImplementation(async (userId: string) => {
      currentUserId = userId;
    });
    const destroySyncPulse = vi.fn();
    const resetFocusEntrySyncPulseState = vi.fn();
    const context = {
      eventBus: {
        onSessionRestored$: sessionRestored$.asObservable(),
      },
      launchSnapshotWriteBlocked: signal(false),
      destroyRef: {
        onDestroy: vi.fn(),
      },
      logger: {
        warn: vi.fn(),
      },
      launchSnapshot: {
        cancelPendingPersist,
      },
      simpleSync: {
        stopRuntime,
        startRuntime,
        unsubscribeFromProject,
      },
      authService: {
        completeCrossTabSessionRestore,
      },
      userSession: {
        setCurrentUser,
      },
      startupTier: {
        isTierReady: vi.fn().mockReturnValue(true),
      },
      destroySyncPulse,
      resetFocusEntrySyncPulseState,
      currentUserId: () => currentUserId,
      subscribedProjectId: 'project-1',
    } as unknown as WorkspaceShellComponent;

    (WorkspaceShellComponent.prototype as unknown as {
      setupSessionRestoredHandler: (this: WorkspaceShellComponent) => void;
    }).setupSessionRestoredHandler.call(context);

    sessionRestored$.next({
      type: 'session-restored',
      source: 'AuthService.storageBridge',
      userId: 'new-user',
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(cancelPendingPersist).toHaveBeenCalledTimes(1);
    expect(stopRuntime).toHaveBeenCalledTimes(1);
    expect(unsubscribeFromProject).toHaveBeenCalledTimes(1);
    expect(destroySyncPulse).toHaveBeenCalledTimes(1);
    expect(resetFocusEntrySyncPulseState).toHaveBeenCalledWith(false);
    expect(setCurrentUser).toHaveBeenCalledWith('new-user', {
      forceLoad: true,
    });
    expect(completeCrossTabSessionRestore).toHaveBeenCalledWith('new-user');
    expect(startRuntime).toHaveBeenCalledTimes(1);
    expect((context as unknown as { launchSnapshotWriteBlocked: ReturnType<typeof signal<boolean>> }).launchSnapshotWriteBlocked()).toBe(false);
    expect((context as unknown as { subscribedProjectId: string | null }).subscribedProjectId).toBeNull();
  });

  it('signOut 应复位 focus-entry 状态，避免下个会话复用旧 intent', async () => {
    const resetFocusEntrySyncPulseState = vi.fn();
    const destroySyncPulse = vi.fn();
    const signOut = vi.fn().mockResolvedValue(true);
    const clearState = vi.fn();
    const set = vi.fn();
    const context = {
      resetFocusEntrySyncPulseState,
      destroySyncPulse,
      authCoord: { signOut },
      projectCoord: { clearState },
      unifiedSearchQuery: { set },
    } as unknown as WorkspaceShellComponent;

    await WorkspaceShellComponent.prototype.signOut.call(context);

    expect(resetFocusEntrySyncPulseState).toHaveBeenCalledWith(false);
    expect(destroySyncPulse).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(clearState).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith('');
  });

  it('signOut 在远端吊销中断时不应提前清理工作区状态', async () => {
    const resetFocusEntrySyncPulseState = vi.fn();
    const destroySyncPulse = vi.fn();
    const signOut = vi.fn().mockResolvedValue(false);
    const clearState = vi.fn();
    const set = vi.fn();
    const context = {
      resetFocusEntrySyncPulseState,
      destroySyncPulse,
      authCoord: { signOut },
      projectCoord: { clearState },
      unifiedSearchQuery: { set },
    } as unknown as WorkspaceShellComponent;

    await WorkspaceShellComponent.prototype.signOut.call(context);

    expect(signOut).toHaveBeenCalledTimes(1);
    expect(resetFocusEntrySyncPulseState).not.toHaveBeenCalled();
    expect(destroySyncPulse).not.toHaveBeenCalled();
    expect(clearState).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  it('syncStateFromRoute 应在 /projects 根路由回填启动项目，避免主内容空壳', () => {
    const switchActiveProject = vi.fn();
    const navigate = vi.fn();
    const context = {
      getCurrentStartupEntryIntent: () => null,
      routeUrl: () => '/projects',
      uiState: { isMobile: () => true },
      rootStartupTextNavigationApplied: false,
      route: {
        snapshot: { params: {} },
        firstChild: null,
      },
      projectState: {
        activeProjectId: () => null,
        projects: () => [{ id: 'project-1' }, { id: 'project-2' }],
      },
      userSession: {
        switchActiveProject,
        canAuthoritativelyRejectProjectRoute: () => true,
        isProjectAuthoritativelyAccessible: () => true,
        startupProjectCatalogStage: () => 'resolved',
      },
      startupLaunchSnapshot: {
        activeProjectId: 'project-2',
        currentProject: { id: 'project-2' },
      },
      router: {
        navigate,
      },
      navigateRootStartupToTextProject: (projectId: string) =>
        (WorkspaceShellComponent.prototype as unknown as {
          navigateRootStartupToTextProject: (this: WorkspaceShellComponent, projectId: string) => void;
        }).navigateRootStartupToTextProject.call(context as unknown as WorkspaceShellComponent, projectId),
      shouldNavigateRootStartupToTextProject: () =>
        (WorkspaceShellComponent.prototype as unknown as {
          shouldNavigateRootStartupToTextProject: (this: WorkspaceShellComponent) => boolean;
        }).shouldNavigateRootStartupToTextProject.call(context as unknown as WorkspaceShellComponent),
      resolveStartupProjectFallbackId: (projects: Array<{ id: string }>) =>
        (WorkspaceShellComponent.prototype as unknown as {
          resolveStartupProjectFallbackId: (
            this: WorkspaceShellComponent,
            projects: Array<{ id: string }>
          ) => string | null;
        }).resolveStartupProjectFallbackId.call(context as unknown as WorkspaceShellComponent, projects as never),
    } as unknown as WorkspaceShellComponent;

    (WorkspaceShellComponent.prototype as unknown as {
      syncStateFromRoute: (this: WorkspaceShellComponent) => void;
    }).syncStateFromRoute.call(context);

    expect(switchActiveProject).toHaveBeenCalledWith('project-2');
    expect(navigate).toHaveBeenCalledWith(['/projects', 'project-2', 'text'], {
      replaceUrl: true,
      queryParamsHandling: 'preserve',
    });
  });

  it('syncStateFromRoute 应在快照已选中项目时仍把移动端根启动推到文本栏', () => {
    const navigate = vi.fn();
    const context = {
      getCurrentStartupEntryIntent: () => null,
      routeUrl: () => '/projects',
      uiState: { isMobile: () => true },
      rootStartupTextNavigationApplied: false,
      route: {
        snapshot: { params: {} },
        firstChild: null,
      },
      projectState: {
        activeProjectId: () => 'project-2',
        projects: () => [{ id: 'project-1' }, { id: 'project-2' }],
      },
      userSession: {
        switchActiveProject: vi.fn(),
        canAuthoritativelyRejectProjectRoute: () => true,
        isProjectAuthoritativelyAccessible: () => true,
      },
      startupLaunchSnapshot: null,
      router: { navigate },
      navigateRootStartupToTextProject: (projectId: string) =>
        (WorkspaceShellComponent.prototype as unknown as {
          navigateRootStartupToTextProject: (this: WorkspaceShellComponent, projectId: string) => void;
        }).navigateRootStartupToTextProject.call(context as unknown as WorkspaceShellComponent, projectId),
      shouldNavigateRootStartupToTextProject: () =>
        (WorkspaceShellComponent.prototype as unknown as {
          shouldNavigateRootStartupToTextProject: (this: WorkspaceShellComponent) => boolean;
        }).shouldNavigateRootStartupToTextProject.call(context as unknown as WorkspaceShellComponent),
      resolveStartupProjectFallbackId: vi.fn(),
    } as unknown as WorkspaceShellComponent;

    (WorkspaceShellComponent.prototype as unknown as {
      syncStateFromRoute: (this: WorkspaceShellComponent) => void;
    }).syncStateFromRoute.call(context);

    expect(navigate).toHaveBeenCalledWith(['/projects', 'project-2', 'text'], {
      replaceUrl: true,
      queryParamsHandling: 'preserve',
    });
  });

  it('syncStateFromRoute 不应把桌面端 /projects 根路由强制改成 text 深链', () => {
    const switchActiveProject = vi.fn();
    const navigate = vi.fn();
    const context = {
      getCurrentStartupEntryIntent: () => null,
      routeUrl: () => '/projects',
      uiState: { isMobile: () => false },
      rootStartupTextNavigationApplied: false,
      route: {
        snapshot: { params: {} },
        firstChild: null,
      },
      projectState: {
        activeProjectId: () => null,
        projects: () => [{ id: 'project-1' }],
      },
      userSession: {
        switchActiveProject,
        canAuthoritativelyRejectProjectRoute: () => true,
        isProjectAuthoritativelyAccessible: () => true,
      },
      startupLaunchSnapshot: null,
      router: { navigate },
      navigateRootStartupToTextProject: (projectId: string) =>
        (WorkspaceShellComponent.prototype as unknown as {
          navigateRootStartupToTextProject: (this: WorkspaceShellComponent, projectId: string) => void;
        }).navigateRootStartupToTextProject.call(context as unknown as WorkspaceShellComponent, projectId),
      shouldNavigateRootStartupToTextProject: () =>
        (WorkspaceShellComponent.prototype as unknown as {
          shouldNavigateRootStartupToTextProject: (this: WorkspaceShellComponent) => boolean;
        }).shouldNavigateRootStartupToTextProject.call(context as unknown as WorkspaceShellComponent),
      resolveStartupProjectFallbackId: () => 'project-1',
    } as unknown as WorkspaceShellComponent;

    (WorkspaceShellComponent.prototype as unknown as {
      syncStateFromRoute: (this: WorkspaceShellComponent) => void;
    }).syncStateFromRoute.call(context);

    expect(switchActiveProject).toHaveBeenCalledWith('project-1');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('syncStateFromRoute 在当前路由已是文本深链时不应重复导航', () => {
    const previousFlag = (window as Window & { __NANOFLOW_LAUNCH_ROUTE_APPLIED__?: boolean })
      .__NANOFLOW_LAUNCH_ROUTE_APPLIED__;
    (window as Window & { __NANOFLOW_LAUNCH_ROUTE_APPLIED__?: boolean })
      .__NANOFLOW_LAUNCH_ROUTE_APPLIED__ = true;

    const navigate = vi.fn();
    const context = {
      getCurrentStartupEntryIntent: () => null,
      routeUrl: () => '/projects/project-2/text',
      uiState: { isMobile: () => true },
      rootStartupTextNavigationApplied: false,
      route: {
        snapshot: { params: {} },
        firstChild: {
          snapshot: { params: { projectId: 'project-2' } },
          firstChild: {
            snapshot: { params: {} },
            firstChild: null,
          },
        },
      },
      projectState: {
        activeProjectId: () => 'project-2',
        projects: () => [{ id: 'project-2' }],
        setActiveProjectId: vi.fn(),
      },
      userSession: {
        canAuthoritativelyRejectProjectRoute: () => true,
        isProjectAuthoritativelyAccessible: () => true,
      },
      startupLaunchSnapshot: null,
      router: { navigate },
      navigateRootStartupToTextProject: (projectId: string) =>
        (WorkspaceShellComponent.prototype as unknown as {
          navigateRootStartupToTextProject: (this: WorkspaceShellComponent, projectId: string) => void;
        }).navigateRootStartupToTextProject.call(context as unknown as WorkspaceShellComponent, projectId),
      shouldNavigateRootStartupToTextProject: () =>
        (WorkspaceShellComponent.prototype as unknown as {
          shouldNavigateRootStartupToTextProject: (this: WorkspaceShellComponent) => boolean;
        }).shouldNavigateRootStartupToTextProject.call(context as unknown as WorkspaceShellComponent),
      resolveStartupProjectFallbackId: vi.fn(),
    } as unknown as WorkspaceShellComponent;

    try {
      (WorkspaceShellComponent.prototype as unknown as {
        syncStateFromRoute: (this: WorkspaceShellComponent) => void;
      }).syncStateFromRoute.call(context);
    } finally {
      if (previousFlag === undefined) {
        delete (window as Window & { __NANOFLOW_LAUNCH_ROUTE_APPLIED__?: boolean })
          .__NANOFLOW_LAUNCH_ROUTE_APPLIED__;
      } else {
        (window as Window & { __NANOFLOW_LAUNCH_ROUTE_APPLIED__?: boolean })
          .__NANOFLOW_LAUNCH_ROUTE_APPLIED__ = previousFlag;
      }
    }

    expect(navigate).not.toHaveBeenCalled();
  });

  it('applyStartupEntryIntent 应在 focus/blackbox shortcut 下打开侧边栏并预加载工具', () => {
    const setSidebarOpen = vi.fn();
    const preloadSidebarTools = vi.fn();
    const loadBlackBoxRecorderComponent = vi.fn();
    const context = {
      isSidebarOpen: { set: setSidebarOpen },
      preloadSidebarTools,
      loadBlackBoxRecorderComponent,
      primeWidgetWorkspaceGateSync: vi.fn(),
      focusPrefs: {
        isBlackBoxEnabled: () => true,
      },
    } as unknown as WorkspaceShellComponent;

    (WorkspaceShellComponent.prototype as unknown as {
      applyStartupEntryIntent: (this: WorkspaceShellComponent, startupEntryIntent: {
        entry: 'shortcut' | 'widget' | 'twa';
        intent: 'open-focus-tools' | 'open-blackbox-recorder' | 'open-workspace' | 'mark-gate-read' | 'mark-gate-complete' | null;
        rawIntent: string | null;
        widgetGateEntryId: string | null;
      }) => void;
    }).applyStartupEntryIntent.call(context, {
      entry: 'shortcut',
      intent: 'open-blackbox-recorder',
      rawIntent: 'open-blackbox-recorder',
      widgetGateEntryId: null,
    });

    expect(setSidebarOpen).toHaveBeenCalledWith(true);
    expect(preloadSidebarTools).toHaveBeenCalledWith('intent');
    expect(loadBlackBoxRecorderComponent).toHaveBeenCalledTimes(1);
  });

  it('widget open-workspace 应同时强制拉取 Focus C 位快照，避免小组件顺序被本地旧状态回调', () => {
    const primeWidgetWorkspaceGateSync = vi.fn();
    const refreshFocusSessionFromCloud = vi.fn();
    const context = {
      routeUrl: () => '/projects/project-1?entry=widget&intent=open-workspace',
      currentUserId: () => 'user-1',
      focusStartupProbe: {
        primeWidgetWorkspaceGateSync,
      },
      bootStage: {
        isApplicationReady: () => false,
      },
      dockEngine: {
        refreshFocusSessionFromCloud,
      },
      primedWidgetWorkspaceGateSyncKey: null,
      flushWidgetWorkspaceGateRecheck: vi.fn(),
    } as unknown as WorkspaceShellComponent;

    (WorkspaceShellComponent.prototype as unknown as {
      primeWidgetWorkspaceGateSync: (this: WorkspaceShellComponent, startupEntryIntent: {
        entry: 'shortcut' | 'widget' | 'twa';
        intent: 'open-workspace' | null;
        rawIntent: string | null;
      }) => void;
    }).primeWidgetWorkspaceGateSync.call(context, {
      entry: 'widget',
      intent: 'open-workspace',
      rawIntent: 'open-workspace',
    });

    expect(primeWidgetWorkspaceGateSync).toHaveBeenCalledTimes(1);
    expect(refreshFocusSessionFromCloud).toHaveBeenCalledWith('user-1');
  });

  it('TWA bootstrap 形式的小组件 open-workspace 也应触发同源 Gate 复核', () => {
    const primeWidgetWorkspaceGateSync = vi.fn();
    const refreshFocusSessionFromCloud = vi.fn();
    const context = {
      routeUrl: () => '/projects?entry=twa&intent=open-workspace&widgetBootstrap=1',
      currentUserId: () => 'user-1',
      focusStartupProbe: {
        primeWidgetWorkspaceGateSync,
      },
      bootStage: {
        isApplicationReady: () => false,
      },
      dockEngine: {
        refreshFocusSessionFromCloud,
      },
      primedWidgetWorkspaceGateSyncKey: null,
      flushWidgetWorkspaceGateRecheck: vi.fn(),
    } as unknown as WorkspaceShellComponent;

    (WorkspaceShellComponent.prototype as unknown as {
      primeWidgetWorkspaceGateSync: (this: WorkspaceShellComponent, startupEntryIntent: {
        entry: 'shortcut' | 'widget' | 'twa';
        intent: 'open-workspace' | null;
        rawIntent: string | null;
        androidWidgetBootstrap?: true;
      }) => void;
    }).primeWidgetWorkspaceGateSync.call(context, {
      entry: 'twa',
      intent: 'open-workspace',
      rawIntent: 'open-workspace',
      androidWidgetBootstrap: true,
    });

    expect(primeWidgetWorkspaceGateSync).toHaveBeenCalledTimes(1);
    expect(refreshFocusSessionFromCloud).toHaveBeenCalledWith('user-1');
  });

  it('小组件 open-workspace 在探针已初始化但早于应用 ready 时，应在 ready 后补跑 Gate 复核', () => {
    let applicationReady = false;
    const primeWidgetWorkspaceGateSync = vi.fn();
    const recheckGate = vi.fn();
    const refreshFocusSessionFromCloud = vi.fn();
    const context = {
      routeUrl: () => '/projects/project-1/text?entry=widget&intent=open-workspace',
      currentUserId: () => 'user-1',
      focusStartupProbe: {
        primeWidgetWorkspaceGateSync,
        recheckGate,
      },
      bootStage: {
        isApplicationReady: () => applicationReady,
      },
      dockEngine: {
        refreshFocusSessionFromCloud,
      },
      primedWidgetWorkspaceGateSyncKey: null,
      pendingWidgetWorkspaceGateRecheckKey: null,
      focusProbeInitializedForUser: 'user-1',
      flushWidgetWorkspaceGateRecheck: (WorkspaceShellComponent.prototype as unknown as {
        flushWidgetWorkspaceGateRecheck: (this: WorkspaceShellComponent) => void;
      }).flushWidgetWorkspaceGateRecheck,
    } as {
      pendingWidgetWorkspaceGateRecheckKey: string | null;
      focusProbeInitializedForUser: string | null;
    } & Record<string, unknown>;

    (WorkspaceShellComponent.prototype as unknown as {
      primeWidgetWorkspaceGateSync: (this: WorkspaceShellComponent, startupEntryIntent: {
        entry: 'shortcut' | 'widget' | 'twa';
        intent: 'open-workspace' | null;
        rawIntent: string | null;
      }) => void;
    }).primeWidgetWorkspaceGateSync.call(context as unknown as WorkspaceShellComponent, {
      entry: 'widget',
      intent: 'open-workspace',
      rawIntent: 'open-workspace',
    });

    expect(recheckGate).not.toHaveBeenCalled();
    applicationReady = true;

    (WorkspaceShellComponent.prototype as unknown as {
      flushWidgetWorkspaceGateRecheck: (this: WorkspaceShellComponent) => void;
    }).flushWidgetWorkspaceGateRecheck.call(context as unknown as WorkspaceShellComponent);

    expect(recheckGate).toHaveBeenCalledWith({
      source: 'widget-open-workspace',
      reloadLocal: false,
    });
    expect(context.pendingWidgetWorkspaceGateRecheckKey).toBeNull();
  });

  it('小组件 open-workspace 早于 Focus 探针初始化时，也应在应用 ready 后立即复核 Gate', () => {
    const primeWidgetWorkspaceGateSync = vi.fn();
    const recheckGate = vi.fn();
    const refreshFocusSessionFromCloud = vi.fn();
    const context = {
      routeUrl: () => '/projects/project-1/text?entry=widget&intent=open-workspace',
      currentUserId: () => 'user-1',
      focusStartupProbe: {
        primeWidgetWorkspaceGateSync,
        recheckGate,
      },
      bootStage: {
        isApplicationReady: () => true,
      },
      dockEngine: {
        refreshFocusSessionFromCloud,
      },
      primedWidgetWorkspaceGateSyncKey: null,
      pendingWidgetWorkspaceGateRecheckKey: null,
      focusProbeInitializedForUser: null,
      flushWidgetWorkspaceGateRecheck: (WorkspaceShellComponent.prototype as unknown as {
        flushWidgetWorkspaceGateRecheck: (this: WorkspaceShellComponent) => void;
      }).flushWidgetWorkspaceGateRecheck,
    } as {
      pendingWidgetWorkspaceGateRecheckKey: string | null;
      focusProbeInitializedForUser: string | null;
    } & Record<string, unknown>;

    (WorkspaceShellComponent.prototype as unknown as {
      primeWidgetWorkspaceGateSync: (this: WorkspaceShellComponent, startupEntryIntent: {
        entry: 'shortcut' | 'widget' | 'twa';
        intent: 'open-workspace' | null;
        rawIntent: string | null;
      }) => void;
    }).primeWidgetWorkspaceGateSync.call(context as unknown as WorkspaceShellComponent, {
      entry: 'widget',
      intent: 'open-workspace',
      rawIntent: 'open-workspace',
    });

    expect(primeWidgetWorkspaceGateSync).toHaveBeenCalledTimes(1);
    expect(recheckGate).toHaveBeenCalledWith({
      source: 'widget-open-workspace',
      reloadLocal: false,
    });
    expect(context.pendingWidgetWorkspaceGateRecheckKey).toBeNull();
  });

  it('TWA open-workspace 在用户恢复前应保留 Gate 复核，避免点击套壳后延迟到常规探针', () => {
    let currentUserId: string | null = null;
    const primeWidgetWorkspaceGateSync = vi.fn();
    const recheckGate = vi.fn();
    const refreshFocusSessionFromCloud = vi.fn();
    const context = {
      routeUrl: () => '/projects?entry=twa&intent=open-workspace',
      currentUserId: () => currentUserId,
      focusStartupProbe: {
        primeWidgetWorkspaceGateSync,
        recheckGate,
      },
      bootStage: {
        isApplicationReady: () => true,
      },
      dockEngine: {
        refreshFocusSessionFromCloud,
      },
      primedWidgetWorkspaceGateSyncKey: null,
      pendingWidgetWorkspaceGateRecheckKey: null,
      focusProbeInitializedForUser: null,
      flushWidgetWorkspaceGateRecheck: (WorkspaceShellComponent.prototype as unknown as {
        flushWidgetWorkspaceGateRecheck: (this: WorkspaceShellComponent) => void;
      }).flushWidgetWorkspaceGateRecheck,
    } as {
      pendingWidgetWorkspaceGateRecheckKey: string | null;
      focusProbeInitializedForUser: string | null;
    } & Record<string, unknown>;

    (WorkspaceShellComponent.prototype as unknown as {
      primeWidgetWorkspaceGateSync: (this: WorkspaceShellComponent, startupEntryIntent: {
        entry: 'shortcut' | 'widget' | 'twa';
        intent: 'open-workspace' | null;
        rawIntent: string | null;
      }) => void;
    }).primeWidgetWorkspaceGateSync.call(context as unknown as WorkspaceShellComponent, {
      entry: 'twa',
      intent: 'open-workspace',
      rawIntent: 'open-workspace',
    });

    expect(recheckGate).not.toHaveBeenCalled();
    expect(context.pendingWidgetWorkspaceGateRecheckKey).toBe('twa-open-workspace:open-workspace:/projects?entry=twa&intent=open-workspace');

    currentUserId = 'user-1';
    (WorkspaceShellComponent.prototype as unknown as {
      flushWidgetWorkspaceGateRecheck: (this: WorkspaceShellComponent) => void;
    }).flushWidgetWorkspaceGateRecheck.call(context as unknown as WorkspaceShellComponent);

    expect(recheckGate).toHaveBeenCalledWith({
      source: 'widget-open-workspace',
      reloadLocal: false,
    });
    expect(context.pendingWidgetWorkspaceGateRecheckKey).toBeNull();
  });

  it('小组件 Gate pending 复核在用户未恢复前不应被 flush 清空', () => {
    const recheckGate = vi.fn();
    const context = {
      currentUserId: () => null,
      focusStartupProbe: { recheckGate },
      bootStage: { isApplicationReady: () => true },
      pendingWidgetWorkspaceGateRecheckKey: 'widget:open-workspace:/projects',
      focusProbeInitializedForUser: null,
    } as {
      pendingWidgetWorkspaceGateRecheckKey: string | null;
      focusProbeInitializedForUser: string | null;
    } & Record<string, unknown>;

    (WorkspaceShellComponent.prototype as unknown as {
      flushWidgetWorkspaceGateRecheck: (this: WorkspaceShellComponent) => void;
    }).flushWidgetWorkspaceGateRecheck.call(context as unknown as WorkspaceShellComponent);

    expect(recheckGate).not.toHaveBeenCalled();
    expect(context.pendingWidgetWorkspaceGateRecheckKey).toBe('widget:open-workspace:/projects');
  });

  it('TWA open-workspace 应按远端状态复核项目大门', () => {
    const primeWidgetWorkspaceGateSync = vi.fn();
    const refreshFocusSessionFromCloud = vi.fn();
    const context = {
      routeUrl: () => '/projects?entry=twa&intent=open-workspace',
      currentUserId: () => 'user-1',
      focusStartupProbe: {
        primeWidgetWorkspaceGateSync,
      },
      bootStage: {
        isApplicationReady: () => false,
      },
      dockEngine: {
        refreshFocusSessionFromCloud,
      },
      primedWidgetWorkspaceGateSyncKey: null,
      flushWidgetWorkspaceGateRecheck: vi.fn(),
    } as unknown as WorkspaceShellComponent;

    (WorkspaceShellComponent.prototype as unknown as {
      primeWidgetWorkspaceGateSync: (this: WorkspaceShellComponent, startupEntryIntent: {
        entry: 'shortcut' | 'widget' | 'twa';
        intent: 'open-workspace' | null;
        rawIntent: string | null;
      }) => void;
    }).primeWidgetWorkspaceGateSync.call(context, {
      entry: 'twa',
      intent: 'open-workspace',
      rawIntent: 'open-workspace',
    });

    expect(primeWidgetWorkspaceGateSync).toHaveBeenCalledTimes(1);
    expect(refreshFocusSessionFromCloud).toHaveBeenCalledWith('user-1');
  });

  it('consumeStartupEntryIntent 应在执行后保留当前深链接并清理一次性 startup query', () => {
    const navigate = vi.fn();
    const context = {
      router: { navigate },
      routeUrl: () => '/projects/project-1/task/task-1?entry=widget&intent=open-workspace',
    } as unknown as WorkspaceShellComponent;

    (WorkspaceShellComponent.prototype as unknown as {
      consumeStartupEntryIntent: (this: WorkspaceShellComponent) => void;
    }).consumeStartupEntryIntent.call(context);

    expect(navigate).toHaveBeenCalledWith(['/projects', 'project-1', 'task', 'task-1'], { replaceUrl: true });
  });

  it('syncStateFromRoute 应在项目异步到达后补上深链接项目选择', () => {
    const switchActiveProject = vi.fn();
    const navigate = vi.fn();
    const context = {
      getCurrentStartupEntryIntent: () => null,
      route: {
        snapshot: { params: {} },
        firstChild: {
          snapshot: { params: { projectId: 'project-1' } },
          firstChild: null,
        },
      },
      projectState: {
        activeProjectId: () => null,
        projects: () => [{ id: 'project-1' }],
      },
      userSession: {
        switchActiveProject,
        canAuthoritativelyRejectProjectRoute: () => true,
        isProjectAuthoritativelyAccessible: () => true,
        startupProjectCatalogStage: () => 'resolved',
      },
      startupLaunchSnapshot: null,
      router: { navigate },
      resolveStartupProjectFallbackId: vi.fn(),
    } as unknown as WorkspaceShellComponent;

    (WorkspaceShellComponent.prototype as unknown as {
      syncStateFromRoute: (this: WorkspaceShellComponent) => void;
    }).syncStateFromRoute.call(context);

    expect(switchActiveProject).toHaveBeenCalledWith('project-1');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('syncStateFromRoute 在路由项目已选中时仍应触发会话层补水检查', () => {
    const switchActiveProject = vi.fn();
    const navigate = vi.fn();
    const context = {
      getCurrentStartupEntryIntent: () => null,
      route: {
        snapshot: { params: {} },
        firstChild: {
          snapshot: { params: { projectId: 'project-1' } },
          firstChild: null,
        },
      },
      projectState: {
        activeProjectId: () => 'project-1',
        projects: () => [{ id: 'project-1' }],
      },
      userSession: {
        switchActiveProject,
        canAuthoritativelyRejectProjectRoute: () => true,
        isProjectAuthoritativelyAccessible: () => true,
        startupProjectCatalogStage: () => 'resolved',
      },
      startupLaunchSnapshot: null,
      router: { navigate },
      resolveStartupProjectFallbackId: vi.fn(),
    } as unknown as WorkspaceShellComponent;

    (WorkspaceShellComponent.prototype as unknown as {
      syncStateFromRoute: (this: WorkspaceShellComponent) => void;
    }).syncStateFromRoute.call(context);

    expect(switchActiveProject).toHaveBeenCalledWith('project-1');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('syncStateFromRoute 不应把 partial 启动目录误当成完整真相并提前吃掉 deep-link', () => {
    const setActiveProjectId = vi.fn();
    const navigate = vi.fn();
    const context = {
      getCurrentStartupEntryIntent: () => null,
      route: {
        snapshot: { params: {} },
        firstChild: {
          snapshot: { params: { projectId: 'project-9' } },
          firstChild: null,
        },
      },
      projectState: {
        activeProjectId: () => null,
        projects: () => [{ id: 'project-1' }],
      },
      userSession: {
        switchActiveProject: setActiveProjectId,
        canAuthoritativelyRejectProjectRoute: () => false,
        isProjectAuthoritativelyAccessible: () => false,
        startupProjectCatalogStage: () => 'partial',
      },
      startupLaunchSnapshot: null,
      router: { navigate },
      resolveStartupProjectFallbackId: vi.fn(),
    } as unknown as WorkspaceShellComponent;

    (WorkspaceShellComponent.prototype as unknown as {
      syncStateFromRoute: (this: WorkspaceShellComponent) => void;
    }).syncStateFromRoute.call(context);

    expect(setActiveProjectId).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('syncStateFromRoute 应在项目目录已 resolved 且目标不存在时回退到 /projects', () => {
    const navigate = vi.fn();
    const context = {
      getCurrentStartupEntryIntent: () => null,
      route: {
        snapshot: { params: {} },
        firstChild: {
          snapshot: { params: { projectId: 'project-9' } },
          firstChild: null,
        },
      },
      projectState: {
        activeProjectId: () => null,
        projects: () => [{ id: 'project-1' }],
        setActiveProjectId: vi.fn(),
      },
      userSession: {
        canAuthoritativelyRejectProjectRoute: () => true,
        isProjectAuthoritativelyAccessible: () => false,
        startupProjectCatalogStage: () => 'resolved',
      },
      startupLaunchSnapshot: null,
      router: { navigate },
      resolveStartupProjectFallbackId: vi.fn(),
    } as unknown as WorkspaceShellComponent;

    (WorkspaceShellComponent.prototype as unknown as {
      syncStateFromRoute: (this: WorkspaceShellComponent) => void;
    }).syncStateFromRoute.call(context);

    expect(navigate).toHaveBeenCalledWith(['/projects']);
  });

  it('syncStateFromRoute 应在目录转为 authoritative 后清理已被提前写入的陈旧 projectId', () => {
    const navigate = vi.fn();
    const context = {
      getCurrentStartupEntryIntent: () => null,
      route: {
        snapshot: { params: {} },
        firstChild: {
          snapshot: { params: { projectId: 'project-9' } },
          firstChild: null,
        },
      },
      projectState: {
        activeProjectId: () => 'project-9',
        projects: () => [{ id: 'project-1' }],
        setActiveProjectId: vi.fn(),
      },
      userSession: {
        canAuthoritativelyRejectProjectRoute: () => true,
        isProjectAuthoritativelyAccessible: () => false,
        startupProjectCatalogStage: () => 'resolved',
      },
      startupLaunchSnapshot: null,
      router: { navigate },
      resolveStartupProjectFallbackId: vi.fn(),
    } as unknown as WorkspaceShellComponent;

    (WorkspaceShellComponent.prototype as unknown as {
      syncStateFromRoute: (this: WorkspaceShellComponent) => void;
    }).syncStateFromRoute.call(context);

    expect(navigate).toHaveBeenCalledWith(['/projects']);
  });

  it('syncStateFromRoute 不应把本地保留的幽灵项目当成 authoritative 可访问项目', () => {
    const switchActiveProject = vi.fn();
    const navigate = vi.fn();
    const context = {
      getCurrentStartupEntryIntent: () => null,
      route: {
        snapshot: { params: {} },
        firstChild: {
          snapshot: { params: { projectId: 'project-9' } },
          firstChild: null,
        },
      },
      projectState: {
        activeProjectId: () => null,
        projects: () => [{ id: 'project-9' }],
      },
      userSession: {
        switchActiveProject,
        canAuthoritativelyRejectProjectRoute: () => true,
        isProjectAuthoritativelyAccessible: () => false,
        startupProjectCatalogStage: () => 'resolved',
      },
      startupLaunchSnapshot: null,
      router: { navigate },
      resolveStartupProjectFallbackId: vi.fn(),
    } as unknown as WorkspaceShellComponent;

    (WorkspaceShellComponent.prototype as unknown as {
      syncStateFromRoute: (this: WorkspaceShellComponent) => void;
    }).syncStateFromRoute.call(context);

    expect(switchActiveProject).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(['/projects']);
  });

});
