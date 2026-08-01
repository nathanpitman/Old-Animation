/*!
 * app.js
 * Bootstraps the gallery: fetches the manifest, builds the disk caddy,
 * and wires the CRT's icon transport to a UnifiedPlayer.
 */
(function () {
  'use strict';

  const canvas = document.getElementById('canvas');
  const player = new UnifiedPlayer(canvas);

  const playBtn = document.getElementById('playBtn');
  const prevFrameBtn = document.getElementById('prevFrameBtn');
  const nextFrameBtn = document.getElementById('nextFrameBtn');
  const loopBtn = document.getElementById('loopToggle');
  const scrub = document.getElementById('scrub');
  const frameCountEl = document.getElementById('frameCount');
  const captionTitle = document.getElementById('captionTitle');
  const captionDims = document.getElementById('captionDims');
  const emptyState = document.getElementById('emptyState');
  const driveLed = document.getElementById('driveLed');

  const isLooping = () => loopBtn.getAttribute('aria-pressed') === 'true';

  function setControlsEnabled(enabled) {
    playBtn.disabled = !enabled;
    prevFrameBtn.disabled = !enabled;
    nextFrameBtn.disabled = !enabled;
    scrub.disabled = !enabled;
  }

  function setPlayingUI(playing) {
    playBtn.classList.toggle('is-playing', playing);
    playBtn.title = playing ? 'Pause' : 'Play';
    playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }

  function updateFrameReadout() {
    const count = player.frameCount;
    const index = player.frameIndex;
    scrub.max = Math.max(0, count - 1);
    scrub.value = index;
    scrub.style.setProperty('--p', (count > 1 ? (index / (count - 1)) * 100 : 0) + '%');
    frameCountEl.textContent = (count ? index + 1 : 0) + ' / ' + count;
  }

  player.addEventListener('ready', (e) => {
    const { format, width, height, frameCount } = e.detail;
    captionDims.textContent = width + '×' + height + ' · ' + frameCount + (frameCount === 1 ? ' frame' : ' frames') + ' · ' + format.toUpperCase();
    emptyState.hidden = true;
    setControlsEnabled(true);
    player.setLoop(isLooping());
    updateFrameReadout();
    player.play();
  });
  player.addEventListener('frame', updateFrameReadout);
  player.addEventListener('play', () => setPlayingUI(true));
  player.addEventListener('pause', () => setPlayingUI(false));
  player.addEventListener('trackchange', (e) => {
    if (e.detail && e.detail.track) {
      captionDims.textContent = e.detail.track.width + '×' + e.detail.track.height + ' · ' +
        e.detail.track.frames.length + ' frames · ANM (' + (e.detail.index + 1) + '/' + player.trackCount + ')';
    }
  });

  playBtn.addEventListener('click', () => player.toggle());
  prevFrameBtn.addEventListener('click', () => player.stepFrame(-1));
  nextFrameBtn.addEventListener('click', () => player.stepFrame(1));
  scrub.addEventListener('input', () => { player.pause(); player.seek(parseInt(scrub.value, 10)); });
  loopBtn.addEventListener('click', () => {
    const next = !isLooping();
    loopBtn.setAttribute('aria-pressed', String(next));
    player.setLoop(next);
  });

  async function loadAnimation(anim, disk) {
    setControlsEnabled(false);
    setPlayingUI(false);
    emptyState.hidden = false;
    emptyState.textContent = 'LOADING ' + anim.title + '…';
    captionTitle.textContent = 'Disk ' + disk.number + ' / ' + anim.title;
    try {
      await player.load(anim);
    } catch (err) {
      emptyState.hidden = false;
      emptyState.textContent = 'COULD NOT LOAD ' + anim.title;
      setControlsEnabled(false);
      console.error(err);
    }
  }

  function onEject() {
    player.pause();
    player.destroy();
    setControlsEnabled(false);
    setPlayingUI(false);
    captionTitle.textContent = 'NO DISK LOADED';
    captionDims.textContent = '—';
    emptyState.hidden = false;
    emptyState.innerHTML = 'PICK A DISK<br>PRESS IT IN';
    frameCountEl.textContent = '0 / 0';
    scrub.max = 0;
    scrub.value = 0;
    scrub.style.setProperty('--p', '0%');
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  fetch('data/manifest.json')
    .then((r) => r.json())
    .then((manifest) => {
      initCarousel({
        diskHolderEl: document.getElementById('diskHolder'),
        caddySlotsEl: document.getElementById('caddySlots'),
        caddyCountEl: document.getElementById('caddyCount'),
        postitEl: document.getElementById('postit'),
        postitTitleEl: document.getElementById('postitTitle'),
        contentsListEl: document.getElementById('contentsList'),
        prevDiskBtnEl: document.getElementById('prevDiskBtn'),
        nextDiskBtnEl: document.getElementById('nextDiskBtn'),
        ejectBtnEl: document.getElementById('ejectBtn'),
        driveLedEl: driveLed,
        disks: manifest.disks,
        onSelect: loadAnimation,
        onEject: onEject,
      });
    })
    .catch((err) => {
      emptyState.textContent = 'COULD NOT LOAD MANIFEST';
      console.error(err);
    });
})();
