import { Injectable, inject } from '@angular/core';
import type { Project, Task, Connection } from '../models';
import { LoggerService } from './logger.service';
import { AuthService } from './auth.service';
import { ThemeService } from './theme.service';
import { UiStateService } from './ui-state.service';
import { PreferenceService } from './preference.service';
import { FocusPreferenceService } from './focus-preference.service';
import { BlackBoxService } from './black-box.service';
import { ConflictStorageService } from './conflict-storage.service';
import { SupabaseClientService } from './supabase-client.service';
import { AUTH_CONFIG } from '../config/auth.config';
import { FOCUS_CONFIG } from '../config/focus.config';
import { PARKING_CONFIG } from '../config/parking.config';
import { LOCAL_QUEUE_CONFIG } from './action-queue-storage.service';
import {
  BACKUP_CONFIG,
  buildTableCounts,
  calculateChecksum,
  type BackupData,
  type BackupBlackBoxEntry,
  type BackupConnection,
  type BackupFocusSession,
  type BackupLocalState,
  type BackupProject,
  type BackupRoutineCompletion,
  type BackupRoutineTask,
  type BackupTask,
  type BackupTranscriptionUsage,
  type BackupUserPreferences,
  type BackupCoverage,
  type BackupExternalSourceLink,
} from '../../supabase/functions/_shared/backup-utils';
import { ExternalSourceLinkService } from '../app/core/external-sources/external-source-link.service';
import { ExternalSourceCacheService } from '../app/core/external-sources/external-source-cache.service';
import type { ExternalSourceLink } from '../app/core/external-sources/external-source.model';
import { supabaseErrorToError } from '../utils/supabase-error';
import {
  isBrowserNetworkSuspendedError,
  isBrowserNetworkSuspendedWindow,
} from '../utils/browser-network-suspension';

const ACTION_QUEUE_BACKUP_DB_NAME = 'nanoflow-queue-backup';
const ACTION_QUEUE_BACKUP_STORE_NAME = 'queue-backup';
const DOCK_SNAPSHOT_IDB_DB_NAME = 'keyval-store';
const DOCK_SNAPSHOT_IDB_STORE_NAME = 'keyval';
const DOCK_SNAPSHOT_IDB_KEY_PREFIX = 'nanoflow.focus-session.v5';
const OFFLINE_SNAPSHOT_STORAGE_KEY = 'nanoflow.offline-cache-v2';
const OFFLINE_SNAPSHOT_RECORD_PREFIX = 'offline-snapshot:';
const LAUNCH_SNAPSHOT_STORAGE_KEY_V1 = 'nanoflow.launch-snapshot.v1';
const LAUNCH_SNAPSHOT_STORAGE_KEY_V2 = 'nanoflow.launch-snapshot.v2';

/**
 * 允许被动态查询的备份表白名单
 *
 * 【2026-04-16 T0-3】任何动态表名必须先经过此白名单；
 * 禁止直接把用户输入或未审核的字符串传入 `supabase.from()`。
 */
const BACKUP_TABLES = [
  'user_preferences',
  'focus_sessions',
  'transcription_usage',
  'routine_tasks',
  'routine_completions',
] as const;
type BackupTable = (typeof BACKUP_TABLES)[number];

export interface LocalDisasterBackupOptions {
  autoBackupEnabled: boolean;
  autoBackupIntervalMs: number;
}

interface SupabaseUserPreferenceRow {
  id: string;
  created_at?: string;
  updated_at?: string;
}

interface SupabaseFocusSessionRow {
  id: string;
  user_id: string;
  started_at: string;
  ended_at?: string | null;
  session_state: unknown;
  updated_at?: string;
}

interface SupabaseTranscriptionUsageRow {
  id: string;
  user_id: string;
  date: string;
  audio_seconds: number;
  created_at?: string;
}

interface SupabaseRoutineTaskRow {
  id: string;
  user_id: string;
  title: string;
  max_times_per_day: number;
  is_enabled: boolean;
  created_at?: string;
  updated_at?: string;
}

