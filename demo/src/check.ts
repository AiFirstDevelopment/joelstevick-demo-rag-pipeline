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

export const MAX_SENTENCES = 4

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

export interface Reply {
  answer: string
  sources: string[]
}

export type Checked = { ok: true; answer: string; cited: Chunk[] } | { ok: false; reason: 'empty' | 'uncited' | 'ungrounded' | 'overlong' }

export function checkAnswer(reply: Reply, given: Chunk[], question: string): Checked {
  const answer = reply.answer.trim()
  // `reply.sources` are chunk ids, copied by the model from the `[id]` label each given passage
  // carried. Each is matched to a given chunk by id, exactly; one that matches none (misspelt,
  // invented, or from outside the context) fails the whole answer as `uncited`.
  const ids = [...new Set(reply.sources)]
  // No answer, or one citing nothing: the model's own "no passage answers it", shown as the fallback.
  if (answer.length === 0 || ids.length === 0) return { ok: false, reason: 'empty' }
  const cited = ids.map((id) => given.find((chunk) => chunk.id === id) ?? null)
  if (cited.some((chunk) => chunk === null)) return { ok: false, reason: 'uncited' }
  const sources = cited as Chunk[]
  // Figures, by contrast, are compared as text on purpose: a number in the answer must appear,
  // written the same way, in a cited passage or in the question.
  const grounded = new Set<string>()
  for (const chunk of sources) for (const figure of figuresIn(chunk.text)) grounded.add(figure)
  for (const figure of figuresIn(question)) grounded.add(figure)
  for (const figure of figuresIn(answer)) if (!grounded.has(figure)) return { ok: false, reason: 'ungrounded' }
  // The page promises two to four sentences; a longer answer is refused, not trimmed.
  if (sentences(answer) > MAX_SENTENCES) return { ok: false, reason: 'overlong' }
  return { ok: true, answer, cited: sources }
}
