/**
 * Collectrr Contact Workspace Application Logic
 */

let currentContact = null;
let currentWindowStatus = null;
const el = (id) => document.getElementById(id);

async function authFetch(url, options = {}) {
  let token = localStorage.getItem('collectrr_auth');
  const isDev = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

  if (!token && isDev) {
    token = 'Bearer dev_token';
  } else if (!token) {
    window.location.href = `/login.html?redirect=${encodeURIComponent(window.location.pathname + window.location.search)}`;
    throw new Error("Authentication required");
  }

  const headers = {
    ...options.headers,
    'Authorization': token,
    'Content-Type': 'application/json',
  };

  const res = await fetch(url, { ...options, headers });
  if (res.status === 401 && !isDev) {
    localStorage.removeItem('collectrr_auth');
    window.location.href = `/login.html?redirect=${encodeURIComponent(window.location.pathname + window.location.search)}`;
    throw new Error("Session expired. Please log in again.");
  }
  return res;
}

function getContactIdFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get("id");
}

function getInitials(name) {
  if (!name) return "--";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

async function loadContactWorkspace() {
  const contactId = getContactIdFromUrl();
  if (!contactId) {
    window.location.href = "/dashboard.html";
    return;
  }

  try {
    const res = await authFetch(`/api/contacts/${encodeURIComponent(contactId)}`);
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || `HTTP ${res.status}: Failed to load target workspace`);
    }

    const data = await res.json();
    currentContact = data.contact || data;

    renderBanner(currentContact, data.messages || [], data.customerWindow);
    renderMessages(data.messages || []);
    renderRequests(data.requests || []);
    renderActivities(data.activities || []);

    if (data.customerWindow) {
      applyWindowStatus(data.customerWindow);
    }
  } catch (err) {
    console.error("Workspace load error:", err);
    if (el("clientName")) el("clientName").textContent = "Error loading target";
    const chat = el("chatContainer");
    if (chat) chat.innerHTML = `<div style="text-align: center; color: #DC2626; padding: 2rem;">Error: ${err.message}</div>`;
  }
}

function sanitizePhone(raw) {
  if (!raw || raw === '—') return '';
  let str = String(raw).trim();
  const hasPlus = str.startsWith('+');
  const digits = str.replace(/\D/g, '');
  if (!digits) return '';
  
  if (digits.length <= 4) return (hasPlus ? '+' : '') + digits;
  if (digits.length >= 10) {
    const prefix = hasPlus ? '+' : (digits.length > 10 ? '+' : '');
    const visibleStart = digits.slice(0, digits.length > 10 ? (digits.length - 8) : 2);
    const visibleEnd = digits.slice(-3);
    return `${prefix}${visibleStart}****${visibleEnd}`;
  }
  const visibleStart = digits.slice(0, 2);
  const visibleEnd = digits.slice(-2);
  return `${hasPlus ? '+' : ''}${visibleStart}****${visibleEnd}`;
}

function sanitizeEmail(email) {
  if (!email || !email.includes('@')) return email || '';
  const [user, domain] = email.split('@');
  if (user.length <= 2) {
    return `${user.charAt(0)}*@${domain}`;
  }
  const start = user.slice(0, 3);
  const end = user.length > 5 ? user.slice(-2) : '';
  return `${start}***${end}@${domain}`;
}

function resolveContactStatus(contact, messages = [], customerWindow = null) {
  const hasInbound = messages.some(m => m.direction === 'inbound' || m.sender_type === 'contact') || (customerWindow && customerWindow.hasReplied);
  if (hasInbound) {
    return { label: 'Replied', bg: '#DCFCE7', color: '#15803D' };
  }

  const outboundMsgs = messages.filter(m => m.direction === 'outbound' || !m.direction);
  const latestMsg = outboundMsgs.length > 0 ? outboundMsgs[outboundMsgs.length - 1] : null;

  if (latestMsg) {
    const status = (latestMsg.delivery_status || 'sent').toLowerCase();
    if (status === 'read') return { label: 'Read', bg: '#ECFDF5', color: '#047857' };
    if (status === 'delivered') return { label: 'Delivered', bg: '#EFF6FF', color: '#1D4ED8' };
    if (status === 'failed') return { label: 'Failed', bg: '#FEE2E2', color: '#991B1B' };
    if (status === 'sent') return { label: 'Sent', bg: '#F4F3EF', color: '#6E6A62' };
  }

  if (contact && contact.status) {
    const s = contact.status.toLowerCase();
    if (s === 'lead') return { label: 'New', bg: '#F4F3EF', color: '#6E6A62' };
    return { label: contact.status.replace(/_/g, ' '), bg: '#F4F3EF', color: '#171717' };
  }

  return { label: 'New', bg: '#F4F3EF', color: '#6E6A62' };
}

