/* ============================================================
   viewer.js — Sync engine, playback, annotations, export
   ============================================================ */

// ── Module state ────────────────────────────────────────────
const DROPBOX_FOLDER = sessionStorage.getItem('calten_dbx_folder') || '/full_dataset';

const state = {
  folderKey:       '',
  sessionLabel:    '',
  annotator:       '',
  players:         {},   // { P1: 'Rafael Nadal', … }
  videos:          [],   // [{ camKey, url, wallClockMs, offsetMs, el }]
  refIdx:          0,    // index of the reference (latest-starting) video
  syncedDuration:  0,    // synced timeline length in seconds
  isSeeking:       false,
  calibrating:     false,
  calibrationLoaded: false,
  thumbsGenerated: false,
  annotations:     [],
  nextId:          1,
  pendingStart:    null, // synced ms
  pendingEnd:      null, // synced ms
  config:          null,
  // Click-to-annotate state
  focusIdx:          0,
  clickAnnotating:   false,
  clickCoords:       null,   // { x: 0-1, y: 0-1 }
  clickSyncedMs:     null,
  // Annotation replay loop state
  replayLoop:        null,   // { startSec, endSec, annotationId } or null
  replayInterval:    null,   // setInterval id for loop check
  _replayLoopId:     0,      // monotonic id to cancel stale callbacks
};

// ── Dropbox API helpers ─────────────────────────────────────
async function dbxPost(token, endpoint, body) {
  const res = await fetch(`https://api.dropboxapi.com/2${endpoint}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Dropbox API ${endpoint} failed: ${res.status} ${text}`);
  }
  return res.json();
}

async function dbxGetTemporaryLink(token, filePath) {
  const result = await dbxPost(token, '/files/get_temporary_link', { path: filePath });
  return result.link;
}

// ── Rosters ─────────────────────────────────────────────────
const rosters = {
  men: [
    { id: '1', name: 'Constantin Pradenne' },
    { id: '2', name: 'Nicholas Ciordas' },
    { id: '3', name: 'Michael Gao' },
    { id: '4', name: 'Soren Ghorai' },
    { id: '5', name: 'Eric He' },
    { id: '6', name: 'David Jin' },
    { id: '7', name: 'Tejas Ram' },
    { id: '8', name: 'Jan Safrata' },
    { id: '9', name: 'Marco Yang' },
    { id: '10', name: 'Andrew Zabelo' },
  ],
  women: [
    { id: '1', name: 'Carissa Gerung' },
    { id: '2', name: 'Polaris Hayes' },
    { id: '3', name: 'Naya Kessman' },
    { id: '4', name: 'Aoi Kunimoto' },
    { id: '5', name: 'Anna Piland' },
    { id: '6', name: 'Hannah Ramsperger' },
    { id: '7', name: 'Anna Szczuka' },
    { id: '8', name: 'Katelyn Waugh' },
    { id: '9', name: 'Tara Zhan' },
  ],
};

function loadViewerRoster(team) {
  state.players = {};
  rosters[team].forEach(p => {
    state.players[p.id] = p.name;
  });
  // Re-populate the player dropdown in the annotation form if config is loaded
  if (state.config) populateFormDropdowns();
}

