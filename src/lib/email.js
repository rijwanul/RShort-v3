import { getSettings } from "./utils.js";

// Sends via the generic email webhook if one is configured, otherwise
// falls back to Resend.com if those settings are configured. Returns
// true/false so callers can decide whether to surface a warning.
export async function sendEmail(env, { to, subject, body }) {
  const settings = await getSettings(env, [
    "email_webhook_url",
    "resend_api_key",
    "resend_from_email",
  ]);

  if (settings.email_webhook_url) {
    try {
      const res = await fetch(settings.email_webhook_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ To: to, Subject: subject, Body: body }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  if (settings.resend_api_key && settings.resend_from_email) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${settings.resend_api_key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: settings.resend_from_email,
          to: [to],
          subject,
          html: body.replace(/\n/g, "<br>"),
        }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  return false;
}

export async function emailIsConfigured(env) {
  const settings = await getSettings(env, ["email_webhook_url", "resend_api_key", "resend_from_email"]);
  return !!(settings.email_webhook_url || (settings.resend_api_key && settings.resend_from_email));
}

// ---------------------------------------------------------------------
// Admin-editable email templates: welcome, password_reset,
// forgot_password, account_disabled. Each has an independent on/off
// toggle - render + send is skipped silently when disabled.
// ---------------------------------------------------------------------
function renderTemplate(text, vars) {
  return String(text || "").replace(/\{\{(\w+)\}\}/g, (m, key) => (vars[key] !== undefined ? vars[key] : m));
}

export async function sendTemplatedEmail(env, key, to, vars = {}) {
  if (!to) return false;
  const template = await env.DB.prepare("SELECT * FROM email_templates WHERE key = ?").bind(key).first();
  if (!template || !template.enabled) return false;

  const siteSettings = await getSettings(env, ["site_title"]);
  const fullVars = { siteTitle: siteSettings.site_title || "RShort v3", ...vars };

  return sendEmail(env, {
    to,
    subject: renderTemplate(template.subject, fullVars),
    body: renderTemplate(template.body, fullVars),
  });
}
