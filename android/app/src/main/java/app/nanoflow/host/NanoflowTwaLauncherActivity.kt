package app.nanoflow.host

import android.appwidget.AppWidgetManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.SystemClock
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import com.google.androidbrowserhelper.trusted.LauncherActivity
import com.google.androidbrowserhelper.trusted.TwaProviderPicker
import kotlinx.coroutines.runBlocking

class NanoflowTwaLauncherActivity : LauncherActivity() {
  private var cachedLaunchRequest: LaunchRequest? = null
  private var cachedLaunchUri: Uri? = null
  private var splashHoldStartElapsedMs = 0L
  private var isSplashHoldActive = false

  override fun onCreate(savedInstanceState: Bundle?) {
    // 让原生启动窗口和 Web 初始 loader 使用同一套启动面，避免 TWA provider 接管前露出白底窗口。
    // 2026-04-19 深挖补强：久置后 Chrome / CustomTabs service 需要重建 session 时，LauncherActivity
    // 可能会在系统 splash 消退后短暂暴露自己的 windowBackground。这里保留系统 splash，直到
    // handoff 触发 onStop() 或超过保底上限，避免用户把这段空白等待误感知成“白屏卡住”。
    splashHoldStartElapsedMs = SystemClock.elapsedRealtime()
    isSplashHoldActive = true
    installSplashScreen().setKeepOnScreenCondition {
      if (!isSplashHoldActive) {
        return@setKeepOnScreenCondition false
      }

      val elapsedMs = SystemClock.elapsedRealtime() - splashHoldStartElapsedMs
      if (elapsedMs >= LAUNCHER_SPLASH_MAX_HOLD_MS) {
        releaseSplashHold("timeout")
        return@setKeepOnScreenCondition false
      }

      true
    }
    // 2026-04-19 白屏闪退修复：强制向 ABH LauncherActivity 基类传入 null 作为 savedInstanceState。
    // ABH 基类 onCreate 存在以下致命分支：
    //   if (savedInstanceState != null
    //       && savedInstanceState.getBoolean("android.support.customtabs.trusted.BROWSER_WAS_LAUNCHED_KEY")) {
    //       finish();
    //       return;
    //   }
    // 我们的 LauncherActivity 是纯 trampoline（不承载任何需要恢复的 UI 状态），但系统会为
    // Activity 的 task snapshot 自动 onSaveInstanceState；上一次成功 launch 过 Chrome TWA 后
    // mBrowserWasLaunched=true 被写入 state。即使 force-stop 杀进程，ATMS 的 recents task
    // snapshot 仍保留 state Bundle，下次 LAUNCHER intent 进来时系统会把这个 state 喂回来，
    // ABH 基类立刻 finish() → 用户观感 = 点图标白屏闪退、无法进入项目。
    // 传 null 绕过这条恢复路径；LauncherActivity 自己不关心任何恢复的 UI 状态，无副作用。
    super.onCreate(null)
    // TWA Launcher 必须保持纯 trampoline：任何设置页引导都不能插在 launchTwa() 之前，
    // 否则普通桌面图标点击会先露出启动窗口再 finish，用户看到的就是白屏闪退。
    launchFromCurrentIntent()
  }

  override fun onDestroy() {
    releaseSplashHold("activity-destroyed")
    super.onDestroy()
  }

  override fun onStop() {
    releaseSplashHold("activity-stopped")
    super.onStop()
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    resetLaunchCache()
    launchFromCurrentIntent()
  }

  override fun shouldLaunchImmediately(): Boolean = false

  override fun getLaunchingUrl(): Uri {
    return cachedLaunchUri ?: resolveLaunchingUrl().also { uri ->
      cachedLaunchUri = uri
    }
  }

  private fun resolveLaunchingUrl(): Uri {
    val request = resolveLaunchRequest()

    if (request.appWidgetId != AppWidgetManager.INVALID_APPWIDGET_ID) {
      return runBlocking {
        NanoflowWidgetRepository(applicationContext).buildLaunchUri(
          appWidgetId = request.appWidgetId,
          preferredEntrySource = request.entrySource,
          launchIntent = request.launchIntent,
          requestedTaskIndex = request.taskIndex,
          gateEntryId = request.gateEntryId,
        )
      }
    }

    return NanoflowBootstrapContract.buildLaunchUri(
      request.entrySource,
      request.launchIntent,
      bridgeContext = null,
      gateEntryId = request.gateEntryId,
    )
  }

  private fun launchFromCurrentIntent() {
    if (isFinishing) {
      return
    }

    resetReactiveRefreshGateIfNeeded()
    scheduleWidgetRefreshBurstIfNeeded()
    logLaunchStarted()
    launchTwa()
  }

  private fun resetReactiveRefreshGateIfNeeded() {
    val request = resolveLaunchRequest()
    if (request.entrySource != NanoFlowEntrySource.WIDGET) {
      return
    }
    if (request.appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID) {
      return
    }

    NanoflowWidgetReceiver.resetReactiveRefreshGate(
      context = applicationContext,
      reason = "widget-activity-launch",
    )
  }

  private fun scheduleWidgetRefreshBurstIfNeeded() {
    if (!NanoflowWidgetReceiver.hasInstalledWidgets(applicationContext)) {
      return
    }

    val request = resolveLaunchRequest()
    val reason = when (request.entrySource) {
      NanoFlowEntrySource.WIDGET -> "twa-session-from-widget"
      NanoFlowEntrySource.TWA -> "twa-session-from-launcher"
    }
    NanoflowWidgetRefreshWorker.scheduleTwaSessionRefreshBurst(
      context = applicationContext,
      reason = reason,
    )
  }

