// Copyright (c) 2026 Joel Stevick
// SPDX-License-Identifier: MIT
// Licensed under the MIT License: https://opensource.org/licenses/MIT

/**
 * Which chunks a question is answered from: BM25 over the demo's own chunks,
 * fused by reciprocal rank with the vector index's nearest.
 *
 * Ported from Howard's Lantern's worker/src/law-retrieval.ts
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

/** Words too common to tell chunks apart, dropped from the question and the chunks alike so they neither match nor score. */
const STOP = new Set(
  'a an and are as at be by can could do does for from how i if in is it its me my of on or should so that the their them there this to was what when where which who why will with would you your'.split(' '),
)

/** A text as the tokens BM25 compares: lower-cased runs of letters and digits, stop words out, a plain plural's "s" off. */
export function words(text: string): string[] {
  // Anything but a letter or digit separates tokens, so punctuation and case never stop a match.
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((word) => !STOP.has(word))
    // "invoices" must find "invoice"; "bus" must not become "bu".
    .map((word) => (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word))
}

/** The chunks sharing words with `question`, best first. A chunk with no word of the question is never returned. */
export function bm25(chunks: Chunk[], question: string, limit: number): Chunk[] {
  if (chunks.length === 0) return []
  // Document frequency: for each word, how many chunks contain it (the n of the idf below).
  const frequency = new Map<string, number>()
  // Each chunk reduced once to its length in tokens and its count of each word (its tf), so scoring never re-reads the text.
  const docs = chunks.map((chunk) => {
    const counts = new Map<string, number>()
    const tokens = words(chunk.text)
    for (const word of tokens) counts.set(word, (counts.get(word) ?? 0) + 1)
    // Once per chunk, not per occurrence: idf asks how many chunks hold the word, not how often it is written.
    for (const word of counts.keys()) frequency.set(word, (frequency.get(word) ?? 0) + 1)
    return { length: tokens.length, counts }
  })
  // The average chunk length, which each chunk's length is measured against; `|| 1` avoids dividing by zero when no chunk has a word.
  const average = docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length || 1
  // The question's distinct words: a word asked twice is scored once.
  const asked = [...new Set(words(question))]
  // The usual BM25 constants. k1 sets how fast repeats of a word stop adding score (the second occurrence adds far more
  // than the tenth); b sets how much a chunk's length counts against it (0 not at all, 1 in full proportion).
  const k1 = 1.2
  const b = 0.75
  return docs
    .map((doc, index) => {
      let score = 0
      for (const word of asked) {
        // n: how many chunks hold the word; tf: how often this chunk does. A word this chunk lacks adds nothing.
        const n = frequency.get(word)
        const tf = doc.counts.get(word) ?? 0
        if (n === undefined || tf === 0) continue
        // idf: a word held by few chunks says more about a chunk than one held by most, so it weighs more. The + 0.5s keep
        // the ratio finite when a word is in every chunk, and the 1 + keeps idf positive, so a common word adds a little, never less than nothing.
        const idf = Math.log(1 + (chunks.length - n + 0.5) / (n + 0.5))
        // tf saturates through k1, and is divided by the chunk's length relative to the average, so a long chunk does not
        // outscore a short one just by holding more words.
        score += (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * doc.length) / average))
      }
      return { chunk: chunks[index], score }
    })
    // A chunk with no word of the question scores 0 and is dropped, so keyword search names only real matches and
    // fusion never gives a non-match a rank.
    .filter((scored) => scored.score > 0)
    // Highest score first, cut to `limit`, the scores dropped.
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
export function fuseKeywordAndVector(chunks: Chunk[], question: string, limit: number, near: string[] = []): Chunk[] {
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
