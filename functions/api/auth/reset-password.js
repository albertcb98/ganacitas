// functions/api/auth/reset-password.js

import { hashPassword } from "../_lib/password.js";

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

function toHex(buf) {
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(str) {
  const data = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return toHex(digest);
}

export async function onRequestPost({ request, env }) {
  // 🔒 Guards to prevent Cloudflare 1101
  if (!env.DB) {
    return json({ error: "DB binding missing" }, 500);
  }

  const body = await request.json().catch(() => null);
  const token = body?.token?.trim();
 const newPassword = typeof body?.newPassword === "string"
  ? body.newPassword
  : "";
console.log("RESET password type:", typeof newPassword);

  if (!token) {
    return json({ error: "Token inválido" }, 400);
  }
  if (!newPassword || newPassword.length < 8) {
    return json(
      { error: "La contraseña debe tener al menos 8 caracteres" },
      400
    );
  }

  const now = Math.floor(Date.now() / 1000);

  let tokenHash;
  try {
    tokenHash = await sha256Hex(token);
  } catch (e) {
    console.log("TOKEN HASH ERROR:", e);
    return json({ error: "Token inválido" }, 400);
  }

  let row;
  try {
    row = await env.DB.prepare(
      `SELECT id, user_id, expires_at, used_at
       FROM password_resets
       WHERE token_hash = ?
       ORDER BY created_at DESC
       LIMIT 1`
    ).bind(tokenHash).first();
  } catch (e) {
    console.log("RESET SELECT ERROR:", e);
    return json({ error: "Error al validar el token" }, 500);
  }

  if (!row) {
    return json({ error: "Token inválido o caducado" }, 400);
  }
  if (row.used_at) {
    return json({ error: "Este enlace ya fue usado" }, 400);
  }
  if (row.expires_at <= now) {
    return json({ error: "Token caducado" }, 400);
  }

  let newHash;
  try {
    newHash = await hashPassword(newPassword);
  } catch (e) {
    console.log("PASSWORD HASH ERROR:", e);
    return json({ error: "Error al procesar la contraseña" }, 500);
  }

  try {
    await env.DB.prepare(
      "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?"
    ).bind(
      newHash,
      new Date().toISOString(),
      row.user_id
    ).run();

    await env.DB.prepare(
      "UPDATE password_resets SET used_at = ? WHERE id = ?"
    ).bind(
      now,
      row.id
    ).run();
  } catch (e) {
    console.log("RESET UPDATE ERROR:", e);
    return json({ error: "No se pudo actualizar la contraseña" }, 500);
  }

  return json({ ok: true }, 200);
}