// ── Boot ────────────────────────────────────────────────────
(async function init() {
  const params = new URLSearchParams(window.location.search);
  state.folderKey = params.get('session') || '';

  if (!state.folderKey) {
    setStatus('No session specified. <a href="home.html">Go back</a>.');
    return;
  }

  state.annotator = params.get('annotator') || '';

  // Default to men's roster; wire up the roster switcher
  const rosterSelect = document.getElementById('viewer-roster-select');
  const initialTeam = params.get('team') || 'men';
  rosterSelect.value = initialTeam;
  loadViewerRoster(initialTeam);

  rosterSelect.addEventListener('change', () => {
    loadViewerRoster(rosterSelect.value);
  });

  // Config: actions are hardcoded, token comes from sessionStorage
  const config = {
    actions: ['forehand', 'backhand', 'serve', 'volley', 'overhead', 'drop_shot', 'lob'],
  };
  state.config = config;

  const DROPBOX_TOKEN = getDropboxToken();

  if (!DROPBOX_TOKEN) {
    setStatus('No Dropbox token found in config.json.');
    return;
  }

  // Set session title
  state.sessionLabel = state.folderKey;
  document.getElementById('session-title').textContent = state.folderKey;
  document.title = `${state.folderKey} — CalTen`;

  // Populate form dropdowns
  populateFormDropdowns();

  // Fetch all files from session folder
  setStatus('Loading session from Dropbox…');
  const folderPath = `${DROPBOX_FOLDER}/${state.folderKey}`;
  let folderEntries;
  try {
    const result = await dbxPost(DROPBOX_TOKEN, '/files/list_folder', { path: folderPath });
    folderEntries = result.entries;
  } catch (e) {
    setStatus(`Failed to load session folder from Dropbox: ${e.message}`);
    return;
  }

  // Find .MOV video files only
  const videoFiles = folderEntries
    .filter(e => e['.tag'] === 'file' && /\.mov$/i.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (videoFiles.length === 0) {
    setStatus('No video files found in this session folder.');
    return;
  }

  // Load existing annotation JSON if present
  const annotationFile = folderEntries
    .filter(e => e['.tag'] === 'file' && /annotations.*\.json$/i.test(e.name))
    .sort((a, b) => b.name.localeCompare(a.name))[0];

  if (annotationFile) {
    try {
      setStatus('Loading existing annotations…');
      const link = await dbxGetTemporaryLink(DROPBOX_TOKEN, annotationFile.path_display);
      const data = await fetch(link).then(r => r.json());
      if (Array.isArray(data.annotations) && data.annotations.length > 0) {
        data.annotations.forEach(a => {
          state.annotations.push(a);
          if (a.id >= state.nextId) state.nextId = a.id + 1;
        });
        renderAnnotationList();
      }
    } catch (err) {
      console.warn('Could not load existing annotations:', err);
    }
  }

  // Get temporary streaming links for all videos
  setStatus(`Getting streaming links for ${videoFiles.length} videos…`);
  let parsed;
  try {
    parsed = await Promise.all(videoFiles.map(async (vf) => {
      const url = await dbxGetTemporaryLink(DROPBOX_TOKEN, vf.path_display);
      return { camKey: vf.name, url, filename: vf.name, ...parseFilename(vf.name) };
    }));
  } catch (e) {
    setStatus(`Failed to get video links: ${e.message}`);
    return;
  }

  const offsets = calcOffsets(parsed);
  state.videos = parsed.map((v, i) => ({ ...v, offsetMs: offsets[i], calibrationMs: 0 }));
  state.refIdx = offsets.indexOf(0);

  // Load saved calibration if present
  const calibrationFile = folderEntries
    .filter(e => e['.tag'] === 'file' && /calibration\.json$/i.test(e.name))[0];

  if (calibrationFile) {
    try {
      const link = await dbxGetTemporaryLink(DROPBOX_TOKEN, calibrationFile.path_display);
      const calData = await fetch(link).then(r => r.json());
      if (calData.calibration) {
        state.videos.forEach(v => {
          if (calData.calibration[v.filename] !== undefined) {
            v.calibrationMs = calData.calibration[v.filename];
          }
        });
        state.calibrationLoaded = true;
      }
    } catch (err) {
      console.warn('Could not load calibration:', err);
    }
  }

  // Build video tiles
  buildVideoGrid();

  // Wire playback controls
  wireControls();

  setStatus('');
})();

// ── Step 5: Filename parsing & sync ─────────────────────────

/**
 * Extract wall-clock start time and direction from a filename.
 *
 * Format: MM_DD_YYYY_HH_MM_SS_ms_{courtNum}_{direction}_{camNum}_{endHH}_{endMM}_{endSS}_{endMs}.MOV
 * Example: 02_25_2026_16_26_53_000_5_W_02_18_32_06_375.MOV
 */
function parseFilename(filenameOrUrl) {
  // Handle both raw filenames and URLs
  const withoutQuery = filenameOrUrl.split('?')[0];
  const filename = withoutQuery.split('/').pop();
  const base = filename.replace(/\.MOV$/i, '');
  const parts = base.split('_');

  // indices: 0=MM 1=DD 2=YYYY 3=HH 4=MM 5=SS 6=ms 7=courtNum 8=direction
  const hh   = parseInt(parts[3], 10) || 0;
  const mm   = parseInt(parts[4], 10) || 0;
  const ss   = parseInt(parts[5], 10) || 0;
  const ms   = parseInt(parts[6], 10) || 0;
  const courtNum = parts[7] || '';
  const direction = parts[8] || '';

  const wallClockMs = ((hh * 3600) + (mm * 60) + ss) * 1000 + ms;

  const directionLabels = {
    'W': 'West',
    'E': 'East',
    'N': 'North',
    'S': 'South',
    'NW': 'Northwest',
    'NE': 'Northeast',
    'SW': 'Southwest',
    'SE': 'Southeast'
  };
  const label = directionLabels[direction] || direction;

  return { wallClockMs, direction, courtNum, label };
}

/**
 * Given array of { wallClockMs }, return array of offsetMs.
 * The latest-starting camera has offset 0; earlier ones get a positive offset
 * so they seek forward to the same real-world moment.
 */
function calcOffsets(parsedVideos) {
  const maxStartMs = Math.max(...parsedVideos.map(v => v.wallClockMs));
  return parsedVideos.map(v => maxStartMs - v.wallClockMs);
}

/** Total offset for a video: parsed offset + manual calibration adjustment. */
function totalOffsetSec(v) {
  return (v.offsetMs + v.calibrationMs) / 1000;
}

// ── Step 4 / 5: Build video grid ────────────────────────────
function buildVideoGrid() {
  const grid = document.getElementById('video-grid');
  grid.innerHTML = '';

  state.videos.forEach((v, i) => {
    const tile = document.createElement('div');
    tile.className = 'video-tile';

    const video = document.createElement('video');
    video.src = v.url;
    video.preload = 'auto';
    video.playsInline = true;
    video.controls = false;
    // Store reference
    v.el = video;

    // Volume strip
    const volStrip = document.createElement('div');
    volStrip.className = 'video-tile-volume';
    volStrip.innerHTML = `
      <span>Vol</span>
      <input type="range" min="0" max="1" step="0.05" value="0.5" />
    `;
    volStrip.querySelector('input').addEventListener('input', e => {
      video.volume = parseFloat(e.target.value);
    });
    video.volume = 0.5;

    // Label overlay
    const labelEl = document.createElement('div');
    labelEl.className = 'video-tile-label';
    labelEl.textContent = v.label;

    // Minimize button
    const minBtn = document.createElement('button');
    minBtn.className = 'video-tile-minimize';
    minBtn.title = 'Minimize';
    minBtn.textContent = '−';
    minBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      minimizeVideo(i);
    });

    tile.appendChild(video);
    tile.appendChild(labelEl);
    tile.appendChild(minBtn);
    tile.appendChild(volStrip);
    tile.dataset.videoIdx = i;
    grid.appendChild(tile);

    // Click-to-annotate: click on video tile to start annotation flow
    tile.addEventListener('click', (e) => {
      if (state.calibrating) return;
      // Don't trigger on volume strip interactions
      if (e.target.closest('.video-tile-volume')) return;
      handleVideoTileClick(e, i);
    });

    // Apply offset once metadata is available
    video.addEventListener('loadedmetadata', () => {
      video.currentTime = totalOffsetSec(v);
      // After all videos have metadata, compute synced duration and build scrubber (once only)
      if (!state.thumbsGenerated && state.videos.every(sv => sv.el && sv.el.readyState >= 1)) {
        state.thumbsGenerated = true;
        computeSyncedDuration();
        updateSeekSlider();
        if (state.calibrationLoaded) {
          // Calibration already loaded from Dropbox — skip UI, just seek to start
          seekAll(0);
          setStatus('Calibration loaded from saved data.');
          setTimeout(() => setStatus(''), 2000);
        } else {
          showCalibration();
        }
      }
    });

    // Keep play button label in sync when a video ends naturally
    video.addEventListener('ended', () => {
      document.getElementById('btn-play').textContent = 'Play';
    });
  });

  // Set initial grid layout class
  updateGridLayout();
}

function computeSyncedDuration() {
  // Synced duration = shortest available synced length across all videos
  let min = Infinity;
  state.videos.forEach(v => {
    const syncedLen = v.el.duration - totalOffsetSec(v);
    if (syncedLen < min) min = syncedLen;
  });
  state.syncedDuration = isFinite(min) ? min : 0;
  const slider = document.getElementById('seek-slider');
  slider.max = Math.floor(state.syncedDuration * 1000); // ms resolution
}

// ── Step 5: Sync helpers ─────────────────────────────────────

/** Current position on the synced timeline, in seconds. */
function getSyncedTime() {
  const ref = state.videos[state.refIdx];
  if (!ref || !ref.el) return 0;
  return ref.el.currentTime - totalOffsetSec(ref);
}

/** Seek all videos to a given synced position (in seconds). */
function seekAll(syncedSec) {
  state.isSeeking = true;

  // Always pause on seek
  state.videos.forEach(v => v.el && v.el.pause());
  document.getElementById('btn-play').textContent = 'Play';

  state.videos.forEach(v => {
    const target = syncedSec + totalOffsetSec(v);
    v.el.currentTime = Math.max(0, Math.min(target, v.el.duration || Infinity));
  });
  updateTimeDisplay(syncedSec);
  setTimeout(() => { state.isSeeking = false; }, 50);
}

