import { getDbClient } from "../db/client.js";
import { WHATSAPP_TEMPLATES } from "../whatsapp/templates.js";

/**
 * Supported Meta Official Language Codes
 */
export const SUPPORTED_LANGUAGES = [
  { code: "en", name: "English (en)" },
  { code: "en_IN", name: "English (IND) / en_IN" },
  { code: "en_US", name: "English US (en_US)" },
  { code: "en_GB", name: "English UK (en_GB)" },
];

/**
 * Built-in System Email Templates
 */
export const SYSTEM_EMAIL_TEMPLATES = [
  {
    id: "tpl_sys_email_intro",
    name: "founder_intro_email",
    displayName: "Founder Introduction",
    channel: "email",
    scope: "system",
    subject: "Introduction — {{name}} & Springboard",
    body_text: "Hi {{name}},\n\nI came across your work and wanted to introduce how you can manage personal outreach and client requests seamlessly.\n\nWould love to connect if this sounds interesting.\n\nBest regards,\n{{user_name}}",
    param_mappings: {
      subject: ["name"],
      body: ["name", "user_name"]
    },
    variables: [
      { token: "{{name}}", label: "Contact Name", component: "body" },
      { token: "{{user_name}}", label: "Sender Name", component: "body" }
    ],
    is_system: true,
    status: "active"
  },
  {
    id: "tpl_sys_email_followup",
    name: "client_followup_email",
    displayName: "Quick Follow-Up",
    channel: "email",
    scope: "system",
    subject: "Following up on our conversation — {{name}}",
    body_text: "Hi {{name}},\n\nJust following up on our previous note. Let me know if you have any questions or if we should reconnect next week.\n\nBest regards,\n{{user_name}}",
    param_mappings: {
      subject: ["name"],
      body: ["name", "user_name"]
    },
    variables: [
      { token: "{{name}}", label: "Contact Name", component: "body" },
      { token: "{{user_name}}", label: "Sender Name", component: "body" }
    ],
    is_system: true,
    status: "active"
  }
];

/**
 * Helper to extract variable tokens from template components
 */
export function extractTemplateVariables(
  bodyText = "",
  headerText = "",
  paramMappings = {}
) {
  const vars = [];

  if (headerText) {
    const hMatches = headerText.match(/\{\{(\w+|\d+)\}\}/g) || [];
    hMatches.forEach((m, idx) => {
      const rawToken = m.replace(/[\{\}]/g, "");
      vars.push({
        token: m,
        component: "header",
        index: idx + 1,
        label: paramMappings.header?.[idx] || (isNaN(Number(rawToken)) ? rawToken : `Header Variable ${idx + 1}`)
      });
    });
  }

  if (bodyText) {
    const bMatches = bodyText.match(/\{\{(\w+|\d+)\}\}/g) || [];
    bMatches.forEach((m, idx) => {
      const rawToken = m.replace(/[\{\}]/g, "");
      let defaultLabel = idx === 0 ? "Target Name" : `Parameter ${idx + 1}`;
      if (isNaN(Number(rawToken))) {
        defaultLabel = rawToken.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
      }
      if (paramMappings.body?.[idx]) {
        const p = paramMappings.body[idx];
        const strP = typeof p === "string" ? p : (p?.text || p?.name || "");
        if (strP) {
          defaultLabel = strP.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
        }
      }
      vars.push({
        token: m,
        component: "body",
        index: idx + 1,
        label: defaultLabel
      });
    });
  }

  return vars;
}

/**
 * Convert hardcoded WHATSAPP_TEMPLATES configuration into normalized format
 */
