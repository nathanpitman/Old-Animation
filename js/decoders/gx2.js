/*!
 * gx2.js
 * Dependency-free decoder/player for Show Partner F/X (.GX2 frame + .SPS
 * script) files.
 *
 * decodeGX2 / gx2ToImageData / parseSPS are extracted verbatim (decode
 * logic unchanged) from standalone_players/showpartner_fx_player.html.
 *
 * GX2Player is a new wrapper (playlist/sequencing/event bookkeeping only —
 * not decode logic) built to mirror FLIPlayer/ANMPlayer's public interface.
 * It resolves each .SPS script entry to a same-directory .GX2 file at load
 * time; entries whose .GX2 wasn't part of this disk backup are skipped
 * during playback exactly as the original player left them (marked
 * "missing" rather than erroring).
 *
 * Usage:
 *   const player = new GX2Player(canvas);
 *   await player.load('tmp/disk11/LEM/LEMMING.SPS');
 *   player.play();
 */
(function (global) {
  'use strict';

  const SCREEN_W = 320;
  const SCREEN_H = 200;

  /* =========================================================================
     GX2 decoder — reverse engineered from the on-disk header + verified
     against LEMMING.GX2 (RLE stream consumes to exactly the header-declared
     size with zero slack).
     Header:  "GX2"+0x01 | u16 headerSize(0x19) | u8 bpp | u16 width | u16 height
              | u16 aspectX | u16 aspectY | u8 unk | u16 subhSize | "SPFX"
              | u16 unk | u8 unk | u16 unk | palette[256*3]
     Pixel data (from offset 0x31B) is: RLE (high-bit=repeat, low 7 bits=count)
     -> then a per-row bitmask stream where set bits pull a fresh byte and
     clear bits copy the pixel directly above.
     ========================================================================= */
  function decodeGX2(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (String.fromCharCode(bytes[0], bytes[1], bytes[2]) !== "GX2") throw new Error("Not a GX2 file");
    const bpp = bytes[6];
    const width = dv.getUint16(7, true);
    const height = dv.getUint16(9, true);
    const palStart = 0x1B;
    const palette = new Uint8Array(768);
    palette.set(bytes.subarray(palStart, palStart + 768));
    const rle = bytes.subarray(palStart + 768);

    // 1. RLE decode -> bitmask-compressed row stream
    const bm = [];
    for (let i = 0; i < rle.length;) {
      const code = rle[i++];
      const repeat = (code & 0x80) !== 0;
      const amount = code & 0x7f;
      if (repeat) {
        const val = rle[i++];
        for (let k = 0; k < amount; k++) bm.push(val);
      } else {
        for (let k = 0; k < amount; k++) bm.push(rle[i++]);
      }
    }
    const bmData = Uint8Array.from(bm);

    // 2. bitmask expand -> full stride*height indexed image
    const stride = width;
    const maskLen = (stride + 7) >> 3;
    const out = new Uint8Array(stride * height);
    out.set(bmData.subarray(0, stride));
    let prevRow = 0, writePtr = stride, inPtr = stride;
    for (let y = 1; y < height; y++) {
      const maskPtr = inPtr;
      inPtr += maskLen;
      for (let x = 0; x < stride; x++) {
        const bit = (bmData[maskPtr + (x >> 3)] << (x & 7)) & 0x80;
        if (bit) { out[writePtr] = bmData[inPtr++]; }
        else { out[writePtr] = out[prevRow + x]; }
        writePtr++;
      }
      prevRow += stride;
    }

    return { width, height, bpp, palette, indices: out, consumedAll: inPtr === bmData.length };
  }

  function gx2ToImageData(gx2) {
    const { width, height, palette, indices } = gx2;
    const imgData = new ImageData(width, height);
    const d = imgData.data;
    for (let i = 0; i < indices.length; i++) {
      const idx = indices[i];
      d[i * 4 + 0] = palette[idx * 3 + 0];
      d[i * 4 + 1] = palette[idx * 3 + 1];
      d[i * 4 + 2] = palette[idx * 3 + 2];
      d[i * 4 + 3] = 255;
    }
    return imgData;
  }

  /* =========================================================================
     SPS parser — 44 fixed 42-byte records: 20-byte padded filename + 22
     bytes of fields (x1,y1,x2,y2,w,h,x3,y3,flag1,flag2,delay as little-
     endian words). Exact semantics of every field aren't fully reversed,
     but position/size/name are solid enough for a script readout.
     ========================================================================= */
  function parseSPS(bytes) {
    const RECSZ = 42;
    const n = Math.floor(bytes.length / RECSZ);
    const entries = [];
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < n; i++) {
      const off = i * RECSZ;
      let raw = bytes.subarray(off, off + 20);
      let name = "";
      for (let c of raw) { if (c === 0) break; name += String.fromCharCode(c); }
      name = name.trim();
      const f = [];
      for (let w = 0; w < 11; w++) f.push(dv.getUint16(off + 20 + w * 2, true));
      entries.push({
        name, x: f[2], y: f[3], w: f[4], h: f[5], delay: f[10]
      });
    }
    return entries;
  }

  // ---- Public player class (playback/sequencing bookkeeping, new code) ----

  class GX2Player extends EventTarget {
    constructor(canvas, opts) {
      super();
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.opts = Object.assign({ loop: true, frameDelayMs: 350 }, opts);
      this.entries = [];
      this.assets = new Map(); // uppercased filename -> { gx2, imgData }
      this.curIndex = 0;
      this._playing = false;
      this._timer = null;
    }

    get width() { return SCREEN_W; }
    get height() { return SCREEN_H; }
    get frameCount() { return this.entries.length; }
    get frameIndex() { return this.curIndex; }
    get isPlaying() { return this._playing; }

    /** Load an .SPS script; sibling .GX2 files are resolved from the same directory. */
    async load(spsUrl) {
      this.pause();
      this.assets.clear();
      const dir = spsUrl.slice(0, spsUrl.lastIndexOf('/'));

      const spsBuf = await fetch(spsUrl).then((r) => {
        if (!r.ok) throw new Error('Failed to fetch ' + spsUrl + ': ' + r.status);
        return r.arrayBuffer();
      });
      this.entries = parseSPS(new Uint8Array(spsBuf));

      const uniqueNames = [...new Set(this.entries.map((e) => e.name).filter(Boolean))];
      await Promise.all(uniqueNames.map(async (name) => {
        try {
          const bytes = new Uint8Array(await fetch(dir + '/' + name).then((r) => {
            if (!r.ok) throw new Error(String(r.status));
            return r.arrayBuffer();
          }));
          const gx2 = decodeGX2(bytes);
          this.assets.set(name.toUpperCase(), { gx2, imgData: gx2ToImageData(gx2) });
        } catch (e) {
          // Frame not present in this disk backup — left unresolved, exactly
          // like the original player's drag-and-drop "MISSING" rows.
        }
      }));

      this.canvas.width = SCREEN_W;
      this.canvas.height = SCREEN_H;
      this.curIndex = 0;
      this._renderCurrent();
      this.dispatchEvent(new CustomEvent('load', {
        detail: { width: SCREEN_W, height: SCREEN_H, frameCount: this.entries.length, resolved: this.assets.size },
      }));
      this.dispatchEvent(new CustomEvent('frame', { detail: { index: 0 } }));
      return this;
    }

    _renderCurrent() {
      const entry = this.entries[this.curIndex];
      this.ctx.fillStyle = '#000';
      this.ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
      if (!entry) return;
      const asset = entry.name && this.assets.get(entry.name.toUpperCase());
      if (asset) {
        this.ctx.putImageData(asset.imgData, 0, 0);
      }
    }

    seek(i) {
      if (this.entries.length === 0) return;
      this.curIndex = Math.max(0, Math.min(this.entries.length - 1, i));
      this._renderCurrent();
      this.dispatchEvent(new CustomEvent('frame', { detail: { index: this.curIndex } }));
    }

    stepFrame(dir) {
      if (this.entries.length === 0) return;
      this.seek((this.curIndex + dir + this.entries.length) % this.entries.length);
    }

    play() {
      if (this._playing || this.entries.length === 0) return;
      this._playing = true;
      const tick = () => {
        if (!this._playing) return;
        const next = this.curIndex + 1;
        if (next >= this.entries.length) {
          if (this.opts.loop) this.seek(0);
          else { this.pause(); return; }
        } else {
          this.seek(next);
        }
        this._timer = setTimeout(tick, this.opts.frameDelayMs);
      };
      this._timer = setTimeout(tick, this.opts.frameDelayMs);
      this.dispatchEvent(new CustomEvent('play'));
    }

    pause() {
      this._playing = false;
      if (this._timer) clearTimeout(this._timer);
      this._timer = null;
      this.dispatchEvent(new CustomEvent('pause'));
    }

    stop() {
      this.pause();
      this.seek(0);
    }

    toggle() {
      this._playing ? this.pause() : this.play();
    }

    destroy() {
      this.pause();
    }
  }

  global.GX2Player = GX2Player;
  global.decodeGX2 = decodeGX2;
  global.parseSPS = parseSPS;
})(typeof window !== 'undefined' ? window : globalThis);
