# Arenal

A browser-based semi-modular synthesizer built around a pitch-recording pattern generator.
Open `index.html` over HTTP (AudioWorklet needs it), for example:

```bash
python3 -m http.server 8000
```

then visit http://localhost:8000 and press **Start audio**.

## Modules

| Module | What it does |
| --- | --- |
| OSC A | Tracked VCO (triangle, square). Its pitch is measured continuously, quantized and recorded by PATTERN. |
| OSC B | Free VCO with LO (LFO) / HI (audio) range. |
| TEMPO | Clock LFO. Normalled to the pattern clock, STRATA, S&H. |
| STRATA | 8-bit shift-register random (rungler style): LOCK loops, FLIP doubles the loop, RAND injects DATA bits. |
| GRAIN | Noise and sample & hold with slew. |
| XOR | Logic XOR of two squares. |
| MIX | Three-channel mixer. |
| FILTER | 2-pole state-variable filter, LP/BP/HP/notch, self-oscillating. |
| ENVELOPE | AD or ASR envelope. |
| VCA | Amplifier with a DRONE bias. |
| PATTERN | Pitch recorder and quantizer with two 64-step patterns. |
| OUTPUT | Volume and scope. |

Every input is normalled (the source is printed under the jack), so the synth plays with no cables.
A cable overrides the normal. Any output can go to any input, feedback included: the engine runs
every module per sample with a one-sample delay on each cable.

## Pattern recorder

Ported from the softPop pattern generator firmware:

* **REC** (hold): writes the tracked note of OSC A on each falling clock edge. On release the
  length snaps to 2, 4, 8, 16, 32, 48 or 64 steps; 3, 12 and 24 are kept.
* **A / B**: start, switch and stop the two patterns.
* **QUANT**: auto-tune. OSC A is pulled onto the nearest note of the selected scale
  (the firmware's 13-scale table).
* Patterns, QUANT and the selected pattern are kept in browser storage, like the original EEPROM.
* Patch **TRACK** to record the pitch of any other signal.

## Patches and recording

* **Save** stores the current patch (every knob, switch, cable and both patterns) in this browser
  under the name you type. Saving with an existing name updates it. **Delete** asks for a second click.
* **Export** writes the patch to a `.json` file; **Import** loads one back and adds it to your saved patches.
* **RECORD** on the OUTPUT module captures the main output as a mono 24-bit PCM WAV at the audio
  device's sample rate (TPDF-dithered, up to 20 minutes per take). When Arenal runs as a hosted
  claude.ai page, the WAV is delivered inside a `.zip`, because the host doesn't accept `.wav` downloads.

Keyboard: `A`–`;` play notes, `Z`/`X` octave, hold `Space` to record, `1`/`2` patterns, `Q` QUANT.

## Files

* `js/spec.js`: modules, jacks, knobs and normalled routes (shared by UI and engine)
* `js/engine-worklet.js`: DSP engine (AudioWorkletProcessor)
* `js/app.js`: UI, patch cables, patches, recorder, keyboard
* `js/files.js`: 24-bit WAV encoder, zip writer, file saving
* `css/arenal.css`: styling

## License and credit

The pattern recorder and quantizer are adapted from the softPop firmware by Václav Peloušek /
Bastl Instruments (2017), released under CC BY-SA. This project is shared under the same
license, [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/).
