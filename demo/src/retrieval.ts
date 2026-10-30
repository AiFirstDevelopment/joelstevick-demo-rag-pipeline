// Copyright (c) 2026 Joel Stevick
// SPDX-License-Identifier: MIT
// Licensed under the MIT License: https://opensource.org/licenses/MIT

/**
 * Which chunks a question is answered from: BM25 over the demo's own chunks,
 * fused by reciprocal rank with the vector index's nearest.
 *
 * Ported from howards-lantern-rag-pipeline/worker/src/law-retrieval.ts
 * (`words`, `bm25`, `retrieve`): the same tokens, the same BM25 constants and
 * the same RRF k. The law-specific steps (scope, rephrase, widen, nationwide,
 * spelling repair) are left out.
 */

export interface Chunk {
  id: string
  file: string
  page: number
  text: string
  /** Its place in its file's order of chunks; null for chunks stored before the order was. */
  seq?: number | null
  /** The last page of a widened passage that runs past `page`. */
  lastPage?: number
}

/** The usual constant for reciprocal-rank fusion: it keeps one list's first place from swamping the other's. */
export const RRF_K = 60

const STOP = new Set(
  'a an and are as at be by can could do does for from how i if in is it its me my of on or should so that the their them there this to was what when where which who why will with would you your'.split(' '),
)

export function words(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((word) => !STOP.has(word))
    // "invoices" must find "invoice"; "bus" must not become "bu".
    .map((word) => (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word))
}

/** The chunks sharing words with `question`, best first. A chunk with no word of the question is never returned. */
export function bm25(chunks: Chunk[], question: string, limit: number): Chunk[] {
  if (chunks.length === 0) return []
  const frequency = new Map<string, number>()
  const docs = chunks.map((chunk) => {
    const counts = new Map<string, number>()
    const tokens = words(chunk.text)
    for (const word of tokens) counts.set(word, (counts.get(word) ?? 0) + 1)
    for (const word of counts.keys()) frequency.set(word, (frequency.get(word) ?? 0) + 1)
    return { length: tokens.length, counts }
  })
  const average = docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length || 1
  const asked = [...new Set(words(question))]
  const k1 = 1.2
  const b = 0.75
  return docs
    .map((doc, index) => {
      let score = 0
      for (const word of asked) {
        const n = frequency.get(word)
        const tf = doc.counts.get(word) ?? 0
        if (n === undefined || tf === 0) continue
        const idf = Math.log(1 + (chunks.length - n + 0.5) / (n + 0.5))
        score += (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * doc.length) / average))
      }
      return { chunk: chunks[index], score }
    })
    .filter((scored) => scored.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((scored) => scored.chunk)
}

/**
 * Picks the chunks a question should be answered from, best first, by combining
 * two rankings of the same chunks.
 *
 * Inputs:
 * - `chunks`: every chunk of the demo's documents, read from D1 by the caller.
 * - `question`: the visitor's question.
 * - `limit`: how many chunks to return.
 * - `near`: the vector search results, passed in. These are the chunk ids the
 *   vector index (Vectorize) returned as closest in meaning to the question,
 *   best first. This function does not call the vector index: the caller
 *   (`ask` in app.ts) embeds the question, queries Vectorize, and hands the ids
 *   in here. It may pass none, if there is no index or the query failed.
 *
 * The two rankings:
 * - keyword search: `bm25`, run here over `chunks`, which favours chunks that
 *   share the question's exact words;
 * - vector search: `near`, as given.
 *
 * The two are merged by reciprocal rank fusion (RRF): each chunk scores
 * 1 / (RRF_K + its rank) in each list it appears in, and the scores add up, so
 * a chunk ranked well by either search rises, and one ranked well by both
 * rises furthest.
 *
 * Only ids that are among `chunks` count: a vector id for anything else, such
 * as a chunk since deleted, is dropped here and never shown. When no vector
 * ids are left (no index, or it failed), the result is keyword search alone.
 */
export function retrieve(chunks: Chunk[], question: string, limit: number, near: string[] = []): Chunk[] {
  const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]))
  // The vector search results passed in as `near`, kept only if they are still this demo's chunks.
  const meant = near.filter((id) => byId.has(id))
  if (meant.length === 0) return bm25(chunks, question, limit)
  // Chunk id -> its summed RRF score. Ranks are 0-based, hence the + 1.
  const fused = new Map<string, number>()
  const add = (ids: string[]) => ids.forEach((id, rank) => fused.set(id, (fused.get(id) ?? 0) + 1 / (RRF_K + rank + 1)))
  // Twice as many keyword results as needed, so a chunk just below the cut can still rise by its vector rank.
  add(bm25(chunks, question, limit * 2).map((chunk) => chunk.id))
  add(meant)
  // Highest fused score first, cut to `limit`, ids turned back into chunks.
  return [...fused.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => byId.get(id) as Chunk)
}
