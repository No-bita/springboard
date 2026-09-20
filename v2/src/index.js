import { Hono } from "hono";

import { handleLogin, handleRegister } from "./api/auth.js";
import { handleWebhookVerify, handleWebhookEvent } from "./api/webhook.js";
import {
  handleGetContacts,
  handleCreateContact,
  handleGetContactWorkspace,
  handleUpdateContact,
  handleDeleteContact,
  handleCheckContactPhone,
} from "./api/contacts.js";
import {
  handleSendContactText,
  handleSendContactTemplate,
  handleSendMessage,
} from "./api/conversations.js";
import {
  handleCreateRequest,
  handleUpdateRequestStatus,
  handleUpdateRequestItem,
  handleAddRequestItem,
} from "./api/requests.js";
import {
  handleGetContactActivities,
  handleAddContactNote,
} from "./api/activities.js";
import {
  handleGetCredits,
  handleRechargeCredits,
  handleAdminAdjustCredits,
} from "./api/credits.js";
import {
  handleGetTemplates,
  handleCreateTemplate,
  handleDeleteTemplate,
} from "./api/templates.js";
import {
  handleCreateSchedule,
  handleGetSchedules,
  handleCancelSchedule,
  handleRetryOccurrence,
} from "./api/schedules.js";
import {
  handleGetAdminAnalyticsData,
  handleGetAdminAnalyticsDashboard,
  handleGetAdminFailures,
  handleDeleteAdminFailure,
  handleClearAllFailures,
} from "./api/admin.js";

import { handleSessionRequest } from "./api/session.js";
import { handleUploadUrlRequest, handleDirectUpload } from "./api/upload.js";
import { handleBulkImportCases, handleBulkPrecheck } from "./api/cases.js";

import { scanAndClaimDueOccurrences } from "./scheduler/scanner.js";
import { processScheduledOccurrence, handleQueueBatch } from "./scheduler/consumer.js";
import { getDbClient } from "./db/client.js";
import { authMiddleware, adminOnlyMiddleware } from "./middleware/auth.js";
import { corsMiddleware } from "./middleware/cors.js";

const app = new Hono();

app.use("*", corsMiddleware);

// Auth API Endpoints
app.post("/api/auth/login", handleLogin);
app.post("/api/auth/register", handleRegister);

// Application Redirects
app.get("/app", (c) => c.redirect("/dashboard.html"));
app.get("/dashboard", (c) => c.redirect("/dashboard.html"));
app.get("/early-access", (c) => c.redirect("/register.html"));

// Health Check API
app.get("/api/health", (c) => c.text("Collectr Personal CRM API Running"));

// Public Webhook Routes (Meta WhatsApp)
app.get("/api/webhook", handleWebhookVerify);
app.post("/api/webhook", handleWebhookEvent);

// Public Upload & Session Routes
app.get("/api/session/:token", handleSessionRequest);
app.post("/api/upload-url/:token", handleUploadUrlRequest);
app.post("/api/direct-upload/:token", handleDirectUpload);

// Protected API Routes (Requires Auth Credentials)
app.use("/api/contacts", authMiddleware);
app.use("/api/contacts/*", authMiddleware);
app.use("/api/cases", authMiddleware);
app.use("/api/cases/*", authMiddleware);
app.use("/api/requests/*", authMiddleware);
app.use("/api/schedules", authMiddleware);
app.use("/api/schedules/*", authMiddleware);
app.use("/api/templates", authMiddleware);
app.use("/api/user/*", authMiddleware);
app.use("/api/admin/*", authMiddleware, adminOnlyMiddleware);

// Contacts Endpoints
app.get("/api/contacts", handleGetContacts);
app.post("/api/contacts", handleCreateContact);
app.post("/api/contacts/check", handleCheckContactPhone);
app.get("/api/contacts/:id", handleGetContactWorkspace);
app.patch("/api/contacts/:id", handleUpdateContact);
app.delete("/api/contacts/:id", handleDeleteContact);

// Conversations & Messaging Endpoints
app.post("/api/contacts/:id/messages", handleSendMessage);
app.post("/api/contacts/:id/messages/text", handleSendContactText);
app.post("/api/contacts/:id/messages/template", handleSendContactTemplate);

// Requests Endpoints
app.post("/api/contacts/:id/requests", handleCreateRequest);
app.patch("/api/requests/:id/status", handleUpdateRequestStatus);
app.post("/api/requests/:id/items", handleAddRequestItem);
app.patch("/api/requests/:requestId/items/:itemId", handleUpdateRequestItem);

// Activities Endpoints
app.get("/api/contacts/:id/activities", handleGetContactActivities);
app.post("/api/contacts/:id/activities/note", handleAddContactNote);

// Message Templates Endpoints
app.get("/api/templates", handleGetTemplates);
app.post("/api/admin/templates", handleCreateTemplate);
app.delete("/api/admin/templates/:id", handleDeleteTemplate);

// Schedules Endpoints
app.get("/api/schedules", handleGetSchedules);
app.post("/api/schedules", handleCreateSchedule);
app.delete("/api/schedules/:id", handleCancelSchedule);
app.post("/api/schedules/occurrences/:id/retry", handleRetryOccurrence);

// User Credits Endpoints
app.get("/api/user/credits", handleGetCredits);
app.post("/api/user/recharge", handleRechargeCredits);
app.post("/api/admin/credits/adjust", handleAdminAdjustCredits);

// Admin Analytics Endpoints
app.get("/api/admin/analytics", handleGetAdminAnalyticsData);
app.get("/api/admin/analytics/dashboard", handleGetAdminAnalyticsDashboard);
app.get("/api/admin/failures", handleGetAdminFailures);
app.delete("/api/admin/failures/:id", handleDeleteAdminFailure);
app.post("/api/admin/failures/clear", handleClearAllFailures);

// Backward Compatibility Aliases for Frontend
app.get("/api/cases", handleGetContacts);
app.get("/api/cases/:id", handleGetContactWorkspace);
app.post("/api/cases", handleCreateContact);
app.patch("/api/cases/:id/status", handleUpdateContact);
app.post("/api/cases/bulk-import", handleBulkImportCases);
app.post("/api/cases/bulk-precheck", handleBulkPrecheck);
app.get("/api/user/profile", async (c) => {
  const user = c.get("user");
  const db = getDbClient(c.env);
  const res = await db.execute({ sql: "SELECT id, username, role, credit_balance FROM users WHERE id = ?", args: [user.id] });
  return c.json({ success: true, user: res.rows[0] || user });
});

app.scheduled = async (event, env, ctx) => {
  const db = getDbClient(env);
  try {
    await scanAndClaimDueOccurrences(env, db);
  } catch (err) {
    console.error("[CRON] Scanner execution error:", err);
  }
};

app.queue = async (batch, env, ctx) => {
  const db = getDbClient(env);
  await handleQueueBatch(batch, env, ctx, db);
};

export { app };
export default app;

