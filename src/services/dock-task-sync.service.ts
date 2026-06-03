/**
 * DockTaskSyncService
 * Dock 引擎中任务同步相关的操作：项目归属查找、详情/规划字段同步、跨项目更新。
 * 从 DockEngineService 提取，降低引擎文件体量。
 */
import { Injectable, inject } from '@angular/core';
import { CognitiveLoad, DockEntry } from '../models/parking-dock';
import { Task } from '../models';
import { TaskStore } from '../core-bridge';
import { LoggerService } from './logger.service';
import { ProjectStateService } from './project-state.service';
import { TaskOperationAdapterService } from './task-operation-adapter.service';
import { BlackBoxService } from './black-box.service';
import { normalizeNullableNumber } from './dock-snapshot-persistence.service';
import { sanitizePlannerFields } from '../utils/planner-fields';

@Injectable({
  providedIn: 'root',
})
export class DockTaskSyncService {
  private readonly taskStore = inject(TaskStore);
  private readonly taskOps = inject(TaskOperationAdapterService);
  private readonly projectState = inject(ProjectStateService);
  private readonly blackBoxService = inject(BlackBoxService);
  private readonly logger = inject(LoggerService).category('DockTaskSync');

  resolveTaskProjectId(taskId: string, fallbackProjectId?: string | null): string | null {
    const directProjectId = this.taskStore.getTaskProjectId(taskId);
    if (directProjectId) return directProjectId;
    if (fallbackProjectId) return fallbackProjectId;

    const project = this.projectState.projects().find(candidate =>
      candidate.tasks.some(task => task.id === taskId),
    );
    return project?.id ?? this.projectState.activeProjectId() ?? null;
  }

  /**
   * 同步 dock 详情文本到底层任务或 BlackBox 条目。
   * @param context 来自引擎的运行时状态（entries 列表与专注会话上下文）
   */
  syncTaskDetail(
    taskId: string,
    detail: string,
    context: {
      entries: DockEntry[];
      focusSessionContext: { id: string; startedAt: number } | null;
    },
  ): void {
    const inlineEntry = context.entries.find(entry => entry.taskId === taskId) ?? null;
    if (inlineEntry?.sourceKind === 'dock-created') {
      if (!inlineEntry.sourceBlackBoxEntryId) return;
      this.blackBoxService.update(inlineEntry.sourceBlackBoxEntryId, {
        content: detail.trim() || inlineEntry.title,
        focusMeta: {
          source: 'focus-console-inline',
          sessionId: context.focusSessionContext?.id ?? crypto.randomUUID(),
          title: inlineEntry.title,
          detail: detail.trim() || null,
          lane: inlineEntry.lane,
          expectedMinutes: normalizeNullableNumber(inlineEntry.expectedMinutes),
          waitMinutes: normalizeNullableNumber(inlineEntry.waitMinutes),
          cognitiveLoad: inlineEntry.load,
          dockEntryId: inlineEntry.taskId,
        },
      });
      return;
    }

    const task = this.taskStore.getTask(taskId);
    if (!task) return;
    const projectId = this.resolveTaskProjectId(taskId, inlineEntry?.sourceProjectId ?? null);
    if (!projectId) return;

    if (this.projectState.activeProjectId() === projectId) {
      this.taskOps.updateTaskContent(taskId, detail);
      return;
    }

    this.applyCrossProjectTaskPatch(taskId, projectId, {
      content: detail,
    });
  }

