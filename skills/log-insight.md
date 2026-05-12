---
name: log-insight
description: Chunked inductive log analysis. Use when the user asks to analyze application logs by splitting a log file into fixed-size chunks, analyzing each with a sub-agent against project documentation, and merging findings into a trend report. Accepts requests like "analyze logs/app.log with 5 chunks" or "/log-insight --chunks 5 --log logs/app.log".
---

# Log Insight

## Contract

Act as the orchestrator. Do not analyze log contents yourself — your job is to read raw chunks and pass them to sub-agents verbatim.

Use the user's language for reports and user-facing explanations. Keep log lines, code identifiers, exception names, file paths, and technical terms as written.

This skill is intentionally inductive: each sub-agent receives one complete log chunk plus project context embedded directly in its prompt. Sub-agents must not use tools — they receive everything inline and respond immediately.

### Context Budget (Tokens, Not Bytes)

Pass the sub-agent context window via the `contextTokens` argument of `split_log_chunks` (in thousands of tokens — `200` = 200K, `700` = 700K). The tool sizes each chunk at up to **70% of that window**, leaving room for the PROJECT_BRIEFING and the sub-agent's response.

This limit is in **model tokenizer units**. It is NOT about:
- Characters, bytes, or kilobytes of the log file
- Number of log lines alone
- File size as reported by the filesystem

The tool reports `lines_per_chunk`, `max_chunk_tokens`, and emits `warnings[]` when the file is too large for N chunks at the chosen context. If the warnings indicate partial coverage, surface them to the user and suggest raising `--chunks` or `--context`.

## Required Input

Parse the user's request as flags (order does not matter):

- `--chunks N` (integer, required) — number of chunks to analyze
- `--log <path>` (string, optional) — explicit path to the log file. If not provided, auto-discover.
- `--context <K>` (integer, optional, default 200) — sub-agent context window in thousands of tokens.

Examples: `/log-insight --chunks 5 --log logs/app.log`, `/log-insight --chunks 3`, `/log-insight --chunks 5 --context 700`.

If `--chunks` is missing, ask the user. If `--log` is missing, auto-discover in the next phase.

## Phase 1: Build Project Briefing First

Before splitting or launching sub-agents, read repository documentation and rules.

Build one `PROJECT_BRIEFING` for all sub-agents:

- Read `AGENTS.md` and `CLAUDE.md` if present.
- Read `docs/*.md` if present.
- Read `README.md` if it contains runtime or business context.
- Include business rules and workflow rules with high fidelity. If `docs/rules.md`, `docs/business_rules.md`, or equivalent files exist, include their important rule text directly.
- Summarize architecture, runtime flow, components, expected success path, domain rules, configuration requirements, state transitions, and known invariants.
- Keep the briefing compact — it must fit alongside one chunk within the ~140K token budget.

The briefing must be passed directly in every sub-agent prompt. Sub-agents must not read project docs or source files themselves.

## Phase 2: Split the Log into Chunks (Tool Returns Ready Prompts)

Call the **native opencode tool** `split_log_chunks`. This is a built-in tool registered by the `@dr39m/log-analyzer-suite` plugin — invoke it directly the same way you would invoke `Read`, `Grep`, or `Bash`. It is NOT a shell command, NOT a Python script, and NOT a file on disk.

If the `split_log_chunks` tool is not available in your tool list, the plugin failed to load. STOP and report the issue to the user. Do NOT improvise — do NOT split the file with `Bash`/`Read`/`Python`, do NOT write your own splitter. The whole point of this skill is that the splitting is done by this single tool.

Parameters:

- `logPath` (string, required) — absolute path to the log file.
- `chunks` (number, required) — N from the user's `--chunks` flag.
- `contextTokens` (number, optional, default 200) — K from the user's `--context` flag, in thousands of tokens.

The tool loads the file, slices it into N equal chunks from the END of the file, and **returns a fully-rendered sub-agent prompt for each chunk** with the raw log content already embedded.

The tool returns JSON with:
- `total_lines`, `total_bytes` — file size
- `lines_per_chunk` — how many lines each chunk covers
- `analyzed_lines`, `coverage_percent` — total lines covered and % of the file
- `context_tokens_k`, `max_chunk_tokens` — context budget echo
- `warnings[]` — coverage/sizing warnings to relay to the user
- `chunks[]` — array of `{number, total, byte_size, line_count, est_tokens, agent_prompt}` for each chunk

