/**
 * Log Analyzer Suite — OpenCode Plugin
 *
 * Provides one custom tool (split_log_chunks) that splits a log file into N
 * equal chunks and returns the raw text of each chunk inline. The orchestrator
 * then passes each chunk's content directly into a sub-agent prompt — no Read
 * tool calls by sub-agents, no offset/limit math, no 50KB Read cap.
 *
 * Installation: add "@dr39m/log-analyzer-suite" to opencode.json plugins.
 * Skills and commands are auto-bootstrapped on first run.
 */
import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile, stat, mkdir, rm, access } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Embedded skill & command content (Node fs, no Bun-specific APIs)
// ---------------------------------------------------------------------------

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(PLUGIN_DIR, "..");

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function readBundledFile(relativePath: string): Promise<string> {
  // PLUGIN_DIR points at dist/. Static assets (skills/, commands/, package.json)
  // live in the package root, one level up.
  const fullPath = join(PACKAGE_ROOT, relativePath);
  if (await pathExists(fullPath)) return readFile(fullPath, "utf8");
  throw new Error(`Bundled file not found: ${fullPath}`);
}

// ---------------------------------------------------------------------------
// YAML frontmatter parser for command .md files
// ---------------------------------------------------------------------------

interface CommandFrontmatter {
  description?: string;
  agent?: string;
  model?: string;
  subtask?: boolean;
}

interface ParsedCommand {
  name: string;
  frontmatter: CommandFrontmatter;
  template: string;
}

function parseFrontmatter(content: string): {
  frontmatter: CommandFrontmatter;
  body: string;
} {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content.trim() };

  const [, yamlContent, body] = match;
  const fm: CommandFrontmatter = {};

  for (const line of yamlContent.split("\n")) {
    const ci = line.indexOf(":");
    if (ci === -1) continue;
    const key = line.slice(0, ci).trim();
    const value = line.slice(ci + 1).trim();
    if (key === "description") fm.description = value;
    if (key === "agent") fm.agent = value;
    if (key === "model") fm.model = value;
    if (key === "subtask") fm.subtask = value === "true";
  }

  return { frontmatter: fm, body: body.trim() };
}

// ---------------------------------------------------------------------------
// Skill bootstrapper (version-aware)
//
// Writes a sidecar `.bundle-version` next to each SKILL.md. On startup, if the
// installed version does not match the bundled plugin version, SKILL.md is
// rewritten. This lets `opencode plugin <name> --force` update both the tool
// code AND the skill in one step, without users having to delete .opencode/.
// ---------------------------------------------------------------------------

async function readBundledPluginVersion(): Promise<string> {
  const pkgText = await readBundledFile("package.json");
  const pkg = JSON.parse(pkgText) as { version?: string };
  return pkg.version ?? "0.0.0";
}

async function bootstrapSkill(
  skillName: string,
  skillsDir: string,
  pluginVersion: string,
): Promise<void> {
  const skillDir = join(skillsDir, skillName);
  const skillFile = join(skillDir, "SKILL.md");
  const versionFile = join(skillDir, ".bundle-version");

  if (await pathExists(skillFile)) {
    const installedVersion = (await pathExists(versionFile))
      ? (await readFile(versionFile, "utf8")).trim()
      : null;
    if (installedVersion === pluginVersion) return;
  }

  const content = await readBundledFile(join("skills", `${skillName}.md`));
  await mkdir(skillDir, { recursive: true });
  await writeFile(skillFile, content, "utf8");
  await writeFile(versionFile, pluginVersion, "utf8");
}

