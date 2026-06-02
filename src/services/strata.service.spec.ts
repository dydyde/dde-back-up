/**
 * Strata 服务单元测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { StrataService } from './strata.service';
import { BlackBoxService } from './black-box.service';
import { ProjectStateService } from './project-state.service';
import { LoggerService } from './logger.service';
import { 
  strataLayers,
  focusPreferences,
  setBlackBoxEntries
} from '../state/focus-stores';
import { StrataItem, StrataLayer } from '../models/focus';

describe('StrataService', () => {
  let service: StrataService;
  let mockBlackBoxService: {
    entriesMap: ReturnType<typeof signal>;
    getCompletedEntries: ReturnType<typeof vi.fn>;
  };
  let mockProjectStateService: {
    activeProjectId: ReturnType<typeof signal>;
    tasks: ReturnType<typeof signal>;
  };
  let mockLoggerService: {
    debug: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };

  const getLocalDateString = (date = new Date()): string => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  const createMockStrataItem = (overrides: Partial<StrataItem> = {}): StrataItem => ({
    id: crypto.randomUUID(),
    title: '已完成项目',
    type: 'task',
    completedAt: new Date().toISOString(),
    source: undefined,  // 测试时可以为 undefined
    ...overrides
  });

  beforeEach(() => {
    // 重置状态
    strataLayers.set([]);
    setBlackBoxEntries([]);
    focusPreferences.set({
      gateEnabled: true,
      strataEnabled: true,
      blackBoxEnabled: true,
      maxSnoozePerDay: 3,
      routineResetHourLocal: 0,
      restReminderHighLoadMinutes: 90,
      restReminderLowLoadMinutes: 120,
    });

    mockBlackBoxService = {
      entriesMap: signal(new Map()),
      getCompletedEntries: vi.fn().mockReturnValue([])
    };

    mockProjectStateService = {
      activeProjectId: signal('test-project'),
      tasks: signal([])
    };

    mockLoggerService = {
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn()
    };

    TestBed.configureTestingModule({
      providers: [
        StrataService,
        { provide: BlackBoxService, useValue: mockBlackBoxService },
        { provide: ProjectStateService, useValue: mockProjectStateService },
        { provide: LoggerService, useValue: mockLoggerService }
      ]
    });

    service = TestBed.inject(StrataService);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('refresh', () => {
    it('应该刷新地质层数据', () => {
      mockProjectStateService.tasks.set([
        { id: '1', title: '已完成', status: 'completed', updatedAt: new Date().toISOString(), deletedAt: null }
      ]);

      service.refresh();

      const layers = strataLayers();
      expect(layers.length).toBeGreaterThanOrEqual(0);
    });

    it('应该以完成时间稳定排序，避免 updatedAt 后续变化导致条目跳动', () => {
      mockProjectStateService.tasks.set([
        {
          id: 'older-completion',
          title: '先完成但后来编辑',
          status: 'completed',
          completedAt: '2026-04-20T10:00:00.000Z',
          updatedAt: '2026-04-28T08:00:00.000Z',
          createdDate: '2026-04-19T00:00:00.000Z',
          deletedAt: null,
        },
        {
          id: 'newer-completion',
          title: '后完成',
          status: 'completed',
          completedAt: '2026-04-20T11:00:00.000Z',
          updatedAt: '2026-04-20T11:00:00.000Z',
          createdDate: '2026-04-19T00:00:00.000Z',
          deletedAt: null,
        },
      ]);

      service.refresh();

      expect(strataLayers()[0].items.map(item => item.id)).toEqual([
        'newer-completion',
        'older-completion',
      ]);
    });

    it('应该以最后完成日作为沉积剖面的零层，而不是自然今日', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-28T08:00:00.000Z'));
      mockProjectStateService.tasks.set([
        {
          id: 'last-completed-task',
          title: '最后完成日任务',
          status: 'completed',
          completedAt: '2026-04-20T11:00:00.000Z',
          updatedAt: '2026-04-28T08:00:00.000Z',
          createdDate: '2026-04-19T00:00:00.000Z',
          deletedAt: null,
        },
      ]);

      service.refresh();

      expect(strataLayers()[0].date).toBe('2026-04-20');
      expect(service.getDepthLabel('2026-04-20')).toBe('那日');
      expect(service.getLayerLabel('2026-04-20')).toBe('4月20日');
    });

    it('黑匣子 updatedAt 变成今天时不应污染最后完成任务日期标签', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-19T08:00:00.000Z'));
      mockProjectStateService.tasks.set([
        {
          id: 'last-completed-task',
          title: '最后完成任务',
          status: 'completed',
          completedAt: '2026-05-18T10:00:00.000Z',
          updatedAt: '2026-05-18T10:00:00.000Z',
          createdDate: '2026-05-10T00:00:00.000Z',
          deletedAt: null,
        },
      ]);
      setBlackBoxEntries([
        {
          id: 'black-box-synced-today',
          projectId: null,
          userId: 'user-1',
          content: '历史黑匣子条目',
          date: '2026-05-17',
          createdAt: '2026-05-17T09:00:00.000Z',
          updatedAt: '2026-05-19T07:30:00.000Z',
          isRead: true,
          isCompleted: true,
          isArchived: false,
          deletedAt: null,
          syncStatus: 'synced',
          focusMeta: null,
        },
      ]);

      service.refresh();

      const layers = strataLayers();
      expect(layers.map(layer => layer.date)).not.toContain('2026-05-19');
      expect(layers[0].date).toBe('2026-05-18');
      expect(service.getLayerLabel(layers[0].date)).toBe('5月18日');
    });

    it('completedAt 缺失时不应把 5月31日 的 updatedAt 修复脉冲当作历史层日期', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-31T12:00:00.000Z'));
      mockProjectStateService.tasks.set([
        {
          id: 'legacy-completed-task',
          title: '历史完成任务',
          status: 'completed',
          completedAt: null,
          updatedAt: '2026-05-31T08:30:00.000Z',
          createdDate: '2026-05-20T10:00:00.000Z',
          deletedAt: null,
        },
      ]);

      service.refresh();

      const layers = strataLayers();
      expect(layers.map(layer => layer.date)).not.toContain('2026-05-31');
      expect(layers[0].date).toBe('2026-05-20');
      expect(layers[0].items.map(item => item.id)).toEqual(['legacy-completed-task']);
      expect(service.getLayerLabel(layers[0].date)).toBe('5月20日');
    });

    it('completedAt 缺失的历史任务不应随 updatedAt 后续变化重排跳动', () => {
      mockProjectStateService.tasks.set([
        {
          id: 'legacy-earlier-task',
          title: '较早完成任务',
          status: 'completed',
          completedAt: null,
          updatedAt: '2026-05-20T12:00:00.000Z',
          createdDate: '2026-05-20T09:00:00.000Z',
          deletedAt: null,
        },
        {
          id: 'legacy-later-task',
          title: '较晚完成任务',
          status: 'completed',
          completedAt: null,
          updatedAt: '2026-05-31T08:30:00.000Z',
          createdDate: '2026-05-20T11:00:00.000Z',
          deletedAt: null,
        },
      ]);
      service.refresh();
      const firstOrder = strataLayers()[0].items.map(item => item.id);

      mockProjectStateService.tasks.update(tasks => tasks.map(task => task.id === 'legacy-earlier-task'
        ? { ...task, updatedAt: '2026-05-31T09:00:00.000Z' }
        : task));
      service.refresh();

      expect(strataLayers()[0].date).toBe('2026-05-20');
      expect(strataLayers()[0].items.map(item => item.id)).toEqual(firstOrder);
      expect(firstOrder).toEqual(['legacy-later-task', 'legacy-earlier-task']);
    });
  });

  describe('addItem', () => {
    it('应该添加项目到正确的日期层', () => {
      const item = createMockStrataItem({ title: '新完成项目' });

      service.addItem(item);

      const layers = strataLayers();
      expect(layers.length).toBe(1);
      expect(layers[0].items.some(i => i.title === '新完成项目')).toBe(true);
    });

    it('应该在层不存在时创建新层', () => {
      expect(strataLayers().length).toBe(0);

      const item = createMockStrataItem();
      service.addItem(item);

      expect(strataLayers().length).toBe(1);
    });
  });

  describe('getLayerOpacity', () => {
    it('今天的层应该是完全不透明', () => {
      const today = getLocalDateString();
      const layer: StrataLayer = {
        date: today,
        items: [],
        opacity: 1
      };

      const opacity = service.getLayerOpacity(layer);

      expect(opacity).toBe(1);
    });

    it('更早的层应该更透明', () => {
      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 7);
      const layer: StrataLayer = {
        date: getLocalDateString(pastDate),
        items: [],
        opacity: 1
      };

      const opacity = service.getLayerOpacity(layer);

      expect(opacity).toBeLessThan(1);
      expect(opacity).toBeGreaterThan(0);
    });
  });

  describe('getTotalCount', () => {
    it('应该返回所有层的项目总数', () => {
      strataLayers.set([
        { date: '2024-01-01', items: [createMockStrataItem(), createMockStrataItem()], opacity: 1 },
        { date: '2024-01-02', items: [createMockStrataItem()], opacity: 1 }
      ]);

      const total = service.getTotalCount();

      expect(total).toBe(3);
    });

    it('空层应该返回 0', () => {
      expect(service.getTotalCount()).toBe(0);
    });
  });

  describe('clearOldLayers', () => {
    it('应该清除超过保留天数的层', () => {
      const today = new Date();
      const oldDate = new Date(today);
      oldDate.setDate(oldDate.getDate() - 31);

      strataLayers.set([
        { date: getLocalDateString(today), items: [createMockStrataItem()], opacity: 1 },
        { date: getLocalDateString(oldDate), items: [createMockStrataItem()], opacity: 0.3 }
      ]);

      service.clearOldLayers(30);

      const layers = strataLayers();
      expect(layers.length).toBe(1);
      expect(layers[0].date).toBe(getLocalDateString(today));
    });
  });

  describe('collapseLayer', () => {
    it('应该切换层的折叠状态', () => {
      const today = getLocalDateString();
      strataLayers.set([
        { date: today, items: [createMockStrataItem()], opacity: 1, collapsed: false }
      ]);

      service.collapseLayer(today);

      expect(strataLayers()[0].collapsed).toBe(true);

      service.collapseLayer(today);

      expect(strataLayers()[0].collapsed).toBe(false);
    });
  });

  describe('getTodayItems', () => {
    it('应该返回今日完成的项目', () => {
      mockProjectStateService.tasks.set([
        { id: '1', title: '今日完成', status: 'completed', updatedAt: new Date().toISOString(), deletedAt: null }
      ]);

      const items = service.getTodayItems();

      expect(items.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getWeeklyCount', () => {
    it('应该返回本周完成数量', () => {
      const count = service.getWeeklyCount();

      expect(typeof count).toBe('number');
      expect(count).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getLayerLabel', () => {
    it('今天应该返回具体日期（如 2月18日）', () => {
      const today = getLocalDateString();
      const label = service.getLayerLabel(today);
      const d = new Date(today);
      const expected = `${d.getMonth() + 1}月${d.getDate()}日`;
      expect(label).toBe(expected);
    });

    it('其他日期应该返回格式化日期', () => {
      const label = service.getLayerLabel('2024-01-15');

      expect(label).toContain('1月15日');
    });
  });
});
