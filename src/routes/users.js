import { json, badRequest, notFound, logActivity, getSettings } from "../lib/utils.js";
import { hashPassword, randomPassword } from "../lib/crypto.js";
import { hasPermission, defaultPermissions, defaultSubuserPermissions, ALL_PERMISSIONS } from "../lib/permissions.js";
import { sendTemplatedEmail } from "../lib/email.js";

function serializeUser(row, usernameById) {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    isRoot: !!row.is_root,
    parentId: row.parent_id,
    parentUsername: row.parent_id ? usernameById[row.parent_id] : null,
    permissions: typeof row.permissions === "string" ? JSON.parse(row.permissions) : row.permissions,
    mustChangePassword: !!row.must_change_password,
    enabled: !!row.enabled,
    approved: !!row.approved,
    disabledByLockout: !!row.disabled_by_lockout,
    isLockedOut: !!(row.locked_until && new Date(row.locked_until) > new Date()),
    createdAt: row.created_at,
  };
}

// Root: everyone. Top-level user: self + their sub-users. Sub-user: none
// (sub-users can't manage other accounts, permission-gated separately).
async function scopeForUserList(env, actor) {
  if (actor.is_root) {
    return env.DB.prepare("SELECT * FROM users WHERE username != 'disabled' ORDER BY created_at DESC").all();
  }
  if (!actor.parent_id) {
    return env.DB.prepare(
      "SELECT * FROM users WHERE id = ? OR parent_id = ? ORDER BY created_at DESC"
    )
      .bind(actor.id, actor.id)
      .all();
  }
  return env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(actor.id).all();
}

export async function handleListUsers(request, env, actor) {
  const rows = await scopeForUserList(env, actor);
  const all = await env.DB.prepare("SELECT id, username FROM users").all();
  const usernameById = {};
  for (const u of all.results) usernameById[u.id] = u.username;

  const urlCounts = await env.DB.prepare(
    "SELECT created_by, COUNT(*) as c FROM urls WHERE deleted_at IS NULL GROUP BY created_by"
  ).all();
  const urlCountById = {};
  for (const r of urlCounts.results) urlCountById[r.created_by] = r.c;

  const pendingApprovals = actor.is_root
    ? (await env.DB.prepare("SELECT COUNT(*) as c FROM users WHERE approved = 0").first()).c
    : 0;

  return json({
    users: rows.results.map((r) => ({ ...serializeUser(r, usernameById), urlCount: urlCountById[r.id] || 0 })),
    pendingApprovals,
  });
}

function canActorManage(actor, targetRow) {
  if (actor.is_root) return true;
  if (!actor.parent_id && targetRow.parent_id === actor.id) return true;
  return false;
}

