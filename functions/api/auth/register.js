// functions/api/auth/register.js

import { hashPassword } from "../_lib/password.js";
import { signJWT } from "../_lib/jwt.js";
import { setCookie } from "../_lib/cookies.js";

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

function newId() {
  return crypto.randomUUID();
}

export async function onRequestPost({ request, env }) {
  // 🔒 HARD GUARDS (prevent Cloudflare 1101)
  if (!env.DB) {
    return json({ error: "DB binding missing" }, 500);
  }
  if (!env.JWT_SECRET) {
    return json({ error: "JWT_SECRET missing" }, 500);
  }

  const body = await request.json().catch(() => null);
  if (!body?.email || !body?.password) {
    return json(
      { error: "Email y contraseña requeridos" },
      400
    );
  }

  const email = body.email.toLowerCase().trim();
  const password = body.password;

  if (password.length < 8) {
    return json(
      { error: "La contraseña debe tener al menos 8 caracteres" },
      400
    );
  }

  const id = newId();
  const now = new Date().toISOString();

  let password_hash;
  try {
    password_hash = await hashPassword(password);
  } catch (e) {
    console.log("PASSWORD HASH ERROR:", e);
    return json({ error: "Error al procesar la contraseña" }, 500);
  }

  try {
    await env.DB.prepare(
      `INSERT INTO users (
        id,
        email,
        password_hash,
        auth_provider,
        paid_status,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id,
      email,
      password_hash,
      "password",
      "free",
      now,
      now
    ).run();
  } catch (e) {
    console.log("REGISTER SQL ERROR:", e);

    // UNIQUE constraint (email already exists)
    if (String(e).includes("UNIQUE")) {
      return json(
        { error: "Ese email ya existe. Inicia sesión." },
        409
      );
    }

    return json(
      { error: "No se pudo crear la cuenta" },
      500
    );
  }

  let token;
  try {
    token = await signJWT(env.JWT_SECRET, { sub: id, email });
  } catch (e) {
    console.log("JWT ERROR:", e);
    return json({ error: "Error de sesión" }, 500);
  }
const secure = true;
  return json(
    { ok: true },
    200,
    {
      "Set-Cookie": setCookie("session", token, {
        secure,
        maxAge: 60 * 60 * 24 * 7, // 7 days
        sameSite: "Lax",
        path: "/",
      }),
    }
  );
}
