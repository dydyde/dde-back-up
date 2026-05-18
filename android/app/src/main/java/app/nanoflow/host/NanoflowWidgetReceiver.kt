package app.nanoflow.host

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.widget.Toast
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext

/**
 * 原生 AppWidget 接收器。
 *
 * 交互模型：
 *  - Root 级整卡点击：`setOnClickPendingIntent` 挂载 [ACTION_CLICK_OPEN_APP] / [ACTION_CLICK_OPEN_FOCUS_TOOLS]。
 *  - Focus tabs / Gate pager / Refresh：统一通过 `RemoteViewsService + RemoteViewsFactory + PendingIntentTemplate`
 *    派发，所有子 item 的 click 走 [ACTION_CLICK_ITEM]，fillInIntent 携带 [EXTRA_ITEM_TYPE] 等 extras。
 *    此路径与 MIUI launcher 的 root 吞噬机制不同，属于绕道实现。
 */
class NanoflowWidgetReceiver : AppWidgetProvider() {

  override fun onUpdate(
    context: Context,
    appWidgetManager: AppWidgetManager,
    appWidgetIds: IntArray,
  ) {
    runBlocking {
      val store = NanoflowWidgetStore(context)
      val repository = NanoflowWidgetRepository(context)
      appWidgetIds.forEach { widgetId ->
        val existingInstanceId = store.readInstanceId(widgetId)
        val instanceId = store.ensureInstanceId(widgetId)
        val sizeBucket = resolveSizeBucket(appWidgetManager.getAppWidgetOptions(widgetId))
        store.persistSizeBucket(widgetId, sizeBucket)
        NanoflowWidgetTelemetry.info(
          if (existingInstanceId == null) "widget_instance_install" else "widget_instance_update",
          mapOf(
            "appWidgetId" to widgetId,
            "instanceId" to NanoflowWidgetTelemetry.redactId(instanceId),
            "sizeBucket" to sizeBucket,
          ),
        )
        renderAndApply(context, appWidgetManager, repository, widgetId)
        notifyActionListsDataChanged(appWidgetManager, widgetId)
      }
    }
    NanoflowWidgetRefreshWorker.syncPeriodicRefresh(context, hasInstalledWidgets(context))
    NanoflowWidgetRefreshWorker.enqueue(context, reason = "receiver-update")
  }

  override fun onAppWidgetOptionsChanged(
    context: Context,
    appWidgetManager: AppWidgetManager,
    appWidgetId: Int,
    newOptions: Bundle,
  ) {
    runBlocking {
      val store = NanoflowWidgetStore(context)
      val repository = NanoflowWidgetRepository(context)
      val instanceId = store.readInstanceId(appWidgetId)
      val sizeBucket = resolveSizeBucket(newOptions)
      store.persistSizeBucket(appWidgetId, sizeBucket)
      NanoflowWidgetTelemetry.info(
        "widget_instance_resized",
        mapOf(
          "appWidgetId" to appWidgetId,
          "instanceId" to NanoflowWidgetTelemetry.redactId(instanceId),
          "sizeBucket" to sizeBucket,
        ),
      )
      renderAndApply(context, appWidgetManager, repository, appWidgetId)
      notifyActionListsDataChanged(appWidgetManager, appWidgetId)
    }
    NanoflowWidgetRefreshWorker.syncPeriodicRefresh(context, hasInstalledWidgets(context))
    NanoflowWidgetRefreshWorker.enqueue(context, reason = "receiver-options-changed")
  }

  override fun onDeleted(context: Context, appWidgetIds: IntArray) {
    val hasWidgetsRemaining = hasInstalledWidgets(context)
    runBlocking {
      val store = NanoflowWidgetStore(context)
      appWidgetIds.forEach { widgetId ->
        val instanceId = store.readInstanceId(widgetId)
        store.clearWidgetState(widgetId)
        NanoflowWidgetTelemetry.info(
          "widget_instance_uninstall",
          mapOf(
            "appWidgetId" to widgetId,
            "instanceId" to NanoflowWidgetTelemetry.redactId(instanceId),
            "widgetsRemaining" to hasWidgetsRemaining,
          ),
        )
      }
      if (!hasWidgetsRemaining) {
        store.clearAllWidgetState(clearPendingPushToken = true)
      }
    }
    NanoflowWidgetRefreshWorker.syncPeriodicRefresh(context, hasWidgetsRemaining)
  }

  override fun onDisabled(context: Context) {
    NanoflowWidgetTelemetry.info("widget_instance_uninstall_all")
    runBlocking {
      NanoflowWidgetStore(context).clearAllWidgetState(clearPendingPushToken = true)
    }
    NanoflowWidgetRefreshWorker.syncPeriodicRefresh(context, enabled = false)
  }

  override fun onReceive(context: Context, intent: Intent) {
    super.onReceive(context, intent)
    when (intent.action) {
      ACTION_CLICK_OPEN_APP -> {
        resetReactiveRefreshGate(context, "click-open-app")
        handleClickOpenApp(context, intent)
      }
      ACTION_CLICK_OPEN_FOCUS_TOOLS -> {
        resetReactiveRefreshGate(context, "click-open-focus-tools")
        handleClickOpenFocusTools(context, intent)
      }
      ACTION_CLICK_GATE_BLOCKED -> {
        resetReactiveRefreshGate(context, "click-gate-blocked")
        handleGateBlockedClick(context, intent)
      }
      ACTION_CLICK_ITEM -> {
        resetReactiveRefreshGate(context, "click-item")
        handleClickItem(context, intent)
      }
      ACTION_FORCE_REFRESH -> NanoflowWidgetRefreshWorker.enqueue(context, reason = "force-refresh-broadcast")
      // 【根因修复 2026-04-22】APK 升级（尤其 widget layout 结构变化）后，launcher 只会对旧
      // hostView 调 RemoteViews.reapply（经 partiallyUpdateAppWidget）。reapply 无法补齐新增
      // 的 View ID（如 footer_label），也不会重读 layout 属性（如 numColumns）。因此必须在
      // 包替换瞬间，对所有 widgetId 走一次非 partial 的 updateAppWidget，让 launcher 重新
      // inflate hostView。这是结构性 layout 变更能在已安装实例上立即可见的唯一稳定路径。
      Intent.ACTION_MY_PACKAGE_REPLACED -> {
        NanoflowWidgetTelemetry.info("widget_package_replaced_reinflate_all")
        reinflateAllWidgets(context)
        NanoflowWidgetRefreshWorker.enqueue(context, reason = "package-replaced")
      }
      // 【根因修复 2026-04-21】在 FCM 未就绪的环境下，widget 只靠 15-min 周期 WorkManager +
      // 手动 force-refresh + add/resize 回调更新；用户在桌面端切换专注模式后，手机端最长需
      // 等 15 min 才看到同步。USER_PRESENT（解锁）是 manifest receiver 仍稳定可用的
      // 「用户准备看 widget」信号，因此绑 2 min 节流闸；Click 系列 action 会重置闸，让
      // 「点 widget → 切专注 → 回桌面」走 0 延迟刷新。
      Intent.ACTION_USER_PRESENT -> maybeEnqueueReactiveRefresh(
        context,
        reason = "user-present",
        minIntervalMs = USER_PRESENT_REFRESH_MIN_INTERVAL_MS,
        gateKey = USER_PRESENT_REFRESH_GATE_LAST_AT_KEY,
      )
    }
  }

