-- ============================================================
-- NanoFlow Supabase 完整初始化脚本（统一导入）
-- ============================================================
-- 版本: 7.1.0
-- 最后验证: 2026-03-23（免费层深度优化）
--
-- 更新日志：
--   7.1.0 (2026-03-23): 免费层深度优化：
--                       - 删除 10 个确认未使用/冗余索引（节省 ~208 KB + 写入放大）
--                       - 删除索引清单：idx_task_tombstones_deleted_by, idx_connection_tombstones_deleted_by,
--                         idx_black_box_entries_project_id, idx_routine_completions_routine_id,
--                         idx_tasks_project_load, idx_connections_deleted_at, idx_projects_owner_id,
--                         idx_tasks_project_id, idx_tasks_project_active, idx_connections_project_active
--                       - 应用层配合优化：轮询间隔 5min→10min, 活跃轮询 60s→120s,
--                         Tombstone TTL 5min→30min, focus_sessions 脏检查
--   7.0.0 (2026-03-22): 移除云端备份基础设施：
--                       - 删除 backup_metadata / backup_restore_history / backup_encryption_keys 表
--                       - 删除备份相关 RLS 策略、索引、GRANT
--                       - 删除备份辅助函数（get_latest_completed_backup / mark_expired_backups / cleanup_expired_backups）
--                       - 删除 invoke_internal_edge_function / apply_backup_schedules / update_backup_schedule
--                       - 删除 backup.* app_config 配置项
--                       - 删除备份相关 cron 任务
--                       - 保留本地备份相关字段（local_backup_enabled / local_backup_interval_ms）
--   6.3.0 (2026-03-20): 个人版后端收口：
--                       - project_members / attachment_scans / quarantined_files 最终移除
--                       - user_preferences.dock_snapshot 最终移除
--                       - owner-only project access 函数与 projects 策略重写
--                       - cron 日志清理、个人数据保留清理
--   6.2.0 (2026-03-18): MCP Supabase Advisor 最终优化 + 架构修正：
--                       【根本发现】应用 100% 使用软删除（UPDATE deleted_at），而不是物理 DELETE
--                              → FK 索引对应的级联删除约束检查永未执行
--                              → 所有"FK enforcement"索引实际使用次数为 0
--                       - 【删除】不必要的 FK 索引（0 查询验证）：
--                         * idx_project_members_invited_by
--                         * idx_task_tombstones_deleted_by
--                         * idx_connection_tombstones_deleted_by
--                         * idx_quarantined_files_quarantined_by
--                         * idx_black_box_entries_project_id
--                         * idx_routine_completions_routine_id
--                         + 其他未使用索引
--                       - 【文档】添加架构说明：软删除策略与 FK 索引必要性关系
--                       - 预期性能提升：写入 +2-8%（减少 FK 检查开销）
--   6.0.0 (2026-03-15): 全量数据库优化：
--                       - 清理 13 个确认冗余的未使用索引
--                       - connections UNIQUE 约束改为部分唯一索引（仅活跃行）
--                       - 5 核心表 autovacuum 阈值调优
--                       - cleanup 函数部分索引补充（deleted_at）
--                       - authenticated 角色 statement_timeout = 30s
--                       - transcription_usage SELECT 策略统一命名
--   5.0.0 (2026-03-15): 全量安全加固 + Focus Console 汇总：
--                       - FORCE RLS 覆盖全部用户表
--                       - anon 角色零写入（仅 app_config SELECT）
--                       - 管理/维护 RPC 函数仅限 service_role
--                       - batch_upsert_tasks 升级支持 parking_meta/expected_minutes/cognitive_load/wait_minutes
--                       - 数据安全约束：TEXT 长度、数值范围、JSONB 大小限制
--                       - RLS 策略拆分为独立 CRUD（routine_tasks/routine_completions）
--                       - 补充缺失策略（transcription_usage INSERT/UPDATE/DELETE, circuit_breaker_logs INSERT）
--   4.0.0 (2026-03-15): 全量对齐迁移：
--                       - tasks 表新增 parking_meta, expected_minutes, cognitive_load, wait_minutes 列及约束
--                       - user_preferences 表新增 dock_snapshot 列
--                       - black_box_entries 表新增 focus_meta 列、来源约束、共享仓索引、FORCE RLS
--                       - 新增 focus_sessions / routine_tasks / routine_completions 表（UUID PK）
--                       - 所有新表配置 RLS（(SELECT auth.uid()) 缓存优化）、FORCE RLS、触发器、索引、GRANT
--   3.9.0 (2026-02-15): 集成 Resume 水位 RPC（get_project_sync_watermark / get_user_projects_watermark /
--                       list_project_heads_since / get_accessible_project_probe / get_black_box_sync_watermark /
--                       get_resume_recovery_probe）及配套索引
--   3.8.0 (2026-02-10): pg_cron 段与 cleanup-cron-setup.sql 对齐（函数存在性校验 + namespace 校验）
--   3.7.0 (2026-02-09): 一次性初始化增强：自动尝试配置 pg_cron 清理任务（幂等 + 容错）
--                       同步清理脚本说明，避免“已自动配置/仍提示手动配置”冲突
--   3.6.0 (2026-02-02): 性能优化：添加 get_all_projects_data 和 get_projects_list RPC 函数
--                       支持增量同步和分页查询，减少 N+1 查询问题
--   3.5.0 (2026-01-27): 性能优化：添加 get_full_project_data 和 get_user_projects_meta
--                       批量加载 RPC 函数，合并 4+ 请求为 1 个，首屏加载提升 70%
--   3.4.0 (2026-01-26): 深度数据库优化：删除未使用索引、添加 RLS 辅助函数、
--                       优化 RLS 策略使用 STABLE 函数缓存、添加部分复合索引
--   3.3.0 (2026-01-25): 添加专注模式支持：black_box_entries 表和 transcription_usage 表
--   3.2.0 (2026-01-09): 修复 batch_upsert_tasks 函数：移除不存在的 owner_id 列引用，
--                       使用 project.owner_id + project_members 进行权限校验；
--                       添加 SET search_path；修复 rank/x/y 类型为 numeric
--   3.1.0 (2026-01-07): 修复 get_dashboard_stats 使用 JOIN 查询；添加 active_connections 视图；
--                       添加 connections/user_preferences updated_at 索引；添加 Storage UPDATE 策略
--   3.0.0 (2026-01-04): 初始整合版本
--
-- 目标：新项目可在 Supabase SQL Editor 一次性执行本脚本完成全部数据库对象创建。
-- 说明：此文件由以下来源整合生成：
--   - scripts/init-database.sql（基础表 / RLS / Storage / Realtime）
--   - supabase/migrations/archive/*.sql（历史增量加固、tombstone、purge、病毒扫描、仪表盘 RPC 等）
--
-- 推荐用法：
--   1) 在 Storage 创建 attachments 私有桶
--   2) 在 SQL Editor 执行本脚本（脚本会自动尝试配置 pg_cron 清理任务）
--   3) 若实例暂不支持 pg_cron，可后续执行 scripts/cleanup-cron-setup.sql 重试
-- ============================================================

-- ============================================================
-- [BASE] scripts/init-database.sql
-- ============================================================
-- ============================================================
-- NanoFlow 数据库初始化脚本 (一次性导入)
-- ============================================================
-- 
-- 用法：在 Supabase SQL Editor 中执行此脚本完成所有数据库配置
-- 
-- 包含：
--   1. 核心表结构 (projects, tasks, connections, user_preferences)
--   2. RLS 安全策略
--   3. 自动更新时间戳触发器
--   4. 附件 RPC 函数
--   5. 定时清理函数
--   6. 实时订阅配置
--   7. Storage 策略
--
-- 版本: 2.1.0
-- 最后更新: 2025-01-01
-- ============================================================

-- ============================================
-- 13.1 软删除清理定时任务（pg_cron，可选）
-- ============================================
-- 自动更新 updated_at 时间戳
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER FUNCTION public.update_updated_at_column()
  SET search_path = pg_catalog, public;

-- ============================================
-- 0.1 RLS 优化辅助函数
-- 使用 STABLE 标记启用 PostgreSQL 函数缓存
-- ============================================

-- 获取当前用户 ID（带缓存优化）
CREATE OR REPLACE FUNCTION public.current_user_id()
RETURNS UUID
LANGUAGE SQL
STABLE
PARALLEL SAFE
AS $$
  SELECT auth.uid()
$$;

-- 检查用户是否为项目所有者
CREATE OR REPLACE FUNCTION public.user_is_project_owner(p_project_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
PARALLEL SAFE
SET search_path TO 'pg_catalog', 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = p_project_id 
    AND p.owner_id = public.current_user_id()
  )
$$;

-- 检查用户是否为项目所有者（个人版 owner-only）
CREATE OR REPLACE FUNCTION public.user_has_project_access(p_project_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
PARALLEL SAFE
SET search_path TO 'pg_catalog', 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = p_project_id 
    AND p.owner_id = public.current_user_id()
  )
$$;

-- 获取用户可访问的所有项目 ID（个人版 owner-only）
CREATE OR REPLACE FUNCTION public.user_accessible_project_ids()
RETURNS SETOF UUID
LANGUAGE SQL
STABLE
PARALLEL SAFE
SET search_path TO 'pg_catalog', 'public'
AS $$
  SELECT id FROM public.projects WHERE owner_id = public.current_user_id()
$$;

-- ============================================
-- 1. 项目表 (projects)
-- ============================================

CREATE TABLE IF NOT EXISTS public.projects (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT,
  description TEXT,
  created_date TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  deleted_at TIMESTAMP WITH TIME ZONE,
  version INTEGER DEFAULT 1,
  data JSONB DEFAULT '{}'::jsonb,
  migrated_to_v2 BOOLEAN DEFAULT FALSE
);

-- 添加新列（兼容已有表）
DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'projects' AND column_name = 'version') THEN
    ALTER TABLE public.projects ADD COLUMN version INTEGER DEFAULT 1;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'projects' AND column_name = 'migrated_to_v2') THEN
    ALTER TABLE public.projects ADD COLUMN migrated_to_v2 BOOLEAN DEFAULT FALSE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'projects' AND column_name = 'data') THEN
    ALTER TABLE public.projects ADD COLUMN data JSONB DEFAULT '{}'::jsonb;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'projects' AND column_name = 'deleted_at') THEN
    ALTER TABLE public.projects ADD COLUMN deleted_at TIMESTAMP WITH TIME ZONE;
  END IF;
END $$;

DROP TRIGGER IF EXISTS update_projects_updated_at ON public.projects;
CREATE TRIGGER update_projects_updated_at
  BEFORE UPDATE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
-- 复合索引用于增量同步查询
CREATE INDEX IF NOT EXISTS idx_projects_owner_id_updated ON public.projects(owner_id, updated_at DESC);
-- 注：以下索引已删除（未使用或被复合索引替代）：
-- - idx_projects_owner_id: 被 idx_projects_owner_id_updated 完全覆盖
-- - idx_projects_updated_at: 被复合索引替代

-- ============================================
-- 2. 项目成员表 (project_members)
-- ============================================

CREATE TABLE IF NOT EXISTS public.project_members (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role VARCHAR(20) DEFAULT 'viewer' CHECK (role IN ('viewer', 'editor', 'admin')),
  invited_by UUID REFERENCES auth.users(id),
  invited_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  accepted_at TIMESTAMP WITH TIME ZONE,
  UNIQUE(project_id, user_id)
);

ALTER TABLE public.project_members ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_project_members_project_id ON public.project_members(project_id);
CREATE INDEX IF NOT EXISTS idx_project_members_user_id ON public.project_members(user_id);
-- 【添加】invited_by FK 约束索引（2026-03-18 v6.3.0: Advisor 全量解决）
CREATE INDEX IF NOT EXISTS idx_project_members_invited_by ON public.project_members(invited_by);
COMMENT ON INDEX idx_project_members_invited_by IS 
  'FK enforcement: invited_by references auth.users(id). ON DELETE SET NULL.';


-- ============================================
-- 3. 任务表 (tasks)
-- ============================================

CREATE TABLE IF NOT EXISTS public.tasks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  parent_id UUID REFERENCES public.tasks(id) ON DELETE SET NULL,
  title TEXT NOT NULL DEFAULT '',
  content TEXT DEFAULT '',
  stage INTEGER,
  "order" INTEGER DEFAULT 0,
  rank NUMERIC DEFAULT 10000,
  status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'completed', 'archived')),
  x NUMERIC DEFAULT 0,
  y NUMERIC DEFAULT 0,
  short_id VARCHAR(20),
  priority VARCHAR(20) CHECK (priority IS NULL OR priority IN ('low', 'medium', 'high', 'urgent')),
  due_date TIMESTAMP WITH TIME ZONE,
  tags JSONB DEFAULT '[]'::jsonb,
  attachments JSONB DEFAULT '[]'::jsonb,
  -- 【2026-02-22 新增】State Overlap 停泊元数据
  parking_meta JSONB DEFAULT NULL,
  -- 【2026-02-26 新增】Dock/Focus 规划属性
  expected_minutes INTEGER DEFAULT NULL,
  cognitive_load TEXT DEFAULT 'low',
  wait_minutes INTEGER DEFAULT NULL,
  deleted_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  -- 约束
  CONSTRAINT tasks_cognitive_load_check CHECK (cognitive_load IS NULL OR cognitive_load IN ('high', 'low')),
  CONSTRAINT tasks_expected_minutes_check CHECK (expected_minutes IS NULL OR expected_minutes > 0),
  CONSTRAINT tasks_wait_minutes_check CHECK (wait_minutes IS NULL OR wait_minutes > 0),
  CONSTRAINT tasks_wait_within_expected_check CHECK (expected_minutes IS NULL OR wait_minutes IS NULL OR wait_minutes <= expected_minutes)
);

DROP TRIGGER IF EXISTS update_tasks_updated_at ON public.tasks;
CREATE TRIGGER update_tasks_updated_at
  BEFORE UPDATE ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_tasks_parent_id ON public.tasks(parent_id);
-- 停泊任务跨项目查询索引
CREATE INDEX IF NOT EXISTS idx_tasks_parking_meta
  ON public.tasks ((parking_meta IS NOT NULL))
  WHERE parking_meta IS NOT NULL;
COMMENT ON COLUMN public.tasks.parking_meta IS
  'State Overlap 停泊元数据（JSONB）。结构：{ state, parkedAt, lastVisitedAt, contextSnapshot, reminder, pinned }。NULL 表示非停泊任务。';
-- 注：以下索引已删除（未使用或被复合索引替代）：
-- - idx_tasks_project_id: 被 idx_tasks_project_updated + project_order 替代
-- - idx_tasks_project_active: 被 idx_tasks_project_updated 替代（仅 3 次使用）
-- - idx_tasks_project_load: 80KB 覆盖索引，仅 1 次使用
-- - idx_tasks_stage: 早期删除
-- - idx_tasks_deleted_at: 软删除查询较少
-- - idx_tasks_updated_at: 被复合索引替代
-- - idx_tasks_short_id: 几乎无使用

-- ============================================
-- 4. 连接表 (connections)
-- ============================================

CREATE TABLE IF NOT EXISTS public.connections (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  source_id UUID NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  target_id UUID NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  title TEXT,
  description TEXT,
  deleted_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 部分唯一索引：仅活跃连接约束（减少维护成本）
CREATE UNIQUE INDEX IF NOT EXISTS uq_connections_project_source_target_active
  ON public.connections (project_id, source_id, target_id)
  WHERE deleted_at IS NULL;

-- 兼容旧表
DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'connections' AND column_name = 'title') THEN
    ALTER TABLE public.connections ADD COLUMN title TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'connections' AND column_name = 'deleted_at') THEN
    ALTER TABLE public.connections ADD COLUMN deleted_at TIMESTAMP WITH TIME ZONE;
  END IF;
END $$;

DROP TRIGGER IF EXISTS update_connections_updated_at ON public.connections;
CREATE TRIGGER update_connections_updated_at
  BEFORE UPDATE ON public.connections
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE public.connections ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_connections_target_id ON public.connections(target_id);
-- 增量同步索引
CREATE INDEX IF NOT EXISTS idx_connections_project_updated ON public.connections(project_id, updated_at DESC);
-- 注：以下索引已删除（未使用或被复合索引替代）：
-- - idx_connections_project_active: 被 idx_connections_project_updated 替代（仅 4 次使用）
-- - idx_connections_deleted_at: 被 idx_connections_project_updated 替代
-- - idx_connections_source_id: source_id 查询走 project_id 复合索引
-- - idx_connections_deleted_at_cleanup: 清理操作较少
-- - idx_connections_updated_at: 被 idx_connections_project_updated 替代

-- cleanup 函数所需的部分索引（仅索引已删除的行）
CREATE INDEX IF NOT EXISTS idx_tasks_deleted_cleanup
  ON public.tasks (deleted_at)
  WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_connections_deleted_cleanup
  ON public.connections (deleted_at)
  WHERE deleted_at IS NOT NULL;

-- ============================================
-- 5. 用户偏好设置表 (user_preferences)
-- ============================================

CREATE TABLE IF NOT EXISTS public.user_preferences (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  theme VARCHAR(20) DEFAULT 'default',
  layout_direction VARCHAR(10) DEFAULT 'ltr',
  floating_window_pref VARCHAR(20) DEFAULT 'auto',
  -- 【2026-02-17 新增】跨设备同步字段
  color_mode VARCHAR(10) DEFAULT 'system' CHECK (color_mode IS NULL OR color_mode IN ('light', 'dark', 'system')),
  auto_resolve_conflicts BOOLEAN DEFAULT true,
  local_backup_enabled BOOLEAN DEFAULT false,
  local_backup_interval_ms INTEGER DEFAULT 3600000,
  last_backup_proof_at TIMESTAMP WITH TIME ZONE DEFAULT NULL,
  focus_preferences JSONB DEFAULT '{"gateEnabled":true,"strataEnabled":true,"blackBoxEnabled":true,"maxSnoozePerDay":3}'::jsonb,
  -- 【2026-02-25 新增】停泊坞快照（跨设备同步）
  dock_snapshot JSONB DEFAULT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id)
);

CREATE OR REPLACE FUNCTION public.user_preferences_keep_latest_backup_proof()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.last_backup_proof_at IS NOT NULL
     AND (
       NEW.last_backup_proof_at IS NULL
       OR NEW.last_backup_proof_at < OLD.last_backup_proof_at
     ) THEN
    NEW.last_backup_proof_at := OLD.last_backup_proof_at;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_user_preferences_updated_at ON public.user_preferences;
CREATE TRIGGER update_user_preferences_updated_at
  BEFORE UPDATE ON public.user_preferences
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS keep_latest_backup_proof_on_user_preferences ON public.user_preferences;
CREATE TRIGGER keep_latest_backup_proof_on_user_preferences
  BEFORE UPDATE ON public.user_preferences
  FOR EACH ROW EXECUTE FUNCTION public.user_preferences_keep_latest_backup_proof();

ALTER TABLE public.user_preferences ENABLE ROW LEVEL SECURITY;
-- 注：idx_user_preferences_user_id 已删除（user_id 已有 UNIQUE 约束）
-- 注：idx_user_preferences_updated_at 已删除（未使用）

-- ============================================
-- 5.1 黑匣子条目表 (black_box_entries) - 专注模式
-- ============================================

CREATE TABLE IF NOT EXISTS public.black_box_entries (
  -- 主键：由客户端 crypto.randomUUID() 生成
  id UUID PRIMARY KEY,
  
  -- 外键关联
  project_id UUID REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  
  -- 内容
  content TEXT NOT NULL,
  
  -- 【2026-03-04 新增】专注控制台就地创建元数据
  focus_meta JSONB DEFAULT NULL,
  
  -- 时间字段
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ DEFAULT NULL,
  
  -- 状态字段
  is_read BOOLEAN DEFAULT FALSE,
  is_completed BOOLEAN DEFAULT FALSE,
  is_archived BOOLEAN DEFAULT FALSE,
  
  -- 跳过/稍后提醒
  snooze_until DATE DEFAULT NULL,
  snooze_count INTEGER DEFAULT 0,
  
  -- 软删除
  deleted_at TIMESTAMPTZ DEFAULT NULL
);

-- 添加表注释
COMMENT ON TABLE public.black_box_entries IS '黑匣子条目表 - 语音转写记录，用于紧急捕捉想法';
COMMENT ON COLUMN public.black_box_entries.id IS '由客户端 crypto.randomUUID() 生成';
COMMENT ON COLUMN public.black_box_entries.content IS '语音转写后的文本内容';
COMMENT ON COLUMN public.black_box_entries.date IS 'YYYY-MM-DD 格式，用于按日分组';
COMMENT ON COLUMN public.black_box_entries.completed_at IS '完成状态首次落地时间，用于地质层按完成日稳定分组';
COMMENT ON COLUMN public.black_box_entries.is_read IS '是否已读；已读但未完成条目仍会在大门中出现';
COMMENT ON COLUMN public.black_box_entries.is_completed IS '是否已完成，计入地质层';
COMMENT ON COLUMN public.black_box_entries.is_archived IS '是否已归档，不显示在主列表';
COMMENT ON COLUMN public.black_box_entries.snooze_until IS '跳过至该日期，在此之前不会在大门中出现';
COMMENT ON COLUMN public.black_box_entries.snooze_count IS '已跳过次数';
COMMENT ON COLUMN public.black_box_entries.project_id IS
  '所属项目 ID；NULL 表示共享黑匣子仓（跨项目可见）';

-- focus_meta 来源约束
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'black_box_entries_focus_meta_source_check'
      AND conrelid = 'public.black_box_entries'::regclass
  ) THEN
    ALTER TABLE public.black_box_entries
      ADD CONSTRAINT black_box_entries_focus_meta_source_check
      CHECK (
        focus_meta IS NULL
        OR NOT (focus_meta ? 'source')
        OR focus_meta->>'source' = 'focus-console-inline'
      );
  END IF;
END $$;

-- 索引（仅保留增量同步必需的索引）
-- 注意：idx_black_box_user_date, idx_black_box_project, idx_black_box_pending 经验证未使用，已移除
CREATE INDEX IF NOT EXISTS idx_black_box_updated_at ON public.black_box_entries(updated_at);
-- 注：idx_black_box_entries_project_id 已删除（FK enforcement，应用查询全走 user_id + updated_at，71 天内 0 次使用）

-- updated_at 自动更新触发器
DROP TRIGGER IF EXISTS update_black_box_entries_updated_at ON public.black_box_entries;
CREATE TRIGGER update_black_box_entries_updated_at
  BEFORE UPDATE ON public.black_box_entries
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

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

-- RLS 策略（使用优化的 helper 函数）
ALTER TABLE public.black_box_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.black_box_entries FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "black_box_select_policy" ON public.black_box_entries;
CREATE POLICY "black_box_select_policy" ON public.black_box_entries 
  FOR SELECT USING (
    public.current_user_id() = user_id OR
    project_id IN (SELECT public.user_accessible_project_ids())
  );

DROP POLICY IF EXISTS "black_box_insert_policy" ON public.black_box_entries;
CREATE POLICY "black_box_insert_policy" ON public.black_box_entries
  FOR INSERT WITH CHECK (public.current_user_id() = user_id);

DROP POLICY IF EXISTS "black_box_update_policy" ON public.black_box_entries;
CREATE POLICY "black_box_update_policy" ON public.black_box_entries
  FOR UPDATE USING (public.current_user_id() = user_id);

DROP POLICY IF EXISTS "black_box_delete_policy" ON public.black_box_entries;
CREATE POLICY "black_box_delete_policy" ON public.black_box_entries
  FOR DELETE USING (public.current_user_id() = user_id);

-- ============================================
-- 5.2 转写使用量表 (transcription_usage) - 专注模式
-- ============================================

CREATE TABLE IF NOT EXISTS public.transcription_usage (
  -- 主键：由 Edge Function 使用 crypto.randomUUID() 生成
  id UUID PRIMARY KEY,
  
  -- 外键关联
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  
  -- 使用量数据
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  audio_seconds INTEGER DEFAULT 0,
  
  -- 时间戳
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 添加表注释
COMMENT ON TABLE public.transcription_usage IS '转写 API 使用量追踪表 - 用于配额控制';
COMMENT ON COLUMN public.transcription_usage.audio_seconds IS '估算的音频秒数';

-- 索引
CREATE INDEX IF NOT EXISTS idx_transcription_usage_user_date ON public.transcription_usage(user_id, date);

-- RLS 策略
ALTER TABLE public.transcription_usage ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "transcription_usage_select_policy" ON public.transcription_usage;
DROP POLICY IF EXISTS "transcription_usage_select" ON public.transcription_usage;
CREATE POLICY "transcription_usage_select" ON public.transcription_usage 
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);

-- INSERT/UPDATE/DELETE 由 Edge Function 使用 service_role 执行，无需用户策略

-- ============================================
-- 5.3 专注会话快照表 (focus_sessions) - Focus Console v3
-- ============================================

CREATE TABLE IF NOT EXISTS public.focus_sessions (
  id              UUID PRIMARY KEY,                -- 客户端 crypto.randomUUID()
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  started_at      TIMESTAMPTZ NOT NULL,
  ended_at        TIMESTAMPTZ,
  session_state   JSONB NOT NULL,                  -- FocusSessionState 序列化
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 注：idx_focus_sessions_user_id 已移除（被 idx_focus_sessions_user_updated_at 复合索引替代）
CREATE INDEX IF NOT EXISTS idx_focus_sessions_user_updated_at
  ON public.focus_sessions (user_id, updated_at DESC);

DROP TRIGGER IF EXISTS trg_focus_sessions_updated_at ON public.focus_sessions;
CREATE TRIGGER trg_focus_sessions_updated_at
  BEFORE UPDATE ON public.focus_sessions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE public.focus_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.focus_sessions FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "focus_sessions_select"
    ON focus_sessions FOR SELECT
    USING ((SELECT auth.uid()) = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "focus_sessions_insert"
    ON focus_sessions FOR INSERT
    WITH CHECK ((SELECT auth.uid()) = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "focus_sessions_update"
    ON focus_sessions FOR UPDATE
    USING ((SELECT auth.uid()) = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "focus_sessions_delete"
    ON focus_sessions FOR DELETE
    USING ((SELECT auth.uid()) = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- anon 不允许访问用户数据表
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.focus_sessions TO authenticated;
GRANT ALL ON TABLE public.focus_sessions TO service_role;

-- ============================================
-- 5.4 日常任务表 (routine_tasks) - Focus Console v3
-- ============================================

CREATE TABLE IF NOT EXISTS public.routine_tasks (
  id                UUID PRIMARY KEY,              -- 客户端 crypto.randomUUID()
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  max_times_per_day INT NOT NULL DEFAULT 1,
  is_enabled        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 注：idx_routine_tasks_user_id 已移除（被 idx_routine_tasks_user_updated 复合索引替代）
CREATE INDEX IF NOT EXISTS idx_routine_tasks_user_updated
  ON public.routine_tasks (user_id, updated_at DESC);

DROP TRIGGER IF EXISTS trg_routine_tasks_updated_at ON public.routine_tasks;
CREATE TRIGGER trg_routine_tasks_updated_at
  BEFORE UPDATE ON public.routine_tasks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE public.routine_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.routine_tasks FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "routine_tasks_select"
    ON routine_tasks FOR SELECT
    TO authenticated USING ((SELECT auth.uid()) = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "routine_tasks_insert"
    ON routine_tasks FOR INSERT
    TO authenticated WITH CHECK ((SELECT auth.uid()) = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "routine_tasks_update"
    ON routine_tasks FOR UPDATE
    TO authenticated USING ((SELECT auth.uid()) = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "routine_tasks_delete"
    ON routine_tasks FOR DELETE
    TO authenticated USING ((SELECT auth.uid()) = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- anon 不允许访问用户数据表
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.routine_tasks TO authenticated;
GRANT ALL ON TABLE public.routine_tasks TO service_role;

-- ============================================
-- 5.5 日常任务完成记录表 (routine_completions) - Focus Console v3
-- ============================================

CREATE TABLE IF NOT EXISTS public.routine_completions (
  id              UUID PRIMARY KEY,                -- 客户端 crypto.randomUUID()
  routine_id      UUID NOT NULL REFERENCES public.routine_tasks(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  date_key        DATE NOT NULL,                   -- 完成日期
  count           INT NOT NULL DEFAULT 1,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.routine_completion_events (
  id              UUID PRIMARY KEY,
  routine_id      UUID NOT NULL REFERENCES public.routine_tasks(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  date_key        DATE NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_routine_completions_user_routine_date_key
  ON public.routine_completions (user_id, routine_id, date_key);
CREATE INDEX IF NOT EXISTS idx_routine_completion_events_user_routine_date
  ON public.routine_completion_events (user_id, routine_id, date_key);

-- 注：idx_routine_completions_routine_id 已删除（routine 功能尚未上线，0 次使用）

DROP TRIGGER IF EXISTS trg_routine_completions_updated_at ON public.routine_completions;
CREATE TRIGGER trg_routine_completions_updated_at
  BEFORE UPDATE ON public.routine_completions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE public.routine_completions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.routine_completions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.routine_completion_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.routine_completion_events FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "routine_completions_select"
    ON routine_completions FOR SELECT
    TO authenticated USING ((SELECT auth.uid()) = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DROP POLICY IF EXISTS "routine_completions_insert" ON public.routine_completions;
DROP POLICY IF EXISTS "routine_completions_update" ON public.routine_completions;
DROP POLICY IF EXISTS "routine_completions_delete" ON public.routine_completions;

REVOKE INSERT, UPDATE, DELETE ON TABLE public.routine_completions FROM authenticated;
GRANT SELECT ON TABLE public.routine_completions TO authenticated;
GRANT ALL ON TABLE public.routine_completions TO service_role;
REVOKE ALL ON TABLE public.routine_completion_events FROM authenticated;
REVOKE ALL ON TABLE public.routine_completion_events FROM anon;
GRANT ALL ON TABLE public.routine_completion_events TO service_role;

-- ============================================
-- 6. 清理日志表 (cleanup_logs)
-- ============================================

CREATE TABLE IF NOT EXISTS public.cleanup_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  type VARCHAR(50) NOT NULL,
  details JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE public.cleanup_logs ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_cleanup_logs_type ON public.cleanup_logs(type);
CREATE INDEX IF NOT EXISTS idx_cleanup_logs_created_at ON public.cleanup_logs(created_at);

-- ============================================
-- 6.1 任务 Tombstone 表 (task_tombstones)
-- 用于永久删除任务后防止复活
-- ============================================

CREATE TABLE IF NOT EXISTS public.task_tombstones (
  task_id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  deleted_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  deleted_by UUID REFERENCES auth.users(id)
);

ALTER TABLE public.task_tombstones ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_task_tombstones_project_id ON public.task_tombstones(project_id);
-- 注：idx_task_tombstones_deleted_by 已删除（FK enforcement，应用使用软删除，级联从未触发）

-- RLS 策略（使用优化的 helper 函数）
DROP POLICY IF EXISTS "task_tombstones_select_owner" ON public.task_tombstones;
DROP POLICY IF EXISTS "task_tombstones_insert_owner" ON public.task_tombstones;

CREATE POLICY "task_tombstones_select_owner" ON public.task_tombstones FOR SELECT USING (
  project_id IN (SELECT public.user_accessible_project_ids())
);
CREATE POLICY "task_tombstones_insert_owner" ON public.task_tombstones FOR INSERT WITH CHECK (
  public.user_is_project_owner(project_id)
);

-- ============================================
-- 6.2 连接 Tombstone 表 (connection_tombstones)
-- 用于永久删除连接后防止复活
-- ============================================

CREATE TABLE IF NOT EXISTS public.connection_tombstones (
  connection_id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  deleted_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  deleted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

ALTER TABLE public.connection_tombstones ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_connection_tombstones_project_id ON public.connection_tombstones(project_id);
CREATE INDEX IF NOT EXISTS idx_connection_tombstones_deleted_at ON public.connection_tombstones(deleted_at);
-- 注：idx_connection_tombstones_deleted_by 已删除（同 idx_task_tombstones_deleted_by）

-- RLS 策略（使用优化的 helper 函数）
DROP POLICY IF EXISTS "connection_tombstones_select" ON public.connection_tombstones;
DROP POLICY IF EXISTS "connection_tombstones_insert" ON public.connection_tombstones;

CREATE POLICY "connection_tombstones_select" ON public.connection_tombstones FOR SELECT USING (
  project_id IN (SELECT public.user_accessible_project_ids())
);

CREATE POLICY "connection_tombstones_insert" ON public.connection_tombstones FOR INSERT WITH CHECK (
  public.user_is_project_owner(project_id)
);

-- 11. purge_rate_limits 表（速率限制）
-- ============================================

CREATE TABLE IF NOT EXISTS public.purge_rate_limits (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  call_count INTEGER DEFAULT 0,
  window_start TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE public.purge_rate_limits ENABLE ROW LEVEL SECURITY;

-- RLS 策略
DROP POLICY IF EXISTS "purge_rate_limits_own" ON public.purge_rate_limits;

CREATE POLICY "purge_rate_limits_own" ON public.purge_rate_limits
  FOR ALL
  USING (user_id = (select auth.uid()))
  WITH CHECK (user_id = (select auth.uid()));

-- ============================================
-- 自定义类型
-- ============================================

-- purge_result 复合类型
DROP TYPE IF EXISTS purge_result CASCADE;
CREATE TYPE purge_result AS (
  purged_count INTEGER,
  attachment_paths TEXT[]
);

-- ============================================
-- 触发器和函数
-- ============================================

-- 防止 tombstone 连接复活的触发器
CREATE OR REPLACE FUNCTION prevent_tombstoned_connection_writes()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.connection_tombstones WHERE connection_id = NEW.id) THEN
    -- 静默忽略，防止旧客户端数据复活
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER FUNCTION public.prevent_tombstoned_connection_writes()
  SET search_path TO 'pg_catalog', 'public';

DROP TRIGGER IF EXISTS trg_prevent_connection_resurrection ON public.connections;
CREATE TRIGGER trg_prevent_connection_resurrection
  BEFORE INSERT OR UPDATE ON public.connections
  FOR EACH ROW
  EXECUTE FUNCTION prevent_tombstoned_connection_writes();

-- 自动记录 Connection Tombstone 的触发器
CREATE OR REPLACE FUNCTION record_connection_tombstone()
RETURNS TRIGGER AS $$
BEGIN
  -- 中文注释：任何物理删除都要落 tombstone，覆盖任务 purge 的级联删除路径。
  INSERT INTO public.connection_tombstones (connection_id, project_id, deleted_at, deleted_by)
  VALUES (OLD.id, OLD.project_id, NOW(), auth.uid())
  ON CONFLICT (connection_id)
  DO UPDATE SET
    project_id = EXCLUDED.project_id,
    deleted_at = EXCLUDED.deleted_at,
    deleted_by = EXCLUDED.deleted_by;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_record_connection_tombstone ON public.connections;
CREATE TRIGGER trg_record_connection_tombstone
  BEFORE DELETE ON public.connections
  FOR EACH ROW
  EXECUTE FUNCTION record_connection_tombstone();

-- 检查连接是否已被 tombstone
CREATE OR REPLACE FUNCTION is_connection_tombstoned(p_connection_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
BEGIN
  -- 权限校验：无权访问时返回 false
  IF NOT EXISTS (
    SELECT 1 FROM public.connections c
    JOIN public.projects p ON c.project_id = p.id
    WHERE c.id = p_connection_id
      AND p.owner_id = auth.uid()
  ) THEN
    RETURN false;
  END IF;
  
  -- 检查是否在 tombstone 表中
  RETURN EXISTS (
    SELECT 1 FROM public.connection_tombstones
    WHERE connection_id = p_connection_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION is_connection_tombstoned(UUID) TO authenticated;
GRANT SELECT, INSERT ON public.connection_tombstones TO service_role;
GRANT SELECT, INSERT ON public.connection_tombstones TO authenticated;

-- 防止 tombstone 任务复活的触发器
-- prevent_tombstoned_task_writes 函数已在后面的 MIGRATION 20251212_prevent_task_resurrection.sql 中定义（第 1379 行）

-- ============================================
-- 7. RLS 策略 - Projects
-- ============================================

DROP POLICY IF EXISTS "owner select" ON public.projects;
DROP POLICY IF EXISTS "owner insert" ON public.projects;
DROP POLICY IF EXISTS "owner update" ON public.projects;
DROP POLICY IF EXISTS "owner delete" ON public.projects;

CREATE POLICY "owner select" ON public.projects FOR SELECT USING (
  (select auth.uid()) = owner_id
);
CREATE POLICY "owner insert" ON public.projects FOR INSERT WITH CHECK ((select auth.uid()) = owner_id);
CREATE POLICY "owner update" ON public.projects FOR UPDATE USING (
  (select auth.uid()) = owner_id
) WITH CHECK ((select auth.uid()) = owner_id);
CREATE POLICY "owner delete" ON public.projects FOR DELETE USING (
  (select auth.uid()) = owner_id
  AND deleted_at IS NULL
);

-- ============================================
-- 8. RLS 策略 - Project Members
-- ============================================

DROP POLICY IF EXISTS "project_members select" ON public.project_members;
DROP POLICY IF EXISTS "project_members insert" ON public.project_members;
DROP POLICY IF EXISTS "project_members update" ON public.project_members;
DROP POLICY IF EXISTS "project_members delete" ON public.project_members;

CREATE POLICY "project_members select" ON public.project_members FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.projects p WHERE p.id = project_members.project_id AND p.owner_id = auth.uid() AND p.deleted_at IS NULL)
);
CREATE POLICY "project_members insert" ON public.project_members FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM public.projects p WHERE p.id = project_members.project_id AND p.owner_id = auth.uid() AND p.deleted_at IS NULL)
);
CREATE POLICY "project_members update" ON public.project_members FOR UPDATE USING (
  EXISTS (SELECT 1 FROM public.projects p WHERE p.id = project_members.project_id AND p.owner_id = auth.uid() AND p.deleted_at IS NULL)
);
CREATE POLICY "project_members delete" ON public.project_members FOR DELETE USING (
  EXISTS (SELECT 1 FROM public.projects p WHERE p.id = project_members.project_id AND p.owner_id = auth.uid() AND p.deleted_at IS NULL)
);

-- ============================================
-- 9. RLS 策略 - Tasks
-- ============================================

DROP POLICY IF EXISTS "tasks owner select" ON public.tasks;
DROP POLICY IF EXISTS "tasks owner insert" ON public.tasks;
DROP POLICY IF EXISTS "tasks owner update" ON public.tasks;
DROP POLICY IF EXISTS "tasks owner delete" ON public.tasks;

-- 使用缓存的 helper 函数优化性能
CREATE POLICY "tasks owner select" ON public.tasks FOR SELECT USING (
  project_id IN (SELECT public.user_accessible_project_ids())
);
CREATE POLICY "tasks owner insert" ON public.tasks FOR INSERT WITH CHECK (
  public.user_has_project_access(project_id)
);
CREATE POLICY "tasks owner update" ON public.tasks FOR UPDATE USING (
  public.user_has_project_access(project_id)
);
CREATE POLICY "tasks owner delete" ON public.tasks FOR DELETE USING (
  public.user_is_project_owner(project_id)
);

-- ============================================
-- 10. RLS 策略 - Connections
-- ============================================

DROP POLICY IF EXISTS "connections owner select" ON public.connections;
DROP POLICY IF EXISTS "connections owner insert" ON public.connections;
DROP POLICY IF EXISTS "connections owner update" ON public.connections;
DROP POLICY IF EXISTS "connections owner delete" ON public.connections;

-- 使用缓存的 helper 函数优化性能
CREATE POLICY "connections owner select" ON public.connections FOR SELECT USING (
  project_id IN (SELECT public.user_accessible_project_ids())
);
CREATE POLICY "connections owner insert" ON public.connections FOR INSERT WITH CHECK (
  public.user_has_project_access(project_id)
);
CREATE POLICY "connections owner update" ON public.connections FOR UPDATE USING (
  public.user_has_project_access(project_id)
);
CREATE POLICY "connections owner delete" ON public.connections FOR DELETE USING (
  public.user_is_project_owner(project_id)
);

-- ============================================
-- 11. RLS 策略 - User Preferences
-- ============================================

DROP POLICY IF EXISTS "Users can view own preferences" ON public.user_preferences;
DROP POLICY IF EXISTS "Users can insert own preferences" ON public.user_preferences;
DROP POLICY IF EXISTS "Users can update own preferences" ON public.user_preferences;
DROP POLICY IF EXISTS "Users can delete own preferences" ON public.user_preferences;

CREATE POLICY "Users can view own preferences" ON public.user_preferences FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own preferences" ON public.user_preferences FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own preferences" ON public.user_preferences FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own preferences" ON public.user_preferences FOR DELETE USING (auth.uid() = user_id);

-- ============================================
-- 12. 附件 RPC 函数
-- ============================================

-- 添加附件（原子操作）
CREATE OR REPLACE FUNCTION append_task_attachment(p_task_id UUID, p_attachment JSONB)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public' AS $$
DECLARE
  v_current_attachments JSONB;
  v_attachment_id TEXT;
  v_project_id UUID;
BEGIN
  v_attachment_id := p_attachment->>'id';
  IF v_attachment_id IS NULL THEN RAISE EXCEPTION 'Attachment must have an id'; END IF;
  
  SELECT project_id, attachments INTO v_project_id, v_current_attachments
  FROM public.tasks
  WHERE id = p_task_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Task not found: %', p_task_id; END IF;
  IF NOT public.user_is_project_owner(v_project_id) THEN RAISE EXCEPTION 'not authorized'; END IF;
  IF v_current_attachments IS NULL THEN v_current_attachments := '[]'::JSONB; END IF;
  
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_current_attachments) AS elem WHERE elem->>'id' = v_attachment_id) THEN
    RETURN TRUE;
  END IF;
  
  UPDATE public.tasks
  SET attachments = v_current_attachments || p_attachment, updated_at = NOW()
  WHERE id = p_task_id;
  RETURN TRUE;
END; $$;

-- 移除附件（原子操作）
CREATE OR REPLACE FUNCTION remove_task_attachment(p_task_id UUID, p_attachment_id TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public' AS $$
DECLARE
  v_current_attachments JSONB;
  v_new_attachments JSONB;
  v_project_id UUID;
BEGIN
  SELECT project_id, attachments INTO v_project_id, v_current_attachments
  FROM public.tasks
  WHERE id = p_task_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Task not found: %', p_task_id; END IF;
  IF NOT public.user_is_project_owner(v_project_id) THEN RAISE EXCEPTION 'not authorized'; END IF;
  IF v_current_attachments IS NULL OR jsonb_array_length(v_current_attachments) = 0 THEN RETURN TRUE; END IF;
  
  SELECT COALESCE(jsonb_agg(elem), '[]'::JSONB) INTO v_new_attachments
  FROM jsonb_array_elements(v_current_attachments) AS elem WHERE elem->>'id' != p_attachment_id;
  
  UPDATE public.tasks
  SET attachments = v_new_attachments, updated_at = NOW()
  WHERE id = p_task_id;
  RETURN TRUE;
END; $$;

-- 授予 authenticated 用户执行权限
GRANT EXECUTE ON FUNCTION append_task_attachment(UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION remove_task_attachment(UUID, TEXT) TO authenticated;

-- ============================================
-- 13. 清理函数
-- ============================================

-- 清理软删除任务（30天后）
CREATE OR REPLACE FUNCTION cleanup_old_deleted_tasks()
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public' AS $$
DECLARE deleted_count INTEGER;
BEGIN
  WITH expired_tasks AS (
    SELECT t.id AS task_id, t.project_id
    FROM public.tasks t
    WHERE t.deleted_at IS NOT NULL
      AND t.deleted_at < NOW() - INTERVAL '30 days'
  ),
  task_tombstone_rows AS (
    INSERT INTO public.task_tombstones (task_id, project_id, deleted_at, deleted_by)
    SELECT et.task_id, et.project_id, NOW(), NULL
    FROM expired_tasks et
    ON CONFLICT (task_id)
    DO UPDATE SET
      project_id = EXCLUDED.project_id,
      deleted_at = EXCLUDED.deleted_at,
      deleted_by = EXCLUDED.deleted_by
    RETURNING task_id, project_id
  ),
  expired_connections AS (
    SELECT DISTINCT c.id AS connection_id, c.project_id
    FROM public.connections c
    JOIN task_tombstone_rows tt ON tt.project_id = c.project_id
    WHERE c.source_id = tt.task_id OR c.target_id = tt.task_id
  ),
  connection_tombstone_rows AS (
    INSERT INTO public.connection_tombstones (connection_id, project_id, deleted_at, deleted_by)
    SELECT ec.connection_id, ec.project_id, NOW(), NULL
    FROM expired_connections ec
    ON CONFLICT (connection_id)
    DO UPDATE SET
      project_id = EXCLUDED.project_id,
      deleted_at = EXCLUDED.deleted_at,
      deleted_by = EXCLUDED.deleted_by
    RETURNING connection_id
  ),
  deleted_connections AS (
    DELETE FROM public.connections c
    USING connection_tombstone_rows ct
    WHERE c.id = ct.connection_id
    RETURNING c.id
  ),
  deleted_tasks AS (
    DELETE FROM public.tasks t
    USING task_tombstone_rows tt
    WHERE t.id = tt.task_id
    RETURNING t.id
  )
  SELECT COUNT(*) INTO deleted_count FROM deleted_tasks;

  IF deleted_count > 0 THEN
    INSERT INTO public.cleanup_logs (type, details)
    VALUES ('deleted_tasks_cleanup', jsonb_build_object('deleted_count', deleted_count, 'cleanup_time', NOW(), 'mode', 'tombstone_then_delete'));
  END IF;

  RETURN deleted_count;
END; $$;

-- 清理旧日志（30天后）
CREATE OR REPLACE FUNCTION cleanup_old_logs()
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public' AS $$
DECLARE deleted_count INTEGER;
BEGIN
  WITH deleted AS (
    DELETE FROM public.cleanup_logs WHERE created_at < NOW() - INTERVAL '30 days' RETURNING id
  ) SELECT COUNT(*) INTO deleted_count FROM deleted;
  RETURN deleted_count;
END; $$;

-- 清理软删除连接（30天后）
CREATE OR REPLACE FUNCTION cleanup_old_deleted_connections()
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public' AS $$
DECLARE deleted_count INTEGER;
BEGIN
  WITH expired_connections AS (
    SELECT c.id AS connection_id, c.project_id
    FROM public.connections c
    WHERE c.deleted_at IS NOT NULL
      AND c.deleted_at < NOW() - INTERVAL '30 days'
  ),
  connection_tombstone_rows AS (
    INSERT INTO public.connection_tombstones (connection_id, project_id, deleted_at, deleted_by)
    SELECT ec.connection_id, ec.project_id, NOW(), NULL
    FROM expired_connections ec
    ON CONFLICT (connection_id)
    DO UPDATE SET
      project_id = EXCLUDED.project_id,
      deleted_at = EXCLUDED.deleted_at,
      deleted_by = EXCLUDED.deleted_by
    RETURNING connection_id
  ),
  deleted AS (
    DELETE FROM public.connections c
    USING connection_tombstone_rows ct
    WHERE c.id = ct.connection_id
    RETURNING c.id
  )
  SELECT COUNT(*) INTO deleted_count FROM deleted;
  
  IF deleted_count > 0 THEN
    INSERT INTO public.cleanup_logs (type, details)
    VALUES ('deleted_connections_cleanup', jsonb_build_object('deleted_count', deleted_count, 'cleanup_time', NOW(), 'mode', 'tombstone_then_delete'));
  END IF;
  
  RETURN deleted_count;
END; $$;

-- ============================================
-- 13.1 软删除清理定时任务（pg_cron，可选）
-- ============================================
-- 目标：在支持 pg_cron 的环境中，自动调度软删除清理任务
-- 说明：
-- - 幂等：重复执行会先移除旧任务再重建
-- - 容错：如果当前实例不支持 pg_cron，仅输出 NOTICE，不中断初始化
-- - 函数校验：调度前确认清理函数存在，避免静默失败
-- - 与 scripts/cleanup-cron-setup.sql 保持同步（后者为独立可执行版本，使用 EXCEPTION 而非 NOTICE）
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
  EXCEPTION
    WHEN OTHERS THEN
      RAISE NOTICE 'pg_cron 不可用，跳过清理定时任务配置: %', SQLERRM;
      RAISE NOTICE '可后续执行 scripts/cleanup-cron-setup.sql 重试';
      RETURN;
  END;

  -- 验证 cron schema 生效
  IF to_regnamespace('cron') IS NULL THEN
    RAISE NOTICE 'pg_cron 扩展未生效（cron schema 不存在），跳过配置';
    RETURN;
  END IF;

  -- 校验清理函数存在性（避免静默注册无效任务）
  IF to_regprocedure('public.cleanup_old_deleted_tasks()') IS NULL THEN
    RAISE NOTICE '缺少函数 cleanup_old_deleted_tasks()，跳过 cron 配置';
    RETURN;
  END IF;
  IF to_regprocedure('public.cleanup_old_deleted_connections()') IS NULL THEN
    RAISE NOTICE '缺少函数 cleanup_old_deleted_connections()，跳过 cron 配置';
    RETURN;
  END IF;
  IF to_regprocedure('public.cleanup_old_logs()') IS NULL THEN
    RAISE NOTICE '缺少函数 cleanup_old_logs()，跳过 cron 配置';
    RETURN;
  END IF;

  -- 清理旧任务（如果存在），幂等处理
  PERFORM cron.unschedule(jobid)
  FROM cron.job
  WHERE jobname IN (
    'nanoflow-cleanup-deleted-tasks',
    'nanoflow-cleanup-deleted-connections',
    'nanoflow-cleanup-logs'
  );

  -- 每天 03:10 UTC 清理软删除任务
  PERFORM cron.schedule(
    'nanoflow-cleanup-deleted-tasks',
    '10 3 * * *',
    $job$SELECT public.cleanup_old_deleted_tasks();$job$
  );

  -- 每天 03:20 UTC 清理软删除连接
  PERFORM cron.schedule(
    'nanoflow-cleanup-deleted-connections',
    '20 3 * * *',
    $job$SELECT public.cleanup_old_deleted_connections();$job$
  );

  -- 每天 03:30 UTC 清理旧日志
  PERFORM cron.schedule(
    'nanoflow-cleanup-logs',
    '30 3 * * *',
    $job$SELECT public.cleanup_old_logs();$job$
  );

  RAISE NOTICE 'pg_cron 清理任务已配置: nanoflow-cleanup-deleted-tasks, nanoflow-cleanup-deleted-connections, nanoflow-cleanup-logs';
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE '配置 pg_cron 清理任务失败（已忽略，不影响初始化）: %', SQLERRM;
    RAISE NOTICE '可后续执行 scripts/cleanup-cron-setup.sql 单独配置';
END $$;

-- 迁移函数：从 JSONB 到独立表
CREATE OR REPLACE FUNCTION migrate_project_data_to_v2(p_project_id UUID)
RETURNS TABLE (
  tasks_migrated INTEGER,
  connections_migrated INTEGER,
  errors TEXT[]
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public' AS $$
DECLARE
  project_record RECORD;
  task_data JSONB;
  conn_data JSONB;
  task_record JSONB;
  conn_record JSONB;
  task_id UUID;
  task_count INTEGER := 0;
  conn_count INTEGER := 0;
  error_list TEXT[] := ARRAY[]::TEXT[];
  old_id_to_new_id JSONB := '{}'::jsonb;
BEGIN
  -- 获取项目数据
  SELECT * INTO project_record 
  FROM public.projects 
  WHERE id = p_project_id;
  
  IF NOT FOUND THEN
    error_list := array_append(error_list, 'Project not found: ' || p_project_id::text);
    RETURN QUERY SELECT 0, 0, error_list;
    RETURN;
  END IF;
  
  -- 检查是否已迁移
  IF project_record.migrated_to_v2 = TRUE THEN
    error_list := array_append(error_list, 'Project already migrated');
    RETURN QUERY SELECT 0, 0, error_list;
    RETURN;
  END IF;
  
  -- 获取 tasks 数组
  task_data := COALESCE(project_record.data->'tasks', '[]'::jsonb);
  
  -- 迁移每个任务
  FOR task_record IN SELECT * FROM jsonb_array_elements(task_data)
  LOOP
    BEGIN
      -- 生成新的 UUID（保留原 ID 作为映射）
      task_id := COALESCE(
        (task_record->>'id')::uuid,
        gen_random_uuid()
      );
      
      -- 存储 ID 映射
      old_id_to_new_id := old_id_to_new_id || jsonb_build_object(
        task_record->>'id', 
        task_id::text
      );
      
      -- 插入任务（如果不存在）
      INSERT INTO public.tasks (
        id,
        project_id,
        parent_id,
        title,
        content,
        stage,
        "order",
        rank,
        status,
        x,
        y,
        short_id,
        priority,
        due_date,
        tags,
        attachments,
        deleted_at,
        created_at
      ) VALUES (
        task_id,
        p_project_id,
        NULL, -- parent_id 稍后更新
        COALESCE(task_record->>'title', ''),
        COALESCE(task_record->>'content', ''),
        (task_record->>'stage')::INTEGER,
        COALESCE((task_record->>'order')::INTEGER, 0),
        COALESCE((task_record->>'rank')::NUMERIC, 10000),
        COALESCE(task_record->>'status', 'active'),
        COALESCE((task_record->>'x')::NUMERIC, 0),
        COALESCE((task_record->>'y')::NUMERIC, 0),
        task_record->>'shortId',
        task_record->>'priority',
        CASE WHEN task_record->>'dueDate' IS NOT NULL 
             THEN (task_record->>'dueDate')::TIMESTAMP WITH TIME ZONE 
             ELSE NULL END,
        COALESCE(task_record->'tags', '[]'::jsonb),
        COALESCE(task_record->'attachments', '[]'::jsonb),
        CASE WHEN task_record->>'deletedAt' IS NOT NULL 
             THEN (task_record->>'deletedAt')::TIMESTAMP WITH TIME ZONE 
             ELSE NULL END,
        COALESCE(
          (task_record->>'createdDate')::TIMESTAMP WITH TIME ZONE,
          NOW()
        )
      )
      ON CONFLICT (id) DO NOTHING;
      
      task_count := task_count + 1;
      
    EXCEPTION WHEN OTHERS THEN
      error_list := array_append(error_list, 
        'Error migrating task: ' || SQLERRM || ' - ' || task_record::text
      );
    END;
  END LOOP;
  
  -- 更新 parent_id 关系
  FOR task_record IN SELECT * FROM jsonb_array_elements(task_data)
  LOOP
    IF task_record->>'parentId' IS NOT NULL THEN
      BEGIN
        UPDATE public.tasks 
        SET parent_id = (old_id_to_new_id->>(task_record->>'parentId'))::UUID
        WHERE id = (old_id_to_new_id->>(task_record->>'id'))::UUID
        AND project_id = p_project_id;
      EXCEPTION WHEN OTHERS THEN
        error_list := array_append(error_list, 
          'Error updating parent_id: ' || SQLERRM
        );
      END;
    END IF;
  END LOOP;
  
  -- 获取 connections 数组
  conn_data := COALESCE(project_record.data->'connections', '[]'::jsonb);
  
  -- 迁移每个连接
  FOR conn_record IN SELECT * FROM jsonb_array_elements(conn_data)
  LOOP
    BEGIN
      -- 插入连接
      INSERT INTO public.connections (
        project_id,
        source_id,
        target_id,
        description
      ) VALUES (
        p_project_id,
        (old_id_to_new_id->>(conn_record->>'source'))::UUID,
        (old_id_to_new_id->>(conn_record->>'target'))::UUID,
        conn_record->>'description'
      )
      ON CONFLICT (project_id, source_id, target_id) DO NOTHING;
      
      conn_count := conn_count + 1;
      
    EXCEPTION WHEN OTHERS THEN
      error_list := array_append(error_list, 
        'Error migrating connection: ' || SQLERRM || ' - ' || conn_record::text
      );
    END;
  END LOOP;
  
  -- 标记项目已迁移
  UPDATE public.projects 
  SET migrated_to_v2 = TRUE
  WHERE id = p_project_id;
  
  RETURN QUERY SELECT task_count, conn_count, error_list;
END; $$;

GRANT EXECUTE ON FUNCTION migrate_project_data_to_v2(UUID) TO authenticated;

-- 批量迁移所有项目
CREATE OR REPLACE FUNCTION migrate_all_projects_to_v2()
RETURNS TABLE (
  project_id UUID,
  project_title TEXT,
  tasks_migrated INTEGER,
  connections_migrated INTEGER,
  errors TEXT[]
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public' AS $$
DECLARE
  project_record RECORD;
  migration_result RECORD;
BEGIN
  FOR project_record IN 
    SELECT id, title 
    FROM public.projects 
    WHERE migrated_to_v2 = FALSE OR migrated_to_v2 IS NULL
  LOOP
    SELECT * INTO migration_result 
    FROM migrate_project_data_to_v2(project_record.id);
    
    RETURN QUERY SELECT 
      project_record.id,
      project_record.title,
      migration_result.tasks_migrated,
      migration_result.connections_migrated,
      migration_result.errors;
  END LOOP;
END; $$;

GRANT EXECUTE ON FUNCTION migrate_all_projects_to_v2() TO authenticated;

-- 永久删除任务（写入 tombstone + 物理删除）
-- 核心 RPC：防止已删除任务复活
CREATE OR REPLACE FUNCTION purge_tasks_v2(p_project_id UUID, p_task_ids UUID[])
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public' AS $$
DECLARE
  purged_count INTEGER;
BEGIN
  IF p_project_id IS NULL THEN
    RAISE EXCEPTION 'p_project_id is required';
  END IF;

  IF p_task_ids IS NULL OR array_length(p_task_ids, 1) IS NULL THEN
    RETURN 0;
  END IF;

  IF NOT public.user_has_project_access(p_project_id) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  -- 仅为当前 project 中真实存在的任务落 tombstone，禁止跨项目污染
  WITH to_purge AS (
    SELECT candidate.task_id
    FROM (
      SELECT t.id AS task_id
      FROM public.tasks t
      WHERE t.project_id = p_project_id
        AND t.id = ANY(p_task_ids)

      UNION

      SELECT tt.task_id
      FROM public.task_tombstones tt
      WHERE tt.project_id = p_project_id
        AND tt.task_id = ANY(p_task_ids)
    ) AS candidate
  )
  INSERT INTO public.task_tombstones (task_id, project_id, deleted_at, deleted_by)
  SELECT task_id, p_project_id, now(), auth.uid()
  FROM to_purge
  ON CONFLICT (task_id)
  DO UPDATE SET
    project_id = EXCLUDED.project_id,
    deleted_at = EXCLUDED.deleted_at,
    deleted_by = EXCLUDED.deleted_by;

  -- 中文注释：任务 purge 会直接带走关联连接，必须先显式落 connection tombstone，避免另一端长期残留旧连接。
  INSERT INTO public.connection_tombstones (connection_id, project_id, deleted_at, deleted_by)
  SELECT c.id, c.project_id, now(), auth.uid()
  FROM public.connections c
  WHERE c.project_id = p_project_id
    AND (c.source_id = ANY(p_task_ids) OR c.target_id = ANY(p_task_ids))
  ON CONFLICT (connection_id)
  DO UPDATE SET
    project_id = EXCLUDED.project_id,
    deleted_at = EXCLUDED.deleted_at,
    deleted_by = EXCLUDED.deleted_by;

  -- 删除相关连接
  DELETE FROM public.connections c
  WHERE c.project_id = p_project_id
    AND (c.source_id = ANY(p_task_ids) OR c.target_id = ANY(p_task_ids));

  -- 删除 tasks 行（如果存在）
  WITH del AS (
    DELETE FROM public.tasks t
    WHERE t.project_id = p_project_id
      AND t.id = ANY(p_task_ids)
    RETURNING t.id
  )
  SELECT count(*) INTO purged_count FROM del;

  RETURN COALESCE(purged_count, 0);
END; $$;

GRANT EXECUTE ON FUNCTION purge_tasks_v2(UUID, UUID[]) TO authenticated;

-- 清理过期软删除附件
CREATE OR REPLACE FUNCTION cleanup_deleted_attachments(retention_days INTEGER DEFAULT 30)
RETURNS TABLE(deleted_count INTEGER, storage_paths TEXT[])
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public' AS $$
DECLARE
  cutoff_date TIMESTAMPTZ;
  paths_to_delete TEXT[] := ARRAY[]::TEXT[];
  task_record RECORD;
  attachment JSONB;
  total_deleted INTEGER := 0;
BEGIN
  cutoff_date := NOW() - (retention_days || ' days')::INTERVAL;
  
  FOR task_record IN 
    SELECT t.id AS task_id, t.project_id, t.attachments, p.owner_id
    FROM tasks t JOIN projects p ON t.project_id = p.id
    WHERE t.attachments IS NOT NULL AND jsonb_array_length(t.attachments) > 0
  LOOP
    FOR attachment IN SELECT * FROM jsonb_array_elements(task_record.attachments) LOOP
      IF attachment->>'deletedAt' IS NOT NULL AND (attachment->>'deletedAt')::TIMESTAMPTZ < cutoff_date THEN
        paths_to_delete := array_append(paths_to_delete, 
          task_record.owner_id || '/' || task_record.project_id || '/' || task_record.task_id || '/' || (attachment->>'id')
        );
        total_deleted := total_deleted + 1;
      END IF;
    END LOOP;
    
    UPDATE tasks SET attachments = (
      SELECT jsonb_agg(att) FROM jsonb_array_elements(task_record.attachments) AS att
      WHERE att->>'deletedAt' IS NULL OR (att->>'deletedAt')::TIMESTAMPTZ >= cutoff_date
    ) WHERE id = task_record.task_id AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(task_record.attachments) AS att
      WHERE att->>'deletedAt' IS NOT NULL AND (att->>'deletedAt')::TIMESTAMPTZ < cutoff_date
    );
  END LOOP;
  
  RETURN QUERY SELECT total_deleted, paths_to_delete;
END; $$;

GRANT EXECUTE ON FUNCTION cleanup_deleted_attachments TO service_role;

-- ============================================
-- 14. 配置 REPLICA IDENTITY（Realtime DELETE 事件所需）
-- ============================================

ALTER TABLE public.projects REPLICA IDENTITY FULL;
ALTER TABLE public.tasks REPLICA IDENTITY FULL;
ALTER TABLE public.connections REPLICA IDENTITY FULL;

-- ============================================
-- 15. 启用实时订阅
-- ============================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'projects') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.projects;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'tasks') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.tasks;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'connections') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.connections;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'user_preferences') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.user_preferences;
  END IF;
END $$;

-- ============================================
-- 16. Storage 策略（attachments 桶）
-- ============================================

-- 用户可以上传自己的附件 (路径格式: {user_id}/{project_id}/{task_id}/{filename})
DROP POLICY IF EXISTS "Users can upload own attachments" ON storage.objects;
CREATE POLICY "Users can upload own attachments" ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'attachments' AND (storage.foldername(name))[1] = auth.uid()::text);

-- 用户可以查看自己的附件
DROP POLICY IF EXISTS "Users can view own attachments" ON storage.objects;
CREATE POLICY "Users can view own attachments" ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'attachments' AND (storage.foldername(name))[1] = auth.uid()::text);

-- 用户可以删除自己的附件
DROP POLICY IF EXISTS "Users can delete own attachments" ON storage.objects;
CREATE POLICY "Users can delete own attachments" ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'attachments' AND (storage.foldername(name))[1] = auth.uid()::text);

-- 用户可以更新自己的附件元数据（2026-01-07 补齐）
DROP POLICY IF EXISTS "Users can update own attachments" ON storage.objects;
CREATE POLICY "Users can update own attachments" ON storage.objects FOR UPDATE TO authenticated
USING (bucket_id = 'attachments' AND (storage.foldername(name))[1] = auth.uid()::text)
WITH CHECK (bucket_id = 'attachments' AND (storage.foldername(name))[1] = auth.uid()::text);

-- 兼容保留旧策略名，但读取范围收紧到 owner 自己的附件目录
DROP POLICY IF EXISTS "Project members can view attachments" ON storage.objects;
CREATE POLICY "Project members can view attachments" ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'attachments' AND (storage.foldername(name))[1] = auth.uid()::text);

-- ============================================
-- 完成！
-- ============================================
-- 
-- 数据库表：
--   ✓ projects          - 项目
--   ✓ project_members   - 项目成员（协作预留）
--   ✓ tasks             - 任务（含 deleted_at 软删除）
--   ✓ connections       - 任务连接（含 title, deleted_at）
--   ✓ user_preferences  - 用户偏好
--   ✓ cleanup_logs      - 清理日志
--   ✓ task_tombstones   - 任务永久删除记录（防止复活）
--
-- RPC 函数：
--   ✓ append_task_attachment(task_id, attachment)
--   ✓ remove_task_attachment(task_id, attachment_id)
--   ✓ cleanup_old_deleted_tasks()
--   ✓ cleanup_old_deleted_connections()
--   ✓ cleanup_old_logs()
--   ✓ cleanup_deleted_attachments(retention_days)
--   ✓ purge_tasks_v2(project_id, task_ids)  - 永久删除任务（写入 tombstone）
--
-- 定时任务：
--   - 本脚本第 13.1 节会自动尝试配置：
--       nanoflow-cleanup-deleted-tasks
--       nanoflow-cleanup-deleted-connections
--       nanoflow-cleanup-logs
--   - 若实例不支持 pg_cron，可后续执行 scripts/cleanup-cron-setup.sql 重试
--
-- Storage 桶配置（需要在 Dashboard 中创建）：
--   Name: attachments
--   Public: false
--   File size limit: 10MB
-- ============================================================
-- [MIGRATION] 20251203_sync_schema_with_code.sql
-- ============================================================
-- ============================================
-- 同步数据库 Schema 与项目代码
-- 日期: 2025-12-03
-- ============================================

-- 1. 为 user_preferences 表添加缺失的列
ALTER TABLE user_preferences
  ADD COLUMN IF NOT EXISTS layout_direction varchar(10) DEFAULT 'ltr',
  ADD COLUMN IF NOT EXISTS floating_window_pref varchar(10) DEFAULT 'auto',
  ADD COLUMN IF NOT EXISTS last_backup_proof_at timestamptz DEFAULT NULL;

-- 添加约束检查
DO $$
BEGIN
  -- 删除旧约束（如果存在）然后添加新约束
  ALTER TABLE user_preferences DROP CONSTRAINT IF EXISTS user_preferences_layout_direction_check;
  ALTER TABLE user_preferences ADD CONSTRAINT user_preferences_layout_direction_check 
    CHECK (layout_direction IS NULL OR layout_direction IN ('ltr', 'rtl'));
    
  ALTER TABLE user_preferences DROP CONSTRAINT IF EXISTS user_preferences_floating_window_pref_check;
  ALTER TABLE user_preferences ADD CONSTRAINT user_preferences_floating_window_pref_check 
    CHECK (floating_window_pref IS NULL OR floating_window_pref IN ('auto', 'fixed'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- 2. 清理日志表与清理函数已在文件早期定义（保持幂等重跑）

-- 5. 为 tasks 表的 deleted_at 添加索引（加速清理查询）
CREATE INDEX IF NOT EXISTS idx_tasks_deleted_at ON public.tasks (deleted_at)
  WHERE deleted_at IS NOT NULL;

-- 6. 为 cleanup_logs 表添加索引
CREATE INDEX IF NOT EXISTS idx_cleanup_logs_created_at ON public.cleanup_logs (created_at);
CREATE INDEX IF NOT EXISTS idx_cleanup_logs_type ON public.cleanup_logs (type);

-- 7. 授予必要的权限
REVOKE ALL ON TABLE public.cleanup_logs FROM authenticated;
REVOKE ALL ON TABLE public.cleanup_logs FROM anon;
GRANT ALL ON TABLE public.cleanup_logs TO service_role;
GRANT EXECUTE ON FUNCTION cleanup_old_deleted_tasks() TO service_role;
GRANT EXECUTE ON FUNCTION cleanup_old_logs() TO service_role;
-- ============================================================
-- [MIGRATION] 20251208_fix_realtime_delete_events.sql
-- ============================================================
-- ============================================
-- 修复 Realtime DELETE 事件问题
-- 日期: 2025-12-08
-- ============================================
--
-- 问题描述:
-- 当在一个设备上删除任务时，其他设备无法接收到删除事件
-- 这是因为表缺少 REPLICA IDENTITY FULL 配置
--
-- 解决方案:
-- 设置 REPLICA IDENTITY FULL 确保 DELETE 事件包含完整的旧行数据
-- 这样客户端可以正确识别被删除的记录

-- 设置 REPLICA IDENTITY FULL
-- 注意：这会增加一些存储开销，但对于确保跨设备同步的正确性是必需的
ALTER TABLE public.projects REPLICA IDENTITY FULL;
ALTER TABLE public.tasks REPLICA IDENTITY FULL;
ALTER TABLE public.connections REPLICA IDENTITY FULL;

-- 验证配置（可选，用于调试）
-- SELECT 
--   n.nspname as schemaname, 
--   c.relname as tablename, 
--   CASE c.relreplident
--     WHEN 'd' THEN 'DEFAULT (primary key)'
--     WHEN 'n' THEN 'NOTHING'
--     WHEN 'f' THEN 'FULL'
--     WHEN 'i' THEN 'INDEX'
--   END as replica_identity
-- FROM pg_class c
-- JOIN pg_namespace n ON n.oid = c.relnamespace
-- WHERE n.nspname = 'public' 
-- AND c.relname IN ('projects', 'tasks', 'connections');
-- ============================================================
-- [MIGRATION] 20251212_hardening_and_indexes.sql
-- ============================================================
-- ============================================
-- 安全加固 + 性能小优化（search_path + 外键索引 + RLS initplan）
-- 日期: 2025-12-12
-- ============================================

-- 1) 性能：为未覆盖的外键列补齐索引
-- 注：idx_project_members_invited_by 已移除（invited_by 极少作为查询条件）

CREATE INDEX IF NOT EXISTS idx_task_tombstones_project_id
  ON public.task_tombstones (project_id);

-- 2) 安全：为函数显式设置 search_path（避免 search_path 可变引发的劫持风险）
-- 说明：优先 pg_catalog，确保内建函数解析更安全。

DROP POLICY IF EXISTS "owner delete" ON public.projects;
CREATE POLICY "owner delete" ON public.projects
  FOR DELETE
  TO public
  USING ((select auth.uid()) = owner_id);

-- project_members
DROP POLICY IF EXISTS "project_members select" ON public.project_members;
CREATE POLICY "project_members select" ON public.project_members
  FOR SELECT
  TO public
  USING (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = project_members.project_id
        AND p.owner_id = (select auth.uid())
        AND p.deleted_at IS NULL
    )
  );

DROP POLICY IF EXISTS "project_members insert" ON public.project_members;
CREATE POLICY "project_members insert" ON public.project_members
  FOR INSERT
  TO public
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = project_members.project_id
        AND p.owner_id = (select auth.uid())
        AND p.deleted_at IS NULL
    )
  );

DROP POLICY IF EXISTS "project_members update" ON public.project_members;
CREATE POLICY "project_members update" ON public.project_members
  FOR UPDATE
  TO public
  USING (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = project_members.project_id
        AND p.owner_id = (select auth.uid())
        AND p.deleted_at IS NULL
    )
  );

DROP POLICY IF EXISTS "project_members delete" ON public.project_members;
CREATE POLICY "project_members delete" ON public.project_members
  FOR DELETE
  TO public
  USING (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = project_members.project_id
        AND p.owner_id = (select auth.uid())
        AND p.deleted_at IS NULL
    )
  );

-- tasks
DROP POLICY IF EXISTS "tasks owner select" ON public.tasks;
CREATE POLICY "tasks owner select" ON public.tasks
  FOR SELECT
  TO public
  USING (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = tasks.project_id
        AND p.owner_id = (select auth.uid())
        AND p.deleted_at IS NULL
    )
  );

DROP POLICY IF EXISTS "tasks owner insert" ON public.tasks;
CREATE POLICY "tasks owner insert" ON public.tasks
  FOR INSERT
  TO public
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = tasks.project_id
        AND p.owner_id = (select auth.uid())
        AND p.deleted_at IS NULL
    )
  );

DROP POLICY IF EXISTS "tasks owner update" ON public.tasks;
CREATE POLICY "tasks owner update" ON public.tasks
  FOR UPDATE
  TO public
  USING (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = tasks.project_id
        AND p.owner_id = (select auth.uid())
        AND p.deleted_at IS NULL
    )
  );

DROP POLICY IF EXISTS "tasks owner delete" ON public.tasks;
CREATE POLICY "tasks owner delete" ON public.tasks
  FOR DELETE
  TO public
  USING (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = tasks.project_id
        AND p.owner_id = (select auth.uid())
        AND p.deleted_at IS NULL
    )
  );

-- connections
DROP POLICY IF EXISTS "connections owner select" ON public.connections;
CREATE POLICY "connections owner select" ON public.connections
  FOR SELECT
  TO public
  USING (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = connections.project_id
        AND p.owner_id = (select auth.uid())
        AND p.deleted_at IS NULL
    )
  );

DROP POLICY IF EXISTS "connections owner insert" ON public.connections;
CREATE POLICY "connections owner insert" ON public.connections
  FOR INSERT
  TO public
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = connections.project_id
        AND p.owner_id = (select auth.uid())
        AND p.deleted_at IS NULL
    )
  );

DROP POLICY IF EXISTS "connections owner update" ON public.connections;
CREATE POLICY "connections owner update" ON public.connections
  FOR UPDATE
  TO public
  USING (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = connections.project_id
        AND p.owner_id = (select auth.uid())
        AND p.deleted_at IS NULL
    )
  );

DROP POLICY IF EXISTS "connections owner delete" ON public.connections;
CREATE POLICY "connections owner delete" ON public.connections
  FOR DELETE
  TO public
  USING (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = connections.project_id
        AND p.owner_id = (select auth.uid())
        AND p.deleted_at IS NULL
    )
  );

-- user_preferences
DROP POLICY IF EXISTS "Users can view own preferences" ON public.user_preferences;
CREATE POLICY "Users can view own preferences" ON public.user_preferences
  FOR SELECT
  TO public
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can insert own preferences" ON public.user_preferences;
CREATE POLICY "Users can insert own preferences" ON public.user_preferences
  FOR INSERT
  TO public
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can update own preferences" ON public.user_preferences;
CREATE POLICY "Users can update own preferences" ON public.user_preferences
  FOR UPDATE
  TO public
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can delete own preferences" ON public.user_preferences;
CREATE POLICY "Users can delete own preferences" ON public.user_preferences
  FOR DELETE
  TO public
  USING ((select auth.uid()) = user_id);

-- task_tombstones
DROP POLICY IF EXISTS "task_tombstones_select_owner" ON public.task_tombstones;
CREATE POLICY "task_tombstones_select_owner" ON public.task_tombstones
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = task_tombstones.project_id
        AND p.owner_id = (select auth.uid())
    )
  );

DROP POLICY IF EXISTS "task_tombstones_insert_owner" ON public.task_tombstones;
CREATE POLICY "task_tombstones_insert_owner" ON public.task_tombstones
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = task_tombstones.project_id
        AND p.owner_id = (select auth.uid())
    )
  );
-- ============================================================
-- [MIGRATION] 20251212_prevent_task_resurrection.sql
-- ============================================================
-- ============================================
-- 阻止“永久删除任务”被旧端 upsert 复活
-- 日期: 2025-12-12
-- ============================================
--
-- 背景：
-- 1) 物理 DELETE 后，如果某个离线/旧版本客户端仍持有该 task 并执行 upsert，
--    Postgres 会将其当作 INSERT，从而把任务“插回”云端（复活）。
-- 2) 解决思路：为“永久删除”建立不可逆 tombstone。
--    - purge RPC：写入 tombstone + 删除 tasks 行（以及相关 connections）。
--    - trigger：拦截对 tombstoned task_id 的 INSERT/UPDATE，直接丢弃写入，避免复活。

-- 注意：task_tombstones 表及相关 RLS 策略已在文件早期（第 248 行附近）创建

-- 2) purge RPC：批量永久删除任务（写 tombstone + 删除 tasks + 删除相关 connections）
CREATE OR REPLACE FUNCTION public.purge_tasks(p_task_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  purged_count integer;
BEGIN
  IF p_task_ids IS NULL OR array_length(p_task_ids, 1) IS NULL THEN
    RETURN 0;
  END IF;

  WITH to_purge AS (
    SELECT t.id AS task_id, t.project_id
    FROM public.tasks t
    JOIN public.projects p ON p.id = t.project_id
    WHERE t.id = ANY(p_task_ids)
      AND p.owner_id = auth.uid()
  ),
  ins AS (
    INSERT INTO public.task_tombstones (task_id, project_id, deleted_at, deleted_by)
    SELECT task_id, project_id, now(), auth.uid()
    FROM to_purge
    ON CONFLICT (task_id)
    DO UPDATE SET
      project_id = EXCLUDED.project_id,
      deleted_at = EXCLUDED.deleted_at,
      deleted_by = EXCLUDED.deleted_by
    RETURNING task_id
  ),
  del_connections AS (
    DELETE FROM public.connections c
    USING to_purge tp
    WHERE c.project_id = tp.project_id
      AND (c.source_id = tp.task_id OR c.target_id = tp.task_id)
  ),
  del_tasks AS (
    DELETE FROM public.tasks t
    USING to_purge tp
    WHERE t.id = tp.task_id
    RETURNING t.id
  )
  SELECT count(*) INTO purged_count FROM del_tasks;

  RETURN COALESCE(purged_count, 0);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.purge_tasks(uuid[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.purge_tasks(uuid[]) TO service_role;

-- safe_delete_tasks: 安全删除任务（软删除+限制）
CREATE OR REPLACE FUNCTION public.safe_delete_tasks(p_task_ids uuid[], p_project_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  deleted_count integer;
  total_tasks integer;
BEGIN
  -- 参数校验
  IF p_task_ids IS NULL OR array_length(p_task_ids, 1) IS NULL THEN
    RETURN 0;
  END IF;

  IF p_project_id IS NULL THEN
    RAISE EXCEPTION 'p_project_id is required';
  END IF;

  IF NOT public.user_has_project_access(p_project_id) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  -- 获取项目总任务数
  SELECT count(*) INTO total_tasks
  FROM public.tasks
  WHERE project_id = p_project_id AND deleted_at IS NULL;

  -- 限制：单次最多删除 50 条或 50% 的任务
  IF array_length(p_task_ids, 1) > 50 THEN
    RAISE EXCEPTION 'Cannot delete more than 50 tasks at once';
  END IF;

  IF array_length(p_task_ids, 1) > (total_tasks * 0.5) THEN
    RAISE EXCEPTION 'Cannot delete more than 50%% of tasks at once';
  END IF;

  -- 软删除任务
  WITH del AS (
    UPDATE public.tasks
    SET deleted_at = now()
    WHERE id = ANY(p_task_ids)
      AND project_id = p_project_id
      AND deleted_at IS NULL
    RETURNING id
  )
  SELECT count(*) INTO deleted_count FROM del;

  RETURN COALESCE(deleted_count, 0);
END;
$$;

GRANT EXECUTE ON FUNCTION public.safe_delete_tasks(uuid[], uuid) TO authenticated;

-- purge_tasks_v3: 永久删除任务并返回附件路径（带速率限制）
CREATE OR REPLACE FUNCTION public.purge_tasks_v3(p_project_id uuid, p_task_ids uuid[])
RETURNS purge_result
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  result purge_result;
  v_owner_id uuid;
  task_record RECORD;
  attachment jsonb;
  attachment_paths text[] := ARRAY[]::text[];
  file_ext text;
  current_user_id uuid;
  rate_limit_record RECORD;
  max_calls_per_minute CONSTANT integer := 10;
  max_tasks_per_call CONSTANT integer := 100;
BEGIN
  result.purged_count := 0;
  result.attachment_paths := ARRAY[]::text[];
  current_user_id := auth.uid();

  IF p_project_id IS NULL THEN
    RAISE EXCEPTION 'p_project_id is required';
  END IF;

  IF p_task_ids IS NULL OR array_length(p_task_ids, 1) IS NULL THEN
    RETURN result;
  END IF;
  
  -- 速率限制检查
  IF array_length(p_task_ids, 1) > max_tasks_per_call THEN
    RAISE EXCEPTION 'Too many tasks in single request. Maximum: %', max_tasks_per_call;
  END IF;
  
  -- 检查并更新调用次数
  INSERT INTO public.purge_rate_limits (user_id, call_count, window_start)
  VALUES (current_user_id, 1, now())
  ON CONFLICT (user_id) DO UPDATE SET
    call_count = CASE 
      WHEN purge_rate_limits.window_start < now() - interval '1 minute' 
      THEN 1 
      ELSE purge_rate_limits.call_count + 1 
    END,
    window_start = CASE 
      WHEN purge_rate_limits.window_start < now() - interval '1 minute' 
      THEN now() 
      ELSE purge_rate_limits.window_start 
    END
  RETURNING call_count INTO rate_limit_record;
  
  IF rate_limit_record.call_count > max_calls_per_minute THEN
    RAISE EXCEPTION 'Rate limit exceeded. Maximum % calls per minute', max_calls_per_minute;
  END IF;

  IF NOT public.user_has_project_access(p_project_id) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  SELECT p.owner_id INTO v_owner_id
  FROM public.projects p
  WHERE p.id = p_project_id;

  -- 收集附件路径
  FOR task_record IN
    SELECT t.id AS task_id, t.attachments
    FROM public.tasks t
    WHERE t.project_id = p_project_id
      AND t.id = ANY(p_task_ids)
      AND t.attachments IS NOT NULL
      AND jsonb_array_length(t.attachments) > 0
  LOOP
    FOR attachment IN SELECT * FROM jsonb_array_elements(task_record.attachments)
    LOOP
      file_ext := COALESCE(
        NULLIF(SUBSTRING((attachment->>'name') FROM '\\.([^.]+)$'), ''),
        'bin'
      );
      
      attachment_paths := array_append(
        attachment_paths,
        v_owner_id::text || '/' || 
        p_project_id::text || '/' || 
        task_record.task_id::text || '/' || 
        (attachment->>'id') || '.' || file_ext
      );
      
      IF attachment->>'thumbnailUrl' IS NOT NULL THEN
        attachment_paths := array_append(
          attachment_paths,
          v_owner_id::text || '/' || 
          p_project_id::text || '/' || 
          task_record.task_id::text || '/' || 
          (attachment->>'id') || '_thumb.webp'
        );
      END IF;
    END LOOP;
  END LOOP;

  -- 仅为当前 project 中真实存在的任务落 tombstone，禁止跨项目污染
  INSERT INTO public.task_tombstones (task_id, project_id, deleted_at, deleted_by)
  SELECT purge_scope.task_id, p_project_id, now(), auth.uid()
  FROM (
    SELECT candidate.task_id
    FROM (
      SELECT t.id AS task_id
      FROM public.tasks t
      WHERE t.project_id = p_project_id
        AND t.id = ANY(p_task_ids)

      UNION

      SELECT tt.task_id
      FROM public.task_tombstones tt
      WHERE tt.project_id = p_project_id
        AND tt.task_id = ANY(p_task_ids)
    ) AS candidate
  ) AS purge_scope
  ON CONFLICT (task_id)
  DO UPDATE SET
    project_id = EXCLUDED.project_id,
    deleted_at = EXCLUDED.deleted_at,
    deleted_by = EXCLUDED.deleted_by;

  -- 中文注释：任务 purge 会直接带走关联连接，必须先显式落 connection tombstone，避免另一端长期残留旧连接。
  INSERT INTO public.connection_tombstones (connection_id, project_id, deleted_at, deleted_by)
  SELECT c.id, c.project_id, now(), auth.uid()
  FROM public.connections c
  WHERE c.project_id = p_project_id
    AND (c.source_id = ANY(p_task_ids) OR c.target_id = ANY(p_task_ids))
  ON CONFLICT (connection_id)
  DO UPDATE SET
    project_id = EXCLUDED.project_id,
    deleted_at = EXCLUDED.deleted_at,
    deleted_by = EXCLUDED.deleted_by;

  -- 删除相关连接
  DELETE FROM public.connections c
  WHERE c.project_id = p_project_id
    AND (c.source_id = ANY(p_task_ids) OR c.target_id = ANY(p_task_ids));

  -- 删除 tasks 行
  WITH del AS (
    DELETE FROM public.tasks t
    WHERE t.project_id = p_project_id
      AND t.id = ANY(p_task_ids)
    RETURNING t.id
  )
  SELECT count(*) INTO result.purged_count FROM del;

  result.attachment_paths := attachment_paths;
  RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.purge_tasks_v3(uuid, uuid[]) TO authenticated;

-- 3) 防复活触发器：拦截对已 tombstone task_id 的 INSERT/UPDATE
CREATE OR REPLACE FUNCTION public.prevent_tombstoned_task_writes()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.task_tombstones tt
    WHERE tt.task_id = NEW.id
  ) THEN
    -- 静默丢弃写入，避免旧端 upsert 复活
    RETURN NULL;
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.prevent_tombstoned_task_writes()
  SET search_path TO 'pg_catalog', 'public';

DROP TRIGGER IF EXISTS trg_prevent_tombstoned_task_writes ON public.tasks;
CREATE TRIGGER trg_prevent_tombstoned_task_writes
BEFORE INSERT OR UPDATE ON public.tasks
FOR EACH ROW
EXECUTE FUNCTION public.prevent_tombstoned_task_writes();
-- ============================================================
-- [MIGRATION] 20251212_purge_tasks_v2.sql
-- ============================================================
-- ============================================
-- purge_tasks_v2: 支持在 tasks 行不存在时也能落 tombstone
-- 日期: 2025-12-12
-- ============================================
-- 目的：
-- - 客户端“永久删除”时，优先写入不可逆 tombstone，阻断旧端/离线端 upsert 复活。
-- - 即使 tasks 行已不存在（例如历史物理删除），也能通过 project_id 强制落 tombstone。

-- 注意：purge_tasks_v2 函数已在前面定义（第 708 行）

-- 授予额外的权限
GRANT EXECUTE ON FUNCTION public.purge_tasks_v2(uuid, uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.purge_tasks_v2(uuid, uuid[]) TO service_role;
-- ============================================================
-- [MIGRATION] 20251213_tombstone_aware_task_loading.sql
-- ============================================================
-- ============================================
-- Tombstone-aware task loading optimization
-- 日期: 2025-12-13
-- ============================================
--
-- 背景：
-- - 修复了"电脑端删除的任务在手机端登录后恢复"的问题
-- - 原因：loadTasks 函数没有检查 task_tombstones 表，也没有过滤软删除的任务
-- - 解决方案：
--   1. 在 loadTasks 中同时检查 tombstone 和 deleted_at
--   2. 创建辅助视图和函数简化客户端查询
--   3. 添加性能索引
--
-- 优化：
-- - 创建视图简化客户端查询
-- - 添加性能索引
-- - 确保 RLS 策略正确应用
--
-- 修复的具体问题：
-- 1. 永久删除的任务（有 tombstone）在其他设备上复活
-- 2. 软删除的任务（deleted_at 不为 null）在其他设备上复活
-- 3. 待分配任务（stage = null）的删除也会在其他设备上恢复

-- 1) 创建视图：自动过滤已 tombstone 和软删除的任务
CREATE OR REPLACE VIEW public.active_tasks AS
SELECT t.*
FROM public.tasks t
WHERE NOT EXISTS (
  SELECT 1 
  FROM public.task_tombstones tt 
  WHERE tt.task_id = t.id
)
AND t.deleted_at IS NULL;

-- 为视图设置 RLS（继承基表的 RLS）
ALTER VIEW public.active_tasks SET (security_invoker = true);

COMMENT ON VIEW public.active_tasks IS '
自动过滤已被永久删除（tombstone）和软删除（deleted_at 不为 null）的任务的视图。
客户端应优先使用此视图而非直接查询 tasks 表，以避免已删除任务复活。
此视图解决了以下问题：
1. 永久删除的任务在其他设备上复活
2. 软删除的任务在其他设备上复活  
3. 待分配任务（stage = null）的删除也会在其他设备上恢复
';

-- 1.1) 创建 active_connections 视图：对应 active_tasks（2026-01-07 补齐）
CREATE OR REPLACE VIEW public.active_connections AS
SELECT 
    c.id,
    c.project_id,
    c.source_id,
    c.target_id,
    c.title,
    c.description,
    c.created_at,
    c.updated_at,
    c.deleted_at
FROM public.connections c
WHERE NOT EXISTS (
    SELECT 1 
    FROM public.connection_tombstones ct 
    WHERE ct.connection_id = c.id
)
AND c.deleted_at IS NULL;

ALTER VIEW public.active_connections SET (security_invoker = true);

COMMENT ON VIEW public.active_connections IS '
Tombstone-aware 连接加载视图 - 过滤掉已永久删除的连接和软删除的连接。
与 active_tasks 视图逻辑一致，客户端应优先使用此视图而非直接查询 connections 表。
创建于 2026-01-07。
';

-- 2) 创建辅助函数：批量检查任务是否在 tombstone 中
CREATE OR REPLACE FUNCTION public.is_task_tombstoned(p_task_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT EXISTS (
    SELECT 1 
    FROM public.task_tombstones 
    WHERE task_id = p_task_id
  );
$$;

ALTER FUNCTION public.is_task_tombstoned(uuid)
  SET search_path TO 'pg_catalog', 'public';

GRANT EXECUTE ON FUNCTION public.is_task_tombstoned(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_task_tombstoned(uuid) TO service_role;

COMMENT ON FUNCTION public.is_task_tombstoned IS '
检查指定任务是否已被永久删除（在 tombstone 表中）。
返回 true 表示该任务已被永久删除，不应被恢复或显示。
';

-- 3) 性能优化：确保 tombstone 查询索引存在
-- （这个索引应该已在 20251212_hardening_and_indexes.sql 中创建，这里做防御性检查）
CREATE INDEX IF NOT EXISTS idx_task_tombstones_task_id 
  ON public.task_tombstones (task_id);

-- 4) 数据一致性检查：查找存在 tombstone 但仍有 tasks 行的数据
-- （这些数据理论上不应存在，因为 purge RPC 会同时删除）
DO $$
DECLARE
  inconsistent_count integer;
BEGIN
  SELECT COUNT(*) INTO inconsistent_count
  FROM public.task_tombstones tt
  INNER JOIN public.tasks t ON t.id = tt.task_id;
  
  IF inconsistent_count > 0 THEN
    RAISE WARNING 'Found % tasks that exist in both tasks and task_tombstones tables. Consider running cleanup.', inconsistent_count;
  END IF;
END $$;
-- ============================================================
-- [MIGRATION] 20251215_sync_mechanism_hardening.sql
-- ============================================================
-- ============================================================================
-- 同步机制强化迁移脚本
-- 创建日期: 2025-12-15
-- 目的:
--   1. 为 user_preferences 表启用 REPLICA IDENTITY FULL
--   2. 添加缺失的索引以优化实时同步性能
--   3. 强化数据完整性约束
-- ============================================================================

-- ============================================================================
-- 1. 为 user_preferences 启用 REPLICA IDENTITY FULL
-- 这确保 Supabase Realtime 的 DELETE 事件能够返回完整的行数据
-- 没有这个设置，DELETE 事件只会返回主键，导致前端无法正确处理删除
-- ============================================================================
ALTER TABLE public.user_preferences REPLICA IDENTITY FULL;

-- 验证设置（通过注释记录，实际验证需要在 psql 中执行）
-- SELECT relreplident FROM pg_class WHERE relname = 'user_preferences';
-- 期望返回 'f' (full)

-- ============================================================================
-- 2. 为实时同步添加优化索引
-- 这些索引优化 Realtime 订阅的过滤查询
-- ============================================================================

-- 优化 projects 表的 owner_id 查询（如果不存在）
CREATE INDEX IF NOT EXISTS idx_projects_owner_id_updated 
ON public.projects(owner_id, updated_at DESC);

-- 优化 tasks 表的 project_id + updated_at 查询
CREATE INDEX IF NOT EXISTS idx_tasks_project_updated 
ON public.tasks(project_id, updated_at DESC);

-- 优化 user_preferences 表的 user_id 查询
CREATE INDEX IF NOT EXISTS idx_user_preferences_user_id 
ON public.user_preferences(user_id);

-- ============================================================================
-- 3. 添加用于冲突检测的 updated_at 触发器（如果不存在）
-- 确保每次更新都会自动更新 updated_at 字段
-- ============================================================================

-- 创建通用的 updated_at 触发器函数
CREATE OR REPLACE FUNCTION public.trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER FUNCTION public.trigger_set_updated_at()
  SET search_path TO 'pg_catalog', 'public';

-- 为 projects 表添加触发器
DROP TRIGGER IF EXISTS set_updated_at ON public.projects;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.projects
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_set_updated_at();

-- 为 tasks 表添加触发器
DROP TRIGGER IF EXISTS set_updated_at ON public.tasks;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.tasks
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_set_updated_at();

-- 为 connections 表添加触发器
DROP TRIGGER IF EXISTS set_updated_at ON public.connections;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.connections
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_set_updated_at();

-- 为 user_preferences 表添加触发器
DROP TRIGGER IF EXISTS set_updated_at ON public.user_preferences;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.user_preferences
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_set_updated_at();

-- ============================================================================
-- 4. 添加版本号自动递增约束
-- 防止版本号回退，用于乐观锁冲突检测
-- ============================================================================

-- 创建版本号验证函数
CREATE OR REPLACE FUNCTION public.check_version_increment()
RETURNS TRIGGER AS $$
BEGIN
  -- 只在版本号存在且被修改时检查
  IF OLD.version IS NOT NULL AND NEW.version IS NOT NULL THEN
    -- 允许版本号增加或保持不变（用于冲突解决后的强制覆盖）
    -- 但不允许回退
    IF NEW.version < OLD.version THEN
      RAISE WARNING 'Version regression detected: % -> %, allowing update but logging', OLD.version, NEW.version;
      -- 注意：这里只是警告，不阻止更新，因为冲突解决可能需要这样做
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER FUNCTION public.check_version_increment()
  SET search_path TO 'pg_catalog', 'public';

-- 为 projects 表添加版本检查触发器
DROP TRIGGER IF EXISTS check_version_increment ON public.projects;
CREATE TRIGGER check_version_increment
  BEFORE UPDATE ON public.projects
  FOR EACH ROW
  EXECUTE FUNCTION public.check_version_increment();

-- ============================================================================
-- 5. 添加死锁预防索引
-- 确保并发更新时有一致的锁定顺序
-- ============================================================================

-- 添加 tasks 表的 id 索引用于批量更新
CREATE INDEX IF NOT EXISTS idx_tasks_id_project_id 
ON public.tasks(id, project_id);

-- 添加 connections 表的复合索引用于批量删除
CREATE INDEX IF NOT EXISTS idx_connections_source_target 
ON public.connections(source_id, target_id);

-- ============================================================================
-- 6. RPC 批量加载优化索引（2026-01-27）
-- 覆盖 get_full_project_data RPC 的查询模式
-- ============================================================================

-- 任务表：项目级批量加载（包含排序字段和覆盖列）
-- 优化 RPC 中的 SELECT ... FROM tasks WHERE project_id = ? ORDER BY stage, "order"
CREATE INDEX IF NOT EXISTS idx_tasks_project_load 
ON public.tasks(project_id, stage NULLS LAST, "order")
INCLUDE (id, title, content, parent_id, rank, status, x, y, updated_at, deleted_at, short_id)
WHERE deleted_at IS NULL;

-- ============================================================================
-- 完成
-- ============================================================================
COMMENT ON TABLE public.projects IS '项目表 - REPLICA IDENTITY FULL for Realtime';
COMMENT ON TABLE public.tasks IS '任务表 - REPLICA IDENTITY FULL for Realtime';
COMMENT ON TABLE public.connections IS '连接表 - REPLICA IDENTITY FULL for Realtime';
COMMENT ON TABLE public.user_preferences IS '用户偏好表 - REPLICA IDENTITY FULL for Realtime';
-- ============================================================
-- [MIGRATION] 20251220_add_connection_soft_delete.sql
-- ============================================================
-- ============================================
-- 为 connections 表添加软删除支持
-- 日期: 2025-12-20
-- 
-- 目的：支持跨树连接的软删除同步
-- 解决问题：在一个设备上删除的连接，在其他设备上会因为同步逻辑问题而"复活"
-- 
-- 解决方案：使用 deleted_at 字段标记软删除状态，而不是物理删除
-- 这样删除操作可以正确同步到所有设备
-- ============================================

-- 1. 为 connections 表添加 deleted_at 列
ALTER TABLE public.connections
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE DEFAULT NULL;

-- 2. 创建索引以加速查询未删除的连接
CREATE INDEX IF NOT EXISTS idx_connections_deleted_at 
  ON public.connections (deleted_at)
  WHERE deleted_at IS NULL;

-- 3. 创建索引以加速查询需要清理的已删除连接
CREATE INDEX IF NOT EXISTS idx_connections_deleted_at_cleanup
  ON public.connections (deleted_at)
  WHERE deleted_at IS NOT NULL;

-- 4. 创建清理过期软删除连接的函数
CREATE OR REPLACE FUNCTION public.validate_task_data()
RETURNS TRIGGER AS $$
BEGIN
  -- 规则 1: 拒绝将 title 和 content 同时置空
  IF (NEW.title IS NULL OR NEW.title = '') AND (NEW.content IS NULL OR NEW.content = '') THEN
    -- 例外：软删除的任务允许
    IF NEW.deleted_at IS NOT NULL THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Task must have either title or content (task_id: %)', NEW.id;
  END IF;
  
  -- 规则 2: stage 必须非负（如果有值）
  IF NEW.stage IS NOT NULL AND NEW.stage < 0 THEN
    RAISE EXCEPTION 'Invalid stage value: % (must be >= 0)', NEW.stage;
  END IF;
  
  -- 规则 3: rank 必须是正数（如果有值）
  IF NEW.rank IS NOT NULL AND NEW.rank < 0 THEN
    RAISE EXCEPTION 'Invalid rank value: % (must be >= 0)', NEW.rank;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER FUNCTION public.validate_task_data()
  SET search_path TO 'pg_catalog', 'public';

-- 删除旧触发器（如果存在）
DROP TRIGGER IF EXISTS trg_validate_task_data ON public.tasks;

-- 创建新触发器
CREATE TRIGGER trg_validate_task_data
BEFORE INSERT OR UPDATE ON public.tasks
FOR EACH ROW
EXECUTE FUNCTION public.validate_task_data();

-- ============================================
-- 审计日志表
-- 记录所有熔断操作（阻止和通过的）
-- ============================================
CREATE TABLE IF NOT EXISTS public.circuit_breaker_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  operation text NOT NULL,
  blocked boolean NOT NULL DEFAULT false,
  reason text,
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 创建索引加速查询
CREATE INDEX IF NOT EXISTS idx_circuit_breaker_logs_user_id ON public.circuit_breaker_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_circuit_breaker_logs_created_at ON public.circuit_breaker_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_circuit_breaker_logs_blocked ON public.circuit_breaker_logs(blocked) WHERE blocked = true;

-- RLS 策略：只能查看自己的日志
ALTER TABLE public.circuit_breaker_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS circuit_breaker_logs_select_own ON public.circuit_breaker_logs;
CREATE POLICY circuit_breaker_logs_select_own ON public.circuit_breaker_logs
  FOR SELECT TO authenticated
  USING (user_id = (select auth.uid()));

-- 不允许用户直接删除日志（审计日志需保留）
-- INSERT 由 RPC 函数内部执行（SECURITY DEFINER 绕过 RLS）

-- ============================================
-- 授权
-- ============================================
GRANT EXECUTE ON FUNCTION public.safe_delete_tasks(uuid[], uuid) TO authenticated;

-- ============================================
-- 注释
-- ============================================
COMMENT ON FUNCTION public.safe_delete_tasks(uuid[], uuid) IS 
  '安全的批量删除任务 RPC。限制：单次最多删除 50 条或 50% 的任务。';
COMMENT ON FUNCTION public.validate_task_data() IS 
  '任务数据校验触发器。确保 title/content 不同时为空，stage/rank 为有效值。';
COMMENT ON TABLE public.circuit_breaker_logs IS 
  '熔断操作审计日志。记录所有批量删除操作（包括被阻止和成功的）。';
-- ============================================================
-- [MIGRATION] 20260101000001_connection_tombstones.sql (已移至早期位置)
-- ============================================================
-- 注意：connection_tombstones 表及相关函数已在文件早期（第 271 行附近）创建
-- 此处保留迁移标记以维护版本历史完整性
-- ============================================================
-- [MIGRATION] 20260101000002_batch_upsert_tasks_attachments.sql
-- ============================================================
-- batch_upsert_tasks 函数：批量 upsert 任务主字段，附件变更仅允许走专用 RPC
-- 用于批量操作的事务保护（≥20 个任务）
-- 
-- v6.0.0 修正：新增 parking_meta, expected_minutes, cognitive_load, wait_minutes 支持
--              新增安全校验：TEXT 长度限制、数值范围约束
-- v5.2.3 修正：移除不存在的 owner_id 列引用，通过 project.owner_id 进行权限校验
-- 安全特性：
-- 1. SECURITY DEFINER + auth.uid() 权限校验
-- 2. 只能操作自己的项目和任务（通过 projects.owner_id 校验）
-- 3. 事务保证原子性
-- 4. TEXT 长度限制防 DoS / 数据溢出
-- 5. 数值范围约束防溢出

CREATE OR REPLACE FUNCTION public.batch_upsert_tasks(
  p_tasks jsonb[],
  p_project_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_count integer := 0;
  v_task jsonb;
  v_user_id uuid;
  v_title text;
  v_content text;
  v_cognitive text;
  v_expected int;
  v_wait int;
BEGIN
  -- 权限校验
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: not authenticated';
  END IF;

  -- 附件只能通过专用 RPC 变更，批量 upsert 仅允许 owner 写任务主字段
  IF NOT public.user_is_project_owner(p_project_id) THEN
    RAISE EXCEPTION 'Unauthorized: not project owner';
  END IF;

  FOREACH v_task IN ARRAY p_tasks
  LOOP
    -- 安全校验：TEXT 长度限制（防 DoS / 数据溢出）
    v_title := v_task->>'title';
    v_content := v_task->>'content';
    IF v_title IS NOT NULL AND length(v_title) > 10000 THEN
      RAISE EXCEPTION 'Title too long (max 10000 chars) for task %', v_task->>'id';
    END IF;
    IF v_content IS NOT NULL AND length(v_content) > 1000000 THEN
      RAISE EXCEPTION 'Content too long (max 1000000 chars) for task %', v_task->>'id';
    END IF;

    -- 安全校验：数值范围
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

    INSERT INTO public.tasks AS existing (
      id, project_id, title, content, stage, parent_id,
      "order", rank, status, x, y, short_id, deleted_at,
      attachments, expected_minutes, cognitive_load, wait_minutes, parking_meta
    )
    VALUES (
      (v_task->>'id')::uuid,
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
      (v_task->>'deletedAt')::timestamptz,
      '[]'::jsonb,
      v_expected,
      COALESCE(v_cognitive, 'low'),
      v_wait,
      v_task->'parkingMeta'
    )
    ON CONFLICT (id) DO UPDATE SET
      title = EXCLUDED.title,
      content = EXCLUDED.content,
      stage = EXCLUDED.stage,
      parent_id = EXCLUDED.parent_id,
      "order" = EXCLUDED."order",
      rank = EXCLUDED.rank,
      status = EXCLUDED.status,
      x = EXCLUDED.x,
      y = EXCLUDED.y,
      short_id = EXCLUDED.short_id,
      deleted_at = EXCLUDED.deleted_at,
      attachments = COALESCE(existing.attachments, '[]'::jsonb),
      expected_minutes = EXCLUDED.expected_minutes,
      cognitive_load = EXCLUDED.cognitive_load,
      wait_minutes = EXCLUDED.wait_minutes,
      parking_meta = EXCLUDED.parking_meta,
      updated_at = NOW()
    WHERE existing.project_id = p_project_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Task project mismatch';
    END IF;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
EXCEPTION WHEN OTHERS THEN
  RAISE;
END;
$$;

-- 授权
GRANT EXECUTE ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) TO authenticated;

COMMENT ON FUNCTION public.batch_upsert_tasks IS 'Owner-only batch upsert for task core fields. Attachments stay on dedicated append/remove RPCs (v6.0.1).';
-- ============================================================
-- [MIGRATION] 20260101000003_optimistic_lock_strict_mode.sql
-- ============================================================
-- 乐观锁强化：版本冲突从警告改为拒绝
-- 
-- 变更说明：
-- 1. 修改 check_version_increment() 函数，启用严格模式
-- 2. 版本回退时直接抛出异常，拒绝更新
-- 3. 记录到 circuit_breaker_logs 以便调试

COMMENT ON FUNCTION public.check_version_increment IS 'Strict optimistic lock: rejects version regression instead of just warning. Logs to circuit_breaker_logs.';
-- ============================================================
-- [MIGRATION] 20260101000004_attachment_count_limit.sql
-- ============================================================
-- ============================================
-- 附件数量服务端限制
-- 日期：2026-01-01
-- 
-- 问题背景：
-- - 客户端限制可被绕过（通过直接 API 调用）
-- - 需要在服务端强制执行附件数量限制
-- ============================================

-- 定义最大附件数量常量
-- 与客户端 ATTACHMENT_CONFIG.MAX_ATTACHMENTS_PER_TASK 保持一致
DO $$
BEGIN
  -- 创建配置表（如果不存在）
  CREATE TABLE IF NOT EXISTS public.app_config (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
  );
  
  -- 插入附件数量限制配置
  INSERT INTO public.app_config (key, value, description)
  VALUES ('max_attachments_per_task', '20', '每个任务最大附件数量')
  ON CONFLICT (key) DO NOTHING;
END $$;

-- 为配置表启用 RLS 并设置只读策略（认证用户可读）
ALTER TABLE public.app_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "app_config_select" ON public.app_config;
CREATE POLICY "app_config_select" ON public.app_config
  FOR SELECT TO authenticated
  USING (true);

-- 更新 append_task_attachment 函数，添加数量限制检查
COMMENT ON FUNCTION public.purge_tasks_v3 IS 
'永久删除任务并返回附件存储路径。客户端需要调用 Storage API 删除返回的路径。';
-- ============================================================
-- [MIGRATION] 20260102000001_virus_scan_and_rls_fix.sql
-- ============================================================
-- ============================================
-- 病毒扫描表 + cleanup_logs RLS 修复
-- 版本: v5.12
-- ============================================

-- ============================================
-- 1. 创建病毒扫描记录表
-- ============================================

-- 存储文件扫描结果
CREATE TABLE IF NOT EXISTS public.attachment_scans (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  file_id UUID NOT NULL,
  file_hash VARCHAR(64), -- SHA-256 哈希
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  threat_name VARCHAR(255),
  threat_description TEXT,
  scanner VARCHAR(50) NOT NULL DEFAULT 'clamav',
  engine_version VARCHAR(50),
  signature_version VARCHAR(50),
  scanned_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  -- 约束
  CONSTRAINT valid_status CHECK (status IN ('pending', 'scanning', 'clean', 'threat_detected', 'failed', 'quarantined', 'skipped'))
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_attachment_scans_file_id ON public.attachment_scans(file_id);
CREATE INDEX IF NOT EXISTS idx_attachment_scans_status ON public.attachment_scans(status);
CREATE INDEX IF NOT EXISTS idx_attachment_scans_scanned_at ON public.attachment_scans(scanned_at);
CREATE INDEX IF NOT EXISTS idx_attachment_scans_file_hash ON public.attachment_scans(file_hash);

-- 启用 RLS
ALTER TABLE public.attachment_scans ENABLE ROW LEVEL SECURITY;

-- RLS 策略：仅 service_role 可访问扫描记录
-- 前端通过 Edge Function 间接访问
DROP POLICY IF EXISTS "attachment_scans_service_only" ON public.attachment_scans;
CREATE POLICY "attachment_scans_service_only" ON public.attachment_scans
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

-- 隔离区表（可选，用于存储被隔离的恶意文件信息）
CREATE TABLE IF NOT EXISTS public.quarantined_files (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  original_file_id UUID NOT NULL,
  storage_path TEXT NOT NULL,
  threat_name VARCHAR(255) NOT NULL,
  threat_description TEXT,
  quarantined_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  quarantined_by UUID REFERENCES auth.users(id),
  expires_at TIMESTAMP WITH TIME ZONE,
  restored BOOLEAN DEFAULT FALSE,
  restored_at TIMESTAMP WITH TIME ZONE,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_quarantined_files_expires_at ON public.quarantined_files(expires_at);
-- 【添加】quarantined_by FK 约束索引（2026-03-18 v6.3.0: Advisor 全量解决）
CREATE INDEX IF NOT EXISTS idx_quarantined_files_quarantined_by ON public.quarantined_files(quarantined_by);
COMMENT ON INDEX idx_quarantined_files_quarantined_by IS 
  'FK enforcement: quarantined_by references auth.users(id). ON DELETE SET NULL.';
ALTER TABLE public.quarantined_files ENABLE ROW LEVEL SECURITY;

-- RLS 策略：仅 service_role 可访问隔离区
DROP POLICY IF EXISTS "quarantined_files_service_only" ON public.quarantined_files;
CREATE POLICY "quarantined_files_service_only" ON public.quarantined_files
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

-- ============================================
-- 2. 修复 cleanup_logs RLS（仅 service_role 可访问）
-- 问题：当前策略 USING(true) 允许任意认证用户读写日志
-- ============================================

-- 删除旧的宽松策略
DROP POLICY IF EXISTS "cleanup_logs select" ON public.cleanup_logs;
DROP POLICY IF EXISTS "cleanup_logs insert" ON public.cleanup_logs;
DROP POLICY IF EXISTS "cleanup_logs_select_policy" ON public.cleanup_logs;

-- 创建新的限制性策略：仅 service_role 可访问
-- 这意味着普通用户无法直接访问日志，只能通过 Edge Function
CREATE POLICY "cleanup_logs_service_role_select" ON public.cleanup_logs
  FOR SELECT TO service_role
  USING (true);

CREATE POLICY "cleanup_logs_service_role_insert" ON public.cleanup_logs
  FOR INSERT TO service_role
  WITH CHECK (true);

CREATE POLICY "cleanup_logs_service_role_delete" ON public.cleanup_logs
  FOR DELETE TO service_role
  USING (true);

-- ============================================
-- 3. 定期清理过期扫描记录的函数
-- ============================================

CREATE OR REPLACE FUNCTION public.cleanup_expired_scan_records()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  deleted_count INTEGER;
  tmp_count INTEGER;
BEGIN
  -- 删除 30 天前的扫描记录（保留威胁检测记录更长时间）
  DELETE FROM public.attachment_scans
  WHERE scanned_at < NOW() - INTERVAL '30 days'
    AND status NOT IN ('threat_detected', 'quarantined');
  
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  
  -- 删除 90 天前的威胁检测记录
  DELETE FROM public.attachment_scans
  WHERE scanned_at < NOW() - INTERVAL '90 days';
  
  GET DIAGNOSTICS tmp_count = ROW_COUNT;
  deleted_count := deleted_count + tmp_count;
  
  -- 删除过期的隔离文件记录
  DELETE FROM public.quarantined_files
  WHERE expires_at < NOW() AND restored = FALSE;
  
  GET DIAGNOSTICS tmp_count = ROW_COUNT;
  deleted_count := deleted_count + tmp_count;
  
  -- 记录清理日志
  INSERT INTO public.cleanup_logs (type, details)
  VALUES ('scan_records', jsonb_build_object(
    'deleted_count', deleted_count,
    'cleaned_at', NOW()
  ));
  
  RETURN deleted_count;
END;
$$;

-- ============================================
-- 4. 更新触发器
-- ============================================

-- 自动更新 updated_at 时间戳
CREATE OR REPLACE FUNCTION public.update_attachment_scans_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER FUNCTION public.update_attachment_scans_timestamp()
  SET search_path TO 'pg_catalog', 'public';

DROP TRIGGER IF EXISTS trg_update_attachment_scans_timestamp ON public.attachment_scans;
CREATE TRIGGER trg_update_attachment_scans_timestamp
  BEFORE UPDATE ON public.attachment_scans
  FOR EACH ROW
  EXECUTE FUNCTION public.update_attachment_scans_timestamp();

-- ============================================
-- 5. 授予权限
-- ============================================

-- service_role 完全访问
GRANT ALL ON public.attachment_scans TO service_role;
GRANT ALL ON public.quarantined_files TO service_role;

-- 普通用户无直接访问权限（通过 Edge Function）
REVOKE ALL ON public.attachment_scans FROM authenticated;
REVOKE ALL ON public.quarantined_files FROM authenticated;

-- 函数执行权限
GRANT EXECUTE ON FUNCTION public.cleanup_expired_scan_records() TO service_role;
-- ============================================================
-- [MIGRATION] 20260102000010_batch_upsert_search_path_fix.sql
-- ============================================================
-- ============================================
-- 安全加固：为 batch_upsert_tasks 添加 search_path
-- 日期: 2026-01-02
-- 问题: batch_upsert_tasks 函数缺少 SET search_path，存在 search_path 注入风险
-- 解决: 添加 SET search_path TO 'pg_catalog', 'public' 与项目标准一致
-- ============================================

-- 为 batch_upsert_tasks 设置安全的 search_path
ALTER FUNCTION public.batch_upsert_tasks(jsonb[], uuid)
  SET search_path TO 'pg_catalog', 'public';

-- 验证说明（在 psql 中执行）:
-- SELECT proconfig FROM pg_proc WHERE proname = 'batch_upsert_tasks';
-- 期望返回包含 search_path=pg_catalog, public
-- ============================================================
-- [MIGRATION] 20260103000001_add_dashboard_rpc.sql
-- ============================================================
-- ============================================
-- Dashboard RPC 聚合函数
-- 减少流量：从 MB 级原始数据降至 ~200 Bytes JSON
-- ============================================
-- @see docs/plan_save.md Phase 1.3

-- 创建 Dashboard 统计聚合函数
-- 注意：tasks 表没有 user_id 列，必须通过 project.owner_id 关联查询
CREATE OR REPLACE FUNCTION public.get_dashboard_stats()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'  -- 🔒 防止 search_path 注入攻击
AS $$
DECLARE
  current_user_id uuid := (SELECT auth.uid());
BEGIN
  -- 使用 initplan 缓存 user_id，避免每行重复计算
  -- 通过 project.owner_id 关联查询（tasks 表没有 user_id 列）
  RETURN json_build_object(
    'pending', (
      SELECT COUNT(*) 
      FROM public.tasks t
      JOIN public.projects p ON t.project_id = p.id
      WHERE p.owner_id = current_user_id 
        AND p.deleted_at IS NULL
        AND t.status = 'active' 
        AND t.deleted_at IS NULL
    ),
    'completed', (
      SELECT COUNT(*) 
      FROM public.tasks t
      JOIN public.projects p ON t.project_id = p.id
      WHERE p.owner_id = current_user_id 
        AND p.deleted_at IS NULL
        AND t.status = 'completed' 
        AND t.deleted_at IS NULL
    ),
    'projects', (SELECT COUNT(*) FROM public.projects WHERE owner_id = current_user_id AND deleted_at IS NULL)
  );
END;
$$;

-- 添加函数注释
COMMENT ON FUNCTION public.get_dashboard_stats() IS 
  'Dashboard 统计聚合函数 - 返回用户的待处理任务数、已完成任务数和项目数。
   通过 project.owner_id 关联查询（tasks 表没有 user_id 列）。
   使用 SECURITY DEFINER 确保 RLS 生效。修复于 2026-01-07。';

-- 授权：仅认证用户可调用
GRANT EXECUTE ON FUNCTION public.get_dashboard_stats() TO authenticated;
REVOKE EXECUTE ON FUNCTION public.get_dashboard_stats() FROM anon, public;
-- ============================================================
-- [MIGRATION] 20260103000002_rls_initplan_audit_fix.sql
-- ============================================================
-- ============================================
-- RLS 策略 initplan 优化审计修复
-- 日期: 2026-01-03
-- 
-- 问题: connection_tombstones 表的 RLS 策略未使用 (select auth.uid())
-- 影响: 每行都会重复计算 auth.uid()，影响性能
-- 解决: 使用 initplan 缓存 auth.uid() 值
-- 
-- @see docs/plan_save.md Phase 1.4
-- ============================================

-- 修复 connection_tombstones 表 RLS 策略
-- 使用 (select auth.uid()) 替代 auth.uid() 实现 initplan 优化

DROP POLICY IF EXISTS "connection_tombstones_select" ON public.connection_tombstones;
CREATE POLICY "connection_tombstones_select" ON public.connection_tombstones
  FOR SELECT TO authenticated
  USING (public.user_is_project_owner(project_id));

DROP POLICY IF EXISTS "connection_tombstones_insert" ON public.connection_tombstones;
CREATE POLICY "connection_tombstones_insert" ON public.connection_tombstones
  FOR INSERT TO authenticated
  WITH CHECK (public.user_is_project_owner(project_id));

-- 更新相关函数的 auth.uid() 调用也使用 initplan
-- 注意：在函数中设置 search_path 以防止注入攻击

ALTER FUNCTION public.record_connection_tombstone()
  SET search_path = pg_catalog, public;

-- 添加 RLS 策略审计注释
COMMENT ON POLICY "connection_tombstones_select" ON public.connection_tombstones IS
  'SELECT 策略 - 使用 initplan 优化的 (select auth.uid())';

COMMENT ON POLICY "connection_tombstones_insert" ON public.connection_tombstones IS
  'INSERT 策略 - 使用 initplan 优化的 (select auth.uid())';
-- ============================================================
-- [MIGRATION] 20260103000003_add_get_server_time_rpc.sql
-- ============================================================
-- ============================================================
-- 添加 get_server_time RPC 函数
-- ============================================================
-- 
-- 用途：为客户端提供服务端时间，用于时钟偏移检测
-- 被调用：clock-sync.service.ts
-- 
-- 版本: 1.0.0
-- 日期: 2026-01-03
-- ============================================================

-- 创建获取服务端时间的 RPC 函数
-- 返回当前服务端 UTC 时间戳（ISO 8601 格式）
CREATE OR REPLACE FUNCTION public.get_server_time()
RETURNS TIMESTAMPTZ
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  SELECT NOW();
$$;

-- 仅允许明确角色执行（避免 PUBLIC 默认权限漂移）
REVOKE EXECUTE ON FUNCTION public.get_server_time() FROM PUBLIC;

-- 授予所有认证用户执行权限
GRANT EXECUTE ON FUNCTION public.get_server_time() TO authenticated;

-- 允许匿名用户执行（用于未登录时的时钟检测）
GRANT EXECUTE ON FUNCTION public.get_server_time() TO anon;

-- ============================================================
-- [MIGRATION] 20260126100000_batch_load_optimization.sql
-- ============================================================
-- ============================================================
-- 性能优化：批量加载 RPC 函数
-- ============================================================
-- 
-- 优化目标：
--   - 将 4+ 个 API 请求合并为 1 个 RPC 调用
--   - 减少 70% 的网络往返时间
--   - 首屏加载时间提升 3-4 秒
-- 
-- 版本: 1.0.0
-- 日期: 2026-01-26
-- ============================================================

-- 批量加载项目完整数据 RPC
-- 合并 projects + tasks + connections + tombstones 为单次请求
CREATE OR REPLACE FUNCTION public.get_full_project_data(p_project_id UUID)
RETURNS JSON
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_result JSON;
  v_user_id UUID;
BEGIN
  -- 获取当前用户 ID
  v_user_id := auth.uid();
  
  -- 权限检查：个人版仅允许 owner 访问
  IF NOT public.user_has_project_access(p_project_id) THEN
    RAISE EXCEPTION 'Access denied to project %', p_project_id;
  END IF;
  
  -- 构建完整项目数据（单次查询）
  SELECT json_build_object(
    'project', (
      SELECT row_to_json(p.*) 
      FROM (
        SELECT id, owner_id, title, description, created_date, updated_at, deleted_at, version
        FROM public.projects WHERE id = p_project_id
      ) p
    ),
    'tasks', COALESCE((
      SELECT json_agg(row_to_json(t.*))
      FROM (
        SELECT id, title, content, stage, parent_id, "order", rank, status, x, y, 
               updated_at, deleted_at, short_id
        FROM public.tasks 
        WHERE project_id = p_project_id
        ORDER BY stage NULLS LAST, "order"
      ) t
    ), '[]'::json),
    'connections', COALESCE((
      SELECT json_agg(row_to_json(c.*))
      FROM (
        SELECT id, source_id, target_id, title, description, deleted_at, updated_at
        FROM public.connections 
        WHERE project_id = p_project_id
      ) c
    ), '[]'::json),
    'task_tombstones', COALESCE((
      SELECT json_agg(task_id)
      FROM public.task_tombstones 
      WHERE project_id = p_project_id
    ), '[]'::json),
    'connection_tombstones', COALESCE((
      SELECT json_agg(connection_id)
      FROM public.connection_tombstones 
      WHERE project_id = p_project_id
    ), '[]'::json)
  ) INTO v_result;
  
  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.get_full_project_data(UUID) IS 
  '批量加载项目完整数据，合并 4+ 请求为 1 个，性能提升 70%';

-- 权限设置
REVOKE EXECUTE ON FUNCTION public.get_full_project_data(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_full_project_data(UUID) TO authenticated;

-- 增量加载用户项目列表 RPC
-- 支持 updated_at 增量同步
CREATE OR REPLACE FUNCTION public.get_user_projects_meta(p_since_timestamp TIMESTAMPTZ DEFAULT '1970-01-01'::timestamptz)
RETURNS JSON
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_result JSON;
  v_user_id UUID;
BEGIN
  v_user_id := auth.uid();
  
  SELECT json_build_object(
    'projects', COALESCE((
      SELECT json_agg(row_to_json(p.*))
      FROM (
        SELECT id, owner_id, title, description, created_date, updated_at, deleted_at, version
        FROM public.projects 
        WHERE owner_id = v_user_id AND deleted_at IS NULL AND updated_at > p_since_timestamp
        ORDER BY updated_at DESC
      ) p
    ), '[]'::json),
    'server_time', now()
  ) INTO v_result;
  
  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.get_user_projects_meta(TIMESTAMPTZ) IS 
  '增量加载用户项目列表，支持增量同步';

-- 权限设置
REVOKE EXECUTE ON FUNCTION public.get_user_projects_meta(TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_user_projects_meta(TIMESTAMPTZ) TO authenticated;

-- ============================================
-- 性能优化：批量加载 RPC 函数 (2026-02-02)
-- 将 N+1 查询合并为单次 RPC 调用
-- 预期收益：API 请求从 12+ 降至 1-2 个
-- ============================================

-- 批量加载所有项目（用于后台同步）
CREATE OR REPLACE FUNCTION public.get_all_projects_data(
  p_since_timestamp TIMESTAMPTZ DEFAULT '1970-01-01'::TIMESTAMPTZ
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_result JSON;
  v_user_id UUID;
BEGIN
  v_user_id := auth.uid();
  
  SELECT json_build_object(
    'projects', COALESCE((
      SELECT json_agg(row_to_json(p.*) ORDER BY p.updated_at DESC)
      FROM (
        SELECT id, owner_id, title, description, created_date, updated_at, deleted_at, version
        FROM public.projects 
        WHERE owner_id = v_user_id AND deleted_at IS NULL AND updated_at > p_since_timestamp
      ) p
    ), '[]'::json),
    'server_time', now()
  ) INTO v_result;
  
  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.get_all_projects_data(TIMESTAMPTZ) IS 
  '批量加载用户所有项目的元数据（增量同步）- 性能优化 2026-02-02';

REVOKE EXECUTE ON FUNCTION public.get_all_projects_data(TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_all_projects_data(TIMESTAMPTZ) TO authenticated;

-- 分页获取项目列表（含摘要信息）
CREATE OR REPLACE FUNCTION public.get_projects_list(
  p_limit INT DEFAULT 50,
  p_offset INT DEFAULT 0
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_result JSON;
  v_user_id UUID;
BEGIN
  v_user_id := auth.uid();
  
  SELECT json_build_object(
    'projects', COALESCE((
      SELECT json_agg(json_build_object(
        'id', p.id,
        'owner_id', p.owner_id,
        'title', p.title,
        'description', p.description,
        'created_date', p.created_date,
        'updated_at', p.updated_at,
        'version', p.version,
        'task_count', (SELECT COUNT(*) FROM public.tasks WHERE project_id = p.id AND deleted_at IS NULL),
        'last_modified', (SELECT MAX(updated_at) FROM (
          SELECT updated_at FROM public.tasks WHERE project_id = p.id
          UNION ALL
          SELECT updated_at FROM public.connections WHERE project_id = p.id
        ) AS updates)
      ) ORDER BY p.updated_at DESC)
      FROM (
        SELECT *
        FROM public.projects 
        WHERE owner_id = v_user_id
          AND deleted_at IS NULL
        ORDER BY updated_at DESC
        LIMIT p_limit OFFSET p_offset
      ) p
    ), '[]'::json),
    'total', (SELECT COUNT(*) FROM public.projects WHERE owner_id = v_user_id AND deleted_at IS NULL),
    'server_time', now()
  ) INTO v_result;
  
  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.get_projects_list(INT, INT) IS 
  '分页获取项目列表（含摘要信息）- 性能优化 2026-02-02';

REVOKE EXECUTE ON FUNCTION public.get_projects_list(INT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_projects_list(INT, INT) TO authenticated;

CREATE INDEX IF NOT EXISTS idx_tasks_project_order 
  ON public.tasks(project_id, stage, "order");

CREATE INDEX IF NOT EXISTS idx_connections_project 
  ON public.connections(project_id);

-- ============================================================
-- [RESUME] Resume 水位 RPC 函数 + 配套索引
-- 来源：supabase/migrations/20260214~20260218 合并
-- ============================================================

-- ============================================
-- Resume 索引补强（幂等）
-- ============================================

CREATE INDEX IF NOT EXISTS idx_projects_id_owner_updated_desc
  ON public.projects (id, owner_id, updated_at DESC);

-- tasks / connections / tombstone 增量同步索引（保留单一定义）
CREATE INDEX IF NOT EXISTS idx_tasks_project_updated
  ON public.tasks (project_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_connections_project_updated
  ON public.connections (project_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_task_tombstones_project_deleted_desc
  ON public.task_tombstones (project_id, deleted_at DESC);

-- 注：idx_connection_tombstones_project_deleted_desc 已移除（被 idx_connection_tombstones_project_id + deleted_at 替代）

CREATE INDEX IF NOT EXISTS idx_black_box_entries_user_updated
  ON public.black_box_entries (user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_project_members_user_project
  ON public.project_members (user_id, project_id);
-- 注：以下冗余索引已移除（极少作为查询条件或被复合索引替代）：
-- - idx_connection_tombstones_deleted_by
-- - idx_project_members_invited_by
-- - idx_quarantined_files_quarantined_by
-- - idx_task_tombstones_deleted_by

-- ============================================
-- get_project_sync_watermark：单项目聚合同步水位
-- ============================================

CREATE OR REPLACE FUNCTION public.get_project_sync_watermark(
  p_project_id UUID
)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID;
  v_watermark TIMESTAMPTZ;
BEGIN
  v_user_id := auth.uid();

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  -- 单用户 owner-only 模型（project_members 已移除）
  IF NOT EXISTS (
    SELECT 1
    FROM public.projects p
    WHERE p.id = p_project_id
      AND p.owner_id = v_user_id
      AND p.deleted_at IS NULL
  ) THEN
    RETURN NULL;
  END IF;

  SELECT GREATEST(
    COALESCE((SELECT p.updated_at FROM public.projects p WHERE p.id = p_project_id), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(t.updated_at) FROM public.tasks t WHERE t.project_id = p_project_id), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(c.updated_at) FROM public.connections c WHERE c.project_id = p_project_id), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(tt.deleted_at) FROM public.task_tombstones tt WHERE tt.project_id = p_project_id), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(ct.deleted_at) FROM public.connection_tombstones ct WHERE ct.project_id = p_project_id), '-infinity'::timestamptz)
  )
  INTO v_watermark;

  IF v_watermark = '-infinity'::timestamptz THEN
    RETURN NULL;
  END IF;

  RETURN v_watermark;
END;
$$;

REVOKE ALL ON FUNCTION public.get_project_sync_watermark(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_project_sync_watermark(UUID) TO authenticated;

COMMENT ON FUNCTION public.get_project_sync_watermark IS
  '返回单项目聚合同步水位（owner-only，project_members 已移除）';

-- ============================================
-- get_user_projects_watermark：用户项目域全局水位（性能优化版）
-- ============================================

CREATE OR REPLACE FUNCTION public.get_user_projects_watermark()
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID;
  v_watermark TIMESTAMPTZ;
BEGIN
  v_user_id := auth.uid();

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  -- 单用户 owner-only 模型（project_members 已移除）
  SELECT GREATEST(
    COALESCE((
      SELECT MAX(GREATEST(
        COALESCE(p.updated_at, '-infinity'::timestamptz),
        COALESCE(p.deleted_at, '-infinity'::timestamptz)
      ))
      FROM public.projects p
      WHERE p.owner_id = v_user_id
    ), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(t.updated_at) FROM public.tasks t JOIN public.projects p ON p.id = t.project_id WHERE p.owner_id = v_user_id AND p.deleted_at IS NULL), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(c.updated_at) FROM public.connections c JOIN public.projects p ON p.id = c.project_id WHERE p.owner_id = v_user_id AND p.deleted_at IS NULL), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(tt.deleted_at) FROM public.task_tombstones tt JOIN public.projects p ON p.id = tt.project_id WHERE p.owner_id = v_user_id AND p.deleted_at IS NULL), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(ct.deleted_at) FROM public.connection_tombstones ct JOIN public.projects p ON p.id = ct.project_id WHERE p.owner_id = v_user_id AND p.deleted_at IS NULL), '-infinity'::timestamptz)
  )
  INTO v_watermark;

  IF v_watermark = '-infinity'::timestamptz THEN
    RETURN NULL;
  END IF;

  RETURN v_watermark;
END;
$$;

REVOKE ALL ON FUNCTION public.get_user_projects_watermark() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_user_projects_watermark() TO authenticated;

COMMENT ON FUNCTION public.get_user_projects_watermark IS
  '返回当前用户项目域聚合最大时间戳（owner-only，project_members 已移除）';

-- ============================================
-- list_project_heads_since：变更项目头信息（性能优化版）
-- ============================================

CREATE OR REPLACE FUNCTION public.list_project_heads_since(
  p_since TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  project_id UUID,
  updated_at TIMESTAMPTZ,
  version INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID;
BEGIN
  v_user_id := auth.uid();

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  -- 单用户 owner-only 模型（project_members 已移除）
  RETURN QUERY
  WITH project_changes AS (
    SELECT
      p.id AS project_id,
      GREATEST(
        COALESCE(p.updated_at, '-infinity'::timestamptz),
        COALESCE((SELECT MAX(t.updated_at) FROM public.tasks t WHERE t.project_id = p.id), '-infinity'::timestamptz),
        COALESCE((SELECT MAX(c.updated_at) FROM public.connections c WHERE c.project_id = p.id), '-infinity'::timestamptz),
        COALESCE((SELECT MAX(tt.deleted_at) FROM public.task_tombstones tt WHERE tt.project_id = p.id), '-infinity'::timestamptz),
        COALESCE((SELECT MAX(ct.deleted_at) FROM public.connection_tombstones ct WHERE ct.project_id = p.id), '-infinity'::timestamptz)
      ) AS updated_at,
      COALESCE(p.version, 1)::INTEGER AS version
    FROM public.projects p
    WHERE p.owner_id = v_user_id
      AND p.deleted_at IS NULL
  )
  SELECT
    pc.project_id,
    pc.updated_at,
    pc.version
  FROM project_changes pc
  WHERE pc.updated_at > COALESCE(p_since, '-infinity'::timestamptz)
  ORDER BY pc.updated_at ASC;
END;
$$;

REVOKE ALL ON FUNCTION public.list_project_heads_since(TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_project_heads_since(TIMESTAMPTZ) TO authenticated;

COMMENT ON FUNCTION public.list_project_heads_since(TIMESTAMPTZ) IS
  '返回当前用户在给定水位后变更的项目头信息（owner-only，project_members 已移除）';

-- ============================================
-- get_accessible_project_probe：项目可访问探测 + 水位
-- ============================================

CREATE OR REPLACE FUNCTION public.get_accessible_project_probe(
  p_project_id UUID
)
RETURNS TABLE (
  project_id UUID,
  accessible BOOLEAN,
  watermark TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID;
  v_accessible BOOLEAN := FALSE;
  v_watermark TIMESTAMPTZ;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  -- 单用户 owner-only 模型（project_members 已移除）
  SELECT EXISTS (
    SELECT 1
    FROM public.projects p
    WHERE p.id = p_project_id
      AND p.owner_id = v_user_id
      AND p.deleted_at IS NULL
  )
  INTO v_accessible;

  IF NOT v_accessible THEN
    RETURN QUERY
    SELECT p_project_id, FALSE, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  SELECT GREATEST(
    COALESCE((SELECT p.updated_at FROM public.projects p WHERE p.id = p_project_id), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(t.updated_at) FROM public.tasks t WHERE t.project_id = p_project_id), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(c.updated_at) FROM public.connections c WHERE c.project_id = p_project_id), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(tt.deleted_at) FROM public.task_tombstones tt WHERE tt.project_id = p_project_id), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(ct.deleted_at) FROM public.connection_tombstones ct WHERE ct.project_id = p_project_id), '-infinity'::timestamptz)
  )
  INTO v_watermark;

  IF v_watermark = '-infinity'::timestamptz THEN
    v_watermark := NULL;
  END IF;

  RETURN QUERY
  SELECT p_project_id, TRUE, v_watermark;
END;
$$;

REVOKE ALL ON FUNCTION public.get_accessible_project_probe(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_accessible_project_probe(UUID) TO authenticated;

COMMENT ON FUNCTION public.get_accessible_project_probe IS
  '返回当前项目可访问性与项目域聚合水位（owner-only，project_members 已移除）';

-- ============================================
-- get_black_box_sync_watermark：黑匣子域同步水位
-- ============================================

CREATE OR REPLACE FUNCTION public.get_black_box_sync_watermark()
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID;
  v_watermark TIMESTAMPTZ;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT MAX(updated_at)
  INTO v_watermark
  FROM public.black_box_entries
  WHERE user_id = v_user_id;

  RETURN v_watermark;
END;
$$;

REVOKE ALL ON FUNCTION public.get_black_box_sync_watermark() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_black_box_sync_watermark() TO authenticated;

COMMENT ON FUNCTION public.get_black_box_sync_watermark IS
  '返回当前用户黑匣子域聚合同步水位（MAX(updated_at)）';

-- ============================================
-- get_resume_recovery_probe：恢复链路聚合探测
-- ============================================

CREATE OR REPLACE FUNCTION public.get_resume_recovery_probe(
  p_project_id UUID DEFAULT NULL
)
RETURNS TABLE (
  active_project_id UUID,
  active_accessible BOOLEAN,
  active_watermark TIMESTAMPTZ,
  projects_watermark TIMESTAMPTZ,
  blackbox_watermark TIMESTAMPTZ,
  server_now TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID;
  v_active_accessible BOOLEAN := FALSE;
  v_active_watermark TIMESTAMPTZ := NULL;
  v_projects_watermark TIMESTAMPTZ := NULL;
  v_blackbox_watermark TIMESTAMPTZ := NULL;
BEGIN
  v_user_id := auth.uid();

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  -- 单用户 owner-only 模型（project_members 已移除）
  IF p_project_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = p_project_id
        AND p.owner_id = v_user_id
        AND p.deleted_at IS NULL
    )
    INTO v_active_accessible;

    IF v_active_accessible THEN
      SELECT GREATEST(
        COALESCE((SELECT p.updated_at FROM public.projects p WHERE p.id = p_project_id), '-infinity'::timestamptz),
        COALESCE((SELECT MAX(t.updated_at) FROM public.tasks t WHERE t.project_id = p_project_id), '-infinity'::timestamptz),
        COALESCE((SELECT MAX(c.updated_at) FROM public.connections c WHERE c.project_id = p_project_id), '-infinity'::timestamptz),
        COALESCE((SELECT MAX(tt.deleted_at) FROM public.task_tombstones tt WHERE tt.project_id = p_project_id), '-infinity'::timestamptz),
        COALESCE((SELECT MAX(ct.deleted_at) FROM public.connection_tombstones ct WHERE ct.project_id = p_project_id), '-infinity'::timestamptz)
      )
      INTO v_active_watermark;

      IF v_active_watermark = '-infinity'::timestamptz THEN
        v_active_watermark := NULL;
      END IF;
    END IF;
  END IF;

  SELECT GREATEST(
    COALESCE((
      SELECT MAX(GREATEST(
        COALESCE(p.updated_at, '-infinity'::timestamptz),
        COALESCE(p.deleted_at, '-infinity'::timestamptz)
      ))
      FROM public.projects p
      WHERE p.owner_id = v_user_id
    ), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(t.updated_at) FROM public.tasks t JOIN public.projects p ON p.id = t.project_id WHERE p.owner_id = v_user_id AND p.deleted_at IS NULL), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(c.updated_at) FROM public.connections c JOIN public.projects p ON p.id = c.project_id WHERE p.owner_id = v_user_id AND p.deleted_at IS NULL), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(tt.deleted_at) FROM public.task_tombstones tt JOIN public.projects p ON p.id = tt.project_id WHERE p.owner_id = v_user_id AND p.deleted_at IS NULL), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(ct.deleted_at) FROM public.connection_tombstones ct JOIN public.projects p ON p.id = ct.project_id WHERE p.owner_id = v_user_id AND p.deleted_at IS NULL), '-infinity'::timestamptz)
  )
  INTO v_projects_watermark;

  IF v_projects_watermark = '-infinity'::timestamptz THEN
    v_projects_watermark := NULL;
  END IF;

  SELECT MAX(updated_at)
  INTO v_blackbox_watermark
  FROM public.black_box_entries
  WHERE user_id = v_user_id;

  RETURN QUERY
  SELECT
    p_project_id,
    v_active_accessible,
    v_active_watermark,
    v_projects_watermark,
    v_blackbox_watermark,
    NOW();
END;
$$;

REVOKE ALL ON FUNCTION public.get_resume_recovery_probe(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_resume_recovery_probe(UUID) TO authenticated;

COMMENT ON FUNCTION public.get_resume_recovery_probe IS
  '恢复链路聚合探测（owner-only，project_members 已移除）';

-- ============================================================
-- 权限收口：SECURITY DEFINER RPC 禁止 PUBLIC / anon
-- 说明：NanoFlow 强依赖登录态；匿名角色不应具备写入/批量操作能力。
-- ============================================================

-- 附件 RPC
REVOKE EXECUTE ON FUNCTION public.append_task_attachment(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.append_task_attachment(uuid, jsonb) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.remove_task_attachment(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remove_task_attachment(uuid, text) TO authenticated;

-- 批量任务
REVOKE EXECUTE ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) TO authenticated;

-- Purge / 删除
REVOKE EXECUTE ON FUNCTION public.purge_tasks(uuid[]) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.purge_tasks(uuid[]) FROM authenticated;

REVOKE EXECUTE ON FUNCTION public.purge_tasks_v2(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.purge_tasks_v2(uuid, uuid[]) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.purge_tasks_v3(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.purge_tasks_v3(uuid, uuid[]) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.safe_delete_tasks(uuid[], uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.safe_delete_tasks(uuid[], uuid) TO authenticated;

-- 辅助查询
REVOKE EXECUTE ON FUNCTION public.is_task_tombstoned(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_task_tombstoned(uuid) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.is_connection_tombstoned(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_connection_tombstoned(uuid) TO authenticated;

-- 迁移工具（仅限 service_role，不应暴露给普通用户）
REVOKE EXECUTE ON FUNCTION public.migrate_project_data_to_v2(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.migrate_project_data_to_v2(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.migrate_project_data_to_v2(uuid) TO service_role;

REVOKE EXECUTE ON FUNCTION public.migrate_all_projects_to_v2() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.migrate_all_projects_to_v2() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.migrate_all_projects_to_v2() TO service_role;

-- 触发器辅助函数（不应作为 RPC 暴露）
REVOKE EXECUTE ON FUNCTION public.trigger_set_updated_at() FROM PUBLIC, anon;

-- 维护/清理函数（不应默认对外暴露）
REVOKE EXECUTE ON FUNCTION public.cleanup_old_deleted_tasks() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.cleanup_old_deleted_connections() FROM PUBLIC, anon;

REVOKE EXECUTE ON FUNCTION public.cleanup_old_logs() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.cleanup_deleted_attachments(integer) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.cleanup_expired_scan_records() FROM PUBLIC, anon;

-- 维护函数仅 service_role 可调用
GRANT EXECUTE ON FUNCTION public.cleanup_old_logs() TO service_role;
GRANT EXECUTE ON FUNCTION public.cleanup_deleted_attachments(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.cleanup_expired_scan_records() TO service_role;
GRANT EXECUTE ON FUNCTION public.cleanup_old_deleted_tasks() TO service_role;
GRANT EXECUTE ON FUNCTION public.cleanup_old_deleted_connections() TO service_role;

COMMENT ON FUNCTION public.get_server_time() IS '获取服务端当前时间，用于客户端时钟偏移检测';

-- ============================================================
-- 全量安全加固 (v6.0.0)
-- ============================================================

-- FORCE RLS 全量覆盖（确保 service_role 也受策略约束）
ALTER TABLE public.tasks FORCE ROW LEVEL SECURITY;
ALTER TABLE public.projects FORCE ROW LEVEL SECURITY;
ALTER TABLE public.connections FORCE ROW LEVEL SECURITY;
ALTER TABLE public.user_preferences FORCE ROW LEVEL SECURITY;
ALTER TABLE public.task_tombstones FORCE ROW LEVEL SECURITY;
ALTER TABLE public.connection_tombstones FORCE ROW LEVEL SECURITY;
ALTER TABLE public.project_members FORCE ROW LEVEL SECURITY;
ALTER TABLE public.app_config FORCE ROW LEVEL SECURITY;
ALTER TABLE public.attachment_scans FORCE ROW LEVEL SECURITY;
ALTER TABLE public.circuit_breaker_logs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.cleanup_logs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.purge_rate_limits FORCE ROW LEVEL SECURITY;
ALTER TABLE public.quarantined_files FORCE ROW LEVEL SECURITY;
ALTER TABLE public.transcription_usage FORCE ROW LEVEL SECURITY;

-- anon 角色全量收紧（用户数据零访问）
REVOKE ALL ON TABLE public.tasks FROM anon;
REVOKE ALL ON TABLE public.projects FROM anon;
REVOKE ALL ON TABLE public.connections FROM anon;
REVOKE ALL ON TABLE public.user_preferences FROM anon;
REVOKE ALL ON TABLE public.black_box_entries FROM anon;
REVOKE ALL ON TABLE public.focus_sessions FROM anon;
REVOKE ALL ON TABLE public.routine_tasks FROM anon;
REVOKE ALL ON TABLE public.routine_completions FROM anon;
REVOKE ALL ON TABLE public.transcription_usage FROM anon;
REVOKE ALL ON TABLE public.task_tombstones FROM anon;
REVOKE ALL ON TABLE public.connection_tombstones FROM anon;
REVOKE ALL ON TABLE public.project_members FROM anon;
REVOKE ALL ON TABLE public.circuit_breaker_logs FROM anon;
REVOKE ALL ON TABLE public.cleanup_logs FROM anon;
REVOKE ALL ON TABLE public.purge_rate_limits FROM anon;
REVOKE ALL ON TABLE public.quarantined_files FROM anon;
REVOKE ALL ON TABLE public.attachment_scans FROM anon;
-- app_config：仅保留 anon 只读
REVOKE ALL ON TABLE public.app_config FROM anon;
GRANT SELECT ON TABLE public.app_config TO anon;
-- 新表不自动授权 anon
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon;

-- 数据安全约束（防 DoS / 溢出 / 注入）
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='tasks_title_length_check' AND conrelid='public.tasks'::regclass)
  THEN ALTER TABLE public.tasks ADD CONSTRAINT tasks_title_length_check CHECK (title IS NULL OR length(title) <= 10000);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='tasks_content_length_check' AND conrelid='public.tasks'::regclass)
  THEN ALTER TABLE public.tasks ADD CONSTRAINT tasks_content_length_check CHECK (content IS NULL OR length(content) <= 1000000);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='tasks_parking_meta_size_check' AND conrelid='public.tasks'::regclass)
  THEN ALTER TABLE public.tasks ADD CONSTRAINT tasks_parking_meta_size_check CHECK (parking_meta IS NULL OR pg_column_size(parking_meta) <= 524288);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='routine_tasks_title_length_check' AND conrelid='public.routine_tasks'::regclass)
  THEN ALTER TABLE public.routine_tasks ADD CONSTRAINT routine_tasks_title_length_check CHECK (length(title) <= 1000);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='routine_tasks_max_times_check' AND conrelid='public.routine_tasks'::regclass)
  THEN ALTER TABLE public.routine_tasks ADD CONSTRAINT routine_tasks_max_times_check CHECK (max_times_per_day > 0 AND max_times_per_day <= 100);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='routine_completions_count_check' AND conrelid='public.routine_completions'::regclass)
  THEN ALTER TABLE public.routine_completions ADD CONSTRAINT routine_completions_count_check CHECK (count > 0 AND count <= 1000);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='focus_sessions_state_size_check' AND conrelid='public.focus_sessions'::regclass)
  THEN ALTER TABLE public.focus_sessions ADD CONSTRAINT focus_sessions_state_size_check CHECK (pg_column_size(session_state) <= 1048576);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='user_preferences_dock_snapshot_size_check' AND conrelid='public.user_preferences'::regclass)
  THEN ALTER TABLE public.user_preferences ADD CONSTRAINT user_preferences_dock_snapshot_size_check CHECK (dock_snapshot IS NULL OR pg_column_size(dock_snapshot) <= 1048576);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='user_preferences_focus_pref_size_check' AND conrelid='public.user_preferences'::regclass)
  THEN ALTER TABLE public.user_preferences ADD CONSTRAINT user_preferences_focus_pref_size_check CHECK (focus_preferences IS NULL OR pg_column_size(focus_preferences) <= 65536);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='user_preferences_color_mode_check' AND conrelid='public.user_preferences'::regclass)
  THEN ALTER TABLE public.user_preferences ADD CONSTRAINT user_preferences_color_mode_check CHECK (color_mode IS NULL OR color_mode IN ('light', 'dark', 'system'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='user_preferences_backup_interval_check' AND conrelid='public.user_preferences'::regclass)
  THEN ALTER TABLE public.user_preferences ADD CONSTRAINT user_preferences_backup_interval_check CHECK (local_backup_interval_ms IS NULL OR (local_backup_interval_ms >= 300000 AND local_backup_interval_ms <= 604800000));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='black_box_entries_focus_meta_size_check' AND conrelid='public.black_box_entries'::regclass)
  THEN ALTER TABLE public.black_box_entries ADD CONSTRAINT black_box_entries_focus_meta_size_check CHECK (focus_meta IS NULL OR pg_column_size(focus_meta) <= 262144);
  END IF;
END $$;

-- 补充缺失的 RLS 策略
DO $$ BEGIN
  CREATE POLICY "transcription_usage_insert_policy" ON public.transcription_usage FOR INSERT TO authenticated WITH CHECK ((SELECT auth.uid()) = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "transcription_usage_update_policy" ON public.transcription_usage FOR UPDATE TO authenticated USING ((SELECT auth.uid()) = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "transcription_usage_delete_policy" ON public.transcription_usage FOR DELETE TO authenticated USING ((SELECT auth.uid()) = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "circuit_breaker_logs_insert_own" ON public.circuit_breaker_logs FOR INSERT TO authenticated WITH CHECK (user_id = (SELECT auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  DROP POLICY IF EXISTS "cleanup_logs_authenticated_select" ON public.cleanup_logs;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION public.increment_routine_completion(
  p_completion_id uuid,
  p_routine_id uuid,
  p_date_key date
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'pg_catalog', 'public'
AS $$
DECLARE
  v_user_id uuid;
  v_next_count integer;
BEGIN
  v_user_id := auth.uid();

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required'
      USING ERRCODE = '42501';
  END IF;

  PERFORM 1
  FROM public.routine_tasks
  WHERE id = p_routine_id
    AND user_id = v_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Routine not found'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.routine_completion_events (id, routine_id, user_id, date_key)
  VALUES (p_completion_id, p_routine_id, v_user_id, p_date_key)
  ON CONFLICT (id) DO NOTHING;

  IF NOT FOUND THEN
    SELECT count
    INTO v_next_count
    FROM public.routine_completions
    WHERE user_id = v_user_id
      AND routine_id = p_routine_id
      AND date_key = p_date_key;

    RETURN COALESCE(v_next_count, 0);
  END IF;

  INSERT INTO public.routine_completions (id, routine_id, user_id, date_key, count)
  VALUES (p_completion_id, p_routine_id, v_user_id, p_date_key, 1)
  ON CONFLICT (user_id, routine_id, date_key) DO UPDATE
  SET count = public.routine_completions.count + 1
  RETURNING count INTO v_next_count;

  RETURN v_next_count;
END;
$$;

REVOKE ALL ON FUNCTION public.increment_routine_completion(uuid, uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.increment_routine_completion(uuid, uuid, date) TO authenticated;

-- 自动 VACUUM 阈值调优（小表默认 50 太高）
ALTER TABLE public.tasks SET (autovacuum_vacuum_threshold = 10, autovacuum_analyze_threshold = 10);
ALTER TABLE public.connections SET (autovacuum_vacuum_threshold = 10, autovacuum_analyze_threshold = 10);
ALTER TABLE public.projects SET (autovacuum_vacuum_threshold = 10, autovacuum_analyze_threshold = 10);
ALTER TABLE public.black_box_entries SET (autovacuum_vacuum_threshold = 10, autovacuum_analyze_threshold = 10);
ALTER TABLE public.user_preferences SET (autovacuum_vacuum_threshold = 5, autovacuum_analyze_threshold = 5);

-- 连接保护：防止长查询占用连接池
ALTER ROLE authenticated SET statement_timeout = '30s';

COMMENT ON SCHEMA public IS
  '全量优化 v6.0.0: FORCE RLS 全覆盖, 冗余索引清理, 备份索引整合, autovacuum 调优, statement_timeout 30s';

-- ============================================================
-- Personal Backend Slim-Down Overlay (v6.3.0)
-- 使一次性初始化后的最终状态与 2026-03-19 主库迁移保持一致。
-- ============================================================


CREATE OR REPLACE FUNCTION public.user_accessible_project_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = 'pg_catalog', 'public'
AS $$
  SELECT id
  FROM public.projects
  WHERE owner_id = public.current_user_id()
    AND deleted_at IS NULL
$$;

CREATE OR REPLACE FUNCTION public.user_has_project_access(p_project_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = 'pg_catalog', 'public'
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.projects p
    WHERE p.id = p_project_id
      AND p.owner_id = public.current_user_id()
  )
$$;

CREATE OR REPLACE FUNCTION public.soft_delete_project(p_project_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'pg_catalog', 'public'
AS $$
DECLARE
  v_user_id uuid;
  v_owner_id uuid;
  v_deleted_at timestamptz;
  v_operation_ts timestamptz;
BEGIN
  v_user_id := auth.uid();

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required'
      USING ERRCODE = '42501';
  END IF;

  SELECT owner_id, deleted_at
  INTO v_owner_id, v_deleted_at
  FROM public.projects
  WHERE id = p_project_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN true;
  END IF;

  IF v_owner_id IS DISTINCT FROM v_user_id THEN
    RETURN true;
  END IF;

  IF v_deleted_at IS NOT NULL THEN
    RETURN true;
  END IF;

  v_operation_ts := now();

  UPDATE public.tasks
  SET deleted_at = v_operation_ts,
      updated_at = CASE
        WHEN updated_at IS NULL OR updated_at < v_operation_ts THEN v_operation_ts
        ELSE updated_at
      END
  WHERE project_id = p_project_id
    AND deleted_at IS NULL;

  UPDATE public.connections
  SET deleted_at = v_operation_ts,
      updated_at = CASE
        WHEN updated_at IS NULL OR updated_at < v_operation_ts THEN v_operation_ts
        ELSE updated_at
      END
  WHERE project_id = p_project_id
    AND deleted_at IS NULL;

  INSERT INTO public.task_tombstones (task_id, project_id, deleted_at, deleted_by)
  SELECT
    t.id,
    t.project_id,
    COALESCE(t.deleted_at, v_operation_ts),
    v_user_id
  FROM public.tasks t
  WHERE t.project_id = p_project_id
  ON CONFLICT (task_id) DO UPDATE
  SET project_id = EXCLUDED.project_id,
      deleted_at = GREATEST(public.task_tombstones.deleted_at, EXCLUDED.deleted_at),
      deleted_by = COALESCE(public.task_tombstones.deleted_by, EXCLUDED.deleted_by);

  INSERT INTO public.connection_tombstones (connection_id, project_id, deleted_at, deleted_by)
  SELECT
    c.id,
    c.project_id,
    COALESCE(c.deleted_at, v_operation_ts),
    v_user_id
  FROM public.connections c
  WHERE c.project_id = p_project_id
  ON CONFLICT (connection_id) DO UPDATE
  SET project_id = EXCLUDED.project_id,
      deleted_at = GREATEST(public.connection_tombstones.deleted_at, EXCLUDED.deleted_at),
      deleted_by = COALESCE(public.connection_tombstones.deleted_by, EXCLUDED.deleted_by);

  UPDATE public.projects
  SET deleted_at = v_operation_ts,
      updated_at = v_operation_ts
  WHERE id = p_project_id;

  RETURN true;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.soft_delete_project(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.soft_delete_project(uuid) TO authenticated;

DROP POLICY IF EXISTS "owner select" ON public.projects;
CREATE POLICY "owner select" ON public.projects
FOR SELECT
USING (((SELECT auth.uid() AS uid) = owner_id));

DROP POLICY IF EXISTS "owner update" ON public.projects;
CREATE POLICY "owner update" ON public.projects
FOR UPDATE
USING (((SELECT auth.uid() AS uid) = owner_id))
WITH CHECK ((SELECT auth.uid() AS uid) = owner_id);

DROP POLICY IF EXISTS "owner delete" ON public.projects;
CREATE POLICY "owner delete" ON public.projects
FOR DELETE
USING (((SELECT auth.uid() AS uid) = owner_id) AND (deleted_at IS NULL));


CREATE OR REPLACE FUNCTION public.cleanup_cron_job_run_details(
  p_max_age interval DEFAULT interval '7 days'
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'pg_catalog', 'cron'
AS $$
DECLARE
  v_deleted_count integer := 0;
BEGIN
  WITH deleted AS (
    DELETE FROM cron.job_run_details
    WHERE end_time < now() - p_max_age
    RETURNING 1
  )
  SELECT count(*) INTO v_deleted_count FROM deleted;

  RETURN v_deleted_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.cleanup_personal_retention_artifacts()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'pg_catalog', 'public'
AS $$
DECLARE
  v_focus_sessions_deleted integer := 0;
  v_transcription_usage_deleted integer := 0;
  v_task_tombstones_deleted integer := 0;
  v_connection_tombstones_deleted integer := 0;
BEGIN
  WITH deleted AS (
    DELETE FROM public.focus_sessions
    WHERE ended_at IS NOT NULL
      AND updated_at < now() - interval '30 days'
    RETURNING 1
  )
  SELECT count(*) INTO v_focus_sessions_deleted FROM deleted;

  WITH deleted AS (
    DELETE FROM public.transcription_usage
    WHERE created_at < now() - interval '90 days'
    RETURNING 1
  )
  SELECT count(*) INTO v_transcription_usage_deleted FROM deleted;

  WITH deleted AS (
    DELETE FROM public.task_tombstones
    WHERE deleted_at < now() - interval '30 days'
    RETURNING 1
  )
  SELECT count(*) INTO v_task_tombstones_deleted FROM deleted;

  WITH deleted AS (
    DELETE FROM public.connection_tombstones
    WHERE deleted_at < now() - interval '30 days'
    RETURNING 1
  )
  SELECT count(*) INTO v_connection_tombstones_deleted FROM deleted;

  IF (v_focus_sessions_deleted + v_transcription_usage_deleted + v_task_tombstones_deleted + v_connection_tombstones_deleted) > 0 THEN
    INSERT INTO public.cleanup_logs (type, details)
    VALUES (
      'personal_retention_cleanup',
      jsonb_build_object(
        'focus_sessions_deleted', v_focus_sessions_deleted,
        'transcription_usage_deleted', v_transcription_usage_deleted,
        'task_tombstones_deleted', v_task_tombstones_deleted,
        'connection_tombstones_deleted', v_connection_tombstones_deleted,
        'cleanup_time', now()
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'focus_sessions_deleted', v_focus_sessions_deleted,
    'transcription_usage_deleted', v_transcription_usage_deleted,
    'task_tombstones_deleted', v_task_tombstones_deleted,
    'connection_tombstones_deleted', v_connection_tombstones_deleted
  );
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_personal_retention_artifacts() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cleanup_personal_retention_artifacts() FROM anon;
REVOKE ALL ON FUNCTION public.cleanup_personal_retention_artifacts() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_personal_retention_artifacts() TO service_role;

DELETE FROM cron.job_run_details;

DO $$
DECLARE
  v_job record;
BEGIN
  FOR v_job IN
    SELECT jobid
    FROM cron.job
    WHERE jobname IN ('nanoflow-personal-retention', 'nanoflow-cron-log-retention')
  LOOP
    PERFORM cron.unschedule(v_job.jobid);
  END LOOP;

  PERFORM cron.schedule(
    'nanoflow-personal-retention',
    '40 20 * * *',
    $cmd$SELECT public.cleanup_personal_retention_artifacts();$cmd$
  );

  PERFORM cron.schedule(
    'nanoflow-cron-log-retention',
    '55 20 * * *',
    $cmd$SELECT public.cleanup_cron_job_run_details(interval '7 days');$cmd$
  );
END $$;

ALTER TABLE public.user_preferences
DROP CONSTRAINT IF EXISTS user_preferences_dock_snapshot_size_check;

DROP TABLE IF EXISTS public.project_members CASCADE;
DROP TABLE IF EXISTS public.attachment_scans CASCADE;
DROP TABLE IF EXISTS public.quarantined_files CASCADE;

ALTER TABLE public.user_preferences
DROP COLUMN IF EXISTS dock_snapshot;

-- ============================================================
-- batch_get_tombstones：批量 tombstone 查询（免费 tier 优化）
-- ============================================================

CREATE OR REPLACE FUNCTION public.batch_get_tombstones(
  p_project_ids UUID[]
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID;
  v_result JSON;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = 'P0001';
  END IF;

  SELECT json_build_object(
    'task_tombstones',
    COALESCE(
      (SELECT json_agg(json_build_object(
        'project_id', tt.project_id,
        'task_id', tt.task_id,
        'deleted_at', tt.deleted_at
      ))
       FROM public.task_tombstones tt
       INNER JOIN public.projects p ON p.id = tt.project_id
       WHERE tt.project_id = ANY(p_project_ids)
         AND p.owner_id = v_user_id),
      '[]'::json
    ),
    'connection_tombstones',
    COALESCE(
      (SELECT json_agg(json_build_object('project_id', ct.project_id, 'connection_id', ct.connection_id))
       FROM public.connection_tombstones ct
       INNER JOIN public.projects p ON p.id = ct.project_id
       WHERE ct.project_id = ANY(p_project_ids)
         AND p.owner_id = v_user_id),
      '[]'::json
    )
  ) INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.batch_get_tombstones(UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.batch_get_tombstones(UUID[]) TO authenticated;

COMMENT ON FUNCTION public.batch_get_tombstones IS
  '批量获取多项目 tombstone：1 次 RPC 替代 N 次查询，降低免费 tier API 消耗';

CREATE OR REPLACE FUNCTION public.widget_summary_wave1(
  p_user_id UUID,
  p_today DATE,
  p_preview_limit INT DEFAULT 6
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_session_json JSONB := NULL;
  v_accessible_project_ids UUID[] := ARRAY[]::UUID[];
  v_pending_count INT := 0;
  v_unread_count INT := 0;
  v_preview JSONB := '[]'::JSONB;
  v_black_box_watermark TIMESTAMPTZ;
  v_gate_read_cooldown_cutoff TIMESTAMPTZ := now() - interval '30 minutes';
  v_next_gate_review_at TIMESTAMPTZ;
  v_dock_count INT := 0;
  v_dock_watermark TIMESTAMPTZ;
BEGIN
  SELECT jsonb_build_object(
    'id', id,
    'updated_at', updated_at,
    'session_state', session_state
  )
    INTO v_session_json
    FROM public.focus_sessions
    WHERE user_id = p_user_id
    ORDER BY updated_at DESC
    LIMIT 1;

  SELECT COALESCE(array_agg(id), ARRAY[]::UUID[])
    INTO v_accessible_project_ids
    FROM public.projects
    WHERE owner_id = p_user_id
      AND deleted_at IS NULL;

  SELECT count(*)::INT
    INTO v_pending_count
    FROM public.black_box_entries
    WHERE user_id = p_user_id
      AND deleted_at IS NULL
      AND is_completed = FALSE
      AND is_archived = FALSE
      AND date < p_today
      AND (snooze_until IS NULL OR snooze_until <= p_today)
      AND (is_read = FALSE OR updated_at <= v_gate_read_cooldown_cutoff);

  SELECT count(*)::INT
    INTO v_unread_count
    FROM public.black_box_entries
    WHERE user_id = p_user_id
      AND deleted_at IS NULL
      AND is_read = FALSE
      AND is_completed = FALSE
      AND is_archived = FALSE
      AND date < p_today
      AND (snooze_until IS NULL OR snooze_until <= p_today);

  SELECT max(updated_at)
    INTO v_black_box_watermark
    FROM public.black_box_entries
    WHERE user_id = p_user_id
      AND deleted_at IS NULL
      AND is_archived = FALSE
      AND date < p_today;

  SELECT min(updated_at + interval '30 minutes')
    INTO v_next_gate_review_at
    FROM public.black_box_entries
    WHERE user_id = p_user_id
      AND deleted_at IS NULL
      AND is_read = TRUE
      AND is_completed = FALSE
      AND is_archived = FALSE
      AND date < p_today
      AND (snooze_until IS NULL OR snooze_until <= p_today)
      AND updated_at > v_gate_read_cooldown_cutoff;

  SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'id', bb.id,
        'date', bb.date,
        'project_id', bb.project_id,
        'content', bb.content,
        'is_read', bb.is_read,
        'created_at', bb.created_at,
        'snooze_until', bb.snooze_until,
        'updated_at', bb.updated_at
      ) ORDER BY bb.created_at ASC
    ), '[]'::JSONB)
    INTO v_preview
    FROM (
      SELECT id, date, project_id, content, is_read, created_at, snooze_until, updated_at
        FROM public.black_box_entries
        WHERE user_id = p_user_id
          AND deleted_at IS NULL
          AND is_completed = FALSE
          AND is_archived = FALSE
          AND date < p_today
          AND (snooze_until IS NULL OR snooze_until <= p_today)
          AND (is_read = FALSE OR updated_at <= v_gate_read_cooldown_cutoff)
        ORDER BY created_at ASC
        LIMIT greatest(p_preview_limit, 0)
    ) bb;

  IF array_length(v_accessible_project_ids, 1) IS NOT NULL THEN
    SELECT count(*)::INT, max(updated_at)
      INTO v_dock_count, v_dock_watermark
      FROM public.tasks
      WHERE project_id = ANY(v_accessible_project_ids)
        AND deleted_at IS NULL
        AND parking_meta @> '{"state":"parked"}'::jsonb;
  END IF;

  RETURN jsonb_build_object(
    'focusSession', v_session_json,
    'accessibleProjectIds', to_jsonb(v_accessible_project_ids),
    'pendingBlackBoxCount', v_pending_count,
    'unreadBlackBoxCount', v_unread_count,
    'nextGateReviewAt', v_next_gate_review_at,
    'blackBoxPreview', v_preview,
    'blackBoxWatermark', v_black_box_watermark,
    'dockCount', v_dock_count,
    'dockWatermark', v_dock_watermark
  );
END;
$$;

REVOKE ALL ON FUNCTION public.widget_summary_wave1(UUID, DATE, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.widget_summary_wave1(UUID, DATE, INT) TO service_role;

COMMENT ON FUNCTION public.widget_summary_wave1(UUID, DATE, INT) IS
  'Widget summary 第一波聚合：focus_sessions + projects + black_box read cooldown pending/unread count/preview/watermark + dock count/watermark 合并到单次 RPC，把 4-5 个 PostgREST roundtrip 压缩到 1 个。';

-- ============================================================
-- [MIGRATION] 20260412143000_widget_backend_foundation.sql
-- Widget backend foundation: device auth, instance boundaries,
-- rate limiting, notify dedupe, and kill switch defaults.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.widget_devices (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('android-widget')),
  installation_id TEXT NOT NULL,
  push_token TEXT NULL,
  push_token_updated_at TIMESTAMPTZ NULL,
  secret_hash TEXT NOT NULL,
  token_hash TEXT NULL,
  capabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
  binding_generation INTEGER NOT NULL DEFAULT 1 CHECK (binding_generation >= 1),
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_bound_user_hash TEXT NOT NULL,
  revoked_at TIMESTAMPTZ NULL,
  revoke_reason TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (platform, installation_id)
);

ALTER TABLE public.widget_devices
  ADD COLUMN IF NOT EXISTS token_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_widget_devices_user_platform_active
  ON public.widget_devices (user_id, platform, updated_at DESC)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_widget_devices_expires_at
  ON public.widget_devices (expires_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_widget_devices_token_hash
  ON public.widget_devices (token_hash)
  WHERE token_hash IS NOT NULL;

DROP TRIGGER IF EXISTS trg_widget_devices_updated_at ON public.widget_devices;
CREATE TRIGGER trg_widget_devices_updated_at
  BEFORE UPDATE ON public.widget_devices
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.widget_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.widget_devices FORCE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.widget_instances (
  id UUID PRIMARY KEY,
  device_id UUID NOT NULL REFERENCES public.widget_devices(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('android-widget')),
  host_instance_id TEXT NOT NULL,
  size_bucket TEXT NOT NULL,
  config_scope TEXT NOT NULL DEFAULT 'global-summary' CHECK (config_scope IN ('global-summary')),
  privacy_mode TEXT NOT NULL DEFAULT 'minimal' CHECK (privacy_mode IN ('minimal')),
  binding_generation INTEGER NOT NULL DEFAULT 1 CHECK (binding_generation >= 1),
  installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  uninstalled_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (device_id, host_instance_id)
);

CREATE INDEX IF NOT EXISTS idx_widget_instances_device_active
  ON public.widget_instances (device_id, updated_at DESC)
  WHERE uninstalled_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_widget_instances_user_platform
  ON public.widget_instances (user_id, platform, updated_at DESC);

DROP TRIGGER IF EXISTS trg_widget_instances_updated_at ON public.widget_instances;
CREATE TRIGGER trg_widget_instances_updated_at
  BEFORE UPDATE ON public.widget_instances
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.widget_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.widget_instances FORCE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.widget_request_rate_limits (
  scope_type TEXT NOT NULL CHECK (scope_type IN ('device', 'user', 'ip')),
  scope_key TEXT NOT NULL,
  call_count INTEGER NOT NULL DEFAULT 0 CHECK (call_count >= 0),
  window_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  blocked_until TIMESTAMPTZ NULL,
  last_decision TEXT NOT NULL DEFAULT 'allow' CHECK (last_decision IN ('allow', 'deny')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (scope_type, scope_key)
);

CREATE INDEX IF NOT EXISTS idx_widget_request_rate_limits_blocked_until
  ON public.widget_request_rate_limits (blocked_until)
  WHERE blocked_until IS NOT NULL;

DROP TRIGGER IF EXISTS trg_widget_request_rate_limits_updated_at ON public.widget_request_rate_limits;
CREATE TRIGGER trg_widget_request_rate_limits_updated_at
  BEFORE UPDATE ON public.widget_request_rate_limits
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.widget_request_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.widget_request_rate_limits FORCE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.widget_notify_events (
  webhook_id TEXT PRIMARY KEY,
  user_id UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  source_table TEXT NOT NULL CHECK (source_table IN ('focus_sessions', 'black_box_entries', 'tasks', 'projects')),
  event_type TEXT NOT NULL CHECK (event_type IN ('INSERT', 'UPDATE', 'DELETE')),
  summary_cursor TEXT NULL,
  last_status TEXT NOT NULL DEFAULT 'processing',
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_widget_notify_events_user_processed
  ON public.widget_notify_events (user_id, processed_at DESC);

DROP TRIGGER IF EXISTS trg_widget_notify_events_updated_at ON public.widget_notify_events;
CREATE TRIGGER trg_widget_notify_events_updated_at
  BEFORE UPDATE ON public.widget_notify_events
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.widget_notify_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.widget_notify_events FORCE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.widget_notify_throttle (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  last_notified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_summary_version TEXT NULL,
  last_event_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_widget_notify_throttle_updated_at ON public.widget_notify_throttle;
CREATE TRIGGER trg_widget_notify_throttle_updated_at
  BEFORE UPDATE ON public.widget_notify_throttle
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.widget_notify_throttle ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.widget_notify_throttle FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.consume_widget_rate_limit(
  p_scope_type TEXT,
  p_scope_key TEXT,
  p_max_calls INTEGER,
  p_window_seconds INTEGER DEFAULT 60,
  p_block_seconds INTEGER DEFAULT 300
)
RETURNS TABLE (
  allowed BOOLEAN,
  retry_after_seconds INTEGER,
  remaining_calls INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_record public.widget_request_rate_limits%ROWTYPE;
  v_now TIMESTAMPTZ := NOW();
  v_next_count INTEGER;
  v_retry_after INTEGER := 0;
BEGIN
  IF p_scope_type NOT IN ('device', 'user', 'ip') THEN
    RAISE EXCEPTION 'Invalid widget rate limit scope';
  END IF;
  IF COALESCE(length(trim(p_scope_key)), 0) = 0 THEN
    RAISE EXCEPTION 'Invalid widget rate limit scope key';
  END IF;
  IF p_max_calls < 1 THEN
    RAISE EXCEPTION 'Invalid widget rate limit max calls';
  END IF;

  INSERT INTO public.widget_request_rate_limits (
    scope_type,
    scope_key,
    call_count,
    window_start,
    blocked_until,
    last_decision,
    created_at,
    updated_at
  )
  VALUES (
    p_scope_type,
    p_scope_key,
    0,
    v_now,
    NULL,
    'allow',
    v_now,
    v_now
  )
  ON CONFLICT (scope_type, scope_key) DO NOTHING;

  SELECT *
  INTO v_record
  FROM public.widget_request_rate_limits
  WHERE scope_type = p_scope_type
    AND scope_key = p_scope_key
  FOR UPDATE;

  IF v_record.blocked_until IS NOT NULL AND v_record.blocked_until > v_now THEN
    v_retry_after := GREATEST(1, CEIL(EXTRACT(EPOCH FROM (v_record.blocked_until - v_now)))::INTEGER);
    UPDATE public.widget_request_rate_limits
    SET last_decision = 'deny', updated_at = v_now
    WHERE scope_type = p_scope_type AND scope_key = p_scope_key;
    RETURN QUERY SELECT FALSE, v_retry_after, 0;
    RETURN;
  END IF;

  IF v_record.window_start <= v_now - make_interval(secs => GREATEST(p_window_seconds, 1)) THEN
    v_next_count := 1;
    UPDATE public.widget_request_rate_limits
    SET call_count = v_next_count,
        window_start = v_now,
        blocked_until = NULL,
        last_decision = 'allow',
        updated_at = v_now
    WHERE scope_type = p_scope_type AND scope_key = p_scope_key;
    RETURN QUERY SELECT TRUE, 0, GREATEST(p_max_calls - v_next_count, 0);
    RETURN;
  END IF;

  v_next_count := v_record.call_count + 1;
  IF v_next_count > p_max_calls THEN
    UPDATE public.widget_request_rate_limits
    SET call_count = v_next_count,
        blocked_until = v_now + make_interval(secs => GREATEST(p_block_seconds, 1)),
        last_decision = 'deny',
        updated_at = v_now
    WHERE scope_type = p_scope_type AND scope_key = p_scope_key;
    RETURN QUERY SELECT FALSE, GREATEST(p_block_seconds, 1), 0;
    RETURN;
  END IF;

  UPDATE public.widget_request_rate_limits
  SET call_count = v_next_count,
      last_decision = 'allow',
      updated_at = v_now
  WHERE scope_type = p_scope_type AND scope_key = p_scope_key;

  RETURN QUERY SELECT TRUE, 0, GREATEST(p_max_calls - v_next_count, 0);
END;
$$;

REVOKE ALL ON TABLE public.widget_devices FROM anon, authenticated;
REVOKE ALL ON TABLE public.widget_instances FROM anon, authenticated;
REVOKE ALL ON TABLE public.widget_request_rate_limits FROM anon, authenticated;
REVOKE ALL ON TABLE public.widget_notify_events FROM anon, authenticated;
REVOKE ALL ON TABLE public.widget_notify_throttle FROM anon, authenticated;
GRANT ALL ON TABLE public.widget_devices TO service_role;
GRANT ALL ON TABLE public.widget_instances TO service_role;
GRANT ALL ON TABLE public.widget_request_rate_limits TO service_role;
GRANT ALL ON TABLE public.widget_notify_events TO service_role;
GRANT ALL ON TABLE public.widget_notify_throttle TO service_role;

REVOKE ALL ON FUNCTION public.consume_widget_rate_limit(TEXT, TEXT, INTEGER, INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_widget_rate_limit(TEXT, TEXT, INTEGER, INTEGER, INTEGER)
  TO service_role;

INSERT INTO public.app_config (key, value, description)
VALUES (
  'widget_capabilities',
  jsonb_build_object(
    'widgetEnabled', true,
    'installAllowed', true,
    'refreshAllowed', true,
    'pushAllowed', false,
    'reason', NULL,
    'rules', jsonb_build_array()
  ),
  'Widget backend capability gates and kill switch defaults'
)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.app_config (key, value, description)
VALUES (
  'widget_limits',
  jsonb_build_object(
    'registerUserPerMinute', 10,
    'registerIpPerMinute', 20,
    'summaryDevicePerMinute', 30,
    'summaryUserPerMinute', 60,
    'summaryIpPerMinute', 120,
    'notifyUserPerMinute', 120,
    'notifyIpPerMinute', 600,
    'blockSeconds', 300,
    'tokenTtlDays', 30,
    'freshThresholdMinutes', 5,
    'agingThresholdMinutes', 60
  ),
  'Widget backend rate limits and freshness thresholds'
)
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- [MIGRATION] 20260413102000_widget_notify_webhook_hmac.sql
-- Widget notify direct webhook wiring via pg_net + Vault-backed HMAC headers.
-- ============================================================

CREATE OR REPLACE FUNCTION public.invoke_widget_notify_webhook()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, vault, extensions
AS $$
DECLARE
  v_base_url TEXT;
  v_secret TEXT;
  v_timestamp TEXT;
  v_event_id TEXT;
  v_payload JSONB;
  v_signature TEXT;
BEGIN
  v_base_url := public.get_vault_secret('widget_notify_base_url');
  v_secret := public.get_vault_secret('widget_notify_webhook_secret');

  IF COALESCE(trim(v_base_url), '') = '' OR COALESCE(trim(v_secret), '') = '' THEN
    RAISE LOG 'widget-notify webhook secrets are missing; skip enqueue';
    RETURN NULL;
  END IF;

  v_timestamp := floor(extract(epoch FROM clock_timestamp()))::bigint::text;
  v_event_id := gen_random_uuid()::text;
  v_payload := jsonb_build_object(
    'type', TG_OP,
    'table', TG_TABLE_NAME,
    'schema', TG_TABLE_SCHEMA,
    'record', CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END,
    'old_record', CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END
  );

  v_signature := encode(
    hmac(
      convert_to(v_timestamp || '.' || v_payload::text, 'utf8'),
      convert_to(v_secret, 'utf8'),
      'sha256'
    ),
    'hex'
  );

  PERFORM net.http_post(
    url := rtrim(v_base_url, '/') || '/functions/v1/widget-notify',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-widget-webhook-event-id', v_event_id,
      'x-widget-webhook-timestamp', v_timestamp,
      'x-widget-webhook-signature', v_signature
    ),
    body := v_payload
  );

  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE LOG 'widget-notify webhook enqueue failed: %', SQLERRM;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.invoke_widget_notify_webhook() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS widget_notify_focus_session_change ON public.focus_sessions;
CREATE TRIGGER widget_notify_focus_session_change
  AFTER INSERT OR UPDATE OR DELETE ON public.focus_sessions
  FOR EACH ROW
  EXECUTE FUNCTION public.invoke_widget_notify_webhook();

DROP TRIGGER IF EXISTS widget_notify_black_box_change ON public.black_box_entries;
CREATE TRIGGER widget_notify_black_box_change
  AFTER INSERT OR UPDATE OR DELETE ON public.black_box_entries
  FOR EACH ROW
  EXECUTE FUNCTION public.invoke_widget_notify_webhook();

DROP TRIGGER IF EXISTS widget_notify_task_change ON public.tasks;
CREATE TRIGGER widget_notify_task_change
  AFTER INSERT OR UPDATE OR DELETE ON public.tasks
  FOR EACH ROW
  EXECUTE FUNCTION public.invoke_widget_notify_webhook();

DROP TRIGGER IF EXISTS widget_notify_project_change ON public.projects;
CREATE TRIGGER widget_notify_project_change
  AFTER INSERT OR UPDATE OR DELETE ON public.projects
  FOR EACH ROW
  EXECUTE FUNCTION public.invoke_widget_notify_webhook();

-- ============================================================
-- [MIGRATION] 20260413113000_widget_notify_hmac_replay_fix.sql
-- Bind event_id into HMAC and tighten SECURITY DEFINER search_path.
-- ============================================================

CREATE OR REPLACE FUNCTION public.invoke_widget_notify_webhook()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, vault, extensions
AS $$
DECLARE
  v_base_url TEXT;
  v_secret TEXT;
  v_timestamp TEXT;
  v_event_id TEXT;
  v_payload JSONB;
  v_signature TEXT;
BEGIN
  v_base_url := public.get_vault_secret('widget_notify_base_url');
  v_secret := public.get_vault_secret('widget_notify_webhook_secret');

  IF COALESCE(trim(v_base_url), '') = '' OR COALESCE(trim(v_secret), '') = '' THEN
    RAISE LOG 'widget-notify webhook secrets are missing; skip enqueue';
    RETURN NULL;
  END IF;

  v_timestamp := floor(extract(epoch FROM clock_timestamp()))::bigint::text;
  v_event_id := extensions.gen_random_uuid()::text;
  v_payload := jsonb_build_object(
    'type', TG_OP,
    'table', TG_TABLE_NAME,
    'schema', TG_TABLE_SCHEMA,
    'record', CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END,
    'old_record', CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END
  );

  v_signature := encode(
    extensions.hmac(
      convert_to(v_event_id || '.' || v_timestamp || '.' || v_payload::text, 'utf8'),
      convert_to(v_secret, 'utf8'),
      'sha256'
    ),
    'hex'
  );

  PERFORM net.http_post(
    url := rtrim(v_base_url, '/') || '/functions/v1/widget-notify',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-widget-webhook-event-id', v_event_id,
      'x-widget-webhook-timestamp', v_timestamp,
      'x-widget-webhook-signature', v_signature
    ),
    body := v_payload
  );

  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE LOG 'widget-notify webhook enqueue failed: %', SQLERRM;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.invoke_widget_notify_webhook() FROM PUBLIC, anon, authenticated;

-- ============================================================
-- [MIGRATION] 20260413120000_widget_notify_secret_normalization.sql
-- Normalize webhook secret before signing to match Edge verification semantics.
-- ============================================================

CREATE OR REPLACE FUNCTION public.invoke_widget_notify_webhook()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, vault, extensions
AS $$
DECLARE
  v_base_url TEXT;
  v_secret TEXT;
  v_timestamp TEXT;
  v_event_id TEXT;
  v_payload JSONB;
  v_signature TEXT;
BEGIN
  v_base_url := public.get_vault_secret('widget_notify_base_url');
  v_secret := regexp_replace(trim(public.get_vault_secret('widget_notify_webhook_secret')), '^v1,whsec_', '');

  IF COALESCE(trim(v_base_url), '') = '' OR COALESCE(v_secret, '') = '' THEN
    RAISE LOG 'widget-notify webhook secrets are missing; skip enqueue';
    RETURN NULL;
  END IF;

  v_timestamp := floor(extract(epoch FROM clock_timestamp()))::bigint::text;
  v_event_id := extensions.gen_random_uuid()::text;
  v_payload := jsonb_build_object(
    'type', TG_OP,
    'table', TG_TABLE_NAME,
    'schema', TG_TABLE_SCHEMA,
    'record', CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END,
    'old_record', CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END
  );

  v_signature := encode(
    extensions.hmac(
      convert_to(v_event_id || '.' || v_timestamp || '.' || v_payload::text, 'utf8'),
      convert_to(v_secret, 'utf8'),
      'sha256'
    ),
    'hex'
  );

  PERFORM net.http_post(
    url := rtrim(v_base_url, '/') || '/functions/v1/widget-notify',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-widget-webhook-event-id', v_event_id,
      'x-widget-webhook-timestamp', v_timestamp,
      'x-widget-webhook-signature', v_signature
    ),
    body := v_payload
  );

  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE LOG 'widget-notify webhook enqueue failed: %', SQLERRM;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.invoke_widget_notify_webhook() FROM PUBLIC, anon, authenticated;

-- ============================================================
-- [MIGRATION] 20260413121000_widget_notify_limits_backfill.sql
-- Backfill notify-specific rate limits into app_config for existing projects.
-- ============================================================

INSERT INTO public.app_config (key, value, description)
VALUES (
  'widget_limits',
  jsonb_build_object(
    'registerUserPerMinute', 10,
    'registerIpPerMinute', 20,
    'summaryDevicePerMinute', 30,
    'summaryUserPerMinute', 60,
    'summaryIpPerMinute', 120,
    'notifyUserPerMinute', 120,
    'notifyIpPerMinute', 600,
    'blockSeconds', 300,
    'tokenTtlDays', 30,
    'freshThresholdMinutes', 5,
    'agingThresholdMinutes', 60
  ),
  'Widget backend rate limits and freshness thresholds'
)
ON CONFLICT (key) DO UPDATE
SET value = COALESCE(public.app_config.value, '{}'::jsonb) || jsonb_build_object(
      'notifyUserPerMinute', COALESCE((public.app_config.value ->> 'notifyUserPerMinute')::INTEGER, 120),
      'notifyIpPerMinute', COALESCE((public.app_config.value ->> 'notifyIpPerMinute')::INTEGER, 600)
    ),
    description = EXCLUDED.description,
    updated_at = NOW();

-- ============================================================
-- 初始化完成
-- ============================================================
