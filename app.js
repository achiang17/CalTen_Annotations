(async function () {
  // Load config
  let config;
  try {
    config = await fetch('config.json').then(r => r.json());
  } catch (err) {
    document.getElementById('folder-list').innerHTML =
      '<div class="empty-state">Failed to load config.json. Open via a local server (python3 -m http.server).</div>';
    return;
  }

  const DROPBOX_TOKEN = config.dropbox_token;
  const DROPBOX_FOLDER = config.dropbox_folder || '/full_dataset';

  if (!DROPBOX_TOKEN) {
    document.getElementById('folder-list').innerHTML =
      '<div class="empty-state">No Dropbox token found in config.json.</div>';
    return;
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

  // ── Roster State ──────────────────────────────────────────
  const rosters = {
    men: [
      { id: 'P1', name: 'Constantin Pradenne' },
      { id: 'P2', name: 'Nicholas Ciordas' },
      { id: 'P3', name: 'Michael Gao' },
      { id: 'P4', name: 'Soren Ghorai' },
      { id: 'P5', name: 'Eric He' },
      { id: 'P6', name: 'David Jin' },
      { id: 'P7', name: 'Tejas Ram' },
      { id: 'P8', name: 'Jan Safrata' },
      { id: 'P9', name: 'Marco Yang' },
      { id: 'P10', name: 'Andrew Zabelo' },
    ],
    women: [
      { id: 'P1', name: 'Carissa Gerung' },
      { id: 'P2', name: 'Polaris Hayes' },
      { id: 'P3', name: 'Naya Kessman' },
      { id: 'P4', name: 'Aoi Kunimoto' },
      { id: 'P5', name: 'Anna Piland' },
      { id: 'P6', name: 'Hannah Ramsperger' },
      { id: 'P7', name: 'Anna Szczuka' },
      { id: 'P8', name: 'Katelyn Waugh' },
      { id: 'P9', name: 'Tara Zhan' },
    ],
  };

  let players = [];
  const rosterBody = document.getElementById('roster-body');
  const rosterSelect = document.getElementById('roster-select');

  function loadRoster(team) {
    players = rosters[team].map(p => ({ ...p }));
    rosterBody.innerHTML = '';
    players.forEach(p => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${escapeHtml(p.id)}</td><td>${escapeHtml(p.name)}</td>`;
      rosterBody.appendChild(tr);
    });
  }

  loadRoster('men');

  rosterSelect.addEventListener('change', () => {
    loadRoster(rosterSelect.value);
  });

  // ── Session list from Dropbox ─────────────────────────────
  const folderList = document.getElementById('folder-list');
  folderList.innerHTML = '<div class="empty-state">Loading sessions from Dropbox…</div>';

  let folders;
  try {
    const result = await dbxPost('/files/list_folder', { path: DROPBOX_FOLDER });
    folders = result.entries
      .filter(e => e['.tag'] === 'folder')
      .sort((a, b) => {
        // Parse folder names to dates for proper sorting (newest first)
        function toSortKey(name) {
          const p = name.split('_');
          if (p.length >= 6 && p[2].length === 4) {
            // MM_DD_YYYY_HH_MM_courtN
            return `${p[2]}${p[0]}${p[1]}${p[3]}${p[4]}`;
          }
          // MM_DD_HH_MM_courtN (assume 2026)
          return `2026${p[0]}${p[1]}${p[2]}${p[3]}`;
        }
        return toSortKey(b.name).localeCompare(toSortKey(a.name));
      });
  } catch (err) {
    folderList.innerHTML = `<div class="empty-state">Failed to load sessions from Dropbox.<br>${escapeHtml(err.message)}</div>`;
    return;
  }

  if (folders.length === 0) {
    folderList.innerHTML = '<div class="empty-state">No sessions found in Dropbox folder.</div>';
    return;
  }

  // Parse folder name into a human-readable label
  function folderLabel(name) {
    const parts = name.split('_');
    // Handle both MM_DD_YYYY_HH_MM_courtN and MM_DD_HH_MM_courtN formats
    let month, day, year, hour, minute, court;
    if (parts.length >= 6 && parts[2].length === 4) {
      // MM_DD_YYYY_HH_MM_courtN
      month = parts[0]; day = parts[1]; year = parts[2];
      hour = parts[3]; minute = parts[4]; court = parts[5];
    } else if (parts.length >= 5) {
      // MM_DD_HH_MM_courtN (no year)
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

  // Render session cards
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

  // Load thumbnails in batches of 3 to avoid Dropbox rate limits
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

  // Process in batches of 3
  const BATCH_SIZE = 3;
  for (let i = 0; i < thumbJobs.length; i += BATCH_SIZE) {
    const batch = thumbJobs.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(j => loadThumbnail(j.folderPath, j.container)));
  }

  // ── Open session ─────────────────────────────────────────
  function openSession(folderName) {
    const params = new URLSearchParams();
    params.set('session', folderName);
    params.set('team', rosterSelect.value);
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
