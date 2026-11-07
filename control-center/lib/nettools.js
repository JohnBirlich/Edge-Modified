'use strict';
/**
 * nettools.js — diagnostics (ping/DNS/TCP/HTTP), flow inspector (DPI-lite),
 * QoS packet-prioritization script generator, EBP/1.0 cross-platform bridge registry.
 */
const dns = require('dns').promises;
const net = require('net');
const { execFile } = require('child_process');
const crypto = require('crypto');
const os = require('os');

const sh = (cmd, args, timeout = 6000) => new Promise(res => {
  execFile(cmd, args, { timeout }, (err, stdout, stderr) => res({ err: !!err, out: stdout || stderr || '' }));
});

/* ---------- ICMP ping with histogram ---------- */
async function ping(host, count = 10) {
  const r = await sh('ping', ['-c', String(count), '-w', '6', host], 9000);
  const times = [...r.out.matchAll(/time[=<]([\d.]+)\s*ms/g)].map(m => parseFloat(m[1]));
  const loss = r.out.match(/([\d.]+)% packet loss/);
  const stats = {
    host, probes: count, resolved: times.length,
    lossPct: loss ? parseFloat(loss[1]) : (times.length === 0 ? 100 : 0),
    min: times.length ? Math.min(...times) : null,
    max: times.length ? Math.max(...times) : null,
    avg: times.length ? +(times.reduce((a, b) => a + b, 0) / times.length).toFixed(2) : null,
    jitter: times.length > 1 ? +(Math.max(...times) - Math.min(...times)).toFixed(2) : 0,
    histogram: times, src: 'LIVE'
  };
  if (!r.err && times.length === 0 && /unknown host/i.test(r.out)) stats.error = 'resolve failed';
  return stats;
}

/* ---------- DNS resolver matrix ---------- */
async function resolveOn(resolver, host) {
  const t0 = process.hrtime.bigint();
  try {
    const amp = new dns.Resolver();
    if (resolver) amp.setServers([resolver]);
    const addrs = await new Promise((res, rej) => {
      amp.resolve4(host, (e, a) => e ? rej(e) : res(a));
      setTimeout(() => rej(new Error('timeout')), 3000);
    });
    return { resolver: resolver || 'system', ok: true, ms: Number(process.hrtime.bigint() - t0) / 1e6, addrs };
  } catch (e) {
    return { resolver: resolver || 'system', ok: false, ms: Number(process.hrtime.bigint() - t0) / 1e6, error: e.message };
  }
}
async function dnsMatrix(host) {
  const rows = await Promise.all(['1.1.1.1', '9.9.9.9', '8.8.8.8', null].map(r => resolveOn(r, host)));
  const ok = rows.filter(r => r.ok);
  return { host, rows, fastest: ok.length ? ok.reduce((a, b) => a.ms < b.ms ? a : b) : null, src: 'LIVE' };
}

/* ---------- TCP handshake latency ---------- */
function tcpLatency(host, port, timeout = 3000) {
  return new Promise(res => {
    const t0 = process.hrtime.bigint();
    const s = net.connect({ host, port });
    const done = r => { try { s.destroy(); } catch { } res(r); };
    s.setTimeout(timeout, () => done({ host, port, ok: false, error: 'timeout', src: 'LIVE' }));
    s.on('connect', () => done({ host, port, ok: true, ms: +(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(2), src: 'LIVE' }));
    s.on('error', e => done({ host, port, ok: false, error: e.message, src: 'LIVE' }));
  });
}

/* ---------- HTTP TTFB ---------- */
async function httpProbe(url) {
  const t0 = Date.now();
  try {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 6000);
    const r = await fetch(url, { signal: ctl.signal, redirect: 'follow' });
    clearTimeout(to);
    await r.text().catch(() => '');
    return { url, ok: true, status: r.status, ttfbMs: Date.now() - t0, src: 'LIVE' };
  } catch (e) {
    return { url, ok: false, error: String(e.message || e), ms: Date.now() - t0, src: 'LIVE' };
  }
}

