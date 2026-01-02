export async function onRequestPost({ request, env }) {
  const { plan } = await request.json();

  if (!env.STRIPE_SECRET_KEY) {
    return new Response(JSON.stringify({ error: "Missing STRIPE_SECRET_KEY" }), { status: 500 });
  }

  // Map your button keys -> Stripe Price IDs
  const PLAN_MAP = {
    recepcionista_monthly: {
      recurring: env.STRIPE_PRICE_47_MONTH,
      setup: env.STRIPE_PRICE_57_SETUP,
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

    // recurring line item
    "line_items[0][price]": cfg.recurring,
    "line_items[0][quantity]": "1",

    // setup fee charged on FIRST invoice
    "subscription_data[add_invoice_items][0][price]": cfg.setup,
    "subscription_data[add_invoice_items][0][quantity]": "1",

    // If later you want Stripe to calculate IVA automatically:
    // "automatic_tax[enabled]": "true",
    // "billing_address_collection": "required",
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
    return new Response(JSON.stringify({ error: data }), { status: 400 });
  }

  return new Response(JSON.stringify({ url: data.url }), {
    headers: { "Content-Type": "application/json" },
  });
}
