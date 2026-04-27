import { loadJobs, updateJob, type Job } from './job-store.js';
import { createRun, updateRun } from './run-store.js';
import { hasSession } from './session.js';
import { fetchConversationTitle } from './chatgpt-api.js';
import { syncChatGPTConversation } from './live-sync.js';
import { isApiMode } from './api-writer.js';
import {
  computeNextBoundary,
  sincePresetToMs,
  type SincePreset,
} from './since-presets.js';
import { enqueue } from './scheduler-queue.js';

const jobTimers = new Map<string, ReturnType<typeof setTimeout>>();
const jobLastCompletion = new Map<string, number>(); // Track last completion timestamp per job
const MIN_RUN_INTERVAL_MS = 60_000; // Minimum 60s between runs of the same job

function clearJobTimer(jobId: string): void {
  const t = jobTimers.get(jobId);
  if (t !== undefined) {
    clearTimeout(t);
    jobTimers.delete(jobId);
  }
}

export type JobRunOverrides = {
  limit?: number;
  sinceMs?: number;
  sincePreset?: Job['sincePreset'];
};

async function executeJob(job: Job, overrides?: JobRunOverrides): Promise<void> {
  // Guard: don't re-run a job within MIN_RUN_INTERVAL_MS of last completion
  const lastDone = jobLastCompletion.get(job.id) ?? 0;
  if (Date.now() - lastDone < MIN_RUN_INTERVAL_MS && !overrides) {
    console.log(`[Scheduler] Job ${job.id} (${job.name}) finished ${Math.round((Date.now() - lastDone) / 1000)}s ago — skipping rapid re-run.`);
    return;
  }
  if (!isApiMode() && !process.env.DATABASE_URL) {
    console.log('[Scheduler] No write backend configured — cannot run job.');
    return;
  }

  if (!hasSession()) {
    console.log(`[Scheduler] No ChatGPT session — skipping job ${job.id} (${job.name}).`);
    await updateJob(job.id, { lastStatus: 'error' });
    return;
  }

  // NOTE: Removed validateSession() pre-check — it was silently failing and blocking all syncs.
  // The actual API calls in chatgpt-api.ts already handle token refresh and 401s gracefully.

  const now = new Date();
  const runSincePreset = overrides?.sincePreset ?? job.sincePreset;
  const runLimit = overrides?.limit ?? job.limit;

  // Compute effective cutoff ms
  const overlapPctRaw = Number(process.env.SCHEDULE_SINCE_OVERLAP_PERCENT ?? '10');
  const overlapPct = Number.isFinite(overlapPctRaw) ? Math.min(Math.max(overlapPctRaw, 0), 100) : 10;

  let effectiveSinceMs: number | undefined;
  if (overrides?.sinceMs !== undefined) {
    effectiveSinceMs = overrides.sinceMs;
  } else if (job.lastSyncedAt) {
    // Priority: lastSyncedAt → startDate → sincePreset (legacy) → beginning (0)
    effectiveSinceMs = new Date(job.lastSyncedAt).getTime();
  } else if (job.startDate) {
    effectiveSinceMs = new Date(job.startDate).getTime();
  } else if (runSincePreset && runSincePreset !== 'all') {
    const baseMs = sincePresetToMs(runSincePreset as SincePreset);
    const lookbackMs = Math.round(baseMs * (1 + overlapPct / 100));
    effectiveSinceMs = now.getTime() - lookbackMs;
  } else if (runSincePreset === 'all') {
    effectiveSinceMs = 0; // Sync all — no cutoff
  }
  // Apply startDate as floor even when lastSyncedAt is set
  if (job.startDate && effectiveSinceMs !== undefined) {
    const startMs = new Date(job.startDate).getTime();
    effectiveSinceMs = Math.max(effectiveSinceMs, startMs);
  }

  const startedAt = now.toISOString();
  await updateJob(job.id, { lastStatus: 'running', lastRunAt: startedAt });

  const convTitle = await fetchConversationTitle(job.channel).catch(() => null);

  const run = await createRun({
    jobId: job.id,
    startedAt,
    status: 'running',
    channel: job.channel,
    channelName: convTitle ?? undefined,
    params: {
      limit: runLimit,
      sincePreset: runSincePreset,
      effectiveAfter: effectiveSinceMs !== undefined ? new Date(effectiveSinceMs).toISOString() : undefined,
    },
    fetchedCount: 0,
    insertedCount: 0,
    updatedCount: 0,
    skippedCount: 0,
    attachmentsSeen: 0,
  });

  const writeMode = isApiMode() ? 'api' : 'pg';

  try {
    console.log(
      `[Scheduler] Starting job ${job.id} (${job.name}) — conversation=${job.channel}` +
      (job.cadencePreset ? ` — cadence=${job.cadencePreset}` : '') +
      (runSincePreset ? ` — since=${runSincePreset}` : '') +
      ` [write=${writeMode}]`
    );

    const result = await syncChatGPTConversation(job.channel, {
      sinceMs: effectiveSinceMs,
      limit: runLimit,
      verbose: true,
    });

    const finishedAt = new Date().toISOString();
    await updateJob(job.id, { lastStatus: 'success', lastRunAt: finishedAt, lastSyncedAt: finishedAt });
    await updateRun(run.runId, {
      finishedAt,
      status: 'success',
      fetchedCount: result.fetched,
      insertedCount: result.inserted,
      updatedCount: result.updated,
      skippedCount: result.skipped,
      attachmentsSeen: result.attachmentsSeen,
    });

    console.log(`[Scheduler] Job ${job.id} done — fetched=${result.fetched} inserted=${result.inserted} updated=${result.updated}`);
    jobLastCompletion.set(job.id, Date.now());
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.log(`[Scheduler] Job ${job.id} (${job.name}) failed: ${message}`);
    await updateJob(job.id, { lastStatus: 'error' });
    await updateRun(run.runId, {
      finishedAt: new Date().toISOString(),
      status: 'error',
      error: message,
    });
    jobLastCompletion.set(job.id, Date.now());
  }
}

