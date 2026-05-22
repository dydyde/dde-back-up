# NanoFlow 迁移 Cloudflare Pages 策划案

> 版本：2026-05-18
> 适用项目：NanoFlow / Angular 19 重客户端 PWA  
> 目标：剥离 Vercel 托管与构建链路，将前端静态产物迁移到 Cloudflare Pages，并把构建、测试、Sentry Source Map 上传放到 GitHub Actions。  
> 约束：这是个人项目。迁移方案以可落地、低维护、可回滚为准，不引入面向团队/企业审计的重流程。

## 1. 执行结论

NanoFlow 适合迁移到 Cloudflare Pages；仓库侧 Direct Upload 发布链路已经落地，剩余工作集中在控制台配置、custom domain、真实登录回调和阶段 4 线上观察。

最终建议：

- **Cloudflare Pages** 只负责静态资源托管、边缘分发、预览环境、正式域名和生产部署回滚。
- **GitHub Actions** 负责 `npm ci`、测试、Angular production build、no-JIT 产物扫描、可选的 Sentry Source Map 上传、Wrangler Direct Upload。
- **Supabase 保持不迁移**，继续承载 Auth、PostgreSQL、Storage、Edge Functions。
- **Sentry 保持不迁移**，但首版迁移默认不上传 Source Map；迁移稳定后再启用 sourcemap 流程。
- **Vercel 保留 24-72 小时作为 DNS 回滚后备**，稳定后关闭自动部署或断开 Git integration。

### 1.1 当前执行快照（2026-04-29）

本地分支 `codex/cloudflare-cursor-consistency` 当前跟踪 `origin/codex/cloudflare-cursor-consistency`。本轮执行中 GitHub Connector 查询 PR 元数据失败，因此远端 PR 状态以本地 `origin/*` 引用为准，不能视为已经完成线上 PR 检查。

已完成的仓库侧迁移内容：

- Cloudflare Pages deploy workflow 与 dry-run workflow 已落地：test job 不读取部署 secret，deploy step 才读取 `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`，同仓 PR 才允许 preview deploy，fork PR 只跑无 secret 测试。
- `public/_headers`、`quality:guard:deploy-artifacts`、`quality:guard:build-deterministic`、`artifact-manifest.json`、`version.json`、`! Link`、无 `_redirects`、无公开 sourcemap、worker safety no-store、TWA assetlinks/fingerprint guard 已进入构建或 CI 门禁。
- `quality:guard:artifact-trends` 已接入 deploy / dry-run workflow：记录文件数、总大小、根 JS 数、`_headers` 规则数、`ngsw.json` asset 数和 GoJS/Flow chunk size；相对 main baseline 超过 15% warning、超过 30% fail-fast。部署浏览器 smoke 入口 `npm run smoke:cloudflare-playwright` 已补齐，并与 header smoke 一致：Cloudflare Pages 默认 SPA fallback 返回缺失 chunk 的 HTML 200 时，必须同时证明 `GlobalErrorHandler` chunk 自愈合同存在。
- Canonical Origin Gate 已提前到 `<head>` 早期同步执行，早于 resource hints / modulepreload / Angular bootstrap，并补齐一次性 SW unregister + `ngsw`/NanoFlow cache 清理和 `__NANOFLOW_WRITE_GUARD__` runtime 标记。
- `ngsw-config.json` 已移除 broad worker glob；生成物 guard 会检查 `worker-basic.min.js` / `safety-worker.js` 不进入 Angular SW assetGroups。
- Canonical Origin Gate、WriteGuard、migration recovery banner、sync RPC 客户端/数据库 RPC 草案、task/connection/blackbox RPC/CAS flag 接入、sync writer lease 队列接入和 Realtime circuit/fallback 相关单测已经存在；但删除/批量写保护、端到端 Realtime/LWW/游标 smoke 仍不能算阶段 2/3 验收完成。
- `scripts/validate-env.cjs` 已支持 Supabase `sb_publishable_*` browser build key，并显式拒绝 `sb_secret_*`；本轮用生产 Supabase URL + publishable key 完成 `build:strict` 与 artifact guard，且未把实际 key 写入 tracked diff。
- `scripts/set-env.cjs` 现在会把 Supabase preconnect / dns-prefetch hint 同步到 `NG_APP_SUPABASE_URL`，避免生产 bundle 使用新 Supabase 项目时仍预连旧项目。

配置后验证（2026-04-29 续跑）：

- Cloudflare 账号 ID / API Token / Pages 项目名已能被本地 `.env.local` 读取；`npx --yes wrangler@3.112.0 pages deployment list --project-name=nanoflow` 成功返回 production 部署，当前生产 deployment 为 `https://a34c65fd.nanoflow.pages.dev`，分支 `main`，source `b058899`。
- `https://a34c65fd.nanoflow.pages.dev` 与 `https://nanoflow.pages.dev` 的 `/version.json` 均读到 `gitSha=b05889949680553f3838a481f5410dfea91b8139`、`deploymentTarget=production`、同一 `ngswHash=5663bc774c9f...`。
- 生产环境校验 `npm run validate-env:prod` 通过；本地 `.env.local` 未提供 `NG_APP_GOJS_LICENSE_KEY`，因此本地校验仍提示 GoJS 水印警告，若生产 GitHub Secret 已配置则以 workflow build 环境为准。
- 部署产物校验 `npm run quality:guard:deploy-artifacts` 通过：`dist/browser` 150 files，无 `.map`、无 Pages Functions 入口、`_headers` 21 rules、`! Link`、worker safety、manifest origin-neutral、assetlinks package/fingerprint 与 artifact manifest 均通过。
- 线上 smoke：canonical `https://nanoflow.pages.dev` 已通过 `bash scripts/smoke/cloudflare-header-smoke.sh https://nanoflow.pages.dev`（PASS=23 / FAIL=0）、`PLAYWRIGHT_BASE_URL=https://nanoflow.pages.dev npm run smoke:cloudflare-playwright`、`PLAYWRIGHT_BASE_URL=https://nanoflow.pages.dev npm run smoke:cloudflare-e2e`（2 passed / 1 preview-only skipped）。浏览器 smoke 读到 `gitSha=b05889949680553f3838a481f5410dfea91b8139`，Service Worker API 可用且已有 1 个注册；缺失 chunk 当前走 Pages SPA fallback，但本地 chunk 自愈合同通过。
- 本地网络环境会把 `nanoflow.pages.dev` DNS 解析到代理保留网段 `198.18.0.85`；`scripts/smoke/cloudflare-playwright-smoke.cjs` 与 `playwright.config.ts` 已显式继承 `PLAYWRIGHT_PROXY` / `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` 并尊重 `NO_PROXY`，避免 Playwright APIRequestContext 直连 fake IP 超时。
- 已配置项不再作为仓库侧阻塞；Supabase Auth / Email Templates 控制台项已由人工完成，Edge Function CORS 已发布并通过 `nanoflow.pages.dev` 预检 smoke。阶段 2 preview / custom domain 的 Realtime 弱网、多标签 single-writer、Storage SW dataGroups、GoJS 大图和阶段 4 稳定观察仍属于端到端迁移验收，不能被 pages.dev production smoke 替代。

2026-04-30 续跑补充：

- 仓库侧补齐 Project upsert/delete 与 task batch delete/purge 的 sync RPC 覆盖：新增 `sync_upsert_project`、`sync_delete_project`、`sync_delete_tasks`，并让客户端在 `NG_APP_SYNC_RPC_ENABLED` 下通过 RPC/CAS 处理 Project、task position fallback、soft delete batch 和 purge，避免删除/批量写继续绕过服务端写入保护。
- `index.html` early gate 增加 `/version.json.ngswHash` 探测；`ngswHash` 不匹配时进入一次性 `export-only` 写闸、unregister 旧 SW、清理 `ngsw`/NanoFlow cache 后刷新，避免旧 SW 继续服务旧 shell 并 flush 队列。
- Realtime 与迁移观测性补齐：Supabase client 明确 `worker: true`、`workerUrl=/worker-basic.min.js`、`heartbeatCallback`，heartbeat 异常写入 Sentry breadcrumb；sync writer lease acquire/release/fallback 与 migration recovery banner export/dismiss 均写入 breadcrumb。
- 本轮验证通过：`npm run lint`、`npm run test:run:ci`、受影响 7 个 Vitest spec、`npm run build:strict`、`npm run quality:guard:deploy-artifacts`、`npm run quality:guard:env-flags`、`npm run perf:guard:nojit`、`npm run quality:guard:font-contract`、`npm run quality:guard:supabase-ready`、`npm run quality:guard:artifact-trends`、`npm run quality:guard:build-deterministic`、本地 `wrangler pages dev dist/browser --port 8788` header smoke。
- Fresh online smoke（注意：验证的是当前线上部署，不代表本地分支已发布）通过：`bash scripts/smoke/cloudflare-header-smoke.sh https://nanoflow.pages.dev`（PASS=23 / FAIL=0）、`PLAYWRIGHT_BASE_URL=https://nanoflow.pages.dev npm run smoke:cloudflare-playwright`（读到 `gitSha=49372daca499bb62e689fbc8604377cceff01be8`）、`PLAYWRIGHT_BASE_URL=https://nanoflow.pages.dev npm run smoke:cloudflare-e2e`（2 passed / 1 preview-only skipped）。
- `npx supabase db push --dry-run` 确认仅需发布 `20260429080000` 与 `20260430100000`；随后 `npx supabase db push --yes` 已成功应用两条 sync RPC migration。复查 `npx supabase migration list` 显示本地/远端已对齐，并用 `npx supabase db query --linked` 确认 `sync_operation_log`、`sync_protocol_state`、`sync_upsert_task(jsonb)`、`sync_upsert_project(jsonb)`、`sync_delete_tasks(jsonb)` 存在。
- 发现 `20260126000000_database_optimization.sql` 在 clean database push 中早于 baseline schema 创建却引用 `public.connection_tombstones` 等表，已改为 remote history compatibility placeholder；依赖该历史迁移创建的 access helper 已移到 post-baseline migration，advisor `ALTER FUNCTION` 改为按 `to_regprocedure` guard 执行，并补合同测试防止再次把 pre-baseline migration 写成 schema-dependent。`npx supabase db diff --linked --schema public` 仍被本机 Docker daemon 缺失阻塞，需要在 Docker/Supabase CI 环境完成 shadow database diff。
- 沙盒库 direct `db push --db-url` 会从空 migration history 重放全部 active migrations；已将退役 cloud-backup 表（`backup_metadata` / `backup_restore_history` / `backup_encryption_keys`）相关历史优化/删除迁移改为 `to_regclass` guard + 动态 SQL，有表的旧库继续执行兼容清理，干净库不会因已退役表缺失而中断。对应合同测试 `guards retired cloud backup migrations for clean database pushes` 已覆盖。
- 同一 clean push 又暴露沙盒库没有 `cron.job_run_details`；`20260319153259_personal_backend_slimdown.sql` 已将 pg_cron 调度、`job_run_details` 清理和运行期 helper 改为 `to_regclass('cron.job')` / `to_regclass('cron.job_run_details')` guard。无 pg_cron 的沙盒库跳过定时任务注册，有 pg_cron 的旧库继续注册清理任务；合同测试 `guards optional pg_cron operations for clean database pushes` 已覆盖。
- Supabase Edge Function CORS 发布完成：`transcribe`、`widget-register`、`widget-summary`、`widget-notify`、`widget-black-box-action`、`widget-focus-action` 均通过 `--use-api` 部署；`OPTIONS` live smoke 对 `Origin: https://nanoflow.pages.dev` 均返回 `200` 与 `Access-Control-Allow-Origin: https://nanoflow.pages.dev`。
- Auth 邮件跳转 helper 继续收口：`AuthService.signUp()` 已为注册确认邮件写入 canonical `emailRedirectTo=https://nanoflow.pages.dev/auth/callback`，与 password reset redirect 共用生产 canonical origin helper；用户已完成 Supabase Dashboard Site URL / Redirect URLs / Email Templates 审查，Magic Link / OAuth 真实回调仍需在登录窗口 smoke。
- 旧 origin / export-only 本地写保护继续收口：`TaskOperationAdapterService` 与 `ProjectOperationService` 已接入 `WriteGuardService.isExportOnly()`，在旧入口导出模式下阻断新增、编辑、移动、删除、项目元数据更新等本地 mutation，不创建乐观快照、不标记本地变更；RetryQueue / ActionQueue 云端 flush 仍由 `assertWritable()` 阻断。
- 新增手动 `vercel-prebuilt-recovery.yml`：仅 `workflow_dispatch`，默认构建 `legacy-export-only` 旧 Vercel artifact（`NG_APP_DEPLOYMENT_TARGET=vercel-legacy`、`NG_APP_ORIGIN_GATE_MODE=export-only`），只有 `deploy=true` 且输入确认 token 后才执行 `vercel pull` / `vercel build` / `vercel deploy --prebuilt --prod`。
- Realtime 迁移观测性继续收口：通道错误与降级到轮询分别写入 `realtime_channel_error`、`realtime_fallback_polling_started` breadcrumb；heartbeat timeout/disconnected 仍由 Supabase client heartbeat breadcrumb 记录。

### 1.2 当前审查与完成状态（2026-05-18）

本轮复核结论：仓库侧 Cloudflare Pages Direct Upload 迁移主链路已经可以作为默认生产发布路径；继续阻塞“完全收口”的不是仓库内缺少部署脚本，而是控制台/线上环境类验证，例如 GitHub Secrets、custom domain、真实 Auth 回调、弱网 Realtime、多标签 single-writer 和阶段 4 观察窗口。

已完成并复核的最佳实践项：

- **远端数据库同步更新已完成**：生产 Supabase 项目 `fkhihclpghmmtbbywvoj` 已应用 `20260518162000_external_source_links_stale_write_protection.sql`；MCP 复查 `prevent_external_source_links_stale_write` 函数存在，`trg_external_source_links_prevent_stale_write` 触发器存在且启用。该项补上 SiYuan / external source 指针的服务端 stale-write 最后防线，避免旧离线 pending upsert 回滚较新的 `role`、`sort_order`、`deleted_at`。
- **Cloudflare 官方约束复核通过**：Context7 查询到的 Cloudflare Pages 文档仍以 Wrangler / API Token / Account ID 作为 Direct Upload CI 主路径；`_headers` 的 `! Link` 是关闭自动 Link header 生成的官方写法；`_headers` 仍有 100 条规则上限；Pages Functions 存在时不支持 Dashboard Direct Upload。当前仓库选择 `wrangler@3.112.0`、`public/_headers`、`dist/browser`、无 Pages Functions 的静态 SPA 路径与这些约束一致。
- **CI/CD 实现优先级正确**：`.github/workflows/deploy-cloudflare-pages.yml` 已拆分 secret-free test job 与 build/deploy job；Cloudflare token 只出现在 deploy step；deploy 后等待 `/` 与 `/version.json` 健康，再跑 header smoke。`.github/workflows/deploy-cloudflare-pages-dry-run.yml` 可在不读取发布 token 的情况下跑 deterministic build、artifact guard 和本地 Pages smoke。
- **预览环境策略已从早期 `PREVIEW_*` 草案收敛为 GitHub Environment**：当前事实源是 `NanoFlow-Preview` 环境中同名 `NG_APP_SUPABASE_URL` / `NG_APP_SUPABASE_ANON_KEY` secrets；合同测试明确禁止 `PREVIEW_NG_APP_*` 和生产 fallback 表达式进入 workflow。这比 `PREVIEW_* || PROD_*` 更不容易误把 PR preview 打到生产项目。
- **PWA / 缓存 / 产物门禁已落地**：`public/_headers` 使 app shell、`ngsw.json`、SW 脚本、`version.json` no-store，hash bundle immutable，非 hash public assets revalidate；artifact guard 覆盖 `version.json`、`artifact-manifest.json`、TWA assetlinks、无 `_redirects`、无 sourcemap、无 Pages Functions、安全 worker 不进 `ngsw.json`。
- **Vercel 已降级为应急回滚路径**：`vercel-prebuilt-recovery.yml` 仅允许 `workflow_dispatch`，默认生成 `legacy-export-only` artifact，且需要确认 token 才会执行 `vercel deploy --prebuilt --prod`；这符合“Vercel 只保留短期回滚，不再作为推荐生产构建平台”的目标。

仍需人工/线上验收的项：

- GitHub Settings 中 Cloudflare、Supabase、GoJS、Sentry、TWA fingerprint secrets 是否完整写入，必须在仓库外确认。
- custom domain / TLS / DNS / zone rules 尚未在本轮验证；`nanoflow.pages.dev` 可作为生产 smoke origin，但 custom domain active 后必须再次跑 header smoke、Playwright smoke，并收敛 `pages.dev` 的生产写入入口。
- Auth Magic Link / OAuth 真实回调、Supabase Storage CORS、Edge Function CORS 在最终 custom domain 上仍需 live smoke。
- Realtime 弱网、后台标签页、BlackBox 独立 realtime、同时间戳 cursor、多标签 single-writer、Flow 大图性能和 stale SW 负向路径仍属于端到端迁移验收，不应被静态合同测试替代。
- Sentry 生产 environment 的 `heartbeat_timeout`、`realtime_fallback_polling_started`、`remote_newer_conflict`、`ghost_write_rejected`、`stale_layout_dropped` 等指标，需要在阶段 4 观察窗口确认。

迁移后建议：

- README 和部署入口以 **Cloudflare Pages + GitHub Actions Direct Upload** 作为默认推荐；Vercel / Netlify / Railway 保留为备选或回滚说明，不再写“Vercel（推荐）”。
- 首版继续保持 `ENABLE_SENTRY_SOURCEMAPS=false`；只有完成 post-inject rename 或 JS cache 降级方案后，才启用 Sentry Source Map inject/upload。
- custom domain 生效后，按“先 Pages URL smoke，再 custom domain smoke，再移除 `pages.dev` 写入 allow-list”的顺序收口，不把 `pages.dev` 留成第二个生产入口。
- Vercel 回滚窗口结束后，关闭 Vercel 自动部署或仅保留手动 recovery workflow；旧域若继续可访问，必须是 export-only/read-only。
- 稳定 7 天后再刷新性能基线；稳定 6 个月内做一次 Workers Static Assets non-production dry-run，确认未来仍有迁移退路。

迁移动因不是“Vercel 不能托管 Angular”，而是当前项目的计算和风险边界不适合继续绑在 Vercel Git 构建上：

- NanoFlow 是 Angular SPA + PWA + Supabase BaaS，不使用 Vercel 的 SSR、ISR、Route Handlers 或 Serverless 主路径。
- 构建成本主要来自 Angular AOT、PWA 产物、no-JIT 扫描、Sentry sourcemap、GoJS 相关 chunk 和测试门禁。
- 这些工作更适合 GitHub Actions 这类 CI 执行；托管平台只接收静态产物并做 CDN 分发。

本计划把迁移视为既定方向。Vercel 构建分钟数耗尽不是“是否迁移”的判断条件，而是迁移前必须修复的发布链路弊病：在正式切换前，先把 Vercel 的无效构建、构建额度和应急发布能力收敛好，确保迁移窗口内仍能发布、验证和回滚。

必须修正的审查点：

- Cloudflare Pages + Wrangler Direct Upload 在当前官方 CI 文档中仍以 `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` 作为非交互认证方式。不要把 GitHub OIDC 写成当前可执行门禁。可以作为未来升级方向，但本次落地使用最小权限、可轮换的 Cloudflare Account API Token。
- Cloudflare Pages 的生产回滚应使用 Pages Dashboard 或 Pages Deployments Rollback API。`wrangler rollback` 是 Workers 版本回滚命令，不应写成 Pages 的主回滚路径。
- WAF、GDPR、SOC 2 审计包不是这个个人项目迁移的必要路径。可以保留“不要误开 Under Attack Mode / 全局 Challenge”的安全提醒，但不需要建立企业合规流程。
- Sentry `sourcemaps inject` 会修改部署用 JS。Angular Service Worker 的 `ngsw.json` 在 build 时记录文件内容 hash；如果 inject 后不重建 `ngsw.json`，PWA 缓存完整性会失配。这是上线阻断项。
- 如果从旧 Vercel 默认域迁到新 custom domain，IndexedDB/localStorage/Service Worker/PWA 安装状态不会跨 origin 自动迁移。迁移前必须确认云端同步队列清空，或先导出本地数据。
- 生产环境必须只有一个 canonical writable origin。`pages.dev`、apex、`www`、`app` 子域和旧 Vercel 默认域不能都承载完整可写 PWA；非 canonical origin 必须在最早期脚本进入 redirect 或 read-only/export-only，且禁止注册 Service Worker、初始化 Supabase、flush RetryQueue/ActionQueue。
- 同一 custom domain 从 Vercel 切到 Cloudflare 时也会有 DNS 分裂脑。DNS TTL 和递归缓存收敛前，同一个 origin 可能命中两套托管；割接前必须把同一份构建产物部署到 Vercel 和 Cloudflare，先迁移托管层，不同时升级业务版本。
- PR preview 的 Supabase 环境变量不能用 `PREVIEW_* || PROD_*` 静默 fallback。缺少 preview Supabase secret 时必须 fail-fast；生产 Supabase opt-in 只有在 READ_ONLY_PREVIEW、应用 fail-closed、RLS/RPC 隔离和自动清理都落地后才允许。
- PR preview 默认必须使用独立 Supabase Preview Project。生产 Supabase + preview-bot 只能作为临时例外，并且必须同时有 `READ_ONLY_PREVIEW=true`、应用层 mutation fail-closed、RLS/RPC 隔离 namespace 和自动清理；否则 preview URL 就是另一个生产入口。
- Angular 当前产物包含 `worker-basic.min.js` / `safety-worker.js` 这类非 hash 安全 worker，必须 no-store；不要用静态 `/worker*.js` 或 `/worker-*.js` 长缓存规则，因为 `/worker-*.js` 仍会命中 `worker-basic.min.js`。应用 Web Worker chunk 只有在构建后生成精确文件名 header 时才能长期缓存。
- `ngsw-config.json` 当前 `app-lazy` 仍包含 `/worker*.js`，即使 `_headers` 给 `worker-basic.min.js` no-store，Angular Service Worker 仍可能把安全 worker 纳入 assetGroups。阶段 1 必须改 `ngsw-config.json` 或增加生成后 guard，检查 `dist/browser/ngsw.json` 不含 `worker-basic.min.js` / `safety-worker.js` 的长期资产条目。
- 当前 `public/fonts/**`、`public/icons/**` 的文件名不是内容 hash。`/assets/*`、`/icons/*`、`/fonts/*` 不能默认 `immutable`；除非文件名改成 hash/versioned，否则这些公开静态资源必须 revalidate。
- Sentry inject 后 JS 内容改变但文件名 hash 不会自动重算；在没有 post-inject rename 能力前，启用 inject 的 JS 不能走长期 immutable。首版默认禁用 sourcemap inject 是发布链路门禁，不只是安全偏好。
- Cloudflare Pages Early Hints 会自动从 HTML 的 `preload` / `preconnect` / `modulepreload` 生成 `Link` header。首版迁移默认关闭自动 Link 生成（`! Link`），先稳定 PWA/chunk 加载；后续再用独立 PR 打开并验证真实 103 行为。
- Wrangler Direct Upload 从仓库根目录执行时可能识别根目录 `functions/`，不能只检查 `dist/browser/functions/`。CI guard 必须覆盖根目录和部署目录。
- Direct Upload API 成功不等于边缘立即可访问。每次 deploy 后必须对 `pages.dev` / preview branch URL 做等待式 health check，再进入 Playwright 或 custom domain smoke。
- `_headers` 最多 100 条规则；如果后续为 hash worker、字体、图标生成精确 header，CI 必须统计规则数并保留余量。
- 部署后 smoke 不能在 custom domain TLS/DNS active 前硬编码最终域名。首轮 production 先 smoke `https://<project>.pages.dev`，custom domain active 后再跑第二套 smoke。
- `https://<project>.pages.dev` 只是 production 首轮 smoke origin。custom domain active 且通过 smoke 后，必须把 `pages.dev` 从生产 Supabase Auth redirect、Edge Function CORS、Storage CORS 中移除或降为只读/redirect；不能留下第二个可写生产入口。
- Cloudflare zone-level Cache Rules/Page Rules/Transform Rules/Security Rules 可能覆盖 Pages `_headers` 与 SPA 行为。full DNS 或已接入 Cloudflare zone 时，阶段 0 必须盘点 app host 命中的 zone 规则，禁止 Cache Everything、HTML Edge TTL、响应体改写、JS/CSS 改写和全站 Challenge。
- Angular `@angular/build:application` 的 hash 产物是整个缓存策略的根基。阶段 1 必须增加 deterministic build probe：同一 commit、同一 Node/npm lockfile、同一 `NG_APP_*` 输入下两次 clean build 的 hashed JS/CSS 内容 hash、入口 chunk、`ngsw.json` 和 modulepreload 列表必须一致。不要把不存在或未暴露的 esbuild `seed` 当成门禁；若漂移，先定位 Node/Angular/Sentry/env/script 输入差异，再决定是否禁用对应优化。
- full DNS setup 不只迁 app。迁权威 DNS 前必须导出旧 zone 并比对 A/AAAA/CNAME、MX、TXT、CAA、NS、DS、SRV；CAA/ACME/MX/TXT 漏项会导致证书签发、邮件或第三方验证失败。
- Android TWA 不能只校验 `assetlinks.json` 的 package name；必须校验 dev/release/Play Signing 全部 SHA256 fingerprint。
- Supabase Realtime 必须按已开启路径处理。当前仓库 `FEATURE_FLAGS.REALTIME_ENABLED = true`，`RealtimePollingService` 已订阅 `postgres_changes`，`BlackBoxSyncService` 也有独立 `black_box_entries` Realtime channel；迁移验收必须覆盖 WebSocket 断线、重连、fallback polling 和本地 IndexedDB 合并一致性。
- Realtime 事件只能作为“有远端变化”的 invalidation 信号，不能绕过增量拉取、LWW、tombstone 和 dirty field 保护直接覆盖本地状态。游标只能在远端数据成功 merge 到 Signals store 且本地持久化成功后推进。
- Realtime 保持开启时，阶段 1 默认启用 `worker: true` + `heartbeatCallback`，把 heartbeat timeout / disconnected 接入 Sentry breadcrumb 并自动进入 polling fallback；若不能启用 worker，必须用显式例外记录原因并补后台标签页长时运行测试。
- Cloudflare Pages 不代理浏览器到 Supabase 的 Realtime WebSocket，不能把 Realtime 风险误写成“Cloudflare edge 代理 Supabase WS”。真正风险来自新 origin 上的长会话、移动/后台 timer throttling、不同网络路径和发布窗口；因此 smoke 要覆盖弱网/高延迟/后台恢复，并把 `heartbeat_timeout`、`realtime_disconnect`、`sync_queue_stuck` 作为 Sentry 指标。
- LWW 不等于普通 `upsert`。任务、连接、项目、BlackBox/Focus 等同步实体的云端写入必须有服务端条件写入或等价 CAS/RPC 保护，不能让离线旧写入重放后凭数据库 `updated_at = now()` 覆盖其他端的新写入。
- 同步游标门禁必须覆盖所有 `setLastSyncTime` / `lastSyncTime` 写入点，不只覆盖 Delta `checkForDrift()`。禁止用本地 `new Date()` 作为已拉取远端水位；cursor 必须是组合水位 `(updated_at, id)` / `(updated_at, entity_type, id)`，或短期用强制安全回看窗口兜底。
- 同一 origin 的多标签页不能同时 flush RetryQueue/ActionQueue 或提交 sync cursor。`TabSyncService` 的 BroadcastChannel 提醒不是强锁；阶段 1 必须引入 sync single-writer 方案或证明队列幂等且具备远端新版本保护。
- CAS/RPC 只能保护单行 LWW，不能替代队列契约。RetryQueue/ActionQueue 必须有 `operation_id`、同实体保序、跨实体依赖和 delete/tombstone barrier，覆盖 connection、attachment、focus recording 等跨实体场景。
- client-side Canonical Origin Gate 不是强安全边界。阶段 3 前必须有 server-side 写入保护：所有云端 mutation 通过 RPC/Edge Function 或等价受控路径，校验 `operation_id` 幂等、`syncProtocolVersion` / `deploymentEpoch`、base version 和 tombstone barrier；仍存在直接 PostgREST table mutation 且无法被 RLS/RPC 拦截时，不允许进入生产割接。
- 迁移后用户体验不能只靠“去旧站导出”。新域名首次打开应有一次性迁移状态提示：说明本地 origin 已变化、云端恢复/队列同步状态、PWA 可能需要刷新或重新安装；该提示的展示/完成/失败要进入 Sentry breadcrumb。
- GoJS 懒加载只解决首屏包体，不解决大图主线程阻塞。Flow 视图必须增加节点规模阈值、自动布局性能预算和降级策略；超阈值时默认 Text/降级 Flow，必要时把布局预计算迁出 UI 线程。
- OnPush + Signals 与 GoJS 这类直接操作 DOM 的库需要显式桥接门禁：高频图形事件留在 Angular zone 外，真正改变应用状态的事件必须通过 `NgZone.run()`、signal/effect 或等价桥接进入 Angular 响应式上下文。
- GoJS Worker/分片调度不能只写“迁出主线程”。异步布局结果必须带 generation / graph revision，过期结果必须丢弃；否则旧布局可能晚到并覆盖用户的新坐标。
- GoJS 性能 smoke 不能只从本地或单一区域看。至少对 Cloudflare `pages.dev` 与 custom domain 跑一次弱网/移动端 profile；若能接入远程浏览器，补亚洲/欧洲两个区域的 TTFB、chunk load 与 Flow 首开采样。

## 2. 当前仓库事实

| 项 | 当前状态 | 迁移含义 |
| --- | --- | --- |
| Angular builder | `@angular/build:application` | 浏览器产物位于 `dist/browser` |
| 生产输出 | `angular.json` 的 `outputPath` 为 `dist` | Wrangler 部署目录必须是 `dist/browser`，不是 `dist` |
| 静态资源目录 | `public/**` 会复制到输出根目录 | `_headers` 应放在 `public/`；`_redirects` 仅在需要显式 fallback 时放在 `public/` |
| PWA | `serviceWorker: ngsw-config.json` | 必须控制 `ngsw.json`、SW 脚本和 HTML 缓存 |
| `ngsw-config.json` worker 规则 | `app-lazy.resources.files` 当前含 `/worker*.js` | 该规则会覆盖 `worker-basic.min.js` 这类非 hash 安全 worker；阶段 1 必须改配置或生成后检查 `ngsw.json`，不能只依赖 `_headers` |
| SW 入口 | `main.ts` 注册 `sw-composed.js`，其内部加载 `ngsw-worker.js` | `sw-composed.js`、`ngsw-worker.js` 都不能长期缓存 |
| Angular 安全 worker | build 产物包含 `safety-worker.js` 与 `worker-basic.min.js` | 二者文件名不带内容 hash，必须 no-store；不要被 `/worker*.js` 或 `/worker-*.js` 宽泛长缓存规则命中 |
| 非 hash 公开资源 | `public/icons/icon-*.png`、`public/fonts/lxgw-wenkai-screen.css`、`public/fonts/lxgwwenkaiscreen-subset-*.woff2` | 文件名不是内容 hash；首版 `_headers` 应 revalidate，只有改成 hash/versioned 文件名后才能 immutable |
| Chunk 自愈 | `GlobalErrorHandler` 已处理 `ChunkLoadError`、动态 import 失败、JIT/DI version skew | 文档写“保持并验证现有机制”，不重复造一套 |
| 版本提示 | `workspace-shell.component.ts` 已监听 `SwUpdate.VERSION_READY` 并提示刷新 | 迁移验收要覆盖新版本提示和强制清缓存刷新 |
| Source Map | 生产配置当前没有开启 source map | 首版迁移默认关闭上传；启用时必须在 Sentry inject 后重建 `ngsw.json` 并删除 `.map` |
| 生产 origin | 可能同时存在旧 Vercel 默认域、Pages `pages.dev`、apex、`www`、`app` 子域等入口 | 必须选择唯一 canonical writable origin；非 canonical origin 进入 redirect/read-only/export-only，不能初始化 Supabase 或注册 SW |
| 同域 DNS 割接 | 若沿用同一 custom domain，Vercel 与 Cloudflare 在 TTL 收敛期可能同时服务同一 origin | 割接前两边部署同一份构建产物；DNS 稳定后再发布业务变更，避免同 origin 下不同前端版本抢同一 IndexedDB/队列 |
| CORS | 多个 Supabase Edge Function 有 CORS/origin 判断 | 迁移时要全量审查 `supabase/functions/**`，不只改 `transcribe`。`widget-black-box-action` 是独立实现，不等同于 `_shared/widget-common.ts`；每个函数必须单独审查 CORS、认证和授权逻辑 |
| Vercel 忽略构建 | `vercel.json` 已配置 `ignoreCommand` 指向 `scripts/vercel-ignore-step.sh` | 文档/非关键文件变更已能跳过 Vercel 构建；若分钟仍耗尽，说明主要消耗来自真实代码构建 |
| 环境变量注入 | `scripts/set-env.cjs` 在 `npm run config` 阶段写入 `src/environments/*` 和 `index.html` | Direct Upload 时 Cloudflare Dashboard 变量不会自动进入已构建 JS，必须在 GitHub Actions 构建阶段注入 `NG_APP_*` |
| Node 版本 | 现有 GitHub workflows 使用 Node 22，`netlify.toml` 仍是 Node 20，`package.json` engines 为 `>=18.19.0` | 首版迁移 workflow 固定 Node 22；是否收紧 `package.json` engines 作为独立基线决策 |
| Android TWA origin | `android/app/build.gradle.kts` 默认 `webOrigin` 仍指向 `https://dde-eight.vercel.app` | 阶段 1 必须纳入旧域名 inventory，按是否沿用 custom domain 决定更新 `NANOFLOW_WEB_ORIGIN` |
| Supabase Realtime | `FEATURE_FLAGS.REALTIME_ENABLED = true`，`RealtimePollingService` 订阅 Supabase `postgres_changes` 并有 polling fallback | 迁移必须验收当前 realtime-on 路径；WebSocket 断线、重连、fallback polling 都进入 smoke/回归 |
| Focus / BlackBox Realtime | `BlackBoxSyncService` 独立订阅 `black_box_entries`，维护自己的 `lastSyncTime` 与 IndexedDB cursor | §6.4 的 invalidation、LWW、tombstone、cursor-after-persist 门禁必须同样覆盖 `BlackBoxEntry.updatedAt` / `deletedAt` |
| 云端同步写入 | 任务、连接等路径存在直接 `upsert`；数据库触发器会把 `updated_at` 刷成服务端当前时间 | 阶段 1 必须改成条件写入/RPC 或等价 CAS，避免离线旧写重放后“变新”覆盖远端新行 |
| Delta 同步游标 | `SimpleSyncService.checkForDrift()` 当前会推进 `lastSyncTimeByProject`，调用方 merge 失败时存在跳过变更的风险 | 阶段 1 必须把 cursor commit 移到 merge + IndexedDB 持久化成功之后，或用等价事务门禁证明不会丢变更 |
| 非 Delta 游标写入 | `SyncCoordinatorService.refreshActiveProjectSilent()` 等路径也会提交 `lastSyncTime`，且可能使用本地当前时间 | 阶段 1 必须 inventory 全部游标写入点，统一为“远端 watermark 候选值 -> 持久化成功 -> commit” |
| timestamp-only cursor | 仅保存 `max(updated_at)` 且下一轮用 `updated_at > cursor` 会漏掉同时间戳未处理行 | 阶段 1 优先升级组合 cursor；短期必须强制安全回看窗口和去重，不能只写“必要时” |
| 队列跨实体顺序 | 单行 CAS/RPC 不表达 task/connection/attachment/focus recording 之间的操作依赖 | Mutation 必须有 `operation_id`、base version、依赖关系和 tombstone barrier，重试/接管不能重排破坏拓扑 |
| 多标签同步写入 | `TabSyncService` 是 BroadcastChannel 协调，不是 RetryQueue/ActionQueue 的强 single-writer 锁 | 同一 origin 同一用户只允许一个同步写入者；旧/新 origin 仍必须靠 read-only/export-only 切断双写 |
| GoJS zone 边界 | GoJS 初始化大量使用 `runOutsideAngular()`，状态性事件通过 `zone.run()` 回到 Angular | 迁移验收要覆盖 Flow 选择、拖拽、连线、主题/详情面板等桥接路径，避免 OnPush 下 UI 状态不刷新 |
| Flow 自动布局 | `flow-layout.service.ts` 的 auto layout 与位置写回仍在主线程同步执行 | 迁移 smoke 不能只测 lazy chunk；必须增加大图性能采样、长任务阈值、异步布局 generation/stale-result 丢弃和降级/Worker 后续决策 |

