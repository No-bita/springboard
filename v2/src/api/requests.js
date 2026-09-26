import { getDbClient } from "../db/client.js";
import { computeFollowUpUtc } from "../scheduler/time.js";

const VALID_REQUEST_STATUSES = [
  "open",
  "waiting_on_them",
  "needs_follow_up",
  "waiting_on_me",
  "completed",
  "cancelled",
];

const VALID_ITEM_STATUSES = ["pending", "done", "waived"];

/**
 * POST /api/contacts/:id/requests
 * Creates a new request with optional checklist items for a contact.
 */
export async function handleCreateRequest(c) {
  const db = getDbClient(c.env);
  const user = c.get("user");
  const userId = user.id;
  const contactId = c.req.param("id");

  const body = await c.req.json().catch(() => ({}));
  const title = String(body.title || "").trim();
  const description = body.description ? String(body.description).trim() : null;
  const dueDate = body.dueDate || null;
  const items = Array.isArray(body.items) ? body.items : [];

  if (!title) {
    return c.json({ error: "Request title is required." }, 400);
  }

  try {
    // Verify contact ownership
    const contactRes = await db.execute({
      sql: "SELECT id, name FROM contacts WHERE id = ? AND user_id = ? LIMIT 1",
      args: [contactId, userId],
    });

    if (contactRes.rows.length === 0) {
      return c.json({ error: "Contact not found." }, 404);
    }

    const requestId = "req_" + crypto.randomUUID();

    await db.execute({
      sql: `INSERT INTO requests (id, user_id, contact_id, title, description, status, due_date, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'open', ?, datetime('now'), datetime('now'))`,
      args: [requestId, userId, contactId, title, description, dueDate],
    });

    // Insert checklist items
    const createdItems = [];
    for (const item of items) {
      const itemTitle = typeof item === "string" ? item.trim() : String(item.title || "").trim();
      if (itemTitle) {
        const itemId = "itm_" + crypto.randomUUID();
        await db.execute({
          sql: `INSERT INTO request_items (id, request_id, title, status, created_at, updated_at)
                VALUES (?, ?, ?, 'pending', datetime('now'), datetime('now'))`,
          args: [itemId, requestId, itemTitle],
        });
        createdItems.push({ id: itemId, title: itemTitle, status: "pending" });
      }
    }

    // Log Activity
    const actId = "act_" + crypto.randomUUID();
    await db.execute({
      sql: `INSERT INTO activities (id, user_id, contact_id, request_id, activity_type, title, description, metadata, created_at)
            VALUES (?, ?, ?, ?, 'request_created', 'Request Created', ?, ?, datetime('now'))`,
      args: [actId, userId, contactId, requestId, title, JSON.stringify({ itemsCount: createdItems.length, dueDate })],
    });

    return c.json({
      success: true,
      request: {
        id: requestId,
        contactId,
        title,
        description,
        status: "open",
        dueDate,
        items: createdItems,
      },
    }, 201);
  } catch (err) {
    console.error("handleCreateRequest error:", err);
    return c.json({ error: "Failed to create request", details: err.message }, 500);
  }
}

/**
 * PATCH /api/requests/:id/status
 * Updates request status strictly following the state machine.
 */
