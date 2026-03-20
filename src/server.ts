/**
 * ChatGPT ingestor server — Express + WebSocket for browser-driven session capture,
 * plus the Sync UI with scheduler for automated conversation ingestion.
 */
import 'dotenv/config';
import { createServer, type IncomingMessage } from 'http';
import { type Socket } from 'net';
import express from 'express';
import { WebSocket as NodeWebSocket, WebSocketServer } from 'ws';
import {
  ensureChromium,
  createChatGPTLoginScreencast,
  cdpListTabs,
  cdpCloseTab,
  CHROME_UA,
  CHROME_TZ,
} from './lib/browser.js';
import {
  setCookies,
  setAccessToken,
  saveSessionToFile,
  loadSessionFromFile,
  hasSession,
  isAuthCookie,
  setUserInfo,
  clearSession,
  getSessionInfo,
} from './lib/session.js';
import { validateSession } from './lib/chatgpt-api.js';
import syncRouter from './lib/sync-router.js';
import backfillRouter from './lib/backfill-router.js';
import { startScheduler } from './lib/scheduler.js';

const app = express();
const PORT = parseInt(process.env.LOGIN_SERVER_PORT ?? process.env.PORT ?? '3456');

const wss = new WebSocketServer({ noServer: true });

const SESSION_TIMEOUT_MS = 5 * 60 * 1000;
const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 800;

type SessionStatus = 'idle' | 'running' | 'success' | 'timeout' | 'error';

interface LoginSession {
  tabId: string;
  webSocketDebuggerUrl: string;
  status: SessionStatus;
  message: string;
  startedAt: number;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

let loginSession: LoginSession | null = null;

function closeLoginSession() {
  if (!loginSession) return;
  const s = loginSession;
  loginSession = null;
  clearTimeout(s.timeoutHandle);
  cdpListTabs()
    .then((tabs) => {
      for (const tab of tabs) {
        if (tab.id === s.tabId) cdpCloseTab(tab.id).catch(() => {});
      }
    })
    .catch(() => {});
}

const SPECIAL_KEY_MAP: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter:     { code: 'Enter',     keyCode: 13, text: '\r' },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Tab:       { code: 'Tab',       keyCode: 9 },
  Escape:    { code: 'Escape',    keyCode: 27 },
  Delete:    { code: 'Delete',    keyCode: 46 },
  ArrowUp:   { code: 'ArrowUp',   keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight:{ code: 'ArrowRight',keyCode: 39 },
  Home:      { code: 'Home',      keyCode: 36 },
  End:       { code: 'End',       keyCode: 35 },
  PageUp:    { code: 'Prior',     keyCode: 33 },
  PageDown:  { code: 'Next',      keyCode: 34 },
};

app.use(express.json());

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/', (_req, res) => {
  res.json({
    name: 'openclaw-chatgpt-ingestor',
    version: '0.1.0',
    endpoints: {
      login: '/login',
      loginStatus: '/api/login/status',
      syncUi: '/sync',
      syncApi: '/api/sync',
      backfill: '/backfill',
      jobs: '/api/jobs',
      runs: '/api/runs',
      sessionStatus: '/api/session/status',
      schedulerStatus: '/api/scheduler/status',
    },
  });
});

app.get('/api/health', async (_req, res) => {
  const validation = hasSession() ? await validateSession() : { valid: false };
  res.json({
    status: 'ok',
    authenticated: validation.valid,
    user: (validation as { user?: string }).user,
  });
});

// Clear stale session and force re-auth
app.post('/api/session/clear', async (_req, res) => {
  clearSession();
  await saveSessionToFile();
  console.log('[session] Session cleared via API');
  res.json({ ok: true, message: 'Session cleared. Please log in again.' });
});

// Manually set access token (e.g. extracted from browser DevTools)
app.post('/api/session/token', express.json(), async (req, res) => {
  const { accessToken } = req.body as { accessToken?: string };
  if (!accessToken) {
    res.status(400).json({ error: 'accessToken required in body' });
    return;
  }
  
  // Validate the token isn't expired
  try {
    const parts = accessToken.split('.');
    if (parts.length >= 2) {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { exp?: number };
      const now = Math.floor(Date.now() / 1000);
      if (payload.exp && payload.exp < now) {
        res.status(400).json({ error: `Token is already expired (${now - payload.exp}s ago)` });
        return;
      }
    }
  } catch {}
  
  setAccessToken(accessToken);
  await saveSessionToFile();
  
  // Validate it actually works
  const validation = await validateSession();
  if (validation.valid) {
    console.log(`[session] Token set manually — valid for ${validation.user}`);
    res.json({ ok: true, user: validation.user, message: `Token valid for ${validation.user}` });
  } else {
    res.json({ ok: true, warning: 'Token set but validation failed: ' + validation.error });
  }
});

