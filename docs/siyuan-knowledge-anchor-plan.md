# NanoFlow × SiYuan Knowledge Anchor 策划案

> **版本**：v1.4
> **日期**：2026-05-18
> **状态**：已进一步落地，需应用生产迁移并补齐 Focus 专属入口与 E2E 验证
> **定位**：思源笔记是知识源头（Source of Truth），NanoFlow 是执行工作台（Execution Workspace）  
> **核心决策**：NanoFlow 只保存思源块指针与少量元数据，不嵌入思源 UI，不在 MVP 同步正文到云端，不在 MVP 做双向写回。
> **v1.4 审查提示**：当前实现已进一步采用用户隔离的 `siyuan-preview-cache:{userId}:{linkId}:{blockId}`，并兼容迁移旧的 `siyuan-preview-cache:{linkId}:{blockId}`；这是比 v1.3 更安全的本机缓存 key。

---

## 0. 执行摘要

本方案建议为 NanoFlow 引入一个轻量的外部知识锚点能力：**在任务块中挂载思源块链接，桌面端鼠标悬浮时以浮层样式展示精确到该思源块 ID 的 NanoFlow 原生预览，点击时跳回思源原块**。

该能力的产品边界必须收紧为：

1. **思源负责内容主权**：长文、知识块、引用网络、属性体系继续留在思源。
2. **NanoFlow 负责执行推进**：任务排序、Focus、Parking Dock、流程推进仍由 NanoFlow 主导。
3. **指针优先于镜像**：默认只同步块 ID、URI、路径、标签、角色等轻量信息；正文预览默认仅保存在本机。
4. **只读优先于写回**：第一阶段只做读取预览、打开原块、刷新缓存、解除关联，不做从 NanoFlow 改写思源。
5. **块级精确预览优先于文档级预览**：任务卡预览必须以 `targetId` 指向的思源块为根，只展示该块及受限的一层子块，不默认展开整篇文档，避免把执行上下文扩大成整篇阅读流。

### 0.1 本案最终裁决

针对 HTTPS PWA 无法直接请求 `http://127.0.0.1:6806` 的 Mixed Content 物理限制，本案**优先采用桌面浏览器扩展 Relay** 作为突破方式，而不是先做本地 HTTP bridge。

原因：

1. **兼容公网 HTTPS PWA**：扩展可以在浏览器权限模型内访问本地思源内核，不要求 NanoFlow 页面直接发起 mixed-content 请求。
2. **避免本地证书分发复杂度**：如果先做本地 bridge，要么仍然是 HTTP 被拦截，要么必须处理本地 HTTPS 证书信任，实施成本高且易出故障。
3. **对现有 NanoFlow 改动最小**：前端只需要接一个 provider 抽象层，桌面端通过扩展拿预览，移动端和未安装扩展的环境直接降级为缓存预览 + 深链打开。
4. **更符合 MVP 节奏**：先把链接绑定、缓存预览、深链回跳跑通，再为桌面浏览器补上“在线预览”能力，产品风险最小。

因此，本案采用三层运行时策略：

| 运行时 | 预览能力 | 打开原块 | 备注 |
|------|------|------|------|
| 桌面浏览器 + NanoFlow Extension | 实时预览 | 支持 | 主路径 |
| 本地开发 / 本地桌面壳（未来） | 实时预览 | 支持 | 次路径 |
| 公网 HTTPS PWA / 移动端 / 无扩展桌面 | 缓存预览或无预览 | 支持 | 降级路径 |

### 0.2 成功指标

MVP 是否成立，不以“能否完整复制思源体验”为标准，而以任务执行链路是否更顺滑为标准：

| 指标 | 目标 |
|------|------|
| 绑定成功率 | 粘贴合法 `siyuan://blocks/{id}` 后可稳定创建锚点 |
| 降级可用性 | 无扩展、无 token、思源不可达时任务卡仍可操作 |
| 首次交互成本 | 桌面端悬浮即可预览，任务卡上最多一次点击即可打开思源原块 |
| 预览精度 | 任务卡预览命中 `targetId` 对应的具体思源块，不退化为整篇文档摘要 |
| Hover 稳定性 | 从锚点移动到预览浮层时不闪烁，快速切换锚点时不显示旧块 |
| 数据边界 | Supabase 只保存指针与轻量元数据，不保存 token 与正文缓存 |
| Focus 干扰 | Focus 中不自动展开正文，不提供块内漫游入口 |

### 0.3 实施优先级

优先级按“先建立稳定指针，再补预览，再增强集成”排序：

1. **P0 指针闭环**：解析链接、保存锚点、展示锚点、深链回跳。
2. **P1 本地缓存与状态 UI**：让预览能力即使在无实时连接时也能解释清楚。
3. **P2 桌面扩展 Relay**：解决 HTTPS PWA 访问本地思源的 Mixed Content 障碍。
4. **P3 多端体验收敛**：移动端 Bottom Sheet、Focus / Dock 降噪、多锚点。
5. **P4 可选增强**：本地 bridge、桌面壳、显式 opt-in 写回。

### 0.4 当前实施审查快照（2026-05-18）

本节是对当前代码库的执行审查，不替代后续开发计划。结论：**P0 / P1 / P2 主链路已经落地；本轮已补本地 stale-write 迁移、Dock deep-link-only 行为、移动端长按菜单、预览 in-flight 去重和直接回归测试；仍需把迁移应用到目标 Supabase 环境，并补 Focus 专属入口、多锚点管理与 E2E 验证。**

| 阶段 | 当前状态 | 已落地证据 | 仍需补齐 |
|------|------|------|------|
| Phase 0 锚点绑定与深链回跳 | 基本完成 | `src/app/core/external-sources/external-source-link.service.ts`、`src/app/core/external-sources/siyuan/siyuan-link-parser.ts`、`src/app/shared/components/knowledge-anchor/knowledge-anchor.component.ts`；文本卡片、文本编辑器、Flow 任务详情、Parking Dock 已接入 `app-knowledge-anchor` | 任务卡外的批量管理入口尚无；绑定入口当前仍偏技术化 |
| Phase 1 预览模型与缓存框架 | 大部分完成 | `external-source.model.ts`、`external-source-cache.service.ts`、`siyuan-preview.service.ts`、`knowledge-anchor-popover.*`；缓存 key 已包含 `userId/linkId/blockId`，并有旧 key 迁移；本轮已补同锚点 in-flight 去重与组件测试 | 仍缺真实扩展/真实思源的端到端验收 |
| Phase 2 浏览器扩展 Relay | 大部分完成 | `extensions/siyuan-relay` v0.2.0、content-script origin allowlist、API allowlist、页面到扩展单向配置通道、`SiyuanExtensionProvider` | 需要补真实扩展安装/未安装的 E2E 或手工验收记录；文档中 `externally_connectable` 应理解为当前 content-script relay 的 origin allowlist 等价控制 |
| Phase 3 移动端 / Focus / Dock | 部分完成 | 移动端 Bottom Sheet 和长按菜单已在 `KnowledgeAnchorComponent` 中实现；Dock 已接入 compact + deep-link-only 模式 | Focus 专属入口未接入；多锚点 UI、role 标注、排序 UI 未实现 |
| Phase 4 安全增强与可选写回 | 未开始 | 当前仍保持只读优先，无默认写回 | 本地 bridge、桌面壳、`setBlockAttrs` opt-in 写回均应继续后置 |

#### 已执行且符合最佳实践的部分

1. **数据边界正确**：Supabase `external_source_links` 只保存指针和轻量元数据；预览正文、token、本地错误状态保存在设备本机，符合 Source of Truth 与隐私边界。
2. **Offline-first 主链路成立**：新增、解除、导入锚点都先写本地 Store / IndexedDB，再通过 pending 队列推送；失败进入本机重试与死信队列。
3. **安全输入收敛**：思源 block ID 使用白名单正则，拒绝换行、路径穿越和非 `siyuan://` 协议；服务端约束已在 `20260504152000_external_source_links_lowercase_block_ids.sql` 收紧为小写块 ID。
4. **Mixed Content 方案选择正确**：主路径采用浏览器扩展 Relay，页面端不直接从 HTTPS PWA fetch 本地 HTTP 思源内核。
5. **Relay attack surface 收敛**：扩展只允许固定本机 baseUrl、固定 API allowlist、固定消息类型；页面配置通道只回传 `hasToken`，不回传 token 明文。
6. **UI 运行时成本可控**：桌面 Overlay 通过动态 import 懒加载，移动端不加载 hover 逻辑；符合移动端默认轻量的约束。
7. **导入导出与灾备已纳入锚点**：`export.service.ts`、`import.service.ts`、`disaster-backup.service.ts` 已处理 `externalSourceLinks`，不会把锚点排除在本地迁移与灾备之外。

#### 未完成或需要优化的部分

1. **P3 Focus 专属入口未落地**：计划要求 Focus 中只显示一行来源和精简摘要，但当前未发现 Focus 独立组件接入 `KnowledgeAnchorComponent`。Dock 的 focus-like 详情已改为 deep-link-only，不等同于完整 Focus 入口。
2. **生产迁移待应用**：本轮已新增 `20260518162000_external_source_links_stale_write_protection.sql`，但目标 Supabase 环境仍需执行迁移并做 remote-newer/stale-pending 行为验证。
3. **多锚点仅数据模型就绪**：Store 和服务支持多条 link，但 UI 只取 `firstLink` 展示；role、排序、多个锚点的可视管理仍未完成。
4. **E2E 覆盖不足**：已有服务、解析器、Provider、扩展合约与本轮新增组件测试；仍缺真实/模拟扩展场景 E2E、Focus 中不自动展开预览的 E2E。
5. **预览并发策略已补关键路径**：本轮已在 `SiyuanPreviewService` 增加按 `userId/linkId/blockId/forceRefresh` 分组的 in-flight 去重；后续仍应观察真实扩展通道下的取消与超时行为。
6. **文档表结构需对齐实现**：计划中 `task_id` 写作 `text`，实际迁移为 `uuid` 外键引用 `public.tasks(id)`；当前项目任务 ID 本身是 UUID 字符串，这个实现更利于 RLS 与引用完整性，文档应以后者为准。
7. **配置常量命名存在历史并存**：文档早期示例出现 `SIYUAN_PREVIEW_CONFIG.MAX_CHILD_BLOCKS = 5`，实现已统一到 `SIYUAN_CONFIG.MAX_PREVIEW_CHILDREN = 10` 与 `MAX_PREVIEW_CHARS = 1200`；后续文档应避免再引入第二套配置名。

