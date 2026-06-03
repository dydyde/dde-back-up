/**
 * Supabase 数据库类型定义
 * 
 * 【重要】此文件是"数据库协议层"，直接映射数据库 Schema
 * - 字段命名使用 snake_case（与数据库一致）
 * - 仅 Service 层可以访问这些类型
 * - Component 层应该使用 src/models/index.ts 中的领域模型
 * 
 * 生成方式：基于 scripts/supabase-setup.sql 手动创建
 * 理想情况下应使用 `supabase gen types typescript` 自动生成
 * 
 * @see https://supabase.com/docs/reference/javascript/typescript-support
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

/**
 * Supabase 数据库 Schema 定义
 */
export interface Database {
  public: {
    Tables: {
      /** 项目表 */
      projects: {
        Row: ProjectRow;
        Insert: ProjectInsert;
        Update: ProjectUpdate;
      };
      /** 任务表 */
      tasks: {
        Row: TaskRow;
        Insert: TaskInsert;
        Update: TaskUpdate;
      };
      /** 连接表 */
      connections: {
        Row: ConnectionRow;
        Insert: ConnectionInsert;
        Update: ConnectionUpdate;
      };
      /** 用户偏好设置表 */
      user_preferences: {
        Row: UserPreferencesRow;
        Insert: UserPreferencesInsert;
        Update: UserPreferencesUpdate;
      };
      /** 项目成员表 */
      project_members: {
        Row: ProjectMemberRow;
        Insert: ProjectMemberInsert;
        Update: ProjectMemberUpdate;
      };
      /** 清理日志表 */
      cleanup_logs: {
        Row: CleanupLogRow;
        Insert: CleanupLogInsert;
        Update: never; // 日志表不支持更新
      };
      /** 任务墓碑表 - 记录已永久删除的任务 ID，防止已删除任务复活 */
      task_tombstones: {
        Row: TaskTombstoneRow;
        Insert: TaskTombstoneInsert;
        Update: never; // 墓碑记录不支持更新
      };
      /** 连接墓碑表 - 记录已永久删除的连接 ID，防止已删除连接复活 */
      connection_tombstones: {
        Row: ConnectionTombstoneRow;
        Insert: ConnectionTombstoneInsert;
        Update: never;
      };
      /** 黑匣子条目表 - 专注模式语音/文本记录 */
      black_box_entries: {
        Row: BlackBoxEntryRow;
        Insert: BlackBoxEntryInsert;
        Update: BlackBoxEntryUpdate;
      };
      /** 语音转写用量表 - 每用户每日配额追踪 */
      transcription_usage: {
        Row: TranscriptionUsageRow;
        Insert: TranscriptionUsageInsert;
        Update: TranscriptionUsageUpdate;
      };
      /** 附件扫描表 - 病毒扫描结果记录 */
      attachment_scans: {
        Row: AttachmentScanRow;
        Insert: AttachmentScanInsert;
        Update: AttachmentScanUpdate;
      };
      /** 隔离文件表 - 检测到威胁的文件 */
      quarantined_files: {
        Row: QuarantinedFileRow;
        Insert: QuarantinedFileInsert;
        Update: QuarantinedFileUpdate;
      };
      /** 熔断器日志表 */
      circuit_breaker_logs: {
        Row: CircuitBreakerLogRow;
        Insert: CircuitBreakerLogInsert;
        Update: never;
      };
      /** 清除操作限流表 */
      purge_rate_limits: {
        Row: PurgeRateLimitRow;
        Insert: PurgeRateLimitInsert;
        Update: PurgeRateLimitUpdate;
      };
      /** 应用配置表 - 全局键值对 */
      app_config: {
        Row: AppConfigRow;
        Insert: AppConfigInsert;
        Update: AppConfigUpdate;
      };
      /** 专注会话快照表 - Focus Console v3 */
      focus_sessions: {
        Row: FocusSessionRow;
        Insert: FocusSessionInsert;
        Update: FocusSessionUpdate;
      };
      /** 日常任务表 - Focus Console v3 */
      routine_tasks: {
        Row: RoutineTaskRow;
        Insert: RoutineTaskInsert;
        Update: RoutineTaskUpdate;
      };
      /** 日常任务完成记录表 - Focus Console v3 */
      routine_completions: {
        Row: RoutineCompletionRow;
        Insert: RoutineCompletionInsert;
        Update: RoutineCompletionUpdate;
      };
      /** 日常任务完成事件表 - Focus Console v3 */
      routine_completion_events: {
        Row: RoutineCompletionEventRow;
        Insert: RoutineCompletionEventInsert;
        Update: RoutineCompletionEventUpdate;
      };
      /** Widget 设备绑定表 */
      widget_devices: {
        Row: WidgetDeviceRow;
        Insert: WidgetDeviceInsert;
        Update: WidgetDeviceUpdate;
      };
      /** Widget 实例元数据表 */
      widget_instances: {
        Row: WidgetInstanceRow;
        Insert: WidgetInstanceInsert;
        Update: WidgetInstanceUpdate;
      };
      /** Widget 请求限流表 */
      widget_request_rate_limits: {
        Row: WidgetRequestRateLimitRow;
        Insert: WidgetRequestRateLimitInsert;
        Update: WidgetRequestRateLimitUpdate;
      };
      /** Widget Webhook 去重事件表 */
      widget_notify_events: {
        Row: WidgetNotifyEventRow;
        Insert: WidgetNotifyEventInsert;
        Update: WidgetNotifyEventUpdate;
      };
      /** Widget 推送节流表 */
      widget_notify_throttle: {
        Row: WidgetNotifyThrottleRow;
        Insert: WidgetNotifyThrottleInsert;
        Update: WidgetNotifyThrottleUpdate;
      };
    };
    Views: {
      /** 活跃任务视图（排除软删除） */
      active_tasks: {
        Row: TaskRow;
      };
      /** 活跃连接视图（排除软删除） */
      active_connections: {
        Row: ConnectionRow;
      };
    };
    Functions: {
      cleanup_old_deleted_tasks: {
        Args: Record<string, never>;
        Returns: number;
      };
      cleanup_old_logs: {
        Args: Record<string, never>;
        Returns: number;
      };
      cleanup_old_deleted_connections: {
        Args: Record<string, never>;
        Returns: number;
      };
      cleanup_expired_scan_records: {
        Args: Record<string, never>;
        Returns: number;
      };
      cleanup_deleted_attachments: {
        Args: { retention_days?: number };
        Returns: { deleted_count: number; storage_paths: string[] }[];
      };
      /** 原子递增日常任务完成计数 */
      increment_routine_completion: {
        Args: {
          p_completion_id: string;
          p_routine_id: string;
          p_date_key: string;
        };
        Returns: number;
      };
      /** 获取完整项目数据（任务 + 连接） */
      get_full_project_data: {
        Args: { p_project_id: string };
        Returns: Json;
      };
      /** 获取单项目聚合同步水位 */
      get_project_sync_watermark: {
        Args: { p_project_id: string };
        Returns: string | null;
      };
      /** 获取当前项目访问性 + 项目域聚合水位 */
      get_accessible_project_probe: {
        Args: { p_project_id: string };
        Returns: {
          project_id: string;
          accessible: boolean;
          watermark: string | null;
        }[];
      };
      /** 恢复链路聚合探测（activeProject + 项目/黑匣子水位） */
      get_resume_recovery_probe: {
        Args: { p_project_id?: string | null };
        Returns: {
          active_project_id: string | null;
          active_accessible: boolean;
          active_watermark: string | null;
          projects_watermark: string | null;
          blackbox_watermark: string | null;
          server_now: string | null;
        }[];
      };
      /** 获取黑匣子域聚合水位 */
      get_black_box_sync_watermark: {
        Args: Record<string, never>;
        Returns: string | null;
      };
      /** 获取当前用户项目域聚合水位 */
      get_user_projects_watermark: {
        Args: Record<string, never>;
        Returns: string | null;
      };
      /** 获取用户项目元数据（增量同步） */
      get_user_projects_meta: {
        Args: { p_since_timestamp?: string };
        Returns: Json;
      };
      /** 列出指定水位后的项目头变更 */
      list_project_heads_since: {
        Args: { p_since?: string | null };
        Returns: { project_id: string; updated_at: string; version: number }[];
      };
      /** 获取服务器时间（时钟同步） */
      get_server_time: {
        Args: Record<string, never>;
        Returns: string;
      };
      /** 获取仪表盘统计数据 */
      get_dashboard_stats: {
        Args: Record<string, never>;
        Returns: Json;
      };
      /** 获取当前用户 ID */
      current_user_id: {
        Args: Record<string, never>;
        Returns: string;
      };
      /** 批量更新/插入任务 */
      batch_upsert_tasks: {
        Args: { p_project_id: string; p_tasks: Json[] };
        Returns: number;
      };
      /** 追加任务附件 */
      append_task_attachment: {
        Args: { p_attachment: Json; p_task_id: string };
        Returns: boolean;
      };
      /** 移除任务附件 */
      remove_task_attachment: {
        Args: { p_attachment_id: string; p_task_id: string };
        Returns: boolean;
      };
      /** 安全删除任务（软删除 + tombstone） */
      safe_delete_tasks: {
        Args: { p_project_id: string; p_task_ids: string[] };
        Returns: number;
      };
      /** 安全软删除项目（owner-only, idempotent） */
      soft_delete_project: {
        Args: { p_project_id: string };
        Returns: boolean;
      };
      /** 永久清除任务 v1 */
      purge_tasks: {
        Args: { p_task_ids: string[] };
        Returns: number;
      };
      /** 永久清除任务 v2（带项目校验） */
      purge_tasks_v2: {
        Args: { p_project_id: string; p_task_ids: string[] };
        Returns: number;
      };
      /** 永久清除任务 v3（返回附件路径） */
      purge_tasks_v3: {
        Args: { p_project_id: string; p_task_ids: string[] };
        Returns: PurgeResult;
      };
      /** 检查任务是否已被墓碑化 */
      is_task_tombstoned: {
        Args: { p_task_id: string };
        Returns: boolean;
      };
      /** 检查连接是否已被墓碑化 */
      is_connection_tombstoned: {
        Args: { p_connection_id: string };
        Returns: boolean;
      };
      /** 检查用户是否为项目所有者 */
      user_is_project_owner: {
        Args: { p_project_id: string };
        Returns: boolean;
      };
      /** 检查用户是否有项目访问权限 */
      user_has_project_access: {
        Args: { p_project_id: string };
        Returns: boolean;
      };
      /** 获取用户可访问的项目 ID 列表 */
      user_accessible_project_ids: {
        Args: Record<string, never>;
        Returns: string[];
      };
      /** Widget 公网摘要接口三维限流 */
      consume_widget_rate_limit: {
        Args: {
          p_scope_type: string;
          p_scope_key: string;
          p_max_calls: number;
          p_window_seconds?: number;
          p_block_seconds?: number;
        };
        Returns: {
          allowed: boolean;
          retry_after_seconds: number;
          remaining_calls: number;
        }[];
      };
      /** 迁移单个项目到 v2 */
      migrate_project_data_to_v2: {
        Args: { p_project_id: string };
        Returns: { tasks_migrated: number; connections_migrated: number; errors: string[] }[];
      };
      /** 迁移所有项目到 v2 */
      migrate_all_projects_to_v2: {
        Args: Record<string, never>;
        Returns: { project_id: string; project_title: string; tasks_migrated: number; connections_migrated: number; errors: string[] }[];
      };
    };
    CompositeTypes: {
      purge_result: PurgeResult;
    };
  };
}

