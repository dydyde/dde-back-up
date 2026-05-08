import { TestBed } from '@angular/core/testing';
import { Injector, runInInjectionContext } from '@angular/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { BlackBoxEntryComponent } from './black-box-entry.component';
import type { BlackBoxEntry } from '../../../../../models';
import { AUTH_CONFIG } from '../../../../../config/auth.config';

function createEntry(overrides: Partial<BlackBoxEntry> = {}): BlackBoxEntry {
  return {
    id: 'entry-1',
    projectId: null,
    userId: 'user-1',
    content: 'entry',
    date: '2026-05-08',
    createdAt: '2026-05-08T10:00:00.000Z',
    updatedAt: '2026-05-08T10:00:00.000Z',
    isRead: false,
    isCompleted: false,
    isArchived: false,
    deletedAt: null,
    syncStatus: 'pending',
    ...overrides,
  };
}

describe('BlackBoxEntryComponent', () => {
  let injector: Injector;

  beforeEach(() => {
    injector = TestBed.configureTestingModule({}).inject(Injector);
  });

  it('云端用户 pending 条目应显示待同步标识', () => {
    const component = runInInjectionContext(injector, () => new BlackBoxEntryComponent());
    component.entry = (() => createEntry()) as typeof component.entry;

    expect(component.shouldShowSyncPendingIndicator()).toBe(true);
  });

  it('本地模式历史 pending 条目不应显示远端待同步标识', () => {
    const component = runInInjectionContext(injector, () => new BlackBoxEntryComponent());
    component.entry = (() => createEntry({
      userId: AUTH_CONFIG.LOCAL_MODE_USER_ID,
      syncStatus: 'pending',
    })) as typeof component.entry;

    expect(component.shouldShowSyncPendingIndicator()).toBe(false);
  });
});
