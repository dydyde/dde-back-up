/**
 * WorkspaceModalCoordinatorService 单元测试
 */
import { Injector, runInInjectionContext } from '@angular/core';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkspaceModalCoordinatorService } from './workspace-modal-coordinator.service';
import { ToastService } from './toast.service';
import { GlobalErrorHandler } from './global-error-handler.service';
import { DynamicModalService } from './dynamic-modal.service';
import { ModalLoaderService } from '../app/core/services/modal-loader.service';
import { ProjectStateService } from './project-state.service';
import { ProjectOperationService } from './project-operation.service';
import { SyncCoordinatorService } from './sync-coordinator.service';
import { AppAuthCoordinatorService } from '../app/core/services/app-auth-coordinator.service';
import { Router } from '@angular/router';
import { type ConflictData } from './modal.service';
import { type ConflictResolutionPlan } from './conflict-resolution.types';

// ── Fake component for modal loading ─────────────────────────
class FakeComponent {}

// ── Mock factories ───────────────────────────────────────────

const mockToast = { error: vi.fn(), info: vi.fn(), success: vi.fn() };
const mockRouter = { navigateByUrl: vi.fn() };
const mockErrorHandler = { dismissRecoveryDialog: vi.fn() };

let setInputSpy = vi.fn();
const createModalRef = () => {
  let resolver: ((value?: unknown) => void) | null = null;
  const result = new Promise(resolve => {
    resolver = resolve as (value?: unknown) => void;
  });

  const ref = {
    close: vi.fn((value?: unknown) => {
      resolver?.(value);
    }),
    result,
    componentRef: { setInput: (...args: unknown[]) => setInputSpy(...args) } as never,
  };

  return ref;
};

let lastModalRef: ReturnType<typeof createModalRef> | null = null;
const mockDynamicModal = {
  open: vi.fn(() => {
    lastModalRef = createModalRef();
    return lastModalRef;
  }),
  close: vi.fn(),
};

const mockModalLoader = {
  loadSettingsModal: vi.fn().mockResolvedValue(FakeComponent),
  loadDashboardModal: vi.fn().mockResolvedValue(FakeComponent),
  loadLoginModal: vi.fn().mockResolvedValue(FakeComponent),
  loadTrashModal: vi.fn().mockResolvedValue(FakeComponent),
  loadConfigHelpModal: vi.fn().mockResolvedValue(FakeComponent),
  loadNewProjectModal: vi.fn().mockResolvedValue(FakeComponent),
  loadMigrationModal: vi.fn().mockResolvedValue(FakeComponent),
  loadErrorRecoveryModal: vi.fn().mockResolvedValue(FakeComponent),
  loadConflictModal: vi.fn().mockResolvedValue(FakeComponent),
  loadStorageEscapeModal: vi.fn().mockResolvedValue(FakeComponent),
};

const mockProjectState = { projects: vi.fn(() => []) };
const mockProjectOps = {
  resolveConflict: vi.fn().mockResolvedValue(undefined),
  resolveConflictWithPlan: vi.fn().mockResolvedValue(true),
};
const mockSyncCoordinator = { clearActiveConflict: vi.fn() };
const mockAuthCoord = {
  sessionEmail: vi.fn(() => ''),
  authError: vi.fn(() => null),
  isAuthLoading: vi.fn(() => false),
  resetPasswordSent: vi.fn(() => false),
  isReloginMode: { set: vi.fn() },
};

