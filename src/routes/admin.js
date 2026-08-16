import { json, badRequest, getSettings, setSetting, logActivity, parseCSV, parseBulkPasteLines, csvEscape, isSlugAvailable } from "../lib/utils.js";
import { hasPermission } from "../lib/permissions.js";
import { randomToken, sha256Hex, randomSlug } from "../lib/crypto.js";
import { emailIsConfigured, sendTestEmail } from "../lib/email.js";

// ---------------------------------------------------------------------
// Site Analytics (admin) - totals for the whole site, referrer
// breakdown for the "visits by referrer" chart.
// ---------------------------------------------------------------------
export async function handleSiteAnalytics(request, env, user) {
  if (!user.is_root && !hasPermission(user, "admin.site_analytics")) {
    return badRequest("You don't have permission to view site analytics.");
  }

  const [apiKeys, users, urls, fullIframe, customPreview, visits, referrers] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) as c FROM api_keys").first(),
    env.DB.prepare(
      "SELECT is_root, parent_id FROM users"
    ).all(),
    env.DB.prepare("SELECT COUNT(*) as c FROM urls WHERE deleted_at IS NULL").first(),
    env.DB.prepare("SELECT COUNT(*) as c FROM urls WHERE deleted_at IS NULL AND full_iframe = 1").first(),
    env.DB.prepare("SELECT COUNT(*) as c FROM urls WHERE deleted_at IS NULL AND social_enabled = 1").first(),
    env.DB.prepare("SELECT COUNT(*) as c FROM hit_logs").first(),
    env.DB.prepare(
      "SELECT referrer_bucket, COUNT(*) as count FROM hit_logs GROUP BY referrer_bucket ORDER BY count DESC LIMIT 15"
    ).all(),
  ]);

  let totalAdmins = 0;
  let totalSubusers = 0;
  let totalUsers = 0;
  for (const u of users.results) {
    if (u.is_root) totalAdmins++;
    else if (u.parent_id) totalSubusers++;
    else totalUsers++;
  }

  return json({
    totalApiKeys: apiKeys.c,
    totalUsers,
    totalSubusers,
    totalAdmins,
    totalUrls: urls.c,
    totalFullIframe: fullIframe.c,
    totalCustomPreview: customPreview.c,
    totalVisits: visits.c,
    topReferrers: referrers.results,
  });
}

// ---------------------------------------------------------------------
// Public site info (safe subset, no secrets) - used by the homepage and
// login/register pages.
// ---------------------------------------------------------------------
export async function handleSiteInfo(request, env) {
  const settings = await getSettings(env, [
    "site_title",
    "theme_color",
    "logo_url",
    "favicon_url",
    "social_image_url",
    "homepage_notice",
    "homepage_button_label",
    "homepage_button_url",
    "homepage_button_new_tab",
    "homepage_show_login",
    "registration_enabled",
    "registration_show_on_homepage",
    "forgot_password_enabled",
    "slug_min_chars",
    "subusers_feature_enabled",
  ]);
  settings.emailConfigured = await emailIsConfigured(env);
  const imgbb = await getSettings(env, ["imgbb_api_key"]);
  settings.imgbbConfigured = !!(imgbb.imgbb_api_key && imgbb.imgbb_api_key.trim());
  return json(settings);
}

// ---------------------------------------------------------------------
// Per-user Error Page settings (404 / disabled-link pages). Gated by
// error_settings.edit for non-root users; falls back to site defaults
// wherever a field is left blank (see redirect.js).
// ---------------------------------------------------------------------
export async function handleGetErrorSettings(request, env, user) {
  if (!user.is_root && !hasPermission(user, "error_settings.edit")) {
    return badRequest("You don't have permission to customize error pages.");
  }
  const row = await env.DB.prepare("SELECT error_settings FROM users WHERE id = ?").bind(user.id).first();
  let settings = {};
  try {
    settings = JSON.parse((row && row.error_settings) || "{}");
  } catch {
    settings = {};
  }

  let inherited = { source: "site" };
  if (user.parent_id) {
    const parent = await env.DB.prepare("SELECT error_settings FROM users WHERE id = ?").bind(user.parent_id).first();
    try {
      const parentSettings = JSON.parse((parent && parent.error_settings) || "{}");
      if (parentSettings.errorEnabled !== false && parentSettings.disabledText) {
        inherited = { source: "parent", disabledText: parentSettings.disabledText };
      }
    } catch {
      // fall through to site default
    }
  }
  if (inherited.source === "site") {
    const site = await getSettings(env, ["default_disabled_text"]);
    inherited.disabledText = site.default_disabled_text;
  }

  return json({ ...settings, inherited });
}

