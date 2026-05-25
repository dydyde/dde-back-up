/** UserSessionService - 用户会话管理：登录/登出清理、项目切换、数据加载 */
import { Injectable, inject, DestroyRef, Injector, signal } from '@angular/core';
import { AuthService } from './auth.service';
import { SyncCoordinatorService } from './sync-coordinator.service';
import { UndoService } from './undo.service';
import { UiStateService } from './ui-state.service';
import { ProjectStateService } from './project-state.service';
import { ChangeTrackerService } from './change-tracker.service';
import type { AttachmentService } from './attachment.service';
import { ActionQueueService } from './action-queue.service';
import { ConflictStorageService } from './conflict-storage.service';
import { LayoutService } from './layout.service';
import { LoggerService } from './logger.service';
import { SupabaseClientService } from './supabase-client.service';
// eslint-disable-next-line no-restricted-imports -- RetryQueueService 尚未迁移到 src/services/，会话切换需直接清理重试队列
import { RetryQueueService } from '../app/core/services/sync/retry-queue.service';
import { Project, Task, Connection } from '../models';
import { CACHE_CONFIG, SYNC_CONFIG } from '../config/sync.config';
import { AUTH_CONFIG } from '../config/auth.config';
import { FOCUS_CONFIG } from '../config/focus.config';
import { PARKING_CONFIG } from '../config/parking.config';
import { LOCAL_QUEUE_CONFIG } from './action-queue-storage.service';
import {
  DockSnapshotPersistenceService,
} from './dock-snapshot-persistence.service';
import { StartupPlaceholderStateService } from './startup-placeholder-state.service';
import { FEATURE_FLAGS } from '../config/feature-flags.config';
import { isFailure } from '../utils/result';
import { mergeByLww, mergeByLwwWithTombstone } from '../utils/lww-merge';
import { ToastService } from './toast.service';
import { pushStartupTrace } from '../utils/startup-trace';
import { isValidUUID } from '../utils/validation';
import { resetFocusState } from '../state/focus-stores';
import type { LaunchSnapshot, LaunchSnapshotProject, LaunchSnapshotTask } from '../models/launch-shell';

type StartupProjectCatalogStage = 'unresolved' | 'partial' | 'resolved';

interface SessionGuardContext {
  userId: string | null;
  generation: number;
}

const DOCK_SNAPSHOT_DB_NAME = 'keyval-store';

type ProjectHydrationLoadResult =
  | { status: 'loaded'; project: Project }
  | { status: 'inaccessible' }
  | { status: 'retry' }
  | { status: 'stale' };

const FULL_WIPE_LOCAL_STORAGE_PREFIXES = [
  'nanoflow.project-manifest-watermark',
  'nanoflow.blackbox-manifest-watermark',
];

const GUEST_DATA_STORAGE_KEY = 'nanoflow.guest-data';

@Injectable({
  providedIn: 'root'
})
export class UserSessionService {
  private readonly IDLE_TASK_FALLBACK_MS = 1500;
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('UserSession');
  private authService = inject(AuthService);
  private syncCoordinator = inject(SyncCoordinatorService);
  private actionQueue = inject(ActionQueueService);
  private retryQueue = inject(RetryQueueService);
  private conflictStorage = inject(ConflictStorageService);
  private undoService = inject(UndoService);
  private uiState = inject(UiStateService);
  private projectState = inject(ProjectStateService);
  private changeTracker = inject(ChangeTrackerService);
  private startupPlaceholderState = inject(StartupPlaceholderStateService, { optional: true });
  private injector = inject(Injector);
  private layoutService = inject(LayoutService);
  private toastService = inject(ToastService);
  private supabase = inject(SupabaseClientService);
  private dockSnapshotPersistence = inject(DockSnapshotPersistenceService);
  private destroyRef = inject(DestroyRef);
  private attachmentServiceRef: AttachmentService | null = null;
  private attachmentServicePromise: Promise<AttachmentService | null> | null = null;
  private prehydratedSnapshotApplied = false;
  private prehydratedSnapshotOwnerId: string | null = null;
  private sessionRequestGeneration = 0;
  private readonly lastProjectListMetadataSyncSucceededState = signal(false);
  private readonly authoritativelyAccessibleProjectIdsState = signal<ReadonlySet<string>>(new Set());
  private readonly startupProjectCatalogStageState = signal<StartupProjectCatalogStage>('unresolved');
  private readonly trustedPrehydratedSnapshotState = signal(false);
  /** 已从云端完整加载过内容的项目 ID 集合，防止重复加载 */
  private readonly hydratedProjectIds = new Set<string>();
  /** 正在加载中的项目 ID，防止并发重复请求 */
  private readonly hydrationInFlight = new Map<string, Promise<void>>();

  readonly startupProjectCatalogStage = this.startupProjectCatalogStageState.asReadonly();
  readonly trustedPrehydratedSnapshotVisible = this.trustedPrehydratedSnapshotState.asReadonly();

  canAuthoritativelyRejectProjectRoute(): boolean {
    const currentUserId = this.currentUserId();
    if (!currentUserId || currentUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      return this.startupProjectCatalogStage() === 'resolved';
    }

    return this.lastProjectListMetadataSyncSucceededState();
  }

  isProjectAuthoritativelyAccessible(projectId: string): boolean {
    const normalizedProjectId = typeof projectId === 'string' ? projectId.trim() : '';
    if (!normalizedProjectId) {
      return false;
    }

    const localProject = this.projectState.getProject(normalizedProjectId);

    const currentUserId = this.currentUserId();
    if (!currentUserId || currentUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      return localProject != null;
    }

    if (this.authoritativelyAccessibleProjectIdsState().has(normalizedProjectId)) {
      return true;
    }

    if (!localProject) {
      return false;
    }

    const guestDraftProjectIds = this.getPersistedGuestDraftProjectIds();
    return this.isProtectedLocalOnlyProject(localProject, guestDraftProjectIds)
      || this.hasRealLocalChanges(normalizedProjectId);
  }

  isHintOnlyStartupPlaceholderVisible(): boolean {
    return this.startupPlaceholderState?.isHintOnlyActive() ?? false;
  }

  getLaunchSnapshotPersistOwnerDuringAuthSettle(): string | null {
    if (!this.prehydratedSnapshotApplied || this.isHintOnlyStartupPlaceholderVisible()) {
      return null;
    }

    return this.prehydratedSnapshotOwnerId;
  }

  /** 当前用户 ID (代理 AuthService) */
  readonly currentUserId = this.authService.currentUserId;

  constructor() {
    this.destroyRef.onDestroy(() => {
      // 仅在附件服务已初始化时清理，避免销毁阶段反向触发懒加载
      const loadedService = this.attachmentServiceRef;
      if (loadedService) {
        loadedService.clearUrlRefreshCallback();
        loadedService.clearMonitoredAttachments();
        return;
      }

      const pendingService = this.attachmentServicePromise;
      if (!pendingService) return;

      void pendingService
        .then((service) => {
          service?.clearUrlRefreshCallback();
          service?.clearMonitoredAttachments();
        })
        .catch(() => {
          // 销毁阶段静默忽略
        });
    });

    if (!FEATURE_FLAGS.USER_SESSION_ATTACHMENT_ON_DEMAND_V1) {
      void this.getAttachmentServiceLazy();
    }
  }

  async getAttachmentServiceLazy(): Promise<AttachmentService | null> {
    if (this.attachmentServiceRef) {
      return this.attachmentServiceRef;
    }

    if (this.attachmentServicePromise) {
      return this.attachmentServicePromise;
    }

    this.attachmentServicePromise = import('./attachment.service')
      .then((module) => {
        const service = this.injector.get(module.AttachmentService);
        this.attachmentServiceRef = service;
        return service;
      })
      .catch((error) => {
        this.logger.warn('AttachmentService 懒加载失败，降级为无附件监控', error);
        return null;
      })
      .finally(() => {
        this.attachmentServicePromise = null;
      });

    return this.attachmentServicePromise;
  }

  /**
   * 从启动快照预填充 Store（使 handoff 不再等待 auth + 数据加载）
   *
   * 【P0 新增 2026-03-27】
   * 冷启动时从 localStorage 中已有的 launch-snapshot 构建轻量 Project 列表，
   * 使 ProjectStore.projects().length > 0 立即成立，
   * 从而解除 handoff 对 auth 完成的阻塞依赖。
   *
   * 仅在 Store 为空时填充（避免覆盖已有真实数据）。
   * 后续 loadUserData() 完成后会用完整数据替换。
   *
   * @returns 是否成功预填充
   */
  prehydrateFromSnapshot(): boolean {
    // Store 已有数据，无需预填充
    if (this.projectState.projects().length > 0) {
      this.markStartupProjectCatalogResolved();
      return true;
    }

    const snapshot = this.readSnapshotForPrehydrate();
    if (snapshot?.projects?.length) {
      const trustedSnapshotOwnerId = this.resolveTrustedSnapshotOwnerId(snapshot);
      if (trustedSnapshotOwnerId) {
        try {
          const projects = this.buildPrehydrateProjects(snapshot.projects);
          if (projects.length > 0) {
            this.projectState.setProjects(projects);
            this.projectState.setActiveProjectId(
              snapshot.activeProjectId ?? projects[0]?.id ?? null,
            );
            this.startupPlaceholderState?.clear();
            this.prehydratedSnapshotApplied = true;
            this.prehydratedSnapshotOwnerId = trustedSnapshotOwnerId;
            this.trustedPrehydratedSnapshotState.set(true);
            this.startupProjectCatalogStageState.set('partial');

            // 【P1 秒开优化 2026-03-31】预设临时 userId，使 coreDataLoaded 立即生效。
            // checkSession 完成后会确认或覆盖此值。对个人项目始终为同一用户，无副作用。
            if (trustedSnapshotOwnerId !== AUTH_CONFIG.LOCAL_MODE_USER_ID) {
              this.authService.setProvisionalCurrentUserId(trustedSnapshotOwnerId);
            }

            pushStartupTrace('user_session.snapshot_prehydrate', {
              projectCount: projects.length,
              activeProjectId: snapshot.activeProjectId,
              snapshotUserId: this.prehydratedSnapshotOwnerId,
            });
            this.logger.debug('快照预填充完成', { projectCount: projects.length });
            return true;
          }
        } catch (error) {
          this.logger.warn('快照预填充失败，静默回退到离线快照', error);
        }
      } else {
        this.logger.debug('跳过未验证 owner 的启动快照预填充', {
          snapshotUserId: snapshot.userId ?? null,
        });
      }
    }

    if (this.prehydrateFromOfflineSnapshot(snapshot)) {
      return true;
    }

    this.clearStartupProjectCatalogState();
    return false;
  }

  private clearStartupProjectCatalogState(): void {
    this.startupPlaceholderState?.clear();
    this.prehydratedSnapshotApplied = false;
    this.prehydratedSnapshotOwnerId = null;
    this.trustedPrehydratedSnapshotState.set(false);
    this.startupProjectCatalogStageState.set('unresolved');
  }

  private markStartupProjectCatalogResolved(): void {
    this.startupPlaceholderState?.clear();
    this.trustedPrehydratedSnapshotState.set(false);
    this.startupProjectCatalogStageState.set('resolved');
  }

  private markStartupProjectCatalogAwaitingRemoteResolution(options?: { retainHintPlaceholder?: boolean }): void {
    if (!options?.retainHintPlaceholder) {
      this.startupPlaceholderState?.clear();
    }
    this.trustedPrehydratedSnapshotState.set(false);
    this.startupProjectCatalogStageState.set('partial');
  }

  private syncStartupProjectCatalogStageAfterLocalRestore(userId: string | null): void {
    if (userId && userId !== AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      this.markStartupProjectCatalogAwaitingRemoteResolution();
      return;
    }

    this.markStartupProjectCatalogResolved();
  }

  private resolvePrehydrateOwnerUserId(): string {
    const currentUserId = this.currentUserId();
    if (currentUserId) {
      return currentUserId;
    }

    if (!this.authService.isConfigured) {
      return AUTH_CONFIG.LOCAL_MODE_USER_ID;
    }

    return this.authService.peekPersistedSessionIdentity()?.userId
      ?? this.authService.peekPersistedOwnerHint()
      ?? AUTH_CONFIG.LOCAL_MODE_USER_ID;
  }

  private hasConfirmedPrehydrateOwner(ownerUserId: string): boolean {
    if (ownerUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      return true;
    }

    if (!this.authService.isConfigured) {
      return true;
    }

    const currentUserId = this.currentUserId();
    if (currentUserId === ownerUserId) {
      return true;
    }

    if (this.authService.peekPersistedSessionIdentity()?.userId === ownerUserId) {
      return true;
    }

    // PWA 数据为设备本地存储，owner hint 表示用户曾在此设备登录过。
    // access token 过期但 refresh token 仍可恢复时，信任本地数据归属，
    // 避免冷启动出现"正在确认会话"只读遮罩阻塞用户操作。
    return this.authService.peekPersistedOwnerHint() === ownerUserId;
  }