#### 剩余任务的最佳实践重排

剩余工作不应按“看起来缺哪个 UI 就先补哪个 UI”推进，而应按数据安全、专注体验、交互完整性、验证闭环的顺序推进。

| 优先级 | 剩余任务 | 最佳实践判断 | 具体改善要求 | 验收方式 |
|------|------|------|------|------|
| P0 | `external_source_links` stale-write 防护 | 本地已补，生产待应用。当前客户端已经做 LWW merge，但 pending 队列通过普通 upsert 推送旧 payload 时，服务端必须有“旧写不覆盖新写”的最后防线。 | 已新增 `20260518162000_external_source_links_stale_write_protection.sql`：当现有行 `updated_at > NEW.updated_at + skew` 时保留旧行；软删除同时间窗内删除优先，防止旧 pending 复活锚点。 | 在目标 Supabase 执行迁移后，构造 remote newer + local stale pending 的数据库用例，确认旧 label/role/delete 不覆盖新行；确认唯一冲突仍可合并。 |
| P1 | Focus compact 接入 | 部分完成。组件已具备 `previewMode="deep-link-only"`，Dock 已使用；Focus 独立入口仍需接入。 | 在真正的 Focus 任务展示面接入 `KnowledgeAnchorComponent`，使用 deep-link-only 或等价模式；只显示一行来源和“打开思源”，默认不触发 hover Overlay。 | Focus 组件测试断言锚点可见、不会自动 attach Overlay、打开思源入口可用、任务操作不被阻塞。 |
| P1 | Knowledge Anchor 组件测试 | 部分完成。本轮已补 deep-link-only 与移动端长按直接测试。 | 继续补 hover 宽限、Overlay 生命周期、Esc 恢复焦点、快速切换锚点不串内容、移动 Sheet 刷新/解除关联。 | `knowledge-anchor` 组件和 popover service 至少各有直接 spec；使用 mock provider，不依赖真实思源或真实扩展。 |
| P1 | 移动端长按菜单 | 已补基础路径。移动端最佳实践不是模拟 hover，而是明确 click/long-press 两条路径。 | 已使用 pointer 长按计时，移动超过阈值取消；普通点击仍打开 Sheet；菜单包含预览、打开思源、刷新缓存、解除关联。后续可补更完整的可访问性与视觉验收。 | 本轮组件测试已覆盖长按打开菜单、后续 click 抑制、拖动取消。 |
| P1 | 预览请求 in-flight 去重 | 已补基础路径。 | 已在 `SiyuanPreviewService` 增加按 `userId/linkId/blockId/forceRefresh` 分组的 in-flight map；同 key 复用 Promise，不同 key 仍通过 active request guard 防串内容。 | 本轮服务测试已覆盖相同锚点并发只调用一次 provider，以及 force refresh 与普通刷新分离。 |
| P2 | 扩展 Relay 安装/降级验收 | 需要补。静态契约测试已经存在，但用户真实路径还缺“安装扩展、未安装扩展、旧扩展”的端到端记录。 | 增加 Playwright 或手工验收清单：扩展不可用时显示降级态；旧扩展不支持 `get-config-status` 时设置页提示更新；token 只写入扩展 storage，不进入 IndexedDB。 | E2E 可模拟 content-script message；真实扩展安装路径至少保留手工验收记录和截图位置。 |
| P2 | 多锚点 UI | 继续后置。模型已支持多锚点，但 UI 复杂度高，不应在 Focus 和基础测试补齐前展开。 | 先保留 MVP 单锚点展示；多锚点启用时再补 role 选择、排序、删除、默认主锚点。若允许同一块不同 role，需要先迁移唯一索引。 | 多锚点启用前通过 feature flag 或显式版本门禁；迁移前检查重复数据。 |
| P3 | Phase 4 写回/bridge | 保持暂缓。当前只读主路径未完全验收前，写回会把风险推向思源 Source of Truth。 | 不做默认写回；未来只允许 opt-in 写 `custom-*` 属性，且必须有撤销和关闭开关。bridge/桌面壳仅在扩展 relay 稳定后评估。 | 写回功能进入设计前，先完成只读链路的安全验收和 Focus/Dock/移动端验收。 |

#### 剩余任务的代码落地边界

1. **先硬化数据，再补交互**：`external_source_links` 的 stale-write 防护应早于多锚点 UI，否则多端编辑 role/sortOrder/删除时会放大旧 pending 的覆盖风险。
2. **Focus 不能只传 `compact=true`**：当前 `compact` 只改变视觉密度，不改变 hover 行为；直接接入会违反“Focus 不自动展开阅读流”的产品原则。
3. **移动端长按不要复用桌面 Popover**：长按菜单是命令入口，Sheet 是预览入口，二者状态分离，避免 hover 逻辑进入触屏路径。
4. **扩展安全以 allowlist 为单事实源**：`manifest.content_scripts.matches`、content-script `BUILTIN_ALLOWED_ORIGINS`、页面侧 contract tests 必须同步更新，不能只改其中一个。
5. **测试优先补风险分支**：服务层已覆盖本地先写、pending、死信、重复合并；下一步测试应优先补 UI 生命周期、扩展不可用降级、stale pending 防护，而不是只补快照式渲染。

---

## 1. 背景与目标

NanoFlow 的核心价值在于离线优先、任务执行、Focus 与 Dock 调度；思源笔记的核心价值在于块级知识管理、引用、双向链接与长文材料承载。两者并不应该互相吞并，而应建立清晰分工：

```text
SiYuan：事实、背景、资料、知识块、原始上下文
NanoFlow：拆解、推进、切换、执行、专注、停泊
```

本功能的目标，是让任务在执行时拥有“足够近”的知识上下文，但不让 NanoFlow 演化成第二个知识库。

### 1.1 目标

1. 允许任务挂载一个或多个思源块作为上下文锚点。
2. 在任务卡、Focus、Parking Dock 中以克制方式显示思源来源。
3. 在桌面端提供安全、快速、只读的块预览体验。
4. 在移动端和弱连接场景下提供缓存预览或深链回跳。
5. 维持 NanoFlow 现有 Offline-first、LWW、Signals、按设备本地配置的架构原则。

### 1.2 非目标

以下内容**不进入 MVP**：

1. 在 NanoFlow 中内嵌思源原生 UI 或 iframe。
2. 在 NanoFlow 中搜索整个思源库。
3. 将完整思源正文默认同步到 Supabase。
4. 从 NanoFlow 直接编辑、删除思源块。
5. 默认向思源写回 NanoFlow 状态。
6. 把思源块作为 NanoFlow 任务树节点参与拖拽、排序或同步冲突处理。
7. 在移动端假设可以访问本机思源内核。

### 1.3 目标用户与核心场景

| 用户场景 | 主要诉求 | MVP 行为 |
|------|------|------|
| 桌面执行任务 | 任务旁边快速查看需求、背景、规格 | Hover 查看摘要，必要时打开思源 |
| 移动端临时确认 | 不适合长时间预览，但要能跳回资料 | 点击锚点打开 Sheet，保留深链 |
| Focus 专注推进 | 只需要知道当前任务来自哪里 | 展示一行来源与摘要，不展开多跳 |
| Dock 暂存任务 | 未来回来时恢复上下文 | 保存锚点指针与本机缓存状态 |

---

## 2. 产品定位与命名

建议将该能力命名为：**Knowledge Anchor / 知识锚点 / 思源锚点**。

任务卡中的呈现建议如下：

```text
任务标题
任务描述 / Markdown 内容

来源  思源：/项目资料/产品设计/悬浮窗联动方案
```

桌面端 hover 或移动端点击后，弹出 NanoFlow 自己渲染的预览层：

```text
思源块  /项目资料/产品设计/悬浮窗联动方案#某个具体块      打开思源   刷新

这里是 targetId 对应的具体思源块摘要正文
- 子块 1
- 子块 2
更多内容请打开思源
```

点击“打开思源”时，使用：

```text
siyuan://blocks/{blockId}?focus=1
```

---

## 3. 核心产品原则

### 3.1 Source of Truth 原则

思源是原块事实源，NanoFlow 只保存：

1. 指向思源块的稳定标识。
2. 用于显示的轻量元数据。
3. 当前设备本地缓存的只读预览。

### 3.2 执行优先原则

Knowledge Anchor 的作用是降低“切出任务上下文”的摩擦，而不是把用户引导回长时间阅读。任何预览层都要服务于任务推进，而不是制造新的信息漫游。

### 3.3 降级优先原则

如果当前环境无法安全访问思源内核，本功能仍需保持可用：

1. 能显示锚点。
2. 能打开原块深链。
3. 如果存在本地缓存，则优先展示缓存。
4. 不因为思源不可达而阻塞任务工作流。

### 3.4 只读优先原则

在 read-only 能力稳定之前，不开放写回路径。所有写回能力都必须是用户显式选择加入（opt-in），而不是默认开启。

---

## 4. 关键约束与物理边界

### 4.1 Web 平台约束

当 NanoFlow 运行在公网 HTTPS PWA 环境时，浏览器会拦截页面对 `http://127.0.0.1:6806` 的直接请求。这意味着：

1. **前端页面不能直接 fetch 本地 HTTP 思源 API**。
2. 这不是普通 CORS 配置问题，而是 Mixed Content 硬限制。
3. 因此“网页直连思源内核”不能作为公网 HTTPS 版本的主路径。

### 4.2 设备与运行时差异

