import AsyncStorage from "@react-native-async-storage/async-storage";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { Audio } from "expo-av";
import * as FileSystem from "expo-file-system/legacy";
import { Alert, Linking, Platform } from "react-native";

export type MessageRole = "user" | "assistant" | "system";

export interface MessageAttachment {
  base64?: string;
  fileName?: string;
  height?: number;
  mimeType?: string;
  uri: string;
  width?: number;
}

export interface MessageSource {
  host: string;
  url: string;
}

export interface MessageMeta {
  attachment?: MessageAttachment;
  sources?: MessageSource[];
  usedLiveInfo?: boolean;
}

export interface Message {
  id: string;
  meta?: MessageMeta;
  role: MessageRole;
  text: string;
  timestamp: number;
}

export interface SendMessageInput {
  attachment?: MessageAttachment;
  text: string;
}

type WebSpeechRecognitionAlternative = {
  transcript?: string;
};

type WebSpeechRecognitionResult = {
  0?: WebSpeechRecognitionAlternative;
  isFinal?: boolean;
};

type WebSpeechRecognitionEvent = {
  resultIndex: number;
  results: ArrayLike<WebSpeechRecognitionResult>;
};

type WebSpeechRecognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  onresult: ((event: WebSpeechRecognitionEvent) => void) | null;
  start: () => void;
  stop?: () => void;
};

export type AssistantStatus =
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "error";

export interface Session {
  created_at: string;
  id: string;
  message_count: string;
  updated_at: string;
}

interface AssistantContextValue {
  audioLevel: number;
  clearHistory: () => Promise<void>;
  createNewSession: () => Promise<void>;
  currentTranscript: string;
  fetchSessions: () => Promise<Session[]>;
  hasMicPermission: boolean;
  isRecording: boolean;
  lastReply: string;
  loadSession: (id: string) => Promise<void>;
  messages: Message[];
  sendMessage: (input: SendMessageInput) => Promise<void>;
  sessionId: string;
  startListening: () => void;
  status: AssistantStatus;
  stopListening: () => void;
}

const AssistantContext = createContext<AssistantContextValue | null>(null);

const SESSION_KEY = "clicky_session_id";
const MESSAGES_KEY = "clicky_messages";
const MAX_MESSAGES = 50;
const SILENCE_THRESHOLD_DB = -45;
const SILENCE_FRAMES_NEEDED = 14;
const MIN_RECORDING_FRAMES = 8;

function generateId(): string {
  return Date.now().toString() + Math.random().toString(36).substr(2, 9);
}

function getRequestTimezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

export const BASE_URL = `https://${process.env["EXPO_PUBLIC_DOMAIN"] ?? ""}`;

