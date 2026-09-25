import { getDbClient } from "../db/client.js";
import { localToUtc, utcToLocalParts } from "../scheduler/time.js";
import { WHATSAPP_TEMPLATES } from "../whatsapp/templates.js";
import { SYSTEM_EMAIL_TEMPLATES } from "./templates.js";

/**
 * Normalizes audience filter criteria
 */
function normalizeAudienceFilter(filter = {}) {
  return {
    delivery_status: filter.delivery_status || filter.deliveryStatus || null,
    action_status: filter.action_status || filter.actionStatus || null,
    search: (filter.search || "").trim().toLowerCase(),
    contact_ids: Array.isArray(filter.contact_ids) ? filter.contact_ids : null
  };
}

/**
 * Evaluates audience filter to resolve matching contacts for a user
 */
async function resolveMatchingContacts(db, userId, filter = {}) {
  const norm = normalizeAudienceFilter(filter);
  let sql = `
    SELECT 
      c.id, c.user_id, COALESCE(c.name, c.contact_person) as name, c.phone_number, c.email, c.company, c.notes,
      c.last_outbound_at, c.last_inbound_at, c.created_at
    FROM contacts c
    WHERE c.user_id = ?
  `;
  const args = [userId];

  if (norm.contact_ids && norm.contact_ids.length > 0) {
    const placeholders = norm.contact_ids.map(() => "?").join(", ");
    sql += ` AND c.id IN (${placeholders})`;
    args.push(...norm.contact_ids);
  }

  if (norm.search) {
    sql += ` AND (LOWER(COALESCE(c.name, c.contact_person, '')) LIKE ? OR c.phone_number LIKE ? OR LOWER(COALESCE(c.email, '')) LIKE ?)`;
    const sTerm = `%${norm.search}%`;
    args.push(sTerm, sTerm, sTerm);
  }

  sql += ` ORDER BY c.created_at DESC`;

  const res = await db.execute({ sql, args });
  const rows = res?.rows || [];

  // Post-filter by status if requested
  if (norm.delivery_status) {
    const targetStatus = norm.delivery_status.toLowerCase();
    return rows.filter(r => {
      // If contact has no outbound, it's not_contacted
      if (targetStatus === "not_contacted" && !r.last_outbound_at) return true;
      if (targetStatus === "replied" && r.last_inbound_at) return true;
      return false;
    });
  }

  return rows;
}

/**
 * GET /api/campaigns
 * List all campaigns for the authenticated tenant with derived metrics.
 */
export async function handleGetCampaigns(c) {
  const db = getDbClient(c.env);
  const user = c.get("user");
  const userId = user?.id || user?.user_id || user?.sub;

  try {
    const res = await db.execute({
      sql: `SELECT * FROM campaigns WHERE user_id = ? ORDER BY created_at DESC`,
      args: [userId]
    });

    const campaigns = res?.rows || [];
    const results = [];

    for (const cmp of campaigns) {
      let channels = [];
      try {
        channels = typeof cmp.channels === "string" ? JSON.parse(cmp.channels) : (cmp.channels || []);
      } catch (_) {}

      // Calculate derived metrics from campaign_recipients
      const statsRes = await db.execute({
        sql: `
          SELECT 
            channel,
            COUNT(*) as total,
            SUM(CASE WHEN delivery_status IN ('sent', 'delivered', 'read') THEN 1 ELSE 0 END) as sent,
            SUM(CASE WHEN delivery_status IN ('delivered', 'read') THEN 1 ELSE 0 END) as delivered,
            SUM(CASE WHEN delivery_status = 'read' THEN 1 ELSE 0 END) as read,
            SUM(CASE WHEN response_status = 'replied' THEN 1 ELSE 0 END) as replied,
            SUM(CASE WHEN delivery_status = 'failed' THEN 1 ELSE 0 END) as failed,
            SUM(CASE WHEN delivery_status = 'cancelled' THEN 1 ELSE 0 END) as cancelled,
            SUM(CASE WHEN delivery_status IN ('pending', 'queued', 'sending') THEN 1 ELSE 0 END) as pending
          FROM campaign_recipients
          WHERE campaign_id = ?
          GROUP BY channel
        `,
        args: [cmp.id]
      });

      const metricsByChannel = {};
      for (const row of statsRes?.rows || []) {
        metricsByChannel[row.channel] = {
          total: row.total || 0,
          sent: row.sent || 0,
          delivered: row.delivered || 0,
          read: row.read || 0,
          replied: row.replied || 0,
          failed: row.failed || 0,
          cancelled: row.cancelled || 0,
          pending: row.pending || 0
        };
      }

      // Check if running campaign reached execution completion
      if (cmp.status === "running") {
        const totalPending = Object.values(metricsByChannel).reduce((acc, m) => acc + (m.pending || 0), 0);
        if (totalPending === 0 && cmp.total_recipients_snapshot > 0) {
          await db.execute({
            sql: `UPDATE campaigns SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'running'`,
            args: [cmp.id]
          });
          cmp.status = "completed";
        }
      }

      results.push({
        id: cmp.id,
        name: cmp.name,
        channels: channels,
        status: cmp.status,
        timezone: cmp.timezone,
        scheduled_for: cmp.scheduled_for,
        local_scheduled_time: cmp.local_scheduled_time,
        total_recipients: cmp.total_recipients_snapshot || 0,
        metrics: metricsByChannel,
        created_at: cmp.created_at,
        launched_at: cmp.launched_at,
        completed_at: cmp.completed_at
      });
    }

    return c.json({ success: true, campaigns: results });
  } catch (err) {
    console.error("Error listing campaigns:", err);
    return c.json({ success: false, error: err.message || "Failed to list campaigns" }, 500);
  }
}

