import { get, post, put, del, escapeHtml, formatDate, fileToBase64 } from "/js/api.js";

// Keep in sync with src/lib/permissions.js on the server.
const ADMIN_PERMISSIONS = [
  { key: "admin.reserved_keywords", label: "Reserved Keywords (Add / Delete)" },
  { key: "admin.activity_log", label: "Activity Log (View all)" },
  { key: "admin.site_analytics", label: "Site Analytics (View)" },
  { key: "admin.site_settings", label: "Site Settings (Edit)" },
  { key: "admin.site_apis", label: "Site APIs (Edit)" },
  { key: "admin.error_defaults", label: "Default Error Page Settings (Edit)" },
  { key: "admin.external_tools_default", label: "Default External Tools (Edit)" },
  { key: "admin.manage_users", label: "Add/Edit/Delete Users" },
];
const USER_PERMISSIONS = [
  { key: "url.full_iframe", label: "Full Page Iframe" },
  { key: "url.social_preview", label: "Custom Social Preview" },
  { key: "subusers.manage", label: "Sub-user Accounts" },
  { key: "api.access", label: "API & API Docs visibility" },
  { key: "activity_log.view", label: "Activity Log" },
  { key: "error_settings.edit", label: "Error Page Customization" },
  { key: "tools.manage", label: "Add own External Tools" },
];
const ALL_PERMISSIONS = [...ADMIN_PERMISSIONS, ...USER_PERMISSIONS];

const state = { user: null, settings: {}, tab: "links" };

// Safety net: never let a raw, unstyled browser error surface to the
// user. Log it for debugging and show a normal toast instead.
window.addEventListener("error", (e) => {
  console.error("Unhandled error:", e.error || e.message);
});
window.addEventListener("unhandledrejection", (e) => {
  console.error("Unhandled promise rejection:", e.reason);
});

function hasPerm(key) {
  return state.user.isRoot || !!(state.user.permissions && state.user.permissions[key]);
}

function toast(message, isError = false) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = message;
  el.className = "toast show" + (isError ? " error" : "");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.className = "toast"), 3200);
}

function openModal(html) {
  const root = document.getElementById("modal-root");
  if (!root) return;
  root.innerHTML = `<div class="modal-backdrop" id="mb"><div class="modal">${html}</div></div>`;
  const backdrop = root.querySelector("#mb");
  if (backdrop) {
    backdrop.addEventListener("click", (e) => {
      if (e.target.id === "mb") closeModal();
    });
  }
  lucide.createIcons();
}
function closeModal() {
  const root = document.getElementById("modal-root");
  if (root) root.innerHTML = "";
}

// -----------------------------------------------------------------
// Bootstrap
// -----------------------------------------------------------------
async function boot() {
  let me;
  try {
    me = await get("/api/me");
  } catch {
    window.location.href = "/login";
    return;
  }
  if (!me.user) {
    window.location.href = "/login";
    return;
  }
  state.user = me.user;
  state.settings = await get("/api/site-info").catch(() => ({}));

  applyBranding();

  if (state.user.mustChangePassword) {
    showForcedPasswordChange();
    return;
  }

  document.getElementById("app-shell").style.display = "flex";
  renderSidebar();
  renderUserChip();
  await navigate("links");

  document.getElementById("menu-toggle").addEventListener("click", () => {
    document.getElementById("sidebar").classList.toggle("open");
  });

  // Silently refresh the auth token periodically so long-lived tabs
  // don't get logged out mid-session.
  setInterval(() => post("/api/auth/refresh").catch(() => {}), 20 * 60 * 1000);
}

function applyBranding() {
  const s = state.settings;
  if (s.theme_color) document.documentElement.style.setProperty("--accent", s.theme_color);
  if (s.site_title) document.title = `Dashboard - ${s.site_title}`;
  if (s.favicon_url) document.getElementById("favicon").href = s.favicon_url;
}

function showForcedPasswordChange() {
  const el = document.getElementById("blocking-screen");
  el.style.display = "flex";
  el.style.cssText = "display:flex;align-items:center;justify-content:center;min-height:100vh;";
  el.innerHTML = `
    <div class="card" style="max-width:380px;width:calc(100% - 40px);">
      <h1>Set a new password</h1>
      <p>For security, you need to change your password before continuing.</p>
      <div id="pw-alert"></div>
      <form id="force-pw-form" class="stack">
        <div class="field">
          <label>Current (temporary) password</label>
          <input type="password" id="cur-pw" required>
        </div>
        <div class="field">
          <label>New password</label>
          <input type="password" id="new-pw" minlength="8" required>
          <div class="hint">At least 8 characters.</div>
        </div>
        <button class="btn btn-primary" style="width:100%;justify-content:center;">Update password</button>
      </form>
    </div>`;
  document.getElementById("force-pw-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const alertBox = document.getElementById("pw-alert");
    try {
      await post("/api/auth/change-password", {
        currentPassword: document.getElementById("cur-pw").value,
        newPassword: document.getElementById("new-pw").value,
      });
      window.location.reload();
    } catch (err) {
      alertBox.innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
    }
  });
}

// -----------------------------------------------------------------
// Sidebar / navigation
// -----------------------------------------------------------------
function renderSidebar() {
  const s = state.settings;
  const items = [{ id: "links", icon: "link", label: "My Links" }];

  items.push({ id: "tools", icon: "wrench", label: "External Tools" });

  const subusersFeatureOn = s.subusers_feature_enabled !== false;
  const showUsers =
    state.user.isRoot ||
    ((hasPerm("subusers.manage") || hasPerm("admin.manage_users")) && subusersFeatureOn);
  if (showUsers) items.push({ id: "users", icon: "users", label: state.user.isRoot ? "Users" : "Sub-users" });

  if (hasPerm("api.access")) items.push({ id: "api", icon: "key-round", label: "API & Docs" });

  const showActivity = state.user.isRoot || hasPerm("admin.activity_log") || hasPerm("activity_log.view");
  if (showActivity) items.push({ id: "activity", icon: "history", label: "Activity Log" });

  if (state.user.isRoot || hasPerm("error_settings.edit")) {
    items.push({ id: "errorpages", icon: "octagon-alert", label: "Error Pages" });
  }

  const adminItems = [];
  if (state.user.isRoot || hasPerm("admin.site_analytics")) {
    adminItems.push({ id: "analytics", icon: "bar-chart-3", label: "Site Analytics" });
  }
  if (state.user.isRoot || hasPerm("admin.site_settings") || hasPerm("admin.site_apis")) {
    adminItems.push({ id: "settings", icon: "settings", label: "Site Settings" });
  }
  if (state.user.isRoot || hasPerm("admin.reserved_keywords")) {
    adminItems.push({ id: "reserved", icon: "shield-ban", label: "Reserved Keywords" });
  }

  const sidebar = document.getElementById("sidebar");
  sidebar.innerHTML = `
    <div class="sidebar-brand">
      ${s.logo_url ? `<img src="${escapeHtml(s.logo_url)}" onerror="this.style.display='none'">` : ""}
      <span>${escapeHtml(s.site_title || "RShort v3")}</span>
    </div>
    <div class="nav-group">
      ${items.map(navItemHtml).join("")}
    </div>
    ${adminItems.length ? `<div class="nav-label">Admin</div><div class="nav-group">${adminItems.map(navItemHtml).join("")}</div>` : ""}
  `;

  sidebar.querySelectorAll(".nav-item").forEach((el) => {
    el.addEventListener("click", () => {
      navigate(el.dataset.id);
      document.getElementById("sidebar").classList.remove("open");
    });
  });
  lucide.createIcons();
}

function navItemHtml(item) {
  return `<div class="nav-item" data-id="${item.id}">
    <i data-lucide="${item.icon}" class="icon"></i>${escapeHtml(item.label)}
    ${item.id === "users" && state.pendingCount ? `<span class="badge-dot">${state.pendingCount}</span>` : ""}
  </div>`;
}

function renderUserChip() {
  const chip = document.getElementById("user-chip");
  chip.innerHTML = `<i data-lucide="user-circle" class="icon"></i>
    <span>${escapeHtml(state.user.username)}${state.user.isRoot ? " (root)" : ""}</span>
    <i data-lucide="chevron-down" class="icon"></i>`;
  chip.addEventListener("click", (e) => {
    e.stopPropagation();
    openUserMenu();
  });
  lucide.createIcons();
}

function openUserMenu() {
  const existing = document.getElementById("user-menu-pop");
  if (existing) return existing.remove();
  const chip = document.getElementById("user-chip");
  const pop = document.createElement("div");
  pop.id = "user-menu-pop";
  pop.style.cssText =
    "position:absolute;right:24px;top:56px;background:#fff;border:1px solid var(--line);border-radius:10px;box-shadow:var(--shadow);min-width:180px;z-index:60;overflow:hidden;";
  pop.innerHTML = `
    <div class="nav-item" id="change-pw-item" style="border-radius:0;">Change password</div>
    <div class="nav-item" id="logout-item" style="border-radius:0;color:var(--danger);">Log out</div>`;
  document.body.appendChild(pop);
  document.getElementById("change-pw-item").addEventListener("click", () => {
    pop.remove();
    openChangePasswordModal();
  });
  document.getElementById("logout-item").addEventListener("click", async () => {
    await post("/api/auth/logout").catch(() => {});
    window.location.href = "/login";
  });
  setTimeout(() => document.addEventListener("click", () => pop.remove(), { once: true }));
}

function openChangePasswordModal() {
  openModal(`
    <div class="modal-header"><h3>Change password</h3><button class="btn btn-ghost" onclick="window.__closeModal()"><i data-lucide="x" class="icon"></i></button></div>
    <div id="cp-alert"></div>
    <form id="cp-form" class="stack">
      <div class="field"><label>Current password</label><input type="password" id="cp-cur" required></div>
      <div class="field"><label>New password</label><input type="password" id="cp-new" minlength="8" required></div>
      <button class="btn btn-primary">Update password</button>
    </form>`);
  document.getElementById("cp-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const alertBox = document.getElementById("cp-alert");
    try {
      await post("/api/auth/change-password", {
        currentPassword: document.getElementById("cp-cur").value,
        newPassword: document.getElementById("cp-new").value,
      });
      closeModal();
      toast("Password updated.");
    } catch (err) {
      alertBox.innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
    }
  });
}
window.__closeModal = closeModal;

