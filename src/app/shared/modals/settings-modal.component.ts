import { Component, inject, output, input, computed, viewChild, ElementRef, isDevMode, ChangeDetectionStrategy, effect, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { LoggerService } from '../../../services/logger.service';
import { UserSessionService } from '../../../services/user-session.service';
import { PreferenceService } from '../../../services/preference.service';
import { ExportService, type ExportData } from '../../../services/export.service';
import { ImportService, ImportOptions } from '../../../services/import.service';
import { AttachmentExportService } from '../../../services/attachment-export.service';
import { AttachmentImportService, type AttachmentImportItem } from '../../../services/attachment-import.service';
import { LocalBackupService } from '../../../services/local-backup.service';
import { ThemeService } from '../../../services/theme.service';
import { DockEngineService } from '../../../services/dock-engine.service';
import { FocusPreferenceService } from '../../../services/focus-preference.service';
import { GateService } from '../../../services/gate.service';
import { LocalBackupUIService } from './settings-modal/local-backup-ui.service';
import { ThemeType, ColorMode, Project } from '../../../models';
import { LOCAL_BACKUP_CONFIG } from '../../../config/local-backup.config';
import { SIYUAN_CONFIG, SIYUAN_ERROR_MESSAGES } from '../../../config/siyuan.config';
import { ExternalSourceCacheService } from '../../core/external-sources/external-source-cache.service';
import { SiyuanPreviewService } from '../../core/external-sources/siyuan/siyuan-preview.service';
import { isTrustedSiyuanDirectBaseUrl } from '../../core/external-sources/siyuan/siyuan-direct-provider';
import type { SiyuanRuntimeMode } from '../../core/external-sources/external-source.model';

interface TaskAttachmentMetadata {
  id: string;
  name: string;
  size: number;
  mimeType: string;
}

const SIYUAN_TOKEN_MASK = '••••••••';

@Component({
  selector: 'app-settings-modal',
  standalone: true,
  imports: [CommonModule, FormsModule],
  providers: [LocalBackupUIService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="fixed inset-0 bg-black/40 z-50 flex items-center justify-center backdrop-blur-sm animate-fade-in p-2 sm:p-4" (click)="close.emit()">
      <div data-testid="settings-modal" class="bg-slate-50 dark:bg-stone-900 rounded-2xl shadow-2xl w-full max-w-[420px] animate-scale-in max-h-[calc(100vh-1rem)] sm:max-h-[85vh] flex flex-col overflow-hidden ring-1 ring-slate-900/5 dark:ring-stone-700" (click)="$event.stopPropagation()">
        <!-- 头部 -->
        <div class="px-4 py-3 border-b border-slate-200/60 dark:border-stone-700 flex items-center justify-between bg-white dark:bg-stone-800 sticky top-0 z-10">
          <h2 class="text-base font-bold text-slate-800 dark:text-stone-200">系统设置</h2>
          <button (click)="close.emit()" class="p-1.5 hover:bg-slate-100 dark:hover:bg-stone-700 rounded-full transition-colors text-slate-400 dark:text-stone-500 hover:text-slate-600 dark:hover:text-stone-300">
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        
        <div class="flex-1 overflow-y-auto overflow-x-hidden p-3 space-y-4 custom-scrollbar">
          
          <!-- 账户信息 (置顶) -->
          <section class="bg-white dark:bg-stone-800 rounded-xl border border-slate-200 dark:border-stone-700 shadow-sm p-3">
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-3">
                <div class="w-8 h-8 rounded-full bg-slate-100 dark:bg-stone-700 flex items-center justify-center text-slate-400 dark:text-stone-500 ring-1 ring-slate-200 dark:ring-stone-600">
                  <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>
                </div>
                <div>
                  <div class="text-xs font-bold text-slate-700 dark:text-stone-200">
                    {{ userSession.currentUserId() ? (sessionEmail() || "已登录用户") : "访客模式" }}
                  </div>
                  <div class="text-[10px] flex items-center gap-1.5" [class.text-emerald-600]="userSession.currentUserId()" [class.text-slate-400]="!userSession.currentUserId()">
                    <span class="w-1.5 h-1.5 rounded-full" [class.bg-emerald-500]="userSession.currentUserId()" [class.bg-slate-300]="!userSession.currentUserId()"></span>
                    {{ userSession.currentUserId() ? "云端同步中" : "仅本地存储" }}
                  </div>
                </div>
              </div>
              @if (userSession.currentUserId()) {
                <button (click)="signOut.emit()" class="px-2.5 py-1 text-[10px] font-bold text-slate-500 dark:text-stone-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-md transition-colors">退出</button>
              }
            </div>
          </section>

          <!-- 系统仪表盘入口 -->
          <section>
            <div class="group rounded-xl border border-indigo-100 dark:border-indigo-900/50 bg-indigo-50/40 dark:bg-indigo-900/20 p-2.5 hover:bg-indigo-50 dark:hover:bg-indigo-900/40 transition-all cursor-pointer flex items-center justify-between" (click)="openDashboard.emit()">
              <div class="flex items-center gap-2.5">
                <div class="w-7 h-7 rounded-lg bg-indigo-500 dark:bg-indigo-600 flex items-center justify-center shadow-sm shadow-indigo-200 dark:shadow-indigo-900/50 group-hover:scale-105 transition-transform">
                  <svg class="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                  </svg>
                </div>
                <div>
                  <div class="text-xs font-bold text-indigo-900 dark:text-indigo-300">系统仪表盘</div>
                  <div class="text-[10px] text-indigo-600/70 dark:text-indigo-400/70">查看同步状态与冲突</div>
                </div>
              </div>
              <svg class="w-3 h-3 text-indigo-300 dark:text-indigo-500 group-hover:text-indigo-500 dark:group-hover:text-indigo-400 group-hover:translate-x-0.5 transition-all" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </div>
          </section>
          
          <!-- 主题设置 -->
          <section class="space-y-1.5">
            <h3 class="text-[10px] font-bold text-slate-400 dark:text-stone-500 uppercase tracking-wider px-1">外观风格</h3>
            <div class="bg-white dark:bg-stone-800 border border-slate-200 dark:border-stone-700 rounded-xl p-2.5 shadow-sm space-y-3">
              
              <!-- 颜色模式切换 -->
              <div class="flex flex-wrap items-center justify-between gap-y-1.5 pb-2 border-b border-slate-100 dark:border-stone-700">
                <span class="text-xs font-medium text-slate-600 dark:text-stone-400">颜色模式</span>
                <div class="flex items-center gap-1 bg-slate-100 dark:bg-stone-700 rounded-lg p-0.5">
                  <!-- 浅色 -->
                  <button 
                    (click)="updateColorMode('light')"
                    class="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium transition-all"
                    [ngClass]="{
                      'bg-white dark:bg-stone-600 shadow-sm text-slate-800 dark:text-stone-200': themeService.colorMode() === 'light',
                      'text-slate-500 dark:text-stone-400': themeService.colorMode() !== 'light'
                    }">
                    <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
                    </svg>
                    浅色
                  </button>
                  <!-- 系统 -->
                  <button 
                    (click)="updateColorMode('system')"
                    class="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium transition-all"
                    [ngClass]="{
                      'bg-white dark:bg-stone-600 shadow-sm text-slate-800 dark:text-stone-200': themeService.colorMode() === 'system',
                      'text-slate-500 dark:text-stone-400': themeService.colorMode() !== 'system'
                    }">
                    <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                    </svg>
                    自动
                  </button>
                  <!-- 深色 -->
                  <button 
                    (click)="updateColorMode('dark')"
                    class="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium transition-all"
                    [ngClass]="{
                      'bg-white dark:bg-stone-600 shadow-sm text-slate-800 dark:text-stone-200': themeService.colorMode() === 'dark',
                      'text-slate-500 dark:text-stone-400': themeService.colorMode() !== 'dark'
                    }">
                    <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
                    </svg>
                    深色
                  </button>
                </div>
              </div>
              
              <!-- 色调主题选择 -->
              <div class="grid grid-cols-5 gap-2">
                <!-- 默认主题 -->
                <button (click)="updateTheme('default')" 
                        class="flex flex-col items-center gap-1.5 p-1.5 rounded-lg transition-all group hover:bg-slate-50 dark:hover:bg-stone-700"
                        [ngClass]="{
                          'bg-slate-50 dark:bg-stone-700': preferenceService.theme() === 'default'
                        }">
                  <div class="w-5 h-5 rounded-full bg-gradient-to-br from-slate-100 to-slate-300 border-2 group-hover:scale-110 transition-transform shadow-sm"
                       [class.border-indigo-500]="preferenceService.theme() === 'default'"
                       [class.border-transparent]="preferenceService.theme() !== 'default'"></div>
                  <span class="text-[9px] font-medium" [class.text-indigo-600]="preferenceService.theme() === 'default'" [class.text-slate-500]="preferenceService.theme() !== 'default'">默认</span>
                </button>
                
                <!-- 海洋主题 -->
                <button (click)="updateTheme('ocean')" 
                        class="flex flex-col items-center gap-1.5 p-1.5 rounded-lg transition-all group hover:bg-slate-50 dark:hover:bg-stone-700"
                        [ngClass]="{
                          'bg-slate-50 dark:bg-stone-700': preferenceService.theme() === 'ocean'
                        }">
                  <div class="w-5 h-5 rounded-full bg-gradient-to-br from-sky-200 to-cyan-400 border-2 group-hover:scale-110 transition-transform shadow-sm"
                       [class.border-sky-500]="preferenceService.theme() === 'ocean'"
                       [class.border-transparent]="preferenceService.theme() !== 'ocean'"></div>
                  <span class="text-[9px] font-medium" [class.text-sky-600]="preferenceService.theme() === 'ocean'" [class.text-slate-500]="preferenceService.theme() !== 'ocean'">海洋</span>
                </button>
                
                <!-- 森林主题 -->
                <button (click)="updateTheme('forest')" 
                        class="flex flex-col items-center gap-1.5 p-1.5 rounded-lg transition-all group hover:bg-slate-50 dark:hover:bg-stone-700"
                        [ngClass]="{
                          'bg-slate-50 dark:bg-stone-700': preferenceService.theme() === 'forest'
                        }">
                  <div class="w-5 h-5 rounded-full bg-gradient-to-br from-green-200 to-emerald-400 border-2 group-hover:scale-110 transition-transform shadow-sm"
                       [class.border-green-500]="preferenceService.theme() === 'forest'"
                       [class.border-transparent]="preferenceService.theme() !== 'forest'"></div>
                  <span class="text-[9px] font-medium" [class.text-green-600]="preferenceService.theme() === 'forest'" [class.text-slate-500]="preferenceService.theme() !== 'forest'">森林</span>
                </button>
                
                <!-- 日落主题 -->
                <button (click)="updateTheme('sunset')" 
                        class="flex flex-col items-center gap-1.5 p-1.5 rounded-lg transition-all group hover:bg-slate-50 dark:hover:bg-stone-700"
                        [ngClass]="{
                          'bg-slate-50 dark:bg-stone-700': preferenceService.theme() === 'sunset'
                        }">
                  <div class="w-5 h-5 rounded-full bg-gradient-to-br from-orange-200 to-red-400 border-2 group-hover:scale-110 transition-transform shadow-sm"
                       [class.border-orange-500]="preferenceService.theme() === 'sunset'"
                       [class.border-transparent]="preferenceService.theme() !== 'sunset'"></div>
                  <span class="text-[9px] font-medium" [class.text-orange-600]="preferenceService.theme() === 'sunset'" [class.text-slate-500]="preferenceService.theme() !== 'sunset'">日落</span>
                </button>
                
                <!-- 薰衣草主题 -->
                <button (click)="updateTheme('lavender')" 
                        class="flex flex-col items-center gap-1.5 p-1.5 rounded-lg transition-all group hover:bg-slate-50 dark:hover:bg-stone-700"
                        [ngClass]="{
                          'bg-slate-50 dark:bg-stone-700': preferenceService.theme() === 'lavender'
                        }">
                  <div class="w-5 h-5 rounded-full bg-gradient-to-br from-purple-200 to-fuchsia-400 border-2 group-hover:scale-110 transition-transform shadow-sm"
                       [class.border-purple-500]="preferenceService.theme() === 'lavender'"
                       [class.border-transparent]="preferenceService.theme() !== 'lavender'"></div>
                  <span class="text-[9px] font-medium" [class.text-purple-600]="preferenceService.theme() === 'lavender'" [class.text-slate-500]="preferenceService.theme() !== 'lavender'">薰衣草</span>
                </button>
              </div>
            </div>
          </section>
          
          <!-- 数据管理 -->
          <section class="space-y-1.5">
            <h3 class="text-[10px] font-bold text-slate-400 dark:text-stone-500 uppercase tracking-wider px-1">数据管理</h3>
            
            <div class="bg-white dark:bg-stone-800 border border-slate-200 dark:border-stone-700 rounded-xl shadow-sm divide-y divide-slate-100 dark:divide-stone-700 overflow-hidden">
              <!-- 自动解决冲突 -->
              <div class="px-3 py-2.5 flex items-center justify-between gap-3 hover:bg-slate-50 dark:hover:bg-stone-700 transition-colors">
                <div>
                  <div class="text-xs font-semibold text-slate-700 dark:text-stone-200">自动解决冲突</div>
                  <div class="text-[10px] text-slate-400 dark:text-stone-500">使用 LWW 策略自动合并</div>
                </div>
                <button 
                  type="button"
                  (click)="toggleAutoResolve()"
                  class="relative w-9 h-5 rounded-full transition-colors duration-200 focus:outline-none"
                  [class.bg-indigo-500]="preferenceService.autoResolveConflicts()"
                  [class.bg-slate-200]="!preferenceService.autoResolveConflicts()">
                  <span 
                    class="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow-sm transform transition-transform duration-200"
                    [class.translate-x-4]="preferenceService.autoResolveConflicts()">
                  </span>
                </button>
              </div>
              
              <!-- 备份与恢复 -->
              <div class="px-3 py-2.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 hover:bg-slate-50 dark:hover:bg-stone-700 transition-colors">
                <div class="flex-1 min-w-0">
                  <div class="text-xs font-semibold text-slate-700 dark:text-stone-200">备份与恢复</div>
                  <div class="text-[10px] text-slate-400 dark:text-stone-500">JSON 格式数据</div>
                </div>
                <div class="flex items-center gap-2 flex-shrink-0">
                  <button 
                    data-testid="settings-export-button"
                    (click)="handleExport()"
                    [disabled]="exportService.isExporting()"
                    class="px-2.5 py-1 bg-white dark:bg-stone-700 border border-slate-200 dark:border-stone-600 rounded-md text-[10px] font-bold text-slate-600 dark:text-stone-300 hover:bg-slate-50 dark:hover:bg-stone-600 hover:border-slate-300 transition-all disabled:opacity-50 flex items-center gap-1 shadow-sm">
                    @if (exportService.isExporting()) {
                      <div class="w-2.5 h-2.5 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin"></div>
                    } @else {
                      <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
                    }
                    <span>导出</span>
                  </button>
                  <button 
                    data-testid="settings-import-button"
                    (click)="triggerImportFileSelect()"
                    [disabled]="importService.isImporting()"
                    class="px-2.5 py-1 bg-white dark:bg-stone-700 border border-slate-200 dark:border-stone-600 rounded-md text-[10px] font-bold text-slate-600 dark:text-stone-300 hover:bg-slate-50 dark:hover:bg-stone-600 hover:border-slate-300 transition-all disabled:opacity-50 flex items-center gap-1 shadow-sm">
                    @if (importService.isImporting()) {
                      <div class="w-2.5 h-2.5 border-2 border-green-500 border-t-transparent rounded-full animate-spin"></div>
                    } @else {
                      <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                    }
                    <span>导入</span>
                  </button>
                  <input #fileInput data-testid="settings-import-input" type="file" accept=".json,application/json" class="hidden" (change)="handleFileSelected($event)" />
                </div>
              </div>

              <!-- 附件导出导入 -->
              <div class="px-3 py-2.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 hover:bg-slate-50 dark:hover:bg-stone-700 transition-colors">
                <div class="flex-1 min-w-0">
                  <div class="text-xs font-semibold text-slate-700 dark:text-stone-200">附件备份（ZIP）</div>
                  <div class="text-[10px] text-slate-400 dark:text-stone-500 truncate">{{ attachmentTransferStatus() }}</div>
                </div>
                <div class="flex items-center gap-2 flex-shrink-0">
                  <button
                    (click)="handleAttachmentExport()"
                    [disabled]="attachmentExportService.isExporting() || attachmentImportService.isImporting()"
                    class="px-2.5 py-1 bg-white dark:bg-stone-700 border border-slate-200 dark:border-stone-600 rounded-md text-[10px] font-bold text-slate-600 dark:text-stone-300 hover:bg-slate-50 dark:hover:bg-stone-600 hover:border-slate-300 transition-all disabled:opacity-50 flex items-center gap-1 shadow-sm">
                    @if (attachmentExportService.isExporting()) {
                      <div class="w-2.5 h-2.5 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin"></div>
                    } @else {
                      <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
                    }
                    <span>导出 ZIP</span>
                  </button>
                  <button
                    (click)="triggerAttachmentImportFileSelect()"
                    [disabled]="attachmentImportService.isImporting() || attachmentExportService.isExporting()"
                    class="px-2.5 py-1 bg-white dark:bg-stone-700 border border-slate-200 dark:border-stone-600 rounded-md text-[10px] font-bold text-slate-600 dark:text-stone-300 hover:bg-slate-50 dark:hover:bg-stone-600 hover:border-slate-300 transition-all disabled:opacity-50 flex items-center gap-1 shadow-sm">
                    @if (attachmentImportService.isImporting()) {
                      <div class="w-2.5 h-2.5 border-2 border-green-500 border-t-transparent rounded-full animate-spin"></div>
                    } @else {
                      <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                    }
                    <span>导入 ZIP</span>
                  </button>
                  <input
                    #attachmentZipInput
                    type="file"
                    accept=".zip,application/zip"
                    class="hidden"
                    (change)="handleAttachmentImportFileSelected($event)" />
                </div>
              </div>

            </div>
          </section>

          <!-- 思源知识锚点 -->
          <section class="space-y-1.5">
            <h3 class="text-[10px] font-bold text-slate-400 dark:text-stone-500 uppercase tracking-wider px-1">思源知识锚点</h3>
            <div class="bg-white dark:bg-stone-800 border border-slate-200 dark:border-stone-700 rounded-xl p-3 shadow-sm space-y-3">
              <div>
                <div class="text-xs font-semibold text-slate-700 dark:text-stone-200">只读预览配置</div>
                <div class="text-[10px] text-slate-400 dark:text-stone-500 mt-0.5">token 与预览缓存仅保存当前设备，不进入云端同步</div>
              </div>
              <label class="block space-y-1">
                <span class="text-[10px] font-bold text-slate-500 dark:text-stone-400">连接方式</span>
                <select
                  data-testid="siyuan-runtime-mode-select"
                  class="w-full rounded-lg border border-slate-200 dark:border-stone-600 bg-slate-50 dark:bg-stone-700 px-2 py-1.5 text-xs text-slate-700 dark:text-stone-200"
                  [value]="siyuanRuntimeMode()"
                  (change)="updateSiyuanRuntimeMode($event)">
                  <option value="extension-relay">浏览器扩展 Relay（推荐）</option>
                  <option value="direct">本地开发直连</option>
                  <option value="cache-only">仅缓存与深链</option>
                </select>
              </label>
              <form class="space-y-3" (submit)="onSiyuanConfigSubmit($event)">
                <label class="block space-y-1">
                  <span class="text-[10px] font-bold text-slate-500 dark:text-stone-400">本地思源地址</span>
                  <input
                    type="url"
                    class="w-full rounded-lg border border-slate-200 dark:border-stone-600 bg-slate-50 dark:bg-stone-700 px-2 py-1.5 text-xs text-slate-700 dark:text-stone-200"
                    [value]="siyuanBaseUrl()"
                    (change)="updateSiyuanBaseUrl($event)"
                    [placeholder]="defaultSiyuanBaseUrl" />
                </label>
                <label class="block space-y-1">
                  <span class="text-[10px] font-bold text-slate-500 dark:text-stone-400">本机 Token（可选，直连模式使用）</span>
                  <input
                    type="password"
                    autocomplete="off"
                    class="w-full rounded-lg border border-slate-200 dark:border-stone-600 bg-slate-50 dark:bg-stone-700 px-2 py-1.5 text-xs text-slate-700 dark:text-stone-200"
                    [value]="siyuanTokenMask()"
                    (change)="updateSiyuanToken($event)"
                    placeholder="留空则仅使用扩展或缓存" />
                </label>
              </form>
              <div class="grid grid-cols-3 gap-2">
                <button type="button" class="rounded-lg border border-indigo-200 dark:border-indigo-800 px-2 py-1.5 text-[10px] font-bold text-indigo-600 dark:text-indigo-300" (click)="testSiyuanConnection()">
                  测试连接
                </button>
                <button type="button" class="rounded-lg border border-slate-200 dark:border-stone-600 px-2 py-1.5 text-[10px] font-bold text-slate-600 dark:text-stone-300" (click)="clearSiyuanCache()">
                  清除本机缓存
                </button>
                <button type="button" class="rounded-lg border border-rose-200 dark:border-rose-800 px-2 py-1.5 text-[10px] font-bold text-rose-600 dark:text-rose-300" (click)="forgetSiyuanConfig()">
                  忘记本机授权
                </button>
              </div>
              <div class="rounded-lg bg-indigo-50 dark:bg-indigo-950/30 px-2 py-2 text-[10px] text-indigo-700 dark:text-indigo-300">
                HTTPS PWA 默认不直连 127.0.0.1；桌面实时预览优先通过 NanoFlow 扩展 Relay，未安装扩展时自动降级为缓存预览与 siyuan:// 深链。锚点 ID 会云端同步，路径/标签只用于跨设备显示。
              </div>
              @if (siyuanConnectionStatus(); as status) {
                <div class="rounded-lg bg-slate-50 dark:bg-stone-700 px-2 py-2 text-[10px] text-slate-500 dark:text-stone-300">{{ status }}</div>
              }
            </div>
          </section>
          
          <!-- 专注模式设置 -->
          <section class="space-y-1.5">
            <h3 class="text-[10px] font-bold text-slate-400 dark:text-stone-500 uppercase tracking-wider px-1">专注模式</h3>
            
            <div class="bg-white dark:bg-stone-800 border border-slate-200 dark:border-stone-700 rounded-xl shadow-sm divide-y divide-slate-100 dark:divide-stone-700 overflow-hidden">
              <!-- 大门功能 -->
              <div class="px-3 py-2.5 flex items-center justify-between gap-3 hover:bg-slate-50 dark:hover:bg-stone-700 transition-colors">
                <div>
                  <div class="text-xs font-semibold text-slate-700 dark:text-stone-200">🚪 大门</div>
                  <div class="text-[10px] text-slate-400 dark:text-stone-500">强制处理昨日遗留</div>
                </div>
                <button 
                  type="button"
                  (click)="toggleGateEnabled()"
                  data-testid="settings-gate-toggle"
                  role="switch"
                  [attr.aria-checked]="focusPreferenceService.preferences().gateEnabled"
                  class="relative w-9 h-5 rounded-full transition-colors duration-200 focus:outline-none"
                  [class.bg-indigo-500]="focusPreferenceService.preferences().gateEnabled"
                  [class.bg-slate-200]="!focusPreferenceService.preferences().gateEnabled">
                  <span 
                    class="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow-sm transform transition-transform duration-200"
                    [class.translate-x-4]="focusPreferenceService.preferences().gateEnabled">
                  </span>
                </button>
              </div>
              
              <!-- 黑匣子功能 -->
              <div class="px-3 py-2.5 flex items-center justify-between gap-3 hover:bg-slate-50 dark:hover:bg-stone-700 transition-colors">
                <div>
                  <div class="text-xs font-semibold text-slate-700 dark:text-stone-200">📦 黑匣子</div>
                  <div class="text-[10px] text-slate-400 dark:text-stone-500">语音/文字快速捕捉</div>
                </div>
                <button 
                  type="button"
                  (click)="toggleBlackBoxEnabled()"
                  data-testid="settings-blackbox-toggle"
                  role="switch"
                  [attr.aria-checked]="focusPreferenceService.preferences().blackBoxEnabled"
                  class="relative w-9 h-5 rounded-full transition-colors duration-200 focus:outline-none"
                  [class.bg-indigo-500]="focusPreferenceService.preferences().blackBoxEnabled"
                  [class.bg-slate-200]="!focusPreferenceService.preferences().blackBoxEnabled">
                  <span 
                    class="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow-sm transform transition-transform duration-200"
                    [class.translate-x-4]="focusPreferenceService.preferences().blackBoxEnabled">
                  </span>
                </button>
              </div>
              
              <!-- 地质层功能 -->
              <div class="px-3 py-2.5 flex items-center justify-between gap-3 hover:bg-slate-50 dark:hover:bg-stone-700 transition-colors">
                <div>
                  <div class="text-xs font-semibold text-slate-700 dark:text-stone-200">🗻 地质层</div>
                  <div class="text-[10px] text-slate-400 dark:text-stone-500">已完成任务堆叠显示</div>
                </div>
                <button 
                  type="button"
                  (click)="toggleStrataEnabled()"
                  data-testid="settings-strata-toggle"
                  role="switch"
                  [attr.aria-checked]="focusPreferenceService.preferences().strataEnabled"
                  class="relative w-9 h-5 rounded-full transition-colors duration-200 focus:outline-none"
                  [class.bg-indigo-500]="focusPreferenceService.preferences().strataEnabled"
                  [class.bg-slate-200]="!focusPreferenceService.preferences().strataEnabled">
                  <span 
                    class="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow-sm transform transition-transform duration-200"
                    [class.translate-x-4]="focusPreferenceService.preferences().strataEnabled">
                  </span>
                </button>
              </div>
              
              <!-- Snooze 配置兼容保留：Gate UI 已移除跳过动作，这里隐藏入口 -->
              
              <!-- 开发工具（仅开发模式可见） -->
              <div class="px-3 py-2.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 hover:bg-slate-50 dark:hover:bg-stone-700 transition-colors">
                <div class="min-w-0">
                  <div class="text-xs font-semibold text-slate-700 dark:text-stone-200">高负荷休息提醒</div>
                  <div class="text-[10px] text-slate-400 dark:text-stone-500">累计高负荷专注多久后给轻提醒</div>
                </div>
                <select
                  class="rounded-lg border border-slate-200 dark:border-stone-600 bg-slate-50 dark:bg-stone-700 px-2 py-1 text-[11px] text-slate-700 dark:text-stone-200 flex-shrink-0"
                  [value]="focusPreferenceService.preferences().restReminderHighLoadMinutes"
                  (change)="updateRestReminderHighLoadMinutes($event)"
                  data-testid="settings-rest-reminder-high">
                  @for (minutes of restReminderHighLoadOptions; track minutes) {
                    <option [value]="minutes">{{ formatReminderMinutes(minutes) }}</option>
                  }
                </select>
              </div>

              <div class="px-3 py-2.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 hover:bg-slate-50 dark:hover:bg-stone-700 transition-colors">
                <div class="min-w-0">
                  <div class="text-xs font-semibold text-slate-700 dark:text-stone-200">低负荷休息提醒</div>
                  <div class="text-[10px] text-slate-400 dark:text-stone-500">累计低负荷专注多久后给轻提醒</div>
                </div>
                <select
                  class="rounded-lg border border-slate-200 dark:border-stone-600 bg-slate-50 dark:bg-stone-700 px-2 py-1 text-[11px] text-slate-700 dark:text-stone-200 flex-shrink-0"
                  [value]="focusPreferenceService.preferences().restReminderLowLoadMinutes"
                  (change)="updateRestReminderLowLoadMinutes($event)"
                  data-testid="settings-rest-reminder-low">
                  @for (minutes of restReminderLowLoadOptions; track minutes) {
                    <option [value]="minutes">{{ formatReminderMinutes(minutes) }}</option>
                  }
                </select>
              </div>

              @if (isDev) {
                <div class="px-3 py-2.5 bg-orange-50 dark:bg-orange-900/20 border-t border-orange-200/50 dark:border-orange-800/30">
                  <div class="flex items-center justify-between gap-3">
                    <div>
                      <div class="text-xs font-semibold text-orange-700 dark:text-orange-300">🛠️ 开发测试</div>
                      <div class="text-[10px] text-orange-500 dark:text-orange-400/70">触发大门界面（带模拟数据）</div>
                    </div>
                    <button 
                      data-testid="settings-dev-gate"
                      (click)="triggerDevGate()"
                      class="px-2.5 py-1 text-[10px] font-bold bg-orange-500 text-white rounded-md hover:bg-orange-600 transition-colors shadow-sm">
                      测试大门
                    </button>
                  </div>
                </div>
              }
            </div>
          </section>

          <section class="space-y-1.5" #focusRoutineSection>
            <h3 class="text-[10px] font-bold text-slate-400 dark:text-stone-500 uppercase tracking-wider px-1">日常任务</h3>

            <div class="bg-white dark:bg-stone-800 border border-slate-200 dark:border-stone-700 rounded-xl shadow-sm overflow-hidden">
              <div class="px-3 py-3 border-b border-slate-100 dark:border-stone-700 space-y-3">
                <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
                  <div class="min-w-0">
                    <div class="text-xs font-semibold text-slate-700 dark:text-stone-200">重置时间</div>
                    <div class="text-[10px] text-slate-400 dark:text-stone-500">日常任务每日计数按本地小时切日</div>
                  </div>
                  <select
                    class="rounded-lg border border-slate-200 dark:border-stone-600 bg-slate-50 dark:bg-stone-700 px-2 py-1 text-[11px] text-slate-700 dark:text-stone-200 flex-shrink-0"
                    [value]="focusPreferenceService.preferences().routineResetHourLocal"
                    (change)="updateRoutineResetHour($event)">
                    @for (hour of routineResetHours; track hour) {
                      <option [value]="hour">{{ formatRoutineResetHour(hour) }}</option>
                    }
                  </select>
                </div>

                <!-- 【2026-04-23 响应式】窄屏（<640px）改为两行堆叠：
                     第 1 行：名称 input 占满宽度；第 2 行：次数 input + 添加按钮并排。
                     宽屏恢复原来的三列 grid。通过 sm:contents 让中间 div 桌面端解构成直接 grid 子项。 -->
                <div class="flex flex-col gap-2 sm:grid sm:grid-cols-[1fr_64px_auto] sm:items-center">
                  <input
                    type="text"
                    [(ngModel)]="newRoutineTitle"
                    placeholder="新增日常任务，例如：喝水"
                    class="w-full min-w-0 rounded-lg border border-slate-200 dark:border-stone-600 bg-slate-50 dark:bg-stone-700 px-3 py-2 text-xs text-slate-700 dark:text-stone-200 outline-none" />
                  <div class="flex gap-2 sm:contents">
                    <input
                      type="number"
                      min="1"
                      max="24"
                      [(ngModel)]="newRoutineMaxCount"
                      class="w-16 flex-shrink-0 rounded-lg border border-slate-200 dark:border-stone-600 bg-slate-50 dark:bg-stone-700 px-2 py-2 text-xs text-slate-700 dark:text-stone-200 outline-none"
                      placeholder="次数" />
                    <button
                      type="button"
                      class="flex-1 sm:flex-initial rounded-lg bg-indigo-600 px-3 py-2 text-[11px] font-semibold text-white hover:bg-indigo-500"
                      (click)="addRoutineSlot()">
                      添加
                    </button>
                  </div>
                </div>
              </div>

              <div class="divide-y divide-slate-100 dark:divide-stone-700">
                @for (slot of routineSlots(); track slot.id) {
                  <div class="px-3 py-2.5 flex flex-wrap items-center gap-x-2 gap-y-1.5">
                    <div class="min-w-0 flex-1">
                      <div class="text-xs font-semibold text-slate-700 dark:text-stone-200 truncate">{{ slot.title }}</div>
                      <div class="text-[10px] text-slate-400 dark:text-stone-500">
                        今日 {{ slot.todayCompletedCount }}/{{ slot.maxDailyCount }}
                        · {{ slot.isEnabled ? '已启用' : '已停用' }}
                      </div>
                    </div>
                    <button
                      type="button"
                      class="rounded-md border border-slate-200 dark:border-stone-600 px-2 py-1 text-[10px] text-slate-600 dark:text-stone-300 hover:bg-slate-100 dark:hover:bg-stone-700"
                      [disabled]="!slot.isEnabled || slot.todayCompletedCount >= slot.maxDailyCount"
                      (click)="completeRoutineSlot(slot.id)">
                      计 1 次
                    </button>
                    <button
                      type="button"
                      class="rounded-md border border-slate-200 dark:border-stone-600 px-2 py-1 text-[10px] text-slate-600 dark:text-stone-300 hover:bg-slate-100 dark:hover:bg-stone-700"
                      (click)="toggleRoutineSlot(slot.id, !slot.isEnabled)">
                      {{ slot.isEnabled ? '停用' : '启用' }}
                    </button>
                    <button
                      type="button"
                      class="rounded-md border border-rose-200 dark:border-rose-800 px-2 py-1 text-[10px] text-rose-600 dark:text-rose-300 hover:bg-rose-50 dark:hover:bg-rose-950/30"
                      (click)="removeRoutineSlot(slot.id)">
                      删除
                    </button>
                  </div>
                } @empty {
                  <div class="px-3 py-5 text-center text-[11px] text-slate-400 dark:text-stone-500">
                    暂无日常任务，可在这里新增并手动记次。
                  </div>
                }
              </div>
            </div>
          </section>
          
          <!-- 本地自动备份 -->
          @if (localBackupService.isAvailable()) {
            <section class="space-y-1.5">
              <h3 class="text-[10px] font-bold text-slate-400 dark:text-stone-500 uppercase tracking-wider px-1">本地增强备份</h3>
              
              <div class="bg-amber-50/40 dark:bg-amber-900/20 border border-amber-100 dark:border-amber-800/50 rounded-xl p-3 space-y-3">
                <!-- 状态 1：未授权且无保存的 handle -->
                @if (!localBackupService.isAuthorized() && !localBackupService.hasSavedHandle()) {
                  <div class="flex items-center justify-between gap-3">
                    <div class="flex-1">
                      <div class="text-xs font-bold text-amber-900 dark:text-amber-300">开启本地自动备份</div>
                      <div class="text-[10px] text-amber-700/70 dark:text-amber-400/70 mt-0.5">配合坚果云/Dropbox 实现自动同步</div>
                    </div>
                    <button 
                      (click)="handleSetupLocalBackup()"
                      class="px-3 py-1.5 bg-amber-500 text-white rounded-lg text-[10px] font-bold hover:bg-amber-600 transition-colors shadow-sm shadow-amber-200">
                      选择目录
                    </button>
                  </div>
                }
                
                <!-- 状态 2 & 3：有保存的目录（可能需要恢复权限，开关打开时自动请求） -->
                @if (localBackupService.hasSavedHandle()) {
                  <div class="space-y-2.5">
                    <div class="flex items-center justify-between bg-white/50 dark:bg-stone-700/50 p-2 rounded-lg border border-amber-100 dark:border-amber-900/50">
                      <div class="flex items-center gap-2 min-w-0">
                        @if (localBackupService.isAuthorized()) {
                          <div class="w-6 h-6 rounded bg-green-100 flex items-center justify-center flex-shrink-0">
                            <svg class="w-3.5 h-3.5 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" /></svg>
                          </div>
                        } @else {
                          <div class="w-6 h-6 rounded bg-amber-100 flex items-center justify-center flex-shrink-0">
                            <svg class="w-3.5 h-3.5 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
                          </div>
                        }
                        <div class="min-w-0">
                          <div class="text-[11px] font-bold text-amber-900 dark:text-amber-300 truncate max-w-[120px]">{{ localBackupService.directoryName() }}</div>
                          @if (localBackupService.isAuthorized()) {
                            <div class="text-[9px] text-green-600 dark:text-green-400">✓ 已授权</div>
                          } @else {
                            <div class="text-[9px] text-amber-600 dark:text-amber-400">开启备份时自动授权</div>
                          }
                        </div>
                      </div>
                      <button (click)="handleRevokeLocalBackup()" class="text-[10px] font-bold text-amber-600 hover:text-amber-800 px-2">取消</button>
                    </div>
                    
                    <div class="flex flex-wrap items-center justify-between px-1 gap-x-3 gap-y-1.5">
                      <div class="min-w-0">
                        <div class="text-[11px] font-semibold text-amber-800 dark:text-amber-300">自动定时备份</div>
                        <div class="text-[10px] text-amber-600/80 dark:text-amber-400/80">当前默认间隔 {{ selectedBackupInterval() }}</div>
                      </div>
                      <button 
                        (click)="toggleAutoBackup()"
                        class="relative w-9 h-5 rounded-full transition-colors duration-200"
                        [class.bg-amber-500]="localBackupService.autoBackupEnabled()"
                        [class.bg-amber-200]="!localBackupService.autoBackupEnabled()">
                        <span 
                          class="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow-sm transform transition-transform duration-200"
                          [class.translate-x-4]="localBackupService.autoBackupEnabled()">
                        </span>
                      </button>
                    </div>
                    
                    @if (formattedLastBackupTime()) {
                      <div class="text-[9px] text-amber-600/70 dark:text-amber-400/70 px-1">
                        上次备份：{{ formattedLastBackupTime() }}
                      </div>
                    }

                    <button 
                      (click)="handleManualBackup()"
                      [disabled]="localBackupService.isBackingUp()"
                      class="w-full py-1.5 bg-white dark:bg-stone-700 border border-amber-200 dark:border-amber-700 rounded-lg text-[10px] font-bold text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-900/30 transition-all flex items-center justify-center gap-2 shadow-sm">
                      @if (localBackupService.isBackingUp()) {
                        <div class="w-2.5 h-2.5 border-2 border-amber-500 border-t-transparent rounded-full animate-spin"></div>
                        <span>备份中...</span>
                      } @else {
                        <span>立即执行备份</span>
                      }
                    </button>
                    
                    <!-- 从本地备份恢复 -->
                    @if (localBackupUI.restoreStep() === 'idle') {
                      <button
                        (click)="handleRestoreFromLocalBackup()"
                        class="w-full py-1.5 bg-white dark:bg-stone-700 border border-amber-200 dark:border-amber-700 rounded-lg text-[10px] font-bold text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-900/30 transition-all flex items-center justify-center gap-2 shadow-sm">
                        <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                        <span>从备份恢复</span>
                      </button>
                    }

                    <!-- 恢复流程面板 -->
                    @if (localBackupUI.restoreStep() !== 'idle') {
                      <div class="bg-amber-50/80 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-2.5 space-y-2">
                        <div class="flex items-center justify-between">
                          <span class="text-[10px] font-bold text-amber-800 dark:text-amber-300">从备份恢复</span>
                          @if (localBackupUI.restoreStep() !== 'restoring') {
                            <button (click)="cancelRestore()" class="text-[9px] text-amber-600 hover:text-amber-800 dark:text-amber-400 dark:hover:text-amber-200 font-medium">取消</button>
                          }
                        </div>

                        <!-- 加载中 -->
                        @if (localBackupUI.restoreStep() === 'loading' || localBackupUI.restoreStep() === 'restoring') {
                          <div class="flex items-center justify-center gap-2 py-3">
                            <div class="w-3 h-3 border-2 border-amber-500 border-t-transparent rounded-full animate-spin"></div>
                            <span class="text-[10px] text-amber-700 dark:text-amber-300">
                              {{ localBackupUI.restoreStep() === 'loading' ? '读取备份文件...' : '恢复中，请勿关闭...' }}
                            </span>
                          </div>
                        }

                        <!-- 文件列表 -->
                        @if (localBackupUI.restoreStep() === 'list') {
                          @if (localBackupUI.restoreBackupFiles().length === 0) {
                            <div class="text-[10px] text-amber-600/80 dark:text-amber-400/80 text-center py-2">备份目录中没有找到备份文件</div>
                          } @else {
                            <div class="max-h-[160px] overflow-y-auto space-y-1 custom-scrollbar">
                              @for (file of localBackupUI.restoreBackupFiles().slice(0, 10); track file.name; let i = $index) {
                                <button
                                  (click)="selectRestoreFile(i)"
                                  class="w-full text-left px-2 py-1.5 rounded text-[10px] transition-colors hover:bg-amber-100 dark:hover:bg-amber-900/40"
                                  [ngClass]="localBackupUI.restoreSelectedIndex() === i ? 'bg-amber-200 dark:bg-amber-800' : ''">
                                  <div class="font-medium text-amber-900 dark:text-amber-200">
                                    {{ formatBackupDate(file.timestamp) }}
                                  </div>
                                  <div class="text-[9px] text-amber-600/80 dark:text-amber-400/70">
                                    {{ formatBackupSize(file.size) }}
                                  </div>
                                </button>
                              }
                            </div>
                            <button
                              (click)="loadRestorePreview()"
                              [disabled]="localBackupUI.restoreSelectedIndex() < 0"
                              class="w-full py-1 rounded text-[10px] font-bold transition-colors"
                              [ngClass]="localBackupUI.restoreSelectedIndex() >= 0 ? 'bg-amber-500 text-white hover:bg-amber-600' : 'bg-amber-200 text-amber-400 cursor-not-allowed'">
                              选择此备份
                            </button>
                          }
                        }

                        <!-- 预览确认 -->
                        @if (localBackupUI.restoreStep() === 'preview') {
                          @if (localBackupUI.restorePreview(); as preview) {
                            <div class="space-y-1.5">
                              <div class="text-[10px] text-amber-800 dark:text-amber-300">即将恢复：</div>
                              <div class="grid grid-cols-3 gap-1">
                                <div class="bg-white/60 dark:bg-stone-700/60 rounded px-2 py-1 text-center">
                                  <div class="text-[12px] font-bold text-amber-900 dark:text-amber-200">{{ preview.projects }}</div>
                                  <div class="text-[8px] text-amber-600 dark:text-amber-400">项目</div>
                                </div>
                                <div class="bg-white/60 dark:bg-stone-700/60 rounded px-2 py-1 text-center">
                                  <div class="text-[12px] font-bold text-amber-900 dark:text-amber-200">{{ preview.tasks }}</div>
                                  <div class="text-[8px] text-amber-600 dark:text-amber-400">任务</div>
                                </div>
                                <div class="bg-white/60 dark:bg-stone-700/60 rounded px-2 py-1 text-center">
                                  <div class="text-[12px] font-bold text-amber-900 dark:text-amber-200">{{ preview.connections }}</div>
                                  <div class="text-[8px] text-amber-600 dark:text-amber-400">连接</div>
                                </div>
                              </div>
                              <div class="text-[9px] text-amber-600/80 dark:text-amber-400/70">⚠️ 以合并方式导入，不会删除现有数据</div>
                              <div class="flex gap-2">
                                <button (click)="localBackupUI.restoreStep.set('list')" class="flex-1 py-1 bg-white dark:bg-stone-700 border border-amber-200 dark:border-amber-700 rounded text-[10px] font-bold text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-900/30">返回</button>
                                <button (click)="confirmRestore()" class="flex-1 py-1 bg-amber-500 text-white rounded text-[10px] font-bold hover:bg-amber-600">确认恢复</button>
                              </div>
                            </div>
                          }
                        }

                        <!-- 完成 -->
                        @if (localBackupUI.restoreStep() === 'done') {
                          <div class="text-center py-2 space-y-1.5">
                            <div class="text-green-600 dark:text-green-400 text-[10px] font-bold">✓ {{ localBackupUI.restoreResultMsg() }}</div>
                            <button (click)="cancelRestore()" class="text-[10px] text-amber-600 hover:text-amber-800 dark:text-amber-400 font-medium">关闭</button>
                          </div>
                        }

                        <!-- 错误 -->
                        @if (localBackupUI.restoreStep() === 'error') {
                          <div class="text-center py-2 space-y-1.5">
                            <div class="text-red-600 dark:text-red-400 text-[10px]">{{ localBackupUI.restoreError() }}</div>
                            <button (click)="cancelRestore()" class="text-[10px] text-amber-600 hover:text-amber-800 dark:text-amber-400 font-medium">关闭</button>
                          </div>
                        }
                      </div>
                    }
                  </div>
                }
              </div>
            </section>
          }
        </div>
        
        <!-- 底部操作 -->
        <div class="p-3 bg-slate-50 dark:bg-stone-900 border-t border-slate-200/60 dark:border-stone-700 flex justify-end flex-shrink-0">
          <button (click)="close.emit()" class="px-5 py-1.5 bg-slate-800 text-white rounded-lg hover:bg-slate-900 transition-all text-xs font-bold shadow-md shadow-slate-200 active:scale-95">
            完成
          </button>
        </div>
      </div>
    </div>
  `
})
export class SettingsModalComponent {
  constructor() {
    // 组件初始化 - 开发日志已移除
    // 设置项目提供者，用于自动备份恢复
    this.localBackupService.setProjectsProvider(() => this.projects());
    effect(() => {
      if (this.initialSection() !== 'focus-routines') return;
      const section = this.focusRoutineSectionRef()?.nativeElement;
      if (!section) return;
      queueMicrotask(() => {
        section.scrollIntoView({ block: 'start', behavior: 'smooth' });
      });
    });
    void this.loadSiyuanConfig();
  }
  readonly dockEngine = inject(DockEngineService);
  readonly userSession = inject(UserSessionService);
  readonly preferenceService = inject(PreferenceService);
  readonly exportService = inject(ExportService);
  readonly importService = inject(ImportService);
  readonly attachmentExportService = inject(AttachmentExportService);
  readonly attachmentImportService = inject(AttachmentImportService);
  readonly localBackupService = inject(LocalBackupService);
  readonly localBackupUI = inject(LocalBackupUIService);
  readonly themeService = inject(ThemeService);
  readonly focusPreferenceService = inject(FocusPreferenceService);
  readonly gateService = inject(GateService);
  private readonly siyuanCache = inject(ExternalSourceCacheService);
  private readonly siyuanPreview = inject(SiyuanPreviewService);
  private readonly logger = inject(LoggerService);
  
  /** 是否开发模式（用于显示开发工具） */
  readonly isDev = isDevMode();
  
  /** 当前登录用户邮箱 */
  sessionEmail = input<string | null>(null);
  initialSection = input<'focus-routines' | null>(null);
  
  /** 所有项目（用于导出） */
  projects = input<Project[]>([]);
  private readonly focusRoutineSectionRef = viewChild<ElementRef<HTMLElement>>('focusRoutineSection');
  
  readonly close = output<void>();
  readonly signOut = output<void>();
  readonly themeChange = output<ThemeType>();
  readonly openDashboard = output<void>();
  readonly importComplete = output<Project>();
  readonly routineSlots = computed(() =>
    [...this.dockEngine.dailySlots()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  );
  newRoutineTitle = '';
  newRoutineMaxCount = 1;

  /** 附件传输状态文案 */
  readonly attachmentTransferStatus = computed(() => {
    if (this.attachmentExportService.isExporting()) {
      const progress = this.attachmentExportService.progress();
      const processed = progress.processedCount;
      const total = progress.totalCount;
      return `导出中 ${Math.round(progress.percentage)}% (${processed}/${total || 0})`;
    }

    if (this.attachmentImportService.isImporting()) {
      const progress = this.attachmentImportService.progress();
      const processed = progress.completedItems + progress.failedItems + progress.skippedItems;
      return `导入中 ${Math.round(progress.percentage)}% (${processed}/${progress.totalItems || 0})`;
    }

    return 'ZIP 原文件导出与分批导入';
  });
  
  /** 本地备份间隔选项 */
  readonly backupIntervalOptions = [
    { label: '15 分钟', value: 15 * 60 * 1000 },
    { label: '30 分钟', value: 30 * 60 * 1000 },
    { label: '1 小时', value: 60 * 60 * 1000 },
    { label: '2 小时', value: 2 * 60 * 60 * 1000 },
  ];
  readonly routineResetHours = Array.from({ length: 24 }, (_, index) => index);
  readonly restReminderHighLoadOptions = [45, 60, 75, 90, 120, 150, 180];
  readonly restReminderLowLoadOptions = [10, 15, 20, 30, 45, 60, 90];
  
  /** 当前选择的备份间隔 */
  readonly selectedBackupInterval = computed(() => {
    const currentInterval = this.localBackupService.autoBackupIntervalMs();
    return this.backupIntervalOptions.find(opt => opt.value === currentInterval)?.label || '30 分钟';
  });
  
  /** 格式化上次备份时间 */
  readonly formattedLastBackupTime = computed(() => {
    const time = this.localBackupService.lastBackupTime();
    if (!time) return null;
    const date = new Date(time);
    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  });

  /** 是否正在从备份恢复（委托给 localBackupUI） */
  readonly isRestoringFromBackup = this.localBackupUI.isRestoringFromBackup;
  readonly siyuanRuntimeMode = signal<SiyuanRuntimeMode>('extension-relay');
  readonly siyuanBaseUrl = signal<string>(SIYUAN_CONFIG.DEFAULT_BASE_URL);
  readonly siyuanTokenMask = signal('');
  readonly siyuanConnectionStatus = signal<string>('');
  readonly defaultSiyuanBaseUrl = SIYUAN_CONFIG.DEFAULT_BASE_URL;
  
  /** 文件输入引用 - 使用 viewChild signal 引用模板中的 #fileInput */
  private readonly fileInputRef = viewChild<ElementRef<HTMLInputElement>>('fileInput');
  /** 附件 ZIP 导入文件输入 */
  private readonly attachmentZipInputRef = viewChild<ElementRef<HTMLInputElement>>('attachmentZipInput');
  
  updateTheme(theme: ThemeType) {
    this.themeChange.emit(theme);
  }
  
  updateColorMode(mode: ColorMode) {
    this.themeService.setColorMode(mode);
  }

  async loadSiyuanConfig(): Promise<void> {
    const config = await this.siyuanCache.loadConfig();
    this.siyuanRuntimeMode.set(config.runtimeMode);
    this.siyuanBaseUrl.set(config.baseUrl || SIYUAN_CONFIG.DEFAULT_BASE_URL);
    this.siyuanTokenMask.set(config.token ? SIYUAN_TOKEN_MASK : '');
  }

  async updateSiyuanRuntimeMode(event: Event): Promise<void> {
    const value = (event.target as HTMLSelectElement | null)?.value;
    if (value !== 'extension-relay' && value !== 'direct' && value !== 'cache-only') return;
    const config = await this.siyuanCache.loadConfig();
    await this.siyuanCache.saveConfig({ ...config, runtimeMode: value });
    this.siyuanRuntimeMode.set(value);
    this.siyuanConnectionStatus.set('');
  }

  async updateSiyuanBaseUrl(event: Event): Promise<void> {
    const value = (event.target as HTMLInputElement | null)?.value.trim() || SIYUAN_CONFIG.DEFAULT_BASE_URL;
    if (!isTrustedSiyuanDirectBaseUrl(value, typeof window === 'undefined' ? null : window.location)) {
      // 拒绝可疑 baseUrl 时一并清空已保存的 token，防止下次 testSiyuanConnection 把 token 发到错误的 host。
      const config = await this.siyuanCache.loadConfig();
      await this.siyuanCache.saveConfig({ ...config, baseUrl: SIYUAN_CONFIG.DEFAULT_BASE_URL, token: undefined });
      this.siyuanBaseUrl.set(SIYUAN_CONFIG.DEFAULT_BASE_URL);
      this.siyuanTokenMask.set('');
      this.siyuanConnectionStatus.set('仅支持本机思源地址 http://127.0.0.1:6806 或 http://localhost:6806，已重置授权');
      return;
    }
    const config = await this.siyuanCache.loadConfig();
    await this.siyuanCache.saveConfig({ ...config, baseUrl: value });
    this.siyuanBaseUrl.set(value);
    this.siyuanConnectionStatus.set('');
  }

  async updateSiyuanToken(event: Event): Promise<void> {
    const value = (event.target as HTMLInputElement | null)?.value.trim() ?? '';
    if (value === SIYUAN_TOKEN_MASK) return;
    const config = await this.siyuanCache.loadConfig();
    await this.siyuanCache.saveConfig({ ...config, token: value || undefined });
    this.siyuanTokenMask.set(value ? SIYUAN_TOKEN_MASK : '');
  }

  onSiyuanConfigSubmit(event: Event): void {
    event.preventDefault();
  }

  async testSiyuanConnection(): Promise<void> {
    this.siyuanConnectionStatus.set('正在检测思源连接…');
    try {
      const result = await this.siyuanPreview.diagnoseConnection();
      if (result.ok) {
        this.siyuanConnectionStatus.set(result.mode === 'cache-only' ? '当前为仅缓存与深链模式' : '思源预览通道可用');
        return;
      }
      const message = this.formatSiyuanDiagnosisMessage(result.errorCode);
      this.siyuanConnectionStatus.set(message);
    } catch (error) {
      this.logger.warn('思源连接诊断失败', {
        message: error instanceof Error ? error.message : 'unknown',
      });
      this.siyuanConnectionStatus.set('检测失败，请稍后重试');
    }
  }

  async clearSiyuanCache(): Promise<void> {
    await this.siyuanCache.clearPreviewCache();
    this.siyuanConnectionStatus.set('已清除当前账号的本机思源缓存');
  }

  async forgetSiyuanConfig(): Promise<void> {
    await this.siyuanCache.forgetConfig();
    await this.loadSiyuanConfig();
    this.siyuanConnectionStatus.set('已忘记本机思源授权');
  }

  private formatSiyuanDiagnosisMessage(errorCode?: string): string {
    if (errorCode === 'extension-unavailable') return '扩展未安装或未注入当前页面，请刷新后重试';
    return SIYUAN_ERROR_MESSAGES[errorCode ?? 'unknown'] ?? SIYUAN_ERROR_MESSAGES.unknown;
  }
  
  toggleAutoResolve() {
    const current = this.preferenceService.autoResolveConflicts();
    this.preferenceService.setAutoResolveConflicts(!current);
  }
  
  /**
   * 处理导出
   */
  async handleExport(): Promise<void> {
    const projectList = this.projects();
    if (projectList.length === 0) {
      return;
    }
    
    await this.exportService.exportAndDownload(projectList);
  }

  /**
   * 导出附件 ZIP
   */
  async handleAttachmentExport(): Promise<void> {
    const projectList = this.projects();
    if (projectList.length === 0) {
      alert('没有可导出的项目');
      return;
    }

    const result = await this.attachmentExportService.exportAndDownload(projectList);
    if (!result.success) {
      alert(`附件导出失败：${result.error ?? '未知错误'}`);
      return;
    }

    if (!result.blob) {
      alert('附件导出完成：当前项目没有可导出的附件');
      return;
    }
  }
  
  /**
   * 触发文件选择
   */
  triggerImportFileSelect(): void {
    // 使用 viewChild 引用获取文件输入元素
    const inputRef = this.fileInputRef();
    if (inputRef?.nativeElement) {
      inputRef.nativeElement.click();
    } else {
      this.logger.error('SettingsModal', '文件输入元素未找到');
    }
  }

  /**
   * 触发附件 ZIP 导入文件选择
   */
  triggerAttachmentImportFileSelect(): void {
    const inputRef = this.attachmentZipInputRef();
    if (inputRef?.nativeElement) {
      inputRef.nativeElement.click();
    } else {
      this.logger.error('SettingsModal', '附件 ZIP 输入元素未找到');
    }
  }
  
  /**
   * 处理文件选择
   */
  async handleFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    
    if (!file) return;
    
    // 清空 input 以便可以再次选择同一文件
    input.value = '';
    
    // 验证文件
    const validation = await this.importService.validateFile(file);
    if (!validation.valid || !validation.data) {
      alert(`导入失败：${validation.error}`);
      return;
    }
    
    // 生成预览
    const preview = await this.importService.generatePreview(
      validation.data,
      this.projects()
    );
    
    // 如果有冲突，询问用户
    let conflictStrategy: ImportOptions['conflictStrategy'] = 'skip';
    if (preview.conflicts.length > 0) {
      const choice = confirm(
        `发现 ${preview.conflicts.length} 个冲突项目。\n` +
        `点击"确定"跳过冲突项目，点击"取消"覆盖现有项目。`
      );
      conflictStrategy = choice ? 'skip' : 'overwrite';
    }
    
    // 执行导入
    const result = await this.importService.executeImport(
      validation.data,
      this.projects(),
      { conflictStrategy },
      async (project) => {
        this.importComplete.emit(project);
      }
    );
    
    if (result.success) {
      alert(`导入完成！\n成功: ${result.importedCount}\n跳过: ${result.skippedCount}`);
    } else {
      alert(`导入失败：${result.error}`);
    }
  }

  /**
   * 处理附件 ZIP 选择并导入
   */
  async handleAttachmentImportFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];

    if (!file) return;
    input.value = '';

    if (!file.name.toLowerCase().endsWith('.zip')) {
      alert('请选择 ZIP 附件包文件');
      return;
    }

    try {
      const zipData = await file.arrayBuffer();
      const projects = this.projects();
      const taskAttachmentMap = this.buildTaskAttachmentMap(projects);
      const taskProjectIndex = this.buildTaskProjectIndex(projects);

      const extractedItems = await this.attachmentImportService.extractAttachmentsFromZip(
        zipData,
        taskAttachmentMap
      );

      if (extractedItems.length === 0) {
        alert('附件包中未找到可导入的附件');
        return;
      }

      const groupedByProject = new Map<string, AttachmentImportItem[]>();
      let unmatchedCount = 0;

      for (const item of extractedItems) {
        const projectId = item.projectId ?? taskProjectIndex.get(item.taskId);
        if (!projectId) {
          unmatchedCount++;
          continue;
        }

        const existingGroup = groupedByProject.get(projectId);
        if (existingGroup) {
          existingGroup.push(item);
        } else {
          groupedByProject.set(projectId, [item]);
        }
      }

      if (groupedByProject.size === 0) {
        alert('附件包中的任务与当前项目不匹配，无法导入');
        return;
      }

      let imported = 0;
      let failed = 0;
      let skipped = unmatchedCount;
      const errorMessages: string[] = [];

      for (const [projectId, items] of groupedByProject) {
        const importResult = await this.attachmentImportService.importAttachments(projectId, items);
        imported += importResult.imported;
        failed += importResult.failed;
        skipped += importResult.skipped;
        errorMessages.push(...importResult.errors.map(e => `${e.attachmentName || '未知附件'}: ${e.error}`));
      }

      if (failed === 0) {
        alert(`附件导入完成！\n成功: ${imported}\n跳过: ${skipped}`);
      } else {
        const topError = errorMessages[0] ?? '未知错误';
        alert(`附件导入部分失败。\n成功: ${imported}\n失败: ${failed}\n跳过: ${skipped}\n首个错误: ${topError}`);
      }

      if (unmatchedCount > 0) {
        this.logger.warn('SettingsModal', `部分附件未匹配到项目，已跳过: ${unmatchedCount}`);
      }
    } catch (error: unknown) {
      this.logger.error('SettingsModal', '附件 ZIP 导入失败', error);
      alert(`附件导入失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
  }

  private buildTaskAttachmentMap(projects: Project[]): Map<string, TaskAttachmentMetadata[]> {
    const map = new Map<string, TaskAttachmentMetadata[]>();

    for (const project of projects) {
      for (const task of project.tasks) {
        if (!task.attachments || task.attachments.length === 0) continue;

        const attachments: TaskAttachmentMetadata[] = task.attachments.map(att => ({
          id: att.id,
          name: att.name,
          size: att.size ?? 0,
          mimeType: att.mimeType ?? 'application/octet-stream',
        }));

        map.set(task.id, attachments);
      }
    }

    return map;
  }

  private buildTaskProjectIndex(projects: Project[]): Map<string, string> {
    const index = new Map<string, string>();

    for (const project of projects) {
      for (const task of project.tasks) {
        index.set(task.id, project.id);
      }
    }

    return index;
  }

  // ============================================
  // 本地备份方法（委托给 LocalBackupUIService）
  // ============================================

  /**
   * 设置本地备份目录
   */
  async handleSetupLocalBackup(): Promise<void> {
    await this.localBackupUI.handleSetupLocalBackup();
  }

  /**
   * 取消本地备份授权
   */
  async handleRevokeLocalBackup(): Promise<void> {
    await this.localBackupUI.handleRevokeLocalBackup();
  }

  /**
   * 手动执行本地备份
   */
  async handleManualBackup(): Promise<void> {
    await this.localBackupUI.handleManualBackup(this.projects());
  }

  /**
   * 从本地备份恢复 — 打开文件列表面板
   */
  async handleRestoreFromLocalBackup(): Promise<void> {
    await this.localBackupUI.handleRestoreFromLocalBackup();
  }

  /** 选择备份文件 */
  selectRestoreFile(index: number): void {
    this.localBackupUI.selectRestoreFile(index);
  }

  /** 格式化备份文件日期 */
  formatBackupDate(timestamp: number): string {
    return this.localBackupUI.formatBackupDate(timestamp);
  }

  /** 格式化备份文件大小 */
  formatBackupSize(size: number): string {
    return this.localBackupUI.formatBackupSize(size);
  }

  /** 加载所选备份的预览信息 */
  async loadRestorePreview(): Promise<void> {
    await this.localBackupUI.loadRestorePreview(this.projects());
  }

  /** 确认恢复 */
  async confirmRestore(): Promise<void> {
    await this.localBackupUI.confirmRestore(this.projects(), async (project: Project) => {
      this.importComplete.emit(project);
    });
  }

  /** 取消/关闭恢复面板 */
  cancelRestore(): void {
    this.localBackupUI.cancelRestore();
  }

  /**
   * 切换自动备份
   * 开启时自动请求权限（用户点击开关本身就是用户手势）
   */
  async toggleAutoBackup(): Promise<void> {
    await this.localBackupUI.toggleAutoBackup(() => this.projects());
  }
  
  // ============================================
  // 专注模式设置方法
  // ============================================
  
  /**
   * 切换大门功能
   */
  toggleGateEnabled(): void {
    const current = this.focusPreferenceService.preferences().gateEnabled;
    this.focusPreferenceService.update({ gateEnabled: !current });
  }
  
  /**
   * 切换黑匣子功能
   */
  toggleBlackBoxEnabled(): void {
    const current = this.focusPreferenceService.preferences().blackBoxEnabled;
    this.focusPreferenceService.update({ blackBoxEnabled: !current });
  }
  
  /**
   * 切换地质层功能
   */
  toggleStrataEnabled(): void {
    const current = this.focusPreferenceService.preferences().strataEnabled;
    this.focusPreferenceService.update({ strataEnabled: !current });
  }
  
  updateRoutineResetHour(event: Event): void {
    const select = event.target as HTMLSelectElement;
    const value = Number.parseInt(select.value, 10);
    if (Number.isNaN(value)) return;
    this.focusPreferenceService.update({
      routineResetHourLocal: Math.min(23, Math.max(0, value)),
    });
  }

  updateRestReminderHighLoadMinutes(event: Event): void {
    const select = event.target as HTMLSelectElement;
    const value = Number.parseInt(select.value, 10);
    if (Number.isNaN(value)) return;
    this.focusPreferenceService.setRestReminderHighLoadMinutes(value);
  }

  updateRestReminderLowLoadMinutes(event: Event): void {
    const select = event.target as HTMLSelectElement;
    const value = Number.parseInt(select.value, 10);
    if (Number.isNaN(value)) return;
    this.focusPreferenceService.setRestReminderLowLoadMinutes(value);
  }

  formatRoutineResetHour(hour: number): string {
    return `${String(hour).padStart(2, '0')}:00`;
  }

  formatReminderMinutes(minutes: number): string {
    if (minutes >= 60 && minutes % 60 === 0) {
      return `${minutes / 60} 小时`;
    }
    return `${minutes} 分钟`;
  }

  addRoutineSlot(): void {
    const title = this.newRoutineTitle.trim();
    if (!title) return;
    const nextMax = Math.min(24, Math.max(1, Math.floor(Number(this.newRoutineMaxCount) || 1)));
    this.dockEngine.dailySlotService.addDailySlot(title, nextMax);
    this.newRoutineTitle = '';
    this.newRoutineMaxCount = 1;
  }

  completeRoutineSlot(id: string): void {
    this.dockEngine.dailySlotService.completeDailySlot(id);
  }

  toggleRoutineSlot(id: string, enabled: boolean): void {
    this.dockEngine.dailySlotService.setDailySlotEnabled(id, enabled);
  }

  removeRoutineSlot(id: string): void {
    this.dockEngine.dailySlotService.removeDailySlot(id);
  }
  
  /**
   * [DEV] 触发大门测试界面
   * 关闭设置模态框并显示大门（带模拟数据）
   */
  triggerDevGate(): void {
    this.gateService.devForceShowGate();
    this.close.emit();
  }
}
