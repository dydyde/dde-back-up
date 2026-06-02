package app.nanoflow.host

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withTimeoutOrNull
import java.util.concurrent.TimeUnit

class NanoflowWidgetRefreshWorker(
  appContext: Context,
  workerParams: WorkerParameters,
) : CoroutineWorker(appContext, workerParams) {
  override suspend fun doWork(): Result {
    val repository = NanoflowWidgetRepository(applicationContext)
    val reason = inputData.getString("reason") ?: "unknown"
    NanoflowWidgetTelemetry.info("widget_refresh_started", mapOf("reason" to reason))

    var refreshSucceeded = false
    val result = runCatching {
      repository.refreshInstalledWidgets()
      refreshSucceeded = true
      NanoflowWidgetTelemetry.info("widget_refresh_succeeded", mapOf("reason" to reason))
      Result.success()
    }.getOrElse { error ->
      NanoflowWidgetTelemetry.warn(
        "widget_refresh_failed",
        mapOf("reason" to reason),
        error,
      )
      Result.retry()
    }
    // 通知所有已安装 widget 重新渲染（原生 RemoteViews 路径）。
    NanoflowWidgetReceiver.refreshAllWidgets(applicationContext)
    if (refreshSucceeded) {
      ensureFcmTokenPersisted(applicationContext)
    }
    return result
  }

  private suspend fun ensureFcmTokenPersisted(context: Context) {
    if (!BuildConfig.NANOFLOW_FCM_ENABLED) {
      // 未配置 google-services.json 的构建：跳过，避免 FirebaseApp 未初始化时抛异常。
      return
    }
    try {
      val token = withTimeoutOrNull(FCM_TOKEN_ENSURE_TIMEOUT_MS) {
        com.google.firebase.messaging.FirebaseMessaging.getInstance()
          .token
          .await()
      }
      if (token == null) {
        NanoflowWidgetTelemetry.warn(
          "widget_push_token_ensure_skipped",
          mapOf("reason" to "token-timeout", "timeoutMs" to FCM_TOKEN_ENSURE_TIMEOUT_MS),
        )
        return
      }
      if (token.isBlank()) {
        NanoflowWidgetTelemetry.warn(
          "widget_push_token_ensure_skipped",
          mapOf("reason" to "empty-token"),
        )
        return
      }
      NanoflowWidgetRepository(context).rememberPushToken(token)
      NanoflowWidgetTelemetry.info(
        "widget_push_token_ensured",
        mapOf("tokenLength" to token.length, "source" to "worker-post-refresh"),
      )
    } catch (error: Throwable) {
      NanoflowWidgetTelemetry.warn(
        "widget_push_token_ensure_failed",
        mapOf("errorClass" to (error::class.simpleName ?: "unknown")),
        error,
      )
    }
  }

  companion object {
    private const val UNIQUE_WORK_NAME = "nanoflow-widget-refresh"
    private const val UNIQUE_PERIODIC_WORK_NAME = "nanoflow-widget-refresh-periodic"
    private const val TWA_SESSION_BURST_WORK_PREFIX = "nanoflow-widget-twa-session-burst"
    private const val FOCUS_WAIT_REMINDER_WORK_PREFIX = "nanoflow-widget-focus-wait-reminder"
    private const val GATE_READ_COOLDOWN_REFRESH_WORK_PREFIX = "nanoflow-widget-gate-read-cooldown"
    private const val GATE_READ_REAPPEAR_COOLDOWN_MS = 30 * 60 * 1000L
    private const val FCM_TOKEN_ENSURE_TIMEOUT_MS = 2_000L
    private const val TWA_SESSION_BURST_PREFS = "nanoflow-widget-twa-session-burst"
    private const val TWA_SESSION_BURST_LAST_AT_KEY = "last_scheduled_at"
    private const val TWA_SESSION_BURST_MIN_INTERVAL_MS = 30_000L
    private val TWA_SESSION_BURST_DELAYS_SECONDS = longArrayOf(8, 20, 45, 90, 180, 300)

    fun enqueue(context: Context, reason: String) {
      NanoflowWidgetTelemetry.info("widget_refresh_enqueued", mapOf("reason" to reason))
      val request = OneTimeWorkRequestBuilder<NanoflowWidgetRefreshWorker>()
        .setInputData(Data.Builder().putString("reason", reason).build())
        .build()

      WorkManager.getInstance(context).enqueueUniqueWork(
        UNIQUE_WORK_NAME,
        ExistingWorkPolicy.REPLACE,
        request,
      )
    }

    fun scheduleTwaSessionRefreshBurst(context: Context, reason: String) {
      if (!NanoflowWidgetReceiver.hasInstalledWidgets(context)) {
        return
      }

      val prefs = context.applicationContext.getSharedPreferences(TWA_SESSION_BURST_PREFS, Context.MODE_PRIVATE)
      val nowMs = System.currentTimeMillis()
      val lastScheduledAt = prefs.getLong(TWA_SESSION_BURST_LAST_AT_KEY, 0L)
      val elapsedMs = nowMs - lastScheduledAt
      if (lastScheduledAt > 0L && elapsedMs < TWA_SESSION_BURST_MIN_INTERVAL_MS) {
        NanoflowWidgetTelemetry.info(
          "widget_twa_session_refresh_burst_throttled",
          mapOf(
            "reason" to reason,
            "elapsedMs" to elapsedMs,
            "minIntervalMs" to TWA_SESSION_BURST_MIN_INTERVAL_MS,
          ),
        )
        return
      }
      prefs.edit().putLong(TWA_SESSION_BURST_LAST_AT_KEY, nowMs).apply()

      val workManager = WorkManager.getInstance(context)
      TWA_SESSION_BURST_DELAYS_SECONDS.forEachIndexed { index, delaySeconds ->
        val request = OneTimeWorkRequestBuilder<NanoflowWidgetRefreshWorker>()
          .setInitialDelay(delaySeconds, TimeUnit.SECONDS)
          .setInputData(
            Data.Builder()
              .putString("reason", "$reason-${delaySeconds}s")
              .build(),
          )
          .build()

        workManager.enqueueUniqueWork(
          "$TWA_SESSION_BURST_WORK_PREFIX-$index",
          ExistingWorkPolicy.REPLACE,
          request,
        )
      }

      NanoflowWidgetTelemetry.info(
        "widget_twa_session_refresh_burst_scheduled",
        mapOf(
          "reason" to reason,
          "delaysSeconds" to TWA_SESSION_BURST_DELAYS_SECONDS.joinToString(","),
        ),
      )
    }

    fun scheduleFocusWaitReminder(context: Context, appWidgetId: Int, waitMinutes: Int) {
      val normalizedWait = waitMinutes.coerceAtLeast(1)
      val request = OneTimeWorkRequestBuilder<NanoflowWidgetRefreshWorker>()
        .setInitialDelay(normalizedWait.toLong(), TimeUnit.MINUTES)
        .setInputData(
          Data.Builder()
            .putString("reason", "focus-wait-reminder-${normalizedWait}m")
            .build(),
        )
        .build()

      WorkManager.getInstance(context).enqueueUniqueWork(
        "$FOCUS_WAIT_REMINDER_WORK_PREFIX-$appWidgetId",
        ExistingWorkPolicy.REPLACE,
        request,
      )
      NanoflowWidgetTelemetry.info(
        "widget_focus_wait_reminder_scheduled",
        mapOf(
          "appWidgetId" to appWidgetId,
          "waitMinutes" to normalizedWait,
        ),
      )
    }

    fun scheduleGateReadCooldownRefresh(
      context: Context,
      appWidgetId: Int,
      delayMs: Long = GATE_READ_REAPPEAR_COOLDOWN_MS,
    ) {
      val request = OneTimeWorkRequestBuilder<NanoflowWidgetRefreshWorker>()
        .setInitialDelay(delayMs.coerceAtLeast(0L), TimeUnit.MILLISECONDS)
        .setInputData(
          Data.Builder()
            .putString("reason", "gate-read-cooldown")
            .build(),
        )
        .build()

      WorkManager.getInstance(context).enqueueUniqueWork(
        "$GATE_READ_COOLDOWN_REFRESH_WORK_PREFIX-$appWidgetId",
        ExistingWorkPolicy.REPLACE,
        request,
      )
      NanoflowWidgetTelemetry.info(
        "widget_gate_read_cooldown_refresh_scheduled",
        mapOf(
          "appWidgetId" to appWidgetId,
          "delayMs" to delayMs.coerceAtLeast(0L),
        ),
      )
    }

    fun syncPeriodicRefresh(context: Context, enabled: Boolean) {
      NanoflowWidgetTelemetry.info(
        "widget_periodic_refresh_synced",
        mapOf("enabled" to enabled),
      )
      val workManager = WorkManager.getInstance(context)
      if (!enabled) {
        workManager.cancelUniqueWork(UNIQUE_PERIODIC_WORK_NAME)
        return
      }

      val request = PeriodicWorkRequestBuilder<NanoflowWidgetRefreshWorker>(15, TimeUnit.MINUTES)
        .setInputData(Data.Builder().putString("reason", "periodic-refresh").build())
        .build()

      workManager.enqueueUniquePeriodicWork(
        UNIQUE_PERIODIC_WORK_NAME,
        ExistingPeriodicWorkPolicy.KEEP,
        request,
      )
    }
  }
}
