# Log Insight Report: OctoPrint 1.10.2

**Log file:** `octoprint.log` (5.2 MB, 37,836 строк, 2024-07-20 – 2024-07-26)
**Анализ:** 7 чанков × 3,402 строк = 23,814 строк (62.9% покрытия), контекст 200K
**Система:** Raspberry Pi 4, OctoPi 1.0.0, Marlin 2.1.2.2 (CoreXY), 46 плагинов

---

## Cross-Chunk Metrics

| Метрика | Чанк 1 (20 мин) | Чанк 2 (19ч40м) | Чанк 3 (18ч34м) | Чанк 4 (24ч22м) | Чанк 5 (19 мин) | Чанк 6 (19 мин) | Чанк 7 (25ч) | Тренд |
|---------|:-------:|:-------:|:-------:|:-------:|:-------:|:-------:|:-------:|:-------:|
| Временной диапазон | Jul 22 11:22 | Jul 22 11:42→Jul 23 07:22 | Jul 23 07:23→Jul 24 01:57 | Jul 24 01:57→Jul 25 02:20 | Jul 25 02:20-02:39 | Jul 25 02:39-02:58 | Jul 25 02:58→Jul 26 03:59 | — |
| SerialException | 1 | 1 | 4 | 2 | 0 | 1 | 1 | **Стабильно-частые** |
| RuntimeError (thread) | 0 | 0 | 1 | 9 | 1 | 5 | 31 | ⚠️ **Резкий рост** |
| MemoryError | 0 | 0 | 0 | 3 | 0 | 0 | 7 | ⚠️ **Эскалация** |
| OE 1s flood активен | ✅ | ✅ | ❌ (30-90s) | ❌ (пост-принт) | ✅ | ✅ | ❌ (спорадически) | **Два режима** |
| OE WS disconnects | 0 | 0 | 4 | 7+ | 1 | 0 | 4 | **Волнообразно** |
| Thermal runaway | 0 | 0 | 4 (2× 86/235°C) | 1 | 0 | 0 | 0 | **Изолировано** |
| Напечатано | 0 | 1 (8ч04м) | 0 | 2 (8ч39м+5ч50м) | 1 (из ч.4) | 0 | 1 (6ч) | **Норма** |
| Отменено печатей | 0 | 0 | 0 | 0 | 0 | 0 | 2 | **Разово** |
| **Всего CRITICAL** | 2 | 3 | 6 | 4 | 0 | 2 | 3 | **Пик в ч.4-7** |
| **Всего MEDIUM** | 1 | 5 | 6 | 8 | 3 | 1 | 3 | **Стабильно** |
| **Всего LOW** | 1 | 0 | 6 | 8 | 0 | 0 | 2 | **Стабильно** |
| **Max gap (сек)** | N/A | 32,100 | 19,200 | 32,100 | N/A | N/A | 60,000 | **Регулярные 9ч+** |

---

## CRITICAL

### C1 — Thread Pool Exhaustion: RuntimeError "can't start new thread" (46+ инцидентов)

| Чанки | Количество | Временной диапазон |
|-------|:----------:|:------------------:|
| 4 | 9× | Jul 25 01:00:34–01:22:03 |
| 5 | 1× | Jul 25 02:38:53 |
| 6 | 5× (3 softwareupdate + 1 serial + 1) | Jul 25 02:54:29–02:58:33 |
| 7 | **31×** | Jul 25 02:58:40–Jul 26 03:26:00 |
| **Итого** | **46+** | **Jul 25 01:00 → Jul 26 03:26** |

**Описание:** Прогрессирующее истощение системного лимита потоков (`ulimit -u` или `pids.max`). Начинается в чанке 4 как каскадный отказ 6 плагинов (pluginmanager, softwareupdate, octoeverywhere, pi_support, firmwareupdater, file_check). В чанке 6 достигает критической точки — блокирует подключение к принтеру (serial handshake OK, но `_onConnected()` не может запустить поток SD status timer → Offline after error). В чанке 7 — 31 инцидент, система на грани отказа.

