---
description: Inductive log analysis — splits log into N chunks, analyzes each in parallel against project documentation, consolidates trend-aware findings
agent: plan
---

Load the log-insight skill and analyze the log file using chunked inductive analysis.

Parse `$ARGUMENTS` as flags (order does not matter):

- `--chunks <N>` (required, integer) — number of chunks to analyze
- `--log <path>` (optional, string) — path to the log file. If omitted, auto-discover under `logs/`.
- `--context <K>` (optional, integer, default 200) — model context window in **thousands of tokens** (e.g. 200 for 200K, 250 for 250K). Each chunk is capped at 70% of this budget.

If `--chunks` is missing, ask the user.

Follow the log-insight skill workflow exactly as written. No external tools required — the skill uses only Bash, Read, and Task (built-in).