## 3. 目标架构

```text
Browser / PWA / TWA
  ├─ Canonical Origin Gate
  ├─ Angular Signals + OnPush UI
  ├─ IndexedDB local-first cache
  ├─ Supabase Realtime invalidation + polling fallback
  ├─ RetryQueue / ActionQueue / LWW sync / tombstones
  ├─ GoJS lazy flow rendering + large-graph degradation
  └─ Sentry lazy monitoring

Supabase
  ├─ Auth
  ├─ PostgreSQL + RLS
  ├─ Storage
  └─ Edge Functions

GitHub Actions
  ├─ npm ci
  ├─ tests / contracts
  ├─ Angular production build
  ├─ no-JIT / PWA artifact guards
  ├─ optional Sentry source maps
  └─ wrangler pages deploy dist/browser

Cloudflare Pages
  ├─ Static assets CDN
  ├─ SPA fallback / custom domain / TLS
  ├─ Preview branch deployments
  └─ Production deployment rollback
```

这次迁移不改变 NanoFlow 的 Local-First 主路径。读路径仍是 IndexedDB 优先，后台增量拉取；写路径仍是本地落盘、UI 即时更新、3s 防抖推送、失败进入 RetryQueue/ActionQueue，冲突继续使用 LWW。Supabase Realtime 在当前仓库是已开启路径，只能用来触发增量拉取/重试探测，不能替代 LWW 合并、tombstone 和本地持久化确认。

### 3.1 Vercel 弊病修复与 Cloudflare 目标态

| 维度 | Vercel 现状/过渡修复 | Cloudflare Pages 目标态 |
| --- | --- | --- |
| 架构匹配 | 更适合 Next.js SSR/ISR、Route Handlers、Serverless Functions | 更适合静态 SPA/PWA、全球 CDN、Direct Upload |
| 构建分钟数 | Git 集成构建会持续消耗 Vercel build minutes；可用 `vercel build` + `deploy --prebuilt` 绕开 | GitHub Actions 承担构建，Pages 只接收静态产物 |
| 预览体验 | Vercel Preview DX 很成熟，PR 体验简单 | Wrangler preview branch 也可用，但要自己组织 Actions 输出和注释 |
| 环境变量 | Vercel 构建时注入较顺手 | Direct Upload 下 Cloudflare 变量不参与 GitHub Actions 构建；要用 GitHub Secrets |
| SSR/Node 兼容 | 完整 Node/Serverless 生态更自然 | Pages Functions/Workers 是边缘运行时，不等于完整 Node；本项目不使用它作为主路径 |
| 流量与静态分发 | 能用，但不是本项目的差异化收益 | 静态资源分发、缓存、DDoS 防护和全球边缘网络是强项 |
| 迁移窗口价值 | 保留为回滚后备，并修复构建额度耗尽导致的发布阻塞 | 承接正式生产流量，成为长期托管目标 |

对 NanoFlow 的判断：

- Vercel 的止血修复是迁移前置任务，不是替代路线。
- 如果迁移窗口内需要恢复发布，可以临时让 Vercel 使用 GitHub Actions + `vercel deploy --prebuilt`，但这只保留到 Cloudflare production 稳定。
- 首版目标仍是 Cloudflare Pages Direct Upload + GitHub Actions，降低构建和托管平台耦合；长期平台演进要预留 Workers Static Assets 迁移口子，避免 6-12 个月后再做一次无准备的二次迁移。
- 不建议把 Cloudflare Workers/Pages Functions 当成 Supabase Edge Functions 的替代品。迁移范围限定为前端静态托管和发布链路。

### 3.2 迁移执行常量

为避免 workflow 片段和验收清单散落魔数，本文统一使用以下迁移常量：

| 常量 | 值 | 用途 |
| --- | --- | --- |
| `WRANGLER_VERSION` | `3.112.0` | 当前安全 pin 版本；`3.114.0` 在 `nodejs_compat` 路径上存在已知部署故障，升级必须通过独立 PR 和 `wrangler pages dev/deploy` dry-run |
| `SENTRY_CLI_VERSION` | `2.58.2` | 首版 sourcemap inject/upload pin 版本；不是为了规避已知漏洞，而是避免 `latest` 漂移，后续升级需显式验证 Debug ID 与 `ngsw.json` 流程 |
| `HSTS_STABILIZATION_WINDOW` | `7 天` | Cloudflare TLS 与所有相关子域稳定观察窗口；首版迁移不启用 HSTS |
| `ROOT_JS_ARTIFACT_ALLOW_PATTERN` | `^(main\|polyfills\|chunk\|worker\|runtime)-\|^(sw-composed\|ngsw-worker\|safety-worker\|worker-basic\.min)\.js$` | 根目录 JS 产物 allow-list；它不是缓存分类器。`runtime-` 是防御性兜底（`@angular/build:application` 走 esbuild，当前不会产出独立 `runtime-*.js`，仅在未来切回 webpack 或第三方 bundler 时才会出现）；`worker-basic.min.js` 虽然匹配 `worker-` 前缀，但必须由精确 no-store 规则覆盖，禁止静态 `/worker-*.js` immutable 规则；新增 root JS 入口时必须同步更新 |

## 4. Cloudflare Pages 方案

### 4.1 Direct Upload + GitHub Actions

采用 Cloudflare Pages Direct Upload，由 GitHub Actions 构建完成后调用 Wrangler 上传 `dist/browser`。

理由：

- 避免 Cloudflare Pages 内置构建的 20 分钟 Free plan 超时和每月构建次数限制。
- 保留 GitHub Actions 的白盒流水线，方便插入测试、Source Map、no-JIT 扫描和部署后 smoke。
- NanoFlow 是静态 SPA，不需要 Vercel SSR/ISR/Serverless，也不需要 Cloudflare Pages Functions 承载主业务。

约束：

- Direct Upload 项目创建后不能直接切换成 Git integration；未来如果要改 Cloudflare 自动拉 Git，需要新建 Pages 项目。
- Pages Direct Upload 与 Workers Static Assets 也不是无缝原地升级关系；若未来迁到 Workers，需要新建 Worker 配置、重新验证 custom domain、SPA fallback、`_headers`/`_redirects`、assets binding 和 rollout。
- Direct Upload 项目没有常规 production branch controls。创建后应确认 production branch 是 `main`；必要时用 Cloudflare Pages API 更新一次。
- Wrangler Direct Upload 单次项目限制按 Pages 官方限制执行：Free plan 站点最多 20,000 文件，单文件 25 MiB。NanoFlow 当前静态产物满足此限制；Source Map 不应公开部署。

### 4.1.1 为什么不优先选 Connect to Git

Cloudflare Pages 的 Git integration 也能部署 Angular，但本项目不优先使用它：

- 它会把“构建”和“托管”重新耦合到 Cloudflare，和本次迁移目标相反。
- Pages Free plan 内置构建有构建时长和次数限制，重型 Angular AOT + 测试门禁仍可能撞上平台边界。
- Direct Upload 项目创建后不能切 Git integration；Git integration 项目也不能切 Direct Upload。选型应一次选对。
- 本项目需要在同一条流水线里插入 `npm run test:run:ci`、`npm run build:stats`、`npm run perf:guard:nojit`、可选 Sentry sourcemap 和部署后 smoke，这些更适合 GitHub Actions。

如果只是想快速验证 Cloudflare Pages 能否分发静态产物，可以先用 dashboard drag-and-drop 创建 Direct Upload 项目的首个空部署，再让 GitHub Actions 接管后续部署。

### 4.1.2 Workers Static Assets 备选路径

Cloudflare 官方已经提供 Pages → Workers Static Assets 的迁移指南，Workers 支持更宽的运行时能力和完整 Workers 生态；但 NanoFlow 首版仍不把 Workers 作为主路径，原因是当前需求是静态 SPA/PWA 分发，直接引入 Worker runtime 会扩大路由、计费、headers 和 observability 变量。

阶段 0 必须做一次轻量评估，结论写入迁移 PR：

- 当前是否需要 Worker-only 能力：Durable Objects、Queues、Rate Limiting、Smart Placement、Workers Observability、路径级 Worker code-first routing。若答案为否，首版继续 Pages。
- 若 6 个月内可能需要 edge logic，先准备 Workers Static Assets dry-run 分支，不要等生产 Pages 稳定后临时改架构；当前仓库已用 `wrangler.workers-static-assets.dry-run.toml` 固化这个备选入口。
- Workers 备选配置使用 `dist/browser`，而不是重新设计构建输出；只允许 dry-run workflow 调用，不进入 production deploy：

  ```toml
  name = "nanoflow-workers-static-assets-dry-run"
  main = "cloudflare/workers-static-assets/shell-worker.js"
  compatibility_date = "2026-05-18"
  workers_dev = false

  [assets]
  directory = "./dist/browser"
  binding = "ASSETS"
  not_found_handling = "single-page-application"
  run_worker_first = ["/*"]
  ```

- 备选配置不得进入首版 production deploy。dry-run Worker 只代理 `env.ASSETS.fetch(request)` 并补齐 `_headers` 中的关键 freshness/security 语义，包括 no-store app shell、删除 `Link` header、hash bundle immutable、非 hash public assets revalidate。阶段 4 稳定后 6 个月内再用同一份 deterministic artifact 执行一次 non-production Workers dry-run，验证 SPA deep link、missing asset、SW 更新、`version.json`、TWA assetlinks 和 Supabase Auth callback。
- 如果未来从 Pages 迁到 Workers，必须重新处理 custom domain：Workers custom domain 要求域名 nameserver 由 Cloudflare 管理；这会影响“仅子域 CNAME”的最小迁移路径。

### 4.2 输出目录

必须部署：

```text
dist/browser
```

不要部署 `dist` 根目录。Cloudflare Angular 官方指南也提示部分 Angular 版本实际 build directory 是 `dist/<app>/browser`；本仓库 `angular.json` 对应的是 `dist/browser`。

### 4.3 SPA 路由回退

Cloudflare Pages 对没有顶层 `404.html` 的项目有默认 SPA fallback 行为，会把未命中文件的路径交给根入口处理。因此本迁移的首选策略是：

- 不新增顶层 `404.html`。
- 先依赖 Cloudflare Pages 默认 SPA fallback。
- Preview 中按下面**客观判定脚本**确认默认 fallback 是否满足需求，再决定是否引入 `_redirects`。

**判定脚本（preview 部署完成后必跑）**：

```bash
ORIGIN=https://<pr-number>.<project>.pages.dev
# 1) deep link 必须返回 HTML，且不是 Cloudflare 404 页
#    判定：状态码 200 + Content-Type 含 text/html + body 含 Angular 入口标记（例如 <app-root> 或 <ng-container>）
HTTP=$(curl -s -o /tmp/deep.html -w "%{http_code}" "$ORIGIN/projects")
CT=$(curl -sI "$ORIGIN/projects" | tr -d '\r' | awk -F': ' 'tolower($1)=="content-type"{print $2}')
grep -q '<app-root\|<ng-container\|ng-version' /tmp/deep.html || echo 'FAIL: deep link did not return Angular shell'
[ "$HTTP" = "200" ] || echo "FAIL: deep link returned $HTTP"
echo "$CT" | grep -qi 'text/html' || echo "FAIL: deep link Content-Type=$CT"

# 2) 静态资源不能被 fallback 吞成 HTML
JS_CT=$(curl -sI "$ORIGIN/main-XXXXXXXX.js" | tr -d '\r' | awk -F': ' 'tolower($1)=="content-type"{print $2}')
echo "$JS_CT" | grep -qi 'javascript' || echo "FAIL: hashed JS returned $JS_CT (likely SPA fallback over-matched)"
```

**进入 `public/_redirects` 路径的触发条件**（任一成立即引入）：

1. 上面的 deep link 判定输出 `FAIL`（即默认 fallback 没把 `/projects` 接到 Angular 入口）；
2. Cloudflare Pages 在 PR preview 把未命中路径交给真实 404 页，而不是 `index.html`；
3. 后续添加了顶层 `404.html`（例如做静态错误页，与 Cloudflare 默认行为冲突）。

满足上述任一条件再添加 `public/_redirects`：

```text
/* /index.html 200
```

添加后必须**重跑**上面同一份判定脚本，重点检查第二条："hashed JS Content-Type"。常见误配：写成 `/* /index.html 200` 但没排除静态资源前缀，导致 `_redirects` 覆盖率高于默认 fallback，把 `*.js` / `*.css` 也代理成 HTML。判定脚本里 `JS_CT` 是检测这种回归的关键。

要求：

- `/projects` 返回 `200` 且由 Angular 接管（body 含 `<app-root>` 或 `ng-version` 标记）。
- JS 文件返回 `Content-Type: application/javascript`，不能返回 `text/html`。
- 不要新增顶层 `404.html`，否则会改变 Pages 的默认 SPA 行为。

### 4.4 缓存头

`public/_headers` 应避免“一刀切 `/*.js` 长缓存”，因为 `ngsw-worker.js` 和 `sw-composed.js` 也在输出根目录，错误长缓存会放大 PWA version skew。

推荐配置：

```text
/*
  X-Content-Type-Options: nosniff
  X-Frame-Options: SAMEORIGIN
  Referrer-Policy: strict-origin-when-cross-origin
  ! Link

/index.html
  Cache-Control: no-cache, no-store, must-revalidate

/launch.html
  Cache-Control: no-cache, no-store, must-revalidate

/ngsw.json
  Cache-Control: no-cache, no-store, must-revalidate

/manifest.webmanifest
  Cache-Control: no-cache, no-store, must-revalidate

/ngsw-worker.js
  Content-Type: application/javascript; charset=utf-8
  Cache-Control: no-cache, no-store, must-revalidate

/sw-composed.js
  Content-Type: application/javascript; charset=utf-8
  Cache-Control: no-cache, no-store, must-revalidate

/safety-worker.js
  Content-Type: application/javascript; charset=utf-8
  Cache-Control: no-cache, no-store, must-revalidate

/worker-basic.min.js
  Content-Type: application/javascript; charset=utf-8
  Cache-Control: no-cache, no-store, must-revalidate

/widgets/templates/*
  Cache-Control: no-cache, no-store, must-revalidate

/.well-known/assetlinks.json
  Content-Type: application/json; charset=utf-8
  Cache-Control: public, max-age=0, must-revalidate

/main*.js
  Content-Type: application/javascript; charset=utf-8
  Cache-Control: public, max-age=31536000, immutable

/polyfills*.js
  Content-Type: application/javascript; charset=utf-8
  Cache-Control: public, max-age=31536000, immutable

/chunk*.js
  Content-Type: application/javascript; charset=utf-8
  Cache-Control: public, max-age=31536000, immutable

/styles*.css
  Cache-Control: public, max-age=31536000, immutable

/assets/*
  Cache-Control: public, max-age=0, must-revalidate

/icons/*
  Cache-Control: public, max-age=0, must-revalidate

/fonts/*
  Cache-Control: public, max-age=0, must-revalidate
```

注意：

- Cloudflare `_headers` 里不要让同一资源路径命中相互冲突的 `Cache-Control` 规则。避免同时给 `/*.js` 和 `/ngsw-worker.js` 这类路径设置不同缓存策略，降低规则优先级和合并语义带来的误判。
- `ngsw.json`、`index.html`、`launch.html`、`sw-composed.js` 是 PWA 更新链路的关键文件，宁可少缓存，也不能被长期缓存。
- Hashed application JS/CSS bundles 才允许 `immutable`，且文件名 hash 必须对应最终部署内容。若 Sentry inject 或其他后处理会修改 JS 内容，必须先完成 post-inject rename 并同步改 HTML/modulepreload/`ngsw.json`，否则这些 JS 不得设置长期 immutable。
- 当前 `public/fonts/**`、`public/icons/**` 和普通 `assets` 目录资源不是内容 hash 文件名，首版必须 revalidate。若后续把字体、图标、图片改成 hash/versioned 文件名，可以由构建脚本生成精确 immutable 规则。
- 当前 Angular build 会在根目录生成 `worker-basic.min.js`，这是 Angular Service Worker 的安全清理脚本，文件名不带内容 hash。它不能被 `/worker*.js` 或 `/worker-*.js` 之类宽泛规则长期缓存，必须单独 no-store。
- Cloudflare `_headers` 不能用静态 `/worker-*.js` 表达“只匹配 hash worker chunk 且排除 `worker-basic.min.js`”。如果 build 后确实存在应用 Web Worker chunk，阶段 1 应由构建脚本扫描 `dist/browser/worker-*.js`，排除 `worker-basic.min.js`，再把每个实际文件名追加成精确规则（例如 `/worker-<hash>.js`）并设置 `immutable`。
- `_headers` 只控制浏览器/CDN 响应头，不会阻止 Angular Service Worker 根据 `ngsw.json` 缓存文件。`ngsw-config.json` 中的 `/worker*.js` / `/worker-*.js` 必须同步收紧，生成后的 `dist/browser/ngsw.json` 也必须被 CI 检查，确保 `worker-basic.min.js` / `safety-worker.js` 不在应用 assetGroups 中被长期管理。
- `_headers` 最多 100 条规则。构建脚本若按精确文件名追加 worker/font/icon header，CI 必须统计规则数并在 90 条以上 fail-fast，保留后续扩展余量。
- 首版 `_headers` 在 `/*` 下使用 `! Link`，移除 Cloudflare Pages 从 HTML `<link rel="modulepreload">` 自动生成的 `Link` 响应头，从而关闭 Early Hints 的自动预加载输入。不要写自造的 Early Hints 关闭响应头；Cloudflare Pages 官方支持的 per-site 关闭路径是移除 `Link` header 或让相关 `<link>` 带额外属性（例如 `data-do-not-generate-a-link-header`）避免自动生成。

### 4.5 Vercel 构建分钟弊病修复

Vercel 构建分钟数达到上限后，处理目标不是延续旧平台，而是先解除迁移前的发布阻塞，并把 Vercel 保留为短期回滚后备。按风险从低到高执行：

**动作 A：确认并收紧现有 Ignored Build Step。**

本仓库已经在 `vercel.json` 配置：

```json
"ignoreCommand": "bash scripts/vercel-ignore-step.sh"
```

`scripts/vercel-ignore-step.sh` 只在 `src/`、`main.ts`、`index.html`、`angular.json`、`package*.json`、`vercel.json`、`ngsw-config.json`、`public/` 等构建相关路径变化时触发构建。文档、README、归档材料变更会跳过构建。

适用场景：

- 本月还有少量 Vercel build minutes。
- 最近大量提交只是文档、计划、说明变更。

局限：

- 真实代码改动仍会触发 Vercel 构建。
- 如果多数提交都改 `src/`、`public/` 或构建配置，节省有限。

**动作 B：迁移窗口内保留 Vercel 托管，但把构建挪到 GitHub Actions。**

这是迁移期间的应急发布通道，不是目标架构。GitHub Actions 执行 Vercel build，再上传预构建产物：

```bash
npx vercel pull --yes --environment=production --token "$VERCEL_TOKEN"
npx vercel build --prod --token "$VERCEL_TOKEN"
npx vercel deploy --prebuilt --prod --token "$VERCEL_TOKEN"
```

需要 GitHub Secrets：

```text
VERCEL_TOKEN
VERCEL_ORG_ID
VERCEL_PROJECT_ID
```

适用场景：

- 需要今天恢复生产发布。
- DNS、Supabase redirect、TWA origin 还没准备好，不想立刻切 Cloudflare。
- Cloudflare preview 正在验证，但 production DNS 还没到割接窗口。

局限：

- 仍然保留 Vercel 托管和项目配置复杂度。
- 仍需要维护 Vercel token、`.vercel/project.json` 或通过 `vercel pull` 获取项目设置。
- 只能作为过渡方案；Cloudflare production 稳定后应删除该临时 workflow 或手动禁用。

**动作 C：临时升级 Vercel 计划或购买构建额度。**

适用场景：

- 时间成本高于迁移成本。
- 当前迁移窗口不能被构建额度阻塞，且不想临时改 CI。

局限：

- 如果构建链路本身没有优化，升级只是把问题变成持续账单。
- 即使临时升级，也不改变迁移目标；Cloudflare production 稳定后应停止依赖 Vercel 构建额度。

本项目推荐顺序：

```text
迁移前修复：A 已启用，先确认是否仍有效。
迁移窗口应急发布：必要时临时做 B。
最后手段：短期使用 C，但不改变迁移计划。
最终目标：Cloudflare Pages Direct Upload + GitHub Actions。
```

门禁规则：A/B/C 任一动作完成后，都必须继续进入阶段 0。Vercel 修复只解决“迁移期间不要被旧平台卡住”，不作为取消或延后 Cloudflare 迁移的依据。

### 4.6 Cloudflare Dashboard 具体路径

本项目推荐创建 **Direct Upload** Pages 项目，不推荐从 `Connect to Git` 起步。

**创建 Direct Upload 项目：**

```text
Cloudflare Dashboard
-> Workers & Pages
-> Create application
-> Pages
-> Get started
-> Drag and drop your files
```

操作：

- 填项目名，例如 `nanoflow`。
- 首次可上传一个最小 `index.html` 或本地构建后的 `dist/browser`，完成项目创建。
- 之后由 GitHub Actions 使用 `wrangler pages deploy dist/browser --project-name=<name>` 接管部署。

也可以完全用 Wrangler 创建项目：

```bash
npx wrangler pages project create
npx wrangler pages deploy dist/browser --project-name=nanoflow --branch=main
```

建议使用 `npx wrangler`，不要依赖全局安装的 Wrangler 版本。

**如果已经误选 Connect to Git：**

```text
Workers & Pages
-> 选择 Pages 项目
-> Settings
-> Builds
-> Branch control
```

操作：

- 关闭 automatic production branch deployments。
- Preview branch 可设为 None，避免 Cloudflare 自己构建 PR。
- 后续仍可用 Wrangler 对这个 Pages 项目做直接部署，但不能使用 dashboard drag-and-drop；如果想要纯 Direct Upload 项目，重新建项目更干净。

**查看 Account ID：**

```text
Cloudflare Dashboard
-> Workers & Pages
-> Overview 或项目详情页右侧栏
-> Account ID
```

**创建 API Token：**

```text
右上角头像
-> My Profile
-> API Tokens
-> Create Token
```

操作：

- 如果有 Cloudflare Pages 模板，优先使用模板。
- 如果使用 Custom token，权限限定为目标 Account 的 `Cloudflare Pages: Edit`。
- DNS 自动化需要单独 token，不和 Pages deploy token 混用。
- 生成后写入 GitHub 仓库 `Settings -> Secrets and variables -> Actions -> Repository secrets`。

**Cloudflare Pages 变量与机密路径：**

```text
Workers & Pages
-> 选择 Pages 项目
-> Settings
-> Variables and Secrets
-> Add
```

重要边界：

- Direct Upload + GitHub Actions 模式下，Angular bundle 已经在 GitHub Actions 中构建完成；Cloudflare Dashboard 的变量不会自动进入 `dist/browser/*.js`。
- NanoFlow 的 `NG_APP_SUPABASE_URL`、`NG_APP_SUPABASE_ANON_KEY`、`NG_APP_SENTRY_DSN`、`NG_APP_GOJS_LICENSE_KEY` 必须放在 GitHub Actions Secrets，在 `npm run config` / `npm run build:stats` 之前注入。
- Cloudflare 的 Variables and Secrets 主要用于 Pages Functions 运行时，或 Cloudflare Git integration 的构建时变量。本项目首版不使用 Pages Functions，也不使用 Cloudflare Git 构建。

**GitHub Secrets 路径：**

```text
GitHub repository
-> Settings
-> Secrets and variables
-> Actions
-> Repository secrets
```

至少写入：

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_PAGES_PROJECT_NAME
NG_APP_SUPABASE_URL
NG_APP_SUPABASE_ANON_KEY
NG_APP_SENTRY_DSN
NG_APP_GOJS_LICENSE_KEY
```

## 5. CI/CD 设计

### 5.1 认证模型

当前可落地方案使用 Cloudflare Account API Token。

必做：

- 使用 Account API Token，不使用 Global API Key。
- 权限限定为目标 Account 下的 `Cloudflare Pages: Edit`。
- GitHub 中只放入 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID` secret，不把 token 写入仓库。
- DNS 修改如需自动化，使用单独 token，不和 Pages deploy token 混用。
- 个人项目也建议设置 token 过期时间或定期轮换，例如 90 天。

不写入当前执行项：

- GitHub OIDC 到 Cloudflare Pages Direct Upload。官方 Wrangler CI/CD 文档当前仍要求 API Token；待 Cloudflare 明确支持 Wrangler/Pages 的 OIDC 或 Workload Identity 后再升级。

### 5.2 GitHub Secrets

| Secret | 用途 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Wrangler 部署 Pages，最小权限 |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account id |
| `CLOUDFLARE_PAGES_PROJECT_NAME` | Pages 项目名，例如 `nanoflow` |
| `NG_APP_SUPABASE_URL` | Angular build-time Supabase URL |
| `NG_APP_SUPABASE_ANON_KEY` | Angular build-time Supabase anon key |
| `NanoFlow-Preview / NG_APP_SUPABASE_URL` | GitHub Environment `NanoFlow-Preview` 中的 preview Supabase URL |
| `NanoFlow-Preview / NG_APP_SUPABASE_ANON_KEY` | GitHub Environment `NanoFlow-Preview` 中的 preview anon key |
| `NG_APP_SENTRY_DSN` | 前端 Sentry DSN |
| `NG_APP_GOJS_LICENSE_KEY` | GoJS license key，没有则保留水印 |
| `SENTRY_AUTH_TOKEN` | 可选：上传 Source Map |
| `SENTRY_ORG` | 可选：Sentry org slug |
| `SENTRY_PROJECT` | 可选：Sentry project slug |
| `ANDROID_TWA_EXPECTED_SHA256_CERT_FINGERPRINTS` | Android TWA 期望 fingerprint 列表，逗号分隔；用于 CI 验证 `assetlinks.json` 完整性 |

Supabase anon key 不是 service role key，但仍通过 CI secret 注入，避免模板文件被真实值污染。

GitHub Variables：

| Variable | 默认值 | 用途 |
| --- | --- | --- |
| `ENABLE_SENTRY_SOURCEMAPS` | `false` | 是否启用 Sentry sourcemap inject/upload |
| `READ_ONLY_PREVIEW` | `true` | PR preview 构建的默认 mutation fail-closed 开关；只有独立 Preview Supabase 项目且 e2e 需要写入时才允许关闭 |
| `CANONICAL_PRODUCTION_ORIGIN` | `https://app.nanoflow.app`（示例） | 唯一可写生产 origin；生产 bundle 的最早期脚本必须以它为准 |
| `CLOUDFLARE_CUSTOM_DOMAIN_ORIGIN` | 空 | custom domain 已绑定且 TLS active 后再设置，例如 `https://app.nanoflow.app`；未设置时 post-deploy smoke 只跑 Pages URL |

PR preview 默认必须使用独立 Supabase Preview Project。当前仓库实现方式是 GitHub Environment `NanoFlow-Preview`：同名 `NG_APP_SUPABASE_URL` / `NG_APP_SUPABASE_ANON_KEY` 在 preview environment 中覆盖生产 secrets，workflow 不再使用 `PREVIEW_NG_APP_*` 或 `preview || production` fallback。使用生产 Supabase + preview-bot 只能作为未来临时例外：必须同时满足 `READ_ONLY_PREVIEW=true`、应用层禁止 cloud push/RPC/Edge Function mutation、数据库 RLS/RPC 层只允许 preview-bot 写隔离 namespace 且有自动清理。**不要用 GitHub expression 的 `preview_secret || production_secret` 作为 fallback**，它会把配置缺失伪装成成功，并可能把 PR preview 打到生产项目。

敏感 token 的暴露面按 step 收敛：`SENTRY_AUTH_TOKEN` / `SENTRY_ORG` / `SENTRY_PROJECT` 只给 Sentry upload step，`CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` 只给 deploy step；`npm ci`、测试和 build 阶段只暴露会进入前端 bundle 的 `NG_APP_*` 和非敏感变量。这样同仓 PR 即使修改构建脚本，也不应在 build/test 阶段读到发布 token。

### 5.3 Workflow 草案

> 2026-05-18 注：本节保留原始设计草案用于解释风险边界；当前仓库事实源是 `.github/workflows/deploy-cloudflare-pages.yml` 与 `.github/workflows/deploy-cloudflare-pages-dry-run.yml`。现行 workflow 采用 GitHub Environment `NanoFlow-Preview` 隔离 preview Supabase secrets，不再使用 `PREVIEW_NG_APP_*` 变量名。

新增 `.github/workflows/deploy-cloudflare-pages.yml`。核心原则：**测试 job 不依赖生产 secret；构建/部署 job 只在 secret 可用且事件安全时运行**。这样 fork PR 在 `validate-env:prod` 阶段不会因为拿不到 repository secrets 而失败。

