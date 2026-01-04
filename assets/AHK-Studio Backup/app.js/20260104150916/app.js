/**
 * Minimal JS for:
 * - Modal open/close
 * - Form submit to n8n webhook
 * - Fetch available Vapi demo credentials from YOUR backend
 * - Start Vapi web call in browser after webhook succeeds
 *
 * IMPORTANT:
 * - Do NOT put Notion/Vapi private keys in frontend.
 * - This file expects your backend endpoints:
 *    GET  /api/vapi-demo/select  -> { ok:true, demoPageId, publicKey, assistantId } OR { ok:false, message }
 *    POST /api/vapi-demo/settle  -> (optional) { ok:true }  (best effort)
 */

window.MYAGENCY_CONFIG = window.MYAGENCY_CONFIG || {};
window.MYAGENCY_CONFIG.n8nStartWebhookUrl =
  "https://n8n.worfklow.fun/webhook/ganacitas/start";

// Your backend route that selects an available demo account
window.MYAGENCY_CONFIG.vapiDemoSelectUrl = "/api/vapi-demo/select";
// Optional: settle endpoint after call ends (updates Notion cost, etc.)
window.MYAGENCY_CONFIG.vapiDemoSettleUrl = "/api/vapi-demo/settle";
window.__demoSubmitting = false;

function ensureVapiInstance() {
  if (window.vapiInstance) return window.vapiInstance;

  if (!window.__vapiScriptLoaded || !window.vapiSDK) {
    throw new Error("Vapi script not loaded yet");
  }

  if (!window.VAPI_WEB?.publicKey) {
    throw new Error("Missing VAPI_WEB.publicKey (demo not selected)");
  }
  if (!window.VAPI_WEB?.assistantId) {
    throw new Error("Missing VAPI_WEB.assistantId (demo not selected)");
  }

  // This injects Vapi UI (phone button), so we only do it when user starts a call.
  window.vapiInstance = window.vapiSDK.run({
    apiKey: window.VAPI_WEB.publicKey,
    assistant: window.VAPI_WEB.assistantId,
    config: {},
  });

  return window.vapiInstance;
}

function $(sel, root = document) { return root.querySelector(sel); }
function $all(sel, root = document) { return [...root.querySelectorAll(sel)]; }

function showToast(msg) {
  const t = $("#toast");
  if (!t) return;
  t.textContent = msg;
  t.style.display = "block";
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => { t.style.display = "none"; }, 3600);
}

function openModal(modalId) {
  const b = $(modalId);
  if (!b) return;
  b.style.display = "grid";
  document.body.style.overflow = "hidden";
  const first = b.querySelector("input,select,textarea,button");
  if (first) setTimeout(() => first.focus(), 50);
}

function closeModal(modalId) {
  const b = $(modalId);
  if (!b) return;
  b.style.display = "none";
  document.body.style.overflow = "";
}

async function postJSON(url, payload, headers = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${text}`.trim());
  }

  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return await res.json();
  return { ok: true, text: await res.text().catch(() => "") };
}

// Your existing webhook expects text/plain; keep this separate
async function postPlainJSON(url, payload) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${text}`.trim());
  }

  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return await res.json();
  return { ok: true, text: await res.text().catch(() => "") };
}

function normalizeCompanyName(str) {
  return (str || "").toString().trim().replace(/\s+/g, " ");
}

