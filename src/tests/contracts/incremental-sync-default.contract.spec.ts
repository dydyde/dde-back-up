/**
 * 增量同步默认配置契约测试
 *
 * Hard Rule: 读路径必须走增量拉取（updated_at > cursor）。
 * INCREMENTAL_SYNC_ENABLED 默认必须为 true，feature flag 仅用于紧急回滚。
 *
 * @see AGENTS.md - 同步策略
 * @see feature-flags.config.ts
 * @see sync.config.ts
 */
import { describe, it, expect } from 'vitest';
import { FEATURE_FLAGS } from '../../config/feature-flags.config';
import { FIELD_SELECT_CONFIG, SYNC_CONFIG } from '../../config/sync.config';

describe('增量同步默认配置契约 (Incremental Sync Contract)', () => {
  it('FEATURE_FLAGS.INCREMENTAL_SYNC_ENABLED 默认必须为 true', () => {
    expect(FEATURE_FLAGS.INCREMENTAL_SYNC_ENABLED).toBe(true);
  });

  it('SYNC_CONFIG.DELTA_SYNC_ENABLED 应通过 getter 引用 FEATURE_FLAGS 且默认为 true', () => {
    expect(SYNC_CONFIG.DELTA_SYNC_ENABLED).toBe(true);
  });

  it('增量同步开关应存在且为布尔值', () => {
    expect(typeof FEATURE_FLAGS.INCREMENTAL_SYNC_ENABLED).toBe('boolean');
    expect(typeof SYNC_CONFIG.DELTA_SYNC_ENABLED).toBe('boolean');
  });

  it('任务增量查询字段必须包含 content，避免同步覆盖正文为空字符串', () => {
    const taskListFields = FIELD_SELECT_CONFIG.TASK_LIST_FIELDS.split(',');
    const taskDetailFields = FIELD_SELECT_CONFIG.TASK_DETAIL_FIELDS.split(',');
    const taskFullFields = FIELD_SELECT_CONFIG.TASK_FULL_FIELDS.split(',');

    expect(taskListFields).toContain('content');
    expect(taskDetailFields).toContain('content');
    expect(taskFullFields).toContain('content');
  });

  it('任务增量查询字段必须包含 attachments，避免增量同步清空附件列表', () => {
    const taskListFields = FIELD_SELECT_CONFIG.TASK_LIST_FIELDS.split(',');
    const taskDetailFields = FIELD_SELECT_CONFIG.TASK_DETAIL_FIELDS.split(',');
    const taskFullFields = FIELD_SELECT_CONFIG.TASK_FULL_FIELDS.split(',');

    expect(taskListFields).toContain('attachments');
    expect(taskDetailFields).toContain('attachments');
    expect(taskFullFields).toContain('attachments');
  });

  // 【根因防护 2026-05-15】回收站 UI 完全依赖 task.deletedAt（ProjectStateService.deletedTasks
  // = tasks().filter(t => t.deletedAt)）。任意一条任务字段裁剪去掉 deleted_at 都会让本地"误以为"
  // 远端把所有任务复活，从而回收站全部消失。这条断言锁死字段集合。
  it('任务查询字段必须包含 deleted_at，避免增量同步把已删除任务复活、导致回收站消失', () => {
    const taskListFields = FIELD_SELECT_CONFIG.TASK_LIST_FIELDS.split(',');
    const taskDetailFields = FIELD_SELECT_CONFIG.TASK_DETAIL_FIELDS.split(',');
    const taskFullFields = FIELD_SELECT_CONFIG.TASK_FULL_FIELDS.split(',');

    expect(taskListFields).toContain('deleted_at');
    expect(taskDetailFields).toContain('deleted_at');
    expect(taskFullFields).toContain('deleted_at');
  });
});