async function navigate(tab) {
  state.tab = tab;
  document.querySelectorAll(".nav-item").forEach((el) => el.classList.toggle("active", el.dataset.id === tab));
  const content = document.getElementById("content");
  content.innerHTML = `<p>Loading...</p>`;
  try {
    if (tab === "links") await renderLinksPage(content);
    else if (tab === "users") await renderUsersPage(content);
    else if (tab === "api") await renderApiPage(content);
    else if (tab === "activity") await renderActivityPage(content);
    else if (tab === "errorpages") await renderErrorPagesPage(content);
    else if (tab === "analytics") await renderSiteAnalyticsPage(content);
    else if (tab === "tools") await renderToolsPage(content);
    else if (tab === "settings") await renderSettingsPage(content);
    else if (tab === "reserved") await renderReservedPage(content);
  } catch (err) {
    content.innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
  }
  lucide.createIcons();
}

// -----------------------------------------------------------------
// Links page
// -----------------------------------------------------------------
async function renderLinksPage(content) {
  content.innerHTML = `
    <div class="page-header"><h2>My Links</h2>
      <div class="row">
        <button class="btn btn-secondary btn-sm" id="import-btn"><i data-lucide="upload" class="icon"></i>Import</button>
        <a class="btn btn-secondary btn-sm" href="/api/urls/export"><i data-lucide="download" class="icon"></i>Export</a>
        <button class="btn btn-secondary btn-sm" id="refresh-btn"><i data-lucide="refresh-cw" class="icon"></i>Refresh</button>
      </div>
    </div>
    <div class="card" style="margin-bottom:20px;">
      <h3 style="margin-bottom:14px;">Create a short link</h3>
      ${linkFormHtml()}
    </div>
    <div id="links-table-wrap"><p>Loading links...</p></div>
  `;
  wireLinkForm(document, null);
  document.getElementById("refresh-btn").addEventListener("click", () => loadLinksTable());
  document.getElementById("import-btn").addEventListener("click", openImportModal);
  await loadLinksTable();
}

function linkFormHtml(existing) {
  const socialAllowed = hasPerm("url.social_preview");
  const iframeAllowed = hasPerm("url.full_iframe");
  const s = existing || {};
  return `
    <form id="link-form" class="stack" data-id="${s.id || ""}">
      <div class="grid-2">
        <div class="field">
          <label>Target URL</label>
          <input name="target" required placeholder="https://example.com/page" value="${escapeHtml(s.target || "")}">
        </div>
        <div class="field">
          <label>Custom slug (optional)</label>
          <input name="slug" placeholder="Leave blank for a random slug" value="${escapeHtml(s.slug || "")}">
        </div>
      </div>
      <div class="grid-2">
        <div class="field">
          <label>Password (optional)</label>
          <input name="password" placeholder="Leave blank for no password" value="${escapeHtml(s.password || "")}">
        </div>
        <div class="field" style="display:flex;flex-direction:column;justify-content:flex-end;gap:10px;">
          ${iframeAllowed ? `<div class="checkbox-row"><input type="checkbox" id="lf-iframe" name="fullIframe" ${s.fullIframe ? "checked" : ""}><label for="lf-iframe">Full page iframe</label></div>` : ""}
        </div>
      </div>
      ${socialAllowed ? `
      <div class="checkbox-row">
        <input type="checkbox" id="lf-social" name="socialEnabled" ${s.socialEnabled ? "checked" : ""}>
        <label for="lf-social">Custom social preview</label>
      </div>
      <div id="social-fields" style="display:${s.socialEnabled ? "block" : "none"};" class="stack">
        <div class="grid-2">
          <div class="field"><label>Preview title</label><input name="socialTitle" value="${escapeHtml(s.socialTitle || "")}"></div>
          <div class="field"><label>Preview description</label><input name="socialDescription" value="${escapeHtml(s.socialDescription || "")}"></div>
        </div>
        <div class="field">
          <label>Preview image</label>
          <div id="social-image-input"></div>
        </div>
      </div>` : ""}
      <div class="row">
        <button type="submit" class="btn btn-primary">${s.id ? "Save changes" : "Create link"}</button>
        ${s.id ? `<button type="button" class="btn btn-secondary" id="link-cancel">Cancel</button>` : ""}
      </div>
    </form>`;
}

function renderSocialImageInput(container, existing, imgbbEnabled) {
  const source = existing && existing.socialImageSource;
  const canConfigure = state.user.isRoot || hasPerm("admin.site_apis");
  container.innerHTML = imgbbEnabled
    ? `
      <div class="row" style="margin-bottom:8px;">
        <label class="checkbox-row"><input type="radio" name="img-mode" value="upload" ${source !== "url" ? "checked" : ""}> Upload image</label>
        <label class="checkbox-row"><input type="radio" name="img-mode" value="url" ${source === "url" ? "checked" : ""}> Image URL</label>
      </div>
      <input type="file" id="social-image-file" accept="image/*" style="display:${source === "url" ? "none" : "block"};">
      <input type="text" id="social-image-url" placeholder="https://..." style="display:${source === "url" ? "block" : "none"};" value="${escapeHtml((existing && existing.socialImageUrl) || "")}">
      ${existing && existing.socialImageUrl ? `<div class="hint">Current: <a href="${escapeHtml(existing.socialImageUrl)}" target="_blank">view image</a></div>` : ""}
    `
    : `
      <input type="text" id="social-image-url" placeholder="https://..." value="${escapeHtml((existing && existing.socialImageUrl) || "")}">
      ${canConfigure ? `<div class="hint">Image hosting (ImgBB) is not configured on this site, so only an image URL can be used.</div>` : ""}
    `;

  if (imgbbEnabled) {
    container.querySelectorAll('input[name="img-mode"]').forEach((r) =>
      r.addEventListener("change", () => {
        const mode = container.querySelector('input[name="img-mode"]:checked').value;
        container.querySelector("#social-image-file").style.display = mode === "upload" ? "block" : "none";
        container.querySelector("#social-image-url").style.display = mode === "url" ? "block" : "none";
      })
    );
  }
}

function wireLinkForm(root, existing) {
  const form = root.querySelector("#link-form");
  const socialToggle = root.querySelector("#lf-social");
  const socialFields = root.querySelector("#social-fields");
  const socialImgContainer = root.querySelector("#social-image-input");
  if (socialImgContainer) {
    renderSocialImageInput(socialImgContainer, existing, !!state.settings.imgbbConfigured);
  }

  if (socialToggle && socialFields) {
    socialToggle.addEventListener("change", () => {
      socialFields.style.display = socialToggle.checked ? "block" : "none";
    });
  }

  const cancelBtn = root.querySelector("#link-cancel");
  if (cancelBtn) cancelBtn.addEventListener("click", () => closeModal());

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const body = {
      target: fd.get("target"),
      slug: fd.get("slug") || undefined,
      password: fd.get("password") || "",
      fullIframe: fd.get("fullIframe") === "on",
      socialEnabled: fd.get("socialEnabled") === "on",
      socialTitle: fd.get("socialTitle") || "",
      socialDescription: fd.get("socialDescription") || "",
    };

    if (body.socialEnabled) {
      const mode = form.querySelector('input[name="img-mode"]:checked');
      if (mode && mode.value === "upload") {
        const fileInput = form.querySelector("#social-image-file");
        if (fileInput && fileInput.files[0]) {
          body.socialImageBase64 = await fileToBase64(fileInput.files[0]);
        }
      } else {
        const urlInput = form.querySelector("#social-image-url");
        if (urlInput) body.socialImageUrl = urlInput.value;
      }
    }

    const id = form.dataset.id;
    try {
      if (id) {
        await put(`/api/urls/${id}`, body);
        toast("Link updated.");
        closeModal();
      } else {
        const res = await post("/api/urls", body);
        toast(`Link created: /${res.slug}`);
        form.reset();
        if (socialFields) socialFields.style.display = "none";
      }
      await loadLinksTable();
    } catch (err) {
      toast(err.message, true);
    }
  });
}

let linksCache = [];
let selectedLinkIds = new Set();

async function loadLinksTable() {
  const wrap = document.getElementById("links-table-wrap");
  if (!wrap) return;
  const res = await get("/api/urls");
  linksCache = res.urls;
  selectedLinkIds = new Set([...selectedLinkIds].filter((id) => linksCache.some((u) => String(u.id) === String(id))));
  if (!linksCache.length) {
    wrap.innerHTML = `<div class="empty-state"><i data-lucide="link-2" class="icon" style="width:28px;height:28px;"></i><p>No short links yet. Create your first one above.</p></div>`;
    lucide.createIcons();
    return;
  }
  const showOwnerCols = state.user.isRoot || hasPerm("subusers.manage");
  wrap.innerHTML = `
    <div id="bulk-action-bar"></div>
    <div class="card" style="padding:0;overflow-x:auto;">
      <table>
        <thead><tr>
          <th style="width:36px;"><input type="checkbox" id="select-all-links"></th>
          <th>Slug</th><th>Target</th>${showOwnerCols ? "<th>Owner</th><th>Parent User</th>" : ""}
          <th>Hits</th><th>Enabled</th><th></th>
        </tr></thead>
        <tbody>
          ${linksCache.map(rowHtml(showOwnerCols)).join("")}
        </tbody>
      </table>
    </div>`;
  wrap.querySelectorAll("[data-edit]").forEach((btn) =>
    btn.addEventListener("click", () => openEditLinkModal(btn.dataset.edit))
  );
  wrap.querySelectorAll("[data-analytics]").forEach((btn) =>
    btn.addEventListener("click", () => openAnalyticsModal(btn.dataset.analytics))
  );
  wrap.querySelectorAll("[data-delete]").forEach((btn) =>
    btn.addEventListener("click", () => confirmDeleteLink(btn.dataset.delete))
  );
  wrap.querySelectorAll("[data-toggle-link]").forEach((btn) =>
    btn.addEventListener("click", () => toggleLinkEnabled(btn.dataset.toggleLink, btn.dataset.enable === "1"))
  );
  wrap.querySelectorAll("[data-select-link]").forEach((cb) =>
    cb.addEventListener("change", () => {
      if (cb.checked) selectedLinkIds.add(cb.dataset.selectLink);
      else selectedLinkIds.delete(cb.dataset.selectLink);
      syncSelectAllCheckbox();
      renderBulkActionBar();
    })
  );
  const selectAll = document.getElementById("select-all-links");
  selectAll.addEventListener("change", () => {
    if (selectAll.checked) {
      linksCache.forEach((u) => selectedLinkIds.add(String(u.id)));
    } else {
      selectedLinkIds.clear();
    }
    wrap.querySelectorAll("[data-select-link]").forEach((cb) => (cb.checked = selectedLinkIds.has(cb.dataset.selectLink)));
    renderBulkActionBar();
  });
  syncSelectAllCheckbox();
  renderBulkActionBar();
  lucide.createIcons();
}

