/**
 * Collectrr Personal CRM Dashboard Application Logic
 */

let allContacts = [];
let attentionStats = { attention: 0, needs_follow_up: 0, waiting_on_them: 0, recently_replied: 0 };
let currentFilter = "all";
let searchQuery = "";

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

// ----------------------------------------------------
// USER PROFILE BADGE
// ----------------------------------------------------
async function fetchUserProfile() {
  try {
    const res = await authFetch("/api/user/profile");
    if (!res.ok) return;
    const data = await res.json();
    const user = data.user || data;
    renderUserProfileBadge(user);
  } catch (err) {
    console.warn("Failed fetching user profile:", err);
    renderUserProfileBadge({ username: "DevAgent", role: "admin" });
  }
}

function renderUserProfileBadge(user) {
  const userNameEl = el("userName");
  const userRoleEl = el("userRole");
  const userAvatarEl = el("userAvatar");
  const dropdownUserName = el("dropdownUserName");
  const dropdownUserRole = el("dropdownUserRole");

  const username = user.username || user.name || "User";
  const role = user.role || "admin";
  const roleDisplay = role.charAt(0).toUpperCase() + role.slice(1);

  if (userNameEl) userNameEl.textContent = username;
  if (userRoleEl) userRoleEl.textContent = roleDisplay;
  if (dropdownUserName) dropdownUserName.textContent = username;
  if (dropdownUserRole) dropdownUserRole.textContent = roleDisplay;

  if (userAvatarEl) {
    const initials = username
      .split(" ")
      .map((n) => n[0])
      .join("")
      .slice(0, 2)
      .toUpperCase();
    userAvatarEl.textContent = initials || username.slice(0, 2).toUpperCase();
  }
}

function toggleUserDropdown(event) {
  if (event) event.stopPropagation();
  const menu = el("userDropdownMenu");
  if (!menu) return;
  menu.style.display = menu.style.display === "none" ? "block" : "none";
}

function handleLogout() {
  localStorage.removeItem("collectrr_auth");
  window.location.href = "/login.html";
}

// Close user dropdown menu when clicking anywhere outside
if (typeof document !== "undefined") {
  document.addEventListener("click", (e) => {
    const menu = el("userDropdownMenu");
    const container = el("topUserContainer");
    if (menu && menu.style.display !== "none") {
      if (!container?.contains(e.target) && !menu.contains(e.target)) {
        menu.style.display = "none";
      }
    }
  });
}

// ----------------------------------------------------
// FREEMIUM CREDITS & WALLET
// ----------------------------------------------------
async function fetchUserCredits() {
  try {
    const res = await authFetch("/api/user/credits");
    if (!res.ok) return;
    const data = await res.json();

    const isDevHost = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
    const badgeText = el("creditBadgeText");
    const badgeBtn = el("userCreditBadge");

    if (badgeBtn && badgeText) {
      // Billing / Credits concept commented out
      badgeBtn.style.display = "none";
      badgeText.textContent = data.formatted || `₹${(data.balancePaise / 100).toFixed(2)}`;
    }
    return data;
  } catch (err) {
    console.error("Failed fetching credits:", err);
  }
}

