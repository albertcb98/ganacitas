// functions/api/stripe/topup/start.js
// GET /api/stripe/topup/start?amount=10|20|50
//
// Creates a Stripe Checkout Session (mode=payment) for a logged-in user,
// using your TOPUP product price IDs, and redirects to Stripe URL.
//
// Env required:
// - DB (D1 binding)
// - JWT_SECRET
// - SITE_URL (e.g. https://ganacitas.com)
// - STRIPE_SECRET_KEY (sk_test_... or sk_live_... depending on environment)
// - STRIPE_10_TOPUP, STRIPE_20_TOPUP, STRIPE_50_TOPUP (Price IDs)

import { verifyJWT } from "../../_lib/jwt.js";

function json(data, status=200){
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type":"application/json" }
  });
}

function getCookie(req, name) {
  const h = req.headers.get("Cookie") || "";
  for (const part of h.split(";").map(s=>s.trim())) {
    if (part.startsWith(name + "=")) return decodeURIComponent(part.slice(name.length + 1));
  }
  return null;
}

function pickTopupPriceId(env, amount){
  if (amount === 10) return env.STRIPE_10_TOPUP || null;
  if (amount === 20) return env.STRIPE_20_TOPUP || null;
  if (amount === 50) return env.STRIPE_50_TOPUP || null;
  return null;
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) return json({ error:"DB missing" }, 500);
  if (!env.JWT_SECRET) return json({ error:"JWT_SECRET missing" }, 500);
  if (!env.SITE_URL) return json({ error:"SITE_URL missing" }, 500);
  if (!env.STRIPE_SECRET_KEY) return json({ error:"STRIPE_SECRET_KEY missing" }, 500);

  // auth
  const token = getCookie(request, "session");
  if (!token) return json({ error:"No autorizado" }, 401);

  let payload;
try {
  payload = await verifyJWT(env.JWT_SECRET, token);
} catch {
  return json({ error:"No autorizado" }, 401);
}
  const userId = payload?.sub;
  if (!userId) return json({ error:"No autorizado" }, 401);
const urow = await env.DB.prepare(
  "SELECT talked_to_s, sales_rep_name FROM users WHERE id = ?"
).bind(userId).first();

const repName = (urow?.sales_rep_name || "").toString().trim().replace(/\s+/g, " ");
const talkedTo = urow?.talked_to_s ? "1" : "0";
  const u = new URL(request.url);
  const amount = Number(u.searchParams.get("amount") || 0);

  if (![10,20,50].includes(amount)) {
    return json({ error:"amount must be 10, 20 or 50" }, 400);
  }

  const priceId = pickTopupPriceId(env, amount);
  if (!priceId) return json({ error:"Topup price id missing in env" }, 500);

  // create checkout session
  const successUrl = `${env.SITE_URL}/dashboard/?topup=success`;
  const cancelUrl  = `${env.SITE_URL}/dashboard/?topup=cancel`;

  // Stripe API: POST /v1/checkout/sessions
  const body = new URLSearchParams();
  body.set("mode", "payment");
  body.set("success_url", successUrl);
  body.set("cancel_url", cancelUrl);

  // Link to your user (important)
  body.set("client_reference_id", userId);

  // One line item
  body.set("line_items[0][price]", priceId);
  body.set("line_items[0][quantity]", "1");

  // Optional: helps in webhook reading (nice-to-have)
  body.set("metadata[user_id]", userId);
  body.set("metadata[topup_eur]", String(amount));
body.set("metadata[talked_to_sales_rep]", talkedTo);
body.set("metadata[sales_rep_name]", repName || "none");

// Best practice: also put metadata on the PaymentIntent
body.set("payment_intent_data[metadata][user_id]", userId);
body.set("payment_intent_data[metadata][topup_eur]", String(amount));
body.set("payment_intent_data[metadata][talked_to_sales_rep]", talkedTo);
body.set("payment_intent_data[metadata][sales_rep_name]", repName || "none");

  const r = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  const data = await r.json().catch(()=> ({}));
  if (!r.ok) {
    console.log("[stripe] create checkout failed", r.status, data);
    return json({ error:"Stripe error", detail: data }, 400);
  }

  if (!data?.url) {
    return json({ error:"Stripe session missing url" }, 400);
  }

  return Response.redirect(data.url, 302);
}
