/**
 * 地质层服务
 * 
 * 负责已完成任务的堆叠可视化（沉积岩层设计）
 * 整合黑匣子完成条目和任务系统完成任务
 * 
 * 设计语义：
 * - 每一天的已完成事件 = 一层"沉积岩"
 * - 层的高度 = 该天有完成事件的天数计为 1 天（许多事件也算一天）
 * - 层的颜色 = 根据时间距离从 amber → cyan → slate → zinc → obsidian 渐变
 * - 层的阶梯感 = 越旧的层越薄、越暗，形成地质钻芯效果
 */

import { Injectable, inject, computed } from '@angular/core';
import { StrataItem, StrataLayer } from '../models/focus';
import { FOCUS_CONFIG } from '../config/focus.config';
import { BlackBoxService } from './black-box.service';
import { ProjectStateService } from './project-state.service';
import { LoggerService } from './logger.service';
import { resolveTaskCompletionTimestamp } from '../utils/task-completion-time';
import {
  strataLayers,
  todayCompletedCount,
  blackBoxEntriesMap,
} from '../state/focus-stores';

/** 沉积岩层颜色分级（从新到旧） */
export interface StrataColorTier {
  /** 背景色 CSS 类 */
  bgClass: string;
  /** 左侧边框色 CSS 类 */
  borderClass: string;
  /** 文字色 CSS 类 */
  textClass: string;
  /** 副文字色 CSS 类 */
  subTextClass: string;
  /** 分隔线色 CSS 类 */
  lineClass: string;
}

/**
 * 沉积岩层的显示分级：化石质感配色
 * 设计原则：整体暗沉、低饱和度，模拟岩石断面中矿物氧化后的暗淡色泽
 * 时间越远颜色越冷越暗，最终趋近纯黑
 */
const STRATA_COLOR_TIERS: StrataColorTier[] = [
  // Tier 0: 今天 — 暗琥珀（矿化琥珀，非鲜亮）
  { bgClass: 'bg-amber-900/60 dark:bg-amber-950/70', borderClass: 'border-l-amber-700/50', textClass: 'text-amber-200/80 dark:text-amber-300/70', subTextClass: 'text-amber-300/40 dark:text-amber-400/30', lineClass: 'bg-amber-700/25' },
  // Tier 1: 昨天 — 暗青铜（氧化铜绿，低饱和）
  { bgClass: 'bg-teal-900/50 dark:bg-teal-950/60', borderClass: 'border-l-teal-700/40', textClass: 'text-teal-300/70 dark:text-teal-300/60', subTextClass: 'text-teal-400/30 dark:text-teal-400/25', lineClass: 'bg-teal-700/20' },
  // Tier 2: 2-3天前 — 深石板（页岩质感）
  { bgClass: 'bg-stone-800/60 dark:bg-stone-900/70', borderClass: 'border-l-stone-600/35', textClass: 'text-stone-400/70 dark:text-stone-400/60', subTextClass: 'text-stone-500/35 dark:text-stone-500/25', lineClass: 'bg-stone-600/15' },
  // Tier 3: 4-6天前 — 深炭灰（Graphite）
  { bgClass: 'bg-neutral-800/55 dark:bg-neutral-900/65', borderClass: 'border-l-neutral-700/25', textClass: 'text-neutral-500/60 dark:text-neutral-500/50', subTextClass: 'text-neutral-600/25 dark:text-neutral-600/20', lineClass: 'bg-neutral-700/12' },
  // Tier 4: 7天+ — 近黑色（黑曜石化石）
  { bgClass: 'bg-zinc-900/50 dark:bg-zinc-950/60', borderClass: 'border-l-zinc-800/20', textClass: 'text-zinc-600/50 dark:text-zinc-600/40', subTextClass: 'text-zinc-700/20 dark:text-zinc-700/15', lineClass: 'bg-zinc-800/10' },
];

@Injectable({
  providedIn: 'root'
})
export class StrataService {
  private blackBoxService = inject(BlackBoxService);
  private projectState = inject(ProjectStateService);
  private logger = inject(LoggerService);
  
  // 暴露状态给组件
  readonly layers = strataLayers;
  readonly todayCount = todayCompletedCount;
  
  /**
   * 总完成数量
   */
  readonly totalCount = computed(() => {
    return strataLayers().reduce((sum, layer) => sum + layer.items.length, 0);
  });

  /**
   * 总完成天数（有完成事件的不同日期数）
   */
  readonly totalDays = computed(() => strataLayers().length);
  
