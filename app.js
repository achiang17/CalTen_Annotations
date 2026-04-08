(async function () {
  // Get Dropbox token from sessionStorage (set at login)
  const DROPBOX_TOKEN = getDropboxToken();

  if (!DROPBOX_TOKEN) {
    document.getElementById('folder-list').innerHTML =
      '<div class="empty-state">No Dropbox token found. Please <a href="index.html">sign in</a> again.</div>';
    return;
  }

  // Dropbox folder path — load from sessionStorage or default
  const folderInput = document.getElementById('dropbox-folder');
  const savedFolder = sessionStorage.getItem('calten_dbx_folder') || '/full_dataset';
  folderInput.value = savedFolder;

  function getDropboxFolder() {
    const val = folderInput.value.trim();
    return val || '/full_dataset';
  }

  // ── Dropbox API helpers ──────────────────────────────────────
  async function dbxPost(endpoint, body) {
    const res = await fetch(`https://api.dropboxapi.com/2${endpoint}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${DROPBOX_TOKEN}`,
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

  async function dbxGetThumbnail(filePath) {
    const res = await fetch('https://content.dropboxapi.com/2/files/get_thumbnail_v2', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${DROPBOX_TOKEN}`,
        'Dropbox-API-Arg': JSON.stringify({
          resource: { '.tag': 'path', path: filePath },
          format: 'jpeg',
          size: 'w256h256',
        }),
      },
    });
    if (!res.ok) return null;
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  }

  // ── Roster + Annotator ─────────────────────────────────────
  const rosterSelect = document.getElementById('roster-select');
  const annotatorInput = document.getElementById('annotator-name');

  // ── Session list from Dropbox ─────────────────────────────
  const folderList = document.getElementById('folder-list');

  async function loadSessions() {
    const DROPBOX_FOLDER = getDropboxFolder();
    sessionStorage.setItem('calten_dbx_folder', DROPBOX_FOLDER);

    folderList.innerHTML = '<div class="empty-state">Loading sessions from Dropbox…</div>';

    let folders;
    try {
      const result = await dbxPost('/files/list_folder', { path: DROPBOX_FOLDER });
      folders = result.entries
        .filter(e => e['.tag'] === 'folder')
        .sort((a, b) => {
          function toSortKey(name) {
            const p = name.split('_');
            if (p.length >= 6 && p[2].length === 4) {
              return `${p[2]}${p[0]}${p[1]}${p[3]}${p[4]}`;
            }
            return `2026${p[0]}${p[1]}${p[2]}${p[3]}`;
          }
          return toSortKey(b.name).localeCompare(toSortKey(a.name));
        });
    } catch (err) {
      folderList.innerHTML = `<div class="empty-state">Failed to load sessions from Dropbox.<br>${escapeHtml(err.message)}<br><br>Check your folder path and try again.</div>`;
      return;
    }

    if (folders.length === 0) {
      folderList.innerHTML = '<div class="empty-state">No sessions found in Dropbox folder.</div>';
      return;
    }

    folderList.innerHTML = '';
    const thumbJobs = [];

    folders.forEach(folder => {
      const card = document.createElement('div');
      card.className = 'folder-card';
      card.innerHTML = `
        <div class="folder-card-thumb">
          <div class="thumb-placeholder">Loading…</div>
        </div>
        <div class="folder-card-info">
          <div class="folder-card-label">${escapeHtml(folderLabel(folder.name))}</div>
          <div class="folder-card-key">${escapeHtml(folder.name)}</div>
        </div>
      `;
      card.addEventListener('click', () => openSession(folder.name));
      folderList.appendChild(card);

      thumbJobs.push({ folderPath: folder.path_display, container: card.querySelector('.folder-card-thumb') });
    });

    const BATCH_SIZE = 3;
    for (let i = 0; i < thumbJobs.length; i += BATCH_SIZE) {
      const batch = thumbJobs.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(j => loadThumbnail(j.folderPath, j.container)));
    }
  }

  function folderLabel(name) {
    const parts = name.split('_');
    let month, day, year, hour, minute, court;
    if (parts.length >= 6 && parts[2].length === 4) {
      month = parts[0]; day = parts[1]; year = parts[2];
      hour = parts[3]; minute = parts[4]; court = parts[5];
    } else if (parts.length >= 5) {
      month = parts[0]; day = parts[1]; year = '2026';
      hour = parts[2]; minute = parts[3]; court = parts[4];
    } else {
      return name;
    }
    const courtLabel = court ? court.replace('court', 'Court ') : '';
    const dateStr = `${month}/${day}/${year}`;
    const h = parseInt(hour, 10);
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h > 12 ? h - 12 : (h === 0 ? 12 : h);
    const timeStr = `${h12}:${minute} ${ampm}`;
    return `${dateStr} ${timeStr} — ${courtLabel}`;
  }

  async function loadThumbnail(folderPath, thumbContainer) {
    try {
      const result = await dbxPost('/files/list_folder', { path: folderPath });
      const videos = result.entries
        .filter(e => e['.tag'] === 'file' && /\.mov$/i.test(e.name))
        .sort((a, b) => a.size - b.size);

      if (videos.length === 0) {
        thumbContainer.innerHTML = '<div class="thumb-placeholder">No videos</div>';
        return;
      }

      const thumbUrl = await dbxGetThumbnail(videos[0].path_display);
      if (thumbUrl) {
        thumbContainer.innerHTML = `<img src="${thumbUrl}" alt="Session thumbnail" />`;
      } else {
        thumbContainer.innerHTML = '<div class="thumb-placeholder">No preview</div>';
      }
    } catch (err) {
      thumbContainer.innerHTML = '<div class="thumb-placeholder">No preview</div>';
    }
  }

  // Wire reload button
  document.getElementById('btn-reload-sessions').addEventListener('click', loadSessions);
  folderInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') loadSessions();
  });

  // Initial load
  await loadSessions();

  // ── Open session ─────────────────────────────────────────
  function openSession(folderName) {
    const name = annotatorInput.value.trim();
    if (!name) {
      annotatorInput.style.border = '2px solid #dc2626';
      annotatorInput.focus();
      annotatorInput.placeholder = 'Please enter your name first';
      return;
    }
    const params = new URLSearchParams();
    params.set('session', folderName);
    params.set('team', rosterSelect.value);
    params.set('annotator', name);
    window.location.href = `viewer.html?${params.toString()}`;
  }

  // ── Utilities ─────────────────────────────────────────────
  function escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
})();
