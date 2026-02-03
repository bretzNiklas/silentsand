# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Zen Garden Online (silentsand.me) — a physics-based sand garden simulator using HTML5 Canvas. Zero dependencies, no build system, no framework. Deployed to GitHub Pages.

## Development

No build step. Open `index.html` in a browser to run. Deploy by pushing to the GitHub Pages branch. The `CNAME` file maps to `silentsand.me`.

## Architecture

### File structure

- `index.html` (~314 lines) — HTML markup, meta/SEO tags, structured data
- `script.js` (~2168 lines) — all JavaScript logic
- `style.css` (~311 lines) — all CSS styling

### Data model

Per-pixel typed arrays store the sand simulation state:
- `sandHeight[]` (Float32Array) — elevation at each pixel (range ~0.1–1.5 normal, 0.1–2.0 in digging mode)
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

### Digging mode

A "Dig" button toggles digging mode, a subtractive carving experience where the user digs through geological layers to uncover a hidden daily Zen quote.

**State**: `diggingMode` flag, `savedGardenState` (snapshot to restore on exit), `quotePixels` (Uint8Array bitmask of text pixels).

**Setup** (`enterDiggingMode()`): Saves current garden state, fills sand to height 2.0, builds quote pixel mask by rendering the day's quote to an offscreen canvas, reads alpha channel into bitmask. Disables Clear and Quick Save buttons.

**Carving behavior**: In `carveTine()`, digging mode uses subtractive carving — each pass removes a fixed amount instead of blending toward a target. Rim regions are skipped, displaced sand vanishes (no deposit pass). **Progressive hardness** scales with depth: surface has 1x hardness, deepest layers have 5x. Per-pixel colors are updated in real-time via `getDepthColor()`.

**Geological layers** (`getDepthColor(h, surfaceH, out)`): Unified depth-based coloring used by both regular and digging modes. Six color keyframes map normalized depth (0–1) to layers:
- 0.0 Sand (cream) → 0.2 Clay (rust) → 0.4 Loam (dark brown) → 0.6 Limestone (grey) → 0.8 Slate (teal) → 1.0 Obsidian (black)
- Regular mode: `surfaceH = 1.0`, depth range 0.9. Digging mode: `surfaceH = 2.0`, depth range 1.9.

**Quote reveal**: In `render()`, when depth exceeds 85% and the pixel is a quote pixel, the color blends toward `#e8d5b7` (warm accent).

**Daily rotation**: `getDailyQuote()` picks from a 50-quote array using day-of-year modulo. `buildQuotePixels()` renders the quote with auto-sizing font and word-wrap onto an offscreen canvas, then extracts the alpha channel as a bitmask.

**Exit** (`exitDiggingMode()`): Restores saved garden state, clears undo/redo stacks, re-enables buttons.

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
- Height values: 1.0 = flat sand, <1.0 = groove, >1.0 = rim/pile, clamped to [0.1, 1.5]; digging mode uses 2.0 as surface and carves down to 0.1
