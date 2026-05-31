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
  v_local_updated TIMESTAMPTZ := public.sync_extract_local_updated(payload, 'task');
  v_client_epoch BIGINT := COALESCE((payload->>'deployment_epoch')::BIGINT, 0);
  v_deployment_target TEXT := payload->>'deployment_target';
  v_task JSONB := payload->'task';
  v_task_id UUID := (v_task->>'id')::UUID;
  v_project_id UUID := (v_task->>'project_id')::UUID;
  v_client_git TEXT := payload->>'client_git_sha';
  v_client_origin TEXT := payload->>'client_origin';
  v_payload_digest TEXT := encode(extensions.digest(payload::TEXT, 'sha256'), 'hex');
  v_min_protocol INTEGER;
  v_min_epoch BIGINT;
  v_existing_owner UUID;
  v_existing_project_id UUID;
  v_existing_updated TIMESTAMPTZ;
  v_existing_stage INTEGER;
  v_existing_parent UUID;
  v_existing_content TEXT;
  v_existing_title TEXT;
  v_existing_deleted TIMESTAMPTZ;
  v_payload_stage INTEGER;
  v_payload_parent UUID;
  v_payload_deleted TIMESTAMPTZ;
  v_task_for_write JSONB;
  v_log_existing RECORD;
  v_result JSONB;
  v_written_updated TIMESTAMPTZ;
  v_sync_mode TEXT;
  v_quarantine_id BIGINT;
  v_origin_unverified BOOLEAN := true;
  v_changed_fields JSONB := '[]'::jsonb;
  v_audit_id BIGINT;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'no auth');
  END IF;
  IF v_op_id IS NULL OR v_task_id IS NULL OR v_project_id IS NULL THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'missing required fields');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('sync_upsert_task'), hashtext(v_task_id::TEXT));

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
    v_result := jsonb_build_object(
      'status', 'client-version-rejected',
      'decision', 'rejected',
      'reason', CASE
        WHEN v_protocol < COALESCE(v_min_protocol, 1) THEN 'protocol_version_below_min'
        ELSE 'deployment_epoch_below_min'
      END,
      'minProtocolVersion', v_min_protocol,
      'deploymentEpoch', COALESCE(v_min_epoch, 0)
    );

    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin,
      payload_digest, result_payload)
    VALUES (v_op_id, v_user, 'task', v_task_id, 'client-version-rejected',
      v_result->>'reason', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin,
      v_payload_digest, v_result);
    RETURN v_result;
  END IF;

  SELECT COALESCE(value, 'normal') INTO v_sync_mode
    FROM public.data_safety_flags
    WHERE key = 'sync_mode';
  v_sync_mode := COALESCE(v_sync_mode, 'normal');

  SELECT NOT EXISTS (
    SELECT 1
    FROM public.sync_trusted_client_deployments d
    WHERE d.client_git_sha = v_client_git
      AND d.deployment_epoch = v_client_epoch
      AND (d.deployment_target IS NULL OR d.deployment_target = v_deployment_target)
      AND d.retired_at IS NULL
  ) INTO v_origin_unverified;

  v_origin_unverified := v_origin_unverified
    OR v_client_git IS NULL OR btrim(v_client_git) = ''
    OR v_client_origin IS NULL OR btrim(v_client_origin) = '';

  SELECT p.owner_id INTO v_existing_owner FROM public.projects p WHERE p.id = v_project_id;
  IF v_existing_owner IS DISTINCT FROM v_user THEN
    v_result := jsonb_build_object('status', 'unauthorized', 'decision', 'rejected', 'reason', 'project_not_owned');
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin,
      payload_digest, result_payload)
    VALUES (v_op_id, v_user, 'task', v_task_id, 'unauthorized',
      'project_not_owned', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin,
      v_payload_digest, v_result);
    RETURN v_result;
  END IF;

  SELECT t.project_id, p.owner_id, t.updated_at, t.stage, t.parent_id, t.content, t.title, t.deleted_at
    INTO v_existing_project_id, v_existing_owner, v_existing_updated, v_existing_stage,
      v_existing_parent, v_existing_content, v_existing_title, v_existing_deleted
    FROM public.tasks t
    JOIN public.projects p ON p.id = t.project_id
    WHERE t.id = v_task_id
    FOR UPDATE;

  IF v_existing_project_id IS NOT NULL
    AND (v_existing_project_id <> v_project_id OR v_existing_owner IS DISTINCT FROM v_user)
  THEN
    v_result := jsonb_build_object('status', 'unauthorized', 'decision', 'rejected', 'reason', 'task_owned_by_other_project');
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin,
      payload_digest, result_payload)
    VALUES (v_op_id, v_user, 'task', v_task_id, 'unauthorized',
      'task_owned_by_other_project', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin,
      v_payload_digest, v_result);
    RETURN v_result;
  END IF;

  v_payload_stage := NULLIF(v_task->>'stage', '')::INTEGER;
  v_payload_parent := NULLIF(COALESCE(v_task->>'parentId', v_task->>'parent_id'), '')::UUID;
  v_payload_deleted := NULLIF(COALESCE(v_task->>'deletedAt', v_task->>'deleted_at'), '')::TIMESTAMPTZ;
  v_task_for_write := v_task;
  IF v_local_updated IS NOT NULL
    AND NOT (v_task_for_write ? 'updated_at')
    AND NOT (v_task_for_write ? 'updatedAt')
  THEN
    v_task_for_write := jsonb_set(v_task_for_write, '{updated_at}', to_jsonb(v_local_updated::TEXT), true);
  END IF;

  IF v_existing_project_id IS NULL THEN
    v_changed_fields := jsonb_build_array('insert');
  ELSE
    IF v_existing_stage IS DISTINCT FROM v_payload_stage THEN
      v_changed_fields := v_changed_fields || jsonb_build_array('stage');
    END IF;
    IF v_existing_parent IS DISTINCT FROM v_payload_parent THEN
      v_changed_fields := v_changed_fields || jsonb_build_array('parent_id');
    END IF;
    IF (v_task ? 'content') AND v_existing_content IS DISTINCT FROM (v_task->>'content') THEN
      v_changed_fields := v_changed_fields || jsonb_build_array('content');
    END IF;
    IF v_existing_title IS DISTINCT FROM (v_task->>'title') THEN
      v_changed_fields := v_changed_fields || jsonb_build_array('title');
    END IF;
    IF v_existing_deleted IS DISTINCT FROM v_payload_deleted THEN
      v_changed_fields := v_changed_fields || jsonb_build_array('deleted_at');
    END IF;
  END IF;

  IF v_existing_project_id IS NOT NULL AND v_local_updated IS NULL THEN
    IF v_sync_mode = 'quarantine' THEN
      v_quarantine_id := public.record_sync_write_quarantine(
        v_op_id, v_user, 'task', v_task_id, v_client_git, v_client_origin, 'missing_task_timestamp', payload
      );
    END IF;

    v_result := jsonb_build_object(
      'status', 'remote-newer',
      'decision', CASE WHEN v_quarantine_id IS NULL THEN 'rejected' ELSE 'quarantined' END,
      'reason', 'missing_task_timestamp',
      'quarantine_id', v_quarantine_id,
      'remote_updated_at', v_existing_updated,
      'changed_fields', v_changed_fields
    );

    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin,
      payload_digest, result_payload)
    VALUES (v_op_id, v_user, 'task', v_task_id, CASE WHEN v_quarantine_id IS NULL THEN 'remote-newer' ELSE 'quarantined' END,
      'missing_task_timestamp', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin,
      v_payload_digest, v_result);

    RETURN v_result;
  END IF;

  IF v_sync_mode = 'read_only' THEN
    v_result := jsonb_build_object(
      'status', 'remote-newer',
      'decision', 'rejected',
      'reason', 'sync_read_only',
      'remote_updated_at', v_existing_updated,
      'changed_fields', v_changed_fields
    );

    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin,
      payload_digest, result_payload)
    VALUES (v_op_id, v_user, 'task', v_task_id, 'remote-newer',
      'sync_read_only', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin,
      v_payload_digest, v_result);

    RETURN v_result;
  END IF;

  IF v_sync_mode = 'quarantine' THEN
    v_quarantine_id := public.record_sync_write_quarantine(
      v_op_id, v_user, 'task', v_task_id, v_client_git, v_client_origin, 'sync_quarantine', payload
    );
    v_result := jsonb_build_object(
      'status', 'remote-newer',
      'decision', 'quarantined',
      'reason', 'sync_quarantine',
      'quarantine_id', v_quarantine_id,
      'changed_fields', v_changed_fields
    );

    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin,
      payload_digest, result_payload)
    VALUES (v_op_id, v_user, 'task', v_task_id, 'quarantined',
      'sync_quarantine', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin,
      v_payload_digest, v_result);

    RETURN v_result;
  END IF;

  PERFORM set_config('app.operation_id', v_op_id::TEXT, true);
  PERFORM set_config('app.client_git_sha', COALESCE(v_client_git, ''), true);
  PERFORM set_config('app.client_origin', COALESCE(v_client_origin, ''), true);
  PERFORM set_config('app.deployment_epoch', v_client_epoch::TEXT, true);
  PERFORM set_config('app.payload_digest', v_payload_digest, true);
  PERFORM set_config('app.origin_unverified', v_origin_unverified::TEXT, true);

  PERFORM public.batch_upsert_tasks(ARRAY[v_task_for_write], v_project_id);
  SELECT t.updated_at INTO v_written_updated FROM public.tasks t WHERE t.id = v_task_id;
  SELECT a.id INTO v_audit_id
  FROM public.task_change_audit a
  WHERE a.operation_id = v_op_id
    AND a.task_id = v_task_id
  ORDER BY a.id DESC
  LIMIT 1;

  v_result := jsonb_build_object(
    'status', 'applied',
    'decision', 'applied',
    'reason', CASE
      WHEN v_sync_mode = 'audit_only' THEN 'audit_only'
      WHEN v_existing_project_id IS NULL THEN 'insert'
      ELSE 'fresh-local-update'
    END,
    'operation_id', v_op_id,
    'task_id', v_task_id,
    'updated_at', v_written_updated,
    'changed_fields', v_changed_fields,
    'audit_id', v_audit_id,
    'origin_unverified', v_origin_unverified
  );

  INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
    status, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin,
    payload_digest, result_payload)
  VALUES (v_op_id, v_user, 'task', v_task_id, 'applied',
    v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin,
    v_payload_digest, v_result);

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_upsert_task(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_upsert_task(JSONB) TO authenticated;
