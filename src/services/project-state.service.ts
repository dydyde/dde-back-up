import { Injectable, computed, inject } from '@angular/core';
import { Project, Task, Connection, UnfinishedItem } from '../models';
import { LayoutService } from './layout.service';
import { UiStateService } from './ui-state.service';
import { TaskStore, ProjectStore, ConnectionStore } from '../core-bridge';
import { SUPERSCRIPT_DIGITS } from '../config';
import { summarizeMarkdownTodos } from '../utils/markdown-todo';

/**
 * 任务连接信息（缓存用）
 * 用于 O(1) 查询任务的出入连接
 */
export interface TaskConnectionInfo {
  outgoing: { targetId: string; targetTask: Task | undefined; description?: string }[];
  incoming: { sourceId: string; sourceTask: Task | undefined; description?: string }[];
}

interface TaskTodoSnapshot {
  unfinishedItems: UnfinishedItem[];
  total: number;
  completed: number;
  pending: number;
}

/**
 * 项目状态服务
 * 从 StoreService 拆分出来，专注于项目和任务的状态管理
 * 
 * 【架构升级】
 * 底层使用 TaskStore/ProjectStore/ConnectionStore 实现 O(1) 查找
 * 对外保持原有接口兼容
 * 
 * 【职责边界】
 * ✓ 项目/任务/连接的状态存储（通过 Store 代理）
 * ✓ 计算属性（stages, unassignedTasks, deletedTasks 等）
 * ✓ 纯状态读取操作
 * ✓ displayId 压缩显示
 * ✗ 数据修改操作 → TaskOperationService
 * ✗ 数据持久化 → SyncCoordinatorService
 * ✗ UI 状态 → UiStateService
 */
@Injectable({
  providedIn: 'root'
})
export class ProjectStateService {
  private layoutService = inject(LayoutService);
  private uiState = inject(UiStateService);
  
  // ========== 新架构：底层 Store ==========
  private readonly taskStore = inject(TaskStore);
  private readonly projectStore = inject(ProjectStore);
  private readonly connectionStore = inject(ConnectionStore);
  
  // ========== 核心数据状态（代理到 Store） ==========
  
  /** 项目列表 - 代理到 ProjectStore */
  readonly projects = computed(() => this.projectStore.projects());
  
  /** 
   * 活动项目 ID - 直接暴露 ProjectStore 的 WritableSignal
   * 保持 .set() 可用性
   */
  readonly activeProjectId = this.projectStore.activeProjectId;

  // ========== 计算属性 ==========

  readonly activeProject = computed(() => this.projectStore.activeProject());

  /** 当前项目的任务列表 - 使用 TaskStore O(1) 查找 */
  readonly tasks = computed(() => {
    const projectId = this.activeProjectId();
    if (!projectId) return [];
    return this.taskStore.getTasksByProject(projectId);
  });

  readonly stages = computed(() => {
    const tasks = this.tasks();
    const assigned = tasks.filter(t => t.stage !== null && !t.deletedAt);
    
    const stagesMap = new Map<number, Task[]>();
    assigned.forEach(t => {
      if (!stagesMap.has(t.stage!)) stagesMap.set(t.stage!, []);
      stagesMap.get(t.stage!)!.push(t);
    });
    
    stagesMap.forEach((val) => {
      val.sort((a, b) => a.order - b.order);
    });
    
    const sortedKeys = Array.from(stagesMap.keys()).sort((a, b) => a - b);
    return sortedKeys.map(k => ({
      stageNumber: k,
      tasks: stagesMap.get(k)!
    }));
  });

  readonly unassignedTasks = computed(() => {
    return this.tasks().filter(t => t.stage === null && !t.deletedAt);
  });

  /** 已删除（回收站）中的任务 */
  readonly deletedTasks = computed(() => {
    return this.tasks().filter(t => t.deletedAt);
  });

  private readonly filteredTaskTodoSnapshot = computed<TaskTodoSnapshot>(() => {
    const filter = this.uiState.filterMode();
    let rootDisplayId = '';

    if (filter !== 'all') {
      const root = this.getTask(filter);
      if (root) rootDisplayId = root.displayId;
    }

    return this.collectTaskTodoSnapshot(rootDisplayId);
  });

  private readonly projectTaskTodoSnapshot = computed<TaskTodoSnapshot>(() => {
    return this.collectTaskTodoSnapshot();
  });

