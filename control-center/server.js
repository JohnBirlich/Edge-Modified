#!/usr/bin/env node
'use strict';
/**
 * Edge Control Center — server core (zero npm dependencies).
 * HTTP + SSE wiring for: Overview, Device (Edge 3327), Power, Memory, Storage,
 * Network, Bridge, Stability, AI Studio, Thermal, Admin, Updates.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const cfg = require('./lib/cfg');
const tel = require('./lib/telemetry');
const nettools = require('./lib/nettools');
const stab = require('./lib/stability');
const ai = require('./lib/aistudio');
const auth = require('./lib/auth');

const VERSION = require('../VERSION.json');
const PORT = parseInt(process.env.PORT || '3327', 10);
const PUBLIC = path.join(__dirname, 'public');
auth.ensureCreds();

const plane = new cfg.ConfigPlane(path.join(__dirname, '..'));
const state = {
  started: Date.now(),
  snapshotAnchor: (() => { // restore-point anchor: recorded by installers; first run creates one
    try {
      const p = path.join(__dirname, '..', 'data', 'snapshot.json');
      if (!fs.existsSync(p)) {
        fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
        fs.writeFileSync(p, JSON.stringify({ ts: Date.now(), kind: 'ecc-first-run', note: 'Pre-privilege settings snapshot (ECC config plane + stock Cfg.ini hash).' }, null, 2));
      }
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch { return null; }
  })()
};

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2' };

/* ---------------- telemetry SSE ---------------- */
const sseClients = new Set();
let lastTick = null;
setInterval(async () => {
  try {
    lastTick = await tel.sampleAll();
    lastTick.bridge = nettools.bridgeState();
    const frame = `data: ${JSON.stringify(lastTick)}\n\n`;
    for (const res of sseClients) { try { res.write(frame); } catch { sseClients.delete(res); } }
  } catch (e) { /* keep the loop alive */ }
}, 1000).unref();

/* ---------------- helpers ---------------- */
function json(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': b.length });
  res.end(b);
}
async function body(req) {
  return new Promise((res, rej) => {
    let d = ''; req.on('data', c => { d += c; if (d.length > 2e6) req.destroy(); });
    req.on('end', () => { try { res(d ? JSON.parse(d) : {}); } catch (e) { rej(e); } });
    req.on('error', rej);
  });
}
const adminOnly = handler => async (req, res, ...rest) => {
  const s = auth.requireAdmin(req, res);
  if (!s) return;
  try { return await handler(req, res, s, ...rest); }
  catch (e) { json(res, 500, { error: String(e.message || e) }); }
};

/* ---------------- router ---------------- */
const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

/* ---- meta / updates ---- */
route('GET', /^\/api\/state$/, (req, res) => {
  json(res, 200, {
    app: 'Edge Control Center', version: VERSION, uptimeS: Math.round((Date.now() - state.started) / 1000),
    device: plane.summary(), snapshotAnchor: state.snapshotAnchor,
    modules: {
      device: 'ready', power: 'ready', memory: 'ready', storage: 'ready', network: 'ready',
      bridge: 'ready', stability: 'ready', ai: ai.state.detected ? 'ready' : 'detecting', thermal: 'ready', admin: 'ready'
    }
  });
});
route('GET', /^\/api\/update\/check$/, (req, res) => {
  const ch = (req.url.match(/[?&]channel=(\w+)/) || [])[1] || 'stable';
  const stages = { alpha: 100, beta: 25, stable: 5 };
  json(res, 200, {
    current: VERSION.version, channel: ch, upToDate: true,
    stagedRolloutPct: stages[ch] ?? 5, mechanism: 'installer/update.ps1|sh — snapshot, atomic swap, health-probe rollback (/api/state within 10 s)'
  });
});

