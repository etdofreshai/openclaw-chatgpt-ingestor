---
name: openclaw-chatgpt-ingestor
description: Ingest ChatGPT web conversations via cookie auth into OpenClaw Postgres.
---

# openclaw-chatgpt-ingestor

## Purpose
Ingest ChatGPT conversation turns into OpenClaw `messages`.

## Current status
This repo currently appears **spec/README focused** in this location.
If using the implemented version, follow that repo's scripts and env.

## Expected auth
- `CHATGPT_COOKIE` (session cookie string)

## Expected behavior
- paginate conversation list
- fetch each conversation
- normalize user/assistant turns
- idempotent upsert by stable external id

## Notes
Use this SKILL as a quick contract; verify actual commands in `package.json` of the active implementation repo.
