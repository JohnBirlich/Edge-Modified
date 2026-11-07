# Changelog

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