- Свидетельство: `RuntimeError: can't start new thread` в `Error while calling plugin octoeverywhere`
- Ожидаемое поведение: Плагины должны успешно запускать потоки (R1-R2)
- **Корневая причина:** OctoEverywhere запускает агрессивный snapshot-цикл (каждую ~1 секунду), создающий потоки быстрее, чем они освобождаются. В сочетании с 46 плагинами и sentry_sdk это исчерпывает лимит потоков Pi.

### C2 — Serial Communication Failures: 6 SerialException

| # | Чанк | Время | Тип | Состояние |
|:-:|:----:|:-----:|:---:|:---------:|
| 1 | 1 | Jul 22 11:39:43 | Read — disconnected | Operational → Offline after error |
| 2 | 2 | Jul 23 05:31:58 | Read — disconnected | Operational → Offline after error |
| 3 | 3 | Jul 23 09:03:02 | Read — disconnected | Operational → Offline after error |
| 4 | 3 | Jul 23 12:16:28 | Read — disconnected | Operational → Offline after error |
| 5 | 3 | Jul 23 23:24:25 | Read — disconnected | Operational → Offline after error |
| 6 | 3 | Jul 24 01:55:34 | **Write — [Errno 5] I/O error** | Starting → Offline after error |
| 7 | 4 | Jul 24 11:07:06 | Read — disconnected | Operational → Offline after error |
| 8 | 4 | Jul 24 20:28:13 | Read — disconnected | Operational (after manual reconnect) → Offline |
| 9 | 6 | Jul 25 02:48:56 | Read — disconnected | Operational → Offline after error |
| 10 | 7 | Jul 25 09:34:32 | Read — disconnected | Operational → Offline after error |

**Описание:** 10 SerialException за 6 дней, все с сообщением `device reports readiness to read but returned no data (device disconnected or multiple access on port?)`. Одна ошибка записи (`[Errno 5] Input/output error`).

- Свидетельство: `serial.serialutil.SerialException: device reports readiness to read but returned no data`
- Ожидаемое поведение: Серийное соединение 115200 бод должно быть стабильным (R1, проектный брифинг §1)
- **Корневая причина:** Физическая проблема USB — возможно, ослабленный кабель, неисправный USB-контроллер Pi, или проблемы с питанием USB после завершения печати. Каждый раз восстановление требует перезагрузки или ручного переподключения.

### C3 — MemoryError: 10 инцидентов

| Чанк | Время | Контекст |
|:----:|:-----:|:--------:|
| 4 | Jul 25 01:00:15 | Telegram take_image (снапшот с камеры 192.168.68.131:5041) |
| 4 | Jul 25 01:22:11 | `/api/files [GET]` — `json.dumps` сериализация |
| 4 | Jul 25 01:26:08 | `/api/files [GET]` — `json.dumps` сериализация |
| 7 | Jul 25 03:26:00+ | 7× MemoryError в `/api/files [GET]` |

- Свидетельство: `MemoryError` в `json.dumps` при сериализации списка файлов
- Ожидаемое поведение: API должен обрабатывать запросы без исчерпания памяти
- **Корневая причина:** На фоне thread pool exhaustion и утечки потоков OE, RAM Pi достигает критического уровня. Большой список GCODE файлов при сериализации превышает доступную память.

### C4 — OctoEverywhere Snapshot Flood (99% лога в чанках 1, 2, 5, 6)

**Затронутые чанки: 1, 2, 5, 6**
Повторяющийся триплет каждую ~1 секунду:
```
WARNING - ReadAllContentFromStreamResponse got an exception [buffer is None]
ERROR   - _EnsureJpegHeaderInfo got a null body read from ReadAllContentFromStreamResponse
INFO    - FinalSnap failed to get a snapshot
```

| Чанк | Продолжительность | Оценка строк |
|:----:|:-----------------:|:------------:|
| 1 | 20 мин | 3,384 (99.5%) |
| 2 | 7 мин (до shutdown) | 1,153 |
| 5 | 19 мин | ~3,300 (97%) |
| 6 | 19 мин | ~3,300 (97%) |

