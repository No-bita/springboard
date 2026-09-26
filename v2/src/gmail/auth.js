/**
 * Ephemeral Google Access Token Manager
 * Springboard V2 — Gmail Integration
 * 
 * Invariant: Access tokens are ephemeral and held in-memory during request execution.
 * They are NEVER persisted in D1.
 */

import { decryptToken } from "./crypto.js";

const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";

/**
 * Retrieves a fresh ephemeral access token by decrypting the stored refresh token.
 */
export async function getEphemeralAccessToken(db, connectionId, env = {}) {
  const secretKey = env.ENCRYPTION_SECRET || env.JWT_SECRET || "collectr_dev_secret_key_32_bytes!!";
  const isMock = env.MOCK_GMAIL === "true" || env.ENVIRONMENT === "test" || process?.env?.NO_EXTERNAL_NETWORK === "true";

  if (isMock) {
    return {
      accessToken: `mock_access_token_${connectionId}`,
      expiresIn: 3600,
    };
  }

  // 1. Fetch connection record from D1
  const res = await db.execute({
    sql: "SELECT id, encrypted_refresh_token, google_email FROM google_connections WHERE id = ? LIMIT 1",
    args: [connectionId],
  });

  if (!res.rows || res.rows.length === 0) {
    throw new Error(`Google connection ${connectionId} not found.`);
  }

  const conn = res.rows[0];
  const plainRefreshToken = await decryptToken(conn.encrypted_refresh_token, secretKey);

  if (!plainRefreshToken) {
    throw new Error(`Failed to decrypt refresh token for connection ${connectionId}.`);
  }

  const clientId = env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET is not configured in worker environment.");
  }

  // 2. Exchange refresh_token for ephemeral access_token
  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: plainRefreshToken,
    grant_type: "refresh_token",
  });

  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Failed to refresh Google access token (${response.status}): ${errText}`);
  }

  const data = await response.json();
  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in || 3600,
  };
}

/**
 * Revokes a refresh token with Google Identity endpoint.
 */
export async function revokeGoogleToken(plainRefreshToken, env = {}) {
  const isMock = env.MOCK_GMAIL === "true" || env.ENVIRONMENT === "test" || process?.env?.NO_EXTERNAL_NETWORK === "true";
  if (isMock || !plainRefreshToken) {
    return { success: true, mock: true };
  }

  try {
    const params = new URLSearchParams({ token: plainRefreshToken });
    const response = await fetch(GOOGLE_REVOKE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    return { success: response.ok };
  } catch (err) {
    console.error("Failed to revoke Google token:", err);
    return { success: false, error: err.message };
  }
}
