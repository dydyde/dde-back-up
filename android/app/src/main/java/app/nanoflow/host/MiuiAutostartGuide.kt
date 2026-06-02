package app.nanoflow.host

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.os.Build
import android.widget.Toast

/**
 * 【2026-04-23 根因修复】MIUI / HyperOS 在用户每次重装 / 升级 APK 时，都会把应用的
 * 自启动权限（op 10008）静默清零为 ignore。一旦 autostart=ignore：
 *   * GreezeManager 会在 3 秒内把进程 freeze 到 adj=900（cached empty）状态
 *   * 所有来自 AppWidgetHost 的 broadcast（已读 / 完成 / 点击等）会被系统队列吞掉，
 *     BroadcastReceiver.onReceive 根本不会执行
 *   * 用户点击 widget 按钮无任何反馈；widget 也不再接收 FCM dirty push 刷新
 *
 * 因为 Android 普通应用不能直接修改 AppOps（只有 system/root 可以），这里采用"发现 + 引导"
 * 策略：
 *   1. 检测 `Build.MANUFACTURER == "Xiaomi"` / "Redmi" 判定 MIUI-like ROM
 *   2. 记录"上一次已引导的 versionCode"；versionCode 变化（= 用户刚重装或升级）时触发引导
 *   3. 弹一次 Toast 说明原因，并尝试 3 条已知的 MIUI 自启 Activity deep-link：
 *      - com.miui.securitycenter/com.miui.permcenter.autostart.AutoStartManagementActivity （最稳定）
 *      - miui.intent.action.OP_AUTO_START
 *      - 应用详情页（最终兜底）
 *   4. 用户关闭 / 确认后，把当前 versionCode 写回 prefs。下次升级前不会再打扰。
 *
 * 非 MIUI 设备（比如 Pixel、三星等）整条路径走 no-op，不影响正常启动时延。
 */
object MiuiAutostartGuide {

  private const val PREFS_NAME = "nanoflow_autostart_guide"
  private const val KEY_LAST_PROMPTED_VERSION_CODE = "last_prompted_version_code"

  /**
   * 只能由明确的自启动修复入口调用，不能放进 NanoflowTwaLauncherActivity 的主启动链路。
   * TWA Launcher 是纯 trampoline；在 launchTwa() 前拉起设置页并 finish
   * 会让桌面图标启动退化为白屏闪退。内部自带"每版本只引导一次"节流。
   */
  fun maybePromptOnLaunch(context: Context): Boolean {
    if (!isMiuiLikeDevice()) {
      return false
    }

    if (!NanoflowWidgetReceiver.hasInstalledWidgets(context)) {
      return false
    }

    val currentVersionCode = resolveVersionCode(context) ?: return false
    val prefs = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    val lastPromptedVersionCode = prefs.getLong(KEY_LAST_PROMPTED_VERSION_CODE, -1L)

    if (lastPromptedVersionCode == currentVersionCode) {
      // 本版本已引导过，不再打扰。
      return false
    }

    NanoflowWidgetTelemetry.info(
      "widget_miui_autostart_prompt_shown",
      mapOf(
        "manufacturer" to Build.MANUFACTURER,
        "lastPromptedVersionCode" to lastPromptedVersionCode,
        "currentVersionCode" to currentVersionCode,
      ),
    )

    Toast.makeText(
      context.applicationContext,
      context.getString(R.string.nanoflow_widget_autostart_guide_toast),
      Toast.LENGTH_LONG,
    ).show()

    val launched = tryLaunchAutostartSettings(context)

    // 不管 deep-link 是否成功，都先记账；避免 deep-link 因 ROM 差异反复失败时每次启动都弹 Toast。
    // 若 deep-link 全部失败，用户仍然被 Toast 提示过"请去 MIUI 设置打开自启"，手动查找亦可。
    prefs.edit().putLong(KEY_LAST_PROMPTED_VERSION_CODE, currentVersionCode).apply()

    NanoflowWidgetTelemetry.info(
      "widget_miui_autostart_prompt_completed",
      mapOf(
        "launched" to launched,
        "currentVersionCode" to currentVersionCode,
      ),
    )

    return launched
  }

  private fun isMiuiLikeDevice(): Boolean {
    val manufacturer = Build.MANUFACTURER?.lowercase().orEmpty()
    val brand = Build.BRAND?.lowercase().orEmpty()
    return manufacturer == "xiaomi" ||
      manufacturer == "redmi" ||
      brand == "xiaomi" ||
      brand == "redmi" ||
      brand == "poco"
  }

  private fun resolveVersionCode(context: Context): Long? {
    return runCatching {
      val pm: PackageManager = context.packageManager
      val info: PackageInfo = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        pm.getPackageInfo(context.packageName, PackageManager.PackageInfoFlags.of(0))
      } else {
        @Suppress("DEPRECATION")
        pm.getPackageInfo(context.packageName, 0)
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        info.longVersionCode
      } else {
        @Suppress("DEPRECATION")
        info.versionCode.toLong()
      }
    }.getOrNull()
  }

  /**
   * 尝试三条已知 MIUI 深链。任何一条成功立即返回 true；全部失败时返回 false 但不抛异常。
   */
  private fun tryLaunchAutostartSettings(context: Context): Boolean {
    val candidates = listOf(
      {
        Intent().apply {
          component = ComponentName(
            "com.miui.securitycenter",
            "com.miui.permcenter.autostart.AutoStartManagementActivity",
          )
          flags = Intent.FLAG_ACTIVITY_NEW_TASK
        }
      },
      {
        Intent("miui.intent.action.OP_AUTO_START").apply {
          addCategory(Intent.CATEGORY_DEFAULT)
          flags = Intent.FLAG_ACTIVITY_NEW_TASK
        }
      },
      {
        Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
          data = android.net.Uri.parse("package:${context.packageName}")
          flags = Intent.FLAG_ACTIVITY_NEW_TASK
        }
      },
    )

    for (build in candidates) {
      val intent = runCatching { build() }.getOrNull() ?: continue
      val launched = runCatching {
        context.applicationContext.startActivity(intent)
        true
      }.getOrElse { false }
      if (launched) {
        return true
      }
    }
    return false
  }
}
