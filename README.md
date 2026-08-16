<div align="center">

# 🔗 RShort v3

**A self-hostable, fully-branded URL shortener that runs entirely on Cloudflare's free tier.**

No servers to manage. No monthly bill. Deploy your own instance in minutes.

![Visitors](https://visitor-badge.laobi.icu/badge?page_id=rijwanul.RShort-v3)
[![Deploy](https://img.shields.io/badge/deploy-Cloudflare%20Workers-F38020?logo=cloudflare&logoColor=white)](#-getting-started)
[![Database](https://img.shields.io/badge/database-D1%20(SQLite)-blue)](#-tech-stack)
[![No build step](https://img.shields.io/badge/build%20step-none-brightgreen)](#-tech-stack)
[![License](https://img.shields.io/badge/license-MIT-lightgrey)](#-license)

</div>

---

## ✨ Why RShort v3?

Most self-hosted shorteners give you one user, one link table, and not much else. RShort v3 was built for people who need to actually **run** a shortener for a team — with real roles, real permissions, real security, and a dashboard that doesn't feel like an afterthought.

- 🏢 **Multi-tenant by design** — a root admin, top-level users, and their sub-users, each scoped to see only what they should
- 🔐 **Security that doesn't get in your way** — tiered brute-force lockout, permission-gated everything, API keys that inherit the owner's exact permissions
- 🎨 **Fully white-labelable** — your logo, your colors, your domain, your error pages
- ⚡ **Actually fast hit counting** — Durable Objects instead of racy KV counters
- 💸 **Runs on Cloudflare's free tier** — Workers, D1, and Durable Objects, no bundler required

---

## 🚀 Features

### Links
- Custom or randomly generated slugs, reserved-keyword protection, CSV **and** bulk-paste import (`slug: target (password)`)
- Password-protected links, full-page-iframe links (for platforms like Telegram that need the real page rendered), and custom social preview cards
- **Bulk actions** — select multiple links and enable, disable, password-protect, toggle iframe, delete, or transfer ownership all at once
- Per-link, date-wise, and referrer-bucketed analytics, backed by a Durable Object per link so hit counts never race

### People & permissions
- Root admin → top-level users → sub-users (two levels deep), each with **granular, checkbox-level permissions**
- Sub-user module can be switched off site-wide, with a guided popup to convert, transfer, suspend, or delete existing sub-accounts — or defer the decision entirely
- Self-registration (optional), with domain allow/block lists and auto-approve or manual approval

### Security
- 🔒 **Tiered login lockout** — 5 failed attempts locks an account for 15 minutes, 10 for 30 minutes, 30 for 6 hours, and 50 disables the account until a parent or admin steps in. Fully toggleable from Site Settings.
- Every action is attributed and searchable in the **Activity Log**, filterable by who and by category (Account / Settings / Links), with API-triggered actions clearly marked apart from dashboard actions
- Per-user API keys that inherit that user's own permissions exactly — revoke a permission and matching keys are disabled automatically

### Admin tools
- **Site Analytics** dashboard — totals for users, links, iframe/preview usage, visits, and a referrer breakdown chart
- Editable, independently-toggleable email templates (welcome, password reset, forgot password, account disabled), with a built-in **Test Email** sender to verify delivery before you rely on it
- Fully theme-able: site title, logo, favicon, social image, accent color, homepage notice/button — all editable from the dashboard, no redeploy needed

---

## 🧱 Tech stack

| Layer | Choice | Why |
|---|---|---|
| Compute | **Cloudflare Workers** | API + redirect logic, runs at the edge |
| Database | **D1** (SQLite) | Free, simple, good enough for this scale |
| Hit counting | **Durable Objects** | One instance per link means counts never race |
| Frontend | Plain **HTML/CSS/JS** | No bundler, no npm build step, no framework tax |
| Fonts & icons | **Poppins** + **Lucide** | Clean, free, loaded via CDN |

---

## 🏁 Getting started

Full copy-paste deployment steps live in [`cloudflare-ignore/instructions.html`](cloudflare-ignore/instructions.html) — open it in a browser (it's excluded from deployment). The short version:

```bash
npm install -g wrangler
wrangler login

wrangler d1 create rshort3_db          # paste the database_id into wrangler.toml
wrangler d1 execute rshort3_db --remote --file=./schema.sql

wrangler secret put JWT_SECRET
wrangler secret put ROOT_USERNAME
wrangler secret put ROOT_PASSWORD

wrangler deploy
```

Then visit `/login` and sign in with your root credentials — you'll be asked to set a new password immediately.

> **Updating an existing deployment?** Re-run the `d1 execute` command above whenever `schema.sql` changes. Check the file for any commented-out migration notes before re-running it a second time.

---

## 📁 Project structure

```
├── img/                     source branding images (copied into public/img at build)
├── cloudflare-ignore/
│   └── instructions.html    deployment walkthrough + interactive API tester (not deployed)
├── public/                  static frontend, served directly by Workers Assets
│   ├── index.html           homepage
│   ├── login/index.html
│   ├── register/index.html
│   ├── dashboard/index.html
│   ├── css/style.css
│   └── js/                  api.js (fetch helper) + app.js (dashboard SPA)
├── src/
│   ├── index.js              Worker entry point / router
│   ├── durable-objects/hit-counter.js
│   ├── lib/                  auth, crypto, email, imgbb, permissions, utils
│   └── routes/                auth, urls, users, admin, redirect
├── schema.sql
└── wrangler.toml
```

---

## 🏗️ Architecture notes

**Auth** — stateless signed JWT (HS256) in an HttpOnly cookie, short-lived and silently refreshed. Since a pure JWT can't be revoked before it expires, every authenticated request also re-checks the user's `enabled` flag and a `token_version` counter in D1 — disabling a user, resetting their password, or forcing a password change invalidates their session immediately, with no server-side session store needed.

**Hit counting** — each short link gets its own Durable Object instance. Because a Durable Object processes requests for a given ID one at a time, increments never race, which is what plain KV- or D1-only counters tend to get wrong. Raw hit events are buffered and flushed to D1 in batches for date/referrer analytics, while the dashboard's live count comes straight from the Durable Object's own storage.

**Permissions** — a single list of granular flags (`src/lib/permissions.js`) drives both the admin UI's checkboxes and every route's authorization check, so adding a new permission means changing exactly one file.

**Login lockout** — failed attempts and lockout state live directly on the `users` row (no separate table, no IP tracking). The tier resets to zero on any successful login, and a parent or admin resetting a locked-out user's password clears the lockout state entirely.

---

## ⚠️ Known simplifications

This is a complete, working implementation of the full spec, but a few areas were kept intentionally simple — worth a look before a large production rollout:

- The activity log and email delivery are best-effort (a failed email never blocks the underlying action).
- CSV import is line-based and only imports slug + target; everything else (password, iframe, social preview) can be set afterward via Edit.
- There's no built-in image upload for the site logo/favicon/social image — those are set as URLs. Only the per-link social preview supports a direct ImgBB upload.
- Login-lockout protection is account-based, not IP-based — a deliberate tradeoff to avoid false positives from shared or dynamic IPs. See the project notes for the reasoning.

---

## 📄 License

MIT
