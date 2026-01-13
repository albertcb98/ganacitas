// functions/api/vapi-demo/event.js
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function unauthorized() {
  return json({ error: "No autorizado" }, 401);
}

export async function onRequestPost({ request, env }) {
  if (!env.DEMO_KV) return json({ error: "DEMO_KV binding missing" }, 500);
  if (!env.DEMO_WEBHOOK_SECRET) return json({ error: "DEMO_WEBHOOK_SECRET missing" }, 500);

  const secret = request.headers.get("x-demo-secret") || "";
  if (secret !== env.DEMO_WEBHOOK_SECRET) return unauthorized();

  const body = await request.json().catch(() => null);
  const demoSessionId = body?.demoSessionId;
  const event = body?.event;

  if (!demoSessionId || !event) return json({ error: "Missing demoSessionId/event" }, 400);

  const key = `demo:${demoSessionId}`;
  const existingRaw = await env.DEMO_KV.get(key);
  if (!existingRaw) return json({ error: "Session not found/expired" }, 404);

  const existing = JSON.parse(existingRaw);

  // Keep ONLY the latest event (Option A)
  const next = {
    ...existing,
    lastEvent: {
      id: event.id || null,
      summary: event.summary || "Cita creada",
      start: event.start || null,     // ISO string
      end: event.end || null,         // ISO string
      htmlLink: event.htmlLink || null
    },
    updatedAt: new Date().toISOString(),
  };

  // Refresh TTL to 10 min on update
  await env.DEMO_KV.put(key, JSON.stringify(next), { expirationTtl: 10 * 60 });

  return json({ ok: true });
}
