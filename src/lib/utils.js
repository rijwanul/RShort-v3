export function json(data, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function badRequest(message) {
  return json({ error: message }, { status: 400 });
}

export function notFound(message = "Not found") {
  return json({ error: message }, { status: 404 });
}

// ---------------------------------------------------------------------
// Settings (key/value, JSON-encoded values). Read fresh each time -
// D1 reads are cheap and this keeps the admin UI's "Save" changes
// visible immediately across all requests without a separate cache
// invalidation step.
// ---------------------------------------------------------------------
export async function getSettings(env, keys = null) {
  const rows = keys
    ? await env.DB.prepare(
        `SELECT key, value FROM settings WHERE key IN (${keys.map(() => "?").join(",")})`
      )
        .bind(...keys)
        .all()
    : await env.DB.prepare("SELECT key, value FROM settings").all();
  const out = {};
  for (const row of rows.results) {
    try {
      out[row.key] = JSON.parse(row.value);
    } catch {
      out[row.key] = row.value;
    }
  }
  return out;
}

export async function setSetting(env, key, value) {
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  )
    .bind(key, JSON.stringify(value))
    .run();
}

// ---------------------------------------------------------------------
// Activity log - always written in plain, non-technical language.
// ---------------------------------------------------------------------
export async function logActivity(env, { actorType, actorId, actorLabel, action, message }) {
  await env.DB.prepare(
    `INSERT INTO activity_log (actor_type, actor_id, actor_label, action, message)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(actorType, actorId, actorLabel, action, message)
    .run()
    .catch(() => {});
}

// ---------------------------------------------------------------------
// Slug validation: letters, numbers, underscore, dash only. Case is
// preserved for display but compared case-insensitively via the
// COLLATE NOCASE index/uniqueness on the slug column.
// ---------------------------------------------------------------------
export function isValidSlugFormat(slug) {
  return /^[a-zA-Z0-9_-]+$/.test(slug);
}

export async function isSlugAvailable(env, slug, minChars) {
  if (!isValidSlugFormat(slug)) return { available: false, reason: "invalid_format" };
  if (slug.length < minChars) return { available: false, reason: "too_short" };
  const reserved = await env.DB.prepare(
    "SELECT 1 FROM reserved_keywords WHERE keyword = ? COLLATE NOCASE"
  )
    .bind(slug)
    .first();
  if (reserved) return { available: false, reason: "reserved" };
  const existing = await env.DB.prepare(
    "SELECT 1 FROM urls WHERE slug = ? COLLATE NOCASE AND deleted_at IS NULL"
  )
    .bind(slug)
    .first();
  if (existing) return { available: false, reason: "taken" };
  return { available: true, reason: null };
}

// ---------------------------------------------------------------------
// Referrer bucketing for analytics
// ---------------------------------------------------------------------
const REFERRER_MAP = [
  [/facebook\.com|fb\.com|m\.facebook/i, "facebook"],
  [/google\./i, "google"],
  [/t\.me|telegram\.org|telegram\.me/i, "telegram"],
  [/whatsapp\.com|wa\.me/i, "whatsapp"],
  [/twitter\.com|x\.com|t\.co/i, "twitter/x"],
  [/instagram\.com/i, "instagram"],
];

export function bucketReferrer(referrerHeader) {
  if (!referrerHeader) return "direct";
  for (const [pattern, bucket] of REFERRER_MAP) {
    if (pattern.test(referrerHeader)) return bucket;
  }
  return "other";
}

export function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

// Basic CSV parsing/building good enough for "slug,target" and
// one-keyword-per-line files. Handles quoted fields with commas.
// Parses the bulk-paste shorthand format, one entry per line:
//   slug: target (password)
// The password segment is optional. Example:
//   google: https://google.com (1234)
//   noauth: https://example.org
export function parseBulkPasteLines(text) {
  const rows = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const m = line.match(/^([^:]+):\s*(\S+)(?:\s+\(([^)]*)\))?\s*$/);
    if (!m) continue;
    const slug = m[1].trim();
    const target = m[2].trim();
    const password = m[3] !== undefined ? m[3].trim() : "";
    rows.push([slug, target, password]);
  }
  return rows;
}

export function parseCSV(text) {
  const rows = [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  for (const line of lines) {
    const fields = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          cur += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        fields.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    fields.push(cur);
    rows.push(fields.map((f) => f.trim()));
  }
  return rows;
}

export function csvEscape(value) {
  const s = String(value ?? "");
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
