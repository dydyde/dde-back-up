/**
 * SyncRpcClientService - 同步写入保护 RPC 客户端封装
 *
 * 计划 §6.4 / §16.26：服务端写入保护（CAS + idempotency + protocol fence）的客户端入口。
 *
 * 服务端契约见 supabase/migrations/20260429080000_sync_write_protection_rpcs.sql：
 * - `sync_check_protocol()` —— 启动时获取最小 protocol；
 * - `sync_upsert_task(payload)` —— task 写入；
 * - `sync_upsert_connection(payload)` —— connection 写入；
 * - `sync_upsert_blackbox_entry(payload)` —— blackbox 写入。
 * - `sync_upsert_project(payload)` / `sync_delete_project(payload)` —— project 写入/删除；
 * - `sync_delete_tasks(payload)` —— task 批量软删或 purge。
 *
 * 返回 `status`：`applied` / `idempotent-replay` / `remote-newer` /
 * `client-version-rejected` / `unauthorized`。调用方按 status 走不同重试策略：
 * - `remote-newer` —— 必须先 pull+merge 再重新发起，**不能**简单重试；
 * - `client-version-rejected` —— 旧前端必须停止 flush 并提示更新；
 * - 网络错误 —— 调用方走原有 RetryQueue + circuit breaker 路径。
 *
 * Feature flag：`NG_APP_SYNC_RPC_ENABLED` (`environment.syncRpcEnabled`)。默认 false。
 * task / connection / blackbox push 路径在 flag 开启后通过本服务写入；默认 false 保持现有 PostgREST 路径。
 * 对已迁移环境，调用方可先执行 `checkProtocol()` 做能力探测，探测成功后会自动开启 RPC 写入。
 */

import { Injectable, inject, computed, signal } from '@angular/core';
import { LoggerService } from './logger.service';
import { SupabaseClientService } from './supabase-client.service';
import { environment } from '../environments/environment';
import type { Task, Connection, BlackBoxEntry, Project } from '../models';

export type SyncRpcStatus =
  | 'applied'
  | 'idempotent-replay'
  | 'remote-newer'
  | 'deleted-remote-newer'
  | 'client-version-rejected'
  | 'unauthorized';

export interface SyncRpcResult {
  status: SyncRpcStatus;
  reason?: string;
  /** `remote-newer` 时返回服务端当前 updated_at —— 调用方据此触发 pull。 */
  remoteUpdatedAt?: string;
  /** `applied` / `idempotent-replay` 时服务端写入后的 updated_at（若 RPC 返回）。 */
  serverUpdatedAt?: string;
  /** `client-version-rejected` 时返回服务端要求的最小 protocol。 */
  minProtocolVersion?: number;
  /** `applied` / `idempotent-replay` 时返回的实体 ID。 */
  entityId?: string;
  /** delete/batch RPC 返回的影响行数。 */
  affectedCount?: number;
  /** 任务 purge 时服务端返回、客户端后续异步清理的附件路径。 */
  attachmentPaths?: string[];
  /**
   * `sync_delete_tasks` 返回：服务端发现 existing.updated_at > base + 1s 而拒绝删除的 task id 列表。
   * 调用方应把这些 id 重排入 RetryQueue（走 pull+merge 路径），避免用陈旧 delete 覆盖远端最新状态。
   */
  skippedIds?: string[];
  raw: unknown;
}

export interface SyncProtocolInfo {
  minProtocolVersion: number;
  deploymentEpoch: number;
}

interface SyncRpcEnvironmentSlice {
  syncRpcEnabled?: boolean;
  syncProtocolVersion?: number;
  deploymentEpoch?: number;
  deploymentTarget?: string;
  sentryRelease?: string;
  canonicalOrigin?: string;
}

@Injectable({ providedIn: 'root' })
export class SyncRpcClientService {
  private readonly logger = inject(LoggerService).category('SyncRpc');
  private readonly supabase = inject(SupabaseClientService);

  /** 当前客户端 protocol 版本（来自 environment，未配置时默认 1）。 */
  private readonly clientProtocolVersion = signal<number>(this.readClientProtocolVersion());

