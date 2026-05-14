/**
 * ConnectivityRecoveryService - 网络连接恢复管理
 *
 * 职责：
 * - 监控 Supabase 连接状态变化
 * - 探测远端可达性
 * - 协调连接恢复流程（会话验证 + Transport 恢复）
 * - 管理恢复定时器与重试策略
 *
 * 从 SimpleSyncService 抽离（技术债务清理 2026-05-13）
 */

import { Injectable, inject, DestroyRef } from '@angular/core';
import { SupabaseClientService, type SupabaseConnectivityChange } from '../../../../services/supabase-client.service';
import { LoggerService } from '../../../../services/logger.service';
import { SYNC_CONFIG } from '../../../../config/sync.config';
import { FEATURE_FLAGS } from '../../../../config/feature-flags.config';
import { SessionManagerService } from './session-manager.service';
import { RealtimePollingService } from './realtime-polling.service';
import { RetryQueueService } from './retry-queue.service';
import { SyncStateService } from './sync-state.service';
import { BlackBoxSyncService } from '../../../../services/black-box-sync.service';
import {
  getRemainingBrowserNetworkResumeDelayMs,
  isBrowserNetworkSuspendedWindow,
} from '../../../../utils/browser-network-suspension';

@Injectable({ providedIn: 'root' })
export class ConnectivityRecoveryService {
  private readonly supabase = inject(SupabaseClientService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('ConnectivityRecovery');
  private readonly sessionManager = inject(SessionManagerService);
  private readonly realtimePollingService = inject(RealtimePollingService);
  private readonly retryQueueService = inject(RetryQueueService);
  private readonly syncStateService = inject(SyncStateService);
  private readonly blackBoxSync = inject(BlackBoxSyncService);
  private readonly destroyRef = inject(DestroyRef);

  private connectivityRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private connectivityRecoveryPromise: Promise<void> | null = null;
  private connectivityRecoveryEpoch = 0;
  private runtimeStarted = false;

  /**
   * 启动连接恢复运行时
   */
  startRuntime(): void {
    this.runtimeStarted = true;
    this.connectivityRecoveryEpoch++;
  }

  /**
   * 停止连接恢复运行时
   */
  stopRuntime(): void {
    this.runtimeStarted = false;
    this.connectivityRecoveryEpoch++;
    this.clearConnectivityRecoveryTimer();
    this.connectivityRecoveryPromise = null;
  }

  /**
   * 处理 Supabase 连接状态变化
   */
  handleSupabaseConnectivityChange(change: SupabaseConnectivityChange, syncStateIsOnline: boolean): void {
    this.syncStateService.setOfflineMode(change.offline);

    if (!this.runtimeStarted || change.source !== 'request') {
      return;
    }

    if (change.offline) {
      this.clearConnectivityRecoveryTimer();
      void this.realtimePollingService.suspendTransport();
      this.scheduleConnectivityRecovery('supabase-request-offline', SYNC_CONFIG.CONNECTIVITY_PROBE_INTERVAL);
      return;
    }

    if (!syncStateIsOnline) {
      return;
    }

    void this.restoreRemoteConnectivity('supabase-request-restored');
  }

  /**
   * 清除连接恢复定时器
   */
  private clearConnectivityRecoveryTimer(): void {
    if (!this.connectivityRecoveryTimer) {
      return;
    }

    clearTimeout(this.connectivityRecoveryTimer);
    this.connectivityRecoveryTimer = null;
  }

  cancelScheduledRecovery(): void {
    this.clearConnectivityRecoveryTimer();
  }

  /**
   * 探测远端可达性
   */
  async probeRemoteReachability(
    reason: string,
    timeoutMs: number = SYNC_CONFIG.CONNECTIVITY_PROBE_TIMEOUT,
    force = true
  ): Promise<boolean> {
    if (isBrowserNetworkSuspendedWindow()) {
      const delayMs = Math.max(100, getRemainingBrowserNetworkResumeDelayMs() + 50);
      this.logger.debug('浏览器网络仍处于挂起窗口，延后远端可达性探测', {
        reason,
        delayMs,
      });
      this.scheduleConnectivityRecovery(`${reason}:network-suspended`, delayMs);
      return false;
    }

    const reachable = await this.supabase.probeReachability({ timeoutMs, force });
    this.syncStateService.setOfflineMode(!reachable);

    if (!reachable) {
      this.logger.info('Supabase 远端暂不可达，保持连接中断模式', { reason });
      await this.realtimePollingService.suspendTransport();
      return false;
    }

    return true;
  }

  /**
   * 确保连接恢复会话就绪
   */
  private async ensureConnectivityRecoverySessionReady(reason: string): Promise<boolean> {
    const sessionSnapshot = FEATURE_FLAGS.RESUME_SESSION_SNAPSHOT_V1
      ? this.sessionManager.getRecentValidationSnapshot(10_000)
      : null;

    if (sessionSnapshot?.valid) {
      return true;
    }

    const session = await this.sessionManager.validateOrRefreshOnResume(`connectivity:${reason}`);

    if (session.deferred) {
      const delayMs = Math.max(100, getRemainingBrowserNetworkResumeDelayMs() + 50);
      this.scheduleConnectivityRecovery(`${reason}:session-deferred`, delayMs);
      this.logger.info('连接恢复等待会话稳定后重试', {
        reason,
        delayMs,
        deferredReason: session.reason ?? 'client-unready',
      });
      return false;
    }

    if (!session.ok) {
      this.logger.info('连接恢复因会话不可用而跳过', {
        reason,
        failureReason: session.reason,
      });
      return false;
    }

    return true;
  }

  /**
   * 调度连接恢复
   */
  scheduleConnectivityRecovery(reason: string, delayMs: number = SYNC_CONFIG.DEBOUNCE_DELAY): void {
    if (!this.runtimeStarted || this.connectivityRecoveryTimer) {
      return;
    }

    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
      this.logger.debug('页面仍处于后台，跳过连接恢复定时器，等待下一次可见恢复事件', {
        reason,
      });
      return;
    }

    this.connectivityRecoveryTimer = setTimeout(() => {
      this.connectivityRecoveryTimer = null;

      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        return;
      }

      void this.restoreRemoteConnectivity(`scheduled:${reason}`);
    }, delayMs);
  }

  /**
   * 恢复远端连接
   */
  async restoreRemoteConnectivity(reason: string): Promise<void> {
    if (this.connectivityRecoveryPromise) {
      return this.connectivityRecoveryPromise;
    }

    this.clearConnectivityRecoveryTimer();
    const recoveryEpoch = this.connectivityRecoveryEpoch;
    const recoveryPromise: Promise<void> = this.restoreRemoteConnectivityInternal(reason, recoveryEpoch)
      .finally(() => {
        if (this.connectivityRecoveryPromise === recoveryPromise) {
          this.connectivityRecoveryPromise = null;
        }
      });

    this.connectivityRecoveryPromise = recoveryPromise;

    return this.connectivityRecoveryPromise;
  }

  /**
   * 恢复远端连接内部实现
   */
  private async restoreRemoteConnectivityInternal(reason: string, recoveryEpoch: number): Promise<void> {
    let remoteProbeCompleted = false;

    if (this.supabase.isOfflineMode()) {
      const reachable = await this.probeRemoteReachability(reason, SYNC_CONFIG.CONNECTIVITY_PROBE_TIMEOUT, true);
      remoteProbeCompleted = true;
      if (!this.runtimeStarted || recoveryEpoch !== this.connectivityRecoveryEpoch) {
        return;
      }

      if (!reachable) {
        this.scheduleConnectivityRecovery(reason, SYNC_CONFIG.CONNECTIVITY_PROBE_INTERVAL);
        return;
      }
    }

    const sessionReady = await this.ensureConnectivityRecoverySessionReady(reason);
    if (!this.runtimeStarted || recoveryEpoch !== this.connectivityRecoveryEpoch) {
      return;
    }

    if (!sessionReady) {
      return;
    }

    if (!remoteProbeCompleted) {
      const reachable = await this.probeRemoteReachability(reason, SYNC_CONFIG.CONNECTIVITY_PROBE_TIMEOUT, true);
      if (!this.runtimeStarted || recoveryEpoch !== this.connectivityRecoveryEpoch) {
        return;
      }

      if (!reachable) {
        this.scheduleConnectivityRecovery(reason, SYNC_CONFIG.CONNECTIVITY_PROBE_INTERVAL);
        return;
      }
    }

    await this.realtimePollingService.resumeTransport();
    if (!this.runtimeStarted || recoveryEpoch !== this.connectivityRecoveryEpoch) {
      return;
    }

    this.realtimePollingService.resumeRealtimeUpdates();

    if (this.retryQueueService.length > 0) {
      this.retryQueueService.processQueue();
    }

    if (this.realtimePollingService.hasRemoteChangeCallback()) {
      void this.realtimePollingService.triggerRemoteChange({
        eventType: 'reconnect',
        projectId: this.realtimePollingService.getCurrentProjectId() ?? undefined,
      });
    }

    void this.blackBoxSync.pullChanges({ reason: 'resume' }).catch((error: unknown) => {
      this.logger.warn('远端连接恢复后黑匣子补拉失败', {
        reason,
        error,
      });
    });
  }
}
