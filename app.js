(async function () {
  // Load videos.json for session list
  let videos;
  try {
    videos = await fetch('videos.json').then(r => r.json());
  } catch (err) {
    document.getElementById('folder-list').innerHTML =
      '<div class="empty-state">Failed to load data files. Open via a local server (python3 -m http.server).</div>';
    return;
  }

  // ── Roster State ──────────────────────────────────────────
  let players = []; // Array of { id, name }
  let nextPlayerNum = 1;

  const rosterBody = document.getElementById('roster-body');
  const btnAddPlayer = document.getElementById('btn-add-player');
  const csvUpload = document.getElementById('csv-upload');

  // Start with one empty player
  addPlayer();

  // ── Add Player ────────────────────────────────────────────
  btnAddPlayer.addEventListener('click', () => addPlayer());

  function addPlayer(id = null, name = '') {
    const playerId = id || `P${nextPlayerNum}`;
    if (!id) nextPlayerNum++;

    const player = { id: playerId, name: name };
    players.push(player);

    const tr = document.createElement('tr');
    tr.dataset.playerId = playerId;
    tr.innerHTML = `
      <td>
        <input type="text" class="player-id-input" value="${escapeHtml(playerId)}" placeholder="ID" autocomplete="off" />
      </td>
      <td>
        <input type="text" class="player-name-input" value="${escapeHtml(name)}" placeholder="Enter name…" autocomplete="off" />
      </td>
      <td>
        <button class="btn btn-danger btn-remove-player" title="Remove player">✕</button>
      </td>
    `;

    // Update player object when inputs change
    const idInput = tr.querySelector('.player-id-input');
    const nameInput = tr.querySelector('.player-name-input');
    
    idInput.addEventListener('input', () => {
      player.id = idInput.value.trim();
      tr.dataset.playerId = player.id;
    });
    
    nameInput.addEventListener('input', () => {
      player.name = nameInput.value.trim();
    });

    // Remove player
    tr.querySelector('.btn-remove-player').addEventListener('click', () => {
      const idx = players.indexOf(player);
      if (idx > -1) players.splice(idx, 1);
      tr.remove();
    });

    rosterBody.appendChild(tr);
    
    // Focus the name input for convenience
    if (!name) nameInput.focus();
  }

  // ── CSV Upload ────────────────────────────────────────────
  csvUpload.addEventListener('change', handleCSVUpload);

  function handleCSVUpload(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target.result;
      const lines = text.split(/\r?\n/).filter(line => line.trim());
      
      // Clear existing players
      players = [];
      rosterBody.innerHTML = '';
      nextPlayerNum = 1;

      lines.forEach((line, idx) => {
        // Skip header row if it looks like a header
        const lower = line.toLowerCase();
        if (idx === 0 && (lower.includes('player_id') || lower.includes('id,') || lower.includes('id\t'))) {
          return;
        }

        // Parse CSV line (handle both comma and tab delimiters)
        const delimiter = line.includes('\t') ? '\t' : ',';
        const parts = line.split(delimiter).map(p => p.trim().replace(/^["']|["']$/g, ''));
        
        if (parts.length >= 2) {
          const id = parts[0];
          const name = parts[1];
          if (id) addPlayer(id, name);
        } else if (parts.length === 1 && parts[0]) {
          // Just an ID, no name
          addPlayer(parts[0], '');
        }
      });

      // If no valid players found, add one empty row
      if (players.length === 0) {
        addPlayer();
      }
    };
    reader.readAsText(file);
    
    // Reset file input so same file can be re-uploaded
    csvUpload.value = '';
  }

  // ── Session list ─────────────────────────────────────────
  const folderList = document.getElementById('folder-list');
  folderList.innerHTML = '';

  const folderKeys = Object.keys(videos);
  if (folderKeys.length === 0) {
    folderList.innerHTML = '<div class="empty-state">No sessions found in videos.json.</div>';
    return;
  }

  folderKeys.forEach(key => {
    const session = videos[key];
    const card = document.createElement('div');
    card.className = 'folder-card';
    card.innerHTML = `
      <div>
        <div class="folder-card-label">${session.label}</div>
        <div class="folder-card-key">${key}</div>
      </div>
      <div class="folder-card-arrow">›</div>
    `;
    card.addEventListener('click', () => openSession(key));
    folderList.appendChild(card);
  });

  // ── Open session ─────────────────────────────────────────
  function openSession(folderKey) {
    const params = new URLSearchParams();
    params.set('session', folderKey);
    
    // Pass all players as JSON in a single param
    const playersData = players
      .filter(p => p.id) // Only include players with an ID
      .map(p => ({ id: p.id, name: p.name }));
    params.set('players', JSON.stringify(playersData));
    
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
