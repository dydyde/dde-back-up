/**
 * 专注模式状态管理
 * 
 * 使用 Angular Signals 进行细粒度更新
 * 与现有 stores.ts 架构保持一致
 * 
 * 【P3-04 架构说明】
 * 当前使用模块级 signal 模式（与 stores.ts 一致）。
 * 优势：简单直接、无需 DI 即可访问
 * 缺陷：测试隔离困难、生命周期无法由 Angular 管理
 * 
 * 迁移路径（未来 PR）：
 * 1. 创建 FocusStoreService (providedIn: 'root') 包含所有 signal/computed
 * 2. 消费者从 inject(FocusStoreService) 访问状态
 * 3. 测试中通过 TestBed.inject() mock 服务
 * 4. 使用 resetFocusState() 在测试间重置状态
 */

import { signal, computed } from '@angular/core';
import { 
  BlackBoxEntry, 
  BlackBoxDateGroup, 
  GateState, 
  FocusPreferences, 
  DEFAULT_FOCUS_PREFERENCES,
  StrataLayer
} from '../models/focus';
import { FOCUS_CONFIG } from '../config/focus.config';

// StrataItem 类型已从 focus 模型导出，供外部模块使用
export type { StrataItem } from '../models/focus';

// ============================================
// 日期工具函数
// ============================================

/**
 * 获取今天日期 YYYY-MM-DD
 */
export function getTodayDate(): string {
  return new Date().toISOString().split('T')[0];
}

/**
 * 【P3-03 修复】将今天日期作为信号，确保 pendingBlackBoxEntries 在跨天时自动更新。
 * 每 60 秒检查日期变化（极低开销），避免 computed 因 new Date() 非信号而过期。
 */
export const todayDate = signal(getTodayDate());
export const gateReviewClock = signal(Date.now());

/** 【P3-04】todayDate 定时器 ID，用于测试清理和 SSR 兼容 */
let todayDateIntervalId: ReturnType<typeof setInterval> | null = null;
let gateReviewClockIntervalId: ReturnType<typeof setInterval> | null = null;

function ensureTodayDateInterval(): void {
  if (typeof window === 'undefined' || todayDateIntervalId !== null) {
    return;
  }

  todayDateIntervalId = setInterval(() => {
    const now = getTodayDate();
    if (todayDate() !== now) todayDate.set(now);
  }, 60_000);
}

function ensureGateReviewClockInterval(): void {
  if (typeof window === 'undefined' || gateReviewClockIntervalId !== null) {
    return;
  }

  gateReviewClockIntervalId = setInterval(() => {
    refreshGateReviewClock();
  }, 60_000);
}

export function refreshGateReviewClock(now = Date.now()): void {
  gateReviewClock.set(now);
}

// 浏览器环境下定时刷新日期信号
ensureTodayDateInterval();
ensureGateReviewClockInterval();

/**
 * 【P3-04】清理 todayDate 定时器（用于测试 teardown 和 SSR）
 */
function cleanupTodayDateInterval(): void {
  if (todayDateIntervalId !== null) {
    clearInterval(todayDateIntervalId);
    todayDateIntervalId = null;
  }
}

function cleanupGateReviewClockInterval(): void {
  if (gateReviewClockIntervalId !== null) {
    clearInterval(gateReviewClockIntervalId);
    gateReviewClockIntervalId = null;
  }
}

/**
 * 获取昨天日期 YYYY-MM-DD
 */
export function getYesterdayDate(): string {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  return yesterday.toISOString().split('T')[0];
}

/**
 * 获取明天日期 YYYY-MM-DD
 */
export function getTomorrowDate(): string {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return tomorrow.toISOString().split('T')[0];
}

/**
 * 获取 N 天前的日期 YYYY-MM-DD
 */
export function getDaysAgoDate(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().split('T')[0];
}

// ============================================
// 黑匣子状态
// ============================================

/**
 * 黑匣子条目 Map - O(1) 查找
 * key: entryId
 * value: BlackBoxEntry
 */
export const blackBoxEntriesMap = signal<Map<string, BlackBoxEntry>>(new Map());

/**
 * 按日期索引的条目 ID 集合
 * key: date (YYYY-MM-DD)
 * value: Set<entryId>
 */
export const blackBoxEntriesByDate = signal<Map<string, Set<string>>>(new Map());

/**
 * 黑匣子条目列表（从 Map 派生）
 */
export const blackBoxEntries = computed(() => 
  Array.from(blackBoxEntriesMap().values())
    .filter(e => !e.deletedAt)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
);

/** 条目仓可见集合：已读仍保留，完成/归档后才离开条目仓。 */
export const unresolvedBlackBoxEntries = computed(() =>
  blackBoxEntries().filter(e => !e.isArchived && !e.isCompleted)
);

/** 条目仓 badge 计数，不复用 Gate 待处理队列。 */
export const unresolvedBlackBoxCount = computed(() => unresolvedBlackBoxEntries().length);

/**
 * 按日期分组的黑匣子条目
 */
