# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Zen Garden Online (silentsand.me) — a physics-based sand garden simulator using HTML5 Canvas. Zero dependencies, no build system, no framework. The entire application lives in a single `index.html` file deployed to GitHub Pages.

## Development

No build step. Open `index.html` in a browser to run. Deploy by pushing to the GitHub Pages branch. The `CNAME` file maps to `silentsand.me`.

## Architecture

### Single-file structure

Everything (HTML, CSS, JS) is in `index.html` (~1270 lines). This is intentional — the app has no external dependencies and ships as a single static file.

### Data model

Per-pixel typed arrays store the sand simulation state:
- `sandHeight[]` (Float32Array) — elevation at each pixel (range ~0.1–1.5)
- `sandR/G/B[]` (Float32Array) — per-pixel color channels
- `noiseMap[]` (Float32Array) — pre-generated grain texture

Canvas dimensions are set once at load: `W = min(1120, viewportWidth - 40)`, `H = min(630, viewportHeight - 120)`.

### Physics pipeline

1. **`strokeTo()`** — interpolates mouse movement into discrete steps
2. **`carveRake()`** — positions multiple tines along the rake perpendicular
3. **`carveTine()`** — core carving function per tine:
   - Pass 1: Applies height profile from pre-computed LUT (`tineProfile`), blends with existing height, collects displaced sand
   - Pass 2: Distributes displaced sand to three deposit points (70% forward, 15% each side) using a pre-computed gaussian kernel

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

All user-configurable parameters (18 settings) are saved to `localStorage` under key `zenGardenSettings` on every input/change event and restored on load.

### UI structure

Three-tab settings panel (Rake, Image Guide, Tuning) with range sliders. Tuning sliders use `dbg*` ID prefix. The `info-i` class provides hover tooltips on tuning parameters.

## Conventions

- Global state uses `cached*` prefix for values mirrored from DOM sliders
- Tuning/debug parameters use `dbg*` prefix for element IDs
- Color palette: `#1a1a1a` (bg), `#c2a67d` (primary accent), `#5a4a35` (secondary), `#e8d5b7` (light accent)
- Height values: 1.0 = flat sand, <1.0 = groove, >1.0 = rim/pile, clamped to [0.1, 1.5]
