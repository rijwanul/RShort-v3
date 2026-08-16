import { getSettings } from "./utils.js";

// Sends via the generic email webhook if one is configured, otherwise
// falls back to Resend.com if those settings are configured. Returns
// true/false so callers can decide whether to surface a warning.
export async function sendEmail(env, { to, subject, body, cc = "", bcc = "" }) {
  const settings = await getSettings(env, [
    "email_webhook_url",
    "resend_api_key",
    "resend_from_email",
    "site_title",
  ]);
  const senderName = settings.site_title || "RShort v3";

  if (settings.email_webhook_url) {
    try {
      const res = await fetch(settings.email_webhook_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          To: to,
          CC: cc || "",
          BCC: bcc || "",
          Subject: subject,
          Body: body,
          "Sender Name": senderName,
        }),
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
          from: `${senderName} <${settings.resend_from_email}>`,
          to: [to],
          ...(cc ? { cc: [cc] } : {}),
          ...(bcc ? { bcc: [bcc] } : {}),
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

// Sends a real templated email but forces which channel to use
// (ignoring the normal webhook-first fallback order), for the admin's
// "send test email" feature so they can verify each configured API
// independently.
export async function sendTestEmail(env, { to, templateKey, via }) {
  const template = await env.DB.prepare("SELECT * FROM email_templates WHERE key = ?").bind(templateKey).first();
  if (!template) return { ok: false, error: "Template not found." };

  const siteSettings = await getSettings(env, ["site_title", "email_webhook_url", "resend_api_key", "resend_from_email"]);
  const fullVars = { siteTitle: siteSettings.site_title || "RShort v3", username: "Test User" };
  const subject = renderTemplate(template.subject, fullVars);
  const body = renderTemplate(template.body, fullVars);
  const senderName = siteSettings.site_title || "RShort v3";

  if (via === "webhook") {
    if (!siteSettings.email_webhook_url) return { ok: false, error: "Email webhook URL is not configured." };
    try {
      const res = await fetch(siteSettings.email_webhook_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ To: to, CC: "", BCC: "", Subject: subject, Body: body, "Sender Name": senderName }),
      });
      return res.ok ? { ok: true } : { ok: false, error: `Webhook responded with status ${res.status}.` };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  if (via === "resend") {
    if (!siteSettings.resend_api_key || !siteSettings.resend_from_email) {
      return { ok: false, error: "Resend API key and from-email must both be configured." };
    }
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${siteSettings.resend_api_key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: `${senderName} <${siteSettings.resend_from_email}>`,
          to: [to],
          subject,
          html: body.replace(/\n/g, "<br>"),
        }),
      });
      if (res.ok) return { ok: true };
      const data = await res.json().catch(() => null);
      return { ok: false, error: (data && data.message) || `Resend responded with status ${res.status}.` };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  return { ok: false, error: "Choose which API to send the test through." };
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
