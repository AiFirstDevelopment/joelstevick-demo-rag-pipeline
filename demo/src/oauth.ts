// Copyright (c) 2026 Joel Stevick
// SPDX-License-Identifier: MIT
// Licensed under the MIT License: https://opensource.org/licenses/MIT

/**
 * Who may call the demo's MCP server (README.md, "The MCP server"). OAuth 2.1 is the library's
 * (`@cloudflare/workers-oauth-provider`): discovery documents, client registration, PKCE, codes,
 * tokens, refresh, revocation and the 401 challenge, all kept in the KV namespace `OAUTH_KV`.
 * This Worker is both roles: the authorization server (issuer: the site's origin) and the one
 * resource it issues tokens for (`<origin>/mcp/demo`).
 *
 * What is ours is the part only the application knows:
 *   - who the visitor is: the demo their browser's cookie names (the site forwards its key);
 *   - the consent page: which app is asking, where the access goes, and what it may do;
 *   - what a grant holds: the demo's id and the scopes the visitor ticked, never more;
 *   - the list of connected apps on the demo page, and Disconnect.
 */
import { AuthorizationError, CimdFetchError, OAuthAuthorizationServer, OAuthResourceServer, type ConsentDescription, type OAuthHelpers } from '@cloudflare/workers-oauth-provider'
import { about, json, signedIn, type Demo, type Env, type Options } from './app'
import { anonymousAllowed, READ, serveMcp, tooMany, WRITE, type Run } from './mcp'
import type { Models } from './models'

/** The paths the site forwards here with its own URL: the MCP endpoint, the OAuth endpoints and the two discovery documents. */
export const MCP_PATHS = ['/mcp/demo', '/oauth', '/.well-known/oauth-protected-resource', '/.well-known/oauth-authorization-server']
/** The site, when a request comes from anywhere but it or a local run. */
const SITE = 'https://joelstevick.com'
/** Refresh tokens are asked for with this scope; it is granted when asked and is not a permission to show. */
const OFFLINE = 'offline_access'
/** The most apps one demo can have connected at a time. */
export const MAX_APPS = 5

/** What each permission means, as the consent page and the demo page say it. */
export const SCOPE_WORDS: Record<string, string> = {
  [READ]: 'Search, ask and read your uploaded documents',
  [WRITE]: 'Remove a file from your demo',
}

// What a grant carries: the id of the demo it was given for.
interface Props { demo: string }

/** The origin the visitor and the client see: the site's own, or a local run's. Anything else is the site. */
function originOf(request: Request): string {
  const url = new URL(request.url)
  // A plain-http localhost address is a local run.
  const local = url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')

  return local || url.origin === SITE ? url.origin : SITE
}

/** What a request to the resource carries besides the request: stashed per request under the env object handed to the library. */
const runs = new WeakMap<object, Run>()

interface Servers {
  authorization: OAuthAuthorizationServer<Env>
  resource: OAuthResourceServer<Env, Props>
}

// The two roles built so far, one pair per origin.
const servers = new Map<string, Servers>()

/** The two roles for one origin, built once: every URL the library publishes starts from `origin`. */
function serversFor(origin: string): Servers {
  // Reuse the pair already built for this origin.
  const known = servers.get(origin)
  if (known !== undefined) return known

  // The address of the one resource tokens are issued for.
  const resourceUrl = `${origin}/mcp/demo`

  // The authorization server: consent, tokens and client registration.
  const authorization = new OAuthAuthorizationServer<Env>({
    issuer: origin,
    resources: [resourceUrl],
    authorizeEndpoint: '/oauth/authorize',
    tokenEndpoint: '/oauth/token',
    // Dynamic registration, for a client with no metadata document of its own; open to anyone, so limited by address.
    clientRegistrationEndpoint: '/oauth/register',
    clientIdMetadataDocumentEnabled: true,
    scopesSupported: [READ, WRITE, OFFLINE],
  })

  // The resource server: checks the token on each MCP request, then hands it to serveMcp.
  const resource = new OAuthResourceServer<Env, Props>({
    resourceMetadata: { resource: resourceUrl, authorization_servers: [origin], bearer_methods_supported: ['header'], resource_name: 'Your demo documents' },
    // What any access needs, and so what a client asks for first; removing a file is asked for when it is needed.
    requiredScopes: [READ],
    validateToken: (env) => (wanted, token) => authorization.validateToken<Props>(wanted, token, env),
    handler: {
      fetch(request, env, ctx) {
        // The models and options were stashed for this request before it got here.
        const run = runs.get(env)
        if (run === undefined) return json(500, { error: 'Something went wrong. Please try again in a minute.' })

        // Serve the request for the demo the token names, with what the token says about the caller.
        return serveMcp(request, env, run, ctx.props.demo, {
          token: ctx.auth.token,
          scopes: ctx.auth.scope,
          clientId: ctx.auth.clientId,
          expiresAt: ctx.auth.expiresAt,
          resource: resourceUrl,
          resourceMetadataUrl: `${origin}/.well-known/oauth-protected-resource/mcp/demo`,
        })
      },
    },
  })

  // Keep the pair for next time.
  const made = { authorization, resource }
  servers.set(origin, made)
  return made
}

