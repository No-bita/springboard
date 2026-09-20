/**
 * Collectrr Templates Management Logic
 */

let allTemplates = [];
let activeFilter = 'all';

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

// Fetch Templates
async function loadTemplates() {
  const container = el("templatesContainer");
  try {
    const res = await authFetch("/api/templates");
    if (!res.ok) throw new Error("Failed to load templates");
    const data = await res.json();
    allTemplates = data.templates || [];
    renderTemplates();
  } catch (err) {
    console.error("Error loading templates:", err);
    if (container) {
      container.innerHTML = `<div style="grid-column: 1 / -1; text-align: center; color: #DC2626; padding: 48px 0;">Failed to load templates. Please refresh.</div>`;
    }
  }
}

function setChannelFilter(filter) {
  activeFilter = filter;
  ['All', 'WhatsApp', 'Email', 'Custom'].forEach(f => {
    const btn = el(`filter${f}`);
    if (btn) btn.classList.remove('active');
  });

  const activeBtn = el(`filter${filter.charAt(0).toUpperCase() + filter.slice(1)}`);
  if (activeBtn) activeBtn.classList.add('active');

  renderTemplates();
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

function highlightVariables(text) {
  if (!text) return '';
  const escaped = escapeHtml(text);
  return escaped.replace(/(\{\{[^}]+\}\})/g, '<span class="var-token">$1</span>');
}

