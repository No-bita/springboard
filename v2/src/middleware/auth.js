import { verify } from "hono/jwt";

/**
 * Authentication Middleware (JWT & Local Dev Bypass).
 */
export const authMiddleware = async (c, next) => {
  const isDev =
    c.env.ENVIRONMENT === "development" ||
    c.req.url.includes("localhost") ||
    c.req.url.includes("127.0.0.1");
  const authHeader = c.req.header("Authorization");
  if (isDev && (!authHeader || authHeader === "Bearer dev_token" || authHeader === "dev_token")) {
    c.set("user", { id: "dev-user-1", user_id: "dev-user-1", username: "DevAgent", role: "admin" });
    return next();
  }

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json({ error: "Unauthorized access. Please log in." }, 401);
  }

  const token = authHeader.split(" ")[1];

  try {
    const secret = c.env.JWT_SECRET || "default_unsafe_secret_for_dev_only";
    const payload = await verify(token, secret, "HS256");
    c.set("user", payload);
    return next();
  } catch (err) {
    return c.json({ error: "Invalid or expired session. Please log in again." }, 401);
  }
};

/**
 * Admin Role Verification Middleware.
 */
export const adminOnlyMiddleware = async (c, next) => {
  const user = c.get("user");
  if (!user || user.role !== "admin") {
    return c.json({ error: "Access denied. Admin role required." }, 403);
  }
  return next();
};
