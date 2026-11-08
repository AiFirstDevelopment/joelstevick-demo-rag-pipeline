// Copyright (c) 2026 Joel Stevick
// SPDX-License-Identifier: MIT
// Licensed under the MIT License: https://opensource.org/licenses/MIT

/**
 * Whether an answer may be shown, decided here and nowhere else.
 *
 * Ported from Howard's Lantern's worker/src/learner-ask.ts
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

/** The numbers spelled as one word up to twelve, indexed by value: NUMBER_WORDS[5] is 'five'. */
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve']

/** The larger spelled numbers, each a figure on its own: "thirty" states 30 even outside a compound. */
const LARGER_WORDS: Record<string, number> = {
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  hundred: 100, thousand: 1000,
}
/** One to nineteen: the words a compound adds as they are ("twenty-five" is 20 + 5). */
const UNITS: Record<string, number> = Object.fromEntries(
  [...NUMBER_WORDS.slice(1), 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']
    .map((word, index) => [word, index + 1]),
)
/** The tens a compound adds before its unit. */
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 }

/** Spelled compounds as the numbers they are: "five hundred" is 500, "twenty-five" 25. */
function compounds(text: string): number[] {
  const out: number[] = []
  // total: what the run reached at its last "thousand"; chunk: the part since then, still open to "hundred";
  // open: whether a run of number words is under way.
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
    // Reached only by a number word: the run is under way.
    open = true
  }
  // The text may end on a number word, so the last run is emitted too.
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
  // Every run of digits is a figure, as written.
  const found = new Set<string>(normalised.match(/\d+/g) ?? [])
  // Spelled numbers up to twelve, as whole words, except "one" (see above).
  const lower = normalised.toLowerCase()
  NUMBER_WORDS.forEach((word, value) => {
    if (value !== 1 && new RegExp(`\\b${word}\\b`).test(lower)) found.add(String(value))
  })
  // The larger spelled numbers, each counted on its own.
  for (const word of lower.match(/[a-z]+/g) ?? []) {
    if (LARGER_WORDS[word] !== undefined) found.add(String(LARGER_WORDS[word]))
  }
  // Spelled compounds as their value ("five hundred" adds 500); one that comes to 1 is the pronoun again, so skipped.
  for (const value of compounds(normalised)) if (value !== 1) found.add(String(value))
  return found
}

/**
 * Sentences, not list numbers: "Contents: 1. Talking to a Model; 2. The Loop" is one sentence.
 * A list number starts the text or follows ":", ";", "," or a line break; a figure ending a
 * sentence ("The fee was 5.") follows a word, and still ends it.
 */
export function sentences(text: string): number {
  return sentenceParts(text).length
}