/** The library's helpers for the store, whichever origin asks: the store is one. */
const api = (env: Env, origin = SITE): OAuthHelpers => serversFor(origin).authorization.getOAuthApi(env)

/** A request context for callers with none (the tests call the app directly). */
const noContext = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext

/** The MCP endpoint, the OAuth endpoints and the discovery documents. */
export async function oauthRoute(request: Request, env: Env, models: Models, options: Options, ctx?: ExecutionContext): Promise<Response> {
  // Without the store there are no tokens to check.
  if (env.OAUTH_KV === undefined) return json(503, { error: 'The MCP server is not available right now.' })

  // Work out the path, the origin and the matching servers.
  const { pathname } = new URL(request.url)
  const origin = originOf(request)
  const { authorization, resource } = serversFor(origin)
  const context = ctx ?? noContext

  // The consent page can make the Worker fetch a client's metadata document, so it is limited by address too.
  if (pathname === '/oauth/authorize') {
    if (!(await anonymousAllowed(request, env))) return tooMany()
    return authorize(request, env, api(env, origin))
  }

  // The MCP endpoint and its discovery document go to the resource server.
  if (pathname === '/mcp/demo' || pathname.startsWith('/mcp/demo/') || pathname.startsWith('/.well-known/oauth-protected-resource')) {
    // Every request is counted by address before its token is looked at, so a junk Authorization header
    // cannot skip the limit; a request with a valid token is also limited per demo (mcp.ts).
    if (!(await anonymousAllowed(request, env))) return tooMany()

    // Stash the models and options under a copy of env, so the handler above can find them.
    const scoped = { ...env }
    runs.set(scoped, { models, options, ctx })
    return resource.fetch(request, scoped, context)
  }

  // Registration and the token endpoint are open to anyone.
  if (request.method === 'POST' && !(await anonymousAllowed(request, env))) return tooMany()

  // Everything else goes to the library's authorization server.
  return authorization.fetch(request, env, context)
}

// Makes text safe to put in HTML.
const escape = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)

