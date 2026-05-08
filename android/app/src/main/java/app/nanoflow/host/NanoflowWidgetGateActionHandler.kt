package app.nanoflow.host

import android.appwidget.AppWidgetManager
import android.content.Context
import android.content.Intent
import android.widget.Toast
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * 小组件大门按钮执行器。
 *
 * Gate 的「已读 / 完成」必须直接在 widget 内完成，不应先打开 TWA。该 handler 同时服务：
 * - Activity-backed PendingIntent：避开 MIUI / HyperOS 对 widget broadcast 的静默吞噬。
 * - 旧版本 broadcast 模板：已安装旧 hostView 在下一次完整重绘前仍可被兼容处理。
 */
object NanoflowWidgetGateActionHandler {
  private val remoteActionScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

  suspend fun handle(context: Context, appWidgetId: Int, intent: Intent) {
    val appContext = context.applicationContext
    val gateAction = intent.getStringExtra(NanoflowWidgetActionFactory.EXTRA_GATE_ACTION)
    val entryAction = when (gateAction) {
      NanoflowWidgetActionFactory.GATE_ACTION_READ -> BlackBoxEntryAction.READ
      NanoflowWidgetActionFactory.GATE_ACTION_COMPLETE -> BlackBoxEntryAction.COMPLETE
      else -> null
    }
    if (entryAction == null) {
      NanoflowWidgetTelemetry.warn(
        "widget_click_gate_action_invalid",
        mapOf(
          "appWidgetId" to appWidgetId,
          "gateAction" to (gateAction ?: "missing"),
        ),
      )
      appContext.startActivity(
        NanoflowTwaLauncherActivity.intentForWidget(
          context = appContext,
          appWidgetId = appWidgetId,
          launchIntent = NanoFlowLaunchIntent.OPEN_FOCUS_TOOLS,
        ),
      )
      return
    }

    val repository = NanoflowWidgetRepository(appContext)

    suspend fun renderCurrentWidget() {
      val appWidgetManager = AppWidgetManager.getInstance(appContext)
      NanoflowWidgetReceiver.renderAndApplyWidget(
        appContext,
        appWidgetManager,
        repository,
        appWidgetId,
        partialUpdate = true,
      )
      NanoflowWidgetReceiver.notifyActionListsDataChanged(appWidgetManager, appWidgetId)
    }

    // 读取当前目标 entryId。优先使用 fill-in intent 里由渲染路径直接附带的 displayedGateEntryId，
    // 这样点击目标与屏幕上可见的大门卡严格一致；仅在旧实例/旧缓存没带该字段时才回退到缓存推断。
    val store = NanoflowWidgetStore(appContext)
    val fillInEntryId = intent.getStringExtra(NanoflowWidgetReceiver.EXTRA_GATE_ENTRY_ID)?.takeIf { it.isNotBlank() }
    val cached = runCatching {
      store.readSummary(appWidgetId)
    }.getOrNull()
    val displayedGateEntries = cached?.let {
      runCatching {
        repository.resolveDisplayedGateEntries(appWidgetId, it)
      }.getOrDefault(emptyList())
    }.orEmpty()
    val displayedGateEntryId = displayedGateEntries.firstOrNull()?.entryId?.takeIf { it.isNotBlank() }
    val persistedEntryId = runCatching {
      store.readGateSelectedEntryId(appWidgetId)
    }.getOrNull()?.takeIf { it.isNotBlank() }

    val entryId = fillInEntryId
      ?: displayedGateEntryId
      ?: persistedEntryId
    val currentVisibleEntryId = fillInEntryId
      ?: displayedGateEntryId
    if (currentVisibleEntryId != null && currentVisibleEntryId != persistedEntryId) {
      runCatching {
        store.persistGateSelectedEntryId(appWidgetId, currentVisibleEntryId)
      }
    }

    NanoflowWidgetTelemetry.info(
      "widget_click_gate_action",
      mapOf(
        "appWidgetId" to appWidgetId,
        "gateAction" to entryAction.wireValue,
        "hasEntryId" to !entryId.isNullOrBlank(),
        "entryIdSource" to when {
          fillInEntryId != null -> "fill-in-intent"
          displayedGateEntryId != null && displayedGateEntryId == persistedEntryId -> "rendered-selected-entry"
          displayedGateEntryId != null -> "rendered-entry"
          persistedEntryId != null -> "persisted-fallback"
          else -> "none"
        },
        "mode" to "local-first",
      ),
    )

    if (entryId.isNullOrBlank()) {
      NanoflowWidgetTelemetry.warn(
        "widget_click_gate_action_skipped_no_entry",
        mapOf(
          "appWidgetId" to appWidgetId,
          "gateAction" to entryAction.wireValue,
        ),
      )
      withContext(Dispatchers.Main) {
        Toast.makeText(appContext, "大门暂无待处理条目", Toast.LENGTH_SHORT).show()
      }
      NanoflowWidgetRefreshWorker.enqueue(appContext, reason = "gate-action-${entryAction.wireValue}-empty")
      return
    }

    val currentTargetPreview = displayedGateEntries.firstOrNull { it.entryId == entryId }
      ?: cached?.blackBox?.previews?.firstOrNull { it.entryId == entryId }
      ?: cached?.blackBox?.gatePreview?.takeIf { it.entryId == entryId && it.valid }
    if (entryAction == BlackBoxEntryAction.READ && currentTargetPreview?.isRead == true) {
      NanoflowWidgetTelemetry.info(
        "widget_click_gate_action_skipped_already_read",
        mapOf(
          "appWidgetId" to appWidgetId,
          "entryId" to NanoflowWidgetTelemetry.redactId(entryId),
        ),
      )
      runCatching {
        renderCurrentWidget()
      }.onFailure { error ->
        NanoflowWidgetTelemetry.warn(
          "widget_click_gate_action_local_render_failed",
          mapOf(
            "appWidgetId" to appWidgetId,
            "gateAction" to entryAction.wireValue,
            "phase" to "already-read",
          ),
          error,
        )
      }
      NanoflowWidgetRefreshWorker.enqueue(appContext, reason = "gate-action-read-already-read")
      return
    }

    val optimisticSnapshot = runCatching {
      repository.applyOptimisticBlackBoxAction(appWidgetId, entryId, entryAction)
    }.onFailure { error ->
      NanoflowWidgetTelemetry.warn(
        "widget_click_gate_action_optimistic_failed",
        mapOf(
          "appWidgetId" to appWidgetId,
          "gateAction" to entryAction.wireValue,
          "entryId" to NanoflowWidgetTelemetry.redactId(entryId),
        ),
        error,
      )
    }.getOrNull()

    if (optimisticSnapshot != null) {
      runCatching {
        renderCurrentWidget()
      }.onFailure { error ->
        NanoflowWidgetTelemetry.warn(
          "widget_click_gate_action_local_render_failed",
          mapOf(
            "appWidgetId" to appWidgetId,
            "gateAction" to entryAction.wireValue,
            "phase" to "optimistic",
          ),
          error,
        )
      }
    }

    remoteActionScope.launch {
      submitRemoteAction(
        context = appContext,
        appWidgetId = appWidgetId,
        entryId = entryId,
        entryAction = entryAction,
        optimisticSnapshot = optimisticSnapshot,
      )
    }
  }

