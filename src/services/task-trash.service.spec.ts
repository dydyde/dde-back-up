/**
 * TaskTrashService 单元测试
 * 
 * 模式：Injector 隔离模式（无 TestBed 依赖）
 * 
 * 测试覆盖：
 * - 软删除任务（移动到回收站）
 * - 永久删除任务
 * - 从回收站恢复任务
 * - 清空回收站
 * - keepChildren 参数（保留子任务）
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Injector, runInInjectionContext } from '@angular/core';
import { TaskTrashService } from './task-trash.service';
import { LoggerService } from './logger.service';
import { LayoutService } from './layout.service';
import { ParkingService } from './parking.service';
import { TombstoneService } from '../core-bridge';
import { Project, Task } from '../models';
import { ProjectStateService } from './project-state.service';
import { TaskRecordTrackingService } from './task-record-tracking.service';

// 测试数据工厂
function createTask(overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    title: 'Test Task',
    content: '',
    stage: 1,
    parentId: null,
    order: 0,
    rank: 10000,
    status: 'active',
    x: 100,
    y: 100,
    createdDate: now,
    updatedAt: now,
    displayId: '1',
    deletedAt: null,
    ...overrides,
  };
}

function createProject(tasks: Task[] = []): Project {
  const now = new Date().toISOString();
  return {
    id: 'project-1',
    name: 'Test Project',
    description: '',
    createdDate: now,
    updatedAt: now,
    tasks,
    connections: [],
  };
}

describe('TaskTrashService', () => {
  let service: TaskTrashService;
  let mockLogger: { category: ReturnType<typeof vi.fn> };
  let mockLayoutService: Partial<LayoutService>;
  let mockTombstoneService: { clearLocalTombstones: ReturnType<typeof vi.fn> };
  let currentProject: Project | null;
  let recordAndUpdateCalls: number;
  
  beforeEach(() => {
    currentProject = null;
    recordAndUpdateCalls = 0;
    
    const loggerMock = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    mockLogger = {
      category: vi.fn().mockReturnValue(loggerMock),
    };
    
    // LayoutService mock - rebalance 直接返回传入的项目
    mockLayoutService = {
      rebalance: vi.fn().mockImplementation((p: Project) => p),
    };
    
    const mockProjectState = {
      activeProject: () => currentProject,
      getTask: vi.fn((taskId: string) => currentProject?.tasks.find(t => t.id === taskId) ?? null),
    };
    
    const mockRecorder = {
      recordAndUpdate: (mutator: (p: Project) => Project) => {
        recordAndUpdateCalls++;
        if (currentProject) {
          currentProject = mutator(currentProject);
        }
      },
      recordAndUpdateDebounced: (mutator: (p: Project) => Project) => {
        if (currentProject) {
          currentProject = mutator(currentProject);
        }
      },
    };

    const mockParkingService = {
      handleTaskSoftDelete: vi.fn(),
    };

    mockTombstoneService = {
      clearLocalTombstones: vi.fn(),
    };
    
    const injector = Injector.create({
      providers: [
        { provide: LoggerService, useValue: mockLogger },
        { provide: LayoutService, useValue: mockLayoutService },
        { provide: ProjectStateService, useValue: mockProjectState },
        { provide: TaskRecordTrackingService, useValue: mockRecorder },
        { provide: ParkingService, useValue: mockParkingService },
        { provide: TombstoneService, useValue: mockTombstoneService },
      ],
    });
    
    service = runInInjectionContext(injector, () => new TaskTrashService());
  });
  
  describe('初始状态', () => {
    it('无活动项目时删除返回空结果', () => {
      currentProject = null;
      const result = service.deleteTask('task-1');
      expect(result.deletedTaskIds.size).toBe(0);
      expect(result.deletedConnectionIds).toHaveLength(0);
    });
    
    it('任务不存在时返回空结果', () => {
      currentProject = createProject([]);
      const result = service.deleteTask('non-existent');
      expect(result.deletedTaskIds.size).toBe(0);
    });
  });
  
  describe('软删除任务', () => {
    it('删除单个任务应设置 deletedAt', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-23T01:20:00.000Z'));

      const task = createTask({ id: 'task-1', title: 'Root Task' });
      currentProject = createProject([task]);

      try {
        const result = service.deleteTask('task-1');

        expect(result.deletedTaskIds.has('task-1')).toBe(true);
        expect(result.deletedTaskIds.size).toBe(1);

        const deletedTask = currentProject.tasks.find(t => t.id === 'task-1');
        expect(deletedTask?.deletedAt).toBeDefined();
        expect(deletedTask?.updatedAt).toBe('2026-04-23T01:20:00.000Z');
        expect(deletedTask?.stage).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
    
    it('级联删除应包含所有子任务', () => {
      const root = createTask({ id: 'root', title: 'Root' });
      const child1 = createTask({ id: 'child1', parentId: 'root', title: 'Child 1' });
      const child2 = createTask({ id: 'child2', parentId: 'root', title: 'Child 2' });
      const grandchild = createTask({ id: 'grandchild', parentId: 'child1', title: 'Grandchild' });
      currentProject = createProject([root, child1, child2, grandchild]);
      
      const result = service.deleteTask('root');
      
      expect(result.deletedTaskIds.size).toBe(4);
      expect(result.deletedTaskIds.has('root')).toBe(true);
      expect(result.deletedTaskIds.has('child1')).toBe(true);
      expect(result.deletedTaskIds.has('child2')).toBe(true);
      expect(result.deletedTaskIds.has('grandchild')).toBe(true);
    });
    
    it('keepChildren=true 时应保留子任务', () => {
      const root = createTask({ id: 'root', parentId: null, title: 'Root' });
      const child = createTask({ id: 'child', parentId: 'root', title: 'Child' });
      currentProject = createProject([root, child]);
      
      const result = service.deleteTask('root', true);
      
      // 只删除根任务
      expect(result.deletedTaskIds.size).toBe(1);
      expect(result.deletedTaskIds.has('root')).toBe(true);
      expect(result.deletedTaskIds.has('child')).toBe(false);
      
      // 子任务应提升到被删除任务的父级
      const childTask = currentProject.tasks.find(t => t.id === 'child');
      expect(childTask?.parentId).toBeNull();
    });
    
    it('删除任务应同时删除相关连接', () => {
      const task1 = createTask({ id: 'task1' });
      const task2 = createTask({ id: 'task2' });
      const task3 = createTask({ id: 'task3' });
      currentProject = createProject([task1, task2, task3]);
      currentProject.connections = [
        { id: 'conn1', source: 'task1', target: 'task2' },
        { id: 'conn2', source: 'task2', target: 'task3' },
      ];
      
      const result = service.deleteTask('task2');
      
      expect(result.deletedConnectionIds).toContain('conn1');
      expect(result.deletedConnectionIds).toContain('conn2');
      expect(currentProject.connections).toHaveLength(0);
    });

    it('批量删除父子重叠选择应只写入一次并保留原始恢复元数据', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-23T02:00:00.000Z'));

      const root = createTask({ id: 'root', stage: 1, order: 1, rank: 100, parentId: null });
      const child = createTask({ id: 'child', stage: 2, order: 7, rank: 700, parentId: 'root' });
      const grandchild = createTask({ id: 'grandchild', stage: 3, order: 9, rank: 900, parentId: 'child' });
      currentProject = createProject([root, child, grandchild]);
      currentProject.connections = [
        { id: 'conn-root-child', source: 'root', target: 'child' },
        { id: 'conn-child-grandchild', source: 'child', target: 'grandchild' },
      ];

      try {
        const result = service.deleteTasksBatch(['root', 'child', 'child']);

        expect(recordAndUpdateCalls).toBe(1);
        expect(result.deletedTaskIds).toEqual(new Set(['root', 'child', 'grandchild']));
        expect(result.deletedConnectionIds).toEqual(['conn-root-child', 'conn-child-grandchild']);
        expect(currentProject.connections).toHaveLength(0);

        const deletedChild = currentProject.tasks.find(task => task.id === 'child');
        expect(deletedChild?.deletedAt).toBe('2026-04-23T02:00:00.000Z');
        expect(deletedChild?.deletedMeta).toMatchObject({ parentId: 'root', stage: 2, order: 7, rank: 700 });
        expect(deletedChild?.stage).toBeNull();
        expect(deletedChild?.deletedConnections?.map(connection => connection.id).sort()).toEqual([
          'conn-child-grandchild',
          'conn-root-child',
        ]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('恢复批量删除的父任务应恢复子树内保存的连接', () => {
      const root = createTask({ id: 'root', stage: 1, parentId: null });
      const child = createTask({ id: 'child', stage: 1, parentId: 'root' });
      const grandchild = createTask({ id: 'grandchild', stage: 1, parentId: 'child' });
      currentProject = createProject([root, child, grandchild]);
      currentProject.connections = [
        { id: 'conn-root-child', source: 'root', target: 'child' },
        { id: 'conn-child-grandchild', source: 'child', target: 'grandchild' },
      ];

      service.deleteTasksBatch(['root']);
      const restoreResult = service.restoreTask('root');

      expect(restoreResult.restoredTaskIds).toEqual(new Set(['root', 'child', 'grandchild']));
      expect(restoreResult.restoredConnectionIds.sort()).toEqual([
        'conn-child-grandchild',
        'conn-root-child',
      ]);
      expect(currentProject.connections.map(connection => connection.id).sort()).toEqual([
        'conn-child-grandchild',
        'conn-root-child',
      ]);
      expect(currentProject.tasks.every(task => task.deletedAt === null)).toBe(true);
    });
  });
  
  describe('永久删除任务', () => {
    it('永久删除应从列表中移除任务', () => {
      const task = createTask({ id: 'task-1' });
      currentProject = createProject([task]);
      
      const result = service.permanentlyDeleteTask('task-1');
      
      expect(result.deletedTaskIds.has('task-1')).toBe(true);
      expect(currentProject.tasks.find(t => t.id === 'task-1')).toBeUndefined();
    });
    
    it('永久删除应级联删除子任务', () => {
      const root = createTask({ id: 'root' });
      const child = createTask({ id: 'child', parentId: 'root' });
      currentProject = createProject([root, child]);
      
      const result = service.permanentlyDeleteTask('root');
      
      expect(result.deletedTaskIds.size).toBe(2);
      expect(currentProject.tasks).toHaveLength(0);
    });
  });
  
  describe('恢复任务', () => {
    it('恢复任务应清除 deletedAt', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-23T01:30:00.000Z'));

      const task = createTask({ 
        id: 'task-1', 
        deletedAt: new Date().toISOString(),
        stage: null 
      });
      // 模拟 deletedMeta
      (task as any).deletedMeta = { parentId: null, stage: 1, order: 0, rank: 10000, x: 100, y: 100 };
      currentProject = createProject([task]);

      try {
        const result = service.restoreTask('task-1');

        expect(result.restoredTaskIds.has('task-1')).toBe(true);
        const restoredTask = currentProject.tasks.find(t => t.id === 'task-1');
        expect(restoredTask?.deletedAt).toBeNull();
        expect(restoredTask?.updatedAt).toBe('2026-04-23T01:30:00.000Z');
        expect(restoredTask?.stage).toBe(1);
        expect(mockTombstoneService.clearLocalTombstones).toHaveBeenCalledWith('project-1', ['task-1']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('软删除并恢复任务应保留 parkingMeta 快照', () => {
      const parkingMeta = {
        state: 'parked' as const,
        parkedAt: '2026-04-23T00:00:00.000Z',
        lastVisitedAt: '2026-04-23T00:05:00.000Z',
        contextSnapshot: null,
        reminder: null,
        pinned: true,
      };
      const task = createTask({
        id: 'task-parked',
        stage: 2,
        parkingMeta,
      });
      currentProject = createProject([task]);

      const deleteResult = service.deleteTask('task-parked');

      expect(deleteResult.deletedTaskIds.has('task-parked')).toBe(true);
      const deletedTask = currentProject.tasks.find(t => t.id === 'task-parked');
      expect(deletedTask?.parkingMeta).toBeNull();
      expect(deletedTask?.deletedMeta).toMatchObject({
        stage: 2,
        parkingMeta,
      });

      const restoreResult = service.restoreTask('task-parked');

      expect(restoreResult.restoredTaskIds.has('task-parked')).toBe(true);
      const restoredTask = currentProject.tasks.find(t => t.id === 'task-parked');
      expect(restoredTask?.parkingMeta).toEqual(parkingMeta);
      expect(restoredTask?.deletedMeta).toBeUndefined();
      expect(restoredTask?.stage).toBe(2);
    });

    it('恢复 title 和 content 都为空的任务应设置默认 title', () => {
      const task = createTask({ 
        id: 'task-empty', 
        title: '',
        content: '',
        deletedAt: new Date().toISOString(),
        stage: null 
      });
      // 模拟 deletedMeta
      (task as any).deletedMeta = { parentId: null, stage: 1, order: 0, rank: 10000, x: 100, y: 100 };
      currentProject = createProject([task]);
      
      const result = service.restoreTask('task-empty');
      
      expect(result.restoredTaskIds.has('task-empty')).toBe(true);
      const restoredTask = currentProject.tasks.find(t => t.id === 'task-empty');
      expect(restoredTask?.title).toBe('新任务');
      expect(restoredTask?.deletedAt).toBeNull();
    });

    it('恢复有 content 的任务不应修改空 title', () => {
      const task = createTask({ 
        id: 'task-content', 
        title: '',
        content: '有内容',
        deletedAt: new Date().toISOString(),
        stage: null 
      });
      (task as any).deletedMeta = { parentId: null, stage: 1, order: 0, rank: 10000, x: 100, y: 100 };
      currentProject = createProject([task]);
      
      const result = service.restoreTask('task-content');
      
      const restoredTask = currentProject.tasks.find(t => t.id === 'task-content');
      expect(restoredTask?.title).toBe('');
      expect(restoredTask?.content).toBe('有内容');
    });
  });
  
  describe('获取回收站任务', () => {
    it('应返回所有已删除的任务', () => {
      const activeTask = createTask({ id: 'active', deletedAt: null });
      const deletedTask = createTask({ id: 'deleted', deletedAt: new Date().toISOString() });
      currentProject = createProject([activeTask, deletedTask]);
      
      const trashTasks = service.getTrashTasks();
      
      expect(trashTasks).toHaveLength(1);
      expect(trashTasks[0].id).toBe('deleted');
    });
    
    it('无活动项目时返回空数组', () => {
      currentProject = null;
      const trashTasks = service.getTrashTasks();
      expect(trashTasks).toHaveLength(0);
    });
  });
  
  describe('清空回收站', () => {
    it('应永久删除所有回收站任务', () => {
      const activeTask = createTask({ id: 'active', deletedAt: null });
      const deletedTask1 = createTask({ id: 'deleted1', deletedAt: new Date().toISOString() });
      const deletedTask2 = createTask({ id: 'deleted2', deletedAt: new Date().toISOString() });
      currentProject = createProject([activeTask, deletedTask1, deletedTask2]);
      
      const result = service.emptyTrash();
      
      expect(result.deletedTaskIds.size).toBe(2);
      expect(currentProject.tasks).toHaveLength(1);
      expect(currentProject.tasks[0].id).toBe('active');
    });
  });
});
