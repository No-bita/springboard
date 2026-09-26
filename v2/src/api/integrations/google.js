/**
 * Google OAuth 2.0 & Connection Handlers
 * Springboard V2 — Gmail Integration
 * 
 * Invariants:
 * 1. code_verifier stored exclusively in HttpOnly cookie; never exposed in state URL.
 * 2. Refresh token encrypted at rest via AES-GCM-256.
 * 3. Access tokens ephemeral only.
 * 4. Watch-before-backfill triggered upon connection.
 */

import { getDbClient } from "../../db/client.js";
import { generatePkcePair, signOAuthState, verifyOAuthState, encryptToken, decryptToken } from "../../gmail/crypto.js";
import { revokeGoogleToken } from "../../gmail/auth.js";
import { startInitialSyncPipeline } from "../../gmail/sync.js";

const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v2/userinfo";
const GMAIL_SCOPES = "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/userinfo.email";

/**
 * GET /api/integrations/google/auth
 * Initiates PKCE OAuth flow.
 */
export async function handleGoogleAuthInitiate(c) {
  try {
    const user = c.get("user");
    const userId = user?.id || user?.user_id || user?.sub;
    if (!userId) {
      return c.json({ error: "Unauthorized access. Please log in." }, 401);
    }

    const clientId = c.env.GOOGLE_CLIENT_ID || "mock_google_client_id";
    const frontendUrl = c.env.FRONTEND_URL || "https://crm.aaryanshah.co.in";
    const redirectUri = `${frontendUrl}/api/integrations/google/callback`;
    const secretKey = c.env.ENCRYPTION_SECRET || c.env.JWT_SECRET || "collectr_dev_secret_key_32_bytes!!";

    // 1. Generate PKCE pair
    const { codeVerifier, codeChallenge } = await generatePkcePair();

    // 2. Generate HMAC-signed state containing only { user_id, nonce, issued_at }
    const statePayload = {
      user_id: userId,
      nonce: crypto.randomUUID(),
      issued_at: Date.now(),
    };
    const signedState = await signOAuthState(statePayload, secretKey);

    // 3. Store code_verifier in secure HttpOnly cookie
    const isSecure = !frontendUrl.startsWith("http://localhost");
    const cookieHeader = `sb_pkce_verifier=${encodeURIComponent(codeVerifier)}; HttpOnly; SameSite=Lax; Path=/api/integrations/google; Max-Age=600${isSecure ? "; Secure" : ""}`;

    // 4. Construct Google consent URL
    const authParams = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: GMAIL_SCOPES,
      access_type: "offline",
      prompt: "consent",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state: signedState,
    });

    const authorizationUrl = `${GOOGLE_AUTH_ENDPOINT}?${authParams.toString()}`;

    // Set PKCE cookie and return authorizationUrl JSON for client-side navigation
    c.header("Set-Cookie", cookieHeader);
    return c.json({ authorizationUrl });
  } catch (err) {
    console.error("Google auth initiate error:", err);
    return c.json({ error: "Failed to initiate Google connection: " + (err.message || "Unknown error") }, 500);
  }
}

/**
 * GET /api/integrations/google/callback
 * Exchanges authorization code, encrypts refresh token, stores connection, and triggers watch/backfill.
 */
