import { DestroyRef, Injectable, computed, inject } from "@angular/core";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SupabaseClientService } from "../../../services/supabase-client.service";
import { AuthService } from "../../../services/auth.service";
import { ToastService } from "../../../services/toast.service";
import { LoggerService } from "../../../services/logger.service";
import { AUTH_CONFIG } from "../../../config/auth.config";
import { SIYUAN_CONFIG } from "../../../config/siyuan.config";
import { ExternalSourceCacheService } from "./external-source-cache.service";
import { ExternalSourceLinkStore } from "./external-source-link.store";
import {
  getRemainingBrowserNetworkResumeDelayMs,
  isBrowserNetworkSuspendedError,
  isBrowserNetworkSuspendedWindow,
} from "../../../utils/browser-network-suspension";
import type {
  ExternalSourceLink,
  ExternalSourceRole,
} from "./external-source.model";
import {
  normalizeSiyuanUri,
  parseSiyuanBlockLink,
  shortenSiyuanBlockId,
} from "./siyuan/siyuan-link-parser";

/** Postgres 唯一约束冲突 errorCode；命名常量便于检索 23505 的所有处理位置。 */
const POSTGRES_UNIQUE_VIOLATION = "23505";
const NETWORK_RESUME_RETRY_BUFFER_MS = 50;

type RemotePullResult = {
  links: ExternalSourceLink[];
  deferredBySuspension: boolean;
};

interface ExternalSourceLinkRow {
  id: string;
  user_id: string;
  task_id: string;
  source_type: "siyuan-block";
  target_id: string;
  uri: string;
  label: string | null;
  hpath: string | null;
  role: ExternalSourceRole | null;
  sort_order: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ExternalSourceLinkTableSchema {
  public: {
    Tables: {
      external_source_links: {
        Row: ExternalSourceLinkRow;
        Insert: ExternalSourceLinkRow;
        Update: Partial<ExternalSourceLinkRow>;
        Relationships: [];
      };
    };
  };
}

type ExternalSourceSupabaseClient =
  SupabaseClient<ExternalSourceLinkTableSchema>;

@Injectable({ providedIn: "root" })
export class ExternalSourceLinkService {
  private readonly store = inject(ExternalSourceLinkStore);
  private readonly cache = inject(ExternalSourceCacheService);
  private readonly supabase = inject(SupabaseClientService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  private readonly logger =
    inject(LoggerService).category("ExternalSourceLink");

  readonly links = this.store.links;
  readonly activeLinks = computed(() =>
    this.links().filter((link) => !link.deletedAt),
  );
  private initialized = false;
  private loadedOwnerId: string | null = null;
  private flushPromise: Promise<void> | null = null;
  /** 缓存正在进行的 ensureLoaded，防止并发 caller 各自跑一次 pull/merge。 */
  private loadPromise: Promise<void> | null = null;
  /** 上一次成功 pullRemoteLinks 的时间戳（ms）；用于 refreshIfStale 的陈旧判定。 */
  private lastPullAt = 0;
  /** 缓存正在进行的 refreshIfStale，避免 visibility/online 事件并发各自 pull 一次。 */
  private refreshPromise: Promise<void> | null = null;
  /** 浏览器事件监听器解绑句柄，确保 service 销毁时不泄漏。 */
  private opportunisticListenersBound = false;
  private resumeSyncTimer: number | null = null;
  private resumeSyncForceRefresh = false;

  constructor() {
    // 单例 service 在 root 注入器销毁时（HMR/SSR teardown）解绑事件监听器，避免内存泄漏。
    inject(DestroyRef).onDestroy(() => {
      this.clearResumeSyncTimer();
      this.unbindOpportunisticListeners();
    });
  }

  async ensureLoaded(): Promise<void> {
    const ownerId = this.currentUserId();
    if (this.initialized && this.loadedOwnerId === ownerId) return;
    if (this.loadPromise && this.loadedOwnerId === ownerId) return this.loadPromise;
    this.loadPromise = this.runEnsureLoaded(ownerId).finally(() => {
      this.loadPromise = null;
    });
    return this.loadPromise;
  }

  private async runEnsureLoaded(ownerId: string): Promise<void> {
    this.initialized = true;
    this.loadedOwnerId = ownerId;

    const localLinks = await this.cache.loadLinks();
    this.store.replaceAll(this.mergeLinks(localLinks, []));
    const remotePull = await this.pullRemoteLinks();
    const merged = this.mergeLinks(localLinks, remotePull.links);
    this.store.replaceAll(merged);
    await this.cache.saveLinks(merged);
    if (!remotePull.deferredBySuspension) {
      this.lastPullAt = Date.now();
      await this.pushLocalNewerLinks(merged, remotePull.links);
      void this.flushPendingLinks();
    }
    this.bindOpportunisticListeners();
  }

  /**
   * 机会式远端刷新：visibility/online 事件 + 显式 force 触发。
   * 当 lastPullAt 早于 REMOTE_REFRESH_STALE_MS 时重新 pull-merge；否则跳过以节省请求。
   * 与 ensureLoaded 共享 owner 切换语义；并发调用复用同一 in-flight promise。
   */
  async refreshIfStale(force = false): Promise<void> {
    if (!this.initialized) return;
    const ownerId = this.currentUserId();
    if (this.loadedOwnerId !== ownerId) return; // owner 切换会经 ensureLoaded 处理
    if (!force && Date.now() - this.lastPullAt < SIYUAN_CONFIG.REMOTE_REFRESH_STALE_MS) return;
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.runRefresh().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  private async runRefresh(): Promise<void> {
    const localLinks = await this.cache.loadLinks();
    const remotePull = await this.pullRemoteLinks();
    if (remotePull.deferredBySuspension) {
      return;
    }

    this.lastPullAt = Date.now();
    const merged = this.mergeLinks(localLinks, remotePull.links);
    this.store.replaceAll(merged);
    await this.cache.saveLinks(merged);
    await this.pushLocalNewerLinks(merged, remotePull.links);
  }

  private bindOpportunisticListeners(): void {
    if (this.opportunisticListenersBound || typeof window === "undefined") return;
    this.opportunisticListenersBound = true;
    // 用箭头函数稳定引用，便于 unbind 时移除同一实例。
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    window.addEventListener("online", this.onOnline);
  }

  private unbindOpportunisticListeners(): void {
    if (!this.opportunisticListenersBound || typeof window === "undefined") return;
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    window.removeEventListener("online", this.onOnline);
    this.opportunisticListenersBound = false;
  }

  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState === "visible") {
      this.scheduleResumeSync(false);
    }
  };

