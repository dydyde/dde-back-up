// ============================================
// 应用生命周期恢复配置
// 用于 PWA 前后台切换恢复、自愈与更新提示
// ============================================

/**
 * 应用生命周期恢复配置
 */
export const APP_LIFECYCLE_CONFIG = {
  /**
   * 恢复场景首交互预算（毫秒）
   * 目标：恢复后 150ms 内可编辑
   */
  RESUME_INTERACTION_BUDGET_MS: 150,

  /**
   * 恢复场景远端新鲜度 SLA（毫秒）
   * 目标：10 秒内补齐远端变更
   */
  RESUME_FRESHNESS_SLA_MS: 10 * 1000,

  /**
   * 进入重恢复流程的后台停留阈值（毫秒）
   * 小于该阈值仅执行轻量检查
   */
  RESUME_THRESHOLD_MS: 60 * 1000,

  /**
   * 单次恢复流程超时（毫秒）
   * 超时后降级并保持 UI 可操作
   */
  RESUME_TIMEOUT_MS: 10 * 1000,

  /**
   * 后台停留超过该阈值且检测到新版本时，优先提示刷新（毫秒）
   */
  NEW_VERSION_PROMPT_THRESHOLD_MS: 15 * 60 * 1000,

  /**
   * Service Worker 注册完成后的首次主动版本检查延迟（毫秒）
   */
  SW_UPDATE_INITIAL_CHECK_DELAY_MS: 10 * 1000,

  /**
   * 页面保持前台时的版本检查间隔（毫秒）
   */
  SW_UPDATE_VISIBLE_POLL_INTERVAL_MS: 5 * 60 * 1000,

  /**
   * visibility/focus/online 连续触发时的版本检查冷却窗口（毫秒）
   */
  SW_UPDATE_RESUME_CHECK_COOLDOWN_MS: 60 * 1000,

  /**
   * 恢复场景下黑匣子拉取冷却时间（毫秒）
   */
  RESUME_PULL_COOLDOWN_MS: 10 * 1000,

  /**
   * heavy 恢复冷却窗口（毫秒）
   * visibility/focus/online 连续触发时用于去重
   */
  RESUME_HEAVY_COOLDOWN_MS: 15 * 1000,

  /**
   * heavy 恢复后抑制 pulse 的窗口（毫秒）
   */
  PULSE_SUPPRESS_AFTER_HEAVY_MS: 15 * 1000,

  /**
   * 恢复时重试队列单次处理切片上限
   */
  RESUME_RETRY_SLICE_MAX_ITEMS: 30,

  /**
   * 每日自动刷新上限
   * 用于恢复链路连续失败时的受控兜底
   */
  MAX_AUTO_RELOAD_PER_DAY: 1,

  /**
   * 连续失败阈值：达到后触发受控刷新兜底
   *
   * 重要：仅统计 resume pipeline 抛出的运行时异常；会话状态失败（no-session /
   * refresh-failed）不计入，因为 reload 不修复 session 状态，强刷只会破坏用户当前 UI。
   * 会话失败由 SessionManager 自身的断路 + "登录已过期" toast 处理。
   */
  AUTO_RELOAD_FAILURE_THRESHOLD: 2,
} as const;
