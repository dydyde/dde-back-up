import { describe, expect, it, vi } from 'vitest';
import { SiyuanExtensionProvider } from './siyuan-extension-provider';

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
});
