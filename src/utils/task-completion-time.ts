export interface TaskCompletionTimestampSource {
  completedAt?: string | null;
  updatedAt?: string | null;
  createdDate?: string | null;
}

// Mirrors migration 20260428083000_add_task_completed_at.sql. After this point,
// updatedAt is only an LWW sync clock and must not be treated as completion time.
const TASK_COMPLETED_AT_SCHEMA_INTRODUCED_AT_MS = Date.parse('2026-04-28T08:30:00.000Z');

/**
 * Resolve the stable domain completion time for completed tasks.
 * completedAt always wins; updatedAt is accepted only for pre-completed_at legacy caches.
 */
export function resolveTaskCompletionTimestamp(source: TaskCompletionTimestampSource): string | null {
  const completedAt = nonEmptyTimestamp(source.completedAt);
  if (completedAt) return completedAt;

  const updatedAt = nonEmptyTimestamp(source.updatedAt);
  const createdDate = nonEmptyTimestamp(source.createdDate);
  if (updatedAt && isLegacyUpdatedAtCompletionProxy(updatedAt)) return updatedAt;

  return createdDate ?? updatedAt;
}

function isLegacyUpdatedAtCompletionProxy(timestamp: string): boolean {
  const timestampMs = Date.parse(timestamp);
  return Number.isFinite(timestampMs) && timestampMs < TASK_COMPLETED_AT_SCHEMA_INTRODUCED_AT_MS;
}

function nonEmptyTimestamp(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}