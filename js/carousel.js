/*!
 * carousel.js
 * Floppy-disk browsing UI: a horizontal strip of clickable disks that
 * "insert" (animate + reveal a contents list) when clicked.
 */
(function (global) {
  'use strict';

  function initCarousel(opts) {
    const {
      carouselEl, contentsPanelEl, contentsListEl, contentsDiskLabelEl,
      ejectBtnEl, driveLedEl, disks, onSelect, onEject,
    } = opts;

    let activeDiskId = null;
    let activeAnimId = null;

    function renderCarousel() {
      carouselEl.innerHTML = '';
      disks.forEach((disk) => {
        const btn = document.createElement('button');
        btn.className = 'floppy';
        btn.dataset.diskId = disk.id;
        btn.setAttribute('aria-label', 'Insert ' + disk.label);
        btn.innerHTML =
          '<div class="floppy-body">' +
            '<div class="wp-notch"></div>' +
            '<div class="floppy-shutter"></div>' +
            '<div class="floppy-label">' +
              '<span class="hand-title">' + escapeHtml(disk.label) + '</span>' +
              '<span class="hand-sub">' + escapeHtml(disk.formatTag) + ' &middot; ' + disk.animations.length + '</span>' +
            '</div>' +
          '</div>';
        btn.addEventListener('click', () => insertDisk(disk, btn));
        carouselEl.appendChild(btn);
      });
    }

    function insertDisk(disk, btnEl) {
      if (disk.id === activeDiskId) return;
      carouselEl.classList.add('has-active');
      [...carouselEl.children].forEach((c) => c.classList.remove('active', 'inserting'));
      btnEl.classList.add('active', 'inserting');
      if (driveLedEl) driveLedEl.classList.add('on');

      window.setTimeout(() => {
        btnEl.classList.remove('inserting');
        activeDiskId = disk.id;
        activeAnimId = null;
        renderContents(disk);
      }, 480);
    }

    function renderContents(disk) {
      contentsDiskLabelEl.textContent = disk.label + ' — ' + disk.animations.length + ' item' + (disk.animations.length === 1 ? '' : 's');
      contentsListEl.innerHTML = '';
      disk.animations.forEach((anim, i) => {
        const row = document.createElement('div');
        row.className = 'content-row';
        row.dataset.animId = anim.id;
        row.innerHTML =
          '<span class="idx">' + String(i + 1).padStart(2, '0') + '</span>' +
          '<span class="name">' + escapeHtml(anim.title) + '</span>' +
          '<span class="fmt">' + anim.format.toUpperCase() + '</span>';
        row.addEventListener('click', () => selectAnimation(disk, anim, row));
        contentsListEl.appendChild(row);
      });
      contentsPanelEl.hidden = false;

      // Auto-select the first item so the drive doesn't sit idle after insert.
      const firstRow = contentsListEl.querySelector('.content-row');
      if (firstRow) selectAnimation(disk, disk.animations[0], firstRow);
    }

    function selectAnimation(disk, anim, rowEl) {
      activeAnimId = anim.id;
      [...contentsListEl.children].forEach((c) => c.classList.remove('active'));
      if (rowEl) rowEl.classList.add('active');
      onSelect && onSelect(anim, disk);
    }

    function eject() {
      activeDiskId = null;
      activeAnimId = null;
      carouselEl.classList.remove('has-active');
      [...carouselEl.children].forEach((c) => c.classList.remove('active', 'inserting'));
      contentsPanelEl.hidden = true;
      contentsListEl.innerHTML = '';
      if (driveLedEl) driveLedEl.classList.remove('on');
      onEject && onEject();
    }

    ejectBtnEl.addEventListener('click', eject);

    renderCarousel();

    return { eject };
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  global.initCarousel = initCarousel;
})(typeof window !== 'undefined' ? window : globalThis);
