import { test, expect, Page } from '@playwright/test';
import { getTestEnvConfig, testHelpers, createdTestData } from './critical-paths/helpers';

const STORE_CACHE_DB_NAME = 'nanoflow-store-cache';
const SYNC_CURSORS_STORE = 'sync_cursors';

interface PersistedProjectCursorRecord {
  key: string;
  projectId: string;
  cursor: {
    updatedAt: string;
    entityType: 'project' | 'task' | 'connection';
    id: string;
  };
}

async function readLastSyncMarker(page: Page): Promise<string | null> {
  return page
    .locator('[data-testid="sync-status-indicator"]')
    .first()
    .getAttribute('data-testid-last-sync')
    .catch(() => null);
}

async function ensureCloudEditor(page: Page): Promise<void> {
  await page.goto('/');
  await testHelpers.waitForAppReady(page);
  await testHelpers.ensureCloudAuthenticated(page);
  await testHelpers.ensureEditorReady(page, { mode: 'cloud' });
}

async function openCloudProject(page: Page, projectName: string, timeout = 30_000): Promise<void> {
  const deadline = Date.now() + timeout;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      await page.goto('/');
      await testHelpers.waitForAppReady(page);
      await testHelpers.ensureEditorReady(page, { mode: 'cloud' });

      const projectItem = page.locator(`[data-testid="project-item"]:has-text("${projectName}")`).first();
      if (await testHelpers.isElementVisible(projectItem, 3_000)) {
        await projectItem.click({ force: true });
        await expect(page.locator('[data-testid="add-task-btn"]')).toBeVisible({ timeout: 10_000 });
        return;
      }
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`未能在云端打开测试项目 ${projectName}: ${String(lastError ?? 'timeout')}`);
}

async function triggerProjectRefresh(page: Page): Promise<void> {
  const previousSyncMarker = await readLastSyncMarker(page);
  const refreshButton = page
    .locator('[data-testid="sync-resync-project-btn"], button[title="刷新同步当前项目"]')
    .first();

  if (await testHelpers.isElementVisible(refreshButton, 2_000)) {
    await refreshButton.click({ force: true });
    await testHelpers.waitForCloudSyncSettled(page, {
      timeout: 20_000,
      observeActivity: true,
      previousSyncMarker,
    });
    return;
  }

  await page.reload();
  await testHelpers.waitForAppReady(page);
  await testHelpers.ensureEditorReady(page, { mode: 'cloud' });
}

async function waitForProjectCursor(
  page: Page,
  projectId: string,
  timeout = 15_000,
): Promise<PersistedProjectCursorRecord> {
  let latest: PersistedProjectCursorRecord | null = null;

  await expect
    .poll(async () => {
      const records = await page.evaluate(async ({ dbName, storeName }) => {
        return new Promise<PersistedProjectCursorRecord[]>((resolve, reject) => {
          const request = indexedDB.open(dbName);
          request.onerror = () => reject(request.error ?? new Error(`open ${dbName} failed`));
          request.onsuccess = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(storeName)) {
              db.close();
              resolve([]);
              return;
            }

            const tx = db.transaction(storeName, 'readonly');
            const store = tx.objectStore(storeName);
            const allRequest = store.getAll();
            allRequest.onerror = () => {
              db.close();
              reject(allRequest.error ?? new Error(`read ${storeName} failed`));
            };
            allRequest.onsuccess = () => {
              db.close();
              resolve(allRequest.result as PersistedProjectCursorRecord[]);
            };
          };
        });
      }, { dbName: STORE_CACHE_DB_NAME, storeName: SYNC_CURSORS_STORE });
      latest = records.find(record => record.projectId === projectId) ?? null;
      return latest?.cursor.updatedAt ?? null;
    }, { timeout, intervals: [300, 500, 1_000] })
    .not.toBeNull();

  if (!latest) {
    throw new Error(`未找到项目 ${projectId} 的同步游标`);
  }
  return latest;
}

function decodeUpdatedAtGt(rawUrl: string): string | null {
  const url = new URL(rawUrl);
  const value = url.searchParams
    .getAll('updated_at')
    .find(candidate => candidate.startsWith('gt.'));
  return value ? value.slice(3) : null;
}

test.beforeEach(() => {
  const { TEST_USER_EMAIL, TEST_USER_PASSWORD } = getTestEnvConfig();
  test.skip(!TEST_USER_EMAIL || !TEST_USER_PASSWORD, '跳过：未配置 TEST_USER_EMAIL / TEST_USER_PASSWORD');
});

test.describe.configure({ mode: 'serial' });

