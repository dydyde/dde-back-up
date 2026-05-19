-- Protect external_source_links from stale offline pending upserts.
-- Returning OLD from this BEFORE UPDATE trigger keeps the newer server row intact
-- while allowing PostgREST upsert callers to complete without surfacing a false
-- fatal error to the local-first retry queue.

CREATE OR REPLACE FUNCTION public.prevent_external_source_links_stale_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RETURN NEW;
  END IF;

  IF OLD.updated_at IS NOT NULL
    AND NEW.updated_at IS NOT NULL
    AND OLD.updated_at > NEW.updated_at + interval '1 second'
  THEN
    RETURN OLD;
  END IF;

  IF OLD.deleted_at IS NOT NULL
    AND NEW.deleted_at IS NULL
    AND OLD.updated_at IS NOT NULL
    AND NEW.updated_at IS NOT NULL
    AND OLD.updated_at >= NEW.updated_at - interval '1 second'
  THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.prevent_external_source_links_stale_write() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_external_source_links_prevent_stale_write
  ON public.external_source_links;

CREATE TRIGGER trg_external_source_links_prevent_stale_write
  BEFORE UPDATE ON public.external_source_links
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_external_source_links_stale_write();