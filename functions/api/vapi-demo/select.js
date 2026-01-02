export async function onRequestGet({ env }) {
  try {
    const NOTION_API_KEY = env.NOTION_API_KEY;
    const NOTION_DATABASE_ID = env.NOTION_DATABASE_ID;
    const THRESH = Number(env.LOW_BALANCE_THRESHOLD || 9.6);
    const MIN_AVAILABLE_ALERT = Number(env.MIN_AVAILABLE_ALERT || 4);

    async function notionQuery(body) {
      const res = await fetch(`https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}/query`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${NOTION_API_KEY}`,
          "Notion-Version": "2022-06-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body || {}),
      });
      if (!res.ok) throw new Error(`Notion query failed: ${res.status} ${await res.text()}`);
      return await res.json();
    }

    const rt = (p, name) => (p?.[name]?.rich_text?.[0]?.plain_text || "").trim();
    const num = (p, name) => (typeof p?.[name]?.number === "number" ? p[name].number : 0);

    async function vapiSumCost(vapiPrivateKey) {
      const res = await fetch("https://api.vapi.ai/call", {
        headers: { Authorization: `Bearer ${vapiPrivateKey}` },
      });
      if (!res.ok) throw new Error(`Vapi /call failed: ${res.status} ${await res.text()}`);
      const calls = await res.json();
      if (!Array.isArray(calls)) throw new Error("Unexpected /call response (expected array)");
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
      if (!res.ok) throw new Error(`Notion update failed: ${res.status} ${await res.text()}`);
    }

    // 1) candidates by cached cost
    const q = await notionQuery({
      filter: { property: "Cost", number: { less_than_or_equal_to: THRESH } },
      page_size: 50,
    });

    const pages = (q.results || [])
      .map((page) => {
        const p = page.properties || {};
        return {
          pageId: page.id,
          vapiPrivateKey: rt(p, "VAPI private key"),
          vapiPublicKey: rt(p, "VAPI public key"),
          assistantId: rt(p, "Assistant id"),
          cachedCost: num(p, "Cost"),
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

    // 2) optimization: check first 10 cheapest
    pages.sort((a, b) => a.cachedCost - b.cachedCost);
    const toCheck = pages.slice(0, Math.min(10, pages.length));

    const checked = [];
    for (const acc of toCheck) {
      try {
        const realCost = await vapiSumCost(acc.vapiPrivateKey);
        await notionUpdateCost(acc.pageId, realCost);
        checked.push({ ...acc, realCost });
      } catch {
        // broken key etc -> skip
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
      // TODO: WhatsApp notify
      // console.log("Low inventory", available.length);
    }

    available.sort((a, b) => a.realCost - b.realCost);
    const chosen = available[0];

    return Response.json({
      ok: true,
      demoPageId: chosen.pageId,
      publicKey: chosen.vapiPublicKey,
      assistantId: chosen.assistantId,
    });
  } catch (e) {
    return Response.json({ ok: false, message: "Error del servidor. Intenta más tarde." }, { status: 500 });
  }
}