test.describe('Realtime / local-first consistency', () => {
  test('follower refresh uses the persisted combination cursor with a safety lookback', async ({ browser }) => {
    const contextA = await browser.newContext();
    const pageA = await contextA.newPage();
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    const capturedTaskDeltaUrls: string[] = [];

    try {
      await ensureCloudEditor(pageA);

      const projectName = `游标回看-${testHelpers.uniqueId()}`;
      const projectId = await testHelpers.createTestProject(pageA, projectName);
      expect(projectId).not.toBeNull();
      if (!projectId) {
        throw new Error('创建测试项目失败：无法获取 projectId');
      }
      testHelpers.trackProjectId(projectId);

      const firstTitle = `首个远端任务-${testHelpers.uniqueId()}`;
      testHelpers.trackTaskTitle(firstTitle);
      await testHelpers.createTask(pageA, firstTitle);
      await testHelpers.waitForCloudSyncSettled(pageA, { timeout: 20_000, observeActivity: true });

      await ensureCloudEditor(pageB);
      await openCloudProject(pageB, projectName);
      await testHelpers.waitForTaskCard(pageB, firstTitle, { timeout: 20_000 });
      await triggerProjectRefresh(pageB);

      const firstCursor = await waitForProjectCursor(pageB, projectId);
      const firstCursorMs = new Date(firstCursor.cursor.updatedAt).getTime();
      expect(Number.isFinite(firstCursorMs)).toBe(true);

      await pageB.route('**/rest/v1/tasks*', async (route) => {
        if (route.request().method() === 'GET') {
          const updatedAtGt = decodeUpdatedAtGt(route.request().url());
          if (updatedAtGt) {
            capturedTaskDeltaUrls.push(route.request().url());
          }
        }
        await route.continue();
      });

      const secondTitle = `同水位后续任务-${testHelpers.uniqueId()}`;
      testHelpers.trackTaskTitle(secondTitle);
      await testHelpers.createTask(pageA, secondTitle);
      await testHelpers.waitForCloudSyncSettled(pageA, { timeout: 20_000, observeActivity: true });

      await triggerProjectRefresh(pageB);
      await testHelpers.waitForTaskCard(pageB, secondTitle, { timeout: 20_000 });

      expect(capturedTaskDeltaUrls.length).toBeGreaterThan(0);
      const firstDeltaSince = decodeUpdatedAtGt(capturedTaskDeltaUrls[0]);
      expect(firstDeltaSince).not.toBeNull();
      const firstDeltaSinceMs = new Date(firstDeltaSince ?? '').getTime();
      expect(Number.isFinite(firstDeltaSinceMs)).toBe(true);
      expect(firstDeltaSinceMs).toBeLessThan(firstCursorMs);
    } finally {
      await pageA.close().catch(() => undefined);
      await contextA.close().catch(() => undefined);
      await pageB.close().catch(() => undefined);
      await contextB.close().catch(() => undefined);
    }
  });

  test('offline local write survives reconnect and becomes visible to another session', async ({ browser }) => {
    const contextA = await browser.newContext();
    const pageA = await contextA.newPage();
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();

    try {
      await ensureCloudEditor(pageA);

      const projectName = `本地优先同步-${testHelpers.uniqueId()}`;
      const projectId = await testHelpers.createTestProject(pageA, projectName);
      expect(projectId).not.toBeNull();
      if (projectId) {
        testHelpers.trackProjectId(projectId);
      }

      await testHelpers.setOffline(pageA, contextA, true);
      await testHelpers.waitForOfflineIndicator(pageA, { timeout: 10_000 });

      const offlineTitle = `离线本地写入-${testHelpers.uniqueId()}`;
      testHelpers.trackTaskTitle(offlineTitle);
      await testHelpers.createTask(pageA, offlineTitle);
      await testHelpers.waitForTaskCard(pageA, offlineTitle, { timeout: 10_000 });

      await testHelpers.setOffline(pageA, contextA, false);
      await testHelpers.waitForCloudSyncSettled(pageA, { timeout: 25_000, observeActivity: true });
      await pageA.reload();
      await testHelpers.waitForAppReady(pageA);
      await testHelpers.ensureEditorReady(pageA, { mode: 'cloud' });
      await testHelpers.waitForTaskCard(pageA, offlineTitle, { timeout: 15_000 });

      await ensureCloudEditor(pageB);
      await openCloudProject(pageB, projectName);
      await triggerProjectRefresh(pageB);
      await testHelpers.waitForTaskCard(pageB, offlineTitle, { timeout: 25_000 });
    } finally {
      await testHelpers.setOffline(pageA, contextA, false).catch(() => undefined);
      await pageA.close().catch(() => undefined);
      await contextA.close().catch(() => undefined);
      await pageB.close().catch(() => undefined);
      await contextB.close().catch(() => undefined);
    }
  });
});

test.afterEach(() => {
  createdTestData.projectIds.clear();
  createdTestData.taskTitles.clear();
});
