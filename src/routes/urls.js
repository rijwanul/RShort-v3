import { json, badRequest, notFound, getSettings, logActivity, isSlugAvailable, isValidSlugFormat, todayUTC } from "../lib/utils.js";
import { randomSlug } from "../lib/crypto.js";
import { hasPermission } from "../lib/permissions.js";
import { uploadToImgBB } from "../lib/imgbb.js";

// Returns the list of user ids the given user is allowed to see URLs
// for: root sees everyone, a top-level user sees themself + their
// sub-users, a sub-user sees only themself.
async function visibleUserIds(env, user) {
  if (user.is_root) return null; // null = no restriction
  if (!user.parent_id) {
    const rows = await env.DB.prepare("SELECT id FROM users WHERE parent_id = ?")
      .bind(user.id)
      .all();
    return [user.id, ...rows.results.map((r) => r.id)];
  }
  return [user.id];
}

function serializeUrl(row, ownerMap) {
  const owner = ownerMap[row.created_by];
  return {
    id: row.id,
    slug: row.slug,
    target: row.target,
    hasPassword: !!row.password,
    password: row.password || null,
    fullIframe: !!row.full_iframe,
    socialEnabled: !!row.social_enabled,
    socialTitle: row.social_title,
    socialDescription: row.social_description,
    socialImageUrl: row.social_image_url,
    socialImageSource: row.social_image_source,
    enabled: !!row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: owner ? owner.username : "(deleted user)",
    parentUser: owner && owner.parent_id ? owner.parentUsername : null,
  };
}

export async function handleListUrls(request, env, user) {
  const ids = await visibleUserIds(env, user);
  let rows;
  if (ids === null) {
    rows = await env.DB.prepare(
      "SELECT * FROM urls WHERE deleted_at IS NULL ORDER BY created_at DESC"
    ).all();
  } else {
    const placeholders = ids.map(() => "?").join(",");
    rows = await env.DB.prepare(
      `SELECT * FROM urls WHERE deleted_at IS NULL AND created_by IN (${placeholders}) ORDER BY created_at DESC`
    )
      .bind(...ids)
      .all();
  }

  const owners = await env.DB.prepare("SELECT id, username, parent_id FROM users").all();
  const ownerMap = {};
  for (const o of owners.results) ownerMap[o.id] = { username: o.username, parent_id: o.parent_id };
  for (const o of owners.results) {
    if (o.parent_id && ownerMap[o.parent_id]) {
      ownerMap[o.id].parentUsername = ownerMap[o.parent_id].username;
    }
  }

  // Get live hit totals from each URL's Durable Object.
  const results = await Promise.all(
    rows.results.map(async (row) => {
      const total = await getHitTotal(env, row.id);
      return { ...serializeUrl(row, ownerMap), hits: total };
    })
  );

  return json({ urls: results });
}

async function getHitTotal(env, urlId) {
  try {
    const id = env.HIT_COUNTER.idFromName(String(urlId));
    const stub = env.HIT_COUNTER.get(id);
    const res = await stub.fetch("https://hit-counter/count");
    const data = await res.json();
    return data.total || 0;
  } catch {
    return 0;
  }
}

export async function handleCheckAvailability(request, env, user) {
  const body = await request.json().catch(() => ({}));
  const url = new URL(request.url);
  const slug = body.slug || url.searchParams.get("slug") || "";
  const settings = await getSettings(env, ["slug_min_chars"]);
  const result = await isSlugAvailable(env, slug, settings.slug_min_chars || 4);
  return json(result);
}

