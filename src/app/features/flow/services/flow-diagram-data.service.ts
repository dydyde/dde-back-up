import { Injectable, inject } from '@angular/core';
import { ProjectStateService } from '../../../../services/project-state.service';
import { UiStateService } from '../../../../services/ui-state.service';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
import { SyncCoordinatorService } from '../../../../services/sync-coordinator.service';
import { LoggerService } from '../../../../services/logger.service';
import { ToastService } from '../../../../services/toast.service';
import { DockEngineService } from '../../../../services/dock-engine.service';
import { FlowDiagramConfigService, type GoJSLinkData } from './flow-diagram-config.service';
import { FlowZoomService } from './flow-zoom.service';
import { Task } from '../../../../models';
import * as go from 'gojs';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';

type FlowLinkDataWithPorts = GoJSLinkData & {
  fromPortId: string;
  toPortId: string;
  points?: unknown;
};

/**
 * FlowDiagramDataService - 图表数据同步、导出与视图状态管理
 *
 * 职责：
 * - 图表数据更新（updateDiagram）
 * - 导出 PNG/SVG
 * - 视图状态保存/恢复
 * - Flow 视图激活时的自动适配
 *
 * 从 FlowDiagramService 拆分而来，降低单文件复杂度
 */
@Injectable({
  providedIn: 'root'
})
export class FlowDiagramDataService {
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly projectState = inject(ProjectStateService);
  private readonly uiState = inject(UiStateService);
  private readonly taskOps = inject(TaskOperationAdapterService);
  private readonly syncCoordinator = inject(SyncCoordinatorService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('FlowDiagramData');
  private readonly toast = inject(ToastService);
  private readonly dockEngine = inject(DockEngineService);
  private readonly configService = inject(FlowDiagramConfigService);
  private readonly zoomService = inject(FlowZoomService);

  // ========== GoJS Diagram 引用 ==========
  private diagram: go.Diagram | null = null;

  // ========== 定时器 ==========
  private viewStateSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private restoreViewStateTimer: ReturnType<typeof setTimeout> | null = null;
  private autoFitTimer: ReturnType<typeof setTimeout> | null = null;

  // ========== 标志 ==========
  private isFirstLoad = true;
  private _familyColorLogged = false;
  private pendingAutoFitToContents = false;

  // ========== 【2026-02-25 性能优化】增量更新缓存 ==========
  /**
   * 上一次成功更新图表时的任务指纹（key: updatedAt + title + parentId + stage + status + parkingMeta）
   * 用于跳过无变化的 buildDiagramData 全量重建
   */
  private lastTaskFingerprint = '';
  private lastConnectionSignatureForData = '';
  private lastSearchQuery = '';
  private lastDockFingerprint = '';

  // ========== 外部设置 ==========

  /**
   * 由 FlowDiagramService 在初始化后调用，传入 diagram 实例
   */
  setDiagram(diagram: go.Diagram | null): void {
    const wasDetached = this.diagram === null;
    this.diagram = diagram;
    if (diagram && wasDetached) {
      this.isFirstLoad = true;
      this._familyColorLogged = false;
      this.pendingAutoFitToContents = false;
    }
  }

  // ========== 导出功能 ==========

  async exportToPng(): Promise<Blob | null> {
    if (!this.diagram) {
      this.toast.error('导出失败', '流程图未加载');
      return null;
    }

    try {
      const imgData = this.diagram.makeImageData({
        scale: 2,
        background: '#F5F2E9',
        type: 'image/png',
        maxSize: new go.Size(4096, 4096)
      }) as string;

      if (!imgData) {
        this.toast.error('导出失败', '无法生成图片');
        return null;
      }

      const response = await fetch(imgData);
      const blob = await response.blob();

      this.downloadBlob(blob, `流程图_${this.getExportFileName()}.png`);
      this.toast.success('导出成功', 'PNG 图片已下载');

      return blob;
    } catch (error) {
      this.logger.error('导出 PNG 失败', error);
      this.sentryLazyLoader.captureException(error, { tags: { operation: 'exportToPng' } });
      this.toast.error('导出失败', '生成图片时发生错误');
      // eslint-disable-next-line no-restricted-syntax -- 返回 null 语义正确：导出失败已通过 toast 通知用户
      return null;
    }
  }

  async exportToSvg(): Promise<Blob | null> {
    if (!this.diagram) {
      this.toast.error('导出失败', '流程图未加载');
      return null;
    }

    try {
      const svg = this.diagram.makeSvg({
        scale: 1,
        background: '#F5F2E9',
        maxSize: new go.Size(4096, 4096)
      });

      if (!svg) {
        this.toast.error('导出失败', '无法生成 SVG');
        return null;
      }

      const serializer = new XMLSerializer();
      const svgString = serializer.serializeToString(svg);
      const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });

      this.downloadBlob(blob, `流程图_${this.getExportFileName()}.svg`);
      this.toast.success('导出成功', 'SVG 图片已下载');

      return blob;
    } catch (error) {
      this.logger.error('导出 SVG 失败', error);
      this.sentryLazyLoader.captureException(error, { tags: { operation: 'exportToSvg' } });
      this.toast.error('导出失败', '生成 SVG 时发生错误');
      // eslint-disable-next-line no-restricted-syntax -- 返回 null 语义正确：导出失败已通过 toast 通知用户
      return null;
    }
  }

  private getExportFileName(): string {
    const project = this.projectState.activeProject();
    const projectName = project?.name || '未命名项目';
    const date = new Date().toISOString().slice(0, 10);
    return `${projectName}_${date}`;
  }

  private downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  // ========== 图表数据更新 ==========

  private detectStructuralChange(currentNodeMap: Map<string, go.ObjectData>, newTasks: Task[]): boolean {
    if (currentNodeMap.size !== newTasks.length) {
      return true;
    }

    for (const task of newTasks) {
      const existing = currentNodeMap.get(task.id);
      if (!existing) {
        return true;
      }

      if (existing.stage !== task.stage ||
          existing.status !== task.status ||
          existing.parentId !== task.parentId) {
        return true;
      }
    }

    const newTaskIds = new Set(newTasks.map(t => t.id));
    for (const key of currentNodeMap.keys()) {
      if (!newTaskIds.has(key)) {
        return true;
      }
    }

    const project = this.projectState.activeProject();
    if (project) {
      const model = this.diagram?.model as go.GraphLinksModel;
      if (model) {
        const currentLinkCount = (model.linkDataArray || []).length;
        const parentChildCount = newTasks.filter(t => t.parentId).length;
        const crossTreeCount = project.connections?.filter(c => !c.deletedAt).length || 0;
        const expectedLinkCount = parentChildCount + crossTreeCount;
        if (currentLinkCount !== expectedLinkCount) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * 更新图表数据
   */
  updateDiagram(tasks: Task[], forceRefresh: boolean = false): void {
    if (!this.diagram) {
      return;
    }

    const project = this.projectState.activeProject();
    if (!project) {
      return;
    }

    try {
      const lastUpdateType = this.taskOps.getLastUpdateType();
      const model = this.diagram.model as go.GraphLinksModel;
      const activeTasks = tasks.filter(t => !t.deletedAt);
      const searchQuery = this.uiState.searchQuery();

      // 【2026-04-24 性能优化】先做最便宜的指纹短路，避免 30+ 任务场景下
      // 每次 signal emission 都执行 O(n) 的 currentNodeMap 构建 + detectStructuralChange。
      // 指纹已覆盖 title/updatedAt/parentId/stage/status/parkingMeta，再叠加连接与
      // docks/search 指纹，足以判断“任何影响图表显示的字段是否变化”。
      if (!forceRefresh) {
        const taskFingerprint = this.computeTaskFingerprint(activeTasks);
        const dockFingerprint = this.computeDockFingerprint();
        const activeConns = project.connections?.filter(c => !c.deletedAt) ?? [];
        const connSig = this.computeConnectionSignature(activeConns);

        if (taskFingerprint === this.lastTaskFingerprint
            && connSig === this.lastConnectionSignatureForData
            && searchQuery === this.lastSearchQuery
            && dockFingerprint === this.lastDockFingerprint) {
          return; // 数据无变化，跳过重建
        }
      }

      // 仅在可能需要重建时才构建 node 映射，并复用为 existingNodeMap（避免两次 O(n) 扫描）
      const currentNodeMap = new Map<string, go.ObjectData>();
      (model.nodeDataArray || []).forEach((n: go.ObjectData) => {
        if (n.key) currentNodeMap.set(n.key as string, n);
      });

      const currentLinkMap = new Map<string, go.ObjectData>();
      (model.linkDataArray || []).forEach((link: go.ObjectData) => {
        if (link.key) currentLinkMap.set(link.key as string, link);
      });

      const hasStructuralChange = this.detectStructuralChange(currentNodeMap, activeTasks);

      if (lastUpdateType === 'position' && !forceRefresh && !hasStructuralChange) {
        return;
      }

      const existingNodeMap = currentNodeMap;

      const diagramData = this.configService.buildDiagramData(
        activeTasks,
        project,
        searchQuery,
        existingNodeMap,
        {
          dockedTaskIds: this.dockEngine.dockedTaskIds(),
          focusedTaskId: this.dockEngine.focusingEntry()?.taskId ?? null,
        },
      );

      const selectedKeys = new Set<string>();
      this.diagram.selection.each((part: go.Part) => {
        if (part.data?.key) {
          selectedKeys.add(part.data.key);
        }
      });

      this.diagram.startTransaction('update');
      this.diagram.skipsUndoManager = true;

      model.mergeNodeDataArray(diagramData.nodeDataArray);

      const nextNodeMap = new Map<string, go.ObjectData>();
      diagramData.nodeDataArray.forEach(node => nextNodeMap.set(node.key, node as go.ObjectData));
      const linkDataWithPorts = diagramData.linkDataArray.map(link =>
        this.buildLinkDataWithPorts(link, currentLinkMap, currentNodeMap, nextNodeMap)
      );

      model.mergeLinkDataArray(linkDataWithPorts);

      const nodeKeys = new Set(diagramData.nodeDataArray.map(n => n.key));
      const linkKeys = new Set(diagramData.linkDataArray.map(l => l.key));

      const nodesToRemove = model.nodeDataArray.filter((n: go.ObjectData) => !nodeKeys.has(n.key as string));
      nodesToRemove.forEach((n: go.ObjectData) => model.removeNodeData(n));

      const linksToRemove = model.linkDataArray.filter((l: go.ObjectData) => !linkKeys.has(l.key as string));
      linksToRemove.forEach((l: go.ObjectData) => model.removeLinkData(l));

      this.diagram.skipsUndoManager = false;
      this.diagram.commitTransaction('update');

      // 【2026-02-25 性能优化】更新指纹缓存，下次无变化时可快速跳过
      this.lastTaskFingerprint = this.computeTaskFingerprint(activeTasks);
      const activeConnsForCache = project.connections?.filter(c => !c.deletedAt) ?? [];
      this.lastConnectionSignatureForData = this.computeConnectionSignature(activeConnsForCache);
      this.lastSearchQuery = searchQuery;
      this.lastDockFingerprint = this.computeDockFingerprint();

      if (selectedKeys.size > 0) {
        // 先清除选中再恢复，确保 selectionChanged 回调触发（数据合并后 binding 可能覆盖了选中态边框）
        this.diagram.clearSelection();
        this.diagram.nodes.each((node: go.Node) => {
          if (selectedKeys.has(node.data?.key)) {
            node.isSelected = true;
          }
        });
      }

      // 【2026-02-25 性能优化】移除全量 invalidateRoute() 调用
      // GoJS 的 mergeNodeDataArray/mergeLinkDataArray 已内置路由失效机制，
      // 仅在节点位置或 link 端点变化时自动更新受影响的连线。
      // 此前对所有 link 调用 invalidateRoute() 强制重算所有贝塞尔曲线，
      // 配合自定义 getLinkPoint 4 策略回退，50 节点 + 50-100 链接时造成严重卡顿。

      // Debug 日志
      const linkData = model.linkDataArray;
      if (linkData?.length > 0 && !this._familyColorLogged) {
        this._familyColorLogged = true;
        this.logger.info(`[LineageColor] 首条连线数据: ${JSON.stringify(linkData[0])}`);
      }

      if (this.isFirstLoad && diagramData.nodeDataArray.length > 0) {
        this.isFirstLoad = false;
        setTimeout(() => {
          if (!this.diagram) return;
          const viewState = this.projectState.getViewState();
          if (!viewState) {
            if (this.uiState.activeView() !== 'flow') {
              this.pendingAutoFitToContents = true;
              return;
            }
            this.zoomService.fitToContents();
          }
        }, 100);
      }

    } catch (error) {
      this.sentryLazyLoader.captureException(error, { tags: { operation: 'updateDiagram' } });
      this.logger.error('❌ 更新流程图失败', error);
      this.toast.error('流程图错误', '更新流程图失败。请刷新页面重试。');
    }
  }

  private buildLinkDataWithPorts(
    link: GoJSLinkData,
    currentLinkMap: ReadonlyMap<string, go.ObjectData>,
    currentNodeMap: ReadonlyMap<string, go.ObjectData>,
    nextNodeMap: ReadonlyMap<string, go.ObjectData>,
  ): FlowLinkDataWithPorts {
    const existingLink = currentLinkMap.get(link.key);
    const points = this.shouldPreserveLinkPoints(link, existingLink, currentNodeMap, nextNodeMap)
      ? existingLink?.points
      : undefined;

    return {
      ...link,
      points,
      fromPortId: "",
      toPortId: ""
    };
  }

  private shouldPreserveLinkPoints(
    nextLink: GoJSLinkData,
    currentLink: go.ObjectData | undefined,
    currentNodeMap: ReadonlyMap<string, go.ObjectData>,
    nextNodeMap: ReadonlyMap<string, go.ObjectData>,
  ): boolean {
    if (currentLink?.points === undefined || currentLink.points === null) return false;
    if (currentLink.from !== nextLink.from || currentLink.to !== nextLink.to) return false;
    if (currentLink.category !== nextLink.category || currentLink.curviness !== nextLink.curviness) return false;

    return this.hasStableNodeLoc(currentNodeMap, nextNodeMap, nextLink.from)
      && this.hasStableNodeLoc(currentNodeMap, nextNodeMap, nextLink.to);
  }

  private hasStableNodeLoc(
    currentNodeMap: ReadonlyMap<string, go.ObjectData>,
    nextNodeMap: ReadonlyMap<string, go.ObjectData>,
    key: string,
  ): boolean {
    const currentLoc = currentNodeMap.get(key)?.loc;
    const nextLoc = nextNodeMap.get(key)?.loc;

    return currentLoc !== undefined && nextLoc !== undefined && currentLoc === nextLoc;
  }

  // ========== 视图状态 ==========

  /**
   * 保存当前视图状态（缩放/位置），防抖 1s
   */
  saveViewState(): void {
    if (!this.diagram) return;

    if (this.viewStateSaveTimer) {
      clearTimeout(this.viewStateSaveTimer);
    }

    this.viewStateSaveTimer = setTimeout(() => {
      if (!this.diagram) return;

      const projectId = this.projectState.activeProjectId();
      if (!projectId) return;

      const scale = this.diagram.scale;
      const pos = this.diagram.position;

      this.projectState.updateViewState(projectId, {
        scale,
        positionX: pos.x,
        positionY: pos.y
      });
      this.syncCoordinator.markLocalChanges('position');
      this.syncCoordinator.schedulePersist();

      this.viewStateSaveTimer = null;
    }, 1000);
  }

  cancelPendingViewStateSave(): void {
    if (this.viewStateSaveTimer) {
      clearTimeout(this.viewStateSaveTimer);
      this.viewStateSaveTimer = null;
    }
  }

  /**
   * 恢复上次保存的视图状态
   */
  restoreViewState(): void {
    if (!this.diagram) return;

    const immediateViewState = this.projectState.getViewState();
    if (immediateViewState) {
      this.pendingAutoFitToContents = false;
      this.diagram.scale = immediateViewState.scale;
      this.diagram.position = new go.Point(immediateViewState.positionX, immediateViewState.positionY);
      return;
    }

    if (this.restoreViewStateTimer) {
      clearTimeout(this.restoreViewStateTimer);
      this.restoreViewStateTimer = null;
    }

    this.restoreViewStateTimer = setTimeout(() => {
      if (!this.diagram) return;

      const viewState = this.projectState.getViewState();

      if (viewState) {
        this.pendingAutoFitToContents = false;
        this.diagram.scale = viewState.scale;
        this.diagram.position = new go.Point(viewState.positionX, viewState.positionY);
      } else {
        if (this.uiState.activeView() !== 'flow') {
          this.pendingAutoFitToContents = true;
          return;
        }

        if (this.autoFitTimer) {
          clearTimeout(this.autoFitTimer);
          this.autoFitTimer = null;
        }

        this.autoFitTimer = setTimeout(() => {
          if (!this.diagram) return;
          this.zoomService.fitToContents();
          this.autoFitTimer = null;
        }, 300);
      }
      this.restoreViewStateTimer = null;
    }, 200);
  }

  // ========== Flow 视图激活 ==========

  /**
   * 由外部在 Flow 视图激活时调用
   */
  onFlowActivated(): void {
    if (!this.diagram) return;
    if (this.uiState.activeView() !== 'flow') return;
    if (!this.pendingAutoFitToContents) return;

    const viewState = this.projectState.getViewState();
    if (viewState) {
      this.pendingAutoFitToContents = false;
      this.diagram.scale = viewState.scale;
      this.diagram.position = new go.Point(viewState.positionX, viewState.positionY);
      return;
    }

    this.pendingAutoFitToContents = false;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!this.diagram) return;
        this.zoomService.fitToContents();
      });
    });
  }

  // ========== 清理 ==========

  /**
   * 清理所有内部定时器
   */
  clearTimers(): void {
    if (this.viewStateSaveTimer) {
      clearTimeout(this.viewStateSaveTimer);
      this.viewStateSaveTimer = null;
    }
    if (this.restoreViewStateTimer) {
      clearTimeout(this.restoreViewStateTimer);
      this.restoreViewStateTimer = null;
    }
    if (this.autoFitTimer) {
      clearTimeout(this.autoFitTimer);
      this.autoFitTimer = null;
    }
  }

  /**
   * 销毁时重置状态
   */
  dispose(): void {
    this.clearTimers();
    this.diagram = null;
    this.isFirstLoad = true;
    this._familyColorLogged = false;
    this.pendingAutoFitToContents = false;
    this.lastTaskFingerprint = '';
    this.lastConnectionSignatureForData = '';
    this.lastSearchQuery = '';
    this.lastDockFingerprint = '';
  }

  // ========== 【2026-02-25 性能优化】增量更新辅助 ==========

  /**
   * 计算任务列表的快速指纹
   * 包含影响图表显示的所有关键属性，用于跳过无变化的全量重建
   * O(n) 字符串拼接，但远比 buildDiagramData + merge + GC 开销小
   */
  private computeTaskFingerprint(tasks: Task[]): string {
    // 使用数组 join 代替字符串拼接，减少中间字符串分配
    const parts: string[] = [];
    for (const t of tasks) {
      parts.push(
        t.id, '|',
        t.title, '|',
        t.updatedAt || '', '|',
        t.parentId || '', '|',
        String(t.stage), '|',
        t.status || '', '|',
        t.parkingMeta?.state || '', ';'
      );
    }
    return parts.join('');
  }

  private computeDockFingerprint(): string {
    const dockedIds = Array.from(this.dockEngine.dockedTaskIds()).sort();
    const focusedTaskId = this.dockEngine.focusingEntry()?.taskId ?? '';
    return `${focusedTaskId}|${dockedIds.join(',')}`;
  }

  private computeConnectionSignature(
    connections: Array<{
      source: string;
      target: string;
      title?: string;
      description?: string;
      updatedAt?: string;
    }>
  ): string {
    return connections
      .map(c => `${c.source}->${c.target}|${c.title ?? ''}|${c.description ?? ''}|${c.updatedAt ?? ''}`)
      .sort()
      .join('|');
  }
}
