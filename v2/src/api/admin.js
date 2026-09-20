import { getDbClient } from "../db/client.js";

/**
 * Admin Analytics API & Failure Log Handlers
 * Collectr Personal CRM Admin Module
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

export async function handleGetAdminDashboard(c) {
  return c.redirect("/dashboard.html");
}

export async function handleGetAdminAnalyticsDashboard(c) {
  return c.redirect("/dashboard.html");
}

export async function handleGetAdminFailures(c) {
  return c.json({ success: true, failures: [] });
}

export async function handleDeleteAdminFailure(c) {
  return c.json({ success: true });
}

export async function handleClearAllFailures(c) {
  return c.json({ success: true });
}