| 维度 | 桌面浏览器 | 移动浏览器 / TWA | 本地桌面壳（未来） |
|------|------|------|------|
| Hover | 支持 | 不支持 | 支持 |
| 访问扩展 Relay | 支持 | 基本不可依赖 | 不需要 |
| 访问本地思源内核 | 需 Relay | 默认不可依赖 | 可实现 |
| 推荐交互 | Hover Popover | Bottom Sheet | Hover Popover |

### 4.3 安全边界

1. 思源 token 只能保存在当前设备，不进入 Supabase。
2. 思源最小支持版本建议为 `>= 3.6.2`，推荐使用最新版。
3. 首版只允许访问块预览所需接口，不暴露通用 SQL、文件或 snippet 执行能力。
4. 扩展 Relay 必须验证消息来源，只接受 NanoFlow 可信 origin。
5. 扩展 Relay 不转发任意 URL，只接受结构化 blockId 请求。
6. 任何预览内容进入 DOM 前必须走 NanoFlow 现有 Markdown / XSS 防护链路。

### 4.4 NanoFlow Hard Rules 约束

该功能必须继承 NanoFlow 现有架构底线：

1. `ExternalSourceLink.id` 使用客户端 `crypto.randomUUID()` 生成。
2. 锚点元数据走 Offline-first：本地先写、UI 即时更新、后台同步、失败进入 RetryQueue。
3. 冲突策略沿用 LWW，以 `updatedAt` 为准。
4. 状态管理使用 Angular Signals，不引入 NgRx 或新的全局 RxJS Store。
5. 服务层直接依赖具体子服务或现有 Store，禁止新增门面 Store 聚合类。
6. 移动端仍默认 Text 视图，不因锚点预览强制加载 Flow / GoJS。

### 4.5 建议配置常量

| 常量 | 值 | 用途 |
|------|------|------|
| `SIYUAN_CONFIG.MAX_PREVIEW_CHILDREN` | `10` | 单次预览最多展示的子块数量 |
| `SIYUAN_CONFIG.MAX_PREVIEW_CHARS` | `1200` | 任务卡 Popover / Sheet 单次展示的摘要字符上限 |
| `SIYUAN_CONFIG.PREVIEW_FETCH_TIMEOUT_MS` | `TIMEOUT_CONFIG.QUICK` | 单次块预览请求超时，复用 `src/config/timeout.config.ts` 中的 5000ms 快速操作超时 |
| `SIYUAN_CONFIG.CACHE_STALE_MS` | `86400000` | 本机预览缓存陈旧提示阈值，默认 24 小时 |
| `SIYUAN_CONFIG.MAX_PREVIEW_CACHE_ENTRIES` | `200` | 当前用户本机最多保留的思源预览缓存条数 |
| `SIYUAN_CONFIG.HOVER_OPEN_DELAY_MS` | `300` | 桌面端悬浮意图延迟，避免鼠标扫过即请求 |
| `SIYUAN_CONFIG.HOVER_CLOSE_GRACE_MS` | `150` | 鼠标从锚点移向浮层时的关闭宽限期 |
| `SIYUAN_CONFIG.POPOVER_MAX_WIDTH_PX` | `420` | 桌面悬浮预览最大宽度 |
| `SIYUAN_CONFIG.POPOVER_MAX_HEIGHT_PX` | `360` | 桌面悬浮预览最大高度，超出后内部滚动 |

### 4.6 块级精确预览结论

经 Context7 查询思源 API 能力后，本案确认：**任务卡可以精确预览某一个思源块**。实现前提是锚点保存的 `targetId` 必须是思源 block ID，预览请求只以该 ID 为根调用思源内核的块级接口。

可行调用链：

1. `/api/block/getBlockKramdown`：按 `id` 获取该块自身的 Kramdown 内容。
2. `/api/block/getChildBlocks`：按同一个 `id` 获取直接子块，用 `MAX_PREVIEW_CHILDREN` 截断。
3. `/api/filetree/getHPathByID`：按 `id` 获取人类可读路径，用于任务卡来源行。
4. `/api/attr/getBlockAttrs`：按 `id` 获取块属性，用于标题、别名、标签等轻量元数据增强。

边界要求：

1. 预览根必须是 `ExternalSourceLink.targetId`，禁止 provider 自行扩大到文档级、笔记本级或全库搜索。
2. 子块只取一层，且最多 `SIYUAN_CONFIG.MAX_PREVIEW_CHILDREN` 条。
3. 正文最多渲染 `SIYUAN_CONFIG.MAX_PREVIEW_CHARS` 个字符；超过时展示“更多内容请打开思源”。
4. `getBlockKramdown` 返回内容只进入本机缓存和安全渲染链路，不进入 Supabase。
5. 若 block ID 失效，状态应落为 `block-not-found`，任务卡仍保留解除关联与打开思源入口。

### 4.7 悬浮浮层实现结论

经 Context7 查询 Angular CDK Overlay 能力后，本案确认：桌面端“鼠标悬浮显示对应思源块预览”应使用 **Angular CDK Overlay / Connected Overlay**，而不是浏览器原生 `title`、纯 CSS tooltip 或阻塞式 modal。

原因：

1. 预览内容需要异步加载、刷新、错误态和“打开思源”等交互，不适合 `title` 或只读 tooltip。
2. `FlexibleConnectedPositionStrategy` 可以把浮层绑定到当前锚点元素，并在视口边缘自动调整位置。
3. `OverlayRef` / `CdkConnectedOverlay` 支持独立销毁、键盘事件、外部点击和滚动策略，便于处理快速切换锚点的竞态。
4. 该方案只影响桌面任务卡与共享 `knowledge-anchor` 组件，不要求移动端加载 Hover 逻辑。

---

## 5. 用户体验设计

### 5.1 桌面端

任务卡显示一个精简锚点行：

```text
📎 思源 /产品/需求分析/任务悬浮窗方案
```

交互规则：

1. `mouseenter` 超过 `SIYUAN_CONFIG.HOVER_OPEN_DELAY_MS` 后打开预览。
2. `mouseleave` 后等待 `SIYUAN_CONFIG.HOVER_CLOSE_GRACE_MS` 再关闭。
3. 指针进入预览层时保持打开。
4. `Esc` 关闭。
5. 点击“打开思源”时直接拉起深链。
6. 点击“刷新”时触发重新取数并更新本地缓存。
7. Popover 内容必须以当前锚点 `targetId` 为根；同一文档内其他块不自动并入预览。
8. 如果该块有父文档路径，路径只作为位置提示，不改变预览根。

### 5.1.1 桌面悬浮样式

任务卡锚点以轻量 chip / source row 呈现，鼠标悬浮后显示一个与该锚点连接的浮层：

```text
┌ 任务卡 ──────────────────────┐
│ 任务标题                      │
│ 📎 思源 /产品/需求分析/具体块 │  ← hover origin
└──────────────────────────────┘
          ┌─ 知识锚点预览 ─────────────────┐
          │ 思源块 /产品/需求分析#具体块    │
          │ 具体块摘要正文                  │
          │ - 直接子块 1                    │
          │ - 直接子块 2                    │
          │ 打开思源  刷新                  │
          └─────────────────────────────────┘
```

样式要求：

1. 锚点 chip hover 时显示轻微高亮、边框或阴影，表达“可预览”而不是“已选中”。
2. 浮层使用任务卡同主题色、圆角、阴影和细边框；暗色模式跟随全局主题。
3. 浮层宽度不超过 `SIYUAN_CONFIG.POPOVER_MAX_WIDTH_PX`，高度不超过 `SIYUAN_CONFIG.POPOVER_MAX_HEIGHT_PX`。
4. 正文区域内部滚动，浮层本身不推动任务列表布局。
5. loading 态显示骨架屏或“正在读取思源块”，不阻塞任务卡点击、拖拽和编辑。
6. error / cache-only 态必须保留“打开思源”入口。
7. 同一页面只保留一个活跃预览浮层；悬浮到另一个锚点时复用浮层并切换 `linkId` / `blockId`。

无障碍与输入方式：

1. 鼠标悬浮是桌面主路径；键盘 `focus` 到锚点时也应可打开预览。
2. `Esc` 关闭浮层后，焦点回到触发锚点。
3. 浮层内按钮可通过 Tab 访问；离开锚点与浮层后按关闭宽限期收起。
4. 移动端不模拟 hover，仍使用 Bottom Sheet。

### 5.2 移动端

移动端无 hover，因此交互改为：

1. 单击锚点：打开底部 Sheet 预览。
2. 长按锚点：弹出操作菜单。

操作菜单建议包含：

1. 预览
2. 打开思源
3. 刷新缓存
4. 解除关联

### 5.3 Focus 与 Parking Dock

在 Focus 和 Dock 中，Knowledge Anchor 必须更克制：

1. 只显示一行“思源上下文”入口。
2. 预览默认展示标题、路径、摘要，不展开大段正文。
3. 不在 Focus 中暴露块内多跳导航，避免用户掉入阅读流。
4. “打开思源”保留，以便需要时跳回原知识源。

### 5.4 多锚点策略

数据模型从第一版就按多锚点设计，但产品入口建议分两阶段：

1. **MVP 默认单锚点**：降低 UI 与排序复杂度。
2. **Phase 2 以后支持多锚点**：通过 role 区分 `context/spec/reference/evidence/next-action`。

---

## 6. 数据模型设计

建议不要把思源链接直接塞进任务 Markdown 作为唯一结构，而是单独维护外部来源层：

```text
Task
 └── ExternalSourceLink[]
      └── SiyuanBlockLink
```

### 6.1 同步模型

需要把“可跨设备共享的信息”与“仅本机持有的信息”分开：

