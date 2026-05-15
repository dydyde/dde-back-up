/**
 * ImportService - 数据导入服务
 * 
 * 【Week 8 数据保护 - P1 手动导出/导入】
 * 职责：
 * - 从 JSON 文件导入项目数据
 * - 校验数据完整性和版本兼容性
 * - 支持多种导入策略（合并/覆盖/跳过）
 * - 冲突检测和处理
 * 
 * 设计理念：
 * - 安全第一：导入前充分验证
 * - 用户控制：让用户决定如何处理冲突
 * - 可恢复：导入失败可回滚
 */
import { Injectable, inject, signal, computed } from '@angular/core';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { LayoutService } from './layout.service';
import { Project, Task, Connection, AttachmentType } from '../models';
// 【P2-44 修复】导入 sanitizeProject 用于导入数据消毒
import { sanitizeProject } from '../utils/validation';
import {
  filterParentChildDuplicateConnections,
  softDeleteParentChildDuplicateConnections,
} from '../utils/parent-child-connection-integrity';
import { 
  ExportData, 
  ExportMetadata, 
  ExportProject,
  ExportTask,
  ExportConnection,
  ExportExternalSourceLink,
} from './export.service';
import type { BackupData } from '../../supabase/functions/_shared/backup-utils';
import { ExternalSourceLinkService } from '../app/core/external-sources/external-source-link.service';
import type { ExternalSourceLink } from '../app/core/external-sources/external-source.model';
import { parseSiyuanBlockLink } from '../app/core/external-sources/siyuan/siyuan-link-parser';

// ============================================
// 导入配置
// ============================================

export const IMPORT_CONFIG = {
  /** 支持的最低格式版本 */
  MIN_SUPPORTED_VERSION: '1.0',
  
  /** 支持的最高格式版本 */
  MAX_SUPPORTED_VERSION: '2.1',
  
  /** 最大文件大小（字节）- 50MB */
  MAX_FILE_SIZE: 50 * 1024 * 1024,
  
  /** 允许的文件类型 */
  ALLOWED_MIME_TYPES: ['application/json', 'text/plain'] as readonly string[],
  
  /** 校验和不匹配时是否允许继续 */
  ALLOW_CHECKSUM_MISMATCH: true,
  
  /** ID 冲突时的默认策略 */
  DEFAULT_CONFLICT_STRATEGY: 'skip' as ImportConflictStrategy,
} as const;

// ============================================
// 类型定义
// ============================================

/**
 * 导入冲突策略
 */
export type ImportConflictStrategy = 
  | 'skip'      // 跳过已存在的项目
  | 'overwrite' // 覆盖已存在的项目
  | 'merge'     // 合并任务和连接
  | 'rename';   // 创建为新项目（重命名）

/**
 * 导入选项
 */
export interface ImportOptions {
  /** 冲突处理策略 */
  conflictStrategy: ImportConflictStrategy;
  /** 是否跳过校验和验证 */
  skipChecksumValidation?: boolean;
  /** 是否生成新的 ID。
   * 默认保留导出文件中的客户端 UUID，仅在显式要求或 rename 导入时重生 ID。 */
  generateNewIds?: boolean;
}

/**
 * 文件验证结果
 */
export interface FileValidationResult {
  valid: boolean;
  error?: string;
  data?: ExportData;
}

/**
 * 导入预览
 */
export interface ImportPreview {
  /** 是否可导入 */
  canImport: boolean;
  /** 错误信息 */
  errors: string[];
  /** 警告信息 */
  warnings: string[];
  /** 导出元数据 */
  metadata: ExportMetadata;
  /** 项目预览 */
  projects: ImportProjectPreview[];
  /** 冲突项目 */
  conflicts: ImportConflict[];
}

/**
 * 项目预览
 */
export interface ImportProjectPreview {
  id: string;
  name: string;
  taskCount: number;
  connectionCount: number;
  attachmentCount: number;
  hasConflict: boolean;
}

/**
 * 导入冲突
 */
