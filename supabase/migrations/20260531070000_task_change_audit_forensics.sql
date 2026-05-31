-- =============================================================================
-- 结构化变更取证审计层 (task_change_audit)
-- =============================================================================
--
-- 背景:
-- 2026-05 复发的 P0 中, launch-snapshot 预览摘要被旧客户端 materialize 成无时间戳
-- 假任务并经 LWW 整行回灌, 把真实根的 stage/parent_id/content 冲掉。事后排查时
-- 发现 sync_operation_log 仅记录 task_id/updated_at, 没有任何字段前像, 导致无法从
-- 数据库佐证并还原被覆盖前的 stage/parent/content。
--
-- 目标:
-- 为 tasks 的关键字段(stage / parent_id / content / title / deleted_at)建立低频、
-- 只追加的前像审计。任何结构/内容变更或删除都会留下「变更前完整快照」, 使后续同类
-- 事故可以从数据库直接重建与恢复, 而不依赖客户端日志或人工记忆。
--
-- 设计取舍:
-- - 仅在关键字段实际变化(IS DISTINCT FROM)或行被删除时写入 ⇒ 普通拖拽/正文小改之外
--   的高频无关更新不产生审计噪声, 体量可控。
-- - 记录完整 old_record JSONB 前像, 最大化恢复自由度(可还原任意被覆盖字段)。
-- - 审计写入走 SECURITY DEFINER 触发器, 绕过 RLS 由表属主写入; 客户端无写权限,
--   仅项目属主可读自己的审计。
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.task_change_audit (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id         UUID NOT NULL,
  project_id      UUID,
  owner_id        UUID,
  op              TEXT NOT NULL,                 -- 'UPDATE' | 'DELETE'
  changed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  old_stage       INTEGER,
  old_parent_id   UUID,
  old_content     TEXT,
  old_title       TEXT,
  old_updated_at  TIMESTAMPTZ,
  old_deleted_at  TIMESTAMPTZ,
  old_record      JSONB NOT NULL                 -- 变更前完整前像, 供任意字段恢复
);

CREATE INDEX IF NOT EXISTS task_change_audit_task_idx
  ON public.task_change_audit (task_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS task_change_audit_project_idx
  ON public.task_change_audit (project_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS task_change_audit_owner_idx
  ON public.task_change_audit (owner_id, changed_at DESC);

-- 触发器函数: 捕获关键字段变更/删除的前像。
CREATE OR REPLACE FUNCTION public.capture_task_change_audit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_owner UUID;
BEGIN
  SELECT p.owner_id INTO v_owner FROM public.projects p WHERE p.id = OLD.project_id;

  INSERT INTO public.task_change_audit (
    task_id, project_id, owner_id, op, old_stage, old_parent_id,
    old_content, old_title, old_updated_at, old_deleted_at, old_record
  )
  VALUES (
    OLD.id, OLD.project_id, v_owner, TG_OP, OLD.stage, OLD.parent_id,
    OLD.content, OLD.title, OLD.updated_at, OLD.deleted_at, to_jsonb(OLD)
  );

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

-- 仅在关键字段实际变化时触发(UPDATE), 以及任何硬删除(DELETE)。
DROP TRIGGER IF EXISTS trg_task_change_audit_update ON public.tasks;
CREATE TRIGGER trg_task_change_audit_update
  AFTER UPDATE ON public.tasks
  FOR EACH ROW
  WHEN (
    OLD.stage IS DISTINCT FROM NEW.stage
    OR OLD.parent_id IS DISTINCT FROM NEW.parent_id
    OR OLD.content IS DISTINCT FROM NEW.content
    OR OLD.title IS DISTINCT FROM NEW.title
    OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at
  )
  EXECUTE FUNCTION public.capture_task_change_audit();

DROP TRIGGER IF EXISTS trg_task_change_audit_delete ON public.tasks;
CREATE TRIGGER trg_task_change_audit_delete
  AFTER DELETE ON public.tasks
  FOR EACH ROW
  EXECUTE FUNCTION public.capture_task_change_audit();

-- RLS: 仅项目属主可读自己的审计; 客户端不可写(写入由 DEFINER 触发器完成)。
ALTER TABLE public.task_change_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS task_change_audit_owner_select ON public.task_change_audit;
CREATE POLICY task_change_audit_owner_select
  ON public.task_change_audit
  FOR SELECT
  TO authenticated
  USING (owner_id = auth.uid());

REVOKE ALL ON public.task_change_audit FROM PUBLIC, anon;
GRANT SELECT ON public.task_change_audit TO authenticated;

COMMENT ON TABLE public.task_change_audit IS
  '任务关键字段(stage/parent_id/content/title/deleted_at)变更与删除的只追加前像审计, 用于事故取证与恢复。';
COMMENT ON FUNCTION public.capture_task_change_audit() IS
  '由 tasks 表触发器调用, 在关键字段变更或删除时写入变更前完整前像到 task_change_audit。';
