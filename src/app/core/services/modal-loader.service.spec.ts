/**
 * ModalLoaderService 单元测试
 *
 * 重点覆盖 2026-05-15 新增的 stale-chunk 识别：当 import() 因为部署窗口拿到
 * MIME=text/html 的 chunk 时，跳过重试、不上报 Sentry、给出"刷新"CTA toast。
 */
import { Injector, runInInjectionContext } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ModalLoaderService } from './modal-loader.service';
import { LoggerService } from '../../../services/logger.service';
import { ToastService } from '../../../services/toast.service';
import { DynamicModalService } from '../../../services/dynamic-modal.service';
import { SentryLazyLoaderService } from '../../../services/sentry-lazy-loader.service';

describe('ModalLoaderService stale-chunk handling', () => {
  let service: ModalLoaderService;
  const toastWarn = vi.fn();
  const toastError = vi.fn();
  const captureException = vi.fn();
  const loggerStub = {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();

    const injector = Injector.create({
      providers: [
        { provide: ModalLoaderService, useClass: ModalLoaderService },
        { provide: LoggerService, useValue: { category: () => loggerStub } },
        { provide: ToastService, useValue: { warning: toastWarn, error: toastError, success: vi.fn(), info: vi.fn() } },
        { provide: DynamicModalService, useValue: { open: vi.fn(), close: vi.fn() } },
        { provide: SentryLazyLoaderService, useValue: { captureException } },
      ],
    });

    service = runInInjectionContext(injector, () => injector.get(ModalLoaderService));
  });

  it('"Failed to fetch dynamically imported module" 命中后应跳过重试，不调用 Sentry，并给出刷新 CTA', async () => {
    const loader = vi.fn().mockRejectedValue(
      new TypeError('Failed to fetch dynamically imported module: https://x.dev/chunk-AAA.js')
    );

    // 调用私有 loadModal 方法
    const loadModal = (service as unknown as { loadModal: <T>(type: string, l: () => Promise<T>) => Promise<T> }).loadModal.bind(service);
    await expect(loadModal('trash', loader)).rejects.toBeInstanceOf(TypeError);

    // 关键断言：只调用一次（不再重试 MAX_RETRIES 次）
    expect(loader).toHaveBeenCalledTimes(1);
    // 不上报 Sentry——这是预期内的部署窗口
    expect(captureException).not.toHaveBeenCalled();
    // 提示用户刷新页面
    expect(toastWarn).toHaveBeenCalledWith(
      '版本已更新',
      '请刷新页面以加载最新组件',
      expect.objectContaining({
        duration: 0,
        action: expect.objectContaining({ label: '立即刷新' }),
      }),
    );
  });

  it('MIME text/html 错误也应被识别为 stale-chunk', async () => {
    const loader = vi.fn().mockRejectedValue(
      new TypeError('Expected a JavaScript module but the server responded with a MIME type of "text/html"')
    );
    const loadModal = (service as unknown as { loadModal: <T>(type: string, l: () => Promise<T>) => Promise<T> }).loadModal.bind(service);

    await expect(loadModal('trash', loader)).rejects.toBeInstanceOf(TypeError);

    expect(loader).toHaveBeenCalledTimes(1);
    expect(captureException).not.toHaveBeenCalled();
    expect(toastWarn).toHaveBeenCalled();
  });

  it('真正的网络抖动（不命中 stale-chunk 规则）仍走原有重试逻辑', async () => {
    const loader = vi.fn().mockRejectedValue(new TypeError('NetworkError when attempting to fetch resource.'));
    const loadModal = (service as unknown as { loadModal: <T>(type: string, l: () => Promise<T>) => Promise<T> }).loadModal.bind(service);

    await expect(loadModal('trash', loader)).rejects.toBeInstanceOf(TypeError);

    // MAX_RETRIES=2 → 总共调用 3 次
    expect(loader).toHaveBeenCalledTimes(3);
    // 上报 Sentry
    expect(captureException).toHaveBeenCalled();
    // 不应给出 stale-chunk 刷新 CTA toast
    expect(toastWarn).not.toHaveBeenCalledWith('版本已更新', expect.anything(), expect.anything());
  }, 15000);
});