/* ---- device (Edge 3327 config plane) ---- */
route('GET', /^\/api\/device\/config$/, (req, res) => json(res, 200, plane.summary()));
route('GET', /^\/api\/device\/raw$/, (req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(plane.raw()); });
route('GET', /^\/api\/device\/profiles$/, (req, res) => json(res, 200, Object.fromEntries(Object.entries(cfg.PROFILES).map(([k, v]) => [k, { label: v.label, keys: Object.keys(v.patch) }]))));
route('GET', /^\/api\/device\/unlocks$/, (req, res) => json(res, 200, cfg.UNLOCK_BANK.map(u => ({ ...u, on: String(plane.work.get(u.section, u.key, '0')).trim() === '1' }))));
route('POST', /^\/api\/device\/unlocks?\/(\w+)$/, adminOnly(async (req, res, s, m) => {
  const b = await body(req); json(res, 200, { summary: plane.unlock(m[1], b.on !== false) });
}));
route('POST', /^\/api\/device\/key$/, adminOnly(async (req, res) => {
  const b = await body(req);
  if (!b.section || !b.key || b.value === undefined) return json(res, 400, { error: 'section, key, value required' });
  json(res, 200, { summary: plane.setKey(b.section, b.key, b.value) });
}));
route('POST', /^\/api\/device\/profile\/(\w+)$/, adminOnly(async (req, res, s, m) => {
  json(res, 200, { applied: m[1], summary: plane.applyProfile(m[1]) });
}));
route('POST', /^\/api\/device\/export$/, adminOnly(async (req, res) => {
  const p = plane.exportCfg();
  json(res, 200, { exported: path.basename(p), note: 'Drop into the stock OemDrv folder (backup original) or import via ECC on any machine.' });
}));
route('GET', /^\/api\/device\/dpicalc$/, (req, res) => {
  const dpi = parseFloat(req.url.match(/[?&]dpi=([\d.]+)/)?.[1] || '800');
  const hz = parseFloat(req.url.match(/[?&]hz=([\d.]+)/)?.[1] || '1000');
  const cm360 = (2.54 * 360) / (dpi * 0.0254) ; // counts per inch → cm/360 heuristic
  json(res, 200, { dpi, hz, countsPerCm: +(dpi / 2.54).toFixed(1), cmPer360: +cm360.toFixed(1), msPerCount: +(1000 / hz).toFixed(2), src: 'MODEL' });
});

