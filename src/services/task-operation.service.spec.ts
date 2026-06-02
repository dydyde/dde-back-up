/**
 * TaskOperationService 单元测试
 *
 * 使用 Injector 隔离模式，无需 TestBed。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Injector, runInInjectionContext } from '@angular/core';

import { TaskOperationService } from './task-operation.service';
import { TaskTrashService } from './task-trash.service';
import { LayoutService } from './layout.service';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { SubtreeOperationsService } from './subtree-operations.service';
import { TaskCreationService } from './task-creation.service';
import { TaskMoveService } from './task-move.service';
import { TaskAttributeService } from './task-attribute.service';
import { TaskConnectionService } from './task-connection.service';
import { ParkingService } from './parking.service';
import { ProjectStateService } from './project-state.service';
import { TaskRecordTrackingService } from './task-record-tracking.service';
import { TombstoneService } from '../core-bridge';
import { Project, Task, Connection } from '../models';

const mockLoggerCategory = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const mockLoggerService = {
  category: vi.fn(() => mockLoggerCategory),
};

const mockParkingService = {
  handleTaskSoftDelete: vi.fn(),
  handleTaskStatusChange: vi.fn(),
};

const mockTombstoneService = {
  clearLocalTombstones: vi.fn(),
};

function createTask(overrides: Partial<Task>): Task {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? crypto.randomUUID(),
    title: overrides.title ?? 'T',
    content: overrides.content ?? '',
    stage: overrides.stage ?? 1,
    parentId: overrides.parentId ?? null,
    order: overrides.order ?? 1,
    rank: overrides.rank ?? 1000,
    status: overrides.status ?? 'active',
    x: overrides.x ?? 0,
    y: overrides.y ?? 0,
    createdDate: overrides.createdDate ?? now,
    updatedAt: overrides.updatedAt ?? now,
    displayId: overrides.displayId ?? '?',
    shortId: overrides.shortId,
    hasIncompleteTask: overrides.hasIncompleteTask,
    deletedAt: overrides.deletedAt,
    deletedConnections: overrides.deletedConnections,
    deletedMeta: overrides.deletedMeta,
    attachments: overrides.attachments,
    tags: overrides.tags,
    priority: overrides.priority,
    dueDate: overrides.dueDate,
  };
}

function createProject(overrides: Partial<Project>): Project {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? 'p1',
    name: overrides.name ?? 'P',
    description: overrides.description ?? '',
    createdDate: overrides.createdDate ?? now,
    tasks: overrides.tasks ?? [],
    connections: overrides.connections ?? [],
    updatedAt: overrides.updatedAt,
    version: overrides.version,
    viewState: overrides.viewState,
    flowchartUrl: overrides.flowchartUrl,
    flowchartThumbnailUrl: overrides.flowchartThumbnailUrl,
  };
}

describe('TaskOperationService (deletedMeta restore)', () => {
  let service: TaskOperationService;
  let project: Project;
  let consoleLogSpy: ReturnType<typeof vi.spyOn> | undefined;
  let consoleInfoSpy: ReturnType<typeof vi.spyOn> | undefined;
  let consoleDebugSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    // 测试默认静默：避免内部调试日志写入 stdout。
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    consoleDebugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    // 默认项目会在每个测试里初始化
    project = createProject({});

    // 子服务的 DI mock：ProjectStateService 和 TaskRecordTrackingService
    const mockProjectState = {
      activeProject: () => project,
      getTask: (taskId: string) => project?.tasks.find(t => t.id === taskId),
    };
    const mockRecorder = {
      recordAndUpdate: (mutator: (p: Project) => Project) => {
        project = mutator(project);
      },
      recordAndUpdateDebounced: (mutator: (p: Project) => Project) => {
        project = mutator(project);
      },
      lastUpdateType: 'structure' as const,
    };

    const injector = Injector.create({
      providers: [
        { provide: LayoutService, useClass: LayoutService },
        { provide: ToastService, useClass: ToastService },
        { provide: LoggerService, useValue: mockLoggerService },
        { provide: ParkingService, useValue: mockParkingService },
        { provide: TombstoneService, useValue: mockTombstoneService },
        { provide: TaskTrashService, useClass: TaskTrashService },
        { provide: SubtreeOperationsService, useClass: SubtreeOperationsService },
        { provide: TaskCreationService, useClass: TaskCreationService },
        { provide: TaskMoveService, useClass: TaskMoveService },
        { provide: TaskAttributeService, useClass: TaskAttributeService },
        { provide: TaskConnectionService, useClass: TaskConnectionService },
        { provide: ProjectStateService, useValue: mockProjectState },
        { provide: TaskRecordTrackingService, useValue: mockRecorder },
      ],
    });

    service = runInInjectionContext(injector, () => new TaskOperationService());
  });

  afterEach(() => {
    consoleLogSpy?.mockRestore();
    consoleInfoSpy?.mockRestore();
    consoleDebugSpy?.mockRestore();
  });

  it('deleteTask() 会写入 deletedMeta，restoreTask() 会消费并清除 deletedMeta', () => {
    const parent = createTask({
      id: 'parent',
      stage: 1,
      order: 1,
      rank: 1100,
      x: 10,
      y: 20,
      parentId: null,
      displayId: '1,a',
      shortId: 'NF-PARENT',
      deletedAt: null,
    });

    const child = createTask({
      id: 'child',
      stage: 1,
      order: 2,
      rank: 1200,
      x: 30,
      y: 40,
      parentId: 'parent',
      displayId: '1,a.1',
      shortId: 'NF-CHILD',
      deletedAt: null,
    });

    const other = createTask({
      id: 'other',
      stage: 1,
      order: 3,
      rank: 1300,
      x: 50,
      y: 60,
      parentId: null,
      displayId: '1,b',
      shortId: 'NF-OTHER',
      deletedAt: null,
    });

    const connections: Connection[] = [
      { id: 'c-parent-child', source: 'parent', target: 'child' },
      { id: 'c-parent-other', source: 'parent', target: 'other' },
      { id: 'c-child-other', source: 'child', target: 'other' },
    ];

    project = createProject({
      tasks: [parent, child, other],
      connections,
    });

    service.deleteTask('parent');

    const afterDeleteParent = project.tasks.find(t => t.id === 'parent')!;
    const afterDeleteChild = project.tasks.find(t => t.id === 'child')!;
    const afterDeleteOther = project.tasks.find(t => t.id === 'other')!;

    expect(afterDeleteParent.deletedAt).toBeTruthy();
    expect(afterDeleteParent.stage).toBeNull();
    expect(afterDeleteParent.deletedMeta).toEqual({
      parentId: null,
      stage: 1,
      order: 1,
      rank: 1100,
      x: 10,
      y: 20,
      parkingMeta: null,
    });
    expect(afterDeleteParent.deletedConnections?.length).toBe(3);

    expect(afterDeleteChild.deletedAt).toBeTruthy();
    expect(afterDeleteChild.stage).toBeNull();
    expect(afterDeleteChild.deletedMeta).toEqual({
      parentId: 'parent',
      stage: 1,
      order: 2,
      rank: 1200,
      x: 30,
      y: 40,
      parkingMeta: null,
    });

    // 未删除任务不应受影响
    expect(afterDeleteOther.deletedAt ?? null).toBeNull();

    // 连接应从项目中移除（避免引用已删除任务）
    expect(project.connections.length).toBe(0);

    service.restoreTask('parent');

    const afterRestoreParent = project.tasks.find(t => t.id === 'parent')!;
    const afterRestoreChild = project.tasks.find(t => t.id === 'child')!;

    expect(afterRestoreParent.deletedAt ?? null).toBeNull();
    expect(afterRestoreParent.deletedMeta).toBeUndefined();
    expect(afterRestoreParent.parentId).toBeNull();
    expect(afterRestoreParent.stage).toBe(1);

    expect(afterRestoreChild.deletedAt ?? null).toBeNull();
    expect(afterRestoreChild.deletedMeta).toBeUndefined();
    expect(afterRestoreChild.parentId).toBe('parent');
    // rebalance 会强制子任务 stage = parent.stage + 1
    expect(afterRestoreChild.stage).toBe(2);

    // 删除时保存的连接应被恢复（包含父子连线）
    const connKeys = new Set(project.connections.map(c => `${c.source}->${c.target}`));
    expect(connKeys.has('parent->child')).toBe(true);
    expect(connKeys.has('parent->other')).toBe(true);
    expect(connKeys.has('child->other')).toBe(true);
  });
});

describe('TaskOperationService (moveTaskToStage parentId validation)', () => {
  let service: TaskOperationService;
  let project: Project;
  let consoleLogSpy: ReturnType<typeof vi.spyOn> | undefined;
  let consoleInfoSpy: ReturnType<typeof vi.spyOn> | undefined;
  let consoleDebugSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    consoleDebugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    project = createProject({});

    const mockProjectState = {
      activeProject: () => project,
      getTask: (taskId: string) => project?.tasks.find(t => t.id === taskId),
    };
    const mockRecorder = {
      recordAndUpdate: (mutator: (p: Project) => Project) => {
        project = mutator(project);
      },
      recordAndUpdateDebounced: (mutator: (p: Project) => Project) => {
        project = mutator(project);
      },
      lastUpdateType: 'structure' as const,
    };

    const injector = Injector.create({
      providers: [
        { provide: LayoutService, useClass: LayoutService },
        { provide: ToastService, useClass: ToastService },
        { provide: LoggerService, useValue: mockLoggerService },
        { provide: ParkingService, useValue: mockParkingService },
        { provide: TombstoneService, useValue: mockTombstoneService },
        { provide: TaskTrashService, useClass: TaskTrashService },
        { provide: SubtreeOperationsService, useClass: SubtreeOperationsService },
        { provide: TaskCreationService, useClass: TaskCreationService },
        { provide: TaskMoveService, useClass: TaskMoveService },
        { provide: TaskAttributeService, useClass: TaskAttributeService },
        { provide: TaskConnectionService, useClass: TaskConnectionService },
        { provide: ProjectStateService, useValue: mockProjectState },
        { provide: TaskRecordTrackingService, useValue: mockRecorder },
      ],
    });

    service = runInInjectionContext(injector, () => new TaskOperationService());
  });

  afterEach(() => {
    consoleLogSpy?.mockRestore();
    consoleInfoSpy?.mockRestore();
    consoleDebugSpy?.mockRestore();
  });

  it('移动任务到远距离阶段时应清除无效的 parentId', () => {
    // 场景：root 在 stage=1，child 在 stage=2 且 parentId=root
    // 当 child 移动到 stage=5 时，parentId 应被清除（因为 root 不在 stage=4）
    const root = createTask({
      id: 'root',
      stage: 1,
      parentId: null,
      rank: 10000,
      displayId: '1',
    });
    const child = createTask({
      id: 'child',
      stage: 2,
      parentId: 'root',
      rank: 20000,
      displayId: '1,a',
    });

    project = createProject({ tasks: [root, child] });

    // 移动 child 到 stage=5，不提供 newParentId
    service.moveTaskToStage({ taskId: 'child', newStage: 5 });

    const movedChild = project.tasks.find(t => t.id === 'child')!;
    expect(movedChild.stage).toBe(5);
    // parentId 应被清除，因为 root 在 stage=1，不是 stage=4
    expect(movedChild.parentId).toBeNull();
  });

  it('移动任务到相邻阶段时应保留有效的 parentId', () => {
    // 场景：root 在 stage=1，child 在 stage=2 且 parentId=root
    // 由于 rebalance 会强制子任务 stage = parent.stage + 1，
    // 移动到 stage=2 应保留 parentId
    const root = createTask({
      id: 'root',
      stage: 1,
      parentId: null,
      rank: 10000,
    });
    const child = createTask({
      id: 'child',
      stage: 2,
      parentId: 'root',
      rank: 20000,
    });

    project = createProject({ tasks: [root, child] });

    // 移动 child 到 stage=2（相邻阶段），不提供 newParentId
    service.moveTaskToStage({ taskId: 'child', newStage: 2 });

    const movedChild = project.tasks.find(t => t.id === 'child')!;
    expect(movedChild.stage).toBe(2);
    // parentId 应保留，因为 root 在 stage=1 = newStage - 1
    expect(movedChild.parentId).toBe('root');
  });

  it('移动父任务时应级联更新所有子任务的 stage', () => {
    // 场景：root 在 stage=1，child 在 stage=2，grandchild 在 stage=3
    // 当 root 移动到 stage=3 时，child 应变为 stage=4，grandchild 应变为 stage=5
    const stageOneAnchor = createTask({
      id: 'stage-one-anchor',
      stage: 1,
      parentId: null,
      rank: 5000,
    });
    const root = createTask({
      id: 'root',
      stage: 1,
      parentId: null,
      rank: 10000,
    });
    const child = createTask({
      id: 'child',
      stage: 2,
      parentId: 'root',
      rank: 20000,
    });
    const grandchild = createTask({
      id: 'grandchild',
      stage: 3,
      parentId: 'child',
      rank: 30000,
    });

    project = createProject({ tasks: [stageOneAnchor, root, child, grandchild] });

    // 移动 root 到 stage=3
    service.moveTaskToStage({ taskId: 'root', newStage: 3 });

    const movedRoot = project.tasks.find(t => t.id === 'root')!;
    const movedChild = project.tasks.find(t => t.id === 'child')!;
    const movedGrandchild = project.tasks.find(t => t.id === 'grandchild')!;

    expect(movedRoot.stage).toBe(3);
    // 子任务应级联更新到 stage=4
    expect(movedChild.stage).toBe(4);
    // 孙任务应级联更新到 stage=5
    expect(movedGrandchild.stage).toBe(5);
  });

  it('移动任务到未分配区域应清除 parentId', () => {
    const root = createTask({
      id: 'root',
      stage: 1,
      parentId: null,
      rank: 10000,
    });
    const child = createTask({
      id: 'child',
      stage: 2,
      parentId: 'root',
      rank: 20000,
    });

    project = createProject({ tasks: [root, child] });

    // 移动 child 到未分配区域（stage=null）
    service.moveTaskToStage({ taskId: 'child', newStage: null });

    const movedChild = project.tasks.find(t => t.id === 'child')!;
    expect(movedChild.stage).toBeNull();
    expect(movedChild.parentId).toBeNull();
  });
});

describe('TaskOperationService (database constraint validation)', () => {
  let service: TaskOperationService;
  let project: Project;
  let consoleLogSpy: ReturnType<typeof vi.spyOn> | undefined;
  let consoleInfoSpy: ReturnType<typeof vi.spyOn> | undefined;
  let consoleDebugSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    consoleDebugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    project = createProject({});

    const mockProjectState = {
      activeProject: () => project,
      getTask: (taskId: string) => project?.tasks.find(t => t.id === taskId),
    };
    const mockRecorder = {
      recordAndUpdate: (mutator: (p: Project) => Project) => {
        project = mutator(project);
      },
      recordAndUpdateDebounced: (mutator: (p: Project) => Project) => {
        project = mutator(project);
      },
      lastUpdateType: 'structure' as const,
    };

    const injector = Injector.create({
      providers: [
        { provide: LayoutService, useClass: LayoutService },
        { provide: ToastService, useClass: ToastService },
        { provide: LoggerService, useValue: mockLoggerService },
        { provide: ParkingService, useValue: mockParkingService },
        { provide: TombstoneService, useValue: mockTombstoneService },
        { provide: TaskTrashService, useClass: TaskTrashService },
        { provide: SubtreeOperationsService, useClass: SubtreeOperationsService },
        { provide: TaskCreationService, useClass: TaskCreationService },
        { provide: TaskMoveService, useClass: TaskMoveService },
        { provide: TaskAttributeService, useClass: TaskAttributeService },
        { provide: TaskConnectionService, useClass: TaskConnectionService },
        { provide: ProjectStateService, useValue: mockProjectState },
        { provide: TaskRecordTrackingService, useValue: mockRecorder },
      ],
    });

    service = runInInjectionContext(injector, () => new TaskOperationService());
  });

  afterEach(() => {
    consoleLogSpy?.mockRestore();
    consoleInfoSpy?.mockRestore();
    consoleDebugSpy?.mockRestore();
  });

  it('addTask 当 title 和 content 都为空时应设置默认 title', () => {
    const result = service.addTask({
      title: '',
      content: '',
      targetStage: 1,
      parentId: null,
      isSibling: false
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const newTask = project.tasks.find(t => t.id === result.value);
      expect(newTask).toBeDefined();
      expect(newTask!.title).toBe('新任务');
    }
  });

  it('updateTaskTitle 当 title 为空且 content 为空时应设置默认 title', () => {
    const task = createTask({ id: 'task-1', title: '原标题', content: '' });
    project = createProject({ tasks: [task] });

    service.updateTaskTitle('task-1', '');

    const updatedTask = project.tasks.find(t => t.id === 'task-1')!;
    expect(updatedTask.title).toBe('新任务');
  });

  it('updateTaskContent 当 content 为空且 title 为空时应设置默认 title', () => {
    const task = createTask({ id: 'task-1', title: '', content: '原内容' });
    project = createProject({ tasks: [task] });

    service.updateTaskContent('task-1', '');

    const updatedTask = project.tasks.find(t => t.id === 'task-1')!;
    expect(updatedTask.title).toBe('新任务');
  });

  it('addTask 当 title 有值但 content 为空时不应修改 title', () => {
    const result = service.addTask({
      title: '我的标题',
      content: '',
      targetStage: 1,
      parentId: null,
      isSibling: false
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const newTask = project.tasks.find(t => t.id === result.value);
      expect(newTask!.title).toBe('我的标题');
    }
  });

  it('addFloatingTask 当 title 和 content 都为空时应设置默认 title', () => {
    service.addFloatingTask('', '', 100, 200);

    const floatingTasks = project.tasks.filter(t => t.stage === null);
    expect(floatingTasks.length).toBeGreaterThan(0);
    const newTask = floatingTasks[floatingTasks.length - 1];
    expect(newTask.title).toBe('新任务');
    expect(newTask.x).toBe(100);
    expect(newTask.y).toBe(200);
  });

  it('updateTaskTitle 和 updateTaskContent 组合清空时应设置默认 title', () => {
    const task = createTask({ id: 'task-combo', title: '有标题', content: '有内容' });
    project = createProject({ tasks: [task] });

    // 先清空 content
    service.updateTaskContent('task-combo', '');
    let updatedTask = project.tasks.find(t => t.id === 'task-combo')!;
    expect(updatedTask.title).toBe('有标题'); // title 还有值，不应修改

    // 再清空 title，此时两者都为空
    service.updateTaskTitle('task-combo', '');
    updatedTask = project.tasks.find(t => t.id === 'task-combo')!;
    expect(updatedTask.title).toBe('新任务'); // 应设置默认值
  });
});
