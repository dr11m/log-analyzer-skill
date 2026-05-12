---
name: log-insight
description: Chunked inductive log analysis. Use when the user asks to analyze application logs by splitting a log file into fixed-size chunks, analyzing each with a sub-agent against project documentation, and merging findings into a trend report. Accepts requests like "analyze logs/app.log with 5 chunks" or "/log-insight 5 logs/app.log".
---

# Log Insight

## Contract

Act as the orchestrator. Do not analyze log contents yourself — your job is to compute chunk boundaries and prepare chunk files, then pass them to sub-agents.

Use the user's language for reports and user-facing explanations. Keep log lines, code identifiers, exception names, file paths, and technical terms as written.

This skill is intentionally inductive: each sub-agent receives instructions first, then the full chunk text at the end of the prompt. Sub-agents must not use tools.

No external scripts, no temp files, no plugins. Only built-in tools: Bash, Read, Task.

## Context Budget (Tokens, Not Bytes)

The model context window is approximately **200,000 tokens**. The PROJECT_BRIEFING plus one log chunk must together fit within roughly **70% of that window (~140,000 tokens)**.

This limit refers to **model tokenizer units** (roughly 0.75 words per token for English, fewer for dense log lines). It is NOT about characters, bytes, kilobytes, or line count. Use ~4 chars/token as a rough estimation heuristic.

## Required Input

Parse the user's request for:

- **N** (integer, required) — number of chunks to analyze
- **log path** (string, optional) — explicit path to the log file. If not provided, auto-discover.
- **context** (integer, optional) — model context window in **thousands of tokens** (e.g. `200` for 200K tokens, `250` for 250K tokens). Default: `200`.

Examples: `5 logs/app.log`, `5 logs/app.log 250`, `/log-insight 5`

If N is missing, ask the user. If log path is missing, auto-discover.

## Phase 1: Build Project Briefing First

Before splitting or launching sub-agents, read repository documentation and rules.

Build one `PROJECT_BRIEFING` for all sub-agents:

- Read `AGENTS.md` and `CLAUDE.md` if present.
- Read `docs/*.md` if present.
- Read `README.md` if it contains runtime or business context.
- Include business rules and workflow rules with high fidelity. If `docs/rules.md`, `docs/business_rules.md`, or equivalent files exist, include their important rule text directly.
- Summarize architecture, runtime flow, components, expected success path, domain rules, configuration requirements, state transitions, and known invariants.
- Keep the briefing compact — it must fit alongside one chunk within the ~70% token budget.

The briefing must be passed directly in every sub-agent prompt. Sub-agents must not read project docs or source files themselves.

## Phase 2: Calculate Chunk Boundaries and Read All Chunks

### Step 2a: Get file stats

Run TWO Bash commands in parallel to get file dimensions:

```bash
(Get-Content -LiteralPath "<LOG_PATH>" | Measure-Object -Line).Lines
```
```bash
(Get-Item -LiteralPath "<LOG_PATH>").Length
```

First returns `total_lines` (integer). Second returns `total_bytes` (integer).

### Step 2b: Compute chunk layout

Calculate chunk boundaries manually. The math:

```
context_K_tokens = <user-provided context or 200>
target_chunk_tokens = context_K_tokens * 1000 * 0.70
target_chunk_bytes  = target_chunk_tokens * 4        # ~4 chars per token

avg_bytes_per_line  = total_bytes / total_lines
raw_lines_per_chunk = target_chunk_bytes / avg_bytes_per_line
lines_per_chunk     = min(raw_lines_per_chunk, 10000, floor(total_lines / N))
lines_per_chunk     = max(lines_per_chunk, 1)

coverage_percent    = (N * lines_per_chunk / total_lines) * 100
```

Chunk numbering: chunk 1 = oldest (top of file), chunk N = newest (tail). Compute offsets:

```
for i in 1..N:
    offset[i] = total_lines - (N - i + 1) * lines_per_chunk + 1
    offset[i] = max(1, offset[i])
```

Chunk 3 is the newest, chunk 1 the oldest within analyzed range.

Print summary to user: N, lines_per_chunk, analyzed_lines (= N × lines_per_chunk), coverage_percent, context window used.

If coverage < 5%, warn the user and suggest a higher N.

