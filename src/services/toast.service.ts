import { Injectable, signal, computed, untracked } from '@angular/core';
import { TOAST_CONFIG } from '../config/ui.config';

/**
 * Toast 消息类型
 */
export type ToastType = 'success' | 'error' | 'warning' | 'info';

/**
 * Toast 操作按钮接口
 */
export interface ToastAction {
  label: string;
  /**
   * 点击回调。可以是同步函数（返回 void）或异步函数（返回 Promise）。
   * 当返回 Promise 时，按钮会显示 `pendingLabel`（如果提供）并禁用，
   * Promise 完成或 5 秒兜底超时后才 dismiss toast。
   */
  onClick: () => void | Promise<void>;
  /**
   * 点击后异步处理期间显示的标签（如 "正在刷新…"）。
   * 不提供时按钮文案保持 `label`，但仍会被禁用直到 onClick 完成。
   */
  pendingLabel?: string;
}

/**
 * Toast 选项接口
 */
export interface ToastOptions {
  duration?: number;
  action?: ToastAction;
}

/**
 * Toast 消息接口
 */
export interface ToastMessage {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
  duration: number;
  createdAt: number;
  action?: ToastAction;
}

/**
 * Toast 通知服务
 * 提供全局的错误/成功/警告/信息提示功能
 * 支持错误去重：相同错误在指定时间内不会重复显示
 */
@Injectable({
  providedIn: 'root'
})
export class ToastService {
  /** 当前显示的 Toast 消息列表 */
  private toasts = signal<ToastMessage[]>([]);
  /** Toast 自动关闭定时器，避免重复消息创建时出现信号反馈风暴 */
  private dismissTimers = new Map<string, ReturnType<typeof setTimeout>>();
  
  /** 只读的 Toast 消息列表 */
  readonly messages = computed(() => this.toasts());
  
  /** 是否有消息 */
  readonly hasMessages = computed(() => this.toasts().length > 0);
  
  /** 默认显示时间（毫秒） */
  private static readonly DEFAULT_DURATION: number = TOAST_CONFIG.DEFAULT_DURATION;
  private static readonly ERROR_DURATION: number = 8000;
  private static readonly MAX_TOASTS: number = 5;
  
  /** 
   * 通用去重缓存：记录最近显示的消息及其时间
   * key 格式: `${type}:${title}:${message}`
   */
  private recentMessages = new Map<string, number>();

  /**
   * 显示成功消息
   */
  success(title: string, message?: string, options?: ToastOptions | number): void {
    const opts = this.normalizeOptions(options);
    this.show('success', title, message, opts.duration ?? ToastService.DEFAULT_DURATION, opts.action);
  }

  /**
   * 显示错误消息
   * 支持去重：相同的 title+message 在 ERROR_DEDUP_INTERVAL 内只显示一次
   */
  error(title: string, message?: string, options?: ToastOptions | number): void {
    const opts = this.normalizeOptions(options);
    
    // 错误去重检查
    if (this.isDuplicate('error', title, message)) {
      return;
    }
    
    this.show('error', title, message, opts.duration ?? ToastService.ERROR_DURATION, opts.action);
  }
  
  /**
   * 检查消息是否在去重间隔内已显示过
   * @returns true 表示重复消息，应跳过显示
   */
  private isDuplicate(type: ToastType, title: string, message?: string): boolean {
    const dedupKey = `${type}:${title}:${message || ''}`;
    const now = Date.now();
    const lastShown = this.recentMessages.get(dedupKey);
    
    if (lastShown && (now - lastShown) < TOAST_CONFIG.ERROR_DEDUP_INTERVAL) {
      // 在去重间隔内，跳过显示
      return true;
    }
    
    // 记录显示时间
    this.recentMessages.set(dedupKey, now);
    
    // 清理过期的去重记录（避免内存泄漏）
    this.cleanupRecentMessages();
    
    return false;
  }
  
  /**
   * 清理过期的去重记录
   */
  private cleanupRecentMessages(): void {
    const now = Date.now();
    const expireThreshold = TOAST_CONFIG.ERROR_DEDUP_INTERVAL * 2;
    const expiredKeys: string[] = [];
    this.recentMessages.forEach((timestamp, key) => {
      if (now - timestamp > expireThreshold) {
        expiredKeys.push(key);
      }
    });
    expiredKeys.forEach(key => {
      this.recentMessages.delete(key);
    });
  }

