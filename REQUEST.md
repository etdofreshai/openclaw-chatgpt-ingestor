# REQUEST.md — openclaw-chatgpt-ingestor

## Goal
Ingest ChatGPT conversation history into the OpenClaw PostgreSQL messages database using cookie-based authentication (no official API).

## Background
OpenClaw has a messages DB with 145K+ messages spanning multiple platforms. ChatGPT conversations are missing. This ingestor fetches conversation history from ChatGPT's internal API using session cookies, normalizes it, and stores it alongside other message history.

## Auth Method
Cookie-based — user provides `__Secure-next-auth.session-token` (or equivalent) from browser DevTools. No OAuth, no official API key.

## Stack
- TypeScript, Node.js
- `node-fetch` or `axios` for HTTP
- PostgreSQL (existing OpenClaw DB)
- Connection: `DATABASE_URL` env var
- Cookie: `CHATGPT_COOKIE` env var

## ChatGPT Endpoints
- List conversations: `GET https://chatgpt.com/backend-api/conversations?offset=0&limit=100`
- Get conversation: `GET https://chatgpt.com/backend-api/conversation/{id}`

## Database Target
Insert into existing `messages` table (or create `chatgpt_conversations` staging table):
```sql
-- messages table schema (existing):
-- id, source_id, content, sender, timestamp, metadata (jsonb)
```

## Behavior
- Paginate through all conversations
- For each conversation, extract all turns (user + assistant messages)
- Store with `source = 'chatgpt'`, sender = 'user' or 'assistant'
- Skip already-imported conversations (idempotent)
- Print progress: X conversations, Y messages imported

## Notes
- Cookies expire — this is a one-shot or periodic manual run, not a daemon
- Store raw conversation JSON in metadata column for future use
- Handle rate limiting with exponential backoff
