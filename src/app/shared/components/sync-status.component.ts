import { Component, inject, signal, computed, input, ChangeDetectionStrategy, output, effect, DestroyRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActionQueueService } from '../../../services/action-queue.service';
import { SimpleSyncService } from '../../core/services/simple-sync.service';
import { SyncCoordinatorService } from '../../../services/sync-coordinator.service';
import { ProjectStateService } from '../../../services/project-state.service';
import { AuthService } from '../../../services/auth.service';
import { ConflictStorageService } from '../../../services/conflict-storage.service';
import { RetryQueueService } from '../../core/services/sync/retry-queue.service';
import { ToastService } from '../../../services/toast.service';
import { LoggerService } from '../../../services/logger.service';
import { SYNC_CONFIG } from '../../../config/sync.config';
import type { QueuedAction } from '../../../services/action-queue.types';

/**
 * 同步状态组件
 * 支持紧凑模式和完整模式
 * - 紧凑模式：仅显示小图标和状态文字，适合侧边栏项目列表
 * - 完整模式：显示详细状态，适合弹出面板
 * 
 * 嵌入模式（embedded）：直接显示在侧边栏中而非弹窗
 * 
 * 冲突仓库功能：
 * - 显示冲突红点提示
 * - 用户点击可进入冲突解决中心
 */
