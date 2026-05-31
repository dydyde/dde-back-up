# NanoFlow 数据库坚固与灾难恢复策划案（P0 二次复发后红线版）

> **版本**: 1.3.1
> **日期**: 2026-05-31
> **状态**: P0 数据库加固已落地（取证审计层、无时间戳既有行拒写、冻结开关、隔离表、审计归因、RLS 自动启用、advisor follow-up、逻辑备份 workflow 与 PR 门禁已实现）
> **触发事件**: 2026-05 二次复发 P0 —— 生产任务结构被整行覆盖，用户看到所有项目只剩 3 个待分配块
> **关联线上库**: Supabase `fkhihclpghmmtbbywvoj`（wgje's Project, ap-south-1, pg 17.6.x）
> **参考来源**: context7 / Supabase 官方文档（PITR、备份列表与恢复 API、pgaudit、RLS/自动启用 RLS、SECURITY DEFINER、Vault 密钥隔离、`set_config`/`current_setting` 会话 GUC、`revoke execute`、pg_cron/pg_partman 保留、数据库分支、生产迁移、CI 备份、软删除）

> **v1.2.0 变更要点（针对评审反馈的深度修订）**：
> 1. **恢复 SQL 时间窗口纠偏**（§5 级别 A/B）：从错误的 `changed_at < INCIDENT_TS` 改为「围绕事故窗口取第一批事故写入前像」，并提供 `operation_id`/`audit_id`/`client_git_sha` 精准定位法。
> 2. **备份数据落点降爆炸半径**（§4）：禁止把明文 `data.sql` 自动 commit 到私有仓库，改为加密对象存储 + 独立 backup vault + 短保留 + 密钥轮换 + 临时恢复环境。
> 3. **冻结开关权限模型补全**（§2.1.1）：`data_safety_flags` 增加 `CHECK`、RLS+客户端 `revoke`、`updated_by`、自审计、仅 service/admin role 可改。
> 4. **FORCE RLS 与审计写路径兼容验证**（§2.4 / §3.1）：明确函数 owner 权限、INSERT policy、实测写路径。
> 5. **隔离表取证强化**（§3.4）：RLS/只读、`payload_digest`、`operation_id` 幂等、保留期、review 审计。
> 6. **冻结开关上线前的临时止血路径**（§5.0）：撤销 RPC 执行权限 / 临时 RLS / 停用部署入口 / 轮换 anon key。
> 7. **SLO 改为带前置条件**（§0.2）、**来源归因补 PostgreSQL 实施细节**（§3.3）、**不可恢复声明改为证据倾向措辞**（§8）、**Do-Not-Merge 门禁落到执行机制**（§6.1）。
>
> **v1.3.0 落地要点（2026-05-31）**：
> - 新增 migration `20260531120000_database_hardening_dr_controls.sql`：`data_safety_flags.sync_mode`、`data_safety_flag_audit`、`sync_write_quarantine`、`sync_trusted_client_deployments`、审计 `suspicious/source` 字段、`sync_operation_log.payload_digest` 与 `sync_upsert_task` 冻结/隔离/归因链路。
> - `batch_upsert_tasks` 增加冻结读取与 `task_text_update` / `task_structure_update` / `task_soft_delete` 过渡型字段意图，避免继续扩大整行 LWW 风险。
> - 新增 `.github/CODEOWNERS`、`.github/workflows/database-hardening-gates.yml`、`.github/workflows/supabase-logical-backup.yml`，把门禁与加密逻辑备份从文档要求变成仓库配置。
>
> **v1.3.1 复核补丁（2026-05-31）**：
> - 新增 migration `20260531123000_advisor_followup_rls_and_function_exposure.sql`：收敛 Supabase security advisor 中的 anon SECURITY DEFINER 暴露、service-only 表缺显式 RLS policy、以及 `user_preferences_keep_latest_backup_proof()` mutable `search_path`。
> - 新增 migration `20260531124000_advisor_followup_index_cleanup.sql`：移除归档表重复后缀索引；最终 Supabase advisor 仅剩 authenticated SECURITY DEFINER 需逐项业务判定、Auth 泄露密码保护需 Dashboard 开启、以及新索引未使用/legacy retired 表无主键等 INFO 项。
> - 新增 migration `20260531125000_quarantine_digest_and_audit_origin_hardening.sql`：隔离 digest 排除每次重试都会变化的 `operation_id`，并让无 RPC GUC 来源归因的审计行默认 `origin_unverified=true`。
> - 新增 migration `20260531130000_quarantine_missing_timestamp_capture.sql`：`sync_mode=quarantine` 时，既有任务缺少本地时间戳的高风险 payload 也会进入 `sync_write_quarantine`，同时保持拒写。

---

## 0. 文档目的

本案聚焦"**整行 LWW 覆盖导致结构字段被冲掉**"这一类事故，给出：

1. **预防层**：让同类覆盖在数据库层面无法发生。
2. **取证层**：事故发生后能从数据库直接佐证"被覆盖前的值"。
3. **恢复层**：分级的紧急恢复手册（从单字段回滚到全库 PITR）。
4. **演练与门禁**：把上述能力纳入可重复执行的流程。

> 仅当能从数据库（而非客户端记忆）证明"原值"时，恢复才是可信的。本案的核心方法论：
> **不要用"版本计数 / 无子节点"这类不可证伪的弱推断去判定"本就扁平、不可恢复"**——这正是本次残留误判与用户不信任的根源。
> 正确做法是用**可证伪信号**（§5.6）逐项判定每个 `stage=null` 块到底是「被覆盖的根」还是「本就合法的扁平/新建任务」：
> 1. `stage=null` 却仍被子节点 `parent_id` 引用 → **确定被覆盖**，可用子节点反推恢复（最强信号）。
> 2. 软删除区存在同 id/title 的带 stage 旧版本 → **直接回填**（最高可信）。
> 3. 无子节点、无软删、无审计前像 → 数据库无 ground truth，**禁止捏造 stage**，回到用户确认。
>
> 因此 `饭菜佳肴`/`编程` 是否可恢复，**必须先跑完 §5.6 的可证伪诊断再下结论**，不能仅凭版本计数判死。取证层（§3）确保**此后**同类事故必可恢复。

### 0.1 二次 P0 后的红线判断

这已经不是单点 bug，而是**用户数据安全事件**。后续所有涉及 `tasks`、同步 RPC、离线缓存、水合、迁移、备份的改动，默认按数据安全变更处理。

**不可再突破的红线**：

1. **预览数据不可入库**：任何 snapshot / recent / preview / cache 摘要对象不得被 materialize 成可同步实体。
2. **结构字段不可弱写**：`stage`、`parent_id`、`content`、`deleted_at` 属于高价值字段；既有行更新必须携带 freshness marker、来源信息、并留下前像。
3. **无证据不恢复**：任何恢复必须来自 `task_change_audit`、逻辑备份、PITR、或可验证导出；禁止靠记忆补写。
4. **生产迁移先验证**：涉及同步/数据结构的迁移必须先在分支/影子库验证，并准备回滚或恢复路径。
5. **备份必须可恢复**：没有演练过的备份等同于没有备份；每月必须从备份恢复到新库并做业务校验。
6. **P0 发现即冻结写入**：一旦出现跨项目结构异常，先进入 sync read-only / quarantine 模式，保护证据链，再决定恢复。

### 0.2 数据安全目标（SLO）

> **重要前提**：下表的 RPO/RTO **不是无条件承诺，而是「在前置条件全部满足时」的目标**。任何一个前置条件失效（审计触发器被绕过、备份不可恢复、恢复脚本错误、事故窗口判断错误），实际 RPO/RTO 都会显著劣化。SLO 是工程目标，不是对用户的法律承诺。

**SLO 成立的全局前置条件（必须同时满足）**：

- **P1 审计已上线且健康**：`task_change_audit` 触发器存在、未被 disable、写路径已实测（§3.1 / §2.4）。
- **P2 无 bypass 写路径**：没有任何直接 `UPDATE tasks` 绕过 RPC/触发器的链路（含 service_role 脚本误用）。
- **P3 备份可恢复**：最近一次月度演练成功从备份还原到临时环境并通过业务校验（§4.2）。
- **P4 恢复脚本正确**：级别 A/B 恢复 SQL 已在影子库季度演练验证（§6）。
- **P5 事故窗口准确**：能从 `gitSha`/`deployment_epoch`/`client_origin` 精确圈定 `[incident_start, incident_end]`（§5.0）。

