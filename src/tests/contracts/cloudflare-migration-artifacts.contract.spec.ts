import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relativePath: string): string =>
  fs.readFileSync(path.join(root, relativePath), 'utf-8');
const readAllMigrations = (): string =>
  fs.readdirSync(path.join(root, 'supabase', 'migrations'))
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => read(path.join('supabase', 'migrations', file)))
    .join('\n');

describe('Cloudflare migration artifact contracts', () => {
  it('does not install an explicit wildcard _redirects rule that turns missing chunks into HTML 200', () => {
    const redirectsPath = path.join(root, 'public', '_redirects');

    if (!fs.existsSync(redirectsPath)) {
      expect(fs.existsSync(redirectsPath)).toBe(false);
      return;
    }

    const redirects = read('public/_redirects');
    expect(redirects).not.toMatch(/^\s*\/\*\s+\/index\.html\s+200\b/m);
  });

  it('keeps the production workflow split into secret-free tests and deploy-only Cloudflare credentials', () => {
    const workflow = read('.github/workflows/deploy-cloudflare-pages.yml');

    expect(workflow).not.toContain('pull_request_target');
    expect(workflow).toMatch(/\n  test:\n/);
    expect(workflow).toMatch(/\n  build-deploy:\n/);
    expect(workflow).toContain('needs: test');
    expect(workflow).toContain('wrangler@${WRANGLER_VERSION}');
    expect(workflow).toContain('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}');
    expect(workflow).toContain('vars.CLOUDFLARE_PAGES_PROJECT_NAME');
    expect(workflow).toContain('Inferred Cloudflare Pages project name from CANONICAL_PRODUCTION_ORIGIN');

    const beforeDeploy = workflow.split('- name: Deploy to Cloudflare Pages')[0] ?? workflow;
    expect(beforeDeploy).not.toContain('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}');
    expect(beforeDeploy).not.toContain('CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}');
  });

  it('uses NanoFlow-Preview environment for preview builds while allowing public Sentry DSN config via secrets or variables', () => {
    const workflow = read('.github/workflows/deploy-cloudflare-pages.yml');
    const previewEnvironmentExpression = "${{ (github.event_name == 'pull_request' || (github.event_name == 'workflow_dispatch' && inputs.target == 'preview')) && 'NanoFlow-Preview' || '' }}";

    expect(workflow).toContain('environment:');
    expect(workflow).toContain(`name: ${previewEnvironmentExpression}`);
    expect(workflow).toContain(`GITHUB_ENVIRONMENT_NAME: ${previewEnvironmentExpression}`);
    expect(workflow).toContain('NG_APP_SUPABASE_URL: ${{ secrets.NG_APP_SUPABASE_URL }}');
    expect(workflow).toContain('NG_APP_SUPABASE_ANON_KEY: ${{ secrets.NG_APP_SUPABASE_ANON_KEY }}');
    expect(workflow).toContain("NG_APP_SENTRY_DSN: ${{ secrets.NG_APP_SENTRY_DSN || vars.NG_APP_SENTRY_DSN || '' }}");
    expect(workflow).toContain('must define NG_APP_SENTRY_DSN so Sentry error capture is active on Cloudflare');
    expect(workflow).toContain('NG_APP_SENTRY_DSN must be a valid public https Sentry browser DSN without a secret for o4508391513718784.ingest.us.sentry.io');
    expect(workflow).toContain("url.hostname === allowedHost");
    expect(workflow).toContain("url.password === ''");
    expect(workflow).toContain('/^[a-f0-9]{32}$/i.test(url.username)');
    expect(workflow).toContain('actions/checkout@v6');
    expect(workflow).toContain('actions/setup-node@v6');
    expect(workflow).toContain('actions/upload-artifact@v7');
    expect(workflow).toContain('actions/github-script@v9');
    expect(workflow).not.toContain('actions/checkout@v4');
    expect(workflow).not.toContain('actions/setup-node@v4');
    expect(workflow).not.toContain('actions/upload-artifact@v4');
    expect(workflow).not.toContain('actions/github-script@v7');
    expect(workflow).toContain('public_config_source="Repository secrets or variables"');
    expect(workflow).toContain('public_config_source="GitHub Environment');
    expect(workflow).toContain('if: always()');
    expect(workflow).toContain('CF_COMMIT_MESSAGE: ${{ github.event.head_commit.message || github.event.pull_request.title ||');
    expect(workflow).toContain('--commit-message="$safe_commit_message"');
    expect(workflow).not.toContain('--commit-message="${{ github.event.head_commit.message || github.event.pull_request.title');
    expect(workflow).toContain('secret_source="Repository secrets"');
    expect(workflow).toContain('secret_source="GitHub Environment');
    expect(workflow).not.toContain('PREVIEW_NG_APP_SUPABASE_URL');
    expect(workflow).not.toContain('PREVIEW_NG_APP_SUPABASE_ANON_KEY');
    expect(workflow).not.toContain('NG_APP_SUPABASE_URL_PREVIEW');
    expect(workflow).not.toContain('NG_APP_SUPABASE_ANON_KEY_PREVIEW');
    expect(workflow).not.toContain('NG_APP_SUPABASE_URL_PROD');
    expect(workflow).not.toContain('NG_APP_SUPABASE_ANON_KEY_PROD');
    expect(workflow).not.toContain('ALLOW_PROD_SUPABASE_FOR_PREVIEW_SMOKE');
    expect(workflow).not.toContain("'Production'");
    expect(workflow).not.toContain("'Preview'");
  });

  it('runs deterministic build and local wrangler smoke in the dry-run workflow', () => {
    const workflow = read('.github/workflows/deploy-cloudflare-pages-dry-run.yml');

    expect(workflow).toContain('npm run quality:guard:build-deterministic');
    expect(workflow).toContain('wrangler@${WRANGLER_VERSION} pages dev dist/browser');
    expect(workflow).toContain('scripts/smoke/cloudflare-header-smoke.sh');
    expect(workflow).not.toContain('CLOUDFLARE_API_TOKEN');
    expect(workflow).not.toContain('SENTRY_AUTH_TOKEN');
  });

  it('keeps the Vercel prebuilt recovery workflow manual and gated', () => {
    const workflowPath = path.join(root, '.github', 'workflows', 'vercel-prebuilt-recovery.yml');
    expect(fs.existsSync(workflowPath)).toBe(true);

    const workflow = read('.github/workflows/vercel-prebuilt-recovery.yml');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).not.toContain('pull_request');
    expect(workflow).not.toMatch(/^\s+push:/m);
    expect(workflow).toContain("CONFIRM_TOKEN: 'DEPLOY_VERCEL_PREBUILT'");
    expect(workflow).toContain('legacy-export-only');
    expect(workflow).toContain('vercel-legacy');
    expect(workflow).toContain('export-only');
    expect(workflow).toContain('vercel pull --yes --environment=production');
    expect(workflow).toContain('vercel build --prod');
    expect(workflow).toContain('vercel deploy --prebuilt --prod');
    expect(workflow).toContain('npm run quality:guard:deploy-artifacts');
    expect(workflow).toContain('if [ "${{ inputs.deploy }}" != "true" ]; then');
  });

  it('generates a final artifact manifest after headers are installed', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    const deployWorkflow = read('.github/workflows/deploy-cloudflare-pages.yml');
    const dryRunWorkflow = read('.github/workflows/deploy-cloudflare-pages-dry-run.yml');

    expect(fs.existsSync(path.join(root, 'scripts', 'generate-artifact-manifest.cjs'))).toBe(true);
    expect(pkg.scripts.build).toContain('node scripts/generate-artifact-manifest.cjs');
    expect(pkg.scripts['build:strict']).toContain('node scripts/generate-artifact-manifest.cjs');
    expect(deployWorkflow.indexOf('Install Cloudflare headers')).toBeLessThan(
      deployWorkflow.indexOf('Generate artifact manifest')
    );
    expect(dryRunWorkflow.indexOf('Install Cloudflare headers')).toBeLessThan(
      dryRunWorkflow.indexOf('Generate artifact manifest')
    );
    expect(deployWorkflow).toContain('dist/browser/artifact-manifest.json');
    expect(dryRunWorkflow).toContain('node scripts/generate-artifact-manifest.cjs');
  });

  it('deploy artifact guard validates the final artifact manifest', () => {
    const guard = read('scripts/ci/check-deploy-artifacts.cjs');

    expect(guard).toContain('artifact-manifest.json');
    expect(guard).toContain('artifact manifest');
    expect(guard).toContain('modulepreload');
    expect(guard).toContain('cachePolicy');
  });

  it('runs artifact trend checks against the last main baseline before deploy', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    const deployWorkflow = read('.github/workflows/deploy-cloudflare-pages.yml');
    const dryRunWorkflow = read('.github/workflows/deploy-cloudflare-pages-dry-run.yml');
    const generator = read('scripts/generate-artifact-manifest.cjs');

    expect(pkg.scripts['quality:guard:artifact-trends']).toBe('node scripts/ci/check-artifact-trends.cjs');
    expect(fs.existsSync(path.join(root, 'scripts', 'ci', 'check-artifact-trends.cjs'))).toBe(true);
    expect(deployWorkflow).toContain('npm run quality:guard:artifact-trends');
    expect(dryRunWorkflow).toContain('npm run quality:guard:artifact-trends');
    expect(generator).toContain('gojsFlowChunkBytes');
  });

  it('blocks deployment on no-JIT, font, and Supabase readiness guards', () => {
    const deployWorkflow = read('.github/workflows/deploy-cloudflare-pages.yml');
    const dryRunWorkflow = read('.github/workflows/deploy-cloudflare-pages-dry-run.yml');

    for (const workflow of [deployWorkflow, dryRunWorkflow]) {
      expect(workflow).toContain('npm run perf:guard:nojit');
      expect(workflow).toContain('npm run quality:guard:font-contract');
      expect(workflow).toContain('npm run quality:guard:supabase-ready');
    }
  });

  it('strict production builds emit stats for the deploy no-JIT guard', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    const deployWorkflow = read('.github/workflows/deploy-cloudflare-pages.yml');

    expect(deployWorkflow).toContain('run: npm run build:strict');
    expect(deployWorkflow.indexOf('run: npm run build:strict')).toBeLessThan(
      deployWorkflow.indexOf('npm run perf:guard:nojit')
    );
    expect(pkg.scripts['build:strict']).toContain('node scripts/run-ng.cjs build --stats-json');
    expect(pkg.scripts['build:strict:clean']).toContain('node scripts/run-ng.cjs build --stats-json');
  });

  it('runs the canonical origin gate before resource hints and cleans stale SW caches once', () => {
    const indexHtml = read('index.html');
    const gateIndex = indexHtml.indexOf('id="canonical-origin-gate"');

    expect(gateIndex).toBeGreaterThan(-1);
    expect(gateIndex).toBeLessThan(indexHtml.indexOf('rel="preconnect"'));
    expect(gateIndex).toBeLessThan(indexHtml.indexOf('Anti-FOUC'));
    expect(indexHtml).toContain('nanoflow.originGate.cleanup');
    expect(indexHtml).toContain('EXPECTED_NGSW_HASH');
    expect(indexHtml).toContain('ngswHashMismatch');
    expect(indexHtml).toContain('/version.json');
    expect(indexHtml).toContain('caches.keys');
    expect(indexHtml).toContain('__NANOFLOW_WRITE_GUARD__');
  });

  it('Cloudflare headers explicitly keep the root app shell fresh and suppress Link headers', () => {
    const headers = read('public/_headers');
    const guard = read('scripts/ci/check-deploy-artifacts.cjs');

    expect(headers).toMatch(/^\/\r?\n(?:[ \t].*\r?\n)+/m);
    expect(headers).toMatch(/^\/\r?\n(?:[ \t].*\r?\n)*[ \t]+Cache-Control: .*no-store/im);
    expect(headers).toMatch(/^\/\*\r?\n(?:[ \t].*\r?\n)*[ \t]+! Link/im);
    expect(guard).toContain('Cloudflare Pages serves the app shell at /');
    expect(guard).toContain('suppresses automatic Link/modulepreload headers');
  });

  it('CSP allows Cloudflare Pages analytics beacon injected after deployment', () => {
    const indexHtml = read('index.html');

    expect(indexHtml).toContain('https://static.cloudflareinsights.com');
    expect(indexHtml).toContain('https://cloudflareinsights.com');
  });

  it('CSP allows Sentry regional ingest endpoints used by the production DSN', () => {
    const indexHtml = read('index.html');
    const csp = indexHtml.match(/http-equiv="Content-Security-Policy" content="([\s\S]*?)"/)?.[1] ?? '';
    const connectSrc = csp.match(/connect-src\s+([^;]+);/)?.[1] ?? '';

    expect(connectSrc).toContain('https://o4508391513718784.ingest.us.sentry.io');
    expect(connectSrc).not.toContain('https://*.sentry.io');
    expect(connectSrc).not.toContain('https://*.ingest.sentry.io');
    expect(connectSrc).not.toContain('https://*.ingest.us.sentry.io');
    expect(connectSrc).not.toContain('https://*.ingest.de.sentry.io');
  });

  it('shard balance gate fails only when max/min and max/median both show imbalance', () => {
    const workflow = read('.github/workflows/test-full-suite.yml');

    expect(workflow).toContain('FAIL_MAX_MEDIAN_THRESHOLD');
    expect(workflow).toContain('maxMin >= FAIL_THRESHOLD && maxMedian !== null && maxMedian >= FAIL_MAX_MEDIAN_THRESHOLD');
    expect(workflow).toContain('Required: max/min < 1.5 or max/median < 1.4.');
  });

  it('header smoke accepts Cloudflare default SPA fallback only with chunk self-heal proof', () => {
    const smoke = read('scripts/smoke/cloudflare-header-smoke.sh');

    expect(smoke).toContain('Pages SPA fallback');
    expect(smoke).toContain('GlobalErrorHandler chunk self-heal contract present');
    expect(smoke).toContain('src/services/global-error-handler.service.ts');
    expect(smoke).toContain('src/services/global-error-handler.service.spec.ts');
    expect(smoke).toContain('Failed to fetch dynamically imported module');
  });

  it('header smoke tolerates missing optional Cloudflare cache metadata headers', () => {
    const smoke = read('scripts/smoke/cloudflare-header-smoke.sh');

    expect(smoke).toContain("grep -i '^cf-cache-status:' || true");
    expect(smoke).toContain("grep -i '^age:' || true");
    expect(smoke).toContain('freshness OK (cf=${cf:-none}, age=${age:-0})');
  });

  it('provides a browser smoke for Cloudflare production pages', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    const scriptPath = path.join(root, 'scripts', 'smoke', 'cloudflare-playwright-smoke.cjs');

    expect(pkg.scripts['smoke:cloudflare-playwright']).toBe('node scripts/smoke/cloudflare-playwright-smoke.cjs');
    expect(fs.existsSync(scriptPath)).toBe(true);

    const smoke = read('scripts/smoke/cloudflare-playwright-smoke.cjs');
    expect(smoke).toContain('/version.json');
    expect(smoke).toContain('pageerror');
    expect(smoke).toContain('console');
    expect(smoke).toContain('serviceWorker');
    expect(smoke).toContain('setViewportSize');
    expect(smoke).toContain('hasLocalChunkSelfHealContract');
    expect(smoke).toContain('GlobalErrorHandler chunk self-heal contract present');
  });

  it('keeps the PR cloudflare smoke spec aligned with the Pages fallback self-heal contract', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    const specPath = path.join(root, 'e2e', 'cloudflare-smoke.spec.ts');

    expect(pkg.scripts['smoke:cloudflare-e2e']).toBe('playwright test e2e/cloudflare-smoke.spec.ts --project=chromium');
    expect(fs.existsSync(specPath)).toBe(true);

    const spec = read('e2e/cloudflare-smoke.spec.ts');
    expect(spec).toContain('/projects');
    expect(spec).toContain('intent=open-workspace');
    expect(spec).toContain('X-Robots-Tag');
    expect(spec).toContain('GlobalErrorHandler chunk self-heal contract present');
    expect(spec).not.toContain('缺失的 hashed chunk 必须返回 4xx 或 application/javascript');
  });

  it('Cloudflare workflows use the pinned Wrangler version env instead of hardcoded command versions', () => {
    const deployWorkflow = read('.github/workflows/deploy-cloudflare-pages.yml');
    const dryRunWorkflow = read('.github/workflows/deploy-cloudflare-pages-dry-run.yml');

    expect(deployWorkflow).toContain("WRANGLER_VERSION: '3.114.0'");
    expect(dryRunWorkflow).toContain("WRANGLER_VERSION: '3.114.0'");
    expect(deployWorkflow).toContain('wrangler@${WRANGLER_VERSION}');
    expect(dryRunWorkflow).toContain('wrangler@${WRANGLER_VERSION}');
    expect(deployWorkflow).not.toContain('wrangler@3.114.0');
    expect(dryRunWorkflow).not.toContain('wrangler@3.114.0');
  });

  it('keeps Supabase resource hints aligned with the injected Supabase URL', () => {
    const indexHtml = read('index.html');
    const setEnv = read('scripts/set-env.cjs');
    const supabaseUrl = indexHtml.match(/var SUPABASE_URL = '([^']+)';/)?.[1];
    const preconnect = indexHtml.match(/<link rel="preconnect" href="([^"]+\.supabase\.co)" crossorigin>/)?.[1];
    const dnsPrefetch = indexHtml.match(/<link rel="dns-prefetch" href="([^"]+\.supabase\.co)">/)?.[1];

    expect(supabaseUrl).toBeTruthy();
    expect(preconnect).toBe(supabaseUrl);
    expect(dnsPrefetch).toBe(supabaseUrl);
    expect(setEnv).toContain('supabasePreconnectPattern');
    expect(setEnv).toContain('supabaseDnsPrefetchPattern');
  });

  it('deterministic guard normalizes volatile ngsw timestamp while comparing stable SW content', () => {
    const guard = read('scripts/ci/check-build-deterministic.cjs');

    expect(guard).toContain('normalizeNgswManifest');
    expect(guard).toContain('delete normalized.timestamp');
    expect(guard).toContain('launch.html modulepreload');
    expect(guard).toContain('stableVersionJson');
  });

  it('deployment fingerprints do not let volatile ngsw timestamp or buildTime break deterministic guard', () => {
    const versionScript = read('scripts/generate-version-json.cjs');
    const deterministicGuard = read('scripts/ci/check-build-deterministic.cjs');

    expect(versionScript).toContain('stableNgswHash');
    expect(deterministicGuard).toContain('normalizeArtifactManifest');
    expect(deterministicGuard).not.toContain('sha256(artifactA) !== sha256(artifactB)');
  });

  it('artifact guard explicitly validates manifest id and TWA assetlinks', () => {
    const guard = read('scripts/ci/check-deploy-artifacts.cjs');
    const deployWorkflow = read('.github/workflows/deploy-cloudflare-pages.yml');
    const dryRunWorkflow = read('.github/workflows/deploy-cloudflare-pages-dry-run.yml');

    expect(guard).toContain('manifest.webmanifest id');
    expect(guard).toContain('assetlinks.json');
    expect(guard).toContain('ANDROID_TWA_PACKAGE_NAME');
    expect(guard).toContain('ANDROID_TWA_EXPECTED_SHA256_CERT_FINGERPRINTS');
    expect(guard).toContain('ANDROID_TWA_SHA256_FINGERPRINTS');
    expect(deployWorkflow).toContain('ANDROID_TWA_EXPECTED_SHA256_CERT_FINGERPRINTS');
    expect(dryRunWorkflow).toContain('ANDROID_TWA_EXPECTED_SHA256_CERT_FINGERPRINTS');
  });

  it('sync write protection RPCs carry deployment fences and full entity payloads', () => {
    const migration = readAllMigrations();

    expect(migration).toContain('deployment_epoch BIGINT');
    expect(migration).toContain('deployment_epoch_below_min');
    expect(migration).toContain('deployment_target TEXT');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.sync_upsert_project(payload JSONB)');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.sync_delete_project(payload JSONB)');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.sync_delete_tasks(payload JSONB)');
    expect(migration).toContain('INSERT INTO public.connections AS c (id, project_id, source_id, target_id, title, description, deleted_at, updated_at)');
    expect(migration).toContain('focus_meta');
    expect(migration).toContain('snooze_count');
  });

  it('task delete sync RPC owns delete_mode validation in its own SQL function body', () => {
    const migration = read('supabase/migrations/20260430100000_sync_rpc_project_and_delete_coverage.sql');
    const start = migration.indexOf('CREATE OR REPLACE FUNCTION public.sync_delete_tasks(payload JSONB)');
    const end = migration.indexOf('GRANT EXECUTE ON FUNCTION public.sync_delete_tasks(JSONB)', start);
    const body = migration.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(body).toContain("v_delete_mode TEXT := COALESCE(NULLIF(payload->>'delete_mode', ''), 'purge');");
    expect(body).toContain("IF v_delete_mode NOT IN ('soft', 'purge') THEN");
    expect(body).toContain("IF v_delete_mode = 'soft' THEN");
  });

  it('keeps the pre-baseline optimization migration schema-independent for clean database pushes', () => {
    const migration = read('supabase/migrations/20260126000000_database_optimization.sql');

    expect(migration).toContain('Compatibility placeholder');
    expect(migration).not.toMatch(/\b(?:CREATE|DROP|ALTER|ANALYZE)\b[\s\S]*?\bpublic\.(?:connection_tombstones|task_tombstones|quarantined_files|black_box_entries|tasks|connections|projects)\b/i);
  });

  it('guards retired cloud backup migrations for clean database pushes', () => {
    const retiredBackupMigrationPaths = [
      'supabase/migrations/20260315210000_full_optimization_audit_fixes.sql',
      'supabase/migrations/20260315220000_advisor_driven_full_optimization.sql',
      'supabase/migrations/20260318140000_mcp_advisor_full_remediation.sql',
      'supabase/migrations/20260318180000_final_advisor_unindexed_fk_repair.sql',
      'supabase/migrations/20260318193000_readd_backup_fk_covering_indexes.sql',
      'supabase/migrations/20260322090113_backup_metadata_payload_v2.sql',
      'supabase/migrations/20260322143921_remove_cloud_backup_infrastructure.sql',
    ];
    const directRetiredBackupStatements =
      /^\s*(?!EXECUTE\s)(?:ALTER TABLE|CREATE(?:\s+UNIQUE)?\s+INDEX|ANALYZE|DROP\s+TRIGGER|DROP\s+POLICY|COMMENT\s+ON\s+(?:COLUMN|INDEX)|UPDATE|REVOKE|GRANT)\b.*\b(?:public\.)?backup_(?:metadata|restore_history|encryption_keys)\b/im;

    for (const migrationPath of retiredBackupMigrationPaths) {
      const migration = read(migrationPath);
      const migrationWithoutDynamicSql = migration.replace(
        /EXECUTE\s+\$sql\$[\s\S]*?\$sql\$/g,
        'EXECUTE $sql$...$sql$',
      );

      expect(migration, migrationPath).toContain("to_regclass('public.backup_metadata')");
      expect(migrationWithoutDynamicSql, migrationPath).not.toMatch(directRetiredBackupStatements);
    }
  });

  it('guards optional pg_cron operations for clean database pushes', () => {
    const migration = read('supabase/migrations/20260319153259_personal_backend_slimdown.sql');

    expect(migration).toContain("to_regclass('cron.job')");
    expect(migration).toContain("to_regclass('cron.job_run_details')");
    expect(migration).not.toMatch(/^\s*DELETE\s+FROM\s+cron\.job_run_details\s*;/im);
    expect(migration).not.toMatch(/^\s*SELECT\s+public\.apply_backup_schedules\(\)\s*;/im);
  });

  it('creates access helper functions after the baseline schema before later migrations use them', () => {
    const advisorHardening = read('supabase/migrations/20260318073814_advisor_security_followup_hardening.sql');
    const personalBackendSlimdown = read('supabase/migrations/20260319153259_personal_backend_slimdown.sql');

    expect(advisorHardening).toContain('to_regprocedure(procedure_signature)');
    expect(advisorHardening).toContain("'public.current_user_id()'");
    expect(advisorHardening).toContain("'public.user_has_project_access(uuid)'");
    expect(advisorHardening).toContain("'public.user_is_project_owner(uuid)'");
    expect(advisorHardening).toContain("'public.user_accessible_project_ids()'");
    expect(advisorHardening).not.toContain('ALTER FUNCTION public.current_user_id() SET search_path');
    expect(advisorHardening).not.toContain('ALTER FUNCTION public.user_has_project_access(uuid) SET search_path');

    expect(personalBackendSlimdown).toContain('CREATE OR REPLACE FUNCTION public.current_user_id()');
    expect(personalBackendSlimdown).toContain('CREATE OR REPLACE FUNCTION public.user_is_project_owner(p_project_id uuid)');
    expect(personalBackendSlimdown.indexOf('CREATE OR REPLACE FUNCTION public.current_user_id()')).toBeLessThan(
      personalBackendSlimdown.indexOf('CREATE OR REPLACE FUNCTION public.user_accessible_project_ids()'),
    );
    expect(personalBackendSlimdown.indexOf('CREATE OR REPLACE FUNCTION public.user_is_project_owner(p_project_id uuid)')).toBeLessThan(
      personalBackendSlimdown.indexOf('CREATE OR REPLACE FUNCTION public.get_vault_secret(p_name text)'),
    );
  });

  it('Android TWA default origin no longer points at the retired Vercel host', () => {
    const gradle = read('android/app/build.gradle.kts');

    expect(gradle).not.toContain('https://dde-eight.vercel.app');
    expect(gradle).toContain('https://nanoflow.pages.dev');
  });
});
