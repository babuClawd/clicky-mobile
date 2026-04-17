import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import { Alert, Platform } from "react-native";
import * as AuthSession from "expo-auth-session";
import * as WebBrowser from "expo-web-browser";
import * as SecureStore from "expo-secure-store";
import * as Linking from "expo-linking";

WebBrowser.maybeCompleteAuthSession();

export const AUTH_TOKEN_KEY = "auth_session_token";
const ISSUER_URL = process.env["EXPO_PUBLIC_ISSUER_URL"] ?? "https://replit.com/oidc";

export interface AuthUser {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  profileImageUrl: string | null;
}

interface AuthContextValue {
  user: AuthUser | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  isLoading: true,
  isAuthenticated: false,
  login: async () => {},
  logout: async () => {},
});

export function getApiBaseUrl(): string {
  if (process.env["EXPO_PUBLIC_DOMAIN"]) {
    return `https://${process.env["EXPO_PUBLIC_DOMAIN"]}`;
  }
  return "";
}

function getClientId(): string {
  return process.env["EXPO_PUBLIC_REPL_ID"] || "";
}

// ─── Web Auth Provider ────────────────────────────────────────────────────────
// On web we use server-side OIDC via /api/login (cookie-based).
// This avoids popup/opener issues inside the Replit iframe preview.

function WebAuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const fetchUser = useCallback(async () => {
    try {
      const apiBase = getApiBaseUrl();
      const res = await fetch(`${apiBase}/api/auth/user`, {
        credentials: "include",
      });
      const data = (await res.json()) as { user?: AuthUser };
      setUser(data.user ?? null);
    } catch {
      setUser(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchUser();
  }, [fetchUser]);

  const login = useCallback(async () => {
    const apiBase = getApiBaseUrl();
    const returnTo = encodeURIComponent(window.location.href);
    window.location.href = `${apiBase}/api/login?returnTo=${returnTo}`;
  }, []);

  const logout = useCallback(async () => {
    const apiBase = getApiBaseUrl();
    const returnTo = encodeURIComponent(window.location.origin + "/");
    window.location.href = `${apiBase}/api/logout?returnTo=${returnTo}`;
  }, []);

  return (
    <AuthContext.Provider
      value={{ user, isLoading, isAuthenticated: !!user, login, logout }}
    >
      {children}
    </AuthContext.Provider>
  );
}

// ─── Native Auth Provider ─────────────────────────────────────────────────────
// On iOS/Android we use PKCE + token stored in SecureStore.

function NativeAuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const discovery = AuthSession.useAutoDiscovery(ISSUER_URL);

  // Replit OIDC only accepts https:// redirect URIs on its registered domain.
  // But Android Custom Tabs / Expo Go can't intercept HTTPS callbacks — only
  // deep links. So we register an HTTPS bounce URL with OIDC that includes
  // a `?to=<appDeepLink>` query param. After OIDC adds code/state, the bounce
  // page redirects to the deep link, which the OS opens in our app, closing
  // the in-app browser and giving us the auth response.
  const appDeepLink = useMemo(() => {
    // In Expo Go: exp://<host>/--/auth-callback
    // In standalone: clicky-mobile://auth-callback
    return Linking.createURL("auth-callback");
  }, []);

  const redirectUri = useMemo(
    () =>
      `${getApiBaseUrl()}/api/native-callback?to=${encodeURIComponent(appDeepLink)}`,
    [appDeepLink],
  );

  const [request] = AuthSession.useAuthRequest(
    {
      clientId: getClientId(),
      scopes: ["openid", "email", "profile", "offline_access"],
      redirectUri,
      prompt: AuthSession.Prompt.Login,
    },
    discovery,
  );

  const fetchUser = useCallback(async () => {
    try {
      const token = await SecureStore.getItemAsync(AUTH_TOKEN_KEY);
      if (!token) {
        setUser(null);
        setIsLoading(false);
        return;
      }

      const apiBase = getApiBaseUrl();
      const res = await fetch(`${apiBase}/api/auth/user`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await res.json()) as { user?: AuthUser };

      if (data.user) {
        setUser(data.user);
      } else {
        await SecureStore.deleteItemAsync(AUTH_TOKEN_KEY);
        setUser(null);
      }
    } catch {
      setUser(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchUser();
  }, [fetchUser]);

  const exchangeCode = useCallback(
    async (code: string, state: string, codeVerifier: string, nonce: string | undefined) => {
      const apiBase = getApiBaseUrl();
      if (!apiBase) throw new Error("Missing API base URL");

      const exchangeRes = await fetch(`${apiBase}/api/mobile-auth/token-exchange`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          code_verifier: codeVerifier,
          // Must exactly match the redirect_uri sent during /authorize.
          redirect_uri: redirectUri,
          state,
          nonce,
        }),
      });

      if (!exchangeRes.ok) {
        const text = await exchangeRes.text().catch(() => "");
        throw new Error(`Token exchange failed (${exchangeRes.status}): ${text || "no body"}`);
      }

      const data = (await exchangeRes.json()) as { token?: string };
      if (!data.token) throw new Error("Token exchange returned no token");

      await SecureStore.setItemAsync(AUTH_TOKEN_KEY, data.token);
      setIsLoading(true);
      await fetchUser();
    },
    [redirectUri, fetchUser],
  );

  const login = useCallback(async () => {
    if (!discovery) {
      Alert.alert(
        "Sign-in unavailable",
        "Couldn't reach the authentication service. Please check your connection and try again.",
      );
      return;
    }
    if (!request) {
      Alert.alert("Sign-in not ready", "Please try again in a moment.");
      return;
    }

    try {
      // Build the OIDC authorization URL ourselves (with the request's PKCE
      // params already baked in by useAuthRequest).
      const authUrl = await request.makeAuthUrlAsync(discovery);

      // Open the in-app browser. We tell it to watch for the APP DEEP LINK
      // (not the HTTPS bounce). The bounce page will redirect the browser
      // to the deep link, which the OS catches and the browser closes.
      const result = await WebBrowser.openAuthSessionAsync(authUrl, appDeepLink, {
        showInRecents: true,
      });

      if (result.type === "cancel" || result.type === "dismiss") return;
      if (result.type !== "success" || !result.url) {
        Alert.alert("Sign-in failed", "Authentication did not complete.");
        return;
      }

      const url = new URL(result.url);
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        Alert.alert("Sign-in failed", url.searchParams.get("error_description") || error);
        return;
      }
      if (!code || !state) {
        Alert.alert("Sign-in failed", "Missing authorization code in response.");
        return;
      }
      if (!request.codeVerifier) {
        Alert.alert("Sign-in failed", "Missing PKCE verifier; please try again.");
        return;
      }

      await exchangeCode(code, state, request.codeVerifier, request.nonce);
    } catch (err) {
      console.error("Login error:", err);
      Alert.alert(
        "Sign-in error",
        err instanceof Error ? err.message : "Unknown error during sign-in.",
      );
    }
  }, [discovery, request, appDeepLink, exchangeCode]);

  const logout = useCallback(async () => {
    try {
      const token = await SecureStore.getItemAsync(AUTH_TOKEN_KEY);
      if (token) {
        const apiBase = getApiBaseUrl();
        await fetch(`${apiBase}/api/mobile-auth/logout`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        });
      }
    } catch {
    } finally {
      await SecureStore.deleteItemAsync(AUTH_TOKEN_KEY);
      setUser(null);
    }
  }, []);

  return (
    <AuthContext.Provider
      value={{ user, isLoading, isAuthenticated: !!user, login, logout }}
    >
      {children}
    </AuthContext.Provider>
  );
}

// ─── Unified Provider ─────────────────────────────────────────────────────────

export function AuthProvider({ children }: { children: ReactNode }) {
  if (Platform.OS === "web") {
    return <WebAuthProvider>{children}</WebAuthProvider>;
  }
  return <NativeAuthProvider>{children}</NativeAuthProvider>;
}

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}
