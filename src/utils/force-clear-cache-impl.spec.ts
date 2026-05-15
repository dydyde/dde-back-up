import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FORCE_CLEAR_GATE_RELEASE_MS,
  FORCE_CLEAR_STEP_TIMEOUT_MS,
  FORCE_CLEAR_UNLOAD_FALLBACK_MS,
  __isForceClearInProgressForTests,
  __resetForceClearGateForTests,
  forceClearCacheImpl,
  type ForceClearCacheDeps,
} from './force-clear-cache-impl';

function buildDeps(overrides: Partial<ForceClearCacheDeps> = {}): {
  deps: ForceClearCacheDeps;
  calls: {
    clearRecoveryStorage: ReturnType<typeof vi.fn>;
    clearApplicationCaches: ReturnType<typeof vi.fn>;
    unregisterApplicationServiceWorkers: ReturnType<typeof vi.fn>;
    setForceClearFlag: ReturnType<typeof vi.fn>;
    clearForceClearFlag: ReturnType<typeof vi.fn>;
    replaceLocation: ReturnType<typeof vi.fn>;
    reloadLocation: ReturnType<typeof vi.fn>;
    assignHref: ReturnType<typeof vi.fn>;
    logInfo: ReturnType<typeof vi.fn>;
    logError: ReturnType<typeof vi.fn>;
  };
} {
  const calls = {
    clearRecoveryStorage: vi.fn(),
    clearApplicationCaches: vi.fn().mockResolvedValue(undefined),
    unregisterApplicationServiceWorkers: vi.fn().mockResolvedValue(undefined),
    setForceClearFlag: vi.fn(),
    clearForceClearFlag: vi.fn(),
    replaceLocation: vi.fn(),
    reloadLocation: vi.fn(),
    assignHref: vi.fn(),
    logInfo: vi.fn(),
    logError: vi.fn(),
  };

  const deps: ForceClearCacheDeps = {
    clearRecoveryStorage: calls.clearRecoveryStorage,
    clearApplicationCaches: calls.clearApplicationCaches,
    unregisterApplicationServiceWorkers: calls.unregisterApplicationServiceWorkers,
    setForceClearFlag: calls.setForceClearFlag,
    clearForceClearFlag: calls.clearForceClearFlag,
    replaceLocation: calls.replaceLocation,
    reloadLocation: calls.reloadLocation,
    assignHref: calls.assignHref,
    getCurrentHref: () => 'https://example.test/app',
    getOriginRoot: () => 'https://example.test/',
    logInfo: calls.logInfo,
    logError: calls.logError,
    ...overrides,
  };

  return { deps, calls };
}

