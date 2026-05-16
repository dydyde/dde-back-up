// ============================================
// 配置导出中心
// 统一导出所有配置模块
// ============================================

// 布局配置
export {
  LAYOUT_CONFIG,
  FLOATING_TREE_CONFIG,
  GOJS_CONFIG,
  LETTERS,
  SUPERSCRIPT_DIGITS
} from './layout.config';

// 同步配置
export {
  SYNC_CONFIG,
  RECOVERABLE_SYNC_ERROR_MESSAGES,
  SYNC_DURABILITY_CONFIG,
  REQUEST_THROTTLE_CONFIG,
  CIRCUIT_BREAKER_CONFIG,
  CACHE_CONFIG,
  OPTIMISTIC_CONFIG,
  QUEUE_CONFIG,
  FIELD_SELECT_CONFIG,
  STORAGE_QUOTA_CONFIG,
  PERMISSION_DENIED_CONFIG,
  INDEXEDDB_HEALTH_CONFIG,
  TAB_CONCURRENCY_CONFIG,
  MOBILE_SYNC_CONFIG
} from './sync.config';
export type { ConcurrentEditStrategy } from './sync.config';

// UI 配置
export {
  UI_CONFIG,
  TOAST_CONFIG,
  FLOW_VIEW_CONFIG
} from './ui.config';

// 认证配置
export {
  AUTH_CONFIG,
  GUARD_CONFIG
} from './auth.config';

// 超时配置
export {
  TIMEOUT_CONFIG,
  RETRY_POLICY
} from './timeout.config';
export { BATCH_RETRY_BASE_MS, NETWORK_OFFLINE_DEBOUNCE_MS } from './timeout.config';
export type { TimeoutLevel } from './timeout.config';

// 附件配置
export {
  ATTACHMENT_CONFIG
} from './attachment.config';

// 任务配置
export {
  TRASH_CONFIG,
  UNDO_CONFIG
} from './task.config';

// 特性开关配置
export {
  FEATURE_FLAGS,
  isFeatureEnabled,
  validateCriticalFlags,
  type FeatureFlag
} from './feature-flags.config';

// Sentry 告警配置
export {
  SENTRY_EVENT_TYPES,
  SENTRY_ALERT_RULES,
  SENTRY_ALERT_CONFIG,
  ALERT_LEVELS,
  type SentryEventType,
  type AlertLevel
} from './sentry-alert.config';

// 病毒扫描配置
export {
  VIRUS_SCAN_CONFIG,
  SCAN_STATUS,
  TOCTOU_PROTECTION,
  type ScanStatus,
  type ScanResult,
  type AttachmentScanMetadata
} from './virus-scan.config';

// 本地备份配置
export {
  LOCAL_BACKUP_CONFIG,
  type LocalBackupResult,
  type DirectoryAuthResult,
  type LocalBackupStatus,
  type LocalBackupCompatibility
} from './local-backup.config';

// Focus Mode 配置
export {
  FOCUS_CONFIG
} from './focus.config';

// 移动端抽屉配置
export {
  DRAWER_CONFIG,
  type DrawerLayer,
  type DrawerStateChangeEvent
} from './drawer.config';

// State Overlap / Parking 配置
export {
  PARKING_CONFIG
} from './parking.config';

// 应用生命周期配置
export {
  APP_LIFECYCLE_CONFIG
} from './app-lifecycle.config';

// 启动性能配置
export {
  STARTUP_PERF_CONFIG
} from './startup-performance.config';

// 注意：flow-styles 不再通过 barrel 导出，避免首屏静态依赖误引入。
// 如需使用请直接从 `config/flow-styles` 导入。
