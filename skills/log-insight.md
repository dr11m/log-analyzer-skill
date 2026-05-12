---
name: log-insight
description: Chunked inductive log analysis. Use when the user asks to analyze application logs by splitting a log file into fixed-size chunks, analyzing each with a sub-agent against project documentation, and merging findings into a trend report. Accepts requests like "analyze logs/app.log with 5 chunks" or "/log-insight 5 logs/app.log".
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

Parse the user's request for:

- **N** (integer, required) — number of chunks to analyze
- **log path** (string, optional) — explicit path to the log file. If not provided, auto-discover.

Examples: `5 logs/app.log`, `3`, `/log-insight 5`

If N is missing, ask the user. If log path is missing, auto-discover in the next phase.

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

## Phase 2: Split the Log into Chunks (Content Inline)

Use the `split_log_chunks` tool. It loads the file, slices it into N equal chunks from the END of the file, and **returns each chunk's raw text inline**:

```
Tool: split_log_chunks
Args:
  logPath: "<absolute path to log file>"
  chunks: <N from user input>
  contextTokens: <K from --context, in thousands of tokens; default 200>
```

The tool returns JSON with:
- `total_lines`, `total_bytes` — file size
- `lines_per_chunk` — how many lines each chunk covers
- `analyzed_lines`, `coverage_percent` — total lines covered and % of the file
- `context_tokens_k`, `max_chunk_tokens` — context budget echo
- `warnings[]` — coverage/sizing warnings to relay to the user
- `chunks[]` — array of `{number, total, offset, limit, byte_size, est_tokens, content}` for each chunk

Chunks are numbered oldest to newest. Chunk 1 = oldest analyzed portion, Chunk N = newest (file tail).

**Do NOT read the log file yourself.** The tool already returns the chunk text in `chunks[i].content`. The orchestrator's only job from here is to pass that content into sub-agent prompts.

Print summary to user: N, lines_per_chunk, coverage_percent, max_chunk_tokens.

If `warnings[]` is non-empty, surface every warning to the user before launching sub-agents.

If `coverage_percent < 5`, warn the user and suggest a higher N or higher `--context`.

## Phase 3: Launch One Sub-Agent Per Chunk (Inline Content)

Launch exactly one sub-agent for each chunk. Use the **Task** tool (subagent). All sub-agents should be called in a SINGLE response block for parallel execution.

Do not assign multiple chunks to one sub-agent. Do not analyze a chunk locally.

Each sub-agent's prompt MUST include:
- `PROJECT_BRIEFING`
- The **full raw log chunk text** — copy `chunks[i].content` from the `split_log_chunks` tool response verbatim into the `{CHUNK_TEXT}` placeholder
- Chunk metadata: `{number, total, offset, limit}`
- The analysis instructions below

The sub-agent receives everything inline and has **zero tool budget**: no Read, no Grep, no Bash, no Glob, no Task. It only reasons over the embedded text and responds.

## Sub-Agent Prompt Template

Fill every placeholder before sending. `{CHUNK_TEXT}` MUST be the verbatim `chunks[i].content` string returned by `split_log_chunks` — do not re-read the log file, do not paraphrase, do not truncate.

```text
You are a log chunk analyzer. Analyze exactly one chunk of a log file.

Use the user's language for prose in your final answer. Keep log lines, exception names, code identifiers, paths, and technical terms as written.

Hard tool rules:
- You have ZERO tool budget. The log chunk is embedded inline below.
- Do NOT call Read, Grep, Bash, Glob, Task, or any other tool.
- Do NOT open files, do NOT search, do NOT shell out. Everything you need is in this prompt.
- This is a pure reasoning task: read the inline content, think, output the structured result.

Purpose:
This is inductive log analysis. You must reason from the complete chunk content, not from filtered matches. Compare observed behavior against the project rules and expected runtime flow.

Chunk metadata:
- Chunk: {CHUNK_NUMBER}/{TOTAL_CHUNKS}
- Ordering: chunk 1 is the oldest analyzed chunk, chunk {TOTAL_CHUNKS} is the newest.
- Read offset: {OFFSET}, limit: {LIMIT}

PROJECT_BRIEFING:
---
{PROJECT_BRIEFING}
---

RAW LOG CHUNK (lines {OFFSET} to end of this chunk):
---
{CHUNK_TEXT}
---

Analysis checklist:
1. Errors and exceptions:
   - ERROR, CRITICAL, Exception, Traceback, failed operations.
   - Group repeated patterns. Count exact occurrences.
   - Capture first and last timestamps for each pattern.
2. Warnings and degradation:
   - WARNING lines, retries, timeouts, resource pressure, slow operations, repeated degraded states.
3. Logic and workflow integrity:
   - Missing start/end pairs, orphaned operations, contradictory decisions, impossible state transitions.
   - Compare observed state transitions, counters, decisions against PROJECT_BRIEFING.
4. Timing and volume anomalies:
   - Large gaps (>60s between consecutive entries), sudden bursts, stalled cycles.
5. External dependencies:
   - API failures, DB failures, rate limits, connection errors, DNS/TLS errors.
6. Cross-chunk metrics:
   - Produce structured metrics so the orchestrator can compare chunks.

For every finding, include:
- Exact count (e.g. "14×", NOT "multiple" or "several")
- First and last timestamp from the chunk
- One or two representative log lines as evidence
- Severity: CRITICAL, MEDIUM, or LOW

Output exactly this structure:

## Chunk {CHUNK_NUMBER}/{TOTAL_CHUNKS}
**Range:** lines {OFFSET}-{END_LINE}
**Time range:** <first timestamp> → <last timestamp>

### CRITICAL
- **<title>**: <description, exact count, first/last timestamp>
  - Evidence: `<representative log line>`
  - Expected behavior: <from PROJECT_BRIEFING, or N/A>
  - Root cause hypothesis: <best hypothesis from chunk context>

### MEDIUM
- **<title>**: <description, exact count, first/last timestamp>
  - Evidence: `<representative log line>`
  - Expected behavior: <from PROJECT_BRIEFING, or N/A>

### LOW
- **<title>**: <description, exact count, first/last timestamp>
  - Evidence: `<representative log line>`

### Chunk Statistics
- Lines analyzed: {LIMIT}
- Errors (ERROR/CRITICAL/Exception/Traceback): <number>
- Warnings (WARNING): <number>
- Max timestamp gap: <number or N/A>
- Active components: <comma-separated list>
- Health summary: <one sentence>

### Cross-Chunk Signals
- errors_total: <number>
- warnings_total: <number>
- critical_findings_total: <number>
- medium_findings_total: <number>
- low_findings_total: <number>
- max_gap_seconds: <number or N/A>
- active_components: <comma-separated list>
- pattern_counts:
  - <pattern name>: <count>
```

If no findings in a severity section, write `None`.

Before returning, verify:
- Every finding has an exact count.
- Every finding has first AND last timestamps.
- `### Cross-Chunk Signals` is present.

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
| Chunk | Range (lines) | Time range | Critical | Medium | Low | Status |
|-------|--------------|------------|----------|--------|-----|--------|

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