| 场景 | RPO 目标（前置条件满足时） | RTO 目标 | 首选恢复路径 | 关键依赖 |
|------|----------|----------|--------------|----------|
| 单任务结构字段被覆盖 | 0 条关键字段丢失 | 15 分钟 | 审计前像回滚 | P1+P4+P5 |
| 单项目批量覆盖 | 0 条关键字段丢失 | 30 分钟 | 项目级审计前像回滚 | P1+P4+P5 |
| 跨项目批量覆盖 | 0 到 5 分钟 | 60 分钟 | 写入冻结 → 审计回滚；必要时 PITR | P1+P2+P3+P5 |
| schema/迁移破坏 | 最近一次逻辑备份或 PITR 时间点 | 2 小时 | 分支库验证 → PITR / 逻辑备份导入 | P3 |
| 审计上线前历史损坏 | 不承诺恢复 | 以人工修复为准 | 仅能基于现有 DB 证据判断 | —— |

> 若任一前置条件在事故时不成立，必须在 runbook 中**立即降级 SLO 承诺**，按「尽力恢复 + 透明告知不可恢复窗口」处理，而不是对外维持 0 丢失的表面承诺。

---

## 1. 事故根因回顾（已证实）

| 环节 | 事实 |
|------|------|
| 1. 预览物化 | 旧客户端把 `launch-snapshot.recentTasks`（仅 id/title/displayId/status 的预览摘要）物化成真实 Task：`stage=null`、`parent_id=null`、`content=title`、缺 `updated_at`。 |
| 2. 水合短路 | `hydrateProjectIfNeeded` 见 `tasks.length>0`（假任务）→ 标记 `hydratedProjectIds` → **跳过云端全量水合** → 刷新仍走同路径（"刷新无效"）。 |
| 3. 整行回灌 | 启动同步把这 3 个假任务经 `sync_upsert_task → batch_upsert_tasks` 推送；2026-05 的 LWW 恢复移除了 CAS、接受无时间戳的既有行写入 → **整行覆盖**真实根的 `stage/parent_id/content`，把分层根降级为待分配块。 |
| 4. 取证缺失 | `sync_operation_log.result_payload` 只存 `task_id/updated_at`，**无任何字段前像** → 无法证明覆盖前的 stage。 |

**已落地的两道修复（本案前序工作）**：

- 前端（commit `95bc5de`，已部署）：`buildPrehydrateProjects()` 不再物化 `recentTasks`，返回 `tasks: []`。
- 数据库护栏（migration `20260531063500`，已上线）：`sync_upsert_task` 在"既有行 + payload 无本地时间戳"时返回 `remote-newer / missing_task_timestamp`，**拒绝写入**。
- 取证审计（migration `20260531070000`，已上线）：见 §3.1。

---

## 2. 预防层（让覆盖无法发生）

预防层必须按"客户端不能犯错、RPC 不能放过、数据库不能沉默"三层设计。P0 已发生两次，不能再把数据安全只交给前端约定。

### 2.1 写入前像护栏（已上线，持续保留）

`sync_upsert_task` 既有行写入必须携带可信本地时间戳，否则拒绝。**禁止**任何"无时间戳整行覆盖"。
未来对该 RPC 的任何改动必须保留此护栏（纳入 §6 合同测试）。

### 2.1.1 三重写入栅栏（建议落地）

| 层 | 目标 | 机制 |
|----|------|------|
| 客户端 | 不产生危险 payload | snapshot / preview 类型不可转换为 `Task`；sync payload 必须显式带 `updatedAt`、`content`、`stage` 来源。 |
| RPC | 拒绝危险 payload | 既有行 + 缺 freshness marker 拒写；缺 `content` 时保留旧值；协议版本/部署 epoch 不匹配拒写。 |
| 触发器 | 数据库兜底记录与隔离 | 对 `old.stage IS NOT NULL -> new.stage IS NULL`、`content==title`、跨项目批量 null 化写入打可疑标记，达到阈值后进入 quarantine。 |

建议新增一个轻量全局开关表，用于事故时冻结写入而不需要改代码部署。**这是 P0 冻结的「核按钮」，因此权限模型必须先于功能本身设计好——谁能按、按了留不留痕、被盗 session 能否乱按，都要在建表时就锁死**：

```sql
-- 1. 建表：带值域 CHECK + 变更人 + 时间戳
CREATE TABLE IF NOT EXISTS public.data_safety_flags (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_by  UUID,                                   -- 记录变更人（auth.uid 或 service 标识）
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT data_safety_flags_sync_mode_chk CHECK (
    key <> 'sync_mode'
    OR value IN ('normal', 'audit_only', 'read_only', 'quarantine')
  )
);

-- 2. 种子：默认正常
INSERT INTO public.data_safety_flags(key, value)
VALUES ('sync_mode', 'normal')
ON CONFLICT (key) DO NOTHING;

-- 3. 权限收敛：客户端角色彻底无权读写，避免「核按钮」被前端/被盗 session 触碰
ALTER TABLE public.data_safety_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.data_safety_flags FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.data_safety_flags FROM anon, authenticated;
-- 读：允许 RPC 内部的 SECURITY DEFINER 函数 owner（postgres）读取；不开放任何客户端 SELECT policy。
-- 写：仅 service_role / 管理员通道，不通过 PostgREST 暴露。

-- 4. 仅允许后端受控 RPC 修改开关，并强制写审计
CREATE OR REPLACE FUNCTION public.set_data_safety_flag(p_key TEXT, p_value TEXT)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- 仅 service_role 可调用（见下方 revoke/grant）
  INSERT INTO public.data_safety_flags(key, value, updated_by, updated_at)
  VALUES (p_key, p_value, auth.uid(), now())
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value,
        updated_by = EXCLUDED.updated_by,
        updated_at = now();

  -- 自审计：开关变更本身必须留痕（专用审计表，禁止静默改核按钮）
  INSERT INTO public.data_safety_flag_audit(flag_key, new_value, changed_by, changed_at)
  VALUES (p_key, p_value, auth.uid(), now());
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_data_safety_flag(TEXT, TEXT) FROM anon, authenticated, public;
GRANT  EXECUTE ON FUNCTION public.set_data_safety_flag(TEXT, TEXT) TO service_role;

-- 5. 开关变更审计表（append-only，客户端不可读写）
CREATE TABLE IF NOT EXISTS public.data_safety_flag_audit (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  flag_key    TEXT NOT NULL,
  new_value   TEXT NOT NULL,
  changed_by  UUID,
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.data_safety_flag_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.data_safety_flag_audit FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.data_safety_flag_audit FROM anon, authenticated;
```

> 设计要点（针对「设计了核按钮却忘了写谁能按」的反馈）：
> - **值域闭合**：`CHECK` 限制 `sync_mode` 只能取 4 个合法值，杜绝脚本误写 `normal/read_only/quarantine` 之外的脏值。
> - **客户端零权限**：`anon/authenticated` 既不能 `SELECT` 也不能 `UPDATE`；被盗用户 session 无法把模式改回 `normal` 解除冻结。
> - **唯一改写入口**：只有 `service_role` 经 `set_data_safety_flag()` 能改，且每次修改强制进 `data_safety_flag_audit`。
> - **读取路径**：`sync_upsert_task`/`batch_upsert_tasks` 作为 SECURITY DEFINER 函数，以 owner 身份读 `data_safety_flags`，不依赖客户端 RLS。

`sync_upsert_task` / `batch_upsert_tasks` 在入口读取 `sync_mode`：

- `normal`：正常写入。
- `audit_only`：正常写入但强制记录审计与来源。
- `read_only`：拒绝所有客户端写入，仅允许服务端修复 SQL。
- `quarantine`：危险写进入隔离表，不更新 `tasks`。

### 2.2 关键字段不可被弱化（建议新增 CHECK / 触发器约束）

针对"结构/身份字段被预览物化清空"的根因，建议在数据库层加防御性约束：

```sql
-- 防止把已有正文的任务的 content 改成与 title 完全相同（物化签名）且 stage 被清空的"退化写"
-- 以"软告警 + 审计"为主，不直接 RAISE 阻断（避免误伤合法编辑）。
-- 落地形式：在 capture_task_change_audit 中对"stage NULL 化 + content==title"打标记字段 suspicious=true。
```

> 取舍：硬阻断容易误伤合法的"清空 stage / 改标题"。优先**记录可疑写**（审计 + 标记），由监控告警，而非阻断业务。

