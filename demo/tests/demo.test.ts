// Copyright (c) 2026 Joel Stevick
// SPDX-License-Identifier: MIT
// Licensed under the MIT License: https://opensource.org/licenses/MIT

// The demo Worker through its HTTP routes, with scripted models and a local D1.
import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import schema from '../schema.sql?raw'
import { idsIn, units, unmarked } from '../src/check'
import { createApp, NOT_FOUND, type Env } from '../src/app'
import { ANSWER_MODEL, claudeFor, claudeStreamFor, RERANK_MODEL, type Claude, type ClaudeStream } from '../src/models'
import { WIDEN_CHARS } from '../src/widen'
import { claude as scriptedClaude, embed, ScriptedVectors, scriptedModels, stream as scriptedStream } from '../../tests/support/scripted'

let vectors: ScriptedVectors
let mail: string[]
let app: ReturnType<typeof createApp>
let testEnv: Env

beforeEach(async () => {
  // Create the tables, then empty them, so each test starts clean.
  for (const statement of schema.replace(/--.*$/gm, '').split(';').map((s) => s.trim()).filter(Boolean)) await env.DB.prepare(statement).run()
  await env.DB.batch(['chunks', 'files', 'questions', 'archived_pages', 'demos'].map((table) => env.DB.prepare(`DELETE FROM ${table}`)))

  // Fresh scripted models and an empty mailbox for each test.
  vectors = new ScriptedVectors()
  mail = []
  app = createApp(() => scriptedModels(vectors))

  // The Worker's bindings: the local D1 and a mailer that keeps what it is sent.
  testEnv = {
    DB: env.DB,
    MAILER: { fetch: async (_url: string, init: RequestInit) => (mail.push(String(init.body)), new Response('sent')) } as unknown as Fetcher,
  }
})

