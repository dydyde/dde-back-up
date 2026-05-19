/**
 * LocalBackupService - 本地目录备份服务
 * 
 * 【P3 桌面坚果云备份 - C 层可选增强】
 * 
 * 职责：
 * - 使用 File System Access API 备份到本地目录
 * - 支持坚果云/Dropbox/OneDrive 同步目录
 * - 自动定时备份
 * - 备份文件版本管理
 * - IndexedDB 持久化 DirectoryHandle，跨会话保留
 * 
 * 限制：
 * - 仅桌面 Chrome 浏览器支持
 * - 需要用户手动授权
 * - 浏览器重启后需要重新验证权限（用户点击确认）
 * 
 * 设计理念：
 * - C 层是"第三层"增强，不是主依赖
 * - 提供用户可见的离线副本（心理安全感）
 * - 在极端情况下提供额外恢复途径
 * - 持久化状态确保用户设置不丢失
 */
import { Injectable, inject, signal, computed, OnDestroy } from '@angular/core';
import { get, set, del } from 'idb-keyval';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { UiStateService } from './ui-state.service';
import { PreferenceService } from './preference.service';
import { DisasterBackupService } from './disaster-backup.service';
import { ExportService } from './export.service';
import type { Project } from '../models';
import {
  LOCAL_BACKUP_CONFIG,
  LocalBackupResult,
  DirectoryAuthResult,
  LocalBackupStatus,
  LocalBackupCompatibility,
} from '../config/local-backup.config';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
// ============================================
// IndexedDB 存储键
// ============================================
const IDB_KEYS = {
  DIRECTORY_HANDLE: 'nanoflow.local-backup.directory-handle',
} as const;

type LocalBackupProjectSnapshot = { id: string; name: string; tasks: unknown[]; connections: unknown[] };

interface PermissionCheckOptions {
  request?: boolean;
}

interface BackupRunOptions {
  requestPermission?: boolean;
}

interface AutoBackupStartOptions {
  silent?: boolean;
}

// ============================================
// 服务实现
// ============================================

@Injectable({
  providedIn: 'root'
})
export class LocalBackupService implements OnDestroy {
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly logger = inject(LoggerService).category('LocalBackup');
  private readonly toast = inject(ToastService);
  private readonly disasterBackupService = inject(DisasterBackupService);
  private readonly exportService = inject(ExportService);
  private readonly uiState = inject(UiStateService);
  private readonly preferenceService = inject(PreferenceService);
  
  // 内部状态
  private directoryHandle: FileSystemDirectoryHandle | null = null;
  private restoreHandlePromise: Promise<boolean> | null = null;
  private autoBackupTimer: ReturnType<typeof setInterval> | null = null;
  /** 用于自动备份的项目获取函数（持久化后恢复使用） */
  private getProjectsFn: (() => LocalBackupProjectSnapshot[]) | null = null;
  
  // 响应式状态信号
  private readonly _isAuthorized = signal(false);
  private readonly _directoryName = signal<string | null>(null);
  private readonly _lastBackupTime = signal<string | null>(null);
  private readonly _autoBackupEnabled = signal(false);
  private readonly _autoBackupIntervalMs = signal(LOCAL_BACKUP_CONFIG.DEFAULT_INTERVAL_MS);
  private readonly _isBackingUp = signal(false);
  /** 是否有保存的 handle（需要用户点击恢复权限） */
  private readonly _hasSavedHandle = signal(false);
  /** 权限状态：granted=已授权, prompt=需要用户确认, denied=已拒绝 */
  private readonly _permissionState = signal<PermissionState | null>(null);
  
