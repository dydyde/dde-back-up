import { Component, inject, effect, signal, computed, ChangeDetectionStrategy, DestroyRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SimpleSyncService } from '../../core/services/simple-sync.service';
import { ToastService } from '../../../services/toast.service';
import { ActionQueueService } from '../../../services/action-queue.service';
import { UiStateService } from '../../../services/ui-state.service';
import { AuthService } from '../../../services/auth.service';
import { NetworkAwarenessService } from '../../../services/network-awareness.service';
import { AUTH_CONFIG, FEATURE_FLAGS } from '../../../config';
import { isLocalModeEnabled } from '../../../services/guards/auth.guard';

/**
 * 离线状态通知 + 持久化状态指示器组件
 * 
 * 设计理念（v6.0 离线友好重构）：
 * - 离线不等于错误：使用平静的蓝色调，而非警告的红色
 * - 给用户安全感：明确告知"数据安全"，避免焦虑
 * - 待同步计数：让用户知道有多少编辑在等待同步
 * - 网络恢复时给予正向反馈
 * - 存储受限才用警告色（真正需要关注的问题）
 */
@Component({
  selector: 'app-offline-banner',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!-- 持久化状态指示器 -->
    @if (showIndicator()) {
      <div class="fixed z-50 flex items-center rounded-full font-medium backdrop-blur-sm transition-all duration-300 shadow-sm pointer-events-none"
           data-testid="offline-indicator"
           [style.top]="offlineIndicatorTop()"
           [ngClass]="{
             'right-2 gap-1.5 px-2.5 py-1.5 text-[10px]': !isMobile(),
             'left-1/2 -translate-x-1/2 gap-1 px-2 py-1 text-[9px] max-w-[calc(100vw-16px)]': isMobile(),
             'bg-sky-50/95 dark:bg-sky-900/80 text-sky-700 dark:text-sky-300 border border-sky-200/60 dark:border-sky-700/60': isOffline() && !isStorageFrozen(),
             'bg-amber-100/90 dark:bg-amber-900/70 text-amber-700 dark:text-amber-300 border border-amber-200/60 dark:border-amber-700/60': isStorageFrozen(),
             'bg-green-100/90 dark:bg-green-900/70 text-green-700 dark:text-green-300 opacity-0 border border-green-200/60 dark:border-green-700/60': !isOffline() && !isStorageFrozen()
           }">
        <div class="w-1.5 h-1.5 rounded-full flex-shrink-0"
             [ngClass]="{
               'bg-sky-500': isOffline() && !isStorageFrozen(),
               'bg-amber-500 animate-pulse': isStorageFrozen(),
               'bg-green-500': !isOffline() && !isStorageFrozen()
             }">
        </div>
        @if (isOffline() && !isStorageFrozen()) {
          <span>{{ isMobile() ? '离线数据已保存' : '离线模式 · 数据已安全保存' }}</span>
          @if (pendingEditCount() > 0) {
            <span class="px-1 py-0.5 rounded bg-sky-200/60 dark:bg-sky-800/60 text-[9px]">{{ pendingEditCount() }} 待同步</span>
          }
        } @else if (isStorageFrozen()) {
          <span>存储受限</span>
        }
      </div>
    }
  `,
})
export class OfflineBannerComponent {
  private static readonly DEMO_BANNER_DISMISS_STORAGE_KEY = 'nanoflow.demo-banner-dismissed';
  private syncService = inject(SimpleSyncService);
  private actionQueue = inject(ActionQueueService);
  private toast = inject(ToastService);
  private uiState = inject(UiStateService);
  private destroyRef = inject(DestroyRef);
  private auth = inject(AuthService);
  private networkAwareness = inject(NetworkAwarenessService);
  
  /** 上一次的网络连接状态（用于检测状态变化） */
  private previousOnlineState: boolean | null = null;
  
  /** 上一次的离线模式状态（服务中断） */
  private previousOfflineMode: boolean | null = null;

  /** 是否显示指示器 */
  readonly showIndicator = signal(false);

  /** 设备类型（用于移动端避免遮挡顶部视图切换按钮） */
  readonly isMobile = this.uiState.isMobile;

  /** 离线状态 */
  readonly isOffline = computed(() => 
    !this.networkAwareness.isOnline()
    || !this.syncService.syncState().isOnline
    || this.syncService.syncState().offlineMode
  );

  /** 存储冻结状态 */
  readonly isStorageFrozen = this.actionQueue.queueFrozen;

  /** 待同步编辑数（给用户可见的安心感） */
  readonly pendingEditCount = computed(() => this.syncService.syncState().pendingCount);

  /** 在线恢复后淡出定时器 */
  private fadeOutTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // 【NEW-7】首次加载时检测离线状态 — 使用平和的语气
    if ((typeof navigator !== 'undefined' && !navigator.onLine) || !this.networkAwareness.isOnline()) {
      this.toast.info('离线模式已启用', '您可以继续编辑，所有更改都安全地保存在本地，联网后自动同步');
      this.showIndicator.set(true);
    }
    
    // 【P2-27 修复】组件销毁时清理定时器
    this.destroyRef.onDestroy(() => this.cancelFadeOut());

    // 使用 effect 监听网络状态变化
    effect(() => {
      const isOnline = this.networkAwareness.isOnline() && this.syncService.syncState().isOnline;
      const offlineMode = this.syncService.syncState().offlineMode;
      const queueFrozen = this.actionQueue.queueFrozen();
      
      // 检测网络连接状态变化
      if (this.previousOnlineState !== null && this.previousOnlineState !== isOnline) {
        if (isOnline) {
          this.toast.success('网络已恢复', '正在自动同步您的更改到云端');
          // 在线恢复后 3s 淡出指示器
          this.scheduleFadeOut();
        } else {
          // 使用 info 而非 warning，离线不是警告事件
          this.toast.info('已切换到离线模式', '您可以继续编辑，所有更改都安全地保存在本地');
          this.cancelFadeOut();
        }
      }
      
      // 检测服务中断状态变化（网络在线但服务不可用）
      if (this.previousOfflineMode !== null && this.previousOfflineMode !== offlineMode) {
        if (offlineMode) {
          this.toast.info('云端服务暂时不可用', '您可以继续编辑，更改将在服务恢复后自动同步');
          this.cancelFadeOut();
        } else if (isOnline) {
          this.toast.success('服务已恢复', '正在自动同步您的更改');
          this.scheduleFadeOut();
        }
      }

      // 根据状态决定是否显示指示器
      const shouldShow = !isOnline || offlineMode || queueFrozen;
      this.showIndicator.set(shouldShow);
      
      // 更新状态
      this.previousOnlineState = isOnline;
      this.previousOfflineMode = offlineMode;
    });
  }

  private scheduleFadeOut(): void {
    this.cancelFadeOut();
    this.fadeOutTimer = setTimeout(() => {
      if (!this.isOffline() && !this.isStorageFrozen()) {
        this.showIndicator.set(false);
      }
    }, 3000);
  }

  private cancelFadeOut(): void {
    if (this.fadeOutTimer) {
      clearTimeout(this.fadeOutTimer);
      this.fadeOutTimer = null;
    }
  }

  offlineIndicatorTop(): string {
    const topOffset = this.isMobile()
      ? (this.showMobileDemoBanner() ? 104 : 42)
      : 8;
    return `calc(env(safe-area-inset-top, 0px) + ${topOffset}px)`;
  }

  private showMobileDemoBanner(): boolean {
    if (!this.isMobile()) {
      return false;
    }

    if (this.isDemoBannerDismissed()) {
      return false;
    }

    return isLocalModeEnabled()
      || this.auth.currentUserId() === AUTH_CONFIG.LOCAL_MODE_USER_ID
      || (FEATURE_FLAGS.DEMO_MODE_ENABLED ?? false);
  }

  private isDemoBannerDismissed(): boolean {
    if (typeof localStorage === 'undefined') {
      return false;
    }

    try {
      const stored = localStorage.getItem(OfflineBannerComponent.DEMO_BANNER_DISMISS_STORAGE_KEY);
      if (!stored) {
        return false;
      }

      const data = JSON.parse(stored) as { timestamp?: unknown } | null;
      if (!data || typeof data.timestamp !== 'number') {
        localStorage.removeItem(OfflineBannerComponent.DEMO_BANNER_DISMISS_STORAGE_KEY);
        return false;
      }

      const dismissExpiryMs = 7 * 24 * 60 * 60 * 1000;
      if (Date.now() - data.timestamp < dismissExpiryMs) {
        return true;
      }

      localStorage.removeItem(OfflineBannerComponent.DEMO_BANNER_DISMISS_STORAGE_KEY);
      return false;
    } catch {
      return false;
    }
  }
}
