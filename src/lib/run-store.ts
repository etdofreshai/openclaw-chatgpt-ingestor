import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export interface RunLog {
  runId: string;
  jobId?: string;
  startedAt: string;
  finishedAt?: string;
  status: 'queued' | 'running' | 'success' | 'error';
  error?: string;
  /** Conversation ID (or 'all') */
  channel: string;
  /** Conversation title */
  channelName?: string;
  params: {
    limit?: number;
    after?: string;
    before?: string;
    sincePreset?: string;
    /** Resolved cutoff as ISO timestamp or ms string */
    effectiveAfter?: string;
  };
  fetchedCount: number;
  insertedCount: number;
  updatedCount: number;
  skippedCount: number;
  attachmentsSeen: number;
}

const DATA_ROOT = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : process.env.NODE_ENV === 'production'
    ? '/app/.data'
    : path.resolve(process.cwd(), '.data');

const DATA_DIR = path.join(DATA_ROOT, 'runs');
const RUNS_FILE = path.join(DATA_DIR, 'runs.json');
const MAX_RUNS = 200;

async function ensureDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

export async function loadRuns(): Promise<RunLog[]> {
  try {
    const raw = await fs.readFile(RUNS_FILE, 'utf8');
    return JSON.parse(raw) as RunLog[];
  } catch {
    return [];
  }
}

async function saveRuns(runs: RunLog[]): Promise<void> {
  await ensureDir();
  const trimmed = runs.length > MAX_RUNS ? runs.slice(-MAX_RUNS) : runs;
  await fs.writeFile(RUNS_FILE, JSON.stringify(trimmed, null, 2), 'utf8');
}

export async function createRun(data: Omit<RunLog, 'runId'>): Promise<RunLog> {
  const runs = await loadRuns();
  const run: RunLog = { ...data, runId: crypto.randomUUID() };
  runs.push(run);
  await saveRuns(runs);
  return run;
}

export async function updateRun(runId: string, patch: Partial<RunLog>): Promise<RunLog | null> {
  const runs = await loadRuns();
  const idx = runs.findIndex(r => r.runId === runId);
  if (idx === -1) return null;
  runs[idx] = { ...runs[idx], ...patch };
  await saveRuns(runs);
  return runs[idx];
}

export async function getRecentRuns(limit = 50): Promise<RunLog[]> {
  const runs = await loadRuns();
  return runs.slice(-limit).reverse();
}
