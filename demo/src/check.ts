// Copyright (c) 2026 Joel Stevick
// SPDX-License-Identifier: MIT
// Licensed under the MIT License: https://opensource.org/licenses/MIT

/**
 * Whether an answer may be shown, decided here and nowhere else.
 *
 * Ported from howards-lantern-rag-pipeline/worker/src/learner-ask.ts
 * (`numbersIn`, `figuresIn`, `compounds`, `checkLawAnswer`), English only: every
 * id the answer cites must be a chunk it was given, and every figure it states
 * must be in a chunk it cites (or in the question).
 */
import type { Chunk } from './retrieval'

/**
 * The longest ordinary answer, in sentences. The demo page promises "two to four sentences",
 * and a reply longer than this is refused rather than trimmed (see `checkAnswer`).
 */
export const MAX_SENTENCES = 4

/**
 * The most items a list answer may have.
 *
 * Why lists exist: a visitor asked "what jobs have i held - 1 sentence each" of a two-page
 * résumé. The answer was right, but it came back as one long run-on sentence with the seven jobs
 * separated by semicolons, because a prose answer is held to MAX_SENTENCES and the page showed
 * it as a single paragraph. An answer that names several things of one kind (every job, every
 * fee, every chapter) now comes back as a list instead: a short lead-in in `answer` and one
 * entry per thing in `items`, which the page draws as bullets.
 *
 * Why 12: it matches ANSWER_CHUNKS (12, models.ts), the number of passages the reranker chooses,
 * and it is room for a two-page résumé's jobs or a document's chapters with space to spare. It
 * is a ceiling, not a target: a list longer than this is refused, not cut, so a runaway reply is
 * never shown and a list is never silently shortened by the check.
 * (The number is repeated here rather than imported from models.ts so that this file, the one
 * that decides what may be shown, depends on nothing but the chunk type.)
 */
export const MAX_ITEMS = 12

/**
 * The most sentences a list's lead-in, or any one of its items, may have.
 *
 * An item is meant to be one sentence or a phrase ("Team Lead, Zonar Systems, 2021 to 2026").
 * Two leaves room for a short second sentence the model adds for clarity, without letting one
 * item grow into a paragraph that hides the list's shape. The lead-in gets the same allowance.
 */
export const MAX_ITEM_SENTENCES = 2

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve']

const LARGER_WORDS: Record<string, number> = {
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  hundred: 100, thousand: 1000,
}
const UNITS: Record<string, number> = Object.fromEntries(
  [...NUMBER_WORDS.slice(1), 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']
    .map((word, index) => [word, index + 1]),
)
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 }

/** Spelled compounds as the numbers they are: "five hundred" is 500, "twenty-five" 25. */
function compounds(text: string): number[] {
  const out: number[] = []
  let total = 0
  let chunk = 0
  let open = false
  // A run of number words has ended: emit what it added up to, and start fresh.
  const close = () => {
    if (open) out.push(total + chunk)
    total = 0
    chunk = 0
    open = false
  }
  // Units and tens add to the run, hundred and thousand scale it, 'and' joins it, any other word ends it.
  for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    if (UNITS[word] !== undefined) chunk += UNITS[word]
    else if (TENS[word] !== undefined) chunk += TENS[word]
    else if (word === 'hundred' && open) chunk = (chunk === 0 ? 1 : chunk) * 100
    else if (word === 'thousand' && open) (total += (chunk === 0 ? 1 : chunk) * 1000), (chunk = 0)
    else if (word === 'and' && open) continue
    else {
      close()
      continue
    }
    open = true
  }
  close()
  return out
}

/**
 * Every figure a text states, as digit strings. "4,200" is one figure; "0.5" is
 * read as ".5". The word "one" is a pronoun more often than a figure and is
 * not counted; the digit 1 is.
 */
