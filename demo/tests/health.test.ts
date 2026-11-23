// Copyright (c) 2026 Joel Stevick
// SPDX-License-Identifier: MIT
// Licensed under the MIT License: https://opensource.org/licenses/MIT

// The demo pipeline's health (README.md, "Watching the pipeline"): the daily roll-up, the drift rules, the canary and
// the health route, in workerd against a local D1, with scripted models. Each test names the acceptance
// criterion (C) or guard (G) it covers.
import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import schema from '../schema.sql?raw'
import { createApp, type Env } from '../src/app'
import { CANARY_CASES, CANARY_PAGES } from '../src/canary'
import { chunkPage } from '../src/chunks'
import { ANSWER_CHUNKS } from '../src/models'
import { checkDrift, dailyHealth, daysBefore, driftFlags, healthRoute, percentile, rollUp, runCanary, type DayRow } from '../src/health'
import { ScriptedVectors, scriptedModels } from '../../tests/support/scripted'

let testEnv: Env
let vectors: ScriptedVectors
beforeEach(async () => {
  for (const statement of schema.replace(/--.*$/gm, '').split(';').map((s) => s.trim()).filter(Boolean)) await env.DB.prepare(statement).run()
  await env.DB.batch(['chunks', 'files', 'questions', 'archived_pages', 'demos', 'pipeline_days', 'pipeline_flags', 'canary_runs'].map((table) => env.DB.prepare(`DELETE FROM ${table}`)))
  testEnv = { DB: env.DB }
  // The demo the recorded questions below belong to.
  await env.DB.prepare("INSERT INTO demos (id, card_fingerprint) VALUES ('d1', 'fp_d1')").run()
  vectors = new ScriptedVectors()
})

const DAY = '2026-11-21'
let n = 0
/** One recorded question, as the ask writes it. */
function question(day: string, o: { via?: string | null; checked?: number; fallback?: string | null; ms?: number; first?: number | null } = {}) {
  return env.DB.prepare("INSERT INTO questions (id, demo_id, asked_at, question, answer, checked, fallback, ms, first_ms, keep, via) VALUES (?, 'd1', ?, 'q', 'a', ?, ?, ?, ?, 0, ?)")
    .bind(`q${n++}`, `${day} 12:00:00`, o.checked ?? 1, o.fallback ?? null, o.ms ?? 1000, o.first === undefined ? 400 : o.first, o.via ?? null)
}
const row = (day: string, o: Partial<DayRow> = {}): DayRow => ({ day, via: 'page', asks: 20, answered: 19, not_found: 0, refused: 1, trouble: 0, stopped: 0, ms_p50: 1000, ms_p95: 2000, first_p50: 400, ...o })
const baseline = (o: Partial<DayRow> = {}) => Array.from({ length: 14 }, (_, i) => row(daysBefore(DAY, i + 1), o))