export async function handleUpdateErrorSettings(request, env, user) {
  if (!user.is_root && !hasPermission(user, "error_settings.edit")) {
    return badRequest("You don't have permission to customize error pages.");
  }
  const body = await request.json().catch(() => ({}));
  const allowed = [
    "errorEnabled",
    "errorText",
    "errorButtonLabel",
    "errorButtonUrl",
    "disabledText",
    "disabledButtonLabel",
    "disabledButtonUrl",
  ];
  const settings = {};
  for (const key of allowed) {
    if (body[key] !== undefined) settings[key] = body[key];
  }
  const settingsJson = JSON.stringify(settings);
  await env.DB.prepare("UPDATE users SET error_settings = ? WHERE id = ?")
    .bind(settingsJson, user.id)
    .run();

  let propagatedCount = 0;
  if (body.propagate) {
    if (user.is_root) {
      // Admin: replace error settings for every non-root user site-wide.
      const res = await env.DB.prepare("UPDATE users SET error_settings = ? WHERE is_root = 0").bind(settingsJson).run();
      propagatedCount = res.meta.changes || 0;
    } else if (!user.parent_id) {
      // A top-level (parent) user: replace error settings for their own sub-users.
      const res = await env.DB.prepare("UPDATE users SET error_settings = ? WHERE parent_id = ?")
        .bind(settingsJson, user.id)
        .run();
      propagatedCount = res.meta.changes || 0;
    }
  }

  await logActivity(env, {
    actorType: "user",
    actorId: user.id,
    actorLabel: user.username,
    action: "error_settings.update",
    message: `${user.username} updated their error page settings${propagatedCount > 0 ? ` and applied them to ${propagatedCount} ${user.is_root ? "user(s) site-wide" : "sub-user(s)"}` : ""}.`,
  });

  return json({ ok: true, propagatedCount });
}

// ---------------------------------------------------------------------
// Test email - lets an admin verify a configured channel (webhook or
// Resend) actually delivers, using a real template rendered with
// placeholder values.
// ---------------------------------------------------------------------
export async function handleSendTestEmail(request, env, user) {
  if (!user.is_root && !hasPermission(user, "admin.site_apis")) {
    return badRequest("You don't have permission to send test emails.");
  }
  const body = await request.json().catch(() => ({}));
  const { to, templateKey, via } = body;
  if (!to || !templateKey || !via) {
    return badRequest("Provide a recipient, a template, and which API to send through.");
  }

  const result = await sendTestEmail(env, { to, templateKey, via });

  await logActivity(env, {
    actorType: "user",
    actorId: user.id,
    actorLabel: user.username,
    action: "email_templates.test_send",
    message: `${user.username} sent a test email (${templateKey} via ${via}) to ${to}${result.ok ? "" : " (failed)"}.`,
  });

  if (!result.ok) return badRequest(result.error || "Failed to send test email.");
  return json({ ok: true });
}

// ---------------------------------------------------------------------
// Site settings
// ---------------------------------------------------------------------
const SETTINGS_GROUPS = {
  general: ["site_title", "theme_color", "logo_url", "favicon_url", "social_image_url", "slug_min_chars", "subusers_feature_enabled"],
  homepage: [
    "homepage_notice",
    "homepage_button_label",
    "homepage_button_url",
    "homepage_button_new_tab",
    "homepage_show_login",
  ],
  registration: [
    "registration_enabled",
    "registration_show_on_homepage",
    "registration_auto_approve",
    "registration_domain_mode",
    "registration_domain_list",
  ],
  auth: ["forgot_password_enabled", "login_lockout_enabled"],
  apis: ["imgbb_api_key", "email_webhook_url", "resend_api_key", "resend_from_email"],
  errorDefaults: [
    "default_error_text",
    "default_error_button_label",
    "default_error_button_url",
    "default_disabled_text",
    "default_disabled_button_label",
    "default_disabled_button_url",
  ],
};

export async function handleGetSettings(request, env, user) {
  if (!user.is_root && !hasPermission(user, "admin.site_settings") && !hasPermission(user, "admin.site_apis")) {
    return badRequest("You don't have permission to view site settings.");
  }
  const allKeys = Object.values(SETTINGS_GROUPS).flat();
  const settings = await getSettings(env, allKeys);
  return json(settings);
}