export async function handleCreateUser(request, env, actor) {
  const body = await request.json().catch(() => ({}));
  const { username, email, permissions, asSubuser } = body;

  if (!username || !/^[a-zA-Z0-9_-]{3,32}$/.test(username)) {
    return badRequest("Username must be 3-32 characters: letters, numbers, underscore or dash.");
  }

  const wantsSubuser = asSubuser && (actor.is_root ? !!body.parentUserId : true);
  if (wantsSubuser) {
    const siteSettings = await getSettings(env, ["subusers_feature_enabled"]);
    if (siteSettings.subusers_feature_enabled === false) {
      return badRequest("Sub-user accounts are turned off site-wide. Ask the root admin to re-enable them in Site Settings.");
    }
  }

  let parentId = null;
  if (actor.is_root) {
    // Root can create a top-level user or, if asSubuser + parentUserId given,
    // a sub-user directly under a specific user.
    if (asSubuser && body.parentUserId) parentId = body.parentUserId;
  } else {
    if (!hasPermission(actor, "subusers.manage")) {
      return badRequest("You don't have permission to create sub-user accounts.");
    }
    if (actor.parent_id) return badRequest("Sub-users cannot create further sub-users.");
    parentId = actor.id;
  }

  const existing = await env.DB.prepare("SELECT 1 FROM users WHERE username = ? COLLATE NOCASE")
    .bind(username)
    .first();
  if (existing) return badRequest("That username is already taken.");

  const tempPassword = body.password || randomPassword(12);
  const passwordHash = await hashPassword(tempPassword);

  // "Must change password on first login" checkbox: defaults to checked
  // (required) when the root admin creates a top-level user, and
  // unchecked (not required) when a parent user creates a sub-user.
  // The creator can still override the default either way.
  const isSubuserCreation = !actor.is_root && !!parentId;
  const mustChangePassword =
    body.mustChangePassword !== undefined ? !!body.mustChangePassword : !isSubuserCreation;

  const perms = isSubuserCreation ? { ...defaultPermissions(), ...defaultSubuserPermissions() } : { ...defaultPermissions() };
  if (permissions) {
    for (const p of ALL_PERMISSIONS) {
      if (p.key === "subusers.manage" && isSubuserCreation) continue; // never grantable on a sub-user
      if (permissions[p.key] !== undefined) perms[p.key] = !!permissions[p.key];
    }
  }
  // Only root may grant admin.* permissions.
  if (!actor.is_root) {
    for (const p of ALL_PERMISSIONS) {
      if (p.key.startsWith("admin.")) perms[p.key] = false;
    }
  }

  const result = await env.DB.prepare(
    `INSERT INTO users (username, email, password_hash, is_root, parent_id, permissions, must_change_password, enabled, approved)
     VALUES (?, ?, ?, 0, ?, ?, ?, 1, 1)`
  )
    .bind(username, email || null, passwordHash, parentId, JSON.stringify(perms), mustChangePassword ? 1 : 0)
    .run();

  if (email) {
    const url = new URL(request.url);
    await sendTemplatedEmail(env, "welcome", email, { username, tempPassword, loginUrl: `${url.origin}/login` });
  }

  await logActivity(env, {
    actorType: "user",
    actorId: actor.id,
    actorLabel: actor.username,
    action: "user.create",
    message: `${actor.username} created the account "${username}".`,
  });

  return json({ ok: true, id: result.meta.last_row_id, temporaryPassword: body.password ? undefined : tempPassword });
}

export async function handleUpdateUser(request, env, actor, id) {
  const target = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
  if (!target) return notFound("User not found.");
  if (!canActorManage(actor, target) && actor.id !== target.id) return badRequest("You cannot edit this account.");

  const body = await request.json().catch(() => ({}));
  const updates = { email: target.email, enabled: target.enabled };

  if (body.email !== undefined && (actor.is_root || canActorManage(actor, target))) {
    updates.email = body.email;
  }

  let justDisabled = false;
  let justReenabled = false;
  if (body.enabled !== undefined && actor.id !== target.id) {
    updates.enabled = body.enabled ? 1 : 0;
    if (target.enabled && !body.enabled) justDisabled = true;
    if (!target.enabled && body.enabled) justReenabled = true;
  }

  let permissionsChanged = false;
  let newPerms = typeof target.permissions === "string" ? JSON.parse(target.permissions) : target.permissions;
  let revokedSubuserManage = false;
  let revokedApiAccess = false;

  if (body.permissions && (actor.is_root || canActorManage(actor, target)) && actor.id !== target.id) {
    const merged = { ...newPerms };
    for (const p of ALL_PERMISSIONS) {
      if (p.key.startsWith("admin.") && !actor.is_root) continue; // only root grants admin perms
      if (p.key === "subusers.manage" && !actor.is_root && target.parent_id) continue; // not grantable on a sub-user
      if (body.permissions[p.key] !== undefined) merged[p.key] = !!body.permissions[p.key];
    }
    if (newPerms["subusers.manage"] && merged["subusers.manage"] === false) {
      revokedSubuserManage = true;
    }
    if (newPerms["api.access"] && merged["api.access"] === false) {
      revokedApiAccess = true;
    }
    newPerms = merged;
    permissionsChanged = true;
  }

  await env.DB.prepare(
    `UPDATE users SET email = ?, enabled = ?, permissions = ?, token_version = token_version + 1, updated_at = datetime('now') WHERE id = ?`
  )
    .bind(updates.email, updates.enabled, JSON.stringify(newPerms), id)
    .run();

  if (justReenabled) {
    await env.DB.prepare("UPDATE users SET failed_login_count = 0, locked_until = NULL, disabled_by_lockout = 0 WHERE id = ?")
      .bind(id)
      .run();
  }

  if (justDisabled && target.email) {
    await sendTemplatedEmail(env, "account_disabled", target.email, { username: target.username });
  }

  let disabledKeyCount = 0;
  if (revokedApiAccess) {
    const affected = await env.DB.prepare("SELECT COUNT(*) as c FROM api_keys WHERE user_id = ? AND enabled = 1").bind(id).first();
    disabledKeyCount = affected.c;
    if (disabledKeyCount > 0) {
      await env.DB.prepare("UPDATE api_keys SET enabled = 0 WHERE user_id = ?").bind(id).run();
    }
  }

  await logActivity(env, {
    actorType: "user",
    actorId: actor.id,
    actorLabel: actor.username,
    action: "user.update",
    message: `${actor.username} updated the account "${target.username}"${disabledKeyCount > 0 ? ` and disabled ${disabledKeyCount} API key(s) (API access revoked)` : ""}.`,
  });

  const response = { ok: true };
  if (revokedSubuserManage) {
    const subuserCount = (
      await env.DB.prepare("SELECT COUNT(*) as c FROM users WHERE parent_id = ?").bind(id).first()
    ).c;
    if (subuserCount > 0) {
      response.subuserActionRequired = true;
      response.subuserCount = subuserCount;
    }
  }

  return json(response);
}

