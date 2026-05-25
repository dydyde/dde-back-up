/**
 * 关键路径 3: 拖拽 + 同步 + 性能基准 + 撤销压力测试
 * 
 * 从 critical-paths.spec.ts 拆分
 */
import { test, expect, Page } from '@playwright/test';
import { testHelpers, createdTestData } from './helpers';

async function findTaskCardInContainer(container: ReturnType<Page['locator']>, taskTitle: string, timeout = 5_000) {
  await expect
    .poll(async () => {
      const cards = container.locator('[data-testid="task-card"]');
      const count = await cards.count();

      for (let index = 0; index < count; index += 1) {
        const card = cards.nth(index);
        const titleLabel = card.locator('[data-testid="task-title-label"]').first();
        if (await titleLabel.isVisible().catch(() => false)) {
          const title = (await titleLabel.textContent())?.trim() ?? '';
          if (title === taskTitle) {
            return index;
          }
        }

        const titleInput = card.locator('[data-testid="task-title-input"]').first();
        if (await titleInput.isVisible().catch(() => false)) {
          const title = await titleInput.inputValue().catch(() => '');
          if (title === taskTitle) {
            return index;
          }
        }
      }

      return -1;
    }, { timeout, intervals: [200, 300, 500] })
    .toBeGreaterThanOrEqual(0);

  const cards = container.locator('[data-testid="task-card"]');
  const count = await cards.count();
  for (let index = 0; index < count; index += 1) {
    const card = cards.nth(index);
    const titleLabel = card.locator('[data-testid="task-title-label"]').first();
    if (await titleLabel.isVisible().catch(() => false)) {
      const title = (await titleLabel.textContent())?.trim() ?? '';
      if (title === taskTitle) {
        return card;
      }
    }

    const titleInput = card.locator('[data-testid="task-title-input"]').first();
    if (await titleInput.isVisible().catch(() => false)) {
      const title = await titleInput.inputValue().catch(() => '');
      if (title === taskTitle) {
        return card;
      }
    }
  }

  throw new Error(`未能在目标容器中定位任务卡: ${taskTitle}`);
}

async function moveTaskToStage(page: Page, taskTitle: string, stageNumber: number): Promise<void> {
  const taskCard = await testHelpers.getTaskCard(page, taskTitle, { timeout: 5_000 });
  const stageCard = page.locator(`[data-stage-number="${stageNumber}"]`).first();
  const stageTaskList = page.locator(`[data-stage-number="${stageNumber}"] [data-stage-task-list="${stageNumber}"]`).first();

  await expect(taskCard).toBeVisible({ timeout: 5_000 });
  await expect(stageCard).toBeVisible({ timeout: 5_000 });

  if ((await stageTaskList.getAttribute('aria-hidden')) === 'true') {
    await stageCard.locator('header').first().click({ force: true });
  }
  await expect(stageTaskList).toBeVisible({ timeout: 5_000 });
  await taskCard.dragTo(stageTaskList);

  const stagedCard = await findTaskCardInContainer(stageTaskList, taskTitle, 5_000);
  if (!(await stagedCard.isVisible().catch(() => false))) {
    const ariaHidden = await stageTaskList.getAttribute('aria-hidden');
    if (ariaHidden === 'true') {
      await stageCard.locator('header').first().click({ force: true });
    }
  }

  await expect(stagedCard).toBeVisible({ timeout: 5_000 });
}

async function ensureStageExists(page: Page, stageNumber: number): Promise<void> {
  while (await page.locator('[data-stage-number]').count() < stageNumber) {
    const addStageButton = page.getByText('+ 新阶段').first();
    await expect(addStageButton).toBeVisible({ timeout: 5_000 });
    await addStageButton.click({ force: true });
  }

  await expect(page.locator(`[data-stage-number="${stageNumber}"]`).first()).toBeVisible({ timeout: 5_000 });
}

async function enterStageTaskEditMode(page: Page, taskTitle: string): Promise<void> {
  const taskCard = await testHelpers.getTaskCard(page, taskTitle, { timeout: 5_000 });
  await taskCard.click({ force: true });

  const addChildButton = page.locator('[data-testid="add-child-task-btn"]').first();
  if (await testHelpers.isElementVisible(addChildButton, 800)) {
    return;
  }

  const previewToggle = page.locator('button[title="切换预览/编辑"]').first();
  await expect(previewToggle).toBeVisible({ timeout: 5_000 });
  await previewToggle.click({ force: true });
  await expect(addChildButton).toBeVisible({ timeout: 5_000 });
}

