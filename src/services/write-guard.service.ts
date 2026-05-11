/**
 * WriteGuardService - 写入闸门
 *
 * 职责：判定当前部署是否处于「只读 / 导出」模式，统一 gate 所有云端写入入口。
 *
 * 触发只读的场景（任意一项命中）：
 * 1. `environment.readOnlyPreview === true` —— PR Preview 环境，禁止写主库；
 * 2. `environment.originGateMode === 'export-only'` —— 旧 Vercel origin 割接窗口；
 * 3. `environment.deploymentTarget === 'vercel-legacy'` —— 旧 Vercel export-only 构建；
 * 4. 运行时 sessionStorage 标志 `__NANOFLOW_WRITE_GUARD__=read-only` —— Origin Gate
 *    在 read-only 模式下注入的运行时降级。
 *
 * 计划依据：
 * - §3 / §12 阶段 0：旧 Vercel export-only / read-only 构建路径；
 * - §16.26：服务端写入保护与迁移 UX 客户端配合；
 * - §7.1 / §7.2：Canonical Origin Gate 的 read-only / export-only 语义。
 *
 * 【重要】本服务仅做客户端早返回；服务端 RPC（计划 §6.4 / §16.26）仍是
 * 真正的安全边界，旧 origin 即使绕过本闸门，服务端也会拒绝旧 protocol/version。
 */

import { Injectable, computed, inject, signal } from '@angular/core';
import { environment } from '../environments/environment';
import { LoggerService } from './logger.service';

export type WriteGuardMode = 'writable' | 'read-only' | 'export-only';

interface WriteGuardEnvironmentSlice {
  readOnlyPreview?: boolean;
  originGateMode?: 'off' | 'redirect' | 'read-only' | 'export-only';
  deploymentTarget?: string;
  canonicalOrigin?: string;
}

@Injectable({ providedIn: 'root' })
export class WriteGuardService {
  private static readonly RUNTIME_OVERRIDE_KEY = '__NANOFLOW_WRITE_GUARD__';
  private static readonly ORIGIN_GATE_FIRED_KEY = 'nanoflow.originGate.fired';
  private static readonly STALE_RUNTIME_OVERRIDE_TTL_MS = 10 * 60 * 1000;

  private readonly logger = inject(LoggerService).category('WriteGuard');

  /** 启动时静态判定的基线模式（来自 environment）。 */
  private readonly baselineMode = signal<WriteGuardMode>(this.computeBaselineMode());

  /** 运行时降级模式（例如 Origin Gate 在 redirect 失败后降到 read-only）。 */
  private readonly runtimeOverride = signal<WriteGuardMode | null>(this.readRuntimeOverride());

  /** 当前生效模式 = runtimeOverride ?? baselineMode（runtime 永远只能更严格）。 */
  readonly mode = computed<WriteGuardMode>(() => {
    const override = this.runtimeOverride();
    const baseline = this.baselineMode();
    return this.mostRestrictive(baseline, override);
  });

  /** 是否禁止云端写入。 */
  readonly isReadOnly = computed<boolean>(() => this.mode() !== 'writable');

  /** 是否禁止 UI 写操作（export-only 比 read-only 更严：连本地 IndexedDB 写都禁止）。 */
  readonly isExportOnly = computed<boolean>(() => this.mode() === 'export-only');

  /**
   * 在云端写入入口（RetryQueue.processQueue / ActionQueue.processQueue / RPC push）
   * 调用 `assertWritable()`，若返回 false 调用方必须早返回，不得绕过。
   *
   * 副作用：第一次拦截时记录 logger.info，避免日志洪水仅记一次/模式。
   */
  private warnedModes = new Set<WriteGuardMode>();
  assertWritable(callsite: string): boolean {
    const mode = this.mode();
    if (mode === 'writable') {
      return true;
    }
    if (!this.warnedModes.has(mode)) {
      this.warnedModes.add(mode);
      this.logger.info(`writeguard_block: ${callsite} 模式=${mode}（环境=${this.describeEnvironment()}）`);
    }
    return false;
  }

  /**
   * 运行时升级到更严格模式（仅允许 writable -> read-only -> export-only 单向）。
   * Origin Gate 在某些边界场景调用：例如检测到 Auth 拒绝 + 旧 Vercel origin。
   */
  escalateTo(mode: WriteGuardMode): void {
    const current = this.mode();
    const next = this.mostRestrictive(current, mode);
    if (next !== current) {
      this.runtimeOverride.set(next);
      this.persistRuntimeOverride(next);
      this.logger.info(`writeguard_escalate: ${current} -> ${next}`);
    }
  }

