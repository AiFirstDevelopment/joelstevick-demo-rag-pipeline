// Copyright (c) 2026 Joel Stevick
// SPDX-License-Identifier: MIT
// Licensed under the MIT License: https://opensource.org/licenses/MIT

// The eval harness: runs evals/cases.jsonl through the demo's real routes and real models
// (evals/worker.ts under `wrangler dev`), scores each case and writes evals/runs/<run>/.
//
//   npm run eval -- --label baseline [--only resume-01,book-13] [--budget 2]
//
// Spend is capped: --budget dollars a run (at most 3), and $7.50 across every run in
// evals/runs/ledger.json. A run that reaches either cap stops, and the cases not reached
// are recorded as not run, never as passes. See evals/README.md.
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'

const RUN_CAP = 3
const TOTAL_CAP = 7.5
// $ per million tokens (input, output), Anthropic first-party prices as of 2026-10-06.
const PRICES = { 'claude-sonnet-5-5': [2, 10], 'claude-haiku-5-5': [0.1, 0.5] }
const PORT = 8862
const BASE = `http://localhost:${PORT}`
const STATE = '.wrangler/evals'
const CORPUS = { resume: ['resume.pdf'], book: ['book.pdf'], both: ['resume.pdf', 'book.pdf'] }

// `--flag value` pairs as an object: { label, only, budget }.
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, i, all) => (arg.startsWith('--') ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs), []))
const label = args.label ?? 'run'
const budget = Math.min(Number(args.budget ?? RUN_CAP), RUN_CAP)
if (!(budget > 0)) {
  console.error(`--budget must be a number of dollars up to ${RUN_CAP}.`)
  process.exit(1)
}
const only = args.only ? new Set(args.only.split(',')) : null

if (!existsSync('evals/.dev.vars') || !/ANTHROPIC_API_KEY=\S+/.test(readFileSync('evals/.dev.vars', 'utf8'))) {
  console.error('evals/.dev.vars with ANTHROPIC_API_KEY=... is needed (git ignores it).')
  process.exit(1)
}
const ledgerPath = 'evals/runs/ledger.json'
const ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : { total_usd: 0, runs: [] }
if (ledger.total_usd >= TOTAL_CAP) {
  console.error(`The eval budget is spent: $${ledger.total_usd.toFixed(2)} of $${TOTAL_CAP}.`)
  process.exit(1)
}