If `total_lines < N * 100` and N > 1, suggest a lower N.

### Step 2c: Read each chunk

Read every chunk using the **Read** tool. Use parallel Read calls (one per chunk) in a SINGLE response block:

- For each chunk `i`, call `Read(filePath="<LOG_PATH>", offset=<OFFSET>, limit=<LIMIT>)`.
- The Read output is the raw chunk text. Do not interpret, filter, or summarize it.
- Store each chunk's text paired with its metadata.

## Phase 3: Launch One Sub-Agent Per Chunk (Inline at End)

Launch exactly one sub-agent for each chunk. Use the **Task** tool (subagent). All sub-agents in a SINGLE response block for parallel execution.

Each sub-agent prompt has TWO parts, in this exact order:
1. PROJECT_BRIEFING + chunk metadata + analysis instructions
2. **At the very end:** the full raw chunk text from Step 2c — pasted verbatim after the `RAW LOG DATA` marker

Sub-agent receives everything inline. ZERO tools.

**Placement matters:** chunk text goes at the END. Instructions first, data after. This prevents the sub-agent from "exploring" before it knows the task.

## Sub-Agent Prompt Template

Build the prompt in this EXACT order: briefing + metadata + instructions first, then the raw chunk text LAST. Replace `{CHUNK_TEXT}` with the Read output from Step 2c — paste verbatim.

```text
You are a log chunk analyzer. Analyze exactly one chunk of a log file.

Use the user's language for prose in your final answer. Keep log lines, exception names, code identifiers, paths, and technical terms as written.

You have ZERO tools. The entire log chunk is at the end of this prompt. Do not call any tool — Read, Bash, Grep, nothing. Read the inline data, think, output your findings.

Chunk metadata:
- Chunk: {CHUNK_NUMBER}/{TOTAL_CHUNKS}
- Ordering: chunk 1 oldest, chunk {TOTAL_CHUNKS} newest
- Lines: {LIMIT}

PROJECT_BRIEFING:
---
{PROJECT_BRIEFING}
---

Analysis checklist:
1. Errors and exceptions: ERROR, CRITICAL, Exception, Traceback, failed operations. Group repeated patterns. Count exact occurrences. Capture first/last timestamps.
2. Warnings and degradation: WARNING lines, retries, timeouts, resource pressure, slow operations.
3. Logic and workflow integrity: Missing start/end pairs, orphaned operations, contradictory decisions, impossible state transitions vs PROJECT_BRIEFING.
4. Timing and volume anomalies: Large gaps (>60s), sudden bursts, stalled cycles.
5. External dependencies: API failures, DB failures, rate limits, connection errors, DNS/TLS errors.
6. Cross-chunk metrics: Produce structured metrics for orchestrator comparison.

For every finding: exact count (e.g. "14×"), first+last timestamp, 1-2 representative log lines, severity (CRITICAL/MEDIUM/LOW).

Output structure:
---
## Chunk {CHUNK_NUMBER}/{TOTAL_CHUNKS}
**Range:** lines <offset>-<end_line>
**Time range:** <first> → <last>

### CRITICAL
- **<title>**: <description, count, timestamps>
  - Evidence: `<line>`
  - Expected: <from BRIEFING or N/A>
  - Root cause: <hypothesis>

### MEDIUM
(same format)

### LOW
(same format)

### Chunk Statistics
- Lines analyzed: <number>
- Errors: <number>
- Warnings: <number>
- Max gap: <seconds or N/A>
- Active components: <list>
- Health summary: <sentence>

### Cross-Chunk Signals
- errors_total: <number>
- warnings_total: <number>
- critical_findings_total: <number>
- medium_findings_total: <number>
- low_findings_total: <number>
- max_gap_seconds: <number or N/A>
- active_components: <list>
- pattern_counts:
  - <name>: <count>
---

If no findings in a section, write `None`.
Every finding MUST have exact count + first AND last timestamps.

RAW LOG DATA — your assigned chunk:
---
{CHUNK_TEXT}
```

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
- **Context window:** <context_K>K tokens, target <target_chunk_tokens>K tokens per chunk
- **Method:** one sub-agent per chunk; chunk text inlined at end of prompt (no tools)

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
