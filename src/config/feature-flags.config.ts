// ============================================
// 特性开关配置
// 用于功能开关（开/关），与环境配置分离
// 
// 使用方式：
// import { FEATURE_FLAGS } from '@config/feature-flags.config';
// if (FEATURE_FLAGS.CIRCUIT_BREAKER_ENABLED) { ... }
// 
// 当前版本：静态配置，需重新部署
// 未来考虑：可通过 Supabase Edge Config 实现运行时动态开关
// ============================================

type RuntimeBootFlag =
  | 'LAUNCH_CONTRACT_V2'
  | 'AUTH_RUNTIME_GATE_V1'
  | 'SNAPSHOT_HANDOFF_V2'
  | 'RESUME_INTERACTION_FIRST_V1'
  | 'RESUME_WATERMARK_RPC_V1'
  | 'RESUME_PULSE_DEDUP_V1'
  | 'ROUTE_GUARD_LAZY_IMPORT_V1'
  | 'WEB_VITALS_IDLE_BOOT_V2'
  | 'FONT_AGGRESSIVE_DEFER_V2'
  | 'SYNC_STATUS_DEFERRED_MOUNT_V1'
  | 'PWA_PROMPT_DEFER_V2'
  | 'PWA_NATIVE_INSTALL_PROMPT_V1'
  | 'RESUME_SESSION_SNAPSHOT_V1'
  | 'USER_PROJECTS_WATERMARK_RPC_V1'
  | 'RECOVERY_TICKET_DEDUP_V1'
  | 'BLACKBOX_WATERMARK_PROBE_V1'
  | 'WORKSPACE_SHELL_COMPOSITION_V3'
  | 'RESUME_COMPOSITE_PROBE_RPC_V1'
  | 'RESUME_METRICS_GATE_V1';

function readRuntimeBooleanFlag(flag: RuntimeBootFlag, fallback: boolean): boolean {
  if (typeof window === 'undefined') {
    return fallback;
  }

  const bootFlags = (
    window as Window & { __NANOFLOW_BOOT_FLAGS__?: Record<string, unknown> }
  ).__NANOFLOW_BOOT_FLAGS__;
  const runtimeValue = bootFlags?.[flag];
  return typeof runtimeValue === 'boolean' ? runtimeValue : fallback;
}

/**
 * 特性开关
 * 
 * 职责：控制功能的开/关
 * 与 environment.ts 的区别：
 * - FEATURE_FLAGS 用于功能开关（开/关）
 * - environment.ts 用于环境配置（开发/生产）
 */
