import { Injectable, inject, effect, untracked, Injector, Signal, EffectRef, NgZone } from '@angular/core';
import { ProjectStateService } from '../../../../services/project-state.service';
import { UiStateService } from '../../../../services/ui-state.service';
import { PreferenceService } from '../../../../services/preference.service';
import { FlowDiagramService } from './flow-diagram.service';
import { FlowCommandService } from './flow-command.service';
import { LoggerService } from '../../../../services/logger.service';
import { Task } from '../../../../models';
import { ExternalSourceLinkService } from '../../../core/external-sources/external-source-link.service';

/**
 * 图表响应式效果服务
 * 
 * 统一管理流程图视图的 effect 逻辑：
 * - 任务数据变化时更新图表
 * - 跨树连接变化时更新图表
 * - 搜索查询变化时更新图表高亮
 * - 主题变化时更新节点颜色
 * - 选中状态同步
 * - 命令服务订阅
 */
@Injectable({ providedIn: 'root' })
export class FlowDiagramEffectsService {
  private readonly projectState = inject(ProjectStateService);
  private readonly uiState = inject(UiStateService);
  private readonly preference = inject(PreferenceService);
  private readonly diagram = inject(FlowDiagramService);
  private readonly flowCommand = inject(FlowCommandService);
  private readonly logger = inject(LoggerService);
  private readonly zone = inject(NgZone);
  private readonly externalSourceLinks = inject(ExternalSourceLinkService, { optional: true });

  /** rAF 调度 ID（用于取消） */
  private pendingRafId: number | null = null;
  /** 是否有待处理的图表更新 */
  private diagramUpdatePending = false;

  /**
   * 使用 requestAnimationFrame 调度图表更新
   * 将多个 signal 变化合并到同一帧
   * 【2026-02-15 优化】增加 rAF 合并窗口，确保同一帧内的多个 effect 触发只执行一次更新
   * 【2026-02-24 修复】isDestroyed 改为 getter 函数，避免 rAF 回调捕获到过期的布尔值
   */
  scheduleRafDiagramUpdate(tasks: Task[], forceUpdate: boolean, isDestroyed: () => boolean): void {
    if (forceUpdate) this.diagramUpdatePending = true;
    if (this.pendingRafId !== null) return;
    // 【2026-02-25 性能优化】在 NgZone 外部注册 rAF
    // 避免 GoJS diagram 更新操作触发 Angular 变更检测
    this.zone.runOutsideAngular(() => {
      this.pendingRafId = requestAnimationFrame(() => {
        this.pendingRafId = null;
        if (isDestroyed() || !this.diagram.isInitialized) return;
        // 使用 untracked 避免在 rAF 回调中读取 signal 时建立新的依赖
        const currentTasks = untracked(() => this.projectState.tasks());
        this.diagram.updateDiagram(currentTasks, this.diagramUpdatePending);
        this.diagramUpdatePending = false;
      });
    });
  }

  /** 获取当前 rAF ID（用于组件清理） */
  getPendingRafId(): number | null { return this.pendingRafId; }

  /** 取消待处理的 rAF */
  cancelPendingRaf(): void {
    if (this.pendingRafId !== null) {
      cancelAnimationFrame(this.pendingRafId);
      this.pendingRafId = null;
    }
  }

  /**
   * 创建任务数据变化 effect
   * 监听任务数据变化，使用 rAF 对齐渲染帧更新图表
   * 【2026-02-24】返回 EffectRef 以便组件在 ngOnDestroy 中主动销毁，避免 @defer 拆除时竞态
   */
  createTasksEffect(
    injector: Injector,
    scheduleRafDiagramUpdate: (tasks: Task[], forceRefresh: boolean) => void
  ): EffectRef {
    return effect(() => {
      const tasks = this.projectState.tasks();
      if (this.diagram.isInitialized) {
        scheduleRafDiagramUpdate(tasks, false);
      }
    }, { injector });
  }

  /**
   * 创建跨树连接变化 effect
   * 监听 connections 变化（软删除和恢复）
   */
  // 【P2-26 修复】保存上次连接签名，只在真正变化时才触发更新
  private lastConnectionSignature = '';
  private lastExternalSourceLinkSignature = '';
  
