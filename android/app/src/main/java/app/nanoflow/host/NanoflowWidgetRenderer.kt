package app.nanoflow.host

import android.content.Context
import android.os.Build
import android.view.View
import android.widget.RemoteViews
import app.nanoflow.host.R

/**
 * 使用原生 [RemoteViews] 渲染 widget。
 *
 * 交互派发策略：中央内容区与右下角刷新按钮都走集合视图。内容区用纵向 ListView 承载
 * Focus / Gate 卡片，用户可直接上下滑动切换；刷新按钮保留独立 collection-view 路径，
 * 继续绕过 MIUI / HyperOS (com.miui.home) 对普通子视图 PendingIntent 的静默吞噬。
 *
 * Root 容器保留 `setOnClickPendingIntent` 作为整卡点击入口（打开 App / Focus Tools），
 * 确保在任意 launcher / 空白区域都能触发主要动作。
 */
object NanoflowWidgetRenderer {

  fun render(context: Context, appWidgetId: Int, model: WidgetRenderModel): RemoteViews {
    if (shouldUseStaticStatusLayout(model)) {
      return renderCompact(context, appWidgetId, model)
    }

    // 2026-04-22 蓝图 UI：LARGE / MEDIUM 共用 large layout（focus 或 gate 二选一），
    // 仅 SMALL 继续使用 compact 单行样式。这保证 2×4 倒下长方体与海报 1:1 还原。
    return when (model.sizeTier) {
      WidgetSizeTier.LARGE, WidgetSizeTier.MEDIUM -> renderLarge(context, appWidgetId, model)
      else -> renderCompact(context, appWidgetId, model)
    }
  }

  /**
   * 【2026-04-24 根因修复】Layout 签名：用于 receiver / worker 判断是否必须走 full
   * `updateAppWidget` 而非 `partiallyUpdateAppWidget`。
   *
   * partiallyUpdateAppWidget（= RemoteViews.reapply）**无法切换 layoutRes**：
   * 当 widget 当前 hostView 是 `nano_widget_large`（focus 布局，右下角保留 78×42 的
   * refresh_list + pendingIntentTemplate），新 model 切到 `nano_widget_large_gate`
   * 时若仍用 partial，launcher 只会把新 RemoteViews 的「已有操作」叠加到旧 hostView：
   * gate_actions_list 的 VISIBLE / adapter 生效，但旧 refresh_list 的尺寸 + 旧模板
   * 点击意图 **不会被清除**。用户点击底部区域会被 refresh_list 吃掉，触发
   * `widget_click_refresh` 而非预期的 `widget_click_gate_action`，表现为「已读 / 已完成
   * 按键被刷新按钮冲掉」+「专注模式 UI 闪一下被错误 UI 覆盖」。
   *
   * 解决：layout 签名变化时强制 full update，让 launcher 用新 @xml/layout 重新 inflate
   * hostView，彻底清掉旧结构。
   */
  fun resolveLayoutSignature(model: WidgetRenderModel): String {
    if (shouldUseStaticStatusLayout(model)) {
      return "compact-status"
    }

    val tierTag = when (model.sizeTier) {
      WidgetSizeTier.LARGE, WidgetSizeTier.MEDIUM -> "large"
      else -> "compact"
    }
    if (tierTag == "compact") return "compact"
    val useGateLayout = model.isGateMode || model.showSetup || model.showAuthRequired || model.showUntrusted
    return if (useGateLayout) "large-gate" else "large-focus"
  }

