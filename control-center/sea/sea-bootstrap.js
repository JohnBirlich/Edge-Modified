'use strict';
/**
 * sea-bootstrap.js — v2.0.0 entry script embedded into EdgeControlCenter.exe
 * (Node.js Single Executable Application + embedded VFS payload).
 *
 * The EXE is fully self-contained:
 *   [PE image][SEA blob][VFS payload: app/**, Cfg.ini, VERSION.json][trailer]
 * The trailer layout (appended by tools/make-payload.py):
 *   ...payload bytes... | indexJSON | uint32LE(indexLen) | MAGIC(16)
 *   MAGIC = "ECC2EMBED__V200__" ; index = { "rel/path": [offset,len], ... }
 *   (offsets are relative to payload start = size - 24 - indexLen - payloadLen)
 *
 * Bootstrap responsibilities:
 *   1. Parse own binary tail → in-memory VFS
 *   2. Shim fs (read/exists/stat/readdir/createReadStream → VFS fallback;
 *      writes under the EXE dir → redirected to the user data dir)
 *   3. Mini CommonJS loader (SEA exposes builtins only)
 *   4. Start app/server.js; auto-open the operator URL on Windows
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { exec } = require('child_process');
const { Readable } = require('stream');
const builtinModules = require('module').builtinModules;
const BUILTINS = new Set(builtinModules);

const MAGIC = Buffer.from('ECC2EMBED_V200__', 'utf8'); // exactly 16 bytes
const EXE_DIR = path.dirname(process.execPath);
const APP_DIR = path.join(EXE_DIR, 'app');

/* ---------------------------------------------------------------- */
/* user data dir (survives across runs; EXE location may be RO)      */
/* ---------------------------------------------------------------- */
function defaultDataDir() {
  if (process.env.ECC_DATA) return process.env.ECC_DATA;
  if (process.platform === 'win32' && process.env.APPDATA)
    return path.join(process.env.APPDATA, 'EdgeControlCenter');
  const xdg = process.env.XDG_DATA_HOME || path.join(process.env.HOME || '~', '.local', 'share');
  return path.join(xdg, 'EdgeControlCenter');
}
const DATA_DIR = defaultDataDir();
if (!process.env.ECC_DATA) process.env.ECC_DATA = DATA_DIR;
if (!process.env.PORT) process.env.PORT = '3327';

/* ---------------------------------------------------------------- */
/* VFS: parse trailer from our own executable                        */
/* ---------------------------------------------------------------- */
const VFS = { index: null, fd: null, base: 0, total: 0 };

function vfsInit() {
  try {
    const fd = fs.openSync(process.execPath, 'r');
    const size = fs.fstatSync(fd).size;
    if (size < 64) { fs.closeSync(fd); return; }
    // trailer = [indexJSON][u32 indexLen][MAGIC 16] → last 20 bytes
    const tail = Buffer.alloc(20);
    fs.readSync(fd, tail, 0, 20, size - 20);
    if (!tail.subarray(4).equals(MAGIC)) { fs.closeSync(fd); return; }
    const indexLen = tail.readUInt32LE(0);
    if (indexLen <= 0 || indexLen > 8 * 1024 * 1024) { fs.closeSync(fd); return; }
    const idxBuf = Buffer.alloc(indexLen);
    fs.readSync(fd, idxBuf, 0, indexLen, size - 20 - indexLen);
    const index = JSON.parse(idxBuf.toString('utf8'));
    let total = 0;
    for (const [o, l] of Object.values(index)) total = Math.max(total, o + l);
    VFS.index = index;
    VFS.fd = fd;
    VFS.base = size - 20 - indexLen - total;   // payload start (absolute)
    VFS.total = total;
  } catch { VFS.index = null; }
}
function vfsRead(absPath) {
  if (!VFS.index) return null;
  const rel = path.relative(EXE_DIR, absPath).replace(/\\/g, '/');
  const ent = VFS.index[rel];
  if (!ent) return null;
  const [off, len] = ent;
  const buf = Buffer.alloc(len);
  const n = fs.readSync(VFS.fd, buf, 0, len, VFS.base + off);
  return n === len ? buf : null;
}
function vfsHas(absPath) {
  if (!VFS.index) return false;
  const rel = path.relative(EXE_DIR, absPath).replace(/\\/g, '/');
  return Object.prototype.hasOwnProperty.call(VFS.index, rel);
}
function vfsListDir(absPath) {
  if (!VFS.index) return null;
  const rel = path.relative(EXE_DIR, absPath).replace(/\\/g, '/');
  const pre = rel === '' ? '' : rel + '/';
  const set = new Set();
  for (const k of Object.keys(VFS.index)) {
    if (!k.startsWith(pre)) continue;
    const rest = k.slice(pre.length);
    set.add(rest.includes('/') ? rest.slice(0, rest.indexOf('/')) : rest);
  }
  return set.size ? [...set] : null;
}

