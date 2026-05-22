import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

import {
  buildWidgetClientCapabilitiesPatch,
  consumeWidgetRateLimit,
  createServiceRoleClient,
  evaluateWidgetCapabilities,
  extractWidgetPushSupport,
  extractWidgetClientVersion,
  getClientIp,
  getCorsHeaders,
  getBearerToken,
  jsonResponse,
  loadWidgetCapabilities,
  loadWidgetLimits,
  logWidgetEvent,
  mergeJsonObjects,
  normalizeWidgetPlatform,
  parseWidgetToken,
  redactId,
  sha256Hex,
  toPublicWidgetCapabilities,
  type WidgetPlatform,
  withPrivateNoStoreHeaders,
} from '../_shared/widget-common.ts';
import {
  buildSummaryVersion,
  buildSummaryVersionCursor,
  isSummaryVersionRegressed,
} from './summary-version.ts';

interface WidgetDeviceRow {
  id: string;
  installation_id: string;
  user_id: string;
  secret_hash: string;
  token_hash: string | null;
  push_token: string | null;
  capabilities: Record<string, unknown> | null;
  binding_generation: number;
  revoked_at: string | null;
  expires_at: string;
}

interface WidgetSummaryRequest {
  clientSchemaVersion?: number;
  clientVersion?: string;
  supportsPush?: boolean;
  lastKnownSummaryVersion?: string;
  instanceId?: string;
  hostInstanceId?: string;
  platform?: WidgetPlatform;
}

interface FocusTaskSlotLike {
  taskId: string | null;
  sourceProjectId: string | null;
  inlineTitle: string | null;
  estimatedMinutes: number | null;
  waitMinutes?: number | null;
  waitStartedAt?: string | null;
  waitEndAt?: string | null;
  focusStatus?: string;
  isMaster?: boolean;
  isMain?: boolean;
}

interface FocusSessionStateLike {
  isActive?: boolean;
  commandCenterOrderIds?: string[];
  commandCenterTasks?: FocusTaskSlotLike[];
  comboSelectTasks?: FocusTaskSlotLike[];
  backupTasks?: FocusTaskSlotLike[];
}

interface DockEntryLike {
  taskId?: string | null;
  title?: string | null;
  sourceProjectId?: string | null;
  expectedMinutes?: number | null;
  waitMinutes?: number | null;
  waitStartedAt?: string | null;
  waitEndAt?: string | null;
  status?: string;
  isMain?: boolean;
  lane?: string;
  sourceKind?: string;
  dockedOrder?: number;
  manualOrder?: number | null;
}

interface DockSessionSnapshotLike {
  mainTaskId?: string | null;
  comboSelectIds?: string[];
  backupIds?: string[];
  focusSessionId?: string;
}

interface DockSnapshotLike {
  version?: number;
  focusMode?: boolean;
  session?: DockSessionSnapshotLike;
  entries?: DockEntryLike[];
  focusSessionState?: FocusSessionStateLike | null;
}

interface FocusSessionRow {
  id: string;
  updated_at: string;
  session_state: FocusSessionStateLike | null;
}

interface TaskRow {
  id: string;
  title: string | null;
  project_id: string;
  updated_at: string;
}

interface ProjectRow {
  id: string;
  title: string | null;
  updated_at: string | null;
}

interface ProjectIdRow {
  id: string;
}

interface BlackBoxRow {
  id: string;
  date: string | null;
  project_id: string | null;
  content: string | null;
  is_read: boolean | null;
  created_at: string | null;
  snooze_until: string | null;
  updated_at: string;
}

interface WidgetInstanceRow {
  id: string;
  binding_generation: number;
  uninstalled_at: string | null;
}

const WIDGET_DEVICE_SELECT = 'id,installation_id,user_id,secret_hash,token_hash,push_token,capabilities,binding_generation,revoked_at,expires_at';

type WidgetFreshnessState = 'fresh' | 'aging' | 'stale';
type WidgetTrustState = 'verified' | 'provisional' | 'untrusted' | 'auth-required';
type WidgetSourceState = 'cloud-confirmed' | 'cloud-pending-local-hint' | 'cache-only';

const UUID_LIKE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUMMARY_SCHEMA_VERSION = 1;
const ENTRY_QUERY = 'entry=widget&intent=open-workspace';
const ENTRY_URL = `./#/projects?${ENTRY_QUERY}`;
const MAX_BLACK_BOX_PREVIEW_COUNT = 5;
const GATE_READ_REAPPEAR_COOLDOWN_MS = 30 * 60 * 1000;

function parseTimestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isBlackBoxRowReadCoolingDown(row: BlackBoxRow, nowMs: number): boolean {
  if (row.is_read !== true) return false;
  const anchorMs = parseTimestampMs(row.updated_at) ?? parseTimestampMs(row.created_at);
  if (anchorMs === null) return false;
  return anchorMs > nowMs - GATE_READ_REAPPEAR_COOLDOWN_MS;
}

function isBlackBoxRowGateEligible(row: BlackBoxRow, todayIsoDate: string, nowMs: number): boolean {
  if (typeof row.date === 'string' && row.date >= todayIsoDate) return false;
  const snoozeDate = typeof row.snooze_until === 'string' ? row.snooze_until.slice(0, 10) : null;
  if (snoozeDate && snoozeDate > todayIsoDate) return false;
  return !isBlackBoxRowReadCoolingDown(row, nowMs);
}

function normalizeBlackBoxGateWave(input: {
  pendingBlackBoxCount: number;
  unreadBlackBoxCount: number;
  blackBoxPreviewRows: BlackBoxRow[];
  todayIsoDate: string;
  nowIso: string;
}): {
  pendingBlackBoxCount: number;
  unreadBlackBoxCount: number;
  blackBoxPreviewRows: BlackBoxRow[];
} {
  const nowMs = parseTimestampMs(input.nowIso);
  if (nowMs === null) {
    return {
      pendingBlackBoxCount: input.pendingBlackBoxCount,
      unreadBlackBoxCount: input.unreadBlackBoxCount,
      blackBoxPreviewRows: input.blackBoxPreviewRows,
    };
  }

  const eligibleRows = input.blackBoxPreviewRows.filter(row => (
    isBlackBoxRowGateEligible(row, input.todayIsoDate, nowMs)
  ));
  const hiddenCooldownCount = input.blackBoxPreviewRows.filter(row => (
    isBlackBoxRowReadCoolingDown(row, nowMs)
  )).length;
  const previewCoversPending = input.blackBoxPreviewRows.length >= input.pendingBlackBoxCount;
  const pendingBlackBoxCount = previewCoversPending
    ? eligibleRows.length
    : Math.max(0, input.pendingBlackBoxCount - hiddenCooldownCount);
  const unreadBlackBoxCount = previewCoversPending
    ? eligibleRows.filter(row => row.is_read !== true).length
    : Math.min(input.unreadBlackBoxCount, pendingBlackBoxCount);

  return {
    pendingBlackBoxCount,
    unreadBlackBoxCount,
    blackBoxPreviewRows: eligibleRows,
  };
}

async function loadWidgetDeviceByTokenHash(
  client: ReturnType<typeof createServiceRoleClient>,
  tokenHash: string,
): Promise<WidgetDeviceRow | null> {
  const { data, error } = await client
    .from('widget_devices')
    .select(WIDGET_DEVICE_SELECT)
    .eq('token_hash', tokenHash)
    .maybeSingle();

  if (error) {
    throw new Error(`load widget device by token hash failed: ${error.message}`);
  }

  return (data as WidgetDeviceRow | null) ?? null;
}

async function loadWidgetDeviceById(
  client: ReturnType<typeof createServiceRoleClient>,
  deviceId: string,
): Promise<WidgetDeviceRow | null> {
  const { data, error } = await client
    .from('widget_devices')
    .select(WIDGET_DEVICE_SELECT)
    .eq('id', deviceId)
    .maybeSingle();

  if (error) {
    throw new Error(`load widget device by id failed: ${error.message}`);
  }

  return (data as WidgetDeviceRow | null) ?? null;
}

