/**
 * GoJS Overview 异步路径噪声谓词（共享工具）
 *
 * 背景（2026-05-15 根因修复）：
 * GoJS Overview 内部会在 `ResizeObserver` / `AnimationManager.tick` /
 * `requestAnimationFrame` 等异步入口读取 `observed.documentBounds` /
 * `viewportBounds`。在 Diagram 切换、`@defer` 懒加载、布局首帧等场景下，
 * 这些字段可能尚未就绪并触发：
 *   Uncaught TypeError: Cannot read properties of null (reading 'width')
 *     at pe._getOriginRect (chunk-...)
 *
 * 我们已在 `FlowOverviewService` 主动调用入口加 `isReal()` 守卫，
 * 但 GoJS 自身异步 tick 绕过守卫，会从两路冒泡：
 *   1. `window.onerror` / `unhandledrejection`（main.ts 拦截）
 *   2. Angular ErrorHandler（GlobalErrorHandler.handleError）
 *
 * 本谓词被两路共享，确保「相同噪声两边都识别为静默」，避免一路吞、一路弹 Toast。
 *
 * 命中策略：必须同时满足
 *   - 消息匹配 `Cannot read properties of null (reading 'width')`（兼容 ASCII/Unicode 引号）
 *   - 堆栈包含 `_getOriginRect`（GoJS 内部 Overview 方法名，minified 后仍保留）
 * 双约束让命中面极窄，几乎不可能误吞其他异常。
 */

const NULL_WIDTH_PATTERN = /Cannot read properties of null \(reading [\u2018\u2019'"]width[\u2018\u2019'"]\)/i;
const ORIGIN_RECT_PATTERN = /_getOriginRect/;

/**
 * 判断是否为 GoJS Overview `_getOriginRect` 异步噪声。
 *
 * @param message 错误消息（来自 Error.message / ErrorEvent.message / String(reason)）
 * @param stack 错误堆栈（来自 Error.stack / ErrorEvent.error?.stack / reason?.stack）
 * @returns true 表示命中已知噪声，调用方应静默处理
 */
export function isGojsOverviewOriginRectNoise(
  message: string | null | undefined,
  stack: string | null | undefined,
): boolean {
  if (!message || typeof message !== 'string') return false;
  if (!stack || typeof stack !== 'string') return false;
  return NULL_WIDTH_PATTERN.test(message) && ORIGIN_RECT_PATTERN.test(stack);
}

/**
 * 从任意 unknown 错误对象中尽力提取堆栈字符串。
 *
 * 兼容：
 *   - Error / TypeError 实例 → `error.stack`
 *   - ErrorEvent（来自 window.onerror 包装）→ `error.error?.stack`
 *   - PromiseRejectionEvent.reason 为字符串/对象 → `reason.stack`
 *   - 已经是字符串 → 原样返回
 */
export function extractErrorStack(error: unknown): string | undefined {
  if (typeof error === 'string') return error;
  if (!error || typeof error !== 'object') return undefined;

  // 直接 stack
  const direct = (error as { stack?: unknown }).stack;
  if (typeof direct === 'string' && direct.length > 0) return direct;

  // ErrorEvent.error.stack
  const nestedError = (error as { error?: unknown }).error;
  if (nestedError && typeof nestedError === 'object') {
    const nestedStack = (nestedError as { stack?: unknown }).stack;
    if (typeof nestedStack === 'string' && nestedStack.length > 0) return nestedStack;
  }

  // PromiseRejectionEvent.reason.stack
  const reason = (error as { reason?: unknown }).reason;
  if (reason && typeof reason === 'object') {
    const reasonStack = (reason as { stack?: unknown }).stack;
    if (typeof reasonStack === 'string' && reasonStack.length > 0) return reasonStack;
  }

  return undefined;
}

/**
 * 从任意 unknown 错误对象中尽力提取消息字符串。
 *
 * 与 `extractErrorStack` 互补，但 GlobalErrorHandler 已有同等 `extractErrorMessage`，
 * 这里仅供 main.ts 在 Angular bootstrap 前的窗口使用。
 */
export function extractErrorMessageLoose(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
    const nested = (error as { error?: { message?: unknown } }).error;
    if (nested && typeof nested === 'object') {
      const nestedMsg = nested.message;
      if (typeof nestedMsg === 'string') return nestedMsg;
    }
    const reason = (error as { reason?: unknown }).reason;
    if (typeof reason === 'string') return reason;
    if (reason && typeof reason === 'object') {
      const reasonMsg = (reason as { message?: unknown }).message;
      if (typeof reasonMsg === 'string') return reasonMsg;
    }
  }
  return String(error ?? '');
}
