'use strict';
/**
 * stability.js — crash analysis & recovery: bugcheck knowledge base,
 * minidump header triage, Linux kernel error watch, recovery playbooks.
 */
const fs = require('fs');
const { execFile } = require('child_process');
const sh = (cmd, args, timeout = 6000) => new Promise(res => {
  execFile(cmd, args, { timeout }, (err, stdout, stderr) => res(err ? null : (stdout || stderr || '')));
});

/* Curated bugcheck KB — parameters heuristics + hardware-profile mapping. */
const BUGCHECKS = {
  '0x0A': { name: 'IRQL_NOT_LESS_OR_EQUAL', causes: ['Faulty or outdated driver running at wrong IRQL', 'Overclocked RAM timing instability', 'Failing RAM'], actions: ['Update storage/GPU/LAN drivers', 'Run Memory panel diagnostics', 'If XMP/EXPO trained: test JEDEC fallback'], hw: ['ram', 'xmp'] },
  '0x1A': { name: 'MEMORY_MANAGEMENT', causes: ['RAM instability (XMP/EXPO margin)', 'Driver pool corruption', 'Page-table corruption'], actions: ['One-click MemTest86+ plan (Memory panel)', 'Reduce RAM to JEDEC, retest', 'Driver Verifier on non-Microsoft drivers'], hw: ['ram', 'xmp'] },
  '0x50': { name: 'PAGE_FAULT_IN_NONPAGED_AREA', causes: ['Bad RAM region', 'Antivirus/filter driver', 'Disk corruption in pagefile'], actions: ['chkdsk /scan', 'memtest overnight', 'Disable AV filter driver to test'], hw: ['ram', 'storage'] },
  '0xD1': { name: 'DRIVER_IRQL_NOT_LESS_OR_EQUAL', causes: ['Network/GPU driver bug at DISPATCH_LEVEL', 'Faulty device driver'], actions: ['Identify driver in dump args (param4 = address)', 'Roll back recently updated NIC/GPU drivers'], hw: ['drivers'] },
  '0x9F': { name: 'DRIVER_POWER_STATE_FAILURE', causes: ['Driver mishandling power transition', 'USB/peripheral firmware (mouse dock/LED controllers)'], actions: ['Update chipset + USB drivers', 'Disable fast startup to isolate', 'Check Edge 3327 firmware/dock'], hw: ['drivers', 'peripherals'] },
  '0x116': { name: 'VIDEO_TDR_FAILURE', causes: ['GPU driver reset timeout', 'GPU power delivery dip (PCIe 12V transient)', 'VRAM instability'], actions: ['DDU clean GPU driver reinstall', 'Watch PCIe rail sag in Power panel under load', 'Reduce GPU power limit 10 % to verify'], hw: ['gpu', 'psu'] },
  '0x117': { name: 'VIDEO_TDR_TIMEOUT_DETECTED', causes: ['Sustained GPU hang', 'Thermal-induced clock stall'], actions: ['Check Thermal panel throttle risk', 'Improve GPU fan curve'], hw: ['gpu', 'thermal'] },
  '0x124': { name: 'WHEA_UNCORRECTABLE_ERROR', causes: ['CPU/SoC hardware error (cache, internal timer)', 'Unstable Vcore/LLC calibration', 'PSU transient dip below spec', 'Aggressive PL/overclock'], actions: ['Read WHEA record type in dump (param2)', 'If Internal Timer/Cache errors: reset CPU to stock, verify PSU rails in Power panel', 'Disable C-states to test clock-domain issue'], hw: ['cpu', 'psu', 'power'] },
  '0x139': { name: 'KERNEL_SECURITY_CHECK_FAILURE', causes: ['Stack corruption from driver', 'Spectre/Meltdown patch interaction'], actions: ['Update all drivers + BIOS/microcode', 'Driver Verifier'], hw: ['drivers'] },
  '0x7E': { name: 'SYSTEM_THREAD_EXCEPTION_NOT_HANDLED', causes: ['Driver exception in system thread'], actions: ['Note faulting image in dump text', 'Update/uninstall that vendor package'], hw: ['drivers'] },
  '0xF5': { name: 'FLTMGR_FILE_SYSTEM', causes: ['Filter-manager filesystem driver (AV/encryption)'], actions: ['Uninstall filter drivers (AV, ransomware protection)'], hw: ['drivers', 'storage'] },
  '0x1E':  { name: 'KMODE_EXCEPTION_NOT_HANDLED', causes: ['Driver fault', 'RAM'], actions: ['Decode exception in arg2', 'Memory test if no driver correlation'], hw: ['drivers', 'ram'] },
  '0x3B':  { name: 'SYSTEM_SERVICE_EXCEPTION', causes: ['Driver/RAM'], actions: ['Driver Verifier', 'Memory test'], hw: ['drivers', 'ram'] },
  '0xEF':  { name: 'CRITICAL_PROCESS_DIED', causes: ['System file corruption', 'Disk failure'], actions: ['sfc /scannow then DISM', 'SMART check in Storage panel'], hw: ['storage'] },
  '0xC5':  { name: 'DRIVER_CORRUPTED_EXPOOL', causes: ['Driver writing freed pool'], actions: ['Driver Verifier special pool', 'Remove dubious drivers'], hw: ['drivers'] },
  '0x77':  { name: 'KERNEL_STACK_INPAGE_ERROR', causes: ['Disk/pagefile read failure', 'Bad RAM'], actions: ['chkdsk /r', 'memtest'], hw: ['storage', 'ram'] },
  '0x7A':  { name: 'KERNEL_DATA_INPAGE_ERROR', causes: ['Paging I/O failed — failing disk/cable', 'Bad block'], actions: ['SMART check now', 'chkdsk /f /r', 'reseat SATA/NVMe'], hw: ['storage'] },
  '0xC2':  { name: 'BAD_POOL_CALLER', causes: ['Driver pool misuse'], actions: ['Driver Verifier', 'update drivers'], hw: ['drivers'] },
  '0x133': { name: 'DPC_WATCHDOG_VIOLATION', causes: ['Storage driver (NVMe) latency', 'Firmware'], actions: ['Update NVMe firmware + storahci/stornvme', 'Check Storage panel latency'], hw: ['storage', 'drivers'] },
  '0x109': { name: 'CRITICAL_STRUCTURE_CORRUPTION', causes: ['Kernel patching/injection software', 'Hardware memory error'], actions: ['Remove anti-cheat overlays/injectors', 'memtest'], hw: ['ram', 'drivers'] }
};

