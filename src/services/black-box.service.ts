/**
 * 黑匣子服务
 * 
 * 负责黑匣子条目的 CRUD 操作
 * 遵循 Offline-first：本地写入 → UI 更新 → 后台推送
 */

import { Injectable, inject, computed } from '@angular/core';
import { BlackBoxEntry } from '../models/focus';
import { Result, success, failure, ErrorCodes, OperationError } from '../utils/result';
import {
  blackBoxEntriesMap,
  blackBoxEntriesGroupedByDate,
  pendingBlackBoxEntries,
  updateBlackBoxEntry,
  getTodayDate
} from '../state/focus-stores';
import {
  BlackBoxSyncService,
  type PullChangesOptions,
  type ScheduleBlackBoxSyncOptions,
} from './black-box-sync.service';
import { AuthService } from './auth.service';
import { LoggerService } from './logger.service';
import { AUTH_CONFIG } from '../config/auth.config';

@Injectable({
  providedIn: 'root'
})
export class BlackBoxService {
  private syncService = inject(BlackBoxSyncService);
  private auth = inject(AuthService);
  private readonly logger = inject(LoggerService).category('BlackBox');
  private localHydrationPromise: Promise<void> | null = null;
  private localHydratedUserKey: string | null = null;
  
  /**
   * 按日期分组的条目（暴露给组件）
   */
  readonly entriesByDate = blackBoxEntriesGroupedByDate;
  
  /**
   * 未读条目数量（暴露给组件）
   */
  readonly pendingCount = computed(() => pendingBlackBoxEntries().length);
  
  /**
   * 获取所有条目 Map
   */
  readonly entriesMap = blackBoxEntriesMap;
  
  /**
   * 创建黑匣子条目
   * 遵循 Offline-first：本地写入 → UI 更新 → 后台推送
   */
  create(data: Partial<BlackBoxEntry>): Result<BlackBoxEntry, OperationError> {
    const userId = this.resolveEffectiveUserId();
    
    if (!userId) {
      return failure(ErrorCodes.PERMISSION_DENIED, '请先登录');
    }
    
    const now = new Date().toISOString();
    // 解构 data，排除 id 字段，防止外部传入覆盖 crypto.randomUUID()
    const { id: _ignoreId, ...safeData } = data;
    const entry: BlackBoxEntry = {
      id: crypto.randomUUID(),
      // 黑匣子条目仓为跨项目共享容器，projectId 固定为 null。
      projectId: null,
      userId,
      content: safeData.content ?? '',
      date: getTodayDate(),
      createdAt: now,
      updatedAt: now,
      isRead: false,
      isCompleted: false,
      isArchived: false,
      deletedAt: null,
      localCreatedAt: now,
      snoozeCount: 0,
      ...safeData,
      // 【2026-05-18 根因修复·阶段 1】focusMeta 在本地与远端必须有同一种"空"形态（null），
      // 否则 hasEquivalentEntryState 在后续 push/pull 等价判定时会把"业务字段相同、仅
      // 同步元数据不同"误判为不等价，触发 upgrade-non-equivalent 分支保留 pending，
      // 表现为黑匣子条目永远显示 "⏳ 待同步"。
      focusMeta: safeData.focusMeta ?? null,
      syncStatus: this.resolveSyncStatusForMode(userId),
    };
    
    // 1. 更新状态（立即 UI 响应）
    updateBlackBoxEntry(entry);
    
    // 2. 后台同步（防抖 3s）或本地模式持久化
    this.persistAfterLocalChange(entry);
    
    return success(entry);
  }

  /**
   * 解析当前有效用户 ID
   * 优先登录用户；本地模式下回退到 LOCAL_MODE_USER_ID
   *
   * 【2026-04-23 根因修复】与 BlackBoxSyncService.resolveVisibleUserId 保持一致的优先级：
   * Supabase 已配置时，auth settling 窗口内优先使用 persistedSession / ownerHint 这些
   * 权威的远端身份线索；只有在完全没有云端身份痕迹时才认可 LOCAL_MODE_CACHE_KEY。
   * 否则云端用户重启 app 时，残留的 LOCAL_MODE_CACHE_KEY='true' 会在 currentUserId
   * 就绪前把新建条目打成 'local-user'，之后永远无法 upsert 到云端对应账号。
   */
  private resolveEffectiveUserId(): string | null {
    const currentUserId = this.auth.currentUserId();
    if (currentUserId) {
      return currentUserId;
    }

    if (!this.auth.isConfigured) {
      return AUTH_CONFIG.LOCAL_MODE_USER_ID;
    }

    // Supabase 已配置：先看认证恢复窗口内的远端身份线索，避免 LOCAL_MODE_CACHE_KEY
    // 残留把新建条目误标为 local-user。
    if (this.isAuthSettling()) {
      const persistedSessionUserId = this.auth.peekPersistedSessionIdentity()?.userId ?? null;
      if (persistedSessionUserId) {
        return persistedSessionUserId;
      }

      const ownerHint = this.auth.peekPersistedOwnerHint();
      if (ownerHint) {
        return ownerHint;
      }
    }

    // 没有任何远端身份线索时，才认可 LOCAL_MODE_CACHE_KEY 作为真正的本地模式标记。
    if (this.isLocalModeEnabled()) {
      return AUTH_CONFIG.LOCAL_MODE_USER_ID;
    }

    return null;
  }