// Calls one of the demo's routes, with the demo key or without one, and reads the JSON reply.
async function call(path: string, key: string | null, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (key !== null) headers['X-Demo-Key'] = key
  const response = await app.fetch(new Request(`https://demo${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), testEnv)
  return { status: response.status, body: (await response.json()) as any }
}

// Creates a demo the way the site does at sign-up, and returns its key and id.
async function newDemo(fingerprint: string): Promise<{ key: string; id: string }> {
  const { body } = await call('/internal/demos', null, { fingerprint, company: 'Acme', contact: 'Ada Lovelace <ada@acme.test>' })
  return body
}

// Uploads a file's page texts, as the demo page sends them after reading a PDF.
const upload = (key: string, name: string, pages: string[]) =>
  call('/api/files', key, { name, page_count: pages.length, pages: pages.map((text, i) => ({ page: i + 1, text })) })

describe('one demo, one tenant', () => {
  it("never retrieves another demo's chunks", async () => {
    // Two demos, each with its own file; only b's mentions the zorblaxian clause.
    const a = await newDemo('fp_a')
    const b = await newDemo('fp_b')
    await upload(a.key, 'a.pdf', ['Our warranty covers parts for two years.'])
    await upload(b.key, 'b.pdf', ['The zorblaxian clause covers parts for two years.'])

    // Ask a's demo about b's words.
    const asked = await call('/api/ask', a.key, { question: 'What does the zorblaxian clause cover?' })

    // Nothing of b's file comes back.
    expect(asked.status).toBe(200)
    expect(asked.body.sources.map((s: { file: string }) => s.file)).not.toContain('b.pdf')
    expect(JSON.stringify(asked.body)).not.toContain('zorblaxian clause covers')
  })
})

describe('the purge', () => {
  it('deletes the chunks, files and vectors of a demo unused for 10 days, and keeps its key and questions', async () => {
    // Two demos, each with a file; the idle one also asks a question.
    const idle = await newDemo('fp_old')
    const busy = await newDemo('fp_fresh')
    await upload(idle.key, 'old.pdf', ['Old text about invoices.'])
    await upload(busy.key, 'fresh.pdf', ['Fresh text about invoices.'])
    await call('/api/ask', idle.key, { question: 'What about invoices?' })

    // Date the idle demo's last use 11 days back; the busy one is old but still in use.
    await env.DB.prepare("UPDATE demos SET used_at = datetime('now', '-11 days'), created_at = datetime('now', '-11 days') WHERE id = ?").bind(idle.id).run()
    await env.DB.prepare("UPDATE demos SET created_at = datetime('now', '-30 days') WHERE id = ?").bind(busy.id).run()

    // The idle demo's vector is there before the purge.
    expect([...vectors.store.values()].filter((v) => v.namespace === idle.id)).toHaveLength(1)

    // Run the daily job.
    await app.scheduled({} as ScheduledController, testEnv)

    // The idle demo's chunks and vectors are gone.
    const chunks = await env.DB.prepare('SELECT COUNT(*) AS n FROM chunks WHERE demo_id = ?').bind(idle.id).first<{ n: number }>()
    expect(chunks?.n).toBe(0)
    expect([...vectors.store.values()].filter((v) => v.namespace === idle.id)).toHaveLength(0)

    // Its key still works: no files, its questions left, and a note that it was cleared.
    const session = await call('/api/session', idle.key)
    expect(session.status).toBe(200)
    expect(session.body).toMatchObject({ files: [], left: 9, cleared: true })

    // The busy demo keeps its file and its vector.
    expect((await call('/api/session', busy.key)).body.files).toHaveLength(1)
    expect([...vectors.store.values()].filter((v) => v.namespace === busy.id)).toHaveLength(1)

    // Uploading again is the same demo: Joel is not told it started a second time.
    const told = mail.length
    expect((await upload(idle.key, 'old.pdf', ['Old text about invoices.'])).status).toBe(200)
    expect((await call('/api/session', idle.key)).body).toMatchObject({ files: [{ name: 'old.pdf' }], cleared: false })
    expect(mail).toHaveLength(told)
  })

  it('keeps an upload that lands after the demo was picked as idle', async () => {
    // A demo with a file, last used 11 days ago.
    const demo = await newDemo('fp_race')
    await upload(demo.key, 'old.pdf', ['Old text about invoices.'])
    await env.DB.prepare("UPDATE demos SET used_at = datetime('now', '-11 days'), created_at = datetime('now', '-11 days') WHERE id = ?").bind(demo.id).run()

    // The job reads the idle demo, then the prospect uploads before its deletes run.
    const vectorsDelete = vectors.deleteByIds.bind(vectors)
    vectors.deleteByIds = async (ids) => {
      await vectorsDelete(ids)
      await upload(demo.key, 'new.pdf', ['New text about receipts.'])
    }

    // Run the daily job, then check the late upload survived.
    await app.scheduled({} as ScheduledController, testEnv)
    const session = await call('/api/session', demo.key)
    expect(session.body.files.map((f: { name: string }) => f.name)).toContain('new.pdf')
    expect(session.body.cleared).toBe(false)
  })
})

describe('degrade, do not fail', () => {
  it('answers from BM25 alone when the vector index is down', async () => {
    // A demo with one short policy file.
    const demo = await newDemo('fp_vec')
    await upload(demo.key, 'policy.pdf', ['Refunds are paid within 30 days of the request.'])

    // The vector index goes down.
    vectors.failing = true

    // The ask still finds the answer and cites the page.
    const asked = await call('/api/ask', demo.key, { question: 'When are refunds paid?' })
    expect(asked.body.found).toBe(true)
    expect(asked.body.sources).toEqual([expect.objectContaining({ file: 'policy.pdf', page: 1 })])
  })

  it('answers when the embedding model is down', async () => {
    // A demo with one short policy file.
    const demo = await newDemo('fp_embed')
    await upload(demo.key, 'policy.pdf', ['Refunds are paid within 30 days of the request.'])

    // An app whose embedding call always throws.
    app = createApp(() => ({ ...scriptedModels(vectors), embed: async () => { throw new Error('scripted: Workers AI is down') } }))

    // The ask still finds the answer from keyword search.
    const asked = await call('/api/ask', demo.key, { question: 'When are refunds paid?' })
    expect(asked.body.found).toBe(true)
    expect(asked.body.sources).toHaveLength(1)
  })

  it('answers when the reranker is down', async () => {
    // A demo with one short policy file.
    const demo = await newDemo('fp_rerank')
    await upload(demo.key, 'policy.pdf', ['Refunds are paid within 30 days of the request.'])

    // The [rerank-down] marker makes the reranker throw; the answer still comes.
    const asked = await call('/api/ask', demo.key, { question: 'When are refunds paid? [rerank-down]' })
    expect(asked.body.found).toBe(true)
    expect(asked.body.sources).toHaveLength(1)
  })
})

describe('the cookie', () => {
  it('refuses a guessed key and a demo id sent in the request', async () => {
    // A demo with a file to protect.
    const demo = await newDemo('fp_forge')
    await upload(demo.key, 'policy.pdf', ['Refunds are paid within 30 days.'])

    // A made-up key, and the demo's id used as the key, are both refused.
    const guessed = await call('/api/ask', 'A'.repeat(43), { question: 'When are refunds paid?', demo_id: demo.id })
    expect(guessed.status).toBe(401)
    const byId = await call('/api/ask', demo.id, { question: 'When are refunds paid?', demo_id: demo.id })
    expect(byId.status).toBe(401)

    // The stored hash itself, sent as the key: a lookup by the raw key would take it.
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(demo.key))
    const stored = [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('')
    expect((await call('/api/ask', stored, { question: 'When are refunds paid?' })).status).toBe(401)

    // No key at all is refused too.
    const none = await call('/api/session', null)
    expect(none.status).toBe(401)
  })
})

describe('the upload limits', () => {
  it('refuses a sixth file and keeps nothing of it', async () => {
    // Five files fill the demo.
    const demo = await newDemo('fp_files')
    for (let i = 1; i <= 5; i++) expect((await upload(demo.key, `f${i}.pdf`, [`File ${i}.`])).status).toBe(200)

    // The sixth is refused, with the reason.
    const refused = await upload(demo.key, 'f6.pdf', ['The sixth file.'])
    expect(refused.status).toBe(413)
    expect(refused.body.error).toContain('at most 5 PDFs')

    // Only five files remain, and none of the sixth's chunks were stored.
    const session = await call('/api/session', demo.key)
    expect(session.body.files).toHaveLength(5)
    const kept = await env.DB.prepare("SELECT COUNT(*) AS n FROM chunks WHERE file = 'f6.pdf'").first<{ n: number }>()
    expect(kept?.n).toBe(0)
  })

  it('refuses a file that would take the text past 500 KB and keeps nothing of it', async () => {
    const demo = await newDemo('fp_chars')
    const page = 'word '.repeat(30_000) // 150 KB a page

    // The first file fits under the limit.
    expect((await upload(demo.key, 'big.pdf', [page, page])).status).toBe(200)

    // A second of the same size would pass 500 KB, so it is refused.
    const refused = await upload(demo.key, 'more.pdf', [page, page])
    expect(refused.status).toBe(413)
    expect(refused.body.error).toContain('500 KB')

    // None of it was stored, and only the first file is listed.
    const kept = await env.DB.prepare("SELECT COUNT(*) AS n FROM chunks WHERE file = 'more.pdf'").first<{ n: number }>()
    expect(kept?.n).toBe(0)
    expect((await call('/api/session', demo.key)).body.files.map((f: { name: string }) => f.name)).toEqual(['big.pdf'])
  })
})

describe('two uploads of one name at once', () => {
  it('keeps the one that succeeded', async () => {
    const demo = await newDemo('fp_twice')
    // Upload the same file name twice at the same moment.
    const results = await Promise.all([0, 1].map(() => upload(demo.key, 'same.pdf', ['Refunds are paid within 30 days.'])))
    // One wins and the other gets a conflict.
    expect(results.map((r) => r.status).sort()).toEqual([200, 409])

    // Only one copy of the file and its chunk is kept.
    const session = await call('/api/session', demo.key)
    expect(session.body.files).toEqual([{ name: 'same.pdf', pages: 1, skipped: [] }])
    const kept = await env.DB.prepare("SELECT COUNT(*) AS n FROM chunks WHERE file = 'same.pdf'").first<{ n: number }>()
    expect(kept?.n).toBe(1)
  })
})

describe('Joel is told', () => {
  it("emails Joel once, when a demo's first upload completes", async () => {
    // Two uploads to the same demo.
    const demo = await newDemo('fp_mail')
    await upload(demo.key, 'first.pdf', ['One.', 'Two.'])
    await upload(demo.key, 'second.pdf', ['Three.'])

    // Only the first sent an email, with the company and the counts.
    expect(mail).toHaveLength(1)
    const sent = JSON.parse(mail[0])
    expect(sent.company).toBe('Acme')
    expect(sent.message).toContain('Files: 1, pages: 2')
  })
})

describe('the check', () => {
  it('shows the not-found line, not an answer citing an id it was not given', async () => {
    // A demo with one file.
    const demo = await newDemo('fp_check')
    await upload(demo.key, 'policy.pdf', ['Refunds are paid within 30 days.'])

    // The marker makes the answer cite an id it was never given.
    const asked = await call('/api/ask', demo.key, { question: 'When are refunds paid? [cite-unretrieved]' })
    expect(asked.body).toMatchObject({ answer: NOT_FOUND, sources: [], found: false })
  })
})

// Settings the eval harness chose (evals/JOURNAL.md), held here so they cannot drift back.
describe('the tuned model calls', () => {
  it('asks the reranker at low effort with room to finish, and gives the answer room to think', async () => {
    // Every request body sent to Anthropic, kept to check its settings.
    const sent: { model: string; max_tokens: number; stream?: boolean; output_config?: { effort?: string } }[] = []

    // Stand in for Anthropic's API: the reranker gets JSON, the answer a short stream.
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      sent.push(body)
      const id = /^\[([^\]]+)\] \(/m.exec(body.messages[0].content)?.[1]
      if (body.model === RERANK_MODEL) return Response.json({ content: [{ type: 'text', text: '{"ranked":[0]}' }], stop_reason: 'end_turn' })
      const delta = { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `Refunds are paid within 30 days of the request [${id}].` } }
      return new Response(`event: content_block_delta\ndata: ${JSON.stringify(delta)}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
    }) as typeof fetch

    // Ask once through the real model clients, then put fetch back.
    try {
      app = createApp(() => ({ claude: claudeFor('test-key'), stream: claudeStreamFor('test-key'), embed, vectors }))
      const demo = await newDemo('fp_tuned')
      await upload(demo.key, 'policy.pdf', ['Refunds are paid within 30 days of the request.'])
      const asked = await call('/api/ask', demo.key, { question: 'When are refunds paid?' })
      expect(asked.body.found).toBe(true)
    } finally {
      globalThis.fetch = realFetch
    }

    // The reranker ran at low effort with 1024 tokens; the answer streamed with 2000 and no effort set.
    const rerank = sent.find((body) => body.model === RERANK_MODEL)
    const answered = sent.find((body) => body.model === ANSWER_MODEL)
    expect(rerank).toMatchObject({ max_tokens: 1024, output_config: { effort: 'low' } })
    expect(answered?.max_tokens).toBe(2000)
    expect(answered?.stream).toBe(true)
    expect(answered?.output_config?.effort).toBeUndefined()
  })

  it('gives the reranker 48 passages to choose from', async () => {
    // The pool size of each rerank call.
    const pools: number[] = []
    const counting: Claude = async (request) => {
      if (request.model === RERANK_MODEL) pools.push((request.user.match(/^\[\d+\] /gm) ?? []).length)
      return scriptedClaude(request)
    }

    // Use the counting model, upload 60 sections and ask once.
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
    const answering: ClaudeStream = (request) => {
      if (request.model === ANSWER_MODEL) prompts.push(request.user)
      return scriptedStream(request)
    }
    app = createApp(() => ({ claude: scriptedClaude, stream: answering }))
    return prompts
  }

  /** The passages of an answer prompt, as [id, header, text]. */
  const passagesOf = (prompt: string) =>
    [...(prompt.split('Passages:\n\n')[1] ?? '').matchAll(/^\[([^\]]+)\] \(([^\n]*)\)\n([\s\S]*?)(?=\n\n\[|$(?![\s\S]))/gm)].map(([, id, header, text]) => ({ id, header, text }))

  /** Pages sharing no word with the questions below, so only the chunks a test names are retrieved. */
  const filler = (from: number, count: number, tag = 'f') => Array.from({ length: count }, (_, i) => `Weather log ${tag}${from + i}x stays calm.`)

  // A rule and its exception, split across two pages.
  const RULE = 'The zorblax rule covers every refund request.'
  const EXCEPTION = 'Except requests over 500 dollars, which need sign-off by a director.'

  it('AC1 AC5 AC6: answers with both halves of a point split across a page break, and shows the joined text', async () => {
    // Capture the prompts, and upload the rule and exception on pages 1 and 2 among filler.
    const prompts = capturing()
    const demo = await newDemo('fp_widen_span')
    await upload(demo.key, 'policy.pdf', [RULE, EXCEPTION, ...filler(0, 14)])

    // Ask with [span], so the answer is the whole of its first passage.
    const asked = await call('/api/ask', demo.key, { question: 'What does the zorblax rule cover? [span]' })

    // The exception was not chosen on its own, yet the answer and its source include it.
    expect(passagesOf(prompts[0]).map((p) => p.text)).not.toContain(EXCEPTION)
    expect(asked.body.found).toBe(true)
    expect(asked.body.answer).toContain('over 500 dollars')
    expect(asked.body.sources).toEqual([expect.objectContaining({ file: 'policy.pdf', page: 1, last_page: 2, passage: `${RULE}\n${EXCEPTION}` })])
  })

  it('AC5: still refuses a figure in no given passage or neighbour', async () => {
    // The rule and exception again, among filler.
    capturing()
    const demo = await newDemo('fp_widen_invent')
    await upload(demo.key, 'policy.pdf', [RULE, EXCEPTION, ...filler(0, 14)])

    // The answer states a figure no passage holds, so it is refused.
    const asked = await call('/api/ask', demo.key, { question: 'What does the zorblax rule cost? [invent-figure]' })
    expect(asked.body).toMatchObject({ found: false, refused: 'ungrounded' })
  })

  it("AC2: keeps the reranker's order and never gives a chunk's text twice", async () => {
    // Three steps: alpha and bravo side by side, charlie apart from them.
    const prompts = capturing()
    const demo = await newDemo('fp_widen_order')
    await upload(demo.key, 'manual.pdf', [...filler(0, 3), 'Alpha step opens the valve.', 'Bravo step closes the valve.', ...filler(3, 6), 'Charlie step drains the tank.', ...filler(9, 6)])

    // The reranker picks charlie, then bravo, then alpha.
    await call('/api/ask', demo.key, { question: 'Which step? [pick:charlie bravo alpha]' })

    // Charlie comes first; alpha and bravo share one widened passage.
    const passages = passagesOf(prompts[0])
    expect(passages.map((p) => p.text.split('\n'))).toEqual([
      ['Weather log f8x stays calm.', 'Charlie step drains the tank.', 'Weather log f9x stays calm.'],
      ['Weather log f2x stays calm.', 'Alpha step opens the valve.', 'Bravo step closes the valve.', 'Weather log f3x stays calm.'],
    ])

    // The passage ids are the chosen chunks', in the reranker's order.
    const ids = (await env.DB.prepare('SELECT id, text FROM chunks WHERE demo_id = ?').bind(demo.id).all<{ id: string; text: string }>()).results
    const idOf = (text: string) => ids.find((row) => row.text === text)?.id
    expect(passages.map((p) => p.id)).toEqual([idOf('Charlie step drains the tank.'), idOf('Bravo step closes the valve.')])

    // No line of text appears twice.
    const lines = passages.flatMap((p) => p.text.split('\n'))
    expect(new Set(lines).size).toBe(lines.length)
  })

  it('AC3: takes neighbours from the same file only, and widens a first or last chunk on its one side', async () => {
    // Two files: a.pdf with a keyword chunk at each end, b.pdf only filler.
    const prompts = capturing()
    const demo = await newDemo('fp_widen_files')
    await upload(demo.key, 'a.pdf', ['Zorblax opens the file.', ...filler(0, 12, 'a'), 'Quuxly closes the file.'])
    await upload(demo.key, 'b.pdf', filler(0, 16, 'b'))

    // Pick both keyword chunks.
    await call('/api/ask', demo.key, { question: 'Zorblax quuxly? [pick:zorblax quuxly]' })

    // Each is widened on its one inner side, and nothing comes from b.pdf.
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

    // Upload it and ask for the keyword.
    await upload(demo.key, 'long.pdf', pages)
    await call('/api/ask', demo.key, { question: 'Zorblax?' })

    // Every chosen page is sent.
    const sent = passagesOf(prompts[0]).flatMap((p) => p.text.split('\n'))
    const chosen = pages.filter((_, i) => i % 3 === 0).slice(0, 12)
    for (const page of chosen) expect(sent).toContain(page)

    // Some neighbours were added, but no more text than WIDEN_CHARS.
    const neighbours = sent.filter((text) => !chosen.includes(text))
    const added = neighbours.reduce((sum, text) => sum + text.length, 0)
    expect(neighbours.length).toBeGreaterThan(0)
    expect(added).toBeLessThanOrEqual(WIDEN_CHARS)
  })

  it('AC7: a demo read whole is given the same chunks in the same order, unwidened', async () => {
    // A file short enough to send whole.
    const prompts = capturing()
    const demo = await newDemo('fp_widen_whole')
    await upload(demo.key, 'short.pdf', [RULE, EXCEPTION, 'Weather log w1x stays calm.'])

    // All three pages come in page order, each on its own.
    await call('/api/ask', demo.key, { question: 'What does the zorblax rule cover?' })
    expect(passagesOf(prompts[0]).map((p) => [p.header, p.text])).toEqual([
      ['short.pdf, page 1', RULE],
      ['short.pdf, page 2', EXCEPTION],
      ['short.pdf, page 3', 'Weather log w1x stays calm.'],
    ])
  })

  it('AC8: a chunk stored without seq is answered exactly as before', async () => {
    // The rule and exception among filler.
    const prompts = capturing()
    const demo = await newDemo('fp_widen_noseq')
    await upload(demo.key, 'old.pdf', [...filler(0, 4), RULE, EXCEPTION, ...filler(4, 10)])

    // Stored before the order was, all but one: a null read as 0 would take seq 1 as its neighbour.
    await env.DB.prepare('UPDATE chunks SET seq = NULL WHERE demo_id = ? AND seq <> 1').bind(demo.id).run()

    // Ask with [span]: only the rule's own chunk comes, with no last page.
    const asked = await call('/api/ask', demo.key, { question: 'What does the zorblax rule cover? [span]' })
    expect(passagesOf(prompts[0]).map((p) => p.text)).toEqual([RULE])
    expect(asked.body.answer).toBe(RULE)
    expect(asked.body.sources).toEqual([expect.objectContaining({ page: 5, passage: RULE })])
    expect(asked.body.sources[0].last_page).toBeUndefined()
  })

  it('is on in the deployed demo, and { widen: false } turns it off', async () => {
    // Keep every answer prompt.
    const prompts: string[] = []
    const answering: ClaudeStream = (request) => (request.model === ANSWER_MODEL && prompts.push(request.user), scriptedStream(request))

    // Ask the same question with widening on, then off.
    for (const options of [undefined, { widen: false }]) {
      app = createApp(() => ({ claude: scriptedClaude, stream: answering }), options)
      const demo = await newDemo(`fp_widen_switch_${options === undefined ? 'on' : 'off'}`)
      await upload(demo.key, 'policy.pdf', [RULE, EXCEPTION, ...filler(0, 14)])
      await call('/api/ask', demo.key, { question: 'What does the zorblax rule cover? [span]' })
    }

    // On, the passage includes the exception; off, the rule alone.
    expect(prompts.map((prompt) => passagesOf(prompt)[0].text)).toEqual([`${RULE}\n${EXCEPTION}`, RULE])
  })
})

