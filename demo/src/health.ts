// Copyright (c) 2026 Joel Stevick
// SPDX-License-Identifier: MIT
// Licensed under the MIT License: https://opensource.org/licenses/MIT

/**
 * The demo pipeline's health (README.md, "Watching the pipeline"), run by the Worker's daily job:
 *
 *   1. ROLL UP   each day's questions into counts, fallback rates and times (`pipeline_days`), per `via`;
 *   2. DRIFT     compare each day with the 14 days before it and flag a rate or a time that moved
 *                further than noise explains (`pipeline_flags`);
 *   3. CANARY    ask fixed questions of a fixed document through the real pipeline, so a change in the
 *                model or retrieval shows even on a day with no visitors (`canary_runs`).
 *
 * `/internal/admin/health` serves all three to /admin's Stats tab, and the mailer alerts Joel on a flag.
 * Counts and times only: no visitor's question or answer is copied anywhere.
 */
import { ask, asText, json, upload, type Demo, type Env, type Options } from './app'
import { CANARY_CASES, CANARY_FILE, CANARY_PAGES, type CanaryCase } from './canary'
import type { Models } from './models'

/** The routes a question can come through. The canary's are never counted as traffic. */
export const VIAS = ['page', 'mcp'] as const
/** How far back a missed day is still rolled up: unconsented questions are deleted after 10 days. */
export const CATCH_UP_DAYS = 9
/** The baseline: this many days before the day being checked, pooled. */
export const BASELINE_DAYS = 14
/** A day needs this many questions before its rates or times are judged. */
export const MIN_DAY = 10
/** A baseline needs this many questions (rates) or days with questions (times) before it judges anything. */
export const MIN_BASELINE_ASKS = 30
export const MIN_BASELINE_DAYS = 5
/** A rate is flagged above the baseline by more than this many standard errors… */
export const SIGMAS = 3
/** …and by at least this much, so a tiny baseline rate cannot make a single miss look like drift. */
export const MIN_RATE_JUMP = 0.05
/** The 95th-percentile time is flagged above this multiple of the baseline days' median p95. */
export const SLOW_FACTOR = 1.5
/** The rates the drift check watches: each a count in `pipeline_days`. */
export const RATES = ['refused', 'trouble', 'stopped', 'not_found'] as const
/** The canary demo's identity in `demos.card_fingerprint`. */
export const CANARY_FINGERPRINT = 'canary:v1'

export interface DayRow {
  day: string
  via: string
  asks: number
  answered: number
  not_found: number
  refused: number
  trouble: number
  stopped: number
  ms_p50: number | null
  ms_p95: number | null
  first_p50: number | null
}

export interface Flag {
  day: string
  via: string
  metric: string
  value: number
  baseline: number
  threshold: number
}

/** The `q` percentile of `values` by the nearest-rank method: the smallest value with at least q of them at or below it. */
export function percentile(values: number[], q: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]
}

/** The day `n` days before `day`, as 'YYYY-MM-DD'. */
export function daysBefore(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10)
}