第二阶段再升级为"阈值阻断"：同一 `client_git_sha` / `client_origin` 在 5 分钟内触发超过 N 次可疑写，则自动切换 `sync_mode=quarantine`，并把后续 payload 写入隔离表等待人工审核。

### 2.3 乐观并发（version / updated_at 双重判定）

- `projects.version` 已存在 → 同步时校验 `version` 单调递增，拒绝回退写。
- `tasks.updated_at` 作为 LWW 关键字段，**只允许"服务端到达时间 + 客户端时间"双判定**，禁止纯客户端时间裸判。
- 对结构字段建议引入 `structure_version` 或 `structure_updated_at`，把"任务标题/正文轻编辑"与"树结构变更"分开判定，避免标题类 LWW 误伤结构。

### 2.3.1 字段级 LWW，而不是整行 LWW

本次事故证明：整行 LWW 可以接受在弱字段（例如标题）上，但不适合结构字段。

建议把任务同步拆成两个意图：

| 意图 | 允许字段 | 判定方式 |
|------|----------|----------|
| `task_text_update` | `title`、`content` | `content_updated_at` / 服务端到达时间 |
| `task_structure_update` | `stage`、`parent_id`、排序字段 | `structure_updated_at` + 结构前像审计 |
| `task_soft_delete` | `deleted_at` | tombstone LWW + 审计 |

这样即使旧客户端发送弱 payload，也无法覆盖结构字段。

### 2.4 RLS 与新表自动加固（context7：RLS 事件触发器）

为防止今后新建表漏配 RLS，建议部署官方 `rls_auto_enable` 事件触发器，对 `public` 新表自动启用 RLS：

```sql
CREATE OR REPLACE FUNCTION rls_auto_enable()
RETURNS EVENT_TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog AS $$
DECLARE cmd record;
BEGIN
  FOR cmd IN
    SELECT * FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE','CREATE TABLE AS','SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
    IF cmd.schema_name = 'public' THEN
      EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
    END IF;
  END LOOP;
END; $$;

DROP EVENT TRIGGER IF EXISTS ensure_rls;
CREATE EVENT TRIGGER ensure_rls ON ddl_command_end
WHEN TAG IN ('CREATE TABLE','CREATE TABLE AS','SELECT INTO')
EXECUTE FUNCTION rls_auto_enable();
```

对审计表、隔离表、备份索引表等安全敏感表，建议再加：

```sql
ALTER TABLE public.task_change_audit FORCE ROW LEVEL SECURITY;
```

> ⚠️ **FORCE RLS 与 SECURITY DEFINER 触发器的兼容性必须实测，否则会在最需要审计时把审计写入干掉**。`FORCE ROW LEVEL SECURITY` 会让表 owner 也走 RLS——而 `capture_task_change_audit()` 正是以 owner（`postgres`）身份 `INSERT` 审计行。两者共存的前置条件（部署前逐条核对）：

| 检查项 | 要求 | 验证方式 |
|--------|------|----------|
| 函数 owner 是否 `BYPASSRLS` | Supabase 上 `postgres` 角色默认具备 `BYPASSRLS`；若审计函数 owner 不是 `postgres`，FORCE RLS 后 INSERT 会被策略拦截 | `SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname = '<func_owner>';` |
| 是否存在 INSERT policy | 若 owner 不 `BYPASSRLS`，必须为审计/隔离表显式补 `FOR INSERT WITH CHECK (true)` 的内部写策略 | `SELECT * FROM pg_policies WHERE tablename = 'task_change_audit';` |
| 触发器写路径实测 | 改一条测试任务 stage，确认审计表落 1 行；再 `FORCE RLS` 后**重复同样测试**，确认仍落行 | 见 §6「审计有效性」演练 |
| `search_path` 固定 | `capture_task_change_audit()` 必须 `SET search_path = public, pg_temp`，避免 FORCE RLS 下解析到错误 schema | `\df+ capture_task_change_audit` |

> 结论：**在生产对 `task_change_audit` 执行 `FORCE ROW LEVEL SECURITY` 之前，必须先在分支/影子库跑通「FORCE 后审计仍写入」的回归**（纳入 §6 合同测试）。若 owner 不具备 `BYPASSRLS`，优先方案是「不 FORCE，仅 ENABLE RLS + 只读 SELECT policy + 客户端 revoke 写权限」，把 owner 写入留在 RLS 之外，避免误杀审计写路径。

### 2.5 生产迁移红线（context7：分支/预览库 + `db push`）

涉及同步、任务结构、RLS、触发器、RPC 的迁移必须走如下路径：

1. 在 Supabase 分支/影子库应用迁移。
2. 构造最小真实数据：有 stage 根、有子任务、有空 content、有软删、有离线重放 payload。
3. 执行危险 payload 回放：缺 `updated_at`、缺 `content`、`stage=null`、旧 `client_git_sha`。
4. 确认写入被拒绝或进入 quarantine。
5. 备份当前生产恢复点，再对生产执行 `supabase db push` 或 MCP migration。
6. 应用后立即运行结构分布审计 SQL（见 §5.5）。

---

## 3. 取证层（事故后能从数据库佐证）

### 3.1 结构化变更审计 `task_change_audit`（✅ 已上线）

Migration `20260531070000_task_change_audit_forensics.sql`，已 apply 至线上并验证（2 触发器 / RLS 开 / 1 只读策略 / 函数存在 / 安全顾问无新告警）。

| 能力 | 说明 |
|------|------|
| 捕获范围 | `tasks` 的 `stage/parent_id/content/title/deleted_at` 任一 `IS DISTINCT FROM` 变更，以及硬 `DELETE`。 |
| 前像内容 | 拆列前像（`old_stage/old_parent_id/old_content/old_title/old_updated_at/old_deleted_at`）+ **完整 `old_record JSONB`**，最大化恢复自由度。 |
| 写入方式 | `capture_task_change_audit()`（`SECURITY DEFINER`, `search_path=public,pg_temp`），绕过 RLS 由表属主写入。 |
| 权限 | RLS 开启，仅 `owner_id = auth.uid()` 可 `SELECT`；客户端无写权限。 |
| 体量控制 | 仅关键字段变化或删除才写入 → 普通拖拽/无关高频更新不产生噪声。 |

### 3.2 建议增强（规划）

1. **可疑写标记**：审计行增加 `suspicious BOOLEAN`，在 `content==title 且 new.stage IS NULL 且 old.stage IS NOT NULL` 时置 `true`，便于快速定位物化覆盖。
2. **来源归因（含 PostgreSQL 实施细节）**：把 `client_git_sha / client_origin / deployment_epoch` 透传进审计。**关键认知：客户端提交的来源只是「声明」，不是「证明」，服务器必须交叉验证**。

   实施路径：

   ```sql
   -- (a) RPC 入口用事务级 GUC 写入来源声明（local=true，事务结束自动清除，避免连接池串味）
   --     约定命名空间 app.* ，避免与系统 GUC 冲突。
   PERFORM set_config('app.client_git_sha',   coalesce(p_client_git_sha, ''),   true);
   PERFORM set_config('app.client_origin',    coalesce(p_client_origin, ''),    true);
   PERFORM set_config('app.deployment_epoch', coalesce(p_deployment_epoch, ''), true);

   -- (b) 触发器读取，缺省安全：current_setting(name, missing_ok => true) 不抛错
   v_git_sha := nullif(current_setting('app.client_git_sha', true), '');
   v_origin  := nullif(current_setting('app.client_origin', true), '');
   -- 读取失败/为空 → 记 NULL + suspicious_origin=true，绝不让审计因取不到来源而失败。
   ```

   **服务端交叉验证（杜绝旧客户端/攻击者随意伪造 sha）**：

   - 客户端声明的 `client_git_sha` 必须与服务端已知的「合法部署 epoch 集合」比对；不在集合内 → 标记 `origin_unverified=true`。
   - 结合 `/version.json` 的 `gitSha`、协议版本 fence（§7.2.1）、`deployment_epoch` 三者交叉；任一不一致即视为可疑来源，**归因结果只能当作证据倾向，不能当作权威身份**。
   - 真正可信的身份来自 `auth.uid()`（JWT 签名），来源 sha 仅用于「哪批客户端」的取证线索，不参与授权决策。

   > 反模式：把 `client_git_sha` 当作可信审计身份。攻击者或旧客户端想写什么 sha 就写什么 sha，未交叉验证的归因等于占卜。
