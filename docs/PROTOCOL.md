# EBP/1.0 — Edge Bridge Protocol

Low-latency Windows ↔ Linux channel for the ARDOR Edge platform:
file sharing, peripheral control, mirrored telemetry, guarded execution.

## 1. Topology

```
┌──────────────────┐   UDP :33270 (discovery)   ┌──────────────────┐
│  Control Center  │◄──────────────────────────►│   EBP agent      │
│  (Linux or Win)  │   HTTP :3327 (pairing,     │  (other OS)      │
│                  │    file chunks, control)   │                  │
└──────────────────┘                            └──────────────────┘
        ▲                                              ▲
        └──────────── multiple peers supported ────────┘
```

## 2. Discovery — `EBP-DISCOVER-v1`

UDP broadcast to port **33270**, JSON payload:

```json
{ "proto": "EBP-DISCOVER-v1", "name": "HASBERD-WIN", "platform": "windows",
  "http": 3327, "caps": ["file.share", "periph.apply", "telemetry.mirror"] }
```

Agents answer passively (`edge-agent.py discover`); the Control Center listens
and lists candidates in the Bridge panel.

## 3. Pairing

1. Operator issues a 6-digit code in the Bridge panel (admin-only, TTL 120 s).
2. Agent POSTs `/bridge/hello` `{ name, platform, code, capabilities }`.
3. Server validates and returns `{ ok, peerId, token }` where
   `token = HMAC-SHA256(peerId, "ebp")[0:32]` — presented as `X-Peer-Token`.
4. Pairing state is cached agent-side in `~/.edge-agent.json` (0600).

## 4. Frames (HTTP in reference implementation, WebSocket in production agent)

| Endpoint | Direction | Payload |
|---|---|---|
| `POST /bridge/heartbeat` | peer → hub | `{ peerId, telemetry }` every 15 s; stale peers >60 s are flagged offline |
| `POST /bridge/file` | peer → hub | `{ name, offset, size, sha256, chunkSha256, dataB64 }` — 4 MiB chunks, per-chunk SHA-256, resume by `offset` |
| `periph.apply` | hub → peer | Cfg-schema patch (same keys as the Device panel), applied by the peer's config plane |
| `exec.allow` | hub → peer | whitelisted verbs only (`set dpi`, `set debounce`, `thermal adaptive`, `profile <name>`); destructive verbs refused |

Heartbeats mirror peer telemetry which surfaces in the dashboard with a
`PEER` source badge.

## 5. File transfer guarantees

* 4 MiB chunks, SHA-256 per chunk **and** whole-file SHA-256 up front.
* Resume: receiver acknowledges the highest contiguous offset; sender seeks.
* Rate cap 64 MiB/s default; per-peer concurrency 1 (serialized queue).

## 6. Security model

* Pairing code entropy 10^6, TTL 120 s, single-use, rate-limited to 1/10 s.
* Peer tokens are HMAC-derived, revocable by hub restart; TLS termination
  (production) expected in front of `:3327` when bridged off-subnet.
* `exec.allow` verbs are an explicit allow-list compiled into both ends;
  the hub-side macro runner is dry-run in the sandbox and whitelisted in production.
* All pairing and privileged frames land in the ECC audit journal.

## 7. DPI sink (optional elevated mode)

For full packet-level inspection the agent may open a `tshark` sink:

```
tshark -i <if> -q -z conv,tcp -z endpoints,udp -T json
```

Aggregated conversation stats (not payloads) stream to the hub as
`telemetry.flows` — ECC renders them in the Flow inspector alongside the
default 5-tuple view. Payload capture is deliberately not implemented.