  // ---------------- internal ----------------

  private computeBaselineMode(): WriteGuardMode {
    const env = environment as unknown as WriteGuardEnvironmentSlice;
    if (env.originGateMode === 'export-only') return 'export-only';
    if (env.deploymentTarget === 'vercel-legacy') return 'export-only';
    if (env.originGateMode === 'read-only' || env.readOnlyPreview === true) return 'read-only';
    return 'writable';
  }

  private readRuntimeOverride(): WriteGuardMode | null {
    if (typeof sessionStorage === 'undefined') return null;
    try {
      const raw = sessionStorage.getItem(WriteGuardService.RUNTIME_OVERRIDE_KEY);
      if (raw === 'read-only' || raw === 'export-only') {
        if (this.shouldClearStaleRuntimeOverride(raw)) {
          this.clearRuntimeOverrideMarkers();
          this.logger.info(`writeguard_stale_override_cleared: ${raw}`);
          return null;
        }
        return raw;
      }
      return null;
    } catch {
      // sessionStorage 不可用（例如 third-party cookie 被禁、隐私模式），
      // 视为无 runtime override —— 不抛错，调用方会回到 baselineMode。
      // eslint-disable-next-line no-restricted-syntax
      return null;
    }
  }

  private persistRuntimeOverride(mode: WriteGuardMode): void {
    if (typeof sessionStorage === 'undefined') return;
    try {
      sessionStorage.setItem(WriteGuardService.RUNTIME_OVERRIDE_KEY, mode);
    } catch {
      // sessionStorage 不可用时忽略 —— mode signal 仍然生效。
    }
  }

  private shouldClearStaleRuntimeOverride(mode: WriteGuardMode): boolean {
    if (this.computeBaselineMode() !== 'writable') {
      return false;
    }

    const env = environment as unknown as WriteGuardEnvironmentSlice;
    if (
      typeof window !== 'undefined'
      && typeof env.canonicalOrigin === 'string'
      && env.canonicalOrigin.length > 0
      && window.location.origin !== env.canonicalOrigin
    ) {
      return false;
    }

    const firedAt = this.readOriginGateFiredAt();
    if (firedAt == null) {
      return false;
    }

    return Date.now() - firedAt > WriteGuardService.STALE_RUNTIME_OVERRIDE_TTL_MS;
  }

  private readOriginGateFiredAt(): number | null {
    if (typeof sessionStorage === 'undefined') {
      return null;
    }

    try {
      const raw = sessionStorage.getItem(WriteGuardService.ORIGIN_GATE_FIRED_KEY);
      if (!raw) {
        return null;
      }

      const parsed = JSON.parse(raw) as { ts?: unknown; mode?: unknown };
      if (parsed.mode !== 'read-only' && parsed.mode !== 'export-only' && parsed.mode !== 'redirect') {
        return null;
      }

      if (typeof parsed.ts !== 'string') {
        return null;
      }

      const parsedMs = Date.parse(parsed.ts);
      return Number.isFinite(parsedMs) ? parsedMs : null;
    } catch {
      return null;
    }
  }

  private clearRuntimeOverrideMarkers(): void {
    if (typeof sessionStorage === 'undefined') return;
    try {
      sessionStorage.removeItem(WriteGuardService.RUNTIME_OVERRIDE_KEY);
      sessionStorage.removeItem(WriteGuardService.ORIGIN_GATE_FIRED_KEY);
    } catch {
      // sessionStorage 不可用时忽略。
    }
  }

  private mostRestrictive(a: WriteGuardMode, b: WriteGuardMode | null | undefined): WriteGuardMode {
    const order: Record<WriteGuardMode, number> = {
      'writable': 0,
      'read-only': 1,
      'export-only': 2,
    };
    if (b == null) return a;
    return order[a] >= order[b] ? a : b;
  }

  private describeEnvironment(): string {
    const env = environment as unknown as WriteGuardEnvironmentSlice;
    return [
      `originGateMode=${env.originGateMode ?? 'off'}`,
      `deploymentTarget=${env.deploymentTarget ?? 'unknown'}`,
      `readOnlyPreview=${env.readOnlyPreview === true}`,
    ].join(',');
  }
}
