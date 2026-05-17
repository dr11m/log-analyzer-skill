# Log Insight (Standalone)

## Contract

Act as the orchestrator. Do not analyze log contents yourself — your job is to coordinate splitting and sub-agent analysis.

Use the user's language for reports and user-facing explanations. Keep log lines, code identifiers, exception names, file paths, and technical terms as written.

This skill is intentionally inductive: each sub-agent receives one complete log chunk plus project context embedded directly in its prompt. Sub-agents make exactly one tool call to fetch their chunk, then reason purely over the returned content.

### Context Budget (Tokens, Not Bytes)

The `--context K` flag sets the sub-agent context window in **thousands of tokens** (e.g. 200 = 200K, 700 = 700K). Each chunk is sized at up to **70% of that window**, leaving room for the PROJECT_BRIEFING and the sub-agent's response.

This limit is in **model tokenizer units**, estimated via bytes / 3.5. It is NOT about:
- Characters, bytes, or kilobytes of the log file
- Number of log lines alone
- File size as reported by the filesystem

The script reports `lines_per_chunk`, `max_chunk_tokens`, and emits `warnings[]` when the file is too large for N chunks at the chosen context. If the warnings indicate partial coverage, surface them to the user and suggest raising `--chunks` or `--context`.

## Required Input

Parse the user's request as flags (order does not matter):

- `--chunks N` (integer, required) — number of chunks to analyze
- `--log <path>` (string, optional) — explicit path to the log file. If not provided, auto-discover.
- `--context <K>` (integer, optional, default 200) — sub-agent context window in thousands of tokens.

Examples: `/log-insight-standalone --chunks 5 --log logs/app.log`, `/log-insight-standalone --chunks 3`, `/log-insight-standalone --chunks 5 --context 700`.

If `--chunks` is missing, ask the user. If `--log` is missing, auto-discover in the next phase.

## Prerequisites

### Node.js

Run `node --version`. If Node.js is not available, STOP and tell the user to install it. Node.js is required because the splitting logic runs as a script — no plugin, no Python, no external dependencies.

### opencode tool_output (opencode only)

If running inside opencode, sanity-check `opencode.json` (local `.opencode/opencode.json` or global `~/.config/opencode/opencode.json`) contains `tool_output` override:

```json
{
  "tool_output": {
    "max_lines": 500000,
    "max_bytes": 8388608
  }
}
```

The sub-agent's Bash output (cat of chunk file) goes through the tool_output pipeline. Default opencode cap is **50 KB** — without this override, sub-agents receive truncated chunks. If you can't find the override, **stop and tell the user** to add it before continuing.

Other agent platforms (Claude Code, Cursor, Windsurf/Devin, etc.) typically do not have this 50 KB Bash output cap, so this step can be skipped.

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

The briefing will be embedded directly in each sub-agent's prompt. **Sub-agents must not read project documentation or source code themselves** — all necessary information is already in the briefing.

## Phase 2: Split the Log into Chunks

The briefing is already written to `log-analysis/log-insight/briefing.txt` in the previous phase.

### Step 1: Write the split script

