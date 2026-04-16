# Clicky - Voice-First AI Assistant

Clicky is a voice-first AI assistant mobile app built for **ElevenHacks 4**. Talk to Clicky, share a screenshot when a screen is confusing, and get a short spoken answer back with memory that persists across conversations.

## Features

- **Push-to-talk voice input** - press the mic, speak, release; silence detection auto-sends after about 1.4 seconds
- **Screenshot-based screen help** - share a screenshot and ask what the screen means or what to do next
- **Live web retrieval for current info** - the assistant can use hosted web search for latest or time-sensitive answers when the backend supports it
- **Natural TTS responses** - powered by ElevenLabs, streamed as audio directly to the device
- **Long-term semantic memory** - Turbopuffer stores and retrieves relevant past context
- **Session management** - conversation history is persisted in PostgreSQL with a sessions drawer in the app
- **In-app quick access overlay** - a sparkles FAB still exists inside the app for quick assistant access
- **Warm charcoal + orange UI** - dark theme with orange and amber accents

## Tech Stack

| Layer | Technology |
|---|---|
| Mobile | Expo (React Native), Expo Router, Reanimated |
| AI Chat | OpenAI Responses / GPT-5.2 |
| TTS | ElevenLabs (`eleven_turbo_v2_5`) |
| STT | ElevenLabs Scribe (`scribe_v1`) |
| Vector Memory | Turbopuffer |
| Database | PostgreSQL (Neon / Replit built-in) |
| API Server | Express 5, Node.js, TypeScript |
| Build | EAS Build (Expo Application Services) |

## Project Structure

```text
/
|-- artifacts/
|   |-- api-server/          # Express API (chat, TTS, STT, sessions, memory)
|   `-- clicky-mobile/       # Expo React Native app
|-- docs/
|   `-- CLICKY_CONTEXT.md    # Product direction and implementation context
|-- lib/
|   |-- db/                  # Drizzle ORM schema + PostgreSQL client
|   |-- api-spec/            # OpenAPI spec (Zod)
|   `-- api-client-react/    # Auto-generated TanStack Query hooks
|-- TODO.md
`-- README.md
```

## API Routes

All routes are under `/api/assistant/`:

| Method | Path | Description |
|---|---|---|
| `POST` | `/chat` | Send a message or screenshot, get an AI reply plus live-source metadata when web search is used |
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
| `OPENAI_API_KEY` | Recommended for direct Responses API access and hosted web search |
| `AI_INTEGRATIONS_OPENAI_BASE_URL` | Optional OpenAI-compatible base URL for fallback compatibility |
| `AI_INTEGRATIONS_OPENAI_API_KEY` | Optional OpenAI-compatible API key for fallback compatibility |

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

# Build shared declaration packages once
pnpm exec tsc -p lib/api-zod/tsconfig.json
pnpm exec tsc -p lib/api-client-react/tsconfig.json

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

EAS builds on Expo's cloud servers in about 5 to 10 minutes. When done, scan the QR code or download the APK link and install it directly on your Android device.

> **Note:** The `development` and `preview` build profiles point to the Replit dev domain by default. Update `EXPO_PUBLIC_DOMAIN` in `eas.json` to your deployed API URL before building for production use.

### Deploying the API Server

The API server is configured for deployment on Replit. Click **Deploy** in the Replit workspace - it builds, hosts, and provisions TLS automatically. The deployed URL will be `https://<your-repl>.replit.app`.

Once deployed, update the `EXPO_PUBLIC_DOMAIN` in `eas.json` for the `production` profile and rebuild the app.

## Architecture Notes

- **Voice flow:** Record (`expo-av`) -> Upload to `/transcribe` -> POST to `/chat` -> POST to `/tts` -> Play MP3 (`FileSystem` + `expo-av`)
- **Screen-help flow:** Pick a screenshot in the composer -> send image data to `/chat` -> Responses API uses image input to explain the screen
- **Live-info flow:** The assistant can call hosted web search for current facts and recent changes, then surface that in the reply metadata
- **Memory flow:** Each chat call queries Turbopuffer for semantic context -> injects top results into the assistant instructions -> stores new message embeddings after the reply
- **Session flow:** `sessionId` stored in AsyncStorage -> messages fetched from PostgreSQL -> recent history is included in each assistant turn
- `expo-file-system/legacy` is used (not `expo-file-system`) for SDK 19.x compatibility with `EncodingType.Base64`

## Hackathon

Built for **ElevenHacks 4** - showcasing ElevenLabs TTS + STT as the voice layer of an AI assistant with persistent memory, screenshot help, and a native mobile experience.
