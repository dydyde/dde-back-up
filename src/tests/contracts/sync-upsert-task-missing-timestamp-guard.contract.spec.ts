import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = 'supabase/migrations/20260531063500_sync_upsert_task_missing_timestamp_guard.sql';

function readMigration(): string {
  return fs.readFileSync(path.join(process.cwd(), migrationPath), 'utf8');
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ');
}

describe('sync_upsert_task missing timestamp guard migration', () => {
  it('extracts freshness from task updated_at/updatedAt or base_updated_at', () => {
    const sql = normalize(readMigration());

    expect(sql).toContain("v_local_updated TIMESTAMPTZ := public.sync_extract_local_updated(payload, 'task')");
  });

  it('locks existing task and reads updated_at before applying the write', () => {
    const sql = normalize(readMigration());

    expect(sql).toMatch(
      /SELECT t\.project_id, p\.owner_id, t\.updated_at\s+INTO v_existing_project_id, v_existing_owner, v_existing_updated\s+FROM public\.tasks t\s+JOIN public\.projects p ON p\.id = t\.project_id\s+WHERE t\.id = v_task_id\s+FOR UPDATE/,
    );
  });

  it('rejects existing task upserts without any local timestamp', () => {
    const sql = normalize(readMigration());

    expect(sql).toContain('IF v_existing_project_id IS NOT NULL AND v_local_updated IS NULL THEN');
    expect(sql).toContain("'status', 'remote-newer'");
    expect(sql).toContain("'reason', 'missing_task_timestamp'");
    expect(sql).toContain("'remote_updated_at', v_existing_updated");
    expect(sql).toContain("'missing_task_timestamp', v_protocol");
  });

  it('continues to allow inserts and timestamped upserts through batch_upsert_tasks', () => {
    const sql = normalize(readMigration());

    expect(sql).toContain('PERFORM public.batch_upsert_tasks(ARRAY[v_task], v_project_id)');
    expect(sql).toContain("'status', 'applied'");
  });

  it('keeps public execution revoked and authenticated execution granted', () => {
    const sql = readMigration();

    expect(sql).toContain('REVOKE ALL ON FUNCTION public.sync_upsert_task(JSONB) FROM PUBLIC, anon');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.sync_upsert_task(JSONB) TO authenticated');
  });
});