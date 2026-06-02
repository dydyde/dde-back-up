/**
 * Web Vitals Service 单元测试
 * 
 * 测试范围:
 * 1. 网络质量检测
 * 2. 动态阈值计算
 * 3. Sentry 告警过滤
 * 4. 弱网环境处理
 */

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, afterEach, vi, type Mock, type MockedObject } from 'vitest';
import { WebVitalsService, WEB_VITALS_THRESHOLDS } from './web-vitals.service';
import { LoggerService } from './logger.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { mockSentryLazyLoaderService } from '../test-setup.mocks';
import { isDevMode } from '@angular/core';
import type { Metric } from 'web-vitals';

vi.mock('@angular/core', async () => {
  const actual = await vi.importActual<typeof import('@angular/core')>('@angular/core');
  return {
    ...actual,
    isDevMode: vi.fn(),
  };
});

const isDevModeMock = vi.mocked(isDevMode);

// Mock web-vitals library
vi.mock('web-vitals', () => ({
  onLCP: vi.fn(),
  onFCP: vi.fn(),
  onCLS: vi.fn(),
  onINP: vi.fn(),
  onTTFB: vi.fn(),
}));

// 获取 mock 引用（vi.mock 已替换模块，import 返回的是 vi.fn() 实例）
import { onLCP, onFCP, onCLS, onINP, onTTFB } from 'web-vitals';
const mockOnLCP = vi.mocked(onLCP);
const mockOnFCP = vi.mocked(onFCP);
const mockOnCLS = vi.mocked(onCLS);
const mockOnINP = vi.mocked(onINP);
const mockOnTTFB = vi.mocked(onTTFB);

