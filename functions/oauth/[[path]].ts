// Copyright (c) 2026 Joel Stevick
// SPDX-License-Identifier: MIT
// Licensed under the MIT License: https://opensource.org/licenses/MIT

// /oauth/*: the authorization server of the demo's MCP server (README.md, "The MCP server"), served by
// the demo Worker: the consent page (/oauth/authorize), the token endpoint and client registration.
// Only the consent page is given the browser's cookies and the demo cookie's key.
import { forwardToDemo, type DemoMcpEnv } from "../_lib/demo-mcp";

export const onRequest: PagesFunction<DemoMcpEnv> = ({ request, env }) =>
  forwardToDemo(request, env, new URL(request.url).pathname === "/oauth/authorize");
