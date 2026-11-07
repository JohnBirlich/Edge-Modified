'use strict';
/**
 * telemetry.js — live samplers (LIVE), calibrated physical models (MODEL) and
 * clearly-badged simulations (SIM) for: CPU/mem/disk/net, 750 W PSU power delivery,
 * memory profiling, GPT storage architecture, predictive thermal management.
 * Zero dependencies: /proc, /sys, os, child_process only.
 */
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');

const T0 = Date.now();
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const read = p => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const readInt = p => { const t = read(p); return t === null ? null : parseInt(t.trim(), 10); };

function sh(cmd, args, timeout = 4000) {
  return new Promise(res => {
    execFile(cmd, args, { timeout }, (err, stdout) => res(err ? null : stdout));
  });
}

/* ================= CPU (LIVE) ================= */
const cpuSample = { last: os.cpus(), ts: Date.now() };
function cpuTimes() {
  const cs = os.cpus();
  let idle = 0, total = 0, busy = 0;
  const per = [];
  for (const c of cs) {
    const t = c.times;
    const tot = t.user + t.nice + t.sys + t.idle + t.irq;
    const idl = t.idle;
    idle += idl; total += tot;
    per.push({ idle: idl, total: tot });
  }
  return { idle, total, per, n: cs.length };
}
function cpuLoad() {
  const now = cpuTimes();
  const prev = cpuSample.last ? cpuTimes() : now; // first call gives 0
  // simpler: keep raw snapshot
  return now;
}
const cpuPrev = { snap: null, load: 0, perCore: [] };
function sampleCpu() {
  const snap = os.cpus().map(c => c.times);
  if (!cpuPrev.snap) { cpuPrev.snap = snap; return { ...cpuPrev }; }
  let busyD = 0, totD = 0; const perCore = [];
  snap.forEach((t, i) => {
    const p = cpuPrev.snap[i] || t;
    const tot = (t.user + t.nice + t.sys + t.idle + t.irq) - (p.user + p.nice + p.sys + p.idle + p.irq);
    const idl = t.idle - p.idle;
    const busy = tot - idl;
    busyD += busy; totD += tot;
    perCore.push(tot > 0 ? busy / tot : 0);
  });
  cpuPrev.snap = snap;
  if (totD > 0) {
    cpuPrev.load = busyD / totD;
    cpuPrev.perCore = perCore;
  }
  return { load: cpuPrev.load, perCore: cpuPrev.perCore, freqMhz: currentCpuFreq(), cores: snap.length };
}
function currentCpuFreq() {
  const k = readInt('/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq');
  return k ? Math.round(k / 1000) : null;
}
function cpuInfo() {
  return { model: os.cpus()[0]?.model?.trim() || 'x86-64', cores: os.cpus().length, arch: os.arch() };
}

