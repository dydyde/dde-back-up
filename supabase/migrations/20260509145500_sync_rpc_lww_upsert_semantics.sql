-- =============================================================================
-- Sync RPC LWW upsert semantics
-- =============================================================================
--
-- Root cause:
-- The first sync RPC rollout treated `base_updated_at` as a strict CAS base.
-- Offline-first writes mutate local `updatedAt` before the remote push, so retry
-- payloads usually carry the local mutation timestamp instead of the previous
-- remote timestamp. Strict equality made every normal offline edit look like a
-- conflict and left large RetryQueue/ActionQueue backlogs.
--
-- Fix:
-- Reinterpret the incoming timestamp as the local mutation timestamp for LWW:
--   - missing remote row: accept insert even when the local timestamp exists;
--   - existing remote row: reject only when remote `updated_at` is newer than the
--     local mutation timestamp.
-- This restores the repository Hard Rule: local first, retry later, LWW.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.sync_upsert_task(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_op_id UUID := (payload->>'operation_id')::UUID;
  v_protocol INTEGER := COALESCE((payload->>'protocol_version')::INTEGER, 0);
  v_local_updated TIMESTAMPTZ := NULLIF(COALESCE(payload->>'base_updated_at', payload->'task'->>'updated_at', payload->'task'->>'updatedAt'), '')::TIMESTAMPTZ;
  v_client_epoch BIGINT := COALESCE((payload->>'deployment_epoch')::BIGINT, 0);
  v_deployment_target TEXT := payload->>'deployment_target';
  v_task JSONB := payload->'task';
  v_task_id UUID := (v_task->>'id')::UUID;
  v_project_id UUID := (v_task->>'project_id')::UUID;
  v_client_git TEXT := payload->>'client_git_sha';
  v_client_origin TEXT := payload->>'client_origin';
  v_min_protocol INTEGER;
  v_min_epoch BIGINT;
  v_existing_updated TIMESTAMPTZ;
  v_existing_owner UUID;
  v_log_existing RECORD;
  v_result JSONB;
  v_written_updated TIMESTAMPTZ;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'no auth');
  END IF;
  IF v_op_id IS NULL OR v_task_id IS NULL OR v_project_id IS NULL THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'missing required fields');
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
    VALUES (v_op_id, v_user, 'task', v_task_id, 'client-version-rejected',
      CASE
        WHEN v_protocol < COALESCE(v_min_protocol, 1) THEN 'protocol_version_below_min'
        ELSE 'deployment_epoch_below_min'
      END,
      v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin);
    RETURN jsonb_build_object('status', 'client-version-rejected',
      'minProtocolVersion', v_min_protocol,
      'deploymentEpoch', COALESCE(v_min_epoch, 0));
  END IF;

  SELECT p.owner_id INTO v_existing_owner FROM public.projects p WHERE p.id = v_project_id;
  IF v_existing_owner IS DISTINCT FROM v_user THEN
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin)
    VALUES (v_op_id, v_user, 'task', v_task_id, 'unauthorized',
      'project_not_owned', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin);
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'project_not_owned');
  END IF;

  SELECT t.updated_at INTO v_existing_updated FROM public.tasks t WHERE t.id = v_task_id;

  IF v_existing_updated IS NOT NULL
    AND (v_local_updated IS NULL OR v_local_updated < v_existing_updated)
  THEN
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin)
    VALUES (v_op_id, v_user, 'task', v_task_id, 'remote-newer',
      'lww_remote_newer', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin);
    RETURN jsonb_build_object(
      'status', 'remote-newer',
      'remote_updated_at', v_existing_updated,
      'reason', 'lww_remote_newer'
    );
  END IF;

  PERFORM public.batch_upsert_tasks(ARRAY[v_task], v_project_id);
  SELECT t.updated_at INTO v_written_updated FROM public.tasks t WHERE t.id = v_task_id;

  v_result := jsonb_build_object(
    'status', 'applied',
    'operation_id', v_op_id,
    'task_id', v_task_id,
    'updated_at', v_written_updated
  );

  INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
    status, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin, result_payload)
  VALUES (v_op_id, v_user, 'task', v_task_id, 'applied',
    v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin, v_result);

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.sync_upsert_task(JSONB) TO authenticated;

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
  v_local_updated TIMESTAMPTZ := NULLIF(COALESCE(payload->>'base_updated_at', payload->'connection'->>'updated_at', payload->'connection'->>'updatedAt'), '')::TIMESTAMPTZ;
  v_client_epoch BIGINT := COALESCE((payload->>'deployment_epoch')::BIGINT, 0);
  v_deployment_target TEXT := payload->>'deployment_target';
  v_client_git TEXT := payload->>'client_git_sha';
  v_client_origin TEXT := payload->>'client_origin';
  v_conn JSONB := payload->'connection';
  v_conn_id UUID := (v_conn->>'id')::UUID;
  v_project_id UUID := (v_conn->>'project_id')::UUID;
  v_min_protocol INTEGER;
  v_min_epoch BIGINT;
  v_existing_updated TIMESTAMPTZ;
  v_existing_owner UUID;
  v_log_existing RECORD;
  v_result JSONB;
  v_written_updated TIMESTAMPTZ;
