import 'fake-indexeddb/auto';

import { Injector, signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoggerService } from './logger.service';
import { DisasterBackupService } from './disaster-backup.service';
import { AuthService } from './auth.service';
import { ThemeService } from './theme.service';
import { UiStateService } from './ui-state.service';
import { PreferenceService } from './preference.service';
import { FocusPreferenceService } from './focus-preference.service';
import { BlackBoxService } from './black-box.service';
import { ConflictStorageService } from './conflict-storage.service';
import { SupabaseClientService } from './supabase-client.service';
import type { Project } from '../models';
import { ExternalSourceLinkService } from '../app/core/external-sources/external-source-link.service';
import { ExternalSourceCacheService } from '../app/core/external-sources/external-source-cache.service';
import { resetBrowserNetworkSuspensionTrackingForTests } from '../utils/browser-network-suspension';

const DISASTER_BACKUP_TEST_HOOK_TIMEOUT_MS = 5000;

function createProject(): Project {
  return {
    id: 'project-1',
    name: 'Inbox',
    description: 'Primary',
    createdDate: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-03-02T00:00:00.000Z',
    version: 2,
    tasks: [
      {
        id: 'task-1',
        title: 'Task A',
        content: 'Body',
        stage: 1,
        parentId: null,
        order: 0,
        rank: 10000,
        status: 'active',
        x: 1,
        y: 2,
        createdDate: '2026-03-01T00:00:00.000Z',
        updatedAt: '2026-03-02T00:00:00.000Z',
        displayId: '1',
        shortId: 'NF-1',
        attachments: [],
        tags: ['focus'],
        priority: 'high',
        dueDate: null,
        expected_minutes: 30,
        cognitive_load: 'high',
        wait_minutes: null,
        parkingMeta: null,
      },
    ],
    connections: [
      {
        id: 'conn-1',
        source: 'task-1',
        target: 'task-1',
        title: 'Loop',
        description: 'Self',
        deletedAt: null,
        updatedAt: '2026-03-02T00:00:00.000Z',
      },
    ],
  };
}

async function seedStore(
  dbName: string,
  version: number,
  ensureStores: (db: IDBDatabase) => void,
  writer: (db: IDBDatabase) => Promise<void>,
): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(dbName, version);
    request.onupgradeneeded = () => ensureStores(request.result);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  try {
    await writer(db);
  } finally {
    db.close();
  }
}

