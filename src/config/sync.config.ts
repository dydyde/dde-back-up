// ============================================
// 同步配置
// 包含数据同步、离线缓存、冲突处理、请求限流相关常量
// ============================================

import { FEATURE_FLAGS } from './feature-flags.config';

/**
 * 同步配置
 *
 * 保守模式设计理念：优先保证数据不丢失，降低实时性
 * - 较长的防抖延迟，避免频繁同步导致冲突
 * - 本地优先，云端作为备份
 * - 永不主动丢弃用户数据
 *
 * 【流量优化】2024-12-31
 * - 默认禁用 Realtime，改用轮询
 * - 字段筛选替代 SELECT *
 * - 增量同步优化
 */
export const SYNC_CONFIG = {
  /** 防抖延迟（毫秒）- 增加到3秒，确保用户完成一轮编辑后再同步 */
  DEBOUNCE_DELAY: 3000,
  /** 编辑状态超时（毫秒）- 增加到5秒，给用户更多思考时间 */
  EDITING_TIMEOUT: 5000,
  /** 远程变更处理延迟（毫秒）- 增加到2秒，避免干扰本地编辑 */
  REMOTE_CHANGE_DELAY: 2000,
  /** 冲突检测时间阈值（毫秒）- 放宽到10秒，减少误判 */
  CONFLICT_TIME_THRESHOLD: 10000,
  /** 重连基础延迟（毫秒） */
  RECONNECT_BASE_DELAY: 1000,
  /** 重连最大延迟（毫秒） */
  RECONNECT_MAX_DELAY: 30000,
  /** 云端数据加载超时（毫秒）- 增加到30秒，避免网络慢时加载失败 */
  CLOUD_LOAD_TIMEOUT: 30000,
  /** 本地缓存保存频率（毫秒）- 每3秒自动保存到本地（含脏检查，无变更时跳过） */
  LOCAL_AUTOSAVE_INTERVAL: 3000,
  /** 连通性探测间隔（毫秒）- 用于在 VPN/网络切换后自动恢复在线状态 */
  CONNECTIVITY_PROBE_INTERVAL: 15000,
  /** 连通性探测超时（毫秒）- 避免弱网时长时间挂起 */
  CONNECTIVITY_PROBE_TIMEOUT: 5000,
  // 【已清理】CIRCUIT_BREAKER_* 配置已迁移到 CIRCUIT_BREAKER_CONFIG
  // 详见下方 CIRCUIT_BREAKER_CONFIG 定义
  /**
   * 重试队列最大大小（防止 localStorage 溢出）
   * 【2024-12-31 修复】从 500 降低到 100，因为每个 Task 可能包含大量内容
   * localStorage 配额约 5-10MB，100 个大型任务约占用 1-2MB
   */
  MAX_RETRY_QUEUE_SIZE: 100,
  /**
   * IndexedDB 场景重试队列上限
   * IndexedDB 容量远高于 localStorage，允许更高积压以避免长离线时过早拒绝写入
   */
  MAX_RETRY_QUEUE_SIZE_INDEXEDDB: 1000,
  /** 重试项最大年龄（毫秒，24 小时）*/
  MAX_RETRY_ITEM_AGE: 24 * 60 * 60 * 1000,
  /**
   * 存储配额警告阈值（字节）
   * 当重试队列序列化后超过此大小时触发缩减
   * 默认 1MB，留出余量给其他 localStorage 使用
   */
  RETRY_QUEUE_SIZE_LIMIT_BYTES: 1 * 1024 * 1024,
  
  // ==================== Realtime 配置（流量优化）====================
  /**
   * 是否启用 Realtime 订阅
   * 【流量优化】默认禁用，改用轮询节省 WebSocket 流量
   * 对于个人 PWA，轮询足够且更节省流量
   *
   * 【统一数据源】直接引用 FEATURE_FLAGS，消除双源不一致风险
   */
  get REALTIME_ENABLED(): boolean { return FEATURE_FLAGS.REALTIME_ENABLED; },
  /** 
   * 轮询间隔（毫秒）- 替代 Realtime 的轮询频率
   * 【流量优化 2026-01-12】从 30s 增加到 5 分钟
   * 【免费层优化 2026-03-23】从 5 分钟增加到 10 分钟
   * 理由：单人应用操作触发即时同步，轮询仅是兜底；日均节省 ~3000 次 API 请求
   */
  POLLING_INTERVAL: 600_000,
  /** 
   * 轮询活跃状态判定时间（毫秒）- 用户活跃时使用较短间隔
   * 【流量优化 2026-01-12】从 15s 增加到 60s
   * 【免费层优化 2026-03-23】从 60s 增加到 120s
   * 理由：活跃态轮询密度减半，日均节省 ~5000 次请求
   */
  POLLING_ACTIVE_INTERVAL: 120_000,
  /** 用户活跃超时（毫秒）- 用户无操作后视为不活跃 */
  USER_ACTIVE_TIMEOUT: 60000,
  
  // ==================== 增量同步配置 ====================
  /**
   * Tombstone 缓存有效期（毫秒）
   * 【免费层优化 2026-03-23】从 5 分钟延长到 30 分钟
   * 理由：task_tombstones 和 connection_tombstones 当前均为 0 行，变动极低频；
   * 延长 TTL 可将 tombstone 查询从每轮轮询降为约 1/6，日均节省 ~4000 次请求
   */
  TOMBSTONE_CACHE_TTL: 30 * 60 * 1000,
  
  /**
   * 是否启用 Delta Sync（增量同步）
   * 【Stingy Hoarder Protocol】Feature Flag
   * - true: 使用 updated_at 增量拉取，仅同步变更数据
   * - false: 使用全量拉取（当前默认，待验证后切换）
   * @see docs/plan_save.md Phase 2
   *
   * 【统一数据源】直接引用 FEATURE_FLAGS，消除双源不一致风险
   */
  get DELTA_SYNC_ENABLED(): boolean { return FEATURE_FLAGS.INCREMENTAL_SYNC_ENABLED; },
  /** Delta 游标安全回看窗口（毫秒），抵御时钟漂移/读已提交边界 */
  CURSOR_SAFETY_LOOKBACK_MS: 30_000,
  /** 脏字段保护窗口（毫秒），超过窗口后允许远端合法更新覆盖 */
  DIRTY_PROTECTION_WINDOW_MS: 10 * 60 * 1000,
  /** Tombstone 本地保留时长（毫秒） */
  TOMBSTONE_RETENTION_MS: 30 * 24 * 60 * 60 * 1000,
  /**
   * 黑匣子拉取新鲜度窗口（毫秒）
   * 在此窗口内重复调用 pullChanges() 会被跳过，防止多处并发触发产生重复请求
   * 【性能优化 2026-02-14】解决登录后 black_box_entries 重复拉取问题
   */
  BLACKBOX_PULL_FRESHNESS_WINDOW: 30_000,
} as const;

