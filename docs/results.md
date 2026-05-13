# Рабочие результаты — log-analyzer-suite v1.0.17

Дата: 2026-05-13
opencode: 1.14.48
Плагин: @dr39m/log-analyzer-suite@1.0.17

## Что реально сработало

### Архитектура: Bash cat вместо Read

**Проблема:** Read tool в opencode имеет захардкоженный внутренний лимит 50KB
(`MAX_BYTES = 50 * 1024` в `read.ts`). Конфиг `tool_output` в `opencode.json`
не влияет на этот лимит — Read обрезает контент ДО того, как tool_output
наступает. Сабагент получал 378 строк из 5767.

**Решение:** Сабагент делает `Bash(command="cat <chunk_file>")` вместо
`Read(filePath, offset, limit)`. Bash output проходит через `tool_output`
pipeline (max_bytes из конфига), без внутреннего обрезания.

**Результат:** Сабагент получает полный чанк (~5767 строк, ~800KB) без обрезки.

### Эволюция подходов

| Версия | Подход | Результат |
|---|---|---|
| 1.0.14 | Inline content в agent_prompt (~800KB) | JSON parsing failed — LLM не смог экранировать огромную строку в tool call JSON |
| 1.0.15 | Sanitize ANSI/control bytes + inline | То же — размер строки слишком большой для JSON tool call |
| 1.0.16 | Read(offset, limit) инструкция | 378 из 5767 строк — Read хардкодит 50KB внутренний cap |
| **1.0.17** | **Bash cat chunk_file** | **Работает** — Bash вывод через tool_output 8MB |

### Конфигурация opencode.json (обязательная)

```json
{
  "plugin": ["@dr39m/log-analyzer-suite@latest"],
  "tool_output": {
    "max_lines": 500000,
    "max_bytes": 8388608
  }
}
```

Без `tool_output` сабагент получит обрезанный вывод Bash (~50KB по дефолту).

### Поток данных (v1.0.17)

```
Phase 1: оркестратор читает project docs, строит briefing
Phase 2: один tool call split_log_chunks(projectBriefing=...)
  - тул пишет чанки в .opencode/chunks/chunk_N.log (с санитизацией)
  - возвращает компактные agent_prompt (~15-50KB каждый)
  - agent_prompt содержит: briefing + анализ-инструкции + Bash(cat) директиву
Phase 3: 3 параллельных Task(chunks[i].agent_prompt)
  - каждый сабагент делает ОДИН Bash cat -> получает полный чанк
  - затем чистый reasoning -> структурированный отчёт
Phase 4: оркестратор консолидирует 3 отчёта в финальный report
```

## Ключевые находки про opencode internals

### tool_output — конфигурируется, но не документировано

- Определено в `config.ts` schema, реализовано в `truncate.ts:limits()`
- Строка `tool_output` найдена в бинарнике v1.14.48
- Дефолты: `max_lines: 2000`, `max_bytes: 51200` (50KB)
- **Не документировано** на opencode.ai/docs
- Влияет на ВСЕ тулы (Bash, Read, plugin tools) — единый truncate pipeline

### Read tool — внутренний 50KB cap НЕ конфигурируется

Read tool имеет собственный `MAX_BYTES = 50 * 1024` в `read.ts`
(функция `lines()`). Это внутренний лимит, применяемый ДО truncate pipeline.
`tool_output` его НЕ отменяет. Поэтому Read всегда обрезает на ~50KB
независимо от конфига.

### Bash tool — проходит через tool_output без внутреннего cap

Bash output идёт через общий `Tool.define()` -> `truncate.output()` pipeline.
Нет внутреннего хардкода размера. При `tool_output.max_bytes = 8MB`
Bash возвращает полный вывод без обрезки.

### Task prompt — НЕ обрезается

`prompt`-параметр Task tool — обычная `Schema.String` без лимита.
Truncation применяется только к `output` (результату сабагента),
не к входным параметрам. Поэтому компактный agent_prompt (~15-50KB)
проходит в Task без проблем.

### Plugin hook tool.execute.after — после truncation для plugin tools

Issue #13770: для plugin-tools hook запускается ПОСЛЕ truncation.
Подменить output через hook нельзя. Но это и не нужно —
достаточно настроить `tool_output`.

## Санитизация контента

Тул strip'ит из чанков перед записью в файл:
- ANSI CSI escape codes (`\x1B[...m`) — от loguru-цветов
- C0 control bytes (`\x00-\x1F` кроме `\n\r\t`) + DEL `\x7F`

Причина: спецсимволы ломают JSON-сериализацию при генерации LLM tool calls.

## Запуск

```
opencode                                    # перезапустить opencode
/log-insight --chunks 3 --log logs/src.log --context 250
```

Для полного покрытия (31 900 строк):
```
/log-insight --chunks 6 --log logs/src.log --context 250
```
