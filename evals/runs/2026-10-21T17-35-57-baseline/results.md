# Eval run 2026-10-21T17-35-57-baseline

git 3e8d007+uncommitted · cases 9a0be71ce0c8 · $0.25 (ledger $0.25 of $5)

pass 18 · fail 4 · review 3 · error 0 · not run 0 · of 25

| case | status | behaviour | facts | sources in context | cited support | ms | $ |
|---|---|---|---|---|---|---|---|
| resume-01 | pass | answered | 7/7 | 7/7 of k=9 | 7/7 | 5961 | 0.0097 |
| resume-02 | fail | answered | 4/7 | 4/7 of k=12 | 4/7 | 5300 | 0.0088 |
| resume-03 | pass | answered | 2/2 | 1/1 of k=9 | 1/1 | 4275 | 0.0079 |
| resume-04 | pass | fallback (empty) | 0/0 | 0/0 of k=9 | 0/0 | 4481 | 0.0067 |
| book-01 | pass | answered | 1/1 | 1/1 of k=12 | 1/1 | 5093 | 0.0104 |
| book-02 | pass | answered | 1/1 | 2/2 of k=10 | 2/2 | 4529 | 0.0102 |
| book-03 | fail | fallback (empty) | 0/1 | 0/1 of k=12 | 0/1 | 7624 | 0.0101 |
| book-04 | pass | answered | 2/2 | 2/2 of k=12 | 2/2 | 3192 | 0.0095 |
| book-05 | pass | answered | 1/1 | 0/1 of k=12 | 0/1 | 5382 | 0.0099 |
| book-06 | pass | answered | 2/2 | 0/1 of k=12 | 0/1 | 5001 | 0.0103 |
| book-07 | pass | answered | 2/2 | 0/1 of k=12 | 0/1 | 3759 | 0.0099 |
| book-08 | pass | answered | 1/1 | 1/1 of k=12 | 1/1 | 3984 | 0.0099 |
| book-09 | pass | answered | 1/1 | 1/1 of k=12 | 1/1 | 3677 | 0.0102 |
| book-10 | pass | answered | 1/1 | 1/1 of k=12 | 1/1 | 6108 | 0.0097 |
| book-11 | pass | answered | 1/1 | 1/1 of k=12 | 0/1 | 3359 | 0.0099 |
| book-12 | pass | answered | 2/2 | 2/2 of k=12 | 2/2 | 4236 | 0.0120 |
| book-13 | fail | fallback (overlong) | 0/13 | 3/3 of k=12 | 0/3 | 4890 | 0.0098 |
| book-14 | fail | fallback (ungrounded) | 0/6 | 1/3 of k=12 | 0/3 | 7680 | 0.0136 |
| book-15 | pass | answered | 3/3 | 2/3 of k=12 | 2/3 | 8035 | 0.0148 |
| book-16 | pass | fallback (empty) | 0/0 | 0/0 of k=12 | 0/0 | 3729 | 0.0093 |
| book-17 | pass | fallback (empty) | 0/0 | 0/0 of k=12 | 0/0 | 3118 | 0.0086 |
| book-18 | pass | fallback (empty) | 0/0 | 0/0 of k=12 | 0/0 | 3431 | 0.0088 |
| book-19 | review | answered | 1/1 | 2/2 of k=12 | 1/2 | 4910 | 0.0102 |
| book-20 | review | answered | 1/1 | 1/1 of k=12 | 1/1 | 3728 | 0.0103 |
| book-21 | review | answered | 1/1 | 1/1 of k=12 | 1/1 | 7682 | 0.0138 |

## Answers

**resume-01** what jobs has he held

> Founder of Howard's Lantern (Aug 2026 - Present); Consultant, AI Products at Pilot & Pixel (Jan 2024 - Present); Team Lead, EVIR Web and Inspection Builder at Zonar Systems (Jan 2021 - Aug 2026); Senior Software Engineer at Ic-1 (2020 - 2021); Senior Developer / Team Lead at US Mobilesoft (2004 - 2024); Software Architect at Alexus (1997 - 2004); Software Engineer at Cisco Systems / Digital (1992 - 1996).


**resume-02** what jobs has he held

> He has been a Senior Developer / Team Lead at US Mobilesoft (2004 - 2024); a Senior Software Engineer at Ic-1 (2020 - 2021); a Software Architect at Alexus (1997 - 2004); and a Software Engineer at Cisco Systems / Digital (1992 - 1996). He also co-authored The 25x Developer (Palabra Press, 2026), and one passage mentions replacing legacy Angular EVIR Web and Inspection Builder applications with React in 60 days.

errors: claude-haiku-5-5: max_tokens

**resume-03** What role did he hold at Zonar Systems?

> He was Team Lead for EVIR Web and Inspection Builder at Zonar Systems, a full-time remote role from Jan 2021 to Aug 2026. He led the web application for EVIR, Zonar's verified electronic vehicle inspection.


**resume-04** What role did he hold at Microsoft?

> I couldn't find that in your documents.


**book-01** What version of Node do I need before starting the book's examples?

> You need Node.js 20 or newer, along with npm. Check with node --version; if it prints something starting with v20. or higher, you have what the examples need.


