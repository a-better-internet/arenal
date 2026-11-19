/*
 * ARENAL — file helpers: 24-bit WAV encoding, a minimal zip writer, and saving.
 */
(function (g) {
  'use strict';

  // 24-bit signed PCM, little endian, TPDF dither on the 24-bit LSB.
  function encodeWav24(chunks, sampleRate, channels = 1) {
    let frames = 0;
    for (const c of chunks) frames += c.length;
    frames = Math.floor(frames / channels);
    const dataBytes = frames * channels * 3;
    const buf = new ArrayBuffer(44 + dataBytes);
    const v = new DataView(buf);
    const str = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + dataBytes, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, channels, true);
    v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * channels * 3, true);
    v.setUint16(32, channels * 3, true); v.setUint16(34, 24, true);
    str(36, 'data'); v.setUint32(40, dataBytes, true);
    const out = new Uint8Array(buf);
    let o = 44;
    const end = 44 + dataBytes;
    for (const c of chunks) {
      for (let i = 0; i < c.length && o < end; i++) {
        let x = c[i];
        x = x > 1 ? 1 : x < -1 ? -1 : x;
        let n = Math.round(x * 8388607 + (Math.random() - Math.random()));
        if (n > 8388607) n = 8388607; else if (n < -8388608) n = -8388608;
        out[o++] = n & 255; out[o++] = (n >> 8) & 255; out[o++] = (n >> 16) & 255;
      }
    }
    return new Blob([buf], { type: 'audio/wav' });
  }

  // ---- store-only zip (single or multiple files) ---------------------------
  const CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(u8) { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

  async function zip(files) { // [{name, blob}]
    const parts = [], central = [];
    let offset = 0;
    const d = new Date();
    const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    for (const f of files) {
      const data = new Uint8Array(await f.blob.arrayBuffer());
      const name = new TextEncoder().encode(f.name);
      const crc = crc32(data);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
      lh.setUint16(8, 0, true); lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true);
      lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true);
      lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      parts.push(lh.buffer, name, data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, 0, true); ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true);
      ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true);
      ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
      central.push(ch.buffer, name);
      offset += 30 + name.length + data.length;
    }
    let cdSize = 0; for (const c of central) cdSize += c.byteLength;
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
  }

  // ---- saving ----------------------------------------------------------------
  // In a claude.ai artifact the page may only hand files over through the
  // "downloads" capability, which accepts a fixed list of extensions (.wav is
  // not on it, so audio goes inside a .zip there). Elsewhere: a plain download.
  let dlPromise = null;
  function downloadsCap() {
    if (!dlPromise) {
      dlPromise = (g.claude && typeof g.claude.use === 'function')
        ? g.claude.use('downloads').catch(() => null)
        : Promise.resolve(null);
    }
    return dlPromise;
  }
  const HOSTED_OK = /\.(json|zip|txt|csv)$/i;

  async function saveFile(filename, blob) {
    const dl = await downloadsCap();
    if (dl) {
      let name = filename, data = blob;
      if (!HOSTED_OK.test(name)) { data = await zip([{ name, blob }]); name = name.replace(/\.[^.]+$/, '') + '.zip'; }
      try { await dl.save({ filename: name, data }); return { ok: true, name }; }
      catch (e) { return { ok: false, code: e && e.code, name }; }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    return { ok: true, name: filename };
  }

  g.ArenalFiles = { encodeWav24, zip, crc32, saveFile };
})(typeof window !== 'undefined' ? window : globalThis);