/** Format seconds → HH:MM:SS.mmm */
function formatTime(sec) {
  const totalMs = Math.round(sec * 1000);
  const ms  = totalMs % 1000;
  const s   = Math.floor(totalMs / 1000) % 60;
  const m   = Math.floor(totalMs / 60000) % 60;
  const h   = Math.floor(totalMs / 3600000);
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}.${pad3(ms)}`;
}

function pad2(n) { return String(n).padStart(2, '0'); }
function pad3(n) { return String(n).padStart(3, '0'); }

function updateTimeDisplay(syncedSec) {
  document.getElementById('time-display').textContent = formatTime(syncedSec);
}

function updateSeekSlider() {
  if (state.isSeeking) return;
  const slider = document.getElementById('seek-slider');
  const t = getSyncedTime();
  slider.value = Math.round(t * 1000);
  updateTimeDisplay(t);
}

// ── Step 6: Playback controls ────────────────────────────────
function wireControls() {
  // Play / Pause
  const btnPlay = document.getElementById('btn-play');
  btnPlay.addEventListener('click', togglePlay);

  // Timeupdate on reference video
  const refEl = () => state.videos[state.refIdx]?.el;
  // Poll since timeupdate may not fire for all videos
  setInterval(() => {
    if (!state.isSeeking && refEl() && !refEl().paused) {
      updateSeekSlider();
      correctDrift();
    }
  }, 100);

  // Seek slider
  const slider = document.getElementById('seek-slider');
  const seekTooltip = document.getElementById('seek-tooltip');

  slider.addEventListener('input', () => {
    if (state.replayLoop) stopReplayLoop();
    seekAll(parseInt(slider.value, 10) / 1000);
  });

  // Show time tooltip on hover
  slider.addEventListener('mousemove', e => {
    const rect = slider.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    const maxMs = parseInt(slider.max, 10) || 0;
    const hoverSec = (pct * maxMs) / 1000;
    seekTooltip.textContent = formatTime(Math.max(0, hoverSec));
    // Position tooltip centered on cursor
    const tipWidth = seekTooltip.offsetWidth;
    let left = e.clientX - rect.left - tipWidth / 2;
    left = Math.max(0, Math.min(left, rect.width - tipWidth));
    seekTooltip.style.left = left + 'px';
    seekTooltip.classList.add('visible');
  });

  slider.addEventListener('mouseleave', () => {
    seekTooltip.classList.remove('visible');
  });

  // Speed buttons
  document.querySelectorAll('.btn-speed').forEach(btn => {
    btn.addEventListener('click', () => {
      const rate = parseFloat(btn.dataset.speed);
      state.videos.forEach(v => { v.el.playbackRate = rate; });
      document.querySelectorAll('.btn-speed').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    // Ignore when focus is on an input/textarea/select
    if (['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)) return;

    // Calibration mode: arrow keys step frames on focused tile
    if (state.calibrating) {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        stepFrame(state.calibrationFocusIdx, -1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        stepFrame(state.calibrationFocusIdx, 1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        hideCalibration();
      }
      return; // Block all other shortcuts during calibration
    }

    // Stop replay loop on Escape
    if (state.replayLoop && e.key === 'Escape') {
      e.preventDefault();
      stopReplayLoop();
      return;
    }

    // Click-to-annotate mode
    if (state.clickAnnotating) {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancelClickAnnotation();
        return;
      }
      // Arrow keys: step frames (only before start is marked, or after end is marked for adjustment)
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        clickAnnotateStepFrame(-1);
        return;
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        clickAnnotateStepFrame(1);
        return;
      }
      // S: mark start (only if not already marked)
      if ((e.key === 's' || e.key === 'S') && state.pendingStart === null) {
        e.preventDefault();
        clickAnnotateMarkStart();
        return;
      }
      // E: mark end (only after start is marked)
      if ((e.key === 'e' || e.key === 'E') && state.pendingStart !== null && state.pendingEnd === null) {
        e.preventDefault();
        clickAnnotateMarkEnd();
        return;
      }
      // Space: toggle play/pause (after start is marked, before end is marked)
      if (e.key === ' ' && state.pendingStart !== null && state.pendingEnd === null) {
        e.preventDefault();
        clickAnnotateTogglePlay();
        return;
      }
      // Enter: confirm (after both marked)
      if (e.key === 'Enter') {
        e.preventDefault();
        confirmClickAnnotateRange();
        return;
      }
      return;
    }

    // Enter confirms annotation when form is visible
    if (e.key === 'Enter') {
      const form = document.getElementById('annotation-form');
      if (form && !form.classList.contains('hidden')) {
        e.preventDefault();
        confirmAnnotation();
        return;
      }
    }
    if (e.key === 's' || e.key === 'S') markStart();
    if (e.key === 'e' || e.key === 'E') markEnd();
    if (e.key === ' ') { e.preventDefault(); togglePlay(); }
  });

  // Annotation form buttons
  document.getElementById('btn-mark-start').addEventListener('click', markStart);
  document.getElementById('btn-mark-end').addEventListener('click', markEnd);
  document.getElementById('btn-confirm').addEventListener('click', confirmAnnotation);
  document.getElementById('btn-cancel').addEventListener('click', cancelAnnotation);

  // Save to Dropbox button
  document.getElementById('btn-save-dropbox').addEventListener('click', saveToDropbox);

  // Calibration buttons
  document.getElementById('btn-confirm-calibration').addEventListener('click', hideCalibration);
  document.getElementById('btn-recalibrate').addEventListener('click', showCalibration);

  // Info modal
  const infoModal = document.getElementById('info-modal');
  document.getElementById('btn-info').addEventListener('click', () => {
    infoModal.classList.remove('hidden');
  });
  document.getElementById('btn-info-close').addEventListener('click', () => {
    infoModal.classList.add('hidden');
  });
  infoModal.addEventListener('click', (e) => {
    if (e.target === infoModal) infoModal.classList.add('hidden');
  });
}

function togglePlay() {
  if (state.calibrating || state.clickAnnotating) return;
  // If replay loop is active, stop it on manual play/pause
  if (state.replayLoop) {
    stopReplayLoop();
    return;
  }
  const videos = state.videos.map(v => v.el).filter(Boolean);
  if (videos.length === 0) return;
  const anyPlaying = videos.some(v => !v.paused);
  if (anyPlaying) {
    videos.forEach(v => v.pause());
    document.getElementById('btn-play').textContent = 'Play';
  } else {
    syncedPlay(videos);
  }
}

/** Cancel token for syncedPlay buffering loop */
let _syncedPlayId = 0;

/**
 * Wait for all videos to be buffered enough, re-align,
 * then start them in a single requestAnimationFrame for tight sync.
 */
function syncedPlay(videos) {
  const playId = ++_syncedPlayId;
  const btn = document.getElementById('btn-play');

  // Re-align all videos to the current synced position
  const syncedSec = getSyncedTime();
  state.videos.forEach(v => {
    const target = syncedSec + totalOffsetSec(v);
    v.el.currentTime = Math.max(0, Math.min(target, v.el.duration || Infinity));
  });

  // Check if all videos are ready to play
  if (!videos.every(v => v.readyState >= 3)) {
    btn.textContent = 'Buffering…';
    btn.disabled = true;

    function checkReady() {
      // Abort if a newer syncedPlay call was made or videos were paused
      if (_syncedPlayId !== playId) return;
      if (videos.every(v => v.readyState >= 3)) {
        btn.textContent = 'Play';
        btn.disabled = false;
        if (_syncedPlayId !== playId) return;
        requestAnimationFrame(() => {
          if (_syncedPlayId !== playId) return;
          videos.forEach(v => v.play().catch(() => {}));
          btn.textContent = 'Pause';
        });
      } else {
        setTimeout(checkReady, 50);
      }
    }
    checkReady();
    return;
  }

  // All ready — fire all play() calls in one rAF for tightest sync
  requestAnimationFrame(() => {
    if (_syncedPlayId !== playId) return;
    videos.forEach(v => v.play().catch(() => {}));
    btn.textContent = 'Pause';
  });
}

/** Cancel any pending syncedPlay buffering loop */
function cancelSyncedPlay() {
  _syncedPlayId++;
}

/** Periodic drift correction — called from the poll interval in wireControls */
function correctDrift() {
  const ref = state.videos[state.refIdx];
  if (!ref || !ref.el || ref.el.paused) return;
  const refSynced = ref.el.currentTime - totalOffsetSec(ref);

  state.videos.forEach((v, i) => {
    if (i === state.refIdx || !v.el || v.el.paused) return;
    const expected = refSynced + totalOffsetSec(v);
    const drift = v.el.currentTime - expected;
    // If drift exceeds 150ms, nudge the video back into sync
    if (Math.abs(drift) > 0.15) {
      v.el.currentTime = expected;
    }
  });
}

function pauseAll() {
  state.videos.forEach(v => v.el.pause());
  document.getElementById('btn-play').textContent = 'Play';
}

// ── Calibration system ──────────────────────────────────────
const FRAME_MS = 1000 / 60; // ~16.67ms per frame at 60fps

function showCalibration() {
  state.calibrating = true;

  // Snapshot old ref calibration so we can adjust annotations on confirm
  const ref = state.videos[state.refIdx];
  state.oldRefCalibrationMs = ref ? ref.calibrationMs : 0;

  // Pause all videos
  pauseAll();

  // Show calibration banner
  document.getElementById('calibration-bar').classList.remove('hidden');

  // Disable playback and annotation controls
  document.getElementById('btn-play').disabled = true;
  document.getElementById('btn-mark-start').disabled = true;
  document.getElementById('btn-mark-end').disabled = true;

  // Add calibration overlay to each video tile
  const tiles = document.querySelectorAll('.video-tile');
  tiles.forEach((tile, i) => {
    // Remove any existing calibration overlay
    const existing = tile.querySelector('.calibration-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.className = 'calibration-overlay';

    const frames = Math.round(state.videos[i].calibrationMs / FRAME_MS);
    const ms = Math.round(state.videos[i].calibrationMs);

    overlay.innerHTML = `
      <button class="cal-btn cal-prev" data-idx="${i}" data-dir="-1">&larr; -1f</button>
      <span class="cal-readout" id="cal-readout-${i}">${formatCalibration(frames, ms)}</span>
      <button class="cal-btn cal-next" data-idx="${i}" data-dir="1">+1f &rarr;</button>
    `;
    tile.appendChild(overlay);

    // Wire button clicks
    overlay.querySelectorAll('.cal-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.idx, 10);
        const dir = parseInt(btn.dataset.dir, 10);
        stepFrame(idx, dir);
      });
    });

    // Track which tile was last clicked for keyboard stepping
    tile.addEventListener('click', () => {
      state.calibrationFocusIdx = i;
      tiles.forEach(t => t.classList.remove('cal-focused'));
      tile.classList.add('cal-focused');
    });
  });

  // Default focus to first tile
  state.calibrationFocusIdx = 0;
  if (tiles.length > 0) tiles[0].classList.add('cal-focused');
}

function hideCalibration() {
  state.calibrating = false;

  // Hide calibration banner
  document.getElementById('calibration-bar').classList.add('hidden');

  // Re-enable controls
  document.getElementById('btn-play').disabled = false;
  document.getElementById('btn-mark-start').disabled = false;
  document.getElementById('btn-mark-end').disabled = false;

  // Remove calibration overlays
  document.querySelectorAll('.calibration-overlay').forEach(el => el.remove());
  document.querySelectorAll('.video-tile').forEach(t => t.classList.remove('cal-focused'));

  // Adjust existing annotation times if the reference video's calibration changed
  const ref = state.videos[state.refIdx];
  const newRefCal = ref ? ref.calibrationMs : 0;
  const deltaSec = (state.oldRefCalibrationMs - newRefCal) / 1000;
  if (deltaSec !== 0 && state.annotations.length > 0) {
    state.annotations.forEach(a => {
      const startSec = timeStringToSeconds(a.start_time) + deltaSec;
      const endSec = timeStringToSeconds(a.end_time) + deltaSec;
      a.start_time = formatTime(Math.max(0, startSec));
      a.end_time = formatTime(Math.max(0, endSec));
    });
    renderAnnotationList();
  }

  // Recompute synced duration with new calibration offsets
  computeSyncedDuration();
  seekAll(0);

  // Save calibration to Dropbox
  saveCalibrationToDropbox();
}

function stepFrame(videoIndex, direction) {
  const v = state.videos[videoIndex];
  if (!v || !v.el) return;

  v.calibrationMs += direction * FRAME_MS;
  v.el.currentTime += direction * (FRAME_MS / 1000);

  // Update readout
  const frames = Math.round(v.calibrationMs / FRAME_MS);
  const ms = Math.round(v.calibrationMs);
  const readout = document.getElementById(`cal-readout-${videoIndex}`);
  if (readout) readout.textContent = formatCalibration(frames, ms);
}

function formatCalibration(frames, ms) {
  const sign = frames >= 0 ? '+' : '';
  return `${sign}${frames}f (${sign}${ms}ms)`;
}

async function saveCalibrationToDropbox() {
  const token = getDropboxToken();
  if (!token) return;

  const calibration = {};
  state.videos.forEach(v => {
    calibration[v.filename] = v.calibrationMs;
  });

  const data = JSON.stringify({
    session: state.folderKey,
    saved_at: new Date().toISOString(),
    calibration: calibration,
  }, null, 2);

  const path = `${DROPBOX_FOLDER}/${state.folderKey}/${state.folderKey}_calibration.json`;

  try {
    await dbxUpload(token, path, data);
    setStatus('Calibration saved.');
    setTimeout(() => setStatus(''), 2000);
  } catch (err) {
    console.warn('Could not save calibration:', err);
    setStatus('Failed to save calibration.');
    setTimeout(() => setStatus(''), 3000);
  }
}

// ── Step 8: Annotation system ────────────────────────────────
function markStart() {
  state.pendingStart = getSyncedTime() * 1000; // store as ms
  state.pendingEnd   = null;
  document.getElementById('display-start').textContent = formatTime(state.pendingStart / 1000);
  document.getElementById('display-end').textContent   = '—';
  document.getElementById('btn-mark-start').classList.add('active');
  document.getElementById('btn-mark-end').classList.remove('active');
  hideAnnotationForm();
}

function markEnd() {
  if (state.pendingStart === null) {
    markStart();
    return;
  }
  state.pendingEnd = getSyncedTime() * 1000;
  // Swap if end < start
  if (state.pendingEnd < state.pendingStart) {
    [state.pendingStart, state.pendingEnd] = [state.pendingEnd, state.pendingStart];
  }
  document.getElementById('display-end').textContent = formatTime(state.pendingEnd / 1000);
  document.getElementById('btn-mark-end').classList.add('active');
  showAnnotationForm();
}

function showAnnotationForm() {
  document.getElementById('annotation-form').classList.remove('hidden');
  document.getElementById('form-player').focus();
}

function hideAnnotationForm() {
  document.getElementById('annotation-form').classList.add('hidden');
  document.getElementById('form-notes').value = '';
  document.getElementById('form-drill').value = '';
  document.getElementById('form-perfect').checked = false;
}

function populateFormDropdowns() {
  // Build player <select>
  const playerSelect = document.getElementById('form-player');
  playerSelect.innerHTML = '';
  Object.keys(state.players).forEach(pid => {
    const name = state.players[pid] || '';
    const opt = document.createElement('option');
    opt.value = pid;
    opt.textContent = name ? `${pid} — ${name}` : pid;
    playerSelect.appendChild(opt);
  });

  // Build action <select>
  const actionSelect = document.getElementById('form-action');
  actionSelect.innerHTML = '';
  const noneOpt = document.createElement('option');
  noneOpt.value = '';
  noneOpt.textContent = '— None —';
  actionSelect.appendChild(noneOpt);
  state.config.actions.forEach(action => {
    const opt = document.createElement('option');
    opt.value = action;
    opt.textContent = action.replace(/_/g, ' ');
    actionSelect.appendChild(opt);
  });

  // Enter on player select → move focus to action select
  playerSelect.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      actionSelect.focus();
    }
  });

  // Enter on action select → confirm annotation
  actionSelect.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      confirmAnnotation();
    }
  });
}

function confirmAnnotation() {
  if (state.pendingStart === null || state.pendingEnd === null) return;

  const playerId   = document.getElementById('form-player').value;
  const playerName = state.players[playerId] || '';
  const actionId   = document.getElementById('form-action').value;
  const drill      = document.getElementById('form-drill').value;
  const notes      = document.getElementById('form-notes').value.trim();
  const perfect    = document.getElementById('form-perfect').checked;

  const wasClickAnnotation = state.clickAnnotating;
  const resumeMs = state.pendingEnd;

  const annotation = {
    id:          state.nextId++,
    start_time:  formatTime(state.pendingStart / 1000),
    end_time:    formatTime(state.pendingEnd   / 1000),
    player_id:   playerId,
    player_name: playerName,
    action_id:   actionId,
    drill:       drill,
    perfect:     perfect,
    notes:       notes,
    annotator:   state.annotator,
    created_at:  new Date().toISOString().replace(/\.\d{3}Z$/, ''),
    session:     state.folderKey,
  };

  // Add click coordinates if this was a click-to-annotate flow
  if (state.clickCoords) {
    annotation.click_x = Math.round(state.clickCoords.x * 10000) / 10000;
    annotation.click_y = Math.round(state.clickCoords.y * 10000) / 10000;
    annotation.click_time = formatTime(state.clickSyncedMs / 1000);
    annotation.click_video = state.videos[state.focusIdx]?.filename || '';
  }

  state.annotations.push(annotation);
  renderAnnotationList();

  // Reset state
  state.pendingStart = null;
  state.pendingEnd   = null;
  document.getElementById('display-start').textContent = '—';
  document.getElementById('display-end').textContent   = '—';
  document.getElementById('btn-mark-start').classList.remove('active');
  document.getElementById('btn-mark-end').classList.remove('active');
  hideAnnotationForm();

  // If click-to-annotate, clean up and auto-resume playback
  if (wasClickAnnotation) {
    removeClickMarker();
    state.clickAnnotating = false;
    state.clickCoords = null;
    state.clickSyncedMs = null;
    document.querySelectorAll('.video-tile').forEach(t => t.classList.remove('click-focused'));
    // Restore playback rate
    const activeSpeed = document.querySelector('.btn-speed.active');
    const rate = activeSpeed ? parseFloat(activeSpeed.dataset.speed) : 1;
    state.videos.forEach(v => { if (v.el) v.el.playbackRate = rate; });
    seekAll(resumeMs / 1000);
    setTimeout(() => {
      const videos = state.videos.map(v => v.el).filter(Boolean);
      syncedPlay(videos);
    }, 200);
  }
}

function cancelAnnotation() {
  const wasClick = state.clickAnnotating;
  state.pendingStart = null;
  state.pendingEnd   = null;
  document.getElementById('display-start').textContent = '—';
  document.getElementById('display-end').textContent   = '—';
  document.getElementById('btn-mark-start').classList.remove('active');
  document.getElementById('btn-mark-end').classList.remove('active');
  hideAnnotationForm();

  // If click-to-annotate, clean up and resume playback
  if (wasClick) {
    removeClickMarker();
    state.clickAnnotating = false;
    state.clickCoords = null;
    state.clickSyncedMs = null;
    document.querySelectorAll('.video-tile').forEach(t => t.classList.remove('click-focused'));
    setTimeout(() => {
      const videos = state.videos.map(v => v.el).filter(Boolean);
      syncedPlay(videos);
    }, 200);
  }
}

function deleteAnnotation(id) {
  state.annotations = state.annotations.filter(a => a.id !== id);
  renderAnnotationList();
}

function renderAnnotationList() {
  const list  = document.getElementById('annotation-list');
  const count = document.getElementById('annotation-count');
  count.textContent = state.annotations.length;

  if (state.annotations.length === 0) {
    list.innerHTML = '<div class="empty-state">No annotations yet.<br>Click on a video to annotate, or press S for drill annotations.</div>';
    return;
  }

  list.innerHTML = '';
  // Show newest first
  [...state.annotations].reverse().forEach(a => {
    const row = document.createElement('div');
    row.className = `annotation-row action-${a.action_id}`;
    row.innerHTML = `
      <div class="annotation-row-body">
        <div class="annotation-row-times">${a.start_time} → ${a.end_time}${a.click_time ? ` <span class="annotation-row-clicktime">click @ ${a.click_time}</span>` : ''}</div>
        <div class="annotation-row-meta">
          <span class="annotation-row-player">${a.player_id}${a.player_name ? ' — ' + a.player_name : ''}</span>
          <span class="annotation-row-action badge-${a.action_id}">${a.action_id.replace(/_/g,' ')}</span>
          ${a.drill ? `<span class="annotation-row-drill">${a.drill.replace(/_/g,' ')}</span>` : ''}
          ${a.perfect ? '<span class="annotation-row-perfect">Perfect</span>' : ''}
          ${a.annotator ? `<span class="annotation-row-annotator">by ${escapeHtml(a.annotator)}</span>` : ''}
        </div>
        ${a.notes ? `<div class="annotation-row-notes">${escapeHtml(a.notes)}</div>` : ''}
      </div>
      <button class="btn btn-danger" data-id="${a.id}">✕</button>
    `;

    // Click annotation row to start replay loop
    row.addEventListener('click', e => {
      if (e.target.closest('.btn-danger')) return;
      const startSec = timeStringToSeconds(a.start_time);
      const endSec = timeStringToSeconds(a.end_time);
      startReplayLoop(startSec, endSec, a.id);
    });

    row.querySelector('.btn-danger').addEventListener('click', () => deleteAnnotation(a.id));
    list.appendChild(row);
  });
}

function timeStringToSeconds(str) {
  // HH:MM:SS.mmm
  const [hms, msStr] = str.split('.');
  const [h, m, s] = hms.split(':').map(Number);
  return h * 3600 + m * 60 + s + (parseInt(msStr || '0', 10) / 1000);
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Annotation replay loop ──────────────────────────────────

function startReplayLoop(startSec, endSec, annotationId) {
  // If already looping same annotation, stop it
  if (state.replayLoop && state.replayLoop.annotationId === annotationId) {
    stopReplayLoop();
    return;
  }

  // Stop any existing loop first
  if (state.replayLoop) stopReplayLoop();

  // Cancel any click-annotating in progress
  if (state.clickAnnotating) cancelClickAnnotation();

  state.replayLoop = { startSec, endSec, annotationId };

  // Seek to start and play
  seekAll(startSec);
  showReplayBar(startSec, endSec);

  // Start playing after a short delay for seek to settle
  setTimeout(() => {
    const videos = state.videos.map(v => v.el).filter(Boolean);
    syncedPlay(videos);
  }, 100);

  // Poll to check if we've reached the end → loop back
  const loopId = ++state._replayLoopId;
  state.replayInterval = setInterval(() => {
    if (!state.replayLoop || state._replayLoopId !== loopId) return;
    const current = getSyncedTime();
    if (current >= state.replayLoop.endSec) {
      seekAll(state.replayLoop.startSec);
      setTimeout(() => {
        if (!state.replayLoop || state._replayLoopId !== loopId) return;
        const videos = state.videos.map(v => v.el).filter(Boolean);
        syncedPlay(videos);
      }, 100);
    }
  }, 50);

  // Highlight the active annotation row
  document.querySelectorAll('.annotation-row').forEach(r => r.classList.remove('replay-active'));
  const rows = document.querySelectorAll('.annotation-row');
  rows.forEach(r => {
    const btn = r.querySelector('[data-id]');
    if (btn && parseInt(btn.dataset.id) === annotationId) {
      r.classList.add('replay-active');
    }
  });
}

function stopReplayLoop() {
  // Increment loop ID to cancel any pending setTimeout callbacks
  state._replayLoopId++;

  if (state.replayInterval) {
    clearInterval(state.replayInterval);
    state.replayInterval = null;
  }

  // Cancel any pending syncedPlay buffering loops
  cancelSyncedPlay();

  // Capture end position before clearing state
  const endSec = state.replayLoop ? state.replayLoop.endSec : null;

  state.replayLoop = null;

  // Remove UI first (before querying .btn-speed, since replay bar also has .btn-speed buttons)
  hideReplayBar();
  document.querySelectorAll('.annotation-row.replay-active').forEach(r => r.classList.remove('replay-active'));

  // Restore playback rate (query after replay bar is removed to avoid matching its speed buttons)
  const activeSpeed = document.querySelector('.btn-speed.active');
  const rate = activeSpeed ? parseFloat(activeSpeed.dataset.speed) : 1;
  state.videos.forEach(v => { if (v.el) v.el.playbackRate = rate; });

  // Seek to end of annotation and continue playing
  if (endSec !== null) {
    seekAll(endSec);
    setTimeout(() => {
      const videos = state.videos.map(v => v.el).filter(Boolean);
      syncedPlay(videos);
    }, 150);
  }
}

function showReplayBar(startSec, endSec) {
  hideReplayBar();
  const bar = document.createElement('div');
  bar.className = 'replay-bar';
  bar.id = 'replay-bar';
  bar.innerHTML = `
    <span class="replay-bar-label">Looping: ${formatTime(startSec)} → ${formatTime(endSec)}</span>
    <div class="replay-bar-controls">
      <button class="btn btn-speed replay-speed-btn" data-rspeed="0.25">0.25×</button>
      <button class="btn btn-speed replay-speed-btn" data-rspeed="0.5">0.5×</button>
      <button class="btn btn-speed replay-speed-btn active" data-rspeed="1">1×</button>
      <button class="btn btn-danger replay-stop-btn">Stop</button>
    </div>
  `;

  // Insert after status bar
  const statusBar = document.getElementById('status-bar');
  statusBar.parentNode.insertBefore(bar, statusBar.nextSibling);

  // Wire speed buttons
  bar.querySelectorAll('.replay-speed-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      bar.querySelectorAll('.replay-speed-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const speed = parseFloat(btn.dataset.rspeed);
      state.videos.forEach(v => { if (v.el) v.el.playbackRate = speed; });
    });
  });

  // Wire stop button
  bar.querySelector('.replay-stop-btn').addEventListener('click', stopReplayLoop);
}

function hideReplayBar() {
  const bar = document.getElementById('replay-bar');
  if (bar) bar.remove();
}

// ── Step 9b: Click-to-annotate system ────────────────────────

function computeVideoClickCoords(event, videoElement) {
  const rect = videoElement.getBoundingClientRect();
  const clickX = event.clientX - rect.left;
  const clickY = event.clientY - rect.top;
  const elemW = rect.width;
  const elemH = rect.height;
  const vidW = videoElement.videoWidth;
  const vidH = videoElement.videoHeight;
  if (!vidW || !vidH) return null;

  const elemAspect = elemW / elemH;
  const vidAspect = vidW / vidH;
  let renderW, renderH, offsetX, offsetY;

  if (vidAspect > elemAspect) {
    renderW = elemW;
    renderH = elemW / vidAspect;
    offsetX = 0;
    offsetY = (elemH - renderH) / 2;
  } else {
    renderH = elemH;
    renderW = elemH * vidAspect;
    offsetX = (elemW - renderW) / 2;
    offsetY = 0;
  }

  const relX = (clickX - offsetX) / renderW;
  const relY = (clickY - offsetY) / renderH;
  return {
    x: Math.max(0, Math.min(1, relX)),
    y: Math.max(0, Math.min(1, relY)),
  };
}

function handleVideoTileClick(event, tileIndex) {
  if (state.replayLoop) stopReplayLoop();
  if (state.clickAnnotating) return;
  const form = document.getElementById('annotation-form');
  if (form && !form.classList.contains('hidden')) return;
  const v = state.videos[tileIndex];
  if (!v || !v.el || v.el.readyState < 1) return;

  // Pause all videos
  state.videos.forEach(sv => sv.el && sv.el.pause());
  document.getElementById('btn-play').textContent = 'Play';

  // Capture click coords
  const coords = computeVideoClickCoords(event, v.el);
  if (!coords) return;

  state.clickAnnotating = true;
  state.clickCoords = coords;
  state.clickSyncedMs = getSyncedTime() * 1000;
  state.focusIdx = tileIndex;

  // Visual focus on clicked tile
  document.querySelectorAll('.video-tile').forEach(t => t.classList.remove('click-focused'));
  const tile = document.querySelector(`.video-tile[data-video-idx="${tileIndex}"]`);
  if (tile) tile.classList.add('click-focused');

  // Show red X marker at click position
  showClickMarker(tile, v.el, coords);

  showFrameStepperBar();
}

function showClickMarker(tile, videoEl, coords) {
  removeClickMarker();

  const marker = document.createElement('div');
  marker.className = 'click-marker';
  marker.id = 'click-marker';
  marker.textContent = '✕';
  tile.appendChild(marker);

  positionClickMarker(marker, videoEl, coords);

  // Allow repositioning by clicking on the video tile
  tile._clickMarkerHandler = (e) => {
    if (e.target.closest('.video-tile-volume')) return;
    if (e.target.closest('.click-marker')) return;
    const newCoords = computeVideoClickCoords(e, videoEl);
    if (newCoords) {
      state.clickCoords = newCoords;
      positionClickMarker(marker, videoEl, newCoords);
    }
  };
  tile.addEventListener('click', tile._clickMarkerHandler);
}

function positionClickMarker(marker, videoEl, coords) {
  const rect = videoEl.getBoundingClientRect();
  const tileRect = videoEl.closest('.video-tile').getBoundingClientRect();
  const vidW = videoEl.videoWidth;
  const vidH = videoEl.videoHeight;
  if (!vidW || !vidH) return;

  const elemW = rect.width;
  const elemH = rect.height;
  const elemAspect = elemW / elemH;
  const vidAspect = vidW / vidH;
  let renderW, renderH, offsetX, offsetY;

  if (vidAspect > elemAspect) {
    renderW = elemW;
    renderH = elemW / vidAspect;
    offsetX = 0;
    offsetY = (elemH - renderH) / 2;
  } else {
    renderH = elemH;
    renderW = elemH * vidAspect;
    offsetX = (elemW - renderW) / 2;
    offsetY = 0;
  }

  // Position relative to tile (video may have offset from tile due to flex layout)
  const videoOffsetTop = rect.top - tileRect.top;
  const videoOffsetLeft = rect.left - tileRect.left;

  const px = videoOffsetLeft + offsetX + coords.x * renderW;
  const py = videoOffsetTop + offsetY + coords.y * renderH;

  marker.style.left = px + 'px';
  marker.style.top = py + 'px';
}

function removeClickMarker() {
  const marker = document.getElementById('click-marker');
  if (marker) {
    const tile = marker.closest('.video-tile');
    if (tile && tile._clickMarkerHandler) {
      tile.removeEventListener('click', tile._clickMarkerHandler);
      delete tile._clickMarkerHandler;
    }
    marker.remove();
  }
}

function showFrameStepperBar() {
  hideFrameStepperBar();

  const bar = document.createElement('div');
  bar.className = 'frame-stepper-bar';
  bar.id = 'frame-stepper-bar';

  bar.innerHTML = `
    <div class="frame-stepper-hint" id="frame-stepper-hint">
      Step 1: Use ← → to find the start frame, then press <kbd>S</kbd> to mark start
    </div>
    <div class="frame-stepper-controls">
      <button class="btn btn-secondary" id="btn-step-back" title="Step back 1 frame (←)">◀ -1f</button>
      <span class="frame-stepper-time" id="frame-stepper-time">${formatTime(state.clickSyncedMs / 1000)}</span>
      <button class="btn btn-secondary" id="btn-step-fwd" title="Step forward 1 frame (→)">+1f ▶</button>
      <button class="btn btn-mark-start" id="btn-click-mark-start" title="Mark start (S)">Mark Start <kbd>S</kbd></button>
      <span class="frame-stepper-mark" id="frame-stepper-start">Start: —</span>
      <button class="btn btn-mark-end" id="btn-click-mark-end" disabled title="Mark end (E)">Mark End <kbd>E</kbd></button>
      <span class="frame-stepper-mark" id="frame-stepper-end">End: —</span>
      <button class="btn btn-primary" id="btn-click-confirm" disabled title="Confirm (Enter)">Confirm <kbd>Enter</kbd></button>
      <button class="btn btn-secondary" id="btn-click-cancel" title="Cancel (Esc)">Cancel <kbd>Esc</kbd></button>
    </div>
  `;

  const viewerLeft = document.querySelector('.viewer-left');
  const controlsBar = document.querySelector('.controls-bar');
  viewerLeft.insertBefore(bar, controlsBar);

  document.getElementById('btn-step-back').addEventListener('click', () => clickAnnotateStepFrame(-1));
  document.getElementById('btn-step-fwd').addEventListener('click', () => clickAnnotateStepFrame(1));
  document.getElementById('btn-click-mark-start').addEventListener('click', clickAnnotateMarkStart);
  document.getElementById('btn-click-mark-end').addEventListener('click', clickAnnotateMarkEnd);
  document.getElementById('btn-click-confirm').addEventListener('click', confirmClickAnnotateRange);
  document.getElementById('btn-click-cancel').addEventListener('click', cancelClickAnnotation);
}

function clickAnnotateTogglePlay() {
  const videos = state.videos.map(v => v.el).filter(Boolean);
  const anyPlaying = videos.some(v => !v.paused);
  if (anyPlaying) {
    videos.forEach(v => v.pause());
    document.getElementById('btn-play').textContent = 'Play';
  } else {
    // Resume at 0.5x
    videos.forEach(v => { v.playbackRate = 0.5; });
    syncedPlay(videos);
  }
}

function clickAnnotateStepFrame(direction) {
  const FRAME_STEP = 1 / 60; // ~16.67ms per frame at 60fps
  const syncedSec = getSyncedTime() + direction * FRAME_STEP;
  const clamped = Math.max(0, Math.min(syncedSec, state.syncedDuration));
  seekAll(clamped);
  // Update current time display in stepper
  const timeEl = document.getElementById('frame-stepper-time');
  if (timeEl) timeEl.textContent = formatTime(clamped);

  // If end is already marked, update it as user fine-tunes
  if (state.pendingEnd !== null) {
    state.pendingEnd = clamped * 1000;
    const el = document.getElementById('frame-stepper-end');
    if (el) el.textContent = 'End: ' + formatTime(clamped);
    // Auto-swap if end < start
    if (state.pendingStart !== null && state.pendingEnd < state.pendingStart) {
      [state.pendingStart, state.pendingEnd] = [state.pendingEnd, state.pendingStart];
      const startEl = document.getElementById('frame-stepper-start');
      if (startEl) startEl.textContent = 'Start: ' + formatTime(state.pendingStart / 1000);
      const endEl = document.getElementById('frame-stepper-end');
      if (endEl) endEl.textContent = 'End: ' + formatTime(state.pendingEnd / 1000);
    }
  }
}

function clickAnnotateMarkStart() {
  state.pendingStart = getSyncedTime() * 1000;
  const el = document.getElementById('frame-stepper-start');
  if (el) el.textContent = 'Start: ' + formatTime(state.pendingStart / 1000);
  document.getElementById('btn-click-mark-start')?.classList.add('active');

  // Enable Mark End button
  const endBtn = document.getElementById('btn-click-mark-end');
  if (endBtn) endBtn.disabled = false;

  // Update hint
  const hint = document.getElementById('frame-stepper-hint');
  if (hint) hint.innerHTML = 'Step 2: Playing at 0.5x — press <kbd>E</kbd> to mark end, <kbd>Space</kbd> to pause/resume';

  // Start playing at 0.5x speed
  state.videos.forEach(v => { if (v.el) v.el.playbackRate = 0.5; });
  const videos = state.videos.map(v => v.el).filter(Boolean);
  syncedPlay(videos);

  updateClickConfirmButton();
}

function clickAnnotateMarkEnd() {
  // Pause all videos
  state.videos.forEach(v => { if (v.el) v.el.pause(); });
  document.getElementById('btn-play').textContent = 'Play';

  state.pendingEnd = getSyncedTime() * 1000;
  // Auto-swap if end < start
  if (state.pendingStart !== null && state.pendingEnd < state.pendingStart) {
    [state.pendingStart, state.pendingEnd] = [state.pendingEnd, state.pendingStart];
    const startEl = document.getElementById('frame-stepper-start');
    if (startEl) startEl.textContent = 'Start: ' + formatTime(state.pendingStart / 1000);
  }
  const el = document.getElementById('frame-stepper-end');
  if (el) el.textContent = 'End: ' + formatTime(state.pendingEnd / 1000);
  document.getElementById('btn-click-mark-end')?.classList.add('active');

  // Update hint
  const hint = document.getElementById('frame-stepper-hint');
  if (hint) hint.innerHTML = 'Step 3: Use ← → to fine-tune end frame, then press <kbd>Enter</kbd> to confirm';

  updateClickConfirmButton();
}

function updateClickConfirmButton() {
  const btn = document.getElementById('btn-click-confirm');
  if (btn) btn.disabled = !(state.pendingStart !== null && state.pendingEnd !== null);
}

function confirmClickAnnotateRange() {
  if (state.pendingStart === null || state.pendingEnd === null) return;

  // Update the annotation panel displays
  document.getElementById('display-start').textContent = formatTime(state.pendingStart / 1000);
  document.getElementById('display-end').textContent = formatTime(state.pendingEnd / 1000);
  document.getElementById('btn-mark-start').classList.add('active');
  document.getElementById('btn-mark-end').classList.add('active');

  hideFrameStepperBar();
  showAnnotationForm();
}

function cancelClickAnnotation() {
  hideFrameStepperBar();
  removeClickMarker();
  state.clickAnnotating = false;
  state.clickCoords = null;
  state.clickSyncedMs = null;
  state.pendingStart = null;
  state.pendingEnd = null;
  document.querySelectorAll('.video-tile').forEach(t => t.classList.remove('click-focused'));

  // Restore playback rate to whatever speed button is active
  const activeSpeed = document.querySelector('.btn-speed.active');
  const rate = activeSpeed ? parseFloat(activeSpeed.dataset.speed) : 1;
  state.videos.forEach(v => { if (v.el) v.el.playbackRate = rate; });

  // Resume playback
  setTimeout(() => {
    const videos = state.videos.map(v => v.el).filter(Boolean);
    syncedPlay(videos);
  }, 200);
}

function hideFrameStepperBar() {
  const existing = document.getElementById('frame-stepper-bar');
  if (existing) existing.remove();
}

// ── Step 9c: Video minimize / restore ────────────────────────

function minimizeVideo(idx) {
  const grid = document.getElementById('video-grid');
  const tray = document.getElementById('minimized-tray');
  const tile = grid.querySelector(`.video-tile[data-video-idx="${idx}"]`);
  if (!tile) return;

  // Move tile to tray
  tile.classList.add('minimized');
  tray.appendChild(tile);

  // Create restore overlay
  const restore = document.createElement('div');
  restore.className = 'minimized-restore';
  restore.innerHTML = `<span class="minimized-label">${state.videos[idx].label}</span><button class="minimized-restore-btn" title="Restore">+</button>`;
  restore.querySelector('.minimized-restore-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    restoreVideo(idx);
  });
  // Also restore on clicking the minimized tile itself
  restore.addEventListener('click', (e) => {
    if (e.target.closest('.minimized-restore-btn')) return;
    restoreVideo(idx);
  });
  tile.appendChild(restore);

  updateGridLayout();
}

function restoreVideo(idx) {
  const grid = document.getElementById('video-grid');
  const tray = document.getElementById('minimized-tray');
  const tile = tray.querySelector(`.video-tile[data-video-idx="${idx}"]`);
  if (!tile) return;

  // Remove restore overlay
  const restore = tile.querySelector('.minimized-restore');
  if (restore) restore.remove();

  tile.classList.remove('minimized');

  // Re-insert in correct order
  const tiles = grid.querySelectorAll('.video-tile');
  let inserted = false;
  for (const existing of tiles) {
    if (parseInt(existing.dataset.videoIdx) > idx) {
      grid.insertBefore(tile, existing);
      inserted = true;
      break;
    }
  }
  if (!inserted) grid.appendChild(tile);

  updateGridLayout();
}

function updateGridLayout() {
  const grid = document.getElementById('video-grid');
  const tray = document.getElementById('minimized-tray');
  const activeCount = grid.querySelectorAll('.video-tile').length;
  const minimizedCount = tray.querySelectorAll('.video-tile').length;

  // Update grid columns/rows based on active count
  grid.classList.remove('grid-0', 'grid-1', 'grid-2', 'grid-3', 'grid-4');
  const layoutCount = Math.min(activeCount, 4);
  grid.classList.add(`grid-${layoutCount}`);

  // Force grid to recalculate by briefly toggling display
  grid.style.display = 'none';
  // eslint-disable-next-line no-unused-expressions
  grid.offsetHeight; // force reflow
  grid.style.display = '';

  // Show/hide tray
  if (minimizedCount > 0) {
    tray.classList.remove('hidden');
  } else {
    tray.classList.add('hidden');
  }
}

// ── Step 10: Save to Dropbox ────────────────────────────────
function csvEscape(val) {
  if (val.includes(',') || val.includes('"') || val.includes('\n')) {
    return '"' + val.replace(/"/g, '""') + '"';
  }
  return val;
}

async function dbxUpload(token, path, content) {
  const res = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Dropbox-API-Arg': JSON.stringify({
        path: path,
        mode: 'overwrite',
        autorename: false,
        mute: false,
      }),
      'Content-Type': 'application/octet-stream',
    },
    body: content,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Upload failed: ${res.status} ${text}`);
  }
  return res.json();
}

