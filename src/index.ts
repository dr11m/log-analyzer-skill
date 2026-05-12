/**
 * Log Analyzer Suite — OpenCode Plugin
 *
 * Provides one custom tool (split_log_chunks) that calculates offset/limit
 * pairs for chunked inductive log analysis. Everything else is driven by
 * skills using built-in tools (Read, Grep, Bash, Agent).
 *
 * Installation: add "@dr1m/log-analyzer-suite" to opencode.json plugins.
 * Skills and commands are auto-bootstrapped on first run.
 */
import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { join } from "path";

// ---------------------------------------------------------------------------
// Embedded skill & command content
// ---------------------------------------------------------------------------

async function readBundledFile(relativePath: string): Promise<string> {
  const fullPath = join(import.meta.dir, "..", relativePath);
  const file = Bun.file(fullPath);
  if (await file.exists()) return file.text();
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
// Skill bootstrapper
// ---------------------------------------------------------------------------

async function bootstrapSkill(
  skillName: string,
  skillsDir: string,
): Promise<void> {
  const skillFile = join(skillsDir, skillName, "SKILL.md");
  if (await Bun.file(skillFile).exists()) return;

  const content = await readBundledFile(join("skills", `${skillName}.md`));
  await Bun.write(skillFile, content, { createPath: true });
}

async function bootstrapSkills(cwd: string): Promise<void> {
  const skillsDir = join(cwd, ".opencode", "skills");
  await Promise.all([
    bootstrapSkill("log-insight", skillsDir),
    bootstrapSkill("log-validate", skillsDir),
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
  // Reads the log file, calculates chunk offsets, returns metadata.
  // Does NOT write files — sub-agents use Read(offset, limit) on the
  // original log file.
  // -----------------------------------------------------------------------

  const splitLogChunksTool = tool({
    description:
      "Calculate chunk boundaries for chunked log analysis. " +
      "Reads a log file, counts lines and bytes, then computes N equal-sized " +
      "offset/limit pairs from the END of the file (newest data). " +
      "Returns JSON with total lines, bytes, lines per chunk, coverage %, " +
      "and an array of {number, offset, limit} for each chunk. " +
      "Chunk 1 = oldest analyzed, Chunk N = newest. " +
      "Does NOT write chunk files to disk — sub-agents should use the Read " +
      "tool with the returned offset/limit values on the original log file.",
    args: {
      logPath: tool.schema
        .string()
        .describe("Absolute path to the log file"),
      chunks: tool.schema
        .number()
        .describe("Number of chunks to analyze (e.g. 5)"),
    },
    async execute(args, _ctx) {
      const logPath = args.logPath as string;
      const requestedChunks = args.chunks as number;

      const file = Bun.file(logPath);
      if (!(await file.exists())) {
        return JSON.stringify({ error: `Log file not found: ${logPath}` });
      }

      const totalBytes = file.size;
      const text = await file.text();
      // Count lines preserving the last empty string from trailing \n
      const lines = text.split("\n");
      const totalLines = lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;

      const avgBytesPerLine = totalLines > 0 ? totalBytes / totalLines : 100;
      const targetChunkBytes = 500_000;

      let linesPerChunk = Math.floor(targetChunkBytes / avgBytesPerLine);
      linesPerChunk = Math.min(linesPerChunk, 10_000);
      linesPerChunk = Math.min(linesPerChunk, Math.floor(totalLines / requestedChunks));
      if (linesPerChunk < 1) linesPerChunk = 1;

      // Overflow check
      if (totalLines < requestedChunks * 100 && requestedChunks > 1) {
        const reduced = Math.max(1, Math.floor(totalLines / 100));
        return JSON.stringify({
          error: `File too small: ${totalLines} lines for ${requestedChunks} chunks. ` +
            `Suggest N=${reduced} or smaller.`,
        });
      }

      const manifestChunks: Record<string, unknown>[] = [];
      for (let i = 1; i <= requestedChunks; i++) {
        const offset = totalLines - (requestedChunks - i + 1) * linesPerChunk + 1;
        manifestChunks.push({
          number: i,
          total: requestedChunks,
          offset: Math.max(1, offset),
          limit: linesPerChunk,
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
