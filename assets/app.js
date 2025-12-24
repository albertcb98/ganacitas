/**
 * Minimal JS for:
 * - Modal open/close
 * - Demo form submit to N8N webhook (placeholder)
 * - Optional polling endpoint for demo_id results (placeholder)
 *
 * Configure your endpoints in window.MYAGENCY_CONFIG below or via data attributes.
 */

window.MYAGENCY_CONFIG = window.MYAGENCY_CONFIG || {
  // Set these later:
  n8nStartWebhookUrl: "",         // e.g. https://YOUR-N8N/webhook/demo-start
  n8nStatusWebhookUrl: "",        // e.g. https://YOUR-N8N/webhook/demo-status?demo_id=
  // Stripe Payment Links (optional):
  paymentLinks: {
    // Example keys: recepcionista_monthly, recepcionista_annual, ...
  }
};

function $(sel, root=document){ return root.querySelector(sel); }
function $all(sel, root=document){ return [...root.querySelectorAll(sel)]; }

function showToast(msg){
  const t = $("#toast");
  if(!t) return;
  t.textContent = msg;
  t.style.display = "block";
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(()=>{ t.style.display = "none"; }, 3600);
}

function openModal(modalId){
  const b = $(modalId);
  if(!b) return;
  b.style.display = "grid";
  document.body.style.overflow = "hidden";
  const first = b.querySelector("input,select,textarea,button");
  if(first) setTimeout(()=>first.focus(), 50);
}
function closeModal(modalId){
  const b = $(modalId);
  if(!b) return;
  b.style.display = "none";
  document.body.style.overflow = "";
}

async function postJSON(url, payload){
  const res = await fetch(url, {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify(payload)
  });
  if(!res.ok){
    const text = await res.text().catch(()=> "");
    throw new Error(`HTTP ${res.status} ${text}`.trim());
  }
  const ct = res.headers.get("content-type") || "";
  if(ct.includes("application/json")) return await res.json();
  return { ok:true, text: await res.text().catch(()=> "") };
}

async function pollStatus(baseUrl, demoId, onUpdate){
  // baseUrl is something like https://.../webhook/demo-status?demo_id=
  const maxMs = 120000; // 2 mins
  const start = Date.now();
  while(Date.now() - start < maxMs){
    const res = await fetch(baseUrl + encodeURIComponent(demoId), { method:"GET" });
    if(res.ok){
      const data = await res.json().catch(()=>null);
      if(data){
        onUpdate?.(data);
        if(data.status === "ready" || data.status === "failed") return data;
      }
    }
    await new Promise(r=>setTimeout(r, 1800));
  }
  return { status:"timeout" };
}

function attachDemoHandlers(){
  $all("[data-open-demo]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const modal = btn.getAttribute("data-open-demo");
      openModal(modal);
      // prefill service
      const service = btn.getAttribute("data-service") || "";
      const form = document.querySelector(modal + " form");
      if(form){
        const svc = form.querySelector("input[name=service]");
        if(svc) svc.value = service;
      }
    });
  });

  $all("[data-close]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const modal = btn.getAttribute("data-close");
      closeModal(modal);
    });
  });

  $all(".modal-backdrop").forEach(backdrop=>{
    backdrop.addEventListener("click", (e)=>{
      if(e.target === backdrop){
        closeModal("#" + backdrop.id);
      }
    });
  });

  $all("form[data-demo-form]").forEach(form=>{
    form.addEventListener("submit", async (e)=>{
      e.preventDefault();
      const startUrl = window.MYAGENCY_CONFIG.n8nStartWebhookUrl;
      if(!startUrl){
        showToast("Configura MYAGENCY_CONFIG.n8nStartWebhookUrl para activar el demo.");
        return;
      }
      const fd = new FormData(form);
      const payload = Object.fromEntries(fd.entries());
      const submitBtn = form.querySelector("button[type=submit]");
      if(submitBtn){ submitBtn.disabled = true; submitBtn.textContent = "Procesando…"; }

      try{
        // Expecting { demo_id: "..." } from n8n
        const out = await postJSON(startUrl, payload);
        const demoId = out.demo_id || out.demoId || out.id;
        if(!demoId){
          showToast("Demo iniciado, pero falta demo_id en la respuesta de n8n.");
          console.log(out);
          return;
        }

        // show results block
        const result = form.closest(".modal").querySelector("[data-demo-result]");
        if(result){
          result.style.display = "block";
          const demoIdEl = result.querySelector("[data-demo-id]");
          if(demoIdEl) demoIdEl.textContent = demoId;
        }

        const statusBase = window.MYAGENCY_CONFIG.n8nStatusWebhookUrl;
        if(statusBase){
          showToast("Creando el evento en el calendario…");
          const final = await pollStatus(statusBase, demoId, (data)=>{
            // optional live updates
            const st = result?.querySelector("[data-demo-status]");
            if(st && data.status) st.textContent = data.status;
          });

          if(final.status === "ready" && final.event){
            const ev = final.event;
            const box = result?.querySelector("[data-event-box]");
            if(box){
              box.style.display = "block";
              box.querySelector("[data-ev-title]").textContent = ev.title || "Evento creado";
              box.querySelector("[data-ev-time]").textContent = ev.time || ev.start || "";
              const link = box.querySelector("[data-ev-link]");
              if(link && ev.link){ link.href = ev.link; link.style.display="inline-flex"; }
            }
            showToast("¡Evento creado! ✅");
          }else if(final.status === "failed"){
            showToast("No se pudo completar el demo. Inténtalo de nuevo.");
          }else if(final.status === "timeout"){
            showToast("El demo tarda más de lo esperado. Revisa el estado con tu equipo.");
          }
        }else{
          showToast("Demo iniciado. (Opcional) Configura n8nStatusWebhookUrl para mostrar el evento.");
        }
      }catch(err){
        console.error(err);
        showToast("Error iniciando el demo. Revisa la URL del webhook y CORS.");
      }finally{
        if(submitBtn){ submitBtn.disabled = false; submitBtn.textContent = "Probar demo"; }
      }
    });
  });

  // Payment links
  $all("[data-pay-link]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const key = btn.getAttribute("data-pay-link");
      const url = window.MYAGENCY_CONFIG.paymentLinks?.[key];
      if(!url){
        showToast("Añade tu Stripe Payment Link en MYAGENCY_CONFIG.paymentLinks['"+key+"'].");
        return;
      }
      window.location.href = url;
    });
  });
}

document.addEventListener("DOMContentLoaded", attachDemoHandlers);