async function bootstrapSkills(cwd: string): Promise<void> {
  const skillsDir = join(cwd, ".opencode", "skills");
  const pluginVersion = await readBundledPluginVersion();
  await Promise.all([
    bootstrapSkill("log-insight", skillsDir, pluginVersion),
    bootstrapSkill("log-validate", skillsDir, pluginVersion),
  ]);
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const LogAnalyzerSuite: Plugin = async ({ directory, client }) => {
  // Bootstrap skills on first run (best-effort, non-blocking)
  bootstrapSkills(directory).catch(() => {});

  // Pre-load commands
  const commandNames = ["log-insight", "log-validate"];
  const parsedCommands: ParsedCommand[] = [];
  for (const name of commandNames) {
    try {
      const content = await readBundledFile(join("commands", `${name}.md`));
      const { frontmatter, body } = parseFrontmatter(content);
      parsedCommands.push({ name, frontmatter, template: body });
    } catch {
      // Skip missing command files
    }
  }

  // -----------------------------------------------------------------------
  // Tool: split_log_chunks
  //
  // Reads the log file, splits it into N equal chunks bounded by 70% of the
  // model context window, and returns each chunk's raw text inline. The
  // orchestrator embeds chunk content directly into sub-agent prompts —
  // sub-agents never call Read.
  // -----------------------------------------------------------------------

  const MAX_FILE_BYTES = 200 * 1024 * 1024; // 200 MB safety cap (file is loaded fully into memory)
  const BYTES_PER_TOKEN = 3.5; // conservative estimate for mixed-content logs
  const CHUNK_BUDGET_RATIO = 0.7; // each chunk fills up to 70% of context window

  // Sub-agent prompt template. The tool writes each chunk to a temp file and fills
  // CHUNK_NUMBER/TOTAL/BYTE_SIZE/LINE_COUNT/CHUNK_FILE/OFFSET/OFFSET_END in agent_prompt.
  // The sub-agent makes EXACTLY ONE Bash call (cat <chunk_file>) to fetch its chunk.
  // Bash output goes through tool_output config (max_bytes) — NOT subject to the
  // Read tool's internal 50KB cap. Requires tool_output override in opencode.json.
  const SUBAGENT_PROMPT_TEMPLATE = `You are a log chunk analyzer. Analyze exactly one chunk of a log file.
Use the user's language for prose in your final answer. Keep log lines, exception names, code identifiers, paths, and technical terms as written.

Hard tool rules:
- You may make EXACTLY ONE tool call: Bash(command="cat __CHUNK_FILE__"). That single Bash returns the FULL chunk because the user's opencode.json has tool_output.max_bytes set high enough (>= 8 MB).
- After that one Bash: ZERO further tool calls. Do NOT call Bash again, do NOT call Read/Grep/Glob/Task/Write/any other tool. Do NOT loop, do NOT shell out.
- If the Bash output has fewer than __LINE_COUNT__ lines, report that exact fact in your output ("Bash returned only N of __LINE_COUNT__ lines — tool_output likely not configured") and analyze whatever you got. Do NOT retry.

Purpose:
This is inductive log analysis. You must reason from the complete chunk content, not from filtered matches. Compare observed behavior against the project rules and expected runtime flow.

Chunk metadata:
- Chunk: __CHUNK_NUMBER__/__TOTAL_CHUNKS__
- File range: lines __OFFSET__ to __OFFSET_END__
- Size: __BYTE_SIZE__ bytes, __LINE_COUNT__ lines
- Ordering: chunk 1 is the oldest analyzed chunk, chunk __TOTAL_CHUNKS__ is the newest.

PROJECT_BRIEFING:
---
{PROJECT_BRIEFING}
---

YOUR LOG CHUNK — fetch it now with ONE Bash call:
    Bash(command="cat __CHUNK_FILE__")

That single Bash returns lines __OFFSET__ through __OFFSET_END__ — chunk __CHUNK_NUMBER__/__TOTAL_CHUNKS__, __LINE_COUNT__ lines / __BYTE_SIZE__ bytes total.

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

## Chunk __CHUNK_NUMBER__/__TOTAL_CHUNKS__
**Time range:** <first timestamp> -> <last timestamp>

### CRITICAL
- **<title>**: <description, exact count, first/last timestamp>
  - Evidence: \`<representative log line>\`
  - Expected behavior: <from PROJECT_BRIEFING, or N/A>
  - Root cause hypothesis: <best hypothesis from chunk context>

### MEDIUM
- **<title>**: <description, exact count, first/last timestamp>
  - Evidence: \`<representative log line>\`
  - Expected behavior: <from PROJECT_BRIEFING, or N/A>

### LOW
- **<title>**: <description, exact count, first/last timestamp>
  - Evidence: \`<representative log line>\`

### Chunk Statistics
- Lines analyzed: __LINE_COUNT__
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

If no findings in a severity section, write \`None\`.

Before returning, verify:
- Every finding has an exact count.
- Every finding has first AND last timestamps.
- \`### Cross-Chunk Signals\` is present.
`;

  function renderAgentPrompt(
    chunkNumber: number,
    totalChunks: number,
    byteSize: number,
    lineCount: number,
    chunkFile: string,
    offset: number,
    projectBriefing: string,
  ): string {
    const briefingBlock = projectBriefing.length > 0
      ? projectBriefing
      : "{PROJECT_BRIEFING}";
    const offsetEnd = offset + lineCount - 1;
    return SUBAGENT_PROMPT_TEMPLATE
      .replaceAll("__CHUNK_NUMBER__", String(chunkNumber))
      .replaceAll("__TOTAL_CHUNKS__", String(totalChunks))
      .replaceAll("__BYTE_SIZE__", String(byteSize))
      .replaceAll("__LINE_COUNT__", String(lineCount))
      .replaceAll("__CHUNK_FILE__", chunkFile.replace(/\\/g, "/"))
      .replaceAll("__OFFSET__", String(offset))
      .replaceAll("__OFFSET_END__", String(offsetEnd))
      .replace("{PROJECT_BRIEFING}", briefingBlock);
  }

  const splitLogChunksTool = tool({
    description:
      "Split a log file into N equal chunks and return a ready-to-send sub-agent prompt for each chunk. " +
      "Chunks are sliced from the END of the file (newest data first) so the most recent " +
      "lines are always covered. Each chunk is sized to ~70% of the model context window. " +
      "Chunk 1 = oldest analyzed slice, Chunk N = newest (file tail). " +
      "Each chunk is written to a temp file under .opencode/chunks/ and chunks[i].agent_prompt " +
      "is a compact Task prompt (~15-50 KB) containing PROJECT_BRIEFING + analysis instructions + " +
      "a ONE-line Bash(cat) directive. The sub-agent makes exactly one Bash call to fetch its chunk " +
      "and then analyzes it. REQUIRES tool_output override in opencode.json (max_bytes >= 8 MB) " +
      "so the sub-agent's Bash output is not truncated. Without that override, sub-agents will get " +
      "partial chunks.",
    args: {
      logPath: tool.schema
        .string()
        .describe("Absolute path to the log file"),
      chunks: tool.schema
        .number()
        .describe("Number of chunks to produce (e.g. 5)"),
      contextTokens: tool.schema
        .number()
        .optional()
        .describe(
          "Model context window in THOUSANDS OF TOKENS (e.g. 200 = 200K tokens, 700 = 700K tokens). " +
          "Default: 200. Each chunk is capped at contextTokens * 1000 * 0.70 tokens, " +
          "estimated as bytes / 3.5.",
        ),
      projectBriefing: tool.schema
        .string()
        .optional()
        .describe(
          "Project briefing text built in Phase 1 (architecture notes, business rules, etc.). " +
          "If provided, the tool inlines it into each chunks[i].agent_prompt so the orchestrator " +
          "can forward the prompt to Task as-is, with NO further string substitution. " +
          "If omitted, agent_prompt keeps a {PROJECT_BRIEFING} placeholder for backward compatibility.",
        ),
    },
    async execute(args, _ctx) {
      const logPath = args.logPath as string;
      const requestedChunks = args.chunks as number;
      const contextTokens = (args.contextTokens as number | undefined) ?? 200;
      const projectBriefing = (args.projectBriefing as string | undefined) ?? "";

      if (!(await pathExists(logPath))) {
        return JSON.stringify({ error: `Log file not found: ${logPath}` });
      }

      const totalBytes = (await stat(logPath)).size;
      if (totalBytes > MAX_FILE_BYTES) {
        return JSON.stringify({
          error:
            `Log file too large: ${totalBytes} bytes exceeds the ${MAX_FILE_BYTES}-byte safety cap. ` +
            `Pre-trim the file (e.g. tail -n 100000) before running /log-insight.`,
        });
      }

      const text = await readFile(logPath, "utf8");
      // Count lines preserving the last empty string from trailing \n
      const lines = text.split("\n");
      const totalLines = lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;

      const avgBytesPerLine = totalLines > 0 ? totalBytes / totalLines : 100;

      // 70% of context, converted to bytes via BYTES_PER_TOKEN
      const maxChunkTokens = contextTokens * 1000 * CHUNK_BUDGET_RATIO;
      const maxChunkBytes = Math.floor(maxChunkTokens * BYTES_PER_TOKEN);
      const linesByContext = Math.max(1, Math.floor(maxChunkBytes / avgBytesPerLine));
      const linesByDivision = Math.max(1, Math.floor(totalLines / requestedChunks));
      const linesPerChunk = Math.min(linesByContext, linesByDivision);

      // File too small to give each chunk a reasonable number of lines.
      if (totalLines < requestedChunks * 10 && requestedChunks > 1) {
        const reduced = Math.max(1, Math.floor(totalLines / 10));
        return JSON.stringify({
          error:
            `File too small: ${totalLines} lines for ${requestedChunks} chunks. ` +
            `Suggest --chunks ${reduced} or smaller.`,
        });
      }

      const warnings: string[] = [];

      // Coverage warning: chunk size was capped by the context budget, not by division.
      if (linesByContext < linesByDivision) {
        const analyzedLines = requestedChunks * linesPerChunk;
        const uncoveredPercent = ((totalLines - analyzedLines) / totalLines) * 100;
        warnings.push(
          `chunk_size capped at 70% of context (${linesPerChunk} lines/chunk). ` +
          `~${uncoveredPercent.toFixed(1)}% of the file is uncovered — ` +
          `raise --chunks or --context for fuller coverage.`,
        );
      }

      // Sanity warning: chunks have too few lines to be useful.
      if (linesPerChunk < 100) {
        warnings.push(
          `chunk size very small: ${linesPerChunk} lines/chunk. ` +
          `Consider lowering --chunks for more meaningful analysis windows.`,
        );
      }

      // Write chunks to temp files under .opencode/chunks/ so sub-agents can
      // cat them via Bash (Bash output goes through tool_output, no 50KB Read cap).
      const chunksDir = join(directory, ".opencode", "chunks");
      await mkdir(chunksDir, { recursive: true });

      // Clean up old chunk files from previous runs
      try { await rm(chunksDir, { recursive: true }); } catch { /* ignore */ }
      await mkdir(chunksDir, { recursive: true });

      const manifestChunks: Record<string, unknown>[] = [];
      for (let i = 1; i <= requestedChunks; i++) {
        const rawOffset = totalLines - (requestedChunks - i + 1) * linesPerChunk + 1;
        const offset = Math.max(1, rawOffset);
        const chunkLines = lines.slice(offset - 1, offset - 1 + linesPerChunk);
        // Sanitize: strip ANSI escape codes and C0 control chars (except \n \r \t).
        // Reason: sub-agent Bash cat output goes through tool_output JSON serialization.
        // Unprintable control bytes and unescaped escape sequences can cause issues.
        const chunkText = chunkLines.join("\n")
          .replace(/\x1B\[[0-9;]*[A-Za-z]/g, "")       // ANSI CSI escape codes
          .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ""); // C0 controls + DEL, keep \n \r \t
        const byteSize = Buffer.byteLength(chunkText, "utf8");
        const lineCount = chunkLines.length;
        const chunkFile = join(chunksDir, `chunk_${i}.log`);
        await writeFile(chunkFile, chunkText, "utf8");
        manifestChunks.push({
          number: i,
          total: requestedChunks,
          offset,
          byte_size: byteSize,
          line_count: lineCount,
          chunk_file: chunkFile,
          est_tokens: Math.round(byteSize / BYTES_PER_TOKEN),
          agent_prompt: renderAgentPrompt(i, requestedChunks, byteSize, lineCount, chunkFile, offset, projectBriefing),
        });
      }

      const analyzedLines = requestedChunks * linesPerChunk;
      const coveragePercent = totalLines > 0
        ? (analyzedLines / totalLines) * 100
        : 0;

      return JSON.stringify(
        {
          source_path: logPath,
          total_lines: totalLines,
          total_bytes: totalBytes,
          lines_per_chunk: linesPerChunk,
          analyzed_lines: analyzedLines,
          coverage_percent: Number(coveragePercent.toFixed(1)),
          context_tokens_k: contextTokens,
          max_chunk_tokens: Math.round(maxChunkTokens),
          warnings,
          chunks: manifestChunks,
        },
        null,
        2,
      );
    },
  });

  // -----------------------------------------------------------------------

  return {
    tool: {
      split_log_chunks: splitLogChunksTool,
    },

    async config(config) {
      config.command = config.command ?? {};

      for (const cmd of parsedCommands) {
        config.command[cmd.name] = {
          template: cmd.template,
          ...(cmd.frontmatter.description && {
            description: cmd.frontmatter.description,
          }),
          ...(cmd.frontmatter.agent && { agent: cmd.frontmatter.agent }),
          ...(cmd.frontmatter.model && { model: cmd.frontmatter.model }),
          ...(cmd.frontmatter.subtask !== undefined && {
            subtask: cmd.frontmatter.subtask,
          }),
        };
      }
    },
  };
};
