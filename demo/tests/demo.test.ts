// Copyright (c) 2026 Joel Stevick
// SPDX-License-Identifier: MIT
// Licensed under the MIT License: https://opensource.org/licenses/MIT

// The demo Worker through its HTTP routes, with scripted models and a local D1.
import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import schema from '../schema.sql?raw'
import { createApp, NOT_FOUND, type Env } from '../src/app'
import { ANSWER_MODEL, claudeFor, RERANK_MODEL, type Claude } from '../src/models'
import { WIDEN_CHARS } from '../src/widen'
import { claude as scriptedClaude, embed, ScriptedVectors, scriptedModels } from '../../tests/support/scripted'

let vectors: ScriptedVectors
let mail: string[]
let app: ReturnType<typeof createApp>
let testEnv: Env

beforeEach(async () => {
  for (const statement of schema.replace(/--.*$/gm, '').split(';').map((s) => s.trim()).filter(Boolean)) await env.DB.prepare(statement).run()
  await env.DB.batch(['chunks', 'files', 'questions', 'archived_pages', 'demos'].map((table) => env.DB.prepare(`DELETE FROM ${table}`)))
  vectors = new ScriptedVectors()
  mail = []
  app = createApp(() => scriptedModels(vectors))
  testEnv = {
    DB: env.DB,
    MAILER: { fetch: async (_url: string, init: RequestInit) => (mail.push(String(init.body)), new Response('sent')) } as unknown as Fetcher,
  }
})

