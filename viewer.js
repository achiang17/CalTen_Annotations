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
        generateScrubberThumbs();
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
    }
  }, 100);

  // Seek slider
  const slider = document.getElementById('seek-slider');
  slider.addEventListener('input', () => {
    seekAll(parseInt(slider.value, 10) / 1000);
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
    // Enter confirms annotation when form is visible
    if (e.key === 'Enter') {
      const form = document.getElementById('annotation-form');
      if (form && !form.classList.contains('hidden')) {
        e.preventDefault();
        confirmAnnotation();
        return;
      }
    }
    // Ignore when typing in an input/textarea
    if (['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)) return;
    if (e.key === 's' || e.key === 'S') markStart();
    if (e.key === 'e' || e.key === 'E') markEnd();
    if (e.key === ' ') { e.preventDefault(); togglePlay(); }
  });

  // Annotation form buttons
  document.getElementById('btn-mark-start').addEventListener('click', markStart);
  document.getElementById('btn-mark-end').addEventListener('click', markEnd);
  document.getElementById('btn-confirm').addEventListener('click', confirmAnnotation);
  document.getElementById('btn-cancel').addEventListener('click', cancelAnnotation);

  // Export buttons
  document.getElementById('btn-export-json').addEventListener('click', exportJSON);
  document.getElementById('btn-export-csv').addEventListener('click', exportCSV);
}

function togglePlay() {
  const videos = state.videos.map(v => v.el).filter(Boolean);
  if (videos.length === 0) return;
  const anyPlaying = videos.some(v => !v.paused);
  if (anyPlaying) {
    videos.forEach(v => v.pause());
    document.getElementById('btn-play').textContent = 'Play';
  } else {
    videos.forEach(v => v.play().catch(() => {}));
    document.getElementById('btn-play').textContent = 'Pause';
  }
}

function pauseAll() {
  state.videos.forEach(v => v.el.pause());
  document.getElementById('btn-play').textContent = 'Play';
}

// ── Step 7: Frame scrubber ───────────────────────────────────
async function generateScrubberThumbs() {
  if (state.syncedDuration <= 0) return;

  const panel = document.getElementById('scrubber-panel');
  panel.innerHTML = '';

  const canvas = document.getElementById('thumb-canvas');
  const ctx = canvas.getContext('2d');

  const INTERVAL_SEC = 5;
  const refVideo = state.videos[state.refIdx].el;
  const refOffset = state.videos[state.refIdx].offsetMs / 1000;

  const times = [];
  for (let t = 0; t <= state.syncedDuration; t += INTERVAL_SEC) {
    times.push(t);
  }

  setStatus('Generating thumbnails…');

  for (const syncedSec of times) {
    await seekVideoToTime(refVideo, syncedSec + refOffset);

    let dataUrl = null;
    try {
      ctx.drawImage(refVideo, 0, 0, canvas.width, canvas.height);
      dataUrl = canvas.toDataURL('image/jpeg', 0.6);
    } catch (e) {
      // Cross-origin video taints the canvas — draw a time-label placeholder instead
      ctx.fillStyle = '#1a1a1a';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#9ca3af';
      ctx.font = '12px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(formatTime(syncedSec), canvas.width / 2, canvas.height / 2 + 4);
      dataUrl = canvas.toDataURL('image/png');
    }

    const img = document.createElement('img');
    img.src = dataUrl;
    img.className = 'scrubber-thumb';
    img.title = formatTime(syncedSec);
    img.dataset.syncedSec = syncedSec;
    img.addEventListener('click', () => {
      seekAll(syncedSec);
      panel.querySelectorAll('.scrubber-thumb').forEach(t => t.classList.remove('active'));
      img.classList.add('active');
    });
    panel.appendChild(img);
  }

  // Restore to beginning after thumbnail generation
  seekAll(0);
  setStatus('');
}

function seekVideoToTime(videoEl, timeSec) {
  return new Promise(resolve => {
    // If already at the target time, seeked won't fire — resolve immediately
    if (Math.abs(videoEl.currentTime - timeSec) < 0.01) { resolve(); return; }
    const timeout = setTimeout(resolve, 3000); // safety net if seeked never fires
    const onSeeked = () => {
      clearTimeout(timeout);
      videoEl.removeEventListener('seeked', onSeeked);
      resolve();
    };
    videoEl.addEventListener('seeked', onSeeked);
    videoEl.currentTime = timeSec;
  });
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
}

function hideAnnotationForm() {
  document.getElementById('annotation-form').classList.add('hidden');
  document.getElementById('form-notes').value = '';
}

function populateFormDropdowns() {
  // Build player options
  const playerIds = Object.keys(state.players);
  const playerOptions = playerIds.map(pid => {
    const name = state.players[pid] || '';
    return { value: pid, label: name ? `${pid} — ${name}` : pid };
  });
  initSearchableSelect('ss-player', 'form-player', playerOptions);

  // Build action options
  const actionOptions = state.config.actions.map(action => ({
    value: action,
    label: action.replace(/_/g, ' '),
  }));
  initSearchableSelect('ss-action', 'form-action', actionOptions);
}

function initSearchableSelect(containerId, hiddenId, options) {
  const container = document.getElementById(containerId);
  const input = container.querySelector('.ss-input');
  const hidden = document.getElementById(hiddenId);
  const dropdown = container.querySelector('.ss-dropdown');
  let highlighted = -1;

  // Set default selection
  if (options.length > 0) {
    hidden.value = options[0].value;
    input.value = options[0].label;
  }

  function renderOptions(filter) {
    dropdown.innerHTML = '';
    const query = (filter || '').toLowerCase();
    const filtered = options.filter(o => o.label.toLowerCase().includes(query));

    filtered.forEach((o, i) => {
      const div = document.createElement('div');
      div.className = 'ss-option';
      if (i === 0) div.classList.add('highlighted');
      div.textContent = o.label;
      div.addEventListener('mousedown', e => {
        e.preventDefault();
        selectOption(o);
      });
      dropdown.appendChild(div);
    });

    highlighted = filtered.length > 0 ? 0 : -1;
    dropdown.classList.toggle('open', filtered.length > 0);
  }

  function selectOption(o) {
    hidden.value = o.value;
    input.value = o.label;
    dropdown.classList.remove('open');
  }

  function moveHighlight(dir) {
    const items = dropdown.querySelectorAll('.ss-option');
    if (items.length === 0) return;
    items.forEach(el => el.classList.remove('highlighted'));
    highlighted = Math.max(0, Math.min(items.length - 1, highlighted + dir));
    items[highlighted].classList.add('highlighted');
    items[highlighted].scrollIntoView({ block: 'nearest' });
  }

  input.addEventListener('focus', () => {
    input.select();
    renderOptions('');
  });

  input.addEventListener('input', () => {
    renderOptions(input.value);
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveHighlight(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveHighlight(-1);
    } else if (e.key === 'Enter') {
      if (dropdown.classList.contains('open') && highlighted >= 0) {
        e.preventDefault();
        e.stopPropagation();
        const query = (input.value || '').toLowerCase();
        const filtered = options.filter(o => o.label.toLowerCase().includes(query));
        if (filtered[highlighted]) selectOption(filtered[highlighted]);
      }
    } else if (e.key === 'Escape') {
      dropdown.classList.remove('open');
    }
  });

  input.addEventListener('blur', () => {
    // Delay to allow mousedown on option to fire
    setTimeout(() => {
      dropdown.classList.remove('open');
      // If typed value doesn't match any option, revert to current selection
      const currentOpt = options.find(o => o.value === hidden.value);
      if (currentOpt) input.value = currentOpt.label;
    }, 150);
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

// ── Step 10: Export ──────────────────────────────────────────
function exportJSON() {
  const today = new Date().toISOString().split('T')[0];
  const payload = {
    session:     state.folderKey,
    exported_at: new Date().toISOString().replace(/\.\d{3}Z$/, ''),
    players:     Object.fromEntries(
      Object.entries(state.players).filter(([, v]) => v)
    ),
    annotations: state.annotations,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  triggerDownload(blob, `${state.folderKey}_annotations_${today}.json`);
}

function exportCSV() {
  const today = new Date().toISOString().split('T')[0];
  const cols = ['session','start_time','end_time','player_id','player_name','action_id','notes','created_at'];
  const rows = [cols.join(',')];
  state.annotations.forEach(a => {
    rows.push(cols.map(c => csvEscape(String(a[c] ?? ''))).join(','));
  });
  const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
  triggerDownload(blob, `${state.folderKey}_annotations_${today}.csv`);
}

function csvEscape(val) {
  if (val.includes(',') || val.includes('"') || val.includes('\n')) {
    return '"' + val.replace(/"/g, '""') + '"';
  }
  return val;
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Utilities ────────────────────────────────────────────────
function setStatus(msg) {
  const bar = document.getElementById('status-bar');
  bar.innerHTML = msg;
  bar.style.display = msg ? '' : 'none';
}