export function figuresIn(text: string): Set<string> {
  // Thousands separators out ("4,200" is 4200) and a leading zero off ("0.5" is .5), so one figure is one token however it was written.
  const normalised = text.replace(/(\d),(?=\d{3}(?!\d))/g, '$1').replace(/\b0(\.\d)/g, '$1')
  const found = new Set<string>(normalised.match(/\d+/g) ?? [])
  const lower = normalised.toLowerCase()
  NUMBER_WORDS.forEach((word, value) => {
    if (value !== 1 && new RegExp(`\\b${word}\\b`).test(lower)) found.add(String(value))
  })
  for (const word of lower.match(/[a-z]+/g) ?? []) {
    if (LARGER_WORDS[word] !== undefined) found.add(String(LARGER_WORDS[word]))
  }
  for (const value of compounds(normalised)) if (value !== 1) found.add(String(value))
  return found
}

/**
 * Sentences, not list numbers: "Contents: 1. Talking to a Model; 2. The Loop" is one sentence.
 * A list number starts the text or follows ":", ";", "," or a line break; a figure ending a
 * sentence ("The fee was 5.") follows a word, and still ends it.
 */
export function sentences(text: string): number {
  return text.split(/(?<=[.!?])(?<!(?:^|[:;,]\s*|\n)\d{1,3}\.)\s+(?=\S)/).filter((part) => part.trim().length > 0).length
}

/** The answer model's reply, unchecked: prose in `answer`, or a lead-in in `answer` and a list in `items`. */
export interface Reply {
  answer: string
  /** One entry per thing the answer names, when it is a list; empty or absent for prose. */
  items?: string[]
  sources: string[]
}

/**
 * The verdict. When `ok`, `answer` and `items` are what the page shows, trimmed, and `cited`
 * holds the given chunks the answer cites, in the order it cited them.
 */
export type Checked =
  | { ok: true; answer: string; items: string[]; cited: Chunk[] }
  | { ok: false; reason: 'empty' | 'uncited' | 'ungrounded' | 'overlong' }

export function checkAnswer(reply: Reply, given: Chunk[], question: string): Checked {
  const answer = reply.answer.trim()
  // A list's entries, trimmed; an empty entry is dropped rather than shown as an empty bullet.
  const items = (reply.items ?? []).map((item) => item.trim()).filter((item) => item.length > 0)
  // `reply.sources` are chunk ids, copied by the model from the `[id]` label each given passage
  // carried. Each is matched to a given chunk by id, exactly; one that matches none (misspelt,
  // invented, or from outside the context) fails the whole answer as `uncited`.
  const ids = [...new Set(reply.sources)]
  // No answer (neither prose nor a list), or one citing nothing: the model's own "no passage
  // answers it", shown as the fallback.
  if ((answer.length === 0 && items.length === 0) || ids.length === 0) return { ok: false, reason: 'empty' }
  const cited = ids.map((id) => given.find((chunk) => chunk.id === id) ?? null)
  if (cited.some((chunk) => chunk === null)) return { ok: false, reason: 'uncited' }
  const sources = cited as Chunk[]
  // Figures, by contrast, are compared as text on purpose: a number in the answer must appear,
  // written the same way, in a cited passage or in the question. Every list item is checked the
  // same way as the lead-in: a figure that appears only in a bullet is still a figure shown.
  const grounded = new Set<string>()
  for (const chunk of sources) for (const figure of figuresIn(chunk.text)) grounded.add(figure)
  for (const figure of figuresIn(question)) grounded.add(figure)
  for (const text of [answer, ...items]) {
    for (const figure of figuresIn(text)) if (!grounded.has(figure)) return { ok: false, reason: 'ungrounded' }
  }
  // Length, refused rather than trimmed: a trimmed answer could drop the sentence or the item a
  // citation was for.
  if (items.length === 0) {
    // Prose: the page promises two to four sentences.
    if (sentences(answer) > MAX_SENTENCES) return { ok: false, reason: 'overlong' }
  } else {
    // A list: at most MAX_ITEMS entries, and the lead-in and each entry short. The allowance
    // comes from the shape of the reply, not from the question's wording. A list can be longer in
    // all than prose may be (a two-sentence lead-in and twelve two-sentence items is 26
    // sentences); what is bounded is each piece, so no single bullet becomes a paragraph and the
    // whole stays a list a reader can scan, never a long answer in one block.
    if (items.length > MAX_ITEMS) return { ok: false, reason: 'overlong' }
    if ([answer, ...items].some((text) => sentences(text) > MAX_ITEM_SENTENCES)) return { ok: false, reason: 'overlong' }
  }
  return { ok: true, answer, items, cited: sources }
}