describe('forceClearCacheImpl', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetForceClearGateForTests();
  });

  afterEach(() => {
    __resetForceClearGateForTests();
    vi.useRealTimers();
  });

  it('runs full pipeline and calls replaceLocation with current href', async () => {
    const { deps, calls } = buildDeps();

    const result = await forceClearCacheImpl(deps);

    expect(result).toBe('ok');
    expect(calls.setForceClearFlag).toHaveBeenCalledTimes(1);
    expect(calls.clearRecoveryStorage).toHaveBeenCalledTimes(1);
    expect(calls.clearApplicationCaches).toHaveBeenCalledTimes(1);
    expect(calls.unregisterApplicationServiceWorkers).toHaveBeenCalledTimes(1);
    expect(calls.clearForceClearFlag).toHaveBeenCalledTimes(1);
    expect(calls.replaceLocation).toHaveBeenCalledWith('https://example.test/app');
  });

  it('releases isClearing gate after completion so a retry can run', async () => {
    const { deps, calls } = buildDeps();

    await forceClearCacheImpl(deps);
    expect(__isForceClearInProgressForTests()).toBe(false);

    // Second call must NOT be silently ignored.
    const second = await forceClearCacheImpl(deps);
    expect(second).toBe('ok');
    expect(calls.replaceLocation).toHaveBeenCalledTimes(2);
  });

  it('returns "reentry" while a previous call is in-flight', async () => {
    let resolveCaches: (() => void) | null = null;
    const pendingCaches = new Promise<void>(resolve => {
      resolveCaches = resolve;
    });
    const { deps, calls } = buildDeps({
      clearApplicationCaches: vi.fn().mockReturnValue(pendingCaches),
    });

    const first = forceClearCacheImpl(deps);
    // Let the function reach the await point.
    await Promise.resolve();
    await Promise.resolve();

    const second = await forceClearCacheImpl(deps);
    expect(second).toBe('reentry');
    expect(calls.replaceLocation).not.toHaveBeenCalled();

    resolveCaches!();
    await first;
    expect(calls.replaceLocation).toHaveBeenCalledTimes(1);
  });

  it('skips clearApplicationCaches when it hangs longer than stepTimeoutMs', async () => {
    const hangingClear = vi.fn().mockReturnValue(new Promise<void>(() => { /* never resolves */ }));
    const { deps, calls } = buildDeps({ clearApplicationCaches: hangingClear });

    const promise = forceClearCacheImpl(deps);
    await vi.advanceTimersByTimeAsync(FORCE_CLEAR_STEP_TIMEOUT_MS + 10);
    await promise;

    expect(hangingClear).toHaveBeenCalledTimes(1);
    expect(calls.unregisterApplicationServiceWorkers).toHaveBeenCalledTimes(1);
    expect(calls.replaceLocation).toHaveBeenCalledTimes(1);
    expect(calls.logError).toHaveBeenCalledWith('force-clear-cache:clear-caches-timeout');
  });

  it('skips unregisterApplicationServiceWorkers on timeout but still navigates', async () => {
    const hangingUnreg = vi.fn().mockReturnValue(new Promise<void>(() => { /* never resolves */ }));
    const { deps, calls } = buildDeps({ unregisterApplicationServiceWorkers: hangingUnreg });

    const promise = forceClearCacheImpl(deps);
    await vi.advanceTimersByTimeAsync(FORCE_CLEAR_STEP_TIMEOUT_MS + 10);
    await promise;

    expect(calls.replaceLocation).toHaveBeenCalledTimes(1);
    expect(calls.logError).toHaveBeenCalledWith('force-clear-cache:unregister-sw-timeout');
  });

  it('still navigates when clearApplicationCaches throws', async () => {
    const { deps, calls } = buildDeps({
      clearApplicationCaches: vi.fn().mockRejectedValue(new Error('boom')),
    });

    await forceClearCacheImpl(deps);

    expect(calls.replaceLocation).toHaveBeenCalledTimes(1);
    expect(calls.logError).toHaveBeenCalled();
  });

  it('still navigates when setForceClearFlag throws synchronously', async () => {
    const { deps, calls } = buildDeps({
      setForceClearFlag: vi.fn(() => {
        throw new Error('storage full');
      }),
    });

    const result = await forceClearCacheImpl(deps);

    expect(result).toBe('ok');
    expect(calls.replaceLocation).toHaveBeenCalledTimes(1);
  });

  it('falls back to reloadLocation when replaceLocation does not unload within window', async () => {
    const { deps, calls } = buildDeps();

    const promise = forceClearCacheImpl(deps);
    await promise;

    expect(calls.replaceLocation).toHaveBeenCalledTimes(1);
    expect(calls.reloadLocation).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(FORCE_CLEAR_UNLOAD_FALLBACK_MS + 10);
    expect(calls.reloadLocation).toHaveBeenCalledTimes(1);
  });

  it('falls back to assignHref(originRoot) when reloadLocation also throws', async () => {
    const { deps, calls } = buildDeps({
      reloadLocation: vi.fn(() => {
        throw new Error('reload blocked');
      }),
    });

    const promise = forceClearCacheImpl(deps);
    await promise;

    await vi.advanceTimersByTimeAsync(FORCE_CLEAR_UNLOAD_FALLBACK_MS + 10);

    expect(calls.assignHref).toHaveBeenCalledWith('https://example.test/');
  });

  it('emits invoke + replace-location info breadcrumbs', async () => {
    const { deps, calls } = buildDeps();

    await forceClearCacheImpl(deps);

    expect(calls.logInfo).toHaveBeenCalledWith('force-clear-cache:invoke');
    expect(calls.logInfo).toHaveBeenCalledWith('force-clear-cache:replace-location');
  });

  it('releases gate via finally on normal completion (auto-release timer is also cleared)', async () => {
    // 该用例验证「正常路径」下闸门由 finally 块释放，并不会阻塞下一次调用。
    // gateReleaseMs 兜底定时器仅是双保险，正常路径无需依赖它。
    __resetForceClearGateForTests();
    const { deps } = buildDeps({ gateReleaseMs: 200 });

    const promise = forceClearCacheImpl(deps);
    expect(__isForceClearInProgressForTests()).toBe(true);

    await vi.advanceTimersByTimeAsync(500);
    await promise;

    expect(__isForceClearInProgressForTests()).toBe(false);
  });

  // Sanity: exported constants exist and are positive.
  it('exports sane defaults', () => {
    expect(FORCE_CLEAR_STEP_TIMEOUT_MS).toBeGreaterThan(0);
    expect(FORCE_CLEAR_GATE_RELEASE_MS).toBeGreaterThan(0);
    expect(FORCE_CLEAR_UNLOAD_FALLBACK_MS).toBeGreaterThan(0);
  });
});
