import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Audio } from "expo-av";
import { BASE_URL } from "@/context/AssistantContext";
import { useColors } from "@/hooks/useColors";

type OverlayStatus = "idle" | "listening" | "thinking" | "speaking";

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
}

const SESSION_KEY_OVERLAY = "clicky_overlay_session";

export function ClickyOverlay() {
  const colors = useColors();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<OverlayStatus>("idle");
  const [transcript, setTranscript] = useState("");
  const [response, setResponse] = useState("");
  const [sessionId] = useState(() => generateId());

  // Animations
  const slideAnim = useRef(new Animated.Value(0)).current;
  const fabScale = useRef(new Animated.Value(1)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const orbGlow = useRef(new Animated.Value(0)).current;

  const soundRef = useRef<Audio.Sound | null>(null);

  // Pulse animation for the orb
  useEffect(() => {
    if (status === "listening") {
      const pulse = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.25, duration: 700, useNativeDriver: true, easing: Easing.inOut(Easing.ease) }),
          Animated.timing(pulseAnim, { toValue: 1.0, duration: 700, useNativeDriver: true, easing: Easing.inOut(Easing.ease) }),
        ])
      );
      pulse.start();
      return () => pulse.stop();
    } else if (status === "speaking") {
      const glow = Animated.loop(
        Animated.sequence([
          Animated.timing(orbGlow, { toValue: 1, duration: 500, useNativeDriver: true }),
          Animated.timing(orbGlow, { toValue: 0.3, duration: 500, useNativeDriver: true }),
        ])
      );
      glow.start();
      return () => glow.stop();
    } else {
      pulseAnim.setValue(1);
      orbGlow.setValue(0);
    }
  }, [status, pulseAnim, orbGlow]);

  const toggleOpen = useCallback(() => {
    if (open) {
      Animated.spring(slideAnim, { toValue: 0, useNativeDriver: true, bounciness: 0 }).start(() => setOpen(false));
    } else {
      setOpen(true);
      Animated.spring(slideAnim, { toValue: 1, useNativeDriver: true, tension: 65, friction: 10 }).start();
    }
  }, [open, slideAnim]);

  const playAudio = useCallback(async (text: string) => {
    try {
      const res = await fetch(`${BASE_URL}/api/assistant/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) return;

      if (Platform.OS === "web") {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const audio = new window.Audio(url);
        audio.onended = () => { URL.revokeObjectURL(url); setStatus("idle"); };
        audio.onerror = () => setStatus("idle");
        void audio.play();
      } else {
        await Audio.setAudioModeAsync({ playsInSilentModeIOS: true, allowsRecordingIOS: false });
        const buffer = await res.arrayBuffer();
        const { FileSystem } = await import("expo-file-system");
        const uri = `${FileSystem.cacheDirectory ?? ""}overlay_${Date.now()}.mp3`;
        const bytes = new Uint8Array(buffer);
        let binary = "";
        for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]!);
        await FileSystem.writeAsStringAsync(uri, btoa(binary), { encoding: FileSystem.EncodingType.Base64 });
        if (soundRef.current) { await soundRef.current.unloadAsync(); soundRef.current = null; }
        const { sound } = await Audio.Sound.createAsync({ uri }, { shouldPlay: true, volume: 1.0 });
        soundRef.current = sound;
        sound.setOnPlaybackStatusUpdate((s) => {
          if (s.isLoaded && s.didJustFinish) { void sound.unloadAsync(); soundRef.current = null; setStatus("idle"); }
        });
      }
    } catch {
      setStatus("idle");
    }
  }, []);

  const handleSpeak = useCallback(async (text: string) => {
    if (!text.trim()) return;
    setTranscript(text);
    setStatus("thinking");

    try {
      const res = await fetch(`${BASE_URL}/api/assistant/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, sessionId }),
      });
      if (!res.ok) throw new Error("Chat failed");
      const { reply } = await res.json() as { reply: string };
      setResponse(reply);
      setStatus("speaking");
      await playAudio(reply);
    } catch {
      setStatus("error" as OverlayStatus);
      setResponse("Couldn't connect. Please try again.");
      setTimeout(() => setStatus("idle"), 2000);
    }
  }, [sessionId, playAudio]);

  const startListeningOverlay = useCallback(() => {
    if (status !== "idle") return;
    setStatus("listening");
    setTranscript("");
    setResponse("");

    if (Platform.OS === "web" && typeof window !== "undefined" && "webkitSpeechRecognition" in window) {
      const SR = (window as unknown as { webkitSpeechRecognition: new () => SpeechRecognition }).webkitSpeechRecognition;
      const rec = new SR();
      rec.continuous = false;
      rec.interimResults = true;
      rec.lang = "en-US";

      rec.onresult = (e: SpeechRecognitionEvent) => {
        let interim = "", final = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          if (e.results[i]?.isFinal) final += e.results[i]?.[0]?.transcript ?? "";
          else interim += e.results[i]?.[0]?.transcript ?? "";
        }
        setTranscript(final || interim);
        if (final) void handleSpeak(final);
      };

      rec.onerror = () => setStatus("idle");
      rec.onend = () => { if (status === "listening") setStatus("idle"); };
      rec.start();
      (window as unknown as Record<string, unknown>)["_overlayRec"] = rec;
    }
  }, [status, handleSpeak]);

  const stopListeningOverlay = useCallback(() => {
    setStatus("idle");
    const rec = (window as unknown as Record<string, unknown>)["_overlayRec"] as { stop?: () => void } | undefined;
    if (rec?.stop) rec.stop();
  }, []);

  const handleOrbPress = useCallback(() => {
    if (status === "listening") stopListeningOverlay();
    else if (status === "idle") startListeningOverlay();
  }, [status, startListeningOverlay, stopListeningOverlay]);

  const panelTranslateY = slideAnim.interpolate({ inputRange: [0, 1], outputRange: [340, 0] });
  const fabOpacity = slideAnim.interpolate({ inputRange: [0, 0.5], outputRange: [1, 0] });

  const statusLabel = {
    idle: "Tap to speak to Clicky",
    listening: "Listening...",
    thinking: "Thinking...",
    speaking: "Speaking...",
  }[status] ?? "Tap to speak";

  const orbColor =
    status === "listening" ? colors.primary :
    status === "thinking" ? "#f59e0b" :
    status === "speaking" ? "#10b981" :
    colors.surface;

  return (
    <>
      {/* Floating action button — shown when overlay is closed */}
      {!open && (
        <Animated.View style={[styles.fab, { opacity: fabOpacity }]}>
          <TouchableOpacity
            onPress={toggleOpen}
            style={[styles.fabButton, { backgroundColor: colors.primary, shadowColor: colors.primary }]}
            activeOpacity={0.85}
          >
            <Animated.View style={{ transform: [{ scale: fabScale }] }}>
              <Ionicons name="sparkles" size={22} color="#fff" />
            </Animated.View>
          </TouchableOpacity>
        </Animated.View>
      )}

      {/* Overlay panel — slides up from bottom */}
      {open && (
        <Animated.View
          style={[
            styles.panel,
            { backgroundColor: colors.surface, borderColor: colors.border, transform: [{ translateY: panelTranslateY }] },
          ]}
        >
          {/* Header */}
          <View style={styles.panelHeader}>
            <View style={styles.panelTitleRow}>
              <View style={[styles.panelIcon, { backgroundColor: colors.primary }]}>
                <Ionicons name="sparkles" size={13} color="#fff" />
              </View>
              <Text style={[styles.panelTitle, { color: colors.foreground }]}>Clicky</Text>
              <Text style={[styles.panelStatus, { color: colors.mutedForeground }]}>{statusLabel}</Text>
            </View>
            <TouchableOpacity onPress={toggleOpen} style={[styles.closeBtn, { backgroundColor: colors.surfaceHigh }]}>
              <Ionicons name="close" size={16} color={colors.mutedForeground} />
            </TouchableOpacity>
          </View>

          {/* Transcript / Response area */}
          <View style={styles.textArea}>
            {transcript ? (
              <Text style={[styles.transcriptText, { color: colors.mutedForeground }]} numberOfLines={2}>
                "{transcript}"
              </Text>
            ) : null}
            {response ? (
              <Text style={[styles.responseText, { color: colors.foreground }]} numberOfLines={4}>
                {response}
              </Text>
            ) : !transcript ? (
              <Text style={[styles.hintText, { color: colors.mutedForeground }]}>
                Ask me anything — I'm always here
              </Text>
            ) : null}
          </View>

          {/* Voice orb */}
          <View style={styles.orbRow}>
            <TouchableOpacity onPress={handleOrbPress} activeOpacity={0.85}>
              <Animated.View
                style={[
                  styles.orbOuter,
                  {
                    transform: [{ scale: pulseAnim }],
                    borderColor: orbColor,
                    shadowColor: orbColor,
                  },
                ]}
              >
                <View style={[styles.orbInner, { backgroundColor: orbColor }]}>
                  <Ionicons
                    name={status === "listening" ? "stop" : "mic"}
                    size={24}
                    color="#fff"
                  />
                </View>
              </Animated.View>
            </TouchableOpacity>
          </View>
        </Animated.View>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  fab: {
    position: "absolute",
    bottom: 100,
    right: 20,
    zIndex: 999,
  },
  fabButton: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: "center",
    justifyContent: "center",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.45,
    shadowRadius: 12,
    elevation: 8,
  },
  panel: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 1000,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: 1,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    paddingHorizontal: 20,
    paddingBottom: 36,
    paddingTop: 8,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.3,
    shadowRadius: 16,
    elevation: 24,
  },
  panelHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: 8,
    paddingBottom: 12,
  },
  panelTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  panelIcon: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  panelTitle: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    letterSpacing: -0.3,
  },
  panelStatus: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    marginLeft: 4,
  },
  closeBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  textArea: {
    minHeight: 72,
    marginBottom: 20,
    gap: 8,
  },
  transcriptText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    fontStyle: "italic",
    lineHeight: 20,
  },
  responseText: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    lineHeight: 24,
    letterSpacing: -0.2,
  },
  hintText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    marginTop: 12,
  },
  orbRow: {
    alignItems: "center",
    paddingBottom: 4,
  },
  orbOuter: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.5,
    shadowRadius: 12,
    elevation: 6,
  },
  orbInner: {
    width: 60,
    height: 60,
    borderRadius: 30,
    alignItems: "center",
    justifyContent: "center",
  },
});
