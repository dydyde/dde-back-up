-- =============================================================================
-- P0 同步问题修复 —— 非 task 实体（connection / blackbox / project）+ 批量删除
-- 的陈旧写保护（沿用 0512 在 batch_upsert_tasks 上验证过的同源修复模型）
-- =============================================================================
--
-- 背景：
-- 2026-05-12 `20260512050000_batch_upsert_tasks_stale_write_protection.sql` 只把
-- 陈旧写保护套用到 `batch_upsert_tasks`（task 路径）。2026-05-13 `sync_rpc_lww_restore`
-- 在 LWW 语义回滚中，对 connection / blackbox / project 三个 upsert RPC 仍使用
-- `ON CONFLICT … SET … = EXCLUDED.*` 无条件覆盖，并未引入 stale guard；
-- `sync_delete_tasks` 在 0430 引入后**仅有 idempotency 与 protocol fence**，
-- 没有"本地 base_updated_at vs 服务端 existing.updated_at"校验。
--
-- 风险模型与"待分配块"事件完全同构：RetryQueue 在 IndexedDB 持久化的陈旧 payload，
-- 在网络恢复 / 下次 drain 时被无差别 apply：
-- - R1 sync_upsert_connection：陈旧 source_id/target_id/deleted_at 可洗白真实连线，
--   或把已删连线 "复活"（且 connections 表当时**没有挂** prevent_soft_deleted_row_resurrection 触发器）；
-- - R2 sync_upsert_blackbox_entry：陈旧 is_completed/is_archived/is_read/snooze_*/
--   deleted_at/focus_meta/project_id 把已完成 / 已读 / 已归档 / 已删 entry 倒退；
-- - R3 sync_upsert_project：陈旧 title/description/version/migrated_to_v2 覆盖最新元数据；
-- - R4 sync_delete_tasks：陈旧 delete payload 物理 purge 已被改 stage / 重激活的 task
--   （并 cascade 删除 attachments，破坏性极大）。
--
-- 修复策略（最小侵入、与 0512 对称、不重新引入 CAS 抖动）：
-- 1. 在每个 upsert RPC 内，于 advisory lock + 现有 ownership 检查之后，
--    `SELECT … FOR UPDATE` 抓取 existing 关键身份/状态字段；
-- 2. 用 `payload.updated_at` 与 `existing.updated_at` 比对，
--    `existing > payload + 1s skew` 即判定为陈旧；
-- 3. `ON CONFLICT DO UPDATE SET` 里对身份/状态字段使用 `CASE WHEN v_is_stale`
--    保留 existing 值；UI/文本字段继续 LWW（与 0512 对称）；
-- 4. `sync_delete_tasks` 接受可选 `base_updated_at_map: {task_id: timestamp}`：
--    服务端对每个 task 取 existing.updated_at，凡 `existing > base + 1s` 的
--    task_id 从删除集合中剔除，写入 result.`skipped_ids`；客户端据此重排队
--    （走 pull+merge 路径），不阻塞其余任务的删除；
-- 5. 给 connections 表挂 `trg_prevent_connection_resurrection`（复用 0511 的
--    `public.prevent_soft_deleted_row_resurrection()`），作为防止 deleted_at
--    被陈旧 payload 改回 NULL 的二级护栏（与 projects / black_box_entries 对齐）。
--
-- 兼容性：payload 不携带 `updated_at` 时 v_is_stale 自动收敛到 FALSE，
-- 走原 LWW 行为，与 0509 / 0513 完全兼容，不需要前端先发版。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- R1: sync_upsert_connection —— stale guard on source_id / target_id / deleted_at
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_upsert_connection(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_op_id UUID := (payload->>'operation_id')::UUID;
  v_protocol INTEGER := COALESCE((payload->>'protocol_version')::INTEGER, 0);
  v_local_updated TIMESTAMPTZ := public.sync_extract_local_updated(payload, 'connection');
  v_client_epoch BIGINT := COALESCE((payload->>'deployment_epoch')::BIGINT, 0);
  v_deployment_target TEXT := payload->>'deployment_target';
  v_client_git TEXT := payload->>'client_git_sha';
  v_client_origin TEXT := payload->>'client_origin';
  v_conn JSONB := payload->'connection';
  v_local_deleted TIMESTAMPTZ := NULLIF(payload->'connection'->>'deleted_at', '')::TIMESTAMPTZ;
  v_conn_id UUID := (v_conn->>'id')::UUID;
  v_project_id UUID := (v_conn->>'project_id')::UUID;
  v_min_protocol INTEGER;
  v_min_epoch BIGINT;
  v_local_freshness TIMESTAMPTZ;
  v_same_id_tombstone_deleted TIMESTAMPTZ;
  v_endpoint_tombstone_deleted TIMESTAMPTZ;
  v_existing_owner UUID;
  v_existing_project_id UUID;
  v_existing_updated TIMESTAMPTZ;
  v_existing_source UUID;
  v_existing_target UUID;
  v_existing_deleted TIMESTAMPTZ;
  v_is_stale BOOLEAN;
  v_skew_grace CONSTANT INTERVAL := INTERVAL '1 second';
  v_log_existing RECORD;
  v_result JSONB;
  v_written_updated TIMESTAMPTZ;
BEGIN
  IF v_user IS NULL OR v_op_id IS NULL OR v_conn_id IS NULL OR v_project_id IS NULL THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'missing required fields');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('sync_upsert_connection'), hashtext(v_conn_id::TEXT));

  SELECT user_id, result_payload, status, reject_reason
    INTO v_log_existing
    FROM public.sync_operation_log
    WHERE operation_id = v_op_id;
  IF FOUND THEN
    IF v_log_existing.user_id <> v_user THEN
      RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'operation_id owned by other user');
    END IF;
    RETURN COALESCE(
      v_log_existing.result_payload,
      jsonb_build_object('status', v_log_existing.status, 'reason', v_log_existing.reject_reason)
    );
  END IF;

  SELECT min_protocol_version, deployment_epoch INTO v_min_protocol, v_min_epoch
    FROM public.sync_protocol_state WHERE scope = 'global';
  IF v_protocol < COALESCE(v_min_protocol, 1) OR v_client_epoch < COALESCE(v_min_epoch, 0) THEN
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin)
    VALUES (v_op_id, v_user, 'connection', v_conn_id, 'client-version-rejected',
      CASE
        WHEN v_protocol < COALESCE(v_min_protocol, 1) THEN 'protocol_version_below_min'
        ELSE 'deployment_epoch_below_min'
      END,
      v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin);
    RETURN jsonb_build_object(
      'status', 'client-version-rejected',
      'minProtocolVersion', v_min_protocol,
      'deploymentEpoch', COALESCE(v_min_epoch, 0)
    );
  END IF;

  SELECT p.owner_id INTO v_existing_owner FROM public.projects p WHERE p.id = v_project_id;
  IF v_existing_owner IS DISTINCT FROM v_user THEN
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin)
    VALUES (v_op_id, v_user, 'connection', v_conn_id, 'unauthorized',
      'project_not_owned', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin);
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'project_not_owned');
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.tasks source_task
    JOIN public.tasks target_task ON target_task.id = (v_conn->>'target_id')::UUID
    WHERE source_task.id = (v_conn->>'source_id')::UUID
      AND source_task.project_id = v_project_id
      AND target_task.project_id = v_project_id
      AND source_task.deleted_at IS NULL
      AND target_task.deleted_at IS NULL
  ) THEN
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin)
    VALUES (v_op_id, v_user, 'connection', v_conn_id, 'unauthorized',
      'connection_endpoint_not_in_project', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin);
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'connection_endpoint_not_in_project');
  END IF;

  v_local_freshness := GREATEST(
    COALESCE(v_local_updated, '-infinity'::TIMESTAMPTZ),
    COALESCE(v_local_deleted, '-infinity'::TIMESTAMPTZ)
  );

  SELECT ct.deleted_at INTO v_same_id_tombstone_deleted
    FROM public.connection_tombstones ct
    WHERE ct.connection_id = v_conn_id
    LIMIT 1;

  IF v_same_id_tombstone_deleted IS NOT NULL THEN
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin)
    VALUES (v_op_id, v_user, 'connection', v_conn_id, 'remote-newer',
      'connection_tombstone', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin);
    RETURN jsonb_build_object(
      'status', 'remote-newer',
      'remote_updated_at', v_same_id_tombstone_deleted,
      'reason', 'connection_tombstone'
    );
  END IF;

  SELECT ct.deleted_at INTO v_endpoint_tombstone_deleted
    FROM public.connection_tombstones ct
    WHERE ct.project_id = v_project_id
      AND ct.source_id = (v_conn->>'source_id')::UUID
      AND ct.target_id = (v_conn->>'target_id')::UUID
    ORDER BY ct.deleted_at DESC
    LIMIT 1;

  IF v_endpoint_tombstone_deleted IS NOT NULL AND v_endpoint_tombstone_deleted >= v_local_freshness THEN
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin)
    VALUES (v_op_id, v_user, 'connection', v_conn_id, 'remote-newer',
      'endpoint_tombstone', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin);
    RETURN jsonb_build_object(
      'status', 'remote-newer',
      'remote_updated_at', v_endpoint_tombstone_deleted,
      'reason', 'endpoint_tombstone'
    );
  END IF;

  SELECT ct.deleted_at INTO v_endpoint_tombstone_deleted
    FROM public.connection_tombstones ct
    WHERE ct.project_id = v_project_id
      AND ct.source_id IS NULL
      AND ct.target_id IS NULL
    ORDER BY ct.deleted_at DESC
    LIMIT 1;

  IF v_endpoint_tombstone_deleted IS NOT NULL AND v_endpoint_tombstone_deleted >= v_local_freshness THEN
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin)
    VALUES (v_op_id, v_user, 'connection', v_conn_id, 'remote-newer',
      'legacy_endpointless_tombstone', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin);
    RETURN jsonb_build_object(
      'status', 'remote-newer',
      'remote_updated_at', v_endpoint_tombstone_deleted,
      'reason', 'legacy_endpointless_tombstone'
    );
  END IF;

  -- 抓取 existing 行（包括身份/状态字段），用于陈旧写判定
  SELECT c.project_id, p.owner_id, c.updated_at, c.source_id, c.target_id, c.deleted_at
    INTO v_existing_project_id, v_existing_owner, v_existing_updated, v_existing_source, v_existing_target, v_existing_deleted
    FROM public.connections c
    JOIN public.projects p ON p.id = c.project_id
    WHERE c.id = v_conn_id
    FOR UPDATE;

  IF v_existing_project_id IS NOT NULL
    AND (v_existing_project_id <> v_project_id OR v_existing_owner IS DISTINCT FROM v_user)
  THEN
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin)
    VALUES (v_op_id, v_user, 'connection', v_conn_id, 'unauthorized',
      'connection_owned_by_other_project', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin);
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'connection_owned_by_other_project');
  END IF;

  -- 陈旧写判定：payload.updated_at 比 existing.updated_at 早超过 1s（与 0512 对齐）
  v_is_stale := COALESCE(
    v_existing_updated IS NOT NULL
      AND v_local_updated IS NOT NULL
      AND v_existing_updated > v_local_updated + v_skew_grace,
    FALSE
  );

  INSERT INTO public.connections AS c (id, project_id, source_id, target_id, title, description, deleted_at, updated_at)
  VALUES (
    v_conn_id,
    v_project_id,
    (v_conn->>'source_id')::UUID,
    (v_conn->>'target_id')::UUID,
    NULLIF(v_conn->>'title', ''),
    NULLIF(v_conn->>'description', ''),
    NULLIF(v_conn->>'deleted_at', '')::TIMESTAMPTZ,
    NOW()
  )
  ON CONFLICT (id) DO UPDATE
    -- 身份/删除态字段：陈旧 payload 不得洗白
    SET source_id = CASE WHEN v_is_stale THEN v_existing_source ELSE EXCLUDED.source_id END,
        target_id = CASE WHEN v_is_stale THEN v_existing_target ELSE EXCLUDED.target_id END,
        deleted_at = CASE WHEN v_is_stale THEN v_existing_deleted ELSE EXCLUDED.deleted_at END,
        -- 文本字段：LWW，影响有限可接受陈旧覆盖
        title = EXCLUDED.title,
        description = EXCLUDED.description,
        -- updated_at 始终 NOW()，保证 Lamport-clock 单调，便于下游 incremental pull 识别
        updated_at = NOW()
  RETURNING c.updated_at INTO v_written_updated;

  v_result := jsonb_build_object(
    'status', 'applied',
    'operation_id', v_op_id,
    'connection_id', v_conn_id,
    'updated_at', v_written_updated,
    'stale_payload', v_is_stale
  );

  INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
    status, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin, result_payload)
  VALUES (v_op_id, v_user, 'connection', v_conn_id, 'applied',
    v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin, v_result);

  RETURN v_result;
