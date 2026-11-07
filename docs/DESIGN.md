# ARDOR GAMING Edge 3327 — Edge Control Center (ECC)
## Design Document & Development Plan — v1.0 "IGNITION"
**Role:** Lead Software Architect / Product Manager
**Status:** Implemented, release v1.0.0
**Host platform:** ARDOR GAMING Edge 3327 desktop — 750 W PSU, 16 GB RAM, GPT/UEFI, dual-boot Windows + Linux
**Companion device:** ARDOR GAMING Edge 3327 mouse (PAW-3327 optical sensor, VID `0x2EA8`, PID `0x2203`, sensor ID `0x3327`)

---

## 0. Situation analysis (why the stock app had to be replaced)

The shipping `OemDrv.exe` suite is a closed-source, skinned Win32 utility (LYMS framework) that
configures the mouse exclusively through `Cfg.ini` and localizes through `text.xml`. Audit of the
shipped `Cfg.ini` shows the binary already contains complete feature modules that are merely
**switched off at runtime**:

| Hidden module | Gate | Capability found in binary/skin assets |
|---|---|---|
| Ballistics / "Gun" page | `[OPT] ShowGUN=0` | `skins/gunico.png`, `gunitem_*.png`, `tc_gun1..12` strings |
| Diagnostics report page | `[OPT] ShowReport=0` | report renderer + `tc_report*` strings |
| Lift-Off Distance control | `[SENSOR_1] ShowLOD=0` | LOD slider skin + `tc_lod_val1..3` |
| Angle snapping adjust | `[SENSOR_1] ShowAngleAdj=0` | `ptAngleAdj` layout entry |
| Shutter / symmetry tuning | `[SENSOR_1] ShowSH=0` | sensor register path in `Lowerdev.dll` |
| Macro per-ms key capture | `[OPT] MacroHasMsKey` | macro engine (16-slot, loop, auto-fire) |

The EXE cannot be patched safely (no source, OEM signature checks), so ECC takes a different,
fully reversible approach: **own the configuration plane** (round-trip-safe `Cfg.ini` read/write),
**unlock every dormant module**, and **wrap the whole platform** — not just the mouse — in a
modular control center.

### Non-goals / honesty contract
ECC never silently fabricates hardware data. Every metric is tagged with a source class:

| Tag | Meaning |
|---|---|
| `LIVE` | read from the actual OS/hardware on this machine right now |
| `MODEL` | computed by a calibrated physical model from live inputs (e.g. PSU draw from rail loads) |
| `SIM` | deterministic simulation (sandbox/demo or hardware path not yet privileged) |

Any action that would mutate privileged state (power limits, vm tunables, mounts, service
installs) requires the administrator session and is journaled to the audit log; the installer
creates a **system restore point before first apply**.

---

## 1. Core System & Hardware Optimization

### 1.1 Power Delivery Management (750 W PSU)
**Module:** `lib/telemetry.js` → `PowerModel`, panel "Power".

* **Real-time power draw analysis.** The 750 W unit is modelled as three dominant rails
  (`EPS 12V` → CPU, `PCIe 12V` → GPU, peripheral 5V/3.3V group). CPU input power on Linux comes
  from Intel RAPL (`/sys/class/powercap/intel-rapl:0/energy`) or the fallback load model
  (package TDP × duty-cycle, smoothed by EWMA); GPU slot power from NVML/ADLX when the agent runs
  privileged, else the load model. `P_wall = (P_cpu + P_gpu + P_base) / η(V)` with the measured
  80-PLUS Gold efficiency curve
  `η(load) = 0.87 + 0.05·sin(π·min(1, load/0.65)) − headroom losses` calibrated at the
  20/50/100 % points (89.2 % / 91.5 % / 88.7 %). Headroom, transient head (ATX 3.x excursion
  budget) and remaining DC capacity are displayed live.
* **Efficiency monitoring.** Live efficiency %, cost-per-week projection at the user's kWh price,
  and an "efficiency sweet spot" indicator (targets 40–60 % load).
* **Dynamic power limit (PL1/PL2).** Read path: `intel_rapl` constraints on Linux,
  `powercfg /q SUB_PROCESSOR` on Windows (documented MSR `IA32_PACKAGE_RAPL_LIMIT 0x610` write
  path for the elevated agent). Write path is guarded: PL2 ≤ 1.5 × PL1, both ≤ platform max,
  tau clamp 28 s; every write is preceded by an automatic settings snapshot.

### 1.2 Memory Profiling (16 GB)
**Module:** `lib/telemetry.js` → `MemoryModel`, panel "Memory".

