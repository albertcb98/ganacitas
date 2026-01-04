import { clearCookie } from "../_lib/cookies.js";

export async function onRequestPost() {
  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": clearCookie("session"),
    },
  });
}