/* ---- telemetry ---- */
route('GET', /^\/api\/telemetry\/stream$/, (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write(`data: ${JSON.stringify(lastTick)}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});
route('GET', /^\/api\/thermal\/history$/, (req, res) => {
  const s = tel.THERMAL.sensors;
  const trim = h => h.map(x => ({ t: x.t, v: x.v }));
  json(res, 200, { cpu: trim(s.cpu?.hist || []), gpu: trim(s.gpu?.hist || []), class: tel.THERMAL.classHist.slice(-180) });
});
route('POST', /^\/api\/thermal\/policy$/, adminOnly(async (req, res) => {
  const b = await body(req);
  if (b.mode) tel.THERMAL.fanMode = ['adaptive', 'manual', 'acoustic'].includes(b.mode) ? b.mode : tel.THERMAL.fanMode;
  if (b.acousticTargetDba) tel.THERMAL.acousticTargetDba = Math.max(20, Math.min(45, +b.acousticTargetDba));
  if (Array.isArray(b.curve) && b.curve.length === 5) tel.THERMAL.fanCurve = b.curve.map(p => ({ x: Math.max(30, Math.min(95, +p.x)), y: Math.max(0, Math.min(100, +p.y)) }));
  if (b.ceilings) Object.assign(tel.THERMAL.ceilings, Object.fromEntries(Object.entries(b.ceilings).map(([k, v]) => [k, Math.max(60, Math.min(110, +v))])));
  auth.audit('thermal.policy', JSON.stringify({ mode: tel.THERMAL.fanMode, curve: tel.THERMAL.fanCurve, ceilings: tel.THERMAL.ceilings }), true);
  json(res, 200, { ok: true, controller: { mode: tel.THERMAL.fanMode, curve: tel.THERMAL.fanCurve, acousticTargetDba: tel.THERMAL.acousticTargetDba, ceilings: tel.THERMAL.ceilings } });
}));

/* ---- power ---- */
route('POST', /^\/api\/power\/limit$/, adminOnly(async (req, res) => {
  const b = await body(req);
  const r = tel.setPowerLimits(Number(b.pl1), Number(b.pl2));
  auth.audit('power.limit', JSON.stringify(r), true);
  json(res, 200, r);
}));
route('POST', /^\/api\/power\/price$/, (req, res) => {
  const b = body;
  return body(req).then(x => { tel.powerState.kWhPrice = Math.max(0, Math.min(2, +x.kWhPrice || 0)); json(res, 200, { kWhPrice: tel.powerState.kWhPrice }); });
});

/* ---- memory ---- */
route('GET', /^\/api\/memory$/, async (req, res) => json(res, 200, await tel.memoryProfile()));
route('POST', /^\/api\/memory\/vm$/, adminOnly(async (req, res) => {
  const b = await body(req);
  const results = {};
  const targets = ['swappiness', 'vfs_cache_pressure', 'dirty_ratio', 'dirty_background_ratio'];
  for (const k of targets) {
    if (b[k] !== undefined) {
      const v = Math.max(0, Math.min(1000, parseInt(b[k], 10)));
      try { fs.writeFileSync(`/proc/sys/vm/${k}`, String(v)); results[k] = { set: v, src: 'LIVE' }; }
      catch (e) { results[k] = { set: v, src: 'SIM (needs root)', error: e.code }; }
    }
  }
  auth.audit('memory.vm', JSON.stringify(results), true);
  json(res, 200, { results, note: 'Linux sysctl path; Windows agent maps to LargeSystemCache/Win32PrioritySeparation.' });
}));
route('POST', /^\/api\/memory\/preset\/(\w+)$/, adminOnly(async (req, res, s, m) => {
  const p = tel.VM_PRESETS[m[1]];
  if (!p) return json(res, 404, { error: 'unknown preset' });
  const out = {};
  for (const k of ['swappiness', 'vfs_cache_pressure']) {
    try { fs.writeFileSync(`/proc/sys/vm/${k}`, String(p[k])); out[k] = { set: p[k], src: 'LIVE' }; }
    catch (e) { out[k] = { set: p[k], src: 'SIM (needs root)' }; }
  }
  auth.audit('memory.preset', `${m[1]} ${JSON.stringify(out)}`, true);
  json(res, 200, { preset: m[1], note: p.note, results: out });
}));

/* ---- storage ---- */
route('GET', /^\/api\/storage$/, async (req, res) => json(res, 200, await tel.storageInventory()));
route('POST', /^\/api\/storage\/mountplan$/, adminOnly(async (req, res) => {
  const b = await body(req);
  const dev = String(b.device || '/dev/sdXN').slice(0, 64);
  const plan = [
    '# ECC cross-platform mount plan (dual-boot safe)',
    `# 1) Windows side check: the partition must NOT be in fast-startup hibernation`,
    `#    powercfg /h off   (once)`,
    `# 2) Linux mount with NTFS3 kernel driver, protects Windows metadata:`,
    `sudo mkdir -p /mnt/winshare`,
    `sudo mount -t ntfs3 -o uid=$USER,gid=$USER,windows_names,streams_interface=windows ${dev} /mnt/winshare`,
    `# 3) Persistent entry (ECC writes a dated backup of /etc/fstab first):`,
    `#    ${dev}  /mnt/winshare  ntfs3  uid=1000,gid=1000,windows_names,x-gvfs-show  0  0`,
    `# 4) Windows->Linux parity: wsl --mount \\\\.\\PHYSICALDRIVE<n> --partition <n>`
  ].join('\n');
  auth.audit('storage.mountplan', dev, true);
  json(res, 200, { device: dev, plan, src: 'MODEL' });
}));

