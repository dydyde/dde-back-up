/**
 * 强制清理缓存的核心实现（与 `main.ts` 解耦，便于单元测试）
 *
 * 设计要点（修复 2026-05-15 "检查到新版本" 提示点击无反应的根因）：
 *
 * 1. **`isClearing` 是「正在进行中」而不是「曾经调用过」**：
 *    入口若 `isClearing===true` 直接 return（防止并发重入），但 `finally`
 *    无条件复位，并通过 `setTimeout(reset, 5000)` 兜底，避免极端 hang 场景
 *    下永久卡死，从而保证用户第二次点击「立即刷新」仍能起作用。
 *
 * 2. **cache/SW 清理各自带超时**：
 *    `caches.delete` / `serviceWorker.unregister` 在某些浏览器（iOS Safari、
 *    Storage 受损）下可能 hang。我们用 `Promise.race` 设置上限（默认
 *    `TIMEOUT_CONFIG.STANDARD = 10s`），超时即跳过该步骤进入最终导航 ——
 *    "优先恢复 UI 可用"。
 *
 * 3. **导航三重兜底**：
 *    `location.replace` → 1500ms 内未发生 unload → `location.reload()` →
 *    再失败 → `location.href = origin + '/'`。任一层都能让用户脱离旧 bundle。
 */

import { TIMEOUT_CONFIG } from '../config/timeout.config';

/** 单次 cache/SW 清理步骤的默认超时（毫秒） */
export const FORCE_CLEAR_STEP_TIMEOUT_MS = TIMEOUT_CONFIG.STANDARD;

/** `isClearing` 闸门的最大持有时间，超过即自动释放（毫秒） */
export const FORCE_CLEAR_GATE_RELEASE_MS = 5000;

/** `location.replace` 后等待 unload 的兜底窗口（毫秒） */
export const FORCE_CLEAR_UNLOAD_FALLBACK_MS = 1500;

/**
 * 强制清理缓存所需的外部依赖。
 * 抽出为接口，方便测试时注入 mock。
 */
export interface ForceClearCacheDeps {
  /** 清理本地恢复存储（localStorage 标记等） */
  clearRecoveryStorage(): void;
  /** 清理 caches.* 缓存（按需可挂超时） */
  clearApplicationCaches(): Promise<void>;
  /** 注销所有 service worker */
  unregisterApplicationServiceWorkers(): Promise<void>;
  /** 设置 force-clear 标记 */
  setForceClearFlag(): void;
  /** 清除 force-clear 标记 */
  clearForceClearFlag(): void;
  /** 触发导航：location.replace(href) */
  replaceLocation(href: string): void;
  /** 触发兜底导航：location.reload() */
  reloadLocation(): void;
  /** 最终兜底：location.href = href */
  assignHref(href: string): void;
  /** 当前 URL（用于 replaceLocation 参数） */
  getCurrentHref(): string;
  /** 当前 origin + '/'（最终兜底用） */
  getOriginRoot(): string;
  /** 诊断日志（info 级） */
  logInfo?(message: string, extra?: Record<string, unknown>): void;
  /** 诊断日志（error 级） */
  logError?(message: string, err?: unknown): void;
  /** 单步超时（毫秒），默认 FORCE_CLEAR_STEP_TIMEOUT_MS */
  stepTimeoutMs?: number;
  /** 闸门释放超时（毫秒），默认 FORCE_CLEAR_GATE_RELEASE_MS */
  gateReleaseMs?: number;
  /** 导航兜底窗口（毫秒），默认 FORCE_CLEAR_UNLOAD_FALLBACK_MS */
  unloadFallbackMs?: number;
}

/**
 * 模块级闸门：标记当前是否有强制清理在进行中。
 *
 * - 设计为「正在进行中」语义而非「曾经调用过」。
 * - `finally` 块无条件复位，避免极端 hang 永久锁死。
 * - 同时附带 5s `setTimeout` 兜底（详见 `gateReleaseMs`），以防 finally
 *   之前的同步异常路径绕过复位。
 */
let isClearing = false;

/** 测试辅助：重置闸门状态（仅用于 spec） */
export function __resetForceClearGateForTests(): void {
  isClearing = false;
}

/** 测试辅助：检查闸门当前状态 */
export function __isForceClearInProgressForTests(): boolean {
  return isClearing;
}

/**
 * 用 `Promise.race` 给单步加超时。超时时 resolve 为 `'timeout'`，
 * 上层据此跳过该步骤继续后续逻辑（不抛错，不阻塞导航）。
 *
 * @param stepName 用于日志消息的步骤名（仅用作诊断 breadcrumb 的标识，
 *                 例如 `'clearApplicationCaches'`/`'unregisterApplicationServiceWorkers'`）。
 */
