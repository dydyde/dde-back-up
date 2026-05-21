/**
 * ParkingService 单元测试
 * 覆盖 A12 验收标准 P-01 ~ P-40
 */

import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Project, Task, TaskParkingMeta } from '../models';
import { TaskStore, ProjectStore } from '../app/core/state/stores';
import { ParkingService } from './parking.service';
import { ToastService } from './toast.service';
import { UndoService } from './undo.service';
import { LoggerService } from './logger.service';
import { BeforeUnloadManagerService } from './before-unload-manager.service';
import { StartupTierOrchestratorService } from './startup-tier-orchestrator.service';
import { GateService } from './gate.service';
import { ContextRestoreService } from './context-restore.service';
import { ProjectDataService } from '../core-bridge';
import { PARKING_CONFIG } from '../config/parking.config';
import { AuthService } from './auth.service';
import { resetBrowserNetworkSuspensionTrackingForTests } from '../utils/browser-network-suspension';

describe('ParkingService', () => {
  let service: ParkingService;

  const taskMap = new Map<string, Task>();
  const parkedTasksSignal = signal<Task[]>([]);
  const parkedTaskIdsSignal = signal<Set<string>>(new Set());
  const projectListSignal = signal<Project[]>([]);

  const syncParkedSignals = (): void => {
    const parked = Array.from(taskMap.values()).filter(t => !!t.parkingMeta);
    parkedTasksSignal.set(parked);
    parkedTaskIdsSignal.set(new Set(parked.map(t => t.id)));
  };

  const createParkingMeta = (overrides: Partial<TaskParkingMeta> = {}): TaskParkingMeta => ({
    state: 'parked',
    parkedAt: new Date(Date.now() - 80 * 60 * 60 * 1000).toISOString(),
    lastVisitedAt: new Date(Date.now() - 80 * 60 * 60 * 1000).toISOString(),
    contextSnapshot: null,
    reminder: null,
    pinned: false,
    ...overrides,
  });

  const createTask = (overrides: Partial<Task> = {}): Task => ({
    id: crypto.randomUUID(),
    title: '测试任务',
    content: '',
    stage: 0,
    parentId: null,
    order: 0,
    rank: 10000,
    status: 'active',
    x: 0,
    y: 0,
    displayId: 'T-1',
    createdDate: new Date().toISOString(),
    deletedAt: null,
    parkingMeta: null,
    ...overrides,
  });

  const createProject = (projectId: string): Project => ({
    id: projectId,
    name: '测试项目',
    description: '',
    createdDate: new Date().toISOString(),
    tasks: Array.from(taskMap.values()),
    connections: [],
    deletedAt: null,
  });

  const mockTaskStore = {
    parkedTaskIds: parkedTaskIdsSignal,
    parkedTasks: parkedTasksSignal,
    getTask: vi.fn((id: string) => taskMap.get(id)),
    setTask: vi.fn((task: Task, _projectId: string) => {
      taskMap.set(task.id, task);
      syncParkedSignals();
    }),
    getTaskProjectId: vi.fn(() => 'proj-1'),
  };

  const mockProjectStore = {
    activeProjectId: signal<string | null>('proj-1'),
    projects: projectListSignal,
    getProject: vi.fn((projectId: string) => ({
      id: projectId,
      name: '测试项目',
      description: '',
      createdDate: new Date().toISOString(),
      tasks: Array.from(taskMap.values()),
      connections: [],
    })),
  };

  const mockToastService = {
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    show: vi.fn(),
  };

  const mockUndoService = {
    recordAction: vi.fn(),
    createProjectSnapshot: vi.fn((project: { id: string; tasks: Task[]; connections: unknown[] }) => ({
      id: project.id,
      tasks: project.tasks.map(t => ({ ...t })),
      connections: [...project.connections],
    })),
  };

  const mockLoggerService = {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  const mockBeforeUnloadManager = {
    register: vi.fn(),
  };

  const mockStartupOrchestrator = {
    isTierReady: vi.fn(() => true),
  };

  const mockGateService = {
    isActive: signal(false),
  };

  const mockContextRestoreService = {
    saveSnapshot: vi.fn(),
    restore: vi.fn(),
  };

  const currentUserIdSignal = signal<string | null>(null);

  const mockAuthService = {
    currentUserId: currentUserIdSignal,
  };

  const mockProjectDataService = {
    loadParkedTasksCache: vi.fn(async () => ({ entries: [], cursor: null })),
    pullParkedTasksDelta: vi.fn(async () => ({ entries: [], removedTaskIds: [], nextCursor: null })),
    saveParkedTasksCache: vi.fn(async () => {}),
  };

  const setVisibilityState = (state: DocumentVisibilityState): void => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: state,
    });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-23T10:00:00.000Z'));
    setVisibilityState('visible');

    taskMap.clear();
    projectListSignal.set([createProject('proj-1')]);
    parkedTasksSignal.set([]);
    parkedTaskIdsSignal.set(new Set());
    mockGateService.isActive.set(false);
    currentUserIdSignal.set(null);
    localStorage.removeItem('nanoflow-local-mode');
    vi.clearAllMocks();

    TestBed.configureTestingModule({
      providers: [
        ParkingService,
        { provide: TaskStore, useValue: mockTaskStore },
        { provide: ProjectStore, useValue: mockProjectStore },
        { provide: ToastService, useValue: mockToastService },
        { provide: UndoService, useValue: mockUndoService },
        { provide: LoggerService, useValue: mockLoggerService },
        { provide: BeforeUnloadManagerService, useValue: mockBeforeUnloadManager },
        { provide: StartupTierOrchestratorService, useValue: mockStartupOrchestrator },
        { provide: GateService, useValue: mockGateService },
        { provide: ContextRestoreService, useValue: mockContextRestoreService },
        { provide: ProjectDataService, useValue: mockProjectDataService },
        { provide: AuthService, useValue: mockAuthService },
      ],
    });

    service = TestBed.inject(ParkingService);
  });

  afterEach(() => {
    service?.ngOnDestroy();
    resetBrowserNetworkSuspensionTrackingForTests();
    setVisibilityState('visible');
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  // ─── P-01: 预览任务刷新 lastVisitedAt ───

  describe('P-01: previewTask', () => {
    it('预览停泊任务应刷新 lastVisitedAt', () => {
      const oldTime = new Date('2026-02-20T10:00:00.000Z').toISOString();
      const task = createTask({
        id: 'preview-1',
        parkingMeta: createParkingMeta({ lastVisitedAt: oldTime }),
      });
      taskMap.set(task.id, task);
      syncParkedSignals();

      service.previewTask('preview-1');

      const updated = taskMap.get('preview-1');
      expect(updated?.parkingMeta?.lastVisitedAt).not.toBe(oldTime);
      expect(service.previewingTaskId()).toBe('preview-1');
    });

    it('非停泊任务预览应静默忽略', () => {
      const task = createTask({ id: 'normal-1', parkingMeta: null });
      taskMap.set(task.id, task);

      service.previewTask('normal-1');
      expect(service.previewingTaskId()).toBeNull();
    });
  });

  // ─── P-02: startWork 切换任务 ───

  describe('P-02: startWork', () => {
    it('切换到目标任务并将当前 focused 停泊', () => {
      const currentFocused = createTask({
        id: 'focused-1',
        title: '当前任务',
        parkingMeta: createParkingMeta({ state: 'focused', parkedAt: null }),
      });
      const targetTask = createTask({
        id: 'parked-1',
        title: '目标任务',
        parkingMeta: createParkingMeta({ state: 'parked' }),
      });
      taskMap.set(currentFocused.id, currentFocused);
      taskMap.set(targetTask.id, targetTask);
      syncParkedSignals();

      service.startWork(targetTask.id);

      // 当前 focused → parked
      expect(taskMap.get('focused-1')?.parkingMeta?.state).toBe('parked');
      // 目标 → focused
      expect(taskMap.get('parked-1')?.parkingMeta?.state).toBe('focused');
    });

    it('应保存当前 focused 任务的上下文快照', () => {
      const currentFocused = createTask({
        id: 'focused-save',
        parkingMeta: createParkingMeta({ state: 'focused', parkedAt: null }),
      });
      const target = createTask({
        id: 'target-save',
        parkingMeta: createParkingMeta({ state: 'parked' }),
      });
      taskMap.set(currentFocused.id, currentFocused);
      taskMap.set(target.id, target);
      syncParkedSignals();

      service.startWork(target.id);

      expect(mockContextRestoreService.saveSnapshot).toHaveBeenCalledWith('focused-save');
    });

    it('应恢复目标任务的上下文快照', () => {
      const snapshot = {
        savedAt: new Date().toISOString(),
        contentHash: 'hash',
        viewMode: 'text' as const,
        cursorPosition: { line: 10, column: 5 },
        scrollAnchor: null,
        structuralAnchor: null,
        flowViewport: null,
      };
      const target = createTask({
        id: 'restore-target',
        parkingMeta: createParkingMeta({ state: 'parked', contextSnapshot: snapshot }),
      });
      taskMap.set(target.id, target);
      syncParkedSignals();

      service.startWork(target.id);

      expect(mockContextRestoreService.restore).toHaveBeenCalledWith('restore-target', snapshot);
    });

    it('目标不存在时应 warn 并退出', () => {
      service.startWork('nonexistent');
      expect(mockLoggerService.warn).toHaveBeenCalled();
    });

    it('非 active 状态任务不应切换', () => {
      const completedTask = createTask({
        id: 'completed-task',
        status: 'completed',
        parkingMeta: createParkingMeta(),
      });
      taskMap.set(completedTask.id, completedTask);
      syncParkedSignals();

      service.startWork('completed-task');

      expect(mockLoggerService.warn).toHaveBeenCalled();
    });

    it('记录 task-park 的 Undo 操作（P-34）', () => {
      const currentFocused = createTask({
        id: 'undo-focused',
        title: '当前任务',
        parkingMeta: createParkingMeta({ state: 'focused', parkedAt: null }),
      });
      const targetTask = createTask({
        id: 'undo-target',
        title: '目标任务',
        parkingMeta: createParkingMeta({ state: 'parked' }),
      });
      taskMap.set(currentFocused.id, currentFocused);
      taskMap.set(targetTask.id, targetTask);
      syncParkedSignals();

      service.startWork(targetTask.id);

      expect(mockUndoService.recordAction).toHaveBeenCalled();
      const action = mockUndoService.recordAction.mock.calls[0][0] as {
        type: string;
        data: { before: { tasks: Task[] } };
      };
      expect(action.type).toBe('task-park');
      expect(action.data.before.tasks.length).toBe(2);
    });
  });

  // ─── P-09/P-10: 72h 衰老清理与撤回 ───

  describe('P-09/P-10: 衰老清理', () => {
    it('72h 未访问任务应被自动清理', () => {
      const staleTask = createTask({ id: 'stale-72h', parkingMeta: createParkingMeta() });
      taskMap.set(staleTask.id, staleTask);
      syncParkedSignals();

      (service as unknown as { runEvictionCheck: () => void }).runEvictionCheck();

      expect(taskMap.get('stale-72h')?.parkingMeta).toBeUndefined();
      expect(service.pendingNotices().length).toBe(1);
    });

    it('清理通知包含撤回按钮', () => {
      const staleTask = createTask({ id: 'stale-undo', title: '可撤回', parkingMeta: createParkingMeta() });
      taskMap.set(staleTask.id, staleTask);
      syncParkedSignals();

      (service as unknown as { runEvictionCheck: () => void }).runEvictionCheck();

      const notice = service.pendingNotices()[0];
      expect(notice.type).toBe('eviction');
      expect(notice.actions.some(a => a.key === 'undo-eviction')).toBe(true);
    });

    it('撤回应恢复原始停泊状态', () => {
      const staleTask = createTask({
        id: 'stale-restore',
        parkingMeta: createParkingMeta({ pinned: false }),
      });
      taskMap.set(staleTask.id, staleTask);
      syncParkedSignals();

      (service as unknown as { runEvictionCheck: () => void }).runEvictionCheck();

      const notice = service.pendingNotices()[0];
      const tokenId = notice.evictionTokenId!;
      service.undoEviction(tokenId);

      const restored = taskMap.get('stale-restore');
      expect(restored?.parkingMeta?.state).toBe('parked');
    });
  });

  // ─── P-11: 手动移除可撤回 ───

  describe('P-11: removeParkedTask', () => {
    it('移除后应显示 5s 撤回 Snackbar', () => {
      const task = createTask({
        id: 'remove-1',
        title: '将移除的任务',
        parkingMeta: createParkingMeta({ state: 'parked' }),
      });
      taskMap.set(task.id, task);
      syncParkedSignals();

      service.removeParkedTask('remove-1');

      expect(taskMap.get('remove-1')?.parkingMeta).toBeUndefined();
      expect(mockToastService.info).toHaveBeenCalled();
      const call = mockToastService.info.mock.calls[0];
      expect(call[0]).toContain('将移除的任务');
    });

    it('移除时若正在预览应清除预览状态', () => {
      const task = createTask({
        id: 'remove-preview',
        parkingMeta: createParkingMeta(),
      });
      taskMap.set(task.id, task);
      syncParkedSignals();
      service.previewTask('remove-preview');

      service.removeParkedTask('remove-preview');

      expect(service.previewingTaskId()).toBeNull();
    });
  });

  // ─── P-16: 离线保护 ───

  describe('P-16: 离线清理保护', () => {
    it('离线时不执行衰老清理', () => {
      const staleTask = createTask({ id: 'offline-1', parkingMeta: createParkingMeta() });
      taskMap.set(staleTask.id, staleTask);
      syncParkedSignals();

      const onlineSpy = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
      (service as unknown as { runEvictionCheck: () => void }).runEvictionCheck();

      expect(taskMap.get('offline-1')?.parkingMeta).toBeTruthy();
      expect(service.pendingNotices().length).toBe(0);
      onlineSpy.mockRestore();
    });

    it('恢复在线后应立即重新执行衰老清理并发出通知', () => {
      const staleTask = createTask({ id: 'offline-retry-1', parkingMeta: createParkingMeta() });
      taskMap.set(staleTask.id, staleTask);
      syncParkedSignals();

      let isOnline = false;
      const onlineSpy = vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => isOnline);

      (service as unknown as { runEvictionCheck: () => void }).runEvictionCheck();

      expect(taskMap.get('offline-retry-1')?.parkingMeta).toBeTruthy();
      expect(service.pendingNotices().length).toBe(0);

      isOnline = true;
      window.dispatchEvent(new Event('online'));

      expect(taskMap.get('offline-retry-1')?.parkingMeta).toBeUndefined();
      expect(service.pendingNotices().length).toBe(1);
      expect(service.pendingNotices()[0].type).toBe('eviction');

      onlineSpy.mockRestore();
    });
  });

  describe('停泊轻量同步鉴权保护', () => {
    it('访客态初始化时不应触发停泊任务云端拉取', async () => {
      await Promise.resolve();
      await Promise.resolve();

      expect(mockProjectDataService.pullParkedTasksDelta).not.toHaveBeenCalled();
    });

    it('登录后手动增量同步应恢复云端拉取', async () => {
      currentUserIdSignal.set('user-1');

      await (service as unknown as { syncParkedDelta: () => Promise<void> }).syncParkedDelta();

      expect(mockProjectDataService.pullParkedTasksDelta).toHaveBeenCalledTimes(1);
      expect(mockProjectDataService.pullParkedTasksDelta).toHaveBeenCalledWith(null, [], ['proj-1']);
    });

    it('项目列表未就绪时不应使用 activeProjectId 推进停泊游标', async () => {
      currentUserIdSignal.set('user-1');
      projectListSignal.set([]);

      await (service as unknown as { syncParkedDelta: () => Promise<void> }).syncParkedDelta();

      expect(mockProjectDataService.pullParkedTasksDelta).not.toHaveBeenCalled();
    });

    it('项目列表恢复后应快速补拉一次停泊任务增量', async () => {
      currentUserIdSignal.set('user-1');
      projectListSignal.set([]);

      await (service as unknown as { syncParkedDelta: () => Promise<void> }).syncParkedDelta();
      expect(mockProjectDataService.pullParkedTasksDelta).not.toHaveBeenCalled();

      projectListSignal.set([createProject('proj-1')]);
      await vi.advanceTimersByTimeAsync(500);

      expect(mockProjectDataService.pullParkedTasksDelta).toHaveBeenCalledTimes(1);
      expect(mockProjectDataService.pullParkedTasksDelta).toHaveBeenCalledWith(null, [], ['proj-1']);
    });

    it('挂起窗口内不应触发停泊任务云端拉取', async () => {
      currentUserIdSignal.set('user-1');
      setVisibilityState('hidden');

      await (service as unknown as { syncParkedDelta: () => Promise<void> }).syncParkedDelta();

      expect(mockProjectDataService.pullParkedTasksDelta).not.toHaveBeenCalled();
    });

    it('恢复可见后应延迟补拉一次停泊任务增量', async () => {
      currentUserIdSignal.set('user-1');
      setVisibilityState('hidden');

      await (service as unknown as { syncParkedDelta: () => Promise<void> }).syncParkedDelta();
      expect(mockProjectDataService.pullParkedTasksDelta).not.toHaveBeenCalled();

      setVisibilityState('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(1800);

      expect(mockProjectDataService.pullParkedTasksDelta).toHaveBeenCalledTimes(1);
    });
  });

  // ─── P-17: 无 focused 任务时切换 ───

  describe('P-17: 无 focused 任务时 startWork', () => {
    it('无 focused 任务时直接将目标设为 focused', () => {
      const target = createTask({
        id: 'only-task',
        parkingMeta: createParkingMeta({ state: 'parked' }),
      });
      taskMap.set(target.id, target);
      syncParkedSignals();

      service.startWork('only-task');

      expect(taskMap.get('only-task')?.parkingMeta?.state).toBe('focused');
    });
  });

  // ─── P-21: 软上限警告 ───

  describe('P-21: 软上限', () => {
    it('parkedCount >= SOFT_LIMIT 时 isOverSoftLimit 为 true', () => {
      for (let i = 0; i < PARKING_CONFIG.PARKED_TASK_SOFT_LIMIT; i++) {
        const task = createTask({
          id: `soft-${i}`,
          parkingMeta: createParkingMeta({ state: 'parked' }),
        });
        taskMap.set(task.id, task);
      }
      syncParkedSignals();

      expect(service.isOverSoftLimit()).toBe(true);
    });

    it('parkedCount < SOFT_LIMIT 时 isOverSoftLimit 为 false', () => {
      const task = createTask({
        id: 'single-parked',
        parkingMeta: createParkingMeta({ state: 'parked' }),
      });
      taskMap.set(task.id, task);
      syncParkedSignals();

      expect(service.isOverSoftLimit()).toBe(false);
    });
  });

  // ─── P-26: Gate 激活时通知排队 ───

  describe('P-26: Gate 优先级队列', () => {
    it('Gate 激活时 eviction 通知应排队', () => {
      mockGateService.isActive.set(true);
      const staleTask = createTask({ id: 'gate-stale', parkingMeta: createParkingMeta() });
      taskMap.set(staleTask.id, staleTask);
      syncParkedSignals();

      (service as unknown as { runEvictionCheck: () => void }).runEvictionCheck();

      // Gate 激活时 eviction 通知被延迟到 _deferredEvictionNotices 中
      // 需要 flush 后才进入 pendingNotices
      (service as unknown as { flushDeferredNotices: () => void }).flushDeferredNotices();
      expect(service.pendingNotices().length).toBe(1);
    });
  });

  // ─── P-27: 软删除停泊任务 ───

  describe('P-27: handleTaskSoftDelete', () => {
    it('软删除停泊任务应立即从停泊列表移除', () => {
      const task = createTask({
        id: 'soft-delete-1',
        parkingMeta: createParkingMeta({ state: 'parked' }),
      });
      taskMap.set(task.id, task);
      syncParkedSignals();

      service.handleTaskSoftDelete('soft-delete-1');

      expect(taskMap.get('soft-delete-1')?.parkingMeta).toBeUndefined();
    });

    it('正在预览的任务被软删除时应清除预览', () => {
      const task = createTask({
        id: 'soft-delete-preview',
        parkingMeta: createParkingMeta({ state: 'parked' }),
      });
      taskMap.set(task.id, task);
      syncParkedSignals();
      service.previewTask('soft-delete-preview');

      service.handleTaskSoftDelete('soft-delete-preview');

      expect(service.previewingTaskId()).toBeNull();
    });
  });

  // ─── P-30: 任务完成/归档时从停泊列表移除 ───

  describe('P-30: handleTaskStatusChange', () => {
    it('任务标记完成时应清除 parkingMeta', () => {
      const task = createTask({
        id: 'complete-1',
        parkingMeta: createParkingMeta({ state: 'parked' }),
      });
      taskMap.set(task.id, task);
      syncParkedSignals();

      service.handleTaskStatusChange('complete-1', 'completed');

      expect(taskMap.get('complete-1')?.parkingMeta).toBeUndefined();
    });

    it('任务归档时应清除 parkingMeta', () => {
      const task = createTask({
        id: 'archive-1',
        parkingMeta: createParkingMeta({ state: 'parked' }),
      });
      taskMap.set(task.id, task);
      syncParkedSignals();

      service.handleTaskStatusChange('archive-1', 'archived');

      expect(taskMap.get('archive-1')?.parkingMeta).toBeUndefined();
    });

    it('非终态状态变更不应影响 parkingMeta', () => {
      const task = createTask({
        id: 'status-other',
        parkingMeta: createParkingMeta({ state: 'parked' }),
      });
      taskMap.set(task.id, task);
      syncParkedSignals();

      service.handleTaskStatusChange('status-other', 'active');

      expect(taskMap.get('status-other')?.parkingMeta).toBeTruthy();
    });
  });

  // ─── P-32: 固定任务豁免衰老清理 ───

  describe('P-32: pinned 豁免', () => {
    it('pinned 任务不应被衰老清理', () => {
      const pinnedTask = createTask({
        id: 'pinned-1',
        parkingMeta: createParkingMeta({ pinned: true }),
      });
      taskMap.set(pinnedTask.id, pinnedTask);
      syncParkedSignals();

      (service as unknown as { runEvictionCheck: () => void }).runEvictionCheck();

      expect(taskMap.get('pinned-1')?.parkingMeta).toBeTruthy();
      expect(service.pendingNotices().length).toBe(0);
    });

    it('togglePinned 应切换 pinned 状态', () => {
      const task = createTask({
        id: 'toggle-pin',
        parkingMeta: createParkingMeta({ pinned: false }),
      });
      taskMap.set(task.id, task);
      syncParkedSignals();

      service.togglePinned('toggle-pin');
      expect(taskMap.get('toggle-pin')?.parkingMeta?.pinned).toBe(true);

      service.togglePinned('toggle-pin');
      expect(taskMap.get('toggle-pin')?.parkingMeta?.pinned).toBe(false);
    });
  });

  // ─── P-37: 预览编辑（标题/备注） ───

  describe('P-37: addNote', () => {
    it('添加备注应追加到 content 末尾', () => {
      const task = createTask({
        id: 'note-1',
        content: '原始内容',
        parkingMeta: createParkingMeta(),
      });
      taskMap.set(task.id, task);
      syncParkedSignals();

      service.addNote('note-1', '这是备注');

      const updated = taskMap.get('note-1');
      expect(updated?.content).toContain('原始内容');
      expect(updated?.content).toContain('这是备注');
      expect(updated?.content).toContain('---');
    });
  });

  // ─── keepParked (A6.4.2) ───

  describe('keepParked', () => {
    it('keepParked 应刷新 lastVisitedAt 防止衰老', () => {
      const oldTime = new Date('2026-02-20T00:00:00.000Z').toISOString();
      const task = createTask({
        id: 'keep-1',
        parkingMeta: createParkingMeta({ lastVisitedAt: oldTime }),
      });
      taskMap.set(task.id, task);
      syncParkedSignals();

      service.keepParked('keep-1');

      const updated = taskMap.get('keep-1');
      expect(updated?.parkingMeta?.lastVisitedAt).not.toBe(oldTime);
      expect(mockToastService.info).toHaveBeenCalledWith('已保留，不会被自动清理');
    });
  });

  // ─── parkTask ───

  describe('parkTask', () => {
    it('应将 active 任务停泊', () => {
      const task = createTask({ id: 'park-1', status: 'active' });
      taskMap.set(task.id, task);

      service.parkTask('park-1');

      const updated = taskMap.get('park-1');
      expect(updated?.parkingMeta?.state).toBe('parked');
      expect(updated?.parkingMeta?.parkedAt).toBeTruthy();
    });

    it('应在停泊前保存上下文快照', () => {
      const task = createTask({ id: 'park-snap', status: 'active' });
      taskMap.set(task.id, task);

      service.parkTask('park-snap');

      expect(mockContextRestoreService.saveSnapshot).toHaveBeenCalledWith('park-snap');
    });

    it('非 active 状态停泊应静默忽略', () => {
      const task = createTask({ id: 'park-completed', status: 'completed' });
      taskMap.set(task.id, task);

      service.parkTask('park-completed');

      expect(taskMap.get('park-completed')?.parkingMeta).toBeNull();
    });
  });

  // ─── quickSwitch (A6.1.4) ───

  describe('quickSwitch', () => {
    it('应切回最近的停泊任务', () => {
      const recent = createTask({
        id: 'recent-parked',
        parkingMeta: createParkingMeta({ state: 'parked', parkedAt: new Date().toISOString() }),
      });
      taskMap.set(recent.id, recent);
      syncParkedSignals();

      service.quickSwitch();

      expect(taskMap.get('recent-parked')?.parkingMeta?.state).toBe('focused');
    });

    it('无停泊任务时 quickSwitch 不应出错', () => {
      expect(() => service.quickSwitch()).not.toThrow();
    });
  });

  // ─── 批量清理逐条撤回 ───

  describe('批量衰老清理', () => {
    it('批量清理通知包含逐条撤回 token', () => {
      const task1 = createTask({ id: 'batch-a', title: 'A', parkingMeta: createParkingMeta() });
      const task2 = createTask({ id: 'batch-b', title: 'B', parkingMeta: createParkingMeta() });
      taskMap.set(task1.id, task1);
      taskMap.set(task2.id, task2);
      syncParkedSignals();

      (service as unknown as { runEvictionCheck: () => void }).runEvictionCheck();

      const notice = service.pendingNotices()[0];
      expect(notice.type).toBe('eviction');
      expect(notice.evictionItems?.length).toBe(2);

      const tokenId = notice.evictionItems?.[0]?.evictionTokenId;
      expect(tokenId).toBeTruthy();
      service.undoEviction(tokenId!);
      expect(taskMap.get('batch-a')?.parkingMeta).toBeTruthy();
    });

    it('过期 token 不允许撤回', () => {
      const staleTask = createTask({ id: 'expired-token', parkingMeta: createParkingMeta() });
      taskMap.set(staleTask.id, staleTask);
      syncParkedSignals();

      (service as unknown as { runEvictionCheck: () => void }).runEvictionCheck();
      const notice = service.pendingNotices()[0];
      const tokenId = notice.evictionTokenId!;

      vi.advanceTimersByTime(PARKING_CONFIG.EVICTION_UNDO_TIMEOUT_MS + 1);
      service.undoEviction(tokenId);

      expect(taskMap.get('expired-token')?.parkingMeta).toBeUndefined();
    });
  });

  // ─── 提醒红点 (A5.3.5) ───

  describe('提醒红点', () => {
    it('连续淡出达到阈值应添加红点', () => {
      for (let i = 0; i < PARKING_CONFIG.REMINDER_BADGE_THRESHOLD; i++) {
        service.recordReminderFadeout('badge-task');
      }

      expect(service.badgedTaskIds().has('badge-task')).toBe(true);
    });

    it('clearBadge 应清除红点', () => {
      for (let i = 0; i < PARKING_CONFIG.REMINDER_BADGE_THRESHOLD; i++) {
        service.recordReminderFadeout('clear-badge-task');
      }
      expect(service.badgedTaskIds().has('clear-badge-task')).toBe(true);

      service.clearBadge('clear-badge-task');
      expect(service.badgedTaskIds().has('clear-badge-task')).toBe(false);
    });
  });

  // ─── consumeNotice ───

  describe('consumeNotice', () => {
    it('应移除指定通知', () => {
      const staleTask = createTask({ id: 'consume-1', parkingMeta: createParkingMeta() });
      taskMap.set(staleTask.id, staleTask);
      syncParkedSignals();

      (service as unknown as { runEvictionCheck: () => void }).runEvictionCheck();
      const noticeId = service.pendingNotices()[0].id;

      service.consumeNotice(noticeId);
      expect(service.pendingNotices().length).toBe(0);
    });
  });

  // ─── hasUpcomingReminder ───

  describe('hasUpcomingReminder', () => {
    it('有 <1h 提醒时返回 true', () => {
      const task = createTask({
        id: 'reminder-upcoming',
        parkingMeta: createParkingMeta({
          state: 'parked',
          reminder: {
            reminderAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
            snoozeCount: 0,
            maxSnoozeCount: 5,
          },
        }),
      });
      taskMap.set(task.id, task);
      syncParkedSignals();

      expect(service.hasUpcomingReminder()).toBe(true);
    });

    it('无提醒时返回 false', () => {
      const task = createTask({
        id: 'no-reminder',
        parkingMeta: createParkingMeta({ reminder: null }),
      });
      taskMap.set(task.id, task);
      syncParkedSignals();

      expect(service.hasUpcomingReminder()).toBe(false);
    });
  });
});
