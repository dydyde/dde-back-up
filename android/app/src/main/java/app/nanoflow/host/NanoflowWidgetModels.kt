package app.nanoflow.host

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.JsonNames

@OptIn(ExperimentalSerializationApi::class)
@Serializable
data class WidgetFocusSummary(
  val active: Boolean = false,
  val taskId: String? = null,
  val projectId: String? = null,
  val projectTitle: String? = null,
  val title: String? = null,
  val remainingMinutes: Int? = null,
  @JsonNames("isMain")
  val isMaster: Boolean? = null,
  val valid: Boolean = false,
)

@Serializable
data class WidgetGatePreview(
  val entryId: String? = null,
  val projectId: String? = null,
  val projectTitle: String? = null,
  val content: String? = null,
  val isRead: Boolean = false,
  val createdAt: String? = null,
  val updatedAt: String? = null,
  val valid: Boolean = false,
)

@OptIn(ExperimentalSerializationApi::class)
@Serializable
data class WidgetDockItem(
  val taskId: String? = null,
  val projectId: String? = null,
  val title: String? = null,
  val projectTitle: String? = null,
  val estimatedMinutes: Int? = null,
  val waitMinutes: Int? = null,
  val waitEndAt: String? = null,
  val waitExpired: Boolean = false,
  @JsonNames("isMain")
  val isMaster: Boolean? = null,
  val valid: Boolean = false,
)

@Serializable
data class WidgetDockSummary(
  val count: Int = 0,
  val countFromTasks: Int = 0,
  val items: List<WidgetDockItem> = emptyList(),
)

@Serializable
data class WidgetCommandCenterSlot(
  val position: Int = 0,
  val taskId: String? = null,
  val projectId: String? = null,
  val title: String? = null,
  val projectTitle: String? = null,
  val estimatedMinutes: Int? = null,
  val waitMinutes: Int? = null,
  val waitStartedAt: String? = null,
  val waitEndAt: String? = null,
  val waitExpired: Boolean = false,
  val focusStatus: String? = null,
  val isMain: Boolean = false,
  val isFocused: Boolean = false,
  val valid: Boolean = false,
)

@Serializable
data class WidgetCommandCenterSummary(
  val slots: List<WidgetCommandCenterSlot> = emptyList(),
  val mainTaskId: String? = null,
  val focusedTaskId: String? = null,
  val backupCount: Int = 0,
)

@OptIn(ExperimentalSerializationApi::class)
@Serializable
data class WidgetBlackBoxSummary(
  @SerialName("pendingCount")
  val pendingCount: Int = 0,
  val unreadCount: Int? = null,
  val nextReviewAt: String? = null,
  @JsonNames("previews", "entries", "items")
  val previews: List<WidgetGatePreview> = emptyList(),
  val gatePreview: WidgetGatePreview = WidgetGatePreview(),
)

@Serializable
data class WidgetSummaryResponse(
  val schemaVersion: Int = 1,
  val summaryVersion: String? = null,
  val cloudUpdatedAt: String? = null,
  val freshnessState: String = "stale",
  val trustState: String = "untrusted",
  val sourceState: String = "cache-only",
  val consistencyState: String? = null,
  val degradedReasons: List<String> = emptyList(),
  val warnings: List<String> = emptyList(),
  val entryUrl: String = "",
  val focus: WidgetFocusSummary = WidgetFocusSummary(),
  val dock: WidgetDockSummary = WidgetDockSummary(),
  val commandCenter: WidgetCommandCenterSummary = WidgetCommandCenterSummary(),
  val blackBox: WidgetBlackBoxSummary = WidgetBlackBoxSummary(),
  val code: String? = null,
  val error: String? = null,
  val retryAfterSeconds: Int? = null,
)

@Serializable
data class WidgetSummaryRequestPayload(
  val clientSchemaVersion: Int,
  val platform: String,
  val supportsPush: Boolean,
  val clientVersion: String? = null,
  val lastKnownSummaryVersion: String? = null,
  val instanceId: String,
  val hostInstanceId: String,
)

@Serializable
data class WidgetFocusPromoteRequestPayload(
  val action: String,
  val taskId: String? = null,
  val waitMinutes: Int? = null,
)

@Serializable
data class WidgetBlackBoxActionRequestPayload(
  val entryId: String,
  val action: String,
)

