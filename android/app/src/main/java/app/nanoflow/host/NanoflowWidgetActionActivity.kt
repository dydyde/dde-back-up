package app.nanoflow.host

import android.appwidget.AppWidgetManager
import android.content.Context
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity

/**
 * 透明 trampoline Activity：承接小组件大门「已读 / 完成」按钮。
 *
 * 直接用 Activity PendingIntent 让 launcher 以前台用户手势启动本进程，避免部分 ROM
 * 对 widget broadcast 的后台自启动限制导致按钮点击完全无反馈。
 */
class NanoflowWidgetActionActivity : ComponentActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    handleActionIntent(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    handleActionIntent(intent)
  }

  private fun handleActionIntent(actionIntent: Intent?) {
    val currentIntent = actionIntent ?: run {
      finish()
      return
    }
    val appWidgetId = currentIntent.getIntExtra(
      NanoflowWidgetReceiver.EXTRA_APP_WIDGET_ID,
      AppWidgetManager.INVALID_APPWIDGET_ID,
    )
    NanoflowWidgetTelemetry.info(
      "widget_gate_action_activity_received",
      mapOf(
        "appWidgetId" to appWidgetId,
        "gateAction" to currentIntent.getStringExtra(NanoflowWidgetActionFactory.EXTRA_GATE_ACTION),
        "hasEntryId" to !currentIntent.getStringExtra(NanoflowWidgetReceiver.EXTRA_GATE_ENTRY_ID).isNullOrBlank(),
        "itemType" to currentIntent.getStringExtra(NanoflowWidgetReceiver.EXTRA_ITEM_TYPE),
      ),
    )
    if (appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID) {
      NanoflowWidgetTelemetry.warn("widget_gate_action_activity_rejected", mapOf("reason" to "missing-widget-id"))
      finish()
      return
    }

    NanoflowWidgetReceiver.resetReactiveRefreshGate(
      applicationContext,
      "widget-gate-action-activity",
    )

    dispatchToReceiver(applicationContext, appWidgetId, currentIntent)
    finish()
  }

  private fun dispatchToReceiver(context: Context, appWidgetId: Int, source: Intent) {
    val receiverIntent = Intent(context, NanoflowWidgetReceiver::class.java).apply {
      action = NanoflowWidgetReceiver.ACTION_CLICK_ITEM
      setPackage(context.packageName)
      putExtras(source)
      putExtra(NanoflowWidgetReceiver.EXTRA_APP_WIDGET_ID, appWidgetId)
      putExtra(NanoflowWidgetReceiver.EXTRA_ITEM_TYPE, NanoflowWidgetActionFactory.ITEM_TYPE_GATE_ACTION)
    }
    context.sendBroadcast(receiverIntent)
  }
}