export async function handleUpdateSettings(request, env, user) {
  const body = await request.json().catch(() => ({}));
  const apiKeys = new Set(SETTINGS_GROUPS.apis);
  const isApiOnly = Object.keys(body).every((k) => apiKeys.has(k));

  if (isApiOnly) {
    if (!user.is_root && !hasPermission(user, "admin.site_apis")) {
      return badRequest("You don't have permission to edit site APIs.");
    }
  } else if (!user.is_root && !hasPermission(user, "admin.site_settings")) {
    return badRequest("You don't have permission to edit site settings.");
  }

  const allKeys = new Set(Object.values(SETTINGS_GROUPS).flat());
  const previous = await getSettings(env, ["subusers_feature_enabled"]);
  for (const [key, value] of Object.entries(body)) {
    if (!allKeys.has(key)) continue;
    await setSetting(env, key, value);
  }

  await logActivity(env, {
    actorType: "user",
    actorId: user.id,
    actorLabel: user.username,
    action: "settings.update",
    message: `${user.username} updated site settings.`,
  });

  const response = { ok: true };

  // Sub-user module turned OFF site-wide: if any sub-users still exist,
  // tell the frontend so it can show ONE bulk popup (convert / suspend
  // / delete) applied to all of them at once.
  const turnedOff =
    body.subusers_feature_enabled === false && previous.subusers_feature_enabled !== false;
  if (turnedOff) {
    const count = (
      await env.DB.prepare("SELECT COUNT(*) as c FROM users WHERE parent_id IS NOT NULL").first()
    ).c;
    if (count > 0) {
      response.subuserGlobalActionRequired = true;
      response.affectedCount = count;
    }
  }

  // Sub-user module turned ON site-wide (from off): offer to unsuspend
  // every currently-suspended sub-user, and optionally their links.
  const turnedOn =
    body.subusers_feature_enabled === true && previous.subusers_feature_enabled === false;
  if (turnedOn) {
    const suspendedCount = (
      await env.DB.prepare("SELECT COUNT(*) as c FROM users WHERE parent_id IS NOT NULL AND enabled = 0").first()
    ).c;
    if (suspendedCount > 0) {
      response.subuserGlobalUnsuspendAvailable = true;
      response.suspendedCount = suspendedCount;
    }
  }

  return json(response);
}

// ---------------------------------------------------------------------
// Email templates (welcome, password_reset, forgot_password,
// account_disabled) - editable subject/body plus an on/off toggle per
// event.
// ---------------------------------------------------------------------
export async function handleListEmailTemplates(request, env, user) {
  if (!user.is_root && !hasPermission(user, "admin.site_apis")) {
    return badRequest("You don't have permission to view email templates.");
  }
  const rows = await env.DB.prepare("SELECT * FROM email_templates ORDER BY key ASC").all();
  return json({ templates: rows.results });
}

export async function handleUpdateEmailTemplates(request, env, user) {
  if (!user.is_root && !hasPermission(user, "admin.site_apis")) {
    return badRequest("You don't have permission to edit email templates.");
  }
  const body = await request.json().catch(() => ({}));
  const templates = Array.isArray(body.templates) ? body.templates : [];
  const validKeys = new Set(["welcome", "password_reset", "forgot_password", "account_disabled"]);

  for (const t of templates) {
    if (!validKeys.has(t.key)) continue;
    await env.DB.prepare(
      "UPDATE email_templates SET subject = ?, body = ?, enabled = ? WHERE key = ?"
    )
      .bind(t.subject || "", t.body || "", t.enabled ? 1 : 0, t.key)
      .run();
  }

  await logActivity(env, {
    actorType: "user",
    actorId: user.id,
    actorLabel: user.username,
    action: "email_templates.update",
    message: `${user.username} updated the site's email templates.`,
  });

  return json({ ok: true });
}

// ---------------------------------------------------------------------
// Reserved keywords
// ---------------------------------------------------------------------
export async function handleListReservedKeywords(request, env, user) {
  const rows = await env.DB.prepare("SELECT * FROM reserved_keywords ORDER BY keyword ASC").all();
  return json({ keywords: rows.results });
}

function requireReservedPermission(user) {
  return user.is_root || hasPermission(user, "admin.reserved_keywords");
}

