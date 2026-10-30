-- Copyright (c) 2026 Joel Stevick
-- SPDX-License-Identifier: MIT
-- Licensed under the MIT License: https://opensource.org/licenses/MIT

-- Run once against the live database: the order of a file's chunks, so an answer can widen a
-- chosen chunk with its neighbours. Chunks stored before it keep NULL and are not widened.
ALTER TABLE chunks ADD COLUMN seq INTEGER;
