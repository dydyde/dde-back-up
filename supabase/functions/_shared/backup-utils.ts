/**
 * 备份系统共享模块
 * 包含备份数据结构、摘要校验与健康检查公共功能
 * 
 * 位置: supabase/functions/_shared/backup-utils.ts
 */

// ===========================================
// 类型定义
// ===========================================

/** 备份类型 */
export type BackupType = 'full' | 'incremental';

/** 备份数据结构 */
export interface BackupData {
  version: string;
  payloadVersion: string;
  type: BackupType;
  createdAt: string;
  checksum?: string;
  tableCounts: BackupTableCounts;
  coverage: BackupCoverage;
  projects: BackupProject[];
  tasks: BackupTask[];
  connections: BackupConnection[];
  attachments?: BackupAttachmentMeta[];
  /** 用户偏好设置（v1.1.0+） */
  userPreferences: BackupUserPreferences[];
  /** 黑匣子条目 - 专注模式数据（v1.1.0+） */
  blackBoxEntries: BackupBlackBoxEntry[];
  focusSessions: BackupFocusSession[];
  transcriptionUsage: BackupTranscriptionUsage[];
  routineTasks: BackupRoutineTask[];
  routineCompletions: BackupRoutineCompletion[];
  localState?: BackupLocalState;
}

export interface BackupTableCounts {
  projects: number;
  tasks: number;
  connections: number;
  userPreferences: number;
  blackBoxEntries: number;
  focusSessions: number;
  transcriptionUsage: number;
  routineTasks: number;
  routineCompletions: number;
}

export interface BackupCoverage {
  includesProjectData: boolean;
  includesCloudUserState: boolean;
  includesLocalState: boolean;
}

export interface BackupProject {
  id: string;
  userId: string;
  name: string;
  description?: string;
  createdAt?: string;
  updatedAt?: string;
  /** 数据版本号（乐观锁） */
  version?: number;
}