END;
$$;

-- -----------------------------------------------------------------------------
-- R2: sync_upsert_blackbox_entry —— stale guard on state/state-machine fields
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_upsert_blackbox_entry(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_op_id UUID := (payload->>'operation_id')::UUID;
  v_protocol INTEGER := COALESCE((payload->>'protocol_version')::INTEGER, 0);
  v_local_updated TIMESTAMPTZ := public.sync_extract_local_updated(payload, 'entry');
  v_client_epoch BIGINT := COALESCE((payload->>'deployment_epoch')::BIGINT, 0);
  v_deployment_target TEXT := payload->>'deployment_target';
  v_client_git TEXT := payload->>'client_git_sha';
  v_client_origin TEXT := payload->>'client_origin';
  v_entry JSONB := payload->'entry';
  v_entry_id UUID := (v_entry->>'id')::UUID;
  v_project_id UUID := NULLIF(v_entry->>'project_id', '')::UUID;
  v_min_protocol INTEGER;
  v_min_epoch BIGINT;
  v_existing_owner UUID;
  v_existing_exists BOOLEAN := FALSE;
  v_existing_updated TIMESTAMPTZ;
  v_existing_project UUID;
  v_existing_is_read BOOLEAN;
  v_existing_is_completed BOOLEAN;
  v_existing_is_archived BOOLEAN;
  v_existing_snooze_until TIMESTAMPTZ;
  v_existing_snooze_count INTEGER;
  v_existing_deleted TIMESTAMPTZ;
  v_existing_focus_meta JSONB;
  v_is_stale BOOLEAN;
  v_skew_grace CONSTANT INTERVAL := INTERVAL '1 second';
  v_log_existing RECORD;
  v_result JSONB;
  v_written_updated TIMESTAMPTZ;
BEGIN
  IF v_user IS NULL OR v_op_id IS NULL OR v_entry_id IS NULL THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'missing required fields');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('sync_upsert_blackbox_entry'), hashtext(v_entry_id::TEXT));

  SELECT user_id, result_payload, status, reject_reason
    INTO v_log_existing
    FROM public.sync_operation_log
    WHERE operation_id = v_op_id;
  IF FOUND THEN
    IF v_log_existing.user_id <> v_user THEN
      RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'operation_id owned by other user');
    END IF;
    RETURN COALESCE(
      v_log_existing.result_payload,
      jsonb_build_object('status', v_log_existing.status, 'reason', v_log_existing.reject_reason)
    );
  END IF;

  SELECT min_protocol_version, deployment_epoch INTO v_min_protocol, v_min_epoch
    FROM public.sync_protocol_state WHERE scope = 'global';
  IF v_protocol < COALESCE(v_min_protocol, 1) OR v_client_epoch < COALESCE(v_min_epoch, 0) THEN
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin)
    VALUES (v_op_id, v_user, 'blackbox', v_entry_id, 'client-version-rejected',
      CASE
        WHEN v_protocol < COALESCE(v_min_protocol, 1) THEN 'protocol_version_below_min'
        ELSE 'deployment_epoch_below_min'
      END,
      v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin);
    RETURN jsonb_build_object(
      'status', 'client-version-rejected',
      'minProtocolVersion', v_min_protocol,
      'deploymentEpoch', COALESCE(v_min_epoch, 0)
    );
  END IF;

  -- 抓取 existing 状态字段（行锁）用于陈旧写判定
  SELECT
      TRUE,
      b.user_id,
      b.updated_at,
      b.project_id,
      b.is_read,
      b.is_completed,
      b.is_archived,
      b.snooze_until,
      b.snooze_count,
      b.deleted_at,
      b.focus_meta
    INTO
      v_existing_exists,
      v_existing_owner,
      v_existing_updated,
      v_existing_project,
      v_existing_is_read,
      v_existing_is_completed,
      v_existing_is_archived,
      v_existing_snooze_until,
      v_existing_snooze_count,
      v_existing_deleted,
      v_existing_focus_meta
    FROM public.black_box_entries b
    WHERE b.id = v_entry_id
    FOR UPDATE;

  IF v_existing_exists AND v_existing_owner IS NOT NULL AND v_existing_owner <> v_user THEN
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin)
    VALUES (v_op_id, v_user, 'blackbox', v_entry_id, 'unauthorized',
      'entry_owned_by_other', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin);
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'entry_owned_by_other');
  END IF;

  IF v_project_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.projects p WHERE p.id = v_project_id AND p.owner_id = v_user
  ) THEN
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin)
    VALUES (v_op_id, v_user, 'blackbox', v_entry_id, 'unauthorized',
      'project_not_owned', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin);
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'project_not_owned');
  END IF;

  v_is_stale := COALESCE(
    v_existing_exists
      AND v_local_updated IS NOT NULL
      AND v_existing_updated IS NOT NULL
      AND v_existing_updated > v_local_updated + v_skew_grace,
    FALSE
  );

  INSERT INTO public.black_box_entries AS b (
    id,
    user_id,
    project_id,
    content,
    date,
    created_at,
    updated_at,
    is_read,
    is_completed,
    is_archived,
    snooze_until,
    snooze_count,
    deleted_at,
    focus_meta
  )
  VALUES (
    v_entry_id,
    v_user,
    v_project_id,
    v_entry->>'content',
    COALESCE(NULLIF(v_entry->>'date','')::DATE, CURRENT_DATE),
    COALESCE(NULLIF(v_entry->>'created_at','')::TIMESTAMPTZ, NOW()),
    NOW(),
    COALESCE((v_entry->>'is_read')::BOOLEAN, FALSE),
    COALESCE((v_entry->>'is_completed')::BOOLEAN, FALSE),
    COALESCE((v_entry->>'is_archived')::BOOLEAN, FALSE),
    NULLIF(v_entry->>'snooze_until','')::TIMESTAMPTZ,
    COALESCE((v_entry->>'snooze_count')::INTEGER, 0),
    NULLIF(v_entry->>'deleted_at','')::TIMESTAMPTZ,
    v_entry->'focus_meta'
  )
  ON CONFLICT (id) DO UPDATE
    -- 文本/日期字段：LWW；content 已有 prevent_black_box_content_loss 触发器额外保护
    SET content = EXCLUDED.content,
        date = EXCLUDED.date,
        -- 状态机字段：陈旧 payload 不得洗白
        project_id = CASE WHEN v_is_stale THEN v_existing_project ELSE EXCLUDED.project_id END,
        is_read = CASE WHEN v_is_stale THEN v_existing_is_read ELSE EXCLUDED.is_read END,
        is_completed = CASE WHEN v_is_stale THEN v_existing_is_completed ELSE EXCLUDED.is_completed END,
        is_archived = CASE WHEN v_is_stale THEN v_existing_is_archived ELSE EXCLUDED.is_archived END,
        snooze_until = CASE WHEN v_is_stale THEN v_existing_snooze_until ELSE EXCLUDED.snooze_until END,
        snooze_count = CASE WHEN v_is_stale THEN v_existing_snooze_count ELSE EXCLUDED.snooze_count END,
        deleted_at = CASE WHEN v_is_stale THEN v_existing_deleted ELSE EXCLUDED.deleted_at END,
        focus_meta = CASE WHEN v_is_stale THEN v_existing_focus_meta ELSE EXCLUDED.focus_meta END,
        updated_at = NOW()
  RETURNING b.updated_at INTO v_written_updated;

  v_result := jsonb_build_object(
    'status', 'applied',
    'operation_id', v_op_id,
    'entry_id', v_entry_id,
    'updated_at', v_written_updated,
    'stale_payload', v_is_stale
  );

  INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
    status, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin, result_payload)
  VALUES (v_op_id, v_user, 'blackbox', v_entry_id, 'applied',
    v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin, v_result);

  RETURN v_result;