vfsInit();

/* ---------------------------------------------------------------- */
/* fs shim: virtual reads + write-redirect into DATA_DIR             */
/* ---------------------------------------------------------------- */
const under = (root, p) => {
  const s = path.resolve(String(p));
  return s === root || s.startsWith(root + path.sep);
};
const mirrorOf = p => path.join(DATA_DIR, path.relative(EXE_DIR, path.resolve(String(p))));
const isVirt = p => under(EXE_DIR, p) && (under(APP_DIR, p) || vfsHas(p));

const _readFileSync = fs.readFileSync;
const _existsSync = fs.existsSync;
const _statSync = fs.statSync;
const _readdirSync = fs.readdirSync;
const _mkdirSync = fs.mkdirSync;
const _writeFileSync = fs.writeFileSync;
const _createReadStream = fs.createReadStream;

function maybeDecode(buf, options) {
  const enc = typeof options === 'string' ? options : options && options.encoding;
  return enc ? buf.toString(enc) : buf;
}

fs.readFileSync = function (p, options) {
  if (isVirt(p)) {
    const m = mirrorOf(p);
    try { return _readFileSync(m, options); } catch { }
    const buf = vfsRead(p);
    if (buf) return maybeDecode(buf, options);
  }
  return _readFileSync(p, options);
};
fs.existsSync = function (p) {
  if (isVirt(p)) return _existsSync(mirrorOf(p)) || vfsHas(p);
  return _existsSync(p);
};
fs.statSync = function (p) {
  if (isVirt(p)) {
    const m = mirrorOf(p);
    try { return _statSync(m); } catch { }
    const buf = vfsRead(p);
    if (buf) {
      return { isFile: () => true, isDirectory: () => false, size: buf.length, mtime: new Date(0), mtimeMs: 0 };
    }
  }
  return _statSync(p);
};
fs.readdirSync = function (p) {
  if (isVirt(p)) {
    const m = mirrorOf(p);
    try { return _readdirSync(m); } catch { }
    const list = vfsListDir(p);
    if (list) return list;
  }
  return _readdirSync(p);
};
fs.mkdirSync = function (p, opts) {
  if (under(EXE_DIR, p)) return _mkdirSync(mirrorOf(p), { recursive: true, ...(opts || {}) });
  return _mkdirSync(p, opts);
};
fs.writeFileSync = function (p, data, opts) {
  if (under(EXE_DIR, p)) {
    const m = mirrorOf(p);
    _mkdirSync(path.dirname(m), { recursive: true });
    return _writeFileSync(m, data, opts);
  }
  return _writeFileSync(p, data, opts);
};
fs.createReadStream = function (p, opts) {
  if (isVirt(p)) {
    const m = mirrorOf(p);
    if (_existsSync(m)) return _createReadStream(m, opts);
    const buf = vfsRead(p);
    if (buf) return Readable.from([buf]);
  }
  return _createReadStream(p, opts);
};

/* ---------------------------------------------------------------- */
/* mini CommonJS loader (disk first, VFS fallback)                   */
/* ---------------------------------------------------------------- */
const BOM = /^\uFEFF/;
const cache = new Map();
let MAIN_MOD = null;

