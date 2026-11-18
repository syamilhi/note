# Sam's Note (CustomNote)

> A distraction-free, zero-chrome infinite canvas note-taking experience inspired by Microsoft OneNote and the GitHub contribution heatmap.

[![Platform](https://img.shields.io/badge/Platform-Web-blue.svg)](https://github.com/syamilhi/note)
[![Stack](https://img.shields.io/badge/Stack-Vanilla%20JS%20%7C%20Firebase%20%7C%20Cloudinary-yellow.svg)](https://github.com/syamilhi/note)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](https://github.com/syamilhi/note)

---

## 🌟 Overview

**Sam's Note** combines spatial freedom with temporal structuring:
- **Infinite 2D Canvas:** Drag, zoom, and place rich text notes anywhere on an infinite plane with an adaptive dot grid.
- **Temporal Heatmap Rail:** Every day of the year has its own isolated canvas. A GitHub-style 365-day activity rail at the top of the screen tracks note density and custom tags over time.
- **Vector Inking:** Smooth pencil, line, and eraser tools for sketching diagrams and hand-drawn annotations.
- **Spatial Multi-Selection:** Right-click marquee drag selection, group moving, bulk deletion, and clipboard copy/paste (`Ctrl+C` / `Ctrl+V`).
- **Cloud Sync & Media:** Real-time bi-directional sync via Firebase Realtime Database with Google Authentication and direct Cloudinary image uploads.
- **Mobile Zen Mode:** Dedicated touch gesture engine with screen-wide double-tap toggle between Read Mode and Edit Mode.

---

## 🚀 Quick Start

No build steps, compilers, or package installations are required.

Simply serve the directory using any static HTTP file server:

```bash
# Using Python 3
python3 -m http.server 8080

# Using Node.js
npx serve -l 8080 .
```

Open `http://localhost:8080` in any modern web browser.

---

## ⌨️ Essential Keyboard Shortcuts

| Shortcut | Action |
|:---|:---|
| <kbd>Space</kbd> | Create note card at cursor |
| <kbd>Tab</kbd> | Expand/collapse 365-Day Activity Rail & Personal Boards |
| <kbd>T</kbd> | Jump to today's canvas |
| <kbd>P</kbd> / <kbd>L</kbd> / <kbd>E</kbd> / <kbd>V</kbd> | Switch tools: Pencil, Line, Eraser, Select |
| <kbd>Right Drag</kbd> | Marquee multi-selection box |
| <kbd>Ctrl+C</kbd> / <kbd>Ctrl+V</kbd> | Copy & paste selected notes and drawings |
| <kbd>Ctrl+Z</kbd> | Undo last drawing, move, or note deletion |
| <kbd>Ctrl+0</kbd> | Reset view / center canvas |
| <kbd>?</kbd> | Show complete keyboard shortcuts guide |

### Special In-Note Commands & Tags
- `\check` — Insert an interactive checklist item
- `\img` — Open file dialog to upload and embed an image
- `\title [Name]` — Set custom tooltip title for this day's activity rail cell
- `\red`, `\green`, `\purple`, `\yellow` — Color-tint this day's activity rail cell

---

## 📚 Technical Documentation

Comprehensive documentation for developers and AI agents is available in the **[docs/](docs/)** directory:

- 📖 **[docs/README.md](docs/README.md)** — Master index and quick orientation for AI agents
- 📐 **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — Canvas geometry, affine matrix math, LOD dot grid, and layer hierarchy
- 💾 **[docs/DATA_AND_STORAGE.md](docs/DATA_AND_STORAGE.md)** — LocalStorage schema, Firebase Realtime DB sync protocol, and Cloudinary media pipeline
- 🛠️ **[docs/FEATURES_AND_INTERACTIONS.md](docs/FEATURES_AND_INTERACTIONS.md)** — Note lifecycle, rich formatting, vector ink engine, and multi-selection
- 📱 **[docs/MOBILE_AND_GESTURES.md](docs/MOBILE_AND_GESTURES.md)** — Mobile Zen engine, touch gesture tracking, and responsive rules
- ⚠️ **[docs/KNOWN_ISSUES_AND_EDGE_CASES.md](docs/KNOWN_ISSUES_AND_EDGE_CASES.md)** — Intentional design choices, resolved multi-device sync fixes, and lightly documented quirks
- 🗺️ **[docs/DEVELOPMENT_GUIDE_AND_ROADMAP.md](docs/DEVELOPMENT_GUIDE_AND_ROADMAP.md)** — Local setup, coding invariants, completed hardening, and optional enhancements

