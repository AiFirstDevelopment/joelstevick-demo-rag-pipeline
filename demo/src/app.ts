// Copyright (c) 2026 Joel Stevick
// SPDX-License-Identifier: MIT
// Licensed under the MIT License: https://opensource.org/licenses/MIT

/**
 * The demo chatbot's routes. Reached only through the site's Pages Functions
 * (the DEMO service binding): `/api/*` from functions/api/demo/[[path]].ts,
 * which forwards the visitor's cookie as X-Demo-Key, and `/internal/demos`
 * from functions/api/payment-method.ts, `/internal/demos/which` from
 * functions/api/projects.ts and `/internal/demos/open` from
 * functions/api/projects/demo.ts, which the proxy never forwards to. `/internal/admin/*`
 * are read by the site's /api/admin routes only (docs/plans/admin.md).
 *
 * Every question is recorded in `questions`. When the site sends X-Demo-Keep: 1 (the visitor
 * may be recorded), the question outlives the 10-day purge and each uploaded page's text is
 * archived in `archived_pages`; both are deleted after 25 months.
 */
import { checkAnswer } from './check'
import { chunkPage } from './chunks'
import { ANSWER_CHUNKS, answer, rerank, type Models } from './models'
import { fuseKeywordAndVector, type Chunk } from './retrieval'
import { widen } from './widen'

export interface Env {
  DB: D1Database
  MAILER?: Fetcher
  AI?: Ai
  VECTORS?: VectorizeIndex
  ANTHROPIC_API_KEY?: string
}

export const LIMITS = { asks: 10, files: 5, pages: 300, chars: 500_000 }
/** A demo's documents are deleted after this many days with no upload and no question. */
export const IDLE_DAYS = 10
/** Kept questions and archived page text are deleted after this many months. */
export const KEEP_MONTHS = 25
export const NOT_FOUND = "I couldn't find that in your documents."
/** Said instead of NOT_FOUND when the answer was written from only part of the documents. */
export const NOT_IN_PASSAGES = "I couldn't find that in the passages I read for this question, which are only part of your documents. Asking about it more specifically may find it."
export const TROUBLE = 'The demo is having trouble right now. Please try that question again in a minute.'

/** How many chunks the reranker reads: 24 missed passages a book's answer sat in (evals/runs). */
const POOL = 48
const MAX_QUESTION = 500
const EMBED_BATCH = 50

interface Demo {
  id: string
  asks_used: number
  files: number
  pages: number
  chars: number
  company: string | null
  contact: string | null
  cleared_at: string | null
}

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...extra } })
}

/** What the site reads off an upload's or a question's answer to record the event; it never reaches the browser. */
function about(demo: Demo, question?: string): Record<string, string> {
  const email = /<([^<>]+)>$/.exec(demo.contact ?? '')?.[1] ?? ''
  return { 'X-Demo-Id': demo.id, ...(email ? { 'X-Demo-Email': email } : {}), ...(question ? { 'X-Question-Id': question } : {}) }
}

