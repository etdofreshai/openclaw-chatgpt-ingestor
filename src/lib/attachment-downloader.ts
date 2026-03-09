/**
 * attachment-downloader.ts — Download ChatGPT file attachments using cookie+token auth.
 *
 * ChatGPT stores file references as "file-service://file-XXXXXX" asset pointers.
 * To download:
 * 1. GET /backend-api/files/{file_id}/download → returns { download_url }
 * 2. Fetch the download_url (signed, no auth needed)
 */

import { getCookieString, getAccessToken } from './session.js';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Extract the file ID from an asset_pointer like "file-service://file-XXXXX"
 */
export function parseFileId(assetPointer: string): string | null {
  if (!assetPointer.startsWith('file-service://')) return null;
  const fileId = assetPointer.replace('file-service://', '').trim();
  return fileId || null;
}

/**
 * Get a signed download URL from the ChatGPT API.
 * GET /backend-api/files/{file_id}/download → { download_url }
 */
export async function getSignedDownloadUrl(fileId: string): Promise<string> {
  const cookieString = getCookieString();
  const accessToken = getAccessToken();

  const maxRetries = 3;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const headers: Record<string, string> = {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'application/json',
        'Content-Type': 'application/json',
      };
      if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
      if (cookieString) headers['Cookie'] = cookieString;

      const res = await fetch(
        `https://chatgpt.com/backend-api/files/${fileId}/download`,
        { headers }
      );

      if (res.status === 429) {
        const retryAfter = parseFloat(res.headers.get('retry-after') ?? '5');
        const waitMs = Math.ceil(retryAfter * 1000) + 500;
        console.log(`[attachment-downloader] Rate limited on file ${fileId}, waiting ${waitMs}ms`);
        await sleep(waitMs);
        continue;
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      const data = await res.json() as { download_url?: string };
      if (!data.download_url) {
        throw new Error(`No download_url in response for file ${fileId}`);
      }

      return data.download_url;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(
        `[attachment-downloader] Attempt ${attempt + 1}/${maxRetries + 1} failed for file ${fileId}: ${msg}`
      );
      if (attempt >= maxRetries) throw err;
      await sleep(1000 * Math.pow(2, attempt));
    }
  }

  throw new Error(`Failed to get signed URL for file ${fileId} after retries`);
}

/**
 * Download file bytes from a signed URL (no auth needed — URL is pre-signed).
 */
export async function downloadFile(signedUrl: string, filename: string): Promise<Buffer> {
  const maxRetries = 3;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(signedUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: '*/*',
        },
      });

      if (res.status === 429) {
        const retryAfter = parseFloat(res.headers.get('retry-after') ?? '5');
        const waitMs = Math.ceil(retryAfter * 1000) + 500;
        console.log(`[attachment-downloader] Rate limited on ${filename}, waiting ${waitMs}ms`);
        await sleep(waitMs);
        continue;
      }

      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

      const buf = Buffer.from(await res.arrayBuffer());
      console.log(`[attachment-downloader] ✓ Downloaded ${filename} (${buf.length} bytes)`);
      return buf;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(
        `[attachment-downloader] Attempt ${attempt + 1}/${maxRetries + 1} failed for ${filename}: ${msg}`
      );
      if (attempt >= maxRetries) throw err;
      await sleep(1000 * Math.pow(2, attempt));
    }
  }

  throw new Error(`Failed to download ${filename} after retries`);
}

/**
 * Convenience: parse file ID from asset pointer, get signed URL, download, return buffer.
 */
export async function downloadChatGPTFile(assetPointer: string, filename: string): Promise<Buffer> {
  const fileId = parseFileId(assetPointer);
  if (!fileId) {
    throw new Error(`Invalid asset pointer: ${assetPointer}`);
  }

  const signedUrl = await getSignedDownloadUrl(fileId);
  return downloadFile(signedUrl, filename);
}