export async function handleAddReservedKeyword(request, env, user) {
  if (!requireReservedPermission(user)) return badRequest("You don't have permission to manage reserved keywords.");
  const body = await request.json().catch(() => ({}));
  const keyword = (body.keyword || "").trim();
  if (!keyword) return badRequest("Keyword is required.");
  await env.DB.prepare("INSERT OR IGNORE INTO reserved_keywords (keyword) VALUES (?)").bind(keyword).run();
  await logActivity(env, {
    actorType: "user",
    actorId: user.id,
    actorLabel: user.username,
    action: "reserved.add",
    message: `${user.username} added "${keyword}" to reserved keywords.`,
  });
  return json({ ok: true });
}

export async function handleDeleteReservedKeyword(request, env, user, id) {
  if (!requireReservedPermission(user)) return badRequest("You don't have permission to manage reserved keywords.");
  await env.DB.prepare("DELETE FROM reserved_keywords WHERE id = ?").bind(id).run();
  await logActivity(env, {
    actorType: "user",
    actorId: user.id,
    actorLabel: user.username,
    action: "reserved.delete",
    message: `${user.username} removed a reserved keyword.`,
  });
  return json({ ok: true });
}

export async function handleImportReservedKeywords(request, env, user) {
  if (!requireReservedPermission(user)) return badRequest("You don't have permission to manage reserved keywords.");
  const body = await request.json().catch(() => ({}));
  const text = body.text || "";
  const words = text
    .split(/\r?\n/)
    .map((w) => w.trim())
    .filter(Boolean);
  if (!words.length) return badRequest("No keywords found to import.");
  const stmts = words.map((w) =>
    env.DB.prepare("INSERT OR IGNORE INTO reserved_keywords (keyword) VALUES (?)").bind(w)
  );
  await env.DB.batch(stmts);
  await logActivity(env, {
    actorType: "user",
    actorId: user.id,
    actorLabel: user.username,
    action: "reserved.import",
    message: `${user.username} imported ${words.length} reserved keyword(s).`,
  });
  return json({ ok: true, imported: words.length });
}

export async function handleExportReservedKeywords(request, env, user) {
  if (!requireReservedPermission(user)) return badRequest("You don't have permission to manage reserved keywords.");
  const rows = await env.DB.prepare("SELECT keyword FROM reserved_keywords ORDER BY keyword ASC").all();
  const text = rows.results.map((r) => r.keyword).join("\n");
  return new Response(text, {
    headers: {
      "Content-Type": "text/plain",
      "Content-Disposition": 'attachment; filename="reserved-keywords.txt"',
    },
  });
}

// ---------------------------------------------------------------------
// Activity log
// ---------------------------------------------------------------------
// Maps the action's prefix to one of the three UI-facing categories.
// Falls back to "other" for anything unrecognized so a new action
// added later doesn't silently vanish from every filter - it just
// shows up under no category filter (i.e. only in the unfiltered view).
function actionCategory(action) {
  if (!action) return "other";
  if (
    action.startsWith("auth.") ||
    action.startsWith("user.") ||
    action.startsWith("apikey.")
  ) {
    return "account";
  }
  if (
    action.startsWith("error_settings.") ||
    action.startsWith("settings.") ||
    action.startsWith("reserved.") ||
    action.startsWith("email_templates.")
  ) {
    return "settings";
  }
  if (action.startsWith("url.")) return "links";
  return "other";
}

export async function handleActivityLog(request, env, user) {
  if (!user.is_root && !hasPermission(user, "admin.activity_log") && !hasPermission(user, "activity_log.view")) {
    return badRequest("You don't have permission to view the activity log.");
  }
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "100", 10), 500);
  const who = url.searchParams.get("who"); // actor_id, optional
  const category = url.searchParams.get("category"); // 'account' | 'settings' | 'links', optional

  let rows;
  if (user.is_root || hasPermission(user, "admin.activity_log")) {
    if (who) {
      rows = await env.DB.prepare("SELECT * FROM activity_log WHERE actor_id = ? ORDER BY created_at DESC LIMIT ?")
        .bind(who, limit)
        .all();
    } else {
      rows = await env.DB.prepare("SELECT * FROM activity_log ORDER BY created_at DESC LIMIT ?")
        .bind(limit)
        .all();
    }
  } else {
    // Scoped: only this user's + their sub-users' + their API keys' activity.
    const subs = await env.DB.prepare("SELECT id FROM users WHERE parent_id = ?").bind(user.id).all();
    const scopedIds = [user.id, ...subs.results.map((s) => s.id)];
    const ids = who && scopedIds.map(String).includes(String(who)) ? [who] : scopedIds;
    const placeholders = ids.map(() => "?").join(",");
    rows = await env.DB.prepare(
      `SELECT * FROM activity_log WHERE actor_id IN (${placeholders}) ORDER BY created_at DESC LIMIT ?`
    )
      .bind(...ids, limit)
      .all();
  }

  let entries = rows.results;
  if (category) {
    entries = entries.filter((e) => actionCategory(e.action) === category);
  }

  return json({ entries });
}