```yaml
name: Deploy Cloudflare Pages

on:
  push:
    branches:
      - main
  pull_request:
    branches:
      - main
  workflow_dispatch:
    inputs:
      deploy:
        description: "Deploy after build/test. Only works on main."
        type: boolean
        default: false

permissions:
  contents: read
  deployments: write
  pull-requests: write

concurrency:
  group: cloudflare-pages-${{ github.event_name }}-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true

jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 40

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Run CI tests
        run: npm run test:run:ci

  build-deploy:
    needs: test
    runs-on: ubuntu-latest
    timeout-minutes: 40
    if: >
      github.event_name == 'push' ||
      github.event_name == 'workflow_dispatch' ||
      (github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository)

    env:
      PROD_NG_APP_SUPABASE_URL: ${{ (github.event_name != 'pull_request' || vars.ALLOW_PROD_SUPABASE_FOR_PREVIEW_SMOKE == 'true') && secrets.NG_APP_SUPABASE_URL || '' }}
      PROD_NG_APP_SUPABASE_ANON_KEY: ${{ (github.event_name != 'pull_request' || vars.ALLOW_PROD_SUPABASE_FOR_PREVIEW_SMOKE == 'true') && secrets.NG_APP_SUPABASE_ANON_KEY || '' }}
      PREVIEW_NG_APP_SUPABASE_URL: ${{ secrets.PREVIEW_NG_APP_SUPABASE_URL }}
      PREVIEW_NG_APP_SUPABASE_ANON_KEY: ${{ secrets.PREVIEW_NG_APP_SUPABASE_ANON_KEY }}
      ALLOW_PROD_SUPABASE_FOR_PREVIEW_SMOKE: ${{ vars.ALLOW_PROD_SUPABASE_FOR_PREVIEW_SMOKE || 'false' }}
      NG_APP_SENTRY_DSN: ${{ secrets.NG_APP_SENTRY_DSN }}
      NG_APP_GOJS_LICENSE_KEY: ${{ secrets.NG_APP_GOJS_LICENSE_KEY }}
      ANDROID_TWA_EXPECTED_SHA256_CERT_FINGERPRINTS: ${{ secrets.ANDROID_TWA_EXPECTED_SHA256_CERT_FINGERPRINTS }}
      ENABLE_SENTRY_SOURCEMAPS: ${{ vars.ENABLE_SENTRY_SOURCEMAPS || 'false' }}
      READ_ONLY_PREVIEW: ${{ vars.READ_ONLY_PREVIEW || 'true' }}
      CANONICAL_PRODUCTION_ORIGIN: ${{ vars.CANONICAL_PRODUCTION_ORIGIN || 'https://app.nanoflow.app' }}
      CLOUDFLARE_PAGES_PROJECT_NAME: ${{ secrets.CLOUDFLARE_PAGES_PROJECT_NAME }}
      WRANGLER_VERSION: 3.112.0
      SENTRY_CLI_VERSION: 2.58.2
      ROOT_JS_ARTIFACT_ALLOW_PATTERN: '^(main|polyfills|chunk|worker|runtime)-|^(sw-composed|ngsw-worker|safety-worker|worker-basic\.min)\.js$'

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Select Supabase build env
        shell: bash
        run: |
          if [ "$GITHUB_EVENT_NAME" = "pull_request" ]; then
            if [ -n "${PREVIEW_NG_APP_SUPABASE_URL:-}" ] && [ -n "${PREVIEW_NG_APP_SUPABASE_ANON_KEY:-}" ]; then
              echo "NG_APP_SUPABASE_URL=$PREVIEW_NG_APP_SUPABASE_URL" >> "$GITHUB_ENV"
              echo "NG_APP_SUPABASE_ANON_KEY=$PREVIEW_NG_APP_SUPABASE_ANON_KEY" >> "$GITHUB_ENV"
            elif [ "${ALLOW_PROD_SUPABASE_FOR_PREVIEW_SMOKE:-false}" = "true" ]; then
              if [ "${READ_ONLY_PREVIEW:-true}" != "true" ]; then
                echo "::error::Production Supabase preview opt-in requires READ_ONLY_PREVIEW=true and RPC/RLS isolation."
                exit 1
              fi
              echo "::warning::PR preview is using production Supabase in read-only/isolated mode. Mutation paths must fail closed."
              echo "NG_APP_SUPABASE_URL=$PROD_NG_APP_SUPABASE_URL" >> "$GITHUB_ENV"
              echo "NG_APP_SUPABASE_ANON_KEY=$PROD_NG_APP_SUPABASE_ANON_KEY" >> "$GITHUB_ENV"
            else
              echo "::error::Missing PREVIEW_NG_APP_SUPABASE_URL/PREVIEW_NG_APP_SUPABASE_ANON_KEY. Refusing to fall back to production Supabase for PR preview."
              exit 1
            fi
          else
            echo "NG_APP_SUPABASE_URL=$PROD_NG_APP_SUPABASE_URL" >> "$GITHUB_ENV"
            echo "NG_APP_SUPABASE_ANON_KEY=$PROD_NG_APP_SUPABASE_ANON_KEY" >> "$GITHUB_ENV"
          fi
          echo "NG_APP_READ_ONLY_PREVIEW=$READ_ONLY_PREVIEW" >> "$GITHUB_ENV"
          echo "NG_APP_CANONICAL_ORIGIN=$CANONICAL_PRODUCTION_ORIGIN" >> "$GITHUB_ENV"

      - name: Validate resolved build env
        run: npm run validate-env:prod

      - name: Build production with stats
        run: npm run build:stats

      - name: Deterministic build guard
        run: npm run quality:guard:build-deterministic

      - name: No-JIT artifact guard
        run: npm run perf:guard:nojit

      - name: Font artifact contract
        run: npm run quality:guard:font-contract

      - name: Supabase-ready artifact contract
        run: npm run quality:guard:supabase-ready

      - name: Verify public deploy metadata
        run: |
          test -f dist/browser/index.html
          test -f dist/browser/ngsw.json
          test -f dist/browser/ngsw-worker.js
          test -f dist/browser/sw-composed.js
          test -f dist/browser/manifest.webmanifest
          test -f dist/browser/.well-known/assetlinks.json
          test -f dist/browser/_headers
          test -f dist/browser/version.json
          test ! -d functions
          test ! -d dist/browser/functions
          test ! -f dist/browser/_worker.js
          grep -q "app.nanoflow.twa" dist/browser/.well-known/assetlinks.json
          if [ -n "${ANDROID_TWA_EXPECTED_SHA256_CERT_FINGERPRINTS:-}" ]; then
            assetlinks_fps="$(tr '[:lower:]' '[:upper:]' < dist/browser/.well-known/assetlinks.json | tr -d ':')"
            IFS=',' read -ra expected_fps <<< "$ANDROID_TWA_EXPECTED_SHA256_CERT_FINGERPRINTS"
            for fp in "${expected_fps[@]}"; do
              normalized_fp="$(echo "$fp" | xargs | tr '[:lower:]' '[:upper:]' | tr -d ':')"
              if [ -n "$normalized_fp" ] && ! echo "$assetlinks_fps" | grep -q "$normalized_fp"; then
                echo "Missing Android TWA fingerprint in assetlinks.json: $normalized_fp"
                exit 1
              fi
            done
          else
            echo "::warning::ANDROID_TWA_EXPECTED_SHA256_CERT_FINGERPRINTS is not set; only package name is checked."
          fi
          ! grep "vercel.app" dist/browser/manifest.webmanifest
          if [ -f public/launch.html ]; then
            test -f dist/browser/launch.html
          fi
          if [ -f public/safety-worker.js ]; then
            test -f dist/browser/safety-worker.js
          fi
          if [ -f dist/browser/_redirects ]; then
            echo "_redirects found; preview smoke must verify static assets are not proxied to HTML."
          fi
          HEADER_RULES="$(grep -E '^/[^[:space:]]+' dist/browser/_headers | wc -l | xargs)"
          if [ "$HEADER_RULES" -gt 90 ]; then
            echo "_headers has $HEADER_RULES rules; keep below 90 to stay under Cloudflare Pages 100-rule limit with room for emergency rules."
            exit 1
          fi
          FILE_COUNT="$(find dist/browser -type f | wc -l | xargs)"
          if [ "$FILE_COUNT" -gt 18000 ]; then
            echo "dist/browser has $FILE_COUNT files; keep below 18000 to preserve headroom under the 20000-file Direct Upload limit."
            exit 1
          fi
          if grep -Eq '^/worker\*\.js$|^/worker-\*\.js$' dist/browser/_headers; then
            echo "Do not use a broad /worker*.js or /worker-*.js immutable header; it also matches worker-basic.min.js."
            exit 1
          fi
          if grep -En '"/worker\*\.js"|"/worker-\*\.js"' ngsw-config.json; then
            echo "ngsw-config.json must not use broad /worker*.js or /worker-*.js; it can cache Angular safety workers."
            exit 1
          fi
          if grep -Eq '"(worker-basic\.min|safety-worker)\.js"' dist/browser/ngsw.json; then
            echo "Angular safety workers must not be listed in generated ngsw.json assetGroups."
            exit 1
          fi
          awk '
            /^\/(assets|icons|fonts)\/\*/ { in_public=1; next }
            /^\/[^[:space:]]+/ { in_public=0 }
            in_public && /immutable|max-age=31536000/ {
              print "Non-hash public assets/fonts/icons must not use immutable cache rules"
              exit 1
            }
          ' dist/browser/_headers
          for worker_file in dist/browser/worker-*.js; do
            [ -e "$worker_file" ] || continue
            worker_name="$(basename "$worker_file")"
            [ "$worker_name" = "worker-basic.min.js" ] && continue
            if ! grep -qx "/$worker_name" dist/browser/_headers; then
              echo "Application worker chunk must use an exact immutable _headers rule: /$worker_name"
              exit 1
            fi
          done
          unmatched_js=$(find dist/browser -maxdepth 1 -name '*.js' -printf '%f\n' | grep -Ev "$ROOT_JS_ARTIFACT_ALLOW_PATTERN" || true)
          if [ -n "$unmatched_js" ]; then
            echo "Root JS files outside the known _headers handling allow-list:"
            echo "$unmatched_js"
            exit 1
          fi

      - name: Sentry source maps (disabled by default)
        if: ${{ env.ENABLE_SENTRY_SOURCEMAPS == 'true' }}
        run: |
          if [ -z "${SENTRY_AUTH_TOKEN:-}" ] || [ -z "${SENTRY_ORG:-}" ] || [ -z "${SENTRY_PROJECT:-}" ]; then
            echo "::error::ENABLE_SENTRY_SOURCEMAPS=true requires SENTRY_AUTH_TOKEN/SENTRY_ORG/SENTRY_PROJECT, but these secrets are scoped only to this step."
            exit 1
          fi
          if find dist/browser -name '*.map' -type f | grep -q .; then
            npx @sentry/cli@"$SENTRY_CLI_VERSION" sourcemaps inject dist/browser
            npx @sentry/cli@"$SENTRY_CLI_VERSION" sourcemaps upload dist/browser \
              --org "$SENTRY_ORG" \
              --project "$SENTRY_PROJECT" \
              --release "$GITHUB_SHA"
            find dist/browser -name '*.map' -type f -delete

            # Sentry inject 修改了 JS 内容。必须重建 Angular Service Worker manifest，
            # 并重新计算 HTML hash，确保 ngsw.json 与最终部署产物完全一致。
            npx ngsw-config dist/browser ngsw-config.json /
            node scripts/patch-ngsw-html-hashes.cjs
            if grep -A2 -E '^/(main|polyfills|chunk)\*\.js' dist/browser/_headers | grep -q immutable; then
              echo "::error::Sentry inject changed JS content; without post-inject rename, injected JS must not be immutable."
              exit 1
            fi
          else
            echo "No source maps found; skip Sentry sourcemap upload."
          fi
        env:
          SENTRY_AUTH_TOKEN: ${{ secrets.SENTRY_AUTH_TOKEN }}
          SENTRY_ORG: ${{ secrets.SENTRY_ORG }}
          SENTRY_PROJECT: ${{ secrets.SENTRY_PROJECT }}

      - name: Final no-source-map guard
        run: |
          if find dist/browser -name '*.map' -type f | grep -q .; then
            echo "Source maps must not be deployed to Cloudflare Pages."
            exit 1
          fi

      - name: Deploy preview to Cloudflare Pages
        if: github.event_name == 'pull_request'
        uses: nick-fields/retry@v3
        with:
          timeout_minutes: 8
          max_attempts: 3
          retry_wait_seconds: 30
          command: |
            npx wrangler@"$WRANGLER_VERSION" pages deploy dist/browser \
              --project-name="$CLOUDFLARE_PAGES_PROJECT_NAME" \
              --branch=pr-${{ github.event.pull_request.number }}
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}

      - name: Wait for preview deployment health
        if: github.event_name == 'pull_request'
        shell: bash
        run: |
          ORIGIN="https://pr-${{ github.event.pull_request.number }}.${CLOUDFLARE_PAGES_PROJECT_NAME}.pages.dev"
          for attempt in {1..18}; do
            status="$(curl -sS -o /tmp/cf-index.html -w '%{http_code}' "$ORIGIN/" || true)"
            version_status="$(curl -sS -o /tmp/cf-version.json -w '%{http_code}' "$ORIGIN/version.json" || true)"
            if [ "$status" = "200" ] && [ "$version_status" = "200" ] && grep -q '"gitSha"' /tmp/cf-version.json; then
              break
            fi
            if [ "$attempt" = "18" ]; then
              echo "::error::Preview deployment API returned, but $ORIGIN is not healthy after propagation wait."
              exit 1
            fi
            sleep 10
          done

      - name: Check active deployments before production deploy
        if: >
          (github.event_name == 'push' && github.ref == 'refs/heads/main') ||
          (github.event_name == 'workflow_dispatch' && inputs.deploy == true && github.ref == 'refs/heads/main')
        run: |
          npx wrangler@"$WRANGLER_VERSION" pages deployment list \
            --project-name="$CLOUDFLARE_PAGES_PROJECT_NAME" | head -40
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}

      - name: Deploy production to Cloudflare Pages
        if: >
          (github.event_name == 'push' && github.ref == 'refs/heads/main') ||
          (github.event_name == 'workflow_dispatch' && inputs.deploy == true && github.ref == 'refs/heads/main')
        uses: nick-fields/retry@v3
        with:
          timeout_minutes: 8
          max_attempts: 3
          retry_wait_seconds: 30
          command: |
            npx wrangler@"$WRANGLER_VERSION" pages deploy dist/browser \
              --project-name="$CLOUDFLARE_PAGES_PROJECT_NAME" \
              --branch=main
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}

      - name: Wait for production deployment health
        if: >
          (github.event_name == 'push' && github.ref == 'refs/heads/main') ||
          (github.event_name == 'workflow_dispatch' && inputs.deploy == true && github.ref == 'refs/heads/main')
        shell: bash
        run: |
          ORIGIN="https://${CLOUDFLARE_PAGES_PROJECT_NAME}.pages.dev"
          for attempt in {1..18}; do
            status="$(curl -sS -o /tmp/cf-index.html -w '%{http_code}' "$ORIGIN/" || true)"
            version_status="$(curl -sS -o /tmp/cf-version.json -w '%{http_code}' "$ORIGIN/version.json" || true)"
            if [ "$status" = "200" ] && [ "$version_status" = "200" ] && grep -q '"gitSha"' /tmp/cf-version.json; then
              break
            fi
            if [ "$attempt" = "18" ]; then
              echo "::error::Production deployment API returned, but $ORIGIN is not healthy after propagation wait."
              exit 1
            fi
            sleep 10
          done
```

手动触发说明：`workflow_dispatch` 默认只执行 test/build/guards，不部署。只有在 `main` 分支手动运行并设置 `deploy=true` 时才部署 production。

Fork PR 行为：只运行 `test` job；不执行 `validate-env:prod`、不读取部署 secret、不部署 preview。若需要外部贡献者预览，先由维护者把分支同步到同仓分支再触发 preview。

如果 Direct Upload 项目的 production branch 不是 `main`，创建项目后执行一次：

```bash
curl --request PATCH \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects/$CLOUDFLARE_PAGES_PROJECT_NAME" \
  --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  --header "Content-Type: application/json" \
  --data '{"production_branch":"main"}'
```

### 5.4 Source Map 安全门禁

当前生产 build 不生成 Source Map。迁移首版默认不上传 Sentry Source Map，先把 Cloudflare Pages、DNS、PWA 更新和 Supabase 回调跑稳。

Sentry inject 不只是 sourcemap 流程问题，它会把 Debug ID 写进最终 JS。Angular build 生成的 `main-xxxx.js` / `chunk-xxxx.js` 文件名 hash 是 build 时内容 hash；inject 发生在 build 后，JS 内容改变但文件名不会自动改变。如果这些同名文件继续走 `Cache-Control: immutable`，浏览器 HTTP cache 会相信旧 URL 仍代表旧内容，`ngsw.json` 重建也只能修 Angular SW 校验，不能修浏览器对同名 immutable 文件的信任。

因此三选一：

1. **首版迁移默认方案**：`ENABLE_SENTRY_SOURCEMAPS=false`，不执行 inject，hashed JS 继续允许 immutable。
2. **完整方案**：inject 后重新计算最终 JS 内容 hash，重命名 JS/CSS 文件，并同步改 `index.html`、`launch.html`、modulepreload、`ngsw.json` 和 source map upload 关系。
3. **保守方案**：如果启用 inject 但没有 post-inject rename 能力，被 inject 的 JS 不能设置长期 immutable，只能 `max-age=0, must-revalidate` 或等价 revalidate。

如果迁移首版就要启用 inject，必须满足以下顺序：

```text
npm run build:stats 生成 dist/browser、ngsw.json、modulepreload 和 launch 产物
Sentry CLI inject 修改最终部署 JS
Sentry CLI upload 上传 JS/map Debug ID 关系
删除 dist/browser/**/*.map
如果未做 post-inject rename，把被 inject 的 JS header 降级为 revalidate
重新运行 ngsw-config，生成匹配最终 JS 内容的 ngsw.json
重新运行 scripts/patch-ngsw-html-hashes.cjs，确保 HTML hash 也匹配最终产物
最终检查 dist/browser 中没有 .map
部署 Cloudflare Pages
```

原因：

- Angular Service Worker 的 `ngsw.json` 记录缓存资源内容 hash。
- `@sentry/cli sourcemaps inject` 会向 JS 注入 Debug ID，修改 JS 内容。
- 如果 inject 后不重建 `ngsw.json`，Service Worker 看到的 hash 和最终部署文件不一致，容易触发安装失败、缓存不一致或 version skew。
- 如果 inject 后不重命名最终 JS 或降级 HTTP cache，同名 hash 文件可能被浏览器长期 immutable 缓存；这是独立于 Angular Service Worker 的风险。

建议策略：

- 使用 GitHub variable `ENABLE_SENTRY_SOURCEMAPS=false` 作为默认值。
- Angular production source map 使用 hidden 模式，避免 JS 文件带公开 `sourceMappingURL`。
- Hidden source map 只是不暴露引用，不等于安全；部署前仍必须删除 `.map`。
- `@sentry/cli sourcemaps inject` 必须在 upload 前、deploy 前执行。
- 上传到 Sentry 后，部署 Cloudflare 前必须删除 `dist/browser/**/*.map`。
- 删除 `.map` 且 inject 完成后，必须执行 `npx ngsw-config dist/browser ngsw-config.json /`。
- `ngsw-config` 后必须再执行 `node scripts/patch-ngsw-html-hashes.cjs`，避免 `index.html` / `launch.html` hash 与最终产物失配。
- CI 必须检查 `_headers`：启用 inject 且未执行 post-inject rename 时，`/main*.js`、`/polyfills*.js`、`/chunk*.js` 不能仍是 `immutable`。
- CI 必须用 `find dist/browser -name '*.map'` 做最终门禁，发现 `.map` 立即失败。

不建议：

- 为了“方便调试”把 `.map` 公开发布到 Cloudflare。
- 把 Sentry Source Map 上传和 Cloudflare 部署拆成两个不同构建产物。Sentry 看到的 JS 必须和最终部署的 JS 是同一份。

### 5.5 Sentry Release 对齐

当前 `SentryLazyLoaderService` 的 release 由运行时入口 chunk 路径推导，不等于 GitHub Actions 中的 `$GITHUB_SHA`。因此，如果 workflow 使用 `--release "$GITHUB_SHA"` 上传 sourcemap，但前端运行时没有把同一个 release 写入 `Sentry.init({ release })`，Sentry release 维度会不一致。

两种可选策略：

- 首版迁移只验收 Debug ID sourcemap 能还原堆栈，不把“看到 `$GITHUB_SHA` release”作为门禁。
- 后续如果要以 Git SHA 作为 release，先改 `scripts/set-env.cjs`、`scripts/ensure-env-files.cjs` 和 `SentryLazyLoaderService`，让 `NG_APP_SENTRY_RELEASE=${{ github.sha }}` 进入 `environment` 并被 `Sentry.init` 使用。

## 6. Supabase 配套改动

### 6.1 Auth Redirect URLs

Supabase Auth 的生产 Site URL 设为最终正式域名。这里先做域名选择：

- 如果选择最小 DNS 改动，生产域名建议用子域名，例如 `https://app.nanoflow.app` 或 `https://www.nanoflow.app`。
- 如果坚持使用 apex/root domain `https://nanoflow.app`，DNS 割接必须走 Cloudflare full DNS setup，不能只在外部 DNS 加普通 CNAME。

生产 Site URL 示例：

```text
https://app.nanoflow.app
# 或者 full DNS setup 后使用：
https://nanoflow.app
```

Additional Redirect URLs 必须按 §16.11 决策的 PR preview 数据隔离方案分两份 allow-list 维护，不要在生产 Supabase 项目里塞 preview 通配——会让 OAuth 回调可被任意 PR preview 拦截：

**生产 Supabase 项目（即正式 `NG_APP_SUPABASE_URL` 对应的 project）allow-list**：

```text
http://localhost:4200/**
http://localhost:5173/**
https://nanoflow.pages.dev/**
https://app.nanoflow.app/**
https://nanoflow.app/**
```

注意：`https://nanoflow.pages.dev/**` 只用于 production 首轮 smoke 和 custom domain 生效前的短窗口。custom domain active 且第二套 smoke 通过后，必须从生产 Auth redirect allow-list 移除，或配合 Cloudflare redirect/只读构建让该 origin 不再承载常规写入。**不**在生产项目里加 `https://*.nanoflow.pages.dev/**`。`pr-<number>.nanoflow.pages.dev` 是 PR preview 域，应只在 preview Supabase 项目（§16.11 方案 B 的独立 project）的 allow-list 里出现。

**Preview Supabase 项目（§16.11 方案 B 的 `nanoflow-preview` project）allow-list**：

```text
http://localhost:4200/**
http://localhost:5173/**
https://*.nanoflow.pages.dev/**
https://nanoflow.pages.dev/**
```

若 §16.11 选择方案 C（生产 Supabase + 测试用户），上面两份 allow-list 会合并到生产项目；此时**必须**接受 `pr-*.pages.dev` 的 OAuth 回调风险，并在 preview smoke 中显式跑 OAuth 链路。这是方案 C 不推荐的额外原因之一。

若保留旧 Vercel 回滚窗口，**仅在生产项目**临时加入：

```text
https://dde-eight.vercel.app/**
https://dde-*.vercel.app/**
```

稳定 72 小时后移除旧 Vercel redirect，避免多个生产 origin 长期并存导致 PWA、OAuth、Sentry release 和 TWA 排障复杂化。

注意：

- Supabase 官方建议 production 使用精确 URL，preview/local 才使用 `**` globstar。个人项目可以接受 preview 通配，但生产域名仍应尽量写精确路径。
- 如果当前登录回调有固定路径，例如 `/auth/callback`，生产 allow-list 应补充精确路径。
- 生产 allow-list 的收敛顺序必须写进阶段 3/4 checklist：custom domain smoke 通过后移除 `nanoflow.pages.dev`，稳定窗口结束后移除旧 Vercel。否则会留下多个可写 origin，放大离线队列与 OAuth 回调排障复杂度。
- 阶段 1 PR 描述必须粘贴这两份 allow-list 的最终值与对应 Supabase 项目 ID，避免后续无法追溯。

Auth 还必须审查应用侧 `redirectTo` 生成和 Supabase Email Templates：

- 全仓搜索 `redirectTo`、`window.location.origin`、`location.origin`、`SITE_URL`、`auth/callback`、`reset-password`。生产代码不得用当前浏览器 origin 拼生产回调；应使用 `NG_APP_CANONICAL_ORIGIN` / canonical origin helper，preview/local 走显式环境分支。
- 当前已发现 `src/services/auth.service.ts` 的 password reset 使用 `window.location.origin` 拼 `redirectTo`，迁移 PR 必须改成 canonical origin 或受控 preview origin；否则用户从 `pages.dev` / 旧 Vercel 打开时会把非 canonical origin 传给 Supabase。
- Supabase Dashboard → Authentication → Email Templates 需要同步检查确认、Magic Link、Invite、Password Reset 等模板。若生产代码使用 `redirectTo`，模板中固定 `{{ .SiteURL }}` 的链接可能把用户带回旧域；需要评估改用 `{{ .RedirectTo }}` 或确认模板路径与 Site URL 完全匹配。
- custom domain smoke 必须覆盖 password reset / magic link / OAuth 至少一条 Auth 回调链路，不能只测已有 session。

### 6.2 Edge Functions CORS

Cloudflare Pages 不作为 Supabase API 代理，浏览器仍直连 Supabase REST/Auth/Storage/Edge Functions。迁移要改的是手写 CORS allow-list，而且不同函数的实现不一致，不能只改 `transcribe`。

当前仓库至少分为四类：

| Edge Function | CORS 实现 | 迁移路径 |
| --- | --- | --- |
| `supabase/functions/transcribe/index.ts` | 硬编码 `ALLOWED_ORIGINS` + Vercel preview 前缀判断 | 必须改源码，更新 `src/tests/contracts/transcribe-cors.contract.spec.ts`，重新部署 |
| `supabase/functions/virus-scan/index.ts` | `Deno.env.get('ALLOWED_ORIGINS')` exact match + Vercel preview hostname 判断 | 固定 production + 临时 pages.dev 可用 secret 覆盖；custom smoke 后移除 pages.dev；若要支持 `pr-*.pages.dev`，必须改源码或新增 contract test |
| `supabase/functions/_shared/widget-common.ts` | `Deno.env.get('ALLOWED_ORIGINS')` exact match + Vercel preview hostname 判断 | 固定 production + 临时 pages.dev 可用 secret 覆盖；custom smoke 后移除 pages.dev；若要支持 widget PR preview，必须改源码 |
| `supabase/functions/widget-black-box-action/index.ts` | 独立内联 CORS，不复用 `_shared/widget-common.ts` | 必须单独审查；不能写成“由 `_shared/widget-common.ts` 统一覆盖” |

复用 `_shared/widget-common.ts` 的 widget 函数包括 `widget-register`、`widget-summary`、`widget-notify`、`widget-focus-action`。`widget-black-box-action` 当前是独立实现，迁移时必须单列。

执行方式：

```bash
rg -n "Access-Control-Allow-Origin|allowedOrigins|ALLOWED_ORIGINS|origin|cors|getCorsHeaders|CORS" supabase/functions src/tests/contracts
```

迁移任务包括：

- 所有相关 allow-list 加入最终生产 origin，例如 `https://app.nanoflow.app` 或 `https://nanoflow.app`。
- 加入固定 Pages production smoke origin，例如 `https://nanoflow.pages.dev`，但只保留到 custom domain active 且 smoke 通过；随后从生产 `ALLOWED_ORIGINS` 移除或改由只读/redirect 策略承接。
- 保留 `https://dde-eight.vercel.app` 作为 24-72 小时回滚窗口。
- 如果要允许 PR preview 调用 Edge Functions，必须用 hostname 解析或正则支持 `pr-<number>.<project>.pages.dev`；仅写 `https://pr-*.nanoflow.pages.dev` 到 `ALLOWED_ORIGINS` 不会匹配。
- 同步更新所有相关 contract tests，不只更新 `src/tests/contracts/transcribe-cors.contract.spec.ts`。

阶段 0 必须做一个明确决策：

1. **支持 PR preview 调用 Edge Functions**：改 `transcribe`、`virus-scan`、`_shared/widget-common`、`widget-black-box-action` 的 CORS 判断，统一使用 `URL.hostname` + 正则；补 contract tests。
2. **不支持 PR preview 调用 Edge Functions**：preview smoke 只覆盖静态启动、路由、PWA、只读页面，不跑语音转写、病毒扫描、widget action 等链路。

推荐的判断函数形态：

```ts
function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false;

  try {
    const url = new URL(origin);
    return (
      origin === 'https://app.nanoflow.app' ||
      origin === 'https://nanoflow.app' ||
      // 仅用于 custom domain 生效前的 production smoke，阶段 3 后移除。
      origin === 'https://nanoflow.pages.dev' ||
      /^pr-\d+\.nanoflow\.pages\.dev$/.test(url.hostname) ||
      origin === 'https://dde-eight.vercel.app'
    );
  } catch {
    return false;
  }
}
```

### 6.3 同步握手不改

迁移 Cloudflare 不应修改本地优先同步流程：

1. `UserSessionService.loadProjects()` 判断用户。
2. `loadStartupSnapshotResult()` 读取 IndexedDB 启动快照。
3. `projectState.setProjects(validProjects)` 先渲染本地 UI。
4. `runIdleTask()` 在空闲期启动后台同步。
5. `SimpleSyncService` 按 `updated_at/updatedAt` 做增量拉取与 LWW 合并。
6. 云端写失败进入 RetryQueue/ActionQueue。
7. 只有 RetryQueue 和 ActionQueue 都空，且本轮远端变更已 merge 到 store 并持久化到 IndexedDB 后，才提交远端 watermark 到 lastSyncTime。

验收重点是 Cloudflare 缓存策略不能让旧 HTML、旧 `ngsw.json` 和新 chunk 混用。

### 6.4 Realtime 与 Local-First 一致性门禁

本迁移不引入 CRDT。NanoFlow 继续采用客户端 UUID + 本地先写 + LWW 的同步模型，但必须把当前已启用的 Supabase Realtime 纳入上线门禁，避免把 WebSocket 事件误当成权威数据源。

覆盖范围：

- `RealtimePollingService` 负责主同步路径的 Supabase `postgres_changes` invalidation 与 polling fallback。
- `BlackBoxSyncService` 独立维护 `black_box_entries` Realtime channel、`lastSyncTime` 和 IndexedDB cursor；它不能被主同步 smoke 间接代表，必须单独覆盖。
- `BlackBoxEntry.updatedAt` 是 LWW 关键字段，`deletedAt` 是 tombstone 语义。Focus/BlackBox 的 pending merge、已读/完成单调合并、删除不复活规则必须和任务/连接同步一样进入迁移门禁。

硬约束：

- Realtime payload 只作为 invalidation / wake-up 信号。收到 `INSERT` / `UPDATE` / `DELETE` 后触发增量拉取或 drift check，由统一 merge 管线处理，不能直接覆盖 idb-keyval 或 Signals store。
- 增量拉取仍以服务端 `updated_at` / `updatedAt`、soft delete tombstone 和 LWW 规则为准；如果尚未实现组合 cursor，安全回看窗口是硬门禁，避免客户端时钟、WebSocket 延迟、同 timestamp 分页或重复事件造成漏拉。
- 云端写入不能用无条件 `upsert` 表达 LWW。同步实体 push 必须携带本地已知的 `baseServerUpdatedAt` / 等价版本，走 Postgres RPC 或等价条件更新：远端不存在时插入；远端当前版本仍等于本地基线时更新；远端版本已经前进时返回 conflict / remote-newer，由客户端先 pull+merge，再决定是否重新排队。
- 如果数据库触发器会把 `updated_at` 改成服务端 `now()`，成功 push 后必须把返回的 canonical `updated_at` 写回 Signals store、IndexedDB 快照和 pending queue 元数据。任务、连接、Project、BlackBox/Focus 的 timestamp 语义必须一致，禁止一部分实体用服务端时间、一部分实体继续保留客户端时间。
- `lastSyncTimeByProject` / BlackBox `lastSyncTime` 这类同步游标只能在远端变更成功 merge 到 store 且 IndexedDB 持久化成功之后提交。`checkForDrift()`、`refreshActiveProjectSilent()`、resume/probe、BlackBox 增量同步都只能返回候选 `nextCursor`，不应在调用方还没完成 merge/persist 时自行推进游标。
- 同步游标必须来自已处理远端数据的 watermark，例如本批 remote rows 的最大 `updated_at` 或服务端返回的 remote watermark；禁止用客户端 `new Date().toISOString()` 表示“云端已同步到现在”。
- timestamp-only cursor 不足以保证不漏数据。阶段 1 优先把 cursor 结构升级为 `(updated_at, id)` 或 `(updated_at, entity_type, id)`，查询按 `order by updated_at asc, id asc` 稳定分页，并使用 `(updated_at, id) > (:last_updated_at, :last_id)` 语义。若短期不能改 schema/IndexedDB cursor，必须强制每轮从 `lastSyncTime - 30s` 之类安全窗口回看，按 `entity_type + id + updated_at` 去重，且 tombstone 优先；“必要时回看”不能作为上线门禁。
- RetryQueue/ActionQueue 的每个 mutation 必须有全局 `operation_id`、目标 entity、`base_version` / `baseServerUpdatedAt` 和依赖关系。单一 entity 的 mutation 保序；跨实体依赖必须显式表达，例如 connection 依赖 source/target task 仍存在，attachment/focus recording 依赖 owner 仍未删除。delete/tombstone 是 barrier，后续旧 update/upload 必须被拒绝、丢弃或转入 cleanup。
- 本地 dirty / locked field 保护必须先于远端覆盖；被保护而跳过的 remote event 必须能由下一轮 polling、resume probe 或全量 drift check 恢复。
- Realtime 断线、`CHANNEL_ERROR`、`TIMED_OUT`、浏览器后台静默断连都必须进入 fallback polling；fallback 状态要有 Sentry breadcrumb / metric，不能只停留在 console。
- 如果 origin 变化，旧 Vercel 与新 Cloudflare 不应长期双写同一生产 Supabase。旧 origin 在割接后优先进入只读/导出模式；只有主动回滚窗口内才允许恢复写入。
- 如果继续保持 `REALTIME_ENABLED=true`，阶段 1 默认必须启用 Supabase Realtime `worker: true` 和 `heartbeatCallback`。heartbeat `timeout` / `disconnected` 进入 Sentry breadcrumb / metric，并立即唤醒 fallback polling。若 worker 模式因兼容、CSP 或 worker 文件加载失败不能启用，必须有显式例外 PR、后台标签页长时运行测试和 polling-only 兜底证据。

必须新增或复用的测试：

- 离线本地写入 + 另一端远端写入 + 本端重连后，LWW 结果稳定，RetryQueue/ActionQueue 清空。
- WebSocket 被切断或收到 `TIMED_OUT` 后，进入 polling fallback，并最终拉到远端变更。
- merge 或 IndexedDB 持久化失败时，同步游标不能推进；修复后下一轮仍能拉到同一批远端变更。
- 离线队列里的旧 task/connection push 在远端版本已前进时不能普通 upsert 覆盖远端；应返回 conflict/remote-newer，pull+merge 后再按 LWW 结果处理。
- 成功 push 后，本地 task/connection/Project/BlackBox 的 `updatedAt` 与服务端返回的 canonical timestamp 一致；刷新后 IndexedDB 中仍是 canonical 值。
- 全仓 `setLastSyncTime` / `lastSyncTime` 写入点都有测试或代码注释证明：候选 cursor 先暂存，store merge + IndexedDB persist 成功后才 commit。
- 同一 timestamp 下多行变更、分页中断、批量写入和排序不稳定不会漏拉；组合 cursor 测试或强制回看窗口测试必须覆盖同 `updated_at` 的两条以上 row。
- ActionQueue/RetryQueue 重放覆盖 task 创建、connection 创建、attachment/focus recording 上传、task 删除的跨实体顺序；删除后旧上传或旧连接创建不能留下孤儿数据。
- tombstone 胜过旧的 Realtime update，不出现删除后复活的幽灵任务。
- `black_box_entries` 的 Realtime 断线、fallback polling、pending merge、`updatedAt` 游标提交和 `deletedAt` tombstone 测试必须单列，不允许只用任务同步用例代替。
- 切域期间旧 origin 与新 origin 不会同时作为常规写入入口；若必须双开，写入结果必须由同一 LWW/tombstone 规则收敛。

### 6.5 多标签 sync single-writer 门禁

多标签页是 Realtime / IndexedDB 风险的同源放大器。`TabSyncService` 可以提醒其他标签页有状态变化，但它不是 RetryQueue、ActionQueue、cloud push 或 cursor commit 的强互斥机制。阶段 1 需要把“本地可写”和“云端同步写入者”分开：

- 每个标签页仍可本地写 IndexedDB 并即时更新 UI；只有获得 sync writer lease 的标签页可以 flush RetryQueue/ActionQueue、执行 cloud push、提交 `lastSyncTime`。
- 首选 Web Locks API：锁名包含环境、userId 和 projectId，例如 `nanoflow-sync:production:<userId>:<projectId>`；锁内禁止嵌套其他长期锁，必须有 timeout / AbortSignal，避免死锁。
- 不支持 Web Locks 时，使用 IndexedDB lease + BroadcastChannel heartbeat 作为降级：lease 包含 `ownerTabId`、`expiresAt`、`lastHeartbeatAt`；过期后才能抢占。仅 BroadcastChannel 消息不能作为强所有权。
- 非 owner 标签收到 Realtime event、online/resume 或本地队列变更时，只能通知 owner 或等待下一轮 lease；不能自己直接 flush。
- Web Locks 按 origin 隔离，不能解决旧 Vercel 与新 Cloudflare 双 origin 双写；origin 迁移仍依赖 §7 的 export-only/read-only 策略。

必须新增或复用的测试：

- 两个标签页同时离线写入并恢复联网，只有一个标签页执行 cloud push/cursor commit，队列最终归零且无重复写。
- sync writer 标签页关闭或崩溃后，lease 在 TTL 后被另一个标签页接管，并继续 flush 未完成队列。
- 非 owner 标签收到 Realtime event 后不会推进 cursor；owner 完成 pull+merge+persist 后，其他标签页通过 BroadcastChannel/IndexedDB 看到新状态。
- Web Locks 不可用时走 IndexedDB lease 降级；BroadcastChannel 不可用时至少禁止并发 flush，并上报 Sentry breadcrumb / metric。

## 7. Origin 迁移数据保护

NanoFlow 是 Local-First 应用，核心数据先落 IndexedDB。浏览器存储按 origin 隔离；从 `https://dde-eight.vercel.app` 切到 `https://app.nanoflow.app` 或 `https://nanoflow.app` 时，旧 origin 下的 IndexedDB、localStorage、Service Worker、PWA 安装状态不会自动搬到新 origin。

这意味着：

```text
用户打开新域名
浏览器看到一个全新的 IndexedDB 空间
首屏可能像“数据没了”
实际数据仍在旧 origin 的 IndexedDB 或 Supabase 中
```

如果所有设备都已登录，且 RetryQueue/ActionQueue 已清空，新域名首次登录后可以通过 Supabase 重新拉取缓解。以下场景不能依赖自动恢复：

- 未登录访客或本地-only 数据。
- 设备长期离线，存在未同步写入。
- 附件或大文件还没有上传完成。
- 用户只在旧 Vercel 默认域安装 PWA，从未使用 custom domain。

迁移前数据保护门禁：

- 所有活跃设备打开旧站，确认 RetryQueue / ActionQueue 为空。
- 至少完成一次“新增任务 -> 等待同步 -> 另一设备或隐身窗口登录后可见”的验证。
- 未登录或本地-only 用户必须先导出 JSON。
- 如果有附件、语音或大文件，额外导出 ZIP 或确认 Supabase Storage 已有远端副本。
- 切域名前保留旧 Vercel origin 至少 72 小时，作为找回本地数据的窗口。
- 切域名后旧 Vercel origin 优先切到只读/导出提示页；除非正在执行回滚，不允许它继续作为常规写入入口，避免旧域和新域同时向生产 Supabase 写入造成版本竞争。
- 切域名后首次打开需要重新登录，这是预期行为。
- 不承诺 IndexedDB 从旧 Vercel 默认域自动迁移到新 custom domain。

旧 origin 的“只读/导出”必须是可执行机制，不能只靠从 Supabase allow-list 移除旧域。原因是旧 Vercel 部署里已经发出的前端 JS 仍持有生产 Supabase URL/anon key，只要 CORS/Auth 仍允许，就可以继续写入；而粗暴移除 CORS 又会阻断用户导出本地残留数据。

阶段 1 必须准备一个 export-only / read-only 旧站构建或等价运行时开关：

- 进入旧 origin 时显示只读/导出入口，保留 JSON/ZIP 导出和本地数据读取能力。
- 禁止新增、编辑、删除、拖拽、语音写入、附件上传等会产生远端写入的 UI action。
- 停止 RetryQueue / ActionQueue flush、Supabase cloud push、Realtime write probe 和会改变服务端状态的 Edge Function 调用。
- 允许登录状态用于读取/导出，但不允许把旧 origin 当作常规工作入口；只有执行回滚时才能恢复写入构建。
- 若无法在旧 Vercel 部署上发布 export-only 构建，阶段 3 不允许把新 Cloudflare origin 接到生产 Supabase 写入路径。

验收时需要明确区分：

- **同一 custom domain 换托管商**：origin 不变，IndexedDB 仍可见，主要风险是 DNS/PWA 缓存。
- **从 Vercel 默认域换到新 custom domain**：origin 变化，浏览器本地数据天然隔离，必须依赖云端同步或手动导出恢复。

### 7.1 Canonical Origin Gate

Local-First/PWA 语义下，`https://nanoflow.app`、`https://www.nanoflow.app`、`https://app.nanoflow.app`、`https://nanoflow.pages.dev` 和旧 Vercel 默认域不是同一个应用入口；它们是不同 origin，各自拥有 IndexedDB、localStorage、Service Worker 和离线队列。生产环境只能有一个 canonical writable origin。