async function openRechargeModal() {
  const backdrop = el("rechargeModalBackdrop");
  if (!backdrop) return;
  backdrop.hidden = false;

  const creditData = await fetchUserCredits();
  const balanceDisplay = el("walletBalanceDisplay");
  const msgsBadge = el("walletMessagesBadge");
  const txList = el("creditTransactionsList");

  if (creditData) {
    if (balanceDisplay) balanceDisplay.textContent = creditData.formatted || `₹${(creditData.balancePaise / 100).toFixed(2)}`;
    if (msgsBadge) msgsBadge.textContent = `≈ ${creditData.messagesRemaining || 0} messages`;

    if (txList) {
      if (!creditData.transactions || creditData.transactions.length === 0) {
        txList.innerHTML = `<div style="font-size: 12px; color: #94A3B8; text-align: center; padding: 10px;">No transaction history.</div>`;
      } else {
        txList.innerHTML = creditData.transactions.map(tx => {
          const isPositive = Number(tx.amountRupees) > 0;
          const color = isPositive ? '#16A34A' : '#DC2626';
          const sign = isPositive ? '+' : '';
          const dateStr = new Date(tx.createdAt).toLocaleDateString("en-IN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

          return `<div style="display: flex; justify-content: space-between; align-items: center; padding: 6px 0; border-bottom: 1px solid #F1F5F9; font-size: 12px;">
            <div>
              <div style="font-weight: 600; color: #334155;">${tx.description || tx.transactionType}</div>
              <div style="font-size: 10px; color: #94A3B8;">${dateStr}</div>
            </div>
            <div style="font-weight: 700; color: ${color};">
              ${sign}₹${Math.abs(Number(tx.amountRupees)).toFixed(2)}
            </div>
          </div>`;
        }).join('');
      }
    }
  }
}

function closeRechargeModal() {
  const backdrop = el("rechargeModalBackdrop");
  if (backdrop) backdrop.hidden = true;
}

// ----------------------------------------------------
// CONTACTS & ATTENTION TRIAGE
// ----------------------------------------------------
async function load() {
  const errBox = el("dashboardError");
  if (errBox) errBox.style.display = "none";

  try {
    const res = await authFetch("/api/contacts");
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: Failed to fetch contacts`);
    }

    const data = await res.json();
    allContacts = data.contacts || data.cases || [];
    attentionStats = data.counts || {
      attention: 0,
      needs_follow_up: 0,
      waiting_on_them: 0,
      recently_replied: 0
    };

    updateTriageCards();
    renderTable();
  } catch (err) {
    console.error("Failed to load contacts:", err);
    if (errBox) {
      const errMsg = el("dashboardErrorMessage");
      if (errMsg) errMsg.textContent = err.message || "Failed to load contacts.";
      errBox.style.display = "flex";
    }
    const tbody = el("tbody");
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 2.5rem; color: #DC2626;">Error: ${err.message}. Click retry above.</td></tr>`;
    }
  }
}

function updateTriageCards() {
  const statAtt = el("statAttention");
  const statFol = el("statFollowUp");
  const statWait = el("statWaiting");
  const statRep = el("statReplied");

  if (statAtt) statAtt.textContent = attentionStats.attention ?? 0;
  if (statFol) statFol.textContent = attentionStats.needs_follow_up ?? 0;
  if (statWait) statWait.textContent = attentionStats.waiting_on_them ?? 0;
  if (statRep) statRep.textContent = attentionStats.recently_replied ?? 0;
}

function setAttentionFilter(filterType) {
  currentFilter = filterType;
  const statusSelect = el("statusFilter");
  if (statusSelect) {
    statusSelect.value = filterType;
  }

  const activeBadge = el("activeFilterBadge");
  if (activeBadge) {
    if (filterType === "all") {
      activeBadge.style.display = "none";
    } else {
      activeBadge.style.display = "inline-flex";
      activeBadge.innerHTML = `Filtered: <strong>${filterType.replace(/_/g, ' ')}</strong> <button type="button" onclick="setAttentionFilter('all')" style="border: none; background: none; cursor: pointer; margin-left: 4px;">✕</button>`;
    }
  }

  renderTable();
}

function onFilterChange() {
  const statusSelect = el("statusFilter");
  if (statusSelect) {
    setAttentionFilter(statusSelect.value);
  }
}

function clearAllFilters() {
  const searchInput = el("search");
  if (searchInput) searchInput.value = "";
  setAttentionFilter("all");
}

