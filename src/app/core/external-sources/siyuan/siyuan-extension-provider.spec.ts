import { describe, expect, it, vi } from 'vitest';
import { SiyuanExtensionProvider } from './siyuan-extension-provider';
import { SiyuanProviderError } from './siyuan-provider.interface';

describe('siyuan-extension-provider', () => {
  it('returns extension-unavailable when ping cannot reach relay', async () => {
    const provider = new SiyuanExtensionProvider();

    const result = await provider.diagnoseConnection();

    expect(result).toEqual({ ok: false, errorCode: 'extension-unavailable' });
  });

  it('maps relay test-connection error codes for diagnostics', async () => {
    const provider = new SiyuanExtensionProvider();
    vi.spyOn(provider as { isTrustedWindowMessage: () => boolean }, 'isTrustedWindowMessage').mockReturnValue(true);
    const postMessageSpy = vi.spyOn(window, 'postMessage').mockImplementation((message: unknown, targetOrigin: string | URL) => {
      if (typeof message !== 'object' || message === null) return;
      const payload = message as { type?: string; requestId?: string };
      if (payload.type === 'nanoflow.siyuan.ping') {
        queueMicrotask(() => {
          window.dispatchEvent(new MessageEvent('message', {
            origin: String(targetOrigin),
            data: { type: 'nanoflow.siyuan.pong', requestId: payload.requestId, ok: true },
          }));
        });
      }
      if (payload.type === 'nanoflow.siyuan.test-connection') {
        queueMicrotask(() => {
          window.dispatchEvent(new MessageEvent('message', {
            origin: String(targetOrigin),
            data: {
              type: 'nanoflow.siyuan.test-connection-result',
              requestId: payload.requestId,
              ok: false,
              errorCode: 'token-invalid',
            },
          }));
        });
      }
    });

    const result = await provider.diagnoseConnection();

    expect(result).toEqual({ ok: false, errorCode: 'token-invalid' });
    postMessageSpy.mockRestore();
  });

  it('pushConfig forwards baseUrl and token to the extension and only includes whitelisted fields', async () => {
    const provider = new SiyuanExtensionProvider();
    vi.spyOn(provider as { pingExtension: () => Promise<boolean> }, 'pingExtension').mockResolvedValue(true);
    const postRelay = vi.spyOn(
      provider as { postRelayRequest: (args: { requestType: string; payload?: Record<string, unknown> }) => Promise<unknown> },
      'postRelayRequest',
    ).mockResolvedValue({ type: 'nanoflow.siyuan.set-config-result', ok: true });

    const result = await provider.pushConfig({ baseUrl: 'http://127.0.0.1:6806', token: 'secret-token' });

    expect(result).toEqual({ ok: true });
    expect(postRelay).toHaveBeenCalledTimes(1);
    const call = postRelay.mock.calls[0][0] as { requestType: string; payload: Record<string, unknown> };
    expect(call.requestType).toBe('nanoflow.siyuan.set-config');
    // payload 只能包含 baseUrl/token，杜绝把额外字段透传到 content-script。
    expect(Object.keys(call.payload).sort()).toEqual(['baseUrl', 'token']);
  });

  it('pushConfig maps token-invalid response', async () => {
    const provider = new SiyuanExtensionProvider();
    vi.spyOn(provider as { pingExtension: () => Promise<boolean> }, 'pingExtension').mockResolvedValue(true);
    vi.spyOn(
      provider as { postRelayRequest: () => Promise<unknown> },
      'postRelayRequest',
    ).mockResolvedValue({ type: 'nanoflow.siyuan.set-config-result', ok: false, errorCode: 'token-invalid' });

    const result = await provider.pushConfig({ baseUrl: 'http://127.0.0.1:6806', token: 'x' });

    expect(result).toEqual({ ok: false, errorCode: 'token-invalid' });
  });

  it('pushConfig returns extension-unavailable when ping fails', async () => {
    const provider = new SiyuanExtensionProvider();
    vi.spyOn(provider as { pingExtension: () => Promise<boolean> }, 'pingExtension').mockResolvedValue(false);

    const result = await provider.pushConfig({ baseUrl: 'http://127.0.0.1:6806', token: 'x' });

    expect(result).toEqual({ ok: false, errorCode: 'extension-unavailable' });
  });

  it('pushConfig omits the token field entirely when caller did not provide one', async () => {
    const provider = new SiyuanExtensionProvider();
    vi.spyOn(provider as { pingExtension: () => Promise<boolean> }, 'pingExtension').mockResolvedValue(true);
    const postRelay = vi.spyOn(
      provider as { postRelayRequest: (args: { payload?: Record<string, unknown> }) => Promise<unknown> },
      'postRelayRequest',
    ).mockResolvedValue({ type: 'nanoflow.siyuan.set-config-result', ok: true });

    await provider.pushConfig({ baseUrl: 'http://127.0.0.1:6806' });

    const payload = (postRelay.mock.calls[0][0] as { payload: Record<string, unknown> }).payload;
    expect(payload).toEqual({ baseUrl: 'http://127.0.0.1:6806' });
    expect(Object.prototype.hasOwnProperty.call(payload, 'token')).toBe(false);
  });

  it('getConfigStatus returns null when the extension does not respond (legacy version)', async () => {
    const provider = new SiyuanExtensionProvider();
    vi.spyOn(provider as { pingExtension: () => Promise<boolean> }, 'pingExtension').mockResolvedValue(true);
    // 旧扩展不识别消息 → postRelayRequest 超时抛 extension-unavailable
    vi.spyOn(
      provider as { postRelayRequest: () => Promise<unknown> },
      'postRelayRequest',
    ).mockRejectedValue(new SiyuanProviderError('extension-unavailable'));

    const status = await provider.getConfigStatus();

    expect(status).toBeNull();
  });

  it('getConfigStatus returns baseUrl and hasToken without leaking token', async () => {
    const provider = new SiyuanExtensionProvider();
    vi.spyOn(provider as { pingExtension: () => Promise<boolean> }, 'pingExtension').mockResolvedValue(true);
    vi.spyOn(
      provider as { postRelayRequest: () => Promise<unknown> },
      'postRelayRequest',
    ).mockResolvedValue({
      type: 'nanoflow.siyuan.config-status-result',
      ok: true,
      data: { baseUrl: 'http://127.0.0.1:6806', hasToken: true },
    });

    const status = await provider.getConfigStatus();

    expect(status).toEqual({ baseUrl: 'http://127.0.0.1:6806', hasToken: true });
    // 类型层面已经禁止 token 字段返回，但运行时也回归一次。
    expect(status && Object.prototype.hasOwnProperty.call(status, 'token')).toBeFalsy();
  });

  it('getConfigStatus returns null when extension ping fails (uninstalled)', async () => {
    const provider = new SiyuanExtensionProvider();
    vi.spyOn(provider as { pingExtension: () => Promise<boolean> }, 'pingExtension').mockResolvedValue(false);

    const status = await provider.getConfigStatus();

    expect(status).toBeNull();
  });
});
