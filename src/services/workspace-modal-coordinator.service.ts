/**
 * WorkspaceModalCoordinatorService
 *
 * Extracted from WorkspaceShellComponent to centralise all imperative
 * modal-open / close / conflict-resolution logic into a standalone,
 * root-provided service.
 *
 * The component keeps thin public delegation methods so that template
 * bindings continue to work unchanged.
 */
import { Injectable, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { ToastService } from './toast.service';
import { GlobalErrorHandler } from './global-error-handler.service';
import { type ConflictData } from './modal.service';
import { DynamicModalService, type ModalRef } from './dynamic-modal.service';
/* eslint-disable no-restricted-imports */
import { ModalLoaderService } from '../app/core/services/modal-loader.service';
import { ProjectStateService } from './project-state.service';
import { ProjectOperationService } from './project-operation.service';
import { SyncCoordinatorService } from './sync-coordinator.service';
import { AppAuthCoordinatorService } from '../app/core/services/app-auth-coordinator.service';
import { type ConflictResolutionPlan } from './conflict-resolution.types';
/* eslint-enable no-restricted-imports */
import type { StorageEscapeData } from '../app/shared/modals';
import { ThemeType, Project } from '../models';

type ConflictResolutionAction = 'local' | 'remote' | 'merge' | 'plan';

@Injectable({ providedIn: 'root' })
export class WorkspaceModalCoordinatorService {
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);
  private readonly errorHandler = inject(GlobalErrorHandler);
  private readonly dynamicModal = inject(DynamicModalService);
  private readonly modalLoader = inject(ModalLoaderService);
  private readonly projectState = inject(ProjectStateService);
  private readonly projectOps = inject(ProjectOperationService);
  private readonly syncCoordinator = inject(SyncCoordinatorService);
  private readonly authCoord = inject(AppAuthCoordinatorService);

  // ── State ───────────────────────────────────────────────────────────

  /** Per-modal-type loading flag (provides per-button spinner feedback) */
  readonly modalLoading = signal<Record<string, boolean>>({});

  /** Storage-escape payload for the storage-escape modal */
  readonly storageEscapeData = signal<StorageEscapeData | null>(null);
  readonly showStorageEscapeModal = signal(false);

  /** Login modal ref (needed to update inputs after auth attempts) */
  private _loginModalRef: ModalRef | null = null;
  /** Return URL saved before ModalService state is cleared */
  private _loginReturnUrl: string | null = null;

  /** Pending conflict data kept while the conflict modal is open */
  private _pendingConflict: ConflictData | null = null;
  // M-14: 防止并发冲突解决操作
  private _isResolvingConflict = false;
  /** Dashboard modal ref */
  private _dashboardModalRef: ModalRef | null = null;
  /** Conflict modal ref */
  private _conflictModalRef: ModalRef | null = null;

  // ── Callbacks ──────────────────────────────────────────────────────
  // These are set by the component via `initCallbacks` so the service
  // can call back into component-level methods that are not injectable
  // (e.g. signOut, handleImportComplete, confirmCreateProject, etc.).

  private _callbacks: ModalCallbacks = {};

  /** One-time initialisation called by the host component */
  initCallbacks(callbacks: ModalCallbacks): void {
    this._callbacks = callbacks;
  }

  /** 清除回调引用，避免宿主组件销毁后持有过期引用 */
  clearCallbacks(): void {
    this._callbacks = {};
  }

  // ── Helpers ────────────────────────────────────────────────────────

  /** 预加载常用模态框组件（委托 ModalLoaderService） */
  preloadCommonModals(): void {
    this.modalLoader.preloadCommonModals();
  }

  isModalLoading(type: string): boolean {
    return this.modalLoading()[type] ?? false;
  }

  private setModalLoading(type: string, loading: boolean): void {
    this.modalLoading.update(state => ({ ...state, [type]: loading }));
  }

  // ── Login modal ref accessors (used by handleLogin/Signup/Reset) ──

  get loginModalRef(): ModalRef | null {
    return this._loginModalRef;
  }

  get loginReturnUrl(): string | null {
    return this._loginReturnUrl;
  }

  set loginReturnUrl(url: string | null) {
    this._loginReturnUrl = url;
  }

  // ── Settings ───────────────────────────────────────────────────────

  async openSettings(): Promise<void> {
    if (this.isModalLoading('settings')) return;
    this.setModalLoading('settings', true);
    try {
      const component = await this.modalLoader.loadSettingsModal();
      this.dynamicModal.open(component, {
        inputs: {
          sessionEmail: this.authCoord.sessionEmail(),
          projects: this.projectState.projects()
        },
        outputs: {
          close: () => this.closeSettings(),
          signOut: () => this._callbacks.signOut?.(),
          themeChange: (theme: unknown) => this._callbacks.updateTheme?.(theme as ThemeType),
          openDashboard: () => this.openDashboardFromSettings(),
          importComplete: (project: unknown) => this._callbacks.handleImportComplete?.(project as Project)
        }
      });
    } catch {
      this.toast.error('设置面板加载失败', '请检查网络连接后重试');
    } finally {
      this.setModalLoading('settings', false);
    }
  }

  closeSettings(): void {
    this.dynamicModal.close();
    this.authCoord.isReloginMode.set(false);
  }

  // ── Dashboard ──────────────────────────────────────────────────────

  async openDashboardFromSettings(): Promise<void> {
    this.dynamicModal.close(); // close settings first
    await this.openDashboard();
  }

  async openDashboard(): Promise<void> {
    if (this.isModalLoading('dashboard') || this._dashboardModalRef) return;
    this.setModalLoading('dashboard', true);
    try {
      const component = await this.modalLoader.loadDashboardModal();
      const modalRef = this.dynamicModal.open(component, {
        outputs: {
          close: () => {
            this._dashboardModalRef = null;
            this.dynamicModal.close();
          },
          openConflictCenter: () => this.openConflictCenterFromDashboard()
        }
      });
      this._dashboardModalRef = modalRef;
      void modalRef.result.finally(() => {
        if (this._dashboardModalRef === modalRef) {
          this._dashboardModalRef = null;
        }
      });
    } catch {
      this.toast.error('仪表盘加载失败', '请检查网络连接后重试');
    } finally {
      this.setModalLoading('dashboard', false);
    }
  }

  openConflictCenterFromDashboard(): void {
    this.dynamicModal.close();
    this.toast.info('冲突解决中心', '请从项目列表中选择有冲突的项目进行处理');
  }

  // ── Login ──────────────────────────────────────────────────────────

  async openLoginModal(): Promise<void> {
    if (this.isModalLoading('login')) return;
    this.setModalLoading('login', true);
    try {
      const component = await this.modalLoader.loadLoginModal();
      this._loginModalRef = this.dynamicModal.open(component, {
        inputs: {
          authError: this.authCoord.authError(),
          isLoading: this.authCoord.isAuthLoading(),
          resetPasswordSent: this.authCoord.resetPasswordSent()
        },
        outputs: {
          close: () => {
            this._loginModalRef = null;
            this._loginReturnUrl = null;
          },
          login: (data: unknown) => this._callbacks.handleLoginFromModal?.(data as { email: string; password: string }),
          signup: (data: unknown) => this._callbacks.handleSignupFromModal?.(data as { email: string; password: string; confirmPassword: string }),
          resetPassword: (email: unknown) => this._callbacks.handleResetPasswordFromModal?.(email as string),
          localMode: () => this._callbacks.handleLocalModeFromModal?.()
        },
        closeOnBackdropClick: false,
        closeOnEscape: false
      });
    } catch {
      this.toast.error('登录组件加载失败', '请检查网络连接后重试');
    } finally {
      this.setModalLoading('login', false);
    }
  }

  closeLoginModal(): void {
    if (this._loginModalRef) {
      this._loginModalRef.close();
      this._loginModalRef = null;
    }
    this._loginReturnUrl = null;
  }

  navigateAfterLogin(): void {
    const returnUrl = this._loginReturnUrl;
    this._loginReturnUrl = null;
    if (returnUrl && returnUrl !== '/') {
      void this.router.navigateByUrl(returnUrl);
    }
  }

  // ── Trash ──────────────────────────────────────────────────────────

  async openTrashModal(): Promise<void> {
    if (this.isModalLoading('trash')) return;
    this.setModalLoading('trash', true);
    try {
      const component = await this.modalLoader.loadTrashModal();
      this.dynamicModal.open(component, {
        inputs: { show: true },
        outputs: {
          close: () => this.dynamicModal.close()
        }
      });
    } catch {
      this.toast.error('回收站加载失败', '请检查网络连接后重试');
    } finally {
      this.setModalLoading('trash', false);
    }
  }

  // ── Config help ────────────────────────────────────────────────────

  async openConfigHelpModal(): Promise<void> {
    if (this.isModalLoading('configHelp')) return;
    this.setModalLoading('configHelp', true);
    try {
      const component = await this.modalLoader.loadConfigHelpModal();
      this.dynamicModal.open(component, {
        outputs: {
          close: () => this.dynamicModal.close()
        }
      });
    } catch {
      this.toast.error('配置帮助加载失败', '请检查网络连接后重试');
    } finally {
      this.setModalLoading('configHelp', false);
    }
  }

  // ── New project ────────────────────────────────────────────────────

  async openNewProjectModal(): Promise<void> {
    if (this.isModalLoading('newProject')) return;
    this.setModalLoading('newProject', true);
    try {
      const component = await this.modalLoader.loadNewProjectModal();
      this.dynamicModal.open(component, {
        outputs: {
          close: () => this.dynamicModal.close(),
          confirm: (data: unknown) => {
            const { name, description } = data as { name: string; description: string };
            this.dynamicModal.close();
            this._callbacks.confirmCreateProject?.(name, description);
          }
        }
      });
    } catch {
      this.toast.error('新建项目组件加载失败', '请检查网络连接后重试');
    } finally {
      this.setModalLoading('newProject', false);
    }
  }

  // ── Migration ──────────────────────────────────────────────────────

  async openMigrationModal(): Promise<void> {
    if (this.isModalLoading('migration')) return;
    this.setModalLoading('migration', true);
    try {
      const component = await this.modalLoader.loadMigrationModal();
      this.dynamicModal.open(component, {
        outputs: {
          close: () => { this.dynamicModal.close(); this._callbacks.closeMigrationModal?.(); },
          migrated: () => { this.dynamicModal.close(); this._callbacks.handleMigrationComplete?.(); }
        },
        closeOnBackdropClick: false,
        closeOnEscape: false
      });
    } catch {
      this.toast.error('迁移组件加载失败', '请检查网络连接后重试');
    } finally {
      this.setModalLoading('migration', false);
    }
  }

  // ── Error recovery ─────────────────────────────────────────────────

  async openErrorRecoveryModal(error: {
    title: string;
    message: string;
    details?: string;
    options: unknown[];
    defaultOptionId?: string;
    autoSelectIn?: number | null;
    resolve: (result: { optionId: string }) => void;
  }): Promise<void> {
    try {
      const component = await this.modalLoader.loadErrorRecoveryModal();
      this.dynamicModal.open(component, {
        inputs: {
          title: error.title,
          message: error.message,
          details: error.details,
          options: error.options,
          defaultOptionId: error.defaultOptionId,
          autoSelectIn: error.autoSelectIn ?? null
        },
        outputs: {
          select: (event: unknown) => {
            error.resolve(event as { optionId: string });
            this.dynamicModal.close();
          },
          close: () => {
            this.errorHandler.dismissRecoveryDialog();
            this.dynamicModal.close();
          }
        },
        closeOnBackdropClick: false,
        closeOnEscape: false
      });
    } catch {
      this.toast.error('错误恢复组件加载失败', '请刷新页面重试');
      this.errorHandler.dismissRecoveryDialog();
    }
  }

  // ── Storage escape ─────────────────────────────────────────────────

  async openStorageEscapeModalImperative(): Promise<void> {
    const data = this.storageEscapeData();
    if (!data) return;
    try {
      const component = await this.modalLoader.loadStorageEscapeModal();
      this.dynamicModal.open(component, {
        inputs: {
          show: true,
          data: data
        },
        outputs: {
          close: () => {
            this.closeStorageEscapeModal();
            this.dynamicModal.close();
          }
        },
        closeOnBackdropClick: false,
        closeOnEscape: false
      });
    } catch {
      this.toast.error('存储逃生组件加载失败', '请刷新页面重试');
    }
  }

  closeStorageEscapeModal(): void {
    this.showStorageEscapeModal.set(false);
  }

  // ── Conflict ───────────────────────────────────────────────────────

  async openConflictModal(data: ConflictData): Promise<void> {
    try {
      const component = await this.modalLoader.loadConflictModal();
      this._conflictModalRef = this.dynamicModal.open(component, {
        inputs: {
          conflictData: data,
          isResolving: false,
          activeResolution: null,
        },
        outputs: {
          resolveLocal: () => this.resolveConflictLocal(),
          resolveRemote: () => this.resolveConflictRemote(),
          resolveMerge: () => this.resolveConflictMerge(),
          applyPlan: (plan: unknown) => this.applyConflictResolutionPlan(plan as ConflictResolutionPlan),
          cancel: () => this.cancelConflictResolution()
        },
        closeOnBackdropClick: false,
        closeOnEscape: false
      });
    } catch {
      this.toast.error('冲突解决组件加载失败', '请刷新页面重试');
    }
  }

  setPendingConflict(data: ConflictData): void {
    this._pendingConflict = data;
  }

  private setConflictModalResolutionState(
    isResolving: boolean,
    activeResolution: ConflictResolutionAction | null,
  ): void {
    this._conflictModalRef?.componentRef.setInput('isResolving', isResolving);
    this._conflictModalRef?.componentRef.setInput('activeResolution', activeResolution);
  }

  private notifyConflictResolutionSuccess(action: ConflictResolutionAction): void {
    switch (action) {
      case 'local':
        this.toast.success('已保留本地修改', '冲突已在本地解决，后台会自动同步到云端');
        return;
      case 'remote':
        this.toast.success('已采用云端版本', '当前项目已切换到云端结果');
        return;
      case 'merge':
        this.toast.success('已合并两边修改', '冲突已在本地解决，后台会自动同步到云端');
        return;
      case 'plan':
        this.toast.success('已按系统建议解决冲突', '冲突已在本地解决，后台会自动同步到云端');
        return;
    }
  }

  private async resolveConflictWith(strategy: 'local' | 'remote' | 'merge'): Promise<void> {
    if (this._isResolvingConflict) return;
    this._isResolvingConflict = true;
    this.setConflictModalResolutionState(true, strategy);
    try {
      const data = this._pendingConflict;
      let resolved = true;
      if (data) {
        resolved = await this.projectOps.resolveConflict(data.projectId, strategy, { backgroundPersist: true });
      }
      if (!resolved) {
        return;
      }
      this._conflictModalRef?.close({ choice: strategy });
      this._pendingConflict = null;
      this._conflictModalRef = null;
      this.notifyConflictResolutionSuccess(strategy);
    } finally {
      this.setConflictModalResolutionState(false, null);
      this._isResolvingConflict = false;
    }
  }

  async resolveConflictLocal(): Promise<void> {
    return this.resolveConflictWith('local');
  }

  async resolveConflictRemote(): Promise<void> {
    return this.resolveConflictWith('remote');
  }

  async resolveConflictMerge(): Promise<void> {
    return this.resolveConflictWith('merge');
  }

  async applyConflictResolutionPlan(plan: ConflictResolutionPlan): Promise<void> {
    if (this._isResolvingConflict) return;
    this._isResolvingConflict = true;
    this.setConflictModalResolutionState(true, 'plan');
    try {
      const data = this._pendingConflict;
      let resolved = true;
      if (data) {
        resolved = await this.projectOps.resolveConflictWithPlan(data.projectId, plan, { backgroundPersist: true });
      }
      if (!resolved) {
        return;
      }
      this._conflictModalRef?.close({ choice: 'merge' });
      this._pendingConflict = null;
      this._conflictModalRef = null;
      this.notifyConflictResolutionSuccess('plan');
    } finally {
      this.setConflictModalResolutionState(false, null);
      this._isResolvingConflict = false;
    }
  }

  cancelConflictResolution(): void {
    if (this._isResolvingConflict) {
      return;
    }
    this._conflictModalRef?.close({ choice: 'cancel' });
    this._pendingConflict = null;
    this._conflictModalRef = null;
    this.syncCoordinator.clearActiveConflict();
    this.toast.info('冲突待解决，下次同步时会再次提示');
  }
}

// ── Callback shape ──────────────────────────────────────────────────

/**
 * Callbacks the host component passes into the service so the modal
 * methods can invoke component-level behaviour without creating a
 * circular dependency.
 */
export interface ModalCallbacks {
  signOut?: () => void;
  updateTheme?: (theme: ThemeType) => void;
  handleImportComplete?: (project: Project) => void;
  handleLoginFromModal?: (data: { email: string; password: string }) => void;
  handleSignupFromModal?: (data: { email: string; password: string; confirmPassword: string }) => void;
  handleResetPasswordFromModal?: (email: string) => void;
  handleLocalModeFromModal?: () => void;
  confirmCreateProject?: (name: string, description: string) => void;
  handleMigrationComplete?: () => void;
  closeMigrationModal?: () => void;
}