/* ---------- Flow inspector (DPI-lite over ss) ---------- */
const SERVICE_MAP = [
  [443, 'HTTPS/TLS'], [80, 'HTTP'], [3478, 'STUN'], [3074, 'Xbox-live/game'], [27015, 'Steam game'],
  [27036, 'Steam'], [27017, 'Mongo'], [5222, 'XMPP'], [5060, 'SIP'], [123, 'NTP'],
  [1935, 'RTMP'], [8188, 'ComfyUI-local'], [7860, 'A1111-local'], [33270, 'EBP-bridge'],
  [53, 'DNS'], [22, 'SSH'], [445, 'SMB'], [3389, 'RDP'], [6667, 'IRC'], [25565, 'Minecraft']
];
function classify(port) {
  const hit = SERVICE_MAP.find(([p]) => p === port);
  return hit ? hit[1] : (port < 1024 ? 'privileged' : 'ephemeral/app');
}
async function flowInspector() {
  const r = await sh('ss', ['-tunp'], 5000);
  if (!r.out) return { flows: [], src: 'SIM', note: 'ss unavailable — agent provides netstat -ano parity on Windows.' };
  const lines = r.out.split('\n').slice(1).filter(Boolean);
  const flows = lines.map(l => {
    const c = l.trim().split(/\s+/);
    // ss -tunp: State Recv-Q Send-Q Local Peer [users]
    const local = c[4] || '', peer = c[5] || '', proc = (l.match(/users:\(\("([^"]+)"/) || [])[1] || null;
    const pport = parseInt((peer.match(/:(\d+)$/) || [])[1] || '0', 10);
    return {
      proto: c[0], state: c[0] === 'tcp' ? c[1] : null,
      local, peer, port: pport, service: classify(pport), process: proc,
      klass: /steam|game|epic|riot|origin/.test((proc || '').toLowerCase()) ? 'game'
        : /chrome|firefox|edge|brave/.test((proc || '').toLowerCase()) ? 'browser'
        : /comfy|a1111|python/.test((proc || '').toLowerCase()) ? 'ai-local' : 'system'
    };
  });
  const byClass = {};
  for (const f of flows) byClass[f.klass] = (byClass[f.klass] || 0) + 1;
  return { flows, byClass, count: flows.length, src: 'LIVE', note: 'Flow-level inspection (5-tuple + process attribution + service classifier). pcap/SNI sink specced in docs/PROTOCOL.md §6.' };
}

/* ---------- QoS packet prioritization generator ---------- */
const QOS_PRESETS = {
  esports: {
    label: 'Esports — DSCP EF for game traffic, ACK priority, fq qdisc',
    dscp: 'EF', notes: 'Lowest latency envelope; drops background bulk to LE.',
    linux: ['#!/bin/sh', 'set -e',
      'tc qdisc replace dev eth0 root fq',
      '# game process flows -> EF (46)',
      'iptables -t mangle -A OUTPUT -m cgroup --cgroup 0x110001 -j DSCP --set-dscp-class EF 2>/dev/null || true',
      'iptables -t mangle -A OUTPUT -p udp --dport 3074 -j DSCP --set-dscp-class EF',
      'iptables -t mangle -A OUTPUT -p udp --dport 3478 -j DSCP --set-dscp-class EF',
      'iptables -t mangle -A OUTPUT -p tcp --sport 27015:27050 -j DSCP --set-dscp-class EF',
      '# bulk + background down-graded',
      'iptables -t mangle -A OUTPUT -m length --length 1400:1500 -j DSCP --set-dscp-class CS1 || true',
      'sysctl -w net.ipv4.tcp_congestion_control=bbr',
      'sysctl -w net.core.default_qdisc=fq'].join('\n'),
    windows: ['# Run as Administrator',
      'New-NetQosPolicy "EDGE-Game" -UDP -DestinationPort 3074 -DSCPValue 46',
      'New-NetQosPolicy "EDGE-Game2" -UDP -DestinationPort 3478 -DSCPValue 46',
      'netsh int tcp set supplemental internet congestionprovider=bbr2'].join('\n')
  },
  streaming: {
    label: 'Streaming — CS4 video uplink guard',
    dscp: 'CS4', linux: ['#!/bin/sh', 'set -e', 'tc qdisc replace dev eth0 root fq', 'iptables -t mangle -A OUTPUT -p tcp --dport 1935 -j DSCP --set-dscp-class CS4', 'iptables -t mangle -A OUTPUT -p udp --dport 443 -j DSCP --set-dscp-class CS4'].join('\n'),
    windows: ['New-NetQosPolicy "EDGE-Stream" -TCP -DestinationPort 1935 -DSCPValue 32'].join('\n')
  },
  'latency-first': {
    label: 'Latency-first — everything interactive LE, bulk scavenged',
    dscp: 'LE', linux: ['#!/bin/sh', 'set -e', 'tc qdisc replace dev eth0 root fq', 'iptables -t mangle -A OUTPUT -p icmp -j DSCP --set-dscp-class LE', 'iptables -t mangle -A OUTPUT -p tcp --dport 22 -j DSCP --set-dscp-class LE'].join('\n'),
    windows: ['New-NetQosPolicy "EDGE-Interactive" -TCP -DestinationPort 22 -DSCPValue 1'].join('\n')
  },
  balanced: { label: 'Balanced — defaults restored', dscp: 'CS0', linux: '#!/bin/sh\ntc qdisc del dev eth0 root 2>/dev/null || true\niptables -t mangle -F OUTPUT', windows: 'Get-NetQosPolicy | Where-Object {$_.Name -like "EDGE-*"} | Remove-NetQosPolicy' }
};

/* ---------- Bufferbloat (RTT idle vs loaded) ---------- */
async function bufferbloat(host) {
  const idle = await ping(host, 6);
  const loadPromise = httpProbe(`http://${host}/`).catch(() => null); // light concurrent load
  const loaded = await ping(host, 6);
  await loadPromise;
  const bloat = idle.avg && loaded.avg ? +(loaded.avg - idle.avg).toFixed(2) : null;
  return { idle: idle.avg, loaded: loaded.avg, addedLatencyMs: bloat, grade: bloat === null ? '?' : bloat < 5 ? 'A' : bloat < 20 ? 'B' : bloat < 50 ? 'C' : 'D', src: 'LIVE' };
}

/* ================================================================
 * EBP/1.0 — Edge Bridge Protocol registry (Windows <-> Linux)
 * Discovery: UDP :33270 "EBP-DISCOVER-v1"; pairing: 6-digit + HMAC;
 * transport: /bridge/ws frames (see docs/PROTOCOL.md).
 * ================================================================ */
const BRIDGE = {
  version: 'EBP/1.0', port: 33270,
  pairingCode: null, pairingExpires: 0,
  peers: new Map() // id -> {id, name, platform, since, lastSeen, capabilities, mirrored}
};
function bridgeIdentity() {
  return { name: os.hostname(), platform: os.platform(), role: 'control-center' };
}
function issuePairingCode() {
  BRIDGE.pairingCode = String(crypto.randomInt(100000, 999999));
  BRIDGE.pairingExpires = Date.now() + 120_000;
  return { code: BRIDGE.pairingCode, expiresAt: BRIDGE.pairingExpires, transport: BRIDGE.version, port: BRIDGE.port };
}
function pairPeer({ name, platform, code, capabilities }) {
  if (!BRIDGE.pairingCode || code !== BRIDGE.pairingCode || Date.now() > BRIDGE.pairingExpires)
    return { ok: false, error: 'invalid or expired pairing code' };
  BRIDGE.pairingCode = null;
  const id = crypto.randomUUID();
  const peer = { id, name: name || 'peer', platform: platform || 'unknown', since: Date.now(), lastSeen: Date.now(), capabilities: capabilities || [], mirrored: false };
  BRIDGE.peers.set(id, peer);
  return { ok: true, peerId: id, token: crypto.createHmac('sha256', String(id)).update('ebp').digest('hex').slice(0, 32) };
}
function peerHeartbeat(id) {
  const p = BRIDGE.peers.get(id);
  if (p) p.lastSeen = Date.now();
  return p || null;
}
function bridgeState() {
  const now = Date.now();
  for (const [id, p] of BRIDGE.peers) if (now - p.lastSeen > 60_000) p.online = false;
  for (const p of BRIDGE.peers.values()) p.online = (now - p.lastSeen) < 60_000;
  return { protocol: BRIDGE.version, discoveryPort: BRIDGE.port, pairingActive: !!BRIDGE.pairingCode && now < BRIDGE.pairingExpires, peers: [...BRIDGE.peers.values()], identity: bridgeIdentity() };
}

module.exports = { ping, dnsMatrix, tcpLatency, httpProbe, flowInspector, QOS_PRESETS, bufferbloat, BRIDGE, issuePairingCode, pairPeer, peerHeartbeat, bridgeState };
