import { parseCookies } from "../_lib/cookies.js";
import { verifyJWT } from "../_lib/jwt.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function onRequestGet({ request, env }) {
// ✅ ADD THESE LINES RIGHT HERE (top of handler)
  if (!env.DB) return json({ error: "DB binding missing" }, 500);
  if (!env.JWT_SECRET) return json({ error: "JWT_SECRET missing" }, 500);
  const cookies = parseCookies(request);
  const token = cookies.session;
  if (!token) return json({ error: "No session" }, 401);

  let payload;
try {
  payload = await verifyJWT(env.JWT_SECRET, token);
} catch {
  return json({ error: "Invalid session" }, 401);
}
  if (!payload?.sub) return json({ error: "Invalid session" }, 401);

  const user = await env.DB.prepare(
    "SELECT id, email, auth_provider, paid_status, stripe_customer_id, stripe_subscription_id, stripe_price_id FROM users WHERE id = ?"
  ).bind(payload.sub).first();

  if (!user) return json({ error: "User not found" }, 401);

  return json({ ok: true, user });
}
