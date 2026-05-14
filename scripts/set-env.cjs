const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

// 优先读取 .env.local，其次读取进程环境（方便 Vercel/Supabase 等 CI 环境）
const localEnv = dotenv.config({ path: path.resolve(__dirname, '../.env.local') }).parsed || {};
const supabaseUrl = process.env.NG_APP_SUPABASE_URL || localEnv.NG_APP_SUPABASE_URL;
const supabaseAnonKey = process.env.NG_APP_SUPABASE_ANON_KEY || localEnv.NG_APP_SUPABASE_ANON_KEY;
const gojsLicenseKey = process.env.NG_APP_GOJS_LICENSE_KEY || localEnv.NG_APP_GOJS_LICENSE_KEY || '';
const sentryDsn = process.env.NG_APP_SENTRY_DSN
  || process.env.SENTRY_DSN
  || localEnv.NG_APP_SENTRY_DSN
  || localEnv.SENTRY_DSN
  || '';

/**
 * 解析布尔环境变量
 * 支持 true/false/1/0/yes/no/on/off（大小写不敏感）
 */
const parseBooleanEnv = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
};

const parseNumberEnv = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const decodeBase64UrlJson = (segment) => {
  if (!segment) return null;

  const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
  const paddingLength = normalized.length % 4;
  const padded = paddingLength === 0 ? normalized : `${normalized}${'='.repeat(4 - paddingLength)}`;

  try {
    const decoded = Buffer.from(padded, 'base64').toString('utf8');
    return JSON.parse(decoded);
  } catch {
    return null;
  }
};

const extractSupabaseProjectRefFromUrl = (url) => {
  if (!url) return null;

  try {
    const hostname = new URL(url).hostname;
    if (!hostname.endsWith('.supabase.co')) {
      return null;
    }

    return hostname.split('.')[0] || null;
  } catch {
    return null;
  }
};

const extractLegacyAnonProjectRef = (key) => {
  if (!key) return null;

  const parts = key.split('.');
  if (parts.length !== 3) {
    return null;
  }

  const payload = decodeBase64UrlJson(parts[1]);
  return typeof payload?.ref === 'string' ? payload.ref : null;
};

const getSupabaseProjectRefMismatch = (url, key) => {
  const urlProjectRef = extractSupabaseProjectRefFromUrl(url);
  const keyProjectRef = extractLegacyAnonProjectRef(key);

  if (!urlProjectRef || !keyProjectRef || urlProjectRef === keyProjectRef) {
    return null;
  }

  return { urlProjectRef, keyProjectRef };
};

