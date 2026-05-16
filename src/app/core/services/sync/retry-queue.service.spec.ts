import { DestroyRef, Injector, runInInjectionContext } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RetryQueueItem, RetryQueueService, RetryOperationHandler } from './retry-queue.service';
import { LoggerService } from '../../../../services/logger.service';
import { ToastService } from '../../../../services/toast.service';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import { AuthService } from '../../../../services/auth.service';
import { ProjectStateService } from '../../../../services/project-state.service';
import { BlackBoxSyncService } from '../../../../services/black-box-sync.service';
import { SyncWriterLeaseService } from '../../../../services/sync-writer-lease.service';
import { AUTH_CONFIG } from '../../../../config/auth.config';
import { Connection, Project, Task } from '../../../../models';
import type { BlackBoxEntry } from '../../../../models/focus';
import {
  createBrowserNetworkSuspendedError,
  isBrowserNetworkSuspendedWindow,
  resetBrowserNetworkSuspensionTrackingForTests,
} from '../../../../utils/browser-network-suspension';

/** 生成稳定的 UUID 供测试去重使用，同一 label 返回同一 UUID */
const uuidCache = new Map<string, string>();
function stableUUID(label: string): string {
  if (!uuidCache.has(label)) {
    uuidCache.set(label, crypto.randomUUID());
  }
  return uuidCache.get(label)!;
}

function createTask(label: string): Task {
  const id = stableUUID(label);
  const now = new Date().toISOString();
  return {
    id,
    title: `Task ${label}`,
    content: '',
    stage: null,
    parentId: null,
    order: 0,
    rank: 0,
    status: 'active',
    x: 0,
    y: 0,
    createdDate: now,
    displayId: label,
    updatedAt: now
  };
}

function createProject(label: string): Project {
  const id = stableUUID(`project-${label}`);
  const now = new Date().toISOString();
  return {
    id,
    name: `Project ${label}`,
    description: '',
    createdDate: now,
    updatedAt: now,
    tasks: [],
    connections: [],
  };
}

function createConnection(label: string, sourceLabel = `${label}-source`, targetLabel = `${label}-target`): Connection {
  return {
    id: stableUUID(`connection-${label}`),
    source: stableUUID(sourceLabel),
    target: stableUUID(targetLabel),
  };
}

function createBlackBoxEntry(label: string, overrides: Partial<BlackBoxEntry> = {}): BlackBoxEntry {
  const now = new Date().toISOString();
  return {
    id: stableUUID(`blackbox-${label}`),
    projectId: null,
    userId: 'test-user',
    content: `BlackBox ${label}`,
    date: '2026-04-21',
    createdAt: now,
    updatedAt: now,
    isRead: false,
    isCompleted: false,
    isArchived: false,
    deletedAt: null,
    snoozeCount: 0,
    ...overrides,
  };
}

function setVisibilityState(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: state,
  });
}

