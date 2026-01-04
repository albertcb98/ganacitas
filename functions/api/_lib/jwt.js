function b64urlEncode(bytes) {
  let str = btoa(String.fromCharCode(...bytes));
  return str.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function b64urlDecodeToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  return new Uint8Array([...bin].map((c) => c.charCodeAt(0)));
}
function textToBytes(t) {
  return new TextEncoder().encode(t);
}

async function hmacSign(secret, data) {
  const key = await crypto.subtle.importKey(
    "raw",
    textToBytes(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, textToBytes(data));
  return new Uint8Array(sig);
}

export async function signJWT(secret, payload, { expiresInSec = 60 * 60 * 24 * 7 } = {}) {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + expiresInSec };

  const h = b64urlEncode(textToBytes(JSON.stringify(header)));
  const p = b64urlEncode(textToBytes(JSON.stringify(body)));
  const signingInput = `${h}.${p}`;

  const sig = await hmacSign(secret, signingInput);
  const s = b64urlEncode(sig);
  return `${signingInput}.${s}`;
}

export async function verifyJWT(secret, token) {
  try {
    const [h, p, s] = token.split(".");
    if (!h || !p || !s) return null;

    const signingInput = `${h}.${p}`;
    const expected = await hmacSign(secret, signingInput);
    const got = b64urlDecodeToBytes(s);

    // constant-time-ish compare
    if (expected.length !== got.length) return null;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ got[i];
    if (diff !== 0) return null;

    const payloadJson = new TextDecoder().decode(b64urlDecodeToBytes(p));
    const payload = JSON.parse(payloadJson);

    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && now > payload.exp) return null;

    return payload;
  } catch {
    return null;
  }
}
