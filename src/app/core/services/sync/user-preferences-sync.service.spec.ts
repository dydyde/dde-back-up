import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserPreferencesSyncService } from './user-preferences-sync.service';
import { SupabaseClientService } from '../../../../services/supabase-client.service';
import { LoggerService } from '../../../../services/logger.service';
import { resetBrowserNetworkSuspensionTrackingForTests } from '../../../../utils/browser-network-suspension';

function setVisibilityState(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: state,
  });
}

describe('UserPreferencesSyncService', () => {
  const maybeSingle = vi.fn();
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  const upsert = vi.fn();
  const from = vi.fn(() => ({ select, upsert }));

  beforeEach(() => {
    vi.clearAllMocks();
    resetBrowserNetworkSuspensionTrackingForTests();
    setVisibilityState('visible');
    maybeSingle.mockResolvedValue({ data: null, error: null });
    upsert.mockResolvedValue({ error: null });

    TestBed.configureTestingModule({
      providers: [
        UserPreferencesSyncService,
        {
          provide: SupabaseClientService,
          useValue: {
            isConfigured: true,
            client: () => ({ from }),
          },
        },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              error: vi.fn(),
              warn: vi.fn(),
              info: vi.fn(),
              debug: vi.fn(),
            }),
          },
        },
      ],
    });
  });

  it('loadUserPreferences should not use dock_snapshot runtime path', async () => {
    maybeSingle.mockResolvedValue({
      data: {
        theme: 'default',
        layout_direction: 'ltr',
        floating_window_pref: 'auto',
        color_mode: 'system',
        auto_resolve_conflicts: true,
        local_backup_enabled: false,
        local_backup_interval_ms: 3600000,
        last_backup_proof_at: '2026-04-23T10:00:00.000Z',
        focus_preferences: {
          gateEnabled: true,
          strataEnabled: true,
          blackBoxEnabled: true,
          maxSnoozePerDay: 3,
          routineResetHourLocal: 5,
          restReminderHighLoadMinutes: 120,
          restReminderLowLoadMinutes: 20,
        },
        dock_snapshot: { version: 4 },
      },
      error: null,
    });

    const service = TestBed.inject(UserPreferencesSyncService);
    const prefs = await service.loadUserPreferences('user-1');

    expect(select).toHaveBeenCalled();
    expect((select.mock.calls[0] as unknown[])[0]).not.toContain('dock_snapshot');
    expect(prefs?.dockSnapshot).toBeUndefined();
    expect(prefs?.lastBackupProofAt).toBe('2026-04-23T10:00:00.000Z');
    expect(prefs?.focusPreferences?.routineResetHourLocal).toBe(5);
    expect(prefs?.focusPreferences?.restReminderHighLoadMinutes).toBe(120);
    expect(prefs?.focusPreferences?.restReminderLowLoadMinutes).toBe(20);
  });

  it('saveUserPreferences should not persist dock_snapshot runtime field', async () => {
    const service = TestBed.inject(UserPreferencesSyncService);
    const ok = await service.saveUserPreferences('user-1', {
      lastBackupProofAt: '2026-04-23T11:00:00.000Z',
      dockSnapshot: {
        version: 5,
        entries: [],
        focusMode: false,
        isDockExpanded: true,
        muteWaitTone: false,
        session: {
          firstDragIntervened: false,
          focusBlurOn: false,
          focusScrimOn: true,
          mainTaskId: null,
          comboSelectIds: [],
          backupIds: [],
        },
        dailySlots: [],
        suspendChainRootTaskId: null,
        suspendRecommendationLocked: false,
        pendingDecision: null,
        dailyResetDate: '2026-03-03',
        savedAt: '2026-03-03T00:00:00.000Z',
      },
    });

    expect(ok).toBe(true);
    const [payload] = upsert.mock.calls[0];
    expect(payload.user_id).toBe('user-1');
    expect(payload.last_backup_proof_at).toBe('2026-04-23T11:00:00.000Z');
    expect(payload.dock_snapshot).toBeUndefined();
  });

  it('saveUserPreferences should defer quietly during browser network suspension', async () => {
    setVisibilityState('hidden');

    const service = TestBed.inject(UserPreferencesSyncService);
    const ok = await service.saveUserPreferences('user-1', { theme: 'default' });

    expect(ok).toBe(false);
    expect(upsert).not.toHaveBeenCalled();
  });
});
