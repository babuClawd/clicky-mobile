import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";
import type { Message } from "@/context/AssistantContext";

interface MessageBubbleProps {
  message: Message;
}

function timeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 60_000) {
    return "just now";
  }
  if (diff < 3_600_000) {
    return `${Math.floor(diff / 60_000)}m ago`;
  }
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const colors = useColors();
  const isUser = message.role === "user";
  const attachment = message.meta?.attachment;
  const liveSources = message.meta?.sources ?? [];
  const liveHosts = liveSources.map((source) => source.host).slice(0, 2).join(", ");
  const liveLabel = message.meta?.usedLiveInfo
    ? liveHosts
      ? `Live web • ${liveHosts}`
      : "Live web"
    : "";

  return (
    <View
      style={[
        styles.container,
        isUser ? styles.userContainer : styles.assistantContainer,
      ]}
    >
      {!isUser ? (
        <View
          style={[
            styles.avatar,
            { backgroundColor: colors.primary, shadowColor: colors.primary },
          ]}
        >
          <Ionicons name="sparkles" size={14} color="#fff" />
        </View>
      ) : null}

      <View
        style={[
          styles.bubble,
          isUser
            ? [styles.userBubble, { backgroundColor: colors.primary }]
            : [
                styles.assistantBubble,
                { backgroundColor: colors.surface, borderColor: colors.border },
              ],
        ]}
      >
        {attachment ? (
          <Image source={{ uri: attachment.uri }} style={styles.attachmentImage} />
        ) : null}

        <Text
          style={[
            styles.text,
            { color: isUser ? "#fff" : colors.foreground },
          ]}
        >
          {message.text}
        </Text>

        {!isUser && liveLabel ? (
          <View
            style={[
              styles.liveInfoPill,
              {
                backgroundColor: colors.secondary,
                borderColor: colors.border,
              },
            ]}
          >
            <Ionicons name="globe-outline" size={12} color={colors.accent} />
            <Text style={[styles.liveInfoText, { color: colors.mutedForeground }]}>
              {liveLabel}
            </Text>
          </View>
        ) : null}

        <Text
          style={[
            styles.time,
            { color: isUser ? "rgba(255,255,255,0.5)" : colors.mutedForeground },
          ]}
        >
          {timeAgo(message.timestamp)}
        </Text>
      </View>

      {isUser ? (
        <View
          style={[
            styles.avatar,
            { backgroundColor: colors.secondary, shadowColor: colors.primary },
          ]}
        >
          <Ionicons name="person" size={14} color={colors.mutedForeground} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  assistantBubble: {
    borderWidth: 1,
    borderBottomLeftRadius: 4,
  },
  assistantContainer: {
    justifyContent: "flex-start",
  },
  attachmentImage: {
    width: 180,
    height: 180,
    borderRadius: 14,
  },
  avatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 4,
  },
  bubble: {
    maxWidth: "72%",
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 8,
  },
  container: {
    flexDirection: "row",
    alignItems: "flex-end",
    marginVertical: 6,
    paddingHorizontal: 16,
    gap: 8,
  },
  liveInfoPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "flex-start",
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  liveInfoText: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
  },
  text: {
    fontSize: 15,
    lineHeight: 21,
    fontFamily: "Inter_400Regular",
  },
  time: {
    fontSize: 10,
    fontFamily: "Inter_400Regular",
    alignSelf: "flex-end",
  },
  userBubble: {
    borderBottomRightRadius: 4,
  },
  userContainer: {
    justifyContent: "flex-end",
  },
});
