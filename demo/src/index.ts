// Copyright (c) 2026 Joel Stevick
// SPDX-License-Identifier: MIT
// Licensed under the MIT License: https://opensource.org/licenses/MIT

// The deployed demo Worker: Claude on Joel's key, bge-m3 through Workers AI, and
// the demo's own Vectorize index. The routes are in app.ts.
import { createApp } from './app'
import { claudeFor, embedFor, vectorsFor } from './models'

export default createApp((env) => ({
  claude: claudeFor(env.ANTHROPIC_API_KEY),
  embed: embedFor(env.AI),
  vectors: vectorsFor(env.VECTORS),
}))