  // 公开的计算属性
  readonly isAuthorized = computed(() => this._isAuthorized());
  readonly directoryName = computed(() => this._directoryName());
  readonly lastBackupTime = computed(() => this._lastBackupTime());
  readonly autoBackupEnabled = computed(() => this._autoBackupEnabled());
  readonly autoBackupIntervalMs = computed(() => this._autoBackupIntervalMs());
  readonly isBackingUp = computed(() => this._isBackingUp());
  /** 是否有保存的 handle 但需要用户恢复权限 */
  readonly hasSavedHandle = computed(() => this._hasSavedHandle());
  /** 当前权限状态 */
  readonly permissionState = computed(() => this._permissionState());
  /** 是否需要用户点击恢复权限（有保存的 handle 但未授权） */
  readonly needsPermissionResume = computed(() => 
    this._hasSavedHandle() && !this._isAuthorized() && this._permissionState() === 'prompt'
  );
  
  /**
   * 平台兼容性检查
   */
  readonly compatibility = computed<LocalBackupCompatibility>(() => {
    const isDesktop = !this.uiState.isMobile();
    const isSupported = 'showDirectoryPicker' in window;
    
    if (!isDesktop) {
      return {
        isSupported: false,
        isDesktop: false,
        unsupportedReason: '移动设备不支持本地备份功能',
      };
    }
    
    if (!isSupported) {
      return {
        isSupported: false,
        isDesktop: true,
        unsupportedReason: '当前浏览器不支持 File System Access API，请使用 Chrome 浏览器',
      };
    }
    
    return {
      isSupported: true,
      isDesktop: true,
    };
  });
  
  /**
   * 是否可用（平台支持且功能可用）
   */
  readonly isAvailable = computed(() => this.compatibility().isSupported);
  
  /**
   * 完整状态
   */
  readonly status = computed<LocalBackupStatus>(() => ({
    isAuthorized: this._isAuthorized(),
    directoryName: this._directoryName() ?? undefined,
    lastBackupTime: this._lastBackupTime() ?? undefined,
    autoBackupEnabled: this._autoBackupEnabled(),
    autoBackupIntervalMs: this._autoBackupIntervalMs(),
  }));
  
  constructor() {
    // 先从 localStorage 加载基础状态
    this.loadPersistedState();
    // 然后从 IndexedDB 恢复 DirectoryHandle（异步）
    this.restoreHandlePromise = this.restoreFromIndexedDB();
  }
  
  ngOnDestroy(): void {
    this.stopAutoBackup();
  }
  
  // ============================================
  // 目录授权
  // ============================================
  
  /**
   * 请求目录访问授权
   * 用户可以选择坚果云同步目录或任意目录
   */
  async requestDirectoryAccess(): Promise<DirectoryAuthResult> {
    if (!this.isAvailable()) {
      const reason = this.compatibility().unsupportedReason || '功能不可用';
      return { success: false, error: reason };
    }
    
    try {
      this.logger.info('请求目录访问授权...');
      
      // 调用 File System Access API
      this.directoryHandle = await window.showDirectoryPicker!(LOCAL_BACKUP_CONFIG.DIRECTORY_PICKER_OPTIONS);
      
      const directoryName = this.directoryHandle.name;
      
      // 更新状态
      this._isAuthorized.set(true);
      this._directoryName.set(directoryName);
      this._hasSavedHandle.set(true);
      this._permissionState.set('granted');
      
      // 持久化到 IndexedDB 和 localStorage
      await this.saveDirectoryHandleToIDB();
      this.savePersistedState();

      if (this._autoBackupEnabled() && this.getProjectsFn) {
        this.startAutoBackup(this.getProjectsFn, undefined, { silent: true });
      }
      
      this.logger.info('目录授权成功', { directoryName });
      this.toast.success(`已选择备份目录：${directoryName}`);
      
      return { success: true, directoryName };
      
    } catch (error) {
      const e = error as Error;
      
      // 用户取消不算错误
      if (e.name === 'AbortError') {
        this.logger.info('用户取消目录选择');
        return { success: false, error: '已取消' };
      }
      
      this.logger.error('目录授权失败', error);
      this.sentryLazyLoader.captureException(error, { tags: { operation: 'localBackup.requestDirectory' } });
      
      return { success: false, error: e.message };
    }
  }
  