export const FEATURE_FLAGS = {
  // ==================== 熔断层 ====================
  /** 是否启用客户端熔断保护 */
  CIRCUIT_BREAKER_ENABLED: true,
  /** 是否启用 L3 硬熔断（可单独关闭硬熔断） */
  CIRCUIT_BREAKER_L3_ENABLED: true,
  
  // ==================== Demo 模式 ====================
  /** 是否启用 Demo 模式（显示 Demo Banner，限制功能） */
  DEMO_MODE_ENABLED: false,
  /** Demo 模式最大项目数限制 */
  DEMO_PROJECT_LIMIT: 3,
  /** Demo 数据保留天数（用于共享实例方案） */
  DEMO_DATA_RETENTION_DAYS: 7,
  
  // ==================== 安全功能 ====================
  /** 是否启用会话过期检查 */
  SESSION_EXPIRED_CHECK_ENABLED: true,
  /** 是否启用登出时数据清理 */
  LOGOUT_CLEANUP_ENABLED: true,
  /** 是否启用 Connection Tombstone 防复活 */
  CONNECTION_TOMBSTONE_ENABLED: true,
  
  // ==================== 备份功能 ====================
  /** 是否启用自动备份 */
  AUTO_BACKUP_ENABLED: false, // 默认关闭，待 P2 实现
  /** 是否启用用户手动导出 */
  MANUAL_EXPORT_ENABLED: false, // 默认关闭，待 P1 实现
  
  // ==================== 同步功能 ====================
  /**
   * 是否启用 Realtime 订阅（替代轮询）
   * SYNC_CONFIG.REALTIME_ENABLED 通过 getter 自动引用此值，无需手动保持一致
   */
    REALTIME_ENABLED: false, // 默认使用轮询，避免受限网络下 WebSocket/heartbeat 错误刷屏
  /**
   * 是否启用增量同步优化
   * SYNC_CONFIG.DELTA_SYNC_ENABLED 通过 getter 自动引用此值，无需手动保持一致
   * Hard Rule：读路径必须走增量拉取，此开关仅用于紧急回滚
   */
  INCREMENTAL_SYNC_ENABLED: true,
  /** 同步成功语义：仅远端确认成功才视为成功 */
  SYNC_STRICT_SUCCESS_ENABLED: true,
  /** 队列耐久优先：禁用默认淘汰策略 */
  SYNC_DURABILITY_FIRST_ENABLED: true,
  /** Delta 游标使用服务端 max(updated_at) 推进 */
  SYNC_SERVER_CURSOR_ENABLED: true,
  /** Realtime 任务级回调链路 */
  SYNC_TASK_LEVEL_CALLBACK_ENABLED: true,
  /** 单队列语义（灰度开关，先用于状态口径与入口约束） */
  SYNC_UNIFIED_QUEUE_SEMANTICS_ENABLED: true,
  /** 离线快照使用 IndexedDB 替代 localStorage（缓解 5MB 上限） */
  OFFLINE_SNAPSHOT_IDB_ENABLED: false,
  /** 完整项目批量 RPC 快路：默认关闭，避免大项目 JSON 聚合触发网关 504 */
  PROJECT_FULL_DATA_RPC_V1: false,

  // ==================== PWA 生命周期与体验 ====================
  /** 生命周期恢复编排（前后台切换自愈） */
  LIFECYCLE_RECOVERY_V1: true,
  /** 恢复链路交互优先（light/heavy 分级恢复） */
  RESUME_INTERACTION_FIRST_V1: readRuntimeBooleanFlag('RESUME_INTERACTION_FIRST_V1', true),
  /** 恢复链路项目水位 RPC 快路 */
  RESUME_WATERMARK_RPC_V1: readRuntimeBooleanFlag('RESUME_WATERMARK_RPC_V1', true),
  /** 恢复链路 pulse 去重（heavy 后抑制） */
  RESUME_PULSE_DEDUP_V1: readRuntimeBooleanFlag('RESUME_PULSE_DEDUP_V1', true),
  /** Flow 视图用户意图触发懒加载 */
  FLOW_INTENT_LAZYLOAD_V1: true,
  /** 黑匣子恢复拉取冷却窗口 */
  BLACKBOX_PULL_COOLDOWN_V1: true,
  /** PWA 安装提示与安装态体验 */
  PWA_INSTALL_PROMPT_V1: true,
  /** PWA 安装提示优先交给浏览器原生 UX，仅 iOS 保留手动指引 */
  PWA_NATIVE_INSTALL_PROMPT_V1: readRuntimeBooleanFlag('PWA_NATIVE_INSTALL_PROMPT_V1', true),
  /** 禁用 index.html 首屏数据预加载 fetch（弱网优先） */
  DISABLE_INDEX_DATA_PRELOAD_V1: true,
  /** 字体极致首屏策略（增强字体延后加载） */
  FONT_EXTREME_FIRSTPAINT_V1: true,
  /** Focus 启动即时本地检查 + 远端节流拉取 */
  FOCUS_STARTUP_THROTTLED_CHECK_V1: true,
  /** activeProject 访问预判（避免无效 RPC 400） */
  ACTIVE_PROJECT_ACCESS_PREFLIGHT_V1: true,
  /** Flow 状态感知恢复（桌面端智能恢复/弱网降级） */
  FLOW_STATE_AWARE_RESTORE_V2: true,
  /** 事件驱动同步脉冲（非常驻 WebSocket） */
  EVENT_DRIVEN_SYNC_PULSE_V1: true,
  /** 跨标签同步后的本地零网络回填 */
  TAB_SYNC_LOCAL_REFRESH_V1: true,
  /** 根组件启动依赖瘦身（重服务按需懒加载） */
  ROOT_STARTUP_DEP_PRUNE_V1: true,
  /** modulepreload 严格模式关闭，允许关键路径 chunk preload 消除串行瀑布 */
  STRICT_MODULEPRELOAD_V2: false,
  /** 启动文档/缓存链路契约收口 */
  LAUNCH_CONTRACT_V2: readRuntimeBooleanFlag('LAUNCH_CONTRACT_V2', true),
  /** Auth runtime 延后到 handoff 后显式启动 */
  AUTH_RUNTIME_GATE_V1: readRuntimeBooleanFlag('AUTH_RUNTIME_GATE_V1', true),
  /** Snapshot v2 + handoff 协调器 */
  SNAPSHOT_HANDOFF_V2: readRuntimeBooleanFlag('SNAPSHOT_HANDOFF_V2', true),
  /** Root 组件移除 FormsModule（改为原生 input 事件绑定） */
  ROOT_FORMS_FREE_V1: true,
  /** UserSession 附件服务按需懒加载 */
  USER_SESSION_ATTACHMENT_ON_DEMAND_V1: true,
  /** UserSession 移除启动期 MigrationService 注入 */
  USER_SESSION_MIGRATION_PRUNE_V1: true,
  /** 分层启动水合（P0/P1/P2） */
  TIERED_STARTUP_HYDRATION_V1: true,
  /** Supabase SDK 延迟装载 */
  SUPABASE_DEFERRED_SDK_V1: true,
  /** 启动热路径禁用 config barrel 导入 */
  CONFIG_BARREL_PRUNE_V1: true,
  /** 侧栏工具链动态加载 */
  SIDEBAR_TOOLS_DYNAMIC_LOAD_V1: true,
  /** 路由守卫按需异步加载（移出 initial static） */
  ROUTE_GUARD_LAZY_IMPORT_V1: readRuntimeBooleanFlag('ROUTE_GUARD_LAZY_IMPORT_V1', true),
  /** Web Vitals 监控改为 idle 阶段动态初始化 */
  WEB_VITALS_IDLE_BOOT_V2: readRuntimeBooleanFlag('WEB_VITALS_IDLE_BOOT_V2', true),
  /** 字体增强样式激进延后加载策略 */
  FONT_AGGRESSIVE_DEFER_V2: readRuntimeBooleanFlag('FONT_AGGRESSIVE_DEFER_V2', true),
  /** 工作区壳层 V2 拆分 */
  WORKSPACE_SHELL_SPLIT_V2: true,
  /** 同步状态面板延后挂载 */
  SYNC_STATUS_DEFERRED_MOUNT_V1: readRuntimeBooleanFlag('SYNC_STATUS_DEFERRED_MOUNT_V1', true),
  /** PWA 安装提示延后初始化 */
  PWA_PROMPT_DEFER_V2: readRuntimeBooleanFlag('PWA_PROMPT_DEFER_V2', true),
  /** 恢复链路会话快照复用 */
  RESUME_SESSION_SNAPSHOT_V1: readRuntimeBooleanFlag('RESUME_SESSION_SNAPSHOT_V1', true),
  /** 用户项目清单水位 RPC 快路 */
  USER_PROJECTS_WATERMARK_RPC_V1: readRuntimeBooleanFlag('USER_PROJECTS_WATERMARK_RPC_V1', true),
  /** 热路径禁止 config barrel（构建/CI 门禁，非运行时回滚项） */
  HOTPATH_CONFIG_BARREL_BAN_V1: true,
  /** 恢复 ticket 去重（同 ticket 禁止重复 heavy/light） */
  RECOVERY_TICKET_DEDUP_V1: readRuntimeBooleanFlag('RECOVERY_TICKET_DEDUP_V1', true),
  /** 黑匣子 watermark 先判变更再拉明细 */
  BLACKBOX_WATERMARK_PROBE_V1: readRuntimeBooleanFlag('BLACKBOX_WATERMARK_PROBE_V1', true),
  /** Workspace Shell 组合式拆分（V3） */
  WORKSPACE_SHELL_COMPOSITION_V3: readRuntimeBooleanFlag('WORKSPACE_SHELL_COMPOSITION_V3', true),
  /** 恢复聚合探测 RPC（项目访问性+项目/黑匣子水位） */
  RESUME_COMPOSITE_PROBE_RPC_V1: readRuntimeBooleanFlag('RESUME_COMPOSITE_PROBE_RPC_V1', true),
  /** 恢复指标门禁（resume.* 埋点与预算校验） */
  RESUME_METRICS_GATE_V1: readRuntimeBooleanFlag('RESUME_METRICS_GATE_V1', true),
  /** 性能无回归门禁（构建/CI 门禁，非运行时回滚项） */
  NO_REGRESSION_GUARD_V1: true,
  
  // ==================== 迁移功能 ====================
  /** 是否启用迁移快照 */
  MIGRATION_SNAPSHOT_ENABLED: true,
  /** 是否要求迁移二次确认 */
  MIGRATION_CONFIRMATION_REQUIRED: true,
  
  // ==================== 调试功能 ====================
  /** 是否启用详细日志 */
  VERBOSE_LOGGING_ENABLED: false,
  /** 是否启用性能监控 */
  PERFORMANCE_MONITORING_ENABLED: false,
} as const;