function isUuidLike(value: string | null | undefined): value is string {
  return typeof value === 'string' && UUID_LIKE_PATTERN.test(value);
}

function normalizeOptionalText(value: unknown, maxLength = 256): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : null;
}

function encodeRouteSegment(value: string): string {
  return encodeURIComponent(value);
}

function buildProjectEntryUrl(projectId: string): string {
  return `./#/projects/${encodeRouteSegment(projectId)}?${ENTRY_QUERY}`;
}

function buildTaskEntryUrl(projectId: string, taskId: string): string {
  return `./#/projects/${encodeRouteSegment(projectId)}/task/${encodeRouteSegment(taskId)}?${ENTRY_QUERY}`;
}

function buildEntryUrlFromContext(input: {
  forceWorkspaceFallback: boolean;
  focusValid: boolean;
  focusTaskId: string | null;
  focusProjectId: string | null;
  dockItems: Array<{ taskId: string | null; projectId: string | null; valid: boolean }>;
}): string {
  if (input.forceWorkspaceFallback) {
    return ENTRY_URL;
  }

  if (input.focusValid && input.focusProjectId && input.focusTaskId) {
    return buildTaskEntryUrl(input.focusProjectId, input.focusTaskId);
  }

  if (input.focusValid && input.focusProjectId) {
    return buildProjectEntryUrl(input.focusProjectId);
  }

  const dockTask = input.dockItems.find(item => item.valid && item.projectId && item.taskId);
  if (dockTask?.projectId && dockTask.taskId) {
    return buildTaskEntryUrl(dockTask.projectId, dockTask.taskId);
  }

  const dockProject = input.dockItems.find(item => item.valid && item.projectId);
  if (dockProject?.projectId) {
    return buildProjectEntryUrl(dockProject.projectId);
  }

  return ENTRY_URL;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toSlotList(value: unknown): FocusTaskSlotLike[] {
  if (!Array.isArray(value)) return [];

  return value
    .filter(isPlainObject)
    .map(item => ({
      taskId: typeof item.taskId === 'string' ? item.taskId : null,
      sourceProjectId: typeof item.sourceProjectId === 'string' ? item.sourceProjectId : null,
      inlineTitle: typeof item.inlineTitle === 'string' && item.inlineTitle.trim().length > 0
        ? item.inlineTitle.trim()
        : null,
      estimatedMinutes: typeof item.estimatedMinutes === 'number' && Number.isFinite(item.estimatedMinutes)
        ? item.estimatedMinutes
        : null,
      waitMinutes: typeof item.waitMinutes === 'number' && Number.isFinite(item.waitMinutes)
        ? item.waitMinutes
        : null,
      waitStartedAt: typeof item.waitStartedAt === 'string' ? normalizeIsoTimestamp(item.waitStartedAt) : null,
      waitEndAt: typeof item.waitEndAt === 'string' ? normalizeIsoTimestamp(item.waitEndAt) : null,
      focusStatus: typeof item.focusStatus === 'string' ? item.focusStatus : undefined,
      isMaster: item.isMaster === true || item.isMain === true,
      isMain: item.isMain === true,
    }));
}

function isMasterSlot(slot: FocusTaskSlotLike | null | undefined): boolean {
  return slot?.isMaster === true || slot?.isMain === true;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function toDockEntryList(value: unknown): DockEntryLike[] {
  if (!Array.isArray(value)) return [];

  return value
    .filter(isPlainObject)
    .map(item => ({
      taskId: typeof item.taskId === 'string' ? item.taskId : null,
      title: typeof item.title === 'string' && item.title.trim().length > 0 ? item.title.trim() : null,
      sourceProjectId: typeof item.sourceProjectId === 'string' ? item.sourceProjectId : null,
      expectedMinutes: typeof item.expectedMinutes === 'number' && Number.isFinite(item.expectedMinutes)
        ? item.expectedMinutes
        : null,
      waitMinutes: typeof item.waitMinutes === 'number' && Number.isFinite(item.waitMinutes)
        ? item.waitMinutes
        : null,
      waitStartedAt: typeof item.waitStartedAt === 'string' ? normalizeIsoTimestamp(item.waitStartedAt) : null,
      waitEndAt: typeof item.waitEndAt === 'string' ? normalizeIsoTimestamp(item.waitEndAt) : null,
      status: typeof item.status === 'string' ? item.status : undefined,
      isMain: item.isMain === true,
      lane: typeof item.lane === 'string' ? item.lane : undefined,
      sourceKind: typeof item.sourceKind === 'string' ? item.sourceKind : undefined,
      dockedOrder: typeof item.dockedOrder === 'number' && Number.isFinite(item.dockedOrder)
        ? item.dockedOrder
        : undefined,
      manualOrder: typeof item.manualOrder === 'number' && Number.isFinite(item.manualOrder)
        ? item.manualOrder
        : null,
    }));
}

function mapDockEntryToFocusSlot(entry: DockEntryLike, forceMaster = false): FocusTaskSlotLike {
  const isMaster = forceMaster || entry.isMain === true;
  return {
    taskId: entry.taskId ?? null,
    sourceProjectId: entry.sourceProjectId ?? null,
    inlineTitle: entry.sourceKind === 'dock-created' ? entry.title ?? null : entry.title ?? null,
    estimatedMinutes: entry.expectedMinutes ?? null,
    waitMinutes: entry.waitMinutes ?? null,
    waitStartedAt: entry.waitStartedAt ?? null,
    waitEndAt: entry.waitEndAt ?? (
      entry.waitStartedAt && entry.waitMinutes
        ? new Date(new Date(entry.waitStartedAt).getTime() + entry.waitMinutes * 60_000).toISOString()
        : null
    ),
    focusStatus: entry.status,
    isMaster,
    isMain: isMaster,
  };
}

function applyMainTaskHint(slots: FocusTaskSlotLike[], mainTaskId: string | null): FocusTaskSlotLike[] {
  if (!mainTaskId) return slots;
  return slots.map(slot => {
    if (slot.taskId === mainTaskId) {
      return { ...slot, isMaster: true, isMain: true };
    }
    if (isMasterSlot(slot)) {
      return { ...slot, isMaster: false, isMain: false };
    }
    return slot;
  });
}

function isCommandCenterEntry(entry: DockEntryLike): boolean {
  return entry.isMain === true
    || entry.status === 'focusing'
    || entry.lane === 'combo-select';
}

function toLegacyFocusStateFromDockSnapshot(snapshot: DockSnapshotLike): FocusSessionStateLike {
  const session = isPlainObject(snapshot.session) ? snapshot.session : {};
  const entries = toDockEntryList(snapshot.entries);
  const entryMap = new Map<string, DockEntryLike>();

  for (const entry of entries) {
    if (entry.taskId) {
      entryMap.set(entry.taskId, entry);
    }
  }

  const explicitMainEntry = entries.find(entry => entry.isMain === true && entry.status !== 'completed') ?? null;
  const sessionMainTaskId = typeof session.mainTaskId === 'string' ? session.mainTaskId : null;
  const mainTaskId = explicitMainEntry?.taskId ?? sessionMainTaskId;
  const comboSelectIds = toStringArray(session.comboSelectIds);
  const backupIds = toStringArray(session.backupIds);

  const commandCenterTasks = explicitMainEntry
    ? [mapDockEntryToFocusSlot(explicitMainEntry, true)]
    : (
        mainTaskId && entryMap.has(mainTaskId)
          ? [mapDockEntryToFocusSlot(entryMap.get(mainTaskId)!, true)]
          : entries.filter(entry => entry.isMain === true).slice(0, 1).map(entry => mapDockEntryToFocusSlot(entry))
      );

  const comboSelectTasks = comboSelectIds.length > 0
    ? comboSelectIds
        .filter(taskId => taskId !== mainTaskId)
        .map(taskId => entryMap.get(taskId))
        .filter((entry): entry is DockEntryLike => !!entry && entry.isMain !== true)
      .map(entry => mapDockEntryToFocusSlot(entry))
    : entries
        .filter(entry => entry.taskId !== mainTaskId && entry.isMain !== true && entry.lane === 'combo-select')
      .map(entry => mapDockEntryToFocusSlot(entry));

  const backupTasks = backupIds.length > 0
    ? backupIds
        .filter(taskId => taskId !== mainTaskId)
        .map(taskId => entryMap.get(taskId))
        .filter((entry): entry is DockEntryLike => !!entry && entry.isMain !== true)
      .map(entry => mapDockEntryToFocusSlot(entry))
    : entries
        .filter(entry => entry.taskId !== mainTaskId && entry.isMain !== true && entry.lane === 'backup')
      .map(entry => mapDockEntryToFocusSlot(entry));

  return {
    // 权威判定：只信任 focusMode 布尔值。
    // session.focusSessionId 在 exitFocusMode() 中不会被清除（作为历史轨迹保留），
    // 若以此作为 fallback 会导致"关闭专注后 widget 仍显示 focus active"。
    isActive: snapshot.focusMode === true,
    commandCenterOrderIds: entries
      .filter(isCommandCenterEntry)
      .sort((left, right) => {
        if (left.status === 'focusing' && right.status !== 'focusing') return -1;
        if (right.status === 'focusing' && left.status !== 'focusing') return 1;
        const leftOrder = left.manualOrder ?? left.dockedOrder ?? Number.MAX_SAFE_INTEGER;
        const rightOrder = right.manualOrder ?? right.dockedOrder ?? Number.MAX_SAFE_INTEGER;
        if (leftOrder !== rightOrder) return leftOrder - rightOrder;
        return (left.taskId ?? '').localeCompare(right.taskId ?? '');
      })
      .map(entry => entry.taskId)
      .filter((taskId): taskId is string => typeof taskId === 'string' && taskId.length > 0)
      .slice(0, 4),
    commandCenterTasks,
    comboSelectTasks,
    backupTasks,
  };
}

function toFocusSessionState(value: unknown): FocusSessionStateLike {
  if (!isPlainObject(value)) {
    return {};
  }

  const dockSnapshot = value as DockSnapshotLike;
  if (dockSnapshot.focusSessionState && isPlainObject(dockSnapshot.focusSessionState)) {
    const state = toFocusSessionState(dockSnapshot.focusSessionState);
    const entryDerivedState = toLegacyFocusStateFromDockSnapshot(dockSnapshot);
    const commandCenterOrderIds = (state.commandCenterOrderIds?.length ?? 0) > 0
      ? state.commandCenterOrderIds
      : entryDerivedState.commandCenterOrderIds;

    const commandCenterTasks: FocusTaskSlotLike[] =
      (state.commandCenterTasks?.length ?? 0) > 0
        ? (state.commandCenterTasks ?? [])
        : (entryDerivedState.commandCenterTasks ?? []);
    const comboSelectTasks: FocusTaskSlotLike[] =
      (state.comboSelectTasks?.length ?? 0) > 0
        ? (state.comboSelectTasks ?? [])
        : (entryDerivedState.comboSelectTasks ?? []);
    const backupTasks: FocusTaskSlotLike[] =
      (state.backupTasks?.length ?? 0) > 0
        ? (state.backupTasks ?? [])
        : (entryDerivedState.backupTasks ?? []);
    const derivedMainSlot = entryDerivedState.commandCenterTasks?.find(isMasterSlot) ?? null;
    const hintedMainTaskId = derivedMainSlot?.taskId ?? null;
    const hasMainSlot = hintedMainTaskId
      ? [...commandCenterTasks, ...comboSelectTasks, ...backupTasks].some(slot => slot.taskId === hintedMainTaskId)
      : true;
    const commandCenterTasksWithMain = !hasMainSlot && derivedMainSlot
      ? [derivedMainSlot, ...commandCenterTasks]
      : commandCenterTasks;

    return {
      ...state,
      isActive: dockSnapshot.focusMode === true || state.isActive === true,
      commandCenterOrderIds,
      commandCenterTasks: applyMainTaskHint(commandCenterTasksWithMain, hintedMainTaskId),
      comboSelectTasks: applyMainTaskHint(comboSelectTasks, hintedMainTaskId),
      backupTasks: applyMainTaskHint(backupTasks, hintedMainTaskId),
    };
  }

  if (typeof dockSnapshot.version === 'number' && dockSnapshot.version >= 2 && dockSnapshot.version <= 7) {
    return toLegacyFocusStateFromDockSnapshot(dockSnapshot);
  }

  return {
    isActive: value.isActive === true,
    commandCenterOrderIds: toStringArray(value.commandCenterOrderIds),
    commandCenterTasks: toSlotList(value.commandCenterTasks),
    comboSelectTasks: toSlotList(value.comboSelectTasks),
    backupTasks: toSlotList(value.backupTasks),
  };
}

function resolveCommandCenterSlots(state: FocusSessionStateLike): FocusTaskSlotLike[] {
  const allSlots = [
    ...(state.commandCenterTasks ?? []),
    ...(state.comboSelectTasks ?? []),
    ...(state.backupTasks ?? []),
  ];
  const slotByTaskId = new Map<string, FocusTaskSlotLike>();
  for (const slot of allSlots) {
    if (typeof slot.taskId === 'string' && slot.taskId.length > 0 && !slotByTaskId.has(slot.taskId)) {
      slotByTaskId.set(slot.taskId, slot);
    }
  }

  const orderedFromState = toStringArray(state.commandCenterOrderIds)
    .map(taskId => slotByTaskId.get(taskId))
    .filter((slot): slot is FocusTaskSlotLike => isRenderableFocusSlot(slot));
  const commandCenter = (state.commandCenterTasks ?? []).filter(isRenderableFocusSlot);
  const comboSelect = (state.comboSelectTasks ?? []).filter(isRenderableFocusSlot);
  const fallbackOrdered: FocusTaskSlotLike[] = [];
  const focusingSlot = [
    ...commandCenter,
    ...comboSelect,
  ].find(slot => slot.focusStatus === 'focusing') ?? null;
  const masterSlot = [
    ...commandCenter,
    ...comboSelect,
  ].find(isMasterSlot) ?? null;

  if (focusingSlot) {
    fallbackOrdered.push(focusingSlot);
  }
  if (masterSlot && !fallbackOrdered.includes(masterSlot)) {
    fallbackOrdered.push(masterSlot);
  }
  for (const slot of comboSelect) {
    if (!fallbackOrdered.includes(slot)) {
      fallbackOrdered.push(slot);
    }
  }
  for (const slot of commandCenter) {
    if (!fallbackOrdered.includes(slot)) {
      fallbackOrdered.push(slot);
    }
  }
  if (orderedFromState.length > 0) {
    const masterTaskId = masterSlot?.taskId ?? null;
    const focusingTaskId = focusingSlot?.taskId ?? null;
    const hasMasterSlot = !masterTaskId || orderedFromState.some(slot => slot.taskId === masterTaskId);
    const hasFocusingSlot = !focusingTaskId || orderedFromState.some(slot => slot.taskId === focusingTaskId);
    if (hasMasterSlot && hasFocusingSlot) {
      return orderedFromState.slice(0, 4);
    }

    const orderedWithPriority = [...fallbackOrdered];
    const seenSlotKeys = new Set(orderedWithPriority.map(slot => `${slot.taskId ?? ''}::${slot.inlineTitle ?? ''}`));
    for (const slot of orderedFromState) {
      const slotKey = `${slot.taskId ?? ''}::${slot.inlineTitle ?? ''}`;
      if (!seenSlotKeys.has(slotKey)) {
        orderedWithPriority.push(slot);
        seenSlotKeys.add(slotKey);
      }
    }
    return orderedWithPriority.slice(0, 4);
  }
  return fallbackOrdered.slice(0, 4);
}

function pickPrimaryFocusSlot(state: FocusSessionStateLike): FocusTaskSlotLike | null {
  return resolveCommandCenterSlots(state)[0]
    ?? null;
}

function isRenderableFocusSlot(slot: FocusTaskSlotLike | null | undefined): slot is FocusTaskSlotLike {
  if (!slot) {
    return false;
  }

  return typeof slot.taskId === 'string' && slot.taskId.length > 0
    || typeof slot.inlineTitle === 'string' && slot.inlineTitle.trim().length > 0;
}

function resolveWaitEndAt(slot: FocusTaskSlotLike): string | null {
  const explicit = normalizeIsoTimestamp(slot.waitEndAt ?? null);
  if (explicit) return explicit;
  const startedAt = normalizeIsoTimestamp(slot.waitStartedAt ?? null);
  if (!startedAt || typeof slot.waitMinutes !== 'number' || !Number.isFinite(slot.waitMinutes) || slot.waitMinutes <= 0) {
    return null;
  }
  return new Date(new Date(startedAt).getTime() + Math.floor(slot.waitMinutes) * 60_000).toISOString();
}

function isWaitExpiredSlot(slot: FocusTaskSlotLike, nowMs = Date.now()): boolean {
  if (slot.focusStatus === 'wait-ended' || slot.focusStatus === 'wait_finished') return true;
  const waitEndAt = resolveWaitEndAt(slot);
  return waitEndAt !== null && new Date(waitEndAt).getTime() <= nowMs;
}

function uniqueIds(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0))];
}

function normalizeIsoTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function maxIsoTimestamp(values: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;

  for (const candidate of values) {
    const normalized = normalizeIsoTimestamp(candidate);
    if (!normalized) continue;

    const candidateMs = Date.parse(normalized);
    if (candidateMs > bestMs) {
      best = normalized;
      bestMs = candidateMs;
    }
  }

  return best;
}

async function readSummaryRequest(req: Request): Promise<WidgetSummaryRequest> {
  const text = await req.text();
  if (text.trim().length === 0) {
    return {};
  }

  const parsed = JSON.parse(text) as unknown;
  if (!isPlainObject(parsed)) {
    throw new Error('INVALID_JSON');
  }

  return {
    clientSchemaVersion: typeof parsed.clientSchemaVersion === 'number' && Number.isFinite(parsed.clientSchemaVersion)
      ? Math.trunc(parsed.clientSchemaVersion)
      : undefined,
    clientVersion: normalizeOptionalText(parsed.clientVersion, 256) ?? undefined,
    supportsPush: typeof parsed.supportsPush === 'boolean' ? parsed.supportsPush : undefined,
    lastKnownSummaryVersion: typeof parsed.lastKnownSummaryVersion === 'string' && parsed.lastKnownSummaryVersion.trim().length > 0
      ? parsed.lastKnownSummaryVersion.trim()
      : undefined,
    instanceId: typeof parsed.instanceId === 'string' && parsed.instanceId.trim().length > 0
      ? parsed.instanceId.trim()
      : undefined,
    hostInstanceId: normalizeOptionalText(parsed.hostInstanceId, 128) ?? undefined,
    platform: typeof parsed.platform === 'string' && parsed.platform.trim().length > 0
      ? normalizeWidgetPlatform(parsed.platform.trim()) ?? undefined
      : undefined,
  };
}

function buildSummaryEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: SUMMARY_SCHEMA_VERSION,
    summaryVersion: 'none|empty',
    cloudUpdatedAt: null,
    freshnessState: 'stale' as WidgetFreshnessState,
    trustState: 'untrusted' as WidgetTrustState,
    sourceState: 'cache-only' as WidgetSourceState,
    consistencyState: 'unavailable',
    degradedReasons: [] as string[],
    schemaMinClient: SUMMARY_SCHEMA_VERSION,
    schemaMaxClient: SUMMARY_SCHEMA_VERSION,
    entryUrl: ENTRY_URL,
    focus: {
      active: false,
      taskId: null,
      projectId: null,
      projectTitle: null,
      title: null,
      remainingMinutes: null,
      isMaster: false,
      valid: false,
    },
    dock: {
      count: 0,
      countFromTasks: 0,
      items: [],
    },
    commandCenter: {
      slots: [],
      mainTaskId: null,
      focusedTaskId: null,
      backupCount: 0,
    },
    blackBox: {
      pendingCount: 0,
      unreadCount: 0,
      nextReviewAt: null,
      previews: [],
      gatePreview: {
        entryId: null,
        projectId: null,
        projectTitle: null,
        content: null,
        createdAt: null,
        valid: false,
      },
    },
    warnings: [] as string[],
    ...overrides,
  };
}