export interface ImportConflict {
  projectId: string;
  projectName: string;
  existingProjectId: string;
  existingProjectName: string;
  type: 'id' | 'name';
}

/**
 * 导入执行结果
 */
export interface ImportExecutionResult {
  success: boolean;
  error?: string;
  /** 成功导入的项目数 */
  importedCount: number;
  /** 跳过的项目数 */
  skippedCount: number;
  /** 失败的项目数 */
  failedCount: number;
  /** 详细结果 */
  details: ImportProjectResult[];
  /** 耗时（毫秒） */
  durationMs: number;
}

/**
 * 单个项目导入结果
 */
export interface ImportProjectResult {
  projectId: string;
  projectName: string;
  success: boolean;
  action: 'imported' | 'skipped' | 'merged' | 'overwritten' | 'failed';
  error?: string;
  taskCount?: number;
  connectionCount?: number;
}

/**
 * 导入进度
 */
export interface ImportProgress {
  stage: 'validating' | 'preparing' | 'importing' | 'complete';
  percentage: number;
  currentItem?: string;
}

// ============================================
// 服务实现
// ============================================

@Injectable({
  providedIn: 'root'
})
export class ImportService {
  private readonly logger = inject(LoggerService).category('Import');
  private readonly toast = inject(ToastService);
  private readonly layoutService = inject(LayoutService);
  private readonly externalSourceLinks = inject(ExternalSourceLinkService);
  
  // 状态信号
  private readonly _isImporting = signal(false);
  private readonly _progress = signal<ImportProgress>({
    stage: 'validating',
    percentage: 0,
  });
  
  // 公开的计算属性
  readonly isImporting = computed(() => this._isImporting());
  readonly progress = computed(() => this._progress());
  
  /**
   * 从文件读取并验证
   */
  async validateFile(file: File): Promise<FileValidationResult> {
    this.logger.info('验证导入文件', { 
      name: file.name, 
      size: file.size,
      type: file.type 
    });
    
    // 1. 检查文件大小
    if (file.size > IMPORT_CONFIG.MAX_FILE_SIZE) {
      return {
        valid: false,
        error: `文件过大，最大支持 ${IMPORT_CONFIG.MAX_FILE_SIZE / 1024 / 1024}MB`,
      };
    }
    
    // 2. 检查文件类型
    const mimeType = file.type || 'text/plain';
    if (!IMPORT_CONFIG.ALLOWED_MIME_TYPES.includes(mimeType)) {
      // 允许无类型的 .json 文件
      if (!file.name.endsWith('.json')) {
        return {
          valid: false,
          error: '不支持的文件类型，请选择 JSON 文件',
        };
      }
    }
    
    // 3. 读取文件内容
    let text: string;
    try {
      text = await file.text();
    } catch (e) {
      this.logger.debug('读取文件失败', { error: e, fileName: file.name });
      return {
        valid: false,
        error: '无法读取文件',
      };
    }
    
    // 4. 解析 JSON
    let data: ExportData;
    try {
      data = JSON.parse(text) as ExportData;
    } catch (e) {
      return {
        valid: false,
        error: `JSON 解析失败：${(e as Error).message}`,
      };
    }
    
    // 5. 验证数据结构（BackupData 格式会被自动转换为 ExportData）
    const structureValidation = this.validateDataStructure(data);
    if (!structureValidation.valid) {
      return structureValidation;
    }
    
    // 使用转换后的数据（BackupData 会被 validateDataStructure 转为 ExportData）
    const validatedData = structureValidation.data ?? data;
    
    // 6. 验证版本兼容性
    const versionValidation = this.validateVersion(validatedData.metadata.version);
    if (!versionValidation.valid) {
      return versionValidation;
    }
    
    return { valid: true, data: validatedData };
  }