/* Linux kernel oops pattern scan over journalctl. */
async function kernelWatch(lines = 200) {
  const j = await sh('journalctl', ['-k', '-n', String(lines), '--no-pager'], 6000);
  if (!j) return { src: 'SIM', events: [], tail: [], note: 'journalctl unavailable — Windows agent feeds Event Log + LiveKernelReports parity.' };
  const events = [];
  for (const l of j.split('\n')) {
    if (/segfault|Oops|BUG:|panic|Call Trace|hardware error|Machine Check|thermal|throttl/i.test(l)) {
      events.push({ ts: l.match(/^[A-Z][a-z]{2} [ \d]{2} [\d:]+/)?.[0] || null, text: l.trim().slice(0, 240) });
    }
  }
  return { src: 'LIVE', events: events.slice(-40), tail: j.split('\n').slice(-12) };
}

/** Minidump triage — header parse + code correlation. */
function analyzeMinidump(buf) {
  if (!buf || buf.length < 32 || buf.slice(0, 4).toString('ascii') !== 'MDMP') {
    return { valid: false, note: 'Not a Windows minidump (missing MDMP magic). Paste a .dmp file or its bugcheck code.' };
  }
  const version = buf.readUInt32LE(4);
  const streamCount = buf.readUInt32LE(8);
  const flags = buf.readBigUInt64LE(12);
  // SystemInfoStream (7) holds the timestamp of crash in header check only;
  // bugcheck code lives in BugCheckCode stream — full parse needs stream walk.
  let bugcheck = null;
  const dirOff = buf.readUInt32LE(24);
  for (let i = 0; i < streamCount && dirOff + i * 12 + 12 <= buf.length; i++) {
    const o = dirOff + i * 12;
    const type = buf.readUInt32LE(o);
    const off = buf.readUInt32LE(o + 4);
    const size = buf.readUInt32LE(o + 8);
    if (type === 16 && off + 32 <= buf.length) { // BugCheckCodeStream (unused type guard) or comment stream
      // stream type 16 = CommentStreamW in minidump spec; real bugcheck is type 14 (HandleOperationList)? No:
      // Windows MINIDUMP_STREAM_TYPES: BugCheckInformationStream = 20
    }
    if (type === 20 && off + 8 <= buf.length) { // BugCheckInformationStream: ULONG Code; ULONG Params[4]
      bugcheck = { code: '0x' + buf.readUInt32LE(off).toString(16).toUpperCase().padStart(2, '0') };
    }
  }
  return {
    valid: true, formatVersion: version, streams: streamCount,
    flags: '0x' + flags.toString(16),
    bugcheck,
    note: 'Header triage complete. Full parameter decode requires dbghelp — the elevated agent pipes symbols; ECC correlates the code against the knowledge base below.'
  };
}

