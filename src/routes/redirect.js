import { getSettings, bucketReferrer, todayUTC } from "../lib/utils.js";
import { verifyPassword } from "../lib/crypto.js";

const PAGE_CSS = `
  body{font-family:Poppins,Arial,sans-serif;background:#f6f7f5;margin:0;
    display:flex;align-items:center;justify-content:center;min-height:100vh;color:#20261f;}
  .card{background:#fff;border-radius:14px;box-shadow:0 6px 24px rgba(0,0,0,.08);
    padding:36px 32px;max-width:420px;width:calc(100% - 48px);text-align:center;}
  h1{font-size:20px;margin:0 0 8px;}
  p{color:#5c6660;font-size:14px;line-height:1.5;margin:0 0 20px;}
  input[type=password]{width:100%;box-sizing:border-box;padding:11px 14px;border:1px solid #d8ded8;
    border-radius:8px;font-size:14px;margin-bottom:12px;font-family:inherit;}
  button,a.btn{display:inline-block;background:var(--accent,#417B5A);color:#fff;border:none;
    padding:11px 22px;border-radius:8px;font-size:14px;cursor:pointer;text-decoration:none;font-family:inherit;}
  .err{color:#b3392c;font-size:13px;margin:-8px 0 12px;}
`;

function htmlPage({ title, body, themeColor }) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600&display=swap" rel="stylesheet">
  <title>${title}</title><style>:root{--accent:${themeColor || "#417B5A"}}${PAGE_CSS}</style></head>
  <body><div class="card">${body}</div></body></html>`;
}

async function renderErrorPage(env, { kind, ownerErrorSettings, parentErrorSettings, siteSettings }) {
  const owner = ownerErrorSettings || {};
  const parent = parentErrorSettings || {};

  // "Link not found" has no owner by definition, so it can never be
  // customized per-user - it always uses the site default message.
  if (kind === "notfound") {
    const text = siteSettings.default_error_text;
    const buttonLabel = siteSettings.default_error_button_label;
    const buttonUrl = siteSettings.default_error_button_url;
    const button = buttonLabel && buttonUrl ? `<a class="btn" href="${buttonUrl}">${buttonLabel}</a>` : "";
    return new Response(
      htmlPage({ title: siteSettings.site_title || "RShort v3", themeColor: siteSettings.theme_color, body: `<h1>${text}</h1>${button}` }),
      { status: 404, headers: { "Content-Type": "text/html" } }
    );
  }

  // "Link disabled": owner's own custom message if they've turned
  // customization on and set one; otherwise fall back to their
  // parent's custom message (if any); otherwise the site default.
  // Customization being off never hides the disabled page itself -
  // it only decides whose message text is shown.
  let text, buttonLabel, buttonUrl;
  if (owner.errorEnabled !== false && owner.disabledText) {
    text = owner.disabledText;
    buttonLabel = owner.disabledButtonLabel;
    buttonUrl = owner.disabledButtonUrl;
  } else if (parent.errorEnabled !== false && parent.disabledText) {
    text = parent.disabledText;
    buttonLabel = parent.disabledButtonLabel;
    buttonUrl = parent.disabledButtonUrl;
  } else {
    text = siteSettings.default_disabled_text;
    buttonLabel = siteSettings.default_disabled_button_label;
    buttonUrl = siteSettings.default_disabled_button_url;
  }

  const button = buttonLabel && buttonUrl ? `<a class="btn" href="${buttonUrl}">${buttonLabel}</a>` : "";

  return new Response(
    htmlPage({
      title: siteSettings.site_title || "RShort v3",
      themeColor: siteSettings.theme_color,
      body: `<h1>${text}</h1>${button}`,
    }),
    { status: 410, headers: { "Content-Type": "text/html" } }
  );
}

function renderPasswordPrompt({ slug, error, themeColor, siteTitle }) {
  return new Response(
    htmlPage({
      title: siteTitle || "RShort v3",
      themeColor,
      body: `
        <h1>Password required</h1>
        <p>This link is protected. Enter the password to continue.</p>
        <form method="GET" action="/${encodeURIComponent(slug)}">
          ${error ? `<div class="err">Incorrect password.</div>` : ""}
          <input type="password" name="pw" autofocus required>
          <div><button type="submit">Continue</button></div>
        </form>`,
    }),
    { status: 401, headers: { "Content-Type": "text/html" } }
  );
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

function renderTargetPage({ urlRow, siteSettings, useIframe, useMetaRefresh }) {
  const title = urlRow.social_enabled ? urlRow.social_title || siteSettings.site_title : siteSettings.site_title;
  const description = urlRow.social_enabled ? urlRow.social_description || "" : "";
  const image = urlRow.social_enabled ? urlRow.social_image_url || siteSettings.social_image_url : "";

  const metaTags = urlRow.social_enabled
    ? `
      <meta property="og:title" content="${escapeHtml(title)}">
      <meta property="og:description" content="${escapeHtml(description)}">
      ${image ? `<meta property="og:image" content="${escapeHtml(image)}">` : ""}
      <meta property="og:url" content="${escapeHtml(urlRow.target)}">
      <meta name="twitter:card" content="summary_large_image">
      <meta name="twitter:title" content="${escapeHtml(title)}">
      <meta name="twitter:description" content="${escapeHtml(description)}">
      ${image ? `<meta name="twitter:image" content="${escapeHtml(image)}">` : ""}`
    : "";

  const refresh = useMetaRefresh
    ? `<meta http-equiv="refresh" content="0;url=${escapeHtml(urlRow.target)}">
       <script>window.location.replace(${JSON.stringify(urlRow.target)});</script>`
    : "";

  const bodyContent = useIframe
    ? `<style>html,body{margin:0;height:100%;} iframe{border:0;width:100%;height:100%;display:block;}</style>
       <iframe src="${escapeHtml(urlRow.target)}" allow="fullscreen"></iframe>`
    : `<style>${PAGE_CSS}</style><div class="card"><h1>${escapeHtml(title)}</h1>
       <p>Redirecting you now. <a href="${escapeHtml(urlRow.target)}">Click here</a> if you are not redirected automatically.</p></div>`;

  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
     <title>${escapeHtml(title)}</title>${metaTags}${refresh}</head><body>${bodyContent}</body></html>`,
    { headers: { "Content-Type": "text/html" } }
  );
}

