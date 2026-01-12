import { verifyPassword } from "../_lib/password.js";
import { signJWT } from "../_lib/jwt.js";
import { setCookie } from "../_lib/cookies.js";

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

export async function onRequestPost({ request, env }) {
  // 1️⃣ Parse body
  const { email, password } = await request.json().catch(() => ({}));
  if (!email || !password) {
    return json({ error: "Credenciales incompletas" }, 400);
  }

  // 2️⃣ ENV GUARDS (ADD HERE 👇)
  if (!env.DB) {
    return json({ error: "DB binding missing" }, 500);
  }
  if (!env.JWT_SECRET) {
    return json({ error: "JWT_SECRET missing" }, 500);
  }

  // 3️⃣ Normalize email ONCE (ADD HERE 👇)
  const e = email.toLowerCase().trim();

  // Allow local http dev to set cookies; keep Secure on https.




  // 4️⃣ Use normalized email
  const row = await env.DB.prepare(
    "SELECT id, email, password_hash FROM users WHERE email = ?"
  ).bind(e).first();

  if (!row || !row.password_hash) {
    return json({ error: "Contraseña incorrecta o usuario inexistente" }, 401);
  }

  const ok = await verifyPassword(password, row.password_hash);
  if (!ok) {
    return json({ error: "Contraseña incorrecta o usuario inexistente" }, 401);
  }

  const token = await signJWT(env.JWT_SECRET, {
    sub: row.id,
    email: row.email,
  });
const secure = true; // force secure

  return json(
    { ok: true },
    200,
    {
      "Set-Cookie": setCookie("session", token, {
	secure
        secure: isHttps,
        maxAge: 60 * 60 * 24 * 7, // 7 days
      }),
    }
  );
}

