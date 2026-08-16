import { HitCounter } from "./durable-objects/hit-counter.js";
import { getCurrentUser, getUserFromApiKey, unauthorized, forbidden } from "./lib/auth.js";
import { json, badRequest } from "./lib/utils.js";
import { hashPassword } from "./lib/crypto.js";
import { defaultPermissions } from "./lib/permissions.js";

import * as Auth from "./routes/auth.js";
import * as Urls from "./routes/urls.js";
import * as Users from "./routes/users.js";
import * as Admin from "./routes/admin.js";
import { handleSlugRedirect } from "./routes/redirect.js";

export { HitCounter };

// Ensures the root admin account exists, reading credentials from
// Cloudflare Secrets. Cheap no-op after the first request once the row
// exists. If ROOT_USERNAME/ROOT_PASSWORD secrets change later, this
// intentionally does NOT overwrite an existing root row - update the
// password via the dashboard instead.
async function ensureRootAdmin(env) {
  if (!env.ROOT_USERNAME || !env.ROOT_PASSWORD) return;
  const existing = await env.DB.prepare("SELECT id FROM users WHERE is_root = 1 LIMIT 1").first();
  if (existing) return;
  const passwordHash = await hashPassword(env.ROOT_PASSWORD);
  const isEmail = env.ROOT_USERNAME.includes("@");
  await env.DB.prepare(
    `INSERT INTO users (username, email, password_hash, is_root, parent_id, permissions, must_change_password, enabled, approved)
     VALUES (?, ?, ?, 1, NULL, ?, 1, 1, 1)`
  )
    .bind(
      isEmail ? env.ROOT_USERNAME.split("@")[0] : env.ROOT_USERNAME,
      isEmail ? env.ROOT_USERNAME : null,
      passwordHash,
      JSON.stringify(defaultPermissions())
    )
    .run();
}

// Reserved top-level path segments that must never be treated as a
// short-link slug lookup, mirroring the default reserved keywords.
const SYSTEM_PATHS = new Set(["dashboard", "login", "register", "api", "img", "css", "js"]);

async function requireAuth(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user) return { error: unauthorized() };
  return { user };
}

async function requireApiKeyAuth(request, env) {
  const result = await getUserFromApiKey(request, env);
  if (!result) return { error: unauthorized("Invalid or missing API key.") };
  return { user: result.user };
}

function idFromPath(request, prefix) {
  const path = new URL(request.url).pathname;
  const rest = path.slice(prefix.length);
  const id = parseInt(rest.replace(/^\//, ""), 10);
  return Number.isFinite(id) ? id : null;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      await ensureRootAdmin(env);

      // -----------------------------------------------------------
      // API routes
      // -----------------------------------------------------------
      if (path.startsWith("/api/")) {
        const response = await routeApi(request, env, path, method);
        if (response) return response;
        return badRequest("Unknown API route.");
      }

      // -----------------------------------------------------------
      // Known static/SPA routes -> serve via the static asset binding
      // -----------------------------------------------------------
      if (
        path === "/" ||
        path === "/login" ||
        path === "/register" ||
        path === "/dashboard" ||
        path.startsWith("/dashboard/") ||
        path.startsWith("/img/") ||
        path.startsWith("/css/") ||
        path.startsWith("/js/") ||
        path.includes(".")
      ) {
        return env.ASSETS.fetch(request);
      }

      // -----------------------------------------------------------
      // Everything else is treated as a short-link slug lookup
      // -----------------------------------------------------------
      const slug = path.slice(1);
      if (!slug || SYSTEM_PATHS.has(slug.toLowerCase())) {
        return env.ASSETS.fetch(request);
      }
      return handleSlugRedirect(request, env, slug);
    } catch (err) {
      return json({ error: "Internal error: " + err.message }, { status: 500 });
    }
  },
};