  private collectTaskTodoSnapshot(rootDisplayId: string = ''): TaskTodoSnapshot {
    const tasks = this.tasks();
    const unfinishedItems: UnfinishedItem[] = [];
    let total = 0;
    let completed = 0;

    tasks.forEach(task => {
      if (task.deletedAt) return;

      if (rootDisplayId) {
        const isDescendant = task.displayId === rootDisplayId || task.displayId.startsWith(rootDisplayId + ',');
        if (!isDescendant) return;
      }

      const todoStats = this.extractTaskTodoStats(task.content || '');
      total += todoStats.total;
      completed += todoStats.completed;

      todoStats.unfinishedItems.forEach(item => {
        unfinishedItems.push({
          taskId: task.id,
          taskDisplayId: task.displayId,
          todoIndex: item.index,
          text: item.text,
        });
      });
    });

    return {
      unfinishedItems,
      total,
      completed,
      pending: total - completed,
    };
  }

  readonly unfinishedItems = computed<UnfinishedItem[]>(() => {
    return this.filteredTaskTodoSnapshot().unfinishedItems;
  });

  readonly taskTodoStats = computed(() => {
    const snapshot = this.projectTaskTodoSnapshot();
    return {
      total: snapshot.total,
      completed: snapshot.completed,
      pending: snapshot.pending,
    };
  });

  readonly rootTasks = computed(() => {
    const tasks = this.tasks();
    const tasksWithUnfinished = tasks.filter(task => {
      if (task.deletedAt) return false;
      return this.extractTaskTodoStats(task.content || '').pending > 0;
    });
    
    return tasks.filter(t => t.stage === 1 && !t.deletedAt).filter(root => {
      if (tasksWithUnfinished.some(u => u.id === root.id)) return true;
      return tasksWithUnfinished.some(u => u.displayId.startsWith(root.displayId + ','));
    });
  });

  readonly allStage1Tasks = computed(() => {
    return this.tasks()
      .filter(t => t.stage === 1 && !t.deletedAt)
      .sort((a, b) => a.rank - b.rank);
  });

  private extractTaskTodoStats(content: string): {
    total: number;
    completed: number;
    pending: number;
    unfinishedItems: Array<{
      index: number;
      text: string;
    }>;
  } {
    const summary = summarizeMarkdownTodos(content);
    return {
      total: summary.total,
      completed: summary.completed,
      pending: summary.pending,
      unfinishedItems: summary.items
        .filter(item => !item.checked)
        .map(item => ({
          index: item.index,
          text: item.text,
        })),
    };
  }

  /**
   * 【性能优化】所有任务的连接关系缓存
   * 
   * 将 O(n²) 的逐任务查询优化为 O(n) 的一次性计算 + O(1) 查找
   * 返回 Map<taskId, { outgoing, incoming }>
   * 
   * 只在 tasks 或 connections 变化时重新计算
   */
  readonly taskConnectionsMap = computed(() => {
    const project = this.activeProject();
    if (!project) return new Map<string, TaskConnectionInfo>();
    
    const tasks = project.tasks;
    const connections = project.connections;
    
    // 构建父子关系 Set（O(n)）
    const parentChildPairs = new Set<string>();
    for (const t of tasks) {
      if (t.parentId) {
        parentChildPairs.add(`${t.parentId}->${t.id}`);
      }
    }
    
    // 构建任务 ID -> Task 映射（O(n)）
    const taskMap = new Map<string, Task>();
    for (const t of tasks) {
      taskMap.set(t.id, t);
    }
    
    // 初始化结果 Map
    const result = new Map<string, TaskConnectionInfo>();
    for (const t of tasks) {
      result.set(t.id, { outgoing: [], incoming: [] });
    }
    
    // 一次遍历 connections 构建所有连接关系（O(m)）
    for (const conn of connections) {
      // 【P1-13 修复】跳过软删除的连接
      if (conn.deletedAt) continue;
      const pairKey = `${conn.source}->${conn.target}`;
      if (parentChildPairs.has(pairKey)) continue; // 跳过父子关系
      
      // 添加到 source 的 outgoing
      const sourceInfo = result.get(conn.source);
      if (sourceInfo) {
        sourceInfo.outgoing.push({
          targetId: conn.target,
          targetTask: taskMap.get(conn.target),
          description: conn.description
        });
      }
      
      // 添加到 target 的 incoming
      const targetInfo = result.get(conn.target);
      if (targetInfo) {
        targetInfo.incoming.push({
          sourceId: conn.source,
          sourceTask: taskMap.get(conn.source),
          description: conn.description
        });
      }
    }
    
    return result;
  });