// Handles the prompt when revoking sub-user functionality from an
// account that currently has active sub-users.
export async function handleResolveSubusers(request, env, actor, id) {
  const target = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
  if (!target) return notFound("User not found.");
  if (!canActorManage(actor, target)) return badRequest("You cannot manage this account's sub-users.");

  const body = await request.json().catch(() => ({}));
  const { mode, transferToUserId, alsoDisableUrls } = body; // mode: 'transfer' | 'convert' | 'suspend' | 'delete'

  const subusers = await env.DB.prepare("SELECT * FROM users WHERE parent_id = ?").bind(id).all();

  if (mode === "transfer") {
    if (!transferToUserId) return badRequest("A destination user is required to transfer sub-users.");
    await env.DB.prepare("UPDATE users SET parent_id = ? WHERE parent_id = ?")
      .bind(transferToUserId, id)
      .run();
  } else if (mode === "convert") {
    await env.DB.prepare("UPDATE users SET parent_id = NULL WHERE parent_id = ?").bind(id).run();
  } else if (mode === "suspend") {
    await env.DB.prepare("UPDATE users SET enabled = 0, token_version = token_version + 1 WHERE parent_id = ?")
      .bind(id)
      .run();
    if (alsoDisableUrls) {
      const ids = subusers.results.map((s) => s.id);
      if (ids.length) {
        const placeholders = ids.map(() => "?").join(",");
        await env.DB.prepare(`UPDATE urls SET enabled = 0 WHERE created_by IN (${placeholders})`)
          .bind(...ids)
          .run();
      }
    }
  } else if (mode === "delete") {
    await env.DB.prepare("DELETE FROM users WHERE parent_id = ?").bind(id).run();
  } else {
    return badRequest("Invalid mode. Use transfer, convert, suspend, or delete.");
  }

  await logActivity(env, {
    actorType: "user",
    actorId: actor.id,
    actorLabel: actor.username,
    action: "user.resolve_subusers",
    message: `${actor.username} resolved ${subusers.results.length} sub-user(s) of "${target.username}" using mode "${mode}".`,
  });

  return json({ ok: true, affected: subusers.results.length });
}

