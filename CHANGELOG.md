# Changelog

## v2.1.2 — "NATIVE" (hotfix-2, 2026-11-07)

По журналу с машины оператора найдена точная причина краха движка и устранена.

### Root cause (по трейсу `node::InitializeOncePerProcess` + кадры OpenSSL)
Лаунчер передавал движку самодельный env-блок только с `PORT=`. У ребёнка не было
`SystemRoot`/`PATH` — инициализация OpenSSL в Node падала при старте (код 0x86,
кадры `AES_cbc_encrypt` в журнале — классическая ловушка CreateProcess на Windows).

### Fixed
* Движок теперь **наследует полное окружение** родителя (lpEnvironment = NULL),
  `PORT` выставляется в собственное окружение лаунчера до CreateProcess.
* Порт в статус-строке теперь реальный (после авто-выбора свободного).
* На карточке сбоя — подсказка про исключения Defender для папки движка.

---

## v2.1.1 — "NATIVE" (hotfix, 2026-11-07)


Исправления по итогам первого запуска у оператора (окно работало, движок не стартовал):

### Fixed
* **Экран диагностики вместо немого отказа**: журнал движка (stdout/stderr →
  `%LOCALAPPDATA%\EdgeControlCenter\engine.log`) рисуется прямо в окне; причины видны сразу.
* **Кнопки восстановления на экране сбоя**: «↻ Перезапустить движок», «Журнал (блокнот)»,
  «Открыть папку» (папка движка в %LOCALAPPDATA%).
* **Авто-выбор свободного порта**: приложение находит свободный порт и передаёт его движку
  (больше нельзя «успешно запуститься и умереть» из-за занятого 3327); сервер также
  самостоятельно отступает на +1…+20 порт при EADDRINUSE и пишет `port.txt`.
* **«Усыновление» живого движка**: если движок уже работает (например, от прошлого
  зависшего сеанса) — приложение подключается к нему, не запуская второй.
* **Код завершения** движка показывается в статусе; один автоматический перезапуск при
  падении уже работавшего движка.
* **Переиспользование распакованного движка** (по точному размеру): не падает, если файл
  заблокирован антивирусом — сначала попытка удалить, затем переиспользование.
* **Исправлен слой отрисовки**: контент страниц рисуется в области контента (раньше
  карточки могли перекрывать левое меню).
* Фатальные ошибки движка пишутся в `engine-error.log` (в каталоге данных) до выхода.

---

## v2.1.0 — "NATIVE" (2026-11-07)


**Настоящее нативное приложение: весь интерфейс — чистый Win32/GDI. Без браузера.**

### Added
* **Нативный UI** (`launcher/edge-native.c`, ~1000 строк C): левое меню модулей, тёмные
  страницы, собственные слайдеры/переключатели/карточки, графики-спарклайны, круговые
  шкалы, статусная строка, трей. Окно — обычное десктопное, шрифт Segoe UI, иконка ARDOR.
* **Line-протокол для нативного клиента**: `GET /api/native/state` (все метрики одним
  ответом) и `POST /api/native/action` (login/unlock/key/profile/pl/thermal/ping/dns/
  analyze/ai/audit/snapshot) — серверная часть в `server.js`.
