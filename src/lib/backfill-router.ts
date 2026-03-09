import { Router, type Request, type Response, type NextFunction } from 'express';
import {
  backfillAttachments,
  type BackfillOptions,
  type BackfillProgress,
} from '../commands/backfill-attachments.js';
import {
  createBackfillRun,
  updateBackfillRun,
  getBackfillRun,
  getRecentBackfillRuns,
  getActiveBackfillRun,
} from './backfill-store.js';

const router = Router();

// Track active runs and their latest progress
const activeRuns = new Map<string, BackfillProgress>();

// Track SSE clients per run
const sseClients = new Map<string, Set<Response>>();

// ── Auth middleware ────────────────────────────────────────────────────────────

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const uiToken = process.env.UI_TOKEN;
  if (!uiToken) { next(); return; }

  const authHeader = req.headers['authorization'];
  const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
  const queryToken = typeof req.query.token === 'string' ? req.query.token : undefined;
  const provided = bearer ?? queryToken;

  if (!provided || provided !== uiToken) {
    res.status(401).json({ error: 'Unauthorized: invalid or missing UI_TOKEN.' });
    return;
  }
  next();
}

// ── GET /backfill — serve HTML UI ─────────────────────────────────────────────

router.get('/backfill', (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildBackfillUI(Boolean(process.env.UI_TOKEN)));
});

// ── POST /api/backfill/start ──────────────────────────────────────────────────

