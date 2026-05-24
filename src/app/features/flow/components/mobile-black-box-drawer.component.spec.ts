import { Injector, runInInjectionContext, signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { MobileBlackBoxDrawerComponent } from './mobile-black-box-drawer.component';
import { BlackBoxService } from '../../../../services/black-box.service';
import { SpeechToTextService } from '../../../../services/speech-to-text.service';
import { FocusPreferenceService } from '../../../../services/focus-preference.service';
import { ToastService } from '../../../../services/toast.service';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';

describe('MobileBlackBoxDrawerComponent', () => {
  it('ngOnInit 应只补本地快照，不触发远端拉取', async () => {
    const blackBoxService = {
      entriesByDate: signal([]),
      pendingCount: signal(0),
      refreshForView: vi.fn().mockResolvedValue(undefined),
      loadFromServer: vi.fn(),
    };

    const injector = Injector.create({
      providers: [
        { provide: BlackBoxService, useValue: blackBoxService },
        { provide: SpeechToTextService, useValue: {} },
        { provide: FocusPreferenceService, useValue: {} },
        { provide: ToastService, useValue: {} },
        { provide: TaskOperationAdapterService, useValue: {} },
      ],
    });

    const component = runInInjectionContext(injector, () => new MobileBlackBoxDrawerComponent());

    component.ngOnInit();
    await Promise.resolve();

    expect(blackBoxService.refreshForView).toHaveBeenCalledTimes(1);
    expect(blackBoxService.loadFromServer).not.toHaveBeenCalled();

    // 清理 visibilitychange 监听器
    component.ngOnDestroy();
  });

  it('visibilitychange → visible 时应触发 refreshForView', async () => {
    const blackBoxService = {
      entriesByDate: signal([]),
      pendingCount: signal(0),
      refreshForView: vi.fn().mockResolvedValue(undefined),
      loadFromServer: vi.fn(),
    };

    const injector = Injector.create({
      providers: [
        { provide: BlackBoxService, useValue: blackBoxService },
        { provide: SpeechToTextService, useValue: {} },
        { provide: FocusPreferenceService, useValue: {} },
        { provide: ToastService, useValue: {} },
        { provide: TaskOperationAdapterService, useValue: {} },
      ],
    });

    const component = runInInjectionContext(injector, () => new MobileBlackBoxDrawerComponent());
    component.ngOnInit();
    blackBoxService.refreshForView.mockClear();

    // 模拟 visibility 变为 visible
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));

    expect(blackBoxService.refreshForView).toHaveBeenCalledTimes(1);

    component.ngOnDestroy();
  });
});