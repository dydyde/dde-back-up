import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { Injector, runInInjectionContext } from '@angular/core';

import { SyncRpcClientService } from './sync-rpc-client.service';
import { SupabaseClientService } from './supabase-client.service';
import { LoggerService } from './logger.service';
import { environment } from '../environments/environment';
import type { Task, Connection, BlackBoxEntry, Project } from '../models';

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
  syncRpcEnabled?: boolean;
  syncProtocolVersion?: number;
  deploymentEpoch?: number;
  deploymentTarget?: string;
  sentryRelease?: string;
  canonicalOrigin?: string;
}

function buildService(rpcImpl: (name: string, payload: unknown) => Promise<{ data: unknown; error: { message: string } | null }>): SyncRpcClientService {
  const mockSupabase = {
    clientAsync: vi.fn(async () => ({
      rpc: vi.fn(async (name: string, args: { payload: unknown }) => rpcImpl(name, args?.payload)),
    })),
  } as unknown as SupabaseClientService;

  const injector = Injector.create({
    providers: [
      { provide: SupabaseClientService, useValue: mockSupabase },
      { provide: LoggerService, useValue: mockLogger },
    ],
  });
  return runInInjectionContext(injector, () => new SyncRpcClientService());
}

describe('SyncRpcClientService', () => {
  let originalEnv: MutableEnv;

  beforeEach(() => {
    mockLoggerCategory.info.mockReset();
    mockLoggerCategory.warn.mockReset();
    const env = environment as unknown as MutableEnv;
    originalEnv = {
      syncRpcEnabled: env.syncRpcEnabled,
      syncProtocolVersion: env.syncProtocolVersion,
      deploymentEpoch: env.deploymentEpoch,
      deploymentTarget: env.deploymentTarget,
      sentryRelease: env.sentryRelease,
      canonicalOrigin: env.canonicalOrigin,
    };
  });

  afterEach(() => {
    const env = environment as unknown as MutableEnv;
    env.syncRpcEnabled = originalEnv.syncRpcEnabled;
    env.syncProtocolVersion = originalEnv.syncProtocolVersion;
    env.deploymentEpoch = originalEnv.deploymentEpoch;
    env.deploymentTarget = originalEnv.deploymentTarget;
    env.sentryRelease = originalEnv.sentryRelease;
    env.canonicalOrigin = originalEnv.canonicalOrigin;
  });

  it('checkProtocol 在 feature 关闭但服务端支持时应自动开启 RPC', async () => {
    const env = environment as unknown as MutableEnv;
    env.syncRpcEnabled = false;

    const rpc = vi.fn(async () => ({ data: { minProtocolVersion: 1 }, error: null }));
    const service = buildService(rpc as never);
    const result = await service.checkProtocol();
    expect(result).toEqual({ minProtocolVersion: 1, deploymentEpoch: 0 });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(service.isFeatureEnabled()).toBe(true);
  });

  it('checkProtocol 在 feature 关闭且探测失败时保持关闭', async () => {
    const env = environment as unknown as MutableEnv;
    env.syncRpcEnabled = false;

    const rpc = vi.fn(async () => ({ data: null, error: { message: 'pgrst-404' } }));
    const service = buildService(rpc as never);
    const result = await service.checkProtocol();
    expect(result).toBeNull();
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(service.isFeatureEnabled()).toBe(false);
  });

  it('checkProtocol 在 deploymentEpoch 落后时不应自动开启 RPC', async () => {
    const env = environment as unknown as MutableEnv;
    env.syncRpcEnabled = false;
    env.syncProtocolVersion = 1;
    env.deploymentEpoch = 0;

    const rpc = vi.fn(async () => ({ data: { minProtocolVersion: 1, deploymentEpoch: 3 }, error: null }));
    const service = buildService(rpc as never);
    const result = await service.checkProtocol();

    expect(result).toEqual({ minProtocolVersion: 1, deploymentEpoch: 3 });
    expect(service.isFeatureEnabled()).toBe(false);
    expect(service.isClientRejected()).toBe(true);
  });

  it('checkProtocol 对失败探测结果应做缓存，避免重复阻塞写入路径', async () => {
    const env = environment as unknown as MutableEnv;
    env.syncRpcEnabled = false;

    const rpc = vi.fn(async () => ({ data: null, error: { message: 'pgrst-404' } }));
    const service = buildService(rpc as never);

    await expect(service.checkProtocol()).resolves.toBeNull();
    await expect(service.checkProtocol()).resolves.toBeNull();

    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('checkProtocol 解析 minProtocolVersion + deploymentEpoch', async () => {
    const env = environment as unknown as MutableEnv;
    env.syncRpcEnabled = true;
    env.syncProtocolVersion = 1;

    const rpc = vi.fn(async () => ({ data: { minProtocolVersion: 2, deploymentEpoch: 7 }, error: null }));
    const service = buildService(rpc as never);
    const result = await service.checkProtocol();
    expect(result).toEqual({ minProtocolVersion: 2, deploymentEpoch: 7 });
    expect(service.isClientRejected()).toBe(true);
  });

  it('checkProtocol RPC 错误返回 null（向后兼容）', async () => {
    const env = environment as unknown as MutableEnv;
    env.syncRpcEnabled = true;

    const rpc = vi.fn(async () => ({ data: null, error: { message: 'pgrst-503' } }));
    const service = buildService(rpc as never);
    const result = await service.checkProtocol();
    expect(result).toBeNull();
    expect(mockLoggerCategory.warn).toHaveBeenCalled();
  });

  it('upsertTask: applied 状态解析 entityId / status', async () => {
    const env = environment as unknown as MutableEnv;
    env.syncRpcEnabled = true;
    env.syncProtocolVersion = 1;

    const rpc = vi.fn(async (_name, _payload) => ({
      data: { status: 'applied', operation_id: 'op-1', task_id: 'task-9', updated_at: '2026-04-30T00:00:01.000Z' },
      error: null,
    }));

    const service = buildService(rpc as never);
    const result = await service.upsertTask({
      operationId: 'op-1',
      task: { id: 'task-9', projectId: 'p-1', content: 'hi' } as unknown as Task,
      baseUpdatedAt: null,
    });

    expect(result.status).toBe('applied');
    expect(result.entityId).toBe('task-9');
    expect(result.serverUpdatedAt).toBe('2026-04-30T00:00:01.000Z');
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('upsertBlackboxEntry: 应解析服务端 stale_payload 标记', async () => {
    const env = environment as unknown as MutableEnv;
    env.syncRpcEnabled = true;
    env.syncProtocolVersion = 1;

    const rpc = vi.fn(async () => ({
      data: {
        status: 'applied',
        entry_id: 'entry-9',
        updated_at: '2026-05-16T00:00:01.000Z',
        stale_payload: true,
      },
      error: null,
    }));

    const service = buildService(rpc as never);
    const result = await service.upsertBlackboxEntry({
      operationId: 'op-blackbox-stale',
      entry: { id: 'entry-9', projectId: null, content: 'hi' } as unknown as BlackBoxEntry,
      baseUpdatedAt: '2026-05-16T00:00:00.000Z',
    });

    expect(result.status).toBe('applied');
    expect(result.entityId).toBe('entry-9');
    expect(result.serverUpdatedAt).toBe('2026-05-16T00:00:01.000Z');
    expect(result.stalePayload).toBe(true);
  });

  it('upsertTask: 序列化完整同步字段供 batch_upsert_tasks 使用', async () => {
    const env = environment as unknown as MutableEnv;
    env.syncRpcEnabled = true;
    env.syncProtocolVersion = 4;
    env.deploymentEpoch = 12;
    env.deploymentTarget = 'cloudflare-pages';
    env.sentryRelease = 'git-sha';
    env.canonicalOrigin = 'https://nanoflow.pages.dev';

    let captured: unknown = null;
    const rpc = vi.fn(async (_name, payload) => {
      captured = payload;
      return { data: { status: 'applied', task_id: 'task-full' }, error: null };
    });

    const service = buildService(rpc as never);
    await service.upsertTask({
      operationId: 'op-full',
      task: {
        id: 'task-full',
        projectId: 'project-1',
        title: 'Full title',
        content: 'Full content',
        stage: 2,
        parentId: 'parent-1',
        order: 3,
        rank: 4000,
        status: 'completed',
        x: 10,
        y: 20,
        shortId: 'S-1',
        priority: 'high',
        dueDate: '2026-05-01',
        expected_minutes: 25,
        cognitive_load: 'high',
        wait_minutes: 5,
        tags: ['sync'],
        completedAt: '2026-04-30T01:00:00.000Z',
        updatedAt: '2026-04-30T00:05:00.000Z',
        deletedAt: null,
        attachments: [{ id: 'att-1' }],
        parkingMeta: { state: 'parked' },
      } as unknown as Task,
      baseUpdatedAt: '2026-04-30T00:00:00.000Z',
    });

    const cap = captured as { task: Record<string, unknown> };
    expect(cap).toMatchObject({
      operation_id: 'op-full',
      protocol_version: 4,
      base_updated_at: '2026-04-30T00:00:00.000Z',
      client_git_sha: 'git-sha',
      client_origin: 'https://nanoflow.pages.dev',
      deployment_epoch: 12,
      deployment_target: 'cloudflare-pages',
    });
    expect(cap.task).toMatchObject({
      id: 'task-full',
      project_id: 'project-1',
      title: 'Full title',
      content: 'Full content',
      stage: 2,
      parent_id: 'parent-1',
      order: 3,
      rank: 4000,
      status: 'completed',
      x: 10,
      y: 20,
      short_id: 'S-1',
      priority: 'high',
      due_date: '2026-05-01',
      expected_minutes: 25,
      cognitive_load: 'high',
      wait_minutes: 5,
      tags: ['sync'],
      completed_at: '2026-04-30T01:00:00.000Z',
      updated_at: '2026-04-30T00:05:00.000Z',
      deleted_at: null,
      attachments: [{ id: 'att-1' }],
      parking_meta: { state: 'parked' },
    });
  });

  it('upsertTask: remote-newer 状态解析 remoteUpdatedAt', async () => {
    const env = environment as unknown as MutableEnv;
    env.syncRpcEnabled = true;
    env.syncProtocolVersion = 1;

    const rpc = vi.fn(async () => ({
      data: { status: 'remote-newer', remote_updated_at: '2026-04-29T01:00:00Z' },
      error: null,
    }));

    const service = buildService(rpc as never);
    const result = await service.upsertTask({
      operationId: 'op-1',
      task: { id: 'task-9', projectId: 'p-1', content: 'hi' } as unknown as Task,
      baseUpdatedAt: '2026-04-28T20:00:00Z',
    });

    expect(result.status).toBe('remote-newer');
    expect(result.remoteUpdatedAt).toBe('2026-04-29T01:00:00Z');
  });

  it('upsertTask: client-version-rejected 状态解析 minProtocolVersion', async () => {
    const env = environment as unknown as MutableEnv;
    env.syncRpcEnabled = true;
    env.syncProtocolVersion = 1;

    const rpc = vi.fn(async () => ({
      data: { status: 'client-version-rejected', minProtocolVersion: 3 },
      error: null,
    }));

    const service = buildService(rpc as never);
    const result = await service.upsertTask({
      operationId: 'op-1',
      task: { id: 'task-9', projectId: 'p-1', content: 'hi' } as unknown as Task,
      baseUpdatedAt: null,
    });

    expect(result.status).toBe('client-version-rejected');
    expect(result.minProtocolVersion).toBe(3);
  });

  it('upsertConnection: 序列化 source_id/target_id（兼容标准 source/target 与 from/to 别名）', async () => {
    const env = environment as unknown as MutableEnv;
    env.syncRpcEnabled = true;

    let captured: unknown = null;
    const rpc = vi.fn(async (_name, payload) => {
      captured = payload;
      return { data: { status: 'applied', connection_id: 'c-1' }, error: null };
    });

    const service = buildService(rpc as never);
    await service.upsertConnection({
      operationId: 'op-1',
      connection: {
        id: 'c-1',
        source: 't-1',
        target: 't-2',
        title: 'Link',
        description: 'Link detail',
        updatedAt: '2026-04-30T02:00:00.000Z',
        deletedAt: null,
        projectId: 'p-1',
      } as unknown as Connection,
      baseUpdatedAt: null,
    });

    const cap = captured as { connection: Record<string, unknown> };
    expect(cap.connection.source_id).toBe('t-1');
    expect(cap.connection.target_id).toBe('t-2');
    expect(cap.connection.title).toBe('Link');
    expect(cap.connection.description).toBe('Link detail');
    expect(cap.connection.updated_at).toBe('2026-04-30T02:00:00.000Z');
    expect(cap.connection.deleted_at).toBeNull();
  });

  it('upsertBlackboxEntry: 序列化完整黑匣子同步字段', async () => {
    const env = environment as unknown as MutableEnv;
    env.syncRpcEnabled = true;

    let captured: unknown = null;
    const rpc = vi.fn(async (_name, payload) => {
      captured = payload;
      return { data: { status: 'applied', entry_id: 'b-1' }, error: null };
    });

    const service = buildService(rpc as never);
    await service.upsertBlackboxEntry({
      operationId: 'op-1',
      entry: {
        id: 'b-1',
        projectId: 'project-1',
        userId: 'user-1',
        content: 'hello',
        date: '2026-04-29',
        createdAt: '2026-04-29T00:00:00Z',
        updatedAt: '2026-04-29T00:01:00Z',
        isRead: true,
        isCompleted: false,
        isArchived: false,
        snoozeUntil: '2026-04-30',
        snoozeCount: 1,
        deletedAt: null,
        focusMeta: { source: 'focus-console-inline' },
      } as unknown as BlackBoxEntry,
      baseUpdatedAt: null,
    });

    const cap = captured as { entry: Record<string, unknown> };
    expect(cap.entry.content).toBe('hello');
    expect(cap.entry.created_at).toBe('2026-04-29T00:00:00Z');
    expect(cap.entry.project_id).toBe('project-1');
    expect(cap.entry.user_id).toBe('user-1');
    expect(cap.entry.date).toBe('2026-04-29');
    expect(cap.entry.updated_at).toBe('2026-04-29T00:01:00Z');
    expect(cap.entry.is_read).toBe(true);
    expect(cap.entry.is_completed).toBe(false);
    expect(cap.entry.is_archived).toBe(false);
    expect(cap.entry.snooze_until).toBe('2026-04-30');
    expect(cap.entry.snooze_count).toBe(1);
    expect(cap.entry.focus_meta).toEqual({ source: 'focus-console-inline' });
  });

  it('upsertBlackboxEntry: 拒绝缺失 content 的黑匣子 payload，不能序列化为空字符串', async () => {
    const env = environment as unknown as MutableEnv;
    env.syncRpcEnabled = true;

    const rpc = vi.fn(async () => ({ data: { status: 'applied', entry_id: 'b-1' }, error: null }));
    const service = buildService(rpc as never);

    await expect(service.upsertBlackboxEntry({
      operationId: 'op-blank-content',
      entry: {
        id: 'b-1',
        projectId: null,
        userId: 'user-1',
        content: undefined,
        date: '2026-04-29',
        createdAt: '2026-04-29T00:00:00Z',
        updatedAt: '2026-04-29T00:01:00Z',
        isRead: false,
        isCompleted: false,
        isArchived: false,
        deletedAt: null,
        focusMeta: null,
      } as unknown as BlackBoxEntry,
      baseUpdatedAt: null,
    })).rejects.toThrow('BlackBox entry content is missing');

    expect(rpc).not.toHaveBeenCalled();
  });

  it('upsertProject: 序列化项目元数据和部署审计字段', async () => {
    const env = environment as unknown as MutableEnv;
    env.syncRpcEnabled = true;
    env.syncProtocolVersion = 5;
    env.deploymentEpoch = 13;
    env.deploymentTarget = 'cloudflare-pages';
    env.sentryRelease = 'sha-project';
    env.canonicalOrigin = 'https://nanoflow.pages.dev';

    let captured: unknown = null;
    const rpc = vi.fn(async (_name, payload) => {
      captured = payload;
      return { data: { status: 'applied', project_id: 'project-rpc', updated_at: '2026-04-30T02:00:00.000Z' }, error: null };
    });

    const service = buildService(rpc as never);
    const result = await service.upsertProject({
      operationId: 'op-project',
      project: {
        id: 'project-rpc',
        name: 'RPC Project',
        description: 'Project metadata',
        version: 7,
        updatedAt: '2026-04-30T01:30:00.000Z',
        deletedAt: null,
      } as unknown as Project,
      ownerId: 'user-1',
      baseUpdatedAt: '2026-04-30T01:00:00.000Z',
    });

    expect(result.status).toBe('applied');
    expect(result.entityId).toBe('project-rpc');
    const cap = captured as { project: Record<string, unknown> };
    expect(cap).toMatchObject({
      operation_id: 'op-project',
      protocol_version: 5,
      base_updated_at: '2026-04-30T01:00:00.000Z',
      client_git_sha: 'sha-project',
      client_origin: 'https://nanoflow.pages.dev',
      deployment_epoch: 13,
      deployment_target: 'cloudflare-pages',
    });
    expect(cap.project).toMatchObject({
      id: 'project-rpc',
      owner_id: 'user-1',
      title: 'RPC Project',
      description: 'Project metadata',
      version: 7,
      migrated_to_v2: true,
      updated_at: '2026-04-30T01:30:00.000Z',
      deleted_at: null,
    });
  });

  it('deleteProject: 发出受 protocol/epoch 保护的删除 RPC', async () => {
    const env = environment as unknown as MutableEnv;
    env.syncRpcEnabled = true;

    let rpcName = '';
    let captured: unknown = null;
    const rpc = vi.fn(async (name, payload) => {
      rpcName = name;
      captured = payload;
      return { data: { status: 'applied', project_id: 'project-delete', updated_at: '2026-04-30T03:00:00.000Z' }, error: null };
    });

    const service = buildService(rpc as never);
    const result = await service.deleteProject({
      operationId: 'op-delete-project',
      projectId: 'project-delete',
      baseUpdatedAt: null,
    });

    expect(rpcName).toBe('sync_delete_project');
    expect(result.entityId).toBe('project-delete');
    expect((captured as Record<string, unknown>)['project_id']).toBe('project-delete');
  });

  it('deleteTasks: 解析批量删除数量与附件路径', async () => {
    const env = environment as unknown as MutableEnv;
    env.syncRpcEnabled = true;

    let rpcName = '';
    const rpc = vi.fn(async (name) => {
      rpcName = name;
      return {
        data: {
          status: 'applied',
          project_id: 'project-1',
          deleted_count: 2,
          attachment_paths: ['u/p/t/a.png'],
          updated_at: '2026-04-30T04:00:00.000Z',
        },
        error: null,
      };
    });

    const service = buildService(rpc as never);
    const result = await service.deleteTasks({
      operationId: 'op-delete-tasks',
      projectId: 'project-1',
      taskIds: ['task-1', 'task-2'],
      baseUpdatedAt: null,
    });

    expect(rpcName).toBe('sync_delete_tasks');
    expect(result.status).toBe('applied');
    expect(result.affectedCount).toBe(2);
    expect(result.attachmentPaths).toEqual(['u/p/t/a.png']);
  });

  it('deleteTasks: 携带 baseUpdatedAtMap 时应灌入 payload 并解析 skipped_ids 供调用方重排队', async () => {
    const env = environment as unknown as MutableEnv;
    env.syncRpcEnabled = true;

    let capturedPayload: Record<string, unknown> | null = null;
    const rpc = vi.fn(async (_name, payload) => {
      capturedPayload = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : null;
      return {
        data: {
          status: 'applied',
          project_id: 'project-1',
          deleted_count: 1,
          attachment_paths: [],
          skipped_ids: ['task-2'],
          updated_at: '2026-05-15T10:00:00.000Z',
        },
        error: null,
      };
    });

    const service = buildService(rpc as never);
    const result = await service.deleteTasks({
      operationId: 'op-stale-delete',
      projectId: 'project-1',
      taskIds: ['task-1', 'task-2'],
      baseUpdatedAt: null,
      deleteMode: 'soft',
      baseUpdatedAtMap: {
        'task-1': '2026-05-15T09:00:00.000Z',
        'task-2': '2026-05-15T09:30:00.000Z',
      },
    });

    expect(capturedPayload).not.toBeNull();
    if (!capturedPayload) {
      throw new Error('Expected deleteTasks RPC payload to be captured');
    }
    expect(capturedPayload['base_updated_at_map']).toEqual({
      'task-1': '2026-05-15T09:00:00.000Z',
      'task-2': '2026-05-15T09:30:00.000Z',
    });
    expect(result.status).toBe('applied');
    expect(result.skippedIds).toEqual(['task-2']);
  });

  it('deleteTasks: 仅当 baseUpdatedAtMap 至少含一个非空值时才附带 base_updated_at_map（向后兼容）', async () => {
    const env = environment as unknown as MutableEnv;
    env.syncRpcEnabled = true;

    let capturedPayload: Record<string, unknown> | null = null;
    const rpc = vi.fn(async (_name, payload) => {
      capturedPayload = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : null;
      return {
        data: { status: 'applied', deleted_count: 0, attachment_paths: [] },
        error: null,
      };
    });

    const service = buildService(rpc as never);
    await service.deleteTasks({
      operationId: 'op-empty-map',
      projectId: 'project-1',
      taskIds: ['task-1'],
      baseUpdatedAt: null,
      baseUpdatedAtMap: { 'task-1': null, 'task-other': '2026-05-15T09:00:00.000Z' },
    });

    // task-1 在 map 中但 null；task-other 不在 task_ids 中 → filtered 为空 → 不应附带字段
    expect(capturedPayload).not.toBeNull();
    expect(Object.prototype.hasOwnProperty.call(capturedPayload!, 'base_updated_at_map')).toBe(false);
  });

  it('deleted-remote-newer 状态按服务端 tombstone 冲突解析', async () => {
    const env = environment as unknown as MutableEnv;
    env.syncRpcEnabled = true;

    const rpc = vi.fn(async () => ({
      data: {
        status: 'deleted-remote-newer',
        remote_updated_at: '2026-04-30T05:00:00.000Z',
        reason: 'remote_tombstone_newer',
      },
      error: null,
    }));

    const service = buildService(rpc as never);
    const result = await service.upsertTask({
      operationId: 'op-tombstone',
      task: { id: 'task-9', projectId: 'p-1', content: 'hi' } as unknown as Task,
      baseUpdatedAt: '2026-04-30T04:00:00.000Z',
    });

    expect(result.status).toBe('deleted-remote-newer');
    expect(result.remoteUpdatedAt).toBe('2026-04-30T05:00:00.000Z');
  });

  it('upsert RPC 网络错误时向上抛（调用方走 RetryQueue 路径）', async () => {
    const env = environment as unknown as MutableEnv;
    env.syncRpcEnabled = true;

    const rpc = vi.fn(async () => ({ data: null, error: { message: 'network down' } }));
    const service = buildService(rpc as never);

    await expect(
      service.upsertTask({
        operationId: 'op-1',
        task: { id: 't', projectId: 'p', content: 'x' } as unknown as Task,
        baseUpdatedAt: null,
      })
    ).rejects.toMatchObject({ message: 'network down' });
  });

  it('isClientRejected: 服务端 minProtocolVersion <= 客户端时 false', async () => {
    const env = environment as unknown as MutableEnv;
    env.syncRpcEnabled = true;
    env.syncProtocolVersion = 5;

    const rpc = vi.fn(async () => ({ data: { minProtocolVersion: 2, deploymentEpoch: 0 }, error: null }));
    const service = buildService(rpc as never);
    await service.checkProtocol();
    expect(service.isClientRejected()).toBe(false);
  });

  it('未知 status 默认归类为 unauthorized', async () => {
    const env = environment as unknown as MutableEnv;
    env.syncRpcEnabled = true;

    const rpc = vi.fn(async () => ({ data: { status: 'totally-bogus' }, error: null }));
    const service = buildService(rpc as never);
    const result = await service.upsertTask({
      operationId: 'op-1',
      task: { id: 't', projectId: 'p', content: 'x' } as unknown as Task,
      baseUpdatedAt: null,
    });
    expect(result.status).toBe('unauthorized');
  });
});
