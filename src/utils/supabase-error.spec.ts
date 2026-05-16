/**
 * Supabase 错误处理工具测试
 */
import { describe, it, expect } from 'vitest';
import { createBrowserNetworkSuspendedError } from './browser-network-suspension';
import { 
  supabaseErrorToError, 
  isRetryableError, 
  getFriendlyErrorMessage 
} from './supabase-error';

describe('supabase-error', () => {
  describe('supabaseErrorToError', () => {
    it('应该识别 504 Gateway Timeout 错误', () => {
      const error = { code: 504, message: 'Gateway timeout' };
      const result = supabaseErrorToError(error);
      
      expect(result.name).toBe('NetworkTimeoutError');
      expect(result.message).toContain('504 Gateway Timeout');
      expect(result.isRetryable).toBe(true);
      expect(result.errorType).toBe('NetworkTimeoutError');
    });
    
    it('应该识别只有 code 的 504 错误（无 message）', () => {
      const error = { code: 504 };
      const result = supabaseErrorToError(error);
      
      expect(result.name).toBe('NetworkTimeoutError');
      expect(result.message).toContain('504 Gateway Timeout');
      expect(result.isRetryable).toBe(true);
      expect(result.errorType).toBe('NetworkTimeoutError');
    });
    
    it('应该识别 503 Service Unavailable 错误', () => {
      const error = { code: 503, message: 'Service unavailable' };
      const result = supabaseErrorToError(error);
      
      expect(result.name).toBe('ServiceUnavailableError');
      expect(result.message).toContain('503 Service Unavailable');
      expect(result.isRetryable).toBe(true);
    });
    
    it('应该识别 502 Bad Gateway 错误', () => {
      const error = { code: 502, message: 'Bad gateway' };
      const result = supabaseErrorToError(error);
      
      expect(result.name).toBe('GatewayError');
      expect(result.message).toContain('502 Bad Gateway');
      expect(result.isRetryable).toBe(true);
    });
    
    it('应该识别 408 Request Timeout 错误', () => {
      const error = { code: 408, message: 'Request timeout' };
      const result = supabaseErrorToError(error);
      
      expect(result.name).toBe('RequestTimeoutError');
      expect(result.message).toContain('408 Request Timeout');
      expect(result.isRetryable).toBe(true);
    });
    
    it('应该识别 429 Rate Limit 错误（可重试）', () => {
      const error = { code: 429, message: 'Too many requests' };
      const result = supabaseErrorToError(error);
      
      expect(result.name).toBe('RateLimitError');
      expect(result.message).toContain('429 Too Many Requests');
      expect(result.isRetryable).toBe(true); // 速率限制应该重试
    });
    
    it('应该识别 401 Unauthorized 错误', () => {
      const error = { code: 401, message: 'Unauthorized' };
      const result = supabaseErrorToError(error);
      
      expect(result.name).toBe('AuthError');
      expect(result.message).toContain('401 Unauthorized');
      expect(result.isRetryable).toBe(false);
    });
    
    it('应该从消息内容识别 timeout 关键词', () => {
      const error = { message: 'Connection timed out' };
      const result = supabaseErrorToError(error);
      
      expect(result.name).toBe('TimeoutError');
      expect(result.isRetryable).toBe(true);
    });
    
    it('应该从消息内容识别 network 关键词', () => {
      const error = { message: 'Network request failed' };
      const result = supabaseErrorToError(error);
      
      expect(result.name).toBe('NetworkError');
      expect(result.isRetryable).toBe(true);
    });
    
    it('应该从消息内容识别 offline 关键词', () => {
      const error = { message: 'You are offline' };
      const result = supabaseErrorToError(error);
      
      expect(result.name).toBe('OfflineError');
      expect(result.isRetryable).toBe(true);
    });
    
    it('应该处理已经是 Error 实例的情况', () => {
      const error = new Error('Test error');
      const result = supabaseErrorToError(error);
      
      // 【P2-10 修复】不再直接修改原对象，而是返回 Object.create(error)
      expect(result.message).toBe(error.message);
      expect(result.isRetryable).toBeDefined();
      expect(result.errorType).toBeDefined();
    });
    
    it('应该识别 Error 实例中的 "Failed to fetch" 错误', () => {
      const error = new Error('TypeError: Failed to fetch');
      const result = supabaseErrorToError(error);
      
      expect(result.errorType).toBe('NetworkError');
      expect(result.isRetryable).toBe(true);
    });
    
    it('应该识别 Error 实例中的 "Network error" 错误', () => {
      const error = new Error('Network error occurred');
      const result = supabaseErrorToError(error);
      
      expect(result.errorType).toBe('NetworkError');
      expect(result.isRetryable).toBe(true);
    });
    
    it('应该识别 Error 实例中的 timeout 错误', () => {
      const error = new Error('Request timed out');
      const result = supabaseErrorToError(error);
      
      expect(result.errorType).toBe('TimeoutError');
      expect(result.isRetryable).toBe(true);
    });

    it('应该识别 Error 实例中的中文「超时」错误（RequestThrottle 历史错误兜底）', () => {
      // 【2026-05-16 根因修复回归】
      // RequestThrottleService.withTimeout 历史上抛 message 为
      // '请求超时 (30000ms): push-connection:xxx' 的裸 Error。即便已在源头修复
      // name='TimeoutError'，此处的中文 message 识别仍是其他中文超时错误源
      // （auth.service / unsaved-changes.guard / modal-loader 等）的兜底。
      const error = new Error('请求超时 (30000ms): push-connection:abc');
      const result = supabaseErrorToError(error);

      expect(result.errorType).toBe('TimeoutError');
      expect(result.isRetryable).toBe(true);
    });

    it('应该把 name=TimeoutError 的 Error 识别为可重试（throttle 根因修复路径）', () => {
      // RequestThrottle 修复后抛的真实形态：name='TimeoutError' + 中文 message。
      // 必须命中 RETRYABLE_ERROR_TYPES，让 ConnectionSyncOps/TaskSyncOps 把它
      // 入 RetryQueue 而非走 "不可重试的错误，不加入重试队列" 分支。
      const error = new Error('请求超时 (30000ms): push-connection:abc');
      error.name = 'TimeoutError';
      const result = supabaseErrorToError(error);

      expect(result.errorType).toBe('TimeoutError');
      expect(result.isRetryable).toBe(true);
    });
    
    it('应该识别 Error 实例中的 "Unknown Supabase error"（504 回退场景）', () => {
      // 【关键测试】Supabase 客户端在无法解析 504 Gateway Timeout 等非 JSON 响应时
      // 会抛出 new Error('Unknown Supabase error')，而非普通对象
      // 这是 Sentry 报告中 isRetryable: false 的根本原因
      const error = new Error('Unknown Supabase error');
      const result = supabaseErrorToError(error);
      
      expect(result.name).toBe('UnknownServerError');
      expect(result.errorType).toBe('UnknownServerError');
      expect(result.isRetryable).toBe(true);
    });

    it('应该将浏览器网络挂起错误识别为可重试的延后状态', () => {
      const result = supabaseErrorToError(createBrowserNetworkSuspendedError());

      expect(result.name).toBe('BrowserNetworkSuspendedError');
      expect(result.errorType).toBe('BrowserNetworkSuspendedError');
      expect(result.isRetryable).toBe(true);
    });
    
    it('应该识别 Error 实例中的 "unknown error" 变体', () => {
      const error = new Error('Some unknown error occurred');
      const result = supabaseErrorToError(error);
      
      expect(result.name).toBe('UnknownServerError');
      expect(result.errorType).toBe('UnknownServerError');
      expect(result.isRetryable).toBe(true);
    });
    
    it('应该处理空对象错误（无 message）', () => {
      const error = {};
      const result = supabaseErrorToError(error);
      
      // 空对象最终会使用默认消息 "Unknown Supabase error"
      // 这会被识别为 UnknownServerError（可重试）
      expect(result.message).toContain('服务器响应异常');
      expect(result.name).toBe('UnknownServerError');
      expect(result.isRetryable).toBe(true);
    });
    
    it('应该将 "Unknown Supabase error" 识别为可重试的服务端错误', () => {
      // Supabase 客户端在无法解析 504 等响应时返回此消息
      const error = { message: 'Unknown Supabase error' };
      const result = supabaseErrorToError(error);
      
      expect(result.name).toBe('UnknownServerError');
      expect(result.message).toContain('服务器响应异常');
      expect(result.isRetryable).toBe(true);
      expect(result.errorType).toBe('UnknownServerError');
    });
    
    it('应该将 "unknown error" 变体识别为可重试的服务端错误', () => {
      const error = { message: 'Some unknown error occurred' };
      const result = supabaseErrorToError(error);
      
      expect(result.name).toBe('UnknownServerError');
      expect(result.isRetryable).toBe(true);
    });
    
    it('应该保留原始错误的 code, details, hint', () => {
      const error = {
        code: '42P01',
        message: 'Table not found',
        details: 'relation "tasks" does not exist',
        hint: 'Run migrations'
      };
      const result = supabaseErrorToError(error);
      
      expect(result.code).toBe('42P01');
      expect(result.details).toBe('relation "tasks" does not exist');
      expect(result.hint).toBe('Run migrations');
    });
    
    it('应该支持字符串形式的状态码', () => {
      const error = { code: '504', message: 'Gateway timeout' };
      const result = supabaseErrorToError(error);
      
      expect(result.name).toBe('NetworkTimeoutError');
      expect(result.isRetryable).toBe(true);
    });

    it('应该识别外键约束错误（23503）', () => {
      const error = { code: '23503', message: 'foreign_key_violation' };
      const result = supabaseErrorToError(error);
      
      expect(result.errorType).toBe('ForeignKeyError');
      expect(result.isRetryable).toBe(false);
    });

    it('应该识别版本冲突错误（P0001 + version regression）', () => {
      const error = { 
        code: 'P0001', 
        message: 'Version regression not allowed: 5471 -> 5467 (table: projects, id: xxx)' 
      };
      const result = supabaseErrorToError(error);
      
      expect(result.errorType).toBe('VersionConflictError');
      expect(result.isRetryable).toBe(false);
      expect(result.message).toContain('版本冲突');
    });

    it('应该识别任务验证错误（P0001 + task validation）', () => {
      const error = { 
        code: 'P0001', 
        message: 'Task must have either title or content (task_id: 58911898-4099-43c4-8d9f-d45bf5ff7a28)' 
      };
      const result = supabaseErrorToError(error);
      
      expect(result.errorType).toBe('ValidationError');
      expect(result.isRetryable).toBe(false);
      // 应该保留原始消息
      expect(result.message).toContain('Task must have either title or content');
    });

    it('应该识别其他数据验证错误（P0001 + invalid stage）', () => {
      const error = { 
        code: 'P0001', 
        message: 'Invalid stage value: -1 (must be >= 0)' 
      };
      const result = supabaseErrorToError(error);
      
      expect(result.errorType).toBe('ValidationError');
      expect(result.isRetryable).toBe(false);
      expect(result.message).toContain('Invalid stage value');
    });

    it('应该将其他 P0001 错误归类为 BusinessRuleError', () => {
      const error = { 
        code: 'P0001', 
        message: 'Custom business rule violation' 
      };
      const result = supabaseErrorToError(error);
      
      expect(result.errorType).toBe('BusinessRuleError');
      expect(result.isRetryable).toBe(false);
    });
  });
  
  describe('isRetryableError', () => {
    it('应该正确判断可重试错误', () => {
      expect(isRetryableError({ code: 504 })).toBe(true);
      expect(isRetryableError({ code: 503 })).toBe(true);
      expect(isRetryableError({ code: 502 })).toBe(true);
      expect(isRetryableError({ code: 429 })).toBe(true); // 速率限制错误应该重试
      expect(isRetryableError({ message: 'timeout' })).toBe(true);
      expect(isRetryableError({ message: 'network error' })).toBe(true);
      expect(isRetryableError(createBrowserNetworkSuspendedError())).toBe(true);
    });
    
    it('应该正确判断不可重试错误', () => {
      expect(isRetryableError({ code: 401 })).toBe(false);
      expect(isRetryableError({ code: 403 })).toBe(false);
      expect(isRetryableError({ message: 'Invalid input' })).toBe(false);
    });
    
    it('应该处理 null 和 undefined', () => {
      expect(isRetryableError(null)).toBe(false);
      expect(isRetryableError(undefined)).toBe(false);
    });
  });
  
  describe('getFriendlyErrorMessage', () => {
    it('应该为可重试错误提供友好提示', () => {
      expect(getFriendlyErrorMessage({ code: 504 })).toContain('网络响应超时');
      expect(getFriendlyErrorMessage({ code: 503 })).toContain('服务暂时不可用');
      expect(getFriendlyErrorMessage({ code: 502 })).toContain('网关错误');
      expect(getFriendlyErrorMessage({ message: 'timeout' })).toContain('网络响应超时');
      expect(getFriendlyErrorMessage({ message: 'offline' })).toContain('离线');
      expect(getFriendlyErrorMessage(createBrowserNetworkSuspendedError())).toContain('浏览器恢复连接中');
    });
    
    it('应该为 Unknown Supabase error 提供友好提示', () => {
      // 模拟 504 返回非 JSON 响应时 Supabase 客户端的回退错误
      const error = { message: 'Unknown Supabase error' };
      const result = getFriendlyErrorMessage(error);
      
      expect(result).toContain('服务器响应异常');
    });
    
    it('应该为不可重试错误返回详细消息', () => {
      const error = { code: 401, message: 'Unauthorized access' };
      const result = getFriendlyErrorMessage(error);
      
      // 应该返回错误的实际消息
      expect(result).toBeTruthy();
    });
  });
});
