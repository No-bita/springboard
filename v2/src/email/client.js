/**
 * Resend Email Client
 * Collectrr v2 - Email Outreach Module
 * Edge-native HTTPS client for Resend REST API with native Idempotency-Key support.
 */

export async function clientSendEmail({
  to,
  subject,
  html,
  text,
  from,
  idempotencyKey,
  env = {}
}) {
  const isMock = env.MOCK_EMAIL === "true" || (env.ENVIRONMENT === "development" && !env.RESEND_API_KEY);

  const recipientList = Array.isArray(to) ? to : [to];
  const fromAddress = from || env.RESEND_FROM_EMAIL || "Springboard <onboarding@resend.dev>";

  if (isMock) {
    const mockId = "re_mock_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    return {
      success: true,
      id: mockId,
      mock: true
    };
  }

  if (!env.RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY is not configured in worker environment");
  }

  const headers = {
    "Authorization": `Bearer ${env.RESEND_API_KEY}`,
    "Content-Type": "application/json"
  };

  if (idempotencyKey) {
    headers["Idempotency-Key"] = String(idempotencyKey);
  }

  const payload = {
    from: fromAddress,
    to: recipientList,
    subject: subject || "Document Request",
    html: html || "",
    text: text || ""
  };

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  });

  const resText = await response.text();
  let resData;
  try {
    resData = JSON.parse(resText);
  } catch (_) {
    resData = { message: resText };
  }

  if (!response.ok) {
    const errCode = resData?.name || resData?.statusCode || response.status;
    const errMsg = resData?.message || resText || `HTTP ${response.status}`;
    const err = new Error(`Resend API error (${errCode}): ${errMsg}`);
    err.status = response.status;
    err.details = resData;
    throw err;
  }

  return {
    success: true,
    id: resData.id
  };
}
