import type { Task } from '../models';

// 仅在本次运行时标记：当前 Task 源 payload 缺少 content 字段。
const tasksMissingContentFromSource = new WeakSet<Task>();

export function markTaskContentMissingFromSource<T extends Task>(task: T): T {
  tasksMissingContentFromSource.add(task);
  return task;
}

export function hasTaskContentMissingFromSource(task: Task | null | undefined): boolean {
  return Boolean(task && tasksMissingContentFromSource.has(task));
}