**book-02** If an LLM keeps nothing between requests, how does a chat app seem to remember what I said earlier?

> The model itself is stateless: it keeps nothing between requests and answers each one using only what that request contains. The apparent memory comes from the program on the other side, which keeps an array of the conversation (including the model's own replies) and resends it with every request. That messages array is the only memory there is.


**book-03** How many turns does the book's agent loop allow by default before it gives up?

> I couldn't find that in the passages I read for this question, which are only part of your documents. Asking about it more specifically may find it.

errors: claude-haiku-5-5: max_tokens

**book-04** Is it worth caching a prompt prefix that I'm only going to send once?

> No. Writing to the cache costs a quarter more than sending the same tokens uncached, so caching a prefix you use once is a small loss. It pays from the second use, and not at all on a one-shot call.


**book-05** Roughly what fraction of the findings from the AI code reviewers will turn out to be wrong?

> Roughly a quarter to a third of everything the reviewers report will be false positives. The book treats a rate of about a third as no reason to stop, only a reason not to let the reviewers act on findings themselves.


**book-06** In the book's worked verdict for the accents change, why wasn't the change cleared to ship?

> The verdict outcome was "blocked" because AC3 (never empty) was unmet: the behavior transcript showed `"///"` → `""`, with no fallback branch in the diff. There was also an open escalation, that input length is unbounded and the plan does not say whether that is acceptable.


**book-07** What's the risk of leaving a focus marker on a single test in a test file?

> Marking a single test with only makes the framework run that test and nothing else, yet the suite still reports green. One word in one file can stop forty tests from running while every dashboard stays the same colour. It is a one-word, syntactically unremarkable edit that is invisible in a summary, so it is the cheapest way to buy a passing suite.


**book-08** How many agents can a single run of the packaged quorum pipeline use at most?

> A single run can use up to thirteen agents. Each one receives the diff and the plan, and several of them reason at length, which is why a run costs real money.


**book-09** What exit code does a PreToolUse hook return to block a tool call?

> A PreToolUse hook returns exit code 2 to block the tool call. The call does not happen, and whatever the hook wrote to standard error goes back to the model as the result. Exit code 0 means proceed, and any other code is reported as a broken hook while the call proceeds.


**book-10** How often does the author say a test you rely on turns out not to fail when you break the code?

> The author says that roughly one time in five, in their experience, the test you most rely on does not go red when you break the code it guards.


**book-11** What's the catch with copying a shared checker script into every repo so CI can run it?

> A vendored copy is frozen on the day it was made. If you later improve the guard, every repository that copied the old version keeps enforcing the old rules while still reporting green. A stale checker does more harm than an absent one, because the green tick reads as enforcement.


**book-12** How big is the finished workflow in total, in files and lines?

> The finished workflow, everything under agentic/, is 14 TypeScript files and 1546 lines in total. Both numbers are counted from the listings when the appendix page is generated.


**book-13** What are the chapters of the book?

> I couldn't find that in the passages I read for this question, which are only part of your documents. Asking about it more specifically may find it.


**book-14** Which review lenses does the book use?

> I couldn't find that in the passages I read for this question, which are only part of your documents. Asking about it more specifically may find it.

errors: claude-haiku-5-5: max_tokens

**book-15** At what levels can a rule be enforced, from weakest to strongest?

> There are three layers. Layer one is the prompt, a numbered prohibition in a system prompt, which is the weakest. Layer two is the hook, a program the tool calls itself, such as a git pre-commit hook. Layer three is the last and strongest, described as outside anybody's reach, and the guard also runs in a CI job alongside the hook.

errors: claude-haiku-5-5: max_tokens

**book-16** How does the book use LangChain to build its agent loop?

> I couldn't find that in the passages I read for this question, which are only part of your documents. Asking about it more specifically may find it.


**book-17** Does the book show how to fine-tune a model on my own codebase?

> I couldn't find that in the passages I read for this question, which are only part of your documents. Asking about it more specifically may find it.


**book-18** How does the book say to deploy the pipeline to Kubernetes with Docker?

> I couldn't find that in the passages I read for this question, which are only part of your documents. Asking about it more specifically may find it.


**book-19** Why does the book recommend having the model grade its own work as the main quality check?

> The book does not recommend this; it says the opposite. It warns that nothing should grade its own work, because a model asked whether its own work is correct will usually say yes, and a grader whose only input is the thing being graded is a text generator with a strong prior towards approval. The checks it recommends instead do not depend on the model's opinion of its own output.


**book-20** Why does the book say temperature 0 makes the model fully deterministic?

> The book does not say that. It says the opposite: temperature 0 does not make the model deterministic, only the selection rule, so the most likely candidate is taken every time. Identical requests at temperature 0 can still produce different text because of floating-point arithmetic and server-side batching, which are outside your control.


**book-21** Why does the book say a twenty-round agent loop costs about twenty times a single request?

> The book says the opposite: a twenty-round loop does not cost twenty times one request, but closer to two hundred. Cost is linear in the tokens you send, and each round re-sends the entire growing conversation. Chapter 4 gives the example of a twenty-turn run over a transcript ending at 40,000 tokens, which sends about 400,000 input tokens, so cost is quadratic in turn count.