// ============================================
// Row / Insert / Update interfaces below use snake_case field names
// intentionally — they mirror the Supabase (PostgreSQL) column names
// so that the types stay 1-to-1 with the database schema.
// ============================================

// ============================================
// 项目表 (projects)
// ============================================

/** 项目行数据（SELECT 返回） */
export interface ProjectRow {
  id: string;
  owner_id: string;
  title: string | null;
  description: string | null;
  created_date: string | null;
  updated_at: string | null;
  deleted_at: string | null;
  version: number;
  /** @deprecated v1 格式，新数据使用 tasks/connections 独立表 */
  data: Json | null;
  /** 是否已迁移到 v2 独立表 */
  migrated_to_v2: boolean;
}

/** 项目插入数据 */
export interface ProjectInsert {
  id?: string;
  owner_id: string;
  title?: string | null;
  description?: string | null;
  created_date?: string | null;
  deleted_at?: string | null;
  version?: number;
  data?: Json | null;
  migrated_to_v2?: boolean;
}

/** 项目更新数据 */
export interface ProjectUpdate {
  title?: string | null;
  description?: string | null;
  deleted_at?: string | null;
  version?: number;
  data?: Json | null;
  migrated_to_v2?: boolean;
}

// ============================================
// 任务表 (tasks)
// ============================================

