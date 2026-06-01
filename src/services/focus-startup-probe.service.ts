import { Injectable, inject, signal } from '@angular/core';
import { AuthService } from './auth.service';
import { BlackBoxSyncService } from './black-box-sync.service';
import { GateService } from './gate.service';
import { LoggerService } from './logger.service';
import { FEATURE_FLAGS } from '../config/feature-flags.config';

type FocusProbeSource = 'startup' | 'resume-local' | 'resume-remote' | 'manual' | 'widget-open-workspace' | 'project-entry';

@Injectable({ providedIn: 'root' })
export class FocusStartupProbeService {
  private readonly auth = inject(AuthService);
  private readonly blackBoxSync = inject(BlackBoxSyncService);
  private readonly gateService = inject(GateService);
  private readonly logger = inject(LoggerService).category('FocusStartupProbe');

  private readonly probeDoneSignal = signal(false);
  private readonly pendingGateWorkSignal = signal(false);

  private probePromise: Promise<void> | null = null;
  private projectEntryProbePromise: Promise<void> | null = null;
  private initializedForUser: string | null = null;
  private widgetWorkspaceRemoteFirst = false;
  /** 【修复 P1-06】版本号递增，异步完成后对比确保不写入过期用户数据 */
  private probeVersion = 0;

  initialize(): void {
    void this.startProbe({ force: false, reloadLocal: true, source: 'startup' });
  }

  isProbeDone(): boolean {
    return this.probeDoneSignal();
  }

  hasPendingGateWork(): boolean {
    return this.pendingGateWorkSignal();
  }

  checkGateForProjectEntry(): void {
    if (!FEATURE_FLAGS.FOCUS_STARTUP_THROTTLED_CHECK_V1) {
      this.probeDoneSignal.set(true);
      this.pendingGateWorkSignal.set(false);
      return;
    }

    const hasProbeUser = this.resolveProbeUserId(true) !== null;

    if (!this.projectEntryProbePromise) {
      const projectEntryProbe = this.startProbe({
        force: true,
        reloadLocal: true,
        source: 'project-entry',
        localFirstWhileInFlight: true,
      }).finally(() => {
        if (this.projectEntryProbePromise === projectEntryProbe) {
          this.projectEntryProbePromise = null;
        }
      });
      this.projectEntryProbePromise = projectEntryProbe;
    }

    if (hasProbeUser) {
      this.applyGateSnapshot('project-entry', 'memory');
    }
  }

  async recheckGate(options: { reloadLocal?: boolean; source?: FocusProbeSource } = {}): Promise<void> {
    await this.startProbe({
      force: true,
      reloadLocal: options.reloadLocal ?? true,
      source: options.source ?? 'manual',
    });
  }

  primeWidgetWorkspaceGateSync(): void {
    this.widgetWorkspaceRemoteFirst = true;
  }

  private async startProbe(options: {
    force: boolean;
    reloadLocal: boolean;
    source: FocusProbeSource;
    localFirstWhileInFlight?: boolean;
  }): Promise<void> {
    if (!FEATURE_FLAGS.FOCUS_STARTUP_THROTTLED_CHECK_V1) {
      this.probeDoneSignal.set(true);
      this.pendingGateWorkSignal.set(false);
      return;
    }

    const userId = this.resolveProbeUserId(options.force);
    if (!userId) {
      this.initializedForUser = null;
      this.probeDoneSignal.set(false);
      this.pendingGateWorkSignal.set(false);
      return;
    }

    if (!options.force && this.initializedForUser === userId && (this.probeDoneSignal() || this.probePromise)) {
      return;
    }

    // 用户切换时标记之前正在运行的探测为已中止
    if (this.initializedForUser !== null && this.initializedForUser !== userId && this.probePromise) {
      this.probeVersion++;
      this.probePromise = null;
    }

    this.initializedForUser = userId;
    this.probeDoneSignal.set(false);
    this.pendingGateWorkSignal.set(false);

    if (this.probePromise) {
      if (options.force && options.reloadLocal && options.localFirstWhileInFlight) {
        await this.applyLocalGateSnapshotDuringInFlight(userId, options.source);
      }

      await this.probePromise;
      if (!options.force) {
        return;
      }

      if (this.initializedForUser !== userId) {
        return;
      }
    }

    const remoteFirst = this.widgetWorkspaceRemoteFirst;
    this.widgetWorkspaceRemoteFirst = false;
    const capturedVersion = ++this.probeVersion;
    this.probePromise = this.runProbe(capturedVersion, userId, {
      ...options,
      reloadLocal: remoteFirst ? false : options.reloadLocal,
      source: remoteFirst ? 'widget-open-workspace' : options.source,
    }).finally(() => {
      this.probePromise = null;
    });

    await this.probePromise;
  }

  private resolveProbeUserId(force: boolean): string | null {
    return this.auth.currentUserId() ?? (force
      ? this.auth.peekPersistedSessionIdentity?.()?.userId
        ?? this.auth.peekPersistedOwnerHint?.()
        ?? this.initializedForUser
      : null);
  }

  private async applyLocalGateSnapshotDuringInFlight(userId: string, source: FocusProbeSource): Promise<void> {
    try {
      await this.blackBoxSync.loadFromLocal();

      if (this.resolveProbeUserId(true) !== userId) {
        this.logger.debug('项目入口本地 gate 快照已过期，忽略本次结果');
        return;
      }

      this.applyGateSnapshot(source, 'local');
    } catch (error) {
      this.logger.warn('项目入口本地 gate 快照加载失败，等待常规探针继续', {
        source,
        error,
      });
    }
  }

  private async runProbe(
    version: number,
    userId: string,
    options: { reloadLocal: boolean; source: FocusProbeSource }
  ): Promise<void> {
    let hasLocalGateSnapshot = false;

    try {
      if (options.reloadLocal) {
        await this.blackBoxSync.loadFromLocal();
      }

      // 【修复 P1-06】探测期间用户已切换，版本号不匹配则放弃本次结果
      if (version !== this.probeVersion) {
        this.logger.debug('探测被中止（用户已切换，版本号不匹配）');
        return;
      }

      if (options.reloadLocal) {
        this.applyGateSnapshot(options.source, 'local');
        hasLocalGateSnapshot = true;
      }

      await this.blackBoxSync.pullChanges({
        reason: 'gate-review',
        force: true,
        expectedUserId: userId,
      });

      if (version !== this.probeVersion) {
        this.logger.debug('远端 gate 复核结果已过期，忽略本次结果');
        return;
      }

      this.applyGateSnapshot(options.source, 'remote');
    } catch (error) {
      this.logger.warn('Focus 大门探针失败', {
        source: options.source,
        reloadLocal: options.reloadLocal,
        hasLocalGateSnapshot,
        error,
      });
      if (!hasLocalGateSnapshot) {
        this.pendingGateWorkSignal.set(false);
      }
    } finally {
      this.probeDoneSignal.set(true);
    }
  }

  private applyGateSnapshot(source: FocusProbeSource, phase: 'memory' | 'local' | 'remote'): void {
    this.gateService.checkGate({
      ignoreHandledToday: source === 'widget-open-workspace',
    });
    this.pendingGateWorkSignal.set(this.gateService.state() === 'reviewing');

    this.logger.debug('Focus 大门探针完成', {
      source,
      phase,
      pendingGateWork: this.pendingGateWorkSignal(),
    });
  }
}
