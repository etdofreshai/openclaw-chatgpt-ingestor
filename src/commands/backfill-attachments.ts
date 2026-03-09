/**
 * ChatGPT attachment backfill command.
 *
 * Fetches messages from the Memory DB, finds image/audio attachments,
 * downloads them via ChatGPT's signed URL endpoint, and ingests them.
 */
import 'dotenv/config';
import { randomUUID } from 'crypto';
import {
  hasSession,
  getAccessToken,
  getCookieString,
} from '../lib/session.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export type BackfillMode = 'missing' | 'force';

export type BackfillOptions = {
  batchSize: number;
  limit?: number;
  dryRun: boolean;
  resumeFrom: number;
  mode: BackfillMode;
};

export type BackfillStats = {
  messagesProcessed: number;
  messagesWithAttachments: number;
  totalAttachmentsFetched: number;
  attachmentsDownloaded: number;
  attachmentsIngested: number;
  attachmentsSkipped: number;
  errors: Array<{ message: string; fileId?: string; messageId?: string }>;
};

export type BackfillProgress = {
  runId: string;
  page: number;
  totalPages: number;
  messagesProcessed: number;
  downloadedCount: number;
  ingestedCount: number;
  skippedCount: number;
  errorCount: number;
  lastEvent?: string;
  startTime: Date;
  currentTime: Date;
  estimatedRemaining?: number;
  recentItems?: Array<{
    filename: string;
    status: 'downloaded' | 'ingested' | 'skipped' | 'error';
    messageId: string;
  }>;
};

export type ProgressCallback = (progress: BackfillProgress) => void;

// ── Helpers ────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const DEFAULT_UA =
  process.env.CHROME_USER_AGENT ??
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

/**
 * Fetch a page of ChatGPT messages from the Memory DB.
 */
async function fetchChatGPTMessages(
  apiUrl: string,
  token: string,
  page: number,
  limit = 100
): Promise<{
  messages: Array<{
    id: string;
    external_id: string;
    sender: string;
    recipient: string;
    content: string;
    timestamp: string;
    metadata: Record<string, unknown>;
    record_id: string;
  }>;
  total: number;
  totalPages: number;
}> {
  const url = `${apiUrl}/api/messages?source=chatgpt&limit=${limit}&page=${page}`;

  for (let attempt = 0; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (res.status === 429) {
        const retryAfter = parseFloat(res.headers.get('retry-after') ?? '5');
        await sleep(Math.ceil(retryAfter * 1000) + 500);
        continue;
      }

      if (!res.ok) {
        throw new Error(`Memory DB API returned ${res.status}: ${res.statusText}`);
      }

      const data = (await res.json()) as {
        messages?: unknown[];
        total?: number;
        totalPages?: number;
      };
      return {
        messages: (data.messages ?? []) as any[],
        total: data.total ?? 0,
        totalPages: data.totalPages ?? 1,
      };
    } catch (err) {
      if (attempt >= 3) throw err;
      await sleep(1000 * Math.pow(2, attempt));
    }
  }

  throw new Error(`Failed to fetch page ${page} after retries`);
}

/**
 * Check whether a message already has attachments linked in the DB.
 * Returns true if it does (i.e. should be skipped in 'missing' mode).
 */
async function messageHasAttachments(
  apiUrl: string,
  token: string,
  recordId: string
): Promise<boolean> {
  try {
    const res = await fetch(`${apiUrl}/api/messages/${recordId}/attachments`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return false; // 404 or other → assume no attachments
    const data = (await res.json()) as { attachments?: unknown[] };
    return Array.isArray(data.attachments) && data.attachments.length > 0;
  } catch {
    return false;
  }
}

/**
 * Get a signed download URL from ChatGPT for a given file ID.
 */
async function getSignedDownloadUrl(fileId: string): Promise<string> {
  const token = getAccessToken();
  const cookies = getCookieString();

  if (!token) throw new Error('No ChatGPT access token available');

  const url = `https://chatgpt.com/backend-api/files/${fileId}/download`;

  for (let attempt = 0; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Cookie: cookies,
          'User-Agent': DEFAULT_UA,
          Accept: 'application/json',
          Referer: 'https://chatgpt.com/',
          Origin: 'https://chatgpt.com',
        },
      });

      if (res.status === 429) {
        const retryAfter = parseFloat(res.headers.get('retry-after') ?? '5');
        await sleep(Math.ceil(retryAfter * 1000) + 500);
        continue;
      }

      if (!res.ok) {
        throw new Error(`ChatGPT files API returned ${res.status}: ${res.statusText}`);
      }

      const data = (await res.json()) as { download_url?: string };
      if (!data.download_url) throw new Error('No download_url in response');
      return data.download_url;
    } catch (err) {
      if (attempt >= 3) throw err;
      await sleep(1000 * Math.pow(2, attempt));
    }
  }

  throw new Error(`Failed to get signed URL for ${fileId} after retries`);
}