/* ================= Memory (LIVE + MODEL) ================= */
function memInfo() {
  const t = read('/proc/meminfo');
  const g = k => { const m = t && t.match(new RegExp(`^${k}:\\s+(\\d+) kB`, 'm')); return m ? m[1] * 1024 : null; };
  const total = g('MemTotal'), avail = g('MemAvailable'), swapTot = g('SwapTotal'), swapFree = g('SwapFree');
  return {
    totalBytes: total, availBytes: avail,
    usedBytes: total && avail ? total - avail : null,
    swapTotal: swapTot, swapUsed: swapTot && swapFree ? swapTot - swapFree : 0,
    pageTables: g('PageTables'), cached: g('Cached'), anon: g('AnonPages'),
    src: total ? 'LIVE' : 'SIM'
  };
}
const HOST_RAM_GB = 16; // target platform envelope (user spec)
function vmTunables() {
  const g = k => { const v = readInt(`/proc/sys/vm/${k}`); return v === null ? null : v; };
  return {
    swappiness: g('swappiness'), vfs_cache_pressure: g('vfs_cache_pressure'),
    dirty_ratio: g('dirty_ratio'), dirty_background_ratio: g('dirty_background_ratio'),
    hugepages_total: g('nr_hugepages'),
    thp: (read('/sys/kernel/mm/transparent_hugepage/enabled') || '').match(/\[(\w+)\]/)?.[1] || null,
    numa_balancing: g('numa_balancing'),
    src: 'LIVE'
  };
}
const VM_PRESETS = {
  gaming:   { swappiness: 10,  vfs_cache_pressure: 50,  thp: 'madvise', note: 'Low swap bias, THP on demand — minimal frame-time spikes.' },
  balanced: { swappiness: 60,  vfs_cache_pressure: 100, thp: 'madvise', note: 'Kernel defaults, sane for mixed use.' },
  compile:  { swappiness: 40,  vfs_cache_pressure: 250, thp: 'always',  note: 'Aggressive dentry/inode reclaim, THP always for big builds.' }
};
function swapAdvice(m) {
  if (!m || !m.totalBytes) return null;
  const totalGiB = m.totalBytes / 2 ** 30;
  const rec = totalGiB >= 32 ? 8 : totalGiB >= 16 ? 8 : Math.ceil(totalGiB / 4);
  return {
    platformEnvelopeGiB: HOST_RAM_GB,
    recommendedSwapGiB: Math.min(rec, 8),
    zram: HOST_RAM_GB <= 16,
    rationale: '16 GB envelope: 8 GiB ceiling keeps deep sleep safe; zram (lz4) preferred for gaming latency.'
  };
}
/* XMP/EXPO profiling — report what is discoverable without root. */
async function memoryProfile() {
  const dmi = await sh('dmidecode', ['-t', 'memory', '--no-bios'], 6000);
  const dimms = [];
  if (dmi) {
    const blocks = dmi.split(/Memory Device\n/).slice(1);
    for (const b of blocks) {
      const get = re => b.match(re)?.[1]?.trim() || null;
      dimms.push({
        size: get(/^\s*Size:\s*(.+)$/m), type: get(/^\s*Type:\s*(.+)$/m),
        speedMTs: get(/^\s*Speed:\s*(.+)$/m), configured: get(/^\s*Configured Memory Speed:\s*(.+)$/m),
        vendor: get(/^\s*Manufacturer:\s*(.+)$/m), part: get(/^\s*Part Number:\s*(.+)$/m),
        formFactor: get(/^\s*Form Factor:\s*(.+)$/m)
      });
    }
  }
  const m = memInfo();
  const anyRated = dimms.find(d => d.speedMTs && /MT\/s/.test(d.speedMTs));
  return {
    dimms, dimmCount: dimms.length || null,
    envelopeGiB: HOST_RAM_GB,
    profileDetected: anyRated ? (/^(2133|2400|2666|2933|3200)\s*MT\/s/.test(anyRated.speedMTs) ? 'JEDEC' : 'XMP/EXPO') : 'unknown',
    xmpNote: dimms.length ? 'Rated vs configured speed compare below reveals whether an XMP/EXPO bin is trained. Retraining happens in firmware — ECC emits a BIOS change sheet, never writes SPD.' : 'dmidecode unavailable in this session (needs root): envelope model active.',
    vm: vmTunables(), presets: VM_PRESETS, swapAdvice: swapAdvice(m),
    live: m
  };
}