describe('DisasterBackupService', () => {
  let trackedConflictStorage: ConflictStorageService | null = null;

  beforeEach(async () => {
    localStorage.clear();
    resetBrowserNetworkSuspensionTrackingForTests();
    trackedConflictStorage = null;

    for (const name of [
      'nanoflow-offline-snapshots',
      'focus_mode',
      'nanoflow-retry-queue',
      'nanoflow-queue-backup',
      'keyval-store',
      'nanoflow-conflicts',
    ]) {
      await new Promise<void>((resolve) => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = () => resolve();
        request.onerror = () => resolve();
        request.onblocked = () => resolve();
      });
    }
  }, DISASTER_BACKUP_TEST_HOOK_TIMEOUT_MS);

  afterEach(async () => {
    if (trackedConflictStorage) {
      await trackedConflictStorage.closeStorageConnections();
      trackedConflictStorage = null;
    }

    resetBrowserNetworkSuspensionTrackingForTests();
  }, DISASTER_BACKUP_TEST_HOOK_TIMEOUT_MS);

  it('buildLocalPayload should include full v2 business data and localState coverage', async () => {
    localStorage.setItem('nanoflow.offline-cache-v2.user-1', JSON.stringify({
      projects: [{ id: 'offline-project' }],
    }));
    localStorage.setItem('nanoflow.offline-cache-v2', JSON.stringify({
      projects: [{ id: 'foreign-legacy-offline-project' }],
    }));
    localStorage.setItem('nanoflow.action-queue.user-1', JSON.stringify([
      { id: 'action-1', entityType: 'task' },
    ]));
    localStorage.setItem('nanoflow.dead-letter-queue.user-1', JSON.stringify([
      { action: { id: 'dead-1' }, reason: 'failed' },
    ]));
    localStorage.setItem('nanoflow.action-queue.user-2', JSON.stringify([
      { id: 'action-foreign', entityType: 'task' },
    ]));
    localStorage.setItem('nanoflow.dead-letter-queue.user-2', JSON.stringify([
      { action: { id: 'dead-foreign' }, reason: 'foreign' },
    ]));
    localStorage.setItem('nanoflow.dock-snapshot.v3.user-1', JSON.stringify({
      savedAt: '2026-03-10T00:00:00.000Z',
      session: { mainTaskId: 'task-1' },
    }));
    localStorage.setItem('nanoflow.dock-snapshot.v3.user-2', JSON.stringify({
      savedAt: '2026-03-11T00:00:00.000Z',
      session: { mainTaskId: 'foreign-task' },
    }));
    localStorage.setItem('nanoflow.launch-snapshot.v1', JSON.stringify({
      version: 1,
      userId: 'user-2',
      activeProjectId: 'project-2',
    }));
    localStorage.setItem('nanoflow.launch-snapshot.v2', JSON.stringify({
      version: 2,
      userId: 'user-1',
      activeProjectId: 'project-1',
      savedAt: '2026-03-10T00:00:00.000Z',
    }));
    localStorage.setItem('nanoflow.local-tombstones', JSON.stringify({
      'project-1': { 'task-deleted': 123 },
      'project-2': { 'task-deleted-foreign': 456 },
    }));
    localStorage.setItem('nanoflow.local-connection-tombstones', JSON.stringify([
      { projectId: 'project-1', connectionId: 'conn-deleted', deletedAt: '2026-03-07T00:00:00.000Z' },
      { projectId: 'project-2', connectionId: 'conn-deleted-foreign', deletedAt: '2026-03-07T00:00:00.000Z' },
      { connectionId: 'conn-without-project', deletedAt: '2026-03-07T00:00:00.000Z' },
    ]));

    await seedStore(
      'nanoflow-offline-snapshots',
      1,
      (db) => {
        if (!db.objectStoreNames.contains('snapshots')) {
          db.createObjectStore('snapshots', { keyPath: 'id' });
        }
      },
      async (db) => {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('snapshots', 'readwrite');
          tx.objectStore('snapshots').put({
            id: 'offline-snapshot:user-1',
            ownerUserId: 'user-1',
            data: JSON.stringify({ projects: [{ id: 'snapshot-project' }] }),
          });
          tx.objectStore('snapshots').put({
            id: 'offline-snapshot',
            data: JSON.stringify({ projects: [{ id: 'foreign-legacy-snapshot-project' }] }),
          });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      },
    );

    await seedStore(
      'focus_mode',
      3,
      (db) => {
        if (!db.objectStoreNames.contains('black_box_entries')) {
          db.createObjectStore('black_box_entries', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('sync_metadata')) {
          db.createObjectStore('sync_metadata', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('parked_tasks')) {
          db.createObjectStore('parked_tasks', { keyPath: 'taskId' });
        }
      },
      async (db) => {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(['sync_metadata', 'parked_tasks'], 'readwrite');
          tx.objectStore('sync_metadata').put({ key: 'parking_sync_cursor_v1', value: 'cursor-1' });
          tx.objectStore('parked_tasks').put({
            taskId: 'task-parked',
            projectId: 'project-1',
            parkedAt: '2026-03-08T00:00:00.000Z',
            task: { id: 'task-parked', title: 'Parked' },
          });
          tx.objectStore('parked_tasks').put({
            taskId: 'task-parked-foreign',
            projectId: 'project-2',
            parkedAt: '2026-03-09T00:00:00.000Z',
            task: { id: 'task-parked-foreign', title: 'Foreign Parked' },
          });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      },
    );

    await seedStore(
      'nanoflow-retry-queue',
      1,
      (db) => {
        if (!db.objectStoreNames.contains('offline_mutation_queue')) {
          db.createObjectStore('offline_mutation_queue', { keyPath: 'id' });
        }
      },
      async (db) => {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('offline_mutation_queue', 'readwrite');
          tx.objectStore('offline_mutation_queue').put({
            id: 'retry-1',
            type: 'blackbox',
            operation: 'upsert',
            data: {
              id: 'bb-inline-retry',
              content: 'Inline Temp',
              focusMeta: {
                source: 'focus-console-inline',
                sessionId: 'focus-session-1',
                title: 'Inline Temp',
                detail: null,
                lane: 'backup',
                expectedMinutes: null,
                waitMinutes: null,
                cognitiveLoad: 'low',
                dockEntryId: 'dock-inline-1',
              },
            },
            projectId: null,
            retryCount: 1,
            createdAt: 123,
            sourceUserId: 'user-1',
          });
          tx.objectStore('offline_mutation_queue').put({
            id: 'retry-foreign',
            type: 'task',
            operation: 'upsert',
            data: { id: 'task-foreign' },
            projectId: 'project-2',
            retryCount: 1,
            createdAt: 456,
            sourceUserId: 'user-2',
          });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      },
    );

    await seedStore(
      'keyval-store',
      1,
      (db) => {
        if (!db.objectStoreNames.contains('keyval')) {
          db.createObjectStore('keyval');
        }
      },
      async (db) => {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('keyval', 'readwrite');
          tx.objectStore('keyval').put({
            savedAt: '2026-03-10T00:00:00.000Z',
            entries: [{ taskId: 'task-1', lane: 'command' }],
          }, 'nanoflow.focus-session.v5.user-1');
          tx.objectStore('keyval').put({
            savedAt: '2026-03-11T00:00:00.000Z',
            entries: [{ taskId: 'foreign-task', lane: 'backup' }],
          }, 'nanoflow.focus-session.v5.user-2');
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      },
    );

    const tableData: Record<string, unknown[]> = {
      user_preferences: [
        {
          id: 'pref-1',
          user_id: 'user-1',
          created_at: '2026-03-01T00:00:00.000Z',
          updated_at: '2026-03-02T00:00:00.000Z',
        },
      ],
      focus_sessions: [
        {
          id: 'focus-1',
          user_id: 'user-1',
          started_at: '2026-03-03T00:00:00.000Z',
          ended_at: null,
          session_state: { version: 7 },
          updated_at: '2026-03-03T00:05:00.000Z',
        },
      ],
      transcription_usage: [
        {
          id: 'usage-1',
          user_id: 'user-1',
          date: '2026-03-04',
          audio_seconds: 120,
          created_at: '2026-03-04T00:00:00.000Z',
        },
      ],
      routine_tasks: [
        {
          id: 'routine-1',
          user_id: 'user-1',
          title: 'Stretch',
          max_times_per_day: 2,
          is_enabled: true,
          created_at: '2026-03-05T00:00:00.000Z',
          updated_at: '2026-03-05T00:10:00.000Z',
        },
      ],
      routine_completions: [
        {
          id: 'completion-1',
          routine_id: 'routine-1',
          user_id: 'user-1',
          date_key: '2026-03-05',
          count: 2,
          updated_at: '2026-03-05T00:15:00.000Z',
        },
      ],
    };

    const select = vi.fn(function (this: { table: string }) {
      return {
        eq: vi.fn(async () => ({ data: tableData[this.table] ?? [], error: null })),
      };
    });
    const client = {
      from: vi.fn((table: string) => ({
        table,
        select,
      })),
    };

    const focusPreferences = {
      gateEnabled: true,
      strataEnabled: true,
      blackBoxEnabled: true,
      maxSnoozePerDay: 3,
      routineResetHourLocal: 6,
      restReminderHighLoadMinutes: 120,
      restReminderLowLoadMinutes: 20,
    };
    const conflictStorage = {
      getAllConflicts: vi.fn().mockResolvedValue([
        {
          projectId: 'project-1',
          ownerUserId: 'user-1',
          localProject: createProject(),
          remoteProject: undefined,
          conflictedAt: '2026-03-10T00:00:00.000Z',
          localVersion: 2,
          reason: 'field_conflict',
          conflictedFields: ['title'],
          acknowledged: false,
        },
      ]),
    };

    const injector = Injector.create({
      providers: [
        { provide: DisasterBackupService, useClass: DisasterBackupService },
        { provide: LoggerService, useValue: { category: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) } },
        { provide: AuthService, useValue: { currentUserId: vi.fn(() => 'user-1') } },
        { provide: ThemeService, useValue: { theme: signal('forest'), colorMode: signal('dark') } },
        { provide: UiStateService, useValue: { layoutDirection: signal('rtl'), floatingWindowPref: signal('fixed') } },
        { provide: PreferenceService, useValue: { autoResolveConflicts: signal(false) } },
        { provide: FocusPreferenceService, useValue: { preferences: signal(focusPreferences), getPreferences: vi.fn(() => focusPreferences) } },
        {
          provide: BlackBoxService,
          useValue: {
            entriesMap: signal(new Map([
              ['bb-1', {
                id: 'bb-1',
                projectId: null,
                userId: 'user-1',
                content: 'black-box',
                date: '2026-03-06',
                createdAt: '2026-03-06T00:00:00.000Z',
                updatedAt: '2026-03-06T00:00:00.000Z',
                isRead: false,
                isCompleted: false,
                isArchived: false,
                deletedAt: null,
              }],
              ['bb-foreign', {
                id: 'bb-foreign',
                projectId: null,
                userId: 'user-2',
                content: 'foreign-black-box',
                date: '2026-03-06',
                createdAt: '2026-03-06T00:00:00.000Z',
                updatedAt: '2026-03-06T00:00:00.000Z',
                isRead: false,
                isCompleted: false,
                isArchived: false,
                deletedAt: null,
              }],
            ])),
          },
        },
        { provide: ConflictStorageService, useValue: conflictStorage },
        { provide: SupabaseClientService, useValue: { isConfigured: true, client: vi.fn(() => client) } },
        { provide: ExternalSourceLinkService, useValue: { ensureLoaded: vi.fn().mockResolvedValue(undefined), activeLinksForTask: vi.fn(() => []) } },
        { provide: ExternalSourceCacheService, useValue: { loadPendingLinks: vi.fn().mockResolvedValue([]) } },
      ],
    });

    const service = injector.get(DisasterBackupService);
    const payload = await service.buildLocalPayload([createProject()], {
      autoBackupEnabled: true,
      autoBackupIntervalMs: 900000,
    });

    expect(payload.payloadVersion).toBe('2.0.0');
    expect(payload.projects).toHaveLength(1);
    expect(payload.tasks).toHaveLength(1);
    expect(payload.connections).toHaveLength(1);
    expect(payload.userPreferences).toEqual([
      expect.objectContaining({
        id: 'pref-1',
        userId: 'user-1',
        theme: 'forest',
        layoutDirection: 'rtl',
        floatingWindowPref: 'fixed',
        colorMode: 'dark',
        autoResolveConflicts: false,
        localBackupEnabled: true,
        localBackupIntervalMs: 900000,
        focusPreferences,
      }),
    ]);
    expect(payload.blackBoxEntries).toEqual([
      expect.objectContaining({ id: 'bb-1', content: 'black-box' }),
    ]);
    expect(payload.blackBoxEntries).not.toEqual([
      expect.objectContaining({ id: 'bb-foreign', content: 'foreign-black-box' }),
    ]);
    expect(payload.focusSessions).toHaveLength(1);
    expect(payload.transcriptionUsage).toHaveLength(1);
    expect(payload.routineTasks).toHaveLength(1);
    expect(payload.routineCompletions).toHaveLength(1);
    expect(payload.localState).toEqual(
      expect.objectContaining({
        offlineSnapshot: expect.objectContaining({
          localStorage: JSON.stringify({ projects: [{ id: 'offline-project' }] }),
          indexedDb: JSON.stringify({ projects: [{ id: 'snapshot-project' }] }),
        }),
        dockSnapshot: expect.objectContaining({
          localStorage: JSON.stringify({
            savedAt: '2026-03-10T00:00:00.000Z',
            session: { mainTaskId: 'task-1' },
          }),
          indexedDb: expect.objectContaining({
            savedAt: '2026-03-10T00:00:00.000Z',
            entries: [expect.objectContaining({ taskId: 'task-1', lane: 'command' })],
          }),
        }),
        launchSnapshot: expect.objectContaining({
          v1: null,
          v2: JSON.stringify({
            version: 2,
            userId: 'user-1',
            activeProjectId: 'project-1',
            savedAt: '2026-03-10T00:00:00.000Z',
          }),
        }),
        parkedTaskCache: expect.objectContaining({
          entries: [expect.objectContaining({ taskId: 'task-parked', projectId: 'project-1' })],
          syncMetadata: { parking_sync_cursor_v1: 'cursor-1' },
        }),
        retryQueue: [expect.objectContaining({ id: 'retry-1' })],
        actionQueue: [expect.objectContaining({ id: 'action-1' })],
        deadLetters: [expect.objectContaining({ reason: 'failed' })],
        conflicts: [expect.objectContaining({ projectId: 'project-1', reason: 'field_conflict' })],
        taskTombstones: { 'project-1': { 'task-deleted': 123 } },
        connectionTombstones: [expect.objectContaining({ connectionId: 'conn-deleted' })],
      }),
    );
    expect(payload.localState).toBeDefined();
    expect(payload.localState!.offlineSnapshot?.localStorage).not.toContain('foreign-legacy-offline-project');
    expect(payload.localState!.offlineSnapshot?.indexedDb).not.toContain('foreign-legacy-snapshot-project');
    expect(payload.localState!.dockSnapshot?.localStorage).not.toContain('foreign-task');
    expect(payload.localState!.retryQueue).toEqual([
      expect.objectContaining({
        id: 'retry-1',
        type: 'blackbox',
        data: expect.objectContaining({
          id: 'bb-inline-retry',
          content: 'Inline Temp',
          focusMeta: expect.objectContaining({
            source: 'focus-console-inline',
            dockEntryId: 'dock-inline-1',
          }),
        }),
        sourceUserId: 'user-1',
      }),
    ]);
    expect(JSON.stringify(payload.localState!.dockSnapshot?.indexedDb)).not.toContain('foreign-task');
    expect(payload.localState!.retryQueue).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: 'retry-foreign' })]));
    expect(payload.localState!.actionQueue).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: 'action-foreign' })]));
    expect(payload.localState!.deadLetters).not.toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'foreign' })]));
    expect(payload.localState!.parkedTaskCache!.entries).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ taskId: 'task-parked-foreign' })]),
    );
    expect(payload.localState!.taskTombstones).toEqual({ 'project-1': { 'task-deleted': 123 } });
    expect(payload.localState!.connectionTombstones).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ connectionId: 'conn-deleted-foreign' })]),
    );
    expect(payload.localState!.connectionTombstones).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ connectionId: 'conn-without-project' })]),
    );
    expect(payload.tableCounts).toEqual(expect.objectContaining({
      projects: 1,
      tasks: 1,
      connections: 1,
      userPreferences: 1,
      blackBoxEntries: 1,
      focusSessions: 1,
      transcriptionUsage: 1,
      routineTasks: 1,
      routineCompletions: 1,
    }));
    expect(payload.coverage).toEqual(expect.objectContaining({
      includesLocalState: true,
      includesCloudUserState: true,
    }));
  });

  it('buildLocalPayload should continue with local data when remote user state is deferred by browser suspension', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const queryError = { message: 'BrowserNetworkSuspendedError: Browser network IO suspended' };
    const client = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(async () => ({ data: null, error: queryError })),
        })),
      })),
    };

    const injector = Injector.create({
      providers: [
        { provide: DisasterBackupService, useClass: DisasterBackupService },
        { provide: LoggerService, useValue: { category: () => logger } },
        { provide: AuthService, useValue: { currentUserId: vi.fn(() => 'user-1') } },
        { provide: ThemeService, useValue: { theme: signal('forest'), colorMode: signal('dark') } },
        { provide: UiStateService, useValue: { layoutDirection: signal('rtl'), floatingWindowPref: signal('fixed') } },
        { provide: PreferenceService, useValue: { autoResolveConflicts: signal(false) } },
        { provide: FocusPreferenceService, useValue: { preferences: signal({}), getPreferences: vi.fn(() => ({})) } },
        { provide: BlackBoxService, useValue: { entriesMap: signal(new Map()) } },
        { provide: ConflictStorageService, useValue: { getAllConflicts: vi.fn().mockResolvedValue([]) } },
        { provide: SupabaseClientService, useValue: { isConfigured: true, client: vi.fn(() => client) } },
        { provide: ExternalSourceLinkService, useValue: { ensureLoaded: vi.fn().mockResolvedValue(undefined), activeLinksForTask: vi.fn(() => []) } },
        { provide: ExternalSourceCacheService, useValue: { loadPendingLinks: vi.fn().mockResolvedValue([]) } },
      ],
    });

    const service = injector.get(DisasterBackupService);
    const payload = await service.buildLocalPayload([createProject()], {
      autoBackupEnabled: true,
      autoBackupIntervalMs: 900000,
    });

    expect(payload.projects).toHaveLength(1);
    expect(payload.userPreferences).toEqual([
      expect.objectContaining({
        id: 'local-pref-user-1',
        userId: 'user-1',
        theme: 'forest',
      }),
    ]);
    expect(payload.focusSessions).toEqual([]);
    expect(payload.transcriptionUsage).toEqual([]);
    expect(payload.routineTasks).toEqual([]);
    expect(payload.routineCompletions).toEqual([]);
    expect(payload.coverage).toEqual(expect.objectContaining({
      includesProjectData: true,
      includesLocalState: true,
      includesCloudUserState: false,
    }));
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      '备份远端用户状态读取已延后，继续生成本地备份',
      expect.objectContaining({ table: 'user_preferences' }),
    );
  });

  it('buildLocalPayload should include only current owner conflict records from real conflict storage', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    let currentUserId = 'user-1';

    const injector = Injector.create({
      providers: [
        { provide: DisasterBackupService, useClass: DisasterBackupService },
        { provide: ConflictStorageService, useClass: ConflictStorageService },
        { provide: LoggerService, useValue: { category: () => logger } },
        { provide: AuthService, useValue: { currentUserId: vi.fn(() => currentUserId) } },
        { provide: ThemeService, useValue: { theme: signal('forest'), colorMode: signal('dark') } },
        { provide: UiStateService, useValue: { layoutDirection: signal('rtl'), floatingWindowPref: signal('fixed') } },
        { provide: PreferenceService, useValue: { autoResolveConflicts: signal(false) } },
        { provide: FocusPreferenceService, useValue: { preferences: signal({}), getPreferences: vi.fn(() => ({})) } },
        { provide: BlackBoxService, useValue: { entriesMap: signal(new Map()) } },
        { provide: SupabaseClientService, useValue: { isConfigured: false, client: vi.fn() } },
        { provide: ExternalSourceLinkService, useValue: { ensureLoaded: vi.fn().mockResolvedValue(undefined), activeLinksForTask: vi.fn(() => []) } },
        { provide: ExternalSourceCacheService, useValue: { loadPendingLinks: vi.fn().mockResolvedValue([]) } },
      ],
    });

    const conflictStorage = injector.get(ConflictStorageService);
  trackedConflictStorage = conflictStorage;
    const service = injector.get(DisasterBackupService);

    currentUserId = 'user-1';
    await conflictStorage.saveConflict({
      projectId: 'project-1',
      localProject: createProject(),
      conflictedAt: '2026-03-12T00:00:00.000Z',
      localVersion: 3,
      reason: 'field_conflict',
      conflictedFields: ['title'],
      acknowledged: false,
    });

    currentUserId = 'user-2';
    await conflictStorage.saveConflict({
      projectId: 'project-1',
      localProject: {
        ...createProject(),
        name: 'Foreign Inbox',
      },
      conflictedAt: '2026-03-12T00:05:00.000Z',
      localVersion: 4,
      reason: 'concurrent_edit',
      acknowledged: false,
    });

    currentUserId = 'user-1';
    const payload = await service.buildLocalPayload([createProject()], {
      autoBackupEnabled: true,
      autoBackupIntervalMs: 900000,
    });

    expect(payload.localState?.conflicts).toEqual([
      expect.objectContaining({
        ownerUserId: 'user-1',
        projectId: 'project-1',
        reason: 'field_conflict',
        localProject: expect.objectContaining({ name: 'Inbox' }),
      }),
    ]);
  });

  it('buildLocalPayload should fail on retryable remote errors that are not browser suspension', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const queryError = { code: 503, message: 'service unavailable' };
    const client = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(async () => ({ data: null, error: queryError })),
        })),
      })),
    };

    const injector = Injector.create({
      providers: [
        { provide: DisasterBackupService, useClass: DisasterBackupService },
        { provide: LoggerService, useValue: { category: () => logger } },
        { provide: AuthService, useValue: { currentUserId: vi.fn(() => 'user-1') } },
        { provide: ThemeService, useValue: { theme: signal('forest'), colorMode: signal('dark') } },
        { provide: UiStateService, useValue: { layoutDirection: signal('rtl'), floatingWindowPref: signal('fixed') } },
        { provide: PreferenceService, useValue: { autoResolveConflicts: signal(false) } },
        { provide: FocusPreferenceService, useValue: { preferences: signal({}), getPreferences: vi.fn(() => ({})) } },
        { provide: BlackBoxService, useValue: { entriesMap: signal(new Map()) } },
        { provide: ConflictStorageService, useValue: { getAllConflicts: vi.fn().mockResolvedValue([]) } },
        { provide: SupabaseClientService, useValue: { isConfigured: true, client: vi.fn(() => client) } },
        { provide: ExternalSourceLinkService, useValue: { ensureLoaded: vi.fn().mockResolvedValue(undefined), activeLinksForTask: vi.fn(() => []) } },
        { provide: ExternalSourceCacheService, useValue: { loadPendingLinks: vi.fn().mockResolvedValue([]) } },
      ],
    });

    const service = injector.get(DisasterBackupService);

    await expect(service.buildLocalPayload([createProject()], {
      autoBackupEnabled: true,
      autoBackupIntervalMs: 900000,
    })).rejects.toThrow(/Backup table user_preferences query failed/i);
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to fetch backup table',
      expect.objectContaining({ table: 'user_preferences', error: queryError }),
    );
  });

  it('buildLocalPayload should fallback to owner-scoped action queue IndexedDB backup', async () => {
    await seedStore(
      'nanoflow-queue-backup',
      1,
      (db) => {
        if (!db.objectStoreNames.contains('queue-backup')) {
          db.createObjectStore('queue-backup', { keyPath: 'id' });
        }
      },
      async (db) => {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('queue-backup', 'readwrite');
          tx.objectStore('queue-backup').put({
            id: 'queue:user-1',
            ownerUserId: 'user-1',
            actions: [{ id: 'action-backed-up', entityType: 'project' }],
            savedAt: '2026-03-09T00:00:00.000Z',
          });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      },
    );

    const injector = Injector.create({
      providers: [
        { provide: DisasterBackupService, useClass: DisasterBackupService },
        { provide: LoggerService, useValue: { category: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) } },
        { provide: AuthService, useValue: { currentUserId: vi.fn(() => 'user-1') } },
        { provide: ThemeService, useValue: { theme: signal('forest'), colorMode: signal('dark') } },
        { provide: UiStateService, useValue: { layoutDirection: signal('rtl'), floatingWindowPref: signal('fixed') } },
        { provide: PreferenceService, useValue: { autoResolveConflicts: signal(false) } },
        { provide: FocusPreferenceService, useValue: { preferences: signal({}), getPreferences: vi.fn(() => ({})) } },
        { provide: BlackBoxService, useValue: { entriesMap: signal(new Map()) } },
        { provide: ConflictStorageService, useValue: { getAllConflicts: vi.fn().mockResolvedValue([]) } },
        { provide: SupabaseClientService, useValue: { isConfigured: false, client: vi.fn() } },
        { provide: ExternalSourceLinkService, useValue: { ensureLoaded: vi.fn().mockResolvedValue(undefined), activeLinksForTask: vi.fn(() => []) } },
        { provide: ExternalSourceCacheService, useValue: { loadPendingLinks: vi.fn().mockResolvedValue([]) } },
      ],
    });

    const service = injector.get(DisasterBackupService);
    const payload = await service.buildLocalPayload([createProject()], {
      autoBackupEnabled: false,
      autoBackupIntervalMs: 900000,
    });

    expect(payload.localState!.actionQueue).toEqual([
      expect.objectContaining({ id: 'action-backed-up', entityType: 'project' }),
    ]);
  });

  it('buildLocalPayload should include the newest anonymous dock snapshot when current-user scope is empty', async () => {
    localStorage.setItem('nanoflow.dock-snapshot.v3.anonymous', JSON.stringify({
      savedAt: '2026-03-12T00:00:00.000Z',
      session: { mainTaskId: 'anon-legacy-task' },
    }));

    await seedStore(
      'keyval-store',
      1,
      (db) => {
        if (!db.objectStoreNames.contains('keyval')) {
          db.createObjectStore('keyval');
        }
      },
      async (db) => {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('keyval', 'readwrite');
          tx.objectStore('keyval').put({
            savedAt: '2026-03-13T00:00:00.000Z',
            entries: [{ taskId: 'anon-idb-task', lane: 'backup' }],
          }, 'nanoflow.focus-session.v5.anonymous');
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      },
    );

    const injector = Injector.create({
      providers: [
        { provide: DisasterBackupService, useClass: DisasterBackupService },
        { provide: LoggerService, useValue: { category: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) } },
        { provide: AuthService, useValue: { currentUserId: vi.fn(() => 'user-1') } },
        { provide: ThemeService, useValue: { theme: signal('forest'), colorMode: signal('dark') } },
        { provide: UiStateService, useValue: { layoutDirection: signal('rtl'), floatingWindowPref: signal('fixed') } },
        { provide: PreferenceService, useValue: { autoResolveConflicts: signal(false) } },
        { provide: FocusPreferenceService, useValue: { preferences: signal({}), getPreferences: vi.fn(() => ({})) } },
        { provide: BlackBoxService, useValue: { entriesMap: signal(new Map()) } },
        { provide: ConflictStorageService, useValue: { getAllConflicts: vi.fn().mockResolvedValue([]) } },
        { provide: SupabaseClientService, useValue: { isConfigured: false, client: vi.fn() } },
        { provide: ExternalSourceLinkService, useValue: { ensureLoaded: vi.fn().mockResolvedValue(undefined), activeLinksForTask: vi.fn(() => []) } },
        { provide: ExternalSourceCacheService, useValue: { loadPendingLinks: vi.fn().mockResolvedValue([]) } },
      ],
    });

    const service = injector.get(DisasterBackupService);
    const payload = await service.buildLocalPayload([createProject()], {
      autoBackupEnabled: false,
      autoBackupIntervalMs: 900000,
    });

    expect(payload.localState?.dockSnapshot).toEqual(expect.objectContaining({
      localStorage: JSON.stringify({
        savedAt: '2026-03-12T00:00:00.000Z',
        session: { mainTaskId: 'anon-legacy-task' },
      }),
      indexedDb: expect.objectContaining({
        savedAt: '2026-03-13T00:00:00.000Z',
        entries: [expect.objectContaining({ taskId: 'anon-idb-task', lane: 'backup' })],
      }),
    }));
  });
});
