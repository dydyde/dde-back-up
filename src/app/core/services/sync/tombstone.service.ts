/**
 * TombstoneService - 墓碑（软删除标记）管理
 * 
 * 职责：
 * - 管理本地 tombstone 缓存（用于防止已删除任务复活）
 * - 云端 tombstone 缓存管理（流量优化）
 * - 附件删除时的存储清理
 * 
 * 从 SimpleSyncService 提取，作为 Sprint 3 技术债务修复的一部分
 */

import { Injectable, inject } from '@angular/core';
import { LoggerService } from '../../../../services/logger.service';
import { RequestThrottleService } from '../../../../services/request-throttle.service';
import { REQUEST_THROTTLE_CONFIG, SYNC_CONFIG, FIELD_SELECT_CONFIG } from '../../../../config';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  createBrowserNetworkSuspendedError,
  isBrowserNetworkSuspendedError,
  isBrowserNetworkSuspendedWindow,
} from '../../../../utils/browser-network-suspension';

/**
 * Tombstone 缓存项
 */
interface TombstoneCache {
  /** 已删除的任务 ID 集合 */
  ids: Set<string>;
  /** 缓存时间戳 */
  timestamp: number;
  /** 任务 tombstone 的真实删除时间水位 */
  taskDeletedAt?: Map<string, number>;
}

/** batch_get_tombstones RPC 返回结构 */
interface BatchTombstoneResult {
  task_tombstones: { project_id: string; task_id: string; deleted_at?: string | null }[];
  connection_tombstones: { project_id: string; connection_id: string }[];
}

/**
 * 墓碑管理服务
 * 
 * 用于追踪已删除的任务，防止同步时复活
 */
@Injectable({
  providedIn: 'root'
})
export class TombstoneService {
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('Tombstone');
  private readonly throttle = inject(RequestThrottleService);
  
  /** 
   * 本地 tombstone 缓存 
   * 用于在云端 RPC 不可用时防止已删除任务复活
   * 格式：Map<projectId, Map<taskId, timestamp>>
   */
  private localTombstones: Map<string, Map<string, number>> = new Map();
  
  /** 本地 tombstone 持久化 key */
  private readonly LOCAL_TOMBSTONES_KEY = 'nanoflow.local-tombstones';
  
  /** 云端 Tombstone 缓存（用于流量优化） */
  private tombstoneCache = new Map<string, TombstoneCache>();
  
  /** 连接 Tombstone 缓存 */
  private connectionTombstoneCache = new Map<string, TombstoneCache>();
  
  constructor() {
    this.loadLocalTombstones();
    // 【P1-19 修复】启动时加载连接 tombstone
    this.loadConnectionTombstones();
  }

