// Copyright (c) 2026 Joel Stevick
// SPDX-License-Identifier: MIT
// Licensed under the MIT License: https://opensource.org/licenses/MIT

// The demo Worker as the eval harness runs it: demo/src/app.ts with the same models
// the deployed one uses (Claude on the key in evals/.dev.vars, bge-m3 through Workers
// AI, the eval's own Vectorize index), plus three routes for the runner:
//   GET  /eval/trace   the model calls since the last read: model, tokens, and for the
//                      answer model the passage ids it was given
//   POST /eval/reset   every demo's questions back to zero, so one demo serves every case
//   POST /eval/forget  deletes a demo's vectors from the eval index
//   POST /eval/chunks  the stored chunks with the ids given, for scoring what the answer saw
//   POST /eval/indexed how many of a demo's vectors Vectorize has finished writing
import { createApp, type Env } from '../demo/src/app'
import { ANSWER_MODEL, RERANK_MODEL, claudeFor, embedFor, vectorsFor } from '../demo/src/models'

interface Call {
  model: string
  input_tokens: number
  output_tokens: number
  stop_reason: string | null
  ms: number
  given?: string[]
  pool?: string[]
  reply?: string
  error?: string
}

const calls: Call[] = []

// Every Anthropic call goes through fetch: read its request and usage on the way past.
// Patched once at module load, before any request: `claudeFor` calls the global `fetch`, so every Anthropic request passes here.
const realFetch = globalThis.fetch
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (!url.startsWith('https://api.anthropic.com/')) return realFetch(input, init)
  const started = Date.now()
  const sent = JSON.parse(String(init?.body ?? '{}')) as { model: string; messages: { content: string }[] }
  let response: Response
  try {
    response = await realFetch(input, init)
  } catch (error) {
    // A timeout or a dropped connection is a call too: the case shows it, not a silent fallback.
    calls.push({ model: sent.model, input_tokens: 0, output_tokens: 0, stop_reason: null, ms: Date.now() - started, error: String(error) })
    throw error
  }
  // `clone()`, so the body is read here and still readable by the caller.
  const body = (await response.clone().json().catch(() => ({}))) as {
    content?: { type: string; text?: string }[]
    usage?: { input_tokens?: number; output_tokens?: number }
    stop_reason?: string
    error?: { message?: string }
  }
  const call: Call = {
    model: sent.model,
    input_tokens: body.usage?.input_tokens ?? 0,
    output_tokens: body.usage?.output_tokens ?? 0,
    stop_reason: body.stop_reason ?? null,
    ms: Date.now() - started,
  }
  if (!response.ok) call.error = `${response.status} ${body.error?.message ?? ''}`
  call.reply = (body.content ?? []).filter((block) => block.type === 'text').map((block) => block.text ?? '').join('')
  // The reranker's passages back out of its prompt: split at the blank line before each `[n] ` label, labels stripped, in pool order.
  if (sent.model === RERANK_MODEL) call.pool = (sent.messages[0]?.content ?? '').split('Passages:\n\n')[1]?.split(/\n\n(?=\[\d+\] )/).map((p) => p.replace(/^\[\d+\] /, '')) ?? []
  // The answer prompt labels each passage `[id] (file, page)`: those ids are what the answer was given.
  if (sent.model === ANSWER_MODEL) call.given = [...(sent.messages[0]?.content ?? '').matchAll(/^\[([^\]]+)\] \(/gm)].map((m) => m[1])
  calls.push(call)
  return response
}

const app = createApp((env) => ({
  claude: claudeFor(env.ANTHROPIC_API_KEY),
  embed: embedFor(env.AI),
  vectors: vectorsFor(env.VECTORS),
}))

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url)
    // `splice(0)` hands over the calls so far and empties the list: each read is "since the last".
    if (pathname === '/eval/trace') return Response.json(calls.splice(0))
    if (pathname === '/eval/reset' && request.method === 'POST') {
      // Every demo's question count back to zero, so the ten-question limit never ends a run.
      await env.DB.prepare('UPDATE demos SET asks_used = 0').run()
      return Response.json({ ok: true })
    }
    if (pathname === '/eval/forget' && request.method === 'POST') {
      const { demo_id } = (await request.json()) as { demo_id: string }
      const ids = (await env.DB.prepare('SELECT id FROM chunks WHERE demo_id = ?').bind(demo_id).all<{ id: string }>()).results.map((r) => r.id)
      for (let i = 0; i < ids.length; i += 500) await env.VECTORS?.deleteByIds(ids.slice(i, i + 500))
      return Response.json({ deleted: ids.length })
    }
    if (pathname === '/eval/chunks' && request.method === 'POST') {
      const { ids } = (await request.json()) as { ids: string[] }
      const found = []
      for (let i = 0; i < ids.length; i += 50) {
        const part = ids.slice(i, i + 50)
        const rows = await env.DB.prepare(`SELECT id, file, page, text FROM chunks WHERE id IN (${part.map(() => '?').join(', ')})`).bind(...part).all()
        found.push(...rows.results)
      }
      return Response.json(found)
    }
    if (pathname === '/eval/indexed' && request.method === 'POST') {
      const { demo_id } = (await request.json()) as { demo_id: string }
      const ids = (await env.DB.prepare('SELECT id FROM chunks WHERE demo_id = ?').bind(demo_id).all<{ id: string }>()).results.map((r) => r.id)
      let ready = 0
      // `getByIds` returns only vectors already written, 20 a call; `ready === chunks` means the index has caught up.
      for (let i = 0; i < ids.length; i += 20) ready += (await env.VECTORS!.getByIds(ids.slice(i, i + 20))).length
      return Response.json({ chunks: ids.length, ready })
    }
    return app.fetch(request, env)
  },
}
