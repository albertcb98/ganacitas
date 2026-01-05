// functions/api/dashboard/summary.js
// GET /api/dashboard/summary

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function nowISO() {
  return new Date().toISOString();
}

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

function planConfig(plan) {
  if (plan === "esencial") return { label: "Esencial", callsIncluded: 50, budgetEur: 15 };
  if (plan === "profesional") return { label: "Profesional", callsIncluded: 100, budgetEur: 30 };
  if (plan === "empresa") return { label: "Empresa", callsIncluded: 200, budgetEur: 60 };
  return { label: "Free", callsIncluded: 0, budgetEur: 0 };
}

function monthCycleRangeISO() {
  const d = new Date();
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0));
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 0, 0));
  return { startISO: start.toISOString(), endISO: end.toISOString() };
}

async function getGoogleCalendarConnected(env, userId) {
  const row = await env.DB.prepare(
    "SELECT id, refresh_token FROM user_integrations WHERE user_id=? AND provider='google_calendar' LIMIT 1"
  ).bind(userId).first();
  return !!(row && row.refresh_token);
}

async function refreshSpentFromVapi({ env, user }) {
  const vapiKey = user.vapi_api_key || env.VAPI_API_KEY;
  if (!vapiKey) return { spentEur: Number(user.spent_eur_this_cycle || 0), refreshed: false };
  if (!user.vapi_assistant_id) return { spentEur: Number(user.spent_eur_this_cycle || 0), refreshed: false };

  const { startISO, endISO } = monthCycleRangeISO();

  const url = new URL("https://api.vapi.ai/call");
  url.searchParams.set("limit", "1000");
  url.searchParams.set("createdAtGe", startISO);
  url.searchParams.set("createdAtLt", endISO);
  url.searchParams.set("assistantId", user.vapi_assistant_id);

  const r = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${vapiKey}` },
  });

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    console.log("[vapi] list calls failed", r.status, t);
    return { spentEur: Number(user.spent_eur_this_cycle || 0), refreshed: false };
  }

  const data = await r.json().catch(() => ({}));
  const items = Array.isArray(data) ? data : (data.items || data.calls || []);

  let spent = 0;
  for (const c of items) {
    const cost = c.Cost ?? c.cost ?? 0;
    const num = Number(cost);
    if (Number.isFinite(num)) spent += num;
  }

  await env.DB.prepare(
    "UPDATE users SET spent_eur_this_cycle=?, last_usage_sync_at=?, updated_at=? WHERE id=?"
  ).bind(spent, nowISO(), nowISO(), user.id).run();

  return { spentEur: spent, refreshed: true };
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) return json({ error: "DB binding missing" }, 500);
  if (!env.JWT_SECRET) return json({ error: "JWT_SECRET missing" }, 500);

  const token = getCookie(request, "session");
  if (!token) return json({ error: "No autorizado" }, 401);

  const payload = await verifyHS256JWT(token, env.JWT_SECRET);
  const userId = payload?.sub;
  if (!userId) return json({ error: "No autorizado" }, 401);

  const user = await env.DB.prepare(
    `SELECT id, paid_status, plan, agent_status,
            vapi_assistant_id, vapi_api_key,
            notify_50, notify_80,
            auto_topup_enabled, auto_topup_amount_eur,
            last_usage_sync_at, spent_eur_this_cycle
     FROM users WHERE id=? LIMIT 1`
  ).bind(userId).first();

  if (!user) return json({ error: "No autorizado" }, 401);

  const googleCalendarConnected = await getGoogleCalendarConnected(env, user.id);

  if (user.paid_status !== "active") {
    return json({
      paid: false,
      planLabel: "Free",
      callsIncluded: 0,
      callsRemaining: 0,
      agentStatus: "preparacion",
      notify50: true,
      notify80: true,
      autoTopupEnabled: false,
      autoTopupAmountEur: 10,
      googleCalendarConnected,
      vapiAssistantLinked: !!user.vapi_assistant_id,
    });
  }

  const cfg = planConfig(user.plan);

  // refresh max every 10 minutes
  const last = user.last_usage_sync_at ? Date.parse(user.last_usage_sync_at) : 0;
  const nowMs = Date.now();
  let spentEur = Number(user.spent_eur_this_cycle || 0);

  if (!last || (nowMs - last) > 10 * 60 * 1000) {
    const refreshed = await refreshSpentFromVapi({ env, user });
    spentEur = refreshed.spentEur;
  }

  const COST_PER_CALL_EUR = 0.30;
  const usedCalls = Math.ceil(spentEur / COST_PER_CALL_EUR);
  const remaining = Math.max(0, cfg.callsIncluded - usedCalls);

  let agentStatus = user.agent_status || "preparacion";
  if (remaining <= 0) agentStatus = "pausado";

  return json({
    paid: true,
    plan: user.plan,
    planLabel: cfg.label,
    callsIncluded: cfg.callsIncluded,
    callsRemaining: remaining,
    agentStatus,
    spentEurThisCycle: Number(spentEur.toFixed(2)),

    notify50: !!user.notify_50,
    notify80: !!user.notify_80,

    autoTopupEnabled: !!user.auto_topup_enabled,
    autoTopupAmountEur: Number(user.auto_topup_amount_eur || 10),

    googleCalendarConnected,
    vapiAssistantLinked: !!user.vapi_assistant_id,
  });
}