BEGIN
  IF v_user IS NULL OR v_op_id IS NULL OR v_conn_id IS NULL OR v_project_id IS NULL THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'missing required fields');
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

  SELECT c.updated_at INTO v_existing_updated FROM public.connections c WHERE c.id = v_conn_id;
  IF v_existing_updated IS NOT NULL
    AND (v_local_updated IS NULL OR v_local_updated < v_existing_updated)
  THEN
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin)
    VALUES (v_op_id, v_user, 'connection', v_conn_id, 'remote-newer',
      'lww_remote_newer', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin);
    RETURN jsonb_build_object(
      'status', 'remote-newer',
      'remote_updated_at', v_existing_updated,
      'reason', 'lww_remote_newer'
    );
  END IF;

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
    SET source_id = EXCLUDED.source_id,
        target_id = EXCLUDED.target_id,
        title = EXCLUDED.title,
        description = EXCLUDED.description,
        deleted_at = EXCLUDED.deleted_at,
        updated_at = NOW()
  RETURNING c.updated_at INTO v_written_updated;

  v_result := jsonb_build_object(
    'status', 'applied',
    'operation_id', v_op_id,
    'connection_id', v_conn_id,
    'updated_at', v_written_updated
  );

  INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
    status, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin, result_payload)
  VALUES (v_op_id, v_user, 'connection', v_conn_id, 'applied',
    v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin, v_result);

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.sync_upsert_connection(JSONB) TO authenticated;

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
  v_local_updated TIMESTAMPTZ := NULLIF(COALESCE(payload->>'base_updated_at', payload->'entry'->>'updated_at', payload->'entry'->>'updatedAt'), '')::TIMESTAMPTZ;
  v_client_epoch BIGINT := COALESCE((payload->>'deployment_epoch')::BIGINT, 0);
  v_deployment_target TEXT := payload->>'deployment_target';
  v_client_git TEXT := payload->>'client_git_sha';
  v_client_origin TEXT := payload->>'client_origin';
  v_entry JSONB := payload->'entry';
  v_entry_id UUID := (v_entry->>'id')::UUID;
  v_min_protocol INTEGER;
  v_min_epoch BIGINT;
  v_existing_updated TIMESTAMPTZ;
  v_existing_owner UUID;
  v_log_existing RECORD;
  v_result JSONB;
  v_written_updated TIMESTAMPTZ;
