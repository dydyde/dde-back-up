/**
 * ConflictStorageService - 冲突数据持久化服务
 * 
 * 使用 IndexedDB 存储冲突时的完整本地数据，实现"隔离区"概念。
 * 
 * 设计原则：
 * - 当冲突发生且无法自动解决时，完整序列化本地脏数据
 * - 即使应用崩溃、网络断开，用户数据都在等待处理
 * - 只存元数据就像只留路标却清理了事故现场 —— 不负责任
 */
import { Injectable, inject, signal, computed, effect } from '@angular/core';
import { LoggerService } from './logger.service';
import { AuthService } from './auth.service';
import { Project } from '../models';
import { AUTH_CONFIG } from '../config/auth.config';

/** 冲突记录 */
export interface ConflictRecord {
  /** 项目 ID */
  projectId: string;
  /** 冲突所属用户，用于跨账号隔离 */
  ownerUserId?: string;
  /** 完整的本地项目数据（用户心血所在） */
  localProject: Project;
  /** 完整的远程项目数据（用于对比和解决） */
  remoteProject?: Project;
  /** 远端快照是否为本轮冲突新鲜获取，false 表示仅作参考不可直接用于 remote/merge */
  remoteSnapshotFresh?: boolean;
  /** 冲突发生时间 */
  conflictedAt: string;
  /** 本地版本号 */
  localVersion: number;
  /** 远程版本号（如果已知） */
  remoteVersion?: number;
  /** 冲突原因 */
  reason: 'version_mismatch' | 'concurrent_edit' | 'network_recovery' | 'status_conflict' | 'field_conflict';
  /** 冲突的字段列表（用于展示差异） */
  conflictedFields?: string[];
  /** 冲突前已确认的待删除任务，解决冲突后仍需继续回放 */
  pendingTaskDeleteIds?: string[];
  /** 是否已读/已处理 */
  acknowledged?: boolean;
}

interface StoredConflictRecord extends ConflictRecord {
  scopedId: string;
}

const LEGACY_UNKNOWN_OWNER_USER_ID = '__legacy_unknown__';
const DB_NAME = 'nanoflow-conflicts';
const DB_VERSION = 2;
const STORE_NAME = 'conflicts';

@Injectable({
  providedIn: 'root'
})
export class ConflictStorageService {
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('ConflictStorage');
  private readonly authService = inject(AuthService);
  private db: IDBDatabase | null = null;
  private dbPromise: Promise<IDBDatabase> | null = null;
  
  /**
   * 冲突数量信号
   * 用于在 UI 中显示冲突红点提示
   */
  private _conflictCount = signal(0);
  
  /** 冲突数量（响应式） */
  readonly conflictCount = this._conflictCount.asReadonly();
  
  /** 是否有未处理的冲突 */
  readonly hasUnresolvedConflicts = computed(() => this._conflictCount() > 0);
  
  constructor() {
    // 初始化时加载冲突数量
    this.refreshConflictCount();

    /**
     * 2026-05-15 修复：原构造里只调一次 refreshConflictCount，登出再换号登录后
     * `getCurrentOwnerUserId()` 变了，但 signal 仍是上一个账号的数。
     * 跟随 `currentUserId` 变化重新计数，避免侧边栏卡死在前一账号的"X 个冲突待处理"。
     *
     * 用 try/catch 包裹：单元测试用 bare `Injector.create()` 没有 ChangeDetectionScheduler，
     * 直接调 effect() 会抛 NullInjectorError。生产/TestBed 中正常生效。
     */
    try {
      let lastOwner: string | null = this.authService.currentUserId();
      effect(() => {
        const next = this.authService.currentUserId();
        if (next !== lastOwner) {
          lastOwner = next;
          void this.refreshConflictCount();
        }
      });
    } catch (e) {
      this.logger.debug('Auth 切换 effect 注册失败（通常在测试 bare injector 环境）', e);
    }
  }
  