// 启动阶段 Boot Flags（用于 index.html 预加载脚本）
const disableIndexDataPreloadV1 = parseBooleanEnv(
  process.env.NG_APP_DISABLE_INDEX_DATA_PRELOAD_V1 || localEnv.NG_APP_DISABLE_INDEX_DATA_PRELOAD_V1,
  true
);
const fontExtremeFirstpaintV1 = parseBooleanEnv(
  process.env.NG_APP_FONT_EXTREME_FIRSTPAINT_V1 || localEnv.NG_APP_FONT_EXTREME_FIRSTPAINT_V1,
  true
);
const flowStateAwareRestoreV2 = parseBooleanEnv(
  process.env.NG_APP_FLOW_STATE_AWARE_RESTORE_V2 || localEnv.NG_APP_FLOW_STATE_AWARE_RESTORE_V2,
  true
);
const eventDrivenSyncPulseV1 = parseBooleanEnv(
  process.env.NG_APP_EVENT_DRIVEN_SYNC_PULSE_V1 || localEnv.NG_APP_EVENT_DRIVEN_SYNC_PULSE_V1,
  true
);
const tabSyncLocalRefreshV1 = parseBooleanEnv(
  process.env.NG_APP_TAB_SYNC_LOCAL_REFRESH_V1 || localEnv.NG_APP_TAB_SYNC_LOCAL_REFRESH_V1,
  true
);
const strictModulepreloadV2 = parseBooleanEnv(
  process.env.NG_APP_STRICT_MODULEPRELOAD_V2 || localEnv.NG_APP_STRICT_MODULEPRELOAD_V2,
  false
);
const rootStartupDepPruneV1 = parseBooleanEnv(
  process.env.NG_APP_ROOT_STARTUP_DEP_PRUNE_V1 || localEnv.NG_APP_ROOT_STARTUP_DEP_PRUNE_V1,
  true
);
const tieredStartupHydrationV1 = parseBooleanEnv(
  process.env.NG_APP_TIERED_STARTUP_HYDRATION_V1 || localEnv.NG_APP_TIERED_STARTUP_HYDRATION_V1,
  true
);
const supabaseDeferredSdkV1 = parseBooleanEnv(
  process.env.NG_APP_SUPABASE_DEFERRED_SDK_V1 || localEnv.NG_APP_SUPABASE_DEFERRED_SDK_V1,
  true
);
const configBarrelPruneV1 = parseBooleanEnv(
  process.env.NG_APP_CONFIG_BARREL_PRUNE_V1 || localEnv.NG_APP_CONFIG_BARREL_PRUNE_V1,
  true
);
const sidebarToolsDynamicLoadV1 = parseBooleanEnv(
  process.env.NG_APP_SIDEBAR_TOOLS_DYNAMIC_LOAD_V1 || localEnv.NG_APP_SIDEBAR_TOOLS_DYNAMIC_LOAD_V1,
  true
);
const resumeInteractionFirstV1 = parseBooleanEnv(
  process.env.NG_APP_RESUME_INTERACTION_FIRST_V1 || localEnv.NG_APP_RESUME_INTERACTION_FIRST_V1,
  true
);
const resumeWatermarkRpcV1 = parseBooleanEnv(
  process.env.NG_APP_RESUME_WATERMARK_RPC_V1 || localEnv.NG_APP_RESUME_WATERMARK_RPC_V1,
  true
);
const resumePulseDedupV1 = parseBooleanEnv(
  process.env.NG_APP_RESUME_PULSE_DEDUP_V1 || localEnv.NG_APP_RESUME_PULSE_DEDUP_V1,
  true
);
const routeGuardLazyImportV1 = parseBooleanEnv(
  process.env.NG_APP_ROUTE_GUARD_LAZY_IMPORT_V1 || localEnv.NG_APP_ROUTE_GUARD_LAZY_IMPORT_V1,
  true
);
const webVitalsIdleBootV2 = parseBooleanEnv(
  process.env.NG_APP_WEB_VITALS_IDLE_BOOT_V2 || localEnv.NG_APP_WEB_VITALS_IDLE_BOOT_V2,
  true
);
const fontAggressiveDeferV2 = parseBooleanEnv(
  process.env.NG_APP_FONT_AGGRESSIVE_DEFER_V2 || localEnv.NG_APP_FONT_AGGRESSIVE_DEFER_V2,
  true
);
const syncStatusDeferredMountV1 = parseBooleanEnv(
  process.env.NG_APP_SYNC_STATUS_DEFERRED_MOUNT_V1 || localEnv.NG_APP_SYNC_STATUS_DEFERRED_MOUNT_V1,
  true
);
const pwaPromptDeferV2 = parseBooleanEnv(
  process.env.NG_APP_PWA_PROMPT_DEFER_V2 || localEnv.NG_APP_PWA_PROMPT_DEFER_V2,
  true
);
const resumeSessionSnapshotV1 = parseBooleanEnv(
  process.env.NG_APP_RESUME_SESSION_SNAPSHOT_V1 || localEnv.NG_APP_RESUME_SESSION_SNAPSHOT_V1,
  true
);
const userProjectsWatermarkRpcV1 = parseBooleanEnv(
  process.env.NG_APP_USER_PROJECTS_WATERMARK_RPC_V1 || localEnv.NG_APP_USER_PROJECTS_WATERMARK_RPC_V1,
  true
);
const recoveryTicketDedupV1 = parseBooleanEnv(
  process.env.NG_APP_RECOVERY_TICKET_DEDUP_V1 || localEnv.NG_APP_RECOVERY_TICKET_DEDUP_V1,
  true
);
const blackboxWatermarkProbeV1 = parseBooleanEnv(
  process.env.NG_APP_BLACKBOX_WATERMARK_PROBE_V1 || localEnv.NG_APP_BLACKBOX_WATERMARK_PROBE_V1,
  true
);
const workspaceShellCompositionV3 = parseBooleanEnv(
  process.env.NG_APP_WORKSPACE_SHELL_COMPOSITION_V3 || localEnv.NG_APP_WORKSPACE_SHELL_COMPOSITION_V3,
  true
);
const resumeCompositeProbeRpcV1 = parseBooleanEnv(
  process.env.NG_APP_RESUME_COMPOSITE_PROBE_RPC_V1 || localEnv.NG_APP_RESUME_COMPOSITE_PROBE_RPC_V1,
  true
);
const resumeMetricsGateV1 = parseBooleanEnv(
  process.env.NG_APP_RESUME_METRICS_GATE_V1 || localEnv.NG_APP_RESUME_METRICS_GATE_V1,
  true
);

// 开发环境自动登录配置
// 设置后，应用启动时会自动登录，无需手动输入凭据
// Guard 仍然存在且生效，只是登录过程被自动化
const devAutoLoginEmail = process.env.NG_APP_DEV_AUTO_LOGIN_EMAIL || localEnv.NG_APP_DEV_AUTO_LOGIN_EMAIL;
const devAutoLoginPassword = process.env.NG_APP_DEV_AUTO_LOGIN_PASSWORD || localEnv.NG_APP_DEV_AUTO_LOGIN_PASSWORD;
const hasDevAutoLogin = devAutoLoginEmail && devAutoLoginPassword;

