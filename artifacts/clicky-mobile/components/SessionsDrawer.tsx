import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Dimensions,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";
import { useAssistant } from "@/context/AssistantContext";
import type { Session } from "@/context/AssistantContext";

const DRAWER_WIDTH = Math.min(Dimensions.get("window").width * 0.82, 320);

interface SessionsDrawerProps {
  visible: boolean;
  onClose: () => void;
}

function formatSessionDate(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function SessionItem({
  session,
  isActive,
  onPress,
}: {
  session: Session;
  isActive: boolean;
  onPress: () => void;
}) {
  const colors = useColors();
  const count = parseInt(session.message_count, 10);
  const label = `${count} message${count !== 1 ? "s" : ""}`;

  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      style={[
        styles.sessionItem,
        {
          backgroundColor: isActive ? colors.primary + "22" : "transparent",
          borderColor: isActive ? colors.primary + "44" : "transparent",
        },
      ]}
    >
      <View style={[styles.sessionIcon, { backgroundColor: isActive ? colors.primary : colors.surfaceHigh }]}>
        <Ionicons name="chatbubble-outline" size={14} color={isActive ? "#fff" : colors.mutedForeground} />
      </View>
      <View style={styles.sessionInfo}>
        <Text style={[styles.sessionDate, { color: isActive ? colors.primary : colors.foreground }]} numberOfLines={1}>
          {formatSessionDate(session.updated_at)}
        </Text>
        <Text style={[styles.sessionMeta, { color: colors.mutedForeground }]}>
          {label}
        </Text>
      </View>
      {isActive && (
        <View style={[styles.activeDot, { backgroundColor: colors.primary }]} />
      )}
    </TouchableOpacity>
  );
}

export function SessionsDrawer({ visible, onClose }: SessionsDrawerProps) {
  const colors = useColors();
  const { sessionId, loadSession, createNewSession, fetchSessions } = useAssistant();

  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(false);

  const slideAnim = useRef(new Animated.Value(-DRAWER_WIDTH)).current;
  const backdropAnim = useRef(new Animated.Value(0)).current;

  const load = useCallback(async () => {
    setLoading(true);
    const data = await fetchSessions();
    setSessions(data);
    setLoading(false);
  }, [fetchSessions]);

  useEffect(() => {
    if (visible) {
      void load();
      Animated.parallel([
        Animated.spring(slideAnim, { toValue: 0, useNativeDriver: true, tension: 70, friction: 12 }),
        Animated.timing(backdropAnim, { toValue: 1, duration: 250, useNativeDriver: true }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.spring(slideAnim, { toValue: -DRAWER_WIDTH, useNativeDriver: true, bounciness: 0 }),
        Animated.timing(backdropAnim, { toValue: 0, duration: 200, useNativeDriver: true }),
      ]).start();
    }
  }, [visible, load, slideAnim, backdropAnim]);

  const handleSelectSession = useCallback(async (id: string) => {
    onClose();
    await loadSession(id);
  }, [loadSession, onClose]);

  const handleNewChat = useCallback(async () => {
    onClose();
    await createNewSession();
  }, [createNewSession, onClose]);

  if (!visible && !loading) {
    // Keep in tree for animation, but let it be off-screen
  }

  return (
    <>
      {/* Backdrop */}
      <Animated.View
        pointerEvents={visible ? "auto" : "none"}
        style={[styles.backdrop, { opacity: backdropAnim }]}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
      </Animated.View>

      {/* Drawer panel */}
      <Animated.View
        style={[
          styles.drawer,
          {
            width: DRAWER_WIDTH,
            backgroundColor: colors.surface,
            borderRightColor: colors.border,
            transform: [{ translateX: slideAnim }],
          },
        ]}
        pointerEvents={visible ? "auto" : "none"}
      >
        {/* Header */}
        <View style={[styles.drawerHeader, { borderBottomColor: colors.border }]}>
          <View style={styles.drawerTitleRow}>
            <View style={[styles.drawerIcon, { backgroundColor: colors.primary }]}>
              <Ionicons name="sparkles" size={12} color="#fff" />
            </View>
            <Text style={[styles.drawerTitle, { color: colors.foreground }]}>Chats</Text>
          </View>
          <TouchableOpacity onPress={onClose} style={[styles.closeBtn, { backgroundColor: colors.surfaceHigh }]}>
            <Ionicons name="close" size={16} color={colors.mutedForeground} />
          </TouchableOpacity>
        </View>

        {/* New chat button */}
        <View style={styles.newChatSection}>
          <TouchableOpacity
            onPress={() => void handleNewChat()}
            activeOpacity={0.8}
            style={[styles.newChatBtn, { backgroundColor: colors.primary }]}
          >
            <Ionicons name="add" size={18} color="#fff" />
            <Text style={styles.newChatText}>New Chat</Text>
          </TouchableOpacity>
        </View>

        {/* Sessions list */}
        <View style={styles.listSection}>
          <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>RECENT</Text>

          {loading ? (
            <View style={styles.loadingRow}>
              <ActivityIndicator size="small" color={colors.primary} />
              <Text style={[styles.loadingText, { color: colors.mutedForeground }]}>Loading...</Text>
            </View>
          ) : sessions.length === 0 ? (
            <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
              No past chats yet
            </Text>
          ) : (
            sessions.map((s) => (
              <SessionItem
                key={s.id}
                session={s}
                isActive={s.id === sessionId}
                onPress={() => void handleSelectSession(s.id)}
              />
            ))
          )}
        </View>

        {/* Footer hint */}
        <View style={[styles.footer, { borderTopColor: colors.border }]}>
          <Text style={[styles.footerText, { color: colors.mutedForeground }]}>
            {Platform.OS === "web" ? "Powered by ElevenLabs" : "Tap a chat to resume it"}
          </Text>
        </View>
      </Animated.View>
    </>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.55)",
    zIndex: 1000,
  },
  drawer: {
    position: "absolute",
    top: 0,
    left: 0,
    bottom: 0,
    zIndex: 1001,
    borderRightWidth: 1,
    flexDirection: "column",
  },
  drawerHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: Platform.OS === "web" ? 20 : 56,
    paddingBottom: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  drawerTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  drawerIcon: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  drawerTitle: {
    fontSize: 16,
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
  newChatSection: {
    padding: 14,
  },
  newChatBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderRadius: 12,
    paddingVertical: 12,
  },
  newChatText: {
    color: "#fff",
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
  },
  listSection: {
    flex: 1,
    paddingHorizontal: 12,
  },
  sectionLabel: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 1.2,
    marginBottom: 6,
    marginLeft: 4,
  },
  sessionItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 10,
    paddingVertical: 11,
    borderRadius: 10,
    marginBottom: 2,
    borderWidth: 1,
  },
  sessionIcon: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  sessionInfo: {
    flex: 1,
  },
  sessionDate: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
  },
  sessionMeta: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    marginTop: 1,
  },
  activeDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    flexShrink: 0,
  },
  loadingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 16,
    paddingLeft: 4,
  },
  loadingText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
  },
  emptyText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    paddingVertical: 16,
    paddingLeft: 4,
  },
  footer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    padding: 16,
  },
  footerText: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
  },
});