  // ========== 公共方法 ==========

  /**
   * 压缩 displayId 显示
   */
  compressDisplayId(displayId: string): string {
    if (!displayId || displayId === '?') return displayId;
    
    const parts = displayId.split(',');
    const result: string[] = [];
    let i = 0;
    
    while (i < parts.length) {
      const current = parts[i];
      let count = 1;
      
      while (i + count < parts.length && parts[i + count] === current) {
        count++;
      }
      
      if (count >= 5) {
        const superscript = String(count).split('').map(d => SUPERSCRIPT_DIGITS[d]).join('');
        result.push(current + superscript);
      } else {
        for (let j = 0; j < count; j++) {
          result.push(current);
        }
      }
      
      i += count;
    }
    
    return result.join(',');
  }

  /**
   * 获取任务的关联连接
   * 
   * 【性能优化】使用 taskConnectionsMap 缓存，O(1) 查找
   * 只有在 tasks 或 connections 变化时才重新计算缓存
   */
  getTaskConnections(taskId: string): TaskConnectionInfo {
    const cached = this.taskConnectionsMap().get(taskId);
    if (cached) return cached;
    
    // 如果缓存中没有（可能是新任务还未进入缓存），返回空结果
    return { outgoing: [], incoming: [] };
  }

  /**
   * 获取当前项目的视图状态
   */
  getViewState(): { scale: number; positionX: number; positionY: number } | null {
    const project = this.activeProject();
    if (!project?.viewState) return null;
    return project.viewState;
  }

  /**
   * 获取项目（用于外部读取）
   */
  getProject(projectId: string): Project | undefined {
    return this.projectStore.getProject(projectId);
  }

  /**
   * 获取指定项目，并将 tasks/connections 从 Store 实时化
   *
   * 写入云端或 durable 队列时禁止直接使用 ProjectStore 壳对象，
   * 否则 metadata-only / stale shell 里的旧任务结构会被重新推回云端。
   */
  getProjectWithCurrentData(projectId: string): Project | undefined {
    const project = this.projectStore.getProject(projectId);
    if (!project) {
      return undefined;
    }

    return {
      ...project,
      tasks: this.taskStore.getTasksByProject(projectId),
      connections: this.connectionStore.getConnectionsByProject(projectId),
    };
  }

  /**
   * 获取所有项目，并将 tasks/connections 从 Store 实时化
   *
   * ProjectStore 中 Project.tasks 可能因 setProjectsMetadataOnly 等路径变陈旧，
   * 此方法以 TaskStore/ConnectionStore 为真值来源重建 tasks/connections，
   * 保证离线快照和云端推送包含最新数据。
   */
  getProjectsWithCurrentData(): Project[] {
    return this.projectStore.projects().map(p => ({
      ...p,
      tasks: this.taskStore.getTasksByProject(p.id),
      connections: this.connectionStore.getConnectionsByProject(p.id),
    }));
  }

  // ========== 内部更新方法（供 StoreService 调用） ==========

  /**
   * 直接更新项目列表
   * 同时更新 ProjectStore、TaskStore、ConnectionStore
   */
  setProjects(projects: Project[]): void {
    // 更新 ProjectStore
    this.projectStore.setProjects(projects);
    
    // 同步任务和连接到对应 Store（批量操作，单次 Map 克隆）
    // 注意：使用 Array.isArray 而非 length 检查，确保空数组也能正确同步
    // 这对于撤销操作恢复到空连接状态至关重要
    const taskEntries: { tasks: Task[]; projectId: string }[] = [];
    const connectionEntries: { connections: Connection[]; projectId: string }[] = [];
    
    for (const project of projects) {
      if (Array.isArray(project.tasks)) {
        taskEntries.push({ tasks: project.tasks, projectId: project.id });
      }
      if (Array.isArray(project.connections)) {
        connectionEntries.push({ connections: project.connections, projectId: project.id });
      }
    }
    
    if (taskEntries.length > 0) {
      this.taskStore.setTasksForMultipleProjects(taskEntries);
    }
    if (connectionEntries.length > 0) {
      this.connectionStore.setConnectionsForMultipleProjects(connectionEntries);
    }
  }

