import React, { useCallback, useEffect, useRef } from "react";
import {
  Animated,
  Easing,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";
import { useAssistant } from "@/context/AssistantContext";

const NUM_BARS = 5;

function AudioBars({ level, color }: { level: number; color: string }) {
  // Each bar has a different multiplier so they animate at different heights
  const multipliers = [0.5, 0.8, 1.0, 0.8, 0.5];
  const anims = useRef(multipliers.map(() => new Animated.Value(0.15))).current;
  const rafRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (rafRef.current) clearTimeout(rafRef.current);
    const targets = multipliers.map((m) => Math.max(0.15, level * m + Math.random() * 0.08));
    const animations = anims.map((anim, i) =>
      Animated.timing(anim, {
        toValue: targets[i] ?? 0.15,
        duration: 80,
        useNativeDriver: false,
        easing: Easing.out(Easing.ease),
      })
    );
    Animated.parallel(animations).start();
    // jitter: re-animate every 120ms while recording
    if (level > 0.05) {
      rafRef.current = setTimeout(() => {}, 120);
    }
  }, [level]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <View style={styles.barsContainer}>
      {anims.map((anim, i) => (
        <Animated.View
          key={i}
          style={[
            styles.bar,
            {
              backgroundColor: color,
              height: anim.interpolate({
                inputRange: [0, 1],
                outputRange: [4, 36],
              }),
            },
          ]}
        />
      ))}
    </View>
  );
}

