/**
 * backfill-attachments.ts — Backfill ChatGPT file attachments for existing messages.
 *
 * Pages through messages stored in the Memory Database API, finds ones with
 * ChatGPT asset pointers, and downloads + ingests each file.
 */

import { downloadChatGPTFile } from './attachment-downloader.js';
import type { ApiMessagePayload } from './api-writer.js';

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
  errors: string[];
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
  recentItems?: Array<{ filename: string; status: 'downloaded' | 'skipped' | 'error'; assetPointer: string }>;
};

export type ProgressCallback = (progress: BackfillProgress) => void;

interface StoredMessage {
  id: number;
  record_id: string;
  source: string;
  sender: string;
  recipient: string;
  content: string;
  timestamp: string;
  external_id: string;
  metadata?: Record<string, unknown>;
}

interface PagedResponse {
  messages: StoredMessage[];
  total: number;
  page: number;
  limit: number;
  pages: number;
}

interface FileRef {
  assetPointer: string;
  filename: string;
  mimeType: string;
  sizeBytes?: number;
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
 * Extract asset pointers from a stored message's metadata.
 * Checks metadata.files, metadata.parts, metadata.content_parts.
 */
function extractFileRefs(metadata: Record<string, unknown>): FileRef[] {
  const refs: FileRef[] = [];

  // Check metadata.parts or metadata.content_parts (raw content parts stored)
  const rawParts =
    (metadata.parts as unknown[]) ??
    (metadata.content_parts as unknown[]) ??
    (metadata.files as unknown[]) ??
    [];

  if (Array.isArray(rawParts)) {
    for (const part of rawParts) {
      if (typeof part === 'object' && part !== null) {
        const p = part as Record<string, unknown>;
        const assetPointer = p.asset_pointer as string | undefined;
        const partType = (p.content_type as string) ?? '';
        if (assetPointer && assetPointer.startsWith('file-service://')) {
          refs.push({
            assetPointer,
            filename: guessFilename(partType, assetPointer),
            mimeType: guessMimeType(partType),
            sizeBytes: p.size_bytes as number | undefined,
          });
        }
      }
    }
  }

  return refs;
}

/**
 * Check if a message already has attachments in the database.
 */
async function hasExistingAttachments(
  baseUrl: string,
  token: string,
  recordId: string
): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/messages/${recordId}/attachments`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 404) return false;
    if (!res.ok) return false;
    const data = await res.json() as unknown[] | { attachments?: unknown[] };
    const list = Array.isArray(data) ? data : (data as { attachments?: unknown[] }).attachments ?? [];
    return list.length > 0;
  } catch {
    return false;
  }
}

/**
 * Ingest a file attachment via POST /api/messages/ingest (multipart).
 */
async function ingestFile(
  baseUrl: string,
  token: string,
  payload: ApiMessagePayload,
  fileBuffer: Buffer,
  filename: string,
  mimeType: string
): Promise<boolean> {
  try {
    const attachmentsMeta = [
      { original_file_name: filename, created_at_source: payload.timestamp },
    ];

    const form = new FormData();
    form.append('message', JSON.stringify(payload));
    form.append(
      'files',
      new Blob([new Uint8Array(fileBuffer)], { type: mimeType }),
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

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[backfill-attachments] Ingest failed for ${filename}: ${res.status} ${body.slice(0, 200)}`);
      return false;
    }

    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[backfill-attachments] Ingest error for ${filename}: ${msg}`);
    return false;
  }
}

/**
 * Main backfill function.
 * Pages through chatgpt messages, finds asset pointers, downloads + ingests.
 */
export async function backfillAttachments(
  options: BackfillOptions,
  progressCallback?: ProgressCallback
): Promise<BackfillStats> {
  const baseUrl = (process.env.MEMORY_DATABASE_API_URL ?? '').replace(/\/+$/, '');
  const readToken = process.env.MEMORY_DATABASE_API_TOKEN ?? '';
  const writeToken = process.env.MEMORY_DATABASE_API_WRITE_TOKEN ?? readToken;

  const runId = `backfill-${Date.now()}`;
  const startTime = new Date();

  const stats: BackfillStats = {
    messagesProcessed: 0,
    messagesWithAttachments: 0,
    totalAttachmentsFetched: 0,
    attachmentsDownloaded: 0,
    attachmentsIngested: 0,
    attachmentsSkipped: 0,
    errors: [],
  };

  const recentItems: BackfillProgress['recentItems'] = [];

  // First, get total pages
  const firstPageUrl = `${baseUrl}/api/messages?source=chatgpt&limit=100&page=1`;
  let totalPages = 1;

  try {
    const firstRes = await fetch(firstPageUrl, {
      headers: { Authorization: `Bearer ${readToken}` },
    });
    if (firstRes.ok) {
      const firstData = await firstRes.json() as PagedResponse;
      totalPages = firstData.pages ?? 1;
      if (options.limit) {
        const maxPages = Math.ceil(options.limit / 100);
        totalPages = Math.min(totalPages, maxPages + options.resumeFrom - 1);
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[backfill-attachments] Failed to fetch first page: ${msg}`);
  }

  let processedMessages = 0;

  for (let page = options.resumeFrom; page <= totalPages; page++) {
    if (options.limit && processedMessages >= options.limit) break;

    const url = `${baseUrl}/api/messages?source=chatgpt&limit=100&page=${page}`;

    let pageData: PagedResponse;
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${readToken}` },
      });
      if (!res.ok) {
        console.error(`[backfill-attachments] Failed to fetch page ${page}: ${res.status}`);
        continue;
      }
      pageData = await res.json() as PagedResponse;
      totalPages = pageData.pages ?? totalPages;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[backfill-attachments] Error fetching page ${page}: ${msg}`);
      stats.errors.push(`Page ${page}: ${msg}`);
      continue;
    }

    for (const message of pageData.messages) {
      if (options.limit && processedMessages >= options.limit) break;

      stats.messagesProcessed++;
      processedMessages++;

      const metadata = message.metadata ?? {};
      const fileRefs = extractFileRefs(metadata);

      if (fileRefs.length === 0) continue;

      stats.messagesWithAttachments++;
      stats.totalAttachmentsFetched += fileRefs.length;

      // In 'missing' mode, skip if message already has attachments
      if (options.mode === 'missing') {
        const hasAttachments = await hasExistingAttachments(baseUrl, readToken, message.record_id);
        if (hasAttachments) {
          stats.attachmentsSkipped += fileRefs.length;
          continue;
        }
      }

      if (options.dryRun) {
        console.log(`[backfill-attachments] [dry-run] Would process ${fileRefs.length} files for message ${message.external_id}`);
        stats.attachmentsSkipped += fileRefs.length;
        continue;
      }

      // Build the payload for ingestion
      const payload: ApiMessagePayload = {
        source: 'chatgpt',
        sender: message.sender,
        recipient: message.recipient,
        content: message.content,
        timestamp: message.timestamp,
        external_id: message.external_id,
        metadata: metadata,
      };

      for (const ref of fileRefs) {
        try {
          const fileBuffer = await downloadChatGPTFile(ref.assetPointer, ref.filename);
          stats.attachmentsDownloaded++;

          const ok = await ingestFile(baseUrl, writeToken, payload, fileBuffer, ref.filename, ref.mimeType);
          if (ok) {
            stats.attachmentsIngested++;
            console.log(`[backfill-attachments] ✓ Ingested ${ref.filename} for ${message.external_id}`);
            recentItems.unshift({ filename: ref.filename, status: 'downloaded', assetPointer: ref.assetPointer });
          } else {
            stats.attachmentsSkipped++;
            recentItems.unshift({ filename: ref.filename, status: 'error', assetPointer: ref.assetPointer });
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[backfill-attachments] Failed to download ${ref.filename}: ${msg}`);
          stats.errors.push(`${ref.filename}: ${msg}`);
          stats.attachmentsSkipped++;
          recentItems.unshift({ filename: ref.filename, status: 'error', assetPointer: ref.assetPointer });
        }

        // Keep recent items list bounded
        if (recentItems.length > 20) recentItems.pop();
      }
    }

    // Progress callback after each page
    if (progressCallback) {
      const elapsed = Date.now() - startTime.getTime();
      const pagesRemaining = totalPages - page;
      const timePerPage = elapsed / (page - options.resumeFrom + 1);
      const estimatedRemaining = Math.round(pagesRemaining * timePerPage);

      progressCallback({
        runId,
        page,
        totalPages,
        messagesProcessed: stats.messagesProcessed,
        downloadedCount: stats.attachmentsDownloaded,
        ingestedCount: stats.attachmentsIngested,
        skippedCount: stats.attachmentsSkipped,
        errorCount: stats.errors.length,
        lastEvent: recentItems[0]?.filename,
        startTime,
        currentTime: new Date(),
        estimatedRemaining,
        recentItems: [...recentItems],
      });
    }

    // Small delay between pages
    await new Promise(r => setTimeout(r, 200));
  }

  return stats;
}
