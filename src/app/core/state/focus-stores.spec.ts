/**
 * 专注模式状态管理测试
 * 
 * 测试 focus-stores.ts 中的核心逻辑
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  blackBoxEntriesMap,
  pendingBlackBoxEntries,
  getTodayDate,
  getYesterdayDate,
  getDaysAgoDate,
  refreshGateReviewClock,
  resetFocusState,
} from '../../../state/focus-stores';
import type { BlackBoxEntry } from '../../../models/focus';
import { FOCUS_CONFIG } from '../../../config/focus.config';

describe('focus-stores', () => {
  beforeEach(() => {
    resetFocusState({ cleanupTodayDateInterval: true });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-01T12:00:00.000Z'));
    resetFocusState();
  });

  afterEach(() => {
    resetFocusState({ cleanupTodayDateInterval: true });
    vi.useRealTimers();
  });

  describe('pendingBlackBoxEntries', () => {
    /**
     * 创建测试用的 BlackBoxEntry
     */
    function createEntry(overrides: Partial<BlackBoxEntry> = {}): BlackBoxEntry {
      return {
        id: crypto.randomUUID(),
        projectId: 'test-project',
        userId: 'test-user',
        content: '测试内容',
        date: getYesterdayDate(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        isRead: false,
        isCompleted: false,
        isArchived: false,
        deletedAt: null,
        ...overrides,
      };
    }

    it('应该排除今天的条目', () => {
      const todayEntry = createEntry({ id: 'today-1', date: getTodayDate() });
      const yesterdayEntry = createEntry({ id: 'yesterday-1', date: getYesterdayDate() });

      blackBoxEntriesMap.set(new Map([
        [todayEntry.id, todayEntry],
        [yesterdayEntry.id, yesterdayEntry],
      ]));

      const pending = pendingBlackBoxEntries();
      
      expect(pending.length).toBe(1);
      expect(pending[0].id).toBe('yesterday-1');
    });

    it('应该在已读冷却期内排除已读但未完成的跨天条目', () => {
      const readEntry = createEntry({
        id: 'read-1',
        date: getYesterdayDate(),
        isRead: true,
        isCompleted: false,
        updatedAt: new Date(Date.now() - FOCUS_CONFIG.GATE.READ_REAPPEAR_COOLDOWN_MS + 1000).toISOString(),
      });

      blackBoxEntriesMap.set(new Map([
        [readEntry.id, readEntry],
      ]));

      const pending = pendingBlackBoxEntries();
      
      expect(pending.length).toBe(0);
    });

    it('应该在已读冷却到期后重新包含未完成的跨天条目', () => {
      const readEntry = createEntry({
        id: 'read-reappeared',
        date: getYesterdayDate(),
        isRead: true,
        isCompleted: false,
        updatedAt: new Date(Date.now() - FOCUS_CONFIG.GATE.READ_REAPPEAR_COOLDOWN_MS - 1000).toISOString(),
      });

      blackBoxEntriesMap.set(new Map([
        [readEntry.id, readEntry],
      ]));
      refreshGateReviewClock();

      const pending = pendingBlackBoxEntries();

      expect(pending.map(entry => entry.id)).toEqual(['read-reappeared']);
    });

    it('应该包含被跳过但已到期的条目', () => {
      const snoozedEntry = createEntry({
        id: 'snoozed-1',
        date: getDaysAgoDate(2),
        snoozeUntil: getYesterdayDate(), // 跳过至昨天，已到期
      });

      blackBoxEntriesMap.set(new Map([
        [snoozedEntry.id, snoozedEntry],
      ]));

      const pending = pendingBlackBoxEntries();
      
      expect(pending.length).toBe(1);
      expect(pending[0].id).toBe('snoozed-1');
    });

    it('应该排除被跳过且未到期的条目', () => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowStr = tomorrow.toISOString().split('T')[0];

      const snoozedEntry = createEntry({
        id: 'snoozed-future',
        date: getYesterdayDate(),
        snoozeUntil: tomorrowStr, // 跳过至明天，未到期
      });

      blackBoxEntriesMap.set(new Map([
        [snoozedEntry.id, snoozedEntry],
      ]));

      const pending = pendingBlackBoxEntries();
      
      expect(pending.length).toBe(0);
    });

    it('应该排除已完成的条目', () => {
      const completedEntry = createEntry({
        id: 'completed-1',
        date: getYesterdayDate(),
        isCompleted: true,
      });

      blackBoxEntriesMap.set(new Map([
        [completedEntry.id, completedEntry],
      ]));

      const pending = pendingBlackBoxEntries();
      
      expect(pending.length).toBe(0);
    });

    it('应该排除已归档的条目', () => {
      const archivedEntry = createEntry({
        id: 'archived-1',
        date: getYesterdayDate(),
        isArchived: true,
      });

      blackBoxEntriesMap.set(new Map([
        [archivedEntry.id, archivedEntry],
      ]));

      const pending = pendingBlackBoxEntries();
      
      expect(pending.length).toBe(0);
    });

    it('应该排除软删除的条目', () => {
      const deletedEntry = createEntry({
        id: 'deleted-1',
        date: getYesterdayDate(),
        deletedAt: new Date().toISOString(),
      });

      blackBoxEntriesMap.set(new Map([
        [deletedEntry.id, deletedEntry],
      ]));

      const pending = pendingBlackBoxEntries();
      
      expect(pending.length).toBe(0);
    });

    it('应该按创建时间正序排序（最早的排前面）', () => {
      const now = Date.now();
      const entry1 = createEntry({
        id: 'older',
        date: getYesterdayDate(),
        createdAt: new Date(now - 10000).toISOString(),
      });
      const entry2 = createEntry({
        id: 'newer',
        date: getYesterdayDate(),
        createdAt: new Date(now).toISOString(),
      });

      blackBoxEntriesMap.set(new Map([
        [entry2.id, entry2],
        [entry1.id, entry1],
      ]));

      const pending = pendingBlackBoxEntries();
      
      expect(pending.length).toBe(2);
      expect(pending[0].id).toBe('older');
      expect(pending[1].id).toBe('newer');
    });

    it('应该包含多天前的未完成条目', () => {
      const oldEntry = createEntry({
        id: 'old-1',
        date: getDaysAgoDate(7), // 7 天前
      });

      blackBoxEntriesMap.set(new Map([
        [oldEntry.id, oldEntry],
      ]));

      const pending = pendingBlackBoxEntries();
      
      expect(pending.length).toBe(1);
      expect(pending[0].id).toBe('old-1');
    });
  });

  describe('日期工具函数', () => {
    it('getTodayDate 应返回 YYYY-MM-DD 格式', () => {
      const today = getTodayDate();
      expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('getYesterdayDate 应返回昨天日期', () => {
      const yesterday = getYesterdayDate();
      const today = getTodayDate();
      
      expect(yesterday < today).toBe(true);
    });

    it('getDaysAgoDate 应返回正确的过去日期', () => {
      const threeDaysAgo = getDaysAgoDate(3);
      const today = getTodayDate();
      
      expect(threeDaysAgo < today).toBe(true);
    });
  });
});