3. **保留策略**：`task_change_audit` 按 `changed_at` 分区或定期归档（pg_cron 每月把 >180 天的行转入冷表或经 pg_partman 保留），避免无界增长。

### 3.3 证据链完整性要求

未来任何一次任务写入，都应该能回答 6 个问题：

| 问题 | 证据来源 |
|------|----------|
| 谁写的？ | `owner_id`、`auth.uid()`、RPC 安全上下文 |
| 哪个客户端写的？ | `client_git_sha`、`client_origin`、`deployment_epoch` |
| 写了什么？ | `sync_operation_log.payload_digest`（建议新增）+ `task_change_audit.old_record` |
| 写前是什么？ | `task_change_audit.old_record` |
| 为什么允许？ | RPC 返回 reason / guard decision（建议写入 `result_payload`） |
| 能否撤销？ | 审计前像 + 恢复 SQL + 备份/PITR 时间点 |

建议把 `sync_operation_log.result_payload` 从"只返回 task_id/updated_at"升级为：

```json
{
  "task_id": "...",
  "decision": "applied | rejected | quarantined | remote-newer",
  "reason": "fresh-local-update | missing_task_timestamp | suspicious_structure_degrade",
  "changed_fields": ["stage", "parent_id", "content"],
  "audit_id": 123,
  "server_updated_at": "2026-05-31T00:00:00Z"
}
```

### 3.4 Quarantine 隔离表（建议新增）

当 payload 被判定为危险但还需要保留证据时，不应直接丢弃。**隔离表会保存事故期间最敏感、最可疑、最有取证价值的数据，绝不能写成「以后再说」的 JSON 垃圾桶**——它从第一天就必须有权限收敛、脱敏边界、防重、保留期与 review 审计：

```sql
CREATE TABLE public.sync_write_quarantine (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operation_id    UUID NOT NULL,                       -- 来自客户端的幂等键
  user_id         UUID,
  entity_type     TEXT NOT NULL,
  entity_id       UUID,
  client_git_sha  TEXT,
  client_origin   TEXT,
  reason          TEXT NOT NULL,
  payload         JSONB NOT NULL,                       -- 完整危险 payload（取证用）
  payload_digest  TEXT NOT NULL,                        -- sha256(payload)，防重 + 完整性校验
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '30 days'), -- 短期保留
  reviewed_at     TIMESTAMPTZ,
  reviewed_by     UUID,
  review_decision TEXT CHECK (review_decision IS NULL OR review_decision IN ('replay','discard','escalate')),
  -- 防重放/防重写：同一 operation_id 只隔离一次，重复提交幂等吸收
  CONSTRAINT sync_write_quarantine_operation_uniq UNIQUE (operation_id),
  -- 二级防重：相同内容指纹去重，避免风暴期同一危险 payload 刷爆隔离表
  CONSTRAINT sync_write_quarantine_digest_uniq UNIQUE (payload_digest)
);

-- 取证索引：按用户/原因/时间快速分组排查
CREATE INDEX sync_write_quarantine_user_reason_idx
  ON public.sync_write_quarantine (user_id, reason, created_at DESC);

-- 权限收敛：客户端只读不可写，只读也仅限本人行
ALTER TABLE public.sync_write_quarantine ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_write_quarantine FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.sync_write_quarantine FROM anon, authenticated;
-- 写入只能由 SECURITY DEFINER 的隔离 RPC（owner BYPASSRLS）完成；
-- 如需让用户看到自己的隔离条目，仅补一条 FOR SELECT USING (user_id = auth.uid()) 策略，且脱敏后投影。

-- 保留期清理（pg_cron 每日）：到期未 review 的条目归档/删除，避免长期囤积敏感副本
-- SELECT cron.schedule('quarantine-gc', '0 3 * * *',
--   $$ DELETE FROM public.sync_write_quarantine WHERE expires_at < now() AND reviewed_at IS NULL $$);
```

> 设计要点（针对「JSON 垃圾桶」反馈）：
> - **RLS + 客户端零写权限**：隔离表只由服务端 RPC 以 owner 身份写入；`reviewed_by` 身份来自 `auth.uid()`/admin 通道，不接受客户端自报。
> - **幂等 + 防重**：`operation_id` 唯一约束保证同一离线操作只隔离一次；`payload_digest` 唯一约束在 P0 风暴期吸收重复污染。
> - **保留期 + 脱敏**：默认 30 天 `expires_at` + pg_cron GC；若要面向用户展示，必须脱敏投影（隐去 `content` 正文，仅留结构差异摘要）。
> - **可审计 review**：`review_decision` 用 `CHECK` 闭合枚举，`reviewed_at/reviewed_by` 记录处置链。

用途：P0 期间保护证据、阻断继续污染、允许人工确认后重放合法写入。

---

## 4. 备份层（多层冗余）

| 层级 | 机制 | 来源 / 状态 |
|------|------|------------|
| L1 物理 | **Supabase PITR**（按时间点恢复）。**需在项目设置中确认已启用**（Pro 计划）。 | context7：`POST /v1/projects/database/backups/restore-pitr` |
| L2 逻辑（每日） | GitHub Actions `supabase db dump`（roles/schema/data 三件套）→ **加密后上传到独立 backup vault / 加密对象存储**，**禁止明文 `data.sql` 自动 commit**。 | context7：CI 备份工作流（仅借用 dump 命令，落点改造） |
| L3 应用级 | 前端 `ExportService/ImportService`（EscapePod 手动导出）。 | 已实现 |
| L4 取证 | `task_change_audit` 前像（§3）。 | ✅ 已上线 |

**升级要求**：L1/L2/L4 至少两层同时可用，否则生产不算安全。PITR 解决"大范围时间点回滚"，逻辑备份解决"跨项目/跨环境重建"，审计解决"局部字段级回滚"。

> 🔴 **备份落点是爆炸半径问题，不是便利性问题**。`data.sql` 含用户任务正文、项目名、审计 payload，是一份完整的敏感数据副本。把它自动 commit 到（哪怕私有的）Git 仓库，等于把生产数据复制进另一个爆炸半径——私有仓库只是权限模型稍好的文件夹，不是保险箱（fork、缓存、CI artifact、离职成员本地 clone 都会扩大暴露面）。

### 4.1 每日逻辑备份工作流（context7 dump + 加密落点改造）

**原则**：context7 的「dump 后 `git-auto-commit` 到私有仓库」示例仅用于演示 dump 命令，**不可原样作为高安全生产方案**。生产必须做到：加密静态存储、独立 vault、短期保留、密钥轮换、最小读取权限、恢复演练用临时环境、**禁止明文数据进版本库**。

```yaml
name: Supa-backup
on:
  workflow_dispatch:
  schedule:
    - cron: '0 0 * * *'  # 每日 0 点
jobs:
  run_db_backup:
    runs-on: ubuntu-latest
    permissions:
      contents: read      # 不再需要 contents:write，不向仓库写明文
      id-token: write     # GitHub OIDC 换 AWS 短期凭证
    steps:
      - uses: supabase/setup-cli@v1
        with: { version: latest }
      - name: Install backup tools
        run: |
          sudo apt-get update
          sudo apt-get install -y age jq awscli
      - name: Dump, encrypt, upload（仅本步注入敏感 secrets）
        env:
          SUPABASE_DB_URL: ${{ secrets.SUPABASE_DB_URL }}
          BACKUP_AGE_PUBLIC_KEY: ${{ secrets.BACKUP_AGE_PUBLIC_KEY }}
          BACKUP_S3_BUCKET: ${{ secrets.BACKUP_S3_BUCKET }}
          BACKUP_AWS_ROLE_TO_ASSUME: ${{ secrets.BACKUP_AWS_ROLE_TO_ASSUME }}
          AWS_DEFAULT_REGION: ${{ secrets.BACKUP_AWS_REGION }}
        run: |
          # 通过 GitHub OIDC assume-role 获取 1 小时 AWS 临时凭证（不保存长期 AWS key）
          oidc_response="$(curl -fsSL -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
            "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=sts.amazonaws.com")"
          web_identity_token="$(printf '%s' "$oidc_response" | jq -r '.value')"
          credentials="$(aws sts assume-role-with-web-identity \
            --role-arn "$BACKUP_AWS_ROLE_TO_ASSUME" \
            --role-session-name "nanoflow-backup-${GITHUB_RUN_ID}" \
            --web-identity-token "$web_identity_token" \
            --duration-seconds 3600)"
          export AWS_ACCESS_KEY_ID="$(printf '%s' "$credentials" | jq -r '.Credentials.AccessKeyId')"
          export AWS_SECRET_ACCESS_KEY="$(printf '%s' "$credentials" | jq -r '.Credentials.SecretAccessKey')"
          export AWS_SESSION_TOKEN="$(printf '%s' "$credentials" | jq -r '.Credentials.SessionToken')"

          supabase db dump --db-url "$SUPABASE_DB_URL" -f roles.sql  --role-only
          supabase db dump --db-url "$SUPABASE_DB_URL" -f schema.sql
          supabase db dump --db-url "$SUPABASE_DB_URL" -f data.sql --data-only --use-copy
          TS=$(date -u +%Y%m%dT%H%M%SZ)
          for f in roles.sql schema.sql data.sql; do
            age -r "$BACKUP_AGE_PUBLIC_KEY" -o "$f.$TS.age" "$f"
          done
          shred -u roles.sql schema.sql data.sql   # 明文不离开 runner 内存盘
          aws s3 cp . "s3://$BACKUP_S3_BUCKET/$(date -u +%Y/%m/%d)/" \
            --recursive --exclude "*" --include "*.age" \
            --sse aws:kms     # 对象存储再叠一层 KMS 静态加密
      # ❌ 不再有 git-auto-commit 步骤：明文数据绝不进版本库
```

