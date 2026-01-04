// functions/api/auth/reset-password.js
// POST { token, newPassword }
// Validates token, hashes new password, updates users, marks token used.
// Includes JSON debug output (toggle DEBUG_ERRORS).

import { hashPassword } from "../_lib/password.js";

const DEBUG_ERRORS = false; // <-- set to false after you fix the issue

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

function debugPayload(e) {
  if (!DEBUG_ERRORS) return {};
  return {
    debug: {
      name: e?.name,
      message: e?.message,
      stack: e?.stack,
      asString: (() => {
        try { return String(e); } catch { return null; }
      })(),
    },
  };
}

export async function onRequestPost({ request, env }) {
  // Ultimate safety net: NEVER throw out of this handler
  try {
    if (!env.DB) return json({ error: "DB binding missing" }, 500);

    const body = await request.json().catch(() => null);

    const token =
      typeof body?.token === "string" ? body.token.trim() : "";

    const newPassword =
      typeof body?.newPassword === "string" ? body.newPassword : "";

    if (!token) return json({ error: "Token inválido" }, 400);
    if (newPassword.length < 8) {
      return json({ error: "La contraseña debe tener al menos 8 caracteres" }, 400);
    }

    const now = Math.floor(Date.now() / 1000);

    // Hash token
    let tokenHash;
    try {
      tokenHash = await sha256Hex(token);
    } catch (e) {
      return json({ error: "Token inválido", ...debugPayload(e) }, 400);
    }

    // Load reset row
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
      return json({ error: "Error al validar el token", ...debugPayload(e) }, 500);
    }

    if (!row) return json({ error: "Token inválido o caducado" }, 400);
    if (row.used_at) return json({ error: "Este enlace ya fue usado" }, 400);
    if (row.expires_at <= now) return json({ error: "Token caducado" }, 400);

    // Hash new password (your failing step)
    let newHash;
    try {
      newHash = await hashPassword(newPassword);
    } catch (e) {
      return json({ error: "Error al procesar la contraseña", ...debugPayload(e) }, 500);
    }

    // Update user + mark token used
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
      return json({ error: "No se pudo actualizar la contraseña", ...debugPayload(e) }, 500);
    }

    return json({ ok: true }, 200);

  } catch (e) {
    // Any unexpected error still returns JSON (never CF 1101)
    return json({ error: "Error interno", ...debugPayload(e) }, 500);
  }
}
