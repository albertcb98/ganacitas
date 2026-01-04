import { getCookie } from "./cookies.js";
import { verifyJWT } from "./jwt.js";

export async function getSessionUser(request, env) {
  const token = getCookie(request, "session");
  if (!token) return null;

  const payload = await verifyJWT(env.JWT_SECRET, token);
  if (!payload?.sub || !payload?.email) return null;

  return { id: payload.sub, email: payload.email };
}