interface SupabaseRoutineCompletionRow {
  id: string;
  routine_id: string;
  user_id: string;
  date_key: string;
  count: number;
  updated_at?: string;
}

interface RemoteBackupReadState {
  deferred: boolean;
}

@Injectable({
  providedIn: 'root',
})
export class DisasterBackupService {
  private readonly logger = inject(LoggerService).category('DisasterBackup');
  private readonly auth = inject(AuthService);
  private readonly theme = inject(ThemeService);
  private readonly uiState = inject(UiStateService);
  private readonly preferenceService = inject(PreferenceService);
  private readonly focusPreferenceService = inject(FocusPreferenceService);
  private readonly blackBoxService = inject(BlackBoxService);
  private readonly conflictStorage = inject(ConflictStorageService);
  private readonly supabase = inject(SupabaseClientService);
  private readonly externalSourceLinks = inject(ExternalSourceLinkService);
  private readonly externalSourceCache = inject(ExternalSourceCacheService);

  async buildLocalPayload(
    projects: Project[],
    options: LocalDisasterBackupOptions,
  ): Promise<BackupData> {
    const userId = this.resolveEffectiveUserId();
    const visibleProjectIds = new Set(projects.map((project) => project.id));
    const remoteReadState: RemoteBackupReadState = { deferred: false };

    await this.externalSourceLinks.ensureLoaded();
    const payloadBase = this.buildProjectPayload(projects, userId);
    const userPreferences = await this.collectUserPreferences(userId, options, remoteReadState);
    const blackBoxEntries = this.collectBlackBoxEntries(userId);
    const remoteState = await this.collectRemoteUserState(userId, remoteReadState);
    const localState = await this.collectLocalState(visibleProjectIds);

    const coverage: BackupCoverage = {
      includesProjectData: true,
      includesCloudUserState: !!userId && this.supabase.isConfigured && !remoteReadState.deferred,
      includesLocalState: true,
    };

    const provisionalPayload: BackupData = {
      version: BACKUP_CONFIG.VERSION,
      payloadVersion: BACKUP_CONFIG.VERSION,
      type: 'full',
      createdAt: new Date().toISOString(),
      checksum: '',
      tableCounts: {
        projects: 0,
        tasks: 0,
        connections: 0,
        userPreferences: 0,
        blackBoxEntries: 0,
        focusSessions: 0,
        transcriptionUsage: 0,
        routineTasks: 0,
        routineCompletions: 0,
      },
      coverage,
      ...payloadBase,
      userPreferences,
      blackBoxEntries,
      focusSessions: remoteState.focusSessions,
      transcriptionUsage: remoteState.transcriptionUsage,
      routineTasks: remoteState.routineTasks,
      routineCompletions: remoteState.routineCompletions,
      localState,
    };

    const tableCounts = buildTableCounts(provisionalPayload);
    const checksum = await this.calculatePayloadChecksum({
      ...provisionalPayload,
      tableCounts,
    });

    return {
      ...provisionalPayload,
      tableCounts,
      checksum,
    };
  }

  async buildLocalBlob(
    projects: Project[],
    options: LocalDisasterBackupOptions,
  ): Promise<{ payload: BackupData; blob: Blob; deferredCloudUserState: boolean }> {
    const payload = await this.buildLocalPayload(projects, options);
    const content = JSON.stringify(payload, null, 2);
    return {
      payload,
      blob: new Blob([content], { type: 'application/json' }),
      deferredCloudUserState: this.shouldDeferLocalBackupWrite(payload),
    };
  }

  private shouldDeferLocalBackupWrite(payload: BackupData): boolean {
    return !!this.resolveEffectiveUserId()
      && this.supabase.isConfigured
      && !payload.coverage.includesCloudUserState;
  }

