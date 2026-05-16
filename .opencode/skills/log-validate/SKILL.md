---
name: log-validate
description: Code-aware deductive log validation. Use when the user asks to validate a log file against the project source code — builds a Log Signature Map from all logger calls in the codebase, then greps the log for every expected pattern, detecting errors, anomalies, and silent components with full file coverage. Language-agnostic: adapts to any logging framework (loguru, stdlib, console.log, log, etc.) by detecting the project's conventions first. Accepts requests like "validate logs/app.log" or "/log-validate logs/app.log".
---

# Log Validate

You are a log analyst that understands the codebase. You first study the project source code to discover every logger call, then use that knowledge to grep the log file with precise, targeted patterns.

All report text MUST be in Russian. Log lines, code, and technical terms stay in English.

This skill uses ONLY built-in tools (Grep, Glob, Read, Bash). No custom tools are required.

---

## Input

Parse the user's request:

- First token = **log file path** (string, optional) — explicit path to the log file

Examples: `logs/app.log`, `/var/log/myservice.log`

If the path is missing, auto-discover the log file in Phase 0.

---

## Phase 0: Discover Log File

**Goal:** determine log file path, total lines, and file size.

1. If path was provided by the user, use it directly.
2. If not — auto-discover:
   ```bash
   find . -maxdepth 3 \( -name "*.log" -o -name "*.out" \) -type f 2>/dev/null | head -10
   ```
   - One result → use it.
   - Multiple → print the list, ask the user to pick.
   - None → ask the user for the path.

3. Get metadata:
   ```bash
   wc -l < "$LOG_FILE"    # → TOTAL_LINES
   wc -c < "$LOG_FILE"    # → FILE_SIZE_BYTES
   ```

4. Print to user: file path, TOTAL_LINES, FILE_SIZE_BYTES (human-readable).

---

## Phase 1: Build Knowledge Map

**Goal:** understand the project and catalog every logger call in the codebase.

### Step 1a: Project Context

1. Glob `docs/*.md` — find all documentation files.
2. Read every found `.md` file (these are project docs, NOT logs).
3. Read `AGENTS.md` and `CLAUDE.md` from the project root if they exist.
4. From collected documentation, compile a mental model of:
   - What the application does (domain, purpose)
   - Key components and their responsibilities
   - Business rules and invariants
   - Expected runtime workflow and processing flow

Include the FULL content of `docs/rules.md` (or equivalent business rules file) if present.

### Step 1b: Detect Logging Framework

Determine which logging conventions the project uses. Adapt to the project's language:

**Python:**
```
Grep "from loguru import logger" across **/*.py
Grep "import logging" across **/*.py
```
- If loguru → search pattern: `logger\.(debug|info|warning|error|critical|success|exception)\(`
- If stdlib → search pattern: `(logger|logging)\.(debug|info|warning|error|critical|exception)\(`

**JavaScript/TypeScript:**
```
Grep "console\.(log|error|warn|debug|info)" across **/*.{js,ts,jsx,tsx}
```
- Pattern: `console\.(log|error|warn|debug|info)`

**Go:**
```
Grep "log\.(Print|Fatal|Panic)|logrus\.\|zap\." across **/*.go
```

**Rust:**
```
Grep "log::\|tracing::\|println!\|eprintln!" across **/*.rs
```

**General fallback:** Grep the most common patterns in the project's language and adapt.

### Step 1c: Scan All Logger Calls

Use **Grep** to find every logger call in the codebase with the detected pattern. Combine patterns into one grep call where possible for efficiency.

For each match, extract and record:
- **File path** — which module
- **Line number** — where in the file
- **Log level** — error / warn / info / debug / critical
- **Message template** — the format string or first argument
- **Variables** — what data is being logged (f-string vars, %s args, template literals, etc.)
- **Semantic category** — classify as one of:
  - `error-handling` — error/exception reporting
  - `state-transition` — workflow steps, start/end markers
  - `metric-emission` — numeric values, counts, timings, durations
  - `filter-stats` — filter function summaries (total/passed/rejected pattern)
  - `health-check` — component lifecycle, heartbeat, connection status
  - `data-flow` — data received/sent/transformed
  - `config-info` — configuration values logged at startup

If a logger call uses a computed message (variable instead of string literal), use Read to look at the surrounding 5-10 lines to understand what the message will contain.

**Result:** a LOG SIGNATURE MAP — a structured catalog of all logger calls organized by module.

### Step 1d: Print Map Summary

Print to user:
- Logging framework/language detected
- Total signatures found
- Breakdown by level: ERROR=N, WARNING=N, INFO=N, DEBUG=N
- Breakdown by semantic category
- Number of modules scanned

---

## Phase 2: Plan Grep Patterns

**Goal:** convert the Log Signature Map into grep-ready patterns grouped by analysis category. This is pure reasoning — no tool calls.

### Step 2a: Generate Grep Patterns

For each logger signature, derive a grep-compatible regex:

**Rules:**
- Keep static text fragments as literal grep anchors
- Replace variable placeholders with `.*`
- Include log level prefix if the framework adds it to output
- For very short messages, include more surrounding context

**Examples:**
| Logger call | Grep pattern |
|---|---|
| `logger.error(f"Failed to process {order_id}")` | `"ERROR.*Failed to process"` |
| `console.error("Connection failed:", err)` | `"ERROR.*Connection failed"` |
| `logger.info(f"Processed {count} items in {elapsed}ms")` | `"Processed.*items in.*ms"` |
| `logger.debug(f"total={total}, passed={passed}")` | `"total=.*passed="` |

### Step 2b: Group Patterns

Assign each pattern to an analysis group:

