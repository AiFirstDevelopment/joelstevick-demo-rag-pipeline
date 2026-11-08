# Eval run 2026-10-30T12-40-08-stream-after

git 8a69345 · cases a2c5faa3a08f · $0.52 (ledger $4.66 of $7.5)

pass 19 · fail 9 · review 2 · error 0 · not run 0 · of 30

median a question: $0.0178 · 4717 ms · first sentence 4508 ms

| case | status | behaviour | facts | sources in pool | sources in context | cited support | first sentence ms | ms | $ |
|---|---|---|---|---|---|---|---|---|---|
| resume-01 | fail | fallback (uncited) | 0/7 | 7/7 of 9 | 7/7 of k=9 | 0/7 |  | 6135 | 0.0112 |
| resume-02 | fail | fallback (uncited) | 0/7 | 7/7 of 48 | 0/7 of k=5 | 0/7 |  | 6732 | 0.0174 |
| resume-03 | pass | answered | 2/2 | 1/1 of 9 | 1/1 of k=9 | 1/1 | 4356 | 4371 | 0.0077 |
| resume-04 | pass | fallback (empty) | 0/0 | 0/0 of 9 | 0/0 of k=9 | 0/0 |  | 4618 | 0.0070 |
| book-01 | pass | answered (stopped: uncited) | 1/1 | 1/1 of 48 | 1/1 of k=8 | 1/1 | 3425 | 3435 | 0.0177 |
| book-02 | fail | fallback (uncited) | 0/1 | 2/2 of 48 | 0/2 of k=8 | 0/2 |  | 4816 | 0.0178 |
| book-03 | fail | fallback (uncited) | 0/1 | 1/1 of 48 | 1/1 of k=7 | 0/1 |  | 4304 | 0.0187 |
| book-04 | fail | fallback (uncited) | 0/2 | 2/2 of 48 | 2/2 of k=6 | 0/2 |  | 4521 | 0.0181 |
| book-05 | pass | answered (stopped: uncited) | 1/1 | 1/1 of 48 | 1/1 of k=7 | 1/1 | 3854 | 3866 | 0.0162 |
| book-06 | pass | answered | 2/2 | 0/1 of 48 | 0/1 of k=9 | 1/1 | 5095 | 5108 | 0.0192 |
| book-07 | pass | answered (stopped: ungrounded) | 2/2 | 1/1 of 48 | 1/1 of k=8 | 1/1 | 4072 | 4080 | 0.0196 |
| book-08 | pass | answered | 1/1 | 1/1 of 48 | 1/1 of k=6 | 1/1 | 3708 | 3715 | 0.0148 |
| book-09 | pass | answered | 1/1 | 1/1 of 48 | 1/1 of k=6 | 1/1 | 25474 | 25486 | 0.0172 |
| book-10 | pass | answered | 1/1 | 1/1 of 48 | 1/1 of k=7 | 1/1 | 10923 | 10930 | 0.0166 |
| book-11 | pass | answered (stopped: overlong) | 1/1 | 1/1 of 48 | 1/1 of k=8 | 0/1 | 4369 | 4377 | 0.0200 |
| book-12 | pass | answered | 2/2 | 2/2 of 48 | 2/2 of k=7 | 2/2 | 4508 | 4516 | 0.0195 |
| book-13 | fail | answered (stopped: overlong) | 12/13 | 3/3 of 48 | 3/3 of k=8 | 3/3 | 6571 | 6592 | 0.0210 |
| book-14 | pass | answered | 6/6 | 3/3 of 48 | 2/3 of k=8 | 2/3 | 7661 | 7669 | 0.0206 |
| book-15 | fail | fallback (uncited) | 1/3 | 3/3 of 48 | 3/3 of k=5 | 0/3 |  | 10175 | 0.0165 |
| book-16 | pass | fallback (empty) | 0/0 | 0/0 of 48 | 0/0 of k=6 | 0/0 |  | 4391 | 0.0169 |
| book-17 | pass | fallback (empty) | 0/0 | 0/0 of 48 | 0/0 of k=10 | 0/0 |  | 9399 | 0.0183 |
| book-18 | pass | fallback (empty) | 0/0 | 0/0 of 48 | 0/0 of k=7 | 0/0 |  | 2992 | 0.0155 |
| book-19 | review | answered | 1/1 | 2/2 of 48 | 2/2 of k=6 | 1/2 | 8076 | 8084 | 0.0193 |
| book-20 | pass | fallback (uncited) | 0/1 | 1/1 of 48 | 1/1 of k=10 | 0/1 |  | 5177 | 0.0176 |
| book-21 | review | answered | 1/1 | 1/1 of 48 | 1/1 of k=9 | 1/1 | 5595 | 5609 | 0.0209 |
| boundary-01 | pass | answered | 1/1 | 2/2 of 48 | 0/2 of k=8 | 2/2 | 4979 | 5012 | 0.0203 |
| boundary-02 | pass | answered | 2/2 | 2/2 of 48 | 1/2 of k=9 | 2/2 | 4009 | 4016 | 0.0170 |
| boundary-03 | fail | answered (stopped: uncited) | 0/1 | 2/2 of 48 | 1/2 of k=10 | 2/2 | 4184 | 4189 | 0.0179 |
| boundary-04 | pass | answered | 1/1 | 2/2 of 48 | 1/2 of k=6 | 2/2 | 4065 | 4094 | 0.0186 |
| boundary-05 | fail | answered (stopped: uncited) | 0/2 | 2/2 of 48 | 1/2 of k=7 | 2/2 | 4846 | 4852 | 0.0197 |

