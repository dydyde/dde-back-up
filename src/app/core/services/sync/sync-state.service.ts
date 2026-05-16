/**
 * SyncStateService - 同步状态管理
 * 
 * 职责：
 * - 维护同步状态 Signal
 * - 提供便捷的 computed 属性
 * - 处理会话过期逻辑
 * 
 * 从 SimpleSyncService 提取，作为 Sprint 3 技术债务修复的一部分
 */

import { Injectable, signal, computed } from '@angular/core';
import { Project } from '../../../../models';
import { SYNC_CONFIG } from '../../../../config/sync.config';

/**
 * 同步状态
 */
export interface SyncState {
  /** 是否正在同步 */
  isSyncing: boolean;
  /** 是否在线 */
  isOnline: boolean;
  /** 是否处于离线模式 */
  offlineMode: boolean;
  /** 会话是否过期 */
  sessionExpired: boolean;
  /** 上次同步时间 */
  lastSyncTime: string | null;
  /** 待处理的同步项数量 */
  pendingCount: number;
  /** 同步错误信息 */
  syncError: string | null;
  /**
   * 后台同步状态提示（信息级，非错误）。
   *
   * 与 `syncError` 完全解耦：
   * - `syncError`：用户必须知道、可能需要采取行动的真错误（终态冲突、队列已满、存储冻结等）
   * - `backgroundSyncNotice`：系统已经接管的可自愈状态（partial-handoff 等），UI 渲染为信息条而非红错
   *
   * 【2026-05-16 根因修复】此前 partial-handoff 走 `scheduleRecoverableSyncError` 落到 `syncError`，
   * 导致 UI 红条"部分同步失败，已进入重试队列"在 RetryQueue 自愈窗口里始终挂着，
   * 与"系统已接管"的语义矛盾。改走独立通道，让 UI 可以用合适的视觉等级渲染。
   */
  backgroundSyncNotice: string | null;
  /** 是否存在冲突 */
  hasConflict: boolean;
  /** 冲突数据 */
  conflictData: ConflictData | null;
}

/**
 * 冲突数据
 */
export interface ConflictData {
  /** 本地版本 */
  local: Project;
  /** 远程版本 */
  remote: Project;
  /** 项目 ID */
  projectId: string;
  /** 冲突实例时间戳，用于区分同项目的不同冲突轮次 */
  conflictedAt?: string;
  /** 冲突前已确认的待删除任务，解决冲突后仍需继续回放 */
  pendingTaskDeleteIds?: string[];
}

/**
 * 同步状态管理服务
 * 
 * 提供统一的同步状态访问和更新接口
 */
@Injectable({
  providedIn: 'root'
})
export class SyncStateService {
  private syncErrorListener: ((syncError: string | null) => void) | null = null;
  private pendingRecoverableSyncError: string | null = null;
  private recoverableSyncErrorTimer: ReturnType<typeof setTimeout> | null = null;
  
  /** 同步状态 Signal（内部可写，外部只读）*/
  private readonly _syncState = signal<SyncState>({
    isSyncing: false,
    isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
    offlineMode: false,
    sessionExpired: false,
    lastSyncTime: null,
    pendingCount: 0,
    syncError: null,
    backgroundSyncNotice: null,
    hasConflict: false,
    conflictData: null
  });

  /** 同步状态只读视图 */
  readonly syncState = this._syncState.asReadonly();

  /** 兼容旧接口：state 别名（只读）*/
  readonly state = this.syncState;

  /** 便捷 computed 属性 */
  readonly isOnline = computed(() => this.syncState().isOnline);
  readonly isSyncing = computed(() => this.syncState().isSyncing);
  readonly hasConflict = computed(() => this.syncState().hasConflict);
  readonly sessionExpired = computed(() => this.syncState().sessionExpired);
  readonly pendingCount = computed(() => this.syncState().pendingCount);
  readonly backgroundSyncNotice = computed(() => this.syncState().backgroundSyncNotice);

  /** 是否正在从远程加载（内部可写，外部只读）*/
  private readonly _isLoadingRemote = signal(false);
  readonly isLoadingRemote = this._isLoadingRemote.asReadonly();

  /**
   * 更新同步状态
   */
  update(partial: Partial<SyncState>): void {
    this._syncState.update(state => ({ ...state, ...partial }));
  }
  
  /**
   * 设置是否正在同步
   */
  setSyncing(isSyncing: boolean): void {
    this.update({ isSyncing });
  }
  
  /**
   * 设置在线状态
   */
  setOnline(isOnline: boolean): void {
    this.update({ isOnline });
  }
  
  /**
   * 设置离线模式
   */
  setOfflineMode(offlineMode: boolean): void {
    this.update({ offlineMode });
  }
  
  /**
   * 设置会话过期
   */
  setSessionExpired(sessionExpired: boolean): void {
    this.update({ sessionExpired });
  }
  
  /**
   * 重置会话过期状态
   */
  resetSessionExpired(): void {
    this.update({ sessionExpired: false });
  }
  
  /**
   * 设置上次同步时间
   */
  setLastSyncTime(lastSyncTime: string | null): void {
    this.update({ lastSyncTime });
  }

  /**
   * 空闲检测器：返回 true 表示 ActionQueue/RetryQueue 均已排空，可推进 lastSyncTime。
   * 由 SimpleSyncService 在初始化时注册，避免 SyncStateService 反向依赖队列实例。
   */
  private idleChecker: (() => boolean) | null = null;

  /**
   * 注册空闲检测器。重复调用会覆盖旧实例（切账号场景）。
   */
  registerIdleChecker(checker: () => boolean): void {
    this.idleChecker = checker;
  }