export const RECOVERABLE_SYNC_ERROR_MESSAGES = {
  PARTIAL_RETRY_HANDOFF: '部分同步失败，已进入重试队列',
  RETRY_QUEUE_FULL: '同步队列已满，暂未写入重试队列',
} as const;

/**
 * 同步耐久策略配置（Durability-First）
 */
export const SYNC_DURABILITY_CONFIG = {
  /**
   * 队列满载策略：
   * - soft-overflow: 超过软上限后继续接收写入，后台加速排队消化（默认）
   * - reject-new: 仅用于绝对保护上限触发时的兜底拒绝
   */
  DROP_POLICY: 'soft-overflow' as const,
  /**
   * 存储压力模式：
   * - memory-fallback: 存储压力下优先内存兜底，恢复后再持久化
   * - freeze-writes: 兼容旧行为（冻结新写）
   */
  STORAGE_PRESSURE_MODE: 'memory-fallback' as const,
  /**
   * Delta 游标推进策略：
   * - max-server-updated-at: 以本次返回最大 updated_at 推进（推荐）
   * - client-now: 兼容旧行为（不推荐）
   */
  CURSOR_STRATEGY: 'max-server-updated-at' as const,
} as const;

/**
 * 字段筛选配置 - 替代 SELECT * 节省流量
 * 
 * 【P0 修复】2026-01-13
 * - 【重要】同步查询必须包含 content 字段，否则会导致任务内容丢失！
 * - 原设计的流量优化导致 content 在同步过程中被空字符串覆盖
 * - 问题路径：pullTasks → rowToTask(content: undefined → '') → 合并时覆盖本地内容
 * 
 * 【历史】2024-12-31 流量优化尝试
 * - 原计划：任务列表查询只返回元数据，不包含 content
 * - 结果：导致严重的数据丢失 Bug，已回滚
 */
