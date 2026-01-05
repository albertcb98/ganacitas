// /functions/api/integrations/google/start.js
// Starts Google OAuth flow for Google Calendar integration.
// Requires an existing session.

import { verifyJWT } from "../../_lib/jwt.js";

function pickNext(nextMaybe) {
  if (!nextMaybe || typeof nextMaybe !== "string") return "/dashboard/";
  if (!nextMaybe.startsWith("/")) return "/dashboard/";
  return nextMaybe;
}

function getCookie(req, name) {
  const h = req.headers.get("Cookie") || "";
  const parts = h.split(";").map(s => s.trim());
  for (const p of parts) {
    if (p.startsWith(name + "=")) return decodeURIComponent(p.slice(name.length + 1));
  }
  return null;
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) return new Response("Missing DB", { status: 500 });
  if (!env.SITE_URL) return new Response("Missing SITE_URL", { status: 500 });
  if (!env.GOOGLE_CLIENT_ID) return new Response("Missing GOOGLE_CLIENT_ID", { status: 500 });
  if (!env.JWT_SECRET) return new Response("Missing JWT_SECRET", { status: 500 });

  // Require session
  const session = getCookie(request, "session");
  if (!session) return Response.redirect(`${env.SITE_URL}/login/`, 302);

  const claims = await verifyJWT(env.JWT_SECRET, session).catch(() => null);
  const userId = claims?.sub;
  if (!userId) return Response.redirect(`${env.SITE_URL}/login/`, 302);

  const urlReq = new URL(request.url);
  const next = pickNext(urlReq.searchParams.get("next"));

  const state = crypto.randomUUID();
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 minutes

  // store oauth_state for integration; email field stores next (same trick you use)
  await env.DB.prepare(
    `INSERT INTO auth_tokens (id, type, token, expires_at, created_at, email, user_id)
     VALUES (?, 'oauth_state_calendar', ?, ?, ?, ?, ?)`
  )
    .bind(crypto.randomUUID(), state, expires, now, next, userId)
    .run();

  const redirectUri = `${env.SITE_URL}/api/integrations/google/callback`;

  // Calendar scopes
  const scopes = [
     "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/spreadsheets"
  ].join(" ");

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", scopes);
  authUrl.searchParams.set("state", state);

  // IMPORTANT: to get refresh_token reliably:
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");

  return Response.redirect(authUrl.toString(), 302);
}
