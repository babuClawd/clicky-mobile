import React, { useRef, useState } from "react";
import {
  Alert,
  Platform,
  StyleSheet,
  Text,
  TextInput as RNTextInput,
  TouchableOpacity,
  View,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";
import type { MessageAttachment, SendMessageInput } from "@/context/AssistantContext";

interface ChatInputProps {
  disabled?: boolean;
  onSend: (input: SendMessageInput) => void | Promise<void>;
}

export function ChatInput({ onSend, disabled }: ChatInputProps) {
  const [text, setText] = useState("");
  const [attachment, setAttachment] = useState<MessageAttachment | null>(null);
  const [isPickingImage, setIsPickingImage] = useState(false);
  const colors = useColors();
  const inputRef = useRef<RNTextInput>(null);

  const handleSend = () => {
    const trimmed = text.trim();
    if ((!trimmed && !attachment) || disabled) {
      return;
    }

    void onSend({
      text: trimmed,
      ...(attachment ? { attachment } : {}),
    });

    setText("");
    setAttachment(null);
    inputRef.current?.blur();
  };

  const handlePickImage = async () => {
    if (disabled || isPickingImage) {
      return;
    }

    setIsPickingImage(true);
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        Alert.alert(
          "Photos Required",
          "Clicky needs access to your photos so you can share a screenshot.",
        );
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        allowsEditing: false,
        allowsMultipleSelection: false,
        base64: true,
        mediaTypes: ["images"],
        quality: 0.7,
      });

      if (result.canceled || result.assets.length === 0) {
        return;
      }

      const asset = result.assets[0];
      if (!asset.base64) {
        Alert.alert(
          "Image Not Ready",
          "That screenshot could not be prepared for analysis. Please try another image.",
        );
        return;
      }

      setAttachment({
        uri: asset.uri,
        base64: asset.base64,
        fileName: asset.fileName ?? `clicky-screen-${Date.now()}.jpg`,
        height: asset.height,
        mimeType: asset.mimeType ?? "image/jpeg",
        width: asset.width,
      });
    } catch (error) {
      console.error("Image picker error:", error);
      Alert.alert(
        "Couldn't Open Photos",
        "Please try again in a moment.",
      );
    } finally {
      setIsPickingImage(false);
    }
  };

  const canSend = (text.trim().length > 0 || Boolean(attachment)) && !disabled;
  const attachmentLabel = attachment?.fileName ?? "Screenshot attached";

  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor: colors.surface,
          borderColor: colors.border,
          borderTopColor: colors.border,
        },
      ]}
    >
      {attachment ? (
        <View
          style={[
            styles.previewRow,
            {
              backgroundColor: colors.secondary,
              borderColor: colors.border,
            },
          ]}
        >
          <Image source={{ uri: attachment.uri }} style={styles.previewImage} />
          <View style={styles.previewCopy}>
            <Text style={[styles.previewTitle, { color: colors.foreground }]}>
              Screenshot ready
            </Text>
            <Text style={[styles.previewMeta, { color: colors.mutedForeground }]}>
              {attachmentLabel}
            </Text>
          </View>
          <TouchableOpacity
            onPress={() => setAttachment(null)}
            style={[styles.previewRemove, { backgroundColor: colors.surface }]}
            activeOpacity={0.8}
          >
            <Ionicons name="close" size={14} color={colors.mutedForeground} />
          </TouchableOpacity>
        </View>
      ) : null}

      <View
        style={[
          styles.inputRow,
          {
            backgroundColor: colors.secondary,
            borderColor: colors.border,
          },
        ]}
      >
        <TouchableOpacity
          onPress={() => void handlePickImage()}
          disabled={disabled || isPickingImage}
          style={[styles.attachButton, { backgroundColor: colors.surfaceHigh }]}
          activeOpacity={0.8}
        >
          <Ionicons
            name={attachment ? "images" : "image-outline"}
            size={18}
            color={colors.mutedForeground}
          />
        </TouchableOpacity>

        <RNTextInput
          ref={inputRef}
          style={[
            styles.input,
            {
              color: colors.foreground,
              fontFamily: "Inter_400Regular",
            },
          ]}
          placeholder={
            attachment
              ? "Ask what this screen means..."
              : "Message Clicky..."
          }
          placeholderTextColor={colors.mutedForeground}
          value={text}
          onChangeText={setText}
          multiline
          maxLength={500}
          returnKeyType="send"
          onSubmitEditing={Platform.OS !== "web" ? handleSend : undefined}
          blurOnSubmit={false}
          editable={!disabled}
        />

        <TouchableOpacity
          onPress={handleSend}
          disabled={!canSend}
          style={[
            styles.sendButton,
            {
              backgroundColor: canSend ? colors.primary : colors.muted,
              shadowColor: canSend ? colors.primary : "transparent",
            },
          ]}
          activeOpacity={0.8}
        >
          <Ionicons
            name="arrow-up"
            size={18}
            color={canSend ? "#fff" : colors.mutedForeground}
          />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  attachButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 2,
  },
  container: {
    borderTopWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 10,
  },
  input: {
    flex: 1,
    fontSize: 15,
    lineHeight: 21,
    maxHeight: 100,
    paddingVertical: 4,
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    borderWidth: 1,
    borderRadius: 24,
    paddingLeft: 8,
    paddingRight: 6,
    paddingVertical: 6,
    gap: 8,
  },
  previewCopy: {
    flex: 1,
    gap: 2,
  },
  previewImage: {
    width: 44,
    height: 44,
    borderRadius: 12,
  },
  previewMeta: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
  },
  previewRemove: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
  },
  previewRow: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderRadius: 18,
    padding: 10,
    gap: 10,
  },
  previewTitle: {
    fontSize: 13,
    fontFamily: "Inter_700Bold",
  },
  sendButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 4,
  },
});