  private buildProjectPayload(
    projects: Project[],
    userId: string | null,
  ): Pick<BackupData, 'projects' | 'tasks' | 'connections'> {
    const backupProjects: BackupProject[] = [];
    const backupTasks: BackupTask[] = [];
    const backupConnections: BackupConnection[] = [];

    for (const project of projects) {
      backupProjects.push({
        id: project.id,
        userId: userId ?? AUTH_CONFIG.LOCAL_MODE_USER_ID,
        name: project.name,
        description: project.description,
        createdAt: project.createdDate,
        updatedAt: project.updatedAt,
        version: project.version,
      });

      for (const task of project.tasks ?? []) {
        backupTasks.push(this.mapTask(project.id, task));
      }

      for (const connection of project.connections ?? []) {
        backupConnections.push(this.mapConnection(project.id, connection));
      }
    }

    return {
      projects: backupProjects,
      tasks: backupTasks,
      connections: backupConnections,
    };
  }

  private mapTask(projectId: string, task: Task): BackupTask {
    return {
      id: task.id,
      projectId,
      title: task.title,
      content: task.content,
      parentId: task.parentId,
      stage: task.stage,
      order: task.order,
      rank: task.rank,
      status: task.status,
      x: task.x,
      y: task.y,
      displayId: task.displayId,
      shortId: task.shortId,
      attachments: task.attachments ?? [],
      tags: task.tags,
      priority: task.priority,
      dueDate: task.dueDate,
      createdAt: task.createdDate,
      updatedAt: task.updatedAt,
      deletedAt: task.deletedAt,
      externalSourceLinks: this.mapExternalSourceLinks(task.id),
    };
  }

  private mapExternalSourceLinks(taskId: string): BackupExternalSourceLink[] | undefined {
    const links = this.externalSourceLinks.activeLinksForTask(taskId);
    if (links.length === 0) return undefined;
    return links.map(link => this.mapExternalSourceLink(link));
  }

  private mapExternalSourceLink(link: ExternalSourceLink): BackupExternalSourceLink {
    return {
      id: link.id,
      sourceType: link.sourceType,
      targetId: link.targetId,
      uri: link.uri,
      label: link.label,
      hpath: link.hpath,
      role: link.role,
      sortOrder: link.sortOrder,
      deletedAt: link.deletedAt,
      createdAt: link.createdAt,
      updatedAt: link.updatedAt,
    };
  }

  private mapConnection(projectId: string, connection: Connection): BackupConnection {
    return {
      id: connection.id,
      projectId,
      source: connection.source,
      target: connection.target,
      title: connection.title,
      description: connection.description,
      createdAt: undefined,
      updatedAt: connection.updatedAt,
      deletedAt: connection.deletedAt,
    };
  }

