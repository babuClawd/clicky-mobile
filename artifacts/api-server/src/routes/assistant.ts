import { Router } from "express";
import { ElevenLabsClient } from "elevenlabs";
import { Turbopuffer } from "@turbopuffer/turbopuffer";
import type { Request, Response } from "express";
import multer from "multer";
import fs from "fs";
import { logger } from "../lib/logger";
import { upsertSession, saveMessage, getSessionMessages, getSessions } from "../lib/db";

const router = Router();

// Multer: store uploaded audio in /tmp
const upload = multer({
  dest: "/tmp/clicky-audio/",
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB max
  fileFilter: (_req, file, cb) => {
    const allowed = ["audio/mpeg", "audio/mp4", "audio/wav", "audio/webm", "audio/ogg", "audio/x-m4a", "audio/m4a", "audio/aac", "video/mp4", "application/octet-stream"];
    cb(null, allowed.includes(file.mimetype) || file.originalname.match(/\.(mp3|mp4|m4a|wav|webm|ogg|aac|3gp)$/i) !== null);
  },
});

const elevenlabs = new ElevenLabsClient({
  apiKey: process.env["ELEVENLABS_API_KEY"],
});

const tpuf = new Turbopuffer({
  apiKey: process.env["TURBOPUFFER_API_KEY"] ?? "",
  region: process.env["TURBOPUFFER_REGION"] ?? "gcp-us-central1",
});

const NAMESPACE = "clicky-memories";
const VOICE_ID = "JBFqnCBsd6RMkjVDRZzb";

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

// Simple 128-dim bag-of-words embedding (no external API needed)
function simpleEmbedding(text: string): number[] {
  const dims = 128;
  const vec: number[] = new Array(dims).fill(0);
  const words = text.toLowerCase().split(/\s+/);
  for (const word of words) {
    const h = word.split("").reduce((a, c) => ((a << 5) - a + c.charCodeAt(0)) & 0x7fffffff, 0);
    for (let i = 0; i < word.length; i++) {
      vec[(word.charCodeAt(i) * (i + 1) * 31) % dims]! += 1;
    }
    vec[h % dims]! += 2;
  }
  const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return mag === 0 ? vec : vec.map((v) => v / mag);
}

async function storeMemory(sessionId: string, role: string, text: string): Promise<void> {
  try {
    const ns = tpuf.namespace(NAMESPACE);
    const id = `${sessionId}-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
    await ns.write({
      upsert_rows: [{ id, vector: simpleEmbedding(text), text, role, sessionId, timestamp: new Date().toISOString() }],
      distance_metric: "cosine_distance",
    });
  } catch (err) {
    logger.warn({ err }, "Failed to store memory in turbopuffer");
  }
}

async function retrieveMemories(query: string, sessionId: string, topK = 5): Promise<string[]> {
  try {
    const ns = tpuf.namespace(NAMESPACE);
    const results = await ns.query({
      rank_by: ["vector", "ANN", simpleEmbedding(query)],
      top_k: topK,
      distance_metric: "cosine_distance",
      filters: ["sessionId", "Eq", sessionId],
      include_attributes: ["text", "role"],
    });
    const rows = (results as { rows?: Array<{ $dist?: number; text?: string; role?: string }> }).rows ?? [];
    return rows.filter((r) => (r.$dist ?? 1) < 0.85).map((r) => `[${r.role}]: ${r.text}`);
  } catch (err) {
    const msg = String(err);
    if (msg.includes("not found") || msg.includes("404")) return [];
    logger.warn({ err }, "Failed to retrieve memories");
    return [];
  }
}

async function generateReply(message: string, memoryContext: string): Promise<string> {
  const systemPrompt = `You are Clicky, a smart personal voice AI assistant. Be concise — max 2 short sentences for voice. Friendly and direct.${memoryContext ? "\n\nRelevant past context:\n" + memoryContext : ""}`;
  const groqKey = process.env["GROQ_API_KEY"] ?? "";
  if (groqKey) {
    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${groqKey}` },
        body: JSON.stringify({
          model: "llama-3.1-8b-instant",
          messages: [{ role: "system", content: systemPrompt }, { role: "user", content: message }],
          max_tokens: 150,
          temperature: 0.7,
        }),
      });
      if (res.ok) {
        const data = await res.json() as { choices: Array<{ message: { content: string } }> };
        const reply = data.choices[0]?.message?.content?.trim();
        if (reply) return reply;
      }
    } catch (err) {
      logger.warn({ err }, "Groq failed, using fallback");
    }
  }
  return generateFallbackReply(message);
}

function generateFallbackReply(message: string): string {
  const msg = message.toLowerCase().trim();
  if (/^(hello|hi|hey|sup|yo)\b/.test(msg)) return "Hey! I'm Clicky, your personal AI assistant. What can I help you with?";
  if (/how are you|how.s it going/.test(msg)) return "All good and ready to help! What's on your mind?";
  if (/your name|who are you/.test(msg)) return "I'm Clicky — your AI assistant powered by ElevenLabs and Turbopuffer. Nice to meet you!";
  if (/what time/.test(msg)) return `It's ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`;
  if (/what.s the date|what day/.test(msg)) return `Today is ${new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}.`;
  if (/weather/.test(msg)) return "I can't check real-time weather yet, but your phone's weather app has you covered!";
  if (/thank/.test(msg)) return "You're welcome! Anything else I can help with?";
  if (/help|what can you do/.test(msg)) return "I can answer questions, remember our conversations, and speak to you via ElevenLabs. Just ask!";
  const fallbacks = [
    "That's a great question! I'm still learning, but I'm here to help however I can.",
    "Interesting! Tell me more and I'll do my best to assist you.",
    "Got it. I'm always getting smarter — what else can I do for you?",
  ];
  return fallbacks[Math.floor(Math.random() * fallbacks.length)]!;
}