router.post('/api/backfill/start', requireAuth, async (req: Request, res: Response) => {
  const {
    batchSize = 5,
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

  const existing = await getActiveBackfillRun();
  if (existing) {
    res.status(409).json({ error: 'A backfill is already running.', runId: existing.runId });
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
    const run = await createBackfillRun(options, options.mode);

    const initialProgress: BackfillProgress = {
      runId: run.runId,
      page: resumeFrom,
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

    res.json({ runId: run.runId, status: 'running', startedAt: run.startedAt, progress: initialProgress });

    // Run in background
    backfillAttachments(options, (progress) => {
      activeRuns.set(run.runId, progress);
      broadcast(run.runId, 'data', progress);
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
        });
        broadcastEnd(run.runId, 'complete', { runId: run.runId, status: 'complete' });
        activeRuns.delete(run.runId);
      })
      .catch(async (err) => {
        console.error(`[backfill-router] Run ${run.runId} error:`, err);
        await updateBackfillRun(run.runId, {
          status: 'error',
          completedAt: new Date().toISOString(),
          error: err.message || String(err),
        });
        broadcastEnd(run.runId, 'error', { runId: run.runId, status: 'error', message: err.message || String(err) });
        activeRuns.delete(run.runId);
      });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/backfill/status/:runId ──────────────────────────────────────────

router.get('/api/backfill/status/:runId', requireAuth, async (req: Request, res: Response) => {
  const runId = String(req.params.runId);
  const run = await getBackfillRun(runId);
  if (!run) { res.status(404).json({ error: 'Run not found.' }); return; }

  const progress = activeRuns.get(runId);
  res.json({
    runId,
    status: run.status,
    mode: run.mode,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    progress: progress ?? {
      page: run.lastPage,
      totalPages: run.totalPages,
      messagesProcessed: run.stats.totalMessages,
      downloadedCount: run.stats.downloadedAttachments,
      ingestedCount: run.stats.ingestedAttachments,
      skippedCount: run.stats.skipped,
      errorCount: run.stats.errors,
    },
    stats: run.stats,
    error: run.error,
  });
});

// ── GET /api/backfill/runs ────────────────────────────────────────────────────

router.get('/api/backfill/runs', requireAuth, async (_req: Request, res: Response) => {
  const runs = await getRecentBackfillRuns(50);
  res.json({
    runs: runs.map(r => ({
      runId: r.runId,
      startedAt: r.startedAt,
      completedAt: r.completedAt,
      status: r.status,
      mode: r.mode,
      stats: r.stats,
      error: r.error,
    })),
  });
});

// ── GET /api/backfill/progress/:runId — SSE ───────────────────────────────────

router.get('/api/backfill/progress/:runId', requireAuth, (req: Request, res: Response) => {
  const runId = String(req.params.runId);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  if (!sseClients.has(runId)) sseClients.set(runId, new Set());
  const clients = sseClients.get(runId)!;
  clients.add(res);

  // Send current progress immediately if available
  const current = activeRuns.get(runId);
  if (current) res.write('data: ' + JSON.stringify(current) + '\n\n');

  req.on('close', () => {
    clients.delete(res);
    if (clients.size === 0) sseClients.delete(runId);
  });
});

// ── SSE helpers ───────────────────────────────────────────────────────────────

function broadcast(runId: string, event: string, data: unknown): void {
  const clients = sseClients.get(runId);
  if (!clients) return;
  const line = event === 'data'
    ? 'data: ' + JSON.stringify(data) + '\n\n'
    : `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  clients.forEach(c => c.write(line));
}

function broadcastEnd(runId: string, event: string, data: unknown): void {
  const clients = sseClients.get(runId);
  if (!clients) return;
  const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  clients.forEach(c => { c.write(line); c.end(); });
  sseClients.delete(runId);
}

// ── HTML UI ───────────────────────────────────────────────────────────────────

function buildBackfillUI(requiresAuth: boolean): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>ChatGPT Ingestor — Attachment Backfill</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#0f0f0f;color:#e0e0e0;font-family:system-ui,sans-serif;min-height:100vh;padding:24px 16px;line-height:1.6}
    h1{font-size:1.5rem;font-weight:700;color:#fff;margin-bottom:20px}
    a{color:#10a37f;text-decoration:none}
    a:hover{text-decoration:underline}
    .card{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:10px;padding:20px;margin-bottom:20px}
    .card h2{font-size:1rem;font-weight:600;color:#ccc;margin-bottom:14px}
    label{font-size:.85rem;color:#aaa;display:block;margin-bottom:4px}
    input[type=number],input[type=text]{background:#111;border:1px solid #333;color:#e0e0e0;border-radius:6px;padding:8px 12px;font-size:.9rem;width:100%}
    input:focus{outline:none;border-color:#10a37f}
    .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:14px;margin-bottom:14px}
    .form-group{display:flex;flex-direction:column}
    .checkbox-row{display:flex;align-items:center;gap:8px;margin-top:4px}
    .checkbox-row input[type=checkbox]{width:16px;height:16px;accent-color:#10a37f}
    .mode-row{display:flex;gap:16px;margin-bottom:14px;align-items:center}
    .mode-row label{display:flex;align-items:center;gap:6px;color:#ccc;font-size:.9rem;cursor:pointer;margin:0}
    .mode-row input[type=radio]{accent-color:#10a37f;width:15px;height:15px}
    button{background:#10a37f;color:#fff;border:none;border-radius:6px;padding:9px 18px;font-size:.9rem;font-weight:600;cursor:pointer;transition:background .15s}
    button:hover{background:#0d8f6e}
    button:disabled{background:#2a2a2a;color:#555;cursor:not-allowed}
    .btn-secondary{background:#2a2a2a;color:#aaa}
    .btn-secondary:hover{background:#333;color:#ccc}
    .progress-bar{width:100%;height:18px;background:#222;border-radius:4px;overflow:hidden;margin-bottom:14px}
    .progress-fill{height:100%;background:linear-gradient(90deg,#10a37f,#0d8f6e);transition:width .3s ease;display:flex;align-items:center;justify-content:center;color:#fff;font-size:.75rem;font-weight:700}
    .stats-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px;margin-bottom:14px}
    .stat-box{background:#111;border:1px solid #2a2a2a;border-radius:6px;padding:10px;text-align:center}
    .stat-label{font-size:.7rem;color:#666;text-transform:uppercase;letter-spacing:.05em;margin-bottom:2px}
    .stat-value{font-size:1.4rem;font-weight:700;color:#e0e0e0}
    .eta{background:#0a1a14;border-left:3px solid #10a37f;padding:8px 12px;border-radius:4px;font-size:.85rem;color:#aaa;margin-bottom:14px}
    .status-badge{display:inline-block;padding:3px 8px;border-radius:4px;font-size:.75rem;font-weight:700}
    .status-badge.running{background:#1a2f3a;color:#10a37f}
    .status-badge.complete{background:#1a2a1e;color:#22c55e}
    .status-badge.error{background:#2a1a1a;color:#ef4444}
    table{width:100%;border-collapse:collapse;font-size:.85rem}
    thead tr{border-bottom:1px solid #2a2a2a}
    th{color:#666;font-weight:600;padding:8px 10px;text-align:left}
    td{padding:8px 10px;border-bottom:1px solid #1e1e1e;color:#ccc}
    tbody tr:hover td{background:#1e1e1e}
    .event-log{background:#111;border:1px solid #2a2a2a;border-radius:6px;max-height:200px;overflow-y:auto;font-family:monospace;font-size:.78rem;padding:0}
    .event-item{padding:6px 10px;border-bottom:1px solid #1a1a1a;color:#888;display:flex;gap:10px}
    .event-item:last-child{border-bottom:none}
    .event-time{color:#555;white-space:nowrap}
    .event-text{word-break:break-all;color:#aaa}
    .alert{background:#1a2a1e;border:1px solid #2a4a2e;border-radius:6px;padding:10px 14px;font-size:.85rem;color:#86efac;margin-bottom:16px}
    .alert.error{background:#2a1a1a;border-color:#4a2a2a;color:#fca5a5}
    #authModal{position:fixed;inset:0;background:rgba(0,0,0,.7);display:none;align-items:center;justify-content:center;z-index:100}
    #authModal.active{display:flex}
    .modal-box{background:#1a1a1a;border:1px solid #333;border-radius:10px;padding:24px;min-width:300px;text-align:center}
    .modal-box h2{color:#fff;margin-bottom:12px}
    .modal-box input{margin:8px 0;padding:8px 12px;background:#111;border:1px solid #333;color:#e0e0e0;border-radius:6px;font-size:.9rem;width:100%}
    .recent-item-status{padding:2px 6px;border-radius:3px;font-size:.72rem;font-weight:700}
    .s-ingested{background:#1a2a1e;color:#22c55e}
    .s-downloaded{background:#1a2a3a;color:#60a5fa}
    .s-skipped{background:#2a2a1a;color:#f59e0b}
    .s-error{background:#2a1a1a;color:#ef4444}
  </style>
</head>
<body>
<div id="authModal">
  <div class="modal-box">
    <h2>Authentication Required</h2>
    <input type="password" id="tokenInput" placeholder="Enter UI_TOKEN">
    <button onclick="submitToken()" style="margin-top:8px;width:100%">Submit</button>
  </div>
</div>

<div style="max-width:1000px;margin:0 auto">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">
    <h1>📥 Attachment Backfill</h1>
    <a href="/sync" style="font-size:.85rem;padding:6px 12px;border:1px solid #10a37f;border-radius:6px">← Back to Sync</a>
  </div>

  <div id="statusAlert" class="alert" style="display:none"></div>

  <!-- Config card -->
  <div class="card">
    <h2>Configuration</h2>
    <div style="margin-bottom:14px">
      <div style="font-size:.85rem;color:#aaa;margin-bottom:8px">Mode</div>
      <div class="mode-row">
        <label><input type="radio" name="mode" value="missing" checked> Missing only</label>
        <label><input type="radio" name="mode" value="force"> Force re-download all</label>
      </div>
    </div>
    <div class="grid">
      <div class="form-group">
        <label for="batchSize">Batch Size</label>
        <input type="number" id="batchSize" value="5" min="1" max="20">
      </div>
      <div class="form-group">
        <label for="limit">Limit (blank = all)</label>
        <input type="number" id="limit" placeholder="unlimited">
      </div>
      <div class="form-group">
        <label for="resumeFrom">Resume From Page</label>
        <input type="number" id="resumeFrom" value="1" min="1">
      </div>
    </div>
    <div class="checkbox-row" style="margin-bottom:16px">
      <input type="checkbox" id="dryRun">
      <label for="dryRun" style="color:#ccc;cursor:pointer">Dry Run (download only, don't ingest)</label>
    </div>
    <button id="startBtn" onclick="startBackfill()">▶ Start Backfill</button>
  </div>

  <!-- Progress card -->
  <div class="card" id="progressCard" style="display:none">
    <h2>Progress</h2>
    <div class="progress-bar"><div class="progress-fill" id="progressFill" style="width:0%">0%</div></div>
    <div class="stats-grid">
      <div class="stat-box"><div class="stat-label">Pages</div><div class="stat-value"><span id="statPage">0</span>/<span id="statTotalPages">?</span></div></div>
      <div class="stat-box"><div class="stat-label">Messages</div><div class="stat-value" id="statMessages">0</div></div>
      <div class="stat-box"><div class="stat-label">Downloaded</div><div class="stat-value" id="statDownloaded">0</div></div>
      <div class="stat-box"><div class="stat-label">Ingested</div><div class="stat-value" id="statIngested">0</div></div>
      <div class="stat-box"><div class="stat-label">Skipped</div><div class="stat-value" id="statSkipped">0</div></div>
      <div class="stat-box"><div class="stat-label">Errors</div><div class="stat-value" id="statErrors">0</div></div>
    </div>
    <div class="eta" id="etaBox">Estimating…</div>
    <div style="font-size:.85rem;color:#666;margin-bottom:8px">Events</div>
    <div class="event-log" id="eventLog"><div style="padding:10px;color:#555;text-align:center">No events yet</div></div>
  </div>

  <!-- Recent items card -->
  <div class="card" id="recentItemsCard" style="display:none">
    <h2>Recent Items</h2>
    <table>
      <thead><tr><th>Filename</th><th>Message ID</th><th>Status</th></tr></thead>
      <tbody id="recentItemsBody"></tbody>
    </table>
  </div>

  <!-- Recent runs card -->
  <div class="card">
    <h2>Recent Runs</h2>
    <table>
      <thead><tr><th>Started</th><th>Mode</th><th>Status</th><th>Downloaded</th><th>Ingested</th><th>Skipped</th><th>Errors</th><th>Duration</th></tr></thead>
      <tbody id="runsBody"><tr><td colspan="8" style="text-align:center;color:#555">Loading…</td></tr></tbody>
    </table>
  </div>
</div>

<script>
const REQUIRES_AUTH = ${requiresAuth};
let currentRunId = null;
let eventSource = null;
const events = [];

function getToken() { return localStorage.getItem('backfill-token'); }
function setToken(t) { localStorage.setItem('backfill-token', t); }
function getHeaders(json) {
  const h = {};
  const t = getToken();
  if (t) h['Authorization'] = 'Bearer ' + t;
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

function submitToken() {
  const v = document.getElementById('tokenInput').value;
  if (!v) return;
  setToken(v);
  document.getElementById('authModal').classList.remove('active');
  location.reload();
}

function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function showAlert(msg, type='') {
  const el = document.getElementById('statusAlert');
  el.textContent = msg;
  el.className = 'alert' + (type ? ' ' + type : '');
  el.style.display = 'block';
}

async function startBackfill() {
  const batchSize = parseInt(document.getElementById('batchSize').value) || 5;
  const limitVal = document.getElementById('limit').value;
  const limit = limitVal ? parseInt(limitVal) : null;
  const resumeFrom = parseInt(document.getElementById('resumeFrom').value) || 1;
  const dryRun = document.getElementById('dryRun').checked;
  const mode = document.querySelector('input[name=mode]:checked').value;

  document.getElementById('startBtn').disabled = true;

  try {
    const res = await fetch('/api/backfill/start', {
      method: 'POST',
      headers: getHeaders(true),
      body: JSON.stringify({ batchSize, limit, dryRun, resumeFrom, mode }),
    });

    if (res.status === 401) {
      if (REQUIRES_AUTH) { document.getElementById('authModal').classList.add('active'); }
      else { showAlert('Unauthorized', 'error'); }
      document.getElementById('startBtn').disabled = false;
      return;
    }

    if (!res.ok) {
      const d = await res.json();
      showAlert('Error: ' + (d.error || res.statusText), 'error');
      document.getElementById('startBtn').disabled = false;
      return;
    }

    const data = await res.json();
    currentRunId = data.runId;
    showAlert('Backfill started (run ' + currentRunId.slice(0,8) + '…)');
    document.getElementById('progressCard').style.display = 'block';
    events.length = 0;
    updateEventLog();
    listenSSE(currentRunId);
    loadRuns();
  } catch (err) {
    showAlert('Error: ' + err.message, 'error');
    document.getElementById('startBtn').disabled = false;
  }
}

function listenSSE(runId) {
  if (eventSource) eventSource.close();
  const t = getToken();
  const q = t ? '?token=' + encodeURIComponent(t) : '';
  eventSource = new EventSource('/api/backfill/progress/' + runId + q);

  eventSource.onmessage = (e) => {
    const p = JSON.parse(e.data);
    updateProgress(p);
  };

  eventSource.addEventListener('complete', () => {
    showAlert('✅ Backfill complete!');
    document.getElementById('startBtn').disabled = false;
    eventSource.close();
    loadRuns();
  });

  eventSource.addEventListener('error', (e) => {
    try {
      const d = JSON.parse(e.data);
      showAlert('Error: ' + (d.message || 'Unknown error'), 'error');
    } catch { showAlert('Backfill encountered an error.', 'error'); }
    document.getElementById('startBtn').disabled = false;
    eventSource.close();
    loadRuns();
  });

  eventSource.onerror = () => eventSource.close();
}

function updateProgress(p) {
  const pct = p.totalPages > 0 ? Math.min(100, Math.round(p.page / p.totalPages * 100)) : 0;
  document.getElementById('progressFill').style.width = pct + '%';
  document.getElementById('progressFill').textContent = pct + '%';
  document.getElementById('statPage').textContent = p.page;
  document.getElementById('statTotalPages').textContent = p.totalPages || '?';
  document.getElementById('statMessages').textContent = p.messagesProcessed;
  document.getElementById('statDownloaded').textContent = p.downloadedCount;
  document.getElementById('statIngested').textContent = p.ingestedCount;
  document.getElementById('statSkipped').textContent = p.skippedCount;
  document.getElementById('statErrors').textContent = p.errorCount;

  if (p.estimatedRemaining > 0) {
    const mins = Math.round(p.estimatedRemaining / 1000 / 60);
    document.getElementById('etaBox').textContent = mins < 60
      ? '~' + mins + 'm remaining'
      : '~' + Math.floor(mins/60) + 'h ' + (mins%60) + 'm remaining';
  }

  if (p.lastEvent) {
    events.unshift({ time: new Date().toLocaleTimeString(), text: p.lastEvent });
    if (events.length > 50) events.pop();
    updateEventLog();
  }

  if (p.recentItems && p.recentItems.length > 0) {
    updateRecentItems(p.recentItems);
    document.getElementById('recentItemsCard').style.display = 'block';
  }
}

function updateEventLog() {
  const el = document.getElementById('eventLog');
  el.innerHTML = events.length === 0
    ? '<div style="padding:10px;color:#555;text-align:center">No events yet</div>'
    : events.map(e => '<div class="event-item"><span class="event-time">[' + e.time + ']</span><span class="event-text">' + escapeHtml(e.text) + '</span></div>').join('');
}

function updateRecentItems(items) {
  const tbody = document.getElementById('recentItemsBody');
  tbody.innerHTML = items.map(item => {
    const cls = 's-' + item.status;
    return '<tr><td>' + escapeHtml(item.filename) + '</td>' +
      '<td style="font-family:monospace;font-size:.8rem">' + escapeHtml(item.messageId.slice(0,14)) + '…</td>' +
      '<td><span class="recent-item-status ' + cls + '">' + item.status.toUpperCase() + '</span></td></tr>';
  }).join('');
}

async function loadRuns() {
  try {
    const res = await fetch('/api/backfill/runs', { headers: getHeaders(false) });
    if (!res.ok) return;
    const data = await res.json();
    const tbody = document.getElementById('runsBody');
    if (!data.runs || data.runs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#555">No runs yet</td></tr>';
      return;
    }
    tbody.innerHTML = data.runs.map(r => {
      const started = new Date(r.startedAt).toLocaleString();
      const duration = r.completedAt
        ? Math.round((new Date(r.completedAt) - new Date(r.startedAt)) / 1000)
        : null;
      const durStr = duration === null ? '—' : duration < 60 ? duration + 's' : Math.floor(duration/60) + 'm ' + (duration%60) + 's';
      const cls = 'status-badge ' + r.status;
      return '<tr>' +
        '<td>' + started + '</td>' +
        '<td>' + (r.mode || '—') + '</td>' +
        '<td><span class="' + cls + '">' + r.status + '</span></td>' +
        '<td>' + r.stats.downloadedAttachments + '</td>' +
        '<td>' + r.stats.ingestedAttachments + '</td>' +
        '<td>' + r.stats.skipped + '</td>' +
        '<td>' + r.stats.errors + '</td>' +
        '<td>' + durStr + '</td>' +
        '</tr>';
    }).join('');
  } catch {}
}

window.addEventListener('DOMContentLoaded', () => {
  if (REQUIRES_AUTH && !getToken()) {
    document.getElementById('authModal').classList.add('active');
  }
  loadRuns();
  setInterval(loadRuns, 10000);
});
</script>
</body>
</html>`;
}

export default router;
