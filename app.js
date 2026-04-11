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
  let walkupFadeTimeout = null;
  let globalDuration = 30;
  let isPaused = false;
  let playbackStartTime = 0;
  let pausedAt = 0;
  let totalPausedMs = 0;
  let wakeLock = null;

  // === Drag (lineup reorder) state ===
  let dragItem = null;
  let dragIdx = -1;
  let dragOffsetY = 0;
  let placeholder = null;

  // === Audio cache ===
  const objectUrlCache = {};   // playerNumber -> object URL for uploaded blob
  const audioBufferCache = {}; // playerNumber -> decoded AudioBuffer (for waveform)
  let searchPlayerNumber = null; // player number currently searching for
  let searchPreviewAudio = null; // audio element for previewing search results

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
  const progressBar = document.getElementById('progress-bar');
  const progressFill = document.getElementById('progress-fill');
  const timeCurrent = document.getElementById('time-current');
  const timeTotal = document.getElementById('time-total');
  const announcementAudio = document.getElementById('announcement-audio');
  const walkupAudio = document.getElementById('walkup-audio');
  const globalDurationSlider = document.getElementById('global-duration');
  const globalDurationLabel = document.getElementById('global-duration-label');
  const songSettingsList = document.getElementById('song-settings-list');

  // Now Playing (fullscreen) refs
  const nowPlaying = document.getElementById('now-playing');
  const expandBtn = document.getElementById('expand-btn');
  const collapseBtn = document.getElementById('collapse-btn');
  const npNumber = document.getElementById('np-number');
  const npName = document.getElementById('np-name');
  const npProgressBar = document.getElementById('np-progress-bar');
  const npProgressFill = document.getElementById('np-progress-fill');
  const npTimeCurrent = document.getElementById('np-time-current');
  const npTimeTotal = document.getElementById('np-time-total');
  const npPrevBtn = document.getElementById('np-prev-btn');
  const npNextBtn = document.getElementById('np-next-btn');
  const npPlayPauseBtn = document.getElementById('np-play-pause-btn');
  const npPlayIcon = document.getElementById('np-play-icon');
  const npPauseIcon = document.getElementById('np-pause-icon');
  const npBatterBtn = document.getElementById('np-batter-btn');
  const npCurrentLabel = document.getElementById('np-current-label');
  const npArt = document.getElementById('np-art');
  const npSongName = document.getElementById('np-song-name');
  const npNextBatter = document.getElementById('np-next-batter');
  const playbackArt = document.getElementById('playback-art');
  const playbackSongName = document.getElementById('playback-song-name');

  // === IndexedDB for uploaded audio files ===
  const DB_NAME = 'walkup-audio';
  const STORE_NAME = 'files';
  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE_NAME);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function saveAudioFile(playerNumber, blob) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(blob, playerNumber);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function getAudioFile(playerNumber) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(playerNumber);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function loadUploadedAudio() {
    // For each player, check IndexedDB for uploaded file. If present, override the walkup file path with object URL.
    for (const player of roster) {
      const blob = await getAudioFile(player.number);
      if (blob) {
        const url = URL.createObjectURL(blob);
        objectUrlCache[player.number] = url;
        // Remember the original (static) walkup file if any
        if (!player.walkup) {
          player.walkup = { startTime: 0 };
        } else if (player.walkup.file && !player._originalFile) {
          player._originalFile = player.walkup.file;
        }
        player.walkup.file = url;
        player._isUploaded = true;
      }
    }
  }

  async function deleteUploadedAudio(player) {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(player.number);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    if (objectUrlCache[player.number]) {
      URL.revokeObjectURL(objectUrlCache[player.number]);
      delete objectUrlCache[player.number];
    }
    delete audioBufferCache[player.number];
    player._isUploaded = false;
    if (player._originalFile) {
      player.walkup.file = player._originalFile;
      delete player._originalFile;
    } else {
      player.walkup = null;
    }
  }

  // === Deezer Search ===
  let searchDebounceTimer = null;

  async function searchDeezer(query) {
    if (!query || query.length < 2) return [];
    try {
      const resp = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=12&output=jsonp`);
      // Deezer doesn't support CORS for search, use JSONP-style workaround
      // Actually, let's try with a CORS proxy approach or direct fetch
      const data = await resp.json();
      return data.data || [];
    } catch (e) {
      // Fallback: use JSONP
      return searchDeezerJsonp(query);
    }
  }

  function searchDeezerJsonp(query) {
    return new Promise((resolve) => {
      const cbName = '_deezerCb' + Date.now();
      const script = document.createElement('script');
      script.src = `https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=12&output=jsonp&callback=${cbName}`;
      window[cbName] = (data) => {
        resolve(data.data || []);
        delete window[cbName];
        script.remove();
      };
      script.onerror = () => {
        resolve([]);
        delete window[cbName];
        script.remove();
      };
      document.head.appendChild(script);
    });
  }

  function openSearchModal(playerNumber) {
    searchPlayerNumber = playerNumber;
    const player = roster.find(p => p.number === playerNumber);
    const modal = document.getElementById('search-modal');
    const input = document.getElementById('search-input');
    const playerLabel = document.getElementById('search-player-label');
    const results = document.getElementById('search-results');

    playerLabel.textContent = `#${player.number} ${player.firstName} ${player.lastName}`;
    input.value = '';
    results.innerHTML = '<div class="search-empty">Search for a song above</div>';
    modal.classList.remove('hidden');
    setTimeout(() => input.focus(), 100);

    // Stop any preview audio
    if (searchPreviewAudio) {
      searchPreviewAudio.pause();
      searchPreviewAudio = null;
    }
  }

  function closeSearchModal() {
    const modal = document.getElementById('search-modal');
    modal.classList.add('hidden');
    searchPlayerNumber = null;
    if (searchPreviewAudio) {
      searchPreviewAudio.pause();
      searchPreviewAudio = null;
    }
  }

  function renderSearchResults(tracks) {
    const results = document.getElementById('search-results');
    if (tracks.length === 0) {
      results.innerHTML = '<div class="search-empty">No results found</div>';
      return;
    }

    results.innerHTML = '';
    tracks.forEach(track => {
      const item = document.createElement('div');
      item.className = 'search-result';
      const albumArt = track.album?.cover_medium || track.album?.cover_small || '';
      item.innerHTML = `
        <img class="search-result-art" src="${albumArt}" alt="" loading="lazy">
        <div class="search-result-info">
          <div class="search-result-title">${escapeHtml(track.title_short || track.title)}</div>
          <div class="search-result-artist">${escapeHtml(track.artist?.name || 'Unknown')}</div>
        </div>
        <button class="search-result-preview" data-preview="${track.preview || ''}" title="Preview">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg>
        </button>
        <button class="search-result-select" data-id="${track.id}" title="Use this song">Use</button>
      `;
      results.appendChild(item);
    });

    // Preview buttons
    results.querySelectorAll('.search-result-preview').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const url = btn.dataset.preview;
        if (!url) return;

        // Toggle preview
        if (searchPreviewAudio && searchPreviewAudio.src === url && !searchPreviewAudio.paused) {
          searchPreviewAudio.pause();
          btn.classList.remove('previewing');
          return;
        }

        // Stop any existing preview
        if (searchPreviewAudio) searchPreviewAudio.pause();
        results.querySelectorAll('.previewing').forEach(b => b.classList.remove('previewing'));

        searchPreviewAudio = new Audio(url);
        searchPreviewAudio.play().catch(() => {});
        btn.classList.add('previewing');
        searchPreviewAudio.addEventListener('ended', () => btn.classList.remove('previewing'));
      });
    });

    // Select buttons
    results.querySelectorAll('.search-result-select').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const trackId = btn.dataset.id;
        const track = tracks.find(t => String(t.id) === trackId);
        if (!track || !track.preview) return;
        if (!searchPlayerNumber) return;

        btn.textContent = '...';
        btn.disabled = true;

        try {
          await assignDeezerTrack(searchPlayerNumber, track);
          closeSearchModal();
          renderRoster();
          renderSettings();
          renderAllWaveforms();
        } catch (err) {
          btn.textContent = 'Use';
          btn.disabled = false;
          alert('Failed to save song: ' + err.message);
        }
      });
    });
  }

  async function assignDeezerTrack(playerNumber, track) {
    const player = roster.find(p => p.number === playerNumber);
    if (!player) return;

    // Download the preview MP3 and store in IndexedDB
    const resp = await fetch(track.preview);
    const blob = await resp.blob();
    await saveAudioFile(playerNumber, blob);

    // Revoke old URL
    if (objectUrlCache[playerNumber]) {
      URL.revokeObjectURL(objectUrlCache[playerNumber]);
    }

    const url = URL.createObjectURL(blob);
    objectUrlCache[playerNumber] = url;

    if (!player.walkup) {
      player.walkup = { startTime: 0 };
    } else if (player.walkup.file && !player._originalFile && !player._isUploaded) {
      player._originalFile = player.walkup.file;
    }
    player.walkup.file = url;
    player._isUploaded = true;
    player._deezerTrack = {
      title: track.title_short || track.title,
      artist: track.artist?.name || '',
      art: track.album?.cover_medium || track.album?.cover_small || '',
      artLarge: track.album?.cover_xl || track.album?.cover_big || track.album?.cover_medium || '',
    };

    // Persist deezer track info
    saveDeezerInfo();
    delete audioBufferCache[playerNumber];
  }

  function saveDeezerInfo() {
    const info = {};
    roster.forEach(p => {
      if (p._deezerTrack) info[p.number] = p._deezerTrack;
    });
    localStorage.setItem('walkup-deezer-info', JSON.stringify(info));
  }

  function loadDeezerInfo() {
    const saved = localStorage.getItem('walkup-deezer-info');
    if (!saved) return;
    try {
      const info = JSON.parse(saved);
      roster.forEach(p => {
        if (info[p.number]) p._deezerTrack = info[p.number];
      });
    } catch (e) {}
  }

  function showConfirm(message, okLabel = 'Remove') {
    return new Promise((resolve) => {
      const modal = document.getElementById('confirm-modal');
      const msgEl = document.getElementById('confirm-message');
      const okBtn = document.getElementById('confirm-ok');
      const cancelBtn = document.getElementById('confirm-cancel');
      const backdrop = document.getElementById('confirm-backdrop');

      msgEl.innerHTML = message;
      okBtn.textContent = okLabel;
      modal.classList.remove('hidden');

      function cleanup(result) {
        modal.classList.add('hidden');
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        backdrop.removeEventListener('click', onCancel);
        resolve(result);
      }

      function onOk() { cleanup(true); }
      function onCancel() { cleanup(false); }

      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
      backdrop.addEventListener('click', onCancel);
    });
  }

  // === Dynamic color from album art ===
  function extractDominantColor(imgSrc) {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const size = 40; // small sample
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, size, size);
        try {
          const data = ctx.getImageData(0, 0, size, size).data;
          let r = 0, g = 0, b = 0, count = 0;
          // Sample pixels, skipping very dark and very light ones
          for (let i = 0; i < data.length; i += 16) { // every 4th pixel
            const pr = data[i], pg = data[i + 1], pb = data[i + 2];
            const brightness = (pr + pg + pb) / 3;
            if (brightness > 30 && brightness < 220) {
              // Weight more saturated colors higher
              const max = Math.max(pr, pg, pb);
              const min = Math.min(pr, pg, pb);
              const saturation = max === 0 ? 0 : (max - min) / max;
              const weight = 1 + saturation * 3;
              r += pr * weight;
              g += pg * weight;
              b += pb * weight;
              count += weight;
            }
          }
          if (count > 0) {
            r = Math.round(r / count);
            g = Math.round(g / count);
            b = Math.round(b / count);
            resolve({ r, g, b });
          } else {
            resolve({ r: 40, g: 40, b: 60 }); // fallback
          }
        } catch (e) {
          resolve({ r: 40, g: 40, b: 60 }); // CORS or other error
        }
      };
      img.onerror = () => resolve({ r: 40, g: 40, b: 60 });
      img.src = imgSrc;
    });
  }

  async function applyAlbumBackground(imgSrc) {
    if (!imgSrc) {
      nowPlaying.style.background = '';
      return;
    }
    const c = await extractDominantColor(imgSrc);
    // Create a dark, subtle gradient using the dominant color
    nowPlaying.style.background = `
      radial-gradient(circle at 50% 25%, rgba(${c.r}, ${c.g}, ${c.b}, 0.35) 0%, transparent 70%),
      radial-gradient(circle at 30% 80%, rgba(${c.r}, ${c.g}, ${c.b}, 0.15) 0%, transparent 50%),
      radial-gradient(circle at 80% 60%, rgba(${c.r}, ${c.g}, ${c.b}, 0.1) 0%, transparent 40%),
      var(--bg)
    `;
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // === Wake Lock ===
  async function acquireWakeLock() {
    try {
      if ('wakeLock' in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch (e) {
      // Silent fail — wake lock not supported or denied
    }
  }

  function releaseWakeLock() {
    if (wakeLock) {
      wakeLock.release().catch(() => {});
      wakeLock = null;
    }
  }

  // Re-acquire on visibility change (page returns from background)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && playbackPhase) {
      acquireWakeLock();
    }
  });

  // === Init ===
  async function init() {
    const resp = await fetch('roster.json');
    roster = await resp.json();
    roster.sort((a, b) => a.number - b.number);

    await loadUploadedAudio();
    loadDeezerInfo();

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
    setupNowPlayingGestures();
    setupMediaSessionHandlers();
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

        // Lazy-render waveforms when settings tab opens
        if (tab.dataset.tab === 'settings') {
          renderAllWaveforms();
        }
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
      attachDropHandlers(card, player);
      rosterView.appendChild(card);
    });
  }

  // === Lineup helpers ===
  function getOnDeckIdx() {
    if (lineup.length === 0 || currentBatterIdx < 0) return -1;
    return (currentBatterIdx + 1) % lineup.length;
  }

  function getInTheHoleIdx() {
    if (lineup.length < 3 || currentBatterIdx < 0) return -1;
    return (currentBatterIdx + 2) % lineup.length;
  }

  function getPlayerAtLineupIdx(idx) {
    if (idx < 0 || idx >= lineup.length) return null;
    return roster.find(p => p.number === lineup[idx]) || null;
  }

  // === Lineup rendering ===
  function renderLineup() {
    if (lineup.length === 0) {
      lineupList.innerHTML = '<div class="empty-lineup">No batting order set.<br>Tap players below to build the lineup.</div>';
    } else {
      const onDeckIdx = getOnDeckIdx();
      const holeIdx = getInTheHoleIdx();

      lineupList.innerHTML = '';
      lineup.forEach((num, idx) => {
        const player = roster.find(p => p.number === num);
        if (!player) return;

        // Determine role
        let role = '';
        let roleLabel = '';
        if (idx === currentBatterIdx) {
          role = 'at-bat';
          roleLabel = 'AT BAT';
        } else if (idx === onDeckIdx) {
          role = 'on-deck';
          roleLabel = 'ON DECK';
        } else if (idx === holeIdx) {
          role = 'in-the-hole';
          roleLabel = 'IN THE HOLE';
        }

        const item = document.createElement('div');
        item.className = 'lineup-item' + (role ? ' ' + role : '');
        item.dataset.number = num;
        item.dataset.idx = idx;
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
          ${roleLabel ? `<span class="lineup-role lineup-role-${role}">${roleLabel}</span>` : ''}
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

      if (currentBatterIdx === dragIdx) {
        currentBatterIdx = newIdx;
      } else {
        if (currentBatterIdx > dragIdx) currentBatterIdx--;
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
      row.className = 'song-setting-row';
      row.dataset.number = player.number;

      const startTime = hasWalkup ? (player.walkup.startTime || 0) : 0;

      const dz = player._deezerTrack;
      const songInfo = dz
        ? `<div class="song-info"><img class="song-info-art" src="${dz.art}" alt="">${escapeHtml(dz.title)} — ${escapeHtml(dz.artist)}</div>`
        : (hasWalkup ? '<div class="song-info song-info-file">Uploaded MP3</div>' : '');

      row.innerHTML = `
        <div class="song-setting-header">
          <div class="song-setting-player">
            <span class="song-setting-number">#${player.number}</span>
            <span class="song-setting-name">${player.firstName} ${player.lastName}</span>
          </div>
          <div class="song-setting-actions">
            <button class="search-song-btn" data-number="${player.number}">Search</button>
            ${player._isUploaded ? `
              <button class="remove-upload-btn" data-number="${player.number}" title="Remove song">&#10005;</button>
            ` : ''}
          </div>
        </div>
        ${songInfo}
        ${hasWalkup ? `
          <div class="song-setting-control">
            <label class="song-setting-label">Start</label>
            <button class="start-time-btn minus" data-number="${player.number}">-</button>
            <span class="start-time-value" data-number="${player.number}">${formatTime(startTime)}</span>
            <button class="start-time-btn plus" data-number="${player.number}">+</button>
            <button class="start-time-preview" data-number="${player.number}" title="Preview">&#9654;</button>
          </div>
        ` : ''}
        <div class="waveform-container" data-number="${player.number}">
          ${hasWalkup
            ? `<canvas class="waveform-canvas" data-number="${player.number}"></canvas>
               <div class="waveform-marker" data-number="${player.number}"></div>
               <div class="waveform-overlay">Drop MP3 to replace</div>`
            : `<div class="waveform-empty">Drop MP3 or use Search above</div>`}
        </div>
      `;

      // Drop target on the waveform container
      const waveformContainer = row.querySelector('.waveform-container');
      attachDropHandlers(waveformContainer, player);

      songSettingsList.appendChild(row);
    });

    // Wire up +/- buttons
    songSettingsList.querySelectorAll('.start-time-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const num = parseInt(btn.dataset.number);
        const player = roster.find(p => p.number === num);
        if (!player || !player.walkup) return;

        const delta = btn.classList.contains('plus') ? 1 : -1;
        player.walkup.startTime = Math.max(0, (player.walkup.startTime || 0) + delta);

        const valueEl = songSettingsList.querySelector(`.start-time-value[data-number="${num}"]`);
        if (valueEl) valueEl.textContent = formatTime(player.walkup.startTime);

        updateWaveformMarker(num);
        saveStartTimes();
      });
    });

    // Wire up preview buttons (full-duration playback)
    songSettingsList.querySelectorAll('.start-time-preview').forEach(btn => {
      btn.addEventListener('click', () => {
        const num = parseInt(btn.dataset.number);
        const player = roster.find(p => p.number === num);
        if (!player) return;
        playPlayer(player);
        playbackStatus.textContent = 'Preview';
      });
    });

    // Wire up remove uploaded song buttons
    songSettingsList.querySelectorAll('.remove-upload-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const num = parseInt(btn.dataset.number);
        const player = roster.find(p => p.number === num);
        if (!player) return;
        const ok = await showConfirm(
          `Remove walk-up song for<br><strong>#${player.number} ${player.firstName} ${player.lastName}</strong>?`
        );
        if (!ok) return;

        try {
          await deleteUploadedAudio(player);
          renderRoster();
          renderSettings();
          renderAllWaveforms();
        } catch (err) {
          alert('Failed to remove song: ' + err.message);
        }
      });
    });

    // Wire up search buttons
    songSettingsList.querySelectorAll('.search-song-btn').forEach(btn => {
      btn.addEventListener('click', () => openSearchModal(parseInt(btn.dataset.number)));
    });

    // Wire up waveform click-and-drag (set start time)
    songSettingsList.querySelectorAll('.waveform-canvas').forEach(canvas => {
      function setStartFromEvent(e, clientX) {
        const num = parseInt(canvas.dataset.number);
        const player = roster.find(p => p.number === num);
        if (!player || !player.walkup) return;
        const buf = audioBufferCache[num];
        if (!buf) return;

        const rect = canvas.getBoundingClientRect();
        const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
        const pct = x / rect.width;
        player.walkup.startTime = Math.round(pct * buf.duration);

        const valueEl = songSettingsList.querySelector(`.start-time-value[data-number="${num}"]`);
        if (valueEl) valueEl.textContent = formatTime(player.walkup.startTime);

        updateWaveformMarker(num);
        saveStartTimes();
      }

      // Mouse drag
      canvas.addEventListener('mousedown', (e) => {
        e.preventDefault();
        setStartFromEvent(e, e.clientX);
        function onMove(ev) { setStartFromEvent(ev, ev.clientX); }
        function onUp() {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });

      // Touch drag
      canvas.addEventListener('touchstart', (e) => {
        e.preventDefault();
        setStartFromEvent(e, e.touches[0].clientX);
      }, { passive: false });
      canvas.addEventListener('touchmove', (e) => {
        e.preventDefault();
        setStartFromEvent(e, e.touches[0].clientX);
      }, { passive: false });
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

  // === Waveform rendering ===
  async function renderAllWaveforms() {
    for (const player of roster) {
      if (player.walkup) {
        await renderWaveform(player);
      }
    }
  }

  async function renderWaveform(player) {
    const canvas = songSettingsList.querySelector(`.waveform-canvas[data-number="${player.number}"]`);
    if (!canvas) return;

    let buffer = audioBufferCache[player.number];
    if (!buffer) {
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const arrayBuffer = await fetch(player.walkup.file).then(r => r.arrayBuffer());
        buffer = await ctx.decodeAudioData(arrayBuffer);
        audioBufferCache[player.number] = buffer;
      } catch (e) {
        console.error('Failed to decode audio for waveform', e);
        return;
      }
    }

    drawWaveform(canvas, buffer, player.number);
    updateWaveformMarker(player.number);
  }

  function drawWaveform(canvas, buffer, playerNumber) {
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = canvas.offsetWidth || canvas.parentElement.offsetWidth || 300;
    const cssHeight = 60;
    canvas.width = cssWidth * dpr;
    canvas.height = cssHeight * dpr;
    canvas.style.width = cssWidth + 'px';
    canvas.style.height = cssHeight + 'px';

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    const channelData = buffer.getChannelData(0);
    const bars = Math.floor(cssWidth / 3);
    const samplesPerBar = Math.floor(channelData.length / bars);
    const midY = cssHeight / 2;

    // Compute playback region
    const player = roster.find(p => p.number === playerNumber);
    const startTime = player?.walkup?.startTime || 0;
    const effectiveDur = getEffectiveWalkupDuration(player);
    const endTime = startTime + effectiveDur;
    const startBar = Math.floor((startTime / buffer.duration) * bars);
    const endBar = Math.floor((endTime / buffer.duration) * bars);

    for (let i = 0; i < bars; i++) {
      let max = 0;
      const start = i * samplesPerBar;
      const end = start + samplesPerBar;
      for (let j = start; j < end; j++) {
        const v = Math.abs(channelData[j]);
        if (v > max) max = v;
      }
      const h = Math.max(1, max * cssHeight * 0.9);

      // Bars in playback region are bright, others are dim
      if (i >= startBar && i < endBar) {
        ctx.fillStyle = 'rgba(244, 160, 32, 0.6)';
      } else {
        ctx.fillStyle = 'rgba(251, 252, 255, 0.15)';
      }
      ctx.fillRect(i * 3, midY - h / 2, 2, h);
    }
  }

  function updateWaveformMarker(playerNumber) {
    const player = roster.find(p => p.number === playerNumber);
    if (!player || !player.walkup) return;
    const buf = audioBufferCache[playerNumber];
    if (!buf) return;

    const marker = songSettingsList.querySelector(`.waveform-marker[data-number="${playerNumber}"]`);
    if (!marker) return;

    const pct = ((player.walkup.startTime || 0) / buf.duration) * 100;
    marker.style.left = pct + '%';

    // Redraw waveform to update the highlighted playback region
    const canvas = songSettingsList.querySelector(`.waveform-canvas[data-number="${playerNumber}"]`);
    if (canvas) drawWaveform(canvas, buf, playerNumber);
  }

  // === Drag-and-drop file upload ===
  function attachDropHandlers(element, player) {
    element.addEventListener('dragover', (e) => {
      // Only show drop zone if files are being dragged
      if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) {
        e.preventDefault();
        element.classList.add('drag-over');
      }
    });

    element.addEventListener('dragleave', (e) => {
      if (!element.contains(e.relatedTarget)) {
        element.classList.remove('drag-over');
      }
    });

    element.addEventListener('drop', async (e) => {
      e.preventDefault();
      element.classList.remove('drag-over');

      const file = e.dataTransfer.files[0];
      if (!file) return;
      if (!file.type.startsWith('audio/') && !file.name.toLowerCase().endsWith('.mp3')) {
        alert('Please drop an audio file (MP3)');
        return;
      }

      try {
        await saveAudioFile(player.number, file);

        // Revoke old object URL if any
        if (objectUrlCache[player.number]) {
          URL.revokeObjectURL(objectUrlCache[player.number]);
        }

        const url = URL.createObjectURL(file);
        objectUrlCache[player.number] = url;

        if (!player.walkup) {
          player.walkup = { startTime: 0 };
        } else if (player.walkup.file && !player._originalFile && !player._isUploaded) {
          player._originalFile = player.walkup.file;
        }
        player.walkup.file = url;
        player._isUploaded = true;

        // Clear waveform cache so it re-decodes
        delete audioBufferCache[player.number];

        renderRoster();
        renderSettings();
        renderAllWaveforms();
      } catch (err) {
        console.error('Failed to save audio file', err);
        alert('Failed to save audio file: ' + err.message);
      }
    });
  }

  // === Playback ===
  function getEffectiveWalkupDuration(player) {
    if (!player || !player.walkup) return 0;
    const startTime = player.walkup.startTime || 0;
    const configuredDur = player.walkup.duration || globalDuration;
    // If we know the audio file length, cap to what's available
    const buf = audioBufferCache[player.number];
    if (buf) {
      const available = buf.duration - startTime;
      return Math.max(0, Math.min(configuredDur, available));
    }
    return configuredDur;
  }

  function getTotalDuration() {
    if (!currentPlayer) return 0;
    const annDur = (announcementAudio.duration && isFinite(announcementAudio.duration))
      ? announcementAudio.duration : 3;
    if (!currentPlayer.walkup) return annDur;
    const walkupDur = getEffectiveWalkupDuration(currentPlayer);
    return Math.max(annDur, walkupDur);
  }

  function setupControls() {
    playPauseBtn.addEventListener('click', () => {
      if (!currentPlayer || !playbackPhase) {
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

      if (isPaused) {
        if (playbackPhase === 'announcement') {
          announcementAudio.play().catch(() => {});
          if (currentPlayer && currentPlayer.walkup) walkupAudio.play().catch(() => {});
        } else {
          walkupAudio.play().catch(() => {});
        }
        totalPausedMs += Date.now() - pausedAt;
        isPaused = false;
        acquireWakeLock();
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
      } else {
        announcementAudio.pause();
        walkupAudio.pause();
        pausedAt = Date.now();
        isPaused = true;
        releaseWakeLock();
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
      }
      updatePlayPauseIcon();
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

    nextBtn.addEventListener('click', advanceBatter);

    batterBtn.addEventListener('click', () => {
      if (playbackPhase) {
        stopPlayback(true);
      } else {
        advanceBatter();
      }
    });

    clearLineupBtn.addEventListener('click', async () => {
      if (lineup.length === 0) return;
      const ok = await showConfirm('Clear the entire batting order?', 'Clear');
      if (!ok) return;
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

    // Tap progress bar to seek
    progressBar.addEventListener('click', (e) => {
      if (!currentPlayer || !playbackPhase) return;
      const rect = progressBar.getBoundingClientRect();
      const pct = (e.clientX - rect.left) / rect.width;
      const total = getTotalDuration();
      seekTo(pct * total);
    });

    // Search modal
    document.getElementById('search-close').addEventListener('click', closeSearchModal);
    document.getElementById('search-modal-backdrop').addEventListener('click', closeSearchModal);
    const searchInput = document.getElementById('search-input');
    searchInput.addEventListener('input', () => {
      clearTimeout(searchDebounceTimer);
      const query = searchInput.value.trim();
      if (query.length < 2) {
        document.getElementById('search-results').innerHTML = '<div class="search-empty">Type at least 2 characters</div>';
        return;
      }
      document.getElementById('search-results').innerHTML = '<div class="search-empty">Searching...</div>';
      searchDebounceTimer = setTimeout(async () => {
        const tracks = await searchDeezer(query);
        renderSearchResults(tracks);
      }, 300);
    });

    // Now Playing fullscreen
    expandBtn.addEventListener('click', () => {
      nowPlaying.classList.remove('hidden');
      updateNowPlaying();
    });

    collapseBtn.addEventListener('click', () => {
      nowPlaying.classList.add('hidden');
    });

    // Mirror controls in fullscreen view
    npPlayPauseBtn.addEventListener('click', () => playPauseBtn.click());
    npPrevBtn.addEventListener('click', () => prevBtn.click());
    npNextBtn.addEventListener('click', () => nextBtn.click());
    npBatterBtn.addEventListener('click', () => batterBtn.click());

    npProgressBar.addEventListener('click', (e) => {
      if (!currentPlayer || !playbackPhase) return;
      const rect = npProgressBar.getBoundingClientRect();
      const pct = (e.clientX - rect.left) / rect.width;
      const total = getTotalDuration();
      seekTo(pct * total);
    });
  }

  // === Swipe-down gesture for Now Playing ===
  function setupNowPlayingGestures() {
    let startY = 0;
    let currentY = 0;
    let isDragging = false;

    nowPlaying.addEventListener('touchstart', (e) => {
      // Only drag if the touch started on background or specific drag areas,
      // not on buttons or interactive elements
      if (e.target.closest('button, canvas, input, #np-progress-bar')) return;
      startY = e.touches[0].clientY;
      currentY = startY;
      isDragging = true;
      nowPlaying.style.transition = 'none';
    }, { passive: true });

    nowPlaying.addEventListener('touchmove', (e) => {
      if (!isDragging) return;
      currentY = e.touches[0].clientY;
      const delta = Math.max(0, currentY - startY);
      nowPlaying.style.transform = `translateY(${delta}px)`;
      nowPlaying.style.opacity = String(Math.max(0.5, 1 - delta / 600));
    }, { passive: true });

    nowPlaying.addEventListener('touchend', () => {
      if (!isDragging) return;
      isDragging = false;
      nowPlaying.style.transition = '';
      const delta = currentY - startY;
      if (delta > 120) {
        // Collapse
        nowPlaying.classList.add('hidden');
      }
      nowPlaying.style.transform = '';
      nowPlaying.style.opacity = '';
    });

    nowPlaying.addEventListener('touchcancel', () => {
      isDragging = false;
      nowPlaying.style.transition = '';
      nowPlaying.style.transform = '';
      nowPlaying.style.opacity = '';
    });
  }

  function updateNowPlaying() {
    // Show currently playing player, OR the current batter in the lineup, OR nothing
    let activePlayer = currentPlayer;
    if (!activePlayer && lineup.length > 0 && currentBatterIdx >= 0) {
      activePlayer = getPlayerAtLineupIdx(currentBatterIdx);
    }

    if (!activePlayer) {
      npNumber.textContent = '--';
      npName.textContent = 'No batter selected';
      npNextBatter.innerHTML = '—';
      npCurrentLabel.textContent = '';
      document.getElementById('np-song-line').classList.add('hidden');
      applyAlbumBackground(null);
      if (!playbackPhase) {
        npProgressFill.style.width = '0%';
        npTimeCurrent.textContent = '0:00';
        npTimeTotal.textContent = '0:00';
      }
      return;
    }

    npCurrentLabel.textContent = 'At Bat';
    npNumber.textContent = '#' + activePlayer.number;
    npName.textContent = activePlayer.firstName + ' ' + activePlayer.lastName;

    // Album art and song name in fullscreen
    const dz = activePlayer._deezerTrack;
    const npSongLine = document.getElementById('np-song-line');
    if (dz && dz.art) {
      const artUrl = dz.artLarge || dz.art;
      npArt.src = dz.art; // use medium for inline
      npSongName.textContent = `${dz.title} — ${dz.artist}`;
      npSongLine.classList.remove('hidden');
      applyAlbumBackground(artUrl);
    } else {
      npSongLine.classList.add('hidden');
      applyAlbumBackground(null);
    }

    if (!playbackPhase) {
      npProgressFill.style.width = '0%';
      npTimeCurrent.textContent = '0:00';
      npTimeTotal.textContent = '0:00';
    }

    // On deck + in the hole
    const onDeckPlayer = getPlayerAtLineupIdx(getOnDeckIdx());
    const holePlayer = getPlayerAtLineupIdx(getInTheHoleIdx());

    let nextHtml = '';
    if (onDeckPlayer) {
      nextHtml += `<div class="np-role-row"><span class="np-role-label on-deck">On Deck</span><span class="np-role-name">#${onDeckPlayer.number} ${onDeckPlayer.firstName} ${onDeckPlayer.lastName}</span></div>`;
    }
    if (holePlayer) {
      nextHtml += `<div class="np-role-row"><span class="np-role-label in-the-hole">In the Hole</span><span class="np-role-name">#${holePlayer.number} ${holePlayer.firstName} ${holePlayer.lastName}</span></div>`;
    }
    npNextBatter.innerHTML = nextHtml || '—';
  }

  function updateTransportState() {
    const hasLineup = lineup.length > 0;
    const isPlaying = playbackPhase !== null;

    prevBtn.disabled = !hasLineup;
    nextBtn.disabled = !hasLineup;
    batterBtn.disabled = !hasLineup;
    batterBtn.textContent = isPlaying ? 'Stop Batter' : 'Next Batter';
    playPauseBtn.disabled = !hasLineup && !isPlaying;

    npPrevBtn.disabled = !hasLineup;
    npNextBtn.disabled = !hasLineup;
    npBatterBtn.disabled = !hasLineup;
    npBatterBtn.textContent = isPlaying ? 'Stop Batter' : 'Next Batter';
    npPlayPauseBtn.disabled = !hasLineup && !isPlaying;

    playbackBar.classList.toggle('active', isPlaying);
    updateNowPlaying();
  }

  function updatePlayPauseIcon() {
    const isPlaying = playbackPhase !== null && !isPaused;
    playIcon.style.display = isPlaying ? 'none' : '';
    pauseIcon.style.display = isPlaying ? '' : 'none';
    npPlayIcon.style.display = isPlaying ? 'none' : '';
    npPauseIcon.style.display = isPlaying ? '' : 'none';
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

    // Boost announcement using Web Audio API gain node
    if (!announcementAudio._boosted) {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const source = ctx.createMediaElementSource(announcementAudio);
      const gain = ctx.createGain();
      gain.gain.value = 1.5;
      source.connect(gain);
      gain.connect(ctx.destination);
      announcementAudio._boosted = true;
    }
    announcementAudio.src = player.announcement;
    announcementAudio.volume = 1;
    announcementAudio.currentTime = 0;
    announcementAudio.play().catch(() => {});

    if (player.walkup) {
      const startTime = player.walkup.startTime || 0;
      walkupAudio.src = player.walkup.file;
      walkupAudio.volume = 0.15;
      walkupAudio.currentTime = startTime;
      walkupAudio.play().catch(() => {});
    }

    acquireWakeLock();
    setMediaSessionMetadata(player);
    startProgressTracking();
  }

  // === Media Session (lock screen controls) ===
  function setMediaSessionMetadata(player) {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: `#${player.number} ${player.firstName} ${player.lastName}`,
        artist: 'Now Batting',
        album: 'Walk-Up Music',
        artwork: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      });
      navigator.mediaSession.playbackState = 'playing';
    } catch (e) {}
  }

  function setupMediaSessionHandlers() {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.setActionHandler('play', () => {
        if (isPaused || !playbackPhase) playPauseBtn.click();
      });
      navigator.mediaSession.setActionHandler('pause', () => {
        if (!isPaused && playbackPhase) playPauseBtn.click();
      });
      navigator.mediaSession.setActionHandler('previoustrack', () => prevBtn.click());
      navigator.mediaSession.setActionHandler('nexttrack', () => nextBtn.click());
      navigator.mediaSession.setActionHandler('stop', () => {
        if (playbackPhase) stopPlayback(true);
      });
    } catch (e) {}
  }

  function clearMediaSession() {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = 'none';
    } catch (e) {}
  }

  function startWalkup(player) {
    playbackPhase = 'walkup';
    updatePlayPauseIcon();
    fadeIn(walkupAudio, 0.15, 1, 1000);
    scheduleWalkupFadeOut(player);
  }

  function scheduleWalkupFadeOut(player) {
    if (walkupFadeTimeout) {
      clearTimeout(walkupFadeTimeout);
      walkupFadeTimeout = null;
    }
    if (!player.walkup) return;

    const startTime = player.walkup.startTime || 0;
    const duration = getEffectiveWalkupDuration(player);
    const alreadyPlayed = walkupAudio.currentTime - startTime;
    const remaining = duration - alreadyPlayed;
    if (remaining <= 0) {
      finishPlayback();
      return;
    }
    const fadeStartMs = Math.max(0, (remaining - 2) * 1000);
    walkupFadeTimeout = setTimeout(() => {
      walkupFadeTimeout = null;
      if (playbackPhase === 'walkup' && currentPlayer === player && !isPaused) {
        fadeOut(walkupAudio, 2000, () => finishPlayback());
      }
    }, fadeStartMs);
  }

  function seekTo(seconds) {
    if (!currentPlayer || !playbackPhase) return;

    const annDur = (announcementAudio.duration && isFinite(announcementAudio.duration))
      ? announcementAudio.duration : 3;
    const startTime = currentPlayer.walkup ? (currentPlayer.walkup.startTime || 0) : 0;
    const total = getTotalDuration();
    seconds = Math.max(0, Math.min(total, seconds));

    // Cancel any pending fades
    if (walkupFadeTimeout) {
      clearTimeout(walkupFadeTimeout);
      walkupFadeTimeout = null;
    }
    clearInterval(fadeInterval);

    if (seconds < annDur) {
      // In announcement phase
      playbackPhase = 'announcement';
      announcementAudio.currentTime = seconds;
      if (!isPaused) announcementAudio.play().catch(() => {});

      if (currentPlayer.walkup) {
        walkupAudio.currentTime = startTime + seconds;
        walkupAudio.volume = 0.15;
        if (!isPaused) walkupAudio.play().catch(() => {});
      }
    } else {
      // Past announcement → walkup phase
      playbackPhase = 'walkup';
      announcementAudio.pause();

      if (currentPlayer.walkup) {
        walkupAudio.currentTime = startTime + seconds;
        walkupAudio.volume = 1;
        if (!isPaused) walkupAudio.play().catch(() => {});
        scheduleWalkupFadeOut(currentPlayer);
      } else {
        finishPlayback();
        return;
      }
    }

    // Reset timer baseline
    playbackStartTime = Date.now() - (seconds * 1000);
    totalPausedMs = 0;
    if (isPaused) {
      pausedAt = Date.now();
    }
    updatePlayPauseIcon();
  }

  function stopPlayback(withFade) {
    clearInterval(fadeInterval);
    clearInterval(progressInterval);
    if (walkupFadeTimeout) {
      clearTimeout(walkupFadeTimeout);
      walkupFadeTimeout = null;
    }

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
    walkupAudio.pause();
    walkupAudio.currentTime = 0;
  }

  function finishPlayback() {
    playbackPhase = null;
    currentPlayer = null;
    isPaused = false;
    clearInterval(progressInterval);
    clearHighlights();
    updatePlayPauseIcon();
    updateTransportState();
    releaseWakeLock();
    clearMediaSession();
    playbackNumber.textContent = '';
    playbackName.textContent = 'No player selected';
    playbackStatus.textContent = '';
    playbackArt.classList.add('hidden');
    playbackSongName.classList.add('hidden');
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
      const total = getTotalDuration();
      const percent = total > 0 ? Math.min(100, (elapsed / total) * 100) : 0;

      progressFill.style.width = percent + '%';
      timeCurrent.textContent = formatTime(Math.max(0, elapsed));
      timeTotal.textContent = formatTime(Math.max(0, total));

      // Mirror to fullscreen view
      npProgressFill.style.width = percent + '%';
      npTimeCurrent.textContent = formatTime(Math.max(0, elapsed));
      npTimeTotal.textContent = formatTime(Math.max(0, total));
    }, 100);
  }

  // === UI helpers ===
  function showPlaybackInfo(player) {
    playbackNumber.textContent = '#' + player.number;
    playbackName.textContent = player.firstName + ' ' + player.lastName;
    playbackStatus.textContent = 'At Bat';
    progressFill.style.width = '0%';
    timeCurrent.textContent = '0:00';

    // Album art and song name in collapsed bar
    const dz = player._deezerTrack;
    if (dz && dz.art) {
      playbackArt.src = dz.art;
      playbackArt.classList.remove('hidden');
      playbackSongName.textContent = `${dz.title} — ${dz.artist}`;
      playbackSongName.classList.remove('hidden');
    } else {
      playbackArt.classList.add('hidden');
      playbackSongName.classList.add('hidden');
    }
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

  // === Service Worker (PWA) ===
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }

  // === Warn before closing during playback ===
  window.addEventListener('beforeunload', (e) => {
    if (playbackPhase) {
      e.preventDefault();
      e.returnValue = '';
      return '';
    }
  });

  // === Start ===
  init();
})();
