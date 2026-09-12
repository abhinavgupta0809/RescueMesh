import type { FieldReport } from './contract';
export const queueKey = (mode: string) => `rescuemesh.queue.v1.${mode}`;
export function readQueue(storage: Pick<Storage, 'getItem'>, mode: string): FieldReport[] {
  const raw = storage.getItem(queueKey(mode));
  if (!raw) return [];
  const value: unknown = JSON.parse(raw);
  if (
    !Array.isArray(value) ||
    value.some(
      (r) =>
        typeof r.clientReportId !== 'string' ||
        typeof r.body !== 'string' ||
        typeof r.zoneId !== 'string' ||
        typeof r.capturedAt !== 'string'
    )
  )
    throw new Error('Saved report queue is unreadable. Existing storage has been preserved.');
  return value as FieldReport[];
}
export function writeQueue(
  storage: Pick<Storage, 'setItem'>,
  mode: string,
  reports: FieldReport[]
) {
  storage.setItem(queueKey(mode), JSON.stringify(reports));
}