  // --- 紧凑布局：SMALL / MEDIUM 共用，单一 click -> 打开 App ---
  private fun renderCompact(context: Context, appWidgetId: Int, model: WidgetRenderModel): RemoteViews {
    val views = RemoteViews(context.packageName, R.layout.nano_widget_compact)
    views.setInt(R.id.nano_widget_root, "setBackgroundResource", rootBackgroundFor(model))
    views.setTextViewText(R.id.nano_widget_mode_label, model.modeLabel)
    views.setTextColor(R.id.nano_widget_mode_label, accentColorFor(model))
    views.setTextViewText(R.id.nano_widget_title, model.title.ifBlank { context.getString(R.string.app_name) })
    val subtitle = model.supportingLine?.takeIf { it.isNotBlank() } ?: model.statusLine
    if (subtitle.isNotBlank()) {
      views.setTextViewText(R.id.nano_widget_subtitle, subtitle)
      views.setViewVisibility(R.id.nano_widget_subtitle, View.VISIBLE)
    } else {
      views.setViewVisibility(R.id.nano_widget_subtitle, View.GONE)
    }
    views.setOnClickPendingIntent(
      R.id.nano_widget_root,
      NanoflowWidgetReceiver.primaryActionPendingIntent(context, appWidgetId, model.primaryAction),
    )
    return views
  }

  // --- 中大尺寸布局：Focus / Gate / 状态页（已不再单独走 medium 分支） ---
  @Suppress("unused")
  private fun renderMedium(context: Context, appWidgetId: Int, model: WidgetRenderModel): RemoteViews {
    // 保留函数签名以兼容旧路径；当前所有 MEDIUM/LARGE 都走 renderLarge。
    return renderLarge(context, appWidgetId, model)
  }

  private fun shouldUseStaticStatusLayout(model: WidgetRenderModel): Boolean {
    // 首次放置后的 setup/auth/untrusted 页面必须绕开 collection-view，避免 launcher
    // 还没绑定 content factory 时中心区域变成死区，导致用户第一次点击无法进入应用完成绑定。
    return model.showSetup || model.showAuthRequired || model.showUntrusted
  }

  private fun renderLarge(context: Context, appWidgetId: Int, model: WidgetRenderModel): RemoteViews {
    val useGateLayout = model.isGateMode || model.showSetup || model.showAuthRequired || model.showUntrusted
    val layoutRes = if (useGateLayout) R.layout.nano_widget_large_gate else R.layout.nano_widget_large
    val views = RemoteViews(context.packageName, layoutRes)

    // Root 点击 = 打开 App / Focus Tools（空白区 / 整卡回退）
    views.setOnClickPendingIntent(
      R.id.nano_widget_root,
      NanoflowWidgetReceiver.primaryActionPendingIntent(context, appWidgetId, model.primaryAction),
    )

    renderSyncBadge(views, model)
    renderModeHeader(views, model)

    if (useGateLayout) {
      renderGateCountRing(views, model)
      renderContentList(context, views, appWidgetId, model)
      if (model.isGateMode) {
        views.setViewVisibility(R.id.nano_widget_gate_actions_list, View.VISIBLE)
        renderGateActionsList(context, views, appWidgetId, model)
      } else {
        views.setViewVisibility(R.id.nano_widget_gate_actions_list, View.GONE)
      }
    } else {
      renderTabList(context, views, appWidgetId)
      // 2026-04-24：移除右下角 refresh GridView。focus 模式不再渲染 refresh 接收器，
      // 用户操作通过 root 点击与 tab slot 完成。layoutRes 不再含 R.id.nano_widget_refresh_list。
      renderFocusFooter(context, views, model)
      renderFocusActionsList(context, views, appWidgetId, model)
      renderFocusWaitPresetList(context, views, appWidgetId, model)
    }

    return views
  }

  /** 顶部 tab 栏：通过 GridView + RemoteViewsFactory 动态渲染主任务/副任务 chip。 */
  private fun renderTabList(context: Context, views: RemoteViews, appWidgetId: Int) {
    val tabAdapter = NanoflowWidgetReceiver.actionListAdapterIntent(
      context, appWidgetId, NanoflowWidgetActionFactory.LIST_KIND_TABS,
    )
    views.setRemoteAdapter(R.id.nano_widget_tab_list, tabAdapter)
    views.setPendingIntentTemplate(
      R.id.nano_widget_tab_list,
      NanoflowWidgetReceiver.actionListClickTemplatePendingIntent(context, appWidgetId),
    )
  }