  /** 当前客户端 deployment epoch（来自 environment，未配置时默认 0）。 */
  private readonly clientDeploymentEpoch = signal<number>(this.readDeploymentEpoch());

  /** Feature flag（环境标志）。 */
  private readonly featureEnabled = signal<boolean>(this.readFeatureFlag());

  /** protocol 探测结果缓存；undefined 表示尚未探测。 */
  private protocolProbeResult: SyncProtocolInfo | null | undefined;

  /** in-flight protocol 探测去重。 */
  private protocolProbePromise: Promise<SyncProtocolInfo | null> | null = null;

  /** 上次拉到的服务端 protocol 信息（启动时探测一次）。 */
  private readonly serverProtocol = signal<SyncProtocolInfo | null>(null);

  /** 客户端是否被服务端拒绝（min_protocol_version > clientProtocolVersion）。 */
  readonly isClientRejected = computed<boolean>(() => {
    const server = this.serverProtocol();
    if (server == null) return false;
    return server.minProtocolVersion > this.clientProtocolVersion()
      || server.deploymentEpoch > this.clientDeploymentEpoch();
  });

  readonly isFeatureEnabled = computed<boolean>(() => this.featureEnabled());

  /**
   * 启动探测：拉取服务端 minProtocolVersion / deploymentEpoch。
   *
   * - 失败时不抛错（保持向后兼容），仅记录 logger.warn；
   * - 服务端拒绝时调用方应停止 cloud push 并显示更新提示。
   */
  async checkProtocol(): Promise<SyncProtocolInfo | null> {
    if (this.protocolProbeResult !== undefined) {
      return this.protocolProbeResult;
    }

    if (this.protocolProbePromise) {
      return this.protocolProbePromise;
    }

    this.protocolProbePromise = this.checkProtocolInternal();
    return this.protocolProbePromise;
  }

  private async checkProtocolInternal(): Promise<SyncProtocolInfo | null> {
    try {
      const client = await this.supabase.clientAsync();
      if (client == null) {
        this.protocolProbeResult = null;
        return null;
      }
      const { data, error } = await client.rpc('sync_check_protocol' as never);
      if (error) {
        this.logger.warn(`sync_check_protocol_failed: ${error.message}`);
        this.protocolProbeResult = null;
        return null;
      }
      const parsed = this.parseProtocolInfo(data);
      if (parsed) {
        this.serverProtocol.set(parsed);
        const accepted = parsed.minProtocolVersion <= this.clientProtocolVersion()
          && parsed.deploymentEpoch <= this.clientDeploymentEpoch();
        if (!this.featureEnabled() && accepted) {
          this.featureEnabled.set(true);
          this.logger.info(
            `sync_rpc_auto_enabled: server_min=${parsed.minProtocolVersion}, client=${this.clientProtocolVersion()}, server_epoch=${parsed.deploymentEpoch}, client_epoch=${this.clientDeploymentEpoch()}`,
          );
        }
        if (!accepted) {
          this.logger.info(
            `sync_protocol_rejected: server_min=${parsed.minProtocolVersion}, client=${this.clientProtocolVersion()}, server_epoch=${parsed.deploymentEpoch}, client_epoch=${this.clientDeploymentEpoch()}`,
          );
        }
      }
      this.protocolProbeResult = parsed;
      return parsed;
    } catch (err) {
      this.logger.warn(`sync_check_protocol_threw: ${(err as Error)?.message ?? err}`);
      this.protocolProbeResult = null;
      // 启动探测失败不应阻塞应用启动；返回 null 让调用方按未探测处理。
      // eslint-disable-next-line no-restricted-syntax
      return null;
    } finally {
      this.protocolProbePromise = null;
    }
  }

  /** 客户端 task upsert RPC 包装。 */
  async upsertTask(params: {
    operationId: string;
    task: Task;
    projectId?: string;
    baseUpdatedAt: string | null;
  }): Promise<SyncRpcResult> {
    return this.invokeRpc('sync_upsert_task', {
      operation_id: params.operationId,
      protocol_version: this.clientProtocolVersion(),
      base_updated_at: params.baseUpdatedAt,
      task: this.serializeTask(params.task, params.projectId),
      ...this.buildAuditFields(),
    });
  }

