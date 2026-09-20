/**
 * Meta WhatsApp Cloud API Client
 * Collectrr v2 - WhatsApp Messaging Module
 *
 * Dedicated strictly to low-level communication with Meta Graph API and Phone Normalization.
 * Contains ZERO application business logic.
 */

/**
 * Normalizes any Indian phone representation into canonical 12-digit format ('91' + 10 digits).
 * Strips all non-digit characters (+, spaces, hyphens, brackets).
 * Throws validation error if input does not resolve to a valid 10-digit Indian mobile number.
 */
export function normalizeIndianPhoneNumber(rawPhone) {
  if (!rawPhone || typeof rawPhone !== "string" && typeof rawPhone !== "number") {
    throw new Error("Please enter a valid 10-digit Indian mobile number.");
  }

  const digits = String(rawPhone).replace(/\D/g, "");

  if (/^\d{10}$/.test(digits)) {
    return "91" + digits;
  }

  if (/^0\d{10}$/.test(digits)) {
    return "91" + digits.slice(1);
  }

  if (/^91\d{10}$/.test(digits)) {
    return digits;
  }

  throw new Error("Please enter a valid 10-digit Indian mobile number (e.g. 9876543210).");
}

function resolvePhoneIds(env) {
  const phoneIds = [];
  if (env?.WHATSAPP_PROD_PHONE_ID && env.WHATSAPP_PROD_PHONE_ID.trim()) {
    phoneIds.push(env.WHATSAPP_PROD_PHONE_ID.trim());
  }
  if (env?.WHATSAPP_PHONE_ID && !phoneIds.includes(env.WHATSAPP_PHONE_ID.trim())) {
    phoneIds.push(env.WHATSAPP_PHONE_ID.trim());
  }
  if (phoneIds.length === 0) {
    throw new Error("WhatsApp Phone Number ID is not configured. Please set WHATSAPP_PHONE_ID or WHATSAPP_PROD_PHONE_ID in your environment.");
  }
  return phoneIds;
}

/**
 * Dispatch an approved Meta template message.
 * Iterates through available phone IDs, languages, and payloads until successful.
 */
export async function sendWhatsAppTemplate({
  phone,
  templateConfig,
  templateParams = {},
  env,
}) {
  const isMock =
    env?.MOCK_WHATSAPP !== undefined
      ? env.MOCK_WHATSAPP === "true"
      : (typeof process !== "undefined" && (process.env?.MOCK_WHATSAPP === "true" || process.env?.NODE_ENV === "test")) ||
        (env?.ENVIRONMENT === "development" && !env?.WHATSAPP_ACCESS_TOKEN && !env?.WHATSAPP_PHONE_ID) ||
        env?.ENVIRONMENT === "test";

  if (isMock) {
    const mockStatus = (
      env?.MOCK_WHATSAPP_STATUS !== undefined
        ? env.MOCK_WHATSAPP_STATUS
        : (typeof process !== "undefined" && process.env?.MOCK_WHATSAPP_STATUS) ||
          "sent"
    ).toLowerCase();

    if (mockStatus === "failed") {
      throw new Error(`[Mock WhatsApp] Template dispatch failed (status: ${mockStatus})`);
    }

    const mockId = `wamid.mock_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    return {
      messaging_product: "whatsapp",
      contacts: [{ input: phone, wa_id: phone }],
      messages: [{ id: mockId, message_status: mockStatus }],
    };
  }

  const primaryLang = templateConfig.defaultLang || "en";
  const langCodesToTry = [primaryLang];
  const phoneIdsToTry = resolvePhoneIds(env);

  let lastErrorData = null;
  const attemptedErrors = [];

  for (const phoneId of phoneIdsToTry) {
    const url = `https://graph.facebook.com/v17.0/${phoneId}/messages`;

    for (const langCode of langCodesToTry) {
      const payloads = templateConfig.getPayloads({
        phone,
        ...templateParams,
        langCode,
      });

      for (const payload of payloads) {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });

        const data = await res.json();
        if (res.ok) return data;

        lastErrorData = data;
        attemptedErrors.push(
          `[${phoneId}/${langCode}/${payload.template?.name}]: ${
            data?.error?.message || res.statusText
          }`
        );
      }
    }
  }

  const details =
    lastErrorData?.error?.error_data?.details ||
    lastErrorData?.error?.message ||
    "";
  throw new Error(
    `${details || "Failed to send WhatsApp template message"} (Attempts: ${attemptedErrors.join(" | ")})`
  );
}

/**
 * Dispatch a free-form WhatsApp text message during the 24h customer window.
 */
export async function sendWhatsAppText(phone, messageText, env) {
  const isMock =
    env?.MOCK_WHATSAPP !== undefined
      ? env.MOCK_WHATSAPP === "true"
      : (typeof process !== "undefined" && (process.env?.MOCK_WHATSAPP === "true" || process.env?.NODE_ENV === "test")) ||
        (env?.ENVIRONMENT === "development" && !env?.WHATSAPP_ACCESS_TOKEN && !env?.WHATSAPP_PHONE_ID) ||
        env?.ENVIRONMENT === "test";

  if (isMock) {
    const mockStatus = (
      env?.MOCK_WHATSAPP_STATUS !== undefined
        ? env.MOCK_WHATSAPP_STATUS
        : (typeof process !== "undefined" && process.env?.MOCK_WHATSAPP_STATUS) ||
          "sent"
    ).toLowerCase();

    if (mockStatus === "failed") {
      throw new Error(`[Mock WhatsApp] Text message dispatch failed (status: ${mockStatus})`);
    }

    const mockId = `wamid.mock_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    return {
      messaging_product: "whatsapp",
      contacts: [{ input: phone, wa_id: phone }],
      messages: [{ id: mockId, message_status: mockStatus }],
    };
  }

  const phoneIdsToTry = resolvePhoneIds(env);

  let lastErrorData = null;
  const attemptedErrors = [];

  for (const phoneId of phoneIdsToTry) {
    const url = `https://graph.facebook.com/v17.0/${phoneId}/messages`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: phone,
        type: "text",
        text: { body: messageText },
      }),
    });

    const data = await res.json();
    if (res.ok) return data;

    lastErrorData = data;
    attemptedErrors.push(`[${phoneId}]: ${data?.error?.message || res.statusText}`);
  }

  const details =
    lastErrorData?.error?.error_data?.details ||
    lastErrorData?.error?.message ||
    "";
  throw new Error(
    `${details || "Failed to send WhatsApp text message"} (Attempts: ${attemptedErrors.join(" | ")})`
  );
}
