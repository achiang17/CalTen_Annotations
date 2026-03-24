# Product Requirements Document
## Tennis Field Data Annotation Website

---

## 1. Project Overview

A private, link-accessible web application for annotating tennis match video footage. Coaches browse a Dropbox-hosted video library organized by session folders, select a folder to load up to 4 camera angles simultaneously, watch them in a wall-clock-synchronized 2×2 grid, and create time-region annotations (start + end time) tagging a player and action. Annotations are saved in-browser during the session and exported as JSON/CSV at the end.

---

## 2. Access & Privacy

- **Access model:** Private by default — accessible only to users who have the direct URL
- **Authentication:** No login system required for v1
- **Hosting:** Static site (Netlify or GitHub Pages recommended)

---

## 3. Folder & File Structure (Dropbox)

### Session Folder Naming
```
MM_DD_YYYY_HH_MM_courtN
e.g. 02_25_2026_16_30_court1
```

### Video File Naming
```
{month}_{day}_{year}_{starthour}_{startminute}_{startsecond}_{startmillisecond}_court{number}_{direction}_{endhour}_{endminute}_{endsecond}.MOV
e.g. 02_25_2026_16_26_53_000_court1_W_18_32_06.MOV
```

### Filename Parsing
| Segment | Example | Meaning |
|---|---|---|
| `MM_DD_YYYY` | `02_25_2026` | Recording date |
| `HH_MM_SS_ms` | `16_26_53_000` | Wall clock start time of this camera |
| `court{N}` | `court1` | Court identifier |
| `direction` | `W` or `E` | Court side (West / East) |
| `HH_MM_SS` | `18_32_06` | End time of recording (ignore for sync) |