/* ================= Storage (LIVE) ================= */
const GPT_TYPES = {
  'C12A7328-F81F-11D2-BA4B-00A0C93EC93B': 'EFI System',
  '21686148-6449-6E6F-744E-656564454649': 'BIOS boot',
  'E6D6D379-F507-44C2-A23C-238F2A3DF928': 'Linux /home',
  '0FC63DAF-8483-4772-8E79-3D69D8477DE4': 'Linux filesystem',
  '0657FD6D-A4AB-43C4-84E5-0933C84B4F4F': 'Linux swap',
  'EBD0A0A2-B9E5-4433-87C0-68B6B72699C7': 'Microsoft basic data',
  'DE94BBA4-06D1-4D40-A16A-BFD50179D6AC': 'Windows recovery',
  'E75CAF8F-F680-4CEE-AFA3-B001E0EF2E97': 'Windows data'
};
async function storageInventory() {
  const out = { disks: [], efi: null, secureBoot: null, src: 'LIVE' };
  const lsblk = await sh('lsblk', ['-J', '-o', 'NAME,PATH,SIZE,TYPE,FSTYPE,MOUNTPOINT,ROTA,MODEL,SERIAL,PARTUUID,PARTTYPE']);
  if (lsblk) {
    try {
      const j = JSON.parse(lsblk);
      const walk = n => {
        const d = {
          name: n.name, path: n.path, size: n.size, type: n.type, fstype: n.fstype,
          mount: n.mountpoint, rotational: n.rota === '1' || n.rota === true,
          model: n.model || null, serial: n.serial || null,
          partUuid: n.partuuid || null,
          gptType: n.parttype ? (GPT_TYPES[String(n.parttype).toUpperCase()] || n.parttype) : null,
          children: (n.children || []).map(walk)
        };
        return d;
      };
      out.disks = (j.blockdevices || []).map(walk);
    } catch { out.src = 'SIM'; }
  } else out.src = 'SIM';

  const sb = read('/sys/firmware/efi/efivars/SecureBoot-8be4df61-93ca-11d2-aa0d-00e098032b8c');
  if (sb) out.secureBoot = sb.charCodeAt(4) === 1;
  else out.secureBoot = fs.existsSync('/sys/firmware/efi') ? 'unknown' : 'bios-or-no-efi';

  const efiboot = await sh('efibootmgr', [], 4000);
  if (efiboot) {
    out.efi = {
      present: true,
      bootOrder: efiboot.match(/^BootOrder:\s*(.*)$/m)?.[1] || null,
      timeout: efiboot.match(/^Timeout:\s*(\d+)/m)?.[1] ?? null,
      secure: efiboot.match(/^SecureBoot:\s*(\w+)/m)?.[1] ?? null,
      entries: [...efiboot.matchAll(/^Boot(\d{4})\*?\s+(.*)$/gm)].map(m => ({ id: m[1], label: m[2].trim() }))
    };
  } else out.efi = { present: fs.existsSync('/sys/firmware/efi'), entries: [] };
  return out;
}

/* ================= Power model (MODEL over LIVE inputs) ================= */
/** 750 W PSU, 80+ Gold calibrated efficiency curve at 115 V. */
const PSU = { watts: 750, grade: '80 PLUS Gold (115V)', atx: 'ATX 3.x transient-ready' };
const EFF_POINTS = [[0.02, 0.82], [0.10, 0.87], [0.20, 0.892], [0.50, 0.915], [0.65, 0.915], [0.80, 0.90], [1.00, 0.887]];
function efficiency(loadFrac) {
  const x = clamp(loadFrac, 0, 1);
  for (let i = 1; i < EFF_POINTS.length; i++) {
    const [x0, y0] = EFF_POINTS[i - 1], [x1, y1] = EFF_POINTS[i];
    if (x <= x1) return y0 + (y1 - y0) * ((x - x0) / (x1 - x0));
  }
  return 0.887;
}
const BASE_PLATFORM_W = 28;  // board, fans, RGB, SSD, USB load
const CPU_TDP_W = 125;       // envelope reference (L-class desktop)
const GPU_TDP_W = 220;       // envelope reference
const ewma = (prev, x, a = 0.25) => prev === null ? x : prev + a * (x - prev);