## Answers

**resume-01** what jobs has he held

> I couldn't find that in your documents.


**resume-02** what jobs has he held

> I couldn't find that in the passages I read for this question, which are only part of your documents. Asking about it more specifically may find it.


**resume-03** What role did he hold at Zonar Systems?

> He was Team Lead for EVIR Web and Inspection Builder at Zonar Systems, a full-time remote job from Jan 2021 to Aug 2026. He also describes himself as the team lead for EVIR Web and Inspection Builder.


**resume-04** What role did he hold at Microsoft?

> I couldn't find that in your documents.


**book-01** What version of Node do I need before starting the book's examples?

> You need Node.js 20 or newer, along with npm.


**book-02** If an LLM keeps nothing between requests, how does a chat app seem to remember what I said earlier?

> I couldn't find that in the passages I read for this question, which are only part of your documents. Asking about it more specifically may find it.


**book-03** How many turns does the book's agent loop allow by default before it gives up?

> I couldn't find that in the passages I read for this question, which are only part of your documents. Asking about it more specifically may find it.


**book-04** Is it worth caching a prompt prefix that I'm only going to send once?

> I couldn't find that in the passages I read for this question, which are only part of your documents. Asking about it more specifically may find it.


**book-05** Roughly what fraction of the findings from the AI code reviewers will turn out to be wrong?

> Expect roughly a quarter to a third of the reported findings to be false positives, meaning findings that are wrong.


**book-06** In the book's worked verdict for the accents change, why wasn't the change cleared to ship?

> The change was blocked because acceptance criterion AC3 (the result is never empty) was not met, and an escalation was still open. The behavior transcript showed `"///"` producing an empty string instead of a fallback. The open escalation was that input length is unbounded and the plan does not say whether that is acceptable. The book says a blocked verdict covers anything unmet, unresolved, or unsafe.


**book-07** What's the risk of leaving a focus marker on a single test in a test file?

> Leaving `only` on one test means the framework runs that test and nothing else, yet the suite still reports green. One word in one file can stop forty tests from running while every dashboard stays the same colour. It is also an unremarkable one-word edit that is invisible in a summary, which makes it the cheapest way to buy a passing suite.


**book-08** How many agents can a single run of the packaged quorum pipeline use at most?

> A single run can use up to thirteen agents.


**book-09** What exit code does a PreToolUse hook return to block a tool call?

> A PreToolUse hook returns exit code 2 to block a tool call. The tool call then does not happen, and whatever the command wrote to standard error goes back to the model as the result of the call. An exit code of zero means proceed, and any other code is reported as a broken hook while the call proceeds.


**book-10** How often does the author say a test you rely on turns out not to fail when you break the code?

> The author says that roughly one time in five, in his experience, the test does not go red when you break the code it guards.


**book-11** What's the catch with copying a shared checker script into every repo so CI can run it?

> The catch is that a vendored copy is frozen on the day it was made. If you improve the guard, add a rule or fix a bug, every repo that copied the old version keeps enforcing the old rules while still reporting green. That is worse than having no checker, because the green tick reads as enforcement. The book's advice is that a shared guard should check its own copy against the original and treat a mismatch as a violation.


**book-12** How big is the finished workflow in total, in files and lines?

> The workflow itself, meaning everything under agentic/, is 14 TypeScript files and 1546 lines in total, and both numbers are counted from the listings when the appendix is generated.


**book-13** What are the chapters of the book?