// === Cloudflare 迁移注入：环境/部署/Origin Gate 标识符（§16.7 / §16.18 / §16.24 / §16.26） ===
// 这些值默认为空字符串/false，保持与 Vercel 当前部署行为兼容；GitHub Actions 通过显式 env 注入。
const sentryEnvironment = (process.env.NG_APP_SENTRY_ENVIRONMENT || localEnv.NG_APP_SENTRY_ENVIRONMENT || '').trim();
const canonicalOrigin = (process.env.NG_APP_CANONICAL_ORIGIN || localEnv.NG_APP_CANONICAL_ORIGIN || '').trim();
const originGateMode = (process.env.NG_APP_ORIGIN_GATE_MODE || localEnv.NG_APP_ORIGIN_GATE_MODE || 'off').trim();
const readOnlyPreview = parseBooleanEnv(
  process.env.NG_APP_READ_ONLY_PREVIEW || localEnv.NG_APP_READ_ONLY_PREVIEW,
  false
);
const deploymentTarget = (process.env.NG_APP_DEPLOYMENT_TARGET || localEnv.NG_APP_DEPLOYMENT_TARGET || 'local').trim();
const supabaseProjectAlias = (process.env.NG_APP_SUPABASE_PROJECT_ALIAS || localEnv.NG_APP_SUPABASE_PROJECT_ALIAS || 'local').trim();
const sentryRelease = (process.env.NG_APP_SENTRY_RELEASE || localEnv.NG_APP_SENTRY_RELEASE || process.env.GITHUB_SHA || '').trim();
const syncRpcEnabled = parseBooleanEnv(
  process.env.NG_APP_SYNC_RPC_ENABLED || localEnv.NG_APP_SYNC_RPC_ENABLED,
  false
);
const syncLeaseEnabled = parseBooleanEnv(
  process.env.NG_APP_SYNC_LEASE_ENABLED || localEnv.NG_APP_SYNC_LEASE_ENABLED,
  false
);
const syncProtocolVersion = parseNumberEnv(
  process.env.NG_APP_SYNC_PROTOCOL_VERSION || localEnv.NG_APP_SYNC_PROTOCOL_VERSION,
  1
);
const deploymentEpoch = parseNumberEnv(
  process.env.NG_APP_DEPLOYMENT_EPOCH || localEnv.NG_APP_DEPLOYMENT_EPOCH,
  0
);

const readIndexHtmlSupabaseUrlFallback = () => {
  const indexHtmlPath = path.resolve(__dirname, '../index.html');
  try {
    const indexHtml = fs.readFileSync(indexHtmlPath, 'utf-8');
    const matches = [
      indexHtml.match(/var SUPABASE_URL = '([^']+)';/),
      indexHtml.match(/var supabaseUrl = '([^']+)';/),
      indexHtml.match(/<link rel="preconnect" href="([^"]+\.supabase\.co)" crossorigin>/i),
      indexHtml.match(/<link rel="dns-prefetch" href="([^"]+\.supabase\.co)">/i)
    ];

    const candidates = matches.map((match) => match?.[1]).filter(Boolean);
    for (const candidate of candidates) {
      const normalized = String(candidate).trim();
      if (/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(normalized)) {
        return normalized;
      }
    }

    return null;
  } catch {
    return null;
  }
};

// 如果没有配置 Supabase 环境变量，使用占位符（应用将以离线模式运行）
const useOfflineMode = !supabaseUrl || !supabaseAnonKey;
if (useOfflineMode) {
  console.log('ℹ️ 未找到 Supabase 环境变量，将生成离线模式配置文件。');
  console.log('   如需云端同步功能，请在 .env.local 中设置 NG_APP_SUPABASE_URL 和 NG_APP_SUPABASE_ANON_KEY');
}

const supabaseProjectMismatch = useOfflineMode ? null : getSupabaseProjectRefMismatch(supabaseUrl, supabaseAnonKey);
if (supabaseProjectMismatch) {
  console.error('❌ Supabase 配置错误：URL 和 ANON_KEY 来自不同项目。');
  console.error(`   NG_APP_SUPABASE_URL -> ${supabaseProjectMismatch.urlProjectRef}`);
  console.error(`   NG_APP_SUPABASE_ANON_KEY -> ${supabaseProjectMismatch.keyProjectRef}`);
  console.error('   请保持 NG_APP_SUPABASE_URL 与 NG_APP_SUPABASE_ANON_KEY 来自同一 Supabase 项目。');
  process.exit(1);
}

