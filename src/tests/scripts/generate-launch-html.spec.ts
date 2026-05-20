import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

const tempRoots: string[] = [];

function writeFile(filepath: string, content: string): void {
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  fs.writeFileSync(filepath, content);
}

function createFixture(): { root: string; distDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-launch-html-'));
  const distDir = path.join(root, 'browser');
  tempRoots.push(root);

  writeFile(
    path.join(distDir, 'index.html'),
    `<!doctype html>
<html>
<head>
  <!-- LAUNCH_SHARED_HEAD_START -->
  <meta charset="utf-8">
  <!-- LAUNCH_SHARED_HEAD_END -->
  <!-- LAUNCH_SHARED_STYLES_START -->
  <style>body{background:#fff;}</style>
  <!-- LAUNCH_SHARED_STYLES_END -->
  <!-- LAUNCH_SHARED_BOOT_FLAGS_START -->
  <script>window.__NANOFLOW_BOOT_FLAGS__ = { STRICT_MODULEPRELOAD_V2: false };</script>
  <!-- LAUNCH_SHARED_BOOT_FLAGS_END -->
</head>
<body>
  <!-- LAUNCH_SHARED_SHELL_START -->
  <div id="loader-spinner"></div>
  <!-- LAUNCH_SHARED_SHELL_END -->
  <!-- LAUNCH_SHARED_SNAPSHOT_RENDERER_START -->
  <script>window.__LAUNCH_ROUTE_RESOLVER__ = true;</script>
  <!-- LAUNCH_SHARED_SNAPSHOT_RENDERER_END -->
  <!-- LAUNCH_SHARED_PREWARM_START -->
  <script>window.__NANOFLOW_SESSION_PREWARM__ = { status: 'idle' };</script>
  <!-- LAUNCH_SHARED_PREWARM_END -->
  <app-root></app-root>
  <!-- LAUNCH_SHARED_LOADER_DISMISS_START -->
  <script>window.addEventListener('nanoflow:boot-stage', function() {});</script>
  <!-- LAUNCH_SHARED_LOADER_DISMISS_END -->
  <script src="polyfills-XYZ999.js" type="module"></script>
  <script src="main-ABC123.js" type="module"></script>
</body>
</html>`,
  );
  writeFile(path.join(root, 'public', 'launch.html'), '<!doctype html><html><head></head><body></body></html>');

  return { root, distDir };
}

describe('generate-launch-html', () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('generates a legacy bootstrap alias from shared index.html blocks', () => {
    const { root, distDir } = createFixture();
    const { generateLaunchHtml } = require('../../../scripts/generate-launch-html.cjs');

    generateLaunchHtml({
      distDir,
      templatePath: path.join(root, 'public', 'launch.html'),
    });

    const launchHtml = fs.readFileSync(path.join(distDir, 'launch.html'), 'utf8');

    expect(launchHtml).toContain('<meta charset="utf-8">');
    expect(launchHtml).toContain('nanoflow-launch-mode');
    expect(launchHtml).toContain('bootstrap-alias');
    expect(launchHtml).toContain('history.replaceState');
    expect(launchHtml).toContain("pathname.endsWith('/launch.html')");
    expect(launchHtml).toContain('__NANOFLOW_BOOT_FLAGS__');
    expect(launchHtml).toContain('__LAUNCH_ROUTE_RESOLVER__');
    expect(launchHtml).toContain('nanoflow:boot-stage');
    expect(launchHtml).toContain('<app-root></app-root>');
    expect(launchHtml).not.toContain('snapshot-shell');
    expect(launchHtml).toContain('polyfills-XYZ999.js');
    expect(launchHtml).toContain('main-ABC123.js');
    expect(launchHtml).not.toContain('location.replace');
    expect(launchHtml).not.toContain('__NANOFLOW_SESSION_PREWARM__');
  });

  it('preserves body classes so launch alias matches index startup chrome', () => {
    const { root, distDir } = createFixture();
    // 覆盖 index.html 使 body 带 Tailwind class
    writeFile(
      path.join(distDir, 'index.html'),
      `<!doctype html>
<html>
<head>
  <!-- LAUNCH_SHARED_HEAD_START -->
  <meta charset="utf-8">
  <!-- LAUNCH_SHARED_HEAD_END -->
</head>
<body class="bg-slate-50 text-slate-900 dark:bg-slate-900 h-screen w-screen overflow-hidden">
  <!-- LAUNCH_SHARED_BOOT_FLAGS_START -->
  <script>window.__FLAGS__ = {};</script>
  <!-- LAUNCH_SHARED_BOOT_FLAGS_END -->
  <!-- LAUNCH_SHARED_SNAPSHOT_RENDERER_START -->
  <!-- LAUNCH_SHARED_SNAPSHOT_RENDERER_END -->
  <!-- LAUNCH_SHARED_LOADER_DISMISS_START -->
  <script>true;</script>
  <!-- LAUNCH_SHARED_LOADER_DISMISS_END -->
  <script src="polyfills-A.js" type="module"></script>
  <script src="main-B.js" type="module"></script>
</body>
</html>`,
    );

    const { generateLaunchHtml } = require('../../../scripts/generate-launch-html.cjs');
    generateLaunchHtml({ distDir, templatePath: path.join(root, 'public', 'launch.html') });
    const launchHtml = fs.readFileSync(path.join(distDir, 'launch.html'), 'utf8');

    expect(launchHtml).toContain('bg-slate-50');
    expect(launchHtml).toContain('overflow-hidden');
    expect(launchHtml).toContain('<body class="bg-slate-50 text-slate-900 dark:bg-slate-900 h-screen w-screen overflow-hidden">');
    expect(launchHtml).not.toContain('id="snapshot-shell"');
  });

  it('throws when entry scripts are missing because launch alias must bootstrap the app directly', () => {
    const { root, distDir } = createFixture();
    // 覆盖 index.html 移除 entry scripts
    writeFile(
      path.join(distDir, 'index.html'),
      `<!doctype html>
<html>
<head>
  <!-- LAUNCH_SHARED_HEAD_START -->
  <meta charset="utf-8">
  <!-- LAUNCH_SHARED_HEAD_END -->
</head>
<body>
  <!-- LAUNCH_SHARED_BOOT_FLAGS_START --><script>window.__FLAGS__ = {};</script><!-- LAUNCH_SHARED_BOOT_FLAGS_END -->
  <!-- LAUNCH_SHARED_SNAPSHOT_RENDERER_START -->
  <!-- LAUNCH_SHARED_SNAPSHOT_RENDERER_END -->
  <!-- LAUNCH_SHARED_LOADER_DISMISS_START --><script>true;</script><!-- LAUNCH_SHARED_LOADER_DISMISS_END -->
</body>
</html>`,
    );

    const { generateLaunchHtml } = require('../../../scripts/generate-launch-html.cjs');
    expect(() =>
      generateLaunchHtml({ distDir, templatePath: path.join(root, 'public', 'launch.html') }),
    ).toThrow('未在 index.html 中找到 main/polyfills 入口脚本，launch.html 无法作为启动别名');
  });
});
