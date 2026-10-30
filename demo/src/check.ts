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
 * The longest answer to a question that asks for a sentence per item ("what jobs have I held,
 * one sentence each"), in sentences.
 *
 * Why it exists: a visitor asked exactly that of a two-page résumé, and the model wrote a
 * correct, fully cited answer of seven sentences, one per job. The four-sentence cap refused it
 * as `overlong`, and the visitor was told the answer could not be found. The model had done
 * what was asked; the check had not allowed for the asking.
 *
 * Why 12: it matches ANSWER_CHUNKS (12, models.ts), the number of passages the reranker chooses,
 * and it is room for a two-page résumé's jobs or a document's chapters with space to spare. A
 * passage can hold several items (one résumé page holds several jobs), so it is a judgement, not
 * a count of passages. It is a ceiling, not a target: an answer that runs past it is still
 * refused, so a runaway reply is never shown.
 * (The constant is repeated here rather than imported from models.ts so that this file, the one
 * that decides what may be shown, depends on nothing but the chunk type.)
 */
export const MAX_LIST_SENTENCES = 12

/**
 * Whether the question asks for one sentence (or one line) for each of several things, so its
 * answer may run past MAX_SENTENCES.
 *
 * It is matched on the visitor's own wording, not on the answer, so the model cannot grant
 * itself a longer answer. It needs a count of one, a length word, and then a word that spreads
 * it over the items:
 *
 *   - "1 sentence each", "one line apiece", "a single sentence each";
 *   - "one sentence per job", "a line for each employer", "one sentence for every role".
 *
 * Why so strict: "each" on its own is common in ordinary questions ("How much does each plan
 * cost?", "Does each party sign?"), and those must keep the four-sentence cap the page promises.
 * The count word keeps phrases such as "the bottom line per quarter" from matching too. A
 * per-item request worded another way ("describe every job in a sentence") does not match; its
 * long answer is then refused, never wrongly shown, which is the safe way to miss.
 *
 * A question that only asks for a list ("list the jobs I have held") does not match either: the
 * answer rules have the model name every item in one sentence separated by semicolons, which
 * fits the ordinary cap.
 */
export function asksForEach(question: string): boolean {
  return /\b(1|one|a|single)\s+(single\s+|short\s+)?(sentence|line)\s+(each|apiece|per\s+[a-z]|for\s+(each|every)\b)/i.test(question)
}

/** The sentence cap for this question: MAX_LIST_SENTENCES when it asks for one per item, MAX_SENTENCES otherwise. */
export function sentenceLimit(question: string): number {
  return asksForEach(question) ? MAX_LIST_SENTENCES : MAX_SENTENCES
}

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
  // Length. The page promises two to four sentences, so an ordinary answer longer than that is
  // refused, not trimmed: a trimmed answer could drop the sentence a citation was for. A question
  // that asks for a sentence per item ("one sentence each") is allowed one per item, up to
  // MAX_LIST_SENTENCES; past that it is refused the same way. `sentenceLimit` reads the
  // question, never the answer, so the model cannot lengthen its own allowance.
  if (sentences(answer) > sentenceLimit(question)) return { ok: false, reason: 'overlong' }
  return { ok: true, answer, cited: sources }
}
