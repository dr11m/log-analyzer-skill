# Отчёт интеллектуального анализа логов

## Параметры анализа
- **Файл:** `logs/octoprint-systeminfo-20240726035924/octoprint.log` (5.20 MB, 37836 строк)
- **Проанализировано:** 100% файла, 50+ grep-паттернов
- **Источник паттернов:** 829 вызовов логгера в 263 модулях
- **Фреймворк/язык:** Python `logging` (stdlib), формат: `timestamp - logger_name - LEVEL - message`
- **Временной диапазон:** 2024-07-20 10:11:39 — 2024-07-26 03:59:20 (~6 дней работы)

## Сводка проекта
OctoPrint — веб-интерфейс для управления 3D-принтерами (Python, Flask + Tornado). Лог снят с Raspberry Pi, запущенного с 30+ установленными плагинами (OctoEverywhere, Telegram, Zupfe, ArcWelder, Dashboard и др.).

## Общая статистика лога

| Уровень | Всего | octoeverywhere | Остальные |
|---------|-------|----------------|-----------|
| INFO    | 18420 | 14114          | ~4306     |
| WARNING | 7011  | 6113           | ~898      |
| ERROR   | 6506  | 6115           | ~391      |
| **Итого** | **37937** | **26342** (69.4%) | **~5595** |

**Вывод:** 69.4% всех записей лога генерируются одним плагином — OctoEverywhere.

## Карта покрытия

| Модуль | Вызовов логгера в коде | Найдено в логе | Ключевые паттерны |
|--------|----------------------|----------------|-------------------|
| `octoprint.plugins.octoeverywhere` | ~50+ | 26342 | Подключения, WS errors, Gadget, FinalSnap |
| `octoprint.settings` | ~30+ | ~635 | DeprecationWarnings, stickypad errors |
| `octoprint.server` | ~80+ | ~443 | Старт/стоп, heartbeat, CSRF warnings |
| `octoprint.access.users` | ~15+ | ~517 | Логин/логаут сессий |
| `octoprint.server.util.sockjs` | ~25+ | ~486 | WebSocket подключения |
| `octoprint.util.comm` | ~120+ | ~416 | Serial, print jobs |
| `octoprint.plugins.tracking` | ~5+ | ~425 | Tracking events |
| `octoprint.server.heartbeat` | ~3+ | ~334 | Heartbeat |
| `octoprint.server.util.flask` | ~30+ | ~268 | Flask middleware, логины |
| `octoprint.plugins.softwareupdate` | ~60+ | ~114 | Ошибки проверки обновлений |
| `octoprint.plugins.telegram` | ~30+ | ~93 | Ошибки Telegram API |
| `octoprint.plugins.zupfe` | ~10+ | ~174 | Webcam, websocket errors |
| Другие | ~400+ | ~500+ | Разное |

## Проблемы и ошибки

---

### CRITICAL

#### 1. OctoEverywhere: хроническая нестабильность сетевого соединения
- **Источник:** `octoprint.plugins.octoeverywhere` — плагин удалённого доступа
- **В логе:** 6115 ERROR + 6113 WARNING + 14114 INFO = 26342 строк (69.4% всего лога)
- **Кластеры:** Постоянные обрывы и переподключения на всём протяжении 6 дней
- **Доказательство:**
  ```
  41 попыток подключения → 37 успешных → 29 отключений
  29 WebSocket errors (ping/pong timeout, connection refused, DNS fail)
  10 Failed to send gadget inspection  
  5947 FinalSnap вызовов
  ```
- **Гипотеза:** Нестабильное интернет-соединение на Raspberry Pi (DNS failures: `Temporary failure in name resolution`, `No route to host`, `Connection refused`). OctoEverywhere пытается реконнектиться с exponential backoff, но цикл «disconnect → sleep → reconnect → disconnect» не прекращается. Плагин генерирует ~4400 строк лога в день только от себя.
- **Влияние:** Удалённый доступ через OctoEverywhere практически не работает. Лог переполнен шумом — 69% всех записей неинформативны. Затруднён мониторинг других проблем.
- **Рекомендация:**
  1. Проверить сетевое подключение Raspberry Pi (DNS resolver, маршрутизация)
  2. Настроить статический DNS (8.8.8.8, 1.1.1.1) в `/etc/resolv.conf`
  3. Рассмотреть отключение OctoEverywhere, если удалённый доступ не критичен
  4. Обновить плагин до последней версии (возможны улучшения reconnect logic)

#### 2. Telegram Plugin: полная потеря связи с Telegram API
- **Источник:** `octoprint.plugins.telegram`
- **В логе:** ~93 строки (включая listener, TMSG), повторяющиеся ошибки на протяжении 6 дней
- **Кластеры:** Каждые ~2 минуты — ошибка и повторная попытка
- **Доказательство:**
  ```
  Exception on_startup: 'NoneType' object has no attribute 'port'
  TimeOut Exception: HTTPConnectionPool(host='192.168.68.131', port=5041): Read timed out  
  Setting status: Got an exception while trying to connect to telegram API: ...
    ... Temporary failure in name resolution
    ... Network is unreachable
    ... ConnectionResetError(104, 'Connection reset by peer')
  Setting status: Telegram API responded with code 502
  ```
