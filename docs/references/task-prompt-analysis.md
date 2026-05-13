# Анализ: обрезается ли `prompt`-параметр Task tool?

**Вопрос:** Можно ли передать большой chunk-контент (>2000 строк, >50 KB) напрямую в `prompt`-параметре Task tool, в обход tool output truncation?

**Ответ:** ДА. `prompt`-параметр **не обрезается**. Обрезается только **output** Task tool (результат сабагента).

## Доказательства

### 1. Schema Task tool: prompt — обычная строка без limit'а

**Файл:** `packages/opencode/src/tool/task.ts` (аномалиco/opencode, ветка dev)

```typescript
export const Parameters = Schema.Struct({
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  task_id: Schema.optional(Schema.String),
  command: Schema.optional(Schema.String),
})
```

`Schema.String` — нет ограничения на длину. Для сравнения, `Read` tool имеет `limit` с дефолтом 2000:
```typescript
// read.ts
limit: Schema.optional(Schema.Number).annotate({ description: "Maximum number of lines to read (defaults to 2000)" })
```

**Источник:** https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/tool/task.ts

### 2. `Tool.define()` обрезает только `result.output`

**Файл:** `packages/opencode/src/tool/tool.ts`

```typescript
const result = yield* execute(decoded as Schema.Schema.Type<Parameters>, ctx)
// ...
const truncated = yield* truncate.output(result.output, {}, agent)
return {
  ...result,
  output: truncated.content,       // <-- обрезается ТОЛЬКО output
  metadata: {
    ...result.metadata,
    truncated: truncated.truncated,
    ...(truncated.truncated && { outputPath: truncated.outputPath }),
  },
}
```

Truncation pipeline:
1. Входные параметры → Zod validation → **нет обрезки**
2. `execute(args, ctx)` → возвращает `{ title, output, metadata }`
3. `truncate.output(result.output)` → обрезает строку `output`
4. `result.metadata.truncated` !== undefined → **пропускает** обрезку

### 3. `fromPlugin` wrapper: то же поведение

**Файл:** `packages/opencode/src/tool/registry.ts`

```typescript
const result = yield* Effect.promise(() => def.execute(args as any, pluginCtx))
const output = typeof result === "string" ? result : result.output
const out = yield* truncate.output(output, {}, info)
return {
  output: out.truncated ? out.content : output,
  // ...
}
```

Обрезается только `output` (результат plugin-тула), не `args`.

### 4. Что Task tool делает с `prompt`

```typescript
const parts = yield* ops.resolvePromptParts(params.prompt)
const result = yield* ops.prompt({
  messageID,
  sessionID: nextSession.id,
  model: { ... },
  agent: next.name,
  tools: { ... },
  parts,  // <-- полный prompt (с резолвнутыми {file:...} если есть) → сабагенту
})
```

`parts` передаются в `ops.prompt()` — это запускает полноценный prompt cycle для сабагента. Сабагент получает parts как своё входное сообщение.

### 5. Что обрезается у Task tool

```typescript
return {
  title: params.description,
  metadata: { sessionId: nextSession.id, model },
  output: [
    `task_id: ${nextSession.id} ...`,
    "",
    "<task_result>",
    result.parts.findLast((item) => item.type === "text")?.text ?? "",
    "</task_result>",
  ].join("\n"),
}
```

Обрезается **результат сабагента** (`<task_result>...</task_result>`), который возвращается оркестратору. Это правильное поведение — результат сабагента может быть большим, и его обрезка защищает контекст оркестратора.

## Вывод

| Что | Обрезается? | Где |
|---|---|---|
| `prompt`-параметр Task tool | **НЕТ** | — |
| `output` Task tool (результат сабагента) | **ДА** | `Tool.define()` / `fromPlugin` |
| `args` любого тула (включая plugin-тулы) | **НЕТ** | — |
| `output` любого тула | **ДА** (если не bypass) | `truncate.output()` |

**Практическое следствие:** В `prompt` Task tool можно передать чанк любого размера (ограниченный только context window сабагента). Поэтому inline-доставка контента через `chunks[i].agent_prompt` → `Task(prompt=...)` работает при условии, что `split_log_chunks` tool output не обрезается. А это решается через `tool_output` конфиг.

## `{file:...}` синтаксис в prompt

**Важно:** `{file:path}` в prompt Task tool **НЕ инлайнит** содержимое файла. `resolvePromptParts()` создаёт `FilePart` (ссылку), а не встраивает текст. Сабагент должен будет сделать Read. Поэтому `{file:...}` не помогает обойти лимиты — он просто меняет способ, которым сабагент получает данные (Read вместо inline), но Read тоже под капом.

**Источник:** `packages/opencode/src/session/prompt.ts`, функция `resolvePromptParts()` — [raw](https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/session/prompt.ts)