function renderBanner(c, messages = [], customerWindow = null) {
  if (el("contactAvatar")) el("contactAvatar").textContent = getInitials(c.name || c.contact_person);
  if (el("clientName")) el("clientName").textContent = c.name || c.contact_person || "Unnamed Target";
  const rawPhone = c.phoneNumber || c.phone_number || c.phone;
  const cleanPhone = sanitizePhone(rawPhone);
  const cleanEmail = sanitizeEmail(c.email);

  if (el("clientPhone")) {
    el("clientPhone").textContent = cleanPhone || (cleanEmail ? "" : "—");
    el("clientPhone").style.display = cleanPhone ? "inline" : (cleanEmail ? "none" : "inline");
  }
  if (el("clientEmail")) {
    el("clientEmail").textContent = cleanEmail ? (cleanPhone ? `· ${cleanEmail}` : cleanEmail) : "";
    el("clientEmail").style.display = cleanEmail ? "inline" : "none";
  }

  const statusBadge = el("clientStatusBadge");
  if (statusBadge) {
    const resolved = resolveContactStatus(c, messages, customerWindow);
    statusBadge.textContent = resolved.label;
    statusBadge.style.background = resolved.bg;
    statusBadge.style.color = resolved.color;
  }
}

function applyWindowStatus(data) {
  currentWindowStatus = data;
  const banner = el("customerWindowBanner");
  const templateSelect = el("templateSelect");
  const statusText = el("windowStatusText");
  const input = el("composerInput");
  const channel = el("channelSelect")?.value || "whatsapp";

  if (channel === "email") {
    if (banner) banner.style.display = "none";
    if (statusText) statusText.textContent = "Email Outreach";
    return;
  }

  const isOpen = Boolean(data && data.isOpen);

  if (isOpen) {
    if (banner) banner.style.display = "none";
    if (statusText) statusText.textContent = "WhatsApp (24h Window Open)";
    if (templateSelect) {
      templateSelect.innerHTML = `
        <option value="freeform" selected>Direct Freeform Message</option>
        <option value="new_convo_1">New Outreach Template (new_convo_1)</option>
        <option value="hello_world">Meta Hello World (hello_world)</option>
      `;
    }
    if (input) {
      input.placeholder = "Type a message...";
    }
  } else {
    if (banner) banner.style.display = "block";
    if (statusText) statusText.textContent = "WhatsApp (Template Mode)";
    if (templateSelect) {
      templateSelect.innerHTML = `
        <option value="new_convo_1" selected>New Outreach Template (new_convo_1)</option>
        <option value="hello_world">Meta Hello World (hello_world)</option>
        <option value="freeform" disabled>Direct Freeform Message (Disabled until target replies)</option>
      `;
    }
    if (input) {
      input.placeholder = "Template message will be sent...";
    }
  }
}

function onTemplateSelectChange() {
  const templateSelect = el("templateSelect");
  const input = el("composerInput");
  if (!templateSelect || !input) return;

  if (templateSelect.value === "freeform") {
    input.placeholder = "Type a message...";
  } else {
    input.placeholder = "Template message parameters populated automatically...";
  }
}

async function checkWindowStatus(contactId) {
  if (currentContact && currentWindowStatus) {
    applyWindowStatus(currentWindowStatus);
  }
}

