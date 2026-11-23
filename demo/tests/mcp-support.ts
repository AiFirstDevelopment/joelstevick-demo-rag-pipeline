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
// The loopback address a desktop MCP host gets its code back on.
const REDIRECT = 'http://127.0.0.1:53111/callback'

// What a test works with: the Worker app, its bindings and its vector store.
export interface World {
  app: ReturnType<typeof createApp>
  env: Env
  vectors: ScriptedVectors
}

/** A fresh Worker: an empty D1 and an empty OAuth store. */
export async function world(): Promise<World> {
  // The KV namespace the OAuth library keeps its clients and tokens in.
  const kv = (env as unknown as { OAUTH_KV: KVNamespace }).OAUTH_KV

  // Create the tables, then empty them, so each test starts clean.
  for (const statement of schema.replace(/--.*$/gm, '').split(';').map((s) => s.trim()).filter(Boolean)) await env.DB.prepare(statement).run()
  await env.DB.batch(['chunks', 'files', 'questions', 'archived_pages', 'demos', 'mcp_hits'].map((table) => env.DB.prepare(`DELETE FROM ${table}`)))

  // KV has no clear-all, so delete its keys a page at a time until none are left.
  for (;;) {
    const { keys } = await kv.list()
    if (keys.length === 0) break
    await Promise.all(keys.map((key) => kv.delete(key.name)))
  }

  // A new vector store, and an app that uses the scripted models.
  const vectors = new ScriptedVectors()
  return { app: createApp(() => scriptedModels(vectors), { scripted: true }), env: { DB: env.DB, OAUTH_KV: kv }, vectors }
}

/** A request as the site forwards it: the site's own URL, the caller's address, and the demo cookie's key when there is one. */
export function site(w: World, path: string, init: RequestInit & { key?: string } = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  // The demo cookie's key, as the site passes it on.
  if (init.key !== undefined) headers.set('X-Demo-Key', init.key)
  // A default caller address, unless the test gave its own.
  if (!headers.has('X-Client-Address')) headers.set('X-Client-Address', '203.0.113.7')

  // Relative paths go to the site's own URL; redirects are returned, not followed.
  return w.app.fetch(new Request(path.startsWith('http') ? path : `${SITE}${path}`, { ...init, headers, redirect: 'manual' }), w.env, context)
}

/** What the Worker asked to finish after its response (waitUntil), so a test can wait for it before the next one starts. */
const pending: Promise<unknown>[] = []
const context = { waitUntil: (work: Promise<unknown>) => { pending.push(work.catch(() => {})) }, passThroughOnException() {}, props: {} } as unknown as ExecutionContext

