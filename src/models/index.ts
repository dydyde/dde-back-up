// ============================================
// NanoFlow 数据模型定义
// ============================================

/**
 * Task status enum.
 */
export type TaskStatus = 'active' | 'completed' | 'archived';

/**
 * Attachment type enum.
 */
export type AttachmentType = 'image' | 'document' | 'link' | 'file';

/**
 * Attachment model.
 */
export interface Attachment {
  id: string;
  type: AttachmentType;
  name: string;
  url: string;
  thumbnailUrl?: string;
  mimeType?: string;
  size?: number;
  createdAt: string;
  signedAt?: string;
  deletedAt?: string;
}

/**
 * Task model.
 */
export interface Task {
  id: string;
  title: string;
  content: string;
  stage: number | null;
  parentId: string | null;
  order: number;
  rank: number;
  status: TaskStatus;
  x: number;
  y: number;
  createdDate: string;
  updatedAt?: string;
  /** 完成状态首次落地时间；用于历史沉积层稳定排序，避免被 updatedAt 后续编辑扰动 */
  completedAt?: string | null;
  displayId: string;
  shortId?: string;
  hasIncompleteTask?: boolean;
  deletedAt?: string | null;

  // Client-only restore metadata (not persisted as task columns).
  deletedConnections?: Connection[];
  deletedMeta?: {
    parentId: string | null;
    stage: number | null;
    order: number;
    rank: number;
    x: number;
    y: number;
    parkingMeta?: import('./parking').TaskParkingMeta | null;
  };

  attachments?: Attachment[];
  tags?: string[];
  priority?: 'low' | 'medium' | 'high' | 'urgent';

  dueDate?: string | null;

  // Dock planning attributes (nullable by design)
  expected_minutes?: number | null;
  cognitive_load?: 'high' | 'low' | null;
  wait_minutes?: number | null;

  // Dock/parking metadata for active task overlays.
  parkingMeta?: import('./parking').TaskParkingMeta | null;
}

/**
 * 连接模型（任务之间的关联） */
export interface Connection {
  /** 连接的唯一标识符（必需，用于同步和恢复）*/
  id: string;
  source: string;
  target: string;
  /** 联系块标题（外显内容，类似维基百科的预览标题）*/
  title?: string;
  /** 联系块详细描述（悬停/点击时显示） */
  description?: string;
  /** 软删除时间戳，存在表示已标记删除，等待恢复或永久删除 */
  deletedAt?: string | null;
  /** 最后更新时间戳 */
  updatedAt?: string;
}

/**
 * 项目模型
 */
export interface Project {
  id: string;
  name: string;
  description: string;
  createdDate: string;
  tasks: Task[];
  connections: Connection[];
  updatedAt?: string;
  deletedAt?: string | null;
  version?: number;
  /** Sync source marker for local-only vs cloud-linked project. */
  syncSource?: 'local-only' | 'synced';
  /** Whether there are unsynced local changes. */
  pendingSync?: boolean;
  viewState?: ViewState;
  flowchartUrl?: string;
  flowchartThumbnailUrl?: string;
}

/**
 * 视图状态（用于持久化流程图视口位置） */
export interface ViewState {
  scale: number; // 缩放比例
  positionX: number; // 视口 X 位置
  positionY: number; // 视口 Y 位置
}

/**
 * 未完成项目模型（待办事项） */
export interface UnfinishedItem {
  taskId: string;
  taskDisplayId: string;
  todoIndex: number;
  text: string;
}

/**
 * 用户偏好设置
 */