阶段 1 必须增加最早期 origin gate。它必须是 `index.html` `<head>` 中最前面的同步内联脚本（非 `defer` / 非 `async`），早于任何 modulepreload、Angular bootstrap、Service Worker 注册和 Supabase 初始化：

- 生产构建注入 `NG_APP_CANONICAL_ORIGIN` / `CANONICAL_PRODUCTION_ORIGIN`，例如 `https://app.nanoflow.app`。
- 如果 `location.origin !== canonicalOrigin`，进入 redirect 或 read-only/export-only 模式；禁止注册 Service Worker、初始化 Supabase client、启动 Realtime、flush RetryQueue/ActionQueue、调用会写服务端的 Edge Function。
- 如果检测到旧 origin、非 canonical origin、`version.json.ngswHash` 与当前 `ngsw.json` 不一致、或明确的 `forceSwReset` boot flag，只允许执行一次受控清理：`navigator.serviceWorker.getRegistrations().unregister()`、删除本应用 Cache Storage / `ngsw:*` cache，并设置一次性 marker 避免 reload loop。清理前不得 flush 队列。
- `pages.dev` 只允许 custom domain 生效前 production smoke；smoke 结束后 redirect/read-only，不能成为第二生产入口。
- apex 与 `www` 只能二选一作为 canonical，另一个必须 301/302/Cloudflare redirect 到 canonical 或 read-only。不要让 apex、`www`、`app` 同时运行完整可写 PWA。
- Canonical Origin Gate 不是安全边界的全部。因为 Supabase anon key 已在前端，真正的数据写入仍要靠 RLS、条件写入/RPC、sync single-writer 和 queue contract；origin gate 是避免多入口 PWA 分叉的第一道执行机制。

验收：

- 在 `pages.dev`、旧 Vercel、非 canonical apex/`www` 打开生产 bundle，不注册新的 Service Worker，不创建 Supabase client，不 flush 本地队列。
- 在旧 origin 已有 SW/background tab 的情况下刷新，origin gate 仍先于 Angular bootstrap 执行；必要时触发一次 SW unregister + cache delete，且不进入无限 reload。
- 非 canonical origin 若有旧 IndexedDB 数据，只显示导出/迁移提示，不允许新增、编辑、上传或同步写入。
- DevTools Console 脚本检查所有 `caches.keys()`，不仅检查 URL，也检查 cache name；迁移后不应残留旧 origin/旧 deployment 命名的 app cache 或 `ngsw:*` cache。
- Sentry breadcrumb 记录 `origin_gate_blocked` / `origin_gate_redirected`，阶段 4 能确认没有用户长期停留在非 canonical writable origin。

### 7.2 同域 DNS 分裂脑门禁

即使 origin 不变，DNS 从 Vercel 切到 Cloudflare 的 TTL 收敛期也可能让同一 `https://app.nanoflow.app` 一部分用户命中 Vercel，另一部分用户命中 Cloudflare。此时 IndexedDB 和 Service Worker 是同一个 origin，但运行的前端部署可能不同，风险比跨 origin 更隐蔽。

门禁：

- DNS 割接前，把**同一份构建产物**同时部署到 Vercel 和 Cloudflare：同一 commit、同一 `dist/browser`、同一 `index.html`、同一 hash chunk、同一 `ngsw.json`、同一 feature flags、同一 Sentry environment。
- 阶段 3 只迁移托管层，不同时合并业务功能、schema 语义或同步协议变更。DNS 稳定后再单独发下一版业务代码。
- Vercel 回滚后备在 24-72 小时内也必须继续服务同一份构建产物或 export-only/read-only 构建，不能让旧 Vercel 自动部署不同版本。
- production smoke 对 Vercel custom domain 和 Cloudflare `pages.dev` / custom domain 分别抓取 `/version.json`、`/ngsw.json`、`index.html` 入口 chunk 名，确认一致后再切 DNS。

验收失败条件：

- 同一 custom domain 下 Vercel 与 Cloudflare 的 `/version.json.gitSha`、入口 chunk、`ngsw.json` hash 不一致。
- DNS 切换窗口同时存在两个可写业务版本。
- Vercel 自动部署仍开启并可能在 Cloudflare production 稳定前发布新代码。

## 8. PWA 与 version skew 防御

### 8.1 已有应用层防御

本仓库已经具备三层防御：

- `GlobalErrorHandler` 捕获 `ChunkLoadError`、`Failed to fetch dynamically imported module`、`Loading chunk failed` 后清缓存并 reload。
- 同一错误 30 秒内有 reload loop protection，避免无限刷新。
- `SwUpdate.VERSION_READY` 会提示用户刷新，并调用 `reloadViaForceClearCache()`。

迁移任务不是新增重复逻辑，而是验证这些路径在 Cloudflare 域名下仍工作。

### 8.2 必测升级演练

上线前执行一次旧版本到新版本的 PWA 演练：

1. 在旧站打开并安装/注册 PWA。
2. 保持页面后台挂起或关闭后重开。
3. 部署新版本到 Cloudflare preview/production。
4. 重新打开应用。
5. 进入 Text 视图和 Flow 视图。
6. 验证不出现 `JIT compiler unavailable`、`ChunkLoadError`、`Loading chunk failed`。
7. 验证新版本 toast 可触发强制刷新。
8. 验证 IndexedDB 首屏恢复，后台同步后队列归零。

### 8.3 Cloudflare 优化开关

不要为了性能盲目开启会改写前端产物的功能：

- 不启用 Rocket Loader。
- 不启用会改写 JS/CSS 的 Auto Minify，Angular build 已经压缩。
- 不对 `index.html`、`ngsw.json`、SW 脚本设置 Cache Rules 长缓存。

可使用的平台优化：

- Cloudflare 默认内容压缩。官方支持 Gzip、Brotli、Zstandard，按浏览器 `Accept-Encoding` 和计划配置投递；CI 不需要预压缩 JS/CSS。
- Early Hints。Pages 对 `pages.dev` 和 custom domains 自动启用，并可从 HTML 中的 `preload`、`preconnect`、`modulepreload` 生成 Link header。首版通过 `_headers` 的 `! Link` 关闭自动 Link 生成，避免 DNS/TLS/SW 稳定前放大 chunk 预加载错误；后续若单独打开，再验证 103 与所有 preload chunk 的 MIME/hash/`ngsw.json` 对齐。

### 8.4 Flow / GoJS 运行时性能与 OnPush 桥接门禁

Cloudflare 迁移本身不改 GoJS 运行时，但发布 smoke 不能只验证“Flow chunk 能加载”。当前仓库已经把 GoJS 初始化放在 Angular zone 外，并把部分状态性事件通过 `zone.run()` 桥回 Angular；迁移阶段需要把这类隐性契约写成可执行门禁。

性能门禁：

- 50-200 节点：Flow 视图必须维持当前完整交互能力，作为基础 smoke 数据规模。
- 超过 500 节点或连线密集：必须采样首开、自动布局、拖拽、缩放的 long task；preview smoke 中单次用户动作不应出现持续 200ms 以上的主线程长阻塞。
- 超过 1000 节点或跨树连线密集：默认进入 Text 视图或降级 Flow，禁止自动触发同步 auto layout；只有提交性能证据后才允许默认打开完整 Flow。
- `applyAutoLayout()` / `computeFamilyBlockAutoLayout()` 这类布局预计算如果超过预算，后续必须迁移到 Web Worker 或分片调度；主线程 GoJS 只接收坐标/模型增量并负责渲染。
- Worker / 分片布局必须带 `layoutGeneration`、`projectId`、`graphRevision` 和输入 hash。用户在布局计算期间继续编辑、切换项目或销毁 Flow 时，旧 generation 的结果必须丢弃，不能晚到覆盖新坐标。
- 同一时间只允许一个自动布局任务写回同一 project 的坐标；新的自动布局开始时应取消或标记废弃旧任务。Worker 不可用时降级为分片调度或禁用自动布局，不允许回退成无预算的同步大计算。
- 布局任务实现层面要有可观察的取消语义：主线程分片用 `AbortController` / `AbortSignal`，Worker 布局用 `layoutTaskId` + cancel message；写回坐标前再次读取当前 `graphRevision` 和组件 alive 状态，二次校验失败只能记录 `stale_layout_dropped`，不能写 store。
- 大图性能门禁不仅看 long task，还要记录 Flow 首开到可交互时间、自动布局总耗时、坐标写回耗时，以及 10 次 Flow 打开/销毁后的 GoJS Diagram 实例、全局 listener、timer 和 heap 增长趋势。

OnPush / Signals 桥接门禁：

- GoJS 的 mouse move、drag、layout、overview 等高频事件继续留在 Angular zone 外。
- 会改变应用状态的事件，例如选择节点、拖出任务、创建/删除连线、打开详情、切换主题，必须通过 `NgZone.run()`、signal/effect 或等价桥接进入 Angular 响应式上下文。
- GoJS 事件桥接必须只传递必要的稳定状态，不把 GoJS mutable object 长期保存在 Signals store 中；进入 Angular zone 前先归一成 taskId/connectionId/position/selection 这类普通数据。
- Flow 组件销毁时必须释放 GoJS listener、document/window handler、timer 和 subscription；移动端仍坚持默认 Text 视图，Flow 按需加载且销毁/重建，不能用 `visibility:hidden` 持有图实例。
- Playwright smoke 至少覆盖桌面 Flow 首开、节点选择后详情面板刷新、拖拽/连线后的 store 状态刷新、主题切换后画布样式刷新、自动布局期间继续编辑后旧布局结果被丢弃、返回 Text 视图后图实例释放。

## 9. DNS、域名与回滚

### 9.1 两种割接路径

**路径 A：只把子域名 CNAME 指向 Cloudflare Pages，不迁移权威 DNS。**

这是最小改动路径，但只适用于子域名，例如 `app.nanoflow.app` 或 `www.nanoflow.app`。只需要在现有 DNS 提供商处修改对应 CNAME，通常不涉及 Nameserver 切换，也不需要移除 DNSSEC DS 记录。

执行：

- 割接前 48-72 小时把目标记录 TTL 降到 60 秒；若 DNS 提供商或记录类型不允许 60 秒，退回 300 秒并把 split-brain 观察窗口延长到至少 72 小时。
- 在 Cloudflare Pages 绑定 custom domain，等待 TLS 状态正常。
- 修改子域名 CNAME 到 Cloudflare Pages 要求的 `<project>.pages.dev` 目标。
- 用全球 DNS 检查工具确认解析收敛。
- 保留 Vercel 旧部署 24-72 小时。

**路径 B：把域名权威 DNS 迁到 Cloudflare full setup。**

只有在决定让 Cloudflare 接管 DNS zone 时使用。若生产域名坚持使用 apex/root domain `nanoflow.app`，应走这条路径；Cloudflare Pages 的 apex domain 需要该域名作为 Cloudflare zone 并配置 nameserver。此时需要处理 DNSSEC。

执行：

- 割接前 48-72 小时把相关 A/AAAA/CNAME TTL 降到 60 秒；不支持 60 秒时记录限制并按 300 秒窗口执行。
- 如果旧 DNSSEC 已启用，先在注册商处移除旧 DS 记录，并等待缓存过期；Cloudflare 官方提示旧 DS 记录会导致 Nameserver 迁移后解析失败。
- 添加 Cloudflare zone，核对 DNS 记录。
- 在注册商处把 Nameserver 改为 Cloudflare 分配的 NS。
- 等待 zone active 和全球解析收敛。
- 稳定 72 小时后，在 Cloudflare 启用 DNSSEC，并把 Cloudflare 生成的新 DS 记录写回注册商。

不要在仅修改子域名 CNAME 的路径 A 中误删 DS 记录；那是 Nameserver 迁移路径 B 才需要处理的问题。

### 9.2 回滚策略

应用层回滚：

- 如果是新版本代码问题，优先使用 Cloudflare Pages Dashboard 的 Rollback to this deployment。
- 也可以使用 Pages Deployments Rollback API 自动化。
- 不使用 `wrangler rollback` 作为 Pages 回滚命令。

基础设施回滚：

- 如果是 custom domain、TLS、DNS、Cloudflare 边缘配置问题，把 DNS 记录切回 Vercel。
- 因为 TTL 目标已降到 60 秒（或受限时 300 秒），主流递归解析器理论上数分钟内恢复；移动网络、企业代理、iOS/Safari 后台和旧 SW 仍按 72 小时 split-brain 窗口处理，不把 TTL 当成绝对保证。
- Vercel 旧部署至少保留 24-72 小时，且不要在稳定前删除 Vercel 环境变量。

触发回滚的条件：

- 生产首屏白屏或 JS/CSS 被错误返回为 HTML。
- 任意 Angular route 刷新 404。
- 登录/OAuth 回调无法完成。
- 新增任务、离线写入、恢复联网同步失败。
- Sentry 出现持续的 `ChunkLoadError`、`JIT compiler unavailable`、`DI-version-skew`。
- `ngsw.json`、`sw-composed.js`、`ngsw-worker.js` 被长期缓存。

## 10. Android TWA 影响

如果沿用原自定义域名：

- TWA origin 不变。
- 只需确认 `/.well-known/assetlinks.json` 在 Cloudflare Pages 下返回 `200`、`application/json`、正确 SHA256 指纹。
- 确认 `manifest.webmanifest` 的 `id` 和 `start_url` 不被迁移改动。

如果改用新的 Cloudflare 域名：

- Android TWA origin 需要更新。
- `assetlinks.json` 必须发布在新域名的 `/.well-known/assetlinks.json`。
- Android 包名和 SHA256 证书指纹保持一致。
- 安装包或 Play Store 配置需要同步新 URL。

建议优先沿用正式自定义域名，减少 TWA 和 PWA origin 变化。

## 11. 个人项目裁剪项

本迁移不需要执行以下企业级动作：

- 不建立 SOC 2、GDPR、PCI 审计包。
- 不配置多用户审批链路。
- 不做复杂的 WAF/Rate Limiting 分层。NanoFlow 静态站主路径没有 Cloudflare API 代理；Supabase 请求直连 Supabase，Cloudflare WAF 不会保护这些请求。
- 不开启 Cloudflare Under Attack Mode 或全站 Challenge。它可能干扰 PWA、OAuth callback、Service Worker 更新和 preview smoke。
- 不为了“边缘计算”引入 Pages Functions。当前没有业务收益，还会让 `_headers`、`_redirects` 行为复杂化。

保留的轻量安全项：

- 最小权限 Cloudflare API Token。
- Source Map 不公开部署。
- `X-Content-Type-Options`、`X-Frame-Options`、`Referrer-Policy`。
- 旧 Vercel redirect/CORS 只保留回滚窗口，不长期开放。

## 12. 实施路线图

### 阶段 -1：Vercel 弊病修复与迁移窗口保底

- [x] **manifest `id` 一票否决检查**（§16.8 的具体执行）：在 main 分支当前构建产物上跑：

  ```bash
  npm run build
  cat dist/browser/manifest.webmanifest | jq -r '.id, .scope, .start_url'
  ```

  决策树：

  | `id` 当前值 | 结论 |
  | --- | --- |
  | 相对路径（如 `"/"`、`"./"`、`"."`） | ✅ 安全，迁移后 PWA 仍是同一个 app（PWA `id` 解析为 origin + 相对路径，origin 变化但 `id` 解析后会一并变；接受用户重装是迁移本身要求） |
  | 未设置 / 字段缺失 | ✅ 浏览器 fallback 到 `start_url`，行为同上 |
  | 包含 `dde-eight.vercel.app` 或任何旧 origin 绝对 URL | 🚫 一票否决——保留这个值会让新域名下变成"另一个 PWA"，所有用户都要重新安装且本地 IndexedDB 不会自动迁移；阶段 0 内必须先把 `manifest.webmanifest` 模板里的 `id` 改成相对路径，`scope`/`start_url` 同步处理 |

  阶段 0 不通过这一项 → 阻塞迁移；阶段 1 的 CI artifact guard 需断言 `manifest.webmanifest` 不含 `vercel.app` 字符串（已列在阶段 1）。（2026-04-29 当前 `public/manifest.webmanifest` 使用相对 `id: "/launch.html"`、`scope: "./"`、`start_url: "./"`，artifact guard 已断言不含 `vercel.app`。）
- [x] 确认 `vercel.json` 的 `ignoreCommand` 仍指向 `bash scripts/vercel-ignore-step.sh`。
- [ ] 检查近期触发构建的提交是否主要改了 `src/`、`public/`、`package*.json`、`angular.json`、`ngsw-config.json` 等真实构建路径。
- [x] 如果只是文档提交仍触发 Vercel 构建，先修 `scripts/vercel-ignore-step.sh` 的 watched paths。（2026-04-29 `WATCHED_PATHS` 不含 `docs/`，文档-only diff 会 `exit 0` 跳过 Vercel build。）
- [x] 如果真实代码构建导致分钟耗尽，但 Cloudflare production 还没完成割接，临时新增一个 GitHub Actions workflow 使用 `vercel pull`、`vercel build`、`vercel deploy --prebuilt`。（2026-04-30 已新增手动 `vercel-prebuilt-recovery.yml`，默认 `legacy-export-only`，需要确认 token 才会 deploy。）
- [ ] 确认 Vercel 即使全失能，也有备份的 GitHub Secrets 与 Supabase secrets 可读；Cloudflare 与 Supabase 凭据不要只存在 Vercel 中。
- [ ] 临时 Vercel 预构建方案需要 `VERCEL_TOKEN`、`VERCEL_ORG_ID`、`VERCEL_PROJECT_ID`，只用于迁移窗口内的应急发布和回滚后备。（2026-04-30 workflow 已就绪；Secrets 是否已写入仍需 GitHub Settings 确认。）
- [ ] 如果临时升级 Vercel，只把它当作迁移窗口的时间缓冲；不要以此延后 Cloudflare 迁移。
- [ ] Cloudflare production 稳定后，删除或禁用临时 Vercel 预构建 workflow，并关闭 Vercel 自动部署。

### 阶段 0：准备

- [x] 创建 Cloudflare Pages 项目，选择 Direct Upload。（2026-04-29 `wrangler pages project list` 可见 `nanoflow`，Git Provider 为 `No`。）
- [x] 按 §4.6 路径创建 Direct Upload 项目，避免误选 Git integration。（2026-04-29 已确认项目存在且不是 Git integration。）
- [x] 确认项目名，例如 `nanoflow`，记录 `nanoflow.pages.dev`。（2026-04-29 已按用户提供的 canonical writable origin 记录；线上 API 操作仍等待有效 token。）
- [x] 创建最小权限 `CLOUDFLARE_API_TOKEN`。（2026-04-29 权限修正后，Wrangler Direct Upload 已成功。建议本次部署完成后轮换该 token。）
- [ ] 在 GitHub Secrets 写入 Cloudflare、Supabase、GoJS、Sentry、Android TWA fingerprint 变量；PR preview 使用 GitHub Environment `NanoFlow-Preview` 中的同名 Supabase secrets，缺失时 fail-fast，不得静默回退生产 Supabase。（阻塞：需要仓库 Settings 权限或有效 GitHub/Cloudflare/Supabase 控制台操作。）
- [ ] 设置 GitHub Variables：`ENABLE_SENTRY_SOURCEMAPS=false`；`READ_ONLY_PREVIEW=true`；`CLOUDFLARE_CUSTOM_DOMAIN_ORIGIN` 等 custom domain TLS active 后再填。
- [ ] 确认 Direct Upload production branch 为 `main`；必要时用 API 设置。
- [x] **Workers Static Assets 备选路径评估**：按 §4.1.2 记录是否需要 Workers-only 能力；首版仍选 Pages，但已新增 `wrangler.workers-static-assets.dry-run.toml` 与 `cloudflare/workers-static-assets/shell-worker.js`，dry-run workflow 只执行 `wrangler deploy --dry-run`，不发布 production。配置固定 `assets.directory=./dist/browser`、`binding=ASSETS`、`not_found_handling=single-page-application`、`run_worker_first=["/*"]`，并由合同测试禁止 routes/account_id 进入 dry-run fallback。
- [x] **Canonical origin 决策**：在 `app.nanoflow.app` / `www.nanoflow.app` / `nanoflow.app` 中只选择一个生产可写 origin，写入 `CANONICAL_PRODUCTION_ORIGIN`；其他 origin 明确 redirect 或 read-only/export-only。（2026-04-29 首轮 production smoke / writable origin 暂定 `https://nanoflow.pages.dev`；custom domain active 后仍必须执行 `pages.dev` 收敛。）
- [ ] **同域 DNS 分裂脑门禁**：若沿用同一 custom domain，阶段 3 只能部署同一份 `dist/browser` 到 Vercel 与 Cloudflare；DNS 稳定前不允许合并业务版本、schema 语义或同步协议变更。
- [ ] 在 Supabase Auth redirect allow-list 加入 custom domain、临时 Pages production smoke origin、preview、本地开发域名，并记录 custom domain smoke 通过后移除 `pages.dev` 的收敛任务。
- [ ] 审查 Supabase Auth `redirectTo` 生成与 Email Templates：全仓 grep `redirectTo` / `location.origin` / `SITE_URL` / `auth/callback` / `reset-password`，并在 Dashboard 检查模板是否仍固定旧 Site URL。（2026-04-30 用户已完成 Dashboard Site URL / Redirect URLs / Email Templates；代码侧 `resetPassword()` 与 `signUp()` 已走 canonical helper，Magic Link / OAuth 真实回调 smoke 仍需执行。）
- [ ] 明确生产域名：子域名可走路径 A；apex/root domain 必须走路径 B。
- [ ] 若走 DNS 路径 A，提前降低子域名 CNAME 记录 TTL 到 60 秒；不支持 60 秒时记录为 300 秒并延长 split-brain smoke。
- [ ] 若走 DNS 路径 B，提前降低相关 A/AAAA/CNAME TTL 到 60 秒，并处理旧 DNSSEC DS 记录；导出旧 DNS zone，与 Cloudflare zone 导入结果逐项 diff，至少覆盖 A/AAAA/CNAME、MX、TXT、CAA、NS、DS、SRV。
- [ ] **Cloudflare zone 规则 inventory**：full DNS 或 custom domain 已在 Cloudflare zone 下时，列出 app host 命中的 Cache Rules/Page Rules/Transform Rules/Security Rules/Bot/Challenge/Always Online；禁止 Cache Everything、HTML Edge TTL、Browser TTL override、JS/CSS/HTML 改写、Rocket Loader、Auto Minify、Email Obfuscation 和全站 Challenge 命中 app host。若必须保留 zone 规则，必须用精确 hostname/path 排除 `index.html`、`ngsw.json`、SW 脚本、`version.json`、Auth callback 和 hashed chunks。
- [ ] **实际响应头验证门禁**：zone 规则 inventory 只能证明配置意图，不能证明最终响应。阶段 2/3 必须用 `curl -I` 对 `pages.dev` 与 custom domain 的实际响应头做对比，记录 `CF-Cache-Status`、`Age`、`CF-Ray`、`Cache-Control`、`Content-Type`，确认 `_headers` 没被 Cache Rules / Transform Rules / Challenge 覆盖；freshness 关键路径不得返回 `CF-Cache-Status: HIT` 且 `Age > 0`。
- [ ] 所有活跃设备打开旧站，确认 RetryQueue / ActionQueue 为空；本地-only 数据先导出。
- [ ] **Supabase migration 顺序门禁（向 §16.10.3 看齐）**：阶段 0 必须运行 `supabase migration list` + `supabase db diff --schema public` 盘点所有未发布迁移，并按"是否向后兼容"分两批（2026-04-30 `20260429080000` / `20260430100000` 已通过 `supabase db push` 应用，`migration list` 已对齐；`db diff` 因本机 Docker daemon 缺失未完成，仍是上线前硬门禁）：
  - **批次 A（向后兼容）**：新增列允许 NULL、新增表、不删旧字段。**这一批必须先于前端发布**，是上线 Cloudflare 前的硬阻塞门禁。
  - **批次 B（不兼容收紧）**：删除字段、加 NOT NULL、加 CHECK 约束。**禁止与前端迁移同窗口发布**；推迟到阶段 4 稳定 24h 后单独 PR。
  - 任何未通过分批盘点的 migration → 阶段 0 不允许进入阶段 1。
- [ ] **Realtime 当前状态门禁**：确认 `FEATURE_FLAGS.REALTIME_ENABLED` 的生产值。若保持开启，按 §6.4 把 `RealtimePollingService` 与 `BlackBoxSyncService` 的 WebSocket 断线、fallback polling、LWW/tombstone 合并纳入测试；若临时关闭，必须用独立 PR 显式关闭并补 polling-only 验收。（2026-04-30 代码值仍为 `true`，project Realtime fallback 单测已有；BlackBox Realtime 与真实后台/弱网 smoke 仍需执行。）
- [ ] **Realtime 指标门禁**：阶段 0 定义 Sentry metric/breadcrumb 名称与阈值，至少包含 `heartbeat_timeout`、`realtime_disconnected`、`realtime_channel_error`、`realtime_fallback_polling_started`、`sync_queue_stuck`；阶段 2/3 smoke 必须能制造并观察至少一条 fallback 事件。（2026-04-30 已补 `realtime_channel_error` / `realtime_fallback_polling_started` breadcrumb 单测；`sync_queue_stuck` 与 Sentry 线上筛选仍需在真实环境确认。）
- [ ] **条件写入门禁**：inventory 所有同步实体的 cloud push/upsert 路径（task、connection、project、BlackBox/Focus、user preference 如适用）。凡会参与 LWW 或 cursor 的实体，阶段 1 必须改成条件写入/RPC 或证明远端新版本不会被旧离线写覆盖。
- [ ] **游标门禁**：inventory 全仓 `setLastSyncTime` / `lastSyncTime` 写入点，包括 `SimpleSyncService.checkForDrift()`、`DeltaSyncCoordinatorService`、`SyncCoordinatorService.refreshActiveProjectSilent()`、resume/probe 和 BlackBox 路径；确认游标不会早于 merge + IndexedDB 持久化成功推进，且不使用本地 `new Date()` 冒充远端 watermark；优先升级组合 cursor，短期强制安全回看窗口。若当前实现不满足，阶段 1 必须先修。
- [ ] **队列契约门禁**：inventory RetryQueue/ActionQueue 的 mutation 类型，列出 operation_id、同实体顺序、跨实体依赖和 tombstone barrier；必须覆盖 task、connection、attachment、focus recording。
- [ ] **多标签 single-writer 决策**：决定 Web Locks + IndexedDB lease 降级方案的锁名、TTL、Sentry metric 和浏览器兼容策略；没有单写者方案或等价幂等证明不得进入阶段 2。
- [ ] **旧 origin 写入策略**：如果 origin 变化，设计旧 Vercel 的 export-only/read-only 构建或运行时开关：阻断写入 UI、RetryQueue/ActionQueue flush、cloud push 和会写服务端的 Edge Function，同时保留 JSON/ZIP 导出。没有该机制不得进入阶段 3。（2026-04-30 已有 `vercel-legacy` / `export-only` 构建路径、Task/Project 本地 mutation guard、RetryQueue/ActionQueue flush guard；旧域导出 e2e 与 Edge Function mutation 入口 smoke 仍需执行。）
- [ ] **server-side 写入保护策略**：确认所有云端 mutation 是否已通过 RPC/Edge Function 或等价受控路径。阶段 3 前必须能在服务端拒绝旧 `syncProtocolVersion` / 旧 `deploymentEpoch` / 重复 `operation_id` / tombstone barrier 之后的旧 mutation；如果仍有直接 table mutation 绕过该保护，必须先迁到 RPC/CAS 或证明 RLS 等价拦截。
- [ ] **Flow 规模阈值决策**：确定迁移 smoke 的 Flow 基准数据集、500+ 节点采样方式、1000+ 节点降级策略，写入 PR 描述。
- [ ] 决定 PR preview 数据隔离方案，默认强制使用独立 Supabase Preview Project；生产 Supabase + preview-bot 只能在 `READ_ONLY_PREVIEW=true`、RLS/RPC 隔离和自动清理都落地后临时允许。
- [ ] 决定 PR preview 是否允许调用 Edge Functions；若允许，阶段 1 必须改 CORS 代码支持 `pr-*.pages.dev` hostname。
- [ ] 决定 Storage signed URL 是否继续进入 Angular SW dataGroups；确认 `maxAge` 不超过签名有效期，logout/account switch 清理策略明确。
- [ ] 决定 Angular SW dataGroups 的跨域 CORS/opaque 策略：Supabase Storage signed URL、jsdelivr 字体、Google Fonts 必须在 SW 控制页面下验证 `response.type`、状态码和缓存行为；私有 Storage 不允许缓存 opaque/401/403 响应。
- [x] 决定 Sentry sourcemap inject 策略：首版默认关闭；若开启，必须选择 post-inject rename 或 JS revalidate，不能继续让被 inject JS immutable。
- [x] 决定 deterministic build 策略：阶段 1 必须新增 `quality:guard:build-deterministic`，两次 clean build 对比 hashed JS/CSS SHA256、`index.html` modulepreload、`launch.html`（如存在）、`ngsw.json` 和 `/version.json` 中除 `buildTime` 外的稳定字段；不要写 Angular builder 未暴露的 esbuild seed 配置。
- [ ] 从 Vercel Dashboard 导出当前生产环境变量全集，对照 `scripts/set-env.cjs` 的 `NG_APP_*` 默认值。
- [x] 新增 `npm run quality:guard:env-flags`：解析 `scripts/set-env.cjs` 中实际读取的 `NG_APP_*`，与 `src/environments/*` shape、deploy workflow env 列表和本文档 §16.7 快照对齐；新增、删除或默认值变化必须在同一 PR 更新四处，不能只改 GitHub Secrets。

### 阶段 1：仓库改造

