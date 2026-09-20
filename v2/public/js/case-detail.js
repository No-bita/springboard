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

    renderBanner(currentContact, data.messages || [], data.customerWindow, data.requests || []);
    renderNextAction(currentContact, data.messages || [], data.requests || [], data.activities || []);
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

function formatRelativeTime(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  const now = new Date();
  const diffSec = Math.floor((now - date) / 1000);
  if (diffSec < 0 || diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDays = Math.floor(diffHour / 24);
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString('en-IN', { month: 'short', day: 'numeric' });
}

function buildContactContextLine(contact, messages = [], requests = []) {
  const parts = [];

  // 1. Company if present
  if (contact && contact.company) {
    parts.push(contact.company);
  }

  // 2. Latest Interaction / Outreach context
  const inboundMsgs = messages.filter(m => m.direction === 'inbound' || m.sender_type === 'contact');
  const outboundMsgs = messages.filter(m => m.direction === 'outbound' || !m.direction);
  const latestInbound = inboundMsgs.length > 0 ? inboundMsgs[inboundMsgs.length - 1] : null;
  const latestOutbound = outboundMsgs.length > 0 ? outboundMsgs[outboundMsgs.length - 1] : null;

  const lastInboundTime = latestInbound?.created_at || contact?.lastInboundAt || contact?.last_inbound_at;
  const lastOutboundTime = latestOutbound?.created_at || contact?.lastOutboundAt || contact?.last_outbound_at;

  const activeRequest = (requests || []).find(r => r.status !== 'completed' && r.status !== 'cancelled');

  if (lastInboundTime && (!lastOutboundTime || new Date(lastInboundTime) >= new Date(lastOutboundTime))) {
    const channel = (latestInbound?.channel || 'whatsapp').toLowerCase() === 'email' ? 'Email' : 'WhatsApp';
    const time = formatRelativeTime(lastInboundTime);
    parts.push(`Replied ${time} via ${channel}`);
  } else if (latestOutbound) {
    const channel = (latestOutbound.channel || 'whatsapp').toLowerCase() === 'email' ? 'Email' : 'WhatsApp';
    const st = (latestOutbound.delivery_status || 'sent').toLowerCase();
    const time = formatRelativeTime(lastOutboundTime);
    if (st === 'read') {
      parts.push(`Read ${time} via ${channel}`);
    } else if (st === 'delivered') {
      parts.push(`Delivered ${time} via ${channel}`);
    } else if (st === 'failed') {
      parts.push(`Delivery failed ${time} via ${channel}`);
    } else {
      parts.push(`Outreach sent ${time} via ${channel}`);
    }
  } else if (lastOutboundTime) {
    parts.push(`Outreach sent ${formatRelativeTime(lastOutboundTime)}`);
  } else {
    const createdTime = contact?.createdAt || contact?.created_at;
    if (createdTime) {
      parts.push(`Added ${formatRelativeTime(createdTime)} · Not contacted yet`);
    } else {
      parts.push('Not contacted yet');
    }
  }

  // 3. Active request snippet if available
  if (activeRequest && activeRequest.title) {
    parts.push(`Request: ${activeRequest.title}`);
  }

  return parts.join(' · ');
}

function resolveDeliveryStatus(contact, messages = [], customerWindow = null) {
  const hasInbound = messages.some(m => m.direction === 'inbound' || m.sender_type === 'contact') || 
                     Boolean(customerWindow && customerWindow.hasReplied) || 
                     Boolean(contact && (contact.lastInboundAt || contact.last_inbound_at));
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
    if (status === 'queued' || status === 'claimed' || status === 'dispatch_requested') return { label: 'Queued', bg: '#FEF3C7', color: '#92400E' };
    if (status === 'sent') return { label: 'Sent', bg: '#F4F3EF', color: '#4B5563' };
  }

  if (contact && (contact.deliveryStatus || contact.delivery_status)) {
    const st = (contact.deliveryStatus || contact.delivery_status).toLowerCase();
    if (st === 'read') return { label: 'Read', bg: '#ECFDF5', color: '#047857' };
    if (st === 'delivered') return { label: 'Delivered', bg: '#EFF6FF', color: '#1D4ED8' };
    if (st === 'failed') return { label: 'Failed', bg: '#FEE2E2', color: '#991B1B' };
    if (st === 'queued') return { label: 'Queued', bg: '#FEF3C7', color: '#92400E' };
    if (st === 'sent') return { label: 'Sent', bg: '#F4F3EF', color: '#4B5563' };
    if (st === 'replied') return { label: 'Replied', bg: '#DCFCE7', color: '#15803D' };
  }

  if (contact && (contact.lastOutboundAt || contact.last_outbound_at)) {
    return { label: 'Sent', bg: '#F4F3EF', color: '#4B5563' };
  }

  return { label: 'Not Contacted', bg: '#F4F3EF', color: '#6E6A62' };
}