// Bulk version of handleResolveSubusers: applies ONE decision to every
// sub-user across every parent at once, used when the root admin turns
// the sub-user module off site-wide.
export async function handleResolveSubusersGlobal(request, env, actor) {
  if (!actor.is_root) return badRequest("Only the root admin can perform this action.");
  const body = await request.json().catch(() => ({}));
  const { mode, alsoDisableUrls, transferToId } = body; // mode: 'convert' | 'transfer' | 'suspend' | 'delete' | 'defer'

  const subusers = await env.DB.prepare("SELECT * FROM users WHERE parent_id IS NOT NULL").all();
  const ids = subusers.results.map((s) => s.id);

  if (mode === "defer") {
    // Take no action now; existing sub-accounts keep functioning as
    // usual until the admin resolves them individually or globally later.
    return json({ ok: true, affected: 0, deferred: true });
  } else if (mode === "convert") {
    await env.DB.prepare("UPDATE users SET parent_id = NULL WHERE parent_id IS NOT NULL").run();
  } else if (mode === "transfer") {
    if (!transferToId) return badRequest("Choose an account to transfer all sub-user short URLs to.");
    const dest = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(transferToId).first();
    if (!dest) return badRequest("Transfer destination account not found.");
    if (ids.length) {
      const placeholders = ids.map(() => "?").join(",");
      await env.DB.prepare(`UPDATE urls SET created_by = ? WHERE created_by IN (${placeholders})`)
        .bind(transferToId, ...ids)
        .run();
    }
    await env.DB.prepare("DELETE FROM users WHERE parent_id IS NOT NULL").run();
  } else if (mode === "suspend") {
    await env.DB.prepare(
      "UPDATE users SET enabled = 0, token_version = token_version + 1 WHERE parent_id IS NOT NULL"
    ).run();
    if (alsoDisableUrls && ids.length) {
      const placeholders = ids.map(() => "?").join(",");
      await env.DB.prepare(`UPDATE urls SET enabled = 0 WHERE created_by IN (${placeholders})`)
        .bind(...ids)
        .run();
    }
  } else if (mode === "delete") {
    await env.DB.prepare("DELETE FROM users WHERE parent_id IS NOT NULL").run();
  } else {
    return badRequest("Invalid mode. Use convert, transfer, suspend, delete, or defer.");
  }

  await logActivity(env, {
    actorType: "user",
    actorId: actor.id,
    actorLabel: actor.username,
    action: "user.resolve_subusers_global",
    message: `${actor.username} resolved ${subusers.results.length} sub-user(s) site-wide using mode "${mode}".`,
  });

  return json({ ok: true, affected: subusers.results.length });
}

// Used when re-enabling the sub-user module site-wide: optionally
// unsuspends every currently-suspended sub-user and, optionally, their
// short links too.
export async function handleUnsuspendSubusersGlobal(request, env, actor) {
  if (!actor.is_root) return badRequest("Only the root admin can perform this action.");
  const body = await request.json().catch(() => ({}));
  const { alsoEnableUrls } = body;

  const subs = await env.DB.prepare("SELECT id FROM users WHERE parent_id IS NOT NULL AND enabled = 0").all();
  const ids = subs.results.map((s) => s.id);

  await env.DB.prepare("UPDATE users SET enabled = 1 WHERE parent_id IS NOT NULL AND enabled = 0").run();
  if (alsoEnableUrls && ids.length) {
    const placeholders = ids.map(() => "?").join(",");
    await env.DB.prepare(`UPDATE urls SET enabled = 1 WHERE created_by IN (${placeholders})`)
      .bind(...ids)
      .run();
  }

  await logActivity(env, {
    actorType: "user",
    actorId: actor.id,
    actorLabel: actor.username,
    action: "user.unsuspend_subusers_global",
    message: `${actor.username} unsuspended ${ids.length} sub-user(s) site-wide.`,
  });

  return json({ ok: true, affected: ids.length });
}

// Gets or creates the synthetic "disabled" account that holds URLs
// whose owner was deleted and the admin/parent chose to disable
// rather than transfer or delete them. This account is never used for
// login (random unusable password hash) and never shown in normal
// user lists (filtered out by username).
const DISABLED_HOLDER_USERNAME = "disabled";
async function getOrCreateDisabledHolder(env) {
  let holder = await env.DB.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE")
    .bind(DISABLED_HOLDER_USERNAME)
    .first();
  if (holder) return holder;
  const passwordHash = await hashPassword(randomPassword(32));
  const perms = JSON.stringify(defaultPermissions());
  await env.DB.prepare(
    `INSERT INTO users (username, email, password_hash, is_root, parent_id, permissions, must_change_password, enabled, approved)
     VALUES (?, NULL, ?, 0, NULL, ?, 0, 0, 1)`
  )
    .bind(DISABLED_HOLDER_USERNAME, passwordHash, perms)
    .run();
  holder = await env.DB.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE")
    .bind(DISABLED_HOLDER_USERNAME)
    .first();
  return holder;
}

