import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalBackupUIService } from './local-backup-ui.service';
import { LocalBackupService } from '../../../../services/local-backup.service';
import { ImportService } from '../../../../services/import.service';
import { LoggerService } from '../../../../services/logger.service';

describe('LocalBackupUIService', () => {
  const autoBackupEnabled = signal(false);
  const isAuthorized = signal(false);

  const localBackupServiceMock = {
    autoBackupEnabled,
    isAuthorized,
    setProjectsProvider: vi.fn(),
    stopAutoBackup: vi.fn(),
    resumePermission: vi.fn(),
    startAutoBackup: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
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

  it('turns auto backup off even when permission has expired', async () => {
    autoBackupEnabled.set(true);
    isAuthorized.set(false);
    const service = TestBed.inject(LocalBackupUIService);

    await service.toggleAutoBackup(() => []);

    expect(localBackupServiceMock.stopAutoBackup).toHaveBeenCalledTimes(1);
    expect(localBackupServiceMock.resumePermission).not.toHaveBeenCalled();
    expect(localBackupServiceMock.startAutoBackup).not.toHaveBeenCalled();
  });
});