END;
$$;

-- -----------------------------------------------------------------------------
-- R3: sync_upsert_project —— stale guard on title / description / version / migrated_to_v2
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_upsert_project(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_op_id UUID := (payload->>'operation_id')::UUID;
  v_protocol INTEGER := COALESCE((payload->>'protocol_version')::INTEGER, 0);
  v_local_updated TIMESTAMPTZ := public.sync_extract_local_updated(payload, 'project');
  v_client_epoch BIGINT := COALESCE((payload->>'deployment_epoch')::BIGINT, 0);
  v_deployment_target TEXT := payload->>'deployment_target';
  v_client_git TEXT := payload->>'client_git_sha';
  v_client_origin TEXT := payload->>'client_origin';
  v_project JSONB := payload->'project';
  v_project_id UUID := (v_project->>'id')::UUID;
  v_min_protocol INTEGER;
  v_min_epoch BIGINT;
  v_existing_owner UUID;
  v_existing_updated TIMESTAMPTZ;
  v_existing_deleted TIMESTAMPTZ;
  v_existing_title TEXT;
  v_existing_description TEXT;
  v_existing_version INTEGER;
  v_existing_migrated BOOLEAN;
  v_is_stale BOOLEAN;
  v_skew_grace CONSTANT INTERVAL := INTERVAL '1 second';
  v_log_existing RECORD;
  v_result JSONB;
  v_written_updated TIMESTAMPTZ;
BEGIN
  IF v_user IS NULL OR v_op_id IS NULL OR v_project_id IS NULL THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'missing required fields');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('sync_upsert_project'), hashtext(v_project_id::TEXT));

  SELECT user_id, result_payload, status, reject_reason
    INTO v_log_existing
    FROM public.sync_operation_log
    WHERE operation_id = v_op_id;
  IF FOUND THEN
    IF v_log_existing.user_id <> v_user THEN
      RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'operation_id owned by other user');
    END IF;
    RETURN COALESCE(
      v_log_existing.result_payload,
      jsonb_build_object('status', v_log_existing.status, 'reason', v_log_existing.reject_reason)
    );
  END IF;

  SELECT min_protocol_version, deployment_epoch INTO v_min_protocol, v_min_epoch
    FROM public.sync_protocol_state WHERE scope = 'global';
  IF v_protocol < COALESCE(v_min_protocol, 1) OR v_client_epoch < COALESCE(v_min_epoch, 0) THEN
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin)
    VALUES (v_op_id, v_user, 'project', v_project_id, 'client-version-rejected',
      CASE
        WHEN v_protocol < COALESCE(v_min_protocol, 1) THEN 'protocol_version_below_min'
        ELSE 'deployment_epoch_below_min'
      END,
      v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin);
    RETURN jsonb_build_object(
      'status', 'client-version-rejected',
      'minProtocolVersion', v_min_protocol,
      'deploymentEpoch', COALESCE(v_min_epoch, 0)
    );
  END IF;

  SELECT owner_id, updated_at, deleted_at, title, description, version, migrated_to_v2
    INTO v_existing_owner, v_existing_updated, v_existing_deleted,
         v_existing_title, v_existing_description, v_existing_version, v_existing_migrated
    FROM public.projects
    WHERE id = v_project_id
    FOR UPDATE;

  IF v_existing_owner IS NOT NULL AND v_existing_owner <> v_user THEN
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin)
    VALUES (v_op_id, v_user, 'project', v_project_id, 'unauthorized',
      'project_owned_by_other', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin);
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'project_owned_by_other');
  END IF;

  IF v_existing_deleted IS NOT NULL THEN
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin)
    VALUES (v_op_id, v_user, 'project', v_project_id, 'deleted-remote-newer',
      'remote_project_tombstone', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin);
    RETURN jsonb_build_object(
      'status', 'deleted-remote-newer',
      'remote_updated_at', COALESCE(v_existing_updated, v_existing_deleted),
      'reason', 'remote_project_tombstone'
    );
  END IF;

  -- 陈旧写判定（仅对 UPDATE 路径有意义；INSERT 路径下 v_existing_updated 为 NULL → FALSE）
  v_is_stale := COALESCE(
    v_existing_updated IS NOT NULL
      AND v_local_updated IS NOT NULL
      AND v_existing_updated > v_local_updated + v_skew_grace,
    FALSE
  );

  IF v_existing_updated IS NULL THEN
    INSERT INTO public.projects AS p (id, owner_id, title, description, version, migrated_to_v2, deleted_at, updated_at)
    VALUES (
      v_project_id,
      v_user,
      v_project->>'title',
      NULLIF(v_project->>'description', ''),
      COALESCE((v_project->>'version')::INTEGER, 1),
      COALESCE((v_project->>'migrated_to_v2')::BOOLEAN, TRUE),
      NULLIF(v_project->>'deleted_at', '')::TIMESTAMPTZ,
      NOW()
    )
    RETURNING p.updated_at INTO v_written_updated;
  ELSE
    UPDATE public.projects AS p
    SET title = CASE WHEN v_is_stale THEN v_existing_title ELSE v_project->>'title' END,
        description = CASE
          WHEN v_is_stale THEN v_existing_description
          ELSE NULLIF(v_project->>'description', '')
        END,
        version = CASE
          WHEN v_is_stale THEN COALESCE(v_existing_version, p.version, 1)
          ELSE COALESCE((v_project->>'version')::INTEGER, p.version, 1)
        END,
        migrated_to_v2 = CASE
          WHEN v_is_stale THEN COALESCE(v_existing_migrated, TRUE)
          ELSE COALESCE((v_project->>'migrated_to_v2')::BOOLEAN, TRUE)
        END,
        -- 陈旧 payload 不得修改 deleted_at（已删项目走 deleted-remote-newer 提前返回；
        -- 此处主要防止陈旧 payload 错误地把 alive 项目设为 deleted_at != NULL）
        deleted_at = CASE
          WHEN v_is_stale THEN v_existing_deleted
          ELSE NULLIF(v_project->>'deleted_at', '')::TIMESTAMPTZ
        END,
        updated_at = NOW()
    WHERE p.id = v_project_id
    RETURNING p.updated_at INTO v_written_updated;
  END IF;

  v_result := jsonb_build_object(
    'status', 'applied',
    'operation_id', v_op_id,
    'project_id', v_project_id,
    'updated_at', v_written_updated,
    'stale_payload', v_is_stale
  );

  INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
    status, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin, result_payload)
  VALUES (v_op_id, v_user, 'project', v_project_id, 'applied',
    v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin, v_result);

  RETURN v_result;
