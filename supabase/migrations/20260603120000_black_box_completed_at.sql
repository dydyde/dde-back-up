-- =============================================================================
-- Stable completion timestamp for black-box entries
-- =============================================================================

ALTER TABLE public.black_box_entries
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN public.black_box_entries.completed_at IS
  'Completion timestamp captured when is_completed first becomes true; used by strata history grouping.';

CREATE OR REPLACE FUNCTION public.set_black_box_completed_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF COALESCE(NEW.is_completed, FALSE) = FALSE THEN
    NEW.completed_at := NULL;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND COALESCE(OLD.is_completed, FALSE) = TRUE THEN
    NEW.completed_at := COALESCE(OLD.completed_at, NEW.completed_at);
    RETURN NEW;
  END IF;

  NEW.completed_at := COALESCE(NEW.completed_at, NOW());
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_black_box_completed_at ON public.black_box_entries;
CREATE TRIGGER set_black_box_completed_at
  BEFORE INSERT OR UPDATE OF is_completed, completed_at ON public.black_box_entries
  FOR EACH ROW EXECUTE FUNCTION public.set_black_box_completed_at();

REVOKE ALL ON FUNCTION public.set_black_box_completed_at() FROM PUBLIC, anon, authenticated;

-- Keep the latest Sync RPC contract while adding completed_at to the guarded state fields.
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
  v_existing_completed_at TIMESTAMPTZ;
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

  SELECT
      TRUE,
      b.user_id,
      b.updated_at,
      b.project_id,
      b.is_read,
      b.is_completed,
      b.completed_at,
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
      v_existing_completed_at,
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
    completed_at,
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
    CASE
      WHEN COALESCE((v_entry->>'is_completed')::BOOLEAN, FALSE) THEN
        COALESCE(
          NULLIF(v_entry->>'completed_at','')::TIMESTAMPTZ,
          NULLIF(v_entry->>'completedAt','')::TIMESTAMPTZ,
          NOW()
        )
      ELSE NULL
    END,
    COALESCE((v_entry->>'is_archived')::BOOLEAN, FALSE),
    NULLIF(v_entry->>'snooze_until','')::TIMESTAMPTZ,
    COALESCE((v_entry->>'snooze_count')::INTEGER, 0),
    NULLIF(v_entry->>'deleted_at','')::TIMESTAMPTZ,
    v_entry->'focus_meta'
  )
  ON CONFLICT (id) DO UPDATE
    SET content = EXCLUDED.content,
        date = EXCLUDED.date,
        project_id = CASE WHEN v_is_stale THEN v_existing_project ELSE EXCLUDED.project_id END,
        is_read = CASE WHEN v_is_stale THEN v_existing_is_read ELSE EXCLUDED.is_read END,
        is_completed = CASE WHEN v_is_stale THEN v_existing_is_completed ELSE EXCLUDED.is_completed END,
        completed_at = CASE WHEN v_is_stale THEN v_existing_completed_at ELSE EXCLUDED.completed_at END,
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

REVOKE ALL ON FUNCTION public.sync_upsert_blackbox_entry(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_upsert_blackbox_entry(JSONB) TO authenticated;

COMMENT ON FUNCTION public.sync_upsert_blackbox_entry(JSONB) IS
  'Protected BlackBox upsert with stale-write guards and stable completed_at preservation.';