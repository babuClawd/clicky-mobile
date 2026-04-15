import { useCallback, useEffect, useState } from "react";
import { Alert, Linking, Platform } from "react-native";
import { Audio } from "expo-av";

export interface PermissionState {
  microphone: "granted" | "denied" | "undetermined" | "unavailable";
  isReady: boolean;
}

export function usePermissions() {
  const [permissions, setPermissions] = useState<PermissionState>({
    microphone: "undetermined",
    isReady: false,
  });

  const checkPermissions = useCallback(async () => {
    if (Platform.OS === "web") {
      setPermissions({ microphone: "granted", isReady: true });
      return;
    }

    try {
      const micStatus = await Audio.getPermissionsAsync();
      setPermissions({
        microphone: micStatus.granted ? "granted" : micStatus.canAskAgain ? "undetermined" : "denied",
        isReady: true,
      });
    } catch {
      setPermissions({ microphone: "unavailable", isReady: true });
    }
  }, []);

  const requestMicrophonePermission = useCallback(async (): Promise<boolean> => {
    if (Platform.OS === "web") return true;

    try {
      const { granted, canAskAgain } = await Audio.requestPermissionsAsync();

      if (granted) {
        setPermissions((prev) => ({ ...prev, microphone: "granted" }));
        return true;
      }

      if (!canAskAgain) {
        // Permission permanently denied — direct user to settings
        setPermissions((prev) => ({ ...prev, microphone: "denied" }));
        Alert.alert(
          "Microphone Access Required",
          "Clicky needs microphone access to hear your voice commands. Please enable it in Settings.",
          [
            { text: "Cancel", style: "cancel" },
            { text: "Open Settings", onPress: () => void Linking.openSettings() },
          ]
        );
        return false;
      }

      setPermissions((prev) => ({ ...prev, microphone: "undetermined" }));
      return false;
    } catch {
      return false;
    }
  }, []);

  const ensureMicrophonePermission = useCallback(async (): Promise<boolean> => {
    if (permissions.microphone === "granted") return true;
    if (permissions.microphone === "denied") {
      Alert.alert(
        "Microphone Access Required",
        "Clicky needs microphone access to hear your voice commands. Please enable it in Settings.",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Open Settings", onPress: () => void Linking.openSettings() },
        ]
      );
      return false;
    }
    return requestMicrophonePermission();
  }, [permissions.microphone, requestMicrophonePermission]);

  useEffect(() => {
    void checkPermissions();
  }, [checkPermissions]);

  return {
    permissions,
    requestMicrophonePermission,
    ensureMicrophonePermission,
    recheckPermissions: checkPermissions,
  };
}
