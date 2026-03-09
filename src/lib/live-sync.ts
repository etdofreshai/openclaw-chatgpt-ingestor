/**
 * live-sync.ts — ChatGPT conversation sync with API/PG write backends.
 *
 * Fetches all conversations (or a specific one) from ChatGPT's backend API,
 * normalizes each message turn, and writes to the configured backend:
 *
 *   API mode  (preferred): MEMORY_DATABASE_API_URL + MEMORY_DATABASE_API_TOKEN
 *   PG mode   (fallback) : DATABASE_URL
 *
 * Normalization:
 *   - source: 'chatgpt'
 *   - sender: user name (for user messages) or model slug (for assistant messages)
 *   - recipient: 'ChatGPT' (for user) or user name (for assistant)
 *   - external_id: '{conversationId}:{messageId}'
 *   - metadata: { conversationId, conversationTitle, messageId, role, model, ... }
 */
import pg from 'pg';
import {
  hasSession,
  getUserName,
} from './session.js';
import {
  listAllConversations,
  fetchConversation,
  fetchConversationTitle,
  extractMessageText,
  getMessageSender,
  type ChatGPTConversationListItem,
  type ChatGPTConversation,
  type ChatGPTMessage,
} from './chatgpt-api.js';
import { isApiMode, writeMessagesViaApi, type ApiMessagePayload, type ChatGPTFileRef } from './api-writer.js';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface NormalizedMessage {
  externalId: string;
  timestamp: Date;
  sender: string;
  recipient: string;
  content: string;
  attachmentCount: number;
  files: ChatGPTFileRef[];
  metadata: Record<string, unknown>;
}

export interface SyncResult {
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
  attachmentsSeen: number;
  attachmentsDownloaded?: number;
  attachmentsIngested?: number;
}

// ── Message extraction ────────────────────────────────────────────────────────

/**
 * Extract all messages from a conversation's mapping tree.
 * Skips system messages and empty/tool-only messages.
 * Returns messages sorted by create_time.
 */
function extractMessages(conversation: ChatGPTConversation): ChatGPTMessage[] {
  const mapping = conversation.mapping;
  if (!mapping) return [];

  const messages: ChatGPTMessage[] = [];

  for (const nodeId of Object.keys(mapping)) {
    const node = mapping[nodeId];
    if (!node?.message) continue;

    const msg = node.message;

    // Skip system messages
    if (msg.author?.role === 'system') continue;

    // Skip tool/function messages (they're intermediary)
    if (msg.author?.role === 'tool') continue;

    // Skip messages without a timestamp
    if (!msg.create_time) continue;

    // Skip messages with zero weight (deleted/pruned)
    if (msg.weight === 0) continue;

    messages.push(msg);
  }

  // Sort by create_time ascending
  messages.sort((a, b) => (a.create_time ?? 0) - (b.create_time ?? 0));

  return messages;
}

function guessFilename(partType: string, assetPointer: string): string {
  const fileId = assetPointer.replace('file-service://', '');
  if (partType === 'image_asset_pointer') return `${fileId}.jpg`;
  if (partType === 'audio_asset_pointer') return `${fileId}.mp3`;
  return fileId;
}

function guessMimeType(partType: string): string {
  if (partType === 'image_asset_pointer') return 'image/jpeg';
  if (partType === 'audio_asset_pointer') return 'audio/mpeg';
  return 'application/octet-stream';
}

/**
 * Normalize a single ChatGPT message.
 * Returns null if the message should be skipped.
 */