async function createChildTask(page: Page, parentTitle: string, childTitle: string): Promise<void> {
  await enterStageTaskEditMode(page, parentTitle);
  await page.locator('[data-testid="add-child-task-btn"]').first().click();

  const titleInput = page.locator('[data-testid="task-title-input"]').first();
  await expect
    .poll(async () => {
      const value = await titleInput.inputValue().catch(() => '');
      return value.includes(parentTitle) ? 'parent' : 'ready';
    }, { timeout: 5_000, intervals: [200, 300, 500] })
    .toBe('ready');

  await titleInput.fill(childTitle);
  await page.locator('[data-testid="app-container"]').first().click({ position: { x: 12, y: 12 }, force: true });
  await testHelpers.waitForTaskCard(page, childTitle, { timeout: 10_000 });
}

test.describe('关键路径 3: 拖拽 + 同步', () => {
  test('拖入阶段后的下级任务应保留层级缩进', async ({ page }) => {
    await page.goto('/');
    await testHelpers.waitForAppReady(page);
    await testHelpers.ensureEditorReady(page, { mode: 'local' });

    const projectName = `拖拽父子-${testHelpers.uniqueId()}`;
    const projectId = await testHelpers.createTestProject(page, projectName);
    expect(projectId).not.toBeNull();
    if (projectId) {
      testHelpers.trackProjectId(projectId);
    }
    await ensureStageExists(page, 1);
    
    const parentTitle = `父任务-${testHelpers.uniqueId()}`;
    const childTitle = `子任务-${testHelpers.uniqueId()}`;
    testHelpers.trackTaskTitle(parentTitle);
    testHelpers.trackTaskTitle(childTitle);

    await testHelpers.createTask(page, parentTitle);
    await moveTaskToStage(page, parentTitle, 1);
    await createChildTask(page, parentTitle, childTitle);

    const childCard = await testHelpers.getTaskCard(page, childTitle, { timeout: 5_000 });
    await expect(childCard).toBeVisible({ timeout: 5_000 });
    await expect
      .poll(async () => childCard.getAttribute('data-indent-level'), {
        timeout: 5_000,
        intervals: [200, 300, 500],
      })
      .toBe('1');
  });

  test('流程图视图应允许创建并编辑节点标题', async ({ page }) => {
    await page.goto('/');
    await testHelpers.waitForAppReady(page);
    await testHelpers.ensureEditorReady(page, { mode: 'local' });

    const projectName = `流程编辑-${testHelpers.uniqueId()}`;
    const projectId = await testHelpers.createTestProject(page, projectName);
    expect(projectId).not.toBeNull();
    if (projectId) {
      testHelpers.trackProjectId(projectId);
    }

    const updatedTitle = `流程节点-${testHelpers.uniqueId()}`;
    testHelpers.trackTaskTitle(updatedTitle);
    
    // 切换到流程图视图
    const flowViewTab = page.locator('[data-testid="flow-view-tab"]');
    if (await flowViewTab.isVisible()) {
      await flowViewTab.click();
    }
    
    await page.waitForSelector('[data-testid="flow-diagram"]', { timeout: 10000 });

    const unassignedTab = page.locator('[data-testid="flow-palette-tab-unassigned"]').first();
    if (!(await unassignedTab.isVisible({ timeout: 1_000 }).catch(() => false))) {
      const openPanelButton = page.locator('[data-testid="flow-open-right-panel"]').first();
      if (await openPanelButton.isVisible({ timeout: 1_000 }).catch(() => false)) {
        await openPanelButton.click();
      }
    }

    await expect(unassignedTab).toBeVisible({ timeout: 10_000 });
    await unassignedTab.click();

    const createButton = page.locator('[data-testid="create-unassigned-btn"]').first();
    await expect(createButton).toBeVisible({ timeout: 10_000 });
    await createButton.click();

    const createdPaletteTask = page.locator('[data-testid^="flow-palette-task-"]').first();
    await expect(createdPaletteTask).toBeVisible({ timeout: 10_000 });
    await createdPaletteTask.click();

    const titleInput = page.locator('[data-testid="flow-task-title-input"]').first();
    if (!(await titleInput.isVisible({ timeout: 2_000 }).catch(() => false))) {
      const editToggle = page.locator('[data-testid="flow-edit-toggle-btn"]').first();
      await expect(editToggle).toBeVisible({ timeout: 10_000 });
      await editToggle.click();
    }

    await expect(titleInput).toBeVisible({ timeout: 5_000 });
    await titleInput.fill(updatedTitle);
    await titleInput.press('Tab').catch(() => undefined);

    const editToggle = page.locator('[data-testid="flow-edit-toggle-btn"]').first();
    if (await editToggle.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await editToggle.click();
    }
    await expect(createdPaletteTask).toContainText(updatedTitle, { timeout: 5_000 });
  });

  test('离线修改应在重连后同步', async ({ page, context }) => {
    const testEmail = process.env['TEST_USER_EMAIL'];
    const testPassword = process.env['TEST_USER_PASSWORD'];
    
    if (!testEmail || !testPassword) {
      test.skip(true, '跳过：未配置测试账户');
      return;
    }
    
    await page.goto('/');
    await testHelpers.waitForAppReady(page);
    await testHelpers.ensureCloudAuthenticated(page);
    await testHelpers.ensureEditorReady(page, { mode: 'cloud' });
    
    // 模拟离线
    await testHelpers.setOffline(page, context, true);
    await expect(page.locator('[data-testid="offline-indicator"]')).toBeVisible({ timeout: 5000 });
    
    // 创建离线任务
    const offlineTaskTitle = `离线任务-${testHelpers.uniqueId()}`;
    testHelpers.trackTaskTitle(offlineTaskTitle);
    await page.click('[data-testid="add-task-btn"]');
    await page.fill('[data-testid="task-title-input"]', offlineTaskTitle);
    await page.press('[data-testid="task-title-input"]', 'Enter');
    
    await expect(page.locator(`[data-testid="task-card"]:has-text("${offlineTaskTitle}")`)).toBeVisible();
    
    // 离线状态下刷新页面，验证 IndexedDB 持久化
    await page.reload();
    await testHelpers.waitForAppReady(page);
    await testHelpers.ensureEditorReady(page, { mode: 'cloud' });
    await expect(page.locator(`[data-testid="task-card"]:has-text("${offlineTaskTitle}")`)).toBeVisible({ timeout: 10000 });
    
    // 恢复在线
    await testHelpers.setOffline(page, context, false);
    await testHelpers.waitForCloudSyncSettled(page, {
      timeout: 15_000,
      observeActivity: true,
    });
    
    await page.reload();
    await testHelpers.waitForAppReady(page);
    await testHelpers.ensureEditorReady(page, { mode: 'cloud' });
    await expect(page.locator(`[data-testid="task-card"]:has-text("${offlineTaskTitle}")`)).toBeVisible({ timeout: 10000 });
  });

  test('多端一致性：完成/删除/拖拽后另一端不回滚', async ({ browser }) => {
    const testEmail = process.env['TEST_USER_EMAIL'];
    const testPassword = process.env['TEST_USER_PASSWORD'];

    if (!testEmail || !testPassword) {
      test.skip(true, '跳过：未配置测试账户');
      return;
    }

    const contextA = await browser.newContext();
    const pageA = await contextA.newPage();
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();

    const login = async (p: Page) => {
      await testHelpers.ensureCloudAuthenticated(p);
      await expect(p.locator('[data-testid="user-menu"]')).toBeVisible({ timeout: 10000 });
    };

    const waitCloudSaved = async (p: Page) => {
      await testHelpers.waitForCloudSyncSettled(p, {
        timeout: 20_000,
        observeActivity: true,
      });
    };

    const gotoFlowView = async (p: Page) => {
      const flowViewTab = p.locator('[data-testid="flow-view-tab"]');
      if (await flowViewTab.isVisible().catch(() => false)) {
        await flowViewTab.click();
      }
      await p.waitForSelector('[data-testid="flow-diagram"]', { timeout: 15000 });
    };

    const clickDiagramAt = async (p: Page, xRatio: number, yRatio: number, options: { clickCount?: number } = {}) => {
      const diagram = p.locator('[data-testid="flow-diagram"]');
      const box = await diagram.boundingBox();
      expect(box).not.toBeNull();
      if (!box) throw new Error('无法获取 flow-diagram 的 bounding box');
      await p.mouse.click(box.x + box.width * xRatio, box.y + box.height * yRatio, { clickCount: options.clickCount ?? 1 });
    };

    const ensureTaskSelected = async (p: Page) => {
      for (const [x, y] of [[0.5, 0.5], [0.35, 0.5], [0.65, 0.5], [0.5, 0.35], [0.5, 0.65]] as const) {
        await clickDiagramAt(p, x, y);
        if (await p.locator('[data-testid="flow-edit-toggle-btn"]').isVisible().catch(() => false)) {
          return;
        }
      }
      await clickDiagramAt(p, 0.5, 0.5, { clickCount: 2 });
    };

    const setSelectedTaskTitle = async (p: Page, title: string) => {
      await ensureTaskSelected(p);
      await p.locator('[data-testid="flow-edit-toggle-btn"]').click();
      const input = p.locator('[data-testid="flow-task-title-input"]');
      await expect(input).toBeVisible({ timeout: 5000 });
      await input.fill(title);
      await p.locator('[data-testid="flow-edit-toggle-btn"]').click();
      await expect(p.locator('[data-testid="flow-task-title"]')).toContainText(title, { timeout: 5000 });
    };

    const selectTaskByTitle = async (p: Page, title: string) => {
      for (const [x, y] of [[0.35, 0.5], [0.65, 0.5], [0.5, 0.35], [0.5, 0.65], [0.5, 0.5]] as const) {
        await clickDiagramAt(p, x, y);
        const currentTitle = p.locator('[data-testid="flow-task-title"]');
        if (await currentTitle.isVisible().catch(() => false)) {
          const text = (await currentTitle.textContent())?.trim() ?? '';
          if (text.includes(title)) return;
        }
      }
      throw new Error(`未能在流程图中选中目标任务: ${title}`);
    };

    try {
      await login(pageA);
      await login(pageB);

      const projectName = `多端一致性-${testHelpers.uniqueId()}`;
      const projectId = await testHelpers.createTestProject(pageA, projectName);
      if (!projectId) throw new Error('创建测试项目失败：无法获取 projectId');

      await pageB.goto('/');
      await testHelpers.waitForAppReady(pageB);
      const projectItemB = pageB.locator(`[data-testid="project-item"]:has-text("${projectName}")`);
      await expect(projectItemB).toBeVisible({ timeout: 20000 });
      await projectItemB.click();

      await gotoFlowView(pageA);
      await gotoFlowView(pageB);

      const title1 = `完成任务-${testHelpers.uniqueId()}`;
      const title2 = `待删除任务-${testHelpers.uniqueId()}`;

      await pageA.click('[data-testid="create-unassigned-btn"]');
      await setSelectedTaskTitle(pageA, title1);
      await waitCloudSaved(pageA);

      await pageA.click('[data-testid="create-unassigned-btn"]');
      await setSelectedTaskTitle(pageA, title2);
      await waitCloudSaved(pageA);

      // 拖拽测试
      const diagram = pageA.locator('[data-testid="flow-diagram"]');
      const box = await diagram.boundingBox();
      if (box) {
        await pageA.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
        await pageA.mouse.down();
        await pageA.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.58);
        await pageA.mouse.up();
      }

      // 完成任务
      await selectTaskByTitle(pageA, title1);
      await pageA.locator('[data-testid="toggle-task-status-btn"]').click();
      await expect(pageA.locator('[data-testid="flow-task-status-badge"]')).toContainText('完成', { timeout: 5000 });
      await waitCloudSaved(pageA);

      // 删除任务
      await selectTaskByTitle(pageA, title2);
      await pageA.locator('[data-testid="delete-task-btn"]').click();
      await waitCloudSaved(pageA);

      // B 端验证
      await pageB.reload();
      await testHelpers.waitForAppReady(pageB);
      await gotoFlowView(pageB);

      await selectTaskByTitle(pageB, title1);
      await expect(pageB.locator('[data-testid="flow-task-status-badge"]')).toContainText('完成', { timeout: 20000 });

      let deletedStillSelectable = true;
      try {
        await selectTaskByTitle(pageB, title2);
      } catch {
        deletedStillSelectable = false;
      }
      expect(deletedStillSelectable).toBe(false);
    } finally {
      await pageA.close().catch(() => undefined);
      await contextA.close().catch(() => undefined);
      await pageB.close().catch(() => undefined);
      await contextB.close().catch(() => undefined);
    }
  });
});