@Component({
  selector: 'app-sync-status',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (compact() && !embedded()) {
      <!-- 紧凑模式：仅显示状态指示器 -->
      <div class="relative">
        <button 
          (click)="toggleExpand()"
          class="flex items-center gap-1.5 px-2 py-1 rounded-lg hover:bg-stone-100 dark:hover:bg-stone-700 transition-colors text-xs"
          [ngClass]="{
            'bg-stone-100 dark:bg-stone-700': isExpanded()
          }">
          <!-- 状态点 -->
          <div class="w-2 h-2 rounded-full flex-shrink-0"
               [ngClass]="statusDotClass()"
               [class.animate-pulse]="isSyncing() || pendingCount() > 0">
          </div>
          
          <!-- 简短状态文字 -->
          <span class="text-stone-500 dark:text-stone-400 hidden sm:inline">
            @if (isLoadingRemote()) {
              后台同步...
            } @else if (isSyncing()) {
              同步中...
            } @else if (queueFrozen()) {
              队列冻结
            } @else if (deadLetterCount() > 0) {
              {{ deadLetterCount() }} 失败
            } @else if (syncError()) {
              同步错误
            } @else if (conflictCount() > 0) {
              <button
                type="button"
                data-testid="open-conflict-center-btn"
                (click)="openConflictCenter(); $event.stopPropagation()"
                class="underline decoration-dotted underline-offset-2 text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 font-medium cursor-pointer"
                title="点击打开冲突解决中心">
                {{ conflictCount() }} 个冲突
              </button>
            } @else if (pendingCount() > 0) {
              {{ pendingCount() }} 待同步
            } @else if (!isOnline()) {
              离线
            } @else if (offlineMode()) {
              连接中断
            } @else if (!isLoggedIn()) {
              本地
            } @else {
              已保存
            }
          </span>
          
          <!-- 有问题时显示徽章 -->
          @if (hasIssues() && !isExpanded()) {
            <span class="absolute -top-1 -right-1 w-4 h-4 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center">
              {{ totalIssues() }}
            </span>
          }
        </button>
        
        <!-- 展开的浮动面板 -->
        @if (isExpanded()) {
          <div class="absolute bottom-full left-0 mb-2 z-50 w-72">
            <ng-container *ngTemplateOutlet="fullPanel"></ng-container>
          </div>
          <!-- 点击外部关闭 -->
          <div class="fixed inset-0 z-40" (click)="isExpanded.set(false)"></div>
        }
      </div>
    } @else if (embedded()) {
      <!-- 嵌入模式：直接显示在侧边栏中 -->
      <div class="w-full space-y-2 px-2 py-2 bg-stone-50/50 dark:bg-stone-800/50 rounded-lg border border-stone-100 dark:border-stone-700">
        <!-- 状态概览行 -->
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <!-- 状态点 -->
            <div data-testid="sync-status-indicator" class="w-2 h-2 rounded-full flex-shrink-0" 
                 [attr.data-testid-offline]="!isOnline() || offlineMode() ? 'offline-indicator' : null"
                 [attr.data-testid-pending]="pendingCount() > 0 ? 'pending-sync-indicator' : null"
                [attr.data-testid-busy]="isAnySyncing() || isResyncing() || isRetrying() || isProcessing() ? 'sync-busy-indicator' : null"
                [attr.data-testid-last-sync]="syncService.syncState().lastSyncTime"
                [attr.data-testid-success]="statusDotClass() === 'bg-green-500' ? 'sync-success-indicator' : null"
                [ngClass]="statusDotClass()"
                 [class.animate-pulse]="isSyncing() || pendingCount() > 0">
            </div>
            <!-- 状态文字 -->
            <span class="text-[11px] text-stone-500 dark:text-stone-400">
              @if (isLoadingRemote()) {
                后台同步中...
              } @else if (isSyncing()) {
                同步中...
              } @else if (queueFrozen()) {
                队列冻结
              } @else if (deadLetterCount() > 0) {
                {{ deadLetterCount() }} 个同步失败
              } @else if (syncError()) {
                同步错误
              } @else if (conflictCount() > 0) {
                <button
                  type="button"
                  data-testid="open-conflict-center-btn"
                  (click)="openConflictCenter(); $event.stopPropagation()"
                  class="underline decoration-dotted underline-offset-2 text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 font-medium cursor-pointer"
                  title="点击打开冲突解决中心">
                  {{ conflictCount() }} 个冲突待处理
                </button>
              } @else if (pendingCount() > 0) {
                {{ pendingCount() }} 待同步
              } @else if (!isOnline()) {
                离线模式
              } @else if (offlineMode()) {
                连接中断
              } @else if (!isLoggedIn()) {
                数据保存在本地
              } @else {
                已保存到云端
              }
            </span>
          </div>
          
          <!-- 操作按钮 -->
          <div class="flex items-center gap-1">
            @if (conflictCount() > 0) {
              <button
                type="button"
                data-testid="resolve-conflicts-btn"
                (click)="openConflictCenter(); $event.stopPropagation()"
                class="px-2 py-0.5 text-[10px] font-medium bg-red-100 dark:bg-red-900/50 hover:bg-red-200 dark:hover:bg-red-800/50 text-red-700 dark:text-red-300 rounded transition-colors flex items-center gap-1 border border-red-200 dark:border-red-800"
                title="打开冲突解决中心">
                处理冲突
              </button>
            }
            @if (pendingCount() > 0 || deadLetterCount() > 0) {
              <button 
                (click)="retryAll(); $event.stopPropagation()"
                [disabled]="isProcessing() || isRetrying()"
                class="px-2 py-0.5 text-[10px] font-medium bg-indigo-100 dark:bg-indigo-900/50 hover:bg-indigo-200 dark:hover:bg-indigo-800/50 text-indigo-700 dark:text-indigo-300 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1">
                @if (isRetrying()) {
                  <svg class="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  同步中...
                } @else {
                  立即同步
                }
              </button>
            }
            
            <!-- 刷新同步按钮（次要操作） -->
            @if (isLoggedIn() && isOnline() && !offlineMode()) {
              <button
                data-testid="sync-resync-project-btn"
                (click)="resyncProject(); $event.stopPropagation()"
                [disabled]="isResyncing()"
                class="p-1 text-stone-400 dark:text-stone-500 hover:text-stone-600 dark:hover:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-700 rounded transition-colors disabled:opacity-50"
                title="刷新同步当前项目">
                @if (isResyncing()) {
                  <svg class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                } @else {
                  <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                }
              </button>
            }
          </div>
        </div>
        
        <!-- 错误信息 -->
        @if (syncError()) {
          <div class="p-1.5 bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-800 rounded text-[10px] text-red-600 dark:text-red-400 line-clamp-2">
            {{ syncError() }}
          </div>
        }
        
        <!-- 【Senior Consultant "Red Phone"】危险状态警告 -->
        @if (isCriticalState()) {
          <div class="p-2 bg-red-100 dark:bg-red-900/40 border-2 border-red-400 dark:border-red-600 rounded-lg animate-pulse">
            <div class="flex items-center gap-2">
              <span class="text-lg">🔴</span>
              <div class="flex-1">
                <div class="text-[11px] font-bold text-red-700 dark:text-red-300">同步严重滞后</div>
                <div class="text-[10px] text-red-600 dark:text-red-400">
                  @if (deadLetterCount() > 0) {
                    {{ deadLetterCount() }} 个操作失败，数据可能丢失！
                  } @else {
                    {{ pendingCount() }} 个操作待同步，请连接网络
                  }
                </div>
              </div>
            </div>
            <button 
              (click)="downloadBackup(); $event.stopPropagation()"
              class="w-full mt-2 py-1.5 text-[11px] font-bold bg-red-600 hover:bg-red-700 text-white rounded transition-colors">
              ⬇️ 立即下载备份
            </button>
          </div>
        }
        
        <!-- 死信队列（失败的操作）详情 -->
        @if (deadLetterCount() > 0) {
          <div class="space-y-1">
            <div class="flex items-center justify-between">
              <span class="text-[10px] text-red-500 font-medium">失败的操作</span>
              <button 
                (click)="showDeadLetters.set(!showDeadLetters()); $event.stopPropagation()"
                class="text-[9px] text-stone-400 dark:text-stone-500 hover:text-stone-600 dark:hover:text-stone-300">
                {{ showDeadLetters() ? '收起' : '展开' }}
              </button>
            </div>
            
            @if (showDeadLetters()) {
              <div class="space-y-1 max-h-24 overflow-y-auto">
                @for (item of deadLetters(); track item.action.id) {
                  <div class="flex items-center justify-between p-1 bg-white dark:bg-stone-700 rounded border border-stone-100 dark:border-stone-600 text-[10px]">
                    <span class="text-stone-600 dark:text-stone-300 truncate flex-1">{{ getActionLabel(item.action) }}</span>
                    <div class="flex gap-0.5 ml-1">
                      <button 
                        (click)="retryDeadLetter(item.action.id); $event.stopPropagation()"
                        class="p-0.5 text-amber-600 hover:bg-amber-50 rounded"
                        title="重试">
                        ↻
                      </button>
                      <button 
                        (click)="dismissDeadLetter(item.action.id); $event.stopPropagation()"
                        class="p-0.5 text-stone-400 hover:bg-stone-100 rounded"
                        title="放弃">
                        ✕
                      </button>
                    </div>
                  </div>
                }
              </div>
            }
          </div>
        }
        
        <!-- 离线模式提示（安心感设计） -->
        @if (!isOnline()) {
          <div class="text-[10px] text-sky-600 dark:text-sky-400 bg-sky-50 dark:bg-sky-900/30 px-2 py-1 rounded">
            离线模式 · 数据安全，联网后自动同步
          </div>
        }
        
        <!-- 【增强】队列冻结时：逃生导出按钮 + 内存操作计数 -->
        @if (queueFrozen()) {
          <div class="p-1.5 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-700 rounded">
            <div class="text-[10px] text-amber-700 dark:text-amber-300 mb-1">⚠️ 存储受限，队列已冻结</div>
            @if (memoryOnlyCount() > 0) {
              <div class="text-[10px] text-amber-600 dark:text-amber-400 mb-1">
                {{ memoryOnlyCount() }} 个操作仅在内存中（未持久化）
              </div>
            }
            <button
              (click)="exportPendingData(); $event.stopPropagation()"
              class="w-full py-1 text-[10px] font-medium bg-amber-200 dark:bg-amber-800 hover:bg-amber-300 dark:hover:bg-amber-700 text-amber-800 dark:text-amber-200 rounded transition-colors">
              ⬇️ 导出待同步数据
            </button>
          </div>
        }

        <!-- 【增强】重试队列容量使用 >50% 时显示 -->
        @if (retryQueueUsagePercent() > 50) {
          <div class="flex items-center justify-between px-1 text-[10px]"
               [class.text-amber-500]="retryQueueUsagePercent() <= 85"
               [class.text-red-500]="retryQueueUsagePercent() > 85">
            <span>重试队列</span>
            <span>{{ retryQueueUsagePercent() }}% 已用</span>
          </div>
        }

        <!-- 【增强】最近成功云同步时间 -->
        @if (lastSyncTimeText()) {
          <div class="flex items-center justify-between px-1 text-[10px] text-stone-400 dark:text-stone-500">
            <span>最后同步</span>
            <span>{{ lastSyncTimeText() }}</span>
          </div>
        }
      </div>
    } @else {
      <!-- 完整模式面板 -->
      <ng-container *ngTemplateOutlet="fullPanel"></ng-container>
    }
    
    <!-- 完整面板模板 -->
    <ng-template #fullPanel>
      <div class="bg-white dark:bg-stone-800 rounded-xl shadow-lg border border-stone-200 dark:border-stone-600 overflow-hidden">
        <!-- 标题栏 -->
        <div class="px-3 py-2 bg-gradient-to-r from-stone-50 dark:from-stone-700 to-white dark:to-stone-800 border-b border-stone-100 dark:border-stone-600 flex items-center justify-between">
          <div class="flex items-center gap-2">
            <div class="w-2 h-2 rounded-full" 
                 [ngClass]="statusDotClass()"
                 [class.animate-pulse]="isSyncing()">
            </div>
            <h3 class="font-bold text-stone-700 dark:text-stone-200 text-xs">同步状态</h3>
          </div>
          <span class="text-[10px] text-stone-400 dark:text-stone-500">
            {{ !isLoggedIn() ? '未登录' : isOnline() && !offlineMode() ? '在线' : offlineMode() ? '连接中断' : '离线' }}
          </span>
        </div>
        
        <!-- 状态概览 -->
        <div class="p-3 space-y-2">
          <!-- 同步错误 -->
          @if (syncError()) {
            <div class="p-2 bg-red-50 border border-red-100 rounded-lg">
              <div class="flex items-start gap-2">
                <svg class="w-3 h-3 text-red-500 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                <div class="text-[10px] text-red-600 line-clamp-2">{{ syncError() }}</div>
              </div>
            </div>
          }
          
          <!-- 待处理操作 -->
          <div class="flex items-center justify-between p-2 bg-stone-50 dark:bg-stone-700 rounded-lg">
            <div class="flex items-center gap-1.5">
              <svg class="w-3 h-3 text-stone-500 dark:text-stone-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              <span class="text-[10px] text-stone-600 dark:text-stone-300">待处理</span>
            </div>
            <div class="flex items-center gap-1.5">
              <span class="text-xs font-bold" [class.text-stone-400]="pendingCount() === 0" [class.text-amber-600]="pendingCount() > 0">
                {{ pendingCount() }}
              </span>
              @if (pendingCount() > 0) {
                <button 
                  (click)="retryAll(); $event.stopPropagation()"
                  [disabled]="isProcessing()"
                  class="px-1.5 py-0.5 text-[9px] font-medium bg-amber-100 dark:bg-amber-900/50 hover:bg-amber-200 dark:hover:bg-amber-800/50 text-amber-700 dark:text-amber-300 rounded transition-colors disabled:opacity-50">
                  {{ isProcessing() ? '...' : '同步' }}
                </button>
              }
            </div>
          </div>
          
          <!-- 死信队列 -->
          @if (deadLetterCount() > 0) {
            <div class="p-2 bg-red-50 dark:bg-red-900/30 border border-red-100 dark:border-red-800 rounded-lg">
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-1.5">
                  <svg class="w-3 h-3 text-red-500 dark:text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                  </svg>
                  <span class="text-[10px] text-red-600 dark:text-red-300 font-medium">{{ deadLetterCount() }} 个失败</span>
                </div>
                <button 
                  (click)="showDeadLetters.set(!showDeadLetters()); $event.stopPropagation()"
                  class="text-[9px] text-red-500 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300">
                  {{ showDeadLetters() ? '收起' : '详情' }}
                </button>
              </div>
              
              <!-- 死信详情列表 -->
              @if (showDeadLetters()) {
                <div class="mt-2 space-y-1.5 max-h-32 overflow-y-auto">
                  @for (item of deadLetters(); track item.action.id) {
                    <div class="flex items-center justify-between p-1.5 bg-white dark:bg-stone-700 rounded text-[10px]">
                      <div class="flex-1 min-w-0 mr-2">
                        <div class="font-medium text-red-700 dark:text-red-300 truncate">{{ getActionLabel(item.action) }}</div>
                      </div>
                      <div class="flex gap-0.5 flex-shrink-0">
                        <button 
                          (click)="retryDeadLetter(item.action.id); $event.stopPropagation()"
                          class="p-0.5 bg-amber-100 dark:bg-amber-900/50 hover:bg-amber-200 dark:hover:bg-amber-800/50 text-amber-700 dark:text-amber-300 rounded"
                          title="重试">
                          <svg class="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                          </svg>
                        </button>
                        <button 
                          (click)="dismissDeadLetter(item.action.id); $event.stopPropagation()"
                          class="p-0.5 bg-stone-100 dark:bg-stone-600 hover:bg-stone-200 dark:hover:bg-stone-500 text-stone-500 dark:text-stone-300 rounded"
                          title="放弃">
                          <svg class="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  }
                </div>
                
                @if (deadLetterCount() > 1) {
                  <button 
                    (click)="clearAllDeadLetters(); $event.stopPropagation()"
                    class="w-full mt-1.5 py-1 text-[9px] font-medium text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/30 rounded transition-colors">
                    清空全部
                  </button>
                }
              }
            </div>
          }
        </div>
        
        <!-- 底部提示 -->
        @if (!isOnline()) {
          <div class="px-3 py-1.5 bg-sky-50 dark:bg-sky-900/30 border-t border-sky-100 dark:border-sky-800 text-[10px] text-sky-700 dark:text-sky-300">
            离线模式 · 数据安全，联网后自动同步
          </div>
        }
      </div>
    </ng-template>
  `
})
export class SyncStatusComponent {
  private static readonly BACKGROUND_PENDING_ENTITY_TYPES = new Set<QueuedAction['entityType']>([
    'focus-session',
  ]);

  private actionQueue = inject(ActionQueueService);
  private syncService = inject(SimpleSyncService);
  private authService = inject(AuthService);
  private conflictStorage = inject(ConflictStorageService);
  private syncCoordinator = inject(SyncCoordinatorService);
  private projectState = inject(ProjectStateService);
  private retryQueue = inject(RetryQueueService);
  private toastService = inject(ToastService);
  private readonly logger = inject(LoggerService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly RETRY_PENDING_SHOW_DELAY_MS = 1200;
  private readonly PENDING_CLEAR_DELAY_MS = 1500;
  private pendingShowTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingClearTimer: ReturnType<typeof setTimeout> | null = null;
  
  // 输入属性 - 是否使用紧凑模式
  compact = input(false);
  // 输入属性 - 是否使用嵌入模式（直接显示在侧边栏中）
  embedded = input(false);
  
  // 输出事件 - 打开冲突解决中心
  readonly openConflictCenterEvent = output<void>({ alias: 'openConflictCenter' });
  
  /** 用户是否已登录 */
  readonly isLoggedIn = computed(() => !!this.authService.currentUserId());
  
  // 状态
  showDeadLetters = signal(false);
  isExpanded = signal(false);
  /** 本地重试状态（用于禁用按钮防止重复点击） */
  isRetrying = signal(false);
  /** 重新同步状态 */
  isResyncing = signal(false);
  
  // 从服务获取状态
  /**
   * 用户可感知的待同步数量。
   * `focus-session` 由停泊坞后台自动快照推送周期性产生，不应把状态条抖成“1 待同步”。
   */
  readonly actionQueuePendingCount = computed(() =>
    this.actionQueue.pendingActions().filter(action => this.isUserVisiblePendingAction(action)).length
  );
  readonly retryQueuePendingCount = computed(() => this.syncService.syncState().pendingCount);
  readonly rawPendingCount = computed(() =>
    this.actionQueuePendingCount() + this.retryQueuePendingCount()
  );
  readonly pendingCount = signal(0);
  readonly deadLetterCount = this.actionQueue.deadLetterSize;
  readonly deadLetters = this.actionQueue.deadLetterQueue;
  readonly queueFrozen = this.actionQueue.queueFrozen;
  readonly legacyReviewCount = this.retryQueue.legacyReviewCount;

  constructor() {
    effect(() => {
      const actionPending = this.actionQueuePendingCount();
      const retryPending = this.retryQueuePendingCount();
      const current = this.pendingCount();
      const next = actionPending + retryPending;

      if (next === current) {
        return;
      }

      // 用户本地操作产生的待同步应立即反馈，避免交互延迟感。
      if (actionPending > 0) {
        this.clearPendingTimers();
        this.pendingCount.set(next);
        return;
      }

      // 后台重试队列的短促 0/1 波动会导致状态文案来回跳，做轻量防抖。
      if (next > current) {
        if (this.pendingShowTimer) {
          clearTimeout(this.pendingShowTimer);
        }
        this.pendingShowTimer = setTimeout(() => {
          this.pendingShowTimer = null;
          const latestActionPending = this.actionQueuePendingCount();
          const latestRetryPending = this.retryQueuePendingCount();
          if (latestActionPending === 0 && latestRetryPending > 0) {
            this.pendingCount.set(latestActionPending + latestRetryPending);
          }
        }, this.RETRY_PENDING_SHOW_DELAY_MS);
        return;
      }

      if (this.pendingClearTimer) {
        clearTimeout(this.pendingClearTimer);
      }
      this.pendingClearTimer = setTimeout(() => {
        this.pendingClearTimer = null;
        const latest = this.rawPendingCount();
        if (latest === 0) {
          this.pendingCount.set(0);
        }
      }, this.PENDING_CLEAR_DELAY_MS);
    });

    this.destroyRef.onDestroy(() => this.clearPendingTimers());
  }

  private clearPendingTimers(): void {
    if (this.pendingShowTimer) {
      clearTimeout(this.pendingShowTimer);
      this.pendingShowTimer = null;
    }
    if (this.pendingClearTimer) {
      clearTimeout(this.pendingClearTimer);
      this.pendingClearTimer = null;
    }
  }

  private isUserVisiblePendingAction(action: QueuedAction): boolean {
    return !SyncStatusComponent.BACKGROUND_PENDING_ENTITY_TYPES.has(action.entityType);
  }

  /**
   * 队列是否正在处理（原型方法）
   *
   * 【Bug Fix】从 class field 改为原型方法，与 gate-actions.component.ts 保持一致。
   * 原因：SW 缓存导致 chunk 不一致时，class field 可能未初始化，
   * 模板调用 isProcessing() 报 "n.isProcessing is not a function"。
   */
  isProcessing(): boolean {
    try {
      return this.actionQueue?.isProcessing?.() ?? false;
    } catch {
      return false;
    }
  }
  
  // 冲突仓库状态
  readonly conflictCount = this.conflictStorage.conflictCount;
  readonly hasUnresolvedConflicts = this.conflictStorage.hasUnresolvedConflicts;

  readonly isOnline = computed(() => this.syncService.syncState().isOnline);
  readonly isSyncing = computed(() => this.syncService.syncState().isSyncing);
  readonly syncError = computed(() => this.syncService.syncState().syncError);
  readonly offlineMode = computed(() => this.syncService.syncState().offlineMode);

  /** 状态点颜色（互斥优先级：同步中 > 失败 > 警告 > 正常） */
  readonly statusDotClass = computed(() => {
    if (this.isSyncing()) return 'bg-blue-500';
    if (
      this.deadLetterCount() > 0
      || this.queueFrozen()
      || this.legacyReviewCount() > 0
      || !!this.syncError()
      || this.conflictCount() > 0
    ) {
      return 'bg-red-500';
    }
    if (!this.isOnline() || this.offlineMode() || this.pendingCount() > 0 || !this.isLoggedIn()) return 'bg-amber-500';
    return 'bg-green-500';
  });
  
  /** 【新增】后台正在加载云端数据 */
  readonly isLoadingRemote = this.syncCoordinator.isLoadingRemote;
  
  /** 【新增】综合同步状态：正在推送或正在拉取 */
  readonly isAnySyncing = computed(() => this.isSyncing() || this.isLoadingRemote());
  
  // 计算属性 - 是否有需要关注的问题（包括 offlineMode 连接中断状态和冲突）
  readonly hasIssues = computed(() => 
    this.deadLetterCount() > 0 ||
    this.pendingCount() > 0 ||
    this.queueFrozen() ||
    this.legacyReviewCount() > 0 ||
    !!this.syncError() ||
    this.offlineMode() ||
    this.conflictCount() > 0
  );
  
  readonly totalIssues = computed(() => 
    this.deadLetterCount() +
    (this.pendingCount() > 0 ? 1 : 0) +
    (this.queueFrozen() ? 1 : 0) +
    (this.legacyReviewCount() > 0 ? 1 : 0) +
    (this.syncError() ? 1 : 0) +
    (this.offlineMode() ? 1 : 0) +
    this.conflictCount()
  );
  
  /**
   * 【Senior Consultant "Red Phone"】是否处于危险状态
   * 当死信队列有内容或待同步队列超过阈值时，显示紧急警告
   */
  readonly isCriticalState = computed(() => {
    const deadCount = this.deadLetterCount();
    const pendingCount = this.pendingCount();
    const criticalThreshold = Math.floor(SYNC_CONFIG.MAX_RETRY_QUEUE_SIZE * 0.8);
    return deadCount > 0 || pendingCount > criticalThreshold;
  });
  
  /**
   * 【增强】最近成功云同步时间（格式化）
   */
  readonly lastSyncTimeText = computed(() => {
    const lastSync = this.syncService.syncState().lastSyncTime;
    if (!lastSync) return null;
    return this.formatDate(lastSync);
  });

  /**
   * 【增强】队列冻结时的内存中操作计数
   * 队列冻结后新入队的操作仅存在于内存中，重启会丢失
   */
  readonly memoryOnlyCount = computed(() => {
    if (!this.queueFrozen()) return 0;
    return this.actionQueue.queueSize();
  });

  /**
   * 【增强】重试队列容量使用百分比
   */
  readonly retryQueueUsagePercent = computed(() => {
    return this.retryQueue.getCapacityPercent();
  });

  /** 详细状态文本 */
  readonly detailedStatus = computed(() => {
    if (this.isLoadingRemote()) {
      return '后台同步中...';
    }
    if (this.isSyncing()) {
      return '正在同步数据...';
    }
    if (this.queueFrozen()) {
      return '同步队列已冻结，请释放存储空间';
    }
    if (this.legacyReviewCount() > 0) {
      return `${this.legacyReviewCount()} 个旧版离线同步项待确认`;
    }
    if (this.deadLetterCount() > 0) {
      return `${this.deadLetterCount()} 个操作失败`;
    }
    if (this.syncError()) {
      return '同步错误';
    }
    if (this.conflictCount() > 0) {
      return `${this.conflictCount()} 个冲突待处理`;
    }
    if (this.pendingCount() > 0) {
      return `${this.pendingCount()} 个操作待同步`;
    }
    if (!this.isOnline()) {
      return '离线模式 - 数据保存在本地';
    }
    if (this.offlineMode()) {
      return '连接中断 - 恢复后自动同步';
    }
    if (!this.isLoggedIn()) {
      return '数据保存在本地 - 登录后可同步到云端';
    }
    return '数据已保存到云端';
  });
  
  /**
   * 切换展开状态
   */
  toggleExpand() {
    this.isExpanded.update(v => !v);
  }
  
  /**
   * 立即重试所有待处理操作
   *
   * 【根因修复 2026-04-22】过去只触发 ActionQueue.processQueue，
   * 当待同步项实际全部落在 RetryQueue（batch-sync 失败转交）时，
   * "立即同步" 按钮对 RetryQueue 无效 → 用户看到 "同步中..." 旋转但数字不降。
  * 这里并行触发 RetryQueue.processQueue；真正的 syncError 收口仍交给
  * RetryQueue / ActionQueue 自身的恢复信号链路，避免空队列点击把旧错误误清掉。
   */
  async retryAll() {
    // 防止重复点击
    if (this.isRetrying() || this.isProcessing()) return;

    this.isRetrying.set(true);
    try {
      await this.retryQueue.processQueue(undefined, true);
      await this.actionQueue.processQueue();
    } finally {
      this.isRetrying.set(false);
    }
  }
  
  /**
   * 重试单个死信
   */
  retryDeadLetter(itemId: string) {
    this.actionQueue.retryDeadLetter(itemId);
  }
  
  /**
   * 放弃单个死信
   */
  dismissDeadLetter(itemId: string) {
    this.actionQueue.dismissDeadLetter(itemId);
  }
  
  /**
   * 清空所有死信
   */
  clearAllDeadLetters() {
    this.actionQueue.clearDeadLetterQueue();
    this.showDeadLetters.set(false);
  }
  
  /**
   * 打开冲突解决中心
   * 发出事件让父组件处理（可能是打开模态框或导航到冲突页面）
   */
  openConflictCenter() {
    this.isExpanded.set(false);
    this.openConflictCenterEvent.emit();
  }
  
  /**
   * 重新同步当前项目
   * 智能合并而非暴力覆盖
   */
  async resyncProject() {
    if (this.isResyncing()) return;
    
    this.isResyncing.set(true);
    try {
      const result = await this.syncCoordinator.resyncActiveProject();
      
      if (result.success) {
        if (result.conflictDetected) {
          this.toastService.warning('同步完成', result.message, { duration: 5000 });
        } else {
          this.toastService.success('同步完成', result.message);
        }
      } else {
        this.toastService.error('同步失败', result.message);
      }
    } catch (_e) {
      this.toastService.error('同步错误', '重新同步时发生意外错误');
    } finally {
      this.isResyncing.set(false);
    }
  }
  
  /**
   * 【增强】导出待同步数据（逃生导出）
   */
  exportPendingData() {
    this.actionQueue.downloadEscapeExport();
  }

  /**
   * 获取操作的可读标签
   */
  getActionLabel(action: { type: string; entityType: string; entityId: string }): string {
    const typeLabels: Record<string, string> = {
      'create': '创建',
      'update': '更新',
      'delete': '删除'
    };
    const entityLabels: Record<string, string> = {
      'project': '项目',
      'task': '任务',
      'preference': '设置'
    };
    
    return `${typeLabels[action.type] || action.type} ${entityLabels[action.entityType] || action.entityType}`;
  }
  
  /**
   * 格式化日期
   */
  formatDate(isoString: string): string {
    const date = new Date(isoString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    
    if (diffMins < 1) return '刚刚';
    if (diffMins < 60) return `${diffMins} 分钟前`;
    
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours} 小时前`;
    
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays} 天前`;
  }
  
  /**
   * 【Senior Consultant "Red Phone"】紧急下载备份
   * 当同步严重滞后时，允许用户下载本地数据备份
   */
  async downloadBackup() {
    try {
      // 获取当前项目的本地数据
      const _activeProjectId = this.projectState.activeProjectId() || '';
      
      // 构建备份数据
      const backupData = {
        timestamp: new Date().toISOString(),
        version: '1.0',
        source: 'nanoflow-emergency-backup',
        pendingOperations: this.pendingCount(),
        failedOperations: this.deadLetterCount(),
        // 死信队列中的数据
        deadLetterQueue: this.deadLetters().map(item => ({
          type: item.action.type,
          entityType: item.action.entityType,
          entityId: item.action.entityId,
          failedAt: item.failedAt,
          reason: item.reason
        }))
      };
      
      // 创建下载文件
      const blob = new Blob([JSON.stringify(backupData, null, 2)], { 
        type: 'application/json' 
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `nanoflow-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      this.toastService.success('备份已下载', '请妥善保存备份文件');
    } catch (e) {
      this.toastService.error('下载失败', '无法创建备份文件');
      this.logger.error('SyncStatus', 'Backup download failed', e);
    }
  }
}
