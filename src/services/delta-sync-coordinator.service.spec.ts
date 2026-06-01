import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Injector, runInInjectionContext } from '@angular/core';
import { DeltaSyncCoordinatorService } from './delta-sync-coordinator.service';
import { SimpleSyncService, TombstoneService } from '../core-bridge';
import { ConflictDetectionService } from './conflict-detection.service';
import { ChangeTrackerService } from './change-tracker.service';
import { ProjectStateService } from './project-state.service';
import { LoggerService } from './logger.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { mockSentryLazyLoaderService } from '../test-setup.mocks';
import type { ChangeRecord } from './change-tracker.types';
import type { Connection, Project, Task } from '../models';
import { createBrowserNetworkSuspendedError } from '../utils/browser-network-suspension';

const mockLoggerCategory = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const mockLoggerService = {
  category: vi.fn(() => mockLoggerCategory),
};

const mockSimpleSyncService = {
  checkForDrift: vi.fn(),
  saveOfflineSnapshotAndWait: vi.fn(),
  commitProjectSyncCursor: vi.fn(),
};

const mockConflictDetectionService = {
  mergeConnections: vi.fn((localConnections: Connection[], remoteConnections: Connection[]) => [
    ...localConnections,
    ...remoteConnections,
  ]),
};

const mockProjectStateService = {
  projects: vi.fn(),
  getProject: vi.fn(),
  updateProjects: vi.fn(),
};

const mockChangeTrackerService = {
  getPendingChange: vi.fn(),
  getLockedFields: vi.fn(() => []),
};

const mockTombstoneService = {
  getLocalTombstones: vi.fn(() => new Set<string>()),
  shouldRejectTaskUpsert: vi.fn(() => false),
};

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Task',
    content: 'Task content',
    stage: 1,
    parentId: null,
    order: 0,
    rank: 10000,
    status: 'active',
    x: 0,
    y: 0,
    createdDate: '2026-04-18T00:00:00.000Z',
    updatedAt: '2026-04-18T00:00:00.000Z',
    displayId: '1',
    shortId: 'aaaa',
    hasIncompleteTask: false,
    attachments: [],
    tags: [],
    ...overrides,
  };
}

function createProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    name: 'Project',
    description: '',
    tasks: [],
    connections: [],
    createdDate: '2026-04-18T00:00:00.000Z',
    version: 1,
    ...overrides,
  };
}