export function ClickyOverlay() {
  const colors = useColors();
  const {
    status,
    isRecording,
    startListening,
    stopListening,
    currentTranscript,
    lastReply,
    hasMicPermission,
    audioLevel,
  } = useAssistant();

  const [open, setOpen] = React.useState(false);

  const slideAnim = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const fabRotAnim = useRef(new Animated.Value(0)).current;

  // Pulse the orb ring when listening
  useEffect(() => {
    if (status === "listening") {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.18, duration: 700, useNativeDriver: true, easing: Easing.inOut(Easing.ease) }),
          Animated.timing(pulseAnim, { toValue: 1.0, duration: 700, useNativeDriver: true, easing: Easing.inOut(Easing.ease) }),
        ])
      );
      loop.start();
      return () => loop.stop();
    } else {
      Animated.timing(pulseAnim, { toValue: 1, duration: 200, useNativeDriver: true }).start();
    }
  }, [status, pulseAnim]);

  const openOverlay = useCallback(() => {
    setOpen(true);
    Animated.spring(slideAnim, { toValue: 1, useNativeDriver: true, tension: 65, friction: 10 }).start();
    Animated.timing(fabRotAnim, { toValue: 1, duration: 250, useNativeDriver: true }).start();
  }, [slideAnim, fabRotAnim]);

  const closeOverlay = useCallback(() => {
    if (status === "listening") stopListening();
    Animated.spring(slideAnim, { toValue: 0, useNativeDriver: true, bounciness: 0 }).start(() => setOpen(false));
    Animated.timing(fabRotAnim, { toValue: 0, duration: 200, useNativeDriver: true }).start();
  }, [slideAnim, fabRotAnim, status, stopListening]);

  const handleOrbPress = useCallback(() => {
    if (status === "listening" || isRecording) {
      stopListening();
    } else if (status === "idle") {
      startListening();
    }
  }, [status, isRecording, startListening, stopListening]);

  const panelTranslate = slideAnim.interpolate({ inputRange: [0, 1], outputRange: [340, 0] });

  const orbBg =
    status === "listening" ? colors.primary :
    status === "thinking" ? "#f59e0b" :
    status === "speaking" ? "#10b981" :
    colors.surfaceHigh;

  const statusLabel =
    status === "listening" ? "Listening — stop speaking to send" :
    status === "thinking" ? "Thinking..." :
    status === "speaking" ? "Speaking..." :
    hasMicPermission ? "Tap mic to speak" : "Tap to allow microphone";

  const showBars = status === "listening";
  const showTranscript = !!currentTranscript && status !== "listening";
  const showReply = !!lastReply && status !== "listening";

  return (
    <>
      {/* FAB */}
      {!open && (
        <View style={styles.fab}>
          <TouchableOpacity
            onPress={openOverlay}
            style={[styles.fabButton, { backgroundColor: colors.primary, shadowColor: colors.primary }]}
            activeOpacity={0.85}
          >
            <Ionicons name="sparkles" size={20} color="#fff" />
          </TouchableOpacity>
        </View>
      )}

      {/* Slide-up panel */}
      {open && (
        <Animated.View
          style={[
            styles.panel,
            {
              backgroundColor: colors.surface,
              borderColor: colors.border,
              transform: [{ translateY: panelTranslate }],
            },
          ]}
        >
          {/* Drag handle */}
          <View style={styles.handleRow}>
            <View style={[styles.handle, { backgroundColor: colors.border }]} />
          </View>

          {/* Header */}
          <View style={styles.header}>
            <View style={styles.titleRow}>
              <View style={[styles.iconBadge, { backgroundColor: colors.primary }]}>
                <Ionicons name="sparkles" size={12} color="#fff" />
              </View>
              <Text style={[styles.title, { color: colors.foreground }]}>Clicky</Text>
            </View>
            <TouchableOpacity onPress={closeOverlay} style={[styles.closeBtn, { backgroundColor: colors.surfaceHigh }]}>
              <Ionicons name="chevron-down" size={16} color={colors.mutedForeground} />
            </TouchableOpacity>
          </View>

          {/* Content */}
          <View style={styles.content}>
            {/* Live audio bars while recording */}
            {showBars && (
              <View style={styles.listeningBlock}>
                <AudioBars level={audioLevel} color={colors.primary} />
                <Text style={[styles.listeningHint, { color: colors.mutedForeground }]}>
                  Stop speaking and it will auto-send
                </Text>
              </View>
            )}

            {/* Transcript after recording */}
            {showTranscript && (
              <View style={[styles.transcriptBubble, { backgroundColor: colors.primary + "22" }]}>
                <Text style={[styles.transcriptText, { color: colors.mutedForeground }]} numberOfLines={2}>
                  "{currentTranscript}"
                </Text>
              </View>
            )}

            {/* AI response */}
            {showReply && (
              <Text style={[styles.replyText, { color: colors.foreground }]} numberOfLines={5}>
                {lastReply}
              </Text>
            )}

            {/* Idle hint */}
            {!showBars && !showTranscript && !showReply && status === "idle" && (
              <Text style={[styles.hintText, { color: colors.mutedForeground }]}>
                Ask me anything — I'm here to help
              </Text>
            )}

            {/* Thinking/speaking label */}
            {(status === "thinking" || status === "speaking") && !showReply && (
              <Text style={[styles.hintText, { color: colors.mutedForeground }]}>
                {status === "thinking" ? "Processing your message..." : "Playing response..."}
              </Text>
            )}
          </View>

          {/* Status label */}
          <Text style={[styles.statusLabel, { color: colors.mutedForeground }]}>{statusLabel}</Text>

          {/* Voice orb */}
          <View style={styles.orbRow}>
            <TouchableOpacity
              onPress={handleOrbPress}
              activeOpacity={0.85}
              disabled={status === "thinking" || status === "speaking"}
            >
              <Animated.View
                style={[
                  styles.orbOuter,
                  {
                    borderColor: orbBg,
                    shadowColor: orbBg,
                    transform: [{ scale: pulseAnim }],
                  },
                ]}
              >
                <View style={[styles.orbInner, { backgroundColor: orbBg }]}>
                  <Ionicons
                    name={
                      status === "listening" ? "stop" :
                      status === "thinking" ? "hourglass-outline" :
                      status === "speaking" ? "volume-high" :
                      "mic"
                    }
                    size={28}
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
    bottom: 220,
    right: 18,
    zIndex: 9999,
    elevation: 20,
  },
  fabButton: {
    width: 54,
    height: 54,
    borderRadius: 27,
    alignItems: "center",
    justifyContent: "center",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.5,
    shadowRadius: 12,
    elevation: 20,
  },
  panel: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 999,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: 1,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    paddingHorizontal: 20,
    paddingBottom: 44,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -6 },
    shadowOpacity: 0.3,
    shadowRadius: 20,
    elevation: 30,
  },
  handleRow: {
    alignItems: "center",
    paddingTop: 10,
    paddingBottom: 4,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 10,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  iconBadge: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    letterSpacing: -0.3,
  },
  closeBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  content: {
    minHeight: 90,
    marginBottom: 8,
    gap: 10,
    justifyContent: "center",
  },
  listeningBlock: {
    alignItems: "center",
    gap: 10,
  },
  barsContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    height: 40,
  },
  bar: {
    width: 5,
    borderRadius: 3,
  },
  listeningHint: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
  },
  transcriptBubble: {
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  transcriptText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    fontStyle: "italic",
    lineHeight: 20,
  },
  replyText: {
    fontSize: 17,
    fontFamily: "Inter_600SemiBold",
    lineHeight: 26,
    letterSpacing: -0.3,
  },
  hintText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    lineHeight: 22,
  },
  statusLabel: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    marginBottom: 12,
    letterSpacing: 0.2,
  },
  orbRow: {
    alignItems: "center",
  },
  orbOuter: {
    width: 76,
    height: 76,
    borderRadius: 38,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.5,
    shadowRadius: 14,
    elevation: 8,
  },
  orbInner: {
    width: 62,
    height: 62,
    borderRadius: 31,
    alignItems: "center",
    justifyContent: "center",
  },
});
