import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DockEngineService } from './dock-engine.service';
import { DockDailySlotService } from './dock-daily-slot.service';
import { DockFragmentRestService } from './dock-fragment-rest.service';
import { TaskStore, SimpleSyncService } from '../core-bridge';
import { ActionQueueService } from './action-queue.service';
import { AuthService } from './auth.service';
import { FocusPreferenceService } from './focus-preference.service';
import { PreferenceService } from './preference.service';
import { ProjectStateService } from './project-state.service';
import { TaskOperationAdapterService } from './task-operation-adapter.service';
import { BlackBoxService } from './black-box.service';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { FocusAttentionService } from './focus-attention.service';
import { FocusHudWindowService } from './focus-hud-window.service';
import { Task } from '../models';
import { DockSnapshot, FocusTaskSlot } from '../models/parking-dock';
import { PARKING_CONFIG } from '../config/parking.config';
import { DEFAULT_FOCUS_PREFERENCES } from '../models/focus';

describe('DockEngineService', () => {
  let service: DockEngineService;
  let currentUserId: ReturnType<typeof signal<string | null>>;
  let activeProjectId: ReturnType<typeof signal<string | null>>;
  let focusPreferences: ReturnType<typeof signal<typeof DEFAULT_FOCUS_PREFERENCES>>;

  type MockAddTaskResult =
    | { ok: true; value: string }
    | { ok: false; error: { message: string } };

  type MockBlackBoxCreateResult =
    | { ok: true; value: { id: string; content: string } }
    | { ok: false; error: { message: string } };

  const taskMap = new Map<string, Task>();
  const taskProjectMap = new Map<string, string>();
  const projectConnections = new Map<string, Array<{ id: string; source: string; target: string; deletedAt?: string | null }>>();

  const mockPreferenceService = {
    saveUserPreferences: vi.fn().mockResolvedValue(true),
  };

  const mockSyncService = {
    loadFocusSession: vi.fn().mockResolvedValue(null),
    listRoutineTasks: vi.fn().mockResolvedValue([]),
    importLegacyDockSnapshot: vi.fn().mockResolvedValue(null),
  };

  const mockActionQueue = {
    enqueue: vi.fn(() => crypto.randomUUID()),
    enqueueForOwner: vi.fn().mockResolvedValue('queued-owner-action'),
  };

  const mockTaskOps = {
    updateTaskContent: vi.fn(),
    updateTaskExpectedMinutes: vi.fn(),
    updateTaskCognitiveLoad: vi.fn(),
    updateTaskWaitMinutes: vi.fn(),
    updateTaskStatus: vi.fn(),
    addTask: vi.fn((title: string): MockAddTaskResult => ({ ok: true, value: `created-${title}-${crypto.randomUUID()}` })),
  };

  const mockBlackBoxService = {
    create: vi.fn((payload?: { content?: string; focusMeta?: { title?: string } }): MockBlackBoxCreateResult => ({
      ok: true,
      value: {
        id: `bb-${crypto.randomUUID()}`,
        content: payload?.content ?? payload?.focusMeta?.title ?? '',
      },
    })),
    getEntry: vi.fn(() => undefined),
    archive: vi.fn(() => ({ ok: true as const, value: undefined })),
    markAsCompleted: vi.fn(() => ({ ok: true as const, value: undefined })),
  };

  const mockProjectState = {
    activeProjectId: () => activeProjectId(),
    projects: () =>
      Array.from(new Set(taskProjectMap.values())).map(projectId => ({
        id: projectId,
        name: projectId,
        description: '',
        createdDate: new Date().toISOString(),
        tasks: Array.from(taskMap.values()).filter(task => taskProjectMap.get(task.id) === projectId),
        connections: projectConnections.get(projectId) ?? [],
      })),
    updateProjects: vi.fn(),
    getProject: vi.fn((id: string) => ({
      id,
      name: id,
      description: '',
      createdDate: new Date().toISOString(),
      tasks: [],
      connections: projectConnections.get(id) ?? [],
    })),
  };

  // LoggerService：测试不关注日志输出，提供最小无操作实现
  const mockLogger = {
    category: () => ({ warn: () => {}, error: () => {}, info: () => {}, debug: () => {} }),
  };

  const mockToast = {
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  };

  const mockFocusAttention = {
    updateBadge: vi.fn(),
    notify: vi.fn().mockResolvedValue(undefined),
  };

  const mockFocusHudWindow = {
    isActive: signal(false),
    isSupported: signal(true),
  };

  const mockTaskStore = {
    tasksMap: signal<Map<string, Task>>(new Map(), { equal: () => false }),
    getTask: vi.fn((id: string) => taskMap.get(id)),
    getTaskProjectId: vi.fn((id: string) => taskProjectMap.get(id) ?? null),
    getTasksByProject: vi.fn((projectId: string) =>
      Array.from(taskMap.values()).filter(task => taskProjectMap.get(task.id) === projectId),
    ),
    setTask: vi.fn((task: Task, projectId: string) => {
      taskMap.set(task.id, task);
      taskProjectMap.set(task.id, projectId);
      mockTaskStore.tasksMap.update(map => {
        map.set(task.id, task);
        return map;
      });
    }),
  };

  const mockFocusPreferenceService = {
    preferences: () => focusPreferences(),
    update: vi.fn((updates: Partial<typeof DEFAULT_FOCUS_PREFERENCES>) => {
      focusPreferences.update(current => ({ ...current, ...updates }));
    }),
  };

  const seedTask = (id: string, options?: Partial<Task> & { projectId?: string }): void => {
    const projectId = options?.projectId ?? 'project-1';
    const task: Task = {
      id,
      title: options?.title ?? id,
      content: options?.content ?? '',
      stage: options?.stage ?? null,
      parentId: options?.parentId ?? null,
      order: options?.order ?? 0,
      rank: options?.rank ?? 1,
      status: options?.status ?? 'active',
      x: options?.x ?? 0,
      y: options?.y ?? 0,
      createdDate: options?.createdDate ?? new Date().toISOString(),
      updatedAt: options?.updatedAt,
      displayId: options?.displayId ?? id,
      shortId: options?.shortId,
      hasIncompleteTask: options?.hasIncompleteTask,
      deletedAt: options?.deletedAt ?? null,
      attachments: options?.attachments,
      tags: options?.tags,
      priority: options?.priority,
      dueDate: options?.dueDate,
      expected_minutes: options?.expected_minutes ?? null,
      cognitive_load: options?.cognitive_load ?? null,
      wait_minutes: options?.wait_minutes ?? null,
      parkingMeta: options?.parkingMeta,
    };
    taskMap.set(id, task);
    taskProjectMap.set(id, projectId);
    mockTaskStore.tasksMap.update(map => {
      map.set(id, task);
      return map;
    });
  };

  const seedConnection = (projectId: string, source: string, target: string): void => {
    const list = projectConnections.get(projectId) ?? [];
    list.push({
      id: `${source}->${target}`,
      source,
      target,
      deletedAt: null,
    });
    projectConnections.set(projectId, list);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    taskMap.clear();
    taskProjectMap.clear();
    projectConnections.clear();
    currentUserId = signal('user-1');
    activeProjectId = signal('project-1');
    focusPreferences = signal({ ...DEFAULT_FOCUS_PREFERENCES });
    mockTaskStore.tasksMap.set(new Map());
    mockPreferenceService.saveUserPreferences.mockClear();
    mockSyncService.loadFocusSession.mockClear();
    mockSyncService.listRoutineTasks.mockClear();
    mockSyncService.importLegacyDockSnapshot.mockClear();
    mockActionQueue.enqueue.mockClear();
    mockActionQueue.enqueueForOwner.mockClear();
    mockTaskStore.getTasksByProject.mockClear();
    mockTaskOps.updateTaskContent.mockClear();
    mockTaskOps.updateTaskExpectedMinutes.mockClear();
    mockTaskOps.updateTaskCognitiveLoad.mockClear();
    mockTaskOps.updateTaskWaitMinutes.mockClear();
    mockTaskOps.updateTaskStatus.mockClear();
    mockTaskOps.addTask.mockClear();
    mockBlackBoxService.create.mockClear();
    mockBlackBoxService.getEntry.mockClear();
    mockBlackBoxService.getEntry.mockReturnValue(undefined);
    mockBlackBoxService.archive.mockClear();
    mockBlackBoxService.markAsCompleted.mockClear();
    mockProjectState.updateProjects.mockClear();
    mockProjectState.getProject.mockClear();
    mockToast.info.mockClear();
    mockToast.warning.mockClear();
    mockToast.error.mockClear();
    mockFocusAttention.updateBadge.mockClear();
    mockFocusAttention.notify.mockClear();
    mockFocusHudWindow.isActive.set(false);
    mockFocusPreferenceService.update.mockClear();

    TestBed.configureTestingModule({
      providers: [
        DockEngineService,
        { provide: TaskStore, useValue: mockTaskStore },
        { provide: PreferenceService, useValue: mockPreferenceService },
        { provide: SimpleSyncService, useValue: mockSyncService },
        { provide: ActionQueueService, useValue: mockActionQueue },
        { provide: ProjectStateService, useValue: mockProjectState },
        { provide: TaskOperationAdapterService, useValue: mockTaskOps },
        { provide: BlackBoxService, useValue: mockBlackBoxService },
        { provide: AuthService, useValue: { currentUserId } },
        { provide: FocusPreferenceService, useValue: mockFocusPreferenceService },
        { provide: LoggerService, useValue: mockLogger },
        { provide: ToastService, useValue: mockToast },
        { provide: FocusAttentionService, useValue: mockFocusAttention },
        { provide: FocusHudWindowService, useValue: mockFocusHudWindow },
      ],
    });

    service = TestBed.inject(DockEngineService);
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('only first drag auto-sets main task in a focus session', () => {
    seedTask('A');
    seedTask('B');

    service.dockTask('A');
    service.dockTask('B');

    const a = service.entries().find(entry => entry.taskId === 'A');
    const b = service.entries().find(entry => entry.taskId === 'B');
    expect(a?.isMain).toBe(true);
    expect(b?.isMain).toBe(false);
  });

  it('dockTask should reject non-active tasks', () => {
    seedTask('archived-task', { status: 'completed' });
    service.dockTask('archived-task');
    expect(service.entries().length).toBe(0);
  });

  it('dockTaskFromExternalDrag should always dock into backup lane with manual zone source', () => {
    seedTask('drag-task', { projectId: 'project-1' });

    service.dockTaskFromExternalDrag('drag-task', 'flow');

    const entry = service.entries().find(item => item.taskId === 'drag-task');
    expect(entry?.lane).toBe('backup');
    expect(entry?.zoneSource).toBe('manual');
    expect(entry?.sourceSection).toBe('flow');
    expect(entry?.relationScore).toBe(20);
    expect(entry?.relationReason).toBe('manual:backup');
  });

  it('auto lane inference should mark parent-child tasks as combo-select relation', () => {
    seedTask('A', { projectId: 'project-1', stage: 1, order: 1 });
    seedTask('B', { projectId: 'project-1', stage: 2, order: 1, parentId: 'A' });

    service.dockTask('A');
    service.dockTask('B');

    const b = service.entries().find(entry => entry.taskId === 'B');
    expect(b?.lane).toBe('combo-select');
    expect((b?.relationReason ?? '')).toContain('parent-child');
    expect((b?.relationScore ?? 0) > 0).toBe(true);
  });

  it('auto lane inference should treat cross-project tasks as backup by default', () => {
    seedTask('A', { projectId: 'project-1' });
    seedTask('B', { projectId: 'project-2' });

    service.dockTask('A');
    service.dockTask('B');

    const b = service.entries().find(entry => entry.taskId === 'B');
    expect(b?.lane).toBe('backup');
    expect(b?.relationReason).toBe('auto:cross-project-default-backup');
  });

  it('auto lane inference should treat direct connection tasks as combo-select relation', () => {
    seedTask('A', { projectId: 'project-1' });
    seedTask('B', { projectId: 'project-1' });
    seedConnection('project-1', 'A', 'B');

    service.dockTask('A');
    service.dockTask('B');

    const b = service.entries().find(entry => entry.taskId === 'B');
    expect(b?.lane).toBe('combo-select');
    expect((b?.relationReason ?? '')).toContain('direct-connection');
  });

  it('auto lane inference should keep tree distance scoring beyond depth 10', () => {
    let parentId: string | null = null;
    for (let index = 0; index <= 11; index += 1) {
      const id = `tree-${index}`;
      seedTask(id, {
        projectId: 'project-1',
        parentId,
      });
      parentId = id;
    }

    service.dockTask('tree-0');
    service.dockTask('tree-11');

    const deepEntry = service.entries().find(entry => entry.taskId === 'tree-11');
    expect((deepEntry?.relationReason ?? '')).toContain('tree-distance:11');
    expect((deepEntry?.relationScore ?? 0) > 0).toBe(true);
  });

  it('dockTask should inherit expected/load/wait attributes from task entity', () => {
    seedTask('inherit-task', {
      expected_minutes: 35,
      cognitive_load: 'high',
      wait_minutes: 8,
    });

    service.dockTask('inherit-task');

    const entry = service.entries().find(item => item.taskId === 'inherit-task');
    expect(entry?.expectedMinutes).toBe(35);
    expect(entry?.load).toBe('high');
    expect(entry?.waitMinutes).toBe(8);
  });

  it('dockTask should auto-raise expected minutes when inherited wait exceeds expected', () => {
    seedTask('inherit-invalid-task', {
      expected_minutes: 10,
      cognitive_load: 'low',
      wait_minutes: 25,
    });

    service.dockTask('inherit-invalid-task');

    const entry = service.entries().find(item => item.taskId === 'inherit-invalid-task');
    expect(entry?.expectedMinutes).toBe(25);
    expect(entry?.waitMinutes).toBe(25);
    expect(mockTaskOps.updateTaskExpectedMinutes).toHaveBeenCalledWith('inherit-invalid-task', 25);
    expect(mockTaskOps.updateTaskWaitMinutes).toHaveBeenCalledWith('inherit-invalid-task', 25);
  });

  it('dock edits should write planner attributes back to active task', () => {
    seedTask('sync-task');
    service.dockTask('sync-task');

    service.toggleLoad('sync-task', 'up');
    service.setExpectedTime('sync-task', 42);
    service.setWaitTime('sync-task', 15);

    expect(mockTaskOps.updateTaskCognitiveLoad).toHaveBeenCalledWith('sync-task', 'high');
    expect(mockTaskOps.updateTaskExpectedMinutes).toHaveBeenCalledWith('sync-task', 42);
    expect(mockTaskOps.updateTaskWaitMinutes).toHaveBeenCalledWith('sync-task', 15);
  });

  it('createInDock should create shared black-box entry and record sourceBlackBoxEntryId', () => {
    mockBlackBoxService.create.mockReturnValueOnce({
      ok: true,
      value: { id: 'bb-inline-1', content: 'Inline Task' },
    });

    const dockEntryId = service.createInDock('Inline Task', 'backup', 'low', {
      expectedMinutes: 25,
      waitMinutes: 5,
      detail: 'inline detail',
    });

    const entry = service.entries().find(item => item.taskId === dockEntryId);
    expect(entry).toBeDefined();
    expect(entry?.sourceKind).toBe('dock-created');
    expect(entry?.sourceBlackBoxEntryId).toBe('bb-inline-1');
    expect(entry?.inlineArchiveStatus).toBe('pending');
    expect(mockBlackBoxService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: null,
        focusMeta: expect.objectContaining({
          source: 'focus-console-inline',
          dockEntryId,
          lane: 'backup',
          title: 'Inline Task',
        }),
      }),
    );
  });

  it('createInDock should keep UI creation when black-box create fails and mark failed status', () => {
    mockBlackBoxService.create.mockReturnValueOnce({
      ok: false,
      error: { message: 'network failed' },
    });

    const dockEntryId = service.createInDock('Inline Fallback', 'combo-select', 'high');
    const entry = service.entries().find(item => item.taskId === dockEntryId);

    expect(entry).toBeDefined();
    expect(entry?.sourceKind).toBe('dock-created');
    expect(entry?.sourceBlackBoxEntryId ?? null).toBeNull();
    expect(entry?.inlineArchiveStatus).toBe('failed');
  });

  it('archiveInlineEntriesToActiveProject should convert inline entries and replace with project-task', () => {
    mockBlackBoxService.create.mockReturnValueOnce({
      ok: true,
      value: { id: 'bb-inline-archive-1', content: 'Archive Me' },
    });
    mockTaskOps.addTask.mockReturnValueOnce({
      ok: true as const,
      value: 'archived-task-1',
    });

    const inlineId = service.createInDock('Archive Me', 'combo-select', 'high', {
      expectedMinutes: 40,
      waitMinutes: 10,
      detail: 'archive detail',
    });

    const result = service.archiveInlineEntriesToActiveProject();
    const archivedEntry = service.entries().find(item => item.taskId === 'archived-task-1');

    expect(result).toEqual({ converted: 1, failed: 0 });
    expect(archivedEntry).toBeDefined();
    expect(archivedEntry?.sourceKind).toBe('project-task');
    expect(archivedEntry?.sourceProjectId).toBe('project-1');
    expect(archivedEntry?.inlineArchiveStatus).toBe('archived');
    expect(archivedEntry?.inlineArchivedTaskId).toBe('archived-task-1');
    expect(mockTaskOps.addTask).toHaveBeenCalledWith('Archive Me', 'archive detail', null, null, false);
    expect(mockTaskOps.updateTaskExpectedMinutes).toHaveBeenCalledWith('archived-task-1', 40);
    expect(mockTaskOps.updateTaskCognitiveLoad).toHaveBeenCalledWith('archived-task-1', 'high');
    expect(mockTaskOps.updateTaskWaitMinutes).toHaveBeenCalledWith('archived-task-1', 10);
    expect(mockBlackBoxService.archive).toHaveBeenCalledWith('bb-inline-archive-1');
    expect(service.entries().some(item => item.taskId === inlineId)).toBe(false);
  });

  it('archiveInlineEntriesToActiveProject should mark failed when no active project', () => {
    activeProjectId.set(null);
    mockBlackBoxService.create.mockReturnValueOnce({
      ok: true,
      value: { id: 'bb-no-project', content: 'No Project' },
    });

    const inlineId = service.createInDock('No Project', 'backup', 'low');
    const result = service.archiveInlineEntriesToActiveProject();
    const entry = service.entries().find(item => item.taskId === inlineId);

    expect(result).toEqual({ converted: 0, failed: 1 });
    expect(entry?.sourceKind).toBe('dock-created');
    expect(entry?.inlineArchiveStatus).toBe('failed');
    expect(mockTaskOps.addTask).not.toHaveBeenCalled();
  });

  it('archiveInlineEntriesToActiveProject should support partial failures', () => {
    mockBlackBoxService.create
      .mockReturnValueOnce({ ok: true, value: { id: 'bb-partial-1', content: 'Partial A' } })
      .mockReturnValueOnce({ ok: true, value: { id: 'bb-partial-2', content: 'Partial B' } });
    mockTaskOps.addTask
      .mockReturnValueOnce({ ok: true, value: 'partial-ok-task' })
      .mockReturnValueOnce({ ok: false, error: { message: 'addTask failed' } });

    const inlineA = service.createInDock('Partial A', 'combo-select', 'low');
    const inlineB = service.createInDock('Partial B', 'backup', 'high');

    const result = service.archiveInlineEntriesToActiveProject();
    const entryA = service.entries().find(item => item.taskId === 'partial-ok-task');
    const entryB = service.entries().find(item => item.taskId === inlineB);

    expect(result).toEqual({ converted: 1, failed: 1 });
    expect(entryA?.sourceKind).toBe('project-task');
    expect(entryA?.inlineArchiveStatus).toBe('archived');
    expect(entryB?.sourceKind).toBe('dock-created');
    expect(entryB?.inlineArchiveStatus).toBe('failed');
    expect(service.entries().some(item => item.taskId === inlineA)).toBe(false);
  });

  it('cross-project planner sync should use TaskStore + ProjectState update path', () => {
    seedTask('cross-task', {
      projectId: 'project-2',
      expected_minutes: 20,
      cognitive_load: 'low',
      wait_minutes: 5,
    });
    mockTaskStore.setTask.mockClear();
    mockProjectState.updateProjects.mockClear();

    service.dockTask('cross-task');
    service.setExpectedTime('cross-task', 55);

    expect(mockTaskStore.setTask).toHaveBeenCalled();
    expect(mockProjectState.updateProjects).toHaveBeenCalled();
    expect(mockTaskOps.updateTaskExpectedMinutes).not.toHaveBeenCalledWith('cross-task', 55);
  });

  it('first suspend should keep recommendations highlighted without auto-promoting B', () => {
    seedTask('A');
    seedTask('B');
    seedTask('C');

    service.dockTask('A', 'combo-select', { expectedMinutes: 60, load: 'high', zoneSource: 'manual' });
    service.dockTask('B', 'combo-select', { expectedMinutes: 20, waitMinutes: 5, load: 'low', zoneSource: 'manual' });
    service.dockTask('C', 'backup', { expectedMinutes: 40, load: 'high', zoneSource: 'manual' });
    service.toggleFocusMode();
    service.switchToTask('A');
    service.suspendTask('A', 20);

    expect(service.focusingEntry()).toBeNull();
    expect(service.pendingDecision()).not.toBeNull();
    const b = service.entries().find(entry => entry.taskId === 'B');
    const c = service.entries().find(entry => entry.taskId === 'C');
    expect(b?.systemSelected).toBe(true);
    expect((b?.recommendedScore ?? 0) > (c?.recommendedScore ?? 0)).toBe(true);
  });

  it('first suspend should fall back to relaxed wait-fit recommendations when strict groups are empty', () => {
    seedTask('A');
    seedTask('B');

    service.dockTask('A', 'combo-select', { expectedMinutes: 60, load: 'high', zoneSource: 'manual' });
    service.dockTask('B', 'backup', { expectedMinutes: 120, load: 'high', zoneSource: 'manual' });
    service.toggleFocusMode();
    service.switchToTask('A');

    service.suspendTask('A', 30);

    const pending = service.pendingDecision();
    const candidateIds = pending?.candidateGroups.flatMap(group => group.taskIds) ?? [];
    expect(candidateIds).toContain('B');
    expect(pending).not.toBeNull();
  });

  it('first suspend should escalate to ignore-wait recommendations when relaxed groups are still empty', () => {
    seedTask('A');
    seedTask('B');

    service.dockTask('A', 'combo-select', { expectedMinutes: 60, load: 'high', zoneSource: 'manual' });
    service.dockTask('B', 'backup', { expectedMinutes: 200, load: 'high', zoneSource: 'manual' });
    service.toggleFocusMode();
    service.switchToTask('A');

    service.suspendTask('A', 30);

    const pending = service.pendingDecision();
    const candidateIds = pending?.candidateGroups.flatMap(group => group.taskIds) ?? [];
    expect(candidateIds).toContain('B');
    expect(pending).not.toBeNull();
  });

  it('after B completes in mismatch scenario, enters C/D pending decision', () => {
    seedTask('A');
    seedTask('B');
    seedTask('C');
    seedTask('D');

    const waitStartedAt = new Date(Date.now() - 60 * 1000).toISOString();
    service.restoreSnapshot({
      version: 4,
      entries: [
        {
          taskId: 'A',
          title: 'A',
          sourceProjectId: 'project-1',
          status: 'suspended_waiting',
          load: 'high',
          expectedMinutes: 120,
          waitMinutes: 30,
          waitStartedAt,
          lane: 'combo-select',
          zoneSource: 'manual',
          isMain: true,
          dockedOrder: 0,
          detail: '',
          sourceKind: 'project-task',
          systemSelected: false,
          recommendedScore: null,
        },
        {
          taskId: 'B',
          title: 'B',
          sourceProjectId: 'project-1',
          status: 'focusing',
          load: 'low',
          expectedMinutes: 10,
          waitMinutes: null,
          waitStartedAt: null,
          lane: 'combo-select',
          zoneSource: 'manual',
          isMain: false,
          dockedOrder: 1,
          detail: '',
          sourceKind: 'project-task',
          systemSelected: false,
          recommendedScore: null,
        },
        {
          taskId: 'C',
          title: 'C',
          sourceProjectId: 'project-1',
          status: 'pending_start',
          load: 'low',
          expectedMinutes: 5,
          waitMinutes: null,
          waitStartedAt: null,
          lane: 'combo-select',
          zoneSource: 'manual',
          isMain: false,
          dockedOrder: 2,
          detail: '',
          sourceKind: 'project-task',
          systemSelected: false,
          recommendedScore: null,
        },
        {
          taskId: 'D',
          title: 'D',
          sourceProjectId: 'project-1',
          status: 'pending_start',
          load: 'high',
          expectedMinutes: 6,
          waitMinutes: null,
          waitStartedAt: null,
          lane: 'backup',
          zoneSource: 'manual',
          isMain: false,
          dockedOrder: 3,
          detail: '',
          sourceKind: 'project-task',
          systemSelected: false,
          recommendedScore: null,
        },
      ],
      focusMode: true,
      isDockExpanded: true,
      muteWaitTone: false,
      session: {
        firstDragIntervened: true,
        focusBlurOn: true,
        focusScrimOn: true,
        mainTaskId: 'B',
        comboSelectIds: ['D'],
        backupIds: [],
      },
      firstDragDone: true,
      dailySlots: [],
      suspendChainRootTaskId: 'A',
      suspendRecommendationLocked: true,
      pendingDecision: null,
      dailyResetDate: '2026-02-25',
      savedAt: new Date().toISOString(),
    });

    service.completeTask('B');

    const pending = service.pendingDecision();
    expect(pending).not.toBeNull();
    const candidateIds = pending?.candidateGroups.flatMap(group => group.taskIds) ?? [];
    expect(candidateIds).toContain('C');
    expect(candidateIds).toContain('D');
    expect(service.highlightedIds().has('C')).toBe(true);
    expect(service.highlightedIds().has('D')).toBe(true);
  });

  it('should start fragment countdown when subtask completes and root wait remains without suitable next candidate', () => {
    seedTask('A');
    seedTask('B');

    const waitStartedAt = new Date(Date.now() - 30 * 1000).toISOString();
    service.restoreSnapshot({
      version: 7,
      entries: [
        {
          taskId: 'A',
          title: 'A',
          sourceProjectId: 'project-1',
          status: 'suspended_waiting',
          load: 'high',
          expectedMinutes: 30,
          waitMinutes: 4,
          waitStartedAt,
          lane: 'combo-select',
          zoneSource: 'manual',
          isMain: true,
          dockedOrder: 0,
          detail: '',
          sourceKind: 'project-task',
          systemSelected: false,
          recommendedScore: null,
        },
        {
          taskId: 'B',
          title: 'B',
          sourceProjectId: 'project-1',
          status: 'focusing',
          load: 'low',
          expectedMinutes: 2,
          waitMinutes: null,
          waitStartedAt: null,
          lane: 'backup',
          zoneSource: 'manual',
          isMain: false,
          dockedOrder: 1,
          detail: '',
          sourceKind: 'project-task',
          systemSelected: false,
          recommendedScore: null,
        },
      ],
      focusMode: true,
      isDockExpanded: true,
      muteWaitTone: false,
      session: {
        firstDragIntervened: true,
        focusBlurOn: true,
        focusScrimOn: true,
        mainTaskId: 'B',
        comboSelectIds: [],
        backupIds: [],
      },
      firstDragDone: true,
      dailySlots: [],
      suspendChainRootTaskId: 'A',
      suspendRecommendationLocked: true,
      pendingDecision: null,
      dailyResetDate: '2026-02-25',
      savedAt: new Date().toISOString(),
    });

    service.completeTask('B');

    expect(service.fragmentEntryCountdown()).toBe(PARKING_CONFIG.FRAGMENT_ENTRY_COUNTDOWN_S);
    expect(service.pendingDecision()).toBeNull();
    service.fragmentRest.skipFragmentEntry();
    expect(service.fragmentEntryCountdown()).toBeNull();
    expect(service.activeFragmentEvent()).toBeNull();
  });

  it('accepting fragment countdown should enter fragment phase without mutating the waiting root task', () => {
    seedTask('A');
    seedTask('B');

    const waitStartedAt = new Date(Date.now() - 30 * 1000).toISOString();
    service.restoreSnapshot({
      version: 7,
      entries: [
        {
          taskId: 'A',
          title: 'A',
          sourceProjectId: 'project-1',
          status: 'suspended_waiting',
          load: 'high',
          expectedMinutes: 30,
          waitMinutes: 4,
          waitStartedAt,
          lane: 'combo-select',
          zoneSource: 'manual',
          isMain: true,
          dockedOrder: 0,
          detail: '',
          sourceKind: 'project-task',
          systemSelected: false,
          recommendedScore: null,
        },
        {
          taskId: 'B',
          title: 'B',
          sourceProjectId: 'project-1',
          status: 'focusing',
          load: 'low',
          expectedMinutes: 2,
          waitMinutes: null,
          waitStartedAt: null,
          lane: 'backup',
          zoneSource: 'manual',
          isMain: false,
          dockedOrder: 1,
          detail: '',
          sourceKind: 'project-task',
          systemSelected: false,
          recommendedScore: null,
        },
      ],
      focusMode: true,
      isDockExpanded: true,
      muteWaitTone: false,
      session: {
        firstDragIntervened: true,
        focusBlurOn: true,
        focusScrimOn: true,
        mainTaskId: 'B',
        comboSelectIds: [],
        backupIds: [],
      },
      firstDragDone: true,
      dailySlots: [],
      suspendChainRootTaskId: 'A',
      suspendRecommendationLocked: true,
      pendingDecision: null,
      dailyResetDate: '2026-02-25',
      savedAt: new Date().toISOString(),
    });

    service.completeTask('B');
    service.fragmentRest.acceptFragmentEntry();

    expect(service.fragmentEntryCountdown()).toBeNull();
    expect(service.fragmentDefenseLevel()).toBe(2);
    expect(service.activeFragmentEvent()).not.toBeNull();
    expect(service.entries().find(entry => entry.taskId === 'A')?.status).toBe('suspended_waiting');
  });

  it('should trigger and reset the high-load rest reminder after sustained focus time', () => {
    seedTask('A');

    service.dockTask('A', 'combo-select', { expectedMinutes: 45, load: 'high', zoneSource: 'manual' });
    service.toggleFocusMode();
    service.switchToTask('A');

    expect(service.focusingEntry()?.taskId).toBe('A');

    const fragmentRest = TestBed.inject(DockFragmentRestService);
    for (let elapsed = 0; elapsed < PARKING_CONFIG.REST_REMINDER_HIGH_LOAD_THRESHOLD_MS; elapsed += 10_000) {
      fragmentRest.tickRestReminderAccumulator(true, 'high');
    }

    expect(service.restReminderActive()).toBe(true);
    expect(service.cumulativeHighLoadMs()).toBeGreaterThanOrEqual(PARKING_CONFIG.REST_REMINDER_HIGH_LOAD_THRESHOLD_MS);

    service.fragmentRest.dismissRestReminder();

    expect(service.restReminderActive()).toBe(false);
    expect(service.cumulativeHighLoadMs()).toBe(0);
  });

  it('should honor configurable high-load rest reminder threshold', () => {
    focusPreferences.set({
      ...DEFAULT_FOCUS_PREFERENCES,
      restReminderHighLoadMinutes: 20,
    });
    seedTask('A');

    service.dockTask('A', 'combo-select', { expectedMinutes: 45, load: 'high', zoneSource: 'manual' });
    service.toggleFocusMode();
    service.switchToTask('A');

    const fragmentRest = TestBed.inject(DockFragmentRestService);
    for (let elapsed = 0; elapsed < 19 * 60 * 1000; elapsed += 10_000) {
      fragmentRest.tickRestReminderAccumulator(true, 'high');
    }
    expect(service.restReminderActive()).toBe(false);

    for (let elapsed = 19 * 60 * 1000; elapsed < 20 * 60 * 1000; elapsed += 10_000) {
      fragmentRest.tickRestReminderAccumulator(true, 'high');
    }
    expect(service.restReminderActive()).toBe(true);
  });

  it('export snapshot should include v3 fields', () => {
    seedTask('A');
    service.dockTask('A');
    service.setDockExpanded(false);
    service.toggleMuteWaitTone();
    const snapshot = service.exportSnapshot();

    expect(snapshot.version).toBe(7);
    expect(snapshot.focusMode).toBe(false);
    expect(snapshot.isDockExpanded).toBe(false);
    expect(snapshot.muteWaitTone).toBe(true);
    expect(snapshot.session.firstDragIntervened).toBe(true);
    expect(snapshot.session.focusBlurOn).toBe(false);
    expect(snapshot.session.focusScrimOn).toBe(true);
    expect(snapshot.suspendChainRootTaskId).toBeNull();
    expect(snapshot.suspendRecommendationLocked).toBe(false);
    expect(snapshot.dailyResetDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(snapshot.entries[0]?.zoneSource).toBe('auto');
  });

  it('toggleFocusScrim should flip scrim visibility without changing focus mode', () => {
    expect(service.focusMode()).toBe(false);
    expect(service.focusScrimOn()).toBe(true);

    service.toggleFocusScrim();
    expect(service.focusScrimOn()).toBe(false);
    expect(service.focusMode()).toBe(false);

    service.setFocusScrim(true);
    expect(service.focusScrimOn()).toBe(true);
    expect(service.focusMode()).toBe(false);
  });

  it('toggleFocusMode should reset scrim to true on enter', () => {
    service.setFocusScrim(false);
    expect(service.focusMode()).toBe(false);
    expect(service.focusScrimOn()).toBe(false);

    // 进入专注模式时遮罩自动恢复，确保完整专注 UI 可见
    service.toggleFocusMode();
    expect(service.focusMode()).toBe(true);
    expect(service.focusScrimOn()).toBe(true);

    service.toggleFocusMode();
    expect(service.focusMode()).toBe(false);
  });

  it('toggleFocusMode should preserve an exiting transition until the coordinator settles it', () => {
    service.toggleFocusMode();
    expect(service.focusMode()).toBe(true);

    service.beginFocusTransition({
      phase: 'exiting',
      direction: 'exit',
      fromRect: { left: 12, top: 24, width: 180, height: 96 },
      toRect: { left: 18, top: 640, width: 220, height: 108 },
      durationMs: 280,
      startedAt: new Date().toISOString(),
    });

    service.toggleFocusMode();

    expect(service.focusMode()).toBe(false);
    expect(service.focusTransition()?.phase).toBe('exiting');
  });

  it('toggleFocusMode should clear a settled focused transition on direct exit', () => {
    service.toggleFocusMode();
    expect(service.focusMode()).toBe(true);

    service.beginFocusTransition({
      phase: 'focused',
      direction: 'enter',
      fromRect: { left: 12, top: 640, width: 180, height: 96 },
      toRect: { left: 18, top: 24, width: 220, height: 108 },
      durationMs: 340,
      startedAt: new Date().toISOString(),
    });

    service.toggleFocusMode();

    expect(service.focusMode()).toBe(false);
    expect(service.focusTransition()).toBeNull();
  });

  it('restoreSnapshot should restore dock expanded and mute preference', () => {
    service.restoreSnapshot({
      version: 4,
      entries: [],
      focusMode: true,
      isDockExpanded: false,
      muteWaitTone: true,
      session: {
        firstDragIntervened: true,
        focusBlurOn: true,
        focusScrimOn: false,
        mainTaskId: null,
        comboSelectIds: [],
        backupIds: [],
      },
      firstDragDone: true,
      dailySlots: [],
      suspendChainRootTaskId: null,
      suspendRecommendationLocked: false,
      pendingDecision: null,
      dailyResetDate: '2026-02-25',
      savedAt: new Date().toISOString(),
    });

    expect(service.focusMode()).toBe(true);
    expect(service.dockExpanded()).toBe(false);
    expect(service.muteWaitTone()).toBe(true);
    expect(service.focusScrimOn()).toBe(false);
  });

  it('restoreSnapshot should default focusScrimOn=true for legacy snapshots', () => {
    const legacySnapshot = {
      version: 4,
      entries: [],
      focusMode: true,
      isDockExpanded: true,
      muteWaitTone: false,
      session: {
        firstDragIntervened: true,
        focusBlurOn: true,
        mainTaskId: null,
        comboSelectIds: [],
        backupIds: [],
      },
      firstDragDone: true,
      dailySlots: [],
      suspendChainRootTaskId: null,
      suspendRecommendationLocked: false,
      pendingDecision: null,
      dailyResetDate: '2026-02-25',
      savedAt: new Date().toISOString(),
    } as unknown as Parameters<DockEngineService['restoreSnapshot']>[0];
    service.restoreSnapshot(legacySnapshot);

    expect(service.focusScrimOn()).toBe(true);
  });

  it('restoreSnapshot should migrate legacy v3 zone fields into v4 lane fields', () => {
    service.restoreSnapshot({
      version: 3 as unknown as 4,
      entries: [
        {
          taskId: 'legacy-1',
          title: 'Legacy 1',
          sourceProjectId: 'project-1',
          status: 'pending_start',
          load: 'low',
          expectedMinutes: 20,
          waitMinutes: null,
          waitStartedAt: null,
          zone: 'strong',
          zoneSource: 'manual',
          isMain: true,
          dockedOrder: 0,
          detail: '',
          sourceKind: 'project-task',
          systemSelected: false,
          recommendedScore: null,
        },
      ],
      focusMode: false,
      isDockExpanded: true,
      muteWaitTone: false,
      session: {
        firstDragIntervened: true,
        focusBlurOn: false,
        focusScrimOn: true,
        mainTaskId: 'legacy-1',
        strongZoneIds: ['legacy-1'],
        weakZoneIds: [],
      },
      firstDragDone: true,
      dailySlots: [],
      suspendChainRootTaskId: null,
      suspendRecommendationLocked: false,
      pendingDecision: null,
      dailyResetDate: '2026-02-25',
      savedAt: new Date().toISOString(),
    } as unknown as DockSnapshot);

    const entry = service.entries().find(item => item.taskId === 'legacy-1');
    expect(entry?.lane).toBe('combo-select');
    expect(service.exportSnapshot().version).toBe(7);
  });

  it('restoreSnapshot should backfill legacy external-drag manual combo entries to backup', () => {
    service.restoreSnapshot({
      version: 6,
      entries: [
        {
          taskId: 'legacy-flow',
          title: 'Legacy Flow',
          sourceProjectId: 'project-1',
          status: 'pending_start',
          load: 'low',
          expectedMinutes: 20,
          waitMinutes: null,
          waitStartedAt: null,
          lane: 'combo-select',
          zoneSource: 'manual',
          isMain: false,
          dockedOrder: 0,
          detail: '',
          sourceKind: 'project-task',
          sourceSection: 'flow',
          systemSelected: false,
          recommendedScore: null,
          relationScore: 100,
          relationReason: 'manual:combo-select',
        },
      ],
      focusMode: false,
      isDockExpanded: true,
      muteWaitTone: false,
      session: {
        firstDragIntervened: true,
        focusBlurOn: false,
        focusScrimOn: true,
        mainTaskId: null,
        comboSelectIds: ['legacy-flow'],
        backupIds: [],
      },
      firstDragDone: true,
      dailySlots: [],
      suspendChainRootTaskId: null,
      suspendRecommendationLocked: false,
      pendingDecision: null,
      dailyResetDate: '2026-02-25',
      savedAt: new Date().toISOString(),
    });

    const entry = service.entries().find(item => item.taskId === 'legacy-flow');
    expect(entry?.lane).toBe('backup');
    expect(entry?.relationScore).toBe(20);
    expect(entry?.relationReason).toBe('manual:default-backup');
  });

  it('restoreSnapshot backfill should not mutate non-target entries', () => {
    service.restoreSnapshot({
      version: 6,
      entries: [
        {
          taskId: 'dock-created',
          title: 'Inline',
          sourceProjectId: null,
          status: 'pending_start',
          load: 'low',
          expectedMinutes: 10,
          waitMinutes: null,
          waitStartedAt: null,
          lane: 'combo-select',
          zoneSource: 'manual',
          isMain: false,
          dockedOrder: 0,
          detail: '',
          sourceKind: 'dock-created',
          sourceSection: 'dock-create',
          systemSelected: false,
          recommendedScore: null,
          relationScore: 100,
          relationReason: 'manual:create-combo-select',
        },
        {
          taskId: 'manual-text-nonlegacy',
          title: 'Manual text',
          sourceProjectId: 'project-1',
          status: 'pending_start',
          load: 'low',
          expectedMinutes: 15,
          waitMinutes: null,
          waitStartedAt: null,
          lane: 'combo-select',
          zoneSource: 'manual',
          isMain: false,
          dockedOrder: 1,
          detail: '',
          sourceKind: 'project-task',
          sourceSection: 'text',
          systemSelected: false,
          recommendedScore: null,
          relationScore: 99,
          relationReason: 'manual:custom-pinned',
        },
      ],
      focusMode: false,
      isDockExpanded: true,
      muteWaitTone: false,
      session: {
        firstDragIntervened: true,
        focusBlurOn: false,
        focusScrimOn: true,
        mainTaskId: null,
        comboSelectIds: ['dock-created', 'manual-text-nonlegacy'],
        backupIds: [],
      },
      firstDragDone: true,
      dailySlots: [],
      suspendChainRootTaskId: null,
      suspendRecommendationLocked: false,
      pendingDecision: null,
      dailyResetDate: '2026-02-25',
      savedAt: new Date().toISOString(),
    });

    const inlineEntry = service.entries().find(item => item.taskId === 'dock-created');
    expect(inlineEntry?.lane).toBe('combo-select');
    expect(inlineEntry?.relationReason).toBe('manual:create-combo-select');

    const customTextEntry = service.entries().find(item => item.taskId === 'manual-text-nonlegacy');
    expect(customTextEntry?.lane).toBe('combo-select');
    expect(customTextEntry?.relationReason).toBe('manual:custom-pinned');
  });

  it('wait-finished should only notify state and must not steal current focus', () => {
    seedTask('A');
    seedTask('B');
    const waitStartedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    service.restoreSnapshot({
      version: 4,
      entries: [
        {
          taskId: 'A',
          title: 'A',
          sourceProjectId: 'project-1',
          status: 'suspended_waiting',
          load: 'low',
          expectedMinutes: 30,
          waitMinutes: 5,
          waitStartedAt,
          lane: 'combo-select',
          zoneSource: 'manual',
          isMain: true,
          dockedOrder: 0,
          detail: '',
          sourceKind: 'project-task',
          systemSelected: false,
          recommendedScore: null,
        },
        {
          taskId: 'B',
          title: 'B',
          sourceProjectId: 'project-1',
          status: 'focusing',
          load: 'high',
          expectedMinutes: 25,
          waitMinutes: null,
          waitStartedAt: null,
          lane: 'combo-select',
          zoneSource: 'manual',
          isMain: false,
          dockedOrder: 1,
          detail: '',
          sourceKind: 'project-task',
          systemSelected: false,
          recommendedScore: null,
        },
      ],
      focusMode: true,
      isDockExpanded: true,
      muteWaitTone: false,
      session: {
        firstDragIntervened: true,
        focusBlurOn: true,
        focusScrimOn: true,
        mainTaskId: 'A',
        comboSelectIds: [],
        backupIds: [],
      },
      firstDragDone: true,
      dailySlots: [],
      suspendChainRootTaskId: 'A',
      suspendRecommendationLocked: true,
      pendingDecision: null,
      dailyResetDate: '2026-02-25',
      savedAt: new Date().toISOString(),
    });

    vi.advanceTimersByTime(10_500);

    expect(service.focusingEntry()?.taskId).toBe('B');
    expect(service.entries().find(entry => entry.taskId === 'A')?.status).toBe('wait_finished');
  });

  it('expired suspended_waiting entries should count toward the attention badge immediately', () => {
    seedTask('A');
    seedTask('B');
    mockFocusAttention.updateBadge.mockClear();
    const waitStartedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();

    service.restoreSnapshot({
      version: 4,
      entries: [
        {
          taskId: 'A',
          title: 'A',
          sourceProjectId: 'project-1',
          status: 'suspended_waiting',
          load: 'low',
          expectedMinutes: 30,
          waitMinutes: 5,
          waitStartedAt,
          lane: 'combo-select',
          zoneSource: 'manual',
          isMain: true,
          dockedOrder: 0,
          detail: '',
          sourceKind: 'project-task',
          systemSelected: false,
          recommendedScore: null,
        },
        {
          taskId: 'B',
          title: 'B',
          sourceProjectId: 'project-1',
          status: 'focusing',
          load: 'high',
          expectedMinutes: 25,
          waitMinutes: null,
          waitStartedAt: null,
          lane: 'combo-select',
          zoneSource: 'manual',
          isMain: false,
          dockedOrder: 1,
          detail: '',
          sourceKind: 'project-task',
          systemSelected: false,
          recommendedScore: null,
        },
      ],
      focusMode: true,
      isDockExpanded: true,
      muteWaitTone: false,
      session: {
        firstDragIntervened: true,
        focusBlurOn: true,
        focusScrimOn: true,
        mainTaskId: 'A',
        comboSelectIds: [],
        backupIds: [],
      },
      firstDragDone: true,
      dailySlots: [],
      suspendChainRootTaskId: 'A',
      suspendRecommendationLocked: true,
      pendingDecision: null,
      dailyResetDate: '2026-02-25',
      savedAt: new Date().toISOString(),
    });
    TestBed.flushEffects();

    expect(mockFocusAttention.updateBadge).toHaveBeenLastCalledWith(1);
  });

  it('active PiP HUD should suppress wait-finished notifications while the main document is hidden', () => {
    const originalVisibilityDescriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    mockFocusHudWindow.isActive.set(true);
    seedTask('A');
    seedTask('B');
    const waitStartedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();

    try {
      service.restoreSnapshot({
        version: 4,
        entries: [
          {
            taskId: 'A',
            title: 'A',
            sourceProjectId: 'project-1',
            status: 'suspended_waiting',
            load: 'low',
            expectedMinutes: 30,
            waitMinutes: 5,
            waitStartedAt,
            lane: 'combo-select',
            zoneSource: 'manual',
            isMain: true,
            dockedOrder: 0,
            detail: '',
            sourceKind: 'project-task',
            systemSelected: false,
            recommendedScore: null,
          },
          {
            taskId: 'B',
            title: 'B',
            sourceProjectId: 'project-1',
            status: 'focusing',
            load: 'high',
            expectedMinutes: 25,
            waitMinutes: null,
            waitStartedAt: null,
            lane: 'combo-select',
            zoneSource: 'manual',
            isMain: false,
            dockedOrder: 1,
            detail: '',
            sourceKind: 'project-task',
            systemSelected: false,
            recommendedScore: null,
          },
        ],
        focusMode: true,
        isDockExpanded: true,
        muteWaitTone: false,
        session: {
          firstDragIntervened: true,
          focusBlurOn: true,
          focusScrimOn: true,
          mainTaskId: 'A',
          comboSelectIds: [],
          backupIds: [],
        },
        firstDragDone: true,
        dailySlots: [],
        suspendChainRootTaskId: 'A',
        suspendRecommendationLocked: true,
        pendingDecision: null,
        dailyResetDate: '2026-02-25',
        savedAt: new Date().toISOString(),
      });
      mockFocusAttention.notify.mockClear();

      vi.advanceTimersByTime(10_500);

      expect(service.entries().find(entry => entry.taskId === 'A')?.status).toBe('wait_finished');
      expect(mockFocusAttention.notify).not.toHaveBeenCalled();
    } finally {
      if (originalVisibilityDescriptor) {
        Object.defineProperty(document, 'visibilityState', originalVisibilityDescriptor);
      } else {
        Reflect.deleteProperty(document as unknown as Record<string, unknown>, 'visibilityState');
      }
    }
  });

  it('pending decision with candidates should stay manual even after timeout elapses', () => {
    seedTask('A');
    seedTask('B');
    seedTask('C');
    seedTask('D');

    service.restoreSnapshot({
      version: 4,
      entries: [
        {
          taskId: 'A',
          title: 'A',
          sourceProjectId: 'project-1',
          status: 'suspended_waiting',
          load: 'high',
          expectedMinutes: 90,
          waitMinutes: 30,
          waitStartedAt: new Date().toISOString(),
          lane: 'combo-select',
          zoneSource: 'manual',
          isMain: true,
          dockedOrder: 0,
          detail: '',
          sourceKind: 'project-task',
          systemSelected: false,
          recommendedScore: null,
        },
        {
          taskId: 'B',
          title: 'B',
          sourceProjectId: 'project-1',
          status: 'focusing',
          load: 'low',
          expectedMinutes: 20,
          waitMinutes: null,
          waitStartedAt: null,
          lane: 'combo-select',
          zoneSource: 'manual',
          isMain: false,
          dockedOrder: 1,
          detail: '',
          sourceKind: 'project-task',
          systemSelected: false,
          recommendedScore: null,
        },
        {
          taskId: 'C',
          title: 'C',
          sourceProjectId: 'project-1',
          status: 'pending_start',
          load: 'low',
          expectedMinutes: 18,
          waitMinutes: null,
          waitStartedAt: null,
          lane: 'combo-select',
          zoneSource: 'manual',
          isMain: false,
          dockedOrder: 2,
          detail: '',
          sourceKind: 'project-task',
          systemSelected: true,
          recommendedScore: 100,
        },
        {
          taskId: 'D',
          title: 'D',
          sourceProjectId: 'project-1',
          status: 'pending_start',
          load: 'high',
          expectedMinutes: 8,
          waitMinutes: null,
          waitStartedAt: null,
          lane: 'backup',
          zoneSource: 'manual',
          isMain: false,
          dockedOrder: 3,
          detail: '',
          sourceKind: 'project-task',
          systemSelected: true,
          recommendedScore: 60,
        },
      ],
      focusMode: true,
      isDockExpanded: true,
      muteWaitTone: false,
      session: {
        firstDragIntervened: true,
        focusBlurOn: true,
        focusScrimOn: true,
        mainTaskId: 'A',
        comboSelectIds: ['C'],
        backupIds: ['D'],
      },
      firstDragDone: true,
      dailySlots: [],
      suspendChainRootTaskId: 'A',
      suspendRecommendationLocked: true,
      pendingDecision: {
        rootTaskId: 'A',
        rootRemainingMinutes: 25,
        candidateGroups: [
          {
            type: 'homologous-advancement',
            taskIds: ['C', 'D'],
          },
        ],
        reason: '候选任务时长匹配异常',
        createdAt: new Date(Date.now() - 5_000).toISOString(),
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      },
      dailyResetDate: '2026-02-25',
      savedAt: new Date().toISOString(),
    });

    vi.advanceTimersByTime(10_500);

    expect(service.pendingDecision()).not.toBeNull();
    expect(service.focusingEntry()?.taskId).toBe('B');
  });

  it('suspend recommendation should only create the first recommendation chain once', () => {
    seedTask('A');
    seedTask('B');
    seedTask('C');

    service.dockTask('A', 'combo-select', { expectedMinutes: 60, load: 'high', zoneSource: 'manual' });
    service.dockTask('B', 'combo-select', { expectedMinutes: 15, load: 'low', zoneSource: 'manual' });
    service.dockTask('C', 'backup', { expectedMinutes: 20, load: 'low', zoneSource: 'manual' });
    service.toggleFocusMode();
    service.switchToTask('A');

    service.suspendTask('A', 30);
    expect(service.lastRuleDecision()?.type).toBe('first_suspend_recommendation');

    expect(service.focusingEntry()).toBeNull();
    expect(service.pendingDecision()).not.toBeNull();

    service.suspendTask('B', 10);
    expect(service.lastRuleDecision()?.type).not.toBe('first_suspend_recommendation');
    expect(service.pendingDecision()).toBeNull();
  });

  it('switchToTask should coalesce to a single entries.update commit', () => {
    seedTask('A');
    seedTask('B');
    seedTask('C');

    service.dockTask('A', 'combo-select', { expectedMinutes: 50, load: 'high', zoneSource: 'manual' });
    service.dockTask('B', 'combo-select', { expectedMinutes: 20, load: 'low', zoneSource: 'manual' });
    service.dockTask('C', 'backup', { expectedMinutes: 35, load: 'low', zoneSource: 'manual' });
    service.toggleFocusMode();
    service.switchToTask('A');

    const updateSpy = vi.spyOn(service.entries, 'update');
    updateSpy.mockClear();

    service.switchToTask('B');

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(service.focusingEntry()?.taskId).toBe('B');
  });

  it('switchToTask should keep critical commit immediate and defer maintenance commit', () => {
    seedTask('A');
    seedTask('B');
    seedTask('C');

    service.dockTask('A', 'combo-select', { expectedMinutes: 50, load: 'high', zoneSource: 'manual' });
    service.dockTask('B', 'combo-select', { expectedMinutes: 20, load: 'low', zoneSource: 'manual' });
    service.dockTask('C', 'backup', { expectedMinutes: 35, load: 'low', zoneSource: 'manual' });
    service.toggleFocusMode();
    service.switchToTask('A');

    const updateSpy = vi.spyOn(service.entries, 'update');
    updateSpy.mockClear();

    service.switchToTask('B');

    expect(service.focusingEntry()?.taskId).toBe('B');
    expect(updateSpy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(PARKING_CONFIG.DOCK_ANIMATION_MS);
    expect(updateSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('holdNonCriticalWork should defer switch maintenance commit until hold window ends', () => {
    seedTask('A');
    seedTask('B');
    seedTask('C');

    service.dockTask('A', 'combo-select', { expectedMinutes: 50, load: 'high', zoneSource: 'manual' });
    service.dockTask('B', 'combo-select', { expectedMinutes: 20, load: 'low', zoneSource: 'manual' });
    service.dockTask('C', 'backup', { expectedMinutes: 35, load: 'low', zoneSource: 'manual' });
    service.toggleFocusMode();
    service.switchToTask('A');

    const updateSpy = vi.spyOn(service.entries, 'update');
    updateSpy.mockClear();

    service.holdNonCriticalWork(320);
    service.switchToTask('B');

    expect(service.focusingEntry()?.taskId).toBe('B');
    expect(updateSpy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(PARKING_CONFIG.DOCK_ANIMATION_MS);
    expect(updateSpy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(PARKING_CONFIG.DOCK_ANIMATION_MS);
    expect(updateSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('holdNonCriticalWork should defer cloud push timer', () => {
    (service as unknown as { restoringSnapshot: { set: (v: boolean) => void } }).restoringSnapshot.set(false);
    mockActionQueue.enqueueForOwner.mockClear();

    service.holdNonCriticalWork(2600);
    service.toggleFocusScrim();
    mockActionQueue.enqueueForOwner.mockClear();

    vi.advanceTimersByTime(PARKING_CONFIG.NOTICE_MIN_VISIBLE_MS);
    expect(mockActionQueue.enqueueForOwner).not.toHaveBeenCalled();

    vi.advanceTimersByTime(PARKING_CONFIG.FRAGMENT_SILENT_FADE_MS);
    expect(mockActionQueue.enqueueForOwner).toHaveBeenCalledTimes(1);
  });

  it('focusSessionState should keep stable sessionId/sessionStartedAt within one session', () => {
    seedTask('A');
    service.dockTask('A');
    service.toggleFocusMode();

    const first = service.exportSnapshot().focusSessionState;
    expect(first).toBeTruthy();

    vi.advanceTimersByTime(PARKING_CONFIG.DOCK_SEMICIRCLE_DRAG_EXPAND_DELAY_MS);
    service.toggleFocusScrim();
    const second = service.exportSnapshot().focusSessionState;
    expect(second).toBeTruthy();

    expect(second?.sessionId).toBe(first?.sessionId);
    expect(second?.sessionStartedAt).toBe(first?.sessionStartedAt);
  });

  it('restoreSnapshot should reset burnout signals to safe defaults when session fields are missing', () => {
    service.highLoadCounter.set({ count: 5, windowStartAt: Date.now() - 1000 });
    service.burnoutTriggeredAt.set(Date.now() - 500);

    service.restoreSnapshot({
      version: 6,
      entries: [],
      focusMode: false,
      isDockExpanded: true,
      muteWaitTone: false,
      session: {
        firstDragIntervened: false,
        focusBlurOn: false,
        focusScrimOn: true,
        mainTaskId: null,
        comboSelectIds: [],
        backupIds: [],
      },
      dailySlots: [],
      suspendChainRootTaskId: null,
      suspendRecommendationLocked: false,
      pendingDecision: null,
      lastRuleDecision: null,
      dailyResetDate: '2026-03-03',
      savedAt: new Date().toISOString(),
    });

    expect(service.highLoadCounter()).toEqual({ count: 0, windowStartAt: 0 });
    expect(service.burnoutTriggeredAt()).toBeNull();
  });

  it('createInDock should default to blackbox ownership (sourceProjectId null)', () => {
    const taskId = service.createInDock('Inline Task', 'backup', 'low');
    const entry = service.entries().find(item => item.taskId === taskId);
    expect(entry?.sourceProjectId).toBeNull();
  });

  it('first main override window should start on focus entry and allow override within 15 seconds', () => {
    seedTask('A');
    seedTask('B');
    service.dockTask('A');
    service.dockTask('B');

    expect(service.firstMainSelectionPending()).toBeNull();
    service.toggleFocusMode();
    expect(service.firstMainSelectionPending()).not.toBeNull();
    service.overrideFirstMainTask('B');
    expect(service.entries().find(item => item.taskId === 'B')?.isMain).toBe(true);
    expect(service.focusingEntry()?.taskId).toBe('B');
  });

  it('first main override window should close after 15 seconds', () => {
    seedTask('A');
    seedTask('B');
    service.dockTask('A');
    service.dockTask('B');

    service.toggleFocusMode();
    vi.advanceTimersByTime(PARKING_CONFIG.NOTICE_FALLBACK_TIMEOUT_MS + 100);
    expect(service.firstMainSelectionPending()).toBeNull();
    service.overrideFirstMainTask('B');
    expect(service.entries().find(item => item.taskId === 'A')?.isMain).toBe(true);
    expect(service.entries().find(item => item.taskId === 'B')?.isMain).toBe(false);
    expect(service.focusingEntry()?.taskId).toBe('B');
  });

  it('restoreSnapshot should recover a unique main when session mainTaskId is null', () => {
    service.restoreSnapshot({
      version: 6,
      entries: [
        {
          taskId: 'A',
          title: 'A',
          sourceProjectId: 'project-1',
          status: 'pending_start',
          load: 'low',
          expectedMinutes: 20,
          waitMinutes: null,
          waitStartedAt: null,
          lane: 'combo-select',
          zoneSource: 'manual',
          isMain: false,
          dockedOrder: 0,
          detail: '',
          sourceKind: 'project-task',
          systemSelected: false,
          recommendedScore: null,
        },
        {
          taskId: 'B',
          title: 'B',
          sourceProjectId: 'project-1',
          status: 'pending_start',
          load: 'low',
          expectedMinutes: 30,
          waitMinutes: null,
          waitStartedAt: null,
          lane: 'backup',
          zoneSource: 'manual',
          isMain: false,
          dockedOrder: 1,
          detail: '',
          sourceKind: 'project-task',
          systemSelected: false,
          recommendedScore: null,
        },
      ],
      focusMode: false,
      isDockExpanded: true,
      muteWaitTone: false,
      session: {
        firstDragIntervened: true,
        focusBlurOn: false,
        focusScrimOn: true,
        mainTaskId: null,
        comboSelectIds: ['A'],
        backupIds: ['B'],
      },
      firstDragDone: true,
      dailySlots: [],
      suspendChainRootTaskId: null,
      suspendRecommendationLocked: false,
      pendingDecision: null,
      dailyResetDate: '2026-02-25',
      savedAt: new Date().toISOString(),
    });

    const activeEntries = service.entries().filter(entry => entry.status !== 'completed');
    const mains = activeEntries.filter(entry => entry.isMain);
    expect(mains).toHaveLength(1);
    expect(mains[0]?.taskId).toBe('A');
  });

  it('cancelPendingDecisionAutoPromote should repair stale system-selected main to a single main', () => {
    service.restoreSnapshot({
      version: 6,
      entries: [
        {
          taskId: 'A',
          title: 'A',
          sourceProjectId: 'project-1',
          status: 'pending_start',
          load: 'low',
          expectedMinutes: 20,
          waitMinutes: null,
          waitStartedAt: null,
          lane: 'combo-select',
          zoneSource: 'manual',
          isMain: false,
          dockedOrder: 0,
          detail: '',
          sourceKind: 'project-task',
          systemSelected: false,
          recommendedScore: null,
        },
        {
          taskId: 'B',
          title: 'B',
          sourceProjectId: 'project-1',
          status: 'pending_start',
          load: 'low',
          expectedMinutes: 30,
          waitMinutes: null,
          waitStartedAt: null,
          lane: 'backup',
          zoneSource: 'manual',
          isMain: true,
          dockedOrder: 1,
          detail: '',
          sourceKind: 'project-task',
          systemSelected: true,
          recommendationLocked: true,
          recommendedScore: 99,
        },
      ],
      focusMode: true,
      isDockExpanded: true,
      muteWaitTone: false,
      session: {
        firstDragIntervened: true,
        focusBlurOn: true,
        focusScrimOn: true,
        mainTaskId: null,
        comboSelectIds: ['A'],
        backupIds: ['B'],
      },
      firstDragDone: true,
      dailySlots: [],
      suspendChainRootTaskId: null,
      suspendRecommendationLocked: false,
      pendingDecision: {
        rootTaskId: 'A',
        rootRemainingMinutes: 15,
        candidateGroups: [
          { type: 'homologous-advancement', taskIds: ['B'] },
        ],
        reason: 'stale-main-cleanup',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3000).toISOString(),
      },
      dailyResetDate: '2026-02-25',
      savedAt: new Date().toISOString(),
    });

    service.cancelPendingDecisionAutoPromote();

    const activeEntries = service.entries().filter(entry => entry.status !== 'completed');
    const mains = activeEntries.filter(entry => entry.isMain);
    expect(mains).toHaveLength(1);
    expect(mains[0]?.taskId).toBe('A');
    expect(service.entries().find(entry => entry.taskId === 'B')?.isMain).toBe(false);
  });

  it('completeTask should keep exactly one successor main when current main completes', () => {
    seedTask('A');
    seedTask('B');
    service.dockTask('A');
    service.dockTask('B');
    service.toggleFocusMode();
    service.switchToTask('A');
    service.setMainTask('B');
    service.switchToTask('A');

    service.completeTask('A');

    const activeEntries = service.entries().filter(entry => entry.status !== 'completed');
    const mains = activeEntries.filter(entry => entry.isMain);
    expect(mains).toHaveLength(1);
    expect(mains[0]?.taskId).toBe('B');
  });

  it('removeFromDock should keep exactly one successor main after removing current main', () => {
    seedTask('A');
    seedTask('B');
    seedTask('C');
    service.dockTask('A');
    service.dockTask('B');
    service.dockTask('C');

    service.removeFromDock('A');

    const activeEntries = service.entries().filter(entry => entry.status !== 'completed');
    const mains = activeEntries.filter(entry => entry.isMain);
    expect(mains).toHaveLength(1);
    expect(mains[0]?.taskId).toBe('B');
  });

  it('switchToTask should only switch C position and keep main ownership unchanged', () => {
    seedTask('A');
    seedTask('B');
    service.dockTask('A');
    service.dockTask('B');
    service.toggleFocusMode();
    service.switchToTask('A');

    expect(service.entries().find(entry => entry.taskId === 'A')?.isMain).toBe(true);

    service.switchToTask('B');

    expect(service.focusingEntry()?.taskId).toBe('B');
    expect(service.entries().find(entry => entry.taskId === 'A')?.isMain).toBe(true);
    expect(service.entries().find(entry => entry.taskId === 'B')?.isMain).toBe(false);
    expect(service.exportSnapshot().session.mainTaskId).toBe('A');
    expect(service.exportSnapshot().focusSessionState?.commandCenterTasks.map(slot => slot.taskId)).toEqual(['A']);
  });

  it('focusSessionState should keep backup-only tasks out of the widget C slots while showing combo-select pending secondaries', () => {
    const makeEntry = (
      taskId: string,
      dockedOrder: number,
      overrides: Partial<ReturnType<typeof service.entries>[number]> = {},
    ) => ({
      taskId,
      title: taskId,
      sourceProjectId: 'project-1',
      status: 'pending_start' as const,
      load: 'low' as const,
      expectedMinutes: 20,
      waitMinutes: null,
      waitStartedAt: null,
      lane: 'backup' as const,
      zoneSource: 'manual' as const,
      isMain: false,
      dockedOrder,
      detail: '',
      sourceKind: 'project-task' as const,
      systemSelected: false,
      recommendedScore: null,
      ...overrides,
    });

    service.restoreSnapshot({
      version: 7,
      entries: [
        makeEntry('A', 0, { isMain: true, status: 'focusing', lane: 'combo-select' }),
        makeEntry('B', 1),
        makeEntry('C', 2, { lane: 'combo-select' }),
        makeEntry('D', 3),
      ],
      focusMode: true,
      isDockExpanded: true,
      muteWaitTone: false,
      session: {
        firstDragIntervened: true,
        focusBlurOn: true,
        focusScrimOn: true,
        mainTaskId: 'A',
        comboSelectIds: ['C'],
        backupIds: ['B', 'D'],
      },
      firstDragDone: true,
      dailySlots: [],
      suspendChainRootTaskId: null,
      suspendRecommendationLocked: false,
      pendingDecision: null,
      dailyResetDate: '2026-04-25',
      savedAt: '2026-04-25T08:00:00.000Z',
    });

    const focusState = service.exportSnapshot().focusSessionState;

    expect(service.consoleVisibleEntries().map(entry => entry.taskId)).toEqual(['A', 'C']);
    expect(focusState?.commandCenterOrderIds).toEqual(['A', 'C']);
    expect(focusState?.comboSelectTasks.map(slot => slot.taskId)).toEqual(['C']);
    expect(focusState?.backupTasks.map(slot => slot.taskId)).toEqual(['B', 'D']);
  });

  it('switchToTask should move the selected visible card to the front and preserve the remaining order', () => {
    seedTask('A');
    seedTask('B');
    seedTask('C');
    seedTask('D');

    service.restoreSnapshot({
      version: 7,
      entries: [
        {
          taskId: 'A',
          title: 'A',
          sourceProjectId: 'project-1',
          status: 'focusing',
          load: 'low',
          expectedMinutes: 20,
          waitMinutes: null,
          waitStartedAt: null,
          lane: 'combo-select',
          zoneSource: 'manual',
          isMain: true,
          dockedOrder: 0,
          detail: '',
          sourceKind: 'project-task',
          systemSelected: false,
          recommendedScore: null,
        },
        {
          taskId: 'B',
          title: 'B',
          sourceProjectId: 'project-1',
          status: 'stalled',
          load: 'low',
          expectedMinutes: 15,
          waitMinutes: null,
          waitStartedAt: null,
          lane: 'combo-select',
          zoneSource: 'manual',
          isMain: false,
          dockedOrder: 1,
          detail: '',
          sourceKind: 'project-task',
          systemSelected: false,
          recommendedScore: null,
        },
        {
          taskId: 'C',
          title: 'C',
          sourceProjectId: 'project-1',
          status: 'stalled',
          load: 'low',
          expectedMinutes: 10,
          waitMinutes: null,
          waitStartedAt: null,
          lane: 'combo-select',
          zoneSource: 'manual',
          isMain: false,
          dockedOrder: 2,
          detail: '',
          sourceKind: 'project-task',
          systemSelected: false,
          recommendedScore: null,
        },
        {
          taskId: 'D',
          title: 'D',
          sourceProjectId: 'project-1',
          status: 'stalled',
          load: 'low',
          expectedMinutes: 5,
          waitMinutes: null,
          waitStartedAt: null,
          lane: 'combo-select',
          zoneSource: 'manual',
          isMain: false,
          dockedOrder: 3,
          detail: '',
          sourceKind: 'project-task',
          systemSelected: false,
          recommendedScore: null,
        },
      ],
      focusMode: true,
      isDockExpanded: true,
      muteWaitTone: false,
      session: {
        firstDragIntervened: true,
        focusBlurOn: true,
        focusScrimOn: true,
        mainTaskId: 'A',
        comboSelectIds: ['B', 'C', 'D'],
        backupIds: [],
      },
      firstDragDone: true,
      dailySlots: [],
      suspendChainRootTaskId: null,
      suspendRecommendationLocked: false,
      pendingDecision: null,
      dailyResetDate: '2026-03-12',
      savedAt: new Date().toISOString(),
    });

    expect(service.consoleVisibleEntries().map(entry => entry.taskId)).toEqual(['A', 'B', 'C', 'D']);

    service.switchToTask('B');

    expect(service.consoleVisibleEntries().map(entry => entry.taskId)).toEqual(['B', 'A', 'C', 'D']);
    expect(service.entries().find(entry => entry.taskId === 'A')?.isMain).toBe(true);
    expect(service.entries().find(entry => entry.taskId === 'A')?.status).toBe('stalled');
    expect(service.exportSnapshot().session.mainTaskId).toBe('A');
    expect(service.exportSnapshot().focusSessionState?.commandCenterOrderIds).toEqual(['B', 'A', 'C', 'D']);
    expect(service.exportSnapshot().focusSessionState?.commandCenterTasks.map(slot => slot.taskId)).toEqual(['A']);
    expect(service.exportSnapshot().focusSessionState?.comboSelectTasks.map(slot => slot.taskId)).toEqual(['B', 'C', 'D']);
  });

  it('switching back to the main task should mark interrupted secondary task as stalled', () => {
    seedTask('A');
    seedTask('B');
    service.dockTask('A');
    service.dockTask('B');
    service.toggleFocusMode();
    service.switchToTask('A');
    service.switchToTask('B');

    service.switchToTask('A');

    expect(service.entries().find(entry => entry.taskId === 'B')?.status).toBe('stalled');
    expect(service.focusingEntry()?.taskId).toBe('A');
  });

  it('should export command center order from the front four active dock tasks even when secondary slots are still pending', () => {
    seedTask('A');
    seedTask('B');
    seedTask('C');
    seedTask('D');
    seedTask('E');

    service.restoreSnapshot({
      version: 7,
      entries: [
        {
          taskId: 'A',
          title: 'A',
          sourceProjectId: 'project-1',
          status: 'focusing',
          load: 'low',
          expectedMinutes: 20,
          waitMinutes: null,
          waitStartedAt: null,
          lane: 'combo-select',
          zoneSource: 'manual',
          isMain: true,
          dockedOrder: 0,
          detail: '',
          sourceKind: 'project-task',
          systemSelected: false,
          recommendedScore: null,
        },
        {
          taskId: 'B',
          title: 'B',
          sourceProjectId: 'project-1',
          status: 'pending_start',
          load: 'low',
          expectedMinutes: 15,
          waitMinutes: null,
          waitStartedAt: null,
          lane: 'combo-select',
          zoneSource: 'manual',
          isMain: false,
          dockedOrder: 1,
          detail: '',
          sourceKind: 'project-task',
          systemSelected: false,
          recommendedScore: null,
        },
        {
          taskId: 'C',
          title: 'C',
          sourceProjectId: 'project-1',
          status: 'pending_start',
          load: 'low',
          expectedMinutes: 10,
          waitMinutes: null,
          waitStartedAt: null,
          lane: 'combo-select',
          zoneSource: 'manual',
          isMain: false,
          dockedOrder: 2,
          detail: '',
          sourceKind: 'project-task',
          systemSelected: false,
          recommendedScore: null,
        },
        {
          taskId: 'D',
          title: 'D',
          sourceProjectId: 'project-1',
          status: 'pending_start',
          load: 'low',
          expectedMinutes: 5,
          waitMinutes: null,
          waitStartedAt: null,
          lane: 'combo-select',
          zoneSource: 'manual',
          isMain: false,
          dockedOrder: 3,
          detail: '',
          sourceKind: 'project-task',
          systemSelected: false,
          recommendedScore: null,
        },
        {
          taskId: 'E',
          title: 'E',
          sourceProjectId: 'project-1',
          status: 'pending_start',
          load: 'low',
          expectedMinutes: 8,
          waitMinutes: null,
          waitStartedAt: null,
          lane: 'backup',
          zoneSource: 'manual',
          isMain: false,
          dockedOrder: 4,
          detail: '',
          sourceKind: 'project-task',
          systemSelected: false,
          recommendedScore: null,
        },
      ],
      focusMode: true,
      isDockExpanded: true,
      muteWaitTone: false,
      session: {
        firstDragIntervened: true,
        focusBlurOn: true,
        focusScrimOn: true,
        mainTaskId: 'A',
        comboSelectIds: ['B', 'C', 'D'],
        backupIds: ['E'],
      },
      firstDragDone: true,
      dailySlots: [],
      suspendChainRootTaskId: null,
      suspendRecommendationLocked: false,
      pendingDecision: null,
      dailyResetDate: '2026-03-12',
      savedAt: new Date().toISOString(),
    });

    const focusState = service.exportSnapshot().focusSessionState;

    expect(focusState?.commandCenterOrderIds).toEqual(['A', 'B', 'C', 'D']);
    expect(focusState?.comboSelectTasks.map(slot => slot.taskId)).toEqual(['B', 'C', 'D']);
    expect(focusState?.backupTasks.map(slot => slot.taskId)).toEqual(['E']);
  });

  it('insertToConsoleFromRadar should move a backup task to the front and evict the last non-main visible card', () => {
    seedTask('A');
    seedTask('B');
    seedTask('C');
    seedTask('D');
    seedTask('E');

    service.restoreSnapshot({
      version: 7,
      entries: [
        {
          taskId: 'A',
          title: 'A',
          sourceProjectId: 'project-1',
          status: 'focusing',
          load: 'low',
          expectedMinutes: 20,
          waitMinutes: null,
          waitStartedAt: null,
          lane: 'combo-select',
          zoneSource: 'manual',
          isMain: true,
          dockedOrder: 0,
          detail: '',
          sourceKind: 'project-task',
          systemSelected: false,
          recommendedScore: null,
        },
        {
          taskId: 'B',
          title: 'B',
          sourceProjectId: 'project-1',
          status: 'stalled',
          load: 'low',
          expectedMinutes: 15,
          waitMinutes: null,
          waitStartedAt: null,
          lane: 'combo-select',
          zoneSource: 'manual',
          isMain: false,
          dockedOrder: 1,
          detail: '',
          sourceKind: 'project-task',
          systemSelected: false,
          recommendedScore: null,
        },
        {
          taskId: 'C',
          title: 'C',
          sourceProjectId: 'project-1',
          status: 'stalled',
          load: 'low',
          expectedMinutes: 10,
          waitMinutes: null,
          waitStartedAt: null,
          lane: 'combo-select',
          zoneSource: 'manual',
          isMain: false,
          dockedOrder: 2,
          detail: '',
          sourceKind: 'project-task',
          systemSelected: false,
          recommendedScore: null,
        },
        {
          taskId: 'D',
          title: 'D',
          sourceProjectId: 'project-1',
          status: 'stalled',
          load: 'low',
          expectedMinutes: 5,
          waitMinutes: null,
          waitStartedAt: null,
          lane: 'combo-select',
          zoneSource: 'manual',
          isMain: false,
          dockedOrder: 3,
          detail: '',
          sourceKind: 'project-task',
          systemSelected: false,
          recommendedScore: null,
        },
        {
          taskId: 'E',
          title: 'E',
          sourceProjectId: 'project-1',
          status: 'pending_start',
          load: 'low',
          expectedMinutes: 8,
          waitMinutes: null,
          waitStartedAt: null,
          lane: 'backup',
          zoneSource: 'manual',
          isMain: false,
          dockedOrder: 4,
          detail: '',
          sourceKind: 'project-task',
          systemSelected: false,
          recommendedScore: null,
        },
      ],
      focusMode: true,
      isDockExpanded: true,
      muteWaitTone: false,
      session: {
        firstDragIntervened: true,
        focusBlurOn: true,
        focusScrimOn: true,
        mainTaskId: 'A',
        comboSelectIds: ['B', 'C', 'D'],
        backupIds: ['E'],
      },
      firstDragDone: true,
      dailySlots: [],
      suspendChainRootTaskId: null,
      suspendRecommendationLocked: false,
      pendingDecision: null,
      dailyResetDate: '2026-03-12',
      savedAt: new Date().toISOString(),
    });

    expect(service.consoleVisibleEntries().map(entry => entry.taskId)).toEqual(['A', 'B', 'C', 'D']);

    const evictedTaskId = service.insertToConsoleFromRadar('E');

    expect(evictedTaskId).toBe('D');
    expect(service.pendingRadarEviction()).toBe('D');
    expect(service.consoleVisibleEntries().map(entry => entry.taskId)).toEqual(['E', 'A', 'B', 'C']);
    expect(service.statusMachineEntries().map(entry => entry.taskId)).toEqual(['E', 'A', 'B', 'C']);
    expect(service.consoleVisibleEntries()).toHaveLength(4);
    expect(service.statusMachineEntries()).toHaveLength(4);
    expect(service.entries().find(entry => entry.taskId === 'A')?.status).toBe('stalled');
    expect(service.entries().find(entry => entry.taskId === 'E')?.status).toBe('focusing');

    service.flushRadarEviction('D');

    const evicted = service.entries().find(entry => entry.taskId === 'D');
    expect(evicted?.lane).toBe('backup');
    expect(evicted?.status).toBe('pending_start');
    expect(service.pendingRadarEviction()).toBeNull();
  });

  it('insertToConsoleFromRadar should protect a fourth-slot main task and evict the previous non-main card', () => {
    seedTask('A');
    seedTask('B');
    seedTask('C');
    seedTask('D');
    seedTask('E');

    service.dockTask('A');
    service.dockTask('B', 'backup', { zoneSource: 'manual' });
    service.dockTask('C', 'backup', { zoneSource: 'manual' });
    service.dockTask('D', 'backup', { zoneSource: 'manual' });
    service.dockTask('E', 'backup', { zoneSource: 'manual' });
    service.toggleFocusMode();
    service.setMainTask('B');
    service.suspendTask('A', 30);
    service.setMainTask('C');
    service.setMainTask('D');

    expect(service.consoleVisibleEntries().map(entry => entry.taskId)).toEqual(['D', 'C', 'B', 'A']);
    expect(service.entries().find(entry => entry.taskId === 'A')?.isMain).toBe(true);
    expect(service.entries().find(entry => entry.taskId === 'A')?.status).toBe('suspended_waiting');

    const evictedTaskId = service.insertToConsoleFromRadar('E');

    expect(evictedTaskId).toBe('B');
    expect(service.pendingRadarEviction()).toBe('B');
    expect(service.consoleVisibleEntries().map(entry => entry.taskId)).toEqual(['E', 'D', 'C', 'A']);
    expect(service.entries().find(entry => entry.taskId === 'A')?.isMain).toBe(true);
    expect(service.consoleVisibleEntries().at(-1)?.taskId).toBe('A');
  });

  it('main completion should prefer stalled task before fresh recommendation', () => {
    seedTask('A');
    seedTask('B');
    seedTask('C');
    service.dockTask('A');
    service.dockTask('B', 'backup', { zoneSource: 'manual' });
    service.dockTask('C', 'combo-select', { zoneSource: 'manual' });
    service.toggleFocusMode();
    service.switchToTask('A');
    service.setMainTask('B');
    service.switchToTask('A');

    expect(service.entries().find(entry => entry.taskId === 'B')?.status).toBe('stalled');

    service.completeTask('A');

    expect(service.focusingEntry()?.taskId).toBe('B');
    expect(service.entries().find(entry => entry.taskId === 'B')?.isMain).toBe(true);
  });

  it('main completion should let the current front secondary inherit main ownership before other stalled tasks', () => {
    seedTask('A');
    seedTask('B');
    seedTask('C');
    service.dockTask('A');
    service.dockTask('B', 'backup', { zoneSource: 'manual' });
    service.dockTask('C', 'combo-select', { zoneSource: 'manual' });
    service.toggleFocusMode();
    service.switchToTask('A');
    service.switchToTask('C');
    service.switchToTask('B');

    expect(service.focusingEntry()?.taskId).toBe('B');
    expect(service.entries().find(entry => entry.taskId === 'C')?.status).toBe('stalled');
    expect(service.entries().find(entry => entry.taskId === 'A')?.isMain).toBe(true);

    service.completeTask('A');

    expect(service.focusingEntry()?.taskId).toBe('B');
    expect(service.entries().find(entry => entry.taskId === 'B')?.isMain).toBe(true);
    expect(service.entries().find(entry => entry.taskId === 'C')?.isMain).toBe(false);
    expect(service.exportSnapshot().session.mainTaskId).toBe('B');
    expect(service.exportSnapshot().focusSessionState?.commandCenterOrderIds?.[0]).toBe('B');
    expect(service.exportSnapshot().focusSessionState?.commandCenterTasks.map(slot => slot.taskId)).toEqual(['B']);
  });

  it('main completion should promote the highest visible C-slot secondary when no task is focused', () => {
    const makeEntry = (taskId: string, overrides: Partial<DockSnapshot['entries'][number]> = {}) => ({
      taskId,
      title: taskId,
      sourceProjectId: 'project-1',
      status: 'pending_start' as const,
      load: 'low' as const,
      expectedMinutes: 10,
      waitMinutes: null,
      waitStartedAt: null,
      lane: 'combo-select' as const,
      zoneSource: 'manual' as const,
      isMain: false,
      dockedOrder: 0,
      detail: '',
      sourceKind: 'project-task' as const,
      systemSelected: false,
      recommendedScore: null,
      ...overrides,
    });

    service.restoreSnapshot({
      version: 7,
      entries: [
        makeEntry('A', { isMain: true, status: 'focusing', lane: 'combo-select', dockedOrder: 0, manualOrder: 0 }),
        makeEntry('B', { status: 'pending_start', lane: 'combo-select', dockedOrder: 1, manualOrder: 1 }),
        makeEntry('C', { status: 'pending_start', lane: 'combo-select', dockedOrder: 2, manualOrder: 2 }),
        makeEntry('D', { status: 'pending_start', lane: 'backup', dockedOrder: 3, manualOrder: 3 }),
      ],
      focusMode: true,
      isDockExpanded: true,
      muteWaitTone: false,
      session: {
        firstDragIntervened: true,
        focusBlurOn: true,
        focusScrimOn: true,
        mainTaskId: 'A',
        comboSelectIds: ['B', 'C'],
        backupIds: ['D'],
      },
      focusSessionState: {
        schemaVersion: 2,
        sessionId: 'session-1',
        sessionStartedAt: 1710000000000,
        isActive: true,
        isFocusOverlayOn: true,
        commandCenterOrderIds: ['A', 'B', 'C'],
        commandCenterTasks: [],
        comboSelectTasks: [],
        backupTasks: [],
        hasFirstBatchSelected: true,
        routineSlotsShownToday: [],
        highLoadCounter: { count: 0, windowStartAt: 0 },
        burnoutTriggeredAt: null,
      },
      firstDragDone: true,
      dailySlots: [],
      suspendChainRootTaskId: null,
      suspendRecommendationLocked: false,
      pendingDecision: null,
      dailyResetDate: '2026-04-25',
      savedAt: '2026-04-25T08:00:00.000Z',
    });

    service.completeTask('A');

    expect(service.focusingEntry()?.taskId).toBe('B');
    expect(service.entries().find(entry => entry.taskId === 'B')?.isMain).toBe(true);
    expect(service.entries().find(entry => entry.taskId === 'C')?.isMain).toBe(false);
    expect(service.entries().find(entry => entry.taskId === 'D')?.isMain).toBe(false);
    expect(service.exportSnapshot().session.mainTaskId).toBe('B');
  });

  it('main completion should float backup candidates instead of auto-promoting when C slots are empty', () => {
    seedTask('A');
    seedTask('B');
    seedTask('C');
    seedTask('D');
    service.dockTask('A');
    service.dockTask('B', 'backup', { zoneSource: 'manual' });
    service.dockTask('C', 'backup', { zoneSource: 'manual' });
    service.dockTask('D', 'backup', { zoneSource: 'manual' });
    service.toggleFocusMode();

    service.completeTask('A');

    expect(service.focusingEntry()).toBeNull();
    expect(service.entries().filter(entry => entry.isMain)).toHaveLength(0);
    expect(service.pendingDecisionEntries().map(entry => entry.taskId)).toEqual(['B', 'C', 'D']);
    expect(service.highlightedIds()).toEqual(new Set(['B', 'C', 'D']));

    service.choosePendingDecisionCandidate('C');

    expect(service.focusingEntry()?.taskId).toBe('C');
    expect(service.entries().find(entry => entry.taskId === 'C')?.isMain).toBe(true);
    expect(service.exportSnapshot().session.mainTaskId).toBe('C');
  });

  it('completeTask should leave focus mode when the final dock task is completed', () => {
    seedTask('A');
    service.dockTask('A');
    service.toggleFocusMode();

    service.completeTask('A');

    expect(service.focusMode()).toBe(false);
    expect(service.exportSnapshot().focusMode).toBe(false);
    expect(service.exportSnapshot().focusSessionState).toBeNull();
  });

  it('completeTask should complete the source black-box entry for dock-created tasks before save exit', () => {
    mockBlackBoxService.create.mockReturnValueOnce({
      ok: true,
      value: { id: 'bb-inline-completed-before-exit', content: 'Inline Temp' },
    });
    seedTask('A');
    service.dockTask('A');
    const inlineTaskId = service.createInDock('Inline Temp', 'backup', 'low');
    expect(inlineTaskId).not.toBeNull();
    service.toggleFocusMode();

    service.completeTask(inlineTaskId!);
    service.markExitAction('save_exit');
    service.toggleFocusMode();

    expect(service.entries().find(entry => entry.taskId === inlineTaskId)?.status).toBe('completed');
    expect(mockBlackBoxService.markAsCompleted).toHaveBeenCalledWith('bb-inline-completed-before-exit');
    expect(mockBlackBoxService.archive).not.toHaveBeenCalledWith('bb-inline-completed-before-exit');
  });

  it('save exit should backfill completed dock-created black-box sources restored from older snapshots', () => {
    mockBlackBoxService.create.mockReturnValueOnce({
      ok: true,
      value: { id: 'bb-inline-restored-completed', content: 'Restored Temp' },
    });
    seedTask('A');
    service.dockTask('A');
    const inlineTaskId = service.createInDock('Restored Temp', 'backup', 'low');
    expect(inlineTaskId).not.toBeNull();
    service.toggleFocusMode();
    service.entries.update(entries =>
      entries.map(entry =>
        entry.taskId === inlineTaskId
          ? { ...entry, status: 'completed' }
          : entry,
      ),
    );

    service.markExitAction('save_exit');
    service.toggleFocusMode();

    expect(mockBlackBoxService.markAsCompleted).toHaveBeenCalledWith('bb-inline-restored-completed');
  });

  it('clearDockForExit should clear entries but keep exit chrome alive until final cleanup', () => {
    seedTask('A');
    service.dockTask('A');
    service.markExitAction('clear_exit');
    service.pendingDecision.set({
      rootTaskId: 'A',
      rootRemainingMinutes: 15,
      candidateGroups: [],
      reason: 'still visible during exit',
      createdAt: new Date().toISOString(),
    });
    service.lastRuleDecision.set({
      type: 'idle_promote',
      reason: 'rule',
      recommendedTaskIds: ['A'],
      createdAt: new Date().toISOString(),
    });
    service.clearDockForExit();

    expect(service.entries()).toHaveLength(0);
    expect(service.pendingDecision()).toEqual(
      expect.objectContaining({ reason: 'still visible during exit' }),
    );
    service.finalizeClearDockForExit();
    expect(service.lastRuleDecision()).toBeNull();
  });

  it('reorderDockEntries should persist manualOrder sequence', () => {
    seedTask('A');
    seedTask('B');
    seedTask('C');
    service.dockTask('A');
    service.dockTask('B');
    service.dockTask('C');

    service.reorderDockEntries('C', 'B');
    const ordered = service.orderedDockEntries().map(entry => entry.taskId);
    expect(ordered).toEqual(['A', 'C', 'B']);
    expect(service.entries().every(entry => entry.manualOrder !== undefined)).toBe(true);
  });

  it('restoreSnapshot should hydrate remote C-slot order into project and exported session state', () => {
    seedTask('A');
    seedTask('B');
    seedTask('C');
    seedTask('D');

    const makeEntry = (taskId: string, dockedOrder: number, overrides: Partial<DockSnapshot['entries'][number]> = {}) => ({
      taskId,
      title: taskId,
      sourceProjectId: 'project-1',
      status: 'stalled' as const,
      load: 'low' as const,
      expectedMinutes: 10,
      waitMinutes: null,
      waitStartedAt: null,
      lane: 'combo-select' as const,
      zoneSource: 'manual' as const,
      isMain: false,
      dockedOrder,
      detail: '',
      sourceKind: 'project-task' as const,
      systemSelected: false,
      recommendedScore: null,
      ...overrides,
    });

    service.restoreSnapshot({
      version: 7,
      entries: [
        makeEntry('A', 0, { isMain: true, status: 'focusing' }),
        makeEntry('B', 1),
        makeEntry('C', 2),
        makeEntry('D', 3),
      ],
      focusMode: true,
      isDockExpanded: true,
      muteWaitTone: false,
      session: {
        firstDragIntervened: true,
        focusBlurOn: true,
        focusScrimOn: true,
        mainTaskId: 'A',
        comboSelectIds: ['D', 'B', 'C'],
        backupIds: [],
      },
      firstDragDone: true,
      dailySlots: [],
      suspendChainRootTaskId: null,
      suspendRecommendationLocked: false,
      pendingDecision: null,
      dailyResetDate: '2026-04-24',
      savedAt: '2026-04-24T08:00:00.000Z',
    });

    expect(service.consoleVisibleEntries().map(entry => entry.taskId)).toEqual(['A', 'D', 'B', 'C']);
    expect(service.entries().map(entry => entry.taskId)).toEqual(['A', 'D', 'B', 'C']);
    expect(service.exportSnapshot().session.comboSelectIds).toEqual(['D', 'B', 'C']);
    expect(service.exportSnapshot().focusSessionState?.comboSelectTasks.map(slot => slot.taskId)).toEqual(['D', 'B', 'C']);
  });

  it('restoreSnapshot should keep widget-promoted secondary C-slot ahead of the master task', () => {
    seedTask('main');
    seedTask('a');
    seedTask('b');
    seedTask('c');

    const makeFocusSlot = (
      taskId: string,
      zone: FocusTaskSlot['zone'],
      zoneIndex: number,
      isMaster: boolean,
      focusStatus: FocusTaskSlot['focusStatus'],
    ): FocusTaskSlot => ({
      slotId: taskId,
      taskId,
      estimatedMinutes: 10,
      waitMinutes: null,
      cognitiveLoad: 'low',
      focusStatus,
      zone,
      zoneIndex,
      isMaster,
      waitStartedAt: null,
      waitEndAt: null,
      sourceProjectId: 'project-1',
      sourceBlockType: null,
      draggedInAt: 1710000000000,
      isFirstBatch: false,
      inlineTitle: taskId,
      inlineDetail: null,
    });

    const makeEntry = (taskId: string, dockedOrder: number, overrides: Partial<DockSnapshot['entries'][number]> = {}) => ({
      taskId,
      title: taskId,
      sourceProjectId: 'project-1',
      status: 'stalled' as const,
      load: 'low' as const,
      expectedMinutes: 10,
      waitMinutes: null,
      waitStartedAt: null,
      lane: 'combo-select' as const,
      zoneSource: 'manual' as const,
      isMain: false,
      dockedOrder,
      manualOrder: dockedOrder,
      detail: '',
      sourceKind: 'project-task' as const,
      systemSelected: false,
      recommendedScore: null,
      ...overrides,
    });

    service.restoreSnapshot({
      version: 7,
      entries: [
        makeEntry('main', 1, { isMain: true }),
        makeEntry('a', 0, { status: 'focusing' }),
        makeEntry('b', 2),
        makeEntry('c', 3),
      ],
      focusMode: true,
      isDockExpanded: true,
      muteWaitTone: false,
      session: {
        firstDragIntervened: true,
        focusBlurOn: true,
        focusScrimOn: true,
        mainTaskId: 'main',
        comboSelectIds: ['a', 'b', 'c'],
        backupIds: [],
      },
      focusSessionState: {
        schemaVersion: 2,
        sessionId: 'session-1',
        sessionStartedAt: 1710000000000,
        isActive: true,
        isFocusOverlayOn: true,
        commandCenterOrderIds: ['a', 'main', 'b', 'c'],
        commandCenterTasks: [
          makeFocusSlot('main', 'command', 0, true, 'pending'),
        ],
        comboSelectTasks: [
          makeFocusSlot('a', 'combo-select', 0, false, 'focusing'),
          makeFocusSlot('b', 'combo-select', 1, false, 'pending'),
          makeFocusSlot('c', 'combo-select', 2, false, 'pending'),
        ],
        backupTasks: [],
        hasFirstBatchSelected: true,
        routineSlotsShownToday: [],
        highLoadCounter: { count: 0, windowStartAt: 0 },
        burnoutTriggeredAt: null,
      },
      firstDragDone: true,
      dailySlots: [],
      suspendChainRootTaskId: null,
      suspendRecommendationLocked: false,
      pendingDecision: null,
      dailyResetDate: '2026-04-26',
      savedAt: '2026-04-26T08:00:00.000Z',
    });

    expect(service.entries().map(entry => entry.taskId)).toEqual(['a', 'main', 'b', 'c']);
    expect(service.entries().map(entry => entry.manualOrder)).toEqual([0, 1, 2, 3]);
    expect(service.consoleVisibleEntries().map(entry => entry.taskId)).toEqual(['a', 'main', 'b', 'c']);
    expect(service.exportSnapshot().focusSessionState?.commandCenterOrderIds).toEqual(['a', 'main', 'b', 'c']);
  });

  it('dock capacity should warn at soft limit and reject at hard limit', () => {
    for (let i = 0; i < 15; i += 1) {
      const id = `soft-${i}`;
      seedTask(id);
      expect(service.dockTask(id)).toBe(true);
    }

    expect(mockToast.info).toHaveBeenCalledTimes(1);
    expect(service.dockCapacity().softReached).toBe(true);

    for (let i = 15; i < 30; i += 1) {
      const id = `hard-${i}`;
      seedTask(id);
      expect(service.dockTask(id)).toBe(true);
    }

    seedTask('overflow-task');
    expect(service.dockTask('overflow-task')).toBe(false);
    expect(service.entries().some(entry => entry.taskId === 'overflow-task')).toBe(false);
    expect(mockToast.warning).toHaveBeenCalled();
    expect(service.dockCapacity().hardReached).toBe(true);
  });

  it('dockedTaskIds should expose active dock membership', () => {
    seedTask('A');
    seedTask('B');
    service.dockTask('A');
    service.dockTask('B');

    const dockedIds = service.dockedTaskIds();
    expect(dockedIds.has('A')).toBe(true);
    expect(dockedIds.has('B')).toBe(true);

    service.completeTask('A');
    expect(service.dockedTaskIds().has('A')).toBe(false);
    expect(service.dockedTaskIds().has('B')).toBe(true);
  });

  it('external task completion should reconcile dock entry out of active pool', async () => {
    seedTask('A');
    service.dockTask('A');

    mockTaskStore.setTask(
      {
        ...taskMap.get('A')!,
        status: 'completed',
        updatedAt: new Date().toISOString(),
      },
      'project-1',
    );
    TestBed.flushEffects();
    await Promise.resolve();
    TestBed.flushEffects();

    expect(service.entries().find(entry => entry.taskId === 'A')?.status).toBe('completed');
    expect(service.dockedTaskIds().has('A')).toBe(false);
  });

  it('completeTask should fall back to the active project when task store mapping is missing', () => {
    seedTask('project-fallback', { projectId: 'project-1' });
    taskProjectMap.delete('project-fallback');

    service.dockTask('project-fallback', 'backup', { zoneSource: 'manual' });
    service.completeTask('project-fallback');

    expect(mockTaskOps.updateTaskStatus).toHaveBeenCalledWith('project-fallback', 'completed');
    expect(mockTaskStore.setTask).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 'project-fallback', status: 'completed' }),
      'project-1',
    );
  });

  it('todayDateKey should honor routine reset hour preference', () => {
    mockFocusPreferenceService.update({ routineResetHourLocal: 5 });

    const dailySlot = TestBed.inject(DockDailySlotService);
    expect(dailySlot.todayDateKey(new Date('2026-03-06T04:59:00'))).toBe('2026-03-05');
    expect(dailySlot.todayDateKey(new Date('2026-03-06T05:00:00'))).toBe('2026-03-06');
  });

  it('completeDailySlot should enqueue UUID-based routine completion mutation', () => {
    const slotId = service.dailySlotService.addDailySlot('Daily Task', 1);
    mockActionQueue.enqueueForOwner.mockClear();

    service.dailySlotService.completeDailySlot(slotId);

    expect(mockActionQueue.enqueueForOwner).toHaveBeenCalledTimes(1);
    const firstCall = mockActionQueue.enqueueForOwner.mock.calls.at(0) as [
      string,
      {
        entityType: string;
        payload: {
          completion: {
            userId: string;
            routineId: string;
            completionId: string;
          };
        };
      },
    ] | undefined;
    expect(firstCall).toBeDefined();
    expect(firstCall?.[0]).toBe('user-1');
    const payload = firstCall?.[1];
    if (!payload) {
      throw new Error('Expected action queue payload to be present');
    }
    expect(payload.entityType).toBe('routine-completion');
    expect(payload.payload.completion.userId).toBe('user-1');
    expect(payload.payload.completion.routineId).toBe(slotId);
    expect(payload.payload.completion.completionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('focus transition helpers should set and clear transition state', () => {
    service.beginFocusTransition({
      phase: 'entering',
      direction: 'enter',
      fromRect: { left: 1, top: 2, width: 100, height: 60 },
      toRect: { left: 10, top: 20, width: 200, height: 120 },
      durationMs: 550,
      startedAt: new Date().toISOString(),
    });

    expect(service.focusTransition()?.phase).toBe('entering');
    service.endFocusTransition();
    expect(service.focusTransition()).toBeNull();
  });

  it('focus chrome restore should expose restoring phase until timer settles', () => {
    expect(service.focusChromePhase()).toBe('idle');

    service.beginFocusChromeRestore(200);
    expect(service.focusChromePhase()).toBe('restoring');

    vi.advanceTimersByTime(220);
    expect(service.focusChromePhase()).toBe('idle');
  });

  // =========================================================================
  //  Init-chain integration — all sub-services respond after construction
  // =========================================================================

  describe('sub-service init chain', () => {
    it('should allow completionFlow operations after engine construction', () => {
      // completionFlow is initialized during DockEngineService constructor via initSubServices.
      // If init() wasn't called, these would throw "must be called before use".
      seedTask('T1');
      service.dockTask('T1');
      // completionFlow's enforceSingleMainInvariant is called during dockTask flow
      expect(service.entries().length).toBe(1);
    });

    it('should allow entryField operations after engine construction', () => {
      seedTask('T1');
      service.dockTask('T1');
      // entryField.toggleLoad would throw if init() wasn't called
      service.toggleLoad('T1', 'up');
      expect(service.entries().find(e => e.taskId === 'T1')?.load).toBe('high');
    });

    it('should allow inlineCreation after engine construction', () => {
      const taskId = service.createInDock('Inline test', 'combo-select', 'low');
      expect(taskId).not.toBeNull();
      expect(service.entries().some(e => e.taskId === taskId)).toBe(true);
    });
  });
});