async function logHit(env, urlId, referrerHeader) {
  try {
    const id = env.HIT_COUNTER.idFromName(String(urlId));
    const stub = env.HIT_COUNTER.get(id);
    await stub.fetch("https://hit-counter/hit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        urlId,
        hitDate: todayUTC(),
        referrerBucket: bucketReferrer(referrerHeader),
      }),
    });
  } catch {
    // Never let analytics failures break the redirect itself.
  }
}

export async function handleSlugRedirect(request, env, slug) {
  const url = new URL(request.url);
  const siteSettings = await getSettings(env, [
    "site_title",
    "theme_color",
    "social_image_url",
    "default_error_text",
    "default_error_button_label",
    "default_error_button_url",
    "default_disabled_text",
    "default_disabled_button_label",
    "default_disabled_button_url",
  ]);

  const urlRow = await env.DB.prepare(
    "SELECT * FROM urls WHERE slug = ? COLLATE NOCASE AND deleted_at IS NULL"
  )
    .bind(slug)
    .first();

  if (!urlRow) {
    return renderErrorPage(env, { kind: "notfound", ownerErrorSettings: null, siteSettings });
  }

  const owner = await env.DB.prepare("SELECT error_settings, parent_id FROM users WHERE id = ?")
    .bind(urlRow.created_by)
    .first();
  let ownerErrorSettings = {};
  try {
    ownerErrorSettings = owner ? JSON.parse(owner.error_settings || "{}") : {};
  } catch {
    ownerErrorSettings = {};
  }

  let parentErrorSettings = {};
  if (owner && owner.parent_id) {
    const parentRow = await env.DB.prepare("SELECT error_settings FROM users WHERE id = ?")
      .bind(owner.parent_id)
      .first();
    try {
      parentErrorSettings = parentRow ? JSON.parse(parentRow.error_settings || "{}") : {};
    } catch {
      parentErrorSettings = {};
    }
  }

  if (!urlRow.enabled) {
    return renderErrorPage(env, { kind: "disabled", ownerErrorSettings, parentErrorSettings, siteSettings });
  }

  if (urlRow.password) {
    const provided = url.searchParams.get("pw");
    if (!provided) {
      return renderPasswordPrompt({ slug, themeColor: siteSettings.theme_color, siteTitle: siteSettings.site_title });
    }
    if (provided !== urlRow.password) {
      return renderPasswordPrompt({ slug, error: true, themeColor: siteSettings.theme_color, siteTitle: siteSettings.site_title });
    }
  }

  await logHit(env, urlRow.id, request.headers.get("Referer"));

  const useIframe = !!urlRow.full_iframe;
  if (!urlRow.social_enabled && !useIframe) {
    return Response.redirect(urlRow.target, 302);
  }

  return renderTargetPage({
    urlRow,
    siteSettings,
    useIframe,
    useMetaRefresh: !useIframe,
  });
}
