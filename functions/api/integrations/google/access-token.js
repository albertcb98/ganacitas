// /functions/api/integrations/google/access-token.js
// POST { user_id }
// Header: X-N8N-SECRET: <env.N8N_SHARED_SECRET>
// Returns { access_token, expires_at }

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function nowISO() { return new Date().toISOString(); }

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ error: "Missing DB" }, 500);
  if (!env.GOOGLE_CLIENT_ID) return json({ error: "Missing GOOGLE_CLIENT_ID" }, 500);
  if (!env.GOOGLE_CLIENT_SECRET) return json({ error: "Missing GOOGLE_CLIENT_SECRET" }, 500);
  if (!env.N8N_SHARED_SECRET) return json({ error: "Missing N8N_SHARED_SECRET" }, 500);

  const secret = request.headers.get("X-N8N-SECRET") || "";
  if (secret !== env.N8N_SHARED_SECRET) {
    return json({ error: "Unauthorized" }, 401);
  }

  const body = await request.json().catch(() => ({}));
  const userId = (body.user_id || "").trim();
  if (!userId) return json({ error: "Missing user_id" }, 400);

  const integ = await env.DB.prepare(
    `SELECT id, refresh_token
     FROM user_integrations
     WHERE user_id=? AND provider='google_calendar'
     LIMIT 1`
  ).bind(userId).first();

  if (!integ?.refresh_token) {
    return json({ error: "No Google integration for this user" }, 404);
  }

  // Refresh access token
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: integ.refresh_token,
    }).toString(),
  });

  const tokenData = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tokenData.access_token) {
    return json({ error: "Token refresh failed", details: tokenData }, 400);
  }

  const accessToken = tokenData.access_token;
  const expiresIn = Number(tokenData.expires_in || 3600);
  const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;

  // Optionally store latest access token + expiry (not required, but handy)
  const now = nowISO();
  await env.DB.prepare(
    `UPDATE user_integrations
     SET access_token=?, expires_at=?, updated_at=?
     WHERE id=?`
  ).bind(accessToken, expiresAt, now, integ.id).run();

  return json({ access_token: accessToken, expires_at: expiresAt });
}