  private isSyncStateIdle(): boolean {
    return !this.idleChecker || this.idleChecker();
  }

  /**
   * 条件推进 lastSyncTime：仅当检测器返回 true（或未注册）时更新。
   * 返回 true 表示已写入，false 表示被门禁拦截。
   *
   * 【根因修复 2026-04-21】修复移动端侧边栏"最后同步 刚刚 + 86 待同步"矛盾：
   * 原实现 doTaskPush / batch-sync 每次单项成功即无条件推进时间戳，
   * 但此时 RetryQueue 中可能仍有大量失败残留（连接/黑匣子）。
   * 改为门禁模式后，"刚刚"语义回归真实（全部队列空才算一次完整同步）。
   */
  advanceLastSyncTimeIfIdle(lastSyncTime: string): boolean {
    if (!this.isSyncStateIdle()) {
      return false;
    }
    this.update({ lastSyncTime });
    return true;
  }

  /**
   * 仅当 ActionQueue/RetryQueue 都排空时，同时推进 lastSyncTime 并清空 syncError。
   * 用于真实恢复路径（例如 RetryQueue 回放成功后的最终收口），避免旧错误文案在
   * 远端已经 200 成功后继续停留在 UI 上。
   */
  markSyncRecoveredIfIdle(lastSyncTime: string): boolean {
    if (!this.isSyncStateIdle()) {
      return false;
    }
    this.clearPendingRecoverableSyncError();
    this.update({ lastSyncTime, syncError: null, backgroundSyncNotice: null });
    return true;
  }

  /**
   * 设置待处理数量
   */
  setPendingCount(pendingCount: number): void {
    this.update({ pendingCount });
  }
  
  /**
   * 增加待处理数量
   */
  incrementPendingCount(): void {
    this.update({ pendingCount: this.syncState().pendingCount + 1 });
  }
  
  /**
   * 减少待处理数量
   */
  decrementPendingCount(): void {
    const current = this.syncState().pendingCount;
    this.update({ pendingCount: Math.max(0, current - 1) });
  }
  
  /**
   * 设置同步错误
   */
  setSyncError(syncError: string | null): void {
    this.clearPendingRecoverableSyncError();
    this.writeSyncError(syncError);
  }

  /**
   * 设置后台同步状态提示（信息级，非错误）。
   *
   * 此通道用于"系统已经接管自愈"的状态信号（如 partial-handoff），
   * UI 应渲染为信息条而非红色 critical。与 `syncError` 互不影响。
   *
   * 传入 `null` 等价于 `clearBackgroundSyncNotice()`。
   */
  setBackgroundSyncNotice(notice: string | null): void {
    this.update({ backgroundSyncNotice: notice });
  }

  /**
   * 清空后台同步状态提示。
   *
   * 由成功路径（batch-sync 整体成功、markSyncRecoveredIfIdle）配对调用，
   * 确保 notice 不会在自愈完成后继续残留。
   */
  clearBackgroundSyncNotice(): void {
    if (this.syncState().backgroundSyncNotice === null) {
      return;
    }
    this.update({ backgroundSyncNotice: null });
  }

  /**
   * @deprecated 自 2026-05-16 起改为转发到 {@link setBackgroundSyncNotice}。
   *
   * 历史语义是"延迟落地可自愈的同步错误"，宽限期内可被恢复路径取消，否则写入 `syncError`。
   * 但 partial-handoff 本质上不是错误而是后台自愈状态，写入 `syncError` 会被 UI 渲染成红色 critical，
   * 与"系统已接管"的语义矛盾。新通道 `backgroundSyncNotice` 立即落地、不写入 `syncError`，
   * 也无须宽限期（UI 已经按信息级渲染，不会误导用户）。
   *
   * 保留方法签名仅为避免 spec 改动爆炸。新代码请直接调用 `setBackgroundSyncNotice`。
   */
  scheduleRecoverableSyncError(
    syncError: string,
    _delayMs = SYNC_CONFIG.DEBOUNCE_DELAY,
  ): void {
    // 中文注释：转发到新通道。原本的 pendingRecoverableSyncError 计时器机制不再需要
    // —— 后台 notice 立即可见但视觉等级是信息条，不存在"先静默观察再升级为红错"的需求。
    this.clearPendingRecoverableSyncError();
    this.setBackgroundSyncNotice(syncError);
  }

  clearPendingRecoverableSyncError(): void {
    if (this.recoverableSyncErrorTimer) {
      clearTimeout(this.recoverableSyncErrorTimer);
      this.recoverableSyncErrorTimer = null;
    }
    this.pendingRecoverableSyncError = null;
  }

  private writeSyncError(syncError: string | null): void {
    this.update({ syncError });
    this.syncErrorListener?.(syncError);
  }

  registerSyncErrorListener(listener: (syncError: string | null) => void): void {
    this.syncErrorListener = listener;
  }
  
  /**
   * 设置冲突状态
   */
  setConflict(conflictData: ConflictData): void {
    this.update({
      hasConflict: true,
      conflictData
    });
  }
  
  /**
   * 清除冲突状态
   */
  clearConflict(): void {
    this.update({
      hasConflict: false,
      conflictData: null
    });
  }
  
  /**
   * 设置正在加载远程数据
   */
  setLoadingRemote(loading: boolean): void {
    this._isLoadingRemote.set(loading);
  }

  /**
   * 检查会话是否已过期
   * 返回 boolean 而非 Signal，便于在非响应式代码中使用
   */
  isSessionExpired(): boolean {
    return this.syncState().sessionExpired;
  }
}