export function scheduleJob(job: Job): void {
  clearJobTimer(job.id);
  if (!job.enabled) return;

  let delayMs: number;

  if (job.cadencePreset) {
    const nextBoundary = computeNextBoundary(job.cadencePreset);
    delayMs = Math.max(0, nextBoundary.getTime() - Date.now());
    console.log(
      `[Scheduler] Job ${job.id} (${job.name}) — cadence=${job.cadencePreset}` +
      ` next boundary: ${nextBoundary.toISOString()} (in ${Math.round(delayMs / 1000)}s)`
    );
  } else if (job.lastRunAt) {
    const intervalMs = job.intervalMinutes * 60 * 1000;
    const lastRun = new Date(job.lastRunAt).getTime();
    delayMs = Math.max(0, lastRun + intervalMs - Date.now());
    console.log(`[Scheduler] Job ${job.id} (${job.name}) [legacy] next run in ${Math.round(delayMs / 1000)}s`);
  } else {
    delayMs = 5_000;
    console.log(`[Scheduler] Job ${job.id} (${job.name}) first run in ${delayMs / 1000}s`);
  }

  const timer = setTimeout(async () => {
    jobTimers.delete(job.id);

    const jobs = await loadJobs();
    const current = jobs.find(j => j.id === job.id);

    if (!current) {
      console.log(`[Scheduler] Job ${job.id} no longer exists — dropping.`);
      return;
    }

    if (!current.enabled) {
      console.log(`[Scheduler] Job ${job.id} (${current.name}) disabled — not running.`);
      return;
    }

    const { enqueued } = enqueue(current.id, current.name, () => executeJob(current));
    if (!enqueued) {
      console.log(`[Scheduler] Job ${current.id} (${current.name}) already queued/running — skipping.`);
    }

    scheduleJob(current);
  }, delayMs);

  jobTimers.set(job.id, timer);
}

export function unscheduleJob(jobId: string): void {
  clearJobTimer(jobId);
}

export function runJobNow(job: Job, overrides?: JobRunOverrides): Promise<void> {
  clearJobTimer(job.id);
  const { promise } = enqueue(job.id, job.name, () => executeJob(job, overrides));
  if (job.enabled) scheduleJob(job);
  return promise;
}

export async function startScheduler(): Promise<void> {
  const jobs = await loadJobs();
  const enabledJobs = jobs.filter(j => j.enabled);
  console.log(`[Scheduler] Starting — ${jobs.length} total jobs, ${enabledJobs.length} enabled.`);
  for (const job of enabledJobs) {
    scheduleJob(job);
  }
}
