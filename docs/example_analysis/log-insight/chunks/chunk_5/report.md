# Chunk 5/7 Report (lines 27631-31032)

## Timeline: 2024-07-25 02:20:09 – 02:39:21

## 1. Dominant Pattern — OctoEverywhere Snapshot Loop (99% of chunk)

Continuous ~1s repeating trio flooding the log:

```
WARNING - ReadAllContentFromStreamResponse got an exception. We will return the current buffer length of [buffer is None]
ERROR   - _EnsureJpegHeaderInfo got a null body read from ReadAllContentFromStreamResponse
INFO    - FinalSnap failed to get a snapshot
```

- Occurs every ~1.0–1.1s without interruption from 02:20:09 through end of chunk
- Interleaved every ~10s with: `INFO - We found a webcam multicam/Default but it doesn't support snapshots, we will try to detect the snapshot URL for ourselves.`
- **Root cause**: Webcam configured via multi-cam plugin does not support snapshots; OctoEverywhere repeatedly polls it and fails
- **Severity**: Non-critical, known non-issue per project briefing, but extremely noisy (~1800+ triplets in this chunk)

## 2. Normal Operations (Expected)

| Timestamp | Event | Status |
|-----------|-------|--------|
| 02:28:04 | Server heartbeat `<3` | ✓ R3: 900s interval |
| 02:28:20 | Tracking ping (uptime=22517, OPERATIONAL) | ✓ R5: ~15min |
| 02:28:24 | Session cleanup + logout for `octipiadmin` | ✓ Normal |
| 02:38:49–51 | SlicerSettingsParser analyzing new GCODE files (Modular Enclosure parts) | ✓ Normal |
| 02:38:49–51 | Dashboard GcodePreProcessor: layers=47, 47, 116 | ✓ Normal |
| 02:38:53 | PrintDone event | ✓ Normal transition |
| 02:38:53 | FilamentManager: 3802.9mm used, -11.43g PETG spool update | ✓ Normal |
| 02:38:59 | Tracking event `print_done`, elapsed=21002s (~5h50m) | ✓ Normal |

## 3. Events of Interest

### 3.1 Telegram Plugin Errors (02:38:19, 02:38:40)

**Error 1** — Snapshot fetch timeout:
```python
ERROR - TimeOut Exception: Read timed out. [192.168.68.131:5041]
```
- Telegram plugin attempted to fetch webcam snapshot from local webcam at `192.168.68.131:5041`
- HTTP read timed out after 10s
- **Diagnosis**: Local webcam stream unresponsive at that moment

**Error 2** — DNS failure for Telegram API:
```python
ERROR - Exception loop multicam URL to create image: Temporary failure in name resolution
```
- Failed to resolve `api.telegram.org` → DNS outage (`[Errno -3] Temporary failure in name resolution`)
- Caused Telegram notification send failure
- **Diagnosis**: Temporary DNS/network outage on the Pi

### 3.2 OctoEverywhere WebSocket Disconnect/Reconnect (02:38:44)

```
02:38:44,673  ERROR - OctoEverywhere Ws error: Connection timed out
02:38:44,677  ERROR - Connection timed out - goodbye
02:38:44,678  INFO  - Service websocket closed.
02:38:44,679  INFO  - Disconnected from OctoEverywhere [syd.octoeverywhere.com]
02:38:44,680  INFO  - Sleeping for 10 seconds...
02:38:54,719  INFO  - Attempting to use lowest latency server...
02:38:55,019  INFO  - Connected... Starting handshake...
02:38:55,488  INFO  - Handshake complete, successfully connected!
```
- WebSocket to OctoEverywhere timed out and dropped
- Successfully reconnected after ~11s
- Coincides with Telegram DNS failure — consistent with **network connectivity disruption**

### 3.3 Thread Exhaustion + Plugin Error (02:38:53)

```python
ERROR - RuntimeError: can't start new thread
  → in octoprint.plugin - Error while calling plugin octoeverywhere
  → triggered by PrintDone event → OctoEverywhere NotificationHandler.OnDone → threading.Thread.start()
```
- At print completion, OctoEverywhere attempted to spawn a new thread but system hit OS thread limit
- **Diagnosis**: Likely caused by the runaway snapshot loop (WARNING/ERROR/INFO) creating threads faster than they're released; after 18+ minutes of continuous snapshot attempts, thread pool exhausted
- The snapshot loop's `RepeatTimer thread exit` was logged but thread leak already occurred

## 4. Known Non-Issues (Confirmed)

| Pattern | Status |
|---------|--------|
| Webcam deprecated settings paths (`webcam.snapshot`, `webcam.stream`) | ✓ Known non-issue, appears at 02:38:53 |
| OctoEverywhere snapshot failure (no webcam snapshot support) | ✓ Known non-issue (but thread exhaustion is a real impact) |

## 5. Summary

| Category | Count |
|----------|-------|
| INFO | ~2200 |
| WARNING | ~1100+ (mostly OctoEverywhere) |
| ERROR | ~1100+ (mostly OctoEverywhere + 2 Telegram + 1 thread) |
| CRITICAL | 0 |

**Key finding**: The relentless OctoEverywhere snapshot polling (every ~1s) caused thread exhaustion at print completion, which **did** have a real impact — the OctoEverywhere print-done notification failed. This turns a "known non-issue" into a meaningful bug: the polling should be rate-limited or stopped when threads are constrained. The network blip at 02:38:40–45 is secondary and transient.

**Recommendation**: Rate-limit OctoEverywhere `FinalSnap` retries (currently ~3600/hr) to avoid thread pool exhaustion on resource-constrained systems (RPi).
