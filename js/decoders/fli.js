/*!
 * fli.js
 * Dependency-free decoder/player for Autodesk Animator .FLI and
 * Autodesk Animator Pro .FLC files, rendered to an HTML5 canvas.
 *
 * Extracted verbatim (decode logic unchanged) from
 * standalone_players/autodesk_animator_player.html.
 *
 * Supports the chunk types found in real-world FLI/FLC files:
 *   11 COLOR_64    (64-level / 6-bit VGA palette)
 *    4 COLOR_256   (8-bit palette)
 *   15 BRUN        (byte-run compressed keyframe)
 *   16 COPY        (raw uncompressed frame)
 *   12 LC          (line-compressed delta frame)
 *    7 SS2         (word-run delta frame, FLC only)
 *   13 BLACK       (clear frame to color 0)
 *   18 PSTAMP      (thumbnail preview, ignored)
 *
 * Usage:
 *   const player = new FLIPlayer(canvas);
 *   await player.load(url_or_arraybuffer);
 *   player.play();
 */
(function (global) {
  'use strict';

  // ---- Chunk type constants -----------------------------------------
  const CT_COLOR_256 = 4;
  const CT_SS2 = 7;
  const CT_COLOR_64 = 11;
  const CT_LC = 12;
  const CT_BLACK = 13;
  const CT_BRUN = 15;
  const CT_COPY = 16;
  const CT_PSTAMP = 18;

  const FRAME_MAGIC = 0xf1fa;
  const FLI_MAGIC = 0xaf11;
  const FLC_MAGIC = 0xaf12;

  /**
   * Decode a full FLI/FLC file into { width, height, frameDelaysMs, frames }
   * where `frames` is an array of Uint8ClampedArray RGBA buffers, one per
   * animation frame, fully resolved (deltas already applied).
   */
  function decodeFLI(buffer) {
    const data = new DataView(buffer);
    const bytes = new Uint8Array(buffer);

    const magic = data.getUint16(4, true);
    if (magic !== FLI_MAGIC && magic !== FLC_MAGIC) {
      throw new Error(
        'Not a recognized FLI/FLC file (bad magic 0x' + magic.toString(16) + ')'
      );
    }
    const frameCount = data.getUint16(6, true);
    const width = data.getUint16(8, true);
    const height = data.getUint16(10, true);

    let speedMs;
    if (magic === FLC_MAGIC) {
      // FLC: speed is milliseconds per frame (32-bit)
      speedMs = data.getUint32(16, true) || 71;
    } else {
      // Classic FLI: speed is jiffies (1/70 sec) per frame (16-bit)
      const jiffies = data.getUint16(16, true) || 5;
      speedMs = Math.round((jiffies * 1000) / 70);
    }

    // Working state carried between frames.
    const palette = new Uint8Array(256 * 3); // RGB triples
    for (let i = 0; i < 256; i++) {
      palette[i * 3] = palette[i * 3 + 1] = palette[i * 3 + 2] = i; // default grayscale
    }
    const indexBuf = new Uint8Array(width * height); // current 8-bit indexed frame

    const frames = [];
    const frameDelaysMs = [];

    let pos = 128; // FLI/FLC header is always 128 bytes
    for (let f = 0; f < frameCount && pos < bytes.length; f++) {
      const fSize = data.getUint32(pos, true);
      const fMagic = data.getUint16(pos + 4, true);
      const nChunks = data.getUint16(pos + 6, true);
      if (fMagic !== FRAME_MAGIC) break; // ring frame or corrupt data — stop safely

      let cpos = pos + 16;
      for (let c = 0; c < nChunks; c++) {
        const cSize = data.getUint32(cpos, true);
        const cType = data.getUint16(cpos + 4, true);
        const cStart = cpos + 6;
        switch (cType) {
          case CT_COLOR_64:
            readPalette(bytes, cStart, palette, 63);
            break;
          case CT_COLOR_256:
            readPalette(bytes, cStart, palette, 255);
            break;
          case CT_BRUN:
            decodeBRUN(bytes, cStart, indexBuf, width, height);
            break;
          case CT_COPY:
            indexBuf.set(bytes.subarray(cStart, cStart + width * height));
            break;
          case CT_LC:
            decodeLC(bytes, cStart, indexBuf, width, height);
            break;
          case CT_SS2:
            decodeSS2(bytes, cStart, indexBuf, width, height);
            break;
          case CT_BLACK:
            indexBuf.fill(0);
            break;
          case CT_PSTAMP:
          default:
            break; // unsupported/decorative chunk — skip
        }
        cpos += cSize;
      }

      // Resolve this frame's indexed buffer to RGBA using the current palette.
      const rgba = new Uint8ClampedArray(width * height * 4);
      for (let i = 0, p = 0; i < indexBuf.length; i++, p += 4) {
        const idx = indexBuf[i] * 3;
        rgba[p] = palette[idx];
        rgba[p + 1] = palette[idx + 1];
        rgba[p + 2] = palette[idx + 2];
        rgba[p + 3] = 255;
      }
      frames.push(rgba);
      frameDelaysMs.push(speedMs);

      pos += fSize;
    }

    return { width, height, frameDelaysMs, frames };
  }

  function readPalette(bytes, pos, palette, maxLevel) {
    const scale = maxLevel === 63 ? (v) => Math.round((v * 255) / 63) : (v) => v;
    const numPackets = bytes[pos] | (bytes[pos + 1] << 8);
    pos += 2;
    let idx = 0;
    for (let p = 0; p < numPackets; p++) {
      const skip = bytes[pos++];
      let change = bytes[pos++];
      if (change === 0) change = 256;
      idx += skip;
      for (let i = 0; i < change; i++) {
        palette[idx * 3] = scale(bytes[pos++]);
        palette[idx * 3 + 1] = scale(bytes[pos++]);
        palette[idx * 3 + 2] = scale(bytes[pos++]);
        idx++;
      }
    }
  }

  function decodeBRUN(bytes, pos, indexBuf, width, height) {
    for (let y = 0; y < height; y++) {
      const rowOff = y * width;
      const numPackets = bytes[pos++];
      let x = 0;
      for (let p = 0; p < numPackets; p++) {
        let sb = bytes[pos++];
        if (sb > 127) sb -= 256; // signed byte
        if (sb > 0) {
          const color = bytes[pos++];
          for (let i = 0; i < sb; i++) indexBuf[rowOff + x++] = color;
        } else {
          const count = -sb;
          for (let i = 0; i < count; i++) indexBuf[rowOff + x++] = bytes[pos++];
        }
      }
    }
  }

  function decodeLC(bytes, pos, indexBuf, width, height) {
    const skipLines = bytes[pos] | (bytes[pos + 1] << 8);
    const numLines = bytes[pos + 2] | (bytes[pos + 3] << 8);
    pos += 4;
    let y = skipLines;
    for (let li = 0; li < numLines; li++, y++) {
      const rowOff = y * width;
      const numPackets = bytes[pos++];
      let x = 0;
      for (let p = 0; p < numPackets; p++) {
        x += bytes[pos++]; // column skip
        let sb = bytes[pos++];
        if (sb > 127) sb -= 256;
        if (sb >= 0) {
          for (let i = 0; i < sb; i++) indexBuf[rowOff + x++] = bytes[pos++];
        } else {
          const count = -sb;
          const color = bytes[pos++];
          for (let i = 0; i < count; i++) indexBuf[rowOff + x++] = color;
        }
      }
    }
  }

  function decodeSS2(bytes, pos, indexBuf, width, height) {
    const numLines = bytes[pos] | (bytes[pos + 1] << 8);
    pos += 2;
    let y = 0;
    let linesDone = 0;
    while (linesDone < numLines) {
      let first = bytes[pos] | (bytes[pos + 1] << 8);
      pos += 2;
      if ((first & 0xc000) === 0xc000) {
        // skip N lines (stored as negative count)
        y += 0x10000 - first;
        continue;
      }
      let packets;
      const rowOff = y * width;
      let x = 0;
      if ((first & 0xc000) === 0x4000) {
        // low byte sets the last pixel of the line directly
        indexBuf[rowOff + width - 1] = first & 0xff;
        packets = bytes[pos] | (bytes[pos + 1] << 8);
        pos += 2;
      } else {
        packets = first;
      }
      for (let p = 0; p < packets; p++) {
        x += bytes[pos++]; // column skip
        let sb = bytes[pos++];
        if (sb > 127) sb -= 256;
        if (sb >= 0) {
          for (let i = 0; i < sb; i++) {
            const lo = bytes[pos++];
            const hi = bytes[pos++];
            indexBuf[rowOff + x++] = lo;
            indexBuf[rowOff + x++] = hi;
          }
        } else {
          const count = -sb;
          const lo = bytes[pos++];
          const hi = bytes[pos++];
          for (let i = 0; i < count; i++) {
            indexBuf[rowOff + x++] = lo;
            indexBuf[rowOff + x++] = hi;
          }
        }
      }
      y++;
      linesDone++;
    }
  }

  // ---- Public player class -------------------------------------------

  class FLIPlayer extends EventTarget {
    constructor(canvas, opts) {
      super();
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.opts = Object.assign({ loop: true }, opts);
      this.frames = [];
      this.frameDelaysMs = [];
      this.width = 0;
      this.height = 0;
      this.frameIndex = 0;
      this._playing = false;
      this._rafId = null;
      this._lastTime = 0;
      this._accum = 0;
      this._imageData = null;
    }

    /** Load from a URL (string) or an ArrayBuffer. */
    async load(source) {
      const buffer =
        source instanceof ArrayBuffer
          ? source
          : await fetch(source).then((r) => {
              if (!r.ok) throw new Error('Failed to fetch ' + source + ': ' + r.status);
              return r.arrayBuffer();
            });

      const decoded = decodeFLI(buffer);
      this.width = decoded.width;
      this.height = decoded.height;
      this.frames = decoded.frames;
      this.frameDelaysMs = decoded.frameDelaysMs;
      this.frameIndex = 0;

      this.canvas.width = this.width;
      this.canvas.height = this.height;
      this._imageData = this.ctx.createImageData(this.width, this.height);

      this._drawFrame(0);
      this.dispatchEvent(new CustomEvent('load', {
        detail: { width: this.width, height: this.height, frameCount: this.frames.length },
      }));
      return this;
    }

    get frameCount() {
      return this.frames.length;
    }

    get isPlaying() {
      return this._playing;
    }

    _drawFrame(i) {
      const frame = this.frames[i];
      if (!frame) return;
      this._imageData.data.set(frame);
      this.ctx.putImageData(this._imageData, 0, 0);
      this.frameIndex = i;
      this.dispatchEvent(new CustomEvent('frame', { detail: { index: i } }));
    }

    seek(i) {
      const clamped = Math.max(0, Math.min(this.frames.length - 1, i));
      this._drawFrame(clamped);
    }

    play() {
      if (this._playing || this.frames.length === 0) return;
      this._playing = true;
      this._lastTime = performance.now();
      this._accum = 0;
      const step = (now) => {
        if (!this._playing) return;
        this._accum += now - this._lastTime;
        this._lastTime = now;
        const delay = this.frameDelaysMs[this.frameIndex] || 71;
        while (this._accum >= delay) {
          this._accum -= delay;
          let next = this.frameIndex + 1;
          if (next >= this.frames.length) {
            if (this.opts.loop) {
              next = 0;
            } else {
              this._drawFrame(this.frames.length - 1);
              this._playing = false;
              this.dispatchEvent(new CustomEvent('ended'));
              return;
            }
          }
          this._drawFrame(next);
        }
        this._rafId = requestAnimationFrame(step);
      };
      this._rafId = requestAnimationFrame(step);
      this.dispatchEvent(new CustomEvent('play'));
    }

    pause() {
      this._playing = false;
      if (this._rafId) cancelAnimationFrame(this._rafId);
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

  global.FLIPlayer = FLIPlayer;
  global.decodeFLI = decodeFLI;
})(typeof window !== 'undefined' ? window : globalThis);