/**
 * GET /api/campaigns/:id
 * Get campaign detail, message snapshots, and derived metrics.
 */
export async function handleGetCampaignDetail(c) {
  const db = getDbClient(c.env);
  const user = c.get("user");
  const userId = user?.id || user?.user_id || user?.sub;
  const campaignId = c.req.param("id");

  try {
    const res = await db.execute({
      sql: `SELECT * FROM campaigns WHERE id = ?`,
      args: [campaignId]
    });

    if (!res?.rows?.length) {
      return c.json({ success: false, error: "Campaign not found" }, 404);
    }

    const cmp = res.rows[0];
    if (cmp.user_id !== userId && user.role !== "admin") {
      return c.json({ success: false, error: "Unauthorized" }, 403);
    }
    let channels = [];
    try {
      channels = typeof cmp.channels === "string" ? JSON.parse(cmp.channels) : (cmp.channels || []);
    } catch (_) {}

    // Fetch message snapshots
    const msgRes = await db.execute({
      sql: `SELECT * FROM campaign_messages WHERE campaign_id = ?`,
      args: [campaignId]
    });

    const messages = (msgRes?.rows || []).map(m => {
      let buttons = [];
      let mappings = {};
      try { buttons = typeof m.buttons_snapshot === "string" ? JSON.parse(m.buttons_snapshot) : (m.buttons_snapshot || []); } catch (_) {}
      try { mappings = typeof m.param_mappings_snapshot === "string" ? JSON.parse(m.param_mappings_snapshot) : (m.param_mappings_snapshot || {}); } catch (_) {}
      return {
        id: m.id,
        channel: m.channel,
        template_id: m.template_id,
        template_name: m.template_name_snapshot,
        template_version: m.template_version_snapshot,
        subject: m.subject_snapshot,
        body: m.body_snapshot,
        header: m.header_snapshot,
        footer: m.footer_snapshot,
        buttons: buttons,
        param_mappings: mappings
      };
    });

    // Calculate derived metrics
    const statsRes = await db.execute({
      sql: `
        SELECT 
          channel,
          COUNT(*) as total,
          SUM(CASE WHEN delivery_status IN ('sent', 'delivered', 'read') THEN 1 ELSE 0 END) as sent,
          SUM(CASE WHEN delivery_status IN ('delivered', 'read') THEN 1 ELSE 0 END) as delivered,
          SUM(CASE WHEN delivery_status = 'read' THEN 1 ELSE 0 END) as read,
          SUM(CASE WHEN response_status = 'replied' THEN 1 ELSE 0 END) as replied,
          SUM(CASE WHEN delivery_status = 'failed' THEN 1 ELSE 0 END) as failed,
          SUM(CASE WHEN delivery_status = 'cancelled' THEN 1 ELSE 0 END) as cancelled,
          SUM(CASE WHEN delivery_status IN ('pending', 'queued', 'sending') THEN 1 ELSE 0 END) as pending
        FROM campaign_recipients
        WHERE campaign_id = ?
        GROUP BY channel
      `,
      args: [campaignId]
    });

    const metricsByChannel = {};
    for (const row of statsRes?.rows || []) {
      metricsByChannel[row.channel] = {
        total: row.total || 0,
        sent: row.sent || 0,
        delivered: row.delivered || 0,
        read: row.read || 0,
        replied: row.replied || 0,
        failed: row.failed || 0,
        cancelled: row.cancelled || 0,
        pending: row.pending || 0
      };
    }

    return c.json({
      success: true,
      campaign: {
        id: cmp.id,
        name: cmp.name,
        channels: channels,
        status: cmp.status,
        timezone: cmp.timezone,
        scheduled_for: cmp.scheduled_for,
        local_scheduled_time: cmp.local_scheduled_time,
        total_recipients: cmp.total_recipients_snapshot || 0,
        messages: messages,
        metrics: metricsByChannel,
        created_at: cmp.created_at,
        launched_at: cmp.launched_at,
        completed_at: cmp.completed_at
      }
    });
  } catch (err) {
    console.error("Error getting campaign detail:", err);
    return c.json({ success: false, error: err.message || "Failed to get campaign" }, 500);
  }
}

