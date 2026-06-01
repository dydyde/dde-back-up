import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalBackupUIService } from './local-backup-ui.service';
import { LocalBackupService } from '../../../../services/local-backup.service';
import { ImportService } from '../../../../services/import.service';
import { LoggerService } from '../../../../services/logger.service';

describe('LocalBackupUIService', () => {
  const autoBackupEnabled = signal(false);
  const isAuthorized = signal(false);
  const alertMock = vi.fn();

  const localBackupServiceMock = {
    autoBackupEnabled,
    isAuthorized,
    setProjectsProvider: vi.fn(),
    stopAutoBackup: vi.fn(),
    performBackup: vi.fn(),
    resumePermission: vi.fn(),
    startAutoBackup: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('alert', alertMock);
    autoBackupEnabled.set(false);
    isAuthorized.set(false);

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        LocalBackupUIService,
        { provide: LocalBackupService, useValue: localBackupServiceMock },
        { provide: ImportService, useValue: {} },
        { provide: LoggerService, useValue: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } },
      ],
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('turns auto backup off even when permission has expired', async () => {
    autoBackupEnabled.set(true);
    isAuthorized.set(false);
    const service = TestBed.inject(LocalBackupUIService);

    await service.toggleAutoBackup(() => []);

    expect(localBackupServiceMock.stopAutoBackup).toHaveBeenCalledTimes(1);
    expect(localBackupServiceMock.resumePermission).not.toHaveBeenCalled();
    expect(localBackupServiceMock.startAutoBackup).not.toHaveBeenCalled();
  });

  it('shows a retry notice when manual backup is postponed', async () => {
    const service = TestBed.inject(LocalBackupUIService);
    localBackupServiceMock.performBackup.mockResolvedValue({
      success: false,
      deferred: true,
      error: '浏览器恢复连接中，自动备份稍后重试',
    });

    await service.handleManualBackup([{
      id: 'p1',
      name: 'Test',
      description: '',
      createdDate: new Date().toISOString(),
      tasks: [],
      connections: [],
    }]);

    expect(alertMock).toHaveBeenCalledWith('备份暂未完成：浏览器恢复连接中，自动备份稍后重试');
  });
});
