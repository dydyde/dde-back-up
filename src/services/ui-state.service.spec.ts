import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UiStateService } from './ui-state.service';

const LAST_ACTIVE_VIEW_KEY = 'nanoflow.last-active-view';
const TEXT_UNFINISHED_OPEN_KEY = 'nanoflow.text-unfinished-open';
const TEXT_UNASSIGNED_OPEN_KEY = 'nanoflow.text-unassigned-open';

describe('UiStateService', () => {
  beforeEach(() => {
    localStorage.removeItem(LAST_ACTIVE_VIEW_KEY);
    localStorage.removeItem(TEXT_UNFINISHED_OPEN_KEY);
    localStorage.removeItem(TEXT_UNASSIGNED_OPEN_KEY);
    TestBed.configureTestingModule({
      providers: [UiStateService],
    });
  });

  afterEach(() => {
    localStorage.removeItem(LAST_ACTIVE_VIEW_KEY);
    localStorage.removeItem(TEXT_UNFINISHED_OPEN_KEY);
    localStorage.removeItem(TEXT_UNASSIGNED_OPEN_KEY);
    TestBed.resetTestingModule();
  });

  it('应从 localStorage 恢复上次活跃视图', () => {
    localStorage.setItem(LAST_ACTIVE_VIEW_KEY, 'flow');
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [UiStateService],
    });

    const service = TestBed.inject(UiStateService);
    expect(service.getLastActiveView()).toBe('flow');
  });

  it('persistActiveView 应写入 localStorage 并更新内存状态', () => {
    const service = TestBed.inject(UiStateService);
    service.persistActiveView('text');

    expect(service.getLastActiveView()).toBe('text');
    expect(localStorage.getItem(LAST_ACTIVE_VIEW_KEY)).toBe('text');
  });

  it('ensureView 应同步更新上次活跃视图', () => {
    const service = TestBed.inject(UiStateService);
    service.ensureView('flow');

    expect(service.activeView()).toBe('flow');
    expect(service.getLastActiveView()).toBe('flow');
    expect(localStorage.getItem(LAST_ACTIVE_VIEW_KEY)).toBe('flow');
  });

  it('应记住文本视图待办事项和待分配面板的折叠偏好', () => {
    const service = TestBed.inject(UiStateService);
    expect(service.hasTextUnfinishedOpenPreference()).toBe(false);
    expect(service.hasTextUnassignedOpenPreference()).toBe(false);

    service.setTextUnfinishedOpen(false);
    service.toggleTextUnassignedOpen();

    expect(service.isTextUnfinishedOpen()).toBe(false);
    expect(service.isTextUnassignedOpen()).toBe(false);
    expect(service.hasTextUnfinishedOpenPreference()).toBe(true);
    expect(service.hasTextUnassignedOpenPreference()).toBe(true);
    expect(localStorage.getItem(TEXT_UNFINISHED_OPEN_KEY)).toBe('false');
    expect(localStorage.getItem(TEXT_UNASSIGNED_OPEN_KEY)).toBe('false');

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [UiStateService],
    });

    const restored = TestBed.inject(UiStateService);
    expect(restored.isTextUnfinishedOpen()).toBe(false);
    expect(restored.isTextUnassignedOpen()).toBe(false);
    expect(restored.hasTextUnfinishedOpenPreference()).toBe(true);
    expect(restored.hasTextUnassignedOpenPreference()).toBe(true);
  });

  // ========== 编辑状态管理 ==========

  describe('markEditing / clearEditingState', () => {
    it('markEditing 应将 isEditing 设置为 true', () => {
      const service = TestBed.inject(UiStateService);
      expect(service.isEditing).toBe(false);

      service.markEditing();
      expect(service.isEditing).toBe(true);
    });

    it('clearEditingState 应立即清除编辑状态', () => {
      const service = TestBed.inject(UiStateService);
      service.markEditing();
      expect(service.isEditing).toBe(true);

      service.clearEditingState();
      expect(service.isEditing).toBe(false);
    });

    it('markEditing 超时后应自动清除编辑状态', () => {
      vi.useFakeTimers();
      try {
        const service = TestBed.inject(UiStateService);
        service.markEditing();
        expect(service.isEditing).toBe(true);

        // 超时前仍为编辑状态
        vi.advanceTimersByTime(4999);
        expect(service.isEditing).toBe(true);

        // 超时后自动清除
        vi.advanceTimersByTime(1);
        expect(service.isEditing).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('再次调用 markEditing 应重置超时定时器', () => {
      vi.useFakeTimers();
      try {
        const service = TestBed.inject(UiStateService);
        service.markEditing();

        // 推进 3 秒后再次调用 markEditing
        vi.advanceTimersByTime(3000);
        expect(service.isEditing).toBe(true);
        service.markEditing();

        // 原超时点（5 秒）不应清除编辑状态，因为定时器已被重置
        vi.advanceTimersByTime(2000);
        expect(service.isEditing).toBe(true);

        // 新的 5 秒超时到期后清除
        vi.advanceTimersByTime(3000);
        expect(service.isEditing).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('版本号机制应防止过期定时器回调清除新编辑会话', () => {
      vi.useFakeTimers();
      try {
        const service = TestBed.inject(UiStateService);

        // 第一次 markEditing
        service.markEditing();
        vi.advanceTimersByTime(4500);
        expect(service.isEditing).toBe(true);

        // 第二次 markEditing - 版本号递增
        service.markEditing();

        // 第一次定时器到期 - 版本号不匹配，不应清除
        vi.advanceTimersByTime(500);
        expect(service.isEditing).toBe(true);

        // 第二次定时器到期 - 版本号匹配，应清除
        vi.advanceTimersByTime(4500);
        expect(service.isEditing).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('clearEditingState 应清除挂起的超时定时器', () => {
      vi.useFakeTimers();
      try {
        const service = TestBed.inject(UiStateService);
        service.markEditing();
        service.clearEditingState();
        expect(service.isEditing).toBe(false);

        // 超时到期后不应有任何副作用（不会抛异常）
        vi.advanceTimersByTime(6000);
        expect(service.isEditing).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ========== isTextSidebarVisible ==========

  describe('isTextSidebarVisible', () => {
    it('默认值应为 true', () => {
      const service = TestBed.inject(UiStateService);
      expect(service.isTextSidebarVisible()).toBe(true);
    });

    it('可以通过 set 切换侧边栏可见性', () => {
      const service = TestBed.inject(UiStateService);
      service.isTextSidebarVisible.set(false);
      expect(service.isTextSidebarVisible()).toBe(false);

      service.isTextSidebarVisible.set(true);
      expect(service.isTextSidebarVisible()).toBe(true);
    });
  });

  // ========== clearSearch ==========

  describe('clearSearch', () => {
    it('应清除所有搜索相关状态', () => {
      const service = TestBed.inject(UiStateService);

      // 先设置搜索状态
      service.searchQuery.set('test query');
      service.projectSearchQuery.set('project query');
      service.debouncedSearchQuery.set('debounced query');

      service.clearSearch();

      expect(service.searchQuery()).toBe('');
      expect(service.projectSearchQuery()).toBe('');
      expect(service.debouncedSearchQuery()).toBe('');
    });

    it('应清除挂起的搜索防抖定时器', () => {
      vi.useFakeTimers();
      try {
        const service = TestBed.inject(UiStateService);

        // 设置带防抖的搜索 - 按默认延迟 300ms
        service.setSearchQueryDebounced('hello');
        expect(service.searchQuery()).toBe('hello');
        expect(service.debouncedSearchQuery()).toBe('');

        // 在防抖完成前清除
        service.clearSearch();
        expect(service.searchQuery()).toBe('');

        // 防抖定时器到期后不应回写查询
        vi.advanceTimersByTime(500);
        expect(service.debouncedSearchQuery()).toBe('');
      } finally {
        vi.useRealTimers();
      }
    });

    it('clearSearch 后 hasActiveSearch 应为 false', () => {
      const service = TestBed.inject(UiStateService);
      service.searchQuery.set('something');
      expect(service.hasActiveSearch()).toBe(true);

      service.clearSearch();
      expect(service.hasActiveSearch()).toBe(false);
    });
  });

  // ========== clearAllState ==========

  describe('clearAllState', () => {
    it('应重置搜索、筛选器和编辑状态', () => {
      const service = TestBed.inject(UiStateService);

      // 设置各种状态
      service.searchQuery.set('test');
      service.projectSearchQuery.set('proj');
      service.debouncedSearchQuery.set('test');
      service.filterMode.set('some-filter');
      service.stageViewRootFilter.set('root-1');
      service.stageFilter.set(3);
      service.markEditing();
      service.isFlowDetailOpen.set(true);

      service.clearAllState();

      // 搜索状态已清除
      expect(service.searchQuery()).toBe('');
      expect(service.projectSearchQuery()).toBe('');
      expect(service.debouncedSearchQuery()).toBe('');
      expect(service.hasActiveSearch()).toBe(false);

      // 筛选器已重置
      expect(service.filterMode()).toBe('all');
      expect(service.stageViewRootFilter()).toBe('all');
      expect(service.stageFilter()).toBe('all');

      // 编辑状态已清除
      expect(service.isEditing).toBe(false);

      // 流程详情面板已关闭
      expect(service.isFlowDetailOpen()).toBe(false);
    });

    it('应清除编辑超时定时器并重置版本号', () => {
      vi.useFakeTimers();
      try {
        const service = TestBed.inject(UiStateService);
        service.markEditing();
        expect(service.isEditing).toBe(true);

        service.clearAllState();
        expect(service.isEditing).toBe(false);

        // 超时到期后不应有副作用
        vi.advanceTimersByTime(6000);
        expect(service.isEditing).toBe(false);

        // 版本号已重置 - 新的 markEditing 应正常工作
        service.markEditing();
        expect(service.isEditing).toBe(true);

        vi.advanceTimersByTime(5000);
        expect(service.isEditing).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
