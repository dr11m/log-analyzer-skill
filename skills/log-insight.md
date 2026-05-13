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

## Prerequisites

Before splitting/analysis, sanity-check `opencode.json` (local `.opencode/opencode.json` or global `~/.config/opencode/opencode.json`) contains `tool_output` override:

```json
{
  "tool_output": {
    "max_lines": 500000,
    "max_bytes": 8388608
  }
}
```

The tool output of `split_log_chunks` typically reaches 1–8 MB (inline chunk content × N). Default opencode cap is **50 KB** — without this override, the tool response is truncated and sub-agents receive empty `LOG_CHUNK_CONTENT` blocks. If you can't find the override, **stop and tell the user** to add it before continuing.

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
- `projectBriefing` (string, required for the workflow to work without manual substitution) — pass the full PROJECT_BRIEFING text you built in Phase 1. The tool inlines it into each `chunks[i].agent_prompt`, so the orchestrator does NOT have to do any string replacement.

The tool loads the file, slices it into N equal chunks from the END of the file, and **returns a fully-rendered sub-agent prompt for each chunk** with both the raw log content AND the project briefing already embedded.

The tool returns JSON with:
- `total_lines`, `total_bytes` — file size
- `lines_per_chunk` — how many lines each chunk covers
- `analyzed_lines`, `coverage_percent` — total lines covered and % of the file
- `context_tokens_k`, `max_chunk_tokens` — context budget echo
- `warnings[]` — coverage/sizing warnings to relay to the user
- `chunks[]` — array of `{number, total, byte_size, line_count, est_tokens, agent_prompt}` for each chunk

Chunks are numbered oldest to newest. Chunk 1 = oldest analyzed portion, Chunk N = newest (file tail).

**Do NOT read the log file yourself. Do NOT build the sub-agent prompt yourself. Do NOT modify `chunks[i].agent_prompt` in any way.** Each `chunks[i].agent_prompt` is already a complete Task prompt — it contains the analysis instructions, chunk metadata, the project briefing (because you passed `projectBriefing` to the tool), the full raw log content, and the output template. There are NO placeholders left to fill — just pass the string to the Task tool verbatim.

Print summary to user: N, lines_per_chunk, coverage_percent, max_chunk_tokens.

If `warnings[]` is non-empty, surface every warning to the user before launching sub-agents.

If `coverage_percent < 5`, warn the user and suggest a higher N or higher `--context`.

## Phase 3: Launch One Sub-Agent Per Chunk

Principle: **"split — pass through"**. The tool already did the splitting. Your only job is to forward each chunk verbatim.

For each chunk `i`:
1. Take `chunks[i].agent_prompt` from the tool response.
2. Pass that string as the prompt to the **Task** tool. One Task call = one string from the tool. Nothing else.

All N Task calls must go into a **single response block** so they execute in parallel.

### Forbidden manipulations between `split_log_chunks` and `Task`

These are the actions the model often "feels like" doing but they BREAK the analysis. Each bullet corresponds to a real failure mode we have observed:

- ❌ **Do NOT save** `chunks[i].agent_prompt` to a file via `Bash`, `Write`, `Edit`, or any other tool. The content does not need to live on disk.
- ❌ **Do NOT split** `chunks[i].agent_prompt` into segments (40 KB chunks, line ranges, base64 fragments, anything). The tool already produced the only segmentation that matters.
- ❌ **Do NOT replace** the inline content with "Read this file at offset/limit" instructions to the sub-agent. The content is already embedded — the sub-agent must NOT read anything.
- ❌ **Do NOT shell out** to Python, PowerShell, Node, Bash one-liners, or any interpreter to "preprocess" the prompt before Task.
- ❌ **Do NOT shorten, summarize, paraphrase, or excerpt** `agent_prompt`. The tool returned exactly what should go into Task.
- ❌ **Do NOT substitute placeholders** — there are none left. The tool already substituted `{PROJECT_BRIEFING}` because you passed `projectBriefing` to the tool.
- ❌ **Do NOT decide** "this string is too large, the sub-agent can't handle it". That is an incorrect assumption — see below.

### About the size

If `chunks[i].agent_prompt.length` looks large (200 KB – 1 MB) — that is the **correct** size. The tool sized it under the sub-agent's context window (`contextTokens × 1000 × 0.70` tokens). Just pass it through.

If YOU (the orchestrator) genuinely cannot send the string (e.g. your own context window cannot hold N parallel Task prompts of this size) — that is a signal to **STOP and tell the user**: "Current model cannot fit N × {size} KB of parallel Task prompts. Use a model with a larger context window, or lower `--context`/`--chunks`." Do **NOT** work around it via files/segments/Read — that gives a wrong analysis because sub-agents see truncated data.

### Sub-agent constraints (informational — described inside `agent_prompt` too)

The sub-agents have **zero tool budget**: no Read, no Grep, no Bash, no Glob, no Task, no split_log_chunks. They reason over the inline embedded chunk and respond with the structured report described inside `agent_prompt`.

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
