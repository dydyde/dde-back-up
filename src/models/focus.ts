// ============================================
// 专注模式数据模型定义
// ============================================

import { FOCUS_CONFIG } from '../config/focus.config';
import { PARKING_CONFIG } from '../config/parking.config';
import type { Task } from './core-types';

/**
 * 黑匣子条目状态
 */
export type BlackBoxSyncStatus = 'pending' | 'synced' | 'conflict';

export interface BlackBoxFocusMeta {
  source: 'focus-console-inline';
  sessionId: string;
  title: string;
  detail: string | null;
  lane: 'combo-select' | 'backup';
  expectedMinutes: number | null;
  waitMinutes: number | null;
  cognitiveLoad: 'high' | 'low';
  dockEntryId: string;
}

/**
 * 黑匣子条目
 * 语音转写后的文本记录，用于紧急捕捉想法
 */
export interface BlackBoxEntry {
  /** UUID - 必须由客户端 crypto.randomUUID() 生成 */
  id: string;
  /** 所属项目 ID */
  projectId: string | null;
  /** 所属用户 ID */
  userId: string;
  
  // 内容
  /** 转写文本内容 */
  content: string;
  
  // 时间
  /** YYYY-MM-DD 格式，用于按日分组 */
  date: string;
  /** ISO 时间戳 */
  createdAt: string;
  /** 最后更新时间戳，LWW 关键字段 */
  updatedAt: string;
  /** 完成状态首次落地时间，用于地质层按完成日稳定分组 */
  completedAt?: string | null;
  
  // 状态
  /** 是否已读 */
  isRead: boolean;
  /** 是否已完成 */
  isCompleted: boolean;
  /** 是否已归档 */
  isArchived: boolean;
  
  // 跳过/稍后提醒
  /** 跳过至该日期（YYYY-MM-DD） */
  snoozeUntil?: string;
  /** 已跳过次数 */
  snoozeCount?: number;
  
  // 软删除
  /** 软删除时间戳，null 表示未删除 */
  deletedAt: string | null;
  
  // 离线同步元数据
  /** 同步状态 */
  syncStatus?: BlackBoxSyncStatus;
  /** 本地创建时间（用于离线排序） */
  localCreatedAt?: string;
  
  // 元数据
  /** 原始音频时长（秒），转写后删除音频 */
  originalAudioDuration?: number;
  focusMeta?: BlackBoxFocusMeta | null;
}

/**
 * 按日期分组的黑匣子条目
 */
export interface BlackBoxDateGroup {
  /** YYYY-MM-DD */
  date: string;
  /** 该日期的条目列表 */
  entries: BlackBoxEntry[];
}

/**
 * 大门状态机
 */
export type GateState = 
  | 'checking'      // 检查是否有遗留条目
  | 'reviewing'     // 展示遗留条目中
  | 'completed'     // 全部处理完毕
  | 'bypassed'      // 无遗留条目，直接通过
  | 'disabled';     // 用户禁用大门功能

/**
 * 专注模式用户偏好
 */
export interface FocusPreferences {
  /** 是否启用大门（默认 true） */
  gateEnabled: boolean;
  /** 是否启用地质层 */
  strataEnabled: boolean;
  /** 是否启用黑匣子 */
  blackBoxEnabled: boolean;
  /** 每日最大跳过次数（默认 3） */
  maxSnoozePerDay: number;
  /** 日常任务本地重置小时（0-23，默认 0 = 零点） */
  routineResetHourLocal: number;
  /** 高负荷累计专注多久后给休息轻提醒 */
  restReminderHighLoadMinutes: number;
  /** 低负荷累计专注多久后给休息轻提醒 */
  restReminderLowLoadMinutes: number;
}

/**
 * 默认专注模式偏好
 * 默认值从 FOCUS_CONFIG 派生，避免重复硬编码
 * @see FOCUS_CONFIG.GATE.MAX_SNOOZE_PER_DAY
 */
export const DEFAULT_FOCUS_PREFERENCES: FocusPreferences = {
  gateEnabled: true,
  strataEnabled: true,
  blackBoxEnabled: true,
  maxSnoozePerDay: FOCUS_CONFIG.GATE.MAX_SNOOZE_PER_DAY,
  routineResetHourLocal: 0,
  restReminderHighLoadMinutes: Math.floor(PARKING_CONFIG.REST_REMINDER_HIGH_LOAD_THRESHOLD_MS / 60_000),
  restReminderLowLoadMinutes: Math.floor(PARKING_CONFIG.REST_REMINDER_LOW_LOAD_THRESHOLD_MS / 60_000),
};

/**
 * 地质层项目（整合黑匣子和任务）
 */
export interface StrataItem {
  /** 来源类型 */
  type: 'black_box' | 'task';
  /** 唯一标识符 */
  id: string;
  /** 显示标题 */
  title: string;
  /** 完成时间 */
  completedAt: string;
  /** 原始数据源（可选，用于详情展示） */
  source?: BlackBoxEntry | Task | Record<string, unknown>;
}

/**
 * 地质层按日分层
 */
export interface StrataLayer {
  /** YYYY-MM-DD */
  date: string;
  /** 该日完成的项目 */
  items: StrataItem[];
  /** 透明度（0-1） */
  opacity: number;
  /** 是否折叠 */
  collapsed?: boolean;
}

/**
 * 离线音频缓存条目
 */
export interface OfflineAudioCacheEntry {
  /** UUID */
  id: string;
  /** 缓存归属用户 ID；仅允许回放到同一账号 */
  ownerUserId: string | null;
  /** 音频 Blob */
  blob: Blob;
  /** 创建时间 */
  createdAt: string;
  /** MIME 类型 */
  mimeType: string;
  /** 所属项目 ID */
  projectId?: string;
}
