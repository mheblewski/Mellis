# scripts/research: narzędzia badawcze, nie do produkcji

Research tooling from the project's development: offline replays and dual-prompt comparisons of AI answers, capture and
validation of time-range evidence, the forensic audit and the message-history reconstruction. They run against a local
database or a local restore of a backup, some with `AUTH_MODE=disabled` and paid AI calls behind the cost guard.

- Never run them on a server or against a database other people use.
- They are not part of the image's runtime and not needed to run Mellis.
- Every script refuses to write its output inside a Git working tree (`scripts/evaluation/evaluation-output-dir.ts`).

Evaluation helpers they share stay in `scripts/evaluation/`.
