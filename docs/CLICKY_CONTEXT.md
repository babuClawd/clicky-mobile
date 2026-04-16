# Clicky Context

## Product Direction

Clicky is now being positioned as a voice-first digital confidence assistant.

The near-term product is:
- a mobile assistant that can answer questions
- analyze a screenshot the user shares
- explain confusing screens in plain language
- fetch live web context for anything current, recent, or time-sensitive

The near-term product is not:
- a phone-wide Android overlay assistant
- a cross-app floating bubble like GPay
- a clone of the external Clicky SDK demo

## Why We Pivoted

The repo already has strong building blocks for voice, memory, sessions, and assistant UX.
It does not yet have the native Android overlay, accessibility, or media projection stack needed for true cross-app guidance.

For the hackathon, the strongest credible story is:
- voice-first help
- screenshot understanding
- plain-language task guidance
- live web retrieval for up-to-date answers

## Current Implementation Snapshot

### Mobile
- Expo / React Native app in `artifacts/clicky-mobile`
- voice input via `expo-av`
- assistant state in `context/AssistantContext.tsx`
- chat screen in `app/index.tsx`

### API
- Express API in `artifacts/api-server`
- ElevenLabs for STT and TTS
- PostgreSQL session history
- Turbopuffer semantic memory
- OpenAI responses for assistant generation

## New Capabilities Added In This Iteration

- assistant generation moved toward the Responses API path
- hosted web search is available when the backend supports it
- screenshot-aware requests can be sent through the main chat flow
- repo-level context and todo tracking now live in versioned docs

## Known Constraints

- Hosted web search depends on the backend OpenAI configuration supporting Responses tools.
- If the current upstream provider does not support hosted tools, the assistant falls back gracefully and still answers without live search.
- Screenshot previews are local client state today; they are not persisted as first-class database objects.
- The app still contains older in-app overlay work, but that is no longer the core product direction.

## Demo Story

Use Clicky as:
- "What is this screen asking me to do?"
- "Is this page safe?"
- "What do I tap next?"
- "What is the latest rule, price, policy, or update here?"

Payment help can still be one scenario, but it is no longer the entire identity of the product.