if (!gojsLicenseKey) {
  console.log('ℹ️ 未找到 GoJS License Key，流程图将显示水印。');
  console.log('   如需移除水印，请在 .env.local 中设置 NG_APP_GOJS_LICENSE_KEY');
}

if (hasDevAutoLogin) {
  console.log('🔐 开发环境自动登录已配置，应用启动时将自动使用配置的凭据登录');
}

const indexHtmlSupabaseUrlFallback = !supabaseUrl && !supabaseAnonKey
  ? readIndexHtmlSupabaseUrlFallback()
  : null;

if (indexHtmlSupabaseUrlFallback) {
  console.log(`ℹ️ 使用 index.html 中的 Supabase URL 作为离线模式 fallback: ${indexHtmlSupabaseUrlFallback}`);
}

const targetPath = path.resolve(__dirname, '../src/environments/environment.development.ts');
const targetPathProd = path.resolve(__dirname, '../src/environments/environment.ts');

// 确保 environments 目录存在
const envDir = path.dirname(targetPath);
if (!fs.existsSync(envDir)) {
  fs.mkdirSync(envDir, { recursive: true });
}

// 离线模式使用占位符；但为保证 index.html resource hints 与预热脚本一致，允许从 index.html 推导 URL fallback
const finalUrl = supabaseUrl || indexHtmlSupabaseUrlFallback || 'YOUR_SUPABASE_URL';
const finalKey = supabaseAnonKey || 'YOUR_SUPABASE_ANON_KEY';

// 开发环境自动登录配置（仅开发环境）
const devAutoLoginConfig = hasDevAutoLogin 
  ? `{ email: '${devAutoLoginEmail}', password: '${devAutoLoginPassword}' }`
  : 'null';

const devEnvContent = `// 此文件由 scripts/set-env.cjs 自动生成，请勿手动编辑
// 已添加到 .gitignore，不会被提交到代码仓库

export const environment = {
  production: false,
  supabaseUrl: '${finalUrl}',
  supabaseAnonKey: '${finalKey}',
  // Sentry DSN - 用于错误监控
  SENTRY_DSN: '${sentryDsn}',
  // GoJS License Key - 生产环境需要配置以移除水印
  gojsLicenseKey: '${gojsLicenseKey}',
  // === Cloudflare 迁移：部署 / Sentry / Origin Gate 标识符 ===
  sentryEnvironment: '${sentryEnvironment || 'development'}',
  canonicalOrigin: '${canonicalOrigin}',
  originGateMode: '${originGateMode}' as 'off' | 'redirect' | 'read-only' | 'export-only',
  readOnlyPreview: ${readOnlyPreview ? 'true' : 'false'},
  deploymentTarget: '${deploymentTarget}',
  supabaseProjectAlias: '${supabaseProjectAlias}',
  sentryRelease: '${sentryRelease}',
  syncRpcEnabled: ${syncRpcEnabled ? 'true' : 'false'},
  syncLeaseEnabled: ${syncLeaseEnabled ? 'true' : 'false'},
  syncProtocolVersion: ${syncProtocolVersion},
  deploymentEpoch: ${deploymentEpoch},
  // 开发环境自动登录（仅开发环境生效）
  // 设置方式：在 .env.local 中配置 NG_APP_DEV_AUTO_LOGIN_EMAIL 和 NG_APP_DEV_AUTO_LOGIN_PASSWORD
  devAutoLogin: ${devAutoLoginConfig} as { email: string; password: string } | null
};
`;

const prodEnvContent = `// 此文件由 scripts/set-env.cjs 自动生成，请勿手动编辑
// 已添加到 .gitignore，不会被提交到代码仓库

export const environment = {
  production: true,
  supabaseUrl: '${finalUrl}',
  supabaseAnonKey: '${finalKey}',
  // Sentry DSN - 用于错误监控
  SENTRY_DSN: '${sentryDsn}',
  // GoJS License Key - 生产环境需要配置以移除水印
  gojsLicenseKey: '${gojsLicenseKey}',
  // === Cloudflare 迁移：部署 / Sentry / Origin Gate 标识符 ===
  sentryEnvironment: '${sentryEnvironment || 'production'}',
  canonicalOrigin: '${canonicalOrigin}',
  originGateMode: '${originGateMode}' as 'off' | 'redirect' | 'read-only' | 'export-only',
  readOnlyPreview: ${readOnlyPreview ? 'true' : 'false'},
  deploymentTarget: '${deploymentTarget}',
  supabaseProjectAlias: '${supabaseProjectAlias}',
  sentryRelease: '${sentryRelease}',
  syncRpcEnabled: ${syncRpcEnabled ? 'true' : 'false'},
  syncLeaseEnabled: ${syncLeaseEnabled ? 'true' : 'false'},
  syncProtocolVersion: ${syncProtocolVersion},
  deploymentEpoch: ${deploymentEpoch},
  // 生产环境始终禁用自动登录
  devAutoLogin: null as { email: string; password: string } | null
};
`;

