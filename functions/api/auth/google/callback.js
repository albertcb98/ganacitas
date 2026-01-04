// /functions/api/auth/google/callback.js

import { signJWT } from "../../_lib/jwt.js";
import { makeSessionCookie } from "../../_lib/cookies.js";

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
  if (!env.GOOGLE_CLIENT_SECRET) return new Response("Missing GOOGLE_CLIENT_SECRET", { status: 500 });
  if (!env.JWT_SECRET) return new Response("Missing JWT_SECRET", { status: 500 });

  const u = new URL(request.url);
  const code = u.searchParams.get("code");
  const state = u.searchParams.get("state");

  if (!code || !state) return new Response("Missing code/state", { status: 400 });

  // Verify state (and read redirect target)
  const st = await env.DB.prepare(
    "SELECT id, expires_at, email FROM auth_tokens WHERE type='oauth_state' AND token=?"
  ).bind(state).first();

  if (!st) return new Response("Invalid state", { status: 400 });
  if (new Date(st.expires_at).getTime() < Date.now()) return new Response("State expired", { status: 400 });

  // NOTE: you are using auth_tokens.email to store `next`.
  // That's fine for now, but consider renaming column later.
  const next = pickNext(st.email);

  // One-time use: delete state token now
  await env.DB.prepare("DELETE FROM auth_tokens WHERE id=?").bind(st.id).run();

  // Exchange code for tokens
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

  const tokenData = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok) {
    return new Response(`Token exchange failed: ${tokenData.error || ""}`, { status: 400 });
  }

  // Get userinfo
  const infoRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });

  const info = await infoRes.json().catch(() => ({}));
  if (!infoRes.ok) return new Response("Userinfo failed", { status: 400 });

  const email = (info.email || "").toLowerCase().trim();
  if (!email) return new Response("Missing email", { status: 400 });

  // Find or create user
  let user = await env.DB.prepare("SELECT id, email, paid_status FROM users WHERE email=?")
    .bind(email)
    .first();

  const now = new Date().toISOString();

  if (!user) {
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO users (id, email, password_hash, auth_provider, paid_status, created_at, updated_at)
       VALUES (?, ?, NULL, 'google', 'free', ?, ?)`
    ).bind(id, email, now, now).run();

    user = { id, email, paid_status: "free" };
  } else {
    await env.DB.prepare(`UPDATE users SET updated_at=? WHERE id=?`).bind(now, user.id).run();
  }

  const jwt = await signJWT(env.JWT_SECRET, { sub: user.id, email: user.email });

  return new Response(null, {
    status: 302,
    headers: {
      "Set-Cookie": makeSessionCookie(jwt),
      "Location": next,
    },
  });
}
