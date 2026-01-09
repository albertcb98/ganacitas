export async function onRequestGet({ request, env }) {
  try {
    // ───────────────── CAPTCHA (Turnstile) ─────────────────
    const TURNSTILE_SECRET = env.TURNSTILE_SECRET_KEY;
    if (!TURNSTILE_SECRET) {
      return Response.json(
        { ok: false, message: "Turnstile secret not configured" },
        { status: 500 }
      );
    }

    const urlObj = new URL(request.url);
    const token = urlObj.searchParams.get("token");
    if (!token) {
      return Response.json({ ok: false, message: "Missing captcha" }, { status: 400 });
    }

    const ip =
      request.headers.get("CF-Connecting-IP") ||
      request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
      "";

    const verifyRes = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        secret: TURNSTILE_SECRET,
        response: token,
        ...(ip ? { remoteip: ip } : {}),
      }),
    });

    const verifyJson = await verifyRes.json().catch(() => null);
    if (!verifyJson?.success) {
      return Response.json(
        { ok: false, message: "Captcha failed" },
        { status: 403 }
      );
    }

    // ───────────────── CONFIG ─────────────────
    const NOTION_API_KEY = env.NOTION_API_KEY;
    const NOTION_DATABASE_ID = env.NOTION_DATABASE_ID;

    if (!NOTION_API_KEY || !NOTION_DATABASE_ID) {
      return Response.json(
        { ok: false, message: "Server not configured (Notion env missing)" },
        { status: 500 }
      );
    }

    const THRESH = Number(env.LOW_BALANCE_THRESHOLD || 9.6);
    const MIN_AVAILABLE_ALERT = Number(env.MIN_AVAILABLE_ALERT || 4);

    // ───────────────── HELPERS ─────────────────
    async function notionQuery(body) {
      const res = await fetch(
        `https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}/query`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${NOTION_API_KEY}`,
            "Notion-Version": "2022-06-28",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body || {}),
        }
      );

      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(`Notion query failed: ${res.status} ${t}`);
      }

      return await res.json();
    }

    const rt = (props, name) =>
      (props?.[name]?.rich_text?.[0]?.plain_text || "").trim();

    const num = (props, name) =>
      typeof props?.[name]?.number === "number" ? props[name].number : 0;

    async function vapiSumCost(vapiPrivateKey) {
      const res = await fetch("https://api.vapi.ai/call", {
        headers: { Authorization: `Bearer ${vapiPrivateKey}` },
      });

      const json = await res.json().catch(() => null);

      if (!res.ok) {
        throw new Error(`Vapi /call failed: ${res.status} ${JSON.stringify(json)}`);
      }

      // Accept multiple shapes
      const calls =
        Array.isArray(json) ? json :
        Array.isArray(json?.calls) ? json.calls :
        Array.isArray(json?.data) ? json.data :
        null;

      if (!calls) throw new Error(`Unexpected /call response shape: ${JSON.stringify(json)}`);

      let total = 0;
      for (const c of calls) total += Number(c?.cost || 0);
      return total;
    }

    async function notionUpdateCost(pageId, newCost) {
      const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${NOTION_API_KEY}`,
          "Notion-Version": "2022-06-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ properties: { Cost: { number: newCost } } }),
      });

      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(`Notion update failed: ${res.status} ${t}`);
      }
    }

    // ───────────────── SELECT ACCOUNT ─────────────────
    const q = await notionQuery({
      filter: { property: "Cost", number: { less_than_or_equal_to: THRESH } },
      page_size: 50,
    });

    const pages = (q.results || [])
      .map((page) => {
        const props = page.properties || {};
        return {
          pageId: page.id,
          vapiPrivateKey: rt(props, "VAPI private key"),
          vapiPublicKey: rt(props, "VAPI public key"),
          assistantId: rt(props, "Assistant id"),
          cachedCost: num(props, "Cost"),
        };
      })
      .filter((x) => x.vapiPrivateKey && x.vapiPublicKey && x.assistantId);

    if (pages.length === 0) {
      return Response.json({
        ok: false,
        message:
          "No se puede probar ahora mismo, intenta en unas horas. O contáctanos por WhatsApp y lo arreglamos.",
      });
    }

    // Check cheapest first (limit to 7)
    pages.sort((a, b) => a.cachedCost - b.cachedCost);
    const toCheck = pages.slice(0, Math.min(7, pages.length));

    const checked = [];
    for (const acc of toCheck) {
      try {
        const realCost = await vapiSumCost(acc.vapiPrivateKey);
        checked.push({ ...acc, realCost });
      } catch (e) {
        // broken key / api error -> skip
        console.log("[select] vapiSumCost failed for page", acc.pageId, e?.message || e);
      }
    }

    const available = checked.filter((x) => x.realCost <= THRESH);

    if (available.length === 0) {
      return Response.json({
        ok: false,
        message:
          "No se puede probar ahora mismo, intenta en unas horas. O contáctanos por WhatsApp y lo arreglamos.",
      });
    }

    if (available.length <= MIN_AVAILABLE_ALERT) {
      // TODO: WhatsApp notify low inventory
      console.log("[select] Low demo inventory:", available.length);
    }

    available.sort((a, b) => a.realCost - b.realCost);
    const chosen = available[0];

    // Update cost AFTER selection (best-effort)
    try {
      await notionUpdateCost(chosen.pageId, chosen.realCost);
    } catch (e) {
      console.log("[select] notionUpdateCost failed (ignored):", e?.message || e);
    }

    return Response.json({
      ok: true,
      demoPageId: chosen.pageId,
      publicKey: chosen.vapiPublicKey,
      assistantId: chosen.assistantId,
    });
  } catch (e) {
    console.log("[select.js] error:", e?.message || e, e?.stack);
    return Response.json(
      { ok: false, message: "Error del servidor. Intenta más tarde.", detail: String(e?.message || e) },
      { status: 500 }
    );
  }
}
