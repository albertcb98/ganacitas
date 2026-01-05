// /functions/api/stripe/topup/start.js
// GET /api/stripe/topup/start?amount=10
//
// Creates a Stripe Checkout Session (mode=payment) for a topup and redirects user to Stripe.

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

function priceForAmount(env, amount) {
  if (amount === 10) return env.STRIPE_10_TOPUP;
  if (amount === 20) return env.STRIPE_20_TOPUP;
  if (amount === 50) return env.STRIPE_50_TOPUP;
  return null;
}

export async function onRequestGet({ request, env }) {
  if (!env.STRIPE_SECRET_KEY) return new Response("Missing STRIPE_SECRET_KEY", { status: 500 });
  if (!env.JWT_SECRET) return new Response("Missing JWT_SECRET", { status: 500 });
  if (!env.SITE_URL) return new Response("Missing SITE_URL", { status: 500 });

  const url = new URL(request.url);
  const amount = parseInt(url.searchParams.get("amount") || "0", 10);

  const priceId = priceForAmount(env, amount);
  if (!priceId) return new Response("Invalid amount", { status: 400 });

  // Auth user
  const auth = request.headers.get("Authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const token = bearer || getCookie(request, "session");
  if (!token) return new Response("Unauthorized", { status: 401 });

  const payload = await verifyHS256JWT(token, env.JWT_SECRET);
  const userId = payload?.sub;
  if (!userId) return new Response("Unauthorized", { status: 401 });

  // Create Checkout Session
  const successUrl = `${env.SITE_URL}/dashboard/?topup=success`;
  const cancelUrl = `${env.SITE_URL}/dashboard/?topup=cancel`;

  const body = new URLSearchParams();
  body.set("mode", "payment");
  body.set("success_url", successUrl);
  body.set("cancel_url", cancelUrl);
  body.set("client_reference_id", userId);
  body.set("metadata[topup_eur]", String(amount));
  body.set("line_items[0][price]", priceId);
  body.set("line_items[0][quantity]", "1");

  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.log("[stripe] create checkout session failed", res.status, data);
    return new Response("Stripe error creating session", { status: 400 });
  }

  if (!data?.url) return new Response("Missing Stripe session url", { status: 400 });

  return Response.redirect(data.url, 302);
}
