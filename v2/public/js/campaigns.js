/**
 * Collectrr Campaigns & Outreach Management Controller
 */

let allCampaigns = [];
let allTemplates = [];
let allTags = [];
let activeCampaignFilter = 'all';
let currentStep = 1;
let currentAudienceEstimate = 0;
let drawerPollingTimer = null;
let activeDrawerCampaignId = null;

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

// User Profile
async function fetchUserProfile() {
  try {
    const res = await authFetch("/api/user/profile");
    if (!res.ok) return;
    const data = await res.json();
    const user = data.user || data;
    renderUserProfileBadge(user);
  } catch (err) {
    console.warn("Failed fetching user profile:", err);
    renderUserProfileBadge({ username: "User", role: "admin" });
  }
}

function renderUserProfileBadge(user) {
  const username = user.username || user.name || "User";
  const role = user.role || "admin";
  const roleDisplay = role.charAt(0).toUpperCase() + role.slice(1);

  const userNameEl = el("userName");
  const userRoleEl = el("userRole");
  const userAvatarEl = el("userAvatar");
  const dropdownUserName = el("dropdownUserName");
  const dropdownUserRole = el("dropdownUserRole");

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

  const navAnalytics = el("navAnalytics");
  const navObservability = el("navObservability");
  if (navAnalytics) navAnalytics.style.display = (role === "admin") ? "inline-block" : "none";
  if (navObservability) navObservability.style.display = (role === "admin") ? "inline-block" : "none";
}

function toggleUserDropdown(event) {
  if (event) event.stopPropagation();
  const menu = el("userDropdownMenu");
  if (!menu) return;
  menu.style.display = menu.style.display === "none" ? "block" : "none";
}

document.addEventListener("click", (e) => {
  const menu = el("userDropdownMenu");
  const topUserContainer = el("topUserContainer");
  if (menu && menu.style.display === "block" && topUserContainer && !topUserContainer.contains(e.target)) {
    menu.style.display = "none";
  }
});

function handleLogout() {
  localStorage.removeItem("collectrr_auth");
  window.location.href = "/login.html";
}

// Helpers
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatDate(isoStr) {
  if (!isoStr) return '--';
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return isoStr;
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

// Data Fetching
async function loadCampaigns() {
  try {
    const res = await authFetch("/api/campaigns");
    if (!res.ok) throw new Error("Failed to load campaigns");
    const data = await res.json();
    allCampaigns = data.campaigns || [];
    updateMetrics();
    renderCampaigns();
  } catch (err) {
    console.error("Error loading campaigns:", err);
    const tbody = el("campaignsTableBody");
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:#DC2626; padding: 36px;">Failed to load campaigns. Please refresh.</td></tr>`;
    }
  }
}

async function loadDependencies() {
  try {
    const [tplRes, tagsRes] = await Promise.all([
      authFetch("/api/templates"),
      authFetch("/api/tags").catch(() => null)
    ]);

    if (tplRes && tplRes.ok) {
      const tplData = await tplRes.json();
      allTemplates = tplData.templates || [];
    }

    if (tagsRes && tagsRes.ok) {
      const tagsData = await tagsRes.json();
      allTags = tagsData.tags || [];
      populateTagsDropdown();
    }
  } catch (err) {
    console.warn("Error loading auxiliary dependencies:", err);
  }
}

function populateTagsDropdown() {
  const tagSelect = el("cmpAudienceTag");
  if (!tagSelect) return;
  tagSelect.innerHTML = `<option value="">All Contacts (No tag filter)</option>` +
    allTags.map(t => `<option value="${escapeHtml(t.name || t)}">${escapeHtml(t.name || t)}</option>`).join('');
}

function updateMetrics() {
  let totalRecipients = 0;
  let running = 0;
  let scheduled = 0;
  let completed = 0;

  allCampaigns.forEach(c => {
    totalRecipients += (c.total_recipients || 0);
    if (c.status === 'running') running++;
    else if (c.status === 'scheduled') scheduled++;
    else if (c.status === 'completed') completed++;
  });

  if (el("metricTotalRecipients")) el("metricTotalRecipients").textContent = totalRecipients.toLocaleString();
  if (el("metricRunning")) el("metricRunning").textContent = running;
  if (el("metricScheduled")) el("metricScheduled").textContent = scheduled;
  if (el("metricCompleted")) el("metricCompleted").textContent = completed;
}

function setCampaignFilter(filter) {
  activeCampaignFilter = filter;
  ['All', 'Running', 'Scheduled', 'Completed'].forEach(f => {
    const btn = el(`filter${f}`);
    if (btn) btn.classList.remove('active');
  });

  const activeBtn = el(`filter${filter.charAt(0).toUpperCase() + filter.slice(1)}`);
  if (activeBtn) activeBtn.classList.add('active');

  renderCampaigns();
}

