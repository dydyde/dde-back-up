import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

import {
  createServiceRoleClient,
  getBearerToken,
  getCorsHeaders,
  isUuidLike,
  jsonResponse,
  parseWidgetToken,
  redactId,
  sha256Hex,
  withPrivateNoStoreHeaders,
} from '../_shared/widget-common.ts';
import {
  completeFrontTask,
  promoteSecondaryTaskToC2,
  suspendFrontTask,
} from './focus-reorder.ts';

interface WidgetDeviceRow {
  id: string;
  user_id: string;
  secret_hash: string;
  token_hash: string | null;
  binding_generation: number;
  revoked_at: string | null;
  expires_at: string;
}

interface FocusSessionRow {
  id: string;
  user_id: string;
  started_at: string;
  ended_at: string | null;
  session_state: unknown;
  updated_at: string;
}

interface RequestBody {
  action?: string;
  taskId?: string;
  waitMinutes?: number;
}

type SupabaseAdminClient = ReturnType<typeof createServiceRoleClient>;

const WIDGET_DEVICE_SELECT = 'id,user_id,secret_hash,token_hash,binding_generation,revoked_at,expires_at';
const FOCUS_SESSION_SELECT = 'id,user_id,started_at,ended_at,session_state,updated_at';
const FRONT_ACTIONS = new Set(['complete-front', 'wait-front']);

function errorResponse(
  headers: Record<string, string>,
  status: number,
  code: string,
  error: string,
): Response {
  return jsonResponse({ ok: false, code, error }, headers, status);
}

async function loadDevice(
  client: SupabaseAdminClient,
  rawToken: string,
): Promise<WidgetDeviceRow | null> {
  const tokenHash = await sha256Hex(rawToken);
  const byHash = await client
    .from('widget_devices')
    .select(WIDGET_DEVICE_SELECT)
    .eq('token_hash', tokenHash)
    .maybeSingle();
  if (byHash.error) {
    throw new Error(`load widget device by token_hash failed: ${byHash.error.message}`);
  }
  if (byHash.data) return byHash.data as WidgetDeviceRow;

  const parsed = parseWidgetToken(rawToken);
  if (!parsed) return null;

  const byId = await client
    .from('widget_devices')
    .select(WIDGET_DEVICE_SELECT)
    .eq('id', parsed.deviceId)
    .maybeSingle();
  if (byId.error) {
    throw new Error(`load widget device by id failed: ${byId.error.message}`);
  }
  const row = byId.data as WidgetDeviceRow | null;
  if (!row) return null;
  if (row.token_hash) return null;

  if (row.binding_generation !== parsed.bindingGeneration) return null;
  const secretHash = await sha256Hex(parsed.secret);
  if (secretHash !== row.secret_hash) return null;
  return row;
}

async function loadLatestActiveFocusSession(
  client: SupabaseAdminClient,
  userId: string,
): Promise<FocusSessionRow | null> {
  const result = await client
    .from('focus_sessions')
    .select(FOCUS_SESSION_SELECT)
    .eq('user_id', userId)
    .is('ended_at', null)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (result.error) {
    throw new Error(`load focus session failed: ${result.error.message}`);
  }
  return result.data as FocusSessionRow | null;
}

async function maybePatchOwnedTask(
  client: SupabaseAdminClient,
  userId: string,
  taskId: string | null | undefined,
  patch: Record<string, unknown>,
): Promise<void> {
  if (!taskId) return;

  const taskResult = await client
    .from('tasks')
    .select('id,project_id')
    .eq('id', taskId)
    .maybeSingle();
  if (taskResult.error) {
    throw new Error(`load task failed: ${taskResult.error.message}`);
  }
  const taskRow = taskResult.data as { id: string; project_id: string } | null;
  if (!taskRow) return;

  const projectResult = await client
    .from('projects')
    .select('id')
    .eq('id', taskRow.project_id)
    .eq('owner_id', userId)
    .maybeSingle();
  if (projectResult.error) {
    throw new Error(`load task owner project failed: ${projectResult.error.message}`);
  }
  if (!projectResult.data) return;

  const update = await client
    .from('tasks')
    .update(patch)
    .eq('id', taskId)
    .eq('project_id', taskRow.project_id);
  if (update.error) {
    throw new Error(`patch task failed: ${update.error.message}`);
  }
}

