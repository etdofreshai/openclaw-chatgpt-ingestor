# openclaw-chatgpt-ingestor

Ingests ChatGPT conversation history into the OpenClaw Memory Database. Uses the same ChatGPT web API that the browser UI uses, authenticated via session cookies captured through a headless Chromium browser.

## Features

- **Browser-based login** — Headless Chromium via CDP with full screencasting UI at `/login`. Supports Google/Microsoft SSO (popups are redirected inline).
- **Token refresh** — Access tokens are short-lived JWTs; automatically refreshed using session cookies.
- **Full conversation sync** — Fetches the complete message tree for each conversation, extracting all user and assistant turns.
- **Sync all or specific** — Sync a single conversation by UUID or sync all conversations at once (with since-preset filtering).
- **Idempotent writes** — Upserts on `(source, external_id)` — safe to re-run.
- **Dual write modes** — Memory Database API (preferred) or direct PostgreSQL fallback.
- **Scheduler** — Boundary-aligned UTC cadence presets with a global FIFO queue.
- **Sync UI** — Full web UI at `/sync` for manual runs and scheduled job management.

## Quick Start

### 1. Configure environment

```bash
cp .env.example .env
# Edit .env — set MEMORY_DATABASE_API_URL + MEMORY_DATABASE_API_TOKEN (or DATABASE_URL)
```

### 2. Install and run (development)

```bash
npm install
npm run server
```

Server starts on port **3456** by default (`LOGIN_SERVER_PORT` env var).

### 3. Log in to ChatGPT

Open http://localhost:3456/login and click **Start Login**. A headless browser window will appear — log in to ChatGPT normally. Session is captured automatically and saved to `.data/session/chatgpt-session.json`.

### 4. Sync conversations

Open http://localhost:3456/sync to:
- Run a manual sync for a specific conversation or all conversations
- Create scheduled jobs with configurable cadence (every hour, day, etc.)

## Docker

```bash
docker build -t openclaw-chatgpt-ingestor .

docker run -d \
  --name chatgpt-ingestor \
  -p 3456:3456 \
  -v $(pwd)/.data:/app/.data \
  -e MEMORY_DATABASE_API_URL=http://your-api:3000 \
  -e MEMORY_DATABASE_API_TOKEN=your-token \
  openclaw-chatgpt-ingestor
```

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `LOGIN_SERVER_PORT` | No | `3456` | HTTP server port |
| `MEMORY_DATABASE_API_URL` | Yes* | — | Memory Database API base URL |
| `MEMORY_DATABASE_API_TOKEN` | Yes* | — | Memory Database API token |
| `DATABASE_URL` | Yes* | — | PostgreSQL connection string (fallback if API not set) |
| `UI_TOKEN` | No | — | Optional token to protect the /sync UI |
| `DATA_DIR` | No | `.data/` | Directory for job/run/session persistence |
| `PUPPETEER_EXECUTABLE_PATH` | No | `/usr/bin/chromium` | Path to Chromium binary |
| `SCHEDULER_CONCURRENCY` | No | `1` | Max concurrent sync jobs |
| `SCHEDULER_JOB_SPACING_MS` | No | `1000` | Delay between jobs (ms) |
| `SCHEDULE_SINCE_OVERLAP_PERCENT` | No | `10` | Overlap window to avoid edge misses |

*One of API mode (`MEMORY_DATABASE_API_URL` + `MEMORY_DATABASE_API_TOKEN`) or `DATABASE_URL` is required for syncing.

## API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/login` | GET | Browser login UI (screencasted headless Chromium) |
| `/sync` | GET | Sync management UI |
| `/api/health` | GET | Health + auth status |
| `/api/session/status` | GET | ChatGPT session info |
| `/api/conversations` | GET | List conversations (cached 15min) |
| `/api/sync` | POST | Trigger manual sync |
| `/api/jobs` | GET | List scheduled jobs |
| `/api/jobs` | POST | Create scheduled job |
| `/api/jobs/:id` | PATCH | Update job |
| `/api/jobs/:id` | DELETE | Delete job |
| `/api/jobs/:id/run` | POST | Run job now |
| `/api/jobs/:id/run-all` | POST | Run job with full history |
| `/api/runs` | GET | Recent run logs |
| `/api/scheduler/status` | GET | Queue status |

## Data Model

Messages are stored in the Memory Database with:

```json
{
  "source": "chatgpt",
  "sender": "gpt-4o",
  "recipient": "ET",
  "content": "Here's how to do that…",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "external_id": "{conversationId}:{messageId}",
  "metadata": {
    "conversationId": "...",
    "conversationTitle": "...",
    "messageId": "...",
    "role": "assistant",
    "model": "gpt-4o",
    "contentType": "text"
  }
}
```

- **User messages**: `sender = user name`, `recipient = "ChatGPT"`
- **Assistant messages**: `sender = model slug (e.g. "gpt-4o")`, `recipient = user name`

## How Session Capture Works

1. A headless Chromium browser opens `chatgpt.com` via CDP
2. You log in normally through the screencasted UI (Google/Microsoft SSO works — popups are intercepted and redirected inline)
3. Session cookies (`__Secure-next-auth.session-token`, `oai-did`, `oai-sc`, etc.) are captured via CDP Network events
4. The ingestor fetches `/api/auth/session` from within the page context to extract the short-lived `accessToken` (a JWT)
5. Session is persisted to `.data/session/chatgpt-session.json`
6. On subsequent API calls, the access token is refreshed automatically using the stored cookies when it expires

## Conversation Sync Details

ChatGPT conversations are stored as message trees. Each message has:
- `author.role` — `user`, `assistant`, or `system`
- `content.parts` — array of text strings and/or attachment objects
- `metadata.model_slug` — which GPT model responded
- `create_time` — Unix timestamp

The ingestor:
1. Iterates all nodes in the conversation `mapping`
2. Skips system messages, tool calls, and zero-weight (deleted) messages
3. Extracts text from `content.parts` (images/audio are noted as `[image]`, `[audio]`)
4. Sorts by `create_time`
5. Normalizes to the Memory Database message schema

## Scheduler

Jobs fire on **boundary-aligned UTC times** (not drift-based):
- `1h` → top of each hour
- `1d` → midnight UTC
- `1w` → Monday 00:00 UTC
- etc.

A 10% overlap window (configurable via `SCHEDULE_SINCE_OVERLAP_PERCENT`) ensures no messages are missed at boundaries due to clock skew.

All jobs share a global FIFO queue with configurable concurrency (default: 1).
