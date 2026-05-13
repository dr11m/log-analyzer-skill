# Рекомендуемая архитектура: compact agent_prompt + ровно один Read в сабагенте

Это вариант **#11** из [options-evaluated.md](options-evaluated.md) — единственный устойчивый путь при текущих лимитах opencode.

## Главная идея

Тул больше **не пытается** уложить chunk-content в свой ответ. Вместо этого:

1. Тул считает offset/limit для каждого chunk.
2. **Hard cap** `lines_per_chunk = min(formula_по_context, 1800)` и `byte_size ≤ 45 KB` — это запас от 50 KB / 2000 lines cap-а `Read` tool.
3. Тул собирает **компактный** `agent_prompt` (~10–20 KB на чанк):
   - Hard tool rule — «сделай ровно ОДИН `Read` call с готовыми offset/limit».
   - Chunk metadata.
   - `PROJECT_BRIEFING` (inline, ~5–10 KB).
   - Analysis checklist + output template.
   - Готовая Read-инструкция: `Read(filePath="<abs>", offset=X, limit=Y)`.
4. Tool output JSON ≈ 3 × 15 KB + метаданные = **~50 KB total**, проходит под opencode tool output cap **без обрезки**.

Сабагент:
1. Получает полный `agent_prompt` в Task input.
2. Делает **ровно один** `Read(...)` с заранее посчитанными offset/limit.
3. Read возвращает чанк целиком (потому что он capped под 1800 строк / 45 KB → под лимитом Read).
4. Анализирует и возвращает структурированный отчёт.

## Trade-offs

| Метрика | Значение |
|---|---|
| Coverage при `--chunks 3, --context 250` | ~17% (3 × 1800 / 31900 lines) |
| Coverage для 100% (на 31 900 строк) | `--chunks 18` |
| Tool calls на сабагент | 1 (Read) |
| Tool output size после split_log_chunks | ~50 KB (под лимитом) |
| Task prompt per sub-agent | ~15 KB (под лимитом) |
| Сложность для LLM | Минимальная: оркестратор передаёт строку дословно, сабагент делает один Read |

Главный минус — coverage привязан к N. Пользователь должен запросить столько chunks, сколько надо для покрытия. Тул в `warnings[]` подскажет: «при текущем `--context X` для 100% покрытия используй `--chunks Y`».

## Конкретные правки в коде

### src/index.ts — тул `split_log_chunks`

1. **Hard cap размера chunk**. После формулы:
   ```ts
   const READ_TOOL_SAFE_LINES = 1800;      // запас от opencode Read cap 2000
   const READ_TOOL_SAFE_BYTES = 45 * 1024; // запас от opencode Read cap 50 KB

   const linesByContext = Math.max(1, Math.floor(maxChunkBytes / avgBytesPerLine));
   const linesByDivision = Math.max(1, Math.floor(totalLines / requestedChunks));
   const linesByReadCap = Math.max(
     1,
     Math.min(
       READ_TOOL_SAFE_LINES,
       Math.floor(READ_TOOL_SAFE_BYTES / avgBytesPerLine),
     ),
   );
   const linesPerChunk = Math.min(linesByContext, linesByDivision, linesByReadCap);
   ```

2. **Перестать инлайнить content** в `chunks[i].agent_prompt`. Перенос шаблона:
   ```ts
   const SUBAGENT_PROMPT_TEMPLATE = `You are a log chunk analyzer...

   Hard tool rules:
   - Make EXACTLY ONE tool call: Read(filePath="__LOG_PATH__", offset=__OFFSET__, limit=__LIMIT__).
   - The chunk is sized under the Read output limit so a single Read returns it in full.
   - After that one Read: ZERO further tool calls. Reason on the returned text and produce the report.

   PROJECT_BRIEFING:
   ---
   {PROJECT_BRIEFING}
   ---

   YOUR LOG CHUNK — fetch it with:
       Read(filePath="__LOG_PATH__", offset=__OFFSET__, limit=__LIMIT__)

   Chunk metadata: chunk __CHUNK_NUMBER__/__TOTAL_CHUNKS__, __LINE_COUNT__ lines, __BYTE_SIZE__ bytes.

   Analysis checklist:
   ... (без изменений)

   Output structure:
   ... (без изменений)
   `;
   ```

