import { Component, inject, ChangeDetectionStrategy, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ToastService, ToastMessage } from '../../../services/toast.service';
import { UiStateService } from '../../../services/ui-state.service';

/**
 * Toast 通知组件
 * 统一在右上角显示，移动端使用紧凑样式
 */
// 【P2-25 修复】添加 OnPush 变更检测策略
@Component({
  selector: 'app-toast-container',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule],
  template: `
    @if (toast.hasMessages()) {
      <!-- 右上角显示，移动端紧凑宽度 -->
      <div 
        class="fixed top-4 right-4 z-[9999] flex flex-col gap-2 pointer-events-none"
        [ngClass]="{
          'max-w-[280px]': uiState.isMobile(),
          'max-w-sm': !uiState.isMobile()
        }">
        @for (message of toast.messages(); track message.id) {
          <div 
            class="pointer-events-auto animate-toast-in rounded-lg shadow-lg border backdrop-blur-sm flex items-start transition-all duration-300"
            [attr.data-testid]="message.type === 'error' ? 'error-toast' : null"
            [ngClass]="{
              'p-3 gap-2 text-xs': uiState.isMobile(),
              'p-4 gap-3': !uiState.isMobile(),
              'bg-emerald-50 dark:bg-emerald-950 border-emerald-200 dark:border-emerald-800': message.type === 'success',
              'bg-red-50 dark:bg-red-950 border-red-200 dark:border-red-800': message.type === 'error',
              'bg-amber-50 dark:bg-amber-950 border-amber-200 dark:border-amber-800': message.type === 'warning',
              'bg-blue-50 dark:bg-blue-950 border-blue-200 dark:border-blue-800': message.type === 'info'
            }"
            role="alert">
            
            <!-- Icon -->
            <div class="flex-shrink-0"
                 [ngClass]="{
                   'mt-0.5': !uiState.isMobile(),
                   'mt-0': uiState.isMobile()
                 }">
              @switch (message.type) {
                @case ('success') {
                  <svg 
                    class="text-emerald-500"
                    [ngClass]="{
                      'w-4 h-4': uiState.isMobile(),
                      'w-5 h-5': !uiState.isMobile()
                    }"
                    fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
                  </svg>
                }
                @case ('error') {
                  <svg 
                    class="text-red-500"
                    [ngClass]="{
                      'w-4 h-4': uiState.isMobile(),
                      'w-5 h-5': !uiState.isMobile()
                    }"
                    fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
                  </svg>
                }
                @case ('warning') {
                  <svg 
                    class="text-amber-500"
                    [ngClass]="{
                      'w-4 h-4': uiState.isMobile(),
                      'w-5 h-5': !uiState.isMobile()
                    }"
                    fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
                  </svg>
                }
                @case ('info') {
                  <svg 
                    class="text-blue-500"
                    [ngClass]="{
                      'w-4 h-4': uiState.isMobile(),
                      'w-5 h-5': !uiState.isMobile()
                    }"
                    fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
                  </svg>
                }
              }
            </div>
            
            <!-- Content -->
            <div class="flex-1 min-w-0">
              <p 
                class="font-medium"
                [ngClass]="{
                  'text-xs': uiState.isMobile(),
                  'text-sm': !uiState.isMobile(),
                  'text-emerald-800 dark:text-emerald-200': message.type === 'success',
                  'text-red-800 dark:text-red-200': message.type === 'error',
                  'text-amber-800 dark:text-amber-200': message.type === 'warning',
                  'text-blue-800 dark:text-blue-200': message.type === 'info'
                 }">
                {{ message.title }}
              </p>
              @if (message.message) {
                <p 
                  class="mt-1"
                  [ngClass]="{
                    'text-[10px]': uiState.isMobile(),
                    'text-xs': !uiState.isMobile(),
                    'text-emerald-600 dark:text-emerald-300': message.type === 'success',
                    'text-red-600 dark:text-red-300': message.type === 'error',
                    'text-amber-600 dark:text-amber-300': message.type === 'warning',
                    'text-blue-600 dark:text-blue-300': message.type === 'info'
                   }">
                  {{ message.message }}
                </p>
              }
              @if (message.action) {
                <button
                  (click)="handleAction(message)"
                  [disabled]="isActionPending(message.id)"
                  class="mt-2 font-medium rounded-md transition-colors disabled:opacity-60 disabled:cursor-wait"
                  [ngClass]="{
                    'text-[10px] px-2 py-0.5': uiState.isMobile(),
                    'text-xs px-3 py-1': !uiState.isMobile(),
                    'bg-emerald-100 dark:bg-emerald-900 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-200 dark:hover:bg-emerald-800': message.type === 'success',
                    'bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300 hover:bg-red-200 dark:hover:bg-red-800': message.type === 'error',
                    'bg-amber-100 dark:bg-amber-900 text-amber-700 dark:text-amber-300 hover:bg-amber-200 dark:hover:bg-amber-800': message.type === 'warning',
                    'bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 hover:bg-blue-200 dark:hover:bg-blue-800': message.type === 'info'
                  }">
                  {{ isActionPending(message.id) && message.action.pendingLabel ? message.action.pendingLabel : message.action.label }}
                </button>
              }
            </div>
            
            <!-- Close Button -->
            <button 
              (click)="toast.dismiss(message.id)"
              class="flex-shrink-0 rounded-full transition-colors"
              [ngClass]="{
                'p-0.5': uiState.isMobile(),
                'p-1': !uiState.isMobile(),
                'text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-900': message.type === 'success',
                'text-red-400 hover:bg-red-100 dark:hover:bg-red-900': message.type === 'error',
                'text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-900': message.type === 'warning',
                'text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-900': message.type === 'info'
              }"
              aria-label="关闭">
              <svg 
                class="text-current"
                [ngClass]="{
                  'w-3 h-3': uiState.isMobile(),
                  'w-4 h-4': !uiState.isMobile()
                }"
                fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
              </svg>
            </button>
          </div>
        }
      </div>
    }
  `,
  styles: [`
    @keyframes toast-in {
      from {
        opacity: 0;
        transform: translateX(100%);
      }
      to {
        opacity: 1;
        transform: translateX(0);
      }
    }
    
    .animate-toast-in {
      animation: toast-in 0.3s ease-out;
    }
  `]
})
export class ToastContainerComponent {
  readonly toast = inject(ToastService);
  readonly uiState = inject(UiStateService);

