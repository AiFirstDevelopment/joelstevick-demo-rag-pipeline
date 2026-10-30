-- Copyright (c) 2026 Joel Stevick
-- SPDX-License-Identifier: MIT
-- Licensed under the MIT License: https://opensource.org/licenses/MIT

-- Run once against the live database: a demo's documents are deleted after 10 days without use.
ALTER TABLE demos ADD COLUMN used_at TEXT;
ALTER TABLE demos ADD COLUMN cleared_at TEXT;
