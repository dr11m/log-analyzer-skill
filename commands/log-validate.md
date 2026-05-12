---
description: Code-aware log validation — builds Log Signature Map from source code, greps log for every expected pattern, detects errors, anomalies, and silent components
agent: plan
subtask: true
---

Load the log-validate skill and validate the log file against the project source code.

Parse $ARGUMENTS:
- First token = log file path (string, optional) — path to the log file

If the path is missing, auto-discover the log file.

Follow the log-validate skill workflow:
1. Discover the log file (or use the provided path)
2. Build a Log Signature Map: detect the project's logging framework, grep all logger calls in the source code
3. Plan grep patterns grouped into 5 analysis groups (Errors, Warnings, State/Flow, Metrics, Health)
4. Execute patterns via grep: COUNT → TRIAGE → EXTRACT stages
5. Analyze results: classify findings, build metrics table, detect silent components
6. Output the final report in Russian with code-source references for every finding
