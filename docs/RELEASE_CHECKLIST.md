# Final Release Checklist — v1.0.0 "IGNITION"

Every line is a gate; a red line blocks the release.

## Config plane (Edge 3327)
- [x] `Cfg.ini` round-trip byte-safe (verified against shipped stock file — comments, ordering, padding preserved)
- [x] Hidden-module bank verified: `ShowGUN`, `ShowReport`, `ShowLOD`, `ShowAngleAdj`, `ShowSH` flip cleanly and revert
- [x] 5 tuning profiles apply and export as stock-app-compatible INI (UTF-8 BOM, CRLF)
- [x] DPI stage + per-stage RGB editor clamped to sensor range 200–12400 (step 100)
- [x] Export writes a dated file, original stock file never mutated by ECC

## Telemetry & models
- [x] SSE stream stable ≥ 8 h soak, no listener leak (client `close` cleanup verified)
- [x] Every metric badged `LIVE | MODEL | SIM` — no silent fabrication
- [x] PSU model within ±3 % of wall-meter reference at 20/50/100 % load points (80+ Gold curve calibrated)
- [x] PL guard enforced: PL2 ≤ 1.5 × PL1 ≤ platform max, tau clamp
- [x] Thermal predictor backtest MAE ≤ 2.5 °C @ 60 s horizon; time-to-throttle monotonic
- [x] Fan-curve editor bounds (30–95 °C, 0–100 % PWM) enforced server-side

## Privileged operations & security
- [x] All mutating endpoints require admin session (401 verified without token)
- [x] scrypt-hashed passphrase; default `ardor-3327` flagged for forced rotation
- [x] Audit journal records every privileged action (verified: login, unlock, PL, preset, macro, snapshot)
- [x] Macro runner refuses destructive patterns (`rm -rf`, `mkfs`, `format`); dry-run in sandbox
- [x] Restore anchor exists before first privileged write (auto-created on first run)
- [x] Installer creates OS-level restore point **before** file copy (Windows `Checkpoint-Computer`, Linux timeshift/btrfs/tar)

## Cross-platform bridge
- [x] Pairing: 6-digit code, TTL 120 s, single use (verified end-to-end with agent)
- [x] Heartbeat staleness marking at 60 s
- [x] Chunked transfer: 4 MiB chunks, per-chunk + whole-file SHA-256, resume by offset
- [x] Capability matrix honoured; `exec.allow` allow-list on both ends
- [x] Windows↔Linux matrix: Win11↔Debian 12 verified; reversed roles verified

## Stability suite
- [x] Bugcheck KB (20+ codes) maps to hardware-profile hypotheses + playbooks
- [x] Minidump header triage (MDMP magic, streams, BugCheck stream 20)
- [x] Recovery bundle generation (sfc/DISM/chkdsk/verifier/WHEA survey)
- [x] Linux kernel watch (journalctl severity scan) + incident persistence

## AI Studio (Forge)
- [x] ComfyUI adapter live-tested (`/prompt`, `/history`, `/view`)
- [x] A1111 adapter live-tested (`/sdapi/v1/txt2img`)
- [x] SIM renderer path verified (deterministic seeded SVG, badged SIM)
- [x] VRAM budget guard warns above detected footprint
- [x] No cloud egress — verified by packet audit during generation

## UI/UX
- [x] WCAG AA contrast on all text/background pairs (theme tokens audited)
- [x] `prefers-reduced-motion` respected; keyboard navigation + focus rings on all interactive elements
- [x] Modular panel contract (mount/refresh, zero cross-dependencies)

## Deployment
- [x] `install.ps1`: elevation gate, restore point, firewall, scheduled task, 10 s health probe
- [x] `install.sh`: snapshot gate, systemd unit, firewall, health probe
- [x] Updater: snapshot → staged rollout (5/25/100 %) → atomic swap → rollback on failed probe
- [x] Uninstallers clean (restore points intentionally kept)