export async function handleDeleteUser(request, env, actor, id) {
  const target = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
  if (!target) return notFound("User not found.");
  if (!canActorManage(actor, target)) return badRequest("You cannot delete this account.");
  if (target.is_root) return badRequest("The root admin account cannot be deleted.");

  const body = await request.json().catch(() => ({}));
  const urlAction = body.urlAction; // 'transfer' | 'disable' | 'delete'
  const transferToId = body.transferToId;

  const urlCount = (
    await env.DB.prepare("SELECT COUNT(*) as c FROM urls WHERE created_by = ? AND deleted_at IS NULL").bind(id).first()
  ).c;

  if (urlCount > 0) {
    if (urlAction === "transfer") {
      if (!transferToId) return badRequest("Choose an account to transfer the short URLs to.");
      const dest = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(transferToId).first();
      if (!dest) return badRequest("Transfer destination account not found.");
      await env.DB.prepare("UPDATE urls SET created_by = ? WHERE created_by = ?").bind(transferToId, id).run();
    } else if (urlAction === "disable") {
      const holder = await getOrCreateDisabledHolder(env);
      await env.DB.prepare("UPDATE urls SET created_by = ?, enabled = 0 WHERE created_by = ?")
        .bind(holder.id, id)
        .run();
    } else if (urlAction === "delete") {
      await env.DB.prepare("DELETE FROM urls WHERE created_by = ?").bind(id).run();
    } else {
      return badRequest("This account has short URLs. Choose transfer, disable, or delete for them first.");
    }
  }

  await env.DB.prepare("DELETE FROM api_keys WHERE user_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id).run();

  await logActivity(env, {
    actorType: "user",
    actorId: actor.id,
    actorLabel: actor.username,
    action: "user.delete",
    message: `${actor.username} deleted the account "${target.username}"${urlCount > 0 ? ` (${urlCount} short URL(s) ${urlAction === "transfer" ? "transferred" : urlAction === "disable" ? "disabled" : "deleted"})` : ""}.`,
  });

  return json({ ok: true });
}

export async function handleResetPassword(request, env, actor, id) {
  const target = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
  if (!target) return notFound("User not found.");
  if (!canActorManage(actor, target) && actor.id !== target.id) return badRequest("You cannot reset this account's password.");

  const body = await request.json().catch(() => ({}));
  const newPassword = body.customPassword || randomPassword(12);
  const passwordHash = await hashPassword(newPassword);
  const mustChangePassword = !!body.mustChangePassword;

  await env.DB.prepare(
    "UPDATE users SET password_hash = ?, must_change_password = ?, token_version = token_version + 1, failed_login_count = 0, locked_until = NULL, disabled_by_lockout = 0 WHERE id = ?"
  )
    .bind(passwordHash, mustChangePassword ? 1 : 0, id)
    .run();

  if (target.email) {
    const url = new URL(request.url);
    await sendTemplatedEmail(env, "password_reset", target.email, {
      username: target.username,
      tempPassword: newPassword,
      loginUrl: `${url.origin}/login`,
    });
  }

  await logActivity(env, {
    actorType: "user",
    actorId: actor.id,
    actorLabel: actor.username,
    action: "user.reset_password",
    message: `${actor.username} reset the password for "${target.username}".`,
  });

  return json({ ok: true, temporaryPassword: body.customPassword ? undefined : newPassword });
}

export async function handleApproveUser(request, env, actor, id) {
  if (!actor.is_root) return badRequest("Only the root admin can approve new registrations.");
  const body = await request.json().catch(() => ({}));
  const target = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
  if (!target) return notFound("User not found.");

  if (body.approve === false) {
    await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id).run();
    await logActivity(env, {
      actorType: "user",
      actorId: actor.id,
      actorLabel: actor.username,
      action: "user.reject",
      message: `${actor.username} rejected the registration for "${target.username}".`,
    });
    return json({ ok: true, rejected: true });
  }

  await env.DB.prepare("UPDATE users SET approved = 1 WHERE id = ?").bind(id).run();
  await logActivity(env, {
    actorType: "user",
    actorId: actor.id,
    actorLabel: actor.username,
    action: "user.approve",
    message: `${actor.username} approved the registration for "${target.username}".`,
  });
  return json({ ok: true });
}