/** 任务状态枚举 */
export type TaskStatusDb = 'active' | 'completed' | 'archived';

/** 任务优先级枚举 */
export type TaskPriorityDb = 'low' | 'medium' | 'high' | 'urgent' | null;

/** 任务行数据（SELECT 返回） */
export interface TaskRow {
  id: string;
  project_id: string;
  parent_id: string | null;
  title: string;
  content: string | null;
  stage: number | null;
  order: number;
  rank: number;
  status: TaskStatusDb;
  x: number;
  y: number;
  short_id: string | null;
  priority: TaskPriorityDb;
  due_date: string | null;
  expected_minutes: number | null;
  cognitive_load: 'high' | 'low' | null;
  wait_minutes: number | null;
  tags: Json;
  attachments: Json;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  /** State Overlap 停泊元数据（JSONB），NULL 表示非停泊任务 */
  parking_meta: import('./parking').TaskParkingMeta | null;
}

/** 任务插入数据 */
export interface TaskInsert {
  id?: string;
  project_id: string;
  parent_id?: string | null;
  title: string;
  content?: string | null;
  stage?: number | null;
  order?: number;
  rank?: number;
  status?: TaskStatusDb;
  x?: number;
  y?: number;
  short_id?: string | null;
  priority?: TaskPriorityDb;
  due_date?: string | null;
  expected_minutes?: number | null;
  cognitive_load?: 'high' | 'low' | null;
  wait_minutes?: number | null;
  tags?: Json;
  attachments?: Json;
  deleted_at?: string | null;
  completed_at?: string | null;
  /** State Overlap 停泊元数据 */
  parking_meta?: import('./parking').TaskParkingMeta | null;
}