  /**
   * 刷新冲突计数
   * 应在保存/删除冲突后调用
   */
  async refreshConflictCount(): Promise<void> {
    try {
      const count = await this.getConflictCount();
      this._conflictCount.set(count);
    } catch (e) {
      this.logger.warn('刷新冲突计数失败', e);
    }
  }
  
  /**
   * 获取冲突数量
   */
  async getConflictCount(): Promise<number> {
    try {
      const conflicts = await this.getAllConflicts();
      return conflicts.length;
    } catch (e) {
      this.logger.debug('IndexedDB 不可用（getConflictCount），降级到 localStorage', { error: e });
      // 检查 localStorage 降级
      return this.countLocalStorageFallback();
    }
  }
  
  /**
   * 初始化数据库连接
   * 使用懒加载，首次调用时才创建连接
   */
  private async getDb(): Promise<IDBDatabase> {
    if (this.db) return this.db;
    
    if (this.dbPromise) return this.dbPromise;
    
    this.dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB 不可用'));
        return;
      }
      
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      
      request.onerror = () => {
        this.logger.error('打开 IndexedDB 失败', request.error);
        reject(request.error);
      };
      
      request.onsuccess = () => {
        this.db = request.result;
        this.logger.info('IndexedDB 连接成功');
        resolve(this.db);
      };
      
      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        const transaction = request.transaction;
        if (!transaction) {
          return;
        }

        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'scopedId' });
          store.createIndex('ownerUserId', 'ownerUserId', { unique: false });
          store.createIndex('conflictedAt', 'conflictedAt', { unique: false });
          this.logger.info('创建 conflicts 存储');
          return;
        }

        const existingStore = transaction.objectStore(STORE_NAME);
        if (event.oldVersion < 2 || existingStore.keyPath !== 'scopedId') {
          const migrateRequest = existingStore.getAll();
          db.deleteObjectStore(STORE_NAME);
          const nextStore = db.createObjectStore(STORE_NAME, { keyPath: 'scopedId' });
          nextStore.createIndex('ownerUserId', 'ownerUserId', { unique: false });
          nextStore.createIndex('conflictedAt', 'conflictedAt', { unique: false });

          migrateRequest.onsuccess = () => {
            const legacyRecords = (migrateRequest.result || []) as ConflictRecord[];
            legacyRecords.forEach(record => {
              const ownerUserId = this.resolveLegacyConflictOwnerUserId(record);
              const scopedRecord: StoredConflictRecord = {
                ...record,
                ownerUserId,
                scopedId: this.getScopedId(record.projectId, ownerUserId),
              };
              nextStore.put(scopedRecord);
            });
          };

          migrateRequest.onerror = () => {
            this.logger.error('迁移 conflicts 存储失败', migrateRequest.error);
          };
          this.logger.info('升级 conflicts 存储到 owner-scoped 主键');
          return;
        }

        if (!existingStore.indexNames.contains('ownerUserId')) {
          existingStore.createIndex('ownerUserId', 'ownerUserId', { unique: false });
        }
        if (!existingStore.indexNames.contains('conflictedAt')) {
          existingStore.createIndex('conflictedAt', 'conflictedAt', { unique: false });
        }
      };
    });
    
    return this.dbPromise;
  }
  
  /**
   * 保存冲突数据到隔离区
   * 
   * 当检测到冲突时调用，完整保存本地数据
   * 这样即使用户下周才处理，数据也完好无损
   */
  async saveConflict(record: ConflictRecord): Promise<boolean> {
    try {
      const db = await this.getDb();
      const ownerUserId = record.ownerUserId ?? this.getCurrentOwnerUserId();
      const scopedRecord: StoredConflictRecord = {
        ...record,
        ownerUserId,
        scopedId: this.getScopedId(record.projectId, ownerUserId),
      };
      
      return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        
        const request = store.put(scopedRecord);
        
        request.onsuccess = () => {
          this.logger.info('冲突数据已保存到隔离区', {
            projectId: scopedRecord.projectId,
            ownerUserId,
            localVersion: scopedRecord.localVersion,
            taskCount: scopedRecord.localProject.tasks.length
          });
          // 刷新冲突计数
          void this.refreshConflictCount();
          resolve(true);
        };
        
        request.onerror = () => {
          this.logger.error('保存冲突数据失败', request.error);
          reject(request.error);
        };
      });
    } catch (e) {
      this.logger.error('保存冲突数据时发生异常', e);
      // 降级：尝试使用 localStorage
      return this.fallbackSaveToLocalStorage({
        ...record,
        ownerUserId: record.ownerUserId ?? this.getCurrentOwnerUserId(),
      });
    }
  }
  
  /**
   * 获取指定项目的冲突数据
   */
  async getConflict(projectId: string): Promise<ConflictRecord | null> {
    try {
      const db = await this.getDb();

      const indexedRecord = await new Promise<StoredConflictRecord | null>((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readonly');
        const store = transaction.objectStore(STORE_NAME);

        const request = store.get(this.getScopedId(projectId));

        request.onsuccess = () => {
          resolve((request.result as StoredConflictRecord | null) ?? null);
        };

        request.onerror = () => {
          this.logger.error('读取冲突数据失败', request.error);
          reject(request.error);
        };
      });

      const fallbackRecord = this.fallbackLoadFromLocalStorage(projectId);
      const visibleIndexedRecord = this.isRecordVisible(indexedRecord) ? indexedRecord : null;
      const preferredRecord = this.selectPreferredConflictRecord(visibleIndexedRecord, fallbackRecord);

      if (preferredRecord && preferredRecord === fallbackRecord) {
        await this.promoteFallbackRecordToIndexedDb(db, fallbackRecord);
      }

      return preferredRecord;
    } catch (e) {
      this.logger.error('读取冲突数据时发生异常', e);
      // 降级：尝试从 localStorage 读取
      return this.fallbackLoadFromLocalStorage(projectId);
    }
  }
  
  /**
   * 获取所有待处理的冲突
   */
  async getAllConflicts(): Promise<ConflictRecord[]> {
    try {
      const db = await this.getDb();

      const indexedRecords = await new Promise<StoredConflictRecord[]>((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const ownerIndex = store.index('ownerUserId');
        const request = ownerIndex.getAll(this.getCurrentOwnerUserId());

        request.onsuccess = () => {
          const records = (request.result || []) as StoredConflictRecord[];
          resolve(records.filter(record => this.isRecordVisible(record)));
        };

        request.onerror = () => {
          this.logger.error('读取所有冲突数据失败', request.error);
          reject(request.error);
        };
      });

      const mergedRecords = new Map<string, ConflictRecord>();
      indexedRecords.forEach(record => {
        mergedRecords.set(record.projectId, record);
      });

      const fallbackRecords = this.getAllLocalStorageFallback();
      const fallbackRecordsToPromote: ConflictRecord[] = [];
      fallbackRecords.forEach(record => {
        const existing = mergedRecords.get(record.projectId) ?? null;
        if (!existing || this.shouldPreferFallbackRecord(record, existing)) {
          mergedRecords.set(record.projectId, record);
          fallbackRecordsToPromote.push(record);
        }
      });

      if (fallbackRecordsToPromote.length > 0) {
        await Promise.all(
          fallbackRecordsToPromote.map(record => this.promoteFallbackRecordToIndexedDb(db, record))
        );
      }

      return Array.from(mergedRecords.values());
    } catch (e) {
      this.logger.error('读取所有冲突数据时发生异常', e);
      return this.getAllLocalStorageFallback();
    }
  }
  
  /**
   * 冲突解决后删除记录
   */
  async deleteConflict(projectId: string, ownerUserId?: string | null): Promise<boolean> {
    try {
      const db = await this.getDb();
      const explicitOwnerUserId = typeof ownerUserId === 'string' && ownerUserId.length > 0
        ? ownerUserId
        : undefined;
      const bypassVisibility = explicitOwnerUserId !== undefined
        && explicitOwnerUserId !== this.getCurrentOwnerUserId();
      
      return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const scopedId = this.getScopedId(projectId, explicitOwnerUserId);

        const getRequest = store.get(scopedId);
        getRequest.onsuccess = () => {
          const record = getRequest.result as StoredConflictRecord | null;
          if (!record) {
            resolve(this.deleteFallbackConflict(projectId, explicitOwnerUserId ?? undefined));
            return;
          }

          const resolvedOwnerUserId = explicitOwnerUserId ?? this.resolveLegacyConflictOwnerUserId(record);
          const canDelete = bypassVisibility || this.isRecordVisible(record);

          if (!canDelete) {
            resolve(this.deleteFallbackConflict(projectId, explicitOwnerUserId ?? undefined));
            return;
          }

          const deleteRequest = store.delete(scopedId);
          deleteRequest.onsuccess = () => {
            this.logger.info('冲突数据已从隔离区移除', { projectId, ownerUserId: resolvedOwnerUserId });
            // 同时清理可能存在的 localStorage 降级数据
            this.clearLocalStorageFallback(projectId, {
              ownerUserId: resolvedOwnerUserId,
              includeLegacyKey: resolvedOwnerUserId === LEGACY_UNKNOWN_OWNER_USER_ID,
            });
            // 刷新冲突计数
            void this.refreshConflictCount();
            resolve(true);
          };

          deleteRequest.onerror = () => {
            this.logger.error('删除冲突数据失败', deleteRequest.error);
            reject(deleteRequest.error);
          };
        };

        getRequest.onerror = () => {
          this.logger.error('读取待删除冲突数据失败', getRequest.error);
          reject(getRequest.error);
        };
      });
    } catch (e) {
      this.logger.error('删除冲突数据时发生异常', e);
      return this.deleteFallbackConflict(projectId, ownerUserId ?? undefined);
    }
  }
  
  /**
   * 检查是否有待处理的冲突
   */
  async hasConflicts(): Promise<boolean> {
    try {
      const conflicts = await this.getAllConflicts();
      return conflicts.length > 0;
    } catch (e) {
      this.logger.debug('IndexedDB 不可用（hasConflicts），降级到 localStorage', { error: e });
      // 检查 localStorage 降级
      return this.hasLocalStorageFallback();
    }
  }

  clearFallbackStorageForOwner(ownerUserId = this.getCurrentOwnerUserId()): void {
    try {
      this.getFallbackKeysForOwner(ownerUserId)
        .forEach(key => localStorage.removeItem(key));
    } catch (e) {
      this.logger.warn('清理 owner 作用域的 conflict fallback 失败', { ownerUserId, error: e });
    }
  }

  clearAllFallbackStorage(): void {
    try {
      this.listFallbackKeys()
        .forEach(key => localStorage.removeItem(key));
    } catch (e) {
      this.logger.warn('清理全部 conflict fallback 失败', e);
    }
  }

  async closeStorageConnections(): Promise<void> {
    const pendingDbPromise = this.dbPromise;
    this.dbPromise = null;

    if (pendingDbPromise) {
      try {
        const pendingDb = await pendingDbPromise;
        pendingDb.close();
      } catch {
        // 忽略打开失败：此时没有需要关闭的连接
      }
    }

    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
  
  // ========== LocalStorage 降级处理 ==========
  
  private readonly FALLBACK_KEY_PREFIX = 'nanoflow.conflict.';

  private resolveLegacyConflictOwnerUserId(record: ConflictRecord): string {
    if (record.ownerUserId) {
      return record.ownerUserId;
    }

    // 中文注释：owner 缺失的 legacy 冲突进入 unknown-owner 隔离桶，默认不向任何会话直接展示。
    return LEGACY_UNKNOWN_OWNER_USER_ID;
  }

  private getScopedId(projectId: string, ownerUserId = this.getCurrentOwnerUserId()): string {
    return `${ownerUserId}::${projectId}`;
  }

  private getCurrentOwnerUserId(): string {
    return this.authService.currentUserId() ?? AUTH_CONFIG.LOCAL_MODE_USER_ID;
  }

  private isRecordVisible(record: ConflictRecord | null | undefined): record is ConflictRecord {
    if (!record) return false;

    return typeof record.ownerUserId === 'string'
      && record.ownerUserId.length > 0
      && record.ownerUserId === this.getCurrentOwnerUserId();
  }

  private getFallbackKey(projectId: string, ownerUserId = this.getCurrentOwnerUserId()): string {
    if (ownerUserId === LEGACY_UNKNOWN_OWNER_USER_ID) {
      return `${this.FALLBACK_KEY_PREFIX}${projectId}`;
    }

    return `${this.FALLBACK_KEY_PREFIX}${ownerUserId}.${projectId}`;
  }

  private selectPreferredConflictRecord(
    indexedRecord: ConflictRecord | null,
    fallbackRecord: ConflictRecord | null,
  ): ConflictRecord | null {
    if (!fallbackRecord) {
      return indexedRecord;
    }

    if (!indexedRecord) {
      return fallbackRecord;
    }

    return this.shouldPreferFallbackRecord(fallbackRecord, indexedRecord)
      ? fallbackRecord
      : indexedRecord;
  }

  private shouldPreferFallbackRecord(fallbackRecord: ConflictRecord, indexedRecord: ConflictRecord): boolean {
    if (fallbackRecord.conflictedAt !== indexedRecord.conflictedAt) {
      return fallbackRecord.conflictedAt > indexedRecord.conflictedAt;
    }

    return fallbackRecord.localVersion >= indexedRecord.localVersion;
  }

  private async promoteFallbackRecordToIndexedDb(db: IDBDatabase, record: ConflictRecord): Promise<void> {
    const ownerUserId = this.resolveLegacyConflictOwnerUserId(record);
    const scopedRecord: StoredConflictRecord = {
      ...record,
      ownerUserId,
      scopedId: this.getScopedId(record.projectId, ownerUserId),
    };

    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.put(scopedRecord);

        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });

      this.clearLocalStorageFallback(record.projectId, {
        ownerUserId,
        includeLegacyKey: ownerUserId === LEGACY_UNKNOWN_OWNER_USER_ID,
      });
    } catch (error) {
      this.logger.warn('迁移 fallback 冲突到 IndexedDB 失败', {
        projectId: record.projectId,
        ownerUserId,
        error,
      });
    }
  }
  
  private fallbackSaveToLocalStorage(record: ConflictRecord): boolean {
    try {
      const key = this.getFallbackKey(record.projectId, record.ownerUserId ?? this.getCurrentOwnerUserId());
      localStorage.setItem(key, JSON.stringify(record));
      this.logger.warn('使用 localStorage 降级保存冲突数据');
      return true;
    } catch (e) {
      this.logger.error('localStorage 降级保存也失败了', e);
      return false;
    }
  }
  
  private fallbackLoadFromLocalStorage(
    projectId: string,
    ownerUserId = this.getCurrentOwnerUserId(),
    options?: { bypassVisibility?: boolean }
  ): ConflictRecord | null {
    try {
      const key = this.getFallbackKey(projectId, ownerUserId);
      const data = localStorage.getItem(key);
      if (data) {
        const record = JSON.parse(data) as ConflictRecord;
        if (options?.bypassVisibility) {
          return record;
        }

        return this.isRecordVisible(record) ? record : null;
      }

      return null;
    } catch (e) {
      this.logger.warn('从 localStorage 加载冲突数据失败', { projectId, error: e });
      // eslint-disable-next-line no-restricted-syntax -- 返回 null 语义正确：回退加载失败表示无冲突记录
      return null;
    }
  }
  
  private clearLocalStorageFallback(
    projectId: string,
    options?: { includeLegacyKey?: boolean; ownerUserId?: string }
  ): void {
    try {
      localStorage.removeItem(this.getFallbackKey(projectId, options?.ownerUserId ?? this.getCurrentOwnerUserId()));
      if (options?.includeLegacyKey) {
        localStorage.removeItem(`${this.FALLBACK_KEY_PREFIX}${projectId}`);
      }
    } catch (e) {
      this.logger.debug('清理 localStorage 失败，忽略', { projectId, error: e });
    }
  }

  private deleteFallbackConflict(projectId: string, ownerUserId = this.getCurrentOwnerUserId()): boolean {
    const existing = this.fallbackLoadFromLocalStorage(projectId, ownerUserId, {
      bypassVisibility: ownerUserId !== this.getCurrentOwnerUserId(),
    });
    if (!existing) {
      return false;
    }

    this.clearLocalStorageFallback(projectId, {
      ownerUserId,
      includeLegacyKey: ownerUserId === LEGACY_UNKNOWN_OWNER_USER_ID,
    });
    void this.refreshConflictCount();
    return true;
  }

  private getFallbackKeysForOwner(ownerUserId: string): string[] {
    if (ownerUserId === LEGACY_UNKNOWN_OWNER_USER_ID) {
      return this.listFallbackKeys().filter(key => {
        if (!key.startsWith(this.FALLBACK_KEY_PREFIX)) {
          return false;
        }

        const suffix = key.slice(this.FALLBACK_KEY_PREFIX.length);
        return !suffix.includes('.');
      });
    }

    const scopedPrefix = `${this.FALLBACK_KEY_PREFIX}${ownerUserId}.`;

    return this.listFallbackKeys().filter(key => key.startsWith(scopedPrefix));
  }

  private listFallbackKeys(): string[] {
    const keys: string[] = [];

    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(this.FALLBACK_KEY_PREFIX)) {
        keys.push(key);
      }
    }

    return keys;
  }

  private getAllLocalStorageFallback(): ConflictRecord[] {
    try {
      const records: ConflictRecord[] = [];
      const currentOwnerUserId = this.getCurrentOwnerUserId();
      const currentPrefix = `${this.FALLBACK_KEY_PREFIX}${currentOwnerUserId}.`;

      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key) {
          continue;
        }

        if (!key.startsWith(currentPrefix)) {
          continue;
        }

        const raw = localStorage.getItem(key);
        if (!raw) {
          continue;
        }

        const record = JSON.parse(raw) as ConflictRecord;
        if (this.isRecordVisible(record)) {
          records.push(record);
        }
      }

      return records;
    } catch (e) {
      this.logger.debug('读取 localStorage 冲突列表失败，返回空列表', { error: e });
      return [];
    }
  }
  
  private hasLocalStorageFallback(): boolean {
    try {
      const currentPrefix = `${this.FALLBACK_KEY_PREFIX}${this.getCurrentOwnerUserId()}.`;
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith(currentPrefix)) {
          return true;
        }
      }
      return false;
    } catch (e) {
      this.logger.debug('localStorage 访问失败，返回 false', { error: e });
      return false;
    }
  }
  
  private countLocalStorageFallback(): number {
    try {
      let count = 0;
      const currentPrefix = `${this.FALLBACK_KEY_PREFIX}${this.getCurrentOwnerUserId()}.`;
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith(currentPrefix)) {
          count++;
        }
      }
      return count;
    } catch (e) {
      this.logger.debug('localStorage 访问失败，返回 0', { error: e });
      return 0;
    }
  }
  
  // ========== 测试支持 ==========
  
  /**
   * 重置服务状态（用于测试）
   */
  reset(): void {
    void this.closeStorageConnections();
  }
}
