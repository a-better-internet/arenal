/*
 * ARENAL — shared instrument specification.
 *
 * Loaded twice: once as a classic script in the page (defines window.ARENAL_SPEC)
 * and once inside the AudioWorkletGlobalScope (defines globalThis.ARENAL_SPEC),
 * so the UI and the DSP engine agree on every jack, knob and normalled route.
 *
 * Signal conventions (1.0 = "5 V"):
 *   audio / LFO / random  : bipolar  -1 … +1
 *   envelope / gate       : unipolar  0 … 1
 *   pitch inputs          : 1.0 = 5 octaves (i.e. 0.2 per octave, "1 V/oct")
 */
(function (g) {
  'use strict';

  // ---- scales: taken verbatim from the pattern-generator firmware table --------
  const SCALES = [
    { name: 'CHROMA',    steps: [1,1,1,1,1,1,1,1,1,1,1,1] },
    { name: 'MAJ DIA',   steps: [1,0,1,0,1,1,0,1,0,1,0,1] },
    { name: 'MAJ PENTA', steps: [1,0,1,0,1,0,0,1,0,1,0,0] },
    { name: 'MAJ BLUES', steps: [1,0,1,1,1,0,0,1,0,1,0,0] },
    { name: 'MAJ CHORD', steps: [1,0,0,0,1,0,0,1,0,0,0,0] },
    { name: 'FIFTH',     steps: [1,0,0,0,0,0,0,1,0,0,0,0] },
    { name: 'MAJ +7',    steps: [1,0,0,0,1,0,0,1,0,0,1,0] },
    { name: 'MIN DIA',   steps: [1,0,1,1,0,1,0,1,1,0,1,0] },
    { name: 'MIN PENTA', steps: [1,0,0,1,0,1,0,1,0,0,1,0] },
    { name: 'MIN BLUES', steps: [1,0,0,1,0,1,1,1,0,0,1,0] },
    { name: 'MIN CHORD', steps: [1,0,0,1,0,0,0,1,0,0,0,0] },
    { name: 'WHOLE',     steps: [1,0,1,0,1,0,1,0,1,0,1,0] },
    { name: 'MIN +7',    steps: [1,0,0,1,0,0,0,1,0,0,1,0] },
  ];

  // ---- modules ----------------------------------------------------------------
  // knob: { id, label, min, max, def, taper: 'lin'|'exp', unit, steps? }
  // sw:   { id, label, options: [...], def }
  // in/out: { id, label, normal?: 'module.out' (inputs only) }
  const MODULES = [
    {
      id: 'oscA', name: 'OSC A', sub: 'tracked vco', w: 2,
      knobs: [
        { id: 'oscA.tune', label: 'TUNE', min: 24, max: 96, def: 57, taper: 'lin', unit: 'note' },
        { id: 'oscA.fm',   label: 'FM',   min: 0,  max: 1,  def: 0,  taper: 'lin', unit: '%' },
      ],
      ins: [
        { id: 'oscA.pitch', label: 'PITCH', normal: 'seq.cv' },
        { id: 'oscA.fmin',  label: 'FM',    normal: 'oscB.tri' },
      ],
      outs: [
        { id: 'oscA.tri', label: 'TRI' },
        { id: 'oscA.sqr', label: 'SQR' },
      ],
    },
    {
      id: 'oscB', name: 'OSC B', sub: 'free vco', w: 2,
      knobs: [
        { id: 'oscB.tune', label: 'TUNE', min: 0, max: 1, def: 0.309, taper: 'lin', unit: 'oscb' },
        { id: 'oscB.fm',   label: 'FM',   min: 0, max: 1, def: 0,     taper: 'lin', unit: '%' },
      ],
      sws: [ { id: 'oscB.range', label: 'RANGE', options: ['LO', 'HI'], def: 1 } ],
      ins: [
        { id: 'oscB.pitch', label: 'PITCH' },
        { id: 'oscB.fmin',  label: 'FM', normal: 'rung.out' },
      ],
      outs: [
        { id: 'oscB.tri', label: 'TRI' },
        { id: 'oscB.sqr', label: 'SQR' },
      ],
    },
    {
      id: 'lfo', name: 'TEMPO', sub: 'clock lfo', w: 1,
      knobs: [ { id: 'lfo.rate', label: 'RATE', min: 0.05, max: 40, def: 5, taper: 'exp', unit: 'hz' } ],
      ins: [ { id: 'lfo.ratein', label: 'RATE' } ],
      outs: [
        { id: 'lfo.tri', label: 'TRI' },
        { id: 'lfo.sqr', label: 'SQR' },
      ],
    },
    {
      id: 'rung', name: 'STRATA', sub: 'shift-register random', w: 1,
      knobs: [ { id: 'rung.chaos', label: 'CHAOS', min: 0, max: 1, def: 0.72, taper: 'lin', unit: 'chaos' } ],
      ins: [
        { id: 'rung.clk',  label: 'CLK',  normal: 'lfo.sqr' },
        { id: 'rung.data', label: 'DATA', normal: 'oscB.sqr' },
      ],
      outs: [ { id: 'rung.out', label: 'OUT' } ],
    },
    {
      id: 'sh', name: 'GRAIN', sub: 'noise · sample & hold', w: 1,
      knobs: [ { id: 'sh.slew', label: 'SLEW', min: 0, max: 1, def: 0, taper: 'lin', unit: '%' } ],
      ins: [
        { id: 'sh.in',   label: 'IN',   normal: 'sh.noise' },
        { id: 'sh.trig', label: 'TRIG', normal: 'lfo.sqr' },
      ],
      outs: [
        { id: 'sh.noise', label: 'NOISE' },
        { id: 'sh.out',   label: 'S&H' },
      ],
    },
    {
      id: 'xor', name: 'XOR', sub: 'square logic', w: 1,
      ins: [
        { id: 'xor.a', label: 'A', normal: 'oscA.sqr' },
        { id: 'xor.b', label: 'B', normal: 'oscB.sqr' },
      ],
      outs: [ { id: 'xor.out', label: 'OUT' } ],
    },
    {
      id: 'mix', name: 'MIX', sub: 'three channels', w: 3,
      knobs: [
        { id: 'mix.l1', label: '1', min: 0, max: 1, def: 0.75, taper: 'lin', unit: '%' },
        { id: 'mix.l2', label: '2', min: 0, max: 1, def: 0.30, taper: 'lin', unit: '%' },
        { id: 'mix.l3', label: '3', min: 0, max: 1, def: 0.20, taper: 'lin', unit: '%' },
      ],
      ins: [
        { id: 'mix.in1', label: '1', normal: 'oscA.sqr' },
        { id: 'mix.in2', label: '2', normal: 'oscB.tri' },
        { id: 'mix.in3', label: '3', normal: 'xor.out' },
      ],
      outs: [ { id: 'mix.out', label: 'MIX' } ],
    },
    {
      id: 'vcf', name: 'FILTER', sub: '2-pole state variable', w: 2,
      knobs: [
        { id: 'vcf.cutoff', label: 'CUTOFF', min: 30, max: 16000, def: 700, taper: 'exp', unit: 'hz' },
        { id: 'vcf.res',    label: 'RES',    min: 0,  max: 1,     def: 0.55, taper: 'lin', unit: '%' },
        { id: 'vcf.cv',     label: 'CV AMT', min: -1, max: 1,     def: 0.45, taper: 'lin', unit: 'bi' },
      ],
      sws: [ { id: 'vcf.mode', label: 'MODE', options: ['LP', 'BP', 'HP', 'NT'], def: 0 } ],
      ins: [
        { id: 'vcf.in',   label: 'IN', normal: 'mix.out' },
        { id: 'vcf.cvin', label: 'CV', normal: 'env.out' },
      ],
      outs: [
        { id: 'vcf.out', label: 'OUT' },
        { id: 'vcf.bp',  label: 'BP' },
      ],
    },
    {
      id: 'env', name: 'ENVELOPE', sub: 'attack · decay', w: 2,
      knobs: [
        { id: 'env.attack', label: 'ATTACK', min: 0.001, max: 2, def: 0.003, taper: 'exp', unit: 's' },
        { id: 'env.decay',  label: 'DECAY',  min: 0.01,  max: 4, def: 0.28,  taper: 'exp', unit: 's' },
      ],
      sws: [ { id: 'env.mode', label: 'MODE', options: ['AD', 'ASR'], def: 0 } ],
      ins: [ { id: 'env.trig', label: 'TRIG', normal: 'seq.gate' } ],
      outs: [ { id: 'env.out', label: 'ENV' } ],
    },
    {
      id: 'vca', name: 'VCA', sub: 'amplifier', w: 1,
      knobs: [ { id: 'vca.bias', label: 'DRONE', min: 0, max: 1, def: 0, taper: 'lin', unit: '%' } ],
      ins: [
        { id: 'vca.in',   label: 'IN', normal: 'vcf.out' },
        { id: 'vca.cvin', label: 'CV', normal: 'env.out' },
      ],
      outs: [ { id: 'vca.out', label: 'OUT' } ],
    },
    {
      id: 'seq', name: 'PATTERN', sub: 'pitch recorder · quantizer', w: 4, kind: 'seq',
      knobs: [ { id: 'seq.scale', label: 'SCALE', min: 0, max: SCALES.length - 1, def: 0, taper: 'lin', unit: 'scale', steps: SCALES.length } ],
      ins: [
        { id: 'seq.clk',   label: 'CLK',   normal: 'lfo.sqr' },
        { id: 'seq.track', label: 'TRACK', normal: 'oscA.sqr' },
      ],
      outs: [
        { id: 'seq.cv',   label: 'CV' },
        { id: 'seq.gate', label: 'GATE' },
      ],
    },
    {
      id: 'out', name: 'OUTPUT', sub: 'main', w: 2, kind: 'out',
      knobs: [ { id: 'out.vol', label: 'VOLUME', min: 0, max: 1, def: 0.55, taper: 'lin', unit: '%' } ],
      ins: [ { id: 'out.in', label: 'IN', normal: 'vca.out' } ],
      outs: [],
    },
  ];

  const inputs = [], outputs = [], params = [], normals = {}, paramDefaults = {};
  for (const m of MODULES) {
    for (const j of m.ins || []) { inputs.push(j.id); if (j.normal) normals[j.id] = j.normal; }
    for (const j of m.outs || []) outputs.push(j.id);
    for (const k of m.knobs || []) { params.push(k.id); paramDefaults[k.id] = k.def; }
    for (const s of m.sws || []) { params.push(s.id); paramDefaults[s.id] = s.def; }
  }

  // Lengths the recorder snaps to when REC is released (firmware: usefullLengths[]).
  const USEFUL_LENGTHS = [2, 4, 8, 16, 32, 48, 64];
  const LENGTH_EXCEPTIONS = [3, 12, 24];
  const MAX_SEQUENCE_LENGTH = 64;
  const REST = 255;

  g.ARENAL_SPEC = {
    MODULES, SCALES, inputs, outputs, params, normals, paramDefaults,
    USEFUL_LENGTHS, LENGTH_EXCEPTIONS, MAX_SEQUENCE_LENGTH, REST,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
