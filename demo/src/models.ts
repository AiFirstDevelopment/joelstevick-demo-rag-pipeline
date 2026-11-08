// Copyright (c) 2026 Joel Stevick
// SPDX-License-Identifier: MIT
// Licensed under the MIT License: https://opensource.org/licenses/MIT

/**
 * The models the demo calls, each behind a small interface so the suite can
 * script them: Claude (the rerank and the answer), the embedding model and the
 * vector index.
 */
import type { Chunk } from './retrieval'

/** Claude Sonnet writes the answer; Claude Haiku, faster and cheaper, reranks; bge-m3 on Workers AI embeds the chunks and the question. */
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

/**
 * Claude's reply as it is written: the text, a piece at a time, through the Messages API's
 * streaming. It is an `AsyncIterable<string>`: the caller reads it with `for await`, each value
 * being the next few characters of the reply, and leaving the loop early stops the call. Throws
 * when the call fails, before or during the text, so the caller degrades. The suite scripts one in
 * tests/support/scripted.ts (`stream`); the deployed demo uses `claudeStreamFor`.
 */
export type ClaudeStream = (request: {
  model: string
  system: string
  user: string
  maxTokens: number
  timeoutMs: number
}) => AsyncIterable<string>

/** An embedding: one text as a point in the embedding model's space (bge-m3: 1,024 numbers). */
export type Vector = number[]

/** The texts as vectors, one per text, in the same order. */
export type Embed = (texts: string[]) => Promise<Vector[]>

/** The vector index, holding each demo's chunk vectors in a namespace of its own. */
export interface Vectors {
  /** Writes each id's vector into `namespace`, replacing any vector already stored under that id. */
  upsert(namespace: string, items: { id: string; values: Vector }[]): Promise<void>
  /** The nearest ids in `namespace`, best first. */
  query(namespace: string, values: Vector, topK: number): Promise<string[]>
  /** Removes these ids' vectors, whatever namespace they are in. */
  deleteByIds(ids: string[]): Promise<void>
}

/** What a demo calls. Without `embed` or `vectors` (no Workers AI or Vectorize binding), it answers from keyword search alone. */
export interface Models {
  claude: Claude
  /** The answer model, streamed. */
  stream: ClaudeStream
  embed?: Embed
  vectors?: Vectors
}

/** Claude through the Messages API, with structured output and no retries. */
export function claudeFor(apiKey: string | undefined): Claude {
  return async ({ model, system, user, schema, maxTokens, timeoutMs, effort }) => {
    // No key: throw at once, so the caller degrades exactly as it does when the model fails.
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
    // The body is read whether or not the call succeeded, since an error reply carries its message.
    const body = (await response.json()) as { content?: { type: string; text?: string }[]; error?: { message?: string } }
    if (!response.ok) throw new Error(`Anthropic ${response.status}: ${body.error?.message ?? ''}`)
    // The reply's text blocks, joined; any other block, such as the model's thinking, is skipped.
    const text = (body.content ?? []).filter((block) => block.type === 'text').map((block) => block.text ?? '').join('')
    // Text that is not JSON throws here, which the caller treats as a failed call.
    return JSON.parse(text)
  }
}

/**
 * Claude through the Messages API, streamed, with no retries: the `text_delta` pieces of the reply
 * in order, as an async generator.
 *
 * With `stream: true` the API answers with a server-sent event stream instead of one JSON body.
 * The events that matter here, in the order they come:
 *   message_start          the reply has begun (its input token count is here; the eval trace reads it);
 *   content_block_start    a block begins: `thinking` first, since the model thinks before it writes,
 *                          then `text`;
 *   content_block_delta    a piece of the current block: `thinking_delta` (skipped here) or
 *                          `text_delta`, whose `text` is the next few characters of the answer;
 *   message_delta          the end is near: the stop reason and the output token count;
 *   message_stop           the end.
 * Only the `text_delta` pieces are yielded; the thinking is never shown or checked. An `error`
 * event (the API overloaded mid-reply) throws, which the caller treats as the model failing.
 */