function renderTemplates() {
  const container = el("templatesContainer");
  if (!container) return;

  let filtered = allTemplates;
  if (activeFilter === 'whatsapp') {
    filtered = allTemplates.filter(t => t.channel === 'whatsapp');
  } else if (activeFilter === 'email') {
    filtered = allTemplates.filter(t => t.channel === 'email');
  } else if (activeFilter === 'custom') {
    filtered = allTemplates.filter(t => !t.is_system);
  }

  if (filtered.length === 0) {
    container.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 60px 0; background: #ffffff; border: 1px dashed #ECE8DF; border-radius: 16px;">
        <div style="font-size: 15px; font-weight: 600; color: #171717; margin-bottom: 6px;">No templates found</div>
        <div style="font-size: 13px; color: #6E6A62; margin-bottom: 16px;">Create a message template for WhatsApp or Email to start outreach.</div>
        <button type="button" onclick="openCreateTemplateModal()" style="padding: 8px 16px; background: #171717; color: #ffffff; border-radius: 8px; border: none; font-size: 13px; font-weight: 600; cursor: pointer;">+ Create Template</button>
      </div>
    `;
    return;
  }

  container.innerHTML = filtered.map(tpl => {
    const isWa = tpl.channel === 'whatsapp';
    const channelBadge = isWa
      ? `<span class="channel-badge-wa">WhatsApp</span>`
      : `<span class="channel-badge-em">Email</span>`;

    const systemBadge = tpl.is_system
      ? `<span style="font-size: 11px; font-weight: 600; background: #F4F3EF; color: #6E6A62; padding: 2px 7px; border-radius: 6px;">System</span>`
      : `<span style="font-size: 11px; font-weight: 600; background: #EFF6FF; color: #1D4ED8; padding: 2px 7px; border-radius: 6px;">Custom</span>`;

    let bodyPreview = '';
    let subjectPreview = '';

    if (isWa && tpl.whatsapp_config) {
      bodyPreview = tpl.whatsapp_config.body || '';
    } else if (!isWa && tpl.email_config) {
      bodyPreview = tpl.email_config.body_text || '';
      if (tpl.email_config.subject) {
        subjectPreview = `<div style="font-weight: 600; font-size: 13px; color: #171717; margin-bottom: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">Subject: ${escapeHtml(tpl.email_config.subject)}</div>`;
      }
    }

    const editButton = !tpl.is_system
      ? `<button type="button" onclick="openEditTemplateModal('${tpl.id}')" style="padding: 5px 10px; border: 1px solid #ECE8DF; background: #ffffff; border-radius: 6px; font-size: 12px; font-weight: 500; cursor: pointer; color: #171717;">Edit</button>`
      : '';

    const deleteButton = !tpl.is_system
      ? `<button type="button" onclick="deleteTemplate('${tpl.id}')" style="padding: 5px 10px; border: 1px solid #FEE2E2; background: #FFF5F5; border-radius: 6px; font-size: 12px; font-weight: 500; cursor: pointer; color: #DC2626;">Delete</button>`
      : '';

    return `
      <div class="template-card">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 10px;">
          <div>
            <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 4px;">
              ${channelBadge}
              ${systemBadge}
            </div>
            <h3 style="font-size: 15px; font-weight: 600; color: #171717; margin: 0;">${escapeHtml(tpl.display_name || tpl.name)}</h3>
            <div style="font-size: 12px; color: #8C877D; font-family: monospace; margin-top: 2px;">${escapeHtml(tpl.name)}</div>
          </div>
        </div>

        <div class="template-preview-box">
          ${subjectPreview}
          <div>${highlightVariables(bodyPreview)}</div>
        </div>

        <div style="display: flex; justify-content: space-between; align-items: center; margin-top: auto; pt: 12px; border-top: 1px solid #F4F3EF; padding-top: 12px;">
          <a href="/campaigns.html?new=true&template_id=${encodeURIComponent(tpl.id)}" style="font-size: 12px; font-weight: 600; color: #171717; text-decoration: none; display: flex; align-items: center; gap: 4px;">
            Use in Campaign &rarr;
          </a>
          <div style="display: flex; gap: 6px;">
            ${editButton}
            ${deleteButton}
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// Modal handling
function openCreateTemplateModal() {
  el("modalTitle").textContent = "New Message Template";
  el("editingTemplateId").value = "";
  el("tplChannel").disabled = false;
  el("tplName").disabled = false;
  el("templateForm").reset();
  handleChannelChange();
  updateLivePreview();
  el("templateModal").style.display = "flex";
}

function openEditTemplateModal(templateId) {
  const tpl = allTemplates.find(t => t.id === templateId);
  if (!tpl || tpl.is_system) return;

  el("modalTitle").textContent = "Edit Template";
  el("editingTemplateId").value = tpl.id;
  el("tplChannel").value = tpl.channel;
  el("tplChannel").disabled = true; // Channel immutable once created
  el("tplName").value = tpl.name;
  el("tplName").disabled = true;
  el("tplDisplayName").value = tpl.display_name || '';

  handleChannelChange();

  if (tpl.channel === 'whatsapp' && tpl.whatsapp_config) {
    el("tplCategory").value = tpl.whatsapp_config.category || 'UTILITY';
    el("tplLanguage").value = tpl.whatsapp_config.language || 'en';
    el("tplHeader").value = tpl.whatsapp_config.header || '';
    el("tplBody").value = tpl.whatsapp_config.body || '';
    el("tplFooter").value = tpl.whatsapp_config.footer || '';
  } else if (tpl.channel === 'email' && tpl.email_config) {
    el("tplSubject").value = tpl.email_config.subject || '';
    el("tplBody").value = tpl.email_config.body_text || '';
  }

  updateLivePreview();
  el("templateModal").style.display = "flex";
}

function closeTemplateModal() {
  el("templateModal").style.display = "none";
}

function handleChannelChange() {
  const channel = el("tplChannel").value;
  const waFields = el("waFields");
  const waFooterFields = el("waFooterFields");
  const emailFields = el("emailFields");

  if (channel === 'whatsapp') {
    waFields.style.display = "block";
    waFooterFields.style.display = "block";
    emailFields.style.display = "none";
  } else {
    waFields.style.display = "none";
    waFooterFields.style.display = "none";
    emailFields.style.display = "block";
  }
  updateLivePreview();
}

function insertVariable(token) {
  const textarea = el("tplBody");
  if (!textarea) return;
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const text = textarea.value;
  textarea.value = text.substring(0, start) + token + text.substring(end);
  textarea.selectionStart = textarea.selectionEnd = start + token.length;
  textarea.focus();
  updateLivePreview();
}

function updateLivePreview() {
  const channel = el("tplChannel").value;
  const bodyText = el("tplBody").value || "Type your message body to preview...";
  const previewHeader = el("previewHeader");
  const previewSubject = el("previewSubject");
  const previewBody = el("previewBody");
  const previewFooter = el("previewFooter");

  previewBody.innerHTML = highlightVariables(bodyText);

  if (channel === 'whatsapp') {
    previewSubject.style.display = "none";
    const headerVal = el("tplHeader").value.trim();
    const footerVal = el("tplFooter").value.trim();

    if (headerVal) {
      previewHeader.textContent = headerVal;
      previewHeader.style.display = "block";
    } else {
      previewHeader.style.display = "none";
    }

    if (footerVal) {
      previewFooter.textContent = footerVal;
      previewFooter.style.display = "block";
    } else {
      previewFooter.style.display = "none";
    }
  } else {
    previewHeader.style.display = "none";
    previewFooter.style.display = "none";
    const subjectVal = el("tplSubject").value.trim();

    if (subjectVal) {
      previewSubject.textContent = "Subject: " + subjectVal;
      previewSubject.style.display = "block";
    } else {
      previewSubject.style.display = "none";
    }
  }
}

// Form Submission
async function handleSaveTemplate(e) {
  e.preventDefault();
  const saveBtn = el("saveBtn");
  saveBtn.disabled = true;
  saveBtn.textContent = "Saving...";

  const templateId = el("editingTemplateId").value;
  const isEdit = !!templateId;
  const channel = el("tplChannel").value;
  const name = el("tplName").value.trim();
  const display_name = el("tplDisplayName").value.trim();

  // Extract variables
  const body = el("tplBody").value;
  const varMatches = body.match(/\{\{([^}]+)\}\}/g) || [];
  const variables = Array.from(new Set(varMatches.map(v => v.replace(/[{}]/g, '').trim())));

  const payload = {
    channel,
    name,
    display_name,
    variables
  };

  if (channel === 'whatsapp') {
    payload.category = el("tplCategory").value;
    payload.language = el("tplLanguage").value;
    payload.header = el("tplHeader").value.trim() || null;
    payload.body = body;
    payload.footer = el("tplFooter").value.trim() || null;
  } else {
    payload.subject = el("tplSubject").value.trim();
    payload.body_text = body;
  }

  try {
    const url = isEdit ? `/api/templates/${templateId}` : '/api/templates';
    const method = isEdit ? 'PUT' : 'POST';

    const res = await authFetch(url, {
      method,
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || "Failed to save template");
    }

    closeTemplateModal();
    await loadTemplates();
  } catch (err) {
    alert("Error saving template: " + err.message);
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = "Save Template";
  }
}

// Delete Template
async function deleteTemplate(id) {
  if (!confirm("Are you sure you want to delete this template?")) return;

  try {
    const res = await authFetch(`/api/templates/${id}`, {
      method: 'DELETE'
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || "Failed to delete template");
    }
    await loadTemplates();
  } catch (err) {
    alert("Error deleting template: " + err.message);
  }
}

// Init
document.addEventListener("DOMContentLoaded", () => {
  fetchUserProfile();
  loadTemplates();
});
