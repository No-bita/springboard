import { Hono } from "hono";

import { handleLogin, handleRegister, handleResetPassword } from "./api/auth.js";
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
  handleUpdateTemplate,
  handleDeleteTemplate,
} from "./api/templates.js";
import {
  handleCreateSchedule,
  handleGetSchedules,
  handleCancelSchedule,
  handleRetryOccurrence,
} from "./api/schedules.js";
import {
  handleGetCampaigns,
  handleGetCampaignDetail,
  handleGetCampaignRecipients,
  handleCreateCampaign,
  handleSetCampaignMessages,
  handlePreviewCampaignAudience,
  handleLaunchCampaign,
  handleScheduleCampaign,
  handleCancelCampaign,
} from "./api/campaigns.js";
import {
  handleGetAdminAnalyticsData,
  handleGetAdminAnalyticsDashboard,
  handleGetAdminDashboard,
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
app.post("/api/auth/reset-password", handleResetPassword);
app.post("/api/auth/forgot-password", handleResetPassword);

// Application Pages & Redirects
app.get("/app", (c) => c.redirect("/dashboard.html"));
app.get("/dashboard", (c) => c.redirect("/dashboard.html"));
app.get("/campaigns", (c) => c.redirect("/campaigns.html"));
app.get("/templates", (c) => c.redirect("/templates.html"));
app.get("/early-access", (c) => c.redirect("/register.html"));
app.get("/forgot-password", (c) => c.redirect("/forgot-password.html"));
app.get("/admin", (c) => c.redirect("/admin/analytics"));
app.get("/admin/analytics", handleGetAdminAnalyticsDashboard);
app.get("/analytics", handleGetAdminAnalyticsDashboard);
app.get("/admin/observability", handleGetAdminDashboard);
app.get("/observability", handleGetAdminDashboard);
app.get("/dd", handleGetAdminDashboard);

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
app.use("/api/templates/*", authMiddleware);
app.use("/api/campaigns", authMiddleware);
app.use("/api/campaigns/*", authMiddleware);
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
app.post("/api/templates", handleCreateTemplate);
app.put("/api/templates/:id", handleUpdateTemplate);
app.delete("/api/templates/:id", handleDeleteTemplate);
app.post("/api/admin/templates", handleCreateTemplate);
app.delete("/api/admin/templates/:id", handleDeleteTemplate);

// Campaigns Endpoints
app.get("/api/campaigns", handleGetCampaigns);
app.get("/api/campaigns/:id", handleGetCampaignDetail);
app.get("/api/campaigns/:id/recipients", handleGetCampaignRecipients);
app.post("/api/campaigns", handleCreateCampaign);
app.post("/api/campaigns/:id/messages", handleSetCampaignMessages);
app.post("/api/campaigns/:id/audience/preview", handlePreviewCampaignAudience);
app.post("/api/campaigns/:id/launch", handleLaunchCampaign);
app.post("/api/campaigns/:id/schedule", handleScheduleCampaign);
app.post("/api/campaigns/:id/cancel", handleCancelCampaign);

// Schedules Endpoints
app.get("/api/schedules", handleGetSchedules);
app.post("/api/schedules", handleCreateSchedule);
app.delete("/api/schedules/:id", handleCancelSchedule);
app.post("/api/schedules/occurrences/:id/retry", handleRetryOccurrence);

// User Credits Endpoints
app.get("/api/user/credits", handleGetCredits);
app.post("/api/user/recharge", handleRechargeCredits);
app.post("/api/admin/credits/adjust", handleAdminAdjustCredits);

// Admin Analytics & Observability Endpoints
app.get("/api/admin/analytics", handleGetAdminAnalyticsData);
app.get("/api/admin/analytics/dashboard", handleGetAdminAnalyticsDashboard);
app.get("/api/admin/failures", handleGetAdminFailures);
app.delete("/api/admin/failures", handleClearAllFailures);
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
    await scanAndClaimDueOccurrences(db, env.SCHEDULE_QUEUE);
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