export const FIELD_SELECT_CONFIG = {
  /** 
   * 任务列表字段
   * 【P0 修复】必须包含 content，否则同步时会丢失任务内容
   * 【P0-1 修复】必须包含 attachments，否则增量同步会清空附件列表
   */
  TASK_LIST_FIELDS: 'id,title,content,stage,parent_id,order,rank,status,x,y,updated_at,deleted_at,short_id,attachments,tags,priority,due_date,expected_minutes,cognitive_load,wait_minutes,created_at,completed_at,parking_meta',
  /** 任务详情字段（包含 content 和 attachments） */
  TASK_DETAIL_FIELDS: 'id,title,content,stage,parent_id,order,rank,status,x,y,updated_at,deleted_at,short_id,attachments,tags,priority,due_date,expected_minutes,cognitive_load,wait_minutes,created_at,completed_at,parking_meta',
  /** 任务完整字段（用于全量加载，替代 select('*')） */
  TASK_FULL_FIELDS: 'id,title,content,stage,parent_id,order,rank,status,x,y,updated_at,deleted_at,short_id,attachments,created_at,completed_at,project_id,priority,due_date,expected_minutes,cognitive_load,wait_minutes,tags,parking_meta',
  /** 连接字段 */
  CONNECTION_FIELDS: 'id,source_id,target_id,title,description,deleted_at,updated_at',
  /** 连接完整字段（用于全量加载，替代 select('*')） */
  CONNECTION_FULL_FIELDS: 'id,project_id,source_id,target_id,title,description,deleted_at,updated_at',
  /** 项目列表字段 */
  PROJECT_LIST_FIELDS: 'id,title,description,created_date,updated_at,version,owner_id,deleted_at',
  /** 项目完整字段（用于全量加载，替代 select('*')） */
  PROJECT_FULL_FIELDS: 'id,title,description,created_date,updated_at,version,owner_id,deleted_at,migrated_to_v2',
  /** Tombstone 字段 */
  TOMBSTONE_FIELDS: 'task_id,deleted_at,project_id',
} as const;

/**
 * 请求限流配置
 * 解决并发 Supabase API 调用耗尽连接池的问题
 * 
 * 问题背景：
 * - Chrome 对同一域名限制 6 个并发 HTTP 连接
 * - Supabase 数据库连接池有限
 * - 页面加载时大量并发请求可能导致 "Failed to fetch" 错误
 */
export const REQUEST_THROTTLE_CONFIG = {
  /** 最大并发请求数 - Chrome 对同一域名限制 6 个，留 2 个给用户交互 */
  MAX_CONCURRENT: 4,
  /** 默认超时时间（毫秒）- 增加到 60 秒，因为队列等待时间也计入超时 */
  DEFAULT_TIMEOUT: 60000,
  /** 批量同步操作超时时间（毫秒）- 90 秒，给批量 push 操作更多时间 */
  BATCH_SYNC_TIMEOUT: 90000,
  /** 单个操作超时时间（毫秒）- 30 秒，平衡用户体验和慢速网络 */
  INDIVIDUAL_OPERATION_TIMEOUT: 30000,
  /** 默认重试次数 */
  DEFAULT_RETRIES: 3,
  /** 重试基础延迟（毫秒）*/
  RETRY_BASE_DELAY: 1000,
  /** 重试最大延迟（毫秒）*/
  RETRY_MAX_DELAY: 30000,
  /** 去重缓存过期时间（毫秒）*/
  DEDUPE_TTL: 5000,
  /** 请求队列最大长度 */
  MAX_QUEUE_SIZE: 100,
  /** 序列化连接操作间隔（毫秒）- 避免连续写操作触发 Supabase 速率限制 */
  SEQUENTIAL_OP_DELAY_MS: 200,
} as const;

