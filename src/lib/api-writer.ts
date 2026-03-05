/**
 * Memory Database API write module for ChatGPT messages.
 *
 * Writes normalized ChatGPT messages to the Memory Database API.
 * Enabled when both MEMORY_DATABASE_API_URL and MEMORY_DATABASE_API_TOKEN are set.
 *
 * Mode precedence:
 *   1. API mode  — MEMORY_DATABASE_API_URL + MEMORY_DATABASE_API_TOKEN both set
 *   2. PG mode   — fallback; DATABASE_URL required
 */

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

type SingleWriteOutcome = 'inserted' | 'updated' | 'skipped';

export type ApiWriteResult = {
  inserted: number;
  updated: number;
  skipped: number;
  attachmentsSeen: number;
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

export async function writeMessagesViaApi(
  payloads: Array<{ payload: ApiMessagePayload; attachmentCount: number }>
): Promise<ApiWriteResult> {
  const baseUrl = (process.env.MEMORY_DATABASE_API_URL ?? '').replace(/\/+$/, '');
  const token = process.env.MEMORY_DATABASE_API_TOKEN ?? '';

  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let attachmentsSeen = 0;

  for (const { payload, attachmentCount } of payloads) {
    attachmentsSeen += attachmentCount;
    const outcome = await writeOneMessage(baseUrl, token, payload);
    if (outcome === 'inserted') inserted++;
    else if (outcome === 'updated') updated++;
    else skipped++;
  }

  return { inserted, updated, skipped, attachmentsSeen };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
