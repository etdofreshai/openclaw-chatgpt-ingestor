import { Router, type Request, type Response, type NextFunction } from 'express';
import { hasSession, getAccessToken, getSessionInfo } from './session.js';
import { validateSession, listConversationsForUI, fetchConversationTitle } from './chatgpt-api.js';
import { syncChatGPTConversation } from './live-sync.js';
import { isApiMode } from './api-writer.js';
import {
  loadJobs,
  createJob,
  getJob,
  updateJob,
  deleteJob,
} from './job-store.js';
import { getRecentRuns, createRun, updateRun } from './run-store.js';
import { scheduleJob, unscheduleJob, runJobNow } from './scheduler.js';
import { enqueue, getQueueStatus } from './scheduler-queue.js';
import {
  isSincePreset,
  isCadencePreset,
  resolveSincePresetToMs,
  SINCE_PRESETS,
  CADENCE_PRESETS,
  CADENCE_BOUNDARY_LABELS,
  CADENCE_PRESET_MINUTES,
  COMPACT_PRESET_LABELS,
  type SincePreset,
  type CadencePreset,
} from './since-presets.js';

const router = Router();

// ── Auth middleware ────────────────────────────────────────────────────────────

function requireAuth(_req: Request, res: Response, next: NextFunction): void {
  const uiToken = process.env.UI_TOKEN;
  if (!uiToken) { next(); return; }

  const authHeader = _req.headers['authorization'];
  const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
  const queryToken = typeof _req.query.token === 'string' ? _req.query.token : undefined;
  const provided = bearer ?? queryToken;

  if (!provided || provided !== uiToken) {
    res.status(401).json({ error: 'Unauthorized: invalid or missing UI_TOKEN.' });
    return;
  }
  next();
}

// ── Sync UI ────────────────────────────────────────────────────────────────────

router.get('/sync', (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildSyncUI());
});

// ── API: session status ────────────────────────────────────────────────────────

router.get('/api/session/status', async (_req: Request, res: Response) => {
  if (!hasSession()) { res.json({ authenticated: false }); return; }
  // Check JWT expiry directly instead of re-validating server-side
  const token = getAccessToken();
  let isExpired = false;
  try {
    const parts = (token ?? '').split('.');
    if (parts.length >= 2) {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { exp?: number };
      isExpired = !!payload.exp && payload.exp < Math.floor(Date.now() / 1000);
    }
  } catch {}
  if (isExpired) { res.json({ authenticated: false, error: 'Token expired' }); return; }
  const info = getSessionInfo();
  res.json({
    authenticated: true,
    user: info.userName,
    email: info.userEmail,
  });
});

// ── API: conversations list (cached 15min) ─────────────────────────────────────

router.get('/api/conversations', requireAuth, async (_req: Request, res: Response) => {
  if (!hasSession()) { res.status(401).json({ error: 'Not authenticated' }); return; }
  const result = await listConversationsForUI();
  if (result.error) { res.status(500).json({ error: result.error }); return; }
  res.json(result.conversations);
});

// ── API: manual sync ──────────────────────────────────────────────────────────

router.post('/api/sync', requireAuth, async (req: Request, res: Response) => {
  const {
    channel,
    limit,
    sincePreset: sincePresetRaw,
  } = req.body as {
    channel?: string;
    limit?: string | number;
    sincePreset?: string;
  };

  if (!channel || typeof channel !== 'string' || !channel.trim()) {
    res.status(400).json({ error: 'channel (conversation ID or "all") is required.' });
    return;
  }

  const sincePreset: SincePreset | undefined =
    sincePresetRaw && isSincePreset(sincePresetRaw) ? sincePresetRaw : undefined;
  if (sincePresetRaw && !sincePreset) {
    res.status(400).json({ error: `Invalid sincePreset '${sincePresetRaw}'.` });
    return;
  }

  if (!isApiMode() && !process.env.DATABASE_URL) {
    res.status(500).json({ error: 'No write backend configured.' });
    return;
  }

  if (!hasSession()) {
    res.status(500).json({ error: 'No ChatGPT session. Please log in first via /login.' });
    return;
  }

  // Skip server-side validateSession() — it re-fetches from ChatGPT and fails.
  // hasSession() above already confirms we have a token. The actual API calls
  // will fail with 401 if the token is truly invalid.

  const parsedLimit = limit !== undefined && limit !== '' ? parseInt(String(limit), 10) : undefined;
  const now = new Date();
  const effectiveSinceMs = sincePreset ? resolveSincePresetToMs(sincePreset, now) : undefined;

  const startedAt = now.toISOString();
  const convTitle = await fetchConversationTitle(channel.trim()).catch(() => null);

  const run = await createRun({
    startedAt,
    status: 'queued',
    channel: channel.trim(),
    channelName: convTitle ?? undefined,
    params: {
      limit: parsedLimit,
      sincePreset,
      effectiveAfter: effectiveSinceMs !== undefined ? new Date(effectiveSinceMs).toISOString() : undefined,
    },
    fetchedCount: 0,
    insertedCount: 0,
    updatedCount: 0,
    skippedCount: 0,
    attachmentsSeen: 0,
  });

  let syncResult: { fetched: number; inserted: number; updated: number; skipped: number; attachmentsSeen: number } | null = null;
  let syncError: string | null = null;

  const { promise } = enqueue(`manual:${run.runId}`, `manual sync #${channel.trim()}`, async () => {
    await updateRun(run.runId, { status: 'running' });
    try {
      const result = await syncChatGPTConversation(channel.trim(), {
        sinceMs: effectiveSinceMs,
        limit: parsedLimit,
        verbose: false,
      });
      const finishedAt = new Date().toISOString();
      await updateRun(run.runId, {
        finishedAt,
        status: 'success',
        fetchedCount: result.fetched,
        insertedCount: result.inserted,
        updatedCount: result.updated,
        skippedCount: result.skipped,
        attachmentsSeen: result.attachmentsSeen,
      });
      syncResult = result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      await updateRun(run.runId, { finishedAt: new Date().toISOString(), status: 'error', error: message });
      syncError = message;
      throw err;
    }
  });

  await promise.catch(() => {});

  if (syncError) {
    res.status(500).json({ error: syncError, runId: run.runId });
    return;
  }

  res.json({
    success: true,
    runId: run.runId,
    channel: channel.trim(),
    channelName: convTitle ?? null,
    user: validation.user,
    sincePreset: sincePreset ?? null,
    effectiveSinceMs: effectiveSinceMs ?? null,
    ...(syncResult ?? {}),
  });
});

// ── API: jobs ─────────────────────────────────────────────────────────────────

router.get('/api/jobs', requireAuth, async (_req: Request, res: Response) => {
  const jobs = await loadJobs();
  res.json(jobs);
});

