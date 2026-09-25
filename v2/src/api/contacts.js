import { getDbClient } from "../db/client.js";
import { normalizeIndianPhoneNumber, sendWhatsAppTemplate, sendWhatsAppText } from "../whatsapp/client.js";
import { getWhatsAppTemplate, renderTemplateBody } from "../whatsapp/templates.js";
import { isWithin24HourServiceWindow, getCustomerReplyWindowStatus } from "../whatsapp/window.js";

const MESSAGE_COST_PAISE = 90;

/**
 * GET /api/contacts
 * Returns contacts list with latest message, active request summary, and attention filters.
 */
export async function handleGetContacts(c) {
  const db = getDbClient(c.env);
  const user = c.get("user");
  const userId = user?.id || user?.user_id || user?.sub;

  const search = (c.req.query("search") || "").trim().toLowerCase();
  const filter = (c.req.query("filter") || "all").trim().toLowerCase();

  try {
    let sql = `
      SELECT 
        c.id, c.user_id, COALESCE(c.name, c.contact_person) as name, c.phone_number, c.email, c.company, c.notes,
        c.last_outbound_at, c.last_inbound_at, c.last_interaction_at,
        c.created_at, c.last_updated,
        conv.id as conversation_id, conv.unread_count, conv.last_message_at,
        (
          SELECT json_object(
            'id', m.id,
            'direction', m.direction,
            'channel', m.channel,
            'content', m.content,
            'template_id', m.template_id,
            'delivery_status', m.delivery_status,
            'created_at', m.created_at
          )
          FROM messages m 
          WHERE m.contact_id = c.id 
          ORDER BY m.created_at DESC LIMIT 1
        ) as latest_message_json,
        (
          SELECT json_object(
            'id', r.id,
            'title', r.title,
            'status', r.status,
            'due_date', r.due_date
          )
          FROM requests r
          WHERE r.contact_id = c.id AND r.status NOT IN ('completed', 'cancelled')
          ORDER BY r.created_at DESC LIMIT 1
        ) as active_request_json,
        (
          SELECT COUNT(*) FROM requests r WHERE r.contact_id = c.id AND r.status NOT IN ('completed', 'cancelled')
        ) as active_requests_count
      FROM contacts c
      LEFT JOIN conversations conv ON conv.contact_id = c.id AND conv.channel = 'whatsapp'
      WHERE c.user_id = ?
    `;

    const args = [userId];

    if (search) {
      sql += ` AND (LOWER(COALESCE(c.name, c.contact_person, '')) LIKE ? OR c.phone_number LIKE ? OR LOWER(COALESCE(c.email, '')) LIKE ? OR LOWER(COALESCE(c.company, '')) LIKE ?)`;
      const s = `%${search}%`;
      args.push(s, s, s, s);
    }

    sql += ` ORDER BY COALESCE(c.last_interaction_at, c.created_at) DESC LIMIT 200`;

    const res = await db.execute({ sql, args });

    const contacts = (res.rows || []).map((row) => {
      let latestMessage = null;
      let activeRequest = null;

      try {
        if (row.latest_message_json) latestMessage = JSON.parse(row.latest_message_json);
      } catch (_) {}

      try {
        if (row.active_request_json) activeRequest = JSON.parse(row.active_request_json);
      } catch (_) {}

      const contactObj = {
        id: row.id,
        name: row.name,
        phoneNumber: row.phone_number,
        email: row.email,
        company: row.company,
        notes: row.notes,
        lastOutboundAt: row.last_outbound_at,
        lastInboundAt: row.last_inbound_at,
        lastInteractionAt: row.last_interaction_at,
        createdAt: row.created_at,
        lastUpdated: row.last_updated,
        conversationId: row.conversation_id,
        unreadCount: row.unread_count || 0,
        lastMessageAt: row.last_message_at,
        latestMessage,
        activeRequest,
        activeRequestsCount: row.active_requests_count || 0,
        delivery_status: latestMessage?.delivery_status || (row.last_inbound_at ? "replied" : (row.last_outbound_at ? "sent" : null)),
        latest_delivery_status: latestMessage?.delivery_status || (row.last_inbound_at ? "replied" : (row.last_outbound_at ? "sent" : null)),
        latest_message_content: latestMessage?.content || null
      };

      return contactObj;
    });

    // Compute Attention Counts
    const attentionCounts = {
      needsAttention: 0,
      needsFollowUp: 0,
      waitingOnThem: 0,
      recentlyReplied: 0,
    };

    const nowTime = Date.now();
    const fortyEightHoursAgo = new Date(nowTime - 48 * 3600 * 1000).toISOString();

    for (const c of contacts) {
      // Needs Attention: waiting_on_me request OR failed message OR unread inbound
      const isWaitingOnMe = c.activeRequest?.status === "waiting_on_me";
      const hasFailedMsg = c.latestMessage?.delivery_status === "failed";
      const hasUnread = (c.unreadCount || 0) > 0;

      if (isWaitingOnMe || hasFailedMsg || hasUnread) {
        c.actionStatus = "needs_attention";
        c.action_status = "needs_attention";
        attentionCounts.needsAttention++;
      } else if (c.activeRequest?.status === "needs_follow_up") {
        c.actionStatus = "needs_follow_up";
        c.action_status = "needs_follow_up";
        attentionCounts.needsFollowUp++;
      } else if (c.lastInboundAt && c.lastInboundAt >= fortyEightHoursAgo) {
        c.actionStatus = "recently_replied";
        c.action_status = "recently_replied";
        attentionCounts.recentlyReplied++;
      } else if (c.activeRequest?.status === "waiting_on_them" || (c.latestMessage?.direction === "outbound" && !c.activeRequest)) {
        c.actionStatus = "waiting_on_them";
        c.action_status = "waiting_on_them";
        attentionCounts.waitingOnThem++;
      } else if (c.activeRequest?.status === "completed") {
        c.actionStatus = "completed";
        c.action_status = "completed";
      } else {
        c.actionStatus = "idle";
        c.action_status = "idle";
      }
    }

    // Apply client filter if requested
    let filteredContacts = contacts;
    if (filter === "needs_attention" || filter === "attention") {
      filteredContacts = contacts.filter(c => c.actionStatus === "needs_attention");
    } else if (filter === "needs_follow_up") {
      filteredContacts = contacts.filter(c => c.actionStatus === "needs_follow_up");
    } else if (filter === "waiting_on_them") {
      filteredContacts = contacts.filter(c => c.actionStatus === "waiting_on_them");
    } else if (filter === "recently_replied") {
      filteredContacts = contacts.filter(c => c.actionStatus === "recently_replied");
    } else if (filter === "completed") {
      filteredContacts = contacts.filter(c => c.actionStatus === "completed");
    }

    return c.json({
      success: true,
      contacts: filteredContacts,
      attentionCounts,
      total: filteredContacts.length,
    });
  } catch (err) {
    console.error("handleGetContacts error:", err);
    return c.json({ error: "Failed to fetch contacts", details: err.message }, 500);
  }
}