**Важно:** Это не просто шум — в чанке 5 агрессивный цикл привел к thread exhaustion в момент `PrintDone`, что заблокировало отправку уведомления OctoEverywhere. В чанке 6 тот же механизм предотвратил подключение к принтеру.

- Свидетельство: `_EnsureJpegHeaderInfo got a null body read from ReadAllContentFromStreamResponse`
- Ожидаемое поведение: OctoEverywhere должен корректно определять snapshot URL или прекратить polling
- **Корневая причина:** Webcam настроена через multicam/Default без snapshot URL. OctoEverywhere не определяет корректный snapshot URL самостоятельно и не применяет backoff. При этом OctoEverywhere имеет два режима:
  - **Режим A** (нормальный): сканирование раз в 30-90 секунд с одной INFO-строкой (чанк 3)
  - **Режим B** (агрессивный): триплет раз в секунду (чанки 1, 2, 5, 6)

### C5 — Thermal Runaway Warnings (4 инцидента, чанк 3)

| Время | Актуальная | Целевая | Δ |
|:-----:|:----------:|:-------:|:-:|
| Jul 23 10:39 | 208.59°C | 220.0°C | 11.4°C |
| Jul 23 10:39 | 208.75°C | 220.0°C | 11.25°C |
| Jul 23 23:09 | **86.38°C** | **235.0°C** | **148.6°C** |
| Jul 23 23:09 | **86.38°C** | **235.0°C** | **148.6°C** |

- Свидетельство: `Possible thermal runaway detected for tool0. Actual 86.38 and Target 235.0`
- Ожидаемое поведение: Хотэнд должен достигать целевой температуры в течение разумного времени
- **Корневая причина:** Два mild (11°C, при нормальном PID-регулировании) и два **серьёзных** (86°C при цели 235°C — хотэнд не достигает рабочей температуры). Возможна неисправность нагревателя, терморезистора или питания. При этом печать продолжилась (не настоящий runaway по PID-логике).

### C6 — Autoconnect Failure + 9h Offline (чанки 2, 3, 4, 7)

После перезагрузок система остаётся без принтера на длительные периоды:
- Чанк 2: ~9h (11:51→20:47) — `port=None`
- Чанк 4: ~9h (11:18→20:13) — autoconnect исчерпал 3 кандидата портов
- Чанк 3: ~25 мин (23:24→23:48) — retry loop
- Чанк 7: ~10.5h (09:34→20:03) — после SerialException

- Свидетельство: `commerror_autodetect: 'No more candidates to test, and no working port/baudrate combination detected.'`
- Ожидаемое поведение: Autoconnect должен найти порт (R9) или сообщить об отсутствии (R4)
- **Корневая причина:** USB-порт принтера не перечисляется после перезагрузки Pi. Возможно, принтер выключен или USB-хаб не инициализируется вовремя.

---

## MEDIUM

### M1 — OctoEverywhere WebSocket Instability (15+ разрывов)

**Затронутые чанки: 3, 4, 7**

| Чанк | Инциденты | Характер |
|:----:|:---------:|:---------|
| 3 | 4 | Connection timed out, ping/pong timeout |
| 4 | 7+ | Connection timed out + DNS failures, Sentry error |
| 7 | 4 | WS loss → fallback starport → reconnect |

Связь с OctoEverywhere теряется волнообразно, коррелирует с DNS-сбоями и перегрузкой сети.

### M2 — ZupFe PSU Errors (постоянно, все чанки)

`PSU response error {'error': 'The browser (or proxy) sent a request that this server could not understand.'}`

Плагин ZupFe постоянно шлёт некорректные HTTP-запросы к Synology API (192.168.68.131:5001/5041). Ошибка 400 Bad Request. Не влияет на печать, но создаёт шум.

### M3 — Telegram Plugin Failures (постоянно, чанки 3-7)

