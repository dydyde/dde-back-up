import { Injectable, inject, signal, DestroyRef } from '@angular/core';
import { QUEUE_CONFIG } from '../config';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { SentryAlertService } from './sentry-alert.service';
import { extractErrorMessage } from '../utils/result';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { ActionQueueStorageService, LOCAL_QUEUE_CONFIG, type QueueRetryError } from './action-queue-storage.service';
import { RetryQueueService, type RetryableEntityType } from '../core-bridge';
import { AuthService } from './auth.service';
import { WriteGuardService } from './write-guard.service';
import { SyncWriterLeaseService, type LeaseHandle } from './sync-writer-lease.service';
import { AUTH_CONFIG } from '../config/auth.config';
import {
  OperationPriority, 
  ProjectPayload,
  TaskPayload, 
  TaskDeletePayload, 
  QueuedAction,
  EnqueueParams,
  DeadLetterItem
} from './action-queue.types';

const SYNC_WRITER_LEASE_PROJECT_SCOPE = '__global__';
const SYNC_WRITER_LEASE_WAIT_MS = 5_000;

// 重新导出类型供外部使用
export type { 
  OperationPriority, 
  ActionPayload, 
  ProjectPayload, 
  ProjectDeletePayload, 
  TaskPayload, 
  TaskDeletePayload, 
  PreferencePayload,
  QueuedAction,
  EnqueueParams,
  DeadLetterItem
} from './action-queue.types';

export type DeferredActionQueueRetry = {
  outcome: 'defer-retry';
  error: QueueRetryError;
};

export type FailedActionQueueRetry = {
  outcome: 'failed';
  error: QueueRetryError;
};

export type ActionQueueProcessorResult = boolean | DeferredActionQueueRetry | FailedActionQueueRetry;

/**
 * 离线操作队列服务
 * 负责存储失败的变更操作，网络恢复后自动重试
 * 实现离线优先架构的可靠性保证
 * 
 * 存储/死信/网络/重试逻辑委托给 ActionQueueStorageService
 */
