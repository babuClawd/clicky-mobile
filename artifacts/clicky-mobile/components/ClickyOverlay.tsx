import React, { useCallback, useEffect, useRef, useState } from "react";
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
  } = useAssistant();

  const [open, setOpen] = useState(false);

  // Animations
  const slideAnim = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;

  // Pulse when listening
  useEffect(() => {
    if (status === "listening") {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.2, duration: 650, useNativeDriver: true, easing: Easing.inOut(Easing.ease) }),
          Animated.timing(pulseAnim, { toValue: 1.0, duration: 650, useNativeDriver: true, easing: Easing.inOut(Easing.ease) }),
        ])
      );
      loop.start();
      return () => loop.stop();
    } else {
      pulseAnim.setValue(1);
    }
  }, [status, pulseAnim]);

  const openOverlay = useCallback(() => {
    setOpen(true);
    Animated.spring(slideAnim, { toValue: 1, useNativeDriver: true, tension: 65, friction: 10 }).start();
  }, [slideAnim]);

  const closeOverlay = useCallback(() => {
    if (status === "listening") stopListening();
    Animated.spring(slideAnim, { toValue: 0, useNativeDriver: true, bounciness: 0 }).start(() => setOpen(false));
  }, [slideAnim, status, stopListening]);

  const handleOrbPress = useCallback(() => {
    if (status === "listening" || isRecording) {
      stopListening();
    } else if (status === "idle") {
      startListening();
    }
  }, [status, isRecording, startListening, stopListening]);

  const panelTranslate = slideAnim.interpolate({ inputRange: [0, 1], outputRange: [320, 0] });

  const orbBg =
    status === "listening" ? colors.primary :
    status === "thinking" ? "#f59e0b" :
    status === "speaking" ? "#10b981" :
    colors.surfaceHigh;

  const statusLabel =
    status === "listening" ? "Listening..." :
    status === "thinking" ? "Thinking..." :
    status === "speaking" ? "Speaking..." :
    hasMicPermission ? "Tap mic to speak" : "Tap mic (needs permission)";

  return (
    <>
      {/* Floating action button */}
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

      {/* Slide-up overlay panel */}
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
              <Text style={[styles.statusText, { color: colors.mutedForeground }]}>{statusLabel}</Text>
            </View>
            <TouchableOpacity onPress={closeOverlay} style={[styles.closeBtn, { backgroundColor: colors.surfaceHigh }]}>
              <Ionicons name="chevron-down" size={16} color={colors.mutedForeground} />
            </TouchableOpacity>
          </View>

          {/* Content area */}
          <View style={styles.content}>
            {/* User transcript */}
            {currentTranscript ? (
              <View style={[styles.transcriptBubble, { backgroundColor: colors.primary + "22" }]}>
                <Text style={[styles.transcriptText, { color: colors.mutedForeground }]} numberOfLines={2}>
                  "{currentTranscript}"
                </Text>
              </View>
            ) : null}

            {/* AI response */}
            {lastReply ? (
              <Text style={[styles.replyText, { color: colors.foreground }]} numberOfLines={5}>
                {lastReply}
              </Text>
            ) : !currentTranscript ? (
              <Text style={[styles.hintText, { color: colors.mutedForeground }]}>
                Ask me anything — I'm here to help
              </Text>
            ) : null}
          </View>

          {/* Voice orb */}
          <View style={styles.orbRow}>
            <TouchableOpacity onPress={handleOrbPress} activeOpacity={0.85} disabled={status === "thinking" || status === "speaking"}>
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
                    size={26}
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
    bottom: 96,
    right: 18,
    zIndex: 998,
  },
  fabButton: {
    width: 50,
    height: 50,
    borderRadius: 25,
    alignItems: "center",
    justifyContent: "center",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 10,
    elevation: 8,
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
    paddingBottom: 40,
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
  statusText: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    marginLeft: 2,
  },
  closeBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  content: {
    minHeight: 80,
    marginBottom: 20,
    gap: 10,
    justifyContent: "center",
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
