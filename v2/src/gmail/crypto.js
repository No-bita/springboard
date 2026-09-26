/**
 * Edge Web Crypto AES-GCM-256 Encryption Helper
 * Springboard V2 — Gmail Integration
 * 
 * Provides authenticated encryption at rest for sensitive credentials (e.g. refresh tokens).
 * Key derivation uses HKDF with SHA-256.
 */

const ENCRYPTION_ALGORITHM = "AES-GCM";
const IV_LENGTH_BYTES = 12; // 96 bits recommended for AES-GCM
const DEFAULT_SALT = "springboard_v2_gmail_encryption_salt";

function stringToBuffer(str) {
  return new TextEncoder().encode(str);
}

function bufferToString(buf) {
  return new TextDecoder().decode(buf);
}

function base64UrlEncode(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(str) {
  let base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) {
    base64 += "=";
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Derives a 256-bit AES-GCM CryptoKey from a secret string using HKDF.
 */
async function deriveAesGcmKey(secretKey) {
  const rawKeyMaterial = stringToBuffer(secretKey);
  const importedKey = await crypto.subtle.importKey(
    "raw",
    rawKeyMaterial,
    { name: "HKDF" },
    false,
    ["deriveKey"]
  );

  return await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: stringToBuffer(DEFAULT_SALT),
      info: stringToBuffer("gmail_token_encryption")
    },
    importedKey,
    { name: ENCRYPTION_ALGORITHM, length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/**
 * Encrypts plaintext string using AES-GCM-256.
 * Output format: "iv:ciphertext" (both base64url encoded).
 */
export async function encryptToken(plaintext, secretKey) {
  if (!plaintext) return null;
  const key = await deriveAesGcmKey(secretKey);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH_BYTES));
  
  const encryptedBuffer = await crypto.subtle.encrypt(
    { name: ENCRYPTION_ALGORITHM, iv },
    key,
    stringToBuffer(plaintext)
  );

  return `${base64UrlEncode(iv)}:${base64UrlEncode(encryptedBuffer)}`;
}

/**
 * Decrypts serialized "iv:ciphertext" string using AES-GCM-256.
 */
export async function decryptToken(encryptedPayload, secretKey) {
  if (!encryptedPayload) return null;
  const parts = encryptedPayload.split(":");
  if (parts.length !== 2) {
    throw new Error("Invalid encrypted token format");
  }

  const [ivStr, cipherStr] = parts;
  const iv = new Uint8Array(base64UrlDecode(ivStr));
  const ciphertext = base64UrlDecode(cipherStr);
  const key = await deriveAesGcmKey(secretKey);

  const decryptedBuffer = await crypto.subtle.decrypt(
    { name: ENCRYPTION_ALGORITHM, iv },
    key,
    ciphertext
  );

  return bufferToString(decryptedBuffer);
}

/**
 * Generates a high-entropy PKCE code verifier and computes code challenge (S256).
 */
export async function generatePkcePair() {
  const randomBytes = crypto.getRandomValues(new Uint8Array(64));
  const codeVerifier = base64UrlEncode(randomBytes);
  
  const digest = await crypto.subtle.digest(
    "SHA-256",
    stringToBuffer(codeVerifier)
  );
  const codeChallenge = base64UrlEncode(digest);

  return { codeVerifier, codeChallenge };
}

/**
 * Signs an OAuth state payload using HMAC-SHA256.
 */
export async function signOAuthState(payload, secretKey) {
  const jsonStr = JSON.stringify(payload);
  const data = stringToBuffer(jsonStr);
  const key = await crypto.subtle.importKey(
    "raw",
    stringToBuffer(secretKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign("HMAC", key, data);
  return `${base64UrlEncode(data)}.${base64UrlEncode(signature)}`;
}

/**
 * Verifies and decodes an HMAC-SHA256 signed OAuth state string.
 */
export async function verifyOAuthState(signedState, secretKey) {
  if (!signedState || typeof signedState !== "string") return null;
  const parts = signedState.split(".");
  if (parts.length !== 2) return null;

  const [dataStr, sigStr] = parts;
  const data = base64UrlDecode(dataStr);
  const signature = base64UrlDecode(sigStr);

  const key = await crypto.subtle.importKey(
    "raw",
    stringToBuffer(secretKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const isValid = await crypto.subtle.verify("HMAC", key, signature, data);
  if (!isValid) return null;

  try {
    const payload = JSON.parse(bufferToString(data));
    return payload;
  } catch (_) {
    return null;
  }
}
