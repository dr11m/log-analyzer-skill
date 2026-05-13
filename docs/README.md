# Исследование: tool output limit в opencode — полная картина

Эта папка содержит research-findings по поводу того, почему наш плагин не может передать большой chunk-content (>50 KB) через tool output в сабагента, и какие варианты решения существуют.

**Версия opencode:** 1.14.48 (проверено `opencode --version`)
**Дата исследования:** 2026-05-13

## Файлы

- [opencode-output-limits.md](opencode-output-limits.md) — что выяснили про лимиты opencode: точные значения, файлы исходников, какие конфиги/env vars существуют.
- [why-our-plugin-breaks.md](why-our-plugin-breaks.md) — конкретный provenance проблемы в нашем плагине.
- [options-evaluated.md](options-evaluated.md) — все рассмотренные варианты. **ОБНОВЛЕНО:** вариант #1 теперь ✅.
- [architecture-recommendation.md](architecture-recommendation.md) — рекомендуемая архитектура.
- [task-prompt-analysis.md](task-prompt-analysis.md) — анализ: обрезается ли `prompt`-параметр Task tool.

---

## Главный итог (rev. 2 — после глубокого анализа исходников)

### Предыдущий вывод (rev. 1) — ОПРОВЕРГНУТ

> ~~opencode **захардкоженно** обрезает любой tool output до **2000 строк / 50 KB**. Лимит **не конфигурируется**.~~

### Новый вывод (rev. 2)

**`tool_output` — КОНФИГУРИРУЕТСЯ через `opencode.json`.** Это документировано в schema исходного кода (`config.ts`), реализовано в `truncate.ts` (функция `limits()`), и строка `tool_output` найдена в бинарнике установленной версии 1.14.48.

```json
{
  "tool_output": {
    "max_lines": 50000,
    "max_bytes": 1048576
  }
}
```

### Что это значит для плагина

**Текущий дизайн (inline content в `agent_prompt`) — РАБОТАЕТ.** Никаких архитектурных изменений не требуется. Достаточно настроить `tool_output` в `opencode.json`.

---

## Полная цепочка доказательств

### 1. `tool_output` определён в config schema

**Файл:** `packages/opencode/src/config/config.ts` (ветка `dev`, anomalyco/opencode)
**Строки:** ~10000-10030

```typescript
tool_output: Schema.optional(
  Schema.Struct({
    max_lines: Schema.optional(PositiveInt).annotate({
      description: "Maximum lines of tool output before it is truncated and saved to disk (default: 2000)"
    }),
    max_bytes: Schema.optional(PositiveInt).annotate({
      description: "Maximum bytes of tool output before it is truncated and saved to disk (default: 51200)"
    }),
  }),
).annotate({
  description: "Thresholds for truncating tool output. When output exceeds either limit, the full text is written to the truncation directory and a preview is returned."
}),
```

**Источник:** [raw config.ts на GitHub](https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/config/config.ts)