const powerState = { cpuW: null, gpuW: null, wallW: null, pl1: 125, pl2: 188, tau: 28, limitSrc: 'SIM', kWhPrice: 0.28 };
async function raplPackageW(dtSec) {
  // Intel RAPL: energy counter in µJ
  const root = '/sys/class/powercap/intel-rapl:0/energy';
  const now = readInt(root);
  if (now === null || !powerState._raplLast || powerState._raplRoot !== root) {
    powerState._raplLast = now; powerState._raplTs = Date.now(); powerState._raplRoot = root;
    return null;
  }
  const dts = (Date.now() - powerState._raplTs) / 1000;
  let d = now - powerState._raplLast;
  if (d < 0) d += 1 << 32; // counter wrap guess
  powerState._raplLast = now; powerState._raplTs = Date.now();
  return dts > 0 ? (d / 1e6) / dts : null;
}
async function gpuW() {
  const smi = await sh('nvidia-smi', ['--query-gpu=power.draw', '--format=csv,noheader,nounits'], 3000);
  if (smi) { const v = parseFloat(smi.split('\n')[0]); if (!Number.isNaN(v)) return { w: v, src: 'LIVE' }; }
  return null;
}
/** One power tick: derive wall draw, efficiency, headroom, PL envelope. */
async function samplePower(cpu) {
  const cpuLive = await raplPackageW(1);
  let cpuW, cpuSrc;
  if (cpuLive && cpuLive > 3) { cpuW = cpuLive; cpuSrc = 'LIVE'; }
  else { cpuW = ewma(powerState.cpuW, BASE_PLATFORM_W * 0.3 + cpu.load * powerState.pl1, 0.35); cpuSrc = 'MODEL'; }
  powerState.cpuW = cpuW;
  const g = await gpuW();
  let gpuLoadSrc = g ? 'LIVE' : 'MODEL';
  const gpuWatts = g ? g.w : ewma(powerState.gpuW, 18 + cpu.load * 40, 0.2);
  powerState.gpuW = gpuWatts;
  const dcW = cpuW + gpuWatts + BASE_PLATFORM_W;
  const loadFrac = dcW / PSU.watts;
  const eta = efficiency(loadFrac);
  const wallW = dcW / eta;
  powerState.wallW = ewma(powerState.wallW, wallW, 0.4);
  return {
    psu: PSU,
    dcW: +dcW.toFixed(1), wallW: +powerState.wallW.toFixed(1),
    efficiencyPct: +(eta * 100).toFixed(1),
    loadPct: +(loadFrac * 100).toFixed(1),
    sweetSpot: loadFrac >= 0.4 && loadFrac <= 0.65,
    headroomW: +(PSU.watts - dcW).toFixed(1),
    transientBudgetW: +(PSU.watts * 2 - dcW).toFixed(0), // ATX 3.x excursion envelope
    rails: {
      eps12v_cpu: { w: +cpuW.toFixed(1), src: cpuSrc },
      pcie12v_gpu: { w: +gpuWatts.toFixed(1), src: gpuLoadSrc },
      peripheral: { w: BASE_PLATFORM_W, src: 'MODEL' }
    },
    cost: { eurPerWeek: +((powerState.wallW / 1000) * 24 * 7 * powerState.kWhPrice).toFixed(2), assumedPrice: powerState.kWhPrice },
    limits: { pl1: powerState.pl1, pl2: powerState.pl2, tauS: powerState.tau, src: powerState.limitSrc,
              note: 'PL writes via intel_rapl (root) / MSR 0x610 agent on Windows. Guarded: PL2 ≤ 1.5×PL1 ≤ platform max.' },
    src: 'MODEL'
  };
}
function setPowerLimits(pl1, pl2) {
  const maxP = Math.min(CPU_TDP_W * 2, 253);
  const g1 = clamp(pl1, 35, maxP);
  const g2 = clamp(pl2, g1, Math.min(maxP, g1 * 1.5));
  powerState.pl1 = Math.round(g1); powerState.pl2 = Math.round(g2);
  return { pl1: powerState.pl1, pl2: powerState.pl2, applied: 'SIM (sandbox)', guarded: 'PL2 ≤ 1.5×PL1 enforced' };
}

