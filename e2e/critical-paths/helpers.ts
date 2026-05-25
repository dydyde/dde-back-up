/**
 * 关键路径 E2E 测试 - 共享辅助函数和类型
 * 
 * 从 critical-paths.spec.ts 抽取的共享代码
 */
import { expect, BrowserContext, Locator, Page } from '@playwright/test';
import {
  ensureAuthenticated as ensureSharedAuthenticated,
  ensureLoginModalVisible,
} from '../shared/auth-helpers';

type EditorMode = 'local' | 'cloud';

interface EnsureEditorReadyOptions {
  requireCloud?: boolean;
  mode?: EditorMode;
}

interface CreateTaskOptions {
  content?: string;
}

interface WaitForSyncOptions {
  timeout?: number;
}

interface WaitForCloudSyncOptions extends WaitForSyncOptions {
  observeActivity?: boolean;
  previousSyncMarker?: string | null;
}

// ============================================================================
// 类型定义
// ============================================================================

/** 测试环境配置 */
export interface TestEnvConfig {
  TEST_USER_EMAIL?: string;
  TEST_USER_PASSWORD?: string;
}

/** 测试数据跟踪结构 */
export interface CreatedTestData {
  projectIds: Set<string>;
  taskTitles: Set<string>;
}

/** 测试辅助函数接口 */
export interface TestHelpers {
  waitForAppReady(page: Page): Promise<void>;
  ensureCloudAuthenticated(page: Page): Promise<void>;
  ensureEditorReady(page: Page, options?: EnsureEditorReadyOptions): Promise<void>;
  createTestProject(page: Page, projectName: string): Promise<string | null>;
  createTask(page: Page, title: string, options?: CreateTaskOptions): Promise<void>;
  uniqueId(): string;
  cleanupTestTasks(page: Page): Promise<void>;
  trackTaskTitle(title: string): void;
  trackProjectId(id: string): void;
  getKeyboardModifier(): 'Meta' | 'Control';
  waitForTaskCard(page: Page, title: string, options?: { timeout?: number }): Promise<void>;
  getTaskCard(page: Page, title: string, options?: { timeout?: number }): Promise<Locator>;
  openTaskTitleEditor(page: Page, title: string, options?: { timeout?: number }): Promise<Locator>;
  openTaskContentEditor(page: Page, title: string, options?: { timeout?: number }): Promise<Locator>;
  openSettings(page: Page): Promise<void>;
  setOffline(page: Page, context: BrowserContext, offline: boolean): Promise<void>;
  waitForOfflineIndicator(page: Page, options?: WaitForSyncOptions): Promise<void>;
  waitForSyncSettled(page: Page, options?: WaitForSyncOptions): Promise<void>;
  waitForCloudSyncSettled(page: Page, options?: WaitForCloudSyncOptions): Promise<void>;
  /** 安全可见性检查，替代 .isVisible({ timeout }).catch(() => false) */
  isElementVisible(locator: Locator, timeout?: number): Promise<boolean>;
  /** 条件点击：元素可见则点击并返回 true，不可见返回 false */
  clickIfVisible(locator: Locator, options?: { timeout?: number; force?: boolean }): Promise<boolean>;
}

async function isElementVisible(locator: Locator, timeout = 2000): Promise<boolean> {
  try {
    await locator.waitFor({ state: 'visible', timeout });
    return true;
  } catch {
    return false;
  }
}

async function clickIfVisible(locator: Locator, options?: { timeout?: number; force?: boolean }): Promise<boolean> {
  try {
    await locator.waitFor({ state: 'visible', timeout: options?.timeout ?? 2000 });
    await locator.click({ force: options?.force ?? false });
    return true;
  } catch {
    return false;
  }
}

