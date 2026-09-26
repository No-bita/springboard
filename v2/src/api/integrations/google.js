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
  const user = c.get("user");
  const userId = user?.id || user?.user_id || user?.sub;
  if (!userId) {
    return c.json({ error: "Unauthorized" }, 401);
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

  const targetUrl = `${GOOGLE_AUTH_ENDPOINT}?${authParams.toString()}`;

  // Set cookie and redirect
  c.header("Set-Cookie", cookieHeader);
  return c.redirect(targetUrl);
}

/**
 * GET /api/integrations/google/callback
 * Exchanges authorization code, encrypts refresh token, stores connection, and triggers watch/backfill.
 */
export async function handleGoogleAuthCallback(c) {
  const db = getDbClient(c.env);
  const secretKey = c.env.ENCRYPTION_SECRET || c.env.JWT_SECRET || "collectr_dev_secret_key_32_bytes!!";
  const clientId = c.env.GOOGLE_CLIENT_ID;
  const clientSecret = c.env.GOOGLE_CLIENT_SECRET;
  const frontendUrl = c.env.FRONTEND_URL || "https://crm.aaryanshah.co.in";
  const redirectUri = `${frontendUrl}/api/integrations/google/callback`;
  const isMock = c.env.MOCK_GMAIL === "true" || c.env.ENVIRONMENT === "test" || process?.env?.NO_EXTERNAL_NETWORK === "true";

  const code = c.req.query("code");
  const signedState = c.req.query("state");
  const error = c.req.query("error");

  if (error) {
    return c.redirect(`/dashboard.html?error=${encodeURIComponent("Google connection cancelled: " + error)}`);
  }

  if (!code || !signedState) {
    return c.json({ error: "Missing authorization code or state parameter." }, 400);
  }

  // 1. Verify signed state
  const statePayload = await verifyOAuthState(signedState, secretKey);
  if (!statePayload || !statePayload.user_id) {
    return c.json({ error: "Invalid or expired OAuth state parameter." }, 400);
  }

  const stateAge = Date.now() - Number(statePayload.issued_at || 0);
  if (stateAge > 10 * 60 * 1000) {
    return c.json({ error: "OAuth session timed out. Please try connecting again." }, 400);
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
    return c.json({ error: "PKCE verification failed: verifier cookie missing or expired." }, 400);
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
      const errText = await tokenRes.text().catch(() => "");
      return c.redirect(`/dashboard.html?error=${encodeURIComponent("Token exchange failed: " + errText)}`);
    }

    const tokenData = await tokenRes.json();
    plainRefreshToken = tokenData.refresh_token;

    // 4. Fetch Google User Profile for stable identity and verified email
    const userinfoRes = await fetch(GOOGLE_USERINFO_ENDPOINT, {
      headers: { "Authorization": `Bearer ${tokenData.access_token}` },
    });

    if (!userinfoRes.ok) {
      return c.redirect(`/dashboard.html?error=${encodeURIComponent("Failed to fetch Google user profile")}`);
    }

    const profile = await userinfoRes.json();
    googleSubjectId = profile.id;
    googleEmail = (profile.email || "").trim().toLowerCase();
  }

  if (!plainRefreshToken) {
    return c.redirect(`/dashboard.html?error=${encodeURIComponent("No refresh token received from Google. Please reconnect with consent prompt.")}`);
  }

  // 5. Encrypt refresh token using AES-GCM-256
  const encryptedRefreshToken = await encryptToken(plainRefreshToken, secretKey);
  const connectionId = "gconn_" + crypto.randomUUID();

  // 6. Global mailbox uniqueness check & Upsert
  try {
    await db.execute({
      sql: `INSERT INTO google_connections (
        id, user_id, google_subject_id, google_email, encrypted_refresh_token,
        scope, sync_status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'syncing', datetime('now'), datetime('now'))
      ON CONFLICT(google_email) DO UPDATE SET
        user_id = excluded.user_id,
        google_subject_id = excluded.google_subject_id,
        encrypted_refresh_token = excluded.encrypted_refresh_token,
        sync_status = 'syncing',
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

  return c.json({
    connected: true,
    connectionId: conn.id,
    googleEmail: conn.google_email,
    syncStatus: conn.sync_status,
    lastSyncedAt: conn.last_synced_at,
    lastSuccessfulSyncAt: conn.last_successful_sync_at,
    errorMessage: conn.error_message,
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
  await startInitialSyncPipeline(db, connectionId, c.env);

  return c.json({ success: true, message: "Synchronization started." });
}