function normalizeMessage(
  msg: ChatGPTMessage,
  conversationId: string,
  conversationTitle: string,
): NormalizedMessage | null {
  const text = extractMessageText(msg);
  if (!text) return null;

  const role = msg.author?.role ?? 'unknown';
  const userName = getUserName();
  const modelSlug = msg.metadata?.model_slug;

  let sender: string;
  let recipient: string;

  if (role === 'user') {
    sender = userName;
    recipient = 'ChatGPT';
  } else if (role === 'assistant') {
    sender = typeof modelSlug === 'string' && modelSlug ? modelSlug : 'assistant';
    recipient = userName;
  } else {
    sender = getMessageSender(msg);
    recipient = userName;
  }

  const timestamp = new Date((msg.create_time ?? 0) * 1000);
  const externalId = `${conversationId}:${msg.id}`;

  // Count attachments/images in content and extract file refs
  let attachmentCount = 0;
  const files: ChatGPTFileRef[] = [];
  if (Array.isArray(msg.content?.parts)) {
    for (const part of msg.content.parts) {
      if (typeof part === 'object' && part !== null) {
        attachmentCount++;
        const p = part as Record<string, unknown>;
        const partType = (p.content_type as string) ?? '';
        const assetPointer = p.asset_pointer as string | undefined;
        if (assetPointer && assetPointer.startsWith('file-service://')) {
          const filename = guessFilename(partType, assetPointer);
          const mimeType = guessMimeType(partType);
          files.push({ assetPointer, filename, mimeType, sizeBytes: p.size_bytes as number | undefined });
        }
      }
    }
  }

  return {
    externalId,
    timestamp,
    sender,
    recipient,
    content: text,
    attachmentCount,
    files,
    metadata: {
      conversationId,
      conversationTitle,
      messageId: msg.id,
      role,
      model: modelSlug ?? null,
      status: msg.status ?? null,
      endTurn: msg.end_turn ?? null,
      parentId: msg.metadata?.parent_id ?? null,
      contentType: msg.content?.content_type ?? null,
      parts: msg.content?.parts ?? null,
    },
  };
}

// ── PostgreSQL write path ─────────────────────────────────────────────────────

async function ensureSourceId(pool: pg.Pool): Promise<number> {
  const existing = await pool.query<{ id: number }>(
    'SELECT id FROM sources WHERE name = $1 LIMIT 1',
    ['chatgpt']
  );
  if (existing.rows[0]?.id) return existing.rows[0].id;
  const inserted = await pool.query<{ id: number }>(
    'INSERT INTO sources (name) VALUES ($1) RETURNING id',
    ['chatgpt']
  );
  return inserted.rows[0].id;
}

async function writeToPostgres(
  pool: pg.Pool,
  normalized: NormalizedMessage[]
): Promise<{ inserted: number; updated: number; skipped: number; attachmentsSeen: number }> {
  const sourceId = await ensureSourceId(pool);
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let attachmentsSeen = 0;

  for (const msg of normalized) {
    attachmentsSeen += msg.attachmentCount;

    const res = await pool.query<{ xmax: string }>(
      `INSERT INTO messages (source_id, external_id, timestamp, sender, recipient, content, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (source_id, external_id)
       DO UPDATE SET
         timestamp = EXCLUDED.timestamp,
         sender = EXCLUDED.sender,
         recipient = EXCLUDED.recipient,
         content = EXCLUDED.content,
         metadata = EXCLUDED.metadata
       RETURNING xmax`,
      [
        sourceId,
        msg.externalId,
        msg.timestamp.toISOString(),
        msg.sender,
        msg.recipient,
        msg.content,
        JSON.stringify(msg.metadata),
      ]
    );

    if ((res.rowCount ?? 0) > 0) {
      if (res.rows[0].xmax === '0') inserted++;
      else updated++;
    } else {
      skipped++;
    }
  }

  return { inserted, updated, skipped, attachmentsSeen };
}

// ── Sync a single conversation ────────────────────────────────────────────────

