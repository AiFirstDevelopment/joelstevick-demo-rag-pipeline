// Copyright (c) 2026 Joel Stevick
// SPDX-License-Identifier: MIT
// Licensed under the MIT License: https://opensource.org/licenses/MIT

// A stand-in for the site's visitor analytics, which are not part of this repository. On
// joelstevick.com this module records visits and events in the site's own D1 database, and
// `mayRecord` answers whether this visitor may be recorded (in the EEA, the UK and Switzerland
// only after they accept the cookie banner). Here nothing is recorded and no visitor has
// consented, so the demo Worker is told X-Demo-Keep: 0 and keeps nothing past its 10-day purge.

export interface TrackEnv {
  DB?: D1Database;
}

/** Whether this visitor may be recorded. The site checks consent and location; here, never. */
export function mayRecord(_request: Request, _env: TrackEnv): boolean {
  return false;
}

/** Records one server-side event (an upload, a removal, a question). Here, nothing. */
export async function serverEvent(
  _env: TrackEnv,
  _request: Request,
  _type: string,
  _data: Record<string, unknown> = {},
  _email?: string | null,
): Promise<void> {}