function resolveActionStatus(contact, messages = [], requests = []) {
  const outboundMsgs = messages.filter(m => m.direction === 'outbound' || !m.direction);
  const latestMsg = outboundMsgs.length > 0 ? outboundMsgs[outboundMsgs.length - 1] : null;
  const rawDeliveryStatus = (latestMsg?.delivery_status || contact?.deliveryStatus || contact?.delivery_status || '').toLowerCase();

  const nowTime = Date.now();
  const fortyEightHoursAgo = new Date(nowTime - 48 * 3600 * 1000).toISOString();

  const activeRequest = (requests || []).find(r => r.status !== 'completed' && r.status !== 'cancelled');
  const isWaitingOnMe = activeRequest?.status === "waiting_on_me";
  const hasFailedMsg = rawDeliveryStatus === "failed";
  const hasUnread = (contact?.unreadCount || contact?.unread_count || 0) > 0;

  const rawAction = contact?.actionStatus || contact?.action_status;
  if (rawAction) {
    const s = rawAction.toLowerCase();
    if (s === 'needs_attention') return { label: 'Needs Attention', bg: '#FEF2F2', color: '#DC2626' };
    if (s === 'needs_follow_up') return { label: 'Needs Follow-Up', bg: '#FFF7ED', color: '#EA580C' };
    if (s === 'waiting_on_them') return { label: 'Waiting on Them', bg: '#EFF6FF', color: '#2563EB' };
    if (s === 'recently_replied') return { label: 'Recently Replied', bg: '#ECFDF5', color: '#059669' };
    if (s === 'completed') return { label: 'Completed', bg: '#F1F5F9', color: '#475569' };
    if (s === 'idle') return { label: 'Idle', bg: '#F4F3EF', color: '#6E6A62' };
  }

  if (isWaitingOnMe || hasFailedMsg || hasUnread) {
    return { label: 'Needs Attention', bg: '#FEF2F2', color: '#DC2626' };
  }
  if (activeRequest?.status === "needs_follow_up") {
    return { label: 'Needs Follow-Up', bg: '#FFF7ED', color: '#EA580C' };
  }
  const lastInbound = contact?.lastInboundAt || contact?.last_inbound_at;
  if (lastInbound && lastInbound >= fortyEightHoursAgo) {
    return { label: 'Recently Replied', bg: '#ECFDF5', color: '#059669' };
  }
  if (activeRequest?.status === "waiting_on_them" || outboundMsgs.length > 0 || contact?.lastOutboundAt || contact?.last_outbound_at) {
    return { label: 'Waiting on Them', bg: '#EFF6FF', color: '#2563EB' };
  }
  if (activeRequest?.status === "completed" || (requests.length > 0 && requests.every(r => r.status === 'completed'))) {
    return { label: 'Completed', bg: '#F1F5F9', color: '#475569' };
  }
  return { label: 'Idle', bg: '#F4F3EF', color: '#6E6A62' };
}

function resolveContactStatus(contact, messages = [], customerWindow = null, requests = []) {
  return resolveActionStatus(contact, messages, requests);
}

