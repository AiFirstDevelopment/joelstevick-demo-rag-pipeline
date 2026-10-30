# The demo's eval harness

Runs the golden set through the /demo chatbot's real routes and real models, and scores each
answer. `npm test` never runs it: it calls Anthropic and spends money. `JOURNAL.md` is how it
was used to tune the pipeline.

## Run it

1. `evals/.dev.vars` holds `ANTHROPIC_API_KEY=...` (git ignores it). Wrangler must be logged in:
   Workers AI and the `joelstevick-com-demo-eval` Vectorize index are used remotely.
2. `npm run eval -- --label <name>` runs every case; `--only resume-01,book-13` runs some;
   `--budget 1` lowers this run's cap.
3. It writes `evals/runs/<time>-<label>/results.md` (read this) and `results.json`, and adds the
   run's spend to `evals/runs/ledger.json` after every case.

Caps, in `run.mjs`: $3 a run and $7.50 across all runs. A run that reaches one stops; the cases
it did not reach are "not run", never passes. Raise the caps only with Joel's say-so.

Each run makes three demos (the résumé, the book, both), uploads the PDFs in `corpus/` through
`POST /api/files` exactly as the page extracts them, waits until Vectorize has every vector,
asks each case through `POST /api/ask`, and deletes the demos' vectors at the end.

## Read a result

| column | meaning |
|---|---|
| status | `pass`, `fail`, `review` (a person must read it), `error`, `not run` |
| behaviour | answered, or the fallback (with the check's reason when it refused one) |
| facts | required facts whose match terms appear in the answer |
| sources in pool | located passages among the ~48 the reranker read |
| sources in context | located passages among the 12 the answer was written from |
| cited support | located passages among those the answer cites |

A miss "in pool" is retrieval; in the pool but not in context is the reranker; in context but
not in the answer is generation. A fact matched by a term is not proof the answer is right:
`review` cases (false premises, the absent-topic answers) are read by a person, and so is any
surprising pass. Runs vary: compare the same cases over repeats before believing one change.

## Add a case

One line of `cases.jsonl`: `id`, `corpus` (`resume`, `book` or `both`), `category`, `origin`
(`real` for a prospect's question, else `constructed`), `question`, `expected_behavior`
(`answer`, `fallback`, `correct_or_fallback`), `required_facts` (each with short `match` terms),
`forbidden_claims`, `sources` (file, page, and an `evidence` quote copied verbatim from the
page's extracted text), `severity`, `notes`. Check the quote is verbatim before trusting a run;
a person confirms the facts against the PDF. Change a case only by a reviewed commit, never to
make a run pass.
