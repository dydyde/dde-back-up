import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Injector } from '@angular/core';
import { LocalBackupService } from './local-backup.service';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { ExportService } from './export.service';
import { UiStateService } from './ui-state.service';
import { PreferenceService } from './preference.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { DisasterBackupService } from './disaster-backup.service';
import { resetBrowserNetworkSuspensionTrackingForTests } from '../utils/browser-network-suspension';

const mockLoggerCategory = {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
};

const disasterBackupServiceMock = {
  buildLocalBlob: vi.fn(),
};

const exportServiceMock = {
  recordLocalBackupSuccess: vi.fn(),
};

describe('LocalBackupService', () => {
  let service: LocalBackupService;

  beforeEach(() => {
    localStorage.clear();
    mockLoggerCategory.info.mockReset();
    mockLoggerCategory.warn.mockReset();
    mockLoggerCategory.error.mockReset();
    mockLoggerCategory.debug.mockReset();
    exportServiceMock.recordLocalBackupSuccess.mockReset();
    service = createService();
    disasterBackupServiceMock.buildLocalBlob.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetBrowserNetworkSuspensionTrackingForTests();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'showDirectoryPicker');
  });

  describe('初始状态', () => {
    it('初始未授权', () => {
      expect(service.isAuthorized()).toBe(false);
    });

    it('初始目录名为 null', () => {
      expect(service.directoryName()).toBeNull();
    });

    it('初始无上次备份时间', () => {
      expect(service.lastBackupTime()).toBeNull();
    });

    it('初始未在备份中', () => {
      expect(service.isBackingUp()).toBe(false);
    });

    it('自动备份默认关闭', () => {
      expect(service.autoBackupEnabled()).toBe(false);
    });
  });

  describe('compatibility', () => {
    it('返回兼容性信息', () => {
      const compat = service.compatibility();
      expect(compat).toBeDefined();
      expect(compat).toHaveProperty('isSupported');
    });
  });

  describe('revokeDirectoryAccess', () => {
    it('撤销后状态为未授权', async () => {
      await service.revokeDirectoryAccess();
      expect(service.isAuthorized()).toBe(false);
      expect(service.directoryName()).toBeNull();
    });
  });

  describe('stopAutoBackup', () => {
    it('停止定时器', () => {
      service.stopAutoBackup();
      expect(service.autoBackupEnabled()).toBe(false);
    });
  });

  describe('setAutoBackupInterval', () => {
    it('设置备份间隔', () => {
      service.setAutoBackupInterval(60000);
      expect(service.autoBackupIntervalMs()).toBe(60000);
    });
  });

  describe('ngOnDestroy', () => {
    it('清理时不出错', () => {
      expect(() => service.ngOnDestroy()).not.toThrow();
    });
  });

  describe('requestDirectoryAccess', () => {
    it('不支持 File System Access API 时返回不可用', async () => {
      // In Node/test environment, showDirectoryPicker doesn't exist
      const result = await service.requestDirectoryAccess();
      expect(result).toHaveProperty('success');
      expect(result.success).toBe(false);
    });

    it('选择目录时使用稳定 picker 配置，便于浏览器记住上次目录', async () => {
      const handle = { name: 'backups', kind: 'directory' } as unknown as FileSystemDirectoryHandle;
      window.showDirectoryPicker = vi.fn(async () => handle);
      service = createService();

      const result = await service.requestDirectoryAccess();

      expect(result.success).toBe(true);
      expect(window.showDirectoryPicker).toHaveBeenCalledWith(expect.objectContaining({
        id: 'nanoflow-local-backup',
        mode: 'readwrite',
        startIn: 'documents',
      }));
      expect(service.directoryName()).toBe('backups');
      expect(service.hasSavedHandle()).toBe(true);
    });
  });

  describe('自动备份恢复', () => {
    it('项目提供者接入时应恢复刷新前已开启的自动备份', () => {
      vi.useFakeTimers();
      const getProjects = () => [{ id: 'p1', name: 'Test', tasks: [], connections: [] }];
      const startSpy = vi.spyOn(service, 'startAutoBackup');
      setPrivateSignal(service, '_isAuthorized', true);
      setPrivateSignal(service, '_autoBackupEnabled', true);

      service.setProjectsProvider(getProjects);

      expect(startSpy).toHaveBeenCalledWith(getProjects, undefined, { silent: true });
      service.stopAutoBackup();
    });

    it('自动备份定时器不应在无用户手势时请求目录权限', async () => {
      vi.useFakeTimers();
      const handle = createDirectoryHandleMock('backups', 'prompt');
      (service as unknown as { directoryHandle: FileSystemDirectoryHandle }).directoryHandle = handle;
      setPrivateSignal(service, '_isAuthorized', true);

      service.startAutoBackup(
        () => [{ id: 'p1', name: 'Test', tasks: [], connections: [] }],
        1000,
        { silent: true },
      );
      await vi.advanceTimersByTimeAsync(1000);

      expect(handle.queryPermission).toHaveBeenCalledWith({ mode: 'readwrite' });
      expect(handle.requestPermission).not.toHaveBeenCalled();
      expect(disasterBackupServiceMock.buildLocalBlob).not.toHaveBeenCalled();
      service.stopAutoBackup();
    });

    it('目录句柄状态失效时应暂停自动备份并清理授权状态', async () => {
      vi.useFakeTimers();
      const handle = createDirectoryHandleMock('backups', 'granted');
      handle.getFileHandle = vi.fn(async () => {
        throw createStaleDirectoryHandleError();
      }) as FileSystemDirectoryHandle['getFileHandle'];

      (service as unknown as { directoryHandle: FileSystemDirectoryHandle }).directoryHandle = handle;
      setPrivateSignal(service, '_isAuthorized', true);
      setPrivateSignal(service, '_hasSavedHandle', true);
      setPrivateSignal(service, '_directoryName', 'backups');
      disasterBackupServiceMock.buildLocalBlob.mockResolvedValue({
        payload: { payloadVersion: '2.0.0' },
        blob: new Blob(['{}'], { type: 'application/json' }),
      });

      service.startAutoBackup(
        () => [{ id: 'p1', name: 'Test', tasks: [], connections: [] }],
        1000,
        { silent: true },
      );
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(0);

      expect(service.autoBackupEnabled()).toBe(true);
      expect(service.isAuthorized()).toBe(false);
      expect(service.hasSavedHandle()).toBe(false);
      expect(service.directoryName()).toBeNull();
    });

    it('浏览器网络挂起时应静默跳过本轮自动备份', async () => {
      vi.useFakeTimers();
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      setPrivateSignal(service, '_isAuthorized', true);

      service.startAutoBackup(
        () => [{ id: 'p1', name: 'Test', tasks: [], connections: [] }],
        1000,
        { silent: true },
      );
      await vi.advanceTimersByTimeAsync(1000);

      expect(disasterBackupServiceMock.buildLocalBlob).not.toHaveBeenCalled();
      expect(mockLoggerCategory.warn).not.toHaveBeenCalledWith('自动备份失败', expect.anything());
      expect(mockLoggerCategory.debug).toHaveBeenCalledWith(
        '浏览器网络恢复窗口内跳过本轮自动备份',
        expect.objectContaining({ resumeDelayMs: expect.any(Number) }),
      );
      service.stopAutoBackup();
    });

    it('浏览器网络挂起结束后应补跑刚刚跳过的自动备份', async () => {
      vi.useFakeTimers();
      const performBackupSpy = vi.spyOn(service, 'performBackup').mockResolvedValue({ success: true, filename: 'backup.json' });
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      setPrivateSignal(service, '_isAuthorized', true);

      service.startAutoBackup(
        () => [{ id: 'p1', name: 'Test', tasks: [], connections: [] }],
        1000,
        { silent: true },
      );
      await vi.advanceTimersByTimeAsync(1000);

      expect(performBackupSpy).not.toHaveBeenCalled();

      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(1600);

      expect(performBackupSpy).toHaveBeenCalledTimes(1);
      performBackupSpy.mockRestore();
      service.stopAutoBackup();
    });
  });

  describe('performBackup', () => {
    it('未授权时返回失败', async () => {
      const result = await service.performBackup([{
        id: 'p1', name: 'Test', tasks: [], connections: [],
      }]);
      expect(result.success).toBe(false);
    });

    it('授权目录后应通过 DisasterBackupService 生成灾备文件', async () => {
      const writes: Blob[] = [];
      const writable = {
        write: vi.fn(async (blob: Blob) => { writes.push(blob); }),
        close: vi.fn(async () => undefined),
      };
      const fileHandle = {
        createWritable: vi.fn(async () => writable),
        getFile: vi.fn(),
      };

      (service as unknown as { directoryHandle: unknown }).directoryHandle = {
        name: 'backups',
        getFileHandle: vi.fn(async () => fileHandle),
        removeEntry: vi.fn(async () => undefined),
      };
      (service as unknown as { checkAndRestorePermission: () => Promise<boolean> }).checkAndRestorePermission = vi.fn(async () => true);
      service.setAutoBackupInterval(900000);

      disasterBackupServiceMock.buildLocalBlob.mockResolvedValue({
        payload: { payloadVersion: '2.0.0' },
        blob: new Blob(['{"payloadVersion":"2.0.0"}'], { type: 'application/json' }),
      });

      const result = await service.performBackup([{
        id: 'p1', name: 'Test', tasks: [], connections: [],
      }]);

      expect(result.success).toBe(true);
      expect(disasterBackupServiceMock.buildLocalBlob).toHaveBeenCalledWith(
        [{ id: 'p1', name: 'Test', tasks: [], connections: [] }],
        { autoBackupEnabled: false, autoBackupIntervalMs: 900000 },
      );
      expect(exportServiceMock.recordLocalBackupSuccess).toHaveBeenCalledWith(result.timestamp);
      expect(writes).toHaveLength(1);
    });

    it('云端用户态延后时不应写入部分备份文件', async () => {
      const writable = {
        write: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      };
      const fileHandle = {
        createWritable: vi.fn(async () => writable),
        getFile: vi.fn(),
      };

      (service as unknown as { directoryHandle: unknown }).directoryHandle = {
        name: 'backups',
        getFileHandle: vi.fn(async () => fileHandle),
        removeEntry: vi.fn(async () => undefined),
      };
      (service as unknown as { checkAndRestorePermission: () => Promise<boolean> }).checkAndRestorePermission = vi.fn(async () => true);

      disasterBackupServiceMock.buildLocalBlob.mockResolvedValue({
        payload: { payloadVersion: '2.0.0', coverage: { includesCloudUserState: false } },
        blob: new Blob(['{"payloadVersion":"2.0.0"}'], { type: 'application/json' }),
        deferredCloudUserState: true,
      });

      const result = await service.performBackup([{
        id: 'p1', name: 'Test', tasks: [], connections: [],
      }]);

      expect(result).toEqual(expect.objectContaining({
        success: false,
        deferred: true,
      }));
      expect(fileHandle.createWritable).not.toHaveBeenCalled();
      expect(exportServiceMock.recordLocalBackupSuccess).not.toHaveBeenCalled();
    });
  });

  function setPrivateSignal<T>(target: LocalBackupService, key: string, value: T): void {
    (target as unknown as Record<string, { set(next: T): void }>)[key].set(value);
  }

  function createDirectoryHandleMock(name: string, permission: PermissionState): FileSystemDirectoryHandle {
    return {
      name,
      kind: 'directory',
      queryPermission: vi.fn(async () => permission),
      requestPermission: vi.fn(async () => permission),
      getFileHandle: vi.fn(),
      removeEntry: vi.fn(),
      values: vi.fn(),
    } as unknown as FileSystemDirectoryHandle;
  }

  function createStaleDirectoryHandleError(): DOMException {
    return new DOMException(
      'An operation that depends on state cached in an interface object was made but the state had changed since it was read from disk.',
      'InvalidStateError',
    );
  }

  function createService(): LocalBackupService {
    const injector = Injector.create({
      providers: [
        { provide: LocalBackupService, useClass: LocalBackupService },
        { provide: LoggerService, useValue: { category: () => mockLoggerCategory } },
        { provide: ToastService, useValue: { info: vi.fn(), warning: vi.fn(), error: vi.fn(), success: vi.fn() } },
        { provide: ExportService, useValue: exportServiceMock },
        { provide: UiStateService, useValue: { isMobile: vi.fn(() => false) } },
        { provide: PreferenceService, useValue: { get: vi.fn(), set: vi.fn(), syncLocalBackupSettings: vi.fn() } },
        { provide: SentryLazyLoaderService, useValue: { captureException: vi.fn() } },
        { provide: DisasterBackupService, useValue: disasterBackupServiceMock },
      ],
    });
    return injector.get(LocalBackupService);
  }
});
