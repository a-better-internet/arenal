/*
 * ARENAL — DSP engine (AudioWorkletProcessor).
 *
 * Every module runs per sample. Patch cables are resolved to an index table:
 * each input reads the previous sample of whichever output feeds it (patched
 * cable, else its normalled source, else silence). That one-sample delay makes
 * any patch legal, including feedback loops, at audio rate.
 *
 * The PATTERN module is a port of the pattern generator & quantizer firmware
 * (softPop.ino, Vaclav Pelousek / Bastl Instruments 2017, CC BY-SA):
 *   - the tracked oscillator's pitch is measured every few cycles and the
 *     nearest note is found; with QUANT on, a fine-tune correction snaps the
 *     oscillator onto that note (firmware "autoTune")
 *   - REC (held) records the tracked note on each falling clock edge, and on
 *     release snaps the length to 2/4/8/16/32/48/64 (3, 12, 24 kept as-is)
 *   - A / B select, start and stop the two patterns with the firmware's logic
 */
'use strict';

const S = globalThis.ARENAL_SPEC;
const TWO_PI = Math.PI * 2;

const RUNGLER_MAP = [0, 80, 120, 150, 180, 200, 220, 255]; // firmware runglerMap[]

function mtof(m) { return 440 * Math.pow(2, (m - 69) / 12); }
function fastTanh(x) {
  if (x > 3) return 1; if (x < -3) return -1;
  const x2 = x * x; return x * (27 + x2) / (27 + 9 * x2);
}
function polyBlep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}

class ArenalProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    const sr = sampleRate;
    this.sr = sr;

    // ----- patch routing -------------------------------------------------------
    this.nOut = S.outputs.length;
    this.prev = new Float32Array(this.nOut);
    this.cur = new Float32Array(this.nOut);
    this.src = new Int16Array(S.inputs.length).fill(-1);
    this.patched = new Uint8Array(S.inputs.length);
    this.O = {}; S.outputs.forEach((id, i) => { this.O[id] = i; });
    this.I = {}; S.inputs.forEach((id, i) => { this.I[id] = i; });
    this.setPatch([]);

    // ----- parameters (target + smoothed) --------------------------------------
    this.P = {}; this.PT = {};
    for (const id of S.params) { this.P[id] = S.paramDefaults[id]; this.PT[id] = S.paramDefaults[id]; }
    this.smooth = 1 - Math.exp(-1 / (0.012 * sr));

    // ----- module state --------------------------------------------------------
    this.lfoPh = 0;
    this.aPh = 0; this.bPh = 0.25;
    this.aCycles = 0; this.aRawSum = 0; this.aRawN = 0;
    this.corr = 0;               // quantizer fine-tune correction (semitones)
    this.trackedNote = 57;       // most recent measured note (MIDI)
    this.trackedPitch = 57;      // continuous pitch (for UI)
    // external tracker (TRACK patched)
    this.trkHigh = false; this.trkSamples = 0; this.trkCycles = 0; this.trkSince = 0;

    this.rungReg = (Math.random() * 255) | 0; this.rungClk = false; this.rungOut = 0;
    this.shClk = false; this.shHeld = 0; this.shOut = 0;
    this.recording = false; this.recBuf = null; this.recPos = 0;
    this.envClk = false; this.envStage = 0; this.envLevel = 0;
    this.ic1 = 0; this.ic2 = 0;
    this.dcX = 0; this.dcY = 0;

    // keyboard
    this.keyOffset = 0; this.keyGate = false; this.keyRetrig = 0;

    // ----- pattern generator (firmware state) ---------------------------------
    this.seq = [new Uint8Array(64).fill(S.REST), new Uint8Array(64).fill(S.REST)];
    this.seqLen = [0, 0];
    this.seqRef = [57, 57];      // TUNE position when each pattern was recorded
    this.autoTune = true;
    this.rec = false; this.play = false;
    this.ptrnA = true; this.ptrnB = false;
    this.counter = 0;
    this.clkHigh = false;
    this.seqVersion = 0;

    // ----- UI telemetry ---------------------------------------------------------
    this.peak = new Float32Array(this.nOut);
    this.scope = new Float32Array(2048); this.scopePos = 0;
    this.teleEvery = Math.round(sr / 30); this.teleCount = 0;
    this.sentVersion = -1;

    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  // ===========================================================================
  setPatch(cables) {
    this.src.fill(-1); this.patched.fill(0);
    for (const [inId, outId] of Object.entries(S.normals)) {
      const i = this.I[inId], o = this.O[outId];
      if (i !== undefined && o !== undefined) this.src[i] = o;
    }
    for (const c of cables) {
      const i = this.I[c.to], o = this.O[c.from];
      if (i !== undefined && o !== undefined) { this.src[i] = o; this.patched[i] = 1; }
    }
  }

  onMessage(m) {
    switch (m.type) {
      case 'patch': this.setPatch(m.cables); break;
      case 'param':
        if (m.id in this.PT) {
          this.PT[m.id] = m.value;
          if (m.id.endsWith('.range') || m.id.endsWith('.mode') || m.id === 'seq.scale') this.P[m.id] = m.value;
        }
        break;
      case 'button': this.button(m.id, m.down); break;
      case 'record':
        if (m.on) { this.recBuf = new Float32Array(16384); this.recPos = 0; this.recording = true; }
        else { this.flushRec(); this.recording = false; this.port.postMessage({ type: 'recdone' }); }
        break;
      case 'key':
        if (m.gate) { this.keyOffset = m.offset; this.keyRetrig = 48; }
        this.keyGate = m.gate;
        break;
      case 'load': {
        const st = m.state;
        for (let p = 0; p < 2; p++) {
          if (st.seq && st.seq[p]) this.seq[p].set(st.seq[p].slice(0, 64));
          if (st.len) this.seqLen[p] = st.len[p] | 0;
          if (st.ref) this.seqRef[p] = +st.ref[p];
        }
        if ('autoTune' in st) this.autoTune = !!st.autoTune;
        if ('ptrnB' in st) { this.ptrnB = !!st.ptrnB; this.ptrnA = !this.ptrnB; }
        if ('play' in st) this.play = !!st.play;
        this.counter = 0; this.rec = false;
        this.seqVersion++;
        break;
      }
    }
  }

  flushRec() {
    if (!this.recBuf || this.recPos === 0) return;
    const chunk = this.recBuf.slice(0, this.recPos);
    this.port.postMessage({ type: 'rec', data: chunk }, [chunk.buffer]);
    this.recPos = 0;
  }

  saveState(withPattern) {
    this.port.postMessage({
      type: 'save', withPattern,
      state: {
        seq: [Array.from(this.seq[0]), Array.from(this.seq[1])],
        len: [this.seqLen[0], this.seqLen[1]], ref: [this.seqRef[0], this.seqRef[1]],
        autoTune: this.autoTune, ptrnB: this.ptrnB, play: this.play,
      },
    });
  }

  // ----- firmware button handlers --------------------------------------------
  button(id, down) {
    if (id === 'rec') {
      if (down) {                       // record()
        const p = this.ptrnB ? 1 : 0;
        this.rec = true; this.play = true; this.counter = 0;
        this.seq[p][0] = this.trackedNote; this.seqLen[p] = 0;
        this.seqRef[p] = this.PT['oscA.tune'];
        this.seqVersion++;
      } else if (this.rec) {            // button release
        const p = this.ptrnB ? 1 : 0;
        this.rec = false; this.play = true;
        if (this.seqLen[p] === 0) {
          const c = this.counter;
          this.seqLen[p] = c;
          if (S.LENGTH_EXCEPTIONS.indexOf(c) < 0) {
            const U = S.USEFUL_LENGTHS;
            let len = U[U.length - 1];
            for (let i = 0; i < U.length; i++) {
              if (U[i] > c) {
                if (i === 0) len = U[0];
                else len = Math.abs(U[i] - c) > Math.abs(U[i - 1] - c) ? U[i - 1] : U[i];
                break;
              }
            }
            this.seqLen[p] = len;
          }
        }
        this.counter = 0;
        this.seqVersion++;
        this.saveState(true);
      }
      return;
    }
    if (!down) return;
    if (id === 'a') {                   // patternA()
      if (this.play && this.ptrnA) this.play = false;
      else if (this.play && this.ptrnB) { this.ptrnA = true; this.ptrnB = false; }
      else if (!this.play) { this.play = true; this.ptrnA = true; this.ptrnB = false; this.counter = 0; }
    } else if (id === 'b') {            // patternB()
      if (this.play && this.ptrnB) this.play = false;
      else if (this.play && this.ptrnA) { this.ptrnA = false; this.ptrnB = true; }
      else if (!this.play) { this.play = true; this.ptrnA = false; this.ptrnB = true; this.counter = 0; }
    } else if (id === 'quant') {
      this.autoTune = !this.autoTune;
    }
    this.saveState(false);
  }

  // nearest note that belongs to the selected scale
  quantize(pitch) {
    const steps = S.SCALES[this.P['seq.scale'] | 0].steps;
    const n = Math.round(pitch);
    let best = n, bestD = 1e9;
    for (let d = -6; d <= 6; d++) {
      const c = n + d;
      if (steps[((c % 12) + 12) % 12]) {
        const dist = Math.abs(c - pitch);
        if (dist < bestD) { bestD = dist; best = c; }
      }
    }
    return best;
  }

  // falling clock edge — firmware loop() step logic
  clockStep() {
    const p = this.ptrnB ? 1 : 0;
    if (this.rec) {
      if (this.seqLen[p] === 0) {
        if (this.counter < 63) this.counter++;
        else { this.counter = 0; this.seqLen[p] = 64; }
      } else {
        if (this.counter < this.seqLen[p] - 1) this.counter++;
        else this.counter = 0;
      }
      this.seq[p][this.counter] = this.trackedNote;
      this.seqVersion++;
    } else if (this.play) {
      if (this.counter < this.seqLen[p] - 1) this.counter++;
      else this.counter = 0;
    }
  }

  // ===========================================================================
  process(_inputs, outputs) {
    const outL = outputs[0][0], outR = outputs[0][1] || null;
    const n = outL.length, sr = this.sr, inv = 1 / sr;
    const O = this.O, I = this.I, src = this.src, P = this.P, PT = this.PT;
    let prev = this.prev, cur = this.cur;

    // smooth continuous params once per block (block = 128 samples ≈ 2.7 ms)
    const k = 1 - Math.pow(1 - this.smooth, n);
    for (const id in PT) P[id] += (PT[id] - P[id]) * k;

    const inp = (name) => { const s = src[I[name]]; return s >= 0 ? prev[s] : 0; };

    // per-block constants
    const lfoBase = P['lfo.rate'];
    const bRangeHi = PT['oscB.range'] >= 0.5;
    const bBase = bRangeHi ? 16 * Math.pow(2, P['oscB.tune'] * 9) : 0.02 * Math.pow(2, P['oscB.tune'] * 12);
    const bFm = P['oscB.fm'] * 4, aFm = P['oscA.fm'] * 4;
    const aTune = P['oscA.tune'];
    const chaos = P['rung.chaos'];
    const slew = P['sh.slew'];
    const slewK = slew <= 0.001 ? 1 : 1 - Math.exp(-1 / (Math.pow(slew, 2) * 0.5 * sr + 1));
    const l1 = P['mix.l1'], l2 = P['mix.l2'], l3 = P['mix.l3'];
    const cutBase = P['vcf.cutoff'], res = P['vcf.res'], cvAmt = P['vcf.cv'] * 6;
    const vcfMode = PT['vcf.mode'] | 0;
    const kRes = 2 - 1.985 * Math.min(1, res);
    const atkK = 1 - Math.exp(-1 / (P['env.attack'] * sr));
    const decK = 1 - Math.exp(-1 / (P['env.decay'] * sr * 0.25));
    const envAsr = PT['env.mode'] >= 0.5;
    const bias = P['vca.bias'];
    const vol = P['out.vol'];
    const trackPatched = this.patched[I['seq.track']] === 1;
    const measureLen = Math.max(32, Math.round(sr * 0.03));

    const iO = {
      noise: O['sh.noise'], sh: O['sh.out'], lt: O['lfo.tri'], ls: O['lfo.sqr'],
      bt: O['oscB.tri'], bs: O['oscB.sqr'], at: O['oscA.tri'], as: O['oscA.sqr'],
      rung: O['rung.out'], xor: O['xor.out'], mix: O['mix.out'], vcf: O['vcf.out'], bp: O['vcf.bp'],
      env: O['env.out'], vca: O['vca.out'], cv: O['seq.cv'], gate: O['seq.gate'],
    };

    for (let s = 0; s < n; s++) {
      // ---------------- noise ----------------
      cur[iO.noise] = Math.random() * 2 - 1;

      // ---------------- TEMPO lfo ----------------
      const lf = Math.min(lfoBase * Math.pow(2, 5 * inp('lfo.ratein')), 2000);
      this.lfoPh += lf * inv; if (this.lfoPh >= 1) this.lfoPh -= Math.floor(this.lfoPh);
      cur[iO.lt] = 1 - 4 * Math.abs(this.lfoPh - 0.5);
      cur[iO.ls] = this.lfoPh < 0.5 ? 1 : -1;

      // ---------------- OSC B ----------------
      let fb = bBase * Math.pow(2, 5 * inp('oscB.pitch') + bFm * inp('oscB.fmin'));
      if (fb > sr * 0.45) fb = sr * 0.45;
      const dtb = fb * inv;
      this.bPh += dtb; if (this.bPh >= 1) this.bPh -= Math.floor(this.bPh);
      cur[iO.bt] = 1 - 4 * Math.abs(this.bPh - 0.5);
      {
        const t = this.bPh;
        let sq = t < 0.5 ? 1 : -1;
        sq += polyBlep(t, dtb); sq -= polyBlep((t + 0.5) % 1, dtb);
        cur[iO.bs] = sq;
      }

      // ---------------- OSC A (tracked + quantized) ----------------
      const raw = aTune + 60 * inp('oscA.pitch') + 12 * aFm * inp('oscA.fmin') + this.keyOffset;
      const pitch = raw + (this.autoTune ? this.corr : 0);
      let fa = mtof(pitch);
      if (fa > sr * 0.45) fa = sr * 0.45; else if (fa < 0.01) fa = 0.01;
      const dta = fa * inv;
      this.aPh += dta;
      this.aRawSum += raw; this.aRawN++;
      if (this.aPh >= 1) { this.aPh -= Math.floor(this.aPh); this.aCycles++; }
      // measure every 8 cycles (firmware: every 16) or 30 ms, whichever is first
      if (this.aCycles >= 8 || this.aRawN >= measureLen) {
        const avg = this.aRawSum / this.aRawN;
        const target = this.quantize(avg);
        if (this.autoTune) {
          const err = target - (avg + this.corr);
          if (Math.abs(err) > 0.05) this.corr = target - avg;
        } else this.corr = 0;
        if (!trackPatched) this.trackedPitch = avg + (this.autoTune ? this.corr : 0);
        if (!trackPatched) this.trackedNote = Math.max(0, Math.min(127, this.autoTune ? target : Math.round(avg)));
        this.aCycles = 0; this.aRawSum = 0; this.aRawN = 0;
      }
      cur[iO.at] = 1 - 4 * Math.abs(this.aPh - 0.5);
      {
        const t = this.aPh;
        let sq = t < 0.5 ? 1 : -1;
        sq += polyBlep(t, dta); sq -= polyBlep((t + 0.5) % 1, dta);
        cur[iO.as] = sq;
      }

      // ---------------- external pitch tracker (TRACK patched) ----------------
      if (trackPatched) {
        const x = inp('seq.track');
        this.trkSamples++; this.trkSince++;
        if (!this.trkHigh && x > 0.05) {
          this.trkHigh = true;
          if (this.trkSince < sr * 0.5) this.trkCycles++;
          else { this.trkCycles = 0; this.trkSamples = 0; }
          this.trkSince = 0;
          if (this.trkCycles >= 8 || (this.trkCycles > 0 && this.trkSamples >= measureLen)) {
            const f = this.trkCycles * sr / this.trkSamples;
            const m = 69 + 12 * Math.log2(f / 440);
            if (isFinite(m)) {
              this.trackedPitch = m;
              const q = this.autoTune ? this.quantize(m) : Math.round(m);
              this.trackedNote = Math.max(0, Math.min(127, q));
            }
            this.trkCycles = 0; this.trkSamples = 0;
          }
        } else if (this.trkHigh && x < -0.05) this.trkHigh = false;
      }

      // ---------------- STRATA (rungler-style shift register) ----------------
      {
        const c = inp('rung.clk');
        if (!this.rungClk && c > 0.25) {
          this.rungClk = true;
          const reg = this.rungReg;
          const top = (reg >> 7) & 1;
          let bit;
          if (chaos < 0.45) bit = top;                        // locked loop
          else if (chaos < 0.55) bit = top ^ 1;               // inverted: double-length loop
          else {
            const pr = (chaos - 0.55) / 0.45;
            bit = Math.random() < pr ? (inp('rung.data') > 0 ? 1 : 0) : top;
          }
          this.rungReg = ((reg << 1) | bit) & 255;
          const r = this.rungReg;
          const idx = (r & 1) | (((r >> 3) & 1) << 1) | (((r >> 5) & 1) << 2);
          this.rungOut = RUNGLER_MAP[idx] / 127.5 - 1;
        } else if (this.rungClk && c < 0.15) this.rungClk = false;
        cur[iO.rung] = this.rungOut;
      }

      // ---------------- GRAIN (sample & hold) ----------------
      {
        const t = inp('sh.trig');
        if (!this.shClk && t > 0.25) { this.shClk = true; this.shHeld = inp('sh.in'); }
        else if (this.shClk && t < 0.15) this.shClk = false;
        this.shOut += (this.shHeld - this.shOut) * slewK;
        cur[iO.sh] = this.shOut;
      }

      // ---------------- XOR ----------------
      cur[iO.xor] = ((inp('xor.a') > 0) !== (inp('xor.b') > 0)) ? 1 : -1;

      // ---------------- MIX ----------------
      cur[iO.mix] = l1 * inp('mix.in1') + l2 * inp('mix.in2') + l3 * inp('mix.in3');

      // ---------------- PATTERN (clock + CV) ----------------
      {
        const c = inp('seq.clk');
        if (!this.clkHigh && c > 0.25) this.clkHigh = true;
        else if (this.clkHigh && c < 0.15) { this.clkHigh = false; this.clockStep(); }
        const p = this.ptrnB ? 1 : 0;
        let off = 0, rest = false;
        if (this.play && !this.rec) {
          const note = this.seq[p][this.counter];
          if (note === S.REST) rest = true; else off = note - this.seqRef[p];
        }
        cur[iO.cv] = off / 60;
        let gate = !this.clkHigh && !rest ? 1 : 0;
        if (this.keyGate) gate = this.keyRetrig > 0 ? 0 : 1;
        if (this.keyRetrig > 0) this.keyRetrig--;
        cur[iO.gate] = gate;
      }

      // ---------------- ENVELOPE ----------------
      {
        const t = inp('env.trig');
        let rising = false;
        if (!this.envClk && t > 0.25) { this.envClk = true; rising = true; }
        else if (this.envClk && t < 0.15) this.envClk = false;
        if (rising) this.envStage = 1;
        if (this.envStage === 1) {
          this.envLevel += (1.25 - this.envLevel) * atkK;
          if (this.envLevel >= 1) { this.envLevel = 1; this.envStage = envAsr ? 2 : 3; }
        } else if (this.envStage === 2) {
          if (!this.envClk) this.envStage = 3;
        } else if (this.envStage === 3) {
          this.envLevel -= this.envLevel * decK;
          if (this.envLevel < 1e-5) { this.envLevel = 0; this.envStage = 0; }
        }
        cur[iO.env] = this.envLevel;
      }

      // ---------------- FILTER (TPT state variable, soft-saturated) ----------------
      {
        const x = fastTanh(inp('vcf.in') * 0.8);
        let fc = cutBase * Math.pow(2, cvAmt * inp('vcf.cvin'));
        if (fc < 15) fc = 15; else if (fc > sr * 0.42) fc = sr * 0.42;
        const g = Math.tan(Math.PI * fc * inv);
        const a1 = 1 / (1 + g * (g + kRes)), a2 = g * a1, a3 = g * a2;
        const v3 = x - this.ic2;
        let v1 = a1 * this.ic1 + a2 * v3;
        const v2 = this.ic2 + a2 * this.ic1 + a3 * v3;
        v1 = fastTanh(v1 * 0.9) / 0.9;
        this.ic1 = 2 * v1 - this.ic1;
        this.ic2 = 2 * v2 - this.ic2;
        const lp = v2, bp = v1, hp = x - kRes * v1 - v2;
        let y;
        switch (vcfMode) { case 1: y = bp; break; case 2: y = hp; break; case 3: y = lp + hp; break; default: y = lp; }
        cur[iO.vcf] = y * 1.25;
        cur[iO.bp] = bp;
      }

      // ---------------- VCA ----------------
      {
        let gn = inp('vca.cvin') + bias;
        if (gn < 0) gn = 0; else if (gn > 1.2) gn = 1.2;
        cur[iO.vca] = inp('vca.in') * gn;
      }

      // ---------------- OUTPUT ----------------
      let y = inp('out.in') * vol;
      // DC blocker
      const dc = y - this.dcX + 0.9975 * this.dcY; this.dcX = y; this.dcY = dc;
      y = fastTanh(dc * 0.9);
      outL[s] = y; if (outR) outR[s] = y;
      if (this.recording) {
        this.recBuf[this.recPos++] = y;
        if (this.recPos === this.recBuf.length) this.flushRec();
      }
      this.scope[this.scopePos] = y; this.scopePos = (this.scopePos + 1) & 2047;

      // telemetry peaks
      for (let i = 0; i < this.nOut; i++) {
        const a = cur[i] < 0 ? -cur[i] : cur[i];
        if (a > this.peak[i]) this.peak[i] = a;
      }

      // swap buffers
      const tmp = prev; prev = cur; cur = tmp;
    }
    this.prev = prev; this.cur = cur;

    // ---------------- telemetry to UI (~30 Hz) ----------------
    this.teleCount += n;
    if (this.teleCount >= this.teleEvery) {
      this.teleCount = 0;
      const scope = new Float32Array(2048);
      const pos = this.scopePos;
      scope.set(this.scope.subarray(pos)); scope.set(this.scope.subarray(0, pos), 2048 - pos);
      const msg = {
        type: 'tele',
        peaks: Array.from(this.peak),
        scope,
        seq: {
          counter: this.counter, play: this.play, rec: this.rec, ptrnB: this.ptrnB, ptrnA: this.ptrnA,
          len: [this.seqLen[0], this.seqLen[1]], autoTune: this.autoTune,
          note: this.trackedNote, pitch: this.trackedPitch, clk: this.clkHigh,
          ref: [this.seqRef[0], this.seqRef[1]],
        },
      };
      if (this.sentVersion !== this.seqVersion) {
        msg.pattern = [Array.from(this.seq[0]), Array.from(this.seq[1])];
        this.sentVersion = this.seqVersion;
      }
      this.port.postMessage(msg, [scope.buffer]);
      this.peak.fill(0);
    }
    return true;
  }
}

registerProcessor('arenal-engine', ArenalProcessor);
