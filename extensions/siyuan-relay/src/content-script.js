const BUILTIN_ALLOWED_ORIGINS = new Set([
  'https://nanoflow.app',
  'https://www.nanoflow.app',
  'https://nanoflow.pages.dev',
  'https://dde-eight.vercel.app',
]);

const ALLOWED_MESSAGE_TYPES = new Set([
  'nanoflow.siyuan.ping',
  'nanoflow.siyuan.get-preview',
  'nanoflow.siyuan.test-connection',
]);

function isAllowedOrigin(origin) {
  try {
    const url = new URL(origin);
    if (BUILTIN_ALLOWED_ORIGINS.has(url.origin)) return true;
    return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

function responseTypeFor(messageType) {
  if (messageType === 'nanoflow.siyuan.ping') return 'nanoflow.siyuan.pong';
  if (messageType === 'nanoflow.siyuan.test-connection') return 'nanoflow.siyuan.test-connection-result';
  return 'nanoflow.siyuan.preview-result';
}

function buildErrorResponse(message, errorCode = 'unknown') {
  return {
    type: responseTypeFor(message?.type),
    requestId: typeof message?.requestId === 'string' ? message.requestId : '',
    ok: false,
    errorCode,
  };
}

window.addEventListener('message', (event) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  if (!isAllowedOrigin(event.origin)) return;
  const message = event.data;
  if (!message || typeof message !== 'object' || !ALLOWED_MESSAGE_TYPES.has(message.type)) return;

  chrome.runtime.sendMessage(message, (response) => {
    if (chrome.runtime.lastError) {
      window.postMessage(buildErrorResponse(message, 'extension-unavailable'), event.origin);
      return;
    }
    window.postMessage(response ?? buildErrorResponse(message), event.origin);
  });
});