```ts
type ExternalSourceRole =
  | 'context'
  | 'spec'
  | 'reference'
  | 'evidence'
  | 'next-action';

type ExternalSourceLink = {
  id: string; // crypto.randomUUID()
  taskId: string;
  sourceType: 'siyuan-block';
  targetId: string; // 思源 block id
  uri: string; // siyuan://blocks/{id}?focus=1
  label?: string; // 显示名
  hpath?: string; // 人类可读路径
  role?: ExternalSourceRole;
  sortOrder: number; // 多锚点排序；MVP 默认 0
  deletedAt?: string | null; // 软删除，ISO 8601 timestamptz 字符串，参与同步
  createdAt: string;
  updatedAt: string;
};

type LocalSiyuanPreviewCache = {
  linkId: string;
  blockId: string;
  hpath?: string;
  plainText?: string;
  kramdown?: string;
  excerpt?: string;
  childBlocks?: Array<{ id: string; content: string; type: string }>;
  fetchedAt: string;
  sourceUpdatedAt?: string;
  fetchStatus: 'idle' | 'loading' | 'ready' | 'error';
  errorCode?:
    | 'not-configured'
    | 'runtime-not-supported'
    | 'extension-unavailable'
    | 'kernel-unreachable'
    | 'token-invalid'
    | 'block-not-found'
    | 'render-blocked' // 内容被安全渲染链路拦截
    | 'unknown';
};
```

`sortOrder` 采用升序排序；MVP 单锚点固定为 `0`，多锚点启用后由同一任务内的活跃锚点维护稳定顺序。

`LocalSiyuanPreviewCache.linkId` 标识 NanoFlow 锚点关系，`LocalSiyuanPreviewCache.blockId` 标识具体思源块。两者同时存在是为了在同一任务替换锚点、多锚点排序或迟到响应返回时防止跨块误命中。`LocalSiyuanPreviewCache.blockId` 必须等于 `ExternalSourceLink.targetId`。

`render-blocked` 表示预览内容被安全渲染链路拦截，用户仍可通过深链打开思源原块。

### 6.2 同步与本地存储边界

**默认同步到 Supabase**：

1. `id`
2. `taskId`
3. `sourceType`
4. `targetId`
5. `uri`
6. `label`
7. `hpath`
8. `role`
9. `sortOrder`
10. `deletedAt`
11. `createdAt` / `updatedAt`

**默认仅保存在本机**：

1. 思源 `baseUrl`
2. 思源 `token`
3. 正文缓存
4. 子块缓存
5. 资源文件 URL
6. 最后错误状态

这样既维持多设备间的锚点一致，又不把知识正文和凭证带上云端。

### 6.3 Supabase 表建议

建议新增独立表承载外部来源链接，避免污染 `tasks.content`：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `text` | 客户端 `crypto.randomUUID()` 字符串 |
| `user_id` | `uuid` | RLS 隔离字段 |
| `task_id` | `uuid` | 关联任务，引用 `public.tasks(id)`；任务 ID 仍由客户端 `crypto.randomUUID()` 生成 |
| `source_type` | `text` | 首版固定为 `siyuan-block` |
| `target_id` | `text` | 思源 block ID |
| `uri` | `text` | 深链 URI |
| `label` | `text nullable` | 显示名 |
| `hpath` | `text nullable` | 人类可读路径 |
| `role` | `text nullable` | 锚点角色 |
| `sort_order` | `integer` | 多锚点排序 |
| `deleted_at` | `timestamptz nullable` | 软删除 |
| `created_at` | `timestamptz` | 创建时间 |
| `updated_at` | `timestamptz` | LWW 与增量同步字段 |

约束建议：

1. `source_type` 首版只允许 `siyuan-block`。
2. `target_id` 必须匹配思源块 ID 格式。
3. MVP 使用 UNIQUE 约束防止同任务重复绑定同一活跃块；多 role 场景启用后，允许同一块以不同 role 出现。
4. RLS 策略必须按 `user_id = auth.uid()` 隔离。

UNIQUE 约束建议：

```sql
-- MVP：同任务同块只能有一个活跃锚点
CREATE UNIQUE INDEX external_source_links_unique_active_target
ON external_source_links USING btree (user_id, task_id, source_type, target_id)
WHERE deleted_at IS NULL;

-- 多 role：同任务同块允许按 role 区分
CREATE UNIQUE INDEX external_source_links_unique_active_target_role
ON external_source_links USING btree (user_id, task_id, source_type, target_id, COALESCE(role, 'context'))
WHERE deleted_at IS NULL;
```

从 MVP 迁移到多 role 时，应先回填空 `role` 为默认 `context`，再在同一迁移中删除 MVP 唯一索引并创建多 role 唯一索引；迁移前需要检查是否存在同任务同块的历史重复数据。

### 6.4 本地 IndexedDB 建议

本地缓存建议拆成三类 key，便于单独清理：

```text
external-source-links:{userId}
siyuan-preview-cache:{userId}:{linkId}:{blockId}
siyuan-local-config:{userId}
```

> **实现注意**：当前实现已经采用 `siyuan-preview-cache:{userId}:{linkId}:{blockId}`。如果从旧原型迁移，只允许读取并补写 `siyuan-preview-cache:{linkId}:{blockId}` 这类本机旧 key，不能把旧缓存同步到云端。

清理策略：

1. 删除锚点时软删除云端指针，并删除当前设备该用户下该 `linkId` 的所有 `siyuan-preview-cache:{userId}:{linkId}:{blockId}`。
2. 每条 `siyuan-preview-cache:{userId}:{linkId}:{blockId}` 记录必须保存 `fetchedAt`、`blockId` 与可选 `sourceUpdatedAt`，用于判断缓存时效并防止跨块误命中。
3. 用户点击“清除本机缓存”时只清理 preview cache，不删除锚点。
4. 用户点击“忘记本机思源配置”时删除 token / baseUrl / runtimeMode，不影响已绑定锚点。

缓存迁移说明：

1. 如果该能力首次实现时尚未上线旧版 `siyuan-preview-cache:{linkId}` 或 `siyuan-preview-cache:{linkId}:{blockId}`，直接采用用户隔离新 key，无需迁移。
2. 如果已有旧版本机缓存，启动时可以按 `linkId -> ExternalSourceLink.targetId` 补写 `siyuan-preview-cache:{userId}:{linkId}:{blockId}`；无法确认 `blockId` 或 `userId` 的旧缓存必须丢弃。
3. 迁移只发生在当前设备本地，不产生云端同步，不影响锚点指针。
4. 对只匹配 `linkId` 或只匹配 `blockId` 的旧缓存，运行时按 cache miss 处理；后台清理可按 `CACHE_STALE_MS`、锚点删除事件、`MAX_PREVIEW_CACHE_ENTRIES` 上限或用户“清除本机缓存”统一回收，避免频繁替换锚点后本机缓存无界增长。

### 6.5 同步规则

| 操作 | 本地行为 | 云端行为 | 冲突规则 |
|------|------|------|------|
| 新增锚点 | 立即写入本地 Store 与 IndexedDB | 进入 3s 防抖同步 | ID 客户端生成，无需映射 |
| 更新 label / role / sortOrder | 立即更新 UI | 更新 `updated_at` | LWW |
| 解除关联 | 设置 `deletedAt`，UI 隐藏 | 同步软删除 | LWW，删除视为一次更新 |
| 刷新预览 | 更新本地缓存 | 不同步正文 | 不参与云端冲突 |

---

## 7. 架构设计

### 7.1 建议分层

建议新增独立的外部来源层，而不是耦合进任务正文组件内部。

```text
src/app/core/external-sources/
  external-source.model.ts
  external-source-link.store.ts
  external-source-link.service.ts
  external-source-cache.service.ts

src/app/core/external-sources/siyuan/
  siyuan-link-parser.ts
  siyuan-provider.interface.ts
  siyuan-extension-provider.ts
  siyuan-direct-provider.ts
  siyuan-preview.service.ts
  siyuan-preview-cache.service.ts

src/app/shared/components/knowledge-anchor/
  knowledge-anchor.component.ts
  knowledge-anchor-popover.component.ts
  knowledge-anchor-sheet.component.ts
```

职责边界：

| 模块 | 职责 | 不负责 |
|------|------|------|
| `external-source-link.store.ts` | Signals 状态、索引、派生选择器 | 访问思源 API |
| `external-source-link.service.ts` | 新增、更新、解除关联、同步协调 | 渲染预览正文 |
| `external-source-cache.service.ts` | 本地预览缓存读写与清理 | 保存 token |
| `siyuan-preview.service.ts` | 选择 provider、刷新预览、统一错误码 | 直接持久化云端指针 |
| `knowledge-anchor.component.ts` | 展示锚点入口与操作分发 | 解析思源协议细节 |

### 7.1.1 与现有能力的集成点

1. **任务卡**：读取当前任务的 `ExternalSourceLink[]`，MVP 仅展示第一个活跃锚点。
2. **Focus**：复用同一组件的 compact 模式，禁止自动展开完整预览。
3. **Parking Dock**：显示锚点摘要，帮助恢复上下文。
4. **同步服务**：将 `ExternalSourceLink` 纳入增量同步实体，但不把 preview cache 纳入云端同步。
5. **设置页**：管理本机连接配置、扩展状态、缓存清理。

### 7.2 Provider 抽象

前端不应该把“访问思源的方式”写死为 HTTP fetch，而应该用 provider 层隔离不同运行时：

```ts
interface SiyuanPreviewProvider {
  isAvailable(): Promise<boolean>;
  getBlockPreview(blockId: string, signal?: AbortSignal): Promise<{
    blockId: string;
    hpath?: string;
    plainText?: string;
    kramdown?: string;
    sourceUpdatedAt?: string;
    childBlocks?: Array<{ id: string; content: string; type: string }>;
    truncated: boolean; // 正文、子块或安全裁剪任一发生时为 true
  }>;
}
```

接口约束：