describe('WebVitalsService - TTFB 优化测试', () => {
  let service: WebVitalsService;
  let mockLogger: Partial<LoggerService>;

  // Mock navigator.connection
  const mockConnection = (effectiveType: string, downlink: number, rtt: number, saveData = false) => {
    Object.defineProperty(navigator, 'connection', {
      configurable: true,
      value: { effectiveType, downlink, rtt, saveData },
      writable: true,
    });
  };

  beforeEach(() => {
    isDevModeMock.mockReturnValue(true);

    // Reset web-vitals mocks
    mockOnLCP.mockClear();
    mockOnFCP.mockClear();
    mockOnCLS.mockClear();
    mockOnINP.mockClear();
    mockOnTTFB.mockClear();

    // Reset Sentry mocks
    mockSentryLazyLoaderService.setMeasurement.mockClear();
    mockSentryLazyLoaderService.captureMessage.mockClear();

    // Mock LoggerService
    mockLogger = {
      category: vi.fn().mockReturnValue({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      }),
    } as any;

    TestBed.configureTestingModule({
      providers: [
        WebVitalsService,
        { provide: LoggerService, useValue: mockLogger },
        { provide: SentryLazyLoaderService, useValue: mockSentryLazyLoaderService },
      ],
    });

    service = TestBed.inject(WebVitalsService);
  });

  afterEach(() => {
    // Clean up connection mock
    delete (navigator as any).connection;
    // Clean up cached state to avoid cross-test pollution
    // @ts-ignore
    service['cachedNetworkQuality'] = null;
    // @ts-ignore
    service['cachedIsSynthetic'] = null;
  });

  describe('网络质量检测', () => {
    it('应该正确检测 4G 快速网络', () => {
      mockConnection('4g', 10, 50);

      // @ts-ignore - 访问私有方法进行测试
      const quality = service['detectNetworkQuality']();

      expect(quality).toBe('fast');
    });

    it('rtt 为 0 的 4G 高带宽网络应判为 fast（HeadlessChrome 不报 RTT）', () => {
      mockConnection('4g', 10, 0);

      // @ts-ignore
      const quality = service['detectNetworkQuality']();

      expect(quality).toBe('fast');
    });

    it('应该正确检测 3G 慢速网络', () => {
      mockConnection('3g', 1.35, 350); // 与 Sentry Alert 数据一致
      
      // @ts-ignore
      const quality = service['detectNetworkQuality']();
      
      expect(quality).toBe('slow');
    });

    it('应该正确检测 2G 网络', () => {
      mockConnection('2g', 0.4, 800);
      
      // @ts-ignore
      const quality = service['detectNetworkQuality']();
      
      expect(quality).toBe('slow');
    });

    it('4G 低带宽高延迟应识别为 slow（避免误判 moderate）', () => {
      mockConnection('4g', 0.4, 200);

      // @ts-ignore
      const quality = service['detectNetworkQuality']();

      expect(quality).toBe('slow');
    });

    it('应该正确检测极慢网络', () => {
      mockConnection('slow-2g', 0.1, 2000);
      
      // @ts-ignore
      const quality = service['detectNetworkQuality']();
      
      expect(quality).toBe('offline');
    });

    it('没有 Network Information API 时应该返回 unknown', () => {
      // Don't mock connection
      
      // @ts-ignore
      const quality = service['detectNetworkQuality']();
      
      expect(quality).toBe('unknown');
    });
  });

  describe('TTFB 阈值计算（生产环境）', () => {
    beforeEach(async () => {
      // Mock 生产环境
      isDevModeMock.mockReturnValue(false);
    });

    it('4G 网络应该使用标准阈值', () => {
      mockConnection('4g', 10, 50);
      
      // @ts-ignore
      const rating700 = service['getRating']('TTFB', 700);
      // @ts-ignore
      const rating1500 = service['getRating']('TTFB', 1500);
      // @ts-ignore
      const rating2000 = service['getRating']('TTFB', 2000);
      
      expect(rating700).toBe('good'); // < 800ms
      expect(rating1500).toBe('needs-improvement'); // < 1800ms
      expect(rating2000).toBe('poor'); // >= 1800ms
    });

    it('3G 网络应该使用放宽的阈值', () => {
      mockConnection('3g', 1.35, 350);
      
      // @ts-ignore
      const rating2500 = service['getRating']('TTFB', 2500);
      // @ts-ignore
      const rating2861 = service['getRating']('TTFB', 2861); // 实际 Sentry Alert 值
      // @ts-ignore
      const rating4500 = service['getRating']('TTFB', 4500);
      // @ts-ignore
      const rating5500 = service['getRating']('TTFB', 5500);
      
      expect(rating2500).toBe('good'); // < 3000ms
      expect(rating2861).toBe('good'); // < 3000ms - 关键测试！
      expect(rating4500).toBe('needs-improvement'); // < 5000ms
      expect(rating5500).toBe('poor'); // >= 5000ms
    });

    it('2G 网络应该使用放宽的阈值', () => {
      mockConnection('2g', 0.4, 800);
      
      // @ts-ignore
      const rating2900 = service['getRating']('TTFB', 2900);
      // @ts-ignore
      const rating4900 = service['getRating']('TTFB', 4900);
      
      expect(rating2900).toBe('good');
      expect(rating4900).toBe('needs-improvement');
    });

    it('4G 但链路受限时也应使用放宽阈值', () => {
      mockConnection('4g', 0.4, 200);

      // @ts-ignore
      const rating2800 = service['getRating']('TTFB', 2800);
      // @ts-ignore
      const rating4300 = service['getRating']('TTFB', 4300);

      expect(rating2800).toBe('good');
      expect(rating4300).toBe('needs-improvement');
    });

    it('moderate 网络应使用中间阈值', () => {
      mockConnection('4g', 5, 0); // 4G 中等带宽、rtt 不可用

      // @ts-ignore
      const rating1200 = service['getRating']('TTFB', 1200);
      // @ts-ignore
      const rating3136 = service['getRating']('TTFB', 3136); // 关键：Sentry Alert 实际值
      // @ts-ignore
      const rating4000 = service['getRating']('TTFB', 4000);

      expect(rating1200).toBe('good');          // < 1500ms
      expect(rating3136).toBe('needs-improvement'); // < 3500ms（moderate 放宽阈值）
      expect(rating4000).toBe('poor');           // >= 3500ms
    });
  });

  describe('Sentry 告警过滤', () => {
    beforeEach(async () => {
      // Mock 生产环境
      isDevModeMock.mockReturnValue(false);
    });

    it('开发环境 poor 指标只记录 measurement，不发送 Sentry 告警', () => {
      isDevModeMock.mockReturnValue(true);

      const clsMetric = {
        name: 'CLS',
        value: 0.3,
        id: 'test-id',
        delta: 0.3,
        navigationType: 'navigate',
        entries: [],
      } as unknown as Metric;

      // @ts-ignore
      service['reportToSentry'](clsMetric, 'poor');

      expect(mockSentryLazyLoaderService.setMeasurement).toHaveBeenCalledWith('CLS', 0.3, '');
      expect(mockSentryLazyLoaderService.captureMessage).not.toHaveBeenCalled();
    });

    it('3G 网络下的 poor TTFB 不应该触发告警', () => {
      mockConnection('3g', 1.35, 350);
      
      const metric = {
        name: 'TTFB',
        value: 2861,
        id: 'test-id',
        delta: 2861,
        navigationType: 'navigate',
        entries: [],
      } as any;
      
      // @ts-ignore
      service['reportToSentry'](metric, 'poor');
      
      // 不应该调用 captureMessage
      expect(mockSentryLazyLoaderService.captureMessage).not.toHaveBeenCalled();
      
      // 应该调用 setMeasurement（记录指标）
      expect(mockSentryLazyLoaderService.setMeasurement).toHaveBeenCalledWith('TTFB', 2861, 'millisecond');
    });

    it('4G 网络下的 poor TTFB 应该触发告警', () => {
      mockConnection('4g', 10, 50);
      // 确保非合成环境（测试环境可能有 navigator.webdriver = true）
      // @ts-ignore
      service['cachedIsSynthetic'] = false;

      const metric = {
        name: 'TTFB',
        value: 2861,
        id: 'test-id',
        delta: 2861,
        navigationType: 'navigate',
        entries: [],
      } as any;
      
      // @ts-ignore
      service['reportToSentry'](metric, 'poor');
      
      // 应该触发告警
      expect(mockSentryLazyLoaderService.captureMessage).toHaveBeenCalledWith(
        '性能告警: TTFB 超出阈值',
        expect.objectContaining({
          level: 'warning',
          tags: expect.objectContaining({
            'web-vital': 'TTFB',
            'rating': 'poor',
            'network-quality': 'fast',
          }),
          extra: expect.objectContaining({
            value: 2861,
            networkInfo: expect.objectContaining({
              effectiveType: '4g',
              downlink: 10,
              rtt: 50,
            }),
          }),
        })
      );
    });

    it('4G 低带宽下的 poor TTFB 不应该触发告警', () => {
      mockConnection('4g', 0.4, 200);

      const metric = {
        name: 'TTFB',
        value: 5200,
        id: 'test-id',
        delta: 5200,
        navigationType: 'navigate',
        entries: [],
      } as any;

      // @ts-ignore
      service['reportToSentry'](metric, 'poor');

      expect(mockSentryLazyLoaderService.captureMessage).not.toHaveBeenCalled();
    });

    it('moderate 网络下的 poor TTFB 不应该触发告警', () => {
      mockConnection('4g', 5, 0);

      const metric = {
        name: 'TTFB',
        value: 4000,
        id: 'test-id',
        delta: 4000,
        navigationType: 'navigate',
        entries: [],
      } as any;

      // @ts-ignore
      service['reportToSentry'](metric, 'poor');

      expect(mockSentryLazyLoaderService.captureMessage).not.toHaveBeenCalled();
    });

    it('HeadlessChrome 的 TTFB 不应该触发告警', () => {
      mockConnection('4g', 10, 50);
      // Mock HeadlessChrome user agent
      Object.defineProperty(navigator, 'userAgent', {
        configurable: true,
        value: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/145.0.7632.6 Safari/537.36',
        writable: true,
      });

      const metric = {
        name: 'TTFB',
        value: 3136,
        id: 'test-id',
        delta: 3136,
        navigationType: 'navigate',
        entries: [],
      } as any;

      // @ts-ignore
      service['reportToSentry'](metric, 'poor');

      expect(mockSentryLazyLoaderService.captureMessage).not.toHaveBeenCalled();
    });

    it('其他 Web Vitals 指标不受网络质量影响（CLS、INP）', () => {
      mockConnection('3g', 1.35, 350);

      const clsMetric = {
        name: 'CLS',
        value: 0.3,
        id: 'test-id',
        delta: 0.3,
        navigationType: 'navigate',
        entries: [],
      } as any;

      // @ts-ignore
      service['reportToSentry'](clsMetric, 'poor');

      // CLS 应该正常触发告警（不受网络质量过滤影响）
      expect(mockSentryLazyLoaderService.captureMessage).toHaveBeenCalled();
    });

    it('3G 网络下的 poor LCP 不应该触发告警（导航时序指标受 TTFB 级联影响）', () => {
      mockConnection('3g', 1.35, 350);

      const lcpMetric = {
        name: 'LCP',
        value: 7892,
        id: 'test-id',
        delta: 7892,
        navigationType: 'navigate',
        entries: [],
      } as any;

      // @ts-ignore
      service['reportToSentry'](lcpMetric, 'poor');

      // LCP 属于导航时序指标，3G 慢速网络下不应告警
      expect(mockSentryLazyLoaderService.captureMessage).not.toHaveBeenCalled();
    });

    it('3G 网络下的 poor FCP 不应该触发告警', () => {
      mockConnection('3g', 1.35, 350);

      const fcpMetric = {
        name: 'FCP',
        value: 5000,
        id: 'test-id',
        delta: 5000,
        navigationType: 'navigate',
        entries: [],
      } as any;

      // @ts-ignore
      service['reportToSentry'](fcpMetric, 'poor');

      expect(mockSentryLazyLoaderService.captureMessage).not.toHaveBeenCalled();
    });

    it('HeadlessChrome 的 LCP 不应该触发告警', () => {
      mockConnection('4g', 10, 50);
      Object.defineProperty(navigator, 'userAgent', {
        configurable: true,
        value: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/145.0.7632.6 Safari/537.36',
        writable: true,
      });

      const lcpMetric = {
        name: 'LCP',
        value: 7892,
        id: 'test-id',
        delta: 7892,
        navigationType: 'navigate',
        entries: [],
      } as any;

      // @ts-ignore
      service['reportToSentry'](lcpMetric, 'poor');

      expect(mockSentryLazyLoaderService.captureMessage).not.toHaveBeenCalled();
    });

    it('HeadlessChrome 的 FCP 不应该触发告警', () => {
      mockConnection('4g', 10, 50);
      Object.defineProperty(navigator, 'userAgent', {
        configurable: true,
        value: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/145.0.7632.6 Safari/537.36',
        writable: true,
      });

      const fcpMetric = {
        name: 'FCP',
        value: 7800,
        id: 'test-id',
        delta: 7800,
        navigationType: 'navigate',
        entries: [],
      } as any;

      // @ts-ignore
      service['reportToSentry'](fcpMetric, 'poor');

      expect(mockSentryLazyLoaderService.captureMessage).not.toHaveBeenCalled();
    });

    it('4G 快速网络下的 poor LCP 应该正常触发告警', () => {
      mockConnection('4g', 10, 50);
      // @ts-ignore
      service['cachedIsSynthetic'] = false;

      const lcpMetric = {
        name: 'LCP',
        value: 5000,
        id: 'test-id',
        delta: 5000,
        navigationType: 'navigate',
        entries: [],
      } as any;

      // @ts-ignore
      service['reportToSentry'](lcpMetric, 'poor');

      expect(mockSentryLazyLoaderService.captureMessage).toHaveBeenCalledWith(
        '性能告警: LCP 超出阈值',
        expect.objectContaining({
          level: 'warning',
          tags: expect.objectContaining({
            'web-vital': 'LCP',
            'rating': 'poor',
          }),
        })
      );
    });
  });

  describe('网络信息上下文', () => {
    it('应该正确提取网络信息', () => {
      mockConnection('3g', 1.35, 350);
      
      // @ts-ignore
      const networkInfo = service['getNetworkInfo']();
      
      expect(networkInfo).toEqual({
        effectiveType: '3g',
        downlink: 1.35,
        rtt: 350,
        saveData: false,
      });
    });

    it('没有 Network Information API 时应该返回 null', () => {
      // Don't mock connection
      
      // @ts-ignore
      const networkInfo = service['getNetworkInfo']();
      
      expect(networkInfo).toBeNull();
    });
  });

  describe('缓存机制', () => {
    it('应该缓存网络质量检测结果', () => {
      mockConnection('3g', 1.35, 350);

      // @ts-ignore
      const quality1 = service['detectNetworkQuality']();

      // 修改 connection 模拟数据
      mockConnection('4g', 10, 50);

      // @ts-ignore
      const quality2 = service['detectNetworkQuality']();

      // 第二次应该返回缓存的结果（slow），而不是重新检测（fast）
      expect(quality1).toBe('slow');
      expect(quality2).toBe('slow'); // 缓存生效
    });
  });

  describe('合成监控检测', () => {
    it('navigator.webdriver = true 应识别为合成环境', () => {
      Object.defineProperty(navigator, 'webdriver', {
        configurable: true,
        value: true,
        writable: true,
      });

      // @ts-ignore
      const isSynthetic = service['isSyntheticMonitoring']();
      expect(isSynthetic).toBe(true);

      // cleanup
      Object.defineProperty(navigator, 'webdriver', {
        configurable: true,
        value: false,
        writable: true,
      });
    });

    it('Lighthouse UA 应识别为合成环境', () => {
      Object.defineProperty(navigator, 'userAgent', {
        configurable: true,
        value: 'Mozilla/5.0 Chrome/120.0 Lighthouse/11.0',
        writable: true,
      });

      // @ts-ignore
      const isSynthetic = service['isSyntheticMonitoring']();
      expect(isSynthetic).toBe(true);
    });

    it('普通 Chrome UA 不应识别为合成环境', () => {
      Object.defineProperty(navigator, 'userAgent', {
        configurable: true,
        value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        writable: true,
      });
      Object.defineProperty(navigator, 'webdriver', {
        configurable: true,
        value: false,
        writable: true,
      });

      // @ts-ignore
      const isSynthetic = service['isSyntheticMonitoring']();
      expect(isSynthetic).toBe(false);
    });
  });

  describe('init() 合成环境绕过', () => {
    it('合成环境下 init() 不应注册 web-vitals 回调', () => {
      Object.defineProperty(navigator, 'userAgent', {
        configurable: true,
        value: 'Mozilla/5.0 HeadlessChrome/145.0.7632.6',
        writable: true,
      });

      service.init();

      // web-vitals 回调不应被注册
      expect(mockOnLCP).not.toHaveBeenCalled();
      expect(mockOnFCP).not.toHaveBeenCalled();
      expect(mockOnCLS).not.toHaveBeenCalled();
      expect(mockOnINP).not.toHaveBeenCalled();
      expect(mockOnTTFB).not.toHaveBeenCalled();
    });

    it('正常浏览器下 init() 应注册所有 web-vitals 回调', () => {
      Object.defineProperty(navigator, 'userAgent', {
        configurable: true,
        value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0',
        writable: true,
      });
      Object.defineProperty(navigator, 'webdriver', {
        configurable: true,
        value: false,
        writable: true,
      });

      service.init();

      expect(mockOnLCP).toHaveBeenCalledTimes(1);
      expect(mockOnFCP).toHaveBeenCalledTimes(1);
      expect(mockOnCLS).toHaveBeenCalledTimes(1);
      expect(mockOnINP).toHaveBeenCalledTimes(1);
      expect(mockOnTTFB).toHaveBeenCalledTimes(1);
    });
  });

  describe('unknown 网络下的告警行为', () => {
    beforeEach(() => {
      isDevModeMock.mockReturnValue(false);
    });

    it('没有 Network Information API 时 poor FCP 应该正常触发告警', () => {
      // 不 mock connection → unknown 网络
      // @ts-ignore
      service['cachedIsSynthetic'] = false;

      const fcpMetric = {
        name: 'FCP',
        value: 5000,
        id: 'test-id',
        delta: 5000,
        navigationType: 'navigate',
        entries: [],
      } as any;

      // @ts-ignore
      service['reportToSentry'](fcpMetric, 'poor');

      // unknown 网络不属于 slow/moderate，应该正常触发告警
      expect(mockSentryLazyLoaderService.captureMessage).toHaveBeenCalledWith(
        '性能告警: FCP 超出阈值',
        expect.objectContaining({
          tags: expect.objectContaining({
            'web-vital': 'FCP',
            'network-quality': 'unknown',
          }),
        })
      );
    });

    it('4G 快速网络下的 poor FCP 应该正常触发告警', () => {
      mockConnection('4g', 10, 50);
      // @ts-ignore
      service['cachedIsSynthetic'] = false;

      const fcpMetric = {
        name: 'FCP',
        value: 5000,
        id: 'test-id',
        delta: 5000,
        navigationType: 'navigate',
        entries: [],
      } as any;

      // @ts-ignore
      service['reportToSentry'](fcpMetric, 'poor');

      expect(mockSentryLazyLoaderService.captureMessage).toHaveBeenCalledWith(
        '性能告警: FCP 超出阈值',
        expect.objectContaining({
          tags: expect.objectContaining({
            'web-vital': 'FCP',
            'network-quality': 'fast',
          }),
        })
      );
    });

    it('INP poor 在慢速网络下应该正常触发告警（非导航时序指标）', () => {
      mockConnection('3g', 1.35, 350);

      const inpMetric = {
        name: 'INP',
        value: 600,
        id: 'test-id',
        delta: 600,
        navigationType: 'navigate',
        entries: [],
      } as any;

      // @ts-ignore
      service['reportToSentry'](inpMetric, 'poor');

      // INP 不是导航时序指标，不受网络过滤
      expect(mockSentryLazyLoaderService.captureMessage).toHaveBeenCalled();
    });
  });
});
