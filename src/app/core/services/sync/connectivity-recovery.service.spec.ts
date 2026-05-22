/**
 * ConnectivityRecoveryService 单元测试
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ConnectivityRecoveryService } from './connectivity-recovery.service';
import { SupabaseClientService } from '../../../../services/supabase-client.service';
import { LoggerService } from '../../../../services/logger.service';
import { SessionManagerService } from './session-manager.service';
import { RealtimePollingService } from './realtime-polling.service';
import { RetryQueueService } from './retry-queue.service';
import { SyncStateService } from './sync-state.service';
import { BlackBoxSyncService } from '../../../../services/black-box-sync.service';

const mockSupabase = {
  isOfflineMode: signal(false),
  probeReachability: vi.fn().mockResolvedValue(true),
};

const mockLogger = {
  category: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
};

const mockSessionManager = {
  getRecentValidationSnapshot: vi.fn().mockReturnValue({ valid: true }),
  validateOrRefreshOnResume: vi.fn().mockResolvedValue({ ok: true, deferred: false }),
};

const mockRealtimePolling = {
  suspendTransport: vi.fn().mockResolvedValue(undefined),
  resumeTransport: vi.fn().mockResolvedValue(undefined),
  resumeRealtimeUpdates: vi.fn(),
  hasRemoteChangeCallback: vi.fn().mockReturnValue(false),
  getCurrentProjectId: vi.fn().mockReturnValue(null),
  triggerRemoteChange: vi.fn().mockResolvedValue(undefined),
};

const mockRetryQueue = {
  processQueue: vi.fn(),
  length: 0,
};

const mockSyncState = {
  setOfflineMode: vi.fn(),
};

const mockBlackBoxSync = {
  pullChanges: vi.fn().mockResolvedValue({ success: true }),
};

describe('ConnectivityRecoveryService', () => {
  let service: ConnectivityRecoveryService;

  beforeEach(() => {
    mockSupabase.isOfflineMode.set(false);
    mockSupabase.probeReachability.mockReset();
    mockSupabase.probeReachability.mockResolvedValue(true);

    mockLogger.category.mockClear();
    mockSessionManager.getRecentValidationSnapshot.mockClear();
    mockSessionManager.validateOrRefreshOnResume.mockClear();
    mockRealtimePolling.suspendTransport.mockClear();
    mockRealtimePolling.resumeTransport.mockClear();
    mockRealtimePolling.resumeRealtimeUpdates.mockClear();
    mockRealtimePolling.hasRemoteChangeCallback.mockClear();
    mockRealtimePolling.getCurrentProjectId.mockClear();
    mockRealtimePolling.triggerRemoteChange.mockClear();
    mockRetryQueue.processQueue.mockClear();
    mockRetryQueue.length = 0;
    mockSyncState.setOfflineMode.mockClear();
    mockBlackBoxSync.pullChanges.mockClear();
    mockBlackBoxSync.pullChanges.mockResolvedValue({ success: true });

    TestBed.configureTestingModule({
      providers: [
        ConnectivityRecoveryService,
        { provide: SupabaseClientService, useValue: mockSupabase },
        { provide: LoggerService, useValue: mockLogger },
        { provide: SessionManagerService, useValue: mockSessionManager },
        { provide: RealtimePollingService, useValue: mockRealtimePolling },
        { provide: RetryQueueService, useValue: mockRetryQueue },
        { provide: SyncStateService, useValue: mockSyncState },
        { provide: BlackBoxSyncService, useValue: mockBlackBoxSync },
      ],
    });

    service = TestBed.inject(ConnectivityRecoveryService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  it('should start runtime', () => {
    service.startRuntime();
    // Runtime started - connectivity recovery is now active
  });

  it('should stop runtime', () => {
    service.startRuntime();
    service.stopRuntime();
    // Runtime stopped - connectivity recovery is now inactive
  });

  it('should handle connectivity change to offline', () => {
    service.startRuntime();
    service.handleSupabaseConnectivityChange(
      { offline: true, source: 'request' },
      true
    );

    expect(mockSyncState.setOfflineMode).toHaveBeenCalledWith(true);
    expect(mockRealtimePolling.suspendTransport).toHaveBeenCalled();
  });

  it('should handle connectivity change to online', async () => {
    service.startRuntime();
    service.handleSupabaseConnectivityChange(
      { offline: false, source: 'request' },
      true
    );

    expect(mockSyncState.setOfflineMode).toHaveBeenCalledWith(false);

    // Wait for async operations
    await new Promise(resolve => setTimeout(resolve, 0));
  });

  it('should probe remote reachability successfully', async () => {
    const result = await service.probeRemoteReachability('test-reason');

    expect(result).toBe(true);
    expect(mockSupabase.probeReachability).toHaveBeenCalled();
    expect(mockSyncState.setOfflineMode).toHaveBeenCalledWith(false);
  });

  it('should handle unreachable remote', async () => {
    (mockSupabase.probeReachability as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    const result = await service.probeRemoteReachability('test-reason');

    expect(result).toBe(false);
    expect(mockSyncState.setOfflineMode).toHaveBeenCalledWith(true);
    expect(mockRealtimePolling.suspendTransport).toHaveBeenCalled();
  });

  it('should schedule connectivity recovery', () => {
    service.startRuntime();

    vi.useFakeTimers();
    service.scheduleConnectivityRecovery('test-reason', 100);

    expect(vi.getTimerCount()).toBe(1);

    vi.runAllTimers();
    vi.useRealTimers();
  });

  it('should restore remote connectivity', async () => {
    service.startRuntime();

    await service.restoreRemoteConnectivity('test-reason');

    // Verify connectivity restoration flow completed
    expect(mockRealtimePolling.resumeTransport).toHaveBeenCalled();
    expect(mockRealtimePolling.resumeRealtimeUpdates).toHaveBeenCalled();
  });

  it('should not restore connectivity if runtime not started', async () => {
    await service.restoreRemoteConnectivity('test-reason');

    // Should exit early without restoring
    expect(mockRealtimePolling.resumeTransport).not.toHaveBeenCalled();
  });
});
