# log-analyzer-suite — документация

## Рабочие результаты

- [results.md](results.md) — что реально сработало, конфигурация, поток данных, ключевые находки

## Исследовательские материалы

Исходные исследования, проведённые в ходе отладки. Историческая ценность,
не нужны для использования плагина.

- [references/opencode-output-limits.md](references/opencode-output-limits.md) — лимиты tool output в opencode: точные значения, исходники, конфигурируемость
- [references/why-our-plugin-breaks.md](references/why-our-plugin-breaks.md) — provenance проблемы: где именно срабатывает truncation
- [references/options-evaluated.md](references/options-evaluated.md) — все рассмотренные варианты решения (16 подходов)
- [references/architecture-recommendation.md](references/architecture-recommendation.md) — рекомендуемая архитектура (вариант #11, устарело — см. results.md)
- [references/task-prompt-analysis.md](references/task-prompt-analysis.md) — анализ: обрезается ли prompt-параметр Task tool
