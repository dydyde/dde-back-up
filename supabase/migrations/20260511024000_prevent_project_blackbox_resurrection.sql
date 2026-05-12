-- =============================================================================
-- Prevent project and black box resurrection
-- =============================================================================
--
-- Root cause:
-- Projects and black_box_entries use soft delete (`deleted_at`) but lacked a
-- server-side barrier that prevents later direct upserts from clearing the
-- tombstone after another device has already deleted the row.
--
-- Fix:
-- Add a shared trigger function that blocks UPDATE statements which attempt to
-- turn a soft-deleted row back into an active row by resetting deleted_at.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.prevent_soft_deleted_row_resurrection()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN
    RAISE EXCEPTION 'soft-deleted % row cannot be resurrected via sync write', TG_TABLE_NAME
      USING ERRCODE = 'P0001',
            DETAIL = format('id=%s old_deleted_at=%s', COALESCE(NEW.id::text, '<unknown>'), OLD.deleted_at::text),
            HINT = 'Pull latest remote state instead of clearing deleted_at.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_project_resurrection ON public.projects;
CREATE TRIGGER trg_prevent_project_resurrection
  BEFORE UPDATE ON public.projects
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_soft_deleted_row_resurrection();

DROP TRIGGER IF EXISTS trg_prevent_black_box_resurrection ON public.black_box_entries;
CREATE TRIGGER trg_prevent_black_box_resurrection
  BEFORE UPDATE ON public.black_box_entries
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_soft_deleted_row_resurrection();