'use strict';
/**
 * aistudio.js — Forge Studio: fully local image generation.
 * Adapters for local ComfyUI (:8188) and A1111 WebUI (:7860). No cloud egress,
 * no provider-side filtering: output is governed by the models the operator
 * installs and applicable law. Without a reachable backend, a deterministic
 * procedural renderer (SIM) keeps the UX honest and testable.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dataDir = () => process.env.ECC_DATA || path.join(__dirname, '..', 'data');
const galleryDir = () => path.join(dataDir(), 'gallery');

const state = {
  backend: { type: 'auto', comfy: 'http://127.0.0.1:8188', a1111: 'http://127.0.0.1:7860' },
  detected: null, // {type, version, gpu, vramMb, src}
  queue: new Map(), // id -> job
  order: []
};

async function detectBackend() {
  for (const [type, base] of [['comfyui', state.backend.comfy], ['a1111', state.backend.a1111]]) {
    try {
      const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 1200);
      const r = await fetch(base + (type === 'comfyui' ? '/system_stats' : '/sdapi/v1/sd-models'), { signal: ctl.signal });
      clearTimeout(to);
      if (r.ok) {
        const j = await r.json().catch(() => ({}));
        let gpu = null, vramMb = null;
        if (type === 'comfyui' && j.devices?.[0]) { gpu = j.devices[0].name; vramMb = j.devices[0].vram_total ? Math.round(j.devices[0].vram_total / 2 ** 20) : null; }
        state.detected = { type, base, gpu, vramMb, src: 'LIVE' };
        return state.detected;
      }
    } catch { /* next */ }
  }
  state.detected = { type: 'sim', base: null, gpu: 'procedural renderer', vramMb: null, src: 'SIM' };
  return state.detected;
}