export function claudeStreamFor(apiKey: string | undefined): ClaudeStream {
  return async function* ({ model, system, user, maxTokens, timeoutMs }) {
    // No key: throw at once, so the caller degrades exactly as it does when the model fails.
    if (apiKey === undefined || apiKey === '') throw new Error('no ANTHROPIC_API_KEY')
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      // The timeout covers the whole reply, streamed or not: a model that stalls mid-answer aborts
      // the body, which throws out of the `for await` below.
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      // No `output_config`: the answer is plain text with inline citations (ANSWER_RULES), not JSON.
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }], stream: true }),
    })
    // An error reply (a bad key, a rate limit) is one JSON body, not a stream; its message is kept.
    if (!response.ok || response.body === null) {
      const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } }
      throw new Error(`Anthropic ${response.status}: ${body.error?.message ?? ''}`)
    }
    // Each server-sent event's data is one JSON object; only the text pieces are passed on.
    for await (const event of serverEvents(response.body)) {
      const data = JSON.parse(event.data) as { type?: string; delta?: { type?: string; text?: string }; error?: { message?: string } }
      if (data.type === 'content_block_delta' && data.delta?.type === 'text_delta') yield data.delta.text ?? ''
      else if (data.type === 'error') throw new Error(`Anthropic stream: ${data.error?.message ?? ''}`)
    }
  }
}

/**
 * The events of a server-sent event stream, each with its name and its data, as an async generator.
 *
 * The wire format (text/event-stream) is lines: "event: <name>", one or more "data: <text>",
 * other fields ignored here, and a blank line ending each event. The body arrives in chunks that
 * end anywhere, mid-line included, so the decoded text is kept in `buffer` and only whole events,
 * those followed by a blank line, are taken out of it; the remainder waits for the next chunk.
 */
export async function* serverEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  // Bytes to text as they come; a multi-byte character split across two chunks is joined by the decoder.
  const reader = body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  // The `finally` runs however the generator ends: the stream read to its end, an exception, or
  // the caller leaving its `for await` early (`return()` on the generator). Cancelling the reader
  // then cancels the HTTP body, so a reply the demo has stopped reading (a sentence failed its
  // check) is not read, or paid for, to its end.
  try {
    for (;;) {
      const { value, done } = await reader.read()
      // Line endings normalised, so the blank line that ends an event is always "\n\n".
      if (value !== undefined) buffer += value.replace(/\r\n/g, '\n')
      // Each event ends at a blank line; what follows the last one waits for more.
      let end: number
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        // An event with no "event:" line is named "message", as the standard says.
        let event = 'message'
        const data: string[] = []
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim()
          // Several "data:" lines are one payload, joined with newlines; the space after the colon is not part of it.
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
        }
        // A block with no data (a comment, a bare "event:" line) is not an event.
        if (data.length > 0) yield { event, data: data.join('\n') }
      }
      if (done) return
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
}

/** bge-m3 on Workers AI as an `Embed`; undefined without the AI binding, so the demo runs on keywords alone. */
export function embedFor(ai: Ai | undefined): Embed | undefined {
  if (ai === undefined) return undefined
  // `ai.run` is typed per model; cast once to what bge-m3 returns: one vector per text, in order.
  const run = ai.run.bind(ai) as unknown as (model: string, input: unknown) => Promise<{ data: Vector[] }>
  return async (texts) => (await run(EMBEDDING_MODEL, { text: texts })).data
}

/** The Vectorize index as `Vectors`; undefined without the binding. */
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
      // Vectorize deletes by id alone; a chunk id starts with its demo's id, so only that demo's vectors go.
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
 * first, as in Howard's Lantern's worker/src/law-rerank.ts
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