> 关键防线：
> - **非对称加密**：CI runner 只持有公钥，泄露 runner 也无法解密历史备份；私钥离线保管，仅恢复演练时临时引入。
> - **独立 backup vault**：备份桶与业务 Storage 桶物理隔离，开启 SSE-KMS、版本化、对象锁（防勒索删除），桶策略仅允许备份 IAM 角色 `PutObject`。
> - **短期保留 + 生命周期**：对象存储生命周期规则设置保留期（如 35 天）自动过期，避免无界囤积敏感副本。
> - **密钥轮换**：age 密钥对与 KMS key 定期轮换并记录轮换日志；轮换后保留旧 key 至旧备份过期。
> - **恢复用临时环境**：解密与还原只在一次性临时项目/影子库进行，演练结束即销毁，私钥与明文不落地长期环境。
> - **凭证最小化**：`SUPABASE_DB_URL` 存 GitHub Secrets；AWS 使用 GitHub OIDC assume-role 换短期凭证，IAM 仅授 `PutObject`，不授 `GetObject/Delete`。

### 4.2 备份验收标准

备份任务成功不等于备份可用。每次月度演练必须记录：

1. 能否列出 Supabase 可用备份（context7：Management API `/database/backups`）。
2. 能否把逻辑备份恢复到新项目/影子库。
3. 业务校验是否通过：项目数、任务数、stage 分布、软删数、审计表行数。
4. 恢复后的 app 是否能登录并打开核心项目。
5. 恢复耗时是否满足 §0.2 RTO。

### 4.3 PITR 使用纪律

PITR 是最后手段，不是日常修复工具：

- 先在分支/影子库执行目标时间点恢复，确认能找回数据。
- 导出事故后合法写入差异，评估回滚代价。
- 只有审计回滚和逻辑导入都无法满足时，才对生产执行 PITR。
- PITR 后必须重放事故后合法写入，或明确告知不可恢复窗口。

---

## 5. 恢复层（分级紧急手册）

> 决策原则：**优先最小粒度、可佐证、可回滚**的恢复路径；只有在无更细粒度证据时才升级到 PITR。

### 5.0 P0 前 15 分钟处置流程

1. **冻结**：立刻把 `data_safety_flags.sync_mode` 切到 `read_only` 或 `quarantine`（功能落地后，经 `set_data_safety_flag()`）。
2. **封存**：记录当前生产 `gitSha`、`deployment_epoch`、异常用户、异常项目、首次发现时间。
3. **取证**：导出 `sync_operation_log`、`task_change_audit`、异常项目的 `tasks` 当前快照。
4. **止血**：暂停生产部署；禁止清缓存式操作覆盖证据。
5. **判定**：用 §5.5 的结构分布 SQL 判断是单项目、跨项目还是全库级。
6. **恢复**：按 A/B/C/D 级别选择最小可验证路径。

#### 5.0.1 圈定事故窗口 `[incident_start, incident_end]`（恢复正确性的前提）

恢复 SQL 的正确性完全依赖事故窗口判断。下一步所有审计回滚都围绕这个窗口取「事故写入产生的第一批前像」：

```sql
-- 用异常项目里「结构退化写」的审计行圈定窗口边界（content==title 且 stage 被清空）
SELECT
  min(changed_at) AS incident_start,
  max(changed_at) AS incident_end,
  count(*)        AS degraded_rows,
  array_agg(DISTINCT client_git_sha) AS suspect_shas
FROM public.task_change_audit
WHERE project_id = '<PROJECT_UUID>'        -- 跨项目时去掉此行，改用 owner_id
  AND old_stage IS NOT NULL
  AND new_stage IS NULL
  AND coalesce(new_content,'') = coalesce(new_title,'')
  AND changed_at >= '<ROUGH_INCIDENT_START>';   -- 用部署时间/首次发现时间给个粗下界
-- 也可直接用事故批次的 operation_id / client_git_sha 作为更精准的定位键。
```

> 拿到 `incident_start/incident_end/suspect_shas` 后，再进入级别 A/B。**不要再用「< INCIDENT_TS」这种单边时间条件**（理由见级别 A 的纠偏说明）。

#### 5.0.2 冻结开关上线前的临时止血路径（必须存在）

`sync_mode` 是「功能落地后」的冻结手段。但**下一次 P0 不会礼貌地等冻结开关上线**。在开关尚未交付前，必须用现有数据库/部署能力临时止血（按可用性从快到慢）：

| 手段 | 操作 | 影响 | 可逆性 |
|------|------|------|--------|
| 撤销同步 RPC 执行权限 | `REVOKE EXECUTE ON FUNCTION public.sync_upsert_task(...) FROM anon, authenticated;`（`batch_upsert_tasks` 同理） | 客户端立即无法写同步；服务端修复 SQL 不受影响 | `GRANT` 即恢复 |
| 临时 RLS / 函数 guard | 给 `tasks` 加一条临时 `UPDATE` 限制策略，或在 RPC 顶部加 `RAISE EXCEPTION` 守卫 | 阻断写路径但保留读 | 删策略/还原函数 |
| 停用部署入口 | 暂停 Netlify/Vercel/Workers 部署 + 回滚到事故前 `gitSha` | 阻止问题客户端继续分发 | 重新部署 |
| 禁用客户端写同步 | 推一个 kill-switch 配置（`/version.json` 或远端 flag），前端读到后停发同步 | 需要客户端在线拉取 | 改回配置 |
| 轮换 anon key / 抬高 protocol fence | 轮换 `anon` key 使旧会话失效；或提升 `protocol_version` 让旧客户端只读 | 强制所有客户端升级/重登 | 影响面大，最后手段 |

> 优先级：**撤销 RPC 执行权限**最快且最干净（一条 SQL，秒级生效，service_role 修复不受影响），应作为冻结开关未上线期的默认止血动作，并写进 runbook 首条。

### 级别 A —— 单字段/单任务回滚（首选，依赖 §3 审计）

适用：少量任务的 `stage/parent_id/content` 被覆盖，且**事故时间点晚于审计上线（2026-05-31）**。

> 🔴 **时间条件纠偏（v1.2.0 修复，恢复手册核心，不能错）**：
> `task_change_audit` 存的是「某次变更发生时的 **OLD 前像**」。事故覆盖发生在 `incident_start ~ incident_end` 之间，**那条保存了真正旧值（被覆盖前的 stage）的审计行，它的 `changed_at` 正好落在事故窗口内，而不是窗口之前**。
> 旧写法 `changed_at < INCIDENT_TS` 会**跳过事故那一刻保存旧值的审计行**，转去取更早的历史前像——轻则恢复不到，重则恢复成更旧状态。
> 正确做法：取**事故写入产生的第一批前像**，即 `changed_at` 落在事故窗口内、且方向为「结构退化」的那一行的 `old_*` 值；或用 `operation_id/audit_id/client_git_sha` 精准定位事故批次。

