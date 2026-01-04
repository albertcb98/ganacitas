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
  const { email, password } = await request.json().catch(() => ({}));
  if (!email || !password || password.length < 8) {
    return json({ error: "Email y contraseña (mín. 8 caracteres) requeridos" }, 400);
  }

  const now = new Date().toISOString();
  const id = newId();
  const password_hash = await hashPassword(password);

  try {
    await env.DB.prepare(
      `INSERT INTO users (id, email, password_hash, auth_provider, paid_status, created_at, updated_at)
       VALUES (?, ?, ?, 'password', 'free', ?, ?)`
    ).bind(id, email.toLowerCase().trim(), password_hash, now, now).run();
  } catch (e) {
    // likely UNIQUE email
    return json({ error: "Ese email ya existe. Inicia sesión." }, 409);
  }

  const token = await signJWT(env.JWT_SECRET, { sub: id, email });
  return json(
    { ok: true },
    200,
    { "Set-Cookie": setCookie("session", token) }
  );
}