export const blackBoxEntriesGroupedByDate = computed<BlackBoxDateGroup[]>(() => {
  const entries = unresolvedBlackBoxEntries();
  const groups = new Map<string, BlackBoxEntry[]>();
  
  for (const entry of entries) {
    const existing = groups.get(entry.date) || [];
    existing.push(entry);
    groups.set(entry.date, existing);
  }
  
  return Array.from(groups.entries())
    .map(([date, entries]) => ({ 
      date, 
      entries: entries.sort((a, b) => 
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      )
    }))
    .sort((a, b) => b.date.localeCompare(a.date));
});

/**
 * 待处理的黑匣子条目（用于大门）
 * 
 * 逻辑（更新后）：
 * - 只显示**今天之前**的条目（排除当天录入）
 * - 已读代表本轮 Gate 已经裁决过，先缄默 READ_REAPPEAR_COOLDOWN_MS
 * - 缄默期到期但未完成的跨天条目会重新间歇出现
 * 
 * 用户需求：只提醒"除了今天以外"且尚未完成的录入内容；已读只做短时缄默，不等于完成。
 */
export const pendingBlackBoxEntries = computed(() => {
  const entries = Array.from(blackBoxEntriesMap().values());
  const today = todayDate(); // 使用信号确保跨天自动更新
  const now = gateReviewClock();
  const readCooldownCutoff = now - FOCUS_CONFIG.GATE.READ_REAPPEAR_COOLDOWN_MS;
  
  return entries.filter(e => {
    // 已归档或软删除的不显示
    if (e.isArchived || e.deletedAt) return false;
    
    // 已完成的不显示
    if (e.isCompleted) return false;

    // 已读不是完成：只在冷却期内静默，之后继续间歇提醒用户落地或完成。
    if (e.isRead) {
      const readAt = Date.parse(e.updatedAt || e.createdAt);
      if (!Number.isFinite(readAt) || readAt > readCooldownCutoff) return false;
    }
    
    // 被跳过且未到提醒日期的不显示
    if (e.snoozeUntil && e.snoozeUntil > today) return false;
    
    // 排除今天的条目 - 今天录入的不在大门中提醒
    if (e.date >= today) {
      return false;
    }
    
    // 今天之前的条目：未读且未完成才显示
    return true;
  }).sort((a, b) => 
    new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );
});

/**
 * 未读条目数量
 */
export const unreadBlackBoxCount = computed(() => 
  blackBoxEntries().filter(e => !e.isRead && !e.isArchived && !e.isCompleted).length
);

/**
 * 待处理条目数量（用于大门显示）
 */
// ============================================
// 大门状态
// ============================================

/**
 * 大门状态
 */
export const gateState = signal<GateState>('checking');

/**
 * 大门待处理条目列表
 */
export const gatePendingItems = signal<BlackBoxEntry[]>([]);

/**
 * 大门当前条目索引
 */
export const gateCurrentIndex = signal<number>(0);

/**
 * 当日跳过次数
 */
export const gateSnoozeCount = signal<number>(0);

/**
 * 大门当前条目
 */
export const gateCurrentEntry = computed<BlackBoxEntry | null>(() => {
  const items = gatePendingItems();
  const index = gateCurrentIndex();
  return items[index] ?? null;
});

/**
 * 大门进度 (当前索引 + 1) / 总数
 */
export const gateProgress = computed(() => {
  const total = gatePendingItems().length;
  if (total === 0) return { current: 0, total: 0 };
  return {
    current: gateCurrentIndex() + 1,
    total
  };
});

/**
 * 是否可以跳过（未达每日上限）
 */
export const canSnooze = computed(() => {
  const preferences = focusPreferences();
  return gateSnoozeCount() < preferences.maxSnoozePerDay;
});

/**
 * 大门是否激活
 */
export const isGateActive = computed(() => 
  gateState() === 'reviewing'
);

// ============================================
// 地质层状态
// ============================================

/**
 * 地质层数据（按日分层）
 */
export const strataLayers = signal<StrataLayer[]>([]);

/**
 * 今日完成项目数
 */
export const todayCompletedCount = computed(() => {
  const today = getTodayDate();
  const layers = strataLayers();
  const todayLayer = layers.find(l => l.date === today);
  return todayLayer?.items.length ?? 0;
});

// ============================================
// 用户偏好
// ============================================

/**
 * 专注模式偏好设置
 */
export const focusPreferences = signal<FocusPreferences>(DEFAULT_FOCUS_PREFERENCES);

// ============================================
// 录音状态
// ============================================

/**
 * 是否正在录音
 */
export const isRecording = signal<boolean>(false);

/**
 * 当前录音已持续的秒数。
 * 【根因修复 2026-04-20】BlackBoxRecorderComponent 可能有多个实例（侧边栏 + mobile-black-box-drawer），
 * 过去在组件内各自维护 setInterval 与 recordingDuration 信号，当用户在实例 A 按下开始录音时，
 * 实例 B 的 isRecording 同步变 true 并渲染「录音中...」，但实例 B 的本地 timer 从未启动，导致
 * 计时器卡在 0:00。将时长提升为服务层单例信号，所有渲染实例消费同一数据源。
 */
