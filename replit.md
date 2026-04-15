# Clicky Mobile — ElevenHacks 4 Project

## Overview

A voice-first AI assistant mobile app built for the ElevenHacks 4 hackathon using ElevenLabs and Turbopuffer. Includes an in-app Clicky overlay (SDK-style) that floats on any screen and responds to voice without leaving the current context.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL (native pg, Replit-provisioned) + Turbopuffer (vector memory)
- **Build**: esbuild (ESM bundle)

## Artifacts

### 1. Clicky Mobile (Expo React Native)
- **Path**: `artifacts/clicky-mobile/`
- **Preview**: `/` (root)
- **Key Features**:
  - Full chat screen with voice + text input
  - ElevenLabs TTS audio (two-step: text reply from `/chat`, then audio from `/tts`)
  - Floating Clicky overlay (in-app SDK style) — sparkles FAB on every screen
  - Overlay slides up from bottom, shows transcript + response, plays voice
  - Audio: `expo-av` on native, Web Audio API on web
  - File writes for TTS: `expo-file-system` caches mp3 to device

### 2. API Server (Express)
- **Path**: `artifacts/api-server/`
- **Port**: reads `PORT` env var
- **Routes**:
  - `POST /api/assistant/chat` → `{ reply, sessionId }` (JSON, stores to Postgres + Turbopuffer)
  - `POST /api/assistant/tts` → audio/mpeg stream
  - `GET  /api/assistant/sessions` → list all sessions
  - `GET  /api/assistant/sessions/:id/messages` → messages for a session
  - `POST /api/assistant/memories` → query Turbopuffer semantic memory
  - `POST /api/assistant/signed-url` → ElevenLabs Conversational AI signed URL
  - `GET  /api/assistant/agent-config` → ElevenLabs agent config

## Database Schema (PostgreSQL)

```sql
sessions (id TEXT PK, created_at, updated_at, metadata JSONB)
messages (id TEXT PK, session_id FK, role, content, created_at)
```

## Environment Variables / Secrets

| Key | Purpose |
|---|---|
| `ELEVENLABS_API_KEY` | TTS + conversational AI |
| `TURBOPUFFER_API_KEY` | Vector memory store |
| `TURBOPUFFER_REGION` | Set to `gcp-us-central1` |
| `SESSION_SECRET` | Express session signing |
| `DATABASE_URL` / `PG*` | Replit PostgreSQL (auto-provisioned) |
| `GROQ_API_KEY` | (optional) Enables LLM replies via llama-3.1-8b-instant |
| `ELEVENLABS_AGENT_ID` | (optional) ElevenLabs Conversational AI agent |
| `EXPO_PUBLIC_DOMAIN` | Set to `$REPLIT_DEV_DOMAIN` in Expo env |

## Architecture Notes

- **Text bug fix**: Chat now uses a two-step flow. `/chat` returns JSON text first (accessible in React Native). Then `/tts` fetches the audio separately. This avoids the header-inaccessibility issue with binary fetch responses on React Native.
- **Turbopuffer memory**: Uses `ns.write({ upsert_rows })` and `ns.query({ rank_by: ["vector", "ANN", ...] })` (v2 API).
- **ElevenLabs TTS**: Uses `elevenlabs.textToSpeech.convertAsStream()` (v1.59+ API).
- **ClickyOverlay**: Standalone component (own session, own state), rendered globally in `_layout.tsx` via `position: absolute`.