async function dispatchBrowserNetworkState(page: Page, offline: boolean): Promise<void> {
  await page.evaluate((nextOffline) => {
    const online = !nextOffline;
    const defineOnlineGetter = (target: object) => {
      Object.defineProperty(target, 'onLine', {
        configurable: true,
        get: () => online,
      });
    };

    try {
      defineOnlineGetter(Navigator.prototype);
    } catch {
      try {
        defineOnlineGetter(navigator);
      } catch {
        // Some browser engines expose navigator.onLine as read-only; the event still drives NanoFlow state.
      }
    }

    window.dispatchEvent(new Event(nextOffline ? 'offline' : 'online'));
  }, offline);
}

async function cardMatchesTitle(card: Locator, title: string): Promise<boolean> {
  const selectors: Array<{ selector: string; kind: 'text' | 'value' }> = [
    { selector: '[data-testid="task-title-label"]', kind: 'text' },
    { selector: '[data-testid="task-title-preview"]', kind: 'text' },
    { selector: '[data-testid="task-title-input"]', kind: 'value' },
  ];

  for (const candidate of selectors) {
    const element = card.locator(candidate.selector).first();
    if (!(await isElementVisible(element, 200))) {
      continue;
    }

    const value = candidate.kind === 'value'
      ? await element.inputValue().catch(() => '')
      : ((await element.textContent().catch(() => '')) ?? '').trim();
    if (value.trim() === title) {
      return true;
    }
  }

  return false;
}

async function findTaskCard(page: Page, title: string, timeout = 5000): Promise<Locator> {
  const taskCards = page.locator('[data-testid="task-card"]');

  await expect
    .poll(async () => {
      const count = await taskCards.count();
      for (let index = 0; index < count; index += 1) {
        if (await cardMatchesTitle(taskCards.nth(index), title)) {
          return index;
        }
      }
      return -1;
    }, { timeout, intervals: [200, 300, 500] })
    .toBeGreaterThanOrEqual(0);

  const count = await taskCards.count();
  for (let index = 0; index < count; index += 1) {
    const card = taskCards.nth(index);
    if (!(await cardMatchesTitle(card, title))) {
      continue;
    }

    const taskId = await card.getAttribute('data-task-id');
    if (taskId) {
      return page.locator(`[data-testid="task-card"][data-task-id="${taskId}"]`).first();
    }

    return card;
  }

  throw new Error(`未找到任务卡: ${title}`);
}

async function ensureTaskEditMode(page: Page, title: string, timeout = 5000): Promise<Locator> {
  const taskCard = await findTaskCard(page, title, timeout);
  await expect(taskCard).toBeVisible({ timeout });
  await taskCard.click({ force: true });

  const titleInput = taskCard.locator('[data-testid="task-title-input"]').first();
  const contentEditor = taskCard.locator('[data-testid="task-content-editor"]').first();
  if ((await isElementVisible(titleInput, 600)) || (await isElementVisible(contentEditor, 600))) {
    return taskCard;
  }

  const editTriggers = [
    taskCard.locator('[data-testid="task-title-preview"]').first(),
    taskCard.locator('[data-testid="task-content"]').first(),
    taskCard.locator('[data-testid="task-content-empty"]').first(),
    taskCard.locator('[data-testid="task-title-label"]').first(),
  ];

  for (const trigger of editTriggers) {
    if (!(await clickIfVisible(trigger, { timeout: 800, force: true }))) {
      continue;
    }

    if ((await isElementVisible(titleInput, 800)) || (await isElementVisible(contentEditor, 800))) {
      return taskCard;
    }
  }

  await expect(titleInput.or(contentEditor).first()).toBeVisible({ timeout });
  return taskCard;
}

function getSyncIndicator(page: Page): Locator {
  return page.locator('[data-testid="sync-status-indicator"]').first();
}

async function readSyncAttributes(page: Page): Promise<{
  offline: string | null;
  pending: string | null;
  busy: string | null;
  success: string | null;
  lastSync: string | null;
}> {
  const indicator = getSyncIndicator(page);
  return {
    offline: await indicator.getAttribute('data-testid-offline').catch(() => null),
    pending: await indicator.getAttribute('data-testid-pending').catch(() => null),
    busy: await indicator.getAttribute('data-testid-busy').catch(() => null),
    success: await indicator.getAttribute('data-testid-success').catch(() => null),
    lastSync: await indicator.getAttribute('data-testid-last-sync').catch(() => null),
  };
}

