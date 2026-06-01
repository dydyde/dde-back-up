import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TextStagesComponent } from './text-stages.component';
import { UiStateService } from '../../../../services/ui-state.service';
import { ProjectStateService } from '../../../../services/project-state.service';
import { LoggerService } from '../../../../services/logger.service';
import type { Task } from '../../../../models';
import type { StageData } from './text-view.types';

describe('TextStagesComponent', () => {
  let fixture: ComponentFixture<TextStagesComponent>;

  const stages = signal<StageData[]>([]);
  const stageFilter = signal<'all' | number>('all');
  const rootFilter = signal('all');

  const mockUiState = {
    stageFilter,
    stageViewRootFilter: rootFilter,
    setStageFilter: vi.fn((value: 'all' | number) => stageFilter.set(value)),
  };

  const mockProjectState = {
    stages,
    activeProjectId: signal('project-1'),
    getTask: vi.fn(() => null),
    allStage1Tasks: signal([]),
  };

  const mockLogger = {
    warn: vi.fn(),
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

  beforeEach(async () => {
    vi.clearAllMocks();
    stageFilter.set('all');
    rootFilter.set('all');
    stages.set([]);

    await TestBed.configureTestingModule({
      imports: [TextStagesComponent],
      providers: [
        { provide: UiStateService, useValue: mockUiState },
        { provide: ProjectStateService, useValue: mockProjectState },
        { provide: LoggerService, useValue: mockLogger },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(TextStagesComponent);
    fixture.detectChanges();
  });

  it('should keep the host in the flex layout so stage expansion stays inside the text pane', () => {
    const host = fixture.nativeElement as HTMLElement;

    expect(host.classList.contains('flex')).toBe(true);
    expect(host.classList.contains('flex-1')).toBe(true);
    expect(host.classList.contains('min-h-0')).toBe(true);
    expect(host.classList.contains('min-w-0')).toBe(true);

    const section = host.querySelector('section');
    expect(section?.classList.contains('overflow-hidden')).toBe(true);

    const stageList = host.querySelector('[data-stage-scroll-container]');
    expect(stageList).not.toBeNull();
    expect(stageList?.classList.contains('overflow-auto')).toBe(true);
    expect(stageList?.classList.contains('stage-scroll-container')).toBe(true);
  });

  it('should declare the forwarded linked-task payload as taskId plus event', () => {
    const source = readFileSync(resolve(__dirname, 'text-stages.component.ts'), 'utf8');

    expect(source).toContain("@Output() openLinkedTask = new EventEmitter<{ taskId: string; event: Event }>();");
  });

  it('should label the add button as stage-one recovery when visible stages start after 1', () => {
    stages.set([
      { stageNumber: 2, tasks: [createTask({ id: 'stage-2-root', stage: 2 })] },
    ]);

    expect(fixture.componentInstance.addStageLabel()).toBe('+ 补回阶段 1');
  });

  it('should keep the normal add label when only archived later stages exist', () => {
    stages.set([
      { stageNumber: 2, tasks: [createTask({ id: 'archived-stage-2', stage: 2, status: 'archived' })] },
    ]);

    expect(fixture.componentInstance.addStageLabel()).toBe('+ 新阶段');
  });
});
