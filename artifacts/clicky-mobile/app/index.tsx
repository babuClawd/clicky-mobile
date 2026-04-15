import React, { useRef, useState } from "react";
import {
  FlatList,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useColors } from "@/hooks/useColors";
import { useAssistant } from "@/context/AssistantContext";
import { VoiceOrb } from "@/components/VoiceOrb";
import { MessageBubble } from "@/components/MessageBubble";
import { AssistantStatusBar } from "@/components/StatusBar";
import { ChatInput } from "@/components/TextInput";
import { SessionsDrawer } from "@/components/SessionsDrawer";
import type { Message } from "@/context/AssistantContext";

export default function AssistantScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const {
    messages,
    status,
    isRecording,
    startListening,
    stopListening,
    sendMessage,
    createNewSession,
    currentTranscript,
  } = useAssistant();

  const [drawerOpen, setDrawerOpen] = useState(false);
  const flatListRef = useRef<FlatList<Message>>(null);

  const handleOrbPress = () => {
    if (isRecording || status === "listening") {
      stopListening();
    } else if (status === "idle") {
      startListening();
    }
  };

  const isDisabled = status !== "idle";
  const topPad = Platform.OS === "web" ? 60 : insets.top;
  const bottomPad = Platform.OS === "web" ? 20 : insets.bottom;

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View
        style={[
          styles.header,
          {
            paddingTop: topPad + 12,
            borderBottomColor: colors.border,
            backgroundColor: colors.background,
          },
        ]}
      >
        {/* Left: sessions menu */}
        <TouchableOpacity
          onPress={() => setDrawerOpen(true)}
          style={[styles.headerBtn, { backgroundColor: colors.surface }]}
          activeOpacity={0.7}
        >
          <Ionicons name="menu-outline" size={20} color={colors.mutedForeground} />
        </TouchableOpacity>

        {/* Centre: logo + title */}
        <View style={styles.headerCenter}>
          <View style={[styles.headerOrb, { backgroundColor: colors.primary, shadowColor: colors.primary }]}>
            <Ionicons name="sparkles" size={13} color="#fff" />
          </View>
          <View>
            <Text style={[styles.headerTitle, { color: colors.foreground }]}>Clicky</Text>
            <Text style={[styles.headerSub, { color: colors.mutedForeground }]}>Your AI assistant</Text>
          </View>
        </View>

        {/* Right: new chat */}
        <TouchableOpacity
          onPress={() => void createNewSession()}
          style={[styles.headerBtn, { backgroundColor: colors.surface }]}
          activeOpacity={0.7}
        >
          <Ionicons name="create-outline" size={20} color={colors.mutedForeground} />
        </TouchableOpacity>
      </View>

      <KeyboardAvoidingView style={styles.flex} behavior="padding" keyboardVerticalOffset={0}>
        <FlatList
          ref={flatListRef}
          data={[...messages].reverse()}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => <MessageBubble message={item} />}
          inverted
          contentContainerStyle={styles.messageList}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          scrollEnabled={messages.length > 0}
          ListHeaderComponent={
            <AssistantStatusBar status={status} transcript={currentTranscript} />
          }
          ListFooterComponent={<View style={{ height: 8 }} />}
        />

        <View style={[styles.voiceSection, { borderTopColor: colors.border }]}>
          <VoiceOrb status={status} onPress={handleOrbPress} size={80} />
        </View>

        <View style={[styles.inputSection, { paddingBottom: bottomPad + 4 }]}>
          <ChatInput onSend={sendMessage} disabled={isDisabled} />
        </View>
      </KeyboardAvoidingView>

      {/* Sessions drawer — rendered last so it floats above content */}
      <SessionsDrawer visible={drawerOpen} onClose={() => setDrawerOpen(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerCenter: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  headerOrb: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.5,
    shadowRadius: 8,
    elevation: 5,
  },
  headerTitle: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    letterSpacing: -0.3,
  },
  headerSub: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    marginTop: 1,
  },
  headerBtn: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  messageList: {
    paddingTop: 12,
    paddingBottom: 8,
    flexGrow: 1,
  },
  voiceSection: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 24,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  inputSection: { paddingTop: 4 },
});