const cases = readFileSync('evals/cases.jsonl', 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((c) => !only || only.has(c.id))
const sha = (data) => createHash('sha256').update(data).digest('hex').slice(0, 12)
const runId = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${label}`
// Matching is on whitespace-collapsed, lower-cased text with straight quotes: the ways a PDF's text differs from a typed expectation.
const flat = (text) => text.replace(/\s+/g, ' ').trim()
const norm = (text) => flat(text).toLowerCase().replace(/[’‘]/g, "'")

/** A page's text as demo.html extracts it in the browser. */
async function pagesOf(file) {
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(`evals/corpus/${file}`)), verbosity: 0 }).promise
  const pages = []
  for (let n = 1; n <= pdf.numPages; n++) {
    const content = await (await pdf.getPage(n)).getTextContent()
    // pdf.js gives text runs with whether a line ends at each; joined as demo.html joins them, so the Worker sees what a browser would send.
    const text = content.items.map((item) => item.str + (item.hasEOL ? '\n' : ' ')).join('').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim()
    pages.push({ page: n, text })
  }
  return { page_count: pdf.numPages, pages: pages.filter((p) => p.text !== '') }
}

async function call(path, body, key) {
  const headers = { 'Content-Type': 'application/json' }
  if (key) headers['X-Demo-Key'] = key
  const response = await fetch(`${BASE}${path}`, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: response.status, body: await response.json().catch(() => null) }
}

const cost = (calls) => calls.reduce((sum, c) => {
  const [input, output] = PRICES[c.model] ?? [0, 0]
  return sum + (c.input_tokens * input + c.output_tokens * output) / 1e6
}, 0)

// A fresh local database, then the Worker.
rmSync(STATE, { recursive: true, force: true })
execFileSync('npx', ['wrangler', 'd1', 'execute', 'joelstevick-com-demos-eval', '--local', '--persist-to', STATE, '-c', 'evals/wrangler.toml', '--file', 'demo/schema.sql'], { stdio: 'pipe' })
const worker = spawn('npx', ['wrangler', 'dev', '-c', 'evals/wrangler.toml', '--port', String(PORT), '--persist-to', STATE, '--inspector-port', '9362'], { stdio: ['ignore', 'pipe', 'pipe'] })
const log = []
worker.stdout.on('data', (d) => log.push(String(d)))
worker.stderr.on('data', (d) => log.push(String(d)))
const stop = () => worker.kill('SIGTERM')
process.on('exit', stop)
for (let i = 0; ; i++) {
  if (i > 120) throw new Error(`the eval Worker did not start:\n${log.join('')}`)
  const up = await fetch(`${BASE}/eval/trace`).then((r) => r.ok).catch(() => false)
  if (up) break
  await new Promise((r) => setTimeout(r, 1000))
}

// One demo per corpus, each with its PDFs uploaded through the real route.
const demos = {}
const corpusHash = {}
for (const [name, files] of Object.entries(CORPUS)) {
  if (!cases.some((c) => c.corpus === name)) continue
  // A fingerprint no card has: each run gets demos of its own, named after it.
  const { body } = await call('/internal/demos', { fingerprint: `eval-${runId}-${name}` })
  demos[name] = body
  for (const file of files) {
    corpusHash[file] ??= sha(readFileSync(`evals/corpus/${file}`))
    const extracted = await pagesOf(file)
    const up = await call('/api/files', { name: file, ...extracted }, body.key)
    if (up.status !== 200) throw new Error(`${file} did not upload to ${name}: ${JSON.stringify(up.body)}`)
    console.log(`${name}: ${file}, ${extracted.page_count} pages, ${up.body.chunks} chunks`)
  }
  for (let i = 0; ; i++) {
    // A transient failure of the check is a "not yet", never a crash.
    const indexed = (await call('/eval/indexed', { demo_id: body.id }).catch(() => ({ body: null }))).body ?? { ready: -1, chunks: 0 }
    // Vectorize writes asynchronously: wait until every chunk's vector reads back, or the first cases would search a half-built index.
    if (indexed.ready >= indexed.chunks && indexed.chunks > 0) break
    if (i > 90) throw new Error(`Vectorize had ${indexed.ready} of ${indexed.chunks} vectors for ${name} after 3 minutes`)
    await new Promise((r) => setTimeout(r, 2000))
  }
}
await call('/eval/trace')
const setupCalls = []

const results = []
let spent = 0
// The ledger is written after every case, so a run that dies still counts what it spent.
const runEntry = { id: runId, usd: 0 }
ledger.runs.push(runEntry)
const startTotal = ledger.total_usd
const saveLedger = () => {
  runEntry.usd = Number(spent.toFixed(4))
  ledger.total_usd = Number((startTotal + spent).toFixed(4))
  mkdirSync('evals/runs', { recursive: true })
  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + '\n')
}
for (const c of cases) {
  if (spent >= budget || startTotal + spent >= TOTAL_CAP) {
    results.push({ id: c.id, status: 'not run', reason: 'budget' })
    continue
  }
  // Each case starts with the demo's question count at zero, so the ten-question limit never ends a run.
  await call('/eval/reset', {})
  const started = Date.now()
  const asked = await call('/api/ask', { question: c.question }, demos[c.corpus].key)
  const ms = Date.now() - started
  const calls = (await call('/eval/trace')).body
  const usd = cost(calls)
  spent += usd
  saveLedger()
  // The answer call's trace names the chunk ids it was given; their text is read back to score what the answer saw.
  const answerCall = calls.find((x) => x.given)
  const given = answerCall ? (await call('/eval/chunks', { ids: answerCall.given })).body : []
  results.push(score(c, asked, given, calls, ms, usd))
  const r = results.at(-1)
  console.log(`${c.id.padEnd(10)} ${r.status.padEnd(7)} ${r.summary}  $${usd.toFixed(4)}`)
}

for (const demo of Object.values(demos)) await call('/eval/forget', { demo_id: demo.id })
stop()

/** The pool's passages carry no file name; a case's sources are all in one file. */
function fileOf(c) {
  return c.sources[0]?.file
}

function score(c, asked, given, calls, ms, usd) {
  const body = asked.body ?? {}
  // A list answer's items are part of what it says: a fact named only in a bullet is still met.
  const answer = [typeof body.answer === 'string' ? body.answer : '', ...(Array.isArray(body.items) ? body.items : [])].join('\n')
  const found = asked.status === 200 && body.found === true
  const cited = (body.sources ?? []).map((s) => ({ id: s.id, file: s.file, page: s.page, passage: s.passage }))
  // A quote a chunk boundary splits (book-07) counts when either half is in one passage.
  const halves = (evidence) => {
    const words = norm(evidence).split(' ')
    const middle = Math.floor(words.length / 2)
    return [norm(evidence), words.slice(0, middle).join(' '), words.slice(middle).join(' ')].filter((part) => part.length >= 30 || part === norm(evidence))
  }
  const holds = (passages, s) => passages.some((p) => p.file === s.file && halves(s.evidence).some((part) => norm(p.text ?? p.passage).includes(part)))
  // A fact is met when any of its match terms appears in the answer: proof of the term, not of the answer (the README's caveat).
  const facts = c.required_facts.map((f) => ({ fact: f.fact, met: f.match.some((m) => norm(answer).includes(norm(m))) }))
  // Where each expected source got to: the reranker's pool, the answer's context, the citations. A miss names the stage that lost it.
  const retrieved = c.sources.map((s) => holds(given, s))
  const pool = (calls.find((x) => x.pool)?.pool ?? []).map((text) => ({ file: fileOf(c), text }))
  const pooled = c.sources.map((s) => holds(pool, s))
  const supported = c.sources.map((s) => holds(cited, s))
  const errors = calls.filter((x) => x.error || x.stop_reason === 'max_tokens' || x.stop_reason === 'refusal').map((x) => `${x.model}: ${x.error ?? x.stop_reason}`)
  // A pool with no rerank call means the reranker was skipped or failed before it was traced.
  if (asked.status === 200 && calls.some((x) => x.given) && !calls.some((x) => x.pool)) errors.push('no rerank call')
  let status
  // An answer case passes on found and every fact; a fallback case passes on a fallback, and an answer there is `review`: a person reads it.
  if (asked.status !== 200) status = 'error'
  else if (c.expected_behavior === 'answer') status = found && facts.every((f) => f.met) ? 'pass' : 'fail'
  else if (c.expected_behavior === 'fallback') status = found ? 'review' : 'pass'
  else status = found ? 'review' : 'pass'
  const count = (xs) => `${xs.filter(Boolean).length}/${xs.length}`
  return {
    id: c.id, corpus: c.corpus, category: c.category, question: c.question, expected: c.expected_behavior, status,
    found, answer, refused: body.refused ?? null, http: asked.status,
    facts, retrieval: { pool: pool.length, sources_in_pool: count(pooled), k: given.length, sources_in_context: count(retrieved), per_source: retrieved },
    citations: { cited: cited.length, sources_supported: count(supported), pages: [...new Set(cited.map((s) => `${s.file} p${s.page}`))] },
    forbidden_claims: c.forbidden_claims, model_calls: calls, errors, ms, usd,
    summary: `${found ? 'answered' : 'fallback'}; facts ${count(facts.map((f) => f.met))}; in pool ${count(pooled)}; in context ${count(retrieved)}; cited ${count(supported)}${errors.length ? `; ${errors.join(', ')}` : ''}`,
  }
}

// Results, and the spend recorded before anything else can fail.
// The results name the code that produced them; uncommitted changes to the demo or the harness are flagged.
const git = execFileSync('git', ['rev-parse', '--short', 'HEAD']).toString().trim()
const dirty = execFileSync('git', ['status', '--porcelain', '--', 'demo', 'evals/worker.ts']).toString().trim() !== ''
saveLedger()
mkdirSync(`evals/runs/${runId}`, { recursive: true })
const meta = {
  run: runId, label, at: new Date().toISOString(), git: dirty ? `${git}+uncommitted` : git,
  cases_hash: sha(readFileSync('evals/cases.jsonl')), corpus: corpusHash,
  answer_model: 'claude-sonnet-5-5', rerank_model: 'claude-haiku-5-5', embedding_model: '@cf/baai/bge-m3',
  usd: Number(spent.toFixed(4)), budget, ledger_total_usd: ledger.total_usd,
}
writeFileSync(`evals/runs/${runId}/results.json`, JSON.stringify({ meta, results }, null, 2) + '\n')
const tally = (s) => results.filter((r) => r.status === s).length
const lines = [
  `# Eval run ${runId}`, '',
  `git ${meta.git} · cases ${meta.cases_hash} · $${meta.usd.toFixed(2)} (ledger $${meta.ledger_total_usd.toFixed(2)} of $${TOTAL_CAP})`, '',
  `pass ${tally('pass')} · fail ${tally('fail')} · review ${tally('review')} · error ${tally('error')} · not run ${tally('not run')} · of ${results.length}`, '',
  '| case | status | behaviour | facts | sources in pool | sources in context | cited support | ms | $ |', '|---|---|---|---|---|---|---|---|---|',
  ...results.map((r) => r.status === 'not run' ? `| ${r.id} | not run | | | | | | | |`
    : `| ${r.id} | ${r.status} | ${r.found ? 'answered' : 'fallback'}${r.refused ? ` (${r.refused})` : ''} | ${r.facts.filter((f) => f.met).length}/${r.facts.length} | ${r.retrieval.sources_in_pool} of ${r.retrieval.pool} | ${r.retrieval.sources_in_context} of k=${r.retrieval.k} | ${r.citations.sources_supported} | ${r.ms} | ${r.usd.toFixed(4)} |`),
  '', '## Answers', '',
  ...results.filter((r) => r.status !== 'not run').flatMap((r) => [`**${r.id}** ${r.question}`, '', `> ${r.answer.replace(/\n/g, ' ')}`, '', r.errors.length ? `errors: ${r.errors.join('; ')}\n` : '']),
]
writeFileSync(`evals/runs/${runId}/results.md`, lines.join('\n'))
console.log(`\n${lines[4]}\n$${meta.usd.toFixed(4)} this run; ledger $${ledger.total_usd.toFixed(2)} of $${TOTAL_CAP}\nevals/runs/${runId}/results.md`)
process.exit(0)
