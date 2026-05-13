# Варианты передачи большого chunk-контента — оценка (rev. 2)

Все рассмотренные подходы и почему они работают/не работают на opencode 1.14.48.

**Обновление 2026-05-13:** Вариант #1 переведён из ❌ в ✅ — обнаружен конфиг `tool_output` в schema (`config.ts`) и реализации (`truncate.ts`). См. [README.md](README.md).

## Легенда

- ✅ работает — проверено или однозначно следует из source/docs
- ❌ не работает — упирается в hardcoded cap
- ⚠️ работает с оговорками

| # | Подход | Статус | Причина |
|---|---|---|---|
| 1 | Увеличить opencode tool output cap через config | ✅ | `tool_output.max_lines` / `tool_output.max_bytes` в `opencode.json`. Определено в `config.ts` schema, используется в `truncate.ts:limits()`. Строка `tool_output` найдена в бинарнике v1.14.48. [Доказательства](README.md#1-tool_output-определён-в-config-schema). |
| 2 | Увеличить через env var | ❌ | Специального env var для output limit нет. `OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS` — только timeout. |
| 3 | Inline content (~600 KB) в tool output JSON | ✅ | При настроенном `tool_output` (max_bytes ≥ 1 MB) — работает. Без настройки — ❌ (см. старую версию). |
| 4 | Inline content + жёсткий запрет манипуляций в скилле | ✅ | При настроенном `tool_output` — работает. Без — ❌ (скилл не лечит обрезку). |
| 5 | Inline content + 1M-context модель (Opus 4.7) | ⚠️ | Обрезка на стороне opencode runtime решается `tool_output`. Но модель должна вместить промпт в context window. |
| 6 | Тул пишет content в temp-файл, агент-prompt = «Read this file» | ❌ | Read имеет такой же cap. Даже с `tool_output` Read обрезается. |
| 7 | Тул возвращает offset/limit, сабагент делает `Read(offset, limit)` | ⚠️ | Read cap применяется всегда. При `tool_output` Read cap тоже увеличивается. |
| 8 | Несколько маленьких tool calls (по одному chunk на вызов) | ⚠️ | Работает, но сложнее. |
| 9 | Bash + PowerShell вытаскивает контент в stdout | ⚠️ | При `tool_output` Bash cap тоже увеличивается. |
| 10 | Plugin hook `tool.execute.after` подменяет output | ❌ | Issue [#13770](https://github.com/anomalyco/opencode/issues/13770): для plugin-tools hook **после** truncation. |
| 11 | **`lines_per_chunk` capped ≤ 1800 + один Read в сабагенте** | ✅ | Работает без `tool_output`. Запасной план. |
| 12 | Multi-Read в сабагенте (parallel) с chunk > 2000 строк | ⚠️ | Сложная инструкция, риск ошибок склейки. |
| 13 | Custom tool возвращает массив pre-rendered Read-args | ⚠️ | То же что #12, усложняет API. |
| 14 | Auto-bump `--chunks` чтобы каждый chunk вписался в cap | ⚠️ | Дорого по токенам (много параллельных сабагентов). |
| 15 | Переписать плагин как MCP-сервер | ⚠️ | MCP tools: hook до truncation. Много работы, не проверено. |
| 16 | **Настроить `tool_output` + оставить текущий inline-дизайн** | ✅ | **РЕКОМЕНДУЕМЫЙ ПОДХОД.** Минимум изменений в коде, максимум надёжности. Сабагенты не делают tool calls. |

## Что в итоге (rev. 2)

**Вариант #16 — победитель:**
1. Пользователь настраивает `tool_output.max_bytes` в `opencode.json`
2. Плагин работает как есть (inline content)
3. Никаких архитектурных изменений

**Запасной план:** вариант #11 (Read + offset) — если `tool_output` недоступен в конкретной версии opencode.

**Старый итог (rev. 1):** ~~Только варианты 11–14 жизнеспособны, #11 — самый простой.~~ Опровергнуто обнаружением `tool_output`.