  /**
   * 检查并恢复目录权限
   * 浏览器重启后需要重新获取权限
   */
  async checkAndRestorePermission(options: PermissionCheckOptions = {}): Promise<boolean> {
    await this.ensureDirectoryHandleLoaded();

    if (!this.directoryHandle) {
      return false;
    }
    
    try {
      // 查询当前权限状态
      const permission = await this.directoryHandle.queryPermission({ mode: 'readwrite' });
      this._permissionState.set(permission);
      
      if (permission === 'granted') {
        this._isAuthorized.set(true);
        return true;
      }
      
      if (options.request === false) {
        this._isAuthorized.set(false);
        return false;
      }

      // 尝试请求权限（必须由用户手势触发）
      const request = await this.directoryHandle.requestPermission({ mode: 'readwrite' });
      this._permissionState.set(request);
      
      if (request === 'granted') {
        this._isAuthorized.set(true);
        return true;
      }
      
      return false;
      
    } catch (error) {
      this.logger.warn('权限检查失败', error);
      this._permissionState.set('denied');
      return false;
    }
  }
  
  /**
   * 恢复权限（由用户手势触发）
   * 用于浏览器重启后重新获取权限
   */
  async resumePermission(): Promise<boolean> {
    if (!this.directoryHandle) {
      // 尝试从 IndexedDB 恢复 handle
      const restored = await this.ensureDirectoryHandleLoaded();
      if (!restored || !this.directoryHandle) {
        this.toast.error('未找到保存的备份目录，请重新选择');
        return false;
      }
    }
    
    try {
      const permission = await this.directoryHandle.requestPermission({ mode: 'readwrite' });
      this._permissionState.set(permission);
      
      if (permission === 'granted') {
        this._isAuthorized.set(true);
        this._directoryName.set(this.directoryHandle.name);
        this.toast.success(`已恢复备份目录：${this.directoryHandle.name}`);
        
        // 如果之前启用了自动备份，自动恢复
        if (this._autoBackupEnabled() && this.getProjectsFn) {
          this.startAutoBackup(this.getProjectsFn);
          this.logger.info('自动备份已自动恢复');
        }
        
        return true;
      }
      
      this.toast.info('权限请求被拒绝');
      return false;
      
    } catch (error) {
      this.logger.error('恢复权限失败', error);
      this.toast.error('恢复权限失败');
      return false;
    }
  }
  
  /**
   * 撤销目录授权
   */
  async revokeDirectoryAccess(): Promise<void> {
    this.directoryHandle = null;
    this._isAuthorized.set(false);
    this._directoryName.set(null);
    this._hasSavedHandle.set(false);
    this._permissionState.set(null);
    this.stopAutoBackup();
    
    // 清除 IndexedDB 中的 handle
    await this.clearDirectoryHandleFromIDB();
    this.clearPersistedState();
    
    this.logger.info('目录授权已撤销');
    this.toast.info('已取消本地备份目录');
  }
  
  // ============================================
  // 备份操作
  // ============================================
  