export const recordingDurationSec = signal<number>(0);

/**
 * 是否正在转写
 */
export const isTranscribing = signal<boolean>(false);

/**
 * 转写错误信息
 */
export const transcriptionError = signal<string | null>(null);

/**
 * 离线待处理录音数量
 */
export const offlinePendingCount = signal<number>(0);

/**
 * 今日剩余配额
 * 初始值与 FOCUS_CONFIG.SPEECH_TO_TEXT.DAILY_QUOTA 保持一致
 */
export const remainingQuota = signal<number>(FOCUS_CONFIG.SPEECH_TO_TEXT.DAILY_QUOTA);

// ============================================
// UI 状态
// ============================================

/**
 * 是否显示黑匣子面板
 */
export const showBlackBoxPanel = signal<boolean>(false);

// ============================================
// 辅助方法
// ============================================

/**
 * 更新黑匣子条目
 */
export function updateBlackBoxEntry(entry: BlackBoxEntry): void {
  blackBoxEntriesMap.update(map => {
    const newMap = new Map(map);
    newMap.set(entry.id, entry);
    return newMap;
  });
  
  // 【P2-06 修复】创建新 Set 而非原地修改现有 Set
  blackBoxEntriesByDate.update(dateMap => {
    const newDateMap = new Map(dateMap);
    const existingSet = newDateMap.get(entry.date);

    if (entry.deletedAt) {
      if (existingSet) {
        const nextSet = new Set(existingSet);
        nextSet.delete(entry.id);
        if (nextSet.size === 0) {
          newDateMap.delete(entry.date);
        } else {
          newDateMap.set(entry.date, nextSet);
        }
      }
      return newDateMap;
    }

    const dateSet = existingSet ? new Set(existingSet) : new Set<string>();
    dateSet.add(entry.id);
    newDateMap.set(entry.date, dateSet);
    return newDateMap;
  });
}

/**
 * 批量设置黑匣子条目
 */
export function setBlackBoxEntries(entries: BlackBoxEntry[]): void {
  const entriesMap = new Map<string, BlackBoxEntry>();
  const dateMap = new Map<string, Set<string>>();
  
  for (const entry of entries) {
    entriesMap.set(entry.id, entry);
    if (entry.deletedAt) {
      continue;
    }
    
    const dateSet = dateMap.get(entry.date) || new Set();
    dateSet.add(entry.id);
    dateMap.set(entry.date, dateSet);
  }
  
  blackBoxEntriesMap.set(entriesMap);
  blackBoxEntriesByDate.set(dateMap);
}

/**
 * 删除黑匣子条目（软删除）
 */
export function deleteBlackBoxEntry(id: string): void {
  blackBoxEntriesMap.update(map => {
    const newMap = new Map(map);
    const entry = newMap.get(id);
    if (entry) {
      newMap.set(id, { ...entry, deletedAt: new Date().toISOString() });
    }
    return newMap;
  });
  
  // 【P2-05 修复】同步更新日期索引，从日期分组中移除已删除的条目
  const entry = blackBoxEntriesMap().get(id);
  if (entry?.date) {
    blackBoxEntriesByDate.update(dateMap => {
      const newDateMap = new Map(dateMap);
      const existingSet = newDateMap.get(entry.date);
      if (existingSet) {
        const newSet = new Set(existingSet);
        newSet.delete(id);
        if (newSet.size === 0) {
          newDateMap.delete(entry.date);
        } else {
          newDateMap.set(entry.date, newSet);
        }
      }
      return newDateMap;
    });
  }
}

/**
 * 重置大门状态
 */
export function resetGateState(): void {
  gateState.set('checking');
  gatePendingItems.set([]);
  gateCurrentIndex.set(0);
  gateSnoozeCount.set(0);
}

/**
 * 重置所有专注模式状态。
 * 默认保留运行时的跨天刷新定时器；测试如需彻底 teardown，可显式要求清理。
 */
export function resetFocusState(options: { cleanupTodayDateInterval?: boolean } = {}): void {
  blackBoxEntriesMap.set(new Map());
  blackBoxEntriesByDate.set(new Map());
  resetGateState();
  strataLayers.set([]);
  focusPreferences.set(DEFAULT_FOCUS_PREFERENCES);
  isRecording.set(false);
  isTranscribing.set(false);
  transcriptionError.set(null);
  recordingDurationSec.set(0);
  offlinePendingCount.set(0);
  remainingQuota.set(50);
  showBlackBoxPanel.set(false);
  if (options.cleanupTodayDateInterval) {
    cleanupTodayDateInterval();
    cleanupGateReviewClockInterval();
  } else {
    ensureTodayDateInterval();
    ensureGateReviewClockInterval();
  }
  todayDate.set(getTodayDate());
  refreshGateReviewClock();
}