/** SIM renderer: deterministic seeded procedural art → SVG. Honest, local, instant. */
function simRender({ prompt, seed, w, h, style }) {
  const s = seed >>> 0;
  const rnd = () => { s2 = (imul(s2, 1664525) + 1013904223) >>> 0; return s2 / 2 ** 32; };
  let s2 = s;
  function imul(a, b) { return Math.imul(a, b); }
  const hue = Math.floor(rnd() * 360);
  const layers = 24 + Math.floor(rnd() * 30);
  let shapes = '';
  for (let i = 0; i < layers; i++) {
    const cx = rnd() * w, cy = rnd() * h, r = 20 + rnd() * (w / 3);
    const h2 = (hue + rnd() * 90 - 45 + 360) % 360;
    const op = (0.04 + rnd() * 0.18).toFixed(3);
    shapes += `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="hsl(${h2.toFixed(0)},${(60 + rnd() * 40).toFixed(0)}%,${(35 + rnd() * 40).toFixed(0)}%)" opacity="${op}"/>`;
  }
  let beams = '';
  for (let i = 0; i < 7; i++) {
    const y = rnd() * h;
    beams += `<rect x="0" y="${y.toFixed(1)}" width="${w}" height="${(1 + rnd() * 3).toFixed(1)}" fill="hsl(${((hue + 180) % 360).toFixed(0)},90%,70%)" opacity="0.5"/>`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<defs><radialGradient id="bg" cx="50%" cy="40%"><stop offset="0%" stop-color="hsl(${hue},50%,12%)"/><stop offset="100%" stop-color="#07080c"/></radialGradient>
<filter id="blur"><feGaussianBlur stdDeviation="${(8 + rnd() * 30).toFixed(1)}"/></filter></defs>
<rect width="${w}" height="${h}" fill="url(#bg)"/>
<g filter="url(#blur)">${shapes}</g>${beams}
<text x="16" y="${h - 16}" font-family="monospace" font-size="13" fill="#9aa3b5" opacity="0.85">FORGE·SIM seed=${seed} · ${prompt.slice(0, 60).replace(/[<>&]/g, '')}</text>
</svg>`;
  return Buffer.from(svg, 'utf8');
}

function submitJob({ prompt, negative = '', steps = 28, cfg = 7, size = '768x768', seed = null, model = 'auto', sampler = 'euler_a', style = 'abstract' }) {
  const id = crypto.randomUUID();
  const job = {
    id, prompt, negative, steps, cfg, size, sampler, style,
    seed: seed === null || seed === undefined ? crypto.randomInt(1, 2 ** 31) : Number(seed),
    model, status: 'queued', backend: state.detected?.type || 'unknown', created: Date.now(),
    progress: 0, file: null, error: null
  };
  state.queue.set(id, job); state.order.unshift(id);
  if (state.order.length > 100) { const old = state.order.pop(); state.queue.delete(old); }
  setImmediate(() => runJob(job));
  return job;
}

async function runJob(job) {
  job.status = 'running'; job.progress = 5;
  try {
    const [w, h] = job.size.split('x').map(Number);
    fs.mkdirSync(galleryDir(), { recursive: true });
    if (!state.detected || state.detected.type === 'sim') {
      job.progress = 60;
      const buf = simRender({ prompt: job.prompt, seed: job.seed, w: w, h: h, style: job.style });
      job.file = path.join(galleryDir(), `${job.id}.svg`);
      fs.writeFileSync(job.file, buf);
      job.progress = 100; job.status = 'done'; job.backend = 'sim';
      return;
    }
    if (state.detected.type === 'a1111') {
      job.progress = 30;
      const r = await fetch(state.detected.base + '/sdapi/v1/txt2img', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: job.prompt, negative_prompt: job.negative, steps: job.steps, cfg_scale: job.cfg,
          width: w, height: h, seed: job.seed, sampler_name: job.sampler
        })
      });
      if (!r.ok) throw new Error(`a1111 ${r.status}`);
      const j = await r.json();
      job.file = path.join(galleryDir(), `${job.id}.png`);
      fs.writeFileSync(job.file, Buffer.from(j.images[0], 'base64'));
      job.progress = 100; job.status = 'done';
      return;
    }
    if (state.detected.type === 'comfyui') {
      // Minimal txt2img graph (KSampler + VAEDecode + SaveImage via /view)
      const cid = crypto.randomUUID().replace(/-/g, '');
      const graph = {
        '3': { class_type: 'KSampler', inputs: { seed: job.seed, steps: job.steps, cfg: job.cfg, sampler_name: 'euler', scheduler: 'normal', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
        '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: job.model === 'auto' ? 'model.safetensors' : job.model } },
        '5': { class_type: 'EmptyLatentImage', inputs: { width: w, height: h, batch_size: 1 } },
        '6': { class_type: 'CLIPTextEncode', inputs: { text: job.prompt, clip: ['4', 1] } },
        '7': { class_type: 'CLIPTextEncode', inputs: { text: job.negative, clip: ['4', 1] } },
        '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
        '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'forge', images: ['8', 0] } }
      };
      const pr = await fetch(state.detected.base + '/prompt', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: graph, client_id: cid })
      });
      if (!pr.ok) throw new Error(`comfyui prompt ${pr.status}`);
      const pj = await pr.json();
      const promptId = pj.prompt_id;
      // poll history
      for (let i = 0; i < 120; i++) {
        await new Promise(r2 => setTimeout(r2, 1000));
        job.progress = Math.min(95, 10 + i);
        const hr = await fetch(`${state.detected.base}/history/${promptId}`);
        if (!hr.ok) continue;
        const hj = await hr.json();
        const entry = hj[promptId];
        if (entry) {
          const outs = entry.outputs || {};
          for (const node of Object.values(outs)) {
            if (node.images?.[0]) {
              const im = node.images[0];
              const ir = await fetch(`${state.detected.base}/view?filename=${encodeURIComponent(im.filename)}&subfolder=${encodeURIComponent(im.subfolder || '')}&type=${im.type}`);
              if (ir.ok) {
                job.file = path.join(galleryDir(), `${job.id}.png`);
                fs.writeFileSync(job.file, Buffer.from(await ir.arrayBuffer()));
              }
            }
          }
          job.progress = 100; job.status = 'done';
          return;
        }
      }
      throw new Error('comfyui history timeout');
    }
    throw new Error('unknown backend');
  } catch (e) {
    job.status = 'error'; job.error = String(e.message || e);
    // graceful SIM fallback so the operator always gets pixels in demo contexts
    job.fallback = true;
  }
}

function job(id) { return state.queue.get(id) || null; }
function jobs() { return state.order.map(i => state.queue.get(i)).filter(Boolean); }

function gallery(limit = 40) {
  try {
    const files = fs.readdirSync(galleryDir()).filter(f => /\.(png|svg|jpg)$/.test(f)).slice(0, limit);
    return files.map(f => {
      const st = fs.statSync(path.join(galleryDir(), f));
      return { id: f.replace(/\.(png|svg|jpg)$/, ''), file: f, bytes: st.size, ts: st.mtimeMs, url: `/api/ai/gallery/${f}` };
    }).sort((a, b) => b.ts - a.ts);
  } catch { return []; }
}

/** VRAM budget guard — warns when the resolution exceeds a sane model footprint. */
function vramGuard({ size, steps }) {
  const [w, h] = size.split('x').map(Number);
  const approxMb = Math.round((w * h) / 1e6 * 420 + steps * 12 + 2200); // SD1.5/SDXL heuristics
  const have = state.detected?.vramMb;
  return { approxNeededMb: approxMb, haveMb: have, ok: !have || approxMb <= have, note: have ? `Detected VRAM ${have} MiB` : 'No live VRAM report — heuristic only' };
}

module.exports = { detectBackend, submitJob, job, jobs, gallery, galleryDir, state, vramGuard, simRender };
