CREATE OR REPLACE FUNCTION public.sync_canonical_payload_digest(p_payload JSONB)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public, extensions, pg_temp
AS $$
  SELECT encode(
    extensions.digest(
      (COALESCE(p_payload, '{}'::JSONB) - 'operation_id' - 'operationId')::TEXT,
      'sha256'
    ),
    'hex'
  );
$$;

REVOKE ALL ON FUNCTION public.sync_canonical_payload_digest(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_canonical_payload_digest(JSONB) TO service_role;

CREATE OR REPLACE FUNCTION public.record_sync_write_quarantine(
  p_operation_id UUID,
  p_user_id UUID,
  p_entity_type TEXT,
  p_entity_id UUID,
  p_client_git_sha TEXT,
  p_client_origin TEXT,
  p_reason TEXT,
  p_payload JSONB
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_digest TEXT := public.sync_canonical_payload_digest(p_payload);
  v_id BIGINT;
BEGIN
  INSERT INTO public.sync_write_quarantine(
    operation_id, user_id, entity_type, entity_id,
    client_git_sha, client_origin, reason, payload, payload_digest
  )
  VALUES (
    p_operation_id, p_user_id, p_entity_type, p_entity_id,
    p_client_git_sha, p_client_origin, p_reason, p_payload, v_digest
  )
  ON CONFLICT (operation_id) DO UPDATE
    SET operation_id = EXCLUDED.operation_id
  RETURNING id INTO v_id;

  RETURN v_id;
EXCEPTION WHEN unique_violation THEN
  SELECT id INTO v_id
  FROM public.sync_write_quarantine
  WHERE operation_id = p_operation_id OR payload_digest = v_digest
  ORDER BY id ASC
  LIMIT 1;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_sync_write_quarantine(UUID, UUID, TEXT, UUID, TEXT, TEXT, TEXT, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_sync_write_quarantine(UUID, UUID, TEXT, UUID, TEXT, TEXT, TEXT, JSONB)
  TO service_role;

CREATE OR REPLACE FUNCTION public.capture_task_change_audit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_owner UUID;
  v_operation_id UUID;
  v_client_git_sha TEXT;
  v_client_origin TEXT;
  v_deployment_epoch BIGINT;
  v_payload_digest TEXT;
  v_origin_unverified BOOLEAN := true;
  v_suspicious BOOLEAN := false;
  v_suspicious_reason TEXT;
  v_epoch_text TEXT;
BEGIN
  SELECT p.owner_id INTO v_owner FROM public.projects p WHERE p.id = OLD.project_id;

  v_operation_id := NULLIF(current_setting('app.operation_id', true), '')::UUID;
  v_client_git_sha := NULLIF(current_setting('app.client_git_sha', true), '');
  v_client_origin := NULLIF(current_setting('app.client_origin', true), '');
  v_payload_digest := NULLIF(current_setting('app.payload_digest', true), '');
  v_origin_unverified := COALESCE(NULLIF(current_setting('app.origin_unverified', true), '')::BOOLEAN, true);
  v_epoch_text := NULLIF(current_setting('app.deployment_epoch', true), '');
  IF v_epoch_text ~ '^[0-9]+$' THEN
    v_deployment_epoch := v_epoch_text::BIGINT;
  END IF;

  IF v_operation_id IS NULL
    OR v_client_git_sha IS NULL
    OR v_client_origin IS NULL
    OR v_payload_digest IS NULL
  THEN
    v_origin_unverified := true;
  END IF;

  IF TG_OP = 'DELETE' THEN
    INSERT INTO public.task_change_audit (
      task_id, project_id, owner_id, op, old_stage, old_parent_id,
      old_content, old_title, old_updated_at, old_deleted_at, old_record,
      operation_id, client_git_sha, client_origin, deployment_epoch,
      payload_digest, origin_unverified, suspicious, suspicious_reason
    )
    VALUES (
      OLD.id, OLD.project_id, v_owner, TG_OP, OLD.stage, OLD.parent_id,
      OLD.content, OLD.title, OLD.updated_at, OLD.deleted_at, to_jsonb(OLD),
      v_operation_id, v_client_git_sha, v_client_origin, v_deployment_epoch,
      v_payload_digest, v_origin_unverified, false, NULL
    );
    RETURN OLD;
  END IF;

  IF OLD.stage IS NOT NULL
    AND NEW.stage IS NULL
    AND COALESCE(NEW.content, '') = COALESCE(NEW.title, '')
  THEN
    v_suspicious := true;
    v_suspicious_reason := 'structure_degrade_content_equals_title';
  END IF;

  INSERT INTO public.task_change_audit (
    task_id, project_id, owner_id, op, old_stage, old_parent_id,
    old_content, old_title, old_updated_at, old_deleted_at, old_record,
    new_stage, new_parent_id, new_content, new_title, new_updated_at, new_deleted_at,
    operation_id, client_git_sha, client_origin, deployment_epoch,
    payload_digest, origin_unverified, suspicious, suspicious_reason
  )
  VALUES (
    OLD.id, OLD.project_id, v_owner, TG_OP, OLD.stage, OLD.parent_id,
    OLD.content, OLD.title, OLD.updated_at, OLD.deleted_at, to_jsonb(OLD),
    NEW.stage, NEW.parent_id, NEW.content, NEW.title, NEW.updated_at, NEW.deleted_at,
    v_operation_id, v_client_git_sha, v_client_origin, v_deployment_epoch,
    v_payload_digest, v_origin_unverified, v_suspicious, v_suspicious_reason
  );

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.capture_task_change_audit() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.capture_task_change_audit() FROM PUBLIC, anon, authenticated;
