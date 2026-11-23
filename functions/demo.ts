// Copyright (c) 2026 Joel Stevick
// SPDX-License-Identifier: MIT
// Licensed under the MIT License: https://opensource.org/licenses/MIT

// /demo?key=<key> signs this browser in to that demo: the link a prospect
// bookmarks after saving a card. The page itself is demo.html.
import { demoCookie, isDemoKey } from "./_lib/demo";
import { serverEvent, type TrackEnv } from "./_lib/track";

export const onRequestGet: PagesFunction<TrackEnv> = async ({ request, env, next }) => {
  // Read the key from the link and fetch the page as usual.
  const key = new URL(request.url).searchParams.get("key");
  const page = await next();

  // Without a well-formed key, the page is served as it is.
  if (!isDemoKey(key)) return page;

  // Note that someone opened their demo from the link.
  await serverEvent(env, request, "demo_open", {});

  // Hand back the same page with the demo cookie set, and keep it out of any cache.
  const response = new Response(page.body, page);
  response.headers.append("Set-Cookie", demoCookie(key));
  response.headers.set("Cache-Control", "no-store");

  return response;
};