const keeps = (request: Request) => request.headers.get('X-Demo-Keep') === '1'

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function randomKey(bytes: number): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes))
  // URL-safe base64 of random bytes, unpadded: a key that fits a cookie and a URL.
  return btoa(String.fromCharCode(...raw)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** The demo whose key the cookie holds, looked up by the key's hash and nothing else. */
async function signedIn(request: Request, env: Env): Promise<Demo | null> {
  const key = request.headers.get('X-Demo-Key') ?? ''
  if (key === '') return null
  return env.DB.prepare('SELECT id, asks_used, files, pages, chars, company, contact, cleared_at FROM demos WHERE key_hash = ? AND purged_at IS NULL')
    .bind(await sha256(key)).first<Demo>()
}

/** Creates the demo for a card, or finds the one it already has, and gives it a fresh key. */
async function createDemo(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  const fingerprint = typeof body.fingerprint === 'string' ? body.fingerprint : ''
  if (fingerprint === '') return json(400, { error: 'no card fingerprint' })
  const text = (key: string) => (typeof body[key] === 'string' ? (body[key] as string).slice(0, 300) : null)
  const key = randomKey(32)
  const hash = await sha256(key)
  await env.DB.prepare(
    // One demo per card: the same card again re-keys its existing demo instead of making another, unless that one was purged.
    `INSERT INTO demos (id, key_hash, engagement_id, card_fingerprint, company, contact) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (card_fingerprint) DO UPDATE SET key_hash = excluded.key_hash WHERE demos.purged_at IS NULL`,
  ).bind(randomKey(12).toLowerCase().replace(/[^a-z0-9]/g, 'x'), hash, text('engagement_id'), fingerprint, text('company'), text('contact')).run()
  const demo = await env.DB.prepare('SELECT id, key_hash, purged_at FROM demos WHERE card_fingerprint = ?')
    .bind(fingerprint).first<{ id: string; key_hash: string | null; purged_at: string | null }>()
  // The card's row is purged, or our key did not land on it: the card's demo has expired.
  if (demo === null || demo.purged_at !== null || demo.key_hash !== hash) return json(200, { expired: true })
  return json(200, { key, id: demo.id })
}

/** Of the engagement ids given, those with a demo that is not purged. */
async function whichDemos(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { engagement_ids?: unknown }
  const ids = Array.isArray(body.engagement_ids) ? body.engagement_ids.filter((id): id is string => typeof id === 'string').slice(0, 100) : []
  if (ids.length === 0) return json(200, { engagement_ids: [] })
  const rows = await env.DB.prepare(
    `SELECT DISTINCT engagement_id FROM demos WHERE purged_at IS NULL AND engagement_id IN (${ids.map(() => '?').join(', ')})`,
  ).bind(...ids).all<{ engagement_id: string }>()
  return json(200, { engagement_ids: rows.results.map((row) => row.engagement_id) })
}

/** Gives the engagement's latest live demo a fresh key, as createDemo does for a returning card. */
async function openDemo(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { engagement_id?: unknown }
  const engagement = typeof body.engagement_id === 'string' ? body.engagement_id : ''
  const key = randomKey(32)
  const demo = await env.DB.prepare(
    `UPDATE demos SET key_hash = ? WHERE id = (
       SELECT id FROM demos WHERE engagement_id = ? AND purged_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1
     ) RETURNING id`,
  ).bind(await sha256(key), engagement).first<{ id: string }>()
  if (engagement === '' || demo === null) return json(404, { error: 'no demo' })
  return json(200, { key, id: demo.id })
}

async function session(demo: Demo, env: Env): Promise<Response> {
  const files = await env.DB.prepare('SELECT name, pages, skipped FROM files WHERE demo_id = ? ORDER BY rowid')
    .bind(demo.id).all<{ name: string; pages: number; skipped: string }>()
  return json(200, {
    files: files.results.map((file) => ({ name: file.name, pages: file.pages, skipped: JSON.parse(file.skipped) as number[] })),
    left: LIMITS.asks - demo.asks_used,
    limits: LIMITS,
    cleared: demo.cleared_at !== null,
  })
}

async function upload(request: Request, env: Env, models: Models, demo: Demo): Promise<Response> {
  // INGEST 1 · validate the upload: name, page count, each page's text
  const body = (await request.json().catch(() => null)) as { name?: unknown; page_count?: unknown; pages?: unknown } | null
  const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 200) : ''
  const pageCount = Number(body?.page_count)
  const raw = Array.isArray(body?.pages) ? (body.pages as { page?: unknown; text?: unknown }[]) : null
  if (name === '' || !Number.isInteger(pageCount) || pageCount < 1 || raw === null) return json(400, { error: 'That upload could not be read.' })
  // Only pages with text count; the empty ones (scans, blank pages) are listed as `skipped` so the visitor sees them.
  const pages = raw
    .filter((p) => Number.isInteger(p.page) && (p.page as number) >= 1 && (p.page as number) <= pageCount && typeof p.text === 'string')
    .map((p) => ({ page: p.page as number, text: (p.text as string).trim() }))
    .filter((p) => p.text.length > 0)
  const withText = new Set(pages.map((p) => p.page))
  const skipped = Array.from({ length: pageCount }, (_, i) => i + 1).filter((page) => !withText.has(page))
  const chars = pages.reduce((sum, p) => sum + p.text.length, 0)

  // INGEST 2 · claim the file name (one row per file)
  // The file's row first: its primary key is what stops two uploads of one name at once.
  try {
    await env.DB.prepare('INSERT INTO files (demo_id, name, pages, chars, skipped) VALUES (?, ?, ?, ?, ?)')
      .bind(demo.id, name, pageCount, chars, JSON.stringify(skipped)).run()
  } catch (error) {
    if (String(error).includes('UNIQUE')) return json(409, { error: `${name} is already uploaded.` })
    throw error
  }
  // Undoes INGEST 2, for when INGEST 3 finds no room.
  const forget = () => env.DB.prepare('DELETE FROM files WHERE demo_id = ? AND name = ?').bind(demo.id, name).run()

  // INGEST 3 · check the demo's limits (files, pages, characters)
  // Every limit in one statement, so two uploads at once cannot both fit in the last of the room.
  const room = await env.DB.prepare(
    `UPDATE demos SET files = files + 1, pages = pages + ?1, chars = chars + ?2, uploads = uploads + 1, used_at = datetime('now'), cleared_at = NULL
     WHERE id = ?3 AND files < ?4 AND pages + ?1 <= ?5 AND chars + ?2 <= ?6 RETURNING uploads`,
  ).bind(pageCount, chars, demo.id, LIMITS.files, LIMITS.pages, LIMITS.chars).first<{ uploads: number }>()
  if (room === null) {
    await forget()
    const now = (await env.DB.prepare('SELECT files, pages, chars FROM demos WHERE id = ?').bind(demo.id).first<Demo>()) ?? demo
    const limit = now.files >= LIMITS.files
      ? `The demo takes at most ${LIMITS.files} PDFs.`
      : now.pages + pageCount > LIMITS.pages
        ? `The demo takes at most ${LIMITS.pages} pages in all, and ${name} would take it to ${now.pages + pageCount}.`
        : `The demo takes at most ${LIMITS.chars / 1000} KB of text in all, and ${name} would take it past that.`
    return json(413, { error: `${limit} ${name} was not added.` })
  }

  // INGEST 4 · chunk each page
  // A random prefix per upload, so two uploads at once never mint the same chunk id.
  const upload = randomKey(6).toLowerCase().replace(/[^a-z0-9]/g, 'x')
  let n = 0
  // A chunk id is <demo>-<upload>-<n>: the demo's id, this upload's random prefix, the chunk's place in the file (`seq`, which widen walks).
  const chunks: Chunk[] = pages.flatMap((p) => chunkPage(p.text).map((text) => ({ id: `${demo.id}-${upload}-${n}`, file: name, page: p.page, text, seq: n++ })))
  // INGEST 5 · store the chunks (and archived pages) in D1
  // With consent, each page's text is archived beside its chunks; a re-upload of the file replaces it.
  const archive = keeps(request)
    ? [
        env.DB.prepare('DELETE FROM archived_pages WHERE demo_id = ? AND file = ?').bind(demo.id, name),
        ...pages.map((p) => env.DB.prepare('INSERT INTO archived_pages (demo_id, file, page, text) VALUES (?, ?, ?, ?)').bind(demo.id, name, p.page, p.text)),
      ]
    : []
  try {
    const statements = [
      ...archive,
      ...chunks.map((c) => env.DB.prepare('INSERT INTO chunks (id, demo_id, file, page, text, seq) VALUES (?, ?, ?, ?, ?, ?)').bind(c.id, demo.id, c.file, c.page, c.text, c.seq)),
    ]
    // In batches of 100 statements; a failure part-way, whichever batch, is undone below.
    for (let i = 0; i < statements.length; i += 100) await env.DB.batch(statements.slice(i, i + 100))
  } catch (error) {
    console.error('demo upload: the chunks could not be stored', error)
    // Undo everything of this upload: its archive, its chunks (by the upload's prefix), its file row and its room.
    await env.DB.batch([
      ...(archive.length > 0 ? [env.DB.prepare('DELETE FROM archived_pages WHERE demo_id = ? AND file = ?').bind(demo.id, name)] : []),
      env.DB.prepare('DELETE FROM chunks WHERE demo_id = ? AND id LIKE ?').bind(demo.id, `${demo.id}-${upload}-%`),
      env.DB.prepare('DELETE FROM files WHERE demo_id = ? AND name = ?').bind(demo.id, name),
      env.DB.prepare('UPDATE demos SET files = files - 1, pages = pages - ?, chars = chars - ?, uploads = uploads - 1 WHERE id = ?').bind(pageCount, chars, demo.id),
    ])
    return json(500, { error: `${name} could not be stored. Please try again.` })
  }

  // INGEST 6 · embed the chunks (Workers AI) and index them in Vectorize
  // Without vectors the demo answers from BM25 alone, so a failed embedding loses nothing that is shown.
  if (models.embed !== undefined && models.vectors !== undefined) {
    try {
      // EMBED_BATCH texts an embedding call; each vector is written under the demo's namespace with its chunk's id, so a hit maps straight back to its row.
      for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
        const batch = chunks.slice(i, i + EMBED_BATCH)
        const values = await models.embed(batch.map((c) => c.text))
        await models.vectors.upsert(demo.id, batch.map((c, j) => ({ id: c.id, values: values[j] })))
      }
    } catch (error) {
      console.error('demo upload: embedding failed; this file is searched by its words alone', error)
    }
  }

  // INGEST 7 · tell Joel about a demo's first upload, and reply
  // Once per demo, at its first upload ever: a prospect uploading again after their documents were
  // cleared, or after removing every file, is not a new demo.
  if (room.uploads === 1 && env.MAILER !== undefined) await tellJoel(env.MAILER, demo, name, pageCount)
  return json(200, { name, pages: pageCount, skipped, chunks: chunks.length, chars }, about(demo))
}