  /**
   * 生成导入预览
   */
  async generatePreview(
    data: ExportData,
    existingProjects: Project[]
  ): Promise<ImportPreview> {
    const errors: string[] = [];
    const warnings: string[] = [];
    const conflicts: ImportConflict[] = [];
    const projectPreviews: ImportProjectPreview[] = [];
    
    // 构建现有项目索引
    const existingById = new Map(existingProjects.map(p => [p.id, p]));
    const existingByName = new Map(existingProjects.map(p => [p.name.toLowerCase(), p]));
    
    for (const project of data.projects) {
      // 统计
      const taskCount = project.tasks?.length ?? 0;
      const connectionCount = project.connections?.length ?? 0;
      let attachmentCount = 0;
      for (const task of project.tasks ?? []) {
        attachmentCount += task.attachments?.length ?? 0;
      }
      
      // 检查 ID 冲突
      const existingById_ = existingById.get(project.id);
      if (existingById_) {
        conflicts.push({
          projectId: project.id,
          projectName: project.name,
          existingProjectId: existingById_.id,
          existingProjectName: existingById_.name,
          type: 'id',
        });
      }
      
      // 检查名称冲突
      const existingByName_ = existingByName.get(project.name.toLowerCase());
      if (existingByName_ && existingByName_.id !== project.id) {
        conflicts.push({
          projectId: project.id,
          projectName: project.name,
          existingProjectId: existingByName_.id,
          existingProjectName: existingByName_.name,
          type: 'name',
        });
      }
      
      projectPreviews.push({
        id: project.id,
        name: project.name,
        taskCount,
        connectionCount,
        attachmentCount,
        hasConflict: existingById.has(project.id),
      });
    }
    
    // 验证校验和
    const checksumValid = await this.verifyChecksum(data);
    if (!checksumValid) {
      warnings.push('校验和不匹配，数据可能已被修改');
    }
    
    // 检查附件 URL 过期
    const hasAttachments = projectPreviews.some(p => p.attachmentCount > 0);
    if (hasAttachments) {
      warnings.push('附件 URL 可能已过期，导入后需要重新上传附件');
    }
    
    return {
      canImport: errors.length === 0,
      errors,
      warnings,
      metadata: data.metadata,
      projects: projectPreviews,
      conflicts,
    };
  }

