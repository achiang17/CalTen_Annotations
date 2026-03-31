/* ============================================================
   viewer.js — Sync engine, playback, annotations, export
   ============================================================ */

// ── Module state ────────────────────────────────────────────
const state = {
  folderKey:       '',
  sessionLabel:    '',
  players:         {},   // { P1: 'Rafael Nadal', … }
  videos:          [],   // [{ camKey, url, wallClockMs, offsetMs, el }]
  refIdx:          0,    // index of the reference (latest-starting) video
  syncedDuration:  0,    // synced timeline length in seconds
  isSeeking:       false,
  thumbsGenerated: false,
  annotations:     [],
  nextId:          1,
  pendingStart:    null, // synced ms
  pendingEnd:      null, // synced ms
  config:          null,
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
  const DROPBOX_FOLDER = '/full_dataset';

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

  // Fetch video files from Dropbox
  setStatus('Loading videos from Dropbox…');
  let videoFiles;
  try {
    const folderPath = `${DROPBOX_FOLDER}/${state.folderKey}`;
    const result = await dbxPost(DROPBOX_TOKEN, '/files/list_folder', { path: folderPath });
    videoFiles = result.entries
      .filter(e => e['.tag'] === 'file' && /\.mov$/i.test(e.name))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (e) {
    setStatus(`Failed to load session folder from Dropbox: ${e.message}`);
    return;
  }

  if (videoFiles.length === 0) {
    setStatus('No .MOV files found in this session folder.');
    return;
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
  state.videos = parsed.map((v, i) => ({ ...v, offsetMs: offsets[i] }));
  state.refIdx = offsets.indexOf(0);

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

    tile.appendChild(video);
    tile.appendChild(labelEl);
    tile.appendChild(volStrip);
    grid.appendChild(tile);

    // Apply offset once metadata is available
    video.addEventListener('loadedmetadata', () => {
      video.currentTime = v.offsetMs / 1000;
      // After all videos have metadata, compute synced duration and build scrubber (once only)
      if (!state.thumbsGenerated && state.videos.every(sv => sv.el && sv.el.readyState >= 1)) {
        state.thumbsGenerated = true;
        computeSyncedDuration();
        updateSeekSlider();
      }
    });

    // Keep play button label in sync when a video ends naturally
    video.addEventListener('ended', () => {
      document.getElementById('btn-play').textContent = 'Play';
    });
  });
}

