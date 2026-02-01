# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Zen Garden Online (silentsand.me) — a physics-based sand garden simulator using HTML5 Canvas. Zero dependencies, no build system, no framework. Deployed to GitHub Pages.

## Development

No build step. Open `index.html` in a browser to run. Deploy by pushing to the GitHub Pages branch. The `CNAME` file maps to `silentsand.me`.

## Architecture

### File structure

- `index.html` (~255 lines) — HTML markup, meta/SEO tags, structured data
- `script.js` (~1208 lines) — all JavaScript logic
- `style.css` (~245 lines) — all CSS styling

### Data model

Per-pixel typed arrays store the sand simulation state:
- `sandHeight[]` (Float32Array) — elevation at each pixel (range ~0.1–1.5)
- `sandR/G/B[]` (Float32Array) — per-pixel color channels
- `noiseMap[]` (Float32Array) — pre-generated grain texture

Canvas dimensions are set once at load: `W = min(1120, viewportWidth - 40)`, `H = min(630, viewportHeight - 120)`.

### Physics pipeline

1. **`strokeTo()`** — interpolates mouse movement into discrete steps
2. **`carveRake()`** — positions multiple tines along the rake perpendicular; handles symmetry by reflecting strokes across active mirror axes
3. **`carveTine()`** — core carving function per tine:
   - Pass 1: Applies height profile from pre-computed LUT (`tineProfile`), blends with existing height, collects displaced sand
   - Pass 2: Distributes displaced sand to three deposit points (70% forward, 15% each side) using a pre-computed gaussian kernel

### Mirror / symmetry system

Three independent mirror modes can be combined:
- **V (vertical)** — left/right axis reflection
- **H (horizontal)** — top/bottom axis reflection
- **D (diagonal)** — both diagonal axes, enabling up to 8-way kaleidoscope symmetry

A **Center Align** toggle makes rake tines align radially from canvas center instead of following rake angle. Visual guide lines (SVG overlay) show active axes and center dot. Duplicate strokes within 1px are deduplicated.

### Undo / redo system

Captures full typed-array snapshots (sandHeight, sandR, sandG, sandB) on each mousedown/touchstart. Max stack depth: 10 states. Keyboard shortcuts: `Ctrl+Z` undo, `Ctrl+Shift+Z` / `Ctrl+Y` redo.

### Rendering

`render()` reads the height/color arrays and writes to a reused `ImageData` buffer. Lighting is computed from surface normals (finite-difference gradient of `sandHeight`) dotted with a fixed light direction. Only the dirty region is blitted via `putImageData`.

### Key performance patterns

These are numbered in code comments as "optimization #1–#6":
1. **rAF coalescing** — `requestRender()` deduplicates animation frame requests
2. **Dirty region tracking** — `markDirty()`/`resetDirty()` limit rendering to changed pixels
3. **Cached slider values** — `cached*` variables avoid DOM reads during hot loops
4. **Pre-allocated displacement buffers** — `dispIdx`, `dispAmount`, etc. are reused typed arrays
5. **Reused ImageData** — single `imageData` buffer across all frames
6. **Pre-computed tine profile LUT** — `tineProfile` Float32Array rebuilt only when radius/depth/rim changes

### State persistence

- **Settings**: All user-configurable slider/toggle values saved to `localStorage` under key `zenGardenSettings` on every input/change event and restored on load.
- **Garden saves**: Full sand state (height + color arrays, canvas dimensions) stored in IndexedDB. Users can quick-save with a custom name, load, or delete saves from the Saves tab.

### UI structure

Four-tab settings panel:
1. **Rake** — tine count, gap, size sliders; mirror buttons (V, H, D); center align toggle
2. **Image** — guide image upload, show/hide toggle, opacity/zoom/position sliders
3. **Tuning** — depth, rim, light, blend, and advanced physics sliders (`dbg*` IDs); `info-i` hover tooltips
4. **Saves** — quick-save input, scrollable list of saves with load/delete actions

### Keyboard shortcuts

- `Ctrl+Z` / `Cmd+Z` — undo
- `Ctrl+Shift+Z` / `Cmd+Shift+Z` — redo
- `Ctrl+Y` / `Cmd+Y` — redo (Windows alternative)
- Mouse wheel — rotate rake angle (8 snap positions at 45° increments)

## Conventions

- Global state uses `cached*` prefix for values mirrored from DOM sliders
- Tuning/debug parameters use `dbg*` prefix for element IDs
- Color palette: `#1a1a1a` (bg), `#c2a67d` (primary accent), `#5a4a35` (secondary), `#e8d5b7` (light accent)
- Height values: 1.0 = flat sand, <1.0 = groove, >1.0 = rim/pile, clamped to [0.1, 1.5]