  private parseTombstoneTimestamp(value?: string | null): number | undefined {
    if (!value) {
      return undefined;
    }

    const parsed = new Date(value).getTime();
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  
  // ==================== 本地 Tombstone 管理 ====================
  
  /**
   * 从 localStorage 加载本地 tombstone 缓存
   */
  private loadLocalTombstones(): void {
    if (typeof localStorage === 'undefined') return;
    
    try {
      const data = localStorage.getItem(this.LOCAL_TOMBSTONES_KEY);
      if (data) {
        const parsed = JSON.parse(data) as Record<string, unknown>;
        this.localTombstones = new Map();

        for (const [projectId, value] of Object.entries(parsed)) {
          const map = new Map<string, number>();
          if (Array.isArray(value)) {
            // 向后兼容旧格式：string[]
            for (const taskId of value) {
              if (typeof taskId === 'string') {
                map.set(taskId, Date.now());
              }
            }
          } else if (value && typeof value === 'object') {
            // 新格式：Record<taskId, timestamp>
            for (const [taskId, timestamp] of Object.entries(value as Record<string, unknown>)) {
              const ts = typeof timestamp === 'number' ? timestamp : Date.now();
              map.set(taskId, ts);
            }
          }
          if (map.size > 0) {
            this.localTombstones.set(projectId, map);
          }
        }

        // 启动时清理过期 tombstone，避免长期膨胀
        this.cleanupExpiredLocalTombstones();
        this.logger.debug('已恢复本地 tombstone 缓存', { 
          projectCount: this.localTombstones.size 
        });
      }
    } catch (e) {
      this.logger.warn('加载本地 tombstone 缓存失败', e);
      this.localTombstones = new Map();
    }
  }
  
  /**
   * 保存本地 tombstone 缓存到 localStorage
   */
  private saveLocalTombstones(): void {
    if (typeof localStorage === 'undefined') return;
    
    try {
      const data: Record<string, Record<string, number>> = {};
      this.localTombstones.forEach((taskIds, projectId) => {
        const serializedTaskIds: Record<string, number> = {};
        taskIds.forEach((timestamp, taskId) => {
          serializedTaskIds[taskId] = timestamp;
        });
        data[projectId] = serializedTaskIds;
      });
      localStorage.setItem(this.LOCAL_TOMBSTONES_KEY, JSON.stringify(data));
    } catch (e) {
      this.logger.warn('保存本地 tombstone 缓存失败', e);
    }
  }
  
  /**
   * 添加本地 tombstone
   * 
   * 用于在 RPC 不可用时防止任务复活
   * 
   * @param projectId 项目 ID
   * @param taskIds 任务 ID 列表
   */
  addLocalTombstones(
    projectId: string,
    taskIds: string[],
    timestampsByTaskId?: Record<string, string | number | null | undefined>,
  ): void {
    if (!this.localTombstones.has(projectId)) {
      this.localTombstones.set(projectId, new Map());
    }
    const set = this.localTombstones.get(projectId)!;
    const now = Date.now();
    for (const id of taskIds) {
      const rawTimestamp = timestampsByTaskId?.[id];
      const parsedTimestamp = typeof rawTimestamp === 'number'
        ? rawTimestamp
        : typeof rawTimestamp === 'string'
          ? new Date(rawTimestamp).getTime()
          : Number.NaN;
      set.set(id, Number.isNaN(parsedTimestamp) ? now : parsedTimestamp);
    }
    this.saveLocalTombstones();
    // 【P2-20 修复】新增 tombstone 后使缓存失效，确保下次查询拿到最新集合
    this.invalidateTombstoneCache(projectId);
    this.logger.debug('添加本地 tombstone', { projectId, count: taskIds.length });
  }
  
  /**
   * 获取本地 tombstone（合并云端 tombstone）
   */
  getLocalTombstones(projectId: string): Set<string> {
    this.cleanupExpiredLocalTombstones(projectId);
    const records = this.localTombstones.get(projectId);
    return records ? new Set(records.keys()) : new Set();
  }
  
  /**
   * 清除本地 tombstone（当云端 tombstone 同步成功后）
   */

  getLocalTombstoneTimestamp(projectId: string, taskId: string): number | undefined {
    this.cleanupExpiredLocalTombstones(projectId);
    return this.localTombstones.get(projectId)?.get(taskId);
  }

  shouldMaterializeTaskDeletion(taskUpdatedAt: string | undefined | null, tombstoneTimestamp?: number): boolean {
    if (tombstoneTimestamp === undefined) {
      return false;
    }

    if (!taskUpdatedAt) {
      return true;
    }

    const taskUpdatedTime = new Date(taskUpdatedAt).getTime();
    if (Number.isNaN(taskUpdatedTime)) {
      return true;
    }

    return taskUpdatedTime <= tombstoneTimestamp;
  }

  clearLocalTombstones(projectId: string, taskIds: string[]): void {
    const set = this.localTombstones.get(projectId);
    if (set) {
      for (const id of taskIds) {
        set.delete(id);
      }
      if (set.size === 0) {
        this.localTombstones.delete(projectId);
      }
      this.saveLocalTombstones();
    }
  }
  
  /**
   * 清除项目的所有本地 tombstone
   */
  clearAllLocalTombstones(projectId: string): void {
    this.localTombstones.delete(projectId);
    this.saveLocalTombstones();
  }

  private rowsFromTaskTombstoneCache(cached: TombstoneCache): { task_id: string; deleted_at?: string | null }[] {
    return Array.from(cached.ids).map(id => ({
      task_id: id,
      deleted_at: cached.taskDeletedAt?.has(id)
        ? new Date(cached.taskDeletedAt.get(id)!).toISOString()
        : undefined,
    }));
  }

  private updateTaskTombstoneCache(
    projectId: string,
    rows: { task_id: string; deleted_at?: string | null }[],
    timestamp: number,
  ): void {
    const ids = new Set<string>();
    const taskDeletedAt = new Map<string, number>();
    for (const row of rows) {
      ids.add(row.task_id);
      const deletedAt = this.parseTombstoneTimestamp(row.deleted_at);
      if (deletedAt !== undefined) {
        taskDeletedAt.set(row.task_id, deletedAt);
      }
    }
    this.tombstoneCache.set(projectId, { ids, timestamp, taskDeletedAt });
    this.logger.debug('更新 Tombstone 缓存', { projectId, count: ids.size });
  }
  
  // ==================== 云端 Tombstone 缓存（流量优化）====================
  
  /**
   * 获取 Tombstones（带缓存）
   * 
   * 【流量优化】缓存 tombstone 结果，避免每次同步都查询
   * 缓存有效期：5 分钟（SYNC_CONFIG.TOMBSTONE_CACHE_TTL）
   */
  async getTombstonesWithCache(
    projectId: string, 
    client: SupabaseClient
  ): Promise<{ data: { task_id: string; deleted_at?: string | null }[] | null; error: Error | null }> {
    const now = Date.now();
    const cached = this.tombstoneCache.get(projectId);
    
    // 检查缓存是否有效
    if (cached && (now - cached.timestamp) < SYNC_CONFIG.TOMBSTONE_CACHE_TTL) {
      this.logger.debug('使用 Tombstone 缓存', { 
        projectId, 
        count: cached.ids.size,
        age: Math.round((now - cached.timestamp) / 1000) + 's'
      });
      return { data: this.rowsFromTaskTombstoneCache(cached), error: null };
    }

    if (isBrowserNetworkSuspendedWindow()) {
      return { data: null, error: createBrowserNetworkSuspendedError() };
    }
    
    // 缓存过期或不存在，查询云端
    try {
      const result = await this.throttle.execute(
        `task-tombstones:${projectId}`,
        async () => {
          return await client
            .from('task_tombstones')
            .select(FIELD_SELECT_CONFIG.TOMBSTONE_FIELDS)
            .eq('project_id', projectId);
        },
        { 
          deduplicate: true,
          timeout: REQUEST_THROTTLE_CONFIG.BATCH_SYNC_TIMEOUT 
        }
      );
      
      // 更新缓存
      if (!result.error && result.data) {
        this.updateTaskTombstoneCache(projectId, result.data, now);
      }
      
      return result;
    } catch (e) {
      if (isBrowserNetworkSuspendedError(e) || isBrowserNetworkSuspendedWindow()) {
        return { data: null, error: createBrowserNetworkSuspendedError() };
      }

      return { data: null, error: e as Error };
    }
  }
  
  /**
   * 清除 Tombstone 缓存（当有新的删除操作时）
   */
  invalidateTombstoneCache(projectId: string): void {
    this.tombstoneCache.delete(projectId);
    this.connectionTombstoneCache.delete(projectId);
  }
  
  /**
   * 获取缓存的 tombstone ID 集合
   * 返回防御性副本，避免外部修改污染缓存
   */
  getCachedTombstoneIds(projectId: string): Set<string> | null {
    const cached = this.tombstoneCache.get(projectId);
    if (cached && (Date.now() - cached.timestamp) < SYNC_CONFIG.TOMBSTONE_CACHE_TTL) {
      return new Set(cached.ids);
    }
    return null;
  }
  
  /**
   * 更新 tombstone 缓存
   */
  updateTombstoneCache(projectId: string, ids: Set<string>, taskDeletedAt?: Map<string, number>): void {
    this.tombstoneCache.set(projectId, { ids, timestamp: Date.now(), taskDeletedAt });
  }
  
  /**
   * 获取连接 tombstone 缓存
   * 返回防御性副本，避免外部修改污染缓存
   */
  getConnectionTombstoneCache(projectId: string): Set<string> | null {
    const cached = this.connectionTombstoneCache.get(projectId);
    if (cached && (Date.now() - cached.timestamp) < SYNC_CONFIG.TOMBSTONE_CACHE_TTL) {
      return new Set(cached.ids);
    }
    return null;
  }
  
  /**
   * 更新连接 tombstone 缓存
   */
  updateConnectionTombstoneCache(projectId: string, ids: Set<string>): void {
    this.connectionTombstoneCache.set(projectId, { ids, timestamp: Date.now() });
  }

  // ==================== 批量 Tombstone 预热（免费层优化）====================

  /**
   * 批量预热所有项目的 task + connection tombstone 缓存
   *
   * 通过 RPC `batch_get_tombstones` 一次查询替代 N×2 次独立查询。
   * 成功后将结果写入 tombstoneCache / connectionTombstoneCache，
   * 后续 getTombstonesWithCache / getConnectionTombstoneCache 在 TTL 内直接命中。
   *
   * @returns true 表示预热成功，false 表示 RPC 不可用或出错
   */
  async batchPreloadTombstones(
    projectIds: string[],
    client: SupabaseClient
  ): Promise<boolean> {
    if (projectIds.length === 0) return true;

    // 过滤掉缓存仍有效的项目，只加载需要刷新的
    const now = Date.now();
    const staleIds = projectIds.filter(pid => {
      const tc = this.tombstoneCache.get(pid);
      const cc = this.connectionTombstoneCache.get(pid);
      const tcFresh = tc && (now - tc.timestamp) < SYNC_CONFIG.TOMBSTONE_CACHE_TTL;
      const ccFresh = cc && (now - cc.timestamp) < SYNC_CONFIG.TOMBSTONE_CACHE_TTL;
      return !tcFresh || !ccFresh;
    });

    if (staleIds.length === 0) {
      this.logger.debug('批量 tombstone 预热：全部缓存有效，跳过', { count: projectIds.length });
      return true;
    }

    if (isBrowserNetworkSuspendedWindow()) {
      this.logger.debug('浏览器网络挂起，跳过批量 tombstone 预热', { projectCount: staleIds.length });
      return false;
    }

    try {
      const { data, error } = await this.throttle.execute(
        'batch-tombstones',
        async () => client.rpc('batch_get_tombstones', { p_project_ids: staleIds }),
        { deduplicate: true, timeout: REQUEST_THROTTLE_CONFIG.BATCH_SYNC_TIMEOUT }
      );

      if (error) {
        if (isBrowserNetworkSuspendedError(error) || isBrowserNetworkSuspendedWindow()) {
          this.logger.debug('浏览器网络挂起，跳过批量 tombstone 预热', { projectCount: staleIds.length });
          return false;
        }

        this.logger.warn('批量 tombstone RPC 失败', { error: (error as Error).message ?? error });
        return false;
      }

      if (!data) {
        this.logger.debug('批量 tombstone RPC 返回空');
        return false;
      }

      // 解析结果并填充缓存
      const taskRows = (data as BatchTombstoneResult).task_tombstones ?? [];
      const connRows = (data as BatchTombstoneResult).connection_tombstones ?? [];

      // 按 project_id 分组
      const taskMap = new Map<string, Set<string>>();
      const taskDeletedAtMap = new Map<string, Map<string, number>>();
      const taskProjectsMissingDeletedAt = new Set<string>();
      const connMap = new Map<string, Set<string>>();

      for (const row of taskRows) {
        if (!taskMap.has(row.project_id)) taskMap.set(row.project_id, new Set());
        taskMap.get(row.project_id)!.add(row.task_id);
        const deletedAt = this.parseTombstoneTimestamp(row.deleted_at);
        if (deletedAt !== undefined) {
          if (!taskDeletedAtMap.has(row.project_id)) {
            taskDeletedAtMap.set(row.project_id, new Map());
          }
          taskDeletedAtMap.get(row.project_id)!.set(row.task_id, deletedAt);
        } else {
          taskProjectsMissingDeletedAt.add(row.project_id);
        }
      }
      for (const row of connRows) {
        if (!connMap.has(row.project_id)) connMap.set(row.project_id, new Set());
        connMap.get(row.project_id)!.add(row.connection_id);
      }

      // 写入缓存（包括查询结果为空的项目，避免后续重复查询）
      const ts = Date.now();
      for (const pid of staleIds) {
        this.tombstoneCache.set(pid, {
          ids: taskMap.get(pid) ?? new Set(),
          timestamp: ts,
          taskDeletedAt: taskDeletedAtMap.get(pid) ?? new Map(),
        });
        this.connectionTombstoneCache.set(pid, { ids: connMap.get(pid) ?? new Set(), timestamp: ts });
      }

      if (taskProjectsMissingDeletedAt.size > 0) {
        this.logger.warn('批量 tombstone 预热结果缺少 deleted_at，恢复判定将回退到兼容模式', {
          projectCount: taskProjectsMissingDeletedAt.size,
        });
      }

      this.logger.info('批量 tombstone 预热完成', {
        projectCount: staleIds.length,
        taskTombstones: taskRows.length,
        connectionTombstones: connRows.length,
      });
      return true;
    } catch (e) {
      if (isBrowserNetworkSuspendedError(e) || isBrowserNetworkSuspendedWindow()) {
        this.logger.debug('浏览器网络挂起，跳过批量 tombstone 预热', { projectCount: staleIds.length });
        return false;
      }

      this.logger.warn('批量 tombstone 预热异常', e);
      return false;
    }
  }

  /**
   * 判断任务 upsert 是否应被 tombstone 拦截（防复活）
   *
   * 设计决策（LWW 兼容）：
   * - 本地 tombstone：始终拒绝（用户主动删除，尚未同步云端）
   * - 云端 tombstone 缓存：拒绝，除非候选 updatedAt 明显晚于 tombstone 记录时间
   *
   * 注意：tombstoneCache.timestamp 是"缓存填充时刻"，不等于"删除时刻"。
   * 若要精确 LWW，需在 task_tombstones 表存储 deleted_at 字段。
   * 当前实现为保守策略：缓存存在即拒绝，减少误复活风险。
   */
  shouldRejectTaskUpsert(projectId: string, taskId: string, candidateUpdatedAt?: string | null): boolean {
    this.cleanupExpiredLocalTombstones(projectId);

    const localTimestamp = this.localTombstones.get(projectId)?.get(taskId);
    if (localTimestamp !== undefined) {
      if (!candidateUpdatedAt) {
        return true;
      }

      const candidateTime = new Date(candidateUpdatedAt).getTime();
      if (!Number.isNaN(candidateTime) && candidateTime > localTimestamp) {
        this.clearLocalTombstones(projectId, [taskId]);
        this.logger.info('任务 upsert 的 updatedAt 晚于本地 tombstone，允许恢复', {
          projectId,
          taskId,
          candidateUpdatedAt,
          localTombstoneTimestamp: localTimestamp,
        });
        return false;
      }

      return true;
    }

    const cachedIds = this.getCachedTombstoneIds(projectId);
    if (!cachedIds) {
      return false;
    }

    if (!cachedIds.has(taskId)) {
      return false;
    }

    // 候选更新时间未知时，默认拒绝（删除优先）
    if (!candidateUpdatedAt) {
      return true;
    }

    // 云端 tombstone 存在，但候选更新时间已知：
    // 如果候选的 updatedAt 比 tombstone 缓存时间更新，说明可能是合法恢复
    const cacheEntry = this.tombstoneCache.get(projectId);
    const candidateTime = new Date(candidateUpdatedAt).getTime();
    const remoteDeletedAt = cacheEntry?.taskDeletedAt?.get(taskId);
    if (remoteDeletedAt === undefined) {
      this.logger.info('远端 tombstone 缓存缺少 deleted_at，放行恢复候选以兼容旧 RPC 结构', {
        projectId,
        taskId,
        candidateUpdatedAt,
      });
      return false;
    }

    if (!Number.isNaN(candidateTime) && remoteDeletedAt !== undefined && candidateTime > remoteDeletedAt) {
      this.logger.info('任务 upsert 的 updatedAt 晚于 tombstone 缓存，允许恢复', {
        projectId,
        taskId,
        candidateUpdatedAt,
        remoteDeletedAt,
      });
      return false;
    }

    return true;
  }

  private cleanupExpiredLocalTombstones(projectId?: string): void {
    const cutoff = Date.now() - SYNC_CONFIG.TOMBSTONE_RETENTION_MS;
    const targetProjects = projectId ? [projectId] : Array.from(this.localTombstones.keys());
    let cleaned = 0;

    for (const pid of targetProjects) {
      const records = this.localTombstones.get(pid);
      if (!records) {
        continue;
      }
      const expiredTaskIds: string[] = [];
      records.forEach((timestamp, taskId) => {
        if (timestamp < cutoff) {
          expiredTaskIds.push(taskId);
        }
      });
      expiredTaskIds.forEach(taskId => {
        records.delete(taskId);
        cleaned++;
      });
      if (records.size === 0) {
        this.localTombstones.delete(pid);
      }
    }

    if (cleaned > 0) {
      this.logger.info('已清理过期本地 tombstone', {
        projectId: projectId ?? 'all',
        cleaned,
        retentionMs: SYNC_CONFIG.TOMBSTONE_RETENTION_MS
      });
      this.saveLocalTombstones();
    }
  }
  
  // ==================== 附件存储清理 ====================
  
  /**
   * 删除 Storage 中的附件文件
   * 
   * 【v5.7 附件-任务删除联动】
   * 在任务永久删除时，清理关联的附件文件
   * 异步执行，不阻塞任务删除操作
   * 
   * @param client Supabase 客户端
   * @param paths 附件存储路径列表
   */
  async deleteAttachmentFilesFromStorage(
    client: SupabaseClient | null,
    paths: string[]
  ): Promise<void> {
    if (!client || paths.length === 0) return;
    
    try {
      // 批量删除，每次最多 100 个
      const batchSize = 100;
      for (let i = 0; i < paths.length; i += batchSize) {
        const batch = paths.slice(i, i + batchSize);
        const { error } = await client.storage
          .from('attachments')
          .remove(batch);
        
        if (error) {
          this.logger.warn('deleteAttachmentFilesFromStorage: 批量删除失败', {
            batch: batch.slice(0, 5),
            batchSize: batch.length,
            error: error.message
          });
          // 继续删除下一批，不抛出异常
        } else {
          this.logger.debug('deleteAttachmentFilesFromStorage: 批量删除成功', {
            batchIndex: i / batchSize,
            batchSize: batch.length
          });
        }
      }
      
      this.logger.info('deleteAttachmentFilesFromStorage: 完成', {
        totalPaths: paths.length
      });
    } catch (e) {
      this.logger.error('deleteAttachmentFilesFromStorage: 异常', e);
      // 不抛出，因为任务已经删除，附件清理失败只是资源浪费，不影响功能
    }
  }
  
  // ==================== 便捷 API ====================
  
  /**
   * 获取任务 tombstone ID 列表
   * 返回本地缓存的所有 tombstone IDs（不查询云端）
   */
  getTaskTombstones(projectId: string): string[] {
    return Array.from(this.getLocalTombstones(projectId));
  }

  /**
   * 导出本地 tombstones（兼容历史 API）
   */
  exportLocalTombstones(): Record<string, string[]> {
    const data: Record<string, string[]> = {};
    this.localTombstones.forEach((ids, projectId) => {
      const taskIds: string[] = [];
      ids.forEach((_timestamp, taskId) => {
        taskIds.push(taskId);
      });
      data[projectId] = taskIds;
    });
    return data;
  }
  
  /**
   * 失效缓存
   * @deprecated 请使用 invalidateTombstoneCache(projectId)
   */
  invalidateCache(projectId: string): void {
    this.invalidateTombstoneCache(projectId);
  }
  
  // ==================== 连接 Tombstone 管理 ====================
  
  /** 本地连接 tombstone */
  private localConnectionTombstones = new Map<string, { id: string; timestamp: number }[]>();
  
  /** 【P1-19 修复】连接 tombstone 持久化 key */
  private readonly LOCAL_CONNECTION_TOMBSTONES_KEY = 'nanoflow.local-connection-tombstones';
  
  /**
   * 记录连接删除
   */
  recordConnectionDeletion(connectionId: string, timestamp: number): void {
    const key = 'global'; // 连接 tombstone 不按项目分组
    if (!this.localConnectionTombstones.has(key)) {
      this.localConnectionTombstones.set(key, []);
    }
    this.localConnectionTombstones.get(key)!.push({ id: connectionId, timestamp });
    
    // 清理过期的 tombstone
    const cutoff = Date.now() - SYNC_CONFIG.TOMBSTONE_RETENTION_MS;
    const filtered = this.localConnectionTombstones.get(key)!.filter(
      t => t.timestamp > cutoff
    );
    this.localConnectionTombstones.set(key, filtered);
    
    // 【P1-19 修复】持久化到 localStorage
    this.saveConnectionTombstones();
  }
  
  /**
   * 获取连接 tombstone 列表
   */
  getConnectionTombstones(): { id: string; timestamp: number }[] {
    return this.localConnectionTombstones.get('global') || [];
  }
  
  /** 【P1-19 修复】从 localStorage 加载连接 tombstone（仅在构造时调用）*/
  private loadConnectionTombstones(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      const raw = localStorage.getItem(this.LOCAL_CONNECTION_TOMBSTONES_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { id: string; timestamp: number }[];
      if (!Array.isArray(parsed)) return;
      const cutoff = Date.now() - SYNC_CONFIG.TOMBSTONE_RETENTION_MS;
      const valid = parsed.filter(t => t.id && t.timestamp > cutoff);
      if (valid.length > 0) {
        this.localConnectionTombstones.set('global', valid);
      }
    } catch {
      // localStorage 损坏，忽略
    }
  }
  
  /** 【P1-19 修复】持久化连接 tombstone 到 localStorage */
  private saveConnectionTombstones(): void {
    try {
      const entries = this.localConnectionTombstones.get('global') || [];
      localStorage.setItem(this.LOCAL_CONNECTION_TOMBSTONES_KEY, JSON.stringify(entries));
    } catch {
      // localStorage 已满或不可用，忽略
    }
  }
}
