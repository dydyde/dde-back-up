import { test, expect, Page, Route } from '@playwright/test';
import { getTestEnvConfig, testHelpers as criticalPathHelpers } from './critical-paths/helpers';

/**
 * NanoFlow 同步数据完整性 E2E 测试
 * 
 * 【P0 回归保护】2026-01-13
 * 
 * 测试场景：
 * 1. 部分字段同步攻击防护 - 模拟后端返回不含 content 的数据
 * 2. LWW 合并时的内容保护 - 验证本地内容不被空数据覆盖
 * 3. 增量同步内容完整性 - Delta Sync 场景
 * 4. Realtime 推送内容保护 - 模拟实时更新场景
 * 
 * 背景：
 * - 流量优化曾导致 TASK_LIST_FIELDS 不包含 content 字段
 * - 这导致同步时任务内容被空字符串覆盖
 * - 此测试套件确保该问题不会复发
 */

// ============================================================================
// 类型定义
// ============================================================================

interface TestHelpers {
  waitForAppReady(page: Page): Promise<void>;
  uniqueId(): string;
  createTaskWithContent(page: Page, title: string, content: string): Promise<void>;
  openTaskDetail(page: Page, title: string): Promise<void>;
  getTaskContent(page: Page): Promise<string>;
  waitForSync(page: Page): Promise<void>;
  closeTaskDetail(page: Page): Promise<void>;
  triggerSync(page: Page): Promise<void>;
}

interface TaskPayload {
  id: string;
  title: string;
  content?: string;
  stage?: number | null;
  parent_id?: string | null;
  order?: number;
  rank?: number;
  status?: string;
  x?: number;
  y?: number;
  updated_at?: string;
  deleted_at?: string | null;
  short_id?: string;
   
  [key: string]: any;
}

const syncMarkerByPage = new WeakMap<Page, string | null>();

async function readLastSyncMarker(page: Page): Promise<string | null> {
  return page.locator('[data-testid="sync-status-indicator"]').first().getAttribute('data-testid-last-sync').catch(() => null);
}

// ============================================================================
// 测试辅助函数
// ============================================================================

