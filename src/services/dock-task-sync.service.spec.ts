/**
 * DockTaskSyncService 单元测试（Vitest + Injector 隔离模式）
 *
 * 测试覆盖：
 * 1. resolveTaskProjectId — 从 TaskStore 返回项目 ID
 * 2. resolveTaskProjectId — TaskStore 返回 null 时使用 fallback
 * 3. resolveTaskProjectId — 两者都为 null 时返回 null
 * 4. syncTaskPlannerFields — 正确调用 taskOps
 * 5. syncTaskPlannerFields — taskId 无项目时 no-op
 * 6. syncTaskDetail — project-task 来源更新任务内容
 * 7. applyCrossProjectTaskPatch — 调用 taskStore.setTask 和 projectState.updateProjects
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Injector, runInInjectionContext, signal } from '@angular/core';
import { DockTaskSyncService } from './dock-task-sync.service';
import { TaskStore } from '../core-bridge';
import { TaskOperationAdapterService } from './task-operation-adapter.service';
import { ProjectStateService } from './project-state.service';
import { BlackBoxService } from './black-box.service';
import { LoggerService } from './logger.service';
import { Task, Project } from '../models';
import { DockEntry } from '../models/parking-dock';

// ── Mock helpers ──

function createMockTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Test Task',
    content: '',
    stage: 1,
    parentId: null,
    order: 0,
    rank: 500,
    status: 'active',
    x: 0,
    y: 0,
    createdDate: new Date().toISOString(),
    displayId: '1',
    ...overrides,
  };
}

function createMockProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: 'Test Project',
    description: '',
    createdDate: new Date().toISOString(),
    tasks: [],
    connections: [],
    ...overrides,
  };
}

function createMockDockEntry(overrides: Partial<DockEntry> = {}): DockEntry {
  return {
    taskId: 'task-1',
    title: 'Dock Entry',
    sourceProjectId: 'proj-1',
    status: 'pending_start',
    load: 'low',
    expectedMinutes: 30,
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
    ...overrides,
  } as DockEntry;
}

// ── Mocks ──

// LoggerService：测试不关注日志输出，提供最小无操作实现
const noopLoggerCategory = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const mockLoggerService = { category: () => noopLoggerCategory };

const mockTaskStore = {
  getTaskProjectId: vi.fn<(taskId: string) => string | null>().mockReturnValue(null),
  getTask: vi.fn<(id: string) => Task | undefined>().mockReturnValue(undefined),
  setTask: vi.fn(),
};

const mockTaskOps = {
  updateTaskContent: vi.fn(),
  updateTaskExpectedMinutes: vi.fn(),
  updateTaskCognitiveLoad: vi.fn(),
  updateTaskWaitMinutes: vi.fn(),
};

const projectsSignal = signal<Project[]>([]);
const activeProjectIdSignal = signal<string | null>(null);

const mockProjectState = {
  projects: projectsSignal,
  activeProjectId: activeProjectIdSignal,
  updateProjects: vi.fn(),
};

const mockBlackBoxService = {
  update: vi.fn(),
  getEntry: vi.fn().mockReturnValue(undefined),
  markAsCompleted: vi.fn().mockReturnValue({ ok: true, value: {} }),
};

// ── Test suite ──

describe('DockTaskSyncService', () => {
  let service: DockTaskSyncService;

  beforeEach(() => {
    vi.clearAllMocks();
    projectsSignal.set([]);
    activeProjectIdSignal.set(null);
    mockBlackBoxService.getEntry.mockReturnValue(undefined);

    const injector = Injector.create({
      providers: [
        DockTaskSyncService,
        { provide: TaskStore, useValue: mockTaskStore },
        { provide: TaskOperationAdapterService, useValue: mockTaskOps },
        { provide: ProjectStateService, useValue: mockProjectState },
        { provide: BlackBoxService, useValue: mockBlackBoxService },
        { provide: LoggerService, useValue: mockLoggerService },
      ],
    });

    runInInjectionContext(injector, () => {
      service = injector.get(DockTaskSyncService);
    });
  });

  // ==================== resolveTaskProjectId ====================

  describe('resolveTaskProjectId', () => {
    it('should return project ID from task store', () => {
      mockTaskStore.getTaskProjectId.mockReturnValue('proj-from-store');

      const result = service.resolveTaskProjectId('task-1');

      expect(result).toBe('proj-from-store');
      expect(mockTaskStore.getTaskProjectId).toHaveBeenCalledWith('task-1');
    });

    it('should return fallback when task store returns null', () => {
      mockTaskStore.getTaskProjectId.mockReturnValue(null);

      const result = service.resolveTaskProjectId('task-1', 'proj-fallback');

      expect(result).toBe('proj-fallback');
    });

    it('should return null when both task store and fallback are null', () => {
      mockTaskStore.getTaskProjectId.mockReturnValue(null);
      projectsSignal.set([]);
      activeProjectIdSignal.set(null);

      const result = service.resolveTaskProjectId('task-1', null);

      expect(result).toBeNull();
    });
  });

  // ==================== syncTaskPlannerFields ====================

  describe('syncTaskPlannerFields', () => {
    it('should call task operation adapter with correct patch', () => {
      const task = createMockTask({ id: 'task-1', expected_minutes: 30 });
      mockTaskStore.getTask.mockReturnValue(task);
      mockTaskStore.getTaskProjectId.mockReturnValue('proj-1');
      activeProjectIdSignal.set('proj-1');

      service.syncTaskPlannerFields('task-1', {
        expected_minutes: 60,
        cognitive_load: 'high',
      });

      expect(mockTaskOps.updateTaskExpectedMinutes).toHaveBeenCalledWith('task-1', 60);
      expect(mockTaskOps.updateTaskCognitiveLoad).toHaveBeenCalledWith('task-1', 'high');
      // wait_minutes not in patch, should not be called
      expect(mockTaskOps.updateTaskWaitMinutes).not.toHaveBeenCalled();
    });

    it('should no-op when taskId has no project', () => {
      const task = createMockTask({ id: 'task-orphan' });
      mockTaskStore.getTask.mockReturnValue(task);
      mockTaskStore.getTaskProjectId.mockReturnValue(null);
      projectsSignal.set([]);
      activeProjectIdSignal.set(null);

      service.syncTaskPlannerFields('task-orphan', { expected_minutes: 10 });

      expect(mockTaskOps.updateTaskExpectedMinutes).not.toHaveBeenCalled();
      expect(mockTaskOps.updateTaskCognitiveLoad).not.toHaveBeenCalled();
      expect(mockTaskOps.updateTaskWaitMinutes).not.toHaveBeenCalled();
      expect(mockTaskStore.setTask).not.toHaveBeenCalled();
    });
  });

  // ==================== syncTaskDetail ====================

  describe('syncTaskDetail', () => {
    it('should update task content for project-task source in active project', () => {
      const task = createMockTask({ id: 'task-1' });
      mockTaskStore.getTask.mockReturnValue(task);
      mockTaskStore.getTaskProjectId.mockReturnValue('proj-1');
      activeProjectIdSignal.set('proj-1');

      const entry = createMockDockEntry({
        taskId: 'task-1',
        sourceKind: 'project-task',
        sourceProjectId: 'proj-1',
      });

      service.syncTaskDetail('task-1', 'updated detail', {
        entries: [entry],
        focusSessionContext: null,
      });

      expect(mockTaskOps.updateTaskContent).toHaveBeenCalledWith('task-1', 'updated detail');
      expect(mockBlackBoxService.update).not.toHaveBeenCalled();
    });
  });

  describe('syncInlineCompletion', () => {
    it('should mark the source black-box entry completed for dock-created entries', () => {
      const entry = createMockDockEntry({
        taskId: 'inline-task',
        sourceKind: 'dock-created',
        sourceBlackBoxEntryId: 'bb-inline-task',
      });

      service.syncInlineCompletion(entry);

      expect(mockBlackBoxService.markAsCompleted).toHaveBeenCalledWith('bb-inline-task');
    });

    it('should no-op when a dock-created entry has no source black-box entry', () => {
      const entry = createMockDockEntry({
        sourceKind: 'dock-created',
        sourceBlackBoxEntryId: null,
      });

      service.syncInlineCompletion(entry);

      expect(mockBlackBoxService.markAsCompleted).not.toHaveBeenCalled();
    });

    it('should skip source black-box entries that are already completed', () => {
      mockBlackBoxService.getEntry.mockReturnValue({ isCompleted: true });
      const entry = createMockDockEntry({
        sourceKind: 'dock-created',
        sourceBlackBoxEntryId: 'bb-completed',
      });

      service.syncInlineCompletion(entry);

      expect(mockBlackBoxService.markAsCompleted).not.toHaveBeenCalled();
    });

    it('should sync every completed dock-created entry in a restored entries batch', () => {
      service.syncCompletedInlineEntries([
        createMockDockEntry({
          taskId: 'inline-completed',
          sourceKind: 'dock-created',
          sourceBlackBoxEntryId: 'bb-completed-inline',
          status: 'completed',
        }),
        createMockDockEntry({
          taskId: 'inline-active',
          sourceKind: 'dock-created',
          sourceBlackBoxEntryId: 'bb-active-inline',
          status: 'pending_start',
        }),
        createMockDockEntry({
          taskId: 'project-completed',
          sourceKind: 'project-task',
          status: 'completed',
        }),
      ]);

      expect(mockBlackBoxService.markAsCompleted).toHaveBeenCalledTimes(1);
      expect(mockBlackBoxService.markAsCompleted).toHaveBeenCalledWith('bb-completed-inline');
    });
  });

  // ==================== applyCrossProjectTaskPatch ====================

  describe('applyCrossProjectTaskPatch', () => {
    it('should call taskStore.setTask and projectState.updateProjects', () => {
      const task = createMockTask({ id: 'task-1', content: 'old' });
      mockTaskStore.getTask.mockReturnValue(task);

      const project = createMockProject({
        id: 'proj-other',
        tasks: [task],
      });
      projectsSignal.set([project]);

      service.applyCrossProjectTaskPatch('task-1', 'proj-other', { content: 'new' });

      expect(mockTaskStore.setTask).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'task-1', content: 'new' }),
        'proj-other',
      );
      expect(mockProjectState.updateProjects).toHaveBeenCalledWith(expect.any(Function));
    });
  });
});