// A JSON call to one of the demo page's own routes, with or without a demo key.
async function demoCall(w: World, path: string, key: string | null, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (key !== null) headers['X-Demo-Key'] = key

  // Call the Worker directly and read the JSON reply.
  const response = await w.app.fetch(new Request(`https://demo${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), w.env)
  return { status: response.status, headers: response.headers, body: (await response.json()) as any }
}

// A call to the demo page's routes as the visitor holding that demo's key.
export const page = (w: World, path: string, key: string, body?: unknown, method?: string) => demoCall(w, path, key, body, method)

// Creates a demo the way the site does at sign-up, and returns its key and id.
export async function newDemo(w: World, fingerprint: string): Promise<{ key: string; id: string }> {
  return (await demoCall(w, '/internal/demos', null, { fingerprint, company: 'Acme', contact: 'Ada Lovelace <ada@acme.test>' })).body
}

// Uploads a file's page texts, as the demo page sends them after reading a PDF.
export const upload = (w: World, key: string, name: string, pages: string[]) =>
  demoCall(w, '/api/files', key, { name, page_count: pages.length, pages: pages.map((text, i) => ({ page: i + 1, text })) })

// Base64url without padding, as PKCE expects.
const b64url = (bytes: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** What discovery finds, starting from nothing but the server's URL. */
export async function discover(w: World) {
  // A call with no token, which must answer 401 and say where the metadata is.
  const first = await site(w, MCP, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: '{}' })
  const challenge = first.headers.get('WWW-Authenticate') ?? ''
  const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1] ?? ''

  // Follow that to the resource metadata, then to the authorization server's.
  const resource = (await (await site(w, metadataUrl)).json()) as { resource: string; authorization_servers: string[]; scopes_supported?: string[] }
  const issuer = resource.authorization_servers[0]
  const server = (await (await site(w, `${issuer}/.well-known/oauth-authorization-server`)).json()) as Record<string, any>

  return { status: first.status, challenge, metadataUrl, resource, issuer, server }
}

// What a finished connection gives a test: the tokens and the client they belong to.
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

  // Register a public client, as an MCP host does.
  const registered = (await (await site(w, found.server.registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: options.name ?? 'Test Host', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
  })).json()) as { client_id: string }

  // A PKCE verifier and its S256 challenge.
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)))
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))

  // The authorization URL, with every parameter a host would send.
  const url = new URL(found.server.authorization_endpoint)
  for (const [name, value] of Object.entries({
    response_type: 'code', client_id: registered.client_id, redirect_uri: REDIRECT, scope: options.scope ?? 'docs:read docs:write offline_access',
    state: 'st-1', code_challenge: challenge, code_challenge_method: 'S256', resource: found.resource.resource, ...options.query,
  })) url.searchParams.set(name, value)

  // Open it in the browser, keeping the page and the cookies it set.
  const shown = await site(w, url.href, { key })
  const html = await shown.text()
  const cookie = ((shown.headers as unknown as { getSetCookie(): string[] }).getSetCookie()).map((line) => line.split(';')[0]).join('; ')

  // Hand back the form's handle and everything the next steps need.
  return {
    html, status: shown.status, url: url.href, cookie, handle: /name="handle" value="([^"]+)"/.exec(html)?.[1] ?? '',
    clientId: registered.client_id, verifier, tokenEndpoint: found.server.token_endpoint,
  }
}

/** Presses Allow or Deny on a consent page. `write` ticks "Remove a file". */
export async function decide(w: World, key: string | undefined, shown: Consent, decision: 'approve' | 'deny', write = false): Promise<Response> {
  const form = new URLSearchParams({ handle: shown.handle, decision })
  // Ask to remove files only when the test ticks the box.
  if (write) form.append('scope', 'docs:write')
  // Stay signed in when the page offers it, so a refresh token comes back.
  if (shown.html.includes('name="offline"')) form.append('offline', '1')

  // Post the form with the page's cookies, as the browser would.
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

  // Press Allow.
  const allowed = await decide(w, key, shown, 'approve', options.write === true)
  // The code comes back on the redirect to the host.
  const code = new URL(allowed.headers.get('Location') ?? 'http://none/').searchParams.get('code') ?? ''

  // Trade the code for tokens.
  const tokens = (await (await exchange(w, shown, code)).json()) as { access_token: string; refresh_token?: string; scope: string }

  return { token: tokens.access_token, refresh: tokens.refresh_token, clientId: shown.clientId, scope: tokens.scope, tokenEndpoint: shown.tokenEndpoint }
}

// Every client a test has opened, so the cleanup can close it.
const opened: Client[] = []

/** Closes every client a test opened, so nothing of it is still running when the next test's storage is set up. */
export async function closeClients(): Promise<void> {
  await Promise.all(opened.splice(0).map((one) => one.close().catch(() => {})))
  // Then wait for any work the Worker left running after its responses.
  while (pending.length > 0) await Promise.all(pending.splice(0))
}

/** The SDK's own client on the Worker, as a 2026-07-28 client ('modern') or a 2025 one ('legacy'). */
export async function client(w: World, token: string, era: 'modern' | 'legacy' = 'modern', address = '203.0.113.7'): Promise<Client> {
  // Every request goes through the site, with the caller's address added.
  const transport = new StreamableHTTPClientTransport(new URL(MCP), {
    fetch: (input, init) => site(w, String(input instanceof Request ? input.url : input), { ...(init as RequestInit), headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), 'X-Client-Address': address } }),
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  })

  // Pin the newest protocol revision, or let a 2025 client negotiate as it does.
  const made = new Client({ name: 'test-host', version: '1.0.0' }, era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {})

  // Connect, and remember the client so the test's cleanup closes it.
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

  // Copy the body out, so the response is fully read here.
  return new Response(await response.text(), { status: response.status, headers: response.headers })
}
