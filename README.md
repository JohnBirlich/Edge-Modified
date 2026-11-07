# Edge-Modified — Edge Control Center

**v2.0.0 "MONOLITH" — один самодостаточный EXE: скачал → запустил → пользуешься.**

```text
dist/EdgeControlCenter-2.0.0.exe   ← ВСЁ внутри: движок + UI + стоковый Cfg.ini
```

Запуск: двойной клик → откроется консоль со статусом и панель в браузере
(`http://127.0.0.1:3327`). Никаких зависимостей, установки и распаковок.
Данные живут в `%APPDATA%\EdgeControlCenter` (переживают переезды EXE).
Переменные: `PORT`, `ECC_NO_BROWSER=1`, `ECC_DATA`.
Admin: `hasberd` / `ardor-3327` → сменить пароль при первом входе.

Модифицированный софт для ARDOR GAMING Edge 3327 (750 Вт · 16 ГБ · GPT/UEFI ·
Windows+Linux · мышь PAW-3327). Стоковые бинарники `OemDrv.exe` не тронуты.

## What's inside

| Module | Highlights |
|---|---|
| **Device — 3327** | DPI stages + per-stage RGB, debounce/LOD registers, 5 tuning profiles, **hidden-module unlock bank** (Gun ballistics, diagnostics report, LOD, angle-snap, shutter), stock-compatible `Cfg.ini` export |
| **Power delivery** | 750 W PSU telemetry — wall draw, 80+ Gold efficiency curve, rail distribution, ATX 3.x transient budget, guarded PL1/PL2, energy cost |
| **Memory** | 16 GB envelope, DIMM/XMP-EXPO report + BIOS change sheet, kernel latency tunables + presets, paging/zram advisor |
| **Storage / GPT** | GPT type-GUID partition view, Secure Boot + efibootmgr, ESP audit, dual-boot NTFS3 mount planner |
| **Network** | ping/DNS-matrix/TCP/TTFB/bufferbloat, flow inspector (DPI-lite), QoS packet-prioritization generators |
| **Bridge W↔L** | EBP/1.0: discovery → pairing → telemetry mirroring + chunked file transfer + peripheral control |
| **Stability** | bugcheck KB + minidump triage + ranked root causes + recovery bundles + kernel watch |
| **AI Studio** | fully local generation (ComfyUI/A1111 adapters, queue, gallery, VRAM guard) — SIM renderer in sandbox |
| **Thermal** | EWMA+trend prediction, time-to-throttle, load-class AI policy, adaptive/acoustic/manual fan curves |
| **Admin (`hasberd`)** | elevation, audit journal, macro scripting, restore anchors, privileged-path overview |

Every metric is badged **LIVE / MODEL / SIM** — no silent fabrication; privileged actions are
session-gated, journaled, and anchored to a restore point.

## Run

```bash
# zero npm dependencies, Node ≥ 18
node control-center/server.js        # → http://0.0.0.0:3327
```

Admin: user `hasberd`, default passphrase `ardor-3327` — **rotate it** after first login.

## Deploy (production)

```powershell
# Windows (elevated) — creates a mandatory system restore point first
installer\install.ps1
```
```bash
# Linux (sudo) — timeshift/btrfs snapshot first
sudo ./installer/install.sh
```

Bridge the other OS:
```bash
python3 agent/edge-agent.py pair <control-center-host> 3327
python3 agent/edge-agent.py run <control-center-host> 3327
```

## Repository layout

```
Cfg.ini, OemDrv.exe, …   stock ARDOR GAMING Edge 3327 suite (unmodified, still fully usable)
control-center/          ECC core (Node, zero deps) + modular dark UI
agent/edge-agent.py      EBP/1.0 cross-platform agent
installer/               install/uninstall/update (Windows + Linux)
profiles/                runtime config plane + exports
docs/                    DESIGN.md · PROTOCOL.md · RELEASE_CHECKLIST.md
```

**Docs:** [DESIGN.md](docs/DESIGN.md) — full architecture, hardware models, rollout plan ·
[PROTOCOL.md](docs/PROTOCOL.md) — bridge spec · [RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md).

See [CHANGELOG.md](CHANGELOG.md) for release notes.