- [x] 新增 `public/_headers`。
- [x] 更新 `ngsw-config.json`：移除或收紧 `app-lazy` 中的 `/worker*.js` / `/worker-*.js`，确保生成后的 `dist/browser/ngsw.json` 不把 `worker-basic.min.js` / `safety-worker.js` 纳入应用 assetGroups；CI guard 必须检查生成物。
- [x] 先不新增顶层 `404.html`，验证 Cloudflare Pages 默认 SPA fallback。（仓库未新增 `public/404.html`；2026-04-29 `https://nanoflow.pages.dev` 缺失 chunk 返回 HTML 200，按官方 Pages SPA fallback 路径处理，header / Playwright smoke 均要求 `GlobalErrorHandler` chunk 自愈合同兜底。）
- [ ] 如果默认 fallback 不满足深链刷新，再新增 `public/_redirects`，并在 preview 中验证不会把静态资源代理成 HTML。
- [x] 新增 `.github/workflows/deploy-cloudflare-pages.yml`，拆分不依赖 secret 的 `test` job 与只在安全事件运行的 `build-deploy` job。
- [x] 新增 `.github/workflows/deploy-cloudflare-pages-dry-run.yml` 或 workflow_dispatch dry-run mode：不执行 Wrangler deploy，不读取 Cloudflare/Sentry token，只跑 build、deterministic guard、artifact guards、header 文件静态校验和 `wrangler pages dev` 本地 smoke。该 dry-run 必须可由维护者在升级 Angular/Wrangler/Node 前单独运行。
- [x] 明确 `workflow_dispatch` 行为：默认只 test/build/guards；只有 `deploy=true` 且分支为 `main` 才生产部署。
- [x] PR preview deploy 条件限制为同仓库 PR，不使用 `pull_request_target`；fork PR 只跑 test job，不执行 `validate-env:prod`。
- [x] workflow 使用显式的 `Select Supabase build env` step：PR preview 通过 GitHub Environment `NanoFlow-Preview` 读取同名 Supabase secrets；缺少 `NG_APP_SUPABASE_URL` / `NG_APP_SUPABASE_ANON_KEY` 时直接失败，合同测试禁止 `PREVIEW_NG_APP_*` 与生产 fallback 进入 workflow。
- [x] workflow 敏感 token 下沉到 step：`SENTRY_AUTH_TOKEN` 只给 Sentry upload step，`CLOUDFLARE_API_TOKEN` 只给 deploy step；`npm ci`、test、build 不应读到发布 token。
- [x] 固定 `wrangler` 和 Sentry CLI 版本，并为 Direct Upload 增加最多 3 次 retry；若 Wrangler 在 Cloudflare 5xx / malformed response 场景下退出码或输出不稳定，workflow 还会回查 `pages deployment list`，并把解析出的同一 `commit hash + branch` deployment URL 继续交给后续 `gitSha === GITHUB_SHA` 健康校验。对于同一 SHA 的 rerun，允许复用已存在的健康 deployment，因为验收目标是“该 SHA 已上线且健康”，不是强制生成全新 deployment id。
- [x] Direct Upload deploy step 后增加等待式 health check：Wrangler/API 返回成功后，先解析本轮 deployment URL（必要时从 `wrangler pages deployment list` 回查），再循环请求该 deployment 的 `/` 与 `/version.json`；只有根路径返回 200 且 `version.json.gitSha === GITHUB_SHA`，才进入 header smoke / Playwright smoke。生产部署前先执行 `wrangler pages deployment list`，确认没有明显未完成或异常的上一轮 deployment；禁止直接回退到 `https://<project>.pages.dev` 把旧生产别名误判为新部署成功。
- [x] 新增 Canonical Origin Gate：`index.html` 最早期脚本或等价 boot guard 在非 canonical origin 阻断 SW 注册、Supabase 初始化、Realtime 和队列 flush，并进入 redirect/read-only/export-only。
- [x] Canonical Origin Gate 必须位于 `index.html` `<head>` 最前面的同步 inline script，早于 modulepreload、Angular bootstrap、SW 注册和 Supabase 初始化；旧 origin、非 canonical origin、`ngswHash` 不匹配或 `forceSwReset` 时，只允许一次受控 SW unregister + app cache/`ngsw:*` cache delete，并用 marker 防止 reload loop。（2026-04-29 已完成 early gate、非 canonical/redirect、`forceSwReset=1`、一次性 SW/cache cleanup 与 `__NANOFLOW_WRITE_GUARD__` 标记；2026-04-30 已补 `/version.json.ngswHash` mismatch 早期自愈并加入 contract。）
- [ ] 新增 stale SW 负向测试：先安装旧部署 SW，再部署新版本，刷新时旧 SW 可能先拦截 `index.html`；测试必须证明 gate/GlobalErrorHandler 能触发 unregister + cache delete，并且不会在旧 `ngsw.json` / 旧 `index.html` 下继续 flush 队列。
- [x] 生成 `dist/browser/version.json`，内容包含 git SHA、build time、deployment environment、app version、Supabase project alias、Sentry release、ngsw hash；`version.json` 必须 no-store 且不进长期 SW asset cache。
- [x] 全量审查 `supabase/functions/**` 的 CORS/origin 判断，不只更新 `transcribe`；单独处理 `widget-black-box-action`。（2026-04-29 `rg` inventory 覆盖 `transcribe`、`virus-scan`、`_shared/widget-common`、`widget-black-box-action` 与 widget shared callers。）
- [x] 根据阶段 0 决策，改 `transcribe`、`virus-scan`、`_shared/widget-common`、`widget-black-box-action` 的 Cloudflare preview CORS 支持，或明确 preview smoke 不覆盖这些链路。（2026-04-29 这些路径均允许 `https://nanoflow.pages.dev` 与 `*.nanoflow.pages.dev`，widget focus/summary/register/notify 通过 `_shared/widget-common` 继承；2026-04-30 已部署 active HTTP Edge Functions 并用 live `OPTIONS` smoke 验证 `nanoflow.pages.dev`。）
- [ ] 修正 Auth redirect helper：生产使用 canonical origin，preview/local 使用显式环境 origin；补 password reset / magic link / OAuth 回调测试，并记录 Email Templates 审查结果。（2026-04-29 `AuthService.resetPassword()` 生产环境使用 `environment.canonicalOrigin`，单测覆盖 password reset redirect；2026-04-30 `AuthService.signUp()` 注册确认邮件已使用 canonical `emailRedirectTo`，用户已在 Supabase Dashboard 完成 Site URL / Redirect URLs 与 Email Templates 审查，Magic Link / OAuth 端到端回调 smoke 仍需在真实登录窗口验证。）
- [x] 更新所有相关 contract tests。
- [x] 按 §6.4 修正云端写入语义：任务、连接、BlackBox/Focus 的上行已在 `NG_APP_SYNC_RPC_ENABLED` 下接入 RPC/CAS 并补 remote-newer 单测；2026-04-30 已补 Project、删除/批量写 RPC/CAS 与客户端接入。端到端“旧离线写重放不覆盖远端新写”仍归阶段 2 preview smoke / `e2e/realtime-localfirst-consistency.spec.ts`。
- [ ] 按 §6.4 修正 timestamp 归一化：所有成功 push 的同步实体都把服务端返回的 canonical `updated_at` 写回 store、IndexedDB 和队列元数据；补刷新后仍为 canonical timestamp 的测试。（2026-04-30 续：task direct/RPC/position push 已回写调用方快照与 `TaskStore`；connection direct/RPC push 已回写调用方快照与 `ProjectState`；project direct/RPC push 已回写调用方快照与 `ProjectStore`，并补 focused RED/GREEN 单测。刷新后 IndexedDB 端到端验收仍未勾。）
- [ ] 按 §6.4 修正所有同步游标提交语义：`checkForDrift()`、`refreshActiveProjectSilent()`、resume/probe、BlackBox 同步都不得在调用方完成 merge/持久化前提交 cursor；实现组合 cursor 或强制安全回看窗口；补“merge 失败不推进游标”“本地 `new Date()` 不作为远端 watermark”“同 timestamp 分页不漏拉”的单元测试。
- [ ] 按 §6.4 修正队列契约：新增/补齐 `operation_id`、base version、依赖关系和 tombstone barrier；补 task delete 后旧 connection/attachment/focus recording mutation 不留下孤儿数据的测试。
- [ ] 按 §6.4 / §16.26 修正 server-side ghost write 防护：upsert RPC 已记录并幂等校验 `operation_id`，拒绝旧 `syncProtocolVersion` / `deploymentEpoch`，客户端 payload 带 `origin`、`gitSha`、`deploymentTarget`；2026-04-30 已补删除/批量写 RPC，生产 Sentry breadcrumb 验证仍需在部署后完成。
- [ ] 按 §6.5 新增 sync single-writer：RetryQueue/ActionQueue 已在 `NG_APP_SYNC_LEASE_ENABLED` 下持有 sync writer lease 后 flush；双标签恢复联网、owner 崩溃接管、无 Web Locks 降级 e2e 仍需补。
- [ ] 新增或扩展 `e2e/realtime-localfirst-consistency.spec.ts`：覆盖 offline local write、remote write、WebSocket 断线/`TIMED_OUT`、polling fallback、条件写入 remote-newer、canonical timestamp、single-writer、多标签接管、tombstone 不复活；另加 `black_box_entries` 的断线/fallback/cursor-after-persist/pending merge/tombstone 用例。
- [ ] 如果保持 Realtime 开启，默认启用 Supabase Realtime `worker: true`、`heartbeatCallback` 和必要的 `workerUrl`；2026-04-30 已接入 `worker: true`、`workerUrl=/worker-basic.min.js`、heartbeat breadcrumb、`realtime_channel_error` / `realtime_fallback_polling_started` breadcrumb 与 worker no-store guard；后台标签页长时运行 + polling fallback 证据仍需补。
- [x] 更新 `SentryLazyLoaderService` 的 `tracePropagationTargets`，纳入新 custom domain 和 Pages preview 域。（2026-04-29 已包含 `*.nanoflow.pages.dev` 与 `*.nanoflow.app` 匹配。）
- [ ] 全仓 inventory `dde-eight.vercel.app` / `dde[-\w]*.vercel.app`，把运行时常量、TWA 配置、测试 fixture、文档分别归类；结果写入迁移 PR 描述。（2026-04-30 本地 `rg` 已确认剩余引用主要是文档/历史 fixture、迁移期 Edge Function CORS allow-list 和兼容测试；PR 描述归档仍需完成。）
- [x] 更新或显式覆盖 `android/app/build.gradle.kts` 的 `NANOFLOW_WEB_ORIGIN`，避免 TWA 默认 origin 继续指向旧 Vercel 域。（2026-04-29 默认值为 `https://nanoflow.pages.dev`，契约测试禁止回到旧 Vercel host。）
- [x] 决定保留/删除旧 `vercel.json`、`netlify.toml`，并同步更新 `src/tests/startup-contract.spec.ts`。（2026-04-29 决定迁移窗口内保留二者作为回滚/兼容参考；startup contract 继续覆盖 SW 与 retired widget 兼容资产 no-cache。）
- [x] CI artifact guard 补齐 `ngsw-worker.js`、`sw-composed.js`、`manifest.webmanifest`、`version.json`、`.well-known/assetlinks.json`、TWA package name、TWA fingerprint 集合、`manifest.webmanifest` 不含 `vercel.app`、仓库根目录 `functions/` 不存在、`dist/browser/functions` 不存在、`dist/browser/_worker.js` 不存在、`.map` 最终门禁。
- [x] CI deterministic guard 补齐：两次 clean production build 的 hashed JS/CSS、modulepreload、`ngsw.json` 对齐；启用 Sentry inject 时在 inject/post-inject rename/rebuild `ngsw.json` 后再做最终内容 manifest 对齐。
- [x] 新增最终 artifact manifest：部署前生成 `dist/browser/artifact-manifest.json`（或 CI artifact，不公开也可），记录每个 hashed JS/CSS/worker、`index.html` modulepreload、`launch.html`、`ngsw.json`、`_headers`、`version.json` 的 SHA256、size、content-type 期望和 cache policy；Sentry inject/post-build 全流程结束后再生成，并用同一 manifest 驱动 Vercel/Cloudflare 一致性比对。
- [x] CI cache guard 补齐非 hash 资源检查：`public/fonts/**`、`public/icons/**`、非 hash `assets` 不能命中 `immutable`；只有最终内容 hash 对齐的 `main*.js`、`polyfills*.js`、`chunk*.js`、`styles*.css` 和构建脚本生成的精确 worker chunk 规则允许长期缓存；`_headers` 规则数超过 90 失败，`dist/browser` 文件数超过 18,000 失败。
- [x] CI 趋势监控补齐：记录 `dist/browser` 文件数、总大小、根目录 JS 数、`_headers` 规则数、`ngsw.json` asset 数和 GoJS/Flow chunk size；超过上次 main 基线 15% warning，超过 30% fail-fast，避免只在 18,000 文件或 90 规则时才发现增长失控。（2026-04-29 已新增 `docs/cloudflare-artifact-baseline.json`、`scripts/ci/check-artifact-trends.cjs` 与 `quality:guard:artifact-trends`，deploy / dry-run workflow 均在部署前执行。）
- [x] 首版 `_headers` 必须在 `/*` 规则下包含 `! Link`，关闭 Pages 从 HTML preload/modulepreload 自动生成的 `Link` header；阶段 2/3 header smoke 必须验证 `/` 与 `/index.html` 没有 `Link: ... rel=modulepreload`。
- [ ] 若 origin 变化，新增旧 Vercel export-only/read-only 构建路径或 host-based 运行时保护，并用 e2e 验证旧域不能新增/编辑/同步写入但仍能导出本地数据。（2026-04-30 已新增 `legacy-export-only` Vercel prebuilt workflow，且 Task/Project 操作入口在 `export-only` 下阻断本地写入；旧域完整 e2e 与导出流程仍需发布后验证。）
- [ ] 新增一次性迁移欢迎/恢复状态页：新 canonical origin 首次启动时显示云端恢复、队列同步、旧 origin 导出和 PWA 刷新/重装提示；成功恢复、用户跳过、导出入口点击、恢复失败都写 Sentry breadcrumb。（2026-04-30 迁移恢复 banner 的导出/跳过 breadcrumb 已补；新 canonical 首次云端恢复完整页/端到端恢复状态仍需补。）
- [ ] 如启用 Sentry Source Map，新增 hidden source map 构建配置，并确保 inject 后执行 post-inject rename 或把被 inject JS header 降级为 revalidate，再执行 `npx ngsw-config dist/browser ngsw-config.json /` 和 `node scripts/patch-ngsw-html-hashes.cjs`。
- [x] 保留 `npm run perf:guard:nojit`，并加入 `npm run quality:guard:font-contract`、`npm run quality:guard:supabase-ready` 作为部署前门禁。（2026-04-29 deploy / dry-run workflow 已新增 blocking step。）
- [x] 将 `npm run quality:guard:build-deterministic` 加入部署前门禁；若执行成本过高，至少在 PR preview / workflow_dispatch 必跑，production deploy 前必须引用同一份已通过 deterministic guard 的 artifact。
- [ ] 新增 Flow/OnPush smoke：桌面 Flow 首开、节点选择详情刷新、拖拽/连线后 store 刷新、主题切换画布刷新、自动布局期间继续编辑后旧 generation 结果被丢弃、切回 Text 后图实例释放。
- [ ] 新增 Flow layout cancellation smoke：自动布局进行中连续触发编辑、切换项目、销毁 Flow、重新打开 Flow；旧 `layoutTaskId` / `layoutGeneration` 结果必须被取消或丢弃，并在 Sentry breadcrumb 中记录 `stale_layout_dropped`，不能覆盖新坐标。
- [ ] 新增 Flow 大图性能采样脚本或 Playwright case，至少覆盖 200 节点基线和 500+ 节点 long task 采样；1000+ 节点默认降级策略必须可验证；10 次打开/销毁后 Diagram/listener/timer 不持续增长。
- [x] 本地执行 `npx wrangler pages dev dist/browser --port 8788` dry-run，验证 SPA fallback、`_headers`、PWA install、SW update，并确认 `worker-basic.min.js` 与 `safety-worker.js` 都返回 no-store，且不在生成的 `ngsw.json` 应用 assetGroups 中；禁止静态 `/worker*.js` / `/worker-*.js` immutable 规则，如存在应用 Web Worker chunk，必须由构建脚本生成精确文件名 immutable 规则。（2026-04-30 本地 header smoke 通过：`/`、`index.html`、`version.json`、`ngsw.json`、`worker-basic.min.js`、`safety-worker.js` 均 no-store；`/projects` SPA fallback 200；`ngsw.json` 未列入安全 worker。）
- [x] 新增或复用 `scripts/smoke/cloudflare-header-smoke.sh`，用参数化 `ORIGIN` 跑 §14.2 header 契约；不要把 smoke 脚本硬编码到 custom domain。
- [x] **Sentry environment 区分**（§16.18 提级到首版迁移，不延后）：在 `scripts/set-env.cjs`、`scripts/ensure-env-files.cjs` 和 `src/environments/*` environment shape 中增加 `NG_APP_SENTRY_ENVIRONMENT` / `sentryEnvironment` 注入，deploy workflow 按 `github.event_name == 'pull_request' ? 'preview' : 'production'` 取值，`SentryLazyLoaderService` 读取该值传入 `Sentry.init({ environment })`。这样阶段 2 preview 的错误事件就不会污染生产 environment dashboard。
- [x] Node 22 作为 Cloudflare deploy workflow 基线；是否收紧 `package.json engines` 到 `>=22 <23` 另立决策，不在首版迁移中隐式完成。

### 阶段 2：Preview 验证

- [ ] 同仓库 PR 创建后 GitHub Actions 部署 `pr-<number>.<project>.pages.dev`；fork PR 只跑 build/test，不拿部署 secret。
- [ ] 确认 PR preview 使用 GitHub Environment `NanoFlow-Preview` 中的独立测试 Supabase；当前 workflow 不支持生产 Supabase preview fallback。若未来临时引入生产 preview-bot 例外，必须另开 PR 增加显式变量、`READ_ONLY_PREVIEW=true`、应用/RLS/RPC fail-closed 和自动清理证据。
- [ ] 对 preview 执行 Playwright smoke。
- [ ] 在 Playwright smoke 前确认 preview deployment health check 已通过；不能把 Wrangler/API 200 或 Dashboard Success 当成页面已可用。
- [ ] 验证 preview 返回 `X-Robots-Tag: noindex` 或 HTML `noindex,nofollow`，但 production custom domain 不带该 preview noindex。
- [ ] 手动或自动检查 `_headers`：
  - `index.html` no-store。
  - `ngsw.json` no-store。
  - `sw-composed.js` no-store。
  - hashed chunks immutable。
  - `styles*.css` 可 immutable；`/fonts/**`、`/icons/**`、非 hash `assets` 必须 revalidate，除非文件名已改为 hash/versioned。
  - `worker-basic.min.js` / `safety-worker.js` 不在 `ngsw.json` 应用 assetGroups 中。
  - `/` 与 `/index.html` 不返回 modulepreload `Link` header；若出现，说明 `! Link` 未生效或 zone 规则注入了 Early Hints 输入。
  - freshness 关键路径（`/`、`/index.html`、`/ngsw.json`、`/sw-composed.js`、`/ngsw-worker.js`、`/version.json`、Auth callback）必须记录 `CF-Cache-Status`、`Age`、`CF-Ray`；不得出现 `CF-Cache-Status: HIT` 且 `Age > 0`。
- [ ] 负向静态资源测试：请求不存在的 `/chunk-deadbeef.js`、`/styles-deadbeef.css`、`/assets/missing.png`，不能返回 HTML 200；若 Pages 默认 SPA fallback 返回 shell，必须证明 GlobalErrorHandler 能捕获并触发清缓存刷新。（2026-04-29 production pages.dev 已验证缺失 chunk 走 HTML 200 fallback，header / Playwright smoke 已证明 chunk 自愈合同；preview、CSS、assets 负向仍需在阶段 2 重跑。）
- [ ] 验证 `version.json` no-store，且不被 Angular SW 长期缓存。
- [ ] 在 `pages.dev` 或非 canonical origin 打开生产 bundle，确认 Canonical Origin Gate 阻断 SW/Supabase/队列 flush 并进入 redirect/read-only。
- [ ] 移动端浏览器打开 preview，验证默认 Text 视图。
- [ ] 桌面端进入 Flow 视图，验证 GoJS lazy chunk。
- [ ] 在 preview 上执行 Realtime 弱网 smoke：断开 WebSocket 或模拟 `TIMED_OUT` 后进入 polling fallback，恢复后队列归零且没有重复/幽灵任务。
- [ ] 在 preview 上执行 Realtime 后台/高延迟 smoke：后台标签页保持 5-10 分钟后恢复，必须出现 heartbeat callback 或健康状态记录；若发生 timeout/disconnected，Sentry 中必须能看到 `heartbeat_timeout` / `realtime_disconnected` 和 fallback polling 事件。
- [ ] 在 preview 上执行 SW-controlled dataGroups CORS smoke：由已注册 Angular SW 控制的页面加载 Supabase Storage signed URL、LXGW/jsdelivr 字体和 Google Fonts，验证不缓存 opaque/401/403，logout/account switch 后私有内容不可见。
- [ ] 在 preview 上执行 LWW 条件写入 smoke：制造“本端离线旧写 + 另一端远端新写 + 本端重连”，确认旧写不会普通 `upsert` 覆盖远端新写，最终按 LWW/remote-newer 决策收敛。
- [ ] 在 preview 上执行多标签 single-writer smoke：两个标签页同时恢复联网时只有 owner flush 队列和提交 cursor；owner 关闭后 lease 可接管。
- [ ] 在 preview 上执行组合 cursor/安全回看 smoke：同一 `updated_at` 的多行分页不会漏拉。
- [ ] 在 preview 上执行队列拓扑 smoke：task 创建、attachment/focus recording 上传、connection 创建、task 删除乱序重试后不出现孤儿数据或 tombstone 复活。
- [ ] 在 preview 上执行 Flow/OnPush smoke：验证 Flow 事件能刷新 Angular UI，自动布局旧 generation 不覆盖新编辑，并记录 200/500 节点数据集的 long task 结果。
- [ ] 在 preview 上对 Flow 首开补一次弱网/移动 profile；如果能接入远程浏览器，至少取亚洲/欧洲两个边缘路径的 TTFB、chunk load 和 Flow 首开采样。
- [ ] 验证 Supabase Auth redirect、password reset/magic link 或 OAuth 回调、Storage、Edge Functions。
- [ ] 验证 Storage signed URL / 私有附件 logout 后不可继续由 SW cache 展示。
- [ ] 若 sourcemap 关闭，确认 Cloudflare public URL 下没有 `.map`。
- [ ] 若 sourcemap 开启，确认 `ngsw.json` 是 inject 后重建版本，且已重新执行 `patch-ngsw-html-hashes.cjs`；如果采用 post-inject rename，还必须重新执行 `inject-modulepreload.cjs`，并确认 Debug ID sourcemap 可还原堆栈。
- [ ] 验证 Sentry 错误事件和 Session Replay 仍能上报；如果启用 tracing，确认新域名进入 trace propagation 范围。
- [ ] 若 GoJS license 与域名绑定，先在 GoJS 授权后台加入新 custom domain。

### 阶段 3：Production 部署

- [ ] 合并到 `main`。
- [ ] 生成一份 release candidate `dist/browser`，先部署同一份产物到 Vercel 回滚后备和 Cloudflare Pages production；通过 `/version.json`、入口 chunk、`ngsw.json` hash 比对一致后再切 DNS。
- [ ] 使用已通过 deterministic build guard 的 release candidate artifact 部署，不在 Vercel 和 Cloudflare 各自重新 build；若必须重新 build，必须分别产出 artifact manifest 并证明 hashed JS/CSS、modulepreload 和 `ngsw.json` 完全一致。
- [ ] DNS 割接前执行跨版本混合 smoke：Vercel RC、Cloudflare Pages production、同一 custom domain 切换前后各跑一次 `/version.json`、SW update、Realtime reconnect、RetryQueue/ActionQueue replay；模拟用户在旧部署后台停留 10 分钟后切回新部署。
- [ ] GitHub Actions 部署 `main` 到 Cloudflare Pages production；如果同域 DNS 割接，确保 Vercel 自动部署已冻结或只服务同一份 RC/export-only 构建。
- [ ] 确认 production deployment health check 通过后，再在 `https://<project>.pages.dev` production URL 上完成 header smoke 与 Playwright smoke，不依赖 custom domain 已解析。（2026-04-29 当前 `https://nanoflow.pages.dev` 对 HEAD `b05889949680553f3838a481f5410dfea91b8139` 的 header smoke 与 Playwright smoke 均通过；2026-04-30 fresh online smoke 对当前线上 `gitSha=49372daca499bb62e689fbc8604377cceff01be8` 通过；本地分支合并 main / production deploy 后仍需重跑。）
- [ ] 绑定 custom domain，等待 TLS active。
- [ ] 子域名走路径 A；apex/root domain 走路径 B。
- [ ] custom domain 绑定并确认 TLS active 后，再把 `CLOUDFLARE_CUSTOM_DOMAIN_ORIGIN` 设为最终域名并执行 custom domain smoke test。
- [ ] custom domain smoke 通过后，从生产 Supabase Auth redirect、Edge Function `ALLOWED_ORIGINS`、Storage CORS 中移除或禁用 `https://<project>.pages.dev` 的写入能力；如保留该 URL，必须是 redirect/read-only，不是第二生产入口。
- [ ] 保留 Vercel 旧部署 24-72 小时；如果 origin 变化，旧部署必须已部署 export-only/read-only 构建，除非正在执行回滚，不作为常规写入入口。

### 阶段 4：稳定观察

- [ ] 观察 Sentry 24 小时，重点看 chunk load、JIT、DI version skew、Supabase 400/401/403。
- [ ] 观察 Realtime fallback、sync cursor advance、RetryQueue/ActionQueue 异常、tombstone 复活类事件；任何“断线后不再同步”或“merge 失败后游标已推进”都触发回滚/热修。
- [ ] 观察 Sentry 指标：`heartbeat_timeout`、`realtime_disconnected`、`realtime_fallback_polling_started`、`remote_newer_conflict`、`ghost_write_rejected`、`sync_queue_stuck`。前 48 小时内任一指标持续升高，应先降级 Realtime 或暂停旧 origin 写入窗口。
- [ ] 观察 Flow long task、GoJS 初始化/销毁错误、OnPush 桥接漏刷新；500+ 节点触发持续 200ms 以上长阻塞时默认打开降级策略。
- [ ] 观察 Cloudflare 边缘差异导致的 Flow 首开/大图性能漂移；如果亚洲/欧洲或弱网采样明显劣化，先调低自动进入 Flow 的阈值，而不是只提高前端超时。
- [ ] 验证离线新增任务、恢复联网同步、RetryQueue/ActionQueue 清空。
- [ ] 如果 origin 发生变化，验证新域名首次登录后能从 Supabase 恢复数据；旧域名仍可打开用于导出本地残留数据。
- [ ] 验证 `pages.dev` 收敛：custom domain active 后，`pages.dev` 不再位于生产 Supabase 写入 allow-list，或访问后被 redirect/read-only 保护。
- [ ] 验证 PWA 旧版本到新版本升级路径。
- [ ] 验证 stale SW serving new deployment 负向路径：旧 SW 已控制页面时请求新 `/version.json` 和旧 chunk，必须触发清缓存恢复而不是白屏或继续旧队列 flush。
- [ ] 验证 Android TWA assetlinks。
- [ ] **Service Worker 跨 origin 缓存残留验证**（§13 验收一致）：在新域名打开应用后，DevTools → Application → Cache Storage → 列出所有 cache key，确认：
  - 没有名称包含 `dde-eight.vercel.app` 或任何旧 origin 的 SW cache。
  - `ngsw:db:control` / `ngsw:1:assets:*` 这类 cache 的 entry URL 起始 origin 是新域名。
  - 自动化判定（在新域名上跑一次）：

    ```js
    // DevTools Console 一次性检查
    (async () => {
      const names = await caches.keys();
      const stale = [];
      for (const n of names) {
        const c = await caches.open(n);
        const reqs = await c.keys();
        for (const r of reqs) {
          if (/dde-eight\.vercel\.app|vercel\.app/.test(r.url)) stale.push(r.url);
        }
      }
      console.log(stale.length === 0 ? 'PASS: no cross-origin residual' : 'FAIL', stale);
    })();
    ```

  浏览器 SW 缓存按 origin 隔离，**新域名理论上不应继承旧 origin 的 cache**——这条检查的目的是确认 manifest `id` / scope 没有把两个 origin 误识为同一个 PWA（一旦 `id` 错配，新 origin 可能命中旧 cache 的元数据）。
- [ ] 稳定后移除 Supabase/Vercel 临时回滚 allow-list。
- [ ] 关闭 Vercel 自动部署或断开 Git integration。
- [ ] 稳定满 `HSTS_STABILIZATION_WINDOW` 后再单独评估启用 HSTS；首版迁移不在 `_headers` 中启用 HSTS。
- [ ] 阶段 4 稳定后 6 个月内执行 Workers Static Assets dry-run，验证 §4.1.2 的备选路径仍可用，或明确继续保留 Pages 的原因。
- [ ] 如需要 SEO 收敛，稳定 72 小时后给旧 Vercel 域加入 `X-Robots-Tag: noindex` 或友好跳转说明。
- [ ] **Performance baseline 重置**（§16.16 的具体触发）：稳定满 7 天 + 无回滚后再跑 `npm run test:baseline:update`，并在 commit message 中说明 "post-cloudflare-migration baseline reset, prior baseline captured on Vercel edge"。提前重置会污染基线为不稳定窗口数据；7 天内禁止刷新。责任人：迁移 PR 的作者。
- [ ] **Supabase 收紧型 migration（批次 B）发布**（§16.10.3 / 阶段 0 的延迟项）：阶段 0 标记为"批次 B / 不向后兼容"的 migration，仅在阶段 4 稳定 24h 后单独 PR 发布；与前端发布禁止同窗口。
- [x] 更新 README、部署文档和迁移后建议；性能基线 URL 等阶段 4 观察窗口结束后再单独刷新。（2026-05-18 README 已改为 Cloudflare Pages 推荐路径，Vercel 降为回滚/备选。）

## 13. 验收标准

迁移完成必须满足：

- Cloudflare production 首屏可打开。
- 同一 commit 的 deterministic build guard 通过；部署到 Vercel 回滚后备和 Cloudflare production 的 artifact manifest 一致。若启用 Sentry inject，最终部署内容 hash、文件名、modulepreload 和 `ngsw.json` 在 inject/rename 后仍一致。
- 最终 artifact manifest 已生成并保存到 CI artifact；它覆盖 hashed JS/CSS/worker、modulepreload、`index.html`、`launch.html`、`ngsw.json`、`_headers`、`version.json`，并且 Sentry upload、Vercel 回滚后备、Cloudflare deploy 都引用同一份 manifest。
- 刷新任意 Angular path route 不返回 404。
- JS/CSS/SW 请求优先不被 `_redirects` 代理成 HTML；若 Cloudflare Pages 默认 SPA fallback 对缺失 chunk 返回 HTML 200，必须有 GlobalErrorHandler chunk 自愈单测和 Playwright 负向场景证明能清缓存恢复，不允许白屏或继续旧队列 flush。
- `index.html`、`index.csr.html`（仅在未来启用 SSR/CSR 混合时存在）、`launch.html`、`ngsw.json`、`manifest.webmanifest`、`sw-composed.js`、`ngsw-worker.js` 不是长期强缓存。
- `main*.js`、`polyfills*.js`、`chunk*.js`、`styles*.css` 等 hash 构建产物使用长期缓存；应用 Web Worker chunk 只有在 `_headers` 中存在精确文件名规则时才使用长期缓存；`public/fonts/**`、`public/icons/**`、非 hash `assets` 默认 revalidate；`worker-basic.min.js`、`safety-worker.js`、`ngsw-worker.js`、`sw-composed.js` 必须 no-store，且 `_headers` 不得包含静态 `/worker*.js` / `/worker-*.js` immutable 规则。
- 首版迁移的 `/` 与 `/index.html` 实际响应头不包含 Cloudflare 自动生成的 modulepreload `Link` header；`_headers` 必须通过 `! Link` 关闭 Early Hints 的自动输入。后续若重新启用，必须单独验证 103、所有 preload chunk 存在、MIME 正确且 `ngsw.json` 对齐。
- freshness 关键路径的真实线上响应头符合缓存预期：记录 `CF-Ray`；`/`、`/index.html`、`/ngsw.json`、`/sw-composed.js`、`/ngsw-worker.js`、`/version.json` 不得返回 `CF-Cache-Status: HIT` 且 `Age > 0`；hashed JS/CSS 可以被缓存，但必须保持 immutable 且 MIME 正确。
- `dist/browser/ngsw.json` 不得把 `worker-basic.min.js` / `safety-worker.js` 纳入应用 assetGroups；`ngsw-config.json` 的 worker glob 必须已收紧或由生成后 guard 兜底。
- CI artifact guard 确认 `ngsw-worker.js`、`sw-composed.js`、`manifest.webmanifest`、`version.json`、`.well-known/assetlinks.json` 存在。
- `dist/browser` 文件数低于 18,000，保留 Cloudflare Pages 20,000 文件 Direct Upload 限额余量；Dashboard drag-and-drop 不用于上传完整构建产物。
- `/version.json` no-store，包含 git SHA、build time、deployment environment、app version、Supabase project alias、Sentry release、ngsw hash；同域 DNS 割接时 Vercel 与 Cloudflare 的该文件、入口 chunk 和 `ngsw.json` hash 一致。
- `assetlinks.json` 包含 `app.nanoflow.twa`，并包含 `ANDROID_TWA_EXPECTED_SHA256_CERT_FINGERPRINTS` 中列出的全部 fingerprint。
- `manifest.webmanifest` 不包含 `vercel.app` 字符串，`id`、`scope`、`start_url` 不硬编码旧 origin。
- 仓库根目录 `functions/`、`dist/browser/functions/` 和 `dist/browser/_worker.js` 不存在，避免 Wrangler Direct Upload 误启用 Pages Functions。
- `dist/browser` 中没有公开 `.map` 文件。
- 如果启用 Sentry sourcemap，必须先执行 `sourcemaps inject`，再删除 `.map`；随后要么 post-inject rename 并重写 HTML/modulepreload/`ngsw.json`，要么把被 inject 的 JS header 降级为 revalidate，再重建 `ngsw.json` 并重新执行 `node scripts/patch-ngsw-html-hashes.cjs`。
- `npm run test:run:ci` 通过。
- `npm run build:stats` 通过。
- `npm run perf:guard:nojit` 通过。
- `npm run quality:guard:font-contract` 通过。
- `npm run quality:guard:supabase-ready` 通过。
- `npm run quality:guard:env-flags` 通过，证明 `scripts/set-env.cjs`、`src/environments/*`、workflow env 和 §16.7 flag 快照没有漂移。
- Playwright smoke 中 console error/pageerror/requestfailed/badResponse 为 0。
- Wrangler/API 返回 deploy 成功后，必须先通过等待式 deployment health check，再运行 header smoke / Playwright smoke；任何 `/` 或 `/version.json` 在传播窗口后仍 5xx/522/非预期内容都视为部署失败。
- Supabase 登录、项目加载、任务新增、离线写入、恢复联网同步可用。
- Realtime 开启时，`RealtimePollingService` 与 `BlackBoxSyncService` 默认启用 Supabase Realtime `worker: true` 与 `heartbeatCallback`；WebSocket 断线、heartbeat timeout、`TIMED_OUT` 都写入 Sentry breadcrumb/metric 并进入 polling fallback，恢复后不会丢远端变更；Realtime event 不直接覆盖本地 dirty 状态，只触发统一增量拉取/merge。
- LWW 云端写入具备条件写入/RPC 或等价 CAS；旧离线写重放遇到远端新版本时不会普通 `upsert` 覆盖，成功 push 后本地 store、IndexedDB 和队列元数据使用服务端 canonical timestamp。
- server-side 写入保护生效：重复 `operation_id` 幂等、旧 `syncProtocolVersion` / `deploymentEpoch` 被拒绝、tombstone barrier 后旧 mutation 不会写入；若旧 origin 仍被访问，服务端 reject 事件能在 Sentry 中按 `ghost_write_rejected` 过滤。
- 所有同步游标只在远端变更 merge 到 store 且 IndexedDB 持久化成功后推进；组合 cursor 或强制回看窗口证明同 timestamp 分页不漏拉，且没有用本地 `new Date()` 作为远端同步水位。
- RetryQueue/ActionQueue 有 operation id、同实体保序、跨实体依赖和 tombstone barrier；task delete 后旧 attachment/focus recording/connection mutation 不留下孤儿数据或复活 tombstone。
- 同一 origin 多标签恢复联网时只有 sync writer owner 可以 flush RetryQueue/ActionQueue 和提交 cursor；owner 崩溃/关闭后能由其他标签接管，不出现重复 cloud push 或游标竞争。
- soft delete tombstone 在 Realtime/增量拉取/离线恢复路径中一致生效，不出现删除任务复活或幽灵连接。
- Fork PR 不读取生产/部署 secrets；同仓 PR preview 缺少 preview Supabase secrets 时 fail-fast，不静默回退生产 Supabase；生产 Supabase preview opt-in 必须同时满足 `READ_ONLY_PREVIEW=true`、应用 mutation fail-closed、RLS/RPC 隔离和自动清理。Sentry/Cloudflare token 只出现在各自 upload/deploy step。
- PR preview 带 noindex，production custom domain 不带 preview noindex。
- Canonical Origin Gate 生效：它是 `index.html` `<head>` 最前面的同步 inline script；非 canonical origin 不注册 Service Worker、不初始化 Supabase、不 flush 队列，只 redirect 或 read-only/export-only；旧 origin / `ngswHash` mismatch / `forceSwReset` 只触发一次受控 SW unregister + app cache/`ngsw:*` cache delete，不进入 reload loop。
- 新 canonical origin 首次启动的迁移欢迎/恢复状态页生效：用户能看到云端恢复/队列同步状态、旧 origin 导出入口和 PWA 刷新/重装提示；恢复成功或失败都有 Sentry breadcrumb。
- 如果 origin 变化，新域名能从 Supabase 恢复已同步数据；旧域名保留 72 小时用于导出本地残留数据，并在割接后通过 export-only/read-only 构建阻断写入、队列 flush 和 cloud push，避免双 origin 长期写入同一生产 Supabase。
- 如果 origin 不变但托管商切换，DNS 割接窗口 Vercel 与 Cloudflare 服务同一份构建产物；不同时升级业务代码或同步协议。
- custom domain smoke 通过后，`pages.dev` 不再作为可写生产 origin 留在 Supabase Auth redirect、Edge Function CORS、Storage CORS；若保留访问入口，必须 redirect/read-only。
- Auth callback、password reset / magic link 或 OAuth 链路使用 canonical origin helper；Email Templates 已审查，不会把用户带回旧域或非 canonical origin。
- 私有 Storage signed URL 不被 Angular SW 缓存超过签名有效期；logout/account switch 后不能继续通过 SW/Cache Storage 展示附件、录音或 focus recording。
- Angular SW dataGroups 在 SW-controlled 页面下通过跨域 CORS/opaque 测试：Supabase Storage、Google Fonts、jsdelivr 字体不缓存 opaque/401/403；私有 Storage 退出登录或切换账号后不可从 SW/Cache Storage 继续读取。
- 若启用 Source Map，Debug ID sourcemap 可还原堆栈；除非运行时代码已注入同一个 release，否则不把 `$GITHUB_SHA` release 作为验收门禁。
- Sentry 错误事件和 Session Replay 在新域名下仍能上报；`tracePropagationTargets` 不再只覆盖 Vercel 域名。
- GoJS 在新域名下不出现 license 水印或授权相关 console error。
- 移动端默认 Text 视图；Flow 图按需加载，没有 `visibility:hidden` 持有 GoJS 实例。
- Flow/GoJS smoke 覆盖 OnPush 桥接：节点选择、拖拽/连线、详情面板、主题切换都能刷新 Angular UI；销毁 Flow 后没有残留全局 handler 或图实例。
- Flow 大图性能采样通过：200 节点基线可交互，500+ 节点无持续 200ms 以上用户动作长阻塞；1000+ 节点或密集跨树连线默认降级/转 Text；异步布局带 generation/revision 并丢弃过期结果；10 次打开/销毁后 Diagram/listener/timer 不持续增长。
- Android TWA 的 `assetlinks.json` 返回正确，package name 与所有 dev/release/Play Signing fingerprint 完整匹配；`NANOFLOW_WEB_ORIGIN` / `android/app/build.gradle.kts` 不再默认指向不符合最终方案的旧 Vercel origin。
- **Service Worker Cache 跨 origin 残留为零**：新域名 DevTools Console 跑 §12 阶段 4 的检查脚本，输出 `PASS`；任何 `vercel.app` 残留都说明 manifest `id`/`scope` 配置与 §16.8 决策树不一致，必须回滚到阶段 0 重新审查。
- stale SW 负向测试通过：旧部署 SW 已控制页面时，新部署仍能触发 unregister/cache delete 或 ChunkLoadError 自愈；任何旧 SW 继续服务旧 `index.html` 并 flush 队列的路径都阻塞上线。
- Workers Static Assets 备选路径已登记：首版继续 Pages 时，阶段 4 后 6 个月内至少完成一次 non-production dry-run；若 dry-run 失败，需要记录是 Workers 配置、SPA fallback、headers/redirects、custom domain 还是 assets binding 阻塞，不能把 Pages 视为永久无迁移成本目标态。

## 14. Smoke Test 契约

本节定义 smoke 契约（**测什么 / 期望什么**）；§16.15 定义实现（**何时跑 / 怎么接 workflow**）。两节不重复列同一份 curl 清单。

### 14.1 Playwright e2e 契约

新增 `e2e/cloudflare-smoke.spec.ts` 或在现有 e2e 中参数化 `BASE_URL`（`playwright.config.ts` 已支持 `PLAYWRIGHT_BASE_URL` 覆盖 dev server），覆盖：