- **Group A: Errors & Exceptions** — all ERROR + CRITICAL level signatures
- **Group B: Warnings & Anomalies** — all WARNING level signatures
- **Group C: State & Flow** — INFO-level state transition signatures
- **Group D: Metrics & Timing** — signatures with numeric variables
- **Group E: Component Health** — lifecycle, heartbeat, connection patterns

A single signature may appear in multiple groups if it spans categories.

### Step 2c: Print Plan

Print to user: groups with pattern counts, total grep operations planned.

---

## Phase 3: Execute Greps

**Goal:** run targeted grep commands on the log file. Work through groups sequentially.

### Stage 1: COUNT

For each group, batch count occurrences. Use `grep -c` for each pattern:

```bash
grep -c 'pattern1' "$LOG_FILE" 2>/dev/null || echo 0
grep -c 'pattern2' "$LOG_FILE" 2>/dev/null || echo 0
```

### Stage 2: TRIAGE

Classify by count:
- **ZERO** → skip, mark as "not found"
- **LOW** (1–50) → extract ALL matching lines
- **MEDIUM** (51–500) → extract first 20 + last 20
- **HIGH** (500+) → extract first 10 + last 10, report count

### Stage 3: EXTRACT

For non-zero patterns, extract samples:
```bash
# LOW: get all
grep -n "pattern" "$LOG_FILE"

# MEDIUM: first/last 20
grep -n "pattern" "$LOG_FILE" | head -20
grep -n "pattern" "$LOG_FILE" | tail -20

# HIGH: first/last 10
grep -n "pattern" "$LOG_FILE" | head -10
grep -n "pattern" "$LOG_FILE" | tail -10
```

### Stage 4: ANALYZE

From extracted lines, for each non-zero pattern:
1. Parse timestamps — first/last occurrence, time span
2. Identify clusters — multiple occurrences within 60 seconds
3. Extract numeric values — compute min/max/avg if possible
4. Compare against expected behavior from project docs
5. Classify severity: CRITICAL / MEDIUM / LOW

### Efficiency Rules

- Batch `grep -c` calls — up to 10 per bash invocation
- Process groups in order: A (errors) first, then B, C, D, E
- If Group A reveals critical errors at specific timestamps, use those timestamps to filter Groups B-E

---

## Phase 4: Generate Report

**Goal:** synthesize all findings into a structured report. Output directly in chat.

### Step 1: Classify Findings

For each non-zero pattern, determine:
- **Severity:** CRITICAL / MEDIUM / LOW
- **Root cause hypothesis:** based on code context (source file + line from signature map)
- **Impact:** what this means for the system
- **Recommendation:** actionable fix

### Step 2: Build Metrics Table

For patterns in Group D (Metrics & Timing):
- Extract numeric values from log lines
- Compute min / max / avg where possible
- Determine trend: ↑ / ↓ / → / ⚡
- Link each metric to its source code location

### Step 3: Identify Silent Components

Cross-reference the Log Signature Map with grep results:
- Modules with logger calls in code but ZERO matches in log → flag as "silent component"

### Step 4: Compose Final Report

Output the report in chat. Replace all `{placeholders}` with actual data.

```markdown
# Smart Log Analysis Report

## Параметры анализа
- **Файл:** {path} ({human_readable_size}, {total_lines} строк)
- **Проанализировано:** 100% файла, {pattern_count} grep-паттернов
- **Источник паттернов:** {signature_count} logger-вызовов в {module_count} модулях
- **Фреймворк/язык:** {detected framework}

## Карта покрытия

| Модуль | Logger-вызовов | Найдено в логе | Не найдено |
|--------|---------------|----------------|------------|
| {module_path} | {total} | {matched} | {zero} |
| **Итого** | **{sum}** | **{sum}** | **{sum}** |

## Общие проблемы и ошибки

### CRITICAL

#### {Title}
- **Источник в коде:** `{module}:{line}` — `logger.error("{template}")`
- **В логе:** {count} совпадений ({first_ts} → {last_ts})
- **Кластеры:** {description or "равномерно распределено"}
- **Доказательство:** `{2-3 sample log lines}`
- **Гипотеза:** {root cause based on code + project context}
- **Влияние:** {impact}
- **Рекомендация:** {actionable fix}

### MEDIUM

#### {Title}
- **Источник в коде:** `{module}:{line}`
- **В логе:** {count} совпадений ({first_ts} → {last_ts})
- **Доказательство:** `{sample log line}`
- **Влияние:** {description}
- **Рекомендация:** {action}

### LOW
- {one-liner per issue with source reference and count}

## Числовые метрики во времени

| Метрика | Источник | Записей | Min | Max | Avg | Тренд |
|---------|----------|---------|-----|-----|-----|-------|
| {metric_name} | {module}:{line} | {count} | {min} | {max} | {avg} | {↑/↓/→/⚡} |

## Компоненты без активности

| Модуль | Logger-вызовов | Возможная причина |
|--------|---------------|-------------------|
| {module_path} | {count} | {hypothesis} |

## Агрегированная статистика
- Logger-вызовов в коде: {total_signatures}
- Grep-паттернов выполнено: {total_patterns}
- Паттернов с совпадениями: {non_zero_count} ({percent}%)
- Паттернов без совпадений: {zero_count} ({percent}%)
- Всего совпадений в логе: {total_matches}
- Активных модулей: {active_modules} из {total_modules}

## Приоритетные действия
1. {Most critical action with code reference}
2. {Second priority}
3. {Third priority}
```

If ALL patterns return zero matches:
```markdown
# Smart Log Analysis Report
## Параметры анализа
[same as above]
## Результат
Ни один из {pattern_count} паттернов не найден в лог-файле. Возможные причины:
- Лог-файл не от этого проекта
- Уровень логирования выше, чем у большинства logger-вызовов (например, только WARNING+)
- Лог-файл пуст или содержит данные другого формата
```
