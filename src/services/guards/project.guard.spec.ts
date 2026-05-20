import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ActivatedRouteSnapshot, RouterStateSnapshot } from '@angular/router';
import { Router } from '@angular/router';
import { projectExistsGuard } from './project.guard';
import { ProjectStateService } from '../project-state.service';
import { SyncCoordinatorService } from '../sync-coordinator.service';
import { UserSessionService } from '../user-session.service';
import { ToastService } from '../toast.service';

describe('projectExistsGuard', () => {
  let projectStateMock: {
    projects: ReturnType<typeof vi.fn>;
    getProject: ReturnType<typeof vi.fn>;
  };
  let syncCoordinatorMock: {
    isLoadingRemote: ReturnType<typeof vi.fn>;
  };
  let userSessionMock: {
    prehydrateFromSnapshot: ReturnType<typeof vi.fn>;
    loadProjects: ReturnType<typeof vi.fn>;
    canAuthoritativelyRejectProjectRoute: ReturnType<typeof vi.fn>;
    isProjectAuthoritativelyAccessible: ReturnType<typeof vi.fn>;
    startupProjectCatalogStage: ReturnType<typeof vi.fn>;
  };
  let routerMock: {
    navigate: ReturnType<typeof vi.fn>;
  };
  let toastMock: {
    error: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    projectStateMock = {
      projects: vi.fn().mockReturnValue([]),
      getProject: vi.fn().mockReturnValue(null),
    };

    syncCoordinatorMock = {
      isLoadingRemote: vi.fn().mockReturnValue(false),
    };

    userSessionMock = {
      prehydrateFromSnapshot: vi.fn().mockReturnValue(false),
      loadProjects: vi.fn().mockResolvedValue(undefined),
      canAuthoritativelyRejectProjectRoute: vi.fn().mockReturnValue(true),
      isProjectAuthoritativelyAccessible: vi.fn().mockReturnValue(true),
      startupProjectCatalogStage: vi.fn().mockReturnValue('resolved'),
    };

    routerMock = {
      navigate: vi.fn().mockResolvedValue(true),
    };

    toastMock = {
      error: vi.fn(),
      info: vi.fn(),
    };

    TestBed.configureTestingModule({
      providers: [
        { provide: ProjectStateService, useValue: projectStateMock },
        { provide: SyncCoordinatorService, useValue: syncCoordinatorMock },
        { provide: UserSessionService, useValue: userSessionMock },
        { provide: Router, useValue: routerMock },
        { provide: ToastService, useValue: toastMock },
      ],
    });
  });

  it('应先用启动快照预填充项目，避免文本深链被远端加载阻塞', async () => {
    let projects: Array<{ id: string }> = [];
    projectStateMock.projects.mockImplementation(() => projects);
    projectStateMock.getProject.mockImplementation((projectId: string) =>
      projects.find((project) => project.id === projectId) ?? null,
    );
    userSessionMock.prehydrateFromSnapshot.mockImplementation(() => {
      projects = [{ id: 'project-9' }];
      return true;
    });

    const route = {
      params: { projectId: 'project-9' },
    } as unknown as ActivatedRouteSnapshot;
    const state = { url: '/projects/project-9/text' } as RouterStateSnapshot;

    const result = await TestBed.runInInjectionContext(() => projectExistsGuard(route, state));

    expect(result).toBe(true);
    expect(userSessionMock.prehydrateFromSnapshot).toHaveBeenCalledTimes(1);
    expect(userSessionMock.loadProjects).not.toHaveBeenCalled();
    expect(routerMock.navigate).not.toHaveBeenCalled();
  });

  it('partial 启动目录下不应提前把合法 deep-link 重定向到 /projects', async () => {
    projectStateMock.projects.mockReturnValue([{ id: 'project-1' }]);
    projectStateMock.getProject.mockReturnValue(null);
    userSessionMock.canAuthoritativelyRejectProjectRoute.mockReturnValue(false);
    userSessionMock.startupProjectCatalogStage.mockReturnValue('partial');
    syncCoordinatorMock.isLoadingRemote.mockReturnValue(false);

    const route = {
      params: { projectId: 'project-9' },
    } as unknown as ActivatedRouteSnapshot;
    const state = { url: '/projects/project-9' } as RouterStateSnapshot;

    const result = await TestBed.runInInjectionContext(() => projectExistsGuard(route, state));

    expect(result).toBe(true);
    expect(routerMock.navigate).not.toHaveBeenCalled();
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it('resolved 目录下目标项目缺失时应回退到 /projects', async () => {
    projectStateMock.projects.mockReturnValue([{ id: 'project-1' }]);
    projectStateMock.getProject.mockReturnValue(null);
    userSessionMock.canAuthoritativelyRejectProjectRoute.mockReturnValue(true);
    userSessionMock.startupProjectCatalogStage.mockReturnValue('resolved');
    syncCoordinatorMock.isLoadingRemote.mockReturnValue(false);

    const route = {
      params: { projectId: 'project-9' },
    } as unknown as ActivatedRouteSnapshot;
    const state = { url: '/projects/project-9' } as RouterStateSnapshot;

    const result = await TestBed.runInInjectionContext(() => projectExistsGuard(route, state));

    expect(result).toBe(false);
    expect(toastMock.error).toHaveBeenCalledWith(
      '项目不存在',
      '请求的项目可能已被删除或您没有访问权限',
    );
    expect(routerMock.navigate).toHaveBeenCalledWith(['/projects']);
  });

  it('本地仍保留项目壳但 authoritative 目录已判定不可访问时，应拒绝 deep-link', async () => {
    projectStateMock.projects.mockReturnValue([{ id: 'project-9' }]);
    projectStateMock.getProject.mockReturnValue({ id: 'project-9' });
    userSessionMock.canAuthoritativelyRejectProjectRoute.mockReturnValue(true);
    userSessionMock.isProjectAuthoritativelyAccessible.mockReturnValue(false);

    const route = {
      params: { projectId: 'project-9' },
    } as unknown as ActivatedRouteSnapshot;
    const state = { url: '/projects/project-9' } as RouterStateSnapshot;

    const result = await TestBed.runInInjectionContext(() => projectExistsGuard(route, state));

    expect(result).toBe(false);
    expect(routerMock.navigate).toHaveBeenCalledWith(['/projects']);
    expect(toastMock.error).toHaveBeenCalledWith(
      '项目不存在',
      '请求的项目可能已被删除或您没有访问权限',
    );
  });

  it('远端加载后的二次检查若 authoritative 判定不可访问，仍应拒绝 deep-link', async () => {
    projectStateMock.projects.mockReturnValue([{ id: 'project-1' }]);
    projectStateMock.getProject
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({ id: 'project-9' });
    syncCoordinatorMock.isLoadingRemote.mockReturnValue(true);
    userSessionMock.canAuthoritativelyRejectProjectRoute.mockReturnValue(true);
    userSessionMock.isProjectAuthoritativelyAccessible.mockReturnValue(false);

    const route = {
      params: { projectId: 'project-9' },
    } as unknown as ActivatedRouteSnapshot;
    const state = { url: '/projects/project-9' } as RouterStateSnapshot;

    const result = await TestBed.runInInjectionContext(() => projectExistsGuard(route, state));

    expect(result).toBe(false);
    expect(routerMock.navigate).toHaveBeenCalledWith(['/projects']);
    expect(toastMock.error).toHaveBeenCalledWith(
      '项目不存在',
      '请求的项目可能已被删除或您没有访问权限',
    );
  });
});