function summaryResponse(
  responseHeaders: Record<string, string>,
  status: number,
  overrides: Record<string, unknown>,
): Response {
  if (status >= 400) {
    const code = typeof overrides.code === 'string' ? overrides.code : null;
    // 仅发射一次 failure 事件，schema_mismatch / killswitch_applied 之类上游已显式发射的
    // 特殊事件通过 code 去重即可；此处补的是通用失败遥测，避免每个 400+ 分支手工插。
    if (code !== 'SCHEMA_MISMATCH' && code !== 'WIDGET_REFRESH_DISABLED') {
      const reasons = Array.isArray(overrides.degradedReasons)
        ? (overrides.degradedReasons as string[])
        : null;
      logWidgetEvent('widget_summary_fetch_failure', {
        code,
        status,
        degradedReasons: reasons,
      });
    }
  }
  return jsonResponse(buildSummaryEnvelope(overrides), responseHeaders, status);
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get('Origin');
  const corsHeaders = getCorsHeaders(origin, 'POST, OPTIONS');
  const responseHeaders = withPrivateNoStoreHeaders(corsHeaders);

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: responseHeaders });
  }

  if (req.method !== 'POST') {
    return summaryResponse(responseHeaders, 405, {
      error: 'Method not allowed',
      code: 'METHOD_NOT_ALLOWED',
      degradedReasons: ['method-not-allowed'],
      warnings: ['open-app-to-finish-setup'],
    });
  }

  let body: WidgetSummaryRequest;
  try {
    body = await readSummaryRequest(req);
  } catch {
    return summaryResponse(responseHeaders, 400, {
      error: 'Invalid JSON body',
      code: 'INVALID_JSON',
      degradedReasons: ['invalid-json'],
      warnings: ['open-app-to-finish-setup'],
    });
  }

  if (body.clientSchemaVersion !== undefined && body.clientSchemaVersion !== SUMMARY_SCHEMA_VERSION) {
    logWidgetEvent('widget_summary_schema_mismatch', {
      platform: body.platform ?? null,
      instanceId: body.instanceId ?? null,
      schemaVersion: body.clientSchemaVersion,
      code: 'SCHEMA_MISMATCH',
      status: 409,
    });
    logWidgetEvent('widget_summary_fetch_failure', {
      platform: body.platform ?? null,
      instanceId: body.instanceId ?? null,
      code: 'SCHEMA_MISMATCH',
      status: 409,
    });
    return summaryResponse(responseHeaders, 409, {
      error: 'Widget summary schema is incompatible with this client',
      code: 'SCHEMA_MISMATCH',
      degradedReasons: ['schema-mismatch'],
      warnings: ['open-app-to-finish-setup'],
    });
  }

  if (!body.instanceId || !body.hostInstanceId || !body.platform) {
    return summaryResponse(responseHeaders, 400, {
      error: 'instanceId, hostInstanceId, and platform are required',
      code: 'INSTANCE_CONTEXT_REQUIRED',
      degradedReasons: ['instance-context-required'],
      warnings: ['open-app-to-finish-setup'],
    });
  }

  if (!isUuidLike(body.instanceId)) {
    return summaryResponse(responseHeaders, 400, {
      error: 'instanceId must be a UUID',
      code: 'INSTANCE_CONTEXT_INVALID',
      degradedReasons: ['instance-context-invalid'],
      warnings: ['open-app-to-finish-setup'],
    });
  }

  const client = createServiceRoleClient();
  const capabilities = await loadWidgetCapabilities(client);
  const baseCapabilities = toPublicWidgetCapabilities(capabilities);

  const limits = await loadWidgetLimits(client);
  const preAuthIpScopeKey = await sha256Hex(`widget-summary-ip:${getClientIp(req)}`);
  const preAuthIpRate = await consumeWidgetRateLimit(
    client,
    'ip',
    preAuthIpScopeKey,
    limits.summaryIpPerMinute,
    limits.blockSeconds,
  );

  if (!preAuthIpRate.allowed) {
    return summaryResponse(responseHeaders, 429, {
      error: 'Widget summary is rate limited',
      code: 'RATE_LIMITED',
      retryAfterSeconds: preAuthIpRate.retryAfterSeconds,
      trustState: 'provisional' as WidgetTrustState,
      degradedReasons: ['rate-limited'],
      capabilities: baseCapabilities,
      warnings: ['open-app-to-finish-setup'],
    });
  }

  const token = getBearerToken(req);
  if (!token) {
    return summaryResponse(responseHeaders, 401, {
      error: 'Widget token is required',
      code: 'WIDGET_TOKEN_REQUIRED',
      trustState: 'auth-required' as WidgetTrustState,
      degradedReasons: ['invalid-token'],
      capabilities: baseCapabilities,
      warnings: ['open-app-to-finish-setup'],
    });
  }

  const tokenHash = await sha256Hex(token);
  let parsedToken: ReturnType<typeof parseWidgetToken> = null;
  let device: WidgetDeviceRow | null = null;

  try {
    device = await loadWidgetDeviceByTokenHash(client, tokenHash);
  } catch (error) {
    console.error('[WidgetSummary] load device by token hash failed', {
      tokenHash: redactId(tokenHash),
      message: error instanceof Error ? error.message : 'unknown',
    });
    return summaryResponse(responseHeaders, 500, {
      error: 'Failed to load widget binding',
      code: 'DEVICE_LOOKUP_FAILED',
      degradedReasons: ['device-lookup-failed'],
      capabilities: baseCapabilities,
      warnings: ['open-app-to-finish-setup'],
    });
  }

  if (!device) {
    parsedToken = parseWidgetToken(token);
    if (!parsedToken) {
      return summaryResponse(responseHeaders, 401, {
        error: 'Widget token is required',
        code: 'WIDGET_TOKEN_REQUIRED',
        trustState: 'auth-required' as WidgetTrustState,
        degradedReasons: ['invalid-token'],
        capabilities: baseCapabilities,
        warnings: ['open-app-to-finish-setup'],
      });
    }

    try {
      device = await loadWidgetDeviceById(client, parsedToken.deviceId);
    } catch (error) {
      console.error('[WidgetSummary] load legacy device failed', {
        deviceId: redactId(parsedToken.deviceId),
        message: error instanceof Error ? error.message : 'unknown',
      });
      return summaryResponse(responseHeaders, 500, {
        error: 'Failed to load widget binding',
        code: 'DEVICE_LOOKUP_FAILED',
        degradedReasons: ['device-lookup-failed'],
        capabilities: baseCapabilities,
        warnings: ['open-app-to-finish-setup'],
      });
    }
  }

  if (!device) {
    return summaryResponse(responseHeaders, 401, {
      error: 'Widget binding not found',
      code: 'DEVICE_NOT_FOUND',
      trustState: 'auth-required' as WidgetTrustState,
      degradedReasons: ['device-missing'],
      capabilities: baseCapabilities,
      warnings: ['open-app-to-finish-setup'],
    });
  }

  if (device.revoked_at) {
    return summaryResponse(responseHeaders, 401, {
      error: 'Widget binding has been revoked',
      code: 'DEVICE_REVOKED',
      trustState: 'auth-required' as WidgetTrustState,
      degradedReasons: ['token-revoked'],
      capabilities: baseCapabilities,
      warnings: ['open-app-to-finish-setup'],
    });
  }

  const pushTokenMissing = typeof device.push_token !== 'string' || device.push_token.trim().length === 0;

  if (parsedToken && device.token_hash) {
    return summaryResponse(responseHeaders, 401, {
      error: 'Widget token is invalid',
      code: 'TOKEN_INVALID',
      trustState: 'auth-required' as WidgetTrustState,
      degradedReasons: ['token-mismatch'],
      capabilities: baseCapabilities,
      warnings: ['open-app-to-finish-setup'],
    });
  }

  if (parsedToken && device.binding_generation !== parsedToken.bindingGeneration) {
    return summaryResponse(responseHeaders, 401, {
      error: 'Widget binding generation mismatch',
      code: 'BINDING_MISMATCH',
      trustState: 'auth-required' as WidgetTrustState,
      degradedReasons: ['binding-mismatch'],
      capabilities: baseCapabilities,
      warnings: ['open-app-to-finish-setup'],
    });
  }

  if (new Date(device.expires_at).getTime() <= Date.now()) {
    return summaryResponse(responseHeaders, 401, {
      error: 'Widget token has expired',
      code: 'TOKEN_EXPIRED',
      trustState: 'auth-required' as WidgetTrustState,
      degradedReasons: ['token-expired'],
      capabilities: baseCapabilities,
      warnings: ['open-app-to-finish-setup'],
    });
  }

  if (parsedToken) {
    const secretHash = await sha256Hex(parsedToken.secret);
    if (secretHash !== device.secret_hash) {
      return summaryResponse(responseHeaders, 401, {
        error: 'Widget token is invalid',
        code: 'TOKEN_INVALID',
        trustState: 'auth-required' as WidgetTrustState,
        degradedReasons: ['token-mismatch'],
        capabilities: baseCapabilities,
        warnings: ['open-app-to-finish-setup'],
      });
    }
  }

  for (const [scopeType, scopeKeySeed, maxCalls] of [
    ['device', `widget-summary-device:${device.id}`, limits.summaryDevicePerMinute],
    ['user', `widget-summary-user:${device.user_id}`, limits.summaryUserPerMinute],
  ] as const) {
    const scopeKey = await sha256Hex(scopeKeySeed);
    const rate = await consumeWidgetRateLimit(client, scopeType, scopeKey, maxCalls, limits.blockSeconds);
    if (!rate.allowed) {
      return summaryResponse(responseHeaders, 429, {
        error: 'Widget summary is rate limited',
        code: 'RATE_LIMITED',
        retryAfterSeconds: rate.retryAfterSeconds,
        trustState: 'provisional' as WidgetTrustState,
        degradedReasons: ['rate-limited'],
        capabilities: baseCapabilities,
        warnings: ['open-app-to-finish-setup'],
      });
    }
  }

  const { data: instanceData, error: instanceError } = await client
    .from('widget_instances')
    .select('id,binding_generation,uninstalled_at')
    .eq('id', body.instanceId)
    .eq('host_instance_id', body.hostInstanceId)
    .eq('device_id', device.id)
    .eq('user_id', device.user_id)
    .eq('platform', body.platform)
    .maybeSingle();

  if (instanceError) {
    return summaryResponse(responseHeaders, 500, {
      error: 'Failed to validate widget instance',
      code: 'INSTANCE_LOOKUP_FAILED',
      degradedReasons: ['instance-lookup-failed'],
      capabilities: baseCapabilities,
      warnings: ['open-app-to-finish-setup'],
    });
  }

  const instance = instanceData as WidgetInstanceRow | null;
  if (!instance || instance.uninstalled_at) {
    return summaryResponse(responseHeaders, 401, {
      error: 'Widget instance is not active',
      code: 'INSTANCE_NOT_ACTIVE',
      trustState: 'auth-required' as WidgetTrustState,
      degradedReasons: ['instance-not-active'],
      capabilities: baseCapabilities,
      warnings: ['open-app-to-finish-setup'],
    });
  }

  if (instance.binding_generation !== device.binding_generation) {
    return summaryResponse(responseHeaders, 401, {
      error: 'Widget instance binding is out of date',
      code: 'INSTANCE_BINDING_MISMATCH',
      trustState: 'auth-required' as WidgetTrustState,
      degradedReasons: ['instance-binding-mismatch'],
      capabilities: baseCapabilities,
      warnings: ['open-app-to-finish-setup'],
    });
  }

  const nowIso = new Date().toISOString();
  const todayIsoDate = nowIso.slice(0, 10);
  const nextDeviceCapabilities = mergeJsonObjects(
    device.capabilities as Parameters<typeof mergeJsonObjects>[0],
    buildWidgetClientCapabilitiesPatch({
      platform: body.platform,
      clientVersion: body.clientVersion,
      supportsPush: body.supportsPush,
      observedAt: nowIso,
    }) as Parameters<typeof mergeJsonObjects>[1],
  );
  const capabilityDecision = evaluateWidgetCapabilities(capabilities, {
    platform: body.platform,
    installationId: device.installation_id,
    deviceId: device.id,
    clientVersion: body.clientVersion ?? extractWidgetClientVersion(nextDeviceCapabilities),
  });
  const clientSupportsPush = body.supportsPush
    ?? extractWidgetPushSupport(nextDeviceCapabilities)
    ?? false;
  const shouldRepairPushToken = capabilityDecision.pushAllowed && clientSupportsPush && pushTokenMissing;
  const publicCapabilities = toPublicWidgetCapabilities(capabilityDecision);
  if (!capabilityDecision.widgetEnabled || !capabilityDecision.refreshAllowed) {
    const { error: disabledTouchError } = await client
      .from('widget_devices')
      .update({
        last_seen_at: nowIso,
        updated_at: nowIso,
        capabilities: nextDeviceCapabilities,
      })
      .eq('id', device.id);

    if (disabledTouchError) {
      console.warn('[WidgetSummary] failed to persist disabled client context', {
        deviceId: redactId(device.id),
        message: disabledTouchError.message,
      });
    }

    logWidgetEvent('widget_killswitch_applied', {
      userId: device.user_id,
      deviceId: device.id,
      instanceId: body.instanceId ?? null,
      platform: body.platform ?? null,
      code: 'WIDGET_REFRESH_DISABLED',
      reason: capabilityDecision.reason ?? 'refresh-disabled',
      status: 503,
      extra: {
        clientVersion: capabilityDecision.clientVersion,
        matchedRuleIds: capabilityDecision.matchedRuleIds.join(','),
        rolloutBucket: capabilityDecision.rolloutBucket,
      },
    });
    logWidgetEvent('widget_summary_fetch_failure', {
      userId: device.user_id,
      deviceId: device.id,
      instanceId: body.instanceId ?? null,
      platform: body.platform ?? null,
      code: 'WIDGET_REFRESH_DISABLED',
      status: 503,
    });
    return summaryResponse(responseHeaders, 503, {
      error: 'Widget refresh is disabled',
      code: 'WIDGET_REFRESH_DISABLED',
      degradedReasons: ['refresh-disabled'],
      capabilities: publicCapabilities,
      warnings: ['open-app-to-finish-setup'],
    });
  }

  // 2026-04-22 颠覆性压缩：Wave 1（focus_sessions/projects/black_box count/preview + dock count/watermark）
  // 合并到单个 PL/pgSQL RPC（widget_summary_wave1），把 4-5 个 PostgREST HTTP roundtrip
  // 压成 1 个。观测的 4-5s widget-summary 延迟中 1.5-2s 花在 PostgREST 请求排队 + JSON 解析上。
  const wave1RpcResult = await client.rpc('widget_summary_wave1', {
    p_user_id: device.user_id,
    p_today: todayIsoDate,
    p_preview_limit: MAX_BLACK_BOX_PREVIEW_COUNT,
  });

  if (wave1RpcResult.error) {
    console.error('[WidgetSummary] widget_summary_wave1 rpc failed', {
      userId: redactId(device.user_id),
      message: wave1RpcResult.error.message,
    });
    return summaryResponse(responseHeaders, 500, {
      error: 'Failed to load widget summary',
      code: 'SUMMARY_LOAD_FAILED',
      degradedReasons: ['summary-load-failed'],
      capabilities: publicCapabilities,
      warnings: ['open-app-to-finish-setup'],
    });
  }

  interface Wave1Payload {
    focusSession: FocusSessionRow | null;
    accessibleProjectIds: string[];
    pendingBlackBoxCount: number;
    unreadBlackBoxCount: number;
    nextGateReviewAt: string | null;
    blackBoxPreview: BlackBoxRow[];
    blackBoxWatermark: string | null;
    dockCount: number;
    dockWatermark: string | null;
  }
  const wave1 = (wave1RpcResult.data ?? {}) as Partial<Wave1Payload>;
  const latestSession: FocusSessionRow | null = wave1.focusSession ?? null;
  const accessibleProjectIds: string[] = Array.isArray(wave1.accessibleProjectIds) ? wave1.accessibleProjectIds : [];
  const rawPendingBlackBoxCount = typeof wave1.pendingBlackBoxCount === 'number' ? wave1.pendingBlackBoxCount : 0;
  const rawUnreadBlackBoxCount = typeof wave1.unreadBlackBoxCount === 'number' ? wave1.unreadBlackBoxCount : rawPendingBlackBoxCount;
  const nextGateReviewAt = normalizeIsoTimestamp(wave1.nextGateReviewAt ?? null);
  const rawBlackBoxPreviewRows: BlackBoxRow[] = Array.isArray(wave1.blackBoxPreview) ? wave1.blackBoxPreview : [];
  const normalizedBlackBoxGate = normalizeBlackBoxGateWave({
    pendingBlackBoxCount: rawPendingBlackBoxCount,
    unreadBlackBoxCount: rawUnreadBlackBoxCount,
    blackBoxPreviewRows: rawBlackBoxPreviewRows,
    todayIsoDate,
    nowIso,
  });
  const pendingBlackBoxCount = normalizedBlackBoxGate.pendingBlackBoxCount;
  const unreadBlackBoxCount = normalizedBlackBoxGate.unreadBlackBoxCount;
  const blackBoxPreviewRows = normalizedBlackBoxGate.blackBoxPreviewRows;
  const blackBoxWatermark = normalizeIsoTimestamp(wave1.blackBoxWatermark ?? null);
  const dockCountFromTasks: number = typeof wave1.dockCount === 'number' ? wave1.dockCount : 0;
  const dockTasksWatermark = normalizeIsoTimestamp(wave1.dockWatermark ?? null);
  const state = toFocusSessionState(latestSession?.session_state ?? null);
  const commandCenterSlots = resolveCommandCenterSlots(state);
  const primarySlot = commandCenterSlots[0] ?? null;
  const visibleDockSlots = commandCenterSlots.slice(1);
  const allDockSlots = [
    ...visibleDockSlots,
    ...(state.comboSelectTasks ?? []),
    ...(state.backupTasks ?? []),
  ].filter((slot, index, slots) => {
    if (slot.taskId && slot.taskId === primarySlot?.taskId) {
      return false;
    }
    const taskId = slot.taskId;
    if (typeof taskId !== 'string' || taskId.length === 0) {
      return true;
    }
    return slots.findIndex(candidate => candidate.taskId === taskId) === index;
  });
  const taskIds = uniqueIds([
    primarySlot?.taskId ?? null,
    ...allDockSlots.map(slot => slot.taskId),
  ]);
  const projectIds = uniqueIds([
    primarySlot?.sourceProjectId ?? null,
    ...allDockSlots.map(slot => slot.sourceProjectId),
  ]);

  // Wave 2：tasks 校验 / projects 校验 这 2 个查询依赖 wave1 解出的 taskIds/projectIds，
  // dockCount/dockWatermark 已在 wave1 RPC 内一次性算出，这里无需再查。
  const needsTaskLookup = taskIds.length > 0 && accessibleProjectIds.length > 0;
  const needsProjectLookup = projectIds.length > 0 && accessibleProjectIds.length > 0;
  const [
    taskLookupResult,
    projectLookupResult,
  ] = await Promise.all([
    needsTaskLookup
      ? client
          .from('tasks')
          .select('id,title,project_id,updated_at')
          .in('id', taskIds)
          .in('project_id', accessibleProjectIds)
          .is('deleted_at', null)
      : Promise.resolve({ data: [], error: null } as const),
    needsProjectLookup
      ? client
          .from('projects')
          .select('id,title,updated_at')
          .in('id', projectIds)
          .eq('owner_id', device.user_id)
          .is('deleted_at', null)
      : Promise.resolve({ data: [], error: null } as const),
  ]);

  if (taskLookupResult.error) {
    return summaryResponse(responseHeaders, 500, {
      error: 'Failed to validate task references',
      code: 'TASK_LOOKUP_FAILED',
      degradedReasons: ['task-lookup-failed'],
      capabilities: publicCapabilities,
      warnings: ['open-app-to-finish-setup'],
    });
  }
  if (projectLookupResult.error) {
    return summaryResponse(responseHeaders, 500, {
      error: 'Failed to validate project references',
      code: 'PROJECT_LOOKUP_FAILED',
      degradedReasons: ['project-lookup-failed'],
      capabilities: publicCapabilities,
      warnings: ['open-app-to-finish-setup'],
    });
  }

  const taskMap = new Map<string, TaskRow>();
  for (const row of (taskLookupResult.data ?? []) as TaskRow[]) {
    taskMap.set(row.id, row);
  }
  const projectMap = new Map<string, ProjectRow>();
  for (const row of (projectLookupResult.data ?? []) as ProjectRow[]) {
    projectMap.set(row.id, row);
  }

  const toDockItem = (slot: FocusTaskSlotLike) => {
    const task = slot.taskId ? taskMap.get(slot.taskId) : null;
    const projectId = task?.project_id ?? slot.sourceProjectId ?? null;
    const project = projectId ? projectMap.get(projectId) ?? null : null;
    // 2026-04-19 inline 任务兼容：见上方 focusValid 同款说明，允许 inlineTitle 回退
    const hasInlineFallback = typeof slot.inlineTitle === 'string' && slot.inlineTitle.trim().length > 0;
    const validTask = slot.taskId ? (Boolean(task) || hasInlineFallback) : true;
    const validProject = projectId ? Boolean(project) : true;
    const valid = validTask && validProject;

    return {
      taskId: slot.taskId,
      projectId,
      title: task?.title ?? slot.inlineTitle ?? '未命名任务',
      projectTitle: project?.title ?? null,
      estimatedMinutes: slot.estimatedMinutes,
      isMaster: isMasterSlot(slot),
      valid,
      taskUpdatedAt: task?.updated_at ?? null,
      projectUpdatedAt: project?.updated_at ?? null,
    };
  };

  const toCommandCenterItem = (slot: FocusTaskSlotLike, position: number) => {
    const task = slot.taskId ? taskMap.get(slot.taskId) : null;
    const projectId = task?.project_id ?? slot.sourceProjectId ?? null;
    const project = projectId ? projectMap.get(projectId) ?? null : null;
    const hasInlineFallback = typeof slot.inlineTitle === 'string' && slot.inlineTitle.trim().length > 0;
    const validTask = slot.taskId ? (Boolean(task) || hasInlineFallback) : true;
    const validProject = projectId ? Boolean(project) : true;
    const waitEndAt = resolveWaitEndAt(slot);

    return {
      position,
      taskId: slot.taskId,
      projectId,
      title: task?.title ?? slot.inlineTitle ?? '未命名任务',
      projectTitle: project?.title ?? null,
      estimatedMinutes: slot.estimatedMinutes,
      waitMinutes: slot.waitMinutes ?? null,
      waitStartedAt: normalizeIsoTimestamp(slot.waitStartedAt ?? null),
      waitEndAt,
      waitExpired: isWaitExpiredSlot(slot),
      focusStatus: slot.focusStatus ?? null,
      isMain: isMasterSlot(slot),
      isFocused: position === 1 || slot.focusStatus === 'focusing',
      valid: validTask && validProject,
    };
  };

  const dockItems = visibleDockSlots.map(toDockItem);
  const allDockItems = allDockSlots.map(toDockItem);
  const commandCenterItems = commandCenterSlots.map((slot, index) => toCommandCenterItem(slot, index + 1));

  const dockCount = allDockItems.length;
  const taskBackedDockCount = allDockItems.filter(item => item.taskId !== null).length;
  const backupCount = Math.max(dockCount - visibleDockSlots.length, 0);

  const focusTask = primarySlot?.taskId ? taskMap.get(primarySlot.taskId) ?? null : null;
  const focusProjectId = focusTask?.project_id ?? primarySlot?.sourceProjectId ?? null;
  const focusProject = focusProjectId ? projectMap.get(focusProjectId) ?? null : null;
  const hasRenderableFocusTarget = isRenderableFocusSlot(primarySlot);
  const missingBlackBoxProjectIds = [...new Set(
    blackBoxPreviewRows
      .map(row => row.project_id)
      .filter((projectId): projectId is string => typeof projectId === 'string' && projectId.length > 0)
      .filter(projectId => accessibleProjectIds.includes(projectId) && !projectMap.has(projectId)),
  )];
  if (missingBlackBoxProjectIds.length > 0) {
    const { data: blackBoxProjectData, error: blackBoxProjectError } = await client
      .from('projects')
      .select('id,title,updated_at')
      .eq('owner_id', device.user_id)
      .is('deleted_at', null)
      .in('id', missingBlackBoxProjectIds);

    if (blackBoxProjectError) {
      return summaryResponse(responseHeaders, 500, {
        error: 'Failed to validate black box project references',
        code: 'BLACK_BOX_PROJECT_LOOKUP_FAILED',
        degradedReasons: ['black-box-project-lookup-failed'],
        capabilities: publicCapabilities,
        warnings: ['open-app-to-finish-setup'],
      });
    }

    for (const row of (blackBoxProjectData ?? []) as ProjectRow[]) {
      projectMap.set(row.id, row);
    }
  }
  const blackBoxPreviews = blackBoxPreviewRows.map(row => {
    const content = typeof row.content === 'string' && row.content.trim().length > 0
      ? row.content.trim()
      : null;
    const projectId = row.project_id ?? null;
    return {
      entryId: row.id,
      projectId,
      projectTitle: projectId ? projectMap.get(projectId)?.title ?? null : null,
      content,
      isRead: row.is_read === true,
      createdAt: normalizeIsoTimestamp(row.created_at ?? null),
      updatedAt: normalizeIsoTimestamp(row.updated_at ?? null),
      valid: content !== null,
    };
  });
  const gatePreview = blackBoxPreviews[0] ?? {
    entryId: null,
    projectId: null,
    projectTitle: null,
    content: null,
    isRead: false,
    createdAt: null,
    updatedAt: null,
    valid: false,
  };
  // 2026-04-19 inline 任务兼容：dock 里的 inline/dock-created 任务（sourceBlockType=text、
  // sourceProjectId=null、有 inlineTitle）的 taskId 是客户端生成的 UUID，不会在 tasks 表里命中。
  // 过去这种情况被当作 soft-delete 导致 focus.active=false，widget 错误降级到 gate/dock 视图。
  // 这里允许 inlineTitle 作为 fallback 把它当作有效的 focus target。
  const focusHasInlineFallback = hasRenderableFocusTarget
    && typeof primarySlot?.inlineTitle === 'string'
    && primarySlot.inlineTitle.trim().length > 0;
  const focusTaskMissing = Boolean(primarySlot?.taskId) && !focusTask;
  const focusTaskIsInline = focusTaskMissing && focusHasInlineFallback;
  const focusValid = hasRenderableFocusTarget
    ? (
        (primarySlot.taskId ? (Boolean(focusTask) || focusTaskIsInline) : true)
        && (focusProjectId ? Boolean(focusProject) : true)
      )
    : false;
  const hasSoftDeleteTarget = dockItems.some(item => !item.valid)
    || (focusTaskMissing && !focusTaskIsInline)
    || Boolean(focusProjectId && !focusProject);
  const entryUrl = buildEntryUrlFromContext({
    forceWorkspaceFallback: hasSoftDeleteTarget,
    focusValid,
    focusTaskId: primarySlot?.taskId ?? null,
    focusProjectId,
    dockItems,
  });

  const degradedReasons = hasSoftDeleteTarget
    ? ['soft-delete-target']
    : [];

  if (shouldRepairPushToken) {
    degradedReasons.push('push-token-missing');
  }

  const consistencyState = dockCountFromTasks === taskBackedDockCount ? 'aligned' : 'drifted';
  if (consistencyState === 'drifted') {
    degradedReasons.push('dock-count-drift');
  }

  const summaryVersionCursor = buildSummaryVersionCursor({
    latestSessionUpdatedAt: latestSession?.updated_at ?? null,
    dockTasksWatermark,
    blackBoxWatermark,
    focusTaskUpdatedAt: focusTask?.updated_at ?? null,
    focusProjectUpdatedAt: focusProject?.updated_at ?? null,
    dockTaskUpdatedAts: allDockItems.map(item => item.taskUpdatedAt),
    dockProjectUpdatedAts: allDockItems.map(item => item.projectUpdatedAt),
  });

  const cloudUpdatedAt = summaryVersionCursor;
  const ageMinutes = cloudUpdatedAt
    ? Math.max(0, Math.floor((Date.now() - new Date(cloudUpdatedAt).getTime()) / 60000))
    : Number.POSITIVE_INFINITY;
  const freshnessState: WidgetFreshnessState = ageMinutes <= limits.freshThresholdMinutes
    ? 'fresh'
    : ageMinutes <= limits.agingThresholdMinutes
      ? 'aging'
      : 'stale';

  const summarySignature = await sha256Hex(JSON.stringify({
    focus: {
      active: state.isActive === true && focusValid,
      taskId: primarySlot?.taskId ?? null,
      projectId: focusProjectId,
      projectTitle: focusProject?.title ?? null,
      title: focusTask?.title ?? primarySlot?.inlineTitle ?? null,
      remainingMinutes: primarySlot?.estimatedMinutes ?? null,
      isMaster: isMasterSlot(primarySlot),
      valid: focusValid,
    },
    dock: {
      count: dockCount,
      countFromTasks: dockCountFromTasks,
      items: dockItems.map(item => ({
        taskId: item.taskId,
        projectId: item.projectId,
        title: item.title,
        projectTitle: item.projectTitle,
        estimatedMinutes: item.estimatedMinutes,
        isMaster: item.isMaster,
        valid: item.valid,
      })),
    },
    commandCenter: {
      slots: commandCenterItems,
      mainTaskId: commandCenterItems.find(item => item.isMain)?.taskId ?? null,
      focusedTaskId: commandCenterItems[0]?.taskId ?? null,
      backupCount,
    },
    blackBox: {
      pendingCount: pendingBlackBoxCount ?? 0,
      unreadCount: unreadBlackBoxCount ?? 0,
      nextReviewAt: nextGateReviewAt,
      previews: blackBoxPreviews,
      gatePreview,
    },
    degradedReasons,
    consistencyState,
  }));

  const summaryVersion = buildSummaryVersion(summaryVersionCursor, summarySignature);
  const summaryVersionRegressed = isSummaryVersionRegressed(body.lastKnownSummaryVersion, summaryVersion);

  if (summaryVersionRegressed) {
    degradedReasons.push('summary-version-regressed');
  }

  const trustState: WidgetTrustState = summaryVersionRegressed
    ? 'untrusted'
    : degradedReasons.length === 0
      ? 'verified'
      : 'provisional';

  const summary = buildSummaryEnvelope({
    summaryVersion,
    cloudUpdatedAt,
    freshnessState,
    trustState,
    sourceState: 'cloud-confirmed' as WidgetSourceState,
    consistencyState,
    degradedReasons,
    capabilities: publicCapabilities,
    entryUrl,
    focus: {
      active: state.isActive === true && focusValid,
      taskId: primarySlot?.taskId ?? null,
      projectId: focusProjectId,
      projectTitle: focusProject?.title ?? null,
      title: focusTask?.title ?? primarySlot?.inlineTitle ?? null,
      remainingMinutes: primarySlot?.estimatedMinutes ?? null,
      isMaster: isMasterSlot(primarySlot),
      valid: focusValid,
    },
    dock: {
      count: dockCount,
      countFromTasks: dockCountFromTasks,
      items: dockItems.map(({ taskUpdatedAt: _taskUpdatedAt, projectUpdatedAt: _projectUpdatedAt, ...item }) => item),
    },
    commandCenter: {
      slots: commandCenterItems,
      mainTaskId: commandCenterItems.find(item => item.isMain)?.taskId ?? null,
      focusedTaskId: commandCenterItems[0]?.taskId ?? null,
      backupCount,
    },
    blackBox: {
      pendingCount: pendingBlackBoxCount ?? 0,
      unreadCount: unreadBlackBoxCount ?? 0,
      nextReviewAt: nextGateReviewAt,
      previews: blackBoxPreviews,
      gatePreview,
    },
    warnings: [
      'cloud-state-only',
      ...(shouldRepairPushToken ? ['open-app-to-restore-push'] : []),
      ...(latestSession ? [] : ['no-focus-session']),
      ...(body.lastKnownSummaryVersion && body.lastKnownSummaryVersion === summaryVersion ? ['client-already-current'] : []),
      ...(summaryVersionRegressed ? ['summary-version-regressed'] : []),
    ],
  });

  const { error: touchError } = await client
    .from('widget_devices')
    .update({ last_seen_at: nowIso, updated_at: nowIso, capabilities: nextDeviceCapabilities })
    .eq('id', device.id);

  if (touchError) {
    console.warn('[WidgetSummary] failed to update last_seen_at', {
      deviceId: redactId(device.id),
      message: touchError.message,
    });
  }

  const { error: touchInstanceError } = await client
    .from('widget_instances')
    .update({ last_seen_at: nowIso, updated_at: nowIso })
    .eq('id', instance.id);

  if (touchInstanceError) {
    console.warn('[WidgetSummary] failed to update instance last_seen_at', {
      instanceId: redactId(instance.id),
      message: touchInstanceError.message,
    });
  }

  logWidgetEvent('widget_summary_fetch_success', {
    userId: device.user_id,
    deviceId: device.id,
    instanceId: instance.id,
    platform: body.platform ?? null,
    bindingGeneration: device.binding_generation,
    trustState,
    freshnessState,
    sourceState: 'cloud-confirmed',
    degradedReasons: degradedReasons.length > 0 ? degradedReasons : null,
    summaryVersion,
  });
  if (freshnessState !== 'fresh') {
    logWidgetEvent('widget_stale_render', {
      userId: device.user_id,
      deviceId: device.id,
      instanceId: instance.id,
      platform: body.platform ?? null,
      freshnessState,
      trustState,
    });
  }
  if (trustState !== 'verified') {
    logWidgetEvent('widget_untrusted_render', {
      userId: device.user_id,
      deviceId: device.id,
      instanceId: instance.id,
      platform: body.platform ?? null,
      trustState,
      degradedReasons: degradedReasons.length > 0 ? degradedReasons : null,
    });
  }

  return jsonResponse(summary, responseHeaders, 200);
});
