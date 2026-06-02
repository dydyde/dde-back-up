import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { clear } from 'idb-keyval';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../../../services/auth.service';
import { LoggerService } from '../../../services/logger.service';
import { SupabaseClientService } from '../../../services/supabase-client.service';
import { ToastService } from '../../../services/toast.service';
import {
  createBrowserNetworkSuspendedError,
  resetBrowserNetworkSuspensionTrackingForTests,
} from '../../../utils/browser-network-suspension';
import { ExternalSourceCacheService } from './external-source-cache.service';
import { ExternalSourceLinkService } from './external-source-link.service';

function setVisibilityState(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', {
    value: state,
    writable: true,
    configurable: true,
  });
}

describe('ExternalSourceLinkService', () => {
  let upsertPayloads: unknown[];
  let upsertCallCount = 0;
  let selectCallCount = 0;
  let authUser = signal('00000000-0000-0000-0000-000000000001');
  let shouldFailUpsert = false;
  let upsertError: { code?: string; status?: number; message: string } | Error | null = null;
  let remoteRows: unknown[] = [];
  let clientAsyncMock: ReturnType<typeof vi.fn>;
  let loggerCategoryMock: {
    warn: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    await clear();
    vi.useRealTimers();
    resetBrowserNetworkSuspensionTrackingForTests();
    setVisibilityState('visible');
    upsertPayloads = [];
    upsertCallCount = 0;
    selectCallCount = 0;
    authUser = signal('00000000-0000-0000-0000-000000000001');
    shouldFailUpsert = false;
    upsertError = null;
    remoteRows = [];
    loggerCategoryMock = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
    const from = vi.fn((table: string) => ({
      select: vi.fn(() => ({
        eq: vi.fn(async () => {
          selectCallCount += 1;
          return { data: remoteRows, error: null };
        }),
      })),
      upsert: vi.fn(async (payload: unknown) => {
        upsertCallCount += 1;
        if (upsertError) return { error: upsertError };
        if (shouldFailUpsert) return { error: new Error('offline') };
        upsertPayloads.push({ table, payload });
        return { error: null };
      }),
    }));
    clientAsyncMock = vi.fn(async () => ({ from }));

    TestBed.configureTestingModule({
      providers: [
        ExternalSourceLinkService,
        { provide: AuthService, useValue: { currentUserId: authUser } },
        { provide: SupabaseClientService, useValue: { clientAsync: clientAsyncMock } },
        { provide: ToastService, useValue: { success: vi.fn(), info: vi.fn(), error: vi.fn() } },
        { provide: LoggerService, useValue: { category: () => loggerCategoryMock } },
      ],
    });
  });

  afterEach(() => {
    resetBrowserNetworkSuspensionTrackingForTests();
    setVisibilityState('visible');
    vi.useRealTimers();
  });

  it('creates a local-first SiYuan pointer with client uuid and standard deep link', async () => {
    const service = TestBed.inject(ExternalSourceLinkService);

    const link = await service.bindSiyuanBlock('task-1', 'siyuan://blocks/20260426123456-abc1234');

    expect(link?.id).toMatch(/[0-9a-f-]{36}/);
    expect(link?.taskId).toBe('task-1');
    expect(link?.targetId).toBe('20260426123456-abc1234');
    expect(link?.uri).toBe('siyuan://blocks/20260426123456-abc1234?focus=1');
    expect(service.firstActiveLinkForTask('task-1')?.id).toBe(link?.id);
  });

  it('sync payload contains pointer metadata but no preview body fields', async () => {
    const service = TestBed.inject(ExternalSourceLinkService);

    await service.bindSiyuanBlock('task-1', '20260426123456-abc1234');
    await service.flushPendingLinks();

    expect(upsertPayloads).toHaveLength(1);
    const payload = upsertPayloads[0] as { table: string; payload: Record<string, unknown> };
    expect(payload.table).toBe('external_source_links');
    expect(payload.payload).toMatchObject({ task_id: 'task-1', target_id: '20260426123456-abc1234' });
    expect(payload.payload).not.toHaveProperty('content');
    expect(payload.payload).not.toHaveProperty('markdown');
    expect(payload.payload).not.toHaveProperty('kramdown');
    expect(payload.payload).not.toHaveProperty('plainText');
  });



  it('keeps failed pushes in a durable pending queue and flushes later', async () => {
    const service = TestBed.inject(ExternalSourceLinkService);
    shouldFailUpsert = true;

    await service.bindSiyuanBlock('task-1', '20260426123456-abc1234');
    await service.flushPendingLinks();
    expect(upsertPayloads).toHaveLength(0);

    shouldFailUpsert = false;
    await service.flushPendingLinks();

    expect(upsertPayloads).toHaveLength(1);
  });

  it('reloads local links when the current owner changes', async () => {
    const service = TestBed.inject(ExternalSourceLinkService);
    const first = await service.bindSiyuanBlock('task-a', '20260426123456-abc1234');
    expect(service.firstActiveLinkForTask('task-a')?.id).toBe(first?.id);

    authUser.set('00000000-0000-0000-0000-000000000002');
    await service.ensureLoaded();

    expect(service.firstActiveLinkForTask('task-a')).toBeNull();
  });

  it('soft deletes links and hides them from active task anchors', async () => {
    const service = TestBed.inject(ExternalSourceLinkService);
    const link = await service.bindSiyuanBlock('task-1', '20260426123456-abc1234');

    await service.removeLink(link!.id);

    expect(service.firstActiveLinkForTask('task-1')).toBeNull();
  });

  it('replaces a wrong SiYuan pointer in place and clears stale previews', async () => {
    const service = TestBed.inject(ExternalSourceLinkService);
    const cache = TestBed.inject(ExternalSourceCacheService);
    const link = await service.bindSiyuanBlock('task-1', '20260426123456-abc1234');
    await cache.savePreview({
      linkId: link!.id,
      blockId: '20260426123456-abc1234',
      fetchedAt: new Date().toISOString(),
      fetchStatus: 'ready',
      excerpt: '旧块预览',
      truncated: false,
    });

    const replaced = await service.replaceSiyuanBlock(link!.id, '20260426123456-def5678');

    expect(replaced?.id).toBe(link!.id);
    expect(replaced?.targetId).toBe('20260426123456-def5678');
    expect(replaced?.uri).toBe('siyuan://blocks/20260426123456-def5678?focus=1');
    expect(replaced?.label).toBe('思源 2026…5678');
    expect(replaced?.hpath).toBeUndefined();
    expect(service.firstActiveLinkForTask('task-1')?.targetId).toBe('20260426123456-def5678');
    expect(await cache.getPreview(link!.id, '20260426123456-abc1234')).toBeNull();
  });

  it('switches to an existing matching SiYuan pointer instead of creating an active duplicate', async () => {
    const service = TestBed.inject(ExternalSourceLinkService);
    const first = await service.bindSiyuanBlock('task-1', '20260426123456-abc1234');
    const second = await service.bindSiyuanBlock('task-1', '20260426123456-def5678');

    const result = await service.replaceSiyuanBlock(first!.id, '20260426123456-def5678');

    expect(result?.id).toBe(second!.id);
    expect(service.activeLinksForTask('task-1').map(link => link.id)).toEqual([second!.id]);
    expect(service.links().find(link => link.id === first!.id)?.deletedAt).toBeTruthy();
  });

  it('drops pending push on unique-violation (23505) instead of looping forever', async () => {
    const service = TestBed.inject(ExternalSourceLinkService);
    const cache = TestBed.inject(ExternalSourceCacheService);

    upsertError = { code: '23505', message: 'duplicate key value violates unique constraint' };
    await service.bindSiyuanBlock('task-1', '20260426123456-abc1234');
    await service.flushPendingLinks();

    expect(await cache.loadPendingLinks()).toHaveLength(0);
    expect(await cache.loadDeadLetters()).toHaveLength(0);
  });

  it('keeps retry counter so transient failures eventually move to dead letter', async () => {
    const service = TestBed.inject(ExternalSourceLinkService);
    const cache = TestBed.inject(ExternalSourceCacheService);

    shouldFailUpsert = true;
    await service.bindSiyuanBlock('task-1', '20260426123456-abc1234');
    for (let i = 0; i < 6; i++) await service.flushPendingLinks();

    expect(await cache.loadPendingLinks()).toHaveLength(0);
    const deadLetters = await cache.loadDeadLetters();
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0].retryCount).toBeGreaterThan(5);
  });

  it('dedupes concurrent ensureLoaded calls into a single in-flight promise', async () => {
    const service = TestBed.inject(ExternalSourceLinkService);
    const before = clientAsyncMock.mock.calls.length;

    await Promise.all([service.ensureLoaded(), service.ensureLoaded(), service.ensureLoaded()]);
    const after = clientAsyncMock.mock.calls.length;

    // 3 个 caller 只触发一次远端 pull（getClient 调用）；不再每次都重新 pullRemoteLinks。
    expect(after - before).toBe(1);
  });

  it('drops links whose deletedAt is older than the tombstone retention window', async () => {
    // 本地 IndexedDB 中预置一个 30 天前已删除的 link 和一个活跃 link；
    // ensureLoaded 后过期墓碑应被 GC，活跃 link 保留。
    const userId = '00000000-0000-0000-0000-000000000001';
    const now = Date.now();
    const ancient = new Date(now - 31 * 24 * 60 * 60 * 1000).toISOString();
    const fresh = new Date(now).toISOString();
    const cache = TestBed.inject(ExternalSourceCacheService);
    void userId; // ownerId 由 auth mock 保证一致
    await cache.saveLinks([
      {
        id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        taskId: 'task-old',
        sourceType: 'siyuan-block',
        targetId: '20250101120000-old0001',
        uri: 'siyuan://blocks/20250101120000-old0001?focus=1',
        sortOrder: 0,
        deletedAt: ancient,
        createdAt: ancient,
        updatedAt: ancient,
      },
      {
        id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        taskId: 'task-new',
        sourceType: 'siyuan-block',
        targetId: '20260426123456-new0001',
        uri: 'siyuan://blocks/20260426123456-new0001?focus=1',
        sortOrder: 0,
        deletedAt: null,
        createdAt: fresh,
        updatedAt: fresh,
      },
    ]);

    const service = TestBed.inject(ExternalSourceLinkService);
    await service.ensureLoaded();

    const ids = service.links().map((link) => link.id);
    expect(ids).not.toContain('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    expect(ids).toContain('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
  });

  it('refreshIfStale skips remote pull within the staleness window and forces it when force=true', async () => {
    const service = TestBed.inject(ExternalSourceLinkService);
    await service.ensureLoaded();
    const baseline = clientAsyncMock.mock.calls.length;

    // staleness 窗口内调用应直接 no-op，不触发新的 getClient。
    await service.refreshIfStale(false);
    expect(clientAsyncMock.mock.calls.length).toBe(baseline);

    // force=true 强制一次额外 pull（模拟 online 事件 / 用户手动刷新）。
    await service.refreshIfStale(true);
    expect(clientAsyncMock.mock.calls.length).toBeGreaterThan(baseline);
  });

  it('refreshIfStale picks up new remote rows after force refresh', async () => {
    const service = TestBed.inject(ExternalSourceLinkService);
    await service.ensureLoaded();
    expect(service.activeLinks()).toHaveLength(0);

    const now = new Date().toISOString();
    remoteRows = [
      {
        id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        user_id: '00000000-0000-0000-0000-000000000001',
        task_id: 'task-remote',
        source_type: 'siyuan-block',
        target_id: '20260426999999-rem0001',
        uri: 'siyuan://blocks/20260426999999-rem0001?focus=1',
        label: null,
        hpath: null,
        role: null,
        sort_order: 0,
        deleted_at: null,
        created_at: now,
        updated_at: now,
      },
    ];

    await service.refreshIfStale(true);

    expect(service.firstActiveLinkForTask('task-remote')?.id).toBe(
      'cccccccc-cccc-cccc-cccc-cccccccccccc',
    );
  });

  it('浏览器恢复保护期内应延后 remote pull，并在保护期结束后自动补拉', async () => {
    setVisibilityState('hidden');
    const service = TestBed.inject(ExternalSourceLinkService);
    const refreshSpy = vi.spyOn(service, 'refreshIfStale');

    await service.ensureLoaded();
    expect(selectCallCount).toBe(0);

    vi.useFakeTimers();
    try {
      setVisibilityState('visible');
      document.dispatchEvent(new Event('visibilitychange'));

      await vi.advanceTimersByTimeAsync(1549);
      expect(selectCallCount).toBe(0);

      await vi.advanceTimersByTimeAsync(1);
      expect(refreshSpy).toHaveBeenCalledWith(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('BrowserNetworkSuspendedError 不应消耗思源锚点 pending 的 retry budget', async () => {
    const service = TestBed.inject(ExternalSourceLinkService);
    const cache = TestBed.inject(ExternalSourceCacheService);

    upsertError = createBrowserNetworkSuspendedError();
    await service.bindSiyuanBlock('task-1', '20260426123456-abc1234');
    await service.flushPendingLinks();

    const pending = await cache.loadPendingLinks();
    expect(upsertCallCount).toBeGreaterThan(0);
    expect(pending).toHaveLength(1);
    expect(pending[0].retryCount).toBe(0);
    expect(loggerCategoryMock.warn).not.toHaveBeenCalledWith(
      '推送思源锚点失败，已保留本机重试',
      expect.objectContaining({ errorCode: 'browser-network-suspended' }),
    );
  });

  it('suspension 延后 pushLocalNewerLinks 时应保留已有 pending retryCount', async () => {
    const service = TestBed.inject(ExternalSourceLinkService) as unknown as {
      pushLocalNewerLinks(localLinks: Array<Record<string, unknown>>, remoteLinks: Array<Record<string, unknown>>): Promise<void>;
    };
    const cache = TestBed.inject(ExternalSourceCacheService);
    const now = new Date().toISOString();
    const link = {
      id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
      taskId: 'task-1',
      sourceType: 'siyuan-block' as const,
      targetId: '20260426123456-abc1234',
      uri: 'siyuan://blocks/20260426123456-abc1234?focus=1',
      sortOrder: 0,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    await cache.upsertPendingLink(link, { resetRetryCount: true });
    await cache.recordPendingFailure(link.id, 'offline');
    setVisibilityState('hidden');

    await service.pushLocalNewerLinks([link], []);

    const pending = await cache.loadPendingLinks();
    expect(pending).toHaveLength(1);
    expect(pending[0].retryCount).toBe(1);
  });
});