1. Provider 对外只返回 NanoFlow 需要的预览 DTO，不向组件暴露思源原始 API 响应。
2. `blockId` 必须先通过格式校验后再进入 provider。
3. 返回的 `blockId` 必须与入参 `blockId` 完全一致；调用方在写入缓存或更新 UI 前必须再次比对，不一致时丢弃响应。
4. `truncated = true` 表示任一截断发生：正文超过 `MAX_PREVIEW_CHARS`、直接子块超过 `MAX_PREVIEW_CHILDREN`，或 provider 因安全策略裁剪了不适合展示的内容。
5. provider 内部统一把思源 `{ code, msg, data }` 响应转换为 NanoFlow Result / error code。
6. `AbortSignal` 必须贯穿扩展消息和 direct fetch；调用方必须为每次悬浮 / Sheet 打开创建独立 `AbortController`，在锚点切换、Popover 关闭、组件销毁或用户手动刷新覆盖旧请求时调用 `abort()`。
7. 单次不匹配响应通常视为并发请求的迟到结果，对用户静默处理，只记录 debug 级信息；若同一 provider 连续返回不匹配 `blockId`，应按 provider bug 记录可脱敏诊断事件。
8. 组件不得知道 token、baseUrl、HTTP header 或扩展内部端口。
9. direct provider 仅允许在 `localhost` 开发环境或未来可信桌面壳中启用。

实现优先级：

1. `SiyuanExtensionProvider`：桌面浏览器主路径。
2. `SiyuanDirectProvider`：仅本地桌面壳/开发 localhost 等安全场景可用。
3. `CacheOnlyProvider`：降级路径。

### 7.2.1 Hover Popover 实现对策

桌面悬浮预览建议独立为 `KnowledgeAnchorPopoverService` 或组件内 presenter，负责把锚点 DOM 与预览浮层连接起来。根据 Context7 对 Angular CDK Overlay 的资料，推荐实现路径如下：

1. 使用 `Overlay` + `ComponentPortal` 创建 `knowledge-anchor-popover.component.ts`。
2. 使用 `FlexibleConnectedPositionStrategy` 绑定当前锚点元素，优先位置为锚点下方，备选位置为上方、右侧或左侧。
3. 开启 `withPush(true)` 和 viewport margin，避免浮层超出视口。
4. 使用 `reposition` 类滚动策略；任务列表滚动时浮层跟随锚点重新定位，锚点离开视口时关闭。
5. 不使用暗色 backdrop；悬浮预览不应阻塞任务卡其他操作。
6. 使用 `OverlayRef.keydownEvents()` 或 `CdkConnectedOverlay.overlayKeydown` 处理 `Esc`。
7. 使用 `OverlayRef.detach()` 关闭当前浮层，组件销毁时必须 `dispose()`。

Hover 状态机：

```text
idle
  -> hover-intent(linkId, blockId, originRef)
  -> opening
  -> loading | ready | error | cache-only
  -> closing-grace
  -> idle
```

状态机要求：

1. `hover-intent` 期间只启动延迟计时，不立刻请求思源。
2. 进入 `opening` 时记录 `{ linkId, blockId, originRef, controller, requestSeq }` 作为活跃请求状态。
3. `originRef` 只允许保存在 Popover service / component 的普通 class private property 中，不能写入 Signals Store。
4. 关闭浮层、切换锚点或 `ngOnDestroy()` 时，必须在调用 `OverlayRef.detach()` / `dispose()` 的同一个同步调用栈内把该 private property 显式置为 `undefined`，访问时使用 optional chaining，并依赖 TypeScript strict null checks 避免误用已脱离 DOM 的元素。
5. DOM 引用进入 Signals Store 会妨碍垃圾回收，也会把非序列化 UI 资源混入响应式业务状态，因此禁止这样做。
6. 浮层内容加载期间先读取本机缓存，再按 provider 能力后台刷新。
7. 鼠标从锚点进入浮层时取消关闭计时。
8. 鼠标离开锚点和浮层后进入 `closing-grace`，宽限期结束再关闭。
9. 新锚点触发时立即 abort 上一个请求，并用新锚点重设 Overlay origin。
10. 任何响应返回前必须比对当前活跃 `linkId` / `blockId` / `requestSeq`；不一致则静默丢弃。

同步清理与请求切换伪代码：

```ts
// 伪代码：强调同步顺序，不代表最终实现 API。
private originRef?: HTMLElement;
private activeRequest?: {
  linkId: string;
  blockId: string;
  controller: AbortController;
  requestSeq: number;
};
private requestSeq = 0;

closePopover(): void {
  this.overlayRef?.detach();
  this.originRef = undefined;
}

startHover(linkId: string, blockId: string, origin: HTMLElement): void {
  const requestSeq = ++this.requestSeq;
  this.activeRequest?.controller.abort();
  const controller = new AbortController();
  this.originRef = origin;
  this.activeRequest = { linkId, blockId, controller, requestSeq };
}
```

不建议使用 `MatTooltip` 承载该能力。原因是预览浮层需要异步状态、按钮、内部滚动、错误态和安全渲染链路，已经超出普通 tooltip 的语义。

### 7.3 运行时选择规则

```text
if desktop browser && extension available:
  use extension relay
else if trusted local runtime allows direct preview:
  use direct provider
else:
  use cache-only provider
```

### 7.4 错误码与用户文案

| 错误码 | 技术含义 | 用户文案 |
|------|------|------|
| `not-configured` | 当前设备未配置思源连接 | 当前设备未配置思源，仅可打开原块 |
| `runtime-not-supported` | 当前运行时不支持实时访问 | 当前环境不支持实时预览 |
| `extension-unavailable` | 未检测到扩展 Relay | 安装 NanoFlow 扩展后可实时预览 |
| `kernel-unreachable` | 思源内核不可达 | 未连接到思源，请确认思源已启动 |
| `token-invalid` | token 无效或权限不足 | 思源授权失效，请重新配置 |
| `block-not-found` | block ID 不存在或被删除 | 原块可能已删除或移动 |
| `render-blocked` | 内容被安全策略拦截 | 预览内容包含不支持或不安全内容 |
| `unknown` | 未分类错误 | 预览失败，可稍后重试 |

---

## 8. Mixed Content 解决方案设计

### 8.1 为什么不把本地 bridge 作为第一优先级

如果本地 bridge 只是：

```text
http://127.0.0.1:38465/nanoflow-siyuan/preview
```

那么 NanoFlow 的 HTTPS PWA 仍然无法直接访问它，问题没有消失，只是从 `6806` 换成了另一个本地 HTTP 端口。

如果把 bridge 升级为本地 HTTPS，又会立刻引入：

1. 本地证书签发与信任安装。
2. Windows/macOS/Linux 三端证书行为差异。
3. 用户首次配置门槛上升。
4. 排障成本显著增加。

因此，本案把本地 bridge 作为**后续安全增强路径**，而不是第一阶段的主突破方式。

### 8.2 优先方案：桌面浏览器扩展 Relay

扩展承担三件事：

1. 保存当前设备的思源连接信息。
2. 代表 NanoFlow 页面访问本地思源 API。
3. 只向 NanoFlow 页面暴露受限的只读预览能力。

推荐消息模型：

```ts
type SiyuanExtensionRequest = {
  type: 'nanoflow.siyuan.get-preview';
  requestId: string;
  payload: {
    blockId: string;
    includeChildren?: boolean;
    maxChildren?: number;
    maxChars?: number;
  };
};

type SiyuanExtensionResponse = {
  type: 'nanoflow.siyuan.preview-result';
  requestId: string;
  ok: boolean;
  data?: {
    blockId: string;
    hpath?: string;
    plainText?: string;
    kramdown?: string;
    sourceUpdatedAt?: string;
    attrs?: Record<string, string>;
    childBlocks?: Array<{ id: string; content: string; type: string }>;
    truncated: boolean;
  };
  errorCode?: string;
  errorMessage?: string;
};
```

扩展安全要求：

1. 如果采用 `externally_connectable`，只允许 NanoFlow 正式域名、本地开发域名和明确配置的预览域名；当前实现采用 content-script relay，因此由 `manifest.content_scripts.matches` 和 content-script 内部 origin allowlist 共同承担同等边界。
2. 扩展只暴露 `get-preview` / `test-connection` 等受限消息，不提供通用代理。
3. 扩展持有 token 时使用浏览器扩展 storage，并避免在 console、错误上报、消息响应中泄露。
4. 响应体只返回预览所需字段，不返回完整 API 原始响应。
5. 请求必须设置超时，并支持前端取消。
6. 为每次请求设置 `requestId`，超时后返回 `kernel-unreachable` 或 `unknown`。
7. 对返回的 `kramdown` 只做最小必要转换，不在扩展内注入 HTML。

扩展内部访问思源内核时统一使用：

```text
POST http://127.0.0.1:6806/api/{module}/{method}
Authorization: Token {local-token}
Content-Type: application/json
```

### 8.3 后续增强：本地 bridge / 桌面壳

当以下条件成立时，再推进本地 bridge：

1. 需要更强的 token 隔离。
2. 计划推出 NanoFlow 桌面壳或 Tauri/Electron 版本。
3. 希望提供比浏览器扩展更稳定的本机集成层。

此时 bridge 可以作为扩展后的第二跳，而不是直接暴露给网页。

---

## 9. 思源 API 使用边界

本节根据 Context7 查询到的 SiYuan API 文档补齐接口契约。思源本地内核默认监听：

```text
http://127.0.0.1:6806
```

通用约定：

1. API token 在思源 `设置 - 关于` 中获取。
2. 请求头使用 `Authorization: Token {token}`。
3. 请求体为 JSON，`Content-Type: application/json`。
4. API 响应统一为 `{ code: number, msg: string, data: unknown }`，`code === 0` 表示成功。
5. MVP 中 token 只能由扩展或可信本地运行时持有，NanoFlow 云端与 Supabase 不保存 token。

### 9.1 MVP 允许的接口

MVP 只允许访问：

| 接口 | 用途 | 请求体 | MVP 用法 |
|------|------|------|------|
| `/api/system/version` | 连接测试与版本检查 | 无 | 设置页“测试连接” |
| `/api/block/getBlockKramdown` | 读取块 Kramdown | `{ "id": blockId }` | 生成摘要与受限预览 |
| `/api/block/getChildBlocks` | 读取直接子块结构 | `{ "id": blockId }` | 展示子块列表骨架 |
| `/api/filetree/getHPathByID` | 读取人类可读路径 | `{ "id": blockId }` | 展示来源路径 |
| `/api/attr/getBlockAttrs` | 读取块属性 | `{ "id": blockId }` | 获取 `updated` 等元数据或用户自定义标记 |

