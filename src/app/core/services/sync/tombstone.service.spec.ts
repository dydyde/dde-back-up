import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Injector, runInInjectionContext } from '@angular/core';
import { TombstoneService } from './tombstone.service';
import { LoggerService } from '../../../../services/logger.service';
import { RequestThrottleService } from '../../../../services/request-throttle.service';
import {
  isBrowserNetworkSuspendedError,
  resetBrowserNetworkSuspensionTrackingForTests,
} from '../../../../utils/browser-network-suspension';

function setVisibilityState(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: state,
  });
}

const mockLoggerCategory = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const mockLoggerService = {
  category: vi.fn(() => mockLoggerCategory),
};

const mockThrottleService = {
  execute: vi.fn(),
};

describe('TombstoneService', () => {
  let service: TombstoneService;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-23T00:00:00.000Z'));
    resetBrowserNetworkSuspensionTrackingForTests();
    setVisibilityState('visible');
    localStorage.removeItem('nanoflow.local-tombstones');

    const injector = Injector.create({
      providers: [
        TombstoneService,
        { provide: LoggerService, useValue: mockLoggerService },
        { provide: RequestThrottleService, useValue: mockThrottleService },
      ],
    });

    service = runInInjectionContext(injector, () => injector.get(TombstoneService));
  });

  afterEach(() => {
    vi.useRealTimers();
    resetBrowserNetworkSuspensionTrackingForTests();
    localStorage.removeItem('nanoflow.local-tombstones');
  });

  it('should reject older candidates that are not newer than the local tombstone timestamp', () => {
    service.addLocalTombstones('project-1', ['task-1']);

    expect(service.shouldRejectTaskUpsert('project-1', 'task-1', '2026-04-22T23:59:59.000Z')).toBe(true);
  });

  it('should allow newer candidates to clear the local tombstone guard', () => {
    service.addLocalTombstones('project-1', ['task-1']);

    expect(service.shouldRejectTaskUpsert('project-1', 'task-1', '2026-04-23T00:00:01.000Z')).toBe(false);
    expect(service.getLocalTombstones('project-1').has('task-1')).toBe(false);
  });

  it('should compare restores against the actual delete timestamp instead of the later cache write time', () => {
    vi.setSystemTime(new Date('2026-04-23T02:00:00.000Z'));

    service.addLocalTombstones('project-1', ['task-1'], {
      'task-1': '2026-04-23T00:00:00.000Z',
    });

    expect(service.shouldRejectTaskUpsert('project-1', 'task-1', '2026-04-23T01:00:00.000Z')).toBe(false);
  });

  it('should compare remote restores against the cached tombstone deletedAt watermark instead of cache fetch time', () => {
    vi.setSystemTime(new Date('2026-04-23T02:00:00.000Z'));

    service.updateTombstoneCache(
      'project-1',
      new Set(['task-1']),
      new Map([['task-1', new Date('2026-04-23T00:00:00.000Z').getTime()]])
    );

    expect(service.shouldRejectTaskUpsert('project-1', 'task-1', '2026-04-23T01:00:00.000Z')).toBe(false);
  });

  it('should allow restore candidates when batch-preloaded remote tombstones lack deletedAt watermarks', () => {
    vi.setSystemTime(new Date('2026-04-23T02:00:00.000Z'));

    service.updateTombstoneCache('project-1', new Set(['task-1']));

    expect(service.shouldRejectTaskUpsert('project-1', 'task-1', '2026-04-23T01:00:00.000Z')).toBe(false);
  });

  it('getTombstonesWithCache should return a suspension error without querying remote while hidden', async () => {
    setVisibilityState('hidden');

    const result = await service.getTombstonesWithCache(
      'project-1',
      {} as Parameters<TombstoneService['getTombstonesWithCache']>[1]
    );

    expect(result.data).toBeNull();
    expect(isBrowserNetworkSuspendedError(result.error)).toBe(true);
    expect(mockThrottleService.execute).not.toHaveBeenCalled();
  });
});