  private fun resetLaunchCache() {
    cachedLaunchRequest = null
    cachedLaunchUri = null
  }

  private fun releaseSplashHold(reason: String) {
    if (!isSplashHoldActive) {
      return
    }

    if (reason == SPLASH_HOLD_RELEASE_REASON_TIMEOUT) {
      window.setBackgroundDrawableResource(R.drawable.nanoflow_twa_post_splash_timeout)
    }

    isSplashHoldActive = false
    NanoflowWidgetTelemetry.info(
      event = "widget_twa_splash_hold_released",
      fields = mapOf(
        "reason" to reason,
        "elapsedMs" to (SystemClock.elapsedRealtime() - splashHoldStartElapsedMs),
      ),
    )
  }

  private fun logLaunchStarted() {
    val launchUrl = getLaunchingUrl()
    val providerAction = TwaProviderPicker.pickProvider(packageManager)
    val providerLaunchMode = providerLaunchMode(providerAction.launchMode)

    NanoflowWidgetTelemetry.info(
      event = "widget_twa_launch_started",
      fields = buildLaunchTelemetryFields(
        launchUrl = launchUrl,
        providerPackage = providerAction.provider,
        providerLaunchMode = providerLaunchMode,
      ),
    )
  }

  private fun buildLaunchTelemetryFields(
    launchUrl: Uri,
    providerPackage: String?,
    providerLaunchMode: String,
  ): Map<String, Any?> {
    val request = resolveLaunchRequest()

    return mapOf(
      "appWidgetId" to request.appWidgetId.takeUnless { it == AppWidgetManager.INVALID_APPWIDGET_ID },
      "entrySource" to request.entrySource,
      "launchIntent" to request.launchIntent,
      "launchPath" to launchUrl.fragment?.substringBefore('?')?.ifBlank { null },
      "providerLaunchMode" to providerLaunchMode,
      "providerPackage" to providerPackage,
      "widgetLaunch" to (request.appWidgetId != AppWidgetManager.INVALID_APPWIDGET_ID),
    )
  }

  private fun resolveLaunchRequest(): LaunchRequest {
    return cachedLaunchRequest ?: LaunchRequest(
      appWidgetId = intent?.getIntExtra(EXTRA_APP_WIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
        ?: AppWidgetManager.INVALID_APPWIDGET_ID,
      launchIntent = intent?.getStringExtra(EXTRA_LAUNCH_INTENT)
        ?.let { value -> NanoFlowLaunchIntent.entries.find { it.name == value } }
        ?: NanoFlowLaunchIntent.OPEN_WORKSPACE,
      taskIndex = intent?.getIntExtra(NanoflowWidgetReceiver.EXTRA_TASK_INDEX, -1) ?: -1,
      entrySource = intent?.getStringExtra(EXTRA_ENTRY_SOURCE)
        ?.let { value -> NanoFlowEntrySource.entries.find { it.name == value } }
        ?: NanoFlowEntrySource.TWA,
      gateEntryId = intent?.getStringExtra(EXTRA_GATE_ENTRY_ID),
    ).also { request ->
      cachedLaunchRequest = request
    }
  }

  private fun providerLaunchMode(launchMode: Int): String {
    return when (launchMode) {
      TwaProviderPicker.LaunchMode.TRUSTED_WEB_ACTIVITY -> "trusted-web-activity"
      TwaProviderPicker.LaunchMode.CUSTOM_TAB -> "custom-tab"
      TwaProviderPicker.LaunchMode.BROWSER -> "browser"
      else -> "unknown"
    }
  }

  private data class LaunchRequest(
    val appWidgetId: Int,
    val launchIntent: NanoFlowLaunchIntent,
    val taskIndex: Int,
    val entrySource: NanoFlowEntrySource,
    val gateEntryId: String? = null,
  )

  companion object {
    private const val LAUNCHER_SPLASH_MAX_HOLD_MS = 1500L
    private const val SPLASH_HOLD_RELEASE_REASON_TIMEOUT = "timeout"
    private const val EXTRA_APP_WIDGET_ID = "extra.APP_WIDGET_ID"
    private const val EXTRA_LAUNCH_INTENT = "extra.LAUNCH_INTENT"
    private const val EXTRA_ENTRY_SOURCE = "extra.ENTRY_SOURCE"
    private const val EXTRA_GATE_ENTRY_ID = "extra.GATE_ENTRY_ID"

    fun intentForWidget(
      context: Context,
      appWidgetId: Int,
      launchIntent: NanoFlowLaunchIntent,
      taskIndex: Int = -1,
      gateEntryId: String? = null,
    ): Intent {
      return Intent(context, NanoflowTwaLauncherActivity::class.java).apply {
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        putExtra(EXTRA_APP_WIDGET_ID, appWidgetId)
        putExtra(EXTRA_LAUNCH_INTENT, launchIntent.name)
        putExtra(EXTRA_ENTRY_SOURCE, NanoFlowEntrySource.WIDGET.name)
        if (taskIndex >= 0) {
          putExtra(NanoflowWidgetReceiver.EXTRA_TASK_INDEX, taskIndex)
        }
        if (!gateEntryId.isNullOrBlank()) {
          putExtra(EXTRA_GATE_ENTRY_ID, gateEntryId)
        }
      }
    }
  }
}
