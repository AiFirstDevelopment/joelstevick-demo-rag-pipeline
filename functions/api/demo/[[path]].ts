// Copyright (c) 2026 Joel Stevick
// SPDX-License-Identifier: MIT
// Licensed under the MIT License: https://opensource.org/licenses/MIT

// The demo page's endpoints: /api/demo/session, /files and /ask. Forwards each to
// the demo Worker (demo/) through the DEMO binding, with the visitor's demo
// cookie as X-Demo-Key. Nothing the visitor sends names the demo: the Worker
// finds it by the key's hash. X-Demo-Keep tells the Worker whether this visitor may
// be recorded (functions/_lib/track.ts): only then are the page text and the questions
// kept past the 10-day purge. An upload, a removal (DELETE files) and a question are recorded as events.
import { demoKey } from "../../_lib/demo";
import { mayRecord, serverEvent, type TrackEnv } from "../../_lib/track";

interface Env extends TrackEnv {
  DEMO?: Fetcher;
}

const ROUTES = new Set(["session", "files", "ask"]);
/** Headers the Worker answers the site with, never passed on to the browser. */
const INTERNAL = ["X-Demo-Email", "X-Demo-Id", "X-Question-Id"];

export const onRequest: PagesFunction<Env, "path"> = async ({ request, env, params }) => {
  const path = Array.isArray(params.path) ? params.path.join("/") : String(params.path ?? "");
  if (!ROUTES.has(path)) return Response.json({ error: "not found" }, { status: 404 });
  if (env.DEMO === undefined) return Response.json({ error: "The demo is not available right now." }, { status: 503 });
  const headers = new Headers({ "Content-Type": "application/json" });
  const key = demoKey(request);
  if (key !== null) headers.set("X-Demo-Key", key);
  const keep = mayRecord(request, env);
  headers.set("X-Demo-Keep", keep ? "1" : "0");
  const answer = await env.DEMO.fetch(`https://demo/api/${path}`, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.text(),
  });
  const email = answer.headers.get("X-Demo-Email");
  const demo = answer.headers.get("X-Demo-Id");
  if (answer.ok && path === "files") {
    const body = (await answer.clone().json().catch(() => ({}))) as { name?: string; pages?: number; chars?: number };
    if (request.method === "DELETE") await serverEvent(env, request, "demo_remove", { demo, file: body.name }, email);
    else await serverEvent(env, request, "demo_upload", { demo, file: body.name, pages: body.pages, chars: body.chars }, email);
  }
  const question = answer.headers.get("X-Question-Id");
  if (path === "ask" && question !== null) await serverEvent(env, request, "demo_ask", { demo, question }, email);
  const response = new Response(answer.body, answer);
  for (const name of INTERNAL) response.headers.delete(name);
  return response;
};
