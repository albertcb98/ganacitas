import { clearCookie } from "../_lib/cookies.js";

export async function onRequestPost({ request }) {
  const isHttps = new URL(request.url).protocol === "https:";
  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": clearCookie("session", { secure: isHttps }),
    },
  });
}
