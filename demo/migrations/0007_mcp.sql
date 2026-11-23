-- Copyright (c) 2026 Joel Stevick
-- SPDX-License-Identifier: MIT
-- Licensed under the MIT License: https://opensource.org/licenses/MIT

-- Run once against the live database (ALTER TABLE ... ADD COLUMN is not idempotent: check the
-- column does not exist first). The demo's MCP server (README.md, "The MCP server"): a question asked
-- through it is marked, and its limits are counted in mcp_hits.
ALTER TABLE questions ADD COLUMN via TEXT;
CREATE TABLE IF NOT EXISTS mcp_hits (
  key   TEXT NOT NULL,
  slot  TEXT NOT NULL,
  hits  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, slot)
);
