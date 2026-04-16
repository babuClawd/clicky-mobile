import { Router } from "express";
import { ElevenLabsClient } from "elevenlabs";
import { Turbopuffer } from "@turbopuffer/turbopuffer";
import type { Request, Response } from "express";
import multer from "multer";
import fs from "fs";
import OpenAI from "openai";
import { logger } from "../lib/logger";
import { upsertSession, saveMessage, getSessionMessages, getSessions } from "../lib/db";

const router = Router();

const DEFAULT_SCREENSHOT_PROMPT = "Help me understand this screen and what to do next.";
const NAMESPACE = "clicky-memories";
const VOICE_ID = "JBFqnCBsd6RMkjVDRZzb";
const OPENAI_MODEL = "gpt-5.2";

type AssistantHistoryItem = {
  role: string;
  content: string;
};

type AssistantRequestContext = {
  city?: string;
  country?: string;
  region?: string;
  timezone?: string;
};

type AssistantSource = {
  host: string;
  url: string;
};

type AssistantReplyPayload = {
  reply: string;
  sources: AssistantSource[];
  usedWebSearch: boolean;
};

type GenerateReplyOptions = {
  history: AssistantHistoryItem[];
  imageDataUrl?: string;
  memoryContext: string;
  message: string;
  requestContext?: AssistantRequestContext;
};

const audioUpload = multer({
  dest: "/tmp/clicky-audio/",
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      "audio/mpeg",
      "audio/mp4",
      "audio/wav",
      "audio/webm",
      "audio/ogg",
      "audio/x-m4a",
      "audio/m4a",
      "audio/aac",
      "video/mp4",
      "application/octet-stream",
    ];
    cb(
      null,
      allowed.includes(file.mimetype) ||
        file.originalname.match(/\.(mp3|mp4|m4a|wav|webm|ogg|aac|3gp)$/i) !== null,
    );
  },
});

const elevenlabs = new ElevenLabsClient({
  apiKey: process.env["ELEVENLABS_API_KEY"],
});

const tpuf = new Turbopuffer({
  apiKey: process.env["TURBOPUFFER_API_KEY"] ?? "",
  region: process.env["TURBOPUFFER_REGION"] ?? "gcp-us-central1",
});

const openai = new OpenAI({
  apiKey:
    process.env["OPENAI_API_KEY"] ??
    process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] ??
    "",
  ...(process.env["OPENAI_API_KEY"]
    ? {}
    : {
        baseURL: process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"],
      }),
});

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

function simpleEmbedding(text: string): number[] {
  const dims = 128;
  const vec: number[] = new Array(dims).fill(0);
  const words = text.toLowerCase().split(/\s+/);
  for (const word of words) {
    const hash = word
      .split("")
      .reduce((acc, char) => ((acc << 5) - acc + char.charCodeAt(0)) & 0x7fffffff, 0);
    for (let index = 0; index < word.length; index += 1) {
      vec[(word.charCodeAt(index) * (index + 1) * 31) % dims] += 1;
    }
    vec[hash % dims] += 2;
  }
  const magnitude = Math.sqrt(vec.reduce((sum, value) => sum + value * value, 0));
  return magnitude === 0 ? vec : vec.map((value) => value / magnitude);
}