// ─── Session routes ────────────────────────────────────────────────────────────

// GET /api/assistant/sessions
router.get("/sessions", async (_req: Request, res: Response) => {
  try {
    const sessions = await getSessions();
    res.json({ sessions });
  } catch (err) {
    logger.error({ err }, "Failed to get sessions");
    res.status(500).json({ error: "Failed to get sessions" });
  }
});

// GET /api/assistant/sessions/:sessionId/messages
router.get("/sessions/:sessionId/messages", async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params as { sessionId: string };
    const messages = await getSessionMessages(sessionId);
    res.json({ messages: messages.reverse() });
  } catch (err) {
    logger.error({ err }, "Failed to get messages");
    res.status(500).json({ error: "Failed to get messages" });
  }
});

// ─── Main chat (text-only response) ───────────────────────────────────────────

// POST /api/assistant/chat — returns JSON { reply, sessionId }
router.post("/chat", async (req: Request, res: Response) => {
  try {
    const { message, sessionId } = req.body as { message?: string; sessionId?: string };
    if (!message || !sessionId) {
      res.status(400).json({ error: "message and sessionId are required" });
      return;
    }

    // Ensure session exists in DB
    await upsertSession(sessionId);

    // Retrieve memories + save user message in parallel
    const [memories] = await Promise.all([
      retrieveMemories(message, sessionId),
      saveMessage(generateId(), sessionId, "user", message),
      storeMemory(sessionId, "user", message),
    ]);

    const reply = await generateReply(message, memories.join("\n"));

    // Save assistant reply (fire and forget)
    void saveMessage(generateId(), sessionId, "assistant", reply);
    void storeMemory(sessionId, "assistant", reply);

    logger.info({ sessionId, chars: reply.length }, "Chat reply generated");
    res.json({ reply, sessionId });
  } catch (err) {
    logger.error({ err }, "Chat error");
    res.status(500).json({ error: "Failed to process message" });
  }
});

// ─── TTS — streams audio for a given text ─────────────────────────────────────

// POST /api/assistant/tts
router.post("/tts", async (req: Request, res: Response) => {
  try {
    const { text, voiceId } = req.body as { text?: string; voiceId?: string };
    if (!text) {
      res.status(400).json({ error: "text is required" });
      return;
    }

    const stream = await elevenlabs.textToSpeech.convertAsStream(voiceId ?? VOICE_ID, {
      text,
      model_id: "eleven_turbo_v2_5",
      output_format: "mp3_44100_128",
      voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true },
    });

    res.setHeader("Content-Type", "audio/mpeg");
    for await (const chunk of stream) {
      res.write(chunk);
    }
    res.end();
  } catch (err) {
    logger.error({ err }, "TTS error");
    if (!res.headersSent) res.status(500).json({ error: "TTS failed" });
  }
});

// ─── Transcribe — ElevenLabs STT from uploaded audio file ────────────────────

// POST /api/assistant/transcribe  (multipart: field name = "audio")
router.post("/transcribe", upload.single("audio"), async (req: Request, res: Response) => {
  const file = (req as unknown as { file?: Express.Multer.File }).file;
  if (!file) {
    res.status(400).json({ error: "No audio file uploaded (field name must be 'audio')" });
    return;
  }

  try {
    const stream = fs.createReadStream(file.path);
    const result = await elevenlabs.speechToText.convert({
      file: stream,
      model_id: "scribe_v1",
      language_code: "en",
    });

    // Clean up temp file
    fs.unlink(file.path, () => {});

    const transcript = result.text?.trim() ?? "";
    logger.info({ chars: transcript.length }, "ElevenLabs STT transcription done");
    res.json({ transcript });
  } catch (err) {
    fs.unlink(file.path, () => {});
    logger.error({ err }, "Transcription failed");
    res.status(500).json({ error: "Transcription failed" });
  }
});

// ─── Signed URL for ElevenLabs Conversational AI ──────────────────────────────

router.get("/agent-config", (_req: Request, res: Response) => {
  res.json({ agentId: process.env["ELEVENLABS_AGENT_ID"] ?? "", hasAgentId: !!process.env["ELEVENLABS_AGENT_ID"] });
});

router.post("/signed-url", async (req: Request, res: Response) => {
  try {
    const agentId = (req.body as { agentId?: string }).agentId ?? process.env["ELEVENLABS_AGENT_ID"] ?? "";
    if (!agentId) {
      res.status(400).json({ error: "No ElevenLabs agent ID configured." });
      return;
    }
    const result = await elevenlabs.conversationalAi.getSignedUrl({ agent_id: agentId });
    res.json({ signedUrl: result.signed_url });
  } catch (err) {
    logger.error({ err }, "Failed to get signed URL");
    res.status(500).json({ error: "Failed to get signed URL" });
  }
});

// ─── Memory query ──────────────────────────────────────────────────────────────

router.post("/memories", async (req: Request, res: Response) => {
  try {
    const { query, sessionId } = req.body as { query?: string; sessionId?: string };
    if (!query || !sessionId) {
      res.status(400).json({ error: "query and sessionId are required" });
      return;
    }
    const memories = await retrieveMemories(query, sessionId);
    res.json({ memories });
  } catch (err) {
    logger.error({ err }, "Memory retrieval error");
    res.status(500).json({ error: "Memory retrieval failed" });
  }
});

export default router;
