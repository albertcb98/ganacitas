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

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
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
    ["sign"]
  );

  const digest = await crypto.subtle.sign("HMAC", key, toBytes(signedPayload));
  const expectedHex = bytesToHex(new Uint8Array(digest));

  for (const p of v1Parts) {
    const sigHex = p.slice(3);
    if (constantTimeEqual(expectedHex, sigHex)) return { ok: true };
  }

  return { ok: false, reason: "Signature mismatch" };
}

function planFromPriceId(env, priceId) {
  if (!priceId) return null;
  if (priceId === env.STRIPE_PRICE_ESENCIAL) return "esencial";
  if (priceId === env.STRIPE_PRICE_PROFESIONAL) return "profesional";
  if (priceId === env.STRIPE_PRICE_EMPRESA) return "empresa";
  return null;
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
    // 1) Checkout completed (subscription OR payment)
    if (type === "checkout.session.completed") {
      const session = obj;

      const userId = session.client_reference_id || null;
      const customerId = session.customer || null;
      const subscriptionId = session.subscription || null;
      const mode = session.mode || null; // "subscription" | "payment"
      const nowIso = new Date().toISOString();

      if (!userId) return json({ ok: true, ignored: "missing client_reference_id" });

      // 1A) Subscription checkout
      if (mode === "subscription") {
        await env.DB.prepare(
          `UPDATE users
           SET paid_status='active',
               stripe_customer_id=?,
               stripe_subscription_id=?,
               updated_at=?
           WHERE id=?`
        ).bind(customerId, subscriptionId, nowIso, userId).run();

        await notifyTelegram(env, `✅ Nueva suscripción (checkout): user=${userId}`);
        return json({ ok: true });
      }

      // 1B) One-off payment = TOPUP (we set metadata.topup_eur in /api/stripe/topup/start)
      if (mode === "payment") {
        const topupEur = Number(session?.metadata?.topup_eur || 0);
        if (!Number.isFinite(topupEur) || topupEur <= 0) {
          return json({ ok: true, ignored: "payment checkout without metadata.topup_eur" });
        }

        // Requires column topup_balance_eur in users table (REAL default 0)
        await env.DB.prepare(
          `UPDATE users
           SET topup_balance_eur = COALESCE(topup_balance_eur, 0) + ?,
               updated_at=?
           WHERE id=?`
        ).bind(topupEur, nowIso, userId).run();

        await notifyTelegram(env, `➕ Topup €${topupEur}: user=${userId}`);
        return json({ ok: true });
      }

      return json({ ok: true, ignored: `checkout mode ${mode}` });
    }

    // 2) Subscription create/update -> set paid_status + price_id + plan
    if (type === "customer.subscription.created" || type === "customer.subscription.updated") {
      const sub = obj;
      const customerId = sub.customer;
      const subscriptionId = sub.id;

      let paid_status = "free";
      if (sub.status === "active" || sub.status === "trialing") paid_status = "active";
      else if (sub.status === "past_due" || sub.status === "unpaid") paid_status = "past_due";
      else if (sub.status === "canceled" || sub.status === "incomplete_expired") paid_status = "canceled";

      const priceId = sub.items?.data?.[0]?.price?.id || null;
      const plan = planFromPriceId(env, priceId);
      const nowIso = new Date().toISOString();

      await env.DB.prepare(
        `UPDATE users
         SET paid_status=?,
             stripe_subscription_id=?,
             stripe_price_id=COALESCE(?, stripe_price_id),
             plan=COALESCE(?, plan),
             updated_at=?
         WHERE stripe_customer_id=?`
      ).bind(paid_status, subscriptionId, priceId, plan, nowIso, customerId).run();

      return json({ ok: true });
    }

    // 3) Subscription deleted
    if (type === "customer.subscription.deleted") {
      const sub = obj;
      const customerId = sub.customer;
      const nowIso = new Date().toISOString();

      await env.DB.prepare(
        `UPDATE users
         SET paid_status='canceled',
             stripe_subscription_id=NULL,
             updated_at=?
         WHERE stripe_customer_id=?`
      ).bind(nowIso, customerId).run();

      await notifyTelegram(env, `🛑 Suscripción cancelada: ${customerId}`);
      return json({ ok: true });
    }

    // 4) Payment failed
    if (type === "invoice.payment_failed") {
      const invoice = obj;
      const customerId = invoice.customer;
      const nowIso = new Date().toISOString();

      await env.DB.prepare(
        `UPDATE users
         SET paid_status='past_due',
             updated_at=?
         WHERE stripe_customer_id=?`
      ).bind(nowIso, customerId).run();

      await notifyTelegram(env, `⚠️ Pago fallido: ${customerId}`);
      return json({ ok: true });
    }

    // 5) Payment succeeded (new billing cycle) -> store cycle window + reset spent counter
    if (type === "invoice.payment_succeeded") {
      const invoice = obj;
      const customerId = invoice.customer;
      const nowIso = new Date().toISOString();

      const period = invoice.lines?.data?.[0]?.period;
      const cycleStart = period?.start ? new Date(period.start * 1000).toISOString() : null;
      const cycleEnd = period?.end ? new Date(period.end * 1000).toISOString() : null;

      await env.DB.prepare(
        `UPDATE users
         SET paid_status='active',
             cycle_start_at=COALESCE(?, cycle_start_at),
             cycle_end_at=COALESCE(?, cycle_end_at),
             spent_eur_this_cycle=CASE WHEN ? IS NOT NULL THEN 0 ELSE spent_eur_this_cycle END,
             updated_at=?
         WHERE stripe_customer_id=?`
      ).bind(cycleStart, cycleEnd, cycleStart, nowIso, customerId).run();

      await notifyTelegram(env, `✅ Pago OK: ${customerId} ciclo ${cycleStart} → ${cycleEnd}`);
      return json({ ok: true });
    }

    return json({ ok: true, ignored: type });
  } catch (e) {
    return json({ error: "Webhook handler error", detail: String(e?.message || e) }, 500);
  }
}