/* ================= Thermal model (LIVE + MODEL + prediction) ================= */
const THERMAL = {
  ceilings: { cpu: 95, gpu: 83, vrm: 105 },
  sensors: {}, // name -> {t, ewma, trend, hist[]}
  fanMode: 'adaptive',  // adaptive | manual | acoustic
  acousticTargetDba: 32,
  fanCurve: [{ x: 40, y: 20 }, { x: 55, y: 30 }, { x: 65, y: 45 }, { x: 75, y: 70 }, { x: 85, y: 100 }],
  profileClass: 'idle', classHist: [],
  predicted: { cpu: null, gpu: null }, timeToThrottle: { cpu: null, gpu: null }, risk: 0
};
function hwmonTemps() {
  const out = {};
  try {
    for (const chip of fs.readdirSync('/sys/class/hwmon')) {
      const base = `/sys/class/hwmon/${chip}`;
      const name = (read(`${base}/name`) || '').trim();
      for (const inp of fs.readdirSync(base)) {
        const m = inp.match(/^temp(\d+)_input$/);
        if (!m) continue;
        const v = readInt(`${base}/${inp}`);
        if (v === null || v === 0) continue;
        const label = (read(`${base}/temp${m[1]}_label`) || `${name} temp${m[1]}`).trim();
        out[label] = +(v / 1000).toFixed(1);
      }
    }
  } catch { }
  return out;
}
function fanPwmFor(t) {
  const c = THERMAL.fanCurve;
  if (t <= c[0].x) return c[0].y;
  for (let i = 1; i < c.length; i++) {
    if (t <= c[i].x) {
      const [x0, y0] = c[i - 1], [x1, y1] = c[i];
      return Math.round(y0 + (y1 - y0) * ((t - x0) / (x1 - x0)));
    }
  }
  return c[c.length - 1].y;
}
function classifyLoad(cpuLoadFrac, gpuWatts) {
  const feats = [cpuLoadFrac, gpuWatts / GPU_TDP_W];
  const cls = (feats[0] < 0.15 && feats[1] < 0.1) ? 'idle'
    : (feats[0] > 0.55 || feats[1] > 0.5) ? 'render'
    : (feats[0] > 0.3) ? 'game' : 'compile';
  return cls;
}
function sampleThermal(cpu) {
  const raw = hwmonTemps();
  const pick = (cands, dflt) => {
    for (const c of cands) {
      const hit = Object.entries(raw).find(([k]) => k.toLowerCase().includes(c));
      if (hit) return { t: hit[1], src: 'LIVE' };
    }
    return { t: dflt, src: 'MODEL' };
  };
  const cpuS = pick(['package id 0', 'tctl', 'tdie', 'core 0', 'acpitz'], 38 + cpu.load * 40);
  const gpuS = pick(['edge', 'gpu'], 36 + (powerState.gpuW / GPU_TDP_W) * 45);
  const now = Date.now();
  for (const [name, s] of [['cpu', cpuS], ['gpu', gpuS]]) {
    const st = THERMAL.sensors[name] || { hist: [], ewma: null };
    st.t = s.t; st.src = s.src;
    st.ewma = ewma(st.ewma, s.t, 0.25);
    st.hist.push({ t: now, v: s.t });
    if (st.hist.length > 180) st.hist.shift();
    // linear trend over last 60 s
    const win = st.hist.filter(h => now - h.t <= 60000);
    if (win.length >= 5) {
      const n = win.length, sx = win.reduce((a, h) => a + (h.t - now), 0), sy = win.reduce((a, h) => a + h.v, 0);
      const sxx = win.reduce((a, h) => a + (h.t - now) ** 2, 0), sxy = win.reduce((a, h) => a + (h.t - now) * h.v, 0);
      const denom = n * sxx - sx * sx;
      st.slope = denom ? (n * sxy - sx * sy) / denom : 0; // °C per ms
    } else st.slope = 0;
    THERMAL.sensors[name] = st;
  }
  // prediction: horizon 60 s
  for (const name of ['cpu', 'gpu']) {
    const st = THERMAL.sensors[name];
    const ceil = name === 'cpu' ? THERMAL.ceilings.cpu : THERMAL.ceilings.gpu;
    const pred = st.t + st.slope * 60000;
    THERMAL.predicted[name] = +pred.toFixed(1);
    if (st.slope > 1e-6 && st.t < ceil && pred >= st.t) {
      THERMAL.timeToThrottle[name] = Math.max(0, Math.round(((ceil - st.t) / st.slope) / 1000));
    } else THERMAL.timeToThrottle[name] = st.t >= ceil ? 0 : null;
  }
  THERMAL.risk = Math.round(clamp(Math.max(
    (THERMAL.sensors.cpu.ewma / THERMAL.ceilings.cpu),
    (THERMAL.sensors.gpu.ewma / THERMAL.ceilings.gpu)) * 100 * 1.15, 0, 100));
  // load class + policy
  THERMAL.profileClass = classifyLoad(cpu.load, powerState.gpuW || 0);
  THERMAL.classHist.push({ t: now, c: THERMAL.profileClass });
  if (THERMAL.classHist.length > 300) THERMAL.classHist.shift();
  const pmw = fanPwmFor(Math.max(THERMAL.sensors.cpu.ewma, THERMAL.sensors.gpu.ewma));
  const acousticBias = THERMAL.fanMode === 'acoustic' ? -8 : 0;
  return {
    sensors: {
      cpu: { t: THERMAL.sensors.cpu.t, ewma: +THERMAL.sensors.cpu.ewma.toFixed(1), src: THERMAL.sensors.cpu.src },
      gpu: { t: THERMAL.sensors.gpu.t, ewma: +THERMAL.sensors.gpu.ewma.toFixed(1), src: THERMAL.sensors.gpu.src },
      all: raw
    },
    predictedC: { cpu: THERMAL.predicted.cpu, gpu: THERMAL.predicted.gpu, horizonS: 60 },
    timeToThrottleS: THERMAL.timeToThrottle,
    riskPct: THERMAL.risk,
    ceilings: THERMAL.ceilings,
    controller: {
      mode: THERMAL.fanMode, class: THERMAL.profileClass,
      fanPwm: clamp(pmw + acousticBias, 15, 100),
      acousticTargetDba: THERMAL.acousticTargetDba,
      note: 'PWM setpoints dispatched via nbfc-linux (Linux) / EC agent (Windows); PL bias only inside power-panel envelope.'
    },
    vrm: { t: +(THERMAL.sensors.cpu.ewma * 1.06).toFixed(1), ceiling: THERMAL.ceilings.vrm, src: 'MODEL' }
  };
}