/**
 * POST /api/contacts
 * Creates a contact and optionally dispatches an initial message or creates a request.
 */
export async function handleCreateContact(c) {
  const db = getDbClient(c.env);
  const user = c.get("user");
  const userId = user?.id || user?.user_id || user?.sub;

  const body = await c.req.json().catch(() => ({}));
  const rawName = String(body.name || body.contactPerson || body.contact_person || "").trim();
  const rawPhone = String(body.phone_number || body.phoneNumber || body.phone || body.mobile || "").trim();
  const email = body.email ? String(body.email).trim().toLowerCase() : null;
  const company = body.company ? String(body.company).trim() : null;
  const notes = body.notes ? String(body.notes).trim() : null;

  if (!rawName) {
    return c.json({ error: "Contact name is required." }, 400);
  }

  let canonicalPhone;
  try {
    canonicalPhone = normalizeIndianPhoneNumber(rawPhone);
  } catch (err) {
    return c.json({ error: err.message }, 400);
  }

  // Check unique contact for user
  const existing = await db.execute({
    sql: "SELECT id, COALESCE(name, contact_person) as name FROM contacts WHERE user_id = ? AND phone_number = ? LIMIT 1",
    args: [userId, canonicalPhone],
  });

  if (existing.rows.length > 0) {
    return c.json({
      error: "A contact with this phone number already exists.",
      contactId: existing.rows[0].id,
      existingName: existing.rows[0].name,
    }, 409);
  }

  const contactId = "cnt_" + crypto.randomUUID();

  try {
    // 1. Insert Contact
    await db.execute({
      sql: `INSERT INTO contacts (id, user_id, name, contact_person, phone_number, email, company, notes, created_at, last_updated)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      args: [contactId, userId, rawName, rawName, canonicalPhone, email, company, notes],
    });

    // 2. Create Initial Conversation
    const conversationId = "conv_" + crypto.randomUUID();
    await db.execute({
      sql: `INSERT INTO conversations (id, user_id, contact_id, channel, last_message_at, unread_count, created_at)
            VALUES (?, ?, ?, 'whatsapp', NULL, 0, datetime('now'))`,
      args: [conversationId, userId, contactId],
    });

    // 3. Log Activity
    const activityId = "act_" + crypto.randomUUID();
    await db.execute({
      sql: `INSERT INTO activities (id, user_id, contact_id, request_id, activity_type, title, description, metadata, created_at)
            VALUES (?, ?, ?, NULL, 'contact_created', 'Target Created', NULL, ?, datetime('now'))`,
      args: [activityId, userId, contactId, JSON.stringify({ name: rawName })],
    });

    // 4. Optional Initial Request Creation
    let requestId = null;
    if (body.requestTitle || body.request) {
      const rTitle = String(body.requestTitle || body.request?.title || "").trim();
      if (rTitle) {
        requestId = "req_" + crypto.randomUUID();
        const rDesc = body.requestDescription || body.request?.description || null;
        const rDueDate = body.dueDate || body.request?.dueDate || null;

        await db.execute({
          sql: `INSERT INTO requests (id, user_id, contact_id, title, description, status, due_date, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, 'open', ?, datetime('now'), datetime('now'))`,
          args: [requestId, userId, contactId, rTitle, rDesc, rDueDate],
        });

        // Optional Request Items
        const items = body.requestItems || body.request?.items || [];
        if (Array.isArray(items) && items.length > 0) {
          for (const itemTitle of items) {
            const itemClean = String(itemTitle).trim();
            if (itemClean) {
              const itemId = "itm_" + crypto.randomUUID();
              await db.execute({
                sql: `INSERT INTO request_items (id, request_id, title, status, created_at, updated_at)
                      VALUES (?, ?, ?, 'pending', datetime('now'), datetime('now'))`,
                args: [itemId, requestId, itemClean],
              });
            }
          }
        }
      }
    }

    // 5. Optional Immediate Outreach Message Dispatch
    let dispatchedMessage = null;
    if (body.sendMessage !== false && (body.templateName || body.templateId || body.messageText)) {
      const templateIdentifier = body.templateId || body.templateName || "new_convo_1";
      const templateParams = Array.isArray(body.templateParams) ? body.templateParams : [rawName, user.username || "Collectr"];

      // Fetch custom templates if any
      const customTplsRes = await db.execute({
        sql: "SELECT * FROM message_templates WHERE user_id = ? OR user_id IS NULL",
        args: [userId],
      });
      const customTemplates = customTplsRes.rows || [];

      // Credit Check
      const userRes = await db.execute({
        sql: "SELECT credit_balance FROM users WHERE id = ? LIMIT 1",
        args: [userId],
      });
      const currentBalance = userRes.rows[0]?.credit_balance || 0;
      if (currentBalance < MESSAGE_COST_PAISE) {
        return c.json({
          success: true,
          contactId,
          warning: "Contact created, but message could not be sent due to insufficient credit balance.",
        }, 201);
      }

      // Reserve credits
      const idempotencyKey = "wa_init_" + crypto.randomUUID();
      const resId = "res_" + crypto.randomUUID();
      await db.execute({
        sql: "INSERT INTO credit_reservations (id, user_id, amount_paise, reference_id, status, created_at) VALUES (?, ?, ?, ?, 'PENDING', datetime('now'))",
        args: [resId, userId, MESSAGE_COST_PAISE, idempotencyKey],
      });

      // Template lookup & send
      const templateConfig = getWhatsAppTemplate(templateIdentifier, c.env, customTemplates);
      const sendResult = await sendWhatsAppTemplate({
        phone: canonicalPhone,
        templateConfig,
        templateParams: {
          name: rawName,
          userName: user.username || "Collectr",
          templateParams,
        },
        env: c.env,
      });

      const providerMsgId = sendResult?.messages?.[0]?.id || `wamid.mock_${Date.now()}`;
      const renderedBody = renderTemplateBody(templateIdentifier, {
        name: rawName,
        userName: user.username || "Collectr",
        templateParams,
        customTemplates,
      });

      // Insert Message Record
      const messageId = "msg_" + crypto.randomUUID();
      await db.execute({
        sql: `INSERT INTO messages (
          id, conversation_id, contact_id, user_id, request_id, direction, channel, sender_type, content, template_id, provider, provider_message_id, delivery_status, created_at
        ) VALUES (?, ?, ?, ?, ?, 'outbound', 'whatsapp', 'user', ?, ?, 'meta_whatsapp', ?, 'sent', datetime('now'))`,
        args: [messageId, conversationId, contactId, userId, requestId, renderedBody, templateIdentifier, providerMsgId],
      });

      // Update transport ledger
      await db.execute({
        sql: `INSERT INTO whatsapp_messages (id, user_id, message_id, idempotency_key, status, provider_message_id, created_at)
              VALUES (?, ?, ?, ?, 'SENT', ?, datetime('now'))`,
        args: ["wm_" + crypto.randomUUID(), userId, messageId, idempotencyKey, providerMsgId],
      });

      // Capture credit reservation & update user balance
      await db.execute({
        sql: "UPDATE credit_reservations SET status = 'CAPTURED', completed_at = datetime('now') WHERE id = ?",
        args: [resId],
      });
      await db.execute({
        sql: "UPDATE users SET credit_balance = credit_balance - ? WHERE id = ?",
        args: [MESSAGE_COST_PAISE, userId],
      });
      await db.execute({
        sql: `INSERT INTO credit_transactions (id, user_id, amount_paise, balance_after_paise, transaction_type, reference_type, reference_id, description, created_at)
              VALUES (?, ?, ?, ?, 'whatsapp_deduction', 'whatsapp_message', ?, 'WhatsApp Outreach (-₹0.90)', datetime('now'))`,
        args: ["tx_" + crypto.randomUUID(), userId, -MESSAGE_COST_PAISE, currentBalance - MESSAGE_COST_PAISE, idempotencyKey],
      });

      // Update Contact Timestamps & Request Status to waiting_on_them
      await db.execute({
        sql: "UPDATE contacts SET last_outbound_at = datetime('now'), last_interaction_at = datetime('now'), last_updated = datetime('now') WHERE id = ?",
        args: [contactId],
      });
      await db.execute({
        sql: "UPDATE conversations SET last_message_at = datetime('now') WHERE id = ?",
        args: [conversationId],
      });

      if (requestId) {
        await db.execute({
          sql: "UPDATE requests SET status = 'waiting_on_them', updated_at = datetime('now') WHERE id = ?",
          args: [requestId],
        });
      }

      dispatchedMessage = { id: messageId, providerMsgId, content: renderedBody };
    }

    return c.json({
      success: true,
      contact: {
        id: contactId,
        name: rawName,
        phone_number: canonicalPhone,
        phoneNumber: canonicalPhone,
        email,
        company,
        conversationId,
        requestId,
      },
      message: dispatchedMessage,
    }, 201);
  } catch (err) {
    console.error("handleCreateContact error:", err);
    return c.json({ error: "Failed to create contact", details: err.message }, 500);
  }
}

/**
 * GET /api/contacts/:id
 * Fetches single contact workspace with conversation, requests, and activity stream.
 */
export async function handleGetContactWorkspace(c) {
  const db = getDbClient(c.env);
  const user = c.get("user");
  const userId = user?.id || user?.user_id || user?.sub;
  const contactId = c.req.param("id");

  try {
    // 1. Fetch Contact
    const contactRes = await db.execute({
      sql: "SELECT * FROM contacts WHERE id = ? AND user_id = ? LIMIT 1",
      args: [contactId, userId],
    });

    if (contactRes.rows.length === 0) {
      const anyContact = await db.execute({
        sql: "SELECT id FROM contacts WHERE id = ? LIMIT 1",
        args: [contactId],
      }).catch(() => ({ rows: [] }));
      const anyCase = await db.execute({
        sql: "SELECT id FROM loan_cases WHERE id = ? LIMIT 1",
        args: [contactId],
      }).catch(() => ({ rows: [] }));
      if (anyContact.rows.length > 0 || anyCase.rows.length > 0) {
        return c.json({ error: "Access denied. You do not have permission to view this contact." }, 403);
      }
      return c.json({ error: "Contact not found." }, 404);
    }

    const contact = contactRes.rows[0];

    // 2. Fetch Conversation & Messages
    let conversation = null;
    let messages = [];

    const convRes = await db.execute({
      sql: "SELECT * FROM conversations WHERE contact_id = ? AND channel = 'whatsapp' LIMIT 1",
      args: [contactId],
    });

    if (convRes.rows.length > 0) {
      conversation = convRes.rows[0];
      const msgRes = await db.execute({
        sql: "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC",
        args: [conversation.id],
      });
      messages = msgRes.rows || [];
    }

    // 3. Fetch Requests & Items
    const reqRes = await db.execute({
      sql: "SELECT * FROM requests WHERE contact_id = ? ORDER BY created_at DESC",
      args: [contactId],
    });

    const requests = [];
    for (const req of reqRes.rows || []) {
      const itemsRes = await db.execute({
        sql: "SELECT * FROM request_items WHERE request_id = ? ORDER BY order_index ASC",
        args: [req.id],
      });
      requests.push({
        ...req,
        items: itemsRes.rows || [],
      });
    }

    // 4. Fetch Activities
    const actRes = await db.execute({
      sql: "SELECT * FROM activities WHERE contact_id = ? ORDER BY created_at DESC LIMIT 50",
      args: [contactId],
    });

    // Compute live 24h Meta Customer Service Window
    const windowStatus = await getCustomerReplyWindowStatus(db, contactId);

    // Compute decoupled presentation statuses
    const outboundMsgs = messages.filter(m => m.direction === "outbound");
    const latestOutbound = outboundMsgs.length > 0 ? outboundMsgs[outboundMsgs.length - 1] : null;

    let deliveryStatus = "not_contacted";
    if (latestOutbound) {
      deliveryStatus = latestOutbound.delivery_status || "sent";
    }

    const activeRequest = requests.find(r => !["completed", "cancelled"].includes(r.status));
    let actionStatus = "idle";
    const now = new Date();
    const fortyEightHoursAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();

    if (activeRequest?.status === "waiting_on_me" || latestOutbound?.delivery_status === "failed") {
      actionStatus = "attention";
    } else if (activeRequest?.status === "needs_follow_up") {
      actionStatus = "needs_follow_up";
    } else if (contact.last_inbound_at && contact.last_inbound_at >= fortyEightHoursAgo) {
      actionStatus = "recently_replied";
    } else if (activeRequest?.status === "waiting_on_them" || outboundMsgs.length > 0) {
      actionStatus = "waiting_on_them";
    } else if (activeRequest?.status === "completed" || (requests.length > 0 && requests.every(r => r.status === "completed"))) {
      actionStatus = "completed";
    }

    return c.json({
      success: true,
      contact: {
        id: contact.id,
        name: contact.name || contact.contact_person,
        phoneNumber: contact.phone_number,
        email: contact.email,
        company: contact.company,
        notes: contact.notes,
        deliveryStatus,
        actionStatus,
        lastOutboundAt: contact.last_outbound_at,
        lastInboundAt: contact.last_inbound_at,
        lastInteractionAt: contact.last_interaction_at,
        createdAt: contact.created_at,
        lastUpdated: contact.last_updated,
      },
      conversation,
      messages,
      requests,
      activities: actRes.rows || [],
      customerWindow: windowStatus,
    });
  } catch (err) {
    console.error("handleGetContactWorkspace error:", err);
    return c.json({ error: "Failed to load contact workspace", details: err.message }, 500);
  }
}

/**
 * PATCH /api/contacts/:id
 * Updates contact metadata.
 */
export async function handleUpdateContact(c) {
  const db = getDbClient(c.env);
  const user = c.get("user");
  const userId = user?.id || user?.user_id || user?.sub;
  const contactId = c.req.param("id");

  const body = await c.req.json().catch(() => ({}));
  const name = body.name ? String(body.name).trim() : undefined;
  const email = body.email !== undefined ? (body.email ? String(body.email).trim().toLowerCase() : null) : undefined;
  const company = body.company !== undefined ? (body.company ? String(body.company).trim() : null) : undefined;
  const notes = body.notes !== undefined ? (body.notes ? String(body.notes).trim() : null) : undefined;

  try {
    const contactRes = await db.execute({
      sql: "SELECT * FROM contacts WHERE id = ? AND user_id = ? LIMIT 1",
      args: [contactId, userId],
    });

    if (contactRes.rows.length === 0) {
      const anyContact = await db.execute({
        sql: "SELECT id FROM contacts WHERE id = ? LIMIT 1",
        args: [contactId],
      }).catch(() => ({ rows: [] }));
      const anyCase = await db.execute({
        sql: "SELECT id FROM loan_cases WHERE id = ? LIMIT 1",
        args: [contactId],
      }).catch(() => ({ rows: [] }));
      if (anyContact.rows.length > 0 || anyCase.rows.length > 0) {
        return c.json({ error: "Access denied. You do not have permission to modify this contact." }, 403);
      }
      return c.json({ error: "Contact not found." }, 404);
    }

    const current = contactRes.rows[0];
    const updatedName = name !== undefined ? name : (current.name || current.contact_person);
    const updatedEmail = email !== undefined ? email : current.email;
    const updatedCompany = company !== undefined ? company : current.company;
    const updatedNotes = notes !== undefined ? notes : current.notes;

    await db.execute({
      sql: `UPDATE contacts SET name = ?, contact_person = ?, email = ?, company = ?, notes = ?, last_updated = datetime('now') WHERE id = ? AND user_id = ?`,
      args: [updatedName, updatedName, updatedEmail, updatedCompany, updatedNotes, contactId, userId],
    });

    return c.json({ success: true, message: "Contact updated successfully" });
  } catch (err) {
    console.error("handleUpdateContact error:", err);
    return c.json({ error: "Failed to update contact", details: err.message }, 500);
  }
}

/**
 * DELETE /api/contacts/:id
 * Deletes contact and cascaded relationships.
 */
export async function handleDeleteContact(c) {
  const db = getDbClient(c.env);
  const user = c.get("user");
  const userId = user?.id || user?.user_id || user?.sub;
  const contactId = c.req.param("id");

  try {
    const res = await db.execute({
      sql: "DELETE FROM contacts WHERE id = ? AND user_id = ?",
      args: [contactId, userId],
    });

    if (res.rowsAffected === 0) {
      return c.json({ error: "Contact not found." }, 404);
    }

    return c.json({ success: true, message: "Contact deleted successfully" });
  } catch (err) {
    console.error("handleDeleteContact error:", err);
    return c.json({ error: "Failed to delete contact", details: err.message }, 500);
  }
}

/**
 * POST /api/contacts/check
 * Quick duplicate pre-check for phone numbers.
 */
export async function handleCheckContactPhone(c) {
  const db = getDbClient(c.env);
  const user = c.get("user");
  const userId = user?.id || user?.user_id || user?.sub;

  const body = await c.req.json().catch(() => ({}));
  const rawPhone = String(body.phone_number || body.phone || body.phoneNumber || body.mobile || "").trim();

  let canonicalPhone;
  try {
    canonicalPhone = normalizeIndianPhoneNumber(rawPhone);
  } catch (err) {
    return c.json({ error: err.message }, 400);
  }

  const res = await db.execute({
    sql: "SELECT id, COALESCE(name, contact_person) as name, phone_number, email FROM contacts WHERE user_id = ? AND phone_number = ? LIMIT 1",
    args: [userId, canonicalPhone],
  });

  if (res.rows.length > 0) {
    return c.json({
      exists: true,
      contact: res.rows[0],
    });
  }

  return c.json({ exists: false, canonicalPhone });
}
