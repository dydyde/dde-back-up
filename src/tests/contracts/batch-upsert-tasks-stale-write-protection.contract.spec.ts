import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * P0 待分配块脏数据修复的迁移契约。
 *
 * 该 migration 保证 `batch_upsert_tasks` 不会被 RetryQueue drain 时的陈旧 payload
 * （payload.updated_at 明显早于 existing.updated_at）洗白关键状态字段
 * （stage / parent_id / deleted_at），从而避免"突然新增大量待分配块"的脏数据现象。
 */
const migrationPath =
  'supabase/migrations/20260512050000_batch_upsert_tasks_stale_write_protection.sql';

function readMigration(): string {
  return fs.readFileSync(path.join(process.cwd(), migrationPath), 'utf8');
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ');
}

describe('batch_upsert_tasks stale-write protection migration', () => {
  it('redefines batch_upsert_tasks as SECURITY DEFINER with locked search_path', () => {
    const sql = readMigration();
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.batch_upsert_tasks(');
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toContain("SET search_path TO 'pg_catalog', 'pg_temp'");
  });

  it('extracts a payload-side updated_at (snake_case with camelCase fallback)', () => {
    const sql = normalize(readMigration());
    expect(sql).toContain(
      "v_payload_updated := NULLIF(v_task->>'updated_at', '')::timestamptz",
    );
    expect(sql).toContain(
      "v_payload_updated := NULLIF(v_task->>'updatedAt', '')::timestamptz",
    );
  });

  it('locks the existing task row before deciding staleness (avoids TOCTOU)', () => {
    const sql = normalize(readMigration());
    // SELECT ... FOR UPDATE on the conflicting task row before INSERT...ON CONFLICT
    expect(sql).toMatch(
      /SELECT TRUE, t\.updated_at, t\.stage, t\.parent_id, t\.deleted_at[\s\S]*?FROM public\.tasks t[\s\S]*?WHERE t\.id = v_task_id[\s\S]*?AND t\.project_id = p_project_id[\s\S]*?FOR UPDATE/,
    );
  });

  it('treats a payload as stale only when payload.updated_at lags existing.updated_at beyond 1s skew', () => {
    const sql = normalize(readMigration());
    // Definition of v_is_stale must require all three guards plus NULL-safe coercion.
    expect(sql).toContain(
      "v_skew_grace constant interval := interval '1 second'",
    );
    expect(sql).toMatch(
      /v_is_stale := COALESCE\(\s*v_existing_exists\s+AND v_payload_updated IS NOT NULL\s+AND v_existing_updated IS NOT NULL\s+AND v_existing_updated > v_payload_updated \+ v_skew_grace,\s+FALSE\s*\)/,
    );
  });

  it('preserves existing stage / parent_id / deleted_at when the write is stale', () => {
    const sql = normalize(readMigration());
    expect(sql).toContain(
      'stage = CASE WHEN v_is_stale THEN v_existing_stage ELSE EXCLUDED.stage END',
    );
    expect(sql).toContain(
      'parent_id = CASE WHEN v_is_stale THEN v_existing_parent ELSE EXCLUDED.parent_id END',
    );
    expect(sql).toContain(
      'deleted_at = CASE WHEN v_is_stale THEN v_existing_deleted ELSE EXCLUDED.deleted_at END',
    );
  });

  it('keeps server-arrival LWW behavior when payload omits updated_at (0509 compatibility)', () => {
    // 当 payload 不含 updated_at 时，v_payload_updated IS NULL → v_is_stale 为 false
    // → CASE 走 EXCLUDED 分支，与 0509 行为完全一致。这条 spec 通过上面对 v_is_stale 的
    // 定义间接保证；这里额外断言：UPDATE 分支仍对 UI 状态字段使用 EXCLUDED（不被陈旧标记影响）。
    const sql = normalize(readMigration());
    expect(sql).toContain('title = EXCLUDED.title');
    expect(sql).toContain('content = EXCLUDED.content');
    expect(sql).toContain('x = EXCLUDED.x');
    expect(sql).toContain('y = EXCLUDED.y');
    expect(sql).toContain('updated_at = now()');
  });

  it('adds forensics indexes on sync_operation_log for dirty-data triage', () => {
    const sql = readMigration();
    expect(sql).toContain(
      'CREATE INDEX IF NOT EXISTS idx_sync_operation_log_entity_created',
    );
    expect(sql).toContain(
      'ON public.sync_operation_log (entity_type, entity_id, created_at DESC)',
    );
    expect(sql).toContain(
      'CREATE INDEX IF NOT EXISTS idx_sync_operation_log_status_created',
    );
    expect(sql).toContain(
      'ON public.sync_operation_log (entity_type, status, created_at DESC)',
    );
  });

  it('keeps owner-only authorization guards intact', () => {
    const sql = normalize(readMigration());
    expect(sql).toContain("RAISE EXCEPTION 'Unauthorized: not authenticated'");
    expect(sql).toContain("RAISE EXCEPTION 'Unauthorized: not project owner'");
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) TO authenticated');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) TO service_role');
  });
});