async function saveToDropbox() {
  if (state.annotations.length === 0) {
    setStatus('No annotations to save.');
    setTimeout(() => setStatus(''), 3000);
    return;
  }

  const token = getDropboxToken();
  if (!token) {
    setStatus('No Dropbox token available.');
    return;
  }

  const folderPath = `${DROPBOX_FOLDER}/${state.folderKey}`;

  // Build JSON (canonical format — this file gets auto-loaded next time)
  const jsonData = {
    session: state.folderKey,
    exported_at: new Date().toISOString(),
    annotations: state.annotations,
  };
  const jsonContent = JSON.stringify(jsonData, null, 2);
  const jsonPath = `${folderPath}/${state.folderKey}_annotations.json`;

  // Build CSV
  const cols = ['session','start_time','end_time','player_id','player_name','action_id','drill','perfect','notes','annotator','created_at','click_x','click_y','click_time','click_video'];
  const rows = [cols.join(',')];
  state.annotations.forEach(a => {
    rows.push(cols.map(c => csvEscape(String(a[c] ?? ''))).join(','));
  });
  const csvContent = rows.join('\n');
  const csvPath = `${folderPath}/${state.folderKey}_annotations.csv`;

  const btn = document.getElementById('btn-save-dropbox');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  setStatus('Uploading annotations to Dropbox…');

  try {
    await Promise.all([
      dbxUpload(token, jsonPath, jsonContent),
      dbxUpload(token, csvPath, csvContent),
    ]);
    setStatus(`Saved ${state.annotations.length} annotation(s) to Dropbox.`);
    btn.textContent = 'Saved ✓';
    setTimeout(() => {
      btn.textContent = 'Save to Dropbox';
      btn.disabled = false;
      setStatus('');
    }, 3000);
  } catch (e) {
    setStatus(`Failed to save: ${e.message}`);
    btn.textContent = 'Save to Dropbox';
    btn.disabled = false;
  }
}

// ── Utilities ────────────────────────────────────────────────
function setStatus(msg) {
  const bar = document.getElementById('status-bar');
  bar.innerHTML = msg;
  bar.style.display = msg ? '' : 'none';
}
