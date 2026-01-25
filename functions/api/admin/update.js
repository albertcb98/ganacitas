// functions/api/admin/user/update.js
import { verifyJWT } from "../_lib/jwt.js";

function json(data, status=200){
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type":"application/json" }
  });
}

function getCookie(req, name) {
  const h = req.headers.get("Cookie") || "";
  for (const part of h.split(";").map(s=>s.trim())) {
    if (part.startsWith(name + "=")) return decodeURIComponent(part.slice(name.length + 1));
  }
  return null;
}

function isAdminEmail(env, email){
  const list = String(env.ADMIN_EMAILS || "")
    .split(",")
    .map(s=>s.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(String(email || "").toLowerCase());
}

function addDaysISO(baseIso, days){
  const base = baseIso ? new Date(baseIso) : new Date();
  const ms = base.getTime();
  const out = new Date(ms + days * 24*60*60*1000);
  return out.toISOString();
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ error:"DB missing" }, 500);
  if (!env.JWT_SECRET) return json({ error:"JWT_SECRET missing" }, 500);
  const token = getCookie(request, "session");
  if (!token) return json({ error:"No autorizado" }, 401);

  const payload = await verifyJWT(env.JWT_SECRET, token);
  if (!payload?.email || !isAdminEmail(env, payload.email)) return json({ error:"No autorizado" }, 403);

  const body = await request.json().catch(()=> ({}));
  const userId = body.userId;
  const action = body.action;

  if (!userId || !action) return json({ error:"Missing userId/action" }, 400);

const user = await env.DB.prepare(
  "SELECT id, grace_until_at, vapi_phone_number_id FROM users WHERE id=? LIMIT 1"
).bind(userId).first();

  if (!user) return json({ error:"User not found" }, 404);

  const nowIso = new Date().toISOString();

  if (action === "grace_plus_5") {
    // extend from the later of (now) or (existing grace)
    const base = user.grace_until_at && new Date(user.grace_until_at).getTime() > Date.now()
      ? user.grace_until_at
      : nowIso;

    const graceUntil = addDaysISO(base, 5);

    await env.DB.prepare(
      "UPDATE users SET grace_until_at=?, updated_at=? WHERE id=?"
    ).bind(graceUntil, nowIso, userId).run();

    return json({ ok:true, grace_until_at: graceUntil });
  }

  if (action === "grace_remove") {
    await env.DB.prepare(
      "UPDATE users SET grace_until_at=NULL, updated_at=? WHERE id=?"
    ).bind(nowIso, userId).run();

    return json({ ok:true });
  }

  if (action === "pause_agent") {
    await env.DB.prepare(
      "UPDATE users SET agent_status='pausado', updated_at=? WHERE id=?"
    ).bind(nowIso, userId).run();

    return json({ ok:true });
  }
  if (action === "delete_phone_number") {
if (!env.VAPI_API_KEY) return json({ error:"VAPI_API_KEY missing" }, 500);
    if (!user.vapi_phone_number_id) {
      // already unassigned
      await env.DB.prepare(
        "UPDATE users SET phone_state='unassigned', updated_at=? WHERE id=?"
      ).bind(nowIso, userId).run();
      return json({ ok:true, already: "no_phone_number" });
    }

    const del = await fetch(`https://api.vapi.ai/phone-number/${user.vapi_phone_number_id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${env.VAPI_API_KEY}` },
    });

    if (!del.ok) {
      const t = await del.text().catch(()=> "");
      return json({ error:"Vapi delete failed", status: del.status, detail: t }, 400);
    }

    // mark unassigned in D1
    await env.DB.prepare(
      `UPDATE users
       SET vapi_phone_number_id=NULL,
           vapi_phone_number_e164=NULL,
           phone_state='unassigned',
           agent_status='pausado',
           updated_at=?
       WHERE id=?`
    ).bind(nowIso, userId).run();

    return json({ ok:true });
  }
  return json({ error:"Unknown action" }, 400);
}
