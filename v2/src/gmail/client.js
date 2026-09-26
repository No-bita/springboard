/**
 * Edge Gmail REST Client
 * Springboard V2 — Gmail Integration
 * 
 * Zero-dependency HTTP client for Gmail REST v1 API using standard fetch.
 */

const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

/**
 * Subscribes to Gmail mailbox push notifications via Google Cloud Pub/Sub.
 */
export async function gmailWatch(accessToken, topicName, env = {}) {
  const isMock = env.MOCK_GMAIL === "true" || env.ENVIRONMENT === "test" || (typeof process !== "undefined" && process?.env?.NO_EXTERNAL_NETWORK === "true");
  if (isMock) {
    return {
      historyId: "100001",
      expiration: String(Date.now() + 7 * 24 * 3600 * 1000),
    };
  }

  const response = await fetch(`${GMAIL_API_BASE}/watch`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      topicName,
      labelIds: ["INBOX", "SENT"],
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Gmail watch failed (${response.status}): ${errText}`);
  }

  return await response.json();
}

/**
 * Stops Gmail mailbox push notifications.
 */
export async function gmailStopWatch(accessToken, env = {}) {
  const isMock = env.MOCK_GMAIL === "true" || env.ENVIRONMENT === "test" || (typeof process !== "undefined" && process?.env?.NO_EXTERNAL_NETWORK === "true");
  if (isMock) return { success: true };

  const response = await fetch(`${GMAIL_API_BASE}/stop`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${accessToken}` },
  });

  return { success: response.ok };
}

/**
 * Lists messages matching a search query (e.g. after:YYYY/MM/DD).
 */
export async function gmailListMessages(accessToken, { q, maxResults = 50, pageToken = null }, env = {}) {
  const isMock = env.MOCK_GMAIL === "true" || env.ENVIRONMENT === "test" || (typeof process !== "undefined" && process?.env?.NO_EXTERNAL_NETWORK === "true");
  if (isMock) {
    return {
      messages: [],
      nextPageToken: null,
      resultSizeEstimate: 0,
    };
  }

  const params = new URLSearchParams({ maxResults: String(maxResults) });
  if (q) params.set("q", q);
  if (pageToken) params.set("pageToken", pageToken);

  const response = await fetch(`${GMAIL_API_BASE}/messages?${params.toString()}`, {
    headers: { "Authorization": `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Gmail list messages failed (${response.status}): ${errText}`);
  }

  return await response.json();
}

/**
 * Retrieves single message details (headers, snippets, body payload).
 */
export async function gmailGetMessage(accessToken, messageId, format = "full", env = {}) {
  const isMock = env.MOCK_GMAIL === "true" || env.ENVIRONMENT === "test" || (typeof process !== "undefined" && process?.env?.NO_EXTERNAL_NETWORK === "true");
  if (isMock) {
    return {
      id: messageId,
      threadId: `thread_${messageId}`,
      internalDate: String(Date.now()),
      snippet: "Mock email snippet",
      payload: {
        headers: [
          { name: "From", value: "client@example.com" },
          { name: "To", value: "user@example.com" },
          { name: "Subject", value: "Mock Subject" },
          { name: "Date", value: new Date().toUTCString() },
        ],
        body: { data: "" },
      },
    };
  }

  const url = new URL(`${GMAIL_API_BASE}/messages/${encodeURIComponent(messageId)}`);
  url.searchParams.set("format", format);
  if (format === "metadata") {
    ["From", "To", "Cc", "Subject", "Date", "Message-ID", "In-Reply-To", "References"].forEach((h) => {
      url.searchParams.append("metadataHeaders", h);
    });
  }

  const response = await fetch(url.toString(), {
    headers: { "Authorization": `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    const error = new Error(`Gmail get message failed (${response.status}): ${errText}`);
    error.status = response.status;
    throw error;
  }

  return await response.json();
}

/**
 * Lists history records since a starting historyId.
 */
export async function gmailListHistory(accessToken, { startHistoryId, maxResults = 100, pageToken = null }, env = {}) {
  const isMock = env.MOCK_GMAIL === "true" || env.ENVIRONMENT === "test" || (typeof process !== "undefined" && process?.env?.NO_EXTERNAL_NETWORK === "true");
  if (isMock) {
    return {
      history: [],
      historyId: startHistoryId,
      nextPageToken: null,
    };
  }

  const params = new URLSearchParams({
    startHistoryId: String(startHistoryId),
    maxResults: String(maxResults),
  });
  if (pageToken) params.set("pageToken", pageToken);

  const response = await fetch(`${GMAIL_API_BASE}/history?${params.toString()}`, {
    headers: { "Authorization": `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    const error = new Error(`Gmail list history failed (${response.status}): ${errText}`);
    error.status = response.status;
    throw error;
  }

  return await response.json();
}