function renderCampaigns() {
  const tbody = el("campaignsTableBody");
  if (!tbody) return;

  let filtered = allCampaigns;
  if (activeCampaignFilter !== 'all') {
    filtered = allCampaigns.filter(c => c.status === activeCampaignFilter);
  }

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" style="text-align: center; padding: 48px 0; color: #6E6A62;">
          <div style="font-size: 15px; font-weight: 600; color: #171717; margin-bottom: 4px;">No campaigns found</div>
          <div style="font-size: 13px; color: #6E6A62;">Create a campaign to engage your network across WhatsApp or Email.</div>
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = filtered.map(cmp => {
    const total = cmp.total_recipients || 0;
    const sent = cmp.sent_count || 0;
    const delivered = cmp.delivered_count || 0;
    const read = cmp.read_count || 0;
    const replied = cmp.replied_count || 0;
    const failed = cmp.failed_count || 0;

    const sentPct = total > 0 ? ((sent - delivered - read - failed) / total) * 100 : 0;
    const delPct = total > 0 ? ((delivered - read) / total) * 100 : 0;
    const readPct = total > 0 ? (read / total) * 100 : 0;
    const failPct = total > 0 ? (failed / total) * 100 : 0;

    const replyRate = total > 0 ? Math.round((replied / total) * 100) : 0;

    let statusClass = `status-${cmp.status}`;
    let statusLabel = cmp.status;
    if (cmp.status === 'scheduled' && cmp.scheduled_for) {
      statusLabel = `Scheduled (${formatDate(cmp.scheduled_for)})`;
    }

    const channelPill = cmp.channel === 'email'
      ? `<span style="background: #EEF2FF; color: #3730A3; font-size: 11px; font-weight: 600; padding: 2px 7px; border-radius: 6px;">Email</span>`
      : `<span style="background: #E6F4ED; color: #166534; font-size: 11px; font-weight: 600; padding: 2px 7px; border-radius: 6px;">WhatsApp</span>`;

    let actionButtons = `
      <button type="button" onclick="openTelemetryDrawer('${cmp.id}')" style="padding: 5px 10px; border: 1px solid #ECE8DF; background: #ffffff; border-radius: 6px; font-size: 12px; font-weight: 600; cursor: pointer; color: #171717;">Telemetry</button>
    `;

    if (cmp.status === 'scheduled' || cmp.status === 'running') {
      actionButtons += `
        <button type="button" onclick="cancelCampaign('${cmp.id}')" style="padding: 5px 10px; border: 1px solid #FEE2E2; background: #FFF5F5; border-radius: 6px; font-size: 12px; font-weight: 600; cursor: pointer; color: #DC2626; margin-left: 6px;">Cancel</button>
      `;
    }

    return `
      <tr>
        <td>
          <div style="font-weight: 600; color: #171717; font-size: 14px;">${escapeHtml(cmp.title)}</div>
          <div style="font-size: 12px; color: #8C877D; margin-top: 2px;">${formatDate(cmp.created_at)}</div>
        </td>
        <td>
          <span class="badge-status ${statusClass}">${escapeHtml(statusLabel)}</span>
        </td>
        <td>${channelPill}</td>
        <td>
          <span style="font-weight: 600; color: #171717;">${total}</span>
          <span style="font-size: 12px; color: #6E6A62;">recipients</span>
        </td>
        <td>
          <div style="display: flex; flex-direction: column; gap: 4px;">
            <div class="telemetry-bar-container" title="Sent: ${sent}, Delivered: ${delivered}, Read: ${read}, Failed: ${failed}">
              <div class="bar-read" style="width: ${readPct}%;"></div>
              <div class="bar-delivered" style="width: ${delPct}%;"></div>
              <div class="bar-sent" style="width: ${sentPct}%;"></div>
              <div class="bar-failed" style="width: ${failPct}%;"></div>
            </div>
            <div style="font-size: 11px; color: #6E6A62;">
              ${sent}/${total} sent (${delivered} deliv, ${failed} fail)
            </div>
          </div>
        </td>
        <td>
          <span style="font-weight: 600; color: ${replied > 0 ? '#7C3AED' : '#171717'};">${replied}</span>
          <span style="font-size: 11px; color: #6E6A62;">(${replyRate}%)</span>
        </td>
        <td style="text-align: right;">
          ${actionButtons}
        </td>
      </tr>
    `;
  }).join('');
}