/** 任务更新数据 */
export interface TaskUpdate {
  parent_id?: string | null;
  title?: string;
  content?: string | null;
  stage?: number | null;
  order?: number;
  rank?: number;
  status?: TaskStatusDb;
  x?: number;
  y?: number;
  short_id?: string | null;
  priority?: TaskPriorityDb;
  due_date?: string | null;
  expected_minutes?: number | null;
  cognitive_load?: 'high' | 'low' | null;
  wait_minutes?: number | null;
  tags?: Json;
  attachments?: Json;
  deleted_at?: string | null;
  completed_at?: string | null;
  /** State Overlap 停泊元数据 */
  parking_meta?: import('./parking').TaskParkingMeta | null;
}

// ============================================
// 连接表 (connections)
// ============================================

/** 连接行数据（SELECT 返回） */
export interface ConnectionRow {
  id: string;
  project_id: string;
  source_id: string;
  target_id: string;
  /** 联系块标题（外显内容） */
  title: string | null;
  /** 联系块详细描述 */
  description: string | null;
  created_at: string;
  updated_at: string;
  /** 软删除时间戳，存在表示已标记删除 */
  deleted_at: string | null;
}

/** 连接插入数据 */
export interface ConnectionInsert {
  id?: string;
  project_id: string;
  source_id: string;
  target_id: string;
  title?: string | null;
  description?: string | null;
  deleted_at?: string | null;
}

/** 连接更新数据 */
export interface ConnectionUpdate {
  title?: string | null;
  description?: string | null;
  deleted_at?: string | null;
}

// ============================================
// 用户偏好设置表 (user_preferences)
// ============================================

/** 主题类型（数据库） */
export type ThemeTypeDb = 'default' | 'ocean' | 'forest' | 'sunset' | 'lavender';

/** 布局方向（数据库） */
export type LayoutDirectionDb = 'ltr' | 'rtl';

/** 浮动窗口偏好（数据库） */
export type FloatingWindowPrefDb = 'auto' | 'fixed';