// ============================================================================
// 环境变量验证
// ============================================================================

/** 获取并验证测试环境配置 */
export function getTestEnvConfig(): TestEnvConfig {
  return {
    TEST_USER_EMAIL: process.env['TEST_USER_EMAIL'],
    TEST_USER_PASSWORD: process.env['TEST_USER_PASSWORD'],
  };
}

// ============================================================================
// 测试数据跟踪（用于清理）
// ============================================================================

export const createdTestData: CreatedTestData = {
  projectIds: new Set<string>(),
  taskTitles: new Set<string>(),
};

// ============================================================================
// 测试辅助函数
// ============================================================================

export const testHelpers: TestHelpers = {
  /** 等待应用加载完成 */
  async waitForAppReady(page: Page): Promise<void> {
    // 等待路由加载
    await page.waitForSelector('[data-testid="app-container"]', { timeout: 10000 });
    // 等待loading状态消失
    await expect(page.locator('[data-testid="loading-indicator"]')).not.toBeVisible({ timeout: 10000 });
  },

  /** 强制使用云账号完成认证 */
  async ensureCloudAuthenticated(page: Page): Promise<void> {
    const { TEST_USER_EMAIL, TEST_USER_PASSWORD } = getTestEnvConfig();
    if (!TEST_USER_EMAIL || !TEST_USER_PASSWORD) {
      throw new Error('未配置 TEST_USER_EMAIL / TEST_USER_PASSWORD，无法执行云同步用例');
    }

    await ensureSharedAuthenticated(
      page,
      { email: TEST_USER_EMAIL, password: TEST_USER_PASSWORD },
      {
        projectsPath: '/#/projects',
        maxAttempts: 3,
        submitTimeoutMs: 15_000,
      }
    );
  },

  /**
   * 确保进入可编辑态：
   * 1) 已有 add-task-btn 直接通过
   * 2) 有云凭据优先登录云账号
   * 3) 无云凭据时降级进入本地模式
   */
  async ensureEditorReady(page: Page, options?: EnsureEditorReadyOptions): Promise<void> {
    const addTaskBtn = page.locator('[data-testid="add-task-btn"]');
    if (await isElementVisible(addTaskBtn, 1200)) {
      return;
    }

    const { TEST_USER_EMAIL, TEST_USER_PASSWORD } = getTestEnvConfig();
    const hasCloudCreds = !!TEST_USER_EMAIL && !!TEST_USER_PASSWORD;
    const mode = options?.mode;
    const requireCloud = options?.requireCloud ?? mode === 'cloud';

    if (mode === 'local') {
      await ensureLoginModalVisible(page);
      await page.click('[data-testid="local-mode-btn"]');
    } else if (hasCloudCreds) {
      await testHelpers.ensureCloudAuthenticated(page);
    } else if (!requireCloud) {
      await ensureLoginModalVisible(page);
      await page.click('[data-testid="local-mode-btn"]');
    } else {
      throw new Error('该用例要求云登录，但未配置 TEST_USER_EMAIL / TEST_USER_PASSWORD');
    }

    await addTaskBtn.waitFor({ state: 'visible', timeout: 15_000 });
  },

  async createTask(page: Page, title: string, options?: CreateTaskOptions): Promise<void> {
    const textViewTab = page.locator('[data-testid="text-view-tab"]').first();
    await clickIfVisible(textViewTab, { timeout: 1000, force: true });

    await page.click('[data-testid="add-task-btn"]', { force: true });
    const titleInput = page.locator('[data-testid="task-title-input"]').first();
    await expect(titleInput).toBeVisible({ timeout: 5_000 });
    await titleInput.fill(title);
    await titleInput.press('Enter');
    await page.locator('[data-testid="app-container"]').first().click({ position: { x: 12, y: 12 }, force: true });
    const taskCard = await testHelpers.getTaskCard(page, title, { timeout: 10_000 });
    await expect
      .poll(async () => taskCard.getAttribute('draggable'), {
        timeout: 5_000,
        intervals: [100, 150, 250],
      })
      .toBe('true');

    if (typeof options?.content === 'string' && options.content.length > 0) {
      const contentEditor = await testHelpers.openTaskContentEditor(page, title, { timeout: 10_000 });
      await contentEditor.fill(options.content);
      await contentEditor.blur();
    }
  },

  /** 访客模式下创建测试项目，返回项目 ID */
  async createTestProject(page: Page, projectName: string): Promise<string | null> {
    // 点击创建项目按钮
    await page.click('[data-testid="create-project-btn"]');
    // 等待对话框出现
    await page.waitForSelector('[data-testid="new-project-modal"]');
    // 输入项目名
    await page.fill('[data-testid="project-name-input"]', projectName);
    // 确认创建
    await page.click('[data-testid="create-project-confirm"]');
    // 等待对话框关闭
    await expect(page.locator('[data-testid="new-project-modal"]')).not.toBeVisible();
    
    // 尝试从 DOM 获取项目 ID
    const projectElement = page.locator(`[data-testid="project-item"]:has-text("${projectName}")`);
    await expect(projectElement).toBeVisible({ timeout: 5000 });
    const projectId = await projectElement.getAttribute('data-project-id');
    
    // 记录创建的项目用于清理
    if (projectId) {
      createdTestData.projectIds.add(projectId);
    }
    
    return projectId;
  },

  /** 生成唯一的测试数据 */
  uniqueId(): string {
    return `test-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  },

  /** 清理测试创建的任务 */
  async cleanupTestTasks(page: Page): Promise<void> {
    // 尝试删除测试创建的任务
    const taskTitles = Array.from(createdTestData.taskTitles);
    for (const title of taskTitles) {
      try {
        const taskCard = page.locator(`[data-testid="task-card"]:has-text("${title}")`);
        if (await taskCard.isVisible({ timeout: 1000 })) {
          await taskCard.click({ button: 'right' });
          const deleteBtn = page.locator('[data-testid="context-menu-delete"]');
          if (await deleteBtn.isVisible({ timeout: 1000 })) {
            await deleteBtn.click();
          }
        }
      } catch {
        // 忽略清理失败
      }
    }
    createdTestData.taskTitles.clear();
  },

  /** 记录任务标题用于清理 */
  trackTaskTitle(title: string): void {
    createdTestData.taskTitles.add(title);
  },

  /** 记录项目 ID 用于清理 */
  trackProjectId(id: string): void {
    createdTestData.projectIds.add(id);
  },

  /** 获取键盘修饰键（Mac: Meta, 其他: Control） */
  getKeyboardModifier(): 'Meta' | 'Control' {
    return process.platform === 'darwin' ? 'Meta' : 'Control';
  },

  /** 等待任务卡片可见 */
  async waitForTaskCard(page: Page, title: string, options?: { timeout?: number }): Promise<void> {
    await testHelpers.getTaskCard(page, title, options);
  },

  async getTaskCard(page: Page, title: string, options?: { timeout?: number }): Promise<Locator> {
    const timeout = options?.timeout ?? 5000;
    const taskCard = await findTaskCard(page, title, timeout);
    await expect(taskCard).toBeVisible({ timeout });
    return taskCard;
  },

  async openTaskTitleEditor(page: Page, title: string, options?: { timeout?: number }): Promise<Locator> {
    const timeout = options?.timeout ?? 5000;
    const taskCard = await ensureTaskEditMode(page, title, timeout);
    const titleInput = taskCard.locator('[data-testid="task-title-input"]').first();
    await expect(titleInput).toBeVisible({ timeout });
    await titleInput.focus();
    return titleInput;
  },

  async openTaskContentEditor(page: Page, title: string, options?: { timeout?: number }): Promise<Locator> {
    const timeout = options?.timeout ?? 5000;
    const taskCard = await ensureTaskEditMode(page, title, timeout);
    const contentEditor = taskCard.locator('[data-testid="task-content-editor"]').first();
    await expect(contentEditor).toBeVisible({ timeout });
    await contentEditor.focus();
    return contentEditor;
  },

  async openSettings(page: Page): Promise<void> {
    const settingsModal = page.locator('[data-testid="settings-modal"]').first();
    if (await isElementVisible(settingsModal, 500)) {
      return;
    }

    const settingsButton = page.locator('[data-testid="workspace-settings-button"], button[aria-label="打开设置"]').first();
    await expect(settingsButton).toBeVisible({ timeout: 10_000 });
    await settingsButton.click({ force: true });
    await expect(settingsModal).toBeVisible({ timeout: 15_000 });
  },

  async setOffline(page: Page, context: BrowserContext, offline: boolean): Promise<void> {
    await context.setOffline(offline);
    await dispatchBrowserNetworkState(page, offline);
  },

  async waitForOfflineIndicator(page: Page, options?: WaitForSyncOptions): Promise<void> {
    const timeout = options?.timeout ?? 10_000;
    await expect
      .poll(async () => {
        const browserOffline = await page.evaluate(() => navigator.onLine === false).catch(() => false);
        const bannerVisible = await page.locator('[data-testid="offline-indicator"]').first().isVisible().catch(() => false);
        const attrs = await readSyncAttributes(page);
        return browserOffline || bannerVisible || attrs.offline === 'offline-indicator';
      }, { timeout, intervals: [200, 300, 500] })
      .toBe(true);
  },

  async waitForSyncSettled(page: Page, options?: WaitForSyncOptions): Promise<void> {
    const timeout = options?.timeout ?? 10_000;
    await expect(getSyncIndicator(page)).toBeVisible({ timeout: Math.min(timeout, 5_000) });
    await expect
      .poll(async () => {
        const attrs = await readSyncAttributes(page);
        return attrs.offline !== 'offline-indicator'
          && attrs.pending !== 'pending-sync-indicator'
          && attrs.busy !== 'sync-busy-indicator';
      }, { timeout, intervals: [200, 300, 500, 1_000] })
      .toBe(true);
  },

  async waitForCloudSyncSettled(page: Page, options?: WaitForCloudSyncOptions): Promise<void> {
    const timeout = options?.timeout ?? 10_000;
    await expect(getSyncIndicator(page)).toBeVisible({ timeout: Math.min(timeout, 5_000) });

    const baselineMarker = options?.previousSyncMarker ?? (await readSyncAttributes(page)).lastSync;
    let observedActivity = false;

    if (options?.observeActivity) {
      await expect
        .poll(async () => {
          const attrs = await readSyncAttributes(page);
          const active = attrs.busy === 'sync-busy-indicator'
            || attrs.pending === 'pending-sync-indicator'
            || (baselineMarker !== null && attrs.lastSync !== baselineMarker);
          if (active) {
            observedActivity = true;
          }
          return active;
        }, { timeout: Math.min(timeout, 5_000), intervals: [200, 300, 500] })
        .toBe(true);
    }

    await expect
      .poll(async () => {
        const attrs = await readSyncAttributes(page);
        const settled = attrs.offline !== 'offline-indicator'
          && attrs.pending !== 'pending-sync-indicator'
          && attrs.busy !== 'sync-busy-indicator';
        const markerSatisfied = baselineMarker === null
          ? true
          : attrs.lastSync !== baselineMarker || observedActivity;
        return settled
          && attrs.success === 'sync-success-indicator'
          && markerSatisfied;
      }, { timeout, intervals: [200, 300, 500, 1_000] })
      .toBe(true);
  },

  /** 安全可见性检查，替代 .isVisible({ timeout }).catch(() => false) 模式 */
  async isElementVisible(locator: Locator, timeout = 2000): Promise<boolean> {
    return isElementVisible(locator, timeout);
  },

  /** 条件点击：元素可见则点击并返回 true，超时不可见返回 false */
  async clickIfVisible(locator: Locator, options?: { timeout?: number; force?: boolean }): Promise<boolean> {
    return clickIfVisible(locator, options);
  },
};