  /**
   * 刷新地质层数据
   * 整合已完成任务 + 黑匣子条目
   */
  refresh(): void {
    const config = FOCUS_CONFIG.STRATA;
    const layers: StrataLayer[] = [];
    const anchorDate = this.getLatestCompletedLocalDate() ?? this.getLocalDaysAgo(0);

    for (let i = 0; i < config.MAX_DISPLAY_DAYS; i++) {
      // 以最后完成日为沉积剖面的 0 层，避免自然日期推进导致历史层跳动
      const date = this.getLocalDaysBefore(anchorDate, i);
      const items = this.getItemsForDate(date);

      if (items.length > 0) {
        // 计算透明度：越旧越透明
        const opacity = Math.max(
          config.MIN_OPACITY,
          1 - (i * config.OPACITY_DECAY)
        );
        
        layers.push({
          date,
          items,
          opacity
        });
      }
    }
    
    strataLayers.set(layers);
    this.logger.debug('Strata', `Strata layers refreshed: ${layers.length} layers`);
  }
  
  /**
   * 获取指定日期的完成项目
   * 整合黑匣子完成条目 + 已完成任务
   */
  private getItemsForDate(date: string): StrataItem[] {
    const blackBoxItems = this.getBlackBoxItemsForDate(date);
    const taskItems = this.getCompletedTasksForDate(date);
    return [...blackBoxItems, ...taskItems].sort((a, b) => this.compareItemsByCompletion(a, b));
  }

  /**
   * 获取指定日期已完成的任务
    * 优先使用 completedAt；旧数据只在 completed_at 字段上线前才把 updatedAt 当完成时间代理。
   */
  private getCompletedTasksForDate(date: string): StrataItem[] {
    return this.projectState.tasks()
      .filter(t => {
        if (t.status !== 'completed' || t.deletedAt) return false;
        const timestamp = this.getTaskCompletionTimestamp(t);
        if (!timestamp) return false;
        return this.getLocalDate(timestamp) === date;
      })
      .map(t => {
        const timestamp = this.getTaskCompletionTimestamp(t) ?? t.createdDate;
        return {
          type: 'task' as const,
          id: t.id,
          title: (t.title || t.content || '').slice(0, 100),
          completedAt: timestamp,
          source: t
        };
      });
  }
  
  /**
   * 获取指定日期完成的黑匣子条目
   */
  private getBlackBoxItemsForDate(date: string): StrataItem[] {
    return Array.from(blackBoxEntriesMap().values())
      .flatMap(entry => {
        if (!entry.isCompleted || entry.deletedAt) return [];

        const completedAt = this.getBlackBoxCompletionTimestamp(entry);
        if (this.getLocalDate(completedAt) !== date) return [];

        return [{
          type: 'black_box' as const,
          id: entry.id,
          title: (entry.content || '').slice(0, 100),
          completedAt,
          source: entry,
        }];
      });
  }

  private getBlackBoxCompletionTimestamp(entry: { completedAt?: string | null; date: string; createdAt: string }): string {
    if (typeof entry.completedAt === 'string' && entry.completedAt.trim().length > 0) {
      return entry.completedAt;
    }

    if (this.getLocalDate(entry.createdAt) === entry.date) return entry.createdAt;
    return `${entry.date}T00:00:00.000`;
  }

  private getTaskCompletionTimestamp(task: { completedAt?: string | null; updatedAt?: string; createdDate?: string | null }): string | undefined {
    // completed_at 上线后的 updatedAt 是同步时钟，数据修复或重试会 bump，不能再驱动历史层日期。
    return resolveTaskCompletionTimestamp(task) ?? undefined;
  }

  private compareItemsByCompletion(a: StrataItem, b: StrataItem): number {
    const timeDiff = this.getTimestampMillis(b.completedAt) - this.getTimestampMillis(a.completedAt);
    if (timeDiff !== 0) return timeDiff;
    const typeDiff = a.type.localeCompare(b.type);
    if (typeDiff !== 0) return typeDiff;
    return a.id.localeCompare(b.id);
  }

  private getTimestampMillis(timestamp: string): number {
    const value = new Date(timestamp).getTime();
    if (Number.isNaN(value)) {
      this.logger.warn('Strata', '完成时间无法解析，使用稳定兜底排序', { timestamp });
      return 0;
    }
    return value;
  }