/**
 * GET /api/campaigns/:id/recipients
 * Paginated list of recipient execution records.
 */
export async function handleGetCampaignRecipients(c) {
  const db = getDbClient(c.env);
  const user = c.get("user");
  const userId = user?.id || user?.user_id || user?.sub;
  const campaignId = c.req.param("id");

  const limit = Math.min(Number(c.req.query("limit")) || 50, 200);
  const offset = Number(c.req.query("offset")) || 0;
  const deliveryStatus = c.req.query("delivery_status");
  const responseStatus = c.req.query("response_status");

  try {
    // Check tenant ownership
    const cmpCheck = await db.execute({
      sql: `SELECT id, user_id FROM campaigns WHERE id = ?`,
      args: [campaignId]
    });
    if (!cmpCheck?.rows?.length) {
      return c.json({ success: false, error: "Campaign not found" }, 404);
    }
    if (cmpCheck.rows[0].user_id !== userId && user.role !== "admin") {
      return c.json({ success: false, error: "Unauthorized" }, 403);
    }

    let sql = `SELECT * FROM campaign_recipients WHERE campaign_id = ?`;
    const args = [campaignId];

    if (deliveryStatus) {
      sql += ` AND delivery_status = ?`;
      args.push(deliveryStatus);
    }
    if (responseStatus) {
      sql += ` AND response_status = ?`;
      args.push(responseStatus);
    }

    sql += ` ORDER BY created_at ASC LIMIT ? OFFSET ?`;
    args.push(limit, offset);

    const res = await db.execute({ sql, args });
    const countRes = await db.execute({
      sql: `SELECT COUNT(*) as total FROM campaign_recipients WHERE campaign_id = ?`,
      args: [campaignId]
    });

    return c.json({
      success: true,
      total: countRes?.rows?.[0]?.total || 0,
      limit,
      offset,
      recipients: res?.rows || []
    });
  } catch (err) {
    console.error("Error getting recipients:", err);
    return c.json({ success: false, error: err.message || "Failed to get recipients" }, 500);
  }
}

/**
 * POST /api/campaigns
 * Creates a new campaign in 'draft' state.
 */