3. **`renderAgentPrompt`** принимает `logPath, offset, limit, lineCount, byteSize, chunkNumber, totalChunks, projectBriefing` — без `chunkContent`.

4. **`chunks[i]` структура**:
   ```json
   {
     "number": 1,
     "total": 3,
     "offset": 26301,
     "limit": 1800,
     "line_count": 1800,
     "byte_size": 253800,
     "est_tokens": 72514,
     "agent_prompt": "<полный prompt без inline content>"
   }
   ```

5. **Warnings** в JSON-ответе:
   ```ts
   if (linesByReadCap < linesByContext && linesByReadCap < linesByDivision) {
     warnings.push(
       `chunk size capped at ${linesByReadCap} lines (opencode Read tool output limit). ` +
       `Coverage ${coveragePercent}%. For full coverage set --chunks ${Math.ceil(totalLines / linesByReadCap)}.`,
     );
   }
   ```

### skills/log-insight.md

- Phase 2: упомянуть, что тул **возвращает Read-инструкции, не контент**.
- Phase 3: сабагент делает **ровно один** Read (правится из «zero tool budget» → «exactly one Read with the supplied offset/limit»).
- Anti-pattern список из 1.0.13 можно сократить — сценарии «save to file», «split into segments» больше не появятся, потому что contentа нет.

### commands/log-insight.md

- Шаг 4: упомянуть Read-инструкции внутри agent_prompt, ничего больше менять не надо.

### README.md

- Раздел «Требования к модели» можно упростить — теперь модель не должна вмещать 800 KB Task prompts.
- Добавить пояснение про coverage vs `--chunks`.

## Verification

1. **Smoke test**: `node scripts/smoke_real.mjs` на 31 900-строчном логе с `--context 250, --chunks 3`:
   - `chunks[i].agent_prompt.length < 30000` (компактный).
   - `chunks[i].agent_prompt` содержит строку вида `Read(filePath="...", offset=N, limit=1800)`.
   - `lines_per_chunk === 1800`.
   - `coverage_percent ≈ 17`.
   - `warnings[]` содержит подсказку «For full coverage set --chunks 18».
   - Полный размер JSON-ответа `< 60 KB`.

2. **Реальный прогон в opencode**:
   - `/log-insight --chunks 3 --log logs/src.log --context 250`.
   - В trace: один `split_log_chunks` → 3 `Task` в одном response block с компактными prompts.
   - Между split_log_chunks и Task — **ноль** Bash/Write/Python.
   - Каждый сабагент: ровно **один** `Read` → отчёт. (Не ноль и не два — именно один.)

3. **Прогон на полное покрытие**:
   - `/log-insight --chunks 18 --log logs/src.log --context 250`.
   - 18 параллельных сабагентов, каждый делает один Read 1800 строк.
   - Coverage в выводе тула ≈ 100%.

## Запасные варианты

Если выяснится что:

- **Один Read на 1800 строк всё равно обрезается** (запас не достаточный) — снизить cap до 1500.
- **Сабагент игнорирует Read-инструкцию и сам ищет данные** — добавить ещё более жёсткий запрет в шаблон + sanity-check в outputе (есть/нет `Lines analyzed: 1800`).
- **opencode сменит truncation API** — пересмотреть лимиты.

## Что НЕ делаем сейчас

- Не пишем в temp-файлы (variant #6 — Read всё равно cap'ает).
- Не делаем multi-Read внутри сабагента (variant #12) — это сложнее и риск ошибок при склейке. Если в будущем понадобится coverage > 100% (что невозможно) или гибкая модель — пересмотрим.
- Не пытаемся обойти truncation через plugin hooks (variant #10) — порядок hook'ов делает это невозможным для plugin-tools.
- Не переписываем плагин как MCP-сервер (variant #15) — намного больше работы, неполная гарантия успеха.
