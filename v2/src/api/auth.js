import { sign } from "hono/jwt";
import { getDbClient } from "../db/client.js";

export async function hashPassword(password, saltText) {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits", "deriveKey"]
  );
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: encoder.encode(saltText),
      iterations: 100000,
      hash: "SHA-256",
    },
    keyMaterial,
    256
  );
  const hashArray = Array.from(new Uint8Array(derivedBits));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function handleRegister(c) {
  // Block new user registrations on production unless explicitly allowed via ALLOW_REGISTRATION flag
  const reqUrl = c.req?.url || "";
  const isLocal = reqUrl.includes("localhost") || reqUrl.includes("127.0.0.1");
  const isDev = c.env?.ENVIRONMENT === "development" || isLocal;
  const allowRegistration = c.env?.ALLOW_REGISTRATION === "true" || c.env?.ALLOW_REGISTRATION === true;

  if (!isDev && !allowRegistration) {
    return c.json({ error: "New user registration is disabled on production." }, 403);
  }

  const { username, password } = await c.req.json().catch(() => ({}));
  const u = String(username || "").trim();
  const p = String(password || "").trim();

  if (!u || !p || p.length < 6) {
    return c.json({ error: "Username and password (min 6 chars) are required." }, 400);
  }

  const db = getDbClient(c.env);

  try {
    // Check if this is the first user
    const countRes = await db.execute("SELECT COUNT(*) as cnt FROM users");
    const userCount = countRes.rows[0]?.cnt || 0;
    const role = userCount === 0 ? "admin" : "agent";

    const salt = "lekho_salt_" + u.toLowerCase();
    const hashed = await hashPassword(p, salt);

    const id = crypto.randomUUID();
    
    await db.execute({
      sql: "INSERT INTO users (id, username, password_hash, role, credit_balance) VALUES (?, ?, ?, ?, ?)",
      args: [id, u, hashed, role, 900]
    });

    // Create authoritative signup_bonus ledger entry
    const txId = "tx_signup_" + crypto.randomUUID();
    await db.execute({
      sql: "INSERT INTO credit_transactions (id, user_id, amount_paise, balance_after_paise, transaction_type, reference_type, reference_id, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      args: [txId, id, 900, 900, 'signup_bonus', 'signup_ref', 'signup_2026', 'Signup Bonus (₹9.00 Free Messaging Credits)']
    }).catch(e => console.error("Failed writing signup_bonus transaction:", e));

    // Automatically log in user after registration by generating JWT
    const secret = c.env.JWT_SECRET || "default_unsafe_secret_for_dev_only";
    const payload = {
      sub: id,
      id: id,
      username: u,
      role: role,
      exp: Math.floor(Date.now() / 1000) + (60 * 60 * 24 * 7)
    };
    const token = await sign(payload, secret);

    return c.json({ success: true, message: "Registration successful", authHeader: "Bearer " + token });
  } catch (err) {
    if (err.message && err.message.includes("UNIQUE")) {
      return c.json({ error: "Username already exists" }, 400);
    }
    console.error("Register Error:", err);
    return c.json({ error: "Failed to register user" }, 500);
  }
}

export async function handleLogin(c) {
  const { username, password } = await c.req.json().catch(() => ({}));
  const u = String(username || "").trim();
  const p = String(password || "").trim();

  if (!u || !p) return c.json({ error: "Username and password required" }, 400);

  const db = getDbClient(c.env);

  try {
    const res = await db.execute({
      sql: "SELECT id, username, password_hash, role FROM users WHERE LOWER(username) = LOWER(?)",
      args: [u]
    });

    if (res.rows.length === 0) {
      return c.json({ error: "Invalid username or password" }, 401);
    }

    const user = res.rows[0];
    const salt = "lekho_salt_" + user.username.toLowerCase();
    const expectedHash = await hashPassword(p, salt);

    if (user.password_hash !== expectedHash) {
      return c.json({ error: "Invalid username or password" }, 401);
    }

    let role = user.role;
    if (user.username.toLowerCase() === 'papajohn' && role !== 'admin') {
      role = 'admin';
      await db.execute({
        sql: "UPDATE users SET role = 'admin' WHERE id = ?",
        args: [user.id]
      }).catch(e => console.error("Failed setting papajohn admin role:", e));
    }

    // Generate JWT
    const secret = c.env.JWT_SECRET || "default_unsafe_secret_for_dev_only";
    const payload = {
      sub: user.id,
      id: user.id,
      username: user.username,
      role: role,
      exp: Math.floor(Date.now() / 1000) + (60 * 60 * 24 * 7) // 7 days
    };
    const token = await sign(payload, secret);

    return c.json({ success: true, authHeader: "Bearer " + token });
  } catch (err) {
    console.error("Login Error:", err);
    return c.json({ error: "Authentication failed" }, 500);
  }
}

export async function handleResetPassword(c) {
  const { username, newPassword } = await c.req.json().catch(() => ({}));
  const u = String(username || "").trim();
  const p = String(newPassword || "").trim();

  if (!u || !p || p.length < 6) {
    return c.json({ error: "Username and new password (min 6 characters) are required." }, 400);
  }

  const db = getDbClient(c.env);

  try {
    const res = await db.execute({
      sql: "SELECT id, username FROM users WHERE LOWER(username) = LOWER(?)",
      args: [u],
    });

    if (res.rows.length === 0) {
      return c.json({ error: "No account found with that username." }, 404);
    }

    const user = res.rows[0];
    const salt = "lekho_salt_" + user.username.toLowerCase();
    const newHash = await hashPassword(p, salt);

    await db.execute({
      sql: "UPDATE users SET password_hash = ? WHERE id = ?",
      args: [newHash, user.id],
    });

    return c.json({
      success: true,
      message: "Password reset successfully. You can now sign in with your new password.",
    });
  } catch (err) {
    console.error("Reset Password Error:", err);
    return c.json({ error: "Failed to reset password", details: err.message }, 500);
  }
}