describe('DeltaSyncCoordinatorService', () => {
  let service: DeltaSyncCoordinatorService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSimpleSyncService.saveOfflineSnapshotAndWait.mockResolvedValue(undefined);
    mockSimpleSyncService.commitProjectSyncCursor.mockResolvedValue(undefined);
    mockProjectStateService.projects.mockReturnValue([]);

    const injector = Injector.create({
      providers: [
        DeltaSyncCoordinatorService,
        { provide: SimpleSyncService, useValue: mockSimpleSyncService },
        { provide: ConflictDetectionService, useValue: mockConflictDetectionService },
        { provide: ProjectStateService, useValue: mockProjectStateService },
        { provide: ChangeTrackerService, useValue: mockChangeTrackerService },
        { provide: LoggerService, useValue: mockLoggerService },
        { provide: SentryLazyLoaderService, useValue: mockSentryLazyLoaderService },
        { provide: TombstoneService, useValue: mockTombstoneService },
      ],
    });

    service = runInInjectionContext(injector, () => injector.get(DeltaSyncCoordinatorService));
  });

  describe('hasProjectContentDifference', () => {
    it('should detect connection title or description changes with the same counts', () => {
      const project1 = createProject({
        connections: [{
          id: 'conn-1',
          source: 'task-a',
          target: 'task-b',
          title: '旧标题',
          description: '旧描述',
        }],
      });
      const project2 = createProject({
        connections: [{
          id: 'conn-1',
          source: 'task-a',
          target: 'task-b',
          title: '新标题',
          description: '新描述',
        }],
      });

      expect(service.hasProjectContentDifference(project1, project2)).toBe(true);
    });

    it('should not report a difference when connection content is unchanged', () => {
      const connections = [{
        id: 'conn-1',
        source: 'task-a',
        target: 'task-b',
        title: '标题',
        description: '描述',
        deletedAt: undefined,
      }];

      const project1 = createProject({ connections });
      const project2 = createProject({ connections: [{ ...connections[0] }] });

      expect(service.hasProjectContentDifference(project1, project2)).toBe(false);
    });
  });

  describe('performDeltaSync connection merge', () => {
    it('should defer browser network suspension without logging an error or reporting Sentry', async () => {
      mockSimpleSyncService.checkForDrift.mockRejectedValue(createBrowserNetworkSuspendedError());

      const result = await service.performDeltaSync('project-1');

      expect(result).toEqual({ taskChanges: 0, connectionChanges: 0 });
      expect(mockLoggerCategory.error).not.toHaveBeenCalled();
      expect(mockSentryLazyLoaderService.captureException).not.toHaveBeenCalled();
    });

    it('should persist merged state before committing the returned cursor candidate', async () => {
      const currentProject = createProject({
        updatedAt: '2026-04-19T00:00:00.000Z',
        tasks: [createTask({ id: 'task-local', updatedAt: '2026-04-19T00:00:00.000Z' })],
      });
      const remoteTask = createTask({
        id: 'task-remote',
        updatedAt: '2026-04-19T00:01:00.000Z',
      });

      mockProjectStateService.getProject.mockReturnValue(currentProject);
      mockProjectStateService.projects.mockReturnValue([currentProject]);
      mockSimpleSyncService.checkForDrift.mockResolvedValue({
        tasks: [remoteTask],
        connections: [],
        nextCursor: {
          updatedAt: '2026-04-19T00:01:00.000Z',
          entityType: 'task',
          id: 'task-remote',
        },
      });
      const calls: string[] = [];
      mockProjectStateService.updateProjects.mockImplementation((updater: (projects: Project[]) => Project[]) => {
        const updated = updater([currentProject]);
        mockProjectStateService.projects.mockReturnValue(updated);
        calls.push('merge');
      });
      mockSimpleSyncService.saveOfflineSnapshotAndWait.mockImplementation(async () => {
        calls.push('persist');
      });
      mockSimpleSyncService.commitProjectSyncCursor.mockImplementation(() => {
        calls.push('commit');
      });

      const result = await service.performDeltaSync('project-1');

      expect(result).toEqual({ taskChanges: 1, connectionChanges: 0 });
      expect(mockSimpleSyncService.saveOfflineSnapshotAndWait).toHaveBeenCalledWith([
        expect.objectContaining({
          id: 'project-1',
          tasks: expect.arrayContaining([expect.objectContaining({ id: 'task-remote' })]),
        }),
      ]);
      expect(mockSimpleSyncService.commitProjectSyncCursor).toHaveBeenCalledWith('project-1', {
        updatedAt: '2026-04-19T00:01:00.000Z',
        entityType: 'task',
        id: 'task-remote',
      });
      expect(calls).toEqual(['merge', 'persist', 'commit']);
    });

    it('should reuse connection LWW merge instead of raw replacement', async () => {
      const currentProject = createProject({
        updatedAt: '2026-04-19T00:00:00.000Z',
        connections: [{
          id: 'conn-1',
          source: 'task-a',
          target: 'task-b',
          title: '本地标题',
          description: '本地描述',
          updatedAt: '2026-04-19T00:00:00.000Z',
        }],
      });
      const mergedConnections: Connection[] = [{
        id: 'conn-1',
        source: 'task-a',
        target: 'task-b',
        title: '本地标题',
        description: '本地描述',
        updatedAt: '2026-04-19T00:00:00.000Z',
      }];

      mockProjectStateService.getProject.mockReturnValue(currentProject);
      mockSimpleSyncService.checkForDrift.mockResolvedValue({
        tasks: [],
        connections: [{
          id: 'conn-1',
          source: 'task-a',
          target: 'task-b',
          updatedAt: '2026-04-19T00:00:00.000Z',
        }],
      });
      mockConflictDetectionService.mergeConnections.mockReturnValue(mergedConnections);

      await service.performDeltaSync('project-1');

      expect(mockConflictDetectionService.mergeConnections).toHaveBeenCalledWith(
        currentProject.connections,
        [{
          id: 'conn-1',
          source: 'task-a',
          target: 'task-b',
          updatedAt: '2026-04-19T00:00:00.000Z',
        }]
      );

      const updater = mockProjectStateService.updateProjects.mock.calls[0][0] as (projects: Project[]) => Project[];
      const [updatedProject] = updater([currentProject]);
      expect(updatedProject.connections).toEqual(mergedConnections);
    });

    it('should keep deleted connection tombstones in project state', async () => {
      const currentProject = createProject({
        updatedAt: '2026-04-19T00:00:00.000Z',
        connections: [{
          id: 'conn-1',
          source: 'task-a',
          target: 'task-b',
          updatedAt: '2026-04-19T00:00:00.000Z',
        }],
      });
      const deletedConnections: Connection[] = [{
        id: 'conn-1',
        source: 'task-a',
        target: 'task-b',
        deletedAt: '2026-04-19T00:01:00.000Z',
        updatedAt: '2026-04-19T00:01:00.000Z',
      }];

      mockProjectStateService.getProject.mockReturnValue(currentProject);
      mockSimpleSyncService.checkForDrift.mockResolvedValue({
        tasks: [],
        connections: deletedConnections,
      });
      mockConflictDetectionService.mergeConnections.mockReturnValue(deletedConnections);

      await service.performDeltaSync('project-1');

      const updater = mockProjectStateService.updateProjects.mock.calls[0][0] as (projects: Project[]) => Project[];
      const [updatedProject] = updater([currentProject]);
      expect(updatedProject.connections).toEqual(deletedConnections);
    });
  });

  describe('performDeltaSync task merge', () => {
    it('should preserve local completed status when a newer delta arrives while status is still pending', async () => {
      const localTask = createTask({
        status: 'completed',
        updatedAt: '2026-04-19T00:00:00.000Z',
      });
      const currentProject = createProject({
        updatedAt: '2026-04-19T00:00:00.000Z',
        tasks: [localTask],
      });
      const remoteTask = createTask({
        status: 'active',
        updatedAt: '2026-04-19T00:05:00.000Z',
      });
      const pendingChange = {
        entityId: localTask.id,
        entityType: 'task',
        changeType: 'update',
        projectId: currentProject.id,
        timestamp: Date.now(),
        revision: 1,
        changedFields: ['status'],
        data: localTask,
      } satisfies ChangeRecord;

      mockProjectStateService.getProject.mockReturnValue(currentProject);
      mockSimpleSyncService.checkForDrift.mockResolvedValue({
        tasks: [remoteTask],
        connections: [],
      });
      mockChangeTrackerService.getPendingChange.mockReturnValue(pendingChange);

      await service.performDeltaSync(currentProject.id);

      const updater = mockProjectStateService.updateProjects.mock.calls[0][0] as (projects: Project[]) => Project[];
      const [updatedProject] = updater([currentProject]);

      expect(updatedProject.tasks[0]).toMatchObject({
        id: localTask.id,
        status: 'completed',
        updatedAt: remoteTask.updatedAt,
      });
    });

    it('should ignore an older remote tombstone returned by the delta lookback window', async () => {
      const localTask = createTask({
        status: 'active',
        updatedAt: '2026-04-19T00:05:00.000Z',
      });
      const currentProject = createProject({
        updatedAt: '2026-04-19T00:05:00.000Z',
        tasks: [localTask],
      });
      const staleRemoteDelete = createTask({
        updatedAt: '2026-04-19T00:01:00.000Z',
        deletedAt: '2026-04-19T00:01:00.000Z',
      });

      mockProjectStateService.getProject.mockReturnValue(currentProject);
      mockSimpleSyncService.checkForDrift.mockResolvedValue({
        tasks: [staleRemoteDelete],
        connections: [],
      });
      mockChangeTrackerService.getPendingChange.mockReturnValue(undefined);

      await service.performDeltaSync(currentProject.id);

      const updater = mockProjectStateService.updateProjects.mock.calls[0][0] as (projects: Project[]) => Project[];
      const [updatedProject] = updater([currentProject]);

      expect(updatedProject.tasks).toHaveLength(1);
      expect(updatedProject.tasks[0]).toMatchObject({
        id: localTask.id,
        updatedAt: localTask.updatedAt,
      });
      expect(updatedProject.tasks[0].deletedAt).toBeUndefined();
    });

    it('should accept a newer remote restore and clear the local tombstone', async () => {
      const localDeletedTask = createTask({
        updatedAt: '2026-04-19T00:01:00.000Z',
        deletedAt: '2026-04-19T00:01:00.000Z',
      });
      const currentProject = createProject({
        updatedAt: '2026-04-19T00:01:00.000Z',
        tasks: [localDeletedTask],
      });
      const remoteRestoredTask = createTask({
        updatedAt: '2026-04-19T00:05:00.000Z',
      });

      mockProjectStateService.getProject.mockReturnValue(currentProject);
      mockSimpleSyncService.checkForDrift.mockResolvedValue({
        tasks: [remoteRestoredTask],
        connections: [],
      });
      mockChangeTrackerService.getPendingChange.mockReturnValue(undefined);

      await service.performDeltaSync(currentProject.id);

      const updater = mockProjectStateService.updateProjects.mock.calls[0][0] as (projects: Project[]) => Project[];
      const [updatedProject] = updater([currentProject]);

      expect(updatedProject.tasks).toHaveLength(1);
      expect(updatedProject.tasks[0]).toMatchObject({
        id: localDeletedTask.id,
        updatedAt: remoteRestoredTask.updatedAt,
      });
      expect(updatedProject.tasks[0].deletedAt).toBeUndefined();
    });

    it('should apply a newer remote delete delta even when tombstone upserts are blocked', async () => {
      const localTask = createTask({
        updatedAt: '2026-04-19T00:01:00.000Z',
      });
      const currentProject = createProject({
        updatedAt: '2026-04-19T00:01:00.000Z',
        tasks: [localTask],
      });
      const remoteDelete = createTask({
        updatedAt: '2026-04-19T00:05:00.000Z',
        deletedAt: '2026-04-19T00:05:00.000Z',
      });

      mockProjectStateService.getProject.mockReturnValue(currentProject);
      mockSimpleSyncService.checkForDrift.mockResolvedValue({
        tasks: [remoteDelete],
        connections: [],
      });
      mockChangeTrackerService.getPendingChange.mockReturnValue(undefined);
      mockTombstoneService.shouldRejectTaskUpsert.mockReturnValue(true);

      await service.performDeltaSync(currentProject.id);

      const updater = mockProjectStateService.updateProjects.mock.calls[0][0] as (projects: Project[]) => Project[];
      const [updatedProject] = updater([currentProject]);

      expect(updatedProject.tasks).toHaveLength(1);
      expect(updatedProject.tasks[0]).toMatchObject({
        id: localTask.id,
        deletedAt: remoteDelete.deletedAt,
        updatedAt: remoteDelete.updatedAt,
      });
    });

    it('should keep a newer local soft delete in trash when an older remote restore arrives', async () => {
      const localDeletedTask = createTask({
        updatedAt: '2026-04-19T00:01:00.000Z',
        deletedAt: '2026-04-19T00:05:00.000Z',
      });
      const currentProject = createProject({
        updatedAt: '2026-04-19T00:05:00.000Z',
        tasks: [localDeletedTask],
      });
      const olderRemoteRestore = createTask({
        updatedAt: '2026-04-19T00:03:00.000Z',
      });

      mockProjectStateService.getProject.mockReturnValue(currentProject);
      mockSimpleSyncService.checkForDrift.mockResolvedValue({
        tasks: [olderRemoteRestore],
        connections: [],
      });
      mockChangeTrackerService.getPendingChange.mockReturnValue(undefined);

      await service.performDeltaSync(currentProject.id);

      const updater = mockProjectStateService.updateProjects.mock.calls[0][0] as (projects: Project[]) => Project[];
      const [updatedProject] = updater([currentProject]);

      expect(updatedProject.tasks).toHaveLength(1);
      expect(updatedProject.tasks[0]).toMatchObject({
        id: localDeletedTask.id,
        deletedAt: localDeletedTask.deletedAt,
        updatedAt: localDeletedTask.updatedAt,
      });
    });
  });
});