@Injectable({
  providedIn: 'root'
})
export class ActionQueueService {
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('ActionQueue');
  private readonly toast = inject(ToastService);
  private readonly sentryAlert = inject(SentryAlertService);
  private readonly authService = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);
  /**
   * 写入闸门：迁移期 export-only / read-only 部署 gate 云端 flush。
   * 标记 optional：测试 harness 通常不提供，保持向后兼容。
   * 缺失时默认为可写（与迁移前行为一致）。
   */
  private readonly writeGuard = inject(WriteGuardService, { optional: true });
  private readonly syncWriterLease = inject(SyncWriterLeaseService, { optional: true });
  readonly storage = inject(ActionQueueStorageService);
  /** 跨队列去重：当新操作入队时移除 RetryQueue 中同一实体的旧重试 */
  private readonly retryQueue = inject(RetryQueueService);
  
  /** 待处理队列 */
  readonly pendingActions = signal<QueuedAction[]>([]);
  
  /** 死信队列 — 委托给 storage */
  readonly deadLetterQueue = this.storage.deadLetterQueue;
  
  /** 是否正在处理队列 */
  readonly isProcessing = signal(false);
  
  /** 队列大小 */
  readonly queueSize = signal(0);
  
  /** 死信队列大小 — 委托给 storage */
  readonly deadLetterSize = this.storage.deadLetterSize;
  
  /** 存储失败状态 — 委托给 storage */
  readonly storageFailure = this.storage.storageFailure;
  /** 队列冻结状态（配额/存储压力） */
  readonly queueFrozen = this.storage.queueFrozen;
  
  // 【Sentry 上下文】手动同步队列状态到 Sentry
  private syncSentryContext(): void {
    const queueLength = this.pendingActions().length;
    const deadLetterCount = this.deadLetterQueue().length;
    
    this.sentryAlert.updateSyncContext({
      actionQueueLength: queueLength,
      pendingActions: queueLength,
      deadLetterCount: deadLetterCount,
    });
  }
  
  /** 处理器函数映射 */
  private processors: Map<string, (action: QueuedAction) => Promise<ActionQueueProcessorResult>> = new Map();
  
  /** 队列处理生命周期回调 */
  private onQueueProcessStart: (() => void) | null = null;
  private onQueueProcessEnd: (() => void) | null = null;
  private onQueueProcessSettled: ((summary: { processed: number; failed: number; movedToDeadLetter: number; remaining: number; remoteSuccessCount: number; resolvedNoOpCount: number }) => void) | null = null;
  /** 当前处理轮次中真正完成远端写入的 action，按 process token 隔离 */
  private remotelySyncedActionIdsByToken = new Map<number, Set<string>>();
  /** 当前处理轮次中被权威 no-op 收口的 action，按 process token 隔离 */
  private locallyResolvedActionIdsByToken = new Map<number, Set<string>>();
  private actionProcessTokenById = new Map<string, number>();
  /** 当前可见队列/死信视图的代次；切账号或强制清空时递增，使旧处理循环失效 */
  private queueViewGeneration = 0;
  /** project mutation 级别的局部失效代次；仅用于截断同项目的旧 project processor 收尾 */
  private projectMutationViewGeneration = 0;
  private projectMutationViewByKey = new Map<string, number>();
  /** 记录每次视图失效的 stale 处理策略，供旧循环返回后决定如何收口 */
  private queueInvalidations: Array<{ generation: number; stalePolicy: 'discard' | 'settle-owner' }> = [];
  /** 真实 in-flight 处理循环 token，用于切账号时立即释放旧生命周期 */
  private activeProcessTokens = new Set<number>();
  private nextProcessLifecycleToken = 0;
  /** 压力模式通知节流 */
  private readonly QUEUE_PRESSURE_NOTICE_COOLDOWN = 60_000;
  private lastQueuePressureNoticeAt = 0;
  /** 冻结状态下尝试持久化的最小间隔 */
  private readonly FROZEN_PERSIST_RETRY_COOLDOWN = 30_000;
  private lastFrozenPersistAttemptAt = 0;

  /** RetryQueue 可识别的实体类型集合，用于跨队列去重判定 */
  private static readonly RETRYABLE_ENTITY_TYPES: ReadonlySet<string> = new Set<string>([
    'task',
    'project',
    'connection',
    'blackbox',
  ]);

  private isRetryableEntityType(entityType: string): boolean {
    return ActionQueueService.RETRYABLE_ENTITY_TYPES.has(entityType);
  }
  
  constructor() {
    // 初始化 storage 上下文引用
    this.storage.init({
      dequeue: (id) => this.dequeue(id),
      syncSentryContext: () => this.syncSentryContext(),
      processQueue: () => this.processQueue(),
      pendingActions: this.pendingActions,
      queueSize: this.queueSize,
    });
    
    this.storage.loadQueueFromStorage();
    this.storage.loadDeadLetterFromStorage();
    this.storage.setupNetworkListeners();
    
    this.destroyRef.onDestroy(() => this.storage.removeNetworkListeners());
  }
  
  // ========== 公共方法 ==========
  
  /**
   * 注册操作处理器
   */
  registerProcessor(type: string, processor: (action: QueuedAction) => Promise<ActionQueueProcessorResult>) {
    this.processors.set(type, processor);
    this.logger.debug('处理器已注册', { type });
  }

  deferRetry(error: QueueRetryError): DeferredActionQueueRetry {
    return {
      outcome: 'defer-retry',
      error,
    };
  }

  failRetry(error: QueueRetryError): FailedActionQueueRetry {
    return {
      outcome: 'failed',
      error,
    };
  }
  
  /**
   * 验证所有必需的处理器是否已注册
   */
  validateProcessors(requiredProcessors: string[]): string[] {
    const missing = requiredProcessors.filter(type => !this.processors.has(type));
    if (missing.length > 0) {
      this.logger.error('缺少必需的处理器', { missing });
    }
    return missing;
  }
  
  /**
   * 获取已注册的处理器类型列表（用于调试）
   */
  getRegisteredProcessorTypes(): string[] {
    return Array.from(this.processors.keys());
  }

  private isDeferredProcessorResult(result: ActionQueueProcessorResult): result is DeferredActionQueueRetry {
    return typeof result === 'object' && result !== null && result.outcome === 'defer-retry';
  }

  private isFailedProcessorResult(result: ActionQueueProcessorResult): result is FailedActionQueueRetry {
    return typeof result === 'object' && result !== null && result.outcome === 'failed';
  }

  private getProcessorRetryError(result: ActionQueueProcessorResult): QueueRetryError | null {
    if (this.isDeferredProcessorResult(result) || this.isFailedProcessorResult(result)) {
      return result.error;
    }

    return null;
  }
  
  /** 注册失败通知回调 */
  onFailure(callback: (item: DeadLetterItem) => void) {
    this.storage.onFailure(callback);
  }
  
  /** 注册存储失败回调（逃生模式） */
  onStorageFailure(callback: (data: { queue: QueuedAction[]; deadLetter: DeadLetterItem[] }) => void) {
    this.storage.onStorageFailure(callback);
  }
  
  /** 导出待同步数据为 JSON 并下载（逃生导出，冻结时使用） */
  downloadEscapeExport(): void {
    this.storage.downloadEscapeExport();
  }
  
  /**
   * 添加操作到队列（类型安全版本）
   * 支持优先级分级 + 智能合并
   */
  enqueue(action: EnqueueParams): string {
    return this.enqueueInternal(action, true, true);
  }

  async enqueueDurably(action: EnqueueParams): Promise<string> {
    return this.enqueueDurablyInternal(action, true);
  }

  private async enqueueDurablyInternal(action: EnqueueParams, removeRetrySourceOnSuccess: boolean): Promise<string> {
    const previousQueue = [...this.pendingActions()];
    const actionId = this.enqueueInternal(action, false, false);
    if (!actionId) {
      return '';
    }

    const persisted = await this.storage.persistQueueSnapshotForOwner(
      this.getCurrentOwnerUserId(),
      this.pendingActions(),
    );
    if (!persisted) {
      this.pendingActions.set(previousQueue);
      this.queueSize.set(previousQueue.length);
      this.syncSentryContext();
      this.logger.warn('ActionQueue durable enqueue 未能完成持久化确认', {
        actionId,
        entityType: action.entityType,
        entityId: action.entityId,
      });
      return '';
    }

    if (removeRetrySourceOnSuccess && this.isRetryableEntityType(action.entityType)) {
      this.retryQueue.removeByEntity(action.entityType as RetryableEntityType, action.entityId);
    }

    if (this.storage.isOnline) {
      void this.processQueue();
    }

    return actionId;
  }

  async enqueueDurablyForOwner(ownerUserId: string, action: EnqueueParams): Promise<string> {
    if (ownerUserId === this.getCurrentOwnerUserId()) {
      return this.enqueueDurablyInternal(action, false);
    }

    const queuedAction = this.createQueuedAction(action);
    const existingQueue = await this.storage.loadQueueSnapshotForOwner(ownerUserId);
    const nextQueue = [...existingQueue];
    const existingIndex = nextQueue.findIndex(existing =>
      existing.entityType === action.entityType &&
      existing.entityId === action.entityId &&
      existing.retryCount === 0
    );

    let actionId = queuedAction.id;
    if (existingIndex !== -1) {
      const existing = nextQueue[existingIndex];

      if (existing.type === 'delete' && (action.type === 'update' || action.type === 'create')) {
        this.logger.debug('忽略 foreign-owner 队列中已删除实体的操作', {
          ownerUserId,
          entityType: action.entityType,
          entityId: action.entityId,
        });
        return '';
      }

      if (existing.type === 'update' && action.type === 'update') {
        nextQueue[existingIndex] = { ...this.mergeQueuedAction(existing, queuedAction), id: existing.id };
        actionId = existing.id;
      } else if (existing.type === 'create' && action.type === 'update') {
        nextQueue[existingIndex] = {
          ...this.mergeQueuedAction(existing, queuedAction),
          type: 'create',
          id: existing.id,
        };
        actionId = existing.id;
      } else if (existing.type === 'create' && action.type === 'delete') {
        nextQueue.splice(existingIndex, 1);
        actionId = existing.id;
      } else {
        nextQueue.push(queuedAction);
      }
    } else {
      nextQueue.push(queuedAction);
    }

    const persisted = await this.storage.persistQueueSnapshotForOwner(ownerUserId, nextQueue);
    if (!persisted) {
      this.logger.warn('foreign-owner ActionQueue durable enqueue 未能完成持久化确认', {
        ownerUserId,
        actionId,
        entityType: action.entityType,
        entityId: action.entityId,
      });
      return '';
    }

    this.logger.info('已将离线操作 durably 写入指定 owner 队列', {
      ownerUserId,
      actionId,
      type: queuedAction.type,
      entityType: queuedAction.entityType,
      entityId: queuedAction.entityId,
    });
    return actionId;
  }

  private enqueueInternal(action: EnqueueParams, autoProcess: boolean, dedupeRetry: boolean): string {
    if (this.storage.queueFrozen()) {
      this.logger.warn('队列处于冻结状态，改为内存兜底接收写入', {
        type: action.type,
        entityType: action.entityType,
        entityId: action.entityId,
        reason: this.storage.queueFreezeReason()
      });
      this.notifyQueuePressureOnce('同步队列存储受限', '当前写入先保存在内存中，请尽快释放浏览器存储空间');
    }

    const queuedAction = this.createQueuedAction(action);
    let resolvedActionId = queuedAction.id;
    let wasEnqueued = false;
    /** 智能合并导致队列缩小（如 create+delete 取消） */
    let wasMergeShrunk = false;

    this.pendingActions.update(queue => {
      const newQueue = [...queue];

      // ========== 智能合并：对同一实体的操作去重 ==========
      const existingIndex = newQueue.findIndex(a =>
        a.entityType === action.entityType &&
        a.entityId === action.entityId &&
        a.retryCount === 0
      );

      if (existingIndex !== -1) {
        const existing = newQueue[existingIndex];

        // 场景1: 队列中有delete，新操作是update/create → 忽略
        if (existing.type === 'delete' && (action.type === 'update' || action.type === 'create')) {
          this.logger.debug(`忽略已删除实体的操作`, { entityType: action.entityType, entityId: action.entityId });
          resolvedActionId = '';
          return queue;
        }

        // 场景2: 两个update → 合并为一次
        if (existing.type === 'update' && action.type === 'update') {
          this.logger.debug(`合并重复的update操作`, { entityType: action.entityType, entityId: action.entityId });
          newQueue[existingIndex] = { ...this.mergeQueuedAction(existing, queuedAction), id: existing.id };
          resolvedActionId = existing.id;
          wasEnqueued = true;
          return newQueue;
        }

        // 场景3: create + update → 合并到create中
        if (existing.type === 'create' && action.type === 'update') {
          this.logger.debug(`合并create后的update`, { entityType: action.entityType, entityId: action.entityId });
          newQueue[existingIndex] = {
            ...this.mergeQueuedAction(existing, queuedAction),
            type: 'create',
            id: existing.id,
          };
          resolvedActionId = existing.id;
          wasEnqueued = true;
          return newQueue;
        }

        // 场景4: create + delete → 直接移除create
        if (existing.type === 'create' && action.type === 'delete') {
          this.logger.debug(`取消未同步的create操作`, { entityType: action.entityType, entityId: action.entityId });
          newQueue.splice(existingIndex, 1);
          resolvedActionId = '';
          wasMergeShrunk = true;
          return newQueue;
        }
      }

      const softLimit = LOCAL_QUEUE_CONFIG.MAX_QUEUE_SIZE;
      const absoluteLimit = softLimit * 5;
      if (newQueue.length >= absoluteLimit) {
        this.logger.error('队列达到绝对上限，拒绝新操作入队', {
          absoluteLimit,
          rejectedType: action.type,
          rejectedEntityType: action.entityType,
          rejectedEntityId: action.entityId
        });
        this.notifyQueuePressureOnce('同步队列超限', '已达保护上限，请先完成同步后再重试');
        resolvedActionId = '';
        return queue;
      }

      if (newQueue.length >= softLimit) {
        this.logger.warn('队列达到软上限，进入压力模式但继续入队', {
          softLimit,
          queueSize: newQueue.length,
          maxSize: LOCAL_QUEUE_CONFIG.MAX_QUEUE_SIZE,
          type: action.type,
          entityType: action.entityType
        });
        this.notifyQueuePressureOnce('同步队列压力较高', '仍在接收写入，建议尽快联网完成同步');
      }

      // 正常添加
      newQueue.push(queuedAction);
      wasEnqueued = true;
      return newQueue;
    });

    // 智能合并导致队列缩小时，同步 queueSize 并持久化
    if (wasMergeShrunk) {
      this.queueSize.set(this.pendingActions().length);
      this.persistQueue();
      this.syncSentryContext();
      return resolvedActionId;
    }

    if (!wasEnqueued) {
      return resolvedActionId;
    }

    this.queueSize.set(this.pendingActions().length);
    this.persistQueue();
    this.syncSentryContext();

    // 跨队列去重：新操作入队后，移除 RetryQueue 中同一实体的旧重试条目
    // 因为新操作的数据更新，旧的重试一旦成功反而会用过时数据覆盖
    // 【2026-04-21 漏洞 A 修复】原实现仅覆盖 task/project，扩展至 connection/blackbox，
    // 避免连接/黑匣子在重试队列中堆积陈旧副本，导致"86 待同步"虚高。
    if (dedupeRetry && this.isRetryableEntityType(action.entityType)) {
      this.retryQueue.removeByEntity(action.entityType as RetryableEntityType, action.entityId);
    }
    
    // Sentry breadcrumb
    this.sentryLazyLoader.addBreadcrumb({
      category: 'sync',
      message: `Action enqueued: ${action.type} ${action.entityType}`,
      level: 'info',
      data: {
        actionId: resolvedActionId,
        entityType: action.entityType,
        entityId: action.entityId,
        type: action.type,
        priority: queuedAction.priority,
        queueSize: this.pendingActions().length
      }
    });
    
    if (autoProcess && this.storage.isOnline) {
      void this.processQueue();
    }
    
    return resolvedActionId;
  }

  async enqueueForOwner(ownerUserId: string, action: EnqueueParams): Promise<string> {
    if (ownerUserId === this.getCurrentOwnerUserId()) {
      return this.enqueue(action);
    }

    const queuedAction = this.createQueuedAction(action);
    await this.storage.appendActionForOwner(ownerUserId, queuedAction);
    this.logger.info('已将离线操作写入指定 owner 队列', {
      ownerUserId,
      actionId: queuedAction.id,
      type: queuedAction.type,
      entityType: queuedAction.entityType,
      entityId: queuedAction.entityId,
    });
    return queuedAction.id;
  }

  private notifyQueuePressureOnce(title: string, message: string): void {
    const now = Date.now();
    if (now - this.lastQueuePressureNoticeAt < this.QUEUE_PRESSURE_NOTICE_COOLDOWN) {
      return;
    }
    this.lastQueuePressureNoticeAt = now;
    this.toast.warning(title, message);
  }

  private persistQueue(): void {
    const isFrozen = this.storage.queueFrozen();
    const now = Date.now();
    if (isFrozen && now - this.lastFrozenPersistAttemptAt < this.FROZEN_PERSIST_RETRY_COOLDOWN) {
      return;
    }

    if (isFrozen) {
      this.lastFrozenPersistAttemptAt = now;
    }
    this.storage.saveQueueToStorage();
  }
  
  /**
   * 从队列中移除操作
   */
  dequeue(actionId: string) {
    this.pendingActions.update(queue => queue.filter(a => a.id !== actionId));
    this.queueSize.set(this.pendingActions().length);
    this.storage.saveQueueToStorage();
    this.syncSentryContext();
  }
  
  /**
   * 设置队列处理生命周期回调
   */
  setQueueProcessCallbacks(
    onStart: () => void,
    onEnd: () => void,
    onSettled?: (summary: { processed: number; failed: number; movedToDeadLetter: number; remaining: number; remoteSuccessCount: number; resolvedNoOpCount: number }) => void
  ) {
    this.onQueueProcessStart = onStart;
    this.onQueueProcessEnd = onEnd;
    this.onQueueProcessSettled = onSettled ?? null;
  }

  markActionSyncedRemotely(actionId: string): void {
    const processToken = this.actionProcessTokenById.get(actionId);
    if (processToken === undefined) {
      return;
    }

    let actionIds = this.remotelySyncedActionIdsByToken.get(processToken);
    if (!actionIds) {
      actionIds = new Set<string>();
      this.remotelySyncedActionIdsByToken.set(processToken, actionIds);
    }
    actionIds.add(actionId);
  }

  markActionResolvedWithoutRemote(actionId: string): void {
    const processToken = this.actionProcessTokenById.get(actionId);
    if (processToken === undefined) {
      return;
    }

    let actionIds = this.locallyResolvedActionIdsByToken.get(processToken);
    if (!actionIds) {
      actionIds = new Set<string>();
      this.locallyResolvedActionIdsByToken.set(processToken, actionIds);
    }
    actionIds.add(actionId);
  }

  private getCurrentOwnerUserId(): string {
    return this.authService.currentUserId() ?? AUTH_CONFIG.LOCAL_MODE_USER_ID;
  }

  private isSyncWriterLeaseRequired(): boolean {
    try {
      return this.syncWriterLease?.isFeatureEnabled() === true;
    } catch {
      return false;
    }
  }

  private async acquireSyncWriterLease(): Promise<LeaseHandle | null> {
    if (!this.syncWriterLease) {
      return null;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SYNC_WRITER_LEASE_WAIT_MS);
    let leaseHandle: LeaseHandle | null = null;
    try {
      leaseHandle = await this.syncWriterLease.requestLease({
        userId: this.getCurrentOwnerUserId(),
        projectId: SYNC_WRITER_LEASE_PROJECT_SCOPE,
        signal: controller.signal,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('sync writer lease 获取失败，本轮 ActionQueue flush 已延后', { message });
    } finally {
      clearTimeout(timeout);
    }

    return leaseHandle;
  }

  private createQueuedAction(action: EnqueueParams): QueuedAction {
    const defaultPriority: OperationPriority = 
      action.entityType === 'project' || action.entityType === 'focus-session' ? 'critical' :
      action.entityType === 'preference' ? 'low' : 'normal';

    return {
      ...action,
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      retryCount: 0,
      priority: action.priority ?? defaultPriority
    };
  }

  private mergeProjectPayload(
    existingPayload: ProjectPayload,
    nextPayload: ProjectPayload,
  ): ProjectPayload {
    return {
      ...nextPayload,
      sourceUserId: nextPayload.sourceUserId ?? existingPayload.sourceUserId,
      taskIdsToDelete: nextPayload.taskIdsToDelete,
    };
  }

  private mergeQueuedAction(existing: QueuedAction, next: QueuedAction): QueuedAction {
    if (existing.entityType !== 'project' || next.entityType !== 'project') {
      return next;
    }

    return {
      ...next,
      payload: this.mergeProjectPayload(
        existing.payload as ProjectPayload,
        next.payload as ProjectPayload,
      ),
    };
  }

  private beginQueueProcessLifecycle(): number {
    const token = ++this.nextProcessLifecycleToken;
    const shouldNotifyStart = this.activeProcessTokens.size === 0;
    this.activeProcessTokens.add(token);
    if (shouldNotifyStart) {
      this.onQueueProcessStart?.();
    }
    return token;
  }

  private endQueueProcessLifecycle(token: number): void {
    if (!this.activeProcessTokens.delete(token)) {
      return;
    }

    if (this.activeProcessTokens.size === 0) {
      this.onQueueProcessEnd?.();
    }
  }

  private releaseAllQueueProcessLifecycles(reason: string): void {
    if (this.activeProcessTokens.size === 0) {
      return;
    }

    this.activeProcessTokens.clear();
    this.logger.debug('强制释放旧队列处理生命周期', { reason });
    this.onQueueProcessEnd?.();
  }

  private invalidateQueueView(
    reason: string,
    stalePolicy: 'discard' | 'settle-owner' = 'discard'
  ): number {
    this.queueViewGeneration += 1;
    this.queueInvalidations.push({ generation: this.queueViewGeneration, stalePolicy });
    if (this.queueInvalidations.length > 16) {
      this.queueInvalidations = this.queueInvalidations.slice(-16);
    }
    this.logger.debug('队列视图已失效，旧处理循环将停止收尾', {
      reason,
      generation: this.queueViewGeneration,
      stalePolicy,
    });
    return this.queueViewGeneration;
  }

  private isStaleProcess(processGeneration: number): boolean {
    return processGeneration !== this.queueViewGeneration;
  }

  getCurrentQueueViewGeneration(): number {
    return this.queueViewGeneration;
  }

  isQueueViewCurrent(queueViewGeneration: number, ownerUserId?: string | null): boolean {
    if (queueViewGeneration !== this.queueViewGeneration) {
      return false;
    }

    if (typeof ownerUserId === 'string') {
      return this.getCurrentOwnerUserId() === ownerUserId;
    }

    return true;
  }

  getProjectMutationViewGeneration(projectId: string, ownerUserId?: string | null): number {
    const key = this.getProjectMutationViewKey(projectId, ownerUserId);
    return this.projectMutationViewByKey.get(key) ?? 0;
  }

  invalidateProjectMutationView(projectId: string, ownerUserId?: string | null): number {
    const resolvedOwnerUserId = ownerUserId ?? this.getCurrentOwnerUserId();
    const key = this.getProjectMutationViewKey(projectId, resolvedOwnerUserId);
    const generation = ++this.projectMutationViewGeneration;
    this.projectMutationViewByKey.set(key, generation);
    if (this.projectMutationViewByKey.size > 128) {
      const oldestKey = this.projectMutationViewByKey.keys().next().value as string | undefined;
      if (oldestKey) {
        this.projectMutationViewByKey.delete(oldestKey);
      }
    }

    this.logger.debug('项目 mutation 视图已失效，旧 project processor 将停止收尾', {
      projectId,
      ownerUserId: resolvedOwnerUserId,
      generation,
    });
    return generation;
  }

  private getProjectMutationViewKey(projectId: string, ownerUserId?: string | null): string {
    return `${ownerUserId ?? this.getCurrentOwnerUserId()}::${projectId}`;
  }

  private getStaleProcessPolicy(processGeneration: number): 'discard' | 'settle-owner' {
    return [...this.queueInvalidations]
      .reverse()
      .find(entry => entry.generation > processGeneration)?.stalePolicy ?? 'discard';
  }

  private async settleStaleActionResult(
    processGeneration: number,
    processOwnerUserId: string,
    action: QueuedAction,
    outcome: { success: true } | { success: false; error: QueueRetryError }
  ): Promise<void> {
    const stalePolicy = this.getStaleProcessPolicy(processGeneration);
    if (stalePolicy !== 'settle-owner') {
      this.logger.debug('旧处理循环结果已丢弃（非 owner 切换场景）', {
        actionId: action.id,
        processOwnerUserId,
        stalePolicy,
      });
      return;
    }

    if (outcome.success) {
      if (action.entityType === 'project' && action.type === 'delete') {
        const removedCount = await this.storage.settleProjectDeleteSuccessForOwner(
          processOwnerUserId,
          action.entityId,
          action.id,
        );
        this.logger.debug('旧 owner 的项目删除已在持久化队列中收口', {
          actionId: action.id,
          processOwnerUserId,
          projectId: action.entityId,
          removedCount,
        });
        return;
      }

      await this.storage.settleSuccessfulActionForOwner(processOwnerUserId, action.id);
      this.logger.debug('旧 owner 的成功 action 已在持久化队列中收口', {
        actionId: action.id,
        processOwnerUserId,
      });
      return;
    }

    if (!outcome.success) {
      const settleResult = await this.storage.settleFailedActionForOwner(
        processOwnerUserId,
        action,
        outcome.error
      );
      this.logger.debug('旧 owner 的失败 action 已在持久化队列中收口', {
        actionId: action.id,
        processOwnerUserId,
        settleResult,
      });
    }
  }

  async settleProjectDeleteSuccessForOwner(
    ownerUserId: string,
    projectId: string,
    actionId?: string,
  ): Promise<number> {
    if (ownerUserId === this.getCurrentOwnerUserId()) {
      return this.discardActions(action => {
        if (actionId && action.id === actionId) {
          return false;
        }

        if (action.entityType === 'project' && action.entityId === projectId) {
          return true;
        }

        if (action.entityType === 'task') {
          const payload = action.payload as TaskPayload | TaskDeletePayload;
          return payload.projectId === projectId;
        }

        return false;
      });
    }

    return await this.storage.settleProjectDeleteSuccessForOwner(ownerUserId, projectId, actionId);
  }
  
  /**
   * 处理队列中的所有操作
   * 
   * 【依赖顺序控制】
   * Create 操作必须在对应实体的 Update/Delete 操作之前成功
   */
  async processQueue(): Promise<{ processed: number; failed: number; movedToDeadLetter: number }> {
    if (this.isProcessing() || !this.storage.isOnline) {
      return { processed: 0, failed: 0, movedToDeadLetter: 0 };
    }

    // 【Cloudflare 迁移 §3 / §16.26】 export-only / read-only 部署禁止 flush 云端写入
    // 旧 Vercel 割接窗口期、PR Preview 只读环境、Origin Gate 运行时降级都会触发此分支
    if (this.writeGuard && !this.writeGuard.assertWritable('ActionQueue.processQueue')) {
      return { processed: 0, failed: 0, movedToDeadLetter: 0 };
    }

    if (this.storage.shouldDeferQueueProcessing()) {
      this.storage.requestQueueProcessing('processQueue');
      return { processed: 0, failed: 0, movedToDeadLetter: 0 };
    }

    let syncWriterLeaseHandle: LeaseHandle | null = null;
    if (this.isSyncWriterLeaseRequired()) {
      syncWriterLeaseHandle = await this.acquireSyncWriterLease();
      if (!syncWriterLeaseHandle) {
        return { processed: 0, failed: 0, movedToDeadLetter: 0 };
      }
    }

    const processGeneration = this.queueViewGeneration;
    const processOwnerUserId = this.getCurrentOwnerUserId();
    
    const queueSnapshot = this.pendingActions();
    
    this.sentryLazyLoader.addBreadcrumb({
      category: 'sync',
      message: `Queue processing started`,
      level: 'info',
      data: {
        queueSize: queueSnapshot.length,
        actionTypes: queueSnapshot.map(a => `${a.entityType}:${a.type}`).join(', ')
      }
    });
    
    this.isProcessing.set(true);
    const processLifecycleToken = this.beginQueueProcessLifecycle();
    this.remotelySyncedActionIdsByToken.set(processLifecycleToken, new Set<string>());
    this.locallyResolvedActionIdsByToken.set(processLifecycleToken, new Set<string>());
    
    let processed = 0;
    let failed = 0;
    let movedToDeadLetter = 0;
    
    // 跟踪失败的 Create 操作
    const failedCreateEntities = new Set<string>();
    
    try {
      const queue = [...this.pendingActions()];

      for (const action of queue) {
        if (this.isStaleProcess(processGeneration)) {
          this.logger.debug('检测到过期的队列处理循环，停止后续处理', {
            actionId: action.id,
            processGeneration,
            currentGeneration: this.queueViewGeneration,
          });
          break;
        }

        // 验证 action 仍在队列中（可能已被 dequeue 或前一次处理移除）
        if (!this.pendingActions().some(a => a.id === action.id)) {
          continue;
        }

        const entityKey = `${action.entityType}:${action.entityId}`;
        
        // 依赖顺序检查：Create 失败的实体跳过后续操作
        if (action.type !== 'create' && failedCreateEntities.has(entityKey)) {
          this.logger.debug('跳过操作：依赖的 Create 尚未成功', { actionId: action.id, type: action.type, entityKey });
          continue;
        }
        
        // 依赖顺序检查：有未处理的 Create 则跳过
        if (action.type !== 'create') {
          const hasUnprocessedCreate = queue.some(a => 
            a.entityType === action.entityType && 
            a.entityId === action.entityId && 
            a.type === 'create' &&
            a.id !== action.id
          );
          if (hasUnprocessedCreate) {
            this.logger.debug('跳过操作：队列中有未处理的 Create', { actionId: action.id, type: action.type, entityKey });
            continue;
          }
        }
        
        const processorKey = `${action.entityType}:${action.type}`;
        const processor = this.processors.get(processorKey);
        
        if (!processor) {
          this.logger.warn(`No processor registered for action type: ${processorKey} - action will remain in queue`);
          const waitTime = Date.now() - action.timestamp;
          if (waitTime > QUEUE_CONFIG.NO_PROCESSOR_TIMEOUT) {
            this.logger.warn(`Action ${action.id} has no processor and timed out (${Math.round(waitTime / 1000)}s), moving to dead letter`);
            this.storage.moveToDeadLetter(action, `无处理器且等待超时 (${Math.round(waitTime / 60000)}分钟)`);
            movedToDeadLetter++;
            if (action.type === 'create') {
              failedCreateEntities.add(entityKey);
            }
          } else if (action.retryCount > 2) {
            this.toast.warning('操作待处理', `有 ${processorKey} 类型的操作尚未处理，请稍后重试`);
          }
          failed++;
          continue;
        }
        
        try {
          this.actionProcessTokenById.set(action.id, processLifecycleToken);
          const processResult = await processor(action);
          const success = processResult === true;
          const retryError = this.getProcessorRetryError(processResult)
            ?? { message: 'Operation returned false' };

          if (this.isStaleProcess(processGeneration)) {
            if (success) {
              await this.settleStaleActionResult(processGeneration, processOwnerUserId, action, {
                success: true,
              });
            } else {
              await this.settleStaleActionResult(processGeneration, processOwnerUserId, action, {
                success: false,
                error: retryError,
              });
            }
            this.logger.debug('旧账号队列项处理结果已失效，已转入旧 owner 收口流程', {
              actionId: action.id,
              processGeneration,
              currentGeneration: this.queueViewGeneration,
            });
            if (success) {
              processed++;
            } else {
              failed++;
            }
            break;
          }
          
          if (success) {
            this.dequeue(action.id);
            processed++;
          } else {
            const result = this.storage.handleRetry(action, retryError);
            if (result === 'dead-letter') {
              movedToDeadLetter++;
              if (action.type === 'create') {
                failedCreateEntities.add(entityKey);
                this.storage.pauseDependentActions(action.entityType, action.entityId, queue);
              }
            }
            failed++;
          }
        } catch (error: unknown) {
          if (this.isStaleProcess(processGeneration)) {
            const retryError = this.toRetryError(error);
            await this.settleStaleActionResult(processGeneration, processOwnerUserId, action, {
              success: false,
              error: retryError,
            });
            this.logger.debug('旧账号队列项处理异常已失效，已转入旧 owner 收口流程', {
              actionId: action.id,
              processGeneration,
              currentGeneration: this.queueViewGeneration,
            });
            failed++;
            break;
          }

          const retryError = this.toRetryError(error);
          const result = this.storage.handleRetry(action, retryError);
          if (result === 'dead-letter') {
            movedToDeadLetter++;
            if (action.type === 'create') {
              failedCreateEntities.add(entityKey);
              this.storage.pauseDependentActions(action.entityType, action.entityId, queue);
            }
          }
          failed++;
        } finally {
          this.actionProcessTokenById.delete(action.id);
        }
      }
    } finally {
      const remoteSuccessCount = this.remotelySyncedActionIdsByToken.get(processLifecycleToken)?.size ?? 0;
      const resolvedNoOpCount = this.locallyResolvedActionIdsByToken.get(processLifecycleToken)?.size ?? 0;
      this.endQueueProcessLifecycle(processLifecycleToken);
      if (!this.isStaleProcess(processGeneration)) {
        this.isProcessing.set(false);
        this.onQueueProcessSettled?.({
          processed,
          failed,
          movedToDeadLetter,
          remaining: this.pendingActions().length,
          remoteSuccessCount,
          resolvedNoOpCount,
        });
      }
      this.remotelySyncedActionIdsByToken.delete(processLifecycleToken);
      this.locallyResolvedActionIdsByToken.delete(processLifecycleToken);
      
      this.sentryLazyLoader.addBreadcrumb({
        category: 'sync',
        message: `Queue processing completed`,
        level: processed > 0 ? 'info' : (failed > 0 ? 'warning' : 'info'),
        data: { processed, failed, movedToDeadLetter }
      });
      if (syncWriterLeaseHandle) {
        await syncWriterLeaseHandle.release().catch(error => {
          this.logger.warn('sync writer lease 释放失败', error);
        });
      }
    }
    
    return { processed, failed, movedToDeadLetter };
  }

  private toRetryError(error: unknown): QueueRetryError {
    if (error && typeof error === 'object') {
      const maybeError = error as { code?: unknown; message?: unknown; details?: unknown };
      return {
        code: typeof maybeError.code === 'string' ? maybeError.code : undefined,
        message: extractErrorMessage(error),
        details: maybeError.details && typeof maybeError.details === 'object'
          ? maybeError.details as Record<string, unknown>
          : undefined,
      };
    }

    return { message: extractErrorMessage(error) };
  }
  
  /** 清空队列 */
  clearQueue() {
    this.invalidateQueueView('clear-queue', 'discard');
    this.releaseAllQueueProcessLifecycles('clear-queue');
    this.pendingActions.set([]);
    this.queueSize.set(0);
    this.isProcessing.set(false);
    this.storage.saveQueueToStorage();
    this.syncSentryContext();
  }
  
  /** 清空死信队列 */
  clearDeadLetterQueue() { this.storage.clearDeadLetterQueue(); }

  /**
   * 仅清空当前内存视图，不覆盖持久化数据。
   * 用于切账号时先断开旧 owner 的可见队列，再按新 owner 重新加载。
   */
  clearCurrentView(): void {
    this.invalidateQueueView('clear-current-view', 'settle-owner');
    this.releaseAllQueueProcessLifecycles('clear-current-view');
    this.pendingActions.set([]);
    this.queueSize.set(0);
    this.storage.deadLetterQueue.set([]);
    this.storage.deadLetterSize.set(0);
    this.isProcessing.set(false);
    this.syncSentryContext();
  }

  /** 按当前 owner 重新加载持久化队列，避免跨账号会话看到旧队列/死信。 */
  reloadFromStorageForCurrentOwner(): void {
    this.clearCurrentView();
    this.storage.loadQueueFromStorage();
    this.storage.loadDeadLetterFromStorage();
    this.syncSentryContext();
  }
  
  /** 从死信队列重试操作 */
  retryDeadLetter(itemId: string) { this.storage.retryDeadLetter(itemId); }
  
  /** 从死信队列删除操作（放弃同步） */
  dismissDeadLetter(itemId: string) { this.storage.dismissDeadLetter(itemId); }

  /** 将待处理操作直接转入死信队列，保留数据供人工确认或稍后重试 */
  moveToDeadLetter(action: QueuedAction, reason: string): void {
    this.storage.moveToDeadLetter(action, reason);
  }
  
  /** 获取特定实体的待处理操作 */
  getActionsForEntity(entityType: string, entityId: string): QueuedAction[] {
    return this.pendingActions().filter(
      a => a.entityType === entityType && a.entityId === entityId
    );
  }

  /**
   * 获取特定项目的所有待处理操作
   */
  getPendingActionsForProject(projectId: string): QueuedAction[] {
    return this.pendingActions().filter(action => {
      if (action.entityType === 'project' && action.entityId === projectId) {
        return true;
      }
      if (action.entityType === 'task') {
        const payload = action.payload as TaskPayload | TaskDeletePayload;
        if ('projectId' in payload && payload.projectId === projectId) {
          return true;
        }
      }
      return false;
    });
  }

  /** 检查是否有待处理的操作 */
  hasPendingActions(): boolean {
    return this.pendingActions().length > 0;
  }

  /** 丢弃满足条件的待处理操作，并立即持久化队列 */
  discardActions(predicate: (action: QueuedAction) => boolean): number {
    const currentQueue = this.pendingActions();
    const nextQueue = currentQueue.filter(action => !predicate(action));
    const discardedCount = currentQueue.length - nextQueue.length;

    if (discardedCount === 0) {
      return 0;
    }

    this.pendingActions.set(nextQueue);
    this.queueSize.set(nextQueue.length);
    this.storage.saveQueueToStorage();
    this.syncSentryContext();
    return discardedCount;
  }
  
  /** 检查是否有死信 */
  hasDeadLetters(): boolean {
    return this.storage.hasDeadLetters();
  }
  
  /** 检查指定实体是否有未完成的 Create 操作 */
  hasUncompletedCreate(entityType: string, entityId: string): boolean {
    return this.pendingActions().some(a => 
      a.entityType === entityType && 
      a.entityId === entityId && 
      a.type === 'create'
    );
  }
  
  /** 获取被阻塞的操作（等待 Create 成功） */
  getBlockedActions(): QueuedAction[] {
    const queue = this.pendingActions();
    const blocked: QueuedAction[] = [];
    
    for (const action of queue) {
      if (action.type === 'create') continue;
      
      const hasCreate = queue.some(a => 
        a.entityType === action.entityType && 
        a.entityId === action.entityId && 
        a.type === 'create'
      );
      
      if (hasCreate) {
        blocked.push(action);
      }
    }
    
    return blocked;
  }

  // ========== 状态重置 ==========
  
  /**
   * 显式重置服务状态（测试 / HMR）
   */
  reset(): void {
    this.invalidateQueueView('reset', 'discard');
    this.storage.reset();
    
    this.pendingActions.set([]);
    this.queueSize.set(0);
    this.isProcessing.set(false);
    this.syncSentryContext();
    
    this.processors.clear();
    this.onQueueProcessStart = null;
    this.onQueueProcessEnd = null;
    this.onQueueProcessSettled = null;
  }
}
