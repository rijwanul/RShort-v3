import { hashPassword, verifyPassword, randomPassword } from "../lib/crypto.js";
import { issueToken, setAuthCookie, clearAuthCookie, getCurrentUser } from "../lib/auth.js";
import { json, badRequest, getSettings, logActivity } from "../lib/utils.js";
import { defaultPermissions } from "../lib/permissions.js";
import { sendTemplatedEmail, emailIsConfigured } from "../lib/email.js";

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    isRoot: !!u.is_root,
    parentId: u.parent_id,
    permissions: typeof u.permissions === "string" ? JSON.parse(u.permissions) : u.permissions,
    mustChangePassword: !!u.must_change_password,
  };
}

export async function handleMe(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user) return json({ user: null });
  return json({ user: publicUser(user) });
}

// Lockout tiers, checked from highest to lowest. At `count` consecutive
// failed attempts, the account is locked for `minutes` (or permanently
// disabled, for the last tier, requiring parent/admin action).
const LOCKOUT_TIERS = [
  { count: 50, minutes: null, disable: true },
  { count: 30, minutes: 360 },
  { count: 10, minutes: 30 },
  { count: 5, minutes: 15 },
];

function tierForCount(count) {
  return LOCKOUT_TIERS.find((t) => count >= t.count) || null;
}

export async function handleLogin(request, env) {
  const body = await request.json().catch(() => ({}));
  const { identifier, password } = body;
  if (!identifier || !password) return badRequest("Username/email and password are required.");

  const settings = await getSettings(env, ["login_lockout_enabled"]);
  const lockoutEnabled = settings.login_lockout_enabled !== false;

  const user = await env.DB.prepare(
    "SELECT * FROM users WHERE (username = ? OR email = ?) COLLATE NOCASE"
  )
    .bind(identifier, identifier)
    .first();

  if (!user) return badRequest("Invalid username/email or password.");

  if (lockoutEnabled && user.disabled_by_lockout) {
    return badRequest("This account has been disabled after repeated failed login attempts. Contact your parent account or admin to re-enable it.");
  }
  if (!user.enabled) return badRequest("This account has been disabled. Contact your administrator.");
  if (!user.approved) return badRequest("This account is awaiting admin approval.");

  if (lockoutEnabled && user.locked_until && new Date(user.locked_until) > new Date()) {
    const mins = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
    return badRequest(`Too many failed attempts. Try again in about ${mins} minute(s).`);
  }

  const ok = await verifyPassword(password, user.password_hash);

  if (!ok) {
    await logActivity(env, {
      actorType: "user",
      actorId: user.id,
      actorLabel: user.username,
      action: "auth.login_failed",
      message: `Failed login attempt for "${user.username}".`,
    });

    if (lockoutEnabled) {
      const newCount = (user.failed_login_count || 0) + 1;
      const tier = tierForCount(newCount);
      if (tier && tier.disable) {
        await env.DB.prepare(
          "UPDATE users SET failed_login_count = ?, disabled_by_lockout = 1, locked_until = NULL WHERE id = ?"
        )
          .bind(newCount, user.id)
          .run();
        await logActivity(env, {
          actorType: "system",
          actorId: user.id,
          actorLabel: user.username,
          action: "auth.account_locked",
          message: `"${user.username}" was automatically disabled after ${newCount} consecutive failed login attempts.`,
        });
      } else if (tier) {
        const lockedUntil = new Date(Date.now() + tier.minutes * 60000).toISOString();
        await env.DB.prepare("UPDATE users SET failed_login_count = ?, locked_until = ? WHERE id = ?")
          .bind(newCount, lockedUntil, user.id)
          .run();
        await logActivity(env, {
          actorType: "system",
          actorId: user.id,
          actorLabel: user.username,
          action: "auth.account_locked",
          message: `"${user.username}" was locked for ${tier.minutes} minute(s) after ${newCount} consecutive failed login attempts.`,
        });
      } else {
        await env.DB.prepare("UPDATE users SET failed_login_count = ? WHERE id = ?").bind(newCount, user.id).run();
      }
    }

    return badRequest("Invalid username/email or password.");
  }

  if (lockoutEnabled && (user.failed_login_count > 0 || user.locked_until)) {
    await env.DB.prepare("UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = ?")
      .bind(user.id)
      .run();
  }

  const token = await issueToken(env, user);
  const headers = new Headers();
  setAuthCookie(headers, token);

  await logActivity(env, {
    actorType: "user",
    actorId: user.id,
    actorLabel: user.username,
    action: "auth.login",
    message: `${user.username} signed in.`,
  });

  return json({ user: publicUser(user) }, { headers });
}

export async function handleLogout(request, env) {
  const headers = new Headers();
  clearAuthCookie(headers);
  return json({ ok: true }, { headers });
}

export async function handleRefresh(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user) return json({ user: null });
  const token = await issueToken(env, user);
  const headers = new Headers();
  setAuthCookie(headers, token);
  return json({ user: publicUser(user) }, { headers });
}

