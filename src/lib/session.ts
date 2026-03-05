/**
 * ChatGPT session persistence — cookies and access token.
 *
 * Session is stored in .data/session/chatgpt-session.json.
 * Auth uses Bearer token (accessToken from /api/auth/session) + session cookies.
 */
import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';

const DATA_ROOT = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : process.env.NODE_ENV === 'production'
    ? '/app/.data'
    : path.resolve(process.cwd(), '.data');

const SESSION_DIR = path.join(DATA_ROOT, 'session');
const SESSION_FILE = path.join(SESSION_DIR, 'chatgpt-session.json');

// ── Session state ─────────────────────────────────────────────────────────────

interface ChatGPTSession {
  cookies: Record<string, string>;
  accessToken?: string;
  userEmail?: string;
  userName?: string;
  userId?: string;
  lastValidated?: string;
}

const session: ChatGPTSession = {
  cookies: {},
};

// Cookies to capture from chatgpt.com
const AUTH_COOKIE_PATTERNS = [
  /^__Secure-next-auth\.session-token$/,
  /^__Secure-next-auth\.callback-url$/,
  /^__Host-next-auth\.csrf-token$/,
  /^oai-did$/,
  /^oai-sc$/,
  /^oai-hlib$/,
  /^cf_clearance$/,
  /^__cf_bm$/,
  /^_cfuvid$/,
  /^oai-user-/,
  /^next-auth/,
];

export function isAuthCookie(name: string): boolean {
  return AUTH_COOKIE_PATTERNS.some(p => p.test(name));
}

export function setCookies(cookies: Record<string, string>): void {
  Object.assign(session.cookies, cookies);
}

export function getCookies(): Record<string, string> {
  return { ...session.cookies };
}

export function getCookieString(): string {
  return Object.entries(session.cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

export function setAccessToken(token: string): void {
  session.accessToken = token;
}

export function getAccessToken(): string | undefined {
  return session.accessToken;
}

/**
 * Full auth requires an accessToken (obtained from /api/auth/session).
 */
export function hasSession(): boolean {
  return Boolean(session.accessToken);
}

export function hasCookies(): boolean {
  return Boolean(session.cookies['__Secure-next-auth.session-token'] || session.cookies['oai-did']);
}

export function setUserInfo(info: { email?: string; name?: string; id?: string }): void {
  if (info.email) session.userEmail = info.email;
  if (info.name) session.userName = info.name;
  if (info.id) session.userId = info.id;
  session.lastValidated = new Date().toISOString();
}

export function getUserName(): string {
  return session.userName || session.userEmail || 'User';
}

export function getSessionInfo(): ChatGPTSession {
  return { ...session };
}

/**
 * Check if accessToken is expired by decoding the JWT exp field.
 * Returns true if the token is missing or expired.
 */
export function isTokenExpired(): boolean {
  const token = session.accessToken;
  if (!token) return true;
  try {
    const parts = token.split('.');
    if (parts.length < 2) return false; // Not a JWT, assume valid
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { exp?: number };
    if (!payload.exp) return false;
    // Add 30-second buffer
    return Date.now() / 1000 > payload.exp - 30;
  } catch {
    return false;
  }
}

export async function saveSessionToFile(): Promise<void> {
  try {
    await mkdir(SESSION_DIR, { recursive: true });
    await writeFile(SESSION_FILE, JSON.stringify(session, null, 2), 'utf8');
    console.log('[session] ChatGPT session persisted to', SESSION_FILE);
  } catch (err) {
    console.error('[session] Failed to save session:', err);
  }
}

export async function loadSessionFromFile(): Promise<boolean> {
  try {
    const data = await readFile(SESSION_FILE, 'utf8');
    const parsed = JSON.parse(data) as ChatGPTSession;

    if (typeof parsed !== 'object' || parsed === null) {
      console.warn('[session] Invalid session file format');
      return false;
    }

    if (parsed.cookies && typeof parsed.cookies === 'object') {
      Object.assign(session.cookies, parsed.cookies);
    }
    if (parsed.accessToken) session.accessToken = parsed.accessToken;
    if (parsed.userEmail) session.userEmail = parsed.userEmail;
    if (parsed.userName) session.userName = parsed.userName;
    if (parsed.userId) session.userId = parsed.userId;
    if (parsed.lastValidated) session.lastValidated = parsed.lastValidated;

    if (hasSession()) {
      if (isTokenExpired()) {
        console.log('[session] Access token is expired — will refresh on next API call');
      } else {
        console.log('[session] ChatGPT session loaded from', SESSION_FILE);
      }
      return true;
    }

    if (hasCookies()) {
      console.warn('[session] Loaded cookies but no accessToken — re-login may be needed');
    }
    return false;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    console.error('[session] Failed to load session:', err);
    return false;
  }
}

export function clearSession(): void {
  session.cookies = {};
  session.accessToken = undefined;
  session.userEmail = undefined;
  session.userName = undefined;
  session.userId = undefined;
  session.lastValidated = undefined;
}
