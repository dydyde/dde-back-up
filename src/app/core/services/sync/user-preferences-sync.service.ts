/**
 * UserPreferencesSyncService - 用户偏好同步服务
 * 
 * 职责：
 * - 加载用户偏好 (loadUserPreferences)
 * - 保存用户偏好 (saveUserPreferences)
 * 
 * 从 SimpleSyncService 提取，Sprint 9 技术债务修复
 */

import { Injectable, inject } from '@angular/core';
import { SupabaseClientService } from '../../../../services/supabase-client.service';
import { LoggerService } from '../../../../services/logger.service';
import { UserPreferences, ThemeType, ColorMode } from '../../../../models';
import { FocusPreferences, DEFAULT_FOCUS_PREFERENCES } from '../../../../models/focus';
import { nowISO } from '../../../../utils/date';
import { supabaseErrorToError } from '../../../../utils/supabase-error';
import {
  isBrowserNetworkSuspendedError,
  isBrowserNetworkSuspendedWindow,
} from '../../../../utils/browser-network-suspension';
import type { SupabaseClient } from '@supabase/supabase-js';

@Injectable({
  providedIn: 'root'
})
export class UserPreferencesSyncService {
  private readonly supabase = inject(SupabaseClientService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('UserPrefsSync');

  private shouldDeferForBrowserSuspension(
    operation: '加载' | '保存',
    userId: string,
    error?: unknown,
  ): boolean {
    const suspended = error === undefined
      ? isBrowserNetworkSuspendedWindow()
      : isBrowserNetworkSuspendedError(error) || isBrowserNetworkSuspendedWindow();

    if (!suspended) {
      return false;
    }

    this.logger.debug(`浏览器网络挂起，延后${operation}用户偏好`, { userId });
    return true;
  }

  private parseFocusPreferences(value: unknown): FocusPreferences | undefined {
    if (!value || typeof value !== 'object') {
      return undefined;
    }

    const fp = value as Record<string, unknown>;
    return {
      gateEnabled: (fp['gateEnabled'] as boolean) ?? DEFAULT_FOCUS_PREFERENCES.gateEnabled,
      strataEnabled: (fp['strataEnabled'] as boolean) ?? DEFAULT_FOCUS_PREFERENCES.strataEnabled,
      blackBoxEnabled: (fp['blackBoxEnabled'] as boolean) ?? DEFAULT_FOCUS_PREFERENCES.blackBoxEnabled,
      maxSnoozePerDay: (fp['maxSnoozePerDay'] as number) ?? DEFAULT_FOCUS_PREFERENCES.maxSnoozePerDay,
      routineResetHourLocal:
        (fp['routineResetHourLocal'] as number) ?? DEFAULT_FOCUS_PREFERENCES.routineResetHourLocal,
      restReminderHighLoadMinutes:
        (fp['restReminderHighLoadMinutes'] as number) ?? DEFAULT_FOCUS_PREFERENCES.restReminderHighLoadMinutes,
      restReminderLowLoadMinutes:
        (fp['restReminderLowLoadMinutes'] as number) ?? DEFAULT_FOCUS_PREFERENCES.restReminderLowLoadMinutes,
    };
  }
  
  /**
   * 获取 Supabase 客户端
   */
  private getSupabaseClient(): SupabaseClient | null {
    if (!this.supabase.isConfigured) return null;
    try {
      return this.supabase.client();
    } catch {
      // eslint-disable-next-line no-restricted-syntax -- 返回 null 语义正确：客户端不可用时静默降级
      return null;
    }
  }
  
  /**
   * 加载用户偏好
   * 
   * 【修复】查询所有偏好字段，支持跨设备同步 colorMode/autoResolveConflicts/localBackup/focusPreferences
   */
  async loadUserPreferences(userId: string): Promise<UserPreferences | null> {
    const client = this.getSupabaseClient();
    if (!client) return null;

    if (this.shouldDeferForBrowserSuspension('加载', userId)) {
      return null;
    }
    
    try {
      const { data, error } = await client
        .from('user_preferences')
        .select('theme,layout_direction,floating_window_pref,color_mode,auto_resolve_conflicts,local_backup_enabled,local_backup_interval_ms,last_backup_proof_at,focus_preferences')
        .eq('user_id', userId)
        .maybeSingle();
      
      if (error) throw supabaseErrorToError(error);
      if (!data) return null;
      
      // 解析 focusPreferences（JSONB → 领域模型）
      const focusPreferences = this.parseFocusPreferences(data.focus_preferences);

      return {
        theme: (data.theme as ThemeType) || 'default',
        layoutDirection: (data.layout_direction as 'ltr' | 'rtl') || 'ltr',
        floatingWindowPref: (data.floating_window_pref as 'auto' | 'fixed') || 'auto',
        colorMode: (data.color_mode as ColorMode) || 'system',
        autoResolveConflicts: data.auto_resolve_conflicts ?? true,
        localBackupEnabled: data.local_backup_enabled ?? false,
        localBackupIntervalMs: data.local_backup_interval_ms ?? 3600000,
        lastBackupProofAt: data.last_backup_proof_at ?? undefined,
        focusPreferences,
      };
    } catch (e) {
      if (this.shouldDeferForBrowserSuspension('加载', userId, e)) {
        return null;
      }

      this.logger.error('加载用户偏好失败', e);
      // eslint-disable-next-line no-restricted-syntax -- 返回 null 语义正确：偏好加载失败使用默认值
      return null;
    }
  }
  
  /**
   * 保存用户偏好
   * 
   * 【修复】保存所有偏好字段，支持跨设备同步
   */
  async saveUserPreferences(userId: string, preferences: Partial<UserPreferences>): Promise<boolean> {
    const client = this.getSupabaseClient();
    if (!client) return false;

    if (this.shouldDeferForBrowserSuspension('保存', userId)) {
      return false;
    }
    
    try {
      // 构建 upsert payload，只包含有值的字段
      const payload: Record<string, unknown> = {
        user_id: userId,
        updated_at: nowISO()
      };
      
      if (preferences.theme !== undefined) payload['theme'] = preferences.theme;
      if (preferences.layoutDirection !== undefined) payload['layout_direction'] = preferences.layoutDirection;
      if (preferences.floatingWindowPref !== undefined) payload['floating_window_pref'] = preferences.floatingWindowPref;
      if (preferences.colorMode !== undefined) payload['color_mode'] = preferences.colorMode;
      if (preferences.autoResolveConflicts !== undefined) payload['auto_resolve_conflicts'] = preferences.autoResolveConflicts;
      if (preferences.localBackupEnabled !== undefined) payload['local_backup_enabled'] = preferences.localBackupEnabled;
      if (preferences.localBackupIntervalMs !== undefined) payload['local_backup_interval_ms'] = preferences.localBackupIntervalMs;
      if (preferences.lastBackupProofAt !== undefined) payload['last_backup_proof_at'] = preferences.lastBackupProofAt;
      if (preferences.focusPreferences !== undefined) payload['focus_preferences'] = preferences.focusPreferences;
      
      const { error } = await client
        .from('user_preferences')
        .upsert(payload, { onConflict: 'user_id' });
      
      if (error) throw supabaseErrorToError(error);
      return true;
    } catch (e) {
      if (this.shouldDeferForBrowserSuspension('保存', userId, e)) {
        return false;
      }

      this.logger.error('保存用户偏好失败', e);
      return false;
    }
  }
}
