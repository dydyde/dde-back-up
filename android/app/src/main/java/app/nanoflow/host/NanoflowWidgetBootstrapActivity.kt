package app.nanoflow.host

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.widget.Toast
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

class NanoflowWidgetBootstrapActivity : Activity() {
  private val bootstrapScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
  private var inlineRefreshJob: Job? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    handleBootstrapIntent(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    handleBootstrapIntent(intent)
  }

  override fun onDestroy() {
    inlineRefreshJob?.cancel()
    bootstrapScope.cancel()
    super.onDestroy()
  }

  private fun handleBootstrapIntent(intent: Intent?) {
    inlineRefreshJob?.cancel()
    val repository = NanoflowWidgetRepository(applicationContext)
    val accepted = runBlocking {
      repository.consumeBootstrapUri(intent?.data)
    }
    if (accepted) {
      NanoflowWidgetRefreshWorker.syncPeriodicRefresh(
        applicationContext,
        enabled = NanoflowWidgetReceiver.hasInstalledWidgets(applicationContext),
      )
      refreshAfterBootstrap(repository)
    } else {
      showBootstrapToast(R.string.nanoflow_widget_bootstrap_failed_toast)
      finish()
    }
  }

  private fun refreshAfterBootstrap(repository: NanoflowWidgetRepository) {
    inlineRefreshJob = bootstrapScope.launch {
      var shouldCompleteAcceptedCallback = true
      try {
        NanoflowWidgetTelemetry.info(
          "widget_bootstrap_inline_refresh_started",
          mapOf("timeoutMs" to BOOTSTRAP_INLINE_REFRESH_TIMEOUT_MS),
        )
        val completed = withTimeoutOrNull(BOOTSTRAP_INLINE_REFRESH_TIMEOUT_MS) {
          refreshInstalledWidgetsInline(repository)
          true
        }
        if (completed == true) {
          NanoflowWidgetTelemetry.info("widget_bootstrap_inline_refresh_succeeded")
        } else {
          NanoflowWidgetTelemetry.warn(
            "widget_bootstrap_inline_refresh_timed_out",
            mapOf("timeoutMs" to BOOTSTRAP_INLINE_REFRESH_TIMEOUT_MS),
          )
          showBootstrapToast(R.string.nanoflow_widget_bootstrap_refresh_delayed_toast)
        }
      } catch (error: CancellationException) {
        shouldCompleteAcceptedCallback = false
        throw error
      } catch (error: Throwable) {
        NanoflowWidgetTelemetry.warn(
          "widget_bootstrap_inline_refresh_failed",
          mapOf("errorClass" to (error::class.simpleName ?: "unknown")),
          error,
        )
        showBootstrapToast(R.string.nanoflow_widget_bootstrap_refresh_delayed_toast)
      } finally {
        if (shouldCompleteAcceptedCallback && !isFinishing) {
          enqueueBootstrapFollowUp()
          returnToWidgetHostSurface()
          finish()
        }
      }
    }
  }

  private suspend fun refreshInstalledWidgetsInline(repository: NanoflowWidgetRepository) {
    withContext(Dispatchers.IO) {
      repository.refreshInstalledWidgets()
      NanoflowWidgetReceiver.refreshAllWidgets(applicationContext)
    }
  }

  private fun showBootstrapToast(messageResId: Int) {
    Toast.makeText(applicationContext, getString(messageResId), Toast.LENGTH_SHORT).show()
  }

  private fun enqueueBootstrapFollowUp() {
    runCatching {
      NanoflowWidgetRefreshWorker.enqueue(applicationContext, reason = "bootstrap-callback-followup")
    }.onFailure { error ->
      NanoflowWidgetTelemetry.warn(
        "widget_bootstrap_followup_enqueue_failed",
        mapOf("errorClass" to (error::class.simpleName ?: "unknown")),
        error,
      )
    }
  }

  private fun returnToWidgetHostSurface() {
    val homeIntent = Intent(Intent.ACTION_MAIN).apply {
      addCategory(Intent.CATEGORY_HOME)
      flags = Intent.FLAG_ACTIVITY_NEW_TASK
    }

    try {
      startActivity(homeIntent)
      NanoflowWidgetTelemetry.info("widget_bootstrap_return_home_started")
    } catch (error: RuntimeException) {
      NanoflowWidgetTelemetry.warn(
        "widget_bootstrap_return_home_failed",
        mapOf("errorClass" to error.javaClass.simpleName),
        error,
      )
    }
  }

  companion object {
    private const val BOOTSTRAP_INLINE_REFRESH_TIMEOUT_MS = 10_000L
  }
}
