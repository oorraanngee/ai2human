export function bufToHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBuf(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMat = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 30000, hash: "SHA-256" },
    keyMat,
    256
  );
  return `${bufToHex(salt)}:${bufToHex(bits)}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || "").split(":");
  if (parts.length !== 2) return false;
  const salt = hexToBuf(parts[0]);
  const expected = hexToBuf(parts[1]);
  const keyMat = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 30000, hash: "SHA-256" },
    keyMat,
    256
  );
  const actual = new Uint8Array(bits);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}

async function getHmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export async function signSessionToken(payloadObj, secret) {
  const json = JSON.stringify(payloadObj);
  const b64 = btoa(unescape(encodeURIComponent(json)));
  const key = await getHmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(b64));
  return `${b64}.${bufToHex(sig)}`;
}

export async function verifySessionToken(token, secret) {
  if (!token || !secret) return null;
  const dot = token.indexOf(".");
  if (dot === -1) return null;
  const b64 = token.slice(0, dot);
  const sigHex = token.slice(dot + 1);
  if (!/^[0-9a-f]+$/i.test(sigHex) || sigHex.length % 2 !== 0) return null;
  try {
    const key = await getHmacKey(secret);
    const ok = await crypto.subtle.verify(
      "HMAC",
      key,
      hexToBuf(sigHex),
      new TextEncoder().encode(b64)
    );
    if (!ok) return null;
    const payload = JSON.parse(decodeURIComponent(escape(atob(b64))));
    if (!payload || !payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

export function parseCookies(req) {
  const raw = req.headers.get("Cookie") || "";
  const out = {};
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

export function makeSessionCookie(token, maxAgeSec) {
  return `ai2human_session=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

export async function getAuthUser(req, env) {
  if (!env.SESSION_SECRET) return null;
  const cookies = parseCookies(req);
  const payload = await verifySessionToken(
    cookies.ai2human_session,
    env.SESSION_SECRET
  );
  if (!payload || !payload.uid) return null;
  const user = await env.DB.prepare(
    "SELECT id, username, role, is_active, created_at FROM users WHERE id = ?"
  )
    .bind(payload.uid)
    .first();
  if (!user || !user.is_active) return null;
  return user;
}
