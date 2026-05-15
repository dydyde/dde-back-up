const DEFAULT_BASE_URL = 'http://127.0.0.1:6806';
const PREVIEW_FETCH_TIMEOUT_MS = 5000;
const MAX_PREVIEW_CHILDREN = 10;
const MAX_PREVIEW_CHARS = 1200;
const MAX_TOKEN_LENGTH = 256;
const BLOCK_ID_PATTERN = /^\d{14}-[a-z0-9]{7}$/;
const SIYUAN_BLOCK_REF_PATTERN = /\(\((\d{14}-[a-z0-9]{7})(?:\s+"([^"]*)")?\)\)/g;
const ALLOWED_API_PATHS = new Set([
  '/api/system/version',
  '/api/block/getBlockKramdown',
  '/api/block/getChildBlocks',
  '/api/filetree/getHPathByID',
  '/api/attr/getBlockAttrs',
]);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void handleMessage(message).then(sendResponse);
  return true;
});

async function handleMessage(message) {
  if (!message || typeof message !== 'object') return buildPreviewError(message, 'unknown');
  if (message.type === 'nanoflow.siyuan.ping') {
    return { type: 'nanoflow.siyuan.pong', requestId: readRequestId(message), ok: true };
  }
  if (message.type === 'nanoflow.siyuan.test-connection') {
    return testConnection(message);
  }
  if (message.type === 'nanoflow.siyuan.get-preview') {
    return getPreview(message);
  }
  if (message.type === 'nanoflow.siyuan.set-config') {
    return setConfig(message);
  }
  if (message.type === 'nanoflow.siyuan.get-config-status') {
    return getConfigStatus(message);
  }
  return buildPreviewError(message, 'unknown');
}

async function setConfig(message) {
  const requestId = readRequestId(message);
  const payload = message?.payload;
  // 仅允许 payload 中出现 baseUrl/token 两个键，拒绝任何额外字段以收敛 attack surface。
  if (!payload || typeof payload !== 'object') {
    return { type: 'nanoflow.siyuan.set-config-result', requestId, ok: false, errorCode: 'unknown' };
  }
  const rawBaseUrl = typeof payload.baseUrl === 'string' ? payload.baseUrl.trim() : '';
  const baseUrl = rawBaseUrl || DEFAULT_BASE_URL;
  if (!isTrustedBaseUrl(baseUrl)) {
    // 复用 token-invalid 而非新增错误码：UI 在 saveSiyuanConfigToExtension 中已用同一份白名单校验过 baseUrl，
    // 走到这里说明页面被绕过（被注入脚本或调试器），此时把请求统一拒绝即可；下游 UI 的提示文案虽然偏向 token，
    // 但用户最终修复路径仍是"改 baseUrl 或 token 后重新保存"。
    return { type: 'nanoflow.siyuan.set-config-result', requestId, ok: false, errorCode: 'token-invalid' };
  }
  // 空字符串视为"清除授权"，与扩展 Options 页 clearConfig 行为一致。
  const hasTokenField = Object.prototype.hasOwnProperty.call(payload, 'token');
  const rawToken = hasTokenField && typeof payload.token === 'string' ? payload.token : undefined;
  if (rawToken !== undefined && rawToken.length > MAX_TOKEN_LENGTH) {
    return { type: 'nanoflow.siyuan.set-config-result', requestId, ok: false, errorCode: 'token-invalid' };
  }
  try {
    await chrome.storage.local.set({ baseUrl });
    if (hasTokenField) {
      if (rawToken && rawToken.length > 0) {
        await chrome.storage.local.set({ token: rawToken });
      } else {
        await chrome.storage.local.remove(['token']);
      }
    }
    return { type: 'nanoflow.siyuan.set-config-result', requestId, ok: true };
  } catch {
    return { type: 'nanoflow.siyuan.set-config-result', requestId, ok: false, errorCode: 'unknown' };
  }
}

async function getConfigStatus(message) {
  const requestId = readRequestId(message);
  try {
    const stored = await chrome.storage.local.get(['baseUrl', 'token']);
    const baseUrl = typeof stored.baseUrl === 'string' && isTrustedBaseUrl(stored.baseUrl)
      ? stored.baseUrl
      : DEFAULT_BASE_URL;
    const hasToken = typeof stored.token === 'string' && stored.token.length > 0;
    // 仅回传 baseUrl 与 hasToken，绝不把 token 明文经 message channel 返回页面。
    return {
      type: 'nanoflow.siyuan.config-status-result',
      requestId,
      ok: true,
      data: { baseUrl, hasToken },
    };
  } catch {
    return { type: 'nanoflow.siyuan.config-status-result', requestId, ok: false, errorCode: 'unknown' };
  }
}

async function testConnection(message) {
  try {
    const config = await loadConfig();
    await callSiyuan(config, '/api/system/version', {});
    return { type: 'nanoflow.siyuan.test-connection-result', requestId: readRequestId(message), ok: true };
  } catch (error) {
    return {
      type: 'nanoflow.siyuan.test-connection-result',
      requestId: readRequestId(message),
      ok: false,
      errorCode: mapError(error),
    };
  }
}

