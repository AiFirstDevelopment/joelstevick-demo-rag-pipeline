// Copyright (c) 2026 Joel Stevick
// SPDX-License-Identifier: MIT
// Licensed under the MIT License: https://opensource.org/licenses/MIT

// The demo's cookie: a random key whose SHA-256 the demo Worker stores. Read
// here, never sent anywhere but the DEMO binding.

export const COOKIE = "demo";
const FORMAT = /^[A-Za-z0-9_-]{43}$/;

export function demoKey(request: Request): string | null {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === COOKIE && FORMAT.test(value.join("="))) return value.join("=");
  }
  return null;
}

export const isDemoKey = (key: string | null): key is string => key !== null && FORMAT.test(key);

export function demoCookie(key: string): string {
  return `${COOKIE}=${key}; Path=/; Max-Age=${14 * 86_400}; HttpOnly; Secure; SameSite=Lax`;
}