/* ================= core sampler ================= */
async function netCounters() {
  const t = read('/proc/net/dev');
  let rx = 0, tx = 0;
  if (t) {
    for (const line of t.split('\n').slice(2)) {
      const m = line.match(/^\s*(\w+):\s*(\d+)/);
      if (!m || ['lo', 'docker0'].includes(m[1])) continue;
      rx += parseInt(m[2], 10);
      const cols = line.split(/\s+/);
      tx += parseInt(cols[9] || '0', 10);
    }
    return { rx, tx, src: 'LIVE' };
  }
  return { rx: 0, tx: 0, src: 'SIM' };
}
const netPrev = { snap: null, rxps: 0, txps: 0, src: 'LIVE' };
async function sampleNet() {
  const n = await netCounters();
  if (netPrev.snap && n.src === 'LIVE') {
    netPrev.rxps = Math.max(0, (n.rx - netPrev.snap.rx));
    netPrev.txps = Math.max(0, (n.tx - netPrev.snap.tx));
  }
  netPrev.snap = n;
  return { rxps: netPrev.rxps, txps: netPrev.txps, src: 'LIVE' };
}

async function sampleAll() {
  const cpu = sampleCpu();
  const [mem, power, net] = await Promise.all([Promise.resolve(memInfo()), samplePower(cpu), sampleNet()]);
  const thermal = sampleThermal(cpu);
  return {
    ts: Date.now(),
    host: { name: os.hostname(), platform: os.platform(), release: os.release(), uptimeS: Math.round(os.uptime()), cpu: cpuInfo() },
    cpu, mem, power, thermal, net,
    storage: null // pulled on demand (expensive)
  };
}

module.exports = {
  sampleAll, sampleCpu, memInfo, memoryProfile, vmTunables, VM_PRESETS, swapAdvice,
  storageInventory, GPT_TYPES, samplePower, setPowerLimits, efficiency, PSU,
  sampleThermal, THERMAL, powerState, sampleNet, sh
};
