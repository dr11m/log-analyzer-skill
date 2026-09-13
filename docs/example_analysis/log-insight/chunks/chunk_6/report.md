# Chunk 6/7: Lines 31033–34434 (3402 lines)

**Time range:** 2024-07-25 02:39:21 — 2024-07-25 02:58:39 (~19 min)

---

## Overview

The shortest chunk in the log (~19 min). Almost entirely dominated by OctoEverywhere's aggressive 1s snapshot triplet (WARNING/ERROR/INFO). Contains a serial disconnection and, critically, shows thread exhaustion **preventing the printer from reconnecting**.

---

## CRITICAL

### C1 — Thread exhaustion prevents serial reconnection (02:58:33)

**Timeline:**
```
02:48:56  Serial error → Offline after error  (5th occurrence logged)
02:54:29  3× RuntimeError: can't start new thread (softwareupdate)
02:58:04  Heartbeat (server still alive)
02:58:32  Autoconnect triggered: Offline → Detecting serial connection
02:58:32  Handshake #1 OK → M110 detected ✓
02:58:33  _onConnected() tries to start SD status timer →
          RuntimeError: can't start new thread ✗
02:58:33  Detecting serial → Offline after error (connection failed!)
02:58:39  Second autoconnect attempt: Offline → Detecting serial connection
          (still in progress at chunk end)
```

**Root cause:** The thread pool is exhausted (from OctoEverywhere's polling + softwareupdate). Although serial handshake #1 succeeds (M110 detected), the `_onConnected()` callback fails to start the SD status timer thread. **The serial connection is technically established but breaks during initialization.**

**Impact: System cannot connect to printer despite physical serial connection being functional.** The printer shows readiness (M110 detected) but the software can't complete initialization.

### C2 — Serial Error #5 (02:48:56)

Same pattern as all previous: `SerialException: device reports readiness to read but returned no data`. Printer was in OPERATIONAL state (idle between prints). This is the 5th occurrence across all chunks.

---

## MEDIUM

### M1 — OctoEverywhere aggressive snapshot flooding

99%+ of this chunk is the 1s triplet:
```
WARNING - ReadAllContentFromStreamResponse...
ERROR   - _EnsureJpegHeaderInfo...
INFO    - FinalSnap failed...
```
The snapshot polling generates ~1800 triplets in this 19-minute chunk.

---

## Chunk Statistics

| Metric | Value |
|--------|-------|
| Total lines | 3402 |
| Time span | 19 min |
| State transitions | 4 |
| Serial errors | 1 |
| `RuntimeError: can't start new thread` | 5 (3 softwareupdate + 1 serial thread + 1 more) |
| Heartbeats | 2 (correct 900s interval) |

## Cross-Chunk Signals

1. **Thread exhaustion prevents connection** — this is a new severity level. Previous chunks showed thread exhaustion affecting plugins; this chunk shows it blocking basic functionality.
2. **Chunk 7 continues immediately** — the serial connection attempt at 02:58:39 continues in chunk 7 (line 1 of chunk 7 starts at 02:58:40).
3. **5th serial error** — pattern accelerating. The USB connection reliability is degrading or being affected by other system issues.
