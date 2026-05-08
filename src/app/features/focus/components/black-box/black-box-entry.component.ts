/**
 * 黑匣子条目组件
 *
 * 显示单个黑匣子条目
 */

import {
  Component,
  ChangeDetectionStrategy,
  input,
  output,
  HostListener
} from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { BlackBoxEntry } from '../../../../../models';
import { AUTH_CONFIG } from '../../../../../config/auth.config';

@Component({
  selector: 'app-black-box-entry',
  standalone: true,
  imports: [CommonModule, DatePipe],
  template: `
    <div
      class="group mb-1.5 p-2 rounded-lg transition-all duration-150"
      [class]="entryShellClass()"
      [class.opacity-50]="entry().isRead && !entry().isCompleted"
      [class.line-through]="entry().isCompleted"
      [attr.data-entry-id]="entry().id"
      data-testid="black-box-entry"
      tabindex="0"
      role="article"
      [attr.aria-label]="'黑匣子条目: ' + (entry().content || '').slice(0, 50)">

      <!-- 内容 -->
      <p class="text-xs leading-relaxed break-words" [class]="contentClass()">
        {{ entry().content || '' }}
      </p>

      <!-- 底部栏 -->
      <div class="mt-1.5 flex items-center justify-between">
        <!-- 时间戳 -->
        <span class="text-[10px] font-mono" [class]="timeClass()">
          {{ entry().createdAt | date:'HH:mm' }}
        </span>

        <!-- 同步状态指示 -->
        @if (shouldShowSyncPendingIndicator()) {
          <span class="text-[9px]" [class]="syncPendingClass()"
                data-testid="sync-pending-indicator">
            ⏳ 待同步
          </span>
        }

        <!-- 操作按钮 -->
        <div class="flex gap-1 opacity-0 group-hover:opacity-100
                    group-focus-within:opacity-100 transition-opacity duration-150">

          <!-- 已读按钮 -->
          @if (!entry().isRead) {
            <button
              class="entry-action-btn"
              [class.obsidian]="appearance() === 'obsidian'"
              (click)="onMarkRead($event)"
              title="标记已读"
              aria-label="标记已读">
              👁️
            </button>
          }

          <!-- 完成按钮 -->
          @if (!entry().isCompleted) {
            <button
              class="entry-action-btn text-green-600 dark:text-green-400"
              [class.obsidian]="appearance() === 'obsidian'"
              (click)="onMarkCompleted($event)"
              title="标记完成"
              aria-label="标记完成">
              ✅
            </button>
          }

          <!-- 删除按钮 -->
          <button
            class="entry-action-btn text-red-500 dark:text-red-400"
            [class.obsidian]="appearance() === 'obsidian'"
            (click)="onDelete($event)"
            title="删除"
            aria-label="删除"
            data-testid="black-box-entry-delete">
            🗑️
          </button>
        </div>
      </div>

      <!-- 状态标签 -->
      @if (entry().isRead && !entry().isCompleted) {
        <div class="mt-1 inline-block px-1.5 py-0.5 rounded text-[9px]" [class]="readBadgeClass()">
          已读
        </div>
      }

      @if (entry().isCompleted) {
        <div class="mt-1 inline-block px-1.5 py-0.5 rounded text-[9px]" [class]="completedBadgeClass()">
          已完成
        </div>
      }
    </div>
  `,
  styles: [`
    .entry-action-btn {
      @apply w-6 h-6 rounded flex items-center justify-center text-xs
             bg-white/80 dark:bg-stone-600/80
             hover:bg-white dark:hover:bg-stone-500
             active:scale-90 transition-all duration-100
             focus-visible:ring-2 focus-visible:ring-amber-500;
    }

    .entry-action-btn.obsidian {
      @apply bg-stone-800/85 hover:bg-stone-700 border border-stone-600/70;
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class BlackBoxEntryComponent {
  entry = input.required<BlackBoxEntry>();
  appearance = input<'default' | 'obsidian'>('default');

  markRead = output<string>();
  markCompleted = output<string>();
  delete = output<string>();

  /**
   * 键盘快捷键支持
   */
  @HostListener('keydown', ['$event'])
  handleKeydown(event: KeyboardEvent): void {
    const key = typeof event.key === 'string' ? event.key.toLowerCase() : '';
    if (!key) return;


    // 【修复 2026-02-19】排除修饰键组合，避免 Ctrl+C/Cmd+C 误触发标记完成
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    if (key === 'r') {
      event.preventDefault();
      this.onMarkRead(event);
    } else if (key === 'c') {
      event.preventDefault();
      this.onMarkCompleted(event);
    }
  }

  onMarkRead(event: Event): void {
    event.stopPropagation();
    this.markRead.emit(this.entry().id);
  }

  onMarkCompleted(event: Event): void {
    event.stopPropagation();
    this.markCompleted.emit(this.entry().id);
  }

  onDelete(event: Event): void {
    event.stopPropagation();
    this.delete.emit(this.entry().id);
  }

  entryShellClass(): string {
    if (this.appearance() === 'obsidian') {
      return `bg-stone-900/70 border border-stone-700/70
              hover:bg-stone-800/80 hover:border-amber-400/45`;
    }
    return 'hover:bg-amber-100/50 dark:hover:bg-stone-700/50';
  }

  contentClass(): string {
    if (this.appearance() === 'obsidian') {
      return 'text-stone-300';
    }
    return 'text-stone-600 dark:text-stone-300';
  }

  timeClass(): string {
    if (this.appearance() === 'obsidian') {
      return 'text-stone-500';
    }
    return 'text-stone-400 dark:text-stone-500';
  }

  syncPendingClass(): string {
    if (this.appearance() === 'obsidian') {
      return 'text-amber-300';
    }
    return 'text-amber-500 dark:text-amber-300';
  }

  shouldShowSyncPendingIndicator(): boolean {
    const currentEntry = this.entry();
    return currentEntry.syncStatus === 'pending'
      && currentEntry.userId !== AUTH_CONFIG.LOCAL_MODE_USER_ID;
  }

  readBadgeClass(): string {
    if (this.appearance() === 'obsidian') {
      return 'bg-stone-700 text-stone-300';
    }
    return 'bg-stone-200 dark:bg-stone-600 text-stone-500 dark:text-stone-400';
  }

  completedBadgeClass(): string {
    if (this.appearance() === 'obsidian') {
      return 'bg-emerald-900/35 text-emerald-300';
    }
    return 'bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400';
  }
}
