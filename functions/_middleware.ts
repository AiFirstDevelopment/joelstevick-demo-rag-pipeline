// Copyright (c) 2026 Joel Stevick
// SPDX-License-Identifier: MIT
// Licensed under the MIT License: https://opensource.org/licenses/MIT

// The two OAuth discovery documents of the demo's MCP server (README.md, "The MCP server") live under /.well-known/,
// where a Pages function's file cannot: they are forwarded to the demo Worker from here. Every other request goes on
// unchanged. (On joelstevick.com this middleware also does the site's own redirects, which are not part of this repo.)
import { forwardToDemo, WELL_KNOWN, type DemoMcpEnv } from "./_lib/demo-mcp";

export const onRequest: PagesFunction<DemoMcpEnv> = async ({ request, next, env }) => {
  const url = new URL(request.url);
  if (WELL_KNOWN.some((prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))) return forwardToDemo(request, env);
  return next();
};
