/**
 * QueueBackupService — IndexedDB 队列备份服务
 *
 * 职责：
 * - IndexedDB 备份数据库管理
 * - 队列备份写入与恢复
 * - Legacy 备份迁移处理
 *
 * 从 ActionQueueStorageService 抽离（2026-05-13）
 */
import { Injectable, inject } from '@angular/core';
import { LoggerService } from './logger.service';
import type { QueuedAction } from './action-queue.types';

const QUEUE_BACKUP_DB_NAME = 'nanoflow-queue-backup';
const QUEUE_BACKUP_DB_VERSION = 1;
const QUEUE_BACKUP_STORE_NAME = 'queue-backup';

/**
 * 队列备份记录
 */
export interface QueueBackupRecord {
  id: string;
  ownerUserId: string;
  actions: QueuedAction[];
  savedAt: string;
}

/**
 * Legacy 队列审查条目
 */
export interface LegacyQueueReviewItem {
  action: QueuedAction;
  source: 'legacy-global-queue' | 'legacy-idb-backup';
  capturedAt: string;
  ownerUserId: string;
}

const LEGACY_QUEUE_BACKUP_RECORD_ID = 'nanoflow-queue-backup-v1';
const LEGACY_UNKNOWN_OWNER_USER_ID = '__legacy_unknown__';

@Injectable({ providedIn: 'root' })
export class QueueBackupService {
  private readonly logger = inject(LoggerService).category('QueueBackup');

  /**
   * 生成用户专属的备份记录 ID
   */
  getQueueBackupRecordId(ownerUserId: string): string {
    return `queue-backup:${ownerUserId}`;
  }

  /**
   * 备份队列到 IndexedDB
   */
  async backupQueue(queue: QueuedAction[], ownerUserId: string): Promise<boolean> {
    if (typeof indexedDB === 'undefined') return false;

    try {
      const recordId = this.getQueueBackupRecordId(ownerUserId);
      const db = await this.openQueueBackupDb();
      return new Promise((resolve) => {
        const transaction = db.transaction([QUEUE_BACKUP_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(QUEUE_BACKUP_STORE_NAME);
        const record: QueueBackupRecord = {
          id: recordId,
          ownerUserId,
          actions: queue,
          savedAt: new Date().toISOString(),
        };
        const putRequest = store.put(record);

        putRequest.onsuccess = () => {
          db.close();
          this.logger.info('队列已备份到 IndexedDB', { count: queue.length, ownerUserId });
          resolve(true);
        };

        putRequest.onerror = () => {
          db.close();
          this.logger.error('IndexedDB 写入失败', putRequest.error);
          resolve(false);
        };
      });
    } catch (e) {
      this.logger.error('IndexedDB 备份异常', e);
      return false;
    }
  }

  /**
   * 从 IndexedDB 恢复队列
   * 优先恢复当前用户的备份，若无则检查 legacy 备份
   *
   * @returns 恢复的队列数据；若无备份或读取失败返回 null
   *          legacy 备份会被隔离到审查队列，不直接返回
   */
  async restoreQueue(
    ownerUserId: string,
    onLegacyFound?: (items: LegacyQueueReviewItem[]) => void
  ): Promise<QueuedAction[] | null> {
    if (typeof indexedDB === 'undefined') return null;

    try {
      const recordId = this.getQueueBackupRecordId(ownerUserId);
      const db = await this.openQueueBackupDb();

      return new Promise((resolve) => {
        const transaction = db.transaction([QUEUE_BACKUP_STORE_NAME], 'readonly');
        const store = transaction.objectStore(QUEUE_BACKUP_STORE_NAME);
        const request = store.get(recordId);

        request.onsuccess = () => {
          const data = request.result as QueueBackupRecord | undefined;

          // 找到当前用户的备份
          if (data?.actions) {
            db.close();
            this.logger.info('从 IndexedDB 恢复队列备份', {
              count: data.actions.length,
              savedAt: data.savedAt,
            });
            resolve(data.actions);
            return;
          }

          // 未找到当前用户备份，检查 legacy 备份
          const legacyRequest = store.get(LEGACY_QUEUE_BACKUP_RECORD_ID);

          legacyRequest.onsuccess = () => {
            const legacyData = legacyRequest.result as QueueBackupRecord | undefined;
            db.close();

            if (legacyData?.actions && legacyData.actions.length > 0) {
              this.logger.warn('检测到 legacy 队列备份，已隔离待审查', {
                count: legacyData.actions.length,
                savedAt: legacyData.savedAt,
              });

              // 转换为审查条目并通知调用方
              const reviewItems: LegacyQueueReviewItem[] = legacyData.actions.map((action) => ({
                action,
                source: 'legacy-idb-backup' as const,
                capturedAt: legacyData.savedAt,
                ownerUserId: LEGACY_UNKNOWN_OWNER_USER_ID,
              }));

              onLegacyFound?.(reviewItems);
            }

            resolve(null);
          };

          legacyRequest.onerror = () => {
            db.close();
            this.logger.warn('从 IndexedDB 读取 legacy 备份失败', legacyRequest.error);
            resolve(null);
          };
        };

        request.onerror = () => {
          db.close();
          this.logger.warn('从 IndexedDB 读取备份失败', request.error);
          resolve(null);
        };
      });
    } catch (e) {
      this.logger.warn('IndexedDB 恢复异常', e);
      return null;
    }
  }

  /**
   * 打开队列备份数据库
   */
  private openQueueBackupDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(QUEUE_BACKUP_DB_NAME, QUEUE_BACKUP_DB_VERSION);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(QUEUE_BACKUP_STORE_NAME)) {
          db.createObjectStore(QUEUE_BACKUP_STORE_NAME, { keyPath: 'id' });
        }
      };
    });
  }
}