```sql
-- 1. 先看该任务在事故窗口内的退化写前像（这一行的 old_* 就是被覆盖前的真值）
SELECT id AS audit_id, old_stage, old_parent_id, old_content, old_updated_at,
       new_stage, new_content, changed_at, client_git_sha
FROM public.task_change_audit
WHERE task_id = '<TASK_UUID>'
  AND changed_at >= '<incident_start>'
  AND changed_at <= '<incident_end>'
  AND old_stage IS NOT NULL
  AND new_stage IS NULL           -- 结构退化方向：恰好是事故那一笔
ORDER BY changed_at ASC           -- 取事故窗口内「第一笔」退化写的前像
LIMIT 5;

-- 2. 校验无误后，用「事故窗口内第一笔退化写」的前像回滚
UPDATE public.tasks t
SET stage = a.old_stage,
    parent_id = a.old_parent_id,
    updated_at = now()
FROM (
  SELECT DISTINCT ON (task_id) task_id, old_stage, old_parent_id
  FROM public.task_change_audit
  WHERE task_id = '<TASK_UUID>'
    AND changed_at >= '<incident_start>'
    AND changed_at <= '<incident_end>'
    AND old_stage IS NOT NULL AND new_stage IS NULL
  ORDER BY task_id, changed_at ASC      -- 升序 = 事故首笔前像（真值），而非更旧历史
) a
WHERE t.id = a.task_id;

-- 替代：若已能用 operation_id / audit_id 精准锁定事故批次，直接按主键定位最可靠：
-- WHERE a.id = <AUDIT_ID>  或  WHERE a.operation_id = '<INCIDENT_OPERATION_ID>'
```

### 级别 B —— 项目批量回滚（依赖 §3 审计）

适用：单个项目整批被覆盖。

> 同级别 A 的纠偏：围绕事故窗口取每个任务「事故写入产生的第一批前像」，禁止用 `changed_at < INCIDENT_TS`。

```sql
-- 取该项目内每个任务在事故窗口内「第一笔结构退化写」的前像并回滚
UPDATE public.tasks t
SET stage = a.old_stage, parent_id = a.old_parent_id, updated_at = now()
FROM (
  SELECT DISTINCT ON (task_id) task_id, old_stage, old_parent_id
  FROM public.task_change_audit
  WHERE project_id = '<PROJECT_UUID>'
    AND changed_at >= '<incident_start>'
    AND changed_at <= '<incident_end>'
    AND old_stage IS NOT NULL AND new_stage IS NULL    -- 只回滚事故退化写，避开合法编辑
  ORDER BY task_id, changed_at ASC                      -- 升序取事故首笔前像
) a
WHERE t.id = a.task_id AND t.project_id = '<PROJECT_UUID>';

-- 更稳的精准定位（推荐）：用事故批次的 operation_id 集合，彻底避免时间边界误差
-- WHERE a.operation_id = ANY('{<op1>,<op2>,...}'::uuid[])
```

### 级别 C —— 全库 PITR（最后手段，context7）

适用：大范围损坏、审计不足以覆盖、或 schema 级破坏。**先评估"丢失事故后合法写入"的代价**。

```bash
curl https://api.supabase.com/v1/projects/database/backups/restore-pitr \
  --request POST \
  --header 'Authorization: Bearer {PAT}' \
  --header 'Content-Type: application/json' \
  --data '{ "recovery_time_target_unix": <UNIX_TS_JUST_BEFORE_INCIDENT> }'
```

> ⚠️ PITR 会回滚**整库**到指定时间点，事故后产生的所有合法写入都会丢失。仅在 A/B 不可行时使用，且优先在分支/影子库验证。

### 级别 D —— 逻辑备份导入（schema 损坏时）

从 §4.1 的 `schema.sql + data.sql` 在新库重建，再做选择性数据迁移。

### 级别 E —— Quarantine 合法写重放（规划）

适用：事故期间 sync 写入被隔离，其中一部分是合法离线写。

流程：

1. 按 `reason/client_git_sha/entity_id` 分组查看隔离 payload。
2. 对照 `task_change_audit` 和当前任务状态确认是否可重放。
3. 只通过服务端修复 RPC 重放，不允许客户端直接二次同步。
4. 重放后解除 `sync_mode`，并保留 `review_decision`。

### 恢复后必做校验（context7：数据完整性）

```sql
SELECT schemaname, tablename, n_live_tup
FROM pg_stat_user_tables
ORDER BY n_live_tup DESC
LIMIT 20;
-- + 业务校验：每项目 stage 分布、根/子节点计数、content 非空率
```

### 5.5 NanoFlow 专项结构审计 SQL

```sql
-- 每项目 active/stage/null/content 分布
SELECT
  p.id AS project_id,
  p.title,
  count(t.id) FILTER (WHERE t.deleted_at IS NULL) AS active_tasks,
  count(t.id) FILTER (WHERE t.deleted_at IS NULL AND t.stage IS NULL) AS stage_null,
  count(t.id) FILTER (WHERE t.deleted_at IS NULL AND t.parent_id IS NOT NULL) AS child_tasks,
  count(t.id) FILTER (WHERE t.deleted_at IS NULL AND coalesce(t.content, '') = coalesce(t.title, '')) AS content_equals_title,
  max(t.updated_at) AS last_task_update
FROM public.projects p
LEFT JOIN public.tasks t ON t.project_id = p.id
WHERE p.owner_id = '<USER_UUID>' AND p.deleted_at IS NULL
GROUP BY p.id, p.title
ORDER BY last_task_update DESC NULLS LAST;
```

如果多个项目在同一时间窗口出现 `stage_null` 激增、`content_equals_title` 激增，直接按跨项目 P0 处理。

### 5.6 残留损坏根诊断与可证伪恢复（本次 P0 残留案例 → 最佳实践）

> **为什么预防目标已落地、问题却仍残留？** 这是本次评审揭示的核心：预防层（拒写护栏 §2.1 + 审计 §3）只能阻止**未来**的覆盖，**无法回溯修复事故前已经发生的覆盖**。事故已经把真实分层根降级成 `stage=null` 的扁平块，而审计表 `2026-05-31` 才上线，对更早的覆盖没有前像。于是残留修复的真正难点不是"拒写"，而是：**在没有前像的快照里，如何区分「被覆盖的根」与「本就合法的扁平/新建任务」**——因为二者当前都长成 `stage=null`。

#### 5.6.1 失败逻辑链条（彻底理清）

```
旧客户端物化预览摘要 → stage/parent_id 被清空、content=title、无 updated_at
  → 水合短路（tasks>0 跳过云端全量水合）
    → 启动同步整行 LWW 覆盖真实根 → 分层根降级为 stage=null 扁平块
      → 事故前无字段前像（sync_operation_log 只存 task_id/updated_at）
        → 当前快照里「被覆盖的根」与「本就扁平的任务」外观完全相同
          → 若用「version 计数 / 无子节点」这种【不可证伪】的弱推断判死
            → 误判为「本就扁平、不可恢复」→ 与用户记忆冲突 → 二次信任打击
```

> 根源教训：**判定「不可恢复」必须建立在可证伪证据上，而不是不可证伪的弱相关推断上。** 「version=2、没有子节点、没有 history」既不能证明它曾有 stage，也不能证明它没有——这是无信息推断，不能用来对用户的数据下死刑判决。

#### 5.6.2 可证伪信号分级（恢复决策的唯一依据）

| 信号 | 含义 | 可证伪性 | 恢复动作 | 可信度 |
|------|------|----------|----------|--------|
| **S1：`stage=null` 却仍被子节点 `parent_id` 引用** | 一个拥有子树的节点不可能"本就是扁平待分配块"——它必然曾是分层根，stage 被覆盖清空 | 强（子节点引用是硬证据） | 用子节点的 stage/层级关系**反推回填**根 stage | 高（可信恢复） |
| **S2：软删除区存在同 `id`/`title` 的带 stage 旧版本** | 事故前的正确版本可能被软删保留 | 强（旧行即 ground truth） | 直接用软删行 `stage/parent_id/content` **回填活动行** | 最高 |
| **S3：审计前像命中（仅 2026-05-31 后事故）** | 事故落在审计上线后 | 强 | 走 §5 级别 A/B | 高 |
| **S4：无子节点 + 无软删 + 无审计 + `content==title`** | 没有任何数据库 ground truth | **不可证伪** | **禁止捏造 stage**；回到用户口述，或用户确认后设默认 stage | 无（不得擅自写） |

