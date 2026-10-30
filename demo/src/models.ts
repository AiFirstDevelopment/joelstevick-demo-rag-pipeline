// Copyright (c) 2026 Joel Stevick
// SPDX-License-Identifier: MIT
// Licensed under the MIT License: https://opensource.org/licenses/MIT

/**
 * The models the demo calls, each behind a small interface so the suite can
 * script them: Claude (the rerank and the answer), the embedding model and the
 * vector index.
 */
import type { Chunk } from './retrieval'

export const ANSWER_MODEL = 'claude-sonnet-5-5'
export const RERANK_MODEL = 'claude-haiku-5-5'
export const EMBEDDING_MODEL = '@cf/baai/bge-m3'

/** One JSON reply from Claude, parsed. Throws on anything else, so the caller degrades. */
export type Claude = (request: {
  model: string
  system: string
  user: string
  schema: Record<string, unknown>
  maxTokens: number
  timeoutMs: number
  /** How hard the model thinks, where the model's default does not fit. */
  effort?: 'low'
}) => Promise<unknown>

/** An embedding: one text as a point in the embedding model's space (bge-m3: 1,024 numbers). */
export type Vector = number[]

export type Embed = (texts: string[]) => Promise<Vector[]>

export interface Vectors {
  upsert(namespace: string, items: { id: string; values: Vector }[]): Promise<void>
  /** The nearest ids in `namespace`, best first. */
  query(namespace: string, values: Vector, topK: number): Promise<string[]>
  deleteByIds(ids: string[]): Promise<void>
}

export interface Models {
  claude: Claude
  embed?: Embed
  vectors?: Vectors
}

/** Claude through the Messages API, with structured output and no retries. */
export function claudeFor(apiKey: string | undefined): Claude {
  return async ({ model, system, user, schema, maxTokens, timeoutMs, effort }) => {
    if (apiKey === undefined || apiKey === '') throw new Error('no ANTHROPIC_API_KEY')
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      // The timeout aborts the request itself, so a slow model throws instead of holding the ask.
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
        // Structured output: the schema makes the reply JSON of this shape, so `JSON.parse` below is enough.
        output_config: { format: { type: 'json_schema', schema }, ...(effort === undefined ? {} : { effort }) },
      }),
    })
    const body = (await response.json()) as { content?: { type: string; text?: string }[]; error?: { message?: string } }
    if (!response.ok) throw new Error(`Anthropic ${response.status}: ${body.error?.message ?? ''}`)
    const text = (body.content ?? []).filter((block) => block.type === 'text').map((block) => block.text ?? '').join('')
    return JSON.parse(text)
  }
}

export function embedFor(ai: Ai | undefined): Embed | undefined {
  if (ai === undefined) return undefined
  // `ai.run` is typed per model; cast once to what bge-m3 returns: one vector per text, in order.
  const run = ai.run.bind(ai) as unknown as (model: string, input: unknown) => Promise<{ data: Vector[] }>
  return async (texts) => (await run(EMBEDDING_MODEL, { text: texts })).data
}

export function vectorsFor(index: VectorizeIndex | undefined): Vectors | undefined {
  if (index === undefined) return undefined
  return {
    async upsert(namespace, items) {
      // Every vector is written under the demo's namespace, so a query in that namespace sees that demo's vectors alone.
      await index.upsert(items.map((item) => ({ ...item, namespace })))
    },
    async query(namespace, values, topK) {
      // Vectorize returns matches best first; only the ids are kept, the chunks are read from D1 by id.
      return (await index.query(values, { topK, namespace })).matches.map((match) => match.id)
    },
    async deleteByIds(ids) {
      await index.deleteByIds(ids)
    },
  }
}

/**
 * How many chunks the answer is written from: about 11,000 characters, room for
 * every entry of a two-page résumé. A question asking for every one of something
 * needs every passage that holds one; five left half of them out.
 */
export const ANSWER_CHUNKS = 12

const RERANK_RULES = `You choose which passages answer a question about a set of documents.
You are given the question and a numbered list of passages.
Return the numbers of the passages that answer the question, best first, at most ${ANSWER_CHUNKS}.
When the question asks for every one of something (every job, every date, every fee), include every passage that holds one.
Return an empty list if none answers it.`

/**
 * The chunks the answer is written from: Claude Haiku's choice from the pool
 * first, as in howards-lantern-rag-pipeline/worker/src/law-rerank.ts
 * (`haikuRerankFor`, `chooseLaws`), then the rest of the pool by fusion, up to
 * ANSWER_CHUNKS. The reranker orders the context; it does not cut it, because a
 * passage it passed over may still hold part of the answer. Failing or naming a
 * passage it was not given, the pool by fusion alone.
 */