function renderMessages(messages) {
  const container = el("chatContainer");
  if (!container) return;

  if (messages.length === 0) {
    container.innerHTML = `<div style="text-align: center; color: #9CA3AF; padding: 2.5rem 1rem;">No messages in this conversation yet. Send a message below.</div>`;
    return;
  }

  container.innerHTML = messages.map(m => {
    const isOutbound = m.direction === "outbound";
    const channelName = m.channel === "email" ? "Email" : "WhatsApp";
    const statusText = m.delivery_status ? ` · ${m.delivery_status}` : "";
    const timeStr = m.created_at
      ? new Date(m.created_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })
      : "";

    return `
      <div class="chat-bubble ${isOutbound ? 'outbound' : 'inbound'}">
        <div style="font-size: 11px; font-weight: 600; color: ${isOutbound ? '#6E6A62' : '#2563EB'}; margin-bottom: 2px;">${channelName}</div>
        <div>${m.content || "—"}</div>
        <div class="chat-meta">
          <span>${timeStr}${statusText}</span>
        </div>
      </div>
    `;
  }).join("");

  container.scrollTop = container.scrollHeight;
}

function renderRequests(requests) {
  const container = el("requestsList");
  if (!container) return;

  if (requests.length === 0) {
    container.innerHTML = `<div style="color: #6E6A62; font-size: 13px; text-align: center; padding: 1rem;">No active requests.</div>`;
    return;
  }

  container.innerHTML = requests.map(req => {
    const items = req.items || [];
    const itemsHtml = items.map(item => `
      <label class="checklist-item ${item.is_completed ? 'done' : ''}">
        <input type="checkbox" ${item.is_completed ? 'checked' : ''} onchange="toggleItem('${req.id}', '${item.id}', this.checked)" />
        <span>${item.title}</span>
      </label>
    `).join("");

    return `
      <div class="request-card">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
          <strong style="font-size: 14px; color: #171717;">${req.title}</strong>
          <span style="font-size: 11px; font-weight: 600; padding: 2px 6px; border-radius: 4px; background: #ECE8DF;">${(req.status || 'open').replace(/_/g, ' ')}</span>
        </div>
        <div>${itemsHtml || '<div style="font-size: 12px; color: #9CA3AF;">No items.</div>'}</div>
      </div>
    `;
  }).join("");
}

