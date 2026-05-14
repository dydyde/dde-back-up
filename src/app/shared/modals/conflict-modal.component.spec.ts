import { Component, EventEmitter, Input, Output, ViewChild } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { Project, Task } from '../../../models';
import {
  ConflictAutoResolverService,
  type AutoResolutionReport,
} from '../../../services/conflict-auto-resolver.service';
import { ConflictTaskDiffComponent } from '../components/conflict-task-diff.component';
import { ConflictModalComponent } from './conflict-modal.component';
import { type ConflictResolutionPlan } from '../../../services/conflict-resolution.types';

@Component({
  selector: 'app-conflict-task-diff',
  standalone: true,
  template: '',
})
class ConflictTaskDiffStubComponent {
  @Input() localTasks: Task[] = [];
  @Input() remoteTasks: Task[] = [];
  @Input() selectable = false;
  @Input() recommendations = [];
  @Output() selectionChange = new EventEmitter<Map<string, 'local' | 'remote'>>();
}

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    title: overrides.title ?? 'Task',
    content: overrides.content ?? '',
    stage: overrides.stage ?? 1,
    parentId: overrides.parentId ?? null,
    order: overrides.order ?? 1,
    rank: overrides.rank ?? 1000,
    status: overrides.status ?? 'active',
    x: overrides.x ?? 0,
    y: overrides.y ?? 0,
    createdDate: overrides.createdDate ?? '2026-05-13T10:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-05-13T10:00:00.000Z',
    displayId: overrides.displayId ?? 'A',
    hasIncompleteTask: overrides.hasIncompleteTask ?? false,
    ...overrides,
  };
}

function createProject(id: string, name: string, updatedAt: string, tasks: Task[]): Project {
  return {
    id,
    name,
    description: '',
    createdDate: '2026-05-13T09:00:00.000Z',
    tasks,
    connections: [],
    updatedAt,
    version: 1,
  };
}

function createAutoReport(): AutoResolutionReport {
  return {
    projectId: 'project-1',
    recommendations: [
      {
        taskId: 'task-1',
        title: '新任务',
        recommendation: 'local',
        confidence: 'auto',
        reason: '本地版本更新较新',
        reasoning: ['本地 updatedAt 晚于云端'],
        localTime: '2026-05-13T10:22:00.000Z',
        remoteTime: '2026-05-12T20:20:00.000Z',
        conflictedFields: ['content'],
      },
    ],
    autoCount: 1,
    suggestCount: 0,
    manualCount: 0,
    generatedAt: '2026-05-13T10:23:00.000Z',
    overallSuggestion: '建议保留本地版本',
  };
}

function getByTestId<T extends HTMLElement>(fixture: ComponentFixture<unknown>, testId: string): T {
  const element = fixture.nativeElement.querySelector(`[data-testid="${testId}"]`) as T | null;
  expect(element).not.toBeNull();
  return element as T;
}