  private fun renderContentList(context: Context, views: RemoteViews, appWidgetId: Int, model: WidgetRenderModel) {
    val contentAdapter = NanoflowWidgetReceiver.actionListAdapterIntent(
      context,
      appWidgetId,
      NanoflowWidgetActionFactory.LIST_KIND_CONTENT,
      stateToken = buildContentAdapterStateToken(model),
    )
    views.setRemoteAdapter(R.id.nano_widget_content_list, contentAdapter)
    // 内容列表点击必须启动 LauncherActivity，使用 activity-target 模板直通
    // （不走 receiver 广播中转），避免 Android 14+ BAL_BLOCK 拦截。
    views.setPendingIntentTemplate(
      R.id.nano_widget_content_list,
      NanoflowWidgetReceiver.contentListClickTemplatePendingIntent(context, appWidgetId, model.primaryAction),
    )
  }

  private fun renderRefreshList(context: Context, views: RemoteViews, appWidgetId: Int) {
    val refreshAdapter = NanoflowWidgetReceiver.actionListAdapterIntent(
      context, appWidgetId, NanoflowWidgetActionFactory.LIST_KIND_REFRESH,
    )
    views.setRemoteAdapter(R.id.nano_widget_refresh_list, refreshAdapter)
    views.setPendingIntentTemplate(
      R.id.nano_widget_refresh_list,
      NanoflowWidgetReceiver.actionListClickTemplatePendingIntent(context, appWidgetId),
    )
  }

  // --- 背景 / 配色辅助 ---
  private fun rootBackgroundFor(model: WidgetRenderModel): Int {
    return when (model.tone) {
      WidgetVisualTone.FOCUS -> R.drawable.nano_widget_root_focus
      WidgetVisualTone.GATE,
      WidgetVisualTone.SETUP,
      WidgetVisualTone.AUTH,
      WidgetVisualTone.UNTRUSTED -> R.drawable.nano_widget_root_gate
    }
  }

  private fun accentColorFor(model: WidgetRenderModel): Int {
    return when (model.tone) {
      WidgetVisualTone.FOCUS,
      WidgetVisualTone.GATE -> 0xFFEAF3FF.toInt()
      WidgetVisualTone.SETUP,
      WidgetVisualTone.AUTH,
      WidgetVisualTone.UNTRUSTED -> 0xFFFFE4D6.toInt()
    }
  }

