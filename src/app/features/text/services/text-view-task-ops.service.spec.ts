import { ElementRef, NgZone, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TextViewTaskOpsService } from './text-view-task-ops.service';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
import { ProjectStateService } from '../../../../services/project-state.service';
import { UiStateService } from '../../../../services/ui-state.service';
import { ToastService } from '../../../../services/toast.service';
import { LoggerService } from '../../../../services/logger.service';
import { ParkingService } from '../../../../services/parking.service';
import { DockEngineService } from '../../../../services/dock-engine.service';
import { TextViewDragDropService } from './text-view-drag-drop.service';
import { UserSessionService } from '../../../../services/user-session.service';
import type { Task } from '../../../../models';

describe('TextViewTaskOpsService', () => {
  let service: TextViewTaskOpsService;
  let hostElement: HTMLElement;
  let outerScrollContainer: HTMLElement;
  let stageScrollContainer: HTMLElement;
  let stageTaskList: HTMLElement;
  const mockTaskOpsAdapter = {
    addTask: vi.fn(),
    repairMissingStageOne: vi.fn(),
  };
  const mockToast = {
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  };
  const mockUserSession = {
    isHintOnlyStartupPlaceholderVisible: vi.fn(() => false),
  };
  const stageFilter = signal<number | 'all'>('all');
  const stageViewRootFilter = signal<'all' | string>('all');
  const isTextUnassignedOpen = signal(false);
  const mockProjectState = {
    getTask: vi.fn((_id?: string): Task | null => null),
    stages: vi.fn(() => []),
    tasks: vi.fn(() => []),
    unassignedTasks: vi.fn(() => []),
  };
  const mockUiState = {
    stageFilter,
    stageViewRootFilter,
    setStageFilter: vi.fn((value: number | 'all') => stageFilter.set(value)),
    isTextUnassignedOpen,
  };

  const mockRect = (element: HTMLElement, top: number, height: number) => {
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: top,
      top,
      left: 0,
      bottom: top + height,
      right: 0,
      width: 320,
      height,
      toJSON: () => ({}),
    } as DOMRect);
  };

  const createTask = (overrides: Partial<Task> = {}): Task => ({
    id: overrides.id ?? 'task-1',
    title: overrides.title ?? 'Task',
    content: overrides.content ?? '',
    stage: 'stage' in overrides ? overrides.stage! : 1,
    parentId: overrides.parentId ?? null,
    order: overrides.order ?? 1,
    rank: overrides.rank ?? 1000,
    status: overrides.status ?? 'active',
    x: overrides.x ?? 0,
    y: overrides.y ?? 0,
    createdDate: overrides.createdDate ?? new Date().toISOString(),
    updatedAt: overrides.updatedAt ?? new Date().toISOString(),
    displayId: overrides.displayId ?? '1',
    deletedAt: overrides.deletedAt ?? null,
  });

  const initOpsContext = () => {
    service.init({
      selectedTaskId: signal<string | null>(null),
      deleteConfirmTask: signal<Task | null>(null),
      deleteKeepChildren: signal(false),
      focusFlowNode: { emit: vi.fn() } as never,
      isMobile: signal(false),
      getStagesRef: () => undefined,
      getUnassignedRef: () => undefined,
    });
  };

  beforeEach(() => {
    hostElement = document.createElement('div');
    hostElement.innerHTML = `
      <div class="text-view-scroll-container"></div>
      <div data-stage-scroll-container></div>
      <div data-stage-task-list="1"></div>
    `;

    outerScrollContainer = hostElement.querySelector('.text-view-scroll-container') as HTMLElement;
    stageScrollContainer = hostElement.querySelector('[data-stage-scroll-container]') as HTMLElement;
    stageTaskList = hostElement.querySelector('[data-stage-task-list="1"]') as HTMLElement;

    Object.defineProperty(stageTaskList, 'scrollTop', {
      configurable: true,
      writable: true,
      value: 0,
    });
    Object.defineProperty(stageScrollContainer, 'scrollTop', {
      configurable: true,
      writable: true,
      value: 0,
    });

    Object.defineProperty(outerScrollContainer, 'clientHeight', {
      configurable: true,
      value: 480,
    });
    Object.defineProperty(outerScrollContainer, 'scrollHeight', {
      configurable: true,
      value: 960,
    });
    Object.defineProperty(stageScrollContainer, 'clientHeight', {
      configurable: true,
      value: 320,
    });
    Object.defineProperty(stageScrollContainer, 'scrollHeight', {
      configurable: true,
      value: 720,
    });

    mockRect(stageTaskList, 100, 180);
    mockRect(stageScrollContainer, 80, 320);

    TestBed.configureTestingModule({
      providers: [
        TextViewTaskOpsService,
        { provide: ElementRef, useValue: new ElementRef(hostElement) },
        { provide: NgZone, useValue: new NgZone({ enableLongStackTrace: false }) },
        { provide: TaskOperationAdapterService, useValue: mockTaskOpsAdapter },
        { provide: ProjectStateService, useValue: mockProjectState },
        { provide: UiStateService, useValue: mockUiState },
        { provide: ToastService, useValue: mockToast },
        {
          provide: LoggerService,
          useValue: {
            category: vi.fn(() => ({
              debug: vi.fn(),
              warn: vi.fn(),
              error: vi.fn(),
            })),
          },
        },
        { provide: ParkingService, useValue: {} },
        { provide: DockEngineService, useValue: {} },
        { provide: UserSessionService, useValue: mockUserSession },
        {
          provide: TextViewDragDropService,
          useValue: {
            requestSourceStageCollapse: vi.fn(() => null),
            consumeAutoCollapsedSourceStage: vi.fn(() => null),
          },
        },
      ],
    });

    service = TestBed.inject(TextViewTaskOpsService);
  stageFilter.set('all');
  stageViewRootFilter.set('all');
  isTextUnassignedOpen.set(false);
  mockProjectState.getTask.mockReturnValue(null);
  mockProjectState.stages.mockReturnValue([]);
  mockProjectState.tasks.mockReturnValue([]);
  mockProjectState.unassignedTasks.mockReturnValue([]);
  mockUiState.setStageFilter.mockClear();
    mockUserSession.isHintOnlyStartupPlaceholderVisible.mockReturnValue(false);
    mockTaskOpsAdapter.addTask.mockReset();
    mockTaskOpsAdapter.repairMissingStageOne.mockReset();
    mockToast.info.mockReset();
    mockToast.warning.mockReset();
    mockToast.error.mockReset();
  });

  it('should prefer the stage task list when that list can scroll', () => {
    Object.defineProperty(stageTaskList, 'clientHeight', {
      configurable: true,
      value: 180,
    });
    Object.defineProperty(stageTaskList, 'scrollHeight', {
      configurable: true,
      value: 540,
    });

    expect(service.resolveAutoScrollContainer(1)).toBe(stageTaskList);
  });

  it('should fall back to the stage list container when the task list cannot scroll', () => {
    Object.defineProperty(stageTaskList, 'clientHeight', {
      configurable: true,
      value: 180,
    });
    Object.defineProperty(stageTaskList, 'scrollHeight', {
      configurable: true,
      value: 180,
    });

    expect(service.resolveAutoScrollContainer(1)).toBe(stageScrollContainer);
    expect(service.resolveAutoScrollContainer(null)).toBe(stageScrollContainer);
  });

  it('should fall back to the outer text view container when neither task list nor stage list can scroll', () => {
    Object.defineProperty(stageTaskList, 'clientHeight', {
      configurable: true,
      value: 180,
    });
    Object.defineProperty(stageTaskList, 'scrollHeight', {
      configurable: true,
      value: 180,
    });
    Object.defineProperty(stageScrollContainer, 'clientHeight', {
      configurable: true,
      value: 320,
    });
    Object.defineProperty(stageScrollContainer, 'scrollHeight', {
      configurable: true,
      value: 320,
    });

    expect(service.resolveAutoScrollContainer(1)).toBe(outerScrollContainer);
    expect(service.resolveAutoScrollContainer(null)).toBe(outerScrollContainer);
  });

  it('should keep the outer text view container when pointer is outside the stage list edge zones', () => {
    Object.defineProperty(stageTaskList, 'clientHeight', {
      configurable: true,
      value: 180,
    });
    Object.defineProperty(stageTaskList, 'scrollHeight', {
      configurable: true,
      value: 180,
    });

    expect(service.resolveAutoScrollContainer(null, 250)).toBe(outerScrollContainer);
  });

  it('should use the stage list when pointer enters its edge zone without an active stage task list', () => {
    Object.defineProperty(stageTaskList, 'clientHeight', {
      configurable: true,
      value: 180,
    });
    Object.defineProperty(stageTaskList, 'scrollHeight', {
      configurable: true,
      value: 180,
    });

    expect(service.resolveAutoScrollContainer(null, 360)).toBe(stageScrollContainer);
  });

  it('should fall back to the outer text view when the null-stage pointer is in the stage edge zone but the stage list is exhausted', () => {
    Object.defineProperty(stageTaskList, 'clientHeight', {
      configurable: true,
      value: 180,
    });
    Object.defineProperty(stageTaskList, 'scrollHeight', {
      configurable: true,
      value: 180,
    });
    stageScrollContainer.scrollTop = 400;

    expect(service.resolveAutoScrollContainer(null, 360)).toBe(outerScrollContainer);
  });

  it('should fall back to the stage list when the task list is already at the bottom edge', () => {
    Object.defineProperty(stageTaskList, 'clientHeight', {
      configurable: true,
      value: 180,
    });
    Object.defineProperty(stageTaskList, 'scrollHeight', {
      configurable: true,
      value: 540,
    });
    stageTaskList.scrollTop = 360;

    expect(service.resolveAutoScrollContainer(1, 270)).toBe(stageScrollContainer);
  });

  it('should keep the stage list as the auto-scroll container while it can still scroll downward', () => {
    Object.defineProperty(stageTaskList, 'clientHeight', {
      configurable: true,
      value: 180,
    });
    Object.defineProperty(stageTaskList, 'scrollHeight', {
      configurable: true,
      value: 540,
    });
    stageTaskList.scrollTop = 120;

    expect(service.resolveAutoScrollContainer(1, 270)).toBe(stageTaskList);
  });

  it('should fall back to the stage list when the task list is already at the top edge', () => {
    Object.defineProperty(stageTaskList, 'clientHeight', {
      configurable: true,
      value: 180,
    });
    Object.defineProperty(stageTaskList, 'scrollHeight', {
      configurable: true,
      value: 540,
    });
    stageTaskList.scrollTop = 0;
    stageScrollContainer.scrollTop = 120;

    expect(service.resolveAutoScrollContainer(1, 110)).toBe(stageScrollContainer);
  });

  it('should fall back to the outer text view container when task list and stage list are both already at the bottom edge', () => {
    Object.defineProperty(stageTaskList, 'clientHeight', {
      configurable: true,
      value: 180,
    });
    Object.defineProperty(stageTaskList, 'scrollHeight', {
      configurable: true,
      value: 540,
    });
    Object.defineProperty(stageScrollContainer, 'clientHeight', {
      configurable: true,
      value: 320,
    });
    Object.defineProperty(stageScrollContainer, 'scrollHeight', {
      configurable: true,
      value: 720,
    });
    stageTaskList.scrollTop = 360;
    stageScrollContainer.scrollTop = 400;

    expect(service.resolveAutoScrollContainer(1, 270)).toBe(outerScrollContainer);
  });

  it('should block create actions while hint-only startup placeholder is read-only', () => {
    mockUserSession.isHintOnlyStartupPlaceholderVisible.mockReturnValue(true);

    service.onCreateUnassigned();

    expect(mockTaskOpsAdapter.addTask).not.toHaveBeenCalled();
    expect(mockToast.info).toHaveBeenCalledWith('会话确认中', '创建任务暂不可用，owner 确认完成前保持只读');
  });

  it('should repair missing stage one instead of creating an extra stage', () => {
    initOpsContext();
    stageFilter.set(2);
    mockProjectState.stages.mockReturnValue([
      { stageNumber: 2, tasks: [createTask({ id: 'stage-2-root', stage: 2 })] },
    ]);
    mockTaskOpsAdapter.repairMissingStageOne.mockReturnValue(true);

    service.onAddNewStage();

    expect(mockTaskOpsAdapter.repairMissingStageOne).toHaveBeenCalledTimes(1);
    expect(mockTaskOpsAdapter.addTask).not.toHaveBeenCalled();
    expect(mockUiState.setStageFilter).toHaveBeenCalledWith('all');
  });

  it('should append a new stage when stage one is present', () => {
    initOpsContext();
    mockProjectState.stages.mockReturnValue([
      { stageNumber: 1, tasks: [createTask({ id: 'stage-1-root', stage: 1 })] },
      { stageNumber: 2, tasks: [createTask({ id: 'stage-2-child', stage: 2 })] },
    ]);
    mockTaskOpsAdapter.addTask.mockReturnValue({ ok: true, value: 'new-stage-task' });

    service.onAddNewStage();

    expect(mockTaskOpsAdapter.repairMissingStageOne).not.toHaveBeenCalled();
    expect(mockTaskOpsAdapter.addTask).toHaveBeenCalledWith('', '', 3, null, false);
  });

  it('should ignore archived-only stages when deciding whether stage one is missing', () => {
    initOpsContext();
    mockProjectState.stages.mockReturnValue([
      { stageNumber: 2, tasks: [createTask({ id: 'archived-stage-2', stage: 2, status: 'archived' })] },
    ]);
    mockTaskOpsAdapter.addTask.mockReturnValue({ ok: true, value: 'new-stage-task' });

    service.onAddNewStage();

    expect(mockTaskOpsAdapter.repairMissingStageOne).not.toHaveBeenCalled();
    expect(mockTaskOpsAdapter.addTask).toHaveBeenCalledWith('', '', 3, null, false);
  });

  it('should not create a stage when missing-stage repair is unavailable', () => {
    initOpsContext();
    mockProjectState.stages.mockReturnValue([
      { stageNumber: 2, tasks: [createTask({ id: 'stage-2-root', stage: 2 })] },
    ]);
    mockTaskOpsAdapter.repairMissingStageOne.mockReturnValue(false);

    service.onAddNewStage();

    expect(mockTaskOpsAdapter.repairMissingStageOne).toHaveBeenCalledTimes(1);
    expect(mockTaskOpsAdapter.addTask).not.toHaveBeenCalled();
  });

  it('should clear browser text selection on the first blank-area click and deselect on the next click', () => {
    const selectedTaskId = signal<string | null>('task-1');
    const removeAllRanges = vi.fn();
    const getSelectionSpy = vi.spyOn(window, 'getSelection').mockReturnValue({
      toString: () => '供应商',
      rangeCount: 1,
      isCollapsed: false,
      removeAllRanges,
    } as unknown as Selection);

    try {
      service.init({
        selectedTaskId,
        deleteConfirmTask: signal<Task | null>(null),
        deleteKeepChildren: signal(false),
        focusFlowNode: { emit: vi.fn() } as never,
        isMobile: signal(false),
        getStagesRef: () => undefined,
        getUnassignedRef: () => undefined,
      });

      const outside = document.createElement('div');
      hostElement.appendChild(outside);

      service.onContainerClick({ target: outside } as unknown as Event);

      expect(removeAllRanges).toHaveBeenCalledTimes(1);
      expect(selectedTaskId()).toBe('task-1');

      getSelectionSpy.mockRestore();
      service.onContainerClick({ target: outside } as unknown as Event);

      expect(selectedTaskId()).toBeNull();
    } finally {
      getSelectionSpy.mockRestore();
    }
  });

  it('should clear browser text selection and keep task selection on outside button clicks', () => {
    const selectedTaskId = signal<string | null>('task-1');
    const removeAllRanges = vi.fn();
    const getSelectionSpy = vi.spyOn(window, 'getSelection').mockReturnValue({
      toString: () => '供应商',
      rangeCount: 1,
      isCollapsed: false,
      removeAllRanges,
    } as unknown as Selection);

    try {
      service.init({
        selectedTaskId,
        deleteConfirmTask: signal<Task | null>(null),
        deleteKeepChildren: signal(false),
        focusFlowNode: { emit: vi.fn() } as never,
        isMobile: signal(false),
        getStagesRef: () => undefined,
        getUnassignedRef: () => undefined,
      });

      const outsideButton = document.createElement('button');
      hostElement.appendChild(outsideButton);

      service.onContainerClick({ target: outsideButton } as unknown as Event);

      expect(removeAllRanges).toHaveBeenCalledTimes(1);
      expect(selectedTaskId()).toBe('task-1');
    } finally {
      getSelectionSpy.mockRestore();
    }
  });

  it('should keep the current selection when clicking inside a task card', () => {
    const selectedTaskId = signal<string | null>('task-1');

    service.init({
      selectedTaskId,
      deleteConfirmTask: signal<Task | null>(null),
      deleteKeepChildren: signal(false),
      focusFlowNode: { emit: vi.fn() } as never,
      isMobile: signal(false),
      getStagesRef: () => undefined,
      getUnassignedRef: () => undefined,
    });

    const taskCard = document.createElement('div');
    taskCard.setAttribute('data-task-id', 'task-1');
    const inner = document.createElement('span');
    taskCard.appendChild(inner);
    hostElement.appendChild(taskCard);

    service.onContainerClick({ target: inner } as unknown as Event);

    expect(selectedTaskId()).toBe('task-1');
  });

  it('should keep the current selection when the click target is detached but the event path still includes the task card', () => {
    const selectedTaskId = signal<string | null>('task-1');

    service.init({
      selectedTaskId,
      deleteConfirmTask: signal<Task | null>(null),
      deleteKeepChildren: signal(false),
      focusFlowNode: { emit: vi.fn() } as never,
      isMobile: signal(false),
      getStagesRef: () => undefined,
      getUnassignedRef: () => undefined,
    });

    const taskCard = document.createElement('div');
    taskCard.setAttribute('data-task-id', 'task-1');
    const detachedButton = document.createElement('button');

    service.onContainerClick({
      target: detachedButton,
      composedPath: () => [detachedButton, taskCard, hostElement, document.body, document, window],
    } as unknown as Event);

    expect(selectedTaskId()).toBe('task-1');
  });

  it('should ignore the same container click after arming the guard from an internal card interaction', () => {
    const selectedTaskId = signal<string | null>('task-1');

    service.init({
      selectedTaskId,
      deleteConfirmTask: signal<Task | null>(null),
      deleteKeepChildren: signal(false),
      focusFlowNode: { emit: vi.fn() } as never,
      isMobile: signal(false),
      getStagesRef: () => undefined,
      getUnassignedRef: () => undefined,
    });

    const taskCard = document.createElement('div');
    taskCard.setAttribute('data-task-id', 'task-1');
    const inner = document.createElement('span');

    service.armContainerClickGuard('task-1');
    service.onContainerClick({
      target: document.body,
      composedPath: () => [inner, taskCard, hostElement, document.body, document, window],
    } as unknown as Event);

    expect(selectedTaskId()).toBe('task-1');

    service.onContainerClick({ target: document.body } as unknown as Event);

    expect(selectedTaskId()).toBeNull();
  });

  it('should let the first real outside click through after the container guard expires unused', () => {
    const selectedTaskId = signal<string | null>('task-1');

    service.init({
      selectedTaskId,
      deleteConfirmTask: signal<Task | null>(null),
      deleteKeepChildren: signal(false),
      focusFlowNode: { emit: vi.fn() } as never,
      isMobile: signal(false),
      getStagesRef: () => undefined,
      getUnassignedRef: () => undefined,
    });

    service.armContainerClickGuard('task-1');
    service.onContainerClick({ target: document.body } as unknown as Event);

    expect(selectedTaskId()).toBeNull();
  });

  it('should reveal the compact title preview and focus the real title input when scrolling to a new task', () => {
    vi.useFakeTimers();
    const scrollIntoView = vi.fn();
    const revealEditor = vi.fn();
    const inputFocus = vi.fn();
    const inputSelect = vi.fn();
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });

    try {
      const taskCard = document.createElement('div');
      taskCard.setAttribute('data-task-id', 'task-1');
      Object.defineProperty(taskCard, 'scrollIntoView', {
        configurable: true,
        value: scrollIntoView,
      });

      const previewButton = document.createElement('button');
      previewButton.setAttribute('data-title-preview-trigger', '');
      previewButton.addEventListener('click', () => {
        revealEditor();
        const input = document.createElement('input');
        input.setAttribute('data-title-input', '');
        Object.defineProperty(input, 'focus', {
          configurable: true,
          value: inputFocus,
        });
        Object.defineProperty(input, 'select', {
          configurable: true,
          value: inputSelect,
        });
        taskCard.appendChild(input);
      });

      taskCard.appendChild(previewButton);
      hostElement.appendChild(taskCard);

      service.scrollToTaskAndFocus('task-1', 'input[data-title-input]');
      vi.runAllTimers();

      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
      expect(revealEditor).toHaveBeenCalledTimes(1);
      expect(taskCard.querySelector('input[data-title-input]')).not.toBeNull();
      expect(inputFocus).toHaveBeenCalledTimes(1);
      expect(inputSelect).toHaveBeenCalledTimes(1);
    } finally {
      rafSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('should keep the current task selected when the same task emits select again', () => {
    const selectedTaskId = signal<string | null>('task-1');
    const focusFlowNode = { emit: vi.fn() };

    service.init({
      selectedTaskId,
      deleteConfirmTask: signal<Task | null>(null),
      deleteKeepChildren: signal(false),
      focusFlowNode: focusFlowNode as never,
      isMobile: signal(false),
      getStagesRef: () => undefined,
      getUnassignedRef: () => undefined,
    });

    service.onTaskSelect({ id: 'task-1' } as Task);

    expect(selectedTaskId()).toBe('task-1');
    expect(focusFlowNode.emit).not.toHaveBeenCalled();
  });

  it('should select a different task and focus its flow node on desktop', () => {
    const selectedTaskId = signal<string | null>(null);
    const focusFlowNode = { emit: vi.fn() };

    service.init({
      selectedTaskId,
      deleteConfirmTask: signal<Task | null>(null),
      deleteKeepChildren: signal(false),
      focusFlowNode: focusFlowNode as never,
      isMobile: signal(false),
      getStagesRef: () => undefined,
      getUnassignedRef: () => undefined,
    });

    service.onTaskSelect({ id: 'task-2' } as Task);

    expect(selectedTaskId()).toBe('task-2');
    expect(focusFlowNode.emit).toHaveBeenCalledWith('task-2');
  });

  it('should ignore invalid task select payloads', () => {
    const selectedTaskId = signal<string | null>('task-1');
    const focusFlowNode = { emit: vi.fn() };

    service.init({
      selectedTaskId,
      deleteConfirmTask: signal<Task | null>(null),
      deleteKeepChildren: signal(false),
      focusFlowNode: focusFlowNode as never,
      isMobile: signal(false),
      getStagesRef: () => undefined,
      getUnassignedRef: () => undefined,
    });

    service.onTaskSelect(undefined);

    expect(selectedTaskId()).toBe('task-1');
    expect(focusFlowNode.emit).not.toHaveBeenCalled();
  });

  it('should reuse jump logic for staged linked tasks', () => {
    const selectedTaskId = signal<string | null>(null);
    const expandStage = vi.fn();
    const linkedTask = { id: 'task-2', stage: 2 } as Task;
    mockProjectState.getTask.mockReturnValue(linkedTask);

    const stagedTask = document.createElement('div');
    stagedTask.setAttribute('data-task-id', linkedTask.id);
    Object.defineProperty(stagedTask, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    hostElement.appendChild(stagedTask);

    service.init({
      selectedTaskId,
      deleteConfirmTask: signal<Task | null>(null),
      deleteKeepChildren: signal(false),
      focusFlowNode: { emit: vi.fn() } as never,
      isMobile: signal(false),
      getStagesRef: () => ({ expandStage } as never),
      getUnassignedRef: () => undefined,
    });

    service.onOpenLinkedTask({ taskId: linkedTask.id, event: { stopPropagation: vi.fn() } as unknown as Event });

    expect(expandStage).toHaveBeenCalledWith(2);
    expect(selectedTaskId()).toBe('task-2');
  });

  it('should warn when a linked task id cannot be resolved', () => {
    const stopPropagation = vi.fn();
    mockProjectState.getTask.mockReturnValue(null);

    service.onOpenLinkedTask({ taskId: 'missing-task', event: { stopPropagation } as unknown as Event });

    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(mockToast.warning).toHaveBeenCalledWith('任务链接不可用', '目标任务不存在、已删除或已归档');
  });

  it('should clear the root filter before jumping to a staged linked task outside the current subtree', async () => {
    const selectedTaskId = signal<string | null>(null);
    const expandStage = vi.fn();
    const rootTask = { id: 'root-1', displayId: '1' } as Task;
    const linkedTask = { id: 'task-4', stage: 3, displayId: '2,1' } as Task;
    stageViewRootFilter.set(rootTask.id);
    mockProjectState.getTask.mockImplementation((id?: string) => {
      if (id === rootTask.id) {
        return rootTask;
      }

      if (id === linkedTask.id) {
        return linkedTask;
      }

      return null;
    });

    const stagedTask = document.createElement('div');
    stagedTask.setAttribute('data-task-id', linkedTask.id);
    Object.defineProperty(stagedTask, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    hostElement.appendChild(stagedTask);

    service.init({
      selectedTaskId,
      deleteConfirmTask: signal<Task | null>(null),
      deleteKeepChildren: signal(false),
      focusFlowNode: { emit: vi.fn() } as never,
      isMobile: signal(false),
      getStagesRef: () => ({ expandStage } as never),
      getUnassignedRef: () => undefined,
    });

    await service.onJumpToTask(linkedTask.id);

    expect(stageViewRootFilter()).toBe('all');
    expect(expandStage).toHaveBeenCalledWith(3);
    expect(selectedTaskId()).toBe(linkedTask.id);
  });

  it('should treat stage 0 linked tasks as staged instead of unassigned', async () => {
    const selectedTaskId = signal<string | null>(null);
    const expandStage = vi.fn();
    const setEditingTask = vi.fn().mockResolvedValue(undefined);
    const linkedTask = { id: 'task-0', stage: 0 } as Task;
    mockProjectState.getTask.mockReturnValue(linkedTask);

    const stagedTask = document.createElement('div');
    stagedTask.setAttribute('data-task-id', linkedTask.id);
    Object.defineProperty(stagedTask, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    hostElement.appendChild(stagedTask);

    service.init({
      selectedTaskId,
      deleteConfirmTask: signal<Task | null>(null),
      deleteKeepChildren: signal(false),
      focusFlowNode: { emit: vi.fn() } as never,
      isMobile: signal(false),
      getStagesRef: () => ({ expandStage } as never),
      getUnassignedRef: () => ({ setEditingTask } as never),
    });

    await service.onJumpToTask(linkedTask.id);

    expect(expandStage).toHaveBeenCalledWith(0);
    expect(setEditingTask).not.toHaveBeenCalled();
    expect(isTextUnassignedOpen()).toBe(false);
    expect(selectedTaskId()).toBe(linkedTask.id);
  });

  it('should clear staged selection and reuse jump logic for unassigned linked tasks', async () => {
    vi.useFakeTimers();
    const selectedTaskId = signal<string | null>('task-1');
    const setEditingTask = vi.fn().mockResolvedValue(undefined);
    const linkedTask = { id: 'task-3', stage: null } as Task;
    mockProjectState.getTask.mockReturnValue(linkedTask);

    const unassignedTask = document.createElement('div');
    unassignedTask.setAttribute('data-unassigned-task', linkedTask.id);
    Object.defineProperty(unassignedTask, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    hostElement.appendChild(unassignedTask);

    service.init({
      selectedTaskId,
      deleteConfirmTask: signal<Task | null>(null),
      deleteKeepChildren: signal(false),
      focusFlowNode: { emit: vi.fn() } as never,
      isMobile: signal(false),
      getStagesRef: () => undefined,
      getUnassignedRef: () => ({ setEditingTask } as never),
    });

    const jumpPromise = service.onJumpToTask(linkedTask.id);
    await vi.advanceTimersByTimeAsync(60);
    await jumpPromise;

    expect(isTextUnassignedOpen()).toBe(true);
    expect(setEditingTask).toHaveBeenCalledWith('task-3', false);
    expect(selectedTaskId()).toBeNull();
    vi.useRealTimers();
  });

  it('should ignore linked-task jumps for deleted or archived tasks', async () => {
    const selectedTaskId = signal<string | null>('task-1');
    const expandStage = vi.fn();
    const setEditingTask = vi.fn().mockResolvedValue(undefined);

    service.init({
      selectedTaskId,
      deleteConfirmTask: signal<Task | null>(null),
      deleteKeepChildren: signal(false),
      focusFlowNode: { emit: vi.fn() } as never,
      isMobile: signal(false),
      getStagesRef: () => ({ expandStage } as never),
      getUnassignedRef: () => ({ setEditingTask } as never),
    });

    mockProjectState.getTask.mockReturnValueOnce({ id: 'deleted-task', stage: 1, status: 'active', deletedAt: new Date().toISOString() } as Task);
    await service.onJumpToTask('deleted-task');

    mockProjectState.getTask.mockReturnValueOnce({ id: 'archived-task', stage: 2, status: 'archived', deletedAt: null } as Task);
    await service.onJumpToTask('archived-task');

    expect(expandStage).not.toHaveBeenCalled();
    expect(setEditingTask).not.toHaveBeenCalled();
    expect(selectedTaskId()).toBe('task-1');
  });
});