describe('the roll-up', () => {
  it('G6 · percentiles by nearest rank: a skewed day has a low median and a high p95', () => {
    expect(percentile([100, 100, 100, 100, 100, 100, 100, 100, 100, 9000], 0.5)).toBe(100)
    expect(percentile([100, 100, 100, 100, 100, 100, 100, 100, 100, 9000], 0.95)).toBe(9000)
    expect(percentile([5], 0.95)).toBe(5)
    expect(percentile([], 0.5)).toBeNull()
  })

  it('C1 G3 · a day rolls up per via, from its own questions, without the canary', async () => {
    await env.DB.batch([
      question(DAY, { ms: 1000 }), question(DAY, { ms: 2000 }), question(DAY, { checked: 0, fallback: 'refused', ms: 3000, first: null }),
      question(DAY, { checked: 1, fallback: 'stopped', ms: 4000 }), question(DAY, { checked: 0, fallback: 'not_found', ms: 500, first: null }),
      question(DAY, { via: 'mcp', ms: 7000 }), question(DAY, { via: 'mcp', checked: 0, fallback: 'trouble', ms: 100, first: null }),
      question(DAY, { via: 'canary', checked: 0, fallback: 'refused', ms: 99999 }), question(DAY, { via: 'canary' }),
      question('2026-11-20'), question('2026-11-22'),
    ])
    await rollUp(testEnv, DAY)
    const rows = (await env.DB.prepare('SELECT * FROM pipeline_days WHERE day = ? ORDER BY via').bind(DAY).all<DayRow>()).results
    expect(rows).toEqual([
      { day: DAY, via: 'mcp', asks: 2, answered: 1, not_found: 0, refused: 0, trouble: 1, stopped: 0, ms_p50: 100, ms_p95: 7000, first_p50: 400 },
      { day: DAY, via: 'page', asks: 5, answered: 2, not_found: 1, refused: 1, trouble: 0, stopped: 1, ms_p50: 2000, ms_p95: 4000, first_p50: 400 },
    ])
    // Rolling the day up again replaces it.
    await env.DB.batch([question(DAY)])
    await rollUp(testEnv, DAY)
    expect((await env.DB.prepare("SELECT asks FROM pipeline_days WHERE day = ? AND via = 'page'").bind(DAY).first<{ asks: number }>())?.asks).toBe(6)
  })

  it('C2 · the daily job fills in a missed day within reach, and leaves a day already rolled up', async () => {
    const now = new Date('2026-11-22T04:17:00Z')
    await env.DB.batch([question('2026-11-21'), question('2026-11-18'), question('2026-11-18'), question('2026-11-10'), question('2026-11-16')])
    // 2026-11-16 was rolled up before, with a different count: it is left as it was.
    await env.DB.prepare("INSERT INTO pipeline_days (day, via, asks, answered, not_found, refused, trouble, stopped) VALUES ('2026-11-16', 'page', 99, 99, 0, 0, 0, 0)").run()
    await dailyHealth({ ...testEnv, CANARY_ENABLED: '0' }, scriptedModels(vectors), { scripted: true }, now)
    const rows = (await env.DB.prepare("SELECT day, asks FROM pipeline_days WHERE via = 'page' ORDER BY day").all<{ day: string; asks: number }>()).results
    // 2026-11-10 is 12 days back, past the 9 days within reach.
    expect(rows).toEqual([{ day: '2026-11-16', asks: 99 }, { day: '2026-11-18', asks: 2 }, { day: '2026-11-21', asks: 1 }])
  })
})