  syncTaskPlannerFields(
    taskId: string,
    patch: {
      expected_minutes?: number | null;
      cognitive_load?: CognitiveLoad | null;
      wait_minutes?: number | null;
    },
  ): void {
    const task = this.taskStore.getTask(taskId);
    if (!task) return;
    const projectId = this.resolveTaskProjectId(taskId);
    if (!projectId) return;

    const normalizedPatch: {
      expected_minutes?: number | null;
      cognitive_load?: CognitiveLoad | null;
      wait_minutes?: number | null;
    } = {};
    const plannerFields = sanitizePlannerFields({
      expectedMinutes:
        'expected_minutes' in patch ? patch.expected_minutes : task.expected_minutes,
      waitMinutes:
        'wait_minutes' in patch ? patch.wait_minutes : task.wait_minutes,
      cognitiveLoad:
        'cognitive_load' in patch ? patch.cognitive_load : task.cognitive_load,
    });
    if ('expected_minutes' in patch || ('wait_minutes' in patch && plannerFields.adjusted)) {
      normalizedPatch.expected_minutes = plannerFields.expectedMinutes;
    }
    if ('cognitive_load' in patch) {
      normalizedPatch.cognitive_load = plannerFields.cognitiveLoad;
    }
    if ('wait_minutes' in patch) {
      normalizedPatch.wait_minutes = plannerFields.waitMinutes;
    }

    if (this.projectState.activeProjectId() === projectId) {
      if ('expected_minutes' in normalizedPatch) {
        this.taskOps.updateTaskExpectedMinutes(taskId, normalizedPatch.expected_minutes ?? null);
      }
      if ('cognitive_load' in normalizedPatch) {
        this.taskOps.updateTaskCognitiveLoad(taskId, normalizedPatch.cognitive_load ?? null);
      }
      if ('wait_minutes' in normalizedPatch) {
        this.taskOps.updateTaskWaitMinutes(taskId, normalizedPatch.wait_minutes ?? null);
      }
      return;
    }

    this.applyCrossProjectTaskPatch(taskId, projectId, normalizedPatch);
  }

  syncInlineCompletion(entry: DockEntry): void {
    if (entry.sourceKind !== 'dock-created') return;
    const blackBoxEntryId = entry.sourceBlackBoxEntryId ?? null;
    if (!blackBoxEntryId) return;

    if (this.blackBoxService.getEntry(blackBoxEntryId)?.isCompleted) return;

    const result = this.blackBoxService.markAsCompleted(blackBoxEntryId);
    if (!result.ok) {
      this.logger.warn('Inline dock completion failed to mark source black-box entry completed', {
        dockEntryId: entry.taskId,
        blackBoxEntryId,
        message: result.error.message,
      });
    }
  }

  syncCompletedInlineEntries(entries: readonly DockEntry[]): void {
    for (const entry of entries) {
      if (entry.status === 'completed') {
        this.syncInlineCompletion(entry);
      }
    }
  }

  applyCrossProjectTaskPatch(
    taskId: string,
    projectId: string,
    patch: Partial<Task>,
  ): void {
    const currentTask = this.taskStore.getTask(taskId);
    if (!currentTask) return;
    const now = new Date().toISOString();
    const completedAt = this.resolveCompletedAt(currentTask, patch, now);

    const updatedTask: Task = {
      ...currentTask,
      ...patch,
      completedAt,
      updatedAt: now,
    };
    this.taskStore.setTask(updatedTask, projectId);
    this.projectState.updateProjects(projects =>
      projects.map(project =>
        project.id === projectId
          ? {
              ...project,
              tasks: project.tasks.map(item => (item.id === taskId ? updatedTask : item)),
            }
          : project,
      ),
    );
  }

  /**
   * 完成时间不是 LWW 时钟：已完成任务保留原值，刚完成时写入 now，恢复/归档时清空。
   */
  private resolveCompletedAt(currentTask: Task, patch: Partial<Task>, now: string): string | null | undefined {
    if (patch.status === 'completed') {
      if (currentTask.status === 'completed') {
        return patch.completedAt ?? currentTask.completedAt ?? now;
      }
      return patch.completedAt ?? now;
    }
    if (patch.status) {
      return null;
    }
    return patch.completedAt === undefined ? currentTask.completedAt : patch.completedAt;
  }
}