END;
$$;

-- -----------------------------------------------------------------------------
-- R4: sync_delete_tasks —— 接受 base_updated_at_map，对每个 task 做 stale 判定
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_delete_tasks(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_op_id UUID := (payload->>'operation_id')::UUID;
  v_protocol INTEGER := COALESCE((payload->>'protocol_version')::INTEGER, 0);
  v_client_epoch BIGINT := COALESCE((payload->>'deployment_epoch')::BIGINT, 0);
  v_deployment_target TEXT := payload->>'deployment_target';
  v_client_git TEXT := payload->>'client_git_sha';
  v_client_origin TEXT := payload->>'client_origin';
  v_project_id UUID := (payload->>'project_id')::UUID;
  v_delete_mode TEXT := COALESCE(NULLIF(payload->>'delete_mode', ''), 'purge');
  v_task_ids UUID[];
  v_base_map JSONB := payload->'base_updated_at_map';
  v_min_protocol INTEGER;
  v_min_epoch BIGINT;
  v_owner_id UUID;
  v_log_existing RECORD;
  v_result JSONB;
  v_deleted_count INTEGER;
  v_attachment_paths TEXT[];
  v_task_id UUID;
  v_existing_updated TIMESTAMPTZ;
  v_base_str TEXT;
  v_base_ts TIMESTAMPTZ;
  v_kept UUID[] := ARRAY[]::UUID[];
  v_skipped UUID[] := ARRAY[]::UUID[];
  v_skew_grace CONSTANT INTERVAL := INTERVAL '1 second';
BEGIN
  SELECT COALESCE(array_agg(task_id::UUID), ARRAY[]::UUID[])
    INTO v_task_ids
    FROM jsonb_array_elements_text(COALESCE(payload->'task_ids', '[]'::JSONB)) AS t(task_id);

  IF v_user IS NULL OR v_op_id IS NULL OR v_project_id IS NULL OR array_length(v_task_ids, 1) IS NULL THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'missing required fields');
  END IF;

  IF v_delete_mode NOT IN ('soft', 'purge') THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'invalid delete_mode');
  END IF;

  SELECT * INTO v_log_existing FROM public.sync_operation_log WHERE operation_id = v_op_id;
  IF FOUND THEN
    IF v_log_existing.user_id <> v_user THEN
      RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'operation_id owned by other user');
    END IF;
    RETURN COALESCE(
      v_log_existing.result_payload,
      jsonb_build_object('status', v_log_existing.status, 'reason', v_log_existing.reject_reason)
    );
  END IF;

  SELECT min_protocol_version, deployment_epoch INTO v_min_protocol, v_min_epoch
    FROM public.sync_protocol_state WHERE scope = 'global';
  IF v_protocol < COALESCE(v_min_protocol, 1) OR v_client_epoch < COALESCE(v_min_epoch, 0) THEN
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin)
    VALUES (v_op_id, v_user, 'task-delete', v_project_id, 'client-version-rejected',
      CASE
        WHEN v_protocol < COALESCE(v_min_protocol, 1) THEN 'protocol_version_below_min'
        ELSE 'deployment_epoch_below_min'
      END,
      v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin);
    RETURN jsonb_build_object(
      'status', 'client-version-rejected',
      'minProtocolVersion', v_min_protocol,
      'deploymentEpoch', COALESCE(v_min_epoch, 0)
    );
  END IF;

  SELECT owner_id INTO v_owner_id
    FROM public.projects
    WHERE id = v_project_id
      AND owner_id = v_user;

  IF v_owner_id IS NULL THEN
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin)
    VALUES (v_op_id, v_user, 'task-delete', v_project_id, 'unauthorized',
      'project_not_owned', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin);
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'project_not_owned');
  END IF;

  -- 当 payload 携带 base_updated_at_map 时，对每个 task 做 stale 判定，剔除"已被远端更新"的 task
  IF v_base_map IS NOT NULL AND jsonb_typeof(v_base_map) = 'object' THEN
    FOREACH v_task_id IN ARRAY v_task_ids
    LOOP
      SELECT t.updated_at
        INTO v_existing_updated
        FROM public.tasks t
        WHERE t.id = v_task_id
          AND t.project_id = v_project_id
        FOR UPDATE;

      v_base_str := v_base_map->>(v_task_id::TEXT);
      v_base_ts := NULLIF(v_base_str, '')::TIMESTAMPTZ;

      IF v_existing_updated IS NOT NULL
        AND v_base_ts IS NOT NULL
        AND v_existing_updated > v_base_ts + v_skew_grace
      THEN
        -- 远端已被改 stage / 重激活 / 改 updated_at；不能用本地陈旧 delete 覆盖
        v_skipped := array_append(v_skipped, v_task_id);
      ELSE
        v_kept := array_append(v_kept, v_task_id);
      END IF;
    END LOOP;
    v_task_ids := v_kept;
  END IF;

  -- 全部被剔除：返回 applied + skipped_ids，客户端据此重排队（不阻塞其他 task）
  IF array_length(v_task_ids, 1) IS NULL THEN
    v_result := jsonb_build_object(
      'status', 'applied',
      'operation_id', v_op_id,
      'project_id', v_project_id,
      'delete_mode', v_delete_mode,
      'deleted_count', 0,
      'attachment_paths', '[]'::JSONB,
      'skipped_ids', COALESCE(to_jsonb(v_skipped), '[]'::JSONB)
    );

    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin, result_payload)
    VALUES (v_op_id, v_user, 'task-delete', v_project_id, 'applied',
      v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin, v_result);

    RETURN v_result;
  END IF;

  IF v_delete_mode = 'soft' THEN
    v_deleted_count := public.safe_delete_tasks(v_task_ids, v_project_id);
    v_attachment_paths := ARRAY[]::TEXT[];
  ELSE
    SELECT purged_count, attachment_paths
      INTO v_deleted_count, v_attachment_paths
      FROM public.purge_tasks_v3(v_project_id, v_task_ids);
  END IF;

  v_result := jsonb_build_object(
    'status', 'applied',
    'operation_id', v_op_id,
    'project_id', v_project_id,
    'delete_mode', v_delete_mode,
    'deleted_count', COALESCE(v_deleted_count, 0),
    'attachment_paths', COALESCE(to_jsonb(v_attachment_paths), '[]'::JSONB),
    'skipped_ids', COALESCE(to_jsonb(v_skipped), '[]'::JSONB)
  );

  INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
    status, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin, result_payload)
  VALUES (v_op_id, v_user, 'task-delete', v_project_id, 'applied',
    v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin, v_result);

  RETURN v_result;
