import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as go from 'gojs';

import { FlowDiagramDataService } from './flow-diagram-data.service';
import { FlowDiagramConfigService } from './flow-diagram-config.service';
import { FlowZoomService } from './flow-zoom.service';
import { ProjectStateService } from '../../../../services/project-state.service';
import { UiStateService } from '../../../../services/ui-state.service';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
import { SyncCoordinatorService } from '../../../../services/sync-coordinator.service';
import { LoggerService } from '../../../../services/logger.service';
import { ToastService } from '../../../../services/toast.service';
import { DockEngineService } from '../../../../services/dock-engine.service';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import { Project, Task } from '../../../../models';

function createTask(overrides: Partial<Task> & Pick<Task, 'id' | 'title'>): Task {
  const now = '2026-06-01T00:00:00.000Z';
  return {
    id: overrides.id,
    title: overrides.title,
    content: overrides.content ?? '',
    stage: overrides.stage ?? 1,
    parentId: overrides.parentId ?? null,
    order: overrides.order ?? 1,
    rank: overrides.rank ?? 100,
    status: overrides.status ?? 'active',
    x: overrides.x ?? 0,
    y: overrides.y ?? 0,
    createdDate: overrides.createdDate ?? now,
    updatedAt: overrides.updatedAt ?? now,
    displayId: overrides.displayId ?? '1',
    attachments: overrides.attachments ?? [],
    tags: overrides.tags ?? [],
  } as Task;
}

describe('FlowDiagramDataService', () => {
  let service: FlowDiagramDataService;
  let buildDiagramData: ReturnType<typeof vi.fn>;

  const rootTask = createTask({ id: 'root-task', title: 'Root', stage: 1, displayId: '1' });
  const childTask = createTask({
    id: 'child-task',
    title: 'Child',
    stage: 2,
    parentId: 'root-task',
    displayId: '1,1',
  });
  const project: Project = {
    id: 'project-1',
    name: 'Route Project',
    description: '',
    createdDate: '2026-06-01T00:00:00.000Z',
    tasks: [rootTask, childTask],
    connections: [],
    viewState: { scale: 1, positionX: 0, positionY: 0 },
  };

  beforeEach(() => {
    buildDiagramData = vi.fn(() => ({
      nodeDataArray: [
        { key: 'root-task', stage: 1, status: 'active', parentId: null, loc: '0 0' },
        { key: 'child-task', stage: 2, status: 'active', parentId: 'root-task', loc: '150 0' },
      ],
      linkDataArray: [
        { key: 'root-task-child-task', from: 'root-task', to: 'child-task', isCrossTree: false, curviness: 20 },
      ],
    }));

    TestBed.configureTestingModule({
      providers: [
        FlowDiagramDataService,
        { provide: ProjectStateService, useValue: { activeProject: signal(project), getViewState: vi.fn(() => project.viewState) } },
        { provide: UiStateService, useValue: { searchQuery: signal(''), activeView: signal<'text' | 'flow'>('flow') } },
        { provide: TaskOperationAdapterService, useValue: { getLastUpdateType: vi.fn(() => 'data') } },
        { provide: SyncCoordinatorService, useValue: {} },
        { provide: LoggerService, useValue: { category: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) } },
        { provide: ToastService, useValue: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() } },
        { provide: DockEngineService, useValue: { dockedTaskIds: vi.fn(() => new Set<string>()), focusingEntry: vi.fn(() => null) } },
        { provide: FlowDiagramConfigService, useValue: { buildDiagramData } },
        { provide: FlowZoomService, useValue: { fitToContents: vi.fn() } },
        { provide: SentryLazyLoaderService, useValue: { captureException: vi.fn() } },
      ],
    });

    service = TestBed.inject(FlowDiagramDataService);
  });

  it('preserves existing keyed link points while refreshing route data', () => {
    const existingPoints = '0 0 40 20 80 0';
    const model = new go.GraphLinksModel(
      [
        { key: 'root-task', stage: 1, status: 'active', parentId: null, loc: '0 0' },
        { key: 'child-task', stage: 2, status: 'active', parentId: 'root-task', loc: '150 0' },
      ],
      [
        {
          key: 'root-task-child-task',
          from: 'root-task',
          to: 'child-task',
          isCrossTree: false,
          curviness: 20,
          points: existingPoints,
          fromPortId: '',
          toPortId: '',
        },
      ],
      {
        linkKeyProperty: 'key',
        nodeKeyProperty: 'key',
        linkFromPortIdProperty: 'fromPortId',
        linkToPortIdProperty: 'toPortId',
      },
    );
    const diagram = {
      model,
      selection: { each: vi.fn() },
      nodes: { each: vi.fn() },
      clearSelection: vi.fn(),
      startTransaction: vi.fn(),
      commitTransaction: vi.fn(),
      skipsUndoManager: false,
    } as unknown as go.Diagram;

    service.setDiagram(diagram);

    service.updateDiagram([rootTask, childTask], true);

    const refreshedLink = model.linkDataArray.find(link => link.key === 'root-task-child-task');
    expect(refreshedLink?.points).toBe(existingPoints);
    expect(refreshedLink?.curviness).toBe(20);
  });

  it('clears existing link points when endpoint locations change', () => {
    const existingPoints = '0 0 40 20 80 0';
    buildDiagramData.mockReturnValueOnce({
      nodeDataArray: [
        { key: 'root-task', stage: 1, status: 'active', parentId: null, loc: '32 0' },
        { key: 'child-task', stage: 2, status: 'active', parentId: 'root-task', loc: '150 0' },
      ],
      linkDataArray: [
        { key: 'root-task-child-task', from: 'root-task', to: 'child-task', isCrossTree: false, curviness: 20 },
      ],
    });
    const model = new go.GraphLinksModel(
      [
        { key: 'root-task', stage: 1, status: 'active', parentId: null, loc: '0 0' },
        { key: 'child-task', stage: 2, status: 'active', parentId: 'root-task', loc: '150 0' },
      ],
      [
        {
          key: 'root-task-child-task',
          from: 'root-task',
          to: 'child-task',
          isCrossTree: false,
          curviness: 20,
          points: existingPoints,
          fromPortId: '',
          toPortId: '',
        },
      ],
      {
        linkKeyProperty: 'key',
        nodeKeyProperty: 'key',
        linkFromPortIdProperty: 'fromPortId',
        linkToPortIdProperty: 'toPortId',
      },
    );
    const diagram = {
      model,
      selection: { each: vi.fn() },
      nodes: { each: vi.fn() },
      clearSelection: vi.fn(),
      startTransaction: vi.fn(),
      commitTransaction: vi.fn(),
      skipsUndoManager: false,
    } as unknown as go.Diagram;

    service.setDiagram(diagram);

    service.updateDiagram([rootTask, childTask], true);

    const refreshedLink = model.linkDataArray.find(link => link.key === 'root-task-child-task');
    expect(refreshedLink?.points).toBeUndefined();
    expect(refreshedLink?.curviness).toBe(20);
  });
});