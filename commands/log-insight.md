---
description: Inductive log analysis — splits log into N chunks, analyzes each in parallel against project documentation, consolidates trend-aware findings
agent: plan
subtask: true
---

Load the log-insight skill and analyze the log file using chunked inductive analysis.

Parse `$ARGUMENTS` as flags (order does not matter):

- `--chunks <N>` (required, integer) — number of chunks to analyze
- `--log <path>` (optional, string) — path to the log file. If omitted, auto-discover under `logs/`.
- `--context <K>` (optional, integer, default 200) — model context window in **thousands of tokens** (e.g. 200 for 200K, 700 for 700K). Each chunk is capped at 70% of this budget.

If `--chunks` is missing, ask the user.

Follow the log-insight skill workflow:
1. Build PROJECT_BRIEFING from project documentation (`AGENTS.md`, `CLAUDE.md`, `docs/*.md`, `README.md`).
2. Call `split_log_chunks` with `logPath`, `chunks`, and `contextTokens` (if provided). The tool returns each chunk's **raw text inline** in `chunks[i].content`.
3. Surface any `warnings[]` from the tool to the user before dispatching sub-agents.
4. Launch N parallel sub-agents — each prompt includes PROJECT_BRIEFING and the **full chunk text inline**. Sub-agents have zero tool budget (no Read, no Grep, no Bash).
5. Consolidate findings into a trend-aware report with CRITICAL/MEDIUM/LOW severity.
6. Output the final report in the user's language.
