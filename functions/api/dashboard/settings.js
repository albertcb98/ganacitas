// functions/api/dashboard/settings.js
// POST /api/dashboard/settings

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function nowISO() { return new Date().toISOString(); }

function getCookie(req, name) {
  const h = req.headers.get("Cookie") || "";
  const parts = h.split(";").map(s => s.trim());
  for (const p of parts) {
    if (p.startsWith(name + "=")) return decodeURIComponent(p.slice(name.length + 1));
  }
  return null;
}

function base64urlToBytes(b64url) {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64url.length + 3) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function verifyHS256JWT(token, secret) {
  try {
    const [h, p, s] = token.split(".");
    if (!h || !p || !s) return null;

    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );

    const sigOk = await crypto.subtle.verify(
      "HMAC",
      key,
      base64urlToBytes(s),
      enc.encode(`${h}.${p}`)
    );
    if (!sigOk) return null;

    const payloadJson = new TextDecoder().decode(base64urlToBytes(p));
    const payload = JSON.parse(payloadJson);
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ error: "DB binding missing" }, 500);
  if (!env.JWT_SECRET) return json({ error: "JWT_SECRET missing" }, 500);

  const token = getCookie(request, "session");
  if (!token) return json({ error: "No autorizado" }, 401);

  const payload = await verifyHS256JWT(token, env.JWT_SECRET);
  const userId = payload?.sub;
  if (!userId) return json({ error: "No autorizado" }, 401);

  const body = await request.json().catch(() => ({}));

  const updates = {
    notify_50: body.notify50 == null ? undefined : (body.notify50 ? 1 : 0),
    notify_80: body.notify80 == null ? undefined : (body.notify80 ? 1 : 0),
    auto_topup_enabled: body.autoTopupEnabled == null ? undefined : (body.autoTopupEnabled ? 1 : 0),
    auto_topup_amount_eur: body.autoTopupAmountEur == null ? undefined : Number(body.autoTopupAmountEur),
  };

  if (updates.auto_topup_amount_eur != null) {
    if (!Number.isFinite(updates.auto_topup_amount_eur) || updates.auto_topup_amount_eur < 5) {
      return json({ error: "Importe inválido" }, 400);
    }
    if (updates.auto_topup_amount_eur > 500) {
      return json({ error: "Importe demasiado alto" }, 400);
    }
  }

  const sets = [];
  const binds = [];

  for (const [k, v] of Object.entries(updates)) {
    if (v === undefined) continue;
    sets.push(`${k}=?`);
    binds.push(v);
  }

  if (sets.length === 0) return json({ ok: true });

  // add updated_at
  sets.push("updated_at=?");
  binds.push(nowISO());

  binds.push(userId);

  await env.DB.prepare(
    `UPDATE users SET ${sets.join(", ")} WHERE id=?`
  ).bind(...binds).run();

  return json({ ok: true });
}