/**
 * Download a file from a signed URL.
 */
async function downloadFile(signedUrl: string, filename: string): Promise<Buffer> {
  for (let attempt = 0; attempt <= 3; attempt++) {
    try {
      const res = await fetch(signedUrl, {
        headers: {
          'User-Agent': DEFAULT_UA,
          Accept: '*/*',
        },
      });

      if (res.status === 429) {
        const retryAfter = parseFloat(res.headers.get('retry-after') ?? '5');
        await sleep(Math.ceil(retryAfter * 1000) + 500);
        continue;
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      const arrayBuffer = await res.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      console.log(`[backfill-download] ✓ Downloaded ${filename} (${buffer.length} bytes)`);
      return buffer;
    } catch (err: any) {
      if (attempt >= 3) throw err;
      await sleep(1000 * Math.pow(2, attempt));
    }
  }

  throw new Error(`Failed to download ${filename} after retries`);
}

/**
 * Ingest an attachment into the Memory DB via multipart form.
 */
async function ingestAttachment(
  apiUrl: string,
  writeToken: string,
  message: {
    id: string;
    external_id: string;
    sender: string;
    recipient: string;
    content: string;
    timestamp: string;
    metadata: Record<string, unknown>;
    record_id: string;
  },
  fileBuffer: Buffer,
  fileMeta: {
    filename: string;
    contentType: string;
    fileId: string;
  }
): Promise<void> {
  const messagePayload = {
    source: 'chatgpt',
    sender: message.sender,
    recipient: message.recipient,
    content: message.content,
    timestamp: message.timestamp,
    external_id: message.external_id,
    metadata: message.metadata,
  };

  const attachmentsMeta = [
    {
      original_file_name: fileMeta.filename,
    },
  ];

  for (let attempt = 0; attempt <= 3; attempt++) {
    try {
      const form = new FormData();
      form.append('message', JSON.stringify(messagePayload));
      form.append(
        'files',
        new Blob([new Uint8Array(fileBuffer)], { type: fileMeta.contentType }),
        fileMeta.filename
      );
      form.append('attachments_meta', JSON.stringify(attachmentsMeta));

      const res = await fetch(`${apiUrl}/api/messages/ingest`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${writeToken}` },
        body: form,
      });

      if (res.status === 429) {
        const retryAfter = parseFloat(res.headers.get('retry-after') ?? '5');
        await sleep(Math.ceil(retryAfter * 1000) + 500);
        continue;
      }

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Ingest API returned ${res.status}: ${body.slice(0, 300)}`);
      }

      console.log(`[backfill-ingest] ✓ Ingested ${fileMeta.filename} for message ${message.external_id}`);
      return;
    } catch (err) {
      if (attempt >= 3) throw err;
      await sleep(1000 * Math.pow(2, attempt));
    }
  }

  throw new Error('Failed to ingest attachment after retries');
}

// ── Attachment extraction ──────────────────────────────────────────────────────

interface AttachmentPart {
  fileId: string;
  contentType: string;
  filename: string;
  sizeBytes?: number;
}

/**
 * Walk a ChatGPT message's metadata to find all attachment parts.
 * metadata structure: { messages: [ { content: { parts: [...] } } ] }
 */