/** A page of the site's own look, for the consent form and what is said in its place. Never indexed, never framed. */
function page(title: string, body: string, status = 200, headers = new Headers()): Response {
  // No caching, no framing and no indexing.
  headers.set('Content-Type', 'text/html; charset=utf-8')
  headers.set('Cache-Control', 'no-store')
  headers.set('X-Frame-Options', 'DENY')
  headers.set('X-Robots-Tag', 'noindex')

  // The page itself, in the site's style.
  return new Response(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escape(title)} | Joel Stevick</title>
<link rel="stylesheet" href="/site.css">
<style>
  .consent { max-width: 34rem; margin: 3rem auto; padding: 0 1.25rem; }
  .consent h1 { font-size: 1.6rem; }
  .consent label { display: block; margin: .6rem 0; }
  .consent .buttons { display: flex; gap: .75rem; margin-top: 1.5rem; }
  .consent button { font: inherit; padding: .6rem 1.2rem; border-radius: .4rem; border: 1px solid currentColor; background: none; cursor: pointer; }
  .consent button[value="approve"] { background: #1f6feb; border-color: #1f6feb; color: #fff; }
  .consent .warn { border-left: 4px solid #d29922; padding: .5rem .9rem; }
</style>
</head>
<body>
<main class="consent">
<p><a href="/">Joel Stevick</a></p>
${body}
</main>
</body>
</html>`, { status, headers })
}

/** Said when the browser has no demo: nothing is granted. */
const needDemo = () => page('Open your demo first', `<h1>Open your demo first</h1>
<p>An app is asking to use the documents in your demo, but this browser has no demo open.</p>
<p><a href="/demo">Open your demo</a> in this browser (or <a href="/register?for=demo">start one</a>), then go back to the app and connect again.</p>`, 401)

/** The consent form: every value that came from the client is escaped. */
function consentPage(details: ConsentDescription, handle: string): string {
  // The app's name, and who published it if that is known.
  const name = escape(details.clientName || 'An app')
  const who = details.clientDomain
    ? `Published by <strong>${escape(details.clientDomain)}</strong>.`
    : 'This app registered itself, so its name is not verified.'

  // The form: who is asking, where the access goes, and a box for each permission.
  return `<h1>Allow ${name} to use your demo&#39;s documents?</h1>
<p>${who} The access will be sent to <strong>${escape(details.redirectHost)}</strong>.</p>
${details.redirectIsLoopback ? '<p class="warn"><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it.</p>' : ''}
<form method="post">
  <input type="hidden" name="handle" value="${escape(handle)}">
  ${details.scope.includes(OFFLINE) ? '<input type="hidden" name="offline" value="1">' : ''}
  <label><input type="checkbox" checked disabled> ${escape(SCOPE_WORDS[READ])}</label>
  <label><input type="checkbox" name="scope" value="${WRITE}"> ${escape(SCOPE_WORDS[WRITE])}</label>
  <p>You can disconnect it at any time on your <a href="/demo">demo page</a>.</p>
  <p class="buttons"><button name="decision" value="approve">Allow</button> <button name="decision" value="deny">Deny</button></p>
</form>`
}

/** What the site records of a decision (never forwarded to the browser): the demo, the decision and the scopes. */
function decided(headers: Headers, demo: Demo, decision: string, scopes: string[]): Headers {
  for (const [name, value] of Object.entries(about(demo))) headers.set(name, value)
  headers.set('X-Mcp-Grant', decision)
  headers.set('X-Mcp-Scopes', scopes.filter((scope) => scope !== OFFLINE).join(' '))

  return headers
}

/**
 * The authorization endpoint. GET shows the consent page and grants nothing; POST is the visitor's
 * decision. The visitor is the demo their cookie names, and nothing in the client's request can
 * name another: the grant is written for that demo and holds only the scopes they ticked.
 */
async function authorize(request: Request, env: Env, oauth: OAuthHelpers): Promise<Response> {
  try {
    if (request.method === 'GET') {
      // The library checks the client, its redirect address, the resource and PKCE before anything is shown.
      const asked = await oauth.parseAuthRequest(request)

      // Nothing is shown without a demo open in this browser.
      const demo = await signedIn(request, env)
      if (demo === null) return needDemo()

      // Describe the app, and see how many are already connected.
      const details = await oauth.describeConsent(asked)
      const apps = (await oauth.listUserGrants(demo.id)).items

      // An app already connected is replaced by its new grant; a new one needs room.
      if (apps.length >= MAX_APPS && !apps.some((app) => app.clientId === asked.clientId && app.redirectUri === asked.redirectUri)) {
        return page('Too many connected apps', `<h1>Too many connected apps</h1><p>This demo already has ${MAX_APPS} apps connected. Disconnect one on your <a href="/demo">demo page</a>, then connect again.</p>`, 409)
      }

      // Show the consent form.
      const consent = await oauth.beginConsent(asked)
      return page(`Allow ${details.clientName || 'an app'}`, consentPage(details, consent.handle), 200, consent.headers)
    }

    // Only GET and POST are allowed.
    if (request.method !== 'POST') return json(405, { error: 'method not allowed' })

    // The decision: the visitor must still have a demo open.
    const demo = await signedIn(request, env)
    if (demo === null) return needDemo()

    // Read the form.
    const form = await request.formData()
    const handle = String(form.get('handle') ?? '')

    // Anything but Allow is a denial, sent back to the app.
    if (form.get('decision') !== 'approve') {
      const denied = await oauth.denyConsent(request, handle)
      return new Response(null, { status: 302, headers: decided(denied.headers, demo, 'denied', []) })
    }

    // What is granted is what the visitor ticked: reading always, removing only with its box, a refresh token when the client asked.
    const scope = [READ, ...(form.getAll('scope').includes(WRITE) ? [WRITE] : []), ...(form.get('offline') === '1' ? [OFFLINE] : [])]
    const approved = await oauth.approveConsent(request, handle, { scope })

    // The cap is checked again here: several consent pages could have been opened at once.
    const apps = (await oauth.listUserGrants(demo.id)).items
    if (apps.length >= MAX_APPS && !apps.some((app) => app.clientId === approved.request.clientId && app.redirectUri === approved.request.redirectUri)) {
      return page('Too many connected apps', `<h1>Too many connected apps</h1><p>This demo already has ${MAX_APPS} apps connected. Disconnect one on your <a href="/demo">demo page</a>, then connect again.</p>`, 409)
    }

    // Write the grant for this demo.
    const details = await oauth.describeConsent(approved.request)
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      // The grant's user is the demo, so its grants can be listed and revoked by demo.
      userId: demo.id,
      metadata: { name: details.clientName, domain: details.clientDomain ?? null, host: details.redirectHost },
      scope: approved.request.scope,
      props: { demo: demo.id } satisfies Props,
    })

    // Send the browser back to the app, with the decision for the site to record.
    approved.headers.set('Location', redirectTo)
    return new Response(null, { status: 302, headers: decided(approved.headers, demo, 'allowed', approved.request.scope) })
  } catch (error) {
    // A redirect back to the client is safe only once the library has validated it; everything else is said here.
    if (error instanceof AuthorizationError && error.redirectTo) return new Response(null, { status: 302, headers: { Location: error.redirectTo } })

    if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
      const message = error instanceof AuthorizationError ? error.description : 'This app could not be verified.'
      return page('This could not be completed', `<h1>This could not be completed</h1><p>${escape(message ?? 'The request was not valid.')}</p><p>Go back to the app and connect again.</p>`, 400)
    }

    // Anything unexpected is passed on.
    throw error
  }
}

/** One connected app as the demo page and /admin list it. */
export interface App {
  id: string
  name: string
  host: string
  can: string[]
  allowed_at: number
}

/** The apps connected to a demo, oldest first. */
export async function appsOf(env: Env, demoId: string): Promise<App[]> {
  // Without the store there are no apps.
  if (env.OAUTH_KV === undefined) return []

  // Load the demo's grants.
  const grants = (await api(env).listUserGrants(demoId)).items

  // Turn each grant into what the page shows, oldest first.
  return grants
    .map((grant) => {
      const meta = (grant.metadata ?? {}) as { name?: string; domain?: string | null; host?: string }
      return {
        id: grant.id,
        name: String(meta.name ?? 'An app').slice(0, 120),
        host: String(meta.domain ?? meta.host ?? '').slice(0, 120),
        can: grant.scope.filter((scope) => scope in SCOPE_WORDS).map((scope) => SCOPE_WORDS[scope]),
        allowed_at: grant.createdAt,
      }
    })
    .sort((a, b) => a.allowed_at - b.allowed_at)
}

/** Disconnects every app from a demo: its grants and their tokens are revoked by the library. */
export async function revokeGrants(env: Env, demoId: string): Promise<void> {
  // Without the store there is nothing to revoke.
  if (env.OAUTH_KV === undefined) return

  const oauth = api(env)
  for (const grant of (await oauth.listUserGrants(demoId)).items) await oauth.revokeGrant(grant.id, demoId)
}

/** The demo page's Connected apps: GET lists them, DELETE { id } disconnects one of this demo's. */
export async function grantsRoute(request: Request, env: Env, demo: Demo): Promise<Response> {
  // Without the store the page shows no apps and says the feature is off.
  if (env.OAUTH_KV === undefined) return json(200, { apps: [], available: false })

  // GET lists the apps.
  if (request.method === 'GET') return json(200, { apps: await appsOf(env, demo.id), available: true })

  // DELETE: find the app named in the body among this demo's.
  const body = (await request.json().catch(() => ({}))) as { id?: unknown }
  const app = (await appsOf(env, demo.id)).find((one) => one.id === body.id)

  // Only a grant of this demo: an id from another demo's list finds nothing here.
  if (app === undefined) return json(404, { error: 'That app is not connected to your demo.' })

  // Revoke it, and send back the new list with the details the site records.
  await api(env).revokeGrant(app.id, demo.id)
  return json(200, { apps: await appsOf(env, demo.id), available: true }, { ...about(demo), 'X-Mcp-Grant': 'disconnected' })
}