function computeSyncedDuration() {
  // Synced duration = shortest available synced length across all videos
  let min = Infinity;
  state.videos.forEach(v => {
    const syncedLen = v.el.duration - (v.offsetMs / 1000);
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
  return ref.el.currentTime - (ref.offsetMs / 1000);
}

/** Seek all videos to a given synced position (in seconds). */
function seekAll(syncedSec) {
  state.isSeeking = true;

  // Always pause on seek
  state.videos.forEach(v => v.el && v.el.pause());
  document.getElementById('btn-play').textContent = 'Play';

  state.videos.forEach(v => {
    const target = syncedSec + (v.offsetMs / 1000);
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
}

function togglePlay() {
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

/**
 * Wait for all videos to be buffered enough, re-align,
 * then start them in a single requestAnimationFrame for tight sync.
 */
function syncedPlay(videos) {
  const btn = document.getElementById('btn-play');

  // Re-align all videos to the current synced position
  const syncedSec = getSyncedTime();
  state.videos.forEach(v => {
    const target = syncedSec + (v.offsetMs / 1000);
    v.el.currentTime = Math.max(0, Math.min(target, v.el.duration || Infinity));
  });

  // Check if all videos are ready to play
  if (!videos.every(v => v.readyState >= 3)) {
    btn.textContent = 'Buffering…';
    btn.disabled = true;

    function checkReady() {
      if (videos.every(v => v.readyState >= 3)) {
        btn.textContent = 'Play';
        btn.disabled = false;
      } else {
        setTimeout(checkReady, 50);
      }
    }
    checkReady();
    return;
  }

  // All ready — fire all play() calls in one rAF for tightest sync
  requestAnimationFrame(() => {
    videos.forEach(v => v.play().catch(() => {}));
    btn.textContent = 'Pause';
  });
}

/** Periodic drift correction — called from the poll interval in wireControls */
function correctDrift() {
  const ref = state.videos[state.refIdx];
  if (!ref || !ref.el || ref.el.paused) return;
  const refSynced = ref.el.currentTime - (ref.offsetMs / 1000);

  state.videos.forEach((v, i) => {
    if (i === state.refIdx || !v.el || v.el.paused) return;
    const expected = refSynced + (v.offsetMs / 1000);
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
  const notes      = document.getElementById('form-notes').value.trim();

  const annotation = {
    id:          state.nextId++,
    start_time:  formatTime(state.pendingStart / 1000),
    end_time:    formatTime(state.pendingEnd   / 1000),
    player_id:   playerId,
    player_name: playerName,
    action_id:   actionId,
    notes:       notes,
    created_at:  new Date().toISOString().replace(/\.\d{3}Z$/, ''),
    session:     state.folderKey,
  };

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
}

function cancelAnnotation() {
  state.pendingStart = null;
  state.pendingEnd   = null;
  document.getElementById('display-start').textContent = '—';
  document.getElementById('display-end').textContent   = '—';
  document.getElementById('btn-mark-start').classList.remove('active');
  document.getElementById('btn-mark-end').classList.remove('active');
  hideAnnotationForm();
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
    list.innerHTML = '<div class="empty-state">No annotations yet.<br>Press S to mark a start time.</div>';
    return;
  }

  list.innerHTML = '';
  // Show newest first
  [...state.annotations].reverse().forEach(a => {
    const row = document.createElement('div');
    row.className = `annotation-row action-${a.action_id}`;
    row.innerHTML = `
      <div class="annotation-row-body">
        <div class="annotation-row-times">${a.start_time} → ${a.end_time}</div>
        <div class="annotation-row-meta">
          <span class="annotation-row-player">${a.player_id}${a.player_name ? ' — ' + a.player_name : ''}</span>
          <span class="annotation-row-action badge-${a.action_id}">${a.action_id.replace(/_/g,' ')}</span>
        </div>
        ${a.notes ? `<div class="annotation-row-notes">${escapeHtml(a.notes)}</div>` : ''}
      </div>
      <button class="btn btn-danger" data-id="${a.id}">✕</button>
    `;

    // Seek to annotation start on row click (but not delete button)
    row.addEventListener('click', e => {
      if (e.target.closest('.btn-danger')) return;
      const startSec = timeStringToSeconds(a.start_time);
      seekAll(startSec);
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

// ── Step 9: Load existing annotations ───────────────────────
async function loadExistingAnnotations(url) {
  if (!url) return;
  try {
    const data = await fetch(url).then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    });
    if (Array.isArray(data.annotations) && data.annotations.length > 0) {
      // Merge, advancing nextId past any loaded ids
      data.annotations.forEach(a => {
        state.annotations.push(a);
        if (a.id >= state.nextId) state.nextId = a.id + 1;
      });
      renderAnnotationList();
      setStatus(`Loaded ${data.annotations.length} existing annotation(s).`);
      setTimeout(() => setStatus(''), 3000);
    }
  } catch (err) {
    console.warn('Could not load existing annotations:', err);
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

  const today = new Date().toISOString().split('T')[0];
  const folderPath = `/full_dataset/${state.folderKey}`;

  // Build CSV
  const cols = ['session','start_time','end_time','player_id','player_name','action_id','notes','created_at'];
  const rows = [cols.join(',')];
  state.annotations.forEach(a => {
    rows.push(cols.map(c => csvEscape(String(a[c] ?? ''))).join(','));
  });
  const csvContent = rows.join('\n');

  const csvPath = `${folderPath}/${state.folderKey}_annotations_${today}.csv`;

  const btn = document.getElementById('btn-save-dropbox');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  setStatus('Uploading annotations to Dropbox…');

  try {
    await dbxUpload(token, csvPath, csvContent);
    setStatus('Annotations saved to Dropbox.');
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
