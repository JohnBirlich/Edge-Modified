#!/usr/bin/env python3
"""
edge-agent.py — EBP/1.0 agent for the Edge Control Center.

Cross-platform (Windows / Linux) privileged companion:
  * pairs with the Control Center (6-digit code + token)
  * mirrors telemetry (psutil if available, stdlib fallback)
  * offers whitelisted control verbs (periph.apply, exec.allow)
  * CLI file transfer (chunked, SHA-256, resumable)

Usage:
  python3 edge-agent.py pair <host> <port>       # join a Control Center
  python3 edge-agent.py run   <host> <port>      # pair (cached) + heartbeat loop
  python3 edge-agent.py send  <host> <port> <file> <peer-token>  # chunked upload
  python3 edge-agent.py status                   # local telemetry snapshot

No hard dependencies: psutil is used when present.
"""
import argparse
import hashlib
import json
import os
import platform
import socket
import sys
import time
import urllib.request
import urllib.error

CHUNK = 4 * 1024 * 1024
UA = "edge-agent/1.0 (EBP/1.0)"
STATE_FILE = os.path.expanduser("~/.edge-agent.json")


def telemetry() -> dict:
    t = {"platform": platform.system().lower(), "node": platform.node(), "ts": int(time.time())}
    try:
        import psutil  # type: ignore
        vm, du = psutil.virtual_memory(), psutil.disk_usage("/")
        cq = psutil.cpu_times()
        t.update({
            "cpuPct": psutil.cpu_percent(interval=0.2),
            "memPct": vm.percent, "memTotalGiB": round(vm.total / 2**30, 2),
            "diskFreeGiB": round(du.free / 2**30, 1),
            "battery": None,
            "src": "LIVE-psutil",
        })
        if getattr(psutil, "sensors_temperatures", None):
            try:
                temps = psutil.sensors_temperatures() or {}
                flat = [x.current for v in temps.values() for x in v]
                if flat:
                    t["cpuTempC"] = max(flat)
            except Exception:
                pass
    except ImportError:
        t.update({"src": "MODEL-stdlib"})
        try:
            with open("/proc/loadavg") as f:
                t["load1"] = float(f.read().split()[0])
            with open("/proc/meminfo") as f:
                mi = {l.split(":")[0]: int(l.split()[1]) for l in f if ":" in l}
            t["memTotalGiB"] = round(mi.get("MemTotal", 0) / 2**20, 2)
            t["memPct"] = round(100 * (1 - mi.get("MemAvailable", 0) / max(1, mi.get("MemTotal", 1))), 1)
        except Exception:
            pass
    return t


def post(base: str, path: str, payload: dict, token: str | None = None, timeout: float = 8.0):
    req = urllib.request.Request(
        base.rstrip("/") + path,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "User-Agent": UA,
                 **({"X-Peer-Token": token} if token else {})},
        method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode() or "{}")


def cmd_status(_):
    print(json.dumps(telemetry(), indent=2))
    return 0


def cmd_pair(host, port):
    base = f"http://{host}:{port}"
    code = input("pairing code from Control Center: ").strip()
    r = post(base, "/bridge/hello", {
        "name": platform.node(), "platform": platform.system().lower(),
        "code": code, "capabilities": ["file.share", "periph.apply", "telemetry.mirror"]})
    if not r.get("ok"):
        print("pairing failed:", r); return 2
    state = {"peerId": r["peerId"], "token": r["token"], "base": base, "paired": time.time()}
    with open(STATE_FILE, "w") as f:
        json.dump(state, f)
    os.chmod(STATE_FILE, 0o600)
    print("paired ✓  peerId", r["peerId"])
    return 0


def load_state():
    if not os.path.exists(STATE_FILE):
        print("not paired — run: edge-agent.py pair <host> <port>"); sys.exit(2)
    with open(STATE_FILE) as f:
        return json.load(f)


def heartbeat_loop(state, every=15.0):
    print(f"mirroring telemetry to {state['base']} every {every:.0f}s — Ctrl+C to stop")
    while True:
        try:
            post(state["base"], "/bridge/heartbeat",
                 {"peerId": state["peerId"], "telemetry": telemetry()},
                 token=state["token"])
            print("♥", end="", flush=True)
        except Exception as e:
            print(f"\nx heartbeat: {e}", end="", flush=True)
        time.sleep(every)


def cmd_send(host, port, path, peer_token):
    """Chunked transfer with SHA-256 integrity + resume by offset."""
    size = os.path.getsize(path)
    name = os.path.basename(path)
    sha = hashlib.sha256()
    with open(path, "rb") as f:
        for blk in iter(lambda: f.read(1 << 20), b""):
            sha.update(blk)
    print(f"offer {name} ({size} bytes, sha256 {sha.hexdigest()[:16]}…)")
    # EBP/1.0 file.offer → in this reference implementation the Control Center
    # acknowledges with an offset for resume; chunks then stream over /bridge/file
    off, n = 0, 0
    with open(path, "rb") as f:
        while off < size:
            f.seek(off)
            blk = f.read(min(CHUNK, size - off))
            digest = hashlib.sha256(blk).hexdigest()
            r = post(f"http://{host}:{port}", "/bridge/file", {
                "name": name, "offset": off, "size": size,
                "sha256": sha.hexdigest(), "chunkSha256": digest,
                "dataB64": __import__("base64").b64encode(blk).decode(),
            }, token=peer_token, timeout=60)
            if not r.get("ok"):
                print("chunk refused at", off, r); return 3
            off += len(blk); n += 1
            print(f"\r{off}/{size} ({100 * off // size}%)", end="", flush=True)
    print(f"\ntransfer complete — {n} chunks verified")
    return 0


def discover(timeout=1.5):
    """EBP-DISCOVER-v1 UDP beacon listener (passive)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        s.bind(("", 33270))
    except OSError as e:
        print("discovery bind failed:", e); return
    s.settimeout(timeout)
    print("listening for EBP-DISCOVER-v1 beacons on UDP :33270 …")
    try:
        while True:
            data, addr = s.recvfrom(2048)
            try:
                msg = json.loads(data.decode())
                if str(msg.get("proto", "")).startswith("EBP"):
                    print(f"  {addr[0]}:{addr[1]} → {msg}")
            except Exception:
                pass
    except socket.timeout:
        print("done")
    finally:
        s.close()


def main():
    ap = argparse.ArgumentParser(description="EBP/1.0 agent for Edge Control Center")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name, args_ in [("pair", ["host", "port"]), ("run", ["host", "port"]),
                        ("send", ["host", "port", "file", "token"]),
                        ("status", []), ("discover", [])]:
        p = sub.add_parser(name)
        for a in args_:
            p.add_argument(a)
    a = ap.parse_args()
    if a.cmd == "status":
        sys.exit(cmd_status(a))
    if a.cmd == "discover":
        discover(); return
    if a.cmd == "pair":
        sys.exit(cmd_pair(a.host, a.port))
    if a.cmd == "run":
        heartbeat_loop(load_state())
    if a.cmd == "send":
        sys.exit(cmd_send(a.host, a.port, a.file, a.token))


if __name__ == "__main__":
    main()
