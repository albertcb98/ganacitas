// functions/api/attribution/sales-rep.js
import { parseCookies } from "../_lib/cookies.js";
import { verifyJWT } from "../_lib/jwt.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function normalizeName(str) {
  const s = (str || "").toString().trim().replace(/\s+/g, " ");
  if (!s) return "";
  // Keeps accents, handles multi-word names
  return s
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB) return json({ error: "DB missing" }, 500);
    if (!env.JWT_SECRET) return json({ error: "JWT_SECRET missing" }, 500);

    // Auth (session cookie)
    const cookies = parseCookies(request);
    const token = cookies.session;
    if (!token) return json({ error: "No session" }, 401);

    let payload;
    try {
      payload = await verifyJWT(env.JWT_SECRET, token);
    } catch {
      return json({ error: "Invalid session" }, 401);
    }

    const userId = payload?.sub;
    if (!userId) return json({ error: "Invalid session" }, 401);

    // Body
    const body = await request.json().catch(() => ({}));
    const talked = !!body.talkedToSales;
    const repName = talked ? normalizeName(body.salesRepName) : "";

    if (talked && !repName) {
      return json({ error: "Missing salesRepName" }, 400);
    }

    const nowIso = new Date().toISOString();

    // ✅ NOTE:
    // This expects columns: talked_to_s (INTEGER) and sales_rep_name (TEXT).
    // If your column names differ, change them here.
    await env.DB.prepare(
      `UPDATE users
       SET talked_to_s = ?,
           sales_rep_name = ?,
           updated_at = ?
       WHERE id = ?`
    )
      .bind(talked ? 1 : 0, talked ? repName : null, nowIso, userId)
      .run();

    return json({ ok: true, talkedToSales: talked, salesRepName: talked ? repName : null });
  } catch (e) {
    // If you see "no such column: talked_to_s", add the columns (SQL below)
    console.error("[sales-rep]", e);
    return json({ error: "Server error", detail: String(e?.message || e) }, 500);
  }
}