// Debug: show current session state (tokens redacted)
app.get('/api/session/debug', (_req, res) => {
  const info = getSessionInfo();
  const token = info.accessToken;
  let tokenInfo: Record<string, unknown> = { present: !!token };
  if (token) {
    try {
      const parts = token.split('.');
      if (parts.length >= 2) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
        const now = Math.floor(Date.now() / 1000);
        tokenInfo = {
          present: true,
          iss: payload.iss,
          sub: typeof payload.sub === 'string' ? payload.sub.slice(0, 20) + '...' : undefined,
          iat: payload.iat,
          exp: payload.exp,
          issuedAt: payload.iat ? new Date((payload.iat as number) * 1000).toISOString() : undefined,
          expiresAt: payload.exp ? new Date((payload.exp as number) * 1000).toISOString() : undefined,
          expiresInSeconds: payload.exp ? (payload.exp as number) - now : undefined,
          isExpired: payload.exp ? (payload.exp as number) < now : undefined,
        };
      }
    } catch {}
  }
  res.json({
    hasCookies: Object.keys(info.cookies ?? {}).length > 0,
    cookieNames: Object.keys(info.cookies ?? {}),
    token: tokenInfo,
    user: info.userName,
    email: info.userEmail,
    lastValidated: info.lastValidated,
  });
});

app.get('/login', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(LOGIN_HTML);
});

app.post('/api/login/start', async (_req, res) => {
  if (loginSession && loginSession.status === 'running') {
    res.status(409).json({ error: 'Session already running' });
    return;
  }

  closeLoginSession();

  try {
    console.log('[login] Starting Chromium...');
    const tabInfo = await createChatGPTLoginScreencast();

    const timeoutHandle = setTimeout(() => {
      if (loginSession && loginSession.status === 'running') {
        console.log('[login] Session timed out.');
        loginSession.status = 'timeout';
        loginSession.message = '⏰ Session timed out after 5 minutes.';
        closeLoginSession();
      }
    }, SESSION_TIMEOUT_MS);

    loginSession = {
      tabId: tabInfo.id,
      webSocketDebuggerUrl: tabInfo.webSocketDebuggerUrl,
      status: 'running',
      message: 'Browser started. Please log in to ChatGPT.',
      startedAt: Date.now(),
      timeoutHandle,
    };

    console.log('[login] Session started, tab:', tabInfo.id);
    res.json({ success: true, message: 'Browser session started.' });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[login] Failed to start:', message);
    res.status(500).json({ error: message });
  }
});

app.get('/api/login/status', (_req, res) => {
  if (!loginSession) {
    res.json({ status: 'idle', message: 'No session active.' });
    return;
  }
  const remainingMs = SESSION_TIMEOUT_MS - (Date.now() - loginSession.startedAt);
  res.json({
    status: loginSession.status,
    message: loginSession.message,
    remainingMs: Math.max(0, remainingMs),
  });
});

app.post('/api/login/stop', (_req, res) => {
  closeLoginSession();
  res.json({ success: true });
});

app.post('/api/logout', (_req, res) => {
  clearSession();
  res.json({ success: true });
});

app.use(syncRouter);
app.use(backfillRouter);

// ── WebSocket handler ─────────────────────────────────────────────────────────

