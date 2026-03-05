/**
 * scheduler-queue.ts
 *
 * Global job execution queue with configurable concurrency.
 * Prevents concurrent API bursts by serializing all sync work through
 * a bounded worker pool.
 *
 * Environment variables:
 *   SCHEDULER_CONCURRENCY     – Max concurrent running jobs (default: 1)
 *   SCHEDULER_JOB_SPACING_MS  – Minimum delay (ms) after a job finishes (default: 1000)
 */

type QueueEntry = {
  jobId: string;
  label: string;
  fn: () => Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
};

const CONCURRENCY = Math.max(
  1,
  parseInt(process.env.SCHEDULER_CONCURRENCY ?? '1', 10) || 1
);

const SPACING_MS = Math.max(
  0,
  parseInt(process.env.SCHEDULER_JOB_SPACING_MS ?? '1000', 10) || 0
);

console.log(`[Queue] Initialised — concurrency=${CONCURRENCY}, spacingMs=${SPACING_MS}`);

const queue: QueueEntry[] = [];
const running = new Set<string>();
let activeWorkers = 0;

export function enqueue(
  jobId: string,
  label: string,
  fn: () => Promise<void>
): { promise: Promise<void>; enqueued: boolean } {
  if (running.has(jobId) || queue.some(q => q.jobId === jobId)) {
    console.log(`[Queue] Job ${jobId} (${label}) already queued/running — skipping duplicate.`);
    return { promise: Promise.resolve(), enqueued: false };
  }

  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  queue.push({ jobId, label, fn, resolve, reject });
  console.log(`[Queue] Enqueued ${jobId} (${label}). Depth: ${queue.length}, active: ${activeWorkers}/${CONCURRENCY}`);

  drainQueue();
  return { promise, enqueued: true };
}

function drainQueue(): void {
  while (activeWorkers < CONCURRENCY && queue.length > 0) {
    const entry = queue.shift()!;
    activeWorkers++;
    running.add(entry.jobId);

    console.log(`[Queue] Starting ${entry.jobId} (${entry.label}). Active: ${activeWorkers}/${CONCURRENCY}, remaining: ${queue.length}`);

    entry.fn()
      .then(() => { entry.resolve(); })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[Queue] Job ${entry.jobId} (${entry.label}) threw: ${msg}`);
        entry.reject(err);
      })
      .finally(() => {
        running.delete(entry.jobId);
        activeWorkers--;
        console.log(`[Queue] Finished ${entry.jobId} (${entry.label}). Active: ${activeWorkers}/${CONCURRENCY}, remaining: ${queue.length}`);
        if (SPACING_MS > 0 && queue.length > 0) {
          setTimeout(drainQueue, SPACING_MS);
        } else {
          drainQueue();
        }
      });
  }
}

export interface QueueStatus {
  concurrency: number;
  spacingMs: number;
  runningIds: string[];
  queuedIds: string[];
  runningCount: number;
  queuedCount: number;
}

export function getQueueStatus(): QueueStatus {
  return {
    concurrency: CONCURRENCY,
    spacingMs: SPACING_MS,
    runningIds: [...running],
    queuedIds: queue.map(q => q.jobId),
    runningCount: running.size,
    queuedCount: queue.length,
  };
}