export async function handleCreateCampaign(c) {
  const db = getDbClient(c.env);
  const user = c.get("user");
  const userId = user?.id || user?.user_id || user?.sub;

  const body = await c.req.json().catch(() => ({}));
  const name = String(body.name || "").trim();
  const channels = Array.isArray(body.channels) ? body.channels : (body.channel ? [body.channel] : ["whatsapp"]);
  const timezone = String(body.timezone || "Asia/Kolkata").trim();
  const targetFilter = body.target_filter || body.targetFilter || {};

  if (!name) {
    return c.json({ success: false, error: "Campaign name is required" }, 400);
  }

  const validChannels = channels.filter(ch => ["whatsapp", "email"].includes(String(ch).toLowerCase()));
  if (validChannels.length === 0) {
    return c.json({ success: false, error: "At least one valid channel ('whatsapp' or 'email') is required" }, 400);
  }

  const campaignId = `cmp_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;

  try {
    await db.execute({
      sql: `INSERT INTO campaigns (id, user_id, name, channels, status, target_filter_audit, timezone)
            VALUES (?, ?, ?, ?, 'draft', ?, ?)`,
      args: [
        campaignId,
        userId,
        name,
        JSON.stringify(validChannels),
        JSON.stringify(targetFilter),
        timezone
      ]
    });

    return c.json({
      success: true,
      message: "Campaign draft created",
      campaign: {
        id: campaignId,
        name: name,
        channels: validChannels,
        status: "draft",
        timezone: timezone
      }
    }, 201);
  } catch (err) {
    console.error("Error creating campaign draft:", err);
    return c.json({ success: false, error: err.message || "Failed to create campaign draft" }, 500);
  }
}

/**
 * POST /api/campaigns/:id/messages
 * Configures and locks template/message snapshots for a channel.
 */
export async function handleSetCampaignMessages(c) {
  const db = getDbClient(c.env);
  const user = c.get("user");
  const userId = user?.id || user?.user_id || user?.sub;
  const campaignId = c.req.param("id");

  const body = await c.req.json().catch(() => ({}));
  const channel = String(body.channel || "").trim().toLowerCase();
  const templateId = body.template_id || body.templateId;
  const customBody = body.body || body.body_text;
  const customSubject = body.subject;

  if (!["whatsapp", "email"].includes(channel)) {
    return c.json({ success: false, error: "Channel must be 'whatsapp' or 'email'" }, 400);
  }

  try {
    // 1. Verify campaign ownership & draft state
    const cmpRes = await db.execute({
      sql: `SELECT id, user_id, status, channels FROM campaigns WHERE id = ?`,
      args: [campaignId]
    });

    if (!cmpRes?.rows?.length) return c.json({ success: false, error: "Campaign not found" }, 404);
    const cmp = cmpRes.rows[0];
    if (cmp.user_id !== userId) return c.json({ success: false, error: "Unauthorized" }, 403);
    if (cmp.status !== "draft") return c.json({ success: false, error: "Can only configure messages for draft campaigns" }, 400);

    let templateNameSnapshot = "custom_message";
    let versionSnapshot = 1;
    let bodySnapshot = "";
    let subjectSnapshot = null;
    let headerSnapshot = null;
    let footerSnapshot = null;
    let buttonsSnapshot = [];
    let paramMappingsSnapshot = body.param_mappings || {};

    if (templateId) {
      // Resolve from templates table (tenant or system)
      const tplRes = await db.execute({
        sql: `
          SELECT t.*, wa.meta_template_name, wa.header_text, wa.body_text as wa_body, wa.footer_text, wa.buttons, wa.param_mappings as wa_mappings,
                 em.subject as em_subject, em.body_text as em_body, em.param_mappings as em_mappings
          FROM templates t
          LEFT JOIN whatsapp_template_configs wa ON t.id = wa.template_id
          LEFT JOIN email_template_configs em ON t.id = em.template_id
          WHERE t.id = ? AND (t.user_id = ? OR t.scope = 'system')
        `,
        args: [templateId, userId]
      });

      if (tplRes?.rows?.length > 0) {
        const t = tplRes.rows[0];
        templateNameSnapshot = t.name;
        versionSnapshot = t.version || 1;
        if (channel === "whatsapp") {
          bodySnapshot = t.wa_body || "";
          headerSnapshot = t.header_text || null;
          footerSnapshot = t.footer_text || null;
          try { buttonsSnapshot = typeof t.buttons === "string" ? JSON.parse(t.buttons) : (t.buttons || []); } catch (_) {}
          try { paramMappingsSnapshot = typeof t.wa_mappings === "string" ? JSON.parse(t.wa_mappings) : (t.wa_mappings || {}); } catch (_) {}
        } else {
          subjectSnapshot = t.em_subject || "Message from Springboard";
          bodySnapshot = t.em_body || "";
          try { paramMappingsSnapshot = typeof t.em_mappings === "string" ? JSON.parse(t.em_mappings) : (t.em_mappings || {}); } catch (_) {}
        }
      } else {
        // Check built-in system templates
        if (channel === "whatsapp" && WHATSAPP_TEMPLATES[templateId]) {
          const sys = WHATSAPP_TEMPLATES[templateId];
          templateNameSnapshot = sys.name;
          bodySnapshot = sys.body_text || sys.body?.text || "";
          footerSnapshot = "Springboard Verification Portal";
          if (sys.button) buttonsSnapshot = [{ type: "URL", text: sys.button.text, url: "" }];
        } else {
          const sysEm = SYSTEM_EMAIL_TEMPLATES.find(t => t.id === templateId || t.name === templateId);
          if (sysEm) {
            templateNameSnapshot = sysEm.name;
            subjectSnapshot = sysEm.subject;
            bodySnapshot = sysEm.body_text;
          } else {
            return c.json({ success: false, error: "Referenced template not found or unauthorized" }, 404);
          }
        }
      }
    } else {
      bodySnapshot = String(customBody || "").trim();
      subjectSnapshot = String(customSubject || "Message from Springboard").trim();
    }

    if (!bodySnapshot) {
      return c.json({ success: false, error: "Message body cannot be empty" }, 400);
    }

    const messageId = `cmsg_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;

    // Upsert campaign_messages
    await db.execute({
      sql: `
        INSERT INTO campaign_messages (
          id, campaign_id, channel, template_id, template_version_snapshot, template_name_snapshot,
          subject_snapshot, body_snapshot, header_snapshot, footer_snapshot, buttons_snapshot, param_mappings_snapshot
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(campaign_id, channel) DO UPDATE SET
          template_id = excluded.template_id,
          template_version_snapshot = excluded.template_version_snapshot,
          template_name_snapshot = excluded.template_name_snapshot,
          subject_snapshot = excluded.subject_snapshot,
          body_snapshot = excluded.body_snapshot,
          header_snapshot = excluded.header_snapshot,
          footer_snapshot = excluded.footer_snapshot,
          buttons_snapshot = excluded.buttons_snapshot,
          param_mappings_snapshot = excluded.param_mappings_snapshot
      `,
      args: [
        messageId,
        campaignId,
        channel,
        templateId || null,
        versionSnapshot,
        templateNameSnapshot,
        subjectSnapshot,
        bodySnapshot,
        headerSnapshot,
        footerSnapshot,
        JSON.stringify(buttonsSnapshot),
        JSON.stringify(paramMappingsSnapshot)
      ]
    });

    return c.json({
      success: true,
      message: `Message snapshot for ${channel} configured successfully`
    });

  } catch (err) {
    console.error("Error setting campaign message:", err);
    return c.json({ success: false, error: err.message || "Failed to set campaign message" }, 500);
  }
}

