/**
 * Memory Database API write module for ChatGPT messages.
 * Supports both plain JSON writes and multipart ingest with file attachments.
 *
 * Writes normalized ChatGPT messages to the Memory Database API.
 * Enabled when both MEMORY_DATABASE_API_URL and MEMORY_DATABASE_API_TOKEN are set.
 *
 * Mode precedence:
 *   1. API mode  — MEMORY_DATABASE_API_URL + MEMORY_DATABASE_API_TOKEN both set
 *   2. PG mode   — fallback; DATABASE_URL required
 */

import { downloadChatGPTFile } from './attachment-downloader.js';

const MAX_API_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1_000;

export function isApiMode(): boolean {
  return !!(
    process.env.MEMORY_DATABASE_API_URL?.trim() &&
    process.env.MEMORY_DATABASE_API_TOKEN?.trim()
  );
}

export type ApiMessagePayload = {
  source: 'chatgpt';
  sender: string;
  recipient: string;
  content: string;
  timestamp: string;
  external_id: string;
  metadata: Record<string, unknown>;
};

/** A ChatGPT file reference extracted from message content parts. */
export type ChatGPTFileRef = {
  assetPointer: string;   // "file-service://file-XXXXX"
  filename: string;
  mimeType?: string;
  sizeBytes?: number;
};

type SingleWriteOutcome = 'inserted' | 'updated' | 'skipped';

export type ApiWriteResult = {
  inserted: number;
  updated: number;
  skipped: number;
  attachmentsSeen: number;
  attachmentsDownloaded: number;
  attachmentsIngested: number;
};

async function writeOneMessage(
  baseUrl: string,
  token: string,
  payload: ApiMessagePayload
): Promise<SingleWriteOutcome> {
  for (let attempt = 0; attempt <= MAX_API_RETRIES; attempt++) {
    let res: Response;

    try {
      res = await fetch(`${baseUrl}/api/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });
    } catch (err: unknown) {
      if (attempt >= MAX_API_RETRIES) {
        console.error(`[api-writer] Network error for external_id=${payload.external_id} — exhausted retries:`, err);
        return 'skipped';
      }
      await sleep(INITIAL_BACKOFF_MS * Math.pow(2, attempt));
      continue;
    }

    if (res.status === 429) {
      if (attempt >= MAX_API_RETRIES) {
        console.error(`[api-writer] 429 for external_id=${payload.external_id} — exhausted retries`);
        return 'skipped';
      }
      const retryHeader = res.headers.get('retry-after') ?? '5';
      const waitMs = Math.ceil((parseFloat(retryHeader) || 5) * 1_000) + 500;
      console.warn(`[api-writer] 429 — waiting ${waitMs}ms`);
      await sleep(waitMs);
      continue;
    }

    if (res.status >= 500) {
      if (attempt >= MAX_API_RETRIES) {
        console.error(`[api-writer] API error ${res.status} for external_id=${payload.external_id} — exhausted retries`);
        return 'skipped';
      }
      await sleep(INITIAL_BACKOFF_MS * Math.pow(2, attempt));
      continue;
    }

    if (res.status === 201) return 'inserted';
    if (res.status === 200) return 'updated';
    if (res.status === 409) return 'updated';

    const body = await res.text().catch(() => '');
    console.error(`[api-writer] Unrecoverable API error ${res.status} for external_id=${payload.external_id}: ${body.slice(0, 200)}`);
    return 'skipped';
  }

  return 'skipped';
}

/**
 * Ingest a single file attachment via POST /api/messages/ingest (multipart).
 */
async function ingestOneFile(
  baseUrl: string,
  token: string,
  payload: ApiMessagePayload,
  fileBuffer: Buffer,
  file: ChatGPTFileRef
): Promise<boolean> {
  const filename = file.filename || 'attachment';
  const contentType = file.mimeType || 'application/octet-stream';
  const attachmentsMeta = [
    {
      original_file_name: filename,
      created_at_source: payload.timestamp,
    },
  ];

  for (let attempt = 0; attempt <= MAX_API_RETRIES; attempt++) {
    try {
      const form = new FormData();
      form.append('message', JSON.stringify(payload));
      form.append(
        'files',
        new Blob([new Uint8Array(fileBuffer)], { type: contentType }),
        filename
      );
      form.append('attachments_meta', JSON.stringify(attachmentsMeta));

      const res = await fetch(`${baseUrl}/api/messages/ingest`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent': 'openclaw-chatgpt-ingestor/1.0',
        },
        body: form,
      });

      if (res.status === 429) {
        const retryAfter = parseFloat(res.headers.get('retry-after') ?? '5');
        const waitMs = Math.ceil(retryAfter * 1000) + 500;
        console.warn(`[api-writer] 429 rate limit on ingest for ${filename}, waiting ${waitMs}ms`);
        await sleep(waitMs);
        continue;
      }

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`API returned ${res.status}: ${body.slice(0, 500)}`);
      }

      console.log(`[api-writer] ✓ Ingested attachment ${filename} for ${payload.external_id}`);
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt >= MAX_API_RETRIES) {
        console.error(`[api-writer] Failed to ingest ${filename} for ${payload.external_id}: ${msg}`);
        return false;
      }
      const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
      console.warn(`[api-writer] Error ingesting ${filename} (attempt ${attempt + 1}), retrying in ${backoff}ms: ${msg}`);
      await sleep(backoff);
    }
  }

  return false;
}

/**
 * Write a message with attached files via multipart /api/messages/ingest.
 * Downloads files inline using downloadChatGPTFile().
 * Falls back to plain JSON write if all downloads fail.
 */
export async function writeMessageWithFiles(
  payload: ApiMessagePayload,
  files: ChatGPTFileRef[]
): Promise<SingleWriteOutcome> {
  const baseUrl = (process.env.MEMORY_DATABASE_API_URL ?? '').replace(/\/+$/, '');
  const readToken = process.env.MEMORY_DATABASE_API_TOKEN ?? '';
  const writeToken = process.env.MEMORY_DATABASE_API_WRITE_TOKEN ?? readToken;

  let ingested = 0;

  for (const file of files) {
    let fileBuffer: Buffer;
    try {
      fileBuffer = await downloadChatGPTFile(file.assetPointer, file.filename);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[api-writer] Failed to download ${file.filename} for ${payload.external_id}: ${msg} — skipping file`);
      continue;
    }

    const ok = await ingestOneFile(baseUrl, writeToken, payload, fileBuffer, file);
    if (ok) ingested++;
  }

  if (ingested > 0) return 'updated';

  // All files failed — fall back to plain JSON write
  console.warn(`[api-writer] All file downloads/ingests failed for ${payload.external_id} — falling back to plain JSON write`);
  return writeOneMessage(baseUrl, writeToken, payload);
}

