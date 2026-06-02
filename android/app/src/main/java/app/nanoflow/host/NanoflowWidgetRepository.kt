package app.nanoflow.host

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.net.Uri
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

data class WidgetBlackBoxOptimisticSnapshot(
  val summary: WidgetSummaryResponse,
  val selectedEntryId: String?,
)

data class WidgetBlackBoxOptimisticPatch(
  val blackBox: WidgetBlackBoxSummary,
  val nextSelectedEntryId: String?,
)

data class WidgetFocusOptimisticSnapshot(
  val summary: WidgetSummaryResponse,
  val selectedTaskIndex: Int,
  val focusWaitMenuOpen: Boolean = false,
)

private const val FOCUS_HINT_GRACE_MS = 30_000L
private const val FOCUS_MUTATION_GRACE_MS = 30_000L
private const val FOCUS_MUTATION_COMPLETE = "complete-front"
private const val FOCUS_MUTATION_WAIT = "wait-front"
private const val GATE_READ_REAPPEAR_COOLDOWN_MS = 30 * 60 * 1000L

internal fun hasActionableOptimisticGateEntry(
  blackBox: WidgetBlackBoxSummary,
  privacyMode: Boolean,
  now: Instant = Instant.now(),
): Boolean {
  if (blackBox.pendingCount <= 0) {
    return true
  }

  return resolveRenderableGateEntriesForBlackBox(blackBox, privacyMode, now)
    .firstOrNull { preview -> isActionableOptimisticGatePreview(preview, privacyMode) } != null
}

private fun isActionableOptimisticGatePreview(
  preview: WidgetGatePreview,
  privacyMode: Boolean,
): Boolean {
  if (preview.entryId.isNullOrBlank()) {
    return false
  }

  return privacyMode || !preview.content.isNullOrBlank()
}

internal fun resolveRenderableGateEntriesForBlackBox(
  blackBox: WidgetBlackBoxSummary,
  privacyMode: Boolean,
  now: Instant = Instant.now(),
): List<WidgetGatePreview> {
  val entries = mutableListOf<WidgetGatePreview>()
  val fallbackEntries = mutableListOf<WidgetGatePreview>()

  fun appendIfRenderable(preview: WidgetGatePreview) {
    if (!preview.valid) {
      return
    }

    val hiddenByCooldown = isGateReadCoolingDownForBlackBox(preview, now)
    val hiddenByMissingContent = !privacyMode && preview.content.isNullOrBlank()
    val renderableIndex = entries.indexOfFirst { existing -> areSameGatePreview(existing, preview) }
    if (renderableIndex >= 0) {
      if (!hiddenByCooldown && !hiddenByMissingContent) {
        entries[renderableIndex] = preferRicherGatePreviewForBlackBox(entries[renderableIndex], preview)
      }
      return
    }

    val fallbackIndex = fallbackEntries.indexOfFirst { existing -> areSameGatePreview(existing, preview) }

    if (hiddenByCooldown || hiddenByMissingContent) {
      if (fallbackIndex >= 0) {
        fallbackEntries[fallbackIndex] = preferRicherGatePreviewForBlackBox(fallbackEntries[fallbackIndex], preview)
      } else {
        fallbackEntries.add(preview)
      }
      return
    }

    if (fallbackIndex >= 0) {
      fallbackEntries.removeAt(fallbackIndex)
    }
    entries.add(preview)
  }

  blackBox.previews.forEach(::appendIfRenderable)
  appendIfRenderable(blackBox.gatePreview)

  if (entries.isNotEmpty() || blackBox.pendingCount <= 0) {
    return entries
  }

  val fallbackPreview = fallbackEntries.firstOrNull { !it.entryId.isNullOrBlank() }
    ?: fallbackEntries.firstOrNull()
  return fallbackPreview?.let(::listOf) ?: emptyList()
}

private fun preferRicherGatePreviewForBlackBox(
  current: WidgetGatePreview,
  candidate: WidgetGatePreview,
): WidgetGatePreview {
  return if (gatePreviewRichnessForBlackBox(candidate) >= gatePreviewRichnessForBlackBox(current)) {
    candidate
  } else {
    current
  }
}

private fun gatePreviewRichnessForBlackBox(preview: WidgetGatePreview): Int {
  var score = 0
  if (!preview.entryId.isNullOrBlank()) score += 8
  if (!preview.content.isNullOrBlank()) score += 4
  if (!preview.createdAt.isNullOrBlank()) score += 2
  if (!preview.projectTitle.isNullOrBlank()) score += 1
  return score
}

private fun isGateReadCoolingDownForBlackBox(
  preview: WidgetGatePreview,
  now: Instant,
): Boolean {
  if (!preview.isRead) {
    return false
  }

  val updatedAt = runCatching {
    Instant.parse(preview.updatedAt?.takeIf { it.isNotBlank() } ?: preview.createdAt ?: "")
  }.getOrNull()
  if (updatedAt == null) return false
  val elapsedMs = Duration.between(updatedAt, now).toMillis().coerceAtLeast(0)
  return elapsedMs < GATE_READ_REAPPEAR_COOLDOWN_MS
}

internal fun buildOptimisticBlackBoxActionPatch(
  blackBox: WidgetBlackBoxSummary,
  entryId: String,
  action: BlackBoxEntryAction,
  gateEntries: List<WidgetGatePreview>,
  selectedGateIndex: Int,
  previousSelectedEntryId: String?,
  now: Instant = Instant.now(),
): WidgetBlackBoxOptimisticPatch? {
  val targetPreview = blackBox.previews.firstOrNull { it.entryId == entryId }
    ?: blackBox.gatePreview.takeIf { it.entryId == entryId && it.valid }
    ?: return null
  val unreadDelta = if (!targetPreview.isRead) 1 else 0
  val newPendingCount = when (action) {
    BlackBoxEntryAction.READ -> (blackBox.pendingCount - 1).coerceAtLeast(0)
    BlackBoxEntryAction.COMPLETE -> (blackBox.pendingCount - 1).coerceAtLeast(0)
  }
  val newPreviews = when (action) {
    BlackBoxEntryAction.READ -> blackBox.previews.filterNot { it.entryId == entryId }
    BlackBoxEntryAction.COMPLETE -> blackBox.previews.filterNot { it.entryId == entryId }
  }
  val candidateEntries = rotateGateEntriesAfterForBlackBox(gateEntries, selectedGateIndex)
    .filterNot { it.entryId == entryId }
  val nextSelectedEntryId = when (action) {
    BlackBoxEntryAction.READ -> resolveNextGateEntryIdForBlackBox(candidateEntries, now)
    BlackBoxEntryAction.COMPLETE -> candidateEntries.firstOrNull()?.entryId
  }
  val nextPreview = when {
    nextSelectedEntryId.isNullOrBlank() -> null
    else -> newPreviews.firstOrNull { it.entryId == nextSelectedEntryId }
      ?: candidateEntries.firstOrNull { it.entryId == nextSelectedEntryId }
  }
  val newGatePreview = when (action) {
    BlackBoxEntryAction.READ -> when {
      blackBox.gatePreview.entryId == entryId -> nextPreview ?: WidgetGatePreview()
      previousSelectedEntryId == entryId -> nextPreview ?: WidgetGatePreview()
      else -> blackBox.gatePreview
    }
    BlackBoxEntryAction.COMPLETE -> {
      if (blackBox.gatePreview.entryId == entryId || previousSelectedEntryId == entryId) {
        nextPreview ?: WidgetGatePreview()
      } else {
        blackBox.gatePreview
      }
    }
  }
  val newUnreadCount = (resolveBlackBoxUnreadCountForPatch(blackBox) - unreadDelta)
    .coerceAtLeast(0)
    .coerceAtMost(newPendingCount)
  return WidgetBlackBoxOptimisticPatch(
    blackBox = blackBox.copy(
      pendingCount = newPendingCount,
      unreadCount = newUnreadCount,
      previews = newPreviews,
      gatePreview = newGatePreview,
    ),
    nextSelectedEntryId = nextSelectedEntryId,
  )
}

private fun rotateGateEntriesAfterForBlackBox(
  entries: List<WidgetGatePreview>,
  selectedGateIndex: Int,
): List<WidgetGatePreview> {
  if (entries.isEmpty()) return emptyList()
  val safeIndex = selectedGateIndex.coerceIn(0, entries.lastIndex)
  return entries.drop(safeIndex + 1) + entries.take(safeIndex + 1)
}

private fun resolveNextGateEntryIdForBlackBox(
  candidateEntries: List<WidgetGatePreview>,
  now: Instant,
): String? {
  return candidateEntries.firstOrNull { !isGateReadCoolingDownForBlackBox(it, now) }?.entryId
}

private fun resolveBlackBoxUnreadCountForPatch(blackBox: WidgetBlackBoxSummary): Int {
  val pendingCount = blackBox.pendingCount.coerceAtLeast(0)
  val explicitUnreadCount = blackBox.unreadCount
  if (explicitUnreadCount != null) {
    return explicitUnreadCount.coerceIn(0, pendingCount)
  }

  val previewUnreadCount = blackBox.previews.count { !it.isRead }
  return previewUnreadCount.coerceAtMost(pendingCount)
}

private fun areSameGatePreview(left: WidgetGatePreview, right: WidgetGatePreview): Boolean {
  val leftEntryId = left.entryId?.takeIf { it.isNotBlank() }
  val rightEntryId = right.entryId?.takeIf { it.isNotBlank() }
  if (leftEntryId != null && rightEntryId != null) {
    return leftEntryId == rightEntryId
  }

  return left.content == right.content
    && left.createdAt == right.createdAt
    && left.projectId == right.projectId
}

private data class VisibleCommandCenterTask(
  val position: Int,
  val taskId: String?,
  val projectId: String?,
  val title: String?,
  val projectTitle: String?,
  val estimatedMinutes: Int?,
  val waitMinutes: Int?,
  val waitEndAt: String?,
  val waitExpired: Boolean,
  val isMain: Boolean,
  val valid: Boolean,
)