  private cloneOfflineProjectsForPrehydrate(projects: Project[]): Project[] {
    return projects.map((project) => ({
      ...project,
      tasks: Array.isArray(project.tasks) ? [...project.tasks] : [],
      connections: Array.isArray(project.connections) ? [...project.connections] : [],
    }));
  }

  private buildHintScopedPlaceholderProjects(projects: Project[]): Project[] {
    return projects.map((project, index) => ({
      id: project.id,
      name: `Project ${index + 1}`,
      description: '',
      createdDate: project.createdDate,
      updatedAt: project.updatedAt,
      version: project.version,
      syncSource: project.syncSource,
      pendingSync: project.pendingSync,
      tasks: [],
      connections: [],
    }));
  }

  private prehydrateFromOfflineSnapshot(snapshot: LaunchSnapshot | null): boolean {
    const core = this.syncCoordinator.core as {
      loadOfflineSnapshot?: (options?: { allowOwnerHint?: boolean }) => Project[] | null;
    };
    if (typeof core.loadOfflineSnapshot !== 'function') {
      return false;
    }

    const offlineProjects = core.loadOfflineSnapshot({ allowOwnerHint: true });
    if (!offlineProjects?.length) {
      return false;
    }

    const ownerUserId = this.resolvePrehydrateOwnerUserId();
    const ownerConfirmed = this.hasConfirmedPrehydrateOwner(ownerUserId);
    const projects = ownerConfirmed
      ? this.cloneOfflineProjectsForPrehydrate(offlineProjects)
      : this.buildHintScopedPlaceholderProjects(offlineProjects);
    const preferredProjectId = snapshot?.activeProjectId ?? null;
    const activeProjectId = preferredProjectId && projects.some((project) => project.id === preferredProjectId)
      ? preferredProjectId
      : projects[0]?.id ?? null;

    this.projectState.setProjects(projects);
    this.projectState.setActiveProjectId(activeProjectId);
    if (ownerConfirmed) {
      this.startupPlaceholderState?.clear();
      // 【P1 秒开优化 2026-03-31】离线快照 owner 已确认时也预设 userId，
      // 使 coreDataLoaded 提前生效，消除等待 auth 的 UI 空档。
      if (ownerUserId !== AUTH_CONFIG.LOCAL_MODE_USER_ID) {
        this.authService.setProvisionalCurrentUserId(ownerUserId);
      }
    } else {
      this.startupPlaceholderState?.activate(ownerUserId);
    }
    this.prehydratedSnapshotApplied = true;
    this.prehydratedSnapshotOwnerId = ownerUserId;
    if (ownerConfirmed) {
      this.syncStartupProjectCatalogStageAfterLocalRestore(ownerUserId);
    } else {
      this.markStartupProjectCatalogAwaitingRemoteResolution({ retainHintPlaceholder: true });
    }

    pushStartupTrace('user_session.offline_snapshot_prehydrate', {
      projectCount: projects.length,
      activeProjectId,
      ownerUserId,
      ownerConfirmed,
    });
    this.logger.debug('离线快照预填充完成', {
      projectCount: projects.length,
      ownerUserId,
      ownerConfirmed,
    });
    return true;
  }

  private resolveTrustedSnapshotOwnerId(snapshot: LaunchSnapshot): string | null {
    const snapshotUserId = typeof snapshot.userId === 'string' && snapshot.userId.length > 0
      ? snapshot.userId
      : null;

    const persistedSessionUserId = this.authService.peekPersistedSessionIdentity()?.userId ?? null;
    const persistedOwnerHint = this.authService.peekPersistedOwnerHint()
      ?? persistedSessionUserId
      ?? null;

    const currentUserId = this.currentUserId();
    const runtimeOwnerHint = currentUserId ?? persistedOwnerHint;

    if (snapshotUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      if (this.authService.isConfigured
        && typeof runtimeOwnerHint === 'string'
        && runtimeOwnerHint.length > 0
        && runtimeOwnerHint !== AUTH_CONFIG.LOCAL_MODE_USER_ID) {
        return null;
      }

      return snapshotUserId;
    }

    if (!this.authService.isConfigured) {
      return snapshotUserId ?? AUTH_CONFIG.LOCAL_MODE_USER_ID;
    }

    if (!snapshotUserId) {
      return null;
    }

    if (currentUserId === snapshotUserId) {
      return snapshotUserId;
    }

    return persistedSessionUserId === snapshotUserId
      ? snapshotUserId
      : null;
  }

  private shouldPreservePrehydratedSelection(userId: string | null): boolean {
    return !!userId
      && this.prehydratedSnapshotApplied
      && this.prehydratedSnapshotOwnerId !== null
      && this.prehydratedSnapshotOwnerId === userId;
  }

  /** 读取全局或 localStorage 中的启动快照 */
  private readSnapshotForPrehydrate(): LaunchSnapshot | null {
    if (typeof window === 'undefined') return null;

    // 优先读取 index.html 内联脚本已注入的全局快照
    const globalSnap = (
      window as Window & { __NANOFLOW_LAUNCH_SNAPSHOT__?: unknown }
    ).__NANOFLOW_LAUNCH_SNAPSHOT__;
    if (globalSnap && typeof globalSnap === 'object' && 'projects' in globalSnap) {
      return globalSnap as LaunchSnapshot;
    }

    // 回退读取 localStorage
    try {
      const raw = localStorage.getItem('nanoflow.launch-snapshot.v2');
      if (!raw) return null;
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && 'projects' in parsed) {
        return parsed as LaunchSnapshot;
      }
    } catch {
      // 损坏的 localStorage 数据，静默忽略
    }

