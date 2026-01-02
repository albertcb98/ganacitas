export async function onRequestPost({ request, env }) {
  try {
    const { demoPageId } = await request.json();
    if (!demoPageId) return Response.json({ ok: false }, { status: 400 });

    const NOTION_API_KEY = env.NOTION_API_KEY;
    const THRESH = Number(env.LOW_BALANCE_THRESHOLD || 9.6);

    async function notionReadPage(id) {
      const res = await fetch(`https://api.notion.com/v1/pages/${id}`, {
        headers: {
          Authorization: `Bearer ${NOTION_API_KEY}`,
          "Notion-Version": "2022-06-28",
        },
      });
      if (!res.ok) throw new Error(`Notion page read failed: ${res.status} ${await res.text()}`);
      return await res.json();
    }

    const rt = (p, name) => (p?.[name]?.rich_text?.[0]?.plain_text || "").trim();

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

    async function vapiSumCost(vapiPrivateKey) {
      const res = await fetch("https://api.vapi.ai/call", {
        headers: { Authorization: `Bearer ${vapiPrivateKey}` },
      });
      if (!res.ok) throw new Error(`Vapi /call failed: ${res.status} ${await res.text()}`);
      const calls = await res.json();
      let total = 0;
      for (const c of calls) total += Number(c?.cost || 0);
      return total;
    }

    const page = await notionReadPage(demoPageId);
    const props = page.properties || {};
    const vapiPrivateKey = rt(props, "VAPI private key");
    if (!vapiPrivateKey) return Response.json({ ok: false }, { status: 400 });

    const cost = await vapiSumCost(vapiPrivateKey);
    await notionUpdateCost(demoPageId, cost);

    const below = cost <= THRESH;
    return Response.json({ ok: true, cost, below });
  } catch (e) {
    return Response.json({ ok: false }, { status: 500 });
  }
}