  /**
   * 5 秒兜底超时：如果 action.onClick 的 Promise 5 秒还没完成（例如等待
   * `forceClearCacheImpl` 在某些机器上 hang），也强制 dismiss 并解除 pending，
   * 否则 toast 永远卡在「正在刷新…」状态。
   */
  private static readonly PENDING_FALLBACK_MS = 5000;

  /** 记录当前正在执行 action 的 toast id 集合（用于 UI 禁用按钮 + 替换标签）。 */
  private readonly pendingActionIds = signal<readonly string[]>([]);

  /**
   * 模板辅助：当前 toast 的 action 是否处于「执行中」状态。
   */
  isActionPending(id: string): boolean {
    return this.pendingActionIds().includes(id);
  }
  
  /**
   * 处理 Toast 操作按钮点击。
   *
   * 关键修复（2026-05-15）：
   * - onClick 可能是异步函数（例如 `swUpdate.activateUpdate()` + 强制清缓存）。
   * - 同步立刻 dismiss toast 会让用户失去「正在处理」的视觉反馈，看起来「点了没反应」。
   *   现在：调用前先把 toast 标记为 pending（按钮禁用、显示 pendingLabel），等
   *   Promise 完成或 5 秒兜底超时后再 dismiss。
   */
  handleAction(message: ToastMessage): void {
    if (this.isActionPending(message.id)) {
      return; // 防重入：用户连点
    }

    const action = message.action;
    if (!action?.onClick) {
      this.toast.dismiss(message.id);
      return;
    }

    // 标记 pending，触发模板重渲染（按钮禁用 + pendingLabel）。
    this.pendingActionIds.update(ids => [...ids, message.id]);

    let dismissed = false;
    const dismissOnce = () => {
      if (dismissed) return;
      dismissed = true;
      this.pendingActionIds.update(ids => ids.filter(id => id !== message.id));
      this.toast.dismiss(message.id);
    };

    let result: void | Promise<void>;
    try {
      result = action.onClick();
    } catch {
      dismissOnce();
      return;
    }

    // 仅对真正异步的 onClick 启用 pending UI + 5 秒兜底。
    // 同步返回 void 时立刻 dismiss，避免无谓的 setTimeout/clearTimeout 周期。
    if (!(result && typeof (result as Promise<void>).then === 'function')) {
      dismissOnce();
      return;
    }

    // 5 秒兜底：避免 onClick Promise 永远不 resolve。
    const fallbackTimer = setTimeout(dismissOnce, ToastContainerComponent.PENDING_FALLBACK_MS);

    (result as Promise<void>)
      .catch(() => {
        // onClick 内部的失败不应阻塞 toast 关闭。具体业务方应在 onClick 内自行
        // 处理失败（例如重新弹 toast / 复位 prompt flag），这里仅保证 UI 解锁。
      })
      .finally(() => {
        clearTimeout(fallbackTimer);
        dismissOnce();
      });
  }
}