function renderBanner(c, messages = [], customerWindow = null, requests = []) {
  if (el("contactAvatar")) el("contactAvatar").textContent = getInitials(c.name || c.contact_person);
  if (el("clientName")) el("clientName").textContent = c.name || c.contact_person || "Unnamed Target";
  const rawPhone = c.phoneNumber || c.phone_number || c.phone;
  const cleanPhone = sanitizePhone(rawPhone);
  const cleanEmail = sanitizeEmail(c.email);

  // Delivery status badge
  const deliveryBadge = el("clientDeliveryBadge");
  if (deliveryBadge) {
    const delivery = resolveDeliveryStatus(c, messages, customerWindow);
    deliveryBadge.textContent = delivery.label;
    deliveryBadge.style.background = delivery.bg;
    deliveryBadge.style.color = delivery.color;
  }

  // Action status badge
  const statusBadge = el("clientStatusBadge");
  if (statusBadge) {
    const action = resolveActionStatus(c, messages, requests);
    statusBadge.textContent = action.label;
    statusBadge.style.background = action.bg;
    statusBadge.style.color = action.color;
  }

  // Populate Contact Details modal fields
  if (el("modalContactName")) el("modalContactName").textContent = c.name || c.contact_person || "Unnamed Target";
  if (el("modalContactPhone")) el("modalContactPhone").textContent = cleanPhone || "—";
  if (el("modalContactEmail")) el("modalContactEmail").textContent = cleanEmail || "—";
  if (el("modalContactCompany")) {
    if (c.company) {
      el("modalContactCompany").textContent = c.company;
      if (el("modalCompanyRow")) el("modalCompanyRow").style.display = "block";
    } else {
      if (el("modalCompanyRow")) el("modalCompanyRow").style.display = "none";
    }
  }
  if (el("modalContactNotes")) {
    if (c.notes) {
      el("modalContactNotes").textContent = c.notes;
      if (el("modalNotesRow")) el("modalNotesRow").style.display = "block";
    } else {
      if (el("modalNotesRow")) el("modalNotesRow").style.display = "none";
    }
  }

  // Populate Contextual line in contact header
  const contextLineEl = el("contactContextLine");
  const contextDotEl = el("contactContextDot");
  if (contextLineEl) {
    const contextText = buildContactContextLine(c, messages, requests);
    contextLineEl.textContent = contextText || "—";
    if (contextDotEl) {
      contextDotEl.style.display = contextText ? "inline" : "none";
    }
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

function openContactDetailsModal() {
  const backdrop = el("contactDetailsModalBackdrop");
  if (backdrop) backdrop.hidden = false;
}

function closeContactDetailsModal() {
  const backdrop = el("contactDetailsModalBackdrop");
  if (backdrop) backdrop.hidden = true;
}

function copyContactField(elementId, btn) {
  const target = el(elementId);
  if (!target) return;
  const text = target.textContent.trim();
  if (!text || text === "—") return;

  const finish = () => {
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = "Copied!";
      btn.style.color = "#15803D";
      setTimeout(() => {
        btn.textContent = orig;
        btn.style.color = "#6E6A62";
      }, 1500);
    }
  };

  if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(finish).catch(() => {
      fallbackCopy(text, finish);
    });
  } else {
    fallbackCopy(text, finish);
  }
}

function fallbackCopy(text, cb) {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    if (cb) cb();
  } catch (_) {}
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function getFirstName(fullName) {
  if (!fullName) return 'Contact';
  const clean = fullName.trim().split(/\s+/)[0];
  return clean || 'Contact';
}

function formatShortDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  const day = d.getDate();
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];
  return `${day} ${months[d.getMonth()]}`;
}