/** The sentences themselves, by the rule `sentences` counts with. */
export function sentenceParts(text: string): string[] {
  // Split at the whitespace after ".", "!" or "?", except after a list number of up to three digits that starts the
  // text or follows ":", ";", "," or a line break; empty parts are not counted.
  return text.split(/(?<=[.!?])(?<!(?:^|[:;,]\s*|\n)\d{1,3}\.)\s+(?=\S)/).filter((part) => part.trim().length > 0)
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

/**
 * Checks the model's reply against the passages it was given and the question, in this order: something was
 * said, every source is a given chunk, every figure is grounded, and the length is within bounds.
 */
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
  // Each id matched to its given chunk, or null when no given chunk has that id.
  const cited = ids.map((id) => given.find((chunk) => chunk.id === id) ?? null)
  if (cited.some((chunk) => chunk === null)) return { ok: false, reason: 'uncited' }
  // No null is left past the check above: these are the cited chunks, in the order they were cited.
  const sources = cited as Chunk[]
  // Figures, by contrast, are compared as text on purpose: a number in the answer must appear,
  // written the same way, in a cited passage or in the question. Every list item is checked the
  // same way as the lead-in: a figure that appears only in a bullet is still a figure shown.
  const grounded = new Set<string>()
  for (const chunk of sources) for (const figure of figuresIn(chunk.text)) grounded.add(figure)
  for (const figure of figuresIn(question)) grounded.add(figure)
  // The first figure stated by no cited passage and not by the question refuses the whole answer.
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

/**
 * The streamed answer, one unit at a time (docs/plans/demo-stream.md). The model writes plain text
 * with the ids of the passages each sentence rests on in square brackets (`… a $50 ticket
 * [a1b2c3-4].`), and a list as lines that start with "- ", each ending with its ids. A unit is one
 * prose sentence, found by the rule `sentences` uses, or one list line; a run of markers after a
 * sentence's full stop belongs to that sentence.
 */
export type UnitKind = 'lead' | 'sentence' | 'item'

/** One complete unit of the model's text, its markers still in it. */
export interface RawUnit {
  kind: UnitKind
  raw: string
}

/**
 * A citation marker: one or more chunk ids in square brackets, "[a1b2c3-4]" or
 * "[a1b2c3-4, d5e6f7-8]". An id is letters, digits and underscores with at least one dash in it,
 * which every chunk id has (`<demo>-<upload>-<n>`, app.ts), so a bracketed word of the model's
 * own ("[sic]") is not read as a citation. Global, so `replace` and `matchAll` see every marker.
 */
const MARKER = /\[\s*([A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)+(?:\s*[,;]\s*[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)+)*)\s*\]/g

/**
 * Where each prose sentence ends, in text that still has its markers. Read left to right:
 *   (?<=[.!?])                       just after a full stop, "!" or "?";
 *   (?<!(?:^|[:;,]\s*|\n)\d{1,3}\.)  but not after a list number ("1." at the start or after
 *                                    ":", ";", "," or a line break), the same rule as `sentences`;
 *   ((?:\s*\[[^\]\n]*\])*)           then any run of markers, captured, so they stay with the
 *                                    sentence they follow ("...30 days [a1-2]." or "...days. [a1-2]");
 *   \s+(?=[^\s[])                    then whitespace, and ahead of it the next sentence's first
 *                                    character, which is not another marker.
 * A sentence is complete only when the text after it has begun, so a full stop at the very end of
 * the text so far does not end a unit: the model may still be writing that sentence's markers.
 */
const PROSE_END = /(?<=[.!?])(?<!(?:^|[:;,]\s*|\n)\d{1,3}\.)((?:\s*\[[^\]\n]*\])*)\s+(?=[^\s[])/g

/**
 * The prose sentences of `text` that are complete, and the remainder still being written. Each
 * match of PROSE_END marks the end of one sentence (its markers included, which is why the match's
 * first group is counted into the sentence); the next sentence starts after the whitespace.
 */
function proseUnits(text: string): { done: string[]; rest: string } {
  const done: string[] = []
  let start = 0
  for (const match of text.matchAll(PROSE_END)) {
    const end = (match.index ?? 0) + match[1].length
    done.push(text.slice(start, end))
    start = (match.index ?? 0) + match[0].length
  }
  return { done, rest: text.slice(start) }
}

/**
 * The complete units of the text so far, in order: prose sentences, a list's lead-in, and list
 * items. With `final`, the stream has ended and what is left is the last unit.
 *
 * This is called again after every piece of the model's reply, on the whole text so far, and it
 * must be stable: the units it returns for a text are the leading units it returns for any longer
 * text that begins the same way. Then the caller (app.ts, `release`) can slice off the units it
 * has already dealt with and take only the new ones, and a unit once released is never revised.
 * Stability is why the line being written is set aside, why a sentence needs the next one to have
 * begun, and why a lone "-" waits.
 */
export function units(text: string, final: boolean): RawUnit[] {
  const out: RawUnit[] = []
  // Lines, because a list item is one line: the model writes each as "- ..." on a line of its own.
  const lines = text.split('\n')
  // The last line is still being written unless the stream has ended: it is held back and looked at separately below.
  const open = final ? null : lines.pop() ?? ''
  // Prose gathered from the completed lines, until a list line or the end completes it.
  let prose = ''
  // A list line completes the prose before it: its sentences, and the rest as the list's lead-in.
  const lead = () => {
    const { done, rest } = proseUnits(prose)
    for (const raw of done) out.push({ kind: 'sentence', raw })
    if (rest.trim().length > 0) out.push({ kind: 'lead', raw: rest })
    prose = ''
  }
  for (const line of lines) {
    if (line.startsWith('- ')) {
      // A completed list line is a whole item; the prose before it, if any, is the list's lead-in.
      lead()
      out.push({ kind: 'item', raw: line.slice(2) })
    } else if (line.trim().length > 0) {
      // A completed prose line joins the prose; a sentence may run over several lines.
      prose += (prose.length > 0 ? '\n' : '') + line
    }
  }
  // The line being written: once it starts "- " it is a list line, and the prose before it is complete;
  // a lone "-" waits to see which it is.
  if (open !== null) {
    if (open.startsWith('- ')) lead()
    else if (open !== '-' && open.trim().length > 0) prose += (prose.length > 0 ? '\n' : '') + open
  }
  if (final) {
    // The end of the stream completes whatever prose is left: a last sentence with no full stop, or a lead-in with no list.
    const { done, rest } = proseUnits(prose)
    for (const raw of done) out.push({ kind: 'sentence', raw })
    if (rest.trim().length > 0) out.push({ kind: 'sentence', raw: rest })
  } else {
    // Only the sentences already followed by another are complete.
    for (const raw of proseUnits(prose).done) out.push({ kind: 'sentence', raw })
  }
  return out
}

/**
 * A unit's text as shown: its markers out, the space they leave before punctuation closed up
 * ("30 days [a1-2]." becomes "30 days."), and runs of whitespace made one space. This is done
 * before `figuresIn` reads the text, since an id's digits would otherwise count as figures.
 */
export function unmarked(raw: string): string {
  return raw.replace(MARKER, ' ').replace(/[ \t]+([.,;:!?])/g, '$1').replace(/\s+/g, ' ').trim()
}

/** The ids a unit cites, in the order it cites them, each once: the group inside each marker, split at its commas. */
export function idsIn(raw: string): string[] {
  return [...new Set([...raw.matchAll(MARKER)].flatMap((m) => m[1].split(/\s*[,;]\s*/)))]
}

/** How many prose sentences and list items have been released so far. */
export interface Counts {
  prose: number
  items: number
}

/** A group's verdict: when `ok`, each unit's text to show, and the chunks the group cites. */
export type UnitsChecked =
  | { ok: true; units: { kind: UnitKind; text: string }[]; cited: Chunk[] }
  | { ok: false; reason: 'empty' | 'uncited' | 'ungrounded' | 'overlong' }

/** Whether a unit cites nothing of its own, and so waits for the next one (`checkUnits`). */
export const uncited = (unit: RawUnit) => idsIn(unit.raw).length === 0

/**
 * Checks units released together as `checkAnswer` checks a whole reply. Usually one unit; a
 * sentence the model wrote without ids ("No, it is a small loss.") is held and released with the
 * next unit that has them, checked against that unit's passages (Joel, 2026-10-30). The group must
 * cite at least one id and every id must be a given chunk; every figure in every unit of it must be
 * in a passage it cites or in the question, read after the markers are taken out (ids hold digits);
 * and no unit may be the fifth prose sentence, the thirteenth item, or an item longer than
 * MAX_ITEM_SENTENCES. `counts` are the units released before the group.
 */
export function checkUnits(group: RawUnit[], given: Chunk[], question: string, counts: Counts): UnitsChecked {
  // The texts as they would be shown, markers out. A unit that was only markers says nothing.
  const texts = group.map((unit) => unmarked(unit.raw))
  if (texts.some((text) => text.length === 0)) return { ok: false, reason: 'empty' }
  // Every id the group cites, matched to a given chunk by id, exactly, as `checkAnswer` matches
  // them: one that matches none (misspelt, invented, or from outside the context) fails the group.
  const ids = [...new Set(group.flatMap((unit) => idsIn(unit.raw)))]
  if (ids.length === 0) return { ok: false, reason: 'uncited' }
  const cited = ids.map((id) => given.find((chunk) => chunk.id === id) ?? null)
  if (cited.some((chunk) => chunk === null)) return { ok: false, reason: 'uncited' }
  const sources = cited as Chunk[]
  // Figures are compared as text: a number in any unit of the group must appear, written the same
  // way, in a passage the group cites or in the question. A held sentence is covered by the
  // passages of the sentence it is released with, which is what makes holding it safe.
  const grounded = new Set<string>()
  for (const chunk of sources) for (const figure of figuresIn(chunk.text)) grounded.add(figure)
  for (const figure of figuresIn(question)) grounded.add(figure)
  for (const text of texts) for (const figure of figuresIn(text)) if (!grounded.has(figure)) return { ok: false, reason: 'ungrounded' }
  // The caps, counted on from what was released before this group: the fifth prose sentence or
  // the thirteenth item fails, as does an item longer than MAX_ITEM_SENTENCES. Refused rather
  // than trimmed, as before: the answer stops at four or twelve and says so.
  let { prose, items } = counts
  for (const [i, unit] of group.entries()) {
    if (unit.kind === 'item') {
      if (++items > MAX_ITEMS || sentences(texts[i]) > MAX_ITEM_SENTENCES) return { ok: false, reason: 'overlong' }
    } else if (++prose > MAX_SENTENCES) {
      return { ok: false, reason: 'overlong' }
    }
  }
  return { ok: true, units: group.map((unit, i) => ({ kind: unit.kind, text: texts[i] })), cited: sources }
}