async function storeMemory(sessionId: string, role: string, text: string): Promise<void> {
  try {
    const namespace = tpuf.namespace(NAMESPACE);
    const id = `${sessionId}-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
    await namespace.write({
      upsert_rows: [
        {
          id,
          vector: simpleEmbedding(text),
          text,
          role,
          sessionId,
          timestamp: new Date().toISOString(),
        },
      ],
      distance_metric: "cosine_distance",
    });
  } catch (error) {
    logger.warn({ err: error }, "Failed to store memory in Turbopuffer");
  }
}

async function retrieveMemories(query: string, sessionId: string, topK = 5): Promise<string[]> {
  try {
    const namespace = tpuf.namespace(NAMESPACE);
    const results = await namespace.query({
      rank_by: ["vector", "ANN", simpleEmbedding(query)],
      top_k: topK,
      distance_metric: "cosine_distance",
      filters: ["sessionId", "Eq", sessionId],
      include_attributes: ["text", "role"],
    });
    const rows =
      (results as { rows?: Array<{ $dist?: number; role?: string; text?: string }> }).rows ??
      [];
    return rows
      .filter((row) => (row.$dist ?? 1) < 0.85)
      .map((row) => `[${row.role}]: ${row.text}`);
  } catch (error) {
    const message = String(error);
    if (message.includes("not found") || message.includes("404")) {
      return [];
    }
    logger.warn({ err: error }, "Failed to retrieve memories");
    return [];
  }
}

function formatToday(requestContext?: AssistantRequestContext): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      ...(requestContext?.timezone ? { timeZone: requestContext.timezone } : {}),
    }).format(new Date());
  } catch {
    return new Date().toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  }
}

function buildHistoryTranscript(history: AssistantHistoryItem[]): string {
  if (history.length === 0) {
    return "";
  }

  return history
    .slice(-10)
    .map((entry) => {
      const speaker =
        entry.role === "assistant"
          ? "Clicky"
          : entry.role === "system"
            ? "System"
            : "User";
      return `${speaker}: ${entry.content}`;
    })
    .join("\n");
}

function buildInstructions(
  memoryContext: string,
  requestContext?: AssistantRequestContext,
  hasImage = false,
): string {
  return [
    "You are Clicky, a voice-first AI assistant that helps people understand digital tasks, confusing screens, and real-world questions.",
    "Reply in plain language and keep spoken answers concise. Prefer 1 to 3 short sentences unless the user clearly needs a few next steps.",
    hasImage
      ? "When the user shares a screenshot, first explain what the screen seems to be asking them to do, then give the next 2 to 4 concrete steps. Call out anything risky, surprising, or easy to miss."
      : "",
    "Whenever the question depends on current facts, recent events, product availability, prices, policies, releases, or anything marked latest/current/today, use live web search before answering.",
    "Do not claim you checked the web unless you actually used web results.",
    `Today is ${formatToday(requestContext)}.`,
    memoryContext ? `Relevant memories from past conversations:\n${memoryContext}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildInput(
  message: string,
  history: AssistantHistoryItem[],
  imageDataUrl?: string,
): Array<{
  content: Array<
    | { text: string; type: "input_text" }
    | { detail: "high"; image_url: string; type: "input_image" }
  >;
  role: "user";
}> {
  const historyTranscript = buildHistoryTranscript(history);
  const promptParts = [
    historyTranscript ? `Recent conversation:\n${historyTranscript}` : "",
    imageDataUrl
      ? "The user attached a screenshot with this request. Use the image to understand the screen before you answer."
      : "",
    `User request: ${message}`,
  ].filter(Boolean);

  return [
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text: promptParts.join("\n\n"),
        },
        ...(imageDataUrl
          ? [
              {
                type: "input_image" as const,
                image_url: imageDataUrl,
                detail: "high" as const,
              },
            ]
          : []),
      ],
    },
  ];
}

function approximateLocation(
  requestContext?: AssistantRequestContext,
): OpenAI.Responses.WebSearchPreviewTool.UserLocation | undefined {
  if (
    !requestContext?.city &&
    !requestContext?.country &&
    !requestContext?.region &&
    !requestContext?.timezone
  ) {
    return undefined;
  }

  return {
    type: "approximate",
    ...(requestContext.city ? { city: requestContext.city } : {}),
    ...(requestContext.country ? { country: requestContext.country } : {}),
    ...(requestContext.region ? { region: requestContext.region } : {}),
    ...(requestContext.timezone ? { timezone: requestContext.timezone } : {}),
  };
}