  /**
   * 判断是否启用本地模式
   */
  private isLocalModeEnabled(): boolean {
    if (typeof window === 'undefined') {
      return false;
    }

    try {
      return localStorage.getItem(AUTH_CONFIG.LOCAL_MODE_CACHE_KEY) === 'true';
    } catch {
      return false;
    }
  }

  private isAuthSettling(): boolean {
    return !this.auth.sessionInitialized()
      || this.auth.authState().isCheckingSession
      || this.auth.runtimeState() === 'pending';
  }
  
  /**
   * 更新条目
   */
  update(
    id: string,
    updates: Partial<BlackBoxEntry>,
    syncOptions?: ScheduleBlackBoxSyncOptions,
  ): Result<BlackBoxEntry, OperationError> {
    const entry = blackBoxEntriesMap().get(id);
    if (!entry) {
      return failure(ErrorCodes.FOCUS_ENTRY_NOT_FOUND, '条目不存在');
    }

    const safeUpdates = this.preserveContentWhenBlankUpdate(entry, updates);
    
    const updated: BlackBoxEntry = {
      ...entry,
      ...safeUpdates,
      // 【2026-05-18 根因修复·阶段 1】update 同样归一化 focusMeta（即便基线 entry
      // 是补丁前持久化的旧数据，也确保后续等价判定不会因 undefined vs null 漂移）。
      focusMeta: (safeUpdates.focusMeta !== undefined ? safeUpdates.focusMeta : entry.focusMeta) ?? null,
      updatedAt: new Date().toISOString(),
      syncStatus: this.resolveSyncStatusForMode(entry.userId),
    };
    
    // 本地优先更新
    updateBlackBoxEntry(updated);
    
    // 后台同步或本地模式持久化
    this.persistAfterLocalChange(updated, syncOptions);
    
    return success(updated);
  }

  private preserveContentWhenBlankUpdate(
    entry: BlackBoxEntry,
    updates: Partial<BlackBoxEntry>,
  ): Partial<BlackBoxEntry> {
    if (
      Object.prototype.hasOwnProperty.call(updates, 'content') &&
      typeof updates.content === 'string' &&
      updates.content.trim().length === 0 &&
      entry.content.trim().length > 0
    ) {
      this.logger.warn('黑匣子忽略空正文更新，保留已有正文以防止内容丢失', {
        entryId: entry.id,
      });
      return {
        ...updates,
        content: entry.content,
      };
    }

    return updates;
  }
  
  /**
   * 标记为已读
   */
  markAsRead(id: string): Result<BlackBoxEntry, OperationError> {
    return this.update(id, { isRead: true }, {
      immediate: true,
      widgetNotifyAction: 'read',
    });
  }
  
  /**
   * 标记为完成
   */
  markAsCompleted(id: string): Result<BlackBoxEntry, OperationError> {
    return this.update(id, { isCompleted: true }, {
      immediate: true,
      widgetNotifyAction: 'complete',
    });
  }
  
  /**
   * 归档条目
   */
  archive(id: string): Result<BlackBoxEntry, OperationError> {
    return this.update(id, { isArchived: true });
  }
  
  /**
   * 取消归档
   */
  unarchive(id: string): Result<BlackBoxEntry, OperationError> {
    return this.update(id, { isArchived: false });
  }
  
  /**
   * 删除条目（软删除）
   */
  delete(id: string): Result<void, OperationError> {
    const entry = blackBoxEntriesMap().get(id);
    if (!entry) {
      return failure(ErrorCodes.FOCUS_ENTRY_NOT_FOUND, '条目不存在');
    }
    
    const now = new Date().toISOString();
    const deleted: BlackBoxEntry = {
      ...entry,
      deletedAt: now,
      updatedAt: now,
      syncStatus: this.resolveSyncStatusForMode(entry.userId),
    };

    updateBlackBoxEntry(deleted);
    
    // 同步删除操作到服务器，或本地模式仅持久化 tombstone
    this.persistAfterLocalChange(deleted);
    
    return success(undefined);
  }
  
