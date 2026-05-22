/**
 * 核心业务类型定义
 * 
 * 这个文件包含最基础的类型定义，不依赖任何其他模型文件。
 * 其他模型文件可以从这里导入基础类型，避免循环依赖。
 * 
 * 【P2-32 注意】models/index.ts 是规范的类型源头，本文件为打破循环依赖而存在的副本。
 * 修改类型定义时，必须同步更新两个文件。
 */

/**
 * 任务状态枚举：
 * - active: 活动状态，正在进行中
 * - completed: 已完成
 * - archived: 已归档，不显示在主视图中但仍可搜索和恢复
 */
export type TaskStatus = 'active' | 'completed' | 'archived';

/**
 * 附件类型
 */
export type AttachmentType = 'image' | 'document' | 'link' | 'file';

/**
 * 附件模型
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
  /** 软删除时间戳 【P2-32 修复】补充缺失字段，与 models/index.ts 保持一致 */
  deletedAt?: string;
}

/**
 * 连接模型（任务之间的关联）
 */
export interface Connection {
  id: string;
  source: string;
  target: string;
  title?: string;
  description?: string;
  deletedAt?: string | null;
  /** 最后更新时间戳（LWW 冲突解决必需）*/
  updatedAt?: string;
}

/**
 * 任务模型
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


  /**
   * State Overlap 停泊元数据
   * 仅 status === 'active' 的任务可持有此字段
   */
  parkingMeta?: import('./parking').TaskParkingMeta | null;
}