Write the following JavaScript to `log-analysis/log-insight/split-log.cjs` (the `.cjs` extension ensures CommonJS compatibility even if the project's `package.json` has `"type": "module"`):

```javascript
#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");

// --- CLI arg parsing ---
const args = process.argv.slice(2);
function getArg(name) {
  const i = args.indexOf("--" + name);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined;
}
const logPath = getArg("log");
const requestedChunks = parseInt(getArg("chunks") || "0", 10);
const contextTokensK = parseInt(getArg("context") || "200", 10);
const briefingFile = getArg("briefing-file");
const chunksDir = getArg("chunks-dir") || "log-analysis/log-insight/chunks";
// Note: this script uses CommonJS (require) intentionally.
// The .cjs extension ensures Node treats it as CommonJS even
// when the project's package.json has "type": "module".

if (!logPath || !requestedChunks) {
  console.error("Usage: node split-log.js --log <path> --chunks <N> [--context <K>] [--briefing-file <path>] [--chunks-dir <dir>]");
  process.exit(1);
}

// --- Constants (same as plugin) ---
const MAX_FILE_BYTES = 200 * 1024 * 1024;
const BYTES_PER_TOKEN = 3.5;
const CHUNK_BUDGET_RATIO = 0.7;

// --- Read log file ---
if (!fs.existsSync(logPath)) {
  console.error("Log file not found: " + logPath);
  process.exit(1);
}
const totalBytes = fs.statSync(logPath).size;
if (totalBytes > MAX_FILE_BYTES) {
  console.error("Log file too large: " + totalBytes + " bytes exceeds " + MAX_FILE_BYTES + "-byte safety cap. Pre-trim the file before running.");
  process.exit(1);
}
const text = fs.readFileSync(logPath, "utf8");
const lines = text.split("\n");
const totalLines = lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
const avgBytesPerLine = totalLines > 0 ? totalBytes / totalLines : 100;

// --- Chunk sizing ---
const maxChunkTokens = contextTokensK * 1000 * CHUNK_BUDGET_RATIO;
const maxChunkBytes = Math.floor(maxChunkTokens * BYTES_PER_TOKEN);
const linesByContext = Math.max(1, Math.floor(maxChunkBytes / avgBytesPerLine));
const linesByDivision = Math.max(1, Math.floor(totalLines / requestedChunks));
const linesPerChunk = Math.min(linesByContext, linesByDivision);

// --- File too small check ---
if (totalLines < requestedChunks * 10 && requestedChunks > 1) {
  const reduced = Math.max(1, Math.floor(totalLines / 10));
  console.error("File too small: " + totalLines + " lines for " + requestedChunks + " chunks. Suggest --chunks " + reduced + " or smaller.");
  process.exit(1);
}

// --- Warnings ---
const warnings = [];
if (linesByContext < linesByDivision) {
  const analyzedLines = requestedChunks * linesPerChunk;
  const uncoveredPercent = ((totalLines - analyzedLines) / totalLines) * 100;
  warnings.push(
    "chunk_size capped at 70% of context (" + linesPerChunk + " lines/chunk). " +
    "~" + uncoveredPercent.toFixed(1) + "% of the file is uncovered — " +
    "raise --chunks or --context for fuller coverage."
  );
}
if (linesPerChunk < 100) {
  warnings.push(
    "chunk size very small: " + linesPerChunk + " lines/chunk. " +
    "Consider lowering --chunks for more meaningful analysis windows."
  );
}

// --- Read briefing ---
let projectBriefing = "";
if (briefingFile && fs.existsSync(briefingFile)) {
  projectBriefing = fs.readFileSync(briefingFile, "utf8");
}

// --- Ensure chunks dir exists ---
fs.mkdirSync(chunksDir, { recursive: true });

// --- Agent prompt template (same as plugin) ---
const PROMPT_TEMPLATE = [
  "You are a log chunk analyzer. Analyze exactly one chunk of a log file.",
  "Use the user's language for prose in your final answer. Keep log lines, exception names, code identifiers, paths, and technical terms as written.",
  "",
  "Hard tool rules:",
  '- Step 1: Bash(command="cat __CHUNK_FILE__") — fetch your chunk. Must be your FIRST tool call.',
  '- Step 2: Bash(command="<shell command to write your report>") — save your COMPLETE analysis to __REPORT_FILE__. Must be your LAST tool call.',
  "- You may make EXACTLY TWO Bash calls: one cat (read), one save (write). Zero other tool calls of any kind.",
  '- If the cat output has fewer than __LINE_COUNT__ lines, report that exact fact in your output ("Bash returned only N of __LINE_COUNT__ lines — tool_output likely not configured") and analyze whatever you got. Do NOT retry.',
  "",
  "Purpose:",
  "This is inductive log analysis. You must reason from the complete chunk content, not from filtered matches. Compare observed behavior against the project rules and expected runtime flow.",
  "",
  "Chunk metadata:",
  "- Chunk: __CHUNK_NUMBER__/__TOTAL_CHUNKS__",
  "- File range: lines __OFFSET__ to __OFFSET_END__",
  "- Size: __BYTE_SIZE__ bytes, __LINE_COUNT__ lines",
  "- Ordering: chunk 1 is the oldest analyzed chunk, chunk __TOTAL_CHUNKS__ is the newest.",
  "",
  "PROJECT_BRIEFING:",
  "---",
  "{PROJECT_BRIEFING}",
  "---",
  "",
  "YOUR LOG CHUNK — fetch it now with ONE Bash call:",
  '    Bash(command="cat __CHUNK_FILE__")',
  "",
  "That single Bash returns lines __OFFSET__ through __OFFSET_END__ — chunk __CHUNK_NUMBER__/__TOTAL_CHUNKS__, __LINE_COUNT__ lines / __BYTE_SIZE__ bytes total.",
  "",
  "Analysis checklist:",
  "1. Errors and exceptions:",
  "   - ERROR, CRITICAL, Exception, Traceback, failed operations.",
  "   - Group repeated patterns. Count exact occurrences.",
  "   - Capture first and last timestamps for each pattern.",
  "2. Warnings and degradation:",
  "   - WARNING lines, retries, timeouts, resource pressure, slow operations, repeated degraded states.",
  "3. Logic and workflow integrity:",
  "   - Missing start/end pairs, orphaned operations, contradictory decisions, impossible state transitions.",
  "   - Compare observed state transitions, counters, decisions against PROJECT_BRIEFING.",
  "4. Timing and volume anomalies:",
  "   - Large gaps (>60s between consecutive entries), sudden bursts, stalled cycles.",
  "5. External dependencies:",
  "   - API failures, DB failures, rate limits, connection errors, DNS/TLS errors.",
  "6. Cross-chunk metrics:",
  "   - Produce structured metrics so the orchestrator can compare chunks.",
  "",
  "For every finding, include:",
  '- Exact count (e.g. "14x", NOT "multiple" or "several")',
  "- First and last timestamp from the chunk",
  "- One or two representative log lines as evidence",
  "- Severity: CRITICAL, MEDIUM, or LOW",
  "",
  "Output exactly this structure:",
  "",
  "## Chunk __CHUNK_NUMBER__/__TOTAL_CHUNKS__",
  "**Time range:** <first timestamp> -> <last timestamp>",
  "",
  "### CRITICAL",
  "- **<title>**: <description, exact count, first/last timestamp>",
  "  - Evidence: `<representative log line>`",
  "  - Expected behavior: <from PROJECT_BRIEFING, or N/A>",
  "  - Root cause hypothesis: <best hypothesis from chunk context>",
  "",
  "### MEDIUM",
  "- **<title>**: <description, exact count, first/last timestamp>",
  "  - Evidence: `<representative log line>`",
  "  - Expected behavior: <from PROJECT_BRIEFING, or N/A>",
  "",
  "### LOW",
  "- **<title>**: <description, exact count, first/last timestamp>",
  "  - Evidence: `<representative log line>`",
  "",
  "### Chunk Statistics",
  "- Lines analyzed: __LINE_COUNT__",
  "- Errors (ERROR/CRITICAL/Exception/Traceback): <number>",
  "- Warnings (WARNING): <number>",
  "- Max timestamp gap: <number or N/A>",
  "- Active components: <comma-separated list>",
  "- Health summary: <one sentence>",
  "",
  "### Cross-Chunk Signals",
  "- errors_total: <number>",
  "- warnings_total: <number>",
  "- critical_findings_total: <number>",
  "- medium_findings_total: <number>",
  "- low_findings_total: <number>",
  "- max_gap_seconds: <number or N/A>",
  "- active_components: <comma-separated list>",
  "- pattern_counts:",
  "  - <pattern name>: <count>",
  "",
  "If no findings in a severity section, write `None`.",
  "",
  "Before returning, verify:",
  "- Every finding has an exact count.",
  "- Every finding has first AND last timestamps.",
  "- `### Cross-Chunk Signals` is present.",
  "",
  "AFTER verification — SAVE YOUR REPORT:",
  '- Make ONE MORE Bash call to write your ENTIRE analysis (the markdown report you just produced above) to the file __REPORT_FILE__.',
  "- Use a shell command that writes the full report text. On Unix: printf or a heredoc. On Windows PowerShell: Set-Content or Out-File.",
  '- Example: Bash(command="printf \'%s\\n\' \'...your full report...\' > __REPORT_FILE__")',
  "- The orchestrator will verify that __REPORT_FILE__ exists with content. If it doesn't, your analysis is considered incomplete.",
  "- This is your LAST tool call. After saving, return only a short confirmation: 'Report saved to __REPORT_FILE__'.",
].join("\n");