  /**
   * 执行导入
   */
  async executeImport(
    data: ExportData,
    existingProjects: Project[],
    options: ImportOptions,
    onProjectImported?: (project: Project) => void | Promise<void>
  ): Promise<ImportExecutionResult> {
    if (this._isImporting()) {
      return {
        success: false,
        error: '导入正在进行中',
        importedCount: 0,
        skippedCount: 0,
        failedCount: 0,
        details: [],
        durationMs: 0,
      };
    }
    
    const startTime = Date.now();
    this._isImporting.set(true);
    this.updateProgress('preparing', 0);
    
    const details: ImportProjectResult[] = [];
    const existingById = new Map(existingProjects.map(p => [p.id, p]));
    
    try {
      this.logger.info('开始导入', { 
        projectCount: data.projects.length,
        conflictStrategy: options.conflictStrategy 
      });
      
      for (let i = 0; i < data.projects.length; i++) {
        const exportProject = data.projects[i];
        const progress = 10 + (i / data.projects.length) * 80;
        this.updateProgress('importing', progress, exportProject.name);
        
        const result = await this.importProject(
          exportProject,
          existingById.get(exportProject.id),
          options,
          onProjectImported
        );
        
        details.push(result);
      }
      
      this.updateProgress('complete', 100);
      
      const importedCount = details.filter(d => 
        d.action === 'imported' || d.action === 'merged' || d.action === 'overwritten'
      ).length;
      const skippedCount = details.filter(d => d.action === 'skipped').length;
      const failedCount = details.filter(d => d.action === 'failed').length;
      
      this.logger.info('导入完成', { importedCount, skippedCount, failedCount });
      
      return {
        success: failedCount === 0,
        importedCount,
        skippedCount,
        failedCount,
        details,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      this.logger.error('导入失败', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : '导入失败',
        importedCount: 0,
        skippedCount: 0,
        failedCount: data.projects.length,
        details,
        durationMs: Date.now() - startTime,
      };
    } finally {
      this._isImporting.set(false);
    }
  }
  
  /**
   * 导入单个项目
   */
  private async importProject(
    exportProject: ExportProject,
    existingProject: Project | undefined,
    options: ImportOptions,
    onProjectImported?: (project: Project) => void | Promise<void>
  ): Promise<ImportProjectResult> {
    const { conflictStrategy } = options;
    let generateNewIds = options.generateNewIds ?? false;
    
    // 标记是否为覆盖操作
    let isOverwrite = false;
    
    // 处理冲突
    if (existingProject) {
      switch (conflictStrategy) {
        case 'skip':
          return {
            projectId: exportProject.id,
            projectName: exportProject.name,
            success: true,
            action: 'skipped',
          };
        
        case 'overwrite':
          // 覆盖：使用导入的数据
          isOverwrite = true;
          break;
        
        case 'merge':
          // 合并：将导入的任务添加到现有项目
          return this.mergeProject(exportProject, existingProject, onProjectImported);
        
        case 'rename':
          // 重命名：必须重生整棵项目树 ID，避免与现有实体冲突
          generateNewIds = true;
          exportProject = {
            ...exportProject,
            name: `${exportProject.name} (导入)`,
          };
          // rename 后不再视为覆盖，而是新项目
          break;
      }
    }
    
    try {
      // 转换为 Project 类型
      const conversion = this.convertToProject(exportProject, generateNewIds);
      const project = conversion.project;
      
      // 调用回调保存项目
      if (onProjectImported) {
        await onProjectImported(project);
      }
      await this.importExternalSourceLinks(exportProject, conversion.taskIdMap);
      
      return {
        projectId: project.id,
        projectName: project.name,
        success: true,
        action: isOverwrite ? 'overwritten' : 'imported',
        taskCount: project.tasks.length,
        connectionCount: project.connections.length,
      };
    } catch (error) {
      return {
        projectId: exportProject.id,
        projectName: exportProject.name,
        success: false,
        action: 'failed',
        error: error instanceof Error ? error.message : '导入失败',
      };
    }
  }
  
  /**
   * 合并项目
   */
  private async mergeProject(
    exportProject: ExportProject,
    existingProject: Project,
    onProjectImported?: (project: Project) => void | Promise<void>
  ): Promise<ImportProjectResult> {
    try {
      // 合并任务（按 ID 去重）
      const existingTaskIds = new Set(existingProject.tasks.map(t => t.id));
      const newExportTasks = (exportProject.tasks ?? [])
        .filter(t => !existingTaskIds.has(t.id));
      const newTasks = newExportTasks.map(t => this.convertToTask(t));
      
      // 合并连接（按 ID 去重）
      const existingConnIds = new Set(existingProject.connections.map(c => c.id));
      const newConnections = (exportProject.connections ?? [])
        .filter(c => !existingConnIds.has(c.id))
        .map(c => this.convertToConnection(c));
      const importedConnections = filterParentChildDuplicateConnections( 
        [...existingProject.tasks, ...newTasks],
        newConnections,
      );
      const mergedTasks = [...existingProject.tasks, ...newTasks];
      const mergedConnections = softDeleteParentChildDuplicateConnections(
        mergedTasks,
        [...existingProject.connections, ...importedConnections],
        new Date().toISOString(),
      );
      
      // 创建合并后的项目
      const mergedProject: Project = {
        ...existingProject,
        tasks: mergedTasks,
        connections: mergedConnections,
        updatedAt: new Date().toISOString(),
      };
      
      if (onProjectImported) {
        await onProjectImported(mergedProject);
      }
      await this.importExternalSourceLinks({ ...exportProject, tasks: newExportTasks }, new Map());
      
      return {
        projectId: mergedProject.id,
        projectName: mergedProject.name,
        success: true,
        action: 'merged',
        taskCount: newTasks.length,
        connectionCount: importedConnections.length,
      };
    } catch (error) {
      return {
        projectId: exportProject.id,
        projectName: exportProject.name,
        success: false,
        action: 'failed',
        error: error instanceof Error ? error.message : '合并失败',
      };
    }
  }
  
  // ==================== 转换方法 ====================
  
  /**
   * 转换导出项目为 Project
   * 【P2-44 修复】对导入数据执行 sanitizeProject 消毒
   *
   * Hard Rule: ID 必须客户端 UUID。导出文件中的实体 ID 本身就是客户端 UUID，
   * 因此默认保留原始 ID；仅在显式要求或 rename 导入时重生整棵项目树 ID。
   */
  private convertToProject(exportProject: ExportProject, generateNewIds: boolean = false): { project: Project; taskIdMap: Map<string, string> } {
    const projectId = generateNewIds ? crypto.randomUUID() : exportProject.id;
    
    if (generateNewIds) {
      this.logger.info('导入时重生项目树 ID', { projectId: exportProject.id });
    }
    
    // 始终构建任务 ID 映射：重生 ID 时用于引用改写，保留 ID 时用于恢复外部锚点指针。
    const idMap = new Map<string, string>();
    for (const task of exportProject.tasks ?? []) {
      idMap.set(task.id, generateNewIds ? crypto.randomUUID() : task.id);
    }
    
    const rawTasks = (exportProject.tasks ?? []).map(t => 
      this.convertToTask(t, generateNewIds ? idMap : undefined)
    );
    const rawConnections = filterParentChildDuplicateConnections(
      rawTasks,
      (exportProject.connections ?? []).map(c => 
        this.convertToConnection(c, generateNewIds ? idMap : undefined)
      ),
    );

    const rawProject: Project = {
      id: projectId,
      name: exportProject.name,
      description: exportProject.description ?? '',
      tasks: rawTasks,
      connections: rawConnections,
      createdDate: exportProject.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      viewState: exportProject.viewState,
      flowchartUrl: exportProject.flowchartUrl,
      flowchartThumbnailUrl: exportProject.flowchartThumbnailUrl,
      version: exportProject.version,
    };
    
    // 导入数据消毒：防止 XSS 和无效数据
    const sanitized = sanitizeProject(rawProject);

    // 【P2-45 修复】导入后执行树结构校验 + 修复
    const { project: validated, issues } = this.layoutService.validateAndFixTree(sanitized);
    if (issues.length > 0) {
      this.logger.warn('导入项目树结构修复', { projectId, issues });
    }
    return { project: validated, taskIdMap: idMap };
  }

  private async importExternalSourceLinks(exportProject: ExportProject, taskIdMap: Map<string, string>): Promise<void> {
    const links: ExternalSourceLink[] = [];
    for (const task of exportProject.tasks ?? []) {
      const taskId = taskIdMap.get(task.id) ?? task.id;
      for (const link of task.externalSourceLinks ?? []) {
        const normalized = this.toExternalSourceLink(link, taskId);
        if (normalized) links.push(normalized);
      }
    }
    await this.externalSourceLinks.importPointers(links);
  }

  private toExternalSourceLink(link: ExportExternalSourceLink, taskId: string): ExternalSourceLink | null {
    if (link.sourceType !== 'siyuan-block' || !link.targetId || !link.uri) return null;
    // 校验 targetId 与 uri 是否符合思源块 ID 形式，否则丢弃并打 warn。
    // 不过滤会导致脏数据进 IndexedDB 且在推送到 Supabase 时被 CHECK 约束拒绝，反复重试。
    const parsed = parseSiyuanBlockLink(link.targetId) ?? parseSiyuanBlockLink(link.uri);
    if (!parsed) {
      this.logger.warn('导入跳过非法思源锚点', { taskId, targetId: link.targetId });
      return null;
    }
    return {
      id: link.id || crypto.randomUUID(),
      taskId,
      sourceType: 'siyuan-block',
      targetId: parsed.blockId,
      uri: parsed.uri,
      label: link.label,
      hpath: link.hpath,
      role: link.role,
      sortOrder: typeof link.sortOrder === 'number' ? link.sortOrder : 0,
      deletedAt: link.deletedAt ?? null,
      createdAt: link.createdAt ?? new Date().toISOString(),
      updatedAt: link.updatedAt ?? new Date().toISOString(),
    };
  }
  
  /**
   * 转换导出任务为 Task
   */
  private convertToTask(
    exportTask: ExportProject['tasks'][0],
    idMap?: Map<string, string>
  ): Task {
    const newId = idMap?.get(exportTask.id) ?? exportTask.id;
    const newParentId = exportTask.parentId 
      ? (idMap?.get(exportTask.parentId) ?? exportTask.parentId)
      : null;
    
    return {
      id: newId,
      title: exportTask.title,
      content: exportTask.content ?? '',
      stage: exportTask.stage,
      parentId: newParentId,
      order: exportTask.order ?? 0,
      rank: exportTask.rank ?? 10000,
      status: (exportTask.status as Task['status']) ?? 'active',
      x: exportTask.x ?? 0,
      y: exportTask.y ?? 0,
      displayId: exportTask.displayId ?? '',
      shortId: exportTask.shortId,
      createdDate: exportTask.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      // 兼容旧导出包：缺少完成时间时使用导出包中最接近完成语义的时间，最后才落到导入时间。
      completedAt: exportTask.status === 'completed'
        ? (exportTask.completedAt ?? exportTask.updatedAt ?? exportTask.createdAt ?? new Date().toISOString())
        : null,
      tags: exportTask.tags,
      priority: exportTask.priority,
      dueDate: exportTask.dueDate,
      expected_minutes:
        typeof exportTask.expected_minutes === 'number' ? exportTask.expected_minutes : null,
      cognitive_load:
        exportTask.cognitive_load === 'high' || exportTask.cognitive_load === 'low'
          ? exportTask.cognitive_load
          : null,
      wait_minutes:
        typeof exportTask.wait_minutes === 'number' ? exportTask.wait_minutes : null,
      hasIncompleteTask: exportTask.hasIncompleteTask,
      deletedAt: exportTask.deletedAt,
      // 导入恢复停泊元数据，刷新 lastVisitedAt，清除过期提醒（A3.11）
      parkingMeta: (exportTask as { parkingMeta?: import('../models/parking').TaskParkingMeta | null }).parkingMeta
        ? (() => {
            const meta = (exportTask as { parkingMeta: import('../models/parking').TaskParkingMeta }).parkingMeta;
            return {
              ...meta,
              lastVisitedAt: new Date().toISOString(),
              contextSnapshot: null,
              reminder: meta.reminder && new Date(meta.reminder.reminderAt).getTime() > Date.now()
                ? meta.reminder : null,
            };
          })()
        : null,
      // 附件需要重新上传，这里只保留元数据并标记为待上传
      attachments: exportTask.attachments?.map(att => ({
        id: att.id,
        name: att.name,
        size: att.size ?? 0,
        mimeType: att.mimeType ?? 'application/octet-stream',
        type: att.type ?? this.inferAttachmentType(att.mimeType ?? 'application/octet-stream'),
        url: '', // URL 需要重新上传后生成
        thumbnailUrl: att.thumbnailUrl,
        createdAt: att.createdAt ?? new Date().toISOString(),
      })),
    };
  }
  
  /**
   * 转换导出连接为 Connection
   */
  private convertToConnection(
    exportConn: ExportProject['connections'][0],
    idMap?: Map<string, string>
  ): Connection {
    const newId = idMap ? crypto.randomUUID() : exportConn.id;
    const newSource = idMap?.get(exportConn.source) ?? exportConn.source;
    const newTarget = idMap?.get(exportConn.target) ?? exportConn.target;
    
    return {
      id: newId,
      source: newSource,
      target: newTarget,
      title: exportConn.title,
      description: exportConn.description,
      deletedAt: exportConn.deletedAt,
    };
  }
  
  // ==================== 验证方法 ====================
  
  /**
   * 验证数据结构
   * 支持 ExportData 格式和 BackupData（本地备份）格式，后者自动转换
   */
  private validateDataStructure(data: unknown): FileValidationResult {
    if (!data || typeof data !== 'object') {
      return { valid: false, error: '无效的数据格式' };
    }
    
    const obj = data as Record<string, unknown>;
    
    // 检测是否为 BackupData 格式（本地备份文件）
    // BackupData 有 payloadVersion + 扁平的 tasks/connections 数组，无 metadata 字段
    if (this.isBackupDataFormat(obj)) {
      const converted = this.convertBackupDataToExportData(obj as unknown as BackupData);
      if (!converted) {
        return { valid: false, error: '本地备份数据转换失败' };
      }
      return { valid: true, data: converted };
    }
    
    // 标准 ExportData 格式验证
    if (!obj['metadata'] || typeof obj['metadata'] !== 'object') {
      return { valid: false, error: '缺少元数据' };
    }
    
    if (!obj['projects'] || !Array.isArray(obj['projects'])) {
      return { valid: false, error: '缺少项目数据' };
    }
    
    const metadata = obj['metadata'] as Record<string, unknown>;
    if (!metadata['version']) {
      return { valid: false, error: '缺少版本信息' };
    }
    
    // 验证每个项目
    for (const project of obj['projects'] as unknown[]) {
      if (!project || typeof project !== 'object') {
        return { valid: false, error: '无效的项目数据' };
      }
      
      const proj = project as Record<string, unknown>;
      if (!proj['id'] || !proj['name']) {
        return { valid: false, error: '项目缺少必需字段 (id, name)' };
      }
    }
    
    return { valid: true, data: data as ExportData };
  }
  
  /**
   * 检测数据是否为 BackupData 格式（本地灾难备份 / 坚果云备份）
   */
  private isBackupDataFormat(obj: Record<string, unknown>): boolean {
    return (
      typeof obj['payloadVersion'] === 'string' &&
      Array.isArray(obj['projects']) &&
      Array.isArray(obj['tasks']) &&
      Array.isArray(obj['connections']) &&
      !obj['metadata']
    );
  }
  
  /**
   * 将 BackupData（扁平结构）转换为 ExportData（嵌套结构）
   * 本地备份和坚果云备份文件使用 BackupData 格式，导入需要 ExportData 格式
   */
  private convertBackupDataToExportData(backup: BackupData): ExportData | null {
    try {
      // 按 projectId 分组 tasks 和 connections
      const tasksByProject = new Map<string, ExportTask[]>();
      const connectionsByProject = new Map<string, ExportConnection[]>();
      
      for (const task of backup.tasks ?? []) {
        const projectId = task.projectId;
        if (!tasksByProject.has(projectId)) {
          tasksByProject.set(projectId, []);
        }
        tasksByProject.get(projectId)!.push({
          id: task.id,
          title: task.title,
          content: task.content ?? '',
          stage: task.stage ?? null,
          parentId: task.parentId ?? null,
          order: task.order ?? 0,
          rank: task.rank ?? 0,
          status: task.status ?? 'active',
          x: task.x ?? 0,
          y: task.y ?? 0,
          displayId: task.displayId ?? task.shortId ?? task.id.slice(0, 6),
          shortId: task.shortId,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
          deletedAt: task.deletedAt,
          attachments: task.attachments?.map(att => {
            if (typeof att === 'object' && att !== null) {
              const a = att as Record<string, unknown>;
              return {
                id: String(a['id'] ?? ''),
                name: String(a['name'] ?? ''),
                size: Number(a['size'] ?? 0),
                mimeType: String(a['mimeType'] ?? a['mime_type'] ?? ''),
                type: (a['type'] as 'image' | 'document' | 'link' | 'file') ?? 'file',
              };
            }
            return { id: '', name: '', size: 0, mimeType: '' };
          }),
          tags: task.tags,
          priority: task.priority as ExportTask['priority'],
          dueDate: task.dueDate,
          externalSourceLinks: task.externalSourceLinks,
        } as ExportTask);
      }
      
      for (const conn of backup.connections ?? []) {
        const projectId = conn.projectId;
        if (!connectionsByProject.has(projectId)) {
          connectionsByProject.set(projectId, []);
        }
        connectionsByProject.get(projectId)!.push({
          id: conn.id,
          source: conn.source,
          target: conn.target,
          title: conn.title,
          description: conn.description,
          deletedAt: conn.deletedAt,
        });
      }
      
      // 构建 ExportProject 列表
      const projects: ExportProject[] = (backup.projects ?? []).map(proj => ({
        id: proj.id,
        name: proj.name,
        description: proj.description ?? '',
        tasks: tasksByProject.get(proj.id) ?? [],
        connections: connectionsByProject.get(proj.id) ?? [],
        createdAt: proj.createdAt,
        updatedAt: proj.updatedAt,
        version: proj.version,
      }));
      
      const totalTasks = (backup.tasks ?? []).length;
      const totalConnections = (backup.connections ?? []).length;
      const totalAttachments = (backup.tasks ?? []).reduce(
        (sum, t) => sum + (t.attachments?.length ?? 0), 0
      );
      
      const metadata: ExportMetadata = {
        exportedAt: backup.createdAt ?? new Date().toISOString(),
        version: backup.payloadVersion ?? backup.version ?? '1.0',
        appVersion: 'backup-restore',
        projectCount: projects.length,
        taskCount: totalTasks,
        connectionCount: totalConnections,
        attachmentCount: totalAttachments,
        checksum: backup.checksum ?? '',
        exportType: 'full',
      };
      
      return { metadata, projects };
    } catch {
      return null; // eslint-disable-line no-restricted-syntax -- 文件解析失败时"无法读取"语义正确，null 触发调用方抛错提示
    }
  }
  
  /**
   * 验证版本兼容性
   */
  private validateVersion(version: string): FileValidationResult {
    const versionNum = parseFloat(version);
    const minVersion = parseFloat(IMPORT_CONFIG.MIN_SUPPORTED_VERSION);
    const maxVersion = parseFloat(IMPORT_CONFIG.MAX_SUPPORTED_VERSION);
    
    if (isNaN(versionNum)) {
      return { valid: false, error: '无效的版本号' };
    }
    
    if (versionNum < minVersion) {
      return { 
        valid: false, 
        error: `版本过低，最低支持 v${IMPORT_CONFIG.MIN_SUPPORTED_VERSION}` 
      };
    }
    
    if (versionNum > maxVersion) {
      return { 
        valid: false, 
        error: `版本过高，最高支持 v${IMPORT_CONFIG.MAX_SUPPORTED_VERSION}` 
      };
    }
    
    return { valid: true };
  }
  
  /**
   * 验证校验和
   */
  private async verifyChecksum(data: ExportData): Promise<boolean> {
    const originalChecksum = data.metadata.checksum;
    if (!originalChecksum) {
      return true; // 无校验和时视为通过
    }
    
    // 计算当前数据的校验和
    const dataForChecksum = {
      ...data,
      metadata: { ...data.metadata, checksum: '' },
    };
    
    const jsonString = JSON.stringify(dataForChecksum);
    
    try {
      if (typeof crypto !== 'undefined' && crypto.subtle) {
        const encoder = new TextEncoder();
        const dataBuffer = encoder.encode(jsonString);
        const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const calculatedChecksum = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        
        return calculatedChecksum === originalChecksum;
      }
    } catch (e) {
      // 降级处理：校验失败时允许继续
      this.logger.debug('校验和验证失败', { error: e });
    }
    
    // 简单 hash 无法准确验证，返回 true
    return true;
  }
  
  /**
   * 更新进度
   */
  private updateProgress(
    stage: ImportProgress['stage'],
    percentage: number,
    currentItem?: string
  ): void {
    this._progress.set({
      stage,
      percentage: Math.min(100, Math.max(0, percentage)),
      currentItem,
    });
  }
  
  /**
   * 根据 MIME 类型推断附件类型
   */
  private inferAttachmentType(mimeType: string): AttachmentType {
    if (mimeType.startsWith('image/')) {
      return 'image';
    }
    if (mimeType === 'application/pdf' || 
        mimeType.includes('document') ||
        mimeType.includes('text/')) {
      return 'document';
    }
    return 'file';
  }
}
