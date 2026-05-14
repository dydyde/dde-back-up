-- =============================================================================
-- P0 同步问题修复 —— batch_upsert_tasks 陈旧写保护（"待分配块"脏数据根因修复）
-- =============================================================================
--
-- 背景：
-- 2026-04-29 上线的 sync RPC 通道使用严格 CAS（`base_updated_at` 必须精确相等），
-- 离线编辑下每条 push 都触发 RetryQueue 重排，导致大量积压。
-- 2026-05-09 `20260509145500_sync_rpc_lww_upsert_semantics.sql` 把策略放宽为
-- server-arrival LWW（到达即生效）来释放积压。但这一改动有一个未被识别的副作用：
-- 已经在 RetryQueue 里"陈旧"了的旧 payload（创建时 `stage` 为 NULL 等过期状态值）
-- 在 drain 时被无差别 apply，把已经被用户 assigned 的 task 的 `stage` 重新洗回 NULL，
-- 表现为"突然新增大量待分配块"的脏数据现象。
--
-- 同样的风险也存在于 `parent_id`（覆盖到错误父节点）和 `deleted_at`（陈旧 payload
-- 把活跃 task 软删，或者反过来把已删除 task 复活）三个"身份/状态机"字段。
--
-- 修复策略（最小侵入，不重新引入 CAS 抖动）：
-- 1. 在 `batch_upsert_tasks` 内对每条 task 做一次 SELECT 取出 existing.updated_at
-- 2. 当 payload 携带的 `updated_at` (or `updatedAt`) **明显早于** existing.updated_at
--    （大于 1 秒，覆盖时钟漂移）时认为是"陈旧写入"
-- 3. 陈旧写入只更新 UI 状态字段（title/content/x/y/order/rank/attachments 等），
--    保留 existing.stage / existing.parent_id / existing.deleted_at 不被洗白
-- 4. 当 payload 不含 `updated_at` 时按现有 server-arrival LWW 语义照常全字段覆盖，
--    与 0509 行为完全兼容（不会破坏既有的 drain 路径）
--
-- 与 fcfb06b 的客户端直写路径关系：
-- 直写路径已在客户端做了完整 CAS（task-sync-operations.service.ts:589-628）。本修复
-- 主要保护通过 `sync_upsert_task` -> `batch_upsert_tasks` 的 RPC 通道，以及初始装载
-- 路径上任何直接调用 batch_upsert_tasks 的场景。
--
-- 同时新增 sync_operation_log 两条 forensics 索引便于后续审计 / 脏数据归因。
-- =============================================================================

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
  v_cognitive text;
  v_expected int;
  v_wait int;
  v_payload_updated timestamptz;
  v_existing_updated timestamptz;
  v_existing_stage int;
  v_existing_parent uuid;
  v_existing_deleted timestamptz;
  v_existing_exists boolean;
  -- "陈旧写"判定：payload.updated_at 比 existing.updated_at 早超过 1 秒
  v_is_stale boolean;
  -- 时钟漂移容忍窗口（与客户端 ClockSyncService 的 1s 阈值对齐）
  v_skew_grace constant interval := interval '1 second';
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: not authenticated';
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
    v_task_id := (v_task->>'id')::uuid;

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

    -- 提取 payload 自带的"意图时间戳"，优先 snake_case，回退 camelCase
    v_payload_updated := NULLIF(v_task->>'updated_at', '')::timestamptz;
    IF v_payload_updated IS NULL THEN
      v_payload_updated := NULLIF(v_task->>'updatedAt', '')::timestamptz;
    END IF;

    -- 查询 existing.updated_at（行锁），用于陈旧写判定
    v_existing_exists := FALSE;
    SELECT TRUE, t.updated_at, t.stage, t.parent_id, t.deleted_at
      INTO v_existing_exists, v_existing_updated, v_existing_stage, v_existing_parent, v_existing_deleted
      FROM public.tasks t
      WHERE t.id = v_task_id
        AND t.project_id = p_project_id
      FOR UPDATE;

    -- 仅在 payload 携带 updated_at 且明显晚于 existing.updated_at 时判定为陈旧。
    -- payload 没带 updated_at 时维持现有 server-arrival LWW 行为，与 0509 兼容。
    -- COALESCE 兜底任何三值逻辑产生的 NULL（理论上 v_existing_updated 不会为 NULL，
    -- 但显式收敛到 FALSE 可避免 CASE WHEN NULL 时的隐式回退依赖）。
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
      v_content,
      (v_task->>'stage')::integer,
      (v_task->>'parentId')::uuid,
      COALESCE((v_task->>'order')::integer, 0),
      COALESCE((v_task->>'rank')::numeric, 10000),
      COALESCE(v_task->>'status', 'active'),
      COALESCE((v_task->>'x')::numeric, 0),
      COALESCE((v_task->>'y')::numeric, 0),
      v_task->>'shortId',
      NULLIF(v_task->>'deletedAt', '')::timestamptz,
      '[]'::jsonb,
      v_expected,
      COALESCE(v_cognitive, 'low'),
      v_wait,
      v_task->'parkingMeta'
    )
    ON CONFLICT (id) DO UPDATE SET
      title = EXCLUDED.title,
      content = EXCLUDED.content,
      -- 陈旧写：保留 existing 的 stage / parent_id / deleted_at，避免"待分配块"等脏数据
      stage = CASE WHEN v_is_stale THEN v_existing_stage ELSE EXCLUDED.stage END,
      parent_id = CASE WHEN v_is_stale THEN v_existing_parent ELSE EXCLUDED.parent_id END,
      deleted_at = CASE WHEN v_is_stale THEN v_existing_deleted ELSE EXCLUDED.deleted_at END,
      "order" = EXCLUDED."order",
      rank = EXCLUDED.rank,
      status = EXCLUDED.status,
      x = EXCLUDED.x,
      y = EXCLUDED.y,
      short_id = EXCLUDED.short_id,
      attachments = COALESCE(existing.attachments, '[]'::jsonb),
      expected_minutes = EXCLUDED.expected_minutes,
      cognitive_load = EXCLUDED.cognitive_load,
      wait_minutes = EXCLUDED.wait_minutes,
      parking_meta = EXCLUDED.parking_meta,
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
  'Owner-only batch upsert with stale-write protection for stage/parent_id/deleted_at (P0 dirty-data fix).';

DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) TO authenticated;
  GRANT EXECUTE ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) TO service_role;
EXCEPTION WHEN undefined_function THEN NULL;
END $$;

-- =============================================================================
-- Forensics 索引（便于排查"待分配块"等同步异常的根因追踪）
-- =============================================================================

-- 用于按实体反查最近一次成功 / 失败的 sync 操作（清理脏数据时常用）
CREATE INDEX IF NOT EXISTS idx_sync_operation_log_entity_created
  ON public.sync_operation_log (entity_type, entity_id, created_at DESC);

-- 用于按状态聚合时间窗（统计 remote-newer / client-version-rejected 风暴）
CREATE INDEX IF NOT EXISTS idx_sync_operation_log_status_created
  ON public.sync_operation_log (entity_type, status, created_at DESC);
