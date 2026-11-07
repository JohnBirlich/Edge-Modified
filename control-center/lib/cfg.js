'use strict';
/**
 * cfg.js — Round-trip safe Cfg.ini parser + Edge 3327 device schema.
 * Preserves comments, key order and formatting so an exported file remains
 * byte-compatible in structure with what OemDrv.exe expects.
 */
const fs = require('fs');
const path = require('path');

class CfgFile {
  constructor(text) {
    this.lines = text.split(/\r?\n/);   // physical lines preserved
    this.sectionOf = new Map();         // lineIndex -> section name
    this.index = new Map();             // "section|key" -> lineIndex
    this._build();
  }
  _build() {
    this.index.clear(); this.sectionOf.clear();
    let section = '_pre';
    this.lines.forEach((line, i) => {
      const t = line.trim();
      const sm = t.match(/^\[(.+)\]$/);
      if (sm) { section = sm[1]; this.sectionOf.set(i, section); return; }
      const km = t.match(/^([^;[][^=]*)=(.*)$/);
      if (km) this.index.set(`${section}|${km[1].trim()}`, i);
    });
  }
  get(section, key, dflt = null) {
    const i = this.index.get(`${section}|${key}`);
    if (i === undefined) return dflt;
    const m = this.lines[i].match(/^([^=]*)=(.*)$/);
    return m ? m[2].trim() : dflt;
  }
  /** Set a key, creating it at the end of the section (before next [section]) if missing. */
  set(section, key, value) {
    const id = `${section}|${key}`;
    if (this.index.has(id)) {
      const i = this.index.get(id);
      const m = this.lines[i].match(/^([^=]*)=/);
      this.lines[i] = `${m[1]}=${value}`;
      return true;
    }
    // find insertion point: end of section
    let insertAt = this.lines.length;
    let inSection = section === '_pre';
    for (let i = 0; i < this.lines.length; i++) {
      const t = this.lines[i].trim();
      if (/^\[.+]$/.test(t)) {
        if (inSection) { insertAt = i; break; }
        inSection = (t.slice(1, -1) === section);
      } else if (inSection && t !== '') { insertAt = i + 1; }
    }
    this.lines.splice(insertAt, 0, `${key}=${value}`);
    this._build();
    return true;
  }
  serialize() { return this.lines.join('\r\n'); }
  /** Parsed view: { section: { key: value } } (comments skipped). */
  toObject() {
    const out = {}; let section = '_pre';
    for (const line of this.lines) {
      const t = line.trim();
      const sm = t.match(/^\[(.+)\]$/);
      if (sm) { section = sm[1]; out[section] = out[section] || {}; continue; }
      const km = t.match(/^([^;[][^=]*)=(.*)$/);
      if (km) (out[section] = out[section] || {})[km[1].trim()] = km[2].trim();
    }
    return out;
  }
}

/* ------------------------------------------------------------------ */
/* Device schema — ARDOR GAMING Edge 3327 (PAW-3327)                  */
/* ------------------------------------------------------------------ */

const DEVICE = {
  name: 'ARDOR GAMING Edge 3327',
  sensor: 'PixArt PAW-3327',
  vid: '0x2EA8', pid: '0x2203', sensorId: '0x3327',
  dpiRange: [200, 12400], dpiStep: 100,
  pollRates: [125, 250, 500, 1000],
  buttons: 9,
  lodSteps: ['low (1 mm)', 'medium (2 mm)', 'high (3 mm)']
};

/** Hidden modules the stock binary ships but keeps disabled. */
const UNLOCK_BANK = [
  { id: 'gun',     section: 'OPT',      key: 'ShowGUN',     title: 'Ballistics / "Gun" suite',
    desc: 'Per-weapon recoil compensation and rapid-fire tables (skins/gunico.png, tc_gun1..12).', dangerous: false },
  { id: 'report',  section: 'OPT',      key: 'ShowReport',  title: 'Diagnostics report page',
    desc: 'On-device report renderer: click latency, DPI drift, debounce stats.', dangerous: false },
  { id: 'lod',     section: 'SENSOR_1', key: 'ShowLOD',     title: 'Lift-Off Distance control',
    desc: 'LOD steps low/medium/high (1/2/3 mm) — the stock UI hides it entirely.', dangerous: false },
  { id: 'angle',   section: 'SENSOR_1', key: 'ShowAngleAdj',title: 'Angle snapping adjust',
    desc: 'Straight-line correction slider from the sensor register path.', dangerous: false },
  { id: 'sh',      section: 'SENSOR_1', key: 'ShowSH',      title: 'Shutter / symmetry tuning',
    desc: 'Frame shutter + DC symmetry registers for exotic pad surfaces.', dangerous: true },
];

/** Curated tuning profiles for the 3327 (applied as Cfg.ini patches). */
const PROFILES = {
  stock:   { label: 'Stock (factory)', patch: {} },
  esports: { label: 'Esports — 400/800 DPI, 1000 Hz, low LOD, no snap',
    patch: { OPT: { DefLOD: '2', Polling: '1000' },
             SENSOR_1: { DEFLEVEL: '1', 'DPI': '400,800,1200,2400,3200,6200,12400', DM: '7', DR: '0x500', ShowLOD: '1', ShowAngleAdj: '0' } } },
  fps:     { label: 'FPS — 800/1600 DPI, tight debounce 0x300, snap off',
    patch: { OPT: { DefLOD: '1' },
             SENSOR_1: { 'DPI': '800,1600,2400,3200,6400,8800,12400', DR: '0x300', DM: '5', ShowAngleAdj: '1' } } },
  mmo:     { label: 'MMO — macro-rich, loop macros, ms-key capture on',
    patch: { OPT: { MacroHasMsKey: '0x1', AutoSw: '1' },
             SENSOR_1: { 'DPI': '800,1200,1600,2400,3200,4800,6400' } } },
  creative:{ label: 'Creative — precision 600/1200, debounce long 0x700',
    patch: { OPT: { DefLOD: '3' },
             SENSOR_1: { 'DPI': '600,1200,1800,2400,3600,5400,7600', DR: '0x700', DM: '9' } } },
  silent:  { label: 'Office — 800 DPI, 500 Hz, deep debounce 0x900 (anti-doubleclick)',
    patch: { OPT: { DefLOD: '2' },
             SENSOR_1: { DEFLEVEL: '0', 'DPI': '800,1200,2000,3000,4000,5000,6000', DR: '0x900', DM: '11' } } },
};

function parseCsvInts(v) { return String(v).split(',').map(s => parseInt(s.trim(), 10)).filter(n => !Number.isNaN(n)); }
function parseRgb(v) {
  // "255,0,0, 0,0,255, ..." -> [{r,g,b}, ...]
  const nums = parseCsvInts(v);
  const out = [];
  for (let i = 0; i + 2 < nums.length + 1; i += 3) {
    if (i + 2 >= nums.length) break;
    out.push({ r: nums[i], g: nums[i + 1], b: nums[i + 2] });
  }
  return out;
}

/** Device-level summary derived from a parsed CfgFile. */
function deviceSummary(cfg) {
  const o = cfg.toObject();
  const opt = o.OPT || {};
  const s1 = o.SENSOR_1 || {};
  const dpi = parseCsvInts(s1['DPI'] || '');
  return {
    device: DEVICE,
    dpiStages: dpi,
    dpiActiveLevel: parseInt(s1.DEFLEVEL || '1', 10),
    dpiColors: parseRgb(s1.DC || ''),
    debounce: s1.DR || '0x500',
    debounceMode: parseInt(s1.DM || '7', 10),
    lod: DEVICE.lodSteps[parseInt(opt.DefLOD || '2', 10)] || 'unknown',
    polling: parseInt(opt.Polling || '1000', 10),
    unlocks: Object.fromEntries(UNLOCK_BANK.map(u => [u.id,
      String((u.section === 'OPT' ? opt : s1)[u.key] ?? '0') === '1'])),
    macroMsKey: (opt.MacroHasMsKey || '0x0') !== '0x0',
    hiddenKeys: {
      gunDefaults: opt.SnipMenu || null,
      ledParam: opt.LEDParam || null,
      brightParam: opt.BrightParam || null,
      sensorM1: opt.SensorM1 || null
    }
  };
}

/* ------------------------------------------------------------------ */
/* Config-plane service                                               */
/* ------------------------------------------------------------------ */

class ConfigPlane {
  constructor(repoRoot) {
    this.repoRoot = repoRoot;
    this.stockPath = path.join(repoRoot, 'Cfg.ini');
    this.workPath = process.env.ECC_CFG_WORK || path.join(repoRoot, 'profiles', 'runtime.ini');
    this.stockText = fs.readFileSync(this.stockPath, 'utf8').replace(/^\uFEFF/, '');
    this.work = new CfgFile(this.stockText);
    this.history = []; // {ts, action, detail}
    this.journal('init', 'config plane booted from stock Cfg.ini');
  }
  journal(action, detail) { this.history.unshift({ ts: Date.now(), action, detail }); if (this.history.length > 200) this.history.pop(); }
  summary() { return deviceSummary(this.work); }
  raw() { return this.work.serialize(); }
  setKey(section, key, value) {
    this.work.set(section, key, String(value));
    this.persist();
    this.journal('set', `${section}.${key}=${value}`);
    return this.summary();
  }
  unlock(id, on) {
    const u = UNLOCK_BANK.find(x => x.id === id);
    if (!u) throw new Error(`unknown unlock ${id}`);
    this.work.set(u.section, u.key, on ? '1' : '0');
    this.persist();
    this.journal('unlock', `${u.key}=${on ? 1 : 0} (${u.title})`);
    return this.summary();
  }
  applyProfile(name) {
    const p = PROFILES[name];
    if (!p) throw new Error(`unknown profile ${name}`);
    for (const [sec, kv] of Object.entries(p.patch))
      for (const [k, v] of Object.entries(kv)) this.work.set(sec, k, v);
    this.persist();
    this.journal('profile', `${name} — ${p.label}`);
    return this.summary();
  }
  exportCfg() {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const out = path.join(this.repoRoot, 'profiles', `Edge3327_${stamp}.ini`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, '\ufeff' + this.work.serialize(), 'utf8');
    this.journal('export', path.basename(out));
    return out;
  }
  persist() {
    fs.mkdirSync(path.dirname(this.workPath), { recursive: true });
    fs.writeFileSync(this.workPath, '\ufeff' + this.work.serialize(), 'utf8');
  }
}

module.exports = { CfgFile, ConfigPlane, DEVICE, UNLOCK_BANK, PROFILES, deviceSummary, parseCsvInts };