Chunks are numbered oldest to newest. Chunk 1 = oldest analyzed portion, Chunk N = newest (file tail).

**Do NOT read the log file yourself. Do NOT build the sub-agent prompt yourself.** Each `chunks[i].agent_prompt` is already a complete Task prompt — it contains the analysis instructions, chunk metadata, the full raw log content, and the output template. The only placeholder left in it is `{PROJECT_BRIEFING}`, which you replace once before sending.

Print summary to user: N, lines_per_chunk, coverage_percent, max_chunk_tokens.

If `warnings[]` is non-empty, surface every warning to the user before launching sub-agents.

If `coverage_percent < 5`, warn the user and suggest a higher N or higher `--context`.

## Phase 3: Launch One Sub-Agent Per Chunk

For each chunk, run exactly one Task call. All N Task calls go into a **single response block** so they execute in parallel.

The procedure per chunk is mechanical — there is no creative prompt-building step:

1. Take `chunks[i].agent_prompt` as-is from the tool response.
2. Do a single string replacement: `{PROJECT_BRIEFING}` → the briefing text you built in Phase 1.
3. Send the resulting string to the **Task** tool as the sub-agent prompt. Do NOT add to it, summarize it, or trim it. Each prompt will be large (hundreds of KB or more) — that is expected.

Do NOT call `Read`, `Grep`, or `Bash` on the log file in the orchestrator. Do NOT pass `offset`, `limit`, or a file path to the sub-agent. The chunk content is already embedded in `agent_prompt`.

The sub-agents have **zero tool budget**: no Read, no Grep, no Bash, no Glob, no Task. They reason over the embedded text and respond with the structured report described inside `agent_prompt`.

## Phase 4: Consolidate

Wait for every sub-agent to finish. Base the final report only on sub-agent responses and the project briefing. Do not open the log file for your own analysis.

Merge duplicate findings:
- Same root cause across chunks → one report item.
- Aggregate total count, affected chunks, and full time range.
- Keep the clearest evidence line.
- Mark trend: isolated / stable / improving / worsening / spiking across chunks.

Build a metric timeline from each `### Cross-Chunk Signals` section:

```markdown
| Metric | Chunk 1 | Chunk 2 | ... | Chunk N | Trend |
|--------|---------|---------|-----|---------|-------|
| errors_total | 0 | 2 | ... | 7 | worsening |
```

Sort findings:
1. CRITICAL before MEDIUM before LOW.
2. More affected chunks before fewer.
3. Higher total count before lower.

## Final Report Shape

Return one report in chat:

```markdown
# Log Insight Report

## Parameters
- **File:** <path> (<size>, {total_lines} lines)
- **Chunks requested:** <N>
- **Chunks analyzed:** <N>
- **Lines per chunk:** <lines_per_chunk>
- **Coverage:** <percent>% of file
- **Method:** one sub-agent per chunk; sub-agents receive full chunk text inline (no tools)

## Project Context Used
<short summary of briefing sources and key rules>

## Chunk Summary
| Chunk | Lines | Time range | Critical | Medium | Low | Status |
|-------|-------|------------|----------|--------|-----|--------|

## Metric Trends
| Metric | Chunk 1 | Chunk 2 | ... | Chunk N | Trend |
|--------|---------|---------|-----|---------|-------|

## Critical Problems
### <title>
- **Where:** chunks <list>, <total count> occurrences
- **Evidence:** `<representative log line>`
- **Expected behavior:** <project rule or N/A>
- **Impact:** <impact>
- **Trend:** <isolated/stable/improving/worsening/spike>
- **Recommendation:** <actionable next step>

## Medium Problems
<same compact structure>

## Low Notes
- <one-line notes with chunk references>

## Aggregated Statistics
- Errors total: <number>
- Warnings total: <number>
- Highest max gap: <number or N/A>
- Active components: <merged list>

## Priority Actions
1. <highest-value action>
2. <next action>
3. <next action>
```

If all chunks are healthy, still include Parameters, Project Context Used, Chunk Summary, Metric Trends, and Aggregated Statistics, then state that no significant issues were found.
