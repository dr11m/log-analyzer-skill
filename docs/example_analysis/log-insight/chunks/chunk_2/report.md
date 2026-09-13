# Chunk 2 Analysis Report

**File:** `tmp_chunk_file`  
**Lines:** 3401 (< 3402, as noted)  
**Bytes:** ~493 KB  
**Time Range:** 2024-07-22 11:42:40 → 2024-07-23 07:22:43  
**Time Span:** ~19h 40m

---

## Session Timeline

| Session | Start | End | Duration | Printer State |
|---------|-------|-----|----------|---------------|
| Session 1 | 2024-07-22 11:51:20 | 2024-07-22 11:49:41 (shutdown cmd) | ~23h (overlaps with prev chunk) | Offline → Online → Printing → Offline after error → Shutdown |
| *Gap* | 11:49:41 | 11:51:20 | ~1m 39s | System shutdown & reboot |
| Session 2 (restart) | 2024-07-22 11:51:20 | 2024-07-23 05:41:57 (shutdown cmd) | ~17h 50m | Offline (9h) → Online → Printing → Done → Error → Shutdown |
| Session 3 (restart) | 2024-07-23 05:42:17 | 2024-07-23 07:22:43 (chunk end, still printing) | Ongoing | Online → Printing |

---

## Severity 1: Critical