export async function handleGoogleAuthCallback(c) {
  try {
    const db = getDbClient(c.env);
    const secretKey = c.env.ENCRYPTION_SECRET || c.env.JWT_SECRET || "collectr_dev_secret_key_32_bytes!!";
    const clientId = c.env.GOOGLE_CLIENT_ID;
    const clientSecret = c.env.GOOGLE_CLIENT_SECRET;
    const frontendUrl = c.env.FRONTEND_URL || "https://crm.aaryanshah.co.in";
    const redirectUri = `${frontendUrl}/api/integrations/google/callback`;
    const isMock = c.env.MOCK_GMAIL === "true" || c.env.ENVIRONMENT === "test" || (typeof process !== "undefined" && process?.env?.NO_EXTERNAL_NETWORK === "true");

    const code = c.req.query("code");
    const signedState = c.req.query("state");
    const error = c.req.query("error");

    if (error) {
      const errorMsg = error === "access_denied"
        ? "Google permissions were not granted. Please allow access to connect Gmail."
        : `Google connection cancelled: ${error}`;
      return c.redirect(`/dashboard.html?error=${encodeURIComponent(errorMsg)}`);
    }

    if (!code || !signedState) {
      return c.redirect(`/dashboard.html?error=${encodeURIComponent("Missing authorization code or state from Google. Please try again.")}`);
    }

    // 1. Verify signed state
    const statePayload = await verifyOAuthState(signedState, secretKey);
    if (!statePayload || !statePayload.user_id) {
      return c.redirect(`/dashboard.html?error=${encodeURIComponent("Invalid or tampered authorization state. Please try connecting again.")}`);
    }

    const stateAge = Date.now() - Number(statePayload.issued_at || 0);
    if (stateAge > 10 * 60 * 1000) {
      return c.redirect(`/dashboard.html?error=${encodeURIComponent("Connection session timed out. Please try connecting again.")}`);
    }

    const userId = statePayload.user_id;

    // 2. Read code_verifier from HttpOnly cookie
    const cookieHeader = c.req.header("Cookie") || "";
    const match = cookieHeader.match(/sb_pkce_verifier=([^;]+)/);
    let codeVerifier = match ? decodeURIComponent(match[1]) : null;

    // Test mode fallback
    if (!codeVerifier && isMock) {
      codeVerifier = "mock_test_code_verifier";
    }

    if (!codeVerifier && !isMock) {
      return c.redirect(`/dashboard.html?error=${encodeURIComponent("Security verification cookie missing or expired. Please ensure cookies are enabled and try again.")}`);
    }

    let plainRefreshToken = "mock_refresh_token_xyz";
    let googleSubjectId = "google_sub_123456";
    let googleEmail = "connected_user@gmail.com";

    if (!isMock) {
      // 3. Exchange code at Google token endpoint
      const tokenParams = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        code_verifier: codeVerifier,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      });

      const tokenRes = await fetch(GOOGLE_TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: tokenParams.toString(),
      });

      if (!tokenRes.ok) {
        let errDesc = "Token exchange failed with Google";
        try {
          const errJson = await tokenRes.json();
          if (errJson.error === "invalid_grant") {
            errDesc = "Authorization code expired or was already used. Please reconnect.";
          } else if (errJson.error_description) {
            errDesc = errJson.error_description;
          }
        } catch (_) {
          const rawText = await tokenRes.text().catch(() => "");
          if (rawText) errDesc += `: ${rawText}`;
        }
        return c.redirect(`/dashboard.html?error=${encodeURIComponent(errDesc)}`);
      }

      const tokenData = await tokenRes.json();
      plainRefreshToken = tokenData.refresh_token;

      // 4. Fetch Google User Profile for stable identity and verified email
      const userinfoRes = await fetch(GOOGLE_USERINFO_ENDPOINT, {
        headers: { "Authorization": `Bearer ${tokenData.access_token}` },
      });

      if (!userinfoRes.ok) {
        return c.redirect(`/dashboard.html?error=${encodeURIComponent("Failed to load Google user profile. Please try reconnecting.")}`);
      }

      const profile = await userinfoRes.json();
      googleSubjectId = profile.id;
      googleEmail = (profile.email || "").trim().toLowerCase();
    }

    if (!plainRefreshToken) {
      return c.redirect(`/dashboard.html?error=${encodeURIComponent("Google did not return an offline access token. Please reconnect and approve the consent prompt.")}`);
    }

    // 5. Encrypt refresh token using AES-GCM-256
    const encryptedRefreshToken = await encryptToken(plainRefreshToken, secretKey);
    const connectionId = "gconn_" + crypto.randomUUID();

    // 6. Global mailbox uniqueness check & Upsert
    try {
      await db.execute({
        sql: `INSERT INTO google_connections (
          id, user_id, google_subject_id, google_email, encrypted_refresh_token,
          scope, sync_status, error_message, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'syncing', 'stage:watch', datetime('now'), datetime('now'))
        ON CONFLICT(google_email) DO UPDATE SET
          user_id = excluded.user_id,
          google_subject_id = excluded.google_subject_id,
          encrypted_refresh_token = excluded.encrypted_refresh_token,
          sync_status = 'syncing',
          error_message = 'stage:watch',
          updated_at = datetime('now')`,
        args: [connectionId, userId, googleSubjectId, googleEmail, encryptedRefreshToken, GMAIL_SCOPES],
      });
    } catch (dbErr) {
      console.error("Failed to store google connection:", dbErr);
      return c.redirect(`/dashboard.html?error=${encodeURIComponent("Database error saving connection")}`);
    }

    // Fetch actual saved connection ID
    const savedConn = await db.execute({
      sql: "SELECT id FROM google_connections WHERE google_email = ? LIMIT 1",
      args: [googleEmail],
    });
    const effectiveConnId = savedConn.rows[0]?.id || connectionId;

    // 7. Trigger Watch-before-Backfill pipeline asynchronously
    try {
      await startInitialSyncPipeline(db, effectiveConnId, c.env);
    } catch (syncErr) {
      console.error("Failed to trigger initial sync pipeline:", syncErr);
    }

    // Clear PKCE cookie and redirect back to dashboard
    c.header("Set-Cookie", "sb_pkce_verifier=; HttpOnly; SameSite=Lax; Path=/api/integrations/google; Max-Age=0");
    return c.redirect("/dashboard.html?connected=gmail");
  } catch (fatalErr) {
    console.error("Fatal Google auth callback error:", fatalErr);
    return c.redirect(`/dashboard.html?error=${encodeURIComponent("Connection failed: " + (fatalErr.message || "Unknown error"))}`);
  }
}

/**
 * GET /api/integrations/google/status
 * Returns current Gmail connection status and sync telemetry for the authenticated user.
 */
