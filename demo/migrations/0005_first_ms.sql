-- Copyright (c) 2026 Joel Stevick
-- SPDX-License-Identifier: MIT
-- Licensed under the MIT License: https://opensource.org/licenses/MIT

-- Run once against the live database (ALTER TABLE ... ADD COLUMN is not idempotent: check the
-- column does not exist first). The answer is streamed a checked sentence at a time
-- (docs/plans/demo-stream.md): first_ms is how long the visitor waited for the first one.
ALTER TABLE questions ADD COLUMN first_ms INTEGER;
