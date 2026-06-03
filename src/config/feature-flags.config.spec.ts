/**
 * Feature Flags 安全性测试
 * 
 * 验证关键安全开关的默认值是否正确（Task 3.3 验证）
 */
import { describe, it, expect } from 'vitest';
import { FEATURE_FLAGS, isFeatureEnabled, validateCriticalFlags } from './feature-flags.config';

describe('Feature Flags 安全校验', () => {
  it('CONNECTION_TOMBSTONE_ENABLED 应默认启用', () => {
    expect(FEATURE_FLAGS.CONNECTION_TOMBSTONE_ENABLED).toBe(true);
  });

  it('SYNC_DURABILITY_FIRST_ENABLED 应默认启用', () => {
    expect(FEATURE_FLAGS.SYNC_DURABILITY_FIRST_ENABLED).toBe(true);
  });

  it('SYNC_STRICT_SUCCESS_ENABLED 应默认启用', () => {
    expect(FEATURE_FLAGS.SYNC_STRICT_SUCCESS_ENABLED).toBe(true);
  });

  it('REALTIME_ENABLED 应默认关闭以避免受限网络下 WebSocket 错误刷屏', () => {
    expect(FEATURE_FLAGS.REALTIME_ENABLED).toBe(false);
  });

  it('LOGOUT_CLEANUP_ENABLED 应默认启用', () => {
    expect(FEATURE_FLAGS.LOGOUT_CLEANUP_ENABLED).toBe(true);
  });

  it('SESSION_EXPIRED_CHECK_ENABLED 应默认启用', () => {
    expect(FEATURE_FLAGS.SESSION_EXPIRED_CHECK_ENABLED).toBe(true);
  });

  it('OFFLINE_SNAPSHOT_IDB_ENABLED 应默认关闭（灰度开关）', () => {
    expect(FEATURE_FLAGS.OFFLINE_SNAPSHOT_IDB_ENABLED).toBe(false);
  });

  it('PROJECT_FULL_DATA_RPC_V1 应默认关闭以避免大项目批量聚合 504', () => {
    expect(FEATURE_FLAGS.PROJECT_FULL_DATA_RPC_V1).toBe(false);
  });

  it('LIFECYCLE_RECOVERY_V1 应默认启用', () => {
    expect(FEATURE_FLAGS.LIFECYCLE_RECOVERY_V1).toBe(true);
  });

  it('RESUME_INTERACTION_FIRST_V1 应默认启用（全量上线）', () => {
    expect(FEATURE_FLAGS.RESUME_INTERACTION_FIRST_V1).toBe(true);
  });

  it('RESUME_WATERMARK_RPC_V1 应默认启用（全量上线）', () => {
    expect(FEATURE_FLAGS.RESUME_WATERMARK_RPC_V1).toBe(true);
  });

  it('RESUME_PULSE_DEDUP_V1 应默认启用（全量上线）', () => {
    expect(FEATURE_FLAGS.RESUME_PULSE_DEDUP_V1).toBe(true);
  });

  it('FLOW_INTENT_LAZYLOAD_V1 应默认启用', () => {
    expect(FEATURE_FLAGS.FLOW_INTENT_LAZYLOAD_V1).toBe(true);
  });

  it('BLACKBOX_PULL_COOLDOWN_V1 应默认启用', () => {
    expect(FEATURE_FLAGS.BLACKBOX_PULL_COOLDOWN_V1).toBe(true);
  });

  it('DISABLE_INDEX_DATA_PRELOAD_V1 应默认启用', () => {
    expect(FEATURE_FLAGS.DISABLE_INDEX_DATA_PRELOAD_V1).toBe(true);
  });

  it('FONT_EXTREME_FIRSTPAINT_V1 应默认启用', () => {
    expect(FEATURE_FLAGS.FONT_EXTREME_FIRSTPAINT_V1).toBe(true);
  });

  it('FOCUS_STARTUP_THROTTLED_CHECK_V1 应默认启用', () => {
    expect(FEATURE_FLAGS.FOCUS_STARTUP_THROTTLED_CHECK_V1).toBe(true);
  });

  it('ACTIVE_PROJECT_ACCESS_PREFLIGHT_V1 应默认启用', () => {
    expect(FEATURE_FLAGS.ACTIVE_PROJECT_ACCESS_PREFLIGHT_V1).toBe(true);
  });

  it('FLOW_STATE_AWARE_RESTORE_V2 应默认启用', () => {
    expect(FEATURE_FLAGS.FLOW_STATE_AWARE_RESTORE_V2).toBe(true);
  });

  it('EVENT_DRIVEN_SYNC_PULSE_V1 应默认启用', () => {
    expect(FEATURE_FLAGS.EVENT_DRIVEN_SYNC_PULSE_V1).toBe(true);
  });

  it('TAB_SYNC_LOCAL_REFRESH_V1 应默认启用', () => {
    expect(FEATURE_FLAGS.TAB_SYNC_LOCAL_REFRESH_V1).toBe(true);
  });

  it('ROOT_STARTUP_DEP_PRUNE_V1 应默认启用', () => {
    expect(FEATURE_FLAGS.ROOT_STARTUP_DEP_PRUNE_V1).toBe(true);
  });

  it('STRICT_MODULEPRELOAD_V2 应默认关闭以允许关键路径 preload', () => {
    expect(FEATURE_FLAGS.STRICT_MODULEPRELOAD_V2).toBe(false);
  });

  it('ROOT_FORMS_FREE_V1 应默认启用', () => {
    expect(FEATURE_FLAGS.ROOT_FORMS_FREE_V1).toBe(true);
  });

  it('USER_SESSION_ATTACHMENT_ON_DEMAND_V1 应默认启用', () => {
    expect(FEATURE_FLAGS.USER_SESSION_ATTACHMENT_ON_DEMAND_V1).toBe(true);
  });

  it('USER_SESSION_MIGRATION_PRUNE_V1 应默认启用', () => {
    expect(FEATURE_FLAGS.USER_SESSION_MIGRATION_PRUNE_V1).toBe(true);
  });

  it('TIERED_STARTUP_HYDRATION_V1 应默认启用', () => {
    expect(FEATURE_FLAGS.TIERED_STARTUP_HYDRATION_V1).toBe(true);
  });

  it('SUPABASE_DEFERRED_SDK_V1 应默认启用', () => {
    expect(FEATURE_FLAGS.SUPABASE_DEFERRED_SDK_V1).toBe(true);
  });

  it('CONFIG_BARREL_PRUNE_V1 应默认启用', () => {
    expect(FEATURE_FLAGS.CONFIG_BARREL_PRUNE_V1).toBe(true);
  });

  it('SIDEBAR_TOOLS_DYNAMIC_LOAD_V1 应默认启用', () => {
    expect(FEATURE_FLAGS.SIDEBAR_TOOLS_DYNAMIC_LOAD_V1).toBe(true);
  });

  it('ROUTE_GUARD_LAZY_IMPORT_V1 应默认启用', () => {
    expect(FEATURE_FLAGS.ROUTE_GUARD_LAZY_IMPORT_V1).toBe(true);
  });

  it('WEB_VITALS_IDLE_BOOT_V2 应默认启用', () => {
    expect(FEATURE_FLAGS.WEB_VITALS_IDLE_BOOT_V2).toBe(true);
  });

  it('FONT_AGGRESSIVE_DEFER_V2 应默认启用', () => {
    expect(FEATURE_FLAGS.FONT_AGGRESSIVE_DEFER_V2).toBe(true);
  });

  it('WORKSPACE_SHELL_SPLIT_V2 应默认启用', () => {
    expect(FEATURE_FLAGS.WORKSPACE_SHELL_SPLIT_V2).toBe(true);
  });

  it('SYNC_STATUS_DEFERRED_MOUNT_V1 应默认启用', () => {
    expect(FEATURE_FLAGS.SYNC_STATUS_DEFERRED_MOUNT_V1).toBe(true);
  });

  it('PWA_PROMPT_DEFER_V2 应默认启用', () => {
    expect(FEATURE_FLAGS.PWA_PROMPT_DEFER_V2).toBe(true);
  });

  it('PWA_NATIVE_INSTALL_PROMPT_V1 应默认启用', () => {
    expect(FEATURE_FLAGS.PWA_NATIVE_INSTALL_PROMPT_V1).toBe(true);
  });

  it('RESUME_SESSION_SNAPSHOT_V1 应默认启用', () => {
    expect(FEATURE_FLAGS.RESUME_SESSION_SNAPSHOT_V1).toBe(true);
  });

  it('USER_PROJECTS_WATERMARK_RPC_V1 应默认启用', () => {
    expect(FEATURE_FLAGS.USER_PROJECTS_WATERMARK_RPC_V1).toBe(true);
  });

  it('RECOVERY_TICKET_DEDUP_V1 应默认启用', () => {
    expect(FEATURE_FLAGS.RECOVERY_TICKET_DEDUP_V1).toBe(true);
  });

  it('BLACKBOX_WATERMARK_PROBE_V1 应默认启用', () => {
    expect(FEATURE_FLAGS.BLACKBOX_WATERMARK_PROBE_V1).toBe(true);
  });

  it('WORKSPACE_SHELL_COMPOSITION_V3 应默认启用', () => {
    expect(FEATURE_FLAGS.WORKSPACE_SHELL_COMPOSITION_V3).toBe(true);
  });

  it('RESUME_COMPOSITE_PROBE_RPC_V1 应默认启用', () => {
    expect(FEATURE_FLAGS.RESUME_COMPOSITE_PROBE_RPC_V1).toBe(true);
  });

  it('RESUME_METRICS_GATE_V1 应默认启用', () => {
    expect(FEATURE_FLAGS.RESUME_METRICS_GATE_V1).toBe(true);
  });

  it('isFeatureEnabled 工具函数应正确返回布尔值', () => {
    expect(isFeatureEnabled('CONNECTION_TOMBSTONE_ENABLED')).toBe(true);
    expect(isFeatureEnabled('DEMO_MODE_ENABLED')).toBe(false);
  });

  it('所有关键安全开关不应被意外禁用', () => {
    const disabledFlags = validateCriticalFlags();
    expect(disabledFlags).toEqual([]);
  });

  it('validateCriticalFlags 应覆盖所有关键保护性开关', () => {
    // 确保关键列表至少包含核心安全 flags
    const expectedMinimumFlags = [
      'CIRCUIT_BREAKER_ENABLED',
      'SESSION_EXPIRED_CHECK_ENABLED',
      'LOGOUT_CLEANUP_ENABLED',
      'CONNECTION_TOMBSTONE_ENABLED',
      'SYNC_STRICT_SUCCESS_ENABLED',
      'SYNC_DURABILITY_FIRST_ENABLED',
      'MIGRATION_SNAPSHOT_ENABLED',
      'MIGRATION_CONFIRMATION_REQUIRED',
      'SYNC_SERVER_CURSOR_ENABLED',
      'SYNC_TASK_LEVEL_CALLBACK_ENABLED',
    ];
    // validateCriticalFlags 返回被禁用的 flags，全部启用时返回空。
    // 我们无法从返回值获取完整列表，但可以确认没有误禁用
    const disabled = validateCriticalFlags();
    expect(disabled).toEqual([]);
    // 逐一验证这些 flags 都是 true
    for (const flag of expectedMinimumFlags) {
      expect(FEATURE_FLAGS[flag as keyof typeof FEATURE_FLAGS]).toBe(true);
    }
  });
});
