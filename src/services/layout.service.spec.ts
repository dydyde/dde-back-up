import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Injector } from '@angular/core';
import { LayoutService } from './layout.service';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { Task, Project, Connection } from '../models';

const mockLoggerCategory = {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
};

function createTask(overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? crypto.randomUUID(),
    title: overrides.title ?? 'Task',
    content: overrides.content ?? '',
    stage: 'stage' in overrides ? overrides.stage! : 1,
    parentId: overrides.parentId ?? null,
    order: overrides.order ?? 1,
    rank: overrides.rank ?? 1000,
    status: overrides.status ?? 'active',
    x: overrides.x ?? 0,
    y: overrides.y ?? 0,
    createdDate: overrides.createdDate ?? now,
    updatedAt: overrides.updatedAt ?? now,
    displayId: overrides.displayId ?? '?',
  };
}

function createProject(tasks: Task[] = [], connections: Connection[] = []): Project {
  const now = new Date().toISOString();
  return {
    id: 'proj-1',
    name: 'Test',
    description: '',
    createdDate: now,
    tasks,
    connections,
  };
}

describe('LayoutService', () => {
  let service: LayoutService;

  beforeEach(() => {
    const injector = Injector.create({
      providers: [
        { provide: LayoutService, useClass: LayoutService },
        { provide: LoggerService, useValue: { category: () => mockLoggerCategory } },
        { provide: ToastService, useValue: { info: vi.fn(), warning: vi.fn(), error: vi.fn(), success: vi.fn() } },
      ],
    });
    service = injector.get(LayoutService);
  });

  describe('gridPosition', () => {
    it('根据阶段和索引计算坐标', () => {
      const pos = service.gridPosition(1, 0);
      expect(pos).toHaveProperty('x');
      expect(pos).toHaveProperty('y');
      expect(typeof pos.x).toBe('number');
      expect(typeof pos.y).toBe('number');
    });

    it('不同阶段返回不同 x 坐标', () => {
      const pos1 = service.gridPosition(1, 0);
      const pos2 = service.gridPosition(2, 0);
      expect(pos1.x).not.toBe(pos2.x);
    });

    it('不同索引返回不同 y 坐标', () => {
      const pos1 = service.gridPosition(1, 0);
      const pos2 = service.gridPosition(1, 1);
      expect(pos1.y).not.toBe(pos2.y);
    });
  });

  describe('getUnassignedPosition', () => {
    it('返回有效坐标', () => {
      const pos = service.getUnassignedPosition(0);
      expect(pos).toHaveProperty('x');
      expect(pos).toHaveProperty('y');
    });

    it('不同数量返回不同位置', () => {
      const pos0 = service.getUnassignedPosition(0);
      const pos1 = service.getUnassignedPosition(1);
      expect(pos0.x !== pos1.x || pos0.y !== pos1.y).toBe(true);
    });
  });

  describe('detectCycle', () => {
    it('无循环时返回 false', () => {
      const tasks = [
        createTask({ id: 'A' }),
        createTask({ id: 'B' }),
      ];
      expect(service.detectCycle('B', 'A', tasks)).toBe(false);
    });

    it('检测到循环时返回 true', () => {
      const tasks = [
        createTask({ id: 'A' }),
        createTask({ id: 'B', parentId: 'A' }),
      ];
      // Setting A's parent to B: walk from B → B.parentId=A → matches taskId → cycle
      expect(service.detectCycle('A', 'B', tasks)).toBe(true);
    });

    it('自身引用返回 true', () => {
      const tasks = [createTask({ id: 'A' })];
      expect(service.detectCycle('A', 'A', tasks)).toBe(true);
    });

    it('newParentId 为 null 时返回 false', () => {
      const tasks = [createTask({ id: 'A' })];
      expect(service.detectCycle('A', null, tasks)).toBe(false);
    });
  });

  describe('detectIncomplete', () => {
    it('检测到 "- [ ]" 返回 true', () => {
      expect(service.detectIncomplete('some text\n- [ ] todo item')).toBe(true);
    });

    it('缩进待办也应返回 true', () => {
      expect(service.detectIncomplete('some text\n  - [ ] nested todo item')).toBe(true);
    });

    it('无未完成待办返回 false', () => {
      expect(service.detectIncomplete('some text\n- [x] done item')).toBe(false);
    });

    it('代码块中的待办不应返回 true', () => {
      expect(service.detectIncomplete('```md\n- [ ] code fence todo\n```')).toBe(false);
    });

    it('空字符串返回 false', () => {
      expect(service.detectIncomplete('')).toBe(false);
    });
  });

  describe('generateShortId', () => {
    it('生成 NF-XXXX 格式的短 ID', () => {
      const id = service.generateShortId([]);
      expect(id).toMatch(/^NF-[A-Z0-9]{4}$/);
    });

    it('不与已有 shortId 重复', () => {
      const existing = [createTask({ shortId: 'NF-AAAA' })];
      const id = service.generateShortId(existing);
      expect(id).not.toBe('NF-AAAA');
    });
  });

  describe('computeInsertRank', () => {
    it('空阶段返回基础 rank', () => {
      const result = service.computeInsertRank(1, [], null, null);
      expect(result.rank).toBeGreaterThan(0);
    });

    it('有兄弟节点时插入末尾', () => {
      const siblings = [
        createTask({ rank: 1000 }),
        createTask({ rank: 2000 }),
      ];
      const result = service.computeInsertRank(1, siblings, null, null);
      expect(result.rank).toBeGreaterThan(2000);
    });
  });

  describe('applyRefusalStrategy', () => {
    it('rank 在有效范围内返回 ok', () => {
      const task = createTask({ rank: 2000 });
      const result = service.applyRefusalStrategy(task, 2000, 1000, 3000);
      expect(result.ok).toBe(true);
    });

    it('rank 小于父 rank 时自动调整到有效值', () => {
      const task = createTask({ rank: 500 });
      const result = service.applyRefusalStrategy(task, 500, 1000, 3000);
      // applyRefusalStrategy 会尝试自动修复 rank
      expect(result.ok).toBe(true);
      expect(result.rank).toBeGreaterThan(1000);
      expect(result.rank).toBeLessThan(3000);
    });

    it('父子区间过窄无法放置时拒绝', () => {
      const task = createTask({ rank: 500 });
      // parentRank=1000, minChildRank=1001 — 区间只有1，RANK_STEP=500 放不下
      const result = service.applyRefusalStrategy(task, 500, 1000, 1001);
      expect(result.ok).toBe(false);
    });
  });

  describe('rebalance', () => {
    it('空项目不出错', () => {
      const project = createProject();
      const result = service.rebalance(project);
      expect(result).toBeDefined();
      expect(result.tasks).toEqual([]);
    });

    it('重平衡后任务保持正确的 displayId', () => {
      const tasks = [
        createTask({ id: 'r1', stage: 1, parentId: null, rank: 1000 }),
        createTask({ id: 'c1', stage: 2, parentId: 'r1', rank: 1500 }),
      ];
      const project = createProject(tasks, [
        { id: 'conn-1', source: 'r1', target: 'c1' },
      ]);
      const result = service.rebalance(project);
      expect(result.tasks.length).toBe(2);
      // displayId should be set (not '?')
      const root = result.tasks.find(t => t.id === 'r1');
      expect(root?.displayId).toBeDefined();
    });

    it('重平衡修复 rank 顺序', () => {
      const tasks = [
        createTask({ id: 'a', stage: 1, rank: 5000 }),
        createTask({ id: 'b', stage: 1, rank: 100 }),
      ];
      const project = createProject(tasks);
      const result = service.rebalance(project);
      // Ranks should still be valid
      expect(result.tasks.every(t => t.rank > 0)).toBe(true);
    });

    it('阶段 1 缺失时将最早可见阶段补回根层', () => {
      const tasks = [
        createTask({ id: 'root', stage: 2, parentId: null, rank: 20000, x: 520 }),
        createTask({ id: 'child', stage: 3, parentId: 'root', rank: 20500, x: 920 }),
      ];
      const project = createProject(tasks);

      const result = service.rebalance(project);
      const root = result.tasks.find(task => task.id === 'root');
      const child = result.tasks.find(task => task.id === 'child');

      expect(root?.stage).toBe(1);
      expect(root?.displayId).toBe('1');
      expect(child?.stage).toBe(2);
      expect(child?.displayId).toBe('1,a');
    });

    it('已有阶段 1 时保留中间阶段孤儿的 O 编号', () => {
      const tasks = [
        createTask({ id: 'stage-1-root', stage: 1, parentId: null, rank: 10000 }),
        createTask({ id: 'orphan', stage: 3, parentId: null, rank: 30000 }),
      ];
      const project = createProject(tasks);

      const result = service.rebalance(project);
      const orphan = result.tasks.find(task => task.id === 'orphan');

      expect(orphan?.stage).toBe(3);
      expect(orphan?.displayId).toBe('O1');
    });
  });

  describe('fixOrphanedTasks', () => {
    it('修复 parentId 指向不存在的任务', () => {
      const tasks = [
        createTask({ id: 'a', parentId: 'nonexistent', stage: 2 }),
        createTask({ id: 'b', stage: 1 }),
      ];
      const result = service.fixOrphanedTasks(tasks);
      expect(result.fixed).toBe(1);
      expect(result.tasks.find(t => t.id === 'a')!.parentId).toBeNull();
    });

    it('无孤儿时不修改', () => {
      const tasks = [
        createTask({ id: 'a', stage: 1 }),
        createTask({ id: 'b', parentId: 'a', stage: 2 }),
      ];
      const result = service.fixOrphanedTasks(tasks);
      expect(result.fixed).toBe(0);
    });
  });

  describe('validateAndFixTree', () => {
    it('健康项目无问题', () => {
      const tasks = [
        createTask({ id: 'a', stage: 1, rank: 1000 }),
      ];
      const project = createProject(tasks);
      const result = service.validateAndFixTree(project);
      expect(result.issues.length).toBe(0);
    });
  });
});