export function handleLoginWs(req: IncomingMessage, socket: Socket, head: Buffer): void {
  wss.handleUpgrade(req, socket, head, (clientWs) => {
    if (!loginSession || loginSession.status !== 'running') {
      clientWs.close(1008, 'No active login session');
      return;
    }

    const cdpWsUrl = loginSession.webSocketDebuggerUrl;
    const cdpWs = new NodeWebSocket(cdpWsUrl);
    let cmdId = 1;
    const capturedCookies: Record<string, string> = {};
    let loginDetected = false;
    let extractionPending = false;
    const pendingCommands = new Map<number, string>();

    function cdpCommand(method: string, params: Record<string, unknown> = {}): number {
      const id = cmdId++;
      if (cdpWs.readyState === NodeWebSocket.OPEN) {
        cdpWs.send(JSON.stringify({ method, params, id }));
      }
      return id;
    }

    /**
     * Try to extract the access token from the page by fetching /api/auth/session
     * from within the page context (so cookies are automatically included).
     */
    function tryExtractAccessToken(): void {
      if (extractionPending || loginDetected) return;
      extractionPending = true;
      const id = cdpCommand('Runtime.evaluate', {
        expression: `(async function() {
          try {
            const res = await fetch('/api/auth/session', {
              credentials: 'include',
              headers: { Accept: 'application/json' }
            });
            if (!res.ok) return null;
            const data = await res.json();
            return data && data.accessToken ? JSON.stringify({ accessToken: data.accessToken, user: data.user }) : null;
          } catch(e) { return null; }
        })()`,
        returnByValue: true,
        awaitPromise: true,
      });
      pendingCommands.set(id, 'extractToken');
    }

    async function checkAndCapture(): Promise<void> {
      if (!loginSession || loginDetected) return;

      // Need at least some auth cookies
      const hasAuthCookies = Object.keys(capturedCookies).some(k =>
        k.includes('session-token') || k.includes('oai-did') || k.includes('oai-sc')
      );
      if (!hasAuthCookies) return;

      tryExtractAccessToken();
    }

    cdpWs.on('open', () => {
      cdpCommand('Page.enable');
      cdpCommand('Network.enable');
      cdpCommand('Runtime.enable');
      cdpCommand('Log.enable');
      cdpCommand('Network.setUserAgentOverride', {
        userAgent: CHROME_UA,
        acceptLanguage: 'en-US,en;q=0.9',
        platform: 'Linux x86_64',
      });
      cdpCommand('Emulation.setTimezoneOverride', { timezoneId: CHROME_TZ });
      cdpCommand('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
      cdpCommand('Target.setDiscoverTargets', { discover: true });
      // Redirect popups to main page (Google OAuth, etc.)
      cdpCommand('Page.addScriptToEvaluateOnNewDocument', {
        source: `
          Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
          window.__origOpen = window.open;
          window.open = function(url) {
            if (url && url !== 'about:blank') { window.location.href = url; return window; }
            return window.__origOpen.apply(this, arguments);
          };
        `,
      });
      cdpCommand('Page.startScreencast', {
        format: 'jpeg',
        quality: 80,
        maxWidth: VIEWPORT_WIDTH,
        maxHeight: VIEWPORT_HEIGHT,
      });
    });

    cdpWs.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as {
          id?: number;
          result?: Record<string, unknown>;
          method?: string;
          params?: Record<string, unknown>;
        };

        // Handle command responses
        if (msg.id !== undefined && msg.result !== undefined) {
          const purpose = pendingCommands.get(msg.id);
          if (purpose === 'extractToken') {
            pendingCommands.delete(msg.id);
            extractionPending = false;

            const value = (msg.result as { result?: { value?: string } }).result?.value;
            if (typeof value === 'string' && value.startsWith('{')) {
              try {
                const parsed = JSON.parse(value) as { accessToken?: string; user?: { id?: string; name?: string; email?: string } };
                if (parsed.accessToken) {
                  loginDetected = true;
                  const token = parsed.accessToken;
                  const user = parsed.user;

                  // Merge captured cookies into session
                  setCookies(capturedCookies);
                  setAccessToken(token);
                  if (user) {
                    setUserInfo({ id: user.id, name: user.name, email: user.email });
                  }

                  // Validate by calling the API
                  validateSession()
                    .then(async (validation) => {
                      if (validation.valid) {
                        await saveSessionToFile();
                        if (loginSession) {
                          loginSession.status = 'success';
                          loginSession.message = `✅ Logged in as ${validation.user}`;
                        }
                        if (clientWs.readyState === NodeWebSocket.OPEN) {
                          clientWs.send(JSON.stringify({ type: 'success', user: validation.user }));
                        }
                        setTimeout(() => closeLoginSession(), 4000);
                      } else {
                        loginDetected = false;
                        extractionPending = false;
                        console.log('[login] Token captured but validation failed:', validation.error);
                      }
                    })
                    .catch((err) => {
                      console.error('[login] Validation error:', err);
                      loginDetected = false;
                      extractionPending = false;
                    });
                }
              } catch {}
            } else {
              console.log('[login] Access token not found in page yet — waiting...');
            }
          } else if (purpose === 'getSessionBody') {
            pendingCommands.delete(msg.id);
            const body = (msg.result as { body?: string; base64Encoded?: boolean })?.body;
            if (body && !loginDetected) {
              console.log(`[login] Got /api/auth/session response body (${body.length} chars): ${body.slice(0, 200)}`);
              try {
                const parsed = JSON.parse(body) as { accessToken?: string; user?: { id?: string; name?: string; email?: string } };
                if (parsed.accessToken) {
                  console.log('[login] ✅ Access token captured from network intercept!');
                  loginDetected = true;
                  setCookies(capturedCookies);
                  setAccessToken(parsed.accessToken);
                  if (parsed.user) {
                    setUserInfo({ id: parsed.user.id, name: parsed.user.name, email: parsed.user.email });
                  }
                  validateSession()
                    .then(async (validation) => {
                      if (validation.valid) {
                        await saveSessionToFile();
                        if (loginSession) {
                          loginSession.status = 'success';
                          loginSession.message = `✅ Logged in as ${validation.user}`;
                        }
                        if (clientWs.readyState === NodeWebSocket.OPEN) {
                          clientWs.send(JSON.stringify({ type: 'success', user: validation.user }));
                        }
                        setTimeout(() => closeLoginSession(), 4000);
                      } else {
                        loginDetected = false;
                        console.log('[login] Network-intercepted token failed validation:', validation.error);
                      }
                    })
                    .catch((err) => {
                      console.error('[login] Network intercept validation error:', err);
                      loginDetected = false;
                    });
                } else {
                  console.log('[login] /api/auth/session body has no accessToken — user may not be fully logged in');
                }
              } catch (e) {
                console.error('[login] Failed to parse /api/auth/session body:', e);
              }
            }
          }
          return;
        }

        // Handle CDP events
        if (msg.method === 'Target.targetCreated') {
          const targetInfo = (msg.params as { targetInfo?: { type?: string; url?: string; targetId?: string; openerId?: string } }).targetInfo;
          if (targetInfo?.type === 'page' && targetInfo.url && targetInfo.openerId && targetInfo.targetId && targetInfo.url !== 'about:blank') {
            console.log(`[login] Popup detected: ${targetInfo.url}`);
            cdpCommand('Target.closeTarget', { targetId: targetInfo.targetId });
            cdpCommand('Page.navigate', { url: targetInfo.url });
          }
        }

        if (msg.method === 'Page.windowOpen') {
          const params = msg.params as { url?: string };
          if (params.url && params.url !== 'about:blank') {
            console.log(`[login] window.open intercepted → ${params.url}`);
            cdpCommand('Page.navigate', { url: params.url });
          }
        }

        if (msg.method === 'Runtime.consoleAPICalled') {
          const params = msg.params as { type?: string; args?: Array<{ value?: unknown; description?: string }> };
          const level = (params.type ?? 'log').toUpperCase();
          const rendered = (params.args ?? [])
            .map((a) => (a?.value !== undefined ? String(a.value) : (a?.description ?? '')))
            .filter(Boolean)
            .join(' ');
          if (rendered) console.log(`[browser:${level}] ${rendered}`);

        } else if (msg.method === 'Runtime.exceptionThrown') {
          const details = (msg.params as { exceptionDetails?: { text?: string; url?: string; lineNumber?: number; columnNumber?: number } })?.exceptionDetails;
          console.error(`[browser:EXCEPTION] ${details?.text ?? 'Unknown exception'} @ ${details?.url ?? 'unknown'}:${(details?.lineNumber ?? 0) + 1}:${(details?.columnNumber ?? 0) + 1}`);

        } else if (msg.method === 'Log.entryAdded') {
          const entry = (msg.params as { entry?: { level?: string; source?: string; text?: string; url?: string; lineNumber?: number } })?.entry;
          if (entry?.text) {
            const level = (entry.level ?? 'info').toUpperCase();
            console.log(`[browser:${level}] [${entry.source ?? 'log'}] ${entry.text}${entry.url ? ` (${entry.url}:${entry.lineNumber ?? 0})` : ''}`);
          }

        } else if (msg.method === 'Page.screencastFrame') {
          const params = msg.params as { sessionId: number; data: string; metadata: unknown };
          if (clientWs.readyState === NodeWebSocket.OPEN) {
            clientWs.send(JSON.stringify({ type: 'frame', data: params.data, metadata: params.metadata }));
          }
          cdpCommand('Page.screencastFrameAck', { sessionId: params.sessionId });

        } else if (msg.method === 'Network.responseReceivedExtraInfo') {
          // Capture cookies from Set-Cookie headers
          const headers = (msg.params as { headers?: Record<string, string> }).headers ?? {};
          for (const [name, value] of Object.entries(headers)) {
            if (name.toLowerCase() !== 'set-cookie') continue;
            for (const entry of String(value).split('\n')) {
              const match = entry.match(/^([^=]+)=([^;]*)/);
              if (match) {
                const cookieName = match[1].trim();
                const cookieVal = match[2].trim();
                if (isAuthCookie(cookieName)) {
                  capturedCookies[cookieName] = cookieVal;
                  console.log(`[login] Captured cookie: ${cookieName}`);
                }
              }
            }
          }
          void checkAndCapture();

        } else if (msg.method === 'Network.requestWillBeSentExtraInfo') {
          // Capture cookies from outgoing requests
          const params = msg.params as {
            associatedCookies?: Array<{ cookie: { name: string; value: string } }>;
            headers?: Record<string, string>;
          };
          if (Array.isArray(params.associatedCookies)) {
            for (const entry of params.associatedCookies) {
              const c = entry.cookie;
              if (c?.name && c.value && isAuthCookie(c.name)) {
                capturedCookies[c.name] = c.value;
              }
            }
          }
          const cookieHeader = params.headers?.['cookie'] ?? params.headers?.['Cookie'];
          if (cookieHeader) {
            for (const pair of cookieHeader.split(';')) {
              const idx = pair.indexOf('=');
              if (idx > 0) {
                const name = pair.slice(0, idx).trim();
                const val = pair.slice(idx + 1).trim();
                if (isAuthCookie(name) && val) capturedCookies[name] = val;
              }
            }
          }
          void checkAndCapture();

        } else if (msg.method === 'Page.frameNavigated') {
          const url = (msg.params as { frame?: { url?: string } })?.frame?.url ?? '';
          // ChatGPT is loaded when we see these URLs
          if (
            url.startsWith('https://chatgpt.com/') &&
            !url.includes('/auth/') &&
            !url.includes('auth0') &&
            !url.includes('accounts.google') &&
            url !== 'https://chatgpt.com/auth/login'
          ) {
            console.log(`[login] ChatGPT page navigated to: ${url}`);
            // Wait briefly for page to settle, then try token extraction
            setTimeout(() => void checkAndCapture(), 2000);
          }

        } else if (msg.method === 'Network.responseReceived') {
          // Intercept /api/auth/session response to capture token directly
          const params = msg.params as { response?: { url?: string; status?: number }; requestId?: string };
          const responseUrl = params.response?.url ?? '';
          if (responseUrl.includes('/api/auth/session') && params.response?.status === 200 && params.requestId) {
            console.log(`[login] /api/auth/session status=${params.response?.status ?? 'unknown'} — intercepting response body (requestId=${params.requestId})...`);
            // Try to get the actual response body via CDP
            const bodyId = cdpCommand('Network.getResponseBody', { requestId: params.requestId });
            pendingCommands.set(bodyId, 'getSessionBody');
            // Also try the old method as fallback
            setTimeout(() => void checkAndCapture(), 2000);
          }

        } else if (msg.method === 'Network.loadingFailed') {
          const params = msg.params as { requestId?: string; errorText?: string; blockedReason?: string; canceled?: boolean };
          console.log(`[browser:NETWORK_FAIL] request=${params.requestId ?? 'unknown'} error=${params.errorText ?? 'unknown'} blocked=${params.blockedReason ?? 'none'} canceled=${params.canceled ? 'yes' : 'no'}`);
        }
      } catch {}
    });

    clientWs.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as { type: string; x?: number; y?: number; key?: string; text?: string };

        if (msg.type === 'click') {
          const { x, y } = msg;
          cdpCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
          setTimeout(() => {
            cdpCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
            setTimeout(() => {
              cdpCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
            }, 50);
          }, 30);
        } else if (msg.type === 'keydown') {
          const key = msg.key as string;
          const keyInfo = SPECIAL_KEY_MAP[key];
          if (keyInfo) {
            cdpCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: keyInfo.code, windowsVirtualKeyCode: keyInfo.keyCode });
            if (keyInfo.text) cdpCommand('Input.dispatchKeyEvent', { type: 'char', text: keyInfo.text });
            cdpCommand('Input.dispatchKeyEvent', { type: 'keyUp', key, code: keyInfo.code, windowsVirtualKeyCode: keyInfo.keyCode });
          } else {
            cdpCommand('Input.dispatchKeyEvent', { type: 'keyDown', key, text: key });
            cdpCommand('Input.dispatchKeyEvent', { type: 'keyUp', key });
          }
        } else if (msg.type === 'type') {
          cdpCommand('Input.insertText', { text: msg.text });
        } else if (msg.type === 'scroll') {
          cdpCommand('Input.dispatchMouseEvent', {
            type: 'mouseWheel',
            x: msg.x ?? 0,
            y: msg.y ?? 0,
            deltaX: 0,
            deltaY: (msg as { deltaY?: number }).deltaY ?? 0,
          });
        }
      } catch {}
    });

    const cleanup = () => {
      try { cdpCommand('Page.stopScreencast'); } catch {}
      try { cdpWs.close(); } catch {}
      try { clientWs.close(); } catch {}
    };

    clientWs.on('close', cleanup);
    cdpWs.on('close', () => { try { clientWs.close(); } catch {} });
    cdpWs.on('error', (err) => {
      console.error('[login] CDP WS error:', err.message);
      try { clientWs.close(); } catch {}
    });
    clientWs.on('error', () => cleanup());
  });
}