    return null;
  }

  /** 从快照 projects 构建轻量 Project 对象供 Store 预填充 */
  private buildPrehydrateProjects(snapshotProjects: LaunchSnapshotProject[]): Project[] {
    // 安全限制：最多预填充 50 个项目，防止恶意 localStorage 注入导致内存/渲染爆炸
    const MAX_PREHYDRATE_PROJECTS = 50;
    const MAX_RECENT_TASKS = 20;
    const MAX_NAME_LENGTH = 200;
    const now = new Date().toISOString();
    const results: Project[] = [];

    for (const sp of snapshotProjects.slice(0, MAX_PREHYDRATE_PROJECTS)) {
      // 安全校验：ID 必须是合法 UUID，防止注入恶意字符串
      if (!sp.id || typeof sp.id !== 'string' || !isValidUUID(sp.id)) continue;

      const tasks: Task[] = (sp.recentTasks ?? [])
        .slice(0, MAX_RECENT_TASKS)
        .filter((t: LaunchSnapshotTask) => t.id && typeof t.id === 'string' && isValidUUID(t.id))
        .map((t: LaunchSnapshotTask, idx: number) => ({
          id: t.id,
          title: this.sanitizeSnapshotString(t.title, MAX_NAME_LENGTH),
          content: this.sanitizeSnapshotString(t.title, MAX_NAME_LENGTH),
          stage: null,
          parentId: null,
          order: idx,
          rank: 10000 + idx,
          status: t.status || 'active',
          x: 0,
          y: 0,
          createdDate: now,
          displayId: t.displayId || '?',
        }));

      results.push({
        id: sp.id,
        name: this.sanitizeSnapshotString(sp.name, MAX_NAME_LENGTH) || 'Untitled',
        description: this.sanitizeSnapshotString(sp.description, MAX_NAME_LENGTH),
        createdDate: now,
        updatedAt: sp.updatedAt ?? now,
        tasks,
        connections: [],
      });
    }

    return results;
  }

  /** 清理快照字段：截断过长文本，去除可能的 HTML 标签 */
  private sanitizeSnapshotString(value: unknown, maxLength: number): string {
    if (typeof value !== 'string') return '';
    // 去除可能的 HTML 标签（Angular 模板默认转义，但多一层防护）
    const cleaned = value.replace(/<[^>]*>/g, '');
    return cleaned.length > maxLength ? cleaned.slice(0, maxLength) : cleaned;
  }

  private createSessionGuard(userId: string | null): SessionGuardContext {
    return {
      userId,
      generation: ++this.sessionRequestGeneration,
    };
  }

  private captureCurrentSessionGuard(): SessionGuardContext {
    return {
      userId: this.currentUserId(),
      generation: this.sessionRequestGeneration,
    };
  }

  private invalidateSessionRequestGeneration(reason: string): void {
    this.sessionRequestGeneration += 1;
    this.logger.debug('会话请求代际已失效', {
      reason,
      generation: this.sessionRequestGeneration,
    });
  }

  private resetProjectHydrationCache(): void {
    this.hydratedProjectIds.clear();
    this.hydrationInFlight.clear();
  }

  private isSessionGuardCurrent(guard: SessionGuardContext): boolean {
    return this.sessionRequestGeneration === guard.generation
      && this.currentUserId() === guard.userId;
  }

  private shouldAbortStaleSession(guard: SessionGuardContext | undefined, stage: string): boolean {
    if (!guard) {
      return false;
    }

    if (this.isSessionGuardCurrent(guard)) {
      return false;
    }

    this.logger.debug('忽略过期的会话加载结果', {
      stage,
      expectedUserId: guard.userId,
      currentUserId: this.currentUserId(),
      generation: guard.generation,
      currentGeneration: this.sessionRequestGeneration,
    });
    return true;
  }

  private shouldAbortStaleSessionGeneration(guard: SessionGuardContext | undefined, stage: string): boolean {
    if (!guard) {
      return false;
    }

    if (this.sessionRequestGeneration === guard.generation) {
      return false;
    }

    this.logger.debug('忽略过期的会话预处理结果', {
      stage,
      expectedUserId: guard.userId,
      currentUserId: this.currentUserId(),
      generation: guard.generation,
      currentGeneration: this.sessionRequestGeneration,
    });
    return true;
  }

  private redactUserId(userId: string | null): string | null {
    return userId ? userId.substring(0, 8) : null;
  }

  private formatUnknownError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private async isSupabaseSessionCurrentForUser(userId: string, stage: string): Promise<boolean> {
    if (!userId || userId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      return true;
    }

    try {
      const { data, error } = await this.supabase.getSession();
      if (error) {
        this.logger.warn('Supabase session 未就绪，跳过本轮权威项目访问判定', {
          stage,
          expectedUserId: this.redactUserId(userId),
          error: error.message,
        });
        return false;
      }

      const sessionUserId = data.session?.user?.id ?? null;
      if (sessionUserId !== userId) {
        this.logger.warn('Supabase session 与当前用户不一致，跳过本轮权威项目访问判定', {
          stage,
          expectedUserId: this.redactUserId(userId),
          sessionUserId: this.redactUserId(sessionUserId),
        });
        return false;
      }

      return true;
    } catch (error: unknown) {
      this.logger.warn('读取 Supabase session 失败，跳过本轮权威项目访问判定', {
        stage,
        expectedUserId: this.redactUserId(userId),
        error: this.formatUnknownError(error),
      });
      return false;
    }
  }

  getCurrentSessionGeneration(): number {
    return this.sessionRequestGeneration;
  }

  isSessionContextCurrent(sessionGeneration: number, userId: string | null): boolean {
    return this.sessionRequestGeneration === sessionGeneration
      && this.currentUserId() === userId;
  }

  private getSnapshotProjectsForSession(
    snapshot: { ownerUserId?: string | null; projects: Project[] },
    expectedUserId: string | null | undefined,
    stage: string
  ): { projects: Project[]; ownerMatched: boolean } {
    const expectedOwnerUserId = expectedUserId ?? AUTH_CONFIG.LOCAL_MODE_USER_ID;
    const hasSnapshotProjects = snapshot.projects.length > 0;
    if (!snapshot.ownerUserId) {
      // 旧版快照可能缺少 ownerUserId 字段，尝试通过 persisted hint 推断归属
      if (this.authService.isConfigured && hasSnapshotProjects) {
        const persistedOwnerHint = this.authService.peekPersistedOwnerHint() ?? null;
        if (persistedOwnerHint && persistedOwnerHint === expectedOwnerUserId) {
          this.logger.debug('缺少 owner 元数据的快照通过 persisted hint 匹配，允许恢复', {
            stage,
            expectedOwnerUserId,
            persistedOwnerHint,
            projectCount: snapshot.projects.length,
          });
          return { projects: snapshot.projects, ownerMatched: true };
        }
      }

      if (hasSnapshotProjects) {
        this.logger.warn('检测到缺少 owner 元数据的离线快照，已忽略本次恢复', {
          stage,
          expectedOwnerUserId,
        });
      }

      return { projects: [], ownerMatched: false };
    }

    if (snapshot.ownerUserId !== expectedOwnerUserId) {
      // 降级会话场景：Supabase 已配置但会话过期/网络不可达时，
      // expectedUserId 为 null → 'local-user'，而快照 owner 是真实用户 ID。
      // 通过 persisted owner hint 匹配，避免同一设备用户看到空工作区。
      if (this.authService.isConfigured) {
        const persistedOwnerHint = this.authService.peekPersistedOwnerHint() ?? null;
        if (persistedOwnerHint && snapshot.ownerUserId === persistedOwnerHint) {
          this.logger.debug('owner 通过 persisted hint 匹配，允许恢复离线快照', {
            stage,
            snapshotOwnerUserId: snapshot.ownerUserId,
            persistedOwnerHint,
          });
          return { projects: snapshot.projects, ownerMatched: true };
        }
      }

      if (hasSnapshotProjects) {
        this.logger.warn('检测到 owner 不匹配的离线快照，已忽略本次恢复', {
          stage,
          snapshotOwnerUserId: snapshot.ownerUserId,
          expectedOwnerUserId,
        });
      }

      return { projects: [], ownerMatched: false };
    }

    return { projects: snapshot.projects, ownerMatched: true };
  }

  private async resolveGuestDraftProjectsForCloudLogin(
    targetUserId: string | null,
    sessionGuard: SessionGuardContext
  ): Promise<Project[]> {
    if (!targetUserId || targetUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      return [];
    }

    if (this.isHintOnlyStartupPlaceholderVisible()) {
      this.logger.debug('hint-only 启动占位不参与 guest draft 迁移', {
        targetUserId,
      });
      return [];
    }

    const localGuestProjects = this.projectState.projects()
      .filter(project => project.syncSource === 'local-only')
      .map(project => this.migrateProject(project));
    if (localGuestProjects.length > 0) {
      return localGuestProjects;
    }

    const startupSnapshot = await this.loadStartupSnapshotResult();
    if (this.shouldAbortStaleSessionGeneration(sessionGuard, 'setCurrentUser:guest-drafts-snapshot')) {
      return [];
    }

    if (startupSnapshot.ownerUserId !== AUTH_CONFIG.LOCAL_MODE_USER_ID || startupSnapshot.projects.length === 0) {
      return [];
    }

    return startupSnapshot.projects.map(project => this.migrateProject(project));
  }

  private async saveProjectsToOfflineSnapshot(
    projects: Project[],
    ownerUserId: string | null,
    options?: { allowEmpty?: boolean },
  ): Promise<void> {
    if (projects.length === 0 && !options?.allowEmpty) {
      return;
    }

    const core = this.syncCoordinator.core as {
      saveOfflineSnapshot: (projects: Project[], ownerUserId?: string | null) => Promise<void> | void;
      saveOfflineSnapshotAndWait?: (projects: Project[], ownerUserId?: string | null) => Promise<void>;
    };

    if (typeof core.saveOfflineSnapshotAndWait === 'function') {
      await core.saveOfflineSnapshotAndWait(projects, ownerUserId);
      return;
    }

    await core.saveOfflineSnapshot(projects, ownerUserId);
  }

  private sanitizePreviousUserIdHint(previousUserIdHint: string | null): string | null {
    if (!previousUserIdHint) {
      return null;
    }

    if (this.currentUserId() === AUTH_CONFIG.LOCAL_MODE_USER_ID && previousUserIdHint !== AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      return null;
    }

    return previousUserIdHint;
  }

  private canPersistCurrentProjectsForPreviousOwner(): boolean {
    if (this.isHintOnlyStartupPlaceholderVisible()) {
      return false;
    }

    if (this.prehydratedSnapshotApplied && this.startupProjectCatalogStage() !== 'resolved') {
      return false;
    }

    return true;
  }

  private forceClearCurrentSessionView(): void {
    this.projectState.setActiveProjectId(null);
    this.projectState.setProjects([]);
    this.clearStartupProjectCatalogState();
    this.uiState.clearAllState();
    this.actionQueue.clearCurrentView();
    this.retryQueue.clearCurrentView();
    this.changeTracker.clearAllChanges();
    resetFocusState();
    this.undoService.clearHistory();
    this.syncCoordinator.clearActiveConflict();
    this.syncCoordinator.core.teardownRealtimeSubscription();
  }

  /**
   * 设置当前用户（登录/登出时调用，总是会加载项目数据）
   * @param userId 用户 ID，null 表示登出
   * @param opts.forceLoad 强制加载数据，跳过 isUserChange 检查（登录时必须为 true）
   * @param opts.skipPersistentReload 仅切换身份与清空内存，不重新加载任何本地持久化数据；
   *  用于 full wipe 失败后的安全登出，避免旧快照被重新灌回匿名态。
   * @param opts.previousUserIdHint 当前 auth signal 已提前清空时，仍用于完成旧 owner 的安全 teardown。
   * @param opts.preserveOfflineSnapshot 仅清理内存视图，不清空旧 owner 的离线快照桶。
   */
  async setCurrentUser(
    userId: string | null,
    opts?: {
      forceLoad?: boolean;
      skipPersistentReload?: boolean;
      previousUserIdHint?: string | null;
      preserveOfflineSnapshot?: boolean;
    }
  ): Promise<void> {
    const sessionGuard = this.createSessionGuard(userId);
    const previousUserIdHint = this.sanitizePreviousUserIdHint(opts?.previousUserIdHint ?? null);
    const previousUserId = previousUserIdHint ?? this.currentUserId();
    const isUserChange = previousUserId !== userId;
    const forceLoad = opts?.forceLoad ?? false;
    const skipPersistentReload = opts?.skipPersistentReload ?? false;
    const preserveOfflineSnapshot = opts?.preserveOfflineSnapshot ?? false;
    const shouldPreservePrehydratedSelection = this.shouldPreservePrehydratedSelection(userId);
    const shouldClearPrehydratedSnapshotState = forceLoad && !shouldPreservePrehydratedSelection;
    
    this.logger.debug('setCurrentUser', {
      previousUserId: previousUserId?.substring(0, 8),
      newUserId: userId?.substring(0, 8),
      isUserChange,
      forceLoad
    });
    pushStartupTrace('user_session.set_current_user', {
      previousUserId,
      userId,
      isUserChange,
      forceLoad,
    });

    if (isUserChange || forceLoad) {
      this.lastProjectListMetadataSyncSucceededState.set(false);
      this.authoritativelyAccessibleProjectIdsState.set(new Set());
    }
    
    // 清理旧用户的附件监控和回调，防止内存泄漏
    if (isUserChange || forceLoad) {
      // 【P1 修复 2026-04-03】将可失败的异步 I/O 操作与必须成功的同步清理分离。
      // 之前整块 try-catch 导致任何一个异步操作（IDB/网络）失败就跳过全部同步清理，
      // 触发 forceClearCurrentSessionView 再次失败的级联告警。
      this.attachmentServiceRef?.clearMonitoredAttachments();
      this.resetProjectHydrationCache();

      // === 阶段 1：可失败的异步持久化操作（单独 try-catch） ===
      let preservedGuestProjects: Project[] = [];
      let shouldClearOfflineSnapshot = !preserveOfflineSnapshot;

      try {
        const isCloudBackedLogin = !!userId && userId !== AUTH_CONFIG.LOCAL_MODE_USER_ID;
        preservedGuestProjects = isCloudBackedLogin
          && (!previousUserId || previousUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID)
          ? await this.resolveGuestDraftProjectsForCloudLogin(userId, sessionGuard)
          : [];
      } catch (guestDraftError) {
        this.logger.warn('解析游客草稿失败，降级为无草稿模式', guestDraftError);
      }
      if (this.shouldAbortStaleSessionGeneration(sessionGuard, 'setCurrentUser:guest-drafts-resolved')) {
        return;
      }

      const shouldPreserveGuestDrafts = preservedGuestProjects.length > 0;
      const shouldResetProjectSelection = isUserChange && previousUserId !== null && !shouldPreserveGuestDrafts;
      const shouldFlushPendingPersist = !skipPersistentReload && (isUserChange || shouldClearPrehydratedSnapshotState);
      shouldClearOfflineSnapshot = !shouldPreserveGuestDrafts && !preserveOfflineSnapshot;

      const canPersistCurrentProjectsForPreviousOwner = this.canPersistCurrentProjectsForPreviousOwner();
      if (preserveOfflineSnapshot && previousUserId !== null && !shouldPreserveGuestDrafts && canPersistCurrentProjectsForPreviousOwner) {
        try {
          await this.saveProjectsToOfflineSnapshot(this.projectState.getProjectsWithCurrentData(), previousUserId);
        } catch (snapshotError) {
          this.logger.warn('保存旧用户离线快照失败，继续清理', snapshotError);
        }
        if (this.shouldAbortStaleSessionGeneration(sessionGuard, 'setCurrentUser:preserve-offline-snapshot')) {
          return;
        }
      }

      if (shouldFlushPendingPersist) {
        try {
          shouldClearOfflineSnapshot = await this.syncCoordinator.preparePendingPersistForOwnerChange(
            previousUserId,
            `owner-switch:${previousUserId ?? 'anonymous'}->${userId ?? 'anonymous'}`
          );
        } catch (persistError) {
          this.logger.warn('刷盘待持久化数据失败，继续清理', persistError);
        }
      }

      if (shouldPreserveGuestDrafts) {
        // 中文注释：先把游客草稿重新落盘，再清理歧义队列，避免登录瞬间丢失唯一离线副本。
        try {
          await this.saveProjectsToOfflineSnapshot(preservedGuestProjects, userId);
        } catch (guestSaveError) {
          this.logger.warn('保存游客草稿快照失败，继续清理', guestSaveError);
        }
        if (this.shouldAbortStaleSessionGeneration(sessionGuard, 'setCurrentUser:guest-drafts-saved')) {
          return;
        }
      }

      // === 阶段 2：必须成功的同步状态清理（不依赖外部 I/O） ===
      // 冷启动 bootstrap(forceLoad) 允许继续沿用「已确认归属于当前用户」的 launch snapshot。
      // 若快照 owner 缺失或与当前 userId 不一致，则必须立即清空，避免旧账号项目短暂暴露。
      if ((shouldResetProjectSelection || shouldClearPrehydratedSnapshotState) && !shouldPreserveGuestDrafts) {
        this.projectState.setActiveProjectId(null);
      }
      // 【P0 修复 2026-02-08 / 2026-03-27 加固】
      // 仅在用户切换（旧用户→新用户）或快照不可信时清空项目列表。
      // 合并两个分支，避免 setProjects([]) 被触发两次产生信号风暴。
      // 从 null→userId（冷启动首次登录）不清空，因为 store 本来就是空的。
      const shouldClearProjects = !shouldPreserveGuestDrafts && (
        shouldClearPrehydratedSnapshotState
        || (isUserChange && previousUserId !== null)
      );
      if (shouldClearProjects) {
        this.projectState.setProjects([]);
        this.clearStartupProjectCatalogState();
      }
      if ((isUserChange && previousUserId !== null) || shouldPreserveGuestDrafts) {
        this.actionQueue.clearCurrentView();
        this.retryQueue.clearCurrentView();
        if (!shouldPreserveGuestDrafts && shouldClearOfflineSnapshot) {
          this.syncCoordinator.core.clearOfflineSnapshot();
        }
      }
      if (isUserChange && previousUserId !== null) {
        this.changeTracker.clearAllChanges();
        this.uiState.clearAllState();
        resetFocusState();
      }
      this.undoService.clearHistory();
      this.syncCoordinator.clearActiveConflict();
      this.syncCoordinator.core.teardownRealtimeSubscription();
    }

    this.authService.currentUserId.set(userId);
    if (this.shouldAbortStaleSession(sessionGuard, 'setCurrentUser:after-auth-set')) {
      return;
    }

    try {
      if (skipPersistentReload) {
        this.actionQueue.clearCurrentView();
        this.retryQueue.clearCurrentView();
      } else {
        this.actionQueue.reloadFromStorageForCurrentOwner();
        this.retryQueue.reloadFromStorageForCurrentOwner();
      }
    } catch (queueReloadError) {
      this.logger.warn('重新加载持久化队列失败，静默继续', queueReloadError);
    }

    try {
      await this.conflictStorage.refreshConflictCount();
    } catch (conflictError) {
      this.logger.warn('刷新冲突计数失败，静默继续', conflictError);
    }

    if (skipPersistentReload) {
      return;
    }

    if (userId) {
      // 【P0 修复 2026-02-08】forceLoad=true 时强制加载数据
      // 修复竞态 bug：signIn() 提前设置 currentUserId 导致 isUserChange=false，
      // 加上种子数据 hasProjects=true，loadUserData 被错误跳过。
      const hasProjects = this.projectState.projects().length > 0;
      if (forceLoad || !hasProjects || isUserChange) {
        try {
          await this.loadUserData(userId, sessionGuard);
        } catch (error) {
          // loadUserData 内部已有错误处理，这里是最后的防线
          this.logger.warn('loadUserData 失败', error);
          // 降级处理：至少加载种子数据
          try {
            await this.loadFromCacheOrSeed(undefined, sessionGuard);
          } catch (fallbackError) {
            this.logger.warn('降级加载种子数据也失败', fallbackError);
            // 即使种子数据加载失败，也不阻断应用启动
          }
          // 不重新抛出异常，避免阻断应用启动
        }
      }
    } else {
      try {
        await this.loadFromCacheOrSeed(undefined, sessionGuard);
      } catch (error) {
        this.logger.warn('loadFromCacheOrSeed 失败', error);
        // 不重新抛出异常
      }
    }
  }

  /** 切换活动项目 */
  switchActiveProject(projectId: string | null): void {
    const previousProjectId = this.projectState.activeProjectId();

    if (previousProjectId === projectId) return;

    // 清理搜索状态
    this.uiState.clearSearch();

    // 先 flush 待处理的防抖操作
    this.undoService.flushPendingAction();

    // 清空之前项目的撤销历史
    if (previousProjectId) {
      this.undoService.onProjectSwitch(previousProjectId);
    }

    // 设置新的活动项目
    this.projectState.setActiveProjectId(projectId);

    // 更新附件 URL 监控
    if (projectId) {
      const newProject = this.projectState.getProject(projectId);
      if (newProject) {
        void this.monitorProjectAttachments(newProject);
      }
      // 【P0 修复】切换项目时按需加载目标项目数据
      // 项目可能是 syncProjectListMetadata 创建的空壳（tasks: []），需要从云端全量加载
      void this.hydrateProjectIfNeeded(projectId);
    } else {
      this.attachmentServiceRef?.clearMonitoredAttachments();
    }
  }

  /**
   * 按需全量加载项目数据（防止空壳项目显示空内容）
   *
   * 触发条件：
   * - 项目在 TaskStore 中无任务（空壳项目）
   * - 项目未标记为 local-only
   * - 项目尚未被加载过
   * - 用户已登录且非本地模式
   */
  private async hydrateProjectIfNeeded(projectId: string): Promise<void> {
    // 已加载过或正在加载，跳过
    if (this.hydratedProjectIds.has(projectId)) return;
    const existing = this.hydrationInFlight.get(projectId);
    if (existing) return;

    const userId = this.currentUserId();
    if (!userId || userId === AUTH_CONFIG.LOCAL_MODE_USER_ID) return;

    const project = this.projectState.getProject(projectId);
    if (!project || project.syncSource === 'local-only') return;

    // 检查 TaskStore 是否已有该项目的任务数据
    const tasks = this.projectState.tasks();
    // tasks 是基于 activeProjectId 的 computed，但此时 activeProjectId 已经切换过来了
    // 如果已有任务，认为项目已水合（可能来自离线快照）
    if (tasks.length > 0) {
      this.hydratedProjectIds.add(projectId);
      return;
    }

    // Project.tasks 也为空才需要加载
    if (project.tasks && project.tasks.length > 0) {
      this.hydratedProjectIds.add(projectId);
      return;
    }

    const sessionGuard = this.captureCurrentSessionGuard();
    this.logger.info('按需加载空壳项目数据', { projectId });
    const hydrationPromise = this.doHydrateProject(projectId, userId, sessionGuard);
    this.hydrationInFlight.set(projectId, hydrationPromise);
    try {
      await hydrationPromise;
    } finally {
      if (this.hydrationInFlight.get(projectId) === hydrationPromise) {
        this.hydrationInFlight.delete(projectId);
      }
    }
  }

  private async loadProjectForHydration(
    projectId: string,
    sessionGuard?: SessionGuardContext,
  ): Promise<ProjectHydrationLoadResult> {
    const cloudProject = await this.syncCoordinator.loadSingleProjectFromCloud(projectId);
    if (this.shouldAbortStaleSession(sessionGuard, `project-hydration:load:${projectId}`)) {
      return { status: 'stale' };
    }
    if (cloudProject) {
      return { status: 'loaded', project: cloudProject };
    }

    try {
      const probe = await this.syncCoordinator.core.getAccessibleProjectProbe(projectId);
      if (this.shouldAbortStaleSession(sessionGuard, `project-hydration:probe:${projectId}`)) {
        return { status: 'stale' };
      }
      if (probe && !probe.accessible) {
        return { status: 'inaccessible' };
      }
    } catch (error) {
      this.logger.warn('空壳项目可访问性复核失败，保留后续重试机会', { projectId, error });
    }

    return { status: 'retry' };
  }

  /** 执行项目全量加载并合并到本地 */
  private async doHydrateProject(
    projectId: string,
    userId: string,
    sessionGuard?: SessionGuardContext,
  ): Promise<void> {
    try {
      const loadResult = await this.loadProjectForHydration(projectId, sessionGuard);
      if (loadResult.status === 'stale') {
        return;
      }
      if (loadResult.status === 'inaccessible') {
        this.logger.info('按需加载项目已确认不可访问，停止当前会话重试', { projectId });
        this.hydratedProjectIds.add(projectId);
        return;
      }
      if (loadResult.status === 'retry') {
        this.logger.info('按需加载项目暂不可用，保留后续重试机会', { projectId });
        return;
      }

      if (this.shouldAbortStaleSession(sessionGuard, `project-hydration:merge:${projectId}`)) {
        return;
      }

      const cloudProject = loadResult.project;

      await this.mergeSingleProject(cloudProject, userId);
      this.hydratedProjectIds.add(projectId);

      // 保存快照以防下次重新加载仍为空壳
      try {
        if (this.shouldAbortStaleSession(sessionGuard, `project-hydration:snapshot:${projectId}`)) {
          return;
        }
        await this.saveProjectsToOfflineSnapshot(
          this.projectState.getProjectsWithCurrentData(),
          userId,
          { allowEmpty: true }
        );
      } catch (snapshotError) {
        this.logger.warn('按需加载后保存快照失败', snapshotError);
      }

      this.logger.info('空壳项目数据已加载', {
        projectId,
        taskCount: cloudProject.tasks?.length ?? 0,
        connectionCount: cloudProject.connections?.length ?? 0,
      });
    } catch (error) {
      this.logger.warn('按需加载项目数据失败', { projectId, error });
    }
  }

  /** 清空本地数据（内存状态），完整登出用 clearAllLocalData() */
  clearLocalData(): void {
    this.invalidateSessionRequestGeneration('clearLocalData');
    this.projectState.clearData();
    this.uiState.clearAllState();
    this.undoService.clearHistory();
    this.changeTracker.clearAllChanges();
    resetFocusState();
    this.syncCoordinator.core.clearOfflineCache();
    this.syncCoordinator.clearActiveConflict();
    this.clearStartupProjectCatalogState();
    // 清理项目补水缓存，避免旧会话状态污染后续会话
    this.resetProjectHydrationCache();
  }

  /**
   * 完整本地持久化数据清理。
   * 登出流程中应在 setCurrentUser(null) 之后调用；会话级 realtime teardown 由前一阶段负责。
   */
  async clearAllLocalData(userId?: string): Promise<void> {
    this.logger.info('执行完整的本地数据清理', { userId });

    const dockSnapshotPersistence = this.dockSnapshotPersistence as DockSnapshotPersistenceService & {
      discardPendingPersist?: () => Promise<void>;
    };
    if (typeof dockSnapshotPersistence.discardPendingPersist === 'function') {
      await dockSnapshotPersistence.discardPendingPersist();
    } else {
      dockSnapshotPersistence.cancelPendingPersist();
    }
    
    // 1. 清理内存状态（原有逻辑）
    this.clearLocalData();
    this.actionQueue.clearQueue();
    this.actionQueue.clearDeadLetterQueue();
    this.retryQueue.clear();
    await this.retryQueue.closeStorageConnections();
    await this.conflictStorage.closeStorageConnections();
    
    // 1.5 【P0 安全修复】兜底清理 sessionStorage，防止撤销历史等敏感数据残留
    try {
      sessionStorage.clear();
    } catch (e) {
      this.logger.warn('sessionStorage.clear() 失败', e);
    }
    
    // 2. 清理 localStorage 中的 NanoFlow 相关数据
    const localStorageKeysToRemove = [
      CACHE_CONFIG.OFFLINE_CACHE_KEY,
      'nanoflow.offline-cache',
      'nanoflow.retry-queue',
      LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY,
      LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY,
      'nanoflow.local-tombstones',
      'nanoflow.local-connection-tombstones',
      'nanoflow.auth-cache',
      'nanoflow.escape-pod',
      'nanoflow.safari-warning-time',
      'nanoflow.guest-data',
      // 启动快照必须在登出时清理，防止跨用户数据泄露
      'nanoflow.launch-snapshot.v1',
      'nanoflow.launch-snapshot.v2',
    ];
    
    localStorageKeysToRemove.forEach(key => {
      try {
        localStorage.removeItem(key);
      } catch (e) {
        this.logger.warn(`清理 localStorage 键失败: ${key}`, e);
      }
    });

    try {
      this.listLocalStorageKeys()
        .filter(key =>
          key.startsWith(`${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.`)
          || key.startsWith(`${LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY}.`)
        )
        .forEach(key => localStorage.removeItem(key));
    } catch (e) {
      this.logger.warn('清理 owner-scoped action queue 键失败', e);
    }
    
    // 1. 清理离线快照键
    try {
      this.listLocalStorageKeys()
        .filter(key => key.startsWith(`${CACHE_CONFIG.OFFLINE_CACHE_KEY}.`))
        .forEach(key => localStorage.removeItem(key));
    } catch (e) {
      this.logger.warn('清理 owner-scoped 离线快照键失败', e);
    }
    
    // 2. 清理用户偏好键（带 userId 前缀的）
    if (userId) {
      const prefixToRemove = `nanoflow.preference.${userId}`;
      try {
        this.listLocalStorageKeys()
          .filter(key => key.startsWith(prefixToRemove))
          .forEach(key => localStorage.removeItem(key));
      } catch (e) {
        this.logger.warn('清理用户偏好键失败', e);
      }
    }
    
    // 清理旧偏好键（兼容迁移）
    try {
      this.listLocalStorageKeys()
        .filter(key => key.startsWith('nanoflow.preference.') && !key.includes('.user-'))
        .forEach(key => localStorage.removeItem(key));
    } catch (e) {
      this.logger.warn('清理旧偏好键失败', e);
    }

    try {
      this.listLocalStorageKeys()
        .filter(key => key.startsWith('nanoflow.retry-queue.legacy-review.'))
        .forEach(key => localStorage.removeItem(key));
    } catch (e) {
      this.logger.warn('清理 legacy retry review 键失败', e);
    }

    try {
      this.listLocalStorageKeys()
        .filter(key => key.startsWith('nanoflow.action-queue.legacy-review.'))
        .forEach(key => localStorage.removeItem(key));
    } catch (e) {
      this.logger.warn('清理 legacy action queue review 键失败', e);
    }

    try {
      this.listLocalStorageKeys()
        .filter(key => FULL_WIPE_LOCAL_STORAGE_PREFIXES.some(prefix => key.startsWith(prefix)))
        .forEach(key => localStorage.removeItem(key));
    } catch (e) {
      this.logger.warn('清理同步水位缓存键失败', e);
    }

    try {
      this.listLocalStorageKeys()
        .filter(key => key.startsWith(`${PARKING_CONFIG.DOCK_SNAPSHOT_STORAGE_KEY}.`))
        .forEach(key => localStorage.removeItem(key));
    } catch (e) {
      this.logger.warn('清理 Dock 快照影子键失败', e);
    }

    this.conflictStorage.clearAllFallbackStorage();
    await this.clearSupabaseSessionArtifacts();

    // 4. 清理 IndexedDB
    const indexedDbCleanup = await Promise.all([
      this.clearIndexedDB('nanoflow-db'),
      this.clearIndexedDB('nanoflow-queue-backup'),
      this.clearIndexedDB('nanoflow-retry-queue'),
      this.clearIndexedDB('nanoflow-conflicts'),
      this.clearIndexedDB('nanoflow-offline-snapshots'),
      this.clearIndexedDB(FOCUS_CONFIG.SYNC.IDB_NAME),
      this.clearIndexedDB(DOCK_SNAPSHOT_DB_NAME),
    ]);
    const cleanupTargets = [
      'nanoflow-db',
      'nanoflow-queue-backup',
      'nanoflow-retry-queue',
      'nanoflow-conflicts',
      'nanoflow-offline-snapshots',
      FOCUS_CONFIG.SYNC.IDB_NAME,
      DOCK_SNAPSHOT_DB_NAME,
    ];
    const failedCleanupTargets = cleanupTargets.filter((_, index) => !indexedDbCleanup[index]);
    if (failedCleanupTargets.length > 0) {
      this.logger.error('本地 IndexedDB 清理未完成', { failedCleanupTargets });
      throw new Error(`IndexedDB 清理未完成: ${failedCleanupTargets.join(', ')}`);
    }
    
    this.logger.info('本地数据清理完成');
  }

  private async clearSupabaseSessionArtifacts(): Promise<void> {
    try {
      if (this.supabase.isConfigured) {
        await this.supabase.signOut();
      }
    } catch (e) {
      this.logger.warn('Supabase signOut 失败', e);
    }

    this.clearSupabaseLocalSessionArtifacts();
    this.clearStartupWindowArtifacts();
  }

  private clearSupabaseLocalSessionArtifacts(): void {
    if (typeof localStorage === 'undefined') {
      return;
    }

    const storageKey = this.supabase.getStorageKey();
    if (!storageKey) {
      return;
    }

    try {
      localStorage.removeItem(storageKey);
    } catch (e) {
      this.logger.warn('清理 Supabase 本地凭证失败', e);
    }
  }

  private clearStartupWindowArtifacts(): void {
    if (typeof window === 'undefined') {
      return;
    }

    try {
      delete (window as Window & { __NANOFLOW_LAUNCH_SNAPSHOT__?: unknown }).__NANOFLOW_LAUNCH_SNAPSHOT__;
      delete (window as Window & { __NANOFLOW_SESSION_PREWARM__?: unknown }).__NANOFLOW_SESSION_PREWARM__;
    } catch {
      // 静默忽略
    }
  }

  private async clearIndexedDB(dbName: string): Promise<boolean> {
    if (typeof indexedDB === 'undefined') return true;

    // 设置超时上限：blocked 场景最多等 3 秒后放弃等待
    const CLEAR_TIMEOUT_MS = 3000;

    return new Promise<boolean>((resolve) => {
      try {
        const timeoutId = setTimeout(() => {
          this.logger.warn(`IndexedDB ${dbName} 删除超时 (${CLEAR_TIMEOUT_MS}ms)，判定为清理失败`);
          resolve(false);
        }, CLEAR_TIMEOUT_MS);

        const request = indexedDB.deleteDatabase(dbName);

        request.onsuccess = () => {
          clearTimeout(timeoutId);
          this.logger.debug(`IndexedDB ${dbName} 已删除`);
          resolve(true);
        };

        request.onerror = () => {
          clearTimeout(timeoutId);
          this.logger.warn(`删除 IndexedDB ${dbName} 失败`, request.error);
          resolve(false);
        };

        request.onblocked = () => {
          // 数据库被其他连接占用，不立即 resolve，等待 onsuccess/onerror 或超时
          this.logger.warn(`IndexedDB ${dbName} 删除被阻塞，等待其他连接关闭或超时`);
        };
      } catch (e) {
        this.logger.warn(`清理 IndexedDB ${dbName} 异常`, e);
        resolve(false);
      }
    });
  }

  private listLocalStorageKeys(): string[] {
    const keys: string[] = [];
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (key) keys.push(key);
    }
    return keys;
  }

  /**
   * 本地优先加载项目列表
   * 1. 立即从本地缓存/种子数据渲染 UI
   * 2. 后台静默同步云端数据
   * 3. 智能合并云端数据
   */
  async loadProjects(): Promise<void> {
    return this.loadProjectsForSession(this.createSessionGuard(this.currentUserId()));
  }

  private async loadProjectsForSession(sessionGuard: SessionGuardContext): Promise<void> {
    const perfStart = performance.now();
    const userId = sessionGuard.userId;
    this.logger.debug('loadProjects 开始（本地优先模式）', { userId });
    pushStartupTrace('user_session.load_projects_start', { userId });
    if (this.shouldAbortStaleSession(sessionGuard, 'loadProjects:start')) {
      return;
    }
    
    // === 阶段 1: 立即渲染本地数据 ===
    
    if (!userId) {
      this.logger.debug('无 userId，从缓存或种子加载');
      await this.loadFromCacheOrSeed(undefined, sessionGuard);
      this.logger.debug(`⚡ 数据加载完成 (${(performance.now() - perfStart).toFixed(1)}ms)`);
      return;
    }
    
    // 【性能优化 2026-01-26】如果是本地模式用户，直接从缓存加载，不尝试云端同步
    // 立即返回，避免触发任何网络请求或会话检查
    if (userId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      this.logger.debug('本地模式，从缓存或种子加载');
      await this.loadFromCacheOrSeed(undefined, sessionGuard);
      this.logger.debug(`⚡ 本地模式数据加载完成 (${(performance.now() - perfStart).toFixed(1)}ms)`);
      // 确保不启动后台同步任务
      return;
    }

    const previousActive = this.projectState.activeProjectId();
    const startupSnapshot = await this.loadStartupSnapshotResult();
    if (this.shouldAbortStaleSession(sessionGuard, 'loadProjects:startup-snapshot')) {
      return;
    }
    const snapshotProjects = this.getSnapshotProjectsForSession(
      startupSnapshot,
      sessionGuard.userId,
      'loadProjects:startup-snapshot'
    );
    const offlineProjects = snapshotProjects.projects;
    this.logger.debug('离线缓存项目数量', {
      count: startupSnapshot.projectCount,
      source: startupSnapshot.source,
      migratedLegacy: startupSnapshot.migratedLegacy,
    });

    if (!snapshotProjects.ownerMatched) {
      this.clearStartupProjectCatalogState();
    }
    
    // 【关键改动】立即渲染本地缓存数据，不等待云端
    if (offlineProjects && offlineProjects.length > 0) {
      this.logger.debug('立即渲染本地缓存数据');
      
      // 验证并迁移本地数据
      const validProjects: Project[] = [];
      for (const p of offlineProjects) {
        try {
          const migrated = this.migrateProject(p);
          if (migrated.id && Array.isArray(migrated.tasks)) {
            validProjects.push(migrated);
          }
        } catch (error) {
          this.logger.warn('跳过无效的缓存项目', { projectId: p.id, error });
        }
      }
      
      if (validProjects.length > 0) {
        if (this.shouldAbortStaleSession(sessionGuard, 'loadProjects:apply-local-projects')) {
          return;
        }
        this.projectState.setProjects(validProjects);
        
        // 标记有任务的项目为已水合（来自离线快照的数据已完整）
        for (const p of validProjects) {
          if (p.tasks && p.tasks.length > 0) {
            this.hydratedProjectIds.add(p.id);
          }
        }
        
        // 恢复之前的活动项目，或选择第一个
        if (previousActive && validProjects.some(p => p.id === previousActive)) {
          this.projectState.setActiveProjectId(previousActive);
        } else {
          this.projectState.setActiveProjectId(validProjects[0]?.id ?? null);
        }
        
        // 设置附件监控
        const activeProject = validProjects.find(p => p.id === this.projectState.activeProjectId());
        if (activeProject) {
          void this.monitorProjectAttachments(activeProject);
        }

        this.syncStartupProjectCatalogStageAfterLocalRestore(userId);
        
        this.logger.debug('本地数据已渲染，用户可以操作');
        pushStartupTrace('user_session.snapshot_rendered', {
          source: startupSnapshot.source,
          projectCount: validProjects.length,
          activeProjectId: this.projectState.activeProjectId(),
          migratedLegacy: startupSnapshot.migratedLegacy,
        });
      } else {
        // 缓存数据无效，使用种子数据
        await this.loadFromCacheOrSeed(startupSnapshot, sessionGuard);
      }
    } else {
      // 无本地缓存，立即生成种子数据让用户可以操作
      this.logger.debug('无本地缓存，生成种子数据');
      await this.loadFromCacheOrSeed(startupSnapshot, sessionGuard);
    }

    if (this.shouldAbortStaleSession(sessionGuard, 'loadProjects:before-background-sync')) {
      return;
    }
    
    // === 阶段 2: 后台静默同步云端数据 ===
    // 【关键改动】不阻塞，使用 .then() 而非 await
    
    this.runIdleTask(() => {
      if (this.shouldAbortStaleSession(sessionGuard, 'loadProjects:idle-background-sync')) {
        return;
      }

      this.startBackgroundSync(userId, previousActive, sessionGuard).catch(error => {
        this.logger.warn('后台同步失败', error);
        // 后台同步失败不影响用户操作，静默处理
      });
    });
  }

  private runIdleTask(task: () => void): void {
    let fired = false;
    const runOnce = () => {
      if (fired) return;
      fired = true;
      task();
    };

    if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
      const fallbackTimer = setTimeout(runOnce, this.IDLE_TASK_FALLBACK_MS);
      (
        window as unknown as { requestIdleCallback: (cb: () => void) => void }
      ).requestIdleCallback(() => {
        clearTimeout(fallbackTimer);
        runOnce();
      });
    } else {
      setTimeout(runOnce, 0);
    }
  }

  private getPersistedGuestDraftProjectIds(): Set<string> {
    if (typeof localStorage === 'undefined') {
      return new Set();
    }

    try {
      const rawGuestData = localStorage.getItem(GUEST_DATA_STORAGE_KEY);
      if (!rawGuestData) {
        return new Set();
      }

      const parsedGuestData = JSON.parse(rawGuestData) as { projects?: unknown };
      const expiresAt = typeof (parsedGuestData as { expiresAt?: unknown }).expiresAt === 'string'
        ? (parsedGuestData as { expiresAt: string }).expiresAt
        : null;
      if (expiresAt) {
        const expiresAtMs = new Date(expiresAt).getTime();
        if (Number.isFinite(expiresAtMs) && expiresAtMs < Date.now()) {
          return new Set();
        }
      }

      if (!Array.isArray(parsedGuestData?.projects)) {
        return new Set();
      }

      const projectIds = new Set<string>();
      for (const project of parsedGuestData.projects) {
        if (!project || typeof project !== 'object') {
          continue;
        }

        const projectId = (project as { id?: unknown }).id;
        if (typeof projectId === 'string' && projectId.trim().length > 0) {
          projectIds.add(projectId);
        }
      }

      return projectIds;
    } catch (error) {
      this.logger.debug('读取 guest draft 标记失败，按无标记处理', { error });
      return new Set();
    }
  }

  private hasRealLocalChanges(projectId: string): boolean {
    return this.syncCoordinator.hasPendingChangesForProject(projectId)
      || this.changeTracker.hasProjectChanges(projectId);
  }

  private isProtectedLocalOnlyProject(
    project: Project | null | undefined,
    guestDraftProjectIds = this.getPersistedGuestDraftProjectIds()
  ): boolean {
    if (!project || project.syncSource !== 'local-only') {
      return false;
    }

    if (guestDraftProjectIds.has(project.id)) {
      return true;
    }

    return this.hasRealLocalChanges(project.id);
  }

  private isLocalOnlyProject(projectId: string | null | undefined): boolean {
    if (!projectId) {
      return false;
    }

    return this.isProtectedLocalOnlyProject(this.projectState.getProject(projectId));
  }

  private hasLocalOnlyProjectsAwaitingPromotion(): boolean {
    return this.projectState.projects().some(project => project.syncSource === 'local-only');
  }

  private isSyncedProjectShellNeedingHydration(projectId: string | null | undefined): boolean {
    if (!projectId || this.hydratedProjectIds.has(projectId) || this.isLocalOnlyProject(projectId)) {
      return false;
    }

    const currentProject = this.projectState.getProjectsWithCurrentData()
      .find(project => project.id === projectId)
      ?? this.projectState.getProject(projectId);

    return !!currentProject && (!Array.isArray(currentProject.tasks) || currentProject.tasks.length === 0);
  }
  
  /** 后台静默同步云端数据（不阻塞 UI，Delta Sync 优先） */
  private async startBackgroundSync(
    userId: string,
    _previousActive: string | null,
    sessionGuard?: SessionGuardContext
  ): Promise<void> {
    // 【修复】本地模式不启动后台同步，防止将 'local-user' 传递给 Supabase
    if (userId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      this.logger.debug('本地模式，跳过后台同步');
      return;
    }

    if (this.shouldAbortStaleSession(sessionGuard, 'startBackgroundSync:start')) {
      return;
    }

    if (!(await this.isSupabaseSessionCurrentForUser(userId, 'startBackgroundSync:start'))) {
      return;
    }

    this.logger.debug('开始后台同步');

    let activeProjectId = this.projectState.activeProjectId();
    let resumeProbe: {
      activeProjectId: string | null;
      activeAccessible: boolean;
      activeWatermark: string | null;
      projectsWatermark: string | null;
      blackboxWatermark: string | null;
      serverNow: string | null;
    } | null = null;

    // 阶段 1: 聚合 RPC 探测（单次调用获取多个水位信息）
    if (FEATURE_FLAGS.RESUME_COMPOSITE_PROBE_RPC_V1) {
      try {
        resumeProbe = await this.syncCoordinator.core.getResumeRecoveryProbe(
          this.isLocalOnlyProject(activeProjectId) ? undefined : (activeProjectId ?? undefined)
        );
        if (this.shouldAbortStaleSession(sessionGuard, 'startBackgroundSync:resume-probe')) {
          return;
        }
      } catch (error) {
        this.logger.warn('恢复聚合探测失败，降级为分步探测', error);
      }
    }

    // 标记 access preflight 是否确认了当前项目可访问（用于后续并行优化）
    let accessPreflightConfirmed = false;
    if (FEATURE_FLAGS.ACTIVE_PROJECT_ACCESS_PREFLIGHT_V1 && activeProjectId && !this.isLocalOnlyProject(activeProjectId)) {
      try {
        const probe = resumeProbe && resumeProbe.activeProjectId === activeProjectId
          ? {
            projectId: activeProjectId,
            accessible: resumeProbe.activeAccessible,
            watermark: resumeProbe.activeWatermark,
          }
          : await this.syncCoordinator.core.getAccessibleProjectProbe(activeProjectId);
        if (this.shouldAbortStaleSession(sessionGuard, 'startBackgroundSync:access-preflight')) {
          return;
        }
        if (probe && !probe.accessible) {
          activeProjectId = await this.reconcileInaccessibleActiveProject(activeProjectId, userId);
        } else if (probe?.watermark) {
          accessPreflightConfirmed = true;
        } else if (probe?.accessible) {
          accessPreflightConfirmed = true;
        }
      } catch (error) {
        this.logger.warn('activeProject 可访问性探测失败，继续走常规路径', error);
      }
    }

    // 阶段 2: 并行执行水位快路 + 黑匣子水位探测（原来是串行 await）
    let skipProjectSyncSlowPath = false;
    let pendingProjectManifestWatermark: string | null = null;
    const parallelTasks: Promise<void>[] = [];

    if (FEATURE_FLAGS.USER_PROJECTS_WATERMARK_RPC_V1) {
      parallelTasks.push((async () => {
        try {
          const manifestResult = resumeProbe
            ? await this.syncCoordinator.refreshProjectManifestIfNeeded('session-background-sync', {
              prefetchedRemoteWatermark: resumeProbe.projectsWatermark,
              deferCommit: true,
            })
            : await this.syncCoordinator.refreshProjectManifestIfNeeded('session-background-sync', {
              deferCommit: true,
            });
          if (manifestResult.skipped && manifestResult.watermark) {
            this.logger.debug('命中项目清单水位快路，跳过后台项目同步', {
              watermark: manifestResult.watermark
            });
            skipProjectSyncSlowPath = true;
          } else if (manifestResult.watermark) {
            pendingProjectManifestWatermark = manifestResult.watermark;
          }
        } catch (error) {
          this.logger.warn('项目清单水位快路失败，降级为常规后台同步', error);
        }
      })());
    }

    if (FEATURE_FLAGS.BLACKBOX_WATERMARK_PROBE_V1) {
      parallelTasks.push((async () => {
        try {
          if (resumeProbe) {
            await this.syncCoordinator.refreshBlackBoxWatermarkIfNeeded('session-background-sync', {
              prefetchedRemoteWatermark: resumeProbe.blackboxWatermark,
            });
          } else {
            await this.syncCoordinator.refreshBlackBoxWatermarkIfNeeded('session-background-sync');
          }
        } catch (error) {
          this.logger.warn('黑匣子水位快路失败，降级为常规流程', error);
        }
      })());
    }

    // 等待所有并行水位探测完成
    await Promise.allSettled(parallelTasks);
    if (this.shouldAbortStaleSession(sessionGuard, 'startBackgroundSync:after-parallel-probes')) {
      return;
    }

    if (skipProjectSyncSlowPath && this.hasLocalOnlyProjectsAwaitingPromotion()) {
      try {
        const accessibleProjectIds = await this.syncProjectListMetadata(userId, sessionGuard);
        if (this.shouldAbortStaleSession(sessionGuard, 'startBackgroundSync:fastpath-metadata-promotion')) {
          return;
        }

        activeProjectId = this.projectState.activeProjectId();
        if (
          FEATURE_FLAGS.ACTIVE_PROJECT_ACCESS_PREFLIGHT_V1
          && activeProjectId
          && !this.isLocalOnlyProject(activeProjectId)
          && !accessibleProjectIds.has(activeProjectId)
        ) {
          activeProjectId = await this.reconcileInaccessibleActiveProject(activeProjectId, userId);
        }
      } catch (error) {
        this.logger.warn('项目清单快路命中，但 local-only 项目 promotion 失败', error);
      }
    }

    if (skipProjectSyncSlowPath && this.projectState.projects().length === 0) {
      skipProjectSyncSlowPath = false;
      this.logger.debug('项目清单快路命中但本地项目为空，降级同步项目元数据');
    }

    // 【性能优化】项目列表元数据同步与当前项目 delta sync 并行执行
    // - 如果 access preflight 已确认 activeProjectId 可访问，可安全并行
    // - syncProjectListMetadata 仅更新项目列表壳数据，不影响当前项目内容
    let currentProjectSynced = false;

    if (skipProjectSyncSlowPath) {
      // 水位快路命中，跳过项目列表同步，只做 delta sync
      if (activeProjectId && !this.isLocalOnlyProject(activeProjectId) && SYNC_CONFIG.DELTA_SYNC_ENABLED) {
        try {
          const deltaResult = await this.syncCoordinator.performDeltaSync(activeProjectId);
          if (deltaResult.taskChanges > 0 || deltaResult.connectionChanges > 0) {
            this.logger.debug('Delta Sync 成功', deltaResult);
            currentProjectSynced = true;
          }
        } catch (deltaSyncError) {
          this.logger.warn('Delta Sync 失败', deltaSyncError);
        }
      }
    } else if (accessPreflightConfirmed && activeProjectId && !this.isLocalOnlyProject(activeProjectId) && SYNC_CONFIG.DELTA_SYNC_ENABLED) {
      // access preflight 已确认项目可访问，并行执行列表同步和 delta sync
      const [metadataResult, deltaResult] = await Promise.allSettled([
        this.syncProjectListMetadata(userId, sessionGuard),
        this.syncCoordinator.performDeltaSync(activeProjectId),
      ]);
      if (this.shouldAbortStaleSession(sessionGuard, 'startBackgroundSync:parallel-metadata-delta')) {
        return;
      }

      if (metadataResult.status === 'fulfilled') {
        const accessibleProjectIds = metadataResult.value;
        if (pendingProjectManifestWatermark && this.lastProjectListMetadataSyncSucceededState()) {
          this.syncCoordinator.commitProjectManifestWatermark(pendingProjectManifestWatermark, userId);
          pendingProjectManifestWatermark = null;
        }
        const currentActive = this.projectState.activeProjectId();
        if (currentActive && !this.isLocalOnlyProject(currentActive) && !accessibleProjectIds.has(currentActive)) {
          activeProjectId = await this.reconcileInaccessibleActiveProject(currentActive, userId);
        }
      } else {
        this.logger.warn('项目列表元数据同步失败', metadataResult.reason);
      }

      if (deltaResult.status === 'fulfilled') {
        const dr = deltaResult.value;
        if (dr.taskChanges > 0 || dr.connectionChanges > 0) {
          this.logger.debug('Delta Sync 成功', dr);
          currentProjectSynced = true;
        }
      } else {
        this.logger.warn('Delta Sync 失败', deltaResult.reason);
      }
    } else {
      // 降级路径：串行执行
      let accessibleProjectIds = new Set<string>();
      try {
        accessibleProjectIds = await this.syncProjectListMetadata(userId, sessionGuard);
        if (pendingProjectManifestWatermark && this.lastProjectListMetadataSyncSucceededState()) {
          this.syncCoordinator.commitProjectManifestWatermark(pendingProjectManifestWatermark, userId);
          pendingProjectManifestWatermark = null;
        }
        if (this.shouldAbortStaleSession(sessionGuard, 'startBackgroundSync:serial-metadata')) {
          return;
        }
      } catch (e) {
        this.logger.warn('项目列表元数据同步失败', e);
      }

      activeProjectId = this.projectState.activeProjectId();

      if (
        FEATURE_FLAGS.ACTIVE_PROJECT_ACCESS_PREFLIGHT_V1 &&
        activeProjectId &&
        !this.isLocalOnlyProject(activeProjectId) &&
        !accessibleProjectIds.has(activeProjectId)
      ) {
        activeProjectId = await this.reconcileInaccessibleActiveProject(activeProjectId, userId);
      }

      if (activeProjectId && !this.isLocalOnlyProject(activeProjectId) && SYNC_CONFIG.DELTA_SYNC_ENABLED) {
        try {
          const deltaResult = await this.syncCoordinator.performDeltaSync(activeProjectId);
          if (deltaResult.taskChanges > 0 || deltaResult.connectionChanges > 0) {
            this.logger.debug('Delta Sync 成功', deltaResult);
            currentProjectSynced = true;
          }
        } catch (deltaSyncError) {
          this.logger.warn('Delta Sync 失败', deltaSyncError);
        }
      }
    }
    
    // === 策略 2: 如果 Delta Sync 失败，只加载当前项目（按需加载）===
    // 【P0 修复 2026-04-05】后台同步完成后，加载所有空壳项目的完整数据
    // 保证所有项目在下次切换时有内容可显示

    // 【修复 2026-04-03】登录后无本地缓存时 activeProjectId 为 null，
    // 但 syncProjectListMetadata 可能已从云端创建了项目壳。
    // 仅在初始就无 activeProjectId 时自动选择首个可用项目，
    // 不覆盖同步流程中因"不可访问"而主动清除的 activeProjectId。
    if (!activeProjectId && this.projectState.projects().length > 0) {
      const firstSyncedProject = this.projectState.projects().find(p => !this.isLocalOnlyProject(p.id));
      if (firstSyncedProject) {
        this.logger.debug('后台同步后自动选择首个可用项目', { projectId: firstSyncedProject.id });
        this.projectState.setActiveProjectId(firstSyncedProject.id);
        activeProjectId = firstSyncedProject.id;
      }
    }

    const activeProjectNeedsHydration = this.isSyncedProjectShellNeedingHydration(activeProjectId);
    if (
      !currentProjectSynced
      && activeProjectId
      && !this.isLocalOnlyProject(activeProjectId)
      && (!skipProjectSyncSlowPath || activeProjectNeedsHydration)
    ) {
      try {
        this.logger.debug('按需加载当前项目', { projectId: activeProjectId });
        const currentProject = await this.syncCoordinator.loadSingleProjectFromCloud(activeProjectId);
        if (this.shouldAbortStaleSession(sessionGuard, 'startBackgroundSync:load-single-project')) {
          return;
        }
        if (currentProject) {
          await this.mergeSingleProject(currentProject, userId);
          currentProjectSynced = true;
        } else {
          // 【性能优化 2026-02-14】RPC 返回 null 说明项目不可访问（Access Denied 或已删除）
          // 清理不可访问的 activeProjectId，避免后续重复触发无效 RPC 请求链
          activeProjectId = await this.reconcileInaccessibleActiveProject(activeProjectId, userId);
        }
      } catch (e) {
        this.logger.warn('当前项目同步失败', e);
      }
    }

    // 标记活跃项目已水合
    if (activeProjectId && currentProjectSynced) {
      this.hydratedProjectIds.add(activeProjectId);
    }

    // 【P0 修复 2026-04-05】后台加载所有空壳项目的完整数据
    // 空壳项目由 syncProjectListMetadata 创建（tasks: []），需要从云端补充内容
    if (this.shouldAbortStaleSession(sessionGuard, 'startBackgroundSync:before-shell-hydration')) {
      this.markStartupProjectCatalogResolved();
      return;
    }
    await this.hydrateShellProjectsInBackground(userId, activeProjectId, sessionGuard);
    
    this.markStartupProjectCatalogResolved();
    this.logger.debug('后台同步完成', { currentProjectSynced });
  }

  /**
   * 后台加载所有空壳项目的完整数据
   *
   * 空壳项目由 syncProjectListMetadata 创建（tasks: [], connections: []），
   * 需要从云端逐个加载完整数据，以保证用户切换项目时能看到内容。
   * 串行执行，避免并发请求过多。
   */
  private async hydrateShellProjectsInBackground(
    userId: string,
    activeProjectId: string | null,
    sessionGuard?: SessionGuardContext,
  ): Promise<void> {
    const projects = this.projectState.projects();
    const shellProjectIds = projects
      .filter(p =>
        p.id !== activeProjectId
        && p.syncSource !== 'local-only'
        && (!p.tasks || p.tasks.length === 0)
        && !this.hydratedProjectIds.has(p.id)
      )
      .map(p => p.id);

    if (shellProjectIds.length === 0) {
      // 即使不需要加载空壳，也标记所有有内容的项目为已水合
      for (const p of projects) {
        if (p.tasks && p.tasks.length > 0) {
          this.hydratedProjectIds.add(p.id);
        }
      }
      return;
    }

    this.logger.info('开始后台加载空壳项目', {
      count: shellProjectIds.length,
      projectIds: shellProjectIds,
    });

    let loadedCount = 0;
    for (const projectId of shellProjectIds) {
      if (this.shouldAbortStaleSession(sessionGuard, `hydrateShell:${projectId}`)) {
        break;
      }

      try {
        const loadResult = await this.loadProjectForHydration(projectId, sessionGuard);
        if (loadResult.status === 'stale') {
          return;
        }

        if (loadResult.status === 'loaded') {
          if (this.shouldAbortStaleSession(sessionGuard, `hydrateShell:merge:${projectId}`)) {
            return;
          }
          await this.mergeSingleProject(loadResult.project, userId);
          this.hydratedProjectIds.add(projectId);
          loadedCount++;
        } else if (loadResult.status === 'inaccessible') {
          // 项目明确不可访问，标记为已处理避免同会话内重复重试
          this.hydratedProjectIds.add(projectId);
        } else {
          this.logger.info('后台加载空壳项目暂不可用，等待后续机会重试', { projectId });
        }
      } catch (error) {
        this.logger.warn('后台加载空壳项目失败', { projectId, error });
        // 单个失败不影响后续项目加载
      }
    }

    if (loadedCount > 0) {
      // 保存快照以持久化已加载的项目数据
      try {
        if (this.shouldAbortStaleSession(sessionGuard, 'hydrateShell:save-snapshot')) {
          return;
        }
        await this.saveProjectsToOfflineSnapshot(
          this.projectState.getProjectsWithCurrentData(),
          userId,
          { allowEmpty: true }
        );
      } catch (snapshotError) {
        this.logger.warn('后台加载空壳项目后保存快照失败', snapshotError);
      }

      this.logger.info('后台空壳项目加载完成', { loadedCount, total: shellProjectIds.length });
    }
  }
  
  /** 同步项目列表元数据（不加载完整数据） */
  private async syncProjectListMetadata(
    userId: string,
    sessionGuard?: SessionGuardContext,
  ): Promise<Set<string>> {
    this.lastProjectListMetadataSyncSucceededState.set(false);
    const localProjects = this.projectState.projects();
    const fallbackIds = new Set(localProjects.map(p => p.id));

    const client = await this.supabase.clientAsync();
    if (this.shouldAbortStaleSession(sessionGuard, 'syncProjectListMetadata:after-client')) {
      return fallbackIds;
    }
    if (!client) return fallbackIds;

    if (!(await this.isSupabaseSessionCurrentForUser(userId, 'syncProjectListMetadata:session'))) {
      return fallbackIds;
    }
    if (this.shouldAbortStaleSession(sessionGuard, 'syncProjectListMetadata:after-session')) {
      return fallbackIds;
    }
    
    const { data, error } = await client
      .from('projects')
      .select('id,title,description,created_date,updated_at,version,owner_id')
      .eq('owner_id', userId)
      .is('deleted_at', null)
      .order('updated_at', { ascending: false });

    if (this.shouldAbortStaleSession(sessionGuard, 'syncProjectListMetadata:after-query')) {
      return fallbackIds;
    }
    
    if (error) {
      this.logger.warn('获取项目列表失败', { message: error.message });
      return fallbackIds;
    }

    const accessibleProjectIds = new Set<string>((data || []).map(row => String(row.id)));
    this.authoritativelyAccessibleProjectIdsState.set(new Set(accessibleProjectIds));
    this.lastProjectListMetadataSyncSucceededState.set(true);
    
    // 更新本地项目列表的元数据（不覆盖 tasks/connections）
    let updatedProjects = [...localProjects];
    let hasChanges = false;
    const guestDraftProjectIds = this.getPersistedGuestDraftProjectIds();
    
    for (const remote of data || []) {
      const localIndex = updatedProjects.findIndex(p => p.id === remote.id);
      if (localIndex === -1) {
        // 新项目：创建空壳，完整数据在用户切换时加载
        updatedProjects.push({
          id: remote.id,
          name: remote.title || 'Untitled Project',
          description: remote.description || '',
          createdDate: remote.created_date || new Date().toISOString(),
          updatedAt: remote.updated_at || new Date().toISOString(),
          version: remote.version || 1,
          syncSource: 'synced',
          pendingSync: false,
          tasks: [],
          connections: []
        });
        hasChanges = true;
      } else {
        // 已有项目：只更新元数据，不覆盖 tasks
        const local = updatedProjects[localIndex];
        const hasPendingLocalChanges = this.hasRealLocalChanges(local.id);
        const nextProject: Project = {
          ...local,
          syncSource: 'synced',
          pendingSync: hasPendingLocalChanges,
          ...(remote.updated_at && remote.updated_at > (local.updatedAt || '') ? {
            name: remote.title || local.name,
            description: remote.description || local.description,
            updatedAt: remote.updated_at,
            version: remote.version || local.version,
          } : {}),
        };

        if (
          nextProject.syncSource !== local.syncSource ||
          nextProject.pendingSync !== local.pendingSync ||
          nextProject.name !== local.name ||
          nextProject.description !== local.description ||
          nextProject.updatedAt !== local.updatedAt ||
          nextProject.version !== local.version
        ) {
          updatedProjects[localIndex] = nextProject;
          hasChanges = true;
        }
      }
    }

    // 查询成功时，远端列表缺失意味着项目已不可访问或已被软删除。
    // 这里允许列表合法收缩，但仍保留 guest draft / active / real pending changes 项目。
    const activeProjectId = this.projectState.activeProjectId();
    const beforePruneCount = updatedProjects.length;
    updatedProjects = updatedProjects.filter(project => {
      if (accessibleProjectIds.has(project.id)) return true;
      if (this.isProtectedLocalOnlyProject(project, guestDraftProjectIds)) return true;
      // 不裁剪当前活跃项目，交由调用方处理
      if (project.id === activeProjectId) return true;
      const hasPendingLocalChanges = this.hasRealLocalChanges(project.id);
      return hasPendingLocalChanges;
    });
    if (updatedProjects.length !== beforePruneCount) {
      hasChanges = true;
    }
    
    if (hasChanges) {
      // 【P0 修复 2026-04-05】使用 setProjectsMetadataOnly 避免空壳项目的 tasks: []
      // 覆盖 TaskStore 中已加载好的任务数据。syncProjectListMetadata 只更新项目元数据，
      // 不应触碰任务和连接数据。
      this.projectState.setProjectsMetadataOnly(updatedProjects);

      const activeProjectIdForPrune = this.projectState.activeProjectId();
      if (activeProjectIdForPrune && !updatedProjects.some(p => p.id === activeProjectIdForPrune)) {
        this.projectState.setActiveProjectId(null);
        this.toastService.info('当前项目不可访问，已自动切换');
      }

      try {
        await this.saveProjectsToOfflineSnapshot(this.projectState.getProjectsWithCurrentData(), userId, { allowEmpty: true });
      } catch (snapshotError) {
        this.logger.warn('持久化项目列表元数据快照失败', snapshotError);
      }

      this.logger.debug('项目列表元数据已更新');
    }

    return accessibleProjectIds;
  }

  private async reconcileInaccessibleActiveProject(projectId: string, userId: string): Promise<string | null> {
    // 【安全阀】Supabase 连接中断时不做激进裁剪，
    // 避免因瞬时网络/认证问题误删活跃项目
    if (this.supabase.isOfflineMode()) {
      this.logger.warn('Supabase 连接中断，跳过 activeProject 不可访问裁剪', { projectId });
      return projectId;
    }

    if (!(await this.isSupabaseSessionCurrentForUser(userId, 'reconcileInaccessibleActiveProject'))) {
      return projectId;
    }

    const localProject = this.projectState.getProject(projectId);
    if (!localProject) {
      this.projectState.setActiveProjectId(null);
      this.toastService.info('当前项目不可访问，已自动切换');
      return null;
    }

    const guestDraftProjectIds = this.getPersistedGuestDraftProjectIds();
    const hasPendingLocalChanges = this.hasRealLocalChanges(projectId)
      || this.isProtectedLocalOnlyProject(localProject, guestDraftProjectIds);

    if (hasPendingLocalChanges) {
      // 使用 getProjectsWithCurrentData 确保项目包含 TaskStore 中最新的任务数据
      const preservedProjects: Project[] = this.projectState.getProjectsWithCurrentData().map(project => (
        project.id === projectId
          ? {
              ...project,
              syncSource: 'local-only' as const,
              pendingSync: true,
            }
          : project
      ));

      this.projectState.setProjects(preservedProjects);
      try {
        await this.saveProjectsToOfflineSnapshot(preservedProjects, userId, { allowEmpty: true });
      } catch (snapshotError) {
        this.logger.warn('持久化 local-only 降级快照失败', snapshotError);
      }

      this.logger.warn('activeProject 不可访问，已降级为 local-only 草稿', { projectId });
      return projectId;
    }

    // 使用 getProjectsWithCurrentData 确保包含 TaskStore 中最新的任务数据
    const remainingProjects = this.projectState.getProjectsWithCurrentData().filter(project => project.id !== projectId);
    this.projectState.setProjects(remainingProjects);
    this.projectState.setActiveProjectId(null);

    try {
      await this.saveProjectsToOfflineSnapshot(remainingProjects, userId, { allowEmpty: true });
    } catch (snapshotError) {
      this.logger.warn('持久化 activeProject 移除后的快照失败', snapshotError);
    }

    this.toastService.info('当前项目不可访问，已自动切换');
    this.logger.warn('activeProject 不可访问，已从本地项目列表移除', { projectId });
    return null;
  }
  
  /** 合并单个项目数据（LWW 竞态保护） */
  private async mergeSingleProject(cloudProject: Project, _userId: string): Promise<void> {
    const localProject = this.projectState.getProject(cloudProject.id);
    
    if (!localProject) {
      // 新项目，直接添加
      this.projectState.setProjects([...this.projectState.projects(), cloudProject]);
      return;
    }
    
    // 【LWW 竞态保护 2026-01-27】
    // 检查是否有本地未同步的修改（脏数据）
    const hasPendingChanges = this.syncCoordinator.hasPendingChangesForProject(cloudProject.id);
    
    if (hasPendingChanges) {
      this.logger.debug('检测到本地未同步修改，使用 LWW 合并');
      // 逐个任务比较 updatedAt，保留最新的
      const mergedTasks = this.mergeTasksWithLWW(localProject.tasks, cloudProject.tasks);
      const mergedConnections = this.mergeConnectionsWithLWW(
        localProject.connections, 
        cloudProject.connections
      );
      
      const mergedProject: Project = {
        ...cloudProject,
        tasks: mergedTasks,
        connections: mergedConnections
      };
      
      const updatedProjects = this.projectState.projects().map((p: Project) =>
        p.id === cloudProject.id ? mergedProject : p
      );
      this.projectState.setProjects(updatedProjects);
    } else {
      // 无本地修改，直接覆盖
      const updatedProjects = this.projectState.projects().map((p: Project) =>
        p.id === cloudProject.id ? cloudProject : p
      );
      this.projectState.setProjects(updatedProjects);
    }
  }
  
  /** LWW 合并任务列表（委托给 `utils/lww-merge`，保持历史私有入口以免外部调用） */
  private mergeTasksWithLWW(localTasks: Task[], cloudTasks: Task[]): Task[] {
    return mergeByLww(localTasks, cloudTasks);
  }

  /** LWW 合并连接列表（Tombstone Wins + updatedAt 比较，委托给通用实现） */
  private mergeConnectionsWithLWW(localConns: Connection[], cloudConns: Connection[]): Connection[] {
    return mergeByLwwWithTombstone(localConns, cloudConns);
  }
  
  /**
   * 智能合并云端数据
   * 幂等检查 + 无脏标记静默覆盖 + 有脏标记触发冲突处理
   */
  private async mergeCloudData(
    cloudProjects: Project[], 
    localProjects: Project[], 
    userId: string,
    previousActive: string | null
  ): Promise<void> {
    this.logger.debug('开始合并云端数据');
    
    const validatedProjects: Project[] = [];
    const failedProjects: string[] = [];

    for (const p of cloudProjects) {
      this.logger.debug('云端项目', { id: p.id, name: p.name, taskCount: p.tasks?.length ?? 0 });
      const result = this.syncCoordinator.validateAndRebalanceWithResult(p);
      if (result.ok) {
        validatedProjects.push(result.value);
      } else if (isFailure(result)) {
        failedProjects.push(p.name || p.id);
        this.logger.warn(`项目 "${p.name}" 验证失败，跳过加载`, { error: result.error.message });
      }
    }

    if (failedProjects.length > 0) {
      this.toastService.warning(
        '部分项目加载失败',
        `以下项目数据损坏已跳过: ${failedProjects.join(', ')}`
      );
    }

    // 合并云端数据
    const offlineProjects = localProjects;
    let mergedProjects = validatedProjects;

    if (offlineProjects && offlineProjects.length > 0) {
      const mergeResult = await this.syncCoordinator.mergeOfflineDataOnReconnect(
        mergedProjects,
        offlineProjects,
        userId
      );
      mergedProjects = mergeResult.projects;
      
      this.logger.debug('合并后项目数量', { count: mergedProjects.length });

      if (mergeResult.syncedCount > 0) {
        this.toastService.success(
          '数据已同步',
          `已将 ${mergeResult.syncedCount} 个项目的修改同步到云端`
        );
      }
    }

    // 更新 UI，使用智能合并避免“跳动”
    this.applyMergedProjects(mergedProjects, previousActive);
    
    // 保存合并后的快照
    this.syncCoordinator.core.saveOfflineSnapshot(mergedProjects);
  }
  
  /** 应用合并后的项目数据（避免 UI “跳动”） */
  private applyMergedProjects(mergedProjects: Project[], previousActive: string | null): void {
    const currentActive = this.projectState.activeProjectId();
    
    this.projectState.setProjects(mergedProjects);
    
    // 保持当前活动项目，除非它已被删除
    if (currentActive && mergedProjects.some(p => p.id === currentActive)) {
      // 保持不变
    } else if (previousActive && mergedProjects.some(p => p.id === previousActive)) {
      this.projectState.setActiveProjectId(previousActive);
    } else {
      this.projectState.setActiveProjectId(mergedProjects[0]?.id ?? null);
    }
    
    // 更新附件监控
    const activeProject = mergedProjects.find(p => p.id === this.projectState.activeProjectId());
    if (activeProject) {
      void this.monitorProjectAttachments(activeProject);
    }
  }
  
  /** 将本地数据迁移到云端（首次登录场景） */
  private async migrateLocalToCloud(localProjects: Project[], userId: string): Promise<void> {
    this.logger.info('首次登录，迁移本地离线数据到云端');
    
    let syncedCount = 0;
    const failedProjects: string[] = [];
    
    for (const project of localProjects) {
      this.logger.debug('迁移项目', { projectId: project.id, name: project.name });
      const rebalanced = this.layoutService.rebalance(project);
      const result = await this.syncCoordinator.core.saveProjectSmart(rebalanced, userId);
      if (result.success) {
        syncedCount++;
        this.logger.debug('项目迁移成功', { name: project.name });
      } else {
        failedProjects.push(project.name || project.id);
        this.logger.warn('项目迁移失败', { name: project.name, result });
      }
    }
    
    if (syncedCount > 0) {
      this.toastService.success(
        '本地数据已同步',
        `已将 ${syncedCount} 个项目同步到云端`
      );
    }
    
    if (failedProjects.length > 0) {
      this.toastService.warning(
        '部分项目同步失败',
        `以下项目无法同步: ${failedProjects.join(', ')}`
      );
    }
  }

  // ========== 私有方法 ==========

  /** 加载用户数据：加载项目 + 后台建立实时订阅 */
  private async loadUserData(userId: string, sessionGuard?: SessionGuardContext): Promise<void> {
    if (this.shouldAbortStaleSession(sessionGuard, 'loadUserData:start')) {
      return;
    }

    // 先加载项目数据（这个需要等待）
    try {
      await this.loadProjectsForSession(sessionGuard ?? this.createSessionGuard(userId));
    } catch (error) {
      if (this.shouldAbortStaleSession(sessionGuard, 'loadUserData:load-projects-error')) {
        return;
      }
      // loadProjects 内部已有错误处理，这里是最后的防线
      this.logger.warn('loadProjects 未捕获异常', error);
      // 确保至少有可用的数据
      try {
        await this.loadFromCacheOrSeed(undefined, sessionGuard);
      } catch (fallbackError) {
        this.logger.warn('种子数据加载失败', fallbackError);
      }
      
      // 向用户显示友好的错误提示
      this.toastService.error('数据加载失败', '已尝试加载本地数据，如问题持续请刷新页面');
      
      return;
    }

    if (this.shouldAbortStaleSession(sessionGuard, 'loadUserData:after-load-projects')) {
      return;
    }
    
    // 实时订阅和冲突数据重载在后台执行，不阻塞 UI
    // 使用 Promise 而非 await，让它们在后台运行
    this.syncCoordinator.core.initRealtimeSubscription(userId).catch(e => {
      this.logger.warn('实时订阅初始化失败（后台）', e);
      // 实时订阅失败不影响核心功能，静默处理
    });

    this.syncCoordinator.tryReloadConflictData(userId, (id) =>
      this.projectState.getProject(id)
    ).catch(e => {
      this.logger.warn('冲突数据重载失败（后台）', e);
      // 冲突数据重载失败不影响核心功能，静默处理
    });
  }

  /** 从缓存或种子数据加载（含数据完整性检查） */
  private async loadStartupSnapshotResult(): Promise<{
    source: 'idb' | 'localStorage' | 'none';
    projectCount: number;
    bytes: number;
    migratedLegacy: boolean;
    projects: Project[];
    ownerUserId?: string | null;
  }> {
    const core = this.syncCoordinator.core as {
      loadStartupOfflineSnapshot?: () => Promise<{
        source: 'idb' | 'localStorage' | 'none';
        projectCount: number;
        bytes: number;
        migratedLegacy: boolean;
        projects: Project[];
      }>;
      loadOfflineSnapshot: () => Project[] | null;
    };

    if (typeof core.loadStartupOfflineSnapshot === 'function') {
      return core.loadStartupOfflineSnapshot();
    }

    const projects = core.loadOfflineSnapshot() ?? [];
    return {
      source: projects.length > 0 ? 'localStorage' : 'none',
      projectCount: projects.length,
      bytes: 0,
      migratedLegacy: false,
      projects,
    };
  }

  private async loadFromCacheOrSeed(snapshotOverride?: {
    source: 'idb' | 'localStorage' | 'none';
    projectCount: number;
    bytes: number;
    migratedLegacy: boolean;
    projects: Project[];
    ownerUserId?: string | null;
  }, sessionGuard?: SessionGuardContext): Promise<void> {
    if (this.shouldAbortStaleSession(sessionGuard, 'loadFromCacheOrSeed:start')) {
      return;
    }

    const snapshot = snapshotOverride ?? await this.loadStartupSnapshotResult();
    if (this.shouldAbortStaleSession(sessionGuard, 'loadFromCacheOrSeed:snapshot-loaded')) {
      return;
    }
    const snapshotProjects = this.getSnapshotProjectsForSession(
      snapshot,
      sessionGuard?.userId ?? this.authService.currentUserId(),
      'loadFromCacheOrSeed:snapshot-loaded'
    );
    if (!snapshotProjects.ownerMatched) {
      this.clearStartupProjectCatalogState();
    }
    const cached = snapshotProjects.projects;
    let projects: Project[] = [];
    let usedSeed = false;

    if (cached && cached.length > 0) {
      // 验证并迁移每个缓存的项目
      const validProjects: Project[] = [];
      const corruptedProjects: string[] = [];
      
      for (const p of cached) {
        try {
          const migrated = this.migrateProject(p);
          // 基本完整性检查
          if (migrated.id && Array.isArray(migrated.tasks)) {
            validProjects.push(migrated);
          } else {
            corruptedProjects.push(p.name || p.id || '未知项目');
          }
        } catch (error) {
          this.logger.warn('项目迁移失败', { projectId: p.id, error });
          corruptedProjects.push(p.name || p.id || '未知项目');
        }
      }
      
      if (corruptedProjects.length > 0) {
        this.logger.warn('跳过损坏的项目', { corruptedProjects });
        this.toastService.warning(
          '部分数据已跳过',
          `以下项目数据损坏已跳过: ${corruptedProjects.join(', ')}`
        );
      }
      
      if (validProjects.length > 0) {
        projects = validProjects;
      } else {
        // 【P0 修复 2026-03-27】已登录用户不创建种子数据，等后台同步填充真实数据
        // 种子数据仅在未登录/离线模式下创建，避免覆盖用户真实数据
        const isAuthenticatedUser = !!this.authService.currentUserId()
          && this.authService.currentUserId() !== AUTH_CONFIG.LOCAL_MODE_USER_ID;
        if (isAuthenticatedUser) {
          this.logger.warn('已登录用户无有效本地缓存，跳过种子数据，等待后台同步');
          projects = [];
        } else {
          projects = this.seedProjects();
          usedSeed = true;
        }
      }
    } else {
      // 【P0 修复 2026-03-27】同上：保护已登录用户免受种子覆盖
      const isAuthenticatedUser = !!this.authService.currentUserId()
        && this.authService.currentUserId() !== AUTH_CONFIG.LOCAL_MODE_USER_ID;
      if (isAuthenticatedUser) {
        this.logger.warn('已登录用户无本地缓存，跳过种子数据，等待后台同步');
        projects = [];
      } else {
        projects = this.seedProjects();
        usedSeed = true;
      }
    }

    if (this.shouldAbortStaleSession(sessionGuard, 'loadFromCacheOrSeed:apply-projects')) {
      return;
    }

    this.projectState.setProjects(projects);
    this.projectState.setActiveProjectId(projects[0]?.id ?? null);
    this.syncStartupProjectCatalogStageAfterLocalRestore(this.authService.currentUserId());
    pushStartupTrace('user_session.snapshot_applied', {
      source: snapshot.source,
      projectCount: projects.length,
      bytes: snapshot.bytes,
      migratedLegacy: snapshot.migratedLegacy,
      usedSeed,
    });
  }

  /** 迁移项目数据格式 */
  private migrateProject(project: Project): Project {
    const migrated = { ...project };
    const currentUserId = this.authService.currentUserId();
    const isAuthenticatedUser = !!currentUserId && currentUserId !== AUTH_CONFIG.LOCAL_MODE_USER_ID;

    migrated.updatedAt = migrated.updatedAt || new Date().toISOString();
    migrated.version = CACHE_CONFIG.CACHE_VERSION;
    migrated.syncSource = migrated.syncSource === 'synced' ? 'synced' : 'local-only';
    migrated.pendingSync = migrated.syncSource === 'local-only'
      ? (isAuthenticatedUser || migrated.pendingSync === true)
      : (migrated.pendingSync ?? false);

    const safeTasks = Array.isArray(migrated.tasks) ? migrated.tasks : [];
    migrated.tasks = safeTasks.map(t => {
      const status = t.status || 'active';
      return {
        ...t,
        status,
        completedAt: status === 'completed'
          ? (t.completedAt ?? t.updatedAt ?? t.createdDate ?? migrated.updatedAt)
          : null,
        rank: t.rank ?? 10000,
        displayId: t.displayId || '?',
        hasIncompleteTask: t.hasIncompleteTask ?? false
      };
    });

    migrated.connections = Array.isArray(migrated.connections) ? migrated.connections : [];

    return this.layoutService.rebalance(migrated);
  }

  /** 生成种子项目数据 */
  private seedProjects(): Project[] {
    const now = new Date().toISOString();
    // 使用有效的 UUID 格式（所有 ID 必须是 UUID，以便同步到 Supabase）
    const seedProjectId = crypto.randomUUID();
    const task1Id = crypto.randomUUID();
    const task2Id = crypto.randomUUID();
    const conn1Id = crypto.randomUUID();
    return [
      this.layoutService.rebalance({
        id: seedProjectId,
        name: 'Alpha Protocol',
        description: 'NanoFlow 核心引擎启动计划。',
        createdDate: now,
        syncSource: 'local-only',
        pendingSync: false,
        tasks: [
          {
            id: task1Id,
            title: '阶段 1: 环境搭建',
            content: '初始化项目环境。\n- [ ] 初始化 git 仓库\n- [ ] 安装 Node.js 依赖',
            stage: 1,
            parentId: null,
            order: 1,
            rank: 10000,
            status: 'active',
            x: 100,
            y: 100,
            createdDate: now,
            displayId: '1'
          },
          {
            id: task2Id,
            title: '核心逻辑实现',
            content: '交付核心业务逻辑。\n- [ ] 编写单元测试',
            stage: 2,
            parentId: task1Id,
            order: 1,
            rank: 10500,
            status: 'active',
            x: 300,
            y: 100,
            createdDate: now,
            displayId: '1,a'
          }
        ],
        connections: [
          { id: conn1Id, source: task1Id, target: task2Id }
        ]
      })
    ];
  }

  /** 监控项目附件 URL */
  private async monitorProjectAttachments(project: Project): Promise<void> {
    const userId = this.currentUserId();
    if (!userId) return;

    const taskAttachmentPairs = project.tasks.flatMap(task =>
      (task.attachments ?? []).map(attachment => ({ taskId: task.id, attachment }))
    );

    // 无附件快速路径：不触发 AttachmentService 懒加载
    if (taskAttachmentPairs.length === 0) {
      this.attachmentServiceRef?.clearMonitoredAttachments();
      return;
    }

    const attachmentService = await this.getAttachmentServiceLazy();
    if (!attachmentService) return;

    attachmentService.clearMonitoredAttachments();
    for (const pair of taskAttachmentPairs) {
      attachmentService.monitorAttachment(userId, project.id, pair.taskId, pair.attachment);
    }
  }
}