function syncSelectAllCheckbox() {
  const selectAll = document.getElementById("select-all-links");
  if (!selectAll) return;
  selectAll.checked = linksCache.length > 0 && linksCache.every((u) => selectedLinkIds.has(String(u.id)));
  selectAll.indeterminate = selectedLinkIds.size > 0 && !selectAll.checked;
}

function renderBulkActionBar() {
  const bar = document.getElementById("bulk-action-bar");
  if (!bar) return;
  const count = selectedLinkIds.size;
  if (!count) {
    bar.innerHTML = "";
    return;
  }
  const canTransfer = !state.user.parentId; // subusers never see transfer
  bar.innerHTML = `
    <div class="card" style="margin-bottom:14px;background:#f4f7f3;">
      <div class="row" style="flex-wrap:wrap;gap:8px;align-items:center;">
        <strong style="margin-right:6px;">${count} selected</strong>
        <button class="btn btn-secondary btn-sm" data-bulk="enable">Enable all</button>
        <button class="btn btn-secondary btn-sm" data-bulk="disable">Disable all</button>
        <button class="btn btn-secondary btn-sm" data-bulk="removePassword">Remove password</button>
        <button class="btn btn-secondary btn-sm" data-bulk="applyPassword">Apply password</button>
        <button class="btn btn-secondary btn-sm" data-bulk="iframeOn">Turn on iframe</button>
        <button class="btn btn-secondary btn-sm" data-bulk="iframeOff">Turn off iframe</button>
        ${canTransfer ? `<button class="btn btn-secondary btn-sm" data-bulk="transfer">Transfer to...</button>` : ""}
        <button class="btn btn-danger btn-sm" data-bulk="delete">Delete all</button>
        <button class="btn btn-ghost btn-sm" id="bulk-clear" style="margin-left:auto;">Clear selection</button>
      </div>
    </div>`;
  bar.querySelectorAll("[data-bulk]").forEach((btn) =>
    btn.addEventListener("click", () => handleBulkActionClick(btn.dataset.bulk))
  );
  document.getElementById("bulk-clear").addEventListener("click", () => {
    selectedLinkIds.clear();
    loadLinksTable();
  });
}

async function handleBulkActionClick(action) {
  const ids = [...selectedLinkIds];
  if (!ids.length) return;

  if (action === "delete") {
    if (!confirm(`Delete ${ids.length} short link(s)? This cannot be undone.`)) return;
    await runBulkAction(action, ids);
    return;
  }

  if (action === "applyPassword") {
    const password = prompt(`Enter the password to apply to all ${ids.length} selected link(s):`);
    if (password === null) return;
    if (!password) {
      toast("Password cannot be empty.", true);
      return;
    }
    await runBulkAction(action, ids, { password });
    return;
  }

  if (action === "transfer") {
    await openBulkTransferModal(ids);
    return;
  }

  await runBulkAction(action, ids);
}

async function runBulkAction(action, ids, extra = {}) {
  try {
    const res = await post("/api/urls/bulk", { action, ids, ...extra });
    toast(`Updated ${res.affected} link(s).${res.skipped ? ` ${res.skipped} skipped.` : ""}`);
    selectedLinkIds.clear();
    await loadLinksTable();
  } catch (err) {
    toast(err.message, true);
  }
}

async function openBulkTransferModal(ids) {
  let users = [];
  try {
    const res = await get("/api/users");
    users = res.users || [];
  } catch {
    users = [];
  }

  let targets;
  if (state.user.isRoot) {
    targets = users; // any parent or subuser
  } else {
    // A parent can transfer to themselves or to one of their own sub-users.
    targets = [
      { id: state.user.id, username: `${state.user.username} (you)` },
      ...users.filter((u) => String(u.parentId) === String(state.user.id)),
    ];
  }

  if (!targets.length) {
    toast("No eligible destination account found.", true);
    return;
  }

  openModal(`
    <div class="modal-header"><h3>Transfer ${ids.length} link(s)</h3></div>
    <div id="bt-alert"></div>
    <form id="bt-form" class="stack">
      <div class="field">
        <label>Transfer to</label>
        <select id="bt-target">
          ${targets.map((u) => `<option value="${u.id}">${escapeHtml(u.username)}</option>`).join("")}
        </select>
      </div>
      <button class="btn btn-primary" type="submit">Transfer</button>
    </form>`);

  document.getElementById("bt-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const res = await post("/api/urls/bulk", {
        action: "transfer",
        ids,
        transferToId: document.getElementById("bt-target").value,
      });
      closeModal();
      toast(`Transferred ${res.affected} link(s).`);
      selectedLinkIds.clear();
      await loadLinksTable();
    } catch (err) {
      document.getElementById("bt-alert").innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
    }
  });
}

async function toggleLinkEnabled(id, enable) {
  try {
    await put(`/api/urls/${id}`, { enabled: enable });
    await loadLinksTable();
  } catch (err) {
    toast(err.message, true);
  }
}

function rowHtml(showOwnerCols) {
  return (u) => `
    <tr>
      <td><input type="checkbox" data-select-link="${u.id}" ${selectedLinkIds.has(String(u.id)) ? "checked" : ""}></td>
      <td><a href="/${escapeHtml(u.slug)}" target="_blank">/${escapeHtml(u.slug)}</a></td>
      <td style="max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(u.target)}">${escapeHtml(u.target)}</td>
      ${showOwnerCols ? `<td>${escapeHtml(u.createdBy)}</td><td>${escapeHtml(u.parentUser || "-")}</td>` : ""}
      <td>${u.hits}</td>
      <td><button class="switch ${u.enabled ? "on" : ""}" data-toggle-link="${u.id}" data-enable="${u.enabled ? 0 : 1}" title="${u.enabled ? "Disable" : "Enable"}" aria-label="${u.enabled ? "Disable" : "Enable"} link"><span class="switch-knob"></span></button></td>
      <td>
        <div class="row">
          <button class="btn btn-ghost btn-sm" data-analytics="${u.id}" title="Analytics"><i data-lucide="bar-chart-2" class="icon"></i></button>
          <button class="btn btn-ghost btn-sm" data-edit="${u.id}" title="Edit"><i data-lucide="pencil" class="icon"></i></button>
          <button class="btn btn-ghost btn-sm" data-delete="${u.id}" title="Delete"><i data-lucide="trash-2" class="icon"></i></button>
        </div>
      </td>
    </tr>`;
}

function openEditLinkModal(id) {
  const u = linksCache.find((x) => String(x.id) === String(id));
  if (!u) return;
  openModal(`
    <div class="modal-header"><h3>Edit link</h3><button class="btn btn-ghost" onclick="window.__closeModal()"><i data-lucide="x" class="icon"></i></button></div>
    ${linkFormHtml(u)}
  `);
  wireLinkForm(document.getElementById("modal-root"), u);
}

async function confirmDeleteLink(id) {
  if (!confirm("Delete this short link? This cannot be undone.")) return;
  try {
    await del(`/api/urls/${id}`);
    toast("Link deleted.");
    await loadLinksTable();
  } catch (err) {
    toast(err.message, true);
  }
}

async function openAnalyticsModal(id) {
  const u = linksCache.find((x) => String(x.id) === String(id));
  openModal(`<div class="modal-header"><h3>Analytics for /${escapeHtml(u ? u.slug : "")}</h3><button class="btn btn-ghost" onclick="window.__closeModal()"><i data-lucide="x" class="icon"></i></button></div><p>Loading...</p>`);
  try {
    const data = await get(`/api/urls/${id}/analytics`);
    const modal = document.querySelector(".modal");
    modal.innerHTML = `
      <div class="modal-header"><h3>Analytics for /${escapeHtml(u ? u.slug : "")}</h3><button class="btn btn-ghost" onclick="window.__closeModal()"><i data-lucide="x" class="icon"></i></button></div>
      <p style="font-size:26px;font-weight:600;color:var(--ink);margin-bottom:18px;">${data.total} total hits</p>
      <div class="grid-2">
        <div>
          <h4>By date</h4>
          <table><thead><tr><th>Date</th><th>Hits</th></tr></thead><tbody>
            ${data.byDate.length ? data.byDate.map((r) => `<tr><td>${r.hit_date}</td><td>${r.count}</td></tr>`).join("") : '<tr><td colspan="2">No data yet</td></tr>'}
          </tbody></table>
        </div>
        <div>
          <h4>By referrer</h4>
          <table><thead><tr><th>Source</th><th>Hits</th></tr></thead><tbody>
            ${data.byReferrer.length ? data.byReferrer.map((r) => `<tr><td>${escapeHtml(r.referrer_bucket)}</td><td>${r.count}</td></tr>`).join("") : '<tr><td colspan="2">No data yet</td></tr>'}
          </tbody></table>
        </div>
      </div>`;
    lucide.createIcons();
  } catch (err) {
    toast(err.message, true);
    closeModal();
  }
}

