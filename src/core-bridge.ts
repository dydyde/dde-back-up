/**
 * Core Bridge - 核心层桥接
 *
 * 解决 src/services/ 层无法直接引用 src/app/core/ 层的架构限制。
 * 所有 src/services/ 需要使用的 core 层导出，统一从此文件导入。
 *
 * 规则：
 * - 仅放「被 src/services/ 实际依赖」的符号
 * - 不要放仅 app/core 内部使用的符号
 * - 新增导出时请附注使用方
 */

// SimpleSyncService — 被 9 个 services 使用
export { SimpleSyncService } from './app/core/services/simple-sync.service';
export type { ConflictData as SyncConflictData } from './app/core/services/sync/sync-state.service';

// RetryQueueService + RetryableEntityType — 被 sync-coordinator, action-queue 使用
export { RetryQueueService } from './app/core/services/sync/retry-queue.service';
export type { RetryableEntityType } from './app/core/services/sync/retry-queue.service';

// SessionManagerService — 被 app-lifecycle-orchestrator, event-driven-sync-pulse 使用
export { SessionManagerService } from './app/core/services/sync/session-manager.service';

// ProjectDataService — 被 parking 轻量停泊任务加载使用
export { ProjectDataService } from './app/core/services/sync/project-data.service';

// TombstoneService — 被 delta-sync-coordinator 使用
export { TombstoneService } from './app/core/services/sync/tombstone.service';

// IndexedDB — 被 indexeddb-health 使用
export { IndexedDBService, DB_CONFIG } from './app/core/state/persistence/indexeddb.service';

// Stores — 被 project-state 使用
export { TaskStore, ProjectStore, ConnectionStore } from './app/core/state/stores';
