/**
 * Email Normalization & Contact Matcher
 * Springboard V2 — Gmail Integration
 * 
 * Handles RFC address parsing, body extraction, canonical internalDate ordering,
 * and tenant-scoped contact resolution.
 */

/**
 * Extracts a normalized, lowercase email address from a header value (e.g. "John Doe <john@doe.com>" -> "john@doe.com").
 */
export function extractCleanEmail(rawAddress) {
  if (!rawAddress || typeof rawAddress !== "string") return "";
  const match = rawAddress.match(/<([^>]+)>/);
  const email = match ? match[1] : rawAddress;
  return email.trim().toLowerCase();
}

/**
 * Extracts display name if present (e.g. "John Doe <john@doe.com>" -> "John Doe").
 */
export function extractDisplayName(rawAddress) {
  if (!rawAddress || typeof rawAddress !== "string") return "";
  const match = rawAddress.match(/^([^<]+)<[^>]+>/);
  if (match) {
    return match[1].trim().replace(/^["']|["']$/g, "");
  }
  return "";
}

/**
 * Splits comma-separated address headers into an array of clean email addresses.
 */
export function extractEmailList(headerValue) {
  if (!headerValue || typeof headerValue !== "string") return [];
  return headerValue
    .split(",")
    .map((s) => extractCleanEmail(s))
    .filter(Boolean);
}

/**
 * Decodes standard base64url data into a UTF-8 string.
 */
function decodeBase64Url(data) {
  if (!data) return "";
  try {
    let base64 = data.replace(/-/g, "+").replace(/_/g, "/");
    while (base64.length % 4) base64 += "=";
    return decodeURIComponent(
      atob(base64)
        .split("")
        .map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
        .join("")
    );
  } catch (_) {
    try {
      return atob(data.replace(/-/g, "+").replace(/_/g, "/"));
    } catch (_) {
      return "";
    }
  }
}

/**
 * Recursively extracts plain text or HTML body from a Gmail message payload.
 */
export function extractEmailBody(payload) {
  if (!payload) return "";

  if (payload.body && payload.body.data) {
    return decodeBase64Url(payload.body.data);
  }

  if (payload.parts && Array.isArray(payload.parts)) {
    // Priority 1: text/plain
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body && part.body.data) {
        return decodeBase64Url(part.body.data);
      }
    }
    // Priority 2: text/html
    for (const part of payload.parts) {
      if (part.mimeType === "text/html" && part.body && part.body.data) {
        const html = decodeBase64Url(part.body.data);
        // Strip HTML tags for clean text content
        return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
      }
    }
    // Priority 3: nested multipart
    for (const part of payload.parts) {
      if (part.parts) {
        const nested = extractEmailBody(part);
        if (nested) return nested;
      }
    }
  }

  return "";
}

/**
 * Parses all relevant headers from a Gmail message object into a clean dictionary.
 */
export function parseGmailHeaders(gmailMsg) {
  const headers = gmailMsg.payload?.headers || [];
  const headerMap = {};
  for (const h of headers) {
    if (h.name && h.value) {
      headerMap[h.name.toLowerCase()] = h.value;
    }
  }

  const rawFrom = headerMap["from"] || "";
  const rawTo = headerMap["to"] || "";
  const rawCc = headerMap["cc"] || "";
  const subject = headerMap["subject"] || "(No Subject)";
  const rfcDate = headerMap["date"] || "";
  const messageRfcId = headerMap["message-id"] || "";
  const inReplyTo = headerMap["in-reply-to"] || "";
  const references = headerMap["references"] || "";

  // Canonical ordering timestamp from Gmail internalDate
  const internalEpochMs = Number(gmailMsg.internalDate || Date.now());
  const canonicalDateIso = new Date(internalEpochMs).toISOString();

  const fromEmail = extractCleanEmail(rawFrom);
  const fromName = extractDisplayName(rawFrom) || fromEmail;
  const toEmails = extractEmailList(rawTo);
  const ccEmails = extractEmailList(rawCc);
  const allRecipientEmails = Array.from(new Set([...toEmails, ...ccEmails]));

  const content = extractEmailBody(gmailMsg.payload) || gmailMsg.snippet || "";

  return {
    gmailMessageId: gmailMsg.id,
    gmailThreadId: gmailMsg.threadId,
    internalEpochMs,
    canonicalDateIso,
    rfcDate,
    messageRfcId,
    inReplyTo,
    references,
    rawFrom,
    fromEmail,
    fromName,
    rawTo,
    toEmails,
    allRecipientEmails,
    subject,
    snippet: gmailMsg.snippet || "",
    content,
  };
}

/**
 * Matches a parsed Gmail message against existing contacts belonging to the user.
 * 
 * @param {object} parsedMsg Parsed message details
 * @param {string} userGoogleEmail Connected user's Google email address
 * @param {Array<object>} userContacts Array of { id, name, email, phone_number }
 * @returns {{ matchedContact: object|null, direction: 'inbound'|'outbound', senderType: 'contact'|'user', isUnmatched: boolean }}
 */
export function matchMessageToContacts(parsedMsg, userGoogleEmail, userContacts = []) {
  const normalizedUserEmail = (userGoogleEmail || "").trim().toLowerCase();
  const contactEmailMap = new Map();

  for (const c of userContacts) {
    if (c.email) {
      contactEmailMap.set(c.email.trim().toLowerCase(), c);
    }
  }

  const isSentByUser = parsedMsg.fromEmail === normalizedUserEmail;

  if (isSentByUser) {
    // Outbound: look for contact among recipients (To / Cc)
    for (const recp of parsedMsg.allRecipientEmails) {
      if (contactEmailMap.has(recp)) {
        return {
          matchedContact: contactEmailMap.get(recp),
          direction: "outbound",
          senderType: "user",
          isUnmatched: false,
        };
      }
    }
    // Outbound email sent to someone not in CRM
    return {
      matchedContact: null,
      direction: "outbound",
      senderType: "user",
      isUnmatched: true,
    };
  } else {
    // Inbound: look for contact in From email
    if (contactEmailMap.has(parsedMsg.fromEmail)) {
      return {
        matchedContact: contactEmailMap.get(parsedMsg.fromEmail),
        direction: "inbound",
        senderType: "contact",
        isUnmatched: false,
      };
    }
    // Inbound email from unknown sender
    return {
      matchedContact: null,
      direction: "inbound",
      senderType: "contact",
      isUnmatched: true,
    };
  }
}
