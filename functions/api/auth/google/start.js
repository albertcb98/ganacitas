// /functions/api/auth/google/start.js

function pickNext(nextMaybe) {
  // prevent open-redirects: only allow internal paths
  if (!nextMaybe || typeof nextMaybe !== "string") return "/dashboard/";
  if (!nextMaybe.startsWith("/")) return "/dashboard/";
  return nextMaybe;
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) return new Response("Missing DB", { status: 500 });
  if (!env.SITE_URL) return new Response("Missing SITE_URL", { status: 500 });
  if (!env.GOOGLE_CLIENT_ID) return new Response("Missing GOOGLE_CLIENT_ID", { status: 500 });

  const urlReq = new URL(request.url);
  const next = pickNext(urlReq.searchParams.get("next"));

  const state = crypto.randomUUID();
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 minutes

  // store oauth_state + where to go after login
  // NOTE: using auth_tokens.email to store `next` (ok for now).
  await env.DB.prepare(
    `INSERT INTO auth_tokens (id, type, token, expires_at, created_at, email, user_id)
     VALUES (?, 'oauth_state', ?, ?, ?, ?, ?)`
  )
    .bind(crypto.randomUUID(), state, expires, now, next, null)
    .run();

  const redirectUri = `${env.SITE_URL}/api/auth/google/callback`;

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "openid email profile");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("prompt", "select_account");
  authUrl.searchParams.set("access_type", "online");

  return Response.redirect(authUrl.toString(), 302);
}