// docs/plans/admin.md: every question is recorded; with X-Demo-Keep: 1 the question and each page's
// text outlive the 10-day purge, for 25 months, and are what the golden-set export reads.
describe('kept questions and archived text', () => {
  // Like call, but sets X-Demo-Keep and returns the raw text and headers.
  async function send(path: string, key: string | null, body: unknown, keep: boolean) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Demo-Keep': keep ? '1' : '0' }
    if (key !== null) headers['X-Demo-Key'] = key
    const response = await app.fetch(new Request(`https://demo${path}`, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) }), testEnv)
    return { status: response.status, headers: response.headers, text: await response.text() }
  }

  // A three-page manual; only page 2 answers the refund question.
  const MANUAL = ['Cover page of the manual.', 'Refunds are paid within 30 days of the request.', 'Appendix with the forms.']
  // Uploads the manual (or other pages), with or without keep.
  const put = (key: string, keep: boolean, name = 'manual.pdf', pages = MANUAL) =>
    send('/api/files', key, { name, page_count: pages.length, pages: pages.map((text, i) => ({ page: i + 1, text })) }, keep)
  // The demo's recorded questions, oldest first.
  const questions = (demo: string) => env.DB.prepare('SELECT * FROM questions WHERE demo_id = ? ORDER BY asked_at, rowid').bind(demo).all<Record<string, unknown>>().then((r) => r.results)
  // The demo's archived page texts.
  const archived = (demo: string) => env.DB.prepare('SELECT file, page, text FROM archived_pages WHERE demo_id = ? ORDER BY file, page').bind(demo).all().then((r) => r.results)
  // Dates the demo's last use 11 days back, so the daily job purges it.
  const age = (demo: string) => env.DB.prepare("UPDATE demos SET used_at = datetime('now', '-11 days'), created_at = datetime('now', '-11 days') WHERE id = ?").bind(demo).run()

  it('records every ask, answered, refused or failed, and names it to the site in X-Question-Id', async () => {
    // A demo with the manual uploaded and kept.
    const demo = await newDemo('fp_q_all')
    expect((await put(demo.key, true)).status).toBe(200)

    // Three asks: one answered, one refused for a bad citation, one with the model down.
    const answered = await send('/api/ask', demo.key, { question: 'When are refunds paid? [pick:refunds]' }, true)
    const refused = await send('/api/ask', demo.key, { question: 'When are refunds paid? [cite-unretrieved]' }, true)
    const failed = await send('/api/ask', demo.key, { question: 'When are refunds paid? [model-down]' }, true)

    // The model being down is a 503; the other two are 200.
    expect([answered.status, refused.status, failed.status]).toEqual([200, 200, 503])

    // Each ask is recorded with its answer, fallback, check result and keep flag.
    const rows = await questions(demo.id)
    expect(rows.map((q) => [q.answer, q.fallback, q.checked, q.keep])).toEqual([
      ['Refunds are paid within 30 days of the request.', null, 1, 1],
      // A refused answer is recorded as the model wrote it, its citations included.
      ['Refunds are paid within 30 days of the request. [nowhere-0]', 'refused', 0, 1],
      [null, 'trouble', 0, 1],
    ])

    // The answered row keeps its sources, and the ids match the X-Question-Id headers.
    expect(JSON.parse(rows[0].sources as string)).toEqual([expect.objectContaining({ file: 'manual.pdf', page: 2, passage: 'Refunds are paid within 30 days of the request.' })])
    expect(rows.map((q) => q.id)).toEqual([answered, refused, failed].map((r) => r.headers.get('X-Question-Id')))

    // The site also gets the demo's email and id in headers.
    expect(answered.headers.get('X-Demo-Email')).toBe('ada@acme.test')
    expect(answered.headers.get('X-Demo-Id')).toBe(demo.id)
  })

  it('archives page text only with keep, and a re-upload of the file replaces it', async () => {
    // Upload the manual to one demo with keep and to another without.
    const kept = await newDemo('fp_q_kept')
    const unkept = await newDemo('fp_q_unkept')
    await put(kept.key, true)
    await put(unkept.key, false)

    // Only the kept demo's pages are archived.
    expect(await archived(kept.id)).toHaveLength(3)
    expect(await archived(unkept.id)).toEqual([])

    // After the purge, uploading the file again replaces its archived pages.
    await age(kept.id)
    await app.scheduled({} as ScheduledController, testEnv)
    expect((await put(kept.key, true, 'manual.pdf', ['A new cover.'])).status).toBe(200)
    expect(await archived(kept.id)).toEqual([{ file: 'manual.pdf', page: 1, text: 'A new cover.' }])
  })

  it('the 10-day purge deletes the questions asked without keep and leaves the kept ones and the archive', async () => {
    // Upload with keep, then ask one question kept and one not.
    const demo = await newDemo('fp_q_purge')
    await put(demo.key, true)
    await send('/api/ask', demo.key, { question: 'When are refunds paid? [pick:refunds]' }, true)
    await send('/api/ask', demo.key, { question: 'What is in the appendix? [pick:appendix]' }, false)

    // Both questions are recorded before the purge.
    expect(await questions(demo.id)).toHaveLength(2)

    // Age the demo and run the daily job.
    await age(demo.id)
    await app.scheduled({} as ScheduledController, testEnv)

    // Only the kept question and the archive are left, and the chunks are gone.
    const left = await questions(demo.id)
    expect(left.map((q) => q.question)).toEqual(['When are refunds paid? [pick:refunds]'])
    expect(await archived(demo.id)).toHaveLength(3)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM chunks WHERE demo_id = ?').bind(demo.id).first<{ n: number }>())?.n).toBe(0)
  })

  it('the daily job deletes kept questions and archived text after 25 months', async () => {
    // A kept question and its archived pages.
    const demo = await newDemo('fp_q_expire')
    await put(demo.key, true)
    await send('/api/ask', demo.key, { question: 'When are refunds paid? [pick:refunds]' }, true)

    // Date the question and page 1's archive just over 25 months back.
    await env.DB.batch([
      env.DB.prepare("UPDATE questions SET asked_at = datetime('now', '-25 months', '-1 day') WHERE demo_id = ?").bind(demo.id),
      env.DB.prepare("UPDATE archived_pages SET archived_at = datetime('now', '-25 months', '-1 day') WHERE demo_id = ? AND page = 1").bind(demo.id),
    ])

    // Run the daily job: the old question and page 1 are deleted.
    await app.scheduled({} as ScheduledController, testEnv)
    expect(await questions(demo.id)).toEqual([])
    expect((await archived(demo.id)).map((p) => (p as { page: number }).page)).toEqual([2, 3])
  })

  it('exports kept questions only, each with the cited page and its neighbours', async () => {
    // One question kept and one not.
    const demo = await newDemo('fp_q_golden')
    await put(demo.key, true)
    await send('/api/ask', demo.key, { question: 'When are refunds paid? [pick:refunds]' }, true)
    await send('/api/ask', demo.key, { question: 'Not kept? [pick:refunds]' }, false)

    // Export the golden set for this demo.
    const exported = await send(`/internal/admin/golden?demo=${demo.id}`, null, undefined, false)
    // One JSON object per line.
    const lines = exported.text.trim().split('\n').map((line) => JSON.parse(line))

    // Only the kept question, with its cited page and the pages either side.
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ question: 'When are refunds paid? [pick:refunds]', model_answer_unverified: 'Refunds are paid within 30 days of the request.', sources: [{ file: 'manual.pdf', page: 2 }] })
    expect(lines[0].pages.map((p: { page: number }) => p.page)).toEqual([1, 2, 3])
  })
})

