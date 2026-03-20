/**
 * ChatGPT backend API wrapper.
 *
 * Uses the same API that chatgpt.com's web UI uses.
 * Base: https://chatgpt.com/backend-api/
 * Auth: Authorization: Bearer <accessToken> header + session cookies.
 *
 * Access tokens expire (short-lived JWTs). Refresh logic automatically
 * re-fetches from /api/auth/session using stored cookies when the token expires.
 */
import {
  getCookieString,
  getAccessToken,
  setAccessToken,
  hasSession,
  isTokenExpired,
  setUserInfo,
  saveSessionToFile,
  getUserName,
  getCookies,
} from './session.js';

const CHATGPT_BASE = 'https://chatgpt.com';
const API_BASE = `${CHATGPT_BASE}/backend-api`;

const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1_000;
const DEFAULT_UA = process.env.CHROME_USER_AGENT
  ?? 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getBrowserLikeHeaders(includeAuthToken = true): Record<string, string> {
  const cookies = getCookies();
  const oaiDid = cookies['oai-did'];
  const headers: Record<string, string> = {
    Cookie: getCookieString(),
    'User-Agent': DEFAULT_UA,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Referer: 'https://chatgpt.com/',
    Origin: 'https://chatgpt.com',
    'Accept-Language': 'en-US,en;q=0.9',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
    'sec-ch-ua': '"Google Chrome";v="134", "Chromium";v="134", "Not:A-Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Linux"',
    'oai-language': 'en-US',
  };
  if (oaiDid) headers['oai-device-id'] = oaiDid;
  if (includeAuthToken) {
    const token = getAccessToken() ?? '';
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ChatGPTConversationListItem {
  id: string;
  title: string;
  create_time: number;
  update_time: number;
  mapping?: null;
  current_node?: null;
  gizmo_id?: string | null;
  is_archived?: boolean;
  workspace_id?: string | null;
  async_status?: string | null;
  safe_urls?: string[];
  conversation_template_id?: string | null;
}

export interface ChatGPTConversationList {
  items: ChatGPTConversationListItem[];
  total: number;
  limit: number;
  offset: number;
  has_missing_conversations?: boolean;
}

export interface ChatGPTMessageAuthor {
  role: 'user' | 'assistant' | 'system' | 'tool';
  name: string | null;
  metadata: Record<string, unknown>;
}

export interface ChatGPTMessageContent {
  content_type: string;
  parts?: Array<string | Record<string, unknown>>;
  text?: string;
}

export interface ChatGPTMessage {
  id: string;
  author: ChatGPTMessageAuthor;
  create_time: number | null;
  update_time?: number | null;
  content: ChatGPTMessageContent;
  status?: string;
  end_turn?: boolean | null;
  weight?: number;
  metadata: {
    model_slug?: string;
    parent_id?: string;
    message_type?: string | null;
    timestamp_?: string;
    finish_details?: { type: string; stop_tokens?: number[] };
    [key: string]: unknown;
  };
  recipient?: string;
}

export interface ChatGPTConversationNode {
  id: string;
  message: ChatGPTMessage | null;
  parent: string | null;
  children: string[];
}

export interface ChatGPTConversation {
  title: string;
  create_time: number;
  update_time: number;
  mapping: Record<string, ChatGPTConversationNode>;
  moderation_results?: unknown[];
  current_node: string | null;
  gizmo_id?: string | null;
  is_archived?: boolean;
  conversation_id?: string;
}

export interface SessionData {
  accessToken: string;
  user?: {
    id?: string;
    name?: string;
    email?: string;
  };
}

// ── Token refresh ─────────────────────────────────────────────────────────────

let _refreshInProgress: Promise<boolean> | null = null;

/**
 * Refresh the access token by fetching /api/auth/session with stored cookies.
 * Returns true if refresh succeeded.
 */
export async function refreshAccessToken(): Promise<boolean> {
  if (_refreshInProgress) return _refreshInProgress;

  _refreshInProgress = (async () => {
    try {
      console.log('[chatgpt-api] Refreshing access token...');
      const res = await fetch(`${CHATGPT_BASE}/api/auth/session`, {
        headers: getBrowserLikeHeaders(false),
      });

      if (!res.ok) {
        console.warn(`[chatgpt-api] Token refresh failed: HTTP ${res.status}`);
        return false;
      }

      const data = await res.json() as SessionData;
      if (!data.accessToken) {
        console.warn('[chatgpt-api] Token refresh: no accessToken in response');
        return false;
      }

      // Decode JWT to check expiry
      const token = data.accessToken;
      try {
        const parts = token.split('.');
        if (parts.length >= 2) {
          const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { exp?: number; iat?: number; iss?: string; sub?: string };
          const now = Math.floor(Date.now() / 1000);
          const expiresIn = (payload.exp ?? 0) - now;
          console.log(`[chatgpt-api] Token JWT: iss=${payload.iss}, sub=${payload.sub?.slice(0,20)}, iat=${payload.iat}, exp=${payload.exp}, expiresIn=${expiresIn}s`);
          if (expiresIn <= 0) {
            console.warn(`[chatgpt-api] ⚠️ Received token is ALREADY EXPIRED (${-expiresIn}s ago)!`);
          }
        }
      } catch {}
      
      setAccessToken(token);
      if (data.user) {
        setUserInfo({
          id: data.user.id,
          name: data.user.name,
          email: data.user.email,
        });
      }
      await saveSessionToFile();
      console.log('[chatgpt-api] Access token refreshed successfully');
      return true;
    } catch (err) {
      console.error('[chatgpt-api] Token refresh error:', err);
      return false;
    } finally {
      _refreshInProgress = null;
    }
  })();

  return _refreshInProgress;
}

/**
 * Get auth headers, refreshing token if expired.
 */
async function getAuthHeaders(): Promise<Record<string, string>> {
  if (isTokenExpired()) {
    await refreshAccessToken();
  }

  return getBrowserLikeHeaders(true);
}

// ── API helpers ───────────────────────────────────────────────────────────────

async function apiGet<T>(path: string): Promise<T> {
  const url = `${API_BASE}${path}`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const headers = await getAuthHeaders();
    let res: Response;

    try {
      res = await fetch(url, { headers });
    } catch (err) {
      if (attempt >= MAX_RETRIES) throw err;
      await sleep(INITIAL_BACKOFF_MS * Math.pow(2, attempt));
      continue;
    }

    // 401/403 — try token refresh once (403 can happen with stale token/device binding)
    if ((res.status === 401 || res.status === 403) && attempt === 0) {
      // Log the response body for debugging
      try {
        const errBody = await res.clone().text();
        console.error(`[chatgpt-api] ${res.status} response for ${path}:`, errBody.slice(0, 500));
        console.error(`[chatgpt-api] Response headers:`, JSON.stringify(Object.fromEntries(res.headers)));
      } catch {}
      const refreshed = await refreshAccessToken();
      if (refreshed) continue;
      if (res.status === 401) throw new Error(`ChatGPT API 401 for ${path} — session expired, please re-login`);
    }

    // 429 — rate limited
    if (res.status === 429) {
      if (attempt >= MAX_RETRIES) throw new Error(`ChatGPT API rate-limited (429) for ${path}`);
      const retryAfter = res.headers.get('retry-after') ?? '10';
      const waitMs = Math.ceil((parseFloat(retryAfter) || 10) * 1000) + 500;
      console.warn(`[chatgpt-api] 429 rate-limited — waiting ${waitMs}ms`);
      await sleep(waitMs);
      continue;
    }

    // 5xx — transient
    if (res.status >= 500) {
      if (attempt >= MAX_RETRIES) throw new Error(`ChatGPT API server error ${res.status} for ${path}`);
      await sleep(INITIAL_BACKOFF_MS * Math.pow(2, attempt));
      continue;
    }

    if (!res.ok) {
      let errDetail = '';
      try { errDetail = (await res.text()).slice(0, 300); } catch {}
      throw new Error(`ChatGPT API HTTP ${res.status} for ${path}: ${errDetail}`);
    }

    return res.json() as Promise<T>;
  }

  throw new Error(`apiGet: exhausted retries for ${path}`);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Validate session by fetching /api/auth/session.
 */
export async function validateSession(): Promise<{ valid: boolean; user?: string; email?: string; error?: string }> {
  try {
    const res = await fetch(`${CHATGPT_BASE}/api/auth/session`, {
      headers: await getAuthHeaders(),
    });

    if (!res.ok) {
      return { valid: false, error: `HTTP ${res.status}` };
    }

    const data = await res.json() as SessionData;
    if (!data.accessToken) {
      return { valid: false, error: 'No accessToken in session response' };
    }

    setAccessToken(data.accessToken);
    const user = data.user;
    if (user) {
      setUserInfo({ id: user.id, name: user.name, email: user.email });
    }

    return {
      valid: true,
      user: user?.name ?? user?.email ?? 'Unknown',
      email: user?.email,
    };
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * List conversations (one page).
 */
async function fetchConversationPage(
  offset: number,
  limit: number
): Promise<ChatGPTConversationList> {
  return apiGet<ChatGPTConversationList>(
    `/conversations?offset=${offset}&limit=${limit}&order=updated`
  );
}

/**
 * List all conversations, paginated.
 */
export async function listAllConversations(options?: {
  sinceMs?: number;
  maxCount?: number;
}): Promise<ChatGPTConversationListItem[]> {
  const all: ChatGPTConversationListItem[] = [];
  const batchSize = 100;
  let offset = 0;

  while (true) {
    const page = await fetchConversationPage(offset, batchSize);
    const items = page.items ?? [];

    let done = false;
    for (const item of items) {
      if (options?.sinceMs !== undefined && options.sinceMs > 0) {
        const updateMs = item.update_time * 1000;
        if (updateMs < options.sinceMs) {
          done = true;
          break;
        }
      }
      all.push(item);
      if (options?.maxCount !== undefined && all.length >= options.maxCount) {
        done = true;
        break;
      }
    }

    if (done) break;
    if (!page.items || page.items.length < batchSize) break;
    offset += batchSize;

    // Small delay to avoid rate limiting
    await sleep(200);
  }

  return all;
}

/**
 * Fetch a full conversation by ID including all messages.
 */
export async function fetchConversation(conversationId: string): Promise<ChatGPTConversation> {
  return apiGet<ChatGPTConversation>(`/conversation/${conversationId}`);
}

/**
 * Cached conversation list (15 minutes TTL).
 */
let _convCache: { items: ChatGPTConversationListItem[]; cachedAt: number } | null = null;
const CONV_CACHE_TTL_MS = 15 * 60 * 1000;

export async function listConversationsForUI(): Promise<{
  conversations: ChatGPTConversationListItem[];
  error?: string;
}> {
  if (_convCache && Date.now() - _convCache.cachedAt < CONV_CACHE_TTL_MS) {
    return { conversations: _convCache.items };
  }

  try {
    const all = await listAllConversations({ maxCount: 500 });
    _convCache = { items: all, cachedAt: Date.now() };
    return { conversations: all };
  } catch (err) {
    return { conversations: [], error: err instanceof Error ? err.message : String(err) };
  }
}

export function invalidateConversationCache(): void {
  _convCache = null;
}

/**
 * Get the title of a conversation (for display purposes).
 */
export async function fetchConversationTitle(conversationId: string): Promise<string | null> {
  if (conversationId === 'all') return 'All Conversations';
  try {
    // Try from cache first
    if (_convCache) {
      const found = _convCache.items.find(i => i.id === conversationId);
      if (found) return found.title;
    }
    const conv = await fetchConversation(conversationId);
    return conv.title ?? conversationId;
  } catch {
    return null;
  }
}

/**
 * Extract text content from a ChatGPT message.
 */
export function extractMessageText(msg: ChatGPTMessage): string {
  const content = msg.content;
  if (!content) return '';

  if (content.content_type === 'text' && content.text) {
    return content.text.trim();
  }

  if (Array.isArray(content.parts)) {
    const parts: string[] = [];
    for (const part of content.parts) {
      if (typeof part === 'string' && part.trim()) {
        parts.push(part.trim());
      } else if (typeof part === 'object' && part !== null) {
        // Attachment or image — note its presence
        const p = part as Record<string, unknown>;
        const partType = (p.content_type as string) ?? (p.type as string) ?? 'attachment';
        if (partType === 'image_asset_pointer' || partType === 'image') {
          parts.push('[image]');
        } else if (partType === 'audio_asset_pointer') {
          parts.push('[audio]');
        } else if (p.text && typeof p.text === 'string') {
          parts.push(p.text.trim());
        } else {
          parts.push(`[${partType}]`);
        }
      }
    }
    return parts.join('\n').trim();
  }

  return '';
}

/**
 * Determine the display name for a message sender.
 */
export function getMessageSender(msg: ChatGPTMessage): string {
  const role = msg.author?.role;
  if (role === 'user') {
    return getUserName();
  }
  if (role === 'assistant') {
    const modelSlug = msg.metadata?.model_slug;
    if (modelSlug && typeof modelSlug === 'string') {
      return modelSlug;
    }
    return 'assistant';
  }
  if (role === 'tool') {
    return `tool:${msg.author?.name ?? 'unknown'}`;
  }
  return role ?? 'unknown';
}