/** Analyze arbitrary user input: code, pasted text, or base64 dump. */
function analyze(input) {
  const out = { matched: [], hypotheses: [], playbook: [], src: 'LIVE' };
  if (!input) { out.error = 'provide bugcheck code, paste text, or base64 dump'; return out; }
  // Try base64 minidump
  if (/^[A-Za-z0-9+/=\s]{100,}$/.test(input.trim())) {
    try {
      const buf = Buffer.from(input.replace(/\s+/g, ''), 'base64');
      Object.assign(out, { dump: analyzeMinidump(buf) });
      if (out.dump.bugcheck) input = out.dump.bugcheck.code;
    } catch { /* fall through to text */ }
  }
  // Direct code
  const codeM = String(input).match(/0x([0-9A-Fa-f]{1,3})\b/);
  const codes = new Set();
  if (codeM) codes.add('0x' + codeM[1].toUpperCase().padStart(2, '0'));
  for (const code of Object.keys(BUGCHECKS)) if (String(input).toUpperCase().includes(code.toUpperCase())) codes.add(code);
  // Text pattern matches
  const text = String(input);
  for (const [code, e] of Object.entries(BUGCHECKS)) {
    if (text.toUpperCase().includes(e.name.toUpperCase())) codes.add(code);
  }
  for (const code of codes) {
    const e = BUGCHECKS[code];
    if (!e) continue;
    out.matched.push({ code, name: e.name, causes: e.causes, actions: e.actions, hwLinks: e.hw });
  }
  if (!out.matched.length) {
    out.matched.push({
      code: null, name: 'Unclassified',
      causes: ['No direct KB hit — paste the stop-code text or .dmp for header triage.'],
      actions: ['Capture: wevtutil qe System /q:"*[System[(EventID=41 or EventID=1001)]]" /f:text'],
      hwLinks: []
    });
  }
  // Rank hypotheses across matches
  const tally = {};
  for (const m of out.matched) for (const h of m.hwLinks) tally[h] = (tally[h] || 0) + 1;
  out.hypotheses = Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([hw, n]) => ({ hw, weight: n }));
  out.playbook = buildPlaybook(out.hypotheses.map(h => h.hw));
  return out;
}