router.post('/api/jobs', requireAuth, async (req: Request, res: Response) => {
  const {
    name,
    channel,
    limit,
    sincePreset: sincePresetRaw,
    cadencePreset: cadencePresetRaw,
    intervalMinutes: intervalMinutesRaw,
    enabled,
  } = req.body as {
    name?: string;
    channel?: string;
    limit?: number;
    sincePreset?: string;
    cadencePreset?: string;
    intervalMinutes?: number;
    enabled?: boolean;
  };

  if (!channel || !channel.trim()) {
    res.status(400).json({ error: 'channel (conversation ID or "all") is required.' });
    return;
  }

  const cadencePreset: CadencePreset | undefined =
    cadencePresetRaw && isCadencePreset(cadencePresetRaw) ? cadencePresetRaw : undefined;
  if (cadencePresetRaw && !cadencePreset) {
    res.status(400).json({ error: `Invalid cadencePreset '${cadencePresetRaw}'.` });
    return;
  }

  const intervalMinutes = cadencePreset
    ? CADENCE_PRESET_MINUTES[cadencePreset]
    : (intervalMinutesRaw !== undefined && Number(intervalMinutesRaw) > 0 ? Number(intervalMinutesRaw) : 60);

  const sincePreset: SincePreset | undefined =
    sincePresetRaw && isSincePreset(sincePresetRaw) ? sincePresetRaw : undefined;
  if (sincePresetRaw && !sincePreset) {
    res.status(400).json({ error: `Invalid sincePreset '${sincePresetRaw}'.` });
    return;
  }

  const effectiveSincePreset: SincePreset | undefined = sincePreset ?? (cadencePreset as SincePreset | undefined);

  // Auto-generate job name
  let jobName = (name ?? '').trim();
  if (!jobName) {
    const convLabel = channel.trim() === 'all' ? 'All Conversations' :
      (await fetchConversationTitle(channel.trim()).catch(() => null)) ?? channel.trim().slice(0, 8) + '…';
    const cadenceLabel = cadencePreset
      ? COMPACT_PRESET_LABELS[cadencePreset as SincePreset]
      : `${intervalMinutes}m`;
    jobName = `"${convLabel}" every ${cadenceLabel}`;
  }

  const job = await createJob({
    name: jobName,
    channel: channel.trim(),
    limit: limit !== undefined ? Number(limit) : undefined,
    sincePreset: effectiveSincePreset,
    cadencePreset,
    intervalMinutes,
    enabled: enabled !== false,
  });

  if (job.enabled) scheduleJob(job);
  res.status(201).json(job);
});

router.post('/api/jobs/:id/run', requireAuth, async (req: Request, res: Response) => {
  const job = await getJob(String(req.params.id));
  if (!job) { res.status(404).json({ error: 'Job not found.' }); return; }
  runJobNow(job).catch((err: unknown) => console.error(`[API] runJobNow error:`, err));
  res.json({ success: true, message: 'Job enqueued. Check /api/runs for result.' });
});

router.post('/api/jobs/:id/run-all', requireAuth, async (req: Request, res: Response) => {
  const job = await getJob(String(req.params.id));
  if (!job) { res.status(404).json({ error: 'Job not found.' }); return; }
  runJobNow(job, { sincePreset: 'all', limit: undefined }).catch((err: unknown) =>
    console.error(`[API] run-all error:`, err)
  );
  res.json({ success: true, message: 'Run-all enqueued. Check /api/runs for progress.' });
});

router.get('/api/scheduler/status', requireAuth, (_req: Request, res: Response) => {
  res.json(getQueueStatus());
});

router.patch('/api/jobs/:id', requireAuth, async (req: Request, res: Response) => {
  const {
    name,
    channel,
    limit,
    sincePreset: sincePresetRaw,
    cadencePreset: cadencePresetRaw,
    intervalMinutes: intervalMinutesRaw,
    enabled,
    startDate,
    lastSyncedAt,
  } = req.body as {
    name?: string;
    channel?: string;
    limit?: number | null;
    sincePreset?: string | null;
    cadencePreset?: string | null;
    intervalMinutes?: number;
    enabled?: boolean;
    startDate?: string | null;
    lastSyncedAt?: string | null;
  };

  const jobId = String(req.params.id);
  const patch: Record<string, unknown> = {};
  if (name !== undefined) patch.name = String(name).trim();
  if (channel !== undefined) patch.channel = String(channel).trim();
  if (limit !== undefined) patch.limit = limit === null ? undefined : Number(limit);
  if (enabled !== undefined) patch.enabled = Boolean(enabled);

  if (cadencePresetRaw !== undefined) {
    if (cadencePresetRaw === null || cadencePresetRaw === '') {
      patch.cadencePreset = undefined;
    } else if (isCadencePreset(cadencePresetRaw)) {
      patch.cadencePreset = cadencePresetRaw;
      patch.intervalMinutes = CADENCE_PRESET_MINUTES[cadencePresetRaw];
    } else {
      res.status(400).json({ error: `Invalid cadencePreset '${cadencePresetRaw}'.` });
      return;
    }
  } else if (intervalMinutesRaw !== undefined) {
    patch.intervalMinutes = Math.max(1, Number(intervalMinutesRaw));
  }

  if (sincePresetRaw !== undefined) {
    if (sincePresetRaw === null || sincePresetRaw === '') {
      patch.sincePreset = undefined;
    } else if (isSincePreset(sincePresetRaw)) {
      patch.sincePreset = sincePresetRaw;
    } else {
      res.status(400).json({ error: `Invalid sincePreset '${sincePresetRaw}'.` });
      return;
    }
  }

  if (startDate !== undefined) {
    patch.startDate = startDate === null || startDate === '' ? undefined : String(startDate).trim() || undefined;
  }
  if (lastSyncedAt !== undefined) {
    patch.lastSyncedAt = lastSyncedAt === null || lastSyncedAt === '' ? undefined : String(lastSyncedAt).trim() || undefined;
  }

  const updated = await updateJob(jobId, patch as Parameters<typeof updateJob>[1]);
  if (!updated) { res.status(404).json({ error: 'Job not found.' }); return; }

  if (updated.enabled) scheduleJob(updated);
  else unscheduleJob(updated.id);

  res.json(updated);
});

router.post('/api/jobs/:id/reset-sync', requireAuth, async (req: Request, res: Response) => {
  const jobId = String(req.params.id);
  const job = await updateJob(jobId, { lastSyncedAt: undefined } as Parameters<typeof updateJob>[1]);
  if (!job) { res.status(404).json({ error: 'Job not found.' }); return; }
  res.json(job);
});

router.delete('/api/jobs/:id', requireAuth, async (req: Request, res: Response) => {
  const delId = String(req.params.id);
  unscheduleJob(delId);
  const ok = await deleteJob(delId);
  if (!ok) { res.status(404).json({ error: 'Job not found.' }); return; }
  res.json({ success: true });
});

router.get('/api/runs', requireAuth, async (req: Request, res: Response) => {
  const limit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : 50;
  const runs = await getRecentRuns(Math.min(Math.max(1, limit), 200));
  res.json(runs);
});

// ── HTML UI ───────────────────────────────────────────────────────────────────

