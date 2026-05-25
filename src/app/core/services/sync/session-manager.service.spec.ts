import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { SessionManagerService } from './session-manager.service';
import { SupabaseClientService } from '../../../../services/supabase-client.service';
import { LoggerService } from '../../../../services/logger.service';
import { ToastService } from '../../../../services/toast.service';
import { EventBusService } from '../../../../services/event-bus.service';
import { SyncStateService } from './sync-state.service';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import { resetBrowserNetworkSuspensionTrackingForTests } from '../../../../utils/browser-network-suspension';

describe('SessionManagerService', () => {
  let service: SessionManagerService;
  let sessionExpired = false;
  let sessionRestored$: Subject<{ type: 'session-restored'; userId: string; source: string }>;
  let sessionInvalidated$: Subject<{ type: 'session-invalidated'; userId: string | null; source: string }>;

  const mockAuth = {
    getSession: vi.fn(),
    refreshSession: vi.fn(),
  };

  const setVisibilityState = (state: DocumentVisibilityState): void => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: state,
    });
  };

  beforeEach(() => {
    resetBrowserNetworkSuspensionTrackingForTests();
    sessionExpired = false;
    sessionRestored$ = new Subject();
    sessionInvalidated$ = new Subject();
    setVisibilityState('visible');
    mockAuth.getSession.mockReset();
    mockAuth.refreshSession.mockReset();

    const mockLoggerCategory = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    TestBed.configureTestingModule({
      providers: [
        SessionManagerService,
        {
          provide: SupabaseClientService,
          useValue: {
            isConfigured: true,
            clientAsync: vi.fn().mockResolvedValue({ auth: mockAuth }),
          },
        },
        {
          provide: LoggerService,
          useValue: {
            category: vi.fn().mockReturnValue(mockLoggerCategory),
          },
        },
        {
          provide: ToastService,
          useValue: {
            warning: vi.fn(),
          },
        },
        {
          provide: EventBusService,
          useValue: {
            onSessionRestored$: sessionRestored$.asObservable(),
            onSessionInvalidated$: sessionInvalidated$.asObservable(),
          },
        },
        {
          provide: SyncStateService,
          useValue: {
            isSessionExpired: vi.fn(() => sessionExpired),
            setSessionExpired: vi.fn((value: boolean) => {
              sessionExpired = value;
            }),
          },
        },
        {
          provide: SentryLazyLoaderService,
          useValue: {
            addBreadcrumb: vi.fn(),
          },
        },
      ],
    });

    service = TestBed.inject(SessionManagerService);
  });

  afterEach(() => {
    resetBrowserNetworkSuspensionTrackingForTests();
    setVisibilityState('visible');
    sessionRestored$.complete();
    sessionInvalidated$.complete();
    TestBed.resetTestingModule();
  });

  it('should return ok without refresh when session is valid', async () => {
    mockAuth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-1' } } },
    });

    const result = await service.validateOrRefreshOnResume('resume:test');

    expect(result).toEqual({ ok: true, refreshed: false, deferred: false });
    expect(mockAuth.refreshSession).not.toHaveBeenCalled();
  });

  it('should refresh session when validation fails', async () => {
    mockAuth.getSession.mockResolvedValue({
      data: { session: null },
    });
    mockAuth.refreshSession.mockResolvedValue({
      data: { session: { user: { id: 'user-2' }, expires_at: 1 } },
      error: null,
    });

    const result = await service.validateOrRefreshOnResume('resume:test');

    expect(result).toEqual({ ok: true, refreshed: true, deferred: false });
    expect(mockAuth.refreshSession).toHaveBeenCalledTimes(1);
  });

  it('should mark session expired when validate and refresh both fail', async () => {
    const syncState = TestBed.inject(SyncStateService) as unknown as {
      setSessionExpired: ReturnType<typeof vi.fn>;
    };
    const toast = TestBed.inject(ToastService) as unknown as {
      warning: ReturnType<typeof vi.fn>;
    };

    mockAuth.getSession.mockResolvedValue({
      data: { session: null },
    });
    mockAuth.refreshSession.mockResolvedValue({
      data: { session: null },
      error: { message: 'refresh failed' },
    });

    const result = await service.validateOrRefreshOnResume('resume:test');

    expect(result).toEqual({ ok: false, refreshed: false, deferred: false, reason: 'refresh-failed' });
    expect(syncState.setSessionExpired).toHaveBeenCalledWith(true);
    expect(toast.warning).toHaveBeenCalled();
  });

  it('should treat auth session missing as no-session and short-circuit later resume checks', async () => {
    const syncState = TestBed.inject(SyncStateService) as unknown as {
      setSessionExpired: ReturnType<typeof vi.fn>;
    };

    mockAuth.getSession.mockResolvedValue({
      data: { session: null },
    });
    mockAuth.refreshSession.mockResolvedValue({
      data: { session: null },
      error: { message: 'Auth session missing!' },
    });

    const first = await service.validateOrRefreshOnResume('resume:test');

    expect(first).toEqual({ ok: false, refreshed: false, deferred: false, reason: 'no-session' });
    expect(syncState.setSessionExpired).toHaveBeenCalledWith(true);
    expect(mockAuth.refreshSession).toHaveBeenCalledTimes(1);

    mockAuth.getSession.mockClear();
    mockAuth.refreshSession.mockClear();

    const second = await service.validateOrRefreshOnResume('resume:test');

    expect(second).toEqual({ ok: false, refreshed: false, deferred: false, reason: 'no-session' });
    expect(mockAuth.getSession).not.toHaveBeenCalled();
    expect(mockAuth.refreshSession).not.toHaveBeenCalled();
  });

  it('should clear no-session short-circuit after session restored event', async () => {
    mockAuth.getSession.mockResolvedValue({
      data: { session: null },
    });
    mockAuth.refreshSession.mockResolvedValue({
      data: { session: null },
      error: { message: 'Auth session missing!' },
    });

    await service.validateOrRefreshOnResume('resume:test');

    sessionRestored$.next({
      type: 'session-restored',
      userId: 'user-restored',
      source: 'AuthService',
    });

    mockAuth.getSession.mockReset();
    mockAuth.refreshSession.mockReset();
    mockAuth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-restored' } } },
    });

    const result = await service.validateOrRefreshOnResume('resume:test');

    expect(result).toEqual({ ok: true, refreshed: false, deferred: false });
    expect(mockAuth.getSession).toHaveBeenCalledTimes(1);
  });

  it('should return deferred when supabase client is not ready on resume', async () => {
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };

    supabase.clientAsync.mockResolvedValueOnce(null);

    const syncState = TestBed.inject(SyncStateService) as unknown as {
      setSessionExpired: ReturnType<typeof vi.fn>;
    };
    const toast = TestBed.inject(ToastService) as unknown as {
      warning: ReturnType<typeof vi.fn>;
    };

    const result = await service.validateOrRefreshOnResume('resume:test');

    expect(result).toEqual({ ok: false, refreshed: false, deferred: true, reason: 'client-unready' });
    expect(syncState.setSessionExpired).not.toHaveBeenCalledWith(true);
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('should defer resume validation during suspended browser network window', async () => {
    const syncState = TestBed.inject(SyncStateService) as unknown as {
      setSessionExpired: ReturnType<typeof vi.fn>;
    };
    const toast = TestBed.inject(ToastService) as unknown as {
      warning: ReturnType<typeof vi.fn>;
    };

    setVisibilityState('hidden');

    const result = await service.validateOrRefreshOnResume('resume:test');

    expect(result).toEqual({ ok: false, refreshed: false, deferred: true, reason: 'client-unready' });
    expect(mockAuth.getSession).not.toHaveBeenCalled();
    expect(mockAuth.refreshSession).not.toHaveBeenCalled();
    expect(syncState.setSessionExpired).not.toHaveBeenCalledWith(true);
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('should classify transient refresh transport failures as client-unready', async () => {
    mockAuth.refreshSession.mockResolvedValue({
      data: { session: null },
      error: { message: 'Failed to fetch' },
    });

    const result = await service.tryRefreshSessionWithReason('speech:test');

    expect(result).toEqual({ refreshed: false, reason: 'client-unready' });
  });

  it('should allow explicit refresh attempts even when sessionExpired is already set', async () => {
    sessionExpired = true;
    mockAuth.refreshSession.mockResolvedValue({
      data: { session: { user: { id: 'user-explicit' }, expires_at: 1 } },
      error: null,
    });

    const result = await service.tryRefreshSessionWithReason('speech:test');

    expect(result).toEqual({ refreshed: true });
    expect(mockAuth.refreshSession).toHaveBeenCalledTimes(1);
  });

  it('should expose refreshed session for callers that must avoid rereading stale getSession data', async () => {
    const refreshedSession = {
      access_token: 'fresh-token',
      refresh_token: 'refresh-token',
      expires_at: 1,
      token_type: 'bearer',
      user: { id: 'user-refresh' },
    };

    mockAuth.refreshSession.mockResolvedValue({
      data: { session: refreshedSession },
      error: null,
    });

    const result = await service.tryRefreshSessionWithSession('speech:test');

    expect(result).toEqual({
      refreshed: true,
      session: refreshedSession,
    });
  });
});