### Wall Clock Sync Logic
- Parse `HH_MM_SS_ms` from each video filename to get its absolute start time in milliseconds
- Find the **latest-starting** camera — this becomes the reference (offset = 0)
- All earlier cameras get a **positive seek offset** = (latest start time) − (this camera's start time)
- On load, seek each video to its offset before playback begins
- All videos then represent the same real-world moment when played together

---

## 4. Pages & Layout

### 4.1 Home / Landing Page
- Project title and brief description
- Player roster setup panel (see Section 7)
- Folder browser to select a session
- Clean minimal aesthetic

### 4.2 Video Browser
- Reads `videos.json` to display session folders
- Folders listed with human-readable label: `MM/DD/YYYY HH:MM — Court N`
- Clicking a folder loads its videos directly into the Viewer
- If a `[folder-name]_annotations.json` exists (referenced in videos.json), load it automatically

### 4.3 Video Viewer + Annotation Panel
- 2×2 synchronized video grid (1–4 videos, layout adapts)
- Each video tile labeled with: Court Side + Camera ID (e.g. "West — Cam 02")
- Unified master playback controls
- Annotation panel to the right or below the grid
- Frame scrubber panel for precise navigation
- Export buttons always visible

---

## 5. Playback Features

### 5.1 Synchronized Playback
- Single master play/pause button controls all videos simultaneously
- Seeking the master timeline seeks all videos accounting for wall clock offsets
- Individual volume controls per video (independent)

### 5.2 Playback Speed
- Speed toggle options: `0.5x`, `1x`, `2x`
- Applies to all videos simultaneously
- Current speed clearly displayed

### 5.3 Frame Scrubber Panel
- Horizontal filmstrip-style panel below the video grid
- Shows thumbnail frames at regular intervals across the timeline
- Clicking a frame thumbnail seeks all videos to that timestamp
- Helps coaches scan footage quickly without blind scrubbing

---

## 6. Annotation System

### 6.1 Creating an Annotation
1. Coach watches and identifies the start of an action
2. Presses **"Mark Start"** button (or keyboard shortcut `S`) — videos pause, start time recorded
3. Coach presses **"Mark End"** button (or keyboard shortcut `E`) — end time recorded
4. Annotation form appears pre-filled with start/end times
5. Coach selects `player_id` and `action_id`, optionally adds notes
6. Confirms → annotation added to the list

### 6.2 Annotation Fields
| Field | Type | Description |
|---|---|---|
| `id` | auto | Unique annotation ID |
| `start_time` | HH:MM:SS.ms | Action start on synced timeline |
| `end_time` | HH:MM:SS.ms | Action end on synced timeline |
| `player_id` | string | Numeric ID e.g. "P1" |
| `player_name` | string | Human name if mapped e.g. "John Smith" |
| `action_id` | string | One of the defined tennis actions |
| `notes` | string | Optional free text |
| `created_at` | ISO datetime | Wall clock time annotation was made |
| `session` | string | Folder name this annotation belongs to |

### 6.3 Tennis Actions (from config.json)
```
forehand, backhand, serve, volley, overhead, drop_shot, lob
```

### 6.4 Annotation List
- Scrollable list of all annotations for the current session
- Each row shows: start–end time, player name/ID, action, notes
- Clicking a row seeks all videos to that annotation's start time
- Each row has a delete button
- Rows subtly color-coded by action type

### 6.5 Loading Existing Annotations
- If `videos.json` references an annotations file for a folder, it loads automatically on folder open
- Annotations appear in the list immediately and are seekable

---

## 7. Player Roster Setup

- Before annotating, coaches open a **Player Setup panel**
- Lists player IDs (P1, P2, etc. from config.json)
- Coach enters a name next to each ID (e.g. P1 → "Rafael Nadal")
- Names stored in browser session memory only (cleared on page close)
- Dropdown in annotation form shows: "P1 — Rafael Nadal"
- Exported annotations include both `player_id` and `player_name`

---

## 8. Export

### 8.1 JSON Format
```json
{
  "session": "02_25_2026_16_30_court1",
  "exported_at": "2026-02-25T17:45:00",
  "players": { "P1": "Rafael Nadal", "P2": "Roger Federer" },
  "annotations": [
    {
      "id": 1,
      "start_time": "00:01:23.400",
      "end_time": "00:01:25.800",
      "player_id": "P1",
      "player_name": "Rafael Nadal",
      "action_id": "forehand",
      "notes": "down the line winner",
      "created_at": "2026-02-25T16:45:12",
      "session": "02_25_2026_16_30_court1"
    }
  ]
}
```

### 8.2 CSV Columns (exact order)
```
session, start_time, end_time, player_id, player_name, action_id, notes, created_at
```

### 8.3 Filename Format
```
02_25_2026_16_30_court1_annotations_2026-02-25.json
02_25_2026_16_30_court1_annotations_2026-02-25.csv
```

---

## 9. Configuration Files

### 9.1 `videos.json`
```json
{
  "02_25_2026_16_30_court1": {
    "label": "02/25/2026 16:30 — Court 1",
    "annotations": "https://www.dropbox.com/s/xyz/02_25_2026_16_30_court1_annotations.json?raw=1",
    "videos": {
      "W": "https://www.dropbox.com/s/abc/02_25_2026_16_26_53_000_court1_W_18_32_06.MOV?raw=1",
      "E": "https://www.dropbox.com/s/def/02_25_2026_16_27_25_000_court1_E_18_32_23.MOV?raw=1"
    }
  }
}
```

### 9.2 `config.json`
```json
{
  "actions": ["forehand", "backhand", "serve", "volley", "overhead", "drop_shot", "lob"],
  "players": ["P1", "P2", "P3", "P4"]
}
```

---

## 10. Technical Stack

- **Frontend:** Vanilla HTML, CSS, JavaScript — no frameworks, no build tools
- **Video:** Native HTML5 `<video>` elements with `.MOV` files via Dropbox `?raw=1` links
- **Sync:** Wall clock offset calculated from filename parsing at load time
- **State:** In-browser session only — annotations lost if page closed without exporting
- **Export:** Client-side Blob generation for CSV and JSON download
- **Hosting:** Netlify (free tier, drag-and-drop deploy)

---

## 11. File Structure

```
project-root/
├── index.html              ← Landing page + folder browser + player setup
├── viewer.html             ← Video grid + annotation panel
├── style.css               ← All styles
├── app.js                  ← Folder browser, loads videos.json, passes selection to viewer
├── viewer.js               ← Sync engine, playback, annotations, export
├── videos.json             ← Session folders → Dropbox video URLs
├── config.json             ← Actions list, player IDs
├── CLAUDE.md               ← AI instructions
└── README.md               ← Human docs
```

---

## 12. Out of Scope (v1)

- User accounts or login
- Auto-save to Dropbox (manual export + upload workflow)
- Real-time multi-user collaboration
- Automatic Dropbox API folder sync
- Mobile optimization
- Video clipping or trimming tools
