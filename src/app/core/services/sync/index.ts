/**
 * Sync Services - 同步服务模块
 * 
 * Sprint 3-9 技术债务修复：从 SimpleSyncService 拆分的专注服务
 * 
 * 服务列表：
 * - SyncStateService: 同步状态管理
 * - TombstoneService: 墓碑（软删除标记）管理
 * - RetryQueueService: 重试队列管理
 * - RealtimePollingService: 实时订阅与轮询管理 (Sprint 9)
 * - SessionManagerService: 会话管理 (Sprint 9)
 */

// 状态管理
export { SyncStateService } from './sync-state.service';
export type { SyncState, ConflictData } from './sync-state.service';

// 墓碑管理
export { TombstoneService } from './tombstone.service';

// 重试队列
export { RetryQueueService } from './retry-queue.service';
export type { RetryQueueItem, RetryableEntityType, RetryableOperation, RetryOperationHandler } from './retry-queue.service';

// 实时订阅与轮询 (Sprint 9)
export { RealtimePollingService } from './realtime-polling.service';
export type { RemoteChangeCallback, UserPreferencesChangeCallback } from './realtime-polling.service';

// 会话管理 (Sprint 9)
export { SessionManagerService } from './session-manager.service';

// 同步操作辅助 (Sprint 9)
export { SyncOperationHelperService } from './sync-operation-helper.service';
export type { SyncOperationContext, SyncOperationOptions, SyncOperationResult } from './sync-operation-helper.service';

// 用户偏好同步 (Sprint 9)
export { UserPreferencesSyncService } from './user-preferences-sync.service';
export { FocusConsoleSyncService } from './focus-console-sync.service';

// 项目数据加载 (Sprint 9)
export { ProjectDataService } from './project-data.service';

// 批量同步 (Sprint 9)
export { BatchSyncService } from './batch-sync.service';
export type { BatchSyncResult, BatchSyncCallbacks } from './batch-sync.service';

// 任务同步操作 (技术债务重构)
export { TaskSyncOperationsService } from './task-sync-operations.service';
export type { TombstoneQueryResult } from './task-sync-operations.service';

// 连接同步操作 (技术债务重构)
export { ConnectionSyncOperationsService } from './connection-sync-operations.service';

// 连接恢复管理 (技术债务重构 2026-05-13)
export { ConnectivityRecoveryService } from './connectivity-recovery.service';
