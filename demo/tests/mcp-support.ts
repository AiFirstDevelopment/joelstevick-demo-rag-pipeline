// Copyright (c) 2026 Joel Stevick
// SPDX-License-Identifier: MIT
// Licensed under the MIT License: https://opensource.org/licenses/MIT

// What the MCP server's tests share: a demo with documents, an OAuth client that connects the way
// an MCP host does (discovery from the 401, registration, the consent page, PKCE, the token), and
// the SDK's own client pointed at the Worker.
import { env } from 'cloudflare:test'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import schema from '../schema.sql?raw'
import { createApp, type Env } from '../src/app'
import { ScriptedVectors, scriptedModels } from '../../tests/support/scripted'

export const SITE = 'https://joelstevick.com'
export const MCP = `${SITE}/mcp/demo`
const REDIRECT = 'http://127.0.0.1:53111/callback'

export interface World {
  app: ReturnType<typeof createApp>
  env: Env
  vectors: ScriptedVectors
}

/** A fresh Worker: an empty D1 and an empty OAuth store. */
export async function world(): Promise<World> {
  const kv = (env as unknown as { OAUTH_KV: KVNamespace }).OAUTH_KV
  for (const statement of schema.replace(/--.*$/gm, '').split(';').map((s) => s.trim()).filter(Boolean)) await env.DB.prepare(statement).run()
  await env.DB.batch(['chunks', 'files', 'questions', 'archived_pages', 'demos', 'mcp_hits'].map((table) => env.DB.prepare(`DELETE FROM ${table}`)))
  for (;;) {
    const { keys } = await kv.list()
    if (keys.length === 0) break
    await Promise.all(keys.map((key) => kv.delete(key.name)))
  }
  const vectors = new ScriptedVectors()
  return { app: createApp(() => scriptedModels(vectors), { scripted: true }), env: { DB: env.DB, OAUTH_KV: kv }, vectors }
}

/** A request as the site forwards it: the site's own URL, the caller's address, and the demo cookie's key when there is one. */
export function site(w: World, path: string, init: RequestInit & { key?: string } = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  if (init.key !== undefined) headers.set('X-Demo-Key', init.key)
  if (!headers.has('X-Client-Address')) headers.set('X-Client-Address', '203.0.113.7')
  return w.app.fetch(new Request(path.startsWith('http') ? path : `${SITE}${path}`, { ...init, headers, redirect: 'manual' }), w.env, context)
}

/** What the Worker asked to finish after its response (waitUntil), so a test can wait for it before the next one starts. */
const pending: Promise<unknown>[] = []
const context = { waitUntil: (work: Promise<unknown>) => { pending.push(work.catch(() => {})) }, passThroughOnException() {}, props: {} } as unknown as ExecutionContext

