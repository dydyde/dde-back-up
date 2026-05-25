import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const normalizeTemplateLiteralSource = (value: string | undefined): string | undefined =>
  value?.trim().replace(/\\\$\{/g, '${');

describe('startup launch contract', () => {
  it('app tsconfig should not inherit root test/build tool entries into Angular production compilation', () => {
    const tsconfigPath = path.join(process.cwd(), 'tsconfig.app.json');
    const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, 'utf8')) as {
      include?: string[];
      files?: string[];
    };

    expect(tsconfig.files).toContain('./main.ts');
    expect(tsconfig.include).toEqual([]);
  });

  it('Angular control-flow aliases should stay on primary @if blocks', () => {
    const files = [
      'src/app/shared/components/knowledge-anchor/knowledge-anchor.component.ts',
      'src/app/shared/components/knowledge-anchor/knowledge-anchor-popover.component.ts',
    ];

    for (const file of files) {
      const source = fs.readFileSync(path.join(process.cwd(), file), 'utf8');
      expect(source).not.toMatch(/@else\s+if\s*\([\s\S]*?;\s*as\s+\w+[\s\S]*?\)/);
    }
  });

  it('ngsw-config app-core resources should explicitly cache polyfills entry chunks', () => {
    const ngswConfigPath = path.join(process.cwd(), 'ngsw-config.json');
    const ngswConfig = JSON.parse(fs.readFileSync(ngswConfigPath, 'utf8'));
    const appCore = ngswConfig.assetGroups.find((group: { name: string }) => group.name === 'app-core');

    expect(appCore?.resources?.files).toContain('/polyfills*.js');
  });

  it('ngsw-config app-core resources should keep launch.html for legacy installed shortcuts', () => {
    const ngswConfigPath = path.join(process.cwd(), 'ngsw-config.json');
    const ngswConfig = JSON.parse(fs.readFileSync(ngswConfigPath, 'utf8'));
    const appCore = ngswConfig.assetGroups.find((group: { name: string }) => group.name === 'app-core');

    expect(appCore?.resources?.files).toContain('/launch.html');
  });

  it('ngsw-config should not proxy Supabase REST and RPC requests through dataGroups', () => {
    const ngswConfigPath = path.join(process.cwd(), 'ngsw-config.json');
    const ngswConfig = JSON.parse(fs.readFileSync(ngswConfigPath, 'utf8'));
    const dataGroups = Array.isArray(ngswConfig.dataGroups) ? ngswConfig.dataGroups : [];
    const urls = dataGroups.flatMap((group: { urls?: string[] }) => group.urls ?? []);

    expect(urls).not.toContain('https://*.supabase.co/rest/v1/*');
    expect(urls).not.toContain('https://*.supabase.co/rest/v1/rpc/*');
    expect(urls).not.toContain('https://*.supabase.co/rpc/v1/*');
  });

  it('manifest start_url should point to root startup path instead of launch.html', () => {
    const manifestPath = path.join(process.cwd(), 'public', 'manifest.webmanifest');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    expect(manifest.start_url).toBe('./');
  });

  it('manifest should pin app identity to the historical launch.html install id', () => {
    const manifestPath = path.join(process.cwd(), 'public', 'manifest.webmanifest');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    expect(manifest.id).toBe('/launch.html');
  });

  it('manifest should focus an existing standalone client on launcher open', () => {
    const manifestPath = path.join(process.cwd(), 'public', 'manifest.webmanifest');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    expect(manifest.launch_handler).toEqual({ client_mode: 'focus-existing' });
  });

  it('Android TWA launcher should reuse the existing task on warm app-icon opens', () => {
    const manifestPath = path.join(process.cwd(), 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
    const manifest = fs.readFileSync(manifestPath, 'utf8');
    const activityMatch = manifest.match(/<activity\s+[^>]*android:name="app\.nanoflow\.host\.NanoflowTwaLauncherActivity"[\s\S]*?<intent-filter>/);

    expect(activityMatch?.[0]).toContain('android:alwaysRetainTaskState="true"');
    expect(manifest).toContain('android.support.customtabs.trusted.LAUNCH_HANDLER_CLIENT_MODE');
    expect(manifest).toContain('android:value="focus-existing"');
    expect(activityMatch?.[0]).not.toContain('android:launchMode="singleTask"');
    expect(activityMatch?.[0]).not.toContain('android:taskAffinity=""');
    expect(activityMatch?.[0]).not.toContain('android:finishOnTaskLaunch="true"');
    expect(activityMatch?.[0]).not.toContain('android:excludeFromRecents="true"');
  });

  it('manifest launch colors should match native TWA and web loader background', () => {
    const twaLaunchBackground = '#F9F8F6';
    const manifestPath = path.join(process.cwd(), 'public', 'manifest.webmanifest');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      theme_color?: string;
      background_color?: string;
    };

    expect(manifest.theme_color).toBe(twaLaunchBackground);
    expect(manifest.background_color).toBe(twaLaunchBackground);

    const androidColorsPath = path.join(
      process.cwd(),
      'android',
      'app',
      'src',
      'main',
      'res',
      'values',
      'colors.xml',
    );
    const androidColors = fs.readFileSync(androidColorsPath, 'utf8');
    expect(androidColors).toContain(
      `<color name="nanoflow_twa_launch_background">${twaLaunchBackground}</color>`,
    );

    const indexHtml = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');
    expect(indexHtml).toContain(`--loader-bg: ${twaLaunchBackground};`);
  });

  it('index startup should not render launch snapshot as a blocking preview shell', () => {
    const indexHtml = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');

    expect(indexHtml).not.toContain('loader.snapshot_visible');
    expect(indexHtml).not.toContain('snapshot-task-list');
    expect(indexHtml).not.toContain('id="snapshot-shell"');
    expect(indexHtml).toContain('不渲染静态预览');
  });

  it('manifest should expose the approved static shortcut intents', () => {
    const manifestPath = path.join(process.cwd(), 'public', 'manifest.webmanifest');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    expect(manifest.shortcuts).toEqual([
      expect.objectContaining({
        url: './#/projects?entry=shortcut&intent=open-workspace',
      }),
      expect.objectContaining({
        url: './#/projects?entry=shortcut&intent=open-focus-tools',
      }),
      expect.objectContaining({
        url: './#/projects?entry=shortcut&intent=open-blackbox-recorder',
      }),
    ]);
  });

  it('manifest should no longer expose desktop widget definitions', () => {
    const manifestPath = path.join(process.cwd(), 'public', 'manifest.webmanifest');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    expect(manifest.widgets).toBeUndefined();
  });

  it('main bootstrap should keep the legacy-compatible composed service worker entry', () => {
    const mainPath = path.join(process.cwd(), 'main.ts');
    const mainSource = fs.readFileSync(mainPath, 'utf8');

    expect(mainSource).toContain("provideServiceWorker('sw-composed.js'");
  });

  it('main bootstrap should suppress browser-network-suspended unhandled rejection noise', () => {
    const mainPath = path.join(process.cwd(), 'main.ts');
    const mainSource = fs.readFileSync(mainPath, 'utf8');

    expect(mainSource).toContain('isBrowserNetworkSuspendedReason(reason)');
    expect(mainSource).toContain('event.preventDefault();');
    expect(mainSource).toContain('BrowserNetworkSuspendedError');
    expect(mainSource).toContain('network IO suspended');
  });

  it('legacy sw-composed compatibility entry should keep the retirement shim but not the old desktop runtime', () => {
    const composedSwPath = path.join(process.cwd(), 'public', 'sw-composed.js');
    const composedSwSource = fs.readFileSync(composedSwPath, 'utf8');

    expect(composedSwSource).toContain("importScripts('./ngsw-worker.js');");
    expect(composedSwSource).toContain('桌面端小组件已停用');
    expect(composedSwSource).toContain('nanoflow-focus-summary');
    expect(composedSwSource).not.toContain('widget-runtime');
    expect(composedSwSource).not.toContain('widget-summary');
  });

  it('build scripts should no longer invoke desktop widget manifest preparation', () => {
    const packageJsonPath = path.join(process.cwd(), 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
      scripts?: Record<string, string>;
    };

    const buildScripts = Object.entries(packageJson.scripts ?? {})
      .filter(([name]) => name.startsWith('build'))
      .map(([, command]) => command);

    expect(buildScripts.some((command) => command.includes('prepare-manifest-widgets'))).toBe(false);
  });

  it('should keep static tombstone assets for retired desktop widget hosts', () => {
    const templatePath = path.join(process.cwd(), 'public', 'widgets', 'templates', 'focus-summary.json');
    const dataPath = path.join(process.cwd(), 'public', 'widgets', 'templates', 'focus-data.json');

    const template = JSON.parse(fs.readFileSync(templatePath, 'utf8')) as { body?: Array<{ text?: string }> };
    const data = JSON.parse(fs.readFileSync(dataPath, 'utf8')) as { message?: string; detail?: string };

    expect(Array.isArray(template.body)).toBe(true);
    expect(data.message).toContain('桌面端小组件已停用');
    expect(data.detail).toContain('Android 手机端小组件');
  });

  it('deployment configs should keep the retirement compatibility assets uncached', () => {
    const vercelConfig = fs.readFileSync(path.join(process.cwd(), 'vercel.json'), 'utf8');
    const netlifyConfig = fs.readFileSync(path.join(process.cwd(), 'netlify.toml'), 'utf8');

    expect(vercelConfig).toContain('"source": "/ngsw-worker.js"');
    expect(vercelConfig).toContain('"source": "/sw-composed.js"');
    expect(vercelConfig).toContain('"source": "/widgets/templates/(.*)"');
    expect(vercelConfig).toContain('"value": "no-cache"');

    expect(netlifyConfig).toContain('for = "/ngsw-worker.js"');
    expect(netlifyConfig).toContain('for = "/sw-composed.js"');
    expect(netlifyConfig).toContain('for = "/widgets/templates/*"');
    expect(netlifyConfig).toContain('Cache-Control = "no-cache"');
  });

  it('sw-composed tombstone payload should stay aligned with the static retirement assets', () => {
    const composedSwSource = fs.readFileSync(path.join(process.cwd(), 'public', 'sw-composed.js'), 'utf8');
    const templateSource = fs.readFileSync(path.join(process.cwd(), 'public', 'widgets', 'templates', 'focus-summary.json'), 'utf8').trim();
    const dataSource = fs.readFileSync(path.join(process.cwd(), 'public', 'widgets', 'templates', 'focus-data.json'), 'utf8').trim();

    const templateMatch = composedSwSource.match(/const TEMPLATE = `([\s\S]*?)`;/);
    const dataMatch = composedSwSource.match(/const DATA = `([\s\S]*?)`;/);

    expect(normalizeTemplateLiteralSource(templateMatch?.[1])).toBe(templateSource);
    expect(dataMatch?.[1]?.trim()).toBe(dataSource);
  });
});
