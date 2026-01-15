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

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function toBytes(str) {
  return new TextEncoder().encode(str);
}

function hexToBytes(hex) {
  if (!hex || typeof hex !== "string" || hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function verifyStripeSignature({ payloadRaw, sigHeader, secret, toleranceSec = 5 * 60 }) {
  if (!sigHeader || !secret) return { ok: false, reason: "Missing signature or secret" };

  const parts = sigHeader.split(",").map((p) => p.trim());
  const tPart = parts.find((p) => p.startsWith("t="));
  const v1Parts = parts.filter((p) => p.startsWith("v1="));
  if (!tPart || v1Parts.length === 0) return { ok: false, reason: "Bad signature header" };

  const timestamp = Number(tPart.slice(2));
  if (!Number.isFinite(timestamp)) return { ok: false, reason: "Bad timestamp" };

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > toleranceSec) return { ok: false, reason: "Timestamp outside tolerance" };

  const signedPayload = `${timestamp}.${payloadRaw}`;

  const key = await crypto.subtle.importKey(
    "raw",
    toBytes(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );

  for (const p of v1Parts) {
    const sigHex = p.slice(3);
    const sigBytes = hexToBytes(sigHex);
    if (!sigBytes) continue;

    const ok = await crypto.subtle.verify("HMAC", key, sigBytes, toBytes(signedPayload));
    if (ok) return { ok: true };
  }

  return { ok: false, reason: "Signature mismatch" };
}

function addDaysISO(isoOrNow, days) {
  const d = isoOrNow ? new Date(isoOrNow) : new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

function planFromPriceId(env, priceId) {
  if (!priceId) return null;
  if (priceId === env.STRIPE_PRICE_ESENCIAL) return "esencial";
  if (priceId === env.STRIPE_PRICE_PROFESIONAL) return "profesional";
  if (priceId === env.STRIPE_PRICE_EMPRESA) return "empresa";
  return null;
}

function topupAmountFromPriceId(env, priceId) {
  if (!priceId) return 0;
  // IMPORTANT: match your topup env var names used in start.js
  if (priceId === env.STRIPE_10_TOPUP) return 10;
  if (priceId === env.STRIPE_20_TOPUP) return 20;
  if (priceId === env.STRIPE_50_TOPUP) return 50;
  return 0;
}

async function stripeGetLineItems(env, sessionId) {
  if (!env.STRIPE_SECRET_KEY) return null;
  const url = `https://api.stripe.com/v1/checkout/sessions/${sessionId}/line_items?limit=10`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    console.log("[stripe] line_items failed", r.status, t);
    return null;
  }
  return r.json().catch(() => null);
}

export async function onRequestPost({ request, env }) {
  if (!env.STRIPE_WEBHOOK_SECRET) return json({ error: "Missing STRIPE_WEBHOOK_SECRET" }, 500);
  if (!env.DB) return json({ error: "Missing D1 binding env.DB" }, 500);

  const sig = request.headers.get("stripe-signature");
  const payloadRaw = await request.text();

  const verified = await verifyStripeSignature({
    payloadRaw,
    sigHeader: sig,
    secret: env.STRIPE_WEBHOOK_SECRET,
  });

  if (!verified.ok) return json({ error: "Invalid signature", detail: verified.reason }, 400);

  let event;
  try {
    event = JSON.parse(payloadRaw);
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const type = event?.type;
  const obj = event?.data?.object;
  if (!type || !obj) return json({ ok: true, ignored: "missing type/object" });

  try {
    // A) checkout.session.completed (subscription OR topup payment)
    if (type === "checkout.session.completed") {
      const session = obj;

      const userId = session.client_reference_id || null;
      const customerId = session.customer || null;
      const subscriptionId = session.subscription || null;
      const mode = session.mode || null; // "subscription" | "payment"
      const nowIso = new Date().toISOString();

      if (!userId) return json({ ok: true, ignored: "missing client_reference_id" });

      // A1) subscription checkout
      if (mode === "subscription") {
      await env.DB.prepare(
  `UPDATE users
   SET paid_status='active',
       stripe_customer_id=?,
       stripe_subscription_id=?,
       grace_until_at=NULL,
       last_subscription_paid_at=?,
       last_subscription_applied_at=?,
       updated_at=?
   WHERE id=?`
).bind(
  customerId,
  subscriptionId,
  nowIso, // last_subscription_paid_at
  nowIso, // last_subscription_applied_at
  nowIso, // updated_at
  userId
).run();

        const rep = (session?.metadata?.sales_rep_name || "none").toString().trim().replace(/\s+/g, " ");
        await notifyTelegram(env, `✅ Nueva suscripción (checkout): user=${userId} • comercial=${rep}`);

        return json({ ok: true });
      }

      // A2) topup payment checkout -> compute amount from line_items priceId(s)
      if (mode === "payment") {
        const li = await stripeGetLineItems(env, session.id);
        const items = li?.data || [];
        let topupEur = 0;

        for (const it of items) {
          const priceId = it?.price?.id || null;
          const qty = Number(it?.quantity || 1);
          const each = topupAmountFromPriceId(env, priceId);
          if (each > 0 && Number.isFinite(qty) && qty > 0) topupEur += each * qty;
        }

        if (!topupEur || topupEur <= 0) {
          await notifyTelegram(env, `⚠️ Topup: no se pudo calcular el importe (session=${session.id})`);
          return json({ ok: true, ignored: "topup amount not detected" });
        }

        await env.DB.prepare(
          `UPDATE users
           SET topup_balance_eur = COALESCE(topup_balance_eur, 0) + ?,
               last_topup_paid_at=?,
               updated_at=?
           WHERE id=?`
        ).bind(topupEur, nowIso, nowIso, userId).run();

        await notifyTelegram(env, `➕ Topup €${topupEur}: user=${userId}`);
        return json({ ok: true });
      }

      return json({ ok: true, ignored: `checkout mode ${mode}` });
    }

    // B) subscription created/updated -> set status + plan + grace rules
    if (type === "customer.subscription.created" || type === "customer.subscription.updated") {
      const sub = obj;
      const customerId = sub.customer;
      const subscriptionId = sub.id;

      const stripeStatus = sub.status; // active, trialing, past_due, unpaid, canceled...
      const nowIso = new Date().toISOString();

      const priceId = sub.items?.data?.[0]?.price?.id || null;
      const plan = planFromPriceId(env, priceId);

      let paid_status = "free";
      if (stripeStatus === "active" || stripeStatus === "trialing") paid_status = "active";
      else if (stripeStatus === "past_due" || stripeStatus === "unpaid") paid_status = "past_due";
      else if (stripeStatus === "canceled") paid_status = "canceled";
      else paid_status = "past_due";

      // canceled => immediate cancel
      if (stripeStatus === "canceled") {
        await env.DB.prepare(
          `UPDATE users
           SET paid_status='canceled',
               grace_until_at=NULL,
               updated_at=?
           WHERE stripe_customer_id=?`
        ).bind(nowIso, customerId).run();

        await notifyTelegram(env, `🛑 Suscripción cancelada: ${customerId}`);
        return json({ ok: true });
      }

      // grace
      const GRACE_DAYS = 5;
      let graceUntil = null;
      if (paid_status === "past_due") graceUntil = addDaysISO(nowIso, GRACE_DAYS);

      await env.DB.prepare(
        `UPDATE users
         SET paid_status=?,
             stripe_subscription_id=?,
             stripe_price_id=COALESCE(?, stripe_price_id),
             plan=COALESCE(?, plan),
             grace_until_at=?,
             updated_at=?
         WHERE stripe_customer_id=?`
      ).bind(paid_status, subscriptionId, priceId, plan, graceUntil, nowIso, customerId).run();

      return json({ ok: true });
    }

    // C) subscription deleted -> canceled immediately
    if (type === "customer.subscription.deleted") {
      const sub = obj;
      const customerId = sub.customer;
      const nowIso = new Date().toISOString();

      await env.DB.prepare(
        `UPDATE users
         SET paid_status='canceled',
             stripe_subscription_id=NULL,
             grace_until_at=NULL,
             updated_at=?
         WHERE stripe_customer_id=?`
      ).bind(nowIso, customerId).run();

      await notifyTelegram(env, `🛑 Suscripción eliminada/cancelada: ${customerId}`);
      return json({ ok: true });
    }

    // D) invoice.payment_failed -> start grace countdown
    if (type === "invoice.payment_failed") {
      const invoice = obj;
      const customerId = invoice.customer;
      const nowIso = new Date().toISOString();

      const GRACE_DAYS = 5;
      const graceUntil = addDaysISO(nowIso, GRACE_DAYS);

      await env.DB.prepare(
        `UPDATE users
         SET paid_status='past_due',
             grace_until_at=?,
             updated_at=?
         WHERE stripe_customer_id=?`
      ).bind(graceUntil, nowIso, customerId).run();

      await notifyTelegram(env, `⚠️ Pago fallido: ${customerId} (gracia hasta ${graceUntil})`);
      return json({ ok: true });
    }

    // E) invoice.payment_succeeded -> new billing cycle OK (clear grace + reset)
    if (type === "invoice.payment_succeeded") {
      const invoice = obj;
      const customerId = invoice.customer;
      const nowIso = new Date().toISOString();

      const lines = invoice.lines?.data || [];
      const subLine =
        lines.find((l) => l?.period && l?.subscription) ||
        lines.find((l) => l?.period) ||
        null;

      const cycleStart = subLine?.period?.start ? new Date(subLine.period.start * 1000).toISOString() : null;
      const cycleEnd = subLine?.period?.end ? new Date(subLine.period.end * 1000).toISOString() : null;

      await env.DB.prepare(
        `UPDATE users
         SET paid_status='active',
             grace_until_at=NULL,
             cycle_start_at=COALESCE(?, cycle_start_at),
             cycle_end_at=COALESCE(?, cycle_end_at),
             spent_eur_this_cycle=CASE WHEN ? IS NOT NULL THEN 0 ELSE spent_eur_this_cycle END,
             last_subscription_paid_at=?,
       updated_at=?
         WHERE stripe_customer_id=?`
      ).bind(cycleStart, cycleEnd, cycleStart, nowIso, customerId).run();

      // Preserve comercial data (prefer Stripe metadata; fallback to DB)
      let rep =
        invoice?.subscription_details?.metadata?.sales_rep_name ||
        invoice?.metadata?.sales_rep_name ||
        null;

      if (!rep) {
        const repRow = await env.DB.prepare(
          "SELECT sales_rep_name FROM users WHERE stripe_customer_id = ? LIMIT 1"
        ).bind(customerId).first();
        rep = repRow?.sales_rep_name || null;
      }

      rep = (rep || "none").toString().trim().replace(/\s+/g, " ");

      await notifyTelegram(
        env,
        `✅ Pago OK (renovación): ${customerId} • comercial=${rep} • ciclo ${cycleStart || "?"} → ${cycleEnd || "?"}`
      );

      return json({ ok: true });
    }

    // default
    return json({ ok: true, ignored: type });
  } catch (e) {
    return json({ error: "Webhook handler error", detail: String(e?.message || e) }, 500);
  }
}