async function demoCall(w: World, path: string, key: string | null, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (key !== null) headers['X-Demo-Key'] = key
  const response = await w.app.fetch(new Request(`https://demo${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), w.env)
  return { status: response.status, headers: response.headers, body: (await response.json()) as any }
}

export const page = (w: World, path: string, key: string, body?: unknown, method?: string) => demoCall(w, path, key, body, method)

export async function newDemo(w: World, fingerprint: string): Promise<{ key: string; id: string }> {
  return (await demoCall(w, '/internal/demos', null, { fingerprint, company: 'Acme', contact: 'Ada Lovelace <ada@acme.test>' })).body
}

export const upload = (w: World, key: string, name: string, pages: string[]) =>
  demoCall(w, '/api/files', key, { name, page_count: pages.length, pages: pages.map((text, i) => ({ page: i + 1, text })) })

const b64url = (bytes: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** What discovery finds, starting from nothing but the server's URL. */
export async function discover(w: World) {
  const first = await site(w, MCP, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: '{}' })
  const challenge = first.headers.get('WWW-Authenticate') ?? ''
  const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1] ?? ''
  const resource = (await (await site(w, metadataUrl)).json()) as { resource: string; authorization_servers: string[]; scopes_supported?: string[] }
  const issuer = resource.authorization_servers[0]
  const server = (await (await site(w, `${issuer}/.well-known/oauth-authorization-server`)).json()) as Record<string, any>
  return { status: first.status, challenge, metadataUrl, resource, issuer, server }
}

export interface Connected {
  token: string
  refresh?: string
  clientId: string
  scope: string
  tokenEndpoint: string
}

export interface Consent {
  /** The consent page as the browser got it. */
  html: string
  status: number
  /** Where the decision is posted, and the cookies the page set. */
  url: string
  cookie: string
  handle: string
  clientId: string
  verifier: string
  tokenEndpoint: string
}

/** Registers a client and opens the consent page in a browser holding `key`'s demo cookie (or none). */
export async function consent(w: World, key: string | undefined, options: { name?: string; scope?: string; query?: Record<string, string> } = {}): Promise<Consent> {
  const found = await discover(w)
  const registered = (await (await site(w, found.server.registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: options.name ?? 'Test Host', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
  })).json()) as { client_id: string }
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)))
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
  const url = new URL(found.server.authorization_endpoint)
  for (const [name, value] of Object.entries({
    response_type: 'code', client_id: registered.client_id, redirect_uri: REDIRECT, scope: options.scope ?? 'docs:read docs:write offline_access',
    state: 'st-1', code_challenge: challenge, code_challenge_method: 'S256', resource: found.resource.resource, ...options.query,
  })) url.searchParams.set(name, value)
  const shown = await site(w, url.href, { key })
  const html = await shown.text()
  const cookie = ((shown.headers as unknown as { getSetCookie(): string[] }).getSetCookie()).map((line) => line.split(';')[0]).join('; ')
  return {
    html, status: shown.status, url: url.href, cookie, handle: /name="handle" value="([^"]+)"/.exec(html)?.[1] ?? '',
    clientId: registered.client_id, verifier, tokenEndpoint: found.server.token_endpoint,
  }
}

/** Presses Allow or Deny on a consent page. `write` ticks "Remove a file". */
export async function decide(w: World, key: string | undefined, shown: Consent, decision: 'approve' | 'deny', write = false): Promise<Response> {
  const form = new URLSearchParams({ handle: shown.handle, decision })
  if (write) form.append('scope', 'docs:write')
  if (shown.html.includes('name="offline"')) form.append('offline', '1')
  return site(w, shown.url, { method: 'POST', key, headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: shown.cookie }, body: form.toString() })
}

/** Exchanges an authorization code for tokens, with the PKCE verifier. */
export async function exchange(w: World, shown: Consent, code: string): Promise<Response> {
  return site(w, shown.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: shown.clientId, code_verifier: shown.verifier, resource: MCP }).toString(),
  })
}

/** The whole flow: discovery, registration, consent, the code and the token. */
export async function connect(w: World, key: string, options: { write?: boolean; name?: string } = {}): Promise<Connected> {
  const shown = await consent(w, key, { name: options.name })
  const allowed = await decide(w, key, shown, 'approve', options.write === true)
  const code = new URL(allowed.headers.get('Location') ?? 'http://none/').searchParams.get('code') ?? ''
  const tokens = (await (await exchange(w, shown, code)).json()) as { access_token: string; refresh_token?: string; scope: string }
  return { token: tokens.access_token, refresh: tokens.refresh_token, clientId: shown.clientId, scope: tokens.scope, tokenEndpoint: shown.tokenEndpoint }
}

const opened: Client[] = []
/** Closes every client a test opened, so nothing of it is still running when the next test's storage is set up. */
export async function closeClients(): Promise<void> {
  await Promise.all(opened.splice(0).map((one) => one.close().catch(() => {})))
  while (pending.length > 0) await Promise.all(pending.splice(0))
}

/** The SDK's own client on the Worker, as a 2026-07-28 client ('modern') or a 2025 one ('legacy'). */
export async function client(w: World, token: string, era: 'modern' | 'legacy' = 'modern', address = '203.0.113.7'): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(MCP), {
    fetch: (input, init) => site(w, String(input instanceof Request ? input.url : input), { ...(init as RequestInit), headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), 'X-Client-Address': address } }),
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  })
  const made = new Client({ name: 'test-host', version: '1.0.0' }, era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {})
  await made.connect(transport)
  opened.push(made)
  return made
}

/** A raw MCP request, for what the status and headers say. Its body is read to the end, so the request is over when this returns. */
export async function raw(w: World, token: string | null, body: unknown, address?: string): Promise<Response> {
  const response = await site(w, MCP, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      ...(token === null ? {} : { Authorization: `Bearer ${token}` }), ...(address === undefined ? {} : { 'X-Client-Address': address }),
    },
    body: JSON.stringify(body),
  })
  return new Response(await response.text(), { status: response.status, headers: response.headers })
}
