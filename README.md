# The RAG pipeline behind joelstevick.com/demo

[joelstevick.com/demo](https://joelstevick.com/demo) lets a visitor upload their own PDFs and ask
up to ten questions. Each answer is two to four sentences, or a list of up to twelve items when it names
several things, citing the file and page it rests on. The answer appears a sentence at a time, each sentence checked
against its sources before it is shown, and a sentence whose citations don't check out is never shown. This repository is that demo's code,
from the page in the browser to the Worker that answers, plus the eval harness used to tune it.

It runs on Cloudflare: a Pages site (the page and its functions), a private Worker (the pipeline),
D1 (SQLite) for chunks and questions, Vectorize for the vectors, Workers AI for embeddings
(bge-m3), and Claude through the Anthropic API for reranking and answering.

```mermaid
flowchart LR
  B["Browser<br/>demo.html"] -->|"page text as JSON"| P["Pages Function<br/>/api/demo/*"]
  P -->|"DEMO service binding"| W["Demo Worker<br/>demo/src"]
  W --> D[("D1<br/>chunks, questions")]
  W --> V[("Vectorize")]
  W --> A["Workers AI<br/>bge-m3"]
  W --> C["Claude<br/>rerank, answer"]
  H["MCP host<br/>Claude Code"] -->|"/mcp/demo, OAuth"| P2["Pages Functions<br/>/mcp/demo, /oauth/*"]
  P2 -->|"DEMO service binding"| W
  W --> K[("KV<br/>OAuth grants")]
```

## Trace a request, from the browser inward

Read the files in this order; the line links land on the step.

### 1. The page: `demo.html`

- `GET /demo` is the static [demo.html](demo.html). Its script ([line 99](demo.html#L99)) does
  the browser's part.
- On load it asks `GET /api/demo/session` for the demo's files and questions left
  ([line 160](demo.html#L160)).
- **The PDFs never leave the browser.** Picking files fires the change handler
  ([line 198](demo.html#L198)); `pagesOf` ([line 184](demo.html#L184)) reads each PDF with pdf.js and
  extracts each page's text. Only that text and the file name are posted, one file at a time, to
  `POST /api/demo/files` ([line 207](demo.html#L207)).
- Removing a file sends `DELETE /api/demo/files` ([line 139](demo.html#L139)); asking sends
  `POST /api/demo/ask` with `Accept: text/event-stream` ([line 359](demo.html#L359)), so the answer
  comes back as a stream (step 6).

### 2. The Pages Functions: `functions/`

Cloudflare Pages routes by file name: `functions/demo.ts` serves `/demo`, and
`functions/api/demo/[[path]].ts` is a catch-all for every path under `/api/demo/`.

- [functions/demo.ts](functions/demo.ts#L10): `GET /demo?key=…` (a bookmarked link) sets the demo
  cookie, then serves the page. Without a key it serves the page unchanged.
- [functions/api/demo/[[path]].ts](functions/api/demo/[[path]].ts#L24): the proxy. It allows only
  `session`, `files` and `ask`, reads the visitor's demo key from the cookie
  ([functions/_lib/demo.ts](functions/_lib/demo.ts#L11)), and forwards the request to the Worker as
  `X-Demo-Key` through the `DEMO` service binding ([line 36](functions/api/demo/[[path]].ts#L36)), with the
  page's `Accept` header. The Worker's response, a stream included, is handed back unread and
  unbuffered. The Worker has no public URL; this binding is the only way in.
- [functions/_lib/track.ts](functions/_lib/track.ts) is a stand-in here: on the site it is the
  visitor analytics and consent check, which are not part of this repository.

### 3. The Worker's entry: `demo/src/index.ts` and `app.ts`

- [demo/wrangler.toml](demo/wrangler.toml) names the entry (`main = "src/index.ts"`) and the
  bindings the runtime injects into `env`: `DB` (D1), `VECTORS` (Vectorize), `AI` (Workers AI).
  `ANTHROPIC_API_KEY` is a Worker secret.
- [demo/src/index.ts](demo/src/index.ts#L10) builds the Worker with `createApp`, passing a function
  that turns `env` into the models. The tests pass scripted models through the same door
  ([tests/support/scripted.ts](tests/support/scripted.ts)), so no test calls a paid API.
- [`createApp`](demo/src/app.ts#L926) returns `{ fetch, scheduled }`. `fetch` calls
  [`route`](demo/src/app.ts#L901), which looks the demo up by the key's SHA-256
  ([`signedIn`](demo/src/app.ts#L92)) and dispatches to `session`, `upload`, `remove` or `ask`.
  `scheduled` runs daily: [`purge`](demo/src/app.ts#L743) deletes a demo's documents after 10 days
  without use.

### 4. Ingest: `upload` in `app.ts`

Search the file for `INGEST` to see each stage.

| Stage | Where | What |
|---|---|---|
| 1 | [app.ts:218](demo/src/app.ts#L218) | validate the name, page count and each page's text |
| 2 | [app.ts:236](demo/src/app.ts#L236) | claim the file name (one row per file) |
| 3 | [app.ts:249](demo/src/app.ts#L249) | check the demo's limits in one atomic statement |
| 4 | [app.ts:267](demo/src/app.ts#L267) | chunk each page: [chunks.ts](demo/src/chunks.ts#L19), about 900 characters, cut at a sentence end |
| 5 | [app.ts:273](demo/src/app.ts#L273) | store the chunks in D1, rolled back on failure |
| 6 | [app.ts:300](demo/src/app.ts#L300) | embed the chunks (bge-m3) and upsert the vectors into Vectorize, under the demo's id as namespace |
| 7 | [app.ts:315](demo/src/app.ts#L315) | notify on a demo's first upload, and reply |

If embedding fails, the file is still searchable by keywords; nothing the visitor sees depends on it.

### 5. Ask: `ask` in `app.ts`

Search the file for `ASK` to see each stage.

| Stage | Where | What |
|---|---|---|
| 1 | [app.ts:461](demo/src/app.ts#L461) | validate the question |
| 2 | [app.ts:465](demo/src/app.ts#L465) | reserve one of the ten questions, atomically |
| 3-4 | [app.ts:581](demo/src/app.ts#L581) | [`retrieval`](demo/src/app.ts#L398): read every chunk from D1, embed the question and query Vectorize, then [`fuseKeywordAndVector`](demo/src/retrieval.ts#L119) runs BM25 and merges both rankings by reciprocal rank fusion |
| 5 | [app.ts:600](demo/src/app.ts#L600) | [`rerank`](demo/src/models.ts#L233): Claude Haiku orders the 48-chunk pool; then [`widen`](demo/src/widen.ts#L27) adds each chosen chunk's neighbours under a character budget |
| 6-7 | [app.ts:609](demo/src/app.ts#L609) | [`answer`](demo/src/models.ts#L305): Claude Sonnet streams its answer from those passages only, each sentence ending with the ids it cites; [`units`](demo/src/check.ts#L267) cuts the text so far into complete sentences and list items, and [`checkUnits`](demo/src/check.ts#L347) checks each one as it completes: every cited id was given and every figure appears in a cited passage. A unit that passes is released; the first that fails ends the answer there, and if nothing passed the fallback is shown |
| 8 | [app.ts:712](demo/src/app.ts#L712) | return the answer with each source's stored text, never the model's paraphrase |

Retrieval is split on purpose: everything that reaches a service and can fail (D1, the embedding
model, Vectorize) is in `retrieval`, with its fallbacks, so `fuseKeywordAndVector` stays a pure function of
plain values that can be tested with arrays alone.

The stages are one async generator, [`answering`](demo/src/app.ts#L564), which yields an event at
each step ([`AskEvent`](demo/src/app.ts#L442)). [`ask`](demo/src/app.ts#L459) renders those events
two ways: as server-sent events when the request asks for `text/event-stream`, or drained to one
JSON body for every other caller, such as the eval harness ([line 479](demo/src/app.ts#L479)).

### 6. The streamed answer: back in `demo.html`

- The answer arrives as server-sent events: `stage` (the step the ask is at), `unit` (one checked
  sentence or list item), `stopped` (a later sentence failed its check), then exactly one of
  `done`, `fallback` or `error`.
- The ask is a `POST`, so the browser's `EventSource` cannot read it; [`events`](demo.html#L325)
  reads the body with a reader and yields each whole event.
- The submit handler acts on each event as it arrives ([line 387](demo.html#L387)): the status
  line names the stage, each unit is appended to the answer, a stop draws a line under what was
  shown, and `done` draws the sources.
- What was shown stays: every sentence on the page passed its own check before it was sent.

## The MCP server: the same documents, from Claude Code

The demo is also an MCP server at `https://joelstevick.com/mcp/demo`, so a visitor's uploaded PDFs can be searched, asked
and read from Claude Code or any MCP host: `claude mcp add --transport http my-docs https://joelstevick.com/mcp/demo`.
The demo page shows that line once a PDF is uploaded, with the apps the visitor has allowed and a Disconnect for each.
[docs/mcp-oauth-flow.md](docs/mcp-oauth-flow.md) walks the whole flow over the wire, step by step, with the code for each.

- **The protocol is a library's, not ours.** The server is built on the official TypeScript SDK
  (`@modelcontextprotocol/server`), which handles both the 2026-07-28 revision and the 2025 ones, discovery, envelopes and
  errors. Our code registers three tools, the files and their pages as resources, and one prompt:
  `build` ([mcp.ts:200](demo/src/mcp.ts#L200)), served a fresh server per request by `serveMcp`
  ([mcp.ts:398](demo/src/mcp.ts#L398)).
- **The tools.** `search_documents` (passages, no answer, costs nothing), `ask_documents` (the page's own `ask`, so the
  same checked answer, one of the ten questions; it sends progress notifications and still records an answer whose
  caller left: `answerFrom`, [mcp.ts:161](demo/src/mcp.ts#L161)), and `remove_file`, the one write.
- **Authorization is OAuth 2.1, and a library's too** (Cloudflare's `@cloudflare/workers-oauth-provider`, its store a KV
  namespace bound as `OAUTH_KV`): discovery documents, client registration, PKCE, tokens, refresh and revocation. Our
  part ([oauth.ts:57](demo/src/oauth.ts#L57)): the settings; the consent page `authorize`
  ([oauth.ts:199](demo/src/oauth.ts#L199)), where the visitor is the demo their cookie names and ticks
  what the app may do (`docs:read` always, `docs:write` to remove a file); and the grant, which holds the demo's id so a
  token can only ever reach that demo's documents.
- **The Pages side only forwards.** `/mcp/demo` ([functions/mcp/demo.ts](functions/mcp/demo.ts)), `/oauth/*`
  ([functions/oauth/[[path]].ts](functions/oauth/%5B%5Bpath%5D%5D.ts)) and the two `/.well-known/` discovery documents
  ([functions/_middleware.ts](functions/_middleware.ts)) go to the Worker through `forwardToDemo`
  ([demo-mcp.ts:28](functions/_lib/demo-mcp.ts#L28)), which drops any `X-Demo-*` header a caller
  sends: only the site says which demo a browser's cookie names.
- **Tests:** [demo/tests/mcp.test.ts](demo/tests/mcp.test.ts) connects with the SDK's own client in both protocol eras,
  runs the whole OAuth flow, and has a test per guard: another demo's documents, a scope the user didn't tick, a
  disconnected app, document text where instructions go, an unbounded result, and no protocol or OAuth code of our own.

## Watching the pipeline: daily metrics, drift, a canary

Every question is recorded (`questions`, with `via`: the page, MCP or the canary), and the Worker's daily job
([demo/src/health.ts](demo/src/health.ts)) watches them:

- **Daily metrics** (`rollUp`, [health.ts:79](demo/src/health.ts#L79)): per day and route, the
  questions, how many were answered, the fallbacks by reason (not found, refused by the check, model failure, stopped),
  and the p50 and p95 time to answer, into `pipeline_days`.
- **Drift** (`driftFlags`, [health.ts:116](demo/src/health.ts#L116)): each day against the 14 days
  before it. A rate is flagged above its baseline by more than 3 standard errors of a binomial and at least 5 points;
  the p95 time at over 1.5 times the baseline days' median; a day needs 10 questions and the baseline 30.
- **A canary** (`runCanary`, [health.ts:184](demo/src/health.ts#L184)): six fixed questions about a
  fixed, invented 16-page document ([demo/src/canary.ts](demo/src/canary.ts)), asked through the real pipeline every
  day. The document is longer than the 12 passages an answer is written from, so it exercises retrieval and reranking,
  not only the model; a canary that cannot run is itself a flag. `CANARY_ENABLED=0` turns it off.
- `/internal/admin/health` serves the days, flags and canary runs. On joelstevick.com an admin page shows them and a
  flagged day sends an alert; those are the site's, not part of this repository.
- **Tests:** [demo/tests/health.test.ts](demo/tests/health.test.ts).

## The eval harness: `evals/`

[evals/README.md](evals/README.md) covers running and reading it; [evals/JOURNAL.md](evals/JOURNAL.md)
is how the runs were used to tune the pipeline.

- [evals/run.mjs](evals/run.mjs) starts the Worker locally under `wrangler dev`, uploads the corpus
  through `POST /api/files` exactly as the page extracts it, asks each case in
  [evals/cases.jsonl](evals/cases.jsonl) through `POST /api/ask`, and scores it: required facts in
  the answer, and whether each expected source reached the pool, the context and the citations. A
  miss names the stage that lost it.
- [evals/worker.ts](evals/worker.ts) is the same `createApp` with the real models, plus `/eval/*`
  routes for the runner. It traces every Anthropic call by wrapping `fetch`; a streamed answer's
  tokens are read from its events by [evals/trace.ts](evals/trace.ts) as the stream passes through.
  Each run records the time to the first sentence beside the total.
- Spend is capped in `run.mjs`. Each run's results are in [evals/runs/](evals/runs/).
- The corpus in [evals/corpus/](evals/corpus/) is not MIT licensed (see [LICENSE](LICENSE)). The
  résumé has some personal details redacted, in the PDF and in the run results that quote it.

## Run it

```sh
npm install
npm run typecheck
npm test          # the Worker's routes in workerd against a local D1, with scripted models
npm run eval      # real models: needs evals/.dev.vars with ANTHROPIC_API_KEY, and wrangler login
```

To deploy your own copy, create the D1 database, the Vectorize index (1,024 dimensions, cosine)
and the secret, plus a KV namespace for the MCP server's OAuth store (`OAUTH_KV`), put their names in
`demo/wrangler.toml`, run the migrations in `demo/migrations/`, and drop the `MAILER` binding (it notifies
the site's owner of a demo's first upload). The page loads the site's stylesheet and scripts, which
are not included.

## License

MIT, © 2026 Joel Stevick, except `evals/corpus/` (see [LICENSE](LICENSE)).
