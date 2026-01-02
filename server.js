import express from "express";
const app = express();
app.use(express.json());

// ====== ENV ======
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;

const THRESH = Number(process.env.LOW_BALANCE_THRESHOLD || 9.6);
const MIN_AVAILABLE_ALERT = Number(process.env.MIN_AVAILABLE_ALERT || 4);

if (!NOTION_API_KEY || !NOTION_DATABASE_ID) {
  console.warn("⚠️ Missing NOTION_API_KEY or NOTION_DATABASE_ID in env.");
}

// ====== Helpers ======
async function notionQuery(filterObj) {
  const res = await fetch(`https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${NOTION_API_KEY}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(filterObj || {}),
  });

  if (!res.ok) throw new Error(`Notion query failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

function rt(p, name) {
  // Notion rich_text -> string
  return (p?.[name]?.rich_text?.[0]?.plain_text || "").trim();
}

function email(p, name) {
  return (p?.[name]?.email || "").trim();
}

function num(p, name) {
  const v = p?.[name]?.number;
  return typeof v === "number" ? v : 0;
}

async function vapiSumCost(vapiPrivateKey) {
  // Your /call returns an array. Sum only "cost".
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
    body: JSON.stringify({
      properties: { Cost: { number: newCost } },
    }),
  });

  if (!res.ok) throw new Error(`Notion update failed: ${res.status} ${await res.text()}`);
}

function mapPage(page) {
  const p = page.properties || {};
  return {
    pageId: page.id,
    email: email(p, "Email"),
    vapiPrivateKey: rt(p, "VAPI private key"),
    vapiPublicKey: rt(p, "VAPI public key"),
    assistantId: rt(p, "Assistant id"),
    cachedCost: num(p, "Cost"),
  };
}

// ====== ROUTES ======

/**
 * GET /api/vapi-demo/select
 * - Finds a demo account with REAL computed cost <= THRESH
 * - Updates Notion Cost for checked pages
 * - Returns publicKey + assistantId + demoPageId
 */
app.get("/api/vapi-demo/select", async (_req, res) => {
  try {
    // 1) Query only candidates with cached Cost <= THRESH (reduces work)
    const q = await notionQuery({
      filter: { property: "Cost", number: { less_than_or_equal_to: THRESH } },
      page_size: 50,
    });

    let pages = (q.results || []).map(mapPage)
      .filter(x => x.vapiPrivateKey && x.vapiPublicKey && x.assistantId);

    // If none even pass cached filter -> fail fast
    if (pages.length === 0) {
      return res.json({
        ok: false,
        message:
          "No se puede probar ahora mismo, intenta en unas horas. O contáctanos por WhatsApp y lo arreglamos.",
      });
    }

    // 2) Optimization: check a few cheapest first
    pages.sort((a, b) => a.cachedCost - b.cachedCost);
    const toCheck = pages.slice(0, Math.min(10, pages.length)); // check first 10

    const checked = [];
    for (const acc of toCheck) {
      let realCost = acc.cachedCost;
      try {
        realCost = await vapiSumCost(acc.vapiPrivateKey);
        // Update Notion with real cost
        await notionUpdateCost(acc.pageId, realCost);
      } catch (e) {
        console.warn("[Cost compute] failed for page", acc.pageId, e.message);
        // If Vapi key broken, skip it
        continue;
      }

      checked.push({ ...acc, realCost });
    }

    const available = checked.filter(x => x.realCost <= THRESH);

    if (available.length === 0) {
      return res.json({
        ok: false,
        message:
          "No se puede probar ahora mismo, intenta en unas horas. O contáctanos por WhatsApp y lo arreglamos.",
      });
    }

    // 3) If low inventory, notify (placeholder)
    if (available.length <= MIN_AVAILABLE_ALERT) {
      console.log(`⚠️ Low demo inventory: ${available.length} accounts <= ${THRESH}`);
      // TODO: sendWhatsApp(...)
    }

    // pick lowest cost
    available.sort((a, b) => a.realCost - b.realCost);
    const chosen = available[0];

    return res.json({
      ok: true,
      demoPageId: chosen.pageId,
      publicKey: chosen.vapiPublicKey,
      assistantId: chosen.assistantId,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, message: "Error del servidor. Intenta más tarde." });
  }
});

/**
 * POST /api/vapi-demo/settle (optional)
 * You can keep it simple and recompute total cost again after a call.
 * This endpoint doesn't need callId at all if you just recompute.
 */
app.post("/api/vapi-demo/settle", async (req, res) => {
  try {
    const { demoPageId } = req.body || {};
    if (!demoPageId) return res.status(400).json({ ok: false });

    // Read page to get VAPI private key
    const pageRes = await fetch(`https://api.notion.com/v1/pages/${demoPageId}`, {
      headers: {
        Authorization: `Bearer ${NOTION_API_KEY}`,
        "Notion-Version": "2022-06-28",
      },
    });
    if (!pageRes.ok) throw new Error(`Notion page read failed: ${pageRes.status} ${await pageRes.text()}`);
    const page = await pageRes.json();

    const acc = mapPage(page);
    if (!acc.vapiPrivateKey) throw new Error("Missing VAPI private key on page");

    const realCost = await vapiSumCost(acc.vapiPrivateKey);
    await notionUpdateCost(acc.pageId, realCost);

    return res.json({ ok: true, cost: realCost });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`API running on http://localhost:${port}`));
