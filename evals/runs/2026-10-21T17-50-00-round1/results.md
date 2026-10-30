# Eval run 2026-10-21T17-50-00-round1

git 3e8d007+uncommitted · cases 9a0be71ce0c8 · $0.27 (ledger $0.54 of $5)

pass 17 · fail 5 · review 3 · error 0 · not run 0 · of 25

| case | status | behaviour | facts | sources in context | cited support | ms | $ |
|---|---|---|---|---|---|---|---|
| resume-01 | pass | answered | 7/7 | 7/7 of k=9 | 7/7 | 6790 | 0.0100 |
| resume-02 | pass | answered | 7/7 | 7/7 of k=12 | 7/7 | 6202 | 0.0110 |
| resume-03 | pass | answered | 2/2 | 1/1 of k=9 | 1/1 | 3493 | 0.0079 |
| resume-04 | pass | fallback (empty) | 0/0 | 0/0 of k=9 | 0/0 | 3561 | 0.0072 |
| book-01 | pass | answered | 1/1 | 1/1 of k=12 | 1/1 | 3473 | 0.0095 |
| book-02 | pass | answered | 1/1 | 2/2 of k=11 | 2/2 | 4403 | 0.0100 |
| book-03 | fail | fallback (empty) | 0/1 | 0/1 of k=12 | 0/1 | 3676 | 0.0092 |
| book-04 | pass | answered | 2/2 | 2/2 of k=12 | 2/2 | 3627 | 0.0097 |
| book-05 | fail | fallback (ungrounded) | 0/1 | 0/1 of k=12 | 0/1 | 3727 | 0.0099 |
| book-06 | fail | answered | 1/2 | 0/1 of k=12 | 0/1 | 7173 | 0.0125 |
| book-07 | pass | answered | 2/2 | 0/1 of k=12 | 0/1 | 4187 | 0.0101 |
| book-08 | pass | answered | 1/1 | 1/1 of k=12 | 1/1 | 3821 | 0.0099 |
| book-09 | pass | answered | 1/1 | 1/1 of k=12 | 1/1 | 4770 | 0.0102 |
| book-10 | pass | answered | 1/1 | 1/1 of k=12 | 1/1 | 3595 | 0.0095 |
| book-11 | pass | answered | 1/1 | 0/1 of k=12 | 0/1 | 5346 | 0.0103 |
| book-12 | pass | answered | 2/2 | 2/2 of k=12 | 2/2 | 3596 | 0.0118 |
| book-13 | fail | answered | 4/13 | 0/3 of k=12 | 0/3 | 6934 | 0.0144 |
| book-14 | fail | answered | 2/6 | 1/3 of k=12 | 1/3 | 7773 | 0.0138 |
| book-15 | pass | answered | 3/3 | 2/3 of k=12 | 2/3 | 7214 | 0.0140 |
| book-16 | pass | fallback (empty) | 0/0 | 0/0 of k=12 | 0/0 | 3714 | 0.0100 |
| book-17 | pass | fallback (empty) | 0/0 | 0/0 of k=12 | 0/0 | 3749 | 0.0097 |
| book-18 | pass | fallback (empty) | 0/0 | 0/0 of k=12 | 0/0 | 3080 | 0.0092 |
| book-19 | review | answered | 1/1 | 2/2 of k=12 | 1/2 | 7560 | 0.0126 |
| book-20 | review | answered | 1/1 | 1/1 of k=12 | 1/1 | 3946 | 0.0104 |
| book-21 | review | answered | 1/1 | 1/1 of k=12 | 1/1 | 5151 | 0.0130 |

## Answers

**resume-01** what jobs has he held

> Founder, Howard's Lantern, Aug 2026 - Present; Consultant - AI Products, Pilot & Pixel, Jan 2024 - Present; Team Lead - EVIR Web and Inspection Builder, Zonar Systems, Jan 2021 - Aug 2026; Senior Software Engineer, Ic-1 (acquired by The Swift Group), 2020 - 2021; Senior Developer / Team Lead, US Mobilesoft, 2004 - 2024; Software Architect, Alexus, 1997 - 2004; Software Engineer, Cisco Systems / Digital, 1992 - 1996.


**resume-02** what jobs has he held

> Founder of Howard's Lantern (Aug 2026 - present); Consultant - AI Products at Pilot & Pixel (Jan 2024 - present); Team Lead - EVIR Web and Inspection Builder at Zonar Systems (Jan 2021 - Aug 2026); Senior Software Engineer at Ic-1 (2020 - 2021); Senior Developer / Team Lead at US Mobilesoft (2004 - 2024); Software Architect at Alexus (1997 - 2004); Software Engineer at Cisco Systems / Digital (1992 - 1996).


**resume-03** What role did he hold at Zonar Systems?

> He was Team Lead for EVIR Web and Inspection Builder at Zonar Systems, a full-time remote role from Jan 2021 to Aug 2026. He led the EVIR web application and owned it end to end for nearly five years.


**resume-04** What role did he hold at Microsoft?

> I couldn't find that in your documents.


**book-01** What version of Node do I need before starting the book's examples?

> You need Node.js 20 or newer, along with npm. Check with node --version; if it prints something starting with v20. or higher, you have what the examples need.