async function buildSocialFields(env, user, body, settings) {
  if (!body.socialEnabled) {
    return {
      social_enabled: 0,
      social_title: null,
      social_description: null,
      social_image_url: null,
      social_image_delete_url: null,
      social_image_source: "none",
    };
  }
  if (!hasPermission(user, "url.social_preview")) {
    throw new Error("PERMISSION:You don't have permission to use Custom Social Preview.");
  }

  let imageUrl = null;
  let imageDeleteUrl = null;
  let imageSource = "none";

  if (body.socialImageBase64 && settings.imgbb_api_key) {
    const uploaded = await uploadToImgBB(settings.imgbb_api_key, body.socialImageBase64);
    imageUrl = uploaded.url;
    imageDeleteUrl = uploaded.deleteUrl;
    imageSource = "imgbb";
  } else if (body.socialImageUrl) {
    imageUrl = body.socialImageUrl;
    imageSource = "url";
  }

  return {
    social_enabled: 1,
    social_title: body.socialTitle || null,
    social_description: body.socialDescription || null,
    social_image_url: imageUrl,
    social_image_delete_url: imageDeleteUrl,
    social_image_source: imageSource,
  };
}

export async function handleCreateUrl(request, env, user, viaApi = false) {
  const body = await request.json().catch(() => ({}));
  const settings = await getSettings(env, ["slug_min_chars", "imgbb_api_key"]);
  const minChars = settings.slug_min_chars || 4;

  if (!body.target || !/^https?:\/\//i.test(body.target)) {
    return badRequest("A valid target URL (starting with http:// or https://) is required.");
  }

  let slug = (body.slug || "").trim();
  if (slug) {
    const check = await isSlugAvailable(env, slug, minChars);
    if (!check.available) {
      const reasons = {
        invalid_format: "Slug can only contain letters, numbers, underscores and dashes.",
        too_short: `Slug must be at least ${minChars} characters.`,
        reserved: "That slug is reserved and cannot be used.",
        taken: "That slug is already taken.",
      };
      return badRequest(reasons[check.reason] || "That slug is not available.");
    }
  } else {
    do {
      slug = randomSlug(Math.max(minChars, 7));
    } while (!(await isSlugAvailable(env, slug, minChars)).available);
  }

  if (body.fullIframe && !hasPermission(user, "url.full_iframe")) {
    return badRequest("You don't have permission to use Full Page Iframe.");
  }

  let socialFields;
  try {
    socialFields = await buildSocialFields(env, user, body, settings);
  } catch (err) {
    if (String(err.message).startsWith("PERMISSION:")) return badRequest(err.message.split(":")[1]);
    return badRequest("Failed to process social preview image: " + err.message);
  }

  const result = await env.DB.prepare(
    `INSERT INTO urls (slug, target, password, full_iframe, social_enabled, social_title, social_description, social_image_url, social_image_delete_url, social_image_source, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      slug,
      body.target,
      body.password || null,
      body.fullIframe ? 1 : 0,
      socialFields.social_enabled,
      socialFields.social_title,
      socialFields.social_description,
      socialFields.social_image_url,
      socialFields.social_image_delete_url,
      socialFields.social_image_source,
      user.id
    )
    .run();

  await logActivity(env, {
    actorType: viaApi ? "api_key" : "user",
    actorId: user.id,
    actorLabel: viaApi ? `${user.username} (API)` : user.username,
    action: "url.create",
    message: viaApi
      ? `An API key belonging to ${user.username} created the short link /${slug}.`
      : `${user.username} created the short link /${slug}.`,
  });

  return json({ ok: true, id: result.meta.last_row_id, slug });
}

async function canManageUrl(env, user, urlRow) {
  if (user.is_root) return true;
  if (urlRow.created_by === user.id) return true;
  if (!user.parent_id) {
    const owner = await env.DB.prepare("SELECT parent_id FROM users WHERE id = ?")
      .bind(urlRow.created_by)
      .first();
    return owner && owner.parent_id === user.id;
  }
  return false;
}

// ---------------------------------------------------------------------
// Bulk actions on multiple selected links at once. Every id is checked
// against canManageUrl individually - ids the caller can't manage are
// silently skipped and reported back, rather than failing the whole
// batch, so a partially-stale selection (e.g. someone else just
// deleted one) doesn't block the rest.
// ---------------------------------------------------------------------
export async function handleBulkUpdateUrls(request, env, user) {
  const body = await request.json().catch(() => ({}));
  const { ids, action } = body;
  if (!Array.isArray(ids) || !ids.length) return badRequest("No links selected.");
  if (!action) return badRequest("No action specified.");

  const placeholders = ids.map(() => "?").join(",");
  const rows = await env.DB.prepare(`SELECT * FROM urls WHERE id IN (${placeholders}) AND deleted_at IS NULL`)
    .bind(...ids)
    .all();

  const manageable = [];
  const skipped = [];
  for (const row of rows.results) {
    if (await canManageUrl(env, user, row)) manageable.push(row);
    else skipped.push(row.id);
  }
  if (!manageable.length) return badRequest("You don't have permission to manage any of the selected links.");

  const manageableIds = manageable.map((r) => r.id);
  const idPlaceholders = manageableIds.map(() => "?").join(",");

  let logMessage;
  switch (action) {
    case "enable":
      await env.DB.prepare(`UPDATE urls SET enabled = 1, updated_at = datetime('now') WHERE id IN (${idPlaceholders})`)
        .bind(...manageableIds)
        .run();
      logMessage = `enabled ${manageable.length} short link(s)`;
      break;
    case "disable":
      await env.DB.prepare(`UPDATE urls SET enabled = 0, updated_at = datetime('now') WHERE id IN (${idPlaceholders})`)
        .bind(...manageableIds)
        .run();
      logMessage = `disabled ${manageable.length} short link(s)`;
      break;
    case "removePassword":
      await env.DB.prepare(`UPDATE urls SET password = NULL, updated_at = datetime('now') WHERE id IN (${idPlaceholders})`)
        .bind(...manageableIds)
        .run();
      logMessage = `removed the password from ${manageable.length} short link(s)`;
      break;
    case "applyPassword": {
      const pw = body.password;
      if (!pw) return badRequest("Provide a password to apply.");
      await env.DB.prepare(`UPDATE urls SET password = ?, updated_at = datetime('now') WHERE id IN (${idPlaceholders})`)
        .bind(pw, ...manageableIds)
        .run();
      logMessage = `applied a password to ${manageable.length} short link(s)`;
      break;
    }
    case "iframeOn":
      await env.DB.prepare(`UPDATE urls SET full_iframe = 1, updated_at = datetime('now') WHERE id IN (${idPlaceholders})`)
        .bind(...manageableIds)
        .run();
      logMessage = `enabled full-page iframe on ${manageable.length} short link(s)`;
      break;
    case "iframeOff":
      await env.DB.prepare(`UPDATE urls SET full_iframe = 0, updated_at = datetime('now') WHERE id IN (${idPlaceholders})`)
        .bind(...manageableIds)
        .run();
      logMessage = `disabled full-page iframe on ${manageable.length} short link(s)`;
      break;
    case "delete":
      await env.DB.prepare(`DELETE FROM urls WHERE id IN (${idPlaceholders})`).bind(...manageableIds).run();
      logMessage = `deleted ${manageable.length} short link(s)`;
      break;
    case "transfer": {
      // Sub-users never get this option client-side, but enforce it
      // server-side too regardless of what the client sends.
      if (user.parent_id) return badRequest("Sub-users cannot transfer links.");
      const transferToId = body.transferToId;
      if (!transferToId) return badRequest("Choose an account to transfer to.");
      const dest = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(transferToId).first();
      if (!dest) return badRequest("Transfer destination account not found.");
      if (!user.is_root) {
        // A parent may transfer to themselves or to one of their own sub-users only.
        const allowed = String(dest.id) === String(user.id) || String(dest.parent_id) === String(user.id);
        if (!allowed) return badRequest("You can only transfer links to yourself or one of your own sub-users.");
      }
      await env.DB.prepare(`UPDATE urls SET created_by = ?, updated_at = datetime('now') WHERE id IN (${idPlaceholders})`)
        .bind(transferToId, ...manageableIds)
        .run();
      logMessage = `transferred ${manageable.length} short link(s) to "${dest.username}"`;
      break;
    }
    default:
      return badRequest("Unknown bulk action.");
  }

  await logActivity(env, {
    actorType: "user",
    actorId: user.id,
    actorLabel: user.username,
    action: "url.bulk_update",
    message: `${user.username} ${logMessage}.`,
  });

  return json({ ok: true, affected: manageable.length, skipped: skipped.length });
}

export async function handleUpdateUrl(request, env, user, id) {
  const urlRow = await env.DB.prepare("SELECT * FROM urls WHERE id = ? AND deleted_at IS NULL")
    .bind(id)
    .first();
  if (!urlRow) return notFound("Short link not found.");
  if (!(await canManageUrl(env, user, urlRow))) return badRequest("You cannot edit this link.");

  const body = await request.json().catch(() => ({}));
  const settings = await getSettings(env, ["slug_min_chars", "imgbb_api_key"]);
  const minChars = settings.slug_min_chars || 4;

  let slug = urlRow.slug;
  if (body.slug && body.slug.trim().toLowerCase() !== urlRow.slug.toLowerCase()) {
    slug = body.slug.trim();
    const check = await isSlugAvailable(env, slug, minChars);
    if (!check.available) return badRequest("That slug is not available.");
  }

  if (body.fullIframe && !hasPermission(user, "url.full_iframe")) {
    return badRequest("You don't have permission to use Full Page Iframe.");
  }

  let socialFields;
  try {
    socialFields = body.socialEnabled !== undefined || body.socialImageBase64 || body.socialImageUrl
      ? await buildSocialFields(env, user, body, settings)
      : null;
  } catch (err) {
    if (String(err.message).startsWith("PERMISSION:")) return badRequest(err.message.split(":")[1]);
    return badRequest("Failed to process social preview image: " + err.message);
  }

  const target = body.target !== undefined ? body.target : urlRow.target;
  const password = body.password !== undefined ? body.password || null : urlRow.password;
  const fullIframe = body.fullIframe !== undefined ? (body.fullIframe ? 1 : 0) : urlRow.full_iframe;
  const enabled = body.enabled !== undefined ? (body.enabled ? 1 : 0) : urlRow.enabled;

  await env.DB.prepare(
    `UPDATE urls SET slug = ?, target = ?, password = ?, full_iframe = ?, enabled = ?,
       social_enabled = COALESCE(?, social_enabled),
       social_title = COALESCE(?, social_title),
       social_description = COALESCE(?, social_description),
       social_image_url = COALESCE(?, social_image_url),
       social_image_delete_url = COALESCE(?, social_image_delete_url),
       social_image_source = COALESCE(?, social_image_source),
       updated_at = datetime('now')
     WHERE id = ?`
  )
    .bind(
      slug,
      target,
      password,
      fullIframe,
      enabled,
      socialFields ? socialFields.social_enabled : null,
      socialFields ? socialFields.social_title : null,
      socialFields ? socialFields.social_description : null,
      socialFields ? socialFields.social_image_url : null,
      socialFields ? socialFields.social_image_delete_url : null,
      socialFields ? socialFields.social_image_source : null,
      id
    )
    .run();

  const changes = [];
  if (body.enabled !== undefined && !!urlRow.enabled !== !!enabled) {
    changes.push(enabled ? "enabled" : "disabled");
  }
  if (target !== urlRow.target) changes.push("edited target of");
  if (slug !== urlRow.slug) changes.push("edited slug of");
  const hadPassword = !!urlRow.password;
  const hasPasswordNow = !!password;
  if (!hadPassword && hasPasswordNow) changes.push("added password to");
  else if (hadPassword && !hasPasswordNow) changes.push("removed password from");
  else if (hadPassword && hasPasswordNow && password !== urlRow.password) changes.push("changed password of");
  if (body.fullIframe !== undefined && !!urlRow.full_iframe !== !!fullIframe) {
    changes.push(fullIframe ? "enabled full-page iframe for" : "disabled full-page iframe for");
  }
  if (socialFields && !!urlRow.social_enabled !== !!socialFields.social_enabled) {
    changes.push(socialFields.social_enabled ? "enabled custom social preview for" : "disabled custom social preview for");
  } else if (socialFields) {
    changes.push("updated social preview of");
  }
  const changeSummary =
    changes.length === 0
      ? "edited"
      : changes.length === 1
      ? changes[0]
      : `${changes.slice(0, -1).join(", ")} and ${changes[changes.length - 1]}`;

  await logActivity(env, {
    actorType: "user",
    actorId: user.id,
    actorLabel: user.username,
    action: "url.update",
    message: `${user.username} ${changeSummary} the short link /${urlRow.slug}${slug !== urlRow.slug ? ` (now /${slug})` : ""}.`,
  });

  return json({ ok: true });
}

export async function handleDeleteUrl(request, env, user, id) {
  const urlRow = await env.DB.prepare("SELECT * FROM urls WHERE id = ? AND deleted_at IS NULL")
    .bind(id)
    .first();
  if (!urlRow) return notFound("Short link not found.");
  if (!(await canManageUrl(env, user, urlRow))) return badRequest("You cannot delete this link.");

  await env.DB.prepare("UPDATE urls SET deleted_at = datetime('now') WHERE id = ?").bind(id).run();

  await logActivity(env, {
    actorType: "user",
    actorId: user.id,
    actorLabel: user.username,
    action: "url.delete",
    message: `${user.username} deleted the short link /${urlRow.slug}.`,
  });

  return json({ ok: true });
}

export async function handleUrlAnalytics(request, env, user, id) {
  const urlRow = await env.DB.prepare("SELECT * FROM urls WHERE id = ?").bind(id).first();
  if (!urlRow) return notFound("Short link not found.");
  if (!(await canManageUrl(env, user, urlRow))) return badRequest("You cannot view analytics for this link.");

  const byDate = await env.DB.prepare(
    `SELECT hit_date, COUNT(*) as count FROM hit_logs WHERE url_id = ? GROUP BY hit_date ORDER BY hit_date DESC LIMIT 90`
  )
    .bind(id)
    .all();
  const byReferrer = await env.DB.prepare(
    `SELECT referrer_bucket, COUNT(*) as count FROM hit_logs WHERE url_id = ? GROUP BY referrer_bucket ORDER BY count DESC`
  )
    .bind(id)
    .all();
  const total = await getHitTotal(env, id);

  return json({
    total,
    byDate: byDate.results,
    byReferrer: byReferrer.results,
  });
}

export async function handleUploadImage(request, env, user) {
  const settings = await getSettings(env, ["imgbb_api_key"]);
  if (!settings.imgbb_api_key) return badRequest("Image hosting is not configured on this site.");
  const body = await request.json().catch(() => ({}));
  if (!body.imageBase64) return badRequest("No image provided.");
  try {
    const uploaded = await uploadToImgBB(settings.imgbb_api_key, body.imageBase64);
    return json({ ok: true, url: uploaded.url, deleteUrl: uploaded.deleteUrl });
  } catch (err) {
    return badRequest("Image upload failed: " + err.message);
  }
}

// ---------------------------------------------------------------------
// Public API (key-authed): /api/newEntry and /api/deleteEntry.
// The key's owning user's permissions apply in full.
// ---------------------------------------------------------------------
export async function handleApiNewEntry(request, env, apiUser) {
  return handleCreateUrl(request, env, apiUser, true);
}

export async function handleApiDeleteEntry(request, env, apiUser) {
  const body = await request.json().catch(() => ({}));
  if (!body.slug) return badRequest("slug is required.");
  const urlRow = await env.DB.prepare(
    "SELECT * FROM urls WHERE slug = ? COLLATE NOCASE AND deleted_at IS NULL"
  )
    .bind(body.slug)
    .first();
  if (!urlRow) return notFound("Short link not found.");
  if (!(await canManageUrl(env, apiUser, urlRow))) return badRequest("You cannot delete this link.");
  await env.DB.prepare("UPDATE urls SET deleted_at = datetime('now') WHERE id = ?")
    .bind(urlRow.id)
    .run();
  await logActivity(env, {
    actorType: "api_key",
    actorId: apiUser.id,
    actorLabel: `${apiUser.username} (API)`,
    action: "url.delete",
    message: `An API key belonging to ${apiUser.username} deleted the short link /${urlRow.slug}.`,
  });
  return json({ ok: true });
}
