// Smoke test the installed plugin against the real Steam Market log file.
// Verifies that chunks[i].agent_prompt actually contains the full chunk text,
// not an empty placeholder.

import { readFile } from "node:fs/promises";

const pkgPath = "C:/Users/dr1m/.cache/opencode/packages/@dr39m/log-analyzer-suite@latest/node_modules/@dr39m/log-analyzer-suite/dist/index.js";

const mod = await import(`file:///${pkgPath.replace(/\\/g, "/")}`);
const LogAnalyzerSuite = mod.LogAnalyzerSuite;

const result = await LogAnalyzerSuite({
  directory: "C:/Users/dr1m/Desktop/github/steam/markets_and_trade_platforms/steam/steam_seller_multiacc",
  client: null,
  project: null,
  worktree: "",
  experimental_workspace: null,
  serverUrl: null,
  $: null,
});

const splitTool = result.tool.split_log_chunks;

const out = await splitTool.execute({
  logPath: "C:/Users/dr1m/Desktop/github/steam/markets_and_trade_platforms/steam/steam_seller_multiacc/logs/src.log",
  chunks: 3,
  contextTokens: 250,
  projectBriefing: "TEST_BRIEFING_PLACEHOLDER",
}, {});

const parsed = JSON.parse(out);

console.log("=== top-level metadata ===");
console.log("total_lines:", parsed.total_lines);
console.log("total_bytes:", parsed.total_bytes);
console.log("lines_per_chunk:", parsed.lines_per_chunk);
console.log("coverage_percent:", parsed.coverage_percent);
console.log("max_chunk_tokens:", parsed.max_chunk_tokens);
console.log("warnings:", parsed.warnings);

console.log("\n=== per-chunk verification ===");
for (const c of parsed.chunks) {
  const ap = c.agent_prompt;
  // Look at the LOG_CHUNK_CONTENT marker and what comes after
  const marker = "LOG_CHUNK_CONTENT";
  const markerIdx = ap.indexOf(marker);
  // The actual chunk content is between the two "---" dividers in the LOG_CHUNK_CONTENT block
  const afterFirstDash = ap.indexOf("---", markerIdx);
  const afterSecondDash = ap.indexOf("---", afterFirstDash + 3);
  const contentBlock = ap.substring(afterFirstDash + 3, afterSecondDash).trim();

  console.log(`\nchunk ${c.number}:`);
  console.log(`  meta: byte_size=${c.byte_size}, line_count=${c.line_count}, est_tokens=${c.est_tokens}`);
  console.log(`  agent_prompt.length: ${ap.length}`);
  console.log(`  content block length: ${contentBlock.length}`);
  console.log(`  content first 200 chars: ${JSON.stringify(contentBlock.substring(0, 200))}`);
  console.log(`  content last 200 chars: ${JSON.stringify(contentBlock.substring(contentBlock.length - 200))}`);
  console.log(`  briefing inlined: ${ap.includes("TEST_BRIEFING_PLACEHOLDER")}`);
  console.log(`  has {PROJECT_BRIEFING} placeholder leftover: ${ap.includes("{PROJECT_BRIEFING}")}`);
}