function buildSystemWhatsAppTemplates() {
  return Object.values(WHATSAPP_TEMPLATES).map((template) => {
    const bodyText = template.body_text || template.body?.text || "";
    const bodyParameters = template.parameters || template.body?.parameters || [];
    const button = template.button || null;

    let buttons = [];
    if (button) {
      buttons.push({
        type: "URL",
        text: button.text || "View",
        url: button.url || ""
      });
    }

    return {
      id: template.id,
      name: template.name,
      displayName: template.displayName || template.name,
      channel: "whatsapp",
      scope: "system",
      category: template.category || "UTILITY",
      language: template.defaultLang || "en",
      context: template.context || ["direct_outreach", "ca", "loan_agent"],

      header_type: "NONE",
      header_text: "",
      body_text: bodyText,
      footer_text: "Collectrr Verification Portal",

      button_type: button ? "url" : "none",
      button_text: button?.text || "",
      button_url: "",
      buttons: buttons,

      param_mappings: {
        body: bodyParameters,
        button: button?.parameter ? [button.parameter] : []
      },
      parameters: Array.isArray(template.parameters) ? template.parameters : [],
      variables: extractTemplateVariables(bodyText, "", { body: bodyParameters }),

      is_system: true,
      status: "active",
      version: 1,
      description: template.description || ""
    };
  });
}

/**
 * GET /api/templates
 * Returns active system templates and user's custom templates (WhatsApp and Email).
 */
export async function handleGetTemplates(c) {
  const db = getDbClient(c.env);
  const user = c.get("user");
  const userId = user?.id;

  const channelQuery = (c.req.query("channel") || "").trim().toLowerCase();
  const statusQuery = (c.req.query("status") || "active").trim().toLowerCase();

  const sysWhatsApp = buildSystemWhatsAppTemplates();
  const sysEmail = SYSTEM_EMAIL_TEMPLATES;

  let allSystem = [...sysWhatsApp, ...sysEmail];
  if (channelQuery) {
    allSystem = allSystem.filter(t => t.channel === channelQuery);
  }

  try {
    // 1. Fetch custom templates from new templates + config tables
    let customTemplates = [];
    let customSql = `
      SELECT 
        t.id, t.user_id, t.scope, t.name, t.display_name, t.channel, t.version, t.status, t.created_at, t.updated_at,
        wa.meta_template_name, wa.language, wa.category, wa.header_type, wa.header_text, wa.body_text as wa_body_text, wa.footer_text, wa.buttons, wa.param_mappings as wa_param_mappings,
        em.subject as em_subject, em.body_text as em_body_text, em.param_mappings as em_param_mappings
      FROM templates t
      LEFT JOIN whatsapp_template_configs wa ON t.id = wa.template_id
      LEFT JOIN email_template_configs em ON t.id = em.template_id
      WHERE (t.user_id = ? OR t.scope = 'system')
    `;
    const customArgs = [userId || ""];

    if (statusQuery === "active") {
      customSql += ` AND t.status = 'active'`;
    } else if (statusQuery === "archived") {
      customSql += ` AND t.status = 'archived'`;
    }

    if (channelQuery) {
      customSql += ` AND t.channel = ?`;
      customArgs.push(channelQuery);
    }

    customSql += ` ORDER BY t.created_at DESC`;

    const res = await db.execute({ sql: customSql, args: customArgs });
    if (res && res.rows) {
      for (const row of res.rows) {
        let isWhatsApp = row.channel === "whatsapp";
        let bodyText = isWhatsApp ? (row.wa_body_text || "") : (row.em_body_text || "");
        let rawMappings = isWhatsApp ? row.wa_param_mappings : row.em_param_mappings;
        let mappings = {};
        try {
          mappings = typeof rawMappings === "string" ? JSON.parse(rawMappings) : (rawMappings || {});
        } catch (_) {}

        let buttons = [];
        try {
          buttons = typeof row.buttons === "string" ? JSON.parse(row.buttons) : (row.buttons || []);
        } catch (_) {}

        customTemplates.push({
          id: row.id,
          user_id: row.user_id,
          name: row.name,
          displayName: row.display_name || row.name,
          channel: row.channel,
          scope: row.scope || "custom",
          version: row.version || 1,
          status: row.status,
          category: row.category || "UTILITY",
          language: row.language || "en",
          meta_template_name: row.meta_template_name || row.name,

          header_type: row.header_type || "NONE",
          header_text: row.header_text || "",
          body_text: bodyText,
          footer_text: row.footer_text || "",
          subject: row.em_subject || "",
          buttons: buttons,
          param_mappings: mappings,
          variables: extractTemplateVariables(bodyText, row.header_text || "", mappings),
          is_system: row.scope === "system",
          created_at: row.created_at,
          updated_at: row.updated_at
        });
      }
    }

    // Combine system and custom templates, deduplicating by (channel, name)
    const seenKeys = new Set(customTemplates.map(t => `${t.channel}:${t.name.toLowerCase()}`));
    const finalSystem = allSystem.filter(t => !seenKeys.has(`${t.channel}:${t.name.toLowerCase()}`));

    return c.json({
      success: true,
      languages: SUPPORTED_LANGUAGES,
      templates: [...finalSystem, ...customTemplates]
    });
  } catch (err) {
    console.error("Error fetching templates:", err);
    return c.json({
      success: true,
      languages: SUPPORTED_LANGUAGES,
      templates: allSystem
    });
  }
}