**Примечание:** Ключ `tool_output` отсутствует в публичной JSON Schema (`https://opencode.ai/config.json`) и в документации на [opencode.ai/docs/config/](https://opencode.ai/docs/config/). Это **недокументированная**, но рабочая фича.

### 2. `truncate.ts` читает `tool_output` из конфига

**Файл:** `packages/opencode/src/tool/truncate.ts` (ветка `dev`, anomalyco/opencode)
**Строки:** функция `limits()`

```typescript
const limits = Effect.fn("Truncate.limits")(function* () {
  const configSvc = yield* Effect.serviceOption(Config.Service)
  if (Option.isNone(configSvc)) return { maxLines: MAX_LINES, maxBytes: MAX_BYTES }
  const cfg = yield* configSvc.value.get().pipe(Effect.catch(() => Effect.succeed(undefined)))
  return {
    maxLines: cfg?.tool_output?.max_lines ?? MAX_LINES,   // fallback: 2000
    maxBytes: cfg?.tool_output?.max_bytes ?? MAX_BYTES,   // fallback: 51200 (50 KB)
  }
})
```

Константы-фоллбеки (строки 10-11):
```typescript
export const MAX_LINES = 2000
export const MAX_BYTES = 50 * 1024  // 51200 = 50 KB
```

**Источник:** [raw truncate.ts на GitHub](https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/tool/truncate.ts)

### 3. `fromPlugin` wrapper применяет `truncate.output()` — с уважением к конфигу

**Файл:** `packages/opencode/src/tool/registry.ts` (ветка `dev`, anomalyco/opencode)
**Строки:** функция `fromPlugin()`

```typescript
function fromPlugin(id: string, def: ToolDefinition): Tool.Def {
  // ...
  return {
    id,
    parameters,
    jsonSchema,
    description: def.description,
    execute: (args, toolCtx) => Effect.gen(function* () {
      const pluginCtx: PluginToolContext = { ...toolCtx, ... }
      const result = yield* Effect.promise(() => def.execute(args as any, pluginCtx))
      const output = typeof result === "string" ? result : result.output
      const metadata = typeof result === "string" ? {} : (result.metadata ?? {})
      const attachments = typeof result === "string" ? undefined : result.attachments
      const info = yield* agent.get(toolCtx.agent)
      const out = yield* truncate.output(output, {}, info)  // <-- ВЫЗОВ С ПУСТЫМИ ОПЦИЯМИ
      return {
        title: typeof result === "string" ? "" : (result.title ?? ""),
        output: out.truncated ? out.content : output,
        attachments,
        metadata: {
          ...metadata,
          truncated: out.truncated,
          ...(out.truncated && { outputPath: out.outputPath }),
        },
      }
    }),
  }
}
```

Ключевой момент: `truncate.output(output, {}, info)` — второй аргумент `{}` (пустые options). Это значит, что `maxLines`/`maxBytes` берутся из `limits()`, которая читает `tool_output` из конфига. **Пользовательский `tool_output` влияет на plugin tools.**

**Источник:** [raw registry.ts на GitHub](https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/tool/registry.ts)

**Примечание:** Issue [#12527](https://github.com/anomalyco/opencode/issues/12527) подтверждает, что `fromPlugin` hardcoded-но перезаписывает metadata (проблема с `context.metadata()`), но это не влияет на сам механизм truncation — `truncate.output()` вызывается корректно.

### 4. `prompt`-параметр Task tool НЕ обрезается

**Файл:** `packages/opencode/src/tool/task.ts` (ветка `dev`, anomalyco/opencode)

```typescript
export const Parameters = Schema.Struct({
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  // prompt — обычная строка, нет limit'а в schema
  subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  task_id: Schema.optional(Schema.String),
  command: Schema.optional(Schema.String),
})
```

`Tool.define()` (файл `tool.ts`) обрезает **только `result.output`** — выходную строку. Входные параметры (`prompt`, `description`, etc.) проходят только Zod-валидацию и **не обрезаются**.

Внутри Task tool:
```typescript
const parts = yield* ops.resolvePromptParts(params.prompt)  // резолвит {file:...} если есть
const result = yield* ops.prompt({                           // запускает сабагента
  messageID,
  sessionID: nextSession.id,
  model: { ... },
  agent: next.name,
  tools: { ... },
  parts,                                                     // <-- полный prompt идёт сабагенту
})
```

Обрезка применяется **только** к тому, что Task tool возвращает оркестратору (output = `<task_result>...`), а **не** к тому, что передаётся сабагенту.

**Источник:** [raw task.ts на GitHub](https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/tool/task.ts)

### 5. `{file:...}` в prompt — НЕ инлайнит содержимое

**Файл:** `packages/opencode/src/session/prompt.ts` — функция `resolvePromptParts()`

```typescript
const resolvePromptParts = Effect.fn("SessionPrompt.resolvePromptParts")(function* (template: string) {
  const ctx = yield* InstanceState.context
  const parts: Types.DeepMutable<SessionPrompt.PromptInput["parts"]> = [{ type: "text", text: template }]
  const files = ConfigMarkdown.files(template)
  // ...
  // Резолвит {file:path} в FilePart (ссылку), а НЕ инлайнит содержимое
})
```

`resolvePromptParts` создаёт **FilePart** — ссылку на файл, а не встраивает текст файла в prompt. Сабагент всё равно должен сделать Read для получения содержимого. Read cap остаётся проблемой.

**Вывод:** `{file:...}` синтаксис **не помогает** обойти лимиты.

**Источник:** [raw prompt.ts на GitHub](https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/session/prompt.ts)

### 6. Подтверждение в бинарнике установленной версии

Строка `tool_output` найдена в бинарниках opencode 1.14.48:
```
C:/Users/dr1m/AppData/Roaming/npm/node_modules/opencode-ai/node_modules/opencode-windows-x64/bin/opencode.exe
C:/Users/dr1m/AppData/Roaming/npm/node_modules/opencode-ai/node_modules/opencode-windows-x64-baseline/bin/opencode.exe
```

Это подтверждает, что фича **присутствует** в установленной версии 1.14.48.

---

## Пересмотренная таблица вариантов

| # | Подход | Старый статус | Новый статус | Причина изменения |
|---|---|---|---|---|
| 1 | Увеличить opencode tool output cap через config | ❌ | ✅ | `tool_output.max_lines` / `tool_output.max_bytes` в `opencode.json` — работает. См. доказательства выше. |
| 3 | Inline content в tool output JSON | ❌ | ✅ | При настроенном `tool_output` контент не обрезается. |
| 16 | **Настроить `tool_output` + оставить текущий inline-дизайн** | — | ✅ | **Рекомендуемый подход.** Минимум изменений в коде. |

Полная таблица: [options-evaluated.md](options-evaluated.md)

---

## Рекомендуемая архитектура (rev. 2 — проще, чем rev. 1)

### Что делает пользователь

Добавляет в `opencode.json` (глобальный или проекта):

```json
{
  "tool_output": {
    "max_lines": 50000,
    "max_bytes": 1048576
  }
}
```

### Что делает плагин (текущий код — без изменений!)

1. `split_log_chunks` читает лог, режет на N чанков
2. Для каждого чанка: рендерит `agent_prompt` с **inline content**
3. Возвращает JSON. При `tool_output.max_bytes = 1MB` — **не обрезается**
4. Оркестратор видит полный JSON → для каждого чанка вызывает `Task(prompt = chunks[i].agent_prompt)`
5. `prompt`-параметр Task tool **не обрезается** → сабагент получает весь контент
6. Сабагент: **ноль Read, ноль Bash, ноль temp-файлов** — чистое reasoning над inline-контентом

### Что нужно изменить в плагине (минимально)

1. **`src/index.ts`:** добавить `warnings[]` — если суммарный размер agent_prompt'ов приближается к дефолтному `tool_output.max_bytes`, предупредить пользователя настроить `tool_output`
2. **`skills/log-insight.md`:** добавить упоминание `tool_output` в секцию Prerequisites
3. **`README.md`:** добавить инструкцию по настройке `tool_output`

### Trade-offs (rev. 2)

| Метрика | rev. 1 (Read + offset) | rev. 2 (tool_output + inline) |
|---|---|---|
| Изменений в коде | ~150 строк diff | ~10 строк (warnings) |
| Tool calls на сабагент | 1 (Read) | 0 |
| Сложность для LLM | Средняя (offset/limit математика) | Минимальная (контент уже в prompt) |
| Риск ошибок сабагента | Средний (может проигнорировать Read-инструкцию) | Нулевой (нет инструментов для ошибки) |
| Зависимость от версии opencode | Нет | Да (нужна версия с `tool_output`) |
| Coverage | Привязан к N chunks | Такой же |

---

## Что делать, если `tool_output` не работает в конкретной версии

**План Б:** архитектура rev. 1 ([architecture-recommendation.md](architecture-recommendation.md)) — `lines_per_chunk ≤ 1800` + компактный `agent_prompt` + один Read в сабагенте. Полностью работоспособна без `tool_output`.

---

## Sources (полный список)

### Исходный код (anomalyco/opencode, ветка dev)
- [config.ts](https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/config/config.ts) — schema definition с `tool_output`
- [truncate.ts](https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/tool/truncate.ts) — `MAX_LINES`, `MAX_BYTES`, функция `limits()`
- [registry.ts](https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/tool/registry.ts) — `fromPlugin` wrapper
- [task.ts](https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/tool/task.ts) — Task tool implementation
- [tool.ts](https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/tool/tool.ts) — `Tool.define()` с truncation pipeline
- [prompt.ts](https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/session/prompt.ts) — `resolvePromptParts`, `{file:...}` resolution

### GitHub Issues
- [#11313](https://github.com/sst/opencode/issues/11313) — feature request на конфигурируемость (было «не реализовано», теперь реализовано)
- [#13770](https://github.com/sst/opencode/issues/13770) — проблемы truncation, inconsistent hook order
- [#12527](https://github.com/anomalyco/opencode/issues/12527) — `fromPlugin` discards custom metadata
- [#11903](https://github.com/anomalyco/opencode/issues/11903) — Task tool truncation drops session_id
- [#4826](https://github.com/sst/opencode/issues/4826) — пользовательский вопрос про truncation

### DeepWiki
- [Context Management and Compaction](https://deepwiki.com/sst/opencode/2.4-context-management-and-compaction)
- [Built-in Tools Reference](https://deepwiki.com/sst/opencode/5.3-built-in-tools-reference)
- [Prompt Processing Pipeline](https://deepwiki.com/sst/opencode/2.3-prompt-processing-pipeline)

### Документация
- [Config docs](https://opencode.ai/docs/config/) — **нет** упоминания `tool_output`
- [Agents docs](https://opencode.ai/docs/agents/)
- [Plugins docs](https://opencode.ai/docs/plugins/)
- [Config JSON Schema](https://opencode.ai/config.json) — **нет** `tool_output` (отстаёт от кода)

### Прочее
- [Gist: OpenCode prompt construction](https://gist.github.com/rmk40/cde7a98c1c90614a27478216cc01551f) — анализ assembly-pipeline
- [OpenCode mirror prompt.ts](https://github.com/joungwoo-lee/opencode-mirror/blob/main/packages/opencode/src/session/prompt.ts) — запасное зеркало