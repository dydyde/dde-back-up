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

let resolveModalResult: ((value?: unknown) => void) | null = null;
let setInputSpy = vi.fn();
const mockModalCloseRef = {
  close: vi.fn((value?: unknown) => {
    resolveModalResult?.(value);
  }),
  result: Promise.resolve(undefined),
  componentRef: { setInput: (...args: unknown[]) => setInputSpy(...args) } as never,
};
const mockDynamicModal = {
  open: vi.fn(() => mockModalCloseRef),
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
    mockModalCloseRef.componentRef = { setInput: (...args: unknown[]) => setInputSpy(...args) } as never;
    mockProjectOps.resolveConflict.mockResolvedValue(true);
    mockProjectOps.resolveConflictWithPlan.mockResolvedValue(true);
    mockModalCloseRef.result = new Promise(resolve => {
      resolveModalResult = resolve as (value?: unknown) => void;
    });

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
    expect(mockModalCloseRef.close).toHaveBeenCalledOnce();
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
    mockModalCloseRef.close();
    await Promise.resolve();
    await service.openDashboard();

    expect(mockModalLoader.loadDashboardModal).toHaveBeenCalledTimes(2);
    expect(mockDynamicModal.open).toHaveBeenCalledTimes(2);
  });

  // ── resolveConflictLocal ───────────────────────────────────

  it('should resolve conflict and close modal', async () => {
    // Set up pending conflict
    service.setPendingConflict({ projectId: 'p-1' } as ConflictData);
    // Open conflict modal to set the ref
    await service.openConflictModal({ projectId: 'p-1' } as ConflictData);

    await service.resolveConflictLocal();

    expect(mockProjectOps.resolveConflict).toHaveBeenCalledWith('p-1', 'local', { backgroundPersist: true });
    expect(mockModalCloseRef.close).toHaveBeenCalledWith({ choice: 'local' });
    expect(setInputSpy).toHaveBeenCalledWith('isResolving', true);
    expect(setInputSpy).toHaveBeenCalledWith('activeResolution', 'local');
    expect(mockToast.success).toHaveBeenCalledWith('已保留本地修改', '当前项目已按本地版本解决冲突');
  });

  it('should keep conflict modal open when resolveConflict returns false', async () => {
    service.setPendingConflict({ projectId: 'p-1' } as ConflictData);
    await service.openConflictModal({ projectId: 'p-1' } as ConflictData);
    mockProjectOps.resolveConflict.mockResolvedValueOnce(false);

    await service.resolveConflictLocal();

    expect(mockProjectOps.resolveConflict).toHaveBeenCalledWith('p-1', 'local', { backgroundPersist: true });
    expect(mockModalCloseRef.close).not.toHaveBeenCalled();

    mockProjectOps.resolveConflict.mockResolvedValueOnce(true);
    await service.resolveConflictLocal();

    expect(mockModalCloseRef.close).toHaveBeenCalledWith({ choice: 'local' });
  });

  it('should apply conflict resolution plan and close modal', async () => {
    service.setPendingConflict({ projectId: 'p-1' } as ConflictData);
    await service.openConflictModal({ projectId: 'p-1' } as ConflictData);

    await service.applyConflictResolutionPlan({
      taskChoices: { 'task-1': 'remote' },
      appliedBy: 'mixed',
    });

    expect(mockProjectOps.resolveConflictWithPlan).toHaveBeenCalledWith('p-1', {
      taskChoices: { 'task-1': 'remote' },
      appliedBy: 'mixed',
    }, { backgroundPersist: true });
    expect(mockModalCloseRef.close).toHaveBeenCalledWith({ choice: 'merge' });
    expect(setInputSpy).toHaveBeenCalledWith('activeResolution', 'plan');
    expect(mockToast.success).toHaveBeenCalledWith('已按系统建议解决冲突');
  });

  it('should wire conflict modal applyPlan output to the plan resolver', async () => {
    service.setPendingConflict({ projectId: 'p-1' } as ConflictData);
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
    expect(mockModalCloseRef.close).toHaveBeenCalledWith({ choice: 'merge' });
  });

  it('should keep conflict modal open when applyPlan resolution returns false', async () => {
    service.setPendingConflict({ projectId: 'p-1' } as ConflictData);
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
    expect(mockModalCloseRef.close).not.toHaveBeenCalled();
    expect(mockToast.success).not.toHaveBeenCalled();
    expect(setInputSpy).toHaveBeenCalledWith('isResolving', false);
  });

  // ── cancelConflictResolution ───────────────────────────────

  it('should close modal and show info toast', async () => {
    await service.openConflictModal({ projectId: 'p-1' } as ConflictData);

    service.cancelConflictResolution();

    expect(mockModalCloseRef.close).toHaveBeenCalledWith({ choice: 'cancel' });
    expect(mockSyncCoordinator.clearActiveConflict).toHaveBeenCalled();
    expect(mockToast.info).toHaveBeenCalled();
  });
});