function extractAttachmentParts(metadata: Record<string, unknown>): AttachmentPart[] {
  const parts: AttachmentPart[] = [];

  const messages = (metadata as any)?.messages;
  if (!Array.isArray(messages)) return parts;

  for (const msg of messages) {
    const contentParts = (msg as any)?.content?.parts;
    if (!Array.isArray(contentParts)) continue;

    for (const part of contentParts) {
      if (typeof part !== 'object' || part === null) continue;

      const contentType = (part as any).content_type as string | undefined;
      if (!contentType) continue;

      if (
        contentType === 'image_asset_pointer' ||
        contentType === 'audio_asset_pointer'
      ) {
        const assetPointer = (part as any).asset_pointer as string | undefined;
        if (!assetPointer) continue;

        // Extract file-XXXXXX from "file-service://file-XXXXXX"
        const fileId = assetPointer.replace(/^file-service:\/\//, '');
        if (!fileId) continue;

        // Determine filename and mime type
        const isAudio = contentType === 'audio_asset_pointer';
        const filename = isAudio ? `${fileId}.mp4` : `${fileId}.png`;
        const mimeType = isAudio ? 'audio/mp4' : 'image/png';

        parts.push({
          fileId,
          contentType: mimeType,
          filename,
          sizeBytes: (part as any).size_bytes as number | undefined,
        });
      } else if (contentType === 'multimodal_text') {
        // Recurse into nested parts
        const nestedParts = (part as any).parts;
        if (Array.isArray(nestedParts)) {
          for (const nested of nestedParts) {
            if (typeof nested !== 'object' || nested === null) continue;
            const nestedType = (nested as any).content_type as string | undefined;
            if (nestedType === 'image_asset_pointer' || nestedType === 'audio_asset_pointer') {
              const assetPointer = (nested as any).asset_pointer as string | undefined;
              if (!assetPointer) continue;
              const fileId = assetPointer.replace(/^file-service:\/\//, '');
              if (!fileId) continue;
              const isAudio = nestedType === 'audio_asset_pointer';
              parts.push({
                fileId,
                contentType: isAudio ? 'audio/mp4' : 'image/png',
                filename: isAudio ? `${fileId}.mp4` : `${fileId}.png`,
                sizeBytes: (nested as any).size_bytes as number | undefined,
              });
            }
          }
        }
      }
    }
  }

  return parts;
}

// ── Main export ────────────────────────────────────────────────────────────────

export async function backfillAttachments(
  options: BackfillOptions,
  progressCallback?: ProgressCallback
): Promise<BackfillStats> {
  const apiUrl = (process.env.MEMORY_DATABASE_API_URL ?? '').replace(/\/+$/, '');
  const readToken = process.env.MEMORY_DATABASE_API_TOKEN ?? '';
  const writeToken = process.env.MEMORY_DATABASE_API_WRITE_TOKEN ?? readToken;

  if (!apiUrl || !readToken) {
    throw new Error(
      'Missing env vars: MEMORY_DATABASE_API_URL and MEMORY_DATABASE_API_TOKEN are required'
    );
  }

  if (!hasSession()) {
    throw new Error('No ChatGPT session available. Please log in via /login first.');
  }

  const stats: BackfillStats = {
    messagesProcessed: 0,
    messagesWithAttachments: 0,
    totalAttachmentsFetched: 0,
    attachmentsDownloaded: 0,
    attachmentsIngested: 0,
    attachmentsSkipped: 0,
    errors: [],
  };

  const runId = randomUUID();
  const startPage = options.resumeFrom ?? 1;
  const startTime = new Date();
  const recentItems: Array<{
    filename: string;
    status: 'downloaded' | 'ingested' | 'skipped' | 'error';
    messageId: string;
  }> = [];

  function addRecentItem(item: typeof recentItems[number]): void {
    recentItems.unshift(item);
    if (recentItems.length > 10) recentItems.pop();
  }

  // Fetch first page to get totalPages
  const firstPage = await fetchChatGPTMessages(apiUrl, readToken, 1, 100);
  const totalPages = firstPage.totalPages;
  const maxMessages = options.limit ?? firstPage.total;

  let messagesProcessedTotal = 0;

  for (let page = startPage; page <= totalPages && messagesProcessedTotal < maxMessages; page++) {
    const pageData =
      page === 1 ? firstPage : await fetchChatGPTMessages(apiUrl, readToken, page, 100);

    for (const message of pageData.messages) {
      if (messagesProcessedTotal >= maxMessages) break;

      stats.messagesProcessed++;
      messagesProcessedTotal++;

      // Extract attachment parts from message metadata
      const attachmentParts = extractAttachmentParts(message.metadata);
      if (attachmentParts.length === 0) continue;

      // In 'missing' mode, skip messages that already have attachments
      if (options.mode === 'missing') {
        const alreadyHas = await messageHasAttachments(apiUrl, readToken, message.record_id);
        if (alreadyHas) {
          stats.attachmentsSkipped += attachmentParts.length;
          addRecentItem({
            filename: attachmentParts[0].filename,
            status: 'skipped',
            messageId: message.external_id,
          });
          continue;
        }
      }

      stats.messagesWithAttachments++;
      stats.totalAttachmentsFetched += attachmentParts.length;

      // Process in batches
      for (let i = 0; i < attachmentParts.length; i += options.batchSize) {
        const batch = attachmentParts.slice(i, i + options.batchSize);

        await Promise.all(
          batch.map(async (att) => {
            try {
              // Get signed download URL from ChatGPT
              const signedUrl = await getSignedDownloadUrl(att.fileId);

              // Download the file
              const fileBuffer = await downloadFile(signedUrl, att.filename);
              stats.attachmentsDownloaded++;
              addRecentItem({ filename: att.filename, status: 'downloaded', messageId: message.external_id });

              if (options.dryRun) {
                stats.attachmentsSkipped++;
                return;
              }

              // Ingest into Memory DB
              await ingestAttachment(apiUrl, writeToken, message, fileBuffer, {
                filename: att.filename,
                contentType: att.contentType,
                fileId: att.fileId,
              });
              stats.attachmentsIngested++;
              addRecentItem({ filename: att.filename, status: 'ingested', messageId: message.external_id });
            } catch (err: any) {
              const errorMsg = String(err?.message ?? 'Unknown error');
              console.error(
                `[backfill] Error processing ${att.fileId} (message ${message.external_id}): ${errorMsg}`
              );
              stats.attachmentsSkipped++;
              stats.errors.push({
                message: errorMsg,
                fileId: att.fileId,
                messageId: message.external_id,
              });
              addRecentItem({ filename: att.filename, status: 'error', messageId: message.external_id });
            }
          })
        );
      }
    }

    // Emit progress after each page
    const now = new Date();
    const elapsed = now.getTime() - startTime.getTime();
    const pagesPerMs = (page - startPage + 1) / elapsed;
    const remainingPages = totalPages - page;
    const estimatedRemaining = remainingPages > 0 ? remainingPages / pagesPerMs : 0;

    if (progressCallback) {
      progressCallback({
        runId,
        page,
        totalPages,
        messagesProcessed: stats.messagesProcessed,
        downloadedCount: stats.attachmentsDownloaded,
        ingestedCount: stats.attachmentsIngested,
        skippedCount: stats.attachmentsSkipped,
        errorCount: stats.errors.length,
        lastEvent: `Page ${page}/${totalPages}: ${stats.attachmentsDownloaded} downloaded, ${stats.attachmentsIngested} ingested`,
        startTime,
        currentTime: now,
        estimatedRemaining,
        recentItems: [...recentItems],
      });
    }
  }

  return stats;
}

// ── CLI entry point ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const opts: BackfillOptions = {
    batchSize: 5,
    dryRun: false,
    resumeFrom: 1,
    mode: 'missing',
  };

  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === '--limit') opts.limit = parseInt(process.argv[++i] ?? '0', 10);
    else if (a === '--batch-size') opts.batchSize = parseInt(process.argv[++i] ?? '5', 10);
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--resume-from') opts.resumeFrom = parseInt(process.argv[++i] ?? '1', 10);
    else if (a === '--force') opts.mode = 'force';
  }

  try {
    const stats = await backfillAttachments(opts, (progress) => {
      console.log(
        `[backfill] Page ${progress.page}/${progress.totalPages}: ` +
        `${progress.downloadedCount} downloaded, ${progress.ingestedCount} ingested, ` +
        `${progress.skippedCount} skipped, ${progress.errorCount} errors`
      );
    });

    console.log('\n[backfill] Complete!');
    console.log(JSON.stringify(stats, null, 2));
    if (stats.errors.length > 0) process.exit(1);
  } catch (err: any) {
    console.error('[backfill] Fatal error:', err.message);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