/**
 * Circuit Breaker 配置
 * 防止在服务端持续故障时（如 504 Gateway Timeout）无效重试
 * 
 * 工作原理：
 * - closed: 正常状态，允许所有请求
 * - open: 熔断状态，拒绝所有请求，等待恢复时间
 * - half-open: 半开状态，允许少量试探请求
 */
export const CIRCUIT_BREAKER_CONFIG = {
  /** 触发熔断的连续失败次数 */
  FAILURE_THRESHOLD: 3,
  /** 熔断恢复时间（毫秒）- 30 秒 */
  RECOVERY_TIME: 30000,
  /** 半开状态允许的试探请求数 */
  HALF_OPEN_REQUESTS: 1,
  /** 触发熔断的错误类型（网络不可达/服务端超时/网关错误） */
  TRIGGER_ERROR_TYPES: ['NetworkError', 'NetworkTimeoutError', 'GatewayError', 'ServiceUnavailableError', 'UnknownServerError'] as readonly string[],
} as const;

/**
 * 缓存配置
 */
export const CACHE_CONFIG = {
  /** 离线缓存 key */
  OFFLINE_CACHE_KEY: 'nanoflow.offline-cache-v2',
  /** 主题缓存 key */
  THEME_CACHE_KEY: 'nanoflow.theme',
  /** 缓存版本号 */
  CACHE_VERSION: 2,
  /** 待处理变更存活时间（毫秒）- 2小时 */
  PENDING_CHANGES_TTL: 2 * 60 * 60 * 1000,
  /** 待处理变更清理间隔（毫秒）- 10分钟 */
  PENDING_CHANGES_CLEANUP_INTERVAL: 10 * 60 * 1000,
} as const;

/**
 * 乐观更新配置
 * 快照管理配置（已移除临时 ID 相关配置 - 使用客户端 UUID）
 */
export const OPTIMISTIC_CONFIG = {
  /** 快照最大保留时间（毫秒）- 5 分钟 */
  SNAPSHOT_MAX_AGE_MS: 5 * 60 * 1000,
  /** 最大快照数量 */
  MAX_SNAPSHOTS: 20,
  /** 清理检查间隔（毫秒） */
  CLEANUP_INTERVAL_MS: 60 * 1000,
} as const;

/**
 * 队列配置
 */
export const QUEUE_CONFIG = {
  /** 重试基础延迟（毫秒） */
  RETRY_BASE_DELAY: 1000,
  /** 无处理器超时时间（毫秒）- 5分钟 */
  NO_PROCESSOR_TIMEOUT: 5 * 60 * 1000,
} as const;

/**
 * 权限拒绝处理配置
 * 【v5.8】RLS 权限拒绝时数据保全机制
 * 
 * 场景：用户离线编辑 → 管理员撤销权限 → 重连时同步被 401/403 拒绝
 * 问题：被拒数据直接丢弃，用户无法恢复
 * 解决：隔离被拒数据到 IndexedDB，提供复制/导出/放弃选项
 * 
 * @reserved 预留的权限拒绝处理配置
 */
