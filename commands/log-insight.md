---
description: Inductive log analysis — splits log into N chunks, analyzes each in parallel against project documentation, consolidates trend-aware findings
agent: plan
subtask: true
---

Load the log-insight skill and analyze the log file using chunked inductive analysis.

Parse $ARGUMENTS:
- First token = N (integer, required) — number of chunks to analyze
- Second token = log file path (string, optional) — path to the log file

If any required value is missing, ask the user for it before proceeding.

Follow the log-insight skill workflow:
1. Build project briefing from project documentation
2. Calculate chunk boundaries using the split_log_chunks tool (returns offset/limit pairs)
3. Launch N parallel sub-agents — each reads one chunk from the original log file using Read(offset, limit)
4. Consolidate all findings into a trend-aware report with CRITICAL/MEDIUM/LOW severity levels
5. Output the final report in Russian