#### 9.1.1 连接测试：`/api/system/version`

用于判断思源内核是否可达、token 是否有效、版本是否满足最低要求。

```http
POST /api/system/version
Authorization: Token {token}
Content-Type: application/json
```

成功响应：

```json
{
  "code": 0,
  "msg": "",
  "data": "3.6.1"
}
```

处理规则：

1. `code !== 0` 或 HTTP 非 2xx：显示连接失败。
2. 版本低于最低支持版本：允许保存配置，但预览能力标记为 unsupported。
3. 该接口只用于本机配置校验，不进入任务同步流程。

#### 9.1.2 块正文：`/api/block/getBlockKramdown`

```http
POST /api/block/getBlockKramdown
Authorization: Token {token}
Content-Type: application/json
```

请求体：

```json
{
  "id": "20260426123456-abc1234"
}
```

成功响应：

```json
{
  "code": 0,
  "msg": "",
  "data": {
    "id": "20260426123456-abc1234",
    "kramdown": "这里是思源块的 Kramdown 内容"
  }
}
```

MVP 处理规则：

1. `kramdown` 只进入本机缓存，不同步到 Supabase。
2. 预览默认从 `kramdown` 提取 `plainText` / `excerpt`，不直接注入 HTML。
3. 块属性尾标记、块引用、资源链接必须走安全转换链路。
4. 返回的 `data.id` 必须与请求 `blockId` 一致，否则视为异常响应。

#### 9.1.3 子块结构：`/api/block/getChildBlocks`

```http
POST /api/block/getChildBlocks
Authorization: Token {token}
Content-Type: application/json
```

请求体：

```json
{
  "id": "20260426123456-abc1234"
}
```

成功响应：

```json
{
  "code": 0,
  "msg": "",
  "data": [
    {
      "id": "20260426123500-child1",
      "type": "h",
      "subType": "h1"
    },
    {
      "id": "20260426123600-child2",
      "type": "l",
      "subType": "u"
    }
  ]
}
```

MVP 处理规则：

1. 只读取直接子块，不递归展开整棵树。
2. 子块正文如需展示，必须对单个子块再按需调用 `getBlockKramdown`，并限制数量。
3. 默认最多展示前 `SIYUAN_PREVIEW_CONFIG.MAX_CHILD_BLOCKS = 5` 个子块摘要，避免 hover 时触发大量请求。
4. 子块列表仅用于预览，不作为任务依赖关系或 NanoFlow 树结构。

#### 9.1.4 人类可读路径：`/api/filetree/getHPathByID`

```http
POST /api/filetree/getHPathByID
Authorization: Token {token}
Content-Type: application/json
```

请求体：

```json
{
  "id": "20260426123456-abc1234"
}
```

成功响应：

```json
{
  "code": 0,
  "msg": "",
  "data": "/项目资料/产品设计/悬浮窗联动方案"
}
```

MVP 处理规则：

1. `data` 作为 `ExternalSourceLink.hpath` 候选值。
2. 路径可同步到 Supabase，因为它是轻量定位元数据，不包含正文。
3. 如果路径读取失败，仍允许创建锚点，只显示 block ID 或用户手填 label。

#### 9.1.5 块属性：`/api/attr/getBlockAttrs`

```http
POST /api/attr/getBlockAttrs
Authorization: Token {token}
Content-Type: application/json
```

请求体：

```json
{
  "id": "20260426123456-abc1234"
}
```

成功响应形态：

```json
{
  "code": 0,
  "msg": "",
  "data": {
    "id": "20260426123456-abc1234",
    "updated": "20260428094500",
    "custom-nanoflow-role": "spec"
  }
}
```

MVP 处理规则：

1. 属性只作为预览元数据读取，不在 MVP 写回。
2. `custom-*` 属性可以作为未来 opt-in 写回的兼容点，但首版不主动设置。
3. 如果存在可用更新时间字段，可映射到 `sourceUpdatedAt` 用于缓存陈旧提示。

调用限制：

1. 每次预览默认只取当前块与一层子块。
2. 子块数量通过 `SIYUAN_CONFIG.MAX_PREVIEW_CHILDREN = 10` 控制，超过后显示“更多内容请打开思源”。
3. API 调用必须带超时与取消信号。
4. 不在前端持久化原始 API 响应，只保存裁剪后的预览缓存。

### 9.1.1 精确块预览调用对策

Context7 对思源 API 的查询结果显示，`/api/block/getBlockKramdown`、`/api/block/getChildBlocks`、`/api/filetree/getHPathByID`、`/api/attr/getBlockAttrs` 都以 block ID 作为核心入参，并通过 `Authorization: Token ...` 鉴权。因此，任务卡预览可以稳定落到某一个具体块，而不是只能预览整篇文档。

推荐 provider 内部流程：

1. 输入校验：只接受已经通过 `siyuan-link-parser` 校验的 `blockId`。
2. 并行读取：
   - `getBlockKramdown(id)` 取当前块正文。
   - `getHPathByID(id)` 取路径。
   - `getBlockAttrs(id)` 取轻量属性。
3. 条件读取：仅当 UI 需要展开摘要时调用 `getChildBlocks(id)`，并按 `MAX_PREVIEW_CHILDREN` 截断。
4. 裁剪转换：把 Kramdown 转为 `plainText` / `excerpt`，按 `MAX_PREVIEW_CHARS` 截断。
5. 安全输出：只返回结构化预览对象，不返回原始 API 响应、token、baseUrl 或未消毒 HTML。
6. 缓存写入：以 `siyuan-preview-cache:{linkId}:{blockId}` 写入本机缓存。

失败处理：

1. `getBlockKramdown` 返回不存在或权限错误时，优先映射为 `block-not-found` 或 `token-invalid`。
2. `getChildBlocks` 失败不应导致整个预览失败；可以只显示当前块正文并提示子块不可用。
3. `getHPathByID` 失败不应阻塞预览；任务卡可退回显示 `label` 或短 block ID。
4. 任一接口超时后必须通过 `AbortSignal` 取消剩余请求。
5. 组件或预览服务必须维护当前活跃请求状态，例如 `{ linkId, blockId, controller, requestSeq }`。
6. 活跃请求状态使用普通 class private property，不写入 Signal；每次新 hover 事件以“递增 requestSeq -> abort 旧 controller -> 创建新 controller -> 一次性替换 activeRequest”的顺序更新。
7. 上述更新必须位于同一个同步代码块中完成，不在中途 `await`；浏览器主线程模型下不需要额外 mutex，但不能把递增、abort 和替换拆散到多个异步回调。
8. 如果底层通道无法真正取消请求，响应返回时仍必须与该活跃状态比对。
9. 响应处理必须同时比对 `linkId`、`blockId`、`controller` 引用或 `requestSeq`；只比对 `blockId` 不足以覆盖 abort 传播与状态替换之间的窄窗口竞态。
10. 比对不一致的迟到结果必须丢弃，避免 hover 快速切换造成过期预览覆盖当前锚点。

示例：用户先悬浮任务 A 的锚点 `blockId=abc`，随后快速悬浮任务 B 的锚点 `blockId=xyz`。如果 A 的响应在 B 的请求开始后才返回，前端必须因当前活跃 `blockId` 已变为 `xyz` 而丢弃 A 的响应。

### 9.2 MVP 禁止的接口

MVP 不开放：

1. `/api/query/sql`
2. `/api/snippet/*`
3. `/api/file/*`
4. 任意写接口（除未来可选的 `setBlockAttrs`）
5. 任意资源文件代理或附件下载。
6. 通过 Kramdown 间接加载远程脚本、iframe 或未消毒 HTML。

### 9.3 链接接入方式

MVP 的接入入口建议保持极简：

1. 用户在思源中复制块超链接。
2. 粘贴到 NanoFlow 任务的“关联思源块”输入框。
3. NanoFlow 解析 block ID。
4. 通过 provider 验证可读性。
5. 成功后创建锚点。

支持输入：

```text
siyuan://blocks/20260426123456-abc1234
siyuan://blocks/20260426123456-abc1234?focus=1
20260426123456-abc1234
```

解析规则：

1. block ID 格式校验：
   - 正则：`^\d{14}-[a-z0-9]{7}$`。
   - 形态：`YYYYMMDDHHmmss-xxxxxxx`。
   - 后缀：必须正好 7 位，每一位允许小写字母 `a-z` 或数字 `0-9`。
   - 大写处理：正则字符类天然排除大写字母；输入中出现大写字母时直接拒绝，不做自动 normalize。
   - 有效示例：`20260426123456-abc1234`。
2. 接受 `siyuan://blocks/{id}` 与裸 block ID；`siyuan://blocks/{id}` 只提取 path 中的 `{id}`，忽略未知 query 参数。
3. 保存时统一生成规范 URI：`siyuan://blocks/{id}?focus=1`。
4. 去除首尾空白，拒绝包含路径穿越、换行或非预期协议的输入；采用白名单策略，允许的完整协议前缀仅为 `siyuan://`，裸 ID 只能匹配思源块 ID 格式；其他协议一律拒绝，包括 `javascript:`、`data:`、`file:`、`http:`、`https:`、`vbscript:`、`about:`。
5. 原始输入不得直接回显为 HTML；错误提示只展示经过转义的文本。
6. 粘贴普通文本但无法解析 block ID 时，不自动创建锚点，并提示用户粘贴思源块链接。

### 9.4 预览取数编排

单次预览刷新建议按以下顺序执行：

```text
1. getHPathByID(blockId)
2. getBlockAttrs(blockId)
3. getBlockKramdown(blockId)
4. getChildBlocks(blockId)        // includeChildren=true 时才执行
5. 可选：对前 N 个子块按需 getBlockKramdown(childId)
```

编排约束：