BEGIN
  IF v_user IS NULL OR v_op_id IS NULL OR v_entry_id IS NULL THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'missing required fields');
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

  SELECT b.updated_at, b.user_id INTO v_existing_updated, v_existing_owner
    FROM public.black_box_entries b WHERE b.id = v_entry_id;

  IF v_existing_owner IS NOT NULL AND v_existing_owner <> v_user THEN
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin)
    VALUES (v_op_id, v_user, 'blackbox', v_entry_id, 'unauthorized',
      'entry_owned_by_other', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin);
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'entry_owned_by_other');
  END IF;

  IF v_existing_updated IS NOT NULL
    AND (v_local_updated IS NULL OR v_local_updated < v_existing_updated)
  THEN
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin)
    VALUES (v_op_id, v_user, 'blackbox', v_entry_id, 'remote-newer',
      'lww_remote_newer', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin);
    RETURN jsonb_build_object(
      'status', 'remote-newer',
      'remote_updated_at', v_existing_updated,
      'reason', 'lww_remote_newer'
    );
  END IF;

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
    NULLIF(v_entry->>'project_id', '')::UUID,
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
    SET content = EXCLUDED.content,
        project_id = EXCLUDED.project_id,
        date = EXCLUDED.date,
        updated_at = NOW(),
        is_read = EXCLUDED.is_read,
        is_completed = EXCLUDED.is_completed,
        is_archived = EXCLUDED.is_archived,
        snooze_until = EXCLUDED.snooze_until,
        snooze_count = EXCLUDED.snooze_count,
        deleted_at = EXCLUDED.deleted_at,
        focus_meta = EXCLUDED.focus_meta
  RETURNING b.updated_at INTO v_written_updated;

  v_result := jsonb_build_object(
    'status', 'applied',
    'operation_id', v_op_id,
    'entry_id', v_entry_id,
    'updated_at', v_written_updated
  );

  INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
    status, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin, result_payload)
  VALUES (v_op_id, v_user, 'blackbox', v_entry_id, 'applied',
    v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin, v_result);

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.sync_upsert_blackbox_entry(JSONB) TO authenticated;

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
  v_local_updated TIMESTAMPTZ := NULLIF(COALESCE(payload->>'base_updated_at', payload->'project'->>'updated_at', payload->'project'->>'updatedAt'), '')::TIMESTAMPTZ;
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
  v_log_existing RECORD;
  v_result JSONB;
  v_written_updated TIMESTAMPTZ;
BEGIN
  IF v_user IS NULL OR v_op_id IS NULL OR v_project_id IS NULL THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'missing required fields');
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

  SELECT owner_id, updated_at, deleted_at
    INTO v_existing_owner, v_existing_updated, v_existing_deleted
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

  IF v_existing_updated IS NULL THEN
    INSERT INTO public.projects AS p (id, owner_id, title, description, version, migrated_to_v2, deleted_at)
    VALUES (
      v_project_id,
      v_user,
      v_project->>'title',
      NULLIF(v_project->>'description', ''),
      COALESCE((v_project->>'version')::INTEGER, 1),
      COALESCE((v_project->>'migrated_to_v2')::BOOLEAN, TRUE),
      NULLIF(v_project->>'deleted_at', '')::TIMESTAMPTZ
    )
    RETURNING p.updated_at INTO v_written_updated;
  ELSE
    IF v_local_updated IS NULL OR v_local_updated < v_existing_updated THEN
      INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
        status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin)
      VALUES (v_op_id, v_user, 'project', v_project_id, 'remote-newer',
        'lww_remote_newer', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin);
      RETURN jsonb_build_object(
        'status', 'remote-newer',
        'remote_updated_at', v_existing_updated,
        'reason', 'lww_remote_newer'
      );
    END IF;

    UPDATE public.projects AS p
    SET title = v_project->>'title',
        description = NULLIF(v_project->>'description', ''),
        version = COALESCE((v_project->>'version')::INTEGER, p.version, 1),
        migrated_to_v2 = COALESCE((v_project->>'migrated_to_v2')::BOOLEAN, TRUE),
        deleted_at = NULLIF(v_project->>'deleted_at', '')::TIMESTAMPTZ,
        updated_at = NOW()
    WHERE p.id = v_project_id
    RETURNING p.updated_at INTO v_written_updated;
  END IF;

  v_result := jsonb_build_object(
    'status', 'applied',
    'operation_id', v_op_id,
    'project_id', v_project_id,
    'updated_at', v_written_updated
  );

  INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
    status, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin, result_payload)
  VALUES (v_op_id, v_user, 'project', v_project_id, 'applied',
    v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin, v_result);

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.sync_upsert_project(JSONB) TO authenticated;

COMMENT ON FUNCTION public.sync_upsert_task(JSONB) IS
  'Sync-protected task upsert with idempotency, protocol fence, and LWW timestamp conflict handling.';

COMMENT ON FUNCTION public.sync_upsert_connection(JSONB) IS
  'Sync-protected connection upsert with idempotency, protocol fence, and LWW timestamp conflict handling.';

COMMENT ON FUNCTION public.sync_upsert_blackbox_entry(JSONB) IS
  'Sync-protected blackbox upsert with idempotency, protocol fence, and LWW timestamp conflict handling.';

COMMENT ON FUNCTION public.sync_upsert_project(JSONB) IS
  'Sync-protected project upsert with idempotency, tombstone barrier, protocol fence, and LWW timestamp conflict handling.';
