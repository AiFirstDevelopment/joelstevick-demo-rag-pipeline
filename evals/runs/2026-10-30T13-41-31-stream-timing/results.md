# Eval run 2026-10-30T13-41-31-stream-timing

git fb76a58 · cases a2c5faa3a08f · $0.08 (ledger $6.00 of $7.5)

pass 5 · fail 0 · review 0 · error 0 · not run 0 · of 5

median a question: $0.0174 · 4204 ms · first sentence 3562 ms

| case | status | behaviour | facts | sources in pool | sources in context | cited support | first sentence ms | ms | $ |
|---|---|---|---|---|---|---|---|---|---|
| resume-03 | pass | answered | 2/2 | 1/1 of 9 | 1/1 of k=9 | 1/1 | 3752 | 4362 | 0.0079 |
| book-01 | pass | answered | 1/1 | 1/1 of 48 | 1/1 of k=8 | 1/1 | 3191 | 3510 | 0.0181 |
| book-05 | pass | answered | 1/1 | 1/1 of 48 | 1/1 of k=8 | 1/1 | 3562 | 4204 | 0.0174 |
| book-10 | pass | answered | 1/1 | 1/1 of 48 | 1/1 of k=7 | 1/1 | 3726 | 3732 | 0.0170 |
| boundary-01 | pass | answered | 1/1 | 2/2 of 48 | 0/2 of k=8 | 2/2 | 3206 | 4658 | 0.0196 |

## Answers

**resume-03** What role did he hold at Zonar Systems?

> He was Team Lead for EVIR Web and Inspection Builder at Zonar Systems, a full-time remote role. He describes himself the same way, as the team lead for EVIR Web and Inspection Builder.


**book-01** What version of Node do I need before starting the book's examples?

> You need Node.js 20 or newer, along with npm. To check, run node --version; if it prints something starting with v20. or higher, you have what the examples need.


**book-05** Roughly what fraction of the findings from the AI code reviewers will turn out to be wrong?

> Expect roughly a quarter to a third of the findings to be wrong. The book calls these false positives, and it says a rate of about a third is not a reason to stop, only a reason not to let the reviewers act on their own.


**book-10** How often does the author say a test you rely on turns out not to fail when you break the code?

> The author says that roughly one time in five, in his experience, the test does not go red when you break the code it guards.


**boundary-01** What does max_tokens do, and what happens to the response if the ceiling is hit?

> `max_tokens` is a required, hard ceiling on how much the model may produce in one response, and it is measured in output tokens. If the model reaches it, the response simply stops, mid-sentence if necessary, and the stop reason is reported as `max_tokens`. The cut-off response still looks like an answer, because its text field is populated, but it stops mid-thought. The book's `runAgent` loop therefore treats it as an error and throws, telling you to raise `max_tokens` or ask for less at a time.