function buildSyncUI(): string {
  const requiresAuth = Boolean(process.env.UI_TOKEN);

  const cadenceOptions = CADENCE_PRESETS.map(p =>
    `<option value="${p}">${COMPACT_PRESET_LABELS[p as SincePreset]}</option>`
  ).join('\n      ');

  const sinceOptions = SINCE_PRESETS.map(p =>
    `<option value="${p}">${COMPACT_PRESET_LABELS[p]}</option>`
  ).join('\n      ');

  const jsCompactLabels = JSON.stringify(
    Object.fromEntries(SINCE_PRESETS.map(p => [p, COMPACT_PRESET_LABELS[p]]))
  );
  const jsCadenceBoundaries = JSON.stringify(CADENCE_BOUNDARY_LABELS);
  const jsCadencePresetsArr = JSON.stringify(CADENCE_PRESETS);
  const jsAllSincePresetsArr = JSON.stringify(SINCE_PRESETS);

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>ChatGPT Sync — OpenClaw</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#1a1a1a;color:#e0e0e0;font-family:system-ui,sans-serif;min-height:100vh;padding:24px 16px}
.page{max-width:900px;margin:0 auto}
h1{font-size:1.5rem;font-weight:700;color:#fff}
.subtitle{color:#888;font-size:.875rem;margin-bottom:20px;margin-top:2px}
.card{background:#2a2a2a;border:1px solid #3d3d3d;border-radius:12px;padding:20px;margin-bottom:16px}
.card-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}
.card-title{font-size:1rem;font-weight:600;color:#ccc}
.field{margin-bottom:14px}
label{display:block;font-size:.78rem;font-weight:600;color:#aaa;text-transform:uppercase;letter-spacing:.05em;margin-bottom:3px}
.field-hint{font-size:.76rem;color:#666;margin-bottom:5px;line-height:1.4}
input[type=text],input[type=password],input[type=number],select{width:100%;background:#383838;border:1px solid #555;color:#e0e0e0;border-radius:6px;padding:8px 11px;font-size:.88rem;outline:none;transition:border-color .15s}
input:focus,select:focus{border-color:#10a37f;box-shadow:0 0 0 2px rgba(16,163,127,.25)}
input::placeholder{color:#555}
select option{background:#2a2a2a}
.badge{display:inline-block;font-size:.62rem;padding:1px 5px;border-radius:4px;vertical-align:middle;margin-left:5px;text-transform:uppercase;letter-spacing:.04em;font-weight:700}
.badge-req{background:#10a37f;color:#fff}
.badge-opt{background:#4f545c;color:#aaa}
.btn{display:inline-flex;align-items:center;gap:6px;border:none;border-radius:6px;padding:8px 14px;font-size:.85rem;font-weight:600;cursor:pointer;transition:background .15s;white-space:nowrap}
.btn-primary{background:#10a37f;color:#fff;width:100%;justify-content:center;padding:10px;font-size:.95rem;border-radius:8px;margin-top:4px}
.btn-primary:hover:not(:disabled){background:#0d8f6e}
.btn-primary:disabled{background:#374151;cursor:not-allowed;color:#6b7280}
.btn-sm{padding:4px 9px;font-size:.78rem;border-radius:5px}
.btn-success{background:#22c55e;color:#000}
.btn-success:hover{background:#16a34a}
.btn-warn{background:#f59e0b;color:#000}
.btn-warn:hover{background:#d97706}
.btn-danger{background:#ef4444;color:#fff}
.btn-danger:hover{background:#dc2626}
.btn-ghost{background:#4f545c;color:#ccc}
.btn-ghost:hover{background:#67707b}
.btn-run{background:#10a37f;color:#fff}
.btn-run:hover{background:#0d8f6e}
.top-bar{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:8px}
.top-bar-left{display:flex;flex-direction:column}
#auth-bar{display:flex;align-items:center;gap:8px;margin-top:4px}
.auth-status{font-size:.78rem;color:#aaa}
.auth-status.ok{color:#22c55e}
.nav-link{color:#10a37f;font-size:.82rem;text-decoration:none}
.nav-link:hover{text-decoration:underline}
.login-status-bar{display:flex;align-items:center;gap:8px;padding:8px 12px;background:#1e1e1e;border:1px solid #3d3d3d;border-radius:6px;font-size:.82rem;margin-bottom:12px}
.login-dot{width:10px;height:10px;border-radius:50%;background:#555;flex-shrink:0}
.login-dot.ok{background:#22c55e}
.login-dot.err{background:#ef4444}
.result-box{margin-top:12px;background:#1e1e1e;border:1px solid #555;border-radius:8px;padding:14px;font-size:.82rem}
.result-box.ok{border-color:#22c55e}
.result-box.err{border-color:#ef4444}
.result-label{font-size:.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#888;margin-bottom:6px}
pre{white-space:pre-wrap;word-break:break-word;font-family:'Courier New',monospace;font-size:.8rem;color:#e0e0e0;line-height:1.5}
.spinner{display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,.25);border-top-color:#fff;border-radius:50%;animation:spin .65s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
table{width:100%;border-collapse:collapse;font-size:.8rem}
thead th{color:#888;font-size:.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;padding:6px 8px;border-bottom:1px solid #3d4046;text-align:left}
tbody td{padding:7px 8px;border-bottom:1px solid #2a2d31;vertical-align:middle}
tbody tr:last-child td{border-bottom:none}
tbody tr:hover td{background:rgba(255,255,255,.03)}
.status-pill{display:inline-block;font-size:.68rem;font-weight:700;padding:2px 7px;border-radius:99px;letter-spacing:.04em}
.pill-ok{background:rgba(34,197,94,.15);color:#22c55e;border:1px solid rgba(34,197,94,.3)}
.pill-err{background:rgba(239,68,68,.15);color:#ef4444;border:1px solid rgba(239,68,68,.3)}
.pill-run{background:rgba(251,191,36,.15);color:#fbbf24;border:1px solid rgba(251,191,36,.3)}
.pill-dis{background:rgba(100,116,139,.15);color:#64748b;border:1px solid rgba(100,116,139,.3)}
.pill-blue{background:rgba(16,163,127,.15);color:#10a37f;border:1px solid rgba(16,163,127,.3)}
.empty-row{text-align:center;color:#555;padding:20px;font-size:.85rem}
.actions{display:flex;gap:4px;flex-wrap:wrap}
.mono{font-family:'Courier New',monospace;font-size:.78rem;color:#10a37f}
.err-text{color:#f87171;font-size:.75rem}
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.75);display:flex;align-items:center;justify-content:center;z-index:100;backdrop-filter:blur(3px)}
.modal-card{background:#2a2a2a;border:1px solid #10a37f;border-radius:14px;padding:28px;width:100%;max-width:420px;box-shadow:0 16px 40px rgba(0,0,0,.5)}
.modal-card h2{font-size:1.1rem;font-weight:700;color:#fff;margin-bottom:6px}
.modal-card p{color:#888;font-size:.85rem;margin-bottom:18px;line-height:1.5}
.modal-card label{font-size:.78rem;font-weight:600;color:#aaa;text-transform:uppercase;letter-spacing:.05em;display:block;margin-bottom:5px}
.modal-card input{width:100%;background:#383838;border:1px solid #555;color:#e0e0e0;border-radius:6px;padding:10px 12px;font-size:.9rem;outline:none;margin-bottom:12px}
.modal-card input:focus{border-color:#10a37f}
.modal-err{color:#f87171;font-size:.8rem;margin-bottom:8px;display:none}
.scroll-x{overflow-x:auto}
.field-disabled input,.field-disabled select{opacity:.45;cursor:not-allowed}
.field-disabled label{opacity:.6}
.auto-name-preview{font-size:.78rem;color:#10a37f;margin-top:4px;min-height:1.1em}
.boundary-info{font-size:.74rem;color:#9ca3af;background:#1e1e1e;border:1px solid #3d4046;border-radius:5px;padding:6px 9px;margin-top:5px;line-height:1.4}
.boundary-info strong{color:#d1d5db}
.queue-row{display:flex;gap:20px;flex-wrap:wrap;align-items:center}
.queue-stat{display:flex;flex-direction:column;align-items:center;gap:2px}
.queue-stat .qs-value{font-size:1.4rem;font-weight:700;color:#fff;line-height:1}
.queue-stat .qs-label{font-size:.68rem;text-transform:uppercase;letter-spacing:.06em;color:#666}
.queue-ids{font-size:.76rem;color:#9ca3af;margin-top:8px;line-height:1.5}
.queue-ids strong{color:#ccc}
.edit-modal-card{max-width:520px;border-color:#555}
.edit-modal-card h2{margin-bottom:14px}
.edit-row{display:flex;gap:12px;align-items:flex-end;margin-bottom:14px}
.edit-row .edit-col{flex:1;min-width:0}
.edit-row .edit-col label{display:block;font-size:.78rem;font-weight:600;color:#aaa;text-transform:uppercase;letter-spacing:.05em;margin-bottom:3px}
.edit-row .edit-col select{width:100%}
.edit-link-col{display:flex;flex-direction:column;align-items:center;padding-bottom:4px;gap:3px;min-width:44px}
.edit-link-col .link-label{font-size:.68rem;color:#888;text-transform:uppercase;letter-spacing:.04em}
.edit-link-col input[type=checkbox]{width:20px;height:20px;cursor:pointer;accent-color:#10a37f}
.edit-enabled-row{display:flex;align-items:center;gap:8px;margin-bottom:14px}
.edit-enabled-row input[type=checkbox]{width:16px;height:16px;cursor:pointer;accent-color:#10a37f;flex-shrink:0}
.edit-enabled-row label{font-size:.88rem;color:#ccc;text-transform:none;letter-spacing:0;margin-bottom:0;cursor:pointer}
.edit-err{color:#f87171;font-size:.8rem;margin-bottom:8px;display:none}
.edit-footer{display:flex;gap:8px;justify-content:flex-end;margin-top:6px}
.edit-footer .btn-primary{width:auto;margin-top:0;padding:8px 20px;font-size:.88rem}
</style>
</head>
<body>
<div class="page">

<!-- Auth Modal -->
<div class="modal-overlay" id="auth-modal" style="display:none">
  <div class="modal-card">
    <h2>🔑 Authentication Required</h2>
    <p>This Sync UI requires a token. Enter your <code>UI_TOKEN</code> to unlock access.</p>
    <label>UI Token</label>
    <input type="password" id="modal-token-input" placeholder="Paste your UI_TOKEN here" autocomplete="current-password"/>
    <div class="modal-err" id="modal-err">Incorrect token — please try again.</div>
    <button class="btn btn-primary" onclick="submitModalToken()" style="margin-top:0">Unlock</button>
  </div>
</div>

<div class="top-bar">
  <div class="top-bar-left">
    <h1>🤖 ChatGPT Sync</h1>
    <p class="subtitle">Pull conversations from ChatGPT into the OpenClaw memory database.</p>
  </div>
  <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px">
    <a class="nav-link" id="nav-login">← ChatGPT Login</a>
    <a class="nav-link" id="nav-backfill">🗂 Backfill Attachments</a>
    <div id="auth-bar" style="display:none">
      <span class="auth-status" id="auth-status-text">🔓 Authenticated</span>
      <button class="btn btn-sm btn-ghost" onclick="clearSavedToken()">Clear Token</button>
    </div>
  </div>
</div>

<!-- Login Status -->
<div class="login-status-bar" id="login-status-bar">
  <span class="login-dot" id="login-dot"></span>
  <span id="login-status-text">Checking ChatGPT session…</span>
  <a class="nav-link" id="nav-login2" style="margin-left:auto">Manage Login →</a>
</div>

<!-- Scheduler Queue Widget -->
<div class="card" id="queue-card">
  <div class="card-header">
    <span class="card-title">⚙️ Scheduler Queue</span>
    <button class="btn btn-sm btn-ghost" onclick="loadQueueStatus()">↻ Refresh</button>
  </div>
  <div id="queue-status-container" style="font-size:.82rem;color:#aaa">Loading…</div>
</div>

<!-- New Sync Card -->
<div class="card">
  <div class="card-header">
    <span class="card-title">⚡ New Sync</span>
  </div>

  <div class="field">
    <label>Mode</label>
    <p class="field-hint">Choose to run a one-off sync immediately, or create a scheduled job that repeats on a cadence.</p>
    <select id="mode" onchange="onModeChange()">
      <option value="manual">Manual Run — execute immediately</option>
      <option value="scheduled">Scheduled Job — repeat on cadence</option>
    </select>
  </div>

  <!-- Scheduled-only: job name -->
  <div class="field field-sched-only" style="display:none" id="field-name">
    <label>Job Name <span class="badge badge-opt">optional</span></label>
    <p class="field-hint">Leave blank to auto-generate from conversation and cadence.</p>
    <input type="text" id="job-name" placeholder="Leave blank to auto-generate" oninput="updateAutoNamePreview()"/>
    <div class="auto-name-preview" id="auto-name-preview"></div>
  </div>

  <!-- Conversation picker -->
  <div class="field">
    <label>Conversation <span class="badge badge-req">required</span></label>
    <p class="field-hint">Select a conversation, choose "All Conversations", or paste a conversation UUID.</p>
    <select id="conv-select" onchange="onConvSelect()">
      <option value="">— Loading conversations… —</option>
    </select>
    <input type="text" id="channel" placeholder="or paste conversation UUID" autocomplete="off" oninput="updateAutoNamePreview()" style="margin-top:6px"/>
  </div>

  <!-- Cadence (scheduled only) -->
  <div class="field field-sched-only" style="display:none" id="field-cadence">
    <label>Cadence <span class="badge badge-req">required</span></label>
    <p class="field-hint">How often this job runs. Jobs fire on <strong>natural UTC boundaries</strong>.</p>
    <select id="cadence" onchange="onCadenceChange()">
      ${cadenceOptions}
    </select>
    <div class="boundary-info" id="cadence-boundary-info">
      <strong>Boundary:</strong> <span id="cadence-boundary-text"></span>
    </div>
  </div>

  <!-- Since preset -->
  <div class="field">
    <label>Since <span class="badge badge-opt">optional</span></label>
    <p class="field-hint" id="since-hint-manual">Only sync conversations updated in the last N time window. Overrides manual since when set.</p>
    <p class="field-hint" id="since-hint-scheduled" style="display:none">Lookback window per run. Defaults to the cadence window.</p>
    <select id="since-preset" onchange="onSinceChange()">
      <option value="">— All (no time filter) —</option>
      ${sinceOptions}
    </select>
  </div>

  <!-- Limit (manual only) -->
  <div class="field field-manual-only" id="field-limit">
    <label>Max Conversations <span class="badge badge-opt">optional</span></label>
    <p class="field-hint">Max conversations to process (for "All" mode). Leave blank for unlimited.</p>
    <input type="number" id="limit" min="1" placeholder="Unlimited"/>
  </div>

  <button class="btn btn-primary" id="submit-btn" onclick="handleSubmit()">▶ Run Sync</button>
  <div id="sync-result"></div>
</div>

<!-- Scheduled Jobs -->
<div class="card">
  <div class="card-header">
    <span class="card-title">📅 Scheduled Jobs</span>
    <button class="btn btn-sm btn-ghost" onclick="loadJobsTable()">↻ Refresh</button>
  </div>
  <div class="scroll-x" id="jobs-container">
    <div style="color:#555;font-size:.85rem">Loading jobs…</div>
  </div>
</div>

<!-- Recent Runs -->
<div class="card">
  <div class="card-header">
    <span class="card-title">📋 Recent Runs</span>
    <button class="btn btn-sm btn-ghost" onclick="loadRunsTable()">↻ Refresh</button>
  </div>
  <div class="scroll-x" id="runs-container">
    <div style="color:#555;font-size:.85rem">Loading runs…</div>
  </div>
</div>

</div><!-- .page -->
<script>
const BASE = (() => { const p = location.pathname.replace(/\\/sync\\/?$/, ''); return p + '/api'; })();
const NAV_BASE = location.pathname.replace(/\\/sync\\/?$/, '');
(function() {
  document.getElementById('nav-login').href = NAV_BASE + '/login';
  document.getElementById('nav-backfill').href = NAV_BASE + '/backfill';
  document.getElementById('nav-login2').href = NAV_BASE + '/login';
})();
const REQUIRES_AUTH = ${requiresAuth ? 'true' : 'false'};
const TOKEN_KEY = 'chatgpt_sync_ui_token';
const COMPACT_LABELS = ${jsCompactLabels};
const CADENCE_BOUNDARIES = ${jsCadenceBoundaries};
const CADENCE_PRESET_VALUES = ${jsCadencePresetsArr};
const ALL_SINCE_PRESET_VALUES = ${jsAllSincePresetsArr};

function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }
function saveToken(val) { localStorage.setItem(TOKEN_KEY, val); }
function clearSavedToken() {
  localStorage.removeItem(TOKEN_KEY);
  updateAuthBar();
  if (REQUIRES_AUTH) showModal();
}
function getHeaders(extra) {
  const h = Object.assign({ 'Content-Type': 'application/json' }, extra || {});
  const t = getToken();
  if (t) h['Authorization'] = 'Bearer ' + t;
  return h;
}

function showModal() { document.getElementById('auth-modal').style.display = 'flex'; setTimeout(() => document.getElementById('modal-token-input').focus(), 50); }
function hideModal() { document.getElementById('auth-modal').style.display = 'none'; }

async function submitModalToken() {
  const input = document.getElementById('modal-token-input');
  const errEl = document.getElementById('modal-err');
  const val = input.value.trim();
  if (!val) return;
  errEl.style.display = 'none';
  try {
    const res = await fetch(BASE + '/jobs', { headers: { 'Authorization': 'Bearer ' + val, 'Content-Type': 'application/json' } });
    if (res.status === 401) { errEl.style.display = 'block'; return; }
    saveToken(val); hideModal(); updateAuthBar(); loadAll();
  } catch { errEl.textContent = 'Network error — try again.'; errEl.style.display = 'block'; }
}
document.getElementById('modal-token-input').addEventListener('keydown', e => { if (e.key === 'Enter') submitModalToken(); });

function updateAuthBar() {
  const bar = document.getElementById('auth-bar');
  const txt = document.getElementById('auth-status-text');
  if (!REQUIRES_AUTH) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  if (getToken()) { txt.textContent = '🔓 Authenticated'; txt.className = 'auth-status ok'; }
  else { txt.textContent = '🔒 Not authenticated'; txt.className = 'auth-status'; }
}

async function loadLoginStatus() {
  const dot = document.getElementById('login-dot');
  const txt = document.getElementById('login-status-text');
  try {
    const res = await fetch(BASE + '/session/status');
    const data = await res.json();
    if (data.authenticated) {
      dot.className = 'login-dot ok';
      txt.textContent = '✅ Logged in' + (data.user ? ' as ' + data.user : '') + (data.email ? ' (' + data.email + ')' : '');
    } else {
      dot.className = 'login-dot err';
      txt.textContent = '⚠️ Not logged in — sync actions require a session. Click Manage Login →';
    }
  } catch {
    dot.className = 'login-dot err';
    txt.textContent = 'Could not check login status.';
  }
}

function onModeChange() {
  const mode = document.getElementById('mode').value;
  const isScheduled = mode === 'scheduled';
  for (const el of document.querySelectorAll('.field-sched-only')) el.style.display = isScheduled ? '' : 'none';
  for (const el of document.querySelectorAll('.field-manual-only')) el.style.display = isScheduled ? 'none' : '';
  document.getElementById('since-hint-manual').style.display = isScheduled ? 'none' : '';
  document.getElementById('since-hint-scheduled').style.display = isScheduled ? '' : 'none';
  document.getElementById('submit-btn').textContent = isScheduled ? '📅 Create Scheduled Job' : '▶ Run Sync';
  onCadenceChange();
  updateAutoNamePreview();
}

function onCadenceChange() {
  const cadence = document.getElementById('cadence').value;
  const el = document.getElementById('cadence-boundary-text');
  if (el) el.textContent = CADENCE_BOUNDARIES[cadence] || '';
  updateAutoNamePreview();
}

function updateAutoNamePreview() {
  const mode = document.getElementById('mode').value;
  const nameEl = document.getElementById('auto-name-preview');
  if (!nameEl || mode !== 'scheduled') { if (nameEl) nameEl.textContent = ''; return; }
  const nameFilled = document.getElementById('job-name').value.trim();
  if (nameFilled) { nameEl.textContent = ''; return; }
  const channel = document.getElementById('channel').value.trim() || 'conversation';
  const cadence = document.getElementById('cadence').value;
  const label = COMPACT_LABELS[cadence] || cadence;
  nameEl.textContent = 'Auto-name: "' + channel + '" every ' + label;
}

function onSinceChange() {}

async function handleSubmit() {
  const mode = document.getElementById('mode').value;
  if (mode === 'scheduled') await handleCreateJob();
  else await handleRunSync();
}

async function handleRunSync() {
  const channel = document.getElementById('channel').value.trim();
  if (!channel) { showResult('error', 'Conversation ID or "all" is required.'); return; }
  const limit = document.getElementById('limit').value.trim();
  const sincePreset = document.getElementById('since-preset').value;
  const btn = document.getElementById('submit-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Syncing\u2026';
  try {
    const body = { channel };
    if (limit) body.limit = parseInt(limit, 10);
    if (sincePreset) body.sincePreset = sincePreset;
    const res = await fetch(BASE + '/sync', { method: 'POST', headers: getHeaders(), body: JSON.stringify(body) });
    const data = await res.json();
    if (res.ok && data.success) { showResult('ok', '✅ Sync complete', data); loadRunsTable(); }
    else { showResult('error', '❌ Sync failed (HTTP ' + res.status + ')', data); }
  } catch (err) {
    showResult('error', '❌ Network error: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '▶ Run Sync';
  }
}

async function handleCreateJob() {
  const name = document.getElementById('job-name').value.trim();
  const channel = document.getElementById('channel').value.trim();
  const cadence = document.getElementById('cadence').value;
  const sincePreset = document.getElementById('since-preset').value;
  if (!channel) { showResult('error', 'Conversation ID or "all" is required.'); return; }
  if (!cadence) { showResult('error', 'Cadence is required.'); return; }
  const btn = document.getElementById('submit-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Creating\u2026';
  try {
    const body = { channel, cadencePreset: cadence, enabled: true };
    if (name) body.name = name;
    if (sincePreset) body.sincePreset = sincePreset;
    const res = await fetch(BASE + '/jobs', { method: 'POST', headers: getHeaders(), body: JSON.stringify(body) });
    const data = await res.json();
    if (res.ok && data.id) {
      showResult('ok', '✅ Scheduled job created: ' + esc(data.name), data);
      loadJobsTable();
      document.getElementById('job-name').value = '';
      document.getElementById('channel').value = '';
      document.getElementById('since-preset').value = '';
      document.getElementById('cadence').value = '1h';
      onCadenceChange(); updateAutoNamePreview();
    } else { showResult('error', '❌ Failed (HTTP ' + res.status + ')', data); }
  } catch (err) { showResult('error', '❌ Network error: ' + err.message); }
  finally { btn.disabled = false; btn.textContent = '📅 Create Scheduled Job'; }
}

function showResult(type, label, data) {
  const cls = type === 'ok' ? 'ok' : 'err';
  const body = data ? '<pre>' + esc(JSON.stringify(data, null, 2)) + '</pre>' : '';
  document.getElementById('sync-result').innerHTML =
    '<div class="result-box ' + cls + '"><div class="result-label">' + esc(label) + '</div>' + body + '</div>';
}

let _loadedJobs = [];
async function loadJobsTable() {
  const el = document.getElementById('jobs-container');
  try {
    const res = await fetch(BASE + '/jobs', { headers: getHeaders() });
    if (res.status === 401) { el.innerHTML = '<p style="color:#f87171;font-size:.85rem">Not authenticated.</p>'; return; }
    const jobs = await res.json();
    _loadedJobs = jobs;
    el.innerHTML = renderJobsTable(jobs);
  } catch (err) { el.innerHTML = '<p style="color:#f87171;font-size:.85rem">Error: ' + esc(err.message) + '</p>'; }
}

function renderJobsTable(jobs) {
  if (!jobs.length) return '<p style="color:#555;font-size:.85rem;padding:12px 0">No scheduled jobs yet.</p>';
  const rows = jobs.map(function(j) {
    const statusPill = j.lastStatus === 'success' ? '<span class="status-pill pill-ok">success</span>'
      : j.lastStatus === 'error' ? '<span class="status-pill pill-err">error</span>'
      : j.lastStatus === 'running' ? '<span class="status-pill pill-run">running</span>'
      : '<span class="status-pill pill-dis">never</span>';
    const enabledPill = j.enabled ? '<span class="status-pill pill-ok">enabled</span>' : '<span class="status-pill pill-dis">disabled</span>';
    const lastRun = j.lastRunAt ? reltime(j.lastRunAt) : '—';
    const toggleLabel = j.enabled ? 'Disable' : 'Enable';
    const toggleClass = j.enabled ? 'btn-warn' : 'btn-success';
    const cadenceCell = j.cadencePreset
      ? '<span class="status-pill pill-blue" title="' + esc(CADENCE_BOUNDARIES[j.cadencePreset] || '') + '">' + esc(COMPACT_LABELS[j.cadencePreset] || j.cadencePreset) + '</span>'
      : '<span class="mono">' + j.intervalMinutes + 'm</span>';
    const sinceCell = j.sincePreset
      ? '<span class="status-pill pill-run">' + esc(COMPACT_LABELS[j.sincePreset] || j.sincePreset) + '</span>'
      : '—';
    const convCell = j.channel === 'all' ? '<span class="status-pill pill-blue">All</span>' : '<span class="mono" title="' + esc(j.channel) + '">' + esc(j.channel.slice(0,8)) + '…</span>';
    return '<tr>' +
      '<td>' + esc(j.name) + '</td>' +
      '<td>' + convCell + '</td>' +
      '<td>' + cadenceCell + '</td>' +
      '<td>' + sinceCell + '</td>' +
      '<td>' + enabledPill + '</td>' +
      '<td>' + lastRun + '</td>' +
      '<td>' + statusPill + '</td>' +
      '<td><div class="actions">' +
        '<button class="btn btn-sm btn-run" onclick="triggerJobRun(&apos;' + esc(j.id) + '&apos;, this)">▶ Run</button>' +
        '<button class="btn btn-sm btn-primary" onclick="triggerJobRunAll(&apos;' + esc(j.id) + '&apos;, this)">⟳ All</button>' +
        '<button class="btn btn-sm btn-ghost" onclick="editJob(&apos;' + esc(j.id) + '&apos;)">✏ Edit</button>' +
        '<button class="btn btn-sm ' + toggleClass + '" onclick="toggleJob(&apos;' + esc(j.id) + '&apos;, ' + !j.enabled + ', this)">' + toggleLabel + '</button>' +
        '<button class="btn btn-sm btn-danger" onclick="removeJob(&apos;' + esc(j.id) + '&apos;, this)">✕</button>' +
      '</div></td>' +
    '</tr>';
  }).join('');
  return '<table><thead><tr><th>Name</th><th>Conversation</th><th>Cadence</th><th>Since</th><th>Status</th><th>Last Run</th><th>Last Result</th><th>Actions</th></tr></thead><tbody>' + rows + '</tbody></table>';
}

let _editJobId = null;
function editJob(id) {
  const job = _loadedJobs.find(function(j) { return j.id === id; });
  if (!job) { alert('Job not found — refresh and try again.'); return; }
  openEditModal(job);
}

function openEditModal(job) {
  _editJobId = job.id;
  const cadence = job.cadencePreset || '';
  const since = job.sincePreset !== undefined ? job.sincePreset : cadence;
  const linked = cadence !== '' && (job.sincePreset === cadence || job.sincePreset === undefined);
  const cadenceOpts = CADENCE_PRESET_VALUES.map(function(p) {
    return '<option value="' + esc(p) + '"' + (p === cadence ? ' selected' : '') + '>' + esc(COMPACT_LABELS[p] || p) + '</option>';
  }).join('');
  const sinceOpts = ALL_SINCE_PRESET_VALUES.map(function(p) {
    return '<option value="' + esc(p) + '"' + (p === since ? ' selected' : '') + '>' + esc(COMPACT_LABELS[p] || p) + '</option>';
  }).join('');
  const existing = document.getElementById('edit-modal-overlay');
  if (existing) existing.remove();
  const overlay = document.createElement('div');
  overlay.id = 'edit-modal-overlay';
  overlay.className = 'modal-overlay';
  overlay.innerHTML =
    '<div class="modal-card edit-modal-card">' +
      '<h2>✏️ Edit Scheduled Job</h2>' +
      '<div class="field"><label>Job Name</label><input type="text" id="edit-name" value="' + esc(job.name) + '" placeholder="Job name"/></div>' +
      '<div class="field"><label>Conversation ID</label><input type="text" id="edit-channel" value="' + esc(job.channel) + '" placeholder="UUID or all"/></div>' +
      '<div class="edit-row">' +
        '<div class="edit-col"><label>Cadence</label><select id="edit-cadence" onchange="onEditCadenceChange()">' + cadenceOpts + '</select></div>' +
        '<div class="edit-link-col"><span class="link-label">Link</span><input type="checkbox" id="edit-link"' + (linked ? ' checked' : '') + ' onchange="onEditLinkChange()" title="When linked, Since matches Cadence"/></div>' +
        '<div class="edit-col"><label>Since</label><select id="edit-since"' + (linked ? ' disabled style="opacity:.55"' : '') + '>' + sinceOpts + '</select></div>' +
      '</div>' +
      '<div class="edit-enabled-row"><input type="checkbox" id="edit-enabled"' + (job.enabled ? ' checked' : '') + '/><label for="edit-enabled">Job is enabled</label></div>' +
      '<div class="edit-err" id="edit-err"></div>' +
      '<div class="edit-footer"><button class="btn btn-ghost" onclick="closeEditModal()">Cancel</button><button class="btn btn-primary" id="edit-save-btn" onclick="saveEditJob()">Save Changes</button></div>' +
    '</div>';
  overlay.addEventListener('click', function(e) { if (e.target === overlay) closeEditModal(); });
  document.body.appendChild(overlay);
}

function closeEditModal() { const o = document.getElementById('edit-modal-overlay'); if (o) o.remove(); _editJobId = null; }
function onEditCadenceChange() { if (!document.getElementById('edit-link').checked) return; document.getElementById('edit-since').value = document.getElementById('edit-cadence').value; }
function onEditLinkChange() {
  const linked = document.getElementById('edit-link').checked;
  const sinceEl = document.getElementById('edit-since');
  if (linked) { sinceEl.value = document.getElementById('edit-cadence').value; sinceEl.disabled = true; sinceEl.style.opacity = '.55'; }
  else { sinceEl.disabled = false; sinceEl.style.opacity = ''; }
}

async function saveEditJob() {
  if (!_editJobId) return;
  const name = document.getElementById('edit-name').value.trim();
  const channel = document.getElementById('edit-channel').value.trim();
  const cadence = document.getElementById('edit-cadence').value;
  const linked = document.getElementById('edit-link').checked;
  const since = linked ? cadence : document.getElementById('edit-since').value;
  const enabled = document.getElementById('edit-enabled').checked;
  const errEl = document.getElementById('edit-err');
  errEl.style.display = 'none';
  if (!channel) { errEl.textContent = 'Conversation ID is required.'; errEl.style.display = 'block'; return; }
  const saveBtn = document.getElementById('edit-save-btn');
  saveBtn.disabled = true;
  saveBtn.innerHTML = '<span class="spinner"></span> Saving\u2026';
  const body = { enabled };
  if (name) body.name = name;
  if (channel) body.channel = channel;
  if (cadence) body.cadencePreset = cadence;
  if (since) body.sincePreset = since;
  try {
    const res = await fetch(BASE + '/jobs/' + _editJobId, { method: 'PATCH', headers: getHeaders(), body: JSON.stringify(body) });
    const data = await res.json();
    if (res.ok && data.id) { closeEditModal(); loadJobsTable(); }
    else { errEl.textContent = data.error || 'Unknown error'; errEl.style.display = 'block'; saveBtn.disabled = false; saveBtn.textContent = 'Save Changes'; }
  } catch (err) { errEl.textContent = 'Network error: ' + err.message; errEl.style.display = 'block'; saveBtn.disabled = false; saveBtn.textContent = 'Save Changes'; }
}

async function triggerJobRun(id, btn) {
  const orig = btn.textContent; btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
  try {
    const res = await fetch(BASE + '/jobs/' + id + '/run', { method: 'POST', headers: getHeaders() });
    const data = await res.json();
    if (res.ok) { btn.textContent = '✓'; setTimeout(function() { btn.textContent = orig; btn.disabled = false; loadJobsTable(); loadRunsTable(); }, 1500); }
    else { alert('Error: ' + (data.error || 'Unknown')); btn.textContent = orig; btn.disabled = false; }
  } catch (err) { alert('Network error: ' + err.message); btn.textContent = orig; btn.disabled = false; }
}

async function triggerJobRunAll(id, btn) {
  if (!confirm('Run ALL history for this conversation? This may take a while.')) return;
  const orig = btn.textContent; btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
  try {
    const res = await fetch(BASE + '/jobs/' + id + '/run-all', { method: 'POST', headers: getHeaders() });
    const data = await res.json();
    if (res.ok) { btn.textContent = '✓'; setTimeout(function() { btn.textContent = orig; btn.disabled = false; loadJobsTable(); loadRunsTable(); }, 1500); }
    else { alert('Error: ' + (data.error || 'Unknown')); btn.textContent = orig; btn.disabled = false; }
  } catch (err) { alert('Network error: ' + err.message); btn.textContent = orig; btn.disabled = false; }
}

async function toggleJob(id, enable, btn) {
  btn.disabled = true;
  try {
    const res = await fetch(BASE + '/jobs/' + id, { method: 'PATCH', headers: getHeaders(), body: JSON.stringify({ enabled: enable }) });
    if (res.ok) loadJobsTable();
    else { const d = await res.json(); alert('Error: ' + (d.error || 'Unknown')); btn.disabled = false; }
  } catch (err) { alert('Network error: ' + err.message); btn.disabled = false; }
}

async function removeJob(id, btn) {
  if (!confirm('Delete this scheduled job?')) return;
  btn.disabled = true;
  try {
    const res = await fetch(BASE + '/jobs/' + id, { method: 'DELETE', headers: getHeaders() });
    if (res.ok) loadJobsTable();
    else { const d = await res.json(); alert('Error: ' + (d.error || 'Unknown')); btn.disabled = false; }
  } catch (err) { alert('Network error: ' + err.message); btn.disabled = false; }
}

async function loadRunsTable() {
  const el = document.getElementById('runs-container');
  try {
    const res = await fetch(BASE + '/runs?limit=50', { headers: getHeaders() });
    if (res.status === 401) { el.innerHTML = '<p style="color:#f87171;font-size:.85rem">Not authenticated.</p>'; return; }
    const runs = await res.json();
    el.innerHTML = renderRunsTable(runs);
  } catch (err) { el.innerHTML = '<p style="color:#f87171;font-size:.85rem">Error: ' + esc(err.message) + '</p>'; }
}

function renderRunsTable(runs) {
  if (!runs.length) return '<p style="color:#555;font-size:.85rem;padding:12px 0">No runs recorded yet.</p>';
  const rows = runs.map(function(r) {
    const statusPill = r.status === 'success' ? '<span class="status-pill pill-ok">success</span>'
      : r.status === 'error' ? '<span class="status-pill pill-err">error</span>'
      : r.status === 'queued' ? '<span class="status-pill pill-blue">queued</span>'
      : '<span class="status-pill pill-run">running</span>';
    const source = r.jobId ? '<span class="mono">scheduled</span>' : 'manual';
    const errCell = r.error ? '<span class="err-text" title="' + esc(r.error) + '">' + esc(r.error.slice(0,40)) + (r.error.length > 40 ? '…' : '') + '</span>' : '—';
    const dur = r.finishedAt ? Math.round((new Date(r.finishedAt) - new Date(r.startedAt)) / 1000) + 's' : '…';
    const sinceCell = r.params && r.params.sincePreset
      ? '<span class="status-pill pill-run">' + esc(r.params.sincePreset) + '</span>'
      : '—';
    const convCell = r.channelName
      ? '<div style="display:flex;flex-direction:column;line-height:1.2"><span>' + esc(r.channelName) + '</span><span class="mono" style="font-size:.72rem;color:#9ca3af">' + esc(r.channel.slice(0,8)) + '…</span></div>'
      : '<span class="mono">' + esc(r.channel) + '</span>';
    return '<tr>' +
      '<td title="' + esc(r.startedAt) + '">' + reltime(r.startedAt) + '</td>' +
      '<td>' + source + '</td>' +
      '<td>' + convCell + '</td>' +
      '<td>' + statusPill + '</td>' +
      '<td>' + sinceCell + '</td>' +
      '<td>' + r.fetchedCount + '</td>' +
      '<td>' + r.insertedCount + '</td>' +
      '<td>' + r.updatedCount + '</td>' +
      '<td>' + r.skippedCount + '</td>' +
      '<td>' + r.attachmentsSeen + '</td>' +
      '<td>' + dur + '</td>' +
      '<td>' + errCell + '</td>' +
      '</tr>';
  }).join('');
  return '<table><thead><tr><th>Started</th><th>Source</th><th>Conversation</th><th>Status</th><th>Since</th><th>Fetched</th><th>Inserted</th><th>Updated</th><th>Skipped</th><th>Attachments</th><th>Duration</th><th>Error</th></tr></thead><tbody>' + rows + '</tbody></table>';
}

async function loadQueueStatus() {
  const el = document.getElementById('queue-status-container');
  if (!el) return;
  try {
    const res = await fetch(BASE + '/scheduler/status', { headers: getHeaders() });
    if (res.status === 401) { el.innerHTML = '<span style="color:#f87171">Not authenticated.</span>'; return; }
    const d = await res.json();
    const runningList = d.runningIds && d.runningIds.length
      ? d.runningIds.map(function(id) { return '<span class="status-pill pill-run">' + esc(id) + '</span>'; }).join(' ')
      : '<span style="color:#555">none</span>';
    const queuedList = d.queuedIds && d.queuedIds.length
      ? d.queuedIds.map(function(id) { return '<span class="status-pill pill-blue">' + esc(id) + '</span>'; }).join(' ')
      : '<span style="color:#555">none</span>';
    el.innerHTML =
      '<div class="queue-row">' +
        '<div class="queue-stat"><div class="qs-value">' + esc(d.runningCount) + '</div><div class="qs-label">Running</div></div>' +
        '<div class="queue-stat"><div class="qs-value">' + esc(d.queuedCount) + '</div><div class="qs-label">Queued</div></div>' +
        '<div class="queue-stat"><div class="qs-value">' + esc(d.concurrency) + '</div><div class="qs-label">Concurrency</div></div>' +
        '<div class="queue-stat"><div class="qs-value">' + esc(d.spacingMs) + 'ms</div><div class="qs-label">Spacing</div></div>' +
      '</div>' +
      '<div class="queue-ids"><strong>Running:</strong> ' + runningList + '</div>' +
      (d.queuedCount > 0 ? '<div class="queue-ids"><strong>Waiting:</strong> ' + queuedList + '</div>' : '');
  } catch (err) { if (el) el.innerHTML = '<span style="color:#f87171">Error: ' + esc(err.message) + '</span>'; }
}

function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function reltime(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return Math.round(diff/1000) + 's ago';
  if (diff < 3600000) return Math.round(diff/60000) + 'm ago';
  if (diff < 86400000) return Math.round(diff/3600000) + 'h ago';
  return Math.round(diff/86400000) + 'd ago';
}

let _convsLoaded = false;
async function loadConversations() {
  if (_convsLoaded) return;
  const sel = document.getElementById('conv-select');
  if (!sel) return;
  const baseOpts = '<option value="">— Select a conversation —</option><option value="all">🔄 All Conversations</option>';
  try {
    const res = await fetch(BASE + '/conversations', { headers: getHeaders() });
    if (!res.ok) {
      let reason = 'Unknown error';
      try { const d = await res.json(); reason = d.error || reason; } catch {}
      if (res.status === 401) reason = 'Not authenticated — check login or UI_TOKEN.';
      sel.innerHTML = baseOpts + '<option disabled>⚠ ' + esc(reason) + '</option>';
      return;
    }
    const convs = await res.json();
    let html = baseOpts;
    for (const c of convs) {
      const title = (c.title || c.id).slice(0, 60);
      html += '<option value="' + esc(c.id) + '">' + esc(title) + '</option>';
    }
    sel.innerHTML = html;
    _convsLoaded = true;
  } catch (e) { sel.innerHTML = baseOpts + '<option disabled>⚠ Network error: ' + esc(e.message) + '</option>'; }
}

function onConvSelect() {
  const sel = document.getElementById('conv-select');
  const input = document.getElementById('channel');
  if (sel.value) input.value = sel.value;
  updateAutoNamePreview();
}

function loadAll() {
  loadLoginStatus();
  loadConversations();
  loadJobsTable();
  loadRunsTable();
  loadQueueStatus();
}

window.addEventListener('DOMContentLoaded', function() {
  updateAuthBar();
  const cadenceEl = document.getElementById('cadence');
  if (cadenceEl && !cadenceEl.value) cadenceEl.value = '1h';
  onCadenceChange();
  if (REQUIRES_AUTH && !getToken()) showModal();
  else loadAll();
  setInterval(function() {
    if (REQUIRES_AUTH && !getToken()) return;
    loadAll();
  }, 30000);
});
</script>
</body>
</html>`;
}

export default router;
