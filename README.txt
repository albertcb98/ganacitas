GanaCitas – Cloudflare Pages (static)

Routes:
- / (home)
- /recepcionista/
- /citas/
- /whatsapp/
- /facturas/

Configure:
- assets/app.js -> window.MYAGENCY_CONFIG.n8nStartWebhookUrl
- assets/app.js -> window.MYAGENCY_CONFIG.n8nStatusWebhookUrl (optional polling)
- assets/app.js -> window.MYAGENCY_CONFIG.paymentLinks (Stripe Payment Links)

Deploy:
- Upload this folder to a GitHub repo and connect to Cloudflare Pages
- Or use Direct Upload in Cloudflare Pages (if available)
