// /functions/api/_lib/cookies.js

export function parseCookies(request) {
  const h = request.headers.get("Cookie") || "";
  const out = {};
  h.split(";").forEach((part) => {
    const [k, ...v] = part.trim().split("=");
    if (!k) return;
    out[k] = decodeURIComponent(v.join("=") || "");
  });
  return out;
}

export function setCookie(name, value, opts = {}) {
  const {
    path = "/",
    httpOnly = true,
    secure = true,
    sameSite = "Lax",
    maxAge,          // seconds
    expires,         // Date
  } = opts;

  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, `SameSite=${sameSite}`];
  if (httpOnly) parts.push("HttpOnly");
  if (secure) parts.push("Secure");
  if (typeof maxAge === "number") parts.push(`Max-Age=${maxAge}`);
  if (expires instanceof Date) parts.push(`Expires=${expires.toUTCString()}`);
  return parts.join("; ");
}

export function clearCookie(name, opts = {}) {
  return setCookie(name, "", { ...opts, maxAge: 0 });
}

// Optional convenience (use this instead of setCookie if you want)
export function makeSessionCookie(jwt) {
  return setCookie("session", jwt, { maxAge: 60 * 60 * 24 * 7 }); // 7 days
}
