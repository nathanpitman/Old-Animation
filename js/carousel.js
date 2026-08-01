/*!
 * carousel.js
 * The disk caddy: one 3.5" disk on show at a time, flipped through with
 * prev/next, the rest filed edge-on in the caddy below, and the selected
 * disk's contents written out on a post-it.
 */
(function (global) {
  'use strict';

  function initCarousel(opts) {
    const {
      diskHolderEl, caddySlotsEl, caddyCountEl,
      postitEl, postitTitleEl, contentsListEl,
      prevDiskBtnEl, nextDiskBtnEl, ejectBtnEl, driveLedEl,
      disks, onSelect, onEject,
    } = opts;

    let current = 0;
    let insertedDiskId = null;
    let activeAnimId = null;
    let insertTimer = null;

    /* ---------- the disk on show ---------- */

    function diskMarkup(disk) {
      const count = disk.animations.length;
      return '' +
        '<button class="disk" type="button" aria-label="Insert disk ' + disk.number + '">' +
          '<span class="disk-shell">' +
            '<span class="disk-arrow"></span>' +
            '<span class="disk-shutter"></span>' +
            '<span class="disk-label">' +
              '<span class="disk-num">Disk ' + disk.number + '</span>' +
              '<span class="disk-sub">' + escapeHtml(disk.formatTag) + ' &middot; ' +
                count + ' clip' + (count === 1 ? '' : 's') + '</span>' +
              '<span class="disk-stamp">IN DRIVE</span>' +
            '</span>' +
          '</span>' +
        '</button>';
    }

    function renderDisk(direction) {
      const disk = disks[current];
      diskHolderEl.innerHTML = diskMarkup(disk);
      const el = diskHolderEl.firstElementChild;
      if (disk.id === insertedDiskId) el.classList.add('inserted');
      if (direction) el.classList.add(direction > 0 ? 'from-right' : 'from-left');
      el.addEventListener('click', () => insertDisk(disk));
    }

    function flip(delta) {
      current = (current + delta + disks.length) % disks.length;
      renderDisk(delta);
      renderPostit();
      markCurrentInCaddy();
    }

    function goTo(index) {
      if (index === current) return;
      const delta = index > current ? 1 : -1;
      current = index;
      renderDisk(delta);
      renderPostit();
      markCurrentInCaddy();
    }

    /* ---------- the caddy ---------- */

    function renderCaddy() {
      caddySlotsEl.innerHTML = '';
      disks.forEach((disk, i) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'caddy-disk';
        btn.title = 'Disk ' + disk.number;
        btn.setAttribute('aria-label', 'Show disk ' + disk.number);
        btn.innerHTML = '<span class="tab">' + disk.number + '</span>';
        btn.addEventListener('click', () => goTo(i));
        caddySlotsEl.appendChild(btn);
      });
      if (caddyCountEl) caddyCountEl.textContent = disks.length + ' disks in the caddy';
      markCurrentInCaddy();
    }

    function markCurrentInCaddy() {
      [...caddySlotsEl.children].forEach((c, i) => c.classList.toggle('current', i === current));
      const el = caddySlotsEl.children[current];
      if (!el) return;
      // Scroll the rail itself rather than scrollIntoView, which would drag the page.
      caddySlotsEl.scrollTo({
        left: el.offsetLeft - caddySlotsEl.clientWidth / 2 + el.offsetWidth / 2,
        behavior: 'smooth',
      });
    }

    /* ---------- the post-it ---------- */

    function renderPostit() {
      const disk = disks[current];
      postitTitleEl.textContent = 'Disk ' + disk.number;
      contentsListEl.innerHTML = '';
      disk.animations.forEach((anim) => {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'track';
        btn.dataset.animId = anim.id;
        btn.innerHTML =
          '<span class="tick">&rarr;</span>' +
          '<span class="name">' + escapeHtml(anim.title) + '</span>' +
          '<span class="fmt">' + escapeHtml(anim.format) + '</span>';
        if (disk.id === insertedDiskId && anim.id === activeAnimId) btn.classList.add('playing');
        btn.addEventListener('click', () => {
          if (disk.id !== insertedDiskId) insertDisk(disk, anim);
          else selectAnimation(disk, anim);
        });
        li.appendChild(btn);
        contentsListEl.appendChild(li);
      });
      postitEl.hidden = false;
    }

    function markPlayingTrack() {
      [...contentsListEl.querySelectorAll('.track')].forEach((el) => {
        el.classList.toggle('playing',
          disks[current].id === insertedDiskId && el.dataset.animId === activeAnimId);
      });
    }

    /* ---------- drive ---------- */

    function insertDisk(disk, anim) {
      // Pressing the disk again shouldn't yank playback back to the first clip.
      if (!anim && disk.id === insertedDiskId) return;
      const target = anim || disk.animations[0];
      if (!target) return;

      const diskEl = diskHolderEl.firstElementChild;
      if (diskEl && disk.id !== insertedDiskId) {
        diskEl.classList.remove('inserting');
        void diskEl.offsetWidth; // restart the animation if it is already running
        diskEl.classList.add('inserting');
      }

      insertedDiskId = disk.id;
      if (driveLedEl) driveLedEl.classList.add('on');
      if (ejectBtnEl) ejectBtnEl.disabled = false;

      global.clearTimeout(insertTimer);
      insertTimer = global.setTimeout(() => {
        const el = diskHolderEl.firstElementChild;
        if (el && disks[current].id === insertedDiskId) el.classList.add('inserted');
      }, 260);

      selectAnimation(disk, target);
    }

    function selectAnimation(disk, anim) {
      activeAnimId = anim.id;
      markPlayingTrack();
      onSelect && onSelect(anim, disk);
    }

    function eject() {
      insertedDiskId = null;
      activeAnimId = null;
      global.clearTimeout(insertTimer);
      const el = diskHolderEl.firstElementChild;
      if (el) el.classList.remove('inserted', 'inserting');
      if (driveLedEl) driveLedEl.classList.remove('on');
      if (ejectBtnEl) ejectBtnEl.disabled = true;
      markPlayingTrack();
      onEject && onEject();
    }

    /* ---------- wiring ---------- */

    prevDiskBtnEl.addEventListener('click', () => flip(-1));
    nextDiskBtnEl.addEventListener('click', () => flip(1));
    if (ejectBtnEl) ejectBtnEl.addEventListener('click', eject);

    document.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target.closest('input, textarea, select, [contenteditable]')) return;
      if (e.key === 'ArrowLeft') { flip(-1); e.preventDefault(); }
      else if (e.key === 'ArrowRight') { flip(1); e.preventDefault(); }
    });

    renderCaddy();
    renderDisk(0);
    renderPostit();

    return { eject };
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  global.initCarousel = initCarousel;
})(typeof window !== 'undefined' ? window : globalThis);
