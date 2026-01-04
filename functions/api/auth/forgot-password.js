// functions/api/auth/forgot-password.js
// POST { email }
// Always returns { ok: true } to prevent user enumeration.
// If RESEND_API_KEY is set, sends reset email via Resend; otherwise logs link.

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

function base64url(bytes) {
  let str = btoa(String.fromCharCode(...bytes));
  return str.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(str) {
  const data = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return toHex(digest);
}

function getBaseUrl(request, env) {
  // Prefer explicit env in production (recommended):
  // APP_BASE_URL = https://ganacitas.pages.dev
  if (env.APP_BASE_URL && typeof env.APP_BASE_URL === "string") {
    return env.APP_BASE_URL.replace(/\/+$/, "");
  }
  return new URL(request.url).origin;
}

async function sendResetEmail({ env, toEmail, resetUrl }) {
  // Resend optional:
  // RESEND_API_KEY, FROM_EMAIL, FROM_NAME (optional)
  if (!env.RESEND_API_KEY || !env.FROM_EMAIL) {
    console.log(`[password-reset] (no email provider) Reset link for ${toEmail}: ${resetUrl}`);
    return;
  }

  const fromName = env.FROM_NAME || "GanaCitas";
  const payload = {
    from: `${fromName} <${env.FROM_EMAIL}>`,
    to: [toEmail],
    subject: "Restablecer contraseña",
    text:
      `Has solicitado restablecer tu contraseña.\n\n` +
      `Abre este enlace para continuar:\n${resetUrl}\n\n` +
      `Si no fuiste tú, puedes ignorar este email.`,
  };

  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!r.ok) {
    const errText = await r.text().catch(() => "");
    console.log("[password-reset] Resend failed:", r.status, errText);
  }
}

export async function onRequestPost({ request, env }) {
  // Guardrails to avoid Cloudflare 1101 mystery crashes
  if (!env.DB) return json({ error: "DB binding missing" }, 500);

  const { email } = await request.json().catch(() => ({}));
  const normalized = (email || "").toLowerCase().trim();

  // Always respond ok (no enumeration). Still validate input lightly.
  if (!normalized || !normalized.includes("@")) {
    return json({ ok: true }, 200);
  }

  // Find user (if exists)
  const user = await env.DB.prepare(
    "SELECT id, email FROM users WHERE email = ?"
  ).bind(normalized).first();

  if (!user) {
    // Still return ok
    return json({ ok: true }, 200);
  }

  // Create a secure random token and store only a hash
  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const token = base64url(tokenBytes);
  const tokenHash = await sha256Hex(token);

  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + 60 * 60; // 1 hour

  await env.DB.prepare(
    `INSERT INTO password_resets (id, user_id, token_hash, expires_at, used_at, created_at)
     VALUES (?, ?, ?, ?, NULL, ?)`
  ).bind(id, user.id, tokenHash, expiresAt, now).run();

  const base = getBaseUrl(request, env);
  const resetUrl = `${base}/reset-password/?token=${encodeURIComponent(token)}`;

  await sendResetEmail({ env, toEmail: user.email, resetUrl });

  return json({ ok: true }, 200);
}
