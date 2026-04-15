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

interface AssistantContextValue {
  messages: Message[];
  status: AssistantStatus;
  sessionId: string;
  isRecording: boolean;
  startListening: () => void;
  stopListening: () => void;
  sendMessage: (text: string) => Promise<void>;
  clearHistory: () => Promise<void>;
  currentTranscript: string;
  lastReply: string;
  hasMicPermission: boolean;
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
  const [hasMicPermission, setHasMicPermission] = useState(false);

  const soundRef = useRef<Audio.Sound | null>(null);
  const recordingRef = useRef<Audio.Recording | null>(null);

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
      // Configure audio playback mode
      if (Platform.OS !== "web") {
        await Audio.setAudioModeAsync({
          allowsRecordingIOS: false,
          playsInSilentModeIOS: true,
          shouldDuckAndroid: true,
          playThroughEarpieceAndroid: false,
        });

        // Check mic permission status (don't prompt yet — wait for first use)
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

    try {
      // Step 1: Text reply
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

      // Step 2: TTS audio
      const ttsRes = await fetch(`${BASE_URL}/api/assistant/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: reply }),
      });

      if (ttsRes.ok) {
        if (Platform.OS === "web") {
          await playAudioBlob(await ttsRes.blob());
        } else {
          const { FileSystem } = await import("expo-file-system");
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

  // ── Native recording helpers ───────────────────────────────────────────────
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
      });
      recordingRef.current = recording;
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

    try {
      await recording.stopAndUnloadAsync();
      const uri = recording.getURI();
      if (!uri) throw new Error("No recording URI");

      setStatus("thinking");

      // Upload audio to ElevenLabs STT via our backend
      const { FileSystem } = await import("expo-file-system");
      const base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });

      const formData = new FormData();
      // React Native FormData supports { uri, name, type } blobs
      formData.append("audio", {
        uri,
        name: "recording.m4a",
        type: "audio/m4a",
      } as unknown as Blob);

      const transcribeRes = await fetch(`${BASE_URL}/api/assistant/transcribe`, {
        method: "POST",
        body: formData,
      });

      void base64; // just for silence on unused

      if (!transcribeRes.ok) throw new Error("Transcription failed");
      const { transcript } = await transcribeRes.json() as { transcript: string };

      if (transcript) {
        setCurrentTranscript(transcript);
        await sendMessage(transcript);
      } else {
        setStatus("idle");
      }

      // Clean up recording file
      await FileSystem.deleteAsync(uri, { idempotent: true });
    } catch (err) {
      console.error("Recording error:", err);
      setStatus("error");
      addMessage("assistant", "Couldn't understand that. Please try again.");
      setTimeout(() => setStatus("idle"), 2000);
    }
  }, [sendMessage, addMessage]);

  // ── startListening: web uses SpeechRecognition, native uses expo-av ────────
  const startListening = useCallback(async () => {
    if (status !== "idle") return;

    if (Platform.OS === "web") {
      // Web: webkitSpeechRecognition
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
      // Native: request mic permission then start expo-av recording
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

  const clearHistory = useCallback(async () => {
    if (soundRef.current) { await soundRef.current.unloadAsync().catch(() => {}); soundRef.current = null; }
    if (recordingRef.current) { await recordingRef.current.stopAndUnloadAsync().catch(() => {}); recordingRef.current = null; }
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
      startListening: () => { void startListening(); },
      stopListening: () => { void stopListening(); },
      sendMessage,
      clearHistory,
      currentTranscript,
      lastReply,
      hasMicPermission,
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
