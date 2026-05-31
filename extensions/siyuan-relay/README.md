# NanoFlow SiYuan Relay

这是 Knowledge Anchor 的桌面浏览器扩展 Relay 最小实现，用于在 HTTPS PWA 中安全读取本机思源内核的只读块预览。

## 安全边界

- token 只保存在扩展 `chrome.storage.local`。
- 自 v0.2.0 起新增"页面 → 扩展"单向写入通道：用户在 NanoFlow 设置页填写 baseUrl / token 后，浏览器通过 content-script 把字段写入扩展存储，**扩展不会回传 token 明文**（`get-config-status` 仅返回 `{ baseUrl, hasToken }`）；NanoFlow 页面端**不**把 token 持久化到 IndexedDB 或上传到云端。
- content script 只在 NanoFlow 正式域名、本地开发域名和预览域名注入（含 `https://www.nanoflow.app`，以及 `http://localhost:*` / `http://127.0.0.1:*` 本地端口）。
- 本地开发放行任意 localhost 端口是为了兼容 Vite/Angular 多端口调试；请勿在启用扩展时运行不可信本地服务。
- background 只允许访问策划案中列出的只读接口：
  - `/api/system/version`
  - `/api/block/getBlockKramdown`
  - `/api/block/getChildBlocks`
  - `/api/filetree/getHPathByID`
  - `/api/filetree/getHPathByPath`
  - `/api/filetree/getPathByID`
  - `/api/attr/getBlockAttrs`
- 不提供通用 URL 代理、SQL、文件、snippet 或写接口。

## 本地安装验证

1. 打开 Chrome/Edge 扩展管理页并启用开发者模式。
2. 选择"加载已解压的扩展"，目录必须选择包含 `manifest.json` 的扩展根目录：
   - 从仓库源码安装：选择 `extensions/siyuan-relay`。
   - 从 GitHub 下载 ZIP 后安装：先完整解压仓库，再选择 `dde-main/extensions/siyuan-relay`（或对应分支名的同级目录）。
   - 如果你把扩展复制到桌面或其他目录时，请确认被选中的 `siyuan-relay` 目录内同时存在 `manifest.json` 和 `src/`（Windows 示例：`C:\Users\你的用户名\Desktop\siyuan-relay\manifest.json`）；不要选择仓库根目录、`src` 子目录，或只从 GitHub 页面单独保存下来的空目录。
3. 打开 NanoFlow，设置页选择"浏览器扩展 Relay（推荐）"，在"本机 Token"输入框填写思源 API Token，点击**保存到扩展**。
4. 点击"测试连接"验证。
5. （可选）扩展 Options 页保留作为备用入口，可手动配置或排查。

## 排障速查

- 扩展灰色 ≠ 一定故障：MV3 图标可能保持灰色，请以 NanoFlow 设置页"测试连接"结果为准。
- Chrome/Edge 提示"清单文件缺失或不可读取 / Manifest file is missing or unreadable"时，说明当前选择的目录根部没有可读取的 `manifest.json`；重新选择上面第 2 步的扩展根目录即可。
- 若提示"扩展未安装或未注入当前页面"，请确认当前页面 origin 属于上述注入范围，并刷新页面后重试。
- 若提示"扩展未安装或版本过旧"，说明扩展不支持页面配置通道（`get-config-status` / `set-config`），请升级到 v0.2.0 及以上。
- 若提示"未配置 token"，请在 NanoFlow 设置页填写并点击"保存到扩展"，或在扩展 Options 页填写。
- 若提示"未连接到思源"，请确认思源内核已启动且可访问 `http://127.0.0.1:6806`。

## 扩展版本与页面兼容性

- 旧扩展（< v0.2.0）+ 新页面：页面会在状态徽标提示"扩展未安装或版本过旧"，"保存到扩展"按钮被禁用；用户可继续使用扩展 Options 页手填，原有预览路径不破坏。
- 新扩展（>= v0.2.0）+ 旧页面：扩展依然按 v0.1.0 兼容，set-config / get-config-status 消息会被旧页面忽略，无副作用。

## 回滚

如 Relay 异常，可在 NanoFlow 设置页切换到"仅缓存与深链"，任务锚点仍会显示并可通过 `siyuan://blocks/{id}?focus=1` 打开原块。
