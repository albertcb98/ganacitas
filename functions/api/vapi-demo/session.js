// functions/api/vapi-demo/session.js
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function onRequestPost({ env }) {
  if (!env.DEMO_KV) return json({ error: "DEMO_KV binding missing" }, 500);

  const demoSessionId = crypto.randomUUID();
  const key = `demo:${demoSessionId}`;

  // Store empty state, TTL 10 min
  await env.DEMO_KV.put(
    key,
    JSON.stringify({ createdAt: new Date().toISOString(), events: [] }),
    { expirationTtl: 10 * 60 }
  );

  return json({ demoSessionId });
}
