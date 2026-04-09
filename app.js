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
  let playbackStartTime = 0;
  let pausedAt = 0;       // elapsed ms when paused
  let totalPausedMs = 0;  // accumulated pause time

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
  const batterBtn = document.getElementById('batter-btn');
  const playIcon = document.getElementById('play-icon');
  const pauseIcon = document.getElementById('pause-icon');
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
    roster.sort((a, b) => a.number - b.number);

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
      lineup.splice(newIdx, 0, moved);

      // Recalculate current batter position after the move
      if (currentBatterIdx === dragIdx) {
        currentBatterIdx = newIdx;
      } else {
        // Removal shifts indices down above dragIdx
        if (currentBatterIdx > dragIdx) currentBatterIdx--;
        // Insertion shifts indices up at and above newIdx
        if (currentBatterIdx >= newIdx) currentBatterIdx++;
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
        <div class="song-setting-control">
          ${hasWalkup ? `
            <label class="song-setting-label">Start</label>
            <button class="start-time-btn minus" data-number="${player.number}">-</button>
            <span class="start-time-value" data-number="${player.number}">${formatTime(startTime)}</span>
            <button class="start-time-btn plus" data-number="${player.number}">+</button>
          ` : `
            <span class="no-song-label">No song</span>
          `}
          <button class="start-time-preview" data-number="${player.number}" title="Preview">&#9654;</button>
        </div>
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
        if (!player) return;

        // Play the full announcement + walkup sequence, auto-stop after 8s
        playPlayer(player);
        playbackStatus.textContent = 'Preview';

        setTimeout(() => {
          if (currentPlayer === player) {
            stopPlayback(true);
          }
        }, 8000);
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
        if (player.walkup && playbackPhase === 'announcement') {
          walkupAudio.play().catch(() => {});
        } else if (playbackPhase === 'walkup') {
          // already the active audio
        }
        totalPausedMs += Date.now() - pausedAt;
        isPaused = false;
      } else {
        activeAudio.pause();
        if (playbackPhase === 'announcement' && !walkupAudio.paused) {
          walkupAudio.pause();
        }
        pausedAt = Date.now();
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

    function advanceBatter() {
      if (lineup.length === 0) return;
      currentBatterIdx = (currentBatterIdx + 1) % lineup.length;
      const num = lineup[currentBatterIdx];
      const player = roster.find(p => p.number === num);
      if (player) {
        playPlayer(player);
        renderLineup();
      }
    }

    nextBtn.addEventListener('click', advanceBatter);
    batterBtn.addEventListener('click', () => {
      if (playbackPhase) {
        // Currently playing — just stop, don't advance
        stopPlayback(true);
      } else {
        // Not playing — advance and play
        advanceBatter();
      }
    });

    clearLineupBtn.addEventListener('click', () => {
      if (lineup.length === 0) return;
      if (!confirm('Clear the entire batting order?')) return;
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
    batterBtn.disabled = !hasLineup;
    batterBtn.textContent = isPlaying ? 'Stop Batter' : 'Next Batter';
    playPauseBtn.disabled = !hasLineup && !isPlaying;

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
    playbackStartTime = Date.now();
    pausedAt = 0;
    totalPausedMs = 0;

    showPlaybackInfo(player);
    highlightPlaying(player.number);
    updatePlayPauseIcon();
    updateTransportState();

    const vol = 1;
    // Boost announcement using Web Audio API gain node
    if (!announcementAudio._boosted) {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const source = ctx.createMediaElementSource(announcementAudio);
      const gain = ctx.createGain();
      gain.gain.value = 1.5;
      source.connect(gain);
      gain.connect(ctx.destination);
      announcementAudio._boosted = true;
      announcementAudio._gain = gain;
      announcementAudio._ctx = ctx;
    }
    announcementAudio.src = player.announcement;
    announcementAudio.volume = 1;
    announcementAudio.currentTime = 0;
    announcementAudio.play().catch(() => {});

    // Start walk-up song quietly underneath the announcement
    if (player.walkup) {
      const startTime = player.walkup.startTime || 0;
      walkupAudio.src = player.walkup.file;
      walkupAudio.volume = 0.15;
      walkupAudio.currentTime = startTime;
      walkupAudio.play().catch(() => {});
    }

    startProgressTracking();
  }

  function startWalkup(player) {
    playbackPhase = 'walkup';
    updatePlayPauseIcon();

    const startTime = player.walkup.startTime || 0;
    const duration = player.walkup.duration || globalDuration;

    // Fade walk-up from background volume to full over 1 second
    fadeIn(walkupAudio, 0.15, 1, 1000);

    if (duration && duration > 0) {
      // Song has been playing since the announcement started — calculate remaining time
      const alreadyPlayed = walkupAudio.currentTime - startTime;
      const remaining = duration - alreadyPlayed;
      const fadeStart = (remaining - 2) * 1000;
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

  function fadeIn(audio, fromVol, toVol, durationMs) {
    audio.volume = fromVol;
    const steps = 20;
    const stepTime = durationMs / steps;
    const volStep = (toVol - fromVol) / steps;
    let step = 0;
    const interval = setInterval(() => {
      step++;
      audio.volume = Math.min(toVol, fromVol + volStep * step);
      if (step >= steps) {
        clearInterval(interval);
        audio.volume = toVol;
      }
    }, stepTime);
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

      const now = isPaused ? pausedAt : Date.now();
      const elapsed = (now - playbackStartTime - totalPausedMs) / 1000;

      // Total = announcement duration + walkup duration
      const annDur = announcementAudio.duration && isFinite(announcementAudio.duration)
        ? announcementAudio.duration : 3;
      const walkupDur = (currentPlayer.walkup)
        ? (currentPlayer.walkup.duration || globalDuration)
        : 0;
      const total = annDur + walkupDur;

      const percent = total > 0 ? Math.min(100, (elapsed / total) * 100) : 0;

      progressFill.style.width = percent + '%';
      timeCurrent.textContent = formatTime(Math.max(0, elapsed));
      timeTotal.textContent = formatTime(Math.max(0, total));
    }, 100);
  }

  // === UI helpers ===
  function showPlaybackInfo(player) {
    playbackNumber.textContent = '#' + player.number;
    playbackName.textContent = player.firstName + ' ' + player.lastName;
    playbackStatus.textContent = 'Playing';
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