function openImportModal() {
  openModal(`
    <div class="modal-header"><h3>Import short links</h3><button class="btn btn-ghost" onclick="window.__closeModal()"><i data-lucide="x" class="icon"></i></button></div>
    <div class="row" style="margin-bottom:12px;">
      <button type="button" class="btn btn-secondary btn-sm" id="import-tab-csv">CSV upload</button>
      <button type="button" class="btn btn-secondary btn-sm" id="import-tab-paste">Paste bulk</button>
    </div>
    <div id="import-csv-panel">
      <p>Upload a CSV file with <code>slug,target</code> per line (a header row is fine too).</p>
      <input type="file" id="import-csv-file" accept=".csv,text/csv">
    </div>
    <div id="import-paste-panel" style="display:none;">
      <p>Paste one link per line as <code>slug: target (password)</code> - the password part is optional.</p>
      <textarea id="import-text" rows="8" placeholder="google: https://google.com (1234)&#10;noauth: https://example.org"></textarea>
    </div>
    <div id="import-result" style="margin-top:10px;"></div>
    <div class="row" style="margin-top:14px;justify-content:flex-end;">
      <button class="btn btn-primary" id="import-submit">Import</button>
    </div>`);

  let mode = "csv";
  const csvPanel = document.getElementById("import-csv-panel");
  const pastePanel = document.getElementById("import-paste-panel");
  document.getElementById("import-tab-csv").addEventListener("click", () => {
    mode = "csv";
    csvPanel.style.display = "block";
    pastePanel.style.display = "none";
  });
  document.getElementById("import-tab-paste").addEventListener("click", () => {
    mode = "paste";
    csvPanel.style.display = "none";
    pastePanel.style.display = "block";
  });

  document.getElementById("import-submit").addEventListener("click", async () => {
    const resultBox = document.getElementById("import-result");
    resultBox.innerHTML = "";
    try {
      let text = "";
      if (mode === "csv") {
        const fileInput = document.getElementById("import-csv-file");
        const file = fileInput.files[0];
        if (!file) {
          resultBox.innerHTML = `<div class="alert alert-error">Choose a CSV file first.</div>`;
          return;
        }
        text = await file.text();
      } else {
        text = document.getElementById("import-text").value;
      }
      const res = await post("/api/urls/import", { text, format: mode === "paste" ? "paste" : "csv" });
      resultBox.innerHTML =
        `<div class="alert alert-ok">Imported ${res.created} link(s).${res.failed.length ? ` ${res.failed.length} failed.` : ""}</div>`;
      await loadLinksTable();
    } catch (err) {
      resultBox.innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
    }
  });
}

// -----------------------------------------------------------------
// Users / Sub-users page
// -----------------------------------------------------------------
async function renderUsersPage(content) {
  const res = await get("/api/users");
  state.pendingCount = res.pendingApprovals || 0;
  content.innerHTML = `
    <div class="page-header">
      <h2>${state.user.isRoot ? "Users" : "Sub-users"}</h2>
      <button class="btn btn-primary btn-sm" id="add-user-btn"><i data-lucide="user-plus" class="icon"></i>${state.user.isRoot ? "Add user" : "Add sub-user"}</button>
    </div>
    ${res.pendingApprovals ? `<div class="alert" style="background:#fff6e5;color:#8a6d1f;">There ${res.pendingApprovals === 1 ? "is" : "are"} ${res.pendingApprovals} account(s) awaiting approval.</div>` : ""}
    <div class="card" style="padding:0;overflow-x:auto;">
      <table><thead><tr>
        <th>Username</th><th>Email</th>${state.user.isRoot ? "<th>Parent</th>" : ""}<th>Links</th><th>Status</th><th></th>
      </tr></thead><tbody>
        ${res.users.map(userRowHtml).join("")}
      </tbody></table>
    </div>`;

  content.querySelectorAll("[data-approve]").forEach((b) => b.addEventListener("click", () => approveUser(b.dataset.approve, true)));
  content.querySelectorAll("[data-reject]").forEach((b) => b.addEventListener("click", () => approveUser(b.dataset.reject, false)));
  content.querySelectorAll("[data-edit-user]").forEach((b) => b.addEventListener("click", () => openEditUserModal(res.users.find((u) => String(u.id) === b.dataset.editUser))));
  content.querySelectorAll("[data-toggle-user]").forEach((b) => b.addEventListener("click", () => toggleUserEnabled(b.dataset.toggleUser, b.dataset.enable === "1")));
  content.querySelectorAll("[data-reset-pw]").forEach((b) => b.addEventListener("click", () => openResetPasswordModal(b.dataset.resetPw)));
  content.querySelectorAll("[data-del-user]").forEach((b) => b.addEventListener("click", () => deleteUser(b.dataset.delUser, res.users)));
  document.getElementById("add-user-btn").addEventListener("click", () => openCreateUserModal(res.users));
  lucide.createIcons();
}

function userRowHtml(u) {
  const isSelf = u.id === state.user.id;
  return `<tr>
    <td>${escapeHtml(u.username)}${u.isRoot ? ' <span class="badge badge-ok">root</span>' : ""}</td>
    <td>${escapeHtml(u.email || "-")}</td>
    ${state.user.isRoot ? `<td>${escapeHtml(u.parentUsername || "-")}</td>` : ""}
    <td>${u.urlCount}</td>
    <td>
      ${
        !u.approved
          ? '<span class="badge badge-off">Pending approval</span>'
          : u.disabledByLockout
          ? '<span class="badge badge-danger">Disabled (lockout)</span>'
          : !u.enabled
          ? '<span class="badge badge-danger">Disabled</span>'
          : u.isLockedOut
          ? '<span class="badge badge-off">Temporarily locked</span>'
          : '<span class="badge badge-ok">Enabled</span>'
      }
    </td>
    <td>
      <div class="row">
        ${!u.approved ? `<button class="btn btn-secondary btn-sm" data-approve="${u.id}">Approve</button><button class="btn btn-danger btn-sm" data-reject="${u.id}">Reject</button>` : ""}
        ${u.isRoot ? "" : `
          <button class="btn btn-ghost btn-sm" data-edit-user="${u.id}" title="Edit"><i data-lucide="pencil" class="icon"></i></button>
          <button class="btn btn-ghost btn-sm" data-reset-pw="${u.id}" title="Reset password"><i data-lucide="key-round" class="icon"></i></button>
          ${!isSelf ? `<button class="btn btn-ghost btn-sm" data-toggle-user="${u.id}" data-enable="${u.enabled ? 0 : 1}" title="${u.enabled ? "Disable" : "Enable"}"><i data-lucide="${u.enabled ? "ban" : "check"}" class="icon"></i></button>
          <button class="btn btn-ghost btn-sm" data-del-user="${u.id}" title="Delete"><i data-lucide="trash-2" class="icon"></i></button>` : ""}
        `}
      </div>
    </td>
  </tr>`;
}

async function approveUser(id, approve) {
  try {
    await post(`/api/users/${id}/approve`, { approve });
    toast(approve ? "Account approved." : "Registration rejected.");
    await navigate("users");
  } catch (err) {
    toast(err.message, true);
  }
}

// Every USER_PERMISSIONS entry defaults to checked when a parent
// creates a sub-user, except Error Page Customization, and
// Sub-user Accounts is never offered here at all.
function subuserDefaultChecklist() {
  const map = {};
  for (const p of USER_PERMISSIONS) {
    if (p.key === "subusers.manage") continue;
    map[p.key] = p.key !== "error_settings.edit";
  }
  return map;
}

function permissionCheckboxesHtml(list, current) {
  return list
    .map(
      (p) => `<div class="checkbox-row">
        <input type="checkbox" id="perm-${p.key}" name="perm" value="${p.key}" ${current && current[p.key] ? "checked" : ""}>
        <label for="perm-${p.key}">${escapeHtml(p.label)}</label>
      </div>`
    )
    .join("");
}

function openCreateUserModal() {
  const isRoot = state.user.isRoot;
  openModal(`
    <div class="modal-header"><h3>${isRoot ? "Add user" : "Add sub-user"}</h3><button class="btn btn-ghost" onclick="window.__closeModal()"><i data-lucide="x" class="icon"></i></button></div>
    <div id="cu-alert"></div>
    <form id="cu-form" class="stack">
      <div class="grid-2">
        <div class="field"><label>Username</label><input name="username" required pattern="[a-zA-Z0-9_-]{3,32}"></div>
        <div class="field"><label>Email (optional)</label><input name="email" type="email"></div>
      </div>
      <div class="field"><label>Initial password (leave blank to auto-generate)</label><input name="password" type="text" placeholder="Auto-generated if left blank"></div>
      <div class="checkbox-row">
        <input type="checkbox" id="cu-must-change" name="mustChangePassword" ${isRoot ? "checked" : ""}>
        <label for="cu-must-change">Require password change on first login</label>
      </div>
      ${isRoot ? "" : `<div class="hint">This account will be created as your sub-user.</div>`}
      <h4 style="margin-top:8px;">Permissions</h4>
      <div class="grid-2">
        ${isRoot ? `<div><div class="nav-label" style="padding-left:0;">Admin</div>${permissionCheckboxesHtml(ADMIN_PERMISSIONS, {})}</div>` : "<div></div>"}
        <div><div class="nav-label" style="padding-left:0;">User tools</div>${permissionCheckboxesHtml(
          USER_PERMISSIONS.filter((p) => (isRoot ? true : hasPerm(p.key) && p.key !== "subusers.manage")),
          isRoot ? {} : subuserDefaultChecklist()
        )}</div>
      </div>
      <button class="btn btn-primary">Create account</button>
    </form>`);

  document.getElementById("cu-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const fd = new FormData(form);
    const permissions = {};
    form.querySelectorAll('input[name="perm"]:checked').forEach((cb) => (permissions[cb.value] = true));
    try {
      const res = await post("/api/users", {
        username: fd.get("username"),
        email: fd.get("email") || undefined,
        password: fd.get("password") || undefined,
        mustChangePassword: fd.get("mustChangePassword") === "on",
        asSubuser: !isRoot,
        permissions,
      });
      closeModal();
      toast(res.temporaryPassword ? `Account created. Temporary password: ${res.temporaryPassword}` : "Account created.");
      await navigate("users");
    } catch (err) {
      document.getElementById("cu-alert").innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
    }
  });
}

function openEditUserModal(u) {
  if (!u) return;
  const isRoot = state.user.isRoot;
  openModal(`
    <div class="modal-header"><h3>Edit ${escapeHtml(u.username)}</h3><button class="btn btn-ghost" onclick="window.__closeModal()"><i data-lucide="x" class="icon"></i></button></div>
    <div id="eu-alert"></div>
    <form id="eu-form" class="stack">
      <div class="field"><label>Email</label><input name="email" type="email" value="${escapeHtml(u.email || "")}"></div>
      <h4>Permissions</h4>
      <div class="grid-2">
        ${isRoot ? `<div><div class="nav-label" style="padding-left:0;">Admin</div>${permissionCheckboxesHtml(ADMIN_PERMISSIONS, u.permissions)}</div>` : "<div></div>"}
        <div><div class="nav-label" style="padding-left:0;">User tools</div>${permissionCheckboxesHtml(
          USER_PERMISSIONS.filter((p) => (isRoot ? true : hasPerm(p.key) && (!u.parentId || p.key !== "subusers.manage"))),
          u.permissions
        )}</div>
      </div>
      <button class="btn btn-primary">Save changes</button>
    </form>`);

  document.getElementById("eu-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const fd = new FormData(form);
    const permissions = { ...u.permissions };
    ALL_PERMISSIONS.forEach((p) => (permissions[p.key] = false));
    form.querySelectorAll('input[name="perm"]:checked').forEach((cb) => (permissions[cb.value] = true));
    try {
      const res = await put(`/api/users/${u.id}`, { email: fd.get("email"), permissions });
      closeModal();
      toast("Account updated.");
      if (res.subuserActionRequired) {
        openResolveSubusersModal(u.id, res.subuserCount);
      } else {
        await navigate("users");
      }
    } catch (err) {
      document.getElementById("eu-alert").innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
    }
  });
}

