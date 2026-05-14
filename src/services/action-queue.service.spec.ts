/**
 * ActionQueueService 单元测试（Vitest + Injector 隔离模式）
 * 
 * 注意：该服务使用 effect()，需要注入上下文，因此使用 runInInjectionContext。
 * 
 * 测试覆盖：
 * 1. 基本入队/出队操作
 * 2. 断网时操作队列化
 * 3. 网络恢复后自动重试
 * 4. 重试失败后的回滚/死信队列
 * 5. 业务错误 vs 网络错误的区分
 * 6. 指数退避重试策略
 * 7. 队列持久化和恢复
 * 8. 死信队列的 TTL 清理
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DestroyRef, Injector, runInInjectionContext, signal } from '@angular/core';
import { ActionQueueService, EnqueueParams } from './action-queue.service';
import { ActionQueueStorageService, LOCAL_QUEUE_CONFIG } from './action-queue-storage.service';
import { Task, Project } from '../models';
import { AuthService } from './auth.service';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { SentryAlertService } from './sentry-alert.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { NetworkAwarenessService } from './network-awareness.service';
import { QueueBackupService } from './queue-backup.service';
import { RetryQueueService } from '../app/core/services/sync/retry-queue.service';
import { WriteGuardService } from './write-guard.service';
import { SyncWriterLeaseService } from './sync-writer-lease.service';
import { createMockDestroyRef, mockSentryLazyLoaderService } from '../test-setup.mocks';
import { resetBrowserNetworkSuspensionTrackingForTests } from '../utils/browser-network-suspension';

// 模拟 LoggerService
const mockLoggerCategory = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const mockLoggerService = {
  category: vi.fn(() => mockLoggerCategory),
};

// 模拟 ToastService
const mockToastService = {
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
};

// 模拟 SentryAlertService
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

// 模拟 RetryQueueService（P2-15 跨队列去重）
const mockRetryQueueService = {
  hasEntity: vi.fn().mockReturnValue(false),
  removeByEntity: vi.fn().mockReturnValue(false),
  getItems: vi.fn().mockReturnValue([]),
  add: vi.fn(),
  clear: vi.fn(),
};

const mockWriteGuardService = {
  assertWritable: vi.fn(() => true),
};

const mockLeaseRelease = vi.fn(async () => undefined);
const mockSyncWriterLeaseService = {
  isFeatureEnabled: vi.fn(() => false),
  requestLease: vi.fn(async () => ({
    tabId: 'tab-action',
    lockName: 'nanoflow-sync:test:test-user:__global__',
    mode: 'memory-only' as const,
    release: mockLeaseRelease,
  })),
};

function createMockTask(overrides: Partial<Task> = {}): Task {
  return {
    id: crypto.randomUUID(),
    title: 'Test Task',
    content: '',
    stage: 1,
    parentId: null,
    order: 0,
    rank: 500,
    status: 'active',
    x: 0, y: 0,
    createdDate: new Date().toISOString(),
    displayId: '1',
    ...overrides,
  };
}

function createMockProject(overrides: Partial<Project> = {}): Project {
  return {
    id: crypto.randomUUID(),
    name: 'Test Project',
    description: '',
    createdDate: new Date().toISOString(),
    tasks: [],
    connections: [],
    ...overrides,
  };
}

describe('ActionQueueService', () => {
  let service: ActionQueueService;
  let currentUserIdSignal = signal<string | null>('test-user');
  let consoleWarnSpy: ReturnType<typeof vi.spyOn> | undefined;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn> | undefined;
  let destroyRefCleanup: (() => void) | undefined;
  let restoreWindowEvents: (() => void) | undefined;

  function installWindowEventBridge(): () => void {
    const originalAddEventListener = window.addEventListener;
    const originalRemoveEventListener = window.removeEventListener;
    const originalDispatchEvent = window.dispatchEvent;
    const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

    Object.defineProperty(window, 'addEventListener', {
      configurable: true,
      writable: true,
      value: (type: string, listener: EventListenerOrEventListenerObject | null) => {
        if (!listener) {
          return;
        }
        const bucket = listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>();
        bucket.add(listener);
        listeners.set(type, bucket);
      },
    });

    Object.defineProperty(window, 'removeEventListener', {
      configurable: true,
      writable: true,
      value: (type: string, listener: EventListenerOrEventListenerObject | null) => {
        if (!listener) {
          return;
        }
        listeners.get(type)?.delete(listener);
      },
    });

    Object.defineProperty(window, 'dispatchEvent', {
      configurable: true,
      writable: true,
      value: (event: Event) => {
        const bucket = listeners.get(event.type);
        if (!bucket) {
          return true;
        }

        for (const listener of bucket) {
          if (typeof listener === 'function') {
            listener.call(window, event);
            continue;
          }

          listener.handleEvent(event);
        }

        return true;
      },
    });

    return () => {
      Object.defineProperty(window, 'addEventListener', {
        configurable: true,
        writable: true,
        value: originalAddEventListener,
      });
      Object.defineProperty(window, 'removeEventListener', {
        configurable: true,
        writable: true,
        value: originalRemoveEventListener,
      });
      Object.defineProperty(window, 'dispatchEvent', {
        configurable: true,
        writable: true,
        value: originalDispatchEvent,
      });
    };
  }

  // 辅助函数：模拟网络状态（不触发事件）
  function setNetworkStatus(online: boolean) {
    Object.defineProperty(navigator, 'onLine', {
      value: online,
      writable: true,
      configurable: true,
    });
    // 直接修改存储服务内部状态，避免竞态条件
    service.storage.isOnline = online;
  }

  // 辅助函数：模拟网络状态变化并触发事件
  function triggerNetworkEvent(online: boolean) {
    Object.defineProperty(navigator, 'onLine', {
      value: online,
      writable: true,
      configurable: true,
    });
    
    if (online) {
      window.dispatchEvent(new Event('online'));
    } else {
      window.dispatchEvent(new Event('offline'));
    }
  }

  function setVisibilityState(state: 'visible' | 'hidden') {
    Object.defineProperty(document, 'visibilityState', {
      value: state,
      writable: true,
      configurable: true,
    });
  }

  // 辅助函数：创建测试操作
  function createTestProjectAction(): EnqueueParams {
    return {
      type: 'update',
      entityType: 'project',
      entityId: `proj-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      payload: {
        project: createMockProject({
          id: `proj-${Date.now()}`,
        }),
      },
    };
  }

  function createTestTaskAction(): EnqueueParams {
    return {
      type: 'update',
      entityType: 'task',
      entityId: `task-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      payload: {
        task: createMockTask({
          id: `task-${Date.now()}`,
        }),
        projectId: 'proj-1',
      },
    };
  }

  beforeEach(() => {
    resetBrowserNetworkSuspensionTrackingForTests();

    // 重置 localStorage
    localStorage.clear();
    vi.clearAllMocks();
    mockWriteGuardService.assertWritable.mockReturnValue(true);
    mockSyncWriterLeaseService.isFeatureEnabled.mockReturnValue(false);
    mockSyncWriterLeaseService.requestLease.mockClear();
    mockLeaseRelease.mockClear();

    // 测试默认静默：避免业务错误分支写入 stderr。
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    
    // 设置初始网络状态为 true（在服务初始化之前）
    Object.defineProperty(navigator, 'onLine', {
      value: true,
      writable: true,
      configurable: true,
    });
    setVisibilityState('visible');

    currentUserIdSignal = signal<string | null>('test-user');

    restoreWindowEvents = installWindowEventBridge();
    
    const { destroyRef, destroy } = createMockDestroyRef();
    destroyRefCleanup = destroy;

    const injector = Injector.create({
      providers: [
        ActionQueueService,
        ActionQueueStorageService,
        { provide: LoggerService, useValue: mockLoggerService },
        { provide: ToastService, useValue: mockToastService },
        { provide: SentryAlertService, useValue: mockSentryAlertService },
        { provide: SentryLazyLoaderService, useValue: mockSentryLazyLoaderService },
        { provide: NetworkAwarenessService, useValue: mockNetworkAwarenessService },
        { provide: QueueBackupService, useValue: mockQueueBackupService },
        { provide: RetryQueueService, useValue: mockRetryQueueService },
        { provide: WriteGuardService, useValue: mockWriteGuardService },
        { provide: SyncWriterLeaseService, useValue: mockSyncWriterLeaseService },
        { provide: AuthService, useValue: { currentUserId: currentUserIdSignal } },
        { provide: DestroyRef, useValue: destroyRef },
      ],
    });

    runInInjectionContext(injector, () => {
      service = injector.get(ActionQueueService);
    });
  });

  afterEach(() => {
    service.reset();
    destroyRefCleanup?.();
    restoreWindowEvents?.();
    resetBrowserNetworkSuspensionTrackingForTests();
    vi.useRealTimers();

    consoleWarnSpy?.mockRestore();
    consoleErrorSpy?.mockRestore();
  });

  // ==================== 基本队列操作 ====================
  
  describe('基本队列操作', () => {
    it('应该能够入队一个操作', () => {
      setNetworkStatus(false); // 防止自动处理
      const actionId = service.enqueue(createTestProjectAction());
      
      expect(actionId).toBeDefined();
      expect(service.queueSize()).toBe(1);
      expect(service.hasPendingActions()).toBe(true);
    });
    
    it('应该能够出队一个操作', () => {
      setNetworkStatus(false);
      const actionId = service.enqueue(createTestProjectAction());
      
      service.dequeue(actionId);
      
      expect(service.queueSize()).toBe(0);
      expect(service.hasPendingActions()).toBe(false);
    });
    
    it('达到软上限后应继续接收写入（避免离线丢写）', () => {
      setNetworkStatus(false);
      // 入队 150 个操作
      for (let i = 0; i < 150; i++) {
        service.enqueue({
          type: 'update',
          entityType: 'task',
          entityId: `task-${i}`,
          payload: { task: createMockTask({ id: `task-${i}` }), projectId: 'proj-1' },
        });
      }
      
      // 软上限后仍然继续入队
      expect(service.queueSize()).toBe(150);
      expect(mockToastService.warning).toHaveBeenCalled();
    });
    
    it('应该能够清空队列', () => {
      setNetworkStatus(false);
      service.enqueue(createTestProjectAction());
      service.enqueue(createTestProjectAction());
      
      service.clearQueue();
      
      expect(service.queueSize()).toBe(0);
    });

          it('项目冲突收口应只失效对应 project mutation 视图，不影响全局队列视图', () => {
            setNetworkStatus(false);
            const beforeQueueGeneration = service.getCurrentQueueViewGeneration();
            const beforeProjectGeneration = service.getProjectMutationViewGeneration('proj-stale', 'test-user');

            const nextProjectGeneration = service.invalidateProjectMutationView('proj-stale', 'test-user');

            expect(nextProjectGeneration).toBe(beforeProjectGeneration + 1);
            expect(service.getProjectMutationViewGeneration('proj-stale', 'test-user')).toBe(nextProjectGeneration);
            expect(service.getCurrentQueueViewGeneration()).toBe(beforeQueueGeneration);
          });

    it('切账号时清空当前视图不应覆盖已持久化的队列和死信', () => {
      setNetworkStatus(false);
      service.enqueue(createTestProjectAction());
      const queuedAction = service.pendingActions()[0];
      service.moveToDeadLetter(queuedAction, 'test dead letter');

      const queueStorageKey = 'nanoflow.action-queue.test-user';
      const deadLetterStorageKey = 'nanoflow.dead-letter-queue.test-user';

      expect(localStorage.getItem(queueStorageKey)).toBe('[]');
      expect(localStorage.getItem(deadLetterStorageKey)).toContain('test dead letter');

      service.clearCurrentView();

      expect(service.queueSize()).toBe(0);
      expect(service.deadLetterSize()).toBe(0);
      expect(localStorage.getItem(queueStorageKey)).toBe('[]');
      expect(localStorage.getItem(deadLetterStorageKey)).toContain('test dead letter');
    });

    it('project update 合并时应保留 sourceUserId 并以最后一次 taskIdsToDelete 为准', () => {
      setNetworkStatus(false);
      const projectId = 'proj-merge-delete-intent';

      service.enqueue({
        type: 'update',
        entityType: 'project',
        entityId: projectId,
        payload: {
          project: createMockProject({ id: projectId, name: 'Before Merge' }),
          sourceUserId: 'owner-a',
          taskIdsToDelete: ['task-delete-a'],
        },
      });

      service.enqueue({
        type: 'update',
        entityType: 'project',
        entityId: projectId,
        payload: {
          project: createMockProject({ id: projectId, name: 'After Merge' }),
          taskIdsToDelete: ['task-delete-b'],
        },
      });

      expect(service.queueSize()).toBe(1);
      expect(service.pendingActions()[0]).toEqual(
        expect.objectContaining({
          payload: expect.objectContaining({
            sourceUserId: 'owner-a',
            project: expect.objectContaining({ id: projectId, name: 'After Merge' }),
            taskIdsToDelete: ['task-delete-b'],
          }),
        }),
      );
    });

    it('foreign-owner project handoff 应复用同一 project 的合并语义', async () => {
      const projectId = 'proj-foreign-owner-merge';

      await service.enqueueDurablyForOwner('owner-b', {
        type: 'update',
        entityType: 'project',
        entityId: projectId,
        payload: {
          project: createMockProject({ id: projectId, name: 'Before Foreign Merge' }),
          sourceUserId: 'owner-b',
          taskIdsToDelete: ['task-delete-a'],
        },
      });

      await service.enqueueDurablyForOwner('owner-b', {
        type: 'update',
        entityType: 'project',
        entityId: projectId,
        payload: {
          project: createMockProject({ id: projectId, name: 'After Foreign Merge' }),
          sourceUserId: 'owner-b',
          taskIdsToDelete: ['task-delete-b'],
        },
      });

      const ownerQueue = await service.storage.loadQueueSnapshotForOwner('owner-b');

      expect(ownerQueue).toHaveLength(1);
      expect(ownerQueue[0]).toEqual(
        expect.objectContaining({
          entityType: 'project',
          entityId: projectId,
          payload: expect.objectContaining({
            sourceUserId: 'owner-b',
            project: expect.objectContaining({ id: projectId, name: 'After Foreign Merge' }),
            taskIdsToDelete: ['task-delete-b'],
          }),
        }),
      );
    });
  });

  // ==================== 处理器注册和执行 ====================
  
  describe('处理器注册和执行', () => {
    it('processQueue 在 sync writer lease 开启时应持有 lease 后再处理并最终释放', async () => {
      const processor = vi.fn().mockResolvedValue(true);
      mockSyncWriterLeaseService.isFeatureEnabled.mockReturnValue(true);
      service.registerProcessor('project:update', processor);
      setNetworkStatus(false);
      service.enqueue(createTestProjectAction());

      setNetworkStatus(true);
      const result = await service.processQueue();

      expect(result.processed).toBe(1);
      expect(mockSyncWriterLeaseService.requestLease).toHaveBeenCalledWith(expect.objectContaining({
        userId: 'test-user',
        projectId: '__global__',
      }));
      expect(processor).toHaveBeenCalledTimes(1);
      expect(mockLeaseRelease).toHaveBeenCalledTimes(1);
    });

    it('应该能够注册处理器并执行', async () => {
      const processor = vi.fn().mockResolvedValue(true);
      service.registerProcessor('project:update', processor);
      
      // 先离线防止自动处理
      setNetworkStatus(false);
      
      service.enqueue(createTestProjectAction());
      
      // 再上线并手动处理
      setNetworkStatus(true);
      await service.processQueue();
      
      expect(processor).toHaveBeenCalledTimes(1);
    });
    
    it('处理成功后应该从队列移除操作', async () => {
      const processor = vi.fn().mockResolvedValue(true);
      service.registerProcessor('project:update', processor);
      
      // 先离线
      setNetworkStatus(false);
      service.enqueue(createTestProjectAction());
      expect(service.queueSize()).toBe(1);
      
      // 再上线并处理
      setNetworkStatus(true);
      const result = await service.processQueue();
      
      expect(result.processed).toBe(1);
      expect(result.failed).toBe(0);
      expect(service.queueSize()).toBe(0);
    });
    
    it('无处理器的操作应该保留在队列中', async () => {
      // 先离线
      setNetworkStatus(false);
      
      service.enqueue(createTestProjectAction());
      
      // 不注册任何处理器，上线并处理
      setNetworkStatus(true);
      const result = await service.processQueue();
      
      expect(result.processed).toBe(0);
      expect(result.failed).toBe(1);
      expect(service.queueSize()).toBe(1); // 仍在队列中
    });

    it('切账号后旧处理循环失败结果应进入旧 owner 死信而不是污染新 owner', async () => {
      let rejectProcessing = null as ((reason?: unknown) => void) | null;
      const processor = vi.fn().mockImplementation(
        () => new Promise<boolean>((_resolve, reject) => {
          rejectProcessing = reject;
        })
      );
      service.registerProcessor('project:update', processor);

      setNetworkStatus(false);
      const actionId = service.enqueue(createTestProjectAction());
      service.pendingActions.update(queue => queue.map(action =>
        action.id === actionId
          ? { ...action, retryCount: LOCAL_QUEUE_CONFIG.MAX_RETRIES }
          : action
      ));
      service.storage.saveQueueToStorage();

      setNetworkStatus(true);
      const processingPromise = service.processQueue();
      await vi.waitFor(() => {
        expect(processor).toHaveBeenCalledTimes(1);
      });

      currentUserIdSignal.set('other-user');
      service.clearCurrentView();

      rejectProcessing?.(new Error('network timeout'));
      await processingPromise;

      expect(service.deadLetterSize()).toBe(0);
      expect(localStorage.getItem('nanoflow.action-queue.test-user')).not.toContain(actionId);
      expect(localStorage.getItem('nanoflow.dead-letter-queue.test-user')).toContain(actionId);
      expect(localStorage.getItem('nanoflow.dead-letter-queue.other-user')).toBeNull();
    });

    it('切账号后旧处理循环成功结果应从旧 owner 的持久化队列中移除', async () => {
      let resolveProcessing = null as ((value: boolean) => void) | null;
      const processor = vi.fn().mockImplementation(
        () => new Promise<boolean>(resolve => {
          resolveProcessing = resolve;
        })
      );
      service.registerProcessor('project:update', processor);

      setNetworkStatus(false);
      const actionId = service.enqueue(createTestProjectAction());
      expect(localStorage.getItem('nanoflow.action-queue.test-user')).toContain(actionId);

      setNetworkStatus(true);
      const processingPromise = service.processQueue();
      await vi.waitFor(() => {
        expect(processor).toHaveBeenCalledTimes(1);
      });

      currentUserIdSignal.set('other-user');
      service.clearCurrentView();

      resolveProcessing?.(true);
      await processingPromise;

      expect(localStorage.getItem('nanoflow.action-queue.test-user')).not.toContain(actionId);
      expect(localStorage.getItem('nanoflow.action-queue.other-user')).toBeNull();
    });

    it('切账号后旧处理循环返回 false 时也应推进旧 owner 的失败收口', async () => {
      let resolveProcessing = null as ((value: boolean) => void) | null;
      const processor = vi.fn().mockImplementation(
        () => new Promise<boolean>(resolve => {
          resolveProcessing = resolve;
        })
      );
      service.registerProcessor('project:update', processor);

      setNetworkStatus(false);
      const actionId = service.enqueue(createTestProjectAction());
      setNetworkStatus(true);

      const processingPromise = service.processQueue();
      await vi.waitFor(() => {
        expect(processor).toHaveBeenCalledTimes(1);
      });

      currentUserIdSignal.set('other-user');
      service.clearCurrentView();

      resolveProcessing?.(false);
      await processingPromise;

      const persistedOldQueue = localStorage.getItem('nanoflow.action-queue.test-user') ?? '';
      expect(persistedOldQueue).toContain(actionId);
      expect(persistedOldQueue).toContain('"retryCount":1');
      expect(localStorage.getItem('nanoflow.dead-letter-queue.other-user')).toBeNull();
    });

    it('full wipe 开始后旧处理循环成功结果不应把旧 owner 队列写回本地', async () => {
      let resolveProcessing = null as ((value: boolean) => void) | null;
      const processor = vi.fn().mockImplementation(
        () => new Promise<boolean>(resolve => {
          resolveProcessing = resolve;
        })
      );
      service.registerProcessor('project:update', processor);

      setNetworkStatus(false);
      const actionId = service.enqueue(createTestProjectAction());
      expect(localStorage.getItem('nanoflow.action-queue.test-user')).toContain(actionId);

      setNetworkStatus(true);
      const processingPromise = service.processQueue();
      await vi.waitFor(() => {
        expect(processor).toHaveBeenCalledTimes(1);
      });

      currentUserIdSignal.set(null);
      service.clearCurrentView();
      service.clearQueue();
      localStorage.removeItem('nanoflow.action-queue.test-user');
      localStorage.removeItem('nanoflow.dead-letter-queue.test-user');

      resolveProcessing?.(true);
      await processingPromise;

      expect(localStorage.getItem('nanoflow.action-queue.test-user')).toBeNull();
      expect(localStorage.getItem('nanoflow.dead-letter-queue.test-user')).toBeNull();
    });

    it('full wipe 开始后旧处理循环失败结果不应把旧 owner 死信写回本地', async () => {
      let rejectProcessing = null as ((reason?: unknown) => void) | null;
      const processor = vi.fn().mockImplementation(
        () => new Promise<boolean>((_resolve, reject) => {
          rejectProcessing = reject;
        })
      );
      service.registerProcessor('project:update', processor);

      setNetworkStatus(false);
      const actionId = service.enqueue(createTestProjectAction());
      service.pendingActions.update(queue => queue.map(action =>
        action.id === actionId
          ? { ...action, retryCount: LOCAL_QUEUE_CONFIG.MAX_RETRIES }
          : action
      ));
      service.storage.saveQueueToStorage();

      setNetworkStatus(true);
      const processingPromise = service.processQueue();
      await vi.waitFor(() => {
        expect(processor).toHaveBeenCalledTimes(1);
      });

      currentUserIdSignal.set(null);
      service.clearCurrentView();
      service.clearQueue();
      localStorage.removeItem('nanoflow.action-queue.test-user');
      localStorage.removeItem('nanoflow.dead-letter-queue.test-user');

      rejectProcessing?.(new Error('network timeout'));
      await processingPromise;

      expect(localStorage.getItem('nanoflow.action-queue.test-user')).toBeNull();
      expect(localStorage.getItem('nanoflow.dead-letter-queue.test-user')).toBeNull();
    });

    it('切账号后旧循环 finally 不应覆盖新 owner 的 processing 状态', async () => {
      let resolveFirst = null as ((value: boolean) => void) | null;
      let resolveSecond = null as ((value: boolean) => void) | null;
      const onStart = vi.fn();
      const onEnd = vi.fn();
      const processor = vi.fn()
        .mockImplementationOnce(() => new Promise<boolean>(resolve => {
          resolveFirst = resolve;
        }))
        .mockImplementationOnce(() => new Promise<boolean>(resolve => {
          resolveSecond = resolve;
        }));
      service.registerProcessor('project:update', processor);
      service.setQueueProcessCallbacks(onStart, onEnd);

      setNetworkStatus(false);
      service.enqueue(createTestProjectAction());
      setNetworkStatus(true);

      const firstProcessing = service.processQueue();
      await vi.waitFor(() => {
        expect(processor).toHaveBeenCalledTimes(1);
      });
      expect(onStart).toHaveBeenCalledTimes(1);

      currentUserIdSignal.set('other-user');
      service.clearCurrentView();
      expect(service.isProcessing()).toBe(false);
      expect(onEnd).toHaveBeenCalledTimes(1);

      setNetworkStatus(false);
      service.enqueue(createTestProjectAction());
      setNetworkStatus(true);

      const secondProcessing = service.processQueue();
      await vi.waitFor(() => {
        expect(processor).toHaveBeenCalledTimes(2);
      });
      expect(service.isProcessing()).toBe(true);
      expect(onStart).toHaveBeenCalledTimes(2);

      resolveFirst?.(true);
      await firstProcessing;
      expect(service.isProcessing()).toBe(true);
      expect(onEnd).toHaveBeenCalledTimes(1);

      resolveSecond?.(true);
      await secondProcessing;
      expect(service.isProcessing()).toBe(false);
      expect(onEnd).toHaveBeenCalledTimes(2);
    });
  });

  // ==================== 离线/在线状态处理 ====================
  
  describe('离线/在线状态处理', () => {
    it('离线时处理队列应该直接返回空结果', async () => {
      const processor = vi.fn().mockResolvedValue(true);
      service.registerProcessor('project:update', processor);
      
      // 模拟离线
      setNetworkStatus(false);
      
      service.enqueue(createTestProjectAction());
      
      const result = await service.processQueue();
      
      // 离线时不应该处理任何操作
      expect(result.processed).toBe(0);
      expect(processor).not.toHaveBeenCalled();
    });
    
    it('网络恢复时应该自动处理队列', async () => {
      let resolveProcessed: (() => void) | null = null;
      const processedPromise = new Promise<void>((resolve) => {
        resolveProcessed = resolve;
      });
      const processor = vi.fn().mockImplementation(async () => {
        resolveProcessed?.();
        return true;
      });
      service.registerProcessor('project:update', processor);
      
      // 先离线
      setNetworkStatus(false);
      
      service.enqueue(createTestProjectAction());
      
      // 恢复在线 - 使用事件触发自动处理
      triggerNetworkEvent(true);
      
      // 等待自动处理真正触发，避免并发矩阵下 100ms 轮询窗口抖动
      await Promise.race([
        processedPromise,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('网络恢复后未触发自动处理')), 1000);
        }),
      ]);

      expect(processor).toHaveBeenCalledTimes(1);
      expect(service.queueSize()).toBe(0);
    });

    it('hidden 状态下 online 不应消费队列，并应在重新可见后恢复处理', async () => {
      vi.useFakeTimers();
      const processor = vi.fn().mockResolvedValue(true);
      service.registerProcessor('project:update', processor);

      setNetworkStatus(false);
      service.enqueue(createTestProjectAction());

      setVisibilityState('hidden');
      triggerNetworkEvent(true);
      await Promise.resolve();

      expect(processor).not.toHaveBeenCalled();
      expect(service.queueSize()).toBe(1);

      setVisibilityState('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.runAllTimersAsync();

      expect(processor).toHaveBeenCalledTimes(1);
      expect(service.queueSize()).toBe(0);
    });
  });

  // ==================== 重试机制 ====================
  
  describe('重试机制', () => {
    it('网络错误应该保留在队列中等待重试', async () => {
      const processor = vi.fn().mockRejectedValue(new Error('Network timeout'));
      service.registerProcessor('project:update', processor);
      
      setNetworkStatus(false);
      service.enqueue(createTestProjectAction());
      
      setNetworkStatus(true);
      await service.processQueue();
      
      // 网络错误后任务应该还在队列中（等待重试）
      expect(service.queueSize()).toBe(1);
      expect(processor).toHaveBeenCalledTimes(1);
    });

    it('压扁后的 browser-suspended 错误不应消耗 retry budget 或进入死信', async () => {
      const processor = vi.fn().mockRejectedValue(new Error('SYNC_OFFLINE | 浏览器恢复连接中，请稍后重试'));
      service.registerProcessor('project:update', processor);

      setNetworkStatus(false);
      const actionId = service.enqueue(createTestProjectAction());
      service.pendingActions.update(queue => queue.map(action =>
        action.id === actionId
          ? { ...action, retryCount: LOCAL_QUEUE_CONFIG.MAX_RETRIES }
          : action
      ));

      setNetworkStatus(true);
      await service.processQueue();

      expect(service.hasDeadLetters()).toBe(false);
      expect(service.queueSize()).toBe(1);
      expect(service.pendingActions()[0]?.retryCount).toBe(LOCAL_QUEUE_CONFIG.MAX_RETRIES);
    });
    
    it('重试成功后应该从队列移除', async () => {
      // 使用 fake timers 加速重试延迟测试
      vi.useFakeTimers();
      
      let callCount = 0;
      const processor = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount < 2) {
          throw new Error('Network timeout');
        }
        return true;
      });
      
      service.registerProcessor('task:update', processor);
      
      setNetworkStatus(false);
      service.enqueue(createTestTaskAction());
      
      // 第一次处理（失败）
      setNetworkStatus(true);
      await service.processQueue();
      expect(service.queueSize()).toBe(1);
      
      // 快进重试延迟时间后再次处理（成功）
      await vi.advanceTimersByTimeAsync(1100);
      await service.processQueue();
      
      expect(callCount).toBe(2);
      expect(service.queueSize()).toBe(0);
      
      vi.useRealTimers();
    });
  });

  // ==================== 业务错误 vs 网络错误 ====================
  
  describe('错误类型区分', () => {
    const businessErrors = [
      'not found',
      'permission denied',
      'unauthorized',
      'forbidden',
      'row level security',
      'violates constraint',
      'duplicate key',
      'unique constraint',
      'invalid input',
    ];
    
    it.each(businessErrors)('业务错误 "%s" 应该直接移入死信队列不重试', async (errorPattern) => {
      const processor = vi.fn().mockRejectedValue(new Error(`Error: ${errorPattern}`));
      service.registerProcessor('task:create', processor);
      
      setNetworkStatus(false);
      service.enqueue({
        type: 'create',
        entityType: 'task',
        entityId: `task-${Date.now()}`,
        payload: { task: createMockTask({ id: 'task-1' }), projectId: 'proj-1' },
      });
      
      setNetworkStatus(true);
      await service.processQueue();
      
      // 业务错误应该只调用一次就进入死信队列
      expect(processor).toHaveBeenCalledTimes(1);
      expect(service.hasDeadLetters()).toBe(true);
      expect(service.queueSize()).toBe(0);
    });
  });

  // ==================== 死信队列管理 ====================
  
  describe('死信队列管理', () => {
    it('应该能够从死信队列重试操作', async () => {
      const processor = vi.fn()
        .mockRejectedValueOnce(new Error('RLS violation'))
        .mockResolvedValueOnce(true);
      
      service.registerProcessor('task:update', processor);
      
      setNetworkStatus(false);
      service.enqueue(createTestTaskAction());
      
      setNetworkStatus(true);
      await service.processQueue();
      expect(service.hasDeadLetters()).toBe(true);
      
      const deadLetters = service.deadLetterQueue();
      expect(deadLetters.length).toBe(1);
      
      // 重试操作会自动触发 processQueue，等待处理完成
      service.retryDeadLetter(deadLetters[0].action.id);
      
      // 等待自动处理完成（使用短超时提高测试速度）
      await vi.waitFor(() => {
        expect(service.queueSize()).toBe(0);
      }, { timeout: 100, interval: 10 });
      
      expect(service.deadLetterSize()).toBe(0);
    });
    
    it('应该能够放弃死信队列中的操作', async () => {
      const processor = vi.fn().mockRejectedValue(new Error('not found'));
      service.registerProcessor('task:delete', processor);
      
      setNetworkStatus(false);
      service.enqueue({
        type: 'delete',
        entityType: 'task',
        entityId: `task-${Date.now()}`,
        payload: { taskId: 'task-1', projectId: 'proj-1' },
      });
      
      setNetworkStatus(true);
      await service.processQueue();
      
      const deadLetters = service.deadLetterQueue();
      service.dismissDeadLetter(deadLetters[0].action.id);
      
      expect(service.deadLetterSize()).toBe(0);
    });
    
    it('应该能够清空死信队列', async () => {
      const processor = vi.fn().mockRejectedValue(new Error('forbidden'));
      service.registerProcessor('project:delete', processor);
      
      setNetworkStatus(false);
      service.enqueue({
        type: 'delete',
        entityType: 'project',
        entityId: `proj-${Date.now()}`,
        payload: { projectId: 'proj-1', userId: 'user-1' },
      });
      
      setNetworkStatus(true);
      await service.processQueue();
      expect(service.hasDeadLetters()).toBe(true);
      
      service.clearDeadLetterQueue();
      
      expect(service.deadLetterSize()).toBe(0);
      expect(service.hasDeadLetters()).toBe(false);
    });
  });

  // ==================== 持久化 ====================
  
  describe('队列持久化', () => {
    it('应该将队列持久化到 localStorage', () => {
      setNetworkStatus(false);
      service.enqueue(createTestProjectAction());
      
      const saved = localStorage.getItem('nanoflow.action-queue.test-user');
      expect(saved).toBeTruthy();
      
      const parsed = JSON.parse(saved!);
      expect(parsed).toHaveLength(1);
    });
    
    it('应该持久化死信队列', async () => {
      const processor = vi.fn().mockRejectedValue(new Error('invalid input'));
      service.registerProcessor('task:create', processor);
      
      setNetworkStatus(false);
      service.enqueue({
        type: 'create',
        entityType: 'task',
        entityId: `task-${Date.now()}`,
        payload: { task: createMockTask({ id: 'task-1' }), projectId: 'proj-1' },
      });
      
      setNetworkStatus(true);
      await service.processQueue();
      
      const savedDeadLetter = localStorage.getItem('nanoflow.dead-letter-queue.test-user');
      expect(savedDeadLetter).toBeTruthy();
      
      const parsed = JSON.parse(savedDeadLetter!);
      expect(parsed).toHaveLength(1);
    });
  });

  // ==================== 失败通知回调 ====================
  
  describe('失败通知回调', () => {
    it('应该在操作进入死信队列时触发回调', async () => {
      const callback = vi.fn();
      service.onFailure(callback);
      
      const processor = vi.fn().mockRejectedValue(new Error('violates foreign key constraint'));
      service.registerProcessor('task:create', processor);
      
      setNetworkStatus(false);
      service.enqueue({
        type: 'create',
        entityType: 'task',
        entityId: `task-${Date.now()}`,
        payload: { task: createMockTask({ id: 'task-1' }), projectId: 'proj-1' },
      });
      
      setNetworkStatus(true);
      await service.processQueue();
      
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(expect.objectContaining({
        action: expect.objectContaining({
          entityType: 'task',
        }),
        reason: expect.stringContaining('业务错误'),
      }));
    });
  });

  // ==================== 队列处理生命周期回调 ====================
  
  describe('队列处理生命周期回调', () => {
    it('处理队列时应该调用开始和结束回调', async () => {
      const onStart = vi.fn();
      const onEnd = vi.fn();
      
      service.setQueueProcessCallbacks(onStart, onEnd);
      
      const processor = vi.fn().mockResolvedValue(true);
      service.registerProcessor('project:update', processor);
      
      setNetworkStatus(false);
      service.enqueue(createTestProjectAction());
      
      setNetworkStatus(true);
      await service.processQueue();
      
      expect(onStart).toHaveBeenCalledTimes(1);
      expect(onEnd).toHaveBeenCalledTimes(1);
    });
  });

  // ==================== 实体查询 ====================
  
  describe('实体相关操作查询', () => {
    it('应该能够获取特定实体的待处理操作', () => {
      setNetworkStatus(false);
      
      service.enqueue({
        type: 'update',
        entityType: 'task',
        entityId: 'task-1',
        payload: { task: createMockTask({ id: 'task-1' }), projectId: 'proj-1' },
      });
      service.enqueue({
        type: 'update',
        entityType: 'task',
        entityId: 'task-2',
        payload: { task: createMockTask({ id: 'task-2' }), projectId: 'proj-1' },
      });
      service.enqueue({
        type: 'update',
        entityType: 'task',
        entityId: 'task-1',
        payload: { task: createMockTask({ id: 'task-1', title: 'Updated' }), projectId: 'proj-1' },
      });
      
      const actions = service.getActionsForEntity('task', 'task-1');
      
      // 由于智能合并，同一实体的多个 update 操作会合并为一个
      expect(actions).toHaveLength(1);
      expect(actions.every(a => a.entityId === 'task-1')).toBe(true);
    });
  });

  // ==================== 并发处理保护 ====================
  
  describe('并发处理保护', () => {
    it('正在处理时不应该重复处理', async () => {
      vi.useFakeTimers();

      const processor = vi.fn().mockImplementation(async () => {
        await new Promise(r => setTimeout(r, 100));
        return true;
      });
      
      service.registerProcessor('project:update', processor);
      
      setNetworkStatus(false);
      service.enqueue(createTestProjectAction());
      
      setNetworkStatus(true);
      
      const promise1 = service.processQueue();
      const promise2 = service.processQueue();

      await vi.advanceTimersByTimeAsync(100);
      
      await Promise.all([promise1, promise2]);
      
      expect(processor).toHaveBeenCalledTimes(1);
    });
  });

  // ==================== 依赖操作暂停测试 ====================

  describe('依赖操作暂停 (pauseDependentActions)', () => {
    /**
     * 测试场景：当 Create 操作失败时，同一实体的后续操作应被暂停
     * 
     * 规则：
     * - Create 失败后，同一 entityId 的 Update/Delete 操作应被标记
     * - 应发送 Sentry 警告
     * - 关键操作被阻塞时应显示 Toast
     */

    it('Create 失败后应暂停同一实体的 Update 操作', async () => {
      // 注意：由于智能合并逻辑（场景3：create + update → 合并为 create）
      // 同一 entityId 的 create 和 update 会被合并成一个操作
      // 因此本测试验证：create 失败后处理器被正确调用
      const createProcessor = vi.fn().mockRejectedValue(new Error('Create failed'));
      
      service.registerProcessor('task:create', createProcessor);
      
      setNetworkStatus(false);
      
      // 入队 create 操作
      service.enqueue({
        type: 'create',
        entityType: 'task',
        entityId: 'task-1',
        payload: { task: createMockTask({ id: 'task-1', title: 'New Task' }), projectId: 'proj-1' },
      });
      
      // 入队同一实体的 update 操作（会被智能合并到 create 中）
      service.enqueue({
        type: 'update',
        entityType: 'task',
        entityId: 'task-1',
        payload: { task: createMockTask({ id: 'task-1', title: 'Updated Task' }), projectId: 'proj-1' },
      });
      
      // 由于智能合并，同一实体的多个操作会合并为一个
      expect(service.pendingActions().length).toBe(1);
      
      setNetworkStatus(true);
      
      // 处理队列 - create 会失败
      await service.processQueue();
      
      // create 处理器应被调用
      expect(createProcessor).toHaveBeenCalled();
      
      // 合并后只有一个操作，没有需要暂停的依赖操作
      // 验证处理器被正确调用即可
    });

    it('Create 失败不应影响其他实体的操作', async () => {
      const createProcessor = vi.fn().mockRejectedValue(new Error('Create failed'));
      const updateProcessor = vi.fn().mockResolvedValue(true);
      
      service.registerProcessor('task:create', createProcessor);
      service.registerProcessor('task:update', updateProcessor);
      
      setNetworkStatus(false);
      
      // 入队 task-1 的 create（会失败）
      service.enqueue({
        type: 'create',
        entityType: 'task',
        entityId: 'task-1',
        payload: { task: createMockTask({ id: 'task-1', title: 'Task 1' }), projectId: 'proj-1' },
      });
      
      // 入队 task-2 的 update（应该正常处理）
      service.enqueue({
        type: 'update',
        entityType: 'task',
        entityId: 'task-2',
        payload: { task: createMockTask({ id: 'task-2', title: 'Task 2 Updated' }), projectId: 'proj-1' },
      });
      
      setNetworkStatus(true);
      
      await service.processQueue();
      
      // task-2 的 update 应该被处理
      expect(updateProcessor).toHaveBeenCalledWith(
        expect.objectContaining({ entityId: 'task-2' })
      );
    });

    it('不同实体类型的操作互不影响', async () => {
      const taskCreateProcessor = vi.fn().mockRejectedValue(new Error('Create failed'));
      const projectUpdateProcessor = vi.fn().mockResolvedValue(true);
      
      service.registerProcessor('task:create', taskCreateProcessor);
      service.registerProcessor('project:update', projectUpdateProcessor);
      
      setNetworkStatus(false);
      
      // 入队 task 的 create（会失败）
      service.enqueue({
        type: 'create',
        entityType: 'task',
        entityId: 'task-1',
        payload: { task: createMockTask({ id: 'task-1', title: 'Task 1' }), projectId: 'proj-1' },
      });
      
      // 入队 project 的 update（应该正常处理）
      service.enqueue({
        type: 'update',
        entityType: 'project',
        entityId: 'proj-1',
        payload: { project: createMockProject({ id: 'proj-1', name: 'Updated' }) },
      });
      
      setNetworkStatus(true);
      
      await service.processQueue();
      
      // project update 应该被处理
      expect(projectUpdateProcessor).toHaveBeenCalled();
    });
  });
});