describe('removing a file', () => {
  // Like call, but always kept, and with any method.
  async function kept(path: string, key: string, body: unknown, method = 'POST') {
    const headers = { 'Content-Type': 'application/json', 'X-Demo-Keep': '1', 'X-Demo-Key': key }
    const response = await app.fetch(new Request(`https://demo${path}`, { method, headers, body: JSON.stringify(body) }), testEnv)
    return { status: response.status, body: (await response.json()) as any }
  }

  // Uploads, or removes, a file by name.
  const put = (key: string, name: string, pages: string[]) => kept('/api/files', key, { name, page_count: pages.length, pages: pages.map((text, i) => ({ page: i + 1, text })) })
  const remove = (key: string, name: string) => kept('/api/files', key, { name }, 'DELETE')
  // Rows in a table for the demo, or for one of its files.
  const count = async (table: string, demo: string, file?: string) =>
    (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE demo_id = ?${file === undefined ? '' : ' AND file = ?'}`).bind(demo, ...(file === undefined ? [] : [file])).first<{ n: number }>())!.n
  // The room the demo has used: files, pages and characters.
  const room = (demo: string) => env.DB.prepare('SELECT files, pages, chars FROM demos WHERE id = ?').bind(demo).first<{ files: number; pages: number; chars: number }>()

  it("AC4: deletes the file's vectors, chunks, row and archived pages, and leaves the other file and the questions asked", async () => {
    // Two files: one with an Acme job, one with a Globex job.
    const demo = await newDemo('fp_remove')
    await put(demo.key, 'acme.pdf', ['Engineer at Acme, 2010 to 2015.', 'Acme made widgets.'])
    await put(demo.key, 'globex.pdf', ['Designer at Globex, 2016 to 2020.'])

    // The Acme question is answered, and both files count against the room.
    expect((await kept('/api/ask', demo.key, { question: 'What role did he hold at Acme?' })).body.answer).toBe('He was Engineer at Acme from 2010 to 2015.')
    expect(await room(demo.id)).toMatchObject({ files: 2, pages: 3 })

    // Map each vector to its file, to see which vectors are left.
    const chunkFiles = new Map((await env.DB.prepare('SELECT id, file FROM chunks WHERE demo_id = ?').bind(demo.id).all<{ id: string; file: string }>()).results.map((c) => [c.id, c.file]))
    const vectorsOf = (file: string) => [...vectors.store.keys()].filter((id) => chunkFiles.get(id) === file)
    expect(vectorsOf('acme.pdf')).toHaveLength(2)

    // Remove acme.pdf; the reply names it and the questions left.
    const removed = await remove(demo.key, 'acme.pdf')
    expect(removed.status).toBe(200)
    expect(removed.body).toEqual({ name: 'acme.pdf', left: 9 })

    // Its vectors, chunks and archived pages are gone; globex.pdf's stay, and so does the question.
    expect(vectorsOf('acme.pdf')).toEqual([])
    expect(vectorsOf('globex.pdf')).toHaveLength(1)
    expect(await count('chunks', demo.id, 'acme.pdf')).toBe(0)
    expect(await count('chunks', demo.id, 'globex.pdf')).toBe(1)
    expect(await count('archived_pages', demo.id, 'acme.pdf')).toBe(0)
    expect(await count('archived_pages', demo.id, 'globex.pdf')).toBe(1)
    expect(await count('questions', demo.id)).toBe(1)

    // The session lists globex.pdf alone.
    const session = await call('/api/session', demo.key)
    expect(session.body.files.map((f: { name: string }) => f.name)).toEqual(['globex.pdf'])
    expect(session.body.left).toBe(9)

    // Its pages and text are given back: the room is what globex.pdf alone took.
    expect(await room(demo.id)).toEqual({ files: 1, pages: 1, chars: 'Designer at Globex, 2016 to 2020.'.length })

    // Acme is no longer found; Globex still is.
    expect((await kept('/api/ask', demo.key, { question: 'What role did he hold at Acme?' })).body.answer).toBe(NOT_FOUND)
    expect((await kept('/api/ask', demo.key, { question: 'What role did he hold at Globex?' })).body.answer).toBe('He was Designer at Globex from 2016 to 2020.')
  })

  it('AC5: a demo that removes its only file and uploads another emails Joel once in all', async () => {
    // The first upload emails Joel.
    const demo = await newDemo('fp_remove_mail')
    await put(demo.key, 'first.pdf', ['One.'])
    expect(mail).toHaveLength(1)

    // Remove it and upload another: still only the one email.
    expect((await remove(demo.key, 'first.pdf')).status).toBe(200)
    expect((await put(demo.key, 'second.pdf', ['Two.'])).status).toBe(200)
    expect(mail).toHaveLength(1)
  })

  it('guard 6: two removes of one file at once give its pages back once', async () => {
    // Two files, one of two pages.
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

    // Remove the file; its pages come back once, and b.pdf is untouched.
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

    // The first upload fails, sends no email and takes no room.
    expect((await put(demo.key, 'first.pdf', ['One.'])).status).toBe(500)
    expect(mail).toHaveLength(0)
    expect(await room(demo.id)).toEqual({ files: 0, pages: 0, chars: 0 })

    // The retry works and sends the one email.
    expect((await put(demo.key, 'first.pdf', ['One.'])).status).toBe(200)
    expect(mail).toHaveLength(1)
  })

  it('fix 2: a demo that removed its every file still loses its unconsented questions after 10 days, without being told its documents were deleted', async () => {
    // Two demos, each with a file and a question asked.
    const removed = await newDemo('fp_remove_purge')
    const kept = await newDemo('fp_remove_purge_other')
    for (const demo of [removed, kept]) {
      await upload(demo.key, 'a.pdf', ['Refunds are paid within 30 days of the request.'])
      expect((await call('/api/ask', demo.key, { question: 'When are refunds paid?' })).status).toBe(200)
    }

    // One removes its file.
    expect((await remove(removed.key, 'a.pdf')).status).toBe(200)

    // Both go unused for 11 days, then the daily job runs.
    for (const demo of [removed, kept]) await env.DB.prepare("UPDATE demos SET used_at = datetime('now', '-11 days') WHERE id = ?").bind(demo.id).run()
    await app.scheduled({} as ScheduledController, testEnv)

    // Both lose their questions, but only the one that still had a file is told it was cleared.
    expect(await count('questions', removed.id)).toBe(0)
    expect(await count('questions', kept.id)).toBe(0)
    expect((await call('/api/session', removed.key)).body).toMatchObject({ files: [], left: 9, cleared: false })
    expect((await call('/api/session', kept.key)).body).toMatchObject({ files: [], left: 9, cleared: true })
  })

  it('refuses a file the demo does not have, and changes nothing', async () => {
    // A demo with one file.
    const demo = await newDemo('fp_remove_404')
    await put(demo.key, 'a.pdf', ['One.'])

    // Removing a name it does not have, or no name, is a 404.
    expect((await remove(demo.key, 'other.pdf')).status).toBe(404)
    expect((await remove(demo.key, '')).status).toBe(404)

    // The room and the file list are unchanged.
    expect(await room(demo.id)).toEqual({ files: 1, pages: 1, chars: 4 })
    expect((await call('/api/session', demo.key)).body.files).toHaveLength(1)
  })
})

// docs/plans/demo-stream.md: the answer is checked and released a sentence (or list item) at a time.
describe('the streamed answer', () => {
  // A policy page of two sentences.
  const POLICY = ['Refunds are paid within 30 days of the request. Ask the front desk for the form.']

  /** An ask as the page sends it: the events of the stream, in order, with their data. */
  async function streamed(key: string, question: string) {
    // Work handed to waitUntil, awaited before the test reads the table.
    const waits: Promise<unknown>[] = []

    // Ask for a stream, as the page does.
    const response = await app.fetch(new Request('https://demo/api/ask', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'X-Demo-Key': key }, body: JSON.stringify({ question }),
    }), testEnv, { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException: () => {} } as unknown as ExecutionContext)

    // Read it all, then let the background work finish.
    const text = await response.text()
    await Promise.all(waits)

    // Split the stream into events and parse each one's data.
    const events = text.split('\n\n').filter((b) => b.trim()).map((b) => ({ event: /^event: (.*)$/m.exec(b)![1], data: JSON.parse(/^data: (.*)$/m.exec(b)![1]) }))
    return { status: response.status, type: response.headers.get('Content-Type'), id: response.headers.get('X-Question-Id'), events }
  }

  // One recorded question, by id.
  const row = (id: string) => env.DB.prepare('SELECT answer, checked, fallback, ms, first_ms FROM questions WHERE id = ?').bind(id).first<Record<string, unknown>>()
  // How many questions the demo has used.
  const used = async (id: string) => (await env.DB.prepare('SELECT asks_used FROM demos WHERE id = ?').bind(id).first<{ asks_used: number }>())!.asks_used

  it('AC1 AC7: one ask streams its stages and sentences, and the same ask in JSON is today\'s body plus first_ms', async () => {
    // A demo with the policy.
    const demo = await newDemo('fp_stream_shape')
    await upload(demo.key, 'policy.pdf', POLICY)

    // Ask for the stream.
    const s = await streamed(demo.key, 'When are refunds paid?')

    // Three stages, one sentence, then done.
    expect(s.type).toBe('text/event-stream; charset=utf-8')
    expect(s.events.map((e) => e.event)).toEqual(['stage', 'stage', 'stage', 'unit', 'done'])
    expect(s.events.slice(0, 3).map((e) => e.data.stage)).toEqual(['retrieving', 'reranking', 'writing'])
    expect(s.events[3].data).toEqual({ kind: 'sentence', text: 'Refunds are paid within 30 days of the request.', sources: [expect.any(String)] })

    // The question is recorded as checked.
    expect(s.id).toBeTruthy()
    expect(await row(s.id!)).toMatchObject({ checked: 1, fallback: null, answer: 'Refunds are paid within 30 days of the request.' })

    // The same question as JSON gives the old body plus first_ms.
    const json = await call('/api/ask', demo.key, { question: 'When are refunds paid?' })
    expect(json.status).toBe(200)
    expect(json.body).toMatchObject({ answer: 'Refunds are paid within 30 days of the request.', sources: [expect.objectContaining({ file: 'policy.pdf', page: 1 })], found: true, left: 8, first_ms: expect.any(Number) })
    expect(json.body.stopped).toBeUndefined()
  })

  it('AC4, guard 5: a later sentence that fails stops the answer there, keeps what was shown, counts the question and records it', async () => {
    // A demo with the policy.
    const demo = await newDemo('fp_stream_stop')
    await upload(demo.key, 'policy.pdf', POLICY)

    // The second sentence cites an id it was not given.
    const s = await streamed(demo.key, 'When are refunds paid? [stop-midway]')

    // The stream stops after the first sentence, which is all that was shown.
    expect(s.events.map((e) => e.event)).toEqual(['stage', 'stage', 'stage', 'unit', 'stopped', 'done'])
    expect(s.events[4].data).toEqual({ reason: 'uncited' })
    expect(JSON.stringify(s.events.filter((e) => e.event === 'unit'))).not.toContain('Ask the front desk')

    // It is recorded as stopped and counted against the allowance.
    expect(await row(s.id!)).toMatchObject({ checked: 1, fallback: 'stopped', answer: 'Refunds are paid within 30 days of the request.' })
    expect(await used(demo.id)).toBe(1)

    // The session history shows what was shown.
    const session = await call('/api/session', demo.key)
    expect(session.body.history).toEqual([expect.objectContaining({ question: 'When are refunds paid? [stop-midway]', answer: 'Refunds are paid within 30 days of the request.' })])

    // JSON gives the same stop.
    const json = await call('/api/ask', demo.key, { question: 'When are refunds paid? [stop-midway]' })
    expect(json.body).toMatchObject({ found: true, stopped: 'uncited', answer: 'Refunds are paid within 30 days of the request.', left: 8 })
  })

  it('AC3 AC5, guards 1 and 3: a first sentence that fails is the fallback in both renderings, and nothing of it is sent', async () => {
    // A demo with the policy.
    const demo = await newDemo('fp_stream_first')
    await upload(demo.key, 'policy.pdf', POLICY)

    // The first sentence states a figure no passage holds.
    const s = await streamed(demo.key, 'How much? [invent-figure]')

    // Only the fallback is sent, and the figure never appears.
    expect(s.events.map((e) => e.event)).toEqual(['stage', 'stage', 'stage', 'fallback'])
    expect(s.events[3].data).toEqual({ answer: NOT_FOUND, found: false, refused: 'ungrounded', left: 9 })
    expect(JSON.stringify(s.events)).not.toContain('4,200')

    // It is recorded as refused, with no first-sentence time.
    expect(await row(s.id!)).toMatchObject({ checked: 0, fallback: 'refused', first_ms: null })

    // JSON gives the same fallback.
    const json = await call('/api/ask', demo.key, { question: 'How much? [invent-figure]' })
    expect(json.body).toMatchObject({ answer: NOT_FOUND, sources: [], found: false, refused: 'ungrounded' })
  })

  it('AC5: a model that writes nothing is the fallback, refused as empty', async () => {
    // A CV with one job.
    const demo = await newDemo('fp_stream_empty')
    await upload(demo.key, 'cv.pdf', ['Engineer at Acme, 2010 to 2015.'])

    // The scripted model writes nothing for an employer it cannot find.
    const json = await call('/api/ask', demo.key, { question: 'What role did he hold at Nowhere?' })
    expect(json.body).toMatchObject({ answer: NOT_FOUND, found: false, refused: 'empty' })
  })

  it('AC6, guard 6: a fifth sentence is never shown; the answer stops at four', async () => {
    // A page of five steps.
    const demo = await newDemo('fp_stream_five')
    await upload(demo.key, 'steps.pdf', ['Unlock the gate. Sweep the dock. Check the forklift. Sign the log. Open the doors.'])

    // The model writes five sentences; only four are shown, then a stop.
    const s = await streamed(demo.key, 'What are the steps? [five-sentences]')
    expect(s.events.filter((e) => e.event === 'unit').map((e) => e.data.text)).toEqual(['Unlock the gate.', 'Sweep the dock.', 'Check the forklift.', 'Sign the log.'])
    expect(s.events.find((e) => e.event === 'stopped')?.data).toEqual({ reason: 'overlong' })
  })

  it('AC9, guard 7: the model failing after a sentence is shown is a stop, not a refund', async () => {
    // A demo with the policy.
    const demo = await newDemo('fp_stream_die')
    await upload(demo.key, 'policy.pdf', POLICY)

    // The model dies after the first sentence: a stop, and the question still counts.
    const json = await call('/api/ask', demo.key, { question: 'When are refunds paid? [die-midway]' })
    expect(json.status).toBe(200)
    expect(json.body).toMatchObject({ found: true, stopped: 'trouble', answer: 'Refunds are paid within 30 days of the request.', left: 9 })
    expect(await used(demo.id)).toBe(1)

    // The model is down before anything is shown: an error, and the question is not counted.
    const down = await streamed(demo.key, 'When are refunds paid? [model-down]')
    expect(down.status).toBe(200)
    expect(down.events.at(-1)).toEqual({ event: 'error', data: { error: expect.stringContaining('try that question again'), left: 9 } })
    expect(await used(demo.id)).toBe(1)
  })

  it('guard 10: first_ms is the time to the first sentence, not the whole answer', async () => {
    // A demo with the policy.
    const demo = await newDemo('fp_stream_slow')
    await upload(demo.key, 'policy.pdf', POLICY)

    // The [slow] marker waits two seconds between the two sentences.
    const s = await streamed(demo.key, 'When are refunds paid? [slow]')

    // first_ms is well under the total time, and is what was recorded.
    const done = s.events.find((e) => e.event === 'done')!.data
    expect(done.first_ms).toEqual(expect.any(Number))
    expect(done.ms - done.first_ms).toBeGreaterThanOrEqual(1500)
    expect(await row(s.id!)).toMatchObject({ first_ms: done.first_ms })
  }, 10_000)

  it('guard 2: citation markers never reach the shown text, and the digits in ids are not read as figures', async () => {
    // A CV with two jobs.
    const demo = await newDemo('fp_stream_marks')
    await upload(demo.key, 'cv.pdf', ['Engineer at Acme, 2010 to 2015.', 'Designer at Globex, 2016 to 2020.'])

    // Ask for the jobs: a lead-in and a list.
    const json = await call('/api/ask', demo.key, { question: 'what jobs has he held' })
    expect(json.body.found).toBe(true)
    expect(json.body.answer).toBe('He has held these jobs:')
    expect(json.body.items).toEqual(['Engineer at Acme, 2010 to 2015', 'Designer at Globex, 2016 to 2020'])

    // No bracket from a citation is left in any shown line.
    for (const text of [json.body.answer, ...json.body.items]) expect(text).not.toContain('[')
  })
})

// Joel, 2026-10-30: a sentence the model wrote without ids is held and released with the next one that has them.
describe('a sentence without its own ids', () => {
  const POLICY = ['Refunds are paid within 30 days of the request. Ask the front desk for the form.']

  it('fix: is released with the next cited sentence, checked against its passages', async () => {
    // A demo with the policy.
    const demo = await newDemo('fp_held_open')
    await upload(demo.key, 'policy.pdf', POLICY)

    // The reply opens with "Yes." and no ids, then a cited sentence.
    const json = await call('/api/ask', demo.key, { question: 'Are refunds paid? [uncited-opener]' })

    // Both are shown together, with no stop.
    expect(json.body).toMatchObject({ found: true, answer: 'Yes. Refunds are paid within 30 days of the request.' })
    expect(json.body.stopped).toBeUndefined()
  })

  it('fix: is never shown when a figure in it is in none of the passages the next sentence cites', async () => {
    // A demo with the policy.
    const demo = await newDemo('fp_held_figure')
    await upload(demo.key, 'policy.pdf', POLICY)

    // The uncited sentence states 4,200 dollars, so the answer falls back.
    const json = await call('/api/ask', demo.key, { question: 'What does it cost? [uncited-figure]' })
    expect(json.body).toMatchObject({ found: false, answer: NOT_FOUND, refused: 'ungrounded' })
  })

  it('fix: ending the reply, nothing vouches for it, so the answer stops before it', async () => {
    // A demo with the policy.
    const demo = await newDemo('fp_held_end')
    await upload(demo.key, 'policy.pdf', POLICY)

    // The reply ends with "That is all." and no ids after it.
    const json = await call('/api/ask', demo.key, { question: 'When are refunds paid? [uncited-end]' })
    expect(json.body).toMatchObject({ found: true, stopped: 'uncited', answer: 'Refunds are paid within 30 days of the request.' })
  })
})

describe('units of a streamed reply', () => {
  // A reply with a numbered aside, two cited sentences, a lead-in and two list items.
  const TEXT = 'Contents: 1. Talk; 2. Hands [ab-1]. The fee is $5 [ab-1, cd-2].\nThese are the steps [ab-1]:\n- Open the gate [ab-1]\n- Close it. Then lock it [cd-2]\n'

  it('splits sentences as `sentences` does, keeps trailing markers with the sentence before them, and reads list lines', () => {
    expect(units(TEXT, true)).toEqual([
      { kind: 'sentence', raw: 'Contents: 1. Talk; 2. Hands [ab-1].' },
      { kind: 'sentence', raw: 'The fee is $5 [ab-1, cd-2].' },
      { kind: 'lead', raw: 'These are the steps [ab-1]:' },
      { kind: 'item', raw: 'Open the gate [ab-1]' },
      { kind: 'item', raw: 'Close it. Then lock it [cd-2]' },
    ])

    // Taking markers out of a sentence, and reading its ids.
    expect(unmarked('The fee is $5 [ab-1, cd-2].')).toBe('The fee is $5.')
    expect(idsIn('The fee is $5 [ab-1, cd-2].')).toEqual(['ab-1', 'cd-2'])
  })

  it('never changes a unit once it is complete, however the text arrives', () => {
    // The units of the whole text.
    const final = units(TEXT, true)

    // At every cut of the text, the units so far match the start of the final ones.
    for (let i = 0; i <= TEXT.length; i++) {
      const sofar = units(TEXT.slice(0, i), false)
      expect(sofar).toEqual(final.slice(0, sofar.length))
    }
  })
})