/**
 * The answer model's instructions. The shape and length rules here and the check in check.ts
 * (`checkUnit`) must agree: an answer these rules ask for must pass the check, or the visitor
 * is shown "couldn't find that" for an answer that was right. So:
 *
 *   - an ordinary answer is prose, two to four sentences (check.ts MAX_SENTENCES, 4), each ending
 *     with the ids it rests on, since each sentence is checked and shown on its own;
 *   - an answer that names several things of one kind (every job, every fee, every chapter), or
 *     one the question asks to have a sentence or a line each, is a list: one "- " line per thing,
 *     at most 12 (check.ts MAX_ITEMS), each a phrase or one sentence (the check allows two,
 *     MAX_ITEM_SENTENCES), after at most a one-sentence lead-in. The page draws the lines as
 *     bullets.
 *
 * A list asked for implicitly counts: "what jobs have I held" is a list as much as "list my jobs".
 * Before lists, such an answer was one sentence with semicolons between the items, which read as
 * a run-on paragraph.
 *
 * When there are more than 12, the model lists the first 12 and its lead-in says the list is
 * not complete, so the visitor is never shown a shortened list as if it were the whole. The
 * lead-in says so without a count ("These are the first jobs listed; the list is not complete."):
 * the figure check reads "12" or "twelve" as a figure, and refuses an answer stating one that no
 * cited passage states, so "the first 12" would turn a right answer into "couldn't find that".
 */
const ANSWER_RULES = `You answer a question from passages of the asker's own documents, and from nothing else.
Write in plain words, with figures in digits exactly as the passages state them.
End every sentence with the ids of the passages it rests on, in square brackets, for example "Refunds are paid within 30 days [a1b2c3-4]." or "[a1b2c3-4, d5e6f7-8]" for two. Every sentence, without exception: a short opening sentence, a sentence that continues the one before it, and the sentence introducing a list end with their ids too, as in "No [a1b2c3-4]. Writing to the cache costs more than reading it [a1b2c3-4]." or "He has held these jobs [a1b2c3-4, d5e6f7-8]:". Each sentence is checked against the passages it cites before it is shown.
Do not write file names or page numbers: they are shown under your answer.
When the answer names several things of one kind (every job, every fee, every chapter), or the question asks for a sentence or a line for each one, answer with a list: at most one short sentence introducing it, ending with its ids, or nothing, then one line per thing starting with "- ", each a short phrase or one sentence ending with its ids, with no blank line before the list. Name every one the passages give. If there are more than 12, list the first 12 and say in the introduction that the list is not complete, in words and without a count.
Otherwise answer in two to four short sentences.
Write nothing else: no heading, no closing remark.
If no passage answers the question, write nothing at all.
Never write that the passages or the documents do not say something: you see only some of them, so write nothing instead.`

/**
 * Sonnet's answer as it is written, unchecked: text with inline citations, a piece at a time.
 * Nothing is read here: the stream is returned for app.ts to iterate, and the call to the model
 * only starts when it does. Throws (out of the caller's `for await`) when the model fails.
 */
export function answer(stream: ClaudeStream, question: string, given: Chunk[]): AsyncIterable<string> {
  // A widened passage that runs past its first page is labelled with the range of pages.
  const pages = (chunk: Chunk) => (chunk.lastPage !== undefined && chunk.lastPage > chunk.page ? `pages ${chunk.page}–${chunk.lastPage}` : `page ${chunk.page}`)
  // Each passage goes in under its id and its place in the file; the answer's citations must copy those ids.
  const listed = given.map((chunk) => `[${chunk.id}] (${chunk.file}, ${pages(chunk)})\n${chunk.text}`).join('\n\n')
  return stream({
    model: ANSWER_MODEL,
    system: ANSWER_RULES,
    user: `Question: ${question}\n\nPassages:\n\n${listed}`,
    // Sonnet 5.5 thinks before answering, inside this limit: 600 left answers within a few
    // tokens of being cut off (eval questions book-14, book-15).
    maxTokens: 2000,
    timeoutMs: 30_000,
  })
}
