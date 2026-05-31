-- =============================================================================
-- Database hardening and disaster-recovery controls
-- =============================================================================
-- Implements the post-P0 controls from docs/database-hardening-disaster-recovery-plan.md:
-- - service-controlled sync freeze switch with audit trail
-- - quarantine table for dangerous sync writes
-- - task audit source attribution, suspicious flags, and archive retention
-- - richer sync_operation_log result metadata and payload digest
-- - transitional field-intent handling for task writes
-- - RLS auto-enable event trigger for new public tables
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- -----------------------------------------------------------------------------
-- Sync operation log: allow explicit quarantined decisions and payload digests.
-- -----------------------------------------------------------------------------
ALTER TABLE public.sync_operation_log
  ADD COLUMN IF NOT EXISTS payload_digest TEXT;

ALTER TABLE public.sync_operation_log
  DROP CONSTRAINT IF EXISTS sync_operation_log_status_check;

ALTER TABLE public.sync_operation_log
  ADD CONSTRAINT sync_operation_log_status_check
    CHECK (status IN (
      'applied',
      'idempotent-replay',
      'remote-newer',
      'deleted-remote-newer',
      'client-version-rejected',
      'tombstoned',
      'unauthorized',
      'quarantined'
    ));

CREATE INDEX IF NOT EXISTS idx_sync_operation_log_payload_digest
  ON public.sync_operation_log (payload_digest)
  WHERE payload_digest IS NOT NULL;

-- -----------------------------------------------------------------------------
-- Global data-safety freeze switch. Client roles cannot read or mutate it; sync
-- RPCs read it as SECURITY DEFINER functions.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.data_safety_flags (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT data_safety_flags_sync_mode_chk CHECK (
    key <> 'sync_mode'
    OR value IN ('normal', 'audit_only', 'read_only', 'quarantine')
  )
);

