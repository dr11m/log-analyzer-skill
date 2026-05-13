# Почему наш плагин ломается на больших чанках

История того, как мы упирались в opencode-лимиты на разных версиях, и в какой именно момент срабатывает truncation.

## Что делает плагин на 1.0.13

`split_log_chunks` принимает `logPath`, `chunks`, `contextTokens?`, `projectBriefing?`. Возвращает JSON:

```json
{
  "total_lines": 31900,
  "total_bytes": 4512067,
  "lines_per_chunk": 4330,
  "coverage_percent": 40.7,
  "warnings": [...],
  "chunks": [
    {
      "number": 1,
      "total": 3,
      "byte_size": 592106,
      "line_count": 4330,
      "est_tokens": 169173,
      "agent_prompt": "<полный prompt сабагента с inline 4330 строк лога ≈ 600 KB>"
    },
    ...
  ]
}
```

Размер JSON = 3 × ~600 KB ≈ **1.7 MB**.

## Что происходит в opencode runtime

1. Наш `execute(...)` возвращает 1.7 MB строку.
2. `Tool.define()` обёртка прогоняет результат через `truncate()` (см. [opencode-output-limits.md](opencode-output-limits.md)).
3. Tool output превышает 50 KB / 2000 строк → **обрезается**.
4. Полный JSON сохраняется в `~/.local/share/opencode/tool-output/tool_<id>`.
5. Оркестратору-LLM в context идёт только обрезанная версия (~50 KB) + подсказка «use Grep/Read on the temp file».

## Что видит оркестратор и что он делает

В одном из прогонов оркестратор сам показал что произошло:

```
Now I call split_log_chunks with all parameters.
Output truncated. Let me read the full tool result.
```

После этого он сам:

1. Через `Bash + PowerShell + ConvertFrom-Json` прочёл `tool-output/tool_<id>` напрямую с диска.
2. Извлёк все 3 `agent_prompt` (по ~850 KB каждый).
3. Сохранил каждый в свой файл в `%TEMP%\opencode\chunks\chunk{i}.txt`.
4. Через Python нарезал каждый chunk-файл на сегменты по 40 KB.
5. Сабагентам передал инструкции вида «Read эти сегменты по очереди».
6. Сабагент делал `Read(offset, limit)` на свои сегменты — **тот же 50 KB cap сработал** на стороне Read tool → каждый Read вернул лишь начало.

Итог: сабагент анализировал ~2410 строк вместо запрошенных 4330+.

В другом прогоне (после жёсткого запрета манипуляций в скилле) оркестратор всё-таки передал в Task строку, но opencode при формировании Task input ровно так же её обрезал. Сабагент получил prompt с пустой секцией `LOG_CHUNK_CONTENT` после маркера `---` и в ответе написал «Content: Empty — no log lines were provided».

## Почему никакие наши skill-правки не помогали

Мы пробовали:

- В Phase 3 написать «pass verbatim, no edits» → оркестратор всё равно «оптимизировал».
- Усилить до явного черного списка («не сохраняй в файл, не нарезай, не запускай Python») → оркестратор подчинился и попытался передать в Task как есть, но opencode обрезал на Task input уровне → сабагент видел пустой контент.
- Перенести подстановку briefing в код тула → не помогло (проблема всё равно в размере tool output, а не в подстановке).
- Сменить модель на 1M-контекст → не пробовали окончательно, но это не решит сам по себе — truncation hardcoded в opencode, а не в модели.

## Где именно срабатывает обрезка

Цепочка вызовов в реальном прогоне на 1.0.13:

```
LLM-оркестратор
  └─→ tool call: split_log_chunks(...)
        └─→ наш execute() возвращает строку 1.7 MB  ← полный JSON ОК
              └─→ Tool.define() truncate(...)         ← ОБРЕЗКА ЗДЕСЬ
                    └─→ saved to ~/.../tool-output/tool_xxx (1.7 MB на диске)
                    └─→ возвращает в LLM ~50 KB + hint
  └─→ LLM видит обрезанный output
        └─→ либо читает temp-файл сам (тогда дальше сабагент упирается в Read cap)
        └─→ либо честно передаёт обрезанное в Task → сабагент видит пустой content
```

То есть **два разных места** обрезают:

1. `split_log_chunks` output → 50 KB cap (Tool.define wrapper)
2. Read tool в сабагенте → 50 KB cap (Tool.define wrapper, тот же)

Один и тот же `MAX_BYTES = 50000`, два разных применения. Поэтому **никакой workaround через файлы/чтения** не помогает — Read имеет тот же лимит что и tool output.

## Имеет ли значение размер `agent_prompt` per chunk

Да, но косвенно. Сейчас:
- Tool output = `JSON.stringify({chunks: [3 × agent_prompt]})` ≈ 1.7 MB
- Truncation смотрит на total tool output, не на отдельный элемент массива

Если уменьшить `agent_prompt` каждого чанка до ~15 KB (briefing + analysis instructions + Read instruction, **без** inline content), то tool output ≈ 50 KB и **умещается** под cap.

Это и есть путь к рабочему плагину — см. [architecture-recommendation.md](architecture-recommendation.md).