function renderNextAction(c, messages = [], requests = [], activities = []) {
  const container = el("nextActionContent");
  const badge = el("nextActionBadge");
  if (!container) return;

  const targetName = c?.name || c?.contact_person || "Target";
  const firstName = getFirstName(targetName);

  const inboundMsgs = messages.filter(m => m.direction === 'inbound' || m.sender_type === 'contact');
  const outboundMsgs = messages.filter(m => m.direction === 'outbound' || !m.direction);
  const latestInbound = inboundMsgs.length > 0 ? inboundMsgs[inboundMsgs.length - 1] : null;
  const latestOutbound = outboundMsgs.length > 0 ? outboundMsgs[outboundMsgs.length - 1] : null;

  const lastInboundTime = latestInbound?.created_at || c?.lastInboundAt || c?.last_inbound_at;
  const lastOutboundTime = latestOutbound?.created_at || c?.lastOutboundAt || c?.last_outbound_at;

  const rescheduleAct = (activities || []).find(a => a.activity_type === 'followup_rescheduled');

  // STATE 1: Inbound received and needs reply
  if (lastInboundTime && (!lastOutboundTime || new Date(lastInboundTime) >= new Date(lastOutboundTime))) {
    if (badge) {
      badge.textContent = "Action required";
      badge.style.background = "#DCFCE7";
      badge.style.color = "#15803D";
    }
    const relTime = formatRelativeTime(lastInboundTime);
    container.innerHTML = `
      <h2 style="font-size: 20px; font-weight: 700; color: #171717; margin: 4px 0 8px 0; line-height: 1.3;">Reply to ${escapeHtml(firstName)}.</h2>
      <div style="font-size: 13px; color: #6E6A62; margin-bottom: 20px;">
        Received · ${relTime}
      </div>
      <div>
        <button type="button" onclick="focusComposer('reply')" style="padding: 10px 22px; background: #171717; color: #ffffff; border: none; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; transition: background 0.15s ease;" onmouseover="this.style.background='#333333'" onmouseout="this.style.background='#171717'">Reply</button>
      </div>
    `;
    return;
  }

  // STATE 2: Outbound message sent (Waiting / Follow-up)
  if (latestOutbound) {
    const isFailed = (latestOutbound.delivery_status || '').toLowerCase() === 'failed';
    if (isFailed) {
      if (badge) {
        badge.textContent = "Delivery Failed";
        badge.style.background = "#FEE2E2";
        badge.style.color = "#991B1B";
      }
      container.innerHTML = `
        <h2 style="font-size: 20px; font-weight: 700; color: #DC2626; margin: 4px 0 8px 0; line-height: 1.3;">Outreach delivery failed.</h2>
        <p style="font-size: 14px; color: #6E6A62; margin: 0 0 20px 0; line-height: 1.5;">Message could not be delivered to the target. Check phone number or retry.</p>
        <div>
          <button type="button" onclick="focusComposer('retry')" style="padding: 10px 22px; background: #DC2626; color: #ffffff; border: none; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer;">Retry send</button>
        </div>
      `;
      return;
    }

    if (badge) {
      badge.textContent = "Waiting on them";
      badge.style.background = "#EFF6FF";
      badge.style.color = "#1D4ED8";
    }

    const sentDate = new Date(lastOutboundTime || latestOutbound.created_at);
    const now = new Date();
    const diffHours = (now - sentDate) / (3600 * 1000);
    const diffDays = Math.floor(diffHours / 24);

    let followUpHeadline = "Follow up in 2 days.";
    if (rescheduleAct) {
      followUpHeadline = "Follow up scheduled.";
    } else if (diffDays >= 2) {
      followUpHeadline = "Follow up now.";
    } else if (diffDays === 1) {
      followUpHeadline = "Follow up in 1 day.";
    }

    const rawMsg = latestOutbound.content || (latestOutbound.template_id ? `Outreach template: ${latestOutbound.template_id}` : "Outreach message");
    const quoteText = rawMsg.length > 90 ? rawMsg.slice(0, 90) + "..." : rawMsg;
    const sentDateStr = formatShortDate(sentDate);

    container.innerHTML = `
      <h2 style="font-size: 20px; font-weight: 700; color: #171717; margin: 4px 0 14px 0; line-height: 1.3;">${escapeHtml(followUpHeadline)}</h2>
      
      <div style="background: #FAF9F6; border: 1px solid #ECE8DF; border-radius: 10px; padding: 14px 16px; margin-bottom: 20px;">
        <div style="font-size: 12px; font-weight: 600; color: #6E6A62; margin-bottom: 6px;">Last message</div>
        <div style="font-size: 14px; color: #171717; line-height: 1.5; font-style: italic; margin-bottom: 8px;">"${escapeHtml(quoteText)}"</div>
        <div style="font-size: 12px; color: #9CA3AF;">Sent · ${sentDateStr}</div>
      </div>

      <div style="display: flex; gap: 10px; flex-wrap: wrap;">
        <button type="button" onclick="focusComposer('follow_up')" style="padding: 10px 18px; background: #171717; color: #ffffff; border: none; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; transition: background 0.15s ease;" onmouseover="this.style.background='#333333'" onmouseout="this.style.background='#171717'">Follow up now</button>
        <button type="button" onclick="openRescheduleModal()" style="padding: 10px 18px; background: #ffffff; border: 1px solid #ECE8DF; color: #171717; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; transition: background 0.15s ease;" onmouseover="this.style.background='#F8F7F4'" onmouseout="this.style.background='#ffffff'">Reschedule</button>
      </div>
    `;
    return;
  }

  // STATE 3: No outreach yet
  if (badge) {
    badge.textContent = "New Target";
    badge.style.background = "#F4F3EF";
    badge.style.color = "#6E6A62";
  }

  container.innerHTML = `
    <h2 style="font-size: 20px; font-weight: 700; color: #171717; margin: 4px 0 8px 0; line-height: 1.3;">No outreach yet.</h2>
    <p style="font-size: 14px; color: #6E6A62; margin: 0 0 20px 0; line-height: 1.5;">Send the first message to start the conversation.</p>
    <div>
      <button type="button" onclick="focusComposer('new_outreach')" style="padding: 10px 22px; background: #171717; color: #ffffff; border: none; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; transition: background 0.15s ease;" onmouseover="this.style.background='#333333'" onmouseout="this.style.background='#171717'">Send message</button>
    </div>
  `;
}