  /**
   * 显示警告消息
   * 支持去重：相同的 title+message 在去重间隔内只显示一次
   */
  warning(title: string, message?: string, options?: ToastOptions | number): void {
    const opts = this.normalizeOptions(options);
    
    // 警告去重检查
    if (this.isDuplicate('warning', title, message)) {
      return;
    }
    
    this.show('warning', title, message, opts.duration ?? ToastService.DEFAULT_DURATION, opts.action);
  }

  /**
   * 显示信息消息
   */
  info(title: string, message?: string, options?: ToastOptions | number): void {
    const opts = this.normalizeOptions(options);
    this.show('info', title, message, opts.duration ?? ToastService.DEFAULT_DURATION, opts.action);
  }
  
  /**
   * 规范化选项参数（兼容旧的 duration 参数）
   */
  private normalizeOptions(options?: ToastOptions | number): ToastOptions {
    if (typeof options === 'number') {
      return { duration: options };
    }
    return options ?? {};
  }

  /**
   * 显示 Toast 消息
   * 支持消息合并：相同类型和标题的消息不会重复显示
   */
  private show(type: ToastType, title: string, message?: string, duration = ToastService.DEFAULT_DURATION, action?: ToastAction): void {
    // 检查是否已有相同的消息显示中（合并逻辑）
    const existingToast = untracked(() => this.toasts().find(
      t => t.type === type && t.title === title && t.message === message
    ));
    
    if (existingToast) {
      // 相同消息已存在：仅重置关闭计时，不再删除重建，避免 signal 反馈循环
      this.refreshDismissTimer(existingToast.id, duration);
      return;
    }
    
    const id = crypto.randomUUID();
    const toast: ToastMessage = {
      id,
      type,
      title,
      message,
      duration,
      createdAt: Date.now(),
      action
    };
    const evictedToastIds: string[] = [];

    this.toasts.update(current => {
      const updated = [...current, toast];
      // 限制最大数量，移除最旧的（保留错误消息优先级）
      if (updated.length > ToastService.MAX_TOASTS) {
        // 找到第一个非错误类型的消息移除
        const nonErrorIndex = updated.findIndex(t => t.type !== 'error');
        if (nonErrorIndex !== -1) {
          const [evicted] = updated.splice(nonErrorIndex, 1);
          if (evicted) {
            evictedToastIds.push(evicted.id);
          }
        } else {
          // 如果全是错误消息，移除最旧的（可能移除多条）
          const overflowCount = updated.length - ToastService.MAX_TOASTS;
          const evicted = updated.splice(0, overflowCount);
          for (const item of evicted) {
            evictedToastIds.push(item.id);
          }
        }
      }
      return updated;
    });
    for (const evictedToastId of evictedToastIds) {
      this.clearDismissTimer(evictedToastId);
    }

    this.refreshDismissTimer(id, duration);
  }

  /**
   * 安排/重置自动关闭计时器
   */
  private refreshDismissTimer(id: string, duration: number): void {
    this.clearDismissTimer(id);
    if (duration <= 0) {
      return;
    }
    const timer = setTimeout(() => {
      this.dismissTimers.delete(id);
      this.removeToastById(id);
    }, duration);
    this.dismissTimers.set(id, timer);
  }

  /**
   * 清理指定 Toast 的计时器
   */
  private clearDismissTimer(id: string): void {
    const timer = this.dismissTimers.get(id);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    this.dismissTimers.delete(id);
  }

  /**
   * 清理全部计时器
   */
  private clearAllDismissTimers(): void {
    this.dismissTimers.forEach(timer => {
      clearTimeout(timer);
    });
    this.dismissTimers.clear();
  }

  /**
   * 从消息列表移除指定 Toast（不处理计时器）
   */
  private removeToastById(id: string): void {
    this.toasts.update(current => current.filter(t => t.id !== id));
  }

  /**
   * 手动关闭指定 Toast
   */
  dismiss(id: string): void {
    this.clearDismissTimer(id);
    this.removeToastById(id);
  }

  /**
   * 关闭所有 Toast
   */
  dismissAll(): void {
    this.clearAllDismissTimers();
    this.toasts.set([]);
  }
}