  /**
   * 执行本地备份
   * @param projects 要备份的项目列表
   */
  async performBackup(projects: LocalBackupProjectSnapshot[], options: BackupRunOptions = {}): Promise<LocalBackupResult> {
    await this.ensureDirectoryHandleLoaded();

    if (!this.directoryHandle) {
      return { success: false, error: '未授权目录访问，请先选择备份目录' };
    }
    
    if (this._isBackingUp()) {
      return { success: false, error: '备份正在进行中' };
    }
    
    // 检查权限
    const hasPermission = await this.checkAndRestorePermission({ request: options.requestPermission !== false });
    if (!hasPermission) {
      this._isAuthorized.set(false);
      return { success: false, error: '目录访问权限已过期，请重新授权' };
    }
    
    this._isBackingUp.set(true);
    
    try {
      this.logger.info('开始本地备份...', { projectCount: projects.length });
      
      const { blob } = await this.disasterBackupService.buildLocalBlob(projects as Project[], {
        autoBackupEnabled: this._autoBackupEnabled(),
        autoBackupIntervalMs: this._autoBackupIntervalMs(),
      });
      
      // 生成文件名
      const timestamp = this.formatTimestamp();
      const filename = `${LOCAL_BACKUP_CONFIG.FILENAME_PREFIX}-${timestamp}${LOCAL_BACKUP_CONFIG.FILE_EXTENSION}`;
      
      // 写入文件
      const fileHandle = await this.directoryHandle.getFileHandle(filename, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(blob);
      await writable.close();
      
      // 验证写入（可选）
      if (LOCAL_BACKUP_CONFIG.VALIDATION.VERIFY_WRITE) {
        const verified = await this.verifyBackupFile(fileHandle, blob.size);
        if (!verified) {
          this.logger.warn('备份文件验证失败，但文件已写入');
        }
      }
      
      // 清理旧备份
      await this.cleanupOldBackups();
      
      // 更新状态
      const backupTime = new Date().toISOString();
      this._lastBackupTime.set(backupTime);
      this.savePersistedState();
      this.exportService.recordLocalBackupSuccess(backupTime);
      
      this.logger.info('本地备份完成', { filename, size: blob.size });
      
      return {
        success: true,
        filename,
        size: blob.size,
        timestamp: backupTime,
        pathHint: `${this._directoryName()}/${filename}`,
      };
      
    } catch (error) {
      const e = error as Error;
      this.logger.error('本地备份失败', error);
      this.sentryLazyLoader.captureException(error, { tags: { operation: 'localBackup.perform' } });
      
      return { success: false, error: e.message };
      
    } finally {
      this._isBackingUp.set(false);
    }
  }
  
  /**
   * 验证备份文件
   */
  private async verifyBackupFile(fileHandle: FileSystemFileHandle, expectedSize: number): Promise<boolean> {
    try {
      const file = await fileHandle.getFile();
      return file.size === expectedSize;
    } catch (e) {
      this.logger.debug('验证备份文件失败', { error: e, expectedSize });
      return false;
    }
  }
  
  /**
   * 清理旧备份文件
   */
  private async cleanupOldBackups(): Promise<void> {
    if (!this.directoryHandle) return;
    
    try {
      const backupFiles: { name: string; timestamp: number }[] = [];
      
      // 遍历目录，收集备份文件
      for await (const entry of this.directoryHandle.values()) {
        if (entry.kind === 'file' && entry.name.startsWith(LOCAL_BACKUP_CONFIG.FILENAME_PREFIX)) {
          // 从文件名解析时间戳
          const timestamp = this.parseTimestampFromFilename(entry.name);
          if (timestamp) {
            backupFiles.push({ name: entry.name, timestamp });
          }
        }
      }
      
      // 按时间排序，保留最新的
      backupFiles.sort((a, b) => b.timestamp - a.timestamp);
      
      // 删除超出数量限制的旧文件
      const toDelete = backupFiles.slice(LOCAL_BACKUP_CONFIG.MAX_BACKUP_FILES);
      
      for (const file of toDelete) {
        try {
          await this.directoryHandle.removeEntry(file.name);
          this.logger.debug('已删除旧备份', { filename: file.name });
        } catch (e) {
          this.logger.warn('删除旧备份失败', { filename: file.name, error: e });
        }
      }
      
      if (toDelete.length > 0) {
        this.logger.info(`清理了 ${toDelete.length} 个旧备份文件`);
      }
      
    } catch (error) {
      this.logger.warn('清理旧备份时出错', error);
    }
  }
  
  // ============================================
  // 备份浏览与恢复
  // ============================================
  
  /**
   * 列出备份目录中的所有备份文件
   * @returns 按时间倒序排列的备份文件列表
   */
  async listBackupFiles(): Promise<{ name: string; timestamp: number; size: number }[]> {
    if (!this.directoryHandle) {
      return [];
    }
    
    const hasPermission = await this.checkAndRestorePermission();
    if (!hasPermission) {
      return [];
    }
    
    try {
      const files: { name: string; timestamp: number; size: number }[] = [];
      
      for await (const entry of this.directoryHandle.values()) {
        if (entry.kind === 'file' && entry.name.startsWith(LOCAL_BACKUP_CONFIG.FILENAME_PREFIX)) {
          const timestamp = this.parseTimestampFromFilename(entry.name);
          if (timestamp) {
            const fileHandle = await this.directoryHandle.getFileHandle(entry.name);
            const file = await fileHandle.getFile();
            files.push({ name: entry.name, timestamp, size: file.size });
          }
        }
      }
      
      files.sort((a, b) => b.timestamp - a.timestamp);
      return files;
    } catch (error) {
      this.logger.error('列出备份文件失败', error);
      return [];
    }
  }
  
  /**
   * 从备份目录读取指定备份文件为 File 对象
   * 返回的 File 可以直接传入 ImportService.validateFile() 进行导入
   */
  async readBackupFile(filename: string): Promise<File | null> {
    if (!this.directoryHandle) {
      return null;
    }
    
    const hasPermission = await this.checkAndRestorePermission();
    if (!hasPermission) {
      return null;
    }
    
    try {
      const fileHandle = await this.directoryHandle.getFileHandle(filename);
      return await fileHandle.getFile();
    } catch (error) {
      this.logger.error('读取备份文件失败', { filename, error });
        return null; // eslint-disable-line no-restricted-syntax -- 文件读取失败时"无法获取"语义正确，null 触发调用方错误提示
    }
  }
  
  // ============================================
  // 自动备份
  // ============================================
  
  /**
   * 启动自动备份
   * @param getProjects 获取项目列表的函数
   * @param intervalMs 备份间隔（毫秒）
   */
  startAutoBackup(
    getProjects: () => LocalBackupProjectSnapshot[],
    intervalMs?: number,
    options: AutoBackupStartOptions = {},
  ): void {
    if (!this._isAuthorized()) {
      this.logger.warn('未授权目录，无法启动自动备份');
      return;
    }
    
    // 停止现有定时器
    this.stopAutoBackup(false); // 不更新状态，避免循环
    
    const interval = intervalMs ?? this._autoBackupIntervalMs();
    
    // 保存获取项目的函数，用于权限恢复后自动恢复备份
    this.getProjectsFn = getProjects;
    
    this.autoBackupTimer = setInterval(async () => {
      const projects = getProjects();
      if (projects.length > 0) {
        const result = await this.performBackup(projects, { requestPermission: false });
        if (result.success) {
          this.logger.debug('自动备份成功', { filename: result.filename });
        } else {
          this.logger.warn('自动备份失败', { error: result.error });
        }
      }
    }, interval);
    
    this._autoBackupEnabled.set(true);
    this._autoBackupIntervalMs.set(interval);
    this.savePersistedState();
    
    this.logger.info('自动备份已启动', { intervalMs: interval });
    if (!options.silent) {
      this.toast.success('自动备份已开启');
    }
  }
  
  /**
   * 停止自动备份
   * @param updateState 是否更新状态（默认 true）
   */
  stopAutoBackup(updateState = true): void {
    if (this.autoBackupTimer) {
      clearInterval(this.autoBackupTimer);
      this.autoBackupTimer = null;
    }
    
    if (updateState) {
      this._autoBackupEnabled.set(false);
      this.savePersistedState();
      this.logger.info('自动备份已停止');
    }
  }
  
  /**
   * 设置自动备份间隔
   */
  setAutoBackupInterval(intervalMs: number): void {
    this._autoBackupIntervalMs.set(intervalMs);
    this.savePersistedState();
    if (this._autoBackupEnabled() && this._isAuthorized() && this.getProjectsFn) {
      this.startAutoBackup(this.getProjectsFn, intervalMs, { silent: true });
    }
  }
  
  // ============================================
  // 辅助方法
  // ============================================
  
  /**
   * 格式化时间戳用于文件名
   */
  private formatTimestamp(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hour = String(now.getHours()).padStart(2, '0');
    const minute = String(now.getMinutes()).padStart(2, '0');
    const second = String(now.getSeconds()).padStart(2, '0');
    
    return `${year}-${month}-${day}_${hour}-${minute}-${second}`;
  }
  
  /**
   * 从文件名解析时间戳
   */
  private parseTimestampFromFilename(filename: string): number | null {
    // 匹配格式：nanoflow-backup-2026-01-02_12-30-45.json
    const match = filename.match(/(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/);
    if (!match) return null;
    
    const [, year, month, day, hour, minute, second] = match;
    const date = new Date(
      parseInt(year),
      parseInt(month) - 1,
      parseInt(day),
      parseInt(hour),
      parseInt(minute),
      parseInt(second)
    );
    
    return date.getTime();
  }
  
  // ============================================
  // 状态持久化
  // ============================================
  
  /**
   * 加载持久化状态（localStorage）
   */
  private loadPersistedState(): void {
    try {
      const lastBackupTime = localStorage.getItem(LOCAL_BACKUP_CONFIG.STORAGE_KEYS.LAST_BACKUP_TIME);
      if (lastBackupTime) {
        this._lastBackupTime.set(lastBackupTime);
      }
      
      const autoEnabled = localStorage.getItem(LOCAL_BACKUP_CONFIG.STORAGE_KEYS.AUTO_BACKUP_ENABLED);
      if (autoEnabled === 'true') {
        this._autoBackupEnabled.set(true);
      }
      
      const interval = localStorage.getItem(LOCAL_BACKUP_CONFIG.STORAGE_KEYS.AUTO_BACKUP_INTERVAL);
      if (interval) {
        this._autoBackupIntervalMs.set(parseInt(interval, 10));
      }
      
      // 加载保存的目录名称
      const directoryName = localStorage.getItem(LOCAL_BACKUP_CONFIG.STORAGE_KEYS.DIRECTORY_HANDLE);
      if (directoryName) {
        this._directoryName.set(directoryName);
        this._hasSavedHandle.set(true);
      }
      
    } catch (error) {
      this.logger.warn('加载持久化状态失败', error);
    }
  }
  
  /**
   * 保存持久化状态（localStorage + 云端同步）
   */
  private savePersistedState(): void {
    try {
      const lastBackupTime = this._lastBackupTime();
      if (lastBackupTime) {
        localStorage.setItem(LOCAL_BACKUP_CONFIG.STORAGE_KEYS.LAST_BACKUP_TIME, lastBackupTime);
      }
      
      localStorage.setItem(
        LOCAL_BACKUP_CONFIG.STORAGE_KEYS.AUTO_BACKUP_ENABLED,
        String(this._autoBackupEnabled())
      );
      
      localStorage.setItem(
        LOCAL_BACKUP_CONFIG.STORAGE_KEYS.AUTO_BACKUP_INTERVAL,
        String(this._autoBackupIntervalMs())
      );
      
      // 保存目录名称（用于 UI 显示）
      const directoryName = this._directoryName();
      if (directoryName) {
        localStorage.setItem(LOCAL_BACKUP_CONFIG.STORAGE_KEYS.DIRECTORY_HANDLE, directoryName);
      }
      
      // 同步到云端（仅同步开关和间隔，不同步目录路径）
      void this.preferenceService.syncLocalBackupSettings({
        autoBackupEnabled: this._autoBackupEnabled(),
        autoBackupIntervalMs: this._autoBackupIntervalMs(),
      });
      
    } catch (error) {
      this.logger.warn('保存持久化状态失败', error);
    }
  }
  
  /**
   * 清除持久化状态
   */
  private clearPersistedState(): void {
    try {
      Object.values(LOCAL_BACKUP_CONFIG.STORAGE_KEYS).forEach(key => {
        localStorage.removeItem(key);
      });
    } catch (error) {
      this.logger.warn('清除持久化状态失败', error);
    }
  }
  
  // ============================================
  // IndexedDB 持久化（DirectoryHandle）
  // ============================================
  
  /**
   * 保存 DirectoryHandle 到 IndexedDB
   */
  private async saveDirectoryHandleToIDB(): Promise<void> {
    if (!this.directoryHandle) return;
    
    try {
      await set(IDB_KEYS.DIRECTORY_HANDLE, this.directoryHandle);
      this.logger.debug('DirectoryHandle 已保存到 IndexedDB');
    } catch (error) {
      this.logger.warn('保存 DirectoryHandle 到 IndexedDB 失败', error);
    }
  }
  
  /**
   * 从 IndexedDB 恢复 DirectoryHandle
   * @returns 是否成功恢复
   */
  private async restoreFromIndexedDB(): Promise<boolean> {
    if (!this.isAvailable()) return false;
    
    try {
      const handle = await get<FileSystemDirectoryHandle>(IDB_KEYS.DIRECTORY_HANDLE);
      
      if (!handle) {
        this.logger.debug('IndexedDB 中没有保存的 DirectoryHandle');
        return false;
      }
      
      this.directoryHandle = handle;
      this._directoryName.set(handle.name);
      this._hasSavedHandle.set(true);
      
      // 检查权限状态（不请求权限，只查询）
      try {
        const permission = await handle.queryPermission({ mode: 'readwrite' });
        this._permissionState.set(permission);
        
        if (permission === 'granted') {
          // 权限仍然有效，自动恢复
          this._isAuthorized.set(true);
          this.logger.info('DirectoryHandle 权限仍然有效，已自动恢复', { name: handle.name });
          
          if (this._autoBackupEnabled()) {
            if (this.getProjectsFn) {
              this.startAutoBackup(this.getProjectsFn, undefined, { silent: true });
              this.logger.info('自动备份已随目录权限恢复');
            } else {
              this.logger.info('等待设置项目获取函数后恢复自动备份');
            }
          }
          
          return true;
        } else if (permission === 'prompt') {
          // 需要用户点击恢复权限
          this.logger.info('DirectoryHandle 已恢复，等待用户授权', { name: handle.name });
          return true;
        } else {
          // 权限被拒绝
          this.logger.warn('DirectoryHandle 权限已被拒绝');
          return false;
        }
      } catch (permError) {
        this.logger.warn('查询权限失败', permError);
        this._permissionState.set('prompt');
        return true; // handle 存在，但需要用户确认
      }
      
    } catch (error) {
      this.logger.warn('从 IndexedDB 恢复 DirectoryHandle 失败', error);
      return false;
    }
  }

  private async ensureDirectoryHandleLoaded(): Promise<boolean> {
    if (this.directoryHandle) return true;
    if (!this.restoreHandlePromise) {
      this.restoreHandlePromise = this.restoreFromIndexedDB();
    }
    await this.restoreHandlePromise;
    return !!this.directoryHandle;
  }
  
  /**
   * 清除 IndexedDB 中的 DirectoryHandle
   */
  private async clearDirectoryHandleFromIDB(): Promise<void> {
    try {
      await del(IDB_KEYS.DIRECTORY_HANDLE);
      this.logger.debug('DirectoryHandle 已从 IndexedDB 清除');
    } catch (error) {
      this.logger.warn('清除 IndexedDB 中的 DirectoryHandle 失败', error);
    }
  }
  
  /**
   * 设置项目获取函数（用于权限恢复后自动启动备份）
   * 应在应用初始化时调用
   */
  setProjectsProvider(getProjects: () => LocalBackupProjectSnapshot[]): void {
    this.getProjectsFn = getProjects;
    
    // 如果权限已授权且自动备份已启用，立即启动
    if (this._isAuthorized() && this._autoBackupEnabled() && !this.autoBackupTimer) {
      this.logger.info('权限已授权，正在恢复自动备份...');
      this.startAutoBackup(getProjects, undefined, { silent: true });
    }
  }
}