  /** 客户端 connection upsert RPC 包装。 */
  async upsertConnection(params: {
    operationId: string;
    connection: Connection;
    projectId?: string;
    baseUpdatedAt: string | null;
  }): Promise<SyncRpcResult> {
    return this.invokeRpc('sync_upsert_connection', {
      operation_id: params.operationId,
      protocol_version: this.clientProtocolVersion(),
      base_updated_at: params.baseUpdatedAt,
      connection: this.serializeConnection(params.connection, params.projectId),
      ...this.buildAuditFields(),
    });
  }

  /** 客户端 blackbox entry upsert RPC 包装。 */
  async upsertBlackboxEntry(params: {
    operationId: string;
    entry: BlackBoxEntry;
    baseUpdatedAt: string | null;
  }): Promise<SyncRpcResult> {
    return this.invokeRpc('sync_upsert_blackbox_entry', {
      operation_id: params.operationId,
      protocol_version: this.clientProtocolVersion(),
      base_updated_at: params.baseUpdatedAt,
      entry: this.serializeBlackboxEntry(params.entry),
      ...this.buildAuditFields(),
    });
  }

  /** 客户端 project upsert RPC 包装。 */
  async upsertProject(params: {
    operationId: string;
    project: Project;
    ownerId: string;
    baseUpdatedAt: string | null;
  }): Promise<SyncRpcResult> {
    return this.invokeRpc('sync_upsert_project', {
      operation_id: params.operationId,
      protocol_version: this.clientProtocolVersion(),
      base_updated_at: params.baseUpdatedAt,
      project: this.serializeProject(params.project, params.ownerId),
      ...this.buildAuditFields(),
    });
  }

  /** 客户端 project delete RPC 包装。 */
  async deleteProject(params: {
    operationId: string;
    projectId: string;
    baseUpdatedAt: string | null;
  }): Promise<SyncRpcResult> {
    return this.invokeRpc('sync_delete_project', {
      operation_id: params.operationId,
      protocol_version: this.clientProtocolVersion(),
      base_updated_at: params.baseUpdatedAt,
      project_id: params.projectId,
      ...this.buildAuditFields(),
    });
  }

  /** 客户端 task batch delete / purge RPC 包装。 */
  async deleteTasks(params: {
    operationId: string;
    projectId: string;
    taskIds: string[];
    baseUpdatedAt: string | null;
    deleteMode?: 'soft' | 'purge';
    /**
     * 可选：每个 task 在本地的 `updated_at` 快照。服务端用它做 stale-write 判定
     * （existing.updated_at > base + 1s 即跳过该 task 并写入 `skipped_ids`）。
     * 缺省时退化为现有行为（无 stale guard）。
     */
    baseUpdatedAtMap?: Record<string, string | null | undefined>;
  }): Promise<SyncRpcResult> {
    const baseMap = this.buildBaseUpdatedAtMap(params.taskIds, params.baseUpdatedAtMap);
    return this.invokeRpc('sync_delete_tasks', {
      operation_id: params.operationId,
      protocol_version: this.clientProtocolVersion(),
      base_updated_at: params.baseUpdatedAt,
      project_id: params.projectId,
      task_ids: params.taskIds,
      delete_mode: params.deleteMode ?? 'purge',
      ...(baseMap ? { base_updated_at_map: baseMap } : {}),
      ...this.buildAuditFields(),
    });
  }

  /**
   * 仅保留 `task_ids` 范围内有非空 updated_at 的条目，避免把不必要的 key 灌进 payload。
   * 全空时返回 null（不附带 base_updated_at_map，服务端走 0430 原行为）。
   */
  private buildBaseUpdatedAtMap(
    taskIds: string[],
    map: Record<string, string | null | undefined> | undefined,
  ): Record<string, string> | null {
    if (!map) return null;
    const filtered: Record<string, string> = {};
    let count = 0;
    for (const id of taskIds) {
      const value = map[id];
      if (typeof value === 'string' && value.length > 0) {
        filtered[id] = value;
        count++;
      }
    }
    return count > 0 ? filtered : null;
  }

