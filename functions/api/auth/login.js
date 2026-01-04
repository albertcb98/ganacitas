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
  const { email, password } = await request.json().catch(() => ({}));
  if (!email || !password) return json({ error: "Credenciales incompletas" }, 400);

  // Allow local http dev to set cookies; keep Secure on https.
  const isHttps = new URL(request.url).protocol === "https:";

  const row = await env.DB.prepare(
    "SELECT id, email, password_hash FROM users WHERE email = ?"
  ).bind(email.toLowerCase().trim()).first();

  if (!row || !row.password_hash) {
    return json({ error: "Credenciales incorrectas" }, 401);
  }

  const ok = await verifyPassword(password, row.password_hash);
  if (!ok) return json({ error: "Credenciales incorrectas" }, 401);

  const token = await signJWT(env.JWT_SECRET, { sub: row.id, email: row.email });
  return json(
    { ok: true },
    200,
    {
      "Set-Cookie": setCookie("session", token, {
        secure: isHttps,
        maxAge: 60 * 60 * 24 * 7, // 7 days
      }),
    }
  );
}
