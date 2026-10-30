# Tuning the demo with evals: the working journal

The raw record behind joelstevick.com/stories/tuning-with-evals. Times are 2026-10-21, US Eastern.

## The failure

- A prospect uploaded Joel's two-page résumé to /demo and asked "what jobs has he held". The
  demo answered that "the passages don't list his job history", citing two page-1 passages.
  "What role did he hold at Zonar Systems?" found page 2, so the text was stored.
- Reproduced on the PDF: 9 chunks; the seven employers sit in 5 of them across both pages.
- Cause: the answer model was given at most 5 chunks; for this wording BM25 matched only the
  summary and the outbound-calls chunk, which led the pool, so page 2 was cut. The model then
  wrote the absence as an answer, and the check passed it (nothing in it was ungrounded).
- Not chunking. A separate chunking defect was found on the way: the page sends each PDF line
  on its own line, the chunker only knew ". " as a sentence end, so real PDFs were cut
  mid-sentence ("Built Howard's Lantern, a").

## The fix (PR #13), test first

- E2e regression on a fictional two-page résumé, uploaded through the real page, scripted
  models that list only the jobs in the passages they are given. Red on the old code: 5 of 7
  jobs ("Team Lead at Corvane Freight" and "Senior Developer at Quillon Systems" missing).
- Fix: context of up to 12 chunks, the reranker orders rather than cuts; a demo of 12 chunks or
  fewer is read whole, and only then is "not in your documents" said; chunker knows ".\n";
  sources grouped one line per file and page.
- Mutation: setting the cap back to 5 turns the same assertion red. A verifier in a fresh
  context found a guard gap (the whole-document read could be removed with tests green);
  closed with a vector-index-down variant that reproduces the live symptom exactly.