  // ---------------- internals ----------------

  private async invokeRpc(name: string, payload: Record<string, unknown>): Promise<SyncRpcResult> {
    const client = await this.supabase.clientAsync();
    if (client == null) {
      return {
        status: 'unauthorized',
        reason: 'supabase_client_unavailable',
        raw: null,
      };
    }
    const { data, error } = await client.rpc(name as never, { payload } as never);
    if (error) {
      // 网络/服务端错误：保持原始错误向上抛，调用方走 RetryQueue 路径。
      throw error;
    }
    return this.parseRpcResult(data);
  }

  private parseRpcResult(raw: unknown): SyncRpcResult {
    const obj = (raw && typeof raw === 'object') ? (raw as Record<string, unknown>) : {};
    const status = this.parseStatus(obj['status']);
    const result: SyncRpcResult = { status, raw };
    if (typeof obj['reason'] === 'string') result.reason = obj['reason'] as string;
    if (typeof obj['remote_updated_at'] === 'string') result.remoteUpdatedAt = obj['remote_updated_at'] as string;
    if (typeof obj['updated_at'] === 'string') result.serverUpdatedAt = obj['updated_at'] as string;
    if (typeof obj['minProtocolVersion'] === 'number') result.minProtocolVersion = obj['minProtocolVersion'] as number;
    if (typeof obj['task_id'] === 'string') result.entityId = obj['task_id'] as string;
    else if (typeof obj['connection_id'] === 'string') result.entityId = obj['connection_id'] as string;
    else if (typeof obj['entry_id'] === 'string') result.entityId = obj['entry_id'] as string;
    else if (typeof obj['project_id'] === 'string') result.entityId = obj['project_id'] as string;
    if (typeof obj['deleted_count'] === 'number') result.affectedCount = obj['deleted_count'] as number;
    if (Array.isArray(obj['attachment_paths'])) {
      result.attachmentPaths = obj['attachment_paths'].filter((value): value is string => typeof value === 'string');
    }
    if (Array.isArray(obj['skipped_ids'])) {
      result.skippedIds = obj['skipped_ids'].filter((value): value is string => typeof value === 'string');
    }
    return result;
  }

  private parseStatus(raw: unknown): SyncRpcStatus {
    const known: SyncRpcStatus[] = [
      'applied',
      'idempotent-replay',
      'remote-newer',
      'deleted-remote-newer',
      'client-version-rejected',
      'unauthorized',
    ];
    if (typeof raw === 'string' && (known as string[]).includes(raw)) {
      return raw as SyncRpcStatus;
    }
    return 'unauthorized';
  }

  private parseProtocolInfo(raw: unknown): SyncProtocolInfo | null {
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;
    const min = obj['minProtocolVersion'];
    const epoch = obj['deploymentEpoch'];
    if (typeof min !== 'number') return null;
    return {
      minProtocolVersion: min,
      deploymentEpoch: typeof epoch === 'number' ? epoch : 0,
    };
  }

