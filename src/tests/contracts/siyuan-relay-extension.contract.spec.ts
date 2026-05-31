import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const relayRoot = path.join(root, 'extensions', 'siyuan-relay');
const manifestPath = path.join(relayRoot, 'manifest.json');

const read = (relativePath: string): string =>
  fs.readFileSync(path.join(root, relativePath), 'utf-8');

interface ExtensionManifest {
  manifest_version?: number;
  background?: {
    service_worker?: string;
  };
  content_scripts?: Array<{
    js?: string[];
    matches?: string[];
  }>;
  options_page?: string;
}

function readManifest(): ExtensionManifest {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as ExtensionManifest;
}

function expectRelayFile(relativePath: string | undefined): void {
  if (!relativePath) {
    throw new Error('manifest must reference a concrete file path');
  }
  expect(fs.existsSync(path.join(relayRoot, relativePath))).toBe(true);
}

describe('SiYuan relay extension contract', () => {
  it('keeps the unpacked extension root loadable by Chrome', () => {
    expect(fs.existsSync(manifestPath)).toBe(true);

    const manifest = readManifest();
    expect(manifest.manifest_version).toBe(3);
    expectRelayFile(manifest.background?.service_worker);
    expectRelayFile(manifest.options_page);

    const contentScripts = manifest.content_scripts ?? [];
    expect(contentScripts.length).toBeGreaterThan(0);
    for (const script of contentScripts) {
      expect(script.js?.length ?? 0).toBeGreaterThan(0);
      for (const jsPath of script.js ?? []) {
        expectRelayFile(jsPath);
      }
    }
  });
});

/**
 * 这些契约用例锁定 SiYuan Relay 扩展静态文件与 NanoFlow 页面侧
 * `SiyuanExtensionProvider` 之间的"消息形状/白名单/origin 约束"约定，
 * 防止其中一侧无声地漂移导致页面填了 baseUrl/token 却不联通到扩展。
 */
describe('SiYuan Relay extension contracts', () => {
  it('content-script whitelists the page→extension message types in lockstep with responseTypeFor', () => {
    const contentScript = read('extensions/siyuan-relay/src/content-script.js');

    expect(contentScript).toMatch(/ALLOWED_MESSAGE_TYPES\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
    const allowedBlock = contentScript.match(/ALLOWED_MESSAGE_TYPES\s*=\s*new Set\(\[([\s\S]*?)\]\)/)![1];
    const allowed = Array.from(allowedBlock.matchAll(/'([^']+)'/g)).map((m) => m[1]).sort();

    expect(allowed).toEqual([
      'nanoflow.siyuan.get-config-status',
      'nanoflow.siyuan.get-preview',
      'nanoflow.siyuan.ping',
      'nanoflow.siyuan.set-config',
      'nanoflow.siyuan.test-connection',
    ]);

    // 每一个 allowed type 都必须能映射到一个 response type
    for (const requestType of allowed) {
      expect(contentScript).toContain(`'${requestType}'`);
    }
    expect(contentScript).toContain("'nanoflow.siyuan.set-config-result'");
    expect(contentScript).toContain("'nanoflow.siyuan.config-status-result'");
  });

  it('background.js handles set-config and get-config-status, but never returns token plaintext', () => {
    const background = read('extensions/siyuan-relay/src/background.js');

    expect(background).toContain("message.type === 'nanoflow.siyuan.set-config'");
    expect(background).toContain("message.type === 'nanoflow.siyuan.get-config-status'");

    // get-config-status 的 data 字段只能包含 baseUrl / hasToken。
    const statusBlock = background.match(/async function getConfigStatus[\s\S]*?\n\}/);
    expect(statusBlock).toBeTruthy();
    const statusSrc = statusBlock![0];
    expect(statusSrc).toContain('hasToken');
    // 不允许在响应里直接写出 token 明文字段
    expect(statusSrc).not.toMatch(/data:\s*\{[^}]*\btoken\s*:/);
  });

  it('background.js validates baseUrl with the same 127.0.0.1/localhost whitelist as the page provider', () => {
    const background = read('extensions/siyuan-relay/src/background.js');
    // 与 src/app/core/external-sources/siyuan/siyuan-direct-provider.ts 的白名单语义一致：
    expect(background).toContain("'http://127.0.0.1:6806'");
    expect(background).toContain("'http://localhost:6806'");
    expect(background).toContain('isTrustedBaseUrl');
    expect(background).toContain("'/api/filetree/getPathByID'");
    expect(background).toContain("'/api/filetree/getHPathByPath'");
    expect(background).toContain('ABSOLUTE_HPATH_FETCH_TIMEOUT_MS');
  });

  it('manifest content_scripts whitelist still covers nanoflow domains and uses an MV3 service worker', () => {
    const manifest = JSON.parse(read('extensions/siyuan-relay/manifest.json')) as {
      manifest_version: number;
      background: { service_worker: string };
      content_scripts: { matches: string[] }[];
    };

    expect(manifest.manifest_version).toBe(3);
    expect(manifest.background.service_worker).toBe('src/background.js');
    const matches = manifest.content_scripts[0]?.matches ?? [];
    expect(matches).toContain('https://nanoflow.app/*');
    expect(matches).toContain('https://nanoflow.pages.dev/*');
  });

  it('page-side SiyuanExtensionProvider speaks the same message types as the extension', () => {
    const provider = read('src/app/core/external-sources/siyuan/siyuan-extension-provider.ts');

    expect(provider).toContain("'nanoflow.siyuan.set-config'");
    expect(provider).toContain("'nanoflow.siyuan.set-config-result'");
    expect(provider).toContain("'nanoflow.siyuan.get-config-status'");
    expect(provider).toContain("'nanoflow.siyuan.config-status-result'");

    // pushConfig 的 payload 只允许包含 baseUrl 和（可选的）token，
    // 防止未来误加字段被 content-script 静默放行后透传给扩展。
    const pushSource = provider.match(/async pushConfig[\s\S]*?\n  \}/);
    expect(pushSource).toBeTruthy();
    expect(pushSource![0]).toMatch(/payload\s*:\s*Record<string,\s*unknown>\s*=\s*\{\s*baseUrl/);
    expect(pushSource![0]).toContain('payload.token = input.token');
  });
});
