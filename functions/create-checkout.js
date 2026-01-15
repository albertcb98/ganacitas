import { parseCookies } from "./api/_lib/cookies.js";
import { verifyJWT } from "./api/_lib/jwt.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function onRequestPost({ request, env }) {
  // 1) Require session
  const cookies = parseCookies(request);
  const token = cookies.session;
  if (!token) return json({ error: "Unauthorized" }, 401);

 let payload;
try {
  payload = await verifyJWT(env.JWT_SECRET, token);
} catch {
  return json({ error: "Unauthorized" }, 401);
}
  if (!payload?.sub) return json({ error: "Unauthorized" }, 401);

const user = await env.DB.prepare(
  "SELECT id, email, stripe_customer_id, talked_to_sales, sales_rep_name FROM users WHERE id = ?"
).bind(payload.sub).first();

  if (!user) return json({ error: "Unauthorized" }, 401);

  // 2) Plan from frontend
  const { plan } = await request.json().catch(() => ({}));
  if (!plan) return json({ error: "Missing plan" }, 400);

  if (!env.STRIPE_SECRET_KEY) return json({ error: "Missing STRIPE_SECRET_KEY" }, 500);

  const PLAN_MAP = {
    recepcionista_esencial: { recurring: env.STRIPE_PRICE_ESENCIAL, setup: env.STRIPE_PRICE_SETUP },
    recepcionista_profesional: { recurring: env.STRIPE_PRICE_PROFESIONAL, setup: env.STRIPE_PRICE_SETUP },
    recepcionista_empresa: { recurring: env.STRIPE_PRICE_EMPRESA, setup: env.STRIPE_PRICE_SETUP },
  };

  const cfg = PLAN_MAP[plan];
  if (!cfg?.recurring || !cfg?.setup) return json({ error: "Invalid plan config" }, 400);

  const siteUrl = env.SITE_URL || new URL(request.url).origin;

  // Build params
const params = new URLSearchParams({
  mode: "subscription",
  success_url: `${siteUrl}/thank-you?session_id={CHECKOUT_SESSION_ID}`,
  cancel_url: `${siteUrl}/asistente-telefonico/#precios`,

  // tie Stripe session to your user
  client_reference_id: user.id,

  // recurring subscription
  "line_items[0][price]": cfg.recurring,
  "line_items[0][quantity]": "1",

  // one-time setup fee (charged at checkout)
  "line_items[1][price]": cfg.setup,
  "line_items[1][quantity]": "1",
});

// Reuse Stripe customer if exists (prevents duplicates)
if (user.stripe_customer_id) {
  params.set("customer", user.stripe_customer_id);
} else {
  params.set("customer_email", user.email);
}

// Normalize rep fields from DB
const repName = (user.sales_rep_name || "")
  .toString()
  .trim()
  .replace(/\s+/g, " ");
const talkedTo = user.talked_to_sales ? "1" : "0";

// Metadata on Checkout Session
params.set("metadata[user_id]", user.id);
params.set("metadata[plan]", plan);
params.set("metadata[talked_to_sales_rep]", talkedTo);
params.set("metadata[sales_rep_name]", repName || "none");

// Metadata on the Subscription that will be created (best for renewals/invoices)
params.set("subscription_data[metadata][user_id]", user.id);
params.set("subscription_data[metadata][plan]", plan);
params.set("subscription_data[metadata][talked_to_sales_rep]", talkedTo);
params.set("subscription_data[metadata][sales_rep_name]", repName || "none");


  const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  const data = await stripeRes.json();

  if (!stripeRes.ok) {
    return json({ stripe_status: stripeRes.status, stripe_error: data }, 400);
  }

  return json({ url: data.url });
}
