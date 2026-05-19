-- Reconcile sync RPC exposure after remote audit.
--
-- Remote behavior for recent sync migrations is present, but three security
-- attributes remained too broad:
-- 1. sync_check_protocol() had no fixed search_path and was callable by anon.
-- 2. sync_delete_project(jsonb) was still callable by anon.
-- 3. prevent_external_source_links_stale_write() is an internal trigger helper
--    and should not be directly executable through the exposed API schema.

ALTER FUNCTION public.sync_check_protocol()
  SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION public.sync_check_protocol() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_check_protocol() TO authenticated;

REVOKE ALL ON FUNCTION public.sync_delete_project(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_delete_project(JSONB) TO authenticated;

REVOKE ALL ON FUNCTION public.prevent_external_source_links_stale_write()
  FROM PUBLIC, anon, authenticated;