/**
 * POST /api/templates
 * Creates a new custom template with channel-specific configuration.
 */
export async function handleCreateTemplate(c) {
  const db = getDbClient(c.env);
  const user = c.get("user");
  const userId = user?.id || user?.user_id || user?.sub;

  const body = await c.req.json().catch(() => ({}));
  const rawName = String(body.name || "").trim().toLowerCase();
  const channel = String(body.channel || "whatsapp").trim().toLowerCase();
  const displayName = String(body.displayName || body.display_name || rawName).trim();

  if (!rawName) {
    return c.json({ success: false, error: "Template identifier name is required" }, 400);
  }
  if (!displayName) {
    return c.json({ success: false, error: "Template display name is required" }, 400);
  }
  if (!["whatsapp", "email"].includes(channel)) {
    return c.json({ success: false, error: "Channel must be 'whatsapp' or 'email'" }, 400);
  }

  // Name format check: snake_case for consistency
  const cleanName = rawName.replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
  if (!cleanName) {
    return c.json({ success: false, error: "Template name must contain alphanumeric characters" }, 400);
  }

  // 1. Check if name collides with a built-in protected system template
  const sysNames = new Set([
    ...Object.values(WHATSAPP_TEMPLATES).map(t => (t.name || "").trim().toLowerCase()),
    ...SYSTEM_EMAIL_TEMPLATES.map(t => (t.name || "").trim().toLowerCase())
  ]);
  if (sysNames.has(cleanName)) {
    return c.json({
      success: false,
      error: `A template named '${cleanName}' already exists as a protected system template. Template names must be unique.`
    }, 409);
  }

  try {
    // 2. Check unique name constraint within tenant
    const existing = await db.execute({
      sql: `SELECT id FROM templates WHERE (user_id = ? OR scope = 'system') AND channel = ? AND LOWER(name) = ? AND status = 'active'`,
      args: [userId, channel, cleanName]
    });
    if (existing?.rows?.length > 0) {
      return c.json({ success: false, error: `A template named '${cleanName}' already exists. Template names must be unique.` }, 409);
    }

    // Also check legacy message_templates table
    const existingLegacy = await db.execute({
      sql: `SELECT id FROM message_templates WHERE (user_id = ? OR user_id IS NULL) AND LOWER(name) = ? AND is_active = 1`,
      args: [userId, cleanName]
    }).catch(() => null);
    if (existingLegacy?.rows?.length > 0) {
      return c.json({ success: false, error: `A template named '${cleanName}' already exists. Template names must be unique.` }, 409);
    }

    const templateId = `tpl_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const bodyText = String(body.body_text || body.bodyText || "").trim();

    if (!bodyText) {
      return c.json({ success: false, error: "Template body text is required" }, 400);
    }

    // 2. Insert into templates table
    await db.execute({
      sql: `INSERT INTO templates (id, user_id, scope, name, display_name, channel, version, status) VALUES (?, ?, 'custom', ?, ?, ?, 1, 'active')`,
      args: [templateId, userId, cleanName, displayName, channel]
    });

    // 3. Channel specific configuration insertion
    if (channel === "whatsapp") {
      const metaName = String(body.meta_template_name || cleanName).trim().toLowerCase();
      const language = String(body.language || "en").trim();
      const category = String(body.category || "UTILITY").toUpperCase();
      const headerType = String(body.header_type || "NONE").toUpperCase();
      const headerText = String(body.header_text || "");
      const footerText = String(body.footer_text || "");
      const buttons = Array.isArray(body.buttons) ? body.buttons : [];
      const paramMappings = body.param_mappings || {};

      await db.execute({
        sql: `INSERT INTO whatsapp_template_configs (template_id, meta_template_name, language, category, header_type, header_text, body_text, footer_text, buttons, param_mappings)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          templateId,
          metaName,
          language,
          category,
          headerType,
          headerText,
          bodyText,
          footerText,
          JSON.stringify(buttons),
          JSON.stringify(paramMappings)
        ]
      });

      // Backward compatibility mirror into message_templates
      await db.execute({
        sql: `INSERT INTO message_templates (id, user_id, name, category, channel, language, header_type, header_text, body_text, footer_text, button_type, param_mappings, is_active)
              VALUES (?, ?, ?, ?, 'whatsapp', ?, ?, ?, ?, ?, ?, ?, 1)`,
        args: [
          templateId,
          userId,
          cleanName,
          category,
          language,
          headerType,
          headerText,
          bodyText,
          footerText,
          buttons.length > 0 ? "url" : "NONE",
          JSON.stringify(paramMappings)
        ]
      }).catch(() => {});

    } else if (channel === "email") {
      const subject = String(body.subject || "Important update from Collectrr").trim();
      const paramMappings = body.param_mappings || {};

      await db.execute({
        sql: `INSERT INTO email_template_configs (template_id, subject, body_text, param_mappings) VALUES (?, ?, ?, ?)`,
        args: [templateId, subject, bodyText, JSON.stringify(paramMappings)]
      });

      // Backward compatibility mirror into message_templates
      await db.execute({
        sql: `INSERT INTO message_templates (id, user_id, name, category, channel, subject, body_text, is_active)
              VALUES (?, ?, ?, 'UTILITY', 'email', ?, ?, 1)`,
        args: [templateId, userId, cleanName, subject, bodyText]
      }).catch(() => {});
    }

    return c.json({
      success: true,
      message: "Template created successfully",
      template: {
        id: templateId,
        name: cleanName,
        displayName: displayName,
        channel: channel,
        version: 1,
        status: "active"
      }
    }, 201);

  } catch (err) {
    console.error("Error creating template:", err);
    return c.json({ success: false, error: err.message || "Failed to create template" }, 500);
  }
}

