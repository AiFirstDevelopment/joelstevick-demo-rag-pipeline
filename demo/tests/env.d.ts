// Copyright (c) 2026 Joel Stevick
// SPDX-License-Identifier: MIT
// Licensed under the MIT License: https://opensource.org/licenses/MIT

declare module 'cloudflare:test' {
  interface ProvidedEnv {
    DB: D1Database
  }
}
declare module '*.sql?raw' {
  const text: string
  export default text
}

// A source file read as text, for the test that checks what the MCP server's files do not contain.
declare module '*.ts?raw' {
  const text: string
  export default text
}
