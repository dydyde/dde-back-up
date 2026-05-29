/**
 * ProjectSyncOperationsService - 项目同步操作服务
 * 
 * 职责：
 * - 重新同步活动项目
 * - 离线数据重连合并
 * - 项目验证和重平衡
 * 
 * 从 SyncCoordinatorService 提取，作为 Sprint 9 技术债务修复的一部分
 */

import { Injectable, inject } from '@angular/core';
import { SimpleSyncService } from '../core-bridge';
import { ConflictResolutionService } from './conflict-resolution.service';
import { ConflictStorageService } from './conflict-storage.service';
import { ProjectStateService } from './project-state.service';
import { AuthService } from './auth.service';
import { ChangeTrackerService } from './change-tracker.service';
import { LayoutService } from './layout.service';
import { ToastService } from './toast.service';
import { LoggerService } from './logger.service';
import { DeltaSyncCoordinatorService } from './delta-sync-coordinator.service';
import { Project } from '../models';
import { Result, success, failure, isFailure, ErrorCodes, OperationError } from '../utils/result';
import { validateProject, sanitizeProject } from '../utils/validation';

@Injectable({
  providedIn: 'root'
})
export class ProjectSyncOperationsService {
  private readonly syncService = inject(SimpleSyncService);
  private readonly conflictService = inject(ConflictResolutionService);
  private readonly conflictStorage = inject(ConflictStorageService);
  private readonly projectState = inject(ProjectStateService);
  private readonly authService = inject(AuthService);
  private readonly changeTracker = inject(ChangeTrackerService);
  private readonly layoutService = inject(LayoutService);
  private readonly toastService = inject(ToastService);
  private readonly deltaSyncCoordinator = inject(DeltaSyncCoordinatorService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('ProjectSyncOps');

  /**
   * 重新同步当前活动项目
   */
  async resyncActiveProject(
    getTombstoneIds: (projectId: string) => Promise<Set<string>>
  ): Promise<{
    success: boolean;
    message: string;
    conflictDetected?: boolean;
  }> {
    const projectId = this.projectState.activeProjectId();
    const userId = this.authService.currentUserId();
    
    if (!projectId || !userId) {
      return { success: false, message: '无活动项目或未登录' };
    }
    
    const activeProject = this.projectState.activeProject();
    const localProject = this.projectState.getProjectWithCurrentData(projectId)
      ?? (activeProject?.id === projectId ? activeProject : null);
    if (!localProject) {
      return { success: false, message: '本地项目不存在' };
    }
    
    this.logger.info('开始重新同步项目', { projectId });
    
    try {
      const remoteProject = await this.syncService.loadSingleProject(projectId, userId);
      
      if (!remoteProject) {
        return { success: false, message: '云端项目不存在' };
      }
      
      const tombstoneIds = await getTombstoneIds(projectId);
      const localVersion = localProject.version ?? 0;
      const remoteVersion = remoteProject.version ?? 0;
      
      if (localVersion === remoteVersion) {
        const mergeResult = this.conflictService.smartMerge(localProject, remoteProject, tombstoneIds);
        const validated = this.validateAndRebalance(mergeResult.project);
        this.projectState.updateProjects(ps => 
          ps.map(p => p.id === projectId ? validated : p)
        );
        return { success: true, message: '数据已是最新' };
      }
      
      if (remoteVersion > localVersion) {
        const mergeResult = this.conflictService.smartMerge(localProject, remoteProject, tombstoneIds);
        
        if (mergeResult.conflictCount > 0) {
          await this.saveConflictSilently(localProject, remoteProject, mergeResult.issues);
          this.logger.info('检测到冲突，已保存到冲突仓库', { 
            projectId, 
            conflictCount: mergeResult.conflictCount 
          });
        }
        
        const validated = this.validateAndRebalance(mergeResult.project);
        this.projectState.updateProjects(ps => 
          ps.map(p => p.id === projectId ? validated : p)
        );
        
        this.changeTracker.clearProjectFieldLocks(projectId);
        
        return { 
          success: true, 
          message: mergeResult.conflictCount > 0 
            ? `已合并，${mergeResult.conflictCount} 处冲突已保存供稍后处理`
            : '已与云端同步',
          conflictDetected: mergeResult.conflictCount > 0
        };
      }
      
      const saveResult = await this.syncService.saveProjectSmart(localProject, userId);
      
      if (saveResult.success) {
        this.changeTracker.clearProjectFieldLocks(projectId);
        return { success: true, message: '本地更改已推送到云端' };
      } else if (saveResult.conflict) {
        if (saveResult.remoteData) {
          await this.saveConflictSilently(localProject, saveResult.remoteData, []);
        }
        return { 
          success: false, 
          message: '发现版本冲突，已保存到冲突仓库',
          conflictDetected: true
        };
      } else {
        return { success: false, message: '同步失败' };
      }
      
    } catch (error) {
      this.logger.error('重新同步失败', error);
      return { success: false, message: '同步时发生错误' };
    }
  }

  /**
   * 离线数据重连合并
   */
  async mergeOfflineDataOnReconnect(
    cloudProjects: Project[], 
    offlineProjects: Project[],
    userId: string,
    getTombstoneIds: (projectId: string) => Promise<Set<string>>,
    onConflict: (local: Project, remote: Project) => void
  ): Promise<{ projects: Project[]; syncedCount: number; conflictProjects: Project[] }> {
    const cloudMap = new Map(cloudProjects.map(p => [p.id, p]));
    const mergedProjects: Project[] = [...cloudProjects];
    const conflictProjects: Project[] = [];
    let syncedCount = 0;
    
    for (const offlineProject of offlineProjects) {
      const cloudProject = cloudMap.get(offlineProject.id);
      
      if (!cloudProject) {
        const result = await this.syncService.saveProjectToCloud(offlineProject, userId);
        if (result.success) {
          const syncedProject = { ...offlineProject, version: result.newVersion ?? offlineProject.version };
          mergedProjects.push(syncedProject);
          syncedCount++;
          this.logger.info('离线新建项目已同步:', offlineProject.name);
        }
        continue;
      }
      
      const offlineVersion = offlineProject.version ?? 0;
      const cloudVersion = cloudProject.version ?? 0;
      
      let shouldSyncOffline = false;
      let reason = '';
      let projectToSync = offlineProject;
      
      if (offlineVersion > cloudVersion) {
        shouldSyncOffline = true;
        reason = '版本号更高';
      } else if (offlineVersion === cloudVersion) {
        const hasContentDiff = this.deltaSyncCoordinator.hasProjectContentDifference(offlineProject, cloudProject);
        
        if (hasContentDiff) {
          const offlineTime = new Date(offlineProject.updatedAt || 0).getTime();
          const cloudTime = new Date(cloudProject.updatedAt || 0).getTime();
          
          if (offlineTime >= cloudTime) {
            shouldSyncOffline = true;
            reason = '本地有未同步的修改';
          } else {
            this.logger.info('检测到本地修改可能被覆盖', {
              projectId: offlineProject.id,
              offlineTime: new Date(offlineTime).toISOString(),
              cloudTime: new Date(cloudTime).toISOString()
            });
            const tombstoneIds = await getTombstoneIds(offlineProject.id);
            const mergedProject = this.conflictService.smartMerge(offlineProject, cloudProject, tombstoneIds);
            shouldSyncOffline = true;
            reason = '智能合并本地和云端修改';
            projectToSync = mergedProject.project;
          }
        }
      }
      
      if (shouldSyncOffline) {
        const projectWithVersion = { 
          ...projectToSync, 
          version: Math.max(offlineVersion, cloudVersion) + 1 
        };
        
        this.logger.info('同步离线修改', { 
          projectId: offlineProject.id, 
          reason,
          offlineVersion,
          cloudVersion
        });
        
        const result = await this.syncService.saveProjectToCloud(projectWithVersion, userId);
        if (result.success) {
          const syncedProject = { ...projectWithVersion, version: result.newVersion ?? projectWithVersion.version };
          const idx = mergedProjects.findIndex(p => p.id === offlineProject.id);
          if (idx !== -1) {
            mergedProjects[idx] = syncedProject;
          }
          syncedCount++;
          this.logger.info('离线修改已同步:', offlineProject.name);
        } else if (result.conflict) {
          this.logger.warn('离线数据存在冲突', { projectName: offlineProject.name });
          conflictProjects.push(offlineProject);
          onConflict(offlineProject, result.remoteData!);
        }
      }
    }
    
    return { projects: mergedProjects, syncedCount, conflictProjects };
  }

  /**
   * 验证并重新平衡项目（Result 版本）
   */
  validateAndRebalanceWithResult(project: Project): Result<Project, OperationError> {
    const validation = validateProject(project);
    
    const fatalErrors = validation.errors.filter(e =>
      e.includes('项目 ID 无效或缺失') ||
      e.includes('项目任务列表必须是数组')
    );
    
    if (fatalErrors.length > 0) {
      this.logger.error('项目数据致命错误，无法恢复', { 
        projectId: project.id, 
        fatalErrors 
      });
      return failure(
        ErrorCodes.VALIDATION_ERROR,
        `项目数据损坏无法修复: ${fatalErrors.join('; ')}`,
        { projectId: project.id, errors: fatalErrors }
      );
    }
    
    if (!validation.valid) {
      this.logger.warn('项目数据验证失败，尝试清理修复', { 
        projectId: project.id, 
        errors: validation.errors 
      });
      project = sanitizeProject(project);
      
      const revalidation = validateProject(project);
      if (!revalidation.valid) {
        this.logger.error('清理后数据仍然无效', { errors: revalidation.errors });
        return failure(
          ErrorCodes.VALIDATION_ERROR,
          `项目数据清理后仍然无效: ${revalidation.errors.join('; ')}`,
          { projectId: project.id, errors: revalidation.errors }
        );
      }
    }
    
    if (validation.warnings.length > 0) {
      this.logger.warn('项目数据警告', { projectId: project.id, warnings: validation.warnings });
    }
    
    const { project: fixedProject, issues } = this.layoutService.validateAndFixTree(project);
    if (issues.length > 0) {
      this.logger.info('已修复数据问题', { projectId: project.id, issues });
    }
    
    return success(this.layoutService.rebalance(fixedProject));
  }

  /**
   * 验证并重新平衡项目（简化版）
   */
  validateAndRebalance(project: Project): Project {
    const result = this.validateAndRebalanceWithResult(project);
    if (isFailure(result)) {
      const errorMsg = result.error.message;
      this.logger.error('validateAndRebalance 失败', { error: errorMsg });
      this.toastService.error('数据验证失败', errorMsg);
      return sanitizeProject(project);
    }
    return result.value;
  }

  /**
   * 静默保存冲突到仓库
   */
  private async saveConflictSilently(
    localProject: Project, 
    remoteProject: Project,
    conflictedFields: string[]
  ): Promise<void> {
    await this.conflictStorage.saveConflict({
      projectId: localProject.id,
      localProject,
      remoteProject,
      remoteSnapshotFresh: true,
      conflictedAt: new Date().toISOString(),
      localVersion: localProject.version ?? 0,
      remoteVersion: remoteProject.version ?? 0,
      reason: 'version_mismatch',
      conflictedFields,
      acknowledged: false
    });
  }
}
