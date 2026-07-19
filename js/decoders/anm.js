/*!
 * anm.js
 * Dependency-free decoder/player for DeluxePaint Animation (.ANM) files.
 *
 * parseANM / decodeFrame / computeCycledPalette / buildFramesFromParsed are
 * extracted verbatim (decode logic unchanged) from
 * standalone_players/deluxe_paint_animation_player.html.
 *
 * ANMPlayer is a new wrapper (playback/playlist/event bookkeeping only —
 * not decode logic) built to mirror FLIPlayer's public interface so a
 * unified player can drive both the same way.
 *
 * Usage:
 *   const player = new ANMPlayer(canvas);
 *   await player.load(['a.anm', 'b.anm']); // or a single url string
 *   player.play();
 */
(function (global) {
  'use strict';

  // ---------- ANM parsing ----------
  // Format derived from FFmpeg's libavformat/anm.c + libavcodec/anm.c (Deluxe
  // Paint Animation demuxer/decoder), cross-checked against the header layout
  // documented on wiki.multimedia.cx (recovered from iffanim.txt).

  function parseANM(arrayBuffer) {
    const u8 = new Uint8Array(arrayBuffer);
    const dv = new DataView(arrayBuffer);
    const len = u8.length;

    function need(n, what) {
      if (n > len) throw new Error("File too short while reading " + what + ".");
    }

    need(4, "magic");
    const magic = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);

    need(16, "page header");
    let nbRecordsRaw = dv.getUint32(8, true);
    const pageTableOffset = dv.getUint16(14, true);

    need(24, "anim tag / dimensions");
    const animTag = String.fromCharCode(u8[16], u8[17], u8[18], u8[19]);
    const width = dv.getUint16(20, true);
    const height = dv.getUint16(22, true);

    if (magic !== "LPF " || animTag !== "ANIM") {
      throw new Error("Not a recognized DeluxePaint Animation file — expected an 'LPF ' / 'ANIM' signature.");
    }
    if (!width || !height || width > 4096 || height > 4096) {
      throw new Error("Header parsed but dimensions look invalid (" + width + "x" + height + ").");
    }

    need(70, "header flags");
    const hasLastDelta = u8[26];
    if (hasLastDelta) nbRecordsRaw = Math.max(nbRecordsRaw - 1, 0);

    need(70, "frame count / rate");
    let fps = dv.getUint16(68, true);
    if (!fps || fps > 240) fps = 10;

    // Bytes 70..127 are 58 bytes of filler, rounding the fixed header to 128
    // bytes. Immediately after that: 16 palette-cycle "Range" structs (8
    // bytes each = 128 bytes), then the 256-colour palette (4 bytes each =
    // 1024 bytes: R,G,B,pad).
    const cyclesStart = 128;
    need(cyclesStart + 16 * 8, "cycle ranges");
    const cycles = [];
    for (let i = 0; i < 16; i++) {
      const o = cyclesStart + i * 8;
      const count = dv.getUint16(o, true);
      const rate = dv.getUint16(o + 2, true);
      const flags = dv.getUint16(o + 4, true);
      const low = u8[o + 6];
      const high = u8[o + 7];
      const activeBit = !!(flags & 1);
      const reverse = !!(flags & 2);
      // The documented Amiga CRNG convention gates cycling on bit0
      // ("RNG_ACTIVE"), but real-world DPaint Animation exports are
      // inconsistent about setting it. A defined rate + a real span is a
      // more reliable signal in practice.
      if (high > low && rate > 0) {
        cycles.push({ count, rate, flags, low, high, reverse, activeBit });
      }
    }

    const paletteStart = cyclesStart + 128; // 256
    need(paletteStart + 256 * 4, "palette");
    const palette = new Uint8Array(256 * 3);
    for (let i = 0; i < 256; i++) {
      const o = paletteStart + i * 4;
      // On-disk order is (Blue, Green, Red, pad) — confirmed against ffmpeg's
      // reference ANM decoder (which VLC also uses), not the (Red, Green,
      // Blue, pad) that the recovered multimedia.cx documentation describes
      // in plain English. ffmpeg reads each entry as a little-endian 32-bit
      // ARGB int, which only lines up with real files if red is the third
      // byte on disk.
      palette[i * 3 + 0] = u8[o + 2]; // R
      palette[i * 3 + 1] = u8[o + 1]; // G
      palette[i * 3 + 2] = u8[o];     // B
    }

    // Page table: up to 256 entries, 6 bytes each, at pageTableOffset.
    const MAX_PAGES = 256;
    need(pageTableOffset + MAX_PAGES * 6, "page table");
    const pages = [];
    for (let i = 0; i < MAX_PAGES; i++) {
      const o = pageTableOffset + i * 6;
      pages.push({
        baseRecord: dv.getUint16(o, true),
        nbRecords: dv.getUint16(o + 2, true),
        size: dv.getUint16(o + 4, true),
      });
    }

    const pageDataBase = pageTableOffset + MAX_PAGES * 6;
    const recordInfo = [];
    let pagesUsed = 0;

    for (let pi = 0; pi < MAX_PAGES; pi++) {
      const p = pages[pi];
      if (p.nbRecords <= 0) continue;
      pagesUsed++;
      const pageStart = pageDataBase + pi * 65536;
      if (pageStart + 8 + p.nbRecords * 2 > len) continue;
      const sizeTableStart = pageStart + 8;
      let cursor = pageStart + 8 + p.nbRecords * 2;
      for (let k = 0; k < p.nbRecords; k++) {
        const sz = dv.getUint16(sizeTableStart + k * 2, true);
        const globalIdx = p.baseRecord + k;
        recordInfo[globalIdx] = { offset: cursor, size: sz };
        cursor += sz;
      }
    }

    const nbRecords = Math.min(nbRecordsRaw, recordInfo.length || nbRecordsRaw);

    return { width, height, fps, nbRecords, palette, cycles, recordInfo, u8, pagesUsed };
  }

  // ---------- Single-frame opcode decoder (RLE stream, ported from libavcodec/anm.c) ----------

  function decodeFrame(u8, offset, size, indexBuf, width, height) {
    if (size < 4) return;
    const end = offset + size;
    let p = offset;
    p += 4; // record type byte, padding byte, 2 reserved bytes

    const total = width * height;
    let dstPix = 0;
    let x = 0;

    function doOp(isCopy, pixel, count) {
      let remaining = width - x;
      while (count > 0) {
        let striplen = Math.min(count, remaining);
        if (isCopy) {
          const avail = Math.max(0, Math.min(striplen, end - p));
          if (avail <= 0) return true;
          indexBuf.set(u8.subarray(p, p + avail), dstPix);
          p += avail;
          striplen = avail;
        } else if (pixel >= 0) {
          indexBuf.fill(pixel, dstPix, dstPix + striplen);
        }
        dstPix += striplen;
        remaining -= striplen;
        count -= striplen;
        if (remaining <= 0) remaining = width;
        if (dstPix >= total) return true;
      }
      x = width - remaining;
      return false;
    }

    while (p < end) {
      const typeByte = u8[p++];
      let count = typeByte & 0x7F;
      const type = typeByte >> 7;

      if (count) {
        if (doOp(type === 0, -1, count)) break;
      } else if (type === 0) {
        if (p + 2 > end) break;
        const cnt = u8[p++];
        const pixel = u8[p++];
        if (cnt === 0) continue;
        if (doOp(false, pixel, cnt)) break;
      } else {
        if (p + 2 > end) break;
        const raw = u8[p] | (u8[p + 1] << 8);
        p += 2;
        let count2 = raw & 0x3FFF;
        const type2 = raw >>> 14;
        if (count2 === 0) {
          if (type2 === 0) break;
          if (type2 === 2) break;
          continue;
        } else {
          let pixel = -1;
          if (type2 === 3) { if (p >= end) break; pixel = u8[p++]; }
          if (type2 === 1) count2 += 0x4000;
          if (doOp(type2 === 2, pixel, count2)) break;
        }
      }
    }
  }

  // ---------- Palette cycling ----------

  function computeCycledPalette(basePalette, cycles, elapsedSeconds, scratch) {
    const pal = scratch || basePalette.slice();
    pal.set(basePalette);
    for (const c of cycles) {
      const rangeSize = c.high - c.low + 1;
      const stepsPerSec = c.rate * 60 / 16384;
      let shift = Math.floor(elapsedSeconds * stepsPerSec) % rangeSize;
      if (c.reverse) shift = -shift;
      shift = ((shift % rangeSize) + rangeSize) % rangeSize;
      if (shift === 0) continue;
      for (let i = 0; i < rangeSize; i++) {
        const srcIdx = c.low + ((i - shift) % rangeSize + rangeSize) % rangeSize;
        const dstIdx = c.low + i;
        pal[dstIdx * 3] = basePalette[srcIdx * 3];
        pal[dstIdx * 3 + 1] = basePalette[srcIdx * 3 + 1];
        pal[dstIdx * 3 + 2] = basePalette[srcIdx * 3 + 2];
      }
    }
    return pal;
  }

  function buildFramesFromParsed(parsed) {
    const { width, height, recordInfo, u8, nbRecords } = parsed;
    const frames = [];
    let indexBuf = new Uint8Array(width * height);
    for (let i = 0; i < nbRecords; i++) {
      const rec = recordInfo[i];
      if (rec && rec.offset + rec.size <= u8.length) {
        decodeFrame(u8, rec.offset, rec.size, indexBuf, width, height);
      }
      frames.push(indexBuf.slice());
    }
    return frames;
  }

  async function fetchAndParse(url) {
    const buf = await fetch(url).then((r) => {
      if (!r.ok) throw new Error('Failed to fetch ' + url + ': ' + r.status);
      return r.arrayBuffer();
    });
    const parsed = parseANM(buf);
    const frames = buildFramesFromParsed(parsed);
    if (frames.length === 0) throw new Error('No valid frames/records found.');
    return {
      name: url.split('/').pop(),
      url,
      width: parsed.width,
      height: parsed.height,
      fps: parsed.fps,
      palette: parsed.palette,
      cycles: parsed.cycles,
      frames,
    };
  }

  // ---- Public player class (playback/playlist bookkeeping, new code) ----

  class ANMPlayer extends EventTarget {
    constructor(canvas, opts) {
      super();
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.opts = Object.assign({ loop: true, cycle: true, staticDurationSec: 5, fps: null }, opts);
      this.playlist = [];
      this.curIndex = -1;
      this.curFrame = 0;
      this._playing = false;
      this._rafId = null;
      this._lastFrameTick = 0;
      this._itemStartTime = 0;
      this._workingPalette = null;
    }

    get track() {
      return this.curIndex >= 0 ? this.playlist[this.curIndex] : null;
    }

    get width() { return this.track ? this.track.width : 0; }
    get height() { return this.track ? this.track.height : 0; }
    get frameCount() { return this.track ? this.track.frames.length : 0; }
    get frameIndex() { return this.curFrame; }
    get isPlaying() { return this._playing; }
    get trackCount() { return this.playlist.length; }

    /** Load a single URL or an array of URLs, played back as a playlist. */
    async load(source) {
      const urls = Array.isArray(source) ? source : [source];
      this.pause();
      this.playlist = [];
      for (const url of urls) {
        const track = await fetchAndParse(url);
        this.playlist.push(track);
      }
      this.curIndex = -1;
      this._goToIndex(0);
      this._startLoop();
      this.dispatchEvent(new CustomEvent('load', {
        detail: { width: this.width, height: this.height, trackCount: this.playlist.length },
      }));
      return this;
    }

    _goToIndex(idx) {
      if (idx < 0 || idx >= this.playlist.length) return;
      this.curIndex = idx;
      this.curFrame = 0;
      this._itemStartTime = performance.now();
      this._workingPalette = this.track.palette.slice();

      const zoom = 1;
      this.canvas.width = this.width;
      this.canvas.height = this.height;

      this.dispatchEvent(new CustomEvent('trackchange', { detail: { index: idx, track: this.track } }));
      this._renderCurrent();
      this.dispatchEvent(new CustomEvent('frame', { detail: { index: 0 } }));
    }

    _renderCurrent() {
      const state = this.track;
      if (!state) return;
      const { width, height, palette, cycles, frames } = state;
      const cyclingOn = this.opts.cycle && cycles.length > 0;
      let pal = palette;
      if (cyclingOn) {
        const elapsed = (performance.now() - this._itemStartTime) / 1000;
        pal = computeCycledPalette(palette, cycles, elapsed, this._workingPalette);
      }
      const idxBuf = frames[this.curFrame];
      const img = this.ctx.createImageData(width, height);
      const data = img.data;
      for (let p = 0; p < idxBuf.length; p++) {
        const c = idxBuf[p] * 3;
        const o = p * 4;
        data[o] = pal[c];
        data[o + 1] = pal[c + 1];
        data[o + 2] = pal[c + 2];
        data[o + 3] = 255;
      }
      this.ctx.putImageData(img, 0, 0);
    }

    seek(i) {
      const state = this.track;
      if (!state) return;
      this.curFrame = Math.max(0, Math.min(state.frames.length - 1, i));
      this._renderCurrent();
      this.dispatchEvent(new CustomEvent('frame', { detail: { index: this.curFrame } }));
    }

    nextTrack() {
      if (this.playlist.length < 2) return;
      this._goToIndex((this.curIndex + 1) % this.playlist.length);
    }

    prevTrack() {
      if (this.playlist.length < 2) return;
      this._goToIndex((this.curIndex - 1 + this.playlist.length) % this.playlist.length);
    }

    _advanceTrack() {
      if (this.playlist.length < 2) {
        // Single track: just loop frame 0 (dwell already handled by caller).
        this.curFrame = 0;
        return;
      }
      let next = this.curIndex + 1;
      if (next >= this.playlist.length) {
        if (this.opts.loop) next = 0;
        else { this.pause(); return; }
      }
      this._goToIndex(next);
    }

    play() {
      if (this._playing || !this.track) return;
      this._playing = true;
      this._lastFrameTick = performance.now();
      this.dispatchEvent(new CustomEvent('play'));
    }

    pause() {
      this._playing = false;
      this.dispatchEvent(new CustomEvent('pause'));
    }

    stop() {
      this.pause();
      this.seek(0);
    }

    toggle() {
      this._playing ? this.pause() : this.play();
    }

    _startLoop() {
      if (this._rafId) cancelAnimationFrame(this._rafId);
      this._lastFrameTick = performance.now();
      const loop = (now) => {
        const state = this.track;
        if (state && this._playing) {
          if (state.frames.length > 1) {
            const fps = Math.max(1, this.opts.fps || state.fps || 10);
            const interval = 1000 / fps;
            if (now - this._lastFrameTick >= interval) {
              this._lastFrameTick = now;
              const next = this.curFrame + 1;
              if (next >= state.frames.length) {
                if (this.playlist.length > 1) {
                  this._advanceTrack();
                } else if (this.opts.loop) {
                  this.curFrame = 0;
                } else {
                  this.pause();
                }
              } else {
                this.curFrame = next;
              }
              this.dispatchEvent(new CustomEvent('frame', { detail: { index: this.curFrame } }));
            }
          } else if (this.playlist.length > 1) {
            // Static (single-frame, possibly palette-cycled) track: hold for
            // the configured duration, then move on.
            const holdMs = Math.max(1, this.opts.staticDurationSec) * 1000;
            if (now - this._itemStartTime >= holdMs) this._advanceTrack();
          }
        }
        if (state) this._renderCurrent();
        this._rafId = requestAnimationFrame(loop);
      };
      this._rafId = requestAnimationFrame(loop);
    }

    destroy() {
      this.pause();
      if (this._rafId) cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  global.ANMPlayer = ANMPlayer;
  global.parseANM = parseANM;
})(typeof window !== 'undefined' ? window : globalThis);