async function call(path: string, key: string | null, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (key !== null) headers['X-Demo-Key'] = key
  const response = await app.fetch(new Request(`https://demo${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), testEnv)
  return { status: response.status, body: (await response.json()) as any }
}

async function newDemo(fingerprint: string): Promise<{ key: string; id: string }> {
  const { body } = await call('/internal/demos', null, { fingerprint, company: 'Acme', contact: 'Ada Lovelace <ada@acme.test>' })
  return body
}

const upload = (key: string, name: string, pages: string[]) =>
  call('/api/files', key, { name, page_count: pages.length, pages: pages.map((text, i) => ({ page: i + 1, text })) })

describe('one demo, one tenant', () => {
  it("never retrieves another demo's chunks", async () => {
    const a = await newDemo('fp_a')
    const b = await newDemo('fp_b')
    await upload(a.key, 'a.pdf', ['Our warranty covers parts for two years.'])
    await upload(b.key, 'b.pdf', ['The zorblaxian clause covers parts for two years.'])
    const asked = await call('/api/ask', a.key, { question: 'What does the zorblaxian clause cover?' })
    expect(asked.status).toBe(200)
    expect(asked.body.sources.map((s: { file: string }) => s.file)).not.toContain('b.pdf')
    expect(JSON.stringify(asked.body)).not.toContain('zorblaxian clause covers')
  })
})

describe('the purge', () => {
  it('deletes the chunks, files and vectors of a demo unused for 10 days, and keeps its key and questions', async () => {
    const idle = await newDemo('fp_old')
    const busy = await newDemo('fp_fresh')
    await upload(idle.key, 'old.pdf', ['Old text about invoices.'])
    await upload(busy.key, 'fresh.pdf', ['Fresh text about invoices.'])
    await call('/api/ask', idle.key, { question: 'What about invoices?' })
    await env.DB.prepare("UPDATE demos SET used_at = datetime('now', '-11 days'), created_at = datetime('now', '-11 days') WHERE id = ?").bind(idle.id).run()
    await env.DB.prepare("UPDATE demos SET created_at = datetime('now', '-30 days') WHERE id = ?").bind(busy.id).run()
    expect([...vectors.store.values()].filter((v) => v.namespace === idle.id)).toHaveLength(1)

    await app.scheduled({} as ScheduledController, testEnv)

    const chunks = await env.DB.prepare('SELECT COUNT(*) AS n FROM chunks WHERE demo_id = ?').bind(idle.id).first<{ n: number }>()
    expect(chunks?.n).toBe(0)
    expect([...vectors.store.values()].filter((v) => v.namespace === idle.id)).toHaveLength(0)
    const session = await call('/api/session', idle.key)
    expect(session.status).toBe(200)
    expect(session.body).toMatchObject({ files: [], left: 9, cleared: true })
    expect((await call('/api/session', busy.key)).body.files).toHaveLength(1)
    expect([...vectors.store.values()].filter((v) => v.namespace === busy.id)).toHaveLength(1)

    // Uploading again is the same demo: Joel is not told it started a second time.
    const told = mail.length
    expect((await upload(idle.key, 'old.pdf', ['Old text about invoices.'])).status).toBe(200)
    expect((await call('/api/session', idle.key)).body).toMatchObject({ files: [{ name: 'old.pdf' }], cleared: false })
    expect(mail).toHaveLength(told)
  })

  it('keeps an upload that lands after the demo was picked as idle', async () => {
    const demo = await newDemo('fp_race')
    await upload(demo.key, 'old.pdf', ['Old text about invoices.'])
    await env.DB.prepare("UPDATE demos SET used_at = datetime('now', '-11 days'), created_at = datetime('now', '-11 days') WHERE id = ?").bind(demo.id).run()
    // The job reads the idle demo, then the prospect uploads before its deletes run.
    const vectorsDelete = vectors.deleteByIds.bind(vectors)
    vectors.deleteByIds = async (ids) => {
      await vectorsDelete(ids)
      await upload(demo.key, 'new.pdf', ['New text about receipts.'])
    }
    await app.scheduled({} as ScheduledController, testEnv)
    const session = await call('/api/session', demo.key)
    expect(session.body.files.map((f: { name: string }) => f.name)).toContain('new.pdf')
    expect(session.body.cleared).toBe(false)
  })
})

describe('degrade, do not fail', () => {
  it('answers from BM25 alone when the vector index is down', async () => {
    const demo = await newDemo('fp_vec')
    await upload(demo.key, 'policy.pdf', ['Refunds are paid within 30 days of the request.'])
    vectors.failing = true
    const asked = await call('/api/ask', demo.key, { question: 'When are refunds paid?' })
    expect(asked.body.found).toBe(true)
    expect(asked.body.sources).toEqual([expect.objectContaining({ file: 'policy.pdf', page: 1 })])
  })

  it('answers when the embedding model is down', async () => {
    const demo = await newDemo('fp_embed')
    await upload(demo.key, 'policy.pdf', ['Refunds are paid within 30 days of the request.'])
    app = createApp(() => ({ ...scriptedModels(vectors), embed: async () => { throw new Error('scripted: Workers AI is down') } }))
    const asked = await call('/api/ask', demo.key, { question: 'When are refunds paid?' })
    expect(asked.body.found).toBe(true)
    expect(asked.body.sources).toHaveLength(1)
  })

  it('answers when the reranker is down', async () => {
    const demo = await newDemo('fp_rerank')
    await upload(demo.key, 'policy.pdf', ['Refunds are paid within 30 days of the request.'])
    const asked = await call('/api/ask', demo.key, { question: 'When are refunds paid? [rerank-down]' })
    expect(asked.body.found).toBe(true)
    expect(asked.body.sources).toHaveLength(1)
  })
})

describe('the cookie', () => {
  it('refuses a guessed key and a demo id sent in the request', async () => {
    const demo = await newDemo('fp_forge')
    await upload(demo.key, 'policy.pdf', ['Refunds are paid within 30 days.'])
    const guessed = await call('/api/ask', 'A'.repeat(43), { question: 'When are refunds paid?', demo_id: demo.id })
    expect(guessed.status).toBe(401)
    const byId = await call('/api/ask', demo.id, { question: 'When are refunds paid?', demo_id: demo.id })
    expect(byId.status).toBe(401)
    // The stored hash itself, sent as the key: a lookup by the raw key would take it.
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(demo.key))
    const stored = [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('')
    expect((await call('/api/ask', stored, { question: 'When are refunds paid?' })).status).toBe(401)
    const none = await call('/api/session', null)
    expect(none.status).toBe(401)
  })
})

describe('the upload limits', () => {
  it('refuses a sixth file and keeps nothing of it', async () => {
    const demo = await newDemo('fp_files')
    for (let i = 1; i <= 5; i++) expect((await upload(demo.key, `f${i}.pdf`, [`File ${i}.`])).status).toBe(200)
    const refused = await upload(demo.key, 'f6.pdf', ['The sixth file.'])
    expect(refused.status).toBe(413)
    expect(refused.body.error).toContain('at most 5 PDFs')
    const session = await call('/api/session', demo.key)
    expect(session.body.files).toHaveLength(5)
    const kept = await env.DB.prepare("SELECT COUNT(*) AS n FROM chunks WHERE file = 'f6.pdf'").first<{ n: number }>()
    expect(kept?.n).toBe(0)
  })

  it('refuses a file that would take the text past 500 KB and keeps nothing of it', async () => {
    const demo = await newDemo('fp_chars')
    const page = 'word '.repeat(30_000) // 150 KB a page
    expect((await upload(demo.key, 'big.pdf', [page, page])).status).toBe(200)
    const refused = await upload(demo.key, 'more.pdf', [page, page])
    expect(refused.status).toBe(413)
    expect(refused.body.error).toContain('500 KB')
    const kept = await env.DB.prepare("SELECT COUNT(*) AS n FROM chunks WHERE file = 'more.pdf'").first<{ n: number }>()
    expect(kept?.n).toBe(0)
    expect((await call('/api/session', demo.key)).body.files.map((f: { name: string }) => f.name)).toEqual(['big.pdf'])
  })
})

describe('two uploads of one name at once', () => {
  it('keeps the one that succeeded', async () => {
    const demo = await newDemo('fp_twice')
    const results = await Promise.all([0, 1].map(() => upload(demo.key, 'same.pdf', ['Refunds are paid within 30 days.'])))
    expect(results.map((r) => r.status).sort()).toEqual([200, 409])
    const session = await call('/api/session', demo.key)
    expect(session.body.files).toEqual([{ name: 'same.pdf', pages: 1, skipped: [] }])
    const kept = await env.DB.prepare("SELECT COUNT(*) AS n FROM chunks WHERE file = 'same.pdf'").first<{ n: number }>()
    expect(kept?.n).toBe(1)
  })
})

describe('Joel is told', () => {
  it("emails Joel once, when a demo's first upload completes", async () => {
    const demo = await newDemo('fp_mail')
    await upload(demo.key, 'first.pdf', ['One.', 'Two.'])
    await upload(demo.key, 'second.pdf', ['Three.'])
    expect(mail).toHaveLength(1)
    const sent = JSON.parse(mail[0])
    expect(sent.company).toBe('Acme')
    expect(sent.message).toContain('Files: 1, pages: 2')
  })
})

describe('the check', () => {
  it('shows the not-found line, not an answer citing an id it was not given', async () => {
    const demo = await newDemo('fp_check')
    await upload(demo.key, 'policy.pdf', ['Refunds are paid within 30 days.'])
    const asked = await call('/api/ask', demo.key, { question: 'When are refunds paid? [cite-unretrieved]' })
    expect(asked.body).toMatchObject({ answer: NOT_FOUND, sources: [], found: false })
  })
})

// Settings the eval harness chose (evals/JOURNAL.md), held here so they cannot drift back.
describe('the tuned model calls', () => {
  it('asks the reranker at low effort with room to finish, and gives the answer room to think', async () => {
    const sent: { model: string; max_tokens: number; output_config: { effort?: string } }[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      sent.push(body)
      const id = /^\[([^\]]+)\] \(/m.exec(body.messages[0].content)?.[1]
      const text = body.model === RERANK_MODEL ? '{"ranked":[0]}' : JSON.stringify({ answer: 'Refunds are paid within 30 days of the request.', sources: [id] })
      return Response.json({ content: [{ type: 'text', text }], stop_reason: 'end_turn' })
    }) as typeof fetch
    try {
      app = createApp(() => ({ claude: claudeFor('test-key'), embed, vectors }))
      const demo = await newDemo('fp_tuned')
      await upload(demo.key, 'policy.pdf', ['Refunds are paid within 30 days of the request.'])
      const asked = await call('/api/ask', demo.key, { question: 'When are refunds paid?' })
      expect(asked.body.found).toBe(true)
    } finally {
      globalThis.fetch = realFetch
    }
    const rerank = sent.find((body) => body.model === RERANK_MODEL)
    const answered = sent.find((body) => body.model === ANSWER_MODEL)
    expect(rerank).toMatchObject({ max_tokens: 1024, output_config: { effort: 'low' } })
    expect(answered?.max_tokens).toBe(2000)
    expect(answered?.output_config.effort).toBeUndefined()
  })

  it('gives the reranker 48 passages to choose from', async () => {
    const pools: number[] = []
    const counting: Claude = async (request) => {
      if (request.model === RERANK_MODEL) pools.push((request.user.match(/^\[\d+\] /gm) ?? []).length)
      return scriptedClaude(request)
    }
    app = createApp(() => ({ ...scriptedModels(vectors), claude: counting }))
    const demo = await newDemo('fp_pool')
    await upload(demo.key, 'manual.pdf', Array.from({ length: 60 }, (_, i) => `Section ${i + 1} says refunds are logged by the desk.`))
    await call('/api/ask', demo.key, { question: 'Who logs refunds?' })
    expect(pools).toEqual([48])
  })
})

// docs/plans/demo-widen.md: each chosen chunk is given with its neighbours in the same file.
describe('widening', () => {
  /** The answer model's prompt for each ask, with the scripted models and no vectors, so the pool is BM25's. */
  function capturing(): string[] {
    const prompts: string[] = []
    const answering: Claude = async (request) => {
      if (request.model === ANSWER_MODEL) prompts.push(request.user)
      return scriptedClaude(request)
    }
    app = createApp(() => ({ claude: answering }))
    return prompts
  }
  /** The passages of an answer prompt, as [id, header, text]. */
  const passagesOf = (prompt: string) =>
    [...(prompt.split('Passages:\n\n')[1] ?? '').matchAll(/^\[([^\]]+)\] \(([^\n]*)\)\n([\s\S]*?)(?=\n\n\[|$(?![\s\S]))/gm)].map(([, id, header, text]) => ({ id, header, text }))
  /** Pages sharing no word with the questions below, so only the chunks a test names are retrieved. */
  const filler = (from: number, count: number, tag = 'f') => Array.from({ length: count }, (_, i) => `Weather log ${tag}${from + i}x stays calm.`)
  const RULE = 'The zorblax rule covers every refund request.'
  const EXCEPTION = 'Except requests over 500 dollars, which need sign-off by a director.'

  it('AC1 AC5 AC6: answers with both halves of a point split across a page break, and shows the joined text', async () => {
    const prompts = capturing()
    const demo = await newDemo('fp_widen_span')
    await upload(demo.key, 'policy.pdf', [RULE, EXCEPTION, ...filler(0, 14)])
    const asked = await call('/api/ask', demo.key, { question: 'What does the zorblax rule cover? [span]' })
    expect(passagesOf(prompts[0]).map((p) => p.text)).not.toContain(EXCEPTION)
    expect(asked.body.found).toBe(true)
    expect(asked.body.answer).toContain('over 500 dollars')
    expect(asked.body.sources).toEqual([expect.objectContaining({ file: 'policy.pdf', page: 1, last_page: 2, passage: `${RULE}\n${EXCEPTION}` })])
  })

  it('AC5: still refuses a figure in no given passage or neighbour', async () => {
    capturing()
    const demo = await newDemo('fp_widen_invent')
    await upload(demo.key, 'policy.pdf', [RULE, EXCEPTION, ...filler(0, 14)])
    const asked = await call('/api/ask', demo.key, { question: 'What does the zorblax rule cost? [invent-figure]' })
    expect(asked.body).toMatchObject({ found: false, refused: 'ungrounded' })
  })

  it("AC2: keeps the reranker's order and never gives a chunk's text twice", async () => {
    const prompts = capturing()
    const demo = await newDemo('fp_widen_order')
    await upload(demo.key, 'manual.pdf', [...filler(0, 3), 'Alpha step opens the valve.', 'Bravo step closes the valve.', ...filler(3, 6), 'Charlie step drains the tank.', ...filler(9, 6)])
    await call('/api/ask', demo.key, { question: 'Which step? [pick:charlie bravo alpha]' })
    const passages = passagesOf(prompts[0])
    expect(passages.map((p) => p.text.split('\n'))).toEqual([
      ['Weather log f8x stays calm.', 'Charlie step drains the tank.', 'Weather log f9x stays calm.'],
      ['Weather log f2x stays calm.', 'Alpha step opens the valve.', 'Bravo step closes the valve.', 'Weather log f3x stays calm.'],
    ])
    const ids = (await env.DB.prepare('SELECT id, text FROM chunks WHERE demo_id = ?').bind(demo.id).all<{ id: string; text: string }>()).results
    const idOf = (text: string) => ids.find((row) => row.text === text)?.id
    expect(passages.map((p) => p.id)).toEqual([idOf('Charlie step drains the tank.'), idOf('Bravo step closes the valve.')])
    const lines = passages.flatMap((p) => p.text.split('\n'))
    expect(new Set(lines).size).toBe(lines.length)
  })

  it('AC3: takes neighbours from the same file only, and widens a first or last chunk on its one side', async () => {
    const prompts = capturing()
    const demo = await newDemo('fp_widen_files')
    await upload(demo.key, 'a.pdf', ['Zorblax opens the file.', ...filler(0, 12, 'a'), 'Quuxly closes the file.'])
    await upload(demo.key, 'b.pdf', filler(0, 16, 'b'))
    await call('/api/ask', demo.key, { question: 'Zorblax quuxly? [pick:zorblax quuxly]' })
    const passages = passagesOf(prompts[0])
    expect(passages.map((p) => p.text.split('\n'))).toEqual([
      ['Zorblax opens the file.', 'Weather log a0x stays calm.'],
      ['Weather log a11x stays calm.', 'Quuxly closes the file.'],
    ])
    expect(prompts[0]).not.toMatch(/log b\d+x/)
  })

  it('AC4: adds neighbours up to WIDEN_CHARS and always gives every chosen chunk', async () => {
    const prompts = capturing()
    const demo = await newDemo('fp_widen_budget')
    // 40 pages of 800 characters; every third holds the keyword, so the 12 chosen have 23 neighbours.
    const pages = Array.from({ length: 40 }, (_, i) => `${i % 3 === 0 ? 'Zorblax' : 'Weather'} q${i}w ${'calm '.repeat(160)}`.slice(0, 800).trim())
    await upload(demo.key, 'long.pdf', pages)
    await call('/api/ask', demo.key, { question: 'Zorblax?' })
    const sent = passagesOf(prompts[0]).flatMap((p) => p.text.split('\n'))
    const chosen = pages.filter((_, i) => i % 3 === 0).slice(0, 12)
    for (const page of chosen) expect(sent).toContain(page)
    const neighbours = sent.filter((text) => !chosen.includes(text))
    const added = neighbours.reduce((sum, text) => sum + text.length, 0)
    expect(neighbours.length).toBeGreaterThan(0)
    expect(added).toBeLessThanOrEqual(WIDEN_CHARS)
  })

  it('AC7: a demo read whole is given the same chunks in the same order, unwidened', async () => {
    const prompts = capturing()
    const demo = await newDemo('fp_widen_whole')
    await upload(demo.key, 'short.pdf', [RULE, EXCEPTION, 'Weather log w1x stays calm.'])
    await call('/api/ask', demo.key, { question: 'What does the zorblax rule cover?' })
    expect(passagesOf(prompts[0]).map((p) => [p.header, p.text])).toEqual([
      ['short.pdf, page 1', RULE],
      ['short.pdf, page 2', EXCEPTION],
      ['short.pdf, page 3', 'Weather log w1x stays calm.'],
    ])
  })

  it('AC8: a chunk stored without seq is answered exactly as before', async () => {
    const prompts = capturing()
    const demo = await newDemo('fp_widen_noseq')
    await upload(demo.key, 'old.pdf', [...filler(0, 4), RULE, EXCEPTION, ...filler(4, 10)])
    // Stored before the order was, all but one: a null read as 0 would take seq 1 as its neighbour.
    await env.DB.prepare('UPDATE chunks SET seq = NULL WHERE demo_id = ? AND seq <> 1').bind(demo.id).run()
    const asked = await call('/api/ask', demo.key, { question: 'What does the zorblax rule cover? [span]' })
    expect(passagesOf(prompts[0]).map((p) => p.text)).toEqual([RULE])
    expect(asked.body.answer).toBe(RULE)
    expect(asked.body.sources).toEqual([expect.objectContaining({ page: 5, passage: RULE })])
    expect(asked.body.sources[0].last_page).toBeUndefined()
  })

  it('is on in the deployed demo, and { widen: false } turns it off', async () => {
    const prompts: string[] = []
    const answering: Claude = async (request) => (request.model === ANSWER_MODEL && prompts.push(request.user), scriptedClaude(request))
    for (const options of [undefined, { widen: false }]) {
      app = createApp(() => ({ claude: answering }), options)
      const demo = await newDemo(`fp_widen_switch_${options === undefined ? 'on' : 'off'}`)
      await upload(demo.key, 'policy.pdf', [RULE, EXCEPTION, ...filler(0, 14)])
      await call('/api/ask', demo.key, { question: 'What does the zorblax rule cover? [span]' })
    }
    expect(prompts.map((prompt) => passagesOf(prompt)[0].text)).toEqual([`${RULE}\n${EXCEPTION}`, RULE])
  })
})

// docs/plans/admin.md: every question is recorded; with X-Demo-Keep: 1 the question and each page's
// text outlive the 10-day purge, for 25 months, and are what the golden-set export reads.
describe('kept questions and archived text', () => {
  async function send(path: string, key: string | null, body: unknown, keep: boolean) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Demo-Keep': keep ? '1' : '0' }
    if (key !== null) headers['X-Demo-Key'] = key
    const response = await app.fetch(new Request(`https://demo${path}`, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) }), testEnv)
    return { status: response.status, headers: response.headers, text: await response.text() }
  }
  const MANUAL = ['Cover page of the manual.', 'Refunds are paid within 30 days of the request.', 'Appendix with the forms.']
  const put = (key: string, keep: boolean, name = 'manual.pdf', pages = MANUAL) =>
    send('/api/files', key, { name, page_count: pages.length, pages: pages.map((text, i) => ({ page: i + 1, text })) }, keep)
  const questions = (demo: string) => env.DB.prepare('SELECT * FROM questions WHERE demo_id = ? ORDER BY asked_at, rowid').bind(demo).all<Record<string, unknown>>().then((r) => r.results)
  const archived = (demo: string) => env.DB.prepare('SELECT file, page, text FROM archived_pages WHERE demo_id = ? ORDER BY file, page').bind(demo).all().then((r) => r.results)
  const age = (demo: string) => env.DB.prepare("UPDATE demos SET used_at = datetime('now', '-11 days'), created_at = datetime('now', '-11 days') WHERE id = ?").bind(demo).run()

  it('records every ask, answered, refused or failed, and names it to the site in X-Question-Id', async () => {
    const demo = await newDemo('fp_q_all')
    expect((await put(demo.key, true)).status).toBe(200)
    const answered = await send('/api/ask', demo.key, { question: 'When are refunds paid? [pick:refunds]' }, true)
    const refused = await send('/api/ask', demo.key, { question: 'When are refunds paid? [cite-unretrieved]' }, true)
    const failed = await send('/api/ask', demo.key, { question: 'When are refunds paid? [model-down]' }, true)
    expect([answered.status, refused.status, failed.status]).toEqual([200, 200, 503])
    const rows = await questions(demo.id)
    expect(rows.map((q) => [q.answer, q.fallback, q.checked, q.keep])).toEqual([
      ['Refunds are paid within 30 days of the request.', null, 1, 1],
      ['Refunds are paid within 30 days of the request.', 'refused', 0, 1],
      [null, 'trouble', 0, 1],
    ])
    expect(JSON.parse(rows[0].sources as string)).toEqual([expect.objectContaining({ file: 'manual.pdf', page: 2, passage: 'Refunds are paid within 30 days of the request.' })])
    expect(rows.map((q) => q.id)).toEqual([answered, refused, failed].map((r) => r.headers.get('X-Question-Id')))
    expect(answered.headers.get('X-Demo-Email')).toBe('ada@acme.test')
    expect(answered.headers.get('X-Demo-Id')).toBe(demo.id)
  })

  it('archives page text only with keep, and a re-upload of the file replaces it', async () => {
    const kept = await newDemo('fp_q_kept')
    const unkept = await newDemo('fp_q_unkept')
    await put(kept.key, true)
    await put(unkept.key, false)
    expect(await archived(kept.id)).toHaveLength(3)
    expect(await archived(unkept.id)).toEqual([])
    await age(kept.id)
    await app.scheduled({} as ScheduledController, testEnv)
    expect((await put(kept.key, true, 'manual.pdf', ['A new cover.'])).status).toBe(200)
    expect(await archived(kept.id)).toEqual([{ file: 'manual.pdf', page: 1, text: 'A new cover.' }])
  })

  it('the 10-day purge deletes the questions asked without keep and leaves the kept ones and the archive', async () => {
    const demo = await newDemo('fp_q_purge')
    await put(demo.key, true)
    await send('/api/ask', demo.key, { question: 'When are refunds paid? [pick:refunds]' }, true)
    await send('/api/ask', demo.key, { question: 'What is in the appendix? [pick:appendix]' }, false)
    expect(await questions(demo.id)).toHaveLength(2)
    await age(demo.id)
    await app.scheduled({} as ScheduledController, testEnv)
    const left = await questions(demo.id)
    expect(left.map((q) => q.question)).toEqual(['When are refunds paid? [pick:refunds]'])
    expect(await archived(demo.id)).toHaveLength(3)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM chunks WHERE demo_id = ?').bind(demo.id).first<{ n: number }>())?.n).toBe(0)
  })

  it('the daily job deletes kept questions and archived text after 25 months', async () => {
    const demo = await newDemo('fp_q_expire')
    await put(demo.key, true)
    await send('/api/ask', demo.key, { question: 'When are refunds paid? [pick:refunds]' }, true)
    await env.DB.batch([
      env.DB.prepare("UPDATE questions SET asked_at = datetime('now', '-25 months', '-1 day') WHERE demo_id = ?").bind(demo.id),
      env.DB.prepare("UPDATE archived_pages SET archived_at = datetime('now', '-25 months', '-1 day') WHERE demo_id = ? AND page = 1").bind(demo.id),
    ])
    await app.scheduled({} as ScheduledController, testEnv)
    expect(await questions(demo.id)).toEqual([])
    expect((await archived(demo.id)).map((p) => (p as { page: number }).page)).toEqual([2, 3])
  })

  it('exports kept questions only, each with the cited page and its neighbours', async () => {
    const demo = await newDemo('fp_q_golden')
    await put(demo.key, true)
    await send('/api/ask', demo.key, { question: 'When are refunds paid? [pick:refunds]' }, true)
    await send('/api/ask', demo.key, { question: 'Not kept? [pick:refunds]' }, false)
    const exported = await send(`/internal/admin/golden?demo=${demo.id}`, null, undefined, false)
    const lines = exported.text.trim().split('\n').map((line) => JSON.parse(line))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ question: 'When are refunds paid? [pick:refunds]', model_answer_unverified: 'Refunds are paid within 30 days of the request.', sources: [{ file: 'manual.pdf', page: 2 }] })
    expect(lines[0].pages.map((p: { page: number }) => p.page)).toEqual([1, 2, 3])
  })
})

