#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");

// --- Парсинг аргументов CLI ---
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

if (!logPath || !requestedChunks) {
  console.error("Usage: node split-log.js --log <path> --chunks <N> [--context <K>] [--briefing-file <path>] [--chunks-dir <dir>]");
  process.exit(1);
}

// --- Константы ---
const MAX_FILE_BYTES = 200 * 1024 * 1024;
const BYTES_PER_TOKEN = 3.5;
const CHUNK_BUDGET_RATIO = 0.7;

// --- Чтение файла лога ---
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

// --- Расчёт размера чанков ---
const maxChunkTokens = contextTokensK * 1000 * CHUNK_BUDGET_RATIO;
const maxChunkBytes = Math.floor(maxChunkTokens * BYTES_PER_TOKEN);
const linesByContext = Math.max(1, Math.floor(maxChunkBytes / avgBytesPerLine));
const linesByDivision = Math.max(1, Math.floor(totalLines / requestedChunks));
const linesPerChunk = Math.min(linesByContext, linesByDivision);

// --- Проверка: файл слишком маленький ---
if (totalLines < requestedChunks * 10 && requestedChunks > 1) {
  const reduced = Math.max(1, Math.floor(totalLines / 10));
  console.error("File too small: " + totalLines + " lines for " + requestedChunks + " chunks. Suggest --chunks " + reduced + " or smaller.");
  process.exit(1);
}

// --- Предупреждения ---
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

// --- Чтение брифинга ---
let projectBriefing = "";
if (briefingFile && fs.existsSync(briefingFile)) {
  projectBriefing = fs.readFileSync(briefingFile, "utf8");
}

// --- Создание директории чанков ---
fs.mkdirSync(chunksDir, { recursive: true });

// --- Шаблон промпта агента ---
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

// --- Сборка чанков ---
const manifestChunks = [];
for (let i = 1; i <= requestedChunks; i++) {
  const rawOffset = totalLines - (requestedChunks - i + 1) * linesPerChunk + 1;
  const offset = Math.max(1, rawOffset);
  const chunkLines = lines.slice(offset - 1, offset - 1 + linesPerChunk);
  // Санитизация: удаление ANSI escape-последовательностей и управляющих символов C0 (кроме \n \r \t)
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
