/**
 * SyncStateService 单元测试（Injector 隔离模式）
 *
 * 覆盖重点：
 * - Signal 状态转换
 * - pendingCount 下界（不能为负）
 * - 冲突生命周期（set/clear）
 * - idleChecker 门禁：advance/markRecovered 仅在空闲时推进 lastSyncTime
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { Injector, runInInjectionContext } from '@angular/core';
import { SyncStateService, type ConflictData } from './sync-state.service';
import type { Project } from '../../../../models';
import { RECOVERABLE_SYNC_ERROR_MESSAGES } from '../../../../config/sync.config';

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'P',
    description: '',
    createdDate: '2026-01-01T00:00:00Z',
    tasks: [],
    connections: [],
    ...overrides,
  };
}

describe('SyncStateService', () => {
  let service: SyncStateService;
  let injector: Injector;

  beforeEach(() => {
    injector = Injector.create({ providers: [] });
    service = runInInjectionContext(injector, () => new SyncStateService());
  });

  describe('初始状态', () => {
    it('isSyncing / hasConflict / sessionExpired 为 false', () => {
      expect(service.isSyncing()).toBe(false);
      expect(service.hasConflict()).toBe(false);
      expect(service.sessionExpired()).toBe(false);
      expect(service.pendingCount()).toBe(0);
      expect(service.syncState().syncError).toBeNull();
      expect(service.syncState().lastSyncTime).toBeNull();
    });

    it('isLoadingRemote signal 默认 false', () => {
      expect(service.isLoadingRemote()).toBe(false);
    });

    it('state 是 syncState 的别名', () => {
      expect(service.state).toBe(service.syncState);
    });
  });

  describe('基础 setter', () => {
    it('setSyncing 更新 isSyncing', () => {
      service.setSyncing(true);
      expect(service.isSyncing()).toBe(true);
    });

    it('setOnline 更新 isOnline', () => {
      service.setOnline(false);
      expect(service.syncState().isOnline).toBe(false);
    });

    it('setOfflineMode 更新 offlineMode', () => {
      service.setOfflineMode(true);
      expect(service.syncState().offlineMode).toBe(true);
    });

    it('setSessionExpired / resetSessionExpired', () => {
      service.setSessionExpired(true);
      expect(service.isSessionExpired()).toBe(true);
      service.resetSessionExpired();
      expect(service.isSessionExpired()).toBe(false);
    });

    it('setSyncError 支持字符串和 null', () => {
      service.setSyncError('boom');
      expect(service.syncState().syncError).toBe('boom');
      service.setSyncError(null);
      expect(service.syncState().syncError).toBeNull();
    });

    it('scheduleRecoverableSyncError 应立即写入 backgroundSyncNotice 通道（非 syncError）', () => {
      service.scheduleRecoverableSyncError(RECOVERABLE_SYNC_ERROR_MESSAGES.PARTIAL_RETRY_HANDOFF, 3000);
      // 中文注释：新通道立即可见；不再走 syncError 红错路径。
      expect(service.syncState().syncError).toBeNull();
      expect(service.syncState().backgroundSyncNotice).toBe(RECOVERABLE_SYNC_ERROR_MESSAGES.PARTIAL_RETRY_HANDOFF);
      expect(service.backgroundSyncNotice()).toBe(RECOVERABLE_SYNC_ERROR_MESSAGES.PARTIAL_RETRY_HANDOFF);
    });

    it('markSyncRecoveredIfIdle 应同时清空 backgroundSyncNotice', () => {
      service.scheduleRecoverableSyncError(RECOVERABLE_SYNC_ERROR_MESSAGES.PARTIAL_RETRY_HANDOFF, 3000);
      expect(service.backgroundSyncNotice()).not.toBeNull();
      expect(service.markSyncRecoveredIfIdle('2026-05-16T00:00:00Z')).toBe(true);
      expect(service.syncState().syncError).toBeNull();
      expect(service.syncState().backgroundSyncNotice).toBeNull();
    });

    it('setBackgroundSyncNotice / clearBackgroundSyncNotice 与 syncError 互不影响', () => {
      service.setSyncError('真错误');
      service.setBackgroundSyncNotice('后台自愈中');
      // 中文注释：两个通道独立；既能并存也能各自清理。
      expect(service.syncState().syncError).toBe('真错误');
      expect(service.syncState().backgroundSyncNotice).toBe('后台自愈中');

      service.clearBackgroundSyncNotice();
      expect(service.syncState().backgroundSyncNotice).toBeNull();
      expect(service.syncState().syncError).toBe('真错误');

      service.setSyncError(null);
      expect(service.syncState().syncError).toBeNull();
    });

    it('setBackgroundSyncNotice(null) 等价于 clearBackgroundSyncNotice', () => {
      service.setBackgroundSyncNotice('foo');
      service.setBackgroundSyncNotice(null);
      expect(service.syncState().backgroundSyncNotice).toBeNull();
    });

    it('setLoadingRemote 更新独立 signal', () => {
      service.setLoadingRemote(true);
      expect(service.isLoadingRemote()).toBe(true);
    });
  });

  describe('pendingCount', () => {
    it('setPendingCount 设置任意值', () => {
      service.setPendingCount(5);
      expect(service.pendingCount()).toBe(5);
    });

    it('incrementPendingCount 递增', () => {
      service.setPendingCount(2);
      service.incrementPendingCount();
      expect(service.pendingCount()).toBe(3);
    });

    it('decrementPendingCount 递减但不低于 0', () => {
      service.setPendingCount(1);
      service.decrementPendingCount();
      expect(service.pendingCount()).toBe(0);
      // 继续减少不应变负
      service.decrementPendingCount();
      expect(service.pendingCount()).toBe(0);
    });
  });

  describe('冲突生命周期', () => {
    const conflict: ConflictData = {
      local: makeProject({ id: 'p1', name: 'local' }),
      remote: makeProject({ id: 'p1', name: 'remote' }),
      projectId: 'p1',
    };

    it('setConflict 写入并标记 hasConflict', () => {
      service.setConflict(conflict);
      expect(service.hasConflict()).toBe(true);
      expect(service.syncState().conflictData).toBe(conflict);
    });

    it('clearConflict 清空', () => {
      service.setConflict(conflict);
      service.clearConflict();
      expect(service.hasConflict()).toBe(false);
      expect(service.syncState().conflictData).toBeNull();
    });

    it('ConflictData 可携带 pendingTaskDeleteIds', () => {
      const c: ConflictData = { ...conflict, pendingTaskDeleteIds: ['a', 'b'] };
      service.setConflict(c);
      expect(service.syncState().conflictData?.pendingTaskDeleteIds).toEqual(['a', 'b']);
    });
  });

  describe('idleChecker 门禁（修复移动端"最后同步 刚刚 + N 待同步"矛盾）', () => {
    it('未注册 checker 时 advance/mark 总是通过', () => {
      expect(service.advanceLastSyncTimeIfIdle('2026-04-22T00:00:00Z')).toBe(true);
      expect(service.syncState().lastSyncTime).toBe('2026-04-22T00:00:00Z');

      service.setSyncError('stale');
      expect(service.markSyncRecoveredIfIdle('2026-04-22T00:01:00Z')).toBe(true);
      expect(service.syncState().syncError).toBeNull();
    });

    it('checker 返回 false 时 advance 被拦截', () => {
      service.registerIdleChecker(() => false);
      const wrote = service.advanceLastSyncTimeIfIdle('2026-04-22T00:00:00Z');
      expect(wrote).toBe(false);
      expect(service.syncState().lastSyncTime).toBeNull();
    });

    it('checker 返回 false 时 markSyncRecovered 被拦截且不清空 syncError', () => {
      service.setSyncError('lingering');
      service.registerIdleChecker(() => false);
      const wrote = service.markSyncRecoveredIfIdle('2026-04-22T00:00:00Z');
      expect(wrote).toBe(false);
      expect(service.syncState().syncError).toBe('lingering');
    });

    it('checker 返回 true 时 advance 通过', () => {
      service.registerIdleChecker(() => true);
      expect(service.advanceLastSyncTimeIfIdle('2026-04-22T00:00:00Z')).toBe(true);
    });

    it('markSyncRecoveredIfIdle 空闲时同时清空 syncError', () => {
      service.setSyncError('old');
      service.registerIdleChecker(() => true);
      const wrote = service.markSyncRecoveredIfIdle('2026-04-22T00:00:00Z');
      expect(wrote).toBe(true);
      expect(service.syncState().lastSyncTime).toBe('2026-04-22T00:00:00Z');
      expect(service.syncState().syncError).toBeNull();
    });

    it('重复注册 checker 会覆盖旧的（切账号场景）', () => {
      let activeCheckerReturns = false;
      service.registerIdleChecker(() => activeCheckerReturns);
      expect(service.advanceLastSyncTimeIfIdle('t1')).toBe(false);

      // 覆盖
      service.registerIdleChecker(() => true);
      expect(service.advanceLastSyncTimeIfIdle('t2')).toBe(true);
      expect(service.syncState().lastSyncTime).toBe('t2');
      // 避免 ESLint unused-var
      activeCheckerReturns = true;
    });
  });
});
