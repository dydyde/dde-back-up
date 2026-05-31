import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function readSql(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function getSection(sql: string, startMarker: string, endMarker: string): string {
  const startIndex = sql.indexOf(startMarker);
  expect(startIndex).toBeGreaterThanOrEqual(0);

  const endIndex = sql.indexOf(endMarker, startIndex);
  expect(endIndex).toBeGreaterThan(startIndex);

  return sql.slice(startIndex, endIndex);
}

function expectOwnerOnlyBatchUpsert(section: string, ownerMarker: string): void {
  expect(section).toContain(ownerMarker);
  expect(section).not.toContain('FROM public.project_members pm');
  expect(section).toContain('INSERT INTO public.tasks AS existing');
  expect(section).not.toContain("COALESCE(v_task->'attachments', '[]'::jsonb)");
  expect(section).toContain("attachments = COALESCE(existing.attachments, '[]'::jsonb)");
  expect(section).toContain('WHERE existing.project_id = p_project_id');
  expect(section).toContain("RAISE EXCEPTION 'Task project mismatch'");
  expect(section).not.toContain('attachments = EXCLUDED.attachments');
}

function expectOwnerOnlyPurge(section: string): void {
  const normalized = section.replace(/\s+/g, ' ');

  const hasDirectOwnerCheck = normalized.includes('p.id = p_project_id')
    && normalized.includes('p.owner_id = auth.uid()');
  const hasAccessHelperCheck = normalized.includes('public.user_has_project_access(p_project_id)');

  expect(hasDirectOwnerCheck || hasAccessHelperCheck).toBe(true);
  expect(section).toContain("RAISE EXCEPTION 'not authorized'");
  expect(section).toContain('WHERE t.project_id = p_project_id');
}

function expectOwnerOnlyAttachmentStorageRead(section: string): void {
  expect(section).toContain("bucket_id = 'attachments'");
  expect(section).toContain('(storage.foldername(name))[1] = auth.uid()::text');
  expect(section).not.toContain('project_members');
}

function expectOwnerOnlyProjectMembersPolicy(section: string): void {
  const normalized = section.replaceAll('"', '').replace(/\s+/g, ' ');

  expect(normalized).toContain('p.owner_id');
  expect(normalized).toContain('auth.uid()');
  expect(normalized).not.toContain('user_id =');
  expect(normalized).not.toContain('FROM public.project_members pm');
  expect(normalized).not.toContain("pm.role = 'admin'");
}

describe('SQL 安全加固契约', () => {
  it('init script 中的附件 RPC 必须校验项目访问权限', () => {
    const sql = readSql('scripts/init-supabase.sql');
    const appendSection = getSection(
      sql,
      'CREATE OR REPLACE FUNCTION append_task_attachment',
      'CREATE OR REPLACE FUNCTION remove_task_attachment',
    );
    const removeSection = getSection(
      sql,
      'CREATE OR REPLACE FUNCTION remove_task_attachment',
      'GRANT EXECUTE ON FUNCTION append_task_attachment(UUID, JSONB) TO authenticated;',
    );

    for (const section of [appendSection, removeSection]) {
      expect(section).toContain('public.user_is_project_owner');
      expect(section).toContain("RAISE EXCEPTION 'not authorized'");
      expect(section).toContain('FROM public.tasks');
    }
  });

  it('migration 中的附件 RPC 必须收紧为 owner-only', () => {
    const sql = readSql('supabase/migrations/20260126074130_remote_commit.sql');
    const appendSection = getSection(
      sql,
      'CREATE OR REPLACE FUNCTION "public"."append_task_attachment"',
      'ALTER FUNCTION "public"."append_task_attachment"',
    );
    const removeSection = getSection(
      sql,
      'CREATE OR REPLACE FUNCTION "public"."remove_task_attachment"',
      'ALTER FUNCTION "public"."remove_task_attachment"',
    );

    for (const section of [appendSection, removeSection]) {
      expect(section).toContain('FROM public.projects p');
      expect(section).toContain('owner_id = auth.uid()');
      expect(section).toContain("RAISE EXCEPTION 'not authorized'");
      expect(section).not.toContain('FROM public.project_members pm');
    }
  });

  it('项目读取与附件读取策略必须保持 owner-only', () => {
    const initSql = readSql('scripts/init-supabase.sql');
    const remoteCommitSql = readSql('supabase/migrations/20260126074130_remote_commit.sql');
    const ownerOnlyRepairSql = readSql('supabase/migrations/20260403050835_20260401100000_owner_only_batch_upsert_tasks.sql');

    const initProjectsPolicySection = getSection(
      initSql,
      'CREATE POLICY "owner select" ON public.projects FOR SELECT USING (',
      '-- ============================================\n-- 8. RLS 策略 - Project Members',
    );
    const initAttachmentPolicySection = getSection(
      initSql,
      'DROP POLICY IF EXISTS "Project members can view attachments" ON storage.objects;',
      '-- ============================================',
    );
    const remoteCommitSelectPolicySection = getSection(
      remoteCommitSql,
      'CREATE POLICY "owner select" ON "public"."projects"',
      'CREATE POLICY "owner update" ON "public"."projects"',
    );
    const remoteCommitUpdatePolicySection = getSection(
      remoteCommitSql,
      'CREATE POLICY "owner update" ON "public"."projects"',
      'ALTER TABLE "public"."project_members" ENABLE ROW LEVEL SECURITY;',
    );
    const remoteCommitAttachmentPolicySection = getSection(
      remoteCommitSql,
      'create policy "Project members can view attachments"',
      'create policy "Users can delete own attachments"',
    );
    const remoteCommitLowerOwnerUpdateSection = getSection(
      remoteCommitSql,
      'create policy "owner update"',
      'create policy "Project members can view attachments"',
    );
    const ownerOnlyRepairProjectsPolicySection = getSection(
      ownerOnlyRepairSql,
      'DO $$ BEGIN\n  DROP POLICY IF EXISTS "owner select" ON public.projects;',
      'DO $$ BEGIN\n  DROP POLICY IF EXISTS "Project members can view attachments" ON storage.objects;',
    );
    const ownerOnlyRepairAttachmentPolicySection = getSection(
      ownerOnlyRepairSql,
      'DO $$ BEGIN\n  DROP POLICY IF EXISTS "Project members can view attachments" ON storage.objects;',
      'COMMENT ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) IS',
    );

    expect(initProjectsPolicySection).toContain('(select auth.uid()) = owner_id');
    expect(initProjectsPolicySection).not.toContain('project_members');
    expectOwnerOnlyAttachmentStorageRead(initAttachmentPolicySection);

    for (const section of [remoteCommitSelectPolicySection, remoteCommitUpdatePolicySection]) {
      expect(section).toContain('( SELECT "auth"."uid"() AS "uid") = "owner_id"');
      expect(section).not.toContain('project_members');
    }

    expect(remoteCommitLowerOwnerUpdateSection).toContain('( SELECT auth.uid() AS uid) = owner_id');
    expect(remoteCommitLowerOwnerUpdateSection).not.toContain('project_members');

    expectOwnerOnlyAttachmentStorageRead(remoteCommitAttachmentPolicySection.replaceAll('(auth.uid())::text', 'auth.uid()::text'));
    expect(ownerOnlyRepairProjectsPolicySection).toContain('USING ((SELECT auth.uid() AS uid) = owner_id);');
    expectOwnerOnlyAttachmentStorageRead(ownerOnlyRepairAttachmentPolicySection);
  });

  it('project_members 过渡策略也必须收敛到 owner-only', () => {
    const initSql = readSql('scripts/init-supabase.sql');
    const remoteCommitSql = readSql('supabase/migrations/20260126074130_remote_commit.sql');
    const ownerOnlyRepairSql = readSql('supabase/migrations/20260403050835_20260401100000_owner_only_batch_upsert_tasks.sql');

    const initEarlyProjectMembersSection = getSection(
      initSql,
      'CREATE POLICY "project_members select" ON public.project_members FOR SELECT USING (',
      '-- ============================================\n-- 9. RLS 策略 - Tasks',
    );
    const initLaterProjectMembersSection = getSection(
      initSql,
      'CREATE POLICY "project_members select" ON public.project_members\n  FOR SELECT\n  TO public\n  USING (',
      'DROP POLICY IF EXISTS "tasks owner select" ON public.tasks;',
    );
    const remoteCommitProjectMembersSection = getSection(
      remoteCommitSql,
      'CREATE POLICY "project_members delete" ON "public"."project_members"',
      'ALTER TABLE "public"."projects" ENABLE ROW LEVEL SECURITY;',
    );
    const ownerOnlyRepairProjectMembersSection = getSection(
      ownerOnlyRepairSql,
      'DO $$ BEGIN\n  IF to_regclass(\'public.project_members\') IS NOT NULL THEN',
      'DO $$ BEGIN\n  DROP POLICY IF EXISTS "Project members can view attachments" ON storage.objects;',
    );

    for (const section of [
      initEarlyProjectMembersSection,
      initLaterProjectMembersSection,
      remoteCommitProjectMembersSection,
      ownerOnlyRepairProjectMembersSection,
    ]) {
      expectOwnerOnlyProjectMembersPolicy(section);
    }
  });

  it('batch_upsert_tasks 必须保持 owner-only 且不能批量覆盖已有 attachments', () => {
    const initSql = readSql('scripts/init-supabase.sql');
    const remoteCommitSql = readSql('supabase/migrations/20260126074130_remote_commit.sql');
    const consolidatedSql = readSql('supabase/migrations/20260315200000_consolidated_focus_console_and_security.sql');
    const syncUnificationSql = readSql('supabase/migrations/20260318073718_security_sync_and_rpc_unification.sql');
    const ownerOnlyRepairSql = readSql('supabase/migrations/20260403050835_20260401100000_owner_only_batch_upsert_tasks.sql');

    const initSection = getSection(
      initSql,
      'CREATE OR REPLACE FUNCTION public.batch_upsert_tasks(',
      'COMMENT ON FUNCTION public.batch_upsert_tasks',
    );
    const remoteCommitSection = getSection(
      remoteCommitSql,
      'CREATE OR REPLACE FUNCTION "public"."batch_upsert_tasks"',
      'ALTER FUNCTION "public"."batch_upsert_tasks"',
    );
    const consolidatedSection = getSection(
      consolidatedSql,
      'CREATE OR REPLACE FUNCTION public.batch_upsert_tasks(',
      'COMMENT ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) IS',
    );
    const syncUnificationSection = getSection(
      syncUnificationSql,
      'CREATE OR REPLACE FUNCTION public.batch_upsert_tasks(',
      'DO $$ BEGIN\n  REVOKE ALL ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) FROM PUBLIC;',
    );
    const ownerOnlyRepairSection = getSection(
      ownerOnlyRepairSql,
      'CREATE OR REPLACE FUNCTION public.batch_upsert_tasks(',
      'DO $$ BEGIN',
    );

    expectOwnerOnlyBatchUpsert(initSection, 'public.user_is_project_owner(p_project_id)');
    expectOwnerOnlyBatchUpsert(remoteCommitSection, 'AND p.owner_id = v_user_id');
    expectOwnerOnlyBatchUpsert(consolidatedSection, 'AND p.owner_id = v_user_id');
    expectOwnerOnlyBatchUpsert(syncUnificationSection, 'AND p.owner_id = v_user_id');
    expectOwnerOnlyBatchUpsert(ownerOnlyRepairSection, 'AND p.owner_id = v_user_id');
  });

  it('black_box_entries 内容保护触发器必须保留已有非空正文而不是抛错中断状态同步', () => {
    const sql = readSql('supabase/migrations/20260430114000_blackbox_content_loss_guard.sql');
    const normalized = sql.replace(/\s+/g, ' ');

    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.prevent_black_box_content_loss()');
    expect(normalized).toContain('BEFORE INSERT OR UPDATE ON public.black_box_entries');
    expect(normalized).toContain('OLD.content IS NOT NULL');
    expect(normalized).toContain("btrim(OLD.content) <> ''");
    expect(normalized).toContain('NEW.content := OLD.content');
    expect(normalized).toContain('RETURN NEW');
    expect(sql).not.toContain('refusing to replace non-empty content with empty content');
  });

  it('init script 中的 owner helper 与 purge RPC 必须保持 owner/project-scope 约束', () => {
    const sql = readSql('scripts/init-supabase.sql');
    const ownerHelperSection = getSection(
      sql,
      'CREATE OR REPLACE FUNCTION public.user_is_project_owner(',
      'CREATE OR REPLACE FUNCTION public.user_has_project_access(',
    );
    const accessHelperSection = getSection(
      sql,
      'CREATE OR REPLACE FUNCTION public.user_has_project_access(',
      'CREATE TABLE IF NOT EXISTS public.projects (',
    );
    const purgeV2Section = getSection(
      sql,
      'CREATE OR REPLACE FUNCTION purge_tasks_v2(',
      'GRANT EXECUTE ON FUNCTION purge_tasks_v2(UUID, UUID[]) TO authenticated;',
    );
    const purgeV3Section = getSection(
      sql,
      'CREATE OR REPLACE FUNCTION public.purge_tasks_v3(',
      'GRANT EXECUTE ON FUNCTION public.purge_tasks_v3(uuid, uuid[]) TO authenticated;',
    );

    expect(ownerHelperSection).toContain('AND p.owner_id = public.current_user_id()');
    expect(ownerHelperSection).not.toContain('project_members');
    expect(accessHelperSection).toContain('AND p.owner_id = public.current_user_id()');
    expect(accessHelperSection).not.toContain('project_members');
    expectOwnerOnlyPurge(purgeV2Section);
    expectOwnerOnlyPurge(purgeV3Section);
  });

  it('get_full_project_data 必须复用 owner-only access helper', () => {
    const sql = readSql('scripts/init-supabase.sql');
    const fullProjectSection = getSection(
      sql,
      'CREATE OR REPLACE FUNCTION public.get_full_project_data(',
      'COMMENT ON FUNCTION public.get_full_project_data(UUID) IS',
    );

    expect(fullProjectSection).toContain('public.user_has_project_access(p_project_id)');
    expect(fullProjectSection).not.toContain('project_members');
  });

  it('remote commit migration 中的 purge RPC 必须保持 owner/project-scope 约束', () => {
    const sql = readSql('supabase/migrations/20260126074130_remote_commit.sql');
    const purgeV2Section = getSection(
      sql,
      'CREATE OR REPLACE FUNCTION "public"."purge_tasks_v2"',
      'ALTER FUNCTION "public"."purge_tasks_v2"',
    );
    const purgeV3Section = getSection(
      sql,
      'CREATE OR REPLACE FUNCTION "public"."purge_tasks_v3"',
      'ALTER FUNCTION "public"."purge_tasks_v3"',
    );

    expectOwnerOnlyPurge(purgeV2Section);
    expectOwnerOnlyPurge(purgeV3Section);
  });

  it('黑匣子与 connection tombstone 访问口必须保持 owner-only', () => {
    const initSql = readSql('scripts/init-supabase.sql');
    const remoteCommitSql = readSql('supabase/migrations/20260126074130_remote_commit.sql');
    const ownerOnlyRepairSql = readSql('supabase/migrations/20260403050835_20260401100000_owner_only_batch_upsert_tasks.sql');

    const initConnectionPolicySection = getSection(
      initSql,
      '-- 修复 connection_tombstones 表 RLS 策略',
      '-- 更新相关函数的 auth.uid() 调用也使用 initplan',
    );
    const initIsConnectionTombstonedSection = getSection(
      initSql,
      'CREATE OR REPLACE FUNCTION is_connection_tombstoned(',
      'GRANT EXECUTE ON FUNCTION is_connection_tombstoned(UUID) TO authenticated;',
    );
    const remoteCommitBlackBoxSection = getSection(
      remoteCommitSql,
      'CREATE POLICY "black_box_select_policy" ON "public"."black_box_entries"',
      'CREATE POLICY "black_box_update_policy" ON "public"."black_box_entries"',
    );
    const remoteCommitConnectionInsertSection = getSection(
      remoteCommitSql,
      'CREATE POLICY "connection_tombstones_insert" ON "public"."connection_tombstones"',
      'COMMENT ON POLICY "connection_tombstones_insert" ON "public"."connection_tombstones"',
    );
    const remoteCommitConnectionSelectSection = getSection(
      remoteCommitSql,
      'CREATE POLICY "connection_tombstones_select" ON "public"."connection_tombstones"',
      'COMMENT ON POLICY "connection_tombstones_select" ON "public"."connection_tombstones"',
    );
    const remoteCommitIsConnectionTombstonedSection = getSection(
      remoteCommitSql,
      'CREATE OR REPLACE FUNCTION "public"."is_connection_tombstoned"',
      'ALTER FUNCTION "public"."is_connection_tombstoned"',
    );
    const ownerOnlyRepairConnectionPoliciesSection = getSection(
      ownerOnlyRepairSql,
      'DO $$ BEGIN\n  DROP POLICY IF EXISTS "black_box_select_policy" ON public.black_box_entries;',
      'DO $$ BEGIN\n  DROP POLICY IF EXISTS "owner select" ON public.projects;',
    );
    const ownerOnlyRepairIsConnectionTombstonedSection = getSection(
      ownerOnlyRepairSql,
      'CREATE OR REPLACE FUNCTION public.is_connection_tombstoned(',
      'COMMENT ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) IS',
    );

    expect(remoteCommitBlackBoxSection).toContain('"projects"."owner_id" = ( SELECT "auth"."uid"() AS "uid")');
    expect(remoteCommitBlackBoxSection).not.toContain('project_members');

    expect(initConnectionPolicySection).toContain('public.user_is_project_owner(project_id)');
    expect(initConnectionPolicySection).not.toContain('project_members');
    expect(initIsConnectionTombstonedSection).toContain('p.owner_id = auth.uid()');
    expect(initIsConnectionTombstonedSection).not.toContain('project_members');

    for (const section of [remoteCommitConnectionInsertSection, remoteCommitConnectionSelectSection]) {
      expect(section).toContain('"projects"."owner_id" = ( SELECT "auth"."uid"() AS "uid")');
      expect(section).not.toContain('project_members');
    }

    expect(remoteCommitIsConnectionTombstonedSection).toContain('p.owner_id = auth.uid()');
    expect(remoteCommitIsConnectionTombstonedSection).not.toContain('project_members');
    expect(ownerOnlyRepairConnectionPoliciesSection).toContain('public.user_is_project_owner(project_id)');
    expect(ownerOnlyRepairConnectionPoliciesSection).toContain('p.owner_id = auth.uid()');
    expect(ownerOnlyRepairConnectionPoliciesSection).not.toContain('project_members');
    expect(ownerOnlyRepairIsConnectionTombstonedSection).toContain('p.owner_id = auth.uid()');
    expect(ownerOnlyRepairIsConnectionTombstonedSection).not.toContain('project_members');
  });

  it('migration 中的迁移工具不应暴露给 authenticated', () => {
    const sql = readSql('supabase/migrations/20260126074130_remote_commit.sql');

    expect(sql).toContain('REVOKE ALL ON FUNCTION "public"."migrate_all_projects_to_v2"() FROM "authenticated";');
    expect(sql).toContain('REVOKE ALL ON FUNCTION "public"."migrate_project_data_to_v2"("p_project_id" "uuid") FROM "authenticated";');
  });

  it('migration 中的维护函数不应暴露给 authenticated', () => {
    const sql = readSql('supabase/migrations/20260126074130_remote_commit.sql');

    expect(sql).toContain('REVOKE ALL ON FUNCTION "public"."cleanup_deleted_attachments"("retention_days" integer) FROM "authenticated";');
    expect(sql).toContain('REVOKE ALL ON FUNCTION "public"."cleanup_expired_scan_records"() FROM "authenticated";');
    expect(sql).toContain('REVOKE ALL ON FUNCTION "public"."cleanup_old_deleted_connections"() FROM "authenticated";');
    expect(sql).toContain('REVOKE ALL ON FUNCTION "public"."cleanup_old_deleted_tasks"() FROM "authenticated";');
    expect(sql).toContain('REVOKE ALL ON FUNCTION "public"."cleanup_old_logs"() FROM "authenticated";');
  });

  it('migration 中的核心业务表不应继续向 anon 暴露', () => {
    const sql = readSql('supabase/migrations/20260126074130_remote_commit.sql');

    expect(sql).toContain('REVOKE ALL ON TABLE "public"."tasks" FROM "anon";');
    expect(sql).toContain('REVOKE ALL ON TABLE "public"."projects" FROM "anon";');
    expect(sql).toContain('REVOKE ALL ON TABLE "public"."connections" FROM "anon";');
    expect(sql).toContain('ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" REVOKE ALL ON TABLES FROM "anon";');
    expect(sql).toContain('ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" REVOKE ALL ON TABLES FROM "authenticated";');
  });

  it('旧 purge_tasks 入口不应继续向 authenticated 暴露', () => {
    const initSql = readSql('scripts/init-supabase.sql');
    const migrationSql = readSql('supabase/migrations/20260126074130_remote_commit.sql');
    const ownerOnlyRepairSql = readSql('supabase/migrations/20260403050835_20260401100000_owner_only_batch_upsert_tasks.sql');

    expect(initSql).toContain('REVOKE EXECUTE ON FUNCTION public.purge_tasks(uuid[]) FROM authenticated;');
    expect(migrationSql).toContain('REVOKE ALL ON FUNCTION "public"."purge_tasks"("p_task_ids" "uuid"[]) FROM "authenticated";');
    expect(ownerOnlyRepairSql).toContain('REVOKE ALL ON FUNCTION public.purge_tasks(uuid[]) FROM authenticated;');
  });

  it('前向修复迁移必须覆盖附件 RPC 与 legacy purge 权限最终态', () => {
    const sql = readSql('supabase/migrations/20260403050835_20260401100000_owner_only_batch_upsert_tasks.sql');
    const appendSection = getSection(
      sql,
      'CREATE OR REPLACE FUNCTION public.append_task_attachment(',
      'CREATE OR REPLACE FUNCTION public.remove_task_attachment(',
    );
    const removeSection = getSection(
      sql,
      'CREATE OR REPLACE FUNCTION public.remove_task_attachment(',
      'DO $$ BEGIN\n  REVOKE ALL ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) FROM PUBLIC;',
    );

    for (const section of [appendSection, removeSection]) {
      expect(section).toContain('FROM public.projects p');
      expect(section).toContain('owner_id = auth.uid()');
      expect(section).toContain("RAISE EXCEPTION 'not authorized'");
    }

    expect(sql).toContain('REVOKE ALL ON FUNCTION public.append_task_attachment(uuid, jsonb) FROM PUBLIC;');
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.remove_task_attachment(uuid, text) FROM PUBLIC;');
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.purge_tasks(uuid[]) FROM authenticated;');
    expect(sql).toContain('REVOKE ALL ON TABLE public.purge_rate_limits FROM authenticated;');
    expect(sql).toContain('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM authenticated;');
  });

  it('重复策略清理迁移必须移除与 optimized policy 重叠的 owner-only 策略', () => {
    const sql = readSql('supabase/migrations/20260403051156_20260403113000_cleanup_duplicate_owner_only_policies.sql');

    expect(sql).toContain("policyname = 'black_box_select_optimized'");
    expect(sql).toContain('DROP POLICY IF EXISTS "black_box_select_policy" ON public.black_box_entries;');
    expect(sql).toContain("policyname = 'connection_tombstones_select_optimized'");
    expect(sql).toContain('DROP POLICY IF EXISTS "connection_tombstones_select" ON public.connection_tombstones;');
    expect(sql).toContain("policyname = 'connection_tombstones_insert_optimized'");
    expect(sql).toContain('DROP POLICY IF EXISTS "connection_tombstones_insert" ON public.connection_tombstones;');
    expect(sql).toContain("policyname = 'Users can view own attachments'");
    expect(sql).toContain('DROP POLICY IF EXISTS "Project members can view attachments" ON storage.objects;');
  });

  it('数据库灾备加固迁移必须提供 service-only 冻结开关与自审计', () => {
    const sql = readSql('supabase/migrations/20260531120000_database_hardening_dr_controls.sql');
    const normalized = sql.replace(/\s+/g, ' ');

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.data_safety_flags');
    expect(sql).toContain("value IN ('normal', 'audit_only', 'read_only', 'quarantine')");
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.data_safety_flag_audit');
    expect(sql).toContain('ALTER TABLE public.data_safety_flags FORCE ROW LEVEL SECURITY;');
    expect(sql).toContain('REVOKE ALL ON public.data_safety_flags FROM PUBLIC, anon, authenticated;');
    expect(sql).toContain('CREATE POLICY data_safety_flags_service_all');
    expect(normalized).toContain('CREATE OR REPLACE FUNCTION public.set_data_safety_flag(p_key TEXT, p_value TEXT) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp');
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.set_data_safety_flag(TEXT, TEXT) FROM PUBLIC, anon, authenticated;');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.set_data_safety_flag(TEXT, TEXT) TO service_role;');
    expect(normalized).toContain('CREATE OR REPLACE FUNCTION public.enforce_data_safety_freeze() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp');
    expect(sql).toContain("COALESCE(v_sync_mode, 'normal') IN ('read_only', 'quarantine') AND NOT v_bypass");
    expect(sql).toContain('CREATE TRIGGER trg_data_safety_freeze_tasks');
    expect(sql).toContain('CREATE TRIGGER trg_data_safety_freeze_connections');
    expect(sql).toContain('CREATE TRIGGER trg_data_safety_freeze_projects');
    expect(sql).toContain('CREATE TRIGGER trg_data_safety_freeze_black_box_entries');
  });

  it('数据库灾备加固迁移必须提供隔离表的幂等、防重、保留期与权限收敛', () => {
    const sql = readSql('supabase/migrations/20260531120000_database_hardening_dr_controls.sql');
    const normalized = sql.replace(/\s+/g, ' ');

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.sync_write_quarantine');
    expect(sql).toContain('CONSTRAINT sync_write_quarantine_operation_uniq UNIQUE (operation_id)');
    expect(sql).toContain('CONSTRAINT sync_write_quarantine_digest_uniq UNIQUE (payload_digest)');
    expect(sql).toContain("expires_at      TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '30 days')");
    expect(sql).toContain("review_decision TEXT CHECK (review_decision IS NULL OR review_decision IN ('replay', 'discard', 'escalate'))");
    expect(sql).toContain('ALTER TABLE public.sync_write_quarantine FORCE ROW LEVEL SECURITY;');
    expect(sql).toContain('REVOKE ALL ON public.sync_write_quarantine FROM PUBLIC, anon, authenticated;');
    expect(sql).toContain('CREATE POLICY sync_write_quarantine_service_all');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.sync_canonical_payload_digest(p_payload JSONB)');
    expect(sql).toContain("COALESCE(p_payload, '{}'::JSONB) - 'operation_id' - 'operationId'");
    expect(normalized).toContain('CREATE OR REPLACE FUNCTION public.record_sync_write_quarantine( p_operation_id UUID, p_user_id UUID, p_entity_type TEXT, p_entity_id UUID, p_client_git_sha TEXT, p_client_origin TEXT, p_reason TEXT, p_payload JSONB ) RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp');
    expect(sql).toContain('v_digest TEXT := public.sync_canonical_payload_digest(p_payload);');
  });

  it('数据库灾备加固迁移必须强化 task_change_audit 来源归因与 suspicious 标记', () => {
    const sql = readSql('supabase/migrations/20260531120000_database_hardening_dr_controls.sql');
    const normalized = sql.replace(/\s+/g, ' ');

    expect(sql).toContain('ADD COLUMN IF NOT EXISTS operation_id UUID');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS client_git_sha TEXT');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS deployment_epoch BIGINT');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS origin_unverified BOOLEAN NOT NULL DEFAULT false');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS suspicious BOOLEAN NOT NULL DEFAULT false');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS task_change_audit_suspicious_idx');
    expect(normalized).toContain('CREATE OR REPLACE FUNCTION public.capture_task_change_audit() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp');
    expect(sql).toContain("current_setting('app.operation_id', true)");
    expect(sql).toContain('v_origin_unverified BOOLEAN := true;');
    expect(sql).toContain("v_origin_unverified := COALESCE(NULLIF(current_setting('app.origin_unverified', true), '')::BOOLEAN, true);");
    expect(normalized).toContain('IF v_operation_id IS NULL OR v_client_git_sha IS NULL OR v_client_origin IS NULL OR v_payload_digest IS NULL THEN v_origin_unverified := true; END IF;');
    expect(sql).toContain("v_suspicious_reason := 'structure_degrade_content_equals_title';");
    expect(sql).toContain('ALTER FUNCTION public.capture_task_change_audit() OWNER TO postgres;');
    expect(sql).toContain('capture_task_change_audit owner must BYPASSRLS before task_change_audit FORCE RLS');
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.capture_task_change_audit() FROM PUBLIC, anon, authenticated;');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.task_change_audit_archive');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.archive_old_task_change_audit(');
  });

  it('数据库灾备加固迁移必须自动启用新 public 表 RLS 且固定 search_path', () => {
    const sql = readSql('supabase/migrations/20260531120000_database_hardening_dr_controls.sql');
    const normalized = sql.replace(/\s+/g, ' ');

    expect(normalized).toContain('CREATE OR REPLACE FUNCTION public.rls_auto_enable() RETURNS EVENT_TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp');
    expect(sql).toContain("EXECUTE 'CREATE EVENT TRIGGER ensure_rls ON ddl_command_end");
    expect(sql).toContain("WHEN TAG IN (''CREATE TABLE'', ''CREATE TABLE AS'', ''SELECT INTO'')");
    expect(sql).toContain('EXCEPTION WHEN insufficient_privilege THEN');
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.rls_auto_enable() FROM PUBLIC, anon, authenticated;');
  });

  it('数据库灾备加固迁移必须提供只读结构审计与 stage-null 诊断视图', () => {
    const sql = readSql('supabase/migrations/20260531120000_database_hardening_dr_controls.sql');

    expect(sql).toContain('CREATE OR REPLACE VIEW public.project_structure_audit');
    expect(sql).toContain('WITH (security_invoker = true)');
    expect(sql).toContain('stage_null');
    expect(sql).toContain('content_equals_title');
    expect(sql).toContain('GRANT SELECT ON public.project_structure_audit TO authenticated;');
    expect(sql).toContain('CREATE OR REPLACE VIEW public.stage_null_recovery_diagnostics');
    expect(sql).toContain('soft_deleted_stage_candidates');
    expect(sql).toContain('audit_preimage_candidates');
    expect(sql).toContain('evidence_class');
    expect(sql).toContain('GRANT SELECT ON public.stage_null_recovery_diagnostics TO authenticated;');
  });

  it('数据库灾备门禁必须由 CODEOWNERS 与 CI contract workflow 承载', () => {
    const owners = readSql('.github/CODEOWNERS');
    const workflow = readSql('.github/workflows/database-hardening-gates.yml');

    expect(owners).toContain('/supabase/migrations/ @wgje');
    expect(owners).toContain('/scripts/validate-sql-structure.cjs @wgje');
    expect(owners).toContain('/src/app/core/services/sync/ @wgje');
    expect(owners).toContain('/src/types/supabase.ts @wgje');
    expect(owners).toContain('/src/models/supabase-types.ts @wgje');
    expect(owners).toContain('/src/tests/contracts/batch-upsert-tasks-stale-write-protection.contract.spec.ts @wgje');
    expect(owners).toContain('/src/tests/contracts/project-soft-delete.contract.spec.ts @wgje');
    expect(owners).toContain('/.github/CODEOWNERS @wgje');
    expect(owners).toContain('/.github/workflows/database-hardening-gates.yml @wgje');
    expect(owners).toContain('/.github/workflows/supabase-logical-backup.yml @wgje');
    expect(workflow).toContain('name: Database hardening gates');
    expect(workflow).toContain('src/tests/contracts/sql-security-hardening.contract.spec.ts');
    expect(workflow).toContain('src/tests/contracts/project-soft-delete.contract.spec.ts');
    expect(workflow).toContain('src/tests/contracts/sync-upsert-task-missing-timestamp-guard.contract.spec.ts');
    expect(workflow).toContain('src/tests/contracts/batch-upsert-tasks-stale-write-protection.contract.spec.ts');
    expect(workflow).toContain('node scripts/validate-sql-structure.cjs');
    expect(workflow).toContain("'scripts/validate-sql-structure.cjs'");
    expect(workflow).toContain("'src/types/supabase.ts'");
    expect(workflow).toContain("'.github/workflows/supabase-logical-backup.yml'");
  });

  it('逻辑备份 workflow 必须加密上传独立对象存储且不提交明文 dump', () => {
    const workflow = readSql('.github/workflows/supabase-logical-backup.yml');

    expect(workflow).toContain('permissions:\n  contents: read\n  id-token: write');
    expect(workflow).toContain('SUPABASE_DB_URL: ${{ secrets.SUPABASE_DB_URL }}');
    expect(workflow).toContain('BACKUP_AGE_PUBLIC_KEY: ${{ secrets.BACKUP_AGE_PUBLIC_KEY }}');
    expect(workflow).toContain('BACKUP_S3_BUCKET: ${{ secrets.BACKUP_S3_BUCKET }}');
    expect(workflow).toContain('BACKUP_AWS_ROLE_TO_ASSUME: ${{ secrets.BACKUP_AWS_ROLE_TO_ASSUME }}');
    expect(workflow).toContain('aws sts assume-role-with-web-identity');
    expect(workflow).toContain('supabase db dump --db-url "$SUPABASE_DB_URL" -f roles.sql --role-only');
    expect(workflow).toContain('age -r "$BACKUP_AGE_PUBLIC_KEY"');
    expect(workflow).toContain('shred -u "$file"');
    expect(workflow).toContain('aws s3 cp . "s3://$BACKUP_S3_BUCKET/$(date -u +%Y/%m/%d)/"');
    expect(workflow).not.toContain('BACKUP_AWS_ACCESS_KEY_ID');
    expect(workflow).not.toContain('BACKUP_AWS_SECRET_ACCESS_KEY');
    expect(workflow).not.toContain('git-auto-commit');
    expect(workflow).not.toContain('contents: write');
  });

  it('advisor follow-up 迁移必须收敛 anon SECURITY DEFINER 暴露与 service-only RLS policy', () => {
    const sql = readSql('supabase/migrations/20260531123000_advisor_followup_rls_and_function_exposure.sql');
    const normalized = sql.replace(/\s+/g, ' ');

    expect(sql).toContain('ALTER FUNCTION public.user_preferences_keep_latest_backup_proof()');
    expect(sql).toContain('SET search_path = public, pg_temp');
    expect(sql).toContain("IF to_regprocedure('public.cascade_soft_delete_connections()') IS NOT NULL THEN");
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.get_all_projects_data(TIMESTAMPTZ)');
    expect(sql).toContain('FROM PUBLIC, anon;');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.get_all_projects_data(TIMESTAMPTZ)');
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.prevent_black_box_content_loss()');
    expect(sql).toContain('FROM PUBLIC, anon, authenticated;');
    expect(normalized).toContain("FOREACH v_table IN ARRAY ARRAY[ 'routine_completion_events', 'widget_devices', 'widget_devices_legacy_retired', 'widget_instances', 'widget_instances_legacy_retired', 'widget_notify_events', 'widget_notify_throttle', 'widget_request_rate_limits' ]");
    expect(sql).toContain('CREATE POLICY %I ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)');
  });

  it('advisor index cleanup 迁移必须移除归档表重复索引', () => {
    const sql = readSql('supabase/migrations/20260531124000_advisor_followup_index_cleanup.sql');

    expect(sql).toContain('DROP INDEX IF EXISTS public.task_change_audit_archive_owner_id_changed_at_idx1');
  });

  it('隔离 digest 与审计来源补丁必须修复 retry 放大和无归因误判', () => {
    const sql = readSql('supabase/migrations/20260531125000_quarantine_digest_and_audit_origin_hardening.sql');
    const normalized = sql.replace(/\s+/g, ' ');

    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.sync_canonical_payload_digest(p_payload JSONB)');
    expect(sql).toContain("COALESCE(p_payload, '{}'::JSONB) - 'operation_id' - 'operationId'");
    expect(sql).toContain('v_digest TEXT := public.sync_canonical_payload_digest(p_payload);');
    expect(sql).toContain('v_origin_unverified BOOLEAN := true;');
    expect(sql).toContain("v_origin_unverified := COALESCE(NULLIF(current_setting('app.origin_unverified', true), '')::BOOLEAN, true);");
    expect(normalized).toContain('IF v_operation_id IS NULL OR v_client_git_sha IS NULL OR v_client_origin IS NULL OR v_payload_digest IS NULL THEN v_origin_unverified := true; END IF;');

    const databaseTypes = readSql('src/types/supabase.ts');
    expect(databaseTypes).toContain('sync_canonical_payload_digest: {');
    expect(databaseTypes).toContain('Args: { p_payload: Json }');
  });
});