// ----------------------------------------------------
// CAMPAIGN CREATION WIZARD
// ----------------------------------------------------
function openCreateCampaignWizard(preselectedTemplateId = null) {
  currentStep = 1;
  el("wizardForm").reset();
  el("campaignModal").style.display = "flex";

  handleWizardChannelChange();
  if (preselectedTemplateId) {
    setTimeout(() => {
      const select = el("cmpTemplateSelect");
      if (select) {
        select.value = preselectedTemplateId;
        handleTemplateSelectChange();
      }
    }, 100);
  }

  showWizardStep(1);
  previewAudienceCount();
}

function closeCampaignModal() {
  el("campaignModal").style.display = "none";
}

function showWizardStep(step) {
  currentStep = step;
  for (let i = 1; i <= 5; i++) {
    const stepEl = el(`step${i}`);
    const dotEl = el(`stepDot${i}`);
    if (stepEl) stepEl.classList.toggle('active', i === step);
    if (dotEl) dotEl.classList.toggle('active', i === step);
  }

  el("prevStepBtn").style.display = step > 1 ? "block" : "none";
  el("nextStepBtn").style.display = step < 5 ? "block" : "none";
  el("launchCampaignBtn").style.display = step === 5 ? "block" : "none";

  if (step === 5) {
    populateReviewStep();
  }
}

function nextWizardStep() {
  if (currentStep === 1) {
    const title = el("cmpTitle").value.trim();
    if (!title) {
      alert("Please enter a campaign title.");
      return;
    }
  } else if (currentStep === 3) {
    const tplId = el("cmpTemplateSelect").value;
    if (!tplId) {
      alert("Please select a template for outreach.");
      return;
    }
  } else if (currentStep === 4) {
    const timingMode = document.querySelector('input[name="timingMode"]:checked')?.value;
    if (timingMode === 'scheduled') {
      const scheduledTime = el("cmpScheduledFor").value;
      if (!scheduledTime) {
        alert("Please specify scheduled date and time.");
        return;
      }
      if (new Date(scheduledTime) <= new Date()) {
        alert("Scheduled date and time must be in the future.");
        return;
      }
    }
  }

  if (currentStep < 5) {
    showWizardStep(currentStep + 1);
  }
}

function prevWizardStep() {
  if (currentStep > 1) {
    showWizardStep(currentStep - 1);
  }
}

function handleWizardChannelChange() {
  const channel = el("cmpChannel").value;
  const tplSelect = el("cmpTemplateSelect");
  if (!tplSelect) return;

  const filteredTpls = allTemplates.filter(t => t.channel === channel);
  tplSelect.innerHTML = `<option value="">-- Choose Template --</option>` +
    filteredTpls.map(t => `<option value="${t.id}">${escapeHtml(t.display_name || t.name)} (${t.channel})</option>`).join('');

  el("selectedTemplatePreview").style.display = "none";
  previewAudienceCount();
}

function handleTemplateSelectChange() {
  const tplId = el("cmpTemplateSelect").value;
  const previewBox = el("selectedTemplatePreview");
  const headerEl = el("selectedTemplateHeader");
  const subjectEl = el("selectedTemplateSubject");
  const bodyEl = el("selectedTemplateBody");
  const footerEl = el("selectedTemplateFooter");

  if (!tplId) {
    previewBox.style.display = "none";
    return;
  }

  const tpl = allTemplates.find(t => t.id === tplId);
  if (!tpl) return;

  previewBox.style.display = "block";

  if (tpl.channel === 'whatsapp' && tpl.whatsapp_config) {
    subjectEl.style.display = "none";
    if (tpl.whatsapp_config.header) {
      headerEl.textContent = tpl.whatsapp_config.header;
      headerEl.style.display = "block";
    } else {
      headerEl.style.display = "none";
    }
    bodyEl.textContent = tpl.whatsapp_config.body || '';
    if (tpl.whatsapp_config.footer) {
      footerEl.textContent = tpl.whatsapp_config.footer;
      footerEl.style.display = "block";
    } else {
      footerEl.style.display = "none";
    }
  } else if (tpl.channel === 'email' && tpl.email_config) {
    headerEl.style.display = "none";
    footerEl.style.display = "none";
    if (tpl.email_config.subject) {
      subjectEl.textContent = "Subject: " + tpl.email_config.subject;
      subjectEl.style.display = "block";
    } else {
      subjectEl.style.display = "none";
    }
    bodyEl.textContent = tpl.email_config.body_text || '';
  }
}