describe('removing a file', () => {
  async function kept(path: string, key: string, body: unknown, method = 'POST') {
    const headers = { 'Content-Type': 'application/json', 'X-Demo-Keep': '1', 'X-Demo-Key': key }
    const response = await app.fetch(new Request(`https://demo${path}`, { method, headers, body: JSON.stringify(body) }), testEnv)
    return { status: response.status, body: (await response.json()) as any }
  }
  const put = (key: string, name: string, pages: string[]) => kept('/api/files', key, { name, page_count: pages.length, pages: pages.map((text, i) => ({ page: i + 1, text })) })
  const remove = (key: string, name: string) => kept('/api/files', key, { name }, 'DELETE')
  const count = async (table: string, demo: string, file?: string) =>
    (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE demo_id = ?${file === undefined ? '' : ' AND file = ?'}`).bind(demo, ...(file === undefined ? [] : [file])).first<{ n: number }>())!.n
  const room = (demo: string) => env.DB.prepare('SELECT files, pages, chars FROM demos WHERE id = ?').bind(demo).first<{ files: number; pages: number; chars: number }>()

  it("AC4: deletes the file's vectors, chunks, row and archived pages, and leaves the other file and the questions asked", async () => {
    const demo = await newDemo('fp_remove')
    await put(demo.key, 'acme.pdf', ['Engineer at Acme, 2010 to 2015.', 'Acme made widgets.'])
    await put(demo.key, 'globex.pdf', ['Designer at Globex, 2016 to 2020.'])
    expect((await kept('/api/ask', demo.key, { question: 'What role did he hold at Acme?' })).body.answer).toBe('He was Engineer at Acme from 2010 to 2015.')
    expect(await room(demo.id)).toMatchObject({ files: 2, pages: 3 })
    const chunkFiles = new Map((await env.DB.prepare('SELECT id, file FROM chunks WHERE demo_id = ?').bind(demo.id).all<{ id: string; file: string }>()).results.map((c) => [c.id, c.file]))
    const vectorsOf = (file: string) => [...vectors.store.keys()].filter((id) => chunkFiles.get(id) === file)
    expect(vectorsOf('acme.pdf')).toHaveLength(2)

    const removed = await remove(demo.key, 'acme.pdf')
    expect(removed.status).toBe(200)
    expect(removed.body).toEqual({ name: 'acme.pdf', left: 9 })
    expect(vectorsOf('acme.pdf')).toEqual([])
    expect(vectorsOf('globex.pdf')).toHaveLength(1)
    expect(await count('chunks', demo.id, 'acme.pdf')).toBe(0)
    expect(await count('chunks', demo.id, 'globex.pdf')).toBe(1)
    expect(await count('archived_pages', demo.id, 'acme.pdf')).toBe(0)
    expect(await count('archived_pages', demo.id, 'globex.pdf')).toBe(1)
    expect(await count('questions', demo.id)).toBe(1)
    const session = await call('/api/session', demo.key)
    expect(session.body.files.map((f: { name: string }) => f.name)).toEqual(['globex.pdf'])
    expect(session.body.left).toBe(9)
    // Its pages and text are given back: the room is what globex.pdf alone took.
    expect(await room(demo.id)).toEqual({ files: 1, pages: 1, chars: 'Designer at Globex, 2016 to 2020.'.length })
    expect((await kept('/api/ask', demo.key, { question: 'What role did he hold at Acme?' })).body.answer).toBe(NOT_FOUND)
    expect((await kept('/api/ask', demo.key, { question: 'What role did he hold at Globex?' })).body.answer).toBe('He was Designer at Globex from 2016 to 2020.')
  })

  it('AC5: a demo that removes its only file and uploads another emails Joel once in all', async () => {
    const demo = await newDemo('fp_remove_mail')
    await put(demo.key, 'first.pdf', ['One.'])
    expect(mail).toHaveLength(1)
    expect((await remove(demo.key, 'first.pdf')).status).toBe(200)
    expect((await put(demo.key, 'second.pdf', ['Two.'])).status).toBe(200)
    expect(mail).toHaveLength(1)
  })

  it('guard 6: two removes of one file at once give its pages back once', async () => {
    const demo = await newDemo('fp_remove_race')
    await put(demo.key, 'a.pdf', ['One.', 'Two.'])
    await put(demo.key, 'b.pdf', ['Three.'])
    // The second remove runs while the first is between its read of the file and its deletes.
    const vectorsDelete = vectors.deleteByIds.bind(vectors)
    let second: Promise<unknown> | null = null
    vectors.deleteByIds = async (ids) => {
      await vectorsDelete(ids)
      if (second === null) {
        second = remove(demo.key, 'a.pdf')
        await second
      }
    }
    expect((await remove(demo.key, 'a.pdf')).status).toBe(200)
    expect(await room(demo.id)).toEqual({ files: 1, pages: 1, chars: 'Three.'.length })
    expect(await count('chunks', demo.id, 'b.pdf')).toBe(1)
  })

  it('fix 1: a first upload whose chunks could not be stored is not counted, so the retry emails Joel', async () => {
    const demo = await newDemo('fp_remove_retry')
    // The first batch (the chunk store) fails once; the rollback and everything after it work.
    const db = testEnv.DB
    let failed = false
    testEnv.DB = new Proxy(db, {
      get(target, property) {
        if (property === 'batch' && !failed) {
          failed = true
          return () => { throw new Error('scripted: D1 is down') }
        }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    expect((await put(demo.key, 'first.pdf', ['One.'])).status).toBe(500)
    expect(mail).toHaveLength(0)
    expect(await room(demo.id)).toEqual({ files: 0, pages: 0, chars: 0 })
    expect((await put(demo.key, 'first.pdf', ['One.'])).status).toBe(200)
    expect(mail).toHaveLength(1)
  })

  it('fix 2: a demo that removed its every file still loses its unconsented questions after 10 days, without being told its documents were deleted', async () => {
    const removed = await newDemo('fp_remove_purge')
    const kept = await newDemo('fp_remove_purge_other')
    for (const demo of [removed, kept]) {
      await upload(demo.key, 'a.pdf', ['Refunds are paid within 30 days of the request.'])
      expect((await call('/api/ask', demo.key, { question: 'When are refunds paid?' })).status).toBe(200)
    }
    expect((await remove(removed.key, 'a.pdf')).status).toBe(200)
    for (const demo of [removed, kept]) await env.DB.prepare("UPDATE demos SET used_at = datetime('now', '-11 days') WHERE id = ?").bind(demo.id).run()
    await app.scheduled({} as ScheduledController, testEnv)
    expect(await count('questions', removed.id)).toBe(0)
    expect(await count('questions', kept.id)).toBe(0)
    expect((await call('/api/session', removed.key)).body).toMatchObject({ files: [], left: 9, cleared: false })
    expect((await call('/api/session', kept.key)).body).toMatchObject({ files: [], left: 9, cleared: true })
  })

  it('refuses a file the demo does not have, and changes nothing', async () => {
    const demo = await newDemo('fp_remove_404')
    await put(demo.key, 'a.pdf', ['One.'])
    expect((await remove(demo.key, 'other.pdf')).status).toBe(404)
    expect((await remove(demo.key, '')).status).toBe(404)
    expect(await room(demo.id)).toEqual({ files: 1, pages: 1, chars: 4 })
    expect((await call('/api/session', demo.key)).body.files).toHaveLength(1)
  })
})