export const PERMISSION_DENIED_CONFIG = {
  /** 
   * 权限拒绝时的数据处理策略
   * - 'discard': 直接丢弃（旧方案，不推荐）
   * - 'download-and-discard': 触发紧急下载，然后丢弃（用户有备份）
   * - 'isolate-and-notify': 隔离到 IndexedDB，提供恢复选项（推荐）
   */
  ON_PERMISSION_DENIED: 'isolate-and-notify' as const,
  
  /** 隔离数据存储 key（用于 IndexedDB） */
  REJECTED_DATA_STORAGE_KEY: 'nanoflow.rejected-data',
  
  /** 隔离数据保留时间（毫秒）- 7 天 */
  REJECTED_DATA_RETENTION: 7 * 24 * 60 * 60 * 1000,
  
  /** 最大可隔离数据大小（字节）- 超过则强制下载 */
  MAX_ISOLATE_SIZE: 10 * 1024 * 1024, // 10MB（IndexedDB 容量充足）
  
  /** 是否在权限拒绝时触发紧急导出 */
  TRIGGER_EMERGENCY_EXPORT: true,
  
  /** 权限拒绝错误代码列表 */
  PERMISSION_DENIED_CODES: ['403', '401', 'PGRST403', 'PGRST401'] as readonly string[],
} as const;

/**
 * 【v5.9】存储配额配置
 * 用于监控和保护本地存储空间
 * 
 * @reserved 预留的存储配额监控配置
 */
export const STORAGE_QUOTA_CONFIG = {
  /** localStorage 警告阈值（字节）- 4MB（通常配额 5-10MB） */
  LOCALSTORAGE_WARNING_THRESHOLD: 4 * 1024 * 1024,
  
  /** localStorage 危险阈值（字节）- 4.5MB */
  LOCALSTORAGE_CRITICAL_THRESHOLD: 4.5 * 1024 * 1024,
  
  /** IndexedDB 警告阈值（字节）- 40MB（通常配额 50MB+） */
  INDEXEDDB_WARNING_THRESHOLD: 40 * 1024 * 1024,
  
  /** IndexedDB 危险阈值（字节）- 45MB */
  INDEXEDDB_CRITICAL_THRESHOLD: 45 * 1024 * 1024,
  
  /** 配额检查间隔（毫秒）- 5 分钟 */
  CHECK_INTERVAL: 5 * 60 * 1000,
  
  /** 是否在启动时自动检查 */
  CHECK_ON_STARTUP: true,
  
  /** 配额警告 Toast 显示间隔（毫秒）- 1 小时（避免频繁打扰） */
  WARNING_COOLDOWN: 60 * 60 * 1000,
  
  /** 需要保留的最小可用空间（字节）- 500KB */
  MIN_FREE_SPACE: 500 * 1024,
} as const;

/**
 * IndexedDB 损坏恢复策略类型
 */
export type CorruptionRecoveryStrategy = 'auto-cloud' | 'prompt-recovery' | 'notify-only';

/**
 * 【v5.10】IndexedDB 健康检查配置
 * 检测和恢复 IndexedDB 损坏问题
 * 
 * @reserved 预留的 IndexedDB 健康检查配置
 */
export const INDEXEDDB_HEALTH_CONFIG = {
  /** 初始化时检测数据库健康 */
  CHECK_ON_INIT: true,
  
  /** 启动时数据完整性校验 */
  STARTUP_INTEGRITY_CHECK: {
    ENABLED: true,
    /** 抽样校验的记录数量 */
    SAMPLE_SIZE: 10,
    /** 校验 JSON 解析 */
    CHECK_JSON_PARSE: true,
    /** 校验必填字段 */
    CHECK_REQUIRED_FIELDS: true,
    /** 校验校验和（性能开销较大，默认关闭） */
    CHECK_CHECKSUM: false,
  },
  
  /** 损坏时的恢复策略 */
  ON_CORRUPTION: 'prompt-recovery' as CorruptionRecoveryStrategy,
  
  /** 定期健康检查间隔（毫秒）- 每 30 分钟 */
  PERIODIC_CHECK_INTERVAL: 30 * 60 * 1000,
  
  /** 任务必填字段 */
  REQUIRED_TASK_FIELDS: ['id', 'title'] as const,
  
  /** 项目必填字段 */
  REQUIRED_PROJECT_FIELDS: ['id', 'title'] as const,

  /** 连接必填字段 */
  REQUIRED_CONNECTION_FIELDS: ['id', 'source_id', 'target_id'] as const,
} as const;

