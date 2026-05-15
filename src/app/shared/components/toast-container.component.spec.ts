/**
 * ToastContainerComponent 单元测试
 *
 * 覆盖 2026-05-15 修复关键行为：
 * - 异步 action.onClick 在执行期间显示 pendingLabel；
 * - 执行期间按钮 disabled；
 * - onClick 完成（成功或失败）后 dismiss；
 * - 5 秒兜底超时后强制 dismiss，避免「正在刷新…」永久卡死；
 * - 防止用户连点重入。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ToastContainerComponent } from './toast-container.component';
import { ToastService, type ToastMessage } from '../../../services/toast.service';
import { UiStateService } from '../../../services/ui-state.service';

vi.mock('../../../config', () => ({
  TOAST_CONFIG: {
    DEFAULT_DURATION: 5000,
    ERROR_DEDUP_INTERVAL: 5000,
  },
}));

function makeMessage(action: ToastMessage['action']): ToastMessage {
  return {
    id: 'msg-1',
    type: 'info',
    title: 'test',
    duration: 0,
    createdAt: Date.now(),
    action,
  };
}

describe('ToastContainerComponent.handleAction', () => {
  let component: ToastContainerComponent;
  let mockToast: { dismiss: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.useFakeTimers();
    mockToast = { dismiss: vi.fn() };

    TestBed.configureTestingModule({
      providers: [
        { provide: ToastService, useValue: mockToast },
        { provide: UiStateService, useValue: { isMobile: () => false } },
      ],
    });

    component = TestBed.runInInjectionContext(() => new ToastContainerComponent());
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
  });

  it('marks toast as pending while async onClick is in flight', async () => {
    let resolveClick: (() => void) | null = null;
    const onClick = vi.fn().mockReturnValue(new Promise<void>(resolve => { resolveClick = resolve; }));
    const message = makeMessage({ label: '立即刷新', pendingLabel: '正在刷新…', onClick });

    component.handleAction(message);

    expect(component.isActionPending('msg-1')).toBe(true);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(mockToast.dismiss).not.toHaveBeenCalled();

    resolveClick!();
    await Promise.resolve();
    await Promise.resolve();

    expect(component.isActionPending('msg-1')).toBe(false);
    expect(mockToast.dismiss).toHaveBeenCalledWith('msg-1');
  });

  it('dismisses synchronously when onClick is sync void', () => {
    const onClick = vi.fn();
    const message = makeMessage({ label: '执行', onClick });

    component.handleAction(message);

    // 同步路径：onClick 调用、pending 立即解除、toast 已 dismiss。
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(component.isActionPending('msg-1')).toBe(false);
    expect(mockToast.dismiss).toHaveBeenCalledWith('msg-1');
  });

  it('still dismisses when async onClick rejects', async () => {
    const onClick = vi.fn().mockRejectedValue(new Error('activate failed'));
    const message = makeMessage({ label: '立即刷新', pendingLabel: '正在刷新…', onClick });

    component.handleAction(message);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(component.isActionPending('msg-1')).toBe(false);
    expect(mockToast.dismiss).toHaveBeenCalledWith('msg-1');
  });

  it('still dismisses when sync onClick throws', () => {
    const onClick = vi.fn(() => {
      throw new Error('boom');
    });
    const message = makeMessage({ label: '执行', onClick });

    component.handleAction(message);

    expect(component.isActionPending('msg-1')).toBe(false);
    expect(mockToast.dismiss).toHaveBeenCalledWith('msg-1');
  });

  it('force-dismisses after 5s fallback when onClick promise never settles', async () => {
    const onClick = vi.fn().mockReturnValue(new Promise<void>(() => { /* never resolves */ }));
    const message = makeMessage({ label: '立即刷新', pendingLabel: '正在刷新…', onClick });

    component.handleAction(message);
    expect(component.isActionPending('msg-1')).toBe(true);
    expect(mockToast.dismiss).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5000);

    expect(component.isActionPending('msg-1')).toBe(false);
    expect(mockToast.dismiss).toHaveBeenCalledWith('msg-1');
  });

  it('ignores duplicate clicks while pending (防连点重入)', () => {
    let resolveClick: (() => void) | null = null;
    const onClick = vi.fn().mockReturnValue(new Promise<void>(resolve => { resolveClick = resolve; }));
    const message = makeMessage({ label: '立即刷新', pendingLabel: '正在刷新…', onClick });

    component.handleAction(message);
    component.handleAction(message);
    component.handleAction(message);

    expect(onClick).toHaveBeenCalledTimes(1);
    resolveClick!();
  });

  it('dismisses immediately when message has no action', () => {
    const message = makeMessage(undefined);

    component.handleAction(message);

    expect(mockToast.dismiss).toHaveBeenCalledWith('msg-1');
    expect(component.isActionPending('msg-1')).toBe(false);
  });
});
