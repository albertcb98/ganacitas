// functions/api/auth/reset-password.js
// POST { token, newPassword }
// Verifies token hash in D1, updates users.password_hash using your PBKDF2 scheme,
// and marks token as used.

import { hashPassword } from "../_lib/password.js";

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(str) {
  const data = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return toHex(digest);
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ error: "DB binding missing" }, 500);

  const { token, newPassword } = await request.json().catch(() => ({}));
  const t = (token || "").trim();
  const pw = (newPassword || "").toString();

  if (!t) return json({ error: "Token inválido" }, 400);
  if (!pw || pw.length < 8) return json({ error: "La contraseña debe tener al menos 8 caracteres" }, 400);

  const tokenHash = await sha256Hex(t);
  const now = Math.floor(Date.now() / 1000);

  // Find a valid unused reset record
  const row = await env.DB.prepare(
    `SELECT id, user_id, expires_at, used_at
     FROM password_resets
     WHERE token_hash = ?
     ORDER BY created_at DESC
     LIMIT 1`
  ).bind(tokenHash).first();

  if (!row) return json({ error: "Token inválido o caducado" }, 400);
  if (row.used_at) return json({ error: "Este enlace ya fue usado" }, 400);
  if (row.expires_at <= now) return json({ error: "Token caducado" }, 400);

  // Hash new password with your existing scheme
  const newHash = await hashPassword(pw);

  // Transaction-ish sequence
  await env.DB.prepare(
    "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?"
  ).bind(newHash, now, row.user_id).run();

  await env.DB.prepare(
    "UPDATE password_resets SET used_at = ? WHERE id = ?"
  ).bind(now, row.id).run();

  return json({ ok: true }, 200);
}
