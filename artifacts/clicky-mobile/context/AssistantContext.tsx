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

export interface Session {
  id: string;
  created_at: string;
  updated_at: string;
  message_count: string;
}

interface AssistantContextValue {
  messages: Message[];
  status: AssistantStatus;
  sessionId: string;
  isRecording: boolean;
  startListening: () => void;
  stopListening: () => void;
  sendMessage: (text: string) => Promise<void>;
  clearHistory: () => Promise<void>;
  createNewSession: () => Promise<void>;
  loadSession: (id: string) => Promise<void>;
  fetchSessions: () => Promise<Session[]>;
  currentTranscript: string;
  lastReply: string;
  hasMicPermission: boolean;
  audioLevel: number;
}

const AssistantContext = createContext<AssistantContextValue | null>(null);

const SESSION_KEY = "clicky_session_id";
const MESSAGES_KEY = "clicky_messages";
const MAX_MESSAGES = 50;

// Silence detection tuning
const SILENCE_THRESHOLD_DB = -45;   // dBFS — below this = silence
const SILENCE_FRAMES_NEEDED = 14;   // × 100ms = ~1.4s of silence → auto-stop
const MIN_RECORDING_FRAMES = 8;     // don't auto-stop in first 0.8s

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
  const [hasMicPermission, setHasMicPermission] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);

  const soundRef = useRef<Audio.Sound | null>(null);
  const recordingRef = useRef<Audio.Recording | null>(null);
  const silenceFramesRef = useRef(0);
  const totalFramesRef = useRef(0);
  const autoStopCalledRef = useRef(false);

  // ── Request microphone permission ──────────────────────────────────────────
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
          ]
        );
      }
      setHasMicPermission(false);
      return false;
    } catch {
      return false;
    }
  }, []);

  // ── Init: session + stored messages + permissions ──────────────────────────
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

      let sid = await AsyncStorage.getItem(SESSION_KEY);
      if (!sid) {
        sid = generateId();
        await AsyncStorage.setItem(SESSION_KEY, sid);
      }
      setSessionId(sid);

      const stored = await AsyncStorage.getItem(MESSAGES_KEY);
      if (stored) {
        try { setMessages(JSON.parse(stored) as Message[]); } catch {}
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

  // ── Play audio from a URI (native) ────────────────────────────────────────
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
      const { sound } = await Audio.Sound.createAsync({ uri }, { shouldPlay: true, volume: 1.0 });
      soundRef.current = sound;
      return new Promise((resolve) => {
        sound.setOnPlaybackStatusUpdate((s) => {
          if (!s.isLoaded) return;
          if (s.didJustFinish) { void sound.unloadAsync(); soundRef.current = null; resolve(); }
        });
      });
    } catch (err) {
      console.warn("Audio playback error:", err);
    }
  }, []);

  // ── Play audio blob (web) ─────────────────────────────────────────────────
  const playAudioBlob = useCallback(async (blob: Blob): Promise<void> => {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const audio = new window.Audio(url);
      audio.onended = () => { URL.revokeObjectURL(url); resolve(); };
      audio.onerror = () => { URL.revokeObjectURL(url); resolve(); };
      void audio.play();
    });
  }, []);

  // ── Send message → get reply text + TTS ──────────────────────────────────
  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || !sessionId) return;

    addMessage("user", text);
    setStatus("thinking");
    setCurrentTranscript("");
    setAudioLevel(0);

    try {
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
          for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]!);
          const uri = `${FileSystem.cacheDirectory ?? ""}clicky_tts_${Date.now()}.mp3`;
          await FileSystem.writeAsStringAsync(uri, btoa(binary), { encoding: FileSystem.EncodingType.Base64 });
          await playAudioFromUri(uri);
        }
      }

      setStatus("idle");
    } catch (err) {
      console.error("sendMessage error:", err);
      setStatus("error");
      addMessage("assistant", "Sorry, I had trouble connecting. Please try again.");
      setTimeout(() => setStatus("idle"), 2000);
    }
  }, [sessionId, addMessage, playAudioBlob, playAudioFromUri]);

  // ── Native recording ───────────────────────────────────────────────────────
  const stopNativeRecordingRef = useRef<(() => Promise<void>) | null>(null);

  const startNativeRecording = useCallback(async () => {
    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
      });

      const { recording } = await Audio.Recording.createAsync(
        {
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
        }
      );

      recordingRef.current = recording;
      silenceFramesRef.current = 0;
      totalFramesRef.current = 0;
      autoStopCalledRef.current = false;

      // 100ms status updates — gives us metering + silence detection
      recording.setProgressUpdateInterval(100);
      recording.setOnRecordingStatusUpdate((s) => {
        if (!s.isRecording) return;

        totalFramesRef.current += 1;

        // Live audio level (normalize dBFS -60..0 → 0..1)
        const db = s.metering ?? -160;
        const normalized = Math.min(1, Math.max(0, (db + 60) / 60));
        setAudioLevel(normalized);

        // Silence detection — only after minimum recording window
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
    } catch (err) {
      console.error("Failed to start recording:", err);
      setIsRecording(false);
      setStatus("idle");
    }
  }, []);

  const stopNativeRecording = useCallback(async () => {
    const recording = recordingRef.current;
    if (!recording) return;
    recordingRef.current = null;
    setAudioLevel(0);

    try {
      await recording.stopAndUnloadAsync();
      const uri = recording.getURI();
      if (!uri) throw new Error("No recording URI");

      setStatus("thinking");

      const formData = new FormData();
      formData.append("audio", {
        uri,
        name: "recording.m4a",
        type: "audio/m4a",
      } as unknown as Blob);

      const transcribeRes = await fetch(`${BASE_URL}/api/assistant/transcribe`, {
        method: "POST",
        body: formData,
      });

      if (!transcribeRes.ok) throw new Error("Transcription failed");
      const { transcript } = await transcribeRes.json() as { transcript: string };

      if (transcript) {
        setCurrentTranscript(transcript);
        await sendMessage(transcript);
      } else {
        setStatus("idle");
      }

      await FileSystem.deleteAsync(uri, { idempotent: true });
    } catch (err) {
      console.error("Recording error:", err);
      setStatus("error");
      addMessage("assistant", "Couldn't understand that. Please try again.");
      setTimeout(() => setStatus("idle"), 2000);
    }
  }, [sendMessage, addMessage]);

  // Keep stopNativeRecordingRef in sync for the metering callback
  useEffect(() => {
    stopNativeRecordingRef.current = stopNativeRecording;
  }, [stopNativeRecording]);

  // ── startListening ─────────────────────────────────────────────────────────
  const startListening = useCallback(async () => {
    if (status !== "idle") return;

    if (Platform.OS === "web") {
      if (typeof window === "undefined" || !("webkitSpeechRecognition" in window)) return;
      setIsRecording(true);
      setStatus("listening");
      setCurrentTranscript("");

      const SR = (window as unknown as { webkitSpeechRecognition: new () => SpeechRecognition }).webkitSpeechRecognition;
      const recognition = new SR();
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.lang = "en-US";

      recognition.onresult = (e: SpeechRecognitionEvent) => {
        let interim = "", final = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          if (e.results[i]?.isFinal) final += e.results[i]?.[0]?.transcript ?? "";
          else interim += e.results[i]?.[0]?.transcript ?? "";
        }
        setCurrentTranscript(final || interim);
        if (final) { setIsRecording(false); void sendMessage(final); }
      };
      recognition.onerror = () => { setIsRecording(false); setStatus("idle"); };
      recognition.onend = () => {
        setIsRecording(false);
        if (status === "listening") setStatus("idle");
      };
      recognition.start();
      (window as unknown as Record<string, unknown>)["_clickyRec"] = recognition;
    } else {
      const granted = hasMicPermission || await requestMicPermission();
      if (!granted) return;

      setIsRecording(true);
      setStatus("listening");
      setCurrentTranscript("");
      await startNativeRecording();
    }
  }, [status, hasMicPermission, requestMicPermission, sendMessage, startNativeRecording]);

  const stopListening = useCallback(async () => {
    if (Platform.OS === "web") {
      setIsRecording(false);
      if (status === "listening") setStatus("idle");
      const rec = (window as unknown as Record<string, unknown>)["_clickyRec"] as { stop?: () => void } | undefined;
      if (rec?.stop) rec.stop();
    } else {
      setIsRecording(false);
      await stopNativeRecording();
    }
  }, [status, stopNativeRecording]);

  // ── Create a fresh session ────────────────────────────────────────────────
  const createNewSession = useCallback(async () => {
    if (soundRef.current) { await soundRef.current.unloadAsync().catch(() => {}); soundRef.current = null; }
    if (recordingRef.current) { await recordingRef.current.stopAndUnloadAsync().catch(() => {}); recordingRef.current = null; }
    const newId = generateId();
    await AsyncStorage.setItem(SESSION_KEY, newId);
    setSessionId(newId);
    setLastReply("");
    setCurrentTranscript("");
    setStatus("idle");
    await AsyncStorage.removeItem(MESSAGES_KEY);
    setMessages([{
      id: generateId(),
      role: "assistant",
      text: "New chat started. What can I help you with?",
      timestamp: Date.now(),
    }]);
  }, []);

  // ── Load an existing session from the API ─────────────────────────────────
  const loadSession = useCallback(async (id: string) => {
    if (soundRef.current) { await soundRef.current.unloadAsync().catch(() => {}); soundRef.current = null; }
    if (recordingRef.current) { await recordingRef.current.stopAndUnloadAsync().catch(() => {}); recordingRef.current = null; }
    setStatus("thinking");
    try {
      const res = await fetch(`${BASE_URL}/api/assistant/sessions/${id}/messages`);
      if (!res.ok) throw new Error("Failed to load session");
      const { messages: raw } = await res.json() as {
        messages: Array<{ id: string; role: string; content: string; created_at: string }>;
      };
      const loaded: Message[] = raw.map((m) => ({
        id: m.id,
        role: m.role as MessageRole,
        text: m.content,
        timestamp: new Date(m.created_at).getTime(),
      }));
      await AsyncStorage.setItem(SESSION_KEY, id);
      setSessionId(id);
      setMessages(loaded.length > 0 ? loaded : [{
        id: generateId(),
        role: "assistant",
        text: "Session loaded. What else can I help you with?",
        timestamp: Date.now(),
      }]);
      setLastReply("");
      setCurrentTranscript("");
      await AsyncStorage.setItem(MESSAGES_KEY, JSON.stringify(loaded.slice(-MAX_MESSAGES)));
    } catch (err) {
      console.error("loadSession error:", err);
    } finally {
      setStatus("idle");
    }
  }, []);

  // ── Fetch all sessions from the API ───────────────────────────────────────
  const fetchSessions = useCallback(async (): Promise<Session[]> => {
    try {
      const res = await fetch(`${BASE_URL}/api/assistant/sessions`);
      if (!res.ok) return [];
      const { sessions } = await res.json() as { sessions: Session[] };
      return sessions;
    } catch {
      return [];
    }
  }, []);

  const clearHistory = useCallback(async () => {
    await createNewSession();
  }, [createNewSession]);

  return (
    <AssistantContext.Provider value={{
      messages,
      status,
      sessionId,
      isRecording,
      startListening: () => { void startListening(); },
      stopListening: () => { void stopListening(); },
      sendMessage,
      clearHistory,
      createNewSession,
      loadSession,
      fetchSessions,
      currentTranscript,
      lastReply,
      hasMicPermission,
      audioLevel,
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
