import * as oidc from "openid-client";
import { Router, type IRouter, type Request, type Response } from "express";
import {
  GetCurrentAuthUserResponse,
  ExchangeMobileAuthorizationCodeBody,
  ExchangeMobileAuthorizationCodeResponse,
  LogoutMobileSessionResponse,
} from "@workspace/api-zod";
import { db, usersTable } from "@workspace/db";
import {
  clearSession,
  getOidcConfig,
  getSessionId,
  createSession,
  deleteSession,
  SESSION_COOKIE,
  SESSION_TTL,
  ISSUER_URL,
  type SessionData,
} from "../lib/auth";

const OIDC_COOKIE_TTL = 10 * 60 * 1000;

const router: IRouter = Router();

function getOrigin(req: Request): string {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host =
    req.headers["x-forwarded-host"] || req.headers["host"] || "localhost";
  return `${proto}://${host}`;
}

function setSessionCookie(res: Response, sid: string) {
  res.cookie(SESSION_COOKIE, sid, {
    httpOnly: true,
    secure: true,
    // "none" lets the cookie be sent in cross-origin fetch requests (e.g. from
    // the Expo web preview domain to the API domain). Requires secure:true.
    sameSite: "none",
    path: "/",
    maxAge: SESSION_TTL,
  });
}

function setOidcCookie(res: Response, name: string, value: string) {
  res.cookie(name, value, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: OIDC_COOKIE_TTL,
  });
}

function getSafeReturnTo(value: unknown): string {
  if (typeof value !== "string") return "/";
  // Allow relative paths
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  // Allow full https:// URLs (e.g. Expo web preview returning from auth)
  if (value.startsWith("https://")) return value;
  return "/";
}

async function upsertUser(claims: Record<string, unknown>) {
  const userData = {
    id: claims["sub"] as string,
    email: (claims["email"] as string) || null,
    firstName: (claims["first_name"] as string) || null,
    lastName: (claims["last_name"] as string) || null,
    profileImageUrl: (claims["profile_image_url"] || claims["picture"]) as string | null,
  };

  const [user] = await db
    .insert(usersTable)
    .values(userData)
    .onConflictDoUpdate({
      target: usersTable.id,
      set: { ...userData, updatedAt: new Date() },
    })
    .returning();
  return user!;
}

// Native auth bounce endpoint.
// Replit OIDC only accepts https:// redirect URIs on Replit-controlled
// domains, but native browsers (especially Android Custom Tabs and Expo Go)
// can't intercept HTTPS callbacks back into the app — only deep links.
//
// Flow:
//   1. App registers `redirect_uri = .../api/native-callback?to=<deepLink>`
//   2. Replit OIDC redirects browser here with ?code=…&state=…&to=…
//   3. This page redirects the browser to `<deepLink>?code=…&state=…`
//   4. The OS opens the deep link in our app; the in-app browser closes
//      and expo-auth-session resolves with the URL.
router.get("/native-callback", (req: Request, res: Response) => {
  const to = typeof req.query["to"] === "string" ? req.query["to"] : "";

  // Only allow well-known schemes the app actually uses.
  const safeScheme = /^(exp|exps|clicky-mobile):\/\//.test(to);

  // Forward all OIDC response params except our internal `to`.
  const forward = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query)) {
    if (k === "to" || typeof v !== "string") continue;
    forward.set(k, v);
  }

  const target = safeScheme
    ? `${to}${to.includes("?") ? "&" : "?"}${forward.toString()}`
    : null;

  // Use both an HTTP meta-refresh and JS replace so it works under any
  // browser, including Custom Tabs which sometimes block JS-only redirects.
  // Also include a manual link as a final fallback.
  const escaped = target ? target.replace(/"/g, "&quot;") : "";
  const body = target
    ? `<!doctype html><html><head><meta charset="utf-8"><title>Returning to Clicky…</title><meta http-equiv="refresh" content="0; url=${escaped}"></head><body style="background:#0C0B0A;color:#fff;font-family:system-ui,-apple-system,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;gap:16px;"><div>Returning to Clicky…</div><a href="${escaped}" style="color:#FF8A33;">Tap here if nothing happens</a><script>setTimeout(function(){window.location.replace(${JSON.stringify(target)});},10);</script></body></html>`
    : `<!doctype html><html><head><meta charset="utf-8"><title>Returning to Clicky…</title></head><body style="background:#0C0B0A;color:#fff;font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;"><div>Returning to Clicky…</div></body></html>`;

  res.status(200).type("html").send(body);
});

router.get("/auth/user", (req: Request, res: Response) => {
  // Disable caching: the auth state changes (login/logout) and a stale 304
  // would mask the new state on the client.
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.set("Pragma", "no-cache");
  res.json(
    GetCurrentAuthUserResponse.parse({
      user: req.isAuthenticated() ? req.user : null,
    }),
  );
});

