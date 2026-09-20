import { getDbClient } from "../db/client.js";

/**
 * Admin Analytics API & Observability Module
 * Collectrr Personal CRM
 */

export async function handleGetAdminAnalyticsData(c) {
  const db = getDbClient(c.env);
  const user = c.get("user");
  const requestedAgentId = c.req.query("agentId");

  try {
    let whereUserClause = "1=1";
    let userParams = [];

    if (user && user.role === "admin" && requestedAgentId && requestedAgentId !== "all") {
      whereUserClause = "user_id = ?";
      userParams = [requestedAgentId];
    } else if (user && user.role !== "admin") {
      whereUserClause = "user_id = ?";
      userParams = [user.id];
    }

    // Registered users list for filter
    let usersList = [];
    if (user && user.role === "admin") {
      const uRes = await db.execute("SELECT id, username, role, credit_balance FROM users ORDER BY username ASC");
      usersList = uRes.rows || [];
    }

    // 1. Contact Metrics
    const contactsRes = await db.execute({
      sql: `SELECT COUNT(*) as total_contacts FROM contacts WHERE ${whereUserClause}`,
      args: userParams,
    });
    const totalContacts = contactsRes.rows[0]?.total_contacts || 0;

    // 2. Message Telemetry Metrics
    const msgRes = await db.execute({
      sql: `SELECT 
              COUNT(*) as total_messages,
              SUM(CASE WHEN direction = 'outbound' THEN 1 ELSE 0 END) as outbound_count,
              SUM(CASE WHEN direction = 'inbound' THEN 1 ELSE 0 END) as inbound_count,
              SUM(CASE WHEN delivery_status = 'delivered' OR delivery_status = 'read' THEN 1 ELSE 0 END) as delivered_count,
              SUM(CASE WHEN delivery_status = 'read' THEN 1 ELSE 0 END) as read_count,
              SUM(CASE WHEN delivery_status = 'failed' THEN 1 ELSE 0 END) as failed_count
            FROM messages WHERE ${whereUserClause}`,
      args: userParams,
    });
    const msgStats = msgRes.rows[0] || {};

    // 3. Request Metrics
    const reqRes = await db.execute({
      sql: `SELECT status, COUNT(*) as count FROM requests WHERE ${whereUserClause} GROUP BY status`,
      args: userParams,
    });

    // 4. Schedules Metrics
    const schRes = await db.execute({
      sql: `SELECT status, COUNT(*) as count FROM schedules WHERE ${whereUserClause} GROUP BY status`,
      args: userParams,
    });

    // 5. Recent Activities
    const actRes = await db.execute({
      sql: `SELECT a.*, c.name as contact_name, c.phone_number as contact_phone, u.username
            FROM activities a
            JOIN contacts c ON c.id = a.contact_id
            JOIN users u ON u.id = a.user_id
            WHERE ${whereUserClause.replace(/user_id/g, "a.user_id")}
            ORDER BY a.created_at DESC LIMIT 30`,
      args: userParams,
    });

    return c.json({
      success: true,
      users: usersList,
      metrics: {
        totalContacts,
        totalMessages: msgStats.total_messages || 0,
        outboundMessages: msgStats.outbound_count || 0,
        inboundMessages: msgStats.inbound_count || 0,
        deliveredMessages: msgStats.delivered_count || 0,
        readMessages: msgStats.read_count || 0,
        failedMessages: msgStats.failed_count || 0,
        deliveryRate: msgStats.outbound_count > 0 ? ((msgStats.delivered_count / msgStats.outbound_count) * 100).toFixed(1) : 0,
        readRate: msgStats.delivered_count > 0 ? ((msgStats.read_count / msgStats.delivered_count) * 100).toFixed(1) : 0,
      },
      requestBreakdown: reqRes.rows || [],
      scheduleBreakdown: schRes.rows || [],
      recentActivities: actRes.rows || [],
    });
  } catch (err) {
    console.error("Admin Analytics error:", err);
    return c.json({ error: "Failed to compile analytics", details: err.message }, 500);
  }
}