export interface UserPreferences {
  theme: ThemeType;
  /** 颜色模式（云端默认值，本地可覆盖） */
  colorMode?: ColorMode;
  layoutDirection: 'ltr' | 'rtl';
  floatingWindowPref: 'auto' | 'fixed';
  /** 
   * 自动解决冲突开关   * true: 使用 LWW (Last-Write-Wins) 自动解决冲突
   * false: 所有冲突进入仪表盘由用户手动处理   */
  autoResolveConflicts?: boolean;
  /**
   * 本地自动备份开关   * 仅同步开关状态，目录路径不同步（不同设备路径不同步   */
  localBackupEnabled?: boolean;
  /**
   * 本地自动备份间隔（毫秒）
   */
  localBackupIntervalMs?: number;
  /**
   * 最近一次成功备份 proof-of-life（跨设备同步，单调只增）
   */
  lastBackupProofAt?: string;
  /**
   * 专注模式偏好设置（跨设备同步）   */
  focusPreferences?: import('./focus').FocusPreferences;
  /**
   * 停泊坞 v3 快照（跨设备同步，全局资源池）
   */
  dockSnapshot?: import('./parking-dock').DockSnapshot;
}

/**
 * 主题类型（色调）
 */
export type ThemeType = 'default' | 'ocean' | 'forest' | 'sunset' | 'lavender';

/**
 * 颜色模式（明暗）
 * - light: 浅色模式
 * - dark: 深色模式  
 * - system: 跟随系统设置
 */
export type ColorMode = 'light' | 'dark' | 'system';

/**
 * 同步状态 */
export interface SyncState {
  isSyncing: boolean;
  isOnline: boolean;
  offlineMode: boolean;
  sessionExpired: boolean;
  syncError: string | null;
  hasConflict: boolean;
  conflictData: { 
    local: Project; 
    /** 冲突时的远程项目数据 */
    remote: Project;
    projectId: string;
  } | null;
}

/**
 * 撤销/重做操作类型
 */
export type UndoActionType = 
  | 'task-create'
  | 'task-delete'
  | 'task-update'
  | 'task-move'
  | 'task-park'
  | 'connection-create'
  | 'connection-delete'
  | 'connection-update'
  | 'project-update';

/**
 * 撤销/重做操作记录
 */
export interface UndoAction {
  type: UndoActionType;
  timestamp: number;
  projectId: string;
  /** 记录操作时的项目版本号，用于检测远程更新冲突 */
  projectVersion?: number;
  data: {
    before: Partial<Project>;
    after: Partial<Project>;
  };
}

// ============================================
// 同步相关类型定义
// ============================================

/**
 * 同步模式
 * - automatic: 自动模式 - 按间隔自动同步 * - manual: 手动模式 - 仅在用户手动触发或应用启动/退出时同步
 * - completely-manual: 完全手动模式 - 用户必须明确选择"上传"/"下载"
 */
export type SyncMode = 'automatic' | 'manual' | 'completely-manual';

// ============================================
// GoJS 边界类型导出
// ============================================
// 【性能优化 2026-02-07】移除 GoJS 相关 re-export，防止 GoJS 运行时代码进入主包

// ============================================
// 流程图视图状态导出
// 【注意】Wildcard re-exports 可能引发循环依赖。各模块不应反向 import 本 barrel，
// 而应直接 import 具体文件（如 './focus'、'./parking-dock'）。
export * from './flow-view-state';

// ============================================
// Focus Mode 类型导出
// ============================================
export * from './focus';

// ============================================
// State Overlap / Parking 类型导出
// ============================================
export * from './parking';

// ============================================
// 停泊坞 v2 — 主控台 + 雷达 + 状态机
// ============================================
export * from './parking-dock';
export * from './launch-shell';

// ============================================
// API 类型定义（边界防御）
// 注意：api-types.ts 中的类型当前未被使用
// 如需类型守卫功能，可从 './api-types' 直接导入
// ============================================

// ============================================
// Supabase 映射器（仅供 Service 层使用）
// ============================================
// 注意：supabase-mapper.ts 中的映射函数当前未被使用
// simple-sync.service.ts 有自己的私有 mapper 方法
// 如需统一映射逻辑，可从 './supabase-mapper' 直接导入
// supabase-types.ts 不在此处导出，应直接 import from './supabase-types'
