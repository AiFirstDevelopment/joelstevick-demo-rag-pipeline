-- Copyright (c) 2026 Joel Stevick
-- SPDX-License-Identifier: MIT
-- Licensed under the MIT License: https://opensource.org/licenses/MIT

-- Run once against the live database (ALTER TABLE ... ADD COLUMN is not idempotent: check the
-- columns do not exist first). A PDF can be removed from a demo (docs/plans/demo-remove-file.md):
-- files.chars is what the upload took of the demo's room, given back on removal; demos.uploads
-- counts every upload that fit, so Joel is emailed at the first and never again.
ALTER TABLE files ADD COLUMN chars INTEGER NOT NULL DEFAULT 0;
ALTER TABLE demos ADD COLUMN uploads INTEGER NOT NULL DEFAULT 0;
-- Chunks never overlap, so their lengths add up to about the page text the upload counted.
UPDATE files SET chars = (SELECT COALESCE(SUM(LENGTH(c.text)), 0) FROM chunks c WHERE c.demo_id = files.demo_id AND c.file = files.name);
UPDATE demos SET uploads = files + CASE WHEN cleared_at IS NULL THEN 0 ELSE 1 END;
