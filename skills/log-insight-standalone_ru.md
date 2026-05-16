---
name: log-insight-standalone
description: Универсальный индуктивный анализ логов с разбиением на чанки. Плагин не требуется — используется встроенный Node.js-скрипт для разделения. Работает на любой агентной платформе с Bash + Node.js. Принимает запросы вида «analyze logs/app.log with 5 chunks» или «/log-insight-standalone --chunks 5 --log logs/app.log».
---

# Log Insight (Standalone)

## Контракт

Действуй как оркестратор. Не анализируй содержимое логов самостоятельно — твоя задача координировать разбиение и анализ суб-агентами.

Используй язык пользователя для отчётов и пояснений. Строки логов, идентификаторы кода, имена исключений, пути к файлам и технические термины оставляй как есть.

Этот навык намеренно индуктивный: каждый суб-агент получает один полный чанк лога плюс контекст проекта, встроенный непосредственно в промпт. Суб-агенты делают ровно один вызов инструмента для получения чанка, а затем рассуждают исключительно на основе полученного содержимого.

### Бюджет контекста (токены, не байты)

Флаг `--context K` задаёт окно контекста суб-агента в **тысячах токенов** (например, 200 = 200K, 700 = 700K). Каждый чанк рассчитан на **70% этого окна**, оставляя место для PROJECT_BRIEFING и ответа суб-агента.

Этот лимит в **единицах токенизатора модели**, приблизительно оцениваемых как bytes / 3.5. Это НЕ про:
- Символы, байты или килобайты файла лога
- Количество строк лога
- Размер файла по данным файловой системы

Скрипт сообщает `lines_per_chunk`, `max_chunk_tokens` и выдаёт `warnings[]`, когда файл слишком большой для N чанков при выбранном контексте. Если предупреждения указывают на неполное покрытие, сообщи об этом пользователю и предложи увеличить `--chunks` или `--context`.

## Обязательные входные данные

Разбирай запрос пользователя как флаги (порядок не важен):

- `--chunks N` (целое число, обязательный) — количество чанков для анализа
- `--log <path>` (строка, необязательный) — явный путь к файлу лога. Если не указан — автоматическое обнаружение.
- `--context <K>` (целое число, необязательный, по умолчанию 200) — окно контекста суб-агента в тысячах токенов.

Примеры: `/log-insight-standalone --chunks 5 --log logs/app.log`, `/log-insight-standalone --chunks 3`, `/log-insight-standalone --chunks 5 --context 700`.

Если `--chunks` отсутствует, спроси у пользователя. Если `--log` отсутствует, автоматическое обнаружение в следующей фазе.

## Предварительные требования

### Node.js

Выполни `node --version`. Если Node.js недоступен, ОСТАНОВИСЬ и скажи пользователю установить его. Node.js обязателен, потому что логика разбиения выполняется как скрипт — без плагинов, без Python, без внешних зависимостей.

### opencode tool_output (только для opencode)

При работе внутри opencode проверь, что `opencode.json` (локальный `.opencode/opencode.json` или глобальный `~/.config/opencode/opencode.json`) содержит переопределение `tool_output`:

```json
{
  "tool_output": {
    "max_lines": 500000,
    "max_bytes": 8388608
  }
}
```

Вывод Bash суб-агента (cat файла чанка) проходит через pipeline tool_output. Ограничение opencode по умолчанию — **50 КБ** — без этого переопределения суб-агенты получат обрезанные чанки. Если не можешь найти переопределение, **остановись и скажи пользователю** добавить его перед продолжением.

Другие агентные платформы (Claude Code, Cursor, Windsurf/Devin и т.д.) обычно не имеют этого ограничения вывода Bash в 50 КБ, поэтому этот шаг можно пропустить.

## Фаза 1: Сначала собери контекст проекта

Перед разбиением или запуском суб-агентов прочитай документацию и правила репозитория.

Составь один `PROJECT_BRIEFING` для всех суб-агентов:

- Прочитай `AGENTS.md` и `CLAUDE.md`, если они существуют.
- Прочитай `docs/*.md`, если они существуют.
- Прочитай `README.md`, если он содержит контекст рантайма или бизнес-логики.
- Включи бизнес-правила и правила рабочего процесса с высокой точностью. Если существуют `docs/rules.md`, `docs/business_rules.md` или эквивалентные файлы, включи важный текст правил напрямую.
- Опиши архитектуру, поток выполнения, компоненты, ожидаемый путь успешного выполнения, доменные правила, требования к конфигурации, переходы состояний и известные инварианты.
- Брифинг должен быть компактным — он должен помещаться вместе с одним чанком в бюджет ~140K токенов.

Брифинг должен передаваться напрямую в каждый промпт суб-агента. Суб-агенты не должны самостоятельно читать документы или исходные файлы проекта.

## Фаза 2: Разбей лог на чанки

### Шаг 1: Запиши файл брифинга

Запиши текст PROJECT_BRIEFING в `.opencode/briefing.txt`. Это позволяет избежать проблем с экранированием в CLI при передаче многострочного текста с кавычками в скрипт.

### Шаг 2: Запиши скрипт разбиения

