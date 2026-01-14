// functions/api/admin/users.js
import { verifyJWT } from "../_lib/jwt.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function getCookie(req, name) {
  const h = req.headers.get("Cookie") || "";
  for (const part of h.split(";").map((s) => s.trim())) {
    if (part.startsWith(name + "=")) return decodeURIComponent(part.slice(name.length + 1));
  }
  return null;
}

function isAdminEmail(env, email) {
  const list = String(env.ADMIN_EMAILS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(String(email || "").toLowerCase());
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) return json({ error: "DB missing" }, 500);
  if (!env.JWT_SECRET) return json({ error: "JWT_SECRET missing" }, 500);

  const token = getCookie(request, "session");
  if (!token) return json({ error: "No autorizado" }, 401);

  const payload = await verifyJWT(env.JWT_SECRET, token);
  if (!payload?.email || !isAdminEmail(env, payload.email)) return json({ error: "No autorizado" }, 403);

const { results } = await env.DB.prepare(`
  SELECT
    id, email, paid_status, plan, agent_status,
    grace_until_at,
    spent_eur_this_cycle, last_usage_sync_at,
    cycle_start_at, cycle_end_at,
    stripe_customer_id, stripe_subscription_id, stripe_price_id,
    vapi_assistant_id,
    vapi_phone_number_id, vapi_phone_number_e164, phone_state,
    last_topup_paid_at, last_topup_applied_at,
last_subscription_paid_at,last_subscription_applied_at,
    mcp_url,
    created_at, updated_at
  FROM users
  ORDER BY created_at DESC
  LIMIT 300
`).all();

  return json({ users: results || [] });
}
