/**
 * backfill-router.ts — HTTP routes + SSE for ChatGPT attachment backfill.
 */

import { Router, type Request, type Response } from 'express';
import {
  backfillAttachments,
  type BackfillOptions,
  type BackfillProgress,
} from './backfill-attachments.js';
import {
  createBackfillRun,
  updateBackfillRun,
  getBackfillRun,
  getRecentBackfillRuns,
  getActiveBackfillRun,
} from './backfill-store.js';

const router = Router();

// Active runs: runId → latest progress
const activeRuns = new Map<string, BackfillProgress>();

// SSE clients: runId → set of Response objects
const sseClients = new Map<string, Set<Response>>();

// ── GET /backfill — HTML UI ────────────────────────────────────────────────────

router.get('/backfill', (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildBackfillUI());
});

// ── POST /api/backfill/start ───────────────────────────────────────────────────

router.post('/api/backfill/start', async (req: Request, res: Response) => {
  const {
    batchSize = 3,
    limit,
    dryRun = false,
    resumeFrom = 1,
    mode = 'missing',
  } = req.body as {
    batchSize?: number;
    limit?: number;
    dryRun?: boolean;
    resumeFrom?: number;
    mode?: 'missing' | 'force';
  };

  const existingActive = await getActiveBackfillRun();
  if (existingActive) {
    res.status(409).json({
      error: 'A backfill is already running.',
      runId: existingActive.runId,
    });
    return;
  }

  const options: BackfillOptions = {
    batchSize: Math.max(1, batchSize),
    limit,
    dryRun,
    resumeFrom: Math.max(1, resumeFrom),
    mode: mode === 'force' ? 'force' : 'missing',
  };

  try {
    const run = await createBackfillRun(
      { batchSize: options.batchSize, limit: options.limit, dryRun: options.dryRun, resumeFrom: options.resumeFrom },
      options.mode
    );

    const initialProgress: BackfillProgress = {
      runId: run.runId,
      page: options.resumeFrom,
      totalPages: 0,
      messagesProcessed: 0,
      downloadedCount: 0,
      ingestedCount: 0,
      skippedCount: 0,
      errorCount: 0,
      startTime: new Date(),
      currentTime: new Date(),
    };

    activeRuns.set(run.runId, initialProgress);
    sseClients.set(run.runId, new Set());

    res.json({
      runId: run.runId,
      status: 'running',
      startedAt: run.startedAt,
      progress: initialProgress,
    });

    // Run backfill in background
    backfillAttachments(options, (progress) => {
      activeRuns.set(run.runId, progress);

      const clients = sseClients.get(run.runId);
      if (clients) {
        const msg = 'data: ' + JSON.stringify(progress) + '\n\n';
        for (const client of clients) client.write(msg);
      }
    })
      .then(async (stats) => {
        await updateBackfillRun(run.runId, {
          status: 'complete',
          completedAt: new Date().toISOString(),
          stats: {
            totalMessages: stats.messagesProcessed,
            messagesWithAttachments: stats.messagesWithAttachments,
            downloadedAttachments: stats.attachmentsDownloaded,
            ingestedAttachments: stats.attachmentsIngested,
            skipped: stats.attachmentsSkipped,
            errors: stats.errors.length,
          },
          totalPages: activeRuns.get(run.runId)?.totalPages ?? 0,
        });

        const clients = sseClients.get(run.runId);
        if (clients) {
          const msg =
            'event: complete\ndata: ' +
            JSON.stringify({ runId: run.runId, status: 'complete', stats }) +
            '\n\n';
          for (const client of clients) {
            client.write(msg);
            client.end();
          }
          sseClients.delete(run.runId);
        }
        activeRuns.delete(run.runId);
      })
      .catch(async (err: Error) => {
        console.error(`[backfill-router] Error in run ${run.runId}:`, err);

        await updateBackfillRun(run.runId, {
          status: 'error',
          completedAt: new Date().toISOString(),
          error: err.message || String(err),
        });

        const clients = sseClients.get(run.runId);
        if (clients) {
          const msg =
            'event: error\ndata: ' +
            JSON.stringify({ runId: run.runId, status: 'error', message: err.message }) +
            '\n\n';
          for (const client of clients) {
            client.write(msg);
            client.end();
          }
          sseClients.delete(run.runId);
        }
        activeRuns.delete(run.runId);
      });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ── GET /api/backfill/status/:runId ───────────────────────────────────────────

router.get('/api/backfill/status/:runId', async (req: Request, res: Response) => {
  const runId = req.params['runId'] as string;
  const run = await getBackfillRun(runId as string);
  if (!run) {
    res.status(404).json({ error: 'Run not found' });
    return;
  }
  const progress = activeRuns.get(runId as string);
  res.json({ run, progress: progress ?? null });
});

// ── GET /api/backfill/runs ─────────────────────────────────────────────────────

router.get('/api/backfill/runs', async (_req: Request, res: Response) => {
  const runs = await getRecentBackfillRuns(50);
  res.json(runs);
});

// ── GET /api/backfill/progress/:runId — SSE ───────────────────────────────────

router.get('/api/backfill/progress/:runId', (req: Request, res: Response) => {
  const runId = req.params['runId'] as string;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send current progress immediately if available
  const current = activeRuns.get(runId);
  if (current) {
    res.write('data: ' + JSON.stringify(current) + '\n\n');
  }

  // Add to SSE clients
  let clients = sseClients.get(runId);
  if (!clients) {
    clients = new Set();
    sseClients.set(runId, clients);
  }
  clients.add(res);

  // Heartbeat every 15s
  const heartbeat = setInterval(() => {
    res.write(': ping\n\n');
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    const cls = sseClients.get(runId);
    if (cls) cls.delete(res);
  });
});

// ── HTML UI ───────────────────────────────────────────────────────────────────

function buildBackfillUI(): string {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>ChatGPT Attachment Backfill — OpenClaw</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#1a1a1a;color:#e0e0e0;font-family:system-ui,sans-serif;padding:24px;max-width:900px;margin:0 auto}
  h1{font-size:1.5rem;font-weight:700;margin-bottom:4px;color:#fff}
  .subtitle{color:#888;font-size:.9rem;margin-bottom:24px}
  .card{background:#242424;border:1px solid #333;border-radius:10px;padding:20px;margin-bottom:20px}
  .card h2{font-size:1rem;font-weight:600;margin-bottom:14px;color:#ccc}
  label{display:flex;flex-direction:column;gap:4px;font-size:.85rem;color:#aaa;margin-bottom:12px}
  label span{color:#ccc;font-weight:500}
  input[type=number],select{background:#1e1e1e;border:1px solid #444;color:#e0e0e0;border-radius:6px;padding:8px 10px;font-size:.85rem;width:100%;max-width:220px}
  input[type=number]:focus,select:focus{outline:none;border-color:#10a37f}
  .checkbox-row{display:flex;align-items:center;gap:8px;font-size:.85rem;color:#ccc;margin-bottom:12px}
  input[type=checkbox]{accent-color:#10a37f;width:16px;height:16px}
  .mode-selector{display:flex;gap:8px;margin-bottom:12px}
  .mode-btn{flex:1;padding:10px;background:#1e1e1e;border:2px solid #444;color:#aaa;border-radius:8px;cursor:pointer;font-size:.85rem;text-align:center;transition:all .15s}
  .mode-btn:hover{border-color:#10a37f;color:#ccc}
  .mode-btn.active{border-color:#10a37f;background:#10a37f22;color:#10a37f}
  button.primary{background:#10a37f;color:#fff;border:none;border-radius:6px;padding:10px 24px;cursor:pointer;font-size:.9rem;font-weight:600;transition:background .15s}
  button.primary:hover{background:#0d8f6e}
  button.primary:disabled{background:#374151;cursor:not-allowed;color:#6b7280}
  .stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px;margin-bottom:16px}
  .stat-box{background:#1a1a1a;border:1px solid #333;border-radius:8px;padding:12px;text-align:center}
  .stat-val{font-size:1.6rem;font-weight:700;color:#10a37f}
  .stat-lbl{font-size:.75rem;color:#888;margin-top:2px}
  .progress-bar-wrap{background:#1a1a1a;border-radius:4px;height:8px;margin-bottom:12px;overflow:hidden}
  .progress-bar{background:#10a37f;height:100%;border-radius:4px;transition:width .3s ease}
  .status-line{font-size:.85rem;color:#888;margin-bottom:12px}
  .recent-list{list-style:none;font-size:.8rem;max-height:180px;overflow-y:auto}
  .recent-list li{padding:4px 8px;border-radius:4px;margin-bottom:3px;display:flex;align-items:center;gap:8px}
  .recent-list li.ok{background:#0a1f16;color:#4ade80}
  .recent-list li.err{background:#1f0a0a;color:#f87171}
  .recent-list li.skip{background:#1a1a1a;color:#888}
  .dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
  .dot.ok{background:#4ade80}
  .dot.err{background:#f87171}
  .dot.skip{background:#555}
  table{width:100%;border-collapse:collapse;font-size:.8rem}
  th{text-align:left;padding:6px 8px;color:#888;border-bottom:1px solid #333;font-weight:500}
  td{padding:6px 8px;color:#ccc;border-bottom:1px solid #2a2a2a}
  .badge{padding:2px 8px;border-radius:10px;font-size:.75rem;font-weight:500}
  .badge.complete{background:#0a2a1a;color:#4ade80}
  .badge.error{background:#2a0a0a;color:#f87171}
  .badge.running{background:#0a1a2a;color:#60a5fa}
  .nav-links{display:flex;gap:16px;margin-bottom:20px;font-size:.85rem}
  .nav-links a{color:#10a37f;text-decoration:none}
  .nav-links a:hover{text-decoration:underline}
  #start-section{display:block}
  #progress-section{display:none}
</style>
</head>
<body>
<h1>📎 ChatGPT Attachment Backfill</h1>
<p class="subtitle">Download and ingest file attachments from previously synced ChatGPT messages.</p>

<div class="nav-links">
  <a href="/sync">← Sync UI</a>
  <a href="/login">Login</a>
  <a href="/api/health">Health</a>
</div>

<div id="start-section">
  <div class="card">
    <h2>Backfill Options</h2>

    <div style="margin-bottom:14px">
      <span style="font-size:.85rem;color:#888;display:block;margin-bottom:8px">Mode</span>
      <div class="mode-selector">
        <div class="mode-btn active" id="mode-missing" onclick="setMode('missing')">
          <strong>Missing only</strong><br>
          <span style="font-size:.75rem;opacity:.7">Skip messages that already have attachments (safe)</span>
        </div>
        <div class="mode-btn" id="mode-force" onclick="setMode('force')">
          <strong>Force re-download</strong><br>
          <span style="font-size:.75rem;opacity:.7">Re-download all attachments regardless</span>
        </div>
      </div>
    </div>

    <label>
      <span>Batch size</span>
      <input type="number" id="batch-size" value="3" min="1" max="20"/>
    </label>

    <label>
      <span>Message limit (optional)</span>
      <input type="number" id="msg-limit" placeholder="No limit" min="1"/>
    </label>

    <label>
      <span>Resume from page</span>
      <input type="number" id="resume-from" value="1" min="1"/>
    </label>

    <div class="checkbox-row">
      <input type="checkbox" id="dry-run"/>
      <label for="dry-run" style="margin:0;flex-direction:row;align-items:center;font-size:.85rem;color:#ccc">Dry run (no downloads or writes)</label>
    </div>

    <button class="primary" id="start-btn" onclick="startBackfill()">▶ Start Backfill</button>
  </div>
</div>

<div id="progress-section">
  <div class="card">
    <h2 id="progress-title">Backfill Running…</h2>
    <div class="progress-bar-wrap">
      <div class="progress-bar" id="progress-bar" style="width:0%"></div>
    </div>
    <div class="status-line" id="status-line">Starting…</div>

    <div class="stats-grid">
      <div class="stat-box"><div class="stat-val" id="s-msgs">0</div><div class="stat-lbl">Messages</div></div>
      <div class="stat-box"><div class="stat-val" id="s-dl">0</div><div class="stat-lbl">Downloaded</div></div>
      <div class="stat-box"><div class="stat-val" id="s-ing">0</div><div class="stat-lbl">Ingested</div></div>
      <div class="stat-box"><div class="stat-val" id="s-skip">0</div><div class="stat-lbl">Skipped</div></div>
      <div class="stat-box"><div class="stat-val" id="s-err" style="color:#f87171">0</div><div class="stat-lbl">Errors</div></div>
    </div>

    <h2 style="margin-bottom:8px">Recent Files</h2>
    <ul class="recent-list" id="recent-list"></ul>
  </div>
</div>

<div class="card">
  <h2>Recent Runs</h2>
  <table>
    <thead><tr><th>Started</th><th>Mode</th><th>Status</th><th>Messages</th><th>Downloaded</th><th>Ingested</th><th>Errors</th></tr></thead>
    <tbody id="runs-table"></tbody>
  </table>
</div>

<script>
let selectedMode = 'missing';
let currentRunId = null;
let eventSource = null;

function setMode(mode) {
  selectedMode = mode;
  document.getElementById('mode-missing').classList.toggle('active', mode === 'missing');
  document.getElementById('mode-force').classList.toggle('active', mode === 'force');
}

async function startBackfill() {
  const batchSize = parseInt(document.getElementById('batch-size').value) || 3;
  const limitVal = document.getElementById('msg-limit').value;
  const limit = limitVal ? parseInt(limitVal) : undefined;
  const resumeFrom = parseInt(document.getElementById('resume-from').value) || 1;
  const dryRun = document.getElementById('dry-run').checked;

  document.getElementById('start-btn').disabled = true;

  try {
    const res = await fetch('/api/backfill/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ batchSize, limit, dryRun, resumeFrom, mode: selectedMode }),
    });

    const data = await res.json();
    if (!res.ok) {
      alert('Error: ' + (data.error || 'Unknown error'));
      document.getElementById('start-btn').disabled = false;
      return;
    }

    currentRunId = data.runId;
    document.getElementById('start-section').style.display = 'none';
    document.getElementById('progress-section').style.display = 'block';
    document.getElementById('progress-title').textContent = dryRun ? 'Dry Run in Progress…' : 'Backfill Running…';

    subscribeToProgress(currentRunId);
  } catch (e) {
    alert('Failed to start: ' + e.message);
    document.getElementById('start-btn').disabled = false;
  }
}

function subscribeToProgress(runId) {
  if (eventSource) { eventSource.close(); eventSource = null; }

  eventSource = new EventSource('/api/backfill/progress/' + runId);

  eventSource.onmessage = (e) => {
    const progress = JSON.parse(e.data);
    updateProgress(progress);
  };

  eventSource.addEventListener('complete', (e) => {
    const data = JSON.parse(e.data);
    document.getElementById('progress-title').textContent = '✅ Backfill Complete';
    document.getElementById('status-line').textContent = 'Completed successfully.';
    document.getElementById('progress-bar').style.width = '100%';
    document.getElementById('start-btn').disabled = false;
    eventSource.close();
    loadRuns();
  });

  eventSource.addEventListener('error', (e) => {
    let msg = 'Unknown error';
    try { msg = JSON.parse(e.data).message; } catch {}
    document.getElementById('progress-title').textContent = '❌ Backfill Error';
    document.getElementById('status-line').textContent = 'Error: ' + msg;
    document.getElementById('start-btn').disabled = false;
    eventSource.close();
    loadRuns();
  });

  eventSource.onerror = () => {
    document.getElementById('status-line').textContent = 'Connection lost.';
  };
}

function updateProgress(p) {
  const pct = p.totalPages > 0 ? Math.round((p.page / p.totalPages) * 100) : 0;
  document.getElementById('progress-bar').style.width = pct + '%';

  let statusText = 'Page ' + p.page + ' / ' + (p.totalPages || '?');
  if (p.estimatedRemaining) {
    const mins = Math.floor(p.estimatedRemaining / 60000);
    const secs = Math.floor((p.estimatedRemaining % 60000) / 1000);
    statusText += ' — ~' + (mins > 0 ? mins + 'm ' : '') + secs + 's remaining';
  }
  if (p.lastEvent) statusText += ' — ' + p.lastEvent;
  document.getElementById('status-line').textContent = statusText;

  document.getElementById('s-msgs').textContent = p.messagesProcessed;
  document.getElementById('s-dl').textContent = p.downloadedCount;
  document.getElementById('s-ing').textContent = p.ingestedCount;
  document.getElementById('s-skip').textContent = p.skippedCount;
  document.getElementById('s-err').textContent = p.errorCount;

  if (p.recentItems && p.recentItems.length > 0) {
    const list = document.getElementById('recent-list');
    list.innerHTML = '';
    for (const item of p.recentItems) {
      const cls = item.status === 'downloaded' ? 'ok' : item.status === 'error' ? 'err' : 'skip';
      const li = document.createElement('li');
      li.className = cls;
      li.innerHTML = '<span class="dot ' + cls + '"></span>' + escHtml(item.filename);
      list.appendChild(li);
    }
  }
}

function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

async function loadRuns() {
  try {
    const res = await fetch('/api/backfill/runs');
    const runs = await res.json();
    const tbody = document.getElementById('runs-table');
    if (!runs.length) { tbody.innerHTML = '<tr><td colspan="7" style="color:#666;text-align:center;padding:16px">No runs yet</td></tr>'; return; }
    tbody.innerHTML = runs.map(r => {
      const badge = '<span class="badge ' + r.status + '">' + r.status + '</span>';
      const started = new Date(r.startedAt).toLocaleString();
      const s = r.stats || {};
      return '<tr>' +
        '<td>' + escHtml(started) + '</td>' +
        '<td>' + escHtml(r.mode || 'missing') + '</td>' +
        '<td>' + badge + '</td>' +
        '<td>' + (s.totalMessages || 0) + '</td>' +
        '<td>' + (s.downloadedAttachments || 0) + '</td>' +
        '<td>' + (s.ingestedAttachments || 0) + '</td>' +
        '<td>' + (s.errors || 0) + '</td>' +
        '</tr>';
    }).join('');
  } catch {}
}

loadRuns();
</script>
</body>
</html>`;
}

export default router;
