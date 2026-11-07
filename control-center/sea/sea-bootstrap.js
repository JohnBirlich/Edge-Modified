'use strict';
/**
 * sea-bootstrap.js — entry script embedded into EdgeControlCenter.exe
 * (Node.js Single Executable Application).
 *
 * Responsibilities:
 *   1. Mini CommonJS loader (SEA supports builtins only — this loads app/ files)
 *   2. Path bootstrap: EXE_DIR / app / data
 *   3. Starts app/server.js, auto-opens the browser on Windows
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { exec } = require('child_process');
const builtinModules = require('module').builtinModules;
const BUILTINS = new Set(builtinModules);

const EXE_DIR = path.dirname(process.execPath);
const APP_DIR = path.join(EXE_DIR, 'app');

// Portable state layout: <exe dir>/app/data (overridable)
if (!process.env.ECC_DATA) process.env.ECC_DATA = path.join(APP_DIR, 'data');
if (!process.env.PORT) process.env.PORT = '3327';

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
  // Node's CJS loader strips shebangs (keeps line count) — mirror that:
  src = src.replace(/^#![^\n]*/, m => '//' + m.slice(2));
  const mod = { exports: {}, id: file, filename: file, loaded: false };
  cache.set(file, mod);
  if (isMain) MAIN_MOD = mod;

  if (file.endsWith('.json')) {
    mod.exports = JSON.parse(src);
    mod.loaded = true;
    return mod.exports;
  }

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
    throw new Error(`ECC loader: bare specifier '${id}' unsupported — ECC is dependency-free by design (from ${file})`);
  };
  localRequire.cache = cache;
  localRequire.resolve = id => path.resolve(dir, id);
  localRequire.main = MAIN_MOD;

  wrapper.call(mod.exports, mod.exports, localRequire, mod, file, dir);
  mod.loaded = true;
  return mod.exports;
}

function banner() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   EDGE CONTROL CENTER  v1.0.0  "IGNITION"    ║');
  console.log('╚══════════════════════════════════════════════╝');
}

banner();

const serverEntry = path.join(APP_DIR, 'server.js');
if (!fs.existsSync(serverEntry)) {
  console.error(`✗ app/server.js not found next to the EXE (expected ${serverEntry})`);
  console.error('  Распакуй ZIP целиком и запускай EdgeControlCenter.exe из папки.');
  if (process.platform === 'win32') { try { exec('pause'); } catch { } }
  process.exit(2);
}

process.argv[1] = serverEntry;
try {
  loadModule(serverEntry, true);
} catch (e) {
  console.error('✗ fatal:', e && e.stack || e);
  if (process.platform === 'win32') { try { exec('pause'); } catch { } }
  process.exit(1);
}

// Auto-open the operator UI (Windows) unless suppressed
if (process.platform === 'win32' && !process.env.ECC_NO_BROWSER) {
  const url = `http://127.0.0.1:${process.env.PORT}/`;
  setTimeout(() => {
    try { exec(`start "" "${url}"`); } catch { }
  }, 1500).unref();
}
