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

  it('upsert RPCs must reject only when remote updated_at is newer than the local mutation timestamp', () => {
    const sql = readMigration();

    for (const functionName of [
      'sync_upsert_task',
      'sync_upsert_connection',
      'sync_upsert_blackbox_entry',
      'sync_upsert_project',
    ]) {
      const normalized = getFunctionSection(sql, functionName).replace(/\s+/g, ' ');

      expect(normalized).toContain('v_local_updated IS NULL OR v_local_updated < v_existing_updated');
      expect(normalized).toContain("'lww_remote_newer'");
      expect(normalized).not.toContain('v_local_updated <> v_existing_updated');
    }
  });
});