- 打开 `/`。
- 打开 `/projects` 并刷新。
- 打开 `/#/projects?entry=shortcut&intent=open-workspace`，兼容 manifest shortcut。
- 验证页面出现 NanoFlow 主 UI。
- 验证 canonical origin：非 canonical origin 打开时不注册 SW、不初始化 Supabase、不 flush 队列，只 redirect 或进入 read-only/export-only。
- 验证 `/version.json` 返回当前部署元数据且 no-store。
- 新增一个本地任务，刷新后仍能从 IndexedDB 恢复。
- 模拟离线写入，再恢复联网，等待队列归零。
- 在 Realtime 开启配置下模拟 WebSocket 断开或 `TIMED_OUT`，确认进入 polling fallback，远端变更最终可见。
- 模拟 merge/IndexedDB 持久化失败，确认同步游标未推进；恢复后同一批远端变更仍会被拉取。
- 模拟同一 `updated_at` 的多行分页，确认组合 cursor 或安全回看窗口不会漏拉。
- 模拟旧离线写重放遇到远端新版本，确认条件写入返回 conflict/remote-newer，旧写不会覆盖远端新行。
- 模拟 task 创建、attachment/focus recording 上传、connection 创建、task 删除的乱序重试，确认依赖校验和 tombstone barrier 不产生孤儿数据。
- 打开两个同一用户标签页，恢复联网时确认只有 sync writer owner flush 队列和提交 cursor；关闭 owner 后 lease 可接管。
- 删除任务后触发旧 update/reconnect，确认 tombstone 不被旧事件复活。
- 触发 password reset / magic link 或 OAuth 回调，确认 redirectTo 使用 canonical/受控 preview origin；logout 后不能继续通过 SW/Cache Storage 看到私有附件或录音。
- 桌面端进入 Flow 视图：验证 GoJS chunk 懒加载、节点选择刷新详情、拖拽/连线刷新 store、主题切换刷新画布。
- 切回 Text 视图或销毁 Flow 组件后，确认没有残留 GoJS 实例、全局 handler 或持续触发的 timer。
- 使用 200 节点基准数据集跑 Flow smoke；使用 500+ 节点数据集记录 long task，单次用户动作不得持续阻塞主线程 200ms 以上；自动布局运行中继续编辑后旧 generation 布局结果必须被丢弃。
- 捕获 console，禁止：
  - `JIT compiler unavailable`
  - `JIT-version-skew`
  - `DI-version-skew`
  - `ChunkLoadError`
  - `Loading chunk failed`
  - Supabase schema/400 error

### 14.2 Header 与静态资源契约

部署后必跑（如果不跑完整 Playwright，至少跑这套）：

```bash
ORIGIN=https://<pages-or-custom-origin>
curl -sSI "$ORIGIN/" | tee /tmp/nanoflow-root.headers
curl -sSI "$ORIGIN/index.html" | tee /tmp/nanoflow-index.headers
curl -sSI "$ORIGIN/ngsw.json" | tee /tmp/nanoflow-ngsw.headers
curl -sSI "$ORIGIN/sw-composed.js" | tee /tmp/nanoflow-sw-composed.headers
curl -sSI "$ORIGIN/ngsw-worker.js" | tee /tmp/nanoflow-ngsw-worker.headers
curl -I "$ORIGIN/safety-worker.js"
curl -I "$ORIGIN/worker-basic.min.js"
curl -I "$ORIGIN/manifest.webmanifest"
curl -sSI "$ORIGIN/version.json" | tee /tmp/nanoflow-version.headers
curl -I "$ORIGIN/fonts/lxgw-wenkai-screen.css"
curl -I "$ORIGIN/icons/icon-192x192.png"
curl -I "$ORIGIN/.well-known/assetlinks.json"
curl -I "$ORIGIN/projects"
curl -I "$ORIGIN/chunk-deadbeef.js"
curl -I "$ORIGIN/styles-deadbeef.css"
curl -I "$ORIGIN/assets/missing.png"
if grep -Ei '^link: .*rel="?modulepreload' /tmp/nanoflow-root.headers /tmp/nanoflow-index.headers; then
  echo "Unexpected modulepreload Link header. First migration should disable Cloudflare Early Hints input with ! Link."
  exit 1
fi
for headers in /tmp/nanoflow-root.headers /tmp/nanoflow-index.headers /tmp/nanoflow-ngsw.headers /tmp/nanoflow-sw-composed.headers /tmp/nanoflow-ngsw-worker.headers /tmp/nanoflow-version.headers; do
  grep -Ei '^(cf-cache-status|age|cf-ray|cache-control|content-type):' "$headers" || true
  if grep -Eiq '^cf-cache-status:\s*HIT\b' "$headers" && grep -Eiq '^age:\s*[1-9][0-9]*\b' "$headers"; then
    echo "Freshness-critical path appears edge-cached with HIT + Age>0: $headers"
    exit 1
  fi
done
curl -fsS "$ORIGIN/.well-known/assetlinks.json" | grep -q "app.nanoflow.twa"
```

期望：

- `index.html` / `ngsw.json` / `sw-composed.js` / `ngsw-worker.js` / `manifest.webmanifest` 返回 `Cache-Control: no-cache, no-store, must-revalidate` 或等效非长缓存头。
- `/` 与 `/index.html` 不返回 `Link: ... rel=modulepreload`。首版迁移必须用 `! Link` 关闭 Cloudflare Pages 自动 Link 生成；如果仍出现 Link header，说明 `_headers` 没生效或 zone 规则/Transform 注入了 Early Hints 输入。
- freshness 关键路径必须输出 `CF-Cache-Status` / `Age` / `CF-Ray` / `Cache-Control` / `Content-Type` 到 CI 日志。`/`、`/index.html`、`ngsw.json`、SW 脚本、`version.json` 不能出现 `CF-Cache-Status: HIT` 且 `Age > 0`；若 Cloudflare 返回 `NONE/UNKNOWN`、`DYNAMIC`、`MISS`、`BYPASS` 或 `REVALIDATED`，以 `Cache-Control` 和重复请求行为共同判断。
- `version.json` 返回 no-store，且不被 Angular SW 长期缓存。
- `worker-basic.min.js` / `safety-worker.js` 返回 no-store；应用 worker chunk 只有精确文件名 header 才允许 immutable；`_headers` 不得包含 `/worker*.js` / `/worker-*.js` 这类宽泛 immutable 规则；生成后的 `ngsw.json` 不得列入这两个安全 worker。
- `fonts/lxgw-wenkai-screen.css`、`icons/icon-192x192.png` 等非 hash public 资源不能返回 `immutable`；如果未来改成 hash/versioned 文件名，必须同步更新契约样本。
- `/projects` 返回 200 且 `Content-Type: text/html`（SPA fallback 命中）。
- 缺失 JS/CSS/asset 不能静默返回 Angular shell HTML 200；如果 Pages 默认 SPA fallback 无法区分，必须由 Playwright 证明 ChunkLoadError 清缓存刷新可恢复，不能白屏。
- `assetlinks.json` body 包含 `app.nanoflow.twa` 字符串，并包含期望 fingerprint 集合。
- `assetlinks.json` 返回 no-store 或短 revalidate，不允许长期缓存；Android dev/release/Play Signing 任一 fingerprint 变更后必须能快速收敛。
- 阶段 3 首次 production deploy 后，先把 `ORIGIN` 设为 `https://<project>.pages.dev` 跑一次；custom domain 只有在 Cloudflare Dashboard 显示 Active、TLS 正常后才把 `ORIGIN` 切到 `https://app.nanoflow.app` 或最终域名再跑。不要在绑定 custom domain 前把 smoke 硬编码到 `app.nanoflow.app`，否则会把 DNS/TLS 未完成误判为部署失败。

### 14.3 何时跑 / 怎么接 workflow

见 §16.15。

## 15. 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| Direct Upload 不能切 Git integration | 后续想用 Cloudflare 自动构建需新建项目 | 当前目标就是 GitHub Actions 构建，接受约束 |
| Cloudflare API Token 泄漏 | 部署通道被滥用 | Account token、Pages Edit 最小权限、GitHub Secrets、定期轮换 |
| OIDC 被误写成当前方案 | CI 无法部署 | 明确标注为未来升级项，当前使用官方支持的 API Token |
| Vercel 止血被误解为迁移替代 | 修复构建分钟后继续留在旧架构，后续再次被构建/额度/平台耦合卡住 | 明确 A/B/C 都只是迁移前置和迁移窗口保底，完成后仍进入 Cloudflare 阶段 0 |
| Sentry inject 后文件名 hash 失真 | JS 内容变了但 `main/chunk` 文件名不变，浏览器 immutable cache 继续信任旧 URL | 首版默认关闭 sourcemap；启用时 post-inject rename 并重写 HTML/modulepreload/`ngsw.json`，或把被 inject JS 降级为 revalidate |
| Angular/esbuild 构建输出漂移 | 同一 commit 产出不同 chunk/hash，immutable cache、`ngsw.json`、Sentry sourcemap 全部失去共同基准 | `quality:guard:build-deterministic` 两次 clean build 比对 hashed JS/CSS、modulepreload 和 `ngsw.json`；不要写未暴露的 esbuild seed |
| Source Map 公开部署 | 源码和注释泄露 | 上传 Sentry 后删除 `.map`，CI 最终门禁 |
| `_headers` 多规则合并 Cache-Control | SW 或 HTML 被错误长期缓存 | 不用 `/*.js` 覆盖全部 JS，单独列 hashed chunk 和 SW |
| Early Hints + modulepreload 提前拉取错误 chunk | DNS/TLS/SW 稳定前放大间歇性 `ChunkLoadError` 或 MIME 错误 | 首版 `_headers` 用 `! Link` 关闭自动 Link 生成；header smoke 断言 `/` 和 `/index.html` 无 modulepreload `Link` header |
| `worker-basic.min.js` 被 `/worker*.js` 或 `/worker-*.js` 长缓存 | Angular 安全 worker 无法及时清理旧 SW，PWA version skew 放大 | `_headers` 单独给 `worker-basic.min.js` no-store；禁止静态 worker 通配 immutable 规则，应用 worker chunk 只能用构建后精确文件名规则 |
| `ngsw.json` 仍把安全 worker 纳入 assetGroups | 响应头 no-store 但 Angular SW 继续版本化缓存安全清理脚本 | 阶段 1 收紧 `ngsw-config.json` 的 `/worker*.js` / `/worker-*.js`，并检查生成的 `dist/browser/ngsw.json` |
| 非 hash public 资源被目录级 immutable | 字体/图标更新后用户长期拿旧文件 | `public/fonts/**`、`public/icons/**`、非 hash `assets` 首版 revalidate；改成 hash/versioned 后才允许长期缓存 |
| `_redirects` 错误代理静态资源 | JS/CSS 变成 HTML，白屏 | 首选 Pages 默认 SPA fallback；如加 `_redirects`，preview 中用 curl/Playwright 验证 content-type |
| Service Worker version skew | Chunk/JIT/DI 错误 | no-store 核心清单，保留 GlobalErrorHandler 和 SwUpdate 验证 |
| Canonical Origin Gate 执行太晚 | 旧 SW / Supabase / 队列在非 canonical origin 已经启动，read-only 失效 | gate 必须是 `<head>` 最前同步脚本；旧 origin 或 `ngswHash` mismatch 只允许一次 SW unregister + cache delete |
| 缺失静态资源被 SPA fallback 吞掉 | `/chunk-deadbeef.js` 返回 HTML 200，旧 HTML 加载新部署时白屏 | smoke 负向请求缺失 JS/CSS/asset；如 Pages 默认 fallback 不可区分，Playwright 证明 ChunkLoadError 能清缓存恢复 |
| Origin 变化导致 IndexedDB 不可见 | 用户误以为本地数据丢失 | 切域名前清空同步队列，本地-only 数据导出，旧 Vercel origin 保留 72 小时 |
| 新域名首开像“数据丢失” | 用户看到空工作区，不知道应等待云端恢复、导出旧站或重新安装 PWA | 新 canonical origin 首次启动显示迁移欢迎/恢复状态页，展示云端恢复、队列同步、旧 origin 导出和 PWA 刷新/重装提示 |
| 多个生产 origin 同时可写 | apex/`www`/`app`/`pages.dev` 各自持有 IndexedDB、SW 和队列，数据分叉 | Canonical Origin Gate；非 canonical origin redirect/read-only/export-only，禁止 SW/Supabase/队列 flush |
| 同域 DNS 分裂脑 | 同一 custom domain 在 TTL 收敛期命中 Vercel/Cloudflare 两个不同前端版本 | DNS 前两边部署同一份 `dist/browser`，用 `/version.json`/入口 chunk/`ngsw.json` 比对一致 |
| `pages.dev` 留作第二个生产写入入口 | 用户、OAuth、PWA、Sentry 在两个生产 origin 间分叉 | `pages.dev` 只用于 custom domain 前 smoke；custom smoke 通过后从 Supabase Auth/CORS/Storage 移除或 redirect/read-only |
| 旧 Vercel 与新 Cloudflare 双 origin 同时写入 | LWW 版本竞争，离线队列互相覆盖，用户看到幽灵数据 | 割接前部署 export-only/read-only 旧站，阻断写入 UI、队列 flush、cloud push；只有主动回滚窗口才恢复写入 |
| client-side origin gate 被旧 SW/旧 HTML 绕过 | 旧 origin 仍可能 flush 队列，产生 ghost write | mutation 走 RPC/CAS，服务端校验 `operation_id`、`syncProtocolVersion`、`deploymentEpoch`、tombstone barrier；旧写返回 `ghost_write_rejected` |
| Realtime 已开启但计划误当未来能力 | 上线 smoke 漏测当前 WebSocket 路径，弱网下本地/云端状态分叉 | 阶段 0 确认 feature flag；阶段 1/2 加 Realtime 断线、fallback polling、LWW/tombstone e2e |
| BlackBox Realtime 未纳入主同步门禁 | Focus/BlackBox 游标推进或 tombstone 失败但普通任务 smoke 仍通过 | 单列 `black_box_entries` 断线/fallback/cursor-after-persist/pending merge/tombstone 测试 |
| 无条件同步 `upsert` 击穿 LWW | 离线旧写重放后被数据库 `updated_at=now()` 变成“最新”，覆盖其他端新写 | 同步实体改条件写入/RPC；远端版本已前进时返回 remote-newer 并先 pull+merge |
| 成功 push 后本地 timestamp 未归一 | 后续 LWW/增量拉取混用客户端时间和服务端时间，产生误判 | 成功 push 必须把服务端 canonical `updated_at` 写回 store、IndexedDB 和队列基线 |
| 任一游标早于 merge/持久化推进 | merge 失败后后续增量拉取跳过同一批远端变更，形成永久数据缺口 | 全仓 cursor registry；所有路径返回候选 cursor，成功 merge + IndexedDB persist 后再 commit；禁止本地 `new Date()` 作为远端水位 |
| timestamp-only cursor 漏同时间戳行 | 批量写入/分页中断后同 `updated_at` 未处理行被 `>` 查询跳过 | 组合 cursor `(updated_at,id)` 或强制 `lastSyncTime - safetyWindow` 回看 + 去重 + tombstone 优先 |
| 队列跨实体重放无契约 | 删除后旧 attachment/connection/focus recording 写入成功，产生孤儿数据 | `operation_id`、同实体保序、跨实体依赖、delete/tombstone barrier 和 cleanup 测试 |
| 多标签同时 flush 同一队列 | 重复 cloud push、游标竞争、旧写覆盖新写 | Web Locks single-writer；降级 IndexedDB lease + TTL + heartbeat；非 owner 只能通知/等待 |
| Supabase Realtime 静默断连 | 页面看似在线但不再接收远端变更 | 默认启用 `worker: true` 与 `heartbeatCallback`；heartbeat timeout / `CHANNEL_ERROR` / `TIMED_OUT` 进入 Sentry breadcrumb 和 polling fallback |
| 误判 Cloudflare Pages 会代理 Supabase WS | 错误排障方向，忽略真正的浏览器后台/网络路径问题 | 文档明确 Supabase Realtime 仍由浏览器直连 Supabase；迁移 smoke 聚焦后台 throttling、弱网、高延迟和 Sentry 指标 |
| Supabase Auth redirect / Email Template 漏审 | password reset、Magic Link、OAuth 把用户带回旧域或非 canonical origin | grep `redirectTo/location.origin`，生产用 canonical helper；Dashboard 审查 Email Templates |
| Edge Function CORS 漏配 | 语音转写、病毒扫描、widget 等功能失败 | 全量 grep `supabase/functions/**`，用 hostname/regex 支持受控 preview 域，更新所有 contract tests |
| Storage signed URL 被 SW 长缓存 | logout 后同浏览器 profile 仍能读取私有附件/录音 | `maxAge` 不超过签名有效期；私有文件优先不用 Angular SW dataGroups，logout 清理 Cache Storage/附件视图 |
| PR preview 污染生产 Supabase | 测试数据进入真实项目 | 默认强制独立 Preview Supabase；生产 opt-in 必须 READ_ONLY_PREVIEW、RLS/RPC 隔离和自动清理 |
| apex 域名误走 CNAME 路径 | custom domain 无法正确接入 Pages | 子域名才走路径 A；`nanoflow.app` apex 走 Cloudflare full DNS setup |
| DNSSEC 旧 DS 残留 | Nameserver 迁移后 SERVFAIL | 仅 full DNS 迁移时提前移除旧 DS，稳定后启用 Cloudflare DNSSEC |
| full DNS 记录漏迁 | app 成功但邮件、证书签发、第三方验证失败 | 旧 zone 全量导出，与 Cloudflare 导入结果 diff A/AAAA/CNAME/MX/TXT/CAA/NS/DS/SRV |
| Cloudflare zone 规则覆盖 Pages 行为 | `_headers` 正确但被 Cache Rules/Transform/Challenge 改写 | 阶段 0 inventory app host 命中规则，禁止 Cache Everything、HTML Edge TTL、改写和全站 Challenge |
| 关键路径被 Cloudflare edge 缓存 | `index.html` / `ngsw.json` / SW 脚本被 `CF-Cache-Status: HIT` 服务，PWA version skew 全局扩散 | header smoke 记录 `CF-Cache-Status`、`Age`、`CF-Ray`；freshness 关键路径禁止 `HIT + Age>0` |
| `_headers` 规则数超过上限 | Direct Upload 后 header 规则失效或部署失败 | CI 统计 `_headers` 路径规则数，超过 90 失败，保留 100 条上限余量 |
| Direct Upload API 200 但边缘 500/522 | 部署看似成功，用户或 preview 实际打不开 | deploy 后等待 `/` + `/version.json` health check；生产前记录 `wrangler pages deployment list` |
| `dist/browser` 文件数逼近 Pages 上限 | 大量小 chunk / sourcemap / 资产增长导致 Direct Upload 失败 | CI 文件数超过 18,000 fail-fast；Source Map 删除后再上传 |
| `workflow_dispatch` 行为不清 | 手动运行只 build/test 却误以为已部署，或误部署 | 增加 `deploy` input；默认不部署，只有 main + `deploy=true` 才生产部署 |
| Sentry/Cloudflare token 暴露给 build/test | 同仓 PR 修改构建脚本读取发布 token | Sentry token 仅在 upload step，Cloudflare token 仅在 deploy step；build/test 只暴露 `NG_APP_*` |
| deploy workflow 复杂度失控 | 个人项目后续升级 Angular/Wrangler/Node 时 CI 脆弱且难复现 | 新增不读部署 secret 的 dry-run workflow；复杂逻辑下沉到 `scripts/ci` / `scripts/smoke`，YAML 只编排 |
| Cloudflare Dashboard 变量被误当成 Angular 运行时变量 | 新部署仍使用旧 Supabase/Sentry/GoJS 配置 | Direct Upload 下以 GitHub Actions Secrets 为准，Cloudflare Variables 只用于 Pages Functions 或 Git integration 构建 |
| Wrangler 从仓库根目录上传时误带根 `functions/` | 自动启用 Pages Functions，改变响应路径和计费边界 | CI guard 同时检查仓库根 `functions/` 与 `dist/browser/functions/`；必要时用隔离 staging 目录上传 |
| Sentry trace/replay 域名未更新 | 新域名下可观测性缺口 | 更新 `tracePropagationTargets`，上线后手动制造一次测试错误和 replay |
| GoJS license 域名未覆盖 | 新域名出现水印或授权错误 | 切换 custom domain 前确认 GoJS license key 覆盖新域名 |
| GoJS 大图主线程阻塞 | Angular OnPush UI 掉帧，自动布局期间页面无响应 | 增加 200/500/1000 节点分级门禁；超阈值默认 Text/降级 Flow，布局预计算迁往 Worker 或分片调度 |
| GoJS 异步布局旧结果晚到 | 用户编辑后的新坐标被旧 generation 覆盖 | 布局任务带 generation/graphRevision/input hash；新任务取消或废弃旧任务，写回前二次校验 |
| GoJS 反复打开/销毁泄漏 | 移动端/长会话内存升高、后台 listener 继续写状态 | 10 次打开/销毁 smoke 检查 Diagram/listener/timer/heap 趋势，销毁后无全局 handler |
| OnPush 与 GoJS 事件桥接漏测 | GoJS 内部状态变化后 Angular UI 不刷新，或销毁后仍有 handler 写状态 | 高频事件留 zone 外，状态事件显式 `NgZone.run()`/signal bridge；Playwright 覆盖选择、拖拽、连线、主题、销毁 |
| Cloudflare 边缘差异放大 Flow 首开成本 | 部分地区弱网下 GoJS chunk 和布局更慢，本地 smoke 通过但用户掉帧 | preview/custom domain 取弱网/移动 profile；可用远程浏览器时补亚洲/欧洲边缘采样 |
| Cloudflare Pages Rollback 命令写错 | 回滚慢或失败 | Pages 用 Dashboard/API rollback，不写 `wrangler rollback` |
| TWA origin 变化 | Android App 无法验证 Web origin | 优先沿用 custom domain；改域名则同步 assetlinks、`android/app/build.gradle.kts` 和 TWA 配置 |
| `assetlinks.json` 只校验 package name | release/dev/Play Signing 任一 fingerprint 缺失，TWA 验证失败 | CI 使用 `ANDROID_TWA_EXPECTED_SHA256_CERT_FINGERPRINTS` 逐一校验 fingerprint |
| `widget-black-box-action` 被误认为复用 `_shared/widget-common.ts` | CORS 漏改，黑匣子 widget action 在新域名失败 | 单独列入 CORS inventory，必要时独立改源码和测试 |
| Fork PR 因缺少 secrets 执行 `validate-env:prod` 失败 | 外部 PR 无法通过基础 CI | workflow 拆分 test 与 build-deploy；fork PR 只跑不依赖 secrets 的 test job |
| Sentry CLI latest 漂移 | sourcemap inject/upload 行为变化 | 固定 `@sentry/cli` 版本或加入 devDependency 由 lockfile 管理 |

## 16. 项目级审查增补项

本节补充策划案 §1-§16 未覆盖、但落地阶段必须处理的项。每条标注归属阶段，避免和已有路线图冲突。

### 16.1 既有部署基础设施清单（补 §2）

仓库当前不止 Vercel 一份托管配置，迁移和清理必须三套同步处理：

| 文件 | 用途 | 迁移动作 |
| --- | --- | --- |
| `vercel.json` | Vercel rewrites/headers/`ignoreCommand` | 阶段 4 决策保留作为回滚锚还是删除；删除前确认 startup-contract 已重写 |
| `netlify.toml` | Netlify build/redirects/headers | 同上；当前 `NODE_VERSION = "20"`，与本计划 GitHub Actions 选用版本必须对齐 |
| `public/_headers`（新增） | Cloudflare Pages 头规则 | 阶段 1 新增 |
| `public/_redirects`（可选） | Cloudflare Pages SPA fallback | 仅在默认 fallback 不满足深链刷新时新增 |
| `src/tests/startup-contract.spec.ts` | 同时校验 `vercel.json` 和 `netlify.toml` 中 `sw-composed.js`、`ngsw-worker.js`、`widgets/templates/(.*)` 的 `no-cache` | 阶段 1 必须随头规则改造同步更新；不更新会让 CI 红 |
| `android/app/build.gradle.kts` | Android TWA 默认 `webOrigin` | 阶段 1 纳入旧域名 inventory；按最终域名更新默认值或要求 release 构建显式传 `NANOFLOW_WEB_ORIGIN` |

执行方式：在阶段 1 增加一条任务"决定保留/删除旧托管配置文件，并同步更新 `startup-contract.spec.ts`"。仅删除 `vercel.json` / `netlify.toml` 而不动 spec 会立即破坏 `npm run test:run:ci`。

### 16.2 Edge Function CORS 边界细化（替换 §6.2 的全量审查描述）

仓库实际至少有四类 CORS 实现：`transcribe` 硬编码、`virus-scan` env 驱动、`_shared/widget-common.ts` env 驱动、`widget-black-box-action` 独立内联。迁移成本不同，不能把所有 widget 函数都视为 `_shared/widget-common.ts` 统一覆盖；表中另列复用 `_shared/widget-common.ts` 的 widget 函数，便于执行时归类：

| Edge Function | CORS 实现 | 迁移路径 |
| --- | --- | --- |
| `supabase/functions/transcribe/index.ts` | **硬编码** `ALLOWED_ORIGINS` 数组 + `*.vercel.app` 前缀判断 | 必须改源码，更新 `src/tests/contracts/transcribe-cors.contract.spec.ts`，重新部署 |
| `supabase/functions/virus-scan/index.ts` | 读 `Deno.env.get('ALLOWED_ORIGINS')` exact match，缺省回退到内置默认；另有 Vercel preview hostname 判断 | 固定 production origin 与临时 pages.dev 可用 `supabase secrets set ALLOWED_ORIGINS=...`；custom smoke 后移除 pages.dev；PR preview wildcard 需要改源码 |
| `supabase/functions/_shared/widget-common.ts` | 读 `Deno.env.get('ALLOWED_ORIGINS')` exact match，缺省回退到内置默认；另有 Vercel preview hostname 判断 | 固定 production origin 与临时 pages.dev 可用 secret；custom smoke 后移除 pages.dev；`pr-*.pages.dev` 需要改源码 |
| `widget-register` / `widget-summary` / `widget-notify` / `widget-focus-action` | 复用 `_shared/widget-common.ts` | 跟随 `_shared/widget-common.ts` 的修复路径 |
| `supabase/functions/widget-black-box-action/index.ts` | **独立内联** `ALLOWED_ORIGINS` + Vercel preview hostname 判断 | 必须单独改源码或明确 preview 不覆盖此链路 |

阶段 0 行动：

```bash
# 固定 production + 临时 pages.dev origin 可先写入 Supabase secrets
supabase secrets set ALLOWED_ORIGINS="https://app.nanoflow.app,https://nanoflow.app,https://nanoflow.pages.dev"
# PR preview wildcard 不会被普通字符串 exact match 命中，必须走代码改动或不测相关链路。
```

`https://nanoflow.pages.dev` 是临时 production smoke origin，不是长期生产入口。custom domain smoke 通过后，必须再次执行 `supabase secrets set ALLOWED_ORIGINS=...` 去掉该 origin，或先部署 host-based read-only/redirect 保护后再保留访问。

PR preview 通配（`https://pr-*.nanoflow.pages.dev`）目前不会被 `ALLOWED_ORIGINS` 的字符串相等比较匹配。要么扩展 `transcribe`、`virus-scan`、`_shared/widget-common`、`widget-black-box-action` 增加 hostname regex 支持，要么**preview 不走需要这些 Edge Function 的链路**。两条路二选一，必须在阶段 0 决策。

**事实校验（2026-04-28 通过 `rg` 验证）**：当前 `supabase/functions/**` 中所有对 `vercel.app` / `nanoflow.app` 的硬编码引用都用于 **CORS allow-list 判断**，没有任何函数把 hostname 写回响应 body / 邮件模板 / push payload / deep link。因此本节列出的 4 个 CORS 实现就是 origin 迁移时 Edge Function 侧的全部改动面；如果未来添加了 widget 模板回写 URL 或邮件链接的逻辑，需要把对应函数追加进 §16.3 的 inventory 表。

### 16.3 旧 Vercel 域名引用全量清单（补 §5/§9）

策划案多处提"更新 contract tests"但只点名 `transcribe-cors.contract.spec.ts`。实际仓库引用 `dde-eight.vercel.app` / `dde[-\w]*\.vercel\.app` 的位置（行号会随 PR 漂移，落地时以下表中的**符号/区域**为准，迁移 PR 必须重新 `rg` 一次定位）：

| 文件 | 定位（符号/区域） | 性质 | 处理方式 |
| --- | --- | --- | --- |
| `src/services/sentry-lazy-loader.service.ts` | `tracePropagationTargets` 数组 | 运行时 trace 传播目标正则 | 阶段 1 改为同时包含新域名与旧域名（迁移窗口期），稳定后移除旧 |
| `src/tests/contracts/transcribe-cors.contract.spec.ts` | 整个 spec（`ALLOWED_ORIGINS` / `VERCEL_PREVIEW_PREFIX` / `isOriginAllowed` 测试块） | 整套契约围绕 vercel 项目前缀 | 阶段 1 改写，与 transcribe Edge Function 同步 |
| `src/services/global-error-handler.service.spec.ts` | 包含 `dde-eight.vercel.app` 的堆栈 fixture 测试块 | 堆栈解析 fixture | 阶段 1 改为新域名 fixture，或保留旧 fixture 验证向后兼容 |
| `src/workspace-shell.component.spec.ts` | 包含 `dde-eight.vercel.app` 的路由 fixture | 路由 fixture | 同上 |
| `src/utils/runtime-platform.spec.ts` | host package 解析负样例（包含 vercel.app 的 case） | host 解析负样例 | 同上 |
| `scripts/contracts/check-secrets.cjs` | `.vercel` 目录排除规则 | 与 vercel.json 共存 | 删除 vercel.json 时一并审查 |
| `android/app/build.gradle.kts` | `webOrigin` `defaultValue` | TWA 默认 `webOrigin` | 阶段 1 按最终域名更新默认值，或要求 release 构建显式传 `NANOFLOW_WEB_ORIGIN` |
| `supabase/functions/transcribe/index.ts` / `virus-scan/index.ts` / `_shared/widget-common.ts` / `widget-black-box-action/index.ts` | `ALLOWED_ORIGINS` / `getCorsHeaders` / origin 判断分支 | Edge Function CORS allow-list | 阶段 1 按 §6.2/§16.2 处理，回滚窗口后移除旧域 |

切换前先全仓 inventory：

```bash
rg "dde-eight\.vercel\.app|dde[-\w]*\.vercel\.app|vercel\.app" --hidden -g '!node_modules' -g '!dist'
```

逐项归类（运行时常量 / Edge Function CORS / TWA 配置 / 测试 fixture / 文档归档），再决定替换或保留。迁移 PR 描述必须贴出 inventory 摘要，避免静态清单漏项。

### 16.4 构建产物后处理顺序（补 §5.4）

NanoFlow `npm run build` 在 `ng build` 之后还有四个后处理步骤，迁移到 GitHub Actions 后必须**完整复刻**，否则产物缺件：

```text
1. node scripts/run-ng.cjs build           # Angular AOT
2. node scripts/generate-launch-html.cjs   # 生成 launch.html（PWA 启动占位页）
3. node scripts/inject-modulepreload.cjs   # 向 index.html 注入 modulepreload Link
4. node scripts/patch-ngsw-html-hashes.cjs # 修正 ngsw.json 中 HTML 文件 hash
5. node scripts/validate-launch-shared-markers.cjs   # 校验 launch.html 共享标记
6. node scripts/validate-launch-artifact-closure.cjs # 校验 launch.html 闭包资源
```

`npm run build:stats` 已经包含完整链路，因此 §5.3 workflow 调用 `build:stats` 是对的。但有两个**容易踩坑**的点：

**陷阱 A：Sentry sourcemap inject / post-inject rename 后必须重新跑 step 3-4，不止 step 4。**

策划案 §5.4 只写了 `npx ngsw-config dist/browser ngsw-config.json /` 重建 ngsw。问题是：

- `inject-modulepreload.cjs` 把 hashed chunk 名写进了 `index.html` 的 `<link rel="modulepreload">`。如果 inject 改了 chunk 内容但没改文件名（Debug ID 是 inline 注入），文件名不变，modulepreload Link 无需重写，但对应 JS 不能继续 immutable。
- 如果采用 §5.4 的完整方案做 post-inject rename，文件名会变化，必须再次运行 `inject-modulepreload.cjs`，否则 HTML 仍预加载旧 chunk 名。
- `patch-ngsw-html-hashes.cjs` 修正的是 `ngsw.json` 中 HTML 内容 hash。`inject-modulepreload` 修改了 `index.html`，`patch-ngsw-html-hashes` 必须**在 sourcemap 流程之外**已经跑过。
- 如果 sourcemap inject 修改了 `index.html`（Sentry 通常不改 HTML），还需要再次跑 `patch-ngsw-html-hashes.cjs`。

正确顺序：

```text
1-6. 标准 build:stats 完成
7.  Sentry sourcemaps inject dist/browser
8.  Sentry sourcemaps upload
9.  rm dist/browser/**/*.map
10a. 若 post-inject rename：重命名 JS/CSS -> node scripts/inject-modulepreload.cjs
10b. 若不 rename：把被 inject 的 JS header 降级为 revalidate
11. npx ngsw-config dist/browser ngsw-config.json /
12. node scripts/patch-ngsw-html-hashes.cjs   # 重新对齐 HTML hash
13. find dist/browser -name '*.map' 必须为空
```

**陷阱 B：Cloudflare Early Hints 与 modulepreload 叠加。**

Cloudflare Pages 官方文档说明 Early Hints 会自动从 HTML 中的 `preload` / `preconnect` / `modulepreload` 生成 `Link` header，且所有 `pages.dev` 与 custom domains 自动启用。`scripts/inject-modulepreload.cjs` 的目的就是把 modulepreload 写进 HTML；如果不控制，Cloudflare 可能把这些 chunk 作为 103 Early Hints 提前发给浏览器。

首版策略：

- 在 `_headers` 的 `/*` 规则下写 `! Link`，禁用自动 Link header 生成，避免 Early Hints 在 DNS/TLS/Service Worker 稳定前放大 chunk 预加载错误。
- 不要写自造的 Early Hints 关闭响应头；Cloudflare Pages 官方支持的是移除 `Link` header，或给 HTML `<link>` 增加额外属性（例如 `data-do-not-generate-a-link-header`）使其不参与自动 Link 生成。
- 不在 `_headers` 中手写 hashed chunk preload。

阶段 2 验收增加两条：

- `curl -I "$ORIGIN/"` 不应出现 `Link: </chunk...>; rel=modulepreload`；若出现，说明 `! Link` 未生效或其他规则注入了 Link。
- 若后续单独 PR 重新启用 Early Hints，必须用 `curl -I --http2 "$ORIGIN/"` / WebPageTest 或等价工具记录是否出现 103，并逐一校验 Link 指向的 chunk 在 `dist/browser` 和 `ngsw.json` 中存在，且返回 JS MIME 而不是 HTML。

### 16.5 Service Worker dataGroups 跨域资源（补 §8）

`ngsw-config.json` 的 `dataGroups` 缓存以下浏览器直连的外部 URL：

```text
https://*.supabase.co/storage/v1/object/*    # Storage（运行时使用）
https://fonts.googleapis.com/**              # Google Fonts（运行时使用）
https://fonts.gstatic.com/**                 # Google Fonts CSS/woff2（运行时使用）
https://cdn.jsdelivr.net/npm/lxgw-wenkai*/** # LXGW 字体（运行时使用，src/services/startup-font-scheduler.service.ts）
https://cdn.jsdelivr.net/**                  # 其他 jsdelivr 资源（**当前运行时无引用**，预留）
https://unpkg.com/**                         # unpkg（**当前运行时无引用**，预留）
```