export async function writeMessagesViaApi(
  payloads: Array<{ payload: ApiMessagePayload; attachmentCount: number; files?: ChatGPTFileRef[] }>
): Promise<ApiWriteResult> {
  const baseUrl = (process.env.MEMORY_DATABASE_API_URL ?? '').replace(/\/+$/, '');
  const readToken = process.env.MEMORY_DATABASE_API_TOKEN ?? '';
  const writeToken = process.env.MEMORY_DATABASE_API_WRITE_TOKEN ?? readToken;

  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let attachmentsSeen = 0;
  let attachmentsDownloaded = 0;
  let attachmentsIngested = 0;

  for (const { payload, attachmentCount, files } of payloads) {
    attachmentsSeen += attachmentCount;

    if (attachmentCount > 0 && files && files.length > 0) {
      // Track downloads/ingests separately
      let dlCount = 0;
      let ingestCount = 0;

      let ingestedAny = false;
      for (const file of files) {
        let fileBuffer: Buffer;
        try {
          fileBuffer = await downloadChatGPTFile(file.assetPointer, file.filename);
          dlCount++;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[api-writer] Failed to download ${file.filename}: ${msg}`);
          continue;
        }

        // Re-use ingestOneFile directly
        const ok = await ingestOneFile(baseUrl, writeToken, payload, fileBuffer, file);
        if (ok) { ingestCount++; ingestedAny = true; }
      }

      attachmentsDownloaded += dlCount;
      attachmentsIngested += ingestCount;

      let outcome: SingleWriteOutcome;
      if (ingestedAny) {
        outcome = 'updated';
      } else {
        console.warn(`[api-writer] All file ingests failed for ${payload.external_id} — falling back to plain JSON write`);
        outcome = await writeOneMessage(baseUrl, writeToken, payload);
      }

      if (outcome === 'inserted') inserted++;
      else if (outcome === 'updated') updated++;
      else skipped++;
    } else {
      const outcome = await writeOneMessage(baseUrl, writeToken, payload);
      if (outcome === 'inserted') inserted++;
      else if (outcome === 'updated') updated++;
      else skipped++;
    }
  }

  return { inserted, updated, skipped, attachmentsSeen, attachmentsDownloaded, attachmentsIngested };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
