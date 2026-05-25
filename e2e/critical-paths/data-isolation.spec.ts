/**
 * 数据隔离与保护 E2E 测试
 *
 * 从 data-protection.spec.ts 精简合并，保留当前仍适合 E2E 的会话边界与本地隔离场景。
 */
import { test, expect, Page } from '@playwright/test';
import { testHelpers } from './helpers';

// ============================================================================
// 轻量辅助（仅本文件使用的简洁版本，不重复 helpers.ts）
// ============================================================================

async function createTaskQuick(page: Page, title: string): Promise<void> {
  await testHelpers.ensureEditorReady(page, { mode: 'local' });
  await testHelpers.createTask(page, title);
}

// ============================================================================
// 测试组：访客数据隔离
// ============================================================================

test.describe('数据隔离：访客会话', () => {
  test('不同访客上下文数据应完全隔离', async ({ browser }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    try {
      await pageA.goto('/');
      await testHelpers.waitForAppReady(pageA);
      await testHelpers.ensureEditorReady(pageA, { mode: 'local' });

      const taskTitleA = `用户A任务-${testHelpers.uniqueId()}`;
      await createTaskQuick(pageA, taskTitleA);

      await pageB.goto('/');
      await testHelpers.waitForAppReady(pageB);
      await testHelpers.ensureEditorReady(pageB, { mode: 'local' });

      // 用户 B 不应看到用户 A 的任务
      await expect(
        pageB.locator(`[data-testid="task-card"]:has-text("${taskTitleA}")`)
      ).not.toBeVisible({ timeout: 3000 });
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });
});

// ============================================================================
// 测试组：RetryQueue
// ============================================================================

test.describe('数据隔离：RetryQueue 机制', () => {
  test('离线操作应进入重试队列并在恢复后清空', async ({ page, context }) => {
    await page.goto('/');
    await testHelpers.waitForAppReady(page);
    await testHelpers.ensureEditorReady(page, { mode: 'local' });

    await testHelpers.setOffline(page, context, true);
    await testHelpers.waitForOfflineIndicator(page);

    const taskTitle = `重试队列-${testHelpers.uniqueId()}`;
    await createTaskQuick(page, taskTitle);

    // 验证任务本地可见
    await expect(
      page.locator(`[data-testid="task-card"]:has-text("${taskTitle}")`)
    ).toBeVisible({ timeout: 5000 });

    await testHelpers.setOffline(page, context, false);
    await testHelpers.waitForSyncSettled(page, { timeout: 15_000 });

    // 等待同步完成（观测同步指示器或轮询 RetryQueue 清空）
    await expect(async () => {
      const queueEmpty = await page.evaluate(() => {
        const queue = localStorage.getItem('nanoflow.retry-queue');
        return !queue || queue === '[]';
      });
      expect(queueEmpty).toBe(true);
    }).toPass({ timeout: 15000 });

    // 任务仍然可见
    await expect(
      page.locator(`[data-testid="task-card"]:has-text("${taskTitle}")`)
    ).toBeVisible();
  });

  test('离线待同步数据不应泄漏到新的访客上下文', async ({ browser }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    try {
      await pageA.goto('/');
      await testHelpers.waitForAppReady(pageA);
      await testHelpers.ensureEditorReady(pageA, { mode: 'local' });
      await testHelpers.setOffline(pageA, contextA, true);
      await testHelpers.waitForOfflineIndicator(pageA);

      const offlineTitle = `隔离离线-${testHelpers.uniqueId()}`;
      await createTaskQuick(pageA, offlineTitle);
      await expect(pageA.locator(`[data-testid="task-card"]:has-text("${offlineTitle}")`)).toBeVisible({ timeout: 5_000 });

      await pageB.goto('/');
      await testHelpers.waitForAppReady(pageB);
      await testHelpers.ensureEditorReady(pageB, { mode: 'local' });
      await expect(pageB.locator(`[data-testid="task-card"]:has-text("${offlineTitle}")`)).not.toBeVisible({ timeout: 3_000 });
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });
});
