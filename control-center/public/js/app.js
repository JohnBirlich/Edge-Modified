/* Edge Control Center — frontend core (ES module, zero deps) */
'use strict';

/* ---------------- helpers ---------------- */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtK = n => n >= 1e9 ? (n / 1e9).toFixed(1) + 'G' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n || 0));
const giB = b => b == null ? '—' : (b / 2 ** 30).toFixed(1) + ' GiB';

let TOKEN = sessionStorage.getItem('ecc_token') || '';
function api(path, opts = {}) {
  const o = { headers: { 'Content-Type': 'application/json', ...(TOKEN ? { 'X-Auth-Token': TOKEN } : {}) }, ...opts };
  if (o.body && typeof o.body !== 'string') o.body = JSON.stringify(o.body);
  return fetch(path, o).then(async r => {
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.status);
    return j;
  });
}
function toast(msg, kind = '') {
  const t = document.createElement('div');
  t.className = `toast ${kind}`; t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), 4200);
}
function requireAdmin() {
  if (TOKEN) return true;
  toast('Administrator session required — open the Admin panel and elevate.', 'err');
  navTo('admin');
  return false;
}

/* ---------------- charts ---------------- */
function sparkline(canvas, data, color = '#ff9d2e', max = null) {
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (!data || data.length < 2) return;
  const mx = max ?? Math.max(...data, 0.0001) * 1.15;
  ctx.strokeStyle = 'rgba(255,255,255,.06)';
  ctx.beginPath(); ctx.moveTo(0, h - 1); ctx.lineTo(w, h - 1); ctx.stroke();
  ctx.beginPath();
  data.forEach((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - 2 - Math.min(1, v / mx) * (h - 6);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.stroke();
  ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, color + '44'); g.addColorStop(1, color + '00');
  ctx.fillStyle = g; ctx.fill();
}
const HIST = { wall: [], cpu: [], tcpu: [], tgpu: [], rx: [] };
function pushHist(arr, v, cap = 160) { arr.push(v); if (arr.length > cap) arr.shift(); }

/* ---------------- navigation ---------------- */
const ICONS = {
  overview: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>',
  device: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="7" y="2" width="10" height="20" rx="5"/><line x1="12" y1="6" x2="12" y2="9"/></svg>',
  power: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z"/></svg>',
  memory: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="7" width="18" height="10" rx="2"/><line x1="7" y1="7" x2="7" y2="4"/><line x1="12" y1="7" x2="12" y2="4"/><line x1="17" y1="7" x2="17" y2="4"/><line x1="7" y1="17" x2="7" y2="20"/><line x1="12" y1="17" x2="12" y2="20"/><line x1="17" y1="17" x2="17" y2="20"/></svg>',
  storage: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/><path d="M12 3v4M12 17v4M3 12h4M17 12h4"/></svg>',
  network: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="5" r="2.5"/><circle cx="5" cy="19" r="2.5"/><circle cx="19" cy="19" r="2.5"/><path d="M12 7.5 6 17M12 7.5 18 17M7.5 19h9"/></svg>',
  bridge: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 21 3 12l5-9M16 3l5 9-5 9"/></svg>',
  stability: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3z"/><line x1="12" y1="9" x2="12" y2="13"/><circle cx="12" cy="16.5" r=".5"/></svg>',
  ai: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="10" r="1.4"/><circle cx="15" cy="10" r="1.4"/><path d="M8.5 15.5c1 1 2 1.5 3.5 1.5s2.5-.5 3.5-1.5"/></svg>',
  thermal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 4a2 2 0 0 1 4 0v9a4 4 0 1 1-4 0V4z"/><line x1="12" y1="9" x2="12" y2="14"/></svg>',
  admin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>'
};
const MODULES = [
  ['overview', 'Overview'], ['device', 'Device — 3327'], ['power', 'Power delivery'], ['memory', 'Memory'],
  ['storage', 'Storage / GPT'], ['network', 'Network'], ['bridge', 'Bridge W↔L'], ['stability', 'Stability'],
  ['ai', 'AI Studio'], ['thermal', 'Thermal'], ['admin', 'Admin']
];
function buildNav() {
  const nav = $('#nav');
  nav.innerHTML = MODULES.map(([id, label]) =>
    `<div class="nav-item" data-nav="${id}" role="button" tabindex="0">${ICONS[id]}<span>${label}</span><i class="dot" id="dot-${id}" style="display:none"></i></div>`).join('');
  nav.addEventListener('click', e => { const b = e.target.closest('[data-nav]'); if (b) navTo(b.dataset.nav); });
  nav.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.dataset.nav) navTo(e.target.dataset.nav); });
}
function navTo(id) {
  $$('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.nav === id));
  $$('.panel').forEach(p => p.classList.toggle('active', p.id === `panel-${id}`));
  $('#modtitle').textContent = MODULES.find(m => m[0] === id)?.[1] || id;
  location.hash = id;
  PANELS[id]?.refresh?.();
}
document.addEventListener('click', e => { const b = e.target.closest('[data-nav]'); if (b && !e.target.closest('#nav')) navTo(b.dataset.nav); });

/* ================= PANELS ================= */
const PANELS = {};

/* ---------- overview ---------- */
PANELS.overview = {
  async refresh() {
    try {
      const st = await api('/api/state');
      $('#ver').textContent = `v${st.version.version} “${st.version.codename}”`;
      $('#ov-device').innerHTML =
        `<div>${esc(st.device.device.name)} · ${esc(st.device.device.sensor)}</div>
         <div>DPI stages: ${st.device.dpiStages.join(' / ')} (active L${st.device.dpiActiveLevel})</div>
         <div>Debounce ${esc(st.device.debounce)} · LOD ${esc(st.device.lod)} · ${st.device.polling} Hz</div>
         <div>Unlocked modules: <b>${Object.entries(st.device.unlocks).filter(([, v]) => v).length}/5</b></div>`;
      const posture = [
        ['Restore anchor', st.snapshotAnchor ? '◆ anchored' : '⚠ missing', st.snapshotAnchor ? 'ok' : 'bad'],
        ['Hidden modules', `${Object.values(st.device.unlocks).filter(Boolean).length} unlocked`, ''],
        ['Bridge', 'EBP/1.0 ready', 'ok'],
        ['Update channel', st.version.channel, '']
      ];
      $('#ov-posture').innerHTML = posture.map(([k, v, c]) =>
        `<div><div class="sub">${esc(k)}</div><div class="mono ${c === 'ok' ? '' : ''}" style="color:${c === 'ok' ? 'var(--ok)' : c === 'bad' ? 'var(--bad)' : 'var(--text)'}">${esc(v)}</div></div>`).join('');
    } catch (e) { toast(e.message, 'err'); }
  }
};

/* ---------- device ---------- */
PANELS.device = {
  async refresh() {
    try {
      const [cfgd, unlocks, profiles] = await Promise.all([
        api('/api/device/config'), api('/api/device/unlocks'), api('/api/device/profiles')]);
      const d = cfgd.device;
      $('#dev-meta').innerHTML =
        `VID/PID <b>${d.vid}:${d.pid}</b> · sensor <b>${d.sensorId}</b><br>` +
        `DPI hw range ${d.dpiRange[0]}–${d.dpiRange[1]} (step ${d.dpiStep})<br>` +
        `Buttons ${d.buttons} · Poll ${cfgd.polling} Hz<br>` +
        `Debounce <b>${esc(cfgd.debounce)}</b> (mode ${cfgd.debounceMode}) · LOD <b>${esc(cfgd.lod)}</b>`;
      $('#dev-led').style.setProperty('--led', `rgb(${cfgd.dpiColors?.[cfgd.dpiActiveLevel]?.r ?? 255},${cfgd.dpiColors?.[cfgd.dpiActiveLevel]?.g ?? 0},${cfgd.dpiColors?.[cfgd.dpiActiveLevel]?.b ?? 0})`);
      $('#dev-stages').innerHTML = cfgd.dpiStages.map((v, i) =>
        `<div class="dpi-stage row"><span class="n" style="width:36px">L${i}</span>
         <input type="number" min="${d.dpiRange[0]}" max="${d.dpiRange[1]}" step="${d.dpiStep}" value="${v}" data-dpi-idx="${i}" style="flex:1">
         <input type="color" value="#${[cfgd.dpiColors?.[i]?.r ?? 255, cfgd.dpiColors?.[i]?.g ?? 0, cfgd.dpiColors?.[i]?.b ?? 0].map(x => (+x).toString(16).padStart(2, '0')).join('')}" data-col-idx="${i}" class="swatch">
         <button class="btn sm ghost" data-dpi-set="${i}" title="set active stage">▲</button></div>`).join('');
      $$('#dev-stages [data-dpi-set]').forEach(b => b.onclick = () => this.setKey('SENSOR_1', 'DEFLEVEL', b.dataset.dpiSet));
      $$('#dev-stages [data-dpi-idx]').forEach(inp => inp.onchange = () => this.commitDpi());
      $$('#dev-stages [data-col-idx]').forEach(inp => inp.onchange = () => this.commitColors());
      $('#unlock-list').innerHTML = unlocks.map(u =>
        `<div class="row mt"><div><div><b>${esc(u.title)}</b> ${u.dangerous ? '<span class="tag bad">advanced</span>' : ''}</div><div class="sub">${esc(u.desc)}</div></div>
         <label class="toggle" style="margin-left:auto"><input type="checkbox" data-unlock="${u.id}" ${u.on ? 'checked' : ''}><i></i></label></div>`).join('');
      $$('#unlock-list [data-unlock]').forEach(t => t.onchange = async () => {
        if (!requireAdmin()) { t.checked = !t.checked; return; }
        try {
          await api(`/api/device/unlock/${t.dataset.unlock}`, { method: 'POST', body: { on: t.checked } });
          toast(`${t.checked ? 'Unlocked' : 'Re-gated'}: ${t.dataset.unlock}`, 'ok'); this.refresh();
        } catch (e) { toast(e.message, 'err'); t.checked = !t.checked; }
      });
      $('#profile-list').innerHTML = Object.entries(profiles).map(([k, p]) =>
        `<button class="btn sm" data-profile="${k}" style="justify-content:flex-start">${esc(p.label)}</button>`).join('');
      $$('#profile-list [data-profile]').forEach(b => b.onclick = async () => {
        if (!requireAdmin()) return;
        try { await api(`/api/device/profile/${b.dataset.profile}`, { method: 'POST', body: {} }); toast(`Profile applied: ${b.dataset.profile}`, 'ok'); this.refresh(); }
        catch (e) { toast(e.message, 'err'); }
      });
      $('#dev-dr').value = cfgd.debounce; $('#dev-dm').value = cfgd.debounceMode; $('#dev-lod').value = ['low (1 mm)', 'medium (2 mm)', 'high (3 mm)'].indexOf(cfgd.lod);
    } catch (e) { toast(e.message, 'err'); }
  },
  async setKey(section, key, value) {
    if (!requireAdmin()) return;
    try { await api('/api/device/key', { method: 'POST', body: { section, key, value } }); toast(`${section}.${key} = ${value}`, 'ok'); this.refresh(); }
    catch (e) { toast(e.message, 'err'); }
  },
  async commitDpi() {
    const vals = $$('#dev-stages [data-dpi-idx]').map(i => i.value).join(',');
    this.setKey('SENSOR_1', 'DPI', vals);
  },
  async commitColors() {
    const cols = $$('#dev-stages [data-col-idx]').map(i => {
      const n = parseInt(i.value.slice(1), 16);
      return [n >> 16, (n >> 8) & 255, n & 255].join(',');
    }).join(', ');
    this.setKey('SENSOR_1', 'DC', cols);
  }
};

$('#btn-unlock-all').onclick = async () => {
  if (!requireAdmin()) return;
  for (const id of ['gun', 'report', 'lod', 'angle', 'sh']) {
    try { await api(`/api/device/unlock/${id}`, { method: 'POST', body: { on: true } }); } catch { }
  }
  toast('All hidden modules unlocked — export Cfg.ini to persist in the stock app.', 'ok');
  PANELS.device.refresh();
};
$('#btn-lock-all').onclick = async () => {
  if (!requireAdmin()) return;
  for (const id of ['gun', 'report', 'lod', 'angle', 'sh']) {
    try { await api(`/api/device/unlock/${id}`, { method: 'POST', body: { on: false } }); } catch { }
  }
  toast('Factory gates restored.', 'ok'); PANELS.device.refresh();
};
$('#btn-dev-apply').onclick = () => {
  PANELS.device.setKey('SENSOR_1', 'DR', $('#dev-dr').value.trim());
  PANELS.device.setKey('SENSOR_1', 'DM', $('#dev-dm').value);
  PANELS.device.setKey('OPT', 'DefLOD', $('#dev-lod').value);
};
$('#btn-calc').onclick = async () => {
  const dpi = $('#calc-dpi').value, hz = $('#calc-hz').value;
  try {
    const r = await api(`/api/device/dpicalc?dpi=${dpi}&hz=${hz}`);
    $('#calc-out').innerHTML = `counts/cm <b>${r.countsPerCm}</b> · cm/360° <b>${r.cmPer360}</b> · ${r.msPerCount} ms/count · src ${r.src}`;
  } catch (e) { toast(e.message, 'err'); }
};
$('#btn-export').onclick = async () => {
  if (!requireAdmin()) return;
  try { const r = await api('/api/device/export', { method: 'POST', body: {} }); toast('Exported ' + r.exported, 'ok'); }
  catch (e) { toast(e.message, 'err'); }
};
$('#btn-raw').onclick = async () => {
  const txt = await fetch('/api/device/raw').then(r => r.text());
  $('#raw-box').style.display = 'block';
  $('#raw-pre').textContent = txt.slice(0, 8000);
};

/* ---------- power ---------- */
PANELS.power = {
  refresh() { }
};
$('#btn-pl').onclick = async () => {
  if (!requireAdmin()) return;
  try {
    const r = await api('/api/power/limit', { method: 'POST', body: { pl1: +$('#pl1').value, pl2: +$('#pl2').value } });
    $('#pl-result').innerHTML = `Applied: PL1 <b>${r.pl1} W</b> · PL2 <b>${r.pl2} W</b> — ${esc(r.applied)} · guard ${esc(r.guarded)}`;
    toast('Power limits updated', 'ok');
  } catch (e) { toast(e.message, 'err'); }
};
$('#btn-price').onclick = async () => {
  try { await api('/api/power/price', { method: 'POST', body: { kWhPrice: +$('#price').value } }); toast('Price updated', 'ok'); }
  catch (e) { toast(e.message, 'err'); }
};

/* ---------- memory ---------- */
PANELS.memory = {
  async refresh() {
    try {
      const m = await api('/api/memory');
      $('#mem-src').textContent = m.dimms.length ? 'LIVE (dmidecode)' : 'MODEL';
      $('#mem-dimms').innerHTML = m.dimms.length ? `<table><tr><th>Slot device</th><th>Size</th><th>Type</th><th>Rated</th><th>Trained</th></tr>${m.dimms.map(d =>
        `<tr><td>${esc(d.vendor || '—')} ${esc(d.part || '')}</td><td>${esc(d.size || '—')}</td><td>${esc(d.type || '—')}</td><td>${esc(d.speedMTs || '—')}</td><td>${esc(d.configured || '—')}</td></tr>`).join('')}</table>`
        : `<div class="sub">dmidecode not readable in this session — 16 GB envelope model active. The elevated agent reports DIMM SPD on the target machine.</div>`;
      $('#mem-xmp-note').textContent = `${m.profileDetected} — ${m.xmpNote}`;
      const l = m.live;
      $('#mem-live').innerHTML = `total ${giB(l.totalBytes)} · used ${giB(l.usedBytes)} · anon ${giB(l.anon)}<br>cached ${giB(l.cached)} · pagetables ${giB(l.pageTables)} · swap ${giB(l.swapUsed)}/${giB(l.swapTotal)}`;
      $('#mem-swap').innerHTML = m.swapAdvice ? `Recommended: <b>${m.swapAdvice.recommendedSwapGiB} GiB</b> · zram ${m.swapAdvice.zram ? 'yes (lz4)' : 'no'} — ${esc(m.swapAdvice.rationale)}` : '—';
      const v = m.vm;
      $('#mem-vm').innerHTML = Object.entries({ swappiness: v.swappiness, vfs_cache_pressure: v.vfs_cache_pressure, dirty_ratio: v.dirty_ratio, 'THP mode': v.thp, numa_balancing: v.numa_balancing }).map(([k, val]) =>
        `<div><div class="sub">${esc(k)}</div><div class="mono" style="font-size:16px"><b>${val === null ? '—' : esc(String(val))}</b></div></div>`).join('');
      $('#mem-vm-edit').innerHTML = ['swappiness', 'vfs_cache_pressure', 'dirty_ratio', 'dirty_background_ratio'].map(k =>
        `<div><label class="f">${k}</label><input type="number" id="vm-${k}" value="${v[k] ?? ''}"></div>`).join('') +
        `<div style="align-self:end"><button class="btn sm acc" id="btn-vm-apply" style="width:100%">Apply</button></div>`;
      $('#btn-vm-apply').onclick = async () => {
        if (!requireAdmin()) return;
        const body = {};
        for (const k of ['swappiness', 'vfs_cache_pressure', 'dirty_ratio', 'dirty_background_ratio']) body[k] = $(`#vm-${k}`).value;
        try {
          const r = await api('/api/memory/vm', { method: 'POST', body });
          toast('VM tunables applied: ' + Object.entries(r.results).map(([k, v2]) => `${k}=${v2.set} (${v2.src})`).join(', '), 'ok');
          this.refresh();
        } catch (e) { toast(e.message, 'err'); }
      };
    } catch (e) { toast(e.message, 'err'); }
  }
};
$$('[data-vm-preset]').forEach(b => b.onclick = async () => {
  if (!requireAdmin()) return;
  try { const r = await api(`/api/memory/preset/${b.dataset.vmPreset}`, { method: 'POST', body: {} }); toast(`Preset ${b.dataset.vmPreset}: ${esc(r.note)}`, 'ok'); PANELS.memory.refresh(); }
  catch (e) { toast(e.message, 'err'); }
});

/* ---------- storage ---------- */
PANELS.storage = {
  async refresh() {
    try {
      const s = await api('/api/storage');
      $('#sto-src').textContent = s.src === 'LIVE' ? 'LIVE (lsblk)' : 'SIM';
      const render = (nodes, depth = 0) => nodes.map(n => `
        <div style="padding-left:${depth * 16}px;margin:3px 0" class="row">
          <span class="mono"><b>${esc(n.name)}</b></span>
          <span class="sub">${esc(n.size || '')}</span>
          ${n.gptType ? `<span class="tag">${esc(n.gptType)}</span>` : ''}
          ${n.fstype ? `<span class="tag ok">${esc(n.fstype)}</span>` : ''}
          ${n.mount ? `<span class="mono sub">@${esc(n.mount)}</span>` : ''}
          ${n.rotational ? '<span class="tag">HDD</span>' : (n.type === 'disk' ? '<span class="tag ok">SSD</span>' : '')}
        </div>${n.children ? render(n.children, depth + 1) : ''}`).join('');
      $('#sto-tree').innerHTML = s.disks.length ? render(s.disks) : '<div class="sub">lsblk unavailable — agent reports on the target machine.</div>';
      $('#sto-efi').innerHTML =
        `Secure Boot: <b style="color:${s.secureBoot === true ? 'var(--ok)' : 'var(--warn)'}">${esc(String(s.secureBoot))}</b><br>` +
        `EFI runtime: ${s.efi?.present ? 'yes' : 'no'}<br>` +
        `Boot order: <b>${esc(s.efi?.bootOrder || '—')}</b> · timeout ${esc(s.efi?.timeout ?? '—')}s<br>` +
        (s.efi?.entries || []).map(e => `Boot${e.id}: ${esc(e.label)}`).join('<br>');
    } catch (e) { toast(e.message, 'err'); }
  }
};
$('#btn-mnt').onclick = async () => {
  try {
    const r = await api('/api/storage/mountplan', { method: 'POST', body: { device: $('#mnt-dev').value } });
    $('#mnt-out').style.display = 'block';
    $('#mnt-out').textContent = r.plan;
  } catch (e) { toast(e.message, 'err'); }
};

/* ---------- network ---------- */
PANELS.network = {
  async refresh() {
    try {
      const f = await api('/api/network/flows');
      $('#net-flows').innerHTML = f.flows.length ? `<table><tr><th>Peer</th><th>Port</th><th>Service</th><th>Process</th><th>Class</th></tr>${f.flows.slice(0, 14).map(x =>
        `<tr><td class="mono">${esc(x.peer)}</td><td>${x.port || ''}</td><td>${esc(x.service)}</td><td class="mono">${esc(x.process || '—')}</td><td><span class="tag ${esc(x.klass)}">${esc(x.klass)}</span></td></tr>`).join('')}</table>
        <div class="sub mt">${f.count} flows · ${Object.entries(f.byClass).map(([k, v]) => `${k}:${v}`).join(' · ')}</div>`
        : `<div class="sub">No flows readable (${esc(f.src)}). ${esc(f.note || '')}</div>`;
      $('#qos-btns').innerHTML = Object.entries(await api('/api/network/qos')).map(([k, p]) => `<button class="btn sm" data-qos="${k}">${esc(p.label.split('—')[0].trim())}</button>`).join('');
      $$('[data-qos]').forEach(b => b.onclick = async () => {
        if (!requireAdmin()) return;
        try {
          const r = await api(`/api/network/qos/${b.dataset.qos}`, { method: 'POST', body: {} });
          $('#qos-out').style.display = 'block';
          $('#qos-out').textContent = `# ${r.label}\n# applied: ${r.applied}\n\n— Linux —\n${r.generated.linux}\n\n— Windows (elevated) —\n${r.generated.windows}`;
        } catch (e) { toast(e.message, 'err'); }
      });
    } catch (e) { /* flows may be unavailable */ }
  }
};
$('#btn-ping').onclick = async () => {
  $('#ping-out').textContent = 'probing…';
  try {
    const r = await api('/api/network/ping', { method: 'POST', body: { host: $('#ping-host').value, count: +$('#ping-n').value } });
    $('#ping-out').innerHTML = r.error ? esc(r.error) :
      `min ${r.min} · avg <b>${r.avg}</b> · max ${r.max} ms<br>jitter ${r.jitter} ms · loss ${r.lossPct}%`;
  } catch (e) { $('#ping-out').textContent = e.message; }
};
$('#btn-dns').onclick = async () => {
  $('#dns-out').textContent = 'racing…';
  try {
    const r = await api('/api/network/dns', { method: 'POST', body: { host: $('#dns-host').value } });
    $('#dns-out').innerHTML = r.rows.map(x => `${esc(x.resolver)}: ${x.ok ? '<b>' + x.ms.toFixed(0) + ' ms</b> ' + esc(x.addrs[0] || '') : '<span style="color:var(--bad)">' + esc(x.error) + '</span>'}`).join('<br>') +
      (r.fastest ? `<br>fastest: <b>${esc(r.fastest.resolver)}</b>` : '');
  } catch (e) { $('#dns-out').textContent = e.message; }
};
$('#btn-tcp').onclick = async () => {
  try {
    const r = await api('/api/network/tcp', { method: 'POST', body: { host: $('#tcp-host').value, port: +$('#tcp-port').value } });
    $('#tcp-out').innerHTML = `TCP ${esc(r.host)}:${r.port} → ${r.ok ? '<b>' + r.ms + ' ms</b>' : '<span style="color:var(--bad)">' + esc(r.error) + '</span>'}`;
  } catch (e) { $('#tcp-out').textContent = e.message; }
};
$('#btn-http').onclick = async () => {
  try {
    const r = await api('/api/network/http', { method: 'POST', body: { url: $('#http-url').value } });
    $('#tcp-out').innerHTML = `HTTP ${r.ok ? r.status + ' · TTFB <b>' + r.ttfbMs + ' ms</b>' : '<span style="color:var(--bad)">' + esc(r.error) + '</span>'}`;
  } catch (e) { $('#tcp-out').textContent = e.message; }
};
$('#btn-bb').onclick = async () => {
  $('#bb-out').textContent = 'measuring…';
  try {
    const r = await api('/api/network/bufferbloat', { method: 'POST', body: { host: $('#bb-host').value } });
    $('#bb-out').innerHTML = `idle ${r.idle} → loaded ${r.loaded} ms<br>added latency <b>${r.addedLatencyMs} ms</b> · grade <b style="color:var(--acc2)">${r.grade}</b>`;
  } catch (e) { $('#bb-out').textContent = e.message; }
};

/* ---------- bridge ---------- */
PANELS.bridge = {
  async refresh() {
    try {
      const b = await api('/api/bridge');
      $('#br-meta').innerHTML = `protocol <b>${esc(b.protocol)}</b> · discovery UDP :${b.discoveryPort}<br>identity: ${esc(b.identity.name)} (${esc(b.identity.platform)}, ${esc(b.identity.role)})<br>pairing window: ${b.pairingActive ? 'OPEN' : 'closed'}`;
      $('#br-peers').innerHTML = b.peers.length ? `<table><tr><th>Peer</th><th>Platform</th><th>Online</th><th>Since</th><th>Capabilities</th></tr>${b.peers.map(p =>
        `<tr><td><b>${esc(p.name)}</b></td><td>${esc(p.platform)}</td><td><span class="tag ${p.online ? 'ok' : ''}">${p.online ? 'online' : 'stale'}</span></td><td class="mono">${new Date(p.since).toLocaleTimeString()}</td><td class="mono">${esc((p.capabilities || []).join(', ') || '—')}</td></tr>`).join('')}</table>`
        : '<div class="sub">No peers yet. Issue a pairing code, then run the agent on the Windows/Linux side.</div>';
    } catch (e) { toast(e.message, 'err'); }
  }
};
$('#btn-pair').onclick = async () => {
  if (!requireAdmin()) return;
  try {
    const r = await api('/api/bridge/pair', { method: 'POST', body: {} });
    $('#pair-code').textContent = r.code;
    toast('Pairing code issued — valid 2 minutes', 'ok');
    PANELS.bridge.refresh();
  } catch (e) { toast(e.message, 'err'); }
};

/* ---------- stability ---------- */
PANELS.stability = {
  async refresh() {
    try {
      $('#kb-list').innerHTML = Object.entries(await api('/api/stability/bugchecks')).map(([i, b]) =>
        `<span class="tag" data-kb="${esc(b.code)}" style="cursor:pointer" title="${esc(b.name)} — ${esc(b.causes[0] || '')}"><b>${esc(b.code)}</b> ${esc(b.name)}</span>`).join('');
      $$('#kb-list [data-kb]').forEach(t => t.onclick = () => { $('#stab-in').value = t.dataset.kb; $('#btn-stab').click(); });
      const k = await api('/api/stability/kernel');
      $('#kern-src').textContent = k.src;
      $('#kern-out').innerHTML = k.events?.length ? k.events.slice(-12).map(e => `• ${esc(e.text)}`).join('<br>') : '<span class="sub">no kernel errors in recent journal window</span>';
      const inc = await api('/api/stability/incidents');
      $('#inc-out').innerHTML = inc.length ? inc.slice(0, 10).map(i => `${new Date(i.ts).toLocaleString()} — ${esc(i.code || '')} ${esc(i.name || i.kind || '')}`).join('<br>') : '<span class="sub">no recorded incidents</span>';
    } catch (e) { /* journalctl may be unavailable */ }
  }
};
$('#btn-stab').onclick = async () => {
  try {
    const r = await api('/api/stability/analyze', { method: 'POST', body: { input: $('#stab-in').value } });
    $('#stab-out').innerHTML = r.matched.map(m => `
      <div class="mt"><b style="color:var(--acc2)">${esc(m.code || '')} ${esc(m.name)}</b>
      <div class="sub mt">Root-cause hypotheses:</div>
      <ul style="padding-left:18px">${m.causes.map(c => `<li>${esc(c)}</li>`).join('')}</ul>
      <div class="sub mt">Recommended actions:</div>
      <ul style="padding-left:18px">${m.actions.map(c => `<li>${esc(c)}</li>`).join('')}</ul></div>`).join('') +
      (r.dump ? `<div class="note mt">Minidump: valid=${r.dump.valid} streams=${r.dump.streams ?? '—'} ${r.dump.bugcheck ? 'code=' + esc(r.dump.bugcheck.code) : ''}</div>` : '');
  } catch (e) { toast(e.message, 'err'); }
};
$('#btn-recover').onclick = async () => {
  try {
    const r = await api('/api/stability/recovery', { method: 'POST', body: { items: ['ram', 'psu', 'gpu', 'storage', 'drivers'] } });
    $('#stab-out').innerHTML = `<pre class="code" style="max-height:280px">${esc(r.script)}</pre>`;
    toast('Recovery bundle generated', 'ok');
  } catch (e) { toast(e.message, 'err'); }
};

/* ---------- AI studio ---------- */
let aiPoll = null;
PANELS.ai = {
  async refresh() {
    try {
      const st = await api('/api/ai/status');
      const d = st.detected || {};
      $('#ai-badge').textContent = d.type === 'sim' ? 'SIM RENDERER' : d.type ? d.type.toUpperCase() + ' LIVE' : 'detecting…';
      $('#ai-badge').className = 'badge ' + (d.type === 'sim' ? 'sim' : 'live');
      $('#ai-backend').innerHTML = d.type === 'sim'
        ? 'No local backend reachable — deterministic procedural renderer active (badged SIM). Point ECC at a local ComfyUI/A1111 below for full GPU-accelerated generation.'
        : `backend <b>${esc(d.type)}</b> @ ${esc(d.base || '')} · GPU ${esc(d.gpu || '—')} ${d.vramMb ? '· ' + d.vramMb + ' MiB VRAM' : ''}`;
      if (st.backend) { $('#ai-comfy').value = st.backend.comfy || ''; $('#ai-a1111').value = st.backend.a1111 || ''; }
      this.pollJobs();
    } catch (e) { toast(e.message, 'err'); }
  },
  pollJobs() {
    clearInterval(aiPoll);
    aiPoll = setInterval(async () => {
      if (!$('#panel-ai').classList.contains('active')) return;
      try {
        const st = await api('/api/ai/status');
        $('#ai-queue').innerHTML = st.queue.slice(0, 8).map(j => `
          <div class="row mt"><span class="mono">${esc(j.id.slice(0, 8))}</span>
          <div class="bar" style="flex:1"><i style="width:${j.progress}%"></i></div>
          <span class="tag ${j.status === 'done' ? 'ok' : j.status === 'error' ? 'bad' : ''}">${esc(j.status)}${j.backend === 'sim' ? ' ·SIM' : ''}</span></div>`).join('') || '<span class="sub">empty</span>';
        if (st.gallery.length) {
          $('#ai-gallery').innerHTML = st.gallery.map(g => `<div><img loading="lazy" src="${g.url}" alt="${esc(g.id)}"><div class="cap">${esc(g.id.slice(0, 14))} · ${(g.bytes / 1024).toFixed(0)}k</div></div>`).join('');
        }
      } catch { }
    }, 1500);
  }
};
$('#btn-ai-gen').onclick = async () => {
  try {
    const r = await api('/api/ai/generate', {
      method: 'POST',
      body: {
        prompt: $('#ai-prompt').value, negative: $('#ai-neg').value, steps: +$('#ai-steps').value,
        cfg: +$('#ai-cfg').value, size: $('#ai-size').value,
        seed: $('#ai-seed').value ? +$('#ai-seed').value : null
      }
    });
    $('#ai-guard').textContent = r.vramGuard.ok ? '' : `⚠ VRAM guard: needs ~${(r.vramGuard.approxNeededMb / 1024).toFixed(1)} GiB, have ${r.vramGuard.haveMb} MiB`;
    toast(`Job ${r.job.id.slice(0, 8)} queued (${r.job.backend})`, 'ok');
    PANELS.ai.pollJobs();
  } catch (e) { toast(e.message, 'err'); }
};
$('#btn-ai-be').onclick = async () => {
  if (!requireAdmin()) return;
  try {
    const r = await api('/api/ai/backend', { method: 'POST', body: { comfy: $('#ai-comfy').value || undefined, a1111: $('#ai-a1111').value || undefined } });
    toast(`Backend: ${r.detected.type}`, 'ok'); PANELS.ai.refresh();
  } catch (e) { toast(e.message, 'err'); }
};

/* ---------- thermal ---------- */
let thHist = { cpu: [], gpu: [] };
PANELS.thermal = {
  async refresh() {
    try {
      const h = await api('/api/thermal/history');
      thHist.cpu = h.cpu.map(x => x.v); thHist.gpu = h.gpu.map(x => x.v);
      sparkline($('#chart-tcpu'), thHist.cpu, '#ff9d2e', 100);
      sparkline($('#chart-tgpu'), thHist.gpu, '#58a6ff', 100);
      $('#th-curve').innerHTML = Array.from({ length: 5 }, (_, i) =>
        `<div><label class="f">P${i + 1}</label><input type="number" data-cx="${i}" value="${40 + i * 11}" style="margin-bottom:4px"><input type="number" data-cy="${i}" value="${[20, 30, 45, 70, 100][i]}"></div>`).join('');
    } catch { }
  }
};
$('#btn-th-apply').onclick = async () => {
  if (!requireAdmin()) return;
  try {
    const curve = Array.from({ length: 5 }, (_, i) => ({ x: +$(`[data-cx="${i}"]`).value, y: +$(`[data-cy="${i}"]`).value }));
    const r = await api('/api/thermal/policy', {
      method: 'POST',
      body: {
        mode: $('#th-mode').value, acousticTargetDba: +$('#th-dba').value, curve,
        ceilings: { cpu: +$('#th-ceil-cpu').value, gpu: +$('#th-ceil-gpu').value }
      }
    });
    toast(`Thermal policy applied (${r.controller.mode})`, 'ok');
  } catch (e) { toast(e.message, 'err'); }
};

/* ---------- admin ---------- */
PANELS.admin = {
  refresh() {
    const on = !!TOKEN;
    $('#admin-login-card').style.display = on ? 'none' : 'block';
    $('#admin-main').style.display = on ? 'block' : 'none';
    $('#btn-admin').textContent = on ? '🔓 hasberd — elevated' : '🔐 Admin — hasberd';
    if (on) api('/api/admin/system').then(sys => {
      $('#admin-sys').innerHTML =
        `host <b>${esc(sys.host.name)}</b> · ${esc(sys.host.platform)} ${esc(sys.host.release)} (${esc(sys.host.arch)})<br>` +
        `anchor: ${sys.snapshotAnchor ? new Date(sys.snapshotAnchor.ts).toLocaleString() + ' — ' + esc(sys.snapshotAnchor.note) : 'none'}<br>` +
        `powerLimits → ${esc(sys.privilegedPaths.powerLimits)}<br>sysctl → ${esc(sys.privilegedPaths.sysctl)}<br>boot → ${esc(sys.privilegedPaths.boot)}<br>fans → ${esc(sys.privilegedPaths.fans)}`;
    }).catch(() => { });
    this.refreshMacros();
  },
  async refreshMacros() {
    if (!TOKEN) return;
    try {
      const list = await api('/api/admin/macros');
      $('#mac-list').innerHTML = list.length ? list.map(m =>
        `<div class="row mt"><span class="mono"><b>${esc(m.name)}</b> · runs ${m.runs}</span><button class="btn sm" data-mac-run="${m.id}">Dry-run</button></div>`).join('') : '';
      $$('[data-mac-run]').forEach(b => b.onclick = async () => {
        try { const r = await api(`/api/admin/macros/${b.dataset.macRun}/run`, { method: 'POST', body: {} }); toast(`Dry-run OK (${r.tokens.length} tokens — sandbox never executes)`, 'ok'); }
        catch (e) { toast(e.message, 'err'); }
      });
    } catch { }
  }
};
$('#btn-admin').onclick = () => navTo('admin');
$('#btn-login').onclick = async () => {
  try {
    const r = await api('/api/auth/login', { method: 'POST', body: { user: $('#au').value, pass: $('#ap').value } });
    TOKEN = r.token; sessionStorage.setItem('ecc_token', TOKEN);
    toast(`Elevated — welcome ${r.user}` + (r.mustRotate ? ' (rotate the default passphrase!)' : ''), r.mustRotate ? '' : 'ok');
    if (r.mustRotate) toast('Default passphrase in use — rotate now.', 'err');
    $('#ap').value = '';
    PANELS.admin.refresh();
  } catch (e) { toast('Login failed: ' + e.message, 'err'); }
};
$('#btn-logout').onclick = async () => {
  try { await api('/api/auth/logout', { method: 'POST', body: {} }); } catch { }
  TOKEN = ''; sessionStorage.removeItem('ecc_token');
  PANELS.admin.refresh(); toast('Session de-elevated', 'ok');
};
$('#btn-snap').onclick = async () => {
  try { const r = await api('/api/admin/snapshot', { method: 'POST', body: { note: 'Manual pre-change anchor from dashboard' } }); toast('Restore anchor @ ' + new Date(r.anchor.ts).toLocaleTimeString(), 'ok'); PANELS.admin.refresh(); }
  catch (e) { toast(e.message, 'err'); }
};
$('#btn-audit').onclick = async () => {
  try {
    const log = await api('/api/admin/audit');
    $('#audit-box').style.display = 'block';
    $('#audit-pre').textContent = log.slice(0, 60).map(a => `${new Date(a.ts).toISOString()}  ${a.privileged ? 'PRIV' : '    '}  ${a.action.padEnd(18)} ${a.detail}`).join('\n') || 'empty';
  } catch (e) { toast(e.message, 'err'); }
};
$('#btn-rotate').onclick = async () => {
  const p = prompt('New passphrase (≥ 10 chars):');
  if (!p) return;
  try { await api('/api/auth/rotate', { method: 'POST', body: { pass: p } }); toast('Passphrase rotated', 'ok'); }
  catch (e) { toast(e.message, 'err'); }
};
$('#btn-mac-add').onclick = async () => {
  try {
    await api('/api/admin/macros', { method: 'POST', body: { name: $('#mac-name').value, script: $('#mac-script').value } });
    toast('Macro stored', 'ok'); PANELS.admin.refreshMacros();
  } catch (e) { toast(e.message, 'err'); }
};

/* ================= telemetry stream ================= */
function onTick(t) {
  if (!t) return;
  $('#tickbadge').textContent = 'LIVE ● ' + (t.src || '');
  $('#clock').textContent = new Date(t.ts).toLocaleTimeString();
  // overview
  if (t.power) {
    $('#ov-wall').innerHTML = `${t.power.wallW} <small>W</small>`;
    $('#ov-eff').textContent = `η ${t.power.efficiencyPct}% · ${t.power.loadPct}% load`;
    $('#ov-wallbar').style.width = Math.min(100, t.power.loadPct) + '%';
    $('#ov-head').textContent = `headroom ${t.power.headroomW} W · transient ${t.power.transientBudgetW} W`;
    pushHist(HIST.wall, t.power.wallW);
    $('#g-wall').style.setProperty('--p', Math.min(100, t.power.loadPct));
    $('#g-wall-v').textContent = t.power.wallW;
    $('#g-eff').style.setProperty('--p', t.power.efficiencyPct);
    $('#g-eff-v').textContent = t.power.efficiencyPct + '%';
    $('#p-sweet').textContent = t.power.sweetSpot ? '◆ in 40–60 % sweet spot' : 'outside 40–60 % sweet spot';
    $('#p-psu').textContent = `${t.power.psu.watts} W ${t.power.psu.grade} · ${t.power.psu.atx}`;
    $('#p-rails').innerHTML = Object.entries(t.power.rails).map(([k, r]) =>
      `<div class="row"><span style="flex:1">${esc(k)}</span><b>${r.w} W</b><span class="tag ${r.src === 'LIVE' ? 'ok' : ''}" style="margin-left:8px">${r.src}</span></div>`).join('');
    $('#p-week').innerHTML = `${t.power.cost.eurPerWeek} <small>€/week</small>`;
    $('#p-month').innerHTML = `${(t.power.cost.eurPerWeek * 4.345).toFixed(2)} <small>€/month</small>`;
    $('#pl-src').textContent = t.power.limits.src;
    sparkline($('#chart-wall'), HIST.wall, '#ff4d2e');
  }
  if (t.cpu) {
    $('#ov-cpu').innerHTML = `${Math.round(t.cpu.load * 100)}<small>%</small>`;
    pushHist(HIST.cpu, t.cpu.load * 100);
    sparkline($('#spark-cpu'), HIST.cpu, '#3fd39f', 100);
    $('#ov-cpuinfo').textContent = `${t.cpu.cores} cores · ${t.cpu.freqMhz ?? '—'} MHz`;
  }
  if (t.mem && t.mem.totalBytes) {
    const pct = t.mem.usedBytes / t.mem.totalBytes * 100;
    $('#ov-mem').innerHTML = `${Math.round(pct)}<small>%</small>`;
    $('#ov-membar').style.width = pct + '%';
    $('#ov-meminfo').textContent = `${giB(t.mem.usedBytes)} / ${giB(t.mem.totalBytes)} · swap ${giB(t.mem.swapUsed)}`;
  }
  if (t.net) {
    $('#ov-rx').innerHTML = `${(t.net.rxps / 1024).toFixed(1)} <small>KB/s</small>`;
    $('#ov-tx').innerHTML = `${(t.net.txps / 1024).toFixed(1)} <small>KB/s</small>`;
    pushHist(HIST.rx, t.net.rxps / 1024);
    sparkline($('#spark-net'), HIST.rx, '#58a6ff');
  }
  if (t.thermal) {
    const th = t.thermal;
    $('#ov-risk').innerHTML = `${th.riskPct}<small>%</small>`;
    $('#ov-riskbar').style.width = th.riskPct + '%';
    $('#ov-riskbar').className = th.riskPct > 70 ? 'bad' : th.riskPct > 40 ? '' : 'ok';
    $('#ov-ttt').textContent = `TTT cpu ${th.timeToThrottleS.cpu ?? '—'}s · gpu ${th.timeToThrottleS.gpu ?? '—'}s`;
    $('#ov-thermsrc').textContent = th.sensors.cpu.src;
    $('#ov-thermsrc').className = 'badge ' + (th.sensors.cpu.src === 'LIVE' ? 'live' : 'model');
    $('#th-cpu').innerHTML = `${th.sensors.cpu.t}°`;
    $('#th-gpu').innerHTML = `${th.sensors.gpu.t}°`;
    $('#th-cpu-pred').textContent = `forecast ${th.predictedC.cpu}° @60 s (EWMA+trend) · class ${th.controller.class} · fan ${th.controller.fanPwm}%`;
    $('#th-gpu-pred').textContent = `forecast ${th.predictedC.gpu}° @60 s · mode ${th.controller.mode}`;
    $('#th-class').value = th.controller.class;
    $('#th-ttt-cpu').textContent = `CPU: t=${th.sensors.cpu.t}° ewma=${th.sensors.cpu.ewma}° → ceiling ${th.ceilings.cpu}° — ${th.timeToThrottleS.cpu === null ? 'stable' : th.timeToThrottleS.cpu + ' s to throttle'}`;
    $('#th-ttt-gpu').textContent = `GPU: t=${th.sensors.gpu.t}° ewma=${th.sensors.gpu.ewma}° → ceiling ${th.ceilings.gpu}° — ${th.timeToThrottleS.gpu === null ? 'stable' : th.timeToThrottleS.gpu + ' s to throttle'}`;
    $('#th-risk').textContent = `Throttle risk: ${th.riskPct}%`;
    pushHist(thHist.cpu, th.sensors.cpu.t, 160);
    pushHist(thHist.gpu, th.sensors.gpu.t, 160);
    if ($('#panel-thermal').classList.contains('active')) {
      sparkline($('#chart-tcpu'), thHist.cpu, '#ff9d2e', 100);
      sparkline($('#chart-tgpu'), thHist.gpu, '#58a6ff', 100);
    }
  }
  if (t.bridge) {
    const peers = t.bridge.peers.filter(p => p.online).length;
    const dot = $('#dot-bridge');
    if (dot) { dot.style.display = peers ? 'block' : 'none'; }
  }
}
function connectSSE() {
  const es = new EventSource('/api/telemetry/stream');
  es.onmessage = e => { try { onTick(JSON.parse(e.data)); } catch { } };
  es.onerror = () => { $('#tickbadge').textContent = 'RECONNECTING…'; };
}

/* ================= boot ================= */
function boot() {
  buildNav();
  $('#chan').textContent = 'stable';
  const h = location.hash.replace('#', '') || 'overview';
  navTo(MODULES.some(m => m[0] === h) ? h : 'overview');
  connectSSE();
  PANELS.overview.refresh();
  // lazy-refresh on nav via navTo; periodic background refresh for active panel
  setInterval(() => {
    const id = location.hash.replace('#', '') || 'overview';
    if (['storage', 'network', 'bridge', 'stability'].includes(id)) PANELS[id]?.refresh?.();
  }, 12000);
  // clock
  setInterval(() => { }, 1000);
}
boot();