describe('RetryQueueService', () => {
  let service: RetryQueueService;
  let injector: Injector;
  let loggerCategory: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
  };
  let handler: RetryOperationHandler;
  let online = false;
  const authServiceMock = {
    currentUserId: vi.fn((): string | null => 'test-user'),
    peekPersistedOwnerHint: vi.fn((): string | null => null),
    peekPersistedSessionIdentity: vi.fn((): { userId: string; email: string | null } | null => null),
  };
  const projectStateMock = {
    getProject: vi.fn((): Record<string, string> | undefined => undefined),
  };
  const destroyCallbacks: Array<() => void> = [];
  const destroyRefMock: Pick<DestroyRef, 'onDestroy'> = {
    onDestroy: (callback: () => void) => {
      destroyCallbacks.push(callback);
      return () => {};
    },
  };
  let toastMock: {
    warning: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    success: ReturnType<typeof vi.fn>;
  };
  let blackBoxSyncMock: {
    markEntrySyncConflict: ReturnType<typeof vi.fn>;
  };
  let initDbSpy: ReturnType<typeof vi.spyOn>;
  let loadFromStorageSpy: ReturnType<typeof vi.spyOn>;
  let saveToStorageSpy: ReturnType<typeof vi.spyOn>;
  const releaseLeaseMock = vi.fn(async () => undefined);
  const syncWriterLeaseMock = {
    isFeatureEnabled: vi.fn(() => false),
    requestLease: vi.fn(async () => ({
      tabId: 'tab-test',
      lockName: 'nanoflow-sync:test:test-user:__global__',
      mode: 'memory-only' as const,
      release: releaseLeaseMock,
    })),
  };

  beforeEach(() => {
    // 每个测试用例重置 UUID 缓存，保证测试隔离
    uuidCache.clear();
    localStorage.clear();
    destroyCallbacks.length = 0;
    resetBrowserNetworkSuspensionTrackingForTests();
    setVisibilityState('visible');

    loggerCategory = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn()
    };

    toastMock = {
      warning: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      success: vi.fn()
    };

    blackBoxSyncMock = {
      markEntrySyncConflict: vi.fn().mockResolvedValue(undefined),
    };

    initDbSpy = vi.spyOn(RetryQueueService.prototype as unknown as {
      initDb: () => Promise<IDBDatabase | null>;
    }, 'initDb').mockResolvedValue(null);
    loadFromStorageSpy = vi.spyOn(RetryQueueService.prototype as unknown as {
      loadFromStorage: () => void;
    }, 'loadFromStorage').mockImplementation(() => {});

    injector = Injector.create({
      providers: [
        { provide: RetryQueueService, useClass: RetryQueueService },
        {
          provide: LoggerService,
          useValue: {
            category: vi.fn().mockReturnValue(loggerCategory)
          }
        },
        {
          provide: ToastService,
          useValue: toastMock
        },
        {
          provide: AuthService,
          useValue: authServiceMock
        },
        {
          provide: ProjectStateService,
          useValue: projectStateMock,
        },
        {
          provide: BlackBoxSyncService,
          useValue: blackBoxSyncMock,
        },
        {
          provide: SyncWriterLeaseService,
          useValue: syncWriterLeaseMock,
        },
        {
          provide: SentryLazyLoaderService,
          useValue: {
            captureMessage: vi.fn(),
            captureException: vi.fn(),
            setTag: vi.fn(),
            setContext: vi.fn()
          }
        },
        {
          provide: DestroyRef,
          useValue: destroyRefMock,
        }
      ]
    });

    service = runInInjectionContext(injector, () => injector.get(RetryQueueService));

    // 测试中不依赖持久化副作用，避免 IndexedDB 异步写入噪音。
    saveToStorageSpy = vi.spyOn(service as unknown as { saveToStorage: () => Promise<void> }, 'saveToStorage')
      .mockResolvedValue(undefined);

    online = false;
    authServiceMock.currentUserId.mockReturnValue('test-user');
    authServiceMock.peekPersistedOwnerHint.mockReturnValue(null);
    authServiceMock.peekPersistedSessionIdentity.mockReturnValue(null);
    projectStateMock.getProject.mockReturnValue(undefined);
    releaseLeaseMock.mockClear();
    syncWriterLeaseMock.isFeatureEnabled.mockReturnValue(false);
    syncWriterLeaseMock.requestLease.mockClear();
    handler = {
      pushTask: vi.fn().mockResolvedValue(true),
      deleteTask: vi.fn().mockResolvedValue(true),
      pushProject: vi.fn().mockResolvedValue(true),
      pushConnection: vi.fn().mockResolvedValue(true),
      pushBlackBoxEntry: vi.fn().mockResolvedValue(true),
      isSessionExpired: vi.fn().mockReturnValue(false),
      isOnline: vi.fn(() => online),
      onProcessingStateChange: vi.fn()
    };
    service.setOperationHandler(handler);
  });

  it('setOperationHandler 即使 queue 为空也应主动同步 pendingCount=0 到 SyncState（防止切账号 stale 漂移）', () => {
    // 模拟切账号场景：clearCurrentView 已把 queue 清空，但 SyncState 残留旧 pendingCount。
    // 此时上层 SimpleSyncService 重新 setOperationHandler 必须把 pendingCount 主动归零。
    const freshHandler = {
      pushTask: vi.fn().mockResolvedValue(true),
      deleteTask: vi.fn().mockResolvedValue(true),
      pushProject: vi.fn().mockResolvedValue(true),
      pushConnection: vi.fn().mockResolvedValue(true),
      pushBlackBoxEntry: vi.fn().mockResolvedValue(true),
      isSessionExpired: vi.fn().mockReturnValue(false),
      isOnline: vi.fn(() => false),
      onProcessingStateChange: vi.fn(),
    };

    expect(service.length).toBe(0);

    service.setOperationHandler(freshHandler);

    expect(freshHandler.onProcessingStateChange).toHaveBeenCalledWith(false, 0);
  });

  it('processQueueSlice 在 sync writer lease 开启时应持有 lease 后再 flush 并最终释放', async () => {
    online = true;
    syncWriterLeaseMock.isFeatureEnabled.mockReturnValue(true);
    const task = createTask('leased-task');
    service.add('task', 'upsert', task, 'project-lease', 'test-user');

    const result = await service.processQueueSlice({ maxItems: 1, maxDurationMs: 1000 });

    expect(result.processed).toBe(1);
    expect(syncWriterLeaseMock.requestLease).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'test-user',
      projectId: '__global__',
    }));
    expect(handler.pushTask).toHaveBeenCalledWith(task, 'project-lease', 'test-user');
    expect(releaseLeaseMock).toHaveBeenCalledTimes(1);
  });

  it('入队时应记录来源用户，避免跨账号重放', () => {
    service.add('task', 'upsert', createTask('t-source-user'), 'p-1');

    expect(service.getItems()[0]?.sourceUserId).toBe('test-user');
  });

  it('显式传入来源用户时应优先使用捕获 owner，避免晚到失败被当前 auth 污染', () => {
    authServiceMock.currentUserId.mockReturnValue('new-user');

    service.add('task', 'upsert', createTask('t-captured-owner'), 'p-1', 'old-user');

    expect((service as unknown as { hiddenQueueItems: RetryQueueItem[] }).hiddenQueueItems[0]?.sourceUserId).toBe('old-user');
  });

  it('跨账号来源的新重试项应直接进入 hidden bucket，不污染当前可见队列', () => {
    authServiceMock.currentUserId.mockReturnValue('new-user');

    service.add('task', 'delete', { id: stableUUID('task-hidden-owner') }, 'p-1', 'old-user');

    expect(service.length).toBe(0);
    expect((service as unknown as { hiddenQueueItems: RetryQueueItem[] }).hiddenQueueItems).toEqual([
      expect.objectContaining({
        projectId: 'p-1',
        sourceUserId: 'old-user',
        data: expect.objectContaining({ id: stableUUID('task-hidden-owner') }),
      }),
    ]);
  });

  it('findItemForOwner 应能命中 hidden bucket 中的旧 owner 重试项', () => {
    const hiddenProject = createProject('hidden-owner-project');
    authServiceMock.currentUserId.mockReturnValue('new-user');

    service.add('project', 'upsert', hiddenProject, undefined, 'old-user');

    expect(service.findItemForOwner('project', hiddenProject.id, 'old-user')).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({ id: hiddenProject.id }),
        sourceUserId: 'old-user',
      }),
    );
  });

  it('addDurably 回滚后应重新挂起已恢复队列的防抖持久化', async () => {
    saveToStorageSpy.mockRestore();
    const existingTask = createTask('existing-pending-persist');
    const failedTask = createTask('durable-persist-failure');

    service.add('task', 'upsert', existingTask, 'p-1');
    const originalTimer = (service as unknown as { saveDebounceTimer: ReturnType<typeof setTimeout> | null }).saveDebounceTimer;
    expect(originalTimer).not.toBeNull();

    (service as unknown as { saveToStorageImmediate: () => Promise<boolean> }).saveToStorageImmediate = vi.fn().mockResolvedValue(false);

    const accepted = await service.addDurably('task', 'upsert', failedTask, 'p-1');

    expect(accepted).toBe(false);
    expect(service.getItems().map(item => item.data.id)).toEqual([existingTask.id]);
    expect((service as unknown as { saveDebounceTimer: ReturnType<typeof setTimeout> | null }).saveDebounceTimer).not.toBeNull();

    const rearmedTimer = (service as unknown as { saveDebounceTimer: ReturnType<typeof setTimeout> | null }).saveDebounceTimer;
    if (rearmedTimer) {
      clearTimeout(rearmedTimer);
      (service as unknown as { saveDebounceTimer: ReturnType<typeof setTimeout> | null }).saveDebounceTimer = null;
    }
  });

  it('processQueueSlice 重放项目时应透传捕获的 sourceUserId', async () => {
    const project = createProject('captured-owner');
    authServiceMock.currentUserId.mockReturnValue('owner-a');
    service.add('project', 'upsert', project, undefined, 'owner-a');
    online = true;
    authServiceMock.currentUserId.mockReturnValue('owner-a');

    await service.processQueueSlice({ maxItems: 1, maxDurationMs: 1000 });

    expect(handler.pushProject).toHaveBeenCalledWith(project, 'owner-a', undefined);
  });

  it('task replay handler 返回 false 时应保留队列项，避免 auth/tombstone 保护误删重试意图', async () => {
    const task = createTask('task-auth-tombstone-replay-retained');
    service.add('task', 'upsert', task, 'p-auth-tombstone');
    online = true;
    (handler.pushTask as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);

    const result = await service.processQueueSlice({ maxItems: 1, maxDurationMs: 1000 });

    expect(result.processed).toBe(1);
    expect(handler.pushTask).toHaveBeenCalledWith(task, 'p-auth-tombstone', 'test-user');
    expect(service.getItems().map(item => item.data.id)).toContain(task.id);
  });

  it('命中 session expired 后应立即停止当前切片，避免消耗后续项的 retry budget', async () => {
    const firstTask = createTask('task-stop-on-session-expired-a');
    const secondTask = createTask('task-stop-on-session-expired-b');
    let sessionExpired = false;
    service.add('task', 'upsert', firstTask, 'p-stop-expired');
    service.add('task', 'upsert', secondTask, 'p-stop-expired');
    online = true;
    (handler.isSessionExpired as ReturnType<typeof vi.fn>).mockImplementation(() => sessionExpired);
    (handler.pushTask as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      sessionExpired = true;
      return false;
    });

    const result = await service.processQueueSlice({ maxItems: 2, maxDurationMs: 1000 });

    expect(result.processed).toBe(1);
    expect(handler.pushTask).toHaveBeenCalledTimes(1);
    expect(service.getItems().map(item => item.data.id)).toEqual([firstTask.id, secondTask.id]);
  });

  it('processQueueSlice 重放项目时应透传 durable taskIdsToDelete', async () => {
    const project = createProject('captured-owner-with-deletes');
    authServiceMock.currentUserId.mockReturnValue('owner-a');
    service.add('project', 'upsert', project, undefined, 'owner-a', ['task-delete-a']);
    online = true;
    authServiceMock.currentUserId.mockReturnValue('owner-a');

    await service.processQueueSlice({ maxItems: 1, maxDurationMs: 1000 });

    expect(handler.pushProject).toHaveBeenCalledWith(project, 'owner-a', ['task-delete-a']);
  });

  it('processQueueSlice 重放连接时应透传捕获的 sourceUserId', async () => {
    const connection = {
      id: stableUUID('connection-captured-owner'),
      source: 'task-1',
      target: 'task-2',
    };
    authServiceMock.currentUserId.mockReturnValue('owner-a');
    service.add('connection', 'upsert', connection, 'project-1', 'owner-a');
    online = true;
    authServiceMock.currentUserId.mockReturnValue('owner-a');

    await service.processQueueSlice({ maxItems: 1, maxDurationMs: 1000 });

    expect(handler.pushConnection).toHaveBeenCalledWith(connection, 'project-1', 'owner-a');
  });

  it('processQueueSlice 重放任务删除时应透传捕获的 sourceUserId', async () => {
    authServiceMock.currentUserId.mockReturnValue('owner-a');
    service.add('task', 'delete', { id: stableUUID('task-delete-captured-owner') }, 'project-1', 'owner-a');
    online = true;
    authServiceMock.currentUserId.mockReturnValue('owner-a');

    await service.processQueueSlice({ maxItems: 1, maxDurationMs: 1000 });

    expect(handler.deleteTask).toHaveBeenCalledWith(stableUUID('task-delete-captured-owner'), 'project-1', 'owner-a');
  });

  it('处理中的旧 blackbox 快照成功后，不应删除同 id 的更新快照', async () => {
    const entryId = stableUUID('blackbox-refresh-during-processing');
    const olderEntry = createBlackBoxEntry('refresh-old', {
      id: entryId,
      updatedAt: '2026-04-21T00:00:00.000Z',
      isCompleted: false,
    });
    const newerEntry = createBlackBoxEntry('refresh-new', {
      id: entryId,
      updatedAt: '2026-04-21T00:00:05.000Z',
      isCompleted: true,
    });

    service.add('blackbox', 'upsert', olderEntry, undefined, 'test-user');
    online = true;
    (handler.pushBlackBoxEntry as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      service.add('blackbox', 'upsert', newerEntry, undefined, 'test-user');
      return true;
    });

    const result = await service.processQueueSlice({ maxItems: 1, maxDurationMs: 1000 });

    expect(result.processed).toBe(1);
    expect(handler.pushBlackBoxEntry).toHaveBeenCalledWith(olderEntry, 'test-user');
    expect(service.getItems()).toEqual([
      expect.objectContaining({
        type: 'blackbox',
        data: expect.objectContaining({
          id: entryId,
          updatedAt: newerEntry.updatedAt,
          isCompleted: true,
        }),
      }),
    ]);
  });

  it('更新同一 blackbox 重试项时，空正文不能覆盖已有完整正文', () => {
    const entryId = stableUUID('blackbox-preserve-content');
    const fullEntry = createBlackBoxEntry('content-full', {
      id: entryId,
      content: '完整黑匣子正文',
      updatedAt: '2026-04-21T00:00:00.000Z',
      isCompleted: false,
    });
    const blankStatusUpdate = createBlackBoxEntry('content-blank', {
      id: entryId,
      content: '',
      updatedAt: '2026-04-21T00:00:05.000Z',
      isCompleted: true,
    });

    service.add('blackbox', 'upsert', fullEntry, undefined, 'test-user');
    service.add('blackbox', 'upsert', blankStatusUpdate, undefined, 'test-user');

    expect(service.getItems()).toHaveLength(1);
    expect(service.getItems()[0]).toEqual(expect.objectContaining({
      type: 'blackbox',
      data: expect.objectContaining({
        id: entryId,
        content: '完整黑匣子正文',
        updatedAt: blankStatusUpdate.updatedAt,
        isCompleted: true,
      }),
    }));
  });

  it('仅项目回放成功见底时也应记录 successful drain flag', async () => {
    const project = createProject('successful-drain-project');

    service.add('project', 'upsert', project, undefined, 'test-user');
    online = true;

    const result = await service.processQueueSlice({ maxItems: 1, maxDurationMs: 1000 });

    expect(result.completed).toBe(true);
    expect(handler.pushProject).toHaveBeenCalledWith(project, 'test-user', undefined);
    expect(service.consumeSuccessfulDrainFlag()).toBe(true);
  });

  it('新重试项入队时应清除旧的 successful drain flag', async () => {
    const project = createProject('successful-drain-reset');

    service.add('project', 'upsert', project, undefined, 'test-user');
    online = true;

    await service.processQueueSlice({ maxItems: 1, maxDurationMs: 1000 });
    expect(service.hasSuccessfulDrainFlag()).toBe(true);

    service.add('task', 'upsert', createTask('reset-flag'), 'p-1', 'test-user');

    expect(service.hasSuccessfulDrainFlag()).toBe(false);
  });

  it('切账号后清空当前视图并保存，不应覆盖其它账号的持久化重试项', async () => {
    loadFromStorageSpy.mockRestore();
    initDbSpy.mockResolvedValue(null);
    saveToStorageSpy.mockImplementation(() => {
      (service as unknown as { saveToLocalStorage: () => void }).saveToLocalStorage();
      return undefined as unknown as Promise<void>;
    });

    const currentTask = createTask('t-current-owner');
    const otherTask = createTask('t-other-owner');
    const storedItems: RetryQueueItem[] = [
      {
        id: crypto.randomUUID(),
        type: 'task',
        operation: 'upsert',
        data: currentTask,
        projectId: 'p-1',
        retryCount: 0,
        createdAt: Date.now(),
        sourceUserId: 'test-user',
      },
      {
        id: crypto.randomUUID(),
        type: 'task',
        operation: 'upsert',
        data: otherTask,
        projectId: 'p-2',
        retryCount: 0,
        createdAt: Date.now(),
        sourceUserId: 'other-user',
      },
    ];
    localStorage.setItem('nanoflow.retry-queue', JSON.stringify({
      version: 1,
      items: storedItems,
      savedAt: Date.now(),
    }));

    service.reloadFromStorageForCurrentOwner();

    await vi.waitFor(() => {
      expect(service.getItems().map(item => item.data.id)).toEqual([currentTask.id]);
    });

    service.clearCurrentView();
    (service as unknown as { saveToLocalStorage: () => void }).saveToLocalStorage();

    const persistedAfterClear = JSON.parse(localStorage.getItem('nanoflow.retry-queue') ?? '{}') as {
      items?: RetryQueueItem[];
    };
    expect(new Set((persistedAfterClear.items ?? []).map(item => item.data.id))).toEqual(
      new Set([currentTask.id, otherTask.id])
    );

    authServiceMock.currentUserId.mockReturnValue('other-user');
    service.reloadFromStorageForCurrentOwner();

    await vi.waitFor(() => {
      expect(service.getItems().map(item => item.data.id)).toEqual([otherTask.id]);
    });
  });

  it('晚到的存储加载结果不应覆盖当前 owner 新增的重试项', async () => {
    loadFromStorageSpy.mockRestore();
    saveToStorageSpy.mockResolvedValue(undefined);

    let resolveDbInit: ((db: IDBDatabase | null) => void) | null = null;
    initDbSpy.mockReturnValue(new Promise(resolve => {
      resolveDbInit = resolve;
    }));

    const staleTask = createTask('t-stale-reload');
    localStorage.setItem('nanoflow.retry-queue', JSON.stringify({
      version: 1,
      items: [
        {
          id: crypto.randomUUID(),
          type: 'task',
          operation: 'upsert',
          data: staleTask,
          projectId: 'p-stale',
          retryCount: 0,
          createdAt: Date.now(),
          sourceUserId: 'test-user',
        },
      ],
      savedAt: Date.now(),
    }));

    service.reloadFromStorageForCurrentOwner();

    const freshTask = createTask('t-fresh-after-reload');
    service.add('task', 'upsert', freshTask, 'p-fresh');

    resolveDbInit!(null);
    await Promise.resolve();
    await Promise.resolve();

    await vi.waitFor(() => {
      expect(service.getItems().map(item => item.data.id)).toEqual([freshTask.id]);
    });
  });

  it('clearCurrentView 应按当前 owner 重新刷新 legacyReviewCount', () => {
    localStorage.setItem('nanoflow.retry-queue.legacy-review.test-user', JSON.stringify([
      {
        item: {
          id: crypto.randomUUID(),
          type: 'task',
          operation: 'upsert',
          data: createTask('legacy-review-user-a'),
          projectId: 'p-1',
          retryCount: 0,
          createdAt: Date.now(),
          sourceUserId: 'test-user',
        },
        reason: 'legacy',
        quarantinedAt: new Date().toISOString(),
        ownerUserId: 'test-user',
      },
    ]));

    service.refreshLegacyReviewCount();
    expect(service.legacyReviewCount()).toBe(1);

    authServiceMock.currentUserId.mockReturnValue(null);
    service.clearCurrentView();

    expect(service.legacyReviewCount()).toBe(0);
  });

  it('clear 应清空包含 hidden items 在内的全量重试数据', () => {
    (service as unknown as { queue: RetryQueueItem[] }).queue = [
      {
        id: crypto.randomUUID(),
        type: 'task',
        operation: 'upsert',
        data: createTask('t-visible-clear-all'),
        projectId: 'p-visible',
        retryCount: 0,
        createdAt: Date.now(),
        sourceUserId: 'test-user',
      },
    ];
    (service as unknown as { hiddenQueueItems: RetryQueueItem[] }).hiddenQueueItems = [
      {
        id: crypto.randomUUID(),
        type: 'task',
        operation: 'upsert',
        data: createTask('t-hidden-clear-all'),
        projectId: 'p-hidden',
        retryCount: 0,
        createdAt: Date.now(),
        sourceUserId: 'other-user',
      },
    ];

    service.clear();

    expect(service.getItems()).toEqual([]);
    expect((service as unknown as { hiddenQueueItems: RetryQueueItem[] }).hiddenQueueItems).toEqual([]);
  });

  it('云端账号加载阶段应立即隔离缺少来源元数据的 legacy 重试项', async () => {
    loadFromStorageSpy.mockRestore();
    initDbSpy.mockResolvedValue(null);
    authServiceMock.currentUserId.mockReturnValue('test-user');
    saveToStorageSpy.mockImplementation(() => {
      (service as unknown as { saveToLocalStorage: () => void }).saveToLocalStorage();
      return undefined as unknown as Promise<void>;
    });

    const legacyTask = createTask('t-legacy-load');
    localStorage.setItem('nanoflow.retry-queue', JSON.stringify({
      version: 1,
      items: [
        {
          id: crypto.randomUUID(),
          type: 'task',
          operation: 'upsert',
          data: legacyTask,
          projectId: 'p-legacy',
          retryCount: 0,
          createdAt: Date.now(),
        },
      ],
      savedAt: Date.now(),
    }));

    service.reloadFromStorageForCurrentOwner();

    await vi.waitFor(() => {
      expect(service.getItems()).toEqual([]);
    });

    expect(localStorage.getItem('nanoflow.retry-queue.legacy-review.__legacy_unknown__')).toContain('t-legacy-load');
    const persisted = JSON.parse(localStorage.getItem('nanoflow.retry-queue') ?? '{}') as { items?: RetryQueueItem[] };
    expect(persisted.items ?? []).toHaveLength(0);
  });

  it('本地模式加载缺少来源元数据的 legacy 重试残留应静默清理且不弹待确认提示', async () => {
    loadFromStorageSpy.mockRestore();
    initDbSpy.mockResolvedValue(null);
    authServiceMock.currentUserId.mockReturnValue(AUTH_CONFIG.LOCAL_MODE_USER_ID);
    saveToStorageSpy.mockImplementation(() => {
      (service as unknown as { saveToLocalStorage: () => void }).saveToLocalStorage();
      return undefined as unknown as Promise<void>;
    });

    const legacyTask = createTask('t-legacy-local-load');
    localStorage.setItem('nanoflow.retry-queue', JSON.stringify({
      version: 1,
      items: [
        {
          id: crypto.randomUUID(),
          type: 'task',
          operation: 'upsert',
          data: legacyTask,
          projectId: 'p-local',
          retryCount: 0,
          createdAt: Date.now(),
        },
      ],
      savedAt: Date.now(),
    }));

    service.reloadFromStorageForCurrentOwner();

    await vi.waitFor(() => {
      expect(service.getItems()).toEqual([]);
    });

    expect(localStorage.getItem('nanoflow.retry-queue.legacy-review.__legacy_unknown__')).toBeNull();
    const persisted = JSON.parse(localStorage.getItem('nanoflow.retry-queue') ?? '{}') as { items?: RetryQueueItem[] };
    expect(persisted.items ?? []).toHaveLength(0);
    expect(toastMock.warning).not.toHaveBeenCalledWith(
      '检测到待确认的离线同步数据',
      expect.any(String),
    );
  });

  it('匿名启动且无持久 owner hint 时 legacy 重试残留应静默清理', async () => {
    loadFromStorageSpy.mockRestore();
    initDbSpy.mockResolvedValue(null);
    authServiceMock.currentUserId.mockReturnValue(null);
    authServiceMock.peekPersistedOwnerHint.mockReturnValue(null);
    saveToStorageSpy.mockImplementation(() => {
      (service as unknown as { saveToLocalStorage: () => void }).saveToLocalStorage();
      return undefined as unknown as Promise<void>;
    });

    localStorage.setItem('nanoflow.retry-queue', JSON.stringify({
      version: 1,
      items: [
        {
          id: crypto.randomUUID(),
          type: 'task',
          operation: 'upsert',
          data: createTask('t-anonymous-legacy-load'),
          projectId: 'p-anonymous',
          retryCount: 0,
          createdAt: Date.now(),
        },
      ],
      savedAt: Date.now(),
    }));

    service.reloadFromStorageForCurrentOwner();

    await vi.waitFor(() => {
      expect(service.getItems()).toEqual([]);
    });

    expect(localStorage.getItem('nanoflow.retry-queue.legacy-review.__legacy_unknown__')).toBeNull();
    expect(toastMock.warning).not.toHaveBeenCalledWith(
      '检测到待确认的离线同步数据',
      expect.any(String),
    );
  });

  it('匿名启动但存在持久云端 owner hint 时应保留 legacy 隔离保护', async () => {
    loadFromStorageSpy.mockRestore();
    initDbSpy.mockResolvedValue(null);
    authServiceMock.currentUserId.mockReturnValue(null);
    authServiceMock.peekPersistedOwnerHint.mockReturnValue('persisted-cloud-user');
    saveToStorageSpy.mockImplementation(() => {
      (service as unknown as { saveToLocalStorage: () => void }).saveToLocalStorage();
      return undefined as unknown as Promise<void>;
    });

    localStorage.setItem('nanoflow.retry-queue', JSON.stringify({
      version: 1,
      items: [
        {
          id: crypto.randomUUID(),
          type: 'task',
          operation: 'upsert',
          data: createTask('t-persisted-hint-legacy-load'),
          projectId: 'p-cloud',
          retryCount: 0,
          createdAt: Date.now(),
        },
      ],
      savedAt: Date.now(),
    }));

    service.reloadFromStorageForCurrentOwner();

    await vi.waitFor(() => {
      expect(service.getItems()).toEqual([]);
    });

    expect(localStorage.getItem('nanoflow.retry-queue.legacy-review.__legacy_unknown__')).toContain('t-persisted-hint-legacy-load');
    expect(toastMock.warning).toHaveBeenCalledWith(
      '检测到待确认的离线同步数据',
      expect.any(String),
    );
  });

  it('认证态下无法确认归属的 legacy 重试项应隔离保留而不是静默丢弃', async () => {
    const task = createTask('t-legacy-retry');
    (service as unknown as {
      queue: Array<Record<string, unknown>>;
    }).queue = [
      {
        id: crypto.randomUUID(),
        type: 'task',
        operation: 'upsert',
        data: task,
        projectId: 'p-1',
        retryCount: 0,
        createdAt: Date.now(),
      },
    ];
    online = true;

    await service.processQueue();

    expect(handler.pushTask).not.toHaveBeenCalled();
    expect(service.length).toBe(0);
    expect(localStorage.getItem('nanoflow.retry-queue.legacy-review.__legacy_unknown__')).toContain('t-legacy-retry');
    expect(toastMock.warning).toHaveBeenCalled();
  });

  it('认证态下即使项目已存在也应隔离缺少来源元数据的 legacy 重试项', async () => {
    const task = createTask('t-legacy-adopt');
    projectStateMock.getProject.mockReturnValueOnce({ id: 'p-1', syncSource: 'synced' });
    (service as unknown as {
      queue: Array<Record<string, unknown>>;
    }).queue = [
      {
        id: crypto.randomUUID(),
        type: 'task',
        operation: 'upsert',
        data: task,
        projectId: 'p-1',
        retryCount: 0,
        createdAt: Date.now(),
      },
    ];
    online = true;

    await service.processQueue();

    expect(handler.pushTask).not.toHaveBeenCalled();
    expect(service.length).toBe(0);
    expect(localStorage.getItem('nanoflow.retry-queue.legacy-review.__legacy_unknown__')).toContain('t-legacy-adopt');
    expect(toastMock.warning).toHaveBeenCalled();
  });

  it('legacy local-user 重试项应隔离保留而不是自动上云', async () => {
    const task = createTask('t-legacy-local-user');
    (service as unknown as {
      queue: Array<Record<string, unknown>>;
    }).queue = [
      {
        id: crypto.randomUUID(),
        type: 'task',
        operation: 'upsert',
        data: task,
        projectId: 'p-1',
        retryCount: 0,
        createdAt: Date.now(),
        sourceUserId: AUTH_CONFIG.LOCAL_MODE_USER_ID,
      },
    ];
    online = true;

    await service.processQueue();

    expect(handler.pushTask).not.toHaveBeenCalled();
    expect(service.length).toBe(0);
    expect(localStorage.getItem('nanoflow.retry-queue.legacy-review.__legacy_unknown__')).toContain('legacy local-user');
  });

  it('legacy local-user blackbox 重试项隔离时应把本地条目标记为 conflict', async () => {
    const entry = createBlackBoxEntry('legacy-local-user-blackbox', {
      syncStatus: 'pending',
    });
    (service as unknown as {
      queue: Array<Record<string, unknown>>;
    }).queue = [
      {
        id: crypto.randomUUID(),
        type: 'blackbox',
        operation: 'upsert',
        data: entry,
        retryCount: 0,
        createdAt: Date.now(),
        sourceUserId: AUTH_CONFIG.LOCAL_MODE_USER_ID,
      },
    ];
    online = true;

    await service.processQueue();

    expect(handler.pushBlackBoxEntry).not.toHaveBeenCalled();
    expect(blackBoxSyncMock.markEntrySyncConflict).toHaveBeenCalledWith(entry);
    expect(service.length).toBe(0);
  });

  it('blackbox 重试超过上限时应把本地 pending 标记为 conflict', async () => {
    const entry = createBlackBoxEntry('max-retry-blackbox', {
      syncStatus: 'pending',
    });
    (service as unknown as {
      queue: Array<Record<string, unknown>>;
      MAX_RETRIES: number;
    }).queue = [
      {
        id: crypto.randomUUID(),
        type: 'blackbox',
        operation: 'upsert',
        data: entry,
        retryCount: (service as unknown as { MAX_RETRIES: number }).MAX_RETRIES - 1,
        createdAt: Date.now(),
        sourceUserId: 'test-user',
      },
    ];
    (handler.pushBlackBoxEntry as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    online = true;

    await service.processQueue();

    expect(handler.pushBlackBoxEntry).toHaveBeenCalledWith(entry, 'test-user');
    expect(blackBoxSyncMock.markEntrySyncConflict).toHaveBeenCalledWith(entry);
    expect(service.length).toBe(0);
  });

  it('应修复历史 legacy review 中遗留的 blackbox pending 状态', () => {
    const entry = createBlackBoxEntry('legacy-review-blackbox', {
      syncStatus: 'pending',
      updatedAt: '2026-05-11T00:00:10.000Z',
    });
    localStorage.setItem(
      'nanoflow.retry-queue.legacy-review.__legacy_unknown__',
      JSON.stringify([
        {
          item: {
            id: crypto.randomUUID(),
            type: 'blackbox',
            operation: 'upsert',
            data: entry,
            retryCount: 0,
            createdAt: Date.now(),
            sourceUserId: AUTH_CONFIG.LOCAL_MODE_USER_ID,
          },
          reason: 'legacy local-user 重试项禁止自动上云',
          quarantinedAt: '2026-05-11T00:00:00.000Z',
          ownerUserId: '__legacy_unknown__',
        },
      ]),
    );

    (service as unknown as {
      repairQuarantinedBlackBoxEntriesFromStorage: () => void;
    }).repairQuarantinedBlackBoxEntriesFromStorage();

    expect(blackBoxSyncMock.markEntrySyncConflict).toHaveBeenCalledWith(entry);
  });

  it('历史 legacy review 修复应忽略其它账号的 blackbox 条目', () => {
    const foreignEntry = createBlackBoxEntry('legacy-review-foreign-blackbox', {
      userId: 'other-user',
      syncStatus: 'pending',
      updatedAt: '2026-05-11T00:00:20.000Z',
    });
    localStorage.setItem(
      'nanoflow.retry-queue.legacy-review.other-user',
      JSON.stringify([
        {
          item: {
            id: crypto.randomUUID(),
            type: 'blackbox',
            operation: 'upsert',
            data: foreignEntry,
            retryCount: 0,
            createdAt: Date.now(),
            sourceUserId: 'other-user',
          },
          reason: '跨账号重试项来源 other-user 与当前账号 test-user 不匹配',
          quarantinedAt: '2026-05-11T00:00:20.000Z',
          ownerUserId: 'other-user',
        },
      ]),
    );

    (service as unknown as {
      repairQuarantinedBlackBoxEntriesFromStorage: () => void;
    }).repairQuarantinedBlackBoxEntriesFromStorage();

    expect(blackBoxSyncMock.markEntrySyncConflict).not.toHaveBeenCalledWith(foreignEntry);
  });

  it('历史 legacy review 修复应优先采用同一条目的最新 blackbox 快照', () => {
    const entryId = stableUUID('legacy-review-blackbox-latest');
    const olderEntry = createBlackBoxEntry('legacy-review-blackbox-latest-old', {
      id: entryId,
      syncStatus: 'pending',
      updatedAt: '2026-05-11T00:00:05.000Z',
      content: 'old snapshot',
    });
    const newerEntry = createBlackBoxEntry('legacy-review-blackbox-latest-new', {
      id: entryId,
      syncStatus: 'pending',
      updatedAt: '2026-05-11T00:00:30.000Z',
      content: 'new snapshot',
    });
    localStorage.setItem(
      'nanoflow.retry-queue.legacy-review.test-user',
      JSON.stringify([
        {
          item: {
            id: crypto.randomUUID(),
            type: 'blackbox',
            operation: 'upsert',
            data: olderEntry,
            retryCount: 0,
            createdAt: Date.now(),
            sourceUserId: 'test-user',
          },
          reason: 'older snapshot',
          quarantinedAt: '2026-05-11T00:00:05.000Z',
          ownerUserId: 'test-user',
        },
        {
          item: {
            id: crypto.randomUUID(),
            type: 'blackbox',
            operation: 'upsert',
            data: newerEntry,
            retryCount: 0,
            createdAt: Date.now(),
            sourceUserId: 'test-user',
          },
          reason: 'newer snapshot',
          quarantinedAt: '2026-05-11T00:00:30.000Z',
          ownerUserId: 'test-user',
        },
      ]),
    );

    (service as unknown as {
      repairQuarantinedBlackBoxEntriesFromStorage: () => void;
    }).repairQuarantinedBlackBoxEntriesFromStorage();

    expect(blackBoxSyncMock.markEntrySyncConflict).toHaveBeenCalledTimes(1);
    expect(blackBoxSyncMock.markEntrySyncConflict).toHaveBeenCalledWith(newerEntry);
  });

  it('本地模式下 local-user 重试残留应静默清理且不弹待确认提示', async () => {
    authServiceMock.currentUserId.mockReturnValue(AUTH_CONFIG.LOCAL_MODE_USER_ID);
    const task = createTask('t-local-mode-leftover');
    (service as unknown as {
      queue: Array<Record<string, unknown>>;
    }).queue = [
      {
        id: crypto.randomUUID(),
        type: 'task',
        operation: 'upsert',
        data: task,
        projectId: 'p-1',
        retryCount: 0,
        createdAt: Date.now(),
        sourceUserId: AUTH_CONFIG.LOCAL_MODE_USER_ID,
      },
    ];
    online = true;

    await service.processQueue();

    expect(handler.pushTask).not.toHaveBeenCalled();
    expect(service.length).toBe(0);
    expect(localStorage.getItem('nanoflow.retry-queue.legacy-review.__legacy_unknown__')).toBeNull();
    expect(toastMock.warning).not.toHaveBeenCalledWith(
      '检测到待确认的离线同步数据',
      expect.any(String),
    );
  });

  it('仅清理终止态残留时也应回写 pendingCount，避免 UI 持续显示待同步', async () => {
    const task = createTask('t-terminal-cleanup-pending-count');
    (service as unknown as {
      queue: Array<Record<string, unknown>>;
    }).queue = [
      {
        id: crypto.randomUUID(),
        type: 'task',
        operation: 'upsert',
        data: task,
        // 缺少 projectId 会进入终止态清理分支，且不会发起网络同步。
        retryCount: 0,
        createdAt: Date.now(),
        sourceUserId: 'test-user',
      },
    ];
    online = true;
    vi.mocked(handler.onProcessingStateChange).mockClear();

    await service.processQueue();

    expect(handler.pushTask).not.toHaveBeenCalled();
    expect(service.length).toBe(0);
    expect(handler.onProcessingStateChange).not.toHaveBeenCalledWith(true, expect.any(Number));
    expect(handler.onProcessingStateChange).toHaveBeenCalledWith(false, 0);
  });

  it('跨账号重试项应隔离保留而不是在当前账号下重放', async () => {
    const task = createTask('t-foreign-user');
    (service as unknown as {
      queue: Array<Record<string, unknown>>;
    }).queue = [
      {
        id: crypto.randomUUID(),
        type: 'task',
        operation: 'upsert',
        data: task,
        projectId: 'p-1',
        retryCount: 0,
        createdAt: Date.now(),
        sourceUserId: 'other-user',
      },
    ];
    online = true;

    await service.processQueue();

    expect(handler.pushTask).not.toHaveBeenCalled();
    expect(service.length).toBe(0);
    expect(localStorage.getItem('nanoflow.retry-queue.legacy-review.other-user')).toContain('other-user');
  });

  it('queue_full 压力模式在容量恢复后应自动解锁', () => {
    (service as unknown as { maxQueueSize: number }).maxQueueSize = 3;

    expect(service.add('task', 'upsert', createTask('t-1'), 'p-1')).toBe(true);
    expect(service.add('task', 'upsert', createTask('t-2'), 'p-1')).toBe(true);
    expect(service.add('task', 'upsert', createTask('t-3'), 'p-1')).toBe(true);
    expect(service.add('task', 'upsert', createTask('t-4'), 'p-1')).toBe(true);
    expect(service.queuePressure()).toBe(true);
    expect(service.queuePressureReason()).toBe('queue_full');

    service.removeByEntityId(stableUUID('t-1')); // 3 -> 2
    service.removeByEntityId(stableUUID('t-2')); // 2 -> 1
    expect(service.length).toBe(2);

    (service as unknown as { tryRecoverQueueFullPressure: (force?: boolean) => void }).tryRecoverQueueFullPressure(true);
    expect(service.queuePressure()).toBe(false);
    expect(service.queuePressureReason()).toBeNull();
  });

  it('processQueue 出现异常后应释放处理锁并回写状态', async () => {
    (service as unknown as { maxQueueSize: number }).maxQueueSize = 3;
    service.add('task', 'upsert', createTask('t-1'), 'p-1');
    online = true;

    (service as unknown as { saveToStorage: () => Promise<void> }).saveToStorage = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('save crash');
      })
      .mockResolvedValue(undefined) as unknown as () => Promise<void>;

    await service.processQueue();

    expect((service as unknown as { isProcessingQueue: boolean }).isProcessingQueue).toBe(false);
    expect(handler.onProcessingStateChange).toHaveBeenCalledWith(true, 1);
    expect(handler.onProcessingStateChange).toHaveBeenCalledWith(false, 0);
  });

  it('处理切片中被移除的项目重试项不应继续重放', async () => {
    const firstTask = createTask('t-keep-processing');
    const secondTask = createTask('t-removed-during-slice');
    service.add('task', 'upsert', firstTask, 'p-keep');
    service.add('task', 'upsert', secondTask, 'p-drop');
    online = true;

    (handler.pushTask as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(async () => {
        service.removeByProjectId('p-drop');
        return true;
      })
      .mockResolvedValue(true);

    await service.processQueueSlice();

    expect(handler.pushTask).toHaveBeenCalledTimes(1);
    expect(handler.pushTask).toHaveBeenCalledWith(firstTask, 'p-keep', 'test-user');
    expect(service.getItems().some(item => item.projectId === 'p-drop')).toBe(false);
  });

  it('removeByProjectId 应同时清理 hidden bucket 中的同项目重试项', () => {
    const visibleTask = createTask('t-visible-remove-by-project');
    const hiddenTask = createTask('t-hidden-remove-by-project');
    service.add('task', 'upsert', visibleTask, 'p-drop');
    service.add('task', 'upsert', hiddenTask, 'p-drop', 'other-user');

    const removed = service.removeByProjectId('p-drop');

    expect(removed).toBe(2);
    expect(service.getItems()).toEqual([]);
    expect((service as unknown as { hiddenQueueItems: RetryQueueItem[] }).hiddenQueueItems).toEqual([]);
  });

  it('removeByEntities 应同时清理 visible 与 hidden bucket 中的同实体重试项', () => {
    const visibleTask = createTask('task-visible-remove-by-entities');
    const hiddenTask = createTask('task-hidden-remove-by-entities');
    const unrelatedTask = createTask('task-keep-remove-by-entities');
    service.add('task', 'upsert', visibleTask, 'p-entities');
    service.add('task', 'delete', hiddenTask, 'p-entities', 'other-user');
    service.add('task', 'upsert', unrelatedTask, 'p-entities');

    const removedTaskIds = service.removeByEntities('task', [visibleTask.id, hiddenTask.id]);

    expect(removedTaskIds).toEqual(expect.arrayContaining([visibleTask.id, hiddenTask.id]));
    expect(removedTaskIds).not.toContain(unrelatedTask.id);
    expect(service.getItems().map(item => item.data.id)).toEqual([unrelatedTask.id]);
    expect((service as unknown as { hiddenQueueItems: RetryQueueItem[] }).hiddenQueueItems).toEqual([]);
  });

  it('removeConnectionsReferencingTasks 应同时清理 visible 与 hidden 的悬挂连接重试项', () => {
    const visibleConnection = createConnection('visible-orphan', 'task-deleted', 'task-keep');
    const hiddenConnection = createConnection('hidden-orphan', 'task-keep', 'task-deleted');
    const unrelatedConnection = createConnection('unrelated', 'task-keep-a', 'task-keep-b');
    service.add('connection', 'upsert', visibleConnection, 'p-drop');
    service.add('connection', 'upsert', hiddenConnection, 'p-drop', 'other-user');
    service.add('connection', 'upsert', unrelatedConnection, 'p-drop');

    const removedConnectionIds = service.removeConnectionsReferencingTasks('p-drop', [stableUUID('task-deleted')]);

    expect(removedConnectionIds).toEqual(expect.arrayContaining([visibleConnection.id, hiddenConnection.id]));
    expect(removedConnectionIds).not.toContain(unrelatedConnection.id);
    expect(service.getItems().map(item => item.data.id)).toEqual([unrelatedConnection.id]);
    expect((service as unknown as { hiddenQueueItems: RetryQueueItem[] }).hiddenQueueItems).toEqual([]);
  });

  it('切账号期间已成功的 in-flight 重试项应从 hidden 持久化队列移除', async () => {
    initDbSpy.mockResolvedValue(null);
    saveToStorageSpy.mockImplementation(() => {
      (service as unknown as { saveToLocalStorage: () => void }).saveToLocalStorage();
      return undefined as unknown as Promise<void>;
    });

    const task = createTask('retry-inflight-success');
    service.add('task', 'upsert', task, 'p-retry');
    const inFlightItemId = service.getItems()[0]?.id;
    online = true;

    let resolvePush: ((value: boolean) => void) | null = null;
    (handler.pushTask as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise<boolean>(resolve => {
      resolvePush = resolve;
    }));

    const processing = service.processQueueSlice({ maxItems: 1, maxDurationMs: 1000 });
    await vi.waitFor(() => {
      expect(handler.pushTask).toHaveBeenCalledOnce();
    });

    authServiceMock.currentUserId.mockReturnValue('other-user');
    service.clearCurrentView();
    resolvePush!(true);
    await processing;

    const persisted = JSON.parse(localStorage.getItem('nanoflow.retry-queue') ?? '{}') as {
      items?: RetryQueueItem[];
    };

    expect((service as unknown as { hiddenQueueItems: RetryQueueItem[] }).hiddenQueueItems).toEqual([]);
    expect((persisted.items ?? []).find(item => item.id === inFlightItemId)).toBeUndefined();
  });

  it('切账号期间失败的 in-flight 重试项应保留在 hidden 队列并递增 retryCount', async () => {
    initDbSpy.mockResolvedValue(null);
    saveToStorageSpy.mockImplementation(() => {
      (service as unknown as { saveToLocalStorage: () => void }).saveToLocalStorage();
      return undefined as unknown as Promise<void>;
    });

    const task = createTask('retry-inflight-failure');
    service.add('task', 'upsert', task, 'p-retry');
    const inFlightItemId = service.getItems()[0]?.id;
    online = true;

    let rejectPush: ((reason?: unknown) => void) | null = null;
    (handler.pushTask as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise<boolean>((_resolve, reject) => {
      rejectPush = reject;
    }));

    const processing = service.processQueueSlice({ maxItems: 1, maxDurationMs: 1000 });
    await vi.waitFor(() => {
      expect(handler.pushTask).toHaveBeenCalledOnce();
    });

    authServiceMock.currentUserId.mockReturnValue('other-user');
    service.clearCurrentView();
    rejectPush!(new Error('network down'));
    await processing;

    const hiddenItems = (service as unknown as { hiddenQueueItems: RetryQueueItem[] }).hiddenQueueItems;
    const persisted = JSON.parse(localStorage.getItem('nanoflow.retry-queue') ?? '{}') as {
      items?: RetryQueueItem[];
    };
    const persistedItem = (persisted.items ?? []).find(item => item.id === inFlightItemId);

    expect(hiddenItems).toHaveLength(1);
    expect(hiddenItems[0]?.retryCount).toBe(1);
    expect(persistedItem?.retryCount).toBe(1);
  });

  it('切账号后新的 owner 不应被旧 in-flight 处理锁阻塞', async () => {
    let resolveFirst: ((value: boolean) => void) | null = null;
    const firstTask = createTask('retry-owner-switch-first');
    const secondTask = createTask('retry-owner-switch-second');
    service.add('task', 'upsert', firstTask, 'p-first');
    online = true;

    (handler.pushTask as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(() => new Promise<boolean>(resolve => {
        resolveFirst = resolve;
      }))
      .mockResolvedValueOnce(true);

    const firstProcessing = service.processQueueSlice({ maxItems: 1, maxDurationMs: 1000 });
    await vi.waitFor(() => {
      expect(handler.pushTask).toHaveBeenCalledTimes(1);
    });

    authServiceMock.currentUserId.mockReturnValue('other-user');
    service.clearCurrentView();

    service.add('task', 'upsert', secondTask, 'p-second');
    const secondProcessing = service.processQueueSlice({ maxItems: 1, maxDurationMs: 1000 });

    await vi.waitFor(() => {
      expect(handler.pushTask).toHaveBeenCalledTimes(2);
    });

    resolveFirst!(true);
    await firstProcessing;
    await secondProcessing;

    expect((service as unknown as { isProcessingQueue: boolean }).isProcessingQueue).toBe(false);
  });

  it('满队列进入压力模式后，在线状态应触发应急处理并继续入队', async () => {
    (service as unknown as { maxQueueSize: number }).maxQueueSize = 1;

    expect(service.add('task', 'upsert', createTask('t-1'), 'p-1')).toBe(true);
    online = true;

    expect(service.add('task', 'upsert', createTask('t-2'), 'p-1')).toBe(true);
    expect(service.queuePressure()).toBe(true);

    await vi.waitFor(() => {
      expect(handler.pushTask).toHaveBeenCalledTimes(1);
    }, { timeout: 200, interval: 10 });
    expect(service.length).toBe(1);

    await service.processQueue();
    expect(handler.pushTask).toHaveBeenCalledTimes(2);
    expect(service.length).toBe(0);
  });

  it('queue_full 压力模式下应允许同实体更新覆盖（不视为新增入队）', () => {
    (service as unknown as { maxQueueSize: number }).maxQueueSize = 2;
    online = false;

    expect(service.add('task', 'upsert', createTask('t-1'), 'p-1')).toBe(true);
    expect(service.add('task', 'upsert', createTask('t-2'), 'p-1')).toBe(true);

    // 新实体入队触发 queue_full 压力模式
    expect(service.add('task', 'upsert', createTask('t-3'), 'p-1')).toBe(true);
    expect(service.queuePressure()).toBe(true);
    expect(service.queuePressureReason()).toBe('queue_full');

    // 清理前一次拒绝触发的提示，验证下面不会再次触发
    toastMock.warning.mockClear();

    const updated = createTask('t-1');
    updated.title = 'Task t-1 updated';

    // 同实体更新应成功（覆盖队列项），而不是被压力模式拒绝
    expect(service.add('task', 'upsert', updated, 'p-1')).toBe(true);
    expect(service.length).toBe(3);
    expect(service.getItems().find(item => item.data.id === stableUUID('t-1'))?.data).toEqual(updated);
    expect(toastMock.warning).not.toHaveBeenCalled();
  });

  it('storage 压力恢复后应自动退出压力模式', () => {
    (service as unknown as { enterPressureMode: (reason: string) => void }).enterPressureMode('storage_quota_exceeded');
    expect(service.queuePressure()).toBe(true);
    expect(service.queuePressureReason()).toBe('storage_quota_exceeded');

    (service as unknown as { tryRecoverQueueFullPressure: (force?: boolean) => void }).tryRecoverQueueFullPressure(true);

    expect(service.queuePressure()).toBe(false);
    expect(service.queuePressureReason()).toBeNull();
  });

  // ==================== Task 2.2 / 3.1 新增测试 ====================
  
  it('getCapacityPercent 应返回正确的容量百分比', () => {
    (service as unknown as { maxQueueSize: number }).maxQueueSize = 10;
    
    expect(service.getCapacityPercent()).toBe(0);
    
    service.add('task', 'upsert', createTask('t-1'), 'p-1');
    service.add('task', 'upsert', createTask('t-2'), 'p-1');
    service.add('task', 'upsert', createTask('t-3'), 'p-1');
    
    expect(service.getCapacityPercent()).toBe(30);
  });

  it('getCapacityPercent 队列满时应返回 100 或更高', () => {
    (service as unknown as { maxQueueSize: number }).maxQueueSize = 2;
    
    service.add('task', 'upsert', createTask('t-1'), 'p-1');
    service.add('task', 'upsert', createTask('t-2'), 'p-1');
    
    expect(service.getCapacityPercent()).toBeGreaterThanOrEqual(100);
  });

  it('checkCapacityWarning 在 80%+ 时应记录日志（WARNING_THRESHOLD=0.8）', () => {
    (service as unknown as { maxQueueSize: number }).maxQueueSize = 10;
    // 重置冷却时间
    (service as unknown as { lastWarningTime: number }).lastWarningTime = 0;
    (service as unknown as { lastWarningPercent: number }).lastWarningPercent = 0;
    
    // 添加 8 个任务达到 80%，刚好超过 WARNING_THRESHOLD(0.8) 的门槛
    for (let i = 0; i < 8; i++) {
      service.add('task', 'upsert', createTask(`cap-${i}`), 'p-1');
    }
    
    // 80% 超过阈值，应触发日志
    expect(loggerCategory.warn).toHaveBeenCalled();
  });

  it('checkCapacityWarning 在 95%+ 时应触发 error 级别日志', () => {
    (service as unknown as { maxQueueSize: number }).maxQueueSize = 20;
    
    // 先添加 19 个任务达到 95%（此过程中会内部触发 warning）
    for (let i = 0; i < 19; i++) {
      service.add('task', 'upsert', createTask(`crit-${i}`), 'p-1');
    }
    
    // 重置冷却，然后显式再次调用 checkCapacityWarning
    (service as unknown as { lastWarningTime: number }).lastWarningTime = 0;
    (service as unknown as { lastWarningPercent: number }).lastWarningPercent = 0;
    loggerCategory.error.mockClear();
    
    service.checkCapacityWarning();
    
    // 95% 应触发 error 级别日志
    expect(loggerCategory.error).toHaveBeenCalled();
  });

  it('processQueueSlice 应按 maxItems 切片并返回未完成状态', async () => {
    service.add('task', 'upsert', createTask('slice-1'), 'p-1');
    service.add('task', 'upsert', createTask('slice-2'), 'p-1');
    service.add('task', 'upsert', createTask('slice-3'), 'p-1');
    online = true;

    const result = await service.processQueueSlice({ maxItems: 2, maxDurationMs: 1000 });

    expect(result.processed).toBe(2);
    expect(result.completed).toBe(false);
    expect(result.remaining).toBe(1);
    expect(handler.pushTask).toHaveBeenCalledTimes(2);
  });

  it('processQueueSlice 应按 maxDurationMs 切片并可续跑完成', async () => {
    let fakeNow = 1000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => fakeNow);
    (handler.pushTask as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      fakeNow += 220;
      return true;
    });

    service.add('task', 'upsert', createTask('budget-1'), 'p-1');
    service.add('task', 'upsert', createTask('budget-2'), 'p-1');
    service.add('task', 'upsert', createTask('budget-3'), 'p-1');
    online = true;

    const first = await service.processQueueSlice({ maxItems: 30, maxDurationMs: 150 });
    expect(first.processed).toBe(1);
    expect(first.completed).toBe(false);
    expect(first.remaining).toBe(2);

    const second = await service.processQueueSlice({ maxItems: 30, maxDurationMs: 150 });
    expect(second.processed).toBe(1);
    expect(second.completed).toBe(false);
    expect(second.remaining).toBe(1);

    const third = await service.processQueueSlice({ maxItems: 30, maxDurationMs: 150 });
    expect(third.processed).toBe(1);
    expect(third.completed).toBe(true);
    expect(third.remaining).toBe(0);

    nowSpy.mockRestore();
  });

  it('processQueueSlice 遇到浏览器网络挂起异常时不应消耗 retry budget', async () => {
    const recordCircuitFailureSpy = vi.spyOn(service, 'recordCircuitFailure');
    const task = createTask('suspended-retry-item');
    service.add('task', 'upsert', task, 'p-1');
    online = true;
    (handler.pushTask as ReturnType<typeof vi.fn>).mockRejectedValueOnce(createBrowserNetworkSuspendedError());

    const result = await service.processQueueSlice({ maxItems: 1, maxDurationMs: 1000 });

    expect(result.processed).toBe(1);
    expect(result.completed).toBe(false);
    expect(recordCircuitFailureSpy).not.toHaveBeenCalled();
    expect(service.getItems()).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ id: task.id }),
        retryCount: 0,
      }),
    ]);
  });

  it('manual processQueue 应等待恢复保护期结束后再重放', async () => {
    vi.useFakeTimers();
    try {
      const task = createTask('manual-suspended-wait');
      service.add('task', 'upsert', task, 'p-1');
      online = true;

      expect(isBrowserNetworkSuspendedWindow()).toBe(false);
      setVisibilityState('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      setVisibilityState('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      expect(isBrowserNetworkSuspendedWindow()).toBe(true);

      const processPromise = service.processQueue(undefined, true);
      expect(handler.pushTask).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1499);
      expect(handler.pushTask).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await processPromise;

      expect(handler.pushTask).toHaveBeenCalledOnce();
      expect(service.getItems()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
