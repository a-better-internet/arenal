/*
 * ARENAL — user interface: rack, knobs, patch cables, pattern display, keyboard.
 * The sound itself is made in js/engine-worklet.js.
 */
(() => {
  'use strict';
  const S = window.ARENAL_SPEC;
  const $ = (sel, root = document) => root.querySelector(sel);

  // ---------------------------------------------------------------- storage
  const LS_PATCH = 'arenal.patch.v1', LS_SEQ = 'arenal.seq.v1';
  const store = {
    get(k) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
  };

  const CABLE_COLORS = ['#ff5a1f', '#18b4a4', '#f2c12e', '#3f6dff', '#e0479e', '#86cf3a', '#f4efe2', '#9b5cff'];
  const ABBR = { oscA: 'A', oscB: 'B', lfo: 'TMP', rung: 'STR', sh: 'GRN', xor: 'XOR', mix: 'MIX', vcf: 'VCF', env: 'ENV', vca: 'VCA', seq: 'PAT', out: 'OUT' };
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const noteName = (m) => NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);

  const DEFAULT_SEQ = {
    seq: [
      pad([57, 60, 64, 67, 69, 67, 64, 60]),
      pad([45, 57, 255, 55, 57, 52, 255, 60, 45, 57, 255, 55, 64, 62, 60, 52]),
    ],
    len: [8, 16], ref: [57, 57], autoTune: true, ptrnB: false, play: true,
  };
  function pad(a) { const r = a.slice(); while (r.length < 64) r.push(255); return r; }

  // ---------------------------------------------------------------- presets
  const PRESETS = [
    { name: 'Basalt arpeggio', desc: 'No cables: everything runs on normalled routes.', params: {}, cables: [] },
    {
      name: 'Strata drone', desc: 'The shift register bends OSC A through a minor pentatonic quantizer.',
      params: { 'oscA.fm': 0.32, 'vca.bias': 0.55, 'vcf.res': 0.72, 'vcf.cv': 0.25, 'vcf.cutoff': 520, 'rung.chaos': 0.62, 'seq.scale': 8, 'lfo.rate': 3.2, 'env.decay': 0.6, 'mix.l2': 0.45 },
      cables: [['rung.out', 'oscA.fmin'], ['lfo.tri', 'oscB.pitch']],
    },
    {
      name: 'Pitch catcher', desc: 'OSC B sweeps OSC A slowly. Hold REC to capture the sweep as a pattern.',
      params: { 'oscB.range': 0, 'oscB.tune': 0.36, 'oscA.fm': 0.45, 'mix.l2': 0, 'mix.l3': 0, 'seq.scale': 1, 'vcf.cutoff': 900, 'env.decay': 0.22 },
      cables: [['oscB.tri', 'oscA.fmin']],
    },
    {
      name: 'XOR bells', desc: 'Band-passed XOR, filter stepped by sample & hold.',
      params: { 'oscB.tune': 0.52, 'mix.l1': 0.15, 'mix.l2': 0.1, 'mix.l3': 0.85, 'vcf.mode': 1, 'vcf.cutoff': 1800, 'vcf.res': 0.78, 'vcf.cv': 0.3, 'env.decay': 1.1, 'lfo.rate': 2.5 },
      cables: [['sh.out', 'vcf.cvin'], ['sh.out', 'oscB.fmin']],
    },
    {
      name: 'Feedback grit', desc: 'Filter output folds back into both oscillators.',
      params: { 'oscB.fm': 0.45, 'oscA.fm': 0.18, 'vcf.res': 0.86, 'vcf.cutoff': 1100, 'vcf.cv': 0.55, 'env.decay': 0.45, 'mix.l3': 0.5, 'lfo.rate': 6.5 },
      cables: [['vcf.out', 'oscB.fmin'], ['vcf.bp', 'oscA.fmin'], ['rung.out', 'lfo.ratein']],
    },
  ];

  // ---------------------------------------------------------------- state
  const state = { params: { ...S.paramDefaults }, cables: [], colorIdx: 0 };
  let ctx = null, node = null, starting = null;
  let seqUI = null, scopeCanvas = null;
  const knobs = {}, switches = {}, jacks = {};
  let patterns = DEFAULT_SEQ.seq.map((a) => a.slice());
  let lastTele = null;

  // ================================================================ knobs
  const ARC0 = -135, ARC1 = 135;
  function polar(cx, cy, r, deg) { const a = (deg - 90) * Math.PI / 180; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; }
  function arcPath(cx, cy, r, a0, a1) {
    if (Math.abs(a1 - a0) < 0.01) a1 = a0 + 0.01;
    const lo = Math.min(a0, a1), hi = Math.max(a0, a1);
    const [x0, y0] = polar(cx, cy, r, lo), [x1, y1] = polar(cx, cy, r, hi);
    return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${hi - lo > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  }

  function fmtHz(f) { return f < 1 ? f.toFixed(2) + ' Hz' : f < 100 ? f.toFixed(1) + ' Hz' : f < 1000 ? Math.round(f) + ' Hz' : (f / 1000).toFixed(2) + ' kHz'; }
  function formatValue(def, v) {
    switch (def.unit) {
      case 'note': { const r = Math.round(v), c = Math.round((v - r) * 100); return noteName(r) + (c ? (c > 0 ? ' +' : ' ') + c + 'c' : ''); }
      case 'oscb': {
        const hi = state.params['oscB.range'] >= 0.5;
        return fmtHz(hi ? 16 * Math.pow(2, v * 9) : 0.02 * Math.pow(2, v * 12));
      }
      case 'hz': return fmtHz(v);
      case 's': return v < 1 ? Math.round(v * 1000) + ' ms' : v.toFixed(2) + ' s';
      case 'bi': return (v > 0 ? '+' : '') + Math.round(v * 100) + '%';
      case 'chaos': return v < 0.45 ? 'LOCK' : v < 0.55 ? 'FLIP' : 'RAND ' + Math.round((v - 0.55) / 0.45 * 100) + '%';
      case 'scale': return S.SCALES[Math.round(v)].name;
      default: return Math.round(v * 100) + '%';
    }
  }

  function makeKnob(def) {
    const el = document.createElement('div');
    el.className = 'knob';
    el.innerHTML = `<div class="knob-label">${def.label}</div>
      <svg viewBox="0 0 64 64" tabindex="0" role="slider" aria-label="${def.id.split('.')[0]} ${def.label}">
        <path class="k-track" d="${arcPath(32, 32, 27, ARC0, ARC1)}" fill="none" stroke-width="4" stroke-linecap="round"/>
        <path class="k-val" fill="none" stroke-width="4" stroke-linecap="round"/>
        <circle class="k-cap" cx="32" cy="32" r="20"/>
        <circle class="k-top" cx="32" cy="31" r="16"/>
        <line class="k-ptr" x1="32" y1="31" x2="32" y2="17" stroke-width="3" stroke-linecap="round"/>
      </svg>
      <div class="knob-value"></div>`;
    const svg = $('svg', el), valPath = $('.k-val', el), ptr = $('.k-ptr', el), readout = $('.knob-value', el);
    const isExp = def.taper === 'exp', bip = def.min < 0;
    const toPos = (v) => isExp ? Math.log(v / def.min) / Math.log(def.max / def.min) : (v - def.min) / (def.max - def.min);
    const fromPos = (p) => {
      p = Math.min(1, Math.max(0, p));
      let v = isExp ? def.min * Math.pow(def.max / def.min, p) : def.min + p * (def.max - def.min);
      if (def.steps) v = Math.round(v);
      return v;
    };
    let pos = toPos(state.params[def.id]);

    function draw() {
      const v = state.params[def.id];
      pos = toPos(v);
      const ang = ARC0 + (ARC1 - ARC0) * pos;
      const start = bip ? 0 : ARC0;
      valPath.setAttribute('d', arcPath(32, 32, 27, start, ang));
      ptr.setAttribute('transform', `rotate(${ang.toFixed(2)} 32 31)`);
      const txt = formatValue(def, v);
      readout.textContent = txt;
      svg.setAttribute('aria-valuenow', v.toFixed(3));
      svg.setAttribute('aria-valuetext', txt);
    }
    function setPos(p, fine) {
      p = Math.min(1, Math.max(0, p));
      const v = fromPos(p);
      pos = def.steps ? toPos(v) : p;
      setParam(def.id, v);
      draw();
    }
    svg.setAttribute('aria-valuemin', def.min); svg.setAttribute('aria-valuemax', def.max);

    // drag
    let drag = null;
    svg.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); svg.focus({ preventScroll: true });
      svg.setPointerCapture(e.pointerId);
      drag = { y: e.clientY, x: e.clientX, p: pos, acc: 0 };
      el.classList.add('active');
    });
    svg.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const scale = e.shiftKey ? 900 : 180;
      const d = ((drag.y - e.clientY) + (e.clientX - drag.x) * 0.5) / scale;
      if (def.steps) {
        const stepSize = 1 / (def.steps - 1);
        const target = drag.p + d * 2.2;
        setPos(Math.round(target / stepSize) * stepSize);
      } else setPos(drag.p + d);
    });
    const end = () => { drag = null; el.classList.remove('active'); };
    svg.addEventListener('pointerup', end); svg.addEventListener('pointercancel', end);
    svg.addEventListener('dblclick', () => { setParam(def.id, def.def); draw(); });
    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (def.steps) { const v = Math.round(state.params[def.id]) + (e.deltaY > 0 ? -1 : 1); setParam(def.id, Math.min(def.max, Math.max(def.min, v))); draw(); return; }
      setPos(pos - e.deltaY * (e.shiftKey ? 0.00015 : 0.0009));
    }, { passive: false });
    svg.addEventListener('keydown', (e) => {
      let d = 0;
      const step = def.steps ? 1 / (def.steps - 1) : (e.shiftKey ? 0.002 : 0.01);
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') d = step;
      else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') d = -step;
      else if (e.key === 'PageUp') d = 0.1; else if (e.key === 'PageDown') d = -0.1;
      else if (e.key === 'Home') d = -1; else if (e.key === 'End') d = 1;
      else return;
      e.preventDefault(); e.stopPropagation();
      setPos(pos + d);
    });
    knobs[def.id] = { el, draw, def };
    draw();
    return el;
  }

  function makeSwitch(def) {
    const el = document.createElement('div');
    el.className = 'switch';
    el.innerHTML = `<div class="switch-label">${def.label}</div><div class="seg" role="group" aria-label="${def.id.split('.')[0]} ${def.label}"></div>`;
    const seg = $('.seg', el);
    const btns = def.options.map((opt, i) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = opt;
      b.addEventListener('click', () => { setParam(def.id, i); draw(); if (def.id === 'oscB.range') knobs['oscB.tune'].draw(); });
      seg.appendChild(b); return b;
    });
    function draw() { const v = Math.round(state.params[def.id]); btns.forEach((b, i) => b.setAttribute('aria-pressed', String(i === v))); }
    switches[def.id] = { el, draw };
    draw();
    return el;
  }

  // ================================================================ jacks
  function makeJack(mod, j, dir) {
    const cell = document.createElement('div');
    cell.className = 'jack-cell';
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'jack'; b.dataset.jack = j.id; b.dataset.dir = dir;
    let title = `${mod.name} ${j.label} ${dir === 'in' ? 'input' : 'output'}`;
    let normTxt = '';
    if (dir === 'in' && j.normal) {
      const [nm, nj] = j.normal.split('.');
      const srcMod = S.MODULES.find((m) => m.id === nm);
      const srcJack = srcMod.outs.find((o) => o.id === j.normal);
      normTxt = `${ABBR[nm]}·${srcJack.label}`;
      title += ` — normalled from ${srcMod.name} ${srcJack.label}`;
    }
    b.title = title; b.setAttribute('aria-label', title);
    b.innerHTML = '<span class="glow"></span>';
    cell.appendChild(b);
    const lab = document.createElement('div'); lab.className = 'jack-label'; lab.textContent = j.label; cell.appendChild(lab);
    let normEl = null;
    if (dir === 'in') { normEl = document.createElement('div'); normEl.className = 'jack-norm'; normEl.textContent = normTxt; cell.appendChild(normEl); }
    jacks[j.id] = { el: b, dir, normEl, glow: $('.glow', b), mod: mod.id };
    b.addEventListener('pointerdown', onJackDown);
    return cell;
  }

  // ================================================================ modules
  function buildRack() {
    const rack = $('#rack');
    for (const m of S.MODULES) {
      const el = document.createElement('section');
      el.className = 'module'; el.dataset.mod = m.id; el.style.setProperty('--w', m.w);
      el.setAttribute('aria-label', m.name);
      el.innerHTML = `<div class="mod-head"><div class="mod-name">${m.name}</div><div class="mod-sub">${m.sub}</div></div>`;
      const body = document.createElement('div');
      if (m.kind === 'seq') { body.className = 'seq-body'; buildSeq(body, m); }
      else {
        body.className = 'mod-body';
        for (const k of m.knobs || []) body.appendChild(makeKnob(k));
        for (const s of m.sws || []) body.appendChild(makeSwitch(s));
        if (m.kind === 'out') {
          buildRecorder(body);
          scopeCanvas = document.createElement('canvas'); scopeCanvas.className = 'scope';
          scopeCanvas.setAttribute('aria-label', 'Output oscilloscope'); scopeCanvas.setAttribute('role', 'img');
          body.appendChild(scopeCanvas);
        }
      }
      el.appendChild(body);
      const jw = document.createElement('div'); jw.className = 'jacks';
      const ins = document.createElement('div'); ins.className = 'jack-row ins' + ((m.ins || []).length ? '' : ' empty');
      const outs = document.createElement('div'); outs.className = 'jack-row outs' + ((m.outs || []).length ? '' : ' empty');
      for (const j of m.ins || []) ins.appendChild(makeJack(m, j, 'in'));
      for (const j of m.outs || []) outs.appendChild(makeJack(m, j, 'out'));
      jw.appendChild(ins); jw.appendChild(outs);
      el.appendChild(jw);
      rack.appendChild(el);
    }
  }

  function buildSeq(body, m) {
    body.innerHTML = `
      <div class="seq-buttons">
        <div class="pbtn rec"><button type="button" data-btn="rec" aria-label="Record (hold)"></button><div class="pbtn-label"><span class="led lava" data-led="rec"></span>REC</div></div>
        <div class="pbtn"><button type="button" data-btn="quant" aria-label="Quantize on or off"></button><div class="pbtn-label"><span class="led" data-led="quant"></span>QUANT</div></div>
        <div class="pbtn"><button type="button" data-btn="a" aria-label="Pattern A"></button><div class="pbtn-label"><span class="led" data-led="a"></span>A</div></div>
        <div class="pbtn"><button type="button" data-btn="b" aria-label="Pattern B"></button><div class="pbtn-label"><span class="led" data-led="b"></span>B</div></div>
      </div>
      <div class="screen" aria-live="off">
        <div class="grid64"></div>
        <div class="readout"><span class="ro-l"></span><b class="ro-r"></b></div>
      </div>
      <div class="seq-side">
        <div class="tracked">TRACKED<b class="tr-note">—</b><span class="tr-hz"></span></div>
      </div>`;
    const grid = $('.grid64', body);
    const cells = [];
    for (let i = 0; i < 64; i++) {
      const c = document.createElement('div'); c.className = 'cell';
      const bar = document.createElement('div'); bar.className = 'bar'; c.appendChild(bar);
      grid.appendChild(c); cells.push({ c, bar });
    }
    $('.seq-side', body).appendChild(makeKnob(m.knobs[0]));
    for (const b of body.querySelectorAll('[data-btn]')) {
      const id = b.dataset.btn;
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault(); b.setPointerCapture(e.pointerId); b.classList.add('held');
        seqButton(id, true);
      });
      const up = () => { if (!b.classList.contains('held')) return; b.classList.remove('held'); seqButton(id, false); };
      b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up); b.addEventListener('lostpointercapture', up);
      b.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); e.stopPropagation(); seqButton(id, true); } });
      b.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); seqButton(id, false); } });
    }
    seqUI = {
      cells, screen: $('.screen', body), roL: $('.ro-l', body), roR: $('.ro-r', body),
      trNote: $('.tr-note', body), trHz: $('.tr-hz', body),
      leds: { rec: $('[data-led=rec]', body), quant: $('[data-led=quant]', body), a: $('[data-led=a]', body), b: $('[data-led=b]', body) },
    };
    const saved = store.get(LS_SEQ) || DEFAULT_SEQ;
    renderSeq({ counter: 0, play: saved.play, rec: false, ptrnB: saved.ptrnB, ptrnA: !saved.ptrnB, len: saved.len, autoTune: saved.autoTune, note: null, ref: saved.ref, clk: false });
  }

  async function seqButton(id, down) {
    if (down && !node) { await ensureAudio(); }
    if (node) node.port.postMessage({ type: 'button', id, down });
  }

  function renderSeq(t) {
    if (!seqUI) return;
    const p = t.ptrnB ? 1 : 0;
    const pat = patterns[p], len = t.len[p], ref = t.ref ? t.ref[p] : 57;
    const recording = t.rec;
    for (let i = 0; i < 64; i++) {
      const { c, bar } = seqUI.cells[i];
      const inRange = recording && len === 0 ? i <= t.counter : i < len;
      const note = pat[i];
      const rest = note === 255;
      const h = rest ? 0 : Math.min(1, Math.max(0.08, (note - ref + 24) / 48));
      bar.style.height = (h * 100).toFixed(1) + '%';
      const now = (t.play || recording) && i === t.counter;
      c.className = 'cell ' + (inRange ? 'in' : 'out') + (rest && inRange ? ' rest' : '') + (now ? ' now' : '');
    }
    seqUI.screen.classList.toggle('rec', recording);
    const name = p ? 'B' : 'A';
    seqUI.roL.textContent = recording ? `REC ${name} · step ${t.counter + 1}` : `PATTERN ${name} · ${len} steps`;
    seqUI.roR.textContent = recording ? 'REC' : t.play ? 'PLAY' : 'STOP';
    const L = seqUI.leds;
    L.rec.classList.toggle('on', recording && !t.clk);
    L.quant.classList.toggle('on', !!t.autoTune);
    L.a.className = 'led' + (!t.ptrnB ? (t.play ? ' on' : ' half') : '');
    L.b.className = 'led' + (t.ptrnB ? (t.play ? ' on' : ' half') : '');
    if (t.note != null) {
      seqUI.trNote.textContent = noteName(t.note);
      const hz = 440 * Math.pow(2, (t.pitch - 69) / 12);
      seqUI.trHz.textContent = isFinite(hz) ? fmtHz(hz) : '';
    }
  }

  // ================================================================ params / patch
  let saveTimer = 0;
  function savePatchSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => store.set(LS_PATCH, { params: state.params, cables: state.cables }), 300);
  }
  function setParam(id, v, quiet) {
    state.params[id] = v;
    if (node) node.port.postMessage({ type: 'param', id, value: v });
    if (!quiet) { savePatchSoon(); markCustom(); }
  }
  function sendPatch() {
    if (node) node.port.postMessage({ type: 'patch', cables: state.cables.map((c) => ({ from: c.from, to: c.to })) });
    for (const [id, j] of Object.entries(jacks)) {
      if (j.normEl) j.normEl.classList.toggle('off', state.cables.some((c) => c.to === id));
    }
  }

  // ================================================================ cables
  const svgNS = 'http://www.w3.org/2000/svg';
  const stage = () => $('#stage');
  const cableLayer = () => $('#cables');

  function jackCenter(id) {
    const j = jacks[id]; if (!j) return null;
    const r = j.el.getBoundingClientRect(), s = stage().getBoundingClientRect();
    return [r.left + r.width / 2 - s.left, r.top + r.height / 2 - s.top];
  }
  function cablePath(a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const dist = Math.hypot(dx, dy);
    const sag = Math.min(150, 24 + dist * 0.32);
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2 + sag;
    return `M${a[0].toFixed(1)} ${a[1].toFixed(1)} Q${mx.toFixed(1)} ${my.toFixed(1)} ${b[0].toFixed(1)} ${b[1].toFixed(1)}`;
  }
  function cableGroup(color) {
    const g = document.createElementNS(svgNS, 'g'); g.setAttribute('class', 'cable');
    g.innerHTML = `<path class="c-shadow"/><path class="c-body" stroke="${color}"/><path class="c-shine"/><path class="c-hit"/>
      <circle class="p1" r="8" fill="${color}" stroke="rgba(0,0,0,.45)" stroke-width="1.5"/><circle class="p1i" r="3.2" fill="rgba(0,0,0,.45)"/>
      <circle class="p2" r="8" fill="${color}" stroke="rgba(0,0,0,.45)" stroke-width="1.5"/><circle class="p2i" r="3.2" fill="rgba(0,0,0,.45)"/>`;
    return g;
  }
  function placeCable(g, a, b, plugB = true) {
    const d = cablePath(a, b);
    for (const p of g.querySelectorAll('path')) p.setAttribute('d', d);
    for (const [cls, pt] of [['p1', a], ['p1i', a], ['p2', b], ['p2i', b]]) {
      const c = g.querySelector('.' + cls); c.setAttribute('cx', pt[0].toFixed(1)); c.setAttribute('cy', pt[1].toFixed(1));
    }
    g.querySelector('.p2').style.display = plugB ? '' : 'none';
    g.querySelector('.p2i').style.display = plugB ? '' : 'none';
  }

  function renderCables() {
    const layer = cableLayer();
    for (const g of layer.querySelectorAll('.cable:not(.dragging)')) g.remove();
    for (const c of state.cables) {
      const a = jackCenter(c.from), b = jackCenter(c.to);
      if (!a || !b) continue;
      const g = cableGroup(c.color);
      placeCable(g, a, b);
      const hit = g.querySelector('.c-hit');
      let lastTap = 0;
      hit.addEventListener('pointerup', () => {
        const now = performance.now();
        if (now - lastTap < 380) removeCable(c); else lastTap = now;
      });
      hit.addEventListener('pointerenter', () => { jacks[c.from].el.classList.add('target'); jacks[c.to].el.classList.add('target'); });
      hit.addEventListener('pointerleave', () => { jacks[c.from].el.classList.remove('target'); jacks[c.to].el.classList.remove('target'); });
      const t = document.createElementNS(svgNS, 'title');
      t.textContent = `${labelOf(c.from)} → ${labelOf(c.to)} (double-click to unplug)`;
      g.appendChild(t);
      layer.appendChild(g);
    }
  }
  function labelOf(id) {
    const [m] = id.split('.'); const mod = S.MODULES.find((x) => x.id === m);
    const j = [...(mod.ins || []), ...(mod.outs || [])].find((x) => x.id === id);
    return `${mod.name} ${j.label}`;
  }

  function addCable(from, to, color) {
    state.cables = state.cables.filter((c) => c.to !== to);
    state.cables.push({ from, to, color });
    sendPatch(); renderCables(); savePatchSoon(); markCustom();
  }
  function removeCable(c) {
    for (const id of [c.from, c.to]) jacks[id] && jacks[id].el.classList.remove('target');
    state.cables = state.cables.filter((x) => x !== c);
    sendPatch(); renderCables(); savePatchSoon(); markCustom();
  }
  function nextColor() { const c = CABLE_COLORS[state.colorIdx % CABLE_COLORS.length]; state.colorIdx++; return c; }

  let drag = null;
  function onJackDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget, id = el.dataset.jack, j = jacks[id];
    let fixed = id, color, origin = null;
    const existing = j.dir === 'in' ? state.cables.find((c) => c.to === id) : null;
    if (existing) {
      origin = existing; fixed = existing.from; color = existing.color;
      state.cables = state.cables.filter((c) => c !== existing);
      renderCables();
    } else color = CABLE_COLORS[state.colorIdx % CABLE_COLORS.length];
    const fixedDir = jacks[fixed].dir;
    const g = cableGroup(color); g.classList.add('dragging');
    cableLayer().appendChild(g);
    drag = { fixed, fixedDir, color, origin, g, x0: e.clientX, y0: e.clientY, moved: false, pointerId: e.pointerId, el };
    el.setPointerCapture(e.pointerId);
    for (const [jid, jj] of Object.entries(jacks)) jj.el.classList.toggle('dim', jj.dir === fixedDir);
    moveDrag(e);
    el.addEventListener('pointermove', moveDrag);
    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', endDrag);
  }
  function jackAt(x, y) {
    const hit = document.elementsFromPoint(x, y).find((n) => n.classList && n.classList.contains('jack'));
    if (hit) return hit.dataset.jack;
    // forgiving radius for fingers
    let best = null, bd = 26;
    for (const [id, j] of Object.entries(jacks)) {
      const r = j.el.getBoundingClientRect();
      const d = Math.hypot(r.left + r.width / 2 - x, r.top + r.height / 2 - y);
      if (d < bd) { bd = d; best = id; }
    }
    return best;
  }
  function moveDrag(e) {
    if (!drag) return;
    if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) > 5) drag.moved = true;
    const s = stage().getBoundingClientRect();
    const a = jackCenter(drag.fixed);
    let b = [e.clientX - s.left, e.clientY - s.top], snapped = false;
    const t = drag.moved ? jackAt(e.clientX, e.clientY) : null;
    for (const j of Object.values(jacks)) j.el.classList.remove('target');
    if (t && jacks[t].dir !== drag.fixedDir) { jacks[t].el.classList.add('target'); b = jackCenter(t); snapped = true; }
    placeCable(drag.g, a, b, snapped || drag.moved);
  }
  function endDrag(e) {
    if (!drag) return;
    const d = drag; drag = null;
    d.el.removeEventListener('pointermove', moveDrag);
    d.el.removeEventListener('pointerup', endDrag);
    d.el.removeEventListener('pointercancel', endDrag);
    d.g.remove();
    for (const j of Object.values(jacks)) j.el.classList.remove('dim', 'target');
    if (!d.moved) {
      if (d.origin) { state.cables.push(d.origin); renderCables(); }   // a tap leaves the cable where it was
      return;
    }
    const t = e.type === 'pointerup' ? jackAt(e.clientX, e.clientY) : null;
    if (t && jacks[t].dir !== d.fixedDir) {
      const from = d.fixedDir === 'out' ? d.fixed : t, to = d.fixedDir === 'out' ? t : d.fixed;
      if (!d.origin) state.colorIdx++;
      addCable(from, to, d.color);
      toast(`${labelOf(from)} → ${labelOf(to)}`);
    } else if (d.origin) {
      sendPatch(); renderCables(); savePatchSoon(); markCustom();
      toast('Cable unplugged');
    }
  }

  // ================================================================ patches
  // A patch = every param, every cable and both patterns. Factory patches only
  // set params and cables; saved and imported patches carry patterns too.
  const LS_USER = 'arenal.userpatches.v1';
  let userPatches = (store.get(LS_USER) || []).filter((p) => p && typeof p.name === 'string');
  let loadingPreset = false;

  function seqSnapshot() {
    const t = lastTele && lastTele.seq;
    if (t) return { seq: patterns.map((a) => a.slice()), len: t.len.slice(), ref: t.ref.slice(), autoTune: t.autoTune, ptrnB: t.ptrnB, play: t.play };
    return JSON.parse(JSON.stringify(store.get(LS_SEQ) || DEFAULT_SEQ));
  }
  function patchSnapshot(name) {
    return {
      format: 'arenal-patch', version: 1, name,
      params: { ...state.params },
      cables: state.cables.map((c) => ({ from: c.from, to: c.to, color: c.color })),
      seq: seqSnapshot(),
    };
  }
  function validSeq(q) {
    return q && Array.isArray(q.seq) && q.seq.length === 2 && q.seq.every((a) => Array.isArray(a)) && Array.isArray(q.len);
  }
  function applyPatch(p) {
    loadingPreset = true;
    for (const id of S.params) {
      const v = p.params && typeof p.params[id] === 'number' && isFinite(p.params[id]) ? p.params[id] : S.paramDefaults[id];
      setParam(id, v, true);
    }
    state.cables = []; state.colorIdx = 0;
    for (const c of p.cables || []) {
      const from = Array.isArray(c) ? c[0] : c.from, to = Array.isArray(c) ? c[1] : c.to;
      if (!S.outputs.includes(from) || !S.inputs.includes(to)) continue;
      const color = !Array.isArray(c) && /^#[0-9a-f]{6}$/i.test(c.color || '') ? c.color : nextColor();
      state.cables = state.cables.filter((x) => x.to !== to);
      state.cables.push({ from, to, color });
    }
    state.colorIdx = Math.max(state.colorIdx, state.cables.length);
    if (validSeq(p.seq)) loadSeq(p.seq);
    refreshControls(); sendPatch(); renderCables(); savePatchSoon();
    loadingPreset = false;
  }
  function loadSeq(q) {
    const clean = {
      seq: [0, 1].map((i) => pad(q.seq[i].slice(0, 64).map((n) => (n | 0) & 255))),
      len: [0, 1].map((i) => Math.max(0, Math.min(64, q.len[i] | 0))),
      ref: [0, 1].map((i) => (q.ref && isFinite(q.ref[i]) ? +q.ref[i] : 57)),
      autoTune: q.autoTune !== false, ptrnB: !!q.ptrnB, play: q.play !== false,
    };
    store.set(LS_SEQ, clean);
    patterns = clean.seq.map((a) => a.slice());
    if (node) node.port.postMessage({ type: 'load', state: clean });
    renderSeq({ counter: 0, play: clean.play, rec: false, ptrnB: clean.ptrnB, ptrnA: !clean.ptrnB, len: clean.len, autoTune: clean.autoTune, note: null, ref: clean.ref, clk: false });
    if (lastTele) lastTele.seq = { ...lastTele.seq, len: clean.len, ref: clean.ref, autoTune: clean.autoTune, ptrnB: clean.ptrnB, play: clean.play };
  }

  function buildPresets() {
    const sel = $('#preset');
    const esc = (t) => t.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
    let html = '<option value="">Custom (unsaved)</option><optgroup label="Factory">' +
      PRESETS.map((p, i) => `<option value="f${i}">${esc(p.name)}</option>`).join('') + '</optgroup>';
    if (userPatches.length) html += '<optgroup label="Saved">' + userPatches.map((p, i) => `<option value="u${i}">${esc(p.name)}</option>`).join('') + '</optgroup>';
    const prev = sel.value;
    sel.innerHTML = html;
    if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
    updatePatchButtons();
  }
  function updatePatchButtons() {
    const v = $('#preset').value;
    $('#patch-delete').disabled = !v.startsWith('u');
    resetDeleteConfirm();
  }
  function markCustom() { const sel = $('#preset'); if (sel && !loadingPreset && sel.value !== '') { sel.value = ''; updatePatchButtons(); } }
  function loadPreset(i) {
    const p = PRESETS[i];
    applyPatch({ params: p.params, cables: p.cables });
    $('#preset').value = 'f' + i; updatePatchButtons();
    toast(p.desc);
  }
  function loadUser(i) {
    const p = userPatches[i]; if (!p) return;
    applyPatch(p);
    $('#preset').value = 'u' + i; $('#patch-name').value = p.name; updatePatchButtons();
    toast(`Loaded “${p.name}”`);
  }
  function saveUser() {
    const input = $('#patch-name');
    let name = input.value.trim();
    const sel = $('#preset').value;
    if (!name && sel.startsWith('u')) name = userPatches[+sel.slice(1)].name;
    if (!name) { input.focus(); toast('Type a name for the patch first'); return; }
    const snap = patchSnapshot(name);
    snap.savedAt = new Date().toISOString();
    let idx = userPatches.findIndex((p) => p.name.toLowerCase() === name.toLowerCase());
    const updated = idx >= 0;
    if (updated) userPatches[idx] = snap; else { userPatches.push(snap); idx = userPatches.length - 1; }
    store.set(LS_USER, userPatches);
    buildPresets();
    $('#preset').value = 'u' + idx; input.value = name; updatePatchButtons();
    toast(updated ? `Updated “${name}”` : `Saved “${name}” in this browser`);
  }
  let deleteArmed = 0;
  function resetDeleteConfirm() {
    const b = $('#patch-delete'); clearTimeout(deleteArmed); deleteArmed = 0;
    b.classList.remove('confirm'); b.textContent = 'Delete';
  }
  function deleteUser() {
    const v = $('#preset').value; if (!v.startsWith('u')) return;
    const b = $('#patch-delete');
    if (!deleteArmed) {
      b.classList.add('confirm'); b.textContent = 'Confirm delete';
      deleteArmed = setTimeout(resetDeleteConfirm, 3000);
      return;
    }
    const p = userPatches.splice(+v.slice(1), 1)[0];
    store.set(LS_USER, userPatches);
    $('#preset').value = ''; $('#patch-name').value = '';
    buildPresets();
    toast(`Deleted “${p.name}”`);
  }
  async function exportPatch() {
    const name = $('#patch-name').value.trim() || ($('#preset').selectedOptions[0] || {}).text || 'patch';
    const clean = name.replace(/^Custom.*/, 'patch');
    const snap = patchSnapshot(clean);
    const slug = clean.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'patch';
    const res = await ArenalFiles.saveFile(`arenal-${slug}.json`, new Blob([JSON.stringify(snap, null, 2)], { type: 'application/json' }));
    toast(res.ok ? `Exported ${res.name}` : saveError(res.code));
  }
  function importPatch(file) {
    const reader = new FileReader();
    reader.onload = () => {
      let p;
      try { p = JSON.parse(reader.result); } catch (e) { toast('That file is not valid JSON.'); return; }
      if (!p || p.format !== 'arenal-patch' || typeof p.params !== 'object') { toast('That file is not an Arenal patch export.'); return; }
      let name = String(p.name || file.name.replace(/\.json$/i, '')).slice(0, 40) || 'Imported';
      while (userPatches.some((u) => u.name.toLowerCase() === name.toLowerCase())) name = name.replace(/( \d+)?$/, (m) => ' ' + ((parseInt(m, 10) || 1) + 1));
      p.name = name;
      applyPatch(p);
      userPatches.push({ ...patchSnapshot(name), savedAt: new Date().toISOString() });
      store.set(LS_USER, userPatches);
      buildPresets();
      $('#preset').value = 'u' + (userPatches.length - 1); $('#patch-name').value = name; updatePatchButtons();
      toast(`Imported “${name}”`);
    };
    reader.readAsText(file);
  }
  function saveError(code) {
    if (code === 'declined') return 'Save cancelled';
    if (code === 'rate_limited') return 'Another save is waiting for confirmation. Try again in a moment.';
    return 'Saving files is not available here.';
  }

  // ================================================================ recorder (24-bit WAV)
  const MAX_REC_SECONDS = 20 * 60;
  const rec = { on: false, chunks: [], frames: 0, ui: null, finishing: false };
  function buildRecorder(body) {
    const el = document.createElement('div');
    el.className = 'recorder';
    el.innerHTML = `<button type="button" class="rec-btn" aria-pressed="false"><span class="rec-dot"></span><span class="rec-label">RECORD</span></button>
      <div class="rec-info"><b class="rec-time">0:00</b><br><span class="rec-fmt">24-bit WAV</span></div>`;
    body.appendChild(el);
    rec.ui = { btn: $('.rec-btn', el), label: $('.rec-label', el), time: $('.rec-time', el), fmt: $('.rec-fmt', el) };
    rec.ui.btn.addEventListener('click', toggleRecord);
  }
  async function toggleRecord() {
    if (rec.finishing) return;
    if (!rec.on) {
      await ensureAudio(); if (!node) return;
      rec.chunks = []; rec.frames = 0; rec.on = true;
      node.port.postMessage({ type: 'record', on: true });
      rec.ui.fmt.textContent = `24-bit · ${(ctx.sampleRate / 1000).toFixed(1)} kHz`;
      toast('Recording the main output');
    } else stopRecord();
    updateRecUI();
  }
  function stopRecord() {
    if (!rec.on) return;
    rec.on = false; rec.finishing = true;
    node.port.postMessage({ type: 'record', on: false });
    updateRecUI();
  }
  async function finishRecord() {
    const frames = rec.frames;
    if (!frames) { rec.finishing = false; updateRecUI(); return; }
    const blob = ArenalFiles.encodeWav24(rec.chunks, ctx.sampleRate, 1);
    rec.chunks = [];
    const d = new Date(), z = (n) => String(n).padStart(2, '0');
    const name = `arenal-${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}.wav`;
    const res = await ArenalFiles.saveFile(name, blob);
    rec.finishing = false; updateRecUI();
    toast(res.ok ? `Saved ${res.name} (${fmtTime(frames / ctx.sampleRate)})` : saveError(res.code));
  }
  function fmtTime(sec) { const m = Math.floor(sec / 60), s = Math.floor(sec % 60); return `${m}:${String(s).padStart(2, '0')}`; }
  function updateRecUI() {
    if (!rec.ui) return;
    rec.ui.btn.setAttribute('aria-pressed', String(rec.on));
    rec.ui.label.textContent = rec.on ? 'STOP' : rec.finishing ? 'SAVING…' : 'RECORD';
    rec.ui.time.textContent = fmtTime(ctx ? rec.frames / ctx.sampleRate : 0);
  }

  function refreshControls() {
    for (const k of Object.values(knobs)) k.draw();
    for (const s of Object.values(switches)) s.draw();
  }

  // ================================================================ audio
  async function ensureAudio() {
    if (node) { if (ctx.state !== 'running') await ctx.resume(); updatePower(); return; }
    if (starting) return starting;
    starting = (async () => {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC || !('audioWorklet' in AC.prototype)) { toast('This browser has no AudioWorklet support. Try a current Chrome, Firefox or Safari.'); return; }
      ctx = new AC({ latencyHint: 'interactive' });
      try {
        const [a, b] = await Promise.all([fetch('js/spec.js').then((r) => r.text()), fetch('js/engine-worklet.js').then((r) => r.text())]);
        const url = URL.createObjectURL(new Blob([a, '\n', b], { type: 'text/javascript' }));
        await ctx.audioWorklet.addModule(url);
      } catch (err) {
        await ctx.audioWorklet.addModule('js/spec.js');
        await ctx.audioWorklet.addModule('js/engine-worklet.js');
      }
      node = new AudioWorkletNode(ctx, 'arenal-engine', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
      node.connect(ctx.destination);
      node.port.onmessage = onEngine;
      for (const id of S.params) node.port.postMessage({ type: 'param', id, value: state.params[id] });
      sendPatch();
      node.port.postMessage({ type: 'load', state: store.get(LS_SEQ) || DEFAULT_SEQ });
      await ctx.resume();
      updatePower();
    })();
    try { await starting; } finally { starting = null; }
  }
  function updatePower() {
    const on = !!(ctx && ctx.state === 'running');
    const b = $('#power');
    b.setAttribute('aria-pressed', String(on));
    $('.power-text', b).textContent = on ? 'Audio on' : (ctx ? 'Audio paused' : 'Start audio');
  }
  async function togglePower() {
    if (!ctx || ctx.state !== 'running') await ensureAudio();
    else { await ctx.suspend(); updatePower(); }
  }

  function onEngine(e) {
    const m = e.data;
    if (m.type === 'tele') {
      if (m.pattern) patterns = m.pattern;
      lastTele = m;
      scheduleFrame();
    } else if (m.type === 'rec') {
      if (rec.on || rec.finishing) {
        rec.chunks.push(m.data); rec.frames += m.data.length;
        if (rec.on && rec.frames >= MAX_REC_SECONDS * ctx.sampleRate) { stopRecord(); toast('Recording stopped at 20 minutes'); }
      }
    } else if (m.type === 'recdone') {
      finishRecord();
    } else if (m.type === 'save') {
      store.set(LS_SEQ, m.state);
    }
  }

  let frameQueued = false;
  function scheduleFrame() { if (!frameQueued) { frameQueued = true; requestAnimationFrame(frame); } }
  function frame() {
    frameQueued = false;
    const t = lastTele; if (!t) return;
    renderSeq(t.seq);
    S.outputs.forEach((id, i) => { const j = jacks[id]; if (j) j.glow.style.opacity = Math.min(1, t.peaks[i] * 0.9).toFixed(2); });
    drawScope(t.scope);
    if (rec.on) updateRecUI();
  }

  function drawScope(buf) {
    const c = scopeCanvas; if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const ink = getComputedStyle(document.documentElement).getPropertyValue('--screen-ink').trim() || '#8ff0c8';
    g.strokeStyle = ink; g.globalAlpha = 0.18; g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();
    g.globalAlpha = 1;
    if (!buf) return;
    const span = 700;
    let start = 0;
    for (let i = 1; i < buf.length - span; i++) { if (buf[i - 1] <= 0 && buf[i] > 0) { start = i; break; } }
    g.lineWidth = 1.6; g.beginPath();
    for (let i = 0; i < span; i++) {
      const x = i / (span - 1) * w, y = h / 2 - buf[start + i] * h * 0.44;
      if (i) g.lineTo(x, y); else g.moveTo(x, y);
    }
    g.stroke();
  }

  // ================================================================ keyboard
  const KEYMAP = { a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12, o: 13, l: 14, p: 15, ';': 16 };
  let octave = 0; const held = [];
  function typing(e) { const t = e.target; return t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable); }
  window.addEventListener('keydown', async (e) => {
    if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === ' ') { e.preventDefault(); if (!e.repeat) seqButton('rec', true); return; }
    if (e.repeat) return;
    if (k in KEYMAP) {
      if (!node) await ensureAudio();
      if (!held.includes(k)) held.push(k);
      node && node.port.postMessage({ type: 'key', gate: true, offset: KEYMAP[k] + octave * 12 });
    } else if (k === 'z') { octave = Math.max(-2, octave - 1); toast(`Keyboard octave ${octave >= 0 ? '+' : ''}${octave}`); }
    else if (k === 'x') { octave = Math.min(2, octave + 1); toast(`Keyboard octave ${octave >= 0 ? '+' : ''}${octave}`); }
    else if (k === '1') seqButton('a', true);
    else if (k === '2') seqButton('b', true);
    else if (k === 'q') seqButton('quant', true);
  });
  window.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    if (k === ' ') { if (!typing(e)) { e.preventDefault(); seqButton('rec', false); } return; }
    const i = held.indexOf(k);
    if (i >= 0) {
      held.splice(i, 1);
      if (!node) return;
      if (held.length) node.port.postMessage({ type: 'key', gate: true, offset: KEYMAP[held[held.length - 1]] + octave * 12 });
      else node.port.postMessage({ type: 'key', gate: false, offset: 0 });
    }
  });

  // ================================================================ misc UI
  let toastTimer = 0;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }

  function init() {
    const saved = store.get(LS_PATCH);
    if (saved && saved.params) {
      for (const id of S.params) if (typeof saved.params[id] === 'number') state.params[id] = saved.params[id];
      if (Array.isArray(saved.cables)) state.cables = saved.cables.filter((c) => S.outputs.includes(c.from) && S.inputs.includes(c.to));
      state.colorIdx = state.cables.length;
    }
    buildRack();
    buildPresets();
    if (!saved) { $('#preset').value = 'f0'; updatePatchButtons(); }
    $('#preset').addEventListener('change', (e) => {
      const v = e.target.value;
      if (v.startsWith('f')) loadPreset(+v.slice(1));
      else if (v.startsWith('u')) loadUser(+v.slice(1));
      else updatePatchButtons();
    });
    $('#patch-save').addEventListener('click', saveUser);
    $('#patch-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveUser(); } });
    $('#patch-delete').addEventListener('click', deleteUser);
    $('#patch-export').addEventListener('click', exportPatch);
    $('#patch-import').addEventListener('click', () => $('#patch-file').click());
    $('#patch-file').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) importPatch(f); e.target.value = ''; });
    sendPatch();
    renderCables();
    $('#power').addEventListener('click', togglePower);
    $('#ghost').addEventListener('click', (e) => {
      const on = cableLayer().classList.toggle('ghost');
      e.currentTarget.setAttribute('aria-pressed', String(on));
    });
    $('#clear').addEventListener('click', () => { state.cables = []; sendPatch(); renderCables(); savePatchSoon(); markCustom(); toast('All cables removed'); });
    const ro = new ResizeObserver(() => renderCables());
    ro.observe($('#rack'));
    window.addEventListener('resize', renderCables);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(renderCables);
    drawScope(null);
  }

  init();
})();
