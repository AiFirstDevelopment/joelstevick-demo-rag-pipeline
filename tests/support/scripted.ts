// Copyright (c) 2026 Joel Stevick
// SPDX-License-Identifier: MIT
// Licensed under the MIT License: https://opensource.org/licenses/MIT

/**
 * The models the suite runs the demo with, so nothing in it calls Anthropic or
 * Workers AI. Steered by markers in the question:
 *
 *   [model-down]        the answer model throws
 *   [rerank-down]       the reranker throws
 *   [cite-unretrieved]  the answer cites an id it was not given
 *   [invent-figure]     the answer states $4,200, which no chunk does
 *   [loose]             the answer paraphrases its chunk instead of quoting it
 *   [whole-line]        the answer is the whole first line of its chunk, a numbered list and all
 *   [vectors-down]      the embedding model throws, so the ask has BM25 alone
 *   [pick:w1 w2]        the reranker chooses only the passages holding w1, then w2
 *   [span]              the answer is the whole of its first passage, on one line
 *   [items]             the answer is a list: one item per sentence of its first passage
 *   [invent-item]       a list whose second item states $4,200, which no chunk does
 *   [long-item]         a list whose one item is the first three sentences of its first passage
 *
 * A question about jobs or a role is answered from the "<role> at <employer>,
 * <year> to <year>" entries in the passages it was given, and from nothing
 * else: every entry for "what jobs", the one whose employer the question names
 * otherwise, and no answer when none matches. "What jobs" is answered as a list,
 * as the answer rules ask: a lead-in, then one item per job ("<role> at
 * <employer>, <year> to <year>"); when the question asks for a sentence each, each
 * item is a sentence ("He was <role> at <employer> from <year> to <year>.") and
 * there is no lead-in.
 *
 * Otherwise the answer is the first sentence of the first chunk it was given,
 * citing that chunk. The reranker keeps the pool's order and honours the
 * "at most N" its rules give it.
 */
import { ANSWER_MODEL, RERANK_MODEL, type Claude, type Embed, type Models, type Vector, type Vectors } from '../../demo/src/models'

// An entry may wrap across a line, as it does in a PDF.
const ENTRY = /([A-Z][a-z]+(?:\s[A-Z][a-z]+)*)\sat\s([A-Z][a-z]+(?:\s[A-Z][a-z]+)*),\s(\d{4})\sto\s(\d{4})/g
const flat = (text: string) => text.replace(/\s+/g, ' ')

function jobs(question: string, passages: string): { answer: string; items?: string[]; sources: string[] } {
  const entries = [...passages.matchAll(/^\[([^\]]+)\] \([^\n]*\)\n([\s\S]*?)(?=\n\n\[|$(?![\s\S]))/gm)]
    .flatMap(([, id, text]) => [...text.matchAll(ENTRY)].map(([, role, employer, from, to]) => ({ id, role: flat(role), employer: flat(employer), from, to })))
  const asked = entries.filter((e) => question.includes(e.employer))
  if (asked.length > 0) {
    const e = asked[0]
    return { answer: `He was ${e.role} at ${e.employer} from ${e.from} to ${e.to}.`, sources: [e.id] }
  }
  if (!/\bjobs\b/i.test(question) || entries.length === 0) return { answer: '', sources: [] }
  const sources = [...new Set(entries.map((e) => e.id))]
  // "One sentence each": a list of sentences, one per job, with no lead-in.
  if (/\beach\b/i.test(question)) {
    return { answer: '', items: entries.map((e) => `He was ${e.role} at ${e.employer} from ${e.from} to ${e.to}.`), sources }
  }
  // "What jobs": a lead-in and one short item per job.
  return { answer: 'He has held these jobs:', items: entries.map((e) => `${e.role} at ${e.employer}, ${e.from} to ${e.to}`), sources }
}