> 核心纪律：**S1/S2/S3 可信则恢复，S4 不可证伪则绝不捏造。** 把「被覆盖的根」（S1/S2/S3）与「本就合法的扁平/新建任务」（S4）严格分开，是这次残留修复必须坚持的最佳实践。

#### 5.6.3 全量体检 SQL（先只读定位，禁止盲写）

```sql
-- A. 全账号盘点：找「有子节点却 stage=null」的损坏根（S1，最强恢复信号）
WITH active AS (
  SELECT t.* FROM public.tasks t
  JOIN public.projects p ON p.id = t.project_id
  WHERE p.owner_id = '<OWNER_UUID>' AND t.deleted_at IS NULL
),
childcount AS (
  SELECT parent_id, count(*) n FROM active WHERE parent_id IS NOT NULL GROUP BY parent_id
)
SELECT pr.title, a.project_id,
  count(*) AS active_tasks,
  count(*) FILTER (WHERE a.stage IS NULL) AS stage_null,
  count(*) FILTER (WHERE a.stage IS NULL AND c.n > 0) AS stage_null_with_children,   -- S1 命中数
  count(*) FILTER (WHERE a.content = a.title) AS content_eq_title,
  min(a.updated_at) FILTER (WHERE a.stage IS NULL) AS min_upd,
  max(a.updated_at) FILTER (WHERE a.stage IS NULL) AS max_upd
FROM active a
JOIN public.projects pr ON pr.id = a.project_id
LEFT JOIN childcount c ON c.parent_id = a.id
GROUP BY pr.title, a.project_id
ORDER BY stage_null_with_children DESC, stage_null DESC;

-- B. 逐个 stage_null 任务详情 + 是否被引用为 parent + 子节点 stage（用于 S1 反推）
WITH active AS (
  SELECT t.* FROM public.tasks t
  JOIN public.projects p ON p.id = t.project_id
  WHERE p.owner_id = '<OWNER_UUID>' AND t.deleted_at IS NULL
)
SELECT a.project_id, a.id, a.title, (a.content = a.title) AS materialized_sig, a.updated_at,
  (SELECT count(*) FROM active c WHERE c.parent_id = a.id) AS child_n,
  (SELECT array_agg(DISTINCT c.stage) FROM active c WHERE c.parent_id = a.id) AS child_stages,
  a.parent_id,
  (SELECT par.stage FROM active par WHERE par.id = a.parent_id) AS parent_stage
FROM active a
WHERE a.stage IS NULL
ORDER BY a.project_id, child_n DESC;

-- C. 软删除区是否藏着事故前的正确版本（S2，最高可信）
SELECT project_id, id, title, stage, parent_id, updated_at, deleted_at
FROM public.tasks
WHERE project_id = ANY('{<PROJECT_UUIDS>}'::uuid[])
  AND deleted_at IS NOT NULL
ORDER BY project_id, title;
```

#### 5.6.4 恢复写入（按可证伪分级，逐条小批量，生产可回滚）

```sql
-- S1：有子节点的损坏根 —— 先确认 stage 语义（列号 vs 层级），再按子节点反推回填
-- ⚠️ stage 语义须先在前端 flow 模板/stage 定义代码确认，避免填错列。
UPDATE public.tasks t
SET stage = :inferred_stage, updated_at = now()
WHERE t.id = :task_id AND t.deleted_at IS NULL;

-- S2：软删旧版本存在 —— 直接回填（最高可信）
UPDATE public.tasks t
SET stage = d.stage, parent_id = d.parent_id, content = d.content, updated_at = now()
FROM public.tasks d
WHERE d.id = t.id AND d.deleted_at IS NOT NULL
  AND t.deleted_at IS NULL AND t.id = :task_id;
```

> 写入纪律（生产库）：
> - 任何 UPDATE 前先 SELECT 复核；**逐条 / 小批量**执行，留回滚点。
> - **S4（不可证伪）绝不写**：无 ground truth 时回到用户确认，宁可不恢复也不捏造。
> - 用 `apply_migration` 而非临时脚本执行，保留可追溯迁移记录。

#### 5.6.5 验收

- 体检 A 中所有项目的 `stage_null_with_children` 归零（S1 损坏根全部修复）。
- 用户在 UI 确认条目已恢复。
- 不破坏既有已修复项目（如 `蚯蚓养殖` 两个根）。
- 仍为 `stage_null` 且无子节点/无软删/无审计的条目，明确归类为 S4，标注「需用户确认，非证据缺失即丢失」。

> **本节即「把残留案例以最佳实践揪出根源写入策划案」的产物**。runbook 已于 2026-05-31 在生产库**只读执行完毕**（结论见 §8.1）：S1/S2/S3 全库无命中，`编程`/`饭菜佳肴` 受损任务判级 S4，依纪律未捏造 stage、未对生产库写入任何字段，处置交回用户确认。后续若出现 S1/S2/S3 命中的新事故，按本节 §5.6.4 分级回填执行。

---

## 6. 演练与门禁

| 项 | 要求 | 频率 |
|----|------|------|
| 护栏合同测试 | `sync_upsert_task` 无时间戳拒写、`batch_upsert_tasks` content 护栏，必须保持绿。 | 每次 PR |
| 审计有效性 | 改 1 个测试任务 stage → 确认 `task_change_audit` 落 1 行前像。 | 每次涉及 tasks/同步的改动 |
| 恢复演练 | 在影子库执行级别 A/B 脚本，验证可还原。 | 季度 |
| 备份可用性 | 校验最近一次逻辑备份能在空库还原。 | 月度 |
| PITR 可用性 | 确认 PITR 处于启用状态、保留窗口足够。 | 月度 |

### 6.1 Do-Not-Merge 门禁

任一项不满足，涉及数据写入的 PR 不得合并：

- 同步 RPC 或任务模型改动没有合同测试。
- 迁移没有在分支/影子库回放危险 payload。
- 新表没有 RLS、策略、权限收敛。
- SECURITY DEFINER 函数没有固定 `search_path`。
- 结构字段写入没有审计或前像。
- 缺少恢复/回滚步骤说明。
- 改动会让 snapshot / preview 数据进入同步路径。

> 门禁不能只是 Markdown 誓言——必须落到「谁执行、在哪执行、失败如何阻断」的具体机制，否则会变成团队最爱忽略的那行字：

| 检查项 | 执行点（在哪） | 执行者（谁） | 失败如何阻断 |
|--------|----------------|--------------|--------------|
| 同步/结构合同测试绿 | CI required check（PR 触发） | CI 自动 | required status check 失败 → 合并按钮置灰 |
| 危险 payload 影子库回放报告 | CI job 跑迁移 + 回放脚本，产出 artifact | CI + migration review owner 复核 | 缺回放报告或回放未拒写 → CODEOWNERS 阻止 approve |
| 新表 RLS/策略/权限收敛 | Supabase advisor gate + CI lint（扫 `CREATE TABLE` 无 `ENABLE RLS`） | CI 自动 + DB owner | advisor security 告警 → required check 失败 |
| SECURITY DEFINER `search_path` 固定 | CI grep 规则扫迁移文件 | CI 自动 | 命中未固定 → check 失败 |
| 结构字段写入有审计/前像 | code review + 合同测试断言审计落行 | code-reviewer / DB owner | 测试未断言审计 → check 失败 |
| 恢复/回滚步骤说明 | PR 模板必填段落 | PR 作者 + reviewer | 模板段落为空 → reviewer request changes |
| snapshot/preview 不进同步 | CI 合同测试（materialize guard）+ §1 已落地断言 | CI 自动 | guard 测试失败 → check 失败 |

> 落地要求：
> - `tasks` / 同步 RPC / 迁移目录纳入 **CODEOWNERS**，强制 migration review owner 与 DB owner 双签。
> - 上述 CI 检查全部设为 **branch protection 的 required status checks**，缺一不可合并。
> - 影子库回放报告作为 CI artifact 留档，PR 描述需链接该报告。

### 6.2 发布后 30 分钟观察

每次同步/数据库相关发布后必须观察：

1. `sync_operation_log` 中 `rejected/quarantined/remote-newer` 比例。
2. `task_change_audit` 新增量与 `suspicious`（落地后）数量。
3. 每项目 `stage_null` 与 `content_equals_title` 是否突增。
4. 生产 `/version.json` 的 `gitSha` 是否与预期一致。
5. 客户端错误监控是否出现水合/同步异常。

---

## 7. 待办清单（落地优先级）