  private readonly onOnline = (): void => {
    // 网络恢复时要等待浏览器恢复保护期结束，再 flush pending / 拉远端真相。
    this.scheduleResumeSync(true);
  };

  activeLinksForTask(taskId: string): ExternalSourceLink[] {
    void this.ensureLoaded();
    return this.store.activeLinksForTask(taskId);
  }

  firstActiveLinkForTask(taskId: string): ExternalSourceLink | null {
    void this.ensureLoaded();
    return this.store.firstActiveLinkForTask(taskId);
  }

  async bindSiyuanBlock(
    taskId: string,
    input: string,
    role: ExternalSourceRole = "context",
  ): Promise<ExternalSourceLink | null> {
    const parsed = this.parseSiyuanInput(input);
    if (!parsed) return null;

    await this.ensureLoaded();
    const existing = this.store
      .activeLinksForTask(taskId)
      .find(
        (link) =>
          link.sourceType === "siyuan-block" &&
          link.targetId === parsed.blockId,
      );
    if (existing) return existing;

    const now = new Date().toISOString();
    const link: ExternalSourceLink = {
      id: crypto.randomUUID(),
      taskId,
      sourceType: "siyuan-block",
      targetId: parsed.blockId,
      uri: parsed.uri,
      label: `思源 ${shortenSiyuanBlockId(parsed.blockId)}`,
      role,
      sortOrder: this.store.activeLinksForTask(taskId).length,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.persistLocal(link);
    await this.cache.upsertPendingLink(link, { resetRetryCount: true });
    void this.flushPendingLinks();
    this.toast.success("已关联思源块");
    return link;
  }

  async replaceSiyuanBlock(
    linkId: string,
    input: string,
  ): Promise<ExternalSourceLink | null> {
    const parsed = this.parseSiyuanInput(input);
    if (!parsed) return null;

    await this.ensureLoaded();
    const existing = this.store.getLink(linkId);
    if (!existing || existing.deletedAt) return null;
    if (existing.targetId === parsed.blockId) return existing;

    const duplicate = this.store
      .activeLinksForTask(existing.taskId)
      .find(
        (link) =>
          link.id !== existing.id &&
          link.sourceType === "siyuan-block" &&
          link.targetId === parsed.blockId,
      );
    if (duplicate) {
      const now = new Date().toISOString();
      const tombstone = { ...existing, deletedAt: now, updatedAt: now };
      await this.persistLocal(tombstone);
      await this.cache.deletePreviewsForLink(tombstone.id);
      await this.cache.upsertPendingLink(tombstone, { resetRetryCount: true });
      void this.flushPendingLinks();
      this.toast.info("已切换到已有思源关联");
      return duplicate;
    }

    const now = new Date().toISOString();
    const link = this.normalizeLink({
      ...existing,
      targetId: parsed.blockId,
      uri: parsed.uri,
      label: `思源 ${shortenSiyuanBlockId(parsed.blockId)}`,
      hpath: undefined,
      deletedAt: null,
      updatedAt: now,
    });
    await this.persistLocal(link);
    await this.cache.deletePreviewsForLink(link.id);
    await this.cache.upsertPendingLink(link, { resetRetryCount: true });
    void this.flushPendingLinks();
    this.toast.success("已更新思源关联");
    return link;
  }

  async removeLink(linkId: string): Promise<void> {
    await this.ensureLoaded();
    const existing = this.store.getLink(linkId);
    if (!existing) return;
    const link = {
      ...existing,
      deletedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await this.persistLocal(link);
    await this.cache.deletePreviewsForLink(link.id);
    await this.cache.upsertPendingLink(link, { resetRetryCount: true });
    void this.flushPendingLinks();
    this.toast.info("已解除思源关联");
  }

  async updateMetadata(
    linkId: string,
    patch: Pick<
      Partial<ExternalSourceLink>,
      "label" | "hpath" | "role" | "sortOrder"
    >,
  ): Promise<void> {
    await this.ensureLoaded();
    const existing = this.store.getLink(linkId);
    if (!existing) return;
    const link = this.normalizeLink({
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    });
    await this.persistLocal(link);
    await this.cache.upsertPendingLink(link, { resetRetryCount: true });
    void this.flushPendingLinks();
  }

  async importPointers(links: ExternalSourceLink[]): Promise<void> {
    if (links.length === 0) return;
    await this.ensureLoaded();
    for (const rawLink of links) {
      const link = this.normalizeLink(rawLink);
      await this.persistLocal(link);
      await this.cache.upsertPendingLink(link, { resetRetryCount: true });
    }
    void this.flushPendingLinks();
  }

  openLink(link: ExternalSourceLink): void {
    if (typeof window === "undefined") return;
    const parsed = parseSiyuanBlockLink(link.uri || link.targetId);
    if (!parsed || parsed.blockId !== link.targetId) {
      this.toast.error("思源链接无效", "已阻止打开非 siyuan:// 块链接");
      return;
    }
    // 用新窗口承载 siyuan:// protocol handler，避免替换 SPA 自身的 URL 导致状态被清空。
    // 浏览器拒绝识别此 protocol 时，新窗口会被立刻关闭，但当前应用保持完整。
    const opened = window.open(parsed.uri, "_blank", "noopener,noreferrer");
    if (!opened) this.toast.info("浏览器已拦截弹窗，请在原块上右键打开");
  }

  async flushPendingLinks(): Promise<void> {
    if (this.flushPromise) return this.flushPromise;
    this.flushPromise = this.flushPendingLinksInternal().finally(() => {
      this.flushPromise = null;
    });
    return this.flushPromise;
  }

  private async flushPendingLinksInternal(): Promise<void> {
    if (this.deferRemoteWorkForSuspension("浏览器网络挂起，延后刷新思源锚点 pending 队列")) {
      return;
    }

    const pending = await this.cache.loadPendingLinks();
    for (const entry of pending) {
      const result = await this.pushLink(entry.link);
      if (result.outcome === "success" || result.outcome === "drop") {
        await this.cache.removePendingLink(entry.link.id);
      } else if (result.deferredBySuspension) {
        return;
      } else {
        await this.cache.recordPendingFailure(entry.link.id, result.errorCode);
      }
    }
  }

  private async persistLocal(link: ExternalSourceLink): Promise<void> {
    this.store.upsert(link);
    await this.cache.saveLinks(this.mergeLinks(this.links(), []));
  }

  private async pullRemoteLinks(): Promise<RemotePullResult> {
    const userId = this.currentUserId();
    if (userId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      return { links: [], deferredBySuspension: false };
    }

    if (this.deferRemoteWorkForSuspension("浏览器网络挂起，延后拉取思源锚点", { userId })) {
      return { links: [], deferredBySuspension: true };
    }

    const client = await this.getClient();
    if (!client) {
      return { links: [], deferredBySuspension: false };
    }

    try {
      const { data, error } = await client
        .from("external_source_links")
        .select(
          "id,user_id,task_id,source_type,target_id,uri,label,hpath,role,sort_order,deleted_at,created_at,updated_at",
        )
        .eq("user_id", userId);
      if (error) throw error;
      return {
        links: (data ?? []).map((row) => this.rowToLink(row)),
        deferredBySuspension: false,
      };
    } catch (error) {
      if (isBrowserNetworkSuspendedError(error) || isBrowserNetworkSuspendedWindow()) {
        this.logSuspensionDeferral("浏览器网络挂起，延后拉取思源锚点", { userId });
        return { links: [], deferredBySuspension: true };
      }

      this.logger.warn("拉取思源锚点失败，保留本地状态", {
        message: error instanceof Error ? error.message : "unknown",
      });
      return { links: [], deferredBySuspension: false };
    }
  }

  private async pushLocalNewerLinks(
    localLinks: ExternalSourceLink[],
    remoteLinks: ExternalSourceLink[],
  ): Promise<void> {
    const remoteById = new Map(remoteLinks.map((link) => [link.id, link]));
    const localsToPush = localLinks.filter((local) => {
      const remote = remoteById.get(local.id);
      return !remote || local.updatedAt > remote.updatedAt;
    });

    if (localsToPush.length === 0) {
      return;
    }

    if (this.deferRemoteWorkForSuspension("浏览器网络挂起，延后推送本地较新的思源锚点", {
      linkCount: localsToPush.length,
    })) {
      for (const local of localsToPush) {
        await this.cache.upsertPendingLink(local, { resetRetryCount: false });
      }
      return;
    }

    for (let index = 0; index < localsToPush.length; index += 1) {
      const local = localsToPush[index];
      // 已确认在线（pullRemoteLinks 成功），优先直接推送，避免 IndexedDB 写放大；
      // 推送失败时再走 pending + retry 路径。
      const result = await this.pushLink(local);
      if (result.outcome !== "success" && result.outcome !== "drop") {
        await this.cache.upsertPendingLink(local, { resetRetryCount: !result.deferredBySuspension });
        if (result.deferredBySuspension) {
          for (const deferred of localsToPush.slice(index + 1)) {
            await this.cache.upsertPendingLink(deferred, { resetRetryCount: false });
          }
          return;
        }
      }
    }
  }

  private async pushLink(
    link: ExternalSourceLink,
  ): Promise<
    | { outcome: "success" }
    | { outcome: "drop"; reason: "local-mode" | "no-client" | "duplicate" }
    | { outcome: "retry"; errorCode: string; deferredBySuspension?: boolean }
  > {
    const userId = this.currentUserId();
    if (this.deferRemoteWorkForSuspension("浏览器网络挂起，延后推送思源锚点", {
      linkId: this.safeId(link.id),
    })) {
      return { outcome: "retry", errorCode: "browser-network-suspended", deferredBySuspension: true };
    }

    const client = await this.getClient();
    if (!client) return { outcome: "drop", reason: "no-client" };
    if (userId === AUTH_CONFIG.LOCAL_MODE_USER_ID)
      return { outcome: "drop", reason: "local-mode" };
    try {
      const { error } = await client
        .from("external_source_links")
        .upsert(this.linkToRow(link, userId) as unknown as never, {
          onConflict: "id",
        });
      if (error) {
        const errorCode = (error as { code?: string }).code ?? "unknown";
        // 23505 = Postgres unique_violation：另一端已绑定同一 (task, target)。
        // 不再重试，丢弃 pending 项让下一次 ensureLoaded 重新拉远端真相。
        if (errorCode === POSTGRES_UNIQUE_VIOLATION) {
          return this.handleUniqueConflict(link, userId, client);
        }
        throw error;
      }
      return { outcome: "success" };
    } catch (error) {
      if (isBrowserNetworkSuspendedError(error) || isBrowserNetworkSuspendedWindow()) {
        this.logSuspensionDeferral("浏览器网络挂起，延后推送思源锚点", {
          linkId: this.safeId(link.id),
        });
        return { outcome: "retry", errorCode: "browser-network-suspended", deferredBySuspension: true };
      }

      const errorCode = this.classifyPushError(error);
      this.logger.warn("推送思源锚点失败，已保留本机重试", {
        linkId: this.safeId(link.id),
        errorCode,
        message: error instanceof Error ? error.message : "unknown",
      });
      return { outcome: "retry", errorCode };
    }
  }

  private async handleUniqueConflict(
    link: ExternalSourceLink,
    userId: string,
    client: ExternalSourceSupabaseClient,
  ): Promise<{ outcome: "success" } | { outcome: "drop"; reason: "duplicate" }> {
    this.logger.info("思源锚点唯一冲突，丢弃本机 pending", {
      linkId: this.safeId(link.id),
    });
    if (await this.resolveUniqueConflict(link, userId, client)) {
      return { outcome: "success" };
    }
    return { outcome: "drop", reason: "duplicate" };
  }

  private async resolveUniqueConflict(
    link: ExternalSourceLink,
    userId: string,
    client: ExternalSourceSupabaseClient,
  ): Promise<boolean> {
    const now = new Date().toISOString();
    const tombstone = this.normalizeLink({
      ...link,
      deletedAt: now,
      updatedAt: now,
    });
    try {
      const { error } = await client
        .from("external_source_links")
        .upsert(this.linkToRow(tombstone, userId) as unknown as never, {
          onConflict: "id",
        });
      if (error) throw error;

      await this.persistLocal(tombstone);
      await this.cache.deletePreviewsForLink(tombstone.id);
      const remotePull = await this.pullRemoteLinks();
      if (!remotePull.deferredBySuspension) {
        this.lastPullAt = Date.now();
        const localLinks = await this.cache.loadLinks();
        const merged = this.mergeLinks(localLinks, remotePull.links);
        this.store.replaceAll(merged);
        await this.cache.saveLinks(merged);
      }
      this.toast.info("思源锚点已在其他设备建立，已切换到已有关联");
      return true;
    } catch (error) {
      this.logger.warn("思源锚点唯一冲突收敛失败，等待下次刷新", {
        linkId: this.safeId(link.id),
        message: error instanceof Error ? error.message : "unknown",
      });
      this.toast.info("思源锚点已在其他设备建立，稍后自动刷新合并");
      return false;
    }
  }

  private classifyPushError(error: unknown): string {
    if (isBrowserNetworkSuspendedError(error)) {
      return "browser-network-suspended";
    }

    if (error && typeof error === "object") {
      const code = (error as { code?: unknown }).code;
      if (typeof code === "string" && code.length > 0) return code;
      const status = (error as { status?: unknown }).status;
      if (status === 401 || status === 403) return "auth";
    }
    return "unknown";
  }

  private async getClient(): Promise<ExternalSourceSupabaseClient | null> {
    const client = await this.supabase.clientAsync();
    return client as unknown as ExternalSourceSupabaseClient | null;
  }

  private currentUserId(): string {
    return this.auth.currentUserId() ?? AUTH_CONFIG.LOCAL_MODE_USER_ID;
  }

  private mergeLinks(
    localLinks: ExternalSourceLink[],
    remoteLinks: ExternalSourceLink[],
  ): ExternalSourceLink[] {
    const byId = new Map<string, ExternalSourceLink>();
    for (const rawLink of [...localLinks, ...remoteLinks]) {
      const link = this.normalizeLink(rawLink);
      const existing = byId.get(link.id);
      if (!existing || existing.updatedAt < link.updatedAt)
        byId.set(link.id, link);
    }
    return this.collapseActiveDuplicates(this.dropExpiredTombstones(Array.from(byId.values())));
  }

  /**
   * 本机墓碑 GC：丢弃 deletedAt 早于 TOMBSTONE_RETENTION_MS 的软删除记录。
   * 客户端 UUID 永不复用，此操作无 id 复活风险；服务端硬删除依赖独立的 cron 调度。
   */
  private dropExpiredTombstones(links: ExternalSourceLink[]): ExternalSourceLink[] {
    const cutoff = Date.now() - SIYUAN_CONFIG.TOMBSTONE_RETENTION_MS;
    return links.filter((link) => {
      if (!link.deletedAt) return true;
      const deletedMs = Date.parse(link.deletedAt);
      // Date.parse 失败时返回 NaN，保守保留以避免误删非法时间戳的记录。
      if (!Number.isFinite(deletedMs)) return true;
      return deletedMs >= cutoff;
    });
  }

  private collapseActiveDuplicates(
    links: ExternalSourceLink[],
  ): ExternalSourceLink[] {
    const activeByNaturalKey = new Map<string, ExternalSourceLink>();
    const next = new Map(links.map((link) => [link.id, link]));
    const now = new Date().toISOString();
    // updatedAt 是 ISO 8601 字符串，可直接做 lexicographic 比较；id 为 ASCII UUID。
    // 使用 < / > 避免 localeCompare 的 locale 漂移与多余开销，结果与字典序一致。
    const sorted = links.slice().sort((a, b) => {
      if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    for (const link of sorted) {
      if (link.deletedAt) continue;
      const key = `${link.taskId}|${link.sourceType}|${link.targetId}`;
      const existing = activeByNaturalKey.get(key);
      if (!existing) {
        activeByNaturalKey.set(key, link);
        continue;
      }
      const winner = this.pickCollapseWinner(existing, link);
      const loser = winner.id === existing.id ? link : existing;
      activeByNaturalKey.set(key, winner);
      next.set(loser.id, {
        ...loser,
        deletedAt: loser.deletedAt ?? now,
        updatedAt: loser.updatedAt > now ? loser.updatedAt : now,
      });
    }
    return Array.from(next.values());
  }

  private pickCollapseWinner(
    a: ExternalSourceLink,
    b: ExternalSourceLink,
  ): ExternalSourceLink {
    if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
    // updatedAt 相同时按 id 升序确定唯一 winner（多端一致），ASCII 比较避免 locale 漂移。
    return a.id <= b.id ? a : b;
  }

  private normalizeLink(link: ExternalSourceLink): ExternalSourceLink {
    const parsed =
      parseSiyuanBlockLink(link.targetId) ?? parseSiyuanBlockLink(link.uri);
    const targetId = parsed?.blockId ?? link.targetId;
    return {
      ...link,
      id: this.truncate(link.id, SIYUAN_CONFIG.MAX_LINK_ID_LENGTH),
      sourceType: "siyuan-block",
      targetId,
      uri: normalizeSiyuanUri(targetId),
      label: this.optionalTruncate(link.label, SIYUAN_CONFIG.MAX_LABEL_LENGTH),
      hpath: this.optionalTruncate(link.hpath, SIYUAN_CONFIG.MAX_HPATH_LENGTH),
      sortOrder: Number.isFinite(link.sortOrder) ? link.sortOrder : 0,
      deletedAt: link.deletedAt ?? null,
    };
  }

  private parseSiyuanInput(
    input: string,
  ): NonNullable<ReturnType<typeof parseSiyuanBlockLink>> | null {
    const parsed = parseSiyuanBlockLink(input);
    if (parsed) return parsed;
    this.toast.error(
      "思源链接无效",
      "请粘贴 siyuan://blocks/{id} 或思源块 ID",
    );
    return null;
  }

  private linkToRow(
    link: ExternalSourceLink,
    userId: string,
  ): ExternalSourceLinkRow {
    const normalized = this.normalizeLink(link);
    return {
      id: normalized.id,
      user_id: userId,
      task_id: normalized.taskId,
      source_type: normalized.sourceType,
      target_id: normalized.targetId,
      uri: this.truncate(normalized.uri, SIYUAN_CONFIG.MAX_URI_LENGTH),
      label: normalized.label ?? null,
      hpath: normalized.hpath ?? null,
      role: normalized.role ?? null,
      sort_order: normalized.sortOrder,
      deleted_at: normalized.deletedAt ?? null,
      created_at: normalized.createdAt,
      updated_at: normalized.updatedAt,
    };
  }

  private rowToLink(row: ExternalSourceLinkRow): ExternalSourceLink {
    return this.normalizeLink({
      id: row.id,
      taskId: row.task_id,
      sourceType: row.source_type,
      targetId: row.target_id,
      uri: row.uri,
      label: row.label ?? undefined,
      hpath: row.hpath ?? undefined,
      role: row.role ?? undefined,
      sortOrder: row.sort_order,
      deletedAt: row.deleted_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  private optionalTruncate(
    value: string | undefined,
    maxLength: number,
  ): string | undefined {
    if (!value) return undefined;
    return this.truncate(value, maxLength);
  }

  private truncate(value: string, maxLength: number): string {
    return value.length > maxLength ? value.slice(0, maxLength) : value;
  }

  private safeId(value: string): string {
    return value.length > 12 ? `${value.slice(0, 8)}…` : value;
  }

  private deferRemoteWorkForSuspension(
    message: string,
    details?: Record<string, unknown>,
  ): boolean {
    if (!isBrowserNetworkSuspendedWindow()) {
      return false;
    }

    this.logSuspensionDeferral(message, details);
    return true;
  }

  private logSuspensionDeferral(
    message: string,
    details?: Record<string, unknown>,
  ): void {
    this.logger.info(message, {
      ...details,
      resumeDelayMs: getRemainingBrowserNetworkResumeDelayMs(),
    });
    this.scheduleResumeSync(true);
  }

  private scheduleResumeSync(forceRefresh = false): void {
    if (typeof window === "undefined") {
      return;
    }

    if (typeof document !== "undefined" && document.visibilityState !== "visible") {
      return;
    }

    this.resumeSyncForceRefresh ||= forceRefresh;
    if (this.resumeSyncTimer != null) {
      return;
    }

    const delayMs = Math.max(100, getRemainingBrowserNetworkResumeDelayMs() + NETWORK_RESUME_RETRY_BUFFER_MS);
    this.resumeSyncTimer = window.setTimeout(() => {
      const shouldForceRefresh = this.resumeSyncForceRefresh;
      this.resumeSyncForceRefresh = false;
      this.resumeSyncTimer = null;
      void this.refreshIfStale(shouldForceRefresh);
      void this.flushPendingLinks();
    }, delayMs);
  }

  private clearResumeSyncTimer(): void {
    if (this.resumeSyncTimer != null) {
      clearTimeout(this.resumeSyncTimer);
      this.resumeSyncTimer = null;
    }
    this.resumeSyncForceRefresh = false;
  }
}