  private getLatestCompletedLocalDate(): string | null {
    const dates = [
      ...this.projectState.tasks()
        .filter(t => t.status === 'completed' && !t.deletedAt)
        .map(t => this.getTaskCompletionTimestamp(t))
        .filter((timestamp): timestamp is string => Boolean(timestamp))
        .map(timestamp => this.getLocalDate(timestamp)),
      ...Array.from(blackBoxEntriesMap().values())
        .filter(e => e.isCompleted && !e.deletedAt)
        .map(entry => this.getLocalDate(this.getBlackBoxCompletionTimestamp(entry))),
    ];
    return dates.sort((a, b) => b.localeCompare(a))[0] ?? null;
  }
  
  /**
   * 从 ISO 时间戳提取本地日期 YYYY-MM-DD
   * 修复时区问题：UTC+8 用户在晚间完成的任务不会被误归到 UTC 的"次日"
   */
  private getLocalDate(timestamp: string): string {
    try {
      const d = new Date(timestamp);
      if (isNaN(d.getTime())) return timestamp.split('T')[0];
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    } catch {
      // 降级：截取 ISO 字符串日期部分
      return timestamp.split('T')[0];
    }
  }

  /**
   * 获取 N 天前的本地日期 YYYY-MM-DD
   * 与 getLocalDate 保持时区一致性
   */
  private getLocalDaysAgo(days: number): string {
    const d = new Date();
    d.setDate(d.getDate() - days);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private getLocalDaysBefore(anchorDate: string, days: number): string {
    const d = this.parseLocalDate(anchorDate);
    d.setDate(d.getDate() - days);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  
  /**
   * 获取今日完成项目
   */
  getTodayItems(): StrataItem[] {
    const today = this.getLocalDaysAgo(0);
    return this.getItemsForDate(today);
  }
  
  /**
   * 获取本周完成数量
   */
  getWeeklyCount(): number {
    let count = 0;
    for (let i = 0; i < 7; i++) {
      const date = this.getLocalDaysAgo(i);
      count += this.getItemsForDate(date).length;
    }
    return count;
  }
  
  /**
   * 获取特定层
   */
  getLayer(date: string): StrataLayer | undefined {
    return strataLayers().find(l => l.date === date);
  }
  
  /**
   * 获取层的显示标签
   */
  getLayerLabel(date: string): string {
    const yesterday = this.getLocalDaysAgo(1);
    const anchorDate = this.getLatestCompletedLocalDate();

    // 最后完成日始终显示具体日期，配合标尺「那日」表达回看锚点
    if (date === anchorDate) return this.formatDateLabel(date);
    if (date === yesterday) return '昨日';
    return this.formatDateLabel(date);
  }

  /**
   * 计算某个日期距今的天数
   */
  getDaysAgo(date: string): number {
    const anchorDate = this.getLatestCompletedLocalDate() ?? this.getLocalDaysAgo(0);
    const today = this.parseLocalDate(anchorDate);
    const target = this.parseLocalDate(date);
    return Math.round((today.getTime() - target.getTime()) / (1000 * 60 * 60 * 24));
  }

  /**
   * 深度标尺标签（用天数替代示例中的米数）
   * 0d → 那日, 1d → 1天, 7d → 1周, 14d → 2周, 30d → 1月
   */
  getDepthLabel(date: string): string {
    const days = this.getDaysAgo(date);
    if (days === 0) return '那日';
    if (days === 1) return '1天';
    if (days < 7) return `${days}天`;
    if (days === 7) return '1周';
    if (days < 14) return `${days}天`;
    if (days === 14) return '2周';
    if (days < 30) return `${days}天`;
    if (days === 30) return '1月';
    return `${days}天`;
  }

  /**
   * 判断标尺刻度是否为主刻度（较长的线条）
   * 主刻度：今天、7天（1周）、14天（2周）、30天（1月）
   */
  isMajorTick(date: string): boolean {
    const days = this.getDaysAgo(date);
    return days === 0 || days === 7 || days === 14 || days === 21 || days === 30;
  }
  
  /**
   * 获取层的颜色分级（沉积岩层设计）
   * 根据距今的天数，颜色从 amber → cyan → slate → zinc → obsidian 渐变
   */
  getColorTier(index: number): StrataColorTier {
    if (index === 0) return STRATA_COLOR_TIERS[0]; // 今天: 琥珀
    if (index === 1) return STRATA_COLOR_TIERS[1]; // 昨天: 青色
    if (index <= 3) return STRATA_COLOR_TIERS[2];  // 2-3天: 石板灰
    if (index <= 6) return STRATA_COLOR_TIERS[3];  // 4-6天: 锌灰
    return STRATA_COLOR_TIERS[4];                   // 7天+: 黑曜石
  }

  /**
   * 获取层的颜色类（向后兼容 API）
   */
  getLayerColorClass(index: number): string {
    return this.getColorTier(index).bgClass;
  }

  /**
   * 获取层的显示高度样式（px）
   * 设计规则：
   * - 今天的层最高（64-160px），根据事件数量伸缩
   * - 近期层中等高度（40-96px）
   * - 历史压缩层（12-48px），越远越薄
   * - 极远的古老层 ≤ 6px，形成化石般的薄线
   */
  getLayerHeight(layer: StrataLayer, index: number): number {
    const itemCount = layer.items.length;
    
    if (index === 0) {
      // 今天：基础 64px，每多一项 +16px，最大 160px
      return Math.min(160, 64 + (itemCount - 1) * 16);
    }
    if (index === 1) {
      // 昨天：基础 48px，每多一项 +12px，最大 96px
      return Math.min(96, 48 + (itemCount - 1) * 12);
    }
    if (index <= 3) {
      // 2-3 天前：基础 32px，每多一项 +8px，最大 64px
      return Math.min(64, 32 + (itemCount - 1) * 8);
    }
    if (index <= 6) {
      // 4-6 天前：基础 16px，每多一项 +4px，最大 40px
      return Math.min(40, 16 + (itemCount - 1) * 4);
    }
    if (index <= 13) {
      // 7-13 天前：基础 8px，每多一项 +2px，最大 20px
      return Math.min(20, 8 + (itemCount - 1) * 2);
    }
    // 14 天+：极度压缩，3-8px
    return Math.min(8, 3 + Math.min(itemCount, 3));
  }
  
  // ========== 测试兼容方法 ==========
  
  /**
   * 加载层（测试兼容方法，等同于 refresh）
   */
  async loadLayers(): Promise<void> {
    this.refresh();
  }
  
  /**
   * 添加项目到对应日期的层
   */
  addItem(item: StrataItem): void {
    // 【修复 P4-15】统一使用 getLocalDate 避免时区不一致
    const date = this.getLocalDate(item.completedAt);
    const layers = strataLayers();
    const existingLayer = layers.find(l => l.date === date);
    
    if (existingLayer) {
      // 更新现有层
      strataLayers.set(
        layers.map(l => 
          l.date === date 
            ? { ...l, items: [...l.items, item] }
            : l
        )
      );
    } else {
      // 创建新层
      const newLayer: StrataLayer = {
        date,
        items: [item],
        opacity: 1,
        collapsed: false
      };
      strataLayers.set([newLayer, ...layers]);
    }
  }
  
  /**
   * 计算层的透明度
   */
  getLayerOpacity(layer: StrataLayer): number {
    const config = FOCUS_CONFIG.STRATA;
    const today = this.getLatestCompletedLocalDate() ?? this.getLocalDaysAgo(0);
    const daysDiff = Math.floor(
      (this.parseLocalDate(today).getTime() - this.parseLocalDate(layer.date).getTime()) / (1000 * 60 * 60 * 24)
    );
    // 【修复 P4-05】上限 clamp 到 1，防止 daysDiff 为负时超 1
    return Math.min(1, Math.max(config.MIN_OPACITY, 1 - (daysDiff * config.OPACITY_DECAY)));
  }

  private parseLocalDate(date: string): Date {
    const [year, month, day] = date.split('-').map(Number);
    if (!year || !month || !day) {
      this.logger.warn('Strata', '本地日期格式异常，降级使用 Date 解析', { date });
      return new Date(date);
    }
    return new Date(year, month - 1, day);
  }

  private formatDateLabel(date: string): string {
    const d = this.parseLocalDate(date);
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  }
  
  /**
   * 获取所有项目总数（方法版本）
   */
  getTotalCount(): number {
    return this.totalCount();
  }
  
  /**
   * 清除超过保留天数的旧层
   */
  clearOldLayers(retentionDays: number): void {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
    // 【修复 P4-04】使用本地日期替代 UTC，与 getLocalDate 保持一致
    const year = cutoffDate.getFullYear();
    const month = String(cutoffDate.getMonth() + 1).padStart(2, '0');
    const day = String(cutoffDate.getDate()).padStart(2, '0');
    const cutoffDateStr = `${year}-${month}-${day}`;
    
    strataLayers.set(
      strataLayers().filter(l => l.date >= cutoffDateStr)
    );
  }
  
  /**
   * 切换层的折叠状态
   */
  collapseLayer(date: string): void {
    strataLayers.set(
      strataLayers().map(l => 
        l.date === date 
          ? { ...l, collapsed: !l.collapsed }
          : l
      )
    );
  }
}