export interface BackupExternalSourceLink {
  id: string;
  sourceType: 'siyuan-block';
  targetId: string;
  uri: string;
  label?: string;
  hpath?: string;
  role?: 'context' | 'spec' | 'reference' | 'evidence' | 'next-action';
  sortOrder: number;
  deletedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BackupTask {
  id: string;
  projectId: string;
  title: string;
  content?: string;
  parentId?: string | null;
  stage?: number | null;
  order?: number;
  rank?: number;
  status?: string;
  x?: number;
  y?: number;
  displayId?: string;
  shortId?: string;
  attachments?: unknown[];
  /** 标签列表 */
  tags?: string[];
  /** 优先级 */
  priority?: string;
  /** 截止日期 */
  dueDate?: string | null;
  createdAt?: string;
  updatedAt?: string;
  deletedAt?: string | null;
  externalSourceLinks?: BackupExternalSourceLink[];
}

export interface BackupConnection {
  id: string;
  projectId: string;
  source: string;
  target: string;
  title?: string;
  description?: string;
  createdAt?: string;
  updatedAt?: string;
  deletedAt?: string | null;
}

export interface BackupAttachmentMeta {
  id: string;
  taskId: string;
  name: string;
  type: string;
  size: number;
  storagePath: string;
}

/** 用户偏好设置备份 */
export interface BackupUserPreferences {
  id: string;
  userId: string;
  theme?: string;
  layoutDirection?: string;
  floatingWindowPref?: string;
  colorMode?: string;
  autoResolveConflicts?: boolean;
  localBackupEnabled?: boolean;
  localBackupIntervalMs?: number;
  focusPreferences?: unknown;
  createdAt?: string;
  updatedAt?: string;
}

/** 黑匣子条目备份（专注模式） */
export interface BackupBlackBoxEntry {
  id: string;
  projectId?: string | null;
  userId?: string | null;
  content: string;
  date?: string;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string | null;
  isRead?: boolean;
  isCompleted?: boolean;
  isArchived?: boolean;
  snoozeUntil?: string | null;
  snoozeCount?: number;
  deletedAt?: string | null;
  focusMeta?: unknown;
}

export interface BackupFocusSession {
  id: string;
  userId: string;
  startedAt: string;
  endedAt?: string | null;
  sessionState: unknown;
  updatedAt?: string;
}

export interface BackupTranscriptionUsage {
  id: string;
  userId: string;
  date: string;
  audioSeconds: number;
  createdAt?: string;
}

export interface BackupRoutineTask {
  id: string;
  userId: string;
  title: string;
  maxTimesPerDay: number;
  isEnabled: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface BackupRoutineCompletion {
  id: string;
  routineId: string;
  userId: string;
  dateKey: string;
  count: number;
  updatedAt?: string;
}

export interface BackupLocalState {
  offlineSnapshot?: {
    localStorage?: string | null;
    indexedDb?: string | null;
  };
  dockSnapshot?: {
    localStorage?: string | null;
    indexedDb?: unknown | null;
  };
  launchSnapshot?: {
    v1?: string | null;
    v2?: string | null;
  };
  parkedTaskCache?: {
    entries: unknown[];
    syncMetadata: Record<string, unknown>;
  };
  retryQueue?: unknown[];
  actionQueue?: unknown;
  deadLetters?: unknown[];
  conflicts?: unknown[];
  taskTombstones?: unknown;
  connectionTombstones?: unknown;
  /**
   * 思源知识锚点尚未推送到 Supabase 的本机 pending 项。
   * 备份时一并打包，跨设备恢复后可继续 flushPendingLinks 完成同步。
   */
  externalSourcePendingLinks?: unknown[];
}

/** 健康校验结果 */
export interface BackupValidation {
  isJsonValid: boolean;
  hasRequiredTables: boolean;
  projectCount: number;
  taskCount: number;
  connectionCount: number;
  taskCountInRange: boolean;
  orphanedTasks: number;
  brokenConnections: number;
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export function buildTableCounts(data: BackupData): BackupTableCounts {
  return {
    projects: data.projects?.length ?? 0,
    tasks: data.tasks?.length ?? 0,
    connections: data.connections?.length ?? 0,
    userPreferences: data.userPreferences?.length ?? 0,
    blackBoxEntries: data.blackBoxEntries?.length ?? 0,
    focusSessions: data.focusSessions?.length ?? 0,
    transcriptionUsage: data.transcriptionUsage?.length ?? 0,
    routineTasks: data.routineTasks?.length ?? 0,
    routineCompletions: data.routineCompletions?.length ?? 0,
  };
}

// ===========================================
// 配置常量
// ===========================================

export const BACKUP_CONFIG = {
  /** 备份版本 */
  VERSION: '2.0.0',
  
  /** 健康校验配置 */
  VALIDATION: {
    /** 任务数变化阈值 - 分级告警 */
    TASK_COUNT_CHANGE: {
      WARNING_RATIO: 0.1,    // 10% → 警告
      BLOCK_RATIO: 0.3,      // 30% → 阻止备份
      ABSOLUTE_THRESHOLD: 20, // 变化超过 20 个任务 → 至少触发警告
      MIN_TASK_COUNT_FOR_RATIO: 50, // 小于 50 个任务时使用绝对值
    },
    /** 是否允许空备份 */
    ALLOW_EMPTY_BACKUP: false,
    /** 最小项目数（低于则告警） */
    MIN_PROJECT_COUNT: 1,
    /** 孤儿任务阈值（超过则告警） */
    MAX_ORPHANED_TASKS: 10,
    /** 断开连接阈值 */
    MAX_BROKEN_CONNECTIONS: 20,
  },
} as const;

// ===========================================
// 完整性校验工具
// ===========================================

/**
 * 计算数据的 SHA-256 校验和
 * @param data 要计算的数据
 * @returns 十六进制编码的校验和
 */
export async function calculateChecksum(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' 
    ? new TextEncoder().encode(data) 
    : data;
  
  // 使用 ArrayBuffer 确保类型兼容
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = new Uint8Array(hashBuffer);
  
  return Array.from(hashArray)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ===========================================
// 健康校验
// ===========================================

/**
 * 执行备份健康校验
 */
export function validateBackup(
  data: BackupData,
  previousMeta?: { taskCount: number; tableCounts?: Partial<BackupTableCounts> } | null
): BackupValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  
  // 1. 基础结构校验
  const hasRequiredTables = 
    Array.isArray(data.projects) &&
    Array.isArray(data.tasks) &&
    Array.isArray(data.connections) &&
    Array.isArray(data.userPreferences) &&
    Array.isArray(data.blackBoxEntries) &&
    Array.isArray(data.focusSessions) &&
    Array.isArray(data.transcriptionUsage) &&
    Array.isArray(data.routineTasks) &&
    Array.isArray(data.routineCompletions);
  
  if (!hasRequiredTables) {
    errors.push('缺少必需的数据表 (projects, tasks, connections)');
  }
  
  const projectCount = data.projects?.length ?? 0;
  const taskCount = data.tasks?.length ?? 0;
  const connectionCount = data.connections?.length ?? 0;
  
  // 2. 空备份检查
  if (!BACKUP_CONFIG.VALIDATION.ALLOW_EMPTY_BACKUP && taskCount === 0) {
    errors.push('备份数据为空 (任务数=0)');
  }
  
  // 3. 最小项目数检查
  if (projectCount < BACKUP_CONFIG.VALIDATION.MIN_PROJECT_COUNT) {
    warnings.push(`项目数 (${projectCount}) 低于最小值 (${BACKUP_CONFIG.VALIDATION.MIN_PROJECT_COUNT})`);
  }
  
  const countThresholds = {
    tasks: BACKUP_CONFIG.VALIDATION.TASK_COUNT_CHANGE,
    default: {
      WARNING_RATIO: 0.1,
      BLOCK_RATIO: 0.3,
      ABSOLUTE_THRESHOLD: 1,
      MIN_TASK_COUNT_FOR_RATIO: 1,
    },
  } as const;

  const validateCountDrift = (
    label: string,
    previousCount: number,
    currentCount: number,
    thresholds: {
      WARNING_RATIO: number;
      BLOCK_RATIO: number;
      ABSOLUTE_THRESHOLD: number;
      MIN_TASK_COUNT_FOR_RATIO: number;
    },
  ): { inRange: boolean } => {
    if (previousCount <= 0) {
      return { inRange: true };
    }

    const change = Math.abs(currentCount - previousCount);
    const ratio = change / previousCount;
    const useAbsolute = previousCount < thresholds.MIN_TASK_COUNT_FOR_RATIO;

    if (useAbsolute) {
      if (change > thresholds.ABSOLUTE_THRESHOLD) {
        if (ratio > thresholds.BLOCK_RATIO) {
          errors.push(`${label} count changed beyond threshold: ${previousCount} → ${currentCount}`);
          return { inRange: false };
        }
        warnings.push(`${label} count changed unexpectedly: ${previousCount} → ${currentCount} (${change})`);
      }
      return { inRange: true };
    }

    if (ratio > thresholds.BLOCK_RATIO && change >= thresholds.ABSOLUTE_THRESHOLD) {
      errors.push(`${label} count changed beyond threshold: ${previousCount} → ${currentCount} (${(ratio * 100).toFixed(1)}%)`);
      return { inRange: false };
    }
    if ((ratio > thresholds.WARNING_RATIO || change >= thresholds.ABSOLUTE_THRESHOLD) && change > 0) {
      warnings.push(`${label} count changed unexpectedly: ${previousCount} → ${currentCount} (${(ratio * 100).toFixed(1)}%)`);
    }
    return { inRange: true };
  };

  // 4. 表级数量变化检查
  let taskCountInRange = true;
  if (previousMeta && previousMeta.taskCount > 0) {
    taskCountInRange = validateCountDrift(
      'tasks',
      previousMeta.taskCount,
      taskCount,
      countThresholds.tasks,
    ).inRange;
  }

  const previousTableCounts = previousMeta?.tableCounts ?? {};
  for (const [label, currentCount] of Object.entries(buildTableCounts(data))) {
    if (label === 'tasks') continue;
    const previousCount = previousTableCounts[label as keyof BackupTableCounts];
    if (typeof previousCount === 'number' && previousCount > 0) {
      validateCountDrift(label, previousCount, currentCount, countThresholds.default);
    }
  }
  
  // 5. 孤儿任务检测
  const projectIds = new Set(data.projects?.map(p => p.id) ?? []);
  const orphanedTasks = data.tasks?.filter(t => t.projectId && !projectIds.has(t.projectId)) ?? [];
  if (orphanedTasks.length > BACKUP_CONFIG.VALIDATION.MAX_ORPHANED_TASKS) {
    warnings.push(`发现 ${orphanedTasks.length} 个孤儿任务（无对应项目）`);
  }
  
  // 6. 断开连接检测
  const taskIds = new Set(data.tasks?.map(t => t.id) ?? []);
  const brokenConnections = data.connections?.filter(
    c => !taskIds.has(c.source) || !taskIds.has(c.target)
  ) ?? [];
  if (brokenConnections.length > BACKUP_CONFIG.VALIDATION.MAX_BROKEN_CONNECTIONS) {
    warnings.push(`发现 ${brokenConnections.length} 个断开的连接（端点任务不存在）`);
  }
  
  return {
    isJsonValid: true, // JSON 解析成功才能到这里
    hasRequiredTables,
    projectCount,
    taskCount,
    connectionCount,
    taskCountInRange,
    orphanedTasks: orphanedTasks.length,
    brokenConnections: brokenConnections.length,
    ok: errors.length === 0,
    errors,
    warnings,
  };
}