export const claude: Claude = async ({ model, system, user }) => {
  const question = /^Question: (.*)$/m.exec(user)?.[1] ?? ''
  if (model === RERANK_MODEL) {
    if (question.includes('[rerank-down]')) throw new Error('scripted: the reranker is down')
    const count = (user.match(/^\[\d+\] /gm) ?? []).length
    const pick = /\[pick:([^\]]+)\]/.exec(question)
    if (pick !== null) {
      const passages = [...user.matchAll(/^\[(\d+)\] (.*)$/gm)].map(([, n, text]) => ({ n: Number(n), text: text.toLowerCase() }))
      return { ranked: pick[1].split(' ').flatMap((word) => passages.filter((p) => p.text.includes(word)).map((p) => p.n)) }
    }
    const most = Number(/at most (\d+)/.exec(system)?.[1] ?? count)
    return { ranked: Array.from({ length: Math.min(count, most) }, (_, i) => i) }
  }
  if (model === ANSWER_MODEL) {
    if (question.includes('[model-down]')) throw new Error('scripted: the answer model is down')
    if (/\b(jobs|role)\b/i.test(question)) return jobs(question, user.split('Passages:\n\n')[1] ?? '')
    const first = /^\[([^\]]+)\] \([^\n]*\)\n([^\n]*)/m.exec(user.split('Passages:\n\n')[1] ?? '')
    if (first === null) return { answer: '', sources: [] }
    const [, id, text] = first
    const sentence = /^.*?[.!?](?=\s|$)/.exec(text)?.[0] ?? text
    if (question.includes('[cite-unretrieved]')) return { answer: sentence, sources: ['nowhere-0'] }
    if (question.includes('[invent-figure]')) return { answer: 'It costs $4,200 a year.', sources: [id] }
    if (question.includes('[whole-line]')) return { answer: text, sources: [id] }
    if (question.includes('[span]')) {
      const whole = /^\[[^\]]+\] \([^\n]*\)\n([\s\S]*?)(?=\n\n\[|$(?![\s\S]))/m.exec(user.split('Passages:\n\n')[1] ?? '')?.[1] ?? text
      return { answer: flat(whole), sources: [id] }
    }
    // The list markers: the first passage, flattened, cut into its sentences.
    const passage = /^\[[^\]]+\] \([^\n]*\)\n([\s\S]*?)(?=\n\n\[|$(?![\s\S]))/m.exec(user.split('Passages:\n\n')[1] ?? '')?.[1] ?? text
    const said = flat(passage).match(/[^.!?]+[.!?]/g)?.map((one) => one.trim()) ?? [flat(passage)]
    if (question.includes('[items]')) return { answer: '', items: said, sources: [id] }
    if (question.includes('[invent-item]')) return { answer: 'The steps:', items: [said[0], 'It costs $4,200.'], sources: [id] }
    if (question.includes('[long-item]')) return { answer: '', items: [said.slice(0, 3).join(' ')], sources: [id] }
    if (question.includes('[loose]')) return { answer: `Roughly speaking, ${sentence.toLowerCase()}`, sources: [id] }
    return { answer: sentence, sources: [id] }
  }
  throw new Error(`scripted: no script for ${model}`)
}

const DIMENSIONS = 1024

/** A bag of hashed words, normalised: texts sharing words are near. */
export const embed: Embed = async (texts) => {
  if (texts.some((text) => text.includes('[vectors-down]'))) throw new Error('scripted: Workers AI is down')
  return texts.map((text) => {
    const values = new Array<number>(DIMENSIONS).fill(0)
    for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      let h = 2166136261
      for (const c of word) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
      values[(h >>> 0) % DIMENSIONS] += 1
    }
    const norm = Math.hypot(...values) || 1
    return values.map((v) => v / norm)
  })
}

/** An in-memory Vectorize that honours namespaces the way the real one does. */
export class ScriptedVectors implements Vectors {
  readonly store = new Map<string, { namespace: string; values: Vector }>()
  failing = false

  async upsert(namespace: string, items: { id: string; values: Vector }[]) {
    for (const item of items) this.store.set(item.id, { namespace, values: item.values })
  }

  async query(namespace: string | undefined, values: Vector, topK: number) {
    if (this.failing) throw new Error('scripted: Vectorize is down')
    return [...this.store.entries()]
      .filter(([, v]) => namespace === undefined || v.namespace === namespace)
      .map(([id, v]) => ({ id, score: v.values.reduce((sum, x, i) => sum + x * values[i], 0) }))
      .filter((match) => match.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((match) => match.id)
  }

  async deleteByIds(ids: string[]) {
    for (const id of ids) this.store.delete(id)
  }
}

export function scriptedModels(vectors: ScriptedVectors): Models {
  return { claude, embed, vectors }
}
