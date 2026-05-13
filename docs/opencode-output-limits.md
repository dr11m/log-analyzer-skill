# Лимиты tool output в opencode — что мы выяснили

Документ собирает результаты поиска по сорсу/issue-трекеру/докам opencode по вопросу «можно ли передавать tool response размером >50 KB».

## TL;DR

| Что | Значение | Где захардкожено | Конфигурируется? |
|---|---|---|---|
| Tool output truncation | **2000 строк / 50 KB** (дефолт) | `packages/opencode/src/tool/truncation.ts:10-11` (константы `MAX_LINES` / `MAX_BYTES`) | **ДА** — через `tool_output.max_lines` / `tool_output.max_bytes` в `opencode.json` (см. [README.md](README.md)) |
| Read tool — total cap | **50 KB** (дефолт) | те же константы | **ДА** — через тот же `tool_output` (Read идёт через общий truncate pipeline) |
| Read tool — line truncation | строки длиннее **2000 символов** обрезаются | там же | **Нет** |
| Bash tool — default timeout | 2 минуты | `packages/opencode/src/tool/bash.ts:21` | Через `OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS` |
| Bash tool — output truncation | те же 2000 / 50 KB (дефолт) | через общий `Tool.define()` wrapper | **ДА** — через `tool_output` (Bash тоже идёт через общий truncate pipeline) |
| Pruning старых tool outputs из контекста | `PRUNE_PROTECT=40 000 tokens`, `PRUNE_MINIMUM=20 000 tokens` | `packages/opencode/src/session/compaction.ts` | **Нет** |
| Model output (max_tokens API) | `OUTPUT_TOKEN_MAX = 32 000 tokens` | `packages/opencode/src/provider/transform.ts:21` | Через `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX` env var или `model.limit.output` в `opencode.json` |

**Главный вывод (rev. 1):** ~~ни через `opencode.json`, ни через env vars **нельзя** увеличить tool-output cap.~~

**Главный вывод (rev. 2, 2026-05-13):** `tool_output.max_lines` / `tool_output.max_bytes` в `opencode.json` **работают**. Определено в schema `config.ts`, реализовано в `truncate.ts:limits()`, найдено в бинарнике v1.14.48. Не документировано на opencode.ai/docs. Подробно: [README.md](README.md).

## Где это происходит в коде

Все тулы — встроенные и custom (через плагины) — оборачиваются единой функцией `Tool.define()` в файле `packages/opencode/src/tool/tool.ts`. Она:

1. Прогоняет аргументы через Zod-валидацию из схемы тула.
2. Запускает `execute(...)` тула.
3. **После execute** прогоняет результат через `truncate(...)` (из `truncation.ts`), который применяет лимит 2000 lines / 50 KB.
4. Если truncated — полный результат пишется в temp-файл, а в LLM возвращается обрезанная версия + подсказка «use Grep/Read/explore agent to access full content».

