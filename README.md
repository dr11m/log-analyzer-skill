# Log Analyzer Suite

Набор инструментов для автоматического анализа логов — индуктивного (по чанкам) и дедуктивного (по сигнатурам кода).

## Форматы

Проект поставляется в двух форматах — для разных сред использования:

### Standalone (`skills/*.md`)
Промпты-инструкции, которые можно скопировать и вставить в **любую** LLM-среду (ChatGPT, Claude, Cursor, Windsurf, opencode, и т.д.). Каждый файл — самодостаточный: содержит всю логику и встроенные скрипты (JS или shell), не требует плагинов.

| Файл | Назначение |
|------|-----------|
| `skills/log-insight-standalone.md` | Индуктивный анализ с контекстом проекта (EN) |
| `skills/log-insight-standalone_ru.md` | То же, на русском |
| `skills/log-validate-standalone.md` | Дедуктивная валидация по коду (EN) |
| `skills/log-validate-standalone_ru.md` | То же, на русском |
| `skills/log-insight-lite_ru.md` | Индуктивный анализ **без** контекста проекта (только лог) |

### Plugin для opencode (`.opencode/skills/`)
Готовые скилы для агента **opencode** с нативными инструментами (`split_log_chunks`, Grep/Glob/Read). Не требуют JS/Node.js — вся логика на инструментах платформы.

| Папка | Назначение |
|-------|-----------|
| `.opencode/skills/log-insight/SKILL.md` | Индуктивный анализ через нативный `split_log_chunks` |
| `.opencode/skills/log-validate/SKILL.md` | Дедуктивная валидация через Grep/Glob/Read |

## Виды анализа

### 1. Log Insight (индуктивный, по чанкам)

Разбивает лог-файл на N равных чанков (с конца файла — свежие данные первыми). Каждый чанк анализирует отдельный саб-агент, затем оркестратор собирает консолидированный отчёт с трендами по всем чанкам.

- **Требует:** Node.js (для скрипта разбиения в standalone-версии)
- **Контекст проекта:** читает `AGENTS.md`, `CLAUDE.md`, `docs/*.md` и передаёт брифинг каждому саб-агенту
- **Результат:** `log-analysis/log-insight/report.md` + отчёты по каждому чанку

### 2. Log Validate (дедуктивный, по сигнатурам)

Сканирует исходный код проекта, находит **все** вызовы логгера (logger.error, console.warn, и т.д.), строит карту сигнатур, а затем grep'ает лог-файл каждым паттерном. Обнаруживает ошибки, аномалии и "молчащие" компоненты.

- **Требует:** только shell (bash/zsh/Git Bash) — grep, find, cat, wc
- **Контекст проекта:** читает весь исходный код, документацию, правила
- **Результат:** `log-analysis/log-validate/report.md`

### 3. Log Insight Lite (индуктивный, без проекта)

То же, что Log Insight, но **без контекста проекта**. Только лог-файл. Саб-агенты сами выводят формат лога, тип приложения, компоненты и ожидаемое поведение — исключительно из содержимого лога.

- **Применение:** чужие логи, неизвестные системы, быстрый анализ без изучения кодовой базы
- **Контекст проекта:** не требуется
- **Результат:** отчёт в чате (без сохранения на диск в текущей версии)

## Сравнение

| | Insight Standalone | Insight Lite | Validate Standalone |
|---|---|---|---|
| **Метод** | Индуктивный | Индуктивный | Дедуктивный |
| **Разбиение на чанки** | Да (JS-скрипт) | Да (JS-скрипт) | Нет |
| **Контекст проекта** | Да (документация) | Нет | Да (исходный код) |
| **Саб-агенты** | N параллельных | N параллельных | Нет |
| **Зависимости** | Node.js | Node.js | Только shell |
| **Сохранение на диск** | Да | Нет | Да |

## Структура вывода (Insight)

```
log-analysis/
├── log-insight/
│   ├── briefing.txt              # брифинг проекта
│   ├── split-log.cjs            # скрипт разбиения
│   ├── report.md                # финальный сводный отчёт
│   └── chunks/
│       ├── chunk_1/
│       │   ├── tmp_chunk_file   # сырые данные чанка
│       │   └── report.md        # отчёт саб-агента
│       └── ...
└── log-validate/
    └── report.md                # финальный отчёт валидации
```

## Использование

### Standalone (любая LLM-среда)

1. Скопируй содержимое нужного `.md` файла
2. Вставь в чат с LLM
3. Укажи путь к логу и параметры (для Insight: `--chunks N`, для Validate: просто путь)

Примеры:
```
/log-insight-standalone --chunks 5 --log logs/app.log
/log-insight-standalone --chunks 3 --context 700 --log logs/app.log
/validate logs/app.log
```

### Plugin (opencode)

Скилы загружаются автоматически. Используй как слэш-команды:
```
/log-insight --chunks 5 --log logs/app.log
/log-validate logs/app.log
```

## Пример разбора

Реальный прогон на логе из публичного issue [OctoPrint](https://github.com/OctoPrint/OctoPrint) — [#5048: Filament run out does not allow resuming anymore](https://github.com/OctoPrint/OctoPrint/issues/5048).

| | |
|---|---|
| **Проект** | [OctoPrint](https://github.com/OctoPrint/OctoPrint) 1.10.2 — веб-интерфейс для 3D-принтеров |
| **Ошибка в issue** | после срабатывания датчика филамента кнопка Resume пропадает из UI, печать остаётся на паузе |
| **Лог** | `octoprint.log` из systeminfo-бандла issue (~5.2 MB, 37 836 строк, 6 дней, Raspberry Pi 4, 46 плагинов) |
| **Полный разбор** | [Log Insight](docs/example_analysis/log-insight/report.md) · [Log Validate](docs/example_analysis/log-validate/report.md) |

Оба метода независимо показали, что **~69% лога** — шум плагина OctoEverywhere (snapshot-цикл ~1 с). Insight связал это с эскалацией `RuntimeError: can't start new thread` (46+) и `MemoryError`, плюс нестабильный USB/serial. Validate по 829 вызовам логгера в коде подтвердил те же кластеры (сеть, serial, Telegram, softwareupdate).

## **Требования**

- **Node.js** — для standalone-версий Insight (скрипт разбиения `split-log.cjs`)
- **Shell (bash/zsh/Git Bash/MSYS2/WSL)** — для Validate
- **opencode** — только для plugin-версий в `.opencode/skills/`

---

## English

A suite of tools for automated log analysis — inductive (chunked) and deductive (signature-based).

### Formats

- **Standalone** (`skills/*.md`) — copy-paste prompts for any LLM environment. Self-contained: all logic and scripts inlined.
- **Plugin** (`.opencode/skills/`) — ready-to-use opencode skills with native tooling (`split_log_chunks`, Grep/Glob/Read).

### Analysis Types

- **Log Insight** — chunked inductive analysis with project context. Splits logs, launches N parallel sub-agents, merges findings into a trend report.
- **Log Validate** — code-aware deductive validation. Scans all logger calls in source, greps the log for every expected pattern.
- **Log Insight Lite** — same as Insight but without project context. Infers everything from log content alone. Good for unknown systems.

### Real-world example

[OctoPrint](https://github.com/OctoPrint/OctoPrint) 1.10.2 log from [#5048](https://github.com/OctoPrint/OctoPrint/issues/5048) (filament run-out, Resume button missing). Full reports: [Insight](docs/example_analysis/log-insight/report.md), [Validate](docs/example_analysis/log-validate/report.md). Both tools flagged OctoEverywhere as ~69% of the log and tied it to thread/memory exhaustion plus serial USB failures.
