// Copyright (c) 2026 Joel Stevick
// SPDX-License-Identifier: MIT
// Licensed under the MIT License: https://opensource.org/licenses/MIT

// /demo?key=<key> signs this browser in to that demo: the link a prospect
// bookmarks after saving a card. The page itself is demo.html.
import { demoCookie, isDemoKey } from "./_lib/demo";
import { serverEvent, type TrackEnv } from "./_lib/track";

export const onRequestGet: PagesFunction<TrackEnv> = async ({ request, env, next }) => {
  const key = new URL(request.url).searchParams.get("key");
  const page = await next();
  if (!isDemoKey(key)) return page;
  await serverEvent(env, request, "demo_open", {});
  const response = new Response(page.body, page);
  response.headers.append("Set-Cookie", demoCookie(key));
  response.headers.set("Cache-Control", "no-store");
  return response;
};
