// /functions/api/integrations/google/callback.js
// Exchanges code for tokens and saves Calendar integration in user_integrations.

function pickNext(nextMaybe) {
  if (!nextMaybe || typeof nextMaybe !== "string") return "/dashboard/";
  if (!nextMaybe.startsWith("/")) return "/dashboard/";
  return nextMaybe;
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) return new Response("Missing DB", { status: 500 });
  if (!env.SITE_URL) return new Response("Missing SITE_URL", { status: 500 });
  if (!env.GOOGLE_CLIENT_ID) return new Response("Missing GOOGLE_CLIENT_ID", { status: 500 });
  if (!env.GOOGLE_CLIENT_SECRET) return new Response("Missing GOOGLE_CLIENT_SECRET", { status: 500 });

  const u = new URL(request.url);
  const code = u.searchParams.get("code");
  const state = u.searchParams.get("state");

  if (!code || !state) return new Response("Missing code/state", { status: 400 });

  // Verify state and get userId + next
  const st = await env.DB.prepare(
    "SELECT id, expires_at, email, user_id FROM auth_tokens WHERE type='oauth_state_calendar' AND token=?"
  ).bind(state).first();

  if (!st) return new Response("Invalid state", { status: 400 });
  if (new Date(st.expires_at).getTime() < Date.now()) return new Response("State expired", { status: 400 });

  const next = pickNext(st.email);
  const userId = st.user_id;
  if (!userId) return new Response("Missing user_id", { status: 400 });

  // One-time use
  await env.DB.prepare("DELETE FROM auth_tokens WHERE id=?").bind(st.id).run();

  const redirectUri = `${env.SITE_URL}/api/integrations/google/callback`;

  // Exchange code for tokens
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }).toString(),
  });

  const tokenData = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok) {
    return new Response(`Token exchange failed: ${tokenData.error || ""}`, { status: 400 });
  }

  const accessToken = tokenData.access_token || null;
  const refreshToken = tokenData.refresh_token || null;
  const scope = tokenData.scope || null;
  const expiresIn = Number(tokenData.expires_in || 0);
  const expiresAt = expiresIn ? Math.floor(Date.now() / 1000) + expiresIn : null;

  // If refresh_token is missing, user already consented before.
  // In that case you must force prompt=consent (we did) OR revoke previous access.
  if (!refreshToken) {
    // Still store access token so you can show "connected", but it will expire.
    // Better: tell user to reconnect (or revoke in Google permissions).
    console.log("[google-calendar] Missing refresh_token. User may need to revoke and reconnect.");
  }

  const now = new Date().toISOString();

  // Upsert integration row
  const existing = await env.DB.prepare(
    "SELECT id FROM user_integrations WHERE user_id=? AND provider='google_calendar' LIMIT 1"
  ).bind(userId).first();

  if (existing?.id) {
    await env.DB.prepare(
      `UPDATE user_integrations
       SET access_token=?, refresh_token=COALESCE(?, refresh_token), expires_at=?, scope=?, updated_at=?
       WHERE id=?`
    ).bind(accessToken, refreshToken, expiresAt, scope, now, existing.id).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO user_integrations (id, user_id, provider, access_token, refresh_token, expires_at, scope, calendar_id, created_at, updated_at)
       VALUES (?, ?, 'google_calendar', ?, ?, ?, ?, NULL, ?, ?)`
    ).bind(crypto.randomUUID(), userId, accessToken, refreshToken, expiresAt, scope, now, now).run();
  }

  return Response.redirect(`${env.SITE_URL}${next}`, 302);
}