CREATE TABLE IF NOT EXISTS public.data_safety_flag_audit (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  flag_key   TEXT NOT NULL,
  old_value  TEXT,
  new_value  TEXT NOT NULL,
  changed_by UUID,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.data_safety_flags(key, value)
VALUES ('sync_mode', 'normal')
ON CONFLICT (key) DO NOTHING;

ALTER TABLE public.data_safety_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.data_safety_flags FORCE ROW LEVEL SECURITY;
ALTER TABLE public.data_safety_flag_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.data_safety_flag_audit FORCE ROW LEVEL SECURITY;

REVOKE ALL ON public.data_safety_flags FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.data_safety_flag_audit FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.data_safety_flags TO service_role;
GRANT ALL ON public.data_safety_flag_audit TO service_role;

DROP POLICY IF EXISTS data_safety_flags_service_all ON public.data_safety_flags;
CREATE POLICY data_safety_flags_service_all
  ON public.data_safety_flags
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS data_safety_flag_audit_service_all ON public.data_safety_flag_audit;
CREATE POLICY data_safety_flag_audit_service_all
  ON public.data_safety_flag_audit
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.set_data_safety_flag(p_key TEXT, p_value TEXT)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_old_value TEXT;
BEGIN
  IF p_key <> 'sync_mode' THEN
    RAISE EXCEPTION 'unsupported data safety flag: %', p_key;
  END IF;

  IF p_value NOT IN ('normal', 'audit_only', 'read_only', 'quarantine') THEN
    RAISE EXCEPTION 'invalid sync_mode value: %', p_value;
  END IF;

  SELECT value INTO v_old_value
  FROM public.data_safety_flags
  WHERE key = p_key
  FOR UPDATE;

  INSERT INTO public.data_safety_flags(key, value, updated_by, updated_at)
  VALUES (p_key, p_value, auth.uid(), now())
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value,
        updated_by = EXCLUDED.updated_by,
        updated_at = now();

  INSERT INTO public.data_safety_flag_audit(flag_key, old_value, new_value, changed_by, changed_at)
  VALUES (p_key, v_old_value, p_value, auth.uid(), now());
END;
$$;

REVOKE ALL ON FUNCTION public.set_data_safety_flag(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_data_safety_flag(TEXT, TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.enforce_data_safety_freeze()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_sync_mode TEXT;
  v_bypass BOOLEAN := COALESCE(NULLIF(current_setting('app.data_safety_bypass', true), '')::BOOLEAN, false);
BEGIN
  SELECT value INTO v_sync_mode
  FROM public.data_safety_flags
  WHERE key = 'sync_mode';

  IF COALESCE(v_sync_mode, 'normal') IN ('read_only', 'quarantine') AND NOT v_bypass THEN
    RAISE EXCEPTION 'data_safety_write_blocked: %', v_sync_mode;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_data_safety_freeze() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_data_safety_freeze_tasks ON public.tasks;
CREATE TRIGGER trg_data_safety_freeze_tasks
  BEFORE INSERT OR UPDATE OR DELETE ON public.tasks
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_data_safety_freeze();

DROP TRIGGER IF EXISTS trg_data_safety_freeze_connections ON public.connections;
CREATE TRIGGER trg_data_safety_freeze_connections
  BEFORE INSERT OR UPDATE OR DELETE ON public.connections
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_data_safety_freeze();

DROP TRIGGER IF EXISTS trg_data_safety_freeze_projects ON public.projects;
CREATE TRIGGER trg_data_safety_freeze_projects
  BEFORE INSERT OR UPDATE OR DELETE ON public.projects
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_data_safety_freeze();

DROP TRIGGER IF EXISTS trg_data_safety_freeze_black_box_entries ON public.black_box_entries;
CREATE TRIGGER trg_data_safety_freeze_black_box_entries
  BEFORE INSERT OR UPDATE OR DELETE ON public.black_box_entries
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_data_safety_freeze();

-- Deployment allow-list used only for attribution confidence. It does not grant
-- authorization; auth.uid() remains the source of identity.
CREATE TABLE IF NOT EXISTS public.sync_trusted_client_deployments (
  client_git_sha   TEXT PRIMARY KEY,
  deployment_epoch BIGINT NOT NULL,
  deployment_target TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at       TIMESTAMPTZ
);

ALTER TABLE public.sync_trusted_client_deployments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_trusted_client_deployments FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.sync_trusted_client_deployments FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.sync_trusted_client_deployments TO service_role;

DROP POLICY IF EXISTS sync_trusted_client_deployments_service_all ON public.sync_trusted_client_deployments;
CREATE POLICY sync_trusted_client_deployments_service_all
  ON public.sync_trusted_client_deployments
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- -----------------------------------------------------------------------------
-- Quarantine table for dangerous sync writes.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sync_write_quarantine (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operation_id    UUID NOT NULL,
  user_id         UUID,
  entity_type     TEXT NOT NULL,
  entity_id       UUID,
  client_git_sha  TEXT,
  client_origin   TEXT,
  reason          TEXT NOT NULL,
  payload         JSONB NOT NULL,
  payload_digest  TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '30 days'),
  reviewed_at     TIMESTAMPTZ,
  reviewed_by     UUID,
  review_decision TEXT CHECK (review_decision IS NULL OR review_decision IN ('replay', 'discard', 'escalate')),
  CONSTRAINT sync_write_quarantine_operation_uniq UNIQUE (operation_id),
  CONSTRAINT sync_write_quarantine_digest_uniq UNIQUE (payload_digest)
);

CREATE INDEX IF NOT EXISTS sync_write_quarantine_user_reason_idx
  ON public.sync_write_quarantine (user_id, reason, created_at DESC);
CREATE INDEX IF NOT EXISTS sync_write_quarantine_expires_idx
  ON public.sync_write_quarantine (expires_at)
  WHERE reviewed_at IS NULL;

ALTER TABLE public.sync_write_quarantine ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_write_quarantine FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.sync_write_quarantine FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.sync_write_quarantine TO service_role;

DROP POLICY IF EXISTS sync_write_quarantine_service_all ON public.sync_write_quarantine;
CREATE POLICY sync_write_quarantine_service_all
  ON public.sync_write_quarantine
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

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

CREATE OR REPLACE FUNCTION public.purge_expired_sync_write_quarantine()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  DELETE FROM public.sync_write_quarantine
  WHERE expires_at < now()
    AND reviewed_at IS NULL;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_expired_sync_write_quarantine() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_expired_sync_write_quarantine() TO service_role;

-- -----------------------------------------------------------------------------
-- Strengthen task_change_audit with source attribution and suspicious markers.
-- -----------------------------------------------------------------------------
ALTER TABLE public.task_change_audit
  ADD COLUMN IF NOT EXISTS new_stage INTEGER,
  ADD COLUMN IF NOT EXISTS new_parent_id UUID,
  ADD COLUMN IF NOT EXISTS new_content TEXT,
  ADD COLUMN IF NOT EXISTS new_title TEXT,
  ADD COLUMN IF NOT EXISTS new_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS new_deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS operation_id UUID,
  ADD COLUMN IF NOT EXISTS client_git_sha TEXT,
  ADD COLUMN IF NOT EXISTS client_origin TEXT,
  ADD COLUMN IF NOT EXISTS deployment_epoch BIGINT,
  ADD COLUMN IF NOT EXISTS payload_digest TEXT,
  ADD COLUMN IF NOT EXISTS origin_unverified BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS suspicious BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS suspicious_reason TEXT;

CREATE INDEX IF NOT EXISTS task_change_audit_operation_idx
  ON public.task_change_audit (operation_id)
  WHERE operation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS task_change_audit_suspicious_idx
  ON public.task_change_audit (owner_id, changed_at DESC)
  WHERE suspicious;

DROP POLICY IF EXISTS task_change_audit_owner_select ON public.task_change_audit;
CREATE POLICY task_change_audit_owner_select
  ON public.task_change_audit
  FOR SELECT
  TO authenticated
  USING (owner_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS task_change_audit_service_all ON public.task_change_audit;
CREATE POLICY task_change_audit_service_all
  ON public.task_change_audit
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

ALTER TABLE public.task_change_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task_change_audit FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.task_change_audit FROM PUBLIC, anon;
GRANT SELECT ON public.task_change_audit TO authenticated;
GRANT ALL ON public.task_change_audit TO service_role;

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

DO $audit_owner_check$
DECLARE
  v_owner_bypasses_rls BOOLEAN;
BEGIN
  SELECT r.rolbypassrls INTO v_owner_bypasses_rls
  FROM pg_proc p
  JOIN pg_roles r ON r.oid = p.proowner
  WHERE p.oid = 'public.capture_task_change_audit()'::regprocedure;

  IF NOT COALESCE(v_owner_bypasses_rls, false) THEN
    RAISE EXCEPTION 'capture_task_change_audit owner must BYPASSRLS before task_change_audit FORCE RLS';
  END IF;
END
$audit_owner_check$;

REVOKE ALL ON FUNCTION public.capture_task_change_audit() FROM PUBLIC, anon, authenticated;

-- Archive table and retention function for audit history older than 180 days.
CREATE TABLE IF NOT EXISTS public.task_change_audit_archive
  (LIKE public.task_change_audit INCLUDING ALL);

ALTER TABLE public.task_change_audit_archive ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task_change_audit_archive FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.task_change_audit_archive FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.task_change_audit_archive TO service_role;

DROP POLICY IF EXISTS task_change_audit_archive_service_all ON public.task_change_audit_archive;
CREATE POLICY task_change_audit_archive_service_all
  ON public.task_change_audit_archive
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.archive_old_task_change_audit(
  p_retention INTERVAL DEFAULT INTERVAL '180 days'
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_moved INTEGER;
BEGIN
  WITH moved AS (
    DELETE FROM public.task_change_audit
    WHERE changed_at < now() - p_retention
    RETURNING *
  )
  INSERT INTO public.task_change_audit_archive OVERRIDING SYSTEM VALUE
  SELECT * FROM moved
  ON CONFLICT (id) DO NOTHING;

  GET DIAGNOSTICS v_moved = ROW_COUNT;
  RETURN v_moved;
END;
$$;

REVOKE ALL ON FUNCTION public.archive_old_task_change_audit(INTERVAL) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.archive_old_task_change_audit(INTERVAL) TO service_role;

-- Optional pg_cron scheduling. The migration remains safe on projects where
-- pg_cron is not installed.
DO $cron_jobs$
DECLARE
  v_job RECORD;
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE 'Skipping DR retention cron scheduling; pg_cron job table is absent.';
  ELSE
    FOR v_job IN
      SELECT jobid
      FROM cron.job
      WHERE jobname IN ('nanoflow-sync-write-quarantine-gc', 'nanoflow-task-change-audit-archive')
    LOOP
      PERFORM cron.unschedule(v_job.jobid);
    END LOOP;

    PERFORM cron.schedule(
      'nanoflow-sync-write-quarantine-gc',
      '0 3 * * *',
      $cmd$SELECT public.purge_expired_sync_write_quarantine();$cmd$
    );

    PERFORM cron.schedule(
      'nanoflow-task-change-audit-archive',
      '30 3 * * *',
      $cmd$SELECT public.archive_old_task_change_audit(INTERVAL '180 days');$cmd$
    );
  END IF;
END
$cron_jobs$;

-- -----------------------------------------------------------------------------
-- Batch task upsert: freeze switch + transitional field-intent LWW.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.batch_upsert_tasks(
  p_tasks jsonb[],
  p_project_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
DECLARE
  v_count integer := 0;
  v_task jsonb;
  v_task_id uuid;
  v_user_id uuid;
  v_title text;
  v_content text;
  v_has_content boolean;
  v_cognitive text;
  v_expected int;
  v_wait int;
  v_payload_updated timestamptz;
  v_existing_updated timestamptz;
  v_existing_stage int;
  v_existing_parent uuid;
  v_existing_deleted timestamptz;
  v_existing_exists boolean;
  v_is_stale boolean;
  v_skew_grace constant interval := interval '1 second';
  v_sync_mode text;
  v_write_intent text;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: not authenticated';
  END IF;

  SELECT value INTO v_sync_mode
  FROM public.data_safety_flags
  WHERE key = 'sync_mode';
  v_sync_mode := COALESCE(v_sync_mode, 'normal');

  IF v_sync_mode IN ('read_only', 'quarantine') THEN
    RAISE EXCEPTION 'sync_write_blocked: %', v_sync_mode;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.projects p
    WHERE p.id = p_project_id
      AND p.owner_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'Unauthorized: not project owner';
  END IF;

  FOREACH v_task IN ARRAY p_tasks
  LOOP
    v_title := v_task->>'title';
    v_content := v_task->>'content';
    v_has_content := v_task ? 'content';
    v_task_id := (v_task->>'id')::uuid;
    v_write_intent := COALESCE(
      NULLIF(v_task->>'write_intent', ''),
      NULLIF(v_task->>'writeIntent', ''),
      'task_full_upsert'
    );

    IF v_write_intent NOT IN ('task_full_upsert', 'task_text_update', 'task_structure_update', 'task_soft_delete') THEN
      RAISE EXCEPTION 'Unsupported task write intent % for task %', v_write_intent, v_task->>'id';
    END IF;

    IF v_title IS NOT NULL AND length(v_title) > 10000 THEN
      RAISE EXCEPTION 'Title too long (max 10000 chars) for task %', v_task->>'id';
    END IF;
    IF v_content IS NOT NULL AND length(v_content) > 1000000 THEN
      RAISE EXCEPTION 'Content too long (max 1000000 chars) for task %', v_task->>'id';
    END IF;

    v_expected := (v_task->>'expectedMinutes')::integer;
    v_wait := (v_task->>'waitMinutes')::integer;
    v_cognitive := v_task->>'cognitiveLoad';

    IF v_expected IS NOT NULL AND (v_expected <= 0 OR v_expected > 14400) THEN
      RAISE EXCEPTION 'expected_minutes out of range (1-14400) for task %', v_task->>'id';
    END IF;
    IF v_wait IS NOT NULL AND (v_wait <= 0 OR v_wait > 14400) THEN
      RAISE EXCEPTION 'wait_minutes out of range (1-14400) for task %', v_task->>'id';
    END IF;
    IF v_cognitive IS NOT NULL AND v_cognitive NOT IN ('low', 'high') THEN
      RAISE EXCEPTION 'cognitive_load must be low or high for task %', v_task->>'id';
    END IF;

    v_payload_updated := NULLIF(v_task->>'updated_at', '')::timestamptz;
    IF v_payload_updated IS NULL THEN
      v_payload_updated := NULLIF(v_task->>'updatedAt', '')::timestamptz;
    END IF;

    v_existing_exists := FALSE;
    SELECT TRUE, t.updated_at, t.stage, t.parent_id, t.deleted_at
      INTO v_existing_exists, v_existing_updated, v_existing_stage, v_existing_parent, v_existing_deleted
      FROM public.tasks t
      WHERE t.id = v_task_id
        AND t.project_id = p_project_id
      FOR UPDATE;

    v_is_stale := COALESCE(
      v_existing_exists
        AND v_payload_updated IS NOT NULL
        AND v_existing_updated IS NOT NULL
        AND v_existing_updated > v_payload_updated + v_skew_grace,
      FALSE
    );

    INSERT INTO public.tasks AS existing (
      id, project_id, title, content, stage, parent_id,
      "order", rank, status, x, y, short_id, deleted_at,
      attachments, expected_minutes, cognitive_load, wait_minutes, parking_meta
    )
    VALUES (
      v_task_id,
      p_project_id,
      v_title,
      CASE WHEN v_has_content THEN v_content ELSE '' END,
      NULLIF(v_task->>'stage', '')::integer,
      NULLIF(COALESCE(v_task->>'parentId', v_task->>'parent_id'), '')::uuid,
      COALESCE((v_task->>'order')::integer, 0),
      COALESCE((v_task->>'rank')::numeric, 10000),
      COALESCE(v_task->>'status', 'active'),
      COALESCE((v_task->>'x')::numeric, 0),
      COALESCE((v_task->>'y')::numeric, 0),
      v_task->>'shortId',
      NULLIF(COALESCE(v_task->>'deletedAt', v_task->>'deleted_at'), '')::timestamptz,
      '[]'::jsonb,
      v_expected,
      COALESCE(v_cognitive, 'low'),
      v_wait,
      COALESCE(v_task->'parkingMeta', v_task->'parking_meta')
    )
    ON CONFLICT (id) DO UPDATE SET
      title = CASE WHEN v_write_intent IN ('task_structure_update', 'task_soft_delete') THEN existing.title ELSE EXCLUDED.title END,
      content = CASE
        WHEN v_write_intent IN ('task_structure_update', 'task_soft_delete') THEN existing.content
        WHEN v_has_content THEN EXCLUDED.content
        ELSE existing.content
      END,
      stage = CASE WHEN v_is_stale OR v_write_intent IN ('task_text_update', 'task_soft_delete') THEN v_existing_stage ELSE EXCLUDED.stage END,
      parent_id = CASE WHEN v_is_stale OR v_write_intent IN ('task_text_update', 'task_soft_delete') THEN v_existing_parent ELSE EXCLUDED.parent_id END,
      deleted_at = CASE
        WHEN v_is_stale THEN v_existing_deleted
        WHEN v_write_intent = 'task_soft_delete' THEN EXCLUDED.deleted_at
        WHEN v_write_intent IN ('task_text_update', 'task_structure_update') THEN existing.deleted_at
        ELSE EXCLUDED.deleted_at
      END,
      "order" = CASE WHEN v_write_intent = 'task_text_update' THEN existing."order" ELSE EXCLUDED."order" END,
      rank = CASE WHEN v_write_intent = 'task_text_update' THEN existing.rank ELSE EXCLUDED.rank END,
      status = CASE WHEN v_write_intent = 'task_structure_update' THEN existing.status ELSE EXCLUDED.status END,
      x = CASE WHEN v_write_intent = 'task_text_update' THEN existing.x ELSE EXCLUDED.x END,
      y = CASE WHEN v_write_intent = 'task_text_update' THEN existing.y ELSE EXCLUDED.y END,
      short_id = EXCLUDED.short_id,
      attachments = COALESCE(existing.attachments, '[]'::jsonb),
      expected_minutes = CASE WHEN v_write_intent = 'task_structure_update' THEN existing.expected_minutes ELSE EXCLUDED.expected_minutes END,
      cognitive_load = CASE WHEN v_write_intent = 'task_structure_update' THEN existing.cognitive_load ELSE EXCLUDED.cognitive_load END,
      wait_minutes = CASE WHEN v_write_intent = 'task_structure_update' THEN existing.wait_minutes ELSE EXCLUDED.wait_minutes END,
      parking_meta = CASE WHEN v_write_intent = 'task_structure_update' THEN existing.parking_meta ELSE EXCLUDED.parking_meta END,
      updated_at = now()
    WHERE existing.project_id = p_project_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Task project mismatch';
    END IF;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) IS
  'Owner-only batch upsert with sync freeze checks, stale-write protection, missing-content guard, and transitional task write intents.';

DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) TO authenticated;
  GRANT EXECUTE ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) TO service_role;
EXCEPTION WHEN undefined_function THEN NULL;
END $$;

-- -----------------------------------------------------------------------------
-- sync_upsert_task: data-safety mode, source attribution GUCs, quarantine, and
-- richer result payload.
-- -----------------------------------------------------------------------------
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

COMMENT ON FUNCTION public.sync_upsert_task(JSONB) IS
  'Sync-protected task upsert with idempotency, protocol fence, data-safety mode, quarantine, audit attribution, and untimestamped existing-task guard.';

-- -----------------------------------------------------------------------------
-- Read-only operational views for release observation and stage-null diagnosis.
-- security_invoker keeps the underlying projects/tasks/task_change_audit RLS in
-- force for authenticated users.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.project_structure_audit
WITH (security_invoker = true)
AS
SELECT
  p.owner_id,
  p.id AS project_id,
  p.title,
  count(t.id) FILTER (WHERE t.deleted_at IS NULL) AS active_tasks,
  count(t.id) FILTER (WHERE t.deleted_at IS NULL AND t.stage IS NULL) AS stage_null,
  count(t.id) FILTER (WHERE t.deleted_at IS NULL AND t.parent_id IS NOT NULL) AS child_tasks,
  count(t.id) FILTER (
    WHERE t.deleted_at IS NULL
      AND COALESCE(t.content, '') = COALESCE(t.title, '')
  ) AS content_equals_title,
  max(t.updated_at) AS last_task_update
FROM public.projects p
LEFT JOIN public.tasks t ON t.project_id = p.id
WHERE p.deleted_at IS NULL
GROUP BY p.owner_id, p.id, p.title;

REVOKE ALL ON public.project_structure_audit FROM PUBLIC, anon;
GRANT SELECT ON public.project_structure_audit TO authenticated;

CREATE OR REPLACE VIEW public.stage_null_recovery_diagnostics
WITH (security_invoker = true)
AS
WITH active AS (
  SELECT t.*, p.owner_id
  FROM public.tasks t
  JOIN public.projects p ON p.id = t.project_id
  WHERE p.deleted_at IS NULL
    AND t.deleted_at IS NULL
)
SELECT
  a.owner_id,
  a.project_id,
  a.id AS task_id,
  a.title,
  (COALESCE(a.content, '') = COALESCE(a.title, '')) AS materialized_sig,
  a.updated_at,
  COALESCE(child.child_n, 0) AS child_n,
  child.child_stages,
  a.parent_id,
  parent.stage AS parent_stage,
  COALESCE(soft_deleted.soft_deleted_stage_candidates, 0) AS soft_deleted_stage_candidates,
  COALESCE(audit.audit_preimage_candidates, 0) AS audit_preimage_candidates,
  CASE
    WHEN COALESCE(child.child_n, 0) > 0 THEN 'S1'
    WHEN COALESCE(soft_deleted.soft_deleted_stage_candidates, 0) > 0 THEN 'S2'
    WHEN COALESCE(audit.audit_preimage_candidates, 0) > 0 THEN 'S3'
    ELSE 'S4'
  END AS evidence_class
FROM active a
LEFT JOIN active parent ON parent.id = a.parent_id
LEFT JOIN LATERAL (
  SELECT count(*) AS child_n, array_agg(DISTINCT c.stage) AS child_stages
  FROM active c
  WHERE c.parent_id = a.id
) child ON true
LEFT JOIN LATERAL (
  SELECT count(*) AS soft_deleted_stage_candidates
  FROM public.tasks d
  WHERE d.project_id = a.project_id
    AND d.deleted_at IS NOT NULL
    AND d.title = a.title
    AND d.stage IS NOT NULL
) soft_deleted ON true
LEFT JOIN LATERAL (
  SELECT count(*) AS audit_preimage_candidates
  FROM public.task_change_audit audit
  WHERE audit.task_id = a.id
    AND audit.old_stage IS NOT NULL
) audit ON true
WHERE a.stage IS NULL;

REVOKE ALL ON public.stage_null_recovery_diagnostics FROM PUBLIC, anon;
GRANT SELECT ON public.stage_null_recovery_diagnostics TO authenticated;

-- -----------------------------------------------------------------------------
-- Auto-enable RLS on future public tables.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rls_auto_enable()
RETURNS EVENT_TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  cmd RECORD;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table', 'partitioned table')
  LOOP
    IF cmd.schema_name = 'public' THEN
      EXECUTE format('ALTER TABLE IF EXISTS %s ENABLE ROW LEVEL SECURITY', cmd.object_identity);
    END IF;
  END LOOP;
END;
$$;

DO $ensure_rls_trigger$
BEGIN
  EXECUTE 'DROP EVENT TRIGGER IF EXISTS ensure_rls';
  EXECUTE 'CREATE EVENT TRIGGER ensure_rls ON ddl_command_end
    WHEN TAG IN (''CREATE TABLE'', ''CREATE TABLE AS'', ''SELECT INTO'')
    EXECUTE FUNCTION public.rls_auto_enable()';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Skipping ensure_rls event trigger; migration role lacks event trigger privilege.';
END
$ensure_rls_trigger$;

REVOKE ALL ON FUNCTION public.rls_auto_enable() FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE public.data_safety_flags IS
  'Service-controlled data safety flags. sync_mode controls normal/audit_only/read_only/quarantine behavior for sync writes.';
COMMENT ON TABLE public.sync_write_quarantine IS
  'Short-retention forensic quarantine for dangerous sync write payloads. Client roles have no direct access.';
COMMENT ON TABLE public.sync_trusted_client_deployments IS
  'Service-maintained allow-list for client deployment attribution confidence; not used for authorization.';