export async function onRequestGet({ env }) {
  const state = crypto.randomUUID();
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 min

  await env.DB.prepare(
    "INSERT INTO auth_tokens (id, type, token, expires_at, created_at) VALUES (?, 'oauth_state', ?, ?, ?)"
  ).bind(crypto.randomUUID(), state, expires, now).run();

  const redirectUri = `${env.SITE_URL}/api/auth/google/callback`;
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "select_account");

  return Response.redirect(url.toString(), 302);
}