/**
 * PUT /api/templates/:id
 * Updates an existing custom template and increments version.
 */
export async function handleUpdateTemplate(c) {
  const db = getDbClient(c.env);
  const user = c.get("user");
  const userId = user?.id || user?.user_id || user?.sub;
  const templateId = c.req.param("id");

  const body = await c.req.json().catch(() => ({}));

  try {
    // 1. Verify tenant ownership
    const existing = await db.execute({
      sql: `SELECT id, user_id, scope, channel, version FROM templates WHERE id = ?`,
      args: [templateId]
    });

    if (!existing?.rows?.length) {
      return c.json({ success: false, error: "Template not found" }, 404);
    }

    const tpl = existing.rows[0];
    if (tpl.scope === "system" || tpl.user_id !== userId) {
      return c.json({ success: false, error: "Cannot modify system or unauthorized templates" }, 403);
    }

    const newVersion = (tpl.version || 1) + 1;
    const displayName = body.displayName || body.display_name;
    const bodyText = String(body.body_text || body.bodyText || "").trim();

    if (!bodyText) {
      return c.json({ success: false, error: "Template body text is required" }, 400);
    }

    // 2. Update templates table
    await db.execute({
      sql: `UPDATE templates SET display_name = COALESCE(?, display_name), version = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      args: [displayName || null, newVersion, templateId]
    });

    // 3. Update channel config
    if (tpl.channel === "whatsapp") {
      const language = String(body.language || "en").trim();
      const category = String(body.category || "UTILITY").toUpperCase();
      const headerType = String(body.header_type || "NONE").toUpperCase();
      const headerText = String(body.header_text || "");
      const footerText = String(body.footer_text || "");
      const buttons = Array.isArray(body.buttons) ? body.buttons : [];
      const paramMappings = body.param_mappings || {};

      await db.execute({
        sql: `UPDATE whatsapp_template_configs 
              SET language = ?, category = ?, header_type = ?, header_text = ?, body_text = ?, footer_text = ?, buttons = ?, param_mappings = ?
              WHERE template_id = ?`,
        args: [
          language,
          category,
          headerType,
          headerText,
          bodyText,
          footerText,
          JSON.stringify(buttons),
          JSON.stringify(paramMappings),
          templateId
        ]
      });

      // Update legacy table
      await db.execute({
        sql: `UPDATE message_templates SET body_text = ?, header_text = ?, footer_text = ?, param_mappings = ? WHERE id = ?`,
        args: [bodyText, headerText, footerText, JSON.stringify(paramMappings), templateId]
      }).catch(() => {});

    } else if (tpl.channel === "email") {
      const subject = String(body.subject || "").trim();
      const paramMappings = body.param_mappings || {};

      await db.execute({
        sql: `UPDATE email_template_configs SET subject = COALESCE(?, subject), body_text = ?, param_mappings = ? WHERE template_id = ?`,
        args: [subject || null, bodyText, JSON.stringify(paramMappings), templateId]
      });

      // Update legacy table
      await db.execute({
        sql: `UPDATE message_templates SET subject = COALESCE(?, subject), body_text = ? WHERE id = ?`,
        args: [subject || null, bodyText, templateId]
      }).catch(() => {});
    }

    return c.json({
      success: true,
      message: "Template updated successfully",
      version: newVersion
    });
  } catch (err) {
    console.error("Error updating template:", err);
    return c.json({ success: false, error: err.message || "Failed to update template" }, 500);
  }
}

/**
 * DELETE /api/templates/:id
 * Soft-archives a custom template.
 */
export async function handleDeleteTemplate(c) {
  const db = getDbClient(c.env);
  const user = c.get("user");
  const userId = user?.id || user?.user_id || user?.sub;
  const templateId = c.req.param("id");

  try {
    const existing = await db.execute({
      sql: `SELECT id, user_id, scope, name FROM templates WHERE id = ?`,
      args: [templateId]
    });

    if (!existing?.rows?.length) {
      // Also check legacy message_templates
      const leg = await db.execute({
        sql: `SELECT id, user_id FROM message_templates WHERE id = ?`,
        args: [templateId]
      });
      if (leg?.rows?.length > 0 && (leg.rows[0].user_id === userId || user.role === "admin")) {
        await db.execute({ sql: `UPDATE message_templates SET is_active = 0 WHERE id = ?`, args: [templateId] });
        return c.json({ success: true, message: "Template archived successfully" });
      }
      return c.json({ success: false, error: "Template not found" }, 404);
    }

    const tpl = existing.rows[0];
    if (tpl.scope === "system" && user.role !== "admin") {
      return c.json({ success: false, error: "System templates cannot be deleted" }, 403);
    }
    if (tpl.scope !== "system" && tpl.user_id !== userId && user.role !== "admin") {
      return c.json({ success: false, error: "Unauthorized" }, 403);
    }

    await db.execute({
      sql: `UPDATE templates SET status = 'archived', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      args: [templateId]
    });

    await db.execute({
      sql: `UPDATE message_templates SET is_active = 0 WHERE id = ? OR LOWER(name) = LOWER(?)`,
      args: [templateId, tpl.name]
    }).catch(() => {});

    return c.json({ success: true, message: "Template archived successfully" });
  } catch (err) {
    console.error("Error archiving template:", err);
    return c.json({ success: false, error: err.message || "Failed to archive template" }, 500);
  }
}