- **Гипотеза:** Двойная проблема: (1) общая сетевая недоступность API Telegram из-за проблем с DNS/маршрутизацией; (2) ошибочная конфигурация — `on_startup` падает с `AttributeError: 'NoneType' object has no attribute 'port'`, что указывает на неинициализированный объект порта/вебкамеры.
- **Влияние:** Telegram-уведомления о печати не работают полностью.
- **Рекомендация:**
  1. Исправить `on_startup` exception — проверить конфигурацию плагина Telegram (возможно, не указан webcam port)
  2. Решить проблему с DNS/сетью (см. рекомендацию по OctoEverywhere)
  3. Проверить, не блокируется ли api.telegram.org файрволом или провайдером

#### 3. Ошибки последовательного порта (Serial Communication)
- **Источник:** `octoprint.util.comm` (строки 294-36737)
- **В логе:** 26 ERROR (13 чтение, 1 запись, 5 crash, 12 ссылок на FAQ)
- **Временные метки:** 20-25 июля, многократно
- **Доказательство:**
  ```
  2024-07-20 10:53:10 - Unexpected error while reading from serial port
  2024-07-20 10:53:11 - Please see https://faq.octoprint.org/serialerror
  2024-07-22 04:31:06 - Unexpected error while reading from serial port
  2024-07-22 04:41:45 - Something crashed inside the serial connection loop, please report this in OctoPrint's bug tracker:
  ```
- **Гипотеза:** Нестабильное USB-соединение с принтером. Ошибка `Something crashed inside the serial connection loop` + 5 трейсов за 10 минут 22 июля указывают на серьёзный сбой драйвера или проблемы с USB-кабелем/контактом.
- **Влияние:** Прерывание печати, потеря связи с принтером. Потенциальная порча текущей печати.
- **Рекомендация:**
  1. Проверить USB-кабель и контакты
  2. Проверить dmesg на наличие USB-ошибок
  3. Снизить скорость serial (baudrate) до 115200 или 250000
  4. Рассмотреть использование ферритового фильтра на USB-кабеле

