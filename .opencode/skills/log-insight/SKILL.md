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

**This is the decisive phase.** Briefing quality determines whether sub-agents can distinguish expected failures (retries, fallbacks, graceful degradation) from real anomalies. A weak briefing → a useless report. Sub-agents see only logs — the briefing must give them a complete model of normal system behavior.

Build one `PROJECT_BRIEFING` for all sub-agents.

### Step 1: Gather Sources (in priority order)

Read ALL listed files if they exist. Do not skip any.

| Priority | Source | What to extract |
|----------|--------|-----------------|
| **P0** | `CLAUDE.md` / `AGENTS.md` | Engineering conventions, architectural contract, module responsibility boundaries |
| **P0** | `docs/rules.md` | **Business rules and invariants — copy verbatim** |
| **P0** | `docs/pipeline_flow.md` | **Primary briefing source.** Step-by-step pipeline (bootstrap → loop → stages), every rejection reason with exact names, all numeric thresholds, persistence side effects. If both `workflow.md` and `pipeline_flow.md` exist — prefer `pipeline_flow.md`, extract maximum from it |
| **P0** | `docs/workflow.md` | Runtime flow: steps, branches, state machine. If `pipeline_flow.md` exists — use as supplement |
| **P0** | `docs/structure.md` | Module map, components, their roles and relationships |
| **P1** | `docs/business_rules.md` | Domain rules, validations, constraints |
| **P1** | `docs/*.md` (all others) | Any descriptions of behavior, configuration, error handling |
| **P2** | `README.md` | If it contains architectural or business context |
| **P3** | `config.yaml`, `.env.example`, `*.config.*` | Numeric thresholds: timeouts, limits, intervals, retries, feature flags |

### Step 2: Extract by Category

Process each source, categorizing information strictly as below.

**Core principle:** rules, invariants, and log patterns must be copied **verbatim** — paraphrasing erases precision and makes the briefing useless. Architectural descriptions may be compressed, but all key facts must survive without invention.

#### 2.1 Architecture & Components
- Full component list: one component = one line with role (e.g. `OrderFetcher — reads orders from Redis queue orders_queue`)
- For each: what it consumes, what it produces
- External dependencies with identifiers: databases (`main_db`, `cache`), queues (`orders_queue`, `dlq`), APIs (`payment-api`, `notify-svc`), caches (`redis_sessions`)
- Call map: who calls whom (A → B → C)

#### 2.2 Runtime Workflow
- **Happy path** — the full chain from entry point to successful completion. Each step with a verb: `fetch → validate → enrich → persist → notify`
- **State machine** — all states and transitions. Explicitly list FORBIDDEN transitions (e.g. `[Processed] → [New]` is impossible). Critical: sub-agents must flag any forbidden transition found in logs
- **Error paths** — all known branches: what happens on validation failure, DB timeout, external API failure
- **Cycles and schedules** — periodicity of cron jobs, processing loops, batches

#### 2.3 Business Rules & Invariants (MOST IMPORTANT)
- **Copy verbatim** all rules from `rules.md` / `business_rules.md`. Each rule as a separate entry: `R<n>: <text>`
- For each rule, specify the format: `CONDITION → ACTION` or `CONDITION → ERROR`
- Invariants — what must ALWAYS be true. Example: "Every `fetch` must have a matching `ack` or `nack`. A `fetch` without `ack/nack` within 30 seconds = anomaly."
- Boundary conditions: max/min values, data integrity constraints, uniqueness

#### 2.4 Numeric Thresholds from Configuration
Collect every number that affects behavior visible in logs. Each on its own line:

| Parameter | Value | What it determines in logs |
|-----------|-------|---------------------------|
| `connection_timeout` | 10s | WARNING/ERROR when exceeded |
| `max_retries` | 3 | After 3 retries → DLQ |
| `batch_size` | 100 | Batch processing traces |

#### 2.5 Log Pattern Mapping (log message → meaning)
**The most valuable section for sub-agents.** Collect every log message mention from documentation and build a mapping table:

| Log Pattern (key or fragment) | Level | Meaning | Expected? |
|------------------------------|-------|---------|-----------|
| `order.processed` | INFO | Order successfully processed, full cycle complete | Yes |
| `QueueConsumer.connection_lost` | WARNING | Redis connection lost, normal reconnect | Yes |
| `dlq.reason=DB_UNAVAILABLE` | ERROR | DB write retries exhausted → message moved to DLQ | No |
| `ValidationError field=email` | WARNING | Invalid email in input data | Yes |

Sub-agents use this table to instantly determine: is this ERROR line a real problem or expected behavior?