  createConnectionsEffect(
    injector: Injector,
    scheduleRafDiagramUpdate: (tasks: Task[], forceRefresh: boolean) => void
  ): EffectRef {
    return effect(() => {
      const project = this.projectState.activeProject();
      // 构建有效连接的签名（过滤掉 deletedAt，只统计活跃连接）
      const activeConnections = project?.connections?.filter((c: { deletedAt?: string | null }) => !c.deletedAt) ?? [];
      const connectionSignature = activeConnections
        .map((c: { source: string; target: string; title?: string; description?: string; updatedAt?: string }) =>
          `${c.source}->${c.target}|${c.title ?? ''}|${c.description ?? ''}|${c.updatedAt ?? ''}`
        )
        .sort()
        .join('|');
      // 只在签名实际变化时才触发更新
      if (connectionSignature !== this.lastConnectionSignature && this.diagram.isInitialized) {
        this.lastConnectionSignature = connectionSignature;
        scheduleRafDiagramUpdate(this.projectState.tasks(), true);
      }
    }, { injector });
  }

  createExternalSourceLinksEffect(
    injector: Injector,
    scheduleRafDiagramUpdate: (tasks: Task[], forceRefresh: boolean) => void
  ): EffectRef {
    return effect(() => {
      const linkSignature = this.externalSourceLinks?.activeLinks()
        .map(link => [
          link.taskId,
          link.sourceType,
          link.targetId,
          String(link.sortOrder),
          link.label ?? '',
          link.hpath ?? '',
          link.updatedAt,
        ].join('|'))
        .sort()
        .join('|') ?? '';
      if (linkSignature !== this.lastExternalSourceLinkSignature && this.diagram.isInitialized) {
        this.lastExternalSourceLinkSignature = linkSignature;
        scheduleRafDiagramUpdate(this.projectState.tasks(), true);
      }
    }, { injector });
  }


  /**
   * 创建搜索查询变化 effect
   */
  createSearchEffect(
    injector: Injector,
    scheduleRafDiagramUpdate: (tasks: Task[], forceRefresh: boolean) => void
  ): EffectRef {
    return effect(() => {
      const _query = this.uiState.searchQuery();
      if (this.diagram.isInitialized) {
        scheduleRafDiagramUpdate(this.projectState.tasks(), true);
      }
    }, { injector });
  }

  /**
   * 创建主题变化 effect
   */
  createThemeEffect(
    injector: Injector,
    scheduleRafDiagramUpdate: (tasks: Task[], forceRefresh: boolean) => void
  ): EffectRef {
    return effect(() => {
      const _theme = this.preference.theme();
      if (this.diagram.isInitialized) {
        scheduleRafDiagramUpdate(this.projectState.tasks(), true);
      }
    }, { injector });
  }

  /**
   * 创建选中状态同步 effect
   * 当新任务创建后，GoJS 图表可能还未更新，需要延迟重试
   */
  createSelectionSyncEffect(
    injector: Injector,
    selectedTaskId: Signal<string | null>,
    selectNodeWithRetry: (taskId: string) => void
  ): EffectRef {
    return effect(() => {
      const selectedId = selectedTaskId();
      if (selectedId && this.diagram.isInitialized) {
        selectNodeWithRetry(selectedId);
      }
    }, { injector });
  }

  /**
   * 创建居中命令订阅 effect
   */
  createCenterCommandEffect(
    injector: Injector,
    executeCenterOnNode: (taskId: string, openDetail: boolean) => void
  ): EffectRef {
    return effect(() => {
      const cmd = this.flowCommand.centerNodeCommand();
      if (cmd) {
        untracked(() => {
          if (this.diagram.isInitialized) {
            executeCenterOnNode(cmd.taskId, cmd.openDetail);
            this.flowCommand.clearCenterCommand();
          }
        });
      }
    }, { injector });
  }

  /**
   * 创建重试初始化命令订阅 effect
   */
  createRetryCommandEffect(
    injector: Injector,
    retryInitDiagram: () => void
  ): EffectRef {
    return effect(() => {
      const count = this.flowCommand.retryDiagramCommand();
      if (count > 0) {
        untracked(() => {
          retryInitDiagram();
        });
      }
    }, { injector });
  }
}
