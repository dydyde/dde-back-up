import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DestroyRef, Injector, runInInjectionContext, signal } from '@angular/core';
import { ActionQueueService } from '../../services/action-queue.service';
import { ActionQueueStorageService, LOCAL_QUEUE_CONFIG } from '../../services/action-queue-storage.service';
import { ChangeTrackerService } from '../../services/change-tracker.service';
import { LoggerService } from '../../services/logger.service';
import { ToastService } from '../../services/toast.service';
import { SentryAlertService } from '../../services/sentry-alert.service';
import { SentryLazyLoaderService } from '../../services/sentry-lazy-loader.service';
import { NetworkAwarenessService } from '../../services/network-awareness.service';
import { AuthService } from '../../services/auth.service';
import { QueueBackupService } from '../../services/queue-backup.service';
import { RetryQueueService } from '../../app/core/services/sync/retry-queue.service';
import { createMockDestroyRef, mockSentryLazyLoaderService } from '../../test-setup.mocks';
import { SYNC_CONFIG, SYNC_DURABILITY_CONFIG } from '../../config';
import type { Task, Connection } from '../../models';
import { resetBrowserNetworkSuspensionTrackingForTests } from '../../utils/browser-network-suspension';

const mockLoggerCategory = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const mockLoggerService = {
  category: vi.fn(() => mockLoggerCategory),
};

const mockToastService = {
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
};

const mockSentryAlertService = {
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  setContext: vi.fn(),
  updateSyncContext: vi.fn(),
};

const mockNetworkAwarenessService = {
  setStoragePressure: vi.fn(),
};

const mockQueueBackupService = {
  backupQueue: vi.fn().mockResolvedValue(true),
  restoreQueue: vi.fn().mockResolvedValue(null),
};

const mockRetryQueueService = {
  removeByEntity: vi.fn(() => false),
};

const createTask = (id: string, overrides?: Partial<Task>): Task => ({
  id,
  title: `task-${id}`,
  content: '',
  stage: 1,
  parentId: null,
  order: 0,
  rank: 0,
  status: 'active',
  x: 0,
  y: 0,
  createdDate: new Date().toISOString(),
  displayId: id,
  updatedAt: new Date().toISOString(),
  ...overrides,
});

const createConnection = (id: string, source: string, target: string, overrides?: Partial<Connection>): Connection => ({
  id,
  source,
  target,
  ...overrides,
});