describe('WorkspaceModalCoordinatorService', () => {
  let service: WorkspaceModalCoordinatorService;
  let injector: Injector;

  beforeEach(() => {
    vi.clearAllMocks();
    setInputSpy = vi.fn();
    mockProjectOps.resolveConflict.mockResolvedValue(true);
    mockProjectOps.resolveConflictWithPlan.mockResolvedValue(true);
    lastModalRef = null;

    injector = Injector.create({
      providers: [
        { provide: WorkspaceModalCoordinatorService, useClass: WorkspaceModalCoordinatorService },
        { provide: ToastService, useValue: mockToast },
        { provide: Router, useValue: mockRouter },
        { provide: GlobalErrorHandler, useValue: mockErrorHandler },
        { provide: DynamicModalService, useValue: mockDynamicModal },
        { provide: ModalLoaderService, useValue: mockModalLoader },
        { provide: ProjectStateService, useValue: mockProjectState },
        { provide: ProjectOperationService, useValue: mockProjectOps },
        { provide: SyncCoordinatorService, useValue: mockSyncCoordinator },
        { provide: AppAuthCoordinatorService, useValue: mockAuthCoord },
      ],
    });

    service = runInInjectionContext(injector, () => injector.get(WorkspaceModalCoordinatorService));
  });

  // ── Initial state ──────────────────────────────────────────

  it('should have empty modalLoading by default', () => {
    expect(service.modalLoading()).toEqual({});
  });

  it('should have null storageEscapeData by default', () => {
    expect(service.storageEscapeData()).toBeNull();
  });

  // ── isModalLoading ─────────────────────────────────────────

  it('should return false for unknown modal type', () => {
    expect(service.isModalLoading('unknown')).toBe(false);
  });

  // ── initCallbacks ──────────────────────────────────────────

  it('should store callbacks without error', () => {
    const callbacks = { signOut: vi.fn() };
    expect(() => service.initCallbacks(callbacks)).not.toThrow();
  });

  // ── openSettings ───────────────────────────────────────────

  it('should load component, open modal, and manage loading flag', async () => {
    await service.openSettings();

    expect(mockModalLoader.loadSettingsModal).toHaveBeenCalledOnce();
    expect(mockDynamicModal.open).toHaveBeenCalledOnce();
    // Loading flag should be cleared after completion
    expect(service.isModalLoading('settings')).toBe(false);
  });

  it('should show error toast when settings load fails', async () => {
    mockModalLoader.loadSettingsModal.mockRejectedValueOnce(new Error('fail'));

    await service.openSettings();

    expect(mockToast.error).toHaveBeenCalledOnce();
    expect(service.isModalLoading('settings')).toBe(false);
  });

  // ── closeSettings ──────────────────────────────────────────

  it('should close modal and reset reloginMode', () => {
    service.closeSettings();

    expect(mockDynamicModal.close).toHaveBeenCalledOnce();
    expect(mockAuthCoord.isReloginMode.set).toHaveBeenCalledWith(false);
  });

  // ── openLoginModal ─────────────────────────────────────────

  it('should open login modal with auth inputs', async () => {
    await service.openLoginModal();

    expect(mockModalLoader.loadLoginModal).toHaveBeenCalledOnce();
    expect(mockDynamicModal.open).toHaveBeenCalledOnce();

    const openCall = mockDynamicModal.open.mock.calls[0] as unknown[];
    const config = openCall[1] as Record<string, unknown>;
    expect(config['inputs']).toHaveProperty('authError');
    expect(config['inputs']).toHaveProperty('isLoading');
    expect(config['inputs']).toHaveProperty('resetPasswordSent');
    expect(config['closeOnBackdropClick']).toBe(false);
    expect(config['closeOnEscape']).toBe(false);
  });

  // ── closeLoginModal ────────────────────────────────────────

  it('should close login modal ref when it exists', async () => {
    await service.openLoginModal();
    service.loginReturnUrl = '/dashboard';
    service.closeLoginModal();
    expect(lastModalRef?.close).toHaveBeenCalledOnce();
    expect(service.loginReturnUrl).toBeNull();
  });

  it('should be no-op when no login modal ref', () => {
    // Should not throw
    expect(() => service.closeLoginModal()).not.toThrow();
  });

  // ── navigateAfterLogin ─────────────────────────────────────

  it('should navigate to return URL', () => {
    service.loginReturnUrl = '/dashboard';
    service.navigateAfterLogin();

    expect(mockRouter.navigateByUrl).toHaveBeenCalledWith('/dashboard');
    expect(service.loginReturnUrl).toBeNull();
  });

  it('should skip navigation for root URL', () => {
    service.loginReturnUrl = '/';
    service.navigateAfterLogin();

    expect(mockRouter.navigateByUrl).not.toHaveBeenCalled();
  });

  it('should skip navigation when no return URL', () => {
    service.loginReturnUrl = null;
    service.navigateAfterLogin();

    expect(mockRouter.navigateByUrl).not.toHaveBeenCalled();
  });

  // ── openTrashModal ─────────────────────────────────────────

  it('should load and open trash modal', async () => {
    await service.openTrashModal();

    expect(mockModalLoader.loadTrashModal).toHaveBeenCalledOnce();
    expect(mockDynamicModal.open).toHaveBeenCalledOnce();
    expect(service.isModalLoading('trash')).toBe(false);
  });

  it('should not reopen dashboard while it is already open', async () => {
    await service.openDashboard();
    await service.openDashboard();

    expect(mockModalLoader.loadDashboardModal).toHaveBeenCalledOnce();
    expect(mockDynamicModal.open).toHaveBeenCalledOnce();
  });

  it('should allow reopening dashboard after modal ref is externally closed', async () => {
    await service.openDashboard();
    lastModalRef?.close();
    await Promise.resolve();
    await service.openDashboard();

    expect(mockModalLoader.loadDashboardModal).toHaveBeenCalledTimes(2);
    expect(mockDynamicModal.open).toHaveBeenCalledTimes(2);
  });

  // ── resolveConflictLocal ───────────────────────────────────

  it('should resolve conflict and close modal', async () => {
    await service.openConflictModal({ projectId: 'p-1' } as ConflictData);

    await service.resolveConflictLocal();

    expect(mockProjectOps.resolveConflict).toHaveBeenCalledWith('p-1', 'local', { backgroundPersist: true });
    expect(lastModalRef?.close).toHaveBeenCalledWith({ choice: 'local' });
    expect(setInputSpy).toHaveBeenCalledWith('isResolving', true);
    expect(setInputSpy).toHaveBeenCalledWith('activeResolution', 'local');
    expect(mockToast.success).toHaveBeenCalledWith('已保留本地修改', '冲突已在本地解决，后台会自动同步到云端');
  });

  it('should keep conflict modal open when resolveConflict returns false', async () => {
    await service.openConflictModal({ projectId: 'p-1' } as ConflictData);
    mockProjectOps.resolveConflict.mockResolvedValueOnce(false);

    await service.resolveConflictLocal();

    expect(mockProjectOps.resolveConflict).toHaveBeenCalledWith('p-1', 'local', { backgroundPersist: true });
    expect(lastModalRef?.close).not.toHaveBeenCalled();

    mockProjectOps.resolveConflict.mockResolvedValueOnce(true);
    await service.resolveConflictLocal();

    expect(lastModalRef?.close).toHaveBeenCalledWith({ choice: 'local' });
  });

  it('should apply conflict resolution plan and close modal', async () => {
    await service.openConflictModal({ projectId: 'p-1' } as ConflictData);

    await service.applyConflictResolutionPlan({
      taskChoices: { 'task-1': 'remote' },
      appliedBy: 'mixed',
    });

    expect(mockProjectOps.resolveConflictWithPlan).toHaveBeenCalledWith('p-1', {
      taskChoices: { 'task-1': 'remote' },
      appliedBy: 'mixed',
    }, { backgroundPersist: true });
    expect(lastModalRef?.close).toHaveBeenCalledWith({ choice: 'merge' });
    expect(setInputSpy).toHaveBeenCalledWith('activeResolution', 'plan');
    expect(mockToast.success).toHaveBeenCalledWith('已按系统建议解决冲突', '冲突已在本地解决，后台会自动同步到云端');
  });

  it('should wire conflict modal applyPlan output to the plan resolver', async () => {
    await service.openConflictModal({ projectId: 'p-1' } as ConflictData);

    const openCall = mockDynamicModal.open.mock.calls[0] as unknown[];
    const config = openCall[1] as {
      outputs: {
        applyPlan: (plan: ConflictResolutionPlan) => Promise<void>;
      };
    };

    await config.outputs.applyPlan({
      taskChoices: { 'task-1': 'local' },
      appliedBy: 'mixed',
    });

    expect(mockProjectOps.resolveConflictWithPlan).toHaveBeenCalledWith('p-1', {
      taskChoices: { 'task-1': 'local' },
      appliedBy: 'mixed',
    }, { backgroundPersist: true });
    expect(lastModalRef?.close).toHaveBeenCalledWith({ choice: 'merge' });
  });

  it('should keep conflict modal open when applyPlan resolution returns false', async () => {
    await service.openConflictModal({ projectId: 'p-1' } as ConflictData);
    mockProjectOps.resolveConflictWithPlan.mockResolvedValueOnce(false);

    const openCall = mockDynamicModal.open.mock.calls[0] as unknown[];
    const config = openCall[1] as {
      outputs: {
        applyPlan: (plan: ConflictResolutionPlan) => Promise<void>;
      };
    };

    await config.outputs.applyPlan({
      taskChoices: { 'task-1': 'remote' },
      appliedBy: 'user',
    });

    expect(mockProjectOps.resolveConflictWithPlan).toHaveBeenCalledWith('p-1', {
      taskChoices: { 'task-1': 'remote' },
      appliedBy: 'user',
    }, { backgroundPersist: true });
    expect(lastModalRef?.close).not.toHaveBeenCalled();
    expect(mockToast.success).not.toHaveBeenCalled();
    expect(setInputSpy).toHaveBeenCalledWith('isResolving', false);
  });

  // ── cancelConflictResolution ───────────────────────────────

  it('should close modal and show info toast', async () => {
    await service.openConflictModal({ projectId: 'p-1' } as ConflictData);

    service.cancelConflictResolution();

    expect(lastModalRef?.close).toHaveBeenCalledWith({ choice: 'cancel' });
    expect(mockSyncCoordinator.clearActiveConflict).toHaveBeenCalled();
    expect(mockToast.info).toHaveBeenCalled();
  });

  it('should refuse resolving when conflict data is missing', async () => {
    await service.resolveConflictLocal();

    expect(mockProjectOps.resolveConflict).not.toHaveBeenCalled();
    expect(mockToast.error).toHaveBeenCalledWith('冲突数据已失效', '请稍后重试，或等待下次同步重新触发');
  });

  it('should not open conflict modal twice', async () => {
    await service.openConflictModal({ projectId: 'p-1' } as ConflictData);
    await service.openConflictModal({ projectId: 'p-1' } as ConflictData);

    expect(mockDynamicModal.open).toHaveBeenCalledTimes(1);
    expect(mockToast.info).toHaveBeenCalledWith('冲突窗口已打开', '请先在当前窗口完成处理');
  });

  it('should update conflict modal inputs when pending conflict changes', async () => {
    await service.openConflictModal({ projectId: 'p-1' } as ConflictData);

    service.setPendingConflict({ projectId: 'p-2' } as ConflictData);

    expect(setInputSpy).toHaveBeenCalledWith('conflictData', { projectId: 'p-2' });
  });

  // ── openDashboard initialTab & openConflictCenterFromDashboard ─────────

  it('openDashboard 应通过 inputs 透传 initialTab 给 DashboardModalComponent', async () => {
    await service.openDashboard({ initialTab: 'conflicts' });

    expect(mockDynamicModal.open).toHaveBeenCalledOnce();
    const callArgs = mockDynamicModal.open.mock.calls[0];
    const config = callArgs[1] as { inputs?: Record<string, unknown> };
    expect(config?.inputs).toEqual({ initialTab: 'conflicts' });
  });

  it('openConflictCenterFromDashboard 应切换已打开仪表盘的 Tab 而不是关闭它', async () => {
    const setActiveTabSpy = vi.fn();
    // 在打开仪表盘前替换 modalRef 的 componentRef.instance，模拟 DashboardModalComponent.setActiveTab。
    mockDynamicModal.open.mockImplementationOnce(() => {
      const ref = createModalRef();
      (ref as unknown as { componentRef: { instance: unknown; setInput: unknown } }).componentRef = {
        instance: { setActiveTab: setActiveTabSpy },
        setInput: (...args: unknown[]) => setInputSpy(...args),
      };
      lastModalRef = ref;
      return ref;
    });
    await service.openDashboard();

    service.openConflictCenterFromDashboard();

    expect(setActiveTabSpy).toHaveBeenCalledWith('conflicts');
    expect(lastModalRef?.close).not.toHaveBeenCalled();
    // 不再误导用户：原"请从项目列表中选择..."toast 应不再触发
    expect(mockToast.info).not.toHaveBeenCalledWith('冲突解决中心', expect.stringContaining('请从项目列表中选择'));
  });
});
