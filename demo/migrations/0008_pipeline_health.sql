-- Copyright (c) 2026 Joel Stevick
-- SPDX-License-Identifier: MIT
-- Licensed under the MIT License: https://opensource.org/licenses/MIT

-- The demo pipeline's health (README.md, "Watching the pipeline"): daily metrics, drift flags and the canary.
-- IF NOT EXISTS throughout, so it can be run again.
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