/**
 * POST /api/campaigns/:id/audience/preview
 * Evaluates audience filter and returns preview list & count.
 */
export async function handlePreviewCampaignAudience(c) {
  const db = getDbClient(c.env);
  const user = c.get("user");
  const userId = user?.id || user?.user_id || user?.sub;
  const campaignId = c.req.param("id");

  const body = await c.req.json().catch(() => ({}));
  const filter = body.target_filter || body.targetFilter || {};

  try {
    const cmpRes = await db.execute({
      sql: `SELECT id, user_id FROM campaigns WHERE id = ?`,
      args: [campaignId]
    });
    if (!cmpRes?.rows?.length) return c.json({ success: false, error: "Campaign not found" }, 404);
    if (cmpRes.rows[0].user_id !== userId) return c.json({ success: false, error: "Unauthorized" }, 403);

    const matchingContacts = await resolveMatchingContacts(db, userId, filter);

    return c.json({
      success: true,
      total_count: matchingContacts.length,
      sample_recipients: matchingContacts.slice(0, 50).map(cnt => ({
        id: cnt.id,
        name: cnt.name || "Contact",
        phone: cnt.phone_number,
        email: cnt.email,
        company: cnt.company
      }))
    });
  } catch (err) {
    console.error("Error previewing audience:", err);
    return c.json({ success: false, error: err.message || "Failed to preview audience" }, 500);
  }
}

/**
 * Helper to snapshot recipients atomically into campaign_recipients
 */
