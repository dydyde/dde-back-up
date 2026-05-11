import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { Injector, runInInjectionContext } from '@angular/core';

import { WriteGuardService } from './write-guard.service';
import { LoggerService } from './logger.service';
import { environment } from '../environments/environment';

const mockLoggerCategory = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const mockLogger = {
  category: () => mockLoggerCategory,
} as unknown as LoggerService;

interface MutableEnv {
  readOnlyPreview: boolean;
  originGateMode: string;
  deploymentTarget: string;
  canonicalOrigin?: string;
}

function buildService(): WriteGuardService {
  const injector = Injector.create({
    providers: [
      { provide: LoggerService, useValue: mockLogger },
    ],
  });
  return runInInjectionContext(injector, () => new WriteGuardService());
}

describe('WriteGuardService', () => {
  let originalEnv: MutableEnv;

  beforeEach(() => {
    mockLoggerCategory.info.mockReset();
    vi.useRealTimers();
    if (typeof sessionStorage !== 'undefined') {
      try {
        sessionStorage.removeItem('__NANOFLOW_WRITE_GUARD__');
        sessionStorage.removeItem('nanoflow.originGate.fired');
      } catch { /* noop */ }
    }
    const env = environment as unknown as MutableEnv;
    originalEnv = {
      readOnlyPreview: env.readOnlyPreview,
      originGateMode: env.originGateMode,
      deploymentTarget: env.deploymentTarget,
      canonicalOrigin: env.canonicalOrigin,
    };
  });

  afterEach(() => {
    const env = environment as unknown as MutableEnv;
    env.readOnlyPreview = originalEnv.readOnlyPreview;
    env.originGateMode = originalEnv.originGateMode;
    env.deploymentTarget = originalEnv.deploymentTarget;
    env.canonicalOrigin = originalEnv.canonicalOrigin;
    vi.useRealTimers();
  });

  it('默认 environment 下 writable，assertWritable 返回 true', () => {
    const env = environment as unknown as MutableEnv;
    env.readOnlyPreview = false;
    env.originGateMode = 'off';
    env.deploymentTarget = 'local';

    const guard = buildService();
    expect(guard.mode()).toBe('writable');
    expect(guard.isReadOnly()).toBe(false);
    expect(guard.assertWritable('test:default')).toBe(true);
    expect(mockLoggerCategory.info).not.toHaveBeenCalled();
  });

  it('readOnlyPreview=true 时进入 read-only', () => {
    const env = environment as unknown as MutableEnv;
    env.readOnlyPreview = true;
    env.originGateMode = 'off';
    env.deploymentTarget = 'local';

    const guard = buildService();
    expect(guard.mode()).toBe('read-only');
    expect(guard.isReadOnly()).toBe(true);
    expect(guard.isExportOnly()).toBe(false);
    expect(guard.assertWritable('test:preview')).toBe(false);
    expect(mockLoggerCategory.info).toHaveBeenCalledTimes(1);
  });

  it('originGateMode=read-only 时进入 read-only', () => {
    const env = environment as unknown as MutableEnv;
    env.readOnlyPreview = false;
    env.originGateMode = 'read-only';
    env.deploymentTarget = 'local';

    const guard = buildService();
    expect(guard.mode()).toBe('read-only');
    expect(guard.isReadOnly()).toBe(true);
  });

  it('originGateMode=export-only 时进入 export-only', () => {
    const env = environment as unknown as MutableEnv;
    env.readOnlyPreview = false;
    env.originGateMode = 'export-only';
    env.deploymentTarget = 'local';

    const guard = buildService();
    expect(guard.mode()).toBe('export-only');
    expect(guard.isExportOnly()).toBe(true);
    expect(guard.assertWritable('test:export')).toBe(false);
  });

  it('deploymentTarget=vercel-legacy 自动进入 export-only（旧 Vercel 割接）', () => {
    const env = environment as unknown as MutableEnv;
    env.readOnlyPreview = false;
    env.originGateMode = 'off';
    env.deploymentTarget = 'vercel-legacy';

    const guard = buildService();
    expect(guard.mode()).toBe('export-only');
    expect(guard.isExportOnly()).toBe(true);
  });

  it('多个标志同时命中时取最严格 mode', () => {
    const env = environment as unknown as MutableEnv;
    env.readOnlyPreview = true;
    env.originGateMode = 'read-only';
    env.deploymentTarget = 'vercel-legacy';

    const guard = buildService();
    expect(guard.mode()).toBe('export-only');
  });

  it('escalateTo 只能向更严格方向升级，不可降级', () => {
    const env = environment as unknown as MutableEnv;
    env.readOnlyPreview = false;
    env.originGateMode = 'off';
    env.deploymentTarget = 'local';

    const guard = buildService();
    expect(guard.mode()).toBe('writable');

    guard.escalateTo('read-only');
    expect(guard.mode()).toBe('read-only');

    guard.escalateTo('writable');
    expect(guard.mode()).toBe('read-only');

    guard.escalateTo('export-only');
    expect(guard.mode()).toBe('export-only');

    guard.escalateTo('read-only');
    expect(guard.mode()).toBe('export-only');
  });

  it('同一模式重复拦截只记录一次 info（防日志洪水）', () => {
    const env = environment as unknown as MutableEnv;
    env.readOnlyPreview = true;
    env.originGateMode = 'off';
    env.deploymentTarget = 'local';

    const guard = buildService();
    guard.assertWritable('a');
    guard.assertWritable('b');
    guard.assertWritable('c');
    expect(mockLoggerCategory.info).toHaveBeenCalledTimes(1);
  });

  it('writable 且 canonical origin 下应自动清理过期 runtime write guard 标记', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-11T12:00:00.000Z'));

    const env = environment as unknown as MutableEnv;
    env.readOnlyPreview = false;
    env.originGateMode = 'off';
    env.deploymentTarget = 'local';
    env.canonicalOrigin = window.location.origin;

    sessionStorage.setItem('__NANOFLOW_WRITE_GUARD__', 'export-only');
    sessionStorage.setItem('nanoflow.originGate.fired', JSON.stringify({
      from: window.location.origin,
      to: window.location.origin,
      mode: 'export-only',
      ts: '2026-05-11T11:40:00.000Z',
    }));

    const guard = buildService();

    expect(guard.mode()).toBe('writable');
    expect(sessionStorage.getItem('__NANOFLOW_WRITE_GUARD__')).toBeNull();
    expect(sessionStorage.getItem('nanoflow.originGate.fired')).toBeNull();
    expect(mockLoggerCategory.info).toHaveBeenCalledWith('writeguard_stale_override_cleared: export-only');
  });

  it('新近的 runtime write guard 标记不应被提前清理', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-11T12:00:00.000Z'));

    const env = environment as unknown as MutableEnv;
    env.readOnlyPreview = false;
    env.originGateMode = 'off';
    env.deploymentTarget = 'local';
    env.canonicalOrigin = window.location.origin;

    sessionStorage.setItem('__NANOFLOW_WRITE_GUARD__', 'export-only');
    sessionStorage.setItem('nanoflow.originGate.fired', JSON.stringify({
      from: window.location.origin,
      to: window.location.origin,
      mode: 'export-only',
      ts: '2026-05-11T11:56:00.000Z',
    }));

    const guard = buildService();

    expect(guard.mode()).toBe('export-only');
    expect(sessionStorage.getItem('__NANOFLOW_WRITE_GUARD__')).toBe('export-only');
  });
});