* **Один EXE**: `[нативный GUI][движок][u64 len][ECCNATIVE1]` — при первом запуске движок
  распаковывается в `%LOCALAPPDATA%\EdgeControlCenter\` и стартует скрыто (CREATE_NO_WINDOW).
* Модули в нативном UI: Обзор (KPI + истории), Мышь 3327 (unlock-тумблеры, DPI, дебаунс,
  LOD, профили, экспорт), Питание (шкалы + PL1/PL2 слайдеры), Термал (график, риск,
  политика), Сеть (ping/DNS-гонка), Стабильность (анализ stop-кодов), ИИ-студия
  (генерация, очередь), Админ (вход, аудит, restore-якорь).
* Веб-панель сохранена как опция (кнопка в шапке) — галерея и расширенные инструменты.

### Verified
* Нативный API end-to-end: state · login→token · unlock · profile (DPI применился) ·
  pl · ping · analyze (0x124 → причины/действия) · thermal · ai · audit.
* PE: x64, subsystem=GUI, трейлер ECCNATIVE1, движок внутри с собственным VFS-трейлером.

---

## v2.0.0 — "MONOLITH" (2026-11-07)


**Один самодостаточный EXE: скачал → запустил → пользуешься.**

### Added
* **Single-file EXE** (`EdgeControlCenter-2.0.0.exe`, ~83 МБ): движок (Node.js 22.22.3, SEA),
  весь UI, стоковый `Cfg.ini` и `VERSION.json` встроены в бинарник через embedded-VFS
  (полезная нагрузка в PE-оверлее, трейлер `ECC2EMBED_V200__`).
* **Embedded VFS + fs-шим** в загрузчике (`control-center/sea/sea-bootstrap.js`):
  чтение модулей/статики/конфига из собственного EXE; все записи рядом с EXE
  перенаправляются в каталог данных пользователя.
* **Портативные данные**: `%APPDATA%\EdgeControlCenter`
  (Linux: `~/.local/share/EdgeControlCenter`) — аудит, профили, экспорты и галерея
  переживают перезапуски и переезды EXE.
* Автооткрытие панели в браузере при старте (`ECC_NO_BROWSER=1` отключает).
* Смоук-тест той же механики на хост-платформе прямо в сборке
  (`installer/build-singlefile.sh`): state/UI/static/config из embedded-payload.
* `tools/make-payload.py` — сборщик полезной нагрузки (индекс + оффсеты + магия).

### Changed
* Версия 2.0.0, кодовое имя MONOLITH; баннер печатает версию из встроенного манифеста.
* Дистрибутив: `dist/EdgeControlCenter-2.0.0.exe` — один файл вместо архивов
  (оконный лаунчер остаётся в исходниках: `launcher/edge-launcher.c`, `installer/build-app.sh`).

### Verified (same mechanics, host platform)
state/UI/static/config из embedded payload · auth + unlock · export в data-dir ·
персистентность unlock между запусками · AI SIM job · SSE-поток.

---

## v1.0.0 — "IGNITION" (2026-11-07)


Initial release of the **Edge Control Center** for the ARDOR GAMING Edge 3327 platform.

### Added
* **Config plane** — round-trip-safe `Cfg.ini` parser/writer (byte-identical on untouched keys);
  DPI stage + per-stage RGB editors; debounce/LOD/register panel; stock-app-compatible export.
* **Hidden-module unlock bank** — activates the five modules the stock binary ships but keeps
  disabled: Ballistics/Gun suite, Diagnostics report, LOD control, Angle-snap adjust, Shutter/symmetry.
* **Power delivery** — 750 W PSU model (80+ Gold calibrated efficiency curve), live wall draw,
  rail distribution, ATX 3.x transient budget, guarded PL1/PL2 editor, energy economics.
* **Memory profiling** — 16 GB envelope, DIMM/SPD report, XMP/EXPO detection + BIOS change sheet,
  kernel latency tunables with Gaming/Balanced/Compile presets, zram/swap sizing.
* **Storage / GPT** — block tree with GPT type-GUID decoding, Secure Boot + `efibootmgr` view,
  ESP audit, dual-boot-safe NTFS3 mount planner.
* **Network suite** — ping/DNS-matrix/TCP/TTFB/bufferbloat probes, flow inspector (DPI-lite),
  QoS packet-prioritization script generator (esports/streaming/latency-first/balanced).
* **EBP/1.0 bridge** — UDP discovery, token pairing, heartbeat mirroring, 4 MiB chunked file
  transfer with SHA-256 + resume; cross-platform agent (`agent/edge-agent.py`).
* **Stability suite** — bugcheck knowledge base, minidump header triage, ranked root-cause
  hypotheses tied to the hardware profile, automated recovery bundles, kernel watch, incident log.
* **Forge Studio (AI)** — fully local image generation via ComfyUI/A1111 adapters with queue +
  gallery; deterministic SIM renderer when no backend; VRAM budget guard. No cloud egress.
* **Predictive thermal** — EWMA+trend forecasting, time-to-throttle, load-class classifier
  (idle/game/compile/render), adaptive/acoustic/manual fan policies with dispatch hooks.
* **Admin dashboard** — `hasberd` elevation (scrypt, sessions, forced rotation of default),
  audit journal, macro scripting (dry-run sandbox), restore anchors, system/privileged-path view.
* **Deployment** — Windows + Linux installers with mandatory restore points, systemd/scheduled-task
  registration, staged-rollout updater with health-probe rollback, uninstallers.
* **Docs** — DESIGN.md (full architecture & rollout plan), PROTOCOL.md (EBP/1.0),
  RELEASE_CHECKLIST.md.

### Release artifacts (v1.0.0, updated)
* `dist/edge-control-center-1.0.0.zip` — portable source bundle (Node ≥ 18 required)
* `dist/EdgeControlCenter-1.0.0-win64.zip` — **ready-to-run Windows EXE**: `EdgeControlCenter.exe`
  (Node.js SEA, runtime 22.22.3 embedded, ~87 MB) + `app/` + stock `Cfg.ini` + RU README +
  `Start-ECC.cmd` fallback launcher. Build recipe: `installer/build-exe.sh`; bootstrap loader:
  `control-center/sea/sea-bootstrap.js`. Same-blob smoke-tested end-to-end (state/UI/config/auth/SSE)
  on the identical Node version before injection.

### v1.0.0-r2 — native desktop APP (Windows)
* **`dist/EdgeControlCenter-1.0.0-win64-APP.zip`** — полноценное оконное приложение:
  `EdgeControlCenterApp.exe` — нативный Win32 GUI-лаунчер (тёмное окно, иконка ARDOR, трей,
  без консоли; скомпилирован `zig cc` из `launcher/edge-launcher.c`, иконка/версия — `resedit`)
  + скрытый движок `ecc-engine.exe` (Node SEA) + панель в отдельном окне приложения
  (Edge/Chrome `--app`, фолбэки: chrome → браузер по умолчанию).
* Portable-архив предыдущего формата заменён APP-бандлом; `Start-ECC.cmd` сохранён как fallback.
* Сборка воспроизводится: `installer/build-app.sh`.