function handleTimingModeChange() {
  const mode = document.querySelector('input[name="timingMode"]:checked')?.value;
  const schedContainer = el("scheduleTimeContainer");
  if (schedContainer) {
    schedContainer.style.display = mode === 'scheduled' ? 'block' : 'none';
  }
}

async function previewAudienceCount() {
  const channel = el("cmpChannel").value;
  const tag = el("cmpAudienceTag").value;
  const attention_status = el("cmpAudienceStatus").value;
  const countEl = el("audiencePreviewCount");

  countEl.textContent = "...";

  try {
    const audience_filter = {};
    if (tag) audience_filter.tag = tag;
    if (attention_status) audience_filter.attention_status = attention_status;

    const res = await authFetch("/api/campaigns/preview-audience", {
      method: 'POST',
      body: JSON.stringify({
        channel,
        audience_filter
      })
    });

    if (!res.ok) throw new Error("Failed to preview audience");
    const data = await res.json();
    currentAudienceEstimate = data.count || 0;
    countEl.textContent = `${currentAudienceEstimate} contacts`;
  } catch (err) {
    console.warn("Failed previewing audience count:", err);
    countEl.textContent = "0 contacts";
    currentAudienceEstimate = 0;
  }
}

function populateReviewStep() {
  const title = el("cmpTitle").value.trim();
  const channel = el("cmpChannel").value;
  const tplId = el("cmpTemplateSelect").value;
  const tpl = allTemplates.find(t => t.id === tplId);
  const timingMode = document.querySelector('input[name="timingMode"]:checked')?.value;
  const scheduledTime = el("cmpScheduledFor").value;

  el("revTitle").textContent = title || '--';
  el("revChannel").textContent = channel === 'whatsapp' ? 'WhatsApp' : 'Email';
  el("revAudience").textContent = `${currentAudienceEstimate} contacts`;
  el("revTemplate").textContent = tpl ? `${tpl.display_name || tpl.name}` : '--';
  el("revTiming").textContent = timingMode === 'immediate'
    ? 'Immediate (Dispatches upon launch)'
    : `Scheduled for ${formatDate(scheduledTime)}`;
}