async function syncOneConversation(
  item: ChatGPTConversationListItem,
  sinceMs?: number
): Promise<NormalizedMessage[]> {
  const conv = await fetchConversation(item.id);
  let messages = extractMessages(conv);

  // Filter to only messages at or after the since cutoff
  if (sinceMs !== undefined && sinceMs > 0) {
    messages = messages.filter(
      msg => msg.create_time != null && msg.create_time * 1000 >= sinceMs
    );
  }

  const title = conv.title ?? item.title ?? item.id;

  const normalized: NormalizedMessage[] = [];
  for (const msg of messages) {
    const n = normalizeMessage(msg, item.id, title);
    if (n) normalized.push(n);
  }

  return normalized;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Get conversation display name for logging/UI.
 */
export async function fetchConversationName(conversationId: string): Promise<string | null> {
  if (conversationId === 'all') return 'All Conversations';
  return fetchConversationTitle(conversationId);
}

/**
 * Unified ChatGPT sync: fetch conversations/messages and write to the configured backend.
 *
 * @param conversationId - Specific conversation UUID, or 'all' to sync all conversations
 * @param options.sinceMs   - Only sync conversations updated after this Unix timestamp (ms)
 * @param options.limit     - Max conversations to sync (for 'all' mode)
 * @param options.verbose   - Log sync stats
 */
export async function syncChatGPTConversation(
  conversationId: string,
  options?: {
    sinceMs?: number;
    limit?: number;
    verbose?: boolean;
  }
): Promise<SyncResult> {
  if (!hasSession()) {
    throw new Error('No active ChatGPT session. Please log in first via /login.');
  }

  const allNormalized: NormalizedMessage[] = [];
  let conversationsFetched = 0;

  if (conversationId === 'all') {
    // Fetch all (or limited) conversations, filtered by sinceMs
    const conversations = await listAllConversations({
      sinceMs: options?.sinceMs,
      maxCount: options?.limit,
    });

    console.log(
      `[live-sync] Fetching ${conversations.length} conversations` +
      (options?.sinceMs ? ` updated since ${new Date(options.sinceMs).toISOString()}` : '')
    );

    for (const item of conversations) {
      try {
        const normalized = await syncOneConversation(item, options?.sinceMs);
        allNormalized.push(...normalized);
        conversationsFetched++;

        if (options?.verbose) {
          console.log(`[live-sync] Conversation "${item.title}" (${item.id}): ${normalized.length} messages`);
        }

        // Small delay to avoid rate limiting
        await sleep(300);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[live-sync] Failed to fetch conversation ${item.id}: ${msg}`);
      }
    }
  } else {
    // Fetch a specific conversation
    const item: ChatGPTConversationListItem = {
      id: conversationId,
      title: (await fetchConversationTitle(conversationId)) ?? conversationId,
      create_time: 0,
      update_time: 0,
    };

    const normalized = await syncOneConversation(item);
    allNormalized.push(...normalized);
    conversationsFetched = 1;
  }

  let result: SyncResult;

  if (isApiMode()) {
    const inputs = allNormalized.map(msg => ({
      payload: {
        source: 'chatgpt' as const,
        sender: msg.sender,
        recipient: msg.recipient,
        content: msg.content,
        timestamp: msg.timestamp.toISOString(),
        external_id: msg.externalId,
        metadata: msg.metadata,
      } satisfies ApiMessagePayload,
      attachmentCount: msg.attachmentCount,
      files: msg.files,
    }));

    const writeResult = await writeMessagesViaApi(inputs);
    result = { fetched: allNormalized.length, ...writeResult };
  } else {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error(
        'DATABASE_URL is not configured and API mode ' +
        '(MEMORY_DATABASE_API_URL + MEMORY_DATABASE_API_TOKEN) is not active.'
      );
    }

    const pool = new pg.Pool({ connectionString: databaseUrl });
    try {
      const writeResult = await writeToPostgres(pool, allNormalized);
      result = { fetched: allNormalized.length, ...writeResult };
    } finally {
      await pool.end();
    }
  }

  if (options?.verbose) {
    const mode = isApiMode() ? 'api' : 'pg';
    console.log(
      `[live-sync] ChatGPT [${mode}]: conversations=${conversationsFetched}, ` +
      `fetched=${result.fetched}, inserted=${result.inserted}, updated=${result.updated}, ` +
      `skipped=${result.skipped}, attachmentsSeen=${result.attachmentsSeen}`
    );
  }

  return result;
}