/** 用户偏好设置行数据 */
export interface UserPreferencesRow {
  id: string;
  user_id: string;
  theme: ThemeTypeDb | null;
  layout_direction: LayoutDirectionDb | null;
  floating_window_pref: FloatingWindowPrefDb | null;
  /** 颜色模式：light/dark/system */
  color_mode: string | null;
  /** 自动解决冲突开关 */
  auto_resolve_conflicts: boolean | null;
  /** 本地自动备份开关 */
  local_backup_enabled: boolean | null;
  /** 本地自动备份间隔（毫秒） */
  local_backup_interval_ms: number | null;
  /** 专注模式偏好（JSONB） */
  focus_preferences: Json | null;
  /** 停泊坞快照（JSONB） */
  dock_snapshot: Json | null;
  created_at: string;
  updated_at: string;
}

/** 用户偏好设置插入数据 */
export interface UserPreferencesInsert {
  id?: string;
  user_id: string;
  theme?: string | null;
  layout_direction?: string | null;
  floating_window_pref?: string | null;
  color_mode?: string | null;
  auto_resolve_conflicts?: boolean | null;
  local_backup_enabled?: boolean | null;
  local_backup_interval_ms?: number | null;
  focus_preferences?: Json | null;
  dock_snapshot?: Json | null;
}

/** 用户偏好设置更新数据 */
export interface UserPreferencesUpdate {
  theme?: string | null;
  layout_direction?: string | null;
  floating_window_pref?: string | null;
  color_mode?: string | null;
  auto_resolve_conflicts?: boolean | null;
  local_backup_enabled?: boolean | null;
  local_backup_interval_ms?: number | null;
  focus_preferences?: Json | null;
  dock_snapshot?: Json | null;
}

// ============================================
// 项目成员表 (project_members)
// ============================================

/** 成员角色枚举 */
export type MemberRoleDb = 'viewer' | 'editor' | 'admin';

/** 项目成员行数据 */
export interface ProjectMemberRow {
  id: string;
  project_id: string;
  user_id: string;
  role: MemberRoleDb;
  invited_by: string | null;
  invited_at: string | null;
  accepted_at: string | null;
}

/** 项目成员插入数据 */
export interface ProjectMemberInsert {
  id?: string;
  project_id: string;
  user_id: string;
  role?: MemberRoleDb;
  invited_by?: string | null;
}

/** 项目成员更新数据 */
export interface ProjectMemberUpdate {
  role?: MemberRoleDb;
  accepted_at?: string | null;
}

// ============================================
// 清理日志表 (cleanup_logs)
// ============================================

/** 清理日志行数据 */
export interface CleanupLogRow {
  id: string;
  type: string;
  details: Json;
  created_at: string;
}

/** 清理日志插入数据 */
export interface CleanupLogInsert {
  id?: string;
  type: string;
  details?: Json;
}

// ============================================
// 任务墓碑表 (task_tombstones)
// ============================================

/**
 * 任务墓碑行数据
 * 记录已被永久删除的任务 ID，防止已删除任务在同步时复活
 */
export interface TaskTombstoneRow {
  task_id: string;
  project_id: string;
  deleted_at: string;
  deleted_by: string | null;
}

/** 任务墓碑插入数据 */
export interface TaskTombstoneInsert {
  task_id: string;
  project_id: string;
  deleted_at?: string;
  deleted_by?: string | null;
}

// ============================================
// 连接墓碑表 (connection_tombstones)
// ============================================

/** 连接墓碑行数据 */
export interface ConnectionTombstoneRow {
  connection_id: string;
  project_id: string;
  deleted_at: string;
  deleted_by: string | null;
}

/** 连接墓碑插入数据 */
export interface ConnectionTombstoneInsert {
  connection_id: string;
  project_id: string;
  deleted_at?: string;
  deleted_by?: string | null;
}

// ============================================
// 黑匣子条目表 (black_box_entries)
// ============================================

/** 黑匣子条目行数据 */
export interface BlackBoxEntryRow {
  id: string;
  project_id: string | null;
  user_id: string | null;
  content: string;
  focus_meta: Json | null;
  date: string;
  created_at: string | null;
  updated_at: string | null;
  completed_at: string | null;
  is_read: boolean | null;
  is_completed: boolean | null;
  is_archived: boolean | null;
  snooze_until: string | null;
  snooze_count: number | null;
  deleted_at: string | null;
}

