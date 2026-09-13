# Chunk 7/7: Lines 34435–37836 (3402 lines)

**Time range:** 2024-07-25 02:58:40 — 2024-07-26 03:59:20 (~25h)

---

## Overview

The final and most eventful chunk. Contains the most severe resource exhaustion (31× `RuntimeError`, 7× `MemoryError`), multiple WebSocket disconnects, 4 print job lifecycle events (1 complete, 2 cancelled, 1 in-progress), and multiple OctoEverywhere disconnection/reconnection cycles. The log ends with the system printing, with Sticky Pad warnings appearing until the very last log line.

---

## CRITICAL

### C1 — Worst Resource Exhaustion in the Log (31× RuntimeError + 7× MemoryError)

**31 occurrences of `RuntimeError: can't start new thread`** cascade through the system:

| Time | Plugin | Context |
|------|--------|---------|
| 02:58:40-03:26:00 | softwareupdate, pluginmanager, file_check, serial | Massive cascade at chunk start — 20+ failures in under 30 min |
| Throughout day | softwareupdate | Sporadic failures on periodic update checks |
| 09:34-19:00 | softwareupdate | Additional bursts during update polling |

**7× `MemoryError` across two API endpoints:**
- `/api/files [GET]` (lines 30, 2897 in chunk 4 context) — Flask JSON serialization failed
- Telegram snapshot fetch (01:00:15 in chunk 4 context) — reading camera response overwhelmed memory

**Impact:** Thread exhaustion prevented serial connection at 02:58:33 (carried over from chunk 6). The system took ~4 minutes to recover (until 03:02:20 restart).

---

### C2 — Two Cancelled Prints within 24 hours

**Print Job 6 — Cancelled after 3 seconds (20:17:16):**
```
File: 2x_Back Panel_Panel Border...120g_12h5m
Started: 20:17:13,356
Cancelled: 20:17:16,802  (fileposition=30366)
→ Force-sending M108 → Cancelling → Operational
```
User octipiadmin cancelled immediately after starting. The file was then re-selected with different slicer settings (`215inc_220nc_50pfs`).

**Print Job 7 — Cancelled after ~7 hours (03:25:34):**
```
File: 1x_Back Panel_Panel Border...60g_6h0m  
Started: 20:18:26,827
Cancelled: 03:25:34,532  (fileposition=24006)
```
User cancelled a 7-hour print job. The same file was restarted 1 minute later as Print Job 8 (03:26:33).

**Cancellation process:** Both followed the same pattern — M108 forced, communication timeout during cancellation, state Cancelling → Operational, OctoEverywhere timer cleanup.

---

### C3 — OctoEverywhere WebSocket Instability (4 disconnects)

| Time | Duration | Target | Reason |
|------|----------|--------|--------|
| 20:34:07 | N/A | ZupFe | Connection to remote host lost |
| 20:41:05 | ~20s | syd.octoeverywhere.com | Connection lost → [Errno 111] refused on retry → starport fallback → reconnected |
| 20:52:04 | ~8s | starport-v1.octoeverywhere.com | Connection lost → fallback to syd → reconnected |
| Throughout | ~7s each | syd.octoeverywhere.com | Multiple ping/pong timeouts |

The 20:41 event is notable: the primary endpoint (`syd.octoeverywhere.com`) failed, the fallback (`starport-v1.octoeverywhere.com`) was attempted after a DNS/connect failure, and eventually reconnected. Pattern suggests network instability in the 20:34-20:52 window.

---

## MEDIUM

### M1 — Print Job 5: Successful 6-hour print (03:04 → 09:04)

| Phase | Time | Duration |
|-------|------|----------|
| Selected | 03:04:17,791 | — |
| Printing | 03:04:18,098 | — |
| **Finished** | **09:04:12,080** | **21,594s (~6h00m)** |
| Gadget stopped | 09:04:20,194 | — |

**File:** `1x_Back Panel_Panel Border_Plain...60g_6h0m.aw.gcode`
**Accuracy:** Filename estimate "6h" vs actual 21,594s (5h59m) — near-perfect match.

---

### M2 — Serial Error #6 (09:34:32)

Same `SerialException` again. Printer was OPERATIONAL (idle after print job 5 completed). Another 9+ hour offline period follows (09:34 → 20:03 restart).

---

### M3 — Startup cycles

| Time | Event | Result |
|------|-------|--------|
| 02:58:40 (chunk start) | Continuing from chunk 6 reconnect | Failed (thread exhaustion) |
| 03:02:20 | Fresh startup (restart happened before this point) | **Connected successfully** |
| 20:03:00 | Startup after 9h offline | **Connected successfully** |

---

## LOW

### L1 — Recurring known non-issues
- **Sticky Pad WARNINGs** — 50+ occurrences, triggered on every UI interaction. Present in the **final line of the log** (line 3402).
- **ZupFe PSU errors** — 3 per print start, always with same `400 Bad Request` error
- **Telegram startup exception** — `'NoneType' object has no attribute 'port'` every restart
- **ZupFe webcam URL errors** — `/webcam/?action=stream` + Synology URL every restart
- **softwareupdate arc_welder config error** — every restart
- **CSRF disabled** warnings for filemanager, multicam, zupfe
- **lastmodified timezone warnings** — on every UI page load
- **MarlinSlider fan suppression** — M107/M106 removed during prints

### L2 — User activity (Jul 25-26)

Multiple UI sessions from 192.168.68.154 (octipiadmin, Mac Chrome) and 192.168.68.101 (octipiadmin). homeassistant sessions from 127.0.0.1 and remote IPs. User was actively managing the printer, selecting/cancelling/restarting prints.

---

## Chunk Statistics

| Metric | Value |
|--------|-------|
| Total lines | 3402 |
| Time span | ~25h (last log chunk) |
| State transitions | 20+ |
| Print jobs | 4 (1 completed, 2 cancelled, 1 in progress) |
| Serial errors | 1 (#6 overall) |
| `RuntimeError: can't start new thread` | **31** |
| `MemoryError` | **7** (in chunk boundary area) |
| OctoEverywhere WebSocket disconnects | 3 |
| ZupFe disconnects | 1 |
| Heartbeats | 35+ (all correct 900s interval) |
| User sessions | 10+ |

## Final Log State

The log ends at **2024-07-26 03:59:20** with:
- State: **PRINTING** (Print Job 8: same 60g file restarted after cancellation)
- OctoEverywhere: NOT in aggressive snapshot mode (42s webcam scan only)
- User octipiadmin last seen at 03:57:17 from 192.168.68.154
- Sticky Pad WARNINGs at the very last log line

## Cross-Chunk Signals (Final Summary)

1. **Thread exhaustion cascade** — worsened across chunks 4→5→6→7. Started as plugin-level failures, escalated to **blocking serial connections** in chunk 6. Root cause: OctoEverywhere's relentless 1s snapshot polling creating threads faster than release.
2. **Serial error pattern** — 6 total occurrences across the full log. The USB connection is unreliable; possible causes: loose cable, USB power management, or Pi USB controller issue.
3. **OctoEverywhere two-mode behavior** — mode A (42s single-line scan) during normal operation, mode B (1s triplet) during final snap phase or after certain triggers. The aggressive mode contributes to thread exhaustion.
4. **User involvement** — octipiadmin actively managing prints, cancelling failed/premature starts, re-selecting files with different settings. User is technically competent.
5. **All plugins work** (eventually) — despite thread exhaustion, every plugin eventually loads and functions when threads become available.
