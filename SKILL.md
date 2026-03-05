---
name: openclaw-chatgpt-ingestor
description: Ingest ChatGPT conversation history into the OpenClaw Memory Database via browser-based session capture and the ChatGPT web API.
---

# openclaw-chatgpt-ingestor

## Purpose

Pulls all ChatGPT conversation turns into the OpenClaw `messages` table. Uses the same API as the ChatGPT web UI, authenticated with session cookies captured via a headless Chromium browser.

## Architecture

```
/login  — Browser screencasting UI (CDP-based Chromium)
/sync   — Sync UI with manual runs + scheduler
```

## Running

```bash
# Development
npm run server

# Production (after build)
npm run build
npm start
```

Default port: **3456** (`LOGIN_SERVER_PORT` env var).

## Authentication Flow

1. Visit `/login` → click **Start Login**
2. Log in to ChatGPT in the headless browser (supports Google/Microsoft SSO)
3. Session cookies + access token captured automatically
4. Persisted to `.data/session/chatgpt-session.json`
5. Access tokens refresh automatically on expiry using stored cookies

## Sync API

### Manual sync (all conversations, last 7 days)
```bash
curl -X POST http://localhost:3456/api/sync \
  -H "Content-Type: application/json" \
  -d '{"channel":"all","sincePreset":"1w"}'
```

### Manual sync (specific conversation)
```bash
curl -X POST http://localhost:3456/api/sync \
  -H "Content-Type: application/json" \
  -d '{"channel":"<conversation-uuid>"}'
```

### Create a scheduled job (sync all, every hour)
```bash
curl -X POST http://localhost:3456/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"channel":"all","cadencePreset":"1h","sincePreset":"1h","enabled":true}'
```

## Key Environment Variables

| Variable | Description |
|---|---|
| `MEMORY_DATABASE_API_URL` | Memory Database API URL |
| `MEMORY_DATABASE_API_TOKEN` | Memory Database API token |
| `DATABASE_URL` | PostgreSQL fallback |
| `LOGIN_SERVER_PORT` | Server port (default: 3456) |
| `UI_TOKEN` | Protect /sync UI with a token |

## Data Schema

```json
{
  "source": "chatgpt",
  "sender": "gpt-4o",
  "recipient": "ET",
  "content": "...",
  "timestamp": "ISO8601",
  "external_id": "{conversationId}:{messageId}",
  "metadata": {
    "conversationId": "...",
    "conversationTitle": "...",
    "role": "assistant",
    "model": "gpt-4o"
  }
}
```

## Implementation Notes

- Uses `https://chatgpt.com/backend-api/conversations` for pagination
- Uses `https://chatgpt.com/backend-api/conversation/{id}` for full message tree
- Access token obtained from `https://chatgpt.com/api/auth/session` (fetched from within the page context using the CDP Runtime.evaluate method so cookies are automatically included)
- Conversations filtered by `update_time` when using since presets
- System messages, tool calls, and zero-weight messages are skipped
- Attachments/images noted as `[image]`, `[audio]` in content
- Idempotent upserts on `(source, external_id)`
- Scheduler uses boundary-aligned UTC timing with 10% overlap window
