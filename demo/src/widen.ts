// Copyright (c) 2026 Joel Stevick
// SPDX-License-Identifier: MIT
// Licensed under the MIT License: https://opensource.org/licenses/MIT

/**
 * The passages the answer is written from: each chunk the reranker chose,
 * joined with the chunk before it and the chunk after it in the same file.
 *
 * The idea of Howard's Lantern's worker/src/learner-ask.ts
 * (`wholeSections`, "Hop 6"): there the rest of each chosen statute's section
 * is added after the rerank, under a character budget. A PDF has no sections,
 * so here the unit is the neighbouring chunk. A chunk is cut at a sentence end,
 * so a rule and its exception are often split across two chunks, and the
 * reranker picks only the half that matches the question's words.
 */
import type { Chunk } from './retrieval'

/** The neighbours added stop here: 12 × 900, so the answer's context at most doubles. */
export const WIDEN_CHARS = 10_800

/**
 * `given` widened, in the reranker's order. A run of neighbouring chunks is one
 * passage, under the id of its first given chunk, so nothing is sent twice. A
 * chunk without `seq` (stored before the order was) is never widened, and is
 * never anyone's neighbour.
 */
export function widen(given: Chunk[], all: Chunk[]): Chunk[] {
  const bySeq = new Map<string, Chunk>()
  for (const chunk of all) if (chunk.seq != null) bySeq.set(`${chunk.file}\u0000${chunk.seq}`, chunk)
  const at = (file: string, seq: number) => bySeq.get(`${file}\u0000${seq}`)

  // Every chunk that goes in: the given ones always, then their neighbours under the budget.
  // `taken` and `placed` are sets of Chunk objects, so `has` is by identity, not text: `given`
  // holds the very objects `all` does (fuseKeywordAndVector and rerank pass them through unchanged).
  const taken = new Set<Chunk>(given)
  // One budget, in characters, shared by the whole call: not per chunk, not per side.
  let added = 0
  // In the reranker's order, so the best-ranked chunks get their neighbours first.
  for (const chunk of given) {
    // A chunk stored before the order existed has no known neighbours.
    if (chunk.seq == null) continue
    // One neighbour each side: the chunk just before and the chunk just after, in the same file.
    for (const seq of [chunk.seq - 1, chunk.seq + 1]) {
      const neighbour = at(chunk.file, seq)
      // Skipped if there is none (the file's edge), it is already in, or it would overspend the budget.
      if (neighbour === undefined || taken.has(neighbour) || added + neighbour.text.length > WIDEN_CHARS) continue
      taken.add(neighbour)
      added += neighbour.text.length
    }
  }

  // Each given chunk's run of taken neighbours, the first time one of its chunks is reached.
  const placed = new Set<Chunk>()
  const passages: Chunk[] = []
  for (const chunk of given) {
    // Already inside an earlier chunk's run: it went out there, once.
    if (placed.has(chunk)) continue
    const run = [chunk]
    if (chunk.seq != null) {
      // Walk outward each way while the next chunk was taken. A run grows past a chunk's own two
      // neighbours only where given chunks lie close together in the file.
      for (let seq = chunk.seq - 1, c = at(chunk.file, seq); c !== undefined && taken.has(c); c = at(chunk.file, --seq)) run.unshift(c)
      for (let seq = chunk.seq + 1, c = at(chunk.file, seq); c !== undefined && taken.has(c); c = at(chunk.file, ++seq)) run.push(c)
    }
    for (const c of run) placed.add(c)
    // Nothing was added around it: the chunk goes as it is.
    if (run.length === 1) {
      passages.push(chunk)
      continue
    }
    // A run is one passage, under its given chunk's id, spanning the run's pages, the texts joined.
    const pages = run.map((c) => c.page)
    passages.push({
      id: chunk.id,
      file: chunk.file,
      page: Math.min(...pages),
      lastPage: Math.max(...pages),
      text: run.map((c) => c.text).join('\n'),
    })
  }
  return passages
}