/** 黑匣子条目插入数据 */
export interface BlackBoxEntryInsert {
  id: string;
  content: string;
  focus_meta?: Json | null;
  date?: string;
  project_id?: string | null;
  user_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  completed_at?: string | null;
  is_read?: boolean | null;
  is_completed?: boolean | null;
  is_archived?: boolean | null;
  snooze_until?: string | null;
  snooze_count?: number | null;
  deleted_at?: string | null;
}

/** 黑匣子条目更新数据 */
export interface BlackBoxEntryUpdate {
  content?: string;
  focus_meta?: Json | null;
  date?: string;
  project_id?: string | null;
  is_read?: boolean | null;
  is_completed?: boolean | null;
  is_archived?: boolean | null;
  snooze_until?: string | null;
  snooze_count?: number | null;
  deleted_at?: string | null;
  updated_at?: string | null;
  completed_at?: string | null;
}

// ============================================
// 语音转写用量表 (transcription_usage)
// ============================================

/** 语音转写用量行数据 */
export interface TranscriptionUsageRow {
  id: string;
  user_id: string | null;
  date: string;
  audio_seconds: number | null;
  created_at: string | null;
}

/** 语音转写用量插入数据 */
export interface TranscriptionUsageInsert {
  id: string;
  user_id?: string | null;
  date?: string;
  audio_seconds?: number | null;
  created_at?: string | null;
}

/** 语音转写用量更新数据 */
export interface TranscriptionUsageUpdate {
  audio_seconds?: number | null;
  date?: string;
  user_id?: string | null;
}

// ============================================
// 附件扫描表 (attachment_scans)
// ============================================

