/*!
 * unified-player.js
 * Format-detecting facade over FLIPlayer / ANMPlayer / GX2Player.
 * Picks the right decoder from a manifest entry and re-exposes a single
 * consistent API + event surface for the CRT UI to drive.
 */
(function (global) {
  'use strict';

  class UnifiedPlayer extends EventTarget {
    constructor(canvas) {
      super();
      this.canvas = canvas;
      this._inner = null;
      this._format = null;
      this._forward = null;
      this._loadToken = 0;
    }

    get format() { return this._format; }
    get width() { return this._inner ? this._inner.width : 0; }
    get height() { return this._inner ? this._inner.height : 0; }
    get frameCount() { return this._inner ? this._inner.frameCount : 0; }
    get frameIndex() { return this._inner ? this._inner.frameIndex : 0; }
    get isPlaying() { return this._inner ? this._inner.isPlaying : false; }
    get trackCount() { return (this._inner && this._inner.trackCount) || 1; }

    /**
     * entry: { format: 'fli'|'anm'|'gx2', file: string, files?: string[] }
     * detected from filename extension if `format` is omitted.
     */
    async load(entry) {
      const format = entry.format || detectFormat(entry.file || (entry.files && entry.files[0]));
      if (!format) throw new Error('Could not detect a player for this entry.');

      // Guard against overlapping selections: if a newer load() starts before
      // this one's fetch/decode finishes, this call's result is stale and
      // must not clobber (or race-render into the same canvas as) the newer one.
      const token = ++this._loadToken;

      let inner;
      if (format === 'fli') {
        inner = new global.FLIPlayer(this.canvas, { loop: true });
        await inner.load(entry.file);
      } else if (format === 'anm') {
        inner = new global.ANMPlayer(this.canvas, { loop: true, cycle: true, staticDurationSec: 5 });
        await inner.load(entry.files || entry.file);
      } else if (format === 'gx2') {
        inner = new global.GX2Player(this.canvas, { loop: true, frameDelayMs: 350 });
        await inner.load(entry.file);
      } else {
        throw new Error('Unknown animation format: ' + format);
      }

      if (token !== this._loadToken) {
        inner.destroy();
        return this;
      }

      if (this._inner) {
        this._inner.destroy();
        if (this._forward) {
          this._forward.forEach(([name, fn]) => this._inner.removeEventListener(name, fn));
        }
      }

      this._inner = inner;
      this._format = format;
      this._forward = ['load', 'frame', 'play', 'pause', 'trackchange', 'ended'].map((name) => {
        const fn = (e) => this.dispatchEvent(new CustomEvent(name, { detail: e.detail }));
        inner.addEventListener(name, fn);
        return [name, fn];
      });

      this.dispatchEvent(new CustomEvent('ready', {
        detail: { format, width: this.width, height: this.height, frameCount: this.frameCount },
      }));
      return this;
    }

    play() { this._inner && this._inner.play(); }
    pause() { this._inner && this._inner.pause(); }
    toggle() { this._inner && this._inner.toggle(); }
    stop() { this._inner && this._inner.stop(); }

    seek(i) { this._inner && this._inner.seek(i); }

    setLoop(v) { if (this._inner) this._inner.opts.loop = v; }

    stepFrame(delta) {
      if (!this._inner) return;
      this.pause();
      const count = this.frameCount;
      if (count <= 1) return;
      const next = ((this.frameIndex + delta) % count + count) % count;
      this._inner.seek(next);
    }

    nextTrack() { this._inner && this._inner.nextTrack && this._inner.nextTrack(); }
    prevTrack() { this._inner && this._inner.prevTrack && this._inner.prevTrack(); }

    destroy() {
      this._loadToken++;
      if (this._inner) this._inner.destroy();
      this._inner = null;
    }
  }

  function detectFormat(filename) {
    if (!filename) return null;
    const ext = filename.split('.').pop().toLowerCase();
    if (ext === 'fli' || ext === 'flc') return 'fli';
    if (ext === 'anm') return 'anm';
    if (ext === 'sps' || ext === 'gx2') return 'gx2';
    return null;
  }

  global.UnifiedPlayer = UnifiedPlayer;
  global.detectAnimationFormat = detectFormat;
})(typeof window !== 'undefined' ? window : globalThis);