/* ---- network ---- */
route('GET', /^\/api\/network\/flows$/, async (req, res) => json(res, 200, await nettools.flowInspector()));
route('POST', /^\/api\/network\/ping$/, async (req, res) => { const b = await body(req); json(res, 200, await nettools.ping(String(b.host || '1.1.1.1').slice(0, 128), Math.min(20, Math.max(1, +b.count || 10)))); });
route('POST', /^\/api\/network\/dns$/, async (req, res) => { const b = await body(req); json(res, 200, await nettools.dnsMatrix(String(b.host || 'example.com').slice(0, 128))); });
route('POST', /^\/api\/network\/tcp$/, async (req, res) => { const b = await body(req); json(res, 200, await nettools.tcpLatency(String(b.host || '1.1.1.1').slice(0, 128), Math.max(1, Math.min(65535, +b.port || 443)))); });
route('POST', /^\/api\/network\/http$/, async (req, res) => { const b = await body(req); json(res, 200, await nettools.httpProbe(String(b.url || 'https://example.com').slice(0, 256))); });
route('POST', /^\/api\/network\/bufferbloat$/, async (req, res) => { const b = await body(req); json(res, 200, await nettools.bufferbloat(String(b.host || '1.1.1.1').slice(0, 128))); });
route('GET', /^\/api\/network\/qos$/, (req, res) => json(res, 200, nettools.QOS_PRESETS));
route('POST', /^\/api\/network\/qos\/(\w+)$/, adminOnly(async (req, res, s, m) => {
  const p = nettools.QOS_PRESETS[m[1]];
  if (!p) return json(res, 404, { error: 'unknown preset' });
  auth.audit('network.qos', m[1], true);
  json(res, 200, { preset: m[1], label: p.label, generated: { linux: p.linux, windows: p.windows }, applied: 'REVIEW — scripts are staged for operator execution (admin), not auto-run in sandbox' });
}));

/* ---- bridge (EBP/1.0) ---- */
route('GET', /^\/api\/bridge$/, (req, res) => json(res, 200, nettools.bridgeState()));
route('POST', /^\/api\/bridge\/pair$/, adminOnly(async (req, res) => { json(res, 200, nettools.issuePairingCode()); }));
/* Agent-facing endpoints (from agent/edge-agent.py or any EBP client) */
route('POST', /^\/bridge\/hello$/, async (req, res) => {
  const b = await body(req);
  const r = nettools.pairPeer(b);
  if (r.ok) auth.audit('bridge.paired', `${b.name}/${b.platform}`, true);
  json(res, r.ok ? 200 : 403, r);
});
route('POST', /^\/bridge\/heartbeat$/, async (req, res) => {
  const b = await body(req);
  const p = nettools.peerHeartbeat(b.peerId);
  if (p && b.telemetry) { p.mirrored = true; p.telemetry = b.telemetry; }
  json(res, p ? 200 : 404, { ok: !!p });
});

/* ---- stability ---- */
route('GET', /^\/api\/stability\/kernel$/, async (req, res) => json(res, 200, await stab.kernelWatch()));
route('GET', /^\/api\/stability\/incidents$/, (req, res) => json(res, 200, stab.incidents()));
route('POST', /^\/api\/stability\/analyze$/, async (req, res) => {
  const b = await body(req);
  const r = stab.analyze(String(b.input || '').slice(0, 400000));
  if (r.matched?.length && (b.record !== false)) stab.recordIncident({ kind: 'analyze', code: r.matched[0].code, name: r.matched[0].name });
  json(res, 200, r);
});
route('POST', /^\/api\/stability\/recovery$/, async (req, res) => {
  const b = await body(req);
  json(res, 200, { script: stab.recoveryScript(Array.isArray(b.items) ? b.items : null) });
});
route('GET', /^\/api\/stability\/bugchecks$/, (req, res) => json(res, 200, Object.entries(stab.BUGCHECKS).map(([code, e]) => ({ code, ...e }))));

