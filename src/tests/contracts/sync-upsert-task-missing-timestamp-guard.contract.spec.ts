import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = 'supabase/migrations/20260531063500_sync_upsert_task_missing_timestamp_guard.sql';
const hardeningMigrationPath = 'supabase/migrations/20260531120000_database_hardening_dr_controls.sql';
const quarantineCaptureMigrationPath = 'supabase/migrations/20260531130000_quarantine_missing_timestamp_capture.sql';

function readMigration(): string {
  return fs.readFileSync(path.join(process.cwd(), migrationPath), 'utf8');
}

function readHardeningMigration(): string {
  return fs.readFileSync(path.join(process.cwd(), hardeningMigrationPath), 'utf8');
}

function readQuarantineCaptureMigration(): string {
  return fs.readFileSync(path.join(process.cwd(), quarantineCaptureMigrationPath), 'utf8');
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

  it('hardening migration enriches task sync decisions without removing the missing timestamp guard', () => {
    const sql = normalize(readHardeningMigration());

    expect(sql).toContain("v_local_updated TIMESTAMPTZ := public.sync_extract_local_updated(payload, 'task')");
    expect(sql).toContain('IF v_existing_project_id IS NOT NULL AND v_local_updated IS NULL THEN');
    expect(sql).toContain("v_task_for_write := jsonb_set(v_task_for_write, '{updated_at}', to_jsonb(v_local_updated::TEXT), true)");
    expect(sql).toContain('PERFORM public.batch_upsert_tasks(ARRAY[v_task_for_write], v_project_id)');
    expect(sql).toContain("'decision', CASE WHEN v_quarantine_id IS NULL THEN 'rejected' ELSE 'quarantined' END");
    expect(sql).toContain("'reason', 'missing_task_timestamp'");
    expect(sql).toContain("'quarantine_id', v_quarantine_id");
    expect(sql).toContain("'missing_task_timestamp', payload");
    expect(sql).toContain("'changed_fields', v_changed_fields");
    expect(sql).toContain('payload_digest, result_payload');
  });

  it('hardening migration wires sync freeze and quarantine modes into sync_upsert_task', () => {
    const sql = normalize(readHardeningMigration());

    expect(sql).toContain("WHERE key = 'sync_mode'");
    expect(sql).toContain("IF v_sync_mode = 'read_only' THEN");
    expect(sql).toContain("'reason', 'sync_read_only'");
    expect(sql).toContain("IF v_sync_mode = 'quarantine' THEN");
    expect(sql).toContain('public.record_sync_write_quarantine(');
    expect(sql).toContain("'decision', 'quarantined'");
  });

  it('quarantine capture migration preserves missing timestamp payloads without applying writes', () => {
    const sql = normalize(readQuarantineCaptureMigration());

    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.sync_upsert_task(payload JSONB)');
    expect(sql).toContain('IF v_existing_project_id IS NOT NULL AND v_local_updated IS NULL THEN');
    expect(sql).toContain("IF v_sync_mode = 'quarantine' THEN");
    expect(sql).toContain("'missing_task_timestamp', payload");
    expect(sql).toContain("'decision', CASE WHEN v_quarantine_id IS NULL THEN 'rejected' ELSE 'quarantined' END");
    expect(sql).toContain("CASE WHEN v_quarantine_id IS NULL THEN 'remote-newer' ELSE 'quarantined' END");
    expect(sql).toContain('RETURN v_result;');
  });

  it('hardening migration passes source metadata to the task audit trigger through transaction GUCs', () => {
    const sql = normalize(readHardeningMigration());

    expect(sql).toContain("set_config('app.operation_id', v_op_id::TEXT, true)");
    expect(sql).toContain("set_config('app.client_git_sha', COALESCE(v_client_git, ''), true)");
    expect(sql).toContain("set_config('app.client_origin', COALESCE(v_client_origin, ''), true)");
    expect(sql).toContain("set_config('app.deployment_epoch', v_client_epoch::TEXT, true)");
    expect(sql).toContain("set_config('app.payload_digest', v_payload_digest, true)");
    expect(sql).toContain("set_config('app.origin_unverified', v_origin_unverified::TEXT, true)");
    expect(sql).toContain('SELECT a.id INTO v_audit_id');
  });
});
