import type { LaunchRouteIntent } from '../models/launch-shell';
import { resolveRouteIntent } from './route-intent';

export type StartupEntrySource = 'shortcut' | 'widget' | 'twa';
export type StartupEntryIntentKind =
  | 'open-workspace'
  | 'open-focus-tools'
  | 'open-blackbox-recorder'
  | 'mark-gate-read'
  | 'mark-gate-complete';

const UUID_LIKE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ANDROID_WIDGET_BOOTSTRAP_CALLBACK_SCHEME = 'nanoflow-widget:';
const ANDROID_WIDGET_BOOTSTRAP_CALLBACK_HOST = 'bootstrap';

export interface StartupEntryIntent {
  entry: StartupEntrySource;
  intent: StartupEntryIntentKind | null;
  rawIntent: string | null;
  /** Android 小组件经 TWA bootstrap 进入时，entry 会是 twa，这里保留小组件来源语义。 */
  androidWidgetBootstrap?: true;
  /** 小组件大门按钮透传的 BlackBoxEntry ID（mark-gate-read / mark-gate-complete 专用）。 */
  widgetGateEntryId: string | null;
}

export interface AndroidWidgetBootstrapRequest {
  callbackUri: string;
  installationId: string;
  deviceId: string;
  deviceSecret: string;
  clientVersion: string | null;
  instanceId: string;
  hostInstanceId: string;
  sizeBucket: string;
  bootstrapNonce: string;
  pendingPushToken: string | null;
}

function buildAndroidWidgetBootstrapRequest(input: {
  callbackUri: string | null;
  installationId: string | null;
  deviceId: string | null;
  deviceSecret: string | null;
  clientVersion: string | null;
  instanceId: string | null;
  hostInstanceId: string | null;
  sizeBucket: string | null;
  bootstrapNonce: string | null;
  pendingPushToken: string | null;
}): AndroidWidgetBootstrapRequest | null {
  if (!isAndroidBootstrapCallbackUri(input.callbackUri)) {
    return null;
  }

  if (!isUuidLike(input.installationId) || !isUuidLike(input.deviceId) || !isUuidLike(input.instanceId) || !isUuidLike(input.bootstrapNonce)) {
    return null;
  }

  if (!isNonEmptyText(input.deviceSecret, 128) || !isNonEmptyText(input.hostInstanceId, 128) || !isNonEmptyText(input.sizeBucket, 32)) {
    return null;
  }

  return {
    callbackUri: input.callbackUri,
    installationId: input.installationId,
    deviceId: input.deviceId,
    deviceSecret: input.deviceSecret.trim(),
    clientVersion: isNonEmptyText(input.clientVersion, 256) ? input.clientVersion.trim() : null,
    instanceId: input.instanceId,
    hostInstanceId: input.hostInstanceId.trim(),
    sizeBucket: input.sizeBucket.trim(),
    bootstrapNonce: input.bootstrapNonce,
    pendingPushToken: isNonEmptyText(input.pendingPushToken, 4096) ? input.pendingPushToken.trim() : null,
  };
}

function readStartupEntryParams(routeUrl: string | null): URLSearchParams | null {
  if (!routeUrl) {
    return null;
  }

  const queryIndex = routeUrl.indexOf('?');
  if (queryIndex < 0) {
    return null;
  }

  const query = routeUrl.slice(queryIndex + 1).split('#', 1)[0] ?? '';
  return query ? new URLSearchParams(query) : null;
}

function isStartupEntrySource(value: string | null): value is StartupEntrySource {
  return value === 'shortcut' || value === 'widget' || value === 'twa';
}

function isStartupEntryIntentKind(value: string | null): value is StartupEntryIntentKind {
  return value === 'open-workspace'
    || value === 'open-focus-tools'
    || value === 'open-blackbox-recorder'
    || value === 'mark-gate-read'
    || value === 'mark-gate-complete';
}

function isUuidLike(value: string | null): value is string {
  return typeof value === 'string' && UUID_LIKE_PATTERN.test(value);
}

function isNonEmptyText(value: string | null, maxLength = 256): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= maxLength;
}

function isAndroidBootstrapCallbackUri(value: string | null): value is string {
  if (!isNonEmptyText(value, 512)) {
    return false;
  }

  try {
    const uri = new URL(value);
    return uri.protocol === ANDROID_WIDGET_BOOTSTRAP_CALLBACK_SCHEME
      && uri.host === ANDROID_WIDGET_BOOTSTRAP_CALLBACK_HOST
      && (uri.pathname === '' || uri.pathname === '/');
  } catch {
    return false;
  }
}