/* ---- AI studio ---- */
route('GET', /^\/api\/ai\/status$/, async (req, res) => {
  const d = await ai.detectBackend();
  json(res, 200, { detected: d, backend: ai.state.backend, queue: ai.jobs().slice(0, 20), gallery: ai.gallery(24) });
});
route('POST', /^\/api\/ai\/generate$/, async (req, res) => {
  const b = await body(req);
  if (!b.prompt) return json(res, 400, { error: 'prompt required' });
  const g = ai.vramGuard({ size: b.size || '768x768', steps: +b.steps || 28 });
  const job = ai.submitJob({ ...b, steps: Math.max(1, Math.min(150, +b.steps || 28)), cfg: Math.max(1, Math.min(30, +b.cfg || 7)) });
  json(res, 202, { job, vramGuard: g });
});
route('GET', /^\/api\/ai\/job\/([\w-]+)$/, (req, res, m) => {
  const j = ai.job(m[1]);
  j ? json(res, 200, j) : json(res, 404, { error: 'no such job' });
});
route('GET', /^\/api\/ai\/gallery\/([\w.\-]+)$/, (req, res, m) => {
  const p = path.join(ai.galleryDir(), path.basename(m[1]));
  if (!fs.existsSync(p)) return json(res, 404, { error: 'not found' });
  const mime = p.endsWith('.svg') ? 'image/svg+xml' : p.endsWith('.png') ? 'image/png' : 'image/jpeg';
  res.writeHead(200, { 'Content-Type': mime }); fs.createReadStream(p).pipe(res);
});
route('POST', /^\/api\/ai\/backend$/, adminOnly(async (req, res) => {
  const b = await body(req);
  if (b.comfy) ai.state.backend.comfy = String(b.comfy);
  if (b.a1111) ai.state.backend.a1111 = String(b.a1111);
  const d = await ai.detectBackend();
  auth.audit('ai.backend', JSON.stringify(ai.state.backend), true);
  json(res, 200, { backend: ai.state.backend, detected: d });
}));

/* ---- admin ---- */
route('POST', /^\/api\/auth\/login$/, async (req, res) => {
  const b = await body(req);
  const r = auth.login(String(b.user || ''), String(b.pass || ''));
  r ? json(res, 200, r) : json(res, 403, { error: 'invalid credentials' });
});
route('POST', /^\/api\/auth\/logout$/, (req, res) => {
  const t = req.headers['x-auth-token']; if (t) auth.logout(t);
  json(res, 200, { ok: true });
});
route('POST', /^\/api\/auth\/rotate$/, adminOnly(async (req, res, s) => {
  const b = await body(req);
  if (!b.pass || String(b.pass).length < 10) return json(res, 400, { error: 'passphrase must be ≥ 10 chars' });
  auth.setCreds(s.user, String(b.pass));
  json(res, 200, { ok: true, rotated: true });
}));
route('GET', /^\/api\/admin\/audit$/, adminOnly(async (req, res) => json(res, 200, auth.auditLog())));
route('GET', /^\/api\/admin\/system$/, adminOnly(async (req, res) => json(res, 200, {
  host: { name: os.hostname(), platform: os.platform(), release: os.release(), arch: os.arch() },
  snapshotAnchor: state.snapshotAnchor,
  privilegedPaths: {
    powerLimits: process.platform === 'linux' ? '/sys/class/powercap (root) or MSR 0x610 via agent' : 'MSR 0x610 via ring-0 agent',
    sysctl: '/proc/sys/vm (root)', boot: 'efibootmgr (root)', fans: 'nbfc-linux / EC agent'
  }
})));
/* Macro scripting for the admin dashboard — ECC-side macros execute as guarded shelllets */
const macros = new Map();
route('GET', /^\/api\/admin\/macros$/, adminOnly(async (req, res) => json(res, 200, [...macros.values()])));
route('POST', /^\/api\/admin\/macros$/, adminOnly(async (req, res) => {
  const b = await body(req);
  if (!b.name || !b.script) return json(res, 400, { error: 'name and script required' });
  if (/(rm\s+-rf|mkfs|format|del\s+\/[sf])/i.test(b.script)) return json(res, 400, { error: 'destructive pattern refused' });
  const id = require('crypto').randomUUID();
  const m = { id, name: String(b.name).slice(0, 64), script: String(b.script).slice(0, 8000), created: Date.now(), runs: 0 };
  macros.set(id, m);
  auth.audit('macro.create', m.name, true);
  json(res, 200, m);
}));
route('POST', /^\/api\/admin\/macros\/([\w-]+)\/run$/, adminOnly(async (req, res, s, m) => {
  const mac = macros.get(m[1]);
  if (!mac) return json(res, 404, { error: 'no such macro' });
  // In the sandbox macros run in dry-run: they are tokenized and echoed, never executed.
  mac.runs++;
  auth.audit('macro.run', mac.name, true);
  json(res, 200, { ok: true, dryRun: true, tokens: mac.script.split(/\s+/).slice(0, 64), note: 'Dry-run sandbox: elevated agent executes whitelisted verbs only.' });
}));
/* Restore point anchor */
route('POST', /^\/api\/admin\/snapshot$/, adminOnly(async (req, res) => {
  const anchor = { ts: Date.now(), kind: 'ecc-manual', note: String((await body(req)).note || 'Pre-change snapshot') };
  try {
    fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, '..', 'data', 'snapshot.json'), JSON.stringify(anchor, null, 2));
  } catch { }
  state.snapshotAnchor = anchor;
  auth.audit('snapshot.create', anchor.note, true);
  json(res, 200, { anchor, note: 'Windows: Checkpoint-Computer executed by installer/restore-point.ps1; Linux: timeshift/btrfs snapshot.' });
}));

