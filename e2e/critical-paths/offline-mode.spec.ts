/**
 * 关键路径 5: 离线同步和数据保护 + 数据导入导出
 *
 * 从 critical-paths.spec.ts 拆分
 */
import { test, expect, Page } from '@playwright/test';
import { testHelpers, createdTestData } from './helpers';

interface CapturedExportState {
  suggestedName: string | null;
  content: string | null;
}

async function stubFilePickerExport(page: Page): Promise<void> {
  await page.evaluate(() => {
    const capture = {
      suggestedName: null as string | null,
      content: null as string | null,
    };

    (window as Window & { __copilotExportCapture?: typeof capture }).__copilotExportCapture = capture;

    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      writable: true,
      value: async ({ suggestedName }: { suggestedName?: string }) => ({
        name: suggestedName ?? 'nanoflow-backup.json',
        async createWritable() {
          return {
            async write(blob: Blob) {
              capture.suggestedName = suggestedName ?? 'nanoflow-backup.json';
              capture.content = await blob.text();
            },
            async close() {
              return undefined;
            },
          };
        },
      }),
    });
  });
}

async function readCapturedExport(page: Page): Promise<CapturedExportState> {
  return page.evaluate(() => {
    return (window as Window & { __copilotExportCapture?: CapturedExportState }).__copilotExportCapture ?? {
      suggestedName: null,
      content: null,
    };
  });
}

test.describe('关键路径 5: 离线同步和数据保护', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await testHelpers.waitForAppReady(page);
    await testHelpers.ensureEditorReady(page, { mode: 'local' });
  });

  test('离线编辑后联网同步应保留数据', async ({ page, context }) => {
    const taskTitle = `离线测试-${testHelpers.uniqueId()}`;
    const offlineUpdate = `${taskTitle}-离线更新`;
    testHelpers.trackTaskTitle(taskTitle);
    testHelpers.trackTaskTitle(offlineUpdate);

    await testHelpers.createTask(page, taskTitle);

    await testHelpers.setOffline(page, context, true);
    await testHelpers.waitForOfflineIndicator(page);

    const editInput = await testHelpers.openTaskTitleEditor(page, taskTitle);
    await editInput.fill(offlineUpdate);
    await editInput.blur();

    await testHelpers.setOffline(page, context, false);
    await testHelpers.waitForSyncSettled(page, { timeout: 20_000 });

    await page.reload();
    await testHelpers.waitForAppReady(page);
    await testHelpers.ensureEditorReady(page, { mode: 'local' });
    await expect(page.locator(`[data-testid="task-card"]:has-text("${offlineUpdate}")`).first()).toBeVisible({ timeout: 10_000 });
  });

  test('页面加载后数据完整性检查不应误报', async ({ page }) => {
    const taskTitle = `完整性测试-${testHelpers.uniqueId()}`;
    testHelpers.trackTaskTitle(taskTitle);

    await testHelpers.createTask(page, taskTitle);

    await page.reload();
    await testHelpers.waitForAppReady(page);
    await testHelpers.ensureEditorReady(page, { mode: 'local' });

    await expect(page.locator('[data-testid="integrity-error-toast"]').first()).not.toBeVisible({ timeout: 5_000 });
    await expect(page.locator(`[data-testid="task-card"]:has-text("${taskTitle}")`).first()).toBeVisible({ timeout: 5_000 });
  });

  test('连续离线恢复后同步状态仍应可用', async ({ page, context }) => {
    const taskTitle = `网络抖动-${testHelpers.uniqueId()}`;
    testHelpers.trackTaskTitle(taskTitle);

    await testHelpers.createTask(page, taskTitle);

    for (let i = 0; i < 3; i++) {
      await testHelpers.setOffline(page, context, true);
      await testHelpers.waitForOfflineIndicator(page);
      await testHelpers.setOffline(page, context, false);
      await testHelpers.waitForSyncSettled(page, { timeout: 10_000 });
    }

    await expect(page.locator('[data-testid="sync-status-indicator"]').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(`[data-testid="task-card"]:has-text("${taskTitle}")`).first()).toBeVisible({ timeout: 5_000 });
  });

  test('切换离线后应继续显示当前本地数据', async ({ page, context }) => {
    const taskTitle = `本地优先-${testHelpers.uniqueId()}`;
    testHelpers.trackTaskTitle(taskTitle);

    await testHelpers.createTask(page, taskTitle);

    await testHelpers.setOffline(page, context, true);
    await testHelpers.waitForOfflineIndicator(page);

    const titleInput = await testHelpers.openTaskTitleEditor(page, taskTitle);
    await expect(titleInput).toHaveValue(taskTitle);

    await testHelpers.setOffline(page, context, false);
    await testHelpers.waitForSyncSettled(page);
  });
});

