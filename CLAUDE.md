# CLAUDE.md — AI Assistant Instructions
## Tennis Annotation Website

## Project Summary
A static tennis video annotation tool. Coaches browse session folders, load up to 4 .MOV cameras into a wall-clock-synchronized 2×2 grid, and create time-region annotations (start + end) with player ID, player name, and tennis action. Annotations are exported as JSON/CSV. No backend. No framework. Vanilla HTML/CSS/JS only.

For full feature details read PRD.md before starting any task.

---

## Hard Rules — Never Break These

- **Vanilla HTML, CSS, JavaScript only** — no React, Vue, jQuery, or any framework
- **No backend** — no servers, no databases, no Node.js runtime
- **No npm packages or external dependencies** — zero imports from CDNs or package managers
- **No localStorage or sessionStorage** — all state lives in JS memory only
- **Config-driven** — actions and player IDs always come from `config.json`, video URLs from `videos.json` — never hardcode these

---

## File Responsibilities

| File | Purpose |
|---|---|
| `index.html` | Landing page, folder browser, player roster setup |
| `viewer.html` | 2×2 video grid, annotation panel, export |
| `style.css` | All styles for both pages |
| `app.js` | Loads `videos.json`, renders folder list, passes selected folder to viewer |
| `viewer.js` | Sync engine, wall clock offset calc, playback controls, annotation logic, CSV/JSON export |
| `videos.json` | Maps session folder names → Dropbox video URLs + optional annotations URL |
| `config.json` | Defines `actions` array and `players` array |

---

## Filename Parsing & Sync (Critical)

### Session Folder Naming
```
{month}_{day}_{year}_{starthour}_{startminute}_court{number}
e.g. 02_25_2026_16_30_court1
```

### Video File Naming
```
{MM}_{DD}_{YYYY}_{HH}_{MM}_{SS}_{ms}_{courtNum}_{direction}_{endHH}_{endMM}_{endSS}_{endMs}.MOV
e.g. 02_25_2026_16_26_53_000_5_W_18_32_06_375.MOV
     03_22_2026_11_17_10_000_1_SE_12_23_54_086.MOV
```

Parse positions (split by `_`):
- Index 0–2: `MM_DD_YYYY` — date (ignore for sync)
- Index 3–6: `HH_MM_SS_ms` — wall clock start time → convert to total milliseconds
- Index 7: court number (e.g. "5", "1")
- Index 8: direction (`W`, `E`, `N`, `S`, `NW`, `NE`, `SW`, `SE`)
- Index 9–12: `HH_MM_SS_ms` — end time (ignore for sync)

**Sync algorithm:**
1. Parse wall clock start time (indices 3–6) for each video
2. Find `maxStartMs` = latest start time across all videos
3. Each video's `offsetMs` = `maxStartMs` - `thisVideoStartMs`
4. On load: `video.currentTime = offsetMs / 1000` before any playback
5. All seek/play/pause operations add the offset back to keep sync

**Video tile label:** `{Direction}` e.g. "West" or "Southeast"

---

## Annotation Rules

Each annotation must have exactly these fields:
- `id` — auto-incrementing integer
- `start_time` — HH:MM:SS.ms string (synced timeline position)
- `end_time` — HH:MM:SS.ms string (synced timeline position)
- `player_id` — string from config.json players array
- `player_name` — string from session roster (empty string if not set)
- `action_id` — string from config.json actions array
- `notes` — string (may be empty)
- `created_at` — ISO datetime string
- `session` — folder name string

Keyboard shortcuts: `S` = Mark Start, `E` = Mark End

---

## Export Format

**JSON export** — full wrapper object with session, exported_at, players map, and annotations array (see PRD.md Section 8.1)

**CSV columns in this exact order:**
`session, start_time, end_time, player_id, player_name, action_id, notes, created_at`

**Filename:** `{folder-name}_annotations_{YYYY-MM-DD}.json` and `.csv`

---

## Playback Rules

- Speed options: `0.5x`, `1x`, `2x` — applied to ALL videos simultaneously via `video.playbackRate`
- Master play/pause and seek controls ALL videos — always apply offset when seeking
- Volume controls are per-video and independent
- Frame scrubber shows thumbnails using canvas extraction at regular intervals

---

## Design Rules

- Clean minimal scientific aesthetic
- Desktop-first — no mobile optimization in v1
- System fonts only — no external font imports
- Color palette: white `#ffffff`, light gray `#f5f5f5`, dark text `#1a1a1a`, accent blue `#2563eb`
- Action color coding in annotation list (subtle left border or background tint per action)
- No CSS frameworks — no Bootstrap, no Tailwind

---

## What NOT To Do

- Do not add login, authentication, or user accounts
- Do not add a backend, API server, or database
- Do not persist anything to localStorage or sessionStorage
- Do not add features not in PRD.md without asking first
- Do not change the `videos.json` or `config.json` schema without confirming
- Do not use iframes for video — always use native `<video>` elements
- Do not optimize for mobile

---

## Session Startup Checklist

Before starting any task:
1. Read this file (`CLAUDE.md`)
2. Read `PRD.md` for full feature context
3. Use Plan Mode (`Shift+Tab` twice) for any task touching more than one file
4. State the plan and wait for confirmation before writing any code
