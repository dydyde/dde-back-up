import { Injector } from '@angular/core';
import * as go from 'gojs';
import { beforeEach, describe, expect, it } from 'vitest';
import { getFlowStyles } from '../../../../config/flow-styles';
import { LineageColorService } from '../../../../services/lineage-color.service';
import { ThemeService } from '../../../../services/theme.service';
import { Connection, Project, Task } from '../../../../models';
import { ExternalSourceLinkService } from '../../../core/external-sources/external-source-link.service';
import type { ExternalSourceLink } from '../../../core/external-sources/external-source.model';
import { FlowDiagramConfigService } from './flow-diagram-config.service';

function createTask(overrides: Partial<Task> & Pick<Task, 'id' | 'title'>): Task {
  const now = new Date().toISOString();
  return {
    id: overrides.id,
    title: overrides.title,
    content: overrides.content ?? '',
    stage: Object.prototype.hasOwnProperty.call(overrides, 'stage')
      ? (overrides.stage ?? null)
      : 1,
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

function createProject(tasks: Task[], connections: Connection[] = []): Project {
  const now = new Date().toISOString();
  return {
    id: 'project-1',
    name: 'Test Project',
    description: '',
    createdDate: now,
    tasks,
    connections,
  };
}

function expectEmbeddedCrossTreeLinks(linkDataArray: go.ObjectData[], expectedCount: number): void {
  const crossTreeLinks = linkDataArray.filter(link => link.isCrossTree);
  expect(crossTreeLinks).toHaveLength(expectedCount);
  expect(crossTreeLinks.every(link => link.labelSegmentOffsetY === 0)).toBe(true);

  const fractions = crossTreeLinks.map(link => link.labelSegmentFraction);
  expect(new Set(fractions).size).toBe(expectedCount);
  expect(fractions.every((fraction): fraction is number => typeof fraction === 'number' && fraction > 0 && fraction < 1)).toBe(true);
}

describe('FlowDiagramConfigService', () => {
  let service: FlowDiagramConfigService;
  let lineageColorService: LineageColorService;
  let activeLinksByTask = new Map<string, ExternalSourceLink[]>();

  beforeEach(() => {
    activeLinksByTask = new Map<string, ExternalSourceLink[]>();
    const injector = Injector.create({
      providers: [
        { provide: FlowDiagramConfigService, useClass: FlowDiagramConfigService },
        { provide: LineageColorService, useClass: LineageColorService },
        {
          provide: ExternalSourceLinkService,
          useValue: {
            activeLinksForTask: (taskId: string) => activeLinksByTask.get(taskId) ?? [],
            firstActiveLinkForTask: (taskId: string) => (activeLinksByTask.get(taskId) ?? [])[0] ?? null,
          },
        },
        {
          provide: ThemeService,
          useValue: {
            theme: () => 'default',
            isDark: () => false,
          },
        },
      ],
    });

    service = injector.get(FlowDiagramConfigService);
    lineageColorService = injector.get(LineageColorService);
  });

  it('uses a darker family color for assigned displayId cues', () => {
    const task = createTask({ id: 'root-task', title: 'Root Task', stage: 1, displayId: '1' });
    const result = service.buildDiagramData(
      [task],
      createProject([task]),
      '',
      new Map<string, go.ObjectData>(),
      { dockedTaskIds: new Set<string>(), focusedTaskId: null },
    );

    const node = result.nodeDataArray[0];
    expect(node.displayIdColor).toBe(lineageColorService.getDarkerFamilyColor(node.familyColor!));
  });

  it('keeps the default displayId color for search matches and unassigned nodes', () => {
    const searchTask = createTask({ id: 'search-task', title: 'Alpha root', stage: 1, displayId: '1' });
    const unassignedTask = createTask({ id: 'floating-task', title: 'Floating', stage: null, displayId: '?' });
    const styles = getFlowStyles('default', 'light');
    const result = service.buildDiagramData(
      [searchTask, unassignedTask],
      createProject([searchTask, unassignedTask]),
      'alpha',
      new Map<string, go.ObjectData>(),
      { dockedTaskIds: new Set<string>(), focusedTaskId: null },
    );

    const searchNode = result.nodeDataArray.find(node => node.key === 'search-task');
    const unassignedNode = result.nodeDataArray.find(node => node.key === 'floating-task');

    expect(searchNode?.isSearchMatch).toBe(true);
    expect(searchNode?.displayIdColor).toBe(styles.text.displayIdColor);
    expect(unassignedNode?.isUnassigned).toBe(true);
    expect(unassignedNode?.displayIdColor).toBe(styles.text.displayIdColor);
  });

  it('falls back to a visible placeholder when an assigned task has no displayId yet', () => {
    const task = createTask({ id: 'missing-display-id', title: 'Missing Number', stage: 1, displayId: '' });
    const result = service.buildDiagramData(
      [task],
      createProject([task]),
      '',
      new Map<string, go.ObjectData>(),
      { dockedTaskIds: new Set<string>(), focusedTaskId: null },
    );

    expect(result.nodeDataArray[0]?.displayId).toBe('?');
    expect(result.nodeDataArray[0]?.parentId).toBeNull();
    expect(result.nodeDataArray[0]?.status).toBe('active');
  });

  it('keeps cross-tree relation blocks embedded by staggering repeated stage-boundary links along the line', () => {
    const tasks = [
      createTask({ id: 'left-a', title: 'Left A', stage: 1, displayId: '1' }),
      createTask({ id: 'left-b', title: 'Left B', stage: 1, displayId: '2' }),
      createTask({ id: 'right-a', title: 'Right A', stage: 2, displayId: '3' }),
      createTask({ id: 'right-b', title: 'Right B', stage: 2, displayId: '4' }),
    ];
    const connections: Connection[] = [
      { id: 'conn-a', source: 'left-a', target: 'right-a', title: 'A->A' },
      { id: 'conn-b', source: 'left-b', target: 'right-b', title: 'B->B' },
    ];

    const result = service.buildDiagramData(
      tasks,
      createProject(tasks, connections),
      '',
      new Map<string, go.ObjectData>(),
      { dockedTaskIds: new Set<string>(), focusedTaskId: null },
    );

    expectEmbeddedCrossTreeLinks(result.linkDataArray, 2);
    const fractions = result.linkDataArray
      .filter(link => link.isCrossTree)
      .map(link => link.labelSegmentFraction as number);
    expect(fractions.every(fraction => fraction > 0.5)).toBe(true);
  });

  it('places a single cross-tree relation block near the target-side third of the line', () => {
    const tasks = [
      createTask({ id: 'source-task', title: 'Source', stage: 1, displayId: '1' }),
      createTask({ id: 'target-task', title: 'Target', stage: 2, displayId: '2' }),
    ];
    const connections: Connection[] = [
      { id: 'target-side-conn', source: 'source-task', target: 'target-task', title: 'Near Target' },
    ];

    const result = service.buildDiagramData(
      tasks,
      createProject(tasks, connections),
      '',
      new Map<string, go.ObjectData>(),
      { dockedTaskIds: new Set<string>(), focusedTaskId: null },
    );

    const crossTreeLink = result.linkDataArray.find(link => link.isCrossTree);
    expect(crossTreeLink?.labelSegmentFraction).toBeCloseTo(2 / 3, 6);
    expect(crossTreeLink?.labelSegmentOffsetY).toBe(0);
  });

  it('keeps reverse cross-tree relation blocks near the target side instead of the stage midpoint', () => {
    const tasks = [
      createTask({ id: 'late-source', title: 'Late Source', stage: 3, displayId: '1' }),
      createTask({ id: 'early-target', title: 'Early Target', stage: 1, displayId: '2' }),
    ];
    const connections: Connection[] = [
      { id: 'reverse-conn', source: 'late-source', target: 'early-target', title: 'Reverse' },
    ];

    const result = service.buildDiagramData(
      tasks,
      createProject(tasks, connections),
      '',
      new Map<string, go.ObjectData>(),
      { dockedTaskIds: new Set<string>(), focusedTaskId: null },
    );

    const crossTreeLink = result.linkDataArray.find(link => link.isCrossTree);
    expect(crossTreeLink?.labelSegmentFraction).toBeCloseTo(2 / 3, 6);
  });

  it('keeps same-stage cross-tree relation blocks embedded by spreading them along the link instead of lifting them away', () => {
    const tasks = [
      createTask({ id: 'same-a', title: 'Same A', stage: 2, displayId: '1' }),
      createTask({ id: 'same-b', title: 'Same B', stage: 2, displayId: '2' }),
      createTask({ id: 'same-c', title: 'Same C', stage: 2, displayId: '3' }),
      createTask({ id: 'same-d', title: 'Same D', stage: 2, displayId: '4' }),
    ];
    const connections: Connection[] = [
      { id: 'same-conn-a', source: 'same-a', target: 'same-c', title: 'A->C' },
      { id: 'same-conn-b', source: 'same-b', target: 'same-d', title: 'B->D' },
    ];

    const result = service.buildDiagramData(
      tasks,
      createProject(tasks, connections),
      '',
      new Map<string, go.ObjectData>(),
      { dockedTaskIds: new Set<string>(), focusedTaskId: null },
    );

    expectEmbeddedCrossTreeLinks(result.linkDataArray, 2);
  });

  it('keeps dense stage-boundary relation blocks unique without lifting them away from the link', () => {
    const tasks = Array.from({ length: 8 }, (_, index) => [
      createTask({ id: `left-${index}`, title: `Left ${index}`, stage: 1, displayId: `${index + 1}` }),
      createTask({ id: `right-${index}`, title: `Right ${index}`, stage: 2, displayId: `${index + 9}` }),
    ]).flat();
    const connections: Connection[] = Array.from({ length: 8 }, (_, index) => ({
      id: `dense-boundary-${index}`,
      source: `left-${index}`,
      target: `right-${index}`,
      title: `Dense ${index}`,
    }));

    const result = service.buildDiagramData(
      tasks,
      createProject(tasks, connections),
      '',
      new Map<string, go.ObjectData>(),
      { dockedTaskIds: new Set<string>(), focusedTaskId: null },
    );

    expectEmbeddedCrossTreeLinks(result.linkDataArray, 8);
  });

  it('keeps dense same-stage relation blocks unique without lifting them away from the link', () => {
    const tasks = Array.from({ length: 6 }, (_, index) => [
      createTask({ id: `same-source-${index}`, title: `Same Source ${index}`, stage: 2, displayId: `${index + 1}` }),
      createTask({ id: `same-target-${index}`, title: `Same Target ${index}`, stage: 2, displayId: `${index + 7}` }),
    ]).flat();
    const connections: Connection[] = Array.from({ length: 6 }, (_, index) => ({
      id: `dense-same-${index}`,
      source: `same-source-${index}`,
      target: `same-target-${index}`,
      title: `Same ${index}`,
    }));

    const result = service.buildDiagramData(
      tasks,
      createProject(tasks, connections),
      '',
      new Map<string, go.ObjectData>(),
      { dockedTaskIds: new Set<string>(), focusedTaskId: null },
    );

    expectEmbeddedCrossTreeLinks(result.linkDataArray, 6);
  });

  it('keeps link route inputs stable when task and connection arrays are rehydrated in a different order', () => {
    const tasks = [
      createTask({ id: 'root-a', title: 'Root A', stage: 1, rank: 10, displayId: '1' }),
      createTask({ id: 'child-a', title: 'Child A', stage: 2, parentId: 'root-a', rank: 20, displayId: '1,1' }),
      createTask({ id: 'root-b', title: 'Root B', stage: 1, rank: 30, displayId: '2' }),
      createTask({ id: 'child-b', title: 'Child B', stage: 2, parentId: 'root-b', rank: 40, displayId: '2,1' }),
    ];
    const connections: Connection[] = [
      { id: 'conn-b', source: 'root-b', target: 'child-a', title: 'B to A' },
      { id: 'conn-a', source: 'root-a', target: 'child-b', title: 'A to B' },
    ];

    const first = service.buildDiagramData(
      tasks,
      createProject(tasks, connections),
      '',
      new Map<string, go.ObjectData>(),
      { dockedTaskIds: new Set<string>(), focusedTaskId: null },
    );
    const second = service.buildDiagramData(
      [...tasks].reverse(),
      createProject([...tasks].reverse(), [...connections].reverse()),
      '',
      new Map<string, go.ObjectData>(),
      { dockedTaskIds: new Set<string>(), focusedTaskId: null },
    );

    const toRouteInputs = (links: typeof first.linkDataArray) => links.map(link => ({
      key: link.key,
      from: link.from,
      to: link.to,
      isCrossTree: link.isCrossTree,
      curviness: link.curviness,
      labelSegmentFraction: link.labelSegmentFraction,
    }));

    expect(toRouteInputs(second.linkDataArray)).toEqual(toRouteInputs(first.linkDataArray));
    expect(first.linkDataArray.every(link => typeof link.curviness === 'number')).toBe(true);
  });

  it('keeps long-span edge-boundary relation blocks unique without lifting them away from the link', () => {
    const tasks = Array.from({ length: 2 }, (_, index) => [
      createTask({ id: `far-left-${index}`, title: `Far Left ${index}`, stage: 1, displayId: `${index + 1}` }),
      createTask({ id: `far-right-${index}`, title: `Far Right ${index}`, stage: 11, displayId: `${index + 3}` }),
    ]).flat();
    const connections: Connection[] = Array.from({ length: 2 }, (_, index) => ({
      id: `far-span-${index}`,
      source: `far-left-${index}`,
      target: `far-right-${index}`,
      title: `Far ${index}`,
    }));

    const result = service.buildDiagramData(
      tasks,
      createProject(tasks, connections),
      '',
      new Map<string, go.ObjectData>(),
      { dockedTaskIds: new Set<string>(), focusedTaskId: null },
    );

    expectEmbeddedCrossTreeLinks(result.linkDataArray, 2);
  });

  it('uses the visible active-link index for the SiYuan badge instead of raw sortOrder', () => {
    const task = createTask({ id: 'task-with-siyuan', title: 'Knowledge Task', stage: 1, displayId: '1' });
    activeLinksByTask.set(task.id, [
      {
        id: 'link-remaining',
        taskId: task.id,
        sourceType: 'siyuan-block',
        targetId: '20260426123456-abc1234',
        uri: 'siyuan://blocks/20260426123456-abc1234?focus=1',
        label: '思源 abc1234',
        sortOrder: 3,
        deletedAt: null,
        createdAt: '2026-05-28T12:00:00.000Z',
        updatedAt: '2026-05-28T12:00:00.000Z',
      },
    ]);

    const result = service.buildDiagramData(
      [task],
      createProject([task]),
      '',
      new Map<string, go.ObjectData>(),
      { dockedTaskIds: new Set<string>(), focusedTaskId: null },
    );

    expect(result.nodeDataArray[0]?.siyuanLinkBadgeIndex).toBe(1);
  });
});
