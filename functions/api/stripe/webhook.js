import { timingSafeEqual } from "node:crypto";

// --- helpers ---
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function toBytes(str) {
  return new TextEncoder().encode(str);
}

/**
 * Verify Stripe signature manually (works on Workers/Pages).
 * Stripe signature header: "t=...,v1=...,v0=..."
 */
function verifyStripeSignature({ payloadRaw, sigHeader, secret }) {
  if (!sigHeader || !secret) return { ok: false, reason: "Missing signature or secret" };

  const parts = sigHeader.split(",").map((p) => p.trim());
  const tPart = parts.find((p) => p.startsWith("t="));
  const v1Part = parts.find((p) => p.startsWith("v1="));

  if (!tPart || !v1Part) return { ok: false, reason: "Bad signature header" };

  const timestamp = tPart.slice(2);
  const sig = v1Part.slice(3);

  // Stripe signs: `${timestamp}.${payload}`
  const signedPayload = `${timestamp}.${payloadRaw}`;

  // HMAC-SHA256
  // WebCrypto HMAC in Workers:
  return (async () => {
    const key = await crypto.subtle.importKey(
      "raw",
      toBytes(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );

    const digest = await crypto.subtle.sign("HMAC", key, toBytes(signedPayload));
    const expected = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    // timing-safe compare
    const a = toBytes(expected);
    const b = toBytes(sig);
    if (a.length !== b.length) return { ok: false, reason: "Signature length mismatch" };

    // timingSafeEqual expects Buffer/Uint8Array
    const ok = timingSafeEqual(new Uint8Array(a), new Uint8Array(b));
    return { ok };
  })();
}

// --- main handler ---
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

  if (!verified?.ok) {
    return json({ error: "Invalid signature", detail: verified?.reason || "verify failed" }, 400);
  }

  let event;
  try {
    event = JSON.parse(payloadRaw);
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const type = event.type;
  const obj = event.data?.object;

  // We will update user by client_reference_id from Checkout
  // For subscription events, we’ll map via subscription->customer lookup stored at checkout.completed
  try {
    if (type === "checkout.session.completed") {
      // Checkout Session object
      const session = obj;

      const userId = session.client_reference_id || null;
      const customerId = session.customer || null;
      const subscriptionId = session.subscription || null;

      if (!userId) return json({ ok: true, ignored: "missing client_reference_id" });

      // If you want the price, expand line_items normally; here we store subscription id and customer id.
      const now = new Date().toISOString();

      await env.DB.prepare(
        `UPDATE users
         SET paid_status = 'active',
             stripe_customer_id = ?,
             stripe_subscription_id = ?,
             updated_at = ?
         WHERE id = ?`
      )
        .bind(customerId, subscriptionId, now, userId)
        .run();

      return json({ ok: true });
    }

    if (type === "customer.subscription.created" || type === "customer.subscription.updated") {
      const sub = obj;
      const customerId = sub.customer;
      const subscriptionId = sub.id;

      // Determine paid_status from subscription status
      // Stripe statuses: active, trialing, past_due, canceled, unpaid, incomplete, incomplete_expired, paused
      let paid_status = "free";
      if (sub.status === "active" || sub.status === "trialing") paid_status = "active";
      else if (sub.status === "past_due" || sub.status === "unpaid") paid_status = "past_due";
      else if (sub.status === "canceled" || sub.status === "incomplete_expired") paid_status = "canceled";

      // Try to capture price id from first item
      const priceId = sub.items?.data?.[0]?.price?.id || null;

      const now = new Date().toISOString();

      await env.DB.prepare(
        `UPDATE users
         SET paid_status = ?,
             stripe_subscription_id = ?,
             stripe_price_id = COALESCE(?, stripe_price_id),
             updated_at = ?
         WHERE stripe_customer_id = ?`
      )
        .bind(paid_status, subscriptionId, priceId, now, customerId)
        .run();

      return json({ ok: true });
    }

    if (type === "customer.subscription.deleted") {
      const sub = obj;
      const customerId = sub.customer;
      const now = new Date().toISOString();

      await env.DB.prepare(
        `UPDATE users
         SET paid_status = 'canceled',
             stripe_subscription_id = NULL,
             updated_at = ?
         WHERE stripe_customer_id = ?`
      )
        .bind(now, customerId)
        .run();

      return json({ ok: true });
    }

    if (type === "invoice.payment_failed") {
      const invoice = obj;
      const customerId = invoice.customer;
      const now = new Date().toISOString();

      await env.DB.prepare(
        `UPDATE users
         SET paid_status = 'past_due',
             updated_at = ?
         WHERE stripe_customer_id = ?`
      )
        .bind(now, customerId)
        .run();

      return json({ ok: true });
    }

    if (type === "invoice.payment_succeeded") {
      const invoice = obj;
      const customerId = invoice.customer;
      const now = new Date().toISOString();

      await env.DB.prepare(
        `UPDATE users
         SET paid_status = 'active',
             updated_at = ?
         WHERE stripe_customer_id = ?`
      )
        .bind(now, customerId)
        .run();

      return json({ ok: true });
    }

    // Ignore any other events
    return json({ ok: true, ignored: type });
  } catch (e) {
    return json({ error: "Webhook handler error", detail: String(e?.message || e) }, 500);
  }
}
