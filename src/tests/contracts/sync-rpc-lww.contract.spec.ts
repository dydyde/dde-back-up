import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = 'supabase/migrations/20260509145500_sync_rpc_lww_upsert_semantics.sql';

function readMigration(): string {
  return fs.readFileSync(path.join(process.cwd(), migrationPath), 'utf8');
}

function getFunctionSection(sql: string, functionName: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${functionName}(payload JSONB)`);
  expect(start).toBeGreaterThanOrEqual(0);

  const end = sql.indexOf('GRANT EXECUTE ON FUNCTION', start);
  expect(end).toBeGreaterThan(start);

  return sql.slice(start, end);
}

describe('Sync RPC LWW migration contract', () => {
  it('upsert RPCs must no longer reject missing remote rows when local updatedAt exists', () => {
    const sql = readMigration();

    for (const functionName of [
      'sync_upsert_task',
      'sync_upsert_connection',
      'sync_upsert_blackbox_entry',
      'sync_upsert_project',
    ]) {
      const section = getFunctionSection(sql, functionName);

      expect(section).not.toContain('remote_missing_but_base_present');
    }
  });

  it('upsert RPCs must not strict-CAS reject trusted owner rows during queue drains', () => {
    const sql = readMigration();

    for (const functionName of [
      'sync_upsert_task',
      'sync_upsert_connection',
      'sync_upsert_blackbox_entry',
      'sync_upsert_project',
    ]) {
      const normalized = getFunctionSection(sql, functionName).replace(/\s+/g, ' ');

      expect(normalized).not.toContain('v_local_updated IS NULL OR v_local_updated < v_existing_updated');
      expect(normalized).not.toContain('v_local_updated < v_existing_updated');
      expect(normalized).not.toContain('v_local_updated <> v_existing_updated');
      expect(normalized).not.toContain("'lww_remote_newer'");
    }
  });

  it('SECURITY DEFINER upsert RPCs must serialize entity writes and revoke public execution', () => {
    const sql = readMigration();

    for (const functionName of [
      'sync_upsert_task',
      'sync_upsert_connection',
      'sync_upsert_blackbox_entry',
      'sync_upsert_project',
    ]) {
      const section = getFunctionSection(sql, functionName);

      expect(section).toContain('PERFORM pg_advisory_xact_lock');
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${functionName}(JSONB) FROM PUBLIC, anon;`);
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${functionName}(JSONB) TO authenticated;`);
    }
  });

  it('task, connection, and blackbox RPCs must validate referenced rows under SECURITY DEFINER', () => {
    const sql = readMigration();
    const taskSection = getFunctionSection(sql, 'sync_upsert_task');
    const connectionSection = getFunctionSection(sql, 'sync_upsert_connection');
    const blackboxSection = getFunctionSection(sql, 'sync_upsert_blackbox_entry');

    expect(taskSection).toContain('task_owned_by_other_project');
    expect(connectionSection).toContain('connection_endpoint_not_in_project');
    expect(connectionSection).toContain('connection_owned_by_other_project');
    expect(blackboxSection).toContain('SELECT 1 FROM public.projects p WHERE p.id = v_project_id AND p.owner_id = v_user');
  });
});