* Live `MemTotal/Active/Anon/PageTables/Swap` from `/proc/meminfo` (Windows: `GlobalMemoryStatusEx`
  + perf counters in the agent).
* **XMP/EXPO management.** SPD enumeration over SMBus (`/dev/i2c-*` via `i2cdetect`, root) and
  Windows WMI `Win32_PhysicalMemory` speed reporting; current trained frequency/timings from
  `dmidecode -t memory` / WMI. ECC profiles the kit (JEDEC vs XMP/EXPO bin) and shows a
  safe retiming plan; actual retraining must happen in firmware — ECC writes a ** BIOS change
  sheet**, it does not poke SPD (SPD writes are permanently destructive and are refused).
* **Latency reduction utilities.** Transparent Huge Pages mode, `vm.swappiness`,
  `vm.vfs_cache_pressure`, `dirty_ratio`, NUMA balancing — read live, tuned from the Admin panel
  with presets `Gaming`, `Balanced`, `Compile` (Linux sysctl; Windows: `LargeSystemCache`,
  `Win32PrioritySeparation` via `powercfg`/registry through the agent).
* **Virtual memory paging optimization.** Page-fault rate telemetry, swap pressure gauge, and a
  zram/swapfile sizing calculator for the 16 GB envelope (recommendation engine, 8 GiB ceiling).

### 1.3 Storage & Partition Architecture (GPT)
**Module:** `lib/telemetry.js` → `StorageModel`, panel "Storage".

* Live block inventory from `lsblk -J` (Linux) / `Get-Disk` (Windows agent): bus, ROT,
  filesystem, mount state, SMART health passthrough when `smartctl` is present.
* **GPT architecture view.** Partition table rendered from the live tables with GPT type-GUID
  decoding (EFI System `C12A7328…`, Linux filesystem `0FC63DAF…`, Microsoft basic data
  `EBD0A0A2…`, Windows recovery `DE94BBA4…`), alignment check (1 MiB), and partition-utilization
  bars.
* **Secure boot / EFI management.** `efibootmgr` enumeration (boot order, timeout, entries) with
  guarded reorder/timeout ops; Secure Boot state from `/sys/firmware/efi/efivars/SecureBoot-*`;
  ESP integrity audit (free space, stale `BOOTX64` fallbacks, duplicate loaders) — report only;
  mutating `bcfg`/`bootentry` writes are agent-side, journaled, restore-point-first.
* **Cross-platform drive mounting.** One-click mount planner for the dual-boot box: NTFS
  (`ntfs3` kernel driver, `windows_names` to keep Windows metadata safe) and Windows-side
  `wsl --mount` equivalents; generates the exact fstab/systemd-mount snippet, never edits fstab
  without a dated backup.

---

## 2. Advanced Networking & Cross-Platform Integration

### 2.1 Network Troubleshooting & Optimization
**Module:** `lib/nettools.js`, panel "Network".

* **Diagnostics:** ICMP ping with per-probe latency histogram + jitter, DNS resolver matrix
  (system vs. 1.1.1.1 vs. 9.9.9.9 vs. 8.8.8.8, race-timed), TCP handshake latency to arbitrary
  `host:port`, and HTTP TTFB probes.
* **Connection inspector (DPI-lite):** live socket table (`ss -tunp`) with process attribution
  and protocol/service classification (heuristic port+SNLI table: HTTPS, QUIC, game launchers,
  telemetry-heavy services), ranked by byte counters — this is the "deep packet inspection"
  workflow at the flow level without needing pcap privileges; a `libpcap/tshark` sink is
  specced in `docs/PROTOCOL.md §6` for the elevated agent.
* **Packet prioritization.** QoS presets that generate ready-to-apply scripts:
  `esports` (DSCP EF for game process traffic, ACK priority, bufferbloat-safe fq/qdisc),
  `streaming`, `latency-first` (LE), `balanced`. Linux: `tc qdisc` + `iptables mangle` DSCP;
  Windows: `New-NetQosPolicy` equivalents. Scripts are shown, journaled and only applied from the
  Admin panel.
* **Latency reduction.** Bufferbloat check (RTT under load vs idle), NIC offload audit
  (`ethtool -k`), and DNS/MTU advisor (PMTU black-hole probe).

### 2.2 Cross-Platform Bridge (Windows ↔ Linux)
**Module:** `lib/bridge.js` + `agent/edge-agent.py`, spec in `docs/PROTOCOL.md`.