async function fetchAvailableDemo() {
  const url = window.MYAGENCY_CONFIG.vapiDemoSelectUrl;
  if (!url) throw new Error("Missing MYAGENCY_CONFIG.vapiDemoSelectUrl");

  const res = await fetch(url, { method: "GET" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Demo select failed: HTTP ${res.status} ${text}`.trim());
  }

  const data = await res.json().catch(() => ({}));
  return data;
}

async function settleDemoUsage({ demoPageId, callId }) {
  const url = window.MYAGENCY_CONFIG.vapiDemoSettleUrl;
  if (!url) return;

  try {
    await postJSON(url, { demoPageId, callId });
  } catch (e) {
    // Best-effort only; don't block UX
    console.warn("[Settle] failed:", e);
  }
}

function attachVapiEndHandlers(vapi) {
  // Attach only once
  if (window.__vapiEndHandlerAttached) return;
  window.__vapiEndHandlerAttached = true;

  // Try common event APIs. If your Vapi SDK uses different event names,
  // log events and adjust accordingly.
  const handler = async (evt) => {
    try {
      const callId =
        evt?.call?.id ||
        evt?.callId ||
        evt?.id ||
        window.__lastVapiCallId ||
        null;

      const demoPageId = window.VAPI_WEB?.demoPageId;
      if (demoPageId) {
        await settleDemoUsage({ demoPageId, callId });
      }
    } catch (e) {
      console.warn("[Call End] settle error:", e);
    }
  };

  try {
    if (typeof vapi.on === "function") {
      // Common guesses
      vapi.on("call-end", handler);
      vapi.on("callEnded", handler);
      vapi.on("ended", handler);

      // Capture call id early if available
      vapi.on("call-start", (evt) => {
        const callId = evt?.call?.id || evt?.callId || evt?.id || null;
        if (callId) window.__lastVapiCallId = callId;
      });
      vapi.on("callStarted", (evt) => {
        const callId = evt?.call?.id || evt?.callId || evt?.id || null;
        if (callId) window.__lastVapiCallId = callId;
      });
    }
  } catch (e) {
    console.warn("[Vapi events] failed to attach:", e);
  }
}

function attachDemoHandlers() {
  // Open modal
  $all("[data-open-demo]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const modal = btn.getAttribute("data-open-demo");
      openModal(modal);

      // Prefill service (optional)
      const service = btn.getAttribute("data-service") || "";
      const form = document.querySelector(modal + " form");
      if (form) {
        const svc = form.querySelector("input[name=service]");
        if (svc) svc.value = service;
      }
    });
  });

  // Close modal buttons
  $all("[data-close]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const modal = btn.getAttribute("data-close");
      closeModal(modal);
    });
  });

  // Click outside modal closes
  $all(".modal-backdrop").forEach((backdrop) => {
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) closeModal("#" + backdrop.id);
    });
  });

  // Submit
   // Submit
  $all("form[data-demo-form]").forEach((form) => {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();

      if (window.__demoSubmitting) return;
      window.__demoSubmitting = true;

      const startUrl = window.MYAGENCY_CONFIG.n8nStartWebhookUrl;
      const submitBtn = form.querySelector('button[type="submit"]');
      const originalText = submitBtn ? submitBtn.textContent : "Probar Asistente Telefónico";

      try {
        if (!startUrl) {
          showToast("Configura MYAGENCY_CONFIG.n8nStartWebhookUrl.");
          return;
        }

        const fd = new FormData(form);
        const payload = Object.fromEntries(fd.entries());

        const company = normalizeCompanyName(payload.company);
        if (!company) {
          showToast("Por favor escribe el nombre de tu empresa.");
          const inp = form.querySelector('input[name="company"]');
          if (inp) inp.focus();
          return;
        }
        payload.company = company;

        if (submitBtn) {
          submitBtn.disabled = true;
          submitBtn.textContent = "Procesando…";
        }

        // 1) send to n8n
        await postPlainJSON(startUrl, payload);

        // 2) ask backend for an available demo account (publicKey + assistantId)
        showToast("Buscando un demo disponible…");
        let demo;
        try {
          demo = await fetchAvailableDemo();
        } catch (selErr) {
          console.error(selErr);
          showToast("No se pudo verificar disponibilidad. Intenta de nuevo en unos minutos.");
          return;
        }

        if (!demo || demo.ok !== true) {
          const msg =
            demo?.message ||
            "No se puede probar ahora mismo, intenta en unas horas. O contáctanos por WhatsApp y lo arreglamos.";
          showToast(msg);
          return;
        }

        // Store selected demo config globally
        window.VAPI_WEB = window.VAPI_WEB || {};
        window.VAPI_WEB.publicKey = demo.publicKey;
        window.VAPI_WEB.assistantId = demo.assistantId;
        window.VAPI_WEB.demoPageId = demo.demoPageId;

        // 3) initialize Vapi ONLY now
        let vapi;
        try {
          vapi = ensureVapiInstance();
          attachVapiEndHandlers(vapi);
        } catch (e2) {
          console.error(e2);
          showToast("Cargando el asistente… intenta de nuevo en 1s.");
          return;
        }

        closeModal("#demoModal");
        showToast("Iniciando llamada…");

        // 4) start call safely
        try {
          const result = await vapi.start(window.VAPI_WEB.assistantId, {
            variableValues: { company: payload.company },
          });

          // Best effort: capture callId if returned
          const callId = result?.call?.id || result?.id || result?.callId || null;
          if (callId) window.__lastVapiCallId = callId;

        } catch (startErr) {
          console.error(startErr);
          const msg = (startErr && (startErr.errorMsg || startErr.message)) || "";
          if (msg.toLowerCase().includes("meeting has ended")) {
            showToast("La llamada terminó inmediatamente. Revisa permisos del micrófono y configuración del asistente.");
          } else {
            showToast("No se pudo iniciar la llamada. Revisa la consola.");
          }
          return;
        }

        form.reset();
      } catch (err) {
        console.error(err);
        showToast("Error enviando el formulario. Revisa el webhook.");
      } finally {
        window.__demoSubmitting = false;

        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = originalText;
        }
      }
    });
  });
}
async function getMe() {
  const res = await fetch("/api/auth/me", { method: "GET" });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  return data?.user || null;
}

function attachStripeHandlers() {
  $all("[data-pay-link]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const plan = btn.getAttribute("data-pay-link");
      if (!plan) return;

      // 1) require login
      const me = await getMe();
      if (!me) {
        const next = encodeURIComponent(window.location.pathname + window.location.hash);
        window.location.href = `/register/?next=${next}&plan=${encodeURIComponent(plan)}`;
        return;
      }

      // 2) create checkout
      btn.disabled = true;
      const original = btn.textContent;
      btn.textContent = "Redirigiendo…";

      try {
        const data = await postJSON("/create-checkout", { plan });
        if (data?.url) window.location.href = data.url;
        else showToast("No se pudo crear el checkout.");
      } catch (e) {
        console.error(e);
        showToast("Error creando el pago. Revisa Stripe/Cloudflare logs.");
      } finally {
        btn.disabled = false;
        btn.textContent = original;
      }
    });
  });
}
document.addEventListener("DOMContentLoaded", () => {
  attachDemoHandlers();
  attachStripeHandlers();
  console.log("[App] handlers attached");
});