  private serializeTask(task: Task, projectId?: string): Record<string, unknown> {
    // 仅传递服务端关心的字段，避免泄漏额外内部状态。
    const taskWithProject = task as Task & { projectId?: string; updatedAt?: string | null };
    return {
      id: task.id,
      project_id: projectId ?? taskWithProject.projectId,
      title: task.title,
      content: task.content ?? '',
      stage: task.stage ?? null,
      parent_id: task.parentId ?? null,
      parentId: task.parentId ?? null,
      order: task.order ?? 0,
      rank: task.rank ?? 10000,
      status: task.status ?? 'active',
      x: (task as unknown as { x?: number }).x ?? null,
      y: (task as unknown as { y?: number }).y ?? null,
      short_id: task.shortId ?? null,
      shortId: task.shortId ?? null,
      priority: task.priority ?? null,
      due_date: task.dueDate ?? null,
      dueDate: task.dueDate ?? null,
      expected_minutes: task.expected_minutes ?? null,
      expectedMinutes: task.expected_minutes ?? null,
      cognitive_load: task.cognitive_load ?? null,
      cognitiveLoad: task.cognitive_load ?? null,
      wait_minutes: task.wait_minutes ?? null,
      waitMinutes: task.wait_minutes ?? null,
      tags: task.tags ?? [],
      completed_at: task.completedAt ?? null,
      completedAt: task.completedAt ?? null,
      updated_at: taskWithProject.updatedAt ?? null,
      deleted_at: task.deletedAt ?? null,
      deletedAt: task.deletedAt ?? null,
      attachments: task.attachments ?? [],
      parking_meta: task.parkingMeta ?? null,
      parkingMeta: task.parkingMeta ?? null,
    };
  }

  private serializeConnection(conn: Connection, projectId?: string): Record<string, unknown> {
    const aliased = conn as Connection & {
      projectId?: string;
      sourceId?: string;
      targetId?: string;
      from?: string;
      to?: string;
      updatedAt?: string | null;
    };
    return {
      id: conn.id,
      project_id: projectId ?? aliased.projectId,
      source_id: aliased.sourceId ?? conn.source ?? aliased.from,
      target_id: aliased.targetId ?? conn.target ?? aliased.to,
      title: conn.title ?? null,
      description: conn.description ?? null,
      updated_at: aliased.updatedAt ?? null,
      deleted_at: conn.deletedAt ?? null,
    };
  }

  private serializeBlackboxEntry(entry: BlackBoxEntry): Record<string, unknown> {
    const content = (entry as unknown as { content?: unknown }).content;
    if (typeof content !== 'string') {
      throw new Error('BlackBox entry content is missing');
    }

    return {
      id: entry.id,
      project_id: entry.projectId,
      user_id: entry.userId,
      content,
      date: entry.date,
      created_at: (entry as unknown as { createdAt?: string }).createdAt ?? null,
      updated_at: entry.updatedAt,
      is_read: entry.isRead,
      is_completed: entry.isCompleted,
      is_archived: entry.isArchived,
      snooze_until: entry.snoozeUntil ?? null,
      snooze_count: entry.snoozeCount ?? 0,
      deleted_at: (entry as unknown as { deletedAt?: string }).deletedAt ?? null,
      focus_meta: entry.focusMeta ?? null,
    };
  }

  private serializeProject(project: Project, ownerId: string): Record<string, unknown> {
    const projectWithTimestamp = project as Project & { updatedAt?: string | null };
    return {
      id: project.id,
      owner_id: ownerId,
      title: project.name,
      description: project.description ?? null,
      version: project.version ?? 1,
      migrated_to_v2: true,
      updated_at: projectWithTimestamp.updatedAt ?? null,
      deleted_at: project.deletedAt ?? null,
    };
  }

  private buildAuditFields(): Record<string, unknown> {
    const env = environment as unknown as SyncRpcEnvironmentSlice;
    return {
      client_git_sha: env.sentryRelease ?? null,
      client_origin: env.canonicalOrigin ?? (typeof location !== 'undefined' ? location.origin : null),
      deployment_epoch: typeof env.deploymentEpoch === 'number' ? env.deploymentEpoch : 0,
      deployment_target: env.deploymentTarget ?? null,
    };
  }

  private readFeatureFlag(): boolean {
    const env = environment as unknown as SyncRpcEnvironmentSlice;
    return env.syncRpcEnabled === true;
  }

  private readClientProtocolVersion(): number {
    const env = environment as unknown as SyncRpcEnvironmentSlice;
    const v = env.syncProtocolVersion;
    if (typeof v === 'number' && v > 0) return v;
    return 1;
  }

  private readDeploymentEpoch(): number {
    const env = environment as unknown as SyncRpcEnvironmentSlice;
    const value = env.deploymentEpoch;
    if (typeof value === 'number' && value >= 0) return value;
    return 0;
  }
}