// ---------------------------------------------------------------------
// External tools
// ---------------------------------------------------------------------
export async function handleListTools(request, env, user) {
  const ownerIds = [user.id];
  if (user.parent_id) ownerIds.push(user.parent_id); // sub-users also see their parent's tools
  const placeholders = ownerIds.map(() => "?").join(",");
  // A hide applies to the top-level user's own scope: check the user's
  // own id, and if they're a sub-user, their parent's hides too.
  const hideCheckIds = user.parent_id ? [user.id, user.parent_id] : [user.id];
  const hidePlaceholders = hideCheckIds.map(() => "?").join(",");
  const rows = await env.DB.prepare(
    `SELECT * FROM external_tools
     WHERE (owner_id IS NULL OR owner_id IN (${placeholders}))
       AND id NOT IN (SELECT tool_id FROM hidden_external_tools WHERE user_id IN (${hidePlaceholders}))
     ORDER BY id ASC`
  )
    .bind(...ownerIds, ...hideCheckIds)
    .all();
  return json({ tools: rows.results });
}

export async function handleCreateTool(request, env, user) {
  const isGlobal = user.is_root && (await request.clone().json().catch(() => ({}))).global;
  if (isGlobal && !hasPermission(user, "admin.external_tools_default") && !user.is_root) {
    return badRequest("You don't have permission to manage default external tools.");
  }
  if (!isGlobal && !hasPermission(user, "tools.manage") && !user.is_root) {
    return badRequest("You don't have permission to manage external tools.");
  }
  const body = await request.json().catch(() => ({}));
  if (!body.title || !body.url) return badRequest("Title and URL are required.");
  const result = await env.DB.prepare(
    "INSERT INTO external_tools (title, url, owner_id) VALUES (?, ?, ?)"
  )
    .bind(body.title, body.url, isGlobal ? null : user.id)
    .run();
  return json({ ok: true, id: result.meta.last_row_id });
}