async function handleLaunchCampaignSubmit() {
  const launchBtn = el("launchCampaignBtn");
  launchBtn.disabled = true;
  launchBtn.textContent = "Launching...";

  const title = el("cmpTitle").value.trim();
  const description = el("cmpDescription").value.trim();
  const channel = el("cmpChannel").value;
  const tag = el("cmpAudienceTag").value;
  const attention_status = el("cmpAudienceStatus").value;
  const template_id = el("cmpTemplateSelect").value;
  const timingMode = document.querySelector('input[name="timingMode"]:checked')?.value;
  const scheduled_for = el("cmpScheduledFor").value;

  const audience_filter = {};
  if (tag) audience_filter.tag = tag;
  if (attention_status) audience_filter.attention_status = attention_status;

  try {
    // 1. Create Campaign
    const createRes = await authFetch("/api/campaigns", {
      method: 'POST',
      body: JSON.stringify({
        title,
        description,
        channel,
        audience_filter
      })
    });

    const createData = await createRes.json();
    if (!createRes.ok) throw new Error(createData.error || "Failed to create campaign");
    const campaignId = createData.campaign.id;

    // 2. Set Template/Message
    const msgRes = await authFetch(`/api/campaigns/${campaignId}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        template_id,
        channel,
        step_order: 1
      })
    });

    const msgData = await msgRes.json();
    if (!msgRes.ok) throw new Error(msgData.error || "Failed to attach message template");

    // 3. Launch or Schedule
    if (timingMode === 'immediate') {
      const launchRes = await authFetch(`/api/campaigns/${campaignId}/launch`, {
        method: 'POST'
      });
      const launchData = await launchRes.json();
      if (!launchRes.ok) throw new Error(launchData.error || "Failed to launch campaign");
    } else {
      const schedRes = await authFetch(`/api/campaigns/${campaignId}/schedule`, {
        method: 'POST',
        body: JSON.stringify({
          scheduled_for: new Date(scheduled_for).toISOString()
        })
      });
      const schedData = await schedRes.json();
      if (!schedRes.ok) throw new Error(schedData.error || "Failed to schedule campaign");
    }

    closeCampaignModal();
    await loadCampaigns();
  } catch (err) {
    alert("Error launching campaign: " + err.message);
  } finally {
    launchBtn.disabled = false;
    launchBtn.textContent = "Launch Campaign";
  }
}

async function cancelCampaign(campaignId) {
  if (!confirm("Are you sure you want to cancel this campaign? Pending deliveries will be stopped.")) return;

  try {
    const res = await authFetch(`/api/campaigns/${campaignId}/cancel`, {
      method: 'POST'
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to cancel campaign");
    await loadCampaigns();
  } catch (err) {
    alert("Error cancelling campaign: " + err.message);
  }
}

// ----------------------------------------------------
// TELEMETRY DRAWER
// ----------------------------------------------------
async function openTelemetryDrawer(campaignId) {
  activeDrawerCampaignId = campaignId;
  const drawer = el("telemetryDrawer");
  drawer.style.display = "flex";

  await fetchCampaignTelemetry(campaignId);

  // Auto-refresh telemetry every 4 seconds if open
  if (drawerPollingTimer) clearInterval(drawerPollingTimer);
  drawerPollingTimer = setInterval(() => {
    if (activeDrawerCampaignId) fetchCampaignTelemetry(activeDrawerCampaignId);
  }, 4000);
}

function closeTelemetryDrawer() {
  activeDrawerCampaignId = null;
  if (drawerPollingTimer) clearInterval(drawerPollingTimer);
  el("telemetryDrawer").style.display = "none";
}

async function fetchCampaignTelemetry(campaignId) {
  try {
    const [cmpRes, recRes] = await Promise.all([
      authFetch(`/api/campaigns/${campaignId}`),
      authFetch(`/api/campaigns/${campaignId}/recipients`)
    ]);

    if (!cmpRes.ok || !recRes.ok) return;

    const cmpData = await cmpRes.json();
    const recData = await recRes.json();
    const cmp = cmpData.campaign;
    const recipients = recData.recipients || [];

    el("drawerTitle").textContent = cmp.title;
    el("drawerSubtitle").textContent = `Status: ${cmp.status} • Channel: ${cmp.channel} • Created: ${formatDate(cmp.created_at)}`;

    el("drwTotal").textContent = cmp.total_recipients || recipients.length;
    el("drwSent").textContent = cmp.sent_count || 0;
    el("drwDelivered").textContent = cmp.delivered_count || 0;
    el("drwReplied").textContent = cmp.replied_count || 0;
    el("drwFailed").textContent = cmp.failed_count || 0;

    renderDrawerRecipients(recipients);
  } catch (err) {
    console.warn("Failed fetching campaign telemetry:", err);
  }
}

function renderDrawerRecipients(recipients) {
  const tbody = el("drawerRecipientsBody");
  if (!tbody) return;

  if (recipients.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding: 24px; color: #6E6A62;">No recipients snapshot captured.</td></tr>`;
    return;
  }

  tbody.innerHTML = recipients.map(r => {
    const target = r.phone_snapshot || r.email_snapshot || '--';
    const deliveryClass = `status-${r.delivery_status}`;
    const repliedPill = r.response_status === 'replied'
      ? `<span style="background: #F5F3FF; color: #7C3AED; font-weight: 600; padding: 2px 6px; border-radius: 4px; font-size: 11px;">Replied</span>`
      : `<span style="color: #8C877D; font-size: 11px;">No reply</span>`;

    let timeline = '';
    if (r.replied_at) {
      timeline = `Replied ${formatDate(r.replied_at)}`;
    } else if (r.delivered_at) {
      timeline = `Delivered ${formatDate(r.delivered_at)}`;
    } else if (r.sent_at) {
      timeline = `Sent ${formatDate(r.sent_at)}`;
    } else {
      timeline = `Snapshot queued`;
    }

    const errorMsg = r.error_message
      ? `<div style="color: #DC2626; font-size: 11px; margin-top: 2px;">${escapeHtml(r.error_message)}</div>`
      : '';

    return `
      <tr>
        <td>
          <div style="font-weight: 600; color: #171717;">${escapeHtml(r.recipient_name_snapshot || 'Contact')}</div>
          ${r.company_snapshot ? `<div style="font-size: 11px; color: #6E6A62;">${escapeHtml(r.company_snapshot)}</div>` : ''}
        </td>
        <td>
          <span style="font-family: monospace; font-size: 11px; color: #171717;">${escapeHtml(target)}</span>
        </td>
        <td>
          <span class="badge-status ${deliveryClass}">${escapeHtml(r.delivery_status)}</span>
          ${errorMsg}
        </td>
        <td>${repliedPill}</td>
        <td style="color: #6E6A62;">${timeline}</td>
      </tr>
    `;
  }).join('');
}

// Init
document.addEventListener("DOMContentLoaded", () => {
  fetchUserProfile();
  loadCampaigns();
  loadDependencies();

  // Check URL query parameters (e.g. ?new=true&template_id=...)
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('new') === 'true') {
    const tplId = urlParams.get('template_id');
    openCreateCampaignWizard(tplId);
  }
});