  /**
   * 仅更新项目元数据（不触碰 TaskStore / ConnectionStore）
   *
   * 适用于 syncProjectListMetadata 等只更新项目 name/description/updatedAt 的场景。
   * 空壳项目（tasks: []）不会覆盖 TaskStore 中已加载好的任务数据。
   */
  setProjectsMetadataOnly(projects: Project[]): void {
    this.projectStore.setProjects(projects);
  }

  /**
   * 更新项目列表
   * 兼容旧的 updater 模式
   */
  updateProjects(updater: (projects: Project[]) => Project[]): void {
    const currentProjects = this.projectStore.projects();
    const updatedProjects = updater(currentProjects);
    this.setProjects(updatedProjects);
  }

  /**
   * 设置活动项目 ID
   */
  setActiveProjectId(projectId: string | null): void {
    this.projectStore.activeProjectId.set(projectId);
  }

  /**
   * 创建新项目
   * 生成新项目对象，包含唯一 ID 和初始化信息
   */
  createNewProject(name: string, description: string): Project {
    return {
      id: crypto.randomUUID(),
      name,
      description,
      createdDate: new Date().toISOString(),
      tasks: [],
      connections: [],
      updatedAt: new Date().toISOString(),
      version: 1,
    };
  }

  /**
   * 清空数据
   */
  clearData(): void {
    this.projectStore.clear();
    this.taskStore.clear();
    this.connectionStore.clear();
  }
  
  // ========== 新增：O(1) 查找方法 ==========
  
  /**
   * 获取单个任务 - O(1)
   */
  getTask(taskId: string): Task | undefined {
    return this.taskStore.getTask(taskId);
  }
  
  /**
   * 获取单个连接 - O(1)
   */
  getConnection(connectionId: string): Connection | undefined {
    return this.connectionStore.getConnection(connectionId);
  }
  
  /**
   * 更新单个任务
   */
  updateTask(task: Task, projectId?: string): void {
    const pid = projectId || this.activeProjectId();
    if (pid) {
      this.taskStore.setTask(task, pid);
    }
  }
  
  /**
   * 更新单个连接
   */
  updateConnection(connection: Connection, projectId?: string): void {
    const pid = projectId || this.activeProjectId();
    if (pid) {
      this.connectionStore.setConnection(connection, pid);
    }
  }

  /**
   * 批量更新任务（单次 Map 克隆）
   * 与循环调用 updateTask 相比，减少 N 次 Map 克隆为 1 次
   */
  bulkUpdateTasks(tasks: Task[], projectId?: string): void {
    const pid = projectId || this.activeProjectId();
    if (pid) {
      this.taskStore.bulkSetTasks(tasks, pid);
    }
  }

  /**
   * 批量删除任务（单次 Map 克隆）
   */
  bulkRemoveTasks(taskIds: string[], projectId?: string): void {
    const pid = projectId || this.activeProjectId();
    if (pid) {
      this.taskStore.bulkRemoveTasks(taskIds, pid);
    }
  }

  /**
   * 批量更新连接（单次 Map 克隆）
   */
  bulkUpdateConnections(connections: Connection[], projectId?: string): void {
    const pid = projectId || this.activeProjectId();
    if (pid) {
      this.connectionStore.bulkSetConnections(connections, pid);
    }
  }

  /**
   * 批量删除连接（单次 Map 克隆）
   */
  bulkRemoveConnections(connectionIds: string[], projectId?: string): void {
    const pid = projectId || this.activeProjectId();
    if (pid) {
      this.connectionStore.bulkRemoveConnections(connectionIds, pid);
    }
  }
  
  /**
   * 重命名项目
   * 返回 true 表示成功，false 表示无效名称
   */
  renameProject(projectId: string, newName: string): boolean {
    const trimmed = newName.trim();
    if (!trimmed) return false;
    
    this.updateProjects(projects => projects.map(p => 
      p.id === projectId ? { ...p, name: trimmed } : p
    ));
    return true;
  }
  
  /**
   * 更新项目视图状态（缩放、位置）
   */
  updateViewState(projectId: string, viewState: { scale?: number; positionX?: number; positionY?: number }): void {
    this.updateProjects(projects => projects.map(p => {
      if (p.id === projectId) {
        return {
          ...p,
          viewState: {
            scale: viewState.scale ?? p.viewState?.scale ?? 1,
            positionX: viewState.positionX ?? p.viewState?.positionX ?? 0,
            positionY: viewState.positionY ?? p.viewState?.positionY ?? 0
          }
        };
      }
      return p;
    }));
  }
}
