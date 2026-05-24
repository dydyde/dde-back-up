/**
 * 移动端黑匣子抽屉组件
 * 
 * 底层抽屉内容：黑匣子数据区
 * 专为移动端抽屉布局优化
 */

import { Component, ChangeDetectionStrategy, inject, OnInit, OnDestroy, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { BlackBoxService } from '../../../../services/black-box.service';
import { SpeechToTextService } from '../../../../services/speech-to-text.service';
import { FocusPreferenceService } from '../../../../services/focus-preference.service';
import { ToastService } from '../../../../services/toast.service';
import { BlackBoxRecorderComponent } from '../../focus/components/black-box/black-box-recorder.component';
import { BlackBoxTextInputComponent } from '../../focus/components/black-box/black-box-text-input.component';
import { BlackBoxDateGroupComponent } from '../../focus/components/black-box/black-box-date-group.component';
import { StrataViewComponent } from '../../focus/components/strata/strata-view.component';
import { StrataRestoreEvent } from '../../focus/components/strata/strata-layer.component';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
import { 
  SwipeGestureState, 
  SwipeDirection, 
  startSwipeTracking, 
  detectHorizontalSwipe 
} from '../../../../utils/gesture';

@Component({
  selector: 'app-mobile-black-box-drawer',
  standalone: true,
  imports: [
    CommonModule, 
    BlackBoxRecorderComponent, 
    BlackBoxTextInputComponent,
    BlackBoxDateGroupComponent,
    StrataViewComponent
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (focusPrefs.isBlackBoxEnabled()) {
      <div class="flex flex-col h-full"
           (touchstart)="onSwipeTouchStart($event)"
           (touchend)="onSwipeTouchEnd($event)">
        <!-- 标题区域 -->
        <div class="shrink-0 px-4 pt-2 pb-2 flex items-center justify-between">
          <h2 class="text-base font-bold text-stone-700 dark:text-stone-200 flex items-center gap-2">
            📦 黑匣子
            @if (pendingCount() > 0) {
              <span class="bg-amber-500 text-white text-[9px] px-1.5 py-0.5 rounded-full font-mono">
                {{ pendingCount() }}
              </span>
            }
          </h2>
        </div>
        
        <!-- 滚动内容区域 -->
        <div class="flex-1 overflow-y-auto overflow-x-hidden px-3 pb-8 flex flex-col gap-3 custom-scrollbar">
          
          <!-- 录音按钮或文字输入 -->
          @if (speechService.isSupported()) {
            <app-black-box-recorder 
              (transcribed)="onTranscribed($event)" />
            <div class="mt-2">
              <app-black-box-text-input 
                [showFallbackHint]="false"
                (submitted)="onTranscribed($event)" />
            </div>
          } @else {
            <app-black-box-text-input 
              (submitted)="onTranscribed($event)" />
          }
          
          <!-- 离线待处理提示 -->
          @if (speechService.offlinePendingCount() > 0) {
            <div class="px-2 py-1.5 bg-amber-100 dark:bg-amber-900/30 
                        rounded-lg text-xs text-amber-700 dark:text-amber-300
                        flex items-center gap-2">
              <span class="animate-pulse">📡</span>
              <span>{{ speechService.offlinePendingCount() }} 条录音待联网后转写</span>
            </div>
          }
          
          <!-- 条目列表（按日期分组） -->
          @for (group of entriesByDate(); track group.date) {
            <app-black-box-date-group 
              [group]="group"
              (markRead)="onMarkRead($event)"
              (markCompleted)="onMarkCompleted($event)"
              (confirmDelete)="onConfirmDelete($event)" />
          }
          
          <!-- 空状态 -->
          @if (entriesByDate().length === 0) {
            <div class="py-2 text-center text-[10px] leading-tight text-stone-400 dark:text-stone-500 sm:py-6 sm:text-xs">
              <p class="mb-0.5 sm:mb-1">按住按钮开始录音</p>
              <p class="opacity-60">语音会自动转为文字</p>
            </div>
          }

          <!-- 项目历史回顾（沉积岩层） -->
          <div class="mt-4 border-t border-amber-500/10 dark:border-amber-400/10 pt-3">
            <div class="flex items-center gap-2 px-1 mb-2">
              <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 text-amber-500/60" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
              </svg>
              <span class="text-xs font-bold text-stone-600 dark:text-stone-300 tracking-wide">项目历史回顾</span>
              <span class="text-[9px] font-mono text-amber-500/40 tracking-widest uppercase">Strata</span>
            </div>
            <div class="h-72 rounded-lg overflow-hidden">
              <app-strata-view class="block h-full w-full" [alwaysShow]="true" (restoreItem)="onRestoreFromHistory($event)"></app-strata-view>
            </div>
          </div>
          
        </div>
      </div>
    } @else {
      <!-- 黑匣子未启用 -->
      <div class="flex flex-col h-full items-center justify-center text-stone-400 dark:text-stone-500 text-sm">
        <p>黑匣子功能未启用</p>
        <p class="text-xs mt-1">可在设置中开启</p>
      </div>
    }
  `,
  styles: [`
    :host {
      display: block;
      height: 100%;
    }
  `]
})
export class MobileBlackBoxDrawerComponent implements OnInit, OnDestroy {
  private blackBoxService = inject(BlackBoxService);
  readonly speechService = inject(SpeechToTextService);
  readonly focusPrefs = inject(FocusPreferenceService);
  private readonly toast = inject(ToastService);
  private readonly taskOpsAdapter = inject(TaskOperationAdapterService);
  
  readonly entriesByDate = this.blackBoxService.entriesByDate;
  readonly pendingCount = this.blackBoxService.pendingCount;
  
  /** 滑动切换视图事件 */
  readonly swipeToSwitch = output<SwipeDirection>();
  
  // 滑动手势状态
  private swipeState: SwipeGestureState = { startX: 0, startY: 0, startTime: 0, isActive: false };

  // visibilitychange 监听器引用（用于 cleanup）
  private visibilityHandler: (() => void) | null = null;
  
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
   * 确保手机端切回前台时能获取电脑端的最新修改。
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

  /**
   * 从沉积层历史中恢复条目
   * - task → 恢复为 active 状态
   * - black_box → 取消完成标记
   */
  onRestoreFromHistory(event: StrataRestoreEvent): void {
    if (event.type === 'task') {
      this.taskOpsAdapter.updateTaskStatus(event.id, 'active');
    } else {
      this.blackBoxService.update(event.id, { isCompleted: false });
    }
  }
  
  // ===============================================
  // 滑动切换视图手势处理
  // ===============================================
  
  /**
   * 滑动开始 - 在抽屉容器上调用
   * 用于检测水平滑动以切换视图
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