  /**
   * 获取单个条目
   */
  getEntry(id: string): BlackBoxEntry | undefined {
    return blackBoxEntriesMap().get(id);
  }
  
  /**
   * 获取指定日期的条目
   */
  getEntriesByDate(date: string): BlackBoxEntry[] {
    return Array.from(blackBoxEntriesMap().values())
      .filter(e => e.date === date && !e.deletedAt && !e.isArchived)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }
  
  /**
   * 获取已完成的条目（用于地质层）
   */
  getCompletedEntries(date?: string): BlackBoxEntry[] {
    const entries = Array.from(blackBoxEntriesMap().values())
      .filter(e => e.isCompleted && !e.deletedAt);
    
    if (date) {
      return entries.filter(e => e.date === date);
    }
    
    return entries.sort((a, b) => 
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  }
  
  /**
   * 获取已归档的条目
   */
  getArchivedEntries(): BlackBoxEntry[] {
    return Array.from(blackBoxEntriesMap().values())
      .filter(e => e.isArchived && !e.deletedAt)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }
  
  /**
   * 跳过条目（稍后提醒）
   */
  snooze(id: string, until?: string): Result<BlackBoxEntry, OperationError> {
    const entry = blackBoxEntriesMap().get(id);
    if (!entry) {
      return failure(ErrorCodes.FOCUS_ENTRY_NOT_FOUND, '条目不存在');
    }
    
    // 默认跳过到明天
    const snoozeUntil = until ?? this.getTomorrowDate();
    
    return this.update(id, { 
      snoozeUntil,
      snoozeCount: (entry.snoozeCount ?? 0) + 1
    });
  }
  
  /**
   * 从服务器加载条目
   */
  async loadFromServer(options: PullChangesOptions | PullChangesOptions['reason'] = 'manual'): Promise<void> {
    await this.syncService.pullChanges(
      typeof options === 'string'
        ? { reason: options }
        : options,
    );
  }

  /**
   * 面板打开时先用本地快照填充，再走一次轻量远端刷新。
   */
  async refreshForView(): Promise<void> {
    await this.ensureLocalEntriesLoaded();
    await this.loadFromServer('panel-open');
  }

  getExpectedSyncUserId(): string | null {
    return this.resolveEffectiveUserId();
  }

  /**
   * 避免同一用户重复触发本地水合。
   */
  async ensureLocalEntriesLoaded(): Promise<void> {
    const hydrationKey = this.resolveLocalHydrationKey();
    if (this.localHydratedUserKey === hydrationKey) {
      return;
    }

    if (this.localHydrationPromise) {
      return this.localHydrationPromise;
    }

    this.localHydrationPromise = this.syncService.loadFromLocal()
      .then(() => {
        this.localHydratedUserKey = hydrationKey;
      })
      .catch((error: unknown) => {
        this.logger.debug('本地黑匣子快照水合失败', {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.localHydrationPromise = null;
      });

    await this.localHydrationPromise;
  }
  
  /**
   * 获取明天日期
   */
  private getTomorrowDate(): string {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    return tomorrow.toISOString().split('T')[0];
  }

  private resolveLocalHydrationKey(): string {
    return this.resolveEffectiveUserId() ?? '__anonymous__';
  }

  private resolveSyncStatusForMode(userId: string): NonNullable<BlackBoxEntry['syncStatus']> {
    return this.shouldSyncRemotely(userId) ? 'pending' : 'synced';
  }

  private shouldSyncRemotely(userId: string): boolean {
    return this.auth.isConfigured && userId !== AUTH_CONFIG.LOCAL_MODE_USER_ID;
  }

  private persistAfterLocalChange(entry: BlackBoxEntry, syncOptions?: ScheduleBlackBoxSyncOptions): void {
    if (this.shouldSyncRemotely(entry.userId)) {
      if (syncOptions) {
        void this.syncService.scheduleSync(entry, syncOptions);
      } else {
        void this.syncService.scheduleSync(entry);
      }
      return;
    }

    void this.syncService.saveToLocal(entry).catch((error: unknown) => {
      this.logger.warn('黑匣子本地模式持久化失败，当前会话内存状态已更新，后续本地水合可能需要重试', {
        entryId: entry.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}
