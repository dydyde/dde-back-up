import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { By } from '@angular/platform-browser';
import { SettingsModalComponent } from './settings-modal.component';
import { LoggerService } from '../../../services/logger.service';
import { UserSessionService } from '../../../services/user-session.service';
import { PreferenceService } from '../../../services/preference.service';
import { ExportService } from '../../../services/export.service';
import { ImportService } from '../../../services/import.service';
import { AttachmentExportService } from '../../../services/attachment-export.service';
import { AttachmentImportService } from '../../../services/attachment-import.service';
import { LocalBackupService } from '../../../services/local-backup.service';
import { ThemeService } from '../../../services/theme.service';
import { DockEngineService } from '../../../services/dock-engine.service';
import { FocusPreferenceService } from '../../../services/focus-preference.service';
import { GateService } from '../../../services/gate.service';
import { ExternalSourceCacheService } from '../../core/external-sources/external-source-cache.service';
import { SiyuanPreviewService } from '../../core/external-sources/siyuan/siyuan-preview.service';

describe('SettingsModalComponent', () => {
  let fixture: ComponentFixture<SettingsModalComponent>;
  let component: SettingsModalComponent;

  type MockFocusPreferences = {
    gateEnabled: boolean;
    blackBoxEnabled: boolean;
    strataEnabled: boolean;
    maxSnoozePerDay: number;
    routineResetHourLocal: number;
    restReminderHighLoadMinutes: number;
    restReminderLowLoadMinutes: number;
  };

  const currentUserId = signal<string | null>('user-1');
  const theme = signal<'default' | 'ocean' | 'forest' | 'sunset' | 'lavender'>('default');
  const autoResolveConflicts = signal(true);
  const colorMode = signal<'light' | 'dark' | 'system'>('system');
  const dailySlots = signal([
    {
      id: 'slot-1',
      title: '喝水',
      maxDailyCount: 1,
      todayCompletedCount: 0,
      isEnabled: true,
      createdAt: '2026-03-14T08:00:00.000Z',
    },
  ]);
  const focusPreferences = signal<MockFocusPreferences>({
    gateEnabled: true,
    blackBoxEnabled: true,
    strataEnabled: true,
    maxSnoozePerDay: 3,
    routineResetHourLocal: 0,
    restReminderHighLoadMinutes: 90,
    restReminderLowLoadMinutes: 30,
  });

  const mockLogger = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    category: vi.fn(() => ({
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    })),
  };

  const mockPreferenceService = {
    theme,
    autoResolveConflicts,
    setAutoResolveConflicts: vi.fn((enabled: boolean) => autoResolveConflicts.set(enabled)),
  };

  const mockThemeService = {
    colorMode,
    setColorMode: vi.fn((mode: 'light' | 'dark' | 'system') => colorMode.set(mode)),
  };

  const mockFocusPreferenceService = {
    preferences: focusPreferences,
    update: vi.fn((updates: Partial<MockFocusPreferences>) => {
      focusPreferences.update(current => ({ ...current, ...updates }));
    }),
    setRestReminderHighLoadMinutes: vi.fn((minutes: number) => {
      focusPreferences.update(current => ({ ...current, restReminderHighLoadMinutes: minutes }));
    }),
    setRestReminderLowLoadMinutes: vi.fn((minutes: number) => {
      focusPreferences.update(current => ({ ...current, restReminderLowLoadMinutes: minutes }));
    }),
  };

  const mockDockEngine = {
    dailySlots,
    addDailySlot: vi.fn(),
    completeDailySlot: vi.fn(),
    setDailySlotEnabled: vi.fn(),
    removeDailySlot: vi.fn(),
  };

  const mockLocalBackupService = {
    setProjectsProvider: vi.fn(),
    isAvailable: signal(false),
    isAuthorized: signal(false),
    hasSavedHandle: signal(false),
    needsPermissionResume: signal(false),
    directoryName: signal<string | null>(null),
    autoBackupEnabled: signal(false),
    autoBackupIntervalMs: signal(30 * 60 * 1000),
    lastBackupTime: signal<string | null>(null),
    isBackingUp: signal(false),
    requestDirectoryAccess: vi.fn(),
    revokeDirectoryAccess: vi.fn(),
    resumePermission: vi.fn(),
    performBackup: vi.fn(),
    stopAutoBackup: vi.fn(),
    startAutoBackup: vi.fn(),
  };

  const mockExportService = {
    isExporting: signal(false),
    exportAndDownload: vi.fn(),
  };

  const mockImportService = {
    isImporting: signal(false),
    validateFile: vi.fn(),
    generatePreview: vi.fn(),
    executeImport: vi.fn(),
  };

  const mockAttachmentExportService = {
    isExporting: signal(false),
    progress: signal({ percentage: 0, processedCount: 0, totalCount: 0 }),
    exportAndDownload: vi.fn(),
  };

  const mockAttachmentImportService = {
    isImporting: signal(false),
    progress: signal({ percentage: 0, completedItems: 0, failedItems: 0, skippedItems: 0, totalItems: 0 }),
    extractAttachmentsFromZip: vi.fn(),
    importAttachments: vi.fn(),
  };

  const mockUserSession = {
    currentUserId,
  };

  const mockGateService = {
    devForceShowGate: vi.fn(),
  };

  const mockSiyuanCache = {
    loadConfig: vi.fn().mockResolvedValue({
      runtimeMode: 'extension-relay',
      baseUrl: 'http://127.0.0.1:6806',
      token: undefined,
    }),
    saveConfig: vi.fn().mockResolvedValue(undefined),
    clearPreviewCache: vi.fn().mockResolvedValue(undefined),
    forgetConfig: vi.fn().mockResolvedValue(undefined),
  };

  const mockSiyuanPreview = {
    diagnoseConnection: vi.fn().mockResolvedValue({ ok: true, mode: 'extension-relay' }),
    pushExtensionConfig: vi.fn().mockResolvedValue({ ok: true }),
    getExtensionConfigStatus: vi.fn().mockResolvedValue({ baseUrl: 'http://127.0.0.1:6806', hasToken: false }),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    currentUserId.set('user-1');
    theme.set('default');
    autoResolveConflicts.set(true);
    colorMode.set('system');
    dailySlots.set([
      {
        id: 'slot-1',
        title: '喝水',
        maxDailyCount: 1,
        todayCompletedCount: 0,
        isEnabled: true,
        createdAt: '2026-03-14T08:00:00.000Z',
      },
    ]);
    focusPreferences.set({
      gateEnabled: true,
      blackBoxEnabled: true,
      strataEnabled: true,
      maxSnoozePerDay: 3,
      routineResetHourLocal: 0,
      restReminderHighLoadMinutes: 90,
      restReminderLowLoadMinutes: 30,
    });

    await TestBed.configureTestingModule({
      imports: [SettingsModalComponent],
      providers: [
        { provide: LoggerService, useValue: mockLogger },
        { provide: UserSessionService, useValue: mockUserSession },
        { provide: PreferenceService, useValue: mockPreferenceService },
        { provide: ExportService, useValue: mockExportService },
        { provide: ImportService, useValue: mockImportService },
        { provide: AttachmentExportService, useValue: mockAttachmentExportService },
        { provide: AttachmentImportService, useValue: mockAttachmentImportService },
        { provide: LocalBackupService, useValue: mockLocalBackupService },
        { provide: ThemeService, useValue: mockThemeService },
        { provide: DockEngineService, useValue: mockDockEngine },
        { provide: FocusPreferenceService, useValue: mockFocusPreferenceService },
        { provide: GateService, useValue: mockGateService },
        { provide: ExternalSourceCacheService, useValue: mockSiyuanCache },
        { provide: SiyuanPreviewService, useValue: mockSiyuanPreview },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(SettingsModalComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should remove the obsolete backup reminder setting from the UI', () => {
    expect(fixture.nativeElement.textContent).not.toContain('定期备份提醒');
  });

  it('should emit themeChange when a theme tile is selected', () => {
    const themeSpy = vi.fn();
    component.themeChange.subscribe(themeSpy);

    findButtonByText('海洋').click();

    expect(themeSpy).toHaveBeenCalledWith('ocean');
  });

  it('should update color mode directly through ThemeService', () => {
    findButtonByText('深色').click();

    expect(mockThemeService.setColorMode).toHaveBeenCalledWith('dark');
    expect(colorMode()).toBe('dark');
  });

  it('should expose a stable settings modal test id', () => {
    expect(fixture.nativeElement.querySelector('[data-testid="settings-modal"]')).toBeTruthy();
  });

  it('should keep the black box toggle visible and functional', () => {
    const toggle = fixture.debugElement.query(By.css('[data-testid="settings-blackbox-toggle"]'));

    expect(fixture.nativeElement.textContent).toContain('黑匣子');
    expect(toggle).toBeTruthy();

    (toggle.nativeElement as HTMLButtonElement).click();

    expect(mockFocusPreferenceService.update).toHaveBeenCalledWith({ blackBoxEnabled: false });
  });

  it('should toggle auto resolve conflicts via PreferenceService', () => {
    component.toggleAutoResolve();

    expect(mockPreferenceService.setAutoResolveConflicts).toHaveBeenCalledWith(false);
    expect(autoResolveConflicts()).toBe(false);
  });

  it('should forward rest reminder changes to FocusPreferenceService', () => {
    const highLoadSelect = fixture.debugElement.query(By.css('[data-testid="settings-rest-reminder-high"]')).nativeElement as HTMLSelectElement;
    const lowLoadSelect = fixture.debugElement.query(By.css('[data-testid="settings-rest-reminder-low"]')).nativeElement as HTMLSelectElement;

    highLoadSelect.value = '120';
    highLoadSelect.dispatchEvent(new Event('change'));
    lowLoadSelect.value = '15';
    lowLoadSelect.dispatchEvent(new Event('change'));

    expect(mockFocusPreferenceService.setRestReminderHighLoadMinutes).toHaveBeenCalledWith(120);
    expect(mockFocusPreferenceService.setRestReminderLowLoadMinutes).toHaveBeenCalledWith(15);
  });

  it('should render SiYuan Knowledge Anchor local-only settings', () => {
    expect(fixture.nativeElement.textContent).toContain('思源知识锚点');
    expect(fixture.nativeElement.textContent).toContain('token 与预览缓存仅保存当前设备');
  });

  it('should persist SiYuan runtime mode changes locally', async () => {
    const siyuanSelect = fixture.nativeElement.querySelector('[data-testid="siyuan-runtime-mode-select"]') as HTMLSelectElement | null;
    expect(siyuanSelect).toBeTruthy();

    siyuanSelect!.value = 'cache-only';
    await component.updateSiyuanRuntimeMode({ target: siyuanSelect } as unknown as Event);

    expect(mockSiyuanCache.saveConfig).toHaveBeenCalledWith(expect.objectContaining({ runtimeMode: 'cache-only' }));
    expect(component.siyuanRuntimeMode()).toBe('cache-only');
  });

  it('should clear SiYuan preview cache without forgetting config', async () => {
    await component.clearSiyuanCache();

    expect(mockSiyuanCache.clearPreviewCache).toHaveBeenCalledTimes(1);
    expect(mockSiyuanCache.forgetConfig).not.toHaveBeenCalled();
    expect(component.siyuanConnectionStatus()).toContain('已清除');
  });

  it('should surface SiYuan connection failures with safe messages', async () => {
    mockSiyuanPreview.diagnoseConnection.mockResolvedValueOnce({
      ok: false,
      mode: 'extension-relay',
      errorCode: 'extension-unavailable',
    });

    await component.testSiyuanConnection();

    expect(component.siyuanConnectionStatus()).toContain('扩展未安装或未注入当前页面');
  });

  it('should keep SiYuan diagnose failures local to settings status', async () => {
    mockSiyuanPreview.diagnoseConnection.mockRejectedValueOnce(new Error('network'));

    await component.testSiyuanConnection();

    expect(component.siyuanConnectionStatus()).toContain('检测失败，请稍后重试');
    expect(mockLogger.warn).toHaveBeenCalledWith('SettingsModal', '思源连接诊断失败', expect.objectContaining({ message: 'network' }));
  });

  it('should push SiYuan baseUrl/token to the extension when the explicit save button is clicked', async () => {
    // 模拟用户在 token 输入框输入一个值
    await component.updateSiyuanToken({ target: { value: 'secret-token-value' } } as unknown as Event);
    expect(component.siyuanTokenMask()).toBe('••••••••');
    // relay 模式下 token 不能写入 IndexedDB
    const tokenWrites = mockSiyuanCache.saveConfig.mock.calls.filter(
      (call: unknown[]) => Object.prototype.hasOwnProperty.call(call[0] as object, 'token') && (call[0] as { token?: string }).token,
    );
    expect(tokenWrites).toHaveLength(0);

    await component.saveSiyuanConfigToExtension();

    expect(mockSiyuanPreview.pushExtensionConfig).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: 'http://127.0.0.1:6806', token: 'secret-token-value' }),
    );
    expect(component.siyuanConnectionStatus()).toContain('已写入扩展');
    // token 在写入扩展后必须立即从 UI 清掉
    expect(component.siyuanTokenMask()).toBe('');
  });

  it('should map push-config failure codes to friendly messages', async () => {
    mockSiyuanPreview.pushExtensionConfig.mockResolvedValueOnce({ ok: false, errorCode: 'extension-unavailable' });

    await component.saveSiyuanConfigToExtension();

    expect(component.siyuanConnectionStatus()).toContain('扩展未安装或未启用');
  });

  it('should surface an "extension not supported" badge when getConfigStatus returns null', async () => {
    mockSiyuanPreview.getExtensionConfigStatus.mockResolvedValueOnce(null);

    await component.loadSiyuanConfig();
    fixture.detectChanges();

    const badge = fixture.nativeElement.querySelector('[data-testid="siyuan-extension-status"]') as HTMLElement | null;
    expect(badge).toBeTruthy();
    expect(badge!.textContent ?? '').toContain('扩展未安装或版本过旧');
    const saveBtn = fixture.nativeElement.querySelector('[data-testid="siyuan-save-to-extension"]') as HTMLButtonElement | null;
    expect(saveBtn).toBeTruthy();
    expect(saveBtn!.disabled).toBe(true);
  });

  function findButtonByText(text: string): HTMLButtonElement {
    const buttons = Array.from(fixture.nativeElement.querySelectorAll('button')) as HTMLButtonElement[];
    const button = buttons.find(candidate => candidate.textContent?.includes(text));
    if (!button) {
      throw new Error(`Button not found: ${text}`);
    }
    return button;
  }
});