async function snapshotCampaignRecipients(db, campaignId, userId, channels, contacts) {
  let recipientCount = 0;
  for (const contact of contacts) {
    for (const ch of channels) {
      const recpId = `crecp_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
      await db.execute({
        sql: `
          INSERT INTO campaign_recipients (
            id, campaign_id, user_id, contact_id, channel,
            recipient_name_snapshot, phone_snapshot, email_snapshot, company_snapshot, custom_vars_snapshot,
            delivery_status, response_status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'no_reply')
          ON CONFLICT(campaign_id, id, channel) DO NOTHING
        `,
        args: [
          recpId,
          campaignId,
          userId,
          contact.id || null,
          ch,
          contact.name || "Target",
          contact.phone_number || null,
          contact.email || null,
          contact.company || null,
          JSON.stringify({ notes: contact.notes || "" })
        ]
      });
      recipientCount++;
    }
  }
  return recipientCount;
}

/**
 * POST /api/campaigns/:id/launch
 * Atomically commits destination snapshots, marks running, and enqueues dispatch.
 */
export async function handleLaunchCampaign(c) {
  const db = getDbClient(c.env);
  const user = c.get("user");
  const userId = user?.id || user?.user_id || user?.sub;
  const campaignId = c.req.param("id");

  const body = await c.req.json().catch(() => ({}));
  const filter = body.target_filter || body.targetFilter || {};

  try {
    const cmpRes = await db.execute({
      sql: `SELECT * FROM campaigns WHERE id = ?`,
      args: [campaignId]
    });
    if (!cmpRes?.rows?.length) return c.json({ success: false, error: "Campaign not found" }, 404);
    const cmp = cmpRes.rows[0];
    if (cmp.user_id !== userId) return c.json({ success: false, error: "Unauthorized" }, 403);
    if (cmp.status !== "draft") return c.json({ success: false, error: `Cannot launch campaign in '${cmp.status}' status` }, 400);

    let channels = [];
    try { channels = typeof cmp.channels === "string" ? JSON.parse(cmp.channels) : (cmp.channels || []); } catch (_) {}

    // Verify messages configured for each channel
    const msgRes = await db.execute({
      sql: `SELECT channel FROM campaign_messages WHERE campaign_id = ?`,
      args: [campaignId]
    });
    const configuredChannels = (msgRes?.rows || []).map(r => r.channel);
    for (const ch of channels) {
      if (!configuredChannels.includes(ch)) {
        return c.json({ success: false, error: `Missing message configuration for channel: ${ch}` }, 400);
      }
    }

    // 1. Resolve matching contacts
    const contacts = await resolveMatchingContacts(db, userId, filter);
    if (contacts.length === 0) {
      return c.json({ success: false, error: "No matching contacts found for the selected audience" }, 400);
    }

    // 2. Commit destination snapshot
    const totalRecipients = await snapshotCampaignRecipients(db, campaignId, userId, channels, contacts);

    // 3. Mark campaign running
    await db.execute({
      sql: `UPDATE campaigns SET status = 'running', total_recipients_snapshot = ?, launched_at = CURRENT_TIMESTAMP WHERE id = ?`,
      args: [totalRecipients, campaignId]
    });

    // 4. Mark recipients queued
    await db.execute({
      sql: `UPDATE campaign_recipients SET delivery_status = 'queued' WHERE campaign_id = ? AND delivery_status = 'pending'`,
      args: [campaignId]
    });

    // 5. Enqueue execution batch to Cloudflare Queue if bound
    if (c.env?.SCHEDULE_QUEUE) {
      try {
        await c.env.SCHEDULE_QUEUE.send({
          type: "campaign_dispatch",
          campaign_id: campaignId,
          user_id: userId,
          enqueued_at: new Date().toISOString()
        });
      } catch (qErr) {
        console.warn("Queue enqueue warning (scanner recovery will handle):", qErr);
      }
    }

    return c.json({
      success: true,
      message: `Campaign launched successfully with ${totalRecipients} recipients`,
      total_recipients: totalRecipients
    });

  } catch (err) {
    console.error("Error launching campaign:", err);
    return c.json({ success: false, error: err.message || "Failed to launch campaign" }, 500);
  }
}

/**
 * POST /api/campaigns/:id/schedule
 * Schedules campaign occurrence in existing scheduler engine.
 */
export async function handleScheduleCampaign(c) {
  const db = getDbClient(c.env);
  const user = c.get("user");
  const userId = user?.id || user?.user_id || user?.sub;
  const campaignId = c.req.param("id");

  const body = await c.req.json().catch(() => ({}));
  const scheduledTime = body.scheduled_for || body.scheduledFor;
  const timezone = String(body.timezone || "Asia/Kolkata").trim();
  const filter = body.target_filter || body.targetFilter || {};

  if (!scheduledTime) {
    return c.json({ success: false, error: "Schedule date and time is required" }, 400);
  }

  const scheduledForUtc = localToUtc(scheduledTime, timezone);
  if (!scheduledForUtc || isNaN(new Date(scheduledForUtc).getTime())) {
    return c.json({ success: false, error: "Invalid schedule date/time" }, 400);
  }

  try {
    const cmpRes = await db.execute({
      sql: `SELECT * FROM campaigns WHERE id = ?`,
      args: [campaignId]
    });
    if (!cmpRes?.rows?.length) return c.json({ success: false, error: "Campaign not found" }, 404);
    const cmp = cmpRes.rows[0];
    if (cmp.user_id !== userId) return c.json({ success: false, error: "Unauthorized" }, 403);
    if (cmp.status !== "draft") return c.json({ success: false, error: `Cannot schedule campaign in '${cmp.status}' status` }, 400);

    let channels = [];
    try { channels = typeof cmp.channels === "string" ? JSON.parse(cmp.channels) : (cmp.channels || []); } catch (_) {}

    // Resolve and snapshot audience
    const contacts = await resolveMatchingContacts(db, userId, filter);
    if (contacts.length === 0) {
      return c.json({ success: false, error: "No matching contacts found for the selected audience" }, 400);
    }

    const totalRecipients = await snapshotCampaignRecipients(db, campaignId, userId, channels, contacts);

    // Register with existing schedules and occurrences
    const scheduleId = `sch_cmp_${campaignId.slice(4)}`;
    await db.execute({
      sql: `
        INSERT INTO schedules (id, user_id, contact_id, channel, schedule_type, timezone, status, next_run_utc, message_body)
        VALUES (?, ?, ?, 'whatsapp', 'one_off', ?, 'active', ?, 'Campaign Scheduled Dispatch')
      `,
      args: [scheduleId, userId, contacts[0].id, timezone, scheduledForUtc]
    }).catch(() => {});

    const occurrenceId = `occ_cmp_${campaignId.slice(4)}`;
    await db.execute({
      sql: `
        INSERT INTO scheduled_occurrences (id, schedule_id, occurrence_key, scheduled_for_utc, operational_status)
        VALUES (?, ?, 'campaign_initial_run', ?, 'pending')
      `,
      args: [occurrenceId, scheduleId, scheduledForUtc]
    }).catch(() => {});

    // Mark campaign scheduled
    await db.execute({
      sql: `UPDATE campaigns SET status = 'scheduled', scheduled_for = ?, local_scheduled_time = ?, timezone = ?, total_recipients_snapshot = ? WHERE id = ?`,
      args: [scheduledForUtc, scheduledTime, timezone, totalRecipients, campaignId]
    });

    return c.json({
      success: true,
      message: `Campaign scheduled for ${scheduledTime} (${timezone}) with ${totalRecipients} recipients`,
      scheduled_for_utc: scheduledForUtc,
      total_recipients: totalRecipients
    });

  } catch (err) {
    console.error("Error scheduling campaign:", err);
    return c.json({ success: false, error: err.message || "Failed to schedule campaign" }, 500);
  }
}

/**
 * POST /api/campaigns/:id/cancel
 * Cancels scheduled or running campaign, marking pending/queued recipients cancelled.
 */
export async function handleCancelCampaign(c) {
  const db = getDbClient(c.env);
  const user = c.get("user");
  const userId = user?.id || user?.user_id || user?.sub;
  const campaignId = c.req.param("id");

  try {
    const cmpRes = await db.execute({
      sql: `SELECT * FROM campaigns WHERE id = ?`,
      args: [campaignId]
    });
    if (!cmpRes?.rows?.length) return c.json({ success: false, error: "Campaign not found" }, 404);
    const cmp = cmpRes.rows[0];
    if (cmp.user_id !== userId && user.role !== "admin") return c.json({ success: false, error: "Unauthorized" }, 403);

    // Cancel campaign
    await db.execute({
      sql: `UPDATE campaigns SET status = 'cancelled' WHERE id = ?`,
      args: [campaignId]
    });

    // Cancel pending and queued recipients
    await db.execute({
      sql: `UPDATE campaign_recipients SET delivery_status = 'cancelled' WHERE campaign_id = ? AND delivery_status IN ('pending', 'queued')`,
      args: [campaignId]
    });

    // Cancel related schedule record
    const scheduleId = `sch_cmp_${campaignId.slice(4)}`;
    await db.execute({
      sql: `UPDATE schedules SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP WHERE id = ?`,
      args: [scheduleId]
    }).catch(() => {});

    return c.json({
      success: true,
      message: "Campaign and remaining dispatches cancelled successfully"
    });
  } catch (err) {
    console.error("Error cancelling campaign:", err);
    return c.json({ success: false, error: err.message || "Failed to cancel campaign" }, 500);
  }
}
