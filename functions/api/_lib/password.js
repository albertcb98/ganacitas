// functions/api/_lib/password.js
// Cloudflare-safe PBKDF2 (<= 100000 iterations)

const DEFAULT_ITERATIONS = 100000; // must be <= 100000 in this runtime

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iterations = DEFAULT_ITERATIONS;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(String(password)),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );

  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key,
    256
  );

  return `pbkdf2$${iterations}$${toHex(salt)}$${toHex(new Uint8Array(bits))}`;
}

export async function verifyPassword(password, stored) {
  try {
    const [kind, iterStr, , saltHex, hashHex] = stored.split("$");
    if (kind !== "pbkdf2") return false;

    const iterations = parseInt(iterStr, 10);
    if (!Number.isFinite(iterations) || iterations <= 0) return false;

    // Enforce runtime limit (older hashes might be >100000)
    if (iterations > 100000) return false;

    const salt = fromHex(saltHex);

    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(String(password)),
      { name: "PBKDF2" },
      false,
      ["deriveBits"]
    );

    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
      key,
      256
    );

    const computed = toHex(new Uint8Array(bits));
    return timingSafeEqualHex(computed, hashHex);
  } catch {
    return false;
  }
}

function toHex(u8) {
  return [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex) {
  const u8 = new Uint8Array(hex.length / 2);
  for (let i = 0; i < u8.length; i++) u8[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return u8;
}

function timingSafeEqualHex(a, b) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}