export async function handleChangePassword(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user) return badRequest("Not authenticated.");
  const body = await request.json().catch(() => ({}));
  const { currentPassword, newPassword } = body;
  if (!newPassword || newPassword.length < 8) {
    return badRequest("New password must be at least 8 characters.");
  }
  // Skip the current-password check only on a forced first-login change,
  // where the user is proving identity via the temp password already
  // (still required here for defense in depth).
  if (!currentPassword) return badRequest("Current password is required.");
  const ok = await verifyPassword(currentPassword, user.password_hash);
  if (!ok) return badRequest("Current password is incorrect.");

  const newHash = await hashPassword(newPassword);
  await env.DB.prepare(
    "UPDATE users SET password_hash = ?, must_change_password = 0, token_version = token_version + 1, updated_at = datetime('now') WHERE id = ?"
  )
    .bind(newHash, user.id)
    .run();

  const refreshedUser = { ...user, token_version: user.token_version + 1, must_change_password: 0 };
  const token = await issueToken(env, refreshedUser);
  const headers = new Headers();
  setAuthCookie(headers, token);

  await logActivity(env, {
    actorType: "user",
    actorId: user.id,
    actorLabel: user.username,
    action: "auth.change_password",
    message: `${user.username} changed their password.`,
  });

  return json({ ok: true, user: publicUser(refreshedUser) }, { headers });
}

export async function handleRegister(request, env) {
  const settings = await getSettings(env, [
    "registration_enabled",
    "registration_auto_approve",
    "registration_domain_mode",
    "registration_domain_list",
    "slug_min_chars",
  ]);
  if (!settings.registration_enabled) return badRequest("Registration is currently closed.");

  const body = await request.json().catch(() => ({}));
  const { username, email, password } = body;
  if (!username || !email || !password) return badRequest("Username, email and password are required.");
  if (!/^[a-zA-Z0-9_-]{3,32}$/.test(username)) {
    return badRequest("Username must be 3-32 characters: letters, numbers, underscore or dash.");
  }
  if (password.length < 8) return badRequest("Password must be at least 8 characters.");

  const domain = (email.split("@")[1] || "").toLowerCase();
  if (settings.registration_domain_mode === "allow_only") {
    const list = settings.registration_domain_list || [];
    if (!list.includes(domain)) return badRequest("This email domain is not allowed to register.");
  } else if (settings.registration_domain_mode === "block") {
    const list = settings.registration_domain_list || [];
    if (list.includes(domain)) return badRequest("This email domain is not allowed to register.");
  }

  const existing = await env.DB.prepare(
    "SELECT 1 FROM users WHERE username = ? COLLATE NOCASE"
  )
    .bind(username)
    .first();
  if (existing) return badRequest("That username is already taken.");

  const passwordHash = await hashPassword(password);
  const approved = !!settings.registration_auto_approve;

  const result = await env.DB.prepare(
    `INSERT INTO users (username, email, password_hash, is_root, parent_id, permissions, must_change_password, enabled, approved)
     VALUES (?, ?, ?, 0, NULL, ?, 0, 1, ?)`
  )
    .bind(username, email, passwordHash, JSON.stringify(defaultPermissions()), approved ? 1 : 0)
    .run();

  await logActivity(env, {
    actorType: "user",
    actorId: result.meta.last_row_id,
    actorLabel: username,
    action: "auth.register",
    message: approved
      ? `${username} registered a new account.`
      : `${username} registered a new account and is awaiting approval.`,
  });

  return json({
    ok: true,
    approved,
    message: approved
      ? "Account created. You can now sign in."
      : "Account created. An administrator needs to approve it before you can sign in.",
  });
}

export async function handleForgotPassword(request, env) {
  const settings = await getSettings(env, ["forgot_password_enabled"]);
  const body = await request.json().catch(() => ({}));
  const { identifier } = body;

  // Never reveal whether the account exists.
  const genericResponse = json({
    ok: true,
    message: "Password reset email will be sent if the account exists.",
  });

  if (!settings.forgot_password_enabled) {
    return badRequest("Resetting password via email is not possible. Contact with system admin.");
  }
  if (!identifier) return badRequest("Please enter your username or email.");

  const configured = await emailIsConfigured(env);
  if (!configured) {
    return badRequest("Resetting password via email is not possible. Contact with system admin.");
  }

  const user = await env.DB.prepare(
    "SELECT * FROM users WHERE (username = ? OR email = ?) COLLATE NOCASE AND enabled = 1"
  )
    .bind(identifier, identifier)
    .first();

  if (user && user.email) {
    const tempPassword = randomPassword(12);
    const newHash = await hashPassword(tempPassword);
    await env.DB.prepare(
      "UPDATE users SET password_hash = ?, must_change_password = 1, token_version = token_version + 1 WHERE id = ?"
    )
      .bind(newHash, user.id)
      .run();

    const url = new URL(request.url);
    await sendTemplatedEmail(env, "forgot_password", user.email, {
      username: user.username,
      tempPassword,
      loginUrl: `${url.origin}/login`,
    });

    await logActivity(env, {
      actorType: "user",
      actorId: user.id,
      actorLabel: user.username,
      action: "auth.forgot_password",
      message: `A password reset was requested for ${user.username}.`,
    });
  }

  return genericResponse;
}