**事实校验（2026-04-28 通过 `rg "cdn\.jsdelivr\.net|unpkg\.com" src/`）**：实际只有 `startup-font-scheduler.service.ts` 引用 `cdn.jsdelivr.net`；`unpkg.com` 和宽泛的 `cdn.jsdelivr.net/**` 在 NanoFlow 当前代码里没有运行时引用。

迁移到 Cloudflare Pages **不影响**这些请求（仍由浏览器直连）。CSP 收紧时按"实际使用"取最小集，避免照抄 `dataGroups`：

- `connect-src` 必须包含 `https://*.supabase.co` 和 Sentry DSN 的 host。
- `font-src` 必须包含 `https://fonts.gstatic.com` 与 `https://cdn.jsdelivr.net`（LXGW woff2）。
- `style-src` 必须包含 `https://fonts.googleapis.com` 与 `https://cdn.jsdelivr.net`（LXGW CSS 文件）。
- **不要**在 CSP 里默认加 `https://unpkg.com`——运行时不引用，加进去等于无故扩大攻击面。
- `cdn.jsdelivr.net/**`（不带 LXGW 前缀）同理：除非明确添加新的 CDN 依赖，否则 CSP 走精确路径前缀（`cdn.jsdelivr.net/npm/lxgw-wenkai*/`），不写整个 `cdn.jsdelivr.net`。

Storage dataGroup 是隐私风险，不只是性能缓存：

- 当前 `supabase-storage` dataGroup 的 `maxAge` 是 `7d`。如果运行时使用 signed URL，这个值不得超过签名有效期；否则已过期 URL 的内容可能在同一浏览器 profile 中继续可读。
- 阶段 1 必须确认 attachment、focus recording、voice file 的 URL 类型、签名有效期和 logout 行为。私有附件/录音优先不要交给 Angular SW dataGroups 缓存；改由应用层 IndexedDB/Cache 管理，并在 logout / account switch 时清理。
- 若暂时保留 `supabase-storage` dataGroup，必须保证不缓存 401/403/opaque response；logout 后至少清理本应用 Cache Storage / NGSW data cache 或撤销本地附件视图。
- custom domain smoke 加一条：登录用户打开附件/录音后 logout，再以同浏览器 profile 访问旧 signed URL 或附件视图，不能继续展示私有内容。
- SW-specific CORS smoke 必须在 Angular SW 已控制页面后执行。用 Playwright 读取 `response.status()`、`response.headers()` 和浏览器侧 `Response.type`，分别覆盖正常 signed URL、过期 signed URL、logout 后 signed URL、Google Fonts 和 jsdelivr 字体。任何 `opaque`、401、403 被写入 NGSW data cache 都是阻断项。
- 如果第三方 CDN 无法稳定提供 CORS 响应，不要把它放进 `dataGroups` 的 `performance` 策略；改为 `freshness` + `cacheOpaqueResponses=false`（或移出 Angular SW，由应用层 Cache/IndexedDB 管理）。

可选清理：迁移后单独 PR 把 `ngsw-config.json` 的 `external-cdn` group 收窄到与 CSP 一致——保留 LXGW 前缀，移除 `unpkg.com` 与宽泛 `cdn.jsdelivr.net/**`。`supabase-storage` 是否保留则必须在阶段 1 做出隐私决策，不能只按性能缓存处理。

未来精简 CDN（例如把 LXGW 字体自托管到 Cloudflare）时，先在 ngsw `dataGroups` 中替换 URL 模式，再做 CSP 收紧。

### 16.6 安全响应头补全（补 §4.4）

策划案 `_headers` 草案首版只启用低风险基础头：

```text
/*
  X-Content-Type-Options: nosniff
  X-Frame-Options: SAMEORIGIN
  Referrer-Policy: strict-origin-when-cross-origin
```

以下头不要混入首版迁移，稳定后单独 PR 评估：

```text
/*
  Permissions-Policy: camera=(), microphone=(self), geolocation=(), payment=()
  Cross-Origin-Opener-Policy: same-origin-allow-popups
  Cross-Origin-Resource-Policy: same-site
```

注意：

- `microphone=(self)` 因为 NanoFlow 有 Focus 模式语音转写。
- **首版不启用 `Strict-Transport-Security`**。`HSTS_STABILIZATION_WINDOW` 见 §3.2。HSTS 一旦被浏览器记录，回滚到 HTTP 或错误子域配置会变困难；仅在 Cloudflare TLS 和所有相关子域稳定满 `HSTS_STABILIZATION_WINDOW` 后，作为独立变更启用。
- **不开启 `Cross-Origin-Embedder-Policy: require-corp`**：会导致 Supabase Storage 跨域图片、jsdelivr CDN 字体被拒绝。GoJS chunk 通过 same-origin 加载不受影响，但外部资源会断。
- **`Content-Security-Policy` 暂不开启**：NanoFlow 当前没有运行时 CSP，盲开会触发大面积告警。CSP 收紧应作为**迁移后独立任务**，先 `Content-Security-Policy-Report-Only` 观察一周再切硬模式。

### 16.7 Boot Flag / Feature Flag 注入清单（补 §5.2）

**单事实源**：`scripts/set-env.cjs`。本节给出截至 2026-04-30 的快照，**实际清单与默认值以源码为准**；落地阶段必须以 `grep -E "process\.env\.NG_APP_" scripts/set-env.cjs` 输出为准，避免文档与代码再次分叉。

当前 `set-env.cjs` 注入的 `NG_APP_*` 布尔 Flag 快照：

```text
NG_APP_DISABLE_INDEX_DATA_PRELOAD_V1     default true
NG_APP_FONT_EXTREME_FIRSTPAINT_V1        default true
NG_APP_FLOW_STATE_AWARE_RESTORE_V2       default true
NG_APP_EVENT_DRIVEN_SYNC_PULSE_V1        default true
NG_APP_TAB_SYNC_LOCAL_REFRESH_V1         default true
NG_APP_STRICT_MODULEPRELOAD_V2           default false
NG_APP_ROOT_STARTUP_DEP_PRUNE_V1         default true
NG_APP_TIERED_STARTUP_HYDRATION_V1       default true
NG_APP_SUPABASE_DEFERRED_SDK_V1          default true
NG_APP_CONFIG_BARREL_PRUNE_V1            default true
NG_APP_SIDEBAR_TOOLS_DYNAMIC_LOAD_V1     default true
NG_APP_RESUME_INTERACTION_FIRST_V1       default true
NG_APP_RESUME_WATERMARK_RPC_V1           default true
NG_APP_RESUME_PULSE_DEDUP_V1             default true
NG_APP_ROUTE_GUARD_LAZY_IMPORT_V1        default true
NG_APP_WEB_VITALS_IDLE_BOOT_V2           default true
NG_APP_FONT_AGGRESSIVE_DEFER_V2          default true
NG_APP_SYNC_STATUS_DEFERRED_MOUNT_V1     default true
NG_APP_PWA_PROMPT_DEFER_V2               default true
NG_APP_RESUME_SESSION_SNAPSHOT_V1        default true
NG_APP_USER_PROJECTS_WATERMARK_RPC_V1    default true
NG_APP_RECOVERY_TICKET_DEDUP_V1          default true
NG_APP_BLACKBOX_WATERMARK_PROBE_V1       default true
NG_APP_WORKSPACE_SHELL_COMPOSITION_V3    default true
NG_APP_RESUME_COMPOSITE_PROBE_RPC_V1     default true
NG_APP_RESUME_METRICS_GATE_V1            default true
NG_APP_SYNC_RPC_ENABLED                  default false
NG_APP_SYNC_LEASE_ENABLED                default false
```

当前 Cloudflare 迁移相关非布尔 `NG_APP_*` 注入快照：

```text
NG_APP_SENTRY_ENVIRONMENT                default production/development
NG_APP_CANONICAL_ORIGIN                  default empty
NG_APP_ORIGIN_GATE_MODE                  default off
NG_APP_READ_ONLY_PREVIEW                 default false
NG_APP_DEPLOYMENT_TARGET                 default local
NG_APP_SUPABASE_PROJECT_ALIAS            default local/configured project ref
NG_APP_SENTRY_RELEASE                    default empty / CI git SHA
NG_APP_SYNC_PROTOCOL_VERSION             default 1
NG_APP_DEPLOYMENT_EPOCH                  default 0
```

含义：GitHub Actions 环境如果不显式注入这些变量，会落到代码中的默认值——和 Vercel 当前的默认值是否一致**取决于 Vercel Dashboard 是否覆盖过任何 flag**。

阶段 0 必做：

1. 登录 Vercel Dashboard 导出当前生产环境变量全集（含所有 `NG_APP_*`）。
2. **以 `scripts/set-env.cjs` 当前实际解析的 flag 列表为准**（用 `grep -E "process\.env\.NG_APP_" scripts/set-env.cjs` 重新生成完整列表，不要照抄本节快照），与默认值逐一对照；若有差异，把差异项写进 GitHub Actions Secrets 或 Variables。
3. 在 §5.2 GitHub Secrets 表追加这批 `NG_APP_*` 项作为可选 override。
4. 阶段 2 preview 验收时 `console.log(environment)` 或加一条断言，确认 flag 与生产期望一致。
5. 阶段 1 增加 contract 防漂移：在 `npm run quality:guard:supabase-ready` 或独立 spec 中校验 `set-env.cjs` 的 flag 列表与本文档快照差异 ≤ 阈值，差异超阈必须在同一 PR 中同步本节快照。

### 16.8 manifest.webmanifest 与 assetlinks.json 内容审查（补 §10）

迁移前必须确认两份产物中没有硬编码旧 origin：

```bash
cat dist/browser/manifest.webmanifest | jq '{id, scope, start_url, related_applications}'
cat dist/browser/.well-known/assetlinks.json | jq '.[].target.sha256_cert_fingerprints'
```

**`manifest.webmanifest`**：

- `scope` 与 `start_url`：必须是相对路径或当前 origin；如果硬编码 `https://dde-eight.vercel.app/...`，PWA 在新域名下会被识别为另一个 app，离线缓存隔离、shortcut 失效。
- `id`：一旦上线后不要变，否则浏览器把它当新 PWA。`id` 的值如果原本是 `https://dde-eight.vercel.app/`，迁移后无解——只能让用户重新安装。**这是一票否决项**，迁移前必须看清楚。

**`assetlinks.json`**：

- 通过 `scripts/generate-assetlinks.cjs` 生成。Android TWA 同时存在 dev keystore 与 release keystore 时，必须包含**两个 SHA256 fingerprint**，否则 dev 安装包验证失败。
- 如果使用 Google Play App Signing，还需要 Play Store 控制台分发的 fingerprint。
- CI 不能只 grep `app.nanoflow.twa`。阶段 1 必须把所有期望 fingerprint 写入 `ANDROID_TWA_EXPECTED_SHA256_CERT_FINGERPRINTS`（逗号分隔，使用冒号格式或 64 位 hex 都可，由脚本规范化），并逐一断言它们出现在 `dist/browser/.well-known/assetlinks.json`。缺少该 secret 时可以 warning，但正式 release 前必须补齐，否则 dev/release/Play Signing 任一渠道可能出现 TWA origin 验证失败。

阶段 1 增加任务：在 CI artifact guard 中校验 `dist/browser/manifest.webmanifest` 不包含 `vercel.app` 字符串，并校验 `assetlinks.json` 的 package name 与 fingerprint 集合完整匹配。

### 16.9 防止误启用 Pages Functions（补 §4）

Cloudflare Pages 看到 `dist/browser/functions/` 目录或 `dist/browser/_worker.js` 文件会**自动启用** Functions runtime。Wrangler Direct Upload 还有一个额外陷阱：如果命令从仓库根目录执行，根目录 `functions/` 文件夹也会被识别并随 Pages 项目上传。因此 guard 必须同时检查仓库根目录与最终部署目录，附带影响包括：

- 改变响应头处理（`_headers` 仍生效，但 Functions 优先）；
- 静态资源吞吐被 Functions 预算（每天 100k 请求 free plan）限制；
- 增加冷启动与边缘计算开销。

NanoFlow 不需要 Functions。CI artifact guard 增加：

```bash
test ! -d functions
test ! -d dist/browser/functions
test ! -f dist/browser/_worker.js
```

可选增强：写入 `public/_routes.json` 显式禁用：

```json
{
  "version": 1,
  "include": [],
  "exclude": ["/*"]
}
```

但仅在确实存在 Functions runtime 且要精确排除路由时才需要——如果仓库根目录和 `dist/browser` 都没有 `functions/` / `_worker.js`，`_routes.json` 是冗余的。**不建议加**，留空是更干净的 Direct Upload。若未来必须在仓库根目录放 `functions/` 做其他用途，Wrangler 部署命令应改为从隔离的 staging 目录执行，或在部署前把静态产物复制到不含 `functions/` 的临时目录再上传。

### 16.10 Supabase 配套补充（补 §6）

策划案 §6 已覆盖 Auth Redirect 与 Edge Function CORS。还有三块没写：

**16.10.1 Supabase Storage 跨域**

Storage signed URL 的有效性与 origin 无关，但 bucket CORS allow-list 在 Supabase Dashboard 里。检查路径：

```text
Supabase Dashboard
-> Storage
-> 选择 bucket（attachments / focus-recordings）
-> Configuration / CORS
```

加入 `https://app.nanoflow.app`、临时 `https://nanoflow.pages.dev`、PR preview 模式（如果允许 preview 直传 Storage）。`pages.dev` 只服务 custom domain 生效前的 production smoke；custom domain smoke 通过后必须从生产 bucket CORS 中移除，或配合 redirect/read-only 策略禁用写入。

**16.10.2 Supabase Realtime WebSocket**

NanoFlow 当前 Realtime 已开启：`FEATURE_FLAGS.REALTIME_ENABLED = true`，`SYNC_CONFIG.REALTIME_ENABLED` 通过 getter 引用该值，`RealtimePollingService` 已订阅 Supabase `postgres_changes`。另外 `BlackBoxSyncService` 独立订阅 `black_box_entries`，维护自己的 `lastSyncTime` 和 IndexedDB cursor。因此迁移必须按 Realtime-on 路径验收：

- WebSocket 走 `wss://<project>.supabase.co/realtime/v1/websocket`，与 Cloudflare Pages 无关；
- CSP 若后续启用，`connect-src` 必须包含 `wss://*.supabase.co`；
- Cloudflare 不要对 Supabase Realtime 域名做 proxying；
- Realtime event 只触发 drift check / 增量拉取，不能直接写 idb-keyval 或覆盖 Signals store；
- `black_box_entries` event 同样只能触发 BlackBox 增量拉取/merge，不能绕过 `BlackBoxEntry.updatedAt`、pending monotonic merge 和 `deletedAt` tombstone 保护；
- `CHANNEL_ERROR`、`TIMED_OUT`、heartbeat timeout、浏览器后台静默断连必须进入 polling fallback；
- 主同步与 BlackBox 同步的游标都只能在 merge + IndexedDB 持久化成功后提交；`lastSyncTimeByProject` 与 BlackBox `lastSyncTime` 的失败不推进测试必须分开写；
- 阶段 1 默认启用 `heartbeatCallback` 与 `worker: true`。heartbeat `timeout` / `disconnected` 必须写 Sentry breadcrumb/metric 并触发 polling fallback；worker 文件必须可访问且不能被错误长缓存，未来 CSP 也要补 `worker-src`。若不启用 worker，必须有显式例外和后台标签页长时运行测试；
- 若维护者决定迁移首版临时关闭 Realtime，必须用显式配置 PR 修改 feature flag，并补 polling-only e2e；不能只在策划案中假设它关闭。

**16.10.3 Migration ↔ 前端部署顺序**

如果迁移窗口同时有 Supabase migration 待发布：

```text
错误顺序：先合并前端到 main，Cloudflare 部署新版本，但 migration 还没跑
后果：前端期待新 schema，数据库还是旧 schema，新增任务 400/500
```

正确顺序：

```text
1. Supabase 应用 migration（向后兼容；新列允许 NULL，新表不删旧表）
2. 前端 main 合并，Cloudflare 部署
3. 观察 24 小时无回滚需求后，跑后续 migration（删除旧字段、收紧约束）
```

回滚同理：前端能 rollback 到旧版本的前提是数据库 schema 仍向后兼容旧前端代码。

阶段 -1 / 阶段 0 增加任务：盘点未发布 migration 是否破坏向后兼容。

**16.10.4 LWW 条件写入、timestamp 与多标签单写者**

这部分不是 Cloudflare 平台能力，但迁移会放大问题：新旧 origin、Realtime 恢复、多标签恢复联网都会让离线队列集中重放。首版迁移必须把以下内容作为同步正确性补丁处理：

- **禁止无条件同步 upsert**：`tasks`、`connections`、`projects`、`black_box_entries` 等会参与 LWW 的实体，cloud push 不能只调用 Supabase `.upsert(payload)`。可接受实现是 Postgres RPC / SQL function / 条件 update：带上本地已知 `baseServerUpdatedAt`，在一个数据库事务中读取当前行并决定 insert、update 或 remote-newer conflict。
- **RPC 返回结构**：建议返回 `{ status: 'inserted' | 'updated' | 'remote-newer' | 'deleted-remote-newer', serverUpdatedAt, remoteRow? }`。客户端只在 `inserted/updated` 后从队列移除；`remote-newer` 必须进入 pull+merge，不得本地丢弃或强推覆盖。
- **tombstone 优先级**：如果远端 `deleted_at` / `deletedAt` 比本地基线新，本地旧 update 必须失败为 `deleted-remote-newer`，不能让旧离线更新复活软删除行。
- **canonical timestamp**：数据库触发器如果写入服务端 `updated_at`，客户端成功 push 后必须用返回值更新本地 `updatedAt`、IndexedDB 快照和队列基线。后续 LWW、增量拉取和 cursor commit 只能比较 canonical 值。
- **组合 cursor**：阶段 1 新增一个 sync cursor registry 或等价封装，集中提交 `lastSyncTimeByProject` / BlackBox `lastSyncTime`。新 cursor 优先保存 `(updated_at, id)` 或 `(updated_at, entity_type, id)`，所有调用方只能提交候选 remote watermark，不允许散落调用 `setLastSyncTime(projectId, new Date().toISOString())`。若短期保留 timestamp-only cursor，强制 `lastSyncTime - safetyWindow` 回看并按 entity 去重。
- **sync writer lock**：同一 origin 同一用户/项目只有一个 owner 可以 flush RetryQueue/ActionQueue、执行 cloud push、提交 cursor。Web Locks API 是首选；降级方案必须是 IndexedDB lease + TTL + heartbeat，不能只靠 BroadcastChannel。
- **queue contract**：RetryQueue/ActionQueue mutation 必须有 `operation_id`、entity id、entity type、base version 和依赖关系；同 entity 保序，跨 entity 依赖显式校验。task delete/tombstone 是 barrier，后续旧 connection/attachment/focus recording upload 不能复活或留下孤儿数据。
- **可观测性**：remote-newer conflict、deleted-remote-newer、cursor commit blocked、lease acquire/release/steal、owner crash takeover 都要产生 Sentry breadcrumb 或 metric，阶段 4 能按 production environment 过滤。

迁移 PR 的最小验收不是“代码里有 RPC”，而是能复现并通过这些用例：旧离线写不覆盖远端新写；远端 tombstone 不被旧 update 复活；同 timestamp 分页不漏拉；cursor 失败不推进；两个标签页恢复联网不重复 flush；task 删除后旧 attachment/focus recording/connection mutation 不留下孤儿数据。

### 16.11 PR Preview 数据隔离落地方案（补 §6.1）

策划案 §5.2 / §6.1 多次提"使用 preview Supabase 项目"，但没给出具体方案。三选一：

**方案 A：Supabase Branching（官方功能）。** 适合中等以上预算项目，PR 自动派生 schema 分支与隔离数据。需要 Supabase Pro 计划。个人项目通常不选。

**方案 B：独立 Supabase Preview Project（默认强制）。** 创建一个 `nanoflow-preview` 项目，PR preview 走它的 URL/anon key。当前仓库通过 GitHub Environment `NanoFlow-Preview` 注入同名 `NG_APP_SUPABASE_URL` / `NG_APP_SUPABASE_ANON_KEY`；不要再引入 `PREVIEW_NG_APP_*` 与生产 fallback 表达式。

- 优点：完全隔离，不影响生产用户。
- 缺点：需要手动同步 schema。可写一个 `scripts/sync-preview-schema.sh`，在 CI 里 pin 到生产 schema 的某个 commit。

**方案 C：生产 Supabase + 测试用户（默认禁止，临时例外）。** 用一个 `preview-bot@nanoflow.app` 用户登录 PR preview，所有写入都打到该用户的 RLS 隔离区。每次 PR 关闭后用 cron 清理该用户的数据。

```sql
-- 阶段 1 任务：在 supabase/migrations/ 中加入 preview cleanup function
-- 仅当采用方案 C 时
CREATE OR REPLACE FUNCTION cleanup_preview_user_data() ...
```

方案 C 只有同时满足以下条件才允许临时使用：

- preview 构建注入 `READ_ONLY_PREVIEW=true`，应用层所有 cloud push、RPC mutation、Edge Function mutation、RetryQueue/ActionQueue flush 都 fail closed。
- RLS/RPC 层把 preview-bot 限制在隔离 namespace，不能访问真实用户数据；如果要写，必须写入自动清理的 preview project/test user 范围。
- preview smoke 默认只读；需要写入时必须用隔离数据集并在 PR 关闭/每天定时清理。
- PR preview 的 `X-Robots-Tag: noindex` / `<meta name="robots" content="noindex,nofollow">` 必须启用，避免 branch alias 被搜索引擎或外部用户当成入口。

**默认强制方案 B**，并在阶段 0 决策后写进 §5.2 secrets 表。方案 C 不能只靠“测试纪律”或“只读 smoke”文字说明放行。

### 16.12 Wrangler 与依赖版本固定（补 §5.3）

§5.3 workflow 使用 `npx wrangler@"$WRANGLER_VERSION" pages deploy ...` + `nick-fields/retry@v3` 包装。Direct Upload 行为在 wrangler 3.x 不同子版本间有过破坏性改动（`pages deploy` flag 命名）。Sentry CLI 同理，`npx @sentry/cli` 不应隐式跟随 latest。

阶段 1 必做：

- **wrangler**：`WRANGLER_VERSION` 环境变量（§3.2 定义）固定到 `3.112.0`，所有 `npx wrangler@...` 调用必须显式引用该变量，不要让 `npx wrangler` 隐式跟随 latest；`3.114.0` 已因 `nodejs_compat` 部署故障退役。
- **Sentry CLI**：`SENTRY_CLI_VERSION` 固定到 `2.58.2`，`npx @sentry/cli@"$SENTRY_CLI_VERSION"` 显式 pinning，不改 `package.json`。

不推荐替换为 `cloudflare/wrangler-action@v3`，理由：

- 该 action 的 `wranglerVersion` 输入也只能 pin wrangler 本体，不会减少 retry/超时控制需求。
- §5.3 已用 `nick-fields/retry@v3` 包裹 `npx wrangler` 直接调用，对 5xx/401 限流可控。两套机制混用反而复杂。
- 保持单一 invocation 风格便于本地复现：开发者只需 `WRANGLER_VERSION=3.112.0 npx wrangler@$WRANGLER_VERSION pages deploy dist/browser ...` 即可对齐 CI。

升级路径：

- 升级 wrangler/Sentry CLI 必须通过独立 PR；PR 描述附 `npx wrangler@<new> pages dev dist/browser` 与（如启用 sourcemap）`npx @sentry/cli@<new> sourcemaps inject --dry-run` 的本地验证日志。
- 如果后续需要本地复现 sourcemap 流程，再把 `@sentry/cli` 加入 devDependency 并由 lockfile 固定。

### 16.13 Direct Upload 失败重试与边缘健康确认（补 §5.3）

Cloudflare Direct Upload 偶发 5xx / 401（token 限流）。workflow 加 retry：

```yaml
- name: Deploy production to Cloudflare Pages
  uses: nick-fields/retry@v3
  with:
    timeout_minutes: 8
    max_attempts: 3
    retry_wait_seconds: 30
    command: |
      npx wrangler@"$WRANGLER_VERSION" pages deploy dist/browser \
        --project-name=$CLOUDFLARE_PAGES_PROJECT_NAME \
        --branch=main
  env:
    CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
    CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

本节使用 `npx wrangler@"$WRANGLER_VERSION"` + `nick-fields/retry@v3` 包装的方案，与 §5.3 / §16.12 保持一致；不推荐再叠一层 `cloudflare/wrangler-action@v3`（会和 retry 机制重叠且不易本地复现）。

retry 只覆盖上传 API 失败，不覆盖“Wrangler 输出异常但 deployment 其实已经创建”或“API 返回成功但边缘还没健康”的窗口。Deploy step 后必须先从 Wrangler 输出或 `wrangler pages deployment list --project-name=...` 中解析出候选 deployment URL；如果解析不到，就继续重试并在最终失败时中止，不能直接回退到 `https://<project>.pages.dev` 这种通用别名。拿到候选 deployment URL 后，再对该 URL 的 `/` 和 `/version.json` 做最多 3 分钟等待式 health check；只有根路径返回 200，且 `/version.json.gitSha === GITHUB_SHA`，才进入 §14 header smoke 和 Playwright smoke。这里的门禁目标是保证“当前 SHA 的 deployment 可用且健康”；对于同一 SHA 的 rerun，允许复用已存在的健康 deployment URL，而不是强制要求本次运行新建 deployment id。生产 deploy 前先跑一次 `wrangler pages deployment list --project-name=...`，把最近 deployment 状态写进日志，避免在上一轮 deployment 未稳定时叠加生产发布。

`Direct Upload` 用 Wrangler 上传时单次最多 20,000 文件、单文件 25 MiB；Dashboard drag-and-drop 是 1,000 文件。NanoFlow 当前产物 1-3k 文件，首版不要用 drag-and-drop 上传完整 `dist/browser`，项目创建后直接走 Wrangler 或只用最小占位 `index.html` 建项目。Sentry sourcemap 启用后文件数会翻倍，需要确认 `.map` 已删后再上传。CI 额外设置 18,000 文件软上限，给 Cloudflare 限额、未来 assets 和紧急诊断文件保留余量：

```bash
FILE_COUNT="$(find dist/browser -type f | wc -l | xargs)"
test "$FILE_COUNT" -le 18000
```

`_headers` 还有 100 条规则上限。阶段 1 的 CI cache guard 必须统计：

```bash
HEADER_RULES="$(grep -E '^/[^[:space:]]+' dist/browser/_headers | wc -l | xargs)"
test "$HEADER_RULES" -le 90
```

保留 10 条余量用于紧急 no-store、redirect/read-only 或新增 worker chunk 规则。

### 16.14 Node 版本统一（补 §5.3）

现状不一致：

- `netlify.toml`：`NODE_VERSION = "20"`
- 策划案 `deploy-cloudflare-pages.yml`：`node-version: 22`
- `.github/workflows/test-full-suite.yml` 与 `perf-and-resume-gates.yml` 已使用 Node 22
- `package.json` engines 当前是 `>=18.19.0`

阶段 1 任务：

```bash
grep -rn "node-version\|NODE_VERSION" .github/workflows netlify.toml package.json
```

首版迁移只要求 Cloudflare deploy workflow 固定 Node 22，并同步任何仍用于过渡部署的平台配置。是否把 `package.json` 收紧到：

```json
"engines": {
  "node": ">=22.0.0 <23.0.0"
}
```

应作为独立基线决策，不在 Cloudflare 迁移 PR 中隐式完成；如果收紧，需要同步 README、开发环境说明、CI 和旧托管平台配置。

### 16.15 部署后 Smoke 自动化（实现，配合 §14 契约）

§14 定义 smoke 契约（测什么）；本节给执行点（何时跑、怎么接）。把 §14.1 的 Playwright 契约接进 deploy workflow：

注意执行顺序：Wrangler/API 成功返回后，先跑 §5.3 的 deployment health wait，再跑本节 smoke。header smoke 必须读取真实线上响应头，因为 Cloudflare zone-level Cache Rules / Transform Rules / Challenge 可能覆盖或改写 `_headers` 的意图；只检查仓库里的 `public/_headers` 不够。

```yaml
- name: Post-deploy header smoke on Pages URL
  if: github.event_name != 'pull_request' && success()
  env:
    SMOKE_ORIGIN: https://${{ secrets.CLOUDFLARE_PAGES_PROJECT_NAME }}.pages.dev
  run: |
    bash scripts/smoke/cloudflare-header-smoke.sh "$SMOKE_ORIGIN"

- name: Post-deploy Playwright smoke on Pages URL
  if: github.event_name != 'pull_request' && success()
  env:
    PLAYWRIGHT_BASE_URL: https://${{ secrets.CLOUDFLARE_PAGES_PROJECT_NAME }}.pages.dev
  run: |
    npx playwright test e2e/cloudflare-smoke.spec.ts --reporter=line

- name: Post-deploy smoke on custom domain
  if: github.event_name != 'pull_request' && success() && vars.CLOUDFLARE_CUSTOM_DOMAIN_ORIGIN != ''
  env:
    SMOKE_ORIGIN: ${{ vars.CLOUDFLARE_CUSTOM_DOMAIN_ORIGIN }}
    PLAYWRIGHT_BASE_URL: ${{ vars.CLOUDFLARE_CUSTOM_DOMAIN_ORIGIN }}
  run: |
    bash scripts/smoke/cloudflare-header-smoke.sh "$SMOKE_ORIGIN"
    npx playwright test e2e/cloudflare-smoke.spec.ts --reporter=line
```

首次迁移的执行顺序必须是：production Direct Upload 完成后先 smoke `https://<project>.pages.dev`；custom domain 绑定并确认 TLS active 后，再设置 `CLOUDFLARE_CUSTOM_DOMAIN_ORIGIN` 并跑 custom domain smoke。降级方案：若不跑完整 Playwright，**最低限度**跑 §14.2 的 header 契约脚本作为 shell step，并对返回非 200 的关键路径或 `text/html` 命中 hashed JS 的情形 fail-fast。完整 Playwright 与 header 脚本不要同时只挑一个跑——header 脚本不能验证 IndexedDB / 离线行为，Playwright 又不强制头检查。两者互补：CI deploy job 至少跑 header 脚本，nightly 跑完整 Playwright。

### 16.16 性能 Guard 接入与 baseline 漂移（补 §5.3）

`npm run perf:guard` 包含 5 项：`build:stats` / `nojit` / `startup` / `font-contract` / `supabase-ready`。策划案 deploy workflow 只跑 `nojit`，本轮补充 deterministic build guard。

判断：

- `font-contract` 与 `supabase-ready` 是构建产物契约，**不依赖运行环境**，应进入 deploy 链路。
- `build-deterministic` 是缓存/SW/Sentry 的上游契约，必须进入 deploy 或 dry-run 阻塞链路。
- `startup` 依赖 Lighthouse / 启动时序基线，CI 环境波动大；放在 `perf-and-resume-gates.yml` nightly 跑即可，不进 deploy 阻塞链路。

调整后 deploy workflow 步骤：

```yaml
- run: npm run build:stats
- run: npm run quality:guard:build-deterministic
- run: npm run perf:guard:nojit
- run: npm run quality:guard:font-contract
- run: npm run quality:guard:supabase-ready
```

`perf:guard:startup` 与 `perf:guard:no-regression` 保留在 nightly。Cloudflare 边缘 TTFB 与 Vercel 不同，可能让 startup baseline 出现一次性漂移——迁移稳定满 7 天后用 `npm run test:baseline:update` 重置基线。

### 16.17 文件命名与缓存模式（补 §4.4）

`angular.json` production 配置 `outputHashing: "all"`、`namedChunks: false`。含义：

- 入口：`main-<hash>.js`、`polyfills-<hash>.js`、`styles-<hash>.css`；
- 懒加载：`chunk-<hash>.js`；
- Web Worker：`worker-<hash>.js`。

`_headers` 草案中的 `/main*.js` / `/polyfills*.js` / `/chunk*.js` 能命中 hash 命名产物。应用 Web Worker chunk 不能用静态 `/worker-*.js` 规则处理，因为它也会命中 Angular 的 `worker-basic.min.js`。**风险点**：

- 如果未来在 `angular.json` 把 `outputHashing` 改成 `bundles` 或 `media`，`chunk*.js` 模式可能失效；
- 如果引入新的入口 bundle（例如 `runtime-*.js`），需要补规则。
- Angular 当前还会输出 `worker-basic.min.js` / `safety-worker.js` 这类安全 worker 文件，它们不是 hash 命名产物，必须 no-store，不能被 `/worker*.js` 或 `/worker-*.js` 宽泛规则吃掉。
- 当前 `ngsw-config.json` 的 `app-lazy.resources.files` 包含 `/worker*.js`。这会让生成的 `ngsw.json` 管理 `worker-basic.min.js`；如果未来改成 `/worker-*.js` 也一样会命中。即使响应头是 no-store，Angular Service Worker 仍可能把安全 worker 纳入版本资产；必须从源配置收紧，或在生成后对 `ngsw.json` fail-fast。
- 当前 `public/fonts/**` 与 `public/icons/**` 不是内容 hash 文件名。目录级 `immutable` 会让图标/字体更新被浏览器长期固定；首版只能 revalidate，除非先改成 hash/versioned 文件名。
- 如果确实存在应用 Web Worker chunk，构建脚本必须从 `dist/browser/worker-*.js` 中排除 `worker-basic.min.js`，再生成精确文件名 header；静态 `_headers` 中禁止出现 `/worker-*.js` immutable 规则。

阶段 1 加 CI artifact guard：

```bash
# 防御性检查：除入口/polyfills/chunk/worker 和已知安全 worker 外，不应有未匹配规则的 .js 出现在根目录
# 注：runtime-、sw-composed/ngsw-worker/safety-worker/worker-basic.min 是兜底匹配；
#     当前 @angular/build:application 走 esbuild 不会产出独立 runtime-*.js，
#     worker-basic.min.js 是 Angular 安全 worker，必须在 _headers 中 no-store，
#     且不能出现在生成后的 ngsw.json 应用 assetGroups 中。
grep -Eq '^/worker\*\.js$|^/worker-\*\.js$' dist/browser/_headers && {
  echo "Do not use broad /worker*.js or /worker-*.js immutable header; it matches worker-basic.min.js"
  exit 1
}

grep -En '"/worker\*\.js"|"/worker-\*\.js"' ngsw-config.json && {
  echo "ngsw-config.json must not use broad /worker*.js or /worker-*.js; it can cache Angular safety workers"
  exit 1
}

grep -Eq '"(worker-basic\.min|safety-worker)\.js"' dist/browser/ngsw.json && {
  echo "Angular safety workers must not be listed in generated ngsw.json assetGroups"
  exit 1
}

awk '
  /^\/(assets|icons|fonts)\/\*/ { in_public=1; next }
  /^\/[^[:space:]]+/ { in_public=0 }
  in_public && /immutable|max-age=31536000/ {
    print "Non-hash public assets/fonts/icons must not use immutable cache rules"
    exit 1
  }
' dist/browser/_headers

for worker_file in dist/browser/worker-*.js; do
  [ -e "$worker_file" ] || continue
  worker_name="$(basename "$worker_file")"
  [ "$worker_name" = "worker-basic.min.js" ] && continue
  grep -qx "/$worker_name" dist/browser/_headers || {
    echo "Missing exact immutable _headers rule for application worker chunk: /$worker_name"
    exit 1
  }
done

find dist/browser -maxdepth 1 -name '*.js' -printf '%f\n' | grep -vE '^(main|polyfills|chunk|worker|runtime)-|^(sw-composed|ngsw-worker|safety-worker|worker-basic\.min)\.js$' && exit 1 || true
```

### 16.18 Sentry 多环境配置（补 §5.5）

策划案 §5.5 谈了 release 对齐，未涉及 environment 与 sample rate。建议：