  private async collectUserPreferences(
    userId: string | null,
    options: LocalDisasterBackupOptions,
    remoteReadState: RemoteBackupReadState,
  ): Promise<BackupUserPreferences[]> {
    const focusPreferences = this.readValue<unknown>(this.focusPreferenceService.getPreferences?.bind(this.focusPreferenceService))
      ?? this.readValue<unknown>(this.focusPreferenceService.preferences);

    const base: BackupUserPreferences = {
      id: userId ? `local-pref-${userId}` : 'local-pref-anonymous',
      userId: userId ?? AUTH_CONFIG.LOCAL_MODE_USER_ID,
      theme: this.readValue<string>(this.theme.theme) ?? 'default',
      layoutDirection: this.readValue<'ltr' | 'rtl'>(this.uiState.layoutDirection) ?? 'ltr',
      floatingWindowPref: this.readValue<'auto' | 'fixed'>(this.uiState.floatingWindowPref) ?? 'auto',
      colorMode: this.readValue<string>(this.theme.colorMode) ?? 'system',
      autoResolveConflicts: this.readValue<boolean>(this.preferenceService.autoResolveConflicts) ?? true,
      localBackupEnabled: options.autoBackupEnabled,
      localBackupIntervalMs: options.autoBackupIntervalMs,
      focusPreferences,
    };

    const rows = await this.fetchUserScopedRows<SupabaseUserPreferenceRow>('user_preferences', userId, remoteReadState);
    if (rows.length === 0) {
      return [base];
    }

    return rows.map((row) => ({
      ...base,
      id: row.id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  private collectBlackBoxEntries(userId: string | null): BackupBlackBoxEntry[] {
    const entriesMap = this.readValue<Map<string, BackupBlackBoxEntry>>(this.blackBoxService.entriesMap) ?? new Map();
    return Array.from(entriesMap.values()).map((entry) => ({
      ...entry,
    })).filter((entry) => {
      if (!userId) {
        return entry.userId === AUTH_CONFIG.LOCAL_MODE_USER_ID;
      }

      return entry.userId === userId;
    }).map((entry) => ({
      id: entry.id,
      projectId: entry.projectId,
      userId: entry.userId,
      content: entry.content,
      date: entry.date,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      completedAt: entry.completedAt,
      isRead: entry.isRead,
      isCompleted: entry.isCompleted,
      isArchived: entry.isArchived,
      snoozeUntil: entry.snoozeUntil,
      snoozeCount: entry.snoozeCount,
      deletedAt: entry.deletedAt,
      focusMeta: entry.focusMeta,
    }));
  }

  private async collectRemoteUserState(
    userId: string | null,
    remoteReadState: RemoteBackupReadState,
  ): Promise<{
    focusSessions: BackupFocusSession[];
    transcriptionUsage: BackupTranscriptionUsage[];
    routineTasks: BackupRoutineTask[];
    routineCompletions: BackupRoutineCompletion[];
  }> {
    const [focusSessions, transcriptionUsage, routineTasks, routineCompletions] = await Promise.all([
      this.fetchUserScopedRows<SupabaseFocusSessionRow>('focus_sessions', userId, remoteReadState),
      this.fetchUserScopedRows<SupabaseTranscriptionUsageRow>('transcription_usage', userId, remoteReadState),
      this.fetchUserScopedRows<SupabaseRoutineTaskRow>('routine_tasks', userId, remoteReadState),
      this.fetchUserScopedRows<SupabaseRoutineCompletionRow>('routine_completions', userId, remoteReadState),
    ]);

    return {
      focusSessions: focusSessions.map((row) => ({
        id: row.id,
        userId: row.user_id,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        sessionState: row.session_state,
        updatedAt: row.updated_at,
      })),
      transcriptionUsage: transcriptionUsage.map((row) => ({
        id: row.id,
        userId: row.user_id,
        date: row.date,
        audioSeconds: row.audio_seconds,
        createdAt: row.created_at,
      })),
      routineTasks: routineTasks.map((row) => ({
        id: row.id,
        userId: row.user_id,
        title: row.title,
        maxTimesPerDay: row.max_times_per_day,
        isEnabled: row.is_enabled,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
      routineCompletions: routineCompletions.map((row) => ({
        id: row.id,
        routineId: row.routine_id,
        userId: row.user_id,
        dateKey: row.date_key,
        count: row.count,
        updatedAt: row.updated_at,
      })),
    };
  }

  private async fetchUserScopedRows<T>(
    table: BackupTable,
    userId: string | null,
    remoteReadState: RemoteBackupReadState,
  ): Promise<T[]> {
    // 白名单断言（防御性），阻止未来误传非白名单字符串
    if (!BACKUP_TABLES.includes(table)) {
      throw new Error(`[disaster-backup] Unsupported backup table: ${String(table)}`);
    }

    if (!userId || !this.supabase.isConfigured) {
      return [];
    }

    if (isBrowserNetworkSuspendedWindow()) {
      this.markRemoteBackupReadDeferred(remoteReadState, table, 'browser-window');
      return [];
    }

    try {
      const client = this.supabase.client();
      // Supabase 客户端类型对动态表名 union 推导较慢，使用 unknown 收敛于入口
      // 实际类型由白名单 + `T` 参数保证
      const query = (client.from as unknown as (t: BackupTable) => {
        select(cols: string): { eq(col: string, val: string): Promise<{ data: unknown; error: unknown }> };
      })(table).select('*');
      const result = await query.eq('user_id', userId);

      if (result.error) {
        const enhanced = supabaseErrorToError(result.error);
        if (isBrowserNetworkSuspendedError(enhanced)) {
          this.markRemoteBackupReadDeferred(remoteReadState, table, enhanced.errorType);
          return [];
        }

        this.logger.error('Failed to fetch backup table', { table, error: result.error });
        throw new Error(`Backup table ${table} query failed: ${enhanced.message}`);
      }

      return Array.isArray(result.data) ? (result.data as T[]) : [];
    } catch (error) {
      const enhanced = supabaseErrorToError(error);
      if (isBrowserNetworkSuspendedError(enhanced)) {
        this.markRemoteBackupReadDeferred(remoteReadState, table, enhanced.errorType);
        return [];
      }

      throw error;
    }
  }

  private markRemoteBackupReadDeferred(
    remoteReadState: RemoteBackupReadState,
    table: BackupTable,
    reason: string,
  ): void {
    remoteReadState.deferred = true;
    this.logger.debug('备份远端用户状态读取已延后，继续生成本地备份', { table, reason });
  }

  private async collectLocalState(visibleProjectIds: Set<string>): Promise<BackupLocalState> {
    const ownerUserId = this.resolveEffectiveUserId();
    const [
      indexedSnapshot,
      dockSnapshot,
      launchSnapshot,
      parkedTaskCache,
      retryQueue,
      actionQueue,
      deadLetters,
      conflicts,
      externalSourcePendingLinks,
    ] = await Promise.all([
      this.readSnapshotFromIndexedDb(ownerUserId),
      this.readDockSnapshot(ownerUserId),
      this.readLaunchSnapshot(ownerUserId),
      this.readParkedTaskCache(visibleProjectIds),
      this.readRetryQueue(ownerUserId),
      this.readActionQueue(ownerUserId),
      this.readDeadLetters(ownerUserId),
      this.conflictStorage.getAllConflicts(),
      this.externalSourceCache.loadPendingLinks(),
    ]);

    return {
      offlineSnapshot: {
        localStorage: this.readOfflineSnapshotFromLocalStorage(ownerUserId),
        indexedDb: indexedSnapshot,
      },
      dockSnapshot,
      launchSnapshot,
      parkedTaskCache,
      retryQueue,
      actionQueue,
      deadLetters,
      conflicts,
      taskTombstones: this.readTaskTombstones(visibleProjectIds),
      connectionTombstones: this.readConnectionTombstones(visibleProjectIds),
      externalSourcePendingLinks,
    };
  }

  private readTaskTombstones(visibleProjectIds: Set<string>): Record<string, unknown> {
    const parsed = this.safeParseJson(this.safeGetLocalStorage('nanoflow.local-tombstones'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(parsed).filter(([projectId]) => visibleProjectIds.has(projectId)),
    );
  }

  private readConnectionTombstones(visibleProjectIds: Set<string>): unknown[] {
    const parsed = this.safeParseJson(this.safeGetLocalStorage('nanoflow.local-connection-tombstones'));
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter((entry) => {
      if (!entry || typeof entry !== 'object' || !('projectId' in entry)) {
        return false;
      }

      const projectId = entry.projectId;
      return typeof projectId === 'string' && visibleProjectIds.has(projectId);
    });
  }

  private async readSnapshotFromIndexedDb(ownerUserId: string | null): Promise<string | null> {
    if (!ownerUserId) {
      return null;
    }

    const db = await this.openExistingDb('nanoflow-offline-snapshots');
    if (!db) return null;

    try {
      const row = await this.getByKey<{ data?: string }>(
        db,
        'snapshots',
        `${OFFLINE_SNAPSHOT_RECORD_PREFIX}${ownerUserId}`,
      );
      return typeof row?.data === 'string' ? row.data : null;
    } finally {
      db.close();
    }
  }

  private readOfflineSnapshotFromLocalStorage(ownerUserId: string | null): string | null {
    if (!ownerUserId) {
      return null;
    }

    return this.safeGetLocalStorage(`${OFFLINE_SNAPSHOT_STORAGE_KEY}.${ownerUserId}`);
  }

  private async readDockSnapshot(ownerUserId: string | null): Promise<{ localStorage: string | null; indexedDb: unknown | null } | undefined> {
    const db = await this.openExistingDb(DOCK_SNAPSHOT_IDB_DB_NAME);
    const scope = ownerUserId ?? 'anonymous';
    const currentIdbKey = `${DOCK_SNAPSHOT_IDB_KEY_PREFIX}.${scope}`;
    const anonymousIdbKey = ownerUserId === null ? null : `${DOCK_SNAPSHOT_IDB_KEY_PREFIX}.anonymous`;
    const currentLegacyKey = `${PARKING_CONFIG.DOCK_SNAPSHOT_STORAGE_KEY}.${scope}`;
    const anonymousLegacyKey = ownerUserId === null ? null : `${PARKING_CONFIG.DOCK_SNAPSHOT_STORAGE_KEY}.anonymous`;

    const [currentIdbSnapshot, anonymousIdbSnapshot] = db
      ? await Promise.all([
          this.getByKey<unknown>(db, DOCK_SNAPSHOT_IDB_STORE_NAME, currentIdbKey),
          anonymousIdbKey
            ? this.getByKey<unknown>(db, DOCK_SNAPSHOT_IDB_STORE_NAME, anonymousIdbKey)
            : Promise.resolve(null),
        ])
      : [null, null];

    if (db) {
      db.close();
    }

    const newestIndexedDb = this.pickNewerDockSnapshot(
      this.toDockSnapshotCandidate('idb-current', currentIdbSnapshot),
      this.toDockSnapshotCandidate('idb-anonymous', anonymousIdbSnapshot),
    );
    const newestLegacy = this.pickNewerDockSnapshot(
      this.toDockSnapshotCandidate('legacy-current', this.safeGetLocalStorage(currentLegacyKey)),
      this.toDockSnapshotCandidate(
        'legacy-anonymous',
        anonymousLegacyKey ? this.safeGetLocalStorage(anonymousLegacyKey) : null,
      ),
    );

    if (!newestIndexedDb && !newestLegacy) {
      return undefined;
    }

    return {
      localStorage: newestLegacy?.localStorageValue ?? null,
      indexedDb: newestIndexedDb?.snapshot ?? null,
    };
  }

  private toDockSnapshotCandidate(
    source: 'idb-current' | 'idb-anonymous' | 'legacy-current' | 'legacy-anonymous',
    value: unknown,
  ): { source: typeof source; snapshot: unknown & { savedAt: string }; localStorageValue: string | null } | null {
    if (value == null) {
      return null;
    }

    if (source.startsWith('legacy-')) {
      if (typeof value !== 'string') {
        return null;
      }

      const parsed = this.safeParseJson(value);
      const savedAt = this.readDockSnapshotSavedAt(parsed);
      if (!savedAt) {
        return null;
      }

      return {
        source,
        snapshot: { ...(parsed as Record<string, unknown>), savedAt },
        localStorageValue: value,
      };
    }

    const savedAt = this.readDockSnapshotSavedAt(value);
    if (!savedAt || typeof value !== 'object') {
      return null;
    }

    return {
      source,
      snapshot: { ...(value as Record<string, unknown>), savedAt },
      localStorageValue: null,
    };
  }

  private readDockSnapshotSavedAt(value: unknown): string | null {
    if (!value || typeof value !== 'object' || !('savedAt' in value)) {
      return null;
    }

    const savedAt = value.savedAt;
    return typeof savedAt === 'string' && savedAt ? savedAt : null;
  }

  private pickNewerDockSnapshot<T extends { snapshot: { savedAt: string } }>(current: T | null, incoming: T | null): T | null {
    if (!current) return incoming;
    if (!incoming) return current;

    const currentSavedAt = Date.parse(current.snapshot.savedAt);
    const incomingSavedAt = Date.parse(incoming.snapshot.savedAt);
    if (Number.isNaN(incomingSavedAt)) return current;
    if (Number.isNaN(currentSavedAt)) return incoming;
    return incomingSavedAt > currentSavedAt ? incoming : current;
  }

  private async readLaunchSnapshot(ownerUserId: string | null): Promise<{ v1: string | null; v2: string | null } | undefined> {
    const v1 = this.readOwnerScopedLaunchSnapshot(LAUNCH_SNAPSHOT_STORAGE_KEY_V1, ownerUserId);
    const v2 = this.readOwnerScopedLaunchSnapshot(LAUNCH_SNAPSHOT_STORAGE_KEY_V2, ownerUserId);

    if (!v1 && !v2) {
      return undefined;
    }

    return { v1, v2 };
  }

  private readOwnerScopedLaunchSnapshot(storageKey: string, ownerUserId: string | null): string | null {
    const raw = this.safeGetLocalStorage(storageKey);
    if (!raw) {
      return null;
    }

    const parsed = this.safeParseJson(raw);
    if (!this.isLaunchSnapshotOwnedByCurrentUser(parsed, ownerUserId)) {
      return null;
    }

    return raw;
  }

  private isLaunchSnapshotOwnedByCurrentUser(value: unknown, ownerUserId: string | null): boolean {
    if (!value || typeof value !== 'object') {
      return false;
    }

    const snapshotUserId = 'userId' in value ? value.userId : undefined;
    if (typeof snapshotUserId === 'string') {
      return snapshotUserId === ownerUserId;
    }

    return ownerUserId === null;
  }

  private async readParkedTaskCache(visibleProjectIds: Set<string>): Promise<{ entries: unknown[]; syncMetadata: Record<string, unknown> }> {
    const db = await this.openExistingDb(FOCUS_CONFIG.SYNC.IDB_NAME);
    if (!db) {
      return { entries: [], syncMetadata: {} };
    }

    try {
      const [entries, metadataRows] = await Promise.all([
        this.getAllFromStore(db, FOCUS_CONFIG.IDB_STORES.PARKED_TASKS),
        this.getAllFromStore<{ key: string; value: unknown }>(db, FOCUS_CONFIG.IDB_STORES.SYNC_METADATA),
      ]);

      const syncMetadata = Object.fromEntries(
        metadataRows
          .filter((row): row is { key: string; value: unknown } => !!row && typeof row.key === 'string')
          .map((row) => [row.key, row.value]),
      );

      const filteredEntries = entries.filter((entry) => {
        if (!entry || typeof entry !== 'object') {
          return false;
        }

        const projectId = 'projectId' in entry ? entry.projectId : null;
        return typeof projectId === 'string' && visibleProjectIds.has(projectId);
      });

      return {
        entries: filteredEntries,
        syncMetadata: filteredEntries.length > 0 ? syncMetadata : {},
      };
    } finally {
      db.close();
    }
  }

  private async readRetryQueue(ownerUserId: string | null): Promise<unknown[]> {
    if (!ownerUserId) {
      return [];
    }

    const db = await this.openExistingDb('nanoflow-retry-queue');
    const items = db
      ? await (async () => {
          try {
            return await this.getAllFromStore(db, 'offline_mutation_queue');
          } finally {
            db.close();
          }
        })()
      : (this.safeParseJson(this.safeGetLocalStorage('nanoflow.retry-queue')) ?? []) as unknown[];

    return items.filter((item) => this.resolveRetryQueueItemOwner(item) === ownerUserId);
  }

  private async readActionQueue(ownerUserId: string | null): Promise<unknown> {
    if (!ownerUserId) {
      return null;
    }

    const localSnapshot = this.safeParseJson(
      this.readOwnerScopedLocalStorage(LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY, ownerUserId),
    );
    if (localSnapshot !== null) {
      return localSnapshot;
    }

    const db = await this.openExistingDb(ACTION_QUEUE_BACKUP_DB_NAME);
    if (!db) {
      return null;
    }

    try {
      const queueRecordId = `queue:${ownerUserId}`;
      const record = await this.getByKey<{ actions?: unknown }>(db, ACTION_QUEUE_BACKUP_STORE_NAME, queueRecordId);
      return record?.actions ?? null;
    } finally {
      db.close();
    }
  }

  private async readDeadLetters(ownerUserId: string | null): Promise<unknown[]> {
    if (!ownerUserId) {
      return [];
    }

    return (this.safeParseJson(
      this.readOwnerScopedLocalStorage(LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY, ownerUserId),
    ) ?? []) as unknown[];
  }

  private async openExistingDb(name: string): Promise<IDBDatabase | null> {
    if (typeof indexedDB === 'undefined') return null;

    return new Promise((resolve) => {
      let createdDuringOpen = false;
      const request = indexedDB.open(name);

      request.onupgradeneeded = () => {
        createdDuringOpen = true;
        request.transaction?.abort();
      };

      request.onsuccess = () => {
        if (createdDuringOpen) {
          request.result.close();
          resolve(null);
          return;
        }
        resolve(request.result);
      };

      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    });
  }

  private async getAllFromStore<T = unknown>(db: IDBDatabase, storeName: string): Promise<T[]> {
    if (!db.objectStoreNames.contains(storeName)) {
      return [];
    }

    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const request = tx.objectStore(storeName).getAll();
      request.onsuccess = () => resolve((request.result ?? []) as T[]);
      request.onerror = () => reject(request.error);
    });
  }

  private async getByKey<T>(
    db: IDBDatabase,
    storeName: string,
    key: IDBValidKey,
  ): Promise<T | null> {
    if (!db.objectStoreNames.contains(storeName)) {
      return null;
    }

    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const request = tx.objectStore(storeName).get(key);
      request.onsuccess = () => resolve((request.result ?? null) as T | null);
      request.onerror = () => reject(request.error);
    });
  }

  private async calculatePayloadChecksum(payload: BackupData): Promise<string> {
    const json = JSON.stringify({
      ...payload,
      checksum: '',
    });
    return calculateChecksum(json);
  }

  private safeGetLocalStorage(key: string): string | null {
    if (typeof localStorage === 'undefined') return null;
    try {
      return localStorage.getItem(key);
    } catch {
        return null; // eslint-disable-line no-restricted-syntax -- localStorage 访问异常时"无数据"语义正确，null 触发调用方降级
    }
  }

  private safeParseJson(value: string | null): unknown {
    if (!value) return null;
    try {
      return JSON.parse(value);
    } catch {
        return null; // eslint-disable-line no-restricted-syntax -- JSON 解析失败时"无数据"语义正确，null 触发调用方降级
    }
  }

  private readOwnerScopedLocalStorage(baseKey: string, ownerUserId: string): string | null {
    return this.safeGetLocalStorage(`${baseKey}.${ownerUserId}`);
  }

  private resolveRetryQueueItemOwner(item: unknown): string {
    if (!item || typeof item !== 'object') {
      return '__legacy_unknown__';
    }

    const sourceUserId = (item as { sourceUserId?: unknown }).sourceUserId;
    return typeof sourceUserId === 'string' && sourceUserId.length > 0
      ? sourceUserId
      : '__legacy_unknown__';
  }

  private resolveEffectiveUserId(): string | null {
    const currentUserId = this.auth.currentUserId?.();
    if (currentUserId) {
      return currentUserId;
    }

    if (typeof localStorage !== 'undefined' && localStorage.getItem(AUTH_CONFIG.LOCAL_MODE_CACHE_KEY) === 'true') {
      return AUTH_CONFIG.LOCAL_MODE_USER_ID;
    }

    return null;
  }

  private readValue<T>(source: unknown): T | undefined {
    if (typeof source === 'function') {
      return source() as T;
    }
    return source as T | undefined;
  }
}
