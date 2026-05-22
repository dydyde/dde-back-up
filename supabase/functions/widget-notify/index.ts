import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

import { Webhook } from 'https://esm.sh/standardwebhooks@1.0.0';

import {
  buildWidgetWebhookSigningMessage,
  normalizeWidgetWebhookSecret,
} from '../_shared/widget-normalization.ts';

import {
  consumeWidgetRateLimit,
  createServiceRoleClient,
  evaluateWidgetCapabilities,
  extractWidgetClientVersion,
  getClientIp,
  getCorsHeaders,
  jsonResponse,
  loadWidgetCapabilities,
  loadWidgetLimits,
  logWidgetEvent,
  redactId,
  sha256Hex,
  verifyJwtUser,
  withPrivateNoStoreHeaders,
} from '../_shared/widget-common.ts';
import {
  getFcmAccessToken,
  loadFcmServiceAccount,
  sendFcmDataPush,
} from '../_shared/widget-fcm.ts';

type DatabaseWebhookEventType = 'INSERT' | 'UPDATE' | 'DELETE';
type AllowedWidgetNotifyTable = 'focus_sessions' | 'black_box_entries' | 'tasks' | 'projects';
type WidgetNotifyStatus =
  | 'processing'
  | 'duplicate'
  | 'skipped-disabled'
  | 'skipped-no-user'
  | 'skipped-no-devices'
  | 'throttled'
  | 'rate-limited'
  | 'provider-unavailable'
  | 'internal-error'
  | 'accepted-dry-run'
  | 'accepted-fanout'
  | 'fanout-failed';

interface DatabaseWebhookPayload {
  type: DatabaseWebhookEventType;
  table: AllowedWidgetNotifyTable;
  schema: string;
  record: Record<string, unknown> | null;
  old_record: Record<string, unknown> | null;
}

interface WidgetNotifyEventRow {
  last_status?: string | null;
  updated_at?: string | null;
}

interface WidgetNotifyThrottleRow {
  last_notified_at?: string | null;
}

interface WidgetDeviceRow {
  id: string;
  binding_generation: number;
  installation_id: string;
  capabilities: Record<string, unknown> | null;
  push_token: string | null;
  expires_at: string;
}

interface ActiveWidgetInstanceBindingRow {
  device_id: string;
  binding_generation: number;
}

type BeginNotifyEventResult =
  | { kind: 'created' }
  | { kind: 'duplicate' }
  | { kind: 'retry-later'; retryAfterSeconds: number };

const ALLOWED_TABLES = new Set<AllowedWidgetNotifyTable>([
  'focus_sessions',
  'black_box_entries',
  'tasks',
  'projects',
]);

const NOTIFY_WINDOW_SECONDS = 10;
// 关键状态变更（专注会话、项目软删 / 归档）对小组件语义至关重要，即使处于 10s 节流窗口
// 内也必须放行，避免「结束专注后立即开启新专注」这类场景被前一条 black_box_entries
// 事件把 last_notified_at 压到窗口里，从而吞掉 focus_sessions 的 INSERT / UPDATE。
const MAX_WEBHOOK_AGE_MS = 5 * 60 * 1000;
const STALE_PROCESSING_RECLAIM_MS = 60 * 1000;
const PUSH_PROVIDER_ENV_KEYS = ['FCM_PROJECT_ID', 'FCM_CLIENT_EMAIL', 'FCM_PRIVATE_KEY'] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNonEmptyText(value: unknown, maxLength = 256): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return null;
  return trimmed;
}

function hexEncode(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function hmacSha256Hex(secret: string, value: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return hexEncode(new Uint8Array(signature));
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }

  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }

  return diff === 0;
}

function parseWebhookTimestamp(value: string | null): number | null {
  const timestamp = asNonEmptyText(value, 64);
  if (!timestamp) {
    return null;
  }

  if (/^\d+$/.test(timestamp)) {
    const parsed = Number(timestamp);
    if (!Number.isFinite(parsed)) {
      return null;
    }
    return timestamp.length <= 10 ? parsed * 1000 : parsed;
  }

  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

function hasStandardWebhookHeaders(req: Request): boolean {
  return Boolean(req.headers.get('webhook-id') || req.headers.get('svix-id'));
}

async function verifyCustomWebhook(
  rawBody: string,
  req: Request,
  webhookSecret: string,
): Promise<{ eventId: string; payload: unknown } | null> {
  const eventId = asNonEmptyText(req.headers.get('x-widget-webhook-event-id'), 256);
  const timestamp = asNonEmptyText(req.headers.get('x-widget-webhook-timestamp'), 64);
  const signature = asNonEmptyText(req.headers.get('x-widget-webhook-signature'), 256);
  if (!eventId || !timestamp || !signature) {
    return null;
  }

  const timestampMs = parseWebhookTimestamp(timestamp);
  if (timestampMs === null || Math.abs(Date.now() - timestampMs) > MAX_WEBHOOK_AGE_MS) {
    return null;
  }

  const expectedSignature = await hmacSha256Hex(
    webhookSecret,
    buildWidgetWebhookSigningMessage(eventId, timestamp, rawBody),
  );
  if (!constantTimeEqual(expectedSignature, signature.toLowerCase())) {
    return null;
  }

  try {
    return {
      eventId,
      payload: JSON.parse(rawBody) as unknown,
    };
  } catch {
    return null;
  }
}

function normalizeDatabaseWebhookPayload(value: unknown): DatabaseWebhookPayload | null {
  if (!isPlainObject(value)) return null;

  const type = asNonEmptyText(value.type, 16);
  const table = asNonEmptyText(value.table, 64);
  const schema = asNonEmptyText(value.schema, 64);
  const record = value.record;
  const oldRecord = value.old_record;

  if (type !== 'INSERT' && type !== 'UPDATE' && type !== 'DELETE') {
    return null;
  }

  if (!table || !ALLOWED_TABLES.has(table as AllowedWidgetNotifyTable) || !schema) {
    return null;
  }

  if (record !== null && !isPlainObject(record)) {
    return null;
  }

  if (oldRecord !== null && !isPlainObject(oldRecord)) {
    return null;
  }

  return {
    type,
    table: table as AllowedWidgetNotifyTable,
    schema,
    record: isPlainObject(record) ? record : null,
    old_record: isPlainObject(oldRecord) ? oldRecord : null,
  };
}

function extractSummaryCursor(payload: DatabaseWebhookPayload): string | null {
  const candidates = [
    payload.record?.updated_at,
    payload.record?.deleted_at,
    payload.record?.created_at,
    payload.old_record?.updated_at,
    payload.old_record?.deleted_at,
    payload.old_record?.created_at,
  ];

  for (const candidate of candidates) {
    const value = asNonEmptyText(candidate, 128);
    if (value) {
      return value;
    }
  }

  return null;
}

/**
 * 2026-04-22 颠覆性压缩：从 focus_sessions 事件中抽取 focusMode / focusSessionId 提示字段，
 * 作为轻量 hint 直接塞进 FCM data payload，供小组件在首屏（summary fetch 仍在途中）就把
 * 专注模式按钮/图标切换到正确的视觉状态——避免额外等待 ~2s 的 summary 回环。
 *
 * 只在 focus_sessions 事件且 ended_at 可解析时返回。hint 是「乐观」视图，
 * 后续 summary fetch 成功后仍以服务端权威答案为准。
 */
function extractFocusHint(payload: DatabaseWebhookPayload): { active: string; sessionId: string } | null {
  if (payload.table !== 'focus_sessions') {
    return null;
  }
  // DELETE 会话语义等同于结束，active = false。
  if (payload.type === 'DELETE') {
    const sessionId = asNonEmptyText(payload.old_record?.id, 64) ?? '';
    return { active: 'false', sessionId };
  }

  const record = payload.record;
  if (!isPlainObject(record)) {
    return null;
  }

  const endedAt = record['ended_at'];
  const endedAtIsNullOrEmpty = endedAt === null || endedAt === undefined
    || (typeof endedAt === 'string' && endedAt.trim().length === 0);
  // ended_at=null 意味着当前会话仍处于活跃态 → active=true；反之为 false。
  // 这个口径跟主 App 客户端对 focusMode 的标定一致（dock-engine.service.ts 的 focusMode signal）。
  const active = endedAtIsNullOrEmpty;
  const sessionId = asNonEmptyText(record['id'], 64) ?? '';
  return { active: active ? 'true' : 'false', sessionId };
}

function hasConfiguredPushProvider(): boolean {
  return PUSH_PROVIDER_ENV_KEYS.every((envKey) => Boolean(Deno.env.get(envKey)?.trim()));
}

async function beginNotifyEvent(
  client: ReturnType<typeof createServiceRoleClient>,
  webhookId: string,
  payload: DatabaseWebhookPayload,
  summaryCursor: string | null,
): Promise<BeginNotifyEventResult> {
  const { error } = await client
    .from('widget_notify_events')
    .insert({
      webhook_id: webhookId,
      source_table: payload.table,
      event_type: payload.type,
      summary_cursor: summaryCursor,
      last_status: 'processing',
    });

  if (!error) {
    return { kind: 'created' };
  }

  if (error.code === '23505') {
    const { data: existingData, error: existingError } = await client
      .from('widget_notify_events')
      .select('last_status, updated_at')
      .eq('webhook_id', webhookId)
      .maybeSingle();

    if (existingError) {
      throw new Error(`load existing widget_notify_event failed: ${existingError.message}`);
    }

    const existing = isPlainObject(existingData) ? existingData as WidgetNotifyEventRow : null;
    const existingStatus = existing?.last_status ?? null;
    const existingUpdatedAt = typeof existing?.updated_at === 'string' ? existing.updated_at : null;
    const existingUpdatedAtMs = typeof existing?.updated_at === 'string'
      ? Date.parse(existing.updated_at)
      : Number.NaN;
    const canReclaim = existingStatus === 'internal-error'
      || (existingStatus === 'processing'
        && Number.isFinite(existingUpdatedAtMs)
        && Date.now() - existingUpdatedAtMs >= STALE_PROCESSING_RECLAIM_MS);
    if (existingStatus === 'processing' && Number.isFinite(existingUpdatedAtMs) && !canReclaim) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((STALE_PROCESSING_RECLAIM_MS - (Date.now() - existingUpdatedAtMs)) / 1000),
      );
      return { kind: 'retry-later', retryAfterSeconds };
    }
    if (!canReclaim || !existingStatus || !existingUpdatedAt) {
      return { kind: 'duplicate' };
    }

    const nowIso = new Date().toISOString();
    const { data: reclaimedRow, error: reclaimError } = await client
      .from('widget_notify_events')
      .update({
        user_id: null,
        source_table: payload.table,
        event_type: payload.type,
        summary_cursor: summaryCursor,
        last_status: 'processing',
        processed_at: nowIso,
        updated_at: nowIso,
      })
      .eq('webhook_id', webhookId)
      .eq('last_status', existingStatus)
      .eq('updated_at', existingUpdatedAt)
      .select('webhook_id')
      .maybeSingle();

    if (reclaimError) {
      throw new Error(`reclaim widget_notify_event failed: ${reclaimError.message}`);
    }

    return reclaimedRow ? { kind: 'created' } : { kind: 'retry-later', retryAfterSeconds: 1 };
  }

  throw new Error(`beginNotifyEvent failed: ${error.message}`);
}