class NanoflowWidgetRepository(private val context: Context) {
  private val clockFormatter = DateTimeFormatter.ofPattern("HH:mm")
  private val shortDateFormatter = DateTimeFormatter.ofPattern("MM-dd")
  private val bootstrapTtlMs = 15 * 60 * 1000L
  private val registeredPushTokenRepairIntervalMs = 24 * 60 * 60 * 1000L
  private val pushTokenRepairDegradedReason = "push-token-missing"
  private val bindingResetCodes = setOf(
    "WIDGET_TOKEN_REQUIRED",
    "DEVICE_NOT_FOUND",
    "DEVICE_REVOKED",
    "BINDING_MISMATCH",
    "TOKEN_EXPIRED",
    "TOKEN_INVALID",
  )
  private val bootstrapRequiredCodes = bindingResetCodes + setOf(
    "WIDGET_BOOTSTRAP_REQUIRED",
    "INSTANCE_CONTEXT_REQUIRED",
    "INSTANCE_CONTEXT_INVALID",
    "INSTANCE_NOT_ACTIVE",
    "INSTANCE_BINDING_MISMATCH",
  )
  private val transientContextPreservingCodes = setOf(
    "RATE_LIMITED",
    "WIDGET_REFRESH_DISABLED",
  )
  private val widgetContextResetCodes = setOf(
    "INSTANCE_CONTEXT_INVALID",
    "INSTANCE_NOT_ACTIVE",
    "INSTANCE_BINDING_MISMATCH",
  )
  private val json = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
  }
  private val store = NanoflowWidgetStore(context)

  suspend fun buildLaunchUri(
    appWidgetId: Int,
    preferredEntrySource: NanoFlowEntrySource,
    launchIntent: NanoFlowLaunchIntent,
    requestedTaskIndex: Int = -1,
    gateEntryId: String? = null,
  ): Uri {
    val bridgeContext = if (shouldBootstrap(appWidgetId)) {
      buildBridgeContext(appWidgetId)
    } else {
      null
    }
    val entrySource = if (bridgeContext != null) NanoFlowEntrySource.TWA else preferredEntrySource
    val summary = store.readSummary(appWidgetId)
    val contextualEntryUrl = resolveSelectedTaskEntryUrl(summary, requestedTaskIndex)
      ?: summary?.entryUrl
    val contextualLaunchUri = resolveSummaryLaunchUri(contextualEntryUrl)

    if (bridgeContext == null && launchIntent == NanoFlowLaunchIntent.OPEN_WORKSPACE && contextualLaunchUri != null) {
      return contextualLaunchUri
    }

    if (bridgeContext != null) {
      NanoflowWidgetTelemetry.info(
        "widget_bootstrap_launch_ready",
        mapOf(
          "appWidgetId" to appWidgetId,
          "entrySource" to entrySource.queryValue,
          "launchIntent" to launchIntent.queryValue,
          "instanceId" to NanoflowWidgetTelemetry.redactId(bridgeContext.instanceId),
          "pendingPushToken" to !bridgeContext.pendingPushToken.isNullOrBlank(),
          "sizeBucket" to bridgeContext.sizeBucket,
        ),
      )
    }

    return NanoflowBootstrapContract.buildLaunchUri(
      entrySource = entrySource,
      launchIntent = launchIntent,
      bridgeContext = bridgeContext,
      routeUrl = contextualEntryUrl.takeIf { contextualLaunchUri != null },
      gateEntryId = gateEntryId,
    )
  }

  suspend fun buildBridgeContext(appWidgetId: Int): WidgetBridgeContext {
    val identity = store.ensureDeviceIdentity()
    val instanceId = store.ensureInstanceId(appWidgetId)
    val existingPendingBootstrap = store.readPendingBootstrap(appWidgetId)
    val pendingPushToken = store.readPendingPushToken()
    val bootstrapNonce = if (
      existingPendingBootstrap != null
      && System.currentTimeMillis() - existingPendingBootstrap.issuedAtMs <= bootstrapTtlMs
      && existingPendingBootstrap.requestedPushToken == pendingPushToken
    ) {
      NanoflowWidgetTelemetry.info(
        "widget_bootstrap_nonce_reused",
        mapOf(
          "appWidgetId" to appWidgetId,
          "instanceId" to NanoflowWidgetTelemetry.redactId(instanceId),
        ),
      )
      existingPendingBootstrap.nonce
    } else {
      store.issueBootstrapNonce(appWidgetId, pendingPushToken)
    }
    val sizeBucket = store.readSizeBucket(appWidgetId) ?: resolveSizeBucket(appWidgetId)
    if (existingPendingBootstrap == null || bootstrapNonce != existingPendingBootstrap.nonce) {
      NanoflowWidgetTelemetry.info(
        "widget_bootstrap_nonce_issued",
        mapOf(
          "appWidgetId" to appWidgetId,
          "instanceId" to NanoflowWidgetTelemetry.redactId(instanceId),
          "installationId" to NanoflowWidgetTelemetry.redactId(identity.installationId),
          "pendingPushToken" to !pendingPushToken.isNullOrBlank(),
          "sizeBucket" to sizeBucket,
        ),
      )
    }
    return WidgetBridgeContext(
      installationId = identity.installationId,
      deviceId = identity.deviceId,
      deviceSecret = identity.deviceSecret,
      clientVersion = BuildConfig.NANOFLOW_WIDGET_CLIENT_VERSION,
      instanceId = instanceId,
      hostInstanceId = appWidgetId.toString(),
      bootstrapNonce = bootstrapNonce,
      sizeBucket = sizeBucket,
      pendingPushToken = pendingPushToken,
    )
  }

  suspend fun resolveDisplayedGateEntries(
    appWidgetId: Int,
    summary: WidgetSummaryResponse,
  ): List<WidgetGatePreview> {
    val privacyMode = store.isPrivacyModeEnabled()
    return resolveDisplayedGateEntries(appWidgetId, summary, privacyMode)
  }

  suspend fun consumeBootstrapUri(uri: Uri?): Boolean {
    val payload = NanoflowBootstrapContract.parseBootstrapPayload(uri)
    if (payload == null) {
      NanoflowWidgetTelemetry.warn(
        "widget_bootstrap_callback_rejected",
        mapOf("reason" to "invalid-payload"),
      )
      return false
    }

    val hostWidgetId = payload.hostInstanceId.toIntOrNull()
    if (hostWidgetId == null) {
      NanoflowWidgetTelemetry.warn(
        "widget_bootstrap_callback_rejected",
        mapOf(
          "reason" to "invalid-host-instance-id",
          "hostInstanceId" to payload.hostInstanceId,
        ),
      )
      return false
    }

    NanoflowWidgetTelemetry.info(
      "widget_bootstrap_callback_received",
      mapOf(
        "appWidgetId" to hostWidgetId,
        "bindingGeneration" to payload.bindingGeneration,
        "instanceId" to NanoflowWidgetTelemetry.redactId(payload.instanceId),
        "installationId" to NanoflowWidgetTelemetry.redactId(payload.installationId),
      ),
    )

    if (!NanoflowWidgetReceiver.hasInstalledWidgets(context, hostWidgetId)) {
      store.clearPendingBootstrap(hostWidgetId)
      NanoflowWidgetTelemetry.warn(
        "widget_bootstrap_callback_rejected",
        mapOf(
          "appWidgetId" to hostWidgetId,
          "reason" to "widget-not-installed",
        ),
      )
      return false
    }

    val pendingBootstrap = store.readPendingBootstrap(hostWidgetId)
    if (pendingBootstrap == null) {
      NanoflowWidgetTelemetry.warn(
        "widget_bootstrap_callback_rejected",
        mapOf(
          "appWidgetId" to hostWidgetId,
          "reason" to "pending-bootstrap-missing",
        ),
      )
      return false
    }

    if (System.currentTimeMillis() - pendingBootstrap.issuedAtMs > bootstrapTtlMs) {
      store.clearPendingBootstrap(hostWidgetId)
      NanoflowWidgetTelemetry.warn(
        "widget_bootstrap_callback_rejected",
        mapOf(
          "appWidgetId" to hostWidgetId,
          "reason" to "pending-bootstrap-expired",
        ),
      )
      return false
    }

    val identity = store.ensureDeviceIdentity()
    if (payload.installationId != identity.installationId) {
      NanoflowWidgetTelemetry.warn(
        "widget_bootstrap_callback_rejected",
        mapOf(
          "appWidgetId" to hostWidgetId,
          "reason" to "installation-mismatch",
        ),
      )
      return false
    }
    if (payload.deviceId != identity.deviceId) {
      NanoflowWidgetTelemetry.warn(
        "widget_bootstrap_callback_rejected",
        mapOf(
          "appWidgetId" to hostWidgetId,
          "reason" to "device-mismatch",
        ),
      )
      return false
    }
    if (payload.bootstrapNonce != pendingBootstrap.nonce) {
      NanoflowWidgetTelemetry.warn(
        "widget_bootstrap_callback_rejected",
        mapOf(
          "appWidgetId" to hostWidgetId,
          "reason" to "nonce-mismatch",
        ),
      )
      return false
    }

    val localInstanceId = store.readInstanceId(hostWidgetId)
    if (localInstanceId == null) {
      NanoflowWidgetTelemetry.warn(
        "widget_bootstrap_callback_rejected",
        mapOf(
          "appWidgetId" to hostWidgetId,
          "reason" to "instance-missing",
        ),
      )
      return false
    }
    if (payload.instanceId != localInstanceId) {
      NanoflowWidgetTelemetry.warn(
        "widget_bootstrap_callback_rejected",
        mapOf(
          "appWidgetId" to hostWidgetId,
          "reason" to "instance-mismatch",
          "instanceId" to NanoflowWidgetTelemetry.redactId(localInstanceId),
        ),
      )
      return false
    }

    store.applyBootstrapPayload(payload, pendingBootstrap.requestedPushToken)
    store.clearPendingBootstrap(hostWidgetId)
    NanoflowWidgetTelemetry.info(
      "widget_bootstrap_callback_accepted",
      mapOf(
        "appWidgetId" to hostWidgetId,
        "bindingGeneration" to payload.bindingGeneration,
        "expiresAt" to payload.expiresAt,
        "instanceId" to NanoflowWidgetTelemetry.redactId(localInstanceId),
      ),
    )
    return true
  }

  suspend fun rememberPushToken(pushToken: String) {
    val normalizedPushToken = pushToken.trim()
    if (normalizedPushToken.isBlank()) return
    if (store.readPendingPushToken()?.trim() == normalizedPushToken) {
      return
    }
    val registeredPushToken = store.readRegisteredPushToken()?.trim()
    val registeredPushTokenAckAtMs = store.readRegisteredPushTokenAckAtMs()
    val isRecentlyAcknowledged = registeredPushToken == normalizedPushToken
      && registeredPushTokenAckAtMs != null
      && System.currentTimeMillis() - registeredPushTokenAckAtMs < registeredPushTokenRepairIntervalMs
    if (isRecentlyAcknowledged) {
      return
    }

    store.persistPendingPushToken(normalizedPushToken)
  }

  private suspend fun repairMissingPushTokenState(
    appWidgetId: Int,
    summary: WidgetSummaryResponse,
  ) {
    if (!summary.degradedReasons.contains(pushTokenRepairDegradedReason)) {
      return
    }

    store.clearRegisteredPushTokenState()
    if (!BuildConfig.NANOFLOW_FCM_ENABLED) {
      NanoflowWidgetTelemetry.warn(
        "widget_push_token_repair_skipped",
        mapOf(
          "appWidgetId" to appWidgetId,
          "reason" to "fcm-disabled",
        ),
      )
      return
    }

    if (!store.readPendingPushToken().isNullOrBlank()) {
      NanoflowWidgetTelemetry.info(
        "widget_push_token_repair_already_pending",
        mapOf("appWidgetId" to appWidgetId),
      )
      return
    }

    NanoflowWidgetTelemetry.warn(
      "widget_push_token_repair_skipped",
      mapOf(
        "appWidgetId" to appWidgetId,
        "reason" to "token-fetch-deferred",
      ),
    )
  }

  suspend fun refreshInstalledWidgets() {
    val appWidgetManager = AppWidgetManager.getInstance(context)
    val componentName = ComponentName(context, NanoflowWidgetReceiver::class.java)
    val appWidgetIds = appWidgetManager.getAppWidgetIds(componentName)

    for (appWidgetId in appWidgetIds) {
      refreshSummary(appWidgetId)
    }
  }

  /**
   * 2026-04-22 颠覆性压缩：根据 FCM data payload 携带的 focusActiveHint 对每个已安装的
   * appWidget 的缓存 summary 做乐观内联。返回被改动过的 appWidgetId 列表，以便上层立即触发渲染
   * （而无需等 widget-summary 边缘函数回环，节省 ~5s）。
   *
   * 设计口径：
   * - 只修改 focus.active + focus.valid 两个字段，其它 focus slot 元数据（title / projectId 等）
   *   保持原值——因为 hint 只能告诉你「是否专注」，而不能告诉你「专注的是哪个任务」。
   * - valid 的计算依赖于原来 title/taskId 是否存在；这里保守地复用旧 valid。
   * - 若缓存中 focus.active 已经等于 hint，跳过以免写无用缓存引发 UI 闪烁。
   * - 后续的 refreshSummary 会在短暂 grace 窗口内保留该 hint，避免旧 summary 把 UI 打回去。
   */
  suspend fun applyFocusActiveHint(hintActive: Boolean): List<Int> {
    val appWidgetManager = AppWidgetManager.getInstance(context)
    val componentName = ComponentName(context, NanoflowWidgetReceiver::class.java)
    val appWidgetIds = appWidgetManager.getAppWidgetIds(componentName)
    val changed = mutableListOf<Int>()
    val desiredValid = hintActive
    for (appWidgetId in appWidgetIds) {
      store.persistPendingFocusActiveHint(appWidgetId, hintActive)
      val cached = store.readSummary(appWidgetId) ?: continue
      if (cached.focus.active == hintActive && cached.focus.valid == desiredValid) {
        continue
      }
      // hint 口径下 valid 直接跟随 hint：
      // - hint=true 时即便旧缓存没有可用 focus slot，也要先切到专注模式骨架；
      // - hint=false 时立即撤回到 Gate 视图。
      val patched = cached.copy(
        focus = cached.focus.copy(
          active = hintActive,
          valid = desiredValid,
        ),
      )
      store.saveSummary(appWidgetId, patched)
      changed += appWidgetId
    }
    if (changed.isNotEmpty()) {
      NanoflowWidgetTelemetry.info(
        "widget_focus_hint_applied",
        mapOf(
          "hintActive" to hintActive,
          "appWidgetIds" to changed.joinToString(","),
        ),
      )
    }
    return changed
  }

  /**
   * 大门 1-tap 已读 / 完成：直接调用 widget-black-box-action 边缘函数把 black_box_entries
   * 对应行的 is_read / is_completed 置为 true，而不启动 TWA。
   * `read` 只启动 30 分钟缄默，不代表完成；冷却到期后未完成条目会再次出现。
   *
   * 返回值 == true 表示服务端成功 PATCH；本地乐观缓存由调用方在提交前处理。
   *
   * 设计口径：
   * - 本方法只负责远端提交；调用方负责在提交前先做本地乐观补丁并立即重绘。
   * - 不触发 refreshSummary：让调用方决定（避免一次点击触发两轮 HTTP 放大服务端压力）。
   */
  suspend fun applyOptimisticBlackBoxAction(
    appWidgetId: Int,
    entryId: String,
    action: BlackBoxEntryAction,
  ): WidgetBlackBoxOptimisticSnapshot? {
    val cached = store.readSummary(appWidgetId) ?: return null
    val privacyMode = store.isPrivacyModeEnabled()
    val gateEntries = resolveRenderableGateEntries(cached, privacyMode)
    val selectedGateIndex = if (gateEntries.isEmpty()) {
      0
    } else {
      resolveGatePageIndex(appWidgetId, gateEntries)
    }
    val previousSelectedEntryId = store.readGateSelectedEntryId(appWidgetId)
    val optimisticPatch = buildOptimisticBlackBoxActionPatch(
      blackBox = cached.blackBox,
      entryId = entryId,
      action = action,
      gateEntries = gateEntries,
      selectedGateIndex = selectedGateIndex,
      previousSelectedEntryId = previousSelectedEntryId,
    ) ?: return null
    val patchedBlackBox = optimisticPatch.blackBox
    // 完成动作没有下一条可执行条目时保留旧卡片等权威刷新；已读动作则必须本地移走当前条目，
    // 让 repeated read 重新进入 30 分钟冷却时也有即时反馈。
    if (action != BlackBoxEntryAction.READ && !hasActionableOptimisticGateEntry(patchedBlackBox, privacyMode)) {
      NanoflowWidgetTelemetry.info(
        "widget_black_box_action_optimistic_skipped_unrenderable_gate",
        mapOf(
          "appWidgetId" to appWidgetId,
          "entryId" to NanoflowWidgetTelemetry.redactId(entryId),
          "action" to action.wireValue,
          "pendingCount" to patchedBlackBox.pendingCount,
        ),
      )
      return null
    }
    val patched = cached.copy(
      blackBox = patchedBlackBox,
    )
    store.saveSummary(appWidgetId, patched)
    if (previousSelectedEntryId == entryId || previousSelectedEntryId.isNullOrBlank() || cached.blackBox.gatePreview.entryId == entryId) {
      store.persistGateSelectedEntryId(appWidgetId, optimisticPatch.nextSelectedEntryId)
    }

    NanoflowWidgetTelemetry.info(
      "widget_black_box_action_optimistic_applied",
      mapOf(
        "appWidgetId" to appWidgetId,
        "entryId" to NanoflowWidgetTelemetry.redactId(entryId),
        "action" to action.wireValue,
        "pendingCount" to patched.blackBox.pendingCount,
        "unreadCount" to resolveBlackBoxUnreadCount(patched),
      ),
    )

    return WidgetBlackBoxOptimisticSnapshot(
      summary = cached,
      selectedEntryId = previousSelectedEntryId,
    )
  }

  suspend fun rollbackOptimisticBlackBoxAction(
    appWidgetId: Int,
    snapshot: WidgetBlackBoxOptimisticSnapshot,
  ) {
    store.saveSummary(appWidgetId, snapshot.summary)
    store.persistGateSelectedEntryId(appWidgetId, snapshot.selectedEntryId)
  }

  /**
   * Focus C 位点击：本地先把目标槽位提到 #1，同时保留主/副任务属性，
   * 让桌面小组件立即反馈；随后 widget-focus-action 会改写云端快照作为权威状态。
   */
  suspend fun applyOptimisticFocusPromotion(
    appWidgetId: Int,
    taskId: String,
  ): WidgetFocusOptimisticSnapshot? {
    val cached = store.readSummary(appWidgetId) ?: return null
    if (cached.focus.active != true || !cached.focus.valid) return null
    val visibleTasks = resolveVisibleCommandCenterTasks(cached)
    if (visibleTasks.firstOrNull()?.taskId == taskId) return null

    val target = visibleTasks.firstOrNull { it.taskId == taskId } ?: return null
    if (!target.valid) return null
    val reorderedTasks = buildList {
      add(target)
      addAll(visibleTasks.filterNot { it.taskId == taskId })
    }
    val previousSelectedTaskIndex = store.readSelectedTaskIndex(appWidgetId)
    val patched = patchSummaryWithVisibleCommandTasks(cached, reorderedTasks)
    store.saveSummary(appWidgetId, patched)
    store.persistSelectedTaskIndex(appWidgetId, 0)

    NanoflowWidgetTelemetry.info(
      "widget_focus_promote_optimistic_applied",
      mapOf(
        "appWidgetId" to appWidgetId,
        "taskId" to NanoflowWidgetTelemetry.redactId(taskId),
        "dockItemCount" to reorderedTasks.drop(1).size,
      ),
    )

    return WidgetFocusOptimisticSnapshot(
      summary = cached,
      selectedTaskIndex = previousSelectedTaskIndex,
    )
  }

  suspend fun isVisibleCommandCenterTaskPromotable(appWidgetId: Int, taskId: String): Boolean {
    val cached = store.readSummary(appWidgetId) ?: return false
    return resolveVisibleCommandCenterTasks(cached).any { visibleTask ->
      visibleTask.taskId == taskId && visibleTask.valid
    }
  }

  suspend fun applyOptimisticFocusCompletion(
    appWidgetId: Int,
    taskId: String,
  ): WidgetFocusOptimisticSnapshot? {
    val cached = store.readSummary(appWidgetId) ?: return null
    if (cached.focus.active != true || !cached.focus.valid) return null
    val visibleTasks = resolveVisibleCommandCenterTasks(cached)
    val target = visibleTasks.firstOrNull() ?: return null
    if (target.taskId != taskId || !target.valid) return null

    val remainingTasks = visibleTasks.drop(1).mapIndexed { index, task ->
      if (target.isMain && visibleTasks.drop(1).none { it.isMain } && index == 0) {
        task.copy(isMain = true)
      } else {
        task
      }
    }
    val previousSelectedTaskIndex = store.readSelectedTaskIndex(appWidgetId)
    val previousWaitMenuOpen = store.readFocusWaitMenuOpen(appWidgetId)
    val patched = patchSummaryWithVisibleCommandTasks(cached, remainingTasks)
    store.saveSummary(appWidgetId, patched)
    store.persistSelectedTaskIndex(appWidgetId, 0)
    store.persistFocusWaitMenuOpen(appWidgetId, false)
    store.persistPendingFocusMutation(appWidgetId, FOCUS_MUTATION_COMPLETE)

    NanoflowWidgetTelemetry.info(
      "widget_focus_complete_optimistic_applied",
      mapOf(
        "appWidgetId" to appWidgetId,
        "taskId" to NanoflowWidgetTelemetry.redactId(taskId),
        "remainingVisibleCount" to remainingTasks.size,
      ),
    )

    return WidgetFocusOptimisticSnapshot(
      summary = cached,
      selectedTaskIndex = previousSelectedTaskIndex,
      focusWaitMenuOpen = previousWaitMenuOpen,
    )
  }

  suspend fun applyOptimisticFocusWait(
    appWidgetId: Int,
    taskId: String,
    waitMinutes: Int,
  ): WidgetFocusOptimisticSnapshot? {
    val cached = store.readSummary(appWidgetId) ?: return null
    if (cached.focus.active != true || !cached.focus.valid) return null
    val visibleTasks = resolveVisibleCommandCenterTasks(cached)
    val target = visibleTasks.firstOrNull() ?: return null
    if (target.taskId != taskId || !target.valid) return null

    val normalizedWait = waitMinutes.coerceAtLeast(1)
    val waitEndAt = Instant.now().plus(Duration.ofMinutes(normalizedWait.toLong())).toString()
    val suspended = target.copy(
      waitMinutes = normalizedWait,
      waitEndAt = waitEndAt,
      waitExpired = false,
    )
    val reorderedTasks = visibleTasks.drop(1) + suspended
    val previousSelectedTaskIndex = store.readSelectedTaskIndex(appWidgetId)
    val previousWaitMenuOpen = store.readFocusWaitMenuOpen(appWidgetId)
    val patched = patchSummaryWithVisibleCommandTasks(cached, reorderedTasks)
    store.saveSummary(appWidgetId, patched)
    store.persistSelectedTaskIndex(appWidgetId, 0)
    store.persistFocusWaitMenuOpen(appWidgetId, false)
    store.persistPendingFocusMutation(appWidgetId, FOCUS_MUTATION_WAIT)

    NanoflowWidgetTelemetry.info(
      "widget_focus_wait_optimistic_applied",
      mapOf(
        "appWidgetId" to appWidgetId,
        "taskId" to NanoflowWidgetTelemetry.redactId(taskId),
        "waitMinutes" to normalizedWait,
      ),
    )

    return WidgetFocusOptimisticSnapshot(
      summary = cached,
      selectedTaskIndex = previousSelectedTaskIndex,
      focusWaitMenuOpen = previousWaitMenuOpen,
    )
  }

  suspend fun rollbackOptimisticFocusPromotion(
    appWidgetId: Int,
    snapshot: WidgetFocusOptimisticSnapshot,
  ) {
    store.saveSummary(appWidgetId, snapshot.summary)
    store.persistSelectedTaskIndex(appWidgetId, snapshot.selectedTaskIndex)
    store.persistFocusWaitMenuOpen(appWidgetId, snapshot.focusWaitMenuOpen)
    store.clearPendingFocusMutation(appWidgetId)
  }

  suspend fun promoteFocusSecondaryTask(appWidgetId: Int, taskId: String): Boolean {
    val cached = store.readSummary(appWidgetId)
    val target = cached?.let { summary ->
      resolveVisibleCommandCenterTasks(summary).firstOrNull { visibleTask -> visibleTask.taskId == taskId }
    }
    if (target == null || !target.valid) {
      NanoflowWidgetTelemetry.warn(
        "widget_focus_promote_failure",
        mapOf(
          "appWidgetId" to appWidgetId,
          "taskId" to NanoflowWidgetTelemetry.redactId(taskId),
          "reason" to "task-not-promotable",
        ),
      )
      return false
    }

    val binding = store.readBinding()
    if (binding == null) {
      NanoflowWidgetTelemetry.warn(
        "widget_focus_promote_failure",
        mapOf(
          "appWidgetId" to appWidgetId,
          "reason" to "binding-missing",
          "taskId" to NanoflowWidgetTelemetry.redactId(taskId),
        ),
      )
      return false
    }

    val requestBody = json.encodeToString(
      WidgetFocusPromoteRequestPayload(
        action = "promote-secondary",
        taskId = taskId,
      ),
    )

    val response = runCatching {
      postJson(
        url = "${resolveWidgetSupabaseUrl()}/functions/v1/widget-focus-action",
        bearerToken = binding.widgetToken,
        body = requestBody,
      )
    }.getOrElse { error ->
      NanoflowWidgetTelemetry.warn(
        "widget_focus_promote_failure",
        mapOf(
          "appWidgetId" to appWidgetId,
          "taskId" to NanoflowWidgetTelemetry.redactId(taskId),
          "reason" to "transport-failed",
        ),
        error,
      )
      return false
    }

    if (response.statusCode !in 200..299) {
      NanoflowWidgetTelemetry.warn(
        "widget_focus_promote_failure",
        mapOf(
          "appWidgetId" to appWidgetId,
          "taskId" to NanoflowWidgetTelemetry.redactId(taskId),
          "reason" to "remote-rejected",
          "statusCode" to response.statusCode,
        ),
      )
      return false
    }

    NanoflowWidgetTelemetry.info(
      "widget_focus_promote_success",
      mapOf(
        "appWidgetId" to appWidgetId,
        "taskId" to NanoflowWidgetTelemetry.redactId(taskId),
      ),
    )
    return true
  }

  suspend fun completeFrontFocusTask(appWidgetId: Int, taskId: String): Boolean {
    return invokeFocusAction(
      appWidgetId = appWidgetId,
      action = "complete-front",
      taskId = taskId,
      waitMinutes = null,
      telemetryName = "widget_focus_complete",
    )
  }

  suspend fun suspendFrontFocusTask(appWidgetId: Int, taskId: String, waitMinutes: Int): Boolean {
    return invokeFocusAction(
      appWidgetId = appWidgetId,
      action = "wait-front",
      taskId = taskId,
      waitMinutes = waitMinutes.coerceAtLeast(1),
      telemetryName = "widget_focus_wait",
    )
  }

  private suspend fun invokeFocusAction(
    appWidgetId: Int,
    action: String,
    taskId: String,
    waitMinutes: Int?,
    telemetryName: String,
  ): Boolean {
    val binding = store.readBinding()
    if (binding == null) {
      NanoflowWidgetTelemetry.warn(
        "${telemetryName}_failure",
        mapOf(
          "appWidgetId" to appWidgetId,
          "reason" to "binding-missing",
          "taskId" to NanoflowWidgetTelemetry.redactId(taskId),
        ),
      )
      return false
    }

    val requestBody = json.encodeToString(
      WidgetFocusPromoteRequestPayload(
        action = action,
        taskId = taskId,
        waitMinutes = waitMinutes,
      ),
    )

    val response = runCatching {
      postJson(
        url = "${resolveWidgetSupabaseUrl()}/functions/v1/widget-focus-action",
        bearerToken = binding.widgetToken,
        body = requestBody,
      )
    }.getOrElse { error ->
      NanoflowWidgetTelemetry.warn(
        "${telemetryName}_failure",
        mapOf(
          "appWidgetId" to appWidgetId,
          "taskId" to NanoflowWidgetTelemetry.redactId(taskId),
          "reason" to "transport-failed",
        ),
        error,
      )
      return false
    }

    if (response.statusCode !in 200..299) {
      NanoflowWidgetTelemetry.warn(
        "${telemetryName}_failure",
        mapOf(
          "appWidgetId" to appWidgetId,
          "taskId" to NanoflowWidgetTelemetry.redactId(taskId),
          "reason" to "remote-rejected",
          "statusCode" to response.statusCode,
        ),
      )
      return false
    }

    NanoflowWidgetTelemetry.info(
      "${telemetryName}_success",
      mapOf(
        "appWidgetId" to appWidgetId,
        "taskId" to NanoflowWidgetTelemetry.redactId(taskId),
        "waitMinutes" to waitMinutes,
      ),
    )
    return true
  }

  suspend fun markBlackBoxEntry(appWidgetId: Int, entryId: String, action: BlackBoxEntryAction): Boolean {
    val binding = store.readBinding()
    if (binding == null) {
      NanoflowWidgetTelemetry.warn(
        "widget_black_box_action_failure",
        mapOf(
          "appWidgetId" to appWidgetId,
          "reason" to "binding-missing",
          "action" to action.wireValue,
        ),
      )
      return false
    }

    val requestBody = json.encodeToString(
      WidgetBlackBoxActionRequestPayload(
        entryId = entryId,
        action = action.wireValue,
      ),
    )

    val response = runCatching {
      postJson(
        url = "${resolveWidgetSupabaseUrl()}/functions/v1/widget-black-box-action",
        bearerToken = binding.widgetToken,
        body = requestBody,
      )
    }.getOrElse { error ->
      NanoflowWidgetTelemetry.warn(
        "widget_black_box_action_failure",
        mapOf(
          "appWidgetId" to appWidgetId,
          "entryId" to NanoflowWidgetTelemetry.redactId(entryId),
          "action" to action.wireValue,
          "reason" to "transport-failed",
        ),
        error,
      )
      return false
    }

    if (response.statusCode !in 200..299) {
      NanoflowWidgetTelemetry.warn(
        "widget_black_box_action_failure",
        mapOf(
          "appWidgetId" to appWidgetId,
          "entryId" to NanoflowWidgetTelemetry.redactId(entryId),
          "action" to action.wireValue,
          "reason" to "http-${response.statusCode}",
        ),
      )
      return false
    }

    NanoflowWidgetTelemetry.info(
      "widget_black_box_action_success",
      mapOf(
        "appWidgetId" to appWidgetId,
        "entryId" to NanoflowWidgetTelemetry.redactId(entryId),
        "action" to action.wireValue,
      ),
    )
    return true
  }

  suspend fun refreshSummary(appWidgetId: Int): WidgetSummaryResponse {
    val binding = store.readBinding()
    if (binding == null) {
      val fallback = WidgetSummaryResponse(
        trustState = "auth-required",
        error = "Widget 尚未完成 bootstrap",
        code = "WIDGET_BOOTSTRAP_REQUIRED",
        degradedReasons = listOf("bootstrap-required"),
      )
      store.saveSummary(appWidgetId, fallback)
      NanoflowWidgetTelemetry.warn(
        "widget_summary_fetch_failure",
        mapOf(
          "appWidgetId" to appWidgetId,
          "code" to fallback.code,
          "reason" to "binding-missing",
          "trustState" to fallback.trustState,
        ),
      )
      return fallback
    }

    // DRILL-04: 限流退避——若仍在退避期内，直接返回缓存
    if (store.isRateLimitBackoffActive()) {
      val cachedSummary = store.readSummary(appWidgetId)
      if (cachedSummary != null) {
        NanoflowWidgetTelemetry.warn(
          "widget_summary_fetch_failure",
          mapOf(
            "appWidgetId" to appWidgetId,
            "code" to cachedSummary.code,
            "reason" to "rate-limit-backoff-active",
            "sourceState" to cachedSummary.sourceState,
            "trustState" to cachedSummary.trustState,
          ),
        )
        return cachedSummary
      }
    }

    val instanceId = store.ensureInstanceId(appWidgetId)
    val lastKnownVersion = store.readSummary(appWidgetId)?.summaryVersion
    val requestBody = buildSummaryRequestBody(lastKnownVersion, instanceId, appWidgetId.toString())
    val cachedSummary = store.readSummary(appWidgetId)

    NanoflowWidgetTelemetry.info(
      "widget_summary_fetch_started",
      mapOf(
        "appWidgetId" to appWidgetId,
        "hasCachedSummary" to (cachedSummary != null),
        "instanceId" to NanoflowWidgetTelemetry.redactId(instanceId),
        "lastKnownSummaryVersion" to !lastKnownVersion.isNullOrBlank(),
      ),
    )

    val response = runCatching {
      postJson(
        url = "${resolveWidgetSupabaseUrl()}/functions/v1/widget-summary",
        bearerToken = binding.widgetToken,
        body = requestBody,
      )
    }.getOrElse { error ->
      val fallback = buildTransportFallback(cachedSummary, error)
      store.saveSummary(appWidgetId, fallback)
      NanoflowWidgetTelemetry.warn(
        "widget_summary_fetch_failure",
        mapOf(
          "appWidgetId" to appWidgetId,
          "code" to fallback.code,
          "hasCachedSummary" to (cachedSummary != null),
          "instanceId" to NanoflowWidgetTelemetry.redactId(instanceId),
          "reason" to "transport-failed",
          "sourceState" to fallback.sourceState,
          "trustState" to fallback.trustState,
        ),
        error,
      )
      return fallback
    }

    val summary = runCatching {
      json.decodeFromString(WidgetSummaryResponse.serializer(), response.body)
    }.getOrElse { error ->
      NanoflowWidgetTelemetry.warn(
        "widget_summary_fetch_failure",
        mapOf(
          "appWidgetId" to appWidgetId,
          "instanceId" to NanoflowWidgetTelemetry.redactId(instanceId),
          "reason" to "summary-parse-failed",
          "statusCode" to response.statusCode,
        ),
        error,
      )
      WidgetSummaryResponse(
        trustState = "untrusted",
        error = "无法解析 widget-summary 响应",
        code = "WIDGET_SUMMARY_INVALID",
        degradedReasons = listOf("summary-parse-failed"),
      )
    }
    val normalizedSummary = preserveCachedContextForTransientSummary(summary, cachedSummary)
    val hintedSummary = reconcileRecentFocusHint(appWidgetId, normalizedSummary, cachedSummary)
    val mutationReconciledSummary = reconcilePendingFocusMutation(appWidgetId, normalizedSummary, cachedSummary)
    val reconciledSummary = if (mutationReconciledSummary.sourceState == "cloud-pending-local-focus-mutation") {
      mutationReconciledSummary
    } else {
      hintedSummary
    }
    val shouldResetWidgetContext = reconciledSummary.code in widgetContextResetCodes

    if (shouldResetWidgetContext) {
      store.clearWidgetBindingContext(appWidgetId)
    }

    if (reconciledSummary.code in bindingResetCodes) {
      store.clearBindingState()
      NanoflowWidgetTelemetry.warn(
        "widget_token_revoked",
        mapOf(
          "appWidgetId" to appWidgetId,
          "code" to reconciledSummary.code,
          "instanceId" to NanoflowWidgetTelemetry.redactId(instanceId),
        ),
      )
    }

    // DRILL-04: 收到 RATE_LIMITED 时记录退避时长
    // DRILL-07: WIDGET_REFRESH_DISABLED 也触发退避（30 分钟），避免反复 503
    val retryAfter = reconciledSummary.retryAfterSeconds
    if (reconciledSummary.code == "RATE_LIMITED" && retryAfter != null && retryAfter > 0) {
      store.persistRateLimitBackoff(retryAfter)
      NanoflowWidgetTelemetry.warn(
        "widget_summary_backoff_applied",
        mapOf(
          "appWidgetId" to appWidgetId,
          "code" to reconciledSummary.code,
          "retryAfterSeconds" to retryAfter,
        ),
      )
    } else if (reconciledSummary.code == "WIDGET_REFRESH_DISABLED") {
      store.persistRateLimitBackoff(30 * 60)
      NanoflowWidgetTelemetry.warn(
        "widget_killswitch_applied",
        mapOf(
          "appWidgetId" to appWidgetId,
          "code" to reconciledSummary.code,
          "reason" to "widget-refresh-disabled",
          "instanceId" to NanoflowWidgetTelemetry.redactId(instanceId),
        ),
      )
      NanoflowWidgetTelemetry.warn(
        "widget_summary_backoff_applied",
        mapOf(
          "appWidgetId" to appWidgetId,
          "code" to reconciledSummary.code,
          "retryAfterSeconds" to 30 * 60,
        ),
      )
    } else if (reconciledSummary.code !in transientContextPreservingCodes) {
      store.clearRateLimitBackoff()
    }

    repairMissingPushTokenState(appWidgetId, reconciledSummary)

    store.saveSummary(appWidgetId, reconciledSummary)
    scheduleGateReadCooldownRefreshFromSummary(appWidgetId, reconciledSummary)

    val summaryTelemetryFields = mapOf(
      "appWidgetId" to appWidgetId,
      "code" to reconciledSummary.code,
      "dockCount" to reconciledSummary.dock.count,
      "focusActive" to reconciledSummary.focus.active,
      "freshnessState" to reconciledSummary.freshnessState,
      "instanceId" to NanoflowWidgetTelemetry.redactId(instanceId),
      "pendingBlackBoxCount" to reconciledSummary.blackBox.pendingCount,
      "sourceState" to reconciledSummary.sourceState,
      "statusCode" to response.statusCode,
      "trustState" to reconciledSummary.trustState,
    )

    if (response.statusCode >= 400) {
      NanoflowWidgetTelemetry.warn(
        "widget_summary_fetch_failure",
        summaryTelemetryFields + mapOf("reason" to "server-response"),
      )
    } else {
      NanoflowWidgetTelemetry.info(
        "widget_summary_fetch_success",
        summaryTelemetryFields,
      )
    }

    if (reconciledSummary.freshnessState == "stale") {
      NanoflowWidgetTelemetry.warn(
        "widget_stale_render",
        mapOf(
          "appWidgetId" to appWidgetId,
          "code" to reconciledSummary.code,
          "sourceState" to reconciledSummary.sourceState,
          "trustState" to reconciledSummary.trustState,
        ),
      )
    }

    if (reconciledSummary.trustState == "untrusted") {
      NanoflowWidgetTelemetry.warn(
        "widget_untrusted_render",
        mapOf(
          "appWidgetId" to appWidgetId,
          "code" to reconciledSummary.code,
          "degradedReasons" to reconciledSummary.degradedReasons,
          "sourceState" to reconciledSummary.sourceState,
        ),
      )
    }

    return reconciledSummary
  }

  private fun scheduleGateReadCooldownRefreshFromSummary(appWidgetId: Int, summary: WidgetSummaryResponse) {
    if (summary.focus.active == true) {
      return
    }

    val nextReviewAt = summary.blackBox.nextReviewAt?.takeIf { it.isNotBlank() } ?: return
    val reviewInstant = runCatching { Instant.parse(nextReviewAt) }.getOrNull() ?: return
    val delayMs = Duration.between(Instant.now(), reviewInstant).toMillis().coerceAtLeast(0L)
    NanoflowWidgetRefreshWorker.scheduleGateReadCooldownRefresh(context, appWidgetId, delayMs)
  }

  suspend fun buildRenderModel(appWidgetId: Int): WidgetRenderModel {
    val sizeBucket = store.readSizeBucket(appWidgetId) ?: resolveSizeBucket(appWidgetId)
    val sizeTier = when (sizeBucket) {
      "4x3" -> WidgetSizeTier.LARGE
      "4x2" -> WidgetSizeTier.MEDIUM
      else -> WidgetSizeTier.SMALL
    }
    // 兼容旧字段：仅 SMALL 视为 compact，避免大尺寸误用紧凑布局
    val compact = sizeTier == WidgetSizeTier.SMALL
    val binding = store.readBinding()
    val summary = store.readSummary(appWidgetId)
    if (summary == null) {
      return if (binding != null && !isBindingExpired(binding)) {
        buildStateRenderModel(
          title = context.getString(R.string.nanoflow_widget_sync_ready_title),
          supportingLine = context.getString(R.string.nanoflow_widget_sync_ready_detail),
          statusLine = context.getString(R.string.nanoflow_widget_syncing),
          compact = compact,
          sizeTier = sizeTier,
          tone = WidgetVisualTone.FOCUS,
          statusBadge = context.getString(R.string.nanoflow_widget_badge_syncing),
        )
      } else {
        buildStateRenderModel(
          title = context.getString(R.string.nanoflow_widget_setup_title),
          supportingLine = context.getString(R.string.nanoflow_widget_setup_detail),
          statusLine = context.getString(R.string.nanoflow_widget_setup_required),
          compact = compact,
          sizeTier = sizeTier,
          tone = WidgetVisualTone.SETUP,
          statusBadge = context.getString(R.string.nanoflow_widget_badge_setup),
          showSetup = true,
        )
      }
    }

    val showAuthRequired = summary.trustState == "auth-required"
    val showSetup = summary.code in bootstrapRequiredCodes
    val showUntrusted = summary.trustState == "untrusted"

    if (showSetup) {
      return buildStateRenderModel(
        title = context.getString(R.string.nanoflow_widget_setup_title),
        supportingLine = buildSetupSupportingLine(summary.code),
        statusLine = buildSetupStatusLine(summary),
        compact = compact,
        sizeTier = sizeTier,
        tone = WidgetVisualTone.SETUP,
        statusBadge = context.getString(R.string.nanoflow_widget_badge_setup),
        showSetup = true,
      )
    }

    if (showAuthRequired) {
      return buildStateRenderModel(
        title = context.getString(R.string.nanoflow_widget_auth_required),
        supportingLine = context.getString(R.string.nanoflow_widget_auth_detail),
        statusLine = buildStatusLine(summary),
        compact = compact,
        sizeTier = sizeTier,
        tone = WidgetVisualTone.AUTH,
        statusBadge = context.getString(R.string.nanoflow_widget_badge_auth),
        showAuthRequired = true,
      )
    }

    if (summary.code == "WIDGET_REFRESH_DISABLED") {
      return buildStateRenderModel(
        title = context.getString(R.string.nanoflow_widget_refresh_disabled_title),
        supportingLine = context.getString(R.string.nanoflow_widget_refresh_disabled_detail),
        statusLine = buildStatusLine(summary),
        compact = compact,
        sizeTier = sizeTier,
        tone = WidgetVisualTone.UNTRUSTED,
        statusBadge = context.getString(R.string.nanoflow_widget_badge_paused),
      )
    }

    if (showUntrusted) {
      return buildStateRenderModel(
        title = context.getString(R.string.nanoflow_widget_untrusted_title),
        supportingLine = context.getString(R.string.nanoflow_widget_untrusted_detail),
        statusLine = buildStatusLine(summary),
        compact = compact,
        sizeTier = sizeTier,
        tone = WidgetVisualTone.UNTRUSTED,
        statusBadge = context.getString(R.string.nanoflow_widget_badge_untrusted),
        showUntrusted = true,
      )
    }

    val statusLine = buildStatusLine(summary)
    val statusBadge = buildStatusBadge(summary)
    val privacyMode = store.isPrivacyModeEnabled()
    val gateEntries = resolveRenderableGateEntries(summary, privacyMode)
    val hasFocusState = summary.focus.active == true && summary.focus.valid
    val gateQueueCount = resolveGateQueueCount(summary)
    val showCounts = summary.dock.count > 0 || gateQueueCount > 0
    val showIdleDockSelectionState = !hasFocusState
      && summary.dock.count > 0
      && gateEntries.isEmpty()
      && gateQueueCount == 0
    // 2026-05-01 大门逻辑完善：
    //   * 非空大门 = `!focus && (gateEntries 非空 或 pendingCount>0)` → 整卡点击不进入项目（OPEN_FOCUS_TOOLS），
    //     仅 已读/完成 双按钮通过深链直通 mark-gate-read/complete 改写黑匣子状态。
    //   * 已读条目只在 30 分钟 read cooldown 内从 gateEntries 消失；到期后仍未完成则再次显示。
    //   * 空大门（全部完成清空后）= `!focus && gateEntries.isEmpty() && pendingCount==0` →
    //     渲染空状态大卡（🚪 + 暂无未完成任务 + 点击进入项目），整卡点击走 OPEN_WORKSPACE。
    //   * 专注模式所有任务完成时，服务端需将 focus.active=false（此处依赖后端信号）；
    //     当 focus 不再 active 且无黑匣子时走空大门路径，视觉上自动切换到大门视图。
    val isGateEmpty = !hasFocusState
      && !showIdleDockSelectionState
      && gateEntries.isEmpty()
      && gateQueueCount == 0
    val isGateMode = !hasFocusState
      && !showIdleDockSelectionState
      && (gateEntries.isNotEmpty() || gateQueueCount > 0 || isGateEmpty)
    val metricsLine = buildMetricsLine(summary)

    if (isGateMode) {
      val displayedGateEntries = resolveDisplayedGateEntries(appWidgetId, summary, privacyMode)
      val gateContentCards = if (isGateEmpty) buildGateEmptyContentCards()
        else buildGateContentCards(summary, displayedGateEntries, privacyMode)
      val primaryGateCard = gateContentCards.firstOrNull()
      val displayedGatePreview = displayedGateEntries.firstOrNull()
      val displayedGateEntryId = displayedGatePreview?.entryId?.takeIf { it.isNotBlank() }
      val displayedGateEntryIsRead = displayedGatePreview?.isRead == true
      val displayedGateEntryIsActionable = displayedGatePreview?.let {
        isActionableOptimisticGatePreview(it, privacyMode)
      } == true
      // 空大门点击 = 进入项目（OPEN_WORKSPACE）；非空大门点击只提示用户使用已读/完成按钮。
      val rootPrimaryAction = if (isGateEmpty) WidgetPrimaryAction.OPEN_WORKSPACE
        else WidgetPrimaryAction.BLOCK_GATE_ACTIONS
      return WidgetRenderModel(
        modeLabel = context.getString(R.string.nanoflow_widget_gate_label),
        statusBadge = statusBadge,
        title = primaryGateCard?.title ?: context.getString(R.string.nanoflow_widget_gate_pending_detail),
        supportingLine = primaryGateCard?.subtitle,
        metricsLine = if (showCounts) metricsLine else null,
        statusLine = statusLine,
        primaryActionLabel = context.getString(
          if (isGateEmpty) R.string.nanoflow_widget_open_app else R.string.nanoflow_widget_open_gate,
        ),
        primaryAction = rootPrimaryAction,
        tone = WidgetVisualTone.GATE,
        dockCount = summary.dock.count,
        blackBoxCount = gateQueueCount,
        showStatCards = false,
        isGateMode = true,
        showGatePager = false,
        gatePageIndicator = null,
        canPageBackward = false,
        canPageForward = false,
        compact = compact,
        sizeTier = sizeTier,
        showSetup = false,
        showAuthRequired = false,
        showUntrusted = false,
        displayedGateEntryId = displayedGateEntryId,
        displayedGateEntryIsRead = displayedGateEntryIsRead,
        displayedGateEntryIsActionable = displayedGateEntryIsActionable,
        contentCards = gateContentCards,
        syncBadgeLabel = buildCompactSyncBadge(summary, appWidgetId),
      )
    }

    val focusTitle = summary.focus.title?.takeIf { summary.focus.valid }
    val canOpenFocusTask = hasFocusState && summary.focus.valid

    // 构建 C 位 1-4 卡片列表；主/副属性独立于前后顺序，privacy 模式下隐藏标题细节。
    val taskCards = buildTaskCards(summary, hasFocusState, privacyMode, focusTitle, canOpenFocusTask)
    // 专注模式的小组件永远以 C 位 #1 作为当前任务，不再保留独立的本地 tab 选中态。
    val selectedTaskIndex = 0
    val selectedCard = taskCards.firstOrNull()
    val syncBadgeLabel = buildCompactSyncBadge(summary, appWidgetId)
    val contentCards = buildTaskContentCards(taskCards).ifEmpty {
      listOf(
        WidgetContentCard(
          eyebrow = context.getString(
            if (hasFocusState || showIdleDockSelectionState) R.string.nanoflow_widget_focus_label
            else R.string.nanoflow_widget_gate_label,
          ),
          title = when {
            selectedCard != null -> selectedCard.title
            hasFocusState && privacyMode -> context.getString(R.string.nanoflow_widget_privacy_focus_title)
            hasFocusState && !focusTitle.isNullOrBlank() -> focusTitle
            hasFocusState && canOpenFocusTask -> context.getString(R.string.nanoflow_widget_focus_ready_title)
            hasFocusState -> context.getString(R.string.nanoflow_widget_unknown_task)
            showIdleDockSelectionState -> context.getString(R.string.nanoflow_widget_focus_idle_title)
            else -> context.getString(R.string.nanoflow_widget_gate_empty_title)
          },
          subtitle = when {
            selectedCard != null && !privacyMode -> selectedCard.projectTitle
            hasFocusState && (privacyMode || compact) -> null
            hasFocusState -> buildFocusSupportingLine(summary)
            showIdleDockSelectionState -> context.getString(R.string.nanoflow_widget_focus_idle_detail)
            else -> context.getString(R.string.nanoflow_widget_gate_empty_detail)
          },
        )
      )
    }

    return WidgetRenderModel(
      modeLabel = context.getString(
        if (hasFocusState || showIdleDockSelectionState) R.string.nanoflow_widget_focus_label
        else R.string.nanoflow_widget_gate_label,
      ),
      statusBadge = statusBadge,
      title = when {
        selectedCard != null -> selectedCard.title
        hasFocusState && privacyMode -> context.getString(R.string.nanoflow_widget_privacy_focus_title)
        hasFocusState && !focusTitle.isNullOrBlank() -> focusTitle
        hasFocusState && canOpenFocusTask -> context.getString(R.string.nanoflow_widget_focus_ready_title)
        hasFocusState -> context.getString(R.string.nanoflow_widget_unknown_task)
        showIdleDockSelectionState -> context.getString(R.string.nanoflow_widget_focus_idle_title)
        else -> context.getString(R.string.nanoflow_widget_gate_empty_title)
      },
      supportingLine = when {
        selectedCard != null && !privacyMode -> selectedCard.projectTitle
        hasFocusState && (privacyMode || compact) -> null
        hasFocusState -> buildFocusSupportingLine(summary)
        showIdleDockSelectionState -> context.getString(R.string.nanoflow_widget_focus_idle_detail)
        else -> context.getString(R.string.nanoflow_widget_gate_empty_detail)
      },
      metricsLine = if (showCounts) metricsLine else null,
      statusLine = statusLine,
      primaryActionLabel = context.getString(
        if (canOpenFocusTask) R.string.nanoflow_widget_open_task else R.string.nanoflow_widget_open_app,
      ),
      primaryAction = WidgetPrimaryAction.OPEN_WORKSPACE,
      tone = WidgetVisualTone.FOCUS,
      dockCount = summary.dock.count,
      blackBoxCount = summary.blackBox.pendingCount,
      showStatCards = false,
      isGateMode = false,
      showGatePager = false,
      gatePageIndicator = null,
      canPageBackward = false,
      canPageForward = false,
      compact = compact,
      sizeTier = sizeTier,
      showSetup = false,
      showAuthRequired = false,
      showUntrusted = false,
      tasks = taskCards,
      selectedTaskIndex = selectedTaskIndex,
      contentCards = contentCards,
      syncBadgeLabel = syncBadgeLabel,
      focusWaitMenuOpen = store.readFocusWaitMenuOpen(appWidgetId),
    )
  }

  /**
    * 聚合当前 C 位的 1-4 号槽位。
    * 优先使用服务端显式下发的 commandCenter.slots，避免再从 focus+dock 现场推导主/副属性。
    * 任务属性（主/副）独立于前后顺序，因此第一槽不一定是主任务。
   * 隐私模式下标题用占位符避免信息泄露。
   */
  private fun buildTaskCards(
    summary: WidgetSummaryResponse,
    hasFocusState: Boolean,
    privacyMode: Boolean,
    focusTitle: String?,
    canOpenFocusTask: Boolean,
  ): List<WidgetTaskCard> {
    if (!hasFocusState) return emptyList()
    val resolvedFocusTitle = when {
      privacyMode -> context.getString(R.string.nanoflow_widget_privacy_focus_title)
      !focusTitle.isNullOrBlank() -> focusTitle
      canOpenFocusTask -> context.getString(R.string.nanoflow_widget_focus_ready_title)
      else -> context.getString(R.string.nanoflow_widget_unknown_task)
    }

    return resolveVisibleCommandCenterTasks(summary).mapIndexedNotNull { index, task ->
      if (task.taskId.isNullOrBlank() && task.title.isNullOrBlank()) {
        return@mapIndexedNotNull null
      }
      WidgetTaskCard(
        taskId = task.taskId,
        title = when {
          privacyMode -> context.getString(R.string.nanoflow_widget_privacy_focus_title)
          index == 0 -> resolvedFocusTitle
          else -> task.title?.takeIf { it.isNotBlank() } ?: context.getString(R.string.nanoflow_widget_unknown_task)
        },
        projectTitle = if (privacyMode) null else task.projectTitle,
        estimatedMinutes = task.estimatedMinutes,
        waitMinutes = task.waitMinutes,
        waitEndAt = task.waitEndAt,
        waitExpired = task.waitExpired || isIsoAtOrBeforeNow(task.waitEndAt),
        isMain = task.isMain,
        valid = task.valid,
      )
    }
  }

  private fun buildTaskContentCards(taskCards: List<WidgetTaskCard>): List<WidgetContentCard> {
    return taskCards.mapIndexed { index, card ->
      WidgetContentCard(
        eyebrow = context.getString(R.string.nanoflow_widget_focus_slot_position, index + 1),
        title = card.title,
        subtitle = card.projectTitle,
        metaStart = context.getString(
          if (card.isMain) R.string.nanoflow_widget_focus_slot_main
          else R.string.nanoflow_widget_focus_slot_secondary,
        ),
        metaEnd = card.estimatedMinutes?.let {
          context.getString(R.string.nanoflow_widget_minutes_short, it)
        },
        interactionHint = context.getString(R.string.nanoflow_widget_focus_switch_hint),
      )
    }
  }

  private fun buildGateContentCards(
    summary: WidgetSummaryResponse,
    gateEntries: List<WidgetGatePreview>,
    privacyMode: Boolean,
  ): List<WidgetContentCard> {
    val gateQueueCount = resolveGateQueueCount(summary)
    // 极端兜底：pendingCount 仍有值，但 summary 没带出任何可回退 preview。
    // 继续保持非空大门，避免误判成空大门；正常路径会在 resolveRenderableGateEntries() 中
    // 先回退一条真实 preview，恢复日期与操作按钮。
    if (gateEntries.isEmpty() && gateQueueCount > 0) {
      return listOf(
        WidgetContentCard(
          eyebrow = context.getString(R.string.nanoflow_widget_gate_label),
          title = context.getString(R.string.nanoflow_widget_gate_pending_detail),
          subtitle = context.getString(R.string.nanoflow_widget_content_pending_count, gateQueueCount),
          interactionHint = context.getString(R.string.nanoflow_widget_gate_entry_hint),
        )
      )
    }
    return gateEntries.mapIndexed { index, preview ->
      WidgetContentCard(
        eyebrow = context.getString(
          R.string.nanoflow_widget_content_gate_position,
          index + 1,
          gateEntries.size,
        ),
        title = if (privacyMode) {
          context.getString(R.string.nanoflow_widget_privacy_gate_title, gateQueueCount)
        } else {
          preview.content?.trim()?.takeIf { it.isNotBlank() }
            ?: context.getString(R.string.nanoflow_widget_gate_pending_detail)
        },
        subtitle = preview.projectTitle?.takeIf { it.isNotBlank() },
        metaStart = buildCreatedDateLabel(preview.createdAt),
        metaEnd = buildGateReviewStateLabel(preview),
        interactionHint = context.getString(
          if (preview.isRead) R.string.nanoflow_widget_gate_repeat_hint
          else R.string.nanoflow_widget_gate_entry_hint,
        ),
      )
    }
  }

  /**
   * 空大门状态卡片（E 图）：🚪 + 暂无未完成任务 + 点击进入项目。
   * Factory 在渲染时会检查 `isGateEmptyState` 以切换图标为 nano_widget_icon_door 并隐藏创建/已读元信息。
   */
  private fun buildGateEmptyContentCards(): List<WidgetContentCard> {
    return listOf(
      WidgetContentCard(
        eyebrow = context.getString(R.string.nanoflow_widget_gate_label),
        title = context.getString(R.string.nanoflow_widget_gate_empty_title),
        subtitle = context.getString(R.string.nanoflow_widget_gate_empty_detail),
        interactionHint = context.getString(R.string.nanoflow_widget_gate_empty_hint),
        isGateEmptyState = true,
      )
    )
  }

  /** 紧凑版同步徽章：「刚刚」「N 分前」「较旧」。 */
  private suspend fun buildCompactSyncBadge(summary: WidgetSummaryResponse, appWidgetId: Int): String? {
    // 优先使用本地 wall-clock fetch 时间：这样即便服务端数据未变（cloudUpdatedAt 不变），
    // 用户点了刷新仍然能看到时间归零为「刚刚」，符合"刷新生效"的直觉。
    val localFetchedAtMs = runCatching { store.readSummaryUpdatedAt(appWidgetId) }.getOrNull()
    val instant = if (localFetchedAtMs != null && localFetchedAtMs > 0L) {
      Instant.ofEpochMilli(localFetchedAtMs)
    } else {
      val cloudUpdatedAt = summary.cloudUpdatedAt?.takeIf { it.isNotBlank() } ?: return null
      runCatching { Instant.parse(cloudUpdatedAt) }.getOrNull() ?: return null
    }
    val minutes = Duration.between(instant, Instant.now()).toMinutes().coerceAtLeast(0)
    return when {
      minutes <= 1 -> "刚刚"
      minutes < 60 -> "${minutes} 分前"
      minutes < 1440 -> "${minutes / 60} 小时前"
      else -> "较旧"
    }
  }

  private suspend fun resolveSizeBucket(appWidgetId: Int): String {
    val options = AppWidgetManager.getInstance(context).getAppWidgetOptions(appWidgetId)
    val minWidth = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 0)
    val minHeight = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 0)
    // 与 NanoflowWidgetReceiver.resolveSizeBucket 保持一致的三档判定
    val sizeBucket = when {
      minHeight >= 200 -> "4x3"
      minWidth >= 220 || minHeight >= 120 -> "4x2"
      else -> "2x2"
    }
    store.persistSizeBucket(appWidgetId, sizeBucket)
    return sizeBucket
  }

  private fun buildStateRenderModel(
    title: String,
    supportingLine: String?,
    statusLine: String,
    compact: Boolean,
    sizeTier: WidgetSizeTier,
    tone: WidgetVisualTone,
    statusBadge: String,
    showSetup: Boolean = false,
    showAuthRequired: Boolean = false,
    showUntrusted: Boolean = false,
  ): WidgetRenderModel {
    return WidgetRenderModel(
      modeLabel = context.getString(R.string.nanoflow_widget_label),
      statusBadge = statusBadge,
      title = title,
      supportingLine = supportingLine,
      metricsLine = null,
      statusLine = statusLine,
      primaryActionLabel = context.getString(R.string.nanoflow_widget_open_app),
      primaryAction = WidgetPrimaryAction.OPEN_WORKSPACE,
      tone = tone,
      dockCount = 0,
      blackBoxCount = 0,
      showStatCards = false,
      isGateMode = false,
      showGatePager = false,
      gatePageIndicator = null,
      canPageBackward = false,
      canPageForward = false,
      compact = compact,
      sizeTier = sizeTier,
      showSetup = showSetup,
      showAuthRequired = showAuthRequired,
      showUntrusted = showUntrusted,
      contentCards = listOf(
        WidgetContentCard(
          eyebrow = context.getString(R.string.nanoflow_widget_label),
          title = title,
          subtitle = supportingLine ?: statusLine.takeIf { it != title },
        )
      ),
    )
  }

  suspend fun shiftGatePage(appWidgetId: Int, delta: Int): Int? {
    val summary = store.readSummary(appWidgetId) ?: return null
    if (summary.focus.active == true) {
      store.persistGatePageIndex(appWidgetId, 0)
      store.persistGateSelectedEntryId(appWidgetId, null)
      return 0
    }

    val privacyMode = store.isPrivacyModeEnabled()
    val gateEntries = resolveRenderableGateEntries(summary, privacyMode)
    if (gateEntries.size <= 1) {
      store.persistGatePageIndex(appWidgetId, 0)
      store.persistGateSelectedEntryId(appWidgetId, gateEntries.firstOrNull()?.entryId)
      return 0
    }

    val currentIndex = resolveGatePageIndex(appWidgetId, gateEntries)
    val nextIndex = (currentIndex + delta).coerceIn(0, gateEntries.lastIndex)
    if (nextIndex != currentIndex) {
      store.persistGatePageIndex(appWidgetId, nextIndex)
      store.persistGateSelectedEntryId(appWidgetId, gateEntries[nextIndex].entryId)
    }
    return nextIndex
  }

  private fun buildSetupSupportingLine(code: String?): String {
    return when (code) {
      "INSTANCE_CONTEXT_REQUIRED", "INSTANCE_CONTEXT_INVALID" -> context.getString(R.string.nanoflow_widget_setup_context_fixing)
      "INSTANCE_NOT_ACTIVE", "INSTANCE_BINDING_MISMATCH" -> context.getString(R.string.nanoflow_widget_setup_instance_changed)
      else -> context.getString(R.string.nanoflow_widget_setup_detail)
    }
  }

  private fun buildSetupStatusLine(summary: WidgetSummaryResponse): String {
    return when (summary.code) {
      "INSTANCE_CONTEXT_REQUIRED", "INSTANCE_CONTEXT_INVALID" -> context.getString(R.string.nanoflow_widget_syncing)
      "INSTANCE_NOT_ACTIVE", "INSTANCE_BINDING_MISMATCH" -> context.getString(R.string.nanoflow_widget_target_changed)
      else -> context.getString(R.string.nanoflow_widget_setup_required)
    }
  }

  private fun buildStatusBadge(summary: WidgetSummaryResponse): String {
    return when {
      summary.code == "WIDGET_REFRESH_DISABLED" -> context.getString(R.string.nanoflow_widget_badge_paused)
      summary.sourceState == "cloud-pending-local-hint" -> context.getString(R.string.nanoflow_widget_badge_syncing)
      summary.sourceState == "cache-only" -> context.getString(R.string.nanoflow_widget_badge_cached)
      summary.freshnessState == "stale" || summary.freshnessState == "aging" -> context.getString(R.string.nanoflow_widget_badge_stale)
      else -> context.getString(R.string.nanoflow_widget_badge_ready)
    }
  }

  private fun buildFocusSupportingLine(summary: WidgetSummaryResponse): String? {
    val parts = mutableListOf<String>()

    summary.focus.projectTitle
      ?.takeIf { it.isNotBlank() }
      ?.let(parts::add)

    summary.focus.remainingMinutes
      ?.takeIf { summary.focus.valid }
      ?.let { parts.add(context.getString(R.string.nanoflow_widget_minutes_estimate, it)) }

    return parts.takeIf { it.isNotEmpty() }?.joinToString("  ·  ")
  }

  private fun buildCreatedDateLabel(value: String?): String? {
    val instant = runCatching { Instant.parse(value) }.getOrNull() ?: return null
    val label = shortDateFormatter.format(instant.atZone(ZoneId.systemDefault()))
    return context.getString(R.string.nanoflow_widget_gate_created, label)
  }

  private fun buildRelativeAgeLabel(value: String?): String? {
    val instant = runCatching { Instant.parse(value) }.getOrNull() ?: return null
    val minutes = Duration.between(instant, Instant.now()).toMinutes().coerceAtLeast(0)
    return when {
      minutes <= 1 -> context.getString(R.string.nanoflow_widget_recently)
      minutes < 60 -> context.getString(R.string.nanoflow_widget_relative_minutes, minutes)
      minutes < 1440 -> context.getString(R.string.nanoflow_widget_relative_hours, minutes / 60)
      else -> context.getString(R.string.nanoflow_widget_relative_days, minutes / 1440)
    }
  }

  private fun isIsoAtOrBeforeNow(value: String?): Boolean {
    val instant = runCatching { Instant.parse(value) }.getOrNull() ?: return false
    return !instant.isAfter(Instant.now())
  }

  private fun buildGateReviewStateLabel(preview: WidgetGatePreview): String {
    if (!preview.isRead) {
      return context.getString(R.string.nanoflow_widget_gate_review_pending)
    }
    val relative = buildRelativeAgeLabel(preview.updatedAt)
      ?: buildRelativeAgeLabel(preview.createdAt)
      ?: context.getString(R.string.nanoflow_widget_recently)
    return context.getString(R.string.nanoflow_widget_gate_review_read, relative)
  }

  private fun buildGateSupportingLine(preview: WidgetGatePreview): String {
    val parts = mutableListOf<String>()

    preview.projectTitle
      ?.takeIf { it.isNotBlank() }
      ?.let(parts::add)

    buildCreatedDateLabel(preview.createdAt)?.let(parts::add)
    buildGateReviewStateLabel(preview).let(parts::add)

    return parts.takeIf { it.isNotEmpty() }?.joinToString("  ·  ")
      ?: context.getString(R.string.nanoflow_widget_gate_pending_detail)
  }

  private fun buildMetricsLine(summary: WidgetSummaryResponse): String {
    return context.getString(
      R.string.nanoflow_widget_counts,
      summary.dock.count,
      resolveGateQueueCount(summary),
    )
  }

  private fun resolveGateQueueCount(summary: WidgetSummaryResponse): Int {
    return summary.blackBox.pendingCount.coerceAtLeast(0)
  }

  private fun resolveBlackBoxUnreadCount(summary: WidgetSummaryResponse): Int {
    val pendingCount = summary.blackBox.pendingCount.coerceAtLeast(0)
    val explicitUnreadCount = summary.blackBox.unreadCount
    if (explicitUnreadCount != null) {
      return explicitUnreadCount.coerceIn(0, pendingCount)
    }

    val previewUnreadCount = summary.blackBox.previews.count { !it.isRead }
    return previewUnreadCount.coerceAtMost(pendingCount)
  }

  private fun resolveRenderableGateEntries(
    summary: WidgetSummaryResponse,
    privacyMode: Boolean,
  ): List<WidgetGatePreview> {
    return resolveRenderableGateEntriesForBlackBox(summary.blackBox, privacyMode)
  }

  private fun preferRicherGatePreview(current: WidgetGatePreview, candidate: WidgetGatePreview): WidgetGatePreview {
    return if (gatePreviewRichness(candidate) >= gatePreviewRichness(current)) candidate else current
  }

  private fun gatePreviewRichness(preview: WidgetGatePreview): Int {
    var score = 0
    if (!preview.entryId.isNullOrBlank()) score += 8
    if (!preview.content.isNullOrBlank()) score += 4
    if (!preview.createdAt.isNullOrBlank()) score += 2
    if (!preview.projectTitle.isNullOrBlank()) score += 1
    return score
  }

  private fun isGateReadCoolingDown(preview: WidgetGatePreview): Boolean {
    if (!preview.isRead) {
      return false
    }

    val updatedAt = runCatching {
      Instant.parse(preview.updatedAt?.takeIf { it.isNotBlank() } ?: preview.createdAt ?: "")
    }.getOrNull()
    // 【2026-05-03 安全修复】若 updatedAt 和 createdAt 均无法解析（字段缺失或格式异常），
    // 旧实现 `return true` 会让该条目永久进入 cooling down，从大门视图中消失。
    // 修正：时间戳不可用时视为「已冷却」以外的兜底，允许条目继续展示，
    // 避免因服务端数据异常导致大门永远显示为空。
    if (updatedAt == null) return false
    val elapsedMs = Duration.between(updatedAt, Instant.now()).toMillis().coerceAtLeast(0)
    return elapsedMs < GATE_READ_REAPPEAR_COOLDOWN_MS
  }

  private fun isSameGatePreview(left: WidgetGatePreview, right: WidgetGatePreview): Boolean {
    val leftEntryId = left.entryId?.takeIf { it.isNotBlank() }
    val rightEntryId = right.entryId?.takeIf { it.isNotBlank() }
    if (leftEntryId != null && rightEntryId != null) {
      return leftEntryId == rightEntryId
    }

    return left.content == right.content
      && left.createdAt == right.createdAt
      && left.projectId == right.projectId
  }

  private suspend fun resolveDisplayedGateEntries(
    appWidgetId: Int,
    summary: WidgetSummaryResponse,
    privacyMode: Boolean,
  ): List<WidgetGatePreview> {
    val gateEntries = resolveRenderableGateEntries(summary, privacyMode)
    if (gateEntries.isEmpty()) {
      return gateEntries
    }

    val selectedGateIndex = resolveGatePageIndex(appWidgetId, gateEntries)
    return if (selectedGateIndex <= 0) {
      gateEntries
    } else {
      gateEntries.drop(selectedGateIndex) + gateEntries.take(selectedGateIndex)
    }
  }

  private suspend fun resolveGatePageIndex(appWidgetId: Int, entries: List<WidgetGatePreview>): Int {
    if (entries.isEmpty()) {
      store.persistGatePageIndex(appWidgetId, 0)
      store.persistGateSelectedEntryId(appWidgetId, null)
      return 0
    }

    val selectedEntryId = store.readGateSelectedEntryId(appWidgetId)?.takeIf { it.isNotBlank() }
    val storedIndex = store.readGatePageIndex(appWidgetId).coerceAtLeast(0)
    val normalizedIndex = selectedEntryId
      ?.let { entryId -> entries.indexOfFirst { it.entryId == entryId } }
      ?.takeIf { it >= 0 }
      ?: storedIndex.coerceIn(0, entries.lastIndex)
    if (normalizedIndex != storedIndex || entries[normalizedIndex].entryId != selectedEntryId) {
      store.persistGatePageIndex(appWidgetId, normalizedIndex)
      store.persistGateSelectedEntryId(appWidgetId, entries[normalizedIndex].entryId)
    }
    return normalizedIndex
  }

  private fun buildPreviewTimeLabel(value: String?): String? {
    val instant = runCatching { Instant.parse(value) }.getOrNull() ?: return null
    return clockFormatter.format(instant.atZone(ZoneId.systemDefault()))
  }

  private fun buildFreshnessLabel(cloudUpdatedAt: String): String {
    val instant = runCatching { Instant.parse(cloudUpdatedAt) }.getOrNull()
      ?: return context.getString(R.string.nanoflow_widget_stale)
    val minutes = Duration.between(instant, Instant.now()).toMinutes().coerceAtLeast(0)
    return when {
      minutes <= 1 -> "刚刚同步"
      minutes <= 60 -> "$minutes 分钟前同步"
      else -> context.getString(R.string.nanoflow_widget_stale)
    }
  }

  private fun resolveSummaryLaunchUri(entryUrl: String?): Uri? {
    val rawEntryUrl = entryUrl?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    val origin = Uri.parse(BuildConfig.NANOFLOW_WEB_ORIGIN)
    val resolved = when {
      rawEntryUrl.startsWith("./") -> "${BuildConfig.NANOFLOW_WEB_ORIGIN.removeSuffix("/")}/${rawEntryUrl.removePrefix("./")}"
      rawEntryUrl.startsWith("/#") -> "${BuildConfig.NANOFLOW_WEB_ORIGIN.removeSuffix("/")}$rawEntryUrl"
      rawEntryUrl.startsWith("#/") -> "${BuildConfig.NANOFLOW_WEB_ORIGIN.removeSuffix("/")}/$rawEntryUrl"
      else -> rawEntryUrl
    }
    val candidate = runCatching { Uri.parse(resolved) }.getOrNull() ?: return null
    if (candidate.scheme != origin.scheme || candidate.authority != origin.authority) {
      return null
    }

    val fragment = candidate.fragment ?: return null
    if (!fragment.substringBefore('?').startsWith("/projects")) {
      return null
    }

    return candidate
  }

  private fun preserveCachedContextForTransientSummary(
    summary: WidgetSummaryResponse,
    cachedSummary: WidgetSummaryResponse?,
  ): WidgetSummaryResponse {
    if (cachedSummary == null || summary.code !in transientContextPreservingCodes) {
      return summary
    }

    return summary.copy(
      summaryVersion = cachedSummary.summaryVersion,
      cloudUpdatedAt = cachedSummary.cloudUpdatedAt,
      consistencyState = cachedSummary.consistencyState ?: summary.consistencyState,
      entryUrl = cachedSummary.entryUrl.ifBlank { summary.entryUrl },
      focus = cachedSummary.focus,
      dock = cachedSummary.dock,
      blackBox = cachedSummary.blackBox,
    )
  }

  private suspend fun reconcileRecentFocusHint(
    appWidgetId: Int,
    summary: WidgetSummaryResponse,
    cachedSummary: WidgetSummaryResponse?,
  ): WidgetSummaryResponse {
    val pendingHint = store.readPendingFocusActiveHint(appWidgetId) ?: return summary
    val hintAgeMs = System.currentTimeMillis() - pendingHint.issuedAtMs
    if (hintAgeMs > FOCUS_HINT_GRACE_MS || summary.code in widgetContextResetCodes || summary.code in bindingResetCodes) {
      store.clearPendingFocusActiveHint(appWidgetId)
      return summary
    }

    if (summary.focus.active == pendingHint.active) {
      store.clearPendingFocusActiveHint(appWidgetId)
      return summary
    }

    NanoflowWidgetTelemetry.info(
      "widget_focus_hint_reconciled",
      mapOf(
        "appWidgetId" to appWidgetId,
        "hintActive" to pendingHint.active,
        "hintAgeMs" to hintAgeMs,
        "summaryFocusActive" to summary.focus.active,
      ),
    )

    val hintedFocus = (cachedSummary?.focus ?: summary.focus).copy(
      active = pendingHint.active,
      valid = pendingHint.active,
    )

    return summary.copy(
      sourceState = "cloud-pending-local-hint",
      focus = hintedFocus,
      warnings = (summary.warnings + "focus-hint-pending").distinct(),
    )
  }

  private suspend fun reconcilePendingFocusMutation(
    appWidgetId: Int,
    summary: WidgetSummaryResponse,
    cachedSummary: WidgetSummaryResponse?,
  ): WidgetSummaryResponse {
    val pendingMutation = store.readPendingFocusMutation(appWidgetId) ?: return summary
    val mutationAgeMs = System.currentTimeMillis() - pendingMutation.issuedAtMs
    if (
      mutationAgeMs > FOCUS_MUTATION_GRACE_MS
      || summary.code in widgetContextResetCodes
      || summary.code in bindingResetCodes
      || cachedSummary == null
    ) {
      store.clearPendingFocusMutation(appWidgetId)
      return summary
    }

    if (focusTaskSignature(summary) == focusTaskSignature(cachedSummary)) {
      store.clearPendingFocusMutation(appWidgetId)
      return summary
    }

    NanoflowWidgetTelemetry.info(
      "widget_focus_mutation_reconciled",
      mapOf(
        "appWidgetId" to appWidgetId,
        "action" to pendingMutation.action,
        "mutationAgeMs" to mutationAgeMs,
      ),
    )

    return summary.copy(
      sourceState = "cloud-pending-local-focus-mutation",
      focus = cachedSummary.focus,
      dock = cachedSummary.dock,
      commandCenter = cachedSummary.commandCenter,
      warnings = (summary.warnings + "focus-mutation-pending").distinct(),
    )
  }

  private fun focusTaskSignature(summary: WidgetSummaryResponse): List<String> {
    return resolveVisibleCommandCenterTasks(summary).map { task ->
      task.taskId?.takeIf { it.isNotBlank() }
        ?: task.title?.takeIf { it.isNotBlank() }
        ?: "position:${task.position}"
    }
  }

  private fun buildStatusLine(summary: WidgetSummaryResponse): String {
    if (summary.degradedReasons.contains("soft-delete-target")) {
      return context.getString(R.string.nanoflow_widget_target_changed)
    }

    if (summary.code == "WIDGET_REFRESH_DISABLED") {
      return context.getString(R.string.nanoflow_widget_refresh_disabled)
    }

    if (summary.sourceState == "cloud-pending-local-hint" || summary.sourceState == "cloud-pending-local-focus-mutation") {
      return context.getString(R.string.nanoflow_widget_syncing)
    }

    if (summary.sourceState == "cache-only") {
      return context.getString(R.string.nanoflow_widget_cached)
    }

    if (summary.freshnessState == "stale" || summary.cloudUpdatedAt.isNullOrBlank()) {
      return context.getString(R.string.nanoflow_widget_stale)
    }

    return buildFreshnessLabel(summary.cloudUpdatedAt)
  }

  private suspend fun shouldBootstrap(appWidgetId: Int): Boolean {
    val binding = store.readBinding() ?: return true
    if (isBindingExpired(binding)) {
      return true
    }

    if (!store.readPendingPushToken().isNullOrBlank()) {
      return true
    }

    val summary = store.readSummary(appWidgetId) ?: return true
    if (summary.degradedReasons.contains(pushTokenRepairDegradedReason)) {
      return true
    }
    if (summary.code in bootstrapRequiredCodes) {
      return true
    }

    // 2026-04-19 trust elevation：provisional 状态也要重新 bootstrap 以给 RPC
    // 重新签发 nonce、让 server 端校验并升级为 trusted 的机会。之前仅在
    // auth-required 时触发，导致 provisional 永远 stick。上层 WidgetReceiver
    // 的刷新防抖（30s）保证不会 RPC 风暴。
    if (summary.trustState == "provisional") {
      return true
    }

    return summary.trustState == "auth-required"
  }

  private fun resolveWidgetSupabaseUrl(): String {
    return store.readRuntimeSupabaseUrl()
      ?: BuildConfig.NANOFLOW_SUPABASE_URL.trimEnd('/')
  }

  private fun isBindingExpired(binding: StoredWidgetBinding): Boolean {
    val expiresAt = runCatching { Instant.parse(binding.expiresAt) }.getOrNull()
      ?: return true
    return !expiresAt.isAfter(Instant.now())
  }

  private fun buildSummaryRequestBody(lastKnownVersion: String?, instanceId: String, hostInstanceId: String): String {
    val clientVersion = BuildConfig.NANOFLOW_WIDGET_CLIENT_VERSION.takeIf { it.isNotBlank() }
    return json.encodeToString(
      WidgetSummaryRequestPayload(
        clientSchemaVersion = 1,
        platform = BuildConfig.NANOFLOW_WIDGET_PLATFORM,
        supportsPush = BuildConfig.NANOFLOW_FCM_ENABLED,
        clientVersion = clientVersion,
        lastKnownSummaryVersion = lastKnownVersion?.takeIf { it.isNotBlank() },
        instanceId = instanceId,
        hostInstanceId = hostInstanceId,
      ),
    )
  }

  private fun buildTransportFallback(
    cachedSummary: WidgetSummaryResponse?,
    error: Throwable,
  ): WidgetSummaryResponse {
    return cachedSummary?.copy(
      trustState = when (cachedSummary.trustState) {
        "auth-required" -> "auth-required"
        "untrusted" -> "untrusted"
        else -> "provisional"
      },
      sourceState = "cache-only",
      warnings = (cachedSummary.warnings + listOf("transport-failed")).distinct(),
      degradedReasons = (cachedSummary.degradedReasons + listOf("transport-failed")).distinct(),
      error = error.message ?: "widget-summary 请求失败",
    ) ?: WidgetSummaryResponse(
      trustState = "untrusted",
      sourceState = "cache-only",
      error = error.message ?: "widget-summary 请求失败",
      code = "WIDGET_SUMMARY_TRANSPORT_FAILED",
      degradedReasons = listOf("transport-failed"),
      warnings = listOf("transport-failed"),
    )
  }

  private suspend fun postJson(url: String, bearerToken: String, body: String): HttpResponse {
    val normalizedBearerToken = bearerToken.trim()
    require(normalizedBearerToken.isNotBlank()) { "Widget bearer token is required" }

    return withContext(Dispatchers.IO) {
      val connection = (URL(url).openConnection() as HttpURLConnection).apply {
        requestMethod = "POST"
        connectTimeout = 10_000
        readTimeout = 10_000
        doOutput = true
        useCaches = false
        defaultUseCaches = false
        setRequestProperty("Content-Type", "application/json")
        setRequestProperty("Authorization", "Bearer $normalizedBearerToken")
        setRequestProperty("Cache-Control", "no-store")
        setRequestProperty("Pragma", "no-cache")
        setRequestProperty("x-widget-platform", BuildConfig.NANOFLOW_WIDGET_PLATFORM)
        setRequestProperty("x-widget-client-version", BuildConfig.NANOFLOW_WIDGET_CLIENT_VERSION)
      }

      connection.outputStream.bufferedWriter().use { it.write(body) }
      val bodyText = readBody(connection)
      HttpResponse(statusCode = connection.responseCode, body = bodyText)
    }
  }

  private fun readBody(connection: HttpURLConnection): String {
    val stream = if (connection.responseCode >= 400) connection.errorStream else connection.inputStream
    if (stream == null) return ""

    return BufferedReader(InputStreamReader(stream)).use { it.readText() }
  }

  private fun resolveSelectedTaskEntryUrl(
    summary: WidgetSummaryResponse?,
    requestedTaskIndex: Int,
  ): String? {
    if (summary == null || requestedTaskIndex < 0) {
      return null
    }

    val targetTask = resolveVisibleCommandCenterTasks(summary).getOrNull(requestedTaskIndex)
      ?: return null
    if (!targetTask.valid) {
      return buildWorkspaceEntryUrl()
    }

    val taskId = targetTask.taskId?.takeIf { it.isNotBlank() }
    val projectId = targetTask.projectId?.takeIf { it.isNotBlank() }
    return when {
      projectId != null && taskId != null -> buildTaskEntryUrl(projectId, taskId)
      projectId != null -> buildProjectEntryUrl(projectId)
      else -> buildWorkspaceEntryUrl()
    }
  }

  private fun resolveVisibleCommandCenterTasks(summary: WidgetSummaryResponse): List<VisibleCommandCenterTask> {
    val commandSlots = summary.commandCenter.slots
      .asSequence()
      .filter { !it.taskId.isNullOrBlank() || !it.title.isNullOrBlank() }
      .sortedBy { slot -> if (slot.position > 0) slot.position else Int.MAX_VALUE }
      .take(4)
      .map { slot ->
        VisibleCommandCenterTask(
          position = if (slot.position > 0) slot.position else 1,
          taskId = slot.taskId,
          projectId = slot.projectId,
          title = slot.title,
          projectTitle = slot.projectTitle,
          estimatedMinutes = slot.estimatedMinutes,
          waitMinutes = slot.waitMinutes,
          waitEndAt = slot.waitEndAt,
          waitExpired = slot.waitExpired || isIsoAtOrBeforeNow(slot.waitEndAt),
          isMain = slot.isMain,
          valid = slot.valid,
        )
      }
      .toList()
    if (commandSlots.isNotEmpty()) {
      return commandSlots
    }

    val legacyTasks = mutableListOf<VisibleCommandCenterTask>()
    val hasExplicitMain = summary.focus.isMaster == true || summary.dock.items.any { it.isMaster == true }
    val focusIsMain = summary.focus.isMaster ?: !hasExplicitMain
    if (!summary.focus.taskId.isNullOrBlank() || !summary.focus.title.isNullOrBlank()) {
      legacyTasks += VisibleCommandCenterTask(
        position = 1,
        taskId = summary.focus.taskId,
        projectId = summary.focus.projectId,
        title = summary.focus.title,
        projectTitle = summary.focus.projectTitle,
        estimatedMinutes = summary.focus.remainingMinutes,
        waitMinutes = null,
        waitEndAt = null,
        waitExpired = false,
        isMain = focusIsMain,
        valid = summary.focus.valid,
      )
    }
    for ((index, item) in summary.dock.items.withIndex()) {
      if (legacyTasks.size >= 4) break
      if (item.taskId.isNullOrBlank() && item.title.isNullOrBlank()) continue
      legacyTasks += VisibleCommandCenterTask(
        position = index + 2,
        taskId = item.taskId,
        projectId = item.projectId,
        title = item.title,
        projectTitle = item.projectTitle,
        estimatedMinutes = item.estimatedMinutes,
        waitMinutes = null,
        waitEndAt = null,
        waitExpired = false,
        isMain = item.isMaster == true,
        valid = item.valid,
      )
    }
    return legacyTasks
  }

  private fun patchSummaryWithVisibleCommandTasks(
    summary: WidgetSummaryResponse,
    reorderedTasks: List<VisibleCommandCenterTask>,
  ): WidgetSummaryResponse {
    val focusedTask = reorderedTasks.firstOrNull()
    val dockItems = reorderedTasks.drop(1).map { task ->
      WidgetDockItem(
        taskId = task.taskId,
        projectId = task.projectId,
        title = task.title,
        projectTitle = task.projectTitle,
        estimatedMinutes = task.estimatedMinutes,
        waitMinutes = task.waitMinutes,
        waitEndAt = task.waitEndAt,
        waitExpired = task.waitExpired,
        isMaster = task.isMain,
        valid = task.valid,
      )
    }
    val mainTaskId = if (reorderedTasks.isEmpty()) {
      null
    } else {
      reorderedTasks.firstOrNull { it.isMain }?.taskId
        ?: summary.commandCenter.mainTaskId?.takeIf { existingMain ->
          reorderedTasks.any { task -> task.taskId == existingMain }
        }
        ?: focusedTask?.taskId
    }
    val backupCount = maxOf(
      summary.commandCenter.backupCount.coerceAtLeast(0),
      (summary.dock.count - dockItems.size).coerceAtLeast(0),
    )

    return summary.copy(
      focus = summary.focus.copy(
        active = reorderedTasks.isNotEmpty(),
        taskId = focusedTask?.taskId,
        projectId = focusedTask?.projectId,
        projectTitle = focusedTask?.projectTitle,
        title = focusedTask?.title,
        remainingMinutes = focusedTask?.estimatedMinutes,
        isMaster = focusedTask?.isMain,
        valid = focusedTask?.valid ?: false,
      ),
      dock = summary.dock.copy(items = dockItems),
      commandCenter = summary.commandCenter.copy(
        slots = reorderedTasks.mapIndexed { index, task ->
          WidgetCommandCenterSlot(
            position = index + 1,
            taskId = task.taskId,
            projectId = task.projectId,
        title = task.title,
        projectTitle = task.projectTitle,
        estimatedMinutes = task.estimatedMinutes,
        waitMinutes = task.waitMinutes,
        waitEndAt = task.waitEndAt,
        waitExpired = task.waitExpired,
        focusStatus = if (index == 0) "focusing" else null,
        isMain = task.isMain,
        isFocused = index == 0,
        valid = task.valid,
          )
        },
        mainTaskId = mainTaskId,
        focusedTaskId = focusedTask?.taskId,
        backupCount = backupCount,
      ),
    )
  }

  private fun buildTaskEntryUrl(projectId: String, taskId: String): String {
    val encodedProjectId = Uri.encode(projectId)
    val encodedTaskId = Uri.encode(taskId)
    return "./#/projects/$encodedProjectId/task/$encodedTaskId?entry=widget&intent=open-workspace"
  }

  private fun buildProjectEntryUrl(projectId: String): String {
    val encodedProjectId = Uri.encode(projectId)
    return "./#/projects/$encodedProjectId?entry=widget&intent=open-workspace"
  }

  private fun buildWorkspaceEntryUrl(): String {
    return "./#/projects?entry=widget&intent=open-workspace"
  }

  private data class HttpResponse(
    val statusCode: Int,
    val body: String,
  )
}