fs.writeFileSync(targetPath, devEnvContent);
fs.writeFileSync(targetPathProd, prodEnvContent);

console.log(`✅ 环境变量已写入:`);
console.log(`   - ${targetPath} (development)`);
console.log(`   - ${targetPathProd} (production)`);

// === 同步注入 index.html 预加载脚本的 Supabase 配置 ===
// 使用正则匹配，支持幂等执行（无论是占位符还是已注入的真实值都能正确替换）
const indexHtmlPath = path.resolve(__dirname, '../index.html');
try {
  let indexHtml = fs.readFileSync(indexHtmlPath, 'utf-8');
  const urlPattern = /var supabaseUrl = '[^']*';/;
  const keyPattern = /var supabaseAnonKey = '[^']*';/;
  const preloadUrlPattern = /var preloadSupabaseUrl = '[^']*';/;

  if (urlPattern.test(indexHtml) && keyPattern.test(indexHtml)) {
    indexHtml = indexHtml.replace(urlPattern, `var supabaseUrl = '${finalUrl}';`);
    indexHtml = indexHtml.replace(keyPattern, `var supabaseAnonKey = '${finalKey}';`);
    indexHtml = indexHtml.replace(preloadUrlPattern, `var preloadSupabaseUrl = '${finalUrl}';`);
  } else {
    console.warn('⚠️ index.html 中未找到预加载脚本的 Supabase 配置占位符，跳过注入');
  }

  // 【2026-03-23】会话预热脚本也需要注入 Supabase 配置
  // 使用全局正则确保 index.html 中所有实例都被替换（预热脚本 + 数据预加载脚本）
  const prewarmUrlPattern = /var SUPABASE_URL = '[^']*';/g;
  const prewarmKeyPattern = /var SUPABASE_ANON_KEY = '[^']*';/g;
  if (prewarmUrlPattern.test(indexHtml)) {
    prewarmUrlPattern.lastIndex = 0;
    indexHtml = indexHtml.replace(prewarmUrlPattern, `var SUPABASE_URL = '${finalUrl}';`);
  }

  const supabaseHintUrl = /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(finalUrl)
    ? finalUrl
    : null;
  if (supabaseHintUrl) {
    const supabasePreconnectPattern = /(<link\s+rel="preconnect"\s+href=")https:\/\/[^"]+\.supabase\.co("[^>]*>)/i;
    const supabaseDnsPrefetchPattern = /(<link\s+rel="dns-prefetch"\s+href=")https:\/\/[^"]+\.supabase\.co("[^>]*>)/i;
    indexHtml = indexHtml
      .replace(supabasePreconnectPattern, `$1${supabaseHintUrl}$2`)
      .replace(supabaseDnsPrefetchPattern, `$1${supabaseHintUrl}$2`);
  }
  if (prewarmKeyPattern.test(indexHtml)) {
    prewarmKeyPattern.lastIndex = 0;
    indexHtml = indexHtml.replace(prewarmKeyPattern, `var SUPABASE_ANON_KEY = '${finalKey}';`);
  }

  const disablePreloadPattern = /DISABLE_INDEX_DATA_PRELOAD_V1:\s*(true|false),/;
  const fontExtremePattern = /FONT_EXTREME_FIRSTPAINT_V1:\s*(true|false),/;
  const flowStateAwareRestorePattern = /FLOW_STATE_AWARE_RESTORE_V2:\s*(true|false),/;
  const eventDrivenSyncPulsePattern = /EVENT_DRIVEN_SYNC_PULSE_V1:\s*(true|false),/;
  const tabSyncLocalRefreshPattern = /TAB_SYNC_LOCAL_REFRESH_V1:\s*(true|false),/;
  const strictModulepreloadPattern = /STRICT_MODULEPRELOAD_V2:\s*(true|false),/;
  const rootStartupDepPrunePattern = /ROOT_STARTUP_DEP_PRUNE_V1:\s*(true|false),/;
  const tieredStartupHydrationPattern = /TIERED_STARTUP_HYDRATION_V1:\s*(true|false),/;
  const supabaseDeferredSdkPattern = /SUPABASE_DEFERRED_SDK_V1:\s*(true|false),/;
  const configBarrelPrunePattern = /CONFIG_BARREL_PRUNE_V1:\s*(true|false),/;
  const sidebarToolsDynamicLoadPattern = /SIDEBAR_TOOLS_DYNAMIC_LOAD_V1:\s*(true|false),/;
  const resumeInteractionFirstPattern = /RESUME_INTERACTION_FIRST_V1:\s*(true|false),/;
  const resumeWatermarkRpcPattern = /RESUME_WATERMARK_RPC_V1:\s*(true|false),/;
  const resumePulseDedupPattern = /RESUME_PULSE_DEDUP_V1:\s*(true|false),/;
  const routeGuardLazyImportPattern = /ROUTE_GUARD_LAZY_IMPORT_V1:\s*(true|false),/;
  const webVitalsIdleBootPattern = /WEB_VITALS_IDLE_BOOT_V2:\s*(true|false),/;
  const fontAggressiveDeferPattern = /FONT_AGGRESSIVE_DEFER_V2:\s*(true|false),/;
  const syncStatusDeferredMountPattern = /SYNC_STATUS_DEFERRED_MOUNT_V1:\s*(true|false),/;
  const pwaPromptDeferPattern = /PWA_PROMPT_DEFER_V2:\s*(true|false),/;
  const resumeSessionSnapshotPattern = /RESUME_SESSION_SNAPSHOT_V1:\s*(true|false),/;
  const userProjectsWatermarkRpcPattern = /USER_PROJECTS_WATERMARK_RPC_V1:\s*(true|false),/;
  const recoveryTicketDedupPattern = /RECOVERY_TICKET_DEDUP_V1:\s*(true|false),/;
  const blackboxWatermarkProbePattern = /BLACKBOX_WATERMARK_PROBE_V1:\s*(true|false),/;
  const workspaceShellCompositionPattern = /WORKSPACE_SHELL_COMPOSITION_V3:\s*(true|false),/;
  const resumeCompositeProbePattern = /RESUME_COMPOSITE_PROBE_RPC_V1:\s*(true|false),/;
  const resumeMetricsGatePattern = /RESUME_METRICS_GATE_V1:\s*(true|false),/;

  if (disablePreloadPattern.test(indexHtml)) {
    indexHtml = indexHtml.replace(
      disablePreloadPattern,
      `DISABLE_INDEX_DATA_PRELOAD_V1: ${disableIndexDataPreloadV1},`
    );
  } else {
    console.warn('⚠️ index.html 中未找到 DISABLE_INDEX_DATA_PRELOAD_V1 注入位置，跳过注入');
  }

  if (fontExtremePattern.test(indexHtml)) {
    indexHtml = indexHtml.replace(
      fontExtremePattern,
      `FONT_EXTREME_FIRSTPAINT_V1: ${fontExtremeFirstpaintV1},`
    );
  } else {
    console.warn('⚠️ index.html 中未找到 FONT_EXTREME_FIRSTPAINT_V1 注入位置，跳过注入');
  }

  if (flowStateAwareRestorePattern.test(indexHtml)) {
    indexHtml = indexHtml.replace(
      flowStateAwareRestorePattern,
      `FLOW_STATE_AWARE_RESTORE_V2: ${flowStateAwareRestoreV2},`
    );
  } else {
    console.warn('⚠️ index.html 中未找到 FLOW_STATE_AWARE_RESTORE_V2 注入位置，跳过注入');
  }

  if (eventDrivenSyncPulsePattern.test(indexHtml)) {
    indexHtml = indexHtml.replace(
      eventDrivenSyncPulsePattern,
      `EVENT_DRIVEN_SYNC_PULSE_V1: ${eventDrivenSyncPulseV1},`
    );
  } else {
    console.warn('⚠️ index.html 中未找到 EVENT_DRIVEN_SYNC_PULSE_V1 注入位置，跳过注入');
  }

  if (tabSyncLocalRefreshPattern.test(indexHtml)) {
    indexHtml = indexHtml.replace(
      tabSyncLocalRefreshPattern,
      `TAB_SYNC_LOCAL_REFRESH_V1: ${tabSyncLocalRefreshV1},`
    );
  } else {
    console.warn('⚠️ index.html 中未找到 TAB_SYNC_LOCAL_REFRESH_V1 注入位置，跳过注入');
  }

  if (strictModulepreloadPattern.test(indexHtml)) {
    indexHtml = indexHtml.replace(
      strictModulepreloadPattern,
      `STRICT_MODULEPRELOAD_V2: ${strictModulepreloadV2},`
    );
  } else {
    console.warn('⚠️ index.html 中未找到 STRICT_MODULEPRELOAD_V2 注入位置，跳过注入');
  }

  if (rootStartupDepPrunePattern.test(indexHtml)) {
    indexHtml = indexHtml.replace(
      rootStartupDepPrunePattern,
      `ROOT_STARTUP_DEP_PRUNE_V1: ${rootStartupDepPruneV1},`
    );
  } else {
    console.warn('⚠️ index.html 中未找到 ROOT_STARTUP_DEP_PRUNE_V1 注入位置，跳过注入');
  }

  if (tieredStartupHydrationPattern.test(indexHtml)) {
    indexHtml = indexHtml.replace(
      tieredStartupHydrationPattern,
      `TIERED_STARTUP_HYDRATION_V1: ${tieredStartupHydrationV1},`
    );
  } else {
    console.warn('⚠️ index.html 中未找到 TIERED_STARTUP_HYDRATION_V1 注入位置，跳过注入');
  }

  if (supabaseDeferredSdkPattern.test(indexHtml)) {
    indexHtml = indexHtml.replace(
      supabaseDeferredSdkPattern,
      `SUPABASE_DEFERRED_SDK_V1: ${supabaseDeferredSdkV1},`
    );
  } else {
    console.warn('⚠️ index.html 中未找到 SUPABASE_DEFERRED_SDK_V1 注入位置，跳过注入');
  }

  if (configBarrelPrunePattern.test(indexHtml)) {
    indexHtml = indexHtml.replace(
      configBarrelPrunePattern,
      `CONFIG_BARREL_PRUNE_V1: ${configBarrelPruneV1},`
    );
  } else {
    console.warn('⚠️ index.html 中未找到 CONFIG_BARREL_PRUNE_V1 注入位置，跳过注入');
  }

  if (sidebarToolsDynamicLoadPattern.test(indexHtml)) {
    indexHtml = indexHtml.replace(
      sidebarToolsDynamicLoadPattern,
      `SIDEBAR_TOOLS_DYNAMIC_LOAD_V1: ${sidebarToolsDynamicLoadV1},`
    );
  } else {
    console.warn('⚠️ index.html 中未找到 SIDEBAR_TOOLS_DYNAMIC_LOAD_V1 注入位置，跳过注入');
  }

  if (resumeInteractionFirstPattern.test(indexHtml)) {
    indexHtml = indexHtml.replace(
      resumeInteractionFirstPattern,
      `RESUME_INTERACTION_FIRST_V1: ${resumeInteractionFirstV1},`
    );
  } else {
    console.warn('⚠️ index.html 中未找到 RESUME_INTERACTION_FIRST_V1 注入位置，跳过注入');
  }

  if (resumeWatermarkRpcPattern.test(indexHtml)) {
    indexHtml = indexHtml.replace(
      resumeWatermarkRpcPattern,
      `RESUME_WATERMARK_RPC_V1: ${resumeWatermarkRpcV1},`
    );
  } else {
    console.warn('⚠️ index.html 中未找到 RESUME_WATERMARK_RPC_V1 注入位置，跳过注入');
  }

  if (resumePulseDedupPattern.test(indexHtml)) {
    indexHtml = indexHtml.replace(
      resumePulseDedupPattern,
      `RESUME_PULSE_DEDUP_V1: ${resumePulseDedupV1},`
    );
  } else {
    console.warn('⚠️ index.html 中未找到 RESUME_PULSE_DEDUP_V1 注入位置，跳过注入');
  }

  if (routeGuardLazyImportPattern.test(indexHtml)) {
    indexHtml = indexHtml.replace(
      routeGuardLazyImportPattern,
      `ROUTE_GUARD_LAZY_IMPORT_V1: ${routeGuardLazyImportV1},`
    );
  } else {
    console.warn('⚠️ index.html 中未找到 ROUTE_GUARD_LAZY_IMPORT_V1 注入位置，跳过注入');
  }

  if (webVitalsIdleBootPattern.test(indexHtml)) {
    indexHtml = indexHtml.replace(
      webVitalsIdleBootPattern,
      `WEB_VITALS_IDLE_BOOT_V2: ${webVitalsIdleBootV2},`
    );
  } else {
    console.warn('⚠️ index.html 中未找到 WEB_VITALS_IDLE_BOOT_V2 注入位置，跳过注入');
  }

  if (fontAggressiveDeferPattern.test(indexHtml)) {
    indexHtml = indexHtml.replace(
      fontAggressiveDeferPattern,
      `FONT_AGGRESSIVE_DEFER_V2: ${fontAggressiveDeferV2},`
    );
  } else {
    console.warn('⚠️ index.html 中未找到 FONT_AGGRESSIVE_DEFER_V2 注入位置，跳过注入');
  }

  if (syncStatusDeferredMountPattern.test(indexHtml)) {
    indexHtml = indexHtml.replace(
      syncStatusDeferredMountPattern,
      `SYNC_STATUS_DEFERRED_MOUNT_V1: ${syncStatusDeferredMountV1},`
    );
  } else {
    console.warn('⚠️ index.html 中未找到 SYNC_STATUS_DEFERRED_MOUNT_V1 注入位置，跳过注入');
  }

  if (pwaPromptDeferPattern.test(indexHtml)) {
    indexHtml = indexHtml.replace(
      pwaPromptDeferPattern,
      `PWA_PROMPT_DEFER_V2: ${pwaPromptDeferV2},`
    );
  } else {
    console.warn('⚠️ index.html 中未找到 PWA_PROMPT_DEFER_V2 注入位置，跳过注入');
  }

  if (resumeSessionSnapshotPattern.test(indexHtml)) {
    indexHtml = indexHtml.replace(
      resumeSessionSnapshotPattern,
      `RESUME_SESSION_SNAPSHOT_V1: ${resumeSessionSnapshotV1},`
    );
  } else {
    console.warn('⚠️ index.html 中未找到 RESUME_SESSION_SNAPSHOT_V1 注入位置，跳过注入');
  }

  if (userProjectsWatermarkRpcPattern.test(indexHtml)) {
    indexHtml = indexHtml.replace(
      userProjectsWatermarkRpcPattern,
      `USER_PROJECTS_WATERMARK_RPC_V1: ${userProjectsWatermarkRpcV1},`
    );
  } else {
    console.warn('⚠️ index.html 中未找到 USER_PROJECTS_WATERMARK_RPC_V1 注入位置，跳过注入');
  }

  if (recoveryTicketDedupPattern.test(indexHtml)) {
    indexHtml = indexHtml.replace(
      recoveryTicketDedupPattern,
      `RECOVERY_TICKET_DEDUP_V1: ${recoveryTicketDedupV1},`
    );
  } else {
    console.warn('⚠️ index.html 中未找到 RECOVERY_TICKET_DEDUP_V1 注入位置，跳过注入');
  }

  if (blackboxWatermarkProbePattern.test(indexHtml)) {
    indexHtml = indexHtml.replace(
      blackboxWatermarkProbePattern,
      `BLACKBOX_WATERMARK_PROBE_V1: ${blackboxWatermarkProbeV1},`
    );
  } else {
    console.warn('⚠️ index.html 中未找到 BLACKBOX_WATERMARK_PROBE_V1 注入位置，跳过注入');
  }

  if (workspaceShellCompositionPattern.test(indexHtml)) {
    indexHtml = indexHtml.replace(
      workspaceShellCompositionPattern,
      `WORKSPACE_SHELL_COMPOSITION_V3: ${workspaceShellCompositionV3},`
    );
  } else {
    console.warn('⚠️ index.html 中未找到 WORKSPACE_SHELL_COMPOSITION_V3 注入位置，跳过注入');
  }

  if (resumeCompositeProbePattern.test(indexHtml)) {
    indexHtml = indexHtml.replace(
      resumeCompositeProbePattern,
      `RESUME_COMPOSITE_PROBE_RPC_V1: ${resumeCompositeProbeRpcV1},`
    );
  } else {
    console.warn('⚠️ index.html 中未找到 RESUME_COMPOSITE_PROBE_RPC_V1 注入位置，跳过注入');
  }

  if (resumeMetricsGatePattern.test(indexHtml)) {
    indexHtml = indexHtml.replace(
      resumeMetricsGatePattern,
      `RESUME_METRICS_GATE_V1: ${resumeMetricsGateV1},`
    );
  } else {
    console.warn('⚠️ index.html 中未找到 RESUME_METRICS_GATE_V1 注入位置，跳过注入');
  }

  // === Cloudflare Canonical Origin Gate 占位符注入（§16.10 / §16.26） ===
  // 占位符格式：'/* CANONICAL_ORIGIN */' 与 '/* ORIGIN_GATE_MODE */'
  // - dev/local：CANONICAL_ORIGIN 为空字符串，ORIGIN_GATE_MODE='off'，gate 直接跳过
  // - production：通过 GitHub Actions 注入 'https://nanoflow.pages.dev' + 'redirect'
  const canonicalOriginPattern = /var CANONICAL_ORIGIN = '[^']*';/g;
  const originGateModePattern = /var ORIGIN_GATE_MODE = '[^']*';/g;
  if (canonicalOriginPattern.test(indexHtml)) {
    canonicalOriginPattern.lastIndex = 0;
    indexHtml = indexHtml.replace(
      canonicalOriginPattern,
      `var CANONICAL_ORIGIN = '${escapeHtmlString(canonicalOrigin)}';`
    );
  }
  if (originGateModePattern.test(indexHtml)) {
    originGateModePattern.lastIndex = 0;
    indexHtml = indexHtml.replace(
      originGateModePattern,
      `var ORIGIN_GATE_MODE = '${escapeHtmlString(originGateMode || 'off')}';`
    );
  }

  fs.writeFileSync(indexHtmlPath, indexHtml);
  console.log(`   - ${indexHtmlPath} (预加载脚本 Supabase + Boot Flags + Origin Gate 配置)`);
} catch (e) {
  console.warn('⚠️ 无法更新 index.html 预加载脚本配置:', e.message);
}

function escapeHtmlString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