export async function handleGetAdminFailures(c) {
  const db = getDbClient(c.env);
  const user = c.get("user");
  try {
    let whereUserClause = "1=1";
    let userParams = [];
    if (user && user.role !== "admin") {
      whereUserClause = "m.user_id = ?";
      userParams = [user.id];
    }

    const failedMsgs = await db.execute({
      sql: `SELECT m.id, m.created_at, m.channel, m.delivery_status as status, m.content as details,
                   c.name as contact_name, c.phone_number as contact_phone, c.email as contact_email,
                   u.username as agent_username, 'message_delivery' as error_type
            FROM messages m
            JOIN contacts c ON c.id = m.contact_id
            JOIN users u ON u.id = m.user_id
            WHERE m.delivery_status = 'failed' AND ${whereUserClause}
            ORDER BY m.created_at DESC LIMIT 50`,
      args: userParams,
    });

    const failedOccurrences = await db.execute({
      sql: `SELECT so.id, so.created_at, so.channel, so.operational_status as status, so.last_error as details,
                   c.name as contact_name, c.phone_number as contact_phone, c.email as contact_email,
                   u.username as agent_username, 'scheduled_dispatch' as error_type
            FROM scheduled_occurrences so
            JOIN schedules s ON s.id = so.schedule_id
            JOIN contacts c ON c.id = s.contact_id
            JOIN users u ON u.id = s.user_id
            WHERE so.operational_status = 'failed' AND ${whereUserClause.replace(/m\.user_id/g, "s.user_id")}
            ORDER BY so.created_at DESC LIMIT 50`,
      args: userParams,
    });

    const failures = [...(failedMsgs.rows || []), ...(failedOccurrences.rows || [])].sort(
      (a, b) => new Date(b.created_at) - new Date(a.created_at)
    );

    return c.json({ success: true, failures });
  } catch (err) {
    console.error("Admin Failures error:", err);
    return c.json({ success: true, failures: [] });
  }
}

export async function handleDeleteAdminFailure(c) {
  const failureId = c.req.param("id");
  const db = getDbClient(c.env);
  try {
    // Attempt to reset/dismiss in scheduled_occurrences or messages
    await db.execute({
      sql: `UPDATE scheduled_occurrences SET operational_status = 'skipped', skip_reason = 'dismissed_by_admin' WHERE id = ?`,
      args: [failureId],
    });
    return c.json({ success: true });
  } catch (err) {
    return c.json({ error: "Failed to dismiss failure", details: err.message }, 500);
  }
}

export async function handleClearAllFailures(c) {
  const db = getDbClient(c.env);
  try {
    await db.execute(
      `UPDATE scheduled_occurrences SET operational_status = 'skipped', skip_reason = 'cleared_by_admin' WHERE operational_status = 'failed'`
    );
    return c.json({ success: true });
  } catch (err) {
    return c.json({ error: "Failed to clear failures", details: err.message }, 500);
  }
}