  // --- 同步徽章（蓝图风：纯文字，不再带彩色圆点） ---
  private fun renderSyncBadge(views: RemoteViews, model: WidgetRenderModel) {
    val statusLabel = model.syncBadgeLabel ?: model.statusBadge
    if (statusLabel.isNullOrBlank()) {
      views.setViewVisibility(R.id.nano_widget_sync_badge, View.GONE)
    } else {
      views.setTextViewText(R.id.nano_widget_sync_badge, statusLabel)
      views.setViewVisibility(R.id.nano_widget_sync_badge, View.VISIBLE)
    }
    // 2026-04-22 蓝图 UI：不再绘制 sync 状态彩色圆点。mode_label 已由 header 图标表达模式；
    // 多余的色点与「白色技术线稿」蓝图语言冲突，统一清除右侧 compoundDrawable。
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      views.setTextViewCompoundDrawablesRelative(R.id.nano_widget_sync_badge, 0, 0, 0, 0)
    }
  }

  // --- 模式头部：mode_label 文字永远显示（布局已带图标），此处只保证文字最新 ---
  private fun renderModeHeader(views: RemoteViews, model: WidgetRenderModel) {
    views.setTextViewText(R.id.nano_widget_mode_label, model.modeLabel)
  }

  /**
   * MIUI / HyperOS 会偶发复用旧的 RemoteViewsFactory；把中央卡片状态折进 identity，
   * 让空大门 <-> 非空大门、条目轮换等切换时强制创建新 factory。
   *
   * 【2026-05-03 根因修复补丁】在非空大门模式下额外加入 15 分钟时间桶。
   * MIUI 的 ApplicationThreadDeferred 会在 app 处于 CEM 状态时暂停主线程，导致
   * factory 服务的 onBind 回调被挂起，launcher 无法重建 factory，即便内存中的
   * DataStore 已有有效条目，content_list 仍然展示空白。15 分钟桶保证：在进程解冻后，
   * 至多 15 分钟内渲染路径就会产生与上一次不同的 URI，触发 launcher 重新绑定 factory
   * 服务并调用 onCreate()，从 DataStore 拉到最新数据。
   */
  private fun buildContentAdapterStateToken(model: WidgetRenderModel): String {
    val topCard = model.contentCards.firstOrNull()
    // 非空大门：注入 15 分钟时间桶，确保即使内容不变也会周期性换 factory。
    val timeBucket = if (model.isGateMode && model.displayedGateEntryId != null) {
      (System.currentTimeMillis() / (15L * 60L * 1000L)).toString()
    } else {
      null
    }
    return buildAdapterStateToken(
      model.tone.name,
      model.primaryAction.name,
      model.isGateMode.toString(),
      model.blackBoxCount.toString(),
      model.displayedGateEntryId,
      topCard?.title,
      topCard?.subtitle,
      topCard?.metaStart,
      topCard?.metaEnd,
      topCard?.isGateEmptyState.toString(),
      timeBucket,
    )
  }

  private fun buildGateActionsAdapterStateToken(model: WidgetRenderModel): String {
    val topCard = model.contentCards.firstOrNull()
    // 同 content adapter：非空大门注入 15 分钟时间桶，保证按钮 factory 同步刷新。
    val timeBucket = if (model.isGateMode && model.displayedGateEntryId != null) {
      (System.currentTimeMillis() / (15L * 60L * 1000L)).toString()
    } else {
      null
    }
    return buildAdapterStateToken(
      model.isGateMode.toString(),
      model.displayedGateEntryId,
      topCard?.isGateEmptyState.toString(),
      model.blackBoxCount.toString(),
      timeBucket,
    )
  }

  private fun buildAdapterStateToken(vararg parts: String?): String {
    val raw = parts.joinToString("|") { it.orEmpty() }
    return raw.hashCode().toString()
  }

  // --- 大门计数徽章：(N) 圆环，仅 gate 模式可见 ---
  private fun renderGateCountRing(views: RemoteViews, model: WidgetRenderModel) {
    val count = model.blackBoxCount
    if (count <= 0) {
      views.setViewVisibility(R.id.nano_widget_gate_count_ring, View.GONE)
      return
    }
    views.setTextViewText(R.id.nano_widget_gate_count_text, count.toString())
    views.setViewVisibility(R.id.nano_widget_gate_count_ring, View.VISIBLE)
  }

  // --- 大门双按钮 GridView：已读 / 完成 ---
  private fun renderGateActionsList(
    context: Context,
    views: RemoteViews,
    appWidgetId: Int,
    model: WidgetRenderModel,
  ) {
    val adapter = NanoflowWidgetReceiver.actionListAdapterIntent(
      context,
      appWidgetId,
      NanoflowWidgetActionFactory.LIST_KIND_GATE_ACTIONS,
      stateToken = buildGateActionsAdapterStateToken(model),
    )
    views.setRemoteAdapter(R.id.nano_widget_gate_actions_list, adapter)
    views.setPendingIntentTemplate(
      R.id.nano_widget_gate_actions_list,
      NanoflowWidgetReceiver.gateActionClickTemplatePendingIntent(context, appWidgetId),
    )
  }

  // --- 专注模式底部双按钮 / 等待预设 ---
  private fun renderFocusActionsList(
    context: Context,
    views: RemoteViews,
    appWidgetId: Int,
    model: WidgetRenderModel,
  ) {
    if (model.tasks.firstOrNull()?.taskId.isNullOrBlank()) {
      views.setViewVisibility(R.id.nano_widget_focus_actions_list, View.GONE)
      views.setViewVisibility(R.id.nano_widget_focus_wait_presets_list, View.GONE)
      return
    }
    val adapter = NanoflowWidgetReceiver.actionListAdapterIntent(
      context,
      appWidgetId,
      NanoflowWidgetActionFactory.LIST_KIND_FOCUS_ACTIONS,
    )
    views.setRemoteAdapter(R.id.nano_widget_focus_actions_list, adapter)
    views.setPendingIntentTemplate(
      R.id.nano_widget_focus_actions_list,
      NanoflowWidgetReceiver.actionListClickTemplatePendingIntent(context, appWidgetId),
    )
    views.setViewVisibility(
      R.id.nano_widget_focus_actions_list,
      if (model.focusWaitMenuOpen) View.GONE else View.VISIBLE,
    )
  }

  private fun renderFocusWaitPresetList(
    context: Context,
    views: RemoteViews,
    appWidgetId: Int,
    model: WidgetRenderModel,
  ) {
    if (model.tasks.firstOrNull()?.taskId.isNullOrBlank()) {
      views.setViewVisibility(R.id.nano_widget_focus_wait_presets_list, View.GONE)
      return
    }
    val adapter = NanoflowWidgetReceiver.actionListAdapterIntent(
      context,
      appWidgetId,
      NanoflowWidgetActionFactory.LIST_KIND_FOCUS_WAIT_PRESETS,
    )
    views.setRemoteAdapter(R.id.nano_widget_focus_wait_presets_list, adapter)
    views.setPendingIntentTemplate(
      R.id.nano_widget_focus_wait_presets_list,
      NanoflowWidgetReceiver.actionListClickTemplatePendingIntent(context, appWidgetId),
    )
    views.setViewVisibility(
      R.id.nano_widget_focus_wait_presets_list,
      if (model.focusWaitMenuOpen) View.VISIBLE else View.GONE,
    )
  }

  // --- 专注模式底栏：「备选区：N 个任务  ›」 ---
  private fun renderFocusFooter(context: Context, views: RemoteViews, model: WidgetRenderModel) {
    val visibleSecondarySlots = (model.tasks.size - 1).coerceAtLeast(0)
    val overflow = (model.dockCount - visibleSecondarySlots).coerceAtLeast(0)
    // 即使 overflow=0 也保留文案，改写为 0 个任务，保证海报对齐的底栏视觉
    views.setTextViewText(
      R.id.nano_widget_footer_label,
      if (model.focusWaitMenuOpen) {
        context.getString(R.string.nanoflow_widget_focus_wait_menu_label)
      } else {
        context.getString(R.string.nanoflow_widget_focus_backup_zone, overflow)
      },
    )
    views.setViewVisibility(R.id.nano_widget_footer_label, View.VISIBLE)
  }

  // --- 标题 + 副标题 ---
  private fun renderMiddleTitle(views: RemoteViews, model: WidgetRenderModel) {
    val (title, subtitle) = resolveTitleAndSubtitle(model)
    views.setTextViewText(R.id.nano_widget_title, title)
    if (subtitle.isNullOrBlank()) {
      views.setViewVisibility(R.id.nano_widget_subtitle, View.GONE)
    } else {
      views.setTextViewText(R.id.nano_widget_subtitle, subtitle)
      views.setViewVisibility(R.id.nano_widget_subtitle, View.VISIBLE)
    }
  }

  private fun resolveTitleAndSubtitle(model: WidgetRenderModel): Pair<String, String?> {
    if (model.tasks.isNotEmpty()) {
      val idx = model.selectedTaskIndex.coerceIn(0, model.tasks.lastIndex)
      val card = model.tasks[idx]
      return card.title to null
    }
    return model.title to model.supportingLine
  }
}
