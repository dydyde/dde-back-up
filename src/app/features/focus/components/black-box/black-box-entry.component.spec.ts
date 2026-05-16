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

  it('conflict 条目应显示待确认标识而不是待同步', () => {
    const component = runInInjectionContext(injector, () => new BlackBoxEntryComponent());
    component.entry = (() => createEntry({
      syncStatus: 'conflict',
    })) as typeof component.entry;

    expect(component.shouldShowSyncPendingIndicator()).toBe(false);
    expect(component.shouldShowSyncConflictIndicator()).toBe(true);
  });

  // 2026-05-16 视觉收敛护栏：pending → synced input 切换后徽标必须被隐藏。
  // 此前多次"声明性根因修复"未能从视觉上消除问题，这里用函数层显式断言：
  // 同一组件实例在 entry input 变换为 synced 后，徽标判定必须立刻返回 false。
  it('pending → synced 后 shouldShowSyncPendingIndicator 必须立即返回 false', () => {
    const component = runInInjectionContext(injector, () => new BlackBoxEntryComponent());
    let current: BlackBoxEntry = createEntry({ syncStatus: 'pending' });
    component.entry = (() => current) as typeof component.entry;
    expect(component.shouldShowSyncPendingIndicator()).toBe(true);

    current = createEntry({
      syncStatus: 'synced',
      updatedAt: '2026-05-08T10:00:05.000Z',
    });
    expect(component.shouldShowSyncPendingIndicator()).toBe(false);
    expect(component.shouldShowSyncConflictIndicator()).toBe(false);
  });

  // 2026-05-16 取证：syncDebugAttribute 必须暴露 syncStatus + updatedAt，
  // 模板已通过 [attr.data-sync-debug]="syncDebugAttribute()" 绑定到徽标 span，
  // 便于真机/远程截图直接读出真实同步状态，定位"UI 显示待同步但实际状态"。
  it('syncDebugAttribute 应组合 syncStatus 与 updatedAt 供 DOM 取证', () => {
    const component = runInInjectionContext(injector, () => new BlackBoxEntryComponent());
    component.entry = (() => createEntry({
      syncStatus: 'pending',
      updatedAt: '2026-05-08T10:00:00.000Z',
    })) as typeof component.entry;
    expect(component.syncDebugAttribute()).toBe('pending|2026-05-08T10:00:00.000Z');

    component.entry = (() => createEntry({
      syncStatus: 'synced',
      updatedAt: '2026-05-08T10:01:23.456Z',
    })) as typeof component.entry;
    expect(component.syncDebugAttribute()).toBe('synced|2026-05-08T10:01:23.456Z');
  });
});