describe('drift', () => {
  it('C3 · a refused rate far above its baseline is flagged with its value, baseline and threshold', () => {
    const flags = driftFlags(row(DAY, { refused: 6 }), baseline())
    expect(flags.map((f) => f.metric)).toEqual(['refused'])
    expect(flags[0].value).toBeCloseTo(0.3)
    expect(flags[0].baseline).toBeCloseTo(0.05)
    // p + 3·sqrt(p(1-p)/n) with p = 0.05, n = 20.
    expect(flags[0].threshold).toBeCloseTo(0.05 + 3 * Math.sqrt((0.05 * 0.95) / 20))
  })

  it('C3 G2 · the same rate, a day under 10 questions, or a baseline under 30 questions is not flagged', () => {
    expect(driftFlags(row(DAY), baseline())).toEqual([])
    // 2 of 3 refused would pass the rate test; under 10 questions it is not judged.
    expect(driftFlags(row(DAY, { asks: 3, refused: 2, answered: 1 }), baseline())).toEqual([])
    expect(driftFlags(row(DAY, { refused: 6 }), baseline().slice(0, 1))).toEqual([])
    // A near-zero baseline does not flag a rise smaller than 5 points.
    expect(driftFlags(row(DAY, { asks: 100, refused: 3 }), baseline({ refused: 0 }))).toEqual([])
  })

  it('C4 · a p95 time over 1.5 times the baseline days’ median p95 is flagged', () => {
    expect(driftFlags(row(DAY, { ms_p95: 3100 }), baseline()).map((f) => [f.metric, f.value, f.baseline, f.threshold])).toEqual([['ms_p95', 3100, 2000, 3000]])
    expect(driftFlags(row(DAY, { ms_p95: 2900 }), baseline())).toEqual([])
  })

  it('G1 · the stored check compares the day with the 14 days before it', async () => {
    const days = [...baseline(), row(DAY, { refused: 6 })]
    await env.DB.batch(days.map((r) => env.DB.prepare('INSERT INTO pipeline_days (day, via, asks, answered, not_found, refused, trouble, stopped, ms_p50, ms_p95, first_p50) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(r.day, r.via, r.asks, r.answered, r.not_found, r.refused, r.trouble, r.stopped, r.ms_p50, r.ms_p95, r.first_p50)))
    await checkDrift(testEnv, DAY)
    const flags = (await env.DB.prepare('SELECT day, via, metric FROM pipeline_flags').all()).results
    expect(flags).toEqual([{ day: DAY, via: 'page', metric: 'refused' }])
    // A busy day at 15% refused against a 5% baseline is flagged; pooled with itself it would hide its own shift.
    await env.DB.prepare("UPDATE pipeline_days SET asks = 400, answered = 340, refused = 60 WHERE day = ?").bind(DAY).run()
    await checkDrift(testEnv, DAY)
    expect((await env.DB.prepare('SELECT metric, value FROM pipeline_flags').all()).results).toEqual([{ metric: 'refused', value: 0.15 }])
  })
})

describe('the canary', () => {
  it('C5 G4 · uploads its document once, asks through the real pipeline, records each answer, and flags a failure', async () => {
    const models = scriptedModels(vectors)
    const cases = [
      { name: 'right', question: 'What is the Brightwater Rentals customer policy on rentals charged by the day?', must: ['Brightwater'] },
      { name: 'wrong', question: 'What is the Brightwater Rentals customer policy on rentals charged by the day?', must: ['a word the document never says'] },
    ]
    expect(await runCanary(testEnv, models, { scripted: true }, DAY, cases)).toEqual({ passed: 1, of: 2 })
    const runs = (await env.DB.prepare('SELECT name, passed, found FROM canary_runs WHERE day = ? ORDER BY name').bind(DAY).all()).results
    expect(runs).toEqual([{ name: 'right', passed: 1, found: 1 }, { name: 'wrong', passed: 0, found: 1 }])
    expect((await env.DB.prepare("SELECT value, baseline FROM pipeline_flags WHERE via = 'canary' AND metric = 'canary'").first())).toEqual({ value: 1, baseline: 2 })
    // A second day: the document is not uploaded again, and the allowance does not run out.
    for (let i = 0; i < 6; i++) await runCanary(testEnv, models, { scripted: true }, daysBefore(DAY, -1 - i), cases)
    expect((await env.DB.prepare("SELECT files, uploads FROM demos WHERE company = 'Canary'").first())).toEqual({ files: 1, uploads: 1 })
    // Its questions are marked and are not traffic.
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM questions WHERE via = 'canary'").first<{ n: number }>())?.n).toBe(14)
    await rollUp(testEnv, new Date().toISOString().slice(0, 10))
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM pipeline_days').first<{ n: number }>())?.n).toBe(0)
  })

  it('C5 · a fully passing day leaves no canary flag, and the real cases are six with one that must fall back', async () => {
    const cases = [{ name: 'right', question: 'What is the Brightwater Rentals customer policy on rentals charged by the day?', must: ['Brightwater'] }]
    expect(await runCanary(testEnv, scriptedModels(vectors), { scripted: true }, DAY, cases)).toEqual({ passed: 1, of: 1 })
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM pipeline_flags WHERE via = 'canary'").first<{ n: number }>())?.n).toBe(0)
    expect(CANARY_CASES.length).toBe(6)
    expect(CANARY_CASES.filter((c) => c.fallback).map((c) => c.must)).toEqual([[]])
  })

  it('C6 · with CANARY_ENABLED=0 no canary question is asked, and the metrics still roll up', async () => {
    await env.DB.batch([question('2026-11-21')])
    await dailyHealth({ ...testEnv, CANARY_ENABLED: '0' }, scriptedModels(vectors), { scripted: true }, new Date('2026-11-22T04:17:00Z'))
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM questions WHERE via = 'canary'").first<{ n: number }>())?.n).toBe(0)
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM demos WHERE company = 'Canary'").first<{ n: number }>())?.n).toBe(0)
    expect((await env.DB.prepare("SELECT asks FROM pipeline_days WHERE day = '2026-11-21'").first<{ asks: number }>())?.asks).toBe(1)
  })

  it('a canary that cannot run is flagged, never silent', async () => {
    const models = scriptedModels(vectors)
    // The embeddings are fine; D1 refuses the canary's upload, so the run throws before any question.
    const broken = { ...testEnv, DB: new Proxy(env.DB, { get: (db, key) => key === 'batch' ? async () => { throw new Error('D1 is down') } : (db as any)[key].bind ? (db as any)[key].bind(db) : (db as any)[key] }) as D1Database }
    await dailyHealth({ ...broken, DB: broken.DB }, models, { scripted: true }, new Date('2026-11-22T04:17:00Z'))
    expect((await env.DB.prepare("SELECT day, value, baseline FROM pipeline_flags WHERE via = 'canary'").all()).results).toEqual([{ day: '2026-11-21', value: 0, baseline: CANARY_CASES.length }])
  })

  it('the canary’s document is longer than one answer’s passages, so retrieval and reranking are exercised', () => {
    expect(CANARY_PAGES.flatMap((page) => chunkPage(page)).length).toBeGreaterThan(ANSWER_CHUNKS)
    // Each answer is on its own page, and no other page holds it.
    for (const c of CANARY_CASES.filter((one) => !one.fallback)) expect(CANARY_PAGES.filter((page) => c.must.every((word) => page.includes(word))).length, c.name).toBe(1)
  })

  it('the canary is not in /admin’s list of demos', async () => {
    await runCanary(testEnv, scriptedModels(vectors), { scripted: true }, DAY, [{ name: 'x', question: 'deposit?', must: [] }])
    const app = createApp(() => scriptedModels(vectors), { scripted: true })
    const listed = (await (await app.fetch(new Request('https://demo/internal/admin/demos'), testEnv)).json()) as { demos: { company: string | null }[] }
    expect(listed.demos.map((d) => d.company)).not.toContain('Canary')
    expect(listed.demos.length).toBe(1)
  })

  it('the canary demo never signs anyone in and never emails Joel', async () => {
    const mail: string[] = []
    const withMailer = { ...testEnv, MAILER: { fetch: async (_u: string, init: RequestInit) => (mail.push(String(init.body)), new Response('ok')) } as unknown as Fetcher }
    await runCanary(withMailer, scriptedModels(vectors), { scripted: true }, DAY, [{ name: 'x', question: 'deposit?', must: [] }])
    expect(mail).toEqual([])
    expect((await env.DB.prepare("SELECT key_hash, contact FROM demos WHERE company = 'Canary'").first())).toEqual({ key_hash: null, contact: null })
  })
})

describe('the health route', () => {
  it('C7 · serves the days, the flags and the canary, through the Worker', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const yesterday = daysBefore(today, 1)
    await env.DB.batch([
      env.DB.prepare("INSERT INTO pipeline_days (day, via, asks, answered, not_found, refused, trouble, stopped, ms_p50, ms_p95, first_p50) VALUES (?, 'page', 12, 10, 1, 1, 0, 0, 900, 2100, 300)").bind(yesterday),
      env.DB.prepare("INSERT INTO pipeline_flags (day, via, metric, value, baseline, threshold) VALUES (?, 'page', 'refused', 0.3, 0.05, 0.2)").bind(yesterday),
      env.DB.prepare("INSERT INTO canary_runs (day, name, passed, found, ms, answer) VALUES (?, 'deposit', 1, 1, 800, 'The deposit is 200 dollars.')").bind(yesterday),
    ])
    const app = createApp(() => scriptedModels(vectors), { scripted: true })
    const body = (await (await app.fetch(new Request('https://demo/internal/admin/health'), testEnv)).json()) as any
    expect(body.days).toEqual([expect.objectContaining({ day: yesterday, via: 'page', asks: 12, ms_p95: 2100 })])
    expect(body.flags).toEqual([{ day: yesterday, via: 'page', metric: 'refused', value: 0.3, baseline: 0.05, threshold: 0.2 }])
    expect(body.canary).toEqual([{ day: yesterday, name: 'deposit', passed: 1, found: 1, ms: 800 }])
    expect(body.canary_enabled).toBe(true)
    expect(JSON.stringify(body)).not.toContain('200 dollars')
    expect((await healthRoute({ ...testEnv, CANARY_ENABLED: '0' }).then((r) => r.json()) as any).canary_enabled).toBe(false)
  })
})