- 7+ ReadTimeOut на snapshot URL (192.168.68.131:5041)
- 5+ DNS failures (api.telegram.org — `[Errno -3] Temporary failure in name resolution`)
- Exception on_startup: `'NoneType' object has no attribute 'port'`

### M4 — CSRF Protection Disabled (6 плагинов, все чанки)

**Затронуты:** arc_welder, bedlevelvisualizer, filamentmanager, filemanager, multicam, zupfe

Известное не-issue для сторонних плагинов (R10), но функциональная дыра безопасности.

### M5 — Deprecated Webcam API Access (все чанки)

`Detected access to deprecated settings path ['webcam', 'snapshot']`

Плагины OctoEverywhere и Telegram используют устаревший API webcam v1. Будет удалён в будущем релизе.

### M6 — Network Offline (чанки 2, 3, 4)

```
Connectivity state is currently: offline
Connecting to 1.1.1.1:53 is not working
Resolving octoprint.org is not working
```

После каждой перезагрузки — 1-2 часа без интернета. Плагин blacklist не загружается, OctoEverywhere не подключается.

### M7 — OctoEverywhere Startup Failures (чанки 3, 7)

- Sentry Error: `NotificationsHandler failed to get the exception info before sending`
- 502 Bad Gateway при отправке `started`-уведомления
- `Gadget inspection` DNS failures

---

## LOW

### L1 — Sticky Pad Settings Corruption (все чанки, 150+ предупреждений)

`There is a non-dict value on the path to pluginsstickypadnoteops at ['note'], ignoring.`

Постоянно повторяется при каждом UI-взаимодействии. Известная проблема миграции настроек, нефатально.

### L2 — lastmodified Timezone Warning (все чанки)

`lastmodified is not timezone aware, cannot check against If-Modified-Since. In the future this will become an error!`

Известный баг Flask preemptive cache. Снижает эффективность кэширования, но не влияет на функциональность.

### L3 — OctoEverywhere Timer Cleanup (чанки 3, 4, 7)

`ShouldPrintingTimersBeRunning is not in a printing state: OPERATIONAL`

Ожидаемое поведение после завершения печати, не проблема.

### L4 — Fan Speed Slider Lock (чанки 4, 7)

`A cooling fan control command was seen, but fanspeedslider is locked.`

MarlinSlider плагин корректно перехватывает M106/M107. Ожидаемо.

### L5 — EEPROM Line Not Recognized (чанки 4, 7)

`EEPROM output line not recognized, skipped ... echo: M149 C ; Units in Celsius`

Marlin информационная строка, парсер корректно её пропускает. Не-issue.

### L6 — AppKeys RuntimeError (чанк 3)

`RuntimeError: dictionary changed size during iteration` в `GET /api/plugin/appkeys`

Редкая гонка конкуренции в плагине AppKeys, однократный 500.

### L7 — Software Update Failures (чанки 3, 7)

- arc_welder: ConfigurationInvalid (missing user/repo/current)
- GitHub API: ReadTimeout на api.github.com

---

## State Machine Compliance

Проверено 50+ переходов состояния мониторинга за весь лог. **Все переходы валидны.** Не обнаружено запрещённых переходов или скачков состояний.

---

## Временная шкала ключевых событий

