import { signJWT } from "../../_lib/jwt";
import { setCookie } from "../../_lib/cookies";

export async function onRequestGet({ request, env }) {
  const u = new URL(request.url);
  const code = u.searchParams.get("code");
  const state = u.searchParams.get("state");

  if (!code || !state) return new Response("Missing code/state", { status: 400 });

  // verify state
  const st = await env.DB.prepare(
    "SELECT id, expires_at FROM auth_tokens WHERE type='oauth_state' AND token=?"
  ).bind(state).first();

  if (!st) return new Response("Invalid state", { status: 400 });
  if (new Date(st.expires_at).getTime() < Date.now()) return new Response("State expired", { status: 400 });

  // exchange code for tokens
  const redirectUri = `${env.SITE_URL}/api/auth/google/callback`;
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

  const tokenData = await tokenRes.json();
  if (!tokenRes.ok) return new Response("Token exchange failed", { status: 400 });

  // get userinfo
  const infoRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  const info = await infoRes.json();
  if (!infoRes.ok) return new Response("Userinfo failed", { status: 400 });

  const email = (info.email || "").toLowerCase().trim();
  if (!email) return new Response("Missing email", { status: 400 });

  // find or create user
  let user = await env.DB.prepare("SELECT id, email FROM users WHERE email=?").bind(email).first();
  if (!user) {
    const id = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO users (id, email, password_hash, auth_provider, paid_status, created_at) VALUES (?, ?, NULL, 'google', 'free', ?)"
    ).bind(id, email, new Date().toISOString()).run();
    user = { id, email };
  }

  const jwt = await signJWT(env.JWT_SECRET, { sub: user.id, email: user.email });

  return new Response(null, {
    status: 302,
    headers: {
      "Set-Cookie": setCookie("session", jwt),
      "Location": "/dashboard/",
    },
  });
}