#### 4. Software Update: массовые ошибки проверки обновлений
- **Источник:** `octoprint.plugins.softwareupdate`
- **В логе:** 114 ERROR — `Could not check <plugin> for updates`
- **Затронуты:** 28+ плагинов (octoprint, arc_welder, dashboard, telegram, zupfe, и др.)
- **Временные метки:** Равномерно распределены по всему периоду
- **Гипотеза:** Прямое следствие проблем с сетью — плагин не может достучаться до репозиториев GitHub, PyPI и т.д.
- **Влияние:** Невозможно обновить плагины. Пользователь не получает уведомлений о новых версиях.
- **Рекомендация:** Решить проблему с сетью (см. CRITICAL #1)

---

### MEDIUM

#### 1. Settings: DeprecationWarning — устаревшая конфигурация webcam
- **Источник:** `octoprint.settings:775`
- **В логе:** 4 WARNING
  ```
  DeprecationWarning: Detected access to deprecated settings path ['webcam', 'snapshot']
  DeprecationWarning: Detected access to deprecated settings path ['webcam', 'stream']
  ```
- **Влияние:** Настройки вебкамеры используют устаревший API. В OctoPrint 1.9.0+ введена новая система webcams. Совместимость будет удалена в будущем релизе.
- **Рекомендация:** Перенастроить вебкамеру через новый Webcam UI в настройках OctoPrint

#### 2. Settings: Некорректные данные плагина stickypad
- **Источник:** `octoprint.settings:1835`
- **В логе:** 3 WARNING
  ```
  There is a non-dict value on the path to plugins\tickypad\tnote\tops at ['note'], ignoring
  There is a non-dict value on the path to plugins\tickypad\tnote\tops at ['plugins', 'stickypad', 'note'], ignoring
  ```
- **Влияние:** Конфигурация плагина stickypad повреждена — значение по пути `note` не является словарём. Функциональность заметок может быть нарушена.
- **Рекомендация:** Проверить/перенастроить плагин stickypad через интерфейс OctoPrint

#### 3. CSRF Protection для 6 плагинов
- **Источник:** `octoprint.server:1104,2809,2846`
- **В логе:** 6 WARNING
  ```
  CSRF Protection for Blueprint of plugin arc_welder
  CSRF Protection for Blueprint of plugin bedlevelvisualizer
  CSRF Protection for Blueprint of plugin filamentmanager
  CSRF Protection for Blueprint of plugin filemanager
  CSRF Protection for Blueprint of plugin multicam
  CSRF Protection for Blueprint of plugin zupfe
  ```
- **Влияние:** Эти плагины используют устаревший шаблон Blueprint без CSRF-защиты. Потенциальная уязвимость.
- **Рекомендация:** Обновить указанные плагины до версий с поддержкой CSRF

#### 4. zupfe: Webcam ошибки
- **Источник:** `octoprint.plugins.zupfe`
- **В логе:** 8 ERROR
  ```
  /webcam/?action=stream
  http://192.168.68.131:5041/webapi/entry.cgi?api=SYNO.SurveillanceStation...
  PSU response error {'error': 'The browser (or proxy) sent a request that this server could not understand.'}
  Websocket closed: Connection to remote host was lost.
  ```
- **Влияние:** Zupfe (мониторинг принтера) не может получить изображение с вебкамеры (URL на Synology Surveillance Station не отвечает корректно)
- **Рекомендация:** Проверить доступность Synology Surveillance Station по указанному URL

#### 5. Frontend JavaScript Error
- **Источник:** `octoprint.server.views`
- **В логе:**
  ```
  Message: ResizeObserver loop completed with undelivered notifications.
  URL: https://192.168.68.148/?#tab_plugin_dashboard
  ```
- **Влияние:** Косметическая проблема в dashboard plugin, не влияет на функциональность
- **Рекомендация:** Обновить dashboard plugin до последней версии

#### 6. EEPROM Marlín: нераспознанная строка
- **Источник:** `octoprint.plugins.eeprom_marlin`
- **В логе:**
  ```
  EEPROM output line not recognized, skipping
  Line: echo:  M149 C ; Units in Celsius
  ```
- **Влияние:** Плагин EEPROM не может прочитать прошивку принтера (ожидает EEPROM dump, а получает ответ M149 C). Не критично, но функциональность EEPROM editor может быть ограничена.
- **Рекомендация:** Убедиться, что принтер поддерживает команды EEPROM, или обновить плагин

---

### LOW

- **WebSocket connection errors:** 4 записи `Connection to remote host was lost` / `ping/pong timed out` — следствие общих сетевых проблем
- **Server heartbeat:** 334 heartbeat-записей — нормальное поведение системы
- **Sentry Error в OctoEverywhere:** `Failed to extract exception stack in sentry before send` — плагин не может отправить краш-репорт в Sentry из-за отсутствия сети
- **Плагин PiSupport:** `Error calling SimpleApiPlugin pi_support` — проблема с вызовом API плагина, возможно из-за сети
- **Endpoint Exception:** `Exception on /api/connection [POST]`, `Exception on /api/files [GET]` — единичные ошибки API

## Числовые метрики во времени

| Метрика | Источник | Записей | Min | Max | Среднее | Тренд |
|---------|----------|---------|-----|-----|---------|-------|
| Slipstream cache update time | octoeverywhere | 12 | 20.56s | 31.73s | ~24.4s | Стабильный |
| FinalSnap calls | octoeverywhere | 5947 | — | — | ~990/день | Стабильный |
| OctoEverywhere reconnect sleep | octoeverywhere | 29 | 3s | 27s | ~11s | Exponential backoff |
| Serial errors | octoprint.util.comm | 26 | — | — | ~4/день | Скачкообразный |
| Software update check fails | softwareupdate | 114 | — | — | ~19/день | Стабильный |

## Молчащие компоненты

| Модуль | Вызовов логгера | Возможная причина |
|--------|----------------|-------------------|
| `octoprint.plugins.virtual_printer` | ~10 | Не используется (виртуальный принтер отключён) |
| `octoprint.plugins.debug` | ~5 | Плагин отладки не активирован |
| `octoprint.plugins.gcodeviewer` | ~1 | GCode viewer не использовался |
| `octoprint.slicing` | ~5 | Слайсер не вызывался (печать готовых gcode) |

## Агрегированная статистика
- **Вызовов логгера в коде:** 829
- **Просканировано модулей:** 263 .py файла
- **Просканировано строк лога:** 37836
- **Паттернов с совпадениями:** ~50 (ключевых)
- **Всего совпадений в логе:** 37937
- **Доминирующий источник:** `octoprint.plugins.octoeverywhere` — 69.4% (26342 строк)
- **Активных модулей в логе:** 25+ из 263

## Выводы

### Основная проблема: СЕТЬ
Корневая причина практически всех CRITICAL и MEDIUM проблем — **нестабильное интернет-соединение Raspberry Pi**. DNS resolution постоянно даёт сбои (`Temporary failure in name resolution`), что приводит к:

1. **OctoEverywhere** — полная неработоспособность удалённого доступа
2. **Telegram** — невозможность отправки уведомлений
3. **Software Update** — невозможность проверки обновлений
4. **Вторичные эффекты** — ошибки плагинов, зависимых от сети

### Второстепенная проблема: Serial connection
Нестабильное USB-соединение с принтером — потенциальная угроза для текущих печатей.

### Рекомендованный порядок действий:
1. **Приоритет 1:** Восстановить сетевое подключение Raspberry Pi (DNS, маршрутизация)
2. **Приоритет 2:** Диагностировать USB/serial соединение с принтером
3. **Приоритет 3:** Обновить конфигурацию webcam через новый UI (убрать deprecation warnings)
4. **Приоритет 4:** Исправить конфигурацию плагина Telegram (on_startup error)
5. **Приоритет 5:** Обновить плагины с CSRF warnings
6. **Приоритет 6:** Исправить повреждённую конфигурацию stickypad
