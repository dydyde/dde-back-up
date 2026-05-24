/**
 * 黑匣子面板组件
 * 
 * 显示黑匣子条目列表与文字补录入口
 */

import { 
  Component, 
  ChangeDetectionStrategy, 
  inject,
  output,
  OnInit,
  OnDestroy,
  input
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { BlackBoxService } from '../../../../../services/black-box.service';
import { SpeechToTextService } from '../../../../../services/speech-to-text.service';
import { FocusPreferenceService } from '../../../../../services/focus-preference.service';
import { ToastService } from '../../../../../services/toast.service';
import { BlackBoxTextInputComponent } from './black-box-text-input.component';
import { BlackBoxDateGroupComponent } from './black-box-date-group.component';
import { 
  SwipeGestureState, 
  SwipeDirection, 
  startSwipeTracking, 
  detectHorizontalSwipe 
} from '../../../../../utils/gesture';

@Component({
  selector: 'app-black-box-panel',
  standalone: true,
  imports: [
    CommonModule, 
    BlackBoxTextInputComponent,
    BlackBoxDateGroupComponent
  ],
  template: `
    @if (focusPrefs.isBlackBoxEnabled()) {
      <div class="relative overflow-hidden"
           (touchstart)="onSwipeTouchStart($event)"
           (touchend)="onSwipeTouchEnd($event)"
           data-testid="black-box-panel"
           role="region"
           aria-label="黑匣子面板">

        <!-- 标题栏（仅展示，无交互）-->
        <div class="px-0 py-2 flex justify-between items-center select-none" role="banner" aria-label="黑匣子条目仓">
          <span class="font-semibold text-stone-100 text-xs flex items-center gap-2">
            <span class="w-1.5 h-1.5 rounded-full bg-amber-500 shadow-[0_0_6px_rgba(245,158,11,0.45)]"></span>
            📦 黑匣子条目仓
            @if (pendingCount() > 0) {
              <span class="bg-amber-500 text-white text-[9px] px-1.5 py-0.5 rounded-full font-mono">
                {{ pendingCount() }}
              </span>
            }
          </span>
        </div>

        <!-- 内容区（直接展示）-->
        <div class="px-0 pb-2">
            <app-black-box-text-input
              [showFallbackHint]="!speechService.isSupported()"
              [appearance]="'obsidian'"
              (submitted)="onTranscribed($event)" />

            <!-- 离线待处理提示 -->
            @if (speechService.offlinePendingCount() > 0) {
              <div class="mt-2 px-2 py-1.5 bg-amber-900/30 rounded-lg text-xs text-amber-200 flex items-center gap-2">
                <span class="animate-pulse">📡</span>
                <span>{{ speechService.offlinePendingCount() }} 条录音待联网后转写</span>
              </div>
            }

            <!-- 条目列表（按日期分组） -->
            @for (group of entriesByDate(); track group.date) {
              <app-black-box-date-group
                [group]="group"
                [appearance]="'obsidian'"
                (markRead)="onMarkRead($event)"
                (markCompleted)="onMarkCompleted($event)"
                (confirmDelete)="onConfirmDelete($event)" />
            }

            <!-- 空状态 -->
            @if (entriesByDate().length === 0) {
              <div class="py-6 text-center text-xs text-stone-500">
                <p class="mb-1">暂无条目沉积</p>
                <p class="opacity-60">按住项目栏录音按钮即可快速记录</p>
              </div>
            }
          </div>
      </div>
    }
  `,
  styles: [`
    :host {
      display: block;
      min-height: 0;
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class BlackBoxPanelComponent implements OnInit, OnDestroy {
  private blackBoxService = inject(BlackBoxService);
  speechService = inject(SpeechToTextService);
  focusPrefs = inject(FocusPreferenceService);
  private readonly toast = inject(ToastService);
  readonly expandToken = input(0);
  
  readonly entriesByDate = this.blackBoxService.entriesByDate;
  readonly pendingCount = this.blackBoxService.pendingCount;
  
  /** 滑动切换视图事件 */
  readonly swipeToSwitch = output<SwipeDirection>();
  
  // 滑动手势状态
  private swipeState: SwipeGestureState = { startX: 0, startY: 0, startTime: 0, isActive: false };

  // visibilitychange 监听器引用（用于 cleanup）
  private visibilityHandler: (() => void) | null = null;
  
  /**
   * 组件初始化时先补本地快照，再走轻量远端刷新。
   * 远端刷新会被 single-flight 与 freshness window 去重，不再误报 manual pull。
   */
  ngOnInit(): void {
    void this.blackBoxService.refreshForView();
    this.setupVisibilityRefresh();
  }

  ngOnDestroy(): void {
    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
  }

  /**
   * 【修复 2026-05-24】页面重新可见时触发远端刷新，
   * 确保切回前台时能获取其他设备的最新修改。
   * freshness window 对 panel-open 已绕过，因此不会与定时轮询产生冗余请求。
   */
  private setupVisibilityRefresh(): void {
    this.visibilityHandler = () => {
      if (document.visibilityState === 'visible') {
        void this.blackBoxService.refreshForView();
      }
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);
  }
  
  /**
   * 处理转写完成
   */
  onTranscribed(text: string): void {
    if (text.trim()) {
      const result = this.blackBoxService.create({ content: text.trim() });
      if (!result.ok) {
        this.toast.warning('保存失败', result.error.message);
      }
    }
  }
  
  /**
   * 标记为已读
   */
  onMarkRead(id: string): void {
    this.blackBoxService.markAsRead(id);
  }
  
  /**
   * 标记为完成
   */
  onMarkCompleted(id: string): void {
    this.blackBoxService.markAsCompleted(id);
  }
  
  /**
   * 确认删除条目
   */
  onConfirmDelete(id: string): void {
    this.blackBoxService.delete(id);
  }
  
  // ===============================================
  // 滑动切换视图手势处理
  // ===============================================
  
  /**
   * 滑动开始 - 在面板容器上调用
   */
  onSwipeTouchStart(event: TouchEvent): void {
    if (event.touches.length !== 1) return;
    this.swipeState = startSwipeTracking(event.touches[0]);
  }
  
  /**
   * 滑动结束 - 检测是否触发视图切换
   * 【重要】检测到有效滑动时阻止事件冒泡，避免 app.component 误打开侧边栏
   */
  onSwipeTouchEnd(event: TouchEvent): void {
    if (!this.swipeState.isActive) return;
    
    const touch = event.changedTouches[0];
    const direction = detectHorizontalSwipe(
      this.swipeState,
      touch.clientX,
      touch.clientY
    );
    
    if (direction) {
      // 阻止事件冒泡，避免 app.component 误判为侧边栏切换手势
      event.stopPropagation();
      this.swipeToSwitch.emit(direction);
    }
    
    this.swipeState = { startX: 0, startY: 0, startTime: 0, isActive: false };
  }
}