END;
$$;

-- -----------------------------------------------------------------------------
-- R1 二级护栏：在 connections 表上挂复活防护（与 projects / black_box_entries 对齐）
-- 复用 20260511024000_prevent_project_blackbox_resurrection.sql 中定义的函数。
-- -----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_prevent_connection_resurrection ON public.connections;
CREATE TRIGGER trg_prevent_connection_resurrection
  BEFORE UPDATE ON public.connections
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_soft_deleted_row_resurrection();

-- -----------------------------------------------------------------------------
-- Permissions（与 0513 一致：authenticated 可执行；anon / PUBLIC 拒绝）
-- -----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.sync_upsert_connection(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sync_upsert_blackbox_entry(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sync_upsert_project(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sync_delete_tasks(JSONB) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.sync_upsert_connection(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_upsert_blackbox_entry(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_upsert_project(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_delete_tasks(JSONB) TO authenticated;

COMMENT ON FUNCTION public.sync_upsert_connection(JSONB) IS
  'Sync-protected connection upsert with idempotency, protocol fence, tombstone guards, ownership checks, server-arrival LWW, and stale-write protection on source_id/target_id/deleted_at (P0 dirty-data fix).';

COMMENT ON FUNCTION public.sync_upsert_blackbox_entry(JSONB) IS
  'Sync-protected blackbox upsert with idempotency, protocol fence, ownership checks, server-arrival LWW, and stale-write protection on state-machine fields (P0 dirty-data fix).';

COMMENT ON FUNCTION public.sync_upsert_project(JSONB) IS
  'Sync-protected project upsert with idempotency, tombstone barrier, protocol fence, ownership checks, server-arrival LWW, and stale-write protection on title/description/version/migrated_to_v2 (P0 dirty-data fix).';

COMMENT ON FUNCTION public.sync_delete_tasks(JSONB) IS
  'Sync-protected task batch delete/purge wrapper around safe_delete_tasks/purge_tasks_v3 with idempotency, protocol fence, and optional base_updated_at_map stale-write filtering (P0 dirty-data fix).';

COMMENT ON TRIGGER trg_prevent_connection_resurrection ON public.connections IS
  'Database safety net preventing stale sync payloads from resurrecting soft-deleted connections (mirrors projects/black_box_entries protection).';