async function openResolveSubusersModal(userId, count) {
  const res = await get("/api/users");
  const topLevelOthers = res.users.filter((u) => !u.parentId && u.id !== userId && !u.isRoot);
  openModal(`
    <div class="modal-header"><h3>This account has ${count} sub-user(s)</h3></div>
    <p>Sub-user management was just revoked for this account. Choose what should happen to their existing sub-users:</p>
    <div id="rs-alert"></div>
    <form id="rs-form" class="stack">
      <div class="field">
        <label class="checkbox-row"><input type="radio" name="mode" value="transfer" checked> Transfer sub-users to another user</label>
        <select id="rs-transfer-target" style="margin-top:6px;">
          ${topLevelOthers.map((u) => `<option value="${u.id}">${escapeHtml(u.username)}</option>`).join("")}
        </select>
      </div>
      <label class="checkbox-row"><input type="radio" name="mode" value="convert"> Make sub-users independent top-level users</label>
      <label class="checkbox-row"><input type="radio" name="mode" value="suspend"> Suspend sub-user accounts</label>
      <div class="checkbox-row" style="margin-left:22px;"><input type="checkbox" id="rs-disable-urls"><label for="rs-disable-urls">Also disable their short links</label></div>
      <label class="checkbox-row"><input type="radio" name="mode" value="delete"> Delete sub-users and their short links entirely</label>
      <button class="btn btn-primary">Confirm</button>
    </form>`);

  document.getElementById("rs-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const mode = document.querySelector('input[name="mode"]:checked').value;
    try {
      await post(`/api/users/${userId}/resolve-subusers`, {
        mode,
        transferToUserId: mode === "transfer" ? Number(document.getElementById("rs-transfer-target").value) : undefined,
        alsoDisableUrls: document.getElementById("rs-disable-urls").checked,
      });
      closeModal();
      toast("Sub-users updated.");
      await navigate("users");
    } catch (err) {
      document.getElementById("rs-alert").innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
    }
  });
}

function openResetPasswordModal(id) {
  openModal(`
    <div class="modal-header"><h3>Reset password</h3><button class="btn btn-ghost" onclick="window.__closeModal()"><i data-lucide="x" class="icon"></i></button></div>
    <div id="rp-alert"></div>
    <form id="rp-form" class="stack">
      <div class="field"><label>Custom password (leave blank to auto-generate)</label><input id="rp-pw" type="text"></div>
      <div class="checkbox-row">
        <input type="checkbox" id="rp-must-change">
        <label for="rp-must-change">Require password change on next login</label>
      </div>
      <button class="btn btn-primary">Reset password</button>
    </form>`);
  document.getElementById("rp-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const res = await post(`/api/users/${id}/reset-password`, {
        customPassword: document.getElementById("rp-pw").value || undefined,
        mustChangePassword: document.getElementById("rp-must-change").checked,
      });
      closeModal();
      toast(res.temporaryPassword ? `New password: ${res.temporaryPassword}` : "Password reset.");
    } catch (err) {
      document.getElementById("rp-alert").innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
    }
  });
}

async function toggleUserEnabled(id, enable) {
  try {
    await put(`/api/users/${id}`, { enabled: !!enable });
    toast(enable ? "Account enabled." : "Account disabled.");
    await navigate("users");
  } catch (err) {
    toast(err.message, true);
  }
}

async function deleteUser(id, users) {
  const target = (users || []).find((u) => String(u.id) === String(id));
  const urlCount = target ? target.urlCount : 0;

  if (!urlCount) {
    if (!confirm("Delete this account? This cannot be undone.")) return;
    try {
      await del(`/api/users/${id}`);
      toast("Account deleted.");
      await navigate("users");
    } catch (err) {
      toast(err.message, true);
    }
    return;
  }

  const otherOptions = (users || []).filter((u) => String(u.id) !== String(id) && !u.isDisabledHolder);
  const canTransfer = otherOptions.length > 0;
  openModal(`
    <div class="modal-header"><h3>Delete "${escapeHtml(target.username)}"</h3></div>
    <p>This account has <strong>${urlCount}</strong> short URL(s). What should happen to them?</p>
    <div id="du-alert"></div>
    <form id="du-form" class="stack">
      <label class="checkbox-row"><input type="radio" name="urlAction" value="transfer" ${canTransfer ? "checked" : "disabled"}> Transfer them to another account</label>
      <div class="field" style="margin-left:22px;">
        <select id="du-transfer-to" ${canTransfer ? "" : "disabled"}>
          ${otherOptions.map((u) => `<option value="${u.id}">${escapeHtml(u.username)}</option>`).join("")}
        </select>
      </div>
      <label class="checkbox-row"><input type="radio" name="urlAction" value="disable" ${canTransfer ? "" : "checked"}> Disable them (move to the "disabled" holding account)</label>
      <label class="checkbox-row"><input type="radio" name="urlAction" value="delete"> Delete them along with the account</label>
      <button type="submit" class="btn btn-primary">Delete account</button>
    </form>`);

  document.getElementById("du-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const urlAction = document.querySelector('#du-form input[name="urlAction"]:checked').value;
    const transferToId = urlAction === "transfer" ? document.getElementById("du-transfer-to").value : undefined;
    try {
      await del(`/api/users/${id}`, { urlAction, transferToId });
      closeModal();
      toast("Account deleted.");
      await navigate("users");
    } catch (err) {
      document.getElementById("du-alert").innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
    }
  });
}

// -----------------------------------------------------------------
// API & Docs page
// -----------------------------------------------------------------
async function renderApiPage(content) {
  const res = await get("/api/api-keys");
  content.innerHTML = `
    <div class="page-header"><h2>API & Docs</h2>
      <button class="btn btn-primary btn-sm" id="new-key-btn"><i data-lucide="plus" class="icon"></i>New API key</button>
    </div>
    <div class="card" style="padding:0;overflow-x:auto;margin-bottom:20px;">
      <table><thead><tr><th>Label</th><th>Key prefix</th><th>Status</th><th>Last used</th><th></th></tr></thead><tbody>
        ${res.keys.length ? res.keys.map(apiKeyRowHtml).join("") : '<tr><td colspan="5">No API keys yet.</td></tr>'}
      </tbody></table>
    </div>
    <div class="card">
      <h3>API documentation</h3>
      <p>Include your key as a bearer token: <code>Authorization: Bearer &lt;key&gt;</code>. Your key acts with your account's own permissions.</p>
      <h4>POST /api/checkAvailability</h4>
      <p>Body: <code>{ "slug": "your-slug" }</code> - checks whether a slug can be used.</p>
      <h4>POST /api/newEntry</h4>
      <p>Body: <code>{ "target": "https://...", "slug": "optional", "password": "optional", "fullIframe": false, "socialEnabled": false }</code></p>
      <h4>POST /api/deleteEntry</h4>
      <p>Body: <code>{ "slug": "your-slug" }</code></p>
    </div>`;
  content.querySelectorAll("[data-toggle-key]").forEach((b) => b.addEventListener("click", () => toggleKey(b.dataset.toggleKey, b.dataset.enable === "1")));
  content.querySelectorAll("[data-del-key]").forEach((b) => b.addEventListener("click", () => deleteKey(b.dataset.delKey)));
  document.getElementById("new-key-btn").addEventListener("click", createApiKey);
  lucide.createIcons();
}

function apiKeyRowHtml(k) {
  return `<tr>
    <td>${escapeHtml(k.label)}</td><td><code>${escapeHtml(k.key_prefix)}...</code></td>
    <td>${k.enabled ? '<span class="badge badge-ok">Enabled</span>' : '<span class="badge badge-off">Disabled</span>'}</td>
    <td>${k.last_used_at ? formatDate(k.last_used_at) : "Never"}</td>
    <td><div class="row">
      <button class="btn btn-ghost btn-sm" data-toggle-key="${k.id}" data-enable="${k.enabled ? 0 : 1}">${k.enabled ? "Disable" : "Enable"}</button>
      <button class="btn btn-ghost btn-sm" data-del-key="${k.id}"><i data-lucide="trash-2" class="icon"></i></button>
    </div></td></tr>`;
}

async function createApiKey() {
  const label = prompt('Label for this API key (e.g. "My script"):', "API Key");
  if (label === null) return;
  try {
    const res = await post("/api/api-keys", { label });
    openModal(`<div class="modal-header"><h3>API key created</h3></div>
      <p>Copy this key now. For security it will not be shown again.</p>
      <div class="row">
        <input readonly id="new-api-key-input" value="${escapeHtml(res.key)}" onclick="this.select()" style="flex:1;">
        <button class="btn btn-secondary" id="copy-api-key-btn" type="button"><i data-lucide="copy" class="icon"></i>Copy</button>
      </div>
      <div class="row" style="margin-top:14px;justify-content:flex-end;"><button class="btn btn-primary" onclick="window.__closeModal()">Done</button></div>`);
    lucide.createIcons();
    document.getElementById("copy-api-key-btn").addEventListener("click", async () => {
      const input = document.getElementById("new-api-key-input");
      try {
        await navigator.clipboard.writeText(input.value);
      } catch {
        input.select();
        document.execCommand("copy");
      }
      toast("API key copied.");
    });
    await navigate("api");
  } catch (err) {
    toast(err.message, true);
  }
}

async function toggleKey(id, enable) {
  try {
    await put(`/api/api-keys/${id}`, { enabled: !!enable });
    await navigate("api");
  } catch (err) {
    toast(err.message, true);
  }
}
async function deleteKey(id) {
  if (!confirm("Delete this API key?")) return;
  try {
    await del(`/api/api-keys/${id}`);
    toast("API key deleted.");
    await navigate("api");
  } catch (err) {
    toast(err.message, true);
  }
}