describe('ConflictModalComponent', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;
  const mockAutoResolver = {
    analyze: vi.fn(() => createAutoReport()),
  };

  beforeEach(async () => {
    mockAutoResolver.analyze.mockReturnValue(createAutoReport());

    TestBed.overrideComponent(ConflictModalComponent, {
      remove: { imports: [ConflictTaskDiffComponent] },
      add: { imports: [ConflictTaskDiffStubComponent] },
    });

    await TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [
        { provide: ConflictAutoResolverService, useValue: mockAutoResolver },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;

    const localTask = createTask({
      id: 'task-1',
      title: '新任务',
      content: '本地内容',
      updatedAt: '2026-05-13T10:22:00.000Z',
    });
    const remoteTask = createTask({
      id: 'task-1',
      title: '新任务',
      content: '云端内容',
      updatedAt: '2026-05-12T20:20:00.000Z',
    });

    host.conflictData = {
      projectId: 'project-1',
      localProject: createProject('project-1', '蚯蚓养殖', '2026-05-13T10:22:00.000Z', [localTask]),
      remoteProject: createProject('project-1', '蚯蚓养殖', '2026-05-12T20:20:00.000Z', [remoteTask]),
    };
    fixture.detectChanges();
  });

  it('should toggle selective mode and emit primary action outputs on click', () => {
    const resolveLocalSpy = vi.fn();
    const resolveRemoteSpy = vi.fn();
    const resolveMergeSpy = vi.fn();
    const cancelSpy = vi.fn();

    host.resolveLocal.subscribe(resolveLocalSpy);
    host.resolveRemote.subscribe(resolveRemoteSpy);
    host.resolveMerge.subscribe(resolveMergeSpy);
    host.cancel.subscribe(cancelSpy);

    getByTestId<HTMLButtonElement>(fixture, 'conflict-selective-toggle').click();
    fixture.detectChanges();

    expect(host.modal.selectiveMode()).toBe(true);
    expect(getByTestId<HTMLButtonElement>(fixture, 'conflict-selective-toggle').textContent).toContain('逐任务选择模式');

    getByTestId<HTMLButtonElement>(fixture, 'conflict-resolve-local').click();
    getByTestId<HTMLButtonElement>(fixture, 'conflict-resolve-remote').click();
    getByTestId<HTMLButtonElement>(fixture, 'conflict-merge').click();
    getByTestId<HTMLButtonElement>(fixture, 'conflict-cancel').click();

    expect(resolveLocalSpy).toHaveBeenCalledOnce();
    expect(resolveRemoteSpy).toHaveBeenCalledOnce();
    expect(resolveMergeSpy).toHaveBeenCalledOnce();
    expect(cancelSpy).toHaveBeenCalledOnce();
  });

  it('should emit a resolution plan when applying suggested resolution', () => {
    const applyPlanSpy = vi.fn();
    host.applyPlan.subscribe(applyPlanSpy);

    getByTestId<HTMLButtonElement>(fixture, 'conflict-apply-suggested').click();

    expect(applyPlanSpy).toHaveBeenCalledWith({
      taskChoices: { 'task-1': 'local' },
      appliedBy: 'system',
    });
  });

  it('should show a busy hint and disable actions while resolving', () => {
    host.isResolving = true;
    host.activeResolution = 'local';
    fixture.detectChanges();

    expect(getByTestId<HTMLButtonElement>(fixture, 'conflict-resolve-local').disabled).toBe(true);
    expect(getByTestId<HTMLButtonElement>(fixture, 'conflict-resolve-remote').disabled).toBe(true);
    expect(getByTestId<HTMLButtonElement>(fixture, 'conflict-cancel').disabled).toBe(true);
    expect(fixture.nativeElement.textContent).toContain('正在保留本地修改并覆盖云端');
  });

  it('should emit cancel when Escape is pressed (when not resolving)', () => {
    const cancelSpy = vi.fn();
    host.cancel.subscribe(cancelSpy);

    const target = getByTestId<HTMLButtonElement>(fixture, 'conflict-resolve-local');
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(cancelSpy).toHaveBeenCalledOnce();
  });

  it('should ignore Escape while resolving', () => {
    const cancelSpy = vi.fn();
    host.cancel.subscribe(cancelSpy);

    host.isResolving = true;
    fixture.detectChanges();

    const target = getByTestId<HTMLButtonElement>(fixture, 'conflict-resolve-local');
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(cancelSpy).not.toHaveBeenCalled();
  });
});

@Component({
  standalone: true,
  imports: [ConflictModalComponent],
  template: `
    <app-conflict-modal
      [conflictData]="conflictData"
      [isResolving]="isResolving"
      [activeResolution]="activeResolution"
      (resolveLocal)="resolveLocal.emit()"
      (resolveRemote)="resolveRemote.emit()"
      (resolveMerge)="resolveMerge.emit()"
      (applyPlan)="applyPlan.emit($event)"
      (cancel)="cancel.emit()" />`,
})
class HostComponent {
  conflictData: { localProject: Project; remoteProject: Project; projectId: string } | null = null;
  isResolving = false;
  activeResolution: 'local' | 'remote' | 'merge' | 'plan' | null = null;

  @Output() resolveLocal = new EventEmitter<void>();
  @Output() resolveRemote = new EventEmitter<void>();
  @Output() resolveMerge = new EventEmitter<void>();
  @Output() applyPlan = new EventEmitter<ConflictResolutionPlan>();
  @Output() cancel = new EventEmitter<void>();

  @ViewChild(ConflictModalComponent) modal!: ConflictModalComponent;
}
