---
name: log-insight-standalone
description: Universal chunked inductive log analysis. No plugin required — uses an inline Node.js script for splitting. Works in any agent platform with Bash + Node.js. Accepts requests like "analyze logs/app.log with 5 chunks" or "/log-insight-standalone --chunks 5 --log logs/app.log".
---

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

Before splitting or launching sub-agents, read repository documentation and rules.

Build one `PROJECT_BRIEFING` for all sub-agents:

- Read `AGENTS.md` and `CLAUDE.md` if present.
- Read `docs/*.md` if present.
- Read `README.md` if it contains runtime or business context.
- Include business rules and workflow rules with high fidelity. If `docs/rules.md`, `docs/business_rules.md`, or equivalent files exist, include their important rule text directly.
- Summarize architecture, runtime flow, components, expected success path, domain rules, configuration requirements, state transitions, and known invariants.
- Keep the briefing compact — it must fit alongside one chunk within the ~140K token budget.

The briefing must be passed directly in every sub-agent prompt. Sub-agents must not read project docs or source files themselves.

## Phase 2: Split the Log into Chunks

### Step 1: Write the briefing file

Write your PROJECT_BRIEFING text to `.opencode/briefing.txt`. This avoids CLI escaping issues when passing multiline text with quotes to the script.

### Step 2: Write the split script

Write the following JavaScript to `.opencode/split-log.cjs` (the `.cjs` extension ensures CommonJS compatibility even if the project's `package.json` has `"type": "module"`):

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
const chunksDir = getArg("chunks-dir") || ".opencode/chunks";
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

// --- Clean up and create chunks dir ---
if (fs.existsSync(chunksDir)) {
  fs.rmSync(chunksDir, { recursive: true });
}
fs.mkdirSync(chunksDir, { recursive: true });

// --- Agent prompt template (same as plugin) ---
const PROMPT_TEMPLATE = [
  "You are a log chunk analyzer. Analyze exactly one chunk of a log file.",
  "Use the user's language for prose in your final answer. Keep log lines, exception names, code identifiers, paths, and technical terms as written.",
  "",
  "Hard tool rules:",
  '- You may make EXACTLY ONE tool call: Bash(command="cat __CHUNK_FILE__"). That single Bash returns the FULL chunk because the user has tool_output.max_bytes set high enough (>= 8 MB) or their platform does not truncate Bash output.',
  "- After that one Bash: ZERO further tool calls. Do NOT call Bash again, do NOT call Read/Grep/Glob/Task/Write/any other tool. Do NOT loop, do NOT shell out.",
  '- If the Bash output has fewer than __LINE_COUNT__ lines, report that exact fact in your output ("Bash returned only N of __LINE_COUNT__ lines — tool_output likely not configured") and analyze whatever you got. Do NOT retry.',
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
].join("\n");

function renderAgentPrompt(chunkNumber, totalChunks, byteSize, lineCount, chunkFile, offset, briefing) {
  const briefingBlock = briefing.length > 0 ? briefing : "{PROJECT_BRIEFING}";
  const offsetEnd = offset + lineCount - 1;
  return PROMPT_TEMPLATE
    .replaceAll("__CHUNK_NUMBER__", String(chunkNumber))
    .replaceAll("__TOTAL_CHUNKS__", String(totalChunks))
    .replaceAll("__BYTE_SIZE__", String(byteSize))
    .replaceAll("__LINE_COUNT__", String(lineCount))
    .replaceAll("__CHUNK_FILE__", chunkFile.replace(/\\/g, "/"))
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
  const chunkFile = path.join(chunksDir, "chunk_" + i + ".log");
  fs.writeFileSync(chunkFile, chunkText, "utf8");
  manifestChunks.push({
    number: i,
    total: requestedChunks,
    offset: offset,
    byte_size: byteSize,
    line_count: lineCount,
    chunk_file: chunkFile,
    est_tokens: Math.round(byteSize / BYTES_PER_TOKEN),
    agent_prompt: renderAgentPrompt(i, requestedChunks, byteSize, lineCount, chunkFile, offset, projectBriefing),
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

### Step 3: Run the script

Run the script via Bash:

```
node .opencode/split-log.cjs --log <absolute-path> --chunks <N> --context <K> --briefing-file .opencode/briefing.txt
```

- `--log` must be an **absolute path** to the log file.
- `--chunks` is N from the user's `--chunks` flag.
- `--context` is K from the user's `--context` flag (optional, default 200).
- `--briefing-file` is the path where you wrote the PROJECT_BRIEFING in Step 1.

The script outputs a JSON manifest to stdout. Parse it.

### Step 4: Surface warnings and summary

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

`chunks[i].agent_prompt` is compact (~15-50 KB). It contains PROJECT_BRIEFING + analysis instructions + a single Bash directive:

```
Bash(command="cat <chunk_file_path>")
```

Each sub-agent makes **EXACTLY ONE** Bash tool call to `cat` its chunk file. That single Bash returns the full chunk (because `tool_output` in opencode.json has `max_bytes >= 8 MB`, or because the platform does not truncate Bash output). Then the sub-agent reasons over the output and produces the structured report.

### Forbidden manipulations (between manifest and sub-agent launch)

- Do NOT save `chunks[i].agent_prompt` to a file, do NOT split it into segments, do NOT shell out to Python/PowerShell/Node.
- Do NOT modify the `Bash(...)` line in `agent_prompt` (chunk_file paths are pre-computed by the script).
- Do NOT substitute placeholders — there are none left, the script inlined `{PROJECT_BRIEFING}` when you passed `--briefing-file`.

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
2. More affected chunks first.
3. Higher total count first.

End with a **one-paragraph executive summary** covering the most important findings, their root causes, and recommended next steps.