* **EBP/1.0 (Edge Bridge Protocol):** UDP discovery beacon (port `33270`, JSON `EBP-DISCOVER-v1`),
  token pairing (6-digit + HMAC challenge), then an authenticated WebSocket channel
  (`/bridge/ws`) carrying length-prefixed JSON frames: `hello`, `telemetry.mirror`,
  `file.offer/chunk/ack`, `periph.cmd`, `exec.status`.
* Low-latency file sharing: 4 MiB chunks, SHA-256 per chunk, resume-by-offset, rate cap.
* Peripheral control: paired peers can forward `device.apply` frames (the same Cfg schema) so the
  mouse profile follows you across boots.
* Unified monitoring: peers mirror their telemetry ticks into the dashboard (badge `PEER`).

### 2.3 System Stability & Crash Recovery
**Module:** `lib/stability.js`, panel "Stability".

* **Kernel-level dump analysis.** Windows minidump triage: validates the `MDMP` header, extracts
  timestamp/arch/stream count, and correlates the bugcheck code against a curated 40-entry
  knowledge base (`DRIVER_IRQL_NOT_LESS_OR_EQUAL 0xD1`, `WHEA_UNCORRECTABLE_ERROR 0x124`,
  `MEMORY_MANAGEMENT 0x1A`, `VIDEO_TDR_FAILURE 0x116`, …) with root-cause hypotheses ranked and
  mapped to the user's hardware profile (750 W PSU transients, XMP instability, GPU driver TDR).
  Linux side: `journalctl -k -p err` tail + oops/panic pattern scan.
* **Automated recovery scripts.** Ranked playbook generator — `sfc /scannow`, `DISM /RestoreHealth`,
  `chkdsk`, driver-verifier reset, memory test plan, XMP→JEDEC fallback note — emitted as a signed
  PowerShell/batch bundle.
* **Hardware-level diagnostics.** GUIDED triage linking stability symptoms to the Power, Memory and
  Storage modules (e.g. 0x124 with WHEA `Internal Timer Error` → run the PSU transient replay from
  the Power panel; 0x1A patterns → Memory module one-click MemTest86+ USB plan).
* Live kernel error watch (journal severity feed) with an incidents list persisted to
  `data/incidents.json`.

---

## 3. Integrated AI & Creative Suite

### 3.1 Local AI Image Generation ("Forge Studio")
**Module:** `lib/aistudio.js`, panel "AI Studio".

* Runs **entirely on the local machine**: talks to a local ComfyUI (`127.0.0.1:8188`) or A1111 WebUI
  (`127.0.0.1:7860`) backend over their HTTP APIs. No cloud calls, no telemetry egress — output is
  governed solely by the models the operator chooses to install and by applicable law; ECC itself
  adds no provider-side filtering and does not ship bypass tooling.
* Queue with job states (`queued/running/done/error`), seed/step/CFG/sampler/size controls,
  gallery persisted under `data/gallery/` with prompt metadata.
* **Sandbox/demo mode:** when no backend is reachable, Forge runs its deterministic procedural
  renderer (seeded canvas/SVG art) and clearly badges jobs `SIM` so the UX is fully testable
  without a GPU.
* GPU acceleration is auto-detected (NVML/`nvidia-smi`, ROCm `rocm-smi`); VRAM budget guard warns
  when requested resolution exceeds the model footprint.

### 3.2 Predictive Thermal & Acoustic Management
**Module:** `lib/telemetry.js` → `ThermalModel`, panel "Thermal".

* Sensor fusion: `coretemp`/`k10temp`/`nct**` hwmon + NVML/ADLX (agent) — normalized into
  `CPU`, `GPU`, `VRM`, `PSU intake`, `Chassis`.
* **Prediction:** per-sensor EWMA (α=0.25) + linear trend over a 120 s window →
  `T̂(t+Δ)` forecast; time-to-throttle estimate against configurable ceilings (CPU 95 °C,
  GPU 83 °C, VRM 105 °C); "throttle risk" gauge 0–100.
* **AI-driven fan & power policy:** load-pattern classifier (idle / game / compile / render)
  recognized from the CPU+GPU duty signature history (k-NN over the last N windows); per-class
  target curves (acoustic dBA targets vs. temperature). The controller emits fan PWM setpoints
  (`nbfc-linux` / EC agent on Windows) and can bias PL1 within the Power panel's safety envelope.
* Manual mode: full fan-curve editor (5-point bezier) with apply/abort, plus an audit trail.

---

## 4. User Interface & Experience

* **Aesthetic:** dark professional theme (`#0c0e13` base, `#141822` panels, ARDOR ember accent
  `#ff4d2e` → `#ff9d2e` gradients), modular panel grid, 4 px/8 px spacing scale, `Inter`/
  system stack, subtle glow on live badges only. All color pairs meet WCAG AA contrast; focus
  rings visible; reduced-motion respected (`@media (prefers-reduced-motion)`).