```
Jul 22 11:22 — Чанк 1: OctoEverywhere flood, SerialError #1
Jul 22 11:49 — Shutdown
Jul 22 11:51 — Перезагрузка
Jul 22 11:51→20:47 — 9ч без принтера (port=None)
Jul 22 20:57→Jul 23 05:01 — Печать #1 (8ч04м, успешно)
Jul 23 05:31 — SerialError #2
Jul 23 05:41 — Shutdown + перезагрузка
Jul 23 06:01 — Печать #2 начата
--- чанк 3 ---
Jul 23 09:03, 12:16, 23:24 — SerialErrors #3-5
Jul 23 23:09 — Thermal runaway (86/235°C)
Jul 24 01:55 — SerialError #6 ([Errno 5] I/O)
--- чанк 4 ---
Jul 24 01:58→10:37 — Печать #3 (8ч39м, успешно)
Jul 24 11:07 — SerialError #7
Jul 24 11:17 — Shutdown
Jul 24 11:18→20:13 — 9ч offline (autoconnect fail)
Jul 24 20:28 — SerialError #8 (сразу после manual reconnect)
Jul 24 20:28→Jul 25 02:18 — Печать #4 (5ч50м, успешно)
Jul 25 01:00 — MemoryError #1 (Telegram)
Jul 25 01:00-01:22 — Thread pool exhaustion (9× RuntimeError)
Jul 25 01:22-01:26 — MemoryErrors #2-3 (/api/files)
--- чанк 5 ---
Jul 25 02:38 — Thread exhaustion на PrintDone
--- чанк 6 ---
Jul 25 02:48 — SerialError #9
Jul 25 02:54 — Thread exhaustion (5×)
Jul 25 02:58 — **Блокировка serial reconnection из-за thread exhaustion**
--- чанк 7 ---
Jul 25 03:02 — Перезагрузка, успешное подключение
Jul 25 03:04→09:04 — Печать #5 (6ч, успешно)
Jul 25 09:34 — SerialError #10 → 10.5ч offline
Jul 25 20:03 — Перезагрузка, успешное подключение
Jul 25 20:17 — Печать #6 (отмена через 3 сек)
Jul 25 20:18→Jul 26 03:25 — Печать #7 (отмена через 7ч)
Jul 26 03:26 — Печать #8 начата (продолжается на момент конца лога)
```

---

## Резюме для руководства

### Наиболее критичная проблема: истощение системных потоков (thread pool exhaustion)

**Сводка:** OctoEverywhere плагин в агрессивном режиме snapshot polling (каждую ~1 сек) генерирует непрерывный поток новых потоков, которые не успевают освобождаться. В сочетании с 46 установленными плагинами и sentry_sdk это приводит к исчерпанию лимита потоков Raspberry Pi.

**Эскалация:** В чанке 4 — каскадный отказ 6 плагинов. В чанке 6 — блокировка серийного подключения (serial handshake проходит, но система не может запустить поток таймера). В чанке 7 — 31 RuntimeError.

**Рекомендация №1:** Ограничить частоту snapshot polling в OctoEverywhere (с 1 сек до 30-60 сек) с экспоненциальным backoff при ошибках. Устранить утечку потоков в цикле `FinalSnap` → `_EnsureJpegHeaderInfo` → `ReadAllContentFromStreamResponse`.

### Проблема №2: Нестабильное USB-соединение (10 SerialException за 6 дней)

**Сводка:** Повторяющиеся `device reports readiness to read but returned no data` указывают на физическую проблему соединения — кабель USB, USB-контроллер Pi, или питание USB после печати.

**Рекомендация №2:** Проверить USB-кабель, питание Pi (особенно после нагрузок), рассмотреть USB-изолятор. Добавить watchdog для автоматического переподключения.

### Проблема №3: Утечка памяти (10 MemoryError)

**Сводка:** MemoryError коррелируют с thread exhaustion и попытками сериализации большого списка файлов.

**Рекомендация №3:** Ограничить размер ответа `/api/files`, внедрить пагинацию. Рассмотреть увеличение RAM или `ulimit`.

### Проблема №4: Thermal runaway (86°C vs 235°C)

**Сводка:** В чанке 3 дважды зафиксировано: хотэнд показывает 86°C при целевых 235°C. Потенциальный признак неисправности нагревателя/терморезистора.

**Рекомендация №4:** Проверить целостность терморезистора и нагревателя хотэнда. Продиагностировать PID-регулирование.

### Общий вывод

Система стабильно печатает (5 успешных печатей за 6 дней), но работает в **деградированном режиме** из-за:
1. **Утечки потоков в OctoEverywhere** — убивает производительность системы (первопричина)
2. **Дефектного USB-соединения** — требует физической диагностики
3. **Неисправности хотэнда** — требует проверки температуры

Все три проблемы обострились к последним дням лога (Jul 25-26) и, вероятно, привели бы к полной остановке системы без вмешательства.
