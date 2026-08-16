-- RShort v3 database schema
-- Apply with: wrangler d1 execute rshort3_db --file=./schema.sql --remote
-- (drop --remote for local dev)

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------
-- Users & sub-users (strictly 2 levels: parent_id NULL = top-level user,
-- parent_id set = sub-user of that user). Root admin is a user row with
-- is_root = 1.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL COLLATE NOCASE,
  email TEXT COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  is_root INTEGER NOT NULL DEFAULT 0,
  parent_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  permissions TEXT NOT NULL DEFAULT '{}', -- JSON map of granular permission flags
  must_change_password INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  approved INTEGER NOT NULL DEFAULT 1, -- used for self-registration approval queue
  token_version INTEGER NOT NULL DEFAULT 1, -- bump to invalidate all outstanding JWTs
  error_settings TEXT NOT NULL DEFAULT '{}', -- JSON: per-user 404/disabled error config
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_parent ON users(parent_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- ---------------------------------------------------------------------
-- Short URLs
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS urls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL COLLATE NOCASE,
  target TEXT NOT NULL,
  password TEXT, -- stored in plain text by design (spec requires showing it back in Edit mode)
  full_iframe INTEGER NOT NULL DEFAULT 0,
  social_enabled INTEGER NOT NULL DEFAULT 0,
  social_title TEXT,
  social_description TEXT,
  social_image_url TEXT,
  social_image_delete_url TEXT, -- ImgBB delete_url, if uploaded via ImgBB
  social_image_source TEXT DEFAULT 'none', -- 'none' | 'imgbb' | 'url'
  created_by INTEGER NOT NULL REFERENCES users(id),
  enabled INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_urls_slug ON urls(slug);
CREATE INDEX IF NOT EXISTS idx_urls_created_by ON urls(created_by);
CREATE INDEX IF NOT EXISTS idx_urls_deleted ON urls(deleted_at);

-- ---------------------------------------------------------------------
-- Hit logs (flushed in batches from the HitCounter Durable Object).
-- Kept until the parent URL is deleted (ON DELETE CASCADE).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url_id INTEGER NOT NULL REFERENCES urls(id) ON DELETE CASCADE,
  hit_date TEXT NOT NULL, -- YYYY-MM-DD (UTC)
  referrer_bucket TEXT NOT NULL DEFAULT 'direct',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_hitlogs_url_date ON hit_logs(url_id, hit_date);

-- ---------------------------------------------------------------------
-- Reserved keywords (slugs that can never be registered)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reserved_keywords (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword TEXT NOT NULL COLLATE NOCASE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_reserved_keyword ON reserved_keywords(keyword);

INSERT OR IGNORE INTO reserved_keywords (keyword) VALUES
  ('admin'), ('api'), ('dashboard'), ('settings'),
  ('login'), ('register'), ('signup'), ('signin');

-- ---------------------------------------------------------------------
-- API keys (inherit the owning user's permissions; scoped to the 3
-- public API endpoints at the application layer)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_hash TEXT NOT NULL,
  key_prefix TEXT NOT NULL, -- first 8 chars shown in UI for identification
  label TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_apikeys_hash ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_apikeys_user ON api_keys(user_id);

-- ---------------------------------------------------------------------
-- Activity log (plain-language, shown to non-technical admins/users)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_type TEXT NOT NULL, -- 'user' | 'api_key'
  actor_id INTEGER NOT NULL,
  actor_label TEXT NOT NULL, -- denormalized username / key label for display even after deletion
  action TEXT NOT NULL, -- machine action code, e.g. 'url.create'
  message TEXT NOT NULL, -- human readable sentence
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at);

-- ---------------------------------------------------------------------
-- Site-wide settings (key/value; values are JSON-encoded strings)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('site_title', '"RShort v3"'),
  ('theme_color', '"#417B5A"'),
  ('logo_url', '"/img/logo.png"'),
  ('favicon_url', '"/img/favicon.png"'),
  ('social_image_url', '"/img/social.png"'),
  ('slug_min_chars', '4'),
  ('homepage_notice', '"Thanks for visiting! Nothing much to see here though."'),
  ('homepage_button_label', '"rijwanul.com"'),
  ('homepage_button_url', '"https://rijwanul.com/"'),
  ('homepage_button_new_tab', 'true'),
  ('homepage_show_login', 'true'),
  ('registration_enabled', 'false'),
  ('registration_show_on_homepage', 'false'),
  ('registration_auto_approve', 'false'),
  ('registration_domain_mode', '"none"'), -- 'none' | 'allow_only' | 'block'
  ('registration_domain_list', '[]'),
  ('forgot_password_enabled', 'true'),
  ('imgbb_api_key', '""'),
  ('email_webhook_url', '""'),
  ('resend_api_key', '""'),
  ('resend_from_email', '""'),
  ('default_error_text', '"No such link found!"'),
  ('default_error_button_label', '""'),
  ('default_error_button_url', '""'),
  ('default_disabled_text', '"Link has been disabled!"'),
  ('default_disabled_button_label', '""'),
  ('default_disabled_button_url', '""'),
  ('subusers_feature_enabled', 'true');

-- ---------------------------------------------------------------------
-- Email templates. Each event (welcome, password_reset,
-- forgot_password, account_disabled) has an editable subject/body and
-- an independent on/off toggle - if disabled, that email is silently
-- not sent when the event occurs. Bodies support placeholders:
-- {{username}}, {{tempPassword}}, {{loginUrl}}, {{siteTitle}}.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_templates (
  key TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
);

INSERT OR IGNORE INTO email_templates (key, subject, body, enabled) VALUES
  ('welcome', 'Your {{siteTitle}} account has been created',
   'Hello {{username}},

An account has been created for you on {{siteTitle}}.

Username: {{username}}
Temporary password: {{tempPassword}}

Please sign in at {{loginUrl}} to get started.

If you did not expect this account, you can ignore this email.', 1),
  ('password_reset', 'Your {{siteTitle}} password has been reset',
   'Hello {{username}},

An administrator has reset your password on {{siteTitle}}.

Temporary password: {{tempPassword}}

Please sign in at {{loginUrl}} - you will be asked to set a new password.

If you did not expect this, please contact your administrator.', 1),
  ('forgot_password', 'Reset your {{siteTitle}} password',
   'Hello {{username}},

We received a request to reset your password on {{siteTitle}}.

Temporary password: {{tempPassword}}

Please sign in at {{loginUrl}} - you will be asked to set a new password.

If you did not request this, please contact your administrator.', 1),
  ('account_disabled', 'Your {{siteTitle}} account has been disabled',
   'Hello {{username}},

Your account on {{siteTitle}} has been disabled by an administrator.

If you believe this is a mistake, please contact your administrator.', 1);

-- ---------------------------------------------------------------------
-- External tools (root-managed list; per-user copies allow users to add
-- their own while sub-users may be view-only per their permissions)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS external_tools (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE, -- NULL = global/default tool visible to everyone
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO external_tools (id, title, url, owner_id) VALUES
  (1, 'QR Code Generator', 'https://goqr.me/', NULL),
  (2, 'Font Styler', 'https://lingojam.com/BoldTextGenerator', NULL);

-- ---------------------------------------------------------------------
-- Per-top-level-user hides of admin (site-wide, owner_id IS NULL)
-- external tools. A parent user can "delete" a site-wide tool for
-- themselves and their sub-users without removing it for anyone else
-- or for the site as a whole; only root can truly delete a global tool.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hidden_external_tools (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tool_id INTEGER NOT NULL REFERENCES external_tools(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, tool_id)
);