export async function rerank(claude: Claude, question: string, pool: Chunk[]): Promise<Chunk[]> {
  if (pool.length === 0) return []
  try {
    const reply = (await claude({
      model: RERANK_MODEL,
      system: RERANK_RULES,
      // Passages go in numbered by position, [0] onward; the model answers with those numbers.
      user: `Question: ${question}\n\nPassages:\n\n${pool.map((chunk, index) => `[${index}] ${chunk.text}`).join('\n\n')}`,
      schema: { type: 'object', properties: { ranked: { type: 'array', items: { type: 'integer' } } }, required: ['ranked'], additionalProperties: false },
      // Haiku 5.5 thinks first, inside this limit: at 256 its thinking spent the tokens before
      // the list was written (4 of 25 eval questions, evals/runs), and with thinking off it
      // ranked worse. Low effort and room to finish.
      maxTokens: 1024,
      effort: 'low',
      // 48 passages took up to 4.3 s in the evals: 5 s left too little room before the fallback.
      timeoutMs: 8000,
    })) as { ranked?: unknown }
    const ranked = reply.ranked
    // A number outside the list means the model named a passage it was not given: the whole reply is distrusted.
    if (!Array.isArray(ranked) || ranked.some((n) => !Number.isInteger(n) || n < 0 || n >= pool.length)) {
      throw new Error(`the reranker named passages that were not given: ${JSON.stringify(reply)}`)
    }
    // `ranked` holds positions in `pool`, the `[index]` labels the passages were sent under: not
    // ids, not text. `includes` below is by object identity, on the same Chunk objects.
    const chosen = [...new Set(ranked as number[])].map((n) => pool[n])
    // The chosen first, then the rest of the pool in fusion order, cut to ANSWER_CHUNKS.
    return [...chosen, ...pool.filter((chunk) => !chosen.includes(chunk))].slice(0, ANSWER_CHUNKS)
  } catch (error) {
    console.error('demo ask: the reranker did not answer', error)
    // Fallback: the pool in fusion order.
    return pool.slice(0, ANSWER_CHUNKS)
  }
}

const ANSWER_RULES = `You answer a question from passages of the asker's own documents, and from nothing else.
Answer in two to four short sentences, in plain words, with figures in digits exactly as the passages state them.
Put the ids of the passages you used (for example "a1b2c3-4") in "sources".
Do not write file names or page numbers: they are shown under your answer.
When the question asks for every one of something, name every one the passages give in a single sentence, separated by semicolons, and cite every passage you named one from.
If no passage answers the question, leave "answer" empty and "sources" empty.
Never write that the passages or the documents do not say something: you see only some of them, so leave the answer empty instead.`

/** Sonnet's answer, unchecked. Throws when the model fails, so the ask can be given back. */
export async function answer(claude: Claude, question: string, given: Chunk[]): Promise<{ answer: string; sources: string[] }> {
  const pages = (chunk: Chunk) => (chunk.lastPage !== undefined && chunk.lastPage > chunk.page ? `pages ${chunk.page}–${chunk.lastPage}` : `page ${chunk.page}`)
  // Each passage goes in under its id and its place in the file; the answer's sources must copy those ids.
  const listed = given.map((chunk) => `[${chunk.id}] (${chunk.file}, ${pages(chunk)})\n${chunk.text}`).join('\n\n')
  const reply = (await claude({
    model: ANSWER_MODEL,
    system: ANSWER_RULES,
    user: `Question: ${question}\n\nPassages:\n\n${listed}`,
    schema: {
      type: 'object',
      properties: { answer: { type: 'string' }, sources: { type: 'array', items: { type: 'string' } } },
      required: ['answer', 'sources'],
      additionalProperties: false,
    },
    // Sonnet 5.5 thinks before answering, inside this limit: 600 left answers within a few
    // tokens of being cut off (eval questions book-14, book-15).
    maxTokens: 2000,
    timeoutMs: 30_000,
  })) as { answer?: unknown; sources?: unknown }
  // Anything but a string answer and an array of sources is a failure, not an answer; a non-string source is dropped.
  if (typeof reply.answer !== 'string' || !Array.isArray(reply.sources)) throw new Error('the answer model replied out of shape')
  return { answer: reply.answer, sources: reply.sources.filter((id): id is string => typeof id === 'string') }
}