/** STEP 1 · one day's questions rolled up, per via; the day's rows are replaced. Canary questions are left out. */
export async function rollUp(env: Env, day: string): Promise<DayRow[]> {
  const rows = (await env.DB.prepare(
    `SELECT COALESCE(via, 'page') AS via, checked, fallback, ms, first_ms FROM questions
     WHERE substr(asked_at, 1, 10) = ? AND COALESCE(via, 'page') <> 'canary'`,
  ).bind(day).all<{ via: string; checked: number; fallback: string | null; ms: number | null; first_ms: number | null }>()).results
  const out: DayRow[] = []
  for (const via of VIAS) {
    const mine = rows.filter((row) => row.via === via)
    if (mine.length === 0) continue
    const count = (fallback: string) => mine.filter((row) => row.fallback === fallback).length
    const times = mine.map((row) => row.ms).filter((ms): ms is number => ms !== null)
    const firsts = mine.map((row) => row.first_ms).filter((ms): ms is number => ms !== null)
    out.push({
      day, via, asks: mine.length,
      answered: mine.filter((row) => row.checked === 1 && row.fallback === null).length,
      not_found: count('not_found'), refused: count('refused'), trouble: count('trouble'), stopped: count('stopped'),
      ms_p50: percentile(times, 0.5), ms_p95: percentile(times, 0.95), first_p50: percentile(firsts, 0.5),
    })
  }
  await env.DB.batch([
    env.DB.prepare('DELETE FROM pipeline_days WHERE day = ?').bind(day),
    ...out.map((r) => env.DB.prepare(
      'INSERT INTO pipeline_days (day, via, asks, answered, not_found, refused, trouble, stopped, ms_p50, ms_p95, first_p50) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(r.day, r.via, r.asks, r.answered, r.not_found, r.refused, r.trouble, r.stopped, r.ms_p50, r.ms_p95, r.first_p50)),
  ])
  return out
}

/**
 * STEP 2 · the drift rules, as a pure function of one day and its baseline days (same via).
 *
 * A rate is a count out of the day's questions. The baseline rate p is pooled over the baseline days
 * (their counts summed over their questions summed). Under "nothing changed", the day's rate is a
 * binomial proportion around p with standard error sqrt(p(1-p)/n), so a rate more than SIGMAS standard
 * errors above p is unlikely to be noise; MIN_RATE_JUMP keeps a near-zero baseline from flagging one miss.
 * Time is flagged against the median of the baseline days' p95s, a robust centre one slow day cannot drag.
 */
export function driftFlags(today: DayRow, baseline: DayRow[]): Flag[] {
  const flags: Flag[] = []
  if (today.asks < MIN_DAY) return flags
  const baseAsks = baseline.reduce((sum, row) => sum + row.asks, 0)
  if (baseAsks >= MIN_BASELINE_ASKS) {
    for (const metric of RATES) {
      const p = baseline.reduce((sum, row) => sum + row[metric], 0) / baseAsks
      const rate = today[metric] / today.asks
      const threshold = Math.max(p + SIGMAS * Math.sqrt((p * (1 - p)) / today.asks), p + MIN_RATE_JUMP)
      if (rate > threshold) flags.push({ day: today.day, via: today.via, metric, value: rate, baseline: p, threshold })
    }
  }
  const p95s = baseline.map((row) => row.ms_p95).filter((ms): ms is number => ms !== null)
  if (p95s.length >= MIN_BASELINE_DAYS && today.ms_p95 !== null) {
    const centre = percentile(p95s, 0.5) as number
    if (today.ms_p95 > SLOW_FACTOR * centre) flags.push({ day: today.day, via: today.via, metric: 'ms_p95', value: today.ms_p95, baseline: centre, threshold: SLOW_FACTOR * centre })
  }
  return flags
}

/** STEP 2 · checks one rolled-up day against the 14 days before it, and stores its flags (replacing that day's traffic flags). */
export async function checkDrift(env: Env, day: string): Promise<Flag[]> {
  const rows = (await env.DB.prepare('SELECT * FROM pipeline_days WHERE day BETWEEN ? AND ?').bind(daysBefore(day, BASELINE_DAYS), day).all<DayRow>()).results
  const flags = VIAS.flatMap((via) => {
    const today = rows.find((row) => row.day === day && row.via === via)
    return today === undefined ? [] : driftFlags(today, rows.filter((row) => row.via === via && row.day < day))
  })
  await env.DB.batch([
    env.DB.prepare("DELETE FROM pipeline_flags WHERE day = ? AND via <> 'canary'").bind(day),
    ...flags.map((f) => env.DB.prepare('INSERT INTO pipeline_flags (day, via, metric, value, baseline, threshold) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(f.day, f.via, f.metric, f.value, f.baseline, f.threshold)),
  ])
  return flags
}

/** The canary demo, made the first time, with its document uploaded when it has none. */
async function canaryDemo(env: Env, models: Models): Promise<Demo> {
  const read = () => env.DB.prepare('SELECT id, asks_used, files, pages, chars, company, contact, cleared_at FROM demos WHERE card_fingerprint = ? AND purged_at IS NULL')
    .bind(CANARY_FINGERPRINT).first<Demo>()
  let demo = await read()
  if (demo === null) {
    // No key: no browser can ever sign in to it. No contact: no email names it.
    await env.DB.prepare("INSERT INTO demos (id, card_fingerprint, company) VALUES (?, ?, 'Canary')").bind(`canary${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`, CANARY_FINGERPRINT).run()
    demo = (await read()) as Demo
  }
  if (demo.files === 0) {
    // The page's own upload, without the mailer: the canary is not a prospect starting a demo.
    const response = await upload(new Request('https://demo/api/files', {
      method: 'POST',
      body: JSON.stringify({ name: CANARY_FILE, page_count: CANARY_PAGES.length, pages: CANARY_PAGES.map((text, i) => ({ page: i + 1, text })) }),
    }), { ...env, MAILER: undefined }, models, demo)
    if (!response.ok) throw new Error(`canary: the document could not be uploaded (${response.status})`)
    demo = (await read()) as Demo
  }
  return demo
}

/** Whether one canary answer is right: the words a right answer holds, or a fallback where the document has no answer. */
export function canaryPassed(test: CanaryCase, found: boolean, answer: string): boolean {
  if (test.fallback === true) return !found
  const text = answer.toLowerCase()
  return found && test.must.every((word) => text.includes(word.toLowerCase()))
}

/**
 * STEP 3 · the canary's run for `day`: each question through the page's own ask, with the real models,
 * marked `via = 'canary'` so step 1 never counts it. A day with a failure is flagged.
 */
export async function runCanary(env: Env, models: Models, options: Options, day: string, cases: CanaryCase[] = CANARY_CASES): Promise<{ passed: number; of: number } | null> {
  if (env.CANARY_ENABLED === '0') return null
  let demo = await canaryDemo(env, models)
  // Its allowance is reset each run: the canary is not a visitor.
  await env.DB.prepare('UPDATE demos SET asks_used = 0 WHERE id = ?').bind(demo.id).run()
  demo = { ...demo, asks_used: 0 }
  let passed = 0
  for (const test of cases) {
    const started = Date.now()
    const response = await ask(new Request('https://demo/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Demo-Via': 'canary', 'X-Demo-Keep': '0' },
      body: JSON.stringify({ question: test.question }),
    }), env, models, demo, options)
    const body = (await response.json().catch(() => ({}))) as { answer?: string; items?: string[]; found?: boolean }
    const answer = asText(body.answer ?? '', body.items ?? [])
    const ok = response.ok && canaryPassed(test, body.found === true, answer)
    if (ok) passed++
    await env.DB.prepare('INSERT OR REPLACE INTO canary_runs (day, name, passed, found, ms, answer) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(day, test.name, ok ? 1 : 0, body.found === true ? 1 : 0, Date.now() - started, answer.slice(0, 300)).run()
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM pipeline_flags WHERE day = ? AND via = 'canary'").bind(day),
    ...(passed < cases.length
      ? [env.DB.prepare("INSERT INTO pipeline_flags (day, via, metric, value, baseline, threshold) VALUES (?, 'canary', 'canary', ?, ?, ?)").bind(day, passed, cases.length, cases.length)]
      : []),
    // The canary's own questions are kept two days, for /admin to read; they are never anyone's.
    env.DB.prepare("DELETE FROM questions WHERE via = 'canary' AND asked_at < datetime('now', '-2 days')"),
  ])
  return { passed, of: cases.length }
}

/**
 * The daily job's part: yesterday rolled up and checked, any missed day within reach too, then the canary.
 * Each step on its own, so one failing does not stop the rest.
 */
export async function dailyHealth(env: Env, models: Models, options: Options, now = new Date()): Promise<void> {
  const today = now.toISOString().slice(0, 10)
  const yesterday = daysBefore(today, 1)
  try {
    const have = new Set((await env.DB.prepare('SELECT DISTINCT day FROM pipeline_days WHERE day >= ?').bind(daysBefore(today, CATCH_UP_DAYS)).all<{ day: string }>()).results.map((row) => row.day))
    // Oldest first, so each day's baseline already holds the days before it.
    for (let n = CATCH_UP_DAYS; n >= 1; n--) {
      const day = daysBefore(today, n)
      if (day !== yesterday && have.has(day)) continue
      await rollUp(env, day)
      await checkDrift(env, day)
    }
  } catch (error) {
    console.error('health: the roll-up or the drift check failed', error)
  }
  try {
    await runCanary(env, models, options, yesterday)
  } catch (error) {
    // A canary that cannot run is itself a sign something broke (the upload, the embeddings, D1): it is flagged
    // as no case passing, so it reaches Joel like any failure, never as silence.
    console.error('health: the canary failed to run', error)
    if (env.CANARY_ENABLED !== '0') {
      await env.DB.prepare("INSERT OR REPLACE INTO pipeline_flags (day, via, metric, value, baseline, threshold) VALUES (?, 'canary', 'canary', 0, ?, ?)")
        .bind(yesterday, CANARY_CASES.length, CANARY_CASES.length).run().catch((again) => console.error('health: the canary flag could not be written', again))
    }
  }
}

/** `/internal/admin/health`: the last 30 days, their flags, and the canary's last 14 days. */
export async function healthRoute(env: Env, now = new Date()): Promise<Response> {
  const today = now.toISOString().slice(0, 10)
  const [days, flags, canary] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM pipeline_days WHERE day >= ? ORDER BY day DESC, via').bind(daysBefore(today, 30)),
    env.DB.prepare('SELECT * FROM pipeline_flags WHERE day >= ? ORDER BY day DESC, via, metric').bind(daysBefore(today, 30)),
    env.DB.prepare('SELECT day, name, passed, found, ms FROM canary_runs WHERE day >= ? ORDER BY day DESC, name').bind(daysBefore(today, 14)),
  ])
  return json(200, { days: days.results, flags: flags.results, canary: canary.results, canary_enabled: env.CANARY_ENABLED !== '0', cases: CANARY_CASES.length })
}
