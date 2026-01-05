// /functions/api/stripe/webhook.js

async function notifyTelegram(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
  }).catch(() => {});
}

function planFromPriceId(env, priceId) {
  if (priceId === env.STRIPE_PRICE_ESENCIAL) return "esencial";
  if (priceId === env.STRIPE_PRICE_PROFESIONAL) return "profesional";
  if (priceId === env.STRIPE_PRICE_EMPRESA) return "empresa";
  return null;
}

function topupAmountFromPriceId(env, priceId) {
  if (priceId === env.STRIPE_10_TOPUP) return 10;
  if (priceId === env.STRIPE_20_TOPUP) return 20;
  if (priceId === env.STRIPE_50_TOPUP) return 50;
  return 0;
}

async function stripeGetLineItems(env, sessionId) {
  if (!env.STRIPE_SECRET_KEY) return null;
  const r = await fetch(
    `https://api.stripe.com/v1/checkout/sessions/${sessionId}/line_items?limit=5`,
    { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } }
  );
  if (!r.ok) return null;
  return r.json().catch(() => null);
}

// --- signature verification helpers (igual que ya tenías) ---
/* ... verifyStripeSignature helpers unchanged ... */

export async function onRequestPost({ request, env }) {
  if (!env.DB || !env.STRIPE_WEBHOOK_SECRET) {
    return new Response("Missing env", { status: 500 });
  }

  const sig = request.headers.get("stripe-signature");
  const payloadRaw = await request.text();

  const verified = await verifyStripeSignature({
    payloadRaw,
    sigHeader: sig,
    secret: env.STRIPE_WEBHOOK_SECRET,
  });

  if (!verified.ok) return new Response("Bad signature", { status: 400 });

  const event = JSON.parse(payloadRaw);
  const type = event.type;
  const obj = event.data?.object;

  // A) Checkout completed
  if (type === "checkout.session.completed") {
    const session = obj;
    const mode = session.mode;
    const nowIso = new Date().toISOString();

    // A1) TOPUP (payment)
    if (mode === "payment") {
      const items = await stripeGetLineItems(env, session.id);
      const priceId = items?.data?.[0]?.price?.id;
      const topupEur = topupAmountFromPriceId(env, priceId);

      if (topupEur > 0) {
        // ⚠️ usuario se identifica por customer
        const customerId = session.customer;

        await env.DB.prepare(
          `UPDATE users
           SET topup_balance_eur = COALESCE(topup_balance_eur, 0) + ?,
               updated_at = ?
           WHERE stripe_customer_id = ?`
        ).bind(topupEur, nowIso, customerId).run();

        await notifyTelegram(env, `➕ Topup €${topupEur} (${customerId})`);
      }

      return new Response("ok");
    }

    // A2) SUBSCRIPTION checkout
    if (mode === "subscription") {
      const userId = session.client_reference_id;
      if (userId) {
        await env.DB.prepare(
          `UPDATE users
           SET paid_status='active',
               stripe_customer_id=?,
               stripe_subscription_id=?,
               updated_at=?
           WHERE id=?`
        ).bind(session.customer, session.subscription, nowIso, userId).run();
      }
      return new Response("ok");
    }
  }

  // B) Subscription created / updated
  if (type === "customer.subscription.created" || type === "customer.subscription.updated") {
    const sub = obj;
    const priceId = sub.items?.data?.[0]?.price?.id;
    const plan = planFromPriceId(env, priceId);

    await env.DB.prepare(
      `UPDATE users
       SET paid_status=?,
           plan=COALESCE(?, plan),
           stripe_subscription_id=?,
           stripe_price_id=?,
           updated_at=?
       WHERE stripe_customer_id=?`
    ).bind(
      sub.status === "active" ? "active" : "past_due",
      plan,
      sub.id,
      priceId,
      new Date().toISOString(),
      sub.customer
    ).run();

    return new Response("ok");
  }

  // C) Invoice payment succeeded (nuevo ciclo)
  if (type === "invoice.payment_succeeded") {
    const invoice = obj;
    const period = invoice.lines?.data?.[0]?.period;

    const cycleStart = period?.start
      ? new Date(period.start * 1000).toISOString()
      : null;
    const cycleEnd = period?.end
      ? new Date(period.end * 1000).toISOString()
      : null;

    await env.DB.prepare(
      `UPDATE users
       SET spent_eur_this_cycle=0,
           cycle_start_at=?,
           cycle_end_at=?,
           updated_at=?
       WHERE stripe_customer_id=?`
    ).bind(
      cycleStart,
      cycleEnd,
      new Date().toISOString(),
      invoice.customer
    ).run();

    await notifyTelegram(env, `🔄 Nuevo ciclo ${cycleStart} → ${cycleEnd}`);
    return new Response("ok");
  }

  return new Response("ignored");
}