function renderAgentPrompt(chunkNumber, totalChunks, byteSize, lineCount, chunkFile, reportFile, offset, briefing) {
  const briefingBlock = briefing.length > 0 ? briefing : "{PROJECT_BRIEFING}";
  const offsetEnd = offset + lineCount - 1;
  return PROMPT_TEMPLATE
    .replaceAll("__CHUNK_NUMBER__", String(chunkNumber))
    .replaceAll("__TOTAL_CHUNKS__", String(totalChunks))
    .replaceAll("__BYTE_SIZE__", String(byteSize))
    .replaceAll("__LINE_COUNT__", String(lineCount))
    .replaceAll("__CHUNK_FILE__", chunkFile.replace(/\\/g, "/"))
    .replaceAll("__REPORT_FILE__", reportFile.replace(/\\/g, "/"))
    .replaceAll("__OFFSET__", String(offset))
    .replaceAll("__OFFSET_END__", String(offsetEnd))
    .replace("{PROJECT_BRIEFING}", briefingBlock);
}

// --- Build chunks ---
const manifestChunks = [];
for (let i = 1; i <= requestedChunks; i++) {
  const rawOffset = totalLines - (requestedChunks - i + 1) * linesPerChunk + 1;
  const offset = Math.max(1, rawOffset);
  const chunkLines = lines.slice(offset - 1, offset - 1 + linesPerChunk);
  // Sanitize: strip ANSI escape codes and C0 control chars (except \n \r \t)
  const chunkText = chunkLines.join("\n")
    .replace(/\x1B\[[0-9;]*[A-Za-z]/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  const byteSize = Buffer.byteLength(chunkText, "utf8");
  const lineCount = chunkLines.length;
  const chunkDir = path.join(chunksDir, "chunk_" + i);
  fs.mkdirSync(chunkDir, { recursive: true });
  const chunkFile = path.join(chunkDir, "tmp_chunk_file");
  const reportFile = path.join(chunkDir, "report.md");
  fs.writeFileSync(chunkFile, chunkText, "utf8");
  manifestChunks.push({
    number: i,
    total: requestedChunks,
    offset: offset,
    byte_size: byteSize,
    line_count: lineCount,
    chunk_file: chunkFile,
    report_file: reportFile,
    chunk_dir: chunkDir,
    est_tokens: Math.round(byteSize / BYTES_PER_TOKEN),
    agent_prompt: renderAgentPrompt(i, requestedChunks, byteSize, lineCount, chunkFile, reportFile, offset, projectBriefing),
  });
}

const analyzedLines = requestedChunks * linesPerChunk;
const coveragePercent = totalLines > 0 ? (analyzedLines / totalLines) * 100 : 0;

const result = {
  source_path: logPath,
  total_lines: totalLines,
  total_bytes: totalBytes,
  lines_per_chunk: linesPerChunk,
  analyzed_lines: analyzedLines,
  coverage_percent: Number(coveragePercent.toFixed(1)),
  context_tokens_k: contextTokensK,
  max_chunk_tokens: Math.round(maxChunkTokens),
  warnings: warnings,
  chunks: manifestChunks,
};

console.log(JSON.stringify(result, null, 2));
```

### Step 2: Run the script

Run the script via Bash:

```
node log-analysis/log-insight/split-log.cjs --log <absolute-path> --chunks <N> --context <K> --briefing-file log-analysis/log-insight/briefing.txt
```

- `--log` must be an **absolute path** to the log file.
- `--chunks` is N from the user's `--chunks` flag.
- `--context` is K from the user's `--context` flag (optional, default 200).
- `--briefing-file` is the path where you wrote the PROJECT_BRIEFING in Step 1.

The script outputs a JSON manifest to stdout. Parse it.

### Step 3: Surface warnings and summary

Print summary to user: N chunks, lines_per_chunk, coverage_percent, max_chunk_tokens.

If `warnings[]` is non-empty, surface every warning to the user before launching sub-agents.

If `coverage_percent < 5`, warn the user and suggest a higher N or higher `--context`.

## Phase 3: Launch One Sub-Agent Per Chunk

The manifest JSON contains a `chunks[]` array. Each element has an `agent_prompt` field — a **fully self-contained** sub-agent prompt.

For each chunk `i`:
1. Take `chunks[i].agent_prompt` from the manifest.
2. Pass that string as the prompt to your platform's sub-agent mechanism.

**All N sub-agents must launch in parallel** (single response block if your platform supports it).

### What the orchestrator passes vs what sub-agents do

`chunks[i].agent_prompt` is compact (~15-50 KB). It contains PROJECT_BRIEFING + analysis instructions + two Bash directives:

```
Bash(command="cat <chunk_file_path>")     # Step 1: fetch chunk
Bash(command="...")                        # Step 2: save report to __REPORT_FILE__
```

Each sub-agent makes **exactly TWO** Bash calls: one `cat` to fetch the chunk, one to write the report. No other tools. Then the sub-agent returns a short confirmation.

### Forbidden manipulations (between manifest and sub-agent launch)

- Do NOT save `chunks[i].agent_prompt` to a file, do NOT split it into segments, do NOT shell out to Python/PowerShell/Node.
- Do NOT modify the `Bash(...)` line in `agent_prompt` (chunk_file paths are pre-computed by the script).
- Do NOT substitute placeholders — there are none left, the script inlined `{PROJECT_BRIEFING}` when you passed `--briefing-file`.

### Sub-agent constraints (also stated inside agent_prompt)

The sub-agents have a **tool budget of exactly TWO Bash calls**: one `cat` to fetch the chunk, one to save the report to `__REPORT_FILE__`. No Read, no Grep, no Glob, no Task, no further Bash calls. After the save Bash, the sub-agent returns a short confirmation.

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
2. More affected chunks first.
3. Higher total count first.

End with a **one-paragraph executive summary** covering the most important findings, their root causes, and recommended next steps.

### Phase 4a: Save Final Report to Disk

Write the full consolidated report (the one you just composed in chat) to **`log-analysis/log-insight/report.md`**.

### File Layout After Completion

```
log-analysis/log-insight/
├── briefing.txt
├── split-log.cjs
├── report.md                     ← final consolidated report
└── chunks/
    ├── chunk_1/
    │   ├── tmp_chunk_file        ← raw chunk data (persist, do NOT delete)
    │   └── report.md             ← sub-agent's per-chunk analysis
    ├── chunk_2/
    │   ├── tmp_chunk_file
    │   └── report.md
    └── chunk_N/
        ├── tmp_chunk_file
        └── report.md
```