test.describe('性能基准', () => {
  test('应用加载时间应在可接受范围内', async ({ page }) => {
    const startTime = Date.now();
    await page.goto('/');
    await testHelpers.waitForAppReady(page);
    const loadTime = Date.now() - startTime;
    expect(loadTime).toBeLessThan(5000);
    console.log(`应用加载时间: ${loadTime}ms`);
  });

  test('大量任务下仍能响应', async ({ page }) => {
    await page.goto('/');
    await testHelpers.waitForAppReady(page);
    await testHelpers.ensureEditorReady(page, { mode: 'local' });
    
    for (let i = 0; i < 10; i++) {
      const taskTitle = `批量任务-${i}-${testHelpers.uniqueId()}`;
      testHelpers.trackTaskTitle(taskTitle);
      await page.click('[data-testid="add-task-btn"]');
      await page.fill('[data-testid="task-title-input"]', taskTitle);
      await page.press('[data-testid="task-title-input"]', 'Enter');
    }
    
    const addButton = page.locator('[data-testid="add-task-btn"]');
    await expect(addButton).toBeEnabled();
    
    const taskCards = page.locator('[data-testid="task-card"]');
    const count = await taskCards.count();
    expect(count).toBeGreaterThanOrEqual(10);
  });
});

test.describe('撤销功能压力测试', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await testHelpers.waitForAppReady(page);
    await testHelpers.ensureEditorReady(page, { mode: 'local' });
  });

  test('帕金森测试 - 快速连续撤销不崩溃', async ({ page }) => {
    const modifier = testHelpers.getKeyboardModifier();
    
    for (let i = 0; i < 3; i++) {
      const taskTitle = `撤销测试任务-${i}-${testHelpers.uniqueId()}`;
      testHelpers.trackTaskTitle(taskTitle);
      await page.click('[data-testid="add-task-btn"]');
      await page.fill('[data-testid="task-title-input"]', taskTitle);
      await page.press('[data-testid="task-title-input"]', 'Enter');
      await testHelpers.waitForTaskCard(page, taskTitle);
    }
    
    console.log('开始快速连续撤销测试...');
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press(`${modifier}+z`);
    }
    
    // 验证应用未崩溃，UI 仍能响应
    const addButton = page.locator('[data-testid="add-task-btn"]');
    await expect(addButton).toBeEnabled({ timeout: 5000 });
    
    console.log('帕金森测试通过：快速撤销后应用仍响应');
  });

  test('撤销重做循环 - 多次循环后数据一致', async ({ page }) => {
    const modifier = testHelpers.getKeyboardModifier();
    
    const taskTitle = `循环测试任务-${testHelpers.uniqueId()}`;
    testHelpers.trackTaskTitle(taskTitle);
    await page.click('[data-testid="add-task-btn"]');
    await page.fill('[data-testid="task-title-input"]', taskTitle);
    await page.press('[data-testid="task-title-input"]', 'Enter');

    const taskCard = page.locator(`[data-testid="task-card"]:has-text("${taskTitle}")`);
    await expect(taskCard).toBeVisible({ timeout: 3000 });
    
    for (let cycle = 0; cycle < 5; cycle++) {
      await page.keyboard.press(`${modifier}+z`);
      await expect(taskCard).toBeHidden({ timeout: 5000 });
      await page.keyboard.press(`${modifier}+y`);
      await expect(taskCard).toBeVisible({ timeout: 5000 });
    }
    
    await expect(taskCard).toBeVisible({ timeout: 3000 });
    const addButton = page.locator('[data-testid="add-task-btn"]');
    await expect(addButton).toBeEnabled();
    
    console.log('撤销重做循环测试通过：5次循环后数据一致');
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