export async function handleDeleteTool(request, env, user, id) {
  const tool = await env.DB.prepare("SELECT * FROM external_tools WHERE id = ?").bind(id).first();
  if (!tool) return badRequest("Tool not found.");
  if (tool.owner_id === null) {
    if (user.is_root || hasPermission(user, "admin.external_tools_default")) {
      // Root, or a non-root user with the default-tools admin permission: true site-wide delete.
      await env.DB.prepare("DELETE FROM external_tools WHERE id = ?").bind(id).run();
      return json({ ok: true });
    }
    if (!user.parent_id) {
      // A top-level (parent) user without that admin permission: hide
      // this site-wide tool for themselves and their sub-users only.
      await env.DB.prepare("INSERT OR IGNORE INTO hidden_external_tools (user_id, tool_id) VALUES (?, ?)")
        .bind(user.id, id)
        .run();
      return json({ ok: true, hidden: true });
    }
    return badRequest("You cannot remove this tool.");
  } else if (tool.owner_id !== user.id) {
    return badRequest("You cannot delete this tool.");
  }
  await env.DB.prepare("DELETE FROM external_tools WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

// ---------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------
export async function handleListApiKeys(request, env, user) {
  if (!user.is_root && !hasPermission(user, "api.access")) {
    return badRequest("You don't have permission to use the API.");
  }
  const rows = await env.DB.prepare(
    "SELECT id, key_prefix, label, enabled, created_at, last_used_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC"
  )
    .bind(user.id)
    .all();
  return json({ keys: rows.results });
}

export async function handleCreateApiKey(request, env, user) {
  if (!user.is_root && !hasPermission(user, "api.access")) {
    return badRequest("You don't have permission to use the API.");
  }
  const body = await request.json().catch(() => ({}));
  const label = (body.label || "API Key").trim();
  const rawKey = `rs3_${randomToken(24)}`;
  const keyHash = await sha256Hex(rawKey);

  const result = await env.DB.prepare(
    "INSERT INTO api_keys (key_hash, key_prefix, label, user_id) VALUES (?, ?, ?, ?)"
  )
    .bind(keyHash, rawKey.slice(0, 12), label, user.id)
    .run();

  await logActivity(env, {
    actorType: "user",
    actorId: user.id,
    actorLabel: user.username,
    action: "apikey.create",
    message: `${user.username} created a new API key ("${label}").`,
  });

  // The raw key is only ever shown once.
  return json({ ok: true, id: result.meta.last_row_id, key: rawKey });
}

export async function handleUpdateApiKey(request, env, user, id) {
  const key = await env.DB.prepare("SELECT * FROM api_keys WHERE id = ? AND user_id = ?").bind(id, user.id).first();
  if (!key) return badRequest("API key not found.");
  const body = await request.json().catch(() => ({}));
  if (body.enabled !== undefined) {
    await env.DB.prepare("UPDATE api_keys SET enabled = ? WHERE id = ?").bind(body.enabled ? 1 : 0, id).run();
  }
  return json({ ok: true });
}

export async function handleDeleteApiKey(request, env, user, id) {
  const key = await env.DB.prepare("SELECT * FROM api_keys WHERE id = ? AND user_id = ?").bind(id, user.id).first();
  if (!key) return badRequest("API key not found.");
  await env.DB.prepare("DELETE FROM api_keys WHERE id = ?").bind(id).run();
  await logActivity(env, {
    actorType: "user",
    actorId: user.id,
    actorLabel: user.username,
    action: "apikey.delete",
    message: `${user.username} deleted an API key ("${key.label}").`,
  });
  return json({ ok: true });
}

// ---------------------------------------------------------------------
// Bulk URL import / export (CSV: slug,target - and bulk paste, same format)
// ---------------------------------------------------------------------
export async function handleExportUrls(request, env, user) {
  let rows;
  if (user.is_root) {
    rows = await env.DB.prepare("SELECT * FROM urls WHERE deleted_at IS NULL").all();
  } else if (!user.parent_id) {
    const subs = await env.DB.prepare("SELECT id FROM users WHERE parent_id = ?").bind(user.id).all();
    const ids = [user.id, ...subs.results.map((s) => s.id)];
    const placeholders = ids.map(() => "?").join(",");
    rows = await env.DB.prepare(`SELECT * FROM urls WHERE deleted_at IS NULL AND created_by IN (${placeholders})`)
      .bind(...ids)
      .all();
  } else {
    rows = await env.DB.prepare("SELECT * FROM urls WHERE deleted_at IS NULL AND created_by = ?")
      .bind(user.id)
      .all();
  }

  const lines = ["slug,target"];
  for (const r of rows.results) lines.push(`${csvEscape(r.slug)},${csvEscape(r.target)}`);
  return new Response(lines.join("\n"), {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": 'attachment; filename="short-urls-export.csv"',
    },
  });
}

export async function handleImportUrls(request, env, user) {
  const body = await request.json().catch(() => ({}));
  const text = body.text || "";
  const format = body.format === "paste" ? "paste" : "csv"; // 'csv' | 'paste'
  const settings = await getSettings(env, ["slug_min_chars"]);
  const minChars = settings.slug_min_chars || 4;

  const rows =
    format === "paste"
      ? parseBulkPasteLines(text)
      : parseCSV(text).filter((r) => r.length >= 2 && r[0] && r[0].toLowerCase() !== "slug");
  const created = [];
  const failed = [];

  for (const row of rows) {
    const rawSlug = row[0];
    const target = row[1];
    const password = row[2] || "";
    const slug = rawSlug.trim();
    if (!/^https?:\/\//i.test(target)) {
      failed.push({ slug, reason: "Invalid target URL" });
      continue;
    }
    const check = await isSlugAvailable(env, slug, minChars);
    if (!check.available) {
      failed.push({ slug, reason: check.reason });
      continue;
    }
    await env.DB.prepare("INSERT INTO urls (slug, target, password, created_by) VALUES (?, ?, ?, ?)")
      .bind(slug, target, password || null, user.id)
      .run();
    created.push(slug);
  }

  await logActivity(env, {
    actorType: "user",
    actorId: user.id,
    actorLabel: user.username,
    action: "url.import",
    message: `${user.username} imported ${created.length} short link(s) (${failed.length} failed).`,
  });

  return json({ ok: true, created: created.length, failed });
}