  private suspend fun submitRemoteAction(
    context: Context,
    appWidgetId: Int,
    entryId: String,
    entryAction: BlackBoxEntryAction,
    optimisticSnapshot: WidgetBlackBoxOptimisticSnapshot?,
  ) {
    val appContext = context.applicationContext
    val repository = NanoflowWidgetRepository(appContext)

    suspend fun renderCurrentWidget() {
      val appWidgetManager = AppWidgetManager.getInstance(appContext)
      NanoflowWidgetReceiver.renderAndApplyWidget(
        appContext,
        appWidgetManager,
        repository,
        appWidgetId,
        partialUpdate = true,
      )
      NanoflowWidgetReceiver.notifyActionListsDataChanged(appWidgetManager, appWidgetId)
    }

    val success = runCatching {
      repository.markBlackBoxEntry(appWidgetId, entryId, entryAction)
    }.getOrElse { false }

    if (success) {
      if (optimisticSnapshot == null) {
        // 无法做乐观补丁时，在后台拉一轮权威 summary；正常缓存命中路径不等待网络。
        runCatching {
          repository.refreshSummary(appWidgetId)
          renderCurrentWidget()
        }.onFailure { error ->
          NanoflowWidgetTelemetry.warn(
            "widget_click_gate_action_local_render_failed",
            mapOf(
              "appWidgetId" to appWidgetId,
              "gateAction" to entryAction.wireValue,
              "phase" to "post-success",
            ),
            error,
          )
        }
      }
      if (entryAction == BlackBoxEntryAction.READ) {
        NanoflowWidgetRefreshWorker.scheduleGateReadCooldownRefresh(appContext, appWidgetId)
      }
      NanoflowWidgetRefreshWorker.enqueue(appContext, reason = "gate-action-${entryAction.wireValue}")
      return
    }

    NanoflowWidgetTelemetry.warn(
      "widget_click_gate_action_remote_failure",
      mapOf(
        "appWidgetId" to appWidgetId,
        "gateAction" to entryAction.wireValue,
        "entryId" to NanoflowWidgetTelemetry.redactId(entryId),
      ),
    )
    if (optimisticSnapshot != null) {
      runCatching {
        repository.rollbackOptimisticBlackBoxAction(appWidgetId, optimisticSnapshot)
        renderCurrentWidget()
      }.onFailure { error ->
        NanoflowWidgetTelemetry.warn(
          "widget_click_gate_action_rollback_failed",
          mapOf(
            "appWidgetId" to appWidgetId,
            "gateAction" to entryAction.wireValue,
            "entryId" to NanoflowWidgetTelemetry.redactId(entryId),
          ),
          error,
        )
      }
    }
    withContext(Dispatchers.Main) {
      Toast.makeText(appContext, "网络繁忙，请稍后重试", Toast.LENGTH_SHORT).show()
    }
    NanoflowWidgetRefreshWorker.enqueue(appContext, reason = "gate-action-${entryAction.wireValue}-retry")
  }
}