- Same day: the demo takes a book (300 pages, PR #14) and deletes a demo's documents after 10
  days without use (PR #15).

## The harness

- Joel capped spend at $2 a run and $5 in all, and chose a golden set of 25 questions rather
  than 200 to keep costs down.
- Cases: 4 from the résumé (his question; the same with his 267-page book also uploaded; the
  Zonar question; "What role did he hold at Microsoft?", a trap, since Microsoft appears only as
  the Microsoft Store) and 21 from the book (12 specific, 3 broad lists, 3 absent topics, 3 false
  premises). Every expected quote checked verbatim against the PDF text by a program.
- The runner uploads the real PDFs through the real routes to a local copy of the demo Worker
  with the real models (Sonnet 5.5 answers, Haiku 5.5 reranks, bge-m3 embeds into a separate
  Vectorize index), and records per case: behaviour, facts, whether the evidence reached the
  answer's context, whether a cited passage holds it, latency and cost.
- Smoke run with a dummy key, $0: already showed only 4 of 7 employers reaching the context
  when the book is uploaded too.

## Baseline: 18 pass, 4 fail, 3 review ($0.25)

- Joel's question passes on the live models.
- Hand review: the 3 false-premise answers all reject the premise and say what the book says.
- The reranker hit its 256-token cap on 4 of 25 questions (resume-02, book-03, book-14, book-15): Haiku 5.5 thinks by default, and the
  thinking spent the budget before the list. Each time the ranking was silently discarded.
- Sonnet used 587 and 588 of its 600 output tokens on two answers: a little more and the JSON
  would be cut, and the prospect would see "try again".
- book-13 ("What are the chapters?"): a perfect answer, refused as overlong. The sentence counter
  read "1. Talking to a Model; 2. ..." as fifteen sentences. A defect in the check, not the model.
- book-14 (the review lenses): retrieval. Only 3 of 6 lenses reached the model; it said "six
  lenses" without a cited passage saying so, and the figure check refused it, correctly.

## Round 1: 17 pass, 5 fail ($0.27)

- Changes: reranker thinking off; answer limit 600 → 2000; sentence counter skips list numbers.
- Résumé + book (resume-02) went from 4/7 to 7/7: a reranker that finishes finds every employer.
- But book-05, book-06 and book-13 got worse: with thinking off, Haiku ranked worse, and its
  picks pushed the contents page out of the twelve.

## Round 2

- Reranker thinks again, at low effort with 1024 tokens of room. Added a "sources in pool"
  measure, to separate retrieval misses from rerank misses.
- The harness itself failed twice: an edit script that stopped halfway, then a helper declared
  after its first use. The second run died after spending about a cent the ledger never saw.
  The ledger is now written after every case; the lost spend is recorded as an estimate.

- Joel allowed a 50% overrun of the caps: $3 a run, $7.50 in all.

## Round 2: 19 pass, 3 fail, 3 review ($0.26)

- Every résumé case passes, the book uploaded alongside included. The chapters answer is 13/13.
- Low-effort thinking fixed both problems at once: the reranker finishes, and ranks well.
- Checking the harness: book-07's expected quote is split by a chunk boundary, so "in pool"
  under-counted it; a source now counts when either half of its quote is in one passage.
  book-05 and book-06 answered correctly from other passages that say the same thing; their
  located passage really was not retrieved.
- Left: retrieval. book-03's passage is not in the 24-passage pool (of 501 chunks); book-14 has
  2 of its 3. Round 3 widens the pool to 48: the reranker reads more, the answer still sees 12.

## Round 3, pool 48: 20 pass, 2 fail, 3 review ($0.28)

- book-03 and book-15 flipped to pass (book-03's passage is now in the pool), and book-06
  flipped to fail. book-05 had already passed in round 2. (Corrected after the verifier read
  the runs: my first note said "book-03 and book-05".)
- Hand review of the three false-premise answers and the Microsoft trap: all correct, so 23 of 25.
- The two failures are partial, not wrong: book-06 gives the main reason the change was blocked
  and omits the second (an open escalation); book-14 names 3 of the 6 lenses and says there are
  six. book-14's three passages are all in the pool now, but only one made the reranker's twelve.
- Round 4 tries an answer context of 16 passages instead of 12 (about $0.002 a question).

## Round 4, context 16: 20 pass, 2 fail, 3 review ($0.32)

- No gain, 17% more cost. book-14 still saw 1 of its 3 passages and this time fell back rather
  than answer in part. Reverted to 12: round 3's configuration is the candidate.
- Next: run round 3's configuration twice more, to see how much of any change is noise.

## For the story

- Written in the first person, as Joel. Include the working detail: how long each phase took,
  what each run cost, the caps he set and why, and the decision points.
- Timings so far (2026-10-21): the failure reported mid-morning; regression test, fix and the
  two follow-ups (300 pages, 10-day deletion) shipped by early afternoon; harness built and
  smoke-tested in about an hour; baseline at 13:35; each full live run takes about 10 minutes
  and costs $0.25–0.32. Estimate given at round 4: about 30 minutes more tuning (round 4, then
  two repeats for variance), 45 to ship the tuning with tests, 45 for the story page.

## Repeats of the final configuration ($0.27 each)

- Counting the hand-reviewed cases, the final configuration scored 23, 24 and 23 of 25 over
  three runs; the baseline scored 21.
- book-06 failed in all four runs with the 48-passage pool, giving one of the two reasons the
  change was blocked; it passed with both at baseline and in round 2, with 24. So widening the
  pool traded book-06 for book-03 and book-15: a net gain of one, and a real cost. (Corrected
  after the verifier read the runs: I had written that its passage is "never retrieved".)
- book-14 (six lenses) passed once in three: it sits at the edge of what twelve passages from a
  reranker can hold for a list spread over three chapters.
- resume-04 once answered "The passages do not show him holding a role at Microsoft", correct,
  and against the rule that the model not say what the documents lack. Hand-reviewed as a pass:
  it invents no role, which is what the case guards.
- One repeat died in setup (Vectorize's readiness check answered empty once) before any model
  call, $0; the poll now retries.
- Tuning stopped at $1.96 of $7.50.

## What the verifier caught

A second agent, in a fresh context, checked the branch against the run files before it shipped:

- My journal overclaimed twice: the reranker ran out of tokens on 4 questions, not 6; and book-06
  was not a retrieval gap but the price of the 48-passage pool. Both corrected above.
- Round 1's Sonnet answers reached 616 and 607 tokens: the old 600 limit would have cut them.
- My sentence-counter fix leaked: it exempted any number before a period, so "The total was 100.
  The tax was 20. ..." counted as one sentence. Now only a list number (at the start, or after
  ":", ";", "," or a line break) is exempt, with a test that five such sentences are refused.
- At 48 passages the rerank took up to 4.3 s against a 5 s timeout, and a timeout would have
  been invisible to the harness. The timeout is now 8 s, and an aborted call is traced as an
  error.
