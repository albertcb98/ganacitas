// functions/api/vapi-demo/status.js
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function onRequestGet({ request, env }) {
  if (!env.DEMO_KV) return json({ error: "DEMO_KV binding missing" }, 500);

  const url = new URL(request.url);
  const demoSessionId = url.searchParams.get("demoSessionId");
  if (!demoSessionId) return json({ error: "Missing demoSessionId" }, 400);

  const key = `demo:${demoSessionId}`;
  const raw = await env.DEMO_KV.get(key);
  if (!raw) return json({ found: false }, 200);

  const data = JSON.parse(raw);
  return json({
    found: true,
    lastEvent: data.lastEvent || null,
    updatedAt: data.updatedAt || null,
  });
}
