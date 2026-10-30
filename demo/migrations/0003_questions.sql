-- Copyright (c) 2026 Joel Stevick
-- SPDX-License-Identifier: MIT
-- Licensed under the MIT License: https://opensource.org/licenses/MIT

-- Run once against the live database (CREATE IF NOT EXISTS, so running it again is harmless):
-- every question asked, and the archived page text kept for 25 months with consent.
CREATE TABLE IF NOT EXISTS questions (
  id        TEXT PRIMARY KEY,
  demo_id   TEXT NOT NULL REFERENCES demos(id),
  asked_at  TEXT NOT NULL DEFAULT (datetime('now')),
  question  TEXT NOT NULL,
  answer    TEXT,
  sources   TEXT NOT NULL DEFAULT '[]',
  checked   INTEGER NOT NULL DEFAULT 0,
  fallback  TEXT,
  ms        INTEGER,
  keep      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS questions_demo ON questions(demo_id, asked_at);
CREATE TABLE IF NOT EXISTS archived_pages (
  demo_id     TEXT NOT NULL REFERENCES demos(id),
  file        TEXT NOT NULL,
  page        INTEGER NOT NULL,
  text        TEXT NOT NULL,
  archived_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (demo_id, file, page)
);