### 1.1 SerialException — Device Disconnected (line 2842)
```
2024-07-23 05:31:58 - SerialException: device reports readiness to read but returned no data
                        (device disconnected or multiple access on port?)
2024-07-23 05:31:59 - Changing monitoring state from "Operational" to "Offline after error"
```
- **Effect:** Printer went offline mid-operation (after print #1 finished, before print #2 started).
- **Time in state OFFLINE:** From 05:31:59 until shutdown at 05:41:57 (10 min), then reboot.

### 1.2 OctoEverywhere Snapshot ERROR Storm (lines 1–1187)
- **383 ERROR lines:** `_EnsureJpegHeaderInfo got a null body read from ReadAllContentFromStreamResponse`
- **387 WARNING lines:** `ReadAllContentFromStreamResponse got an exception [buffer is None]`
- **383 INFO lines:** `FinalSnap failed to get a snapshot`
- **Duration:** 11:42:40 → 11:49:41 (7 minutes, continuous ~1/sec cycle until shutdown)
- **Root cause:** Camera/webcam snapshot URL is not returning data. Plugin detects `multicam/Default` but it doesn't support snapshots, and auto-detection of snapshot URL fails.
- **Affects:** OctoEverywhere remote monitoring, timelapse previews.

### 1.3 Missing metadata init gap (~9 hours)
```
2024-07-22 11:51:20 - Starting OctoPrint 1.10.2
... (no serial/connectivity activity for ~9 hours) ...
2024-07-22 20:47:48 - Trying to connect to configured serial port None
```
- **Gap:** 11:51:20 → 20:47:48 (~8h 56m)
- **Likely cause:** Printer was powered off, or serial port was unavailable (`port = None`).
- Connectivity was also offline during this window.

---

## Severity 2: Warning

### 2.1 Deprecated Webcam Settings Access (lines 340, multiple)
```
DeprecationWarning: Detected access to deprecated settings path ['webcam', 'snapshot']
DeprecationWarning: Detected access to deprecated settings path ['webcam', 'stream']
```
- Triggered at print start (session 2 and 3) by `octoeverywhere` and `telegram` plugins.
- **Consequence:** These plugins use pre-1.9.0 webcam API. Compatibility layer will be removed in a future release.

### 2.2 CSRF Protection Disabled for 6 Plugins (lines 2980+)
```
CSRF Protection for Blueprint of plugin <name> is DISABLED
```
- **Affected:** `arc_welder`, `bedlevelvisualizer`, `filamentmanager`, `filemanager`, `multicam`, `zupfe`
- These plugins rely on the default `is_blueprint_csrf_protected` (will switch from False to True in future).

### 2.3 Stickypad Plugin Settings Warning
```
There is a non-dict value on the path to pluginsstickypadnoteops at ['note'], ignoring.
```
- Repeated 3× in session 3 (lines after 05:59:41).

### 2.4 No Internet Connectivity (both restarts)
```
Connectivity state is currently: offline
Connecting to 1.1.1.1:53 is not working
Resolving octoprint.org is not working
```
- After first restart (11:51:26) and second restart (05:42:23).
- Plugin blacklist not fetched; OctoEverywhere could not connect initially.

### 2.5 Plugin Errors on Startup (line ~2980+)
- `telegram` plugin: `Exception on_startup: 'NoneType' object has no attribute 'port'`
- `zupfe` plugin: ERROR logged with webcam URLs, unable to reach Synology Surveillance Station cameras at `192.168.68.131:5041`

---

## Severity 3: Info

### 3.1 Session 1 — Long Print Completed Successfully
- **Print job:** `Cap and Cover/1x_Cable_Hole_Cap..._60g_8h_12m.aw.gcode`
- **Duration:** 20:57:12 → 05:01:42 (29,070s ≈ 8h 4m)
- **Filament used:** 19,529.6mm (58.7g from spool "Yellow - PETG (Creality)")

### 3.2 Session 2 (post error) — Second Print Started
- **Print job:** `Duct Cap for Acrylic/CCR10S_Duct Cap..._19g_2h_26m.aw.gcode`
- **Started:** 06:01:05
- **Chunk ends while still printing** (~1h 21m into estimated 2h 26m job).

### 3.3 Client Connection Activity
- **192.168.68.101 (octipiadmin):** Multiple connect/disconnect cycles throughout
- **192.168.68.154 (octipiadmin):** Connected at 05:59:41 (session 3)
- **127.0.0.1 (homeassistant):** Passive login at 05:59:12
- Frequent `Client connection closed` messages suggest network instability or user actively closing tabs.

### 3.4 Serial Capabilities
- Printer firmware: **Marlin 2.1.2.2** (CR-10S)
- Supported features include: EEPROM, volumetric, auto-report temp, print job, auto-level, runout, z-probe, emergency parser, host action commands, SD write, arcs, babystepping, thermal protection
- Not supported: XON/XOFF, binary file transfer, auto-report pos, progress, build percent, software power, lights, prompt, multi-volume, repeat, chamber temp, meatpack

### 3.5 OctoEverywhere Connection (session 3)
- Connected successfully at 05:59:03, server: `wss://syd.octoeverywhere.com/octoclientws`
- Webcam snapshot detection fails repeatedly — camera not providing snapshot endpoint

---

## Cross-Chunk Signals

| Signal | First Seen (Chunk 2) | Pattern Notes |
|--------|---------------------|---------------|
| Camera snapshot failures | 11:42:40 | ~383 ERROR + 387 WARNING (7 min storm) then second wave after restart |
| SerialException / disconnect | 05:31:58 | Device on /dev/ttyUSB0 disconnected unexpectedly |
| Print completed | 05:01:42 | 8h 4m print, filament tracking OK |
| Metadata gap (serial=None) | 11:51:20 → 20:47:48 | ~9h with no serial connection after reboot |
| Deprecated webcam API usage | Multiple | `octoeverywhere`, `telegram` accessing `webcam.snapshot` |
| CSRF disabled plugins | 05:58:56 | 6 plugins with disabled CSRF |

---

**Summary:** Chunk 2 covers two full OctoPrint sessions and the start of a third. Primary issues: (1) Camera snapshot system is broken — OctoEverywhere cannot take snapshots during prints due to null body from webcam stream; (2) Serial connection dropped after print #1 completed (SerialException), requiring a reboot; (3) After first reboot, ~9h gap with no serial port configured, suggesting printer was powered off; (4) Deprecated plugin APIs (webcam v1) still in active use by 2 plugins; (5) No internet connectivity after both reboots, affecting plugin features.
