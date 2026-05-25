import { test, expect, Locator, Page } from '@playwright/test';
import { testHelpers } from './helpers';

async function isStageExpanded(stage: Locator): Promise<boolean> {
  const taskList = stage.locator('[data-stage-task-list]').first();
  return taskList.evaluate((element: HTMLElement) => {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return element.getAttribute('aria-hidden') !== 'true'
      && style.pointerEvents !== 'none'
      && style.opacity !== '0'
      && rect.height > 4;
  }).catch(() => false);
}

async function expandStageWithTasks(page: Page): Promise<Locator> {
  const stages = page.locator('[data-stage-number]');
  const count = await stages.count();

  for (let index = 0; index < count; index += 1) {
    const stage = stages.nth(index);
    const taskCard = stage.locator('[data-testid="task-card"]').first();
    if ((await taskCard.isVisible().catch(() => false)) && await isStageExpanded(stage)) {
      return stage;
    }

    await stage.locator('header').first().click();
    await expect.poll(async () => await isStageExpanded(stage), {
      timeout: 2_000,
      intervals: [100, 200, 300],
    }).toBe(true);
    if (await taskCard.isVisible().catch(() => false)) {
      return stage;
    }
  }

  throw new Error('未找到可展开的阶段任务卡');
}

test.describe('文本视图预览切编辑', () => {
  test('点击预览态标题不应频闪或瞬间收起', async ({ page }) => {
    await page.goto('/');
    await testHelpers.waitForAppReady(page);
    await testHelpers.ensureEditorReady(page, { mode: 'local' });

    const textViewTab = page.locator('[data-testid="text-view-tab"]');
    if (await textViewTab.isVisible().catch(() => false)) {
      await textViewTab.click();
    }

    const stage = await expandStageWithTasks(page);
    const taskCard = stage.locator('[data-testid="task-card"]').first();
    const collapsedTitle = taskCard.locator('[data-testid="task-title-label"]').first();
    const originalTitle = ((await collapsedTitle.textContent()) || '').trim();

    await expect(taskCard).toBeVisible({ timeout: 5_000 });
    await taskCard.click();

    const titlePreview = taskCard.locator('[data-testid="task-title-preview"]').first();
    await expect(titlePreview).toBeVisible({ timeout: 5_000 });

    await titlePreview.click();

    const titleInput = taskCard.locator('[data-testid="task-title-input"]').first();
    const contentEditor = taskCard.locator('[data-testid="task-content-editor"]').first();

    await expect(titleInput).toBeVisible({ timeout: 5_000 });
    await expect(titleInput).toBeFocused({ timeout: 5_000 });
    await expect(titleInput).toHaveValue(originalTitle);
    await expect(contentEditor).toBeVisible({ timeout: 5_000 });
    await expect.poll(async () => await titleInput.isVisible(), {
      timeout: 1_200,
      intervals: [100, 200, 300],
    }).toBe(true);

    const outsideButton = page.getByRole('button', { name: '详情' }).first();
    await expect(outsideButton).toBeVisible({ timeout: 5_000 });
    await outsideButton.click();

    await expect(taskCard.locator('[data-testid="task-title-input"]')).toHaveCount(0, { timeout: 5_000 });
  });

  test('点击非空内容预览区也应稳定进入编辑态', async ({ page }) => {
    await page.goto('/');
    await testHelpers.waitForAppReady(page);
    await testHelpers.ensureEditorReady(page, { mode: 'local' });

    const textViewTab = page.locator('[data-testid="text-view-tab"]');
    if (await textViewTab.isVisible().catch(() => false)) {
      await textViewTab.click();
    }

    const stage = await expandStageWithTasks(page);
    const taskCard = stage.locator('[data-testid="task-card"]').first();

    await expect(taskCard).toBeVisible({ timeout: 5_000 });
    await taskCard.click();

    const contentPreview = taskCard.locator('[data-testid="task-content"]').first();
    await expect(contentPreview).toBeVisible({ timeout: 5_000 });

    await contentPreview.click();

    const titleInput = taskCard.locator('[data-testid="task-title-input"]').first();
    const contentEditor = taskCard.locator('[data-testid="task-content-editor"]').first();

    await expect(titleInput).toBeVisible({ timeout: 5_000 });
    await expect(contentEditor).toBeVisible({ timeout: 5_000 });
    await expect.poll(async () => await contentEditor.isVisible(), {
      timeout: 1_200,
      intervals: [100, 200, 300],
    }).toBe(true);
  });
});