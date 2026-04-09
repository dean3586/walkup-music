/* Walk-Up Music App */

(function () {
  'use strict';

  // === State ===
  let roster = [];
  let lineup = [];
  let currentBatterIdx = -1;
  let currentPlayer = null;
  let playbackPhase = null;   // 'announcement' | 'walkup' | null
  let fadeInterval = null;
  let progressInterval = null;
  let globalDuration = 30;
  let isPaused = false;

  // === Drag state ===
  let dragItem = null;
  let dragIdx = -1;
  let dragOffsetY = 0;
  let placeholder = null;

  // === DOM refs ===
  const rosterView = document.getElementById('roster-view');
  const lineupList = document.getElementById('lineup-list');
  const availableList = document.getElementById('available-list');
  const clearLineupBtn = document.getElementById('clear-lineup-btn');
  const playbackBar = document.getElementById('playback-bar');
  const playbackNumber = document.getElementById('playback-number');
  const playbackName = document.getElementById('playback-name');
  const playbackStatus = document.getElementById('playback-status');
  const prevBtn = document.getElementById('prev-btn');
  const playPauseBtn = document.getElementById('play-pause-btn');
  const nextBtn = document.getElementById('next-btn');
  const stopBtn = document.getElementById('stop-btn');
  const playIcon = document.getElementById('play-icon');
  const pauseIcon = document.getElementById('pause-icon');
  const volumeSlider = document.getElementById('volume-slider');
  const progressFill = document.getElementById('progress-fill');
  const timeCurrent = document.getElementById('time-current');
  const timeTotal = document.getElementById('time-total');
  const announcementAudio = document.getElementById('announcement-audio');
  const walkupAudio = document.getElementById('walkup-audio');
  const globalDurationSlider = document.getElementById('global-duration');
  const globalDurationLabel = document.getElementById('global-duration-label');
  const songSettingsList = document.getElementById('song-settings-list');

  // === Init ===
  async function init() {
    const resp = await fetch('roster.json');
    roster = await resp.json();

    const saved = localStorage.getItem('walkup-lineup');
    if (saved) {
      try {
        lineup = JSON.parse(saved);
        const rosterNums = new Set(roster.map(p => p.number));
        lineup = lineup.filter(n => rosterNums.has(n));
      } catch (e) {
        lineup = [];
      }
    }

    const savedDuration = localStorage.getItem('walkup-global-duration');
    if (savedDuration) globalDuration = parseInt(savedDuration) || 30;

    const savedStartTimes = localStorage.getItem('walkup-start-times');
    if (savedStartTimes) {
      try {
        const times = JSON.parse(savedStartTimes);
        roster.forEach(p => {
          if (p.walkup && times[p.number] !== undefined) {
            p.walkup.startTime = times[p.number];
          }
        });
      } catch (e) {}
    }

    renderRoster();
    renderLineup();
    renderSettings();
    setupTabs();
    setupControls();
    updateTransportState();
  }

  // === Tab switching ===
  function setupTabs() {
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById(tab.dataset.tab + '-view').classList.add('active');
      });
    });
  }

  // === Roster rendering ===
  function renderRoster() {
    rosterView.innerHTML = '';
    roster.forEach(player => {
      const card = document.createElement('div');
      card.className = 'player-card';
      card.dataset.number = player.number;

      const hasWalkup = player.walkup !== null;
      card.innerHTML = `
        <div class="player-card-number">#${player.number}</div>
        <div class="player-card-info">
          <span class="player-card-first">${player.firstName}</span>
          <span class="player-card-last">${player.lastName}</span>
        </div>
        <div class="player-card-right">
          ${hasWalkup
            ? '<span class="music-indicator">&#9835;</span>'
            : '<span class="no-music-indicator">no song</span>'}
        </div>
      `;

      card.addEventListener('click', () => playPlayer(player));
      rosterView.appendChild(card);
    });
  }

  // === Lineup rendering ===
  function renderLineup() {
    if (lineup.length === 0) {
      lineupList.innerHTML = '<div class="empty-lineup">No batting order set.<br>Tap players below to build the lineup.</div>';
    } else {
      lineupList.innerHTML = '';
      lineup.forEach((num, idx) => {
        const player = roster.find(p => p.number === num);
        if (!player) return;

        const item = document.createElement('div');
        item.className = 'lineup-item';
        item.dataset.number = num;
        item.dataset.idx = idx;
        if (idx === currentBatterIdx) item.classList.add('current');
        if (currentPlayer && currentPlayer.number === num && playbackPhase) {
          item.classList.add('playing');
        }

        item.innerHTML = `
          <span class="drag-handle" aria-label="Drag to reorder">
            <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor">
              <circle cx="2" cy="2" r="1.5"/><circle cx="8" cy="2" r="1.5"/>
              <circle cx="2" cy="8" r="1.5"/><circle cx="8" cy="8" r="1.5"/>
              <circle cx="2" cy="14" r="1.5"/><circle cx="8" cy="14" r="1.5"/>
            </svg>
          </span>
          <span class="lineup-position">${idx + 1}</span>
          <span class="lineup-player-number">#${player.number}</span>
          <span class="lineup-player-name">${player.firstName} ${player.lastName}</span>
          <button class="lineup-remove" data-idx="${idx}">&times;</button>
        `;

        item.addEventListener('click', (e) => {
          if (e.target.closest('.lineup-remove') || e.target.closest('.drag-handle')) return;
          currentBatterIdx = idx;
          playPlayer(player);
          renderLineup();
        });

        const handle = item.querySelector('.drag-handle');
        handle.addEventListener('touchstart', (e) => onDragStart(e, item, idx), { passive: false });

        lineupList.appendChild(item);
      });
    }

    lineupList.querySelectorAll('.lineup-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.idx);
        lineup.splice(idx, 1);
        if (currentBatterIdx >= lineup.length) currentBatterIdx = lineup.length - 1;
        saveLineup();
        renderLineup();
        renderAvailable();
        updateTransportState();
      });
    });

    renderAvailable();
    updateTransportState();
  }

  // === Touch drag-to-reorder ===
  function onDragStart(e, item, idx) {
    e.preventDefault();
    const touch = e.touches[0];
    dragItem = item;
    dragIdx = idx;

    const rect = item.getBoundingClientRect();
    dragOffsetY = touch.clientY - rect.top;

    placeholder = document.createElement('div');
    placeholder.className = 'lineup-placeholder';
    placeholder.style.height = rect.height + 'px';
    item.parentNode.insertBefore(placeholder, item);

    item.classList.add('dragging');
    item.style.width = rect.width + 'px';
    item.style.top = rect.top + 'px';
    item.style.left = rect.left + 'px';
    document.body.appendChild(item);

    document.addEventListener('touchmove', onDragMove, { passive: false });
    document.addEventListener('touchend', onDragEnd);
    document.addEventListener('touchcancel', onDragEnd);
  }

  function onDragMove(e) {
    if (!dragItem) return;
    e.preventDefault();
    const touch = e.touches[0];
    dragItem.style.top = (touch.clientY - dragOffsetY) + 'px';

    const items = lineupList.querySelectorAll('.lineup-item:not(.dragging)');
    let insertBefore = null;

    for (const child of items) {
      const rect = child.getBoundingClientRect();
      if (touch.clientY < rect.top + rect.height / 2) {
        insertBefore = child;
        break;
      }
    }

    if (insertBefore) {
      lineupList.insertBefore(placeholder, insertBefore);
    } else {
      lineupList.appendChild(placeholder);
    }
  }

  function onDragEnd() {
    if (!dragItem) return;
    document.removeEventListener('touchmove', onDragMove);
    document.removeEventListener('touchend', onDragEnd);
    document.removeEventListener('touchcancel', onDragEnd);

    const allChildren = Array.from(lineupList.children);
    let newIdx = allChildren.indexOf(placeholder);

    dragItem.classList.remove('dragging');
    dragItem.style.width = '';
    dragItem.style.top = '';
    dragItem.style.left = '';

    if (placeholder.parentNode) placeholder.parentNode.removeChild(placeholder);

    if (newIdx !== dragIdx && newIdx >= 0) {
      const [moved] = lineup.splice(dragIdx, 1);
      if (dragIdx < newIdx) newIdx--;
      lineup.splice(newIdx, 0, moved);

      if (currentBatterIdx === dragIdx) {
        currentBatterIdx = newIdx;
      } else if (dragIdx < currentBatterIdx && newIdx >= currentBatterIdx) {
        currentBatterIdx--;
      } else if (dragIdx > currentBatterIdx && newIdx <= currentBatterIdx) {
        currentBatterIdx++;
      }

      saveLineup();
    }

    dragItem = null;
    dragIdx = -1;
    placeholder = null;
    renderLineup();
  }

  function renderAvailable() {
    const inLineup = new Set(lineup);
    availableList.innerHTML = '';
    roster.forEach(player => {
      const el = document.createElement('div');
      el.className = 'available-player' + (inLineup.has(player.number) ? ' in-lineup' : '');
      el.innerHTML = `
        <div class="num">#${player.number}</div>
        <div class="name">${player.firstName} ${player.lastName}</div>
      `;
      el.addEventListener('click', () => {
        if (inLineup.has(player.number)) return;
        lineup.push(player.number);
        saveLineup();
        renderLineup();
      });
      availableList.appendChild(el);
    });
  }

  function saveLineup() {
    localStorage.setItem('walkup-lineup', JSON.stringify(lineup));
  }

  // === Settings rendering ===
  function renderSettings() {
    globalDurationSlider.value = globalDuration;
    globalDurationLabel.textContent = globalDuration + 's';

    songSettingsList.innerHTML = '';
    roster.forEach(player => {
      const hasWalkup = player.walkup !== null;
      const row = document.createElement('div');
      row.className = 'song-setting-row' + (hasWalkup ? '' : ' no-song');

      const startTime = hasWalkup ? (player.walkup.startTime || 0) : 0;

      row.innerHTML = `
        <div class="song-setting-player">
          <span class="song-setting-number">#${player.number}</span>
          <span class="song-setting-name">${player.firstName} ${player.lastName}</span>
        </div>
        ${hasWalkup ? `
          <div class="song-setting-control">
            <label class="song-setting-label">Start</label>
            <button class="start-time-btn minus" data-number="${player.number}">-</button>
            <span class="start-time-value" data-number="${player.number}">${formatTime(startTime)}</span>
            <button class="start-time-btn plus" data-number="${player.number}">+</button>
            <button class="start-time-preview" data-number="${player.number}" title="Preview">&#9654;</button>
          </div>
        ` : `
          <div class="song-setting-control">
            <span class="no-song-label">No song assigned</span>
          </div>
        `}
      `;

      songSettingsList.appendChild(row);
    });

    songSettingsList.querySelectorAll('.start-time-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const num = parseInt(btn.dataset.number);
        const player = roster.find(p => p.number === num);
        if (!player || !player.walkup) return;

        const delta = btn.classList.contains('plus') ? 1 : -1;
        player.walkup.startTime = Math.max(0, (player.walkup.startTime || 0) + delta);

        const valueEl = songSettingsList.querySelector(`.start-time-value[data-number="${num}"]`);
        if (valueEl) valueEl.textContent = formatTime(player.walkup.startTime);

        saveStartTimes();
      });
    });

    songSettingsList.querySelectorAll('.start-time-preview').forEach(btn => {
      btn.addEventListener('click', () => {
        const num = parseInt(btn.dataset.number);
        const player = roster.find(p => p.number === num);
        if (!player || !player.walkup) return;

        stopPlayback(false);
        const vol = volumeSlider.value / 100;
        walkupAudio.src = player.walkup.file;
        walkupAudio.volume = vol;
        walkupAudio.currentTime = player.walkup.startTime || 0;
        walkupAudio.play().catch(() => {});

        currentPlayer = player;
        playbackPhase = 'walkup';
        isPaused = false;
        showPlaybackInfo(player);
        playbackStatus.textContent = 'Preview';
        updatePlayPauseIcon();
        updateTransportState();
        startProgressTracking();

        setTimeout(() => {
          if (currentPlayer === player && playbackPhase === 'walkup') {
            fadeOut(walkupAudio, 1000, () => finishPlayback());
          }
        }, 5000);
      });
    });
  }

  function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds) % 60;
    return m + ':' + String(s).padStart(2, '0');
  }

  function saveStartTimes() {
    const times = {};
    roster.forEach(p => {
      if (p.walkup) times[p.number] = p.walkup.startTime || 0;
    });
    localStorage.setItem('walkup-start-times', JSON.stringify(times));
  }

  // === Transport controls ===
  function setupControls() {
    stopBtn.addEventListener('click', () => stopPlayback(true));

    playPauseBtn.addEventListener('click', () => {
      if (!currentPlayer || !playbackPhase) {
        // If lineup has players, start from current or first
        if (lineup.length > 0) {
          if (currentBatterIdx < 0) currentBatterIdx = 0;
          const num = lineup[currentBatterIdx];
          const player = roster.find(p => p.number === num);
          if (player) {
            playPlayer(player);
            renderLineup();
          }
        }
        return;
      }

      const activeAudio = playbackPhase === 'walkup' ? walkupAudio : announcementAudio;
      if (isPaused) {
        activeAudio.play().catch(() => {});
        isPaused = false;
      } else {
        activeAudio.pause();
        isPaused = true;
      }
      updatePlayPauseIcon();
    });

    prevBtn.addEventListener('click', () => {
      if (lineup.length === 0) return;
      currentBatterIdx = (currentBatterIdx - 1 + lineup.length) % lineup.length;
      const num = lineup[currentBatterIdx];
      const player = roster.find(p => p.number === num);
      if (player) {
        playPlayer(player);
        renderLineup();
      }
    });

    nextBtn.addEventListener('click', () => {
      if (lineup.length === 0) return;
      currentBatterIdx = (currentBatterIdx + 1) % lineup.length;
      const num = lineup[currentBatterIdx];
      const player = roster.find(p => p.number === num);
      if (player) {
        playPlayer(player);
        renderLineup();
      }
    });

    volumeSlider.addEventListener('input', () => {
      const vol = volumeSlider.value / 100;
      announcementAudio.volume = vol;
      walkupAudio.volume = vol;
    });

    clearLineupBtn.addEventListener('click', () => {
      lineup = [];
      currentBatterIdx = -1;
      saveLineup();
      renderLineup();
    });

    announcementAudio.addEventListener('ended', () => {
      if (currentPlayer && currentPlayer.walkup) {
        startWalkup(currentPlayer);
      } else {
        finishPlayback();
      }
    });

    globalDurationSlider.addEventListener('input', () => {
      globalDuration = parseInt(globalDurationSlider.value);
      globalDurationLabel.textContent = globalDuration + 's';
      localStorage.setItem('walkup-global-duration', globalDuration);
    });
  }

  function updateTransportState() {
    const hasLineup = lineup.length > 0;
    const isPlaying = playbackPhase !== null;

    prevBtn.disabled = !hasLineup;
    nextBtn.disabled = !hasLineup;
    playPauseBtn.disabled = !hasLineup && !isPlaying;
    stopBtn.disabled = !isPlaying;

    playbackBar.classList.toggle('active', isPlaying);
  }

  function updatePlayPauseIcon() {
    const isPlaying = playbackPhase !== null && !isPaused;
    playIcon.style.display = isPlaying ? 'none' : '';
    pauseIcon.style.display = isPlaying ? '' : 'none';
  }

  // === Play a player ===
  function playPlayer(player) {
    stopPlayback(false);

    currentPlayer = player;
    playbackPhase = 'announcement';
    isPaused = false;

    showPlaybackInfo(player);
    highlightPlaying(player.number);
    updatePlayPauseIcon();
    updateTransportState();

    const vol = volumeSlider.value / 100;
    announcementAudio.src = player.announcement;
    announcementAudio.volume = vol;
    announcementAudio.currentTime = 0;
    announcementAudio.play().catch(() => {});

    if (player.walkup) {
      walkupAudio.src = player.walkup.file;
      walkupAudio.preload = 'auto';
    }

    startProgressTracking();
  }

  function startWalkup(player) {
    playbackPhase = 'walkup';
    playbackStatus.textContent = 'Walk-up';
    updatePlayPauseIcon();

    const vol = volumeSlider.value / 100;
    const startTime = player.walkup.startTime || 0;
    const duration = player.walkup.duration || globalDuration;

    walkupAudio.volume = vol;
    walkupAudio.currentTime = startTime;
    walkupAudio.play().catch(() => {});

    if (duration && duration > 0) {
      const fadeStart = (duration - 2) * 1000;
      setTimeout(() => {
        if (playbackPhase === 'walkup' && currentPlayer === player && !isPaused) {
          fadeOut(walkupAudio, 2000, () => finishPlayback());
        }
      }, Math.max(0, fadeStart));
    }
  }

  function stopPlayback(withFade) {
    clearInterval(fadeInterval);
    clearInterval(progressInterval);

    if (withFade && playbackPhase) {
      const activeAudio = playbackPhase === 'walkup' ? walkupAudio : announcementAudio;
      fadeOut(activeAudio, 1000, () => {
        silenceAll();
        finishPlayback();
      });
    } else {
      silenceAll();
      finishPlayback();
    }
  }

  function silenceAll() {
    announcementAudio.pause();
    announcementAudio.currentTime = 0;
    announcementAudio.src = '';
    walkupAudio.pause();
    walkupAudio.currentTime = 0;
    walkupAudio.src = '';
  }

  function finishPlayback() {
    playbackPhase = null;
    currentPlayer = null;
    isPaused = false;
    clearInterval(progressInterval);
    clearHighlights();
    updatePlayPauseIcon();
    updateTransportState();
    playbackNumber.textContent = '';
    playbackName.textContent = 'No player selected';
    playbackStatus.textContent = '';
    timeCurrent.textContent = '--:--';
    timeTotal.textContent = '--:--';
    progressFill.style.width = '0%';
  }

  function fadeOut(audio, durationMs, onComplete) {
    clearInterval(fadeInterval);
    const startVol = audio.volume;
    const steps = 20;
    const stepTime = durationMs / steps;
    const volStep = startVol / steps;
    let step = 0;

    fadeInterval = setInterval(() => {
      step++;
      audio.volume = Math.max(0, startVol - volStep * step);
      if (step >= steps) {
        clearInterval(fadeInterval);
        audio.pause();
        audio.volume = startVol;
        if (onComplete) onComplete();
      }
    }, stepTime);
  }

  // === Progress tracking ===
  function startProgressTracking() {
    clearInterval(progressInterval);
    progressInterval = setInterval(() => {
      if (!currentPlayer || !playbackPhase) {
        clearInterval(progressInterval);
        return;
      }

      let percent = 0;
      let elapsed = 0;
      let total = 0;

      if (playbackPhase === 'announcement') {
        const a = announcementAudio;
        if (a.duration && isFinite(a.duration)) {
          elapsed = a.currentTime;
          total = a.duration;
          percent = (elapsed / total) * 100;
        }
        playbackStatus.textContent = 'Announcing';
      } else if (playbackPhase === 'walkup') {
        const w = walkupAudio;
        const startTime = currentPlayer.walkup.startTime || 0;
        const duration = currentPlayer.walkup.duration || globalDuration;
        elapsed = w.currentTime - startTime;
        total = duration || (w.duration - startTime);
        if (total > 0) {
          percent = Math.min(100, (elapsed / total) * 100);
        }
      }

      progressFill.style.width = Math.min(100, Math.max(0, percent)) + '%';
      timeCurrent.textContent = formatTime(Math.max(0, elapsed));
      timeTotal.textContent = formatTime(Math.max(0, total));
    }, 100);
  }

  // === UI helpers ===
  function showPlaybackInfo(player) {
    playbackNumber.textContent = '#' + player.number;
    playbackName.textContent = player.firstName + ' ' + player.lastName;
    playbackStatus.textContent = 'Announcing';
    progressFill.style.width = '0%';
    timeCurrent.textContent = '0:00';
    timeTotal.textContent = '--:--';
  }

  function highlightPlaying(number) {
    clearHighlights();
    document.querySelectorAll(`[data-number="${number}"]`).forEach(el => {
      el.classList.add('playing');
    });
  }

  function clearHighlights() {
    document.querySelectorAll('.playing').forEach(el => el.classList.remove('playing'));
  }

  // === Start ===
  init();
})();