async function routeApi(request, env, path, method) {
  // ---- Public (no auth) ----
  if (path === "/api/site-info" && method === "GET") return Admin.handleSiteInfo(request, env);
  if (path === "/api/me" && method === "GET") return Auth.handleMe(request, env);
  if (path === "/api/auth/login" && method === "POST") return Auth.handleLogin(request, env);
  if (path === "/api/auth/logout" && method === "POST") return Auth.handleLogout(request, env);
  if (path === "/api/auth/refresh" && method === "POST") return Auth.handleRefresh(request, env);
  if (path === "/api/auth/register" && method === "POST") return Auth.handleRegister(request, env);
  if (path === "/api/auth/forgot-password" && method === "POST") return Auth.handleForgotPassword(request, env);

  // ---- Public API-key-authed endpoints ----
  if (path === "/api/checkAvailability" && method === "POST") {
    const { user, error } = await requireApiKeyAuth(request, env);
    if (error) return error;
    return Urls.handleCheckAvailability(request, env, user);
  }
  if (path === "/api/newEntry" && method === "POST") {
    const { user, error } = await requireApiKeyAuth(request, env);
    if (error) return error;
    return Urls.handleApiNewEntry(request, env, user);
  }
  if (path === "/api/deleteEntry" && method === "POST") {
    const { user, error } = await requireApiKeyAuth(request, env);
    if (error) return error;
    return Urls.handleApiDeleteEntry(request, env, user);
  }

  // ---- Everything below requires a logged-in dashboard session ----
  const { user, error } = await requireAuth(request, env);
  if (error) return error;

  if (path === "/api/auth/change-password" && method === "POST") return Auth.handleChangePassword(request, env);

  // A user must change their temporary password before touching
  // anything else in the dashboard.
  if (user.must_change_password && path !== "/api/auth/change-password") {
    return forbidden("You must change your password before continuing.");
  }

  if (path === "/api/urls/bulk" && method === "POST") return Urls.handleBulkUpdateUrls(request, env, user);
  if (path === "/api/urls" && method === "GET") return Urls.handleListUrls(request, env, user);
  if (path === "/api/urls" && method === "POST") return Urls.handleCreateUrl(request, env, user);
  if (path.match(/^\/api\/urls\/\d+$/) && method === "PUT") {
    return Urls.handleUpdateUrl(request, env, user, idFromPath(request, "/api/urls"));
  }
  if (path.match(/^\/api\/urls\/\d+$/) && method === "DELETE") {
    return Urls.handleDeleteUrl(request, env, user, idFromPath(request, "/api/urls"));
  }
  if (path.match(/^\/api\/urls\/\d+\/analytics$/) && method === "GET") {
    const id = parseInt(path.split("/")[3], 10);
    return Urls.handleUrlAnalytics(request, env, user, id);
  }
  if (path === "/api/urls/import" && method === "POST") return Admin.handleImportUrls(request, env, user);
  if (path === "/api/urls/export" && method === "GET") return Admin.handleExportUrls(request, env, user);
  if (path === "/api/upload-image" && method === "POST") return Urls.handleUploadImage(request, env, user);

  if (path === "/api/users" && method === "GET") return Users.handleListUsers(request, env, user);
  if (path === "/api/users" && method === "POST") return Users.handleCreateUser(request, env, user);
  if (path.match(/^\/api\/users\/\d+$/) && method === "PUT") {
    return Users.handleUpdateUser(request, env, user, idFromPath(request, "/api/users"));
  }
  if (path.match(/^\/api\/users\/\d+$/) && method === "DELETE") {
    return Users.handleDeleteUser(request, env, user, idFromPath(request, "/api/users"));
  }
  if (path.match(/^\/api\/users\/\d+\/resolve-subusers$/) && method === "POST") {
    const id = parseInt(path.split("/")[3], 10);
    return Users.handleResolveSubusers(request, env, user, id);
  }
  if (path.match(/^\/api\/users\/\d+\/reset-password$/) && method === "POST") {
    const id = parseInt(path.split("/")[3], 10);
    return Users.handleResetPassword(request, env, user, id);
  }
  if (path.match(/^\/api\/users\/\d+\/approve$/) && method === "POST") {
    const id = parseInt(path.split("/")[3], 10);
    return Users.handleApproveUser(request, env, user, id);
  }
  if (path === "/api/users/resolve-subusers-global" && method === "POST") {
    return Users.handleResolveSubusersGlobal(request, env, user);
  }
  if (path === "/api/users/unsuspend-subusers-global" && method === "POST") {
    return Users.handleUnsuspendSubusersGlobal(request, env, user);
  }

  if (path === "/api/site-analytics" && method === "GET") return Admin.handleSiteAnalytics(request, env, user);

  if (path === "/api/error-settings" && method === "GET") return Admin.handleGetErrorSettings(request, env, user);
  if (path === "/api/error-settings" && method === "PUT") return Admin.handleUpdateErrorSettings(request, env, user);

  if (path === "/api/settings/test-email" && method === "POST") return Admin.handleSendTestEmail(request, env, user);

  if (path === "/api/settings" && method === "GET") return Admin.handleGetSettings(request, env, user);
  if (path === "/api/settings" && method === "PUT") return Admin.handleUpdateSettings(request, env, user);

  if (path === "/api/email-templates" && method === "GET") return Admin.handleListEmailTemplates(request, env, user);
  if (path === "/api/email-templates" && method === "PUT") return Admin.handleUpdateEmailTemplates(request, env, user);

  if (path === "/api/reserved-keywords" && method === "GET") return Admin.handleListReservedKeywords(request, env, user);
  if (path === "/api/reserved-keywords" && method === "POST") return Admin.handleAddReservedKeyword(request, env, user);
  if (path.match(/^\/api\/reserved-keywords\/\d+$/) && method === "DELETE") {
    return Admin.handleDeleteReservedKeyword(request, env, user, idFromPath(request, "/api/reserved-keywords"));
  }
  if (path === "/api/reserved-keywords/import" && method === "POST") return Admin.handleImportReservedKeywords(request, env, user);
  if (path === "/api/reserved-keywords/export" && method === "GET") return Admin.handleExportReservedKeywords(request, env, user);

  if (path === "/api/activity-log" && method === "GET") return Admin.handleActivityLog(request, env, user);

  if (path === "/api/tools" && method === "GET") return Admin.handleListTools(request, env, user);
  if (path === "/api/tools" && method === "POST") return Admin.handleCreateTool(request, env, user);
  if (path.match(/^\/api\/tools\/\d+$/) && method === "DELETE") {
    return Admin.handleDeleteTool(request, env, user, idFromPath(request, "/api/tools"));
  }

  if (path === "/api/api-keys" && method === "GET") return Admin.handleListApiKeys(request, env, user);
  if (path === "/api/api-keys" && method === "POST") return Admin.handleCreateApiKey(request, env, user);
  if (path.match(/^\/api\/api-keys\/\d+$/) && method === "PUT") {
    return Admin.handleUpdateApiKey(request, env, user, idFromPath(request, "/api/api-keys"));
  }
  if (path.match(/^\/api\/api-keys\/\d+$/) && method === "DELETE") {
    return Admin.handleDeleteApiKey(request, env, user, idFromPath(request, "/api/api-keys"));
  }

  return null;
}