export async function handleGoogleStatus(c) {
  const db = getDbClient(c.env);
  const user = c.get("user");
  const userId = user?.id || user?.user_id || user?.sub;

  const res = await db.execute({
    sql: `SELECT id, google_email, sync_status, last_synced_at, last_successful_sync_at, error_message, created_at
          FROM google_connections WHERE user_id = ? LIMIT 1`,
    args: [userId],
  });

  if (!res.rows || res.rows.length === 0) {
    return c.json({ connected: false });
  }

  const conn = res.rows[0];

  // Count unresolved unmatched emails
  const unmatchedRes = await db.execute({
    sql: "SELECT COUNT(*) as cnt FROM gmail_unmatched_messages WHERE user_id = ? AND status = 'unresolved'",
    args: [userId],
  });

  let syncStage = "synced";
  let syncStageLabel = "Inbox synchronized";
  let syncStep = 5;

  if (conn.sync_status === "syncing") {
    const rawStage = (conn.error_message && conn.error_message.startsWith("stage:"))
      ? conn.error_message.replace("stage:", "")
      : "scan";

    if (rawStage === "auth" || rawStage === "authorizing") {
      syncStage = "auth";
      syncStageLabel = "Authorizing Google OAuth & permissions";
      syncStep = 1;
    } else if (rawStage === "watch" || rawStage === "registering_watch") {
      syncStage = "watch";
      syncStageLabel = "Registering real-time inbox watch";
      syncStep = 2;
    } else if (rawStage === "scan" || rawStage === "scanning_history") {
      syncStage = "scan";
      syncStageLabel = "Scanning historical messages (past 30 days)";
      syncStep = 3;
    } else if (rawStage === "correlate" || rawStage === "correlating_contacts" || rawStage === "catching_up_delta") {
      syncStage = "correlate";
      syncStageLabel = "Matching emails & correlating requests";
      syncStep = 4;
    } else {
      syncStage = "scan";
      syncStageLabel = "Synchronizing inbox...";
      syncStep = 3;
    }
  } else if (conn.sync_status === "error") {
    syncStage = "error";
    syncStageLabel = conn.error_message || "Synchronization issue encountered";
    syncStep = 0;
  } else if (conn.last_successful_sync_at) {
    syncStage = "synced";
    syncStageLabel = "Real-time inbox watch active";
    syncStep = 5;
  } else {
    // Purely observational: idle state when backfill has not completed
    syncStage = "idle";
    syncStageLabel = "Initial inbox sync pending";
    syncStep = 1;
  }

  return c.json({
    connected: true,
    connectionId: conn.id,
    googleEmail: conn.google_email,
    syncStatus: conn.sync_status,
    syncStage,
    syncStageLabel,
    syncStep,
    totalSteps: 5,
    lastSyncedAt: conn.last_synced_at,
    lastSuccessfulSyncAt: conn.last_successful_sync_at,
    errorMessage: conn.sync_status === "error" ? conn.error_message : null,
    unmatchedCount: unmatchedRes.rows[0]?.cnt || 0,
  });
}

/**
 * POST /api/integrations/google/disconnect
 * Revokes Google access token and deletes connection from D1.
 */
export async function handleGoogleDisconnect(c) {
  const db = getDbClient(c.env);
  const user = c.get("user");
  const userId = user?.id || user?.user_id || user?.sub;
  const secretKey = c.env.ENCRYPTION_SECRET || c.env.JWT_SECRET || "collectr_dev_secret_key_32_bytes!!";

  const res = await db.execute({
    sql: "SELECT id, encrypted_refresh_token FROM google_connections WHERE user_id = ? LIMIT 1",
    args: [userId],
  });

  if (res.rows && res.rows.length > 0) {
    const conn = res.rows[0];
    try {
      const plainRefreshToken = await decryptToken(conn.encrypted_refresh_token, secretKey);
      await revokeGoogleToken(plainRefreshToken, c.env);
    } catch (_) {}

    await db.execute({
      sql: "DELETE FROM google_connections WHERE id = ?",
      args: [conn.id],
    });
  }

  return c.json({ success: true, message: "Gmail connection disconnected successfully." });
}

/**
 * POST /api/integrations/google/sync
 * Manually triggers a delta or backfill sync for the connected mailbox.
 */
export async function handleGoogleManualSync(c) {
  const db = getDbClient(c.env);
  const user = c.get("user");
  const userId = user?.id || user?.user_id || user?.sub;

  const res = await db.execute({
    sql: "SELECT id FROM google_connections WHERE user_id = ? LIMIT 1",
    args: [userId],
  });

  if (!res.rows || res.rows.length === 0) {
    return c.json({ error: "No connected Gmail account found." }, 404);
  }

  const connectionId = res.rows[0].id;
  await db.execute({
    sql: "UPDATE google_connections SET sync_status = 'syncing', error_message = 'stage:scan', updated_at = datetime('now') WHERE id = ?",
    args: [connectionId],
  });
  await startInitialSyncPipeline(db, connectionId, c.env);

  return c.json({ success: true, message: "Synchronization started." });
}
