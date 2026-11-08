# Eval run 2026-10-30T12-53-57-stream-fix-lost

git da691c2 · cases a2c5faa3a08f · $0.14 (ledger $4.80 of $7.5)

pass 5 · fail 3 · review 0 · error 0 · not run 0 · of 8

median a question: $0.0184 · 5224 ms · first sentence 5777 ms

| case | status | behaviour | facts | sources in pool | sources in context | cited support | first sentence ms | ms | $ |
|---|---|---|---|---|---|---|---|---|---|
| resume-01 | fail | fallback (uncited) | 0/7 | 7/7 of 9 | 7/7 of k=9 | 0/7 |  | 5461 | 0.0107 |
| resume-02 | pass | answered | 7/7 | 7/7 of 48 | 0/7 of k=5 | 7/7 | 5777 | 5789 | 0.0187 |
| book-02 | fail | fallback (uncited) | 0/1 | 2/2 of 48 | 0/2 of k=10 | 0/2 |  | 4987 | 0.0183 |
| book-03 | pass | answered | 1/1 | 1/1 of 48 | 1/1 of k=7 | 1/1 | 4148 | 4155 | 0.0184 |
| book-04 | fail | fallback (uncited) | 0/2 | 2/2 of 48 | 2/2 of k=6 | 0/2 |  | 3193 | 0.0185 |
| book-15 | pass | answered | 3/3 | 3/3 of 48 | 3/3 of k=6 | 3/3 | 6441 | 6448 | 0.0173 |
| boundary-03 | pass | answered | 1/1 | 2/2 of 48 | 1/2 of k=10 | 2/2 | 4601 | 4608 | 0.0184 |
| boundary-05 | pass | answered (stopped: overlong) | 2/2 | 2/2 of 48 | 1/2 of k=7 | 2/2 | 6151 | 6160 | 0.0215 |

## Answers

**resume-01** what jobs has he held

> I couldn't find that in your documents.


**resume-02** what jobs has he held

> Here are the jobs listed in his resume. Founder at Howard's Lantern, Aug 2026 to present. Consultant (AI products) at Pilot & Pixel, Jan 2024 to present. Team Lead for EVIR Web and Inspection Builder at Zonar Systems, Jan 2021 to Aug 2026. Senior Developer / Team Lead at US Mobilesoft, 2004 to 2024. Senior Software Engineer at Ic-1, a concurrent contract, 2020 to 2021. Software Architect at Alexus, 1997 to 2004. Software Engineer at Cisco Systems / Digital, 1992 to 1996.


**book-02** If an LLM keeps nothing between requests, how does a chat app seem to remember what I said earlier?

> I couldn't find that in the passages I read for this question, which are only part of your documents. Asking about it more specifically may find it.


**book-03** How many turns does the book's agent loop allow by default before it gives up?

> The book's loop code sets MAX_ITERATIONS to 25. The text calls twenty-five a defensible default, and says the right number is "more than the most complicated legitimate task you expect". If the cap is reached, the loop throws an error saying it gave up without reaching end_turn.


**book-04** Is it worth caching a prompt prefix that I'm only going to send once?

> I couldn't find that in the passages I read for this question, which are only part of your documents. Asking about it more specifically may find it.


**book-15** At what levels can a rule be enforced, from weakest to strongest?

> A rule can be enforced at three levels, from weakest to strongest: the prompt, the hook, and continuous integration (CI). Prompt: a numbered prohibition in a system prompt. It shapes behaviour most of the time, but it fails unattended, under pressure, when an articulate justification is available. Hook: a program the tool calls at a defined point, whose exit code the tool respects, whether or not anybody remembered it. Its weakness is that it runs on somebody's machine, and `git commit --no-verify` skips it. CI: a service that runs the checks on its own machines using the repository's committed configuration, so nothing on a developer's laptop can switch it off.


**boundary-03** The book says sycophancy is not politeness and not indecision. What is it then, and where does the tendency come from?

> Sycophancy is a model's tendency to move towards the position it believes the person it is talking to holds, rather than towards the position the evidence supports. It is a learned pattern, because text in which a speaker accommodates a disagreeing counterpart is very common. Agreeable continuations were also reinforced during training because human raters preferred them.


**boundary-05** Why does the reviewer in review.ts get [] for its tools, seeing only the diff and the plan?

> The empty tools list is a deliberate starting point, not the only defensible choice. Keeping the reviewer blind makes it cheap and fast, and it cannot wander into unrelated code. The diff is also the honest unit of review, since it is what a colleague would look at. It also fits the chapter's wider design: reviewers read the artefact and never the argument, and they have no write access, which is why a wrong finding is cheap.

