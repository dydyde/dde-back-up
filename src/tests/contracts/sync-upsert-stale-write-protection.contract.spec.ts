/**
 * Contract test for `20260515100000_sync_rpc_stale_write_protection.sql`.
 *
 * 对应 P0 同步问题遗留项修复（与 0512 在 batch_upsert_tasks 上的契约对称）：
 * - R1 sync_upsert_connection: 陈旧 payload 不得洗白 source_id / target_id / deleted_at
 * - R2 sync_upsert_blackbox_entry: 陈旧 payload 不得倒退状态机字段
 * - R3 sync_upsert_project: 陈旧 payload 不得覆盖 title/description/version/migrated_to_v2
 * - R4 sync_delete_tasks: 支持 base_updated_at_map，跳过远端已更新的 task
 * - connections 表挂 trg_prevent_connection_resurrection 二级护栏
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = 'supabase/migrations/20260515100000_sync_rpc_stale_write_protection.sql';

function readMigration(): string {
  return fs.readFileSync(path.join(process.cwd(), migrationPath), 'utf8');
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ');
}

function getFunctionSection(sql: string, functionName: string): string {
  const pattern = new RegExp(
    String.raw`CREATE OR REPLACE FUNCTION public\.${functionName}\(payload JSONB\)[\s\S]*?\n\$\$;`,
  );
  const match = sql.match(pattern);
  expect(match, `function ${functionName} not found`).not.toBeNull();
  return match?.[0] ?? '';
}

describe('Sync RPC stale-write protection migration contract (P0 遗留项)', () => {
  it('每个 upsert RPC 都引入 1s skew + 三段式陈旧写判定（与 0512 对齐）', () => {
    const sql = readMigration();
    for (const fn of ['sync_upsert_connection', 'sync_upsert_blackbox_entry', 'sync_upsert_project']) {
      const section = normalize(getFunctionSection(sql, fn));
      expect(section, `${fn} 缺少 1s skew 常量`).toContain(
        "v_skew_grace CONSTANT INTERVAL := INTERVAL '1 second'",
      );
      expect(section, `${fn} 陈旧写判定结构不符合 0512 契约`).toMatch(
        /v_is_stale := COALESCE\(\s*[\s\S]*?v_existing_updated > v_local_updated \+ v_skew_grace,\s+FALSE\s*\)/,
      );
    }
  });

  it('R1 sync_upsert_connection: 陈旧时保留 existing 的 source_id / target_id / deleted_at', () => {
    const section = normalize(getFunctionSection(readMigration(), 'sync_upsert_connection'));
    expect(section).toContain(
      'source_id = CASE WHEN v_is_stale THEN v_existing_source ELSE EXCLUDED.source_id END',
    );
    expect(section).toContain(
      'target_id = CASE WHEN v_is_stale THEN v_existing_target ELSE EXCLUDED.target_id END',
    );
    expect(section).toContain(
      'deleted_at = CASE WHEN v_is_stale THEN v_existing_deleted ELSE EXCLUDED.deleted_at END',
    );
    // 非身份字段保持 LWW
    expect(section).toContain('title = EXCLUDED.title');
    expect(section).toContain('description = EXCLUDED.description');
    // 必须 SELECT FOR UPDATE 抓取 existing 关键字段
    expect(section).toMatch(
      /SELECT c\.project_id, p\.owner_id, c\.updated_at, c\.source_id, c\.target_id, c\.deleted_at[\s\S]*?FROM public\.connections c[\s\S]*?FOR UPDATE/,
    );
  });

  it('R2 sync_upsert_blackbox_entry: 陈旧时保留所有状态机字段', () => {
    const section = normalize(getFunctionSection(readMigration(), 'sync_upsert_blackbox_entry'));
    for (const guarded of [
      'project_id = CASE WHEN v_is_stale THEN v_existing_project ELSE EXCLUDED.project_id END',
      'is_read = CASE WHEN v_is_stale THEN v_existing_is_read ELSE EXCLUDED.is_read END',
      'is_completed = CASE WHEN v_is_stale THEN v_existing_is_completed ELSE EXCLUDED.is_completed END',
      'is_archived = CASE WHEN v_is_stale THEN v_existing_is_archived ELSE EXCLUDED.is_archived END',
      'snooze_until = CASE WHEN v_is_stale THEN v_existing_snooze_until ELSE EXCLUDED.snooze_until END',
      'snooze_count = CASE WHEN v_is_stale THEN v_existing_snooze_count ELSE EXCLUDED.snooze_count END',
      'deleted_at = CASE WHEN v_is_stale THEN v_existing_deleted ELSE EXCLUDED.deleted_at END',
      'focus_meta = CASE WHEN v_is_stale THEN v_existing_focus_meta ELSE EXCLUDED.focus_meta END',
    ]) {
      expect(section, `blackbox 缺少 ${guarded}`).toContain(guarded);
    }
    // content 仍走 EXCLUDED（由 prevent_black_box_content_loss 触发器单独保护）
    expect(section).toContain('content = EXCLUDED.content');
  });

  it('R3 sync_upsert_project: 陈旧时保留 existing 的 title / description / version / migrated_to_v2', () => {
    const section = normalize(getFunctionSection(readMigration(), 'sync_upsert_project'));
    expect(section).toContain(
      "title = CASE WHEN v_is_stale THEN v_existing_title ELSE v_project->>'title' END",
    );
    expect(section).toMatch(
      /description = CASE\s+WHEN v_is_stale THEN v_existing_description\s+ELSE NULLIF\(v_project->>'description', ''\)\s+END/,
    );
    expect(section).toMatch(
      /version = CASE\s+WHEN v_is_stale THEN COALESCE\(v_existing_version, p\.version, 1\)/,
    );
    expect(section).toMatch(
      /migrated_to_v2 = CASE\s+WHEN v_is_stale THEN COALESCE\(v_existing_migrated, TRUE\)/,
    );
    // 陈旧 payload 不得改 deleted_at（与 0511 trigger 配合提供双层防护）
    expect(section).toMatch(
      /deleted_at = CASE\s+WHEN v_is_stale THEN v_existing_deleted\s+ELSE NULLIF\(v_project->>'deleted_at', ''\)::TIMESTAMPTZ\s+END/,
    );
    // 必须 SELECT FOR UPDATE 抓取 existing 关键字段
    expect(section).toMatch(
      /SELECT owner_id, updated_at, deleted_at, title, description, version, migrated_to_v2[\s\S]*?FROM public\.projects[\s\S]*?FOR UPDATE/,
    );
  });

  it('R4 sync_delete_tasks: 接受 base_updated_at_map，跳过远端已更新的 task', () => {
    const section = normalize(getFunctionSection(readMigration(), 'sync_delete_tasks'));
    // 接受新 payload 字段
    expect(section).toContain("v_base_map JSONB := payload->'base_updated_at_map'");
    // 1s skew 与 upsert 路径对齐
    expect(section).toContain("v_skew_grace CONSTANT INTERVAL := INTERVAL '1 second'");
    // 对每个 task 取 existing.updated_at（FOR UPDATE 锁住目标行）
    expect(section).toMatch(
      /SELECT t\.updated_at[\s\S]*?FROM public\.tasks t[\s\S]*?WHERE t\.id = v_task_id[\s\S]*?AND t\.project_id = v_project_id[\s\S]*?FOR UPDATE/,
    );
    // 陈旧时进入 skipped 数组，否则进入 kept 数组
    expect(section).toContain('v_existing_updated > v_base_ts + v_skew_grace');
    expect(section).toContain('v_skipped := array_append(v_skipped, v_task_id)');
    expect(section).toContain('v_kept := array_append(v_kept, v_task_id)');
    // 结果中携带 skipped_ids 供客户端重排队
    expect(section).toContain("'skipped_ids', COALESCE(to_jsonb(v_skipped), '[]'::JSONB)");
    // payload 不带 base_updated_at_map 时退化为现有行为（兼容性保障）
    expect(section).toContain("IF v_base_map IS NOT NULL AND jsonb_typeof(v_base_map) = 'object' THEN");
  });

  it('R1 二级护栏: connections 表挂 trg_prevent_connection_resurrection（复用 0511 函数）', () => {
    const sql = readMigration();
    expect(sql).toContain(
      'DROP TRIGGER IF EXISTS trg_prevent_connection_resurrection ON public.connections;',
    );
    expect(sql).toMatch(
      /CREATE TRIGGER trg_prevent_connection_resurrection\s+BEFORE UPDATE ON public\.connections\s+FOR EACH ROW\s+EXECUTE FUNCTION public\.prevent_soft_deleted_row_resurrection\(\)/,
    );
  });

  it('权限收紧（authenticated 可执行；anon / PUBLIC 拒绝）', () => {
    const sql = readMigration();
    for (const fn of [
      'sync_upsert_connection',
      'sync_upsert_blackbox_entry',
      'sync_upsert_project',
      'sync_delete_tasks',
    ]) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${fn}(JSONB) FROM PUBLIC, anon`);
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${fn}(JSONB) TO authenticated`);
    }
  });

  it('payload 不携带 updated_at 时退化为 server-arrival LWW（0509/0513 兼容性）', () => {
    // v_is_stale = FALSE when v_local_updated IS NULL → CASE 走 EXCLUDED 分支
    // 这条断言通过对 v_is_stale 表达式中 "v_local_updated IS NOT NULL" 守卫的存在间接保证。
    const sql = readMigration();
    for (const fn of ['sync_upsert_connection', 'sync_upsert_blackbox_entry', 'sync_upsert_project']) {
      const section = normalize(getFunctionSection(sql, fn));
      expect(section, `${fn} 必须显式守卫 v_local_updated IS NOT NULL`).toContain(
        'v_local_updated IS NOT NULL',
      );
    }
  });
});
