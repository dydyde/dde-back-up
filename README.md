# NanoFlow

NanoFlow 是一个**离线优先、单用户、多设备同步**的个人任务工作台。它把文本任务树、流程图、停泊坞（Parking Dock）、思源知识锚点（SiYuan Knowledge Anchor）、专注模式（Focus Mode）、黑匣子（Black Box）、回收站、导出导入、桌面本地备份和 Supabase 云同步放在同一个 Angular PWA 里。

如果你只想先理解这个项目，可以记住三句话：

- 它优先服务**个人工作流**，不是团队协作平台。
- 它默认**先写本地**，再在后台补同步。
- 它不仅是任务列表，还包含 **Parking Dock** 和 **Focus** 工作流。

---

## 快速导航

- [这是什么](#这是什么)
- [能做什么](#能做什么)
- [界面速览](#界面速览)
- [3 分钟上手](#3-分钟上手)
- [怎么用最顺手](#怎么用最顺手)
- [功能详解](#功能详解)
  - [文本视图](#文本视图)
  - [SiYuan 知识锚点](#siyuan-知识锚点)
  - [流程图视图](#流程图视图)
  - [Parking Dock 停泊坞](#parking-dock-停泊坞)
  - [Focus 专注模式](#focus-专注模式)
  - [Android 手机端小组件](#android-手机端小组件)
  - [项目管理](#项目管理)
  - [主题与外观](#主题与外观)
  - [PWA 与移动端](#pwa-与移动端)
- [快捷键速查表](#快捷键速查表)
- [数据丢了怎么找回](#数据丢了怎么找回)
- [数据保护机制全景](#数据保护机制全景)
- [常见问题](#常见问题)
- [近期更新](#近期更新)
- [文档导航](#文档导航)
- [开发者折叠区](#开发者折叠区)
- [当前边界与取舍](#当前边界与取舍)

---

## 这是什么

NanoFlow 当前主线定位很明确：

- **面向个人**，而不是多人协作。
- 支持**离线写入**，联网后自动补同步。
- **手机优先文本视图**，流程图按需进入。
- Focus、Parking Dock、Black Box、Strata 都是正式能力，不是实验角落。

如果你更在意"它解决什么问题"，可以把它理解成：

1. **文本视图** 负责快速拆解、整理和推进任务。
2. **流程图视图** 负责关系、结构和空间布局。
3. **Parking Dock** 负责"先停一下，但别忘了"。
4. **Focus** 负责把今天真正要推进的事压到眼前。

---

## 能做什么

| 能力 | 离线可用 | 需要 Supabase | 说明 |
|------|:--------:|:-------------:|------|
| 文本任务树 | ✅ | — | 分层编辑、拖拽排序、过滤、搜索、快速操作 |
| 流程图视图 | ✅ | — | GoJS 流程图、关系感知自动布局、导出 PNG / SVG / 项目脉络 Markdown |
| Parking Dock | ✅ | — | 停泊、提醒、焦点接管、跨项目组合 |
| Focus Mode | ✅ | — | Gate → Strata 工作流 |
| Android 手机端小组件 | — | ✅ | Android-only TWA 宿主小组件；支持 Gate / Focus / Dock 摘要、FCM dirty push，缺少 FCM 时退化为手动 / 解锁 / 周期刷新 |
| Black Box 速记 | ✅ | — | 文本速记离线可用；语音转写需要云端 |
| 思源知识锚点 | ✅ | — | 保存思源块轻量指针；桌面端可实时/缓存预览，移动端与弱连接环境可直接深链回跳 |
| Markdown 任务内容 | ✅ | — | 安全渲染（XSS 防护），适合说明、清单与笔记 |
| 回收站 / 归档恢复 | ✅ | — | 已删除（30 天）和已归档任务可从界面内找回 |
| 撤销 / 重做 | ✅ | — | 桌面端最多 150 步，移动端最多 50 步 |
| JSON 导出 / 导入 | ✅ | — | 结构数据迁移与恢复，包含回收站数据 |
| 附件 ZIP 导出 / 导入 | ✅ | — | 原始附件文件单独打包备份 |
| 桌面本地自动备份 | ✅ | — | Chrome / Chromium 桌面浏览器，每 30 分钟自动备份 |
| 5 色主题 + 深色模式 | ✅ | — | default / ocean / forest / sunset / lavender + 跟随系统 |
| 登录与云同步 | — | ✅ | 多设备同步、增量拉取、LWW 冲突策略 |
| 附件上传 | — | ✅ | Supabase Storage 私有桶，支持病毒扫描 |
| 黑匣子语音转写 | — | ✅ | Groq whisper-large-v3，每日 50 次额度 |

---

## 界面速览

| 界面 | 适合做什么 | 什么时候用 |
|------|------------|------------|
| **文本视图** | 批量整理、快速编辑、按阶段推进 | 每天大多数时候 |
| **流程图视图** | 看关系、调结构、导出图 | 需要"看全局"时 |
| **Parking Dock** | 暂停、提醒、候场、接管焦点 | 任务太多但不想丢 |
| **Gate** | 先清掉黑匣子待处理条目 | 每天第一次打开应用 |
| **Android 小组件** | 在主屏直接看 Gate / Focus / Dock 摘要 | 不想每次都先打开 App 时 |
| **Black Box** | 快速记想法、速记、语音转写入口 | 脑中突然冒出内容时 |
| **Strata** | 从历史沉积里把任务或黑匣子条目挖出来 | 以为"做完了其实还得继续"时 |
| **回收站** | 恢复删除 / 归档项目 | 误删、误归档后 |

---

## 3 分钟上手

### 只想本地离线体验

```bash
npm install
npm start
```

- **Node.js 要求**：`>= 18.19.0`
- **默认开发端口**：优先 `3000`；若该端口在本机被系统保留或占用，会自动回退到下一个可用端口
- 如需固定端口，可设置 `PORT` 或 `NANOFLOW_DEV_SERVER_PORT`
- 即使没有配置 Supabase，也能先以离线模式运行，所有核心功能都可用

### 想用登录、同步、附件、跨设备

你至少需要：

1. 准备一个 Supabase 项目。
2. 创建一个**私有** Storage bucket，名字必须是 `attachments`。
3. 执行 [`scripts/init-supabase.sql`](scripts/init-supabase.sql)（包含所有表、RLS、RPC、触发器和索引）。
4. 配置以下环境变量：

```bash
NG_APP_SUPABASE_URL=https://your-project.supabase.co
NG_APP_SUPABASE_ANON_KEY=your-anon-key
```

> 最快部署自己的实例，直接看：[docs/deploy-private-instance.md](docs/deploy-private-instance.md)
>
> 支持一键部署到 **Vercel**（推荐）、**Netlify** 或 **Railway**。

### 想用语音转写

还需要额外部署 `transcribe` Edge Function，并配置 Groq API Key。排查文档见：[TRANSCRIBE-TROUBLESHOOTING.md](TRANSCRIBE-TROUBLESHOOTING.md)

### 想用 Android 手机端小组件

还需要额外准备 Android 宿主和 widget 后端路径：

1. 部署 `widget-register`、`widget-summary`、`widget-notify` 三个 Edge Function。
2. 构建 Android TWA 宿主 `app.nanoflow.twa`，把它安装到需要挂件的手机上。
3. 如果想要 **FCM dirty push 刷新**，把 `android/app/google-services.json` 放在本地，并为 `widget-notify` 配置以下 Supabase Secrets：

```bash
FCM_PROJECT_ID=...
FCM_CLIENT_EMAIL=...
FCM_PRIVATE_KEY=...
```

- 当前只保留 **Android 手机端** widget 路径；桌面端 widget runtime 已退役
- 没有 `google-services.json` 或 FCM Secrets 也能工作，但会自动退化为**手动刷新 + 解锁触发刷新 + WorkManager 周期刷新**
- 设计边界和验收清单见：[docs/android-widget-host-scaffold.md](docs/android-widget-host-scaffold.md) 与 [docs/pwa-android-widget-cross-platform-implementation-checklist.md](docs/pwa-android-widget-cross-platform-implementation-checklist.md)

---

## 怎么用最顺手

### 推荐的日常节奏

1. 用**文本视图**做当天整理和快速修改。
2. 需要梳理关系时，再切到**流程图视图**。
3. 一时不做但又不想删的任务，放进 **Parking Dock**，而不是直接归档。
4. 准备进入工作状态时，打开 **Focus**，让 Gate 先清理黑匣子待处理项。
5. 完成后的历史沉积不要急着清，**Strata** 可以把"以为结束、后来又要继续"的内容重新挖出来。

### 很有用的使用技巧

| 技巧 | 说明 |
|------|------|
| 删除 ≠ 永久删除 | 普通删除会先进回收站，保留 30 天。先去回收站找 |
| 归档也能找回 | 归档任务出现在回收站的"已归档"标签页 |
| 黑匣子不是垃圾桶 | 它更像临时收集箱，后续要经过 Gate 处理 |
| 语音转写可以离线用 | 离线录制的音频会缓存，联网后自动转写 |
| 长文别塞进任务正文 | 用思源知识锚点挂原块；任务里只保留执行信息，资料继续留在思源维护 |
| 同步状态不对？看仪表盘 | 打开系统设置 →"系统仪表盘"看冲突、网络恢复和待同步状态 |
| 恢复全量数据分两步 | 先导入 JSON（结构数据），再导入附件 ZIP（文件） |
| 手机优先文本视图 | 流程图适合按需进入，避免性能消耗 |
| 看到"待同步"别急 | 很多情况下只是本地已保存、云端待补传，联网后会自动完成 |
| 高风险操作前先备份 | 手动导出一次 JSON，是最便宜也最稳妥的保险 |
| 桌面自动备份指向网盘 | 选择坚果云 / Dropbox / OneDrive 同步目录作为备份目标 |
| 任务有五个优先级 | low / medium / high / urgent，方便排序 |
| 用认知负荷标签 | 标记任务为"高负荷"或"低负荷"，Focus 模式会据此智能推荐填充任务 |
| Space 键录音 | 在 Black Box 界面，按住空格键开始录音，松开自动转写 |

---

## 功能详解

### 文本视图

文本视图是 NanoFlow 的默认主界面（尤其在移动端），适合日常任务管理。

**核心能力**：
- **分层任务树**：支持多级父子关系，无限嵌套（深度限制 100 层）
- **拖拽排序**：鼠标和触控均支持，跨阶段拖拽
- **阶段过滤**：按阶段筛选任务，快速聚焦
- **搜索**：全局搜索框跨项目搜索任务
- **批量操作**：选中多个任务后批量删除
- **任务编辑**：标题 + Markdown 内容，支持内嵌清单
- **任务内容链接**：支持 `[说明](https://example.com)` 外链，也支持 `[关联任务](task:<taskId>)` 这种稳定任务内链
- **附件管理**：上传、预览、管理文件附件
- **标签系统**：给任务打标签分类
- **优先级**：low / medium / high / urgent 四级优先级
- **截止日期**：可选的 deadline 提醒

**Markdown 链接说明**：
- 外部网站：使用标准 Markdown 链接，例如 `[NanoFlow](https://example.com)`，也支持直接粘贴裸网址，例如 `https://example.com/docs`
- 页内锚点 / 相对路径：如 `[跳转](#section)`、`[说明](./docs/guide)` 会保留站内导航语义，不会被强制新开页
- 项目内任务跳转：使用稳定任务 ID，例如 `[跳到任务](task:550e8400-e29b-41d4-a716-446655440000)`，也支持直接写 `task:550e8400-e29b-41d4-a716-446655440000`
- Windows 本地路径：支持显式 Markdown 链接如 `[打开文档](C:\Users\me\Docs\Plan.md)`，也支持无空格裸路径如 `C:\Tools\Todo\plan.md`
- `file:` 本地链接不会把原始 `file:///` 暴露到 DOM，而是走受控链路：普通文档会在点击手势内优先尝试打开并同步复制路径；浏览器拦截时会自动提示
- 网络共享路径（UNC）和高风险可执行文件不会被直接启动，只会给出提示并复制路径，避免误触远程共享或本地可执行目标
- 路径里如果包含空格，优先使用显式 Markdown 链接，避免裸文本自动识别歧义

**移动端适配**：
- 卡片布局替代水平阶段视图
- 长按拖拽（250ms 触发）
- 滑动手势打开/关闭侧边栏
- 边缘自动滚动

### SiYuan 知识锚点

SiYuan 知识锚点用于把任务和外部知识块连起来，同时保持 NanoFlow 仍然是执行工作台，而不是第二个知识库。

**核心能力**：
- **块级绑定**：任务可挂载一个或多个 `siyuan://blocks/{id}` 指针，显示路径、标签和角色等轻量信息
- **桌面端预览**：优先通过浏览器扩展 Relay 做只读实时预览；无法直连时自动回退到本机缓存预览
- **移动端降级**：移动端和公网 HTTPS PWA 无法安全直连本地思源内核时，仍可保留锚点并直接深链回跳
- **本机凭证隔离**：token、baseUrl 和 preview cache 只保存在当前设备，不进入 Supabase
- **多场景复用**：文本视图、Focus、Parking Dock 都能展示来源入口，不需要把长文正文直接塞进任务卡

**使用边界**：
- NanoFlow 只同步轻量指针与显示元数据，不默认同步思源正文
- HTTPS PWA 默认不直连 `127.0.0.1:6806`；桌面实时预览推荐使用 NanoFlow 浏览器扩展 Relay
- 如果当前环境不可实时预览，仍可打开原块，不会阻塞任务推进
- 配置入口在“设置 → 思源知识锚点”；可切换 `extension-relay`、`direct`、`cache-only` 三种本机模式

### 流程图视图

流程图视图基于 GoJS 构建，适合需要"看全局"的场景。

**核心能力**：
- **交互式流程图**：节点代表任务，连线代表关系
- **缩放与导航**：缩放、平移、适应视窗
- **自动布局**：会考虑阶段密度、跨树关联和多父合流，减少关系线挤压
- **连线模式**：进入连线模式后，点击两个节点即可创建连接
- **框选模式**：拖拽框选多个节点
- **级联分配**：向连接的任务层级批量分配属性
- **导出 PNG / SVG / 项目脉络 Markdown**：图片适合分享，Markdown 适合给人或 AI 做结构审阅
- **云端缩略图**：自动保存流程图缩略图到云端

**移动端适配**：
- 按需懒加载（`@defer`），避免首屏阻塞
- 批量操作工具栏
- 触控支持节点操作
- 专用移动绘板下方工具条

### Parking Dock 停泊坞

Parking Dock 是一个**浮动任务资源面板**，用于存放你打算在专注时段处理的任务。

**核心能力**：
- **跨项目组合**：从不同项目拖拽任务到同一个面板
- **停泊任务**：把任务"停下来"但不丢失
- **认知负荷标记**：标记为高负荷（🔴）或低负荷（🟢），系统据此推荐填充任务
- **预估时间**：设置预计耗时和等待时间
- **上下文快照**：停泊时自动保存任务上下文
- **📌 防过期钉选**：钉选后任务不会被自动标记为"过期"
- **智能推荐**：等待期间推荐低负荷任务填充空隙

**停泊坞中的任务会经历以下过期阈值**：
- 64 小时：出现黄色过期警告
- 72 小时：标记为"陈旧"（橙色警告）
- 📌 钉选后：永不过期

**三种放入停泊坞的方式**：
1. 从文本/流程图视图中拖拽任务
2. 点击底部浮动胶囊"停泊坞"展开面板
3. 在面板中直接点"+ 新建"创建任务

### Focus 专注模式

专注模式由四个组件组成一个完整的工作流。

#### Gate 大门 — 每日清理仪式

- **自动触发**：每天第一次打开应用时弹出
- **处理黑匣子待办**：展示所有未处理的 Black Box 条目
- **必须决策**：对每条条目做出 👁️ 已读 / ✅ 完成 / ⏭️ 稍后 决定
- **已读是短时缄默**：未完成条目会在约 30 分钟冷却后再次进入 Gate
- **跨设备更准**：冷启动、进入 reviewing 和切回前台时都会补做一次远端核验，减少"桌面已完成、手机还显示旧条目"的残留
- **贪睡上限**：每天最多 3 次"稍后提醒"
- **可禁用**：在偏好设置中可以关闭 Gate

#### Strata 地质层 — 完成历史

- **分层沉积**：完成的任务按日期分层
- **透明度渐变**：今天 100%、昨天 70%、更早 40%
- **恢复任务**：从 Strata 中把任务恢复为活跃状态

#### Black Box 黑匣子 — 紧急思维捕获

- **语音转写**：按住 🎤 说话，松开自动转写
- **文本速记**：也支持直接打字记录
- **每日额度**：语音转写最多 50 次/天
- **离线排队**：离线录制自动缓存，联网后补传转写
- **安全代理**：语音文件通过 Supabase Edge Function 转发到 Groq，API Key 永远不暴露给浏览器
- **音频不留存**：转写完成后音频立即丢弃，只保留文本

**语音转写支持格式**：webm/opus、webm、mp4、ogg/opus、wav
**最大录音文件**：25 MB | **最短录音**：1 秒 | **转写超时**：10 秒

#### Focus Console 专注控制台（进阶）

当你在停泊坞中有任务并进入 Focus 模式时，停泊坞会变成**三区控制台**：

| 区域 | 容量 | 说明 |
|------|:----:|------|
| **主控台** | 4 个任务栈 | 当前正在执行的任务，前方卡片可交互 |
| **组合选择区** | 8 个推荐 | 主任务等待时，系统推荐的填充任务 |
| **备选区** | 10 个储备 | 手动浏览的候补任务 |

**智能推荐逻辑**：
1. 同项目延续（保持上下文）
2. 认知负荷互补（高负荷主任务 → 推荐低负荷填充）
3. 等待时间链接（把多个有等待时间的任务串联）

**主任务状态流转**：

```
Focusing → Suspend-Waiting → Wait-Ended → Completed
                ↓
             Stalled (临时切出后返回)
```

### Android 手机端小组件

当前只保留 Android 手机端 widget 路径；桌面端 widget runtime 已退役。

**核心能力**：
- **主屏速览**：直接在桌面查看 Gate / Focus / Dock / 项目摘要，不必先打开应用
- **权威打开目标**：点击卡片时走后端返回的 `entryUrl`，宿主不自行猜测业务路径
- **多级刷新兜底**：优先使用 FCM dirty signal；FCM 不可用时退化为手动刷新、`USER_PRESENT` 解锁触发刷新和 WorkManager 周期刷新
- **Gate 已读冷却**：已读只短时静默（约 30 分钟），到期未完成条目会再次出现，小组件会补一次刷新
- **MIUI/HyperOS 兼容**：Gate 列表采用更稳的 RemoteViews 渲染，避免部分机型异常页
- **安全边界清晰**：push 只发 dirty signal，不下发正文；token 失效或未完成 bootstrap 时回退到 setup/auth-required，而不是展示旧缓存冒充最新状态
- **Focus / Gate 联动**：专注状态、Gate 待处理项和项目摘要会跟随后端权威摘要更新

### 项目管理

- **创建项目**：点击"+ 新建"按钮
- **切换项目**：侧边栏点击项目名
- **重命名**：双击或右键菜单重命名
- **跨项目搜索**：全局搜索框可跨项目搜索
- **视图状态持久化**：Flow 视图的缩放、平移位置按项目保存
- **同步指示器**：显示项目是否有待同步变更

### 主题与外观

NanoFlow 提供 **5 种配色主题** 和 **深色/浅色模式**：

| 主题 | 风格 |
|------|------|
| **default** | 标准蓝色 |
| **ocean** | 蓝绿海洋 |
| **forest** | 绿色森林 |
| **sunset** | 橙红暖色 |
| **lavender** | 紫色薰衣草 |

支持**跟随系统**自动切换深色/浅色模式。

### PWA 与移动端

- **可安装**：支持 iOS、Android、桌面浏览器"添加到主屏幕"
- **平台检测**：自动展示对应平台的安装引导（iOS Safari 分享菜单、Android 菜单）
- **Android TWA 壳**：仓库内原生宿主默认包名为 `app.nanoflow.twa`，当前对齐版本为 `0.1.2`（`versionCode 3`）
- **Android 小组件**：当前只保留 Android 手机端宿主；支持主屏摘要与点击回到后端权威入口
- **离线可用**：Service Worker 缓存静态资源和字体
- **移动端默认文本视图**：流程图按需进入，避免性能开销
- **手势支持**：长按拖拽、滑动导航、边缘自动滚动

---

## 快捷键速查表

> Mac 的 `Cmd` 对应 Windows / Linux 的 `Ctrl`。

### 全局快捷键

| 快捷键 | 作用 |
|--------|------|
| `Ctrl/Cmd + Z` | 撤销 |
| `Ctrl/Cmd + Shift + Z` | 重做 |
| `Ctrl/Cmd + Y` | 重做（Windows 风格） |
| `Ctrl/Cmd + F` | 聚焦全局搜索框 |
| `Ctrl/Cmd + B` | 切换黑匣子面板 |
| `Ctrl/Cmd + .` | 进入聚光灯专注模式 |

### Focus / Dock 控制

| 快捷键 | 作用 |
|--------|------|
| `Alt + Shift + L` | 启动 / 退出 Focus 会话 |
| `Alt + Shift + F` | 切换 Focus 虚化遮罩 |
| `Alt + Shift + D` | 展开 / 收起停泊坞 |
| `Alt + H` | 打开 Dock / Focus 帮助层 |
| `Esc` | 分级关闭：帮助层 → 面板 → Focus 退出确认 |

### Gate 入口

| 快捷键 | 作用 |
|--------|------|
| `1` 或 `Enter` | 标记已读 |
| `2` 或 `Space` | 标记完成 |
| `3` | 稍后提醒（贪睡） |

### Black Box 条目

| 快捷键 | 作用 | 条件 |
|--------|------|------|
| `R` | 标记已读 | 聚焦到条目时 |
| `C` | 标记完成 | 聚焦到条目时 |
| `Space`（按住/松开） | 开始/停止录音 | 在录音界面 |
| `Ctrl/Cmd + Enter` | 提交转写文本 | 在文本输入框 |

### Flow 视图

| 快捷键 | 作用 | 说明 |
|--------|------|------|
| `Alt + Z` | 解除父子关系 | 选中任务后生效 |
| `Alt + X` | 删除跨树连接线 | 选中连接线后生效 |

### Dock 交互（键盘无障碍）

| 快捷键 | 作用 |
|--------|------|
| `Enter` / `Space` | 选择/切换 Dock 中的卡片 |
| `Alt + 滚轮` | 调整任务负荷（高/低） |
| `Tab` / `Shift+Tab` | 在面板/对话框中循环焦点 |

---

## 数据丢了怎么找回

> **结论**：NanoFlow 把"误删、误归档、离线待同步、手动备份恢复、桌面自动备份恢复"都纳入了正式路径。最容易犯的错误不是系统彻底没法恢复，而是**找错入口**。

### 按优先级排查

| 优先级 | 现象 | 做法 |
|:------:|------|------|
| 1️⃣ | 刚刚误操作了 | `Ctrl+Z` 撤销（桌面 150 步 / 移动 50 步） |
| 2️⃣ | 任务不见了 | 打开**回收站** → "已删除"或"已归档"标签页 |
| 3️⃣ | 完成后又想继续 | 去 **Strata** 里恢复任务或黑匣子条目 |
| 4️⃣ | 整个项目要迁移/回滚 | 设置 → **JSON 导出 / 导入** |
| 5️⃣ | 附件也要找回 | 额外使用**附件 ZIP 导出 / 导入** |
| 6️⃣ | 桌面 Chrome 自动备份 | 从备份目录直接恢复（默认保留最近 30 份） |
| 7️⃣ | 只是网络异常 | 检查是否仍在本地、是否显示待同步；联网后通常自动补传 |

### 常见场景速查

| 现象 | 恢复方式 | 说明 |
|------|----------|------|
| 误删任务 | 回收站 → 恢复 | 回收站保留 **30 天**，之后自动永久删除 |
| 误归档任务 | 回收站 → 已归档 → 取消归档 | 归档不会自动删除 |
| 黑匣子或已完成任务想重新继续 | Strata → 恢复 | task 恢复为 active，black box 恢复为待处理 |
| 换设备或留一份快照 | 设置 → 导出 JSON | 包含项目、任务、连接、附件元数据和回收站数据 |
| 附件文件一并保存 | 设置 → 导出 ZIP | 原始附件文件和 JSON 是两套通道 |
| 桌面端想自动留底 | 设置 → 本地增强备份 | 选择网盘同步目录即可自动备份 |
| 从本地备份恢复 | 设置 → 从备份恢复 | 走 **merge** 模式，不会先删现有数据 |
| 多标签页冲突 | 自动协调 | BroadcastChannel 跨标签同步，编辑锁防止并发 |

### 恢复注意事项

- **完整恢复**：先导入 JSON（结构数据），再导入附件 ZIP（文件）。顺序很重要。
- **手动 JSON 导入遇到冲突**：界面会让你选择"跳过 / 覆盖 / 合并 / 重命名为新项目"。
- **纯净回滚**：先导出一份现状，或在新实例中恢复更安全。
- **离线与同步**：
  - 本地是第一落点，断网时依然可以编辑。
  - 云同步失败时，改动进入重试队列（最多 5 次、24 小时有效）。
  - 附件、登录态、多设备同步都依赖 Supabase。

---

## 数据保护机制全景

NanoFlow 采用多层数据保护策略，从前端到后端构建了完整的安全网。

### 存储层

| 层级 | 机制 | 说明 |
|------|------|------|
| 即时存储 | IndexedDB（idb-keyval） | 所有操作先写本地 |
| 自动保存 | 每 3 秒自动持久化到 IndexedDB | |
| 操作历史 | 撤销/重做，持久化最近 50 步 | 关闭浏览器后重开仍可撤销 |
| 软删除 | 删除操作设置 `deletedAt` 时间戳 | 可恢复 |
| 自动清理 | 回收站条目 30 天后永久删除 | 每小时检查一次 |

### 同步层

| 机制 | 说明 |
|------|------|
| 增量同步 | 只拉取 `updated_at > last_sync_time` 的变更 |
| 3 秒防抖 | 快速编辑不会每次都触发同步 |
| 断路器 | 连续 3 次失败后暂停同步 30 秒，避免雪崩 |
| Realtime 自动降级 | Realtime 暂不可用时自动切换到定时同步，并在冷却窗口结束后尝试恢复订阅 |
| 重试队列 | 失败操作最多重试 5 次，指数退避 |
| Gate 远端复核 | Gate 启动、reviewing 和页面重新可见时会主动补一次远端核验，降低跨设备旧快照残留 |
| 队列过载保护 | 70% 警告 → 90% 紧急处理 → 95% 冻结新写入 |
| 多标签协调 | BroadcastChannel + 分布式锁，防止多标签并发冲突 |

### 备份层

| 方式 | 自动? | 保留量 | 适用场景 |
|------|:-----:|:------:|----------|
| JSON 导出 | 手动 | 不限 | 结构数据迁移、跨设备传输 |
| 附件 ZIP 导出 | 手动 | 不限 | 附件文件备份（最大 500MB） |
| 桌面本地备份 | 自动 | 最近 30 份 | Chrome/Chromium 桌面端 |
| IndexedDB 日备 | 自动 | 7 天 | Delta Sync 操作前的快照 |
| 云端同步 | 自动 | 持续 | 多设备一致性 |

### 冲突处理

| 场景 | 策略 |
|------|------|
| 默认冲突 | **LWW（Last-Write-Wins）**：以最新 `updatedAt` 为准 |
| 同时编辑同一字段 | 字段级锁保护，编辑中不被远程覆盖 |
| 内容差异 < 30% | 创建"冲突副本"供用户手动决定 |
| 内容差异 ≥ 90% | 自动合并（差异微不足道） |
| 导入冲突 | 跳过 / 覆盖 / 合并 / 重命名 四种策略 |

---

## 常见问题

### 1. 为什么我能用，但没有同步？

大概率是当前处于访客模式，或者没有配置 `NG_APP_SUPABASE_URL` 和 `NG_APP_SUPABASE_ANON_KEY`。

### 2. 为什么附件上传失败？

通常是没有创建名为 `attachments` 的私有 Storage bucket，或者 Supabase 初始化脚本没有完整执行。

### 3. 为什么本地自动备份按钮没有出现？

本地自动备份依赖 File System Access API，只在**桌面 Chrome / Chromium** 类浏览器可用。Firefox、Safari、移动端不支持。

### 4. 为什么附件 ZIP 导入后有部分文件被跳过？

附件导入会按任务 ID 匹配。如果目标项目里的任务还没先通过 JSON 恢复出来，附件就无法正确落位。**先导入 JSON，再导入 ZIP**。

### 5. 为什么流程图在手机上不是主界面？

刻意设计。移动端默认文本视图，流程图按需进入，避免性能和可用性成本。

### 6. 为什么看到"待同步"或"保存超时"？

大多数情况下数据已安全保存到本地，只是云端补传还没完成。联网后通常会自动完成。如果 Realtime 暂不可用，界面会提示已切换到定时同步；恢复窗口结束后会再尝试回到 Realtime。如果持续出现，检查网络和登录状态。

### 7. 语音转写失败怎么排查？

按以下顺序检查：
1. Edge Function 是否已部署（`supabase functions list`）
2. `GROQ_API_KEY` 是否已设置（`supabase secrets list`）
3. `transcription_usage` 表是否存在且 RLS 已启用
4. 今日额度是否已用完（每日 50 次）
5. 详细排查见 [TRANSCRIBE-TROUBLESHOOTING.md](TRANSCRIBE-TROUBLESHOOTING.md)

### 8. 多个浏览器标签页会冲突吗？

NanoFlow 使用 BroadcastChannel 跨标签页同步，并通过编辑锁防止并发编辑。如果检测到另一个标签页正在编辑，会弹出 toast 提示（不强制阻断）。

### 9. 如何完全删除一个任务（不可恢复）？

在回收站中找到该任务，点击"永久删除"。也可以等 30 天自动清理。

### 10. 撤销/重做的历史会保留多久？

会持久化到 IndexedDB（最多 50 步），关闭浏览器后重新打开仍可使用。工作中实时最多保留 150 步（桌面）/ 50 步（移动端）。

### 11. 为什么 Android 小组件或手机上的 Gate 有时不是完全秒级更新？

Gate 现在会在冷启动、进入 reviewing 和页面重新可见时主动做一次远端核验，所以跨设备完成状态通常会更快对齐。已读条目会进入约 30 分钟冷却，未完成会再次进入 Gate；小组件会在冷却到期时补一次刷新。Android 小组件如果配置了 FCM，会收到 dirty signal 后刷新；如果没有 FCM，则会退化为手动刷新、解锁触发刷新和周期刷新，因此不是每次都秒级。

### 12. 为什么思源知识锚点有时只能打开原块，不能实时预览？

这是当前运行时边界决定的。公网 HTTPS PWA 不能直接请求 `http://127.0.0.1:6806`，所以桌面端实时预览优先依赖 NanoFlow 浏览器扩展 Relay；如果当前设备未安装扩展、未配置本机连接，或者你正在移动端使用 NanoFlow，系统会自动降级为缓存预览或只保留 `siyuan://` 深链打开。锚点本身不会因此丢失，登录后其轻量指针仍可跨设备同步。

---

## 近期更新

- **SiYuan 知识锚点**：完成 anchor app integration、relay options storage 加固，并连续补齐多轮 validation / review feedback
- **同步修复收口**：补强 project sync terminal failures、retry bounds 与 ownership checks，继续稳定 Black Box sync / recording
- **Gate / Android 小组件**：恢复 Gate 已读冷却，并修复 MIUI stale empty state 下的小组件强制刷新路径
- **Cloudflare / 同步协议**：继续推进 Cloudflare migration，补齐 sync RPC safeguards 与 protocol refactor 收口
- **CI / 测试 / 文档**：分片基线、隔离修复、deploy workflow rerun 统计与 README 更新持续同步

按 `origin/main` 最近 30 条合并 / 推送记录整理如下：

- **2026-05-04**：Merge pull request #29 from wgje/copilot/complete-knowledge-anchor-plan
- **2026-05-04**：Address remaining SiYuan review issues
- **2026-05-04**：Address SiYuan validation feedback
- **2026-05-04**：Harden SiYuan relay options storage
- **2026-05-04**：Complete SiYuan anchor app integration
- **2026-05-04**：merge: integrate fix/project-sync-terminal-failures into main
- **2026-05-04**：fix(widget): force MIUI gate host refresh on stale empty state
- **2026-05-03**：fix(sync): harden project sync terminal failures
- **2026-05-03**：Merge pull request #27 from wgje/copilot/fix-sync-issues-and-errors
- **2026-05-03**：Address final validation cleanup
- **2026-05-03**：Finish remaining sync review cleanup
- **2026-05-03**：Increase timeout for copilot setup steps to 300 minutes
- **2026-05-03**：Complete sync hardening fixes
- **2026-05-03**：Harden retry bounds and ownership checks
- **2026-05-03**：Address sync review findings
- **2026-05-03**：Stabilize black box sync and recording
- **2026-05-01**：test: reset network suspension in project data spec
- **2026-05-01**：docs: update README with recent fixes
- **2026-05-01**：fix: restore gate read cooldown and widget refresh
- **2026-05-01**：stabilize shard balance gate
- **2026-05-01**：harden deployed supabase network recovery
- **2026-04-30**：fix ci lane-local shard balancing
- **2026-04-30**：rebalance ci shard timing baseline
- **2026-04-30**：fix ci test isolation for supabase and auth specs
- **2026-04-30**：fix export reminder time-sensitive test
- **2026-04-30**：harden blackbox content sync guards
- **2026-04-30**：merge sync protocol cloudflare migration refactor
- **2026-04-30**：refactor sync protocol for cloudflare migration
- **2026-04-30**：align sync RPC migration safeguards
- **2026-04-30**：ci: harden deploy workflow reruns

---

## 文档导航

### 使用者最常看的

| 文档 | 说明 |
|------|------|
| [docs/deploy-private-instance.md](docs/deploy-private-instance.md) | 部署私有实例（Vercel / Netlify / Railway） |
| [docs/cloudflare-migration-plan.md](docs/cloudflare-migration-plan.md) | Cloudflare Pages 迁移方案与门禁 |
| [TRANSCRIBE-TROUBLESHOOTING.md](TRANSCRIBE-TROUBLESHOOTING.md) | 语音转写异常排查 |
| [scripts/README.md](scripts/README.md) | 数据库初始化、脚本用途、测试矩阵说明 |

### 设计 / 审计 / 深入背景

| 文档 | 说明 |
|------|------|
| [docs/android-twa-integration-checklist.md](docs/android-twa-integration-checklist.md) | Android TWA 壳接入、DAL、bootstrap 与验真清单 |
| [docs/android-widget-host-scaffold.md](docs/android-widget-host-scaffold.md) | Android 原生宿主骨架、回调协议与当前验证边界 |
| [docs/pwa-android-widget-cross-platform-implementation-checklist.md](docs/pwa-android-widget-cross-platform-implementation-checklist.md) | Android 小组件跨端实现清单、刷新路径与停用边界 |
| [docs/siyuan-knowledge-anchor-plan.md](docs/siyuan-knowledge-anchor-plan.md) | SiYuan 知识锚点的产品边界、Relay 方案与数据模型 |
| [docs/focus-mode-design.md](docs/focus-mode-design.md) | Focus 模式整体设计 |
| [docs/focus-console-design.md](docs/focus-console-design.md) | Focus 控制台设计 |
| [docs/parking-dock-modular-design.md](docs/parking-dock-modular-design.md) | Parking Dock 模块化设计 |
| [docs/parking-dock-implementation-audit-2026-03-09.md](docs/parking-dock-implementation-audit-2026-03-09.md) | Parking Dock 实现审计 |
| [docs/data-protection-plan.md](docs/data-protection-plan.md) | 数据保护方案 |
| [docs/data-loss-and-ui-truthfulness-master-plan-2026-02-09.md](docs/data-loss-and-ui-truthfulness-master-plan-2026-02-09.md) | 数据丢失防护与 UI 真实性 |
| [docs/pwa-instant-startup-plan.md](docs/pwa-instant-startup-plan.md) | PWA 秒开方案 |
| [docs/deep-performance-audit-2026-02-18.md](docs/deep-performance-audit-2026-02-18.md) | 性能深度审计 |

---

## 开发者折叠区

<details>
<summary><strong>🔧 本地开发、构建与测试</strong></summary>

### 运行要求

- **Node.js** `>= 18.19.0`
- `npm start` 会先执行 `npm run config`

### 常用命令

```bash
# 开发
npm start                      # 启动开发服务器
npm run build                  # 生产构建
npm run build:dev              # 开发构建
npm run build:strict           # 严格模式构建

# 环境检查
npm run validate-env           # 开发环境变量校验
npm run validate-env:prod      # 生产环境变量校验
```

### Android TWA 壳更新到新设备

- 当前仓库默认 Android 宿主包名：`app.nanoflow.twa`
- 当前建议发布版本：`0.1.2`（`versionCode 3`）
- 换新设备时不要改包名；只要继续使用同一 release 证书与同一 Web origin，既有 `assetlinks.json` 验真关系仍然成立

更新前请确保以下环境变量与发布配置一致：

- `ANDROID_TWA_PACKAGE_NAME=app.nanoflow.twa`
- `ANDROID_TWA_SHA256_CERT_FINGERPRINTS=<release cert sha256>`
- `ANDROID_WIDGET_VERSION_NAME=0.1.2`
- 可选：`ANDROID_TWA_RELATIONS`

新设备更新步骤：

1. 先部署最新 Web，并确认 `/.well-known/assetlinks.json` 对应的是当前 release 包名和证书指纹。
2. 再安装或覆盖更新 Android TWA 壳；`versionCode 3` 用于确保设备会把它识别为新版本而不是同版本覆盖失败。
3. 如果设备是 Xiaomi / MIUI，安装后执行 `npm run android:miui:init -- -DeviceSerial <serial>`，把 Chrome 与 `app.nanoflow.twa` 的 appops / 后台运行基线恢复到已验证配置。
4. 首次打开宿主时，优先从桌面图标进入一次，让最新 TWA 启动链、bootstrap 参数与线上 Web 版本重新对齐。

推荐直接按下面的 PowerShell / ADB 流程执行：

```powershell
# 1) 确认设备 serial
adb devices -l

# 2) 更新前查看当前安装版本
adb -s <serial> shell dumpsys package app.nanoflow.twa |
  Select-String -Pattern 'versionName|versionCode|lastUpdateTime' |
  Out-String -Width 240

# 3) 构建并通过 ADB 覆盖安装最新 debug 宿主
Push-Location android
.\gradlew.bat :app:installDebug
Pop-Location

# 4) Xiaomi / MIUI 设备建议补一遍已验证基线
npm run android:miui:init -- -DeviceSerial <serial>

# 5) 更新后再次验证版本
adb -s <serial> shell dumpsys package app.nanoflow.twa |
  Select-String -Pattern 'versionName|versionCode|lastUpdateTime' |
  Out-String -Width 240
```

说明：

- 如果只有一台设备连接，也建议保留 `-s <serial>`，避免后续多设备调试时误装到别的手机。
- 第 4 步只对 Xiaomi / MIUI 设备推荐；非 MIUI 设备可以跳过。
- 当前仓库这轮更新完成后，验证结果应看到 `versionCode=3` 与 `versionName=0.1.2`。

更细的 Android 壳接入、bootstrap 回调协议和验真边界，见上面的 Android 专项文档。

### 测试命令

```bash
# 本地测试
npm run test                   # 默认 matrix 模式（排除 quarantine）
npm run test:run               # lane_node_minimal + lane_browser_minimal
npm run test:run:verify        # 全 lane 不分片（不含 quarantine）
npm run test:run:full          # 全量含 quarantine
npm run test:run:pure          # vitest.pure 纯函数测试
npm run test:run:services      # vitest.services 服务层测试
npm run test:run:components    # vitest.components 组件层测试

# CI 测试
npm run test:run:ci            # weighted + include-quarantine

# E2E
npm run test:e2e               # Playwright E2E 测试
npm run test:e2e:ui            # Playwright UI 模式
npm run test:e2e:perf          # E2E 性能测试
```

### 质量与性能门禁

```bash
npm run lint                   # ESLint 检查
npm run lint:fix               # ESLint 自动修复
npm run test:contracts         # 契约测试
npm run quality:guard:encoding # UTF-8 编码检查
npm run perf:guard             # 完整性能门禁（构建 + nojit + 启动 + 字体 + supabase-ready）
npm run perf:guard:no-regression # 无回归基线检查
npx knip                       # 死代码检测
```

### 类型生成

```bash
npm run db:types               # 从 Supabase 生成 TypeScript 类型
```

### 测试矩阵说明

- 本地默认测试入口：`scripts/run-test-matrix.cjs`
- 支持 **Lane 分片**、**Quarantine 隔离**、**LPT 调度**
- 更细的说明见 [scripts/README.md](scripts/README.md)

</details>

<details>
<summary><strong>🚀 部署、环境变量与 Supabase 初始化</strong></summary>

### 最少环境变量

| 变量 | 必需? | 用途 |
|------|:-----:|------|
| `NG_APP_SUPABASE_URL` | 云同步/生产：是 | Supabase 项目 URL |
| `NG_APP_SUPABASE_ANON_KEY` | 云同步/生产：是 | Supabase anon public key |
| `NG_APP_SENTRY_DSN` | 否 | Sentry 错误监控 |
| `NG_APP_GOJS_LICENSE_KEY` | 否 | GoJS 许可证（去水印） |
| `NG_APP_DEV_AUTO_LOGIN_EMAIL` | 否 | 本地开发自动登录邮箱 |
| `NG_APP_DEV_AUTO_LOGIN_PASSWORD` | 否 | 本地开发自动登录密码 |

### 初始化顺序

1. 创建 Supabase 项目
2. 创建私有 `attachments` 存储桶
3. 执行 [`scripts/init-supabase.sql`](scripts/init-supabase.sql)（v3.9.0，包含所有表/RLS/RPC/触发器/索引）
4. 配置环境变量
5. 如需语音转写，部署 `transcribe` Edge Function + 设置 `GROQ_API_KEY`
6. 如需定时清理，执行 [`scripts/cleanup-cron-setup.sql`](scripts/cleanup-cron-setup.sql)（需要 pg_cron 扩展）

### Android widget / push refresh（可选）

如果要启用 Android 手机端小组件的准实时刷新，还需要：

1. 部署 `widget-register`、`widget-summary`、`widget-notify`
2. 在本地放置 `android/app/google-services.json`，让 Android 宿主以 FCM 模式构建
3. 为 `widget-notify` 配置 `FCM_PROJECT_ID`、`FCM_CLIENT_EMAIL`、`FCM_PRIVATE_KEY`

说明：

- 缺少 `google-services.json` 时，Android 宿主仍可构建，但会自动降级为非 FCM 路径
- 缺少 FCM Secrets 时，小组件仍可通过手动刷新、解锁事件和周期任务保持可用，只是没有 dirty push

### 生产前建议

```bash
npm run validate-env:prod
npm run build:strict
```

### 托管配置

仓库内已提供：

| 平台 | 配置文件 |
|------|----------|
| Vercel（推荐） | [vercel.json](vercel.json) |
| Netlify | [netlify.toml](netlify.toml) |
| Railway | [railway.json](railway.json) |

部署细节：[docs/deploy-private-instance.md](docs/deploy-private-instance.md)

</details>

<details>
<summary><strong>🏗️ 架构与同步模型</strong></summary>

### 前端基线

| 技术 | 版本 | 用途 |
|------|------|------|
| Angular | 19.2.x | Signals + standalone + OnPush |
| TypeScript | 5.8.x | 严格类型 |
| Supabase JS | 2.84+ | Auth + PostgreSQL + Storage + Edge Functions |
| GoJS | 3.1.x | 流程图渲染 |
| Sentry | 10.32+ | 错误监控 + 会话回放 |
| Vitest | 4.0.x | 单元/服务/组件测试 |
| Playwright | 1.48+ | E2E 测试 |
| DOMPurify | 3.3+ | XSS 防护 |
| idb-keyval | 6.2+ | IndexedDB 封装 |

### 关键目录

```text
src/
  app/
    core/                 # state、sync、shell 核心层
    features/
      text/               # 文本视图
      flow/               # GoJS 流程图
      parking/            # Parking Dock
      focus/              # Focus Mode（gate / strata / black-box）
    shared/               # 共享组件、模态框、管道
  services/               # 业务服务层（85+ 服务）
  config/                 # 配置常量
  models/                 # 领域模型
  utils/                  # 工具函数（Result Pattern、error 转换等）

supabase/
  functions/              # Edge Functions
  migrations/             # 数据迁移
```

### 状态存储（Signals）

拆分为 3 个 `@Injectable` 单例：

| Store | 主要 Signal |
|-------|-------------|
| `TaskStore` | `tasksMap`、`tasksByProject`、`parkedTaskIds`、`parkedTasks` |
| `ProjectStore` | `projectsMap`、`activeProjectId`、`activeProject` |
| `ConnectionStore` | `connectionsMap`、`connectionsByProject` |

### Offline-First 数据流

```
读路径：IndexedDB → 后台增量拉取 (updated_at > last_sync_time)
写路径：本地写入 + UI 即时更新 → 3s 防抖 → 推送到云端 → 失败进入 RetryQueue
冲突策略：LWW (Last-Write-Wins)
```

### Hard Rules（开发必须遵守）

- 所有实体 ID 由客户端 `crypto.randomUUID()` 生成
- 禁止数据库自增 ID、临时 ID、同步时 ID 映射
- 手机端默认文本视图；Flow 按需 `@defer` 懒加载并彻底销毁/重建
- 树遍历仅允许迭代算法，深度上限 100
- 状态注入必须直接使用 `TaskStore` / `ProjectStore` / `ConnectionStore`，禁止新增门面 Store 聚合类

### 错误处理

- 统一 Result Pattern：`success(data)` / `failure(ErrorCodes.XXX, message)`
- Supabase 错误通过 `supabaseErrorToError()` 转换
- GlobalErrorHandler 分级：`SILENT` / `NOTIFY` / `RECOVERABLE` / `FATAL`
- Sentry 按需懒加载

### 关键配置基线

| 配置 | 值 |
|------|-----|
| 同步防抖 | 3000ms |
| 云端加载超时 | 30000ms |
| 轮询间隔（空闲） | 600000ms（10 分钟） |
| 轮询间隔（活跃） | 120000ms（2 分钟） |
| 回收站保留期 | 30 天 |
| 重试队列过期 | 24 小时 |
| 断路器阈值 | 连续 3 次失败 |
| 断路器恢复 | 30000ms |
| 撤销步数（桌面/移动） | 150 / 50 |
| 本地备份间隔 | 30 分钟 |
| 本地备份保留 | 30 份 |
| Gate 贪睡上限 | 3 次/天 |
| Gate 已读冷却 | 30 分钟 |
| 语音转写额度 | 50 次/天 |

</details>

<details>
<summary><strong>📚 补充文档地图</strong></summary>

### 部署 / 运维

- [docs/deploy-private-instance.md](docs/deploy-private-instance.md) — 私有实例部署指南
- [scripts/README.md](scripts/README.md) — 脚本与测试矩阵说明
- [docs/perf-gate-runbook.md](docs/perf-gate-runbook.md) — 性能门禁运维手册

### 功能设计

- [docs/focus-mode-design.md](docs/focus-mode-design.md) — Focus 模式设计
- [docs/focus-console-design.md](docs/focus-console-design.md) — Focus 控制台设计
- [docs/parking-dock-modular-design.md](docs/parking-dock-modular-design.md) — Parking Dock 模块化设计

### 数据与可靠性

- [docs/data-protection-plan.md](docs/data-protection-plan.md) — 数据保护方案
- [docs/data-loss-and-ui-truthfulness-master-plan-2026-02-09.md](docs/data-loss-and-ui-truthfulness-master-plan-2026-02-09.md) — 数据丢失防护总计划
- [docs/data-protection-plan-comprehensive-audit-report-2026-02-09.md](docs/data-protection-plan-comprehensive-audit-report-2026-02-09.md) — 数据保护审计报告

### 启动与性能

- [docs/pwa-instant-startup-plan.md](docs/pwa-instant-startup-plan.md) — PWA 秒开方案
- [docs/pwa-instant-open-plan.md](docs/pwa-instant-open-plan.md) — PWA 即时打开方案
- [docs/deep-performance-audit-2026-02-18.md](docs/deep-performance-audit-2026-02-18.md) — 深度性能审计

### Agent / 仓库执行规则

- [AGENTS.md](AGENTS.md) — Agent 执行手册
- [.github/copilot-instructions.md](.github/copilot-instructions.md) — Copilot 全局指令

</details>

<details>
<summary><strong>🔒 安全规则</strong></summary>

- API Key 只允许存储于 Supabase Secrets，禁止前端硬编码
- 所有数据表启用 RLS（Row Level Security），数据按 `user_id` 隔离
- 输入校验与消毒；Markdown 渲染经 DOMPurify XSS 防护
- 文件上传经过类型验证与病毒扫描
- Edge Function 代理第三方 API，前端不直连敏感凭证
- 附件上传超时 30 秒，感染文件隔离 30 天

</details>

<details>
<summary><strong>📊 性能目标</strong></summary>

| 指标 | 目标 |
|------|------|
| FCP (First Contentful Paint) | < 1.5s |
| TTI (Time to Interactive) | < 3s |
| Main bundle | < 500KB |
| 增量同步 | 只拉取变更，不全量加载 |
| GoJS 懒加载 | 按需 `@defer`，不阻塞首屏 |
| Sentry 懒加载 | 按需加载，不影响启动 |
| SQL 查询 | 只取必要字段，避免 `SELECT *` |

</details>

---

## 当前边界与取舍

- 当前主线服务于**个人工作流**，不以多人协作为目标。
- 云同步、附件、登录态、语音转写都依赖 Supabase。
- 本地自动备份仅适合**桌面 Chrome / Chromium** 类浏览器。
- 手机端默认文本视图，流程图不是移动端常驻主界面。
- 当前只保留 Android 手机端小组件；桌面端 widget runtime 已退役。
- 语音转写依赖 Groq API，有每日 50 次额度限制。
- 回收站 30 天后自动永久删除，需要保留的请先导出。

---

## License

MIT