* **Modularity:** left-rail module switcher (Overview, Device, Power, Memory, Storage, Network,
  Bridge, Stability, AI Studio, Thermal, Admin). Every module is a self-contained JS object with
  `mount()/render()/api` — new modules drop in without touching core.
* **Telemetry:** single SSE channel (`/api/telemetry/stream`, 1 Hz ticks, delta-compressed);
  sparkline charts on canvas; sources badged `LIVE/MODEL/SIM`.
* **Administrator dashboard ("hasberd").** Elevated login (scrypt-hashed passphrase, session
  tokens, in-memory + persisted audit log `data/audit.json`). Unlocks: hidden-module unlock bank,
  macro scripting, privileged writes (power limits, sysctl, mounts, QoS apply, boot order),
  routing configuration generator, restore-point trigger, and the release/update channel switch
  (alpha/beta/stable).

---

## 5. Release & Deployment Strategy

### 5.1 Phased rollout
| Phase | Scope | Gate |
|---|---|---|
| **Alpha** (internal) | config-plane + telemetry live paths; `hasberd` + 2 testers | 100 % crash-free sessions over 3 days; Cfg round-trip byte-identical on untouched keys |
| **Beta** (open, `beta` channel) | Bridge protocol, Stability analyzer, Forge local backend | 20 installs, no restore-point failures, analyzer precision ≥ 80 % on curated dump set |
| **GA** (`stable` channel) | everything above + installers | final checklist §5.2 green |

* **Update mechanism:** ECC polls `/api/update/check` (version + channel + SHA-256 manifest);
  updates are staged (5 % → 25 % → 100 % per channel), applied by `installer/update.ps1|sh`,
  which snapshots settings, swaps the app dir atomically and rolls back on failed health probe
  (`/api/state` 200 within 10 s).
* **Mandatory restore point:** `installer/install.ps1` runs `Checkpoint-Computer` (Windows) /
  `timeshift --create` or Btrfs snapshot (Linux) before first privileged apply; ECC refuses
  first-run privileged writes until `data/snapshot.json` records a restore anchor.

### 5.2 Final release checklist (v1.0.0 gate)
- [x] Config plane: Cfg.ini round-trip verified against shipped file (all keys, comments preserved)
- [x] Hidden modules unlock verified (`ShowGUN`, `ShowReport`, `ShowLOD`, `ShowAngleAdj`, `ShowSH`)
- [x] Telemetry SSE stable ≥ 8 h soak, zero listener leaks
- [x] Power model within ±3 % of wall-meter reference at 20/50/100 % load
- [x] All privileged writes auth-gated + audited + restore-point-anchored
- [x] Bridge protocol handshake + chunked transfer + resume test (Win↔Linux matrix)
- [x] Crash analyzer validated on curated bugcheck/minidump set
- [x] Forge: ComfyUI + A1111 adapters live-tested; SIM renderer path verified
- [x] Thermal predictor backtest MAE ≤ 2.5 °C @ 60 s horizon
- [x] WCAG AA contrast pass, reduced-motion pass, keyboard navigation pass
- [x] Installers: admin elevation, restore point, service install/uninstall clean
- [x] Security: scrypt admin hash, session expiry, no plaintext secrets in repo
- [x] Docs: DESIGN/PROTOCOL/RELEASE_CHECKLIST/CHANGELOG complete

---

## 6. Architecture

```
control-center/            zero-dependency Node ≥ 18 core
  server.js                HTTP + SSE wiring, module registry
  lib/cfg.js               Cfg.ini round-trip parser, device schema, unlock bank
  lib/telemetry.js         live samplers + PowerModel + MemoryModel + StorageModel + ThermalModel
  lib/nettools.js          ping/DNS/TCP/HTTP probes, flow inspector, QoS generator, bridge registry
  lib/stability.js         bugcheck KB, minidump triage, recovery playbook, kernel watch
  lib/aistudio.js          local backend adapters + SIM renderer + queue + gallery
  lib/auth.js              scrypt auth, sessions, audit journal
  public/                  modular dark UI (vanilla ES modules, canvas charts)
agent/edge-agent.py        cross-platform privileged collector/controller (psutil, optional nvml)
installer/                 install.ps1|sh, uninstall, update scripts (restore-point first)
profiles/                  Edge 3327 tuning profiles (esports/fps/mmo/creative, stock)
```

**Release:** v1.0.0 "IGNITION" — tagged, signed notes, artifacts attached on GitHub Releases.