export function AssistantProvider({ children }: { children: React.ReactNode }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [status, setStatus] = useState<AssistantStatus>("idle");
  const [isRecording, setIsRecording] = useState(false);
  const [sessionId, setSessionId] = useState<string>("");
  const [currentTranscript, setCurrentTranscript] = useState("");
  const [lastReply, setLastReply] = useState("");
  const [hasMicPermission, setHasMicPermission] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);

  const soundRef = useRef<Audio.Sound | null>(null);
  const recordingRef = useRef<Audio.Recording | null>(null);
  const silenceFramesRef = useRef(0);
  const totalFramesRef = useRef(0);
  const autoStopCalledRef = useRef(false);

  const requestMicPermission = useCallback(async (): Promise<boolean> => {
    if (Platform.OS === "web") {
      setHasMicPermission(true);
      return true;
    }
    try {
      const { granted, canAskAgain } = await Audio.requestPermissionsAsync();
      if (granted) {
        setHasMicPermission(true);
        return true;
      }
      if (!canAskAgain) {
        Alert.alert(
          "Microphone Required",
          "Clicky needs microphone access to hear your voice. Please enable it in Settings.",
          [
            { text: "Cancel", style: "cancel" },
            { text: "Open Settings", onPress: () => void Linking.openSettings() },
          ],
        );
      }
      setHasMicPermission(false);
      return false;
    } catch {
      return false;
    }
  }, []);

  useEffect(() => {
    const init = async () => {
      if (Platform.OS !== "web") {
        await Audio.setAudioModeAsync({
          allowsRecordingIOS: false,
          playsInSilentModeIOS: true,
          shouldDuckAndroid: true,
          playThroughEarpieceAndroid: false,
        });
        const { granted } = await Audio.getPermissionsAsync();
        setHasMicPermission(granted);
      } else {
        setHasMicPermission(true);
      }

      let storedSessionId = await AsyncStorage.getItem(SESSION_KEY);
      if (!storedSessionId) {
        storedSessionId = generateId();
        await AsyncStorage.setItem(SESSION_KEY, storedSessionId);
      }
      setSessionId(storedSessionId);

      const storedMessages = await AsyncStorage.getItem(MESSAGES_KEY);
      if (storedMessages) {
        try {
          setMessages(JSON.parse(storedMessages) as Message[]);
        } catch {
          // Ignore malformed local cache and continue with a fresh greeting.
        }
      }

      setMessages((previous) => {
        if (previous.length === 0) {
          return [
            {
              id: generateId(),
              role: "assistant",
              text: "Hey! I'm Clicky. Ask me anything, tap the mic, or share a screenshot if you want help understanding a screen.",
              timestamp: Date.now(),
            },
          ];
        }
        return previous;
      });
    };

    void init();
  }, []);

  useEffect(() => {
    if (messages.length > 0) {
      void AsyncStorage.setItem(MESSAGES_KEY, JSON.stringify(messages.slice(-MAX_MESSAGES)));
    }
  }, [messages]);

  const addMessage = useCallback(
    (role: MessageRole, text: string, meta?: MessageMeta): string => {
      const id = generateId();
      setMessages((previous) => [
        ...previous,
        { id, role, text, timestamp: Date.now(), ...(meta ? { meta } : {}) },
      ]);
      return id;
    },
    [],
  );

  const playAudioFromUri = useCallback(async (uri: string): Promise<void> => {
    try {
      if (soundRef.current) {
        await soundRef.current.unloadAsync().catch(() => {});
        soundRef.current = null;
      }

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
      });

      const { sound } = await Audio.Sound.createAsync(
        { uri },
        { shouldPlay: true, volume: 1.0 },
      );

      soundRef.current = sound;
      return new Promise((resolve) => {
        sound.setOnPlaybackStatusUpdate((playbackStatus) => {
          if (!playbackStatus.isLoaded) {
            return;
          }
          if (playbackStatus.didJustFinish) {
            void sound.unloadAsync();
            soundRef.current = null;
            resolve();
          }
        });
      });
    } catch (error) {
      console.warn("Audio playback error:", error);
    }
  }, []);

  const playAudioBlob = useCallback(async (blob: Blob): Promise<void> => {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const audio = new window.Audio(url);
      audio.onended = () => {
        URL.revokeObjectURL(url);
        resolve();
      };
      audio.onerror = () => {
        URL.revokeObjectURL(url);
        resolve();
      };
      void audio.play();
    });
  }, []);

  const sendMessage = useCallback(
    async (input: SendMessageInput) => {
      const trimmed = input.text.trim();
      const attachment = input.attachment;
      const displayText =
        trimmed || (attachment ? "Help me understand this screen and what to do next." : "");

      if (!displayText || !sessionId) {
        return;
      }

      addMessage(
        "user",
        displayText,
        attachment ? { attachment } : undefined,
      );
      setStatus("thinking");
      setCurrentTranscript("");
      setAudioLevel(0);

      try {
        const imageDataUrl =
          attachment?.base64 && attachment.mimeType
            ? `data:${attachment.mimeType};base64,${attachment.base64}`
            : attachment?.base64
              ? `data:image/jpeg;base64,${attachment.base64}`
              : undefined;

        const chatRes = await fetch(`${BASE_URL}/api/assistant/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: trimmed,
            sessionId,
            imageDataUrl,
            timezone: getRequestTimezone(),
          }),
        });

        if (!chatRes.ok) {
          throw new Error("Chat failed");
        }

        const { reply, sources, usedWebSearch } = (await chatRes.json()) as {
          reply: string;
          sources?: MessageSource[];
          usedWebSearch?: boolean;
        };

        addMessage("assistant", reply, {
          ...(Array.isArray(sources) && sources.length > 0 ? { sources } : {}),
          ...(usedWebSearch ? { usedLiveInfo: true } : {}),
        });
        setLastReply(reply);
        setStatus("speaking");

        const ttsRes = await fetch(`${BASE_URL}/api/assistant/tts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: reply }),
        });

        if (ttsRes.ok) {
          if (Platform.OS === "web") {
            await playAudioBlob(await ttsRes.blob());
          } else {
            const buffer = await ttsRes.arrayBuffer();
            const bytes = new Uint8Array(buffer);
            let binary = "";
            for (let index = 0; index < bytes.byteLength; index += 1) {
              binary += String.fromCharCode(bytes[index] ?? 0);
            }
            const uri = `${FileSystem.cacheDirectory ?? ""}clicky_tts_${Date.now()}.mp3`;
            await FileSystem.writeAsStringAsync(uri, btoa(binary), {
              encoding: FileSystem.EncodingType.Base64,
            });
            await playAudioFromUri(uri);
          }
        }

        setStatus("idle");
      } catch (error) {
        console.error("sendMessage error:", error);
        setStatus("error");
        addMessage(
          "assistant",
          "Sorry, I had trouble connecting. Please try again.",
        );
        setTimeout(() => setStatus("idle"), 2000);
      }
    },
    [sessionId, addMessage, playAudioBlob, playAudioFromUri],
  );

  const stopNativeRecordingRef = useRef<(() => Promise<void>) | null>(null);

  const startNativeRecording = useCallback(async () => {
    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
      });

      const { recording } = await Audio.Recording.createAsync({
        android: {
          extension: ".m4a",
          outputFormat: Audio.AndroidOutputFormat.MPEG_4,
          audioEncoder: Audio.AndroidAudioEncoder.AAC,
          sampleRate: 44100,
          numberOfChannels: 1,
          bitRate: 96000,
        },
        ios: {
          extension: ".m4a",
          outputFormat: Audio.IOSOutputFormat.MPEG4AAC,
          audioQuality: Audio.IOSAudioQuality.HIGH,
          sampleRate: 44100,
          numberOfChannels: 1,
          bitRate: 96000,
          linearPCMBitDepth: 16,
          linearPCMIsBigEndian: false,
          linearPCMIsFloat: false,
        },
        web: { mimeType: "audio/webm", bitsPerSecond: 96000 },
        isMeteringEnabled: true,
      });

      recordingRef.current = recording;
      silenceFramesRef.current = 0;
      totalFramesRef.current = 0;
      autoStopCalledRef.current = false;

      recording.setProgressUpdateInterval(100);
      recording.setOnRecordingStatusUpdate((recordingStatus) => {
        if (!recordingStatus.isRecording) {
          return;
        }

        totalFramesRef.current += 1;

        const db = recordingStatus.metering ?? -160;
        const normalized = Math.min(1, Math.max(0, (db + 60) / 60));
        setAudioLevel(normalized);

        if (totalFramesRef.current >= MIN_RECORDING_FRAMES) {
          if (db < SILENCE_THRESHOLD_DB) {
            silenceFramesRef.current += 1;
          } else {
            silenceFramesRef.current = 0;
          }

          if (
            silenceFramesRef.current >= SILENCE_FRAMES_NEEDED &&
            !autoStopCalledRef.current
          ) {
            autoStopCalledRef.current = true;
            stopNativeRecordingRef.current?.().catch(console.error);
          }
        }
      });
    } catch (error) {
      console.error("Failed to start recording:", error);
      setIsRecording(false);
      setStatus("idle");
    }
  }, []);

  const stopNativeRecording = useCallback(async () => {
    const recording = recordingRef.current;
    if (!recording) {
      return;
    }

    recordingRef.current = null;
    setAudioLevel(0);

    try {
      await recording.stopAndUnloadAsync();
      const uri = recording.getURI();
      if (!uri) {
        throw new Error("No recording URI");
      }

      setStatus("thinking");

      const formData = new FormData();
      formData.append(
        "audio",
        {
          uri,
          name: "recording.m4a",
          type: "audio/m4a",
        } as unknown as Blob,
      );

      const transcribeRes = await fetch(`${BASE_URL}/api/assistant/transcribe`, {
        method: "POST",
        body: formData,
      });

      if (!transcribeRes.ok) {
        throw new Error("Transcription failed");
      }

      const { transcript } = (await transcribeRes.json()) as { transcript: string };

      if (transcript) {
        setCurrentTranscript(transcript);
        await sendMessage({ text: transcript });
      } else {
        setStatus("idle");
      }

      await FileSystem.deleteAsync(uri, { idempotent: true });
    } catch (error) {
      console.error("Recording error:", error);
      setStatus("error");
      addMessage("assistant", "Couldn't understand that. Please try again.");
      setTimeout(() => setStatus("idle"), 2000);
    }
  }, [sendMessage, addMessage]);

  useEffect(() => {
    stopNativeRecordingRef.current = stopNativeRecording;
  }, [stopNativeRecording]);

  const startListening = useCallback(async () => {
    if (status !== "idle") {
      return;
    }

    if (Platform.OS === "web") {
      if (typeof window === "undefined" || !("webkitSpeechRecognition" in window)) {
        return;
      }

      setIsRecording(true);
      setStatus("listening");
      setCurrentTranscript("");

      const SpeechRecognitionCtor = (
        window as unknown as { webkitSpeechRecognition: new () => WebSpeechRecognition }
      ).webkitSpeechRecognition;
      const recognition = new SpeechRecognitionCtor();
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.lang = "en-US";

      recognition.onresult = (event: WebSpeechRecognitionEvent) => {
        let interim = "";
        let final = "";
        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          if (event.results[index]?.isFinal) {
            final += event.results[index]?.[0]?.transcript ?? "";
          } else {
            interim += event.results[index]?.[0]?.transcript ?? "";
          }
        }
        setCurrentTranscript(final || interim);
        if (final) {
          setIsRecording(false);
          void sendMessage({ text: final });
        }
      };

      recognition.onerror = () => {
        setIsRecording(false);
        setStatus("idle");
      };

      recognition.onend = () => {
        setIsRecording(false);
        setStatus((current) => (current === "listening" ? "idle" : current));
      };

      recognition.start();
      (window as unknown as Record<string, unknown>)["_clickyRec"] = recognition;
    } else {
      const granted = hasMicPermission || (await requestMicPermission());
      if (!granted) {
        return;
      }

      setIsRecording(true);
      setStatus("listening");
      setCurrentTranscript("");
      await startNativeRecording();
    }
  }, [status, hasMicPermission, requestMicPermission, sendMessage, startNativeRecording]);

  const stopListening = useCallback(async () => {
    if (Platform.OS === "web") {
      setIsRecording(false);
      if (status === "listening") {
        setStatus("idle");
      }
      const recognition = (window as unknown as Record<string, unknown>)["_clickyRec"] as
        | { stop?: () => void }
        | undefined;
      recognition?.stop?.();
    } else {
      setIsRecording(false);
      await stopNativeRecording();
    }
  }, [status, stopNativeRecording]);

  const createNewSession = useCallback(async () => {
    if (soundRef.current) {
      await soundRef.current.unloadAsync().catch(() => {});
      soundRef.current = null;
    }
    if (recordingRef.current) {
      await recordingRef.current.stopAndUnloadAsync().catch(() => {});
      recordingRef.current = null;
    }

    const newId = generateId();
    await AsyncStorage.setItem(SESSION_KEY, newId);
    setSessionId(newId);
    setLastReply("");
    setCurrentTranscript("");
    setStatus("idle");
    await AsyncStorage.removeItem(MESSAGES_KEY);
    setMessages([
      {
        id: generateId(),
        role: "assistant",
        text: "New chat started. You can ask a question, use your voice, or share a screenshot.",
        timestamp: Date.now(),
      },
    ]);
  }, []);

  const loadSession = useCallback(async (id: string) => {
    if (soundRef.current) {
      await soundRef.current.unloadAsync().catch(() => {});
      soundRef.current = null;
    }
    if (recordingRef.current) {
      await recordingRef.current.stopAndUnloadAsync().catch(() => {});
      recordingRef.current = null;
    }

    setStatus("thinking");
    try {
      const res = await fetch(`${BASE_URL}/api/assistant/sessions/${id}/messages`);
      if (!res.ok) {
        throw new Error("Failed to load session");
      }

      const { messages: rawMessages } = (await res.json()) as {
        messages: Array<{
          content: string;
          created_at: string;
          id: string;
          role: string;
        }>;
      };

      const loaded: Message[] = rawMessages.map((message) => ({
        id: message.id,
        role: message.role as MessageRole,
        text: message.content,
        timestamp: new Date(message.created_at).getTime(),
      }));

      await AsyncStorage.setItem(SESSION_KEY, id);
      setSessionId(id);
      setMessages(
        loaded.length > 0
          ? loaded
          : [
              {
                id: generateId(),
                role: "assistant",
                text: "Session loaded. What else can I help you with?",
                timestamp: Date.now(),
              },
            ],
      );
      setLastReply("");
      setCurrentTranscript("");
      await AsyncStorage.setItem(MESSAGES_KEY, JSON.stringify(loaded.slice(-MAX_MESSAGES)));
    } catch (error) {
      console.error("loadSession error:", error);
    } finally {
      setStatus("idle");
    }
  }, []);

  const fetchSessions = useCallback(async (): Promise<Session[]> => {
    try {
      const res = await fetch(`${BASE_URL}/api/assistant/sessions`);
      if (!res.ok) {
        return [];
      }
      const { sessions } = (await res.json()) as { sessions: Session[] };
      return sessions;
    } catch {
      return [];
    }
  }, []);

  const clearHistory = useCallback(async () => {
    await createNewSession();
  }, [createNewSession]);

  return (
    <AssistantContext.Provider
      value={{
        messages,
        status,
        sessionId,
        isRecording,
        startListening: () => {
          void startListening();
        },
        stopListening: () => {
          void stopListening();
        },
        sendMessage,
        clearHistory,
        createNewSession,
        loadSession,
        fetchSessions,
        currentTranscript,
        lastReply,
        hasMicPermission,
        audioLevel,
      }}
    >
      {children}
    </AssistantContext.Provider>
  );
}

export function useAssistant() {
  const context = useContext(AssistantContext);
  if (!context) {
    throw new Error("useAssistant must be inside AssistantProvider");
  }
  return context;
}
