import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TextUnassignedComponent } from './text-unassigned.component';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
import { ToastService } from '../../../../services/toast.service';
import { UiStateService } from '../../../../services/ui-state.service';
import { ProjectStateService } from '../../../../services/project-state.service';
import { ParkingService } from '../../../../services/parking.service';
import { DockEngineService } from '../../../../services/dock-engine.service';
import { SimpleReminderService } from '../../../../services/simple-reminder.service';
import { UserSessionService } from '../../../../services/user-session.service';
import type { Task } from '../../../../models';

describe('TextUnassignedComponent', () => {
  let fixture: ComponentFixture<TextUnassignedComponent>;
  let component: TextUnassignedComponent;

  const createTask = (overrides: Partial<Task> = {}): Task => ({
    id: 'task-1',
    title: '原始标题',
    content: '',
    status: 'active',
    stage: null,
    order: 0,
    parentId: null,
    rank: 0,
    x: 0,
    y: 0,
    createdDate: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    displayId: '1,a',
    attachments: [],
    tags: [],
    parkingMeta: null,
    ...overrides,
  });

  const tasks = signal<Task[]>([]);
  const mockTaskAdapter = {
    updateTaskTitle: vi.fn(),
    updateTaskContent: vi.fn(),
    deleteTask: vi.fn(),
    moveTaskToStage: vi.fn(() => ({ ok: true })),
  };
  const mockUiState = {
    isTextSidebarVisible: signal(true),
    isTextUnassignedOpen: signal(true),
    toggleTextUnassignedOpen: vi.fn(),
    setTextUnassignedOpen: vi.fn((open: boolean) => mockUiState.isTextUnassignedOpen.set(open)),
    hasTextUnassignedOpenPreference: vi.fn(() => true),
  };
  const mockProjectState = {
    unassignedTasks: tasks,
    getTask: vi.fn((taskId: string) => tasks().find(task => task.id === taskId) ?? null),
  };
  const mockParkingService = {
    parkTask: vi.fn(),
  };
  const mockDockEngine = {
    dockTask: vi.fn(() => true),
  };
  const mockReminderService = {
    setReminder: vi.fn(),
    cancelReminder: vi.fn(),
  };
  const mockToast = {
    info: vi.fn(),
    warning: vi.fn(),
  };
  const mockUserSession = {
    isHintOnlyStartupPlaceholderVisible: vi.fn(() => false),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    tasks.set([createTask()]);
    mockUiState.isTextSidebarVisible.set(true);
    mockUiState.isTextUnassignedOpen.set(true);
    mockUiState.toggleTextUnassignedOpen.mockImplementation(() => {
      mockUiState.isTextUnassignedOpen.set(!mockUiState.isTextUnassignedOpen());
    });
    mockUiState.setTextUnassignedOpen.mockImplementation((open: boolean) => {
      mockUiState.isTextUnassignedOpen.set(open);
    });
    mockUiState.hasTextUnassignedOpenPreference.mockReturnValue(true);
    mockUserSession.isHintOnlyStartupPlaceholderVisible.mockReturnValue(false);
    mockProjectState.getTask.mockImplementation((taskId: string) => tasks().find(task => task.id === taskId) ?? null);

    await TestBed.configureTestingModule({
      imports: [TextUnassignedComponent],
      providers: [
        { provide: TaskOperationAdapterService, useValue: mockTaskAdapter },
        { provide: UiStateService, useValue: mockUiState },
        { provide: ProjectStateService, useValue: mockProjectState },
        { provide: ParkingService, useValue: mockParkingService },
        { provide: DockEngineService, useValue: mockDockEngine },
        { provide: SimpleReminderService, useValue: mockReminderService },
        { provide: ToastService, useValue: mockToast },
        { provide: UserSessionService, useValue: mockUserSession },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(TextUnassignedComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('parkTaskNow should persist draft edits before parking and sync the dock', () => {
    const task = tasks()[0]!;
    const internal = component as unknown as {
      editingTaskId: { set: (value: string | null) => void; (): string | null };
      isEditMode: { set: (value: boolean) => void; (): boolean };
      localTitle: { set: (value: string) => void };
      localContent: { set: (value: string) => void };
      reminderMenuTaskId: { set: (value: string | null) => void; (): string | null };
    };

    internal.editingTaskId.set(task.id);
    internal.isEditMode.set(true);
    internal.localTitle.set('停泊前标题');
    internal.localContent.set('停泊前正文');
    internal.reminderMenuTaskId.set(task.id);
    fixture.detectChanges();

    const parkButton = fixture.nativeElement.querySelector('[data-testid="text-unassigned-park-button"]') as HTMLButtonElement | null;
    parkButton?.click();

    expect(mockTaskAdapter.updateTaskTitle).toHaveBeenCalledWith(task.id, '停泊前标题');
    expect(mockTaskAdapter.updateTaskContent).toHaveBeenCalledWith(task.id, '停泊前正文');
    expect(mockParkingService.parkTask).toHaveBeenCalledWith(task.id);
    expect(mockDockEngine.dockTask).toHaveBeenCalledWith(task.id, undefined, {
      sourceSection: 'text',
      zoneSource: 'auto',
    });
    expect(internal.editingTaskId()).toBeNull();
    expect(internal.isEditMode()).toBe(false);
    expect(internal.reminderMenuTaskId()).toBeNull();
  });

  it('should disable the park button when the task is already parked', () => {
    tasks.set([
      createTask({
        parkingMeta: {
          state: 'parked',
          parkedAt: new Date().toISOString(),
          lastVisitedAt: new Date().toISOString(),
          contextSnapshot: null,
          reminder: null,
          pinned: false,
        },
      }),
    ]);
    const task = tasks()[0]!;
    const internal = component as unknown as {
      editingTaskId: { set: (value: string | null) => void };
      isEditMode: { set: (value: boolean) => void };
    };
    internal.editingTaskId.set(task.id);
    internal.isEditMode.set(true);
    fixture.detectChanges();

    const parkButton = fixture.nativeElement.querySelector('[data-testid="text-unassigned-park-button"]') as HTMLButtonElement | null;
    expect(parkButton?.disabled).toBe(true);
  });

  it('should preserve the unassigned panel preference when task count changes', () => {
    mockUiState.isTextUnassignedOpen.set(true);
    tasks.set([]);
    fixture.detectChanges();

    expect(mockUiState.isTextUnassignedOpen()).toBe(true);
    expect(fixture.nativeElement.textContent).toContain('无待分配任务');

    mockUiState.isTextUnassignedOpen.set(false);

    tasks.set([createTask({ id: 'restored-task' })]);
    fixture.detectChanges();

    expect(mockUiState.isTextUnassignedOpen()).toBe(false);
    expect(fixture.nativeElement.querySelector('[data-unassigned-task="restored-task"]')).toBeNull();
  });

  it('should open the unassigned panel for creation without storing a panel preference', () => {
    const internal = component as unknown as {
      createUnassigned: { emit: () => void };
    };
    const emitSpy = vi.spyOn(internal.createUnassigned, 'emit');
    mockUiState.isTextUnassignedOpen.set(false);
    fixture.detectChanges();

    const createButton = fixture.nativeElement.querySelector('[data-testid="add-task-btn"]') as HTMLButtonElement | null;
    createButton?.click();

    expect(mockUiState.isTextUnassignedOpen()).toBe(true);
    expect(mockUiState.setTextUnassignedOpen).not.toHaveBeenCalled();
    expect(mockUiState.toggleTextUnassignedOpen).not.toHaveBeenCalled();
    expect(emitSpy).toHaveBeenCalledOnce();
  });

  it('should block parking while hint-only startup placeholder is read-only', () => {
    mockUserSession.isHintOnlyStartupPlaceholderVisible.mockReturnValue(true);

    (component as unknown as {
      parkTaskNow: (task: Task) => void;
    }).parkTaskNow(tasks()[0]!);

    expect(mockParkingService.parkTask).not.toHaveBeenCalled();
    expect(mockDockEngine.dockTask).not.toHaveBeenCalled();
    expect(mockToast.info).toHaveBeenCalledWith('会话确认中', '停泊任务暂不可用，owner 确认完成前保持只读');
  });

  it('should block reminder changes while hint-only startup placeholder is read-only', () => {
    mockUserSession.isHintOnlyStartupPlaceholderVisible.mockReturnValue(true);

    (component as unknown as {
      setReminderPreset: (taskId: string, minutes: number) => void;
    }).setReminderPreset('task-1', 5);

    expect(mockReminderService.setReminder).not.toHaveBeenCalled();
    expect(mockToast.info).toHaveBeenCalledWith('会话确认中', '设置提醒暂不可用，owner 确认完成前保持只读');
  });

  it('should block entering edit mode while hint-only startup placeholder is read-only', () => {
    mockUserSession.isHintOnlyStartupPlaceholderVisible.mockReturnValue(true);

    (component as unknown as {
      enterEdit: (task: Task) => void;
      editingTaskId: { (): string | null };
      isEditMode: { (): boolean };
    }).enterEdit(tasks()[0]!);

    const internal = component as unknown as {
      editingTaskId: { (): string | null };
      isEditMode: { (): boolean };
    };
    expect(internal.editingTaskId()).toBeNull();
    expect(internal.isEditMode()).toBe(false);
    expect(mockToast.info).toHaveBeenCalledWith('会话确认中', '编辑任务暂不可用，owner 确认完成前保持只读');
  });

  it('should keep local draft visible when save is blocked by hint-only startup placeholder', () => {
    mockUserSession.isHintOnlyStartupPlaceholderVisible.mockReturnValue(true);

    const internal = component as unknown as {
      saveTask: (task: Task) => void;
      editingTaskId: { set: (value: string | null) => void; (): string | null };
      isEditMode: { set: (value: boolean) => void; (): boolean };
      localTitle: { set: (value: string) => void; (): string };
      localContent: { set: (value: string) => void; (): string };
    };

    internal.editingTaskId.set('task-1');
    internal.isEditMode.set(true);
    internal.localTitle.set('未保存标题');
    internal.localContent.set('未保存正文');

    internal.saveTask(tasks()[0]!);

    expect(mockTaskAdapter.updateTaskTitle).not.toHaveBeenCalled();
    expect(mockTaskAdapter.updateTaskContent).not.toHaveBeenCalled();
    expect(internal.editingTaskId()).toBe('task-1');
    expect(internal.isEditMode()).toBe(true);
    expect(internal.localTitle()).toBe('未保存标题');
    expect(internal.localContent()).toBe('未保存正文');
    expect(mockToast.info).toHaveBeenCalledWith('会话确认中', '编辑任务暂不可用，owner 确认完成前保持只读');
  });

  it('should emit openLinkedTask when clicking a task markdown link in preview', () => {
    const internal = component as unknown as {
      onContentPreviewClick: (event: MouseEvent, task: Task) => void;
      editingTaskId: { (): string | null };
      openLinkedTask: { emit: ReturnType<typeof vi.fn> };
    };
    const emitSpy = vi.spyOn(internal.openLinkedTask, 'emit');
    const anchor = document.createElement('a');
    anchor.setAttribute('href', '#task:linked-task');
    anchor.setAttribute('data-link-kind', 'task');
    anchor.setAttribute('data-task-link-id', 'linked-task');
    const stopPropagation = vi.fn();
    const preventDefault = vi.fn();
    const event = { target: anchor, stopPropagation, preventDefault } as unknown as MouseEvent;

    internal.onContentPreviewClick(event, tasks()[0]!);

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(emitSpy).toHaveBeenCalledWith({ taskId: 'linked-task', event });
    expect(internal.editingTaskId()).toBeNull();
  });

  it('should keep preview mode when clicking an external markdown link in preview', () => {
    const internal = component as unknown as {
      onContentPreviewClick: (event: MouseEvent, task: Task) => void;
      editingTaskId: { (): string | null };
    };
    const anchor = document.createElement('a');
    anchor.setAttribute('href', 'https://example.com');
    anchor.setAttribute('data-link-kind', 'external');
    const stopPropagation = vi.fn();
    const preventDefault = vi.fn();

    internal.onContentPreviewClick({ target: anchor, stopPropagation, preventDefault } as unknown as MouseEvent, tasks()[0]!);

    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(internal.editingTaskId()).toBeNull();
  });

  it('should block unsafe markdown links without entering edit mode', () => {
    const internal = component as unknown as {
      onContentPreviewClick: (event: MouseEvent, task: Task) => void;
      editingTaskId: { (): string | null };
      openLinkedTask: { emit: ReturnType<typeof vi.fn> };
    };
    const emitSpy = vi.spyOn(internal.openLinkedTask, 'emit');
    const anchor = document.createElement('a');
    anchor.setAttribute('href', '#__nf_blocked__');
    anchor.setAttribute('data-link-kind', 'blocked');
    const stopPropagation = vi.fn();
    const preventDefault = vi.fn();

    internal.onContentPreviewClick({ target: anchor, stopPropagation, preventDefault } as unknown as MouseEvent, tasks()[0]!);

    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(emitSpy).not.toHaveBeenCalled();
    expect(internal.editingTaskId()).toBeNull();
  });

  it('should handle local markdown links without entering edit mode', async () => {
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const writeText = vi.fn().mockResolvedValue(undefined);
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    try {
      const internal = component as unknown as {
        onContentPreviewClick: (event: MouseEvent, task: Task) => void;
        editingTaskId: { (): string | null };
      };
      const anchor = document.createElement('a');
      anchor.setAttribute('href', '#local-path');
      anchor.setAttribute('data-link-kind', 'local');
      anchor.setAttribute('data-local-link-path', 'C:\\Docs\\Plan.md');
      const stopPropagation = vi.fn();
      const preventDefault = vi.fn();

      internal.onContentPreviewClick({ target: anchor, stopPropagation, preventDefault } as unknown as MouseEvent, tasks()[0]!);
      await Promise.resolve();

      expect(stopPropagation).toHaveBeenCalledTimes(1);
      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(internal.editingTaskId()).toBeNull();
      expect(writeText).toHaveBeenCalledWith('C:\\Docs\\Plan.md');
      expect(clickSpy).toHaveBeenCalled();
    } finally {
      clickSpy.mockRestore();
      if (originalClipboard) {
        Object.defineProperty(navigator, 'clipboard', originalClipboard);
      } else {
        Reflect.deleteProperty(navigator as object, 'clipboard');
      }
    }
  });
});
