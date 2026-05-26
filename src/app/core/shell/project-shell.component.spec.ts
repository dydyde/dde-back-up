import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ProjectShellComponent } from './project-shell.component';

type ProjectShellDeepLinkContext = {
  isDestroyed: boolean;
  projectState: {
    tasks: () => unknown[];
    getTask: () => unknown;
  };
  syncCoordinator: {
    isLoadingRemote: () => boolean;
  };
  toast: {
    warning: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
  };
  navigateToProjectList: ReturnType<typeof vi.fn>;
  activateFlowIntent: ReturnType<typeof vi.fn>;
  setActiveView: ReturnType<typeof vi.fn>;
  taskOpsAdapter: {
    addFloatingTask: ReturnType<typeof vi.fn>;
  };
  deepLinkRetryTimer: ReturnType<typeof setTimeout> | null;
};

describe('ProjectShellComponent startup entry fallback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('handleTaskDeepLink 应在 shortcut 深链接任务失效时立即回退到工作区', () => {
    const warning = vi.fn();
    const info = vi.fn();
    const navigateToProjectList = vi.fn();
    const activateFlowIntent = vi.fn();
    const setActiveView = vi.fn();
    const context: ProjectShellDeepLinkContext = {
      isDestroyed: false,
      projectState: {
        tasks: () => [],
        getTask: () => null,
      },
      syncCoordinator: {
        isLoadingRemote: () => false,
      },
      toast: {
        warning,
        info,
      },
      navigateToProjectList,
      activateFlowIntent,
      setActiveView,
      taskOpsAdapter: {
        addFloatingTask: vi.fn(),
      },
      deepLinkRetryTimer: null,
    };

    const result = (ProjectShellComponent.prototype as unknown as {
      handleTaskDeepLink: (
        this: ProjectShellComponent,
        taskId: string,
        options?: { degradeToWorkspaceOnMissing?: boolean }
      ) => 'flow' | 'workspace' | 'pending';
    }).handleTaskDeepLink.call(context as unknown as ProjectShellComponent, 'task-missing', { degradeToWorkspaceOnMissing: true });

    expect(result).toBe('workspace');
    expect(warning).toHaveBeenCalledWith('任务不存在', '请求的任务已失效，已返回工作区');
    expect(navigateToProjectList).toHaveBeenCalledTimes(1);
    expect(activateFlowIntent).not.toHaveBeenCalled();
    expect(setActiveView).not.toHaveBeenCalled();
    expect(context.deepLinkRetryTimer).toBeNull();
  });

  it('handleTaskDeepLink 应在数据仍在加载时保持 pending 且不提前切换到 flow', () => {
    const warning = vi.fn();
    const info = vi.fn();
    const navigateToProjectList = vi.fn();
    const activateFlowIntent = vi.fn();
    const setActiveView = vi.fn();
    const context: ProjectShellDeepLinkContext = {
      isDestroyed: false,
      projectState: {
        tasks: () => [],
        getTask: () => null,
      },
      syncCoordinator: {
        isLoadingRemote: () => true,
      },
      toast: {
        warning,
        info,
      },
      navigateToProjectList,
      activateFlowIntent,
      setActiveView,
      taskOpsAdapter: {
        addFloatingTask: vi.fn(),
      },
      deepLinkRetryTimer: null,
    };

    const result = (ProjectShellComponent.prototype as unknown as {
      handleTaskDeepLink: (
        this: ProjectShellComponent,
        taskId: string,
        options?: { degradeToWorkspaceOnMissing?: boolean }
      ) => 'flow' | 'workspace' | 'pending';
    }).handleTaskDeepLink.call(context as unknown as ProjectShellComponent, 'task-loading', { degradeToWorkspaceOnMissing: true });

    expect(result).toBe('pending');
    expect(context.deepLinkRetryTimer).not.toBeNull();
    expect(warning).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(navigateToProjectList).not.toHaveBeenCalled();
    expect(activateFlowIntent).not.toHaveBeenCalled();
    expect(setActiveView).not.toHaveBeenCalled();
  });
});

describe('ProjectShellComponent route project selection', () => {
  it('handleRouteChange 应通过 UserSession 切换项目以触发空壳补水', () => {
    const switchActiveProject = vi.fn();
    const notifyProjectOpen = vi.fn();
    const applyStateAwareFlowRestore = vi.fn();
    const setActiveView = vi.fn();
    const context = {
      route: {
        snapshot: {
          params: { projectId: 'project-1' },
          firstChild: {
            params: {},
          },
        },
      },
      router: {
        url: '/projects/project-1/text',
      },
      handoffCoordinator: {
        result: () => ({ kind: 'full' }),
      },
      startupLaunchSnapshot: null,
      startupRouteDecisionResolved: false,
      uiState: {
        isMobile: () => true,
      },
      projectState: {
        activeProjectId: () => null,
        getProject: () => ({ id: 'project-1', name: 'Real Project' }),
        projects: () => [{ id: 'project-1', name: 'Real Project' }],
      },
      userSession: {
        switchActiveProject,
      },
      tabSync: {
        notifyProjectOpen,
      },
      handleTaskDeepLink: vi.fn(),
      cancelFlowStateAwareTimers: vi.fn(),
      activateFlowIntent: vi.fn(),
      setActiveView,
      applyStateAwareFlowRestore,
      toast: {
        info: vi.fn(),
      },
    } as unknown as ProjectShellComponent;

    (ProjectShellComponent.prototype as unknown as {
      handleRouteChange: (this: ProjectShellComponent) => void;
    }).handleRouteChange.call(context);

    expect(switchActiveProject).toHaveBeenCalledWith('project-1');
    expect(notifyProjectOpen).toHaveBeenCalledWith('project-1', 'Real Project');
    expect(setActiveView).toHaveBeenCalledWith('text');
    expect(applyStateAwareFlowRestore).not.toHaveBeenCalled();
  });
});

describe('ProjectShellComponent flow view loading contract', () => {
  it('桌面端应直接渲染 FlowView，只有移动端保留 @defer 懒加载', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/app/core/shell/project-shell.component.ts'),
      'utf-8'
    );

    const flowColumnStart = source.indexOf('<!-- Flow Column - 移动端条件渲染，桌面端始终显示 -->');
    expect(flowColumnStart).toBeGreaterThanOrEqual(0);

    const flowColumnEnd = source.indexOf('@defer (on timer(300))', flowColumnStart);
    expect(flowColumnEnd).toBeGreaterThan(flowColumnStart);

    const flowColumn = source.slice(flowColumnStart, flowColumnEnd);
    const desktopFlowBranch = flowColumn.match(
      /@if \(!uiState\.isMobile\(\)\) \{\s*<app-flow-view class="flex-1 min-h-0 overflow-hidden relative" \(goBackToText\)="switchToText\(\)"><\/app-flow-view>\s*\} @else \{/s
    )?.[0];

    expect(desktopFlowBranch).toBeDefined();
    expect(desktopFlowBranch).not.toContain('@defer');
    expect(desktopFlowBranch).not.toContain('流程图加载失败');
    expect(flowColumn).toContain('@defer (when shouldLoadFlowNow(); prefetch when shouldPrefetchFlowChunk())');
  });
});