function focusComposer(mode) {
  const input = el("composerInput");
  const templateSelect = el("templateSelect");

  if (mode === 'reply') {
    if (templateSelect && !templateSelect.disabled) {
      templateSelect.value = "freeform";
    }
    if (input) input.placeholder = "Type your reply...";
  } else if (mode === 'follow_up') {
    if (templateSelect) {
      templateSelect.value = "new_convo_1";
    }
    if (input) input.placeholder = "Follow-up message / template...";
  } else if (mode === 'new_outreach' || mode === 'retry') {
    if (templateSelect) {
      templateSelect.value = "new_convo_1";
    }
    if (input) input.placeholder = "Template message will be sent...";
  }

  if (input) {
    input.scrollIntoView({ behavior: "smooth", block: "center" });
    input.focus();
    input.style.boxShadow = "0 0 0 3px rgba(37, 99, 235, 0.25)";
    input.style.borderColor = "#2563EB";
    setTimeout(() => {
      input.style.boxShadow = "none";
      input.style.borderColor = "#ECE8DF";
    }, 1500);
  }
}

function openRescheduleModal() {
  const backdrop = el("rescheduleModalBackdrop");
  if (backdrop) backdrop.hidden = false;
}

function closeRescheduleModal() {
  const backdrop = el("rescheduleModalBackdrop");
  if (backdrop) backdrop.hidden = true;
}

async function submitReschedule(days) {
  const contactId = getContactIdFromUrl();
  const targetDate = new Date(Date.now() + days * 24 * 3600 * 1000);
  const formattedDate = formatShortDate(targetDate);

  try {
    await authFetch("/api/activities", {
      method: "POST",
      body: JSON.stringify({
        contact_id: contactId,
        activity_type: "followup_rescheduled",
        title: "Follow-up Rescheduled",
        description: `Follow-up postponed by ${days} day(s) to ${formattedDate}.`,
      }),
    });
    closeRescheduleModal();
    await loadContactWorkspace();
  } catch (err) {
    alert("Failed to reschedule: " + err.message);
  }
}

if (typeof window !== "undefined") {
  window.sendMessage = sendMessage;
  window.onChannelChange = onChannelChange;
  window.addNote = addNote;
  window.toggleItem = toggleItem;
  window.resolveDeliveryStatus = resolveDeliveryStatus;
  window.resolveActionStatus = resolveActionStatus;
  window.resolveContactStatus = resolveContactStatus;
  window.renderBanner = renderBanner;
  window.openContactDetailsModal = openContactDetailsModal;
  window.closeContactDetailsModal = closeContactDetailsModal;
  window.copyContactField = copyContactField;
  window.formatRelativeTime = formatRelativeTime;
  window.buildContactContextLine = buildContactContextLine;
  window.renderNextAction = renderNextAction;
  window.focusComposer = focusComposer;
  window.openRescheduleModal = openRescheduleModal;
  window.closeRescheduleModal = closeRescheduleModal;
  window.submitReschedule = submitReschedule;
  window.formatShortDate = formatShortDate;
  window.getFirstName = getFirstName;
}

document.addEventListener("DOMContentLoaded", () => {
  loadContactWorkspace();

  const detailsBackdrop = el("contactDetailsModalBackdrop");
  if (detailsBackdrop) {
    detailsBackdrop.addEventListener("click", (e) => {
      if (e.target === detailsBackdrop) closeContactDetailsModal();
    });
  }

  const reqBackdrop = el("requestModalBackdrop");
  if (reqBackdrop) {
    reqBackdrop.addEventListener("click", (e) => {
      if (e.target === reqBackdrop) closeAddRequestModal();
    });
  }

  const reschedBackdrop = el("rescheduleModalBackdrop");
  if (reschedBackdrop) {
    reschedBackdrop.addEventListener("click", (e) => {
      if (e.target === reschedBackdrop) closeRescheduleModal();
    });
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeContactDetailsModal();
      closeAddRequestModal();
      closeRescheduleModal();
    }
  });
});

