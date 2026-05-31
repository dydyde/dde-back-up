-- =============================================================================
-- P0 task upsert guard: reject untimestamped updates to existing tasks
-- =============================================================================
--
-- Root cause:
-- `launch-snapshot.recentTasks` is a preview summary. Older clients could
-- materialize those summaries as Task objects without `updatedAt` and then push
-- them through `sync_upsert_task`. Since the 2026-05 LWW restore accepted
-- existing task upserts with no local timestamp, those summaries could overwrite
-- authoritative `stage`, `parent_id`, and `content`, making real stage roots
-- appear as unassigned blocks.
--
-- Fix:
-- Keep insert compatibility for new local tasks, but when a row already exists
-- require at least one freshness marker (`task.updated_at` / `task.updatedAt` /
-- `base_updated_at`). Without it, return `remote-newer` and leave the row
-- untouched. This is deliberately narrower than reintroducing strict CAS.
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
  v_local_updated TIMESTAMPTZ := public.sync_extract_local_updated(payload, 'task');
  v_client_epoch BIGINT := COALESCE((payload->>'deployment_epoch')::BIGINT, 0);
  v_deployment_target TEXT := payload->>'deployment_target';
  v_task JSONB := payload->'task';
  v_task_id UUID := (v_task->>'id')::UUID;
  v_project_id UUID := (v_task->>'project_id')::UUID;
  v_client_git TEXT := payload->>'client_git_sha';
  v_client_origin TEXT := payload->>'client_origin';
  v_min_protocol INTEGER;
  v_min_epoch BIGINT;
  v_existing_owner UUID;
  v_existing_project_id UUID;
  v_existing_updated TIMESTAMPTZ;
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

  SELECT t.project_id, p.owner_id, t.updated_at
    INTO v_existing_project_id, v_existing_owner, v_existing_updated
    FROM public.tasks t
    JOIN public.projects p ON p.id = t.project_id
    WHERE t.id = v_task_id
    FOR UPDATE;

  IF v_existing_project_id IS NOT NULL
    AND (v_existing_project_id <> v_project_id OR v_existing_owner IS DISTINCT FROM v_user)
  THEN
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin)
    VALUES (v_op_id, v_user, 'task', v_task_id, 'unauthorized',
      'task_owned_by_other_project', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin);
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'task_owned_by_other_project');
  END IF;

  IF v_existing_project_id IS NOT NULL AND v_local_updated IS NULL THEN
    v_result := jsonb_build_object(
      'status', 'remote-newer',
      'reason', 'missing_task_timestamp',
      'remote_updated_at', v_existing_updated
    );

    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin, result_payload)
    VALUES (v_op_id, v_user, 'task', v_task_id, 'remote-newer',
      'missing_task_timestamp', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin, v_result);

    RETURN v_result;
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

REVOKE ALL ON FUNCTION public.sync_upsert_task(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_upsert_task(JSONB) TO authenticated;

COMMENT ON FUNCTION public.sync_upsert_task(JSONB) IS
  'Sync-protected task upsert with idempotency, protocol fence, ownership checks, server-arrival LWW, and untimestamped existing-task guard.';