// -----------------------------------------------------------------
// Activity log
// -----------------------------------------------------------------
async function renderActivityPage(content) {
  content.innerHTML = `<div class="page-header"><h2>Activity Log</h2></div><p>Loading...</p>`;

  let usersRes = { users: [] };
  try {
    usersRes = await get("/api/users");
  } catch {
    // A sub-user without user-list access simply won't get a populated
    // Who dropdown beyond themselves; the log itself is still scoped
    // server-side regardless of this list.
  }

  await loadAndRenderActivity(content, usersRes.users || []);
}

async function loadAndRenderActivity(content, users, filters = {}) {
  const params = new URLSearchParams();
  if (filters.who) params.set("who", filters.who);
  if (filters.category) params.set("category", filters.category);
  const res = await get(`/api/activity-log${params.toString() ? "?" + params.toString() : ""}`);

  const whoOptions = users.length
    ? `<option value="">Everyone</option>${users.map((u) => `<option value="${u.id}" ${String(filters.who) === String(u.id) ? "selected" : ""}>${escapeHtml(u.username)}</option>`).join("")}`
    : `<option value="">Everyone</option>`;

  content.innerHTML = `
    <div class="page-header"><h2>Activity Log</h2>
      <button class="btn btn-secondary btn-sm" id="activity-refresh"><i data-lucide="refresh-cw" class="icon"></i>Refresh</button>
    </div>
    <div class="row" style="margin-bottom:14px;gap:10px;flex-wrap:wrap;">
      <div class="field" style="margin:0;min-width:180px;">
        <label>Who</label>
        <select id="activity-who">${whoOptions}</select>
      </div>
      <div class="field" style="margin:0;min-width:180px;">
        <label>Action</label>
        <select id="activity-category">
          <option value="">All actions</option>
          <option value="account" ${filters.category === "account" ? "selected" : ""}>Account</option>
          <option value="settings" ${filters.category === "settings" ? "selected" : ""}>Settings</option>
          <option value="links" ${filters.category === "links" ? "selected" : ""}>Links</option>
        </select>
      </div>
    </div>
    <div class="card" style="padding:0;overflow-x:auto;">
      <table><thead><tr><th>When</th><th>Who</th><th>What happened</th></tr></thead><tbody>
        ${res.entries.length ? res.entries.map((e) => `<tr><td>${formatDate(e.created_at)}</td><td>${escapeHtml(e.actor_label)}</td><td>${escapeHtml(e.message)}</td></tr>`).join("") : '<tr><td colspan="3">No activity found.</td></tr>'}
      </tbody></table>
    </div>`;

  const rerun = () => {
    const newFilters = {
      who: document.getElementById("activity-who").value,
      category: document.getElementById("activity-category").value,
    };
    loadAndRenderActivity(content, users, newFilters);
  };
  document.getElementById("activity-refresh").addEventListener("click", rerun);
  document.getElementById("activity-who").addEventListener("change", rerun);
  document.getElementById("activity-category").addEventListener("change", rerun);
  lucide.createIcons();
}

// -----------------------------------------------------------------
// External tools
// -----------------------------------------------------------------
async function renderToolsPage(content) {
  const res = await get("/api/tools");
  const canManageOwn = state.user.isRoot || hasPerm("tools.manage");
  content.innerHTML = `
    <div class="page-header"><h2>External Tools</h2>
      ${canManageOwn ? `<button class="btn btn-primary btn-sm" id="add-tool-btn"><i data-lucide="plus" class="icon"></i>Add tool</button>` : ""}
    </div>
    <div class="card" style="padding:0;">
      <table><thead><tr><th>Title</th><th>URL</th><th></th></tr></thead><tbody>
        ${res.tools.map((t) => toolRowHtml(t, canManageOwn)).join("")}
      </tbody></table>
    </div>`;
  content.querySelectorAll("[data-del-tool]").forEach((b) => b.addEventListener("click", () => deleteTool(b.dataset.delTool)));
  if (canManageOwn) document.getElementById("add-tool-btn").addEventListener("click", () => openAddToolModal());
  lucide.createIcons();
}

function toolRowHtml(t, canManageOwn) {
  const isGlobal = t.owner_id === null;
  // A top-level user can always remove a global tool from their own
  // scope (hides it for them + sub-users); root or admin.external_tools_default
  // holders truly delete it site-wide. Personal tools: owner only.
  const canDelete = isGlobal ? state.user.isRoot || hasPerm("admin.external_tools_default") || !state.user.parentId : canManageOwn;
  return `<tr>
    <td><a href="${escapeHtml(t.url)}" target="_blank">${escapeHtml(t.title)}</a></td>
    <td>${escapeHtml(t.url)}</td>
    <td>${canDelete ? `<button class="btn btn-ghost btn-sm" data-del-tool="${t.id}"><i data-lucide="trash-2" class="icon"></i></button>` : ""}</td>
  </tr>`;
}

function openAddToolModal() {
  const canGlobal = state.user.isRoot || hasPerm("admin.external_tools_default");
  openModal(`
    <div class="modal-header"><h3>Add external tool</h3><button class="btn btn-ghost" onclick="window.__closeModal()"><i data-lucide="x" class="icon"></i></button></div>
    <form id="at-form" class="stack">
      <div class="field"><label>Title</label><input name="title" required></div>
      <div class="field"><label>URL</label><input name="url" type="url" required></div>
      ${canGlobal ? `<div class="checkbox-row"><input type="checkbox" id="at-global" name="global"><label for="at-global">Make this available site-wide</label></div>` : ""}
      <button class="btn btn-primary">Add tool</button>
    </form>`);
  document.getElementById("at-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await post("/api/tools", { title: fd.get("title"), url: fd.get("url"), global: fd.get("global") === "on" });
      closeModal();
      toast("Tool added.");
      await navigate("tools");
    } catch (err) {
      toast(err.message, true);
    }
  });
}

async function deleteTool(id) {
  if (!confirm("Delete this tool?")) return;
  try {
    await del(`/api/tools/${id}`);
    await navigate("tools");
  } catch (err) {
    toast(err.message, true);
  }
}

// -----------------------------------------------------------------
// Site settings
// -----------------------------------------------------------------
async function renderSettingsPage(content) {
  const settings = await get("/api/settings");
  const canGeneral = state.user.isRoot || hasPerm("admin.site_settings");
  const canApis = state.user.isRoot || hasPerm("admin.site_apis");

  content.innerHTML = `
    <div class="page-header"><h2>Site Settings</h2></div>
    <div class="stack">
      ${canGeneral ? settingsSectionHtml("General", generalFieldsHtml(settings)) : ""}
      ${canGeneral ? settingsSectionHtml("Sub-user Accounts", subusersFieldsHtml(settings)) : ""}
      ${canGeneral ? settingsSectionHtml("Homepage", homepageFieldsHtml(settings)) : ""}
      ${canGeneral ? settingsSectionHtml("Registration", registrationFieldsHtml(settings)) : ""}
      ${canGeneral ? settingsSectionHtml("Login", authFieldsHtml(settings)) : ""}
      ${canApis ? settingsSectionHtml("Site APIs", apisFieldsHtml(settings)) : ""}
      ${canApis ? `<div id="email-templates-section"></div>` : ""}
      ${canApis ? `<div id="test-email-section"></div>` : ""}
      ${canGeneral ? settingsSectionHtml("Default Error Pages", errorFieldsHtml(settings)) : ""}
    </div>`;

  content.querySelectorAll("form[data-settings-form]").forEach((form) => {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const body = {};
      for (const [key, value] of fd.entries()) {
        if (form.querySelector(`[name="${key}"]`).type === "checkbox") continue;
        body[key] = castSettingValue(key, value);
      }
      form.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
        body[cb.name] = cb.checked;
      });
      try {
        const res = await put("/api/settings", body);
        toast("Settings saved.");
        state.settings = await get("/api/site-info").catch(() => state.settings);
        applyBranding();
        renderSidebar();
        if (res.subuserGlobalActionRequired) {
          openGlobalResolveSubusersModal(res.affectedCount);
        }
        if (res.subuserGlobalUnsuspendAvailable) {
          openGlobalUnsuspendSubusersModal(res.suspendedCount);
        }
      } catch (err) {
        toast(err.message, true);
      }
    });
  });

  if (canApis) {
    const etSection = document.getElementById("email-templates-section");
    if (etSection) await renderEmailTemplatesSection(etSection);
    const teSection = document.getElementById("test-email-section");
    if (teSection) renderTestEmailSection(teSection, settings);
  }
}

function renderTestEmailSection(container, settings) {
  container.innerHTML = `
    <div class="card">
      <h3 style="margin-bottom:6px;">Test Email</h3>
      <p class="hint" style="margin-top:0;margin-bottom:14px;">Send a real templated email to verify a configured channel actually delivers.</p>
      <div id="te-alert"></div>
      <form id="te-form" class="stack">
        <div class="grid-2">
          <div class="field"><label>To</label><input id="te-to" type="email" required placeholder="you@example.com"></div>
          <div class="field">
            <label>Template</label>
            <select id="te-template">
              <option value="welcome">Welcome</option>
              <option value="password_reset">Password Reset</option>
              <option value="forgot_password">Forgot Password</option>
              <option value="account_disabled">Account Disabled</option>
            </select>
          </div>
        </div>
        <div class="field">
          <label>Send via</label>
          <select id="te-via">
            <option value="webhook" ${!settings.email_webhook_url ? "disabled" : ""}>Email Webhook${!settings.email_webhook_url ? " (not configured)" : ""}</option>
            <option value="resend" ${!settings.resend_api_key || !settings.resend_from_email ? "disabled" : ""}>Resend API${!settings.resend_api_key || !settings.resend_from_email ? " (not configured)" : ""}</option>
          </select>
        </div>
        <div><button class="btn btn-primary" type="submit">Send test email</button></div>
      </form>
    </div>`;

  document.getElementById("te-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const alertBox = document.getElementById("te-alert");
    alertBox.innerHTML = "";
    try {
      await post("/api/settings/test-email", {
        to: document.getElementById("te-to").value,
        templateKey: document.getElementById("te-template").value,
        via: document.getElementById("te-via").value,
      });
      alertBox.innerHTML = `<div class="alert alert-ok">Test email sent.</div>`;
    } catch (err) {
      alertBox.innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
    }
  });
}