data class WidgetDeviceIdentity(
  val installationId: String,
  val deviceId: String,
  val deviceSecret: String,
)

data class StoredWidgetBinding(
  val widgetToken: String,
  val deviceId: String,
  val bindingGeneration: Int,
  val expiresAt: String,
)

data class PendingBootstrapState(
  val nonce: String,
  val issuedAtMs: Long,
  val requestedPushToken: String?,
)

enum class WidgetPrimaryAction {
  OPEN_WORKSPACE,
  OPEN_FOCUS_TOOLS,
  BLOCK_GATE_ACTIONS,
}

enum class WidgetVisualTone {
  SETUP,
  AUTH,
  UNTRUSTED,
  GATE,
  FOCUS,
}

/**
 * 小组件尺寸档位（基于 hostsystem 上报的 min size 推断）。
 * - SMALL  : 约 2x2，仅展示模式 + 标题 + 一行状态 + 主操作
 * - MEDIUM : 约 4x2，展示可纵向滑动的中心内容区 + 右下角刷新
 * - LARGE  : 约 4x3+，展示更高的纵向内容区 + 右下角刷新
 */
enum class WidgetSizeTier {
  SMALL,
  MEDIUM,
  LARGE,
}

data class WidgetRenderModel(
  val modeLabel: String,
  val statusBadge: String?,
  val title: String,
  val supportingLine: String?,
  val metricsLine: String?,
  val statusLine: String,
  val primaryActionLabel: String,
  val primaryAction: WidgetPrimaryAction,
  val tone: WidgetVisualTone,
  val dockCount: Int,
  val blackBoxCount: Int,
  val showStatCards: Boolean,
  val isGateMode: Boolean,
  val showGatePager: Boolean,
  val gatePageIndicator: String?,
  val canPageBackward: Boolean,
  val canPageForward: Boolean,
  val compact: Boolean,
  val sizeTier: WidgetSizeTier,
  val showSetup: Boolean,
  val showAuthRequired: Boolean,
  val showUntrusted: Boolean,
  /** 当前渲染到大门主卡上的条目 ID；null 表示当前没有可直接执行已读/完成的具体条目。 */
  val displayedGateEntryId: String? = null,
  /** 当前展示条目的已读状态；只影响卡片元信息，底部仍稳定保留“已读 / 完成”双按钮。 */
  val displayedGateEntryIsRead: Boolean = false,
  /** 当前展示条目是否仍可直接执行 gate action；非隐私 fallback 只作提示，不展示按钮。 */
  val displayedGateEntryIsActionable: Boolean = false,
  /** C 位 1-4 的可见任务映射；主/副属性由 isMain 独立表达，不随位置前置而改变。 */
  val tasks: List<WidgetTaskCard> = emptyList(),
  /** 当前前台 C 位下标；专注模式下始终锚定 0，仅为兼容旧渲染接口保留。 */
  val selectedTaskIndex: Int = 0,
  /** 中间内容区的纵向卡片列表；用户通过上下滑动浏览。 */
  val contentCards: List<WidgetContentCard> = emptyList(),
  /** 紧凑同步徽章文案（如「刚刚」/「3 分前」）；null 表示不展示。 */
  val syncBadgeLabel: String? = null,
  /** 专注模式底部等待预设是否展开。 */
  val focusWaitMenuOpen: Boolean = false,
)

data class WidgetContentCard(
  val eyebrow: String? = null,
  val title: String,
  val subtitle: String? = null,
  val metaStart: String? = null,
  val metaEnd: String? = null,
  val interactionHint: String? = null,
  /** 标记此卡片为大门空状态（E 图）——Factory 应切换为 🚪 图标并隐藏 创建/已读 元信息。 */
  val isGateEmptyState: Boolean = false,
)

/**
 * 单条停泊任务在小组件 UI 中的展示形态。
 * 第一张卡对应当前 C 位 #1；它可以是副任务，主任务用 isMain 保持王冠语义。
 */
data class WidgetTaskCard(
  val taskId: String?,
  val title: String,
  val projectTitle: String?,
  val estimatedMinutes: Int? = null,
  val waitMinutes: Int? = null,
  val waitEndAt: String? = null,
  val waitExpired: Boolean = false,
  val isMain: Boolean,
  val valid: Boolean = true,
)