**book-02** If an LLM keeps nothing between requests, how does a chat app seem to remember what I said earlier?

> The model is stateless, so the apparent memory comes from the program on your side. It keeps an array of the messages so far, including the model's own replies, and resends the whole array with every request. The model answers each request from scratch using only what that request contains.


**book-03** How many turns does the book's agent loop allow by default before it gives up?

> I couldn't find that in the passages I read for this question, which are only part of your documents. Asking about it more specifically may find it.


**book-04** Is it worth caching a prompt prefix that I'm only going to send once?

> No. Writing to the cache costs a quarter more than sending the same tokens uncached, so caching a prefix you use once is a small loss. It starts to pay from the second use, which in an agentic loop is iteration two, and it does not pay at all on a one-shot call.


**book-05** Roughly what fraction of the findings from the AI code reviewers will turn out to be wrong?

> I couldn't find that in the passages I read for this question, which are only part of your documents. Asking about it more specifically may find it.


**book-06** In the book's worked verdict for the accents change, why wasn't the change cleared to ship?

> Two findings were accepted as real defects. AC3's empty case was not implemented, because the diff has no fallback branch, and `"///"` prints a blank line, which is the same defect seen in behavior. Findings 3 and 4 were rejected, so they did not hold it back.


**book-07** What's the risk of leaving a focus marker on a single test in a test file?

> Marking one test with only makes the framework run that test and nothing else, yet the suite still reports green. One word in one file can stop forty tests from running while every dashboard stays the same colour. It is syntactically unremarkable and invisible in a summary, so it is the cheapest way to buy a passing suite.


**book-08** How many agents can a single run of the packaged quorum pipeline use at most?

> A single run of the packaged pipeline can use up to thirteen agents. Each one receives the diff and the plan, and several of them reason at length, so a large change can cost noticeably more.


**book-09** What exit code does a PreToolUse hook return to block a tool call?

> A PreToolUse hook exits with code 2 to block the tool call. The call does not happen, and whatever the hook wrote to standard error goes back to the model as the result. Exit code 0 means proceed, and any other exit code is reported as a broken hook and the call proceeds.


**book-10** How often does the author say a test you rely on turns out not to fail when you break the code?

> The author says that roughly one time in five, in the author's experience, the test you most rely on does not go red when you break the code it guards.


**book-11** What's the catch with copying a shared checker script into every repo so CI can run it?

> A vendored copy is frozen on the day it was made. If you later improve the guard, every repo that copied the old version keeps enforcing the old rules while still reporting green. That is worse than having no checker, because the green tick reads as enforcement. The book suggests that a shared guard should check that its own copy matches the original and treat a mismatch as a violation.


**book-12** How big is the finished workflow in total, in files and lines?

> The finished workflow, everything under agentic/, is 14 TypeScript files and 1546 lines in total. Both numbers are counted from the appendix listings when the page is generated.


**book-13** What are the chapters of the book?

> The book has thirteen chapters, and the titles given are Chapter 4, What It Knows and Forgets; Chapter 5, Why It Lies to You; Chapter 6, Writing It Down First; Chapter 13, Inside a Plugin.


**book-14** Which review lenses does the book use?

> The book uses six lenses: five are built in Chapter 7, and a sixth arrives in Chapter 8 because it works completely differently. The lenses the passages name are: spec-fidelity; security.


**book-15** At what levels can a rule be enforced, from weakest to strongest?

> The weakest level is the prompt, a rule written as a sentence in a system prompt. Next is the hook, a program the tool itself runs, such as a git pre-commit hook, whose exit code the tool respects. The strongest level is the third one, which the passages point to as the CI job, though they do not describe it in full.


**book-16** How does the book use LangChain to build its agent loop?

> I couldn't find that in the passages I read for this question, which are only part of your documents. Asking about it more specifically may find it.


**book-17** Does the book show how to fine-tune a model on my own codebase?

> I couldn't find that in the passages I read for this question, which are only part of your documents. Asking about it more specifically may find it.


**book-18** How does the book say to deploy the pipeline to Kubernetes with Docker?

> I couldn't find that in the passages I read for this question, which are only part of your documents. Asking about it more specifically may find it.


**book-19** Why does the book recommend having the model grade its own work as the main quality check?

> The book recommends the opposite. Its rule is that nothing grades its own work, because a grader whose only input is the thing being graded is a text generator with a strong prior towards approval. A model asked whether its own work is correct will usually say yes, so the book relies on checks whose outcome does not depend on the model's opinion of its own output.


**book-20** Why does the book say temperature 0 makes the model fully deterministic?

> The book does not say that. It says temperature 0 makes only the selection rule deterministic, because the most likely candidate is taken every time, but it does not make the model deterministic. Identical requests at temperature 0 can still produce different text, because of floating-point arithmetic and server-side batching outside your control.


**book-21** Why does the book say a twenty-round agent loop costs about twenty times a single request?

> The book does not say that. It says a twenty-round loop does not cost twenty times one request, and costs closer to two hundred. The reason is that you send the entire conversation every time, so the transcript grows with each round. Chapter 4 adds that a twenty-turn run over a transcript ending at 40,000 tokens sends roughly 400,000 input tokens, because the average turn carries half the final transcript, so cost is quadratic in turn count.

