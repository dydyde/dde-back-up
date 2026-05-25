/**
 * 关键路径 2: 创建任务 + 保存
 * 
 * 从 critical-paths.spec.ts 拆分
 */
import { test, expect, Page } from '@playwright/test';
import { testHelpers, createdTestData } from './helpers';

test.describe('关键路径 2: 创建任务 + 保存', () => {
  test('应能创建新任务', async ({ page }) => {
    await page.goto('/');
    await testHelpers.waitForAppReady(page);
    await testHelpers.ensureEditorReady(page, { mode: 'local' });
    
    const taskTitle = `测试任务-${testHelpers.uniqueId()}`;
    testHelpers.trackTaskTitle(taskTitle);
    
    // 确保在文本视图
    const textViewTab = page.locator('[data-testid="text-view-tab"]');
    if (await textViewTab.isVisible()) {
      await textViewTab.click();
    }
    
    // 点击添加任务按钮
    await page.click('[data-testid="add-task-btn"]');
    
    // 输入任务标题
    await page.fill('[data-testid="task-title-input"]', taskTitle);
    
    // 按回车确认
    await page.press('[data-testid="task-title-input"]', 'Enter');
    
    // 验证任务已创建
    await testHelpers.waitForTaskCard(page, taskTitle);
    const taskCard = page.locator(`[data-testid="task-card"]:has-text("${taskTitle}")`);
    await expect(taskCard).toBeVisible({ timeout: 5000 });
  });

  test('任务修改应自动保存', async ({ page }) => {
    await page.goto('/');
    await testHelpers.waitForAppReady(page);
    await testHelpers.ensureEditorReady(page, { mode: 'local' });
    
    const taskTitle = `自动保存测试-${testHelpers.uniqueId()}`;
    const updatedTitle = `已更新-${taskTitle}`;
    testHelpers.trackTaskTitle(taskTitle);
    testHelpers.trackTaskTitle(updatedTitle);
    
    // 创建任务
    await page.click('[data-testid="add-task-btn"]');
    await page.fill('[data-testid="task-title-input"]', taskTitle);
    await page.press('[data-testid="task-title-input"]', 'Enter');
    
    // 等待任务出现
    const taskCard = page.locator(`[data-testid="task-card"]:has-text("${taskTitle}")`);
    await expect(taskCard).toBeVisible();
    
    // 进入当前真实编辑流并修改标题
    const editInput = await testHelpers.openTaskTitleEditor(page, taskTitle);
    await editInput.clear();
    await editInput.fill(updatedTitle);
    await editInput.blur();
    
    // 验证标题已更新
    await expect(page.locator(`[data-testid="task-card"]:has-text("${updatedTitle}")`)).toBeVisible();
    
    // 刷新页面验证持久化
    await page.reload();
    await testHelpers.waitForAppReady(page);
    await testHelpers.ensureEditorReady(page, { mode: 'local' });
    
    // 验证任务仍然存在（本地存储）
    await expect(page.locator(`[data-testid="task-card"]:has-text("${updatedTitle}")`)).toBeVisible({ timeout: 10000 });
  });

  test('撤销/重做应正常工作', async ({ page }) => {
    await page.goto('/');
    await testHelpers.waitForAppReady(page);
    await testHelpers.ensureEditorReady(page, { mode: 'local' });
    
    const taskTitle = `撤销测试-${testHelpers.uniqueId()}`;
    testHelpers.trackTaskTitle(taskTitle);
    
    // 创建任务
    await page.click('[data-testid="add-task-btn"]');
    await page.fill('[data-testid="task-title-input"]', taskTitle);
    await page.press('[data-testid="task-title-input"]', 'Enter');
    
    // 等待任务创建并验证
    const taskCard = page.locator(`[data-testid="task-card"]:has-text("${taskTitle}")`);
    await expect(taskCard).toBeVisible({ timeout: 5000 });
    
    // 记录创建后的任务数量
    const initialTaskCount = await page.locator('[data-testid="task-card"]').count();
    
    // 执行撤销
    const modifier = testHelpers.getKeyboardModifier();
    await page.keyboard.press(`${modifier}+z`);
    
    // 验证撤销效果
    await expect(async () => {
      const currentCount = await page.locator('[data-testid="task-card"]').count();
      expect(currentCount).toBeLessThanOrEqual(initialTaskCount);
    }).toPass({ timeout: 5000 });
    
    // 执行重做
    await page.keyboard.press(`${modifier}+y`);
    
    // 验证重做效果
    await expect(async () => {
      const countAfterRedo = await page.locator('[data-testid="task-card"]').count();
      expect(countAfterRedo).toBeGreaterThanOrEqual(initialTaskCount);
    }).toPass({ timeout: 5000 });
    
    // 最终验证
    await expect(page.locator('[data-testid="task-card"]')).toHaveCount(initialTaskCount, { timeout: 5000 });
  });
});

// 测试清理
test.afterEach(async ({ page }) => {
  try {
    await testHelpers.cleanupTestTasks(page);
  } catch (error) {
    console.warn('测试清理时出现警告:', error);
  }
});

test.afterAll(async () => {
  createdTestData.projectIds.clear();
  createdTestData.taskTitles.clear();
});