| 环境 | environment | tracesSampleRate | replaysSessionSampleRate | replaysOnErrorSampleRate |
| --- | --- | --- | --- | --- |
| local | `development` | 0 | 0 | 0 |
| PR preview (`pr-*.pages.dev`) | `preview` | 0.1 | 0 | 1.0 |
| production (`app.nanoflow.app`) | `production` | 0.05 | 0.01 | 1.0 |

实现路径：

- 在 `scripts/set-env.cjs` 增加 `NG_APP_SENTRY_ENVIRONMENT` 注入；
- 同步更新 `scripts/ensure-env-files.cjs`，否则测试/本地 bootstrap 生成的 `src/environments/*` 仍缺少 environment 字段，类型和运行时会与 CI build 分叉；
- 在 `src/environments/environment.ts`、`src/environments/environment.development.ts` 的对象 shape 中加入 `sentryEnvironment`（或同名约定字段），并补 `SentryLazyLoaderService` 单元测试；
- workflow 中按 `github.event_name` 选值：

```yaml
NG_APP_SENTRY_ENVIRONMENT: ${{ github.event_name == 'pull_request' && 'preview' || 'production' }}
```

- `SentryLazyLoaderService` 中读取该值并传入 `Sentry.init({ environment })`，不得继续只用 `environment.production ? 'production' : 'development'` 推断 preview。

首版迁移**已包含**该改动（见 §12 阶段 1 的"Sentry environment 区分"任务）；本节保留作为决策来源与采样率推荐表，避免后续 PR 重新讨论。`replaysSessionSampleRate` 在 preview 设为 0 是为了节省 Sentry replay quota——preview 主要用 e2e 自动化，session replay 价值有限。

### 16.19 Robots / Sitemap / 旧域名收敛（补 §11）

策划案没提 SEO 收敛。现状：NanoFlow 没有官方 robots.txt 或 sitemap.xml（已确认 `public/` 中不存在）。迁移期间：

- **稳定 72 小时后**，在旧 Vercel 部署的 `public/_headers` 注入：

  ```text
  /*
    X-Robots-Tag: noindex
  ```

  防止搜索引擎继续抓取旧域名。

- 不必新增 sitemap/robots 到 Cloudflare 部署，除非有 SEO 需求。
- 如果用户从旧域名 bookmark 进入，提供一个 redirect 友好提示（保留 Vercel 旧部署的同时，加 `vercel.json` rewrite 指向 `https://app.nanoflow.app`）。但 PWA `id` 一旦绑定到旧 origin，redirect 解决不了 PWA 安装迁移问题。

### 16.20 Vercel 完全失能时的最小可发布路径（补 §4.5）

阶段 -1 假设 Vercel 还能用作过渡。极端情况：Vercel 账户被锁、token 失效、构建额度立刻为 0 且无法升级。此时：

1. **立即在 GitHub 仓库 Settings 关闭 Vercel App 集成**，避免 Vercel 持续尝试构建。
2. 跳过阶段 -1 / 阶段 0 中的所有 Vercel 相关步骤，直接进入阶段 1。
3. Cloudflare Direct Upload 项目用 dashboard drag-and-drop 上传一个**本地构建产物**（`npm run build:stats && npm run perf:guard:nojit`），完成首次部署。
4. 自定义域名直接绑定，先牺牲 24-72 小时回滚窗口；老用户在切换前先用 `npm run start` 本地访问数据。
5. 阶段 2 / 阶段 3 在 Cloudflare 上原地推进。

阶段 -1 任务追加一条：**确认 Vercel 即使全失能，也有备份的 GitHub Secrets 与 Supabase secrets 可读。** Cloudflare 与 Supabase 凭据不要只存在 Vercel 中。

### 16.21 Rollback 时数据 schema 兼容（补 §9.2）

策划案 §9.2 把 rollback 当成"切回旧 deployment"。但 Local-First + Supabase 同步链路下，rollback 还要考虑：

- 用户在新版本期间已经写入 IndexedDB 的数据，使用了**新前端**才有的字段（如 `parking_meta` 子字段、`expected_minutes`）。
- 切回旧 Cloudflare deployment 后，旧前端读到这些字段会忽略或 crash。
- 推送到 Supabase 的写入若使用了新列，旧前端在拉取时也可能出现 type guard 失败。

缓解：

- Supabase migration 必须**纯增量**（只加列，不改语义）。
- 前端任何新字段必须有 `field ?? defaultValue` 兜底。
- 前端如果新增 schema validator，必须对未知字段保持宽松（`allowUnknown: true`）。

阶段 0 / 阶段 1 任务：审查近 30 天的前端字段新增 PR，确认旧前端能容忍。

### 16.22 本地预演（新增）

在合并 deploy workflow 之前，在本地完整跑一次 Cloudflare Pages 行为：

```bash
npm ci
npm run build:stats
npm run perf:guard:nojit
npm run quality:guard:font-contract
npm run quality:guard:supabase-ready
npx wrangler pages dev dist/browser --port 8788
# 浏览器打开 http://localhost:8788
# 验证 SPA fallback、_headers、PWA install、SW update
```

`wrangler pages dev` 会模拟 `_headers`、`_redirects`、Functions（如果存在）。这是最便宜的迁移信心来源，应作为阶段 1 的本地 dry-run 步骤。

### 16.23 监控与日志（补 §11）

Cloudflare Pages Free plan 没有持久化的 build 日志或运行时日志。可用的可观测性：

- **GitHub Actions run logs**：deploy workflow 自身的输出，保留 90 天。
- **Cloudflare Dashboard → Pages → Deployments**：每个部署的 build log（仅 Pages Git build 项目；Direct Upload 项目只有上传记录）。
- **Cloudflare Web Analytics**：免费，只看流量；不替代 Sentry。
- **Sentry**：runtime 错误、Session Replay、Performance。**唯一可靠的运行时观测**。

含义：迁移后 Sentry 是 SLO 主要信号源。阶段 4 必做：

- 验证 Sentry 在新域名下能正常上报；
- `tracePropagationTargets` 已包含新域名；
- 为 origin gate block/redirect、Realtime fallback、remote-newer conflict、deleted-remote-newer、sync cursor commit/blocked、same-timestamp cursor replay、sync writer lease acquire/release/steal、RetryQueue/ActionQueue dependency violation、Flow long task / GoJS 初始化失败 / stale layout dropped 增加 breadcrumb 或 metric，至少能在 Sentry 中按 production 过滤；事件上下文带 `/version.json` 中的 `gitSha` / `ngswHash` / `deploymentTarget`；
- 设置一个简单的 Sentry alert：`event.count > 50 in 1h && environment == production` → 邮件。

### 16.24 `/version.json` 部署指纹（新增）

迁移窗口需要判断用户到底命中了哪一层：Vercel、Cloudflare `pages.dev`、custom domain、旧 Service Worker，还是浏览器 HTTP cache。阶段 1 新增公开但不含敏感信息的 `/version.json`：

```json
{
  "gitSha": "GITHUB_SHA",
  "buildTime": "2026-04-29T00:00:00.000Z",
  "environment": "production",
  "appVersion": "package.json version",
  "deploymentTarget": "cloudflare-pages",
  "supabaseProjectAlias": "production",
  "sentryRelease": "optional release/debug-id mode",
  "ngswHash": "sha256 of dist/browser/ngsw.json"
}
```

门禁：

- `version.json` 必须 no-store，不进 Angular SW 长期 asset cache。
- 不写 Supabase URL、anon key、Sentry DSN、Cloudflare account id 或任何 secret。
- 同域 DNS 割接前，Vercel 与 Cloudflare 的 `gitSha`、入口 chunk、`ngswHash` 必须一致。
- Sentry event breadcrumb 可记录 `gitSha` / `ngswHash` / `deploymentTarget`，用于排查 version skew。

### 16.25 Angular 构建确定性门禁（新增）

本迁移大量依赖“文件名 hash 对应最终部署内容”：immutable cache、`ngsw.json`、Sentry sourcemap、modulepreload、同域 DNS 分裂脑回滚都建立在这个假设上。阶段 1 必须把它变成可执行 guard，而不是只相信 Angular/esbuild 默认行为。

新增 `npm run quality:guard:build-deterministic`，推荐实现：

```bash
rm -rf dist .tmp/build-a .tmp/build-b
npm run build:stats
cp -R dist/browser .tmp/build-a
rm -rf dist
npm run build:stats
cp -R dist/browser .tmp/build-b

find .tmp/build-a -type f \( -name 'main*.js' -o -name 'polyfills*.js' -o -name 'chunk*.js' -o -name 'worker-*.js' -o -name 'styles*.css' \) -print0 \
  | sort -z \
  | xargs -0 sha256sum > .tmp/build-a.manifest
find .tmp/build-b -type f \( -name 'main*.js' -o -name 'polyfills*.js' -o -name 'chunk*.js' -o -name 'worker-*.js' -o -name 'styles*.css' \) -print0 \
  | sort -z \
  | xargs -0 sha256sum > .tmp/build-b.manifest
diff -u .tmp/build-a.manifest .tmp/build-b.manifest
cmp .tmp/build-a/ngsw.json .tmp/build-b/ngsw.json
node scripts/compare-modulepreload.cjs .tmp/build-a/index.html .tmp/build-b/index.html
```

落地要求：

- 两次 build 必须使用相同 Node、npm、lockfile、`NG_APP_*` 输入、timezone 和 `SOURCE_DATE_EPOCH`（如脚本支持）。不要在文档或 CI 中写 Angular builder 未暴露的 esbuild seed 参数。
- 比对对象包含 hashed JS/CSS、应用 worker chunk、`index.html` modulepreload 列表、`launch.html`（如存在）和 `ngsw.json`。`version.json.buildTime` 这类天然变化字段必须在生成最终部署指纹时单独处理，不能污染确定性比较。
- Sentry inject 默认关闭。若启用 inject，确定性 guard 分两层：build 前 guard 证明 Angular 输出稳定；inject/post-inject rename/rebuild `ngsw.json` 后再生成最终 deploy manifest，证明 Sentry upload 的 JS 与 Cloudflare deploy 的 JS 是同一份。
- 如果 guard 失败，不允许用“重新跑一次 CI”跳过。先固定 Node/npm/Wrangler/Sentry CLI 版本，检查 `scripts/set-env.cjs` 是否按稳定顺序写 environment，检查 build 脚本是否引入时间戳、随机数、路径绝对值或并行输出顺序。

最终 artifact manifest 是另一个门禁，不等同于 deterministic guard。推荐字段：

```json
{
  "gitSha": "GITHUB_SHA",
  "node": "22.x",
  "npmLockHash": "sha256(package-lock.json)",
  "files": [
    {
      "path": "main-abc123.js",
      "sha256": "...",
      "bytes": 123456,
      "cachePolicy": "immutable",
      "contentType": "application/javascript"
    }
  ],
  "modulepreload": ["chunk-abc123.js"],
  "ngswHash": "sha256(dist/browser/ngsw.json)",
  "headersHash": "sha256(dist/browser/_headers)"
}
```

生成顺序必须在所有 post-build 操作之后：Sentry inject（如启用）→ post-inject rename（如启用）→ `inject-modulepreload`（如需要）→ `ngsw-config` → `patch-ngsw-html-hashes` → 删除 `.map` → 生成 artifact manifest。Vercel 回滚后备和 Cloudflare production smoke 都用该 manifest 比对，不再临时从 HTML 中猜入口 chunk。

### 16.26 Server-side 写入保护与迁移 UX（新增）

Canonical Origin Gate 和 export-only UI 是必要机制，但它们仍是客户端逻辑。旧 Service Worker、旧 HTML、直接书签、离线恢复或脚本异常都可能让旧 origin 尝试 flush 队列。阶段 3 前必须让服务端具备拒绝旧写的能力：

- 所有参与同步的 mutation 优先走 RPC/Edge Function；如果仍允许直接 PostgREST table mutation，必须证明 RLS 能做等价 CAS、tombstone barrier 和 protocol/version 拦截，否则阶段 3 阻塞。
- mutation payload 必须携带 `operation_id`、entity id、base version / base `updated_at`、`syncProtocolVersion`、`deploymentEpoch`、client `gitSha` / `deploymentTarget`。服务端把 `operation_id` 作为全局幂等键；重复请求返回已处理结果，不重复写。
- 迁移窗口内设置服务端最小 `syncProtocolVersion` / `deploymentEpoch`。旧 Vercel export-only 构建不应 flush；如果旧构建仍尝试写，RPC 返回明确 `client-version-rejected` / `migration-readonly`，并进入 Sentry `ghost_write_rejected`。
- `Origin` header 可以作为诊断字段记录，但不能作为唯一安全边界。浏览器 Origin 可被非浏览器客户端伪造，RLS/RPC 的真正判定应基于用户、operation id、entity version、protocol version 和 tombstone 状态。
- Sentry event/breadcrumb 必须带 `origin`、`gitSha`、`deploymentTarget`、`syncProtocolVersion`、`operation_id`、`entityType`、reject reason，方便定位旧 origin ghost write。

迁移 UX 也需要产品化：

- 新 canonical origin 首次启动检测到 origin 变化或本地 IndexedDB 为空但用户已登录时，显示一次性迁移状态页，不把“数据没了”暴露成空白工作区。
- 状态页展示云端恢复状态、RetryQueue/ActionQueue 状态、旧 origin 导出入口、PWA 刷新/重新安装提示和 Auth 重新登录提示。
- 恢复完成后进入正常工作区；恢复失败时保留导出/重试入口，并记录 Sentry breadcrumb。不要把该页做成 marketing landing page，它是迁移安全流程的一部分。

### 16.27 CI/CD 维护性与 dry-run（新增）

Deploy workflow 已经承担 secret 选择、构建、artifact guard、Sentry、Direct Upload、health wait 和 smoke。复杂度本身会成为长期风险，阶段 1 后必须提供低成本 dry-run：

- 新增独立 `deploy-cloudflare-pages-dry-run.yml`，或给现有 workflow 加 `workflow_dispatch` dry-run input。dry-run 不读取 `CLOUDFLARE_API_TOKEN` / `SENTRY_AUTH_TOKEN`，不执行 `wrangler pages deploy`，但跑 `npm ci`、测试、build、deterministic guard、artifact guards、`wrangler pages dev` 和本地 smoke。
- 所有 `NG_APP_*` 的默认值与注入逻辑以 `scripts/set-env.cjs` 为单事实源。CI 中新增 `npm run quality:guard:env-flags`：`set-env.cjs` 解析到的 `NG_APP_*` 列表必须与 `src/environments/*` shape、文档快照、workflow env 列表对齐；新增 flag 必须在同一 PR 更新四处，workflow 不得出现未被 `set-env.cjs` 消费的假 flag。
- 生产 deploy workflow 只消费 dry-run 已验证过的脚本，不复制另一份逻辑。脚本复杂逻辑优先落在 `scripts/ci/*.cjs` 或 `scripts/smoke/*.sh`，workflow YAML 只做编排。
- 每次 Angular、Wrangler、Sentry CLI 或 Node major/minor 升级，先跑 dry-run workflow 和 deterministic guard，再允许改 deploy workflow。

### 16.28 增补风险表（与 §15 保持同步）

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| `netlify.toml` 与 `vercel.json` 删除导致 startup-contract 红 | CI 阻塞 | 阶段 1 同步重写 spec，或保留旧配置作为只读契约 |
| `manifest.webmanifest` 中 `id` 硬编码旧 origin | PWA 安装态无法迁移，全部用户需重装 | 阶段 0 检查 `id`；如已硬编码旧 origin，迁移前先发版改成相对值并稳定 30 天 |
| `worker-basic.min.js` 被 `/worker*.js` 或 `/worker-*.js` 长缓存 | Angular 安全 worker 不能及时注销/清缓存，旧 SW 残留风险升高 | `_headers` 单独 no-store；禁止静态 worker 通配 immutable 规则，应用 Web Worker 只用构建后精确文件名规则 |
| `ngsw-config.json` 仍用 `/worker*.js` / `/worker-*.js` | `ngsw.json` 把安全 worker 当应用资产管理，响应头 no-store 失效一半 | 阶段 1 收紧 worker glob，并检查生成的 `dist/browser/ngsw.json` 不含安全 worker |
| 非 hash public 资源被 immutable | 字体、图标、普通资产更新长期不生效 | `public/fonts/**`、`public/icons/**`、非 hash assets revalidate；hash/versioned 后再加精确 immutable |
| Sentry inject 后文件名 hash 失真 | JS 内容变了但 `main/chunk` 文件名不变，浏览器 immutable cache 继续信任旧 URL | 首版默认关闭 sourcemap；启用时 post-inject rename，或把被 inject JS 降级为 revalidate |
| Angular/esbuild 构建输出漂移 | 同一 commit 产出不同 chunk/hash，immutable cache、`ngsw.json`、Sentry sourcemap 全部失去共同基准 | `quality:guard:build-deterministic` 两次 clean build 比对 hashed JS/CSS、modulepreload 和 `ngsw.json`；不要写未暴露的 esbuild seed |
| 最终 artifact manifest 缺失 | Sentry upload、Vercel 回滚后备、Cloudflare deploy 各自猜测入口 chunk 和 hash，排障时无法证明部署内容一致 | 所有 post-build 操作后生成 `artifact-manifest.json`，记录文件 SHA256、cache policy、content-type、modulepreload、`ngswHash`，并作为 smoke/回滚比对基准 |
| Early Hints + modulepreload 提前拉取错误 chunk | DNS/TLS/SW 稳定前放大 `ChunkLoadError`、MIME 错或旧 HTML 加载新 chunk 的失败 | 首版 `_headers` 用 `! Link` 关闭自动 Link 生成；header smoke 断言无 modulepreload `Link` header，后续单独 PR 才能重启 103 |
| `functions/` 或 `dist/browser/functions/` 误生成 | Cloudflare 自动启用 Functions runtime，影响响应头 | CI artifact guard 同时校验仓库根目录和部署目录不存在 |
| `_headers` 规则数超过上限 | 精确文件名 header 增长后超过 100 条限制 | CI 统计规则数，超过 90 失败 |
| Wrangler 版本漂移 | 部署突然失败 | 固定 `WRANGLER_VERSION`，所有 `npx wrangler@...` 调用显式引用 |
| Direct Upload 偶发 5xx | 部署中断 | retry-action 包裹，max 3 次 |
| Direct Upload API 200 但边缘 500/522 | Dashboard/CLI 显示成功，但 `pages.dev` 或 branch alias 实际不可用 | deploy 后等待 `/` + `/version.json` health check；production deploy 前记录 `wrangler pages deployment list` |
| `dist/browser` 文件数逼近 Pages 上限 | 大量 esbuild chunk、资产或误部署 `.map` 导致 Direct Upload 失败 | CI 文件数超过 18,000 fail-fast；完整构建不走 1,000 文件 drag-and-drop |
| Supabase migration 与前端部署顺序错位 | 新前端读旧 schema 报错 | migration 先发布且向后兼容；rollback 前不发破坏性 migration |
| Realtime 当前开启但未纳入迁移 smoke | 弱网或后台恢复后 IndexedDB 与 Supabase 分叉 | 阶段 0 确认 feature flag；阶段 1 默认 `worker: true` + `heartbeatCallback`，阶段 2 增加 WebSocket 断线、heartbeat timeout、fallback polling、LWW/tombstone e2e |
| 误判 Cloudflare Pages 会代理 Supabase WS | 错误排障方向，忽略真正的浏览器后台/网络路径问题 | 文档明确 Supabase Realtime 仍由浏览器直连 Supabase；迁移 smoke 聚焦后台 throttling、弱网、高延迟和 Sentry 指标 |
| BlackBox Realtime 未纳入迁移 smoke | Focus/BlackBox 游标、pending merge 或 tombstone 出错但主任务 smoke 通过 | 单列 `black_box_entries` 断线/fallback/cursor-after-persist/pending merge/tombstone 用例 |
| 无条件同步 `upsert` 击穿 LWW | 离线旧写重放后被数据库 `updated_at=now()` 变成“最新”，覆盖其他端新写 | 同步实体改条件写入/RPC；远端版本已前进时返回 remote-newer 并先 pull+merge |
| 成功 push 后本地 timestamp 未归一 | LWW/增量拉取混用客户端时间与服务端时间 | 成功 push 必须把服务端 canonical `updated_at` 写回 store、IndexedDB 和队列基线 |
| 任一游标早于 merge/持久化提交 | 一次 merge 失败导致后续增量永久漏拉 | 全仓 cursor registry；游标只在 store merge + IndexedDB persist 成功后 commit；禁止本地 `new Date()` 作为远端水位 |
| timestamp-only cursor 漏同时间戳行 | 批量写入/分页中断后同 `updated_at` 未处理行被 `>` 查询跳过 | 组合 cursor `(updated_at,id)` 或强制回看窗口 + 去重 + tombstone 优先 |
| 队列跨实体重放无契约 | 删除后旧 attachment/connection/focus recording 写入成功，产生孤儿数据 | `operation_id`、同实体保序、跨实体依赖、delete/tombstone barrier 和 cleanup 测试 |
| 多标签同时 flush 同一队列 | 重复 cloud push、游标竞争、旧写覆盖新写 | Web Locks single-writer；降级 IndexedDB lease + TTL + heartbeat；非 owner 只能通知/等待 |
| 多个生产 origin 同时可写 | apex/`www`/`app`/`pages.dev` 各自持有 IndexedDB、SW 和队列，数据分叉 | Canonical Origin Gate；非 canonical origin redirect/read-only/export-only，禁止 SW/Supabase/队列 flush |
| Canonical Origin Gate 执行太晚 | 非 canonical origin 已注册 SW、初始化 Supabase 或 flush 离线队列 | gate 位于 `<head>` 最前同步 inline script；旧 origin/`ngswHash` mismatch/`forceSwReset` 只允许一次 SW unregister + app cache/`ngsw:*` delete |
| 同域 DNS 分裂脑 | 同一 custom domain 在 TTL 收敛期命中 Vercel/Cloudflare 两个不同前端版本 | DNS 前两边部署同一份 `dist/browser`，用 `/version.json`/入口 chunk/`ngsw.json` 比对一致 |
| `pages.dev` 留作第二生产 origin | custom domain 与 Pages 默认域同时写生产 Supabase，OAuth/PWA/Sentry 排障分叉 | custom smoke 通过后移除 Supabase Auth/CORS/Storage 写入能力，或 redirect/read-only |
| 旧 Vercel / 新 Cloudflare 双写生产 Supabase | 两个 origin 的离线队列互相覆盖，出现幽灵任务 | 割接前部署 export-only/read-only 旧站，阻断写入 UI、队列 flush、cloud push；只有主动回滚才恢复写入 |
| client-side origin gate 被旧 SW/旧 HTML 绕过 | 旧 origin 仍可能 flush 队列，产生 ghost write | mutation 走 RPC/CAS，服务端校验 `operation_id`、`syncProtocolVersion`、`deploymentEpoch`、tombstone barrier；旧写返回 `ghost_write_rejected` |
| HSTS 混入首版 `_headers` | TLS/DNS 还未稳定时浏览器锁定 HTTPS，回滚复杂 | 首版不启用；仅在 Cloudflare TLS 和所有相关子域稳定满 `HSTS_STABILIZATION_WINDOW` 后单独 PR 启用 |
| `NG_APP_*_V1/V2` Boot Flag 默认值偏离当前生产 | 启动行为意外变化 | 阶段 0 导出 Vercel env 全集对照默认值 |
| PR preview 缺少 preview Supabase secrets 时静默回退生产 | 真实数据被 preview smoke 写入 | `Select Supabase build env` step fail-fast；生产 opt-in 还必须 READ_ONLY_PREVIEW、RLS/RPC 隔离和自动清理 |
| PR preview 可写生产 Supabase | preview URL 成为公开生产入口 | 默认强制独立 Preview Supabase；生产 opt-in 必须 READ_ONLY_PREVIEW、RLS/RPC 隔离和自动清理 |
| preview 被搜索引擎收录 | branch alias 被外部用户当入口 | preview 专用 `X-Robots-Tag: noindex` 或 meta noindex；production 不带该头 |
| Supabase Auth redirect / Email Template 漏审 | password reset、Magic Link、OAuth 把用户带回旧域或非 canonical origin | grep `redirectTo/location.origin`，生产用 canonical helper；Dashboard 审查 Email Templates |
| Storage signed URL 被 SW 长缓存 | logout 后同浏览器 profile 仍能读取私有附件/录音 | `maxAge` 不超过签名有效期；私有文件优先不用 Angular SW dataGroups，logout 清理 cache/附件视图 |
| Angular SW dataGroups 的跨域响应变成 opaque/401/403 | Service Worker 缓存不可验证的第三方或私有响应，导致字体/附件异常和隐私残留 | SW-controlled Playwright smoke 验证 Supabase Storage、Google Fonts、jsdelivr 的 `response.type`、状态码和缓存结果；私有资源不缓存 opaque/401/403 |
| Sentry environment 未区分 preview/production | 告警噪声、采样失真 | 阶段 1 内补 `scripts/set-env.cjs`、`scripts/ensure-env-files.cjs`、`src/environments/*` 与 `SentryLazyLoaderService` |
| Sentry/Cloudflare token 暴露给 build/test | 同仓 PR 修改构建脚本读取发布 token | Sentry token 仅在 upload step，Cloudflare token 仅在 deploy step；build/test 只暴露 `NG_APP_*` |
| deploy workflow 复杂度失控 | 个人项目后续升级 Angular/Wrangler/Node 时 CI 脆弱且难复现 | 新增不读部署 secret 的 dry-run workflow；复杂逻辑下沉到 `scripts/ci` / `scripts/smoke`，YAML 只编排 |
| `NG_APP_*` flag 清单漂移 | 新增 flag 只改 Secrets 或 workflow，未进入 environment shape / docs / set-env，导致 preview/prod 行为不一致 | `npm run quality:guard:env-flags` 比对 `set-env.cjs`、`src/environments/*`、workflow env 和文档快照 |
| `_headers` 与 `inject-modulepreload` Link 重复 | Early Hints 体积膨胀，且可能提前拉取错误 chunk | 首版不在 `_headers` 写 chunk preload，并用 `! Link` 关闭自动 Link；后续重启 Early Hints 时逐一验证 103 Link 指向 |
| `assetlinks.json` 只校验 package name | Android dev/release/Play Signing 某渠道 TWA 验证失败 | 用 `ANDROID_TWA_EXPECTED_SHA256_CERT_FINGERPRINTS` 校验全部 fingerprint |
| `assetlinks.json` 长缓存 | Play Signing 或证书配置调整后 TWA 验证继续拿旧 fingerprint | `/.well-known/assetlinks.json` no-store 或短 revalidate；header smoke 单独检查 |
| post-deploy smoke 过早硬编码 custom domain | DNS/TLS 未 active 被误判为部署失败 | 先 smoke `https://<project>.pages.dev`；custom domain active 后再跑第二套 smoke |
| full DNS 记录漏迁 | app 成功但邮件、证书签发、第三方验证失败 | 旧 zone 全量导出，与 Cloudflare 导入结果 diff A/AAAA/CNAME/MX/TXT/CAA/NS/DS/SRV |
| Cloudflare zone 规则覆盖 Pages 行为 | `_headers` 正确但被 Cache Rules/Transform/Challenge 改写 | 阶段 0 inventory app host 命中规则，禁止 Cache Everything、HTML Edge TTL、改写和全站 Challenge |
| 关键路径被 Cloudflare edge 缓存 | `index.html` / `ngsw.json` / SW 脚本被 `CF-Cache-Status: HIT` 服务，PWA version skew 全局扩散 | header smoke 记录 `CF-Cache-Status`、`Age`、`CF-Ray`；freshness 关键路径禁止 `HIT + Age>0` |
| 只检查仓库 `_headers`，未检查线上真实响应 | zone 规则或平台行为覆盖后 CI 仍通过 | deploy 后对 `pages.dev` 与 custom domain 跑真实 `curl -I` header smoke，检查 cache、MIME、Link 和 missing asset |
| 缺失静态资源被 SPA fallback 吞掉 | `/chunk-deadbeef.js` 返回 HTML 200，旧 HTML 加载新部署时白屏 | smoke 负向请求缺失 JS/CSS/asset；若 Pages 默认 SPA fallback 返回 HTML 200，必须验证 GlobalErrorHandler chunk 自愈合同并用 Playwright 证明 ChunkLoadError 能恢复 |
| 缺少部署版本可观测性 | 无法判断用户命中 Vercel、Cloudflare、旧 SW 还是新部署 | 生成 no-store `/version.json`，Sentry/Cloudflare/GitHub 对齐 git SHA、ngsw hash、environment |
| `widget-black-box-action` 被误认为复用 `_shared/widget-common.ts` | CORS 漏改，黑匣子 widget action 在新域名失败 | 单独列入 CORS inventory，必要时独立改源码和测试 |
| GoJS 大图主线程阻塞 | 复杂 Flow 掉帧或页面无响应 | 200/500/1000 节点分级门禁；超阈值默认降级，布局预计算迁往 Worker 或分片调度 |
| Cloudflare 边缘差异放大 GoJS 首开成本 | 某些地区/弱网 chunk load 与布局更慢，本地或单一区域 smoke 通过但用户掉帧 | preview/custom domain 跑弱网/移动 profile；可用远程浏览器时补亚洲/欧洲 TTFB、chunk load 和 Flow 首开采样 |
| GoJS 异步布局旧结果晚到 | 用户编辑后的新坐标被旧 generation 覆盖 | 布局任务带 generation/graphRevision/input hash；新任务取消或废弃旧任务，写回前二次校验 |
| GoJS 反复打开/销毁泄漏 | 长会话内存升高、后台 listener 继续写状态 | 10 次打开/销毁 smoke 检查 Diagram/listener/timer/heap 趋势 |
| OnPush / GoJS 桥接漏测 | 图形库内部状态改变后 Angular UI 不刷新 | 高频事件留 zone 外，状态事件显式 bridge；smoke 覆盖选择、拖拽、连线、主题、销毁 |
| 新域名首开像“数据丢失” | 用户看到空工作区，不知道应等待云端恢复、导出旧站或重新安装 PWA | 新 canonical origin 首次启动显示迁移欢迎/恢复状态页，展示云端恢复、队列同步、旧 origin 导出和 PWA 刷新/重装提示 |
| Fork PR 因缺少 secrets 执行 `validate-env:prod` 失败 | 外部 PR 无法通过基础 CI | workflow 拆分 test 与 build-deploy；fork PR 只跑不依赖 secrets 的 test job |
| Android TWA 默认 origin 仍指向 Vercel | release 构建或本地验证误连旧站 | 更新 `android/app/build.gradle.kts` 默认值或强制 release 构建传 `NANOFLOW_WEB_ORIGIN` |
| Sentry CLI latest 漂移 | sourcemap inject/upload 行为变化 | 固定 `@sentry/cli` 版本或加入 devDependency 由 lockfile 管理 |
| 把 Pages 当成永久目标态 | 未来需要 Durable Objects、Queues、Rate Limiting、Workers Observability 或更细路由时被迫二次迁移 | 阶段 0 评估 Workers Static Assets；阶段 4 后 6 个月内跑 non-production dry-run，保留 `assets.directory`、`binding`、`not_found_handling`、`run_worker_first` 决策记录 |

---

## 17. 官方资料

- Vercel Builds：<https://vercel.com/docs/deployments/builds/>
- Vercel Managing Builds：<https://vercel.com/docs/builds/managing-builds>
- Vercel Ignored Build Step：<https://vercel.com/kb/guide/how-do-i-use-the-ignored-build-step-field-on-vercel>
- Vercel CLI `vercel build`：<https://vercel.com/docs/cli/build>
- Vercel Deployments：<https://vercel.com/docs/deployments>
- Cloudflare Pages Direct Upload：<https://developers.cloudflare.com/pages/get-started/direct-upload/>
- Cloudflare Pages Direct Upload with CI：<https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/>
- Cloudflare Wrangler Pages commands：<https://developers.cloudflare.com/workers/wrangler/commands/pages/>
- Cloudflare Workers Static Assets：<https://developers.cloudflare.com/workers/static-assets/>
- Cloudflare Workers Static Assets Configuration and Bindings：<https://developers.cloudflare.com/workers/static-assets/binding/>
- Cloudflare Workers Static Assets SPA routing：<https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/>
- Cloudflare Workers Static Assets migrate from Pages：<https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/>
- Cloudflare Pages Git integration：<https://developers.cloudflare.com/pages/get-started/git-integration/>
- Cloudflare Pages Git integration configuration：<https://developers.cloudflare.com/pages/configuration/git-integration/>
- Cloudflare Pages Variables and Secrets：<https://developers.cloudflare.com/pages/functions/bindings/>
- Cloudflare Pages Angular 指南：<https://developers.cloudflare.com/pages/framework-guides/deploy-an-angular-site/>
- Cloudflare Pages Headers：<https://developers.cloudflare.com/pages/configuration/headers/>
- Cloudflare Pages Redirects：<https://developers.cloudflare.com/pages/configuration/redirects/>
- Cloudflare Pages Serving Pages / SPA behavior：<https://developers.cloudflare.com/pages/configuration/serving-pages/>
- Cloudflare Pages Custom Domains：<https://developers.cloudflare.com/pages/configuration/custom-domains/>
- Cloudflare Pages Limits：<https://developers.cloudflare.com/pages/platform/limits/>
- Cloudflare Pages Rollbacks：<https://developers.cloudflare.com/pages/configuration/rollbacks/>
- Cloudflare Pages Early Hints：<https://developers.cloudflare.com/pages/configuration/early-hints/>
- Cloudflare Cache default behavior：<https://developers.cloudflare.com/cache/concepts/default-cache-behavior/>
- Cloudflare Origin Cache Control：<https://developers.cloudflare.com/cache/concepts/cache-control/>
- Cloudflare Cache Rules settings：<https://developers.cloudflare.com/cache/how-to/cache-rules/settings/>
- Cloudflare cache responses / CF-Cache-Status：<https://developers.cloudflare.com/cache/concepts/cache-responses/>
- Cloudflare Edge and Browser Cache TTL：<https://developers.cloudflare.com/cache/how-to/edge-browser-cache-ttl/>
- Cloudflare Rocket Loader：<https://developers.cloudflare.com/speed/optimization/content/rocket-loader/>
- Cloudflare Content Compression：<https://developers.cloudflare.com/speed/optimization/content/compression/>
- Cloudflare DNSSEC：<https://developers.cloudflare.com/dns/dnssec/>
- Cloudflare DNS record types：<https://developers.cloudflare.com/dns/manage-dns-records/reference/dns-record-types/>
- Cloudflare stale DS troubleshooting：<https://developers.cloudflare.com/dns/zone-setups/troubleshooting/pending-nameservers/>
- Supabase Auth Redirect URLs：<https://supabase.com/docs/guides/auth/redirect-urls>
- Supabase Auth Email Templates：<https://supabase.com/docs/guides/auth/auth-email-templates>
- Supabase Realtime：<https://supabase.com/docs/guides/realtime>
- Supabase Realtime heartbeat：<https://supabase.com/docs/guides/troubleshooting/realtime-heartbeat-messages>
- Supabase Realtime silent disconnections：<https://supabase.com/docs/guides/troubleshooting/realtime-handling-silent-disconnections-in-backgrounded-applications-592794>
- Supabase JavaScript upsert：<https://supabase.com/docs/reference/javascript/upsert>
- Angular Service Workers：<https://angular.dev/ecosystem/service-workers>
- Angular NgZone：<https://angular.dev/api/core/NgZone>
- Angular Workspace Configuration / Source Maps：<https://angular.dev/reference/configs/workspace-config>
- MDN Web Locks API：<https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API>
- MDN PerformanceLongTaskTiming：<https://developer.mozilla.org/en-US/docs/Web/API/PerformanceLongTaskTiming>
- MDN AbortController：<https://developer.mozilla.org/en-US/docs/Web/API/AbortController>
- Sentry Source Maps Uploading with CLI：<https://docs.sentry.io/platforms/javascript/sourcemaps/uploading/cli/>
- Sentry Source Map troubleshooting：<https://docs.sentry.io/platforms/javascript/sourcemaps/troubleshooting_js/>