/**
 * 并发编辑策略类型
 */
export type ConcurrentEditStrategy = 'block' | 'warn' | 'silent';

/**
 * 【v5.10】多标签页并发保护配置
 * 增强 TabSyncService 的编辑锁机制
 * 
 * @reserved 预留的多标签页并发控制配置
 */
export const TAB_CONCURRENCY_CONFIG = {
  /** 是否启用并发编辑检测 */
  DETECT_CONCURRENT_EDIT: true,
  
  /** 
   * 同一任务在多标签页编辑时的处理策略
   * - 'block': 阻止后来者编辑（最严格）
   * - 'warn': 警告但允许编辑（默认，平衡体验）
   * - 'silent': 静默允许（最宽松）
   */
  CONCURRENT_EDIT_STRATEGY: 'warn' as ConcurrentEditStrategy,
  
  /** 编辑锁超时时间（毫秒）- 30 秒无操作自动释放 */
  EDIT_LOCK_TIMEOUT: 30000,
  
  /** 锁刷新间隔（毫秒）- 持续编辑时定期刷新锁 */
  LOCK_REFRESH_INTERVAL: 10000,
  
  /** 并发编辑警告冷却时间（毫秒）- 避免频繁提示 */
  WARNING_COOLDOWN: 30000,
} as const;

/**
 * 【Stingy Hoarder Protocol】移动端同步策略配置
 * 
 * 根据网络状况动态调整同步行为，最大化节省流量
 * 
 * @see docs/plan_save.md Phase 4.5
 * @reserved 预留的移动端同步策略配置
 */
export const MOBILE_SYNC_CONFIG = {
  /** 后台标签页暂停同步 */
  PAUSE_WHEN_BACKGROUND: true,
  
  /** 电池低于此百分比时减少同步频率 */
  LOW_BATTERY_THRESHOLD: 20,
  
  /** 低电量时同步间隔（毫秒）- 5 分钟 */
  LOW_BATTERY_SYNC_INTERVAL: 5 * 60 * 1000,
  
  /** 移动网络下禁止自动同步附件 */
  DISABLE_ATTACHMENT_SYNC_ON_CELLULAR: true,
  
  /** 移动网络下单次请求最大 payload（字节）- 50 KB */
  MAX_PAYLOAD_ON_CELLULAR: 50 * 1024,
  
  /** 启用请求合并（批量推送代替多次请求） */
  BATCH_REQUESTS: true,
  
  /** 批量请求最大等待时间（毫秒）- 5 秒 */
  BATCH_WAIT_MS: 5000,
  
  /** 弱网时请求超时（毫秒）- 45 秒 */
  WEAK_NETWORK_TIMEOUT: 45000,
  
  /** 弱网重试次数 */
  WEAK_NETWORK_RETRIES: 2,
  
  /** Data Saver 模式下禁用 Realtime */
  DISABLE_REALTIME_ON_DATA_SAVER: true,
  
  /** 
   * 网络质量阈值配置
   * - high: WiFi/4G，正常同步
   * - medium: 3G，延迟同步
   * - low: 2G/弱网，仅手动同步
   */
  NETWORK_QUALITY_THRESHOLDS: {
    /** effective type 为 '4g' 视为 high */
    HIGH: ['4g', 'wifi'] as readonly string[],
    /** effective type 为 '3g' 视为 medium */
    MEDIUM: ['3g'] as readonly string[],
    /** effective type 为 '2g', 'slow-2g' 视为 low */
    LOW: ['2g', 'slow-2g'] as readonly string[],
  },
  
  /** medium 网络质量时的同步延迟（毫秒）- 30 秒 */
  MEDIUM_QUALITY_SYNC_DELAY: 30000,
  
  /** low 网络质量时完全禁用自动同步 */
  DISABLE_AUTO_SYNC_ON_LOW_QUALITY: true,
} as const;