const PLAYBOOKS = {
  ram: { title: 'Memory integrity', steps: ['Create restore point (Admin panel → Snapshot)', 'Boot MemTest86+ USB — 4 passes minimum', 'If XMP/EXPO trained: load JEDEC profile, retest 24 h', 'If errors persist on one DIMM: isolate by slot rotation'] },
  xmp: { title: 'XMP/EXPO margin', steps: ['BIOS change sheet from Memory panel', 'Test JEDEC baseline vs XMP bin', 'Raise DRAM voltage within kit spec (+0.05 V max) only if rated for it'] },
  psu: { title: 'Power delivery (750 W unit)', steps: ['Open Power panel → transient replay under load', 'Verify 12 V sag stays within ±5 %', 'Reseat EPS/PCIe cables; avoid daisy-chained PCIe pigtails on high-draw GPUs', 'Cross-check wall draw vs model (±3 % gate)'] },
  gpu: { title: 'GPU subsystem', steps: ['DDU → clean vendor driver install', 'TDR delay 10 s test: HKLM\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers TdrDelay=10', 'Reduce GPU PL −10 % to verify power-delivery link'] },
  storage: { title: 'Storage subsystem', steps: ['SMART audit in Storage panel', 'chkdsk /scan (online) then /spotfix', 'Verify NVMe firmware version', 'Check GPT table backup (Storage panel → partition audit)'] },
  drivers: { title: 'Driver verification', steps: ['verifier /standard /all — let it trap the offender (expect BSOD, read code)', 'Reset with verifier /reset', 'Update chipset, LAN, GPU, USB controller drivers'] },
  cpu: { title: 'CPU / platform', steps: ['Reset CPU to stock (undo PL overrides in Power panel)', 'Clear CMOS; verify microcode/BIOS current', 'Monitor WHEA corrected-error counter for 24 h'] },
  thermal: { title: 'Thermal', steps: ['Check Thermal panel throttle risk + time-to-throttle', 'Adaptive fan policy on, verify PWM dispatch', 'Re-verify under replay workload'] },
  peripherals: { title: 'Peripherals', steps: ['Update Edge 3327 firmware via ECC Device panel export + stock updater', 'Test without RGB dock/hub'] },
  power: { title: 'Power policy', steps: ['Revert PL1/PL2 to platform defaults in Power panel', 'Disable fast startup while isolating 0x9F'] }
};
function buildPlaybook(hwList) {
  const keys = new Set(hwList.length ? hwList : ['drivers', 'ram']);
  return [...keys].map(k => PLAYBOOKS[k]).filter(Boolean);
}

function recoveryScript(items) {
  const keys = items?.length ? items : ['drivers', 'storage'];
  const header = ['# EDGE ECC automated recovery bundle', '# Generated ' + new Date().toISOString(), '# Run each block in an elevated PowerShell. Verify one block at a time.', ''];
  const body = [];
  for (const k of keys) {
    if (PLAYBOOKS[k]) body.push(`## ${PLAYBOOKS[k].title}`, ...PLAYBOOKS[k].steps.map(s => `# ${s}`), '');
  }
  body.push(
    '## System file integrity',
    'sfc /scannow',
    'DISM /Online /Cleanup-Image /RestoreHealth',
    '',
    '## Disk verification',
    'Repair-Volume -DriveLetter C -Scan',
    '',
    '## Driver Verifier (trap offender; expect a bugcheck that identifies it)',
    '# verifier /standard /all',
    '# verifier /reset',
    '',
    '## WHEA error survey',
    'Get-WinEvent -FilterHashtable @{LogName="System"; ProviderName="Microsoft-Windows-WHEA-Logger"} -MaxEvents 20 | Format-List TimeCreated, Message'
  );
  return header.concat(body).join('\r\n');
}

const INCIDENTS_PATH = () => process.env.ECC_DATA || (require('path').join(__dirname, '..', 'data'));
function recordIncident(entry) {
  try {
    const dir = INCIDENTS_PATH(); fs.mkdirSync(dir, { recursive: true });
    const p = require('path').join(dir, 'incidents.json');
    const list = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : [];
    list.unshift({ ts: Date.now(), ...entry });
    fs.writeFileSync(p, JSON.stringify(list.slice(0, 100), null, 2));
  } catch { }
}
function incidents() {
  try {
    const p = require('path').join(INCIDENTS_PATH(), 'incidents.json');
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : [];
  } catch { return []; }
}

module.exports = { BUGCHECKS, analyze, analyzeMinidump, kernelWatch, recoveryScript, buildPlaybook, PLAYBOOKS, recordIncident, incidents };
