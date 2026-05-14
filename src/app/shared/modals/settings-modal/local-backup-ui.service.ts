import { signal, inject, Injectable } from '@angular/core';
import { LocalBackupService } from '../../../../services/local-backup.service';
import { ImportService } from '../../../../services/import.service';
import { LoggerService } from '../../../../services/logger.service';
import { LOCAL_BACKUP_CONFIG } from '../../../../config/local-backup.config';
import type { Project } from '../../../../models';
import type { ExportData } from '../../../../services/export.service';

/**
 * 本地备份 UI 服务
 *
 * 职责：
 * - 备份/恢复流程的 UI 状态管理
 * - 备份文件列表展示与选择
 * - 恢复预览与确认流程
 * - 自动备份开关协调
 *
 * 从 SettingsModalComponent 抽离（2026-05-13）
 */
@Injectable()
export class LocalBackupUIService {
  private readonly localBackupService = inject(LocalBackupService);
  private readonly importService = inject(ImportService);
  private readonly logger = inject(LoggerService);

  /** 恢复流程状态 */
  readonly restoreStep = signal<'idle' | 'list' | 'loading' | 'preview' | 'restoring' | 'done' | 'error'>('idle');
  readonly restoreBackupFiles = signal<{ name: string; timestamp: number; size: number }[]>([]);
  readonly restoreSelectedIndex = signal<number>(-1);
  readonly restorePreview = signal<{ projects: number; tasks: number; connections: number } | null>(null);
  readonly restoreError = signal<string>('');
  readonly restoreResultMsg = signal<string>('');
  readonly isRestoringFromBackup = signal(false);

  /** 缓存待恢复的验证数据（跨步骤） */
  private _pendingRestoreData: ExportData | null = null;

  constructor() {
    // Empty constructor for Angular DI
  }

  /**
   * 设置本地备份目录
   */
  async handleSetupLocalBackup(): Promise<void> {
    await this.localBackupService.requestDirectoryAccess();
  }

  /**
   * 取消本地备份授权
   */
  async handleRevokeLocalBackup(): Promise<boolean> {
    if (!confirm('确定要取消本地备份吗？')) {
      return false;
    }
    await this.localBackupService.revokeDirectoryAccess();
    return true;
  }

  /**
   * 手动执行本地备份
   */
  async handleManualBackup(projects: Project[]): Promise<void> {
    if (projects.length === 0) {
      alert('没有可备份的项目');
      return;
    }

    const result = await this.localBackupService.performBackup(projects);

    if (result.success) {
      alert(`备份成功！\n文件：${result.filename}\n位置：${result.pathHint}`);
    } else {
      alert(`备份失败：${result.error}`);
    }
  }

  /**
   * 从本地备份恢复 — 打开文件列表面板
   */
  async handleRestoreFromLocalBackup(): Promise<void> {
    this.restoreStep.set('loading');
    this.restoreSelectedIndex.set(-1);
    this.restorePreview.set(null);
    this.restoreError.set('');
    this.restoreResultMsg.set('');
    try {
      const files = await this.localBackupService.listBackupFiles();
      this.restoreBackupFiles.set(files);
      this.restoreStep.set('list');
    } catch (error: unknown) {
      this.logger.error('列出备份文件失败', error instanceof Error ? error.message : String(error));
      this.restoreError.set('读取备份目录失败');
      this.restoreStep.set('error');
    }
  }

  /** 选择备份文件 */
  selectRestoreFile(index: number): void {
    this.restoreSelectedIndex.set(index);
  }

  /** 格式化备份文件日期 */
  formatBackupDate(timestamp: number): string {
    return new Date(timestamp).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  /** 格式化备份文件大小 */
  formatBackupSize(size: number): string {
    return size >= 1048576 ? `${(size / 1048576).toFixed(1)} MB` : `${Math.round(size / 1024)} KB`;
  }

  /** 加载所选备份的预览信息 */
  async loadRestorePreview(existingProjects: Project[]): Promise<void> {
    const idx = this.restoreSelectedIndex();
    const files = this.restoreBackupFiles();
    if (idx < 0 || idx >= files.length) return;

    this.restoreStep.set('loading');
    try {
      const file = await this.localBackupService.readBackupFile(files[idx].name);
      if (!file) {
        this.restoreError.set('无法读取备份文件');
        this.restoreStep.set('error');
        return;
      }

      const validation = await this.importService.validateFile(file);
      if (!validation.valid || !validation.data) {
        this.restoreError.set(`验证失败：${validation.error ?? '未知错误'}`);
        this.restoreStep.set('error');
        return;
      }

      // 缓存验证数据
      this._pendingRestoreData = validation.data;

      const preview = await this.importService.generatePreview(validation.data, existingProjects);
      this.restorePreview.set({
        projects: preview.projects.length,
        tasks: preview.projects.reduce((s, p) => s + p.taskCount, 0),
        connections: preview.projects.reduce((s, p) => s + p.connectionCount, 0),
      });
      this.restoreStep.set('preview');
    } catch (error: unknown) {
      this.logger.error('读取备份预览失败', error instanceof Error ? error.message : String(error));
      this.restoreError.set('读取备份文件失败');
      this.restoreStep.set('error');
    }
  }

  /** 确认恢复 */
  async confirmRestore(
    existingProjects: Project[],
    onImportComplete: (project: Project) => void | Promise<void>,
  ): Promise<void> {
    if (!this._pendingRestoreData) return;
    this.restoreStep.set('restoring');
    this.isRestoringFromBackup.set(true);
    try {
      const result = await this.importService.executeImport(
        this._pendingRestoreData,
        existingProjects,
        { conflictStrategy: 'merge' },
        onImportComplete,
      );

      if (result.success) {
        this.restoreResultMsg.set(`恢复成功！已导入 ${result.importedCount} 个项目`);
        this.restoreStep.set('done');
      } else {
        this.restoreError.set(`恢复失败：${result.error ?? '未知错误'}`);
        this.restoreStep.set('error');
      }
    } catch (error: unknown) {
      this.logger.error('从本地备份恢复失败', error instanceof Error ? error.message : String(error));
      this.restoreError.set('恢复过程中发生错误');
      this.restoreStep.set('error');
    } finally {
      this.isRestoringFromBackup.set(false);
      this._pendingRestoreData = null;
    }
  }

  /** 取消/关闭恢复面板 */
  cancelRestore(): void {
    this.restoreStep.set('idle');
    this._pendingRestoreData = null;
  }

  /**
   * 切换自动备份
   * 开启时自动请求权限（用户点击开关本身就是用户手势）
   */
  async toggleAutoBackup(projectsProvider: () => Project[]): Promise<void> {
    if (this.localBackupService.autoBackupEnabled()) {
      // 关闭自动备份
      this.localBackupService.stopAutoBackup();
    } else {
      // 开启自动备份
      // 先确保已授权（浏览器重启后需要重新请求权限）
      if (!this.localBackupService.isAuthorized()) {
        // 设置项目提供者
        this.localBackupService.setProjectsProvider(projectsProvider);
        // 请求权限（用户点击开关就是用户手势，可以触发权限请求）
        const granted = await this.localBackupService.resumePermission();
        if (!granted) {
          // 权限请求失败或被拒绝，不开启自动备份
          return;
        }
      }

      // 权限已授予，启动自动备份
      this.localBackupService.startAutoBackup(projectsProvider, LOCAL_BACKUP_CONFIG.DEFAULT_INTERVAL_MS);
    }
  }
}