  private fun maybeEnqueueReactiveRefresh(
    context: Context,
    reason: String,
    minIntervalMs: Long,
    gateKey: String,
  ) {
    if (!hasInstalledWidgets(context)) {
      // 未安装 widget 时无需刷新，直接返回；不动 gate 时间戳。
      return
    }
    val prefs = context.applicationContext.getSharedPreferences(REFRESH_GATE_PREFS, Context.MODE_PRIVATE)
    val nowMs = System.currentTimeMillis()
    val lastAutoRefreshMs = prefs.getLong(gateKey, 0L)
    val elapsedMs = nowMs - lastAutoRefreshMs
    if (lastAutoRefreshMs > 0L && elapsedMs < minIntervalMs) {
      NanoflowWidgetTelemetry.info(
        "widget_reactive_refresh_throttled",
        mapOf("reason" to reason, "elapsedMs" to elapsedMs, "minIntervalMs" to minIntervalMs),
      )
      return
    }
    prefs.edit().putLong(gateKey, nowMs).apply()
    NanoflowWidgetRefreshWorker.enqueue(context, reason = reason)
  }

  // --- Click handlers ---
  private fun handleClickOpenApp(context: Context, intent: Intent) {
    val appWidgetId = intent.getIntExtra(EXTRA_APP_WIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
    val taskIndex = intent.getIntExtra(EXTRA_TASK_INDEX, -1)
    NanoflowWidgetTelemetry.info(
      "widget_click_open_app",
      mapOf(
        "appWidgetId" to appWidgetId,
        "launchIntent" to NanoFlowLaunchIntent.OPEN_WORKSPACE.queryValue,
      ),
    )
    context.startActivity(
      NanoflowTwaLauncherActivity.intentForWidget(
        context = context,
        appWidgetId = appWidgetId,
        launchIntent = NanoFlowLaunchIntent.OPEN_WORKSPACE,
        taskIndex = taskIndex,
      ),
    )
  }

  private fun handleClickOpenFocusTools(context: Context, intent: Intent) {
    val appWidgetId = intent.getIntExtra(EXTRA_APP_WIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
    val taskIndex = intent.getIntExtra(EXTRA_TASK_INDEX, -1)
    NanoflowWidgetTelemetry.info(
      "widget_click_open_focus_tools",
      mapOf(
        "appWidgetId" to appWidgetId,
        "launchIntent" to NanoFlowLaunchIntent.OPEN_FOCUS_TOOLS.queryValue,
      ),
    )
    context.startActivity(
      NanoflowTwaLauncherActivity.intentForWidget(
        context = context,
        appWidgetId = appWidgetId,
        launchIntent = NanoFlowLaunchIntent.OPEN_FOCUS_TOOLS,
        taskIndex = taskIndex,
      ),
    )
  }

  private fun handleGateBlockedClick(context: Context, intent: Intent) {
    val appWidgetId = intent.getIntExtra(EXTRA_APP_WIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
    NanoflowWidgetTelemetry.info(
      "widget_click_gate_blocked",
      mapOf("appWidgetId" to appWidgetId),
    )
    Toast.makeText(
      context.applicationContext,
      context.getString(R.string.nanoflow_widget_gate_blocked_toast),
      Toast.LENGTH_SHORT,
    ).show()
  }

  /** 集合视图 item click：根据 EXTRA_ITEM_TYPE 分派到具体处理函数。 */
  private fun handleClickItem(context: Context, intent: Intent) {
    val appWidgetId = intent.getIntExtra(EXTRA_APP_WIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
    if (appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID) return
    when (intent.getStringExtra(EXTRA_ITEM_TYPE)) {
      NanoflowWidgetActionFactory.ITEM_TYPE_TAB -> handleSelectTask(context, appWidgetId, intent)
      NanoflowWidgetActionFactory.ITEM_TYPE_REFRESH -> handleRefresh(context, appWidgetId)
      NanoflowWidgetActionFactory.ITEM_TYPE_GATE -> handleGateNav(context, appWidgetId, intent)
      NanoflowWidgetActionFactory.ITEM_TYPE_GATE_ACTION -> handleGateAction(context, appWidgetId, intent)
      NanoflowWidgetActionFactory.ITEM_TYPE_FOCUS_ACTION -> handleFocusAction(context, appWidgetId, intent)
      NanoflowWidgetActionFactory.ITEM_TYPE_PRIMARY -> handlePrimaryContentClick(context, appWidgetId, intent)
      else -> Unit
    }
  }

  private fun handleFocusAction(context: Context, appWidgetId: Int, intent: Intent) {
    val focusAction = intent.getStringExtra(NanoflowWidgetActionFactory.EXTRA_FOCUS_ACTION)
    val taskId = intent.getStringExtra(EXTRA_TASK_ID)?.takeIf { it.isNotBlank() }
    val waitMinutes = intent.getIntExtra(NanoflowWidgetActionFactory.EXTRA_WAIT_MINUTES, 0)

    if (focusAction == NanoflowWidgetActionFactory.FOCUS_ACTION_WAIT) {
      runBlocking {
        val appContext = context.applicationContext
        val store = NanoflowWidgetStore(appContext)
        store.persistFocusWaitMenuOpen(appWidgetId, true)
        val repository = NanoflowWidgetRepository(appContext)
        val appWidgetManager = AppWidgetManager.getInstance(appContext)
        renderAndApply(appContext, appWidgetManager, repository, appWidgetId, partialUpdate = true)
        notifyActionListsDataChanged(appWidgetManager, appWidgetId)
      }
      Toast.makeText(
        context.applicationContext,
        context.getString(R.string.nanoflow_widget_focus_wait_menu_toast),
        Toast.LENGTH_SHORT,
      ).show()
      return
    }

    if (taskId.isNullOrBlank()) {
      Toast.makeText(
        context.applicationContext,
        context.getString(R.string.nanoflow_widget_focus_promote_failed_toast),
        Toast.LENGTH_SHORT,
      ).show()
      NanoflowWidgetRefreshWorker.enqueue(context, reason = "focus-action-missing-task")
      return
    }

    val pendingResult = goAsync()
    val appContext = context.applicationContext
    silentActionScope.launch {
      val repository = NanoflowWidgetRepository(appContext)

      suspend fun renderCurrentWidget() {
        val appWidgetManager = AppWidgetManager.getInstance(appContext)
        renderAndApply(appContext, appWidgetManager, repository, appWidgetId)
        notifyActionListsDataChanged(appWidgetManager, appWidgetId)
      }

      try {
        when (focusAction) {
          NanoflowWidgetActionFactory.FOCUS_ACTION_COMPLETE -> {
            val optimisticSnapshot = runCatching {
              repository.applyOptimisticFocusCompletion(appWidgetId, taskId)
            }.getOrNull()
            if (optimisticSnapshot != null) {
              runCatching { renderCurrentWidget() }
            }

            val success = runCatching {
              repository.completeFrontFocusTask(appWidgetId, taskId)
            }.getOrElse { false }

            if (success) {
              if (optimisticSnapshot == null) {
                runCatching {
                  repository.refreshSummary(appWidgetId)
                  renderCurrentWidget()
                }
              }
              withContext(Dispatchers.Main) {
                Toast.makeText(
                  appContext,
                  appContext.getString(R.string.nanoflow_widget_focus_complete_toast),
                  Toast.LENGTH_SHORT,
                ).show()
              }
              NanoflowWidgetRefreshWorker.enqueue(appContext, reason = "focus-complete-front")
            } else {
              if (optimisticSnapshot != null) {
                runCatching {
                  repository.rollbackOptimisticFocusPromotion(appWidgetId, optimisticSnapshot)
                  renderCurrentWidget()
                }
              }
              withContext(Dispatchers.Main) {
                Toast.makeText(
                  appContext,
                  appContext.getString(R.string.nanoflow_widget_focus_promote_failed_toast),
                  Toast.LENGTH_SHORT,
                ).show()
              }
              NanoflowWidgetRefreshWorker.enqueue(appContext, reason = "focus-complete-front-retry")
            }
          }
          NanoflowWidgetActionFactory.FOCUS_ACTION_WAIT_PRESET -> {
            val normalizedWait = waitMinutes.coerceAtLeast(1)
            val optimisticSnapshot = runCatching {
              repository.applyOptimisticFocusWait(appWidgetId, taskId, normalizedWait)
            }.getOrNull()
            if (optimisticSnapshot != null) {
              runCatching { renderCurrentWidget() }
            }

            val success = runCatching {
              repository.suspendFrontFocusTask(appWidgetId, taskId, normalizedWait)
            }.getOrElse { false }

            if (success) {
              if (optimisticSnapshot == null) {
                runCatching {
                  repository.refreshSummary(appWidgetId)
                  renderCurrentWidget()
                }
              }
              withContext(Dispatchers.Main) {
                Toast.makeText(
                  appContext,
                  appContext.getString(R.string.nanoflow_widget_focus_wait_toast),
                  Toast.LENGTH_SHORT,
                ).show()
              }
              NanoflowWidgetRefreshWorker.enqueue(appContext, reason = "focus-wait-front")
              NanoflowWidgetRefreshWorker.scheduleFocusWaitReminder(
                appContext,
                appWidgetId,
                normalizedWait,
              )
            } else {
              if (optimisticSnapshot != null) {
                withContext(Dispatchers.Main) {
                  Toast.makeText(
                    appContext,
                    appContext.getString(R.string.nanoflow_widget_focus_wait_toast),
                    Toast.LENGTH_SHORT,
                  ).show()
                }
                NanoflowWidgetRefreshWorker.scheduleFocusWaitReminder(
                  appContext,
                  appWidgetId,
                  normalizedWait,
                )
              } else {
                withContext(Dispatchers.Main) {
                  Toast.makeText(
                    appContext,
                    appContext.getString(R.string.nanoflow_widget_focus_promote_failed_toast),
                    Toast.LENGTH_SHORT,
                  ).show()
                }
              }
              NanoflowWidgetRefreshWorker.enqueue(appContext, reason = "focus-wait-front-retry")
            }
          }
          else -> {
            withContext(Dispatchers.Main) {
              Toast.makeText(
                appContext,
                appContext.getString(R.string.nanoflow_widget_focus_promote_failed_toast),
                Toast.LENGTH_SHORT,
              ).show()
            }
          }
        }
      } finally {
        pendingResult.finish()
      }
    }
  }

  private fun handleGateAction(context: Context, appWidgetId: Int, intent: Intent) {
    val pendingResult = goAsync()
    val appContext = context.applicationContext
    silentActionScope.launch {
      try {
        NanoflowWidgetGateActionHandler.handle(appContext, appWidgetId, intent)
      } finally {
        pendingResult.finish()
      }
    }
  }

  private fun handlePrimaryContentClick(context: Context, appWidgetId: Int, intent: Intent) {
    when (intent.getStringExtra(EXTRA_PRIMARY_ACTION)) {
      WidgetPrimaryAction.BLOCK_GATE_ACTIONS.name -> handleGateBlockedClick(
        context,
        Intent(intent).putExtra(EXTRA_APP_WIDGET_ID, appWidgetId),
      )
      WidgetPrimaryAction.OPEN_FOCUS_TOOLS.name -> handleClickOpenFocusTools(
        context,
        Intent(intent).putExtra(EXTRA_APP_WIDGET_ID, appWidgetId),
      )
      else -> handleClickOpenApp(
        context,
        Intent(intent).putExtra(EXTRA_APP_WIDGET_ID, appWidgetId),
      )
    }
  }

  private fun handleSelectTask(context: Context, appWidgetId: Int, intent: Intent) {
    val targetIndex = intent.getIntExtra(EXTRA_TASK_INDEX, -1)
    if (targetIndex < 0) return
    val taskId = intent.getStringExtra(EXTRA_TASK_ID)?.takeIf { it.isNotBlank() }
    NanoflowWidgetTelemetry.info(
      "widget_click_select_task_tab",
      mapOf(
        "appWidgetId" to appWidgetId,
        "taskIndex" to targetIndex,
        "taskId" to NanoflowWidgetTelemetry.redactId(taskId),
      ),
    )

    if (taskId.isNullOrBlank()) {
      Toast.makeText(
        context.applicationContext,
        context.getString(R.string.nanoflow_widget_focus_promote_failed_toast),
        Toast.LENGTH_SHORT,
      ).show()
      NanoflowWidgetRefreshWorker.enqueue(context, reason = "focus-promote-missing-task")
      return
    }

    val pendingResult = goAsync()
    val appContext = context.applicationContext
    silentActionScope.launch {
      val repository = NanoflowWidgetRepository(appContext)
      val store = NanoflowWidgetStore(appContext)

      suspend fun renderCurrentWidget() {
        val appWidgetManager = AppWidgetManager.getInstance(appContext)
        renderAndApply(appContext, appWidgetManager, repository, appWidgetId)
        notifyActionListsDataChanged(appWidgetManager, appWidgetId)
      }

      try {
        val currentFrontTaskId = runCatching {
          store.readSummary(appWidgetId)?.focus?.taskId?.takeIf { it.isNotBlank() }
        }.getOrNull()
        if (currentFrontTaskId == taskId) {
          NanoflowWidgetTelemetry.info(
            "widget_focus_promote_noop_already_front",
            mapOf(
              "appWidgetId" to appWidgetId,
              "taskId" to NanoflowWidgetTelemetry.redactId(taskId),
            ),
          )
          withContext(Dispatchers.Main) {
            Toast.makeText(
              appContext,
              appContext.getString(R.string.nanoflow_widget_focus_main_fixed_toast),
              Toast.LENGTH_SHORT,
            ).show()
          }
          return@launch
        }

        val canPromote = runCatching {
          repository.isVisibleCommandCenterTaskPromotable(appWidgetId, taskId)
        }.getOrDefault(false)
        if (!canPromote) {
          NanoflowWidgetTelemetry.info(
            "widget_focus_promote_fallback_open_app",
            mapOf(
              "appWidgetId" to appWidgetId,
              "taskId" to NanoflowWidgetTelemetry.redactId(taskId),
              "taskIndex" to targetIndex,
            ),
          )
          handleClickOpenApp(
            context,
            Intent(intent).putExtra(EXTRA_APP_WIDGET_ID, appWidgetId),
          )
          return@launch
        }

        val optimisticSnapshot = runCatching {
          repository.applyOptimisticFocusPromotion(appWidgetId, taskId)
        }.onFailure { error ->
          NanoflowWidgetTelemetry.warn(
            "widget_focus_promote_optimistic_failed",
            mapOf(
              "appWidgetId" to appWidgetId,
              "taskId" to NanoflowWidgetTelemetry.redactId(taskId),
            ),
            error,
          )
        }.getOrNull()

        if (optimisticSnapshot != null) {
          runCatching {
            renderCurrentWidget()
          }.onFailure { error ->
            NanoflowWidgetTelemetry.warn(
              "widget_focus_promote_local_render_failed",
              mapOf(
                "appWidgetId" to appWidgetId,
                "taskId" to NanoflowWidgetTelemetry.redactId(taskId),
                "phase" to "optimistic",
              ),
              error,
            )
          }
        }

        val success = runCatching {
          repository.promoteFocusSecondaryTask(appWidgetId, taskId)
        }.getOrElse { false }

        if (success) {
          if (optimisticSnapshot == null) {
            runCatching {
              repository.refreshSummary(appWidgetId)
              renderCurrentWidget()
            }.onFailure { error ->
              NanoflowWidgetTelemetry.warn(
                "widget_focus_promote_local_render_failed",
                mapOf(
                  "appWidgetId" to appWidgetId,
                  "taskId" to NanoflowWidgetTelemetry.redactId(taskId),
                  "phase" to "post-success",
                ),
                error,
              )
            }
          }
          withContext(Dispatchers.Main) {
            Toast.makeText(
              appContext,
              appContext.getString(R.string.nanoflow_widget_focus_promoted_toast),
              Toast.LENGTH_SHORT,
            ).show()
          }
          NanoflowWidgetRefreshWorker.enqueue(appContext, reason = "focus-promote-secondary")
        } else {
          if (optimisticSnapshot != null) {
            runCatching {
              repository.rollbackOptimisticFocusPromotion(appWidgetId, optimisticSnapshot)
              renderCurrentWidget()
            }.onFailure { error ->
              NanoflowWidgetTelemetry.warn(
                "widget_focus_promote_rollback_failed",
                mapOf(
                  "appWidgetId" to appWidgetId,
                  "taskId" to NanoflowWidgetTelemetry.redactId(taskId),
                ),
                error,
              )
            }
          }
          withContext(Dispatchers.Main) {
            Toast.makeText(
              appContext,
              appContext.getString(R.string.nanoflow_widget_focus_promote_failed_toast),
              Toast.LENGTH_SHORT,
            ).show()
          }
          NanoflowWidgetRefreshWorker.enqueue(appContext, reason = "focus-promote-secondary-retry")
        }
      } finally {
        pendingResult.finish()
      }
    }
  }

  private fun handleRefresh(context: Context, appWidgetId: Int) {
    NanoflowWidgetTelemetry.info(
      "widget_click_refresh",
      mapOf("appWidgetId" to appWidgetId),
    )
    // 不在点击瞬间执行 partiallyUpdateAppWidget：MIUI / HyperOS launcher 收到任何 RemoteViews
    // apply 都会对 AppWidgetHostView 触发 folme 缩放动画，造成「整卡抖动」感。chip 自带的
    // ripple drawable 已经提供了局部点击反馈；worker 完成 fetch 后会做一次完整 update，由
    // buildCompactSyncBadge 基于本地 wall-clock 时间把 sync_badge 重置为「刚刚」。
    NanoflowWidgetRefreshWorker.enqueue(context, reason = "widget-click-refresh")
  }

  private fun handleGateNav(context: Context, appWidgetId: Int, intent: Intent) {
    val delta = intent.getIntExtra(EXTRA_GATE_DELTA, 0)
    if (delta == 0) return
    val eventName = if (delta < 0) "widget_click_previous_blackbox_entry" else "widget_click_next_blackbox_entry"
    runBlocking {
      val repository = NanoflowWidgetRepository(context)
      val pageIndex = repository.shiftGatePage(appWidgetId, delta)
      NanoflowWidgetTelemetry.info(
        eventName,
        mapOf("appWidgetId" to appWidgetId, "pageIndex" to pageIndex),
      )
      val appWidgetManager = AppWidgetManager.getInstance(context)
      renderAndApply(
        context,
        appWidgetManager,
        repository,
        appWidgetId,
        partialUpdate = true,
      )
      notifyActionListsDataChanged(appWidgetManager, appWidgetId)
    }
  }

  // --- 渲染辅助 ---
  private suspend fun renderAndApply(
    context: Context,
    appWidgetManager: AppWidgetManager,
    repository: NanoflowWidgetRepository,
    appWidgetId: Int,
    partialUpdate: Boolean = false,
  ) {
    renderAndApplyWidget(context, appWidgetManager, repository, appWidgetId, partialUpdate)
  }

  private fun resolveSizeBucket(options: Bundle): String {
    val minWidth = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 0)
    val minHeight = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 0)
    return when {
      minHeight >= 200 -> "4x3"
      minWidth >= 220 || minHeight >= 120 -> "4x2"
      else -> "2x2"
    }
  }

  companion object {
    // --- 自定义 click action 常量 ---
    const val ACTION_CLICK_OPEN_APP = "app.nanoflow.twa.widget.CLICK_OPEN_APP"
    const val ACTION_CLICK_OPEN_FOCUS_TOOLS = "app.nanoflow.twa.widget.CLICK_OPEN_FOCUS_TOOLS"
    const val ACTION_CLICK_GATE_BLOCKED = "app.nanoflow.twa.widget.CLICK_GATE_BLOCKED"

    /** 集合视图 item 点击：具体行为由 fillIn 的 EXTRA_ITEM_TYPE 指定。 */
    const val ACTION_CLICK_ITEM = "app.nanoflow.twa.widget.CLICK_ITEM"

    /** 外部 adb / FCM 触发的强制刷新广播。 */
    const val ACTION_FORCE_REFRESH = "app.nanoflow.twa.widget.ACTION_FORCE_REFRESH"

    /**
     * 【2026-04-22】小组件大门 1-tap 已读 / 完成的后台 scope。
     * - SupervisorJob：一次失败不拖累其它 action。
     * - Dispatchers.IO：HTTP 请求。
     * - 进程级单例：BroadcastReceiver 每次被 onReceive 重新创建，scope 不能绑在 receiver 实例上。
     * - 所有协程都受 goAsync() 的 PendingResult 生命周期保护，必须在 finish() 之前完成。
     */
    private val silentActionScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /**
    * 【2026-04-21】反应性刷新节流阀。FCM 未就绪场景下，USER_PRESENT（解锁）
    * 是 manifest receiver 可靠可用的廉价触发点；但用户一天解锁很多次，不节流会导致
    * 不必要的网络/电量开销。
    * - USER_PRESENT 走 2 分钟闸：解锁意味着用户确实在看手机，值得较积极刷新。
     * - Click 系列 action 会把闸门时间戳清零（resetAutoRefreshGate），让「点 widget 进应用 →
     *   切换专注 → 回桌面」闭环走 0 延迟刷新。
     */
    private const val REFRESH_GATE_PREFS = "nanoflow_widget_refresh_gate"
    private const val USER_PRESENT_REFRESH_GATE_LAST_AT_KEY = "userPresentLastAutoRefreshAtMs"
    private const val USER_PRESENT_REFRESH_MIN_INTERVAL_MS: Long = 2 * 60 * 1000

    /**
     * 【2026-04-21】用户点击 widget 的任意 action 时，重置自动刷新闸门时间戳。
     * 目的：覆盖「点 widget 进应用 → 切换专注模式 → 回桌面」闭环 —— 此时 USER_PRESENT
     * 不会因为「刚才点击时刚刷过」而被 2 min 闸门挡住。
     */
    fun resetReactiveRefreshGate(context: Context, reason: String) {
      val prefs = context.applicationContext.getSharedPreferences(REFRESH_GATE_PREFS, Context.MODE_PRIVATE)
      prefs.edit()
        .putLong(USER_PRESENT_REFRESH_GATE_LAST_AT_KEY, 0L)
        .apply()
      NanoflowWidgetTelemetry.info("widget_reactive_gate_reset", mapOf("reason" to reason))
    }

    suspend fun renderAndApplyWidget(
      context: Context,
      appWidgetManager: AppWidgetManager,
      repository: NanoflowWidgetRepository,
      appWidgetId: Int,
      partialUpdate: Boolean = false,
    ) {
      val model = repository.buildRenderModel(appWidgetId)
      val views = NanoflowWidgetRenderer.render(context, appWidgetId, model)
      // 【2026-04-24 根因修复】跨 layout 切换（focus ↔ gate）时 partiallyUpdateAppWidget
      // 无法改 layoutRes，旧结构（如 focus 布局右下角的 refresh_list）会保留 pendingIntent，
      // 吞掉用户点击。对比签名决定：签名变化必须 full update。
      val store = NanoflowWidgetStore(context)
      val newSignature = NanoflowWidgetRenderer.resolveLayoutSignature(model)
      val lastSignature = store.readLastAppliedLayoutSignature(appWidgetId)
      val effectivePartial =
        partialUpdate &&
          !shouldForceFullUpdate(model) &&
          lastSignature != null &&
          lastSignature == newSignature
      if (effectivePartial) {
        appWidgetManager.partiallyUpdateAppWidget(appWidgetId, views)
      } else {
        appWidgetManager.updateAppWidget(appWidgetId, views)
      }
      if (lastSignature != newSignature) {
        store.persistLastAppliedLayoutSignature(appWidgetId, newSignature)
        if (partialUpdate && lastSignature != null) {
          NanoflowWidgetTelemetry.info(
            "widget_layout_signature_changed_full_update",
            mapOf(
              "appWidgetId" to appWidgetId,
              "from" to lastSignature,
              "to" to newSignature,
            ),
          )
        }
      }
    }

    private fun shouldForceFullUpdate(model: WidgetRenderModel): Boolean {
      // MIUI / HyperOS 对 gate_actions_list 的 PendingIntentTemplate 绑定偶发不自愈；
      // 仅当中大尺寸真的渲染出「已读 / 完成」按钮时，才强制 full update 重新 inflate hostView。
      if (model.sizeTier == WidgetSizeTier.SMALL) {
        return false
      }
      if (!model.isGateMode) {
        return false
      }
      if (model.contentCards.firstOrNull()?.isGateEmptyState == true) {
        return false
      }
      return model.displayedGateEntryId?.isNotBlank() == true
    }

    const val EXTRA_APP_WIDGET_ID = "extra.APP_WIDGET_ID"
    const val EXTRA_ITEM_TYPE = "extra.ITEM_TYPE"
    const val EXTRA_TASK_INDEX = "extra.TASK_INDEX"
    const val EXTRA_TASK_ID = "extra.TASK_ID"
    const val EXTRA_GATE_DELTA = "extra.GATE_DELTA"
    const val EXTRA_GATE_ENTRY_ID = "extra.GATE_ENTRY_ID"
    const val EXTRA_LIST_KIND = "extra.LIST_KIND"
    const val EXTRA_PRIMARY_ACTION = "extra.PRIMARY_ACTION"

    // --- PendingIntent builders ---
    /**
     * 整卡主点击：直接挂载 `PendingIntent.getActivity()` 指向 [NanoflowTwaLauncherActivity]。
     *
     * 历史实现走 `PendingIntent.getBroadcast()` 中转到 [NanoflowWidgetReceiver]，再由
     * receiver 调用 `context.startActivity(...)`。但从 Android 14 / targetSdk 34+ 开始，
     * BroadcastReceiver 的运行上下文属于 `RECEIVER` 进程状态，receiver 内发起的
     * `startActivity` 不继承 PendingIntent sender（com.miui.home）的 BAL 授权，
     * 会被系统以 `BAL_BLOCK / result code=102` 拒绝，导致 widget 点击后 LauncherActivity
     * 永远启动不起来，widget bootstrap 永远跑不到 `widget-register`，于是 widget 永远
     * 停留在 `binding-missing` 状态（即用户反馈的「无法进行绑定」）。
     *
     * 改为 `getActivity()` 后，PendingIntent 的目标直接就是 Activity，launcher 侧
     * （sender）作为前台应用本就持有 BAL 授权，Android 会按 sender 的授权放行启动，
     * 绕过 receiver 中转，根治 BAL 阻断问题。
     */
    fun primaryActionPendingIntent(
      context: Context,
      appWidgetId: Int,
      action: WidgetPrimaryAction,
    ): PendingIntent {
      if (action == WidgetPrimaryAction.BLOCK_GATE_ACTIONS) {
        return broadcastPendingIntent(
          context = context,
          intentAction = ACTION_CLICK_GATE_BLOCKED,
          requestCode = requestCodeFor(appWidgetId, ACTION_CLICK_GATE_BLOCKED),
          extras = mapOf(EXTRA_APP_WIDGET_ID to appWidgetId),
        )
      }
      val launchIntent = when (action) {
        WidgetPrimaryAction.OPEN_WORKSPACE -> NanoFlowLaunchIntent.OPEN_WORKSPACE
        WidgetPrimaryAction.OPEN_FOCUS_TOOLS -> NanoFlowLaunchIntent.OPEN_FOCUS_TOOLS
        WidgetPrimaryAction.BLOCK_GATE_ACTIONS -> NanoFlowLaunchIntent.OPEN_FOCUS_TOOLS
      }
      val activityIntent = NanoflowTwaLauncherActivity.intentForWidget(
        context = context,
        appWidgetId = appWidgetId,
        launchIntent = launchIntent,
      )
      // 保留 `widget.CLICK_OPEN_APP` 语义作为 requestCode 维度，避免跨动作共享同一
      // PendingIntent 实例；widgetId + action 组合生成稳定的唯一 requestCode。
      val requestKey = when (action) {
        WidgetPrimaryAction.OPEN_WORKSPACE -> ACTION_CLICK_OPEN_APP
        WidgetPrimaryAction.OPEN_FOCUS_TOOLS -> ACTION_CLICK_OPEN_FOCUS_TOOLS
        WidgetPrimaryAction.BLOCK_GATE_ACTIONS -> ACTION_CLICK_GATE_BLOCKED
      }
      val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      return PendingIntent.getActivity(
        context,
        requestCodeFor(appWidgetId, requestKey),
        activityIntent,
        flags,
      )
    }

    /**
     * 集合视图数据源 adapter intent。
     * data Uri 默认携带 appWidgetId + listKind；必要时追加 stateToken，强制 launcher 丢弃旧 factory。
     */
    fun actionListAdapterIntent(
      context: Context,
      appWidgetId: Int,
      listKind: String,
      stateToken: String? = null,
    ): Intent {
      return Intent(context, NanoflowWidgetActionService::class.java).apply {
        putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId)
        putExtra(EXTRA_LIST_KIND, listKind)
        // 关键：Uri 必须唯一，否则 RemoteViewsAdapter 会在 widget/list 之间共享 factory 造成状态混乱。
        // 对 MIUI / HyperOS，再把当前卡片状态折进 identity，避免 launcher 复用旧 content factory。
        val identitySuffix = stateToken?.takeIf { it.isNotBlank() }?.let { "?state=$it" } ?: ""
        data = Uri.parse("nanoflow://widget/actions/$appWidgetId/$listKind$identitySuffix")
      }
    }

    /**
     * 集合视图 item 点击模板 PendingIntent（广播路径）。
     *
     * 仅用于 tabs / refresh / focus action 这类 broadcast 可接受的列表 —— 这些
     * 交互只在 receiver 内完成 store 更新和 partial update，不触发 BAL。
    * Gate 的已读/完成按钮也走同一条 receiver 分发链；receiver 内部用 goAsync 保护后台动作。
     *
     * **禁止** 在 content 列表（主点击打开 App）上复用此模板：content 列表每 item 的
     * 点击都需要启动 LauncherActivity，走 receiver 中转会触发 Android 14+ 的
     * BAL_BLOCK。请改用 [contentListClickTemplatePendingIntent]。
     *
     * 注意：模板必须使用 `FLAG_MUTABLE` 以允许 fillIn 合并 extras。
     */
    fun actionListClickTemplatePendingIntent(context: Context, appWidgetId: Int): PendingIntent {
      val template = Intent(context, NanoflowWidgetReceiver::class.java).apply {
        action = ACTION_CLICK_ITEM
        setPackage(context.packageName)
      }
      val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
      return PendingIntent.getBroadcast(
        context,
        requestCodeFor(appWidgetId, ACTION_CLICK_ITEM),
        template,
        flags,
      )
    }

    /**
     * 大门「已读 / 完成」点击模板：直接交给 Receiver 的 goAsync 分发链。
     * MIUI / HyperOS 对 noHistory 透明 Activity 的任务清理会让 trampoline 只被拉起、业务入口不执行；
     * 广播路径不依赖 Activity 生命周期，且 fill-in extras 会稳定合并到模板中。
     */
    fun gateActionClickTemplatePendingIntent(context: Context, appWidgetId: Int): PendingIntent {
      val template = Intent(context, NanoflowWidgetReceiver::class.java).apply {
        action = ACTION_CLICK_ITEM
        setPackage(context.packageName)
        putExtra(EXTRA_APP_WIDGET_ID, appWidgetId)
        putExtra(EXTRA_ITEM_TYPE, NanoflowWidgetActionFactory.ITEM_TYPE_GATE_ACTION)
      }
      val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
      return PendingIntent.getBroadcast(
        context,
        requestCodeFor(appWidgetId, "gate-action-broadcast"),
        template,
        flags,
      )
    }

    /**
     * Content 列表点击模板：直接 `getActivity()` 指向 [NanoflowTwaLauncherActivity]。
     *
     * Content 列表目前只含一个 PRIMARY item（整卡主点击的镜像），点击后必须启动
     * LauncherActivity 以触发 widget bootstrap。若继续沿用广播模板 + receiver
     * 中转，会被 Android 14+ BAL 拦截（`callingUidProcState=RECEIVER` 下
     * `startActivity` 不继承 launcher sender 的 BAL 授权）。
     *
     * 这里 template 直接就是 activity 意图，sender（com.miui.home 等前台 launcher）
     * 的 BAL 授权会自然流转到 activity 启动，绕过 receiver 完全消除 BAL 阻断。
     */
    fun contentListClickTemplatePendingIntent(
      context: Context,
      appWidgetId: Int,
      action: WidgetPrimaryAction,
    ): PendingIntent {
      if (action == WidgetPrimaryAction.BLOCK_GATE_ACTIONS) {
        return actionListClickTemplatePendingIntent(context, appWidgetId)
      }
      val launchIntent = when (action) {
        WidgetPrimaryAction.OPEN_WORKSPACE -> NanoFlowLaunchIntent.OPEN_WORKSPACE
        WidgetPrimaryAction.OPEN_FOCUS_TOOLS -> NanoFlowLaunchIntent.OPEN_FOCUS_TOOLS
        WidgetPrimaryAction.BLOCK_GATE_ACTIONS -> NanoFlowLaunchIntent.OPEN_FOCUS_TOOLS
      }
      val template = NanoflowTwaLauncherActivity.intentForWidget(
        context = context,
        appWidgetId = appWidgetId,
        launchIntent = launchIntent,
      )
      // 模板必须 MUTABLE，fillInIntent 才能合并每个 item 的 extras。
      val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
      // requestCode 维度包含 action，避免 OPEN_WORKSPACE / OPEN_FOCUS_TOOLS 共享同一
      // PendingIntent 实例（系统会按 (requestCode, filterEquals) 去重）。
      val requestKey = "content_template|" + when (action) {
        WidgetPrimaryAction.OPEN_WORKSPACE -> "workspace"
        WidgetPrimaryAction.OPEN_FOCUS_TOOLS -> "focus_tools"
        WidgetPrimaryAction.BLOCK_GATE_ACTIONS -> "gate_blocked"
      }
      return PendingIntent.getActivity(
        context,
        requestCodeFor(appWidgetId, requestKey),
        template,
        flags,
      )
    }

    private fun broadcastPendingIntent(
      context: Context,
      intentAction: String,
      requestCode: Int,
      extras: Map<String, Any>,
    ): PendingIntent {
      val intent = Intent(context, NanoflowWidgetReceiver::class.java).apply {
        action = intentAction
        setPackage(context.packageName)
        extras.forEach { (key, value) ->
          when (value) {
            is Int -> putExtra(key, value)
            is String -> putExtra(key, value)
            is Long -> putExtra(key, value)
            is Boolean -> putExtra(key, value)
          }
        }
      }
      val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      return PendingIntent.getBroadcast(context, requestCode, intent, flags)
    }

    private fun requestCodeFor(appWidgetId: Int, key: Any): Int {
      return (appWidgetId.toString() + "|" + key.toString()).hashCode()
    }

    fun hasInstalledWidgets(context: Context): Boolean {
      val appWidgetManager = AppWidgetManager.getInstance(context)
      val componentName = ComponentName(context, NanoflowWidgetReceiver::class.java)
      return appWidgetManager.getAppWidgetIds(componentName).isNotEmpty()
    }

    fun hasInstalledWidgets(context: Context, appWidgetId: Int): Boolean {
      val appWidgetManager = AppWidgetManager.getInstance(context)
      val componentName = ComponentName(context, NanoflowWidgetReceiver::class.java)
      return appWidgetManager.getAppWidgetIds(componentName).contains(appWidgetId)
    }

    /**
     * 强制 launcher 重新 inflate 所有 widget 的 hostView。
     *
     * 与 refreshAllWidgets 的区别：refreshAllWidgets 走 partiallyUpdateAppWidget（= reapply），
     * 无法补齐新增的 View ID 或重读 layout 属性；本方法走非 partial 的 updateAppWidget，
     * 强制 hostView 用最新 @xml/layout 重新 inflate，代价是 MIUI/HyperOS launcher 会播放一次
     * folme 缩放动画，因此仅在 APK 升级等「layout 结构变化」场景调用，不得用于常规数据刷新。
     */
    fun reinflateAllWidgets(context: Context) {
      val appWidgetManager = AppWidgetManager.getInstance(context)
      val componentName = ComponentName(context, NanoflowWidgetReceiver::class.java)
      val ids = appWidgetManager.getAppWidgetIds(componentName)
      if (ids.isEmpty()) return
      runBlocking {
        val repository = NanoflowWidgetRepository(context)
        val store = NanoflowWidgetStore(context)
        ids.forEach { widgetId ->
          val model = repository.buildRenderModel(widgetId)
          val views = NanoflowWidgetRenderer.render(context, widgetId, model)
          appWidgetManager.updateAppWidget(widgetId, views)
          store.persistLastAppliedLayoutSignature(
            widgetId,
            NanoflowWidgetRenderer.resolveLayoutSignature(model),
          )
          notifyActionListsDataChanged(appWidgetManager, widgetId)
        }
      }
    }

    /** 从外部（Worker / FCM / bootstrap）触发所有 widget 重新渲染 + 通知集合数据失效。 */
    fun refreshAllWidgets(context: Context) {
      val appWidgetManager = AppWidgetManager.getInstance(context)
      val componentName = ComponentName(context, NanoflowWidgetReceiver::class.java)
      val ids = appWidgetManager.getAppWidgetIds(componentName)
      if (ids.isEmpty()) return
      runBlocking {
        val repository = NanoflowWidgetRepository(context)
        val store = NanoflowWidgetStore(context)
        ids.forEach { widgetId ->
          val model = repository.buildRenderModel(widgetId)
          val views = NanoflowWidgetRenderer.render(context, widgetId, model)
          // 关键减抖点：worker 完成 fetch 后**默认**走 partiallyUpdateAppWidget（=RemoteViews.reapply），
          // 这条路径不会让 AppWidgetHostView 重新 inflate / 重新 bind，从而避开 MIUI / HyperOS
          // launcher 在 LauncherAppWidgetHostView.updateAppWidget 里挂载的 folme 缩放动画。
          //
          // 【2026-04-24 根因修复】但 partial 无法切换 layoutRes。跨 focus/gate 边界时旧 layout 的
          // refresh_list（78×42 右下角 + pendingIntentTemplate）会残留并吞掉本应给 gate_actions 的
          // 点击，表现为用户点「已读 / 已完成」实际触发 `widget_click_refresh`、专注 UI 被错误 UI 冲掉。
          // 因此比对 layout 签名：变化时强制升级为 full update。
          val newSignature = NanoflowWidgetRenderer.resolveLayoutSignature(model)
          val lastSignature = store.readLastAppliedLayoutSignature(widgetId)
          if (lastSignature == newSignature && !shouldForceFullUpdate(model)) {
            appWidgetManager.partiallyUpdateAppWidget(widgetId, views)
          } else {
            appWidgetManager.updateAppWidget(widgetId, views)
            store.persistLastAppliedLayoutSignature(widgetId, newSignature)
            if (lastSignature != null && lastSignature != newSignature) {
              NanoflowWidgetTelemetry.info(
                "widget_layout_signature_changed_full_update",
                mapOf(
                  "appWidgetId" to widgetId,
                  "source" to "refreshAllWidgets",
                  "from" to lastSignature,
                  "to" to newSignature,
                ),
              )
            }
          }
          notifyActionListsDataChanged(appWidgetManager, widgetId)
        }
      }
    }

    /** 同时刷新 widget 内全部集合视图的数据。 */
    fun notifyActionListsDataChanged(appWidgetManager: AppWidgetManager, appWidgetId: Int) {
      appWidgetManager.notifyAppWidgetViewDataChanged(appWidgetId, R.id.nano_widget_tab_list)
      appWidgetManager.notifyAppWidgetViewDataChanged(appWidgetId, R.id.nano_widget_content_list)
      appWidgetManager.notifyAppWidgetViewDataChanged(appWidgetId, R.id.nano_widget_gate_actions_list)
      appWidgetManager.notifyAppWidgetViewDataChanged(appWidgetId, R.id.nano_widget_focus_actions_list)
      appWidgetManager.notifyAppWidgetViewDataChanged(appWidgetId, R.id.nano_widget_focus_wait_presets_list)
      appWidgetManager.notifyAppWidgetViewDataChanged(appWidgetId, R.id.nano_widget_refresh_list)
    }
  }
}