function renderTable() {
  const tbody = el("tbody");
  if (!tbody) return;

  const searchInput = el("search");
  const rawQuery = searchInput?.value?.trim() || "";
  const query = rawQuery.toLowerCase();
  const isFiltered = (currentFilter !== "all") || Boolean(query);

  let filtered = allContacts.filter(c => {
    // Search query filter
    const nameMatch = (c.name || c.contact_person || "").toLowerCase().includes(query);
    const phoneMatch = (c.phone_number || "").toLowerCase().includes(query);
    const emailMatch = (c.email || "").toLowerCase().includes(query);
    if (query && !nameMatch && !phoneMatch && !emailMatch) return false;

    // Status / Triage category filter
    if (currentFilter === "all") return true;
    if (currentFilter === "attention") {
      return Boolean(c.unread_messages > 0 || c.active_requests_count > 0 || c.delivery_status === "failed");
    }
    if (currentFilter === "needs_follow_up") {
      return (c.latest_request_status === "needs_follow_up" || c.status === "needs_follow_up");
    }
    if (currentFilter === "waiting_on_them") {
      return (c.latest_request_status === "waiting_on_them" || c.status === "waiting_on_them");
    }
    if (currentFilter === "recently_replied") {
      return Boolean(c.last_inbound_at || c.delivery_status === "replied");
    }
    if (currentFilter === "completed") {
      return (c.latest_request_status === "completed" || c.status === "completed");
    }
    return true;
  });

  if (filtered.length === 0) {
    if (isFiltered) {
      const filterLabel = query 
        ? `matching "${rawQuery}"` 
        : `in ${currentFilter.replace(/_/g, ' ')}`;
      tbody.innerHTML = `
        <tr>
          <td colspan="5" style="text-align: center; padding: 3.5rem 1rem;">
            <div style="font-size: 14px; font-weight: 600; color: #171717; margin-bottom: 10px;">No targets ${filterLabel}</div>
            <button type="button" onclick="clearAllFilters()" style="padding: 6px 14px; background: #F4F3EF; border: 1px solid #ECE8DF; border-radius: 6px; font-size: 12px; font-weight: 500; color: #171717; cursor: pointer;">Clear filter</button>
          </td>
        </tr>
      `;
    } else {
      tbody.innerHTML = `
        <tr>
          <td colspan="5" style="text-align: center; padding: 4rem 1rem;">
            <div style="font-size: 15px; font-weight: 600; color: #171717; margin-bottom: 12px;">No targets yet</div>
            <button type="button" onclick="openContactModal()" style="padding: 8px 18px; background: #171717; color: #ffffff; border: none; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer;">+ Add Target</button>
          </td>
        </tr>
      `;
    }
    return;
  }

  tbody.innerHTML = filtered.map((c, idx) => {
    const contactId = c.id;
    const name = c.name || c.contact_person || "Unnamed Target";
    const rawPhone = c.phoneNumber || c.phone_number || c.phone;
    const phone = rawPhone ? `+${String(rawPhone).replace(/^\+/, '')}` : "—";
    const email = c.email || "";

    const latestMsg = c.latest_message_content || c.latest_message || "No messages sent yet.";
    const rawDeliveryStatus = (c.latest_delivery_status || c.delivery_status || c.latestMessage?.delivery_status || "").toLowerCase();

    // Fixed Status Buckets: Replied, Read, Delivered, Sent, Failed, Queued (transitory), New
    let statusBadge;
    if (rawDeliveryStatus === "replied" || c.lastInboundAt || c.last_inbound_at) {
      statusBadge = `<span style="font-size: 12px; font-weight: 600; padding: 3px 8px; border-radius: 6px; background: #DCFCE7; color: #15803D;">Replied</span>`;
    } else if (rawDeliveryStatus === "read") {
      statusBadge = `<span style="font-size: 12px; font-weight: 600; padding: 3px 8px; border-radius: 6px; background: #ECFDF5; color: #047857;">Read</span>`;
    } else if (rawDeliveryStatus === "delivered") {
      statusBadge = `<span style="font-size: 12px; font-weight: 600; padding: 3px 8px; border-radius: 6px; background: #EFF6FF; color: #1D4ED8;">Delivered</span>`;
    } else if (rawDeliveryStatus === "failed") {
      statusBadge = `<span style="font-size: 12px; font-weight: 600; padding: 3px 8px; border-radius: 6px; background: #FEE2E2; color: #991B1B;">Failed</span>`;
    } else if (rawDeliveryStatus === "sent" || c.lastOutboundAt || c.last_outbound_at) {
      statusBadge = `<span style="font-size: 12px; font-weight: 600; padding: 3px 8px; border-radius: 6px; background: #F4F3EF; color: #4B5563;">Sent</span>`;
    } else if (rawDeliveryStatus === "queued" || rawDeliveryStatus === "claimed" || rawDeliveryStatus === "dispatch_requested") {
      statusBadge = `<span style="font-size: 12px; font-weight: 600; padding: 3px 8px; border-radius: 6px; background: #FEF3C7; color: #92400E;">Queued</span>`;
    } else {
      statusBadge = `<span style="font-size: 12px; font-weight: 600; padding: 3px 8px; border-radius: 6px; background: #F4F3EF; color: #6E6A62;">Pending</span>`;
    }

    const lastDate = c.last_interaction_at || c.last_updated || c.created_at;
    const lastActivityStr = lastDate
      ? new Date(lastDate).toLocaleDateString("en-IN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
      : "—";

    return `
      <tr onclick="if(!event.target.closest('button') && !event.target.closest('input')) window.location.href='/case.html?id=' + encodeURIComponent('${contactId}')" style="border-bottom: 1px solid #ECE8DF; font-size: 14px; cursor: pointer; transition: background 0.1s;" onmouseover="this.style.background='#FAF9F6'" onmouseout="this.style.background='transparent'">
        <td style="text-align: center; padding: 14px 16px; color: #9CA3AF;">${idx + 1}</td>
        <td style="padding: 14px 16px;">
          <a href="/case.html?id=${encodeURIComponent(contactId)}" style="font-weight: 600; color: #171717; text-decoration: none; font-size: 14px;">${name}</a>
        </td>
        <td style="padding: 14px 16px; color: #374151; max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
          ${latestMsg}
        </td>
        <td style="padding: 14px 16px;">
          ${statusBadge}
        </td>
        <!-- <td style="padding: 14px 16px; color: #6E6A62; font-size: 13px;">${lastActivityStr}</td> -->
        <td style="text-align: center; padding: 14px 16px;">
          <a href="/case.html?id=${encodeURIComponent(contactId)}" style="display: inline-block; padding: 6px 12px; font-size: 13px; font-weight: 500; background: #F4F3EF; color: #171717; border-radius: 6px; text-decoration: none;">Open</a>
        </td>
      </tr>
    `;
  }).join("");
}

// ----------------------------------------------------
// CONTACT CREATION & OUTREACH MODAL (2-STAGE WIZARD)
// ----------------------------------------------------
function goToContactStage(stage) {
  const stage1 = el("contactStage1");
  const stage2 = el("contactStage2");
  const pill1 = el("stepPill1");
  const pill2 = el("stepPill2");
  const subtitle = el("contactModalSubtitle");
  const err = el("contactStage1Error");

  if (err) err.style.display = "none";

  if (stage === 1) {
    if (stage1) stage1.style.display = "flex";
    if (stage2) stage2.style.display = "none";
    if (pill1) pill1.style.background = "#171717";
    if (pill2) pill2.style.background = "#E5E7EB";
    if (subtitle) subtitle.textContent = "Step 1 of 2 · Target Information";
  } else if (stage === 2) {
    if (stage1) stage1.style.display = "none";
    if (stage2) stage2.style.display = "flex";
    if (pill1) pill1.style.background = "#171717";
    if (pill2) pill2.style.background = "#171717";
    if (subtitle) subtitle.textContent = "Step 2 of 2 · Outreach & Message Preview";
    updateTemplatePreview();
  }
}

function handleStage1Next() {
  const name = el("contactName")?.value?.trim();
  const phone = el("contactPhone")?.value?.trim();
  const err = el("contactStage1Error");

  if (!name) {
    if (err) {
      err.textContent = "Please enter a target name.";
      err.style.display = "block";
    }
    el("contactName")?.focus();
    return;
  }

  const phoneDigits = (phone || "").replace(/\D/g, "");
  if (!phone || phoneDigits.length < 10) {
    if (err) {
      err.textContent = "Please enter a valid 10-digit mobile number.";
      err.style.display = "block";
    }
    el("contactPhone")?.focus();
    return;
  }

  goToContactStage(2);
}

function openContactModal() {
  const backdrop = el("modalBackdrop");
  if (backdrop) backdrop.hidden = false;
  goToContactStage(1);
  onChannelSelectChange();
}

function closeContactModal() {
  const backdrop = el("modalBackdrop");
  if (backdrop) backdrop.hidden = true;
}

function updateTemplatePreview() {
  const templateSelect = el("contactTemplate");
  const channelSelect = el("contactChannel");
  const nameInput = el("contactName");
  const customTextarea = el("customTextMessage");
  const previewText = el("templatePreviewText");
  const channelBadge = el("previewChannelBadge");

  if (!templateSelect || !previewText) return;

  const recipientName = (nameInput?.value?.trim()) || "Recipient";
  const channel = channelSelect?.value || "whatsapp";
  const tplId = templateSelect.value;

  if (channelBadge) {
    channelBadge.textContent = channel === "email" ? "Email" : "WhatsApp";
    channelBadge.style.background = channel === "email" ? "#EFF6FF" : "#DCFCE7";
    channelBadge.style.color = channel === "email" ? "#1E40AF" : "#166534";
  }

  if (tplId === "hello_world") {
    previewText.textContent = "Hello World";
  } else if (tplId === "custom_text") {
    const customMsg = customTextarea?.value?.trim();
    previewText.textContent = customMsg || "(Type your custom email message above)";
  } else {
    // new_convo_1 default
    previewText.textContent = `Hi ${recipientName},\n\nThank you for connecting with Collectr.\n\nPlease let us know how we can assist you.\n\nReply here if you have any questions.`;
  }
}

function onChannelSelectChange() {
  const channelSelect = el("contactChannel");
  const templateSelect = el("contactTemplate");
  const customOpt = el("optCustomText");
  if (!channelSelect || !templateSelect || !customOpt) return;

  if (channelSelect.value === "whatsapp") {
    customOpt.disabled = true;
    customOpt.textContent = "Custom Message (Requires approved Meta template for WhatsApp)";
    if (templateSelect.value === "custom_text") {
      templateSelect.value = "new_convo_1";
    }
  } else {
    customOpt.disabled = false;
    customOpt.textContent = "Custom Freeform Message (Email)";
  }
  onTemplateSelectChange();
}

function onTemplateSelectChange() {
  const select = el("contactTemplate");
  const customGroup = el("customTextGroup");
  if (select && customGroup) {
    if (select.value === "custom_text") {
      customGroup.style.display = "block";
    } else {
      customGroup.style.display = "none";
    }
  }
  updateTemplatePreview();
}

async function handleSaveTargetOnly() {
  const name = el("contactName")?.value?.trim();
  const phone = el("contactPhone")?.value?.trim();
  const email = el("contactEmail")?.value?.trim() || null;
  const channel = el("contactChannel")?.value || "whatsapp";
  const err = el("contactStage1Error");

  if (!name) {
    if (err) {
      err.textContent = "Please enter a target name.";
      err.style.display = "block";
    }
    el("contactName")?.focus();
    return;
  }

  const phoneDigits = (phone || "").replace(/\D/g, "");
  if (!phone || phoneDigits.length < 10) {
    if (err) {
      err.textContent = "Please enter a valid 10-digit mobile number.";
      err.style.display = "block";
    }
    el("contactPhone")?.focus();
    return;
  }

  const btn1 = el("btnSaveTargetOnly");
  if (btn1) {
    btn1.disabled = true;
    btn1.textContent = "Saving...";
  }

  try {
    const res = await authFetch("/api/contacts", {
      method: "POST",
      body: JSON.stringify({
        name,
        phone_number: phone,
        phoneNumber: phone,
        phone: phone,
        email,
        channel,
      }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to save target");

    closeContactModal();
    await load();
    await fetchUserCredits();
  } catch (err) {
    alert("Error saving target: " + err.message);
  } finally {
    if (btn1) {
      btn1.disabled = false;
      btn1.textContent = "Save Target Only";
    }
  }
}

async function handleContactSubmit(e) {
  e.preventDefault();
  const btn = el("btnSubmitContact");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Creating...";
  }

  const name = el("contactName")?.value?.trim();
  const phone = el("contactPhone")?.value?.trim();
  const email = el("contactEmail")?.value?.trim() || null;
  const channel = el("contactChannel")?.value || "whatsapp";
  const templateId = el("contactTemplate")?.value;
  const customText = el("customTextMessage")?.value?.trim();

  try {
    // 1. Create Contact / Target
    const res = await authFetch("/api/contacts", {
      method: "POST",
      body: JSON.stringify({
        name,
        phone_number: phone,
        phoneNumber: phone,
        phone: phone,
        email,
        channel,
      }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to create target");

    const contactId = data.contact?.id || data.id;

    // 2. Dispatch Initial Message
    if (templateId === "custom_text" && customText) {
      await authFetch(`/api/contacts/${contactId}/messages/text`, {
        method: "POST",
        body: JSON.stringify({
          channel,
          message_body: customText,
        }),
      }).catch(console.warn);
    } else if (templateId && templateId !== "none") {
      await authFetch(`/api/contacts/${contactId}/messages/template`, {
        method: "POST",
        body: JSON.stringify({
          channel,
          template_id: templateId,
          template_params: [name],
        }),
      }).catch(console.warn);
    }

    closeContactModal();
    await load();
    await fetchUserCredits();
  } catch (err) {
    alert("Error creating target: " + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Send Outreach & Save";
    }
  }
}

// ----------------------------------------------------
// BULK CSV IMPORT (NAME, MOBILE NUMBER, EMAIL, CHANNEL, TEMPLATE)
// ----------------------------------------------------
let parsedCsvContacts = [];

function parseCsvContacts(content) {
  if (!content || !content.trim()) return [];
  const lines = content.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];

  let startIndex = 0;
  let headerMap = null;

  const firstParts = lines[0].split(",").map(p => p.trim().replace(/^["']|["']$/g, "").toLowerCase());
  const hasHeader = firstParts.some(p => 
    p.includes("name") || p.includes("phone") || p.includes("mobile") || p.includes("email") || p.includes("channel") || p.includes("template")
  );

  if (hasHeader) {
    startIndex = 1;
    headerMap = {};
    firstParts.forEach((col, idx) => {
      if (col.includes("name") || col.includes("target")) headerMap.name = idx;
      else if (col.includes("phone") || col.includes("mobile")) headerMap.phone = idx;
      else if (col.includes("email")) headerMap.email = idx;
      else if (col.includes("channel")) headerMap.channel = idx;
      else if (col.includes("template") || col.includes("message")) headerMap.template = idx;
    });
  }

  const results = [];
  for (let i = startIndex; i < lines.length; i++) {
    const parts = lines[i].split(",").map(p => p.trim().replace(/^["']|["']$/g, ""));
    let name = "";
    let phone = "";
    let email = null;
    let channel = "whatsapp";
    let template = null;

    if (headerMap) {
      name = headerMap.name !== undefined ? parts[headerMap.name] || "" : parts[0] || "";
      phone = headerMap.phone !== undefined ? parts[headerMap.phone] || "" : parts[1] || "";
      email = headerMap.email !== undefined && parts[headerMap.email] ? parts[headerMap.email] : null;
      if (headerMap.channel !== undefined && parts[headerMap.channel]) {
        channel = parts[headerMap.channel].toLowerCase() === "email" ? "email" : "whatsapp";
      }
      if (headerMap.template !== undefined && parts[headerMap.template]) {
        const tplVal = parts[headerMap.template].trim();
        template = (tplVal && tplVal.toLowerCase() !== "none") ? tplVal : null;
      }
    } else {
      name = parts[0] || "";
      phone = parts[1] || "";
      email = parts[2] || null;
      if (parts[3]) {
        channel = parts[3].toLowerCase() === "email" ? "email" : "whatsapp";
      }
      if (parts[4]) {
        const tplVal = parts[4].trim();
        template = (tplVal && tplVal.toLowerCase() !== "none") ? tplVal : null;
      }
    }

    if (name && phone) {
      results.push({ name, phone, email, channel, template });
    }
  }

  return results;
}

function handleCsvFileSelect(event) {
  const file = event.target?.files?.[0];
  if (file) {
    processCsvFile(file);
  }
}

function processCsvFile(file) {
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    const content = e.target.result || "";
    if (el("bulkCsvTextarea")) {
      el("bulkCsvTextarea").value = content;
    }

    parsedCsvContacts = parseCsvContacts(content);
    if (parsedCsvContacts.length === 0) {
      alert("The selected CSV file has no valid target rows (Name, Mobile Number).");
      return;
    }

    const promptEl = el("dropzonePrompt");
    const fileInfoEl = el("dropzoneFileInfo");
    const fileNameEl = el("csvFileName");
    const fileMetaEl = el("csvFileMeta");

    if (promptEl) promptEl.style.display = "none";
    if (fileInfoEl) fileInfoEl.style.display = "block";
    if (fileNameEl) fileNameEl.textContent = file.name;
    if (fileMetaEl) fileMetaEl.textContent = `${parsedCsvContacts.length} targets ready to import`;
  };

  reader.readAsText(file);
}

function setupBulkDropzone() {
  const dropzone = el("bulkCsvDropzone");
  if (!dropzone || dropzone.dataset.hasDropzoneListeners) return;
  dropzone.dataset.hasDropzoneListeners = "true";

  dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropzone.style.borderColor = "#171717";
    dropzone.style.background = "#F4F3EF";
  });

  dropzone.addEventListener("dragleave", (e) => {
    e.preventDefault();
    dropzone.style.borderColor = "#D1D5DB";
    dropzone.style.background = "#FAF9F6";
  });

  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.style.borderColor = "#D1D5DB";
    dropzone.style.background = "#FAF9F6";
    const file = e.dataTransfer?.files?.[0];
    if (file) {
      processCsvFile(file);
    }
  });
}

function openBulkImportModal() {
  const backdrop = el("bulkImportBackdrop");
  if (backdrop) backdrop.hidden = false;

  parsedCsvContacts = [];
  const fileInput = el("bulkCsvFileInput");
  if (fileInput) fileInput.value = "";
  const textarea = el("bulkCsvTextarea");
  if (textarea) textarea.value = "";

  const promptEl = el("dropzonePrompt");
  const fileInfoEl = el("dropzoneFileInfo");
  if (promptEl) promptEl.style.display = "block";
  if (fileInfoEl) fileInfoEl.style.display = "none";

  setupBulkDropzone();
}

function closeBulkImportModal() {
  const backdrop = el("bulkImportBackdrop");
  if (backdrop) backdrop.hidden = true;
}

async function handleBulkImport() {
  const btn = el("btnRunBulkImport");

  // Fallback: if parsedCsvContacts is empty, check textarea
  if (parsedCsvContacts.length === 0) {
    const raw = el("bulkCsvTextarea")?.value || "";
    parsedCsvContacts = parseCsvContacts(raw);
  }

  if (parsedCsvContacts.length === 0) {
    alert("Please choose a CSV file with at least one target (Name, Mobile Number).");
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.textContent = `Importing ${parsedCsvContacts.length} targets...`;
  }

  let successCount = 0;
  for (const contact of parsedCsvContacts) {
    try {
      const res = await authFetch("/api/contacts", {
        method: "POST",
        body: JSON.stringify({
          name: contact.name,
          phone_number: contact.phone,
          phoneNumber: contact.phone,
          phone: contact.phone,
          email: contact.email,
          channel: contact.channel || "whatsapp",
        }),
      });
      const data = await res.json();
      if (res.ok && data.contact?.id) {
        successCount++;
        // If template column is provided and not "none", dispatch initial template outreach
        if (contact.template) {
          await authFetch(`/api/contacts/${data.contact.id}/messages/template`, {
            method: "POST",
            body: JSON.stringify({
              channel: contact.channel || "whatsapp",
              template_id: contact.template,
              template_params: [contact.name],
            }),
          }).catch(console.warn);
        }
      }
    } catch (_) {}
  }

  alert(`Successfully imported ${successCount} targets.`);
  closeBulkImportModal();
  await load();
  await fetchUserCredits();

  if (btn) {
    btn.disabled = false;
    btn.textContent = "Import Targets";
  }
}

// ----------------------------------------------------
// STATUS PRESENTATION & EXPORTS
// ----------------------------------------------------
const WHATSAPP_STATUS_ORDER = [
  'queued',
  'dispatch_requested',
  'pending',
  'sent',
  'delivered',
  'read',
  'replied',
  'failed'
];

function formatWhatsAppDeliveryStatus(status) {
  const map = {
    queued: "Queued",
    dispatch_requested: "Dispatch Requested",
    pending: "Pending",
    sent: "Sent",
    delivered: "Delivered",
    read: "Read",
    replied: "Replied",
    failed: "Failed"
  };
  return map[status] || status || "Pending";
}

function formatStatus(status) {
  const map = {
    lead: "Lead",
    documents_pending: "Docs Pending",
    ready_for_review: "Ready for Review",
    submitted: "Submitted",
    completed: "Completed",
    closed: "Closed"
  };
  return map[status] || status || "";
}

function getDisplayStatus(contact, persona = 'crm') {
  if (persona === 'direct_outreach' || persona === 'crm') {
    const raw = contact.latest_delivery_status || contact.delivery_status || contact.latestMessage?.delivery_status || contact.whatsappDeliveryStatus || contact.whatsapp_delivery_status;
    return (raw || 'pending').toLowerCase();
  }
  return contact.status || 'lead';
}

if (typeof window !== "undefined") {
  window.formatWhatsAppDeliveryStatus = formatWhatsAppDeliveryStatus;
  window.formatStatus = formatStatus;
  window.getDisplayStatus = getDisplayStatus;
  window.WHATSAPP_STATUS_ORDER = WHATSAPP_STATUS_ORDER;
  window.clearAllFilters = clearAllFilters;
  window.handleCsvFileSelect = handleCsvFileSelect;
  window.openBulkImportModal = openBulkImportModal;
  window.closeBulkImportModal = closeBulkImportModal;
  window.handleBulkImport = handleBulkImport;
  window.toggleUserDropdown = toggleUserDropdown;
  window.handleLogout = handleLogout;
}

// ----------------------------------------------------
// INITIALIZATION
// ----------------------------------------------------
document.addEventListener("DOMContentLoaded", async () => {
  const searchInput = el("search");
  if (searchInput) {
    searchInput.addEventListener("input", () => {
      renderTable();
    });
  }

  await fetchUserProfile();
  await fetchUserCredits();
  await load();
});
