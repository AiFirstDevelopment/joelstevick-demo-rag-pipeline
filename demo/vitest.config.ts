// Copyright (c) 2026 Joel Stevick
// SPDX-License-Identifier: MIT
// Licensed under the MIT License: https://opensource.org/licenses/MIT

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config'

const HERE = path.dirname(fileURLToPath(import.meta.url))

// The demo Worker's routes, in workerd against a real local D1. Workers AI and
// Vectorize have no local runtime, so the tests pass scripted ones
// (tests/support/scripted.ts) and the bindings are left out here.
export default defineWorkersConfig({
  root: HERE,
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    poolOptions: {
      workers: {
        main: path.join(HERE, 'src/index.ts'),
        miniflare: {
          compatibilityDate: '2026-10-01',
          d1Databases: ['DB'],
        },
      },
    },
  },
})