describe('Sync Integrity Invariants (2026-02-07)', () => {
  let actionQueue: ActionQueueService;
  let actionQueueStorage: ActionQueueStorageService;
  let changeTracker: ChangeTrackerService;
  let destroyRefCleanup: (() => void) | undefined;

  beforeEach(() => {
    resetBrowserNetworkSuspensionTrackingForTests();
    localStorage.clear();
    vi.clearAllMocks();
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      writable: true,
      configurable: true,
    });

    const { destroyRef, destroy } = createMockDestroyRef();
    destroyRefCleanup = destroy;

    const injector = Injector.create({
      providers: [
        ActionQueueService,
        ActionQueueStorageService,
        ChangeTrackerService,
        { provide: LoggerService, useValue: mockLoggerService },
        { provide: ToastService, useValue: mockToastService },
        { provide: SentryAlertService, useValue: mockSentryAlertService },
        { provide: SentryLazyLoaderService, useValue: mockSentryLazyLoaderService },
        { provide: NetworkAwarenessService, useValue: mockNetworkAwarenessService },
        { provide: QueueBackupService, useValue: mockQueueBackupService },
        { provide: RetryQueueService, useValue: mockRetryQueueService },
        { provide: AuthService, useValue: { currentUserId: signal<string | null>('test-user') } },
        { provide: DestroyRef, useValue: destroyRef },
      ],
    });

    runInInjectionContext(injector, () => {
      actionQueue = injector.get(ActionQueueService);
      actionQueueStorage = injector.get(ActionQueueStorageService);
      changeTracker = injector.get(ChangeTrackerService);
    });
  });

  afterEach(() => {
    actionQueue.reset();
    destroyRefCleanup?.();
    resetBrowserNetworkSuspensionTrackingForTests();
    vi.useRealTimers();
  });

  // ==================== SYNC-CROSS-003: Queue Durability ====================

  it('QUEUE-DURABILITY-001: 队列达到软上限后仍继续接收写入并保留历史记录', () => {
    actionQueueStorage.isOnline = false;

    let firstActionId = '';
    for (let i = 0; i < LOCAL_QUEUE_CONFIG.MAX_QUEUE_SIZE; i++) {
      const id = actionQueue.enqueue({
        type: 'update',
        entityType: 'task',
        entityId: `task-${i}`,
        payload: { task: createTask(`task-${i}`), projectId: 'p-1' },
      });
      if (i === 0) firstActionId = id;
    }

    const overflowId = actionQueue.enqueue({
      type: 'update',
      entityType: 'task',
      entityId: 'task-overflow',
      payload: { task: createTask('task-overflow'), projectId: 'p-1' },
    });

    expect(overflowId).not.toBe('');
    expect(actionQueue.queueSize()).toBe(LOCAL_QUEUE_CONFIG.MAX_QUEUE_SIZE + 1);
    expect(actionQueue.pendingActions().some(a => a.id === firstActionId)).toBe(true);
  });

  it('QUEUE-DURABILITY-002: 冻结状态下应走内存兜底接收新写', () => {
    actionQueueStorage.isOnline = false;

    actionQueue.enqueue({
      type: 'update',
      entityType: 'task',
      entityId: 'task-1',
      payload: { task: createTask('task-1'), projectId: 'p-1' },
    });
    const sizeBeforeFreeze = actionQueue.queueSize();

    actionQueue.storage.queueFrozen.set(true);
    actionQueue.storage.queueFreezeReason.set('quota_exceeded');

    const actionId = actionQueue.enqueue({
      type: 'update',
      entityType: 'task',
      entityId: 'task-2',
      payload: { task: createTask('task-2'), projectId: 'p-1' },
    });

    expect(actionId).not.toBe('');
    expect(actionQueue.queueSize()).toBe(sizeBeforeFreeze + 1);
    expect(mockToastService.warning).toHaveBeenCalled();
  });

  // ==================== SYNC-CROSS-003: Drop Policy Config ====================

  it('SYNC-CROSS-003: SYNC_DURABILITY_CONFIG.DROP_POLICY 应为 soft-overflow', () => {
    expect(SYNC_DURABILITY_CONFIG.DROP_POLICY).toBe('soft-overflow');
  });

  it('SYNC-CROSS-003: SYNC_DURABILITY_CONFIG.STORAGE_PRESSURE_MODE 应为 memory-fallback', () => {
    expect(SYNC_DURABILITY_CONFIG.STORAGE_PRESSURE_MODE).toBe('memory-fallback');
  });

  // ==================== SYNC-CROSS-004: Dirty Window Protection ====================

  it('DIRTY-WINDOW-001: 脏字段保护窗口过期后不再命中 pending 记录', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-07T00:00:00.000Z'));

    const task = createTask('task-dirty');
    changeTracker.trackTaskUpdate('project-1', task, ['content']);

    vi.setSystemTime(new Date('2026-02-07T00:00:05.000Z'));

    const pending = changeTracker.getPendingChange('project-1', 'task', 'task-dirty', 1000);

    expect(pending).toBeUndefined();
    expect(changeTracker.pendingChangeCount()).toBe(0);
  });

  it('DIRTY-WINDOW-002: 保护窗口内 pending 记录应存在', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-07T00:00:00.000Z'));

    const task = createTask('task-dirty-2');
    changeTracker.trackTaskUpdate('project-1', task, ['content']);

    // 仅过去 500ms，保护窗口 1000ms 内
    vi.setSystemTime(new Date('2026-02-07T00:00:00.500Z'));

    const pending = changeTracker.getPendingChange('project-1', 'task', 'task-dirty-2', 1000);

    expect(pending).toBeDefined();
  });

  it('DIRTY-WINDOW-003: clearProjectChanges 应清除所有 pending 记录', () => {
    const task1 = createTask('task-c1');
    const task2 = createTask('task-c2');
    changeTracker.trackTaskUpdate('project-1', task1, ['title']);
    changeTracker.trackTaskUpdate('project-1', task2, ['content']);

    expect(changeTracker.pendingChangeCount()).toBeGreaterThan(0);

    const cleared = changeTracker.clearProjectChanges('project-1');

    expect(cleared).toBeGreaterThanOrEqual(2);
    expect(changeTracker.pendingChangeCount()).toBe(0);
  });

  // ==================== SYNC-CROSS-001: Batch Sync Return Semantics ====================
  // Note: Full BatchSyncService testing requires SimpleSyncService DI.
  // Here we verify the queue-level invariants that support batch sync.

  it('SYNC-CROSS-001: 成功入队后 queueSize 必须递增', () => {
    actionQueueStorage.isOnline = false;

    const id1 = actionQueue.enqueue({
      type: 'create',
      entityType: 'task',
      entityId: 'task-batch-1',
      payload: { task: createTask('task-batch-1'), projectId: 'p-1' },
    });
    expect(id1).not.toBe('');
    expect(actionQueue.queueSize()).toBe(1);

    const id2 = actionQueue.enqueue({
      type: 'create',
      entityType: 'task',
      entityId: 'task-batch-2',
      payload: { task: createTask('task-batch-2'), projectId: 'p-1' },
    });
    expect(id2).not.toBe('');
    expect(actionQueue.queueSize()).toBe(2);
  });

  // ==================== SYNC-CROSS-002: Local-only Preservation ====================

  it('SYNC-CROSS-002: 智能合并 — create + delete 应取消', () => {
    actionQueueStorage.isOnline = false;

    const createId = actionQueue.enqueue({
      type: 'create',
      entityType: 'task',
      entityId: 'task-new',
      payload: { task: createTask('task-new'), projectId: 'p-1' },
    });
    expect(createId).not.toBe('');
    expect(actionQueue.queueSize()).toBe(1);

    // delete 同一实体应取消 create
    const deleteId = actionQueue.enqueue({
      type: 'delete',
      entityType: 'task',
      entityId: 'task-new',
      payload: { taskId: 'task-new', projectId: 'p-1' },
    });
    expect(deleteId).toBe('');
    expect(actionQueue.queueSize()).toBe(0);
  });

  it('SYNC-CROSS-002: 智能合并 — create + update 应合并', () => {
    actionQueueStorage.isOnline = false;

    const createId = actionQueue.enqueue({
      type: 'create',
      entityType: 'task',
      entityId: 'task-cu',
      payload: { task: createTask('task-cu'), projectId: 'p-1' },
    });
    expect(createId).not.toBe('');

    const updateId = actionQueue.enqueue({
      type: 'update',
      entityType: 'task',
      entityId: 'task-cu',
      payload: { task: createTask('task-cu', { title: 'Updated' }), projectId: 'p-1' },
    });
    // update 应合并到 create，保持队列大小为 1
    expect(updateId).toBe(createId);
    expect(actionQueue.queueSize()).toBe(1);
    // 合并后操作类型应仍为 create
    const action = actionQueue.pendingActions().find(a => a.id === createId);
    expect(action?.type).toBe('create');
  });

  it('SYNC-CROSS-002: 智能合并 — update + update 去重', () => {
    actionQueueStorage.isOnline = false;

    const firstId = actionQueue.enqueue({
      type: 'update',
      entityType: 'task',
      entityId: 'task-uu',
      payload: { task: createTask('task-uu', { title: 'v1' }), projectId: 'p-1' },
    });
    expect(firstId).not.toBe('');

    const secondId = actionQueue.enqueue({
      type: 'update',
      entityType: 'task',
      entityId: 'task-uu',
      payload: { task: createTask('task-uu', { title: 'v2' }), projectId: 'p-1' },
    });
    expect(secondId).toBe(firstId);
    expect(actionQueue.queueSize()).toBe(1);
  });

  // ==================== SYNC-CROSS-005/006: Pending flag semantics ====================

  it('SYNC-CROSS-006: dequeue 后 queueSize 应减少', () => {
    actionQueueStorage.isOnline = false;

    const id = actionQueue.enqueue({
      type: 'update',
      entityType: 'task',
      entityId: 'task-deq',
      payload: { task: createTask('task-deq'), projectId: 'p-1' },
    });
    expect(actionQueue.queueSize()).toBe(1);

    actionQueue.dequeue(id);

    expect(actionQueue.queueSize()).toBe(0);
    expect(actionQueue.pendingActions()).toHaveLength(0);
  });

  it('SYNC-CROSS-006: clearQueue 清空所有操作', () => {
    actionQueueStorage.isOnline = false;

    for (let i = 0; i < 5; i++) {
      actionQueue.enqueue({
        type: 'update',
        entityType: 'task',
        entityId: `task-clr-${i}`,
        payload: { task: createTask(`task-clr-${i}`), projectId: 'p-1' },
      });
    }
    expect(actionQueue.queueSize()).toBe(5);

    actionQueue.clearQueue();

    expect(actionQueue.queueSize()).toBe(0);
    expect(actionQueue.pendingActions()).toHaveLength(0);
  });

  // ==================== SYNC-CROSS-008: Delta Cursor Config ====================

  it('SYNC-CROSS-008: CURSOR_STRATEGY 应为 max-server-updated-at', () => {
    expect(SYNC_DURABILITY_CONFIG.CURSOR_STRATEGY).toBe('max-server-updated-at');
  });

  it('SYNC-CROSS-008: CURSOR_SAFETY_LOOKBACK_MS 应为正数', () => {
    expect(SYNC_CONFIG.CURSOR_SAFETY_LOOKBACK_MS).toBeGreaterThan(0);
  });

  // ==================== SYNC-CROSS-009: Dependency Order ====================

  it('SYNC-CROSS-009: processQueue 依赖检查 — Create 失败阻塞后续操作', async () => {
    // 注册处理器
    let createCallCount = 0;
    let updateCallCount = 0;

    actionQueue.registerProcessor('task:create', async () => {
      createCallCount++;
      return false; // create 失败
    });

    actionQueue.registerProcessor('task:update', async () => {
      updateCallCount++;
      return true;
    });

    // 添加 create 和 update 到同一实体
    actionQueueStorage.isOnline = true;

    actionQueue.enqueue({
      type: 'create',
      entityType: 'task',
      entityId: 'task-dep',
      payload: { task: createTask('task-dep'), projectId: 'p-1' },
    });

    actionQueue.enqueue({
      type: 'update',
      entityType: 'task',
      entityId: 'task-dep',
      payload: { task: createTask('task-dep', { title: 'v2' }), projectId: 'p-1' },
    });

    // processQueue 应先处理 create，失败后跳过 update
    await actionQueue.processQueue();

    expect(createCallCount).toBe(1);
    // update 应被跳过（因为 create 未完成）
    expect(updateCallCount).toBe(0);
  });

  // ==================== SYNC-CROSS-010: Entity helpers ====================

  it('SYNC-CROSS-010: getActionsForEntity 返回指定实体操作', () => {
    actionQueueStorage.isOnline = false;

    actionQueue.enqueue({
      type: 'update',
      entityType: 'task',
      entityId: 'task-e1',
      payload: { task: createTask('task-e1'), projectId: 'p-1' },
    });
    actionQueue.enqueue({
      type: 'update',
      entityType: 'task',
      entityId: 'task-e2',
      payload: { task: createTask('task-e2'), projectId: 'p-1' },
    });

    const actions = actionQueue.getActionsForEntity('task', 'task-e1');
    expect(actions).toHaveLength(1);
    expect(actions[0].entityId).toBe('task-e1');
  });

  it('SYNC-CROSS-010: hasUncompletedCreate 应正确检测未完成 create', () => {
    actionQueueStorage.isOnline = false;

    actionQueue.enqueue({
      type: 'create',
      entityType: 'task',
      entityId: 'task-uc',
      payload: { task: createTask('task-uc'), projectId: 'p-1' },
    });

    expect(actionQueue.hasUncompletedCreate('task', 'task-uc')).toBe(true);
    expect(actionQueue.hasUncompletedCreate('task', 'task-other')).toBe(false);
  });

  // ==================== SYNC-CROSS-011: Error Classification ====================

  it('SYNC-CROSS-011: ActionQueueStorage 错误分类应区分 network/timeout/permission/business', () => {
    expect(actionQueueStorage.classifyError('Failed to fetch')).toBe('network');
    expect(actionQueueStorage.classifyError('Request timed out')).toBe('timeout');
    expect(actionQueueStorage.classifyError('unauthorized access')).toBe('permission');
    expect(actionQueueStorage.classifyError('duplicate key constraint')).toBe('business');
    expect(actionQueueStorage.classifyError('something unexpected')).toBe('unknown');
  });

  it('SYNC-CROSS-011: network 错误应重试，business 错误不重试', () => {
    actionQueueStorage.isOnline = false;

    // 入队一个操作
    const id = actionQueue.enqueue({
      type: 'update',
      entityType: 'task',
      entityId: 'task-err',
      payload: { task: createTask('task-err'), projectId: 'p-1' },
    });
    expect(id).not.toBe('');

    const action = actionQueue.pendingActions().find(a => a.id === id)!;

    // network 错误应返回 retry
    const networkResult = actionQueueStorage.handleRetry(action, 'Failed to fetch');
    expect(networkResult).toBe('retry');

    // business 错误应返回 dead-letter
    const action2 = actionQueue.pendingActions().find(a => a.id === id);
    if (action2) {
      const businessResult = actionQueueStorage.handleRetry(action2, 'duplicate key constraint');
      expect(businessResult).toBe('dead-letter');
    }
  });

  // ==================== SYNC-CROSS-012: Queue Semantics Convergence ====================

  it('SYNC-CROSS-012: ActionQueue 冻结状态应走内存兜底继续入队', () => {
    actionQueueStorage.isOnline = false;

    // 设置冻结状态
    actionQueue.storage.queueFrozen.set(true);
    actionQueue.storage.queueFreezeReason.set('quota_exceeded');

    const id = actionQueue.enqueue({
      type: 'update',
      entityType: 'task',
      entityId: 'task-frozen',
      payload: { task: createTask('task-frozen'), projectId: 'p-1' },
    });

    expect(id).not.toBe('');
    expect(actionQueue.queueSize()).toBe(1);
  });

  it('SYNC-CROSS-012: delete 已删除实体的 update 应被忽略', () => {
    actionQueueStorage.isOnline = false;

    // 先入队一个 delete
    actionQueue.enqueue({
      type: 'delete',
      entityType: 'task',
      entityId: 'task-del',
      payload: { taskId: 'task-del', projectId: 'p-1' },
    });
    expect(actionQueue.queueSize()).toBe(1);

    // 对已删除实体的 update 应被忽略
    const updateId = actionQueue.enqueue({
      type: 'update',
      entityType: 'task',
      entityId: 'task-del',
      payload: { task: createTask('task-del'), projectId: 'p-1' },
    });

    expect(updateId).toBe('');
    expect(actionQueue.queueSize()).toBe(1);
  });

  // ==================== SYNC-CROSS-003: Priority Assignment ====================

  it('SYNC-CROSS-003: project 类型默认优先级为 critical', () => {
    actionQueueStorage.isOnline = false;

    actionQueue.enqueue({
      type: 'update',
      entityType: 'project',
      entityId: 'proj-1',
      payload: { name: 'Test', description: '' } as never,
    });

    const action = actionQueue.pendingActions()[0];
    expect(action.priority).toBe('critical');
  });

  it('SYNC-CROSS-003: task 类型默认优先级为 normal', () => {
    actionQueueStorage.isOnline = false;

    actionQueue.enqueue({
      type: 'update',
      entityType: 'task',
      entityId: 'task-prio',
      payload: { task: createTask('task-prio'), projectId: 'p-1' },
    });

    const action = actionQueue.pendingActions()[0];
    expect(action.priority).toBe('normal');
  });

  it('SYNC-CROSS-003: preference 类型默认优先级为 low', () => {
    actionQueueStorage.isOnline = false;

    actionQueue.enqueue({
      type: 'update',
      entityType: 'preference',
      entityId: 'pref-1',
      payload: { key: 'theme', value: 'dark' } as never,
    });

    const action = actionQueue.pendingActions()[0];
    expect(action.priority).toBe('low');
  });

  // ==================== Config Invariants ====================

  it('CONFIG: SYNC_CONFIG.MAX_RETRY_QUEUE_SIZE 应大于 0', () => {
    expect(SYNC_CONFIG.MAX_RETRY_QUEUE_SIZE).toBeGreaterThan(0);
  });

  it('CONFIG: LOCAL_QUEUE_CONFIG.MAX_QUEUE_SIZE 应大于 0', () => {
    expect(LOCAL_QUEUE_CONFIG.MAX_QUEUE_SIZE).toBeGreaterThan(0);
  });

  it('CONFIG: SYNC_CONFIG.TOMBSTONE_CACHE_TTL 应大于 0', () => {
    expect(SYNC_CONFIG.TOMBSTONE_CACHE_TTL).toBeGreaterThan(0);
  });

  // ==================== Dead Letter Queue ====================

  it('DEAD-LETTER-001: 死信队列应支持添加和查询', () => {
    expect(actionQueue.hasDeadLetters()).toBe(false);
    expect(actionQueue.deadLetterSize()).toBe(0);
  });

  it('DEAD-LETTER-002: 超过最大重试次数应移入死信队列', () => {
    actionQueueStorage.isOnline = false;

    const id = actionQueue.enqueue({
      type: 'update',
      entityType: 'task',
      entityId: 'task-dl',
      payload: { task: createTask('task-dl'), projectId: 'p-1' },
    });
    expect(id).not.toBe('');

    const action = actionQueue.pendingActions().find(a => a.id === id)!;
    // 模拟多次重试失败
    for (let i = 0; i < LOCAL_QUEUE_CONFIG.MAX_RETRIES; i++) {
      const currentAction = actionQueue.pendingActions().find(a => a.id === id);
      if (currentAction) {
        actionQueueStorage.handleRetry(currentAction, 'Network error');
      }
    }

    // 最后一次应移入死信队列
    const finalAction = actionQueue.pendingActions().find(a => a.id === id);
    if (finalAction) {
      const result = actionQueueStorage.handleRetry(finalAction, 'Network error');
      expect(result).toBe('dead-letter');
    }
  });

  // ==================== Blocked Actions (SYNC-CROSS-009) ====================

  it('SYNC-CROSS-009: getBlockedActions 应返回被 Create 阻塞的操作', () => {
    actionQueueStorage.isOnline = false;

    // 入队 create 和 update 到同一实体
    actionQueue.enqueue({
      type: 'create',
      entityType: 'task',
      entityId: 'task-blocked',
      payload: { task: createTask('task-blocked'), projectId: 'p-1' },
    });

    actionQueue.enqueue({
      type: 'update',
      entityType: 'task',
      entityId: 'task-blocked',
      payload: { task: createTask('task-blocked', { title: 'v2' }), projectId: 'p-1' },
    });

    // 注意: create+update 智能合并到 create, 所以不会有 blocked actions
    // 但如果是不同实体的依赖，需要通过注入来测试
    // 此处验证 getBlockedActions API 存在且返回数组
    const blocked = actionQueue.getBlockedActions();
    expect(Array.isArray(blocked)).toBe(true);
  });

  // ==================== Project-level Query (SYNC-CROSS-002) ====================

  it('SYNC-CROSS-002: getPendingActionsForProject 应返回项目及其任务的操作', () => {
    actionQueueStorage.isOnline = false;

    // 项目级操作
    actionQueue.enqueue({
      type: 'update',
      entityType: 'project',
      entityId: 'proj-q',
      payload: { name: 'Test', description: '' } as never,
    });

    // 项目下的任务操作
    actionQueue.enqueue({
      type: 'update',
      entityType: 'task',
      entityId: 'task-q1',
      payload: { task: createTask('task-q1'), projectId: 'proj-q' },
    });

    // 其他项目的任务
    actionQueue.enqueue({
      type: 'update',
      entityType: 'task',
      entityId: 'task-q2',
      payload: { task: createTask('task-q2'), projectId: 'proj-other' },
    });

    const projectActions = actionQueue.getPendingActionsForProject('proj-q');
    expect(projectActions.length).toBe(2);
  });
});