router.get("/login", async (req: Request, res: Response) => {
  const config = await getOidcConfig();
  const callbackUrl = `${getOrigin(req)}/api/callback`;
  const returnTo = getSafeReturnTo(req.query["returnTo"]);

  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const codeVerifier = oidc.randomPKCECodeVerifier();
  const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);

  const redirectTo = oidc.buildAuthorizationUrl(config, {
    redirect_uri: callbackUrl,
    scope: "openid email profile offline_access",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    prompt: "login consent",
    state,
    nonce,
  });

  setOidcCookie(res, "code_verifier", codeVerifier);
  setOidcCookie(res, "nonce", nonce);
  setOidcCookie(res, "state", state);
  setOidcCookie(res, "return_to", returnTo);

  res.redirect(redirectTo.href);
});

router.get("/callback", async (req: Request, res: Response) => {
  const config = await getOidcConfig();
  const callbackUrl = `${getOrigin(req)}/api/callback`;

  const codeVerifier = req.cookies?.code_verifier as string | undefined;
  const nonce = req.cookies?.nonce as string | undefined;
  const expectedState = req.cookies?.state as string | undefined;

  if (!codeVerifier || !expectedState) {
    res.redirect("/api/login");
    return;
  }

  const currentUrl = new URL(
    `${callbackUrl}?${new URL(req.url, `http://${req.headers["host"]}`).searchParams}`,
  );

  let tokens: oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers;
  try {
    tokens = await oidc.authorizationCodeGrant(config, currentUrl, {
      pkceCodeVerifier: codeVerifier,
      expectedNonce: nonce,
      expectedState,
    });
  } catch (err) {
    req.log.error({ err }, "OIDC callback error");
    res.redirect("/api/login");
    return;
  }

  const claims = tokens.claims();
  if (!claims) {
    res.redirect("/api/login");
    return;
  }

  const dbUser = await upsertUser(claims as unknown as Record<string, unknown>);
  const now = Math.floor(Date.now() / 1000);

  const sessionData: SessionData = {
    user: {
      id: dbUser.id,
      email: dbUser.email ?? null,
      firstName: dbUser.firstName ?? null,
      lastName: dbUser.lastName ?? null,
      profileImageUrl: dbUser.profileImageUrl ?? null,
    },
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: tokens.expiresIn() ? now + tokens.expiresIn()! : (claims["exp"] as number | undefined),
  };

  const sid = await createSession(sessionData);
  setSessionCookie(res, sid);

  const returnTo = getSafeReturnTo(req.cookies?.return_to);
  res.redirect(returnTo);
});

router.get("/logout", async (req: Request, res: Response) => {
  const sid = getSessionId(req);
  await clearSession(res, sid);

  // Redirect back to the app (e.g. the Expo web URL) after logout.
  const returnTo = getSafeReturnTo(req.query["returnTo"]) || getOrigin(req);
  const postLogoutRedirect =
    returnTo.startsWith("http") ? returnTo : `${getOrigin(req)}${returnTo}`;

  try {
    const config = await getOidcConfig();
    const endSessionUrl = oidc.buildEndSessionUrl(config, {
      post_logout_redirect_uri: postLogoutRedirect,
    });
    res.redirect(endSessionUrl.href);
  } catch {
    res.redirect(postLogoutRedirect);
  }
});

router.post(
  "/mobile-auth/token-exchange",
  async (req: Request, res: Response) => {
    const parsed = ExchangeMobileAuthorizationCodeBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Missing or invalid required fields" });
      return;
    }

    const { code, code_verifier, redirect_uri, state, nonce } = parsed.data;

    try {
      const config = await getOidcConfig();

      // Reconstruct the callback URL with all required params.
      // Replit's OIDC omits the "iss" parameter from the auth response,
      // so we add it manually to satisfy openid-client v6's validation.
      const callbackUrl = new URL(redirect_uri);
      callbackUrl.searchParams.set("code", code);
      callbackUrl.searchParams.set("state", state);
      callbackUrl.searchParams.set("iss", ISSUER_URL);

      const tokens = await oidc.authorizationCodeGrant(config, callbackUrl, {
        pkceCodeVerifier: code_verifier,
        expectedNonce: nonce ?? undefined,
        expectedState: state,
        idTokenExpected: true,
      });

      const claims = tokens.claims();
      if (!claims) {
        res.status(401).json({ error: "No claims in ID token" });
        return;
      }

      const dbUser = await upsertUser(claims as unknown as Record<string, unknown>);
      const now = Math.floor(Date.now() / 1000);

      const sessionData: SessionData = {
        user: {
          id: dbUser.id,
          email: dbUser.email ?? null,
          firstName: dbUser.firstName ?? null,
          lastName: dbUser.lastName ?? null,
          profileImageUrl: dbUser.profileImageUrl ?? null,
        },
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: tokens.expiresIn() ? now + tokens.expiresIn()! : (claims["exp"] as number | undefined),
      };

      const sid = await createSession(sessionData);
      res.json(ExchangeMobileAuthorizationCodeResponse.parse({ token: sid }));
    } catch (err) {
      req.log.error({ err }, "Mobile token exchange error");
      res.status(500).json({ error: "Token exchange failed" });
    }
  },
);

router.post("/mobile-auth/logout", async (req: Request, res: Response) => {
  const sid = getSessionId(req);
  if (sid) await deleteSession(sid);
  res.json(LogoutMobileSessionResponse.parse({ success: true }));
});

export default router;
