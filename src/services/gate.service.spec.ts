/**
 * Gate 服务单元测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { GateService } from './gate.service';
import { BlackBoxService } from './black-box.service';
import { LoggerService } from './logger.service';
import {
  gateState,
  gatePendingItems,
  gateCurrentIndex,
  gateSnoozeCount,
  focusPreferences,
  setBlackBoxEntries,
  updateBlackBoxEntry,
  resetGateState,
} from '../state/focus-stores';
import { BlackBoxEntry } from '../models/focus';
import { FOCUS_CONFIG } from '../config/focus.config';

describe('GateService', () => {
  let service: GateService;
  let mockBlackBoxService: {
    markAsRead: ReturnType<typeof vi.fn>;
    markAsCompleted: ReturnType<typeof vi.fn>;
    snooze: ReturnType<typeof vi.fn>;
    loadFromServer: ReturnType<typeof vi.fn>;
    getExpectedSyncUserId: ReturnType<typeof vi.fn>;
  };

  let mockLoggerService: {
    debug: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };

  const getDateOffset = (days: number): string => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d.toISOString().split('T')[0];
  };

  const createMockEntry = (overrides: Partial<BlackBoxEntry> = {}): BlackBoxEntry => ({
    id: crypto.randomUUID(),
    projectId: 'test-project',
    userId: 'test-user',
    content: '测试条目',
    date: getDateOffset(0),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    isRead: false,
    isCompleted: false,
    isArchived: false,
    snoozeCount: 0,
    deletedAt: null,
    ...overrides,
  });

  beforeEach(() => {
    resetGateState();
    setBlackBoxEntries([]);
    focusPreferences.set({
      gateEnabled: true,
      strataEnabled: true,
      blackBoxEnabled: true,
      maxSnoozePerDay: 3,
      routineResetHourLocal: 0,
      restReminderHighLoadMinutes: 120,
      restReminderLowLoadMinutes: 20,
    });
    localStorage.clear();

    mockBlackBoxService = {
      markAsRead: vi.fn().mockReturnValue({ ok: true, value: {} }),
      markAsCompleted: vi.fn().mockReturnValue({ ok: true, value: {} }),
      snooze: vi.fn().mockReturnValue({ ok: true, value: {} }),
      loadFromServer: vi.fn().mockResolvedValue(undefined),
      getExpectedSyncUserId: vi.fn().mockReturnValue('test-user'),
    };

    mockLoggerService = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    TestBed.configureTestingModule({
      providers: [
        GateService,
        { provide: BlackBoxService, useValue: mockBlackBoxService },
        { provide: LoggerService, useValue: mockLoggerService },
      ],
    });

    service = TestBed.inject(GateService);
  });

  afterEach(() => {
    service.reset();
    vi.clearAllMocks();
    vi.useRealTimers();
    localStorage.clear();
  });

  describe('checkGate', () => {
    it('无待处理项目时应该跳过大门', () => {
      service.checkGate();

      expect(gateState()).toBe('bypassed');
    });

    it('有待处理项目时应该激活大门并进入 entering 动画', () => {
      const entry = createMockEntry({
        date: getDateOffset(-1),
        isCompleted: false,
      });
      setBlackBoxEntries([entry]);

      service.checkGate();

      expect(gateState()).toBe('reviewing');
      expect(gatePendingItems().length).toBe(1);
      expect(['entering', 'idle']).toContain(service.cardAnimation());
    });
    it('should refresh pending queue when checkGate is called during reviewing', () => {
      const first = createMockEntry({
        date: getDateOffset(-2),
        createdAt: '2026-02-01T08:00:00.000Z',
        updatedAt: '2026-02-01T08:00:00.000Z',
      });
      setBlackBoxEntries([first]);
      service.checkGate();
      expect(gatePendingItems().map(item => item.id)).toEqual([first.id]);

      const second = createMockEntry({
        date: getDateOffset(-1),
        createdAt: '2026-02-01T09:00:00.000Z',
        updatedAt: '2026-02-01T09:00:00.000Z',
      });
      setBlackBoxEntries([first, second]);

      service.checkGate();

      const ids = gatePendingItems().map(item => item.id);
      expect(ids).toContain(first.id);
      expect(ids).toContain(second.id);
      expect(gateState()).toBe('reviewing');
    });

    it('大门被禁用时应该进入 disabled', () => {
      focusPreferences.update(p => ({ ...p, gateEnabled: false }));
      setBlackBoxEntries([createMockEntry({ date: getDateOffset(-1) })]);

      service.checkGate();

      expect(gateState()).toBe('disabled');
    });

    it('已读处理完成后，冷却期内后续 gate 复核不应重新弹出同一条内容', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-01T12:00:00.000Z'));
      const entry = createMockEntry({
        id: 'read-once',
        date: getDateOffset(-1),
        isRead: false,
        isCompleted: false,
      });
      mockBlackBoxService.markAsRead.mockImplementationOnce((id: string) => {
        const updated = {
          ...entry,
          id,
          isRead: true,
          updatedAt: new Date().toISOString(),
          syncStatus: 'pending' as const,
        };
        updateBlackBoxEntry(updated);
        return { ok: true, value: updated };
      });
      setBlackBoxEntries([entry]);

      service.checkGate();
      service.onEnteringComplete();
      service.markAsRead();
      service.onHeaveReadComplete();

      expect(gateState()).toBe('completed');

      service.checkGate();

      // 修复后：completeGateSession 持久化"今日已处理"标记，第二次 checkGate
      // 命中 isGateHandledToday() 早返回，状态保留 'completed'（与 'bypassed'
      // 等价：均为非激活态、isGateActive=false），但语义更精确。
      expect(gateState()).toBe('completed');
      expect(gatePendingItems()).toEqual([]);
      vi.useRealTimers();
    });

    it('已读冷却到期后，后台恢复复核应让未完成条目重新进入大门', () => {
      vi.useFakeTimers();
      const start = new Date('2026-05-01T12:00:00.000Z');
      vi.setSystemTime(start);
      const entry = createMockEntry({
        id: 'read-reappears-after-cooldown',
        date: getDateOffset(-1),
        isRead: true,
        isCompleted: false,
        updatedAt: start.toISOString(),
      });
      setBlackBoxEntries([entry]);

      service.checkGate();
      expect(gateState()).toBe('bypassed');

      vi.setSystemTime(new Date(start.getTime() + FOCUS_CONFIG.GATE.READ_REAPPEAR_COOLDOWN_MS + 1000));
      service.checkGate();

      expect(gateState()).toBe('reviewing');
      expect(gatePendingItems().map(item => item.id)).toEqual(['read-reappears-after-cooldown']);
      vi.useRealTimers();
    });

    it('今日大门完成后，后台恢复触发的 remote 阶段 checkGate 不应再次激活大门', () => {
      // 复现：FocusStartupProbe.runProbe 里 applyGateSnapshot('local') 已弹出大门，
      // 用户审完进入 'completed'；接着 pullChanges 完成后再次 applyGateSnapshot('remote')
      // 调用 checkGate()，若此时仍有 pending（例如远端带回新条目或本地变更未同步），
      // 旧逻辑会重新设为 'reviewing' 并触发 entering 动画 → 出现"两次大门"。
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-01T12:00:00.000Z'));
      const entry = createMockEntry({
        id: 'first-pass',
        date: getDateOffset(-1),
      });
      mockBlackBoxService.markAsCompleted.mockImplementationOnce((id: string) => {
        const updated = {
          ...entry,
          id,
          isCompleted: true,
          updatedAt: new Date().toISOString(),
          syncStatus: 'pending' as const,
        };
        updateBlackBoxEntry(updated);
        return { ok: true, value: updated };
      });
      setBlackBoxEntries([entry]);

      // 第一阶段：local 探针弹出大门并被用户审完
      service.checkGate();
      expect(gateState()).toBe('reviewing');
      service.onEnteringComplete();
      service.markAsCompleted();
      service.onHeavyDropComplete();
      expect(gateState()).toBe('completed');

      // 第二阶段：模拟 pullChanges 带回一条尚未本地处理的旧 pending（黑匣子端）
      const intruder = createMockEntry({
        id: 'remote-intruder',
        date: getDateOffset(-2),
        isRead: false,
        isCompleted: false,
      });
      setBlackBoxEntries([
        { ...entry, isCompleted: true, updatedAt: new Date().toISOString() },
        intruder,
      ]);

      // applyGateSnapshot('remote') 内部会再次调用 checkGate()
      service.checkGate();

      expect(gateState()).toBe('completed');
      expect(['idle']).toContain(service.cardAnimation());
      vi.useRealTimers();
    });

    it('今日大门完成的标记跨天后失效，次日新 pending 应重新激活大门', () => {
      // 直接以 localStorage 标记"昨日"已处理，验证 checkGate 不再短路。
      // 不使用跨天 fake timer，因为 pendingBlackBoxEntries 依赖每分钟刷新的 todayDate
      // 信号，fake timer 下不会自动 tick，会污染 filter 行为。
      const yesterday = (() => {
        const d = new Date();
        d.setDate(d.getDate() - 1);
        return d.toISOString().split('T')[0];
      })();
      localStorage.setItem('focus_gate_last_check_date', yesterday);

      const entry = createMockEntry({
        id: 'next-day-entry',
        date: getDateOffset(-1),
      });
      setBlackBoxEntries([entry]);

      service.checkGate();

      expect(gateState()).toBe('reviewing');
      expect(gatePendingItems().map(item => item.id)).toEqual(['next-day-entry']);
    });
  });

  describe('动作状态机', () => {
    it('markAsRead 应该触发 heave_read 动画', () => {
      const entry = createMockEntry({ date: getDateOffset(-1) });
      gatePendingItems.set([entry]);
      gateCurrentIndex.set(0);
      gateState.set('reviewing');

      const result = service.markAsRead();

      expect(result.ok).toBe(true);
      expect(mockBlackBoxService.markAsRead).not.toHaveBeenCalled();
      expect(['heave_read', 'idle']).toContain(service.cardAnimation());
    });

    it('markAsCompleted 应该触发 heavy_drop 动画', () => {
      const entry = createMockEntry({ date: getDateOffset(-1) });
      gatePendingItems.set([entry]);
      gateCurrentIndex.set(0);
      gateState.set('reviewing');

      const result = service.markAsCompleted();

      expect(result.ok).toBe(true);
      expect(mockBlackBoxService.markAsCompleted).not.toHaveBeenCalled();
      expect(['heavy_drop', 'idle']).toContain(service.cardAnimation());
    });

    it('heavy_drop 完成后应触发 impactTick 并结束 gate', () => {
      const entry = createMockEntry({ date: getDateOffset(-1) });
      gatePendingItems.set([entry]);
      gateCurrentIndex.set(0);
      gateState.set('reviewing');

      service.markAsCompleted();
      const before = service.impactTick();

      service.onHeavyDropComplete();

      expect(mockBlackBoxService.markAsCompleted).toHaveBeenCalledWith(entry.id);
      expect(service.impactTick()).toBeGreaterThan(before);
      expect(gateState()).toBe('completed');
    });

    it('heave_read 沉降完成后才提交全局黑匣子更新', () => {
      const first = createMockEntry({ date: getDateOffset(-1) });
      const second = createMockEntry({ date: getDateOffset(-2) });
      gatePendingItems.set([first, second]);
      gateCurrentIndex.set(0);
      gateState.set('reviewing');

      service.markAsRead();
      service.onHeaveReadComplete();

      expect(gateCurrentIndex()).toBe(1);
      expect(mockBlackBoxService.markAsRead).not.toHaveBeenCalled();
      expect(['settling', 'idle']).toContain(service.cardAnimation());

      service.onSettlingComplete();

      expect(mockBlackBoxService.markAsRead).toHaveBeenCalledWith(first.id);
    });

    it('未触发动作时 pending 短暂变空不应让大门自动消失', () => {
      const entry = createMockEntry({
        id: 'mobile-gate-current-entry',
        date: getDateOffset(-1),
      });
      setBlackBoxEntries([entry]);

      service.checkGate();
      expect(gateState()).toBe('reviewing');

      // 模拟手机端恢复/远端拉取窗口里 pending 派生信号短暂归零；用户没有点已读/完成。
      setBlackBoxEntries([]);
      TestBed.flushEffects();

      expect(gateState()).toBe('reviewing');
      expect(gatePendingItems().map(item => item.id)).toEqual(['mobile-gate-current-entry']);
      expect(mockBlackBoxService.markAsRead).not.toHaveBeenCalled();
      expect(mockBlackBoxService.markAsCompleted).not.toHaveBeenCalled();
    });

    it('远端确认当前条目已解决时不应保留 ghost 卡片', () => {
      const entry = createMockEntry({
        id: 'remote-cleared-entry',
        date: getDateOffset(-1),
      });
      setBlackBoxEntries([entry]);

      service.checkGate();

      (service as unknown as {
        syncReviewingQueueWithPending: (pending: BlackBoxEntry[], source: 'checkGate' | 'signal' | 'remote') => void;
      }).syncReviewingQueueWithPending([], 'remote');

      expect(gateState()).toBe('completed');
      expect(gatePendingItems()).toEqual([]);
      expect(mockBlackBoxService.markAsRead).not.toHaveBeenCalled();
      expect(mockBlackBoxService.markAsCompleted).not.toHaveBeenCalled();
    });

    it('settling 期间不应接受下一次动作，避免覆盖上一个 deferred mutation', () => {
      const first = createMockEntry({ date: getDateOffset(-1) });
      const second = createMockEntry({ date: getDateOffset(-2) });
      gatePendingItems.set([first, second]);
      gateCurrentIndex.set(0);
      gateState.set('reviewing');

      service.markAsRead();
      service.onHeaveReadComplete();

      const result = service.markAsCompleted();

      expect(result.ok).toBe(false);
      expect(mockBlackBoxService.markAsCompleted).not.toHaveBeenCalled();

      service.onSettlingComplete();

      expect(mockBlackBoxService.markAsRead).toHaveBeenCalledWith(first.id);
    });

    it('reduced motion 下应立即 flush deferred mutation', () => {
      const first = createMockEntry({ date: getDateOffset(-1) });
      const second = createMockEntry({ date: getDateOffset(-2) });
      gatePendingItems.set([first, second]);
      gateCurrentIndex.set(0);
      gateState.set('reviewing');
      (service as unknown as { prefersReducedMotionSignal: { set(value: boolean): void } }).prefersReducedMotionSignal.set(true);

      const result = service.markAsRead();

      expect(result.ok).toBe(true);
      expect(gateCurrentIndex()).toBe(1);
      expect(mockBlackBoxService.markAsRead).toHaveBeenCalledWith(first.id);
    });
  });

  describe('snooze compatibility', () => {
    it('跳过次数上限后返回错误', () => {
      const entry = createMockEntry({ date: getDateOffset(-1) });
      gatePendingItems.set([entry]);
      gateCurrentIndex.set(0);
      gateSnoozeCount.set(3);
      gateState.set('reviewing');

      const result = service.snooze();

      expect(result.ok).toBe(false);
    });
  });

  describe('reset / bypass', () => {
    it('forceBypass 应设为 bypassed', () => {
      gateState.set('reviewing');
      service.forceBypass();
      expect(gateState()).toBe('bypassed');
    });

    it('reset 应重置状态与动画', () => {
      gateState.set('reviewing');
      gatePendingItems.set([createMockEntry({ date: getDateOffset(-1) })]);
      service.cardAnimation.set('heavy_drop');

      service.reset();

      expect(gateState()).toBe('checking');
      expect(gatePendingItems().length).toBe(0);
      expect(service.cardAnimation()).toBe('idle');
    });
  });
});