function safeHost(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function extractWebSources(response: { output?: unknown[] }): AssistantSource[] {
  if (!Array.isArray(response.output)) {
    return [];
  }

  const seen = new Set<string>();
  for (const item of response.output) {
    const webSearchCall = item as {
      action?: {
        sources?: Array<{ type?: string; url?: string }>;
        type?: string;
        url?: string | null;
      };
      type?: string;
    };

    if (webSearchCall.type !== "web_search_call" || !webSearchCall.action) {
      continue;
    }

    if (
      webSearchCall.action.type === "search" &&
      Array.isArray(webSearchCall.action.sources)
    ) {
      for (const source of webSearchCall.action.sources) {
        if (source.type === "url" && typeof source.url === "string") {
          seen.add(source.url);
        }
      }
    }

    if (
      webSearchCall.action.type === "open_page" &&
      typeof webSearchCall.action.url === "string"
    ) {
      seen.add(webSearchCall.action.url);
    }
  }

  return Array.from(seen)
    .slice(0, 5)
    .map((url) => ({
      url,
      host: safeHost(url),
    }));
}

async function generateResponsesReply(
  options: GenerateReplyOptions & { enableWebSearch: boolean },
): Promise<AssistantReplyPayload> {
  const location = approximateLocation(options.requestContext);
  const response = await openai.responses.create({
    model: OPENAI_MODEL,
    instructions: buildInstructions(
      options.memoryContext,
      options.requestContext,
      Boolean(options.imageDataUrl),
    ),
    input: buildInput(options.message, options.history, options.imageDataUrl),
    include: ["web_search_call.action.sources"],
    max_output_tokens: 280,
    parallel_tool_calls: true,
    ...(options.enableWebSearch
      ? {
          tools: [
            {
              type: "web_search_preview" as const,
              search_content_types: ["text"],
              search_context_size: "medium" as const,
              ...(location ? { user_location: location } : {}),
            },
          ],
        }
      : {}),
  });

  const reply = response.output_text?.trim();
  if (!reply) {
    throw new Error("Responses API returned empty output_text");
  }

  const sources = extractWebSources(response as { output?: unknown[] });
  return {
    reply,
    sources,
    usedWebSearch: sources.length > 0,
  };
}

async function generateLegacyReply(
  message: string,
  history: AssistantHistoryItem[],
  memoryContext: string,
  hasImage: boolean,
  requestContext?: AssistantRequestContext,
): Promise<string> {
  const systemPrompt = [
    "You are Clicky, a sharp and knowledgeable personal voice AI assistant.",
    "Answer directly and accurately. Keep spoken replies concise, natural, and easy to follow.",
    hasImage
      ? "The user tried to share a screenshot, but this server could not run image analysis. Briefly explain that limitation and ask them to describe the key on-screen text or action they need help with."
      : "",
    `Today is ${formatToday(requestContext)}.`,
    memoryContext ? `Relevant memories from past conversations:\n${memoryContext}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const chatMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    ...history.slice(-12).map((entry) => ({
      role: entry.role as "user" | "assistant",
      content: entry.content,
    })),
    { role: "user", content: message },
  ];

  const result = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    max_completion_tokens: 220,
    messages: chatMessages,
  });

  const content = result.choices[0]?.message?.content?.trim();
  if (!content) {
    logger.warn(
      { finishReason: result.choices[0]?.finish_reason },
      "Chat completions returned empty content",
    );
    return "Sorry, I had trouble generating a response. Please try again.";
  }
  return content;
}

async function generateReply(options: GenerateReplyOptions): Promise<AssistantReplyPayload> {
  try {
    return await generateResponsesReply({ ...options, enableWebSearch: true });
  } catch (error) {
    logger.warn(
      { err: error },
      "Responses API with web search failed, retrying without hosted tools",
    );
  }

  try {
    return await generateResponsesReply({ ...options, enableWebSearch: false });
  } catch (error) {
    logger.warn({ err: error }, "Responses API retry without tools failed");
  }

  const reply = await generateLegacyReply(
    options.message,
    options.history,
    options.memoryContext,
    Boolean(options.imageDataUrl),
    options.requestContext,
  );

  return {
    reply,
    sources: [],
    usedWebSearch: false,
  };
}

function normalizeHistory(
  rawHistory: Array<{ content: string; role: string }>,
): AssistantHistoryItem[] {
  return rawHistory.reverse().map((message) => ({
    role: message.role,
    content: message.content,
  }));
}

async function runAssistantTurn(options: {
  imageDataUrl?: string;
  persistedUserContent: string;
  requestContext?: AssistantRequestContext;
  sessionId: string;
  userMessage: string;
}): Promise<AssistantReplyPayload> {
  await upsertSession(options.sessionId);

  const [memories, rawHistory] = await Promise.all([
    retrieveMemories(options.userMessage, options.sessionId),
    getSessionMessages(options.sessionId, 12),
  ]);

  await Promise.all([
    saveMessage(generateId(), options.sessionId, "user", options.persistedUserContent),
    storeMemory(options.sessionId, "user", options.persistedUserContent),
  ]);

  const replyPayload = await generateReply({
    message: options.userMessage,
    history: normalizeHistory(rawHistory),
    imageDataUrl: options.imageDataUrl,
    memoryContext: memories.join("\n"),
    requestContext: options.requestContext,
  });

  await Promise.all([
    saveMessage(generateId(), options.sessionId, "assistant", replyPayload.reply),
    storeMemory(options.sessionId, "assistant", replyPayload.reply),
  ]);

  return replyPayload;
}

router.get("/sessions", async (_req: Request, res: Response) => {
  try {
    const sessions = await getSessions();
    res.json({ sessions });
  } catch (error) {
    logger.error({ err: error }, "Failed to get sessions");
    res.status(500).json({ error: "Failed to get sessions" });
  }
});

router.get("/sessions/:sessionId/messages", async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params as { sessionId: string };
    const messages = await getSessionMessages(sessionId);
    res.json({ messages: messages.reverse() });
  } catch (error) {
    logger.error({ err: error }, "Failed to get messages");
    res.status(500).json({ error: "Failed to get messages" });
  }
});

router.post("/chat", async (req: Request, res: Response) => {
  try {
    const {
      city,
      country,
      imageDataUrl,
      message,
      region,
      sessionId,
      timezone,
    } = req.body as {
      city?: string;
      country?: string;
      imageDataUrl?: string;
      message?: string;
      region?: string;
      sessionId?: string;
      timezone?: string;
    };

    if (!sessionId) {
      res.status(400).json({ error: "sessionId is required" });
      return;
    }

    const trimmedMessage = message?.trim() ?? "";
    const userMessage = trimmedMessage || (imageDataUrl ? DEFAULT_SCREENSHOT_PROMPT : "");

    if (!userMessage) {
      res.status(400).json({ error: "message is required when no screenshot is attached" });
      return;
    }

    const persistedUserContent = imageDataUrl
      ? trimmedMessage
        ? `[Shared a screenshot] ${trimmedMessage}`
        : "[Shared a screenshot for screen help]"
      : userMessage;

    const replyPayload = await runAssistantTurn({
      sessionId,
      userMessage,
      persistedUserContent,
      imageDataUrl,
      requestContext: {
        ...(city ? { city } : {}),
        ...(country ? { country } : {}),
        ...(region ? { region } : {}),
        ...(timezone ? { timezone } : {}),
      },
    });

    logger.info(
      {
        chars: replyPayload.reply.length,
        sessionId,
        usedWebSearch: replyPayload.usedWebSearch,
      },
      "Assistant reply generated",
    );

    res.json({ ...replyPayload, sessionId });
  } catch (error) {
    logger.error({ err: error }, "Chat error");
    res.status(500).json({ error: "Failed to process message" });
  }
});

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
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
        style: 0.0,
        use_speaker_boost: true,
      },
    });

    res.setHeader("Content-Type", "audio/mpeg");
    for await (const chunk of stream) {
      res.write(chunk);
    }
    res.end();
  } catch (error) {
    logger.error({ err: error }, "TTS error");
    if (!res.headersSent) {
      res.status(500).json({ error: "TTS failed" });
    }
  }
});

router.post("/transcribe", audioUpload.single("audio"), async (req: Request, res: Response) => {
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

    fs.unlink(file.path, () => {});

    const transcript = result.text?.trim() ?? "";
    logger.info({ chars: transcript.length }, "ElevenLabs STT transcription done");
    res.json({ transcript });
  } catch (error) {
    fs.unlink(file.path, () => {});
    logger.error({ err: error }, "Transcription failed");
    res.status(500).json({ error: "Transcription failed" });
  }
});

router.get("/agent-config", (_req: Request, res: Response) => {
  res.json({
    agentId: process.env["ELEVENLABS_AGENT_ID"] ?? "",
    hasAgentId: Boolean(process.env["ELEVENLABS_AGENT_ID"]),
  });
});

router.post("/signed-url", async (req: Request, res: Response) => {
  try {
    const agentId =
      (req.body as { agentId?: string }).agentId ??
      process.env["ELEVENLABS_AGENT_ID"] ??
      "";
    if (!agentId) {
      res.status(400).json({ error: "No ElevenLabs agent ID configured." });
      return;
    }
    const result = await elevenlabs.conversationalAi.getSignedUrl({ agent_id: agentId });
    res.json({ signedUrl: result.signed_url });
  } catch (error) {
    logger.error({ err: error }, "Failed to get signed URL");
    res.status(500).json({ error: "Failed to get signed URL" });
  }
});

router.post("/memories", async (req: Request, res: Response) => {
  try {
    const { query, sessionId } = req.body as { query?: string; sessionId?: string };
    if (!query || !sessionId) {
      res.status(400).json({ error: "query and sessionId are required" });
      return;
    }
    const memories = await retrieveMemories(query, sessionId);
    res.json({ memories });
  } catch (error) {
    logger.error({ err: error }, "Memory retrieval error");
    res.status(500).json({ error: "Memory retrieval failed" });
  }
});

export default router;