export async function handleGetAdminAnalyticsDashboard(c) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Collectrr — Platform Analytics</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #FAFAF8;
      --surface: #FFFFFF;
      --border: #ECE8DF;
      --border-subtle: #F4F3EF;
      --text: #171717;
      --text-muted: #6E6A62;
      --accent: #171717;
      --radius: 12px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      padding: 24px;
    }
    .container {
      max-width: 1400px;
      margin: 0 auto;
    }
    .nav-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16px 24px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      margin-bottom: 24px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      text-decoration: none;
      color: var(--text);
    }
    .brand-icon {
      width: 32px;
      height: 32px;
      background: #171717;
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
      font-weight: 700;
      font-size: 15px;
    }
    .brand-title {
      font-size: 1.1rem;
      font-weight: 600;
      margin: 0;
    }
    .nav-links {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .nav-btn {
      padding: 6px 14px;
      font-size: 13px;
      font-weight: 500;
      border-radius: 8px;
      text-decoration: none;
      color: var(--text-muted);
      border: 1px solid transparent;
      transition: all 0.15s ease;
      background: transparent;
      cursor: pointer;
    }
    .nav-btn:hover {
      background: var(--border-subtle);
      color: var(--text);
    }
    .nav-btn.active {
      background: #171717;
      color: #ffffff;
    }
    .page-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
      flex-wrap: wrap;
      gap: 12px;
    }
    .page-title {
      font-size: 22px;
      font-weight: 700;
      color: var(--text);
    }
    .filter-select {
      padding: 8px 14px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--surface);
      font-size: 13px;
      font-weight: 500;
      color: var(--text);
      outline: none;
      cursor: pointer;
    }
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .metric-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 18px 20px;
      display: flex;
      flex-direction: column;
    }
    .metric-label {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .metric-val {
      font-size: 26px;
      font-weight: 700;
      color: var(--text);
      margin-top: 6px;
    }
    .metric-sub {
      font-size: 12px;
      color: var(--text-muted);
      margin-top: 4px;
    }
    .dashboard-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
      margin-bottom: 24px;
    }
    @media (max-width: 900px) {
      .dashboard-grid { grid-template-columns: 1fr; }
    }
    .panel {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 20px;
    }
    .panel-title {
      font-size: 15px;
      font-weight: 600;
      color: var(--text);
      margin-bottom: 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .bar-list {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .bar-item {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .bar-meta {
      display: flex;
      justify-content: space-between;
      font-size: 13px;
      font-weight: 500;
    }
    .bar-track {
      height: 8px;
      background: var(--border-subtle);
      border-radius: 999px;
      overflow: hidden;
      width: 100%;
    }
    .bar-fill {
      height: 100%;
      border-radius: 999px;
      background: #171717;
      transition: width 0.4s ease;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
      text-align: left;
    }
    th {
      padding: 10px 14px;
      font-weight: 600;
      color: var(--text-muted);
      border-bottom: 1px solid var(--border);
      background: #FAFAF8;
    }
    td {
      padding: 12px 14px;
      border-bottom: 1px solid var(--border-subtle);
      vertical-align: middle;
    }
    .badge {
      display: inline-block;
      padding: 3px 8px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 600;
      background: var(--border-subtle);
      color: var(--text);
    }
  </style>
</head>
<body>
  <div class="container">
    <nav class="nav-bar">
      <a href="/dashboard" class="brand">
        <div class="brand-icon">C</div>
        <div class="brand-text">
          <h2 class="brand-title">Collectrr</h2>
        </div>
      </a>
      <div class="nav-links">
        <a href="/dashboard" class="nav-btn">Dashboard</a>
        <a href="/admin/analytics" class="nav-btn active">Analytics</a>
        <a href="/observability" class="nav-btn">Observability</a>
        <button class="nav-btn" onclick="handleLogout()">Log out</button>
      </div>
    </nav>

    <div class="page-header">
      <h1 class="page-title">Platform Analytics</h1>
      <div style="display: flex; gap: 10px; align-items: center;">
        <select id="userFilterSelect" class="filter-select" onchange="loadAnalytics()">
          <option value="all">All Workspaces</option>
        </select>
        <button class="nav-btn" style="border: 1px solid var(--border); background: var(--surface);" onclick="loadAnalytics()">Refresh</button>
      </div>
    </div>

    <div class="metrics-grid">
      <div class="metric-card">
        <div class="metric-label">Total Contacts</div>
        <div class="metric-val" id="val-contacts">0</div>
        <div class="metric-sub">Active CRM directory</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Total Messages</div>
        <div class="metric-val" id="val-messages">0</div>
        <div class="metric-sub" id="val-messages-sub">0 outbound / 0 inbound</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Delivery Rate</div>
        <div class="metric-val" id="val-delivery">0%</div>
        <div class="metric-sub" id="val-delivery-sub">Delivered outreach</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Read Rate</div>
        <div class="metric-val" id="val-read">0%</div>
        <div class="metric-sub" id="val-read-sub">Client engagement</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Failed Outbound</div>
        <div class="metric-val" id="val-failed" style="color: #DC2626;">0</div>
        <div class="metric-sub">Requires triage</div>
      </div>
    </div>

    <div class="dashboard-grid">
      <div class="panel">
        <div class="panel-title">
          <span>Request Work State Breakdown</span>
        </div>
        <div class="bar-list" id="requests-bar-list">
          <p style="color: var(--text-muted); padding: 12px; text-align: center;">Loading requests breakdown...</p>
        </div>
      </div>

      <div class="panel">
        <div class="panel-title">
          <span>Automated Schedules Status</span>
        </div>
        <div class="bar-list" id="schedules-bar-list">
          <p style="color: var(--text-muted); padding: 12px; text-align: center;">Loading schedules breakdown...</p>
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-title">
        <span>Recent CRM Activity Stream</span>
      </div>
      <div style="overflow-x: auto;">
        <table>
          <thead>
            <tr>
              <th style="width: 18%">Timestamp</th>
              <th style="width: 15%">Workspace</th>
              <th style="width: 20%">Contact</th>
              <th style="width: 17%">Event Type</th>
              <th style="width: 30%">Details</th>
            </tr>
          </thead>
          <tbody id="activity-stream-body">
            <tr><td colspan="5" style="text-align: center; padding: 24px; color: var(--text-muted);">Loading activity stream...</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <script>
    let usersLoaded = false;

    function handleLogout() {
      localStorage.removeItem("collectrr_auth");
      window.location.href = "/login.html";
    }

    async function loadAnalytics() {
      const token = localStorage.getItem("collectrr_auth");
      if (!token) {
        window.location.href = "/login.html?redirect=" + encodeURIComponent(window.location.pathname);
        return;
      }

      const userSel = document.getElementById("userFilterSelect");
      const selectedUserId = userSel ? userSel.value : "all";

      try {
        const res = await fetch("/api/admin/analytics?agentId=" + encodeURIComponent(selectedUserId), {
          headers: { "Authorization": token }
        });

        if (res.status === 401) {
          localStorage.removeItem("collectrr_auth");
          window.location.href = "/login.html?redirect=" + encodeURIComponent(window.location.pathname);
          return;
        }

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to load analytics");

        if (data.users && data.users.length > 0 && !usersLoaded && userSel) {
          usersLoaded = true;
          userSel.innerHTML = '<option value="all">All Workspaces</option>';
          data.users.forEach(u => {
            const opt = document.createElement("option");
            opt.value = u.id;
            opt.textContent = (u.username || u.id) + ' (' + (u.role || 'user') + ')';
            userSel.appendChild(opt);
          });
        }

        const m = data.metrics || {};
        document.getElementById("val-contacts").textContent = m.totalContacts || 0;
        document.getElementById("val-messages").textContent = m.totalMessages || 0;
        document.getElementById("val-messages-sub").textContent = (m.outboundMessages || 0) + " outbound / " + (m.inboundMessages || 0) + " inbound";
        document.getElementById("val-delivery").textContent = (m.deliveryRate || 0) + "%";
        document.getElementById("val-delivery-sub").textContent = (m.deliveredMessages || 0) + " delivered";
        document.getElementById("val-read").textContent = (m.readRate || 0) + "%";
        document.getElementById("val-read-sub").textContent = (m.readMessages || 0) + " read by client";
        document.getElementById("val-failed").textContent = m.failedMessages || 0;

        renderBreakdown("requests-bar-list", data.requestBreakdown || []);
        renderBreakdown("schedules-bar-list", data.scheduleBreakdown || []);
        renderActivityStream(data.recentActivities || []);
      } catch (err) {
        console.error("Analytics load error:", err);
      }
    }

    function renderBreakdown(containerId, list) {
      const container = document.getElementById(containerId);
      if (!container) return;
      if (!list || list.length === 0) {
        container.innerHTML = '<p style="color: var(--text-muted); padding: 12px; text-align: center;">No records recorded</p>';
        return;
      }
      const total = list.reduce((sum, item) => sum + (item.count || 0), 0);
      container.innerHTML = list.map(item => {
        const pct = total > 0 ? ((item.count / total) * 100).toFixed(0) : 0;
        const label = (item.status || 'unknown').replace(/_/g, ' ');
        return \`
          <div class="bar-item">
            <div class="bar-meta">
              <span style="text-transform: capitalize;">\${label}</span>
              <span style="color: var(--text-muted); font-weight: 600;">\${item.count} (\${pct}%)</span>
            </div>
            <div class="bar-track">
              <div class="bar-fill" style="width: \${pct}%;"></div>
            </div>
          </div>
        \`;
      }).join("");
    }

    function renderActivityStream(activities) {
      const tbody = document.getElementById("activity-stream-body");
      if (!tbody) return;
      if (!activities || activities.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 24px; color: var(--text-muted);">No recent activities.</td></tr>';
        return;
      }
      tbody.innerHTML = activities.map(a => {
        const date = new Date(a.created_at).toLocaleString();
        const contactInfo = a.contact_name ? \`<strong>\${escapeHtml(a.contact_name)}</strong><br><small style="color:var(--text-muted);">\${escapeHtml(a.contact_phone || '')}</small>\` : '—';
        return \`
          <tr>
            <td style="color: var(--text-muted);">\${date}</td>
            <td>\${escapeHtml(a.username || 'System')}</td>
            <td>\${contactInfo}</td>
            <td><span class="badge">\${escapeHtml(a.activity_type || 'activity')}</span></td>
            <td><strong>\${escapeHtml(a.title || '')}</strong>\${a.description ? ' — ' + escapeHtml(a.description) : ''}</td>
          </tr>
        \`;
      }).join("");
    }

    function escapeHtml(str) {
      return (str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    window.onload = loadAnalytics;
  </script>
</body>
</html>`;
  return c.html(html);
}

export async function handleGetAdminDashboard(c) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Collectrr — System Observability & Failures</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #FAFAF8;
      --surface: #FFFFFF;
      --border: #ECE8DF;
      --border-subtle: #F4F3EF;
      --text: #171717;
      --text-muted: #6E6A62;
      --accent: #171717;
      --radius: 12px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      padding: 24px;
    }
    .container {
      max-width: 1400px;
      margin: 0 auto;
    }
    .nav-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16px 24px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      margin-bottom: 24px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      text-decoration: none;
      color: var(--text);
    }
    .brand-icon {
      width: 32px;
      height: 32px;
      background: #171717;
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
      font-weight: 700;
      font-size: 15px;
    }
    .brand-title {
      font-size: 1.1rem;
      font-weight: 600;
      margin: 0;
    }
    .nav-links {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .nav-btn {
      padding: 6px 14px;
      font-size: 13px;
      font-weight: 500;
      border-radius: 8px;
      text-decoration: none;
      color: var(--text-muted);
      border: 1px solid transparent;
      transition: all 0.15s ease;
      background: transparent;
      cursor: pointer;
    }
    .nav-btn:hover {
      background: var(--border-subtle);
      color: var(--text);
    }
    .nav-btn.active {
      background: #171717;
      color: #ffffff;
    }
    .page-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
      flex-wrap: wrap;
      gap: 12px;
    }
    .page-title {
      font-size: 22px;
      font-weight: 700;
      color: var(--text);
    }
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .metric-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 18px 20px;
      display: flex;
      flex-direction: column;
    }
    .metric-label {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .metric-val {
      font-size: 26px;
      font-weight: 700;
      color: var(--text);
      margin-top: 6px;
    }
    .panel {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 20px;
    }
    .panel-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
    }
    .panel-title {
      font-size: 15px;
      font-weight: 600;
      color: var(--text);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
      text-align: left;
    }
    th {
      padding: 10px 14px;
      font-weight: 600;
      color: var(--text-muted);
      border-bottom: 1px solid var(--border);
      background: #FAFAF8;
    }
    td {
      padding: 12px 14px;
      border-bottom: 1px solid var(--border-subtle);
      vertical-align: top;
    }
    .badge-error {
      display: inline-block;
      padding: 3px 8px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 600;
      background: #FEE2E2;
      color: #DC2626;
    }
    .btn-action {
      padding: 4px 10px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      border: 1px solid var(--border);
      background: var(--surface);
    }
    .btn-action:hover {
      background: var(--border-subtle);
    }
    .code-box {
      font-family: monospace;
      font-size: 12px;
      background: #F4F3EF;
      padding: 8px 10px;
      border-radius: 6px;
      max-height: 120px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-word;
    }
  </style>
</head>
<body>
  <div class="container">
    <nav class="nav-bar">
      <a href="/dashboard" class="brand">
        <div class="brand-icon">C</div>
        <div class="brand-text">
          <h2 class="brand-title">Collectrr</h2>
        </div>
      </a>
      <div class="nav-links">
        <a href="/dashboard" class="nav-btn">Dashboard</a>
        <a href="/admin/analytics" class="nav-btn">Analytics</a>
        <a href="/observability" class="nav-btn active">Observability</a>
        <button class="nav-btn" onclick="handleLogout()">Log out</button>
      </div>
    </nav>

    <div class="page-header">
      <h1 class="page-title">System Observability & Failure Telemetry</h1>
      <div style="display: flex; gap: 10px;">
        <button class="nav-btn" style="border: 1px solid var(--border); background: var(--surface);" onclick="loadFailures()">Refresh</button>
        <button class="nav-btn" style="border: 1px solid #FCA5A5; background: #FEF2F2; color: #DC2626;" onclick="clearAll()">Clear All</button>
      </div>
    </div>

    <div class="metrics-grid">
      <div class="metric-card">
        <div class="metric-label">Total Recorded Issues</div>
        <div class="metric-val" id="count-total">0</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Message Delivery Failures</div>
        <div class="metric-val" id="count-delivery" style="color: #DC2626;">0</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Scheduled Dispatch Failures</div>
        <div class="metric-val" id="count-dispatch" style="color: #EA580C;">0</div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-header">
        <div class="panel-title">Active Failures & Anomaly Logs</div>
        <span id="log-status" style="font-size: 12px; color: var(--text-muted);">Updated just now</span>
      </div>
      <div style="overflow-x: auto;">
        <table>
          <thead>
            <tr>
              <th style="width: 16%">Timestamp</th>
              <th style="width: 14%">Category</th>
              <th style="width: 14%">Channel</th>
              <th style="width: 20%">Contact</th>
              <th style="width: 26%">Details</th>
              <th style="width: 10%; text-align: right;">Action</th>
            </tr>
          </thead>
          <tbody id="logs-body">
            <tr><td colspan="6" style="text-align: center; padding: 24px; color: var(--text-muted);">Loading logs...</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <script>
    function handleLogout() {
      localStorage.removeItem("collectrr_auth");
      window.location.href = "/login.html";
    }

    async function loadFailures() {
      const token = localStorage.getItem("collectrr_auth");
      if (!token) {
        window.location.href = "/login.html?redirect=" + encodeURIComponent(window.location.pathname);
        return;
      }
      document.getElementById("log-status").textContent = "Refreshing...";
      try {
        const res = await fetch("/api/admin/failures", {
          headers: { "Authorization": token }
        });
        if (res.status === 401) {
          localStorage.removeItem("collectrr_auth");
          window.location.href = "/login.html?redirect=" + encodeURIComponent(window.location.pathname);
          return;
        }
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to load failure logs");
        renderLogs(data.failures || []);
      } catch (err) {
        console.error("Failed to load failures:", err);
      }
    }

    function renderLogs(failures) {
      document.getElementById("count-total").textContent = failures.length;
      document.getElementById("count-delivery").textContent = failures.filter(f => f.error_type === "message_delivery").length;
      document.getElementById("count-dispatch").textContent = failures.filter(f => f.error_type === "scheduled_dispatch").length;
      
      const body = document.getElementById("logs-body");
      if (failures.length === 0) {
        body.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 28px; color: var(--text-muted);">No system failures recorded. Systems healthy.</td></tr>';
        document.getElementById("log-status").textContent = "All systems operational";
        return;
      }

      body.innerHTML = failures.map(f => {
        const contact = f.contact_name ? \`<strong>\${escapeHtml(f.contact_name)}</strong><br><small style="color:var(--text-muted);">\${escapeHtml(f.contact_phone || f.contact_email || '')}</small>\` : '<em>System</em>';
        return \`
          <tr>
            <td style="color: var(--text-muted);">\${new Date(f.created_at).toLocaleString()}</td>
            <td><span class="badge-error">\${escapeHtml(f.error_type || 'error')}</span></td>
            <td>\${escapeHtml(f.channel || 'whatsapp')}</td>
            <td>\${contact}</td>
            <td><div class="code-box">\${escapeHtml(f.details || 'No error details recorded')}</div></td>
            <td style="text-align: right;">
              <button class="btn-action" onclick="deleteFailure('\${f.id}')">Dismiss</button>
            </td>
          </tr>
        \`;
      }).join("");

      document.getElementById("log-status").textContent = "Last updated: " + new Date().toLocaleTimeString();
    }

    async function deleteFailure(id) {
      const token = localStorage.getItem("collectrr_auth");
      await fetch('/api/admin/failures/' + encodeURIComponent(id), {
        method: "DELETE",
        headers: { "Authorization": token || "" }
      });
      loadFailures();
    }

    async function clearAll() {
      if (!confirm("Dismiss all failure logs?")) return;
      const token = localStorage.getItem("collectrr_auth");
      await fetch("/api/admin/failures", {
        method: "DELETE",
        headers: { "Authorization": token || "" }
      });
      loadFailures();
    }

    function escapeHtml(str) {
      return (str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    window.onload = loadFailures;
  </script>
</body>
</html>`;
  return c.html(html);
}

