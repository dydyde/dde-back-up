-- =============================================================================
-- Supabase advisor follow-up: RLS policy presence and function exposure cleanup
-- =============================================================================
-- Keeps user-facing RPCs authenticated-only, keeps trigger/maintenance helpers
-- service/internal-only, and adds explicit service_role policies to service-owned
-- tables that intentionally deny client access.
-- =============================================================================

ALTER FUNCTION public.user_preferences_keep_latest_backup_proof()
  SET search_path = public, pg_temp;

DO $optional_remote_drift_functions$
BEGIN
  IF to_regprocedure('public.cascade_soft_delete_connections()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.cascade_soft_delete_connections()
      FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.cascade_soft_delete_connections()
      TO service_role;
  END IF;
END
$optional_remote_drift_functions$;

REVOKE ALL ON FUNCTION public.cleanup_cron_job_run_details(INTERVAL)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_cron_job_run_details(INTERVAL)
  TO service_role;

REVOKE ALL ON FUNCTION public.prevent_black_box_content_loss()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prevent_black_box_content_loss()
  TO service_role;

REVOKE ALL ON FUNCTION public.get_accessible_project_probe(UUID)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_accessible_project_probe(UUID)
  TO authenticated;

REVOKE ALL ON FUNCTION public.get_all_projects_data(TIMESTAMPTZ)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_all_projects_data(TIMESTAMPTZ)
  TO authenticated;

REVOKE ALL ON FUNCTION public.get_black_box_sync_watermark()
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_black_box_sync_watermark()
  TO authenticated;

REVOKE ALL ON FUNCTION public.get_project_sync_watermark(UUID)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_project_sync_watermark(UUID)
  TO authenticated;

REVOKE ALL ON FUNCTION public.get_projects_list(INTEGER, INTEGER)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_projects_list(INTEGER, INTEGER)
  TO authenticated;

REVOKE ALL ON FUNCTION public.get_resume_recovery_probe(UUID)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_resume_recovery_probe(UUID)
  TO authenticated;

REVOKE ALL ON FUNCTION public.get_user_projects_watermark()
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_user_projects_watermark()
  TO authenticated;

REVOKE ALL ON FUNCTION public.list_project_heads_since(TIMESTAMPTZ)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_project_heads_since(TIMESTAMPTZ)
  TO authenticated;

REVOKE ALL ON FUNCTION public.user_has_project_access(UUID)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.user_has_project_access(UUID)
  TO authenticated;

REVOKE ALL ON FUNCTION public.user_is_project_owner(UUID)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.user_is_project_owner(UUID)
  TO authenticated;

DO $service_only_policies$
DECLARE
  v_table TEXT;
  v_policy TEXT;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'routine_completion_events',
    'widget_devices',
    'widget_devices_legacy_retired',
    'widget_instances',
    'widget_instances_legacy_retired',
    'widget_notify_events',
    'widget_notify_throttle',
    'widget_request_rate_limits'
  ]
  LOOP
    v_policy := v_table || '_service_all';

    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', v_table);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', v_table);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', v_policy, v_table);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',
      v_policy,
      v_table
    );
  END LOOP;
END
$service_only_policies$;