/** 附件扫描行数据 */
export interface AttachmentScanRow {
  id: string;
  file_id: string;
  scanner: string;
  status: string;
  threat_name: string | null;
  threat_description: string | null;
  error_message: string | null;
  file_hash: string | null;
  engine_version: string | null;
  signature_version: string | null;
  scanned_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/** 附件扫描插入数据 */
export interface AttachmentScanInsert {
  file_id: string;
  id?: string;
  scanner?: string;
  status?: string;
  threat_name?: string | null;
  threat_description?: string | null;
  error_message?: string | null;
  file_hash?: string | null;
  engine_version?: string | null;
  signature_version?: string | null;
  scanned_at?: string | null;
}

/** 附件扫描更新数据 */
export interface AttachmentScanUpdate {
  scanner?: string;
  status?: string;
  threat_name?: string | null;
  threat_description?: string | null;
  error_message?: string | null;
  file_hash?: string | null;
  engine_version?: string | null;
  signature_version?: string | null;
  scanned_at?: string | null;
}

// ============================================
// 隔离文件表 (quarantined_files)
// ============================================

/** 隔离文件行数据 */
export interface QuarantinedFileRow {
  id: string;
  original_file_id: string;
  storage_path: string;
  threat_name: string;
  threat_description: string | null;
  quarantined_by: string | null;
  quarantined_at: string | null;
  expires_at: string | null;
  restored: boolean | null;
  restored_at: string | null;
  notes: string | null;
}

/** 隔离文件插入数据 */
export interface QuarantinedFileInsert {
  original_file_id: string;
  storage_path: string;
  threat_name: string;
  id?: string;
  threat_description?: string | null;
  quarantined_by?: string | null;
  quarantined_at?: string | null;
  expires_at?: string | null;
  restored?: boolean | null;
  notes?: string | null;
}

/** 隔离文件更新数据 */
export interface QuarantinedFileUpdate {
  restored?: boolean | null;
  restored_at?: string | null;
  notes?: string | null;
  expires_at?: string | null;
}

// ============================================
// 熔断器日志表 (circuit_breaker_logs)
// ============================================

/** 熔断器日志行数据 */
export interface CircuitBreakerLogRow {
  id: string;
  user_id: string;
  operation: string;
  blocked: boolean;
  reason: string | null;
  details: Json | null;
  created_at: string;
}

/** 熔断器日志插入数据 */
export interface CircuitBreakerLogInsert {
  user_id: string;
  operation: string;
  id?: string;
  blocked?: boolean;
  reason?: string | null;
  details?: Json | null;
}

// ============================================
// 清除操作限流表 (purge_rate_limits)
// ============================================

/** 清除限流行数据 */
export interface PurgeRateLimitRow {
  user_id: string;
  call_count: number | null;
  window_start: string | null;
}

/** 清除限流插入数据 */
export interface PurgeRateLimitInsert {
  user_id: string;
  call_count?: number | null;
  window_start?: string | null;
}

/** 清除限流更新数据 */
export interface PurgeRateLimitUpdate {
  call_count?: number | null;
  window_start?: string | null;
}

// ============================================
// 应用配置表 (app_config)
// ============================================

/** 应用配置行数据 */
export interface AppConfigRow {
  key: string;
  value: Json;
  description: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/** 应用配置插入数据 */
export interface AppConfigInsert {
  key: string;
  value: Json;
  description?: string | null;
}

/** 应用配置更新数据 */
export interface AppConfigUpdate {
  value?: Json;
  description?: string | null;
}

// ============================================
// 复合类型 (Composite Types)
// ============================================

/** 清除操作结果 */
export interface PurgeResult {
  purged_count: number | null;
  attachment_paths: string[] | null;
}

// ============================================
// 专注会话快照表 (focus_sessions) - Focus Console v3
// ============================================

/** 专注会话行数据 */
export interface FocusSessionRow {
  id: string;
  user_id: string;
  started_at: string;
  ended_at: string | null;
  session_state: Json;
  updated_at: string;
}

/** 专注会话插入数据 */
export interface FocusSessionInsert {
  id: string;
  user_id: string;
  started_at: string;
  ended_at?: string | null;
  session_state: Json;
  updated_at?: string;
}

/** 专注会话更新数据 */
export interface FocusSessionUpdate {
  ended_at?: string | null;
  session_state?: Json;
  started_at?: string;
}

// ============================================
// 日常任务表 (routine_tasks) - Focus Console v3
// ============================================

/** 日常任务行数据 */
export interface RoutineTaskRow {
  id: string;
  user_id: string;
  title: string;
  max_times_per_day: number;
  is_enabled: boolean;
  created_at: string;
  updated_at: string;
}

/** 日常任务插入数据 */
export interface RoutineTaskInsert {
  id: string;
  user_id: string;
  title: string;
  max_times_per_day?: number;
  is_enabled?: boolean;
}

/** 日常任务更新数据 */
export interface RoutineTaskUpdate {
  title?: string;
  max_times_per_day?: number;
  is_enabled?: boolean;
}

// ============================================
// 日常任务完成记录表 (routine_completions) - Focus Console v3
// ============================================

/** 日常任务完成记录行数据 */
export interface RoutineCompletionRow {
  id: string;
  routine_id: string;
  user_id: string;
  date_key: string;
  count: number;
  updated_at: string;
}

/** 日常任务完成记录插入数据 */
export interface RoutineCompletionInsert {
  id: string;
  routine_id: string;
  user_id: string;
  date_key: string;
  count?: number;
}

/** 日常任务完成记录更新数据 */
export interface RoutineCompletionUpdate {
  count?: number;
  date_key?: string;
}

/** 日常任务完成事件行数据 */
export interface RoutineCompletionEventRow {
  id: string;
  routine_id: string;
  user_id: string;
  date_key: string;
  created_at: string;
}

/** 日常任务完成事件插入数据 */
export interface RoutineCompletionEventInsert {
  id: string;
  routine_id: string;
  user_id: string;
  date_key: string;
  created_at?: string;
}

/** 日常任务完成事件更新数据 */
export interface RoutineCompletionEventUpdate {
  date_key?: string;
  created_at?: string;
}

// ============================================
// Widget 设备绑定表 (widget_devices)
// ============================================

export interface WidgetDeviceRow {
  id: string;
  user_id: string;
  platform: string;
  installation_id: string;
  push_token: string | null;
  push_token_updated_at: string | null;
  secret_hash: string;
  token_hash: string | null;
  capabilities: Json;
  binding_generation: number;
  expires_at: string;
  last_seen_at: string;
  last_bound_user_hash: string;
  revoked_at: string | null;
  revoke_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface WidgetDeviceInsert {
  id: string;
  user_id: string;
  platform: string;
  installation_id: string;
  secret_hash: string;
  token_hash?: string | null;
  expires_at: string;
  last_bound_user_hash: string;
  push_token?: string | null;
  push_token_updated_at?: string | null;
  capabilities?: Json;
  binding_generation?: number;
  last_seen_at?: string;
  revoked_at?: string | null;
  revoke_reason?: string | null;
}

export interface WidgetDeviceUpdate {
  user_id?: string;
  platform?: string;
  installation_id?: string;
  push_token?: string | null;
  push_token_updated_at?: string | null;
  secret_hash?: string;
  token_hash?: string | null;
  capabilities?: Json;
  binding_generation?: number;
  expires_at?: string;
  last_seen_at?: string;
  last_bound_user_hash?: string;
  revoked_at?: string | null;
  revoke_reason?: string | null;
}

// ============================================
// Widget 实例元数据表 (widget_instances)
// ============================================

export interface WidgetInstanceRow {
  id: string;
  device_id: string;
  user_id: string;
  platform: string;
  host_instance_id: string;
  size_bucket: string;
  config_scope: string;
  privacy_mode: string;
  binding_generation: number;
  installed_at: string;
  last_seen_at: string;
  uninstalled_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WidgetInstanceInsert {
  id: string;
  device_id: string;
  user_id: string;
  platform: string;
  host_instance_id: string;
  size_bucket: string;
  config_scope?: string;
  privacy_mode?: string;
  binding_generation?: number;
  installed_at?: string;
  last_seen_at?: string;
  uninstalled_at?: string | null;
}

export interface WidgetInstanceUpdate {
  device_id?: string;
  user_id?: string;
  platform?: string;
  host_instance_id?: string;
  size_bucket?: string;
  config_scope?: string;
  privacy_mode?: string;
  binding_generation?: number;
  installed_at?: string;
  last_seen_at?: string;
  uninstalled_at?: string | null;
}

// ============================================
// Widget 请求限流表 (widget_request_rate_limits)
// ============================================

export interface WidgetRequestRateLimitRow {
  scope_type: string;
  scope_key: string;
  call_count: number;
  window_start: string;
  blocked_until: string | null;
  last_decision: string;
  created_at: string;
  updated_at: string;
}

export interface WidgetRequestRateLimitInsert {
  scope_type: string;
  scope_key: string;
  call_count?: number;
  window_start?: string;
  blocked_until?: string | null;
  last_decision?: string;
}

export interface WidgetRequestRateLimitUpdate {
  call_count?: number;
  window_start?: string;
  blocked_until?: string | null;
  last_decision?: string;
}

// ============================================
// Widget Webhook 去重事件表 (widget_notify_events)
// ============================================

export interface WidgetNotifyEventRow {
  webhook_id: string;
  user_id: string | null;
  source_table: string;
  event_type: string;
  summary_cursor: string | null;
  last_status: string;
  processed_at: string;
  created_at: string;
  updated_at: string;
}

export interface WidgetNotifyEventInsert {
  webhook_id: string;
  event_type: string;
  source_table: string;
  user_id?: string | null;
  summary_cursor?: string | null;
  last_status?: string;
  processed_at?: string;
}

export interface WidgetNotifyEventUpdate {
  user_id?: string | null;
  source_table?: string;
  event_type?: string;
  summary_cursor?: string | null;
  last_status?: string;
  processed_at?: string;
}

// ============================================
// Widget 推送节流表 (widget_notify_throttle)
// ============================================

export interface WidgetNotifyThrottleRow {
  user_id: string;
  last_notified_at: string;
  last_summary_version: string | null;
  last_event_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface WidgetNotifyThrottleInsert {
  user_id: string;
  last_notified_at?: string;
  last_summary_version?: string | null;
  last_event_id?: string | null;
}

export interface WidgetNotifyThrottleUpdate {
  last_notified_at?: string;
  last_summary_version?: string | null;
  last_event_id?: string | null;
}
