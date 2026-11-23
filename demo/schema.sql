-- Copyright (c) 2026 Joel Stevick
-- SPDX-License-Identifier: MIT
-- Licensed under the MIT License: https://opensource.org/licenses/MIT

-- The demo chatbot's own database (joelstevick-com-demos), separate from the
-- consulting one. The text extracted from a prospect's PDFs (chunks) is kept here until
-- 10 days pass without an upload or a question, then deleted by the Worker's daily
-- job; the PDF files never arrive. With consent, a copy of each page's text
-- (archived_pages) and the questions are kept 25 months. migrations/ holds the changes
-- to a live database.

-- One row per demo; unique legacy card identity or namespaced verified-email hash.
CREATE TABLE IF NOT EXISTS demos (
  id                TEXT PRIMARY KEY,          -- random; also the Vectorize namespace
  key_hash          TEXT UNIQUE,               -- SHA-256 of the cookie's key; NULL once purged
  engagement_id     TEXT,                      -- the consulting engagement the registration opened
  card_fingerprint  TEXT NOT NULL UNIQUE,      -- legacy Stripe fingerprint or email:<SHA-256>
  company           TEXT,
  contact           TEXT,                      -- "Name <email>", for the email to Joel
  asks_used         INTEGER NOT NULL DEFAULT 0,
  files             INTEGER NOT NULL DEFAULT 0,
  pages             INTEGER NOT NULL DEFAULT 0,
  chars             INTEGER NOT NULL DEFAULT 0,
  uploads           INTEGER NOT NULL DEFAULT 0,  -- every upload that fit, ever; Joel is told at the first
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  used_at           TEXT,                      -- the last upload or question
  cleared_at        TEXT,                      -- when idle documents were deleted; NULL once new ones arrive
  purged_at         TEXT                       -- whole demo deleted, under the old 14-day rule
);

-- What the page lists for each uploaded PDF.
CREATE TABLE IF NOT EXISTS files (
  demo_id     TEXT NOT NULL REFERENCES demos(id),
  name        TEXT NOT NULL,
  pages       INTEGER NOT NULL,
  chars       INTEGER NOT NULL DEFAULT 0,     -- the text it took of the demo's room, given back on removal
  skipped     TEXT NOT NULL DEFAULT '[]',     -- JSON: the page numbers with no extractable text
  PRIMARY KEY (demo_id, name)
);

-- The retrieved unit: a slice of one page's text, never crossing a page.
CREATE TABLE IF NOT EXISTS chunks (
  id       TEXT PRIMARY KEY,                  -- <demo id>-<upload>-<n>; also the vector's id
  demo_id  TEXT NOT NULL REFERENCES demos(id),
  file     TEXT NOT NULL,
  page     INTEGER NOT NULL,
  text     TEXT NOT NULL,
  seq      INTEGER                            -- its place in its file's chunks; NULL if stored before 0002
);
CREATE INDEX IF NOT EXISTS chunks_demo ON chunks(demo_id);

-- Every question asked (demo/src/app.ts ask), including fallbacks and model failures (answer
-- NULL, fallback 'trouble'). keep is set from the site's consent check at ask time: the 10-day
-- purge deletes only rows with keep = 0, and the daily job deletes the rest after 25 months.
CREATE TABLE IF NOT EXISTS questions (
  id        TEXT PRIMARY KEY,
  demo_id   TEXT NOT NULL REFERENCES demos(id),
  asked_at  TEXT NOT NULL DEFAULT (datetime('now')),
  question  TEXT NOT NULL,
  answer    TEXT,                            -- the model's answer, unverified; NULL when it failed
  sources   TEXT NOT NULL DEFAULT '[]',      -- JSON: [{file, page, last_page?, passage}] cited
  checked   INTEGER NOT NULL DEFAULT 0,      -- 1 when the citation check passed and the answer was shown
  fallback  TEXT,                            -- NULL, 'not_found', 'refused', 'trouble' or 'stopped' (checked, shown in part)
  ms        INTEGER,
  first_ms  INTEGER,                         -- milliseconds to the first sentence shown; NULL when none was
  keep      INTEGER NOT NULL DEFAULT 0,
  via       TEXT                             -- 'mcp' when asked through the MCP server (demo/src/mcp.ts), 'canary' by the daily canary; NULL from the page
);
CREATE INDEX IF NOT EXISTS questions_demo ON questions(demo_id, asked_at);

-- The MCP server's counters (demo/src/mcp.ts): requests a minute for a demo or a hashed address, and
-- searches a day for a demo. `slot` is the minute or the day counted; rows older than two days are
-- deleted by the daily job. No query, token or address is stored here.
CREATE TABLE IF NOT EXISTS mcp_hits (
  key   TEXT NOT NULL,                        -- 'demo:<id>', 'search:<id>' or 'addr:<sha-256 of the address>'
  slot  TEXT NOT NULL,                        -- 'YYYY-MM-DDTHH:MM' or 'YYYY-MM-DD'
  hits  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, slot)
);

-- A copy of each uploaded page's text, written at upload only when keep is set, for analysis
-- and golden sets. The 10-day purge never touches it; the daily job deletes it after 25 months.
CREATE TABLE IF NOT EXISTS archived_pages (
  demo_id     TEXT NOT NULL REFERENCES demos(id),
  file        TEXT NOT NULL,
  page        INTEGER NOT NULL,
  text        TEXT NOT NULL,
  archived_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (demo_id, file, page)
);

-- The pipeline's health (demo/src/health.ts, README.md, "Watching the pipeline"). One row per UTC day and via
-- ('page' or 'mcp'): counts, fallbacks by reason and times, rolled up from `questions` by the daily job.
-- Canary questions are not counted. Counts and times only: no question or answer text.
CREATE TABLE IF NOT EXISTS pipeline_days (
  day        TEXT NOT NULL,                  -- 'YYYY-MM-DD', UTC
  via        TEXT NOT NULL,                  -- 'page' or 'mcp'
  asks       INTEGER NOT NULL,
  answered   INTEGER NOT NULL,               -- passed the check, no fallback
  not_found  INTEGER NOT NULL,
  refused    INTEGER NOT NULL,
  trouble    INTEGER NOT NULL,
  stopped    INTEGER NOT NULL,
  ms_p50     INTEGER,
  ms_p95     INTEGER,
  first_p50  INTEGER,
  PRIMARY KEY (day, via)
);

-- What the drift check flagged for a day: the metric, its value, the baseline and the threshold it passed.
CREATE TABLE IF NOT EXISTS pipeline_flags (
  day        TEXT NOT NULL,
  via        TEXT NOT NULL,                  -- 'page', 'mcp' or 'canary'
  metric     TEXT NOT NULL,                  -- 'refused', 'trouble', 'stopped', 'not_found', 'ms_p95', 'canary'
  value      REAL NOT NULL,
  baseline   REAL NOT NULL,
  threshold  REAL NOT NULL,
  PRIMARY KEY (day, via, metric)
);

-- The canary's daily answers to its fixed questions about its fixed document (demo/src/canary.ts).
CREATE TABLE IF NOT EXISTS canary_runs (
  day     TEXT NOT NULL,
  name    TEXT NOT NULL,                     -- the case's name
  passed  INTEGER NOT NULL,
  found   INTEGER NOT NULL,                  -- 1 when the pipeline answered, 0 when it fell back
  ms      INTEGER,
  answer  TEXT,                              -- the first 300 characters of the invented document's answer
  PRIMARY KEY (day, name)
);
