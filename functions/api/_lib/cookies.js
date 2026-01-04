export function getCookie(request, name) {
  const cookie = request.headers.get("Cookie") || "";
  const parts = cookie.split(";").map((p) => p.trim());
  for (const p of parts) {
    if (p.startsWith(name + "=")) return decodeURIComponent(p.slice(name.length + 1));
  }
  return null;
}

export function makeSessionCookie(token) {
  // 7 days
  return `session=${encodeURIComponent(token)}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=604800`;
}

export function clearSessionCookie() {
  return `session=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0`;
}
