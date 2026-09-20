import { getDbClient } from "../db/client.js";

/**
 * GET /api/contacts/:id/activities
 * Returns the activity stream for a contact.
 */
export async function handleGetContactActivities(c) {
  const db = getDbClient(c.env);
  const user = c.get("user");
  const userId = user.id;
  const contactId = c.req.param("id");

  try {
    const res = await db.execute({
      sql: `SELECT a.*, r.title as request_title 
            FROM activities a
            LEFT JOIN requests r ON r.id = a.request_id
            WHERE a.contact_id = ? AND a.user_id = ?
            ORDER BY a.created_at DESC LIMIT 100`,
      args: [contactId, userId],
    });

    return c.json({ success: true, activities: res.rows || [] });
  } catch (err) {
    console.error("handleGetContactActivities error:", err);
    return c.json({ error: "Failed to fetch activities", details: err.message }, 500);
  }
}

/**
 * POST /api/contacts/:id/activities/note
 * Adds a manual internal note to a contact.
 */
export async function handleAddContactNote(c) {
  const db = getDbClient(c.env);
  const user = c.get("user");
  const userId = user.id;
  const contactId = c.req.param("id");

  const body = await c.req.json().catch(() => ({}));
  const note = String(body.note || body.content || "").trim();
  const requestId = body.requestId || null;

  if (!note) {
    return c.json({ error: "Note content cannot be empty." }, 400);
  }

  try {
    // Verify contact ownership
    const contactRes = await db.execute({
      sql: "SELECT id FROM contacts WHERE id = ? AND user_id = ? LIMIT 1",
      args: [contactId, userId],
    });

    if (contactRes.rows.length === 0) {
      return c.json({ error: "Contact not found." }, 404);
    }

    const activityId = "act_" + crypto.randomUUID();
    await db.execute({
      sql: `INSERT INTO activities (id, user_id, contact_id, request_id, activity_type, title, description, metadata, created_at)
            VALUES (?, ?, ?, ?, 'note_added', 'Internal Note', ?, ?, datetime('now'))`,
      args: [activityId, userId, contactId, requestId, note, JSON.stringify({ author: user.username || "User" })],
    });

    // Update contact's last_interaction_at
    await db.execute({
      sql: "UPDATE contacts SET last_interaction_at = datetime('now'), last_updated = datetime('now') WHERE id = ?",
      args: [contactId],
    });

    return c.json({
      success: true,
      activity: {
        id: activityId,
        activityType: "note_added",
        title: "Internal Note",
        description: note,
        createdAt: new Date().toISOString(),
      },
    }, 201);
  } catch (err) {
    console.error("handleAddContactNote error:", err);
    return c.json({ error: "Failed to add note", details: err.message }, 500);
  }
}