1. `getHPathByID` 和 `getBlockAttrs` 失败不应阻断 `getBlockKramdown`。
2. `getBlockKramdown` 失败时预览刷新整体失败，并保留旧缓存。
3. 子块请求失败只降级为“不展示子块摘要”。
4. hover 自动刷新必须有并发去重：同一 `blockId` 同一时刻只允许一个刷新请求。
5. 超时配置：
   - 初始实现必须直接使用 NanoFlow 既有 `TIMEOUT_CONFIG.QUICK`（5000ms）或扩展侧同等配置。
   - 只有基准测试证明本地内核需要不同超时时，才新增 `SIYUAN_PREVIEW_CONFIG.TIMEOUT_MS` 这类命名配置。
   - 基准证据至少应包含本机 p95 延迟、超时率和样本量。
   - 不得新增裸超时魔数。

### 9.5 错误码映射

| 场景 | NanoFlow errorCode | 用户提示 |
|------|------|------|
| 未配置 token / baseUrl | `not-configured` | 当前设备未配置思源连接 |
| 当前运行时不能访问实时预览 | `runtime-not-supported` | 当前环境仅支持缓存预览或打开思源 |
| 浏览器扩展不可用 | `extension-unavailable` | 未检测到 NanoFlow 思源扩展 |
| 思源内核不可达或请求超时 | `kernel-unreachable` | 无法连接本机思源内核 |
| token 无效或被拒绝 | `token-invalid` | 思源授权失败，请重新配置 token |
| 块不存在或无权限读取 | `block-not-found` | 未找到该思源块 |
| API 响应结构不符合预期 | `unknown` | 预览失败，可稍后重试 |

错误处理要求：

1. 所有错误都必须可降级，不阻塞任务编辑、Focus 或 Dock。
2. 日志不得输出 token、完整正文或未脱敏的 API 响应体。
3. UI 上优先展示可操作建议，例如“打开思源”“重新配置”“仅使用缓存”。

---

## 10. 预览与渲染策略

### 10.1 首版渲染原则

思源返回的是 Kramdown，不应在首版直接按完整 HTML 嵌入。首版建议采用**摘要优先、保守渲染**：

1. 优先产出 `plainText` 摘要。
2. 如果存在安全可控的 Kramdown 转换，再展示有限 Markdown。
3. 继续复用 NanoFlow 现有 Markdown 安全渲染链路。
4. 保留 DOMPurify 等现有 XSS 防护。

### 10.2 首版转换范围

1. 删除块属性尾标记，例如 `{: id="..."}`。
2. 把块引用 `((blockId "文本"))` 转成可点击深链。
3. 子块优先以结构化列表展示，而不是完整富文本。
4. 图片和资源文件首版只显示占位，不做代理加载。

### 10.3 缓存策略

悬浮预览遵循：

```text
先显示本地缓存
后台尝试拉取最新预览
成功后局部更新
失败则保留旧缓存并提示状态
```

缓存策略建议：

1. 默认仅当前设备保存缓存。
2. 缓存包含抓取时间与源块更新时间。
3. 支持手动刷新。
4. 后续在桌面扩展路径可选接入事件通知或轮询失效检查。

---

## 11. 状态设计

Knowledge Anchor 至少要覆盖以下状态：

| 状态 | 展示 | 用户操作 |
|------|------|------|
| 已关联，缓存可用，内核可连 | 直接展示缓存并后台刷新 | 打开思源 / 刷新 / 解除关联 |
| 已关联，缓存可用，内核不可连 | 展示缓存 + “当前设备未连接思源” | 打开思源 / 配置连接 |
| 已关联，无缓存，扩展未安装 | 显示“未安装扩展，无法实时预览” | 安装扩展 / 打开思源 |
| 已关联，无缓存，token 无效 | 显示鉴权错误 | 重新配置 |
| 已关联，块不存在 | 显示失效锚点状态 | 打开思源 / 解除关联 |
| 已关联，路径获取失败但块正文可用 | 显示短 block ID + 块摘要 | 打开思源 / 刷新 |
| 已关联，子块获取失败但当前块可用 | 显示当前块摘要 + 子块不可用提示 | 打开思源 / 刷新 |
| 未配置思源 | 只保留深链与说明 | 配置连接 |

### 11.1 Focus 降噪规则

在 Focus 模式下：

1. 不自动展开大段正文。
2. 不展示块内多层跳转。
3. 优先展示摘要与“打开思源”。
4. 所有额外交互都必须少于普通任务卡。

---

## 12. 本地配置设计

思源连接配置必须按设备本地保存，不进入云端同步。

建议配置项：

```text
siyuan.runtimeMode = extension-relay | direct | cache-only
siyuan.baseUrl = http://127.0.0.1:6806
siyuan.token = local-only secret
siyuan.previewStrategy = excerpt-first
siyuan.autoRefresh = on-hover | manual
```

建议实现时把预览数量与摘要长度限制集中为命名配置；超时初始阶段直接使用 `TIMEOUT_CONFIG.QUICK`：

```ts
const SIYUAN_PREVIEW_CONFIG = {
  MAX_CHILD_BLOCKS: 5,
  MAX_EXCERPT_CHARS: 500,
} as const;
```

超时配置规则以 §9.4「预览取数编排」中的“超时配置”为 Single Source of Truth（单事实源）；本节不重复定义超时常量。

建议在设置页增加：

1. 连接方式说明。
2. 扩展安装提示。
3. 测试连接。
4. 清除本机缓存。
5. 关闭实时预览，仅保留深链。

本地配置 UX 要求：

1. token 输入框默认隐藏内容，并提供“清除本机授权”。
2. 测试连接只返回成功 / 失败与错误类型，不显示 token。
3. 如果用户关闭实时预览，所有 provider 强制进入 cache-only / deep-link 模式。
4. 配置项变更不触发云端同步。

---

## 13. 实施路线图

### Phase 0：锚点绑定与深链回跳

目标：先让任务“挂得上、点得开”。

交付：

1. 设置页增加 SiYuan 集成说明与本机配置入口。
2. 支持解析 `siyuan://blocks/{id}`。
3. 任务卡新增“关联思源块”。
4. 任务卡展示锚点行。
5. 点击可打开思源原块。

验收：

1. 粘贴思源块链接后可正确解析 block ID。
2. 任务卡显示锚点。
3. 点击可拉起 `siyuan://blocks/{id}?focus=1`。
4. 离线状态下新增锚点后 UI 立即生效，恢复网络后可同步。

### Phase 1：预览模型与缓存框架

目标：完成预览数据结构、缓存层和状态 UI，但不强依赖公网 HTTPS 实时取数。

交付：

1. 外部来源数据模型。
2. 本地预览缓存。
3. 桌面 Hover Popover / 移动端 Bottom Sheet。
4. loading / error / disconnected / cache-only 状态。
5. 保守渲染链路。

验收：

1. 有缓存时可立即展示。
2. 缓存命中必须同时匹配 `linkId` 与 `blockId`；只匹配其中一个时按 cache miss 处理并重新拉取。
3. 当同一 `linkId` 的 `targetId` 明确变更时，应立即清理旧 `blockId` 缓存；无法确认归属的孤儿缓存再通过 `CACHE_STALE_MS` 或 `MAX_PREVIEW_CACHE_ENTRIES` 后台回收。
4. 无缓存时能显示正确状态，不阻塞任务操作。
5. 桌面 hover 到锚点后显示连接到该锚点的浮层，从锚点移动到浮层不闪烁。
6. Focus / Dock 中为缩减版预览。
7. 清除本机缓存不会删除云端锚点。

### Phase 2：桌面浏览器扩展 Relay

目标：让公网 HTTPS PWA 在桌面浏览器中获得实时预览能力。

交付：

1. NanoFlow 扩展 Relay。
2. 扩展内思源连接配置与测试连接。
3. 前端 provider 接入扩展通道。
4. Hover Popover 在线刷新接入扩展 provider。
5. 只读 allowlist API 访问。

验收：

1. HTTPS NanoFlow 页面可通过扩展读取 `targetId` 对应的精确思源块预览。
2. 未安装扩展时自动降级，不报致命错误。
3. token 不进入 NanoFlow 应用存储。
4. 扩展拒绝非 NanoFlow 可信 origin 的消息。
5. 扩展响应包含 `blockId`，前端丢弃与当前锚点不一致的迟到响应。
6. 快速在多个任务卡锚点间移动鼠标时，浮层只展示最后一个活跃锚点的块预览。

### Phase 3：移动端 / Focus / Dock 完整适配

目标：确保多端与专注场景不被打断。

交付：

1. 移动端底部 Sheet 与长按菜单。
2. Focus / Dock 的最小干扰展示。
3. 多锚点 UI（可选）。
4. 缓存陈旧提示与手动刷新优化。

验收：

1. 手机端无需 hover 也能完成查看与跳转。
2. Focus 模式不被知识预览抢走注意力。
3. Dock 任务可快速查看来源上下文。
4. 多锚点在 UI 上可排序、可标注 role，并保持 MVP 单锚点兼容。

### Phase 4：安全增强与可选写回

目标：在主路径稳定后，再处理更重的系统能力。

交付：

1. 可选本地 bridge / 桌面壳集成。
2. 可选 `setBlockAttrs` 反向写回。
3. 可选同步更丰富的摘要快照开关。

验收：

1. 写回能力必须显式 opt-in。
2. 所有写回都可关闭并可回滚。
3. 没有 bridge 的环境依然可工作。

### Phase Gate

每个阶段进入下一阶段前，必须满足：

1. 当前阶段的降级路径已经可用。
2. 没有把 token、正文缓存或原始 API 响应同步到 Supabase。
3. Focus / Dock / 移动端不存在阻塞性回归。
4. `external_source_links` 的云端写入必须证明旧 pending payload 不会覆盖较新的远端行，尤其是 `target_id`、`uri`、`role`、`sort_order`、`deleted_at`。
5. 相关测试已覆盖错误处理、离线同步、provider fallback、安全校验等关键分支；新增服务层方法、provider 选择、错误码映射、同步 payload 序列化这些核心分支覆盖率不低于 80%，且“建议测试覆盖”表中每一层至少有 1 个直接覆盖用例。

