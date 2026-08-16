import { verifyJWT, signJWT, sha256Hex } from "./crypto.js";

const COOKIE_NAME = "rs3_token";
const TOKEN_TTL_SECONDS = 60 * 60; // 1 hour; frontend silently refreshes

export function getCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  const match = header.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export function setAuthCookie(headers, token) {
  headers.append(
    "Set-Cookie",
    `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${TOKEN_TTL_SECONDS}`
  );
}

export function clearAuthCookie(headers) {
  headers.append(
    "Set-Cookie",
    `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
  );
}

export async function issueToken(env, user) {
  return signJWT(
    {
      uid: user.id,
      isRoot: !!user.is_root,
      parentId: user.parent_id || null,
      tokenVersion: user.token_version,
    },
    env.JWT_SECRET,
    TOKEN_TTL_SECONDS
  );
}

// Verifies the JWT, then re-checks enabled/token_version against D1 so a
// disabled account or a forced logout (permission change, password
// reset) takes effect immediately instead of waiting for the token to
// expire. This costs one indexed lookup per authenticated request,
// which is the trade-off we made for using a stateless JWT.
export async function getCurrentUser(request, env) {
  const token = getCookie(request, COOKIE_NAME);
  if (!token) return null;
  const payload = await verifyJWT(token, env.JWT_SECRET);
  if (!payload) return null;
  const row = await env.DB.prepare(
    "SELECT * FROM users WHERE id = ?"
  )
    .bind(payload.uid)
    .first();
  if (!row) return null;
  if (!row.enabled) return null;
  if (row.token_version !== payload.tokenVersion) return null;
  return row;
}

// API key auth for the public /api/checkAvailability, /api/newEntry,
// /api/deleteEntry endpoints. Keys inherit the owning user's
// permissions in full.
export async function getUserFromApiKey(request, env) {
  const header = request.headers.get("Authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  const rawKey = match ? match[1] : request.headers.get("X-Api-Key");
  if (!rawKey) return null;
  const keyHash = await sha256Hex(rawKey);
  const keyRow = await env.DB.prepare(
    "SELECT * FROM api_keys WHERE key_hash = ? AND enabled = 1"
  )
    .bind(keyHash)
    .first();
  if (!keyRow) return null;
  const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?")
    .bind(keyRow.user_id)
    .first();
  if (!user || !user.enabled) return null;
  env.DB.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?")
    .bind(keyRow.id)
    .run()
    .catch(() => {});
  return { user, apiKey: keyRow };
}

export function unauthorized(message = "Not authenticated") {
  return new Response(JSON.stringify({ error: message }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}

export function forbidden(message = "Not allowed") {
  return new Response(JSON.stringify({ error: message }), {
    status: 403,
    headers: { "Content-Type": "application/json" },
  });
}