export function hasAndroidWidgetBootstrapFlag(routeUrl: string | null): boolean {
  const params = readStartupEntryParams(routeUrl);
  return params?.get('widgetBootstrap') === '1';
}

export function resolveStartupEntryIntent(routeUrl: string | null): StartupEntryIntent | null {
  const params = readStartupEntryParams(routeUrl);
  if (!params) {
    return null;
  }

  const rawEntry = params.get('entry');
  if (!isStartupEntrySource(rawEntry)) {
    return null;
  }

  const rawIntent = params.get('intent');
  const rawGateEntryId = params.get('widgetGateEntryId');
  const intent: StartupEntryIntent = {
    entry: rawEntry,
    intent: isStartupEntryIntentKind(rawIntent) ? rawIntent : null,
    rawIntent,
    widgetGateEntryId: isUuidLike(rawGateEntryId) ? rawGateEntryId : null,
  };

  if (rawEntry === 'twa' && params.get('widgetBootstrap') === '1') {
    intent.androidWidgetBootstrap = true;
  }

  return intent;
}

export function normalizeStartupEntryIntent(value: unknown): StartupEntryIntent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const rawEntry = typeof record.entry === 'string' ? record.entry : null;
  if (!isStartupEntrySource(rawEntry)) {
    return null;
  }

  const rawIntent = typeof record.rawIntent === 'string'
    ? record.rawIntent
    : typeof record.intent === 'string'
      ? record.intent
      : null;
  const intent = typeof record.intent === 'string' && isStartupEntryIntentKind(record.intent)
    ? record.intent
    : null;

  const rawGateEntryId = typeof record.widgetGateEntryId === 'string' ? record.widgetGateEntryId : null;

  const intentValue: StartupEntryIntent = {
    entry: rawEntry,
    intent,
    rawIntent,
    widgetGateEntryId: isUuidLike(rawGateEntryId) ? rawGateEntryId : null,
  };

  if (record.androidWidgetBootstrap === true) {
    intentValue.androidWidgetBootstrap = true;
  }

  return intentValue;
}

export function resolveAndroidWidgetBootstrapRequest(routeUrl: string | null): AndroidWidgetBootstrapRequest | null {
  const startupEntryIntent = resolveStartupEntryIntent(routeUrl);
  if (!startupEntryIntent || startupEntryIntent.entry !== 'twa') {
    return null;
  }

  const params = readStartupEntryParams(routeUrl);
  if (!params || params.get('widgetBootstrap') !== '1') {
    return null;
  }

  const callbackUri = params.get('widgetBootstrapReturnUri');
  const installationId = params.get('widgetInstallationId');
  const deviceId = params.get('widgetDeviceId');
  const deviceSecret = params.get('widgetDeviceSecret');
  const clientVersion = params.get('widgetClientVersion');
  const instanceId = params.get('widgetInstanceId');
  const hostInstanceId = params.get('widgetHostInstanceId');
  const sizeBucket = params.get('widgetSizeBucket');
  const bootstrapNonce = params.get('widgetBootstrapNonce');
  const pendingPushToken = params.get('widgetPendingPushToken');

  return buildAndroidWidgetBootstrapRequest({
    callbackUri,
    installationId,
    deviceId,
    deviceSecret,
    clientVersion,
    instanceId,
    hostInstanceId,
    sizeBucket,
    bootstrapNonce,
    pendingPushToken,
  });
}

export function normalizeAndroidWidgetBootstrapRequest(value: unknown): AndroidWidgetBootstrapRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  return buildAndroidWidgetBootstrapRequest({
    callbackUri: typeof record.callbackUri === 'string' ? record.callbackUri : null,
    installationId: typeof record.installationId === 'string' ? record.installationId : null,
    deviceId: typeof record.deviceId === 'string' ? record.deviceId : null,
    deviceSecret: typeof record.deviceSecret === 'string' ? record.deviceSecret : null,
    clientVersion: typeof record.clientVersion === 'string' ? record.clientVersion : null,
    instanceId: typeof record.instanceId === 'string' ? record.instanceId : null,
    hostInstanceId: typeof record.hostInstanceId === 'string' ? record.hostInstanceId : null,
    sizeBucket: typeof record.sizeBucket === 'string' ? record.sizeBucket : null,
    bootstrapNonce: typeof record.bootstrapNonce === 'string' ? record.bootstrapNonce : null,
    pendingPushToken: typeof record.pendingPushToken === 'string' ? record.pendingPushToken : null,
  });
}

export function resolveStartupEntryRouteIntent(routeUrl: string | null): LaunchRouteIntent | null {
  if (!resolveStartupEntryIntent(routeUrl)) {
    return null;
  }

  return resolveRouteIntent(routeUrl, null);
}