Запиши следующий JavaScript в `.opencode/split-log.cjs` (расширение `.cjs` гарантирует совместимость с CommonJS, даже если `package.json` проекта содержит `"type": "module"`):

```javascript
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
const chunksDir = getArg("chunks-dir") || ".opencode/chunks";
// Примечание: этот скрипт намеренно использует CommonJS (require).
// Расширение .cjs гарантирует, что Node обработает его как CommonJS,
// даже когда package.json проекта имеет "type": "module".

if (!logPath || !requestedChunks) {
  console.error("Usage: node split-log.js --log <path> --chunks <N> [--context <K>] [--briefing-file <path>] [--chunks-dir <dir>]");
  process.exit(1);
}

// --- Константы (аналогично плагину) ---
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

// --- Очистка и создание директории чанков ---
if (fs.existsSync(chunksDir)) {
  fs.rmSync(chunksDir, { recursive: true });
}
fs.mkdirSync(chunksDir, { recursive: true });

// --- Шаблон промпта агента (аналогично плагину) ---
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

### Шаг 3: Запусти скрипт

Запусти скрипт через Bash:

```
node .opencode/split-log.cjs --log <абсолютный-путь> --chunks <N> --context <K> --briefing-file .opencode/briefing.txt
```

- `--log` должен быть **абсолютным путём** к файлу лога.
- `--chunks` — это N из флага `--chunks` пользователя.
- `--context` — это K из флага `--context` пользователя (необязательный, по умолчанию 200).
- `--briefing-file` — путь, куда был записан PROJECT_BRIEFING на шаге 1.

Скрипт выводит JSON-манифест в stdout. Разбери его.

### Шаг 4: Покажи предупреждения и сводку

Выведи пользователю сводку: N чанков, lines_per_chunk, coverage_percent, max_chunk_tokens.

Если `warnings[]` не пуст, покажи каждое предупреждение пользователю перед запуском суб-агентов.

Если `coverage_percent < 5`, предупреди пользователя и предложи увеличить N или `--context`.

## Фаза 3: Запусти по одному суб-агенту на чанк

JSON-манифест содержит массив `chunks[]`. Каждый элемент имеет поле `agent_prompt` — **полностью самодостаточный** промпт суб-агента.

Для каждого чанка `i`:
1. Возьми `chunks[i].agent_prompt` из манифеста.
2. Передай эту строку как промпт в механизм суб-агентов твоей платформы.

**Все N суб-агентов должны быть запущены параллельно** (один блок ответа, если платформа это поддерживает).

### Что передаёт оркестратор vs что делают суб-агенты

`chunks[i].agent_prompt` компактен (~15-50 КБ). Он содержит PROJECT_BRIEFING + инструкции анализа + одну директиву Bash:

```
Bash(command="cat <путь_к_файлу_чанка>")
```

Каждый суб-агент делает **РОВНО ОДИН** вызов Bash для `cat` своего файла чанка. Этот единственный Bash возвращает полный чанк (потому что `tool_output` в opencode.json имеет `max_bytes >= 8 МБ`, или потому что платформа не обрезает вывод Bash). Затем суб-агент рассуждает над выводом и формирует структурированный отчёт.

### Запрещённые манипуляции (между манифестом и запуском суб-агента)

- НЕ сохраняй `chunks[i].agent_prompt` в файл, НЕ разбивай его на сегменты, НЕ вызывай Python/PowerShell/Node.
- НЕ модифицируй строку `Bash(...)` в `agent_prompt` (пути к файлам чанков предварительно вычислены скриптом).
- НЕ подставляй плейсхолдеры — их не осталось, скрипт встроил `{PROJECT_BRIEFING}`, когда ты передал `--briefing-file`.

### Ограничения суб-агентов (также указаны внутри agent_prompt)

У суб-агентов **бюджет инструментов — ровно ОДИН вызов Bash**. Никаких Read, Grep, Glob, Task, никаких дополнительных вызовов Bash. Единственный `cat` получает весь чанк; всё остальное — чистое рассуждение над выводом Bash.

## Фаза 4: Консолидация

Дождись завершения всех суб-агентов. Финальный отчёт строй только на основе ответов суб-агентов и контекста проекта. Не открывай файл лога для собственного анализа.

Объедини дублирующиеся находки:
- Одна и та же корневая причина в нескольких чанках → один элемент отчёта.
- Агрегируй общее количество, затронутые чанки и полный временной диапазон.
- Оставь наиболее наглядную строку-доказательство.
- Обозначь тренд: изолированный / стабильный / улучшающийся / ухудшающийся / скачкообразный по чанкам.

Построй временнýю шкалу метрик из каждой секции `### Cross-Chunk Signals`:

```markdown
| Метрика | Чанк 1 | Чанк 2 | ... | Чанк N | Тренд |
|---------|--------|--------|-----|--------|-------|
| errors_total | 0 | 2 | ... | 7 | ухудшение |
```

Сортировка находок:
1. CRITICAL перед MEDIUM перед LOW.
2. Больше затронутых чанков — выше.
3. Большее общее количество — выше.

Заверши **одним абзацем с резюме руководства**, охватывающим наиболее важные находки, их корневые причины и рекомендуемые следующие шаги.
