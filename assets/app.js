/**
 * Minimal JS for:
 * - Modal open/close
 * - Form submit to n8n webhook
 */

window.MYAGENCY_CONFIG = window.MYAGENCY_CONFIG || {};
// ✅ Set your PRODUCTION webhook URL here:
window.MYAGENCY_CONFIG.n8nStartWebhookUrl =
  window.MYAGENCY_CONFIG.n8nStartWebhookUrl ||
  "https://n8n.workflow.fun/webhook/ganacitas/start";

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
    headers: { "Content-Type": "application/json" },
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

      // Optional: prefill "service" if your form has it
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

      // Read form fields
      const fd = new FormData(form);
      const payload = Object.fromEntries(fd.entries());

      // Validate company
      const company = normalizeCompanyName(payload.company);
      if (!company) {
        showToast("Por favor escribe el nombre de tu empresa.");
        const inp = form.querySelector('input[name="company"]');
        if (inp) inp.focus();
        return;
      }
      payload.company = company;

      const submitBtn = form.querySelector('button[type="submit"]');
      const originalText = submitBtn ? submitBtn.textContent : "";

      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = "Procesando…";
      }

      try {
        await postJSON(startUrl, payload);
        showToast("¡Listo! Te contactaremos en breve.");
        closeModal("#demoModal");
        form.reset();
      } catch (err) {
        console.error(err);
        showToast("Error enviando el formulario. Revisa el webhook/CORS.");
      } finally {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = originalText || "Probar Asistente Telefónico";
        }
      }
    });
  });
}

document.addEventListener("DOMContentLoaded", attachDemoHandlers);
