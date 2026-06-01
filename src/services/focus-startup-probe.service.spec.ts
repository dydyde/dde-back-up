import { Injector, signal } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FocusStartupProbeService } from './focus-startup-probe.service';
import { AuthService } from './auth.service';
import { BlackBoxSyncService } from './black-box-sync.service';
import { GateService } from './gate.service';
import { LoggerService } from './logger.service';
import { gateState, resetFocusState } from '../state/focus-stores';

describe('FocusStartupProbeService', () => {
  const flushPromises = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
  };

  beforeEach(() => {
    resetFocusState();
  });

  it('应立即执行本地检查并更新待处理状态', async () => {
    const loadFromLocal = vi.fn().mockResolvedValue([]);
    const checkGate = vi.fn(() => gateState.set('reviewing'));
    const pullChanges = vi.fn().mockResolvedValue(undefined);
    const userIdSignal = signal<string | null>('user-1');

    const injector = Injector.create({
      providers: [
        { provide: FocusStartupProbeService, useClass: FocusStartupProbeService },
        { provide: AuthService, useValue: { currentUserId: userIdSignal } },
        { provide: BlackBoxSyncService, useValue: { loadFromLocal, pullChanges } },
        { provide: GateService, useValue: { checkGate, state: gateState } },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              debug: vi.fn(),
              warn: vi.fn(),
              info: vi.fn(),
              error: vi.fn(),
            }),
          },
        },
      ],
    });

    const service = injector.get(FocusStartupProbeService);
    service.initialize();
    await flushPromises();

    expect(loadFromLocal).toHaveBeenCalledTimes(1);
    expect(pullChanges).toHaveBeenCalledWith({
      reason: 'gate-review',
      force: true,
      expectedUserId: 'user-1',
    });
    expect(checkGate).toHaveBeenCalledTimes(2);
    expect(service.isProbeDone()).toBe(true);
    expect(service.hasPendingGateWork()).toBe(true);
  });

  it('项目入口应先用当前快照激活大门，再继续本地与远端复核', async () => {
    const loadFromLocal = vi.fn().mockResolvedValue([]);
    const checkGate = vi.fn(() => gateState.set('reviewing'));
    const pullChanges = vi.fn().mockResolvedValue(undefined);
    const userIdSignal = signal<string | null>('user-1');

    const injector = Injector.create({
      providers: [
        { provide: FocusStartupProbeService, useClass: FocusStartupProbeService },
        { provide: AuthService, useValue: { currentUserId: userIdSignal } },
        { provide: BlackBoxSyncService, useValue: { loadFromLocal, pullChanges } },
        { provide: GateService, useValue: { checkGate, state: gateState } },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              debug: vi.fn(),
              warn: vi.fn(),
              info: vi.fn(),
              error: vi.fn(),
            }),
          },
        },
      ],
    });

    const service = injector.get(FocusStartupProbeService);
    service.checkGateForProjectEntry();

    expect(checkGate).toHaveBeenCalledTimes(1);
    expect(service.hasPendingGateWork()).toBe(true);

    await flushPromises();

    expect(loadFromLocal).toHaveBeenCalledTimes(1);
    expect(pullChanges).toHaveBeenCalledWith({
      reason: 'gate-review',
      force: true,
      expectedUserId: 'user-1',
    });
    expect(checkGate).toHaveBeenCalledTimes(3);
    expect(service.isProbeDone()).toBe(true);
  });

  it('项目入口探针在远端复核进行中应避免重复强制拉取', async () => {
    let resolvePull = (): void => undefined;
    const loadFromLocal = vi.fn().mockResolvedValue([]);
    const checkGate = vi.fn(() => gateState.set('reviewing'));
    const pullChanges = vi.fn().mockImplementation(() => new Promise<void>((resolve) => {
      resolvePull = resolve;
    }));
    const userIdSignal = signal<string | null>('user-1');

    const injector = Injector.create({
      providers: [
        { provide: FocusStartupProbeService, useClass: FocusStartupProbeService },
        { provide: AuthService, useValue: { currentUserId: userIdSignal } },
        { provide: BlackBoxSyncService, useValue: { loadFromLocal, pullChanges } },
        { provide: GateService, useValue: { checkGate, state: gateState } },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              debug: vi.fn(),
              warn: vi.fn(),
              info: vi.fn(),
              error: vi.fn(),
            }),
          },
        },
      ],
    });

    const service = injector.get(FocusStartupProbeService);
    service.checkGateForProjectEntry();
    await flushPromises();

    expect(loadFromLocal).toHaveBeenCalledTimes(1);
    expect(pullChanges).toHaveBeenCalledTimes(1);
    expect(checkGate).toHaveBeenCalledTimes(2);

    service.checkGateForProjectEntry();

    expect(loadFromLocal).toHaveBeenCalledTimes(1);
    expect(pullChanges).toHaveBeenCalledTimes(1);
    expect(checkGate).toHaveBeenCalledTimes(3);

    resolvePull();
    await flushPromises();

    expect(pullChanges).toHaveBeenCalledTimes(1);
    expect(checkGate).toHaveBeenCalledTimes(4);
  });

  it('本地与远端都未命中时应在 gate-review 复核后保持无待处理状态', async () => {
    const loadFromLocal = vi.fn().mockResolvedValue([]);
    const checkGate = vi.fn(() => gateState.set('bypassed'));
    const pullChanges = vi.fn().mockResolvedValue(undefined);
    const userIdSignal = signal<string | null>('user-1');

    const injector = Injector.create({
      providers: [
        { provide: FocusStartupProbeService, useClass: FocusStartupProbeService },
        { provide: AuthService, useValue: { currentUserId: userIdSignal } },
        { provide: BlackBoxSyncService, useValue: { loadFromLocal, pullChanges } },
        { provide: GateService, useValue: { checkGate, state: gateState } },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              debug: vi.fn(),
              warn: vi.fn(),
              info: vi.fn(),
              error: vi.fn(),
            }),
          },
        },
      ],
    });

    const service = injector.get(FocusStartupProbeService);
    service.initialize();
    await flushPromises();

    expect(pullChanges).toHaveBeenCalledWith({
      reason: 'gate-review',
      force: true,
      expectedUserId: 'user-1',
    });
    expect(checkGate).toHaveBeenCalledTimes(2);
    expect(service.hasPendingGateWork()).toBe(false);
  });

  it('小组件打开项目时应先拉取远端黑匣子再检查大门，避免旧本地快照复活已读内容', async () => {
    const loadFromLocal = vi.fn().mockResolvedValue([]);
    const checkGate = vi.fn(() => gateState.set('bypassed'));
    const pullChanges = vi.fn().mockResolvedValue(undefined);
    const userIdSignal = signal<string | null>('user-1');

    const injector = Injector.create({
      providers: [
        { provide: FocusStartupProbeService, useClass: FocusStartupProbeService },
        { provide: AuthService, useValue: { currentUserId: userIdSignal } },
        { provide: BlackBoxSyncService, useValue: { loadFromLocal, pullChanges } },
        { provide: GateService, useValue: { checkGate, state: gateState } },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              debug: vi.fn(),
              warn: vi.fn(),
              info: vi.fn(),
              error: vi.fn(),
            }),
          },
        },
      ],
    });

    const service = injector.get(FocusStartupProbeService);
    service.primeWidgetWorkspaceGateSync();
    service.initialize();
    await flushPromises();

    expect(loadFromLocal).not.toHaveBeenCalled();
    expect(pullChanges).toHaveBeenCalledWith({
      reason: 'gate-review',
      force: true,
      expectedUserId: 'user-1',
    });
    expect(checkGate).toHaveBeenCalledTimes(1);
    expect(service.hasPendingGateWork()).toBe(false);
  });

  it('本地快照未命中时应强制执行 gate-review 远端复核并再次检查大门', async () => {
    const loadFromLocal = vi.fn().mockResolvedValue([]);
    const checkGate = vi
      .fn()
      .mockImplementationOnce(() => gateState.set('bypassed'))
      .mockImplementationOnce(() => gateState.set('reviewing'));
    const pullChanges = vi.fn().mockResolvedValue(true);
    const userIdSignal = signal<string | null>('user-1');

    const injector = Injector.create({
      providers: [
        { provide: FocusStartupProbeService, useClass: FocusStartupProbeService },
        { provide: AuthService, useValue: { currentUserId: userIdSignal } },
        { provide: BlackBoxSyncService, useValue: { loadFromLocal, pullChanges } },
        { provide: GateService, useValue: { checkGate, state: gateState } },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              debug: vi.fn(),
              warn: vi.fn(),
              info: vi.fn(),
              error: vi.fn(),
            }),
          },
        },
      ],
    });

    const service = injector.get(FocusStartupProbeService);
    service.initialize();
    await flushPromises();

    expect(loadFromLocal).toHaveBeenCalledTimes(1);
    expect(pullChanges).toHaveBeenCalledWith({
      reason: 'gate-review',
      force: true,
      expectedUserId: 'user-1',
    });
    expect(checkGate).toHaveBeenCalledTimes(2);
    expect(service.hasPendingGateWork()).toBe(true);
  });

  it('相同用户重复 initialize 应保持结果信号稳定', async () => {
    const loadFromLocal = vi.fn().mockResolvedValue([]);
    const checkGate = vi.fn(() => gateState.set('bypassed'));
    const pullChanges = vi.fn().mockResolvedValue(undefined);
    const userIdSignal = signal<string | null>('user-1');

    const injector = Injector.create({
      providers: [
        { provide: FocusStartupProbeService, useClass: FocusStartupProbeService },
        { provide: AuthService, useValue: { currentUserId: userIdSignal } },
        { provide: BlackBoxSyncService, useValue: { loadFromLocal, pullChanges } },
        { provide: GateService, useValue: { checkGate, state: gateState } },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              debug: vi.fn(),
              warn: vi.fn(),
              info: vi.fn(),
              error: vi.fn(),
            }),
          },
        },
      ],
    });

    const service = injector.get(FocusStartupProbeService);
    service.initialize();
    await flushPromises();
    service.initialize();
    await flushPromises();

    expect(loadFromLocal).toHaveBeenCalledTimes(1);
    expect(pullChanges).toHaveBeenCalledTimes(1);
    expect(service.isProbeDone()).toBe(true);
    expect(service.hasPendingGateWork()).toBe(false);
  });

  it('resume-local 强制重探测时应绕过一次性初始化保护', async () => {
    const loadFromLocal = vi.fn().mockResolvedValue([]);
    const checkGate = vi.fn(() => gateState.set('reviewing'));
    const pullChanges = vi.fn().mockResolvedValue(undefined);
    const userIdSignal = signal<string | null>('user-1');

    const injector = Injector.create({
      providers: [
        { provide: FocusStartupProbeService, useClass: FocusStartupProbeService },
        { provide: AuthService, useValue: { currentUserId: userIdSignal } },
        { provide: BlackBoxSyncService, useValue: { loadFromLocal, pullChanges } },
        { provide: GateService, useValue: { checkGate, state: gateState } },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              debug: vi.fn(),
              warn: vi.fn(),
              info: vi.fn(),
              error: vi.fn(),
            }),
          },
        },
      ],
    });

    const service = injector.get(FocusStartupProbeService);
    service.initialize();
    await flushPromises();

    await service.recheckGate({ source: 'resume-local' });

    expect(loadFromLocal).toHaveBeenCalledTimes(2);
    expect(pullChanges).toHaveBeenCalledTimes(2);
    expect(checkGate).toHaveBeenCalledTimes(4);
    expect(service.hasPendingGateWork()).toBe(true);
  });

  it('resume-remote 重探测应直接复核 gate 而不重复读取本地缓存', async () => {
    const loadFromLocal = vi.fn().mockResolvedValue([]);
    const checkGate = vi.fn(() => gateState.set('reviewing'));
    const pullChanges = vi.fn().mockResolvedValue(undefined);
    const userIdSignal = signal<string | null>('user-1');

    const injector = Injector.create({
      providers: [
        { provide: FocusStartupProbeService, useClass: FocusStartupProbeService },
        { provide: AuthService, useValue: { currentUserId: userIdSignal } },
        { provide: BlackBoxSyncService, useValue: { loadFromLocal, pullChanges } },
        { provide: GateService, useValue: { checkGate, state: gateState } },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              debug: vi.fn(),
              warn: vi.fn(),
              info: vi.fn(),
              error: vi.fn(),
            }),
          },
        },
      ],
    });

    const service = injector.get(FocusStartupProbeService);
    await service.recheckGate({ source: 'resume-remote', reloadLocal: false });

    expect(loadFromLocal).not.toHaveBeenCalled();
    expect(pullChanges).toHaveBeenCalledWith({
      reason: 'gate-review',
      force: true,
      expectedUserId: 'user-1',
    });
    expect(checkGate).toHaveBeenCalledTimes(1);
    expect(service.hasPendingGateWork()).toBe(true);
  });

  it('恢复时 auth 信号短暂为空，force recheck 仍应沿用已初始化用户完成 gate 复核', async () => {
    const loadFromLocal = vi.fn().mockResolvedValue([]);
    const checkGate = vi.fn(() => gateState.set('reviewing'));
    const pullChanges = vi.fn().mockResolvedValue(undefined);
    const userIdSignal = signal<string | null>('user-1');

    const injector = Injector.create({
      providers: [
        { provide: FocusStartupProbeService, useClass: FocusStartupProbeService },
        { provide: AuthService, useValue: { currentUserId: userIdSignal } },
        { provide: BlackBoxSyncService, useValue: { loadFromLocal, pullChanges } },
        { provide: GateService, useValue: { checkGate, state: gateState } },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              debug: vi.fn(),
              warn: vi.fn(),
              info: vi.fn(),
              error: vi.fn(),
            }),
          },
        },
      ],
    });

    const service = injector.get(FocusStartupProbeService);
    service.initialize();
    await flushPromises();

    userIdSignal.set(null);
    await service.recheckGate({ source: 'resume-local' });

    expect(loadFromLocal).toHaveBeenCalledTimes(2);
    expect(pullChanges).toHaveBeenCalledTimes(2);
    expect(checkGate).toHaveBeenCalledTimes(4);
    expect(service.hasPendingGateWork()).toBe(true);
  });

  it('首次恢复时若 currentUserId 尚未回填，应回退到持久化 session hint 完成 gate 复核', async () => {
    const loadFromLocal = vi.fn().mockResolvedValue([]);
    const checkGate = vi.fn(() => gateState.set('reviewing'));
    const pullChanges = vi.fn().mockResolvedValue(undefined);
    const userIdSignal = signal<string | null>(null);

    const injector = Injector.create({
      providers: [
        { provide: FocusStartupProbeService, useClass: FocusStartupProbeService },
        {
          provide: AuthService,
          useValue: {
            currentUserId: userIdSignal,
            peekPersistedSessionIdentity: () => ({ userId: 'user-1' }),
            peekPersistedOwnerHint: () => 'user-1',
          },
        },
        { provide: BlackBoxSyncService, useValue: { loadFromLocal, pullChanges } },
        { provide: GateService, useValue: { checkGate, state: gateState } },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              debug: vi.fn(),
              warn: vi.fn(),
              info: vi.fn(),
              error: vi.fn(),
            }),
          },
        },
      ],
    });

    const service = injector.get(FocusStartupProbeService);
    await service.recheckGate({ source: 'resume-local' });

    expect(loadFromLocal).toHaveBeenCalledTimes(1);
    expect(pullChanges).toHaveBeenCalledWith({
      reason: 'gate-review',
      force: true,
      expectedUserId: 'user-1',
    });
    expect(checkGate).toHaveBeenCalledTimes(2);
    expect(service.hasPendingGateWork()).toBe(true);
  });
});