function renderActivities(activities) {
  const container = el("activityTimeline");
  if (!container) return;

  if (activities.length === 0) {
    container.innerHTML = `<div style="color: #6E6A62; font-size: 13px; text-align: center; padding: 1rem;">No activity logged yet.</div>`;
    return;
  }

  container.innerHTML = activities.map(act => {
    const dateStr = act.created_at
      ? new Date(act.created_at).toLocaleDateString("en-IN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
      : "";

    const isCreation = act.activity_type === 'contact_created' || act.title === 'Contact Created' || act.title === 'Target Created';
    const displayDesc = isCreation ? "" : (act.description || "");

    return `
      <div class="timeline-item">
        <div class="timeline-dot"></div>
        <div>
          <div style="font-weight: 600; color: #171717;">${act.title === 'Contact Created' ? 'Target Created' : (act.title || act.activity_type)}</div>
          ${displayDesc ? `<div style="color: #4B5563; margin-top: 2px;">${displayDesc}</div>` : ''}
          <div style="font-size: 11px; color: #9CA3AF; margin-top: 2px;">${dateStr}</div>
        </div>
      </div>
    `;
  }).join("");
}

function onChannelChange() {
  const channel = el("channelSelect")?.value || "whatsapp";
  const templateSelect = el("templateSelect");
  const banner = el("customerWindowBanner");
  const statusText = el("windowStatusText");
  const input = el("composerInput");

  if (channel === "email") {
    if (banner) banner.style.display = "none";
    if (statusText) statusText.textContent = "Email Outreach";
    if (templateSelect) {
      templateSelect.innerHTML = `
        <option value="freeform" selected>Direct Custom Email</option>
        <option value="general_outreach">Document Request (general_outreach)</option>
        <option value="welcome_outreach">Welcome Introduction (welcome_outreach)</option>
      `;
    }
    if (input) {
      input.placeholder = "Type email message...";
    }
  } else if (channel === "both") {
    if (banner) banner.style.display = "none";
    if (statusText) statusText.textContent = "WhatsApp + Email Outreach";
    if (templateSelect) {
      templateSelect.innerHTML = `
        <option value="new_convo_1" selected>New Outreach Template (new_convo_1)</option>
        <option value="hello_world">Meta Hello World (hello_world)</option>
      `;
    }
    if (input) {
      input.placeholder = "Template message will be sent across WhatsApp & Email...";
    }
  } else {
    if (currentWindowStatus) {
      applyWindowStatus(currentWindowStatus);
    } else {
      const contactId = getContactIdFromUrl();
      if (contactId) checkWindowStatus(contactId);
    }
  }
}

async function sendMessage() {
  const contactId = getContactIdFromUrl();
  const input = el("composerInput");
  const templateSelect = el("templateSelect");
  const channelSelect = el("channelSelect");
  const btn = el("btnSendMessage");

  const messageBody = input?.value?.trim();
  const selectedTemplate = templateSelect?.value;
  const selectedChannel = channelSelect?.value || "whatsapp";

  if (!messageBody && selectedTemplate === "freeform") {
    alert("Please enter a message.");
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.textContent = "Sending...";
  }

  try {
    const payload = {
      channel: selectedChannel,
    };

    if (selectedTemplate === "freeform") {
      payload.message_body = messageBody;
    } else {
      payload.template_id = selectedTemplate;
      payload.template_params = [currentContact?.name || "Client"];
      if (selectedChannel === "email" && messageBody) {
        payload.template_params = [messageBody];
      }
    }

    const res = await authFetch(`/api/contacts/${contactId}/messages`, {
      method: "POST",
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    if (!res.ok) {
      if (data.error === "CUSTOMER_WINDOW_CLOSED") {
        alert("The 24-hour service window is closed. Please send a pre-approved template instead.");
        templateSelect.value = "new_convo_1";
      } else {
        alert("Message failed: " + (data.message || data.error));
      }
      return;
    }

    if (input) input.value = "";
    await loadContactWorkspace();
  } catch (err) {
    alert("Error sending message: " + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Send";
    }
  }
}

async function toggleItem(requestId, itemId, isCompleted) {
  try {
    await authFetch(`/api/requests/${requestId}/items/${itemId}`, {
      method: "PATCH",
      body: JSON.stringify({ is_completed: isCompleted }),
    });
    await loadContactWorkspace();
  } catch (err) {
    console.error("Failed to update checklist item:", err);
  }
}

function openAddRequestModal() {
  const backdrop = el("requestModalBackdrop");
  if (backdrop) backdrop.hidden = false;
}

function closeAddRequestModal() {
  const backdrop = el("requestModalBackdrop");
  if (backdrop) backdrop.hidden = true;
}

async function handleCreateRequest(e) {
  e.preventDefault();
  const contactId = getContactIdFromUrl();
  const title = el("reqTitleInput")?.value?.trim();
  const itemsRaw = el("reqItemsInput")?.value || "";

  const items = itemsRaw
    .split("\n")
    .map(s => s.trim())
    .filter(Boolean)
    .map((itemTitle, i) => ({ title: itemTitle, display_order: i + 1 }));

  try {
    await authFetch(`/api/contacts/${contactId}/requests`, {
      method: "POST",
      body: JSON.stringify({ title, items }),
    });
    closeAddRequestModal();
    await loadContactWorkspace();
  } catch (err) {
    alert("Failed to create request: " + err.message);
  }
}

async function addNote() {
  const contactId = getContactIdFromUrl();
  const noteInput = el("noteInput");
  const text = noteInput?.value?.trim();
  if (!text) return;

  try {
    await authFetch("/api/activities", {
      method: "POST",
      body: JSON.stringify({
        contact_id: contactId,
        activity_type: "note_added",
        title: "Internal Note",
        description: text,
      }),
    });
    if (noteInput) noteInput.value = "";
    await loadContactWorkspace();
  } catch (err) {
    alert("Failed to add note: " + err.message);
  }
}

if (typeof window !== "undefined") {
  window.sendMessage = sendMessage;
  window.onChannelChange = onChannelChange;
  window.addNote = addNote;
  window.toggleItem = toggleItem;
}

document.addEventListener("DOMContentLoaded", () => {
  loadContactWorkspace();
});

