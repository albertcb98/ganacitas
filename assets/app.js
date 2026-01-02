/**
 * Minimal JS for:
 * - Modal open/close
 * - Form submit to n8n webhook
 * - Start Vapi web call in browser after webhook succeeds
 */

window.MYAGENCY_CONFIG = window.MYAGENCY_CONFIG || {};
window.MYAGENCY_CONFIG.n8nStartWebhookUrl =
  "https://n8n.worfklow.fun/webhook/ganacitas/start";

function ensureVapiInstance() {
  if (window.vapiInstance) return window.vapiInstance;

  if (!window.__vapiScriptLoaded || !window.vapiSDK) {
    throw new Error("Vapi script not loaded yet");
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

async function postJSON(url, payload) {
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
  $all("form[data-demo-form]").forEach((form) => {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();

      const startUrl = window.MYAGENCY_CONFIG.n8nStartWebhookUrl;
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

      const submitBtn = form.querySelector('button[type="submit"]');
      const originalText = submitBtn ? submitBtn.textContent : "Probar Asistente Telefónico";

      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = "Procesando…";
      }

      try {
        // 1) send to n8n
        await postJSON(startUrl, payload);

        const assistantId = window.VAPI_WEB?.assistantId;
        if (!assistantId) {
          showToast("Falta assistantId.");
          return;
        }

        // 2) initialize Vapi ONLY now (so no floating button before submit)
        let vapi;
        try {
          vapi = ensureVapiInstance();
        } catch (e2) {
          console.error(e2);
          showToast("Cargando el asistente… intenta de nuevo en 1s.");
          return;
        }

        closeModal("#demoModal");
        showToast("Iniciando llamada…");

        // 3) start call safely
        try {
          await vapi.start(assistantId, {
            variableValues: { company: payload.company },
          });
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
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = originalText;
        }
      }
    });
  });
}

document.addEventListener("DOMContentLoaded", () => {
  attachDemoHandlers();
  console.log("[App] handlers attached");
});
