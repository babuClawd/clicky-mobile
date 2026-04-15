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
import { Platform } from "react-native";

export type MessageRole = "user" | "assistant" | "system";

export interface Message {
  id: string;
  role: MessageRole;
  text: string;
  timestamp: number;
}

export type AssistantStatus =
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "error";

interface AssistantContextValue {
  messages: Message[];
  status: AssistantStatus;
  sessionId: string;
  isRecording: boolean;
  startListening: () => void;
  stopListening: () => void;
  sendMessage: (text: string) => Promise<void>;
  clearHistory: () => void;
  currentTranscript: string;
  lastReply: string;
}

const AssistantContext = createContext<AssistantContextValue | null>(null);

const SESSION_KEY = "clicky_session_id";
const MESSAGES_KEY = "clicky_messages";
const MAX_MESSAGES = 50;

function generateId(): string {
  return Date.now().toString() + Math.random().toString(36).substr(2, 9);
}

export const BASE_URL = `https://${process.env["EXPO_PUBLIC_DOMAIN"] ?? ""}`;

export function AssistantProvider({ children }: { children: React.ReactNode }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [status, setStatus] = useState<AssistantStatus>("idle");
  const [isRecording, setIsRecording] = useState(false);
  const [sessionId, setSessionId] = useState<string>("");
  const [currentTranscript, setCurrentTranscript] = useState("");
  const [lastReply, setLastReply] = useState("");
  const soundRef = useRef<Audio.Sound | null>(null);

  useEffect(() => {
    const init = async () => {
      // Configure audio for React Native
      if (Platform.OS !== "web") {
        await Audio.setAudioModeAsync({
          allowsRecordingIOS: false,
          playsInSilentModeIOS: true,
          shouldDuckAndroid: true,
          playThroughEarpieceAndroid: false,
        });
      }

      let sid = await AsyncStorage.getItem(SESSION_KEY);
      if (!sid) {
        sid = generateId();
        await AsyncStorage.setItem(SESSION_KEY, sid);
      }
      setSessionId(sid);

      const stored = await AsyncStorage.getItem(MESSAGES_KEY);
      if (stored) {
        try {
          setMessages(JSON.parse(stored) as Message[]);
        } catch {}
      }

      setMessages((prev) => {
        if (prev.length === 0) {
          return [{
            id: generateId(),
            role: "assistant",
            text: "Hey! I'm Clicky, your personal AI assistant. Ask me anything or tap the mic to speak.",
            timestamp: Date.now(),
          }];
        }
        return prev;
      });
    };
    void init();
  }, []);

  useEffect(() => {
    if (messages.length > 0) {
      void AsyncStorage.setItem(MESSAGES_KEY, JSON.stringify(messages.slice(-MAX_MESSAGES)));
    }
  }, [messages]);

  const addMessage = useCallback((role: MessageRole, text: string): string => {
    const id = generateId();
    setMessages((prev) => [...prev, { id, role, text, timestamp: Date.now() }]);
    return id;
  }, []);

  const playAudioFromUrl = useCallback(async (url: string): Promise<void> => {
    try {
      if (soundRef.current) {
        await soundRef.current.unloadAsync();
        soundRef.current = null;
      }
      const { sound } = await Audio.Sound.createAsync(
        { uri: url },
        { shouldPlay: true, volume: 1.0 }
      );
      soundRef.current = sound;
      return new Promise((resolve) => {
        sound.setOnPlaybackStatusUpdate((playbackStatus) => {
          if (!playbackStatus.isLoaded) return;
          if (playbackStatus.didJustFinish) {
            void sound.unloadAsync();
            soundRef.current = null;
            resolve();
          }
        });
      });
    } catch (err) {
      console.warn("Audio playback error:", err);
    }
  }, []);

  const playAudioWeb = useCallback(async (audioBlob: Blob): Promise<void> => {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(audioBlob);
      const audio = new window.Audio(url);
      audio.onended = () => { URL.revokeObjectURL(url); resolve(); };
      audio.onerror = () => { URL.revokeObjectURL(url); resolve(); };
      void audio.play();
    });
  }, []);

  const sendMessage = useCallback(
    async (text: string) => {
      if (!text.trim() || !sessionId) return;

      addMessage("user", text);
      setStatus("thinking");
      setCurrentTranscript("");

      try {
        // Step 1: Get text reply from /chat (JSON)
        const chatRes = await fetch(`${BASE_URL}/api/assistant/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: text, sessionId }),
        });

        if (!chatRes.ok) throw new Error("Chat failed");

        const { reply } = await chatRes.json() as { reply: string };
        addMessage("assistant", reply);
        setLastReply(reply);
        setStatus("speaking");

        // Step 2: Get TTS audio from /tts (audio stream)
        const ttsRes = await fetch(`${BASE_URL}/api/assistant/tts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: reply }),
        });

        if (ttsRes.ok) {
          if (Platform.OS === "web") {
            const audioBlob = await ttsRes.blob();
            await playAudioWeb(audioBlob);
          } else {
            // On native: save to temp file and play with expo-av
            const arrayBuffer = await ttsRes.arrayBuffer();
            const { FileSystem } = await import("expo-file-system");
            const uri = `${FileSystem.cacheDirectory ?? ""}clicky_tts_${Date.now()}.mp3`;
            const bytes = new Uint8Array(arrayBuffer);
            let binary = "";
            for (let i = 0; i < bytes.byteLength; i++) {
              binary += String.fromCharCode(bytes[i]!);
            }
            const base64 = btoa(binary);
            await FileSystem.writeAsStringAsync(uri, base64, {
              encoding: FileSystem.EncodingType.Base64,
            });
            await playAudioFromUrl(uri);
          }
        }

        setStatus("idle");
      } catch (err) {
        console.error("sendMessage error:", err);
        setStatus("error");
        addMessage("assistant", "Sorry, I had trouble connecting. Please try again.");
        setTimeout(() => setStatus("idle"), 2000);
      }
    },
    [sessionId, addMessage, playAudioWeb, playAudioFromUrl]
  );

  const startListening = useCallback(() => {
    if (status !== "idle") return;
    setIsRecording(true);
    setStatus("listening");
    setCurrentTranscript("");

    if (Platform.OS === "web" && typeof window !== "undefined" && "webkitSpeechRecognition" in window) {
      const SpeechRecognition = (window as unknown as { webkitSpeechRecognition: new () => SpeechRecognition }).webkitSpeechRecognition;
      const recognition = new SpeechRecognition();
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.lang = "en-US";

      recognition.onresult = (event: SpeechRecognitionEvent) => {
        let interim = "";
        let final = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          if (event.results[i]?.isFinal) final += event.results[i]?.[0]?.transcript ?? "";
          else interim += event.results[i]?.[0]?.transcript ?? "";
        }
        setCurrentTranscript(final || interim);
        if (final) {
          setIsRecording(false);
          void sendMessage(final);
        }
      };

      recognition.onerror = () => { setIsRecording(false); setStatus("idle"); };
      recognition.onend = () => {
        setIsRecording(false);
        if (status === "listening") setStatus("idle");
      };

      recognition.start();
      (window as unknown as Record<string, unknown>)["_clickyRecognition"] = recognition;
    }
  }, [status, sendMessage]);

  const stopListening = useCallback(() => {
    setIsRecording(false);
    if (status === "listening") setStatus("idle");
    const rec = (window as unknown as Record<string, unknown>)["_clickyRecognition"] as { stop?: () => void } | undefined;
    if (rec?.stop) rec.stop();
  }, [status]);

  const clearHistory = useCallback(async () => {
    if (soundRef.current) {
      await soundRef.current.unloadAsync().catch(() => {});
      soundRef.current = null;
    }
    setMessages([{
      id: generateId(),
      role: "assistant",
      text: "History cleared. How can I help you?",
      timestamp: Date.now(),
    }]);
    setLastReply("");
    await AsyncStorage.removeItem(MESSAGES_KEY);
  }, []);

  return (
    <AssistantContext.Provider value={{
      messages,
      status,
      sessionId,
      isRecording,
      startListening,
      stopListening,
      sendMessage,
      clearHistory,
      currentTranscript,
      lastReply,
    }}>
      {children}
    </AssistantContext.Provider>
  );
}

export function useAssistant() {
  const ctx = useContext(AssistantContext);
  if (!ctx) throw new Error("useAssistant must be inside AssistantProvider");
  return ctx;
}