test.describe('数据导入导出', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await testHelpers.waitForAppReady(page);
    await testHelpers.ensureEditorReady(page, { mode: 'local' });
  });

  test('应能从设置页面导出数据', async ({ page }) => {
    const taskTitle = `导出测试-${testHelpers.uniqueId()}`;
    testHelpers.trackTaskTitle(taskTitle);

    await testHelpers.createTask(page, taskTitle);
    await stubFilePickerExport(page);
    await testHelpers.openSettings(page);

    await page.locator('[data-testid="settings-export-button"]').first().click();

    await expect.poll(async () => (await readCapturedExport(page)).content, { timeout: 10_000 }).not.toBeNull();
    const capture = await readCapturedExport(page);
    expect(capture.suggestedName).toMatch(/nanoflow-backup.*\.json$/);
  });

  test('导入无效文件应显示错误', async ({ page }) => {
    await testHelpers.openSettings(page);

    const dialogPromise = page.waitForEvent('dialog', { timeout: 10_000 });
    await page.locator('[data-testid="settings-import-input"]').setInputFiles({
      name: 'invalid.json',
      mimeType: 'application/json',
      buffer: Buffer.from('this is not valid json'),
    });

    const dialog = await dialogPromise;
    expect(dialog.message()).toContain('导入失败');
    await dialog.dismiss();
  });

  test('导出的 JSON 应包含正确的数据结构', async ({ page }) => {
    const taskTitle = `结构验证-${testHelpers.uniqueId()}`;
    testHelpers.trackTaskTitle(taskTitle);

    await testHelpers.createTask(page, taskTitle);
    await stubFilePickerExport(page);
    await testHelpers.openSettings(page);

    await page.locator('[data-testid="settings-export-button"]').first().click();

    await expect.poll(async () => (await readCapturedExport(page)).content, { timeout: 10_000 }).not.toBeNull();
    const capture = await readCapturedExport(page);
    const data = JSON.parse(capture.content ?? '{}') as {
      metadata?: Record<string, unknown>;
      projects?: unknown[];
    };

    expect(data).toHaveProperty('metadata');
    expect(data).toHaveProperty('projects');
    expect(data.metadata).toHaveProperty('version');
    expect(data.metadata).toHaveProperty('exportedAt');
    expect(data.metadata).toHaveProperty('checksum');
    expect(Array.isArray(data.projects)).toBe(true);
  });

  test('导出时应反馈正在处理或直接产出文件', async ({ page }) => {
    for (let i = 0; i < 3; i++) {
      const taskTitle = `进度测试-${i}-${testHelpers.uniqueId()}`;
      testHelpers.trackTaskTitle(taskTitle);
      await testHelpers.createTask(page, taskTitle);
    }

    await stubFilePickerExport(page);
    await testHelpers.openSettings(page);

    const exportButton = page.locator('[data-testid="settings-export-button"]').first();
    const spinnerPromise = exportButton
      .locator('.animate-spin')
      .waitFor({ state: 'visible', timeout: 1_500 })
      .then(() => true)
      .catch(() => false);

    await exportButton.click();

    const spinnerVisible = await spinnerPromise;
    await expect.poll(async () => (await readCapturedExport(page)).content, { timeout: 10_000 }).not.toBeNull();
    const capture = await readCapturedExport(page);
    expect(spinnerVisible || !!capture.content).toBe(true);
  });
});

test.afterEach(async () => {
  createdTestData.taskTitles.clear();
  createdTestData.projectIds.clear();
});

test.afterAll(async () => {
  createdTestData.projectIds.clear();
  createdTestData.taskTitles.clear();
});