// ── Login HTML ────────────────────────────────────────────────────────────────

const LOGIN_HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>ChatGPT Login — OpenClaw</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0f0f0f;color:#e0e0e0;font-family:system-ui,sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:16px 8px}
  h1{font-size:1.4rem;font-weight:600;margin-bottom:12px;color:#fff}
  #status-bar{width:100%;max-width:900px;background:#1a1a2e;border:1px solid #333;border-radius:8px;padding:10px 16px;margin-bottom:12px;font-size:.9rem;min-height:42px;display:flex;align-items:center;gap:8px}
  #status-dot{width:10px;height:10px;border-radius:50%;background:#555;flex-shrink:0;transition:background .3s}
  #status-dot.running{background:#22c55e;animation:pulse 1.2s infinite}
  #status-dot.success{background:#22c55e}
  #status-dot.timeout,#status-dot.error{background:#ef4444}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
  #timer{margin-left:auto;font-size:.8rem;color:#888;white-space:nowrap}
  .controls{width:100%;max-width:900px;display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px;align-items:center}
  button{background:#10a37f;color:#fff;border:none;border-radius:6px;padding:8px 16px;cursor:pointer;font-size:.85rem;font-weight:500;transition:background .15s;white-space:nowrap}
  button:hover{background:#0d8f6e}
  button:disabled{background:#374151;cursor:not-allowed;color:#6b7280}
  button.danger{background:#dc2626}
  button.danger:hover{background:#b91c1c}
  button.secondary{background:#374151}
  button.secondary:hover{background:#4b5563}
  #type-input{flex:1;min-width:180px;background:#1e1e1e;border:1px solid #444;color:#e0e0e0;border-radius:6px;padding:8px 12px;font-size:.85rem}
  #type-input:focus{outline:none;border-color:#10a37f}
  .key-group{display:flex;gap:4px}
  #canvas-wrap{width:100%;max-width:900px;position:relative;background:#111;border:2px solid #333;border-radius:8px;overflow:hidden;cursor:pointer;outline:none;transition:border-color .2s}
  #canvas-wrap.inactive{cursor:default;pointer-events:none}
  #canvas-wrap.canvas-focused{border-color:#10a37f;box-shadow:0 0 0 2px rgba(16,163,127,.3)}
  #screen{display:block;width:100%;height:auto;user-select:none}
  #placeholder{width:100%;aspect-ratio:16/10;display:flex;align-items:center;justify-content:center;color:#555;font-size:1rem}
  #overlay-msg{position:absolute;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.7);font-size:1.3rem;font-weight:600;color:#fff}
  .nav-links{display:flex;gap:16px;margin-top:12px;font-size:.85rem}
  .nav-links a{color:#10a37f;text-decoration:none}
  .nav-links a:hover{text-decoration:underline}
  .tip{width:100%;max-width:900px;background:#1a2a1e;border:1px solid #2a4a2e;border-radius:6px;padding:10px 14px;font-size:.8rem;color:#aaa;margin-bottom:12px;line-height:1.6}
  .tip strong{color:#ccc}
</style>
</head>
<body>
<h1>🔐 ChatGPT Login</h1>

<div id="status-bar">
  <span id="status-dot"></span>
  <span id="status-text">Click "Start Login" to open ChatGPT in the browser.</span>
  <span id="timer"></span>
</div>

<div class="tip">
  <strong>How it works:</strong> A headless browser will open chatgpt.com. Log in normally (including Google/Microsoft SSO — popups are automatically redirected inline). Once logged in, your session is automatically captured and saved.
</div>

<div class="controls">
  <button id="start-btn" onclick="startSession()">▶ Start Login</button>
  <button id="stop-btn" class="danger" onclick="stopSession()" disabled>■ Stop</button>
  <input id="type-input" type="text" placeholder="Type text and press Enter (or Send)…" autocomplete="off" spellcheck="false"/>
  <button class="secondary" onclick="sendInput()" disabled id="send-btn">Send</button>
  <div class="key-group">
    <button class="secondary" onclick="sendKey('Enter')" disabled id="key-enter">↵ Enter</button>
    <button class="secondary" onclick="sendKey('Tab')" disabled id="key-tab">⇥ Tab</button>
    <button class="secondary" onclick="sendKey('Backspace')" disabled id="key-bs">⌫ Back</button>
    <button class="secondary" onclick="sendKey('Escape')" disabled id="key-esc">Esc</button>
  </div>
</div>

<div id="canvas-wrap" class="inactive" tabindex="0">
  <canvas id="screen"></canvas>
  <div id="placeholder">Login screen will appear here.</div>
  <div id="overlay-msg"></div>
</div>

<div class="nav-links">
  <a id="link-sync">→ Sync UI</a>
  <a id="link-session">→ Session Status</a>
  <a id="link-health">→ Health</a>
</div>

<script>
const BASE = (() => { const p = location.pathname.replace(/\\/login\\/?$/, ''); return p + '/api'; })();
let ws = null;
let sessionActive = false;
let startTime = null;
let timerInterval = null;
let hasFirstFrame = false;

const canvas = document.getElementById('screen');
const ctx = canvas.getContext('2d');
const placeholder = document.getElementById('placeholder');
const canvasWrap = document.getElementById('canvas-wrap');

canvas.width = ${VIEWPORT_WIDTH};
canvas.height = ${VIEWPORT_HEIGHT};

function setStatus(text, dotClass) {
  document.getElementById('status-text').textContent = text;
  document.getElementById('status-dot').className = dotClass || '';
}

function setControlsEnabled(enabled) {
  sessionActive = enabled;
  document.getElementById('stop-btn').disabled = !enabled;
  document.getElementById('send-btn').disabled = !enabled;
  ['key-enter','key-tab','key-bs','key-esc'].forEach(id => {
    document.getElementById(id).disabled = !enabled;
  });
  canvasWrap.classList.toggle('inactive', !enabled);
}

function startTimer() {
  startTime = Date.now();
  timerInterval = setInterval(() => {
    if (!startTime) return;
    const elapsed = Date.now() - startTime;
    const remaining = Math.max(0, 300000 - elapsed);
    const m = Math.floor(remaining / 60000);
    const s = Math.floor((remaining % 60000) / 1000);
    document.getElementById('timer').textContent = remaining > 0 ? '\u23f1 ' + m + ':' + s.toString().padStart(2,'0') + ' left' : '';
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
  document.getElementById('timer').textContent = '';
}

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsBase = location.pathname.replace(/\\/login\\/?$/, '');
  ws = new WebSocket(proto + '//' + location.host + wsBase + '/ws/login');
  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'frame') {
        const img = new Image();
        img.onload = () => {
          if (canvas.width !== img.naturalWidth || canvas.height !== img.naturalHeight) {
            canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
          }
          ctx.drawImage(img, 0, 0);
          if (!hasFirstFrame) {
            hasFirstFrame = true;
            placeholder.style.display = 'none';
            canvas.style.display = 'block';
          }
        };
        img.src = 'data:image/jpeg;base64,' + msg.data;
      } else if (msg.type === 'success') {
        stopTimer();
        setStatus('\u2705 Logged in as ' + msg.user, 'success');
        setControlsEnabled(false);
        showOverlay('\u2705 Login successful! Redirecting…');
        document.getElementById('start-btn').disabled = false;
        if (ws) { try { ws.close(); } catch {} ws = null; }
        const navBase = location.pathname.replace(/\\/login\\/?$/, '');
        setTimeout(() => { window.location.href = navBase + '/sync'; }, 3000);
      }
    } catch(e) {}
  };
  ws.onerror = () => setStatus('WebSocket error — try again.', 'error');
}

async function startSession() {
  document.getElementById('start-btn').disabled = true;
  hasFirstFrame = false;
  canvas.style.display = 'none';
  placeholder.style.display = 'flex';
  placeholder.textContent = 'Starting browser…';
  setStatus('Starting browser…', 'running');
  try {
    const r = await fetch(BASE + '/login/start', { method: 'POST' });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Failed to start');
    setStatus('Browser started. Log in to ChatGPT.', 'running');
    setControlsEnabled(true);
    startTimer();
    setTimeout(connectWs, 500);
  } catch(e) {
    setStatus('Error: ' + e.message, 'error');
    document.getElementById('start-btn').disabled = false;
    placeholder.textContent = 'Failed to start.';
  }
}

async function stopSession() {
  stopTimer();
  if (ws) { try { ws.close(); } catch {} ws = null; }
  await fetch(BASE + '/login/stop', { method: 'POST' }).catch(() => {});
  setControlsEnabled(false);
  setStatus('Session stopped.', '');
  document.getElementById('start-btn').disabled = false;
  hasFirstFrame = false;
  canvas.style.display = 'none';
  placeholder.style.display = 'flex';
  placeholder.textContent = 'Session stopped.';
}

function showOverlay(msg) {
  const o = document.getElementById('overlay-msg');
  o.textContent = msg; o.style.display = 'flex';
}

canvasWrap.addEventListener('click', (event) => {
  if (!sessionActive || !ws || ws.readyState !== WebSocket.OPEN) return;
  const rect = canvas.getBoundingClientRect();
  const relX = (event.clientX - rect.left) / rect.width;
  const relY = (event.clientY - rect.top) / rect.height;
  ws.send(JSON.stringify({ type: 'click', x: Math.round(relX * canvas.width), y: Math.round(relY * canvas.height) }));
});

canvasWrap.addEventListener('wheel', (event) => {
  if (!sessionActive || !ws || ws.readyState !== WebSocket.OPEN) return;
  event.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const relX = (event.clientX - rect.left) / rect.width;
  const relY = (event.clientY - rect.top) / rect.height;
  ws.send(JSON.stringify({ type: 'scroll', x: Math.round(relX * canvas.width), y: Math.round(relY * canvas.height), deltaY: event.deltaY }));
}, { passive: false });

/* ── Input box: keydown + paste ─────────────────────────────────────────── */
const typeInput = document.getElementById('type-input');

typeInput.addEventListener('keydown', (event) => {
  event.stopPropagation();                       // never let the global handler see input keys
  if (event.key === 'Enter') {
    event.preventDefault();
    sendInput();
  }
});

typeInput.addEventListener('paste', (event) => {
  event.stopPropagation();                       // keep paste inside the input
});

function sendInput() {
  const text = typeInput.value;
  if (text && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'type', text }));
    typeInput.value = '';
  }
}

/* ── Global keydown: forward to CDP when canvas is focused ─────────────── */
document.addEventListener('keydown', (event) => {
  if (!sessionActive || !ws || ws.readyState !== WebSocket.OPEN) return;
  if (document.activeElement === typeInput) return;           // input handles itself
  if (event.ctrlKey || event.metaKey || event.altKey) return; // don't swallow OS shortcuts
  event.preventDefault();
  if (event.key.length === 1) ws.send(JSON.stringify({ type: 'type', text: event.key }));
  else ws.send(JSON.stringify({ type: 'keydown', key: event.key }));
});

function sendKey(key) {
  if (!sessionActive || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'keydown', key }));
}

// Fix nav links for proxy-prefixed paths
(function() {
  const base = location.pathname.replace(/\\/login\\/?$/, '');
  document.getElementById('link-sync').href = base + '/sync';
  document.getElementById('link-session').href = base + '/api/session/status';
  document.getElementById('link-health').href = base + '/api/health';
})();
</script>
</body>
</html>`;

// ── Start Server ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const loaded = await loadSessionFromFile();
  if (loaded) {
    console.log('[startup] ChatGPT session loaded from file');
  } else {
    console.log('[startup] No ChatGPT session — use /login to authenticate');
  }

  const httpServer = createServer(app);

  httpServer.on('upgrade', (req, socket, head) => {
    const url = req.url ?? '';
    if (url === '/ws/login') {
      handleLoginWs(req, socket as Socket, head);
    } else {
      socket.destroy();
    }
  });

  httpServer.listen(PORT, async () => {
    console.log(`[ChatGPT Ingestor] Running on http://localhost:${PORT}`);
    console.log(`[ChatGPT Ingestor] Login UI:  http://localhost:${PORT}/login`);
    console.log(`[ChatGPT Ingestor] Sync UI:   http://localhost:${PORT}/sync`);
    await startScheduler();
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