> The book has an Introduction, 13 numbered chapters, a Conclusion and two appendices. Chapter 1: Talking to a Model Chapter 2: Giving the Model Hands Chapter 3: The Loop Chapter 4: What It Knows and Forgets Chapter 5: Why It Lies to You Chapter 6: Writing It Down First Chapter 7: A Second Pair of Eyes Chapter 8: Running the Thing Chapter 9: Somebody Has to Decide Chapter 10: Tests That Can Fail Chapter 11: Rules a Prompt Can't Hold Chapter 12: From Yours to Shared


**book-14** Which review lenses does the book use?

> The book uses six lenses: behavior, correctness, spec-fidelity, security, simplicity, and test-quality. **correctness:** Does the change do what it says on inputs it will actually see? **spec-fidelity:** Is every acceptance criterion met, and was any non-goal built anyway? **security:** What does the change do with input it did not expect? **simplicity:** What is more complicated than the problem requires? **test-quality:** Would the tests fail if the behaviour broke? **behavior:** It is the sixth lens, built in Chapter 8 because it works completely differently. Its reviewer picks up to ten inputs, such as the ordinary case, the cases the plan names and the empty case, and checks them against the plan's acceptance criteria.


**book-15** At what levels can a rule be enforced, from weakest to strongest?

> I couldn't find that in the passages I read for this question, which are only part of your documents. Asking about it more specifically may find it.


**book-16** How does the book use LangChain to build its agent loop?

> I couldn't find that in the passages I read for this question, which are only part of your documents. Asking about it more specifically may find it.


**book-17** Does the book show how to fine-tune a model on my own codebase?

> I couldn't find that in the passages I read for this question, which are only part of your documents. Asking about it more specifically may find it.


**book-18** How does the book say to deploy the pipeline to Kubernetes with Docker?

> I couldn't find that in the passages I read for this question, which are only part of your documents. Asking about it more specifically may find it.


**book-19** Why does the book recommend having the model grade its own work as the main quality check?

> The book recommends the opposite: its rule is that nothing grades its own work, not the model and not a second call to the same model with a different prompt or "reviewer persona". A grader whose only input is the thing being graded is a text generator with a strong prior towards approval, and in the book's experiment it often prints PASS even when a case is plainly unhandled. Pushing back does not help either, because a model that tends to agree will agree with you whether you are right or wrong. The book's checks instead have outcomes that do not depend on the model's opinion of its own output: criteria written before the work, a reviewer who did not do the work, someone with authority to decide, and machine checks.


**book-20** Why does the book say temperature 0 makes the model fully deterministic?

> I couldn't find that in the passages I read for this question, which are only part of your documents. Asking about it more specifically may find it.


**book-21** Why does the book say a twenty-round agent loop costs about twenty times a single request?

> The book says the opposite: a loop that runs twenty rounds over a growing transcript does not cost twenty times one request, but closer to two hundred. The reason is that you send the entire conversation on every call, so each round re-sends all the earlier history. A twenty-turn run over a transcript that ends at 40,000 tokens sends roughly 400,000 input tokens, because the average turn carried half the final transcript, so cost is quadratic in turn count.


**boundary-01** What does max_tokens do, and what happens to the response if the ceiling is hit?

> max_tokens is a required, hard ceiling on how much the model may produce in one response, measured in output tokens. If the model reaches it, the response simply stops, mid-sentence if necessary, and the stop reason comes back as max_tokens. The cut-off response looks like an answer, since its text field is populated, but it stops mid-thought. The agent loop therefore treats it as an error, not a completion, and throws a message telling you to raise max_tokens or ask for less at a time.


**boundary-02** The weights were fitted on text gathered up to some point in time: what is that point called, and what does the model know after it?

> The point is called the training cutoff. After it the model knows nothing, because it cannot tell "after my cutoff" from "does not exist". So a question about something newer gets a fluent, plausible answer rather than "I don't know".


**boundary-03** The book says sycophancy is not politeness and not indecision. What is it then, and where does the tendency come from?

> Sycophancy is a model's tendency to move towards the position it believes the person it is talking to holds, rather than towards the position the evidence supports.


**boundary-04** What is fail-first verification, and why does it matter more when a model writes the code or the tests?

> Fail-first verification is proving that a test fails when the behaviour it guards is broken, before trusting it to guard anything: break the code, run the test, see red, restore, see green. It matters because some tests pass against both the broken and the fixed code, so they carry no information, and they look identical to real tests when read. It becomes non-negotiable when a model writes the code or the tests, because a test that cannot fail is exactly what an optimiser under pressure produces when asked to make a suite pass. A model asked to "add tests for this change" produces such tests at a noticeable rate.


**boundary-05** Why does the reviewer in review.ts get [] for its tools, seeing only the diff and the plan?

> The reviewer gets `[]` for its tools as a deliberate starting point, so the diff and the plan are the whole world it sees.

