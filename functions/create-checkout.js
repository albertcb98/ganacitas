export async function onRequestPost({ request, env }) {
  const { plan } = await request.json();

  if (!env.STRIPE_SECRET_KEY) {
    return new Response(JSON.stringify({ error: "Missing STRIPE_SECRET_KEY" }), { status: 500 });
  }

  // Map your button keys -> Stripe Price IDs
  const PLAN_MAP = {
   recepcionista_esencial: {
    recurring: env.STRIPE_PRICE_ESENCIAL,
    setup: env.STRIPE_PRICE_SETUP,
  },
  recepcionista_profesional: {
    recurring: env.STRIPE_PRICE_PROFESIONAL,
    setup: env.STRIPE_PRICE_SETUP,
  },
  recepcionista_empresa: {
    recurring: env.STRIPE_PRICE_EMPRESA,
    setup: env.STRIPE_PRICE_SETUP,
  },
  };

  const cfg = PLAN_MAP[plan];
  if (!cfg) {
    return new Response(JSON.stringify({ error: "Invalid plan" }), { status: 400 });
  }

  const siteUrl = env.SITE_URL || new URL(request.url).origin;

const params = new URLSearchParams({
  mode: "subscription",
  success_url: `${siteUrl}/gracias?session_id={CHECKOUT_SESSION_ID}`,
  cancel_url: `${siteUrl}/asistente-telefonico/#precios`,

  // recurring subscription
  "line_items[0][price]": cfg.recurring,
  "line_items[0][quantity]": "1",

  // one-time setup fee (charged on first invoice)
  "line_items[1][price]": cfg.setup,
  "line_items[1][quantity]": "1",
});

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
    return new Response(JSON.stringify({
    stripe_status: stripeRes.status,
    stripe_error: data
  }), {
    status: 400,
    headers: { "Content-Type": "application/json" }
  });
  }

  return new Response(JSON.stringify({ url: data.url }), {
    headers: { "Content-Type": "application/json" },
  });
}