---

## 14. 验证方式

### 14.1 功能验收

1. 任务可以绑定一个思源块并显示锚点。
2. 桌面端可以悬浮查看连接到当前锚点的浮层预览，移动端可以点击查看预览。
3. 预览内容精确来自 `targetId` 对应的思源块，不展示整篇文档摘要。
4. 鼠标从锚点移动到浮层时浮层保持打开，离开后按关闭宽限期收起。
5. 快速悬浮多个锚点时，不出现旧块内容覆盖当前浮层。
6. 点击“打开思源”可回到原块。
7. 思源不可达时，任务工作流仍可继续。
8. 解除关联后当前任务不再显示该锚点，刷新后状态保持一致。
9. 多设备登录时可看到同一锚点指针，但不会同步另一台设备的 token 与正文缓存。
10. 粘贴非法文本、错误 URI、非思源 block ID 时不会创建锚点。
11. 预览刷新失败时保留旧缓存并显示可恢复状态。

### 14.2 架构验收

1. 思源 token 不进入 Supabase。
2. 预览缓存默认不进入 Supabase。
3. 外部来源层不直接耦合任务 Markdown 内容。
4. Provider 抽象可以区分 extension/direct/cache-only 三种模式。
5. 锚点新增、更新、删除走本地先写与 LWW 同步路径。
6. 预览缓存 key 同时包含 `userId`、`linkId` 与 `blockId`，避免账号切换、同任务多锚点或锚点替换后的跨块误命中。
7. 云端写入具备 stale-write 防护：旧的 pending upsert / RPC payload 不得复活已删除锚点，也不得回滚较新的 `role`、`sortOrder` 或 `targetId`。
8. 不新增门面 Store，不破坏现有 Task / Project / Connection Store 边界。

### 14.3 安全验收

1. 首版不暴露通用 SQL 或文件接口。
2. 不允许从 NanoFlow 页面直接访问本地 HTTP 思源内核作为公网主路径。
3. 只在安全运行时中启用实时预览。
4. 扩展 Relay 只接受可信 origin 和 allowlist 消息类型。
5. Kramdown / Markdown 预览经过安全渲染与 XSS 防护。
6. 错误日志不包含 token、原始正文或本机路径敏感信息。
7. token 只存在扩展或可信本地运行时，不进入 Supabase、IndexedDB 预览缓存或日志。

### 14.4 建议测试覆盖

| 层级 | 覆盖点 |
|------|------|
| 单元测试 | 链接解析、block ID 校验、provider 选择、错误码映射、Kramdown 摘要裁剪 |
| 服务测试 | 本地先写；离线新增后恢复同步；软删除；缓存清理；精确块缓存命中；缓存键不匹配时拒绝过期预览；快速切换锚点时丢弃迟到响应；同 key in-flight 刷新去重；旧 pending 不覆盖较新远端锚点；断言 Supabase 同步 payload 不含 `content` / `markdown` / `kramdown` / `plainText` |
| 组件测试 | 任务卡锚点展示、Hover Popover 打开/关闭、锚点到浮层的 mouseleave 宽限期、Esc 关闭并恢复焦点、OverlayRef attach / detach / dispose 生命周期、快速切换锚点不泄漏 Overlay 实例、Popover / Sheet 状态、移动端长按菜单取消规则、Focus compact/deep-link-only 模式、当前块可用但路径或子块失败的降级态 |
| E2E | 粘贴链接绑定、hover 锚点显示对应块预览、快速 hover 多锚点不串内容、点击深链、扩展不可用降级、旧扩展配置通道降级、离线绑定后恢复同步、移动端 Sheet、Focus 中不自动展开预览 |

### 14.5 API 合约验收

使用本机思源内核和测试块验证：

1. `/api/system/version` 可返回版本字符串，并能识别 token 错误。
2. `/api/filetree/getHPathByID` 返回可读路径；失败时 UI 可退回 label / block ID。
3. `/api/block/getBlockKramdown` 返回的 `data.id` 与请求 block ID 一致。
4. `/api/block/getChildBlocks` 只展示有限数量子块，不递归拉取整棵树。
5. `/api/attr/getBlockAttrs` 失败不影响正文预览。
6. 所有 `code !== 0` 的响应都能映射为稳定的 NanoFlow errorCode。

---

## 15. 风险与缓解

### 15.1 决策记录

| 决策 | 结论 | 原因 |
|------|------|------|
| 是否嵌入思源 UI | 不嵌入 | iframe / 原生 UI 会破坏执行工作台定位与安全边界 |
| 是否同步正文 | MVP 不同步 | 避免知识库镜像化与隐私风险 |
| 是否直接请求 `127.0.0.1` | 公网 HTTPS 不直接请求 | Mixed Content 物理限制 |
| 是否优先做 bridge | 不优先 | 证书信任和跨平台排障成本高 |
| 是否支持写回 | 后置且 opt-in | read-only 稳定前避免污染思源 |

### 15.2 风险与缓解清单

| 风险 | 影响 | 缓解 |
|------|------|------|
| 用户未安装扩展 | 无法实时预览 | 保留 cache-only 降级路径 |
| 思源 token 失效 | 预览失败 | 明确状态提示 + 测试连接 |
| Kramdown 复杂语法过多 | 渲染混乱 | 首版摘要优先，保守渲染 |
| Focus 场景被知识预览打断 | 影响专注 | Focus 中收缩预览能力 |
| 误把正文同步进云端 | 产品语义漂移 | 本机缓存与云端指针分层 |
| 以后支持多来源时模型耦合 | 扩展困难 | 从首版就采用 ExternalSourceLink 抽象 |
| 扩展被滥用为本地 API 代理 | 本机数据泄露 | origin allowlist + API allowlist + 结构化请求 |
| 移动端无法访问思源 | 预览不可用 | 预期内降级为深链与缓存 |
| 锚点目标被删除 | 用户困惑 | 显示失效状态，保留解除关联入口 |
| 本地缓存过期 | 用户看到旧内容 | 展示 `fetchedAt` / 陈旧提示，提供手动刷新 |
| 子块过多导致 hover 卡顿 | 体验下降 | 限制子块数量 + 请求去重 + 超时取消 |
| 思源 API 响应结构变化 | 预览失败 | provider 层运行时校验 + errorCode 降级 |

---

## 16. 回滚策略

如果实时预览链路出现问题，可以按层级降级：

1. 关闭扩展 Relay，只保留深链打开。
2. 关闭缓存刷新，只展示已缓存摘要。
3. 关闭锚点预览 UI，只保留锚点标签与跳转按钮。

该能力的最小可退化形态应始终是：

```text
任务卡显示一个思源锚点
点击后跳转回思源原块
```

即使所有预览能力都被关闭，任务与知识源之间的指针关系仍然成立。

---

## 17. 最小产品定义

第一版只做以下 6 项：

1. 任务关联一个思源块链接。
2. 任务卡显示思源锚点。
3. 桌面端有 hover 触发的原生 Popover，移动端有 Bottom Sheet。
4. 预览层展示 `targetId` 对应具体块的路径、摘要、打开思源按钮。
5. 本地缓存预览，思源不可达时优先展示缓存。
6. token 与缓存只保存在当前设备。

第一版明确不做：

1. 全库搜索思源块。
2. 全量同步正文。
3. 在 NanoFlow 内编辑思源块。
4. iframe 嵌入思源 UI。
5. 默认写回思源属性。

### 17.1 MVP 用户故事

1. 作为执行者，我可以把思源块链接贴到任务上，以便之后从任务快速回到资料源。
2. 作为桌面用户，我可以把鼠标悬浮在任务卡思源锚点上，在不离开 NanoFlow 的情况下查看该具体块的一段摘要。
3. 作为移动端用户，我可以点击锚点打开底部预览或跳回该具体块，以便临时确认资料。
4. 作为隐私敏感用户，我可以确信 token 与正文缓存不会被同步到云端。
5. 作为专注模式用户，我不会被知识预览引导到无关阅读流。

### 17.2 暂缓问题

以下问题不阻塞 MVP，但需要在 Phase 2 后重新评估：

1. 是否允许用户选择把摘要快照同步到云端。
2. 是否需要支持思源文档级链接而不只是块级链接。
3. 是否提供从思源块属性反向标记 NanoFlow 任务状态。
4. 是否将 Extension Relay 独立发布，还是随 NanoFlow 桌面壳提供。
5. 是否需要针对团队空间设计共享锚点权限模型。

---

## 18. 一句话结论

> **把思源当知识源头，把 NanoFlow 当执行界面；任务只挂一个或多个思源锚点，NanoFlow 自己做安全预览，用户需要深入时再跳回思源原块。对于 HTTPS PWA 的 Mixed Content 障碍，首选桌面浏览器扩展 Relay，而不是先做本地 HTTP bridge。**

---

## 19. 配置流（v0.2.0 追加）

为消除"设置页填写 token 但不联通到扩展"的体验断层，自扩展 v0.2.0 起新增"页面 → 扩展"单向配置通道：

```
NanoFlow 设置页 ── postMessage ──▶ content-script ── chrome.runtime ──▶ background ── chrome.storage.local
                  ◀──── ack ────                  ◀───── ack ────
```

- 设置页"保存到扩展"按钮提交 `nanoflow.siyuan.set-config { baseUrl, token? }`。
- 设置页加载时调用 `nanoflow.siyuan.get-config-status`，仅获取 `{ baseUrl, hasToken }`，**token 明文永不回流页面**。
- 页面端不再把 token 写入 IndexedDB（`siyuan-local-config:<userId>` 在 `extension-relay` 模式下不携带 `token` 字段）。
- 旧扩展（< v0.2.0）会因不识别新消息而触发超时，UI 自动展示"扩展未安装或版本过旧"徽标并禁用"保存到扩展"按钮，原有 Options 页流程不破坏。

整体架构图（§ 5）保持不变；本节只描述配置写入路径。

