# Clicky — Voice-First AI Assistant

A voice-first AI assistant mobile app built for **ElevenHacks 4**. Talk to Clicky, and it talks back — with memory that persists across conversations.

## Features

- **Push-to-talk voice input** — press the mic, speak, release; silence detection auto-sends after ~1.4s
- **Real-time audio waveform** — animated bars reflect live microphone levels while recording
- **Natural TTS responses** — powered by ElevenLabs, streamed as audio directly to the device
- **Long-term semantic memory** — Turbopuffer vector DB stores and retrieves relevant past context
- **Session management** — full conversation history persisted in PostgreSQL; swipe-accessible sessions drawer
- **Floating Clicky overlay** — sparkles FAB accessible from any screen for quick assistant access
- **Warm charcoal + orange UI** — dark theme with orange/amber accents, smooth Reanimated transitions

## Tech Stack

| Layer | Technology |
|---|---|
| Mobile | Expo (React Native), Expo Router, Reanimated |
| AI Chat | OpenAI GPT-5.2 via Replit AI Integrations |
| TTS | ElevenLabs (`eleven_turbo_v2_5`) |
| STT | ElevenLabs Scribe (`scribe_v1`) |
| Vector Memory | Turbopuffer |
| Database | PostgreSQL (Neon / Replit built-in) |
| API Server | Express 5, Node.js, TypeScript |
| Build | EAS Build (Expo Application Services) |

## Project Structure

```
/
├── artifacts/
│   ├── api-server/          # Express API (chat, TTS, STT, sessions, memory)
│   └── clicky-mobile/       # Expo React Native app
├── lib/
│   ├── db/                  # Drizzle ORM schema + PostgreSQL client
│   ├── api-spec/            # OpenAPI spec (Zod)
│   └── api-client-react/    # Auto-generated TanStack Query hooks
└── README.md
```

## API Routes

All routes are under `/api/assistant/`:

| Method | Path | Description |
|---|---|---|
| `POST` | `/chat` | Send a message, get AI reply (with memory + history) |
| `POST` | `/tts` | Convert text to MP3 audio stream (ElevenLabs) |
| `POST` | `/transcribe` | Upload audio file, get transcript (ElevenLabs Scribe) |
| `GET` | `/sessions` | List recent chat sessions |
| `GET` | `/sessions/:id/messages` | Get messages for a session |

## Environment Variables

### API Server

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `ELEVENLABS_API_KEY` | ElevenLabs API key |
| `TURBOPUFFER_API_KEY` | Turbopuffer API key |
| `SESSION_SECRET` | Express session secret |
| `AI_INTEGRATIONS_OPENAI_BASE_URL` | Auto-set by Replit AI Integrations |
| `AI_INTEGRATIONS_OPENAI_API_KEY` | Auto-set by Replit AI Integrations |

### Mobile App

| Variable | Description |
|---|---|
| `EXPO_PUBLIC_DOMAIN` | API server domain (no `https://`, no trailing slash) |

## Getting Started

### Prerequisites

- Node.js 20+
- pnpm 9+
- Expo account (free at [expo.dev](https://expo.dev))
- EAS CLI: `npm install -g eas-cli`

### Local Development

```bash
# Install dependencies
pnpm install

# Start API server
pnpm --filter @workspace/api-server run dev

# Start Expo app (in a separate terminal)
pnpm --filter @workspace/clicky-mobile run dev
```

### Building for Device (Android APK)

```bash
cd artifacts/clicky-mobile

# Log in to your Expo account
eas login

# Register the project with EAS (first time only)
eas build:configure

# Build a standalone APK for testing
eas build --platform android --profile development
```

EAS builds on Expo's cloud servers (~5–10 min). When done, scan the QR code or download the APK link and install directly on your Android device.

> **Note:** The `development` and `preview` build profiles point to the Replit dev domain by default. Update `EXPO_PUBLIC_DOMAIN` in `eas.json` to your deployed API URL before building for production use.

### Deploying the API Server

The API server is configured for deployment on Replit. Click **Deploy** in the Replit workspace — it builds, hosts, and provisions TLS automatically. The deployed URL will be `https://<your-repl>.replit.app`.

Once deployed, update the `EXPO_PUBLIC_DOMAIN` in `eas.json` for the `production` profile and rebuild the app.

## Architecture Notes

- **Voice flow:** Record (expo-av) → Upload to `/transcribe` → POST to `/chat` → POST to `/tts` → Play MP3 (FileSystem + expo-av)
- **Memory flow:** Each chat call queries Turbopuffer for semantic context → injects top results into system prompt → stores new message embedding after reply
- **Session flow:** `sessionId` stored in AsyncStorage → messages fetched from PostgreSQL → last 12 messages passed as history to OpenAI
- `expo-file-system/legacy` is used (not `expo-file-system`) for SDK 19.x compatibility with `EncodingType.Base64`

## Hackathon

Built for **ElevenHacks 4** — showcasing ElevenLabs TTS + STT as the voice layer of an AI assistant with persistent memory and a native mobile experience.