function tryFile(base) {
  for (const c of [base, base + '.js', base + '.json', path.join(base, 'index.js'), path.join(base, 'index.json')]) {
    try { if (fs.statSync(c).isFile()) return c; } catch { }
  }
  return null;
}

function loadModule(file, isMain = false) {
  file = path.resolve(file);
  const hit = cache.get(file);
  if (hit) return hit.exports;

  let src = fs.readFileSync(file, 'utf8').replace(BOM, '');
  const mod = { exports: {}, id: file, filename: file, loaded: false };
  cache.set(file, mod);
  if (isMain) MAIN_MOD = mod;

  if (file.endsWith('.json')) {
    mod.exports = JSON.parse(src);
    mod.loaded = true;
    return mod.exports;
  }

  src = src.replace(/^#![^\n]*/, m => '//' + m.slice(2)); // shebang → comment, keep lines
  const wrapper = vm.runInThisContext(
    `(function (exports, require, module, __filename, __dirname) {\n${src}\n});`,
    { filename: file });
  const dir = path.dirname(file);

  const localRequire = id => {
    if (BUILTINS.has(id) || id.startsWith('node:')) return require(id);
    if (id.startsWith('.') || id.startsWith('/') || /^[A-Za-z]:[\\/]/.test(id)) {
      const target = tryFile(path.resolve(dir, id));
      if (target) return loadModule(target);
      throw new Error(`ECC loader: cannot resolve '${id}' (from ${file})`);
    }
    throw new Error(`ECC loader: bare specifier '${id}' unsupported (from ${file})`);
  };
  localRequire.cache = cache;
  localRequire.resolve = id => path.resolve(dir, id);
  localRequire.main = MAIN_MOD;

  wrapper.call(mod.exports, mod.exports, localRequire, mod, file, dir);
  mod.loaded = true;
  return mod.exports;
}

/* ---------------------------------------------------------------- */
/* boot                                                              */
/* ---------------------------------------------------------------- */
let VERSION = { version: '2.0.0', codename: 'MONOLITH' };
try { VERSION = JSON.parse(fs.readFileSync(path.join(EXE_DIR, 'VERSION.json'), 'utf8')); } catch { }

function banner() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log(`║  EDGE CONTROL CENTER  v${(VERSION.version + ' ').padEnd(9)}  "${VERSION.codename || ''}"`.padEnd(53) + '║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`  exe:      ${process.execPath}`);
  console.log(`  embedded: ${VFS.index ? Object.keys(VFS.index).length + ' files (self-contained)' : 'no — expects app\\ рядом'}`);
  console.log(`  data:     ${DATA_DIR}`);
  console.log(`  url:      http://127.0.0.1:${process.env.PORT}/`);
}

banner();

const serverEntry = path.join(APP_DIR, 'server.js');
if (!fs.existsSync(serverEntry)) {
  console.error('✗ server not found (embedded payload missing and no app\\ folder next to EXE).');
  if (process.platform === 'win32') { try { exec('pause'); } catch { } }
  process.exit(2);
}

process.argv[1] = serverEntry;
try {
  loadModule(serverEntry, true);
  } catch (e) {
    console.error('✗ fatal:', (e && e.stack) || e);
    // persist for the native host / operator (fs shim redirects to the data dir)
    try { fs.writeFileSync(path.join(EXE_DIR, 'engine-error.log'), new Date().toISOString() + ' fatal: ' + ((e && e.stack) || e) + '\n', { flag: 'a' }); } catch { }
    if (process.platform === 'win32') { try { exec('pause'); } catch { } }
    process.exit(1);
  }

// Auto-open the operator UI once the server had a moment to bind
if (process.platform === 'win32' && !process.env.ECC_NO_BROWSER) {
  setTimeout(() => {
    try { exec(`start "" "http://127.0.0.1:${process.env.PORT}/"`); } catch { }
  }, 1800).unref();
}
