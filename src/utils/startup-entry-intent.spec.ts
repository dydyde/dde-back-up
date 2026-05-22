import { describe, expect, it } from 'vitest';
import {
  hasAndroidWidgetBootstrapFlag,
  normalizeAndroidWidgetBootstrapRequest,
  normalizeStartupEntryIntent,
  resolveAndroidWidgetBootstrapRequest,
  resolveStartupEntryIntent,
  resolveStartupEntryRouteIntent,
} from './startup-entry-intent';

describe('resolveStartupEntryIntent', () => {
  it('should return null when no explicit startup entry is present', () => {
    expect(resolveStartupEntryIntent('/projects')).toBeNull();
  });

  it('should parse approved shortcut intents', () => {
    expect(resolveStartupEntryIntent('/projects?entry=shortcut&intent=open-workspace')).toEqual({
      entry: 'shortcut',
      intent: 'open-workspace',
      rawIntent: 'open-workspace',
      widgetGateEntryId: null,
    });
  });

  it('should parse explicit twa startup envelopes', () => {
    expect(resolveStartupEntryIntent('/projects?entry=twa&intent=open-workspace')).toEqual({
      entry: 'twa',
      intent: 'open-workspace',
      rawIntent: 'open-workspace',
      widgetGateEntryId: null,
    });
  });

  it('should preserve Android widget bootstrap source on twa envelopes', () => {
    expect(resolveStartupEntryIntent('/projects?entry=twa&intent=open-workspace&widgetBootstrap=1')).toEqual({
      entry: 'twa',
      intent: 'open-workspace',
      rawIntent: 'open-workspace',
      androidWidgetBootstrap: true,
      widgetGateEntryId: null,
    });
  });

  it('should preserve an invalid intent so callers can degrade safely', () => {
    expect(resolveStartupEntryIntent('/projects?entry=shortcut&intent=not-real')).toEqual({
      entry: 'shortcut',
      intent: null,
      rawIntent: 'not-real',
      widgetGateEntryId: null,
    });
  });

  it('should ignore unknown entry sources', () => {
    expect(resolveStartupEntryIntent('/projects?entry=share&intent=open-workspace')).toBeNull();
  });
});

describe('normalizeStartupEntryIntent', () => {
  it('should restore Android widget bootstrap source from persisted startup intent', () => {
    expect(normalizeStartupEntryIntent({
      entry: 'twa',
      intent: 'open-workspace',
      rawIntent: 'open-workspace',
      androidWidgetBootstrap: true,
      widgetGateEntryId: null,
    })).toEqual({
      entry: 'twa',
      intent: 'open-workspace',
      rawIntent: 'open-workspace',
      androidWidgetBootstrap: true,
      widgetGateEntryId: null,
    });
  });
});

describe('resolveStartupEntryRouteIntent', () => {
  it('should preserve explicit startup deep links', () => {
    expect(resolveStartupEntryRouteIntent('/projects/p-1/task/t-9?entry=shortcut&intent=open-focus-tools')).toEqual({
      kind: 'task',
      projectId: 'p-1',
      taskId: 't-9',
    });
  });

  it('should still resolve workspace routes when no project context exists', () => {
    expect(resolveStartupEntryRouteIntent('/projects?entry=shortcut&intent=open-focus-tools')).toEqual({
      kind: 'projects',
      projectId: null,
      taskId: null,
    });
  });
});

describe('resolveAndroidWidgetBootstrapRequest', () => {
  it('should parse a valid Android widget bootstrap envelope', () => {
    expect(resolveAndroidWidgetBootstrapRequest(
      '/projects?entry=twa&intent=open-workspace&widgetBootstrap=1'
      + '&widgetBootstrapReturnUri=nanoflow-widget%3A%2F%2Fbootstrap'
      + '&widgetInstallationId=11111111-1111-4111-8111-111111111111'
      + '&widgetDeviceId=22222222-2222-4222-8222-222222222222'
      + '&widgetDeviceSecret=super-secret-device-key'
      + '&widgetClientVersion=android-widget%2F0.1.0'
      + '&widgetInstanceId=33333333-3333-4333-8333-333333333333'
      + '&widgetHostInstanceId=42'
      + '&widgetSizeBucket=4x2'
      + '&widgetBootstrapNonce=44444444-4444-4444-8444-444444444444'
      + '&widgetPendingPushToken=fcm-token',
    )).toEqual({
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
  });

  it('should reject malformed bootstrap callback targets', () => {
    expect(resolveAndroidWidgetBootstrapRequest(
      '/projects?entry=twa&intent=open-workspace&widgetBootstrap=1'
      + '&widgetBootstrapReturnUri=https%3A%2F%2Fevil.invalid%2Fcallback'
      + '&widgetInstallationId=11111111-1111-4111-8111-111111111111'
      + '&widgetDeviceId=22222222-2222-4222-8222-222222222222'
      + '&widgetDeviceSecret=super-secret-device-key'
      + '&widgetInstanceId=33333333-3333-4333-8333-333333333333'
      + '&widgetHostInstanceId=42'
      + '&widgetSizeBucket=4x2'
      + '&widgetBootstrapNonce=44444444-4444-4444-8444-444444444444',
    )).toBeNull();
  });
});

describe('hasAndroidWidgetBootstrapFlag', () => {
  it('should detect Android widget bootstrap markers', () => {
    expect(hasAndroidWidgetBootstrapFlag('/projects?entry=twa&widgetBootstrap=1')).toBe(true);
    expect(hasAndroidWidgetBootstrapFlag('/projects?entry=twa')).toBe(false);
  });
});

describe('normalizeAndroidWidgetBootstrapRequest', () => {
  it('should restore a persisted Android bootstrap request', () => {
    expect(normalizeAndroidWidgetBootstrapRequest({
      callbackUri: 'nanoflow-widget://bootstrap',
      installationId: '11111111-1111-4111-8111-111111111111',
      deviceId: '22222222-2222-4222-8222-222222222222',
      deviceSecret: 'super-secret-device-key',
      clientVersion: null,
      instanceId: '33333333-3333-4333-8333-333333333333',
      hostInstanceId: '42',
      sizeBucket: '4x2',
      bootstrapNonce: '44444444-4444-4444-8444-444444444444',
      pendingPushToken: 'fcm-token',
    })).toEqual({
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
  });
});