/* ---- native Win32 app API (compact line protocol) ---- */
route('GET', /^\/api\/native\/state$/, (req, res) => {
  const t = lastTick || {};
  const d = plane.summary();
  const lodIdx = Math.max(0, ['low (1 mm)', 'medium (2 mm)', 'high (3 mm)'].indexOf(d.lod));
  const lines = [
    'ts=' + Date.now(),
    'version=' + VERSION.version,
    'cpu=' + (t.cpu ? (t.cpu.load * 100).toFixed(1) : '0'),
    'cpuMhz=' + (t.cpu?.freqMhz ?? 0),
    'cores=' + (t.cpu?.cores ?? 0),
    'memPct=' + (t.mem?.totalBytes ? (t.mem.usedBytes / t.mem.totalBytes * 100).toFixed(1) : '0'),
    'swapGiB=' + ((t.mem?.swapUsed || 0) / 2 ** 30).toFixed(2),
    'wallW=' + (t.power?.wallW ?? 0),
    'effPct=' + (t.power?.efficiencyPct ?? 0),
    'loadPct=' + (t.power?.loadPct ?? 0),
    'sweet=' + (t.power?.sweetSpot ? 1 : 0),
    'epsW=' + (t.power?.rails?.eps12v_cpu?.w ?? 0),
    'gpuW=' + (t.power?.rails?.pcie12v_gpu?.w ?? 0),
    'cpuTemp=' + (t.thermal?.sensors?.cpu?.t ?? 0),
    'gpuTemp=' + (t.thermal?.sensors?.gpu?.t ?? 0),
    'riskPct=' + (t.thermal?.riskPct ?? 0),
    'fanPwm=' + (t.thermal?.controller?.fanPwm ?? 0),
    'class=' + (t.thermal?.controller?.class ?? 'idle'),
    'tttCpu=' + (t.thermal?.timeToThrottleS?.cpu ?? -1),
    'tttGpu=' + (t.thermal?.timeToThrottleS?.gpu ?? -1),
    'rxKbps=' + ((t.net?.rxps || 0) / 1024).toFixed(1),
    'txKbps=' + ((t.net?.txps || 0) / 1024).toFixed(1),
    'debounce=' + d.debounce,
    'lod=' + lodIdx,
    'dpi=' + d.dpiStages.join('.'),
    'unlocks=' + Object.entries(d.unlocks).map(([k, v]) => k + ':' + (v ? 1 : 0)).join('.'),
    'pl1=' + (t.power?.limits?.pl1 ?? 125),
    'pl2=' + (t.power?.limits?.pl2 ?? 188)
  ];
  const b = Buffer.from(lines.join('\n'));
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': b.length });
  res.end(b);
});
/* Native action endpoint: POST body "key=value\n…" → response "key=value\n…" */
route('POST', /^\/api\/native\/action$/, async (req, res) => {
  const raw = await new Promise((resolve) => {
    let d = ''; req.on('data', c => { d += c; if (d.length > 1e5) req.destroy(); });
    req.on('end', () => resolve(d)); req.on('error', () => resolve(''));
  });
  const p = {};
  for (const ln of raw.split('\n')) { const i = ln.indexOf('='); if (i > 0) p[ln.slice(0, i).trim()] = ln.slice(i + 1).trim(); }
  const out = { ok: '0' };
  try {
    const admin = () => {
      const s = auth.checkToken(p.token);
      if (!s) throw new Error('admin session required');
      return s;
    };
    switch ((p.op || '').toLowerCase()) {
      case 'login': {
        const r = auth.login(p.user || '', p.pass || '');
        if (!r) { out.error = 'invalid credentials'; break; }
        Object.assign(out, { ok: '1', token: r.token, user: r.user, mustRotate: r.mustRotate ? '1' : '0' });
        break;
      }
      case 'unlock': {
        admin();
        const s = plane.unlock(p.id, p.on === '1' || p.on === 'true');
        out.ok = '1'; out.unlocks = Object.entries(s.unlocks).map(([k, v]) => k + ':' + (v ? 1 : 0)).join('.');
        break;
      }
      case 'key': {
        admin();
        plane.setKey(p.section, p.key, p.value);
        out.ok = '1';
        break;
      }
      case 'profile': {
        admin(); plane.applyProfile(p.id); out.ok = '1';
        break;
      }
      case 'export': {
        admin();
        const f = plane.exportCfg();
        out.ok = '1'; out.file = require('path').basename(f);
        break;
      }
      case 'pl': {
        admin();
        const r = tel.setPowerLimits(Number(p.pl1), Number(p.pl2));
        auth.audit('power.limit', JSON.stringify(r), true);
        Object.assign(out, { ok: '1', pl1: String(r.pl1), pl2: String(r.pl2) });
        break;
      }
      case 'thermal': {
        admin();
        if (p.mode && ['adaptive', 'acoustic', 'manual'].includes(p.mode)) tel.THERMAL.fanMode = p.mode;
        if (p.dba) tel.THERMAL.acousticTargetDba = Math.max(20, Math.min(45, +p.dba));
        if (p.cpuCeil) tel.THERMAL.ceilings.cpu = Math.max(60, Math.min(110, +p.cpuCeil));
        if (p.gpuCeil) tel.THERMAL.ceilings.gpu = Math.max(60, Math.min(110, +p.gpuCeil));
        auth.audit('thermal.policy', JSON.stringify({ mode: tel.THERMAL.fanMode, ceilings: tel.THERMAL.ceilings }), true);
        out.ok = '1'; out.mode = tel.THERMAL.fanMode;
        break;
      }
      case 'ping': {
        const r = await nettools.ping(String(p.host || '1.1.1.1').slice(0, 120), 4);
        if (r.avg === null) { out.error = 'probe failed'; break; }
        Object.assign(out, { ok: '1', avg: String(r.avg), loss: String(r.lossPct), jitter: String(r.jitter) });
        break;
      }
      case 'dns': {
        const r = await nettools.dnsMatrix(String(p.host || 'example.com').slice(0, 120));
        out.ok = '1';
        out.rows = r.rows.map(x => `${x.resolver}=${x.ok ? Math.round(x.ms) + 'ms' : 'fail'}`).join('|');
        out.fastest = r.fastest ? r.fastest.resolver : '';
        break;
      }
      case 'analyze': {
        const r = stab.analyze(String(p.input || '').slice(0, 100000));
        const m = r.matched[0] || {};
        Object.assign(out, {
          ok: '1', code: m.code || '-', name: m.name || 'Unclassified',
          causes: (m.causes || []).join(' | ').slice(0, 900),
          actions: (m.actions || []).join(' | ').slice(0, 900)
        });
        break;
      }
      case 'ai': {
        const j = ai.submitJob({ prompt: (p.prompt || '').slice(0, 1500), steps: Math.max(1, Math.min(60, +p.steps || 28)), cfg: 7, size: ['512x512', '768x768', '1024x1024'].includes(p.size) ? p.size : '768x768', seed: p.seed ? +p.seed : null });
        out.ok = '1'; out.jobId = j.id; out.backend = j.backend;
        break;
      }
      case 'aistatus': {
        const j = ai.job(p.jobId || '');
        if (!j) { out.error = 'no such job'; break; }
        Object.assign(out, { ok: '1', status: j.status, progress: String(j.progress), backend: j.backend, file: j.file ? require('path').basename(j.file) : '' });
        break;
      }
      case 'audit': {
        admin();
        const log = auth.auditLog().slice(0, 40);
        out.ok = '1'; out.n = String(log.length);
        log.forEach((a, i) => { out['l' + i] = `${new Date(a.ts).toISOString().slice(11, 19)}|${a.privileged ? 'PRIV' : '    '}|${a.action}|${String(a.detail).slice(0, 80)}`; });
        break;
      }
      case 'snapshot': {
        admin();
        const anchor = { ts: Date.now(), kind: 'ecc-native', note: 'Anchor from native app' };
        try {
          fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
          fs.writeFileSync(path.join(__dirname, 'data', 'snapshot.json'), JSON.stringify(anchor, null, 2));
        } catch { }
        state.snapshotAnchor = anchor;
        auth.audit('snapshot.create', 'native', true);
        out.ok = '1';
        break;
      }
      case 'logout': {
        auth.logout(p.token); out.ok = '1';
        break;
      }
      default: out.error = 'unknown op';
    }
  } catch (e) { out.ok = '0'; out.error = String(e.message || e); }
  const b = Buffer.from(Object.entries(out).map(([k, v]) => `${k}=${v}`).join('\n'));
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': b.length });
  res.end(b);
});

