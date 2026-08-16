// Single source of truth for every granular permission flag in the
// system. The admin UI renders checkboxes from this list, so adding a
// new permission only requires adding it here + gating the relevant
// route/UI with hasPermission().

export const ADMIN_PERMISSIONS = [
  { key: "admin.reserved_keywords", label: "Reserved Keywords (Add / Delete)" },
  { key: "admin.activity_log", label: "Activity Log (View)" },
  { key: "admin.site_analytics", label: "Site Analytics (View)" },
  { key: "admin.site_settings", label: "Site Settings (Edit)" },
  { key: "admin.site_apis", label: "Site APIs (Edit)" },
  { key: "admin.error_defaults", label: "Default Error Settings (Edit)" },
  { key: "admin.external_tools_default", label: "Default External Tools (Edit)" },
  { key: "admin.manage_users", label: "Add/Edit/Delete Users" },
];

export const USER_PERMISSIONS = [
  { key: "url.full_iframe", label: "Full Page Iframe" },
  { key: "url.social_preview", label: "Custom Social Preview" },
  { key: "subusers.manage", label: "Sub-user Accounts" },
  { key: "api.access", label: "API & API Docs visibility" },
  { key: "activity_log.view", label: "Activity Log" },
  { key: "error_settings.edit", label: "Error Page Customization" },
  { key: "tools.manage", label: "Add own External Tools" },
];

export const ALL_PERMISSIONS = [...ADMIN_PERMISSIONS, ...USER_PERMISSIONS];

// Root admin implicitly has everything. A newly created top-level user
// (created by root) starts with every permission unchecked, same as
// before. When a PARENT USER creates/edits a SUB-USER, "Sub-user
// Accounts" is never shown or grantable in that UI - a sub-user can
// never create further sub-users, enforced server-side regardless of
// this flag - and every other permission defaults to checked except
// Error Page Customization, which defaults to unchecked. The parent
// can still adjust any of the shown ones before saving.
export function defaultPermissions() {
  const perms = {};
  for (const p of ALL_PERMISSIONS) perms[p.key] = false;
  return perms;
}

export function defaultSubuserPermissions() {
  const perms = {};
  for (const p of USER_PERMISSIONS) {
    if (p.key === "subusers.manage") continue;
    perms[p.key] = p.key !== "error_settings.edit";
  }
  return perms;
}

export function hasPermission(user, key) {
  if (!user) return false;
  if (user.is_root) return true;
  let perms = user.permissions;
  if (typeof perms === "string") {
    try {
      perms = JSON.parse(perms);
    } catch {
      perms = {};
    }
  }
  return !!(perms && perms[key]);
}
