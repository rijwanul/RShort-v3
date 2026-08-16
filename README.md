# RShort v3

A self-hostable URL shortener that deploys entirely on Cloudflare's free-tier stack: **Workers + D1 + Durable Objects**, with a plain HTML/CSS/JS frontend (no Node.js build step). Anyone can deploy their own branded instance in a few minutes.

## Features

- Custom or randomly generated short slugs (case-insensitive, letters/numbers/underscore/dash)
- Password-protected links, full-page-iframe links (for platforms like Telegram that need the actual destination page rendered), and custom social preview cards (title/description/image, via ImgBB or a plain image URL)
- Reliable hit counting via a Durable Object (avoids the race conditions and consistency issues that plague KV- or D1-only counters), with date-wise and referrer-bucketed analytics
- Root admin + top-level users + sub-users (two levels deep, no further nesting), each with granular, checkbox-level permissions
- Sub-user accounts can be turned off site-wide from Site Settings, with a guided transfer/convert/suspend/delete flow for any sub-users that already exist
- CSV import/export for short links and reserved keywords
- Self-registration (optional, with domain allow/block lists and auto-approve or manual approval)
- Editable email templates (welcome, password reset, forgot password, account disabled), each independently toggleable, sent via a generic webhook or Resend.com
- Per-user API keys (inheriting that user's own permissions) for `/api/checkAvailability`, `/api/newEntry`, `/api/deleteEntry`
- Fully theme-able: site title, logo, favicon, social image, accent color, homepage notice/button, all editable from the dashboard

## Tech stack

- **Cloudflare Workers** for the API and redirect logic
- **D1** (SQLite) for all persistent data
- **Durable Objects** for race-free hit counting
- **Workers Static Assets** for the plain HTML/CSS/JS frontend (no bundler, no npm build step)
- **Poppins** (Google Fonts) + **Lucide** icons (via the unpkg CDN script)

## Getting started

Full copy-paste deployment steps live in `cloudflare-ignore/instructions.html` (open it in a browser - it's excluded from deployment). In short:

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

Then visit `/login` and sign in with your root credentials - you'll be asked to set a new password immediately.

## Project structure

```
├── img/                    (source branding images copied into public/img at build)
├── cloudflare-ignore/
│   └── instructions.html   deployment walkthrough + interactive API tester (not deployed)
├── public/                 static frontend, served directly by Workers Assets
│   ├── index.html          homepage
│   ├── login/index.html
│   ├── register/index.html
│   ├── dashboard/index.html
│   ├── css/style.css
│   └── js/                 api.js (fetch helper) + app.js (dashboard SPA)
├── src/
│   ├── index.js            Worker entry point / router
│   ├── durable-objects/hit-counter.js
│   ├── lib/                 auth, crypto, email, imgbb, permissions, utils
│   └── routes/               auth, urls, users, admin, redirect
├── schema.sql
└── wrangler.toml
```

## Architecture notes

- **Auth**: stateless signed JWT (HS256) in an HttpOnly cookie, short-lived (1 hour, silently refreshed). Because a pure JWT can't be revoked before it expires, every authenticated request also re-checks the user's `enabled` flag and a `token_version` counter in D1 - disabling a user or forcing a password change invalidates their session immediately without needing server-side session storage.
- **Hit counting**: each short link gets its own Durable Object instance. Because a Durable Object processes requests for a given ID one at a time, increments never race - this is what earlier KV/D1-only attempts were missing. Raw hit events are buffered in the Durable Object and flushed to D1 in batches for date/referrer analytics, while the dashboard's live count comes straight from the Durable Object's own storage.
- **Permissions**: a single list of granular flags (see `src/lib/permissions.js`) drives both the admin UI's checkboxes and every route's authorization check, so adding a new permission only means adding it in one place.

## Known simplifications

This is a complete, working implementation of the full spec, but a few areas were kept intentionally simple given the scope - worth a look before a large production rollout:

- The activity log and email delivery are best-effort (a failed email never blocks the underlying action).
- CSV import is line-based and does not attempt to import the full set of a link's optional fields (password, iframe, social preview) - only slug + target. Everything else can still be set afterward via Edit.
- There's no built-in image upload for the site logo/favicon/social image - those are set as URLs. Only the per-link social preview supports a direct ImgBB upload.

## License

Do whatever you like with this - it's yours.