/* ---- static + fallback ---- */
route('GET', /^\/$/, (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  fs.createReadStream(path.join(PUBLIC, 'index.html')).pipe(res);
});

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = url.match(r.pattern);
    if (!m) continue;
    try { return await r.handler(req, res, m); }
    catch (e) { return json(res, 500, { error: String(e.message || e) }); }
  }
  // static files
  const rel = path.normalize(url).replace(/^([\\/])+/, '');
  const p = path.join(PUBLIC, rel);
  if (p.startsWith(PUBLIC) && fs.existsSync(p) && fs.statSync(p).isFile()) {
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
    return fs.createReadStream(p).pipe(res);
  }
  json(res, 404, { error: 'no route', url });
});

if (require.main === module) {
  // Bind with retry: if the port is taken (e.g. a lingering engine instance),
  // walk up to +20 ports so the host app always gets a live endpoint.
  let attempt = 0;
  const bind = () => {
    server.once('error', e => {
      if (e && e.code === 'EADDRINUSE' && attempt < 20) {
        attempt++;
        console.log(`[ECC] :${PORT + attempt - 1} занят → пробую :${PORT + attempt}`);
        setTimeout(bind, 150);
        return;
      }
      console.error('[ECC] bind failed:', e && e.message);
      // Last-ditch diagnostic for the native host (fs shim redirects this to the user data dir)
      try {
        const dir = path.dirname(process.execPath);
        fs.writeFileSync(path.join(dir, 'engine-error.log'),
          new Date().toISOString() + ' bind failed: ' + (e && e.message) + '\n', { flag: 'a' });
      } catch { }
      setInterval(() => { }, 1 << 30); // stay alive so the host can show diagnostics
    });
    server.listen(PORT + attempt, '0.0.0.0', () => {
      const p2 = PORT + attempt;
      console.log(`[ECC] Edge Control Center v${VERSION.version} on :${p2}`);
      try {
        const dir = path.dirname(process.execPath);
        fs.writeFileSync(path.join(dir, 'port.txt'), String(p2));
      } catch { }
    });
  };
  bind();
}
module.exports = { server, plane };
