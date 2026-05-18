package app.nanoflow.host

import android.content.Context
import android.content.Intent
import android.view.View
import android.widget.RemoteViews
import android.widget.RemoteViewsService
import app.nanoflow.host.R
import kotlinx.coroutines.runBlocking

/**
 * 集合视图 Factory：把当前 widget 的中心内容区 / Refresh 翻译成一组 item。
 *
 * Refresh item 走 [R.layout.nano_widget_action_item]，中心内容卡片走
 * [R.layout.nano_widget_content_item]；两者都通过 `fillInIntent` 绑定点击上下文。
 */
class NanoflowWidgetActionFactory(
  private val context: Context,
  private val appWidgetId: Int,
  private val listKind: String = LIST_KIND_TABS,
) : RemoteViewsService.RemoteViewsFactory {

  private data class ActionItem(
    val label: String,
    val selected: Boolean,
    val kind: Kind,
    val eyebrow: String? = null,
    val subtitle: String? = null,
    val metaStart: String? = null,
    val metaEnd: String? = null,
    val interactionHint: String? = null,
    // kind 相关的数据：TAB 用 taskIndex，GATE_NAV 用 gateDelta
    val taskIndex: Int = -1,
    val gateDelta: Int = 0,
    val clickable: Boolean = true,
    val styleTone: ChipTone = ChipTone.SURFACE,
    val primaryAction: WidgetPrimaryAction? = null,
    val taskId: String? = null,
    // 蓝图 UI 新增字段
    val isMasterTask: Boolean = false,
    val isPlaceholderSlot: Boolean = false,
    val gateAction: String? = null,
    val gateEntryId: String? = null,
    val focusAction: String? = null,
    val waitMinutes: Int? = null,
    val gateCreatedLabel: String? = null,
    val gateReadAtLabel: String? = null,
    val isWaitExpired: Boolean = false,
    /** 大门空状态（E 图）：Factory 渲染 GATE_CARD 时切换图标为 🚪 并隐藏 meta 行。 */
    val isGateEmptyState: Boolean = false,
  ) {
    enum class Kind { TAB, OVERFLOW, REFRESH, GATE_PREV, GATE_NEXT, GATE_LABEL, PRIMARY, GATE_ACTION, GATE_CARD, FOCUS_ACTION }
    enum class ChipTone { ACCENT, SURFACE, ACCENT_GATE, SURFACE_GATE, TAB_SURFACE, TAB_SURFACE_GATE }
  }

  private var items: List<ActionItem> = emptyList()

  override fun onCreate() {
    // 初次加载：预热数据集。
    refreshItems()
  }

  override fun onDataSetChanged() {
    // AppWidgetManager.notifyAppWidgetViewDataChanged() 触发；重新读模型。
    refreshItems()
  }

  override fun onDestroy() {
    items = emptyList()
  }

  override fun getCount(): Int = items.size

  override fun getViewAt(position: Int): RemoteViews {
    if (position < 0 || position >= items.size) return emptyItemView()
    val item = items[position]

    if (listKind == LIST_KIND_CONTENT) {
      // 2026-04-22 蓝图 UI：gate 模式下改用 nano_widget_gate_card_item（带 📄 图标 + 创建/已读元信息）
      if (item.kind == ActionItem.Kind.GATE_CARD) {
        val views = RemoteViews(context.packageName, R.layout.nano_widget_gate_card_item)
        views.setTextViewText(R.id.nano_widget_gate_card_title, item.label.ifBlank { item.subtitle ?: "" })
        if (item.isGateEmptyState) {
          // 空大门（E 图）：🚪 图标 + 「点击进入项目」提示 + 隐藏 创建/已读 meta 行
          views.setImageViewResource(R.id.nano_widget_gate_card_icon, R.drawable.nano_widget_icon_door)
          views.setViewVisibility(R.id.nano_widget_gate_card_meta_row, View.GONE)
          views.setViewVisibility(R.id.nano_widget_gate_card_chevron, View.VISIBLE)
          val subtitleText = item.subtitle?.takeIf { it.isNotBlank() } ?: ""
          if (subtitleText.isBlank()) {
            views.setViewVisibility(R.id.nano_widget_gate_card_subtitle, View.GONE)
          } else {
            views.setTextViewText(R.id.nano_widget_gate_card_subtitle, subtitleText)
            views.setViewVisibility(R.id.nano_widget_gate_card_subtitle, View.VISIBLE)
          }
        } else {
          views.setImageViewResource(R.id.nano_widget_gate_card_icon, R.drawable.nano_widget_icon_document)
          views.setViewVisibility(R.id.nano_widget_gate_card_meta_row, View.VISIBLE)
          views.setViewVisibility(R.id.nano_widget_gate_card_subtitle, View.GONE)
          views.setViewVisibility(R.id.nano_widget_gate_card_chevron, View.GONE)
          val createdLabel = item.gateCreatedLabel
          if (createdLabel.isNullOrBlank()) {
            views.setTextViewText(R.id.nano_widget_gate_card_created, "")
          } else {
            views.setTextViewText(R.id.nano_widget_gate_card_created, createdLabel)
          }
          val readAtLabel = item.gateReadAtLabel
          if (readAtLabel.isNullOrBlank()) {
            views.setTextViewText(R.id.nano_widget_gate_card_read_at, "")
          } else {
            views.setTextViewText(R.id.nano_widget_gate_card_read_at, readAtLabel)
          }
        }
        if (item.clickable) {
          val fillInIntent = buildFillInIntent(item)
          views.setOnClickFillInIntent(R.id.nano_widget_gate_card_root, fillInIntent)
        }
        return views
      }

      val views = RemoteViews(context.packageName, R.layout.nano_widget_content_item)
      if (item.eyebrow.isNullOrBlank()) {
        views.setViewVisibility(R.id.nano_widget_content_eyebrow, View.GONE)
      } else {
        views.setTextViewText(R.id.nano_widget_content_eyebrow, item.eyebrow)
        views.setViewVisibility(R.id.nano_widget_content_eyebrow, View.VISIBLE)
      }
      views.setTextViewText(R.id.nano_widget_content_title, item.label)
      if (item.subtitle.isNullOrBlank()) {
        views.setViewVisibility(R.id.nano_widget_content_subtitle, View.GONE)
      } else {
        views.setTextViewText(R.id.nano_widget_content_subtitle, item.subtitle)
        views.setViewVisibility(R.id.nano_widget_content_subtitle, View.VISIBLE)
      }
      if (item.metaStart.isNullOrBlank()) {
        views.setViewVisibility(R.id.nano_widget_content_meta_start, View.GONE)
      } else {
        views.setTextViewText(R.id.nano_widget_content_meta_start, item.metaStart)
        views.setViewVisibility(R.id.nano_widget_content_meta_start, View.VISIBLE)
      }
      if (item.metaEnd.isNullOrBlank()) {
        views.setViewVisibility(R.id.nano_widget_content_meta_end, View.GONE)
      } else {
        views.setTextViewText(R.id.nano_widget_content_meta_end, item.metaEnd)
        views.setViewVisibility(R.id.nano_widget_content_meta_end, View.VISIBLE)
      }
      if (item.interactionHint.isNullOrBlank()) {
        views.setViewVisibility(R.id.nano_widget_content_hint, View.GONE)
      } else {
        views.setTextViewText(R.id.nano_widget_content_hint, item.interactionHint)
        views.setViewVisibility(R.id.nano_widget_content_hint, View.VISIBLE)
      }
      if (item.clickable) {
        val fillInIntent = buildFillInIntent(item)
        views.setOnClickFillInIntent(R.id.nano_widget_content_item_root, fillInIntent)
        views.setOnClickFillInIntent(R.id.nano_widget_content_title, fillInIntent)
        views.setOnClickFillInIntent(R.id.nano_widget_content_eyebrow, fillInIntent)
        views.setOnClickFillInIntent(R.id.nano_widget_content_subtitle, fillInIntent)
        views.setOnClickFillInIntent(R.id.nano_widget_content_meta_start, fillInIntent)
        views.setOnClickFillInIntent(R.id.nano_widget_content_meta_end, fillInIntent)
        views.setOnClickFillInIntent(R.id.nano_widget_content_hint, fillInIntent)
      }
      return views
    }

    if (listKind == LIST_KIND_GATE_ACTIONS) {
      // 大门模式的双按钮：已读 / 完成
      val views = RemoteViews(context.packageName, R.layout.nano_widget_gate_action_item)
      views.setTextViewText(R.id.nano_widget_gate_action_label, item.label)
      val iconRes = when (item.gateAction) {
        GATE_ACTION_COMPLETE -> R.drawable.nano_widget_icon_check
        else -> R.drawable.nano_widget_icon_eye
      }
      views.setImageViewResource(R.id.nano_widget_gate_action_icon, iconRes)
      if (item.clickable) {
        val fillInIntent = buildFillInIntent(item)
        views.setOnClickFillInIntent(R.id.nano_widget_gate_action_root, fillInIntent)
        views.setOnClickFillInIntent(R.id.nano_widget_gate_action_slot, fillInIntent)
      }
      return views
    }

    if (listKind == LIST_KIND_FOCUS_ACTIONS || listKind == LIST_KIND_FOCUS_WAIT_PRESETS) {
      val views = RemoteViews(context.packageName, R.layout.nano_widget_focus_action_item)
      views.setTextViewText(R.id.nano_widget_focus_action_label, item.label)
      val iconRes = when (item.focusAction) {
        FOCUS_ACTION_COMPLETE -> R.drawable.nano_widget_icon_check
        FOCUS_ACTION_WAIT,
        FOCUS_ACTION_WAIT_PRESET -> R.drawable.nano_widget_icon_clock
        else -> R.drawable.nano_widget_icon_clock
      }
      views.setImageViewResource(R.id.nano_widget_focus_action_icon, iconRes)
      val showIcon = item.focusAction != FOCUS_ACTION_WAIT_PRESET
      views.setViewVisibility(R.id.nano_widget_focus_action_icon, if (showIcon) View.VISIBLE else View.GONE)
      views.setViewVisibility(R.id.nano_widget_focus_action_gap, if (showIcon) View.VISIBLE else View.GONE)
      if (item.clickable) {
        val fillInIntent = buildFillInIntent(item)
        views.setOnClickFillInIntent(R.id.nano_widget_focus_action_root, fillInIntent)
        views.setOnClickFillInIntent(R.id.nano_widget_focus_action_slot, fillInIntent)
      }
      return views
    }

    if (listKind == LIST_KIND_TABS) {
      // 蓝图 C 位插槽：中央图标 + 左上编号徽章 + 底部标签 + 主/副两档描边
      val views = RemoteViews(context.packageName, R.layout.nano_widget_tab_item)
      val isMasterTask = item.isMasterTask
      val slotBg = if (isMasterTask) R.drawable.nano_widget_slot_primary else R.drawable.nano_widget_slot_secondary
      val badgeBg = when {
        item.isWaitExpired -> R.drawable.nano_widget_badge_alert
        isMasterTask -> R.drawable.nano_widget_badge_primary
        else -> R.drawable.nano_widget_badge_secondary
      }
      val iconRes = if (isMasterTask) R.drawable.nano_widget_icon_crown else R.drawable.nano_widget_icon_flag
      views.setInt(R.id.nano_widget_tab_slot, "setBackgroundResource", slotBg)
      views.setInt(R.id.nano_widget_tab_badge, "setBackgroundResource", badgeBg)
      views.setTextViewText(R.id.nano_widget_tab_badge_text, (item.taskIndex + 1).coerceAtLeast(1).toString())
      // 王冠任务用顶部 pennant；旗帜任务保持圆徽章，点击换位后视觉语义不变。
      if (isMasterTask) {
        views.setInt(R.id.nano_widget_tab_badge_text, "setGravity", android.view.Gravity.TOP or android.view.Gravity.CENTER_HORIZONTAL)
        views.setViewPadding(R.id.nano_widget_tab_badge_text, 0, dpToPx(3), 0, 0)
      } else {
        views.setInt(R.id.nano_widget_tab_badge_text, "setGravity", android.view.Gravity.CENTER)
        views.setViewPadding(R.id.nano_widget_tab_badge_text, 0, 0, 0, 0)
      }
      views.setImageViewResource(R.id.nano_widget_tab_icon, iconRes)
      views.setTextViewText(R.id.nano_widget_tab_label, item.label)
      if (item.clickable && !item.isPlaceholderSlot) {
        views.setOnClickFillInIntent(R.id.nano_widget_tab_slot, buildFillInIntent(item))
      }
      return views
    }

    // LIST_KIND_REFRESH（剩余唯一路径）：继续使用 action_item chip 样式
    val views = RemoteViews(context.packageName, R.layout.nano_widget_action_item)
    views.setTextViewText(R.id.nano_widget_action_chip, item.label)
    applyChipStyle(views, item.styleTone)
    if (item.clickable) {
      views.setOnClickFillInIntent(
        R.id.nano_widget_action_chip,
        buildFillInIntent(item),
      )
    }
    return views
  }

  override fun getLoadingView(): RemoteViews = emptyItemView()
  override fun getViewTypeCount(): Int = when (listKind) {
    // content 列表会在 Focus/状态页 与 Gate 大卡之间切布局；必须给 host 至少两个 view type。
    LIST_KIND_CONTENT -> 2
    else -> 1
  }
  override fun getItemId(position: Int): Long = position.toLong()
  override fun hasStableIds(): Boolean = true

  private fun emptyItemView(): RemoteViews =
    RemoteViews(
      context.packageName,
      when (listKind) {
        LIST_KIND_CONTENT -> R.layout.nano_widget_content_item
        LIST_KIND_TABS -> R.layout.nano_widget_tab_item
        LIST_KIND_GATE_ACTIONS -> R.layout.nano_widget_gate_action_item
        LIST_KIND_FOCUS_ACTIONS,
        LIST_KIND_FOCUS_WAIT_PRESETS -> R.layout.nano_widget_focus_action_item
        else -> R.layout.nano_widget_action_item
      },
    )

  // --- 构建当前 item 列表 ---
  private fun refreshItems() {
    items = runBlocking {
      val model = NanoflowWidgetRepository(context).buildRenderModel(appWidgetId)
      computeItems(model)
    }
  }

  private fun computeItems(model: WidgetRenderModel): List<ActionItem> {
    val isGateTone = model.tone == WidgetVisualTone.GATE

    if (listKind == LIST_KIND_CONTENT) {
      val contentCards = model.contentCards.ifEmpty {
        listOf(
          WidgetContentCard(
            eyebrow = model.modeLabel,
            title = model.title,
            subtitle = model.supportingLine,
            metaStart = model.metricsLine,
            metaEnd = model.statusLine,
          )
        )
      }
      // 2026-04-22 蓝图 UI：gate 模式的 content 列表改用专用 gate card item（带 📄 图标与创建/已读元信息）
      if (model.isGateMode) {
        val top = contentCards.first()
        val isEmptyState = top.isGateEmptyState
        val createdLabel = if (isEmptyState) null else top.metaStart?.takeIf { it.isNotBlank() }?.let { raw ->
          // metaStart 通常形如「创建 05-20」——海报用「创建：05-20」，去掉空格加冒号
          raw.replaceFirst(" ", "：")
        }
        val readAtLabel = if (isEmptyState) null else top.metaEnd?.takeIf { it.isNotBlank() }?.let { raw ->
          val trimmed = raw.trim()
          // 「已读 32 分钟前」→「已读：32 分钟前」；「待回顾」原样保留
          if (trimmed.startsWith("已读")) trimmed.replaceFirst("已读 ", "已读：") else trimmed
        }
        return listOf(
          ActionItem(
            label = top.title,
            selected = false,
            kind = ActionItem.Kind.GATE_CARD,
            eyebrow = top.eyebrow,
            subtitle = top.subtitle,
            clickable = true,
            primaryAction = model.primaryAction,
            gateCreatedLabel = createdLabel,
            gateReadAtLabel = readAtLabel,
            isGateEmptyState = isEmptyState,
          )
        )
      }
      return contentCards.mapIndexed { index, card ->
        ActionItem(
          label = card.title,
          selected = false,
          kind = ActionItem.Kind.PRIMARY,
          eyebrow = card.eyebrow,
          subtitle = card.subtitle,
          metaStart = card.metaStart,
          metaEnd = card.metaEnd,
          interactionHint = card.interactionHint,
          taskIndex = if (model.tasks.isNotEmpty() && index <= model.tasks.lastIndex) index else -1,
          clickable = true,
          primaryAction = model.primaryAction,
        )
      }
    }

    if (listKind == LIST_KIND_REFRESH) {
      // 独立 refresh 列表：只包含一个 refresh chip。
      return listOf(
        ActionItem(
          label = context.getString(R.string.nanoflow_widget_refresh),
          selected = false,
          kind = ActionItem.Kind.REFRESH,
          styleTone = if (isGateTone) ActionItem.ChipTone.SURFACE_GATE else ActionItem.ChipTone.SURFACE,
        )
      )
    }

    if (listKind == LIST_KIND_GATE_ACTIONS) {
      // 蓝图 UI：仅当当前 gate 条目仍可直接执行时展示双按钮（已读 / 完成）；
      // 非隐私模式下无正文 fallback 只作为占位提示，不应继续显示动作按钮。
      val displayedGateEntryId = model.displayedGateEntryId?.takeIf { it.isNotBlank() }
      val gateActions = resolveGateActionCodesForModel(model)
      if (displayedGateEntryId == null || gateActions.isEmpty()) {
        return emptyList()
      }
      return gateActions.map { gateAction ->
        val labelRes = when (gateAction) {
          GATE_ACTION_READ -> R.string.nanoflow_widget_gate_action_read
          else -> R.string.nanoflow_widget_gate_action_complete
        }
        ActionItem(
          label = context.getString(labelRes),
          selected = false,
          kind = ActionItem.Kind.GATE_ACTION,
          gateAction = gateAction,
          gateEntryId = displayedGateEntryId,
          clickable = true,
          primaryAction = WidgetPrimaryAction.OPEN_FOCUS_TOOLS,
        )
      }
    }

    if (listKind == LIST_KIND_FOCUS_ACTIONS) {
      if (model.isGateMode || model.tasks.firstOrNull()?.taskId.isNullOrBlank()) {
        return emptyList()
      }
      val frontTaskId = model.tasks.first().taskId
      return listOf(
        ActionItem(
          label = context.getString(R.string.nanoflow_widget_focus_action_complete),
          selected = false,
          kind = ActionItem.Kind.FOCUS_ACTION,
          focusAction = FOCUS_ACTION_COMPLETE,
          taskId = frontTaskId,
          clickable = true,
        ),
        ActionItem(
          label = context.getString(R.string.nanoflow_widget_focus_action_wait),
          selected = false,
          kind = ActionItem.Kind.FOCUS_ACTION,
          focusAction = FOCUS_ACTION_WAIT,
          taskId = frontTaskId,
          clickable = true,
        ),
      )
    }

    if (listKind == LIST_KIND_FOCUS_WAIT_PRESETS) {
      if (model.isGateMode || !model.focusWaitMenuOpen || model.tasks.firstOrNull()?.taskId.isNullOrBlank()) {
        return emptyList()
      }
      val frontTaskId = model.tasks.first().taskId
      return listOf(
        ActionItem(
          label = context.getString(R.string.nanoflow_widget_focus_wait_5m_short),
          selected = false,
          kind = ActionItem.Kind.FOCUS_ACTION,
          focusAction = FOCUS_ACTION_WAIT_PRESET,
          waitMinutes = 5,
          taskId = frontTaskId,
          clickable = true,
        ),
        ActionItem(
          label = context.getString(R.string.nanoflow_widget_focus_wait_15m_short),
          selected = false,
          kind = ActionItem.Kind.FOCUS_ACTION,
          focusAction = FOCUS_ACTION_WAIT_PRESET,
          waitMinutes = 15,
          taskId = frontTaskId,
          clickable = true,
        ),
        ActionItem(
          label = context.getString(R.string.nanoflow_widget_focus_wait_30m_short),
          selected = false,
          kind = ActionItem.Kind.FOCUS_ACTION,
          focusAction = FOCUS_ACTION_WAIT_PRESET,
          waitMinutes = 30,
          taskId = frontTaskId,
          clickable = true,
        ),
        ActionItem(
          label = context.getString(R.string.nanoflow_widget_focus_wait_1h_short),
          selected = false,
          kind = ActionItem.Kind.FOCUS_ACTION,
          focusAction = FOCUS_ACTION_WAIT_PRESET,
          waitMinutes = 60,
          taskId = frontTaskId,
          clickable = true,
        ),
      )
    }

    // LIST_KIND_TABS：蓝图 UI 恒定 4 插槽（主 + 3 副），不足时补占位。
    val result = mutableListOf<ActionItem>()
    // gate 模式下不展示 4 插槽——layout 已隐藏 tab_list，此处返回空避免无谓渲染。
    if (model.isGateMode) return result
    val totalSlots = 4
    for (slotIdx in 0 until totalSlots) {
      val isPrimary = slotIdx == 0
      val taskOrNull = model.tasks.getOrNull(slotIdx)
      val hasTask = taskOrNull != null
      // 海报 UI：标签显示真实任务名（不用「主任务/副任务」role 词），位置编号走徽章展现。
      // 槽位文字区较窄，允许最多 2 行；主槽稍宽，副槽收紧裁切。
      val label: String = when {
        hasTask -> {
          val raw = taskOrNull!!.title.trim()
          val maxChars = if (isPrimary) 9 else 7
          if (raw.length > maxChars) raw.take(maxChars) + "…" else raw
        }
        isPrimary -> context.getString(R.string.nanoflow_widget_focus_slot_main)
        else -> context.getString(R.string.nanoflow_widget_focus_slot_placeholder)
      }
      result += ActionItem(
        label = label,
        selected = false,
        kind = ActionItem.Kind.TAB,
        taskIndex = slotIdx,
        taskId = taskOrNull?.taskId,
        clickable = hasTask && !taskOrNull?.taskId.isNullOrBlank(),
        isMasterTask = taskOrNull?.isMain == true,
        isPlaceholderSlot = !hasTask,
        isWaitExpired = taskOrNull?.waitExpired == true,
      )
    }

    return result
  }

  private fun buildFillInIntent(item: ActionItem): Intent {
    val fill = Intent()
    fill.putExtra(NanoflowWidgetReceiver.EXTRA_APP_WIDGET_ID, appWidgetId)
    val itemType = when (item.kind) {
      ActionItem.Kind.TAB,
      ActionItem.Kind.OVERFLOW -> ITEM_TYPE_TAB
      ActionItem.Kind.REFRESH -> ITEM_TYPE_REFRESH
      ActionItem.Kind.PRIMARY,
      ActionItem.Kind.GATE_CARD -> ITEM_TYPE_PRIMARY
      ActionItem.Kind.GATE_PREV,
      ActionItem.Kind.GATE_NEXT -> ITEM_TYPE_GATE
      ActionItem.Kind.GATE_LABEL -> ITEM_TYPE_NONE
      ActionItem.Kind.GATE_ACTION -> ITEM_TYPE_GATE_ACTION
      ActionItem.Kind.FOCUS_ACTION -> ITEM_TYPE_FOCUS_ACTION
    }
    fill.putExtra(NanoflowWidgetReceiver.EXTRA_ITEM_TYPE, itemType)
    if (item.taskIndex >= 0) fill.putExtra(NanoflowWidgetReceiver.EXTRA_TASK_INDEX, item.taskIndex)
    item.taskId?.let {
      fill.putExtra(NanoflowWidgetReceiver.EXTRA_TASK_ID, it)
    }
    if (item.gateDelta != 0) fill.putExtra(NanoflowWidgetReceiver.EXTRA_GATE_DELTA, item.gateDelta)
    item.gateAction?.let {
      fill.putExtra(EXTRA_GATE_ACTION, it)
    }
    item.gateEntryId?.let {
      fill.putExtra(NanoflowWidgetReceiver.EXTRA_GATE_ENTRY_ID, it)
    }
    item.focusAction?.let {
      fill.putExtra(EXTRA_FOCUS_ACTION, it)
    }
    item.waitMinutes?.let {
      fill.putExtra(EXTRA_WAIT_MINUTES, it)
    }
    item.primaryAction?.let {
      fill.putExtra(EXTRA_PRIMARY_ACTION, it.name)
    }
    return fill
  }

  private fun applyChipStyle(views: RemoteViews, tone: ActionItem.ChipTone) {
    val (bg, fg) = when (tone) {
      ActionItem.ChipTone.ACCENT -> R.drawable.nano_widget_chip_accent to 0xFF08254E.toInt()
      ActionItem.ChipTone.SURFACE -> R.drawable.nano_widget_chip_surface to 0xFFF4F8FF.toInt()
      ActionItem.ChipTone.ACCENT_GATE -> R.drawable.nano_widget_chip_accent_gate to 0xFF08254E.toInt()
      ActionItem.ChipTone.SURFACE_GATE -> R.drawable.nano_widget_chip_surface_gate to 0xFFF4F8FF.toInt()
      ActionItem.ChipTone.TAB_SURFACE -> R.drawable.nano_widget_chip_tab_surface to 0xFFF4F8FF.toInt()
      ActionItem.ChipTone.TAB_SURFACE_GATE -> R.drawable.nano_widget_chip_tab_surface_gate to 0xFFF4F8FF.toInt()
    }
    views.setInt(R.id.nano_widget_action_chip, "setBackgroundResource", bg)
    views.setTextColor(R.id.nano_widget_action_chip, fg)
  }

  private fun dpToPx(dp: Int): Int {
    val density = context.resources.displayMetrics.density
    return (dp * density + 0.5f).toInt()
  }

  companion object {
    const val ITEM_TYPE_TAB = "tab"
    const val ITEM_TYPE_REFRESH = "refresh"
    const val ITEM_TYPE_GATE = "gate"
    const val ITEM_TYPE_PRIMARY = "primary"
    const val ITEM_TYPE_GATE_ACTION = "gate_action"
    const val ITEM_TYPE_FOCUS_ACTION = "focus_action"
    const val ITEM_TYPE_NONE = "none"
    const val EXTRA_PRIMARY_ACTION = "extra.PRIMARY_ACTION"
    const val EXTRA_GATE_ACTION = "extra.GATE_ACTION"
    const val EXTRA_FOCUS_ACTION = "extra.FOCUS_ACTION"
    const val EXTRA_WAIT_MINUTES = "extra.WAIT_MINUTES"
    const val GATE_ACTION_READ = "read"
    const val GATE_ACTION_COMPLETE = "complete"
    const val FOCUS_ACTION_COMPLETE = "complete"
    const val FOCUS_ACTION_WAIT = "wait"
    const val FOCUS_ACTION_WAIT_PRESET = "wait-preset"

    /** 集合视图分流：tabs / content / refresh / gate_actions / focus_actions。 */
    const val LIST_KIND_TABS = "tabs"
    const val LIST_KIND_CONTENT = "content"
    const val LIST_KIND_REFRESH = "refresh"
    const val LIST_KIND_GATE_ACTIONS = "gate_actions"
    const val LIST_KIND_FOCUS_ACTIONS = "focus_actions"
    const val LIST_KIND_FOCUS_WAIT_PRESETS = "focus_wait_presets"
  }
}

internal fun resolveGateActionCodesForModel(model: WidgetRenderModel): List<String> {
  val displayedGateEntryId = model.displayedGateEntryId?.takeIf { it.isNotBlank() }
  if (!model.isGateMode
    || model.contentCards.firstOrNull()?.isGateEmptyState == true
    || displayedGateEntryId == null
    || !model.displayedGateEntryIsActionable
  ) {
    return emptyList()
  }

  return listOf(
    NanoflowWidgetActionFactory.GATE_ACTION_READ,
    NanoflowWidgetActionFactory.GATE_ACTION_COMPLETE,
  )
}
