import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('external_source_links stale-write migration contract', () => {
  it('keeps stale pending upserts from overwriting newer anchor rows', () => {
    const migration = fs.readFileSync(
      path.join(process.cwd(), 'supabase/migrations/20260518162000_external_source_links_stale_write_protection.sql'),
      'utf-8',
    );

    expect(migration).toContain('prevent_external_source_links_stale_write');
    expect(migration).toContain("OLD.updated_at > NEW.updated_at + interval '1 second'");
    expect(migration).toContain('OLD.deleted_at IS NOT NULL');
    expect(migration).toContain('NEW.deleted_at IS NULL');
    expect(migration).toContain('trg_external_source_links_prevent_stale_write');
    expect(migration).toContain('BEFORE UPDATE ON public.external_source_links');
  });
});