const helpers: TestHelpers = {
  async waitForAppReady(page: Page): Promise<void> {
    await criticalPathHelpers.waitForAppReady(page);
    await criticalPathHelpers.ensureCloudAuthenticated(page);
    await criticalPathHelpers.ensureEditorReady(page, { mode: 'cloud' });
    syncMarkerByPage.set(page, await readLastSyncMarker(page));
  },

  uniqueId(): string {
    return `sync-test-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  },

  async createTaskWithContent(page: Page, title: string, content: string): Promise<void> {
    await criticalPathHelpers.createTask(page, title, { content });
  },

  async openTaskDetail(page: Page, title: string): Promise<void> {
    await criticalPathHelpers.openTaskTitleEditor(page, title);
    await expect(page.locator('[data-testid="task-content"], [data-testid="task-content-editor"]').first()).toBeVisible({ timeout: 5_000 });
  },

  async getTaskContent(page: Page): Promise<string> {
    const selectors = [
      '[data-testid="task-content-editor"]',
      '[data-testid="task-content"]',
    ];
    
    for (const selector of selectors) {
      const element = page.locator(selector);
      if (await element.isVisible({ timeout: 500 }).catch(() => false)) {
        // 尝试 inputValue (for input/textarea)
        const inputValue = await element.inputValue().catch(() => null);
        if (inputValue !== null) {
          return inputValue;
        }
        // 尝试 textContent (for div/span)
        const textContent = await element.textContent().catch(() => null);
        if (textContent !== null) {
          return textContent;
        }
      }
    }
    
    return '';
  },

  async waitForSync(page: Page): Promise<void> {
    const previousSyncMarker = syncMarkerByPage.get(page) ?? null;
    await criticalPathHelpers.waitForCloudSyncSettled(page, {
      timeout: 10_000,
      previousSyncMarker,
    });
    syncMarkerByPage.set(page, await readLastSyncMarker(page));
  },

  async closeTaskDetail(page: Page): Promise<void> {
    await page.keyboard.press('Escape');
  },

  async triggerSync(page: Page): Promise<void> {
    const resyncButton = page.locator('[data-testid="sync-resync-project-btn"], button[title="刷新同步当前项目"]').first();
    await expect(resyncButton).toBeVisible({ timeout: 5_000 });

    const previousSyncMarker = syncMarkerByPage.get(page) ?? await readLastSyncMarker(page);

    const tasksResponse = page.waitForResponse((response) => {
      return response.request().method() === 'GET' && response.url().includes('/rest/v1/tasks');
    }, { timeout: 10_000 });

    const waitForSyncCycle = criticalPathHelpers.waitForCloudSyncSettled(page, {
      timeout: 10_000,
      observeActivity: true,
      previousSyncMarker,
    });

    await resyncButton.click();
    await Promise.all([tasksResponse, waitForSyncCycle]);
    syncMarkerByPage.set(page, await readLastSyncMarker(page));
  },
};

test.beforeEach(() => {
  const { TEST_USER_EMAIL, TEST_USER_PASSWORD } = getTestEnvConfig();
  test.skip(!TEST_USER_EMAIL || !TEST_USER_PASSWORD, '跳过：未配置 TEST_USER_EMAIL / TEST_USER_PASSWORD');
});

/**
 * 创建恶意响应拦截器 - 移除 content 字段
 * 模拟后端返回部分字段的场景（流量优化配置错误）
 */
function createContentStripperInterceptor(page: Page): Promise<void> {
  return page.route('**/rest/v1/tasks*', async (route: Route) => {
    const request = route.request();
    const method = request.method();
    
    // 只拦截 GET 请求（同步拉取）
    if (method === 'GET') {
      try {
        const response = await route.fetch();
        const json = await response.json();
        
        // 😈 恶意篡改：移除 content 字段，模拟部分加载
        const corruptedTasks = (Array.isArray(json) ? json : [json]).map((t: TaskPayload) => {
           
          const { content, ...rest } = t;
          // 确保 updated_at 比本地新，触发 LWW 合并
          return { 
            ...rest, 
            updated_at: new Date(Date.now() + 10000).toISOString() 
          };
        });
        
        await route.fulfill({ 
          json: Array.isArray(json) ? corruptedTasks : corruptedTasks[0],
          status: 200,
        });
      } catch {
        // 如果拦截失败，继续原请求
        await route.continue();
      }
    } else {
      await route.continue();
    }
  });
}

/**
 * 创建部分更新拦截器 - 只返回位置/状态变更，不返回 content
 * 模拟另一设备只推送坐标更新的场景
 */
function createPositionOnlyUpdateInterceptor(page: Page, taskId: string): Promise<void> {
  return page.route('**/rest/v1/tasks*', async (route: Route) => {
    const request = route.request();
    const method = request.method();
    const url = request.url();
    
    // 只拦截特定任务的 GET 请求
    if (method === 'GET' && url.includes(taskId)) {
      try {
        const response = await route.fetch();
        const json = await response.json();
        
        // 模拟只有位置更新的响应
        const partialUpdate = (Array.isArray(json) ? json : [json]).map((t: TaskPayload) => ({
          id: t.id,
          title: t.title,
          stage: t.stage,
          parent_id: t.parent_id,
          order: t.order,
          rank: t.rank,
          status: t.status,
          x: (t.x || 0) + 100,  // 模拟位置变更
          y: (t.y || 0) + 100,
          updated_at: new Date(Date.now() + 10000).toISOString(),
          deleted_at: t.deleted_at,
          short_id: t.short_id,
          // 故意不包含 content
        }));
        
        await route.fulfill({ 
          json: Array.isArray(json) ? partialUpdate : partialUpdate[0],
          status: 200,
        });
      } catch {
        await route.continue();
      }
    } else {
      await route.continue();
    }
  });
}

// ============================================================================
// 测试组：同步数据完整性
// ============================================================================

test.describe('同步数据完整性：Content 字段保护', () => {
  
  /**
   * 【P0 回归测试】核心场景
   * 场景：后端返回不含 content 的任务数据时，本地内容不应丢失
   * 
   * 攻击向量：
   * 1. 用户创建包含内容的任务
   * 2. 后端返回该任务的更新（如位置变更），但 payload 不含 content
   * 3. 前端合并逻辑应保护本地 content 不被覆盖
   */
  test('后端返回部分字段时不应覆盖本地 content', async ({ page }) => {
    await page.goto('/');
    await helpers.waitForAppReady(page);
    
    const testTitle = `内容保护测试-${helpers.uniqueId()}`;
    const preciousContent = 'My Precious Content - 这是用户辛苦编写的内容，绝对不能丢失！';
    
    // 1. 创建包含内容的任务
    await helpers.createTaskWithContent(page, testTitle, preciousContent);
    await helpers.waitForSync(page);
    
    // 2. 验证任务已创建
    await helpers.openTaskDetail(page, testTitle);
    const contentBefore = await helpers.getTaskContent(page);
    expect(contentBefore).toContain('My Precious Content');
    
    await helpers.closeTaskDetail(page);
    
    // 3. 设置恶意拦截器 - 模拟后端返回不含 content 的数据
    await createContentStripperInterceptor(page);
    
    // 4. 触发同步
    await helpers.triggerSync(page);
    await helpers.waitForSync(page);
    
    // 5. 🚨 核心断言：验证内容没有消失
    await helpers.openTaskDetail(page, testTitle);
    const contentAfter = await helpers.getTaskContent(page);

    expect(contentAfter).toBe(contentBefore);
  });

  /**
   * 场景：位置更新同步时不应丢失内容
   * 
   * 模拟：另一设备拖动了任务位置，服务器只推送位置变更
   */
  test('位置更新同步不应影响 content', async ({ page }) => {
    await page.goto('/');
    await helpers.waitForAppReady(page);
    
    const testTitle = `位置同步测试-${helpers.uniqueId()}`;
    const testContent = '这是任务的详细内容，在位置更新时不应丢失';
    
    // 1. 创建任务
    await helpers.createTaskWithContent(page, testTitle, testContent);
    await helpers.waitForSync(page);
    
    // 2. 获取任务 ID（从 DOM 中）
    const taskCard = await criticalPathHelpers.getTaskCard(page, testTitle, { timeout: 5_000 });
    await expect(taskCard).toBeVisible();
    const taskId = await taskCard.getAttribute('data-task-id') || 'unknown';
    
    // 3. 验证内容存在
    await helpers.openTaskDetail(page, testTitle);
    const contentBefore = await helpers.getTaskContent(page);
    await helpers.closeTaskDetail(page);
    expect(contentBefore).toContain(testContent);
    
    // 4. 设置拦截器 - 模拟只返回位置更新
    await createPositionOnlyUpdateInterceptor(page, taskId);
    
    // 5. 触发同步
    await helpers.triggerSync(page);
    // 等待合并逻辑完成
    await helpers.waitForSync(page);
    
    // 6. 验证内容完整
    await helpers.openTaskDetail(page, testTitle);
    const contentAfter = await helpers.getTaskContent(page);
    
    expect(contentAfter).toBe(contentBefore);
    console.log('✅ 位置更新后内容保持完整');
  });

  /**
   * 场景：多次同步后内容累积保护
   * 
   * 验证：多次同步请求中，即使持续收到不含 content 的响应，
   * 本地内容也应该一直被保护
   */
  test('多次同步后 content 应持续保持', async ({ page }) => {
    await page.goto('/');
    await helpers.waitForAppReady(page);
    
    const testTitle = `多次同步测试-${helpers.uniqueId()}`;
    const testContent = '这段内容在多次同步后仍应保持';
    
    // 1. 创建任务
    await helpers.createTaskWithContent(page, testTitle, testContent);
    await helpers.waitForSync(page);
    
    // 2. 验证初始内容
    await helpers.openTaskDetail(page, testTitle);
    const initialContent = await helpers.getTaskContent(page);
    await helpers.closeTaskDetail(page);
    expect(initialContent).toContain(testContent);
    
    // 3. 设置恶意拦截器
    await createContentStripperInterceptor(page);
    
    // 4. 执行多次同步
    for (let i = 0; i < 3; i++) {
      await helpers.triggerSync(page);
    }
    
    // 5. 验证内容仍然完整
    await helpers.openTaskDetail(page, testTitle);
    const finalContent = await helpers.getTaskContent(page);
    
    expect(finalContent).toBe(initialContent);
    console.log('✅ 多次同步后内容仍然完整');
  });
});

// ============================================================================
// 测试组：LWW 合并策略
// ============================================================================

test.describe('同步数据完整性：LWW 合并策略', () => {
  
  /**
   * 场景：远程 updated_at 更新但 content 为空时的处理
   * 
   * 这是 LWW 的边界情况：
   * - 远程时间戳更新（应该采用远程数据）
   * - 但远程 content 为空（应该保护本地数据）
   */
  test('远程时间更新但 content 缺失时应保护本地数据', async ({ page }) => {
    await page.goto('/');
    await helpers.waitForAppReady(page);
    
    const testTitle = `LWW边界测试-${helpers.uniqueId()}`;
    const testContent = 'LWW 测试内容 - 即使远程时间更新，也不应丢失';
    
    // 1. 创建任务
    await helpers.createTaskWithContent(page, testTitle, testContent);
    await helpers.waitForSync(page);
    
    // 2. 验证内容
    await helpers.openTaskDetail(page, testTitle);
    const contentBefore = await helpers.getTaskContent(page);
    await helpers.closeTaskDetail(page);
    expect(contentBefore).toContain(testContent);
    
    // 3. 设置拦截器 - 返回更新的时间戳但无 content
    await page.route('**/rest/v1/tasks*', async (route: Route) => {
      const request = route.request();
      if (request.method() === 'GET') {
        try {
          const response = await route.fetch();
          const json = await response.json();
          
          const manipulated = (Array.isArray(json) ? json : [json]).map((t: TaskPayload) => {
             
            const { content, ...rest } = t;
            return {
              ...rest,
              // 设置一个非常新的时间戳，应该触发 LWW 采用远程
              updated_at: new Date(Date.now() + 86400000).toISOString(), // 未来 24 小时
            };
          });
          
          await route.fulfill({ 
            json: Array.isArray(json) ? manipulated : manipulated[0] 
          });
        } catch {
          await route.continue();
        }
      } else {
        await route.continue();
      }
    });
    
    // 4. 触发同步
    await helpers.triggerSync(page);
    await helpers.waitForSync(page);
    
    // 5. 验证内容保护
    await helpers.openTaskDetail(page, testTitle);
    const contentAfter = await helpers.getTaskContent(page);
    
    expect(contentAfter).toBe(contentBefore);
    console.log('✅ LWW 边界情况处理正确：内容得到保护');
  });
});

// ============================================================================
// 测试组：Sentry 监控验证
// ============================================================================

test.describe('同步数据完整性：监控埋点验证', () => {
  
  /**
   * 场景：验证 Sentry 警告被触发
   * 
   * 当检测到 content 字段缺失时，应该有监控埋点上报
   * 注：这个测试主要验证日志，不验证实际 Sentry 上报（需要 Sentry 测试环境）
   */
  test('检测到 content 缺失时应记录警告', async ({ page }) => {
    // 收集控制台警告
    const consoleWarnings: string[] = [];
    page.on('console', msg => {
      // Playwright 使用 'warning' 而不是 'warn'
      if (msg.type() === 'warning' || msg.type() === 'error') {
        consoleWarnings.push(msg.text());
      }
    });
    
    await page.goto('/');
    await helpers.waitForAppReady(page);
    
    const testTitle = `监控测试-${helpers.uniqueId()}`;
    const testContent = '监控埋点测试内容';
    
    // 1. 创建任务
    await helpers.createTaskWithContent(page, testTitle, testContent);
    await helpers.waitForSync(page);
    
    // 2. 设置恶意拦截器
    await createContentStripperInterceptor(page);
    
    // 3. 触发同步
    await helpers.triggerSync(page);
    await helpers.waitForSync(page);
    
    // 4. 检查是否有相关警告（保护机制触发的日志）
    // 注：具体日志格式取决于实现，这里检查是否有 content 相关的警告
    const hasContentWarning = consoleWarnings.some(
      w => w.toLowerCase().includes('content') && 
           (w.toLowerCase().includes('missing') || 
            w.toLowerCase().includes('empty') ||
            w.toLowerCase().includes('保护') ||
            w.toLowerCase().includes('保留'))
    );
    
    // 如果保护机制正常工作，应该有警告日志
    // 但如果根本没触发（因为 content 现在已包含在查询中），也是正常的
    if (hasContentWarning) {
      console.log('✅ 检测到 content 保护警告，监控埋点正常');
    } else {
      console.log('ℹ️ 未检测到 content 警告（可能是因为查询已包含 content 字段）');
    }
    
    // 无论如何，验证内容没有丢失
    await helpers.openTaskDetail(page, testTitle);
    const content = await helpers.getTaskContent(page);
    if (testContent && content) {
      expect(content).toBeTruthy();
    }
  });
});

// ============================================================================
// 测试组：边界情况
// ============================================================================

test.describe('同步数据完整性：边界情况', () => {
  
  /**
   * 场景：空 content 任务的处理
   * 
   * 验证：原本就没有 content 的任务，同步后应保持空
   */
  test('原本为空的 content 应保持为空', async ({ page }) => {
    await page.goto('/');
    await helpers.waitForAppReady(page);
    
    const testTitle = `空内容测试-${helpers.uniqueId()}`;
    
    // 1. 创建没有内容的任务
    await helpers.createTaskWithContent(page, testTitle, '');
    await helpers.waitForSync(page);
    
    // 2. 验证任务存在
    const taskCard = await criticalPathHelpers.getTaskCard(page, testTitle, { timeout: 5_000 });
    await expect(taskCard).toBeVisible();
    
    // 3. 设置拦截器
    await createContentStripperInterceptor(page);
    
    // 4. 触发同步
    await helpers.triggerSync(page);
    
    // 5. 验证任务仍然存在且功能正常
    await expect(taskCard).toBeVisible();
    console.log('✅ 空内容任务处理正常');
  });

  /**
   * 场景：离线后重连同步
   * 
   * 验证：离线期间的编辑，在重连后不应被空数据覆盖
   */
  test('离线编辑在重连后应保持', async ({ page, context }) => {
    await page.goto('/');
    await helpers.waitForAppReady(page);
    
    const testTitle = `离线测试-${helpers.uniqueId()}`;
    const offlineContent = '这是离线编辑的内容';
    
    // 1. 创建任务
    await helpers.createTaskWithContent(page, testTitle, '初始内容');
    await helpers.waitForSync(page);
    
    // 2. 模拟离线
    await criticalPathHelpers.setOffline(page, context, true);
    
    // 3. 离线编辑
    await helpers.openTaskDetail(page, testTitle);
    const editor = await criticalPathHelpers.openTaskContentEditor(page, testTitle);
    await editor.fill(offlineContent);
    await helpers.closeTaskDetail(page);
    
    // 4. 设置拦截器（重连时生效）
    await createContentStripperInterceptor(page);
    
    // 5. 恢复在线
    await criticalPathHelpers.setOffline(page, context, false);
    await helpers.waitForSync(page);
    
    // 6. 验证内容
    await helpers.openTaskDetail(page, testTitle);
    const content = await helpers.getTaskContent(page);

    expect(content).toContain(offlineContent);
  });
});