async function openGlobalResolveSubusersModal(count) {
  let users = [];
  try {
    const res = await get("/api/users");
    users = res.users || [];
  } catch {
    users = [];
  }
  const transferTargets = users.filter((u) => !u.parentId); // top-level users only

  openModal(`
    <div class="modal-header"><h3>${count} sub-user(s) still exist</h3></div>
    <p>Sub-user accounts are now off site-wide. Choose what should happen to every existing sub-user across the whole site, or decide later.</p>
    <div id="grs-alert"></div>
    <form id="grs-form" class="stack">
      <div class="stack" style="gap:10px;">
        <label class="checkbox-row"><input type="radio" name="mode" value="defer" checked> Do nothing for now - existing sub-accounts keep working as usual</label>

        <label class="checkbox-row"><input type="radio" name="mode" value="convert"> Make all sub-users independent top-level users</label>

        <label class="checkbox-row"><input type="radio" name="mode" value="transfer"> Transfer all sub-user short URLs into one account, then remove the sub-user accounts</label>
        <div style="margin:-2px 0 0 26px;">
          <select id="grs-transfer-to" disabled style="width:auto;min-width:200px;">
            ${transferTargets.map((u) => `<option value="${u.id}">${escapeHtml(u.username)}</option>`).join("")}
          </select>
        </div>

        <label class="checkbox-row"><input type="radio" name="mode" value="suspend"> Suspend all sub-user accounts</label>
        <label class="checkbox-row" style="margin:-2px 0 0 26px;"><input type="checkbox" id="grs-disable-urls" disabled> Also disable their short links</label>

        <label class="checkbox-row"><input type="radio" name="mode" value="delete"> Delete all sub-users and their short links entirely</label>
      </div>
      <div class="row" style="margin-top:6px;justify-content:flex-end;">
        <button type="submit" class="btn btn-primary">Confirm</button>
      </div>
    </form>`);

  const form = document.getElementById("grs-form");
  const transferSelect = document.getElementById("grs-transfer-to");
  const disableUrlsCb = document.getElementById("grs-disable-urls");
  form.querySelectorAll('input[name="mode"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      transferSelect.disabled = radio.value !== "transfer";
      disableUrlsCb.disabled = radio.value !== "suspend";
    });
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const mode = document.querySelector('#grs-form input[name="mode"]:checked').value;
    if (mode === "transfer" && !transferTargets.length) {
      document.getElementById("grs-alert").innerHTML = `<div class="alert alert-error">No other account exists to transfer to.</div>`;
      return;
    }
    try {
      await post("/api/users/resolve-subusers-global", {
        mode,
        alsoDisableUrls: disableUrlsCb.checked,
        transferToId: mode === "transfer" ? transferSelect.value : undefined,
      });
      closeModal();
      toast(mode === "defer" ? "No changes made. You can resolve sub-users any time from the Users page." : "Sub-users updated site-wide.");
      if (state.tab === "users") await navigate("users");
    } catch (err) {
      document.getElementById("grs-alert").innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
    }
  });
}

function openGlobalUnsuspendSubusersModal(count) {
  openModal(`
    <div class="modal-header"><h3>Re-enable sub-user accounts</h3></div>
    <p>Sub-user accounts are on again site-wide. ${count} sub-user account(s) are currently suspended - would you like to unsuspend them?</p>
    <div id="gus-alert"></div>
    <form id="gus-form" class="stack">
      <div class="checkbox-row"><input type="checkbox" id="gus-enable-urls"><label for="gus-enable-urls">Also re-enable their short links</label></div>
      <div class="row">
        <button type="submit" class="btn btn-primary">Unsuspend all</button>
        <button type="button" class="btn btn-secondary" id="gus-skip">Not now</button>
      </div>
    </form>`);

  document.getElementById("gus-skip").addEventListener("click", () => closeModal());
  document.getElementById("gus-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await post("/api/users/unsuspend-subusers-global", {
        alsoEnableUrls: document.getElementById("gus-enable-urls").checked,
      });
      closeModal();
      toast("Sub-users unsuspended.");
      if (state.tab === "users") await navigate("users");
    } catch (err) {
      document.getElementById("gus-alert").innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
    }
  });
}

function subusersFieldsHtml(s) {
  return `<div class="checkbox-row"><input type="checkbox" name="subusers_feature_enabled" ${s.subusers_feature_enabled !== false ? "checked" : ""}><label>Allow sub-user accounts site-wide</label></div>
    <div class="hint">Turning this off hides the sub-user module for everyone. If sub-users already exist, you'll be asked to transfer, convert, suspend or delete them.</div>`;
}

const EMAIL_TEMPLATE_LABELS = {
  welcome: "Welcome (new account created)",
  password_reset: "Password reset (by admin)",
  forgot_password: "Forgot password (self-service)",
  account_disabled: "Account disabled",
};

async function renderEmailTemplatesSection(container) {
  const res = await get("/api/email-templates");
  container.innerHTML = `<div class="card">
    <h3 style="margin-bottom:6px;">Email Templates</h3>
    <p class="hint" style="margin-bottom:16px;">Placeholders: <code>{{username}}</code>, <code>{{tempPassword}}</code>, <code>{{loginUrl}}</code>, <code>{{siteTitle}}</code>. Turn a template off to stop that email from being sent.</p>
    <form id="et-form" class="stack">
      ${res.templates.map(emailTemplateFieldsHtml).join("")}
      <button class="btn btn-primary" style="align-self:flex-start;">Save templates</button>
    </form>
  </div>`;

  document.getElementById("et-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const templates = res.templates.map((t) => ({
      key: t.key,
      subject: form.querySelector(`[name="subject-${t.key}"]`).value,
      body: form.querySelector(`[name="body-${t.key}"]`).value,
      enabled: form.querySelector(`[name="enabled-${t.key}"]`).checked,
    }));
    try {
      await put("/api/email-templates", { templates });
      toast("Email templates saved.");
    } catch (err) {
      toast(err.message, true);
    }
  });
}

function emailTemplateFieldsHtml(t) {
  return `
    <div style="border:1px solid var(--line);border-radius:10px;padding:16px;">
      <div class="row-between" style="margin-bottom:10px;">
        <strong>${escapeHtml(EMAIL_TEMPLATE_LABELS[t.key] || t.key)}</strong>
        <label class="checkbox-row"><input type="checkbox" name="enabled-${t.key}" ${t.enabled ? "checked" : ""}> Send this email</label>
      </div>
      <div class="field"><label>Subject</label><input name="subject-${t.key}" value="${escapeHtml(t.subject)}"></div>
      <div class="field"><label>Body</label><textarea name="body-${t.key}" rows="6">${escapeHtml(t.body)}</textarea></div>
    </div>`;
}

function castSettingValue(key, value) {
  if (key === "slug_min_chars") return Number(value) || 4;
  if (key === "registration_domain_list") return value.split(",").map((s) => s.trim()).filter(Boolean);
  return value;
}

function settingsSectionHtml(title, fieldsHtml) {
  return `<div class="card">
    <h3 style="margin-bottom:14px;">${title}</h3>
    <form data-settings-form class="stack">${fieldsHtml}<button class="btn btn-primary" style="align-self:flex-start;">Save</button></form>
  </div>`;
}

function generalFieldsHtml(s) {
  return `
    <div class="grid-2">
      <div class="field"><label>Site title</label><input name="site_title" value="${escapeHtml(s.site_title || "")}"></div>
      <div class="field"><label>Theme color</label><input name="theme_color" type="text" value="${escapeHtml(s.theme_color || "#417B5A")}"></div>
      <div class="field"><label>Logo URL</label><input name="logo_url" value="${escapeHtml(s.logo_url || "")}"></div>
      <div class="field"><label>Favicon URL</label><input name="favicon_url" value="${escapeHtml(s.favicon_url || "")}"></div>
      <div class="field"><label>Default social preview image URL</label><input name="social_image_url" value="${escapeHtml(s.social_image_url || "")}"></div>
      <div class="field"><label>Slug minimum characters</label><input name="slug_min_chars" type="number" min="1" value="${s.slug_min_chars || 4}"></div>
    </div>`;
}

function homepageFieldsHtml(s) {
  return `
    <div class="field"><label>Homepage notice</label><input name="homepage_notice" value="${escapeHtml(s.homepage_notice || "")}"></div>
    <div class="grid-2">
      <div class="field"><label>Homepage button label</label><input name="homepage_button_label" value="${escapeHtml(s.homepage_button_label || "")}"></div>
      <div class="field"><label>Homepage button URL</label><input name="homepage_button_url" value="${escapeHtml(s.homepage_button_url || "")}"></div>
    </div>
    <div class="checkbox-row"><input type="checkbox" name="homepage_button_new_tab" ${s.homepage_button_new_tab ? "checked" : ""}><label>Open homepage button in a new tab</label></div>
    <div class="checkbox-row"><input type="checkbox" name="homepage_show_login" ${s.homepage_show_login ? "checked" : ""}><label>Show login option on homepage</label></div>`;
}

function registrationFieldsHtml(s) {
  return `
    <div class="checkbox-row"><input type="checkbox" name="registration_enabled" ${s.registration_enabled ? "checked" : ""}><label>Allow new registration</label></div>
    <div class="checkbox-row"><input type="checkbox" name="registration_show_on_homepage" ${s.registration_show_on_homepage ? "checked" : ""}><label>Show registration option on homepage / login</label></div>
    <div class="checkbox-row"><input type="checkbox" name="registration_auto_approve" ${s.registration_auto_approve ? "checked" : ""}><label>Auto-approve new registrations</label></div>
    <div class="field"><label>Domain restriction mode</label>
      <select name="registration_domain_mode">
        <option value="none" ${s.registration_domain_mode === "none" ? "selected" : ""}>No restriction</option>
        <option value="allow_only" ${s.registration_domain_mode === "allow_only" ? "selected" : ""}>Allow only listed domains</option>
        <option value="block" ${s.registration_domain_mode === "block" ? "selected" : ""}>Block listed domains</option>
      </select>
    </div>
    <div class="field"><label>Domain list (comma-separated)</label><input name="registration_domain_list" value="${escapeHtml((s.registration_domain_list || []).join(", "))}"></div>`;
}