- [x] 写入前像护栏（`sync_upsert_task`，migration `20260531063500`）
- [x] 结构化变更审计 `task_change_audit`（migration `20260531070000`）
- [x] P0 写入冻结开关 `data_safety_flags.sync_mode` + `CHECK`/RLS/`revoke`/`set_data_safety_flag()`/自审计（§2.1.1，migration `20260531120000`）
- [x] 冻结开关上线前的临时止血 runbook（撤销 RPC 执行权限优先，§5.0.2）
- [x] `sync_write_quarantine` 隔离表：RLS + `payload_digest`/`operation_id` 幂等 + 保留期 + review 审计（§3.4，migration `20260531120000`）
- [x] 审计 `suspicious` 标记 + `client_git_sha/client_origin/deployment_epoch` 来源归因（GUC + 服务端交叉验证，§3.2，migration `20260531120000`）
- [x] `sync_operation_log.result_payload` 记录 decision/reason/changed_fields/audit_id（§3.3，task sync RPC 已落地，migration `20260531120000`）
- [x] 字段级 LWW：拆分 text/structure/delete 写入意图（§2.3.1，`batch_upsert_tasks` 过渡型 `writeIntent` 已落地）
- [x] RLS 自动加固事件触发器 + `FORCE ROW LEVEL SECURITY` 与审计写路径兼容性实测（§2.4，migration `20260531120000` + Supabase advisor 复核）
- [x] Supabase advisor follow-up：anon SECURITY DEFINER、service-only RLS policy、mutable `search_path` 与重复归档索引收敛（migrations `20260531123000` / `20260531124000`）
- [x] 隔离 retry 去重与直接 batch 写入来源误判补丁（migration `20260531125000`）
- [x] `missing_task_timestamp` 在 quarantine 模式下进入隔离表且不写入业务表（migration `20260531130000`）
- [x] 每日逻辑备份 GitHub Actions：加密上传独立 backup vault，**禁止明文入库**（§4.1，`.github/workflows/supabase-logical-backup.yml`）
- [ ] 备份密钥（age + KMS）轮换流程与保留期生命周期规则（§4.1，需在外部 backup vault/IAM 控制台配置并演练）
- [ ] 确认 PITR 启用状态、保留窗口、恢复权限与负责人（§4.3，需 Supabase Dashboard/Management API 备份权限确认）
- [x] 审计保留/归档 pg_cron 任务（§3.2.3，`archive_old_task_change_audit()` + 可用时自动 schedule）
- [x] 事故窗口 `[incident_start, incident_end]` 圈定 SQL 固化为 runbook（§5.0.1）
- [x] 残留损坏根可证伪诊断与恢复 runbook（§5.6，`stage_null_recovery_diagnostics` 只读视图固化 S1/S2/S3/S4 诊断）
- [ ] 恢复演练脚本（含时间窗口纠偏后的级别 A/B）纳入季度流程（§6，需影子库/分支环境执行）
- [x] Do-Not-Merge 门禁落到 CI required checks + CODEOWNERS（§6.1，`.github/CODEOWNERS` + `database-hardening-gates.yml`；branch protection 需在 GitHub 设置中设为 required）
- [x] 发布后 30 分钟结构审计看板（§6.2，`project_structure_audit` 只读视图）

### 7.1 72 小时加固路线

| 时间 | 目标 | 产物 |
|------|------|------|
| T+24h | 止血与可恢复 | 确认 PITR、上线 `sync_mode` 写入冻结、补 `suspicious` 审计字段、把结构审计 SQL 固化为 runbook。 |
| T+48h | 可归因与可隔离 | `client_git_sha/client_origin` 进入审计；危险 payload 进入 `sync_write_quarantine`；告警规则落地。 |
| T+72h | 可演练与可发布 | 影子库恢复演练通过；每日逻辑备份 workflow 合并；Do-Not-Merge 门禁进入 PR checklist。 |

### 7.2 中长期架构升级

1. **同步协议版本化**：每次破坏性协议变化必须提升 `protocol_version`，旧客户端只能读不能写。
2. **实体意图化写入**：用 `task_text_update` / `task_structure_update` / `task_soft_delete` 替代整行 upsert。
3. **本地缓存类型隔离**：TypeScript 层区分 `LaunchSnapshotTaskPreview` 与 `Task`，禁止结构兼容。
4. **可观测性看板**：项目级 `stage_null`、`content_equals_title`、审计增量、拒写数量进入 dashboard。
5. **定期灾备演练**：每月逻辑恢复、每季度 PITR 影子恢复、每次 P0 后 24h 内复盘并更新本案。

---

## 8. 不可恢复事项（诚实声明）

- **判定「不可恢复」前必须先跑完 §5.6 可证伪诊断**：仅当 S1（有子节点的损坏根）、S2（软删旧版本）、S3（审计前像）全部不命中时，才允许下「数据库无 ground truth」的结论。
- 本案取证层只能保护 **2026-05-31 之后** 发生的变更；更早的覆盖无前像可依。

### 8.1 已执行诊断结论（2026-05-31，§5.6 runbook 实证）

> 本节是把 §5.6 方法论**真正跑在生产库上**得到的结论，取代此前基于版本计数的推断。诊断全程**只读**，未对生产库写入任何字段（严守 S4 纪律）。

**全库 S1 扫描结果**：所有项目的 `stage_null_with_children = 0`——**没有任何 `stage=null` 任务仍被子节点 `parent_id` 引用**。S1（最强可恢复信号）全库 0 命中。

| 项目 | 受损 `stage=null` 任务 | S1（有子节点） | S2（软删旧版本带 stage） | S3（审计前像） | op-log payload 含 stage | 判级 |
|------|------------------------|----------------|--------------------------|----------------|--------------------------|------|
| `编程` | ESP32 / 新任务 / 新任务(空) | ❌ 无子节点 | ❌ 无软删行 | ❌ 审计表空 | ❌ `has_stage_key=0` | **S4** |
| `饭菜佳肴` | 新任务 / 购买东西 / 辣椒炒肉 | ❌ 无子节点 | ❌ 无软删行 | ❌ 审计表空 | ❌ `has_stage_key=0` | **S4** |
| `蚯蚓养殖` | 仅 2 个「新任务」 | ❌ | ❌ | ❌ | ❌ | S4（且本就是新建扁平块，层级主体完好） |

**证据通道全穷尽**：
- `task_change_audit` 存在但 **0 行**（触发器尚未实际产生前像，仅保护未来）。
- `sync_operation_log` 的 `result_payload` **不存 stage 字段**（`has_stage_key=0`），无法反推事故前层级。
- 受损任务自 2026-05-14/15 起即以 `content=title`、`stage=null` 形态被反复 `applied`，无任何带 stage 的历史写。
- `data_safety_flags` / `sync_write_quarantine` 尚未建表（§2/§3 功能待落地）。

**最终判级 = S4（不可证伪）**：`编程`/`饭菜佳肴` 的 stage_null 任务，在活动行、软删区、审计表、op-log payload 四个证据通道里**均无任何曾有 stage 的 ground truth**。

> 按 §5.6.2 纪律：**S4 绝不捏造 stage**。诚实结论是——数据库现有证据既不能证明它们曾有分层、也不能可靠恢复；这是**证据倾向（无可恢复 ground truth）**，不是「本就扁平」的事实判决。剩余唯一理论路径是 §5 级别 C 全库 PITR 回滚到事故前，但：(1) 无证据表明这些任务曾有 stage；(2) 受损形态横跨 05-14 起的多次同步，没有干净的「事故前」时点；(3) PITR 会牺牲全库 18 天合法写入（含完好的 `蚯蚓养殖`）。代价与不确定性远超收益，**不建议为这 6 个任务执行 PITR**。
>
> 处置建议：回到用户确认这些任务的预期 stage 后，由用户侧重新分层（前端正常操作即可），而非由数据库猜测回填。

---

## 9. 本次 P0 的最终教训

1. **用户看到的是"数据丢了"，即使数据库里部分实体仍存在，也必须按数据安全事件处理。**
2. **只靠客户端修 bug 不够**：客户端可以旧版本、离线、缓存、竞态；数据库必须有拒写、审计、隔离、恢复能力。
3. **整行 upsert 是高风险同步原语**：对 offline-first 系统，必须按字段意图和 freshness marker 分层。
4. **日志不等于审计**：没有字段前像的日志无法恢复数据；审计必须保存可恢复的 old_record。
5. **备份不等于恢复能力**：只有演练过、能在规定 RTO 内恢复的备份，才算真正保护用户数据。
