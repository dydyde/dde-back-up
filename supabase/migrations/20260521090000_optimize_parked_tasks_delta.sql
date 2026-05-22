CREATE INDEX IF NOT EXISTS idx_tasks_parking_meta_project_updated_active
  ON public.tasks (project_id, updated_at DESC)
  WHERE parking_meta IS NOT NULL
    AND deleted_at IS NULL;

COMMENT ON INDEX public.idx_tasks_parking_meta_project_updated_active IS
  'Optimizes parked/focused task delta pulls scoped by project_id and updated_at while excluding soft-deleted tasks.';