export async function handleUpdateRequestStatus(c) {
  const db = getDbClient(c.env);
  const user = c.get("user");
  const userId = user.id;
  const requestId = c.req.param("id");

  const body = await c.req.json().catch(() => ({}));
  const targetStatus = String(body.status || "").trim().toLowerCase();

  if (!VALID_REQUEST_STATUSES.includes(targetStatus)) {
    return c.json({
      error: `Invalid status. Valid statuses are: ${VALID_REQUEST_STATUSES.join(", ")}`,
    }, 400);
  }

  try {
    const reqRes = await db.execute({
      sql: "SELECT * FROM requests WHERE id = ? AND user_id = ? LIMIT 1",
      args: [requestId, userId],
    });

    if (reqRes.rows.length === 0) {
      return c.json({ error: "Request not found." }, 404);
    }

    const currentReq = reqRes.rows[0];
    const completedAt = targetStatus === "completed" ? new Date().toISOString() : null;

    await db.execute({
      sql: `UPDATE requests SET status = ?, completed_at = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?`,
      args: [targetStatus, completedAt, requestId, userId],
    });

    // If request completed or cancelled, cancel any active pending follow-up
    if (["completed", "cancelled"].includes(targetStatus)) {
      await db.execute({
        sql: `UPDATE request_follow_ups 
              SET status = 'cancelled', 
                  skip_reason = ?, 
                  updated_at = datetime('now') 
              WHERE request_id = ? AND status = 'pending'`,
        args: [targetStatus === "completed" ? "request_completed" : "request_cancelled", requestId],
      });
    }

    // Log Activity
    const actId = "act_" + crypto.randomUUID();
    const actType = targetStatus === "completed" ? "request_completed" : "request_status_updated";
    await db.execute({
      sql: `INSERT INTO activities (id, user_id, contact_id, request_id, activity_type, title, description, metadata, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      args: [
        actId,
        userId,
        currentReq.contact_id,
        requestId,
        actType,
        `Request marked ${targetStatus.replace(/_/g, " ")}`,
        currentReq.title,
        JSON.stringify({ previousStatus: currentReq.status, newStatus: targetStatus }),
      ],
    });

    return c.json({
      success: true,
      request: {
        id: requestId,
        status: targetStatus,
        completedAt,
      },
    });
  } catch (err) {
    console.error("handleUpdateRequestStatus error:", err);
    return c.json({ error: "Failed to update request status", details: err.message }, 500);
  }
}

/**
 * POST /api/requests/:id/follow-up
 * Schedules or reschedules a follow-up reminder for a request.
 */
export async function handleSetRequestFollowUp(c) {
  const db = getDbClient(c.env);
  const user = c.get("user");
  const userId = user?.id || user?.user_id || user?.sub;
  const requestId = c.req.param("id");

  const body = await c.req.json().catch(() => ({}));
  const preset = body.preset ? String(body.preset).trim().toLowerCase() : null; // 'tomorrow' | '3_days' | 'next_week' | 'custom'
  const customScheduledFor = body.scheduledFor || body.scheduled_for || null;
  const timezone = body.timezone || "Asia/Kolkata";

  if (!preset && !customScheduledFor) {
    return c.json({ error: "Follow-up preset or scheduledFor date is required." }, 400);
  }

  try {
    // 1. Verify request exists and user owns it
    const reqRes = await db.execute({
      sql: "SELECT * FROM requests WHERE id = ? AND user_id = ? LIMIT 1",
      args: [requestId, userId],
    });

    if (!reqRes.rows || reqRes.rows.length === 0) {
      return c.json({ error: "Request not found." }, 404);
    }

    const currentReq = reqRes.rows[0];

    // 2. Reject scheduling for completed or cancelled requests
    if (["completed", "cancelled"].includes(currentReq.status)) {
      return c.json({ error: "Cannot schedule a follow-up for a completed or cancelled request." }, 400);
    }

    // 3. Compute target UTC timestamp
    const scheduledForUtc = computeFollowUpUtc(preset, customScheduledFor, timezone);

    // 4. Cancel any existing active pending follow-up for this request
    await db.execute({
      sql: `UPDATE request_follow_ups 
            SET status = 'cancelled', skip_reason = 'rescheduled', updated_at = datetime('now')
            WHERE request_id = ? AND status = 'pending'`,
      args: [requestId],
    });

    // 5. Insert new active pending follow-up
    const followUpId = "rfu_" + crypto.randomUUID();
    await db.execute({
      sql: `INSERT INTO request_follow_ups (
              id, request_id, user_id, contact_id, preset, scheduled_for_utc, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'pending', datetime('now'), datetime('now'))`,
      args: [followUpId, requestId, userId, currentReq.contact_id, preset || "custom", scheduledForUtc],
    });

    // 6. If request is 'open', transition to 'waiting_on_them'
    let newRequestStatus = currentReq.status;
    if (currentReq.status === "open") {
      newRequestStatus = "waiting_on_them";
      await db.execute({
        sql: "UPDATE requests SET status = 'waiting_on_them', updated_at = datetime('now') WHERE id = ?",
        args: [requestId],
      });
    }

    // 7. Log Activity
    const actId = "act_" + crypto.randomUUID();
    const presetLabel = preset ? preset.replace(/_/g, " ") : "custom date";
    await db.execute({
      sql: `INSERT INTO activities (id, user_id, contact_id, request_id, activity_type, title, description, metadata, created_at)
            VALUES (?, ?, ?, ?, 'follow_up_scheduled', 'Follow-Up Scheduled', ?, ?, datetime('now'))`,
      args: [
        actId,
        userId,
        currentReq.contact_id,
        requestId,
        `Follow-up set for ${presetLabel}`,
        JSON.stringify({ followUpId, preset, scheduled_for_utc: scheduledForUtc, timezone }),
      ],
    });

    return c.json({
      success: true,
      followUp: {
        id: followUpId,
        requestId,
        contactId: currentReq.contact_id,
        preset: preset || "custom",
        scheduledForUtc,
        status: "pending",
      },
      requestStatus: newRequestStatus,
    }, 201);
  } catch (err) {
    console.error("handleSetRequestFollowUp error:", err);
    return c.json({ error: "Failed to schedule follow-up", details: err.message }, 500);
  }
}

/**
 * POST /api/requests/:id/follow-up/clear
 * Cancels any active pending follow-up reminder for a request.
 */
export async function handleClearRequestFollowUp(c) {
  const db = getDbClient(c.env);
  const user = c.get("user");
  const userId = user?.id || user?.user_id || user?.sub;
  const requestId = c.req.param("id");

  try {
    const reqRes = await db.execute({
      sql: "SELECT * FROM requests WHERE id = ? AND user_id = ? LIMIT 1",
      args: [requestId, userId],
    });

    if (!reqRes.rows || reqRes.rows.length === 0) {
      return c.json({ error: "Request not found." }, 404);
    }

    const currentReq = reqRes.rows[0];

    const cancelRes = await db.execute({
      sql: `UPDATE request_follow_ups 
            SET status = 'cancelled', skip_reason = 'user_cleared', updated_at = datetime('now')
            WHERE request_id = ? AND status = 'pending'`,
      args: [requestId],
    });

    const rowsAffected = cancelRes?.rowsAffected ?? cancelRes?.changes ?? cancelRes?.meta?.changes ?? 0;

    if (rowsAffected > 0) {
      const actId = "act_" + crypto.randomUUID();
      await db.execute({
        sql: `INSERT INTO activities (id, user_id, contact_id, request_id, activity_type, title, description, metadata, created_at)
              VALUES (?, ?, ?, ?, 'follow_up_cancelled', 'Follow-Up Cleared', ?, ?, datetime('now'))`,
        args: [
          actId,
          userId,
          currentReq.contact_id,
          requestId,
          `Follow-up cancelled for ${currentReq.title}`,
          JSON.stringify({ requestId }),
        ],
      });
    }

    return c.json({ success: true, cleared: rowsAffected > 0 });
  } catch (err) {
    console.error("handleClearRequestFollowUp error:", err);
    return c.json({ error: "Failed to clear follow-up", details: err.message }, 500);
  }
}

/**
 * Inbound Request Reply Event Handler:
 * When a contact replies (via WhatsApp or Gmail), transitions the associated request to 'waiting_on_me'
 * and cancels any pending follow-up with skip_reason = 'request_replied'.
 */
export async function handleInboundRequestReply(db, requestId, userId, contactId) {
  if (!requestId) return { updated: false };

  try {
    const reqRes = await db.execute({
      sql: "SELECT id, user_id, contact_id, title, status FROM requests WHERE id = ? LIMIT 1",
      args: [requestId],
    });

    if (!reqRes.rows || reqRes.rows.length === 0) return { updated: false };

    const req = reqRes.rows[0];
    const resolvedUserId = userId || req.user_id;
    const resolvedContactId = contactId || req.contact_id;

    if (["waiting_on_them", "needs_follow_up", "open"].includes(req.status)) {
      await db.execute({
        sql: "UPDATE requests SET status = 'waiting_on_me', updated_at = datetime('now') WHERE id = ?",
        args: [requestId],
      });

      // Cancel any active pending follow-up
      await db.execute({
        sql: `UPDATE request_follow_ups 
              SET status = 'cancelled', skip_reason = 'request_replied', updated_at = datetime('now')
              WHERE request_id = ? AND status = 'pending'`,
        args: [requestId],
      });

      // Log request status transition activity
      const actId = "act_" + crypto.randomUUID();
      await db.execute({
        sql: `INSERT INTO activities (
                id, user_id, contact_id, request_id, activity_type, title, description, metadata, created_at
              ) VALUES (?, ?, ?, ?, 'request_status_updated', 'Request Waiting on Me (Inbound Reply)', ?, ?, datetime('now'))`,
        args: [
          actId,
          resolvedUserId,
          resolvedContactId,
          requestId,
          `Reply received on request: ${req.title}`,
          JSON.stringify({ previous_status: req.status, new_status: "waiting_on_me", trigger: "inbound_reply" }),
        ],
      });

      return { updated: true, requestId };
    }

    return { updated: false, currentStatus: req.status };
  } catch (err) {
    console.error("handleInboundRequestReply error:", err);
    return { updated: false, error: err.message };
  }
}

/**
 * PATCH /api/requests/:requestId/items/:itemId
 * Marks a request item as pending, done, or waived.
 */
export async function handleUpdateRequestItem(c) {
  const db = getDbClient(c.env);
  const user = c.get("user");
  const userId = user.id;
  const requestId = c.req.param("requestId");
  const itemId = c.req.param("itemId");

  const body = await c.req.json().catch(() => ({}));
  const status = String(body.status || "").trim().toLowerCase();

  if (!VALID_ITEM_STATUSES.includes(status)) {
    return c.json({
      error: `Invalid item status. Must be one of: ${VALID_ITEM_STATUSES.join(", ")}`,
    }, 400);
  }

  try {
    // Verify request ownership
    const reqRes = await db.execute({
      sql: "SELECT * FROM requests WHERE id = ? AND user_id = ? LIMIT 1",
      args: [requestId, userId],
    });

    if (reqRes.rows.length === 0) {
      return c.json({ error: "Request not found." }, 404);
    }

    const currentReq = reqRes.rows[0];

    const res = await db.execute({
      sql: "UPDATE request_items SET status = ?, updated_at = datetime('now') WHERE id = ?",
      args: [status, itemId],
    });

    if (res.rowsAffected === 0) {
      return c.json({ error: "Request item not found." }, 404);
    }

    // Log Activity
    const actId = "act_" + crypto.randomUUID();
    await db.execute({
      sql: `INSERT INTO activities (id, user_id, contact_id, request_id, activity_type, title, description, metadata, created_at)
            VALUES (?, ?, ?, ?, 'request_item_done', 'Item Updated', ?, ?, datetime('now'))`,
      args: [actId, userId, currentReq.contact_id, requestId, `Item marked ${status}`, JSON.stringify({ itemId, status })],
    });

    return c.json({ success: true, itemId, status });
  } catch (err) {
    console.error("handleUpdateRequestItem error:", err);
    return c.json({ error: "Failed to update request item", details: err.message }, 500);
  }
}

/**
 * POST /api/requests/:id/items
 * Adds a new checklist item to an existing request.
 */
export async function handleAddRequestItem(c) {
  const db = getDbClient(c.env);
  const user = c.get("user");
  const userId = user.id;
  const requestId = c.req.param("id");

  const body = await c.req.json().catch(() => ({}));
  const title = String(body.title || "").trim();

  if (!title) {
    return c.json({ error: "Item title is required." }, 400);
  }

  try {
    const reqRes = await db.execute({
      sql: "SELECT * FROM requests WHERE id = ? AND user_id = ? LIMIT 1",
      args: [requestId, userId],
    });

    if (reqRes.rows.length === 0) {
      return c.json({ error: "Request not found." }, 404);
    }

    const itemId = "itm_" + crypto.randomUUID();
    await db.execute({
      sql: `INSERT INTO request_items (id, request_id, title, status, created_at, updated_at)
            VALUES (?, ?, ?, 'pending', datetime('now'), datetime('now'))`,
      args: [itemId, requestId, title],
    });

    return c.json({
      success: true,
      item: { id: itemId, requestId, title, status: "pending" },
    }, 201);
  } catch (err) {
    console.error("handleAddRequestItem error:", err);
    return c.json({ error: "Failed to add request item", details: err.message }, 500);
  }
}