Temp-файл лежит:
- Linux/Mac: `~/.local/share/opencode/tool-output/tool_<id>`
- Windows: `%LOCALAPPDATA%\opencode\tool-output\` или `~/.opencode/data/tool-output/` (зависит от opencode-версии)

Мы наблюдали это эмпирически — в одном из прогонов оркестратор сам читал `~/.local/share/opencode/tool-output/tool_e1e39ced4001MNptXwaSXw4FL7` через PowerShell.

## Что НЕ конфигурируется (rev. 2)

| Что | Существует ли env var | Существует ли config key |
|---|---|---|
| `MAX_LINES` для tool output | Нет | **ДА** — `tool_output.max_lines` |
| `MAX_BYTES` для tool output | Нет | **ДА** — `tool_output.max_bytes` |
| Включить/выключить truncation | Нет | Нет |
| Override truncation для конкретного тула | Нет | Нет |
| Line truncation (2000 chars per line) | Нет | Нет |
| Bash output max_lines/max_bytes | Нет | **ДА** — через общий `tool_output` (Bash идёт через truncate pipeline) |

**Важно:** `tool_output` влияет на **все** тулы, потому что все они проходят через единый `truncate.output()` pipeline — и встроенные, и plugin-тулы (через `fromPlugin` wrapper), и Bash, и Read.

В issue [#11313](https://github.com/sst/opencode/issues/11313) есть конкретный feature-request на конфигурируемость. **Фича реализована** (см. `config.ts` schema и `truncate.ts:limits()`), но **не задокументирована** на opencode.ai/docs.

## Что про plugin hooks

В `@opencode-ai/plugin` есть два хука вокруг tool execution:

```ts
"tool.execute.before"?: (input, output) => Promise<void>;
"tool.execute.after"?: (input, output) => Promise<void>;
```

Issue [#13770](https://github.com/sst/opencode/issues/13770) явно сообщает, что **порядок выполнения этих hook'ов относительно truncation непредсказуем**:

> The `tool.execute.after` hook executes at different points — **before truncation for MCP calls but after for other tools** — creating unpredictable behavior.

То есть:
- Для **MCP-тулов**: `tool.execute.after` запускается **до** truncation → можно подменить output.
- Для **plugin-тулов через `tool()` API** (наш случай): `tool.execute.after` запускается **после** truncation → output уже обрезан, подменить нельзя.

Итог: плагин-хуки **не позволяют** обойти лимит для своих же тулов.

## Что говорит официальная документация opencode

`opencode.ai/docs/config/` ([Config](https://opencode.ai/docs/config/)) — есть только настройки:
- `tools` section — включить/выключить тулы по имени (`"bash": false`)
- `compaction` section — `auto`, `prune`, `reserved` (= context management, не tool output)
- `permissions` section — разрешения на действия

**Никаких** ключей про output size.

`opencode.ai/docs/tools/` ([Tools](https://opencode.ai/docs/tools/)) — описание встроенных тулов **без** упоминания каких-либо численных лимитов.

`opencode.ai/docs/plugins/` ([Plugins](https://opencode.ai/docs/plugins/)) — пример custom-tool через `tool()`, но **ни слова** про лимиты на возврат значения.

Truncation в официальной документации **не описан вообще** (это четвёртая жалоба в issue #13770).

## Сорс-таблица: куда смотреть

| Файл | Что внутри |
|---|---|
| `packages/opencode/src/tool/tool.ts` | `Tool.define()` — обёртка для всех тулов, включает truncate-pipeline |
| `packages/opencode/src/tool/truncation.ts` | Константы `MAX_LINES = 2000`, `MAX_BYTES = 50000` + функция `truncate()` |
| `packages/opencode/src/tool/bash.ts` | bash tool implementation, default timeout 2 min |
| `packages/opencode/src/session/compaction.ts` | session-level pruning, `PRUNE_PROTECT = 40_000`, `PRUNE_MINIMUM = 20_000` |
| `packages/opencode/src/provider/transform.ts` | `OUTPUT_TOKEN_MAX = 32_000`, `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX` env var check |

(Прямой доступ к raw файлам у нас был 404 через WebFetch; данные собраны из issue threads и DeepWiki.)

## Sources

- [Issue #11313 — Long-running bash commands with large outputs cause truncation and agent retry loops](https://github.com/sst/opencode/issues/11313) — точные файлы/константы и предложение конфигурируемости.
- [Issue #13770 — Multiple problems with current truncation implementation](https://github.com/sst/opencode/issues/13770) — подтверждение что не конфигурируется + проблема с inconsistent hook order.
- [Issue #4826 — Is automatic tool calling output truncation supported?](https://github.com/sst/opencode/issues/4826) — пользовательский вопрос, closed без решения.
- [DeepWiki — Context Management and Compaction](https://deepwiki.com/sst/opencode/2.4-context-management-and-compaction) — описание pruning и сэйва в tool-output dir.
- [DeepWiki — Built-in Tools Reference](https://deepwiki.com/sst/opencode/5.3-built-in-tools-reference) — описание Read-cap-а 50 KB / 2000 lines / lines > 2000 chars.
- [Opencode docs — Config](https://opencode.ai/docs/config/) — официальный config schema (без output limits).
- [Opencode docs — Tools](https://opencode.ai/docs/tools/) — официальное описание встроенных тулов.
- [Opencode docs — Plugins](https://opencode.ai/docs/plugins/) — официальный гайд по плагинам.
- [Gist: OpenCode prompt construction](https://gist.github.com/rmk40/cde7a98c1c90614a27478216cc01551f) — анализ assembly-pipeline.
- [Medium: Fixing context limits in opencode + Ollama](https://stouf.medium.com/fixing-context-limits-in-opencode-ollama-1d820b332b41) — про Ollama-side, к нашему случаю не относится (но проверено).