/**
 * Removes one file as if it was never uploaded: its vectors first (a failure there leaves
 * every row, and the visitor is asked to try again), then in one transaction its pages and
 * text given back to the demo's room, and its chunks, file row and archived pages deleted.
 * The questions already asked stay, and the count left is unchanged.
 */
async function remove(request: Request, env: Env, models: Models, demo: Demo): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { name?: unknown } | null
  const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 200) : ''
  const file = name === '' ? null : await env.DB.prepare('SELECT pages, chars FROM files WHERE demo_id = ? AND name = ?').bind(demo.id, name).first<{ pages: number; chars: number }>()
  if (file === null) return json(404, { error: `${name || 'That file'} is not in your demo.` })
  const ids = (await env.DB.prepare('SELECT id FROM chunks WHERE demo_id = ? AND file = ?').bind(demo.id, name).all<{ id: string }>()).results.map((row) => row.id)
  if (models.vectors !== undefined && ids.length > 0) {
    try {
      for (let i = 0; i < ids.length; i += 500) await models.vectors.deleteByIds(ids.slice(i, i + 500))
    } catch (error) {
      console.error('demo remove: the vectors could not be deleted; nothing removed', error)
      return json(500, { error: `${name} could not be removed. Please try again.` })
    }
  }
  // The room is given back only while the file's row is still there, so two removes of one
  // file at once give it back once; the deletes follow in the same transaction.
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE demos SET files = files - 1, pages = pages - ?2, chars = chars - ?3, used_at = datetime('now')
       WHERE id = ?1 AND EXISTS (SELECT 1 FROM files WHERE demo_id = ?1 AND name = ?4)`,
    ).bind(demo.id, file.pages, file.chars, name),
    env.DB.prepare('DELETE FROM chunks WHERE demo_id = ? AND file = ?').bind(demo.id, name),
    env.DB.prepare('DELETE FROM archived_pages WHERE demo_id = ? AND file = ?').bind(demo.id, name),
    env.DB.prepare('DELETE FROM files WHERE demo_id = ? AND name = ?').bind(demo.id, name),
  ])
  return json(200, { name, left: LIMITS.asks - demo.asks_used }, about(demo))
}

async function tellJoel(mailer: Fetcher, demo: Demo, file: string, pages: number): Promise<void> {
  const [, name = demo.contact ?? 'A demo visitor', email = 'joelstevick@gmail.com'] = /^(.*) <(.*)>$/.exec(demo.contact ?? '') ?? []
  try {
    await mailer.fetch('https://mailer/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name, email, company: demo.company ?? '', budget: 'template',
        message: `DEMO STARTED (demo ${demo.id})\nCompany: ${demo.company ?? '(not given)'}\nFirst upload: ${file}\nFiles: 1, pages: ${pages}`,
      }),
    })
  } catch (error) {
    console.error('demo upload: the mailer could not be reached', error)
  }
}

/** How the ask is assembled. `widen: false` turns widening off; it is on by default. */
export interface Options {
  widen?: boolean
}

/**
 * ASK 3-4 · retrieval: the chunks a question is answered from, with every chunk of the demo.
 *
 * Reads the demo's chunks from D1, runs the vector search, and hands both to `fuseKeywordAndVector`
 * (retrieval.ts), which runs the keyword search (BM25) and merges the two rankings. The stage is
 * split this way on purpose, for testability. Everything that reaches a service and can be
 * missing or fail (D1, the embedding model, Vectorize) is here, with its fallbacks, so that
 * `fuseKeywordAndVector` stays a pure function of plain values (chunks, question, ids in; chunks out) that
 * can be exercised with arrays alone, no bindings, no fakes. `all` is returned too: the caller
 * reads documents whole when they fit and widens the chosen chunks by their neighbours in it.
 */
async function retrieval(question: string, env: Env, models: Models, demo: Demo): Promise<{ all: Chunk[]; retrieved: Chunk[] }> {
  // `all`: every chunk of this demo's documents, from D1, for keyword search.
  const all = (await env.DB.prepare('SELECT id, file, page, text, seq FROM chunks WHERE demo_id = ? ORDER BY rowid').bind(demo.id).all<Chunk>()).results
  // `near`: vector search. The question is embedded (Workers AI) and Vectorize returns the ids of
  // the chunks closest in meaning, best first. If either is missing or fails, `near` stays empty
  // and retrieval falls back to keyword search alone.
  let near: string[] = []
  if (models.embed !== undefined && models.vectors !== undefined) {
    try {
      const [values] = await models.embed([question])
      // The namespace is `demo.id`: the demo's own row id in D1, 12 random lowercase letters and
      // digits made in `createDemo` (`upload` stored each chunk's vector under it). So only this
      // demo's vectors are searched, for the POOL (48) closest to the question's vector; the
      // result is their chunk ids, best first.
      near = await models.vectors.query(demo.id, values, POOL)
    } catch (error) {
      console.error('demo ask: the vector index did not answer; BM25 alone', error)
    }
  }
  // Merge keyword (BM25) and vector results into the candidate pool.
  return { all, retrieved: fuseKeywordAndVector(all, question, POOL, near) }
}

async function ask(request: Request, env: Env, models: Models, demo: Demo, options: Options): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { question?: unknown }
  // ASK 1 · validate the question
  const question = typeof body.question === 'string' ? body.question.trim() : ''
  if (question === '' || question.length > MAX_QUESTION) return json(400, { error: `Please ask a question of up to ${MAX_QUESTION} characters.` })

  // ASK 2 · reserve one of the demo's ten questions
  // The reservation is the limit: one statement, so two asks for the last question cannot both pass.
  const reserved = await env.DB.prepare("UPDATE demos SET asks_used = asks_used + 1, used_at = datetime('now') WHERE id = ? AND asks_used < ? RETURNING asks_used")
    .bind(demo.id, LIMITS.asks).first<{ asks_used: number }>()
  if (reserved === null) return json(429, { error: "You've used your ten questions.", left: 0 })
  const left = LIMITS.asks - reserved.asks_used
  const started = Date.now()
  // Every outcome is recorded; a failure to record never costs the visitor the answer.
  const recorded = async (status: number, body: Record<string, unknown>, row: { answer: string | null; sources?: unknown[]; checked?: boolean; fallback: string | null }) => {
    const id = randomKey(12)
    try {
      await env.DB.prepare('INSERT INTO questions (id, demo_id, question, answer, sources, checked, fallback, ms, keep) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(id, demo.id, question, row.answer, JSON.stringify(row.sources ?? []), row.checked ? 1 : 0, row.fallback, Date.now() - started, keeps(request) ? 1 : 0).run()
      return json(status, body, about(demo, id))
    } catch (error) {
      console.error('demo ask: the question could not be recorded', error)
      return json(status, body, about(demo))
    }
  }

  // ASK 3-4 · retrieval: every chunk (D1) and the vector search (Vectorize), merged with keyword
  // search (BM25) into the candidate pool. `retrieval` below says why it is split from `fuseKeywordAndVector`.
  const { all, retrieved } = await retrieval(question, env, models, demo)
  // Documents that fit the answer whole are read whole, retrieved chunks first: then, and only
  // then, "not in your documents" is true.
  const whole = all.length <= ANSWER_CHUNKS
  // `includes` here is by object identity, not text: `fuseKeywordAndVector` returns the very Chunk objects
  // `all` holds, so the filter appends every chunk not already among the retrieved.
  const pool = whole ? [...retrieved, ...all.filter((chunk) => !retrieved.includes(chunk))] : retrieved
  const missing = whole ? NOT_FOUND : NOT_IN_PASSAGES
  if (pool.length === 0) return recorded(200, { answer: missing, sources: [], found: false, left }, { answer: null, fallback: 'not_found' })

  // ASK 5 · rerank (Claude picks the best passages), then widen (add their neighbours)
  // Each chosen chunk with its neighbours, unless every chunk is already given. It passed 5 of 5
  // boundary cases against 4 of 5 for 60% more a question, past the bar set before the runs;
  // Joel switched it on for the better answers (/stories/widening, evals/runs/*-widen-*).
  const chosen = await rerank(models.claude, question, pool)
  // When every chunk is already given there is nothing to widen into.
  const given = whole || options.widen === false ? chosen : widen(chosen, all)
  // ASK 6 · answer (Claude writes it from the given passages only)
  let reply: { answer: string; sources: string[] }
  try {
    reply = await answer(models.claude, question, given)
  } catch (error) {
    console.error('demo ask: the answer model failed; the question is given back', error)
    // The reservation at ASK 2 is undone: the failure costs the visitor no question.
    await env.DB.prepare('UPDATE demos SET asks_used = asks_used - 1 WHERE id = ? AND asks_used > 0').bind(demo.id).run()
    return recorded(503, { error: TROUBLE, left: left + 1 }, { answer: null, fallback: 'trouble' })
  }
  // ASK 7 · check the citations in code; refuse the answer if they don't hold
  const checked = checkAnswer(reply, given, question)
  // A refused answer goes out as the fallback, and is recorded with the model's words and the reason, for the evals and /admin.
  if (!checked.ok) return recorded(200, { answer: missing, sources: [], found: false, left, refused: checked.reason }, { answer: reply.answer, fallback: 'refused' })
  // ASK 8 · return the answer with its sources
  // The passage is the stored text it was given, read by its id: never the model's words.
  const sources = checked.cited.map((chunk) => ({
    id: chunk.id, file: chunk.file, page: chunk.page, ...(chunk.lastPage !== undefined && chunk.lastPage > chunk.page ? { last_page: chunk.lastPage } : {}), passage: chunk.text,
  }))
  return recorded(200, { answer: checked.answer, sources, found: true, left }, { answer: checked.answer, sources, checked: true, fallback: null })
}

/**
 * Deletes the documents of every demo unused for IDLE_DAYS: its vectors first, then its
 * chunks and files, and the questions asked without consent (keep = 0). The demo, its key,
 * its count of questions used, its kept questions and its archived page text stay; it is
 * asked for its PDFs again. A demo whose every file was removed is picked for its unconsented
 * questions alone, and is not told its documents were deleted.
 */
export async function purge(env: Env, models: Models): Promise<number> {
  const old = await env.DB.prepare(
    `SELECT id FROM demos WHERE purged_at IS NULL AND COALESCE(used_at, created_at) <= datetime('now', ?)
     AND (files > 0 OR EXISTS (SELECT 1 FROM questions q WHERE q.demo_id = demos.id AND q.keep = 0))`,
  ).bind(`-${IDLE_DAYS} days`).all<{ id: string }>()
  let purged = 0
  for (const { id } of old.results) {
    try {
      const ids = (await env.DB.prepare('SELECT id FROM chunks WHERE demo_id = ?').bind(id).all<{ id: string }>()).results.map((row) => row.id)
      if (models.vectors !== undefined) {
        for (let i = 0; i < ids.length; i += 500) await models.vectors.deleteByIds(ids.slice(i, i + 500))
      }
      // One transaction, and only while the demo is still idle: an upload since the SELECT
      // above keeps its chunks and files (searched by their words until it is idle again).
      const idle = `EXISTS (SELECT 1 FROM demos WHERE id = ?1 AND COALESCE(used_at, created_at) <= datetime('now', ?2))`
      const cutoff = `-${IDLE_DAYS} days`
      await env.DB.batch([
        env.DB.prepare(`DELETE FROM chunks WHERE demo_id = ?1 AND ${idle}`).bind(id, cutoff),
        env.DB.prepare(`DELETE FROM files WHERE demo_id = ?1 AND ${idle}`).bind(id, cutoff),
        env.DB.prepare(`DELETE FROM questions WHERE demo_id = ?1 AND keep = 0 AND ${idle}`).bind(id, cutoff),
        env.DB.prepare(`UPDATE demos SET files = 0, pages = 0, chars = 0, cleared_at = CASE WHEN files > 0 THEN datetime('now') ELSE cleared_at END WHERE id = ?1 AND ${idle}`).bind(id, cutoff),
      ])
      purged++
    } catch (error) {
      // The rows stay, so tomorrow's run still knows which vectors to delete.
      console.error(`demo purge: ${id} could not be purged; retried tomorrow`, error)
    }
  }
  return purged
}

/** Deletes kept questions and archived page text older than KEEP_MONTHS. */
export async function expire(env: Env): Promise<void> {
  const cutoff = `-${KEEP_MONTHS} months`
  await env.DB.batch([
    env.DB.prepare("DELETE FROM questions WHERE asked_at <= datetime('now', ?)").bind(cutoff),
    env.DB.prepare("DELETE FROM archived_pages WHERE archived_at <= datetime('now', ?)").bind(cutoff),
  ])
}

interface DemoRow {
  id: string
  engagement_id: string | null
  company: string | null
  contact: string | null
  created_at: string
  used_at: string | null
  cleared_at: string | null
  purged_at: string | null
  files: number
  pages: number
  asks_used: number
  questions: number
}

/** Every demo, newest first, or those whose contact is `email`: for /admin. */
async function adminDemos(url: URL, env: Env): Promise<Response> {
  const email = (url.searchParams.get('email') ?? '').trim().toLowerCase()
  const rows = await env.DB.prepare(
    `SELECT d.id, d.engagement_id, d.company, d.contact, d.created_at, d.used_at, d.cleared_at, d.purged_at, d.files, d.pages, d.asks_used,
       (SELECT COUNT(*) FROM questions q WHERE q.demo_id = d.id) AS questions
     FROM demos d WHERE ?1 = '' OR lower(d.contact) = ?1 OR substr(lower(d.contact), -(length(?1) + 2)) = '<' || ?1 || '>'
     ORDER BY d.created_at DESC, d.rowid DESC LIMIT 500`,
  ).bind(email).all<DemoRow>()
  return json(200, { demos: rows.results })
}

/** One demo for /admin: its files with each page's text (live, else archived) and every question. */
async function adminDemo(id: string, env: Env): Promise<Response> {
  const demo = await env.DB.prepare(
    `SELECT d.id, d.engagement_id, d.company, d.contact, d.created_at, d.used_at, d.cleared_at, d.purged_at, d.files, d.pages, d.asks_used,
       (SELECT COUNT(*) FROM questions q WHERE q.demo_id = d.id) AS questions FROM demos d WHERE d.id = ?`,
  ).bind(id).first<DemoRow>()
  if (demo === null) return json(404, { error: 'no demo' })
  const [files, chunks, archived, questions] = await env.DB.batch([
    env.DB.prepare('SELECT name, pages, skipped FROM files WHERE demo_id = ? ORDER BY rowid').bind(id),
    env.DB.prepare('SELECT file, page, text FROM chunks WHERE demo_id = ? ORDER BY file, page, seq, rowid').bind(id),
    env.DB.prepare('SELECT file, page, text, archived_at FROM archived_pages WHERE demo_id = ? ORDER BY file, page').bind(id),
    env.DB.prepare('SELECT id, asked_at, question, answer, sources, checked, fallback, ms, keep FROM questions WHERE demo_id = ? ORDER BY asked_at, rowid').bind(id),
  ])
  type Page = { page: number; text: string }
  const live = new Map<string, Map<number, string[]>>()
  for (const c of chunks.results as { file: string; page: number; text: string }[]) {
    const pages = live.get(c.file) ?? new Map<number, string[]>()
    pages.set(c.page, [...(pages.get(c.page) ?? []), c.text])
    live.set(c.file, pages)
  }
  const kept = new Map<string, Page[]>()
  for (const a of archived.results as { file: string; page: number; text: string }[]) kept.set(a.file, [...(kept.get(a.file) ?? []), { page: a.page, text: a.text }])
  const names = [...new Set([...(files.results as { name: string }[]).map((f) => f.name), ...kept.keys()])]
  const listed = new Map((files.results as { name: string; pages: number; skipped: string }[]).map((f) => [f.name, f]))
  return json(200, {
    demo,
    files: names.map((name) => {
      const index = live.get(name)
      return {
        name,
        pages: listed.get(name)?.pages ?? kept.get(name)?.length ?? 0,
        in_index: index !== undefined,
        archived: kept.has(name),
        text: index !== undefined
          ? [...index.entries()].sort(([a], [b]) => a - b).map(([page, parts]) => ({ page, text: parts.join('\n') }))
          : kept.get(name) ?? [],
      }
    }),
    questions: (questions.results as Record<string, unknown>[]).map((q) => ({ ...q, sources: JSON.parse(String(q.sources ?? '[]')) })),
  })
}

/**
 * Kept questions as JSONL for a golden set: each with its sources and the archived text of
 * every cited page and the pages either side. The answer is the model's, never checked by a
 * person, and is labelled so: build-evals takes required facts from the source text only.
 */
async function golden(url: URL, env: Env): Promise<Response> {
  const from = url.searchParams.get('from') || '0000'
  const to = url.searchParams.get('to') || '9999'
  const demoId = url.searchParams.get('demo') ?? ''
  const rows = await env.DB.prepare(
    `SELECT q.id, q.demo_id, d.company, q.asked_at, q.question, q.answer, q.fallback, q.checked, q.sources
     FROM questions q JOIN demos d ON d.id = q.demo_id
     WHERE q.keep = 1 AND q.asked_at >= ?1 AND q.asked_at < ?2 || 'z' AND (?3 = '' OR q.demo_id = ?3)
     ORDER BY q.asked_at, q.rowid`,
  ).bind(from, to, demoId).all<{ id: string; demo_id: string; company: string | null; asked_at: string; question: string; answer: string | null; fallback: string | null; checked: number; sources: string }>()
  const lines: string[] = []
  for (const q of rows.results) {
    const sources = (JSON.parse(q.sources) as { file: string; page: number; last_page?: number }[]).map((s) => ({ file: s.file, page: s.page, ...(s.last_page ? { last_page: s.last_page } : {}) }))
    const wanted = new Set<string>()
    // The cited pages and one either side, as (file, page) pairs; keyed by their JSON, since a Set compares arrays by identity.
    for (const s of sources) for (let p = s.page - 1; p <= (s.last_page ?? s.page) + 1; p++) if (p >= 1) wanted.add(JSON.stringify([s.file, p]))
    // One query per question (D1 caps the queries a request may make), at most 45 pages (90 bound values) each.
    const pairs = [...wanted].slice(0, 45).map((key) => JSON.parse(key) as [string, number])
    const pages: { file: string; page: number; text: string }[] = pairs.length === 0 ? [] : (await env.DB.prepare(
      `SELECT file, page, text FROM archived_pages WHERE demo_id = ? AND (file, page) IN (VALUES ${pairs.map(() => '(?, ?)').join(', ')})`,
    ).bind(q.demo_id, ...pairs.flat()).all<{ file: string; page: number; text: string }>()).results
    pages.sort((a, b) => a.file.localeCompare(b.file) || a.page - b.page)
    lines.push(JSON.stringify({
      demo: q.demo_id, company: q.company, asked_at: q.asked_at, question: q.question,
      model_answer_unverified: q.answer, fallback: q.fallback, checked: q.checked === 1, sources, pages,
    }))
  }
  return new Response(lines.map((line) => `${line}\n`).join(''), { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' } })
}

async function route(request: Request, env: Env, models: Models, options: Options): Promise<Response> {
  const url = new URL(request.url)
  const { pathname } = url
  if (pathname === '/internal/demos' && request.method === 'POST') return createDemo(request, env)
  if (request.method === 'GET' && pathname === '/internal/admin/demos') return adminDemos(url, env)
  if (request.method === 'GET' && pathname.startsWith('/internal/admin/demos/')) return adminDemo(decodeURIComponent(pathname.slice('/internal/admin/demos/'.length)), env)
  if (request.method === 'GET' && pathname === '/internal/admin/golden') return golden(url, env)
  if (pathname === '/internal/demos/which' && request.method === 'POST') return whichDemos(request, env)
  if (pathname === '/internal/demos/open' && request.method === 'POST') return openDemo(request, env)
  // Everything below is a visitor's route: the key the proxy forwards must name a live demo.
  const demo = await signedIn(request, env)
  if (demo === null) {
    // `expired` tells the page that a key it has is no longer good (purged, or re-keyed), as against no key at all.
    return json(401, { error: 'signed out', expired: (request.headers.get('X-Demo-Key') ?? '') !== '' })
  }
  if (pathname === '/api/session' && request.method === 'GET') return session(demo, env)
  if (pathname === '/api/files' && request.method === 'POST') return upload(request, env, models, demo)
  if (pathname === '/api/files' && request.method === 'DELETE') return remove(request, env, models, demo)
  if (pathname === '/api/ask' && request.method === 'POST') return ask(request, env, models, demo, options)
  return json(404, { error: 'not found' })
}

export function createApp(modelsFor: (env: Env) => Models, options: Options = {}) {
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      try {
        // `modelsFor(env)` on every request: `env` exists only inside a handler, never at module load.
        return await route(request, env, modelsFor(env), options)
      } catch (error) {
        console.error('demo: the request failed', error)
        return json(500, { error: 'Something went wrong. Please try again in a minute.' })
      }
    },
    async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
      await purge(env, modelsFor(env))
      await expire(env)
    },
  }
}
