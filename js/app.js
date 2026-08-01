/*!
 * app.js
 * Bootstraps the gallery: fetches the manifest, builds the floppy carousel,
 * and wires the CRT transport controls to a UnifiedPlayer.
 */
(function () {
  'use strict';

  const canvas = document.getElementById('canvas');
  const player = new UnifiedPlayer(canvas);

  const playBtn = document.getElementById('playBtn');
  const prevFrameBtn = document.getElementById('prevFrameBtn');
  const nextFrameBtn = document.getElementById('nextFrameBtn');
  const loopToggle = document.getElementById('loopToggle');
  const scrub = document.getElementById('scrub');
  const frameCountEl = document.getElementById('frameCount');
  const captionTitle = document.getElementById('captionTitle');
  const captionDims = document.getElementById('captionDims');
  const emptyState = document.getElementById('emptyState');
  const driveLed = document.getElementById('driveLed');

  function setControlsEnabled(enabled) {
    playBtn.disabled = !enabled;
    prevFrameBtn.disabled = !enabled;
    nextFrameBtn.disabled = !enabled;
    scrub.disabled = !enabled;
  }

  function updateFrameReadout() {
    const count = player.frameCount;
    scrub.max = Math.max(0, count - 1);
    scrub.value = player.frameIndex;
    frameCountEl.textContent = (count ? player.frameIndex + 1 : 0) + ' / ' + count;
  }

  player.addEventListener('ready', (e) => {
    const { format, width, height, frameCount } = e.detail;
    captionDims.textContent = width + '×' + height + ' · ' + frameCount + (frameCount === 1 ? ' FRAME' : ' FRAMES') + ' · ' + format.toUpperCase();
    emptyState.hidden = true;
    setControlsEnabled(true);
    player.setLoop(loopToggle.checked);
    updateFrameReadout();
    player.play();
  });
  player.addEventListener('frame', updateFrameReadout);
  player.addEventListener('play', () => { playBtn.textContent = '❚❚ PAUSE'; });
  player.addEventListener('pause', () => { playBtn.textContent = '▶ PLAY'; });
  player.addEventListener('trackchange', (e) => {
    if (e.detail && e.detail.track) {
      captionDims.textContent = e.detail.track.width + '×' + e.detail.track.height + ' · ' + e.detail.track.frames.length + ' FRAMES · ANM (' + (e.detail.index + 1) + '/' + player.trackCount + ')';
    }
  });

  playBtn.addEventListener('click', () => player.toggle());
  prevFrameBtn.addEventListener('click', () => player.stepFrame(-1));
  nextFrameBtn.addEventListener('click', () => player.stepFrame(1));
  scrub.addEventListener('input', () => { player.pause(); player.seek(parseInt(scrub.value, 10)); });
  loopToggle.addEventListener('change', () => player.setLoop(loopToggle.checked));

  async function loadAnimation(anim, disk) {
    setControlsEnabled(false);
    emptyState.hidden = false;
    emptyState.textContent = 'LOADING ' + anim.title + '…';
    captionTitle.textContent = disk.label + ' / ' + anim.title;
    try {
      await player.load(anim);
    } catch (err) {
      emptyState.hidden = false;
      emptyState.textContent = 'COULD NOT LOAD ' + anim.title + ': ' + err.message;
      setControlsEnabled(false);
      console.error(err);
    }
  }

  function onEject() {
    player.pause();
    player.destroy();
    setControlsEnabled(false);
    captionTitle.textContent = 'NO DISK LOADED';
    captionDims.textContent = '—';
    emptyState.hidden = false;
    emptyState.textContent = 'INSERT A DISK →';
    frameCountEl.textContent = '0 / 0';
    scrub.max = 0; scrub.value = 0;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  fetch('data/manifest.json')
    .then((r) => r.json())
    .then((manifest) => {
      initCarousel({
        carouselEl: document.getElementById('carousel'),
        contentsPanelEl: document.getElementById('contentsPanel'),
        contentsListEl: document.getElementById('contentsList'),
        contentsDiskLabelEl: document.getElementById('contentsDiskLabel'),
        ejectBtnEl: document.getElementById('ejectBtn'),
        driveLedEl: driveLed,
        disks: manifest.disks,
        onSelect: loadAnimation,
        onEject: onEject,
      });
    })
    .catch((err) => {
      emptyState.textContent = 'Could not load manifest: ' + err.message;
      console.error(err);
    });
})();