#### 2.6 Expected Anomalies (what is NOT a problem)
Explicitly collect patterns that look like errors but are normal:
- **Retry logic**: which errors are retried, how many times, backoff intervals. Example: `ConnectionError → retry up to 3x with backoff 1s/2s/4s`
- **Graceful degradation**: what happens when an external service fails (no panic, with fallback)
- **Periodic phenomena**: cold starts, maintenance windows, planned restarts

### Step 3: Assemble the Briefing (template)

Assemble all extracted information into a single text following the structure below exactly. Every section is mandatory. If no data found for a section — write `No data`, but do not omit the section.

```markdown
PROJECT_BRIEFING
===============

## 1. System Overview
<2-3 sentences: what the system does, type (web/api/worker/cron), language/framework>

## 2. Components
<list: name — role — key dependencies>
- ComponentA: role, depends on [DB, Redis, ext-API]

## 3. Runtime Workflow

### Happy Path
<step-by-step successful execution chain: Step1 → Step2 → ... → Result>

### State Machine
```
[StateA] --event--> [StateB]
[StateB] --error--> [StateC]
```
Forbidden transitions: [StateX] ↛ [StateY]

### Error Branches
<what happens for each error type>
- Error type X → retry N times → when exhausted → DLQ

## 4. Business Rules & Invariants
<VERBATIM. Each rule as a separate entry.>
R1: <text>
R2: <text>

Invariants (must ALWAYS hold):
- <invariant text>
- <invariant text>

## 5. Numeric Thresholds
| Parameter | Value | Log Impact |
|-----------|-------|-------------|
| <name> | <N> | <how it appears in logs> |

## 6. Log Pattern → Meaning Map
| Log Pattern | Level | Meaning | Expected |
|-------------|-------|---------|----------|
| <fragment> | ERROR/WARN/INFO | <what it means> | Yes/No |

## 7. Known Non-Issues
<log patterns that look like errors but are normal>
- `<pattern>` → normal because <reason>
```

### Step 4: Quality Check Before Writing

Before writing to `briefing.txt`, run through the checklist. If any item fails — go back to documentation and fill it in:

- [ ] At least one **business rule** (Section 4 is not empty) if the project has `docs/rules.md`
- [ ] **Happy path** (Section 3) — sub-agents need the reference sequence
- [ ] At least one **forbidden situation** (forbidden transition or violable invariant)
- [ ] **Log patterns** with meaning decoded (Section 6): at least 3 if documentation mentions them
- [ ] **Numeric thresholds** (Section 5): all timeouts, limits, retries from configuration
- [ ] No filler phrases like "the system processes data" — everything is specific, measurable, verifiable
- [ ] Briefing fits within ~30% of sub-agent context budget (at `--context 200` that's ~60K tokens; the remaining ~70% is the log chunk)

**If the briefing exceeds budget**, trim in strict order:
1. Compress component descriptions to 1 line each
2. Compress workflow descriptions to key transitions only
3. **NEVER trim** business rules, invariants, or log patterns — these are the foundation of analysis

### Step 5: Write

Write the final `PROJECT_BRIEFING` to `log-analysis/log-insight/briefing.txt` (create the directory first: `mkdir -p log-analysis/log-insight`).

The briefing will be passed as the `projectBriefing` parameter to `split_log_chunks` — the tool inlines it into every sub-agent prompt. **Sub-agents must not read project documentation or source code themselves** — all necessary information is already in the briefing.

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

For each chunk `i`:
1. Take `chunks[i].agent_prompt` from the tool response.
2. Pass that string as the prompt to the **Task** tool — verbatim, no edits.

All N Task calls must go into a **single response block** so they execute in parallel.

### What the orchestrator passes vs what sub-agents do

`chunks[i].agent_prompt` is small (~15-50 KB) -- it does NOT contain the raw log. It contains PROJECT_BRIEFING + analysis instructions + a single line:
```
Bash(command="cat <chunk_file_path>")
```

Each sub-agent makes **EXACTLY ONE** Bash tool call to `cat` its chunk file. That single Bash returns the full chunk (because `tool_output` in `opencode.json` has `max_bytes >= 8 MB`, bypassing the Read tool's internal 50KB cap). Then the sub-agent reasons over the output and produces the structured report.

### Forbidden manipulations (between split_log_chunks and Task)

- Do NOT save `chunks[i].agent_prompt` to a file, do NOT split it into segments, do NOT shell out to Python/PowerShell/Node.
- Do NOT modify the `Bash(...)` line in `agent_prompt` (chunk_file paths are pre-computed by the tool).
- Do NOT substitute placeholders -- there are none left, the tool inlined `{PROJECT_BRIEFING}` when you called it with `projectBriefing`.

### Sub-agent constraints (also stated inside agent_prompt)

The sub-agents have a **tool budget of exactly ONE Bash call**. No Read, no Grep, no Glob, no Task, no further Bash calls. The single `cat` fetches the whole chunk; everything else is pure reasoning over the Bash output.

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