function authFieldsHtml(s) {
  return `
    <div class="checkbox-row"><input type="checkbox" name="forgot_password_enabled" ${s.forgot_password_enabled ? "checked" : ""}><label>Show "Forgot password" option in login UI</label></div>
    <div class="checkbox-row" style="margin-top:10px;"><input type="checkbox" name="login_lockout_enabled" ${s.login_lockout_enabled !== false ? "checked" : ""}><label>Lock accounts after repeated failed login attempts</label></div>
    <div class="hint">5 failed attempts locks the account for 15 minutes, 10 for 30 minutes, 30 for 6 hours. At 50, the account is disabled and needs a parent or admin to re-enable it. A successful login, or a password reset by a parent/admin, clears the count.</div>`;
}

function apisFieldsHtml(s) {
  return `
    <div class="field">
      <label>ImgBB API key <a href="https://api.imgbb.com" target="_blank" rel="noopener" class="hint" style="text-decoration:underline;">Get API</a></label>
      <input name="imgbb_api_key" value="${escapeHtml(s.imgbb_api_key || "")}">
    </div>
    <div class="field">
      <label>Email webhook URL <a href="https://connect.pabbly.com/integrations/webhook-by-pabbly/gmail" target="_blank" rel="noopener" class="hint" style="text-decoration:underline;">Pabbly Connect</a></label>
      <input name="email_webhook_url" value="${escapeHtml(s.email_webhook_url || "")}">
      <div class="hint">Receives a POST with JSON body: To, CC, BCC, Subject, Body, Sender Name.</div>
    </div>
    <div class="grid-2">
      <div class="field">
        <label>Resend API key <a href="https://resend.com/api-keys" target="_blank" rel="noopener" class="hint" style="text-decoration:underline;">Get API</a></label>
        <input name="resend_api_key" value="${escapeHtml(s.resend_api_key || "")}">
      </div>
      <div class="field"><label>Resend from-email</label><input name="resend_from_email" value="${escapeHtml(s.resend_from_email || "")}"></div>
    </div>`;
}

function errorFieldsHtml(s) {
  return `
    <div class="grid-2">
      <div class="field"><label>Not-found text</label><input name="default_error_text" value="${escapeHtml(s.default_error_text || "")}"></div>
      <div class="field"><label>Disabled-link text</label><input name="default_disabled_text" value="${escapeHtml(s.default_disabled_text || "")}"></div>
      <div class="field"><label>Not-found button label</label><input name="default_error_button_label" value="${escapeHtml(s.default_error_button_label || "")}"></div>
      <div class="field"><label>Not-found button URL</label><input name="default_error_button_url" value="${escapeHtml(s.default_error_button_url || "")}"></div>
      <div class="field"><label>Disabled button label</label><input name="default_disabled_button_label" value="${escapeHtml(s.default_disabled_button_label || "")}"></div>
      <div class="field"><label>Disabled button URL</label><input name="default_disabled_button_url" value="${escapeHtml(s.default_disabled_button_url || "")}"></div>
    </div>`;
}

// -----------------------------------------------------------------
// Error Pages (per-user 404 / disabled-link customization)
// -----------------------------------------------------------------
async function renderErrorPagesPage(content) {
  const s = await get("/api/error-settings");
  const inherited = s.inherited || {};
  const canPropagate = state.user.isRoot || !state.user.parentId;
  content.innerHTML = `
    <div class="page-header"><h2>Error Pages</h2></div>
    <div class="card">
      <p class="hint" style="margin-top:-4px;">This only applies to the "link disabled" page for your own short links. A "link not found" page has no owner, so it always uses the site's default message.</p>
      <div class="checkbox-row" style="margin:14px 0;">
        <input type="checkbox" id="ep-enabled" ${s.errorEnabled === false ? "" : "checked"}>
        <label for="ep-enabled">Use a custom message for disabled links (instead of ${inherited.source === "parent" ? "your parent's" : "the site's"} default: "${escapeHtml(inherited.disabledText || "")}")</label>
      </div>
      <div id="ep-fields" class="stack" style="display:${s.errorEnabled === false ? "none" : "flex"};">
        <div class="grid-2">
          <div class="field"><label>Message</label><input id="ep-disabled-text" placeholder="${escapeHtml(inherited.disabledText || "")}" value="${escapeHtml(s.disabledText || "")}"></div>
          <div class="field"><label>Button label</label><input id="ep-disabled-btn-label" value="${escapeHtml(s.disabledButtonLabel || "")}"></div>
          <div class="field"><label>Button URL</label><input id="ep-disabled-btn-url" value="${escapeHtml(s.disabledButtonUrl || "")}"></div>
        </div>
      </div>
      ${
        canPropagate
          ? `<div class="checkbox-row" style="margin-top:14px;">
              <input type="checkbox" id="ep-propagate">
              <label for="ep-propagate">${state.user.isRoot ? "Also apply this to every user and sub-user site-wide" : "Also apply this to all of my sub-users"}</label>
            </div>`
          : ""
      }
      <div id="ep-alert" style="margin-top:12px;"></div>
      <button class="btn btn-primary" id="ep-save" style="margin-top:6px;">Save</button>
    </div>`;

  document.getElementById("ep-enabled").addEventListener("change", (e) => {
    document.getElementById("ep-fields").style.display = e.target.checked ? "flex" : "none";
  });

  document.getElementById("ep-save").addEventListener("click", async () => {
    try {
      const propagateEl = document.getElementById("ep-propagate");
      const res = await put("/api/error-settings", {
        errorEnabled: document.getElementById("ep-enabled").checked,
        disabledText: document.getElementById("ep-disabled-text").value,
        disabledButtonLabel: document.getElementById("ep-disabled-btn-label").value,
        disabledButtonUrl: document.getElementById("ep-disabled-btn-url").value,
        propagate: propagateEl ? propagateEl.checked : false,
      });
      toast(res.propagatedCount ? `Saved and applied to ${res.propagatedCount} account(s).` : "Error page settings saved.");
    } catch (err) {
      document.getElementById("ep-alert").innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
    }
  });
}

// -----------------------------------------------------------------
// Site Analytics (admin)
// -----------------------------------------------------------------
async function renderSiteAnalyticsPage(content) {
  content.innerHTML = `<div class="page-header"><h2>Site Analytics</h2></div><p>Loading...</p>`;
  let data;
  try {
    data = await get("/api/site-analytics");
  } catch (err) {
    content.innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
    return;
  }

  const statCard = (label, value) => `<div class="card" style="text-align:center;">
    <div style="font-size:26px;font-weight:600;color:var(--ink);">${value}</div>
    <div class="hint">${label}</div>
  </div>`;

  const maxReferrerCount = Math.max(1, ...data.topReferrers.map((r) => r.count));

  content.innerHTML = `
    <div class="page-header"><h2>Site Analytics</h2></div>
    <div class="grid-2" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:20px;">
      ${statCard("Total APIs", data.totalApiKeys)}
      ${statCard("Users", data.totalUsers)}
      ${statCard("Sub-users", data.totalSubusers)}
      ${statCard("Admins", data.totalAdmins)}
      ${statCard("Total Short URLs", data.totalUrls)}
      ${statCard("Full Page Iframe Links", data.totalFullIframe)}
      ${statCard("Custom Preview Links", data.totalCustomPreview)}
      ${statCard("Total Visits", data.totalVisits)}
    </div>
    <div class="card">
      <h3 style="margin-bottom:14px;">Visits by referrer</h3>
      ${
        data.topReferrers.length
          ? `<div class="stack" style="gap:10px;">
              ${data.topReferrers
                .map(
                  (r) => `<div>
                    <div class="row-between" style="font-size:13px;margin-bottom:4px;">
                      <span>${escapeHtml(r.referrer_bucket)}</span><span class="hint">${r.count}</span>
                    </div>
                    <div style="background:#eef1ed;border-radius:6px;height:10px;overflow:hidden;">
                      <div style="background:var(--accent);height:100%;width:${Math.round((r.count / maxReferrerCount) * 100)}%;"></div>
                    </div>
                  </div>`
                )
                .join("")}
            </div>`
          : `<p class="hint">No referrer data yet.</p>`
      }
    </div>`;
}

// -----------------------------------------------------------------
// Reserved keywords
// -----------------------------------------------------------------
async function renderReservedPage(content) {
  const res = await get("/api/reserved-keywords");
  content.innerHTML = `
    <div class="page-header"><h2>Reserved Keywords</h2>
      <div class="row">
        <button class="btn btn-secondary btn-sm" id="rk-import-btn"><i data-lucide="upload" class="icon"></i>Import</button>
        <a class="btn btn-secondary btn-sm" href="/api/reserved-keywords/export"><i data-lucide="download" class="icon"></i>Export</a>
      </div>
    </div>
    <div class="card" style="margin-bottom:20px;">
      <form id="rk-add-form" class="row">
        <input id="rk-add-input" placeholder="new-keyword" style="flex:1;">
        <button class="btn btn-primary">Add</button>
      </form>
    </div>
    <div class="card" style="padding:0;overflow-x:auto;">
      <table><thead><tr><th>Keyword</th><th></th></tr></thead><tbody>
        ${res.keywords.map((k) => `<tr><td>${escapeHtml(k.keyword)}</td><td><button class="btn btn-ghost btn-sm" data-del-kw="${k.id}"><i data-lucide="trash-2" class="icon"></i></button></td></tr>`).join("")}
      </tbody></table>
    </div>`;
  document.getElementById("rk-add-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = document.getElementById("rk-add-input");
    try {
      await post("/api/reserved-keywords", { keyword: input.value.trim() });
      input.value = "";
      await navigate("reserved");
    } catch (err) {
      toast(err.message, true);
    }
  });
  content.querySelectorAll("[data-del-kw]").forEach((b) =>
    b.addEventListener("click", async () => {
      await del(`/api/reserved-keywords/${b.dataset.delKw}`);
      await navigate("reserved");
    })
  );
  document.getElementById("rk-import-btn").addEventListener("click", () => {
    openModal(`
      <div class="modal-header"><h3>Import reserved keywords</h3><button class="btn btn-ghost" onclick="window.__closeModal()"><i data-lucide="x" class="icon"></i></button></div>
      <p>One keyword per line.</p>
      <textarea id="rk-import-text" rows="8"></textarea>
      <div class="row" style="margin-top:14px;justify-content:flex-end;"><button class="btn btn-primary" id="rk-import-submit">Import</button></div>`);
    document.getElementById("rk-import-submit").addEventListener("click", async () => {
      try {
        await post("/api/reserved-keywords/import", { text: document.getElementById("rk-import-text").value });
        closeModal();
        toast("Keywords imported.");
        await navigate("reserved");
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
  lucide.createIcons();
}

boot();