async function finishNotifyEvent(
  client: ReturnType<typeof createServiceRoleClient>,
  webhookId: string,
  status: WidgetNotifyStatus,
  userId: string | null,
  summaryCursor: string | null,
): Promise<void> {
  const { error } = await client
    .from('widget_notify_events')
    .update({
      user_id: userId,
      summary_cursor: summaryCursor,
      last_status: status,
      processed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('webhook_id', webhookId);

  if (error) {
    throw new Error(`finishNotifyEvent failed: ${error.message}`);
  }
}

async function resolveUserId(
  client: ReturnType<typeof createServiceRoleClient>,
  payload: DatabaseWebhookPayload,
): Promise<string | null> {
  if (payload.table === 'focus_sessions' || payload.table === 'black_box_entries') {
    return asNonEmptyText(payload.record?.user_id, 64)
      ?? asNonEmptyText(payload.old_record?.user_id, 64);
  }

  if (payload.table === 'projects') {
    return asNonEmptyText(payload.record?.owner_id, 64)
      ?? asNonEmptyText(payload.old_record?.owner_id, 64);
  }

  const projectId = asNonEmptyText(payload.record?.project_id, 64)
    ?? asNonEmptyText(payload.old_record?.project_id, 64);
  if (!projectId) {
    return null;
  }

  const { data, error } = await client
    .from('projects')
    .select('owner_id')
    .eq('id', projectId)
    .limit(1);

  if (error) {
    throw new Error(`resolveUserId(project) failed: ${error.message}`);
  }

  const row = Array.isArray(data) ? data[0] as { owner_id?: unknown } | undefined : undefined;
  return asNonEmptyText(row?.owner_id, 64);
}

async function loadNotifyThrottle(
  client: ReturnType<typeof createServiceRoleClient>,
  userId: string,
): Promise<WidgetNotifyThrottleRow | null> {
  const { data, error } = await client
    .from('widget_notify_throttle')
    .select('last_notified_at')
    .eq('user_id', userId)
    .limit(1);

  if (error) {
    throw new Error(`loadNotifyThrottle failed: ${error.message}`);
  }

  return Array.isArray(data) && data[0]
    ? data[0] as WidgetNotifyThrottleRow
    : null;
}

function isWithinNotifyWindow(lastNotifiedAt: string | null | undefined, nowMs: number): boolean {
  if (!lastNotifiedAt) {
    return false;
  }

  const parsed = Date.parse(lastNotifiedAt);
  if (!Number.isFinite(parsed)) {
    return false;
  }

  return nowMs - parsed < NOTIFY_WINDOW_SECONDS * 1000;
}

function normalizeScalarDeltaValue(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  return null;
}

function didScalarFieldChange(payload: DatabaseWebhookPayload, field: string): boolean {
  return normalizeScalarDeltaValue(payload.record?.[field])
    !== normalizeScalarDeltaValue(payload.old_record?.[field]);
}

function shouldBypassNotifyWindow(payload: DatabaseWebhookPayload): boolean {
  if (payload.table === 'focus_sessions') {
    return payload.type === 'INSERT'
      || (payload.type === 'UPDATE' && didScalarFieldChange(payload, 'ended_at'));
  }

  if (payload.table === 'projects') {
    return payload.type === 'UPDATE' && didScalarFieldChange(payload, 'deleted_at');
  }

  return false;
}

async function upsertNotifyThrottle(
  client: ReturnType<typeof createServiceRoleClient>,
  userId: string,
  webhookId: string,
  summaryCursor: string | null,
  nowIso: string,
): Promise<void> {
  const { error } = await client
    .from('widget_notify_throttle')
    .upsert({
      user_id: userId,
      last_notified_at: nowIso,
      last_summary_version: summaryCursor,
      last_event_id: webhookId,
      updated_at: nowIso,
    });

  if (error) {
    throw new Error(`upsertNotifyThrottle failed: ${error.message}`);
  }
}

async function loadActiveAndroidDevices(
  client: ReturnType<typeof createServiceRoleClient>,
  userId: string,
  nowIso: string,
): Promise<WidgetDeviceRow[]> {
  const nowMs = Date.parse(nowIso);
  const { data: instanceData, error: instanceError } = await client
    .from('widget_instances')
    .select('device_id, binding_generation')
    .eq('user_id', userId)
    .eq('platform', 'android-widget')
    .is('uninstalled_at', null);

  if (instanceError) {
    throw new Error(`loadActiveAndroidDevices(instance bindings) failed: ${instanceError.message}`);
  }

  const activeBindingKeys = new Set(
    (Array.isArray(instanceData) ? instanceData : [])
      .filter((row): row is ActiveWidgetInstanceBindingRow => isPlainObject(row)
        && typeof row.device_id === 'string'
        && typeof row.binding_generation === 'number'
        && Number.isFinite(row.binding_generation))
      .map((row) => `${row.device_id}:${Math.trunc(row.binding_generation)}`),
  );
  if (activeBindingKeys.size === 0) {
    return [];
  }

  const { data, error } = await client
    .from('widget_devices')
    .select('id, binding_generation, installation_id, capabilities, push_token, expires_at')
    .eq('user_id', userId)
    .eq('platform', 'android-widget')
    .is('revoked_at', null);

  if (error) {
    throw new Error(`loadActiveAndroidDevices failed: ${error.message}`);
  }

  return (Array.isArray(data) ? data : [])
    .filter((row): row is WidgetDeviceRow => isPlainObject(row)
      && typeof row.id === 'string'
      && typeof row.binding_generation === 'number'
      && Number.isFinite(row.binding_generation)
      && typeof row.installation_id === 'string'
      && typeof row.expires_at === 'string')
    .filter((row) => {
      const expiresAtMs = Date.parse(row.expires_at);
      return typeof row.push_token === 'string'
        && row.push_token.trim().length > 0
        && Number.isFinite(expiresAtMs)
        && expiresAtMs > nowMs
        && activeBindingKeys.has(`${row.id}:${Math.trunc(row.binding_generation)}`);
    });
}

Deno.serve(async (req) => {
  const origin = req.headers.get('Origin');
  const corsHeaders = getCorsHeaders(origin, 'POST, OPTIONS');
  const responseHeaders = withPrivateNoStoreHeaders(corsHeaders);

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: responseHeaders });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' }, responseHeaders, 405);
  }

  const client = createServiceRoleClient();
  const limits = await loadWidgetLimits(client);
  const rawBody = await req.text();
  const webhookSecret = normalizeWidgetWebhookSecret(Deno.env.get('WIDGET_NOTIFY_WEBHOOK_SECRET') ?? null);
  if (!webhookSecret) {
    return jsonResponse({ error: 'Webhook secret is not configured', code: 'WEBHOOK_SECRET_MISSING' }, responseHeaders, 503);
  }

  let verifiedPayload: unknown;
  let webhookId: string | null = null;
  // 2026-04-22 颠覆性压缩 (plan D)：新增 JWT 直调路径。PWA 在 focus 翻转瞬间可并行
  // 调用本函数（带 Authorization: Bearer <user_jwt>）绕过 DB trigger + pg_net 的 ~3s 轮询，
  // 端到端从「ended_at → FCM 抵达」压缩 2-5s。
  //
  // 请求体格式：
  // - Focus: { directNotify: true, focusActive: boolean, focusSessionId: string,
  //            webhookId: string /* 幂等键，由 PWA 生成 uuid */, updatedAt?: string }
  // - BlackBox: { directNotify: true, table: 'black_box_entries', entryId: string,
  //               webhookId: string, updatedAt?: string }
  //
  // 安全与幂等：verifyJwtUser 确认 token 合法后取 user.id 作为事件主体；webhookId 走与
  // DB 触发路径同一张 widget_notify_events 唯一约束表，天然去重（若 pg_net 后到达，会被
  // kind='duplicate' 走掉）。
  const usesStandardWebhookHeaders = hasStandardWebhookHeaders(req);
  const hasBearer = Boolean(req.headers.get('Authorization'));
  let directNotifyUserId: string | null = null;

  if (usesStandardWebhookHeaders) {
    try {
      const webhook = new Webhook(webhookSecret);
      verifiedPayload = webhook.verify(rawBody, Object.fromEntries(req.headers));
      webhookId = asNonEmptyText(req.headers.get('webhook-id'), 256)
        ?? asNonEmptyText(req.headers.get('svix-id'), 256);
    } catch {
      return jsonResponse({ error: 'Invalid webhook signature', code: 'INVALID_SIGNATURE' }, responseHeaders, 401);
    }
  } else if (hasBearer) {
    const authResult = await verifyJwtUser(req);
    if (!authResult) {
      return jsonResponse({ error: 'Invalid user session', code: 'INVALID_JWT' }, responseHeaders, 401);
    }
    let parsedBody: unknown;
    try {
      parsedBody = rawBody.length > 0 ? JSON.parse(rawBody) : null;
    } catch {
      return jsonResponse({ error: 'Malformed direct notify body', code: 'INVALID_PAYLOAD' }, responseHeaders, 400);
    }
    if (!isPlainObject(parsedBody) || parsedBody['directNotify'] !== true) {
      return jsonResponse({ error: 'Direct notify flag required', code: 'INVALID_PAYLOAD' }, responseHeaders, 400);
    }

    const directWebhookId = asNonEmptyText(parsedBody['webhookId'], 256);
    const directTable = asNonEmptyText(parsedBody['table'], 64) ?? 'focus_sessions';
    const updatedAt = asNonEmptyText(parsedBody['updatedAt'], 128) ?? new Date().toISOString();
    if (!directWebhookId) {
      return jsonResponse({ error: 'Direct notify payload invalid', code: 'INVALID_PAYLOAD' }, responseHeaders, 400);
    }

    if (directTable === 'black_box_entries') {
      const entryId = asNonEmptyText(parsedBody['entryId'], 64);
      if (!entryId) {
        return jsonResponse({ error: 'Direct notify payload invalid', code: 'INVALID_PAYLOAD' }, responseHeaders, 400);
      }

      verifiedPayload = {
        type: 'UPDATE' as const,
        table: 'black_box_entries' as const,
        schema: 'public',
        record: {
          id: entryId,
          user_id: authResult.userId,
          updated_at: updatedAt,
        },
        old_record: {
          id: entryId,
          user_id: authResult.userId,
          updated_at: updatedAt,
        },
      };
    } else {
      const focusActiveRaw = parsedBody['focusActive'];
      const focusSessionId = asNonEmptyText(parsedBody['focusSessionId'], 64);
      if (directTable !== 'focus_sessions' || typeof focusActiveRaw !== 'boolean' || !focusSessionId) {
        return jsonResponse({ error: 'Direct notify payload invalid', code: 'INVALID_PAYLOAD' }, responseHeaders, 400);
      }

      // 合成一个与 DB trigger 等价的 UPDATE 形 payload。ended_at 的口径：active=true 时视为 null，
      // active=false 时填入 updatedAt 作为结束时刻——与 focus_sessions 的真实列语义一致，
      // 下游 extractFocusHint / resolveUserId 均能复用现成逻辑。
      verifiedPayload = {
        type: 'UPDATE' as const,
        table: 'focus_sessions' as const,
        schema: 'public',
        record: {
          id: focusSessionId,
          user_id: authResult.userId,
          ended_at: focusActiveRaw ? null : updatedAt,
          updated_at: updatedAt,
        },
        old_record: {
          id: focusSessionId,
          user_id: authResult.userId,
          ended_at: focusActiveRaw ? updatedAt : null,
          updated_at: updatedAt,
        },
      };
    }
    webhookId = directWebhookId;
    directNotifyUserId = authResult.userId;
  } else {
    const customWebhook = await verifyCustomWebhook(rawBody, req, webhookSecret);
    if (!customWebhook) {
      return jsonResponse({ error: 'Invalid webhook signature', code: 'INVALID_SIGNATURE' }, responseHeaders, 401);
    }
    verifiedPayload = customWebhook.payload;
    webhookId = customWebhook.eventId;
  }

  const payload = normalizeDatabaseWebhookPayload(verifiedPayload);
  if (!payload || payload.schema !== 'public') {
    return jsonResponse({ error: 'Unsupported webhook payload', code: 'INVALID_PAYLOAD' }, responseHeaders, 400);
  }

  if (!webhookId) {
    return jsonResponse({ error: 'Missing webhook id', code: 'WEBHOOK_ID_REQUIRED' }, responseHeaders, 400);
  }

  const summaryCursor = extractSummaryCursor(payload);
  const focusHint = extractFocusHint(payload);
  const beginResult = await beginNotifyEvent(client, webhookId, payload, summaryCursor);
  if (beginResult.kind === 'retry-later') {
    return jsonResponse({
      status: 'processing',
      reason: 'event-in-progress',
      webhookId,
      retryAfterSeconds: beginResult.retryAfterSeconds,
    }, responseHeaders, 409, { 'Retry-After': String(beginResult.retryAfterSeconds) });
  }
  if (beginResult.kind === 'duplicate') {
    return jsonResponse({ status: 'duplicate', webhookId }, responseHeaders, 200);
  }

  let userId: string | null = null;
  try {
    // directNotify 路径：JWT 已经 authoritative 地给出 user_id，跳过 resolveUserId 的额外 DB 查询，
    // 节省一跳；非 directNotify 仍走原路径（从 webhook payload 反查）。
    userId = directNotifyUserId ?? await resolveUserId(client, payload);
    if (!userId) {
      await finishNotifyEvent(client, webhookId, 'skipped-no-user', null, summaryCursor);
      logWidgetEvent('widget_push_dirty_dropped', { webhookId, reason: 'no-user' });
      return jsonResponse({ status: 'skipped', reason: 'no-user', webhookId }, responseHeaders, 202);
    }

    const capabilities = await loadWidgetCapabilities(client);
    const nowIso = new Date().toISOString();
    const devices = await loadActiveAndroidDevices(client, userId, nowIso);
    if (devices.length === 0) {
      await finishNotifyEvent(client, webhookId, 'skipped-no-devices', userId, summaryCursor);
      logWidgetEvent('widget_push_dirty_dropped', { userId, webhookId, reason: 'no-active-android-devices' });
      return jsonResponse({
        status: 'skipped',
        reason: 'no-active-android-devices',
        webhookId,
        userId: redactId(userId),
      }, responseHeaders, 200);
    }

    const deviceDecisions = devices.map((device) => ({
      device,
      decision: evaluateWidgetCapabilities(capabilities, {
        platform: 'android-widget',
        installationId: device.installation_id,
        deviceId: device.id,
        clientVersion: extractWidgetClientVersion(device.capabilities),
      }),
    }));
    const eligibleDevices = deviceDecisions
      .filter(({ decision }) => decision.widgetEnabled && decision.pushAllowed)
      .map(({ device }) => device);
    const suppressedDecisions = deviceDecisions.filter(({ decision }) => !decision.widgetEnabled || !decision.pushAllowed);
    if (eligibleDevices.length === 0) {
      const suppressedReasons = [...new Set(
        suppressedDecisions.map(({ decision }) => decision.reason ?? (decision.widgetEnabled ? 'push-disabled' : 'widget-disabled')),
      )];
      await finishNotifyEvent(client, webhookId, 'skipped-disabled', userId, summaryCursor);
      logWidgetEvent('widget_push_dirty_dropped', {
        userId,
        webhookId,
        reason: suppressedReasons[0] ?? 'push-disabled',
        extra: {
          eligibleDeviceCount: 0,
          suppressedDeviceCount: suppressedDecisions.length,
          suppressedReasons: suppressedReasons.join(','),
        },
      });
      return jsonResponse({
        status: 'skipped',
        reason: suppressedReasons[0] ?? 'push-disabled',
        webhookId,
        userId: redactId(userId),
        eligibleDeviceCount: 0,
      }, responseHeaders, 202);
    }

    const throttleRow = await loadNotifyThrottle(client, userId);
    const nowMs = Date.now();
    const throttleBypass = shouldBypassNotifyWindow(payload);
    if (!throttleBypass && isWithinNotifyWindow(throttleRow?.last_notified_at, nowMs)) {
      await finishNotifyEvent(client, webhookId, 'throttled', userId, summaryCursor);
      logWidgetEvent('widget_push_dirty_dropped', {
        userId,
        webhookId,
        reason: 'deduped-within-window',
      });
      return jsonResponse({
        status: 'skipped',
        reason: 'deduped-within-window',
        webhookId,
        userId: redactId(userId),
        windowSeconds: NOTIFY_WINDOW_SECONDS,
      }, responseHeaders, 202);
    }

    if (!hasConfiguredPushProvider()) {
      await finishNotifyEvent(client, webhookId, 'provider-unavailable', userId, summaryCursor);
      logWidgetEvent('widget_push_dirty_dropped', { userId, webhookId, reason: 'push-provider-unavailable' });
      return jsonResponse({
        status: 'skipped',
        reason: 'push-provider-unavailable',
        code: 'PUSH_PROVIDER_UNAVAILABLE',
        webhookId,
        userId: redactId(userId),
      }, responseHeaders, 202);
    }

    const notifyUserScopeKey = await sha256Hex(`widget-notify-user:${userId}`);
    if (limits.notifyUserPerMinute === 0) {
      await finishNotifyEvent(client, webhookId, 'rate-limited', userId, summaryCursor);
      logWidgetEvent('widget_push_dirty_dropped', { userId, webhookId, reason: 'notify-rate-limited', extra: { scope: 'user-zero' } });
      return jsonResponse({
        status: 'skipped',
        reason: 'notify-rate-limited',
        webhookId,
        userId: redactId(userId),
        retryAfterSeconds: limits.blockSeconds,
      }, responseHeaders, 202, { 'Retry-After': String(limits.blockSeconds) });
    }
    const notifyUserLimitResult = await consumeWidgetRateLimit(
      client,
      'user',
      notifyUserScopeKey,
      limits.notifyUserPerMinute,
      limits.blockSeconds,
    );
    if (!notifyUserLimitResult.allowed) {
      await finishNotifyEvent(client, webhookId, 'rate-limited', userId, summaryCursor);
      logWidgetEvent('widget_push_dirty_dropped', { userId, webhookId, reason: 'notify-rate-limited', extra: { scope: 'user' } });
      return jsonResponse({
        status: 'skipped',
        reason: 'notify-rate-limited',
        webhookId,
        userId: redactId(userId),
        retryAfterSeconds: notifyUserLimitResult.retryAfterSeconds,
      }, responseHeaders, 202, { 'Retry-After': String(notifyUserLimitResult.retryAfterSeconds) });
    }

    if (usesStandardWebhookHeaders) {
      const ip = getClientIp(req);
      const notifyIpScopeKey = await sha256Hex(`widget-notify:${ip}`);
      if (limits.notifyIpPerMinute === 0) {
        await finishNotifyEvent(client, webhookId, 'rate-limited', userId, summaryCursor);
        logWidgetEvent('widget_push_dirty_dropped', { userId, webhookId, reason: 'notify-rate-limited', extra: { scope: 'ip-zero' } });
        return jsonResponse({
          status: 'skipped',
          reason: 'notify-rate-limited',
          webhookId,
          userId: redactId(userId),
          retryAfterSeconds: limits.blockSeconds,
        }, responseHeaders, 202, { 'Retry-After': String(limits.blockSeconds) });
      }

      const ipLimitResult = await consumeWidgetRateLimit(
        client,
        'ip',
        notifyIpScopeKey,
        limits.notifyIpPerMinute,
        limits.blockSeconds,
      );
      if (!ipLimitResult.allowed) {
        await finishNotifyEvent(client, webhookId, 'rate-limited', userId, summaryCursor);
        logWidgetEvent('widget_push_dirty_dropped', { userId, webhookId, reason: 'notify-rate-limited', extra: { scope: 'ip' } });
        return jsonResponse({
          status: 'skipped',
          reason: 'notify-rate-limited',
          webhookId,
          userId: redactId(userId),
          retryAfterSeconds: ipLimitResult.retryAfterSeconds,
        }, responseHeaders, 202, { 'Retry-After': String(ipLimitResult.retryAfterSeconds) });
      }
    }

    await upsertNotifyThrottle(client, userId, webhookId, summaryCursor, nowIso);

    const serviceAccount = loadFcmServiceAccount();
    if (!serviceAccount) {
      // 理论上不会到达此分支：上方 hasConfiguredPushProvider 已校验；防御性回退到 dry-run。
      // 注入后若仍触发，多为 isolate 冷启动缓存了旧环境变量，需要重部署。
      const envDiag = {
        hasProjectId: Boolean(Deno.env.get('FCM_PROJECT_ID')?.trim()),
        hasClientEmail: Boolean(Deno.env.get('FCM_CLIENT_EMAIL')?.trim()),
        hasPrivateKey: Boolean(Deno.env.get('FCM_PRIVATE_KEY')?.trim()),
      };
      await finishNotifyEvent(client, webhookId, 'accepted-dry-run', userId, summaryCursor);
      logWidgetEvent('widget_push_dirty_sent', {
        userId,
        webhookId,
        eligibleDeviceCount: eligibleDevices.length,
        extra: { deliveryMode: 'dry-run', reason: 'service-account-missing', ...envDiag },
      });
      return jsonResponse({
        status: 'accepted',
        deliveryMode: 'dry-run',
        webhookId,
        userId: redactId(userId),
        eligibleDeviceCount: eligibleDevices.length,
      }, responseHeaders, 202);
    }

    let accessToken: string;
    try {
      accessToken = await getFcmAccessToken(serviceAccount);
    } catch (tokenError) {
      await finishNotifyEvent(client, webhookId, 'fanout-failed', userId, summaryCursor);
      logWidgetEvent('widget_push_dirty_dropped', {
        userId,
        webhookId,
        reason: 'push-provider-unavailable',
        extra: {
          deliveryMode: 'fcm-v1',
          phase: 'oauth-token',
          message: tokenError instanceof Error ? tokenError.message.slice(0, 200) : 'unknown',
        },
      });
      return jsonResponse({
        status: 'skipped',
        reason: 'push-provider-unavailable',
        code: 'PUSH_PROVIDER_UNAVAILABLE',
        webhookId,
        userId: redactId(userId),
      }, responseHeaders, 202);
    }

    const fanoutResults = await Promise.all(
      eligibleDevices.map(async (device) => {
        const result = await sendFcmDataPush({
          account: serviceAccount,
          accessToken,
          deviceToken: device.push_token as string,
          data: {
            webhookId,
            type: 'widget_dirty',
            table: payload.table,
            eventType: payload.type,
            summaryCursor: summaryCursor ?? '',
            action: 'widget-refresh',
            // 2026-04-22 颠覆性压缩：专注态乐观 hint。当表为 focus_sessions 时，端上可在
            // summary fetch 完成前先用这两个字段把专注按钮/图标翻过来，感知延迟从 ~8s 压到 <1s。
            ...(focusHint
              ? { focusActiveHint: focusHint.active, focusSessionHint: focusHint.sessionId }
              : {}),
          },
        });
        return { device, result };
      }),
    );

    // 清理失效 token：unregistered / invalid-token 触发 push_token 置空。
    const invalidDeviceIds = fanoutResults
      .filter(({ result }) => !result.ok && (result.failure === 'unregistered' || result.failure === 'invalid-token'))
      .map(({ device }) => device.id);
    if (invalidDeviceIds.length > 0) {
      const { error: clearTokenError } = await client
        .from('widget_devices')
        .update({ push_token: null })
        .in('id', invalidDeviceIds);
      if (clearTokenError) {
        console.error('widget-notify invalidate push_token failed', clearTokenError);
      }
    }

    const successCount = fanoutResults.filter(({ result }) => result.ok).length;
    const failureByReason = fanoutResults.reduce<Record<string, number>>((acc, { result }) => {
      if (!result.ok) {
        const key = result.failure ?? 'provider-error';
        acc[key] = (acc[key] ?? 0) + 1;
      }
      return acc;
    }, {});
    const failureByReasonJson = JSON.stringify(failureByReason);

    const anySuccess = successCount > 0;
    const finalStatus: WidgetNotifyStatus = anySuccess ? 'accepted-fanout' : 'fanout-failed';
    await finishNotifyEvent(client, webhookId, finalStatus, userId, summaryCursor);

    if (anySuccess) {
      logWidgetEvent('widget_push_dirty_sent', {
        userId,
        webhookId,
        eligibleDeviceCount: eligibleDevices.length,
        extra: {
          deliveryMode: 'fcm-v1',
          successCount,
          failureCount: eligibleDevices.length - successCount,
          invalidatedTokenCount: invalidDeviceIds.length,
          suppressedDeviceCount: suppressedDecisions.length,
          failureByReasonJson,
        },
      });
      return jsonResponse({
        status: 'accepted',
        deliveryMode: 'fcm-v1',
        webhookId,
        userId: redactId(userId),
        eligibleDeviceCount: eligibleDevices.length,
        successCount,
        failureCount: eligibleDevices.length - successCount,
      }, responseHeaders, 202);
    }

    logWidgetEvent('widget_push_dirty_dropped', {
      userId,
      webhookId,
      reason: 'push-provider-unavailable',
      extra: {
        deliveryMode: 'fcm-v1',
        failureByReasonJson,
        eligibleDeviceCount: eligibleDevices.length,
        suppressedDeviceCount: suppressedDecisions.length,
      },
    });
    return jsonResponse({
      status: 'skipped',
      reason: 'fanout-failed',
      code: 'PUSH_PROVIDER_UNAVAILABLE',
      webhookId,
      userId: redactId(userId),
      failureByReason,
    }, responseHeaders, 202);
  } catch (error) {
    try {
      await finishNotifyEvent(client, webhookId, 'internal-error', userId, summaryCursor);
    } catch (finishError) {
      console.error('widget-notify failed-state persist failed', {
        webhookId,
        userId: redactId(userId),
        error: finishError instanceof Error ? finishError.message : String(finishError),
      });
    }
    console.error('widget-notify failed', {
      webhookId,
      userId: redactId(userId),
      error: error instanceof Error ? error.message : String(error),
    });
    return jsonResponse({ error: 'Internal webhook processing error', code: 'INTERNAL_ERROR' }, responseHeaders, 500);
  }
});
