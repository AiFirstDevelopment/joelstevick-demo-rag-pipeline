// Copyright (c) 2026 Joel Stevick
// SPDX-License-Identifier: MIT
// Licensed under the MIT License: https://opensource.org/licenses/MIT

// The site's door to the demo's MCP server and its OAuth endpoints (README.md, "The MCP server"). The
// server and the authorization server are in the demo Worker (demo/src/mcp.ts, demo/src/oauth.ts),
// which has no public URL: these paths are forwarded to it through the DEMO binding with the
// request's own URL, so every address the Worker publishes is the site's. Nothing of the protocol
// or of OAuth is here.
import { demoKey } from "./demo";
import { mayRecord, serverEvent, type TrackEnv } from "./track";

export interface DemoMcpEnv extends TrackEnv {
  DEMO?: Fetcher;
}

/** The two discovery documents an MCP client reads: the protected resource's and the authorization server's. */
export const WELL_KNOWN = ["/.well-known/oauth-protected-resource", "/.well-known/oauth-authorization-server"];
/** Headers the Worker answers the site with, never passed on to the caller. */
const INTERNAL = ["X-Demo-Email", "X-Demo-Id", "X-Mcp-Grant", "X-Mcp-Scopes"];

/**
 * Forwards one request to the demo Worker and hands its answer back. `consent` is the authorization
 * page: only there do the browser's cookies go through (the consent form's own, set by the Worker),
 * with the demo cookie's key as X-Demo-Key, which is who the visitor is. A caller can never set that
 * header, or its own address, itself: both are removed from what arrived and set here.
 */
export async function forwardToDemo(request: Request, env: DemoMcpEnv, consent = false): Promise<Response> {
  if (env.DEMO === undefined) return Response.json({ error: "The demo is not available right now." }, { status: 503 });
  const headers = new Headers(request.headers);
  const names: string[] = [];
  headers.forEach((_value, name) => names.push(name));
  for (const name of names) if (name.toLowerCase().startsWith("x-demo-") || name.toLowerCase() === "x-client-address") headers.delete(name);
  if (!consent) headers.delete("Cookie");
  headers.set("X-Client-Address", request.headers.get("CF-Connecting-IP") ?? "unknown");
  headers.set("X-Demo-Keep", mayRecord(request, env) ? "1" : "0");
  const key = consent ? demoKey(request) : null;
  if (key !== null) headers.set("X-Demo-Key", key);
  const answer = await env.DEMO.fetch(request.url, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
    redirect: "manual",
  });
  // A decision on the consent page is recorded as an event, with the scopes and never the app's token.
  const decision = answer.headers.get("X-Mcp-Grant");
  if (decision !== null) {
    await serverEvent(env, request, "demo_mcp_grant", { demo: answer.headers.get("X-Demo-Id"), decision, scopes: answer.headers.get("X-Mcp-Scopes") ?? "" }, answer.headers.get("X-Demo-Email"));
  }
  const response = new Response(answer.body, answer);
  for (const name of INTERNAL) response.headers.delete(name);
  return response;
}