function readOptionalStringField(source: unknown, key: string): string | null {
  if (typeof source !== 'object' || source === null || Array.isArray(source)) {
    return null;
  }

  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

function actionErrorStatus(code: string): number {
  if (code === 'SECONDARY_TASK_NOT_FOUND' || code === 'FOCUS_TARGET_NOT_FOUND') return 404;
  if (code === 'INVALID_WAIT_MINUTES' || code === 'INVALID_SESSION_STATE') return 400;
  return 409;
}

async function handleRequest(req: Request): Promise<Response> {
  const corsHeaders = getCorsHeaders(req.headers.get('Origin'), 'POST, OPTIONS');
  const responseHeaders = withPrivateNoStoreHeaders(corsHeaders);

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: responseHeaders });
  }

  if (req.method !== 'POST') {
    return errorResponse(responseHeaders, 405, 'METHOD_NOT_ALLOWED', 'Only POST is supported');
  }

  const token = getBearerToken(req);
  if (!token) {
    return errorResponse(responseHeaders, 401, 'AUTH_REQUIRED', 'Missing widget bearer token');
  }

  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return errorResponse(responseHeaders, 400, 'INVALID_BODY', 'Request body must be valid JSON');
  }

  const action = body.action;
  const requestedTaskId = typeof body.taskId === 'string' ? body.taskId : undefined;
  const requestedWaitMinutes = typeof body.waitMinutes === 'number'
    ? Math.floor(body.waitMinutes)
    : undefined;
  if (action !== 'promote-secondary' && !FRONT_ACTIONS.has(action ?? '')) {
    return errorResponse(
      responseHeaders,
      400,
      'INVALID_ACTION',
      "action must be 'promote-secondary', 'complete-front', or 'wait-front'",
    );
  }
  if (action === 'promote-secondary') {
    if (!isUuidLike(requestedTaskId)) {
      return errorResponse(responseHeaders, 400, 'INVALID_TASK_ID', 'taskId must be a UUID');
    }
  } else if (requestedTaskId !== undefined && !isUuidLike(requestedTaskId)) {
    return errorResponse(responseHeaders, 400, 'INVALID_TASK_ID', 'taskId must be a UUID');
  }
  if (
    action === 'wait-front'
    && (requestedWaitMinutes === undefined || requestedWaitMinutes <= 0)
  ) {
    return errorResponse(responseHeaders, 400, 'INVALID_WAIT_MINUTES', 'waitMinutes must be a positive number');
  }

  const client = createServiceRoleClient();
  let device: WidgetDeviceRow | null = null;
  try {
    device = await loadDevice(client, token);
  } catch (error) {
    console.error('[widget-focus-action] load device failed', error);
    return errorResponse(responseHeaders, 500, 'DEVICE_LOOKUP_FAILED', 'Failed to verify widget token');
  }

  if (!device) {
    return errorResponse(responseHeaders, 401, 'TOKEN_INVALID', 'Widget token is invalid');
  }
  if (device.revoked_at) {
    return errorResponse(responseHeaders, 401, 'DEVICE_REVOKED', 'Widget binding has been revoked');
  }
  if (new Date(device.expires_at).getTime() <= Date.now()) {
    return errorResponse(responseHeaders, 401, 'TOKEN_EXPIRED', 'Widget token has expired');
  }

  let session: FocusSessionRow | null = null;
  try {
    session = await loadLatestActiveFocusSession(client, device.user_id);
  } catch (error) {
    console.error('[widget-focus-action] load focus session failed', error);
    return errorResponse(responseHeaders, 500, 'FOCUS_SESSION_LOOKUP_FAILED', 'Failed to load focus session');
  }
  if (!session) {
    return errorResponse(responseHeaders, 404, 'ACTIVE_FOCUS_SESSION_NOT_FOUND', 'No active focus session found');
  }

  const nowIso = new Date().toISOString();
  const actionResult = (() => {
    if (action === 'promote-secondary') {
      if (requestedTaskId === undefined) {
        return { ok: false, code: 'INVALID_TASK_ID', error: 'taskId must be a UUID' } as const;
      }
      const promoteTaskId = requestedTaskId as string;
      return promoteSecondaryTaskToC2(session.session_state, promoteTaskId, nowIso);
    }

    if (action === 'complete-front') {
      return completeFrontTask(session.session_state, requestedTaskId, nowIso);
    }

    if (requestedWaitMinutes === undefined) {
      return { ok: false, code: 'INVALID_WAIT_MINUTES', error: 'waitMinutes must be a positive number' } as const;
    }

    const waitMinutes = requestedWaitMinutes as number;
    return suspendFrontTask(session.session_state, requestedTaskId, waitMinutes, nowIso);
  })();
  if (!actionResult.ok) {
    return errorResponse(responseHeaders, actionErrorStatus(actionResult.code), actionResult.code, actionResult.error);
  }

  const update = await client
    .from('focus_sessions')
    .update({
      session_state: actionResult.snapshot,
      updated_at: nowIso,
    })
    .eq('id', session.id)
    .eq('user_id', device.user_id)
    .eq('updated_at', session.updated_at)
    .is('ended_at', null)
    .select('id,updated_at')
    .maybeSingle();

  if (update.error) {
    console.error('[widget-focus-action] update failed', update.error);
    return errorResponse(responseHeaders, 500, 'UPDATE_FAILED', 'Failed to update focus session');
  }
  if (!update.data) {
    return errorResponse(responseHeaders, 409, 'FOCUS_SESSION_CHANGED', 'Focus session changed before update');
  }

  const completedTaskId = readOptionalStringField(actionResult, 'completedTaskId');
  const suspendedTaskId = readOptionalStringField(actionResult, 'suspendedTaskId');

  try {
    if (completedTaskId) {
      await maybePatchOwnedTask(client, device.user_id, completedTaskId, {
        status: 'completed',
        wait_minutes: null,
        updated_at: nowIso,
      });
    } else if (suspendedTaskId) {
      await maybePatchOwnedTask(client, device.user_id, suspendedTaskId, {
        wait_minutes: requestedWaitMinutes,
        updated_at: nowIso,
      });
    }
  } catch (error) {
    console.warn('[widget-focus-action] task patch skipped', {
      action,
      taskId: redactId(
        completedTaskId
        ?? suspendedTaskId
        ?? body.taskId
        ?? null,
      ),
      message: error instanceof Error ? error.message : String(error),
    });
  }

  console.log('[widget-focus-action]', JSON.stringify({
    event: `widget_focus_${action}_success`,
    deviceId: redactId(device.id),
    userId: redactId(device.user_id),
    sessionId: redactId(session.id),
    taskId: redactId(body.taskId),
    completedTaskId: redactId(completedTaskId),
    suspendedTaskId: redactId(suspendedTaskId),
    mainTaskId: redactId(actionResult.mainTaskId),
    comboCount: actionResult.comboSelectIds.length,
    backupCount: actionResult.backupIds.length,
    updatedAt: update.data.updated_at,
  }));

  const responseTaskId =
    completedTaskId
    ?? suspendedTaskId
    ?? body.taskId
    ?? null;

  return jsonResponse(
    {
      ok: true,
      action,
      taskId: responseTaskId,
      mainTaskId: actionResult.mainTaskId,
      comboSelectIds: actionResult.comboSelectIds,
      backupIds: actionResult.backupIds,
      ...('waitEndAt' in actionResult && actionResult.waitEndAt ? { waitEndAt: actionResult.waitEndAt } : {}),
      updatedAt: update.data.updated_at,
    },
    responseHeaders,
    200,
  );
}

Deno.serve(async (req) => {
  try {
    return await handleRequest(req);
  } catch (error) {
    console.error('[widget-focus-action] unhandled', error);
    const corsHeaders = getCorsHeaders(req.headers.get('Origin'), 'POST, OPTIONS');
    const responseHeaders = withPrivateNoStoreHeaders(corsHeaders);
    return errorResponse(responseHeaders, 500, 'INTERNAL_ERROR', 'Unexpected error');
  }
});