async function getPreview(message) {
  const requestId = readRequestId(message);
  const blockId = message?.payload?.blockId;
  if (typeof blockId !== 'string' || !BLOCK_ID_PATTERN.test(blockId)) {
    return buildPreviewError(message, 'block-not-found');
  }

  const includeChildren = message.payload.includeChildren !== false;
  const maxChildren = clampInteger(message.payload.maxChildren, 0, MAX_PREVIEW_CHILDREN);
  const maxChars = clampInteger(message.payload.maxChars, 1, MAX_PREVIEW_CHARS);

  try {
    const config = await loadConfig();
    const [kramdown, hpath, attrs, children] = await Promise.all([
      callSiyuan(config, '/api/block/getBlockKramdown', { id: blockId }),
      callSiyuan(config, '/api/filetree/getHPathByID', { id: blockId }).catch(() => undefined),
      callSiyuan(config, '/api/attr/getBlockAttrs', { id: blockId }).catch(() => undefined),
      includeChildren
        ? callSiyuan(config, '/api/block/getChildBlocks', { id: blockId }).catch(() => [])
        : Promise.resolve([]),
    ]);

    if (!kramdown || typeof kramdown !== 'object') throw new RelayError('block-not-found');
    if (typeof kramdown.id === 'string' && kramdown.id !== blockId) throw new RelayError('block-not-found');
    const childBlocks = await buildChildBlocks(config, children, maxChildren);
    const plainText = toPlainText(typeof kramdown.kramdown === 'string' ? kramdown.kramdown : '');
    const truncatedText = plainText.length > maxChars ? `${plainText.slice(0, maxChars).trim()}…` : plainText;

    return {
      type: 'nanoflow.siyuan.preview-result',
      requestId,
      ok: true,
      data: {
        blockId,
        hpath: readHPath(hpath),
        plainText: truncatedText,
        kramdown: truncateString(kramdown.kramdown, maxChars * 2),
        sourceUpdatedAt: readSourceUpdatedAt(attrs),
        childBlocks,
        truncated: plainText.length > maxChars || childBlocks.length >= maxChildren,
      },
    };
  } catch (error) {
    return buildPreviewError(message, mapError(error));
  }
}

async function loadConfig() {
  const config = await chrome.storage.local.get(['baseUrl', 'token']);
  const baseUrl = typeof config.baseUrl === 'string' && isTrustedBaseUrl(config.baseUrl)
    ? config.baseUrl
    : DEFAULT_BASE_URL;
  const token = typeof config.token === 'string' ? config.token : '';
  if (!token) throw new RelayError('not-configured');
  return { baseUrl, token };
}

function isTrustedBaseUrl(value) {
  try {
    const url = new URL(value);
    return (url.origin === 'http://127.0.0.1:6806' || url.origin === 'http://localhost:6806')
      && url.pathname === '/'
      && !url.search
      && !url.hash
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
}

async function callSiyuan(config, path, body) {
  if (!ALLOWED_API_PATHS.has(path)) throw new RelayError('unknown');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PREVIEW_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(new URL(path, config.baseUrl).toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Token ${config.token}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) throw new RelayError('token-invalid');
    if (!response.ok) throw new RelayError('kernel-unreachable');
    const json = await response.json();
    if (json?.code && json.code !== 0) throw new RelayError(mapSiyuanCode(json.msg));
    return json?.data;
  } catch (error) {
    if (error instanceof RelayError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') throw new RelayError('kernel-unreachable');
    throw new RelayError('kernel-unreachable');
  } finally {
    clearTimeout(timer);
  }
}

async function buildChildBlocks(config, rawChildren, maxChildren) {
  if (!Array.isArray(rawChildren) || maxChildren <= 0) return [];
  const children = rawChildren
    .filter((child) => typeof child?.id === 'string' && BLOCK_ID_PATTERN.test(child.id))
    .slice(0, maxChildren);
  return Promise.all(children.map(async (child) => {
    const content = typeof child.content === 'string' || typeof child.markdown === 'string'
      ? child.content ?? child.markdown
      : await callSiyuan(config, '/api/block/getBlockKramdown', { id: child.id })
        .then((data) => typeof data?.kramdown === 'string' ? data.kramdown : '')
        .catch(() => '');
    return {
      id: child.id,
      type: typeof child.type === 'string' ? truncateString(child.type, 32) : 'unknown',
      content: truncateString(toPlainText(content), 240),
    };
  }));
}

function readHPath(value) {
  if (typeof value === 'string') return truncateString(value, 1024);
  if (typeof value?.hPath === 'string') return truncateString(value.hPath, 1024);
  return undefined;
}

function readSourceUpdatedAt(value) {
  if (typeof value?.updatedAt === 'string') return truncateString(value.updatedAt, 64);
  if (typeof value?.updated === 'string') return truncateString(value.updated, 64);
  return undefined;
}

function toPlainText(kramdown) {
  return String(kramdown)
    .replace(/\{:\s*[^}]+\}/g, '')
    .replace(SIYUAN_BLOCK_REF_PATTERN, (_match, blockId, label) => label || blockId)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '[图片]')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_>#\-[\]()]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateString(value, maxLength) {
  if (typeof value !== 'string') return undefined;
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function clampInteger(value, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number)) return max;
  return Math.max(min, Math.min(number, max));
}

function readRequestId(message) {
  return typeof message?.requestId === 'string' ? message.requestId : crypto.randomUUID();
}

function buildPreviewError(message, errorCode) {
  return {
    type: 'nanoflow.siyuan.preview-result',
    requestId: readRequestId(message),
    ok: false,
    errorCode,
  };
}

function mapSiyuanCode(message) {
  const value = String(message ?? '').toLowerCase();
  if (value.includes('token') || value.includes('unauthorized')) return 'token-invalid';
  if (value.includes('not found') || value.includes('不存在')) return 'block-not-found';
  return 'unknown';
}

function mapError(error) {
  if (error instanceof RelayError) return error.code;
  return 'unknown';
}

class RelayError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