async function withTimeout(
  promise: Promise<void>,
  timeoutMs: number,
  stepName: string,
  logInfo?: (message: string, extra?: Record<string, unknown>) => void
): Promise<'ok' | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race<'ok' | 'timeout'>([
      promise.then(() => 'ok' as const),
      new Promise<'timeout'>(resolve => {
        timer = setTimeout(() => {
          logInfo?.('force-clear-cache:step-timeout', { step: stepName, timeoutMs });
          resolve('timeout');
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * 包装一个同步步骤，吞掉异常并记录日志。
 */
function runSafeSync(
  fn: () => void,
  errorTag: string,
  logError?: (message: string, err?: unknown) => void
): void {
  try {
    fn();
  } catch (e) {
    logError?.(errorTag, e);
  }
}

/**
 * 包装一个异步步骤：吞掉异常 + 加超时。超时与异常均不阻塞后续逻辑。
 */
async function runSafeAsync(
  fn: () => Promise<void>,
  errorTag: string,
  timeoutTag: string,
  stepName: string,
  timeoutMs: number,
  logInfo?: (message: string, extra?: Record<string, unknown>) => void,
  logError?: (message: string, err?: unknown) => void
): Promise<void> {
  try {
    const result = await withTimeout(fn(), timeoutMs, stepName, logInfo);
    if (result === 'timeout') {
      logError?.(timeoutTag);
    }
  } catch (e) {
    logError?.(errorTag, e);
  }
}

/**
 * 触发主导航 + 三重兜底（replaceLocation → reloadLocation → assignHref）。
 */
function performNavigation(
  deps: ForceClearCacheDeps,
  unloadFallbackMs: number
): void {
  deps.logInfo?.('force-clear-cache:replace-location');
  try {
    deps.replaceLocation(deps.getCurrentHref());
  } catch (e) {
    deps.logError?.('force-clear-cache:replace-failed', e);
  }

  setTimeout(() => {
    deps.logInfo?.('force-clear-cache:fallback-reload');
    try {
      deps.reloadLocation();
    } catch (e) {
      deps.logError?.('force-clear-cache:reload-failed', e);
      try {
        deps.assignHref(deps.getOriginRoot());
      } catch (assignErr) {
        deps.logError?.('force-clear-cache:assign-href-failed', assignErr);
      }
    }
  }, unloadFallbackMs);
}

/**
 * 执行强制清理缓存并刷新页面的完整流程。
 *
 * @returns 解析为 `'ok' | 'reentry' | 'failed'`：
 *  - `'ok'`：流程已完成，导航已触发；
 *  - `'reentry'`：闸门已被占用，本次调用被忽略；
 *  - `'failed'`：流程异常，已尝试导航兜底。
 */
export async function forceClearCacheImpl(
  deps: ForceClearCacheDeps
): Promise<'ok' | 'reentry' | 'failed'> {
  if (isClearing) {
    deps.logInfo?.('force-clear-cache:reentry-ignored');
    return 'reentry';
  }
  isClearing = true;

  const stepTimeoutMs = deps.stepTimeoutMs ?? FORCE_CLEAR_STEP_TIMEOUT_MS;
  const gateReleaseMs = deps.gateReleaseMs ?? FORCE_CLEAR_GATE_RELEASE_MS;
  const unloadFallbackMs = deps.unloadFallbackMs ?? FORCE_CLEAR_UNLOAD_FALLBACK_MS;

  // 兜底释放闸门：极端情况下 finally 未执行也能恢复。
  const gateReleaseTimer = setTimeout(() => {
    isClearing = false;
  }, gateReleaseMs);

  try {
    deps.logInfo?.('force-clear-cache:invoke');

    runSafeSync(() => deps.setForceClearFlag(), 'force-clear-cache:set-flag-failed', deps.logError);
    runSafeSync(() => deps.clearRecoveryStorage(), 'force-clear-cache:clear-recovery-storage-failed', deps.logError);

    await runSafeAsync(
      () => deps.clearApplicationCaches(),
      'force-clear-cache:clear-caches-failed',
      'force-clear-cache:clear-caches-timeout',
      'clearApplicationCaches',
      stepTimeoutMs,
      deps.logInfo,
      deps.logError
    );
    await runSafeAsync(
      () => deps.unregisterApplicationServiceWorkers(),
      'force-clear-cache:unregister-sw-failed',
      'force-clear-cache:unregister-sw-timeout',
      'unregisterApplicationServiceWorkers',
      stepTimeoutMs,
      deps.logInfo,
      deps.logError
    );

    // 清理结束才能移除 force-clear-flag，否则下次启动会再次触发恢复刷新。
    runSafeSync(() => deps.clearForceClearFlag(), 'force-clear-cache:clear-flag-failed', deps.logError);

    performNavigation(deps, unloadFallbackMs);

    return 'ok';
  } catch (e) {
    deps.logError?.('force-clear-cache:unexpected-failure', e);
    try {
      deps.reloadLocation();
    } catch (reloadErr) {
      deps.logError?.('force-clear-cache:final-reload-failed', reloadErr);
    }
    return 'failed';
  } finally {
    clearTimeout(gateReleaseTimer);
    isClearing = false;
  }
}
