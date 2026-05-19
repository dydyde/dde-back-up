# NanoFlow 私有实例部署指南

> 本指南帮助你在 5 分钟内部署一个完全属于自己的 NanoFlow 实例，数据完全在你的掌控中。

---

## 前置准备

### 1. 创建 Supabase 项目

1. 打开 [supabase.com](https://supabase.com)，用 GitHub 登录
2. 点击「New project」，填写项目名称，选择靠近你的区域
3. 等待项目初始化完成（约 2 分钟）

### 2. 创建 Storage 存储桶

1. 左侧菜单 → Storage → New bucket
2. 名称填 `attachments`，**不要**勾选 Public bucket
3. 点击 Create bucket

### 3. 执行数据库初始化脚本

1. 左侧菜单 → SQL Editor → New query
2. 打开本仓库 [`scripts/init-supabase.sql`](../scripts/init-supabase.sql)，复制全部内容
3. 粘贴到 SQL Editor，点击 Run
4. 看到 ✅ Success 即可

> 脚本会自动创建所有表、RLS 策略、RPC 函数和存储策略，无需手动干预。

### 4. 获取 API 密钥

1. 左侧菜单 → Project Settings → API
2. 复制 **Project URL** 和 **anon public** key
3. ⚠️ 注意：只用 `anon public`，不要用 `service_role`！

---

## 部署到 Cloudflare Pages（推荐）

NanoFlow 当前推荐使用 Cloudflare Pages Direct Upload：GitHub Actions 负责构建、测试、产物门禁和 Wrangler 上传，Cloudflare Pages 只负责静态资源分发。

推荐路径：

1. 在 Cloudflare Pages 创建 Direct Upload 项目，例如 `nanoflow`。
2. 在 GitHub Actions Secrets 写入：
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
   - `CLOUDFLARE_PAGES_PROJECT_NAME`
   - `NG_APP_SUPABASE_URL`
   - `NG_APP_SUPABASE_ANON_KEY`
3. 需要预览环境时，在 GitHub Environment `NanoFlow-Preview` 写入同名 Supabase preview secrets。
4. 合并到 `main` 后由 [.github/workflows/deploy-cloudflare-pages.yml](../.github/workflows/deploy-cloudflare-pages.yml) 部署 `dist/browser`。

完整迁移门禁、缓存头、PWA、Supabase Auth / CORS 和回滚策略见：[cloudflare-migration-plan.md](cloudflare-migration-plan.md)。

---

## 部署到 Vercel（备选）

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fdydyde%2Fdde&env=NG_APP_SUPABASE_URL,NG_APP_SUPABASE_ANON_KEY&project-name=my-nanoflow&repository-name=my-nanoflow)

### 环境变量配置

在 Vercel → Settings → Environment Variables 添加：

| 变量名 | 必需 | 说明 |
|--------|------|------|
| `NG_APP_SUPABASE_URL` | ✅ | Supabase Project URL |
| `NG_APP_SUPABASE_ANON_KEY` | ✅ | Supabase anon public key |
| `NG_APP_SENTRY_DSN` | 可选 | Sentry 错误监控 DSN |
| `NG_APP_GOJS_LICENSE_KEY` | 可选 | GoJS 许可证（移除水印） |

保存后回到 Deployments → 重新部署（Redeploy）。

> ⚠️ 构建时会执行 `npm run config`，它会读取这些变量并生成环境文件。

---

## 部署到 Netlify

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/dydyde/dde)

部署后在 Site Settings → Environment variables 添加：
- `NG_APP_SUPABASE_URL`
- `NG_APP_SUPABASE_ANON_KEY`

---

## 部署到 Railway

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/github?repo=https://github.com/dydyde/dde)

部署后在 Variables 中添加：
- `NG_APP_SUPABASE_URL`
- `NG_APP_SUPABASE_ANON_KEY`

---

## 可选：部署语音转写 Edge Function

如果你需要专注模式的语音转写功能：

```bash
# 安装 Supabase CLI（如未安装）
npm install -g supabase

# 登录并关联项目
supabase login
supabase link --project-ref <your-project-ref>

# 设置 Groq API Key（从 console.groq.com 获取免费 Key）
supabase secrets set GROQ_API_KEY=gsk_your_actual_key_here

# 部署转写函数
supabase functions deploy transcribe

# 验证部署
supabase functions list  # 应看到 'transcribe'
```

### 验证转写功能

```bash
# 方法 1: 使用验证脚本
chmod +x scripts/verify-transcribe-setup.sh
./scripts/verify-transcribe-setup.sh
```

---

## 可选：启用定时清理

系统自动清理 30 天前删除的任务和过期日志：

1. Supabase 控制台 → Database → Extensions → 搜索 `pg_cron` → 启用
2. SQL Editor 执行：

```sql
SELECT cron.schedule('cleanup-deleted-tasks', '0 3 * * *', $$SELECT cleanup_old_deleted_tasks()$$);
SELECT cron.schedule('cleanup-deleted-connections', '0 3 * * *', $$SELECT cleanup_old_deleted_connections()$$);
SELECT cron.schedule('cleanup-old-logs', '0 4 * * 0', $$SELECT cleanup_old_logs()$$);
SELECT cron.schedule('cleanup-expired-scan-records', '0 5 * * 0', $$SELECT cleanup_expired_scan_records()$$);
```

---

## 故障排查指南

### 部署后白屏

**原因**：环境变量未配置或构建缓存。

**解决**：
1. 确认环境变量已正确设置（检查是否有多余空格）
2. 在 Vercel/Netlify 触发重新部署（Redeploy）
3. 检查浏览器控制台是否有 Supabase 连接错误

### 登录后无数据

**原因**：数据库初始化脚本未执行或 RLS 配置不正确。

**解决**：
1. 确认已执行 `scripts/init-supabase.sql`
2. 在 Supabase → SQL Editor 执行以下检查：
   ```sql
   SELECT tablename FROM pg_tables WHERE schemaname = 'public';
   ```
   应看到 `projects`、`tasks`、`connections` 等表
3. 检查 RLS 是否启用：
   ```sql
   SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public' AND rowsecurity = true;
   ```

### 语音转写返回 401

**原因**：Groq API Key 未设置或已过期。

**解决**：
1. 检查 Edge Function 是否部署：`supabase functions list`
2. 检查密钥是否设置：`supabase secrets list`
3. 重新设置密钥：`supabase secrets set GROQ_API_KEY=gsk_your_new_key`
4. 详见 [转写故障排查](../TRANSCRIBE-TROUBLESHOOTING.md)

### 附件上传失败

**原因**：Storage 存储桶未创建或策略未配置。

**解决**：
1. 确认 `attachments` 存储桶存在（Supabase → Storage）
2. 确认存储桶为私有（非 Public）
3. `init-supabase.sql` 已包含所有 Storage 策略，确保该脚本已执行成功

### 构建失败

**原因**：Node.js 版本不兼容或内存不足。

**解决**：
1. 确保 Node.js >= 18.19.0
2. Vercel 默认 Node.js 版本可在 Settings → General → Node.js Version 设置
3. 如果内存不足，检查构建日志中是否有 `heap out of memory` 错误

---

## 数据安全建议

1. **永远不要**将 `service_role` 密钥暴露给前端
2. 定期在 Supabase 控制台检查 RLS 是否正常启用
3. 建议开启 Supabase 的自动数据库备份（Pro 计划）
4. 管理你的 secrets：`supabase secrets list`，定期轮换 API Key