/**
 * 特性开关类型（仅布尔类型的开关）
 */
export type FeatureFlag = {
  [K in keyof typeof FEATURE_FLAGS]: typeof FEATURE_FLAGS[K] extends boolean ? K : never
}[keyof typeof FEATURE_FLAGS];

/**
 * 检查特性是否启用
 * @reserved 预留的工具函数，供动态特性开关检查使用
 * 
 * @param flag 特性开关名称（仅布尔类型）
 * @returns 是否启用
 */
export function isFeatureEnabled(flag: FeatureFlag): boolean {
  return FEATURE_FLAGS[flag] as boolean;
}

// ==================== 【NEW-8】关键 Flag 安全校验 ====================

/**
 * 关键保护性 Flag 列表
 * 禁用这些 Flag 可能导致数据丢失、安全漏洞或同步异常
 */
const CRITICAL_FLAGS: ReadonlyArray<{ flag: FeatureFlag; risk: string }> = [
  { flag: 'CIRCUIT_BREAKER_ENABLED', risk: '禁用后客户端熔断保护失效，异常请求可能无限重试导致雪崩' },
  { flag: 'SESSION_EXPIRED_CHECK_ENABLED', risk: '禁用后不检测会话过期，可能导致操作被静默丢弃' },
  { flag: 'LOGOUT_CLEANUP_ENABLED', risk: '禁用后登出时不清理本地数据，存在跨用户数据泄露风险' },
  { flag: 'CONNECTION_TOMBSTONE_ENABLED', risk: '禁用后已删除连接可能在同步时复活' },
  { flag: 'SYNC_STRICT_SUCCESS_ENABLED', risk: '禁用后部分同步失败可能被误判为成功，导致数据不一致' },
  { flag: 'SYNC_DURABILITY_FIRST_ENABLED', risk: '禁用后同步队列可能淘汰未推送的操作，导致数据丢失' },
  { flag: 'MIGRATION_SNAPSHOT_ENABLED', risk: '禁用后迁移前不创建快照，迁移失败时无法回滚' },
  { flag: 'MIGRATION_CONFIRMATION_REQUIRED', risk: '禁用后迁移操作不需要二次确认，可能误触发不可逆迁移' },
  { flag: 'SYNC_SERVER_CURSOR_ENABLED', risk: '禁用后 delta 游标降级为 client-now，时钟漂移时可能丢失变更' },
  { flag: 'SYNC_TASK_LEVEL_CALLBACK_ENABLED', risk: '禁用后 Realtime 回调链路断开，实时更新失效' },
] as const;

/**
 * 校验关键保护性 Feature Flags 状态
 * 
 * 在应用启动时调用，如果发现关键 Flag 被禁用，输出 console.warn 警告。
 * 不阻塞启动流程，但确保开发者/运维人员能感知潜在风险。
 * 
 * @returns 被禁用的关键 Flag 列表（空数组表示全部正常）
 */
export function validateCriticalFlags(): ReadonlyArray<{ flag: string; risk: string }> {
  const disabledCritical: Array<{ flag: string; risk: string }> = [];

  for (const { flag, risk } of CRITICAL_FLAGS) {
    if (!FEATURE_FLAGS[flag]) {
      disabledCritical.push({ flag, risk });
    }
  }

  if (disabledCritical.length > 0) {
    console.warn(
      `[FeatureFlags] ⚠️ ${disabledCritical.length} 个关键保护性开关已禁用：\n` +
      disabledCritical.map(d => `  • ${d.flag}: ${d.risk}`).join('\n')
    );
  }

  return disabledCritical;
}
