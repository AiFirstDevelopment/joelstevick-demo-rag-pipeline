// Copyright (c) 2026 Joel Stevick
// SPDX-License-Identifier: MIT
// Licensed under the MIT License: https://opensource.org/licenses/MIT

// /mcp/demo: the demo's MCP server (README.md, "The MCP server"), served by the demo Worker. A static
// route beside [training].ts, which is why no training may be called "demo" (scripts/tutor-outlines.mjs checks).
import { forwardToDemo, type DemoMcpEnv } from "../_lib/demo-mcp";

export const onRequest: PagesFunction<DemoMcpEnv> = ({ request, env }) => forwardToDemo(request, env);
