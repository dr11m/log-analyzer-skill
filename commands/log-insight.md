---
description: Inductive log analysis — splits log into N chunks, analyzes each in parallel against project documentation, consolidates trend-aware findings
agent: plan
---

Load the log-insight skill and analyze the log file using chunked inductive analysis.

Parse `$ARGUMENTS` as flags (order does not matter):

- `--chunks <N>` (required, integer) — number of chunks to analyze
- `--log <path>` (optional, string) — path to the log file. If omitted, auto-discover under `logs/`.
- `--context <K>` (optional, integer, default 200) — model context window in **thousands of tokens** (e.g. 200 for 200K, 700 for 700K). Each chunk is capped at 70% of this budget.

If `--chunks` is missing, ask the user.

Follow the log-insight skill workflow:
1. Build PROJECT_BRIEFING from project documentation (`AGENTS.md`, `CLAUDE.md`, `docs/*.md`, `README.md`).
2. Invoke the **native opencode tool** `split_log_chunks` (registered by this plugin — call it like you call `Read`, `Grep`, `Bash`; it is NOT a shell command or Python script) with arguments `logPath`, `chunks`, `contextTokens`. If the tool is not in your tool list, the plugin is not loaded — STOP and tell the user. Do NOT improvise by splitting the file via `Bash`/`Read`/`Python`.
3. The tool returns each chunk as a ready-to-send sub-agent prompt in `chunks[i].agent_prompt` (raw log content already embedded). Surface any `warnings[]` from the tool to the user before dispatching sub-agents.
4. For each chunk, take `chunks[i].agent_prompt`, replace `{PROJECT_BRIEFING}` with the briefing text, and pass the result to the Task tool. Launch all N sub-agents in a single response block for parallel execution. Sub-agents have zero tool budget (no Read, no Grep, no Bash).
5. Consolidate findings into a trend-aware report with CRITICAL/MEDIUM/LOW severity.
6. Output the final report in the user's language.
