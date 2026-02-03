const canvas = document.getElementById('garden');
const ctx = canvas.getContext('2d');
const clearBtn = document.getElementById('clearBtn');
const undoBtn = document.getElementById('undoBtn');
const redoBtn = document.getElementById('redoBtn');

// --- Undo/Redo System ---
const MAX_UNDO = 10;
const undoStack = [];
const redoStack = [];

function getCurrentState() {
  return {
    h: new Float32Array(sandHeight),
    r: new Float32Array(sandR),
    g: new Float32Array(sandG),
    b: new Float32Array(sandB)
  };
}

function saveState() {
  // Clear redo stack on new action
  redoStack.length = 0;
  
  if (undoStack.length >= MAX_UNDO) {
    undoStack.shift(); // Remove oldest state
  }
  undoStack.push(getCurrentState());
  updateHistoryBtns();
}

function undo() {
  if (undoStack.length === 0) return;
  tlResumeForInteraction();

  // Save current state to redo stack before undoing
  redoStack.push(getCurrentState());

  const state = undoStack.pop();
  sandHeight.set(state.h);
  sandR.set(state.r);
  sandG.set(state.g);
  sandB.set(state.b);

  markFullDirty();
  requestRender();
  updateHistoryBtns();
  tlScheduleIdlePause();
}

function redo() {
  if (redoStack.length === 0) return;
  tlResumeForInteraction();

  // Save current state to undo stack before redoing
  if (undoStack.length >= MAX_UNDO) {
    undoStack.shift();
  }
  undoStack.push(getCurrentState());

  const state = redoStack.pop();
  sandHeight.set(state.h);
  sandR.set(state.r);
  sandG.set(state.g);
  sandB.set(state.b);

  markFullDirty();
  requestRender();
  updateHistoryBtns();
  tlScheduleIdlePause();
}

function updateHistoryBtns() {
  undoBtn.disabled = undoStack.length === 0;
  undoBtn.style.opacity = undoStack.length === 0 ? '0.5' : '1';
  
  redoBtn.disabled = redoStack.length === 0;
  redoBtn.style.opacity = redoStack.length === 0 ? '0.5' : '1';
}

undoBtn.addEventListener('click', undo);
redoBtn.addEventListener('click', redo);
updateHistoryBtns();

// Keyboard shortcuts
const heldKeys = new Set();
document.addEventListener('keydown', (e) => {
  heldKeys.add(e.key.toLowerCase());
  if (e.ctrlKey || e.metaKey) {
    const key = e.key.toLowerCase();
    if (key === 'z') {
      e.preventDefault();
      if (e.shiftKey) {
        redo();
      } else {
        undo();
      }
    } else if (key === 'y') {
      e.preventDefault();
      redo();
    }
  }
  if (e.key.toLowerCase() === 'i' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const guideOverlay = document.getElementById('guideOverlay');
    if (guideOverlay && guideOverlay.src) {
      const guideToggle = document.getElementById('guideToggle');
      guideToggle.checked = !guideToggle.checked;
      guideToggle.dispatchEvent(new Event('change'));
      saveSettings();
    }
  }
});
document.addEventListener('keyup', (e) => {
  heldKeys.delete(e.key.toLowerCase());
});
window.addEventListener('blur', () => heldKeys.clear());

// --- Cached slider values (optimization #3) ---
const cached = {};

let W, H;
let totalPixels;
let sandHeight, sandR, sandG, sandB, noiseMap;
let imageData, imageDataBuf;

function initGarden(width, height) {
  W = width;
  H = height;
  canvas.width = W;
  canvas.height = H;
  
  totalPixels = W * H;
  sandHeight = new Float32Array(totalPixels);
  sandR = new Float32Array(totalPixels);
  sandG = new Float32Array(totalPixels);
  sandB = new Float32Array(totalPixels);
  noiseMap = new Float32Array(totalPixels);
  
  imageData = ctx.createImageData(W, H);
  imageDataBuf = imageData.data;
  
  // Reset dirty tracking for new size
  dirtyMinX = 0; dirtyMinY = 0;
  dirtyMaxX = W - 1; dirtyMaxY = H - 1;
  dirtyEmpty = false;
}

// --- Sand color presets ---
const SAND_COLORS = [
  [210, 190, 160], // cream (default)
  [185, 110, 70],  // terracotta
  [100, 75, 55],   // dark brown
  [160, 160, 155]  // grey
];

// --- Data model ---


// --- Pre-compute gaussian kernel as flat typed arrays ---
const MAX_KERNEL = 81; // (2*4+1)^2 = max possible entries
let gaussDx = new Int8Array(MAX_KERNEL);
let gaussDy = new Int8Array(MAX_KERNEL);
let gaussW = new Float32Array(MAX_KERNEL);
let gaussLen = 0;
let builtSpreadR = -1;

function rebuildGaussKernel() {
  const r = cached.spread;
  if (r === builtSpreadR) return;
  builtSpreadR = r;
  const sigma = r * 0.75;
  const invTwoSigma2 = 1 / (2 * sigma * sigma);
  let count = 0;
  let total = 0;
  for (let sy = -r; sy <= r; sy++) {
    for (let sx = -r; sx <= r; sx++) {
      const d2 = sx * sx + sy * sy;
      if (d2 > r * r) continue;
      const w = Math.exp(-d2 * invTwoSigma2);
      gaussDx[count] = sx;
      gaussDy[count] = sy;
      gaussW[count] = w;
      total += w;
      count++;
    }
  }
  const invTotal = 1 / total;
  for (let i = 0; i < count; i++) gaussW[i] *= invTotal;
  gaussLen = count;
}

// --- Pre-allocated displacement buffers (optimization #4) ---
const MAX_R = 20;
const MAX_DISP = (2 * MAX_R + 1) * (2 * MAX_R + 1);
const dispIdx = new Int32Array(MAX_DISP);
const dispAmount = new Float32Array(MAX_DISP);
const dispSrcR = new Float32Array(MAX_DISP);
const dispSrcG = new Float32Array(MAX_DISP);
const dispSrcB = new Float32Array(MAX_DISP);

// --- Particle system (visual sand scatter) ---
const MAX_PARTICLES = 150;
const partX = new Float32Array(MAX_PARTICLES);
const partY = new Float32Array(MAX_PARTICLES);
const partVX = new Float32Array(MAX_PARTICLES);
const partVY = new Float32Array(MAX_PARTICLES);
const partLife = new Float32Array(MAX_PARTICLES);
const partMaxLife = new Float32Array(MAX_PARTICLES);
const partR = new Float32Array(MAX_PARTICLES);
const partG = new Float32Array(MAX_PARTICLES);
const partB = new Float32Array(MAX_PARTICLES);
let partCount = 0;
let particleLoopRunning = false;
let particleLastTs = 0;

// --- Dirty region tracking (optimization #2) ---
let dirtyMinX, dirtyMinY, dirtyMaxX, dirtyMaxY;
let dirtyEmpty = true;

function markDirty(x, y, radius) {
  const r = Math.ceil(radius);
  const x0 = Math.max(0, Math.floor(x) - r);
  const y0 = Math.max(0, Math.floor(y) - r);
  const x1 = Math.min(W - 1, Math.ceil(x) + r);
  const y1 = Math.min(H - 1, Math.ceil(y) + r);
  if (dirtyEmpty) {
    dirtyMinX = x0; dirtyMinY = y0;
    dirtyMaxX = x1; dirtyMaxY = y1;
    dirtyEmpty = false;
  } else {
    if (x0 < dirtyMinX) dirtyMinX = x0;
    if (y0 < dirtyMinY) dirtyMinY = y0;
    if (x1 > dirtyMaxX) dirtyMaxX = x1;
    if (y1 > dirtyMaxY) dirtyMaxY = y1;
  }
}

function markFullDirty() {
  dirtyMinX = 0; dirtyMinY = 0;
  dirtyMaxX = W - 1; dirtyMaxY = H - 1;
  dirtyEmpty = false;
}

function resetDirty() {
  dirtyEmpty = true;
}

// --- rAF render coalescing (optimization #1) ---
let renderScheduled = false;
function requestRender() {
  if (!renderScheduled) {
    renderScheduled = true;
    requestAnimationFrame(() => { renderScheduled = false; render(); });
  }
}

// --- Slider config (single source of truth) ---
const SLIDER_CONFIG = [
  { id: 'sizeSlider', key: 'tineRadius', parse: parseInt, onChange() { markCursorDirty(); requestRender(); } },
  { id: 'tineSlider', key: 'tineCount', parse: parseInt, labelId: 'tineLabel', onChange() { markCursorDirty(); requestRender(); } },
  { id: 'gapSlider', key: 'gapMul', parse: parseFloat, onChange() { markCursorDirty(); requestRender(); } },
  { id: 'dbgDepth', key: 'depth', parse: parseFloat, labelId: 'dbgDepthLabel', onChange() { tineProfileR = -1; markFullDirty(); requestRender(); } },
  { id: 'dbgRim', key: 'rim', parse: parseFloat, labelId: 'dbgRimLabel', onChange() { tineProfileR = -1; markFullDirty(); requestRender(); } },
  { id: 'dbgLight', key: 'light', parse: parseFloat, labelId: 'dbgLightLabel', onChange() { markFullDirty(); requestRender(); } },
  { id: 'dbgBlend', key: 'blend', parse: parseFloat, labelId: 'dbgBlendLabel' },
  { id: 'dbgStep', key: 'step', parse: parseFloat, labelId: 'dbgStepLabel' },
  { id: 'dbgSpread', key: 'spread', parse: parseInt, labelId: 'dbgSpreadLabel', onChange() { rebuildGaussKernel(); } },
  { id: 'dbgFwdD', key: 'fwdD', parse: parseFloat, labelId: 'dbgFwdDLabel' },
  { id: 'dbgSideD', key: 'sideD', parse: parseFloat, labelId: 'dbgSideDLabel' },
  { id: 'dbgNormD', key: 'normD', parse: parseInt, labelId: 'dbgNormDLabel', onChange() { markFullDirty(); requestRender(); } },
  { id: 'dbgNoise', key: 'noise', parse: parseFloat, labelId: 'dbgNoiseLabel', onChange() { markFullDirty(); requestRender(); } },
];

const sliderEls = {};

function setupSliders() {
  for (const def of SLIDER_CONFIG) {
    const el = document.getElementById(def.id);
    const labelEl = def.labelId ? document.getElementById(def.labelId) : null;
    // Reset to HTML default (override browser autofill)
    el.value = el.getAttribute('value');
    sliderEls[def.key] = { el, labelEl };
    cached[def.key] = def.parse(el.value);
    if (labelEl) labelEl.textContent = el.value;

    el.addEventListener('input', () => {
      cached[def.key] = def.parse(el.value);
      if (labelEl) labelEl.textContent = el.value;
      if (def.onChange) def.onChange();
    });
  }
}

function initSand() {
  const def = SAND_COLORS[0];
  for (let i = 0; i < totalPixels; i++) {
    sandHeight[i] = 1.0;
    sandR[i] = def[0];
    sandG[i] = def[1];
    sandB[i] = def[2];
  }
}

function generateNoiseMap() {
  for (let i = 0; i < totalPixels; i++) {
    const fine = (Math.random() - 0.5) * 10;
    const coarse = Math.random() < 0.03 ? (Math.random() - 0.5) * 16 : 0;
    noiseMap[i] = fine + coarse;
  }
}

function clearSand() {
  saveState(); // Save state before clearing
  tlResumeForInteraction();
  initSand();
  // Add fine random variation for a natural untouched look
  for (let i = 0; i < totalPixels; i++) {
    sandHeight[i] += (Math.random() - 0.5) * 0.3;
    sandHeight[i] = Math.max(0.1, Math.min(1.5, sandHeight[i]));
  }
  generateNoiseMap();
  markFullDirty();
  requestRender();
  tlScheduleIdlePause();
}

// --- Tine helpers ---
function getTineCount() {
  return cached.tineCount;
}

function getRakeTineOffsets(tineRadius) {
  const count = cached.tineCount;
  const spacing = cached.gapMul * tineRadius;
  const offsets = [];
  for (let i = 0; i < count; i++) {
    offsets.push((i - (count - 1) / 2) * spacing);
  }
  return offsets;
}

// --- Mirror symmetry state ---
let mirrorV = false;  // vertical axis (left/right)
let mirrorH = false;  // horizontal axis (top/bottom)
let mirrorD = false;  // diagonal axes (8-way)
let alignCenter = false; // center alignment

// --- Helper for alignment ---
function getPerpAt(x, y) {
  if (alignCenter) {
    const dx = x - W / 2;
    const dy = y - H / 2;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len > 0.001) {
      return [dx / len, dy / len];
    }
    return [1, 0];
  }
  return getRakePerp();
}

// --- Timelapse recording state ---
let tlRecorder = null;
let tlStream = null;
let tlChunks = [];
let tlRecording = false;
let tlStartTime = 0;
let tlIdleTimer = null;
let tlStatusInterval = null;
let tlBlobSize = 0;
let tlCanvas = null;   // offscreen canvas (garden + watermark bar)
let tlCtx = null;
let tlBarH = 0;
const TL_IDLE_DELAY = 2000;
const TL_FPS = 30;
const TL_MAX_BYTES = 500 * 1024 * 1024; // 500MB

// --- Intro animation state ---
let introPlaying = false;
let introAnimId = null;

// --- Drawing state ---
let drawing = false;
let lastX = -1, lastY = -1;
let rakeAngle = 0;
let mouseX = -1, mouseY = -1;
let onCanvas = false;
// Track stroke direction for displacement
let strokeDX = 0, strokeDY = 0;
// Anchor point for axis-lock (Ctrl held)
let anchorX = -1, anchorY = -1;
let lockedAxis = null; // 'x' or 'y' once determined

function getRakePerp() {
  return [Math.cos(rakeAngle), Math.sin(rakeAngle)];
}

function getPos(e) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = W / rect.width;
  const scaleY = H / rect.height;
  if (e.touches) {
    return [
      (e.touches[0].clientX - rect.left) * scaleX,
      (e.touches[0].clientY - rect.top) * scaleY
    ];
  }
  return [
    (e.clientX - rect.left) * scaleX,
    (e.clientY - rect.top) * scaleY
  ];
}

// --- Pre-computed tine height profile LUT ---
let tineProfileR = -1;
let tineProfileDepth = -1;
let tineProfileRim = -1;
let tineProfile = null; // Float32Array, size (2*r+1)²
let tineProfileStride = 0;

function rebuildTineProfile(r) {
  const curDepth = cached.depth;
  const curRim = cached.rim;
  if (r === tineProfileR && curDepth === tineProfileDepth && curRim === tineProfileRim) return;
  tineProfileR = r;
  tineProfileDepth = curDepth;
  tineProfileRim = curRim;
  const side = 2 * r + 1;
  tineProfileStride = side;
  tineProfile = new Float32Array(side * side);
  const rSq = r * r;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const dist2 = dx * dx + dy * dy;
      if (dist2 > rSq) {
        tineProfile[(dy + r) * side + (dx + r)] = -1; // sentinel: outside
        continue;
      }
      const t = Math.sqrt(dist2) / r;
      // Smooth groove: cubic ease for the channel, gentle rim
      let h;
      if (t < 0.6) {
        const u = t / 0.6;
        h = 1.0 - curDepth * (1 - u * u * u);
      } else if (t < 0.85) {
        const u = (t - 0.6) / 0.25;
        h = 1.0 + u * curRim;
      } else {
        const u = (t - 0.85) / 0.15;
        h = (1.0 + curRim) - u * curRim;
      }
      tineProfile[(dy + r) * side + (dx + r)] = h;
    }
  }
}

// --- Sand displacement in carveTine (optimizations #4, #6) ---
function carveTine(x, y, radius, dirX, dirY) {
  const r = Math.floor(radius);
  rebuildTineProfile(r);
  const ix = Math.round(x);
  const iy = Math.round(y);

  // Normalize stroke direction
  const dirLenSq = dirX * dirX + dirY * dirY;
  let ndx = 0, ndy = 0;
  if (dirLenSq > 0.000001) {
    const dirLen = Math.sqrt(dirLenSq);
    ndx = dirX / dirLen;
    ndy = dirY / dirLen;
  }
  // Perpendicular (for side displacement)
  const perpX = -ndy;
  const perpY = ndx;

  // Cache blend value and pre-compute inverse
  const blendTarget = cached.blend;
  const blendInv = 1 - blendTarget;

  // Pass 1: figure out how much sand to remove at each pixel
  let dispCount = 0;

  for (let dy = -r; dy <= r; dy++) {
    const py = iy + dy;
    if (py < 0 || py >= H) continue;
    const rowBase = py * W;
    const profileRowBase = (dy + r) * tineProfileStride + r;
    for (let dx = -r; dx <= r; dx++) {
      const px = ix + dx;
      if (px < 0 || px >= W) continue;

      const targetHeight = tineProfile[profileRowBase + dx];
      if (targetHeight < 0) continue; // outside radius

      const idx = rowBase + px;
      const currentH = sandHeight[idx];

      const blended = currentH * blendInv + targetHeight * blendTarget;
      if (currentH > blended) {
        const displaced = currentH - blended;
        dispIdx[dispCount] = idx;
        dispAmount[dispCount] = displaced;
        dispSrcR[dispCount] = sandR[idx];
        dispSrcG[dispCount] = sandG[idx];
        dispSrcB[dispCount] = sandB[idx];
        dispCount++;
        sandHeight[idx] = blended;
      }
    }
  }

  // Mark the carve area dirty
  markDirty(ix, iy, r + 2);

  // Pass 2: distribute displaced sand using flat gaussian kernel arrays
  const fwdDist = r * cached.fwdD;
  const sideDist = r * cached.sideD;
  const spreadR = cached.spread;
  // Deposit spread radius for dirty marking
  const depositMarkR = spreadR + 2;
  // Interior bounds — if deposit center is inside these, all kernel entries are in-bounds
  const interiorMinX = spreadR;
  const interiorMinY = spreadR;
  const interiorMaxX = W - 1 - spreadR;
  const interiorMaxY = H - 1 - spreadR;
  const kLen = gaussLen;

  for (let i = 0; i < dispCount; i++) {
    const srcIdx = dispIdx[i];
    const displaced = dispAmount[i];
    const sR = dispSrcR[i];
    const sG = dispSrcG[i];
    const sB = dispSrcB[i];
    const srcPx = srcIdx % W;
    const srcPy = (srcIdx - srcPx) / W;

    // 3 deposit centers inlined (forward, sideA, sideB)
    const depCX0 = Math.round(srcPx + ndx * fwdDist);
    const depCY0 = Math.round(srcPy + ndy * fwdDist);
    const depAmt0 = displaced * 0.70;

    const depCX1 = Math.round(srcPx + perpX * sideDist);
    const depCY1 = Math.round(srcPy + perpY * sideDist);
    const depAmt1 = displaced * 0.15;

    const depCX2 = Math.round(srcPx - perpX * sideDist);
    const depCY2 = Math.round(srcPy - perpY * sideDist);
    const depAmt2 = displaced * 0.15;

    // Process each deposit center
    for (let depI = 0; depI < 3; depI++) {
      let cx, cy, amount;
      if (depI === 0) { cx = depCX0; cy = depCY0; amount = depAmt0; }
      else if (depI === 1) { cx = depCX1; cy = depCY1; amount = depAmt1; }
      else { cx = depCX2; cy = depCY2; amount = depAmt2; }

      // Fast-path: interior deposits skip the clippedTotal loop
      const isInterior = cx >= interiorMinX && cx <= interiorMaxX &&
                         cy >= interiorMinY && cy <= interiorMaxY;
      let invClipped = 1.0;
      if (!isInterior) {
        let clippedTotal = 0;
        for (let ki = 0; ki < kLen; ki++) {
          const px = cx + gaussDx[ki];
          const py = cy + gaussDy[ki];
          if (px >= 0 && px < W && py >= 0 && py < H) {
            clippedTotal += gaussW[ki];
          }
        }
        if (clippedTotal < 0.001) continue;
        invClipped = 1 / clippedTotal;
      }

      for (let ki = 0; ki < kLen; ki++) {
        const px = cx + gaussDx[ki];
        const py = cy + gaussDy[ki];
        if (px < 0 || px >= W || py < 0 || py >= H) continue;

        const frac = gaussW[ki] * invClipped;
        const cellAmount = amount * frac;
        const cellIdx = py * W + px;
        const destH = sandHeight[cellIdx];
        const totalH = Math.min(destH + cellAmount, 1.5);
        const added = totalH - destH;

        if (added > 0.0001 && totalH > 0.001) {
          sandR[cellIdx] = (sandR[cellIdx] * destH + sR * added) / totalH;
          sandG[cellIdx] = (sandG[cellIdx] * destH + sG * added) / totalH;
          sandB[cellIdx] = (sandB[cellIdx] * destH + sB * added) / totalH;
        }
        sandHeight[cellIdx] = totalH;
      }

      markDirty(cx, cy, depositMarkR);
    }
  }

  // Spawn sand particles from displaced pixels
  spawnParticles(ix, iy, ndx, ndy, dispCount);
}

// --- Particle functions ---
function spawnParticles(x, y, dirX, dirY, dispCount) {
  if (dispCount === 0) return;
  // Sample a small fraction of displaced pixels
  const sampleRate = 0.04;
  const maxSpawn = 5;
  const count = Math.min(maxSpawn, Math.ceil(dispCount * sampleRate));
  const step = Math.max(1, Math.floor(dispCount / count));

  for (let s = 0; s < count; s++) {
    if (partCount >= MAX_PARTICLES) break;
    const di = (s * step) % dispCount;
    const idx = dispIdx[di];
    const amt = dispAmount[di];
    if (amt < 0.01) continue;

    const px = idx % W;
    const py = (idx - px) / W;

    // Random angular jitter (-45 to +45 degrees from stroke direction)
    const jitter = (Math.random() - 0.5) * Math.PI * 0.5;
    const cosJ = Math.cos(jitter);
    const sinJ = Math.sin(jitter);
    const speed = (1.5 + Math.random() * 2) * Math.min(amt * 4, 1);
    // If stroke direction is zero (mousedown), scatter radially
    let baseX = dirX, baseY = dirY;
    if (dirX === 0 && dirY === 0) {
      const angle = Math.random() * Math.PI * 2;
      baseX = Math.cos(angle);
      baseY = Math.sin(angle);
    }
    const vx = (baseX * cosJ - baseY * sinJ) * speed;
    const vy = (baseX * sinJ + baseY * cosJ) * speed;

    const i = partCount;
    partX[i] = px;
    partY[i] = py;
    partVX[i] = vx;
    partVY[i] = vy;
    const life = 200 + Math.random() * 200; // 200-400ms
    partLife[i] = life;
    partMaxLife[i] = life;
    partR[i] = dispSrcR[di];
    partG[i] = dispSrcG[di];
    partB[i] = dispSrcB[di];
    partCount++;
  }

  // Kick off animation loop if not already running
  if (partCount > 0 && !particleLoopRunning) {
    particleLoopRunning = true;
    particleLastTs = performance.now();
    requestAnimationFrame(particleTick);
  }
}

function updateParticles(dt) {
  const friction = Math.pow(0.92, dt / 16.67); // normalize friction to ~60fps
  let i = 0;
  while (i < partCount) {
    partLife[i] -= dt;
    if (partLife[i] <= 0) {
      // Swap-remove: move last particle into this slot
      partCount--;
      if (i < partCount) {
        partX[i] = partX[partCount];
        partY[i] = partY[partCount];
        partVX[i] = partVX[partCount];
        partVY[i] = partVY[partCount];
        partLife[i] = partLife[partCount];
        partMaxLife[i] = partMaxLife[partCount];
        partR[i] = partR[partCount];
        partG[i] = partG[partCount];
        partB[i] = partB[partCount];
      }
      continue; // re-check this index (now holds swapped particle)
    }
    // Mark old position dirty (erase previous frame's drawing)
    markDirty(partX[i], partY[i], 4);
    // Apply friction and advance
    partVX[i] *= friction;
    partVY[i] *= friction;
    partX[i] += partVX[i] * (dt / 16.67);
    partY[i] += partVY[i] * (dt / 16.67);
    // Mark new position dirty
    markDirty(partX[i], partY[i], 4);
    i++;
  }
}

function particleTick(ts) {
  if (partCount === 0) {
    particleLoopRunning = false;
    return;
  }
  const dt = Math.min(ts - particleLastTs, 50); // cap to avoid spiral
  particleLastTs = ts;
  updateParticles(dt);
  requestRender();
  requestAnimationFrame(particleTick);
}

function getSymmetryPoints(x, y, dirX, dirY, perpX, perpY) {
  let pts = [{x, y, dirX, dirY, perpX, perpY}];
  if (mirrorV) {
    const len = pts.length;
    for (let i = 0; i < len; i++) {
      const p = pts[i];
      pts.push({x: (W - 1) - p.x, y: p.y, dirX: -p.dirX, dirY: p.dirY, perpX: -p.perpX, perpY: p.perpY});
    }
  }
  if (mirrorH) {
    const len = pts.length;
    for (let i = 0; i < len; i++) {
      const p = pts[i];
      pts.push({x: p.x, y: H - p.y, dirX: p.dirX, dirY: -p.dirY, perpX: p.perpX, perpY: -p.perpY});
    }
  }
  if (mirrorD) {
    const hw = W / 2, hh = H / 2;
    const ar = W / H, iar = H / W;
    const len = pts.length;
    for (let i = 0; i < len; i++) {
      const p = pts[i];
      // Normalize to [-1,1], swap, denormalize
      const nx = (p.x - hw) / hw;
      const ny = (p.y - hh) / hh;
      const sx = ny * hw + hw;
      const sy = nx * hh + hh;
      // Transform direction
      let sdx = p.dirY * ar;
      let sdy = p.dirX * iar;
      const dlen = Math.sqrt(sdx * sdx + sdy * sdy);
      if (dlen > 0.0001) { sdx /= dlen; sdy /= dlen; const olen = Math.sqrt(p.dirX * p.dirX + p.dirY * p.dirY); sdx *= olen; sdy *= olen; }
      // Transform perpendicular
      let spx = p.perpY * ar;
      let spy = p.perpX * iar;
      const plen = Math.sqrt(spx * spx + spy * spy);
      if (plen > 0.0001) { spx /= plen; spy /= plen; const olen = Math.sqrt(p.perpX * p.perpX + p.perpY * p.perpY); spx *= olen; spy *= olen; }
      pts.push({x: sx, y: sy, dirX: sdx, dirY: sdy, perpX: spx, perpY: spy});
    }
  }
  // Deduplicate points within 1px
  const deduped = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    let dup = false;
    for (let j = 0; j < deduped.length; j++) {
      const dx = pts[i].x - deduped[j].x;
      const dy = pts[i].y - deduped[j].y;
      if (dx * dx + dy * dy < 1) { dup = true; break; }
    }
    if (!dup) deduped.push(pts[i]);
  }
  return deduped;
}

function carveRakeSymmetric(x, y, tineRadius, dirX, dirY) {
  if (!mirrorV && !mirrorH && !mirrorD) {
    // Check alignment for non-symmetric case too
    const [px, py] = getPerpAt(x, y);
    carveRake(x, y, tineRadius, dirX, dirY, px, py);
    return;
  }
  const [perpX, perpY] = getPerpAt(x, y);
  const points = getSymmetryPoints(x, y, dirX, dirY, perpX, perpY);
  for (const p of points) {
    carveRake(p.x, p.y, tineRadius, p.dirX, p.dirY, p.perpX, p.perpY);
  }
}

function carveRake(x, y, tineRadius, dirX, dirY, overridePerpX, overridePerpY) {
  const offsets = getRakeTineOffsets(tineRadius);
  const perpX = overridePerpX !== undefined ? overridePerpX : getRakePerp()[0];
  const perpY = overridePerpY !== undefined ? overridePerpY : getRakePerp()[1];

  for (const offset of offsets) {
    const tx = x + perpX * offset;
    const ty = y + perpY * offset;
    carveTine(tx, ty, tineRadius, dirX, dirY);
  }
}

// --- Render timing ---
let carveTimeAccum = 0;
let lastRenderTime = 0;
let lastFrameTs = 0;
let lastFps = 0;

// --- Render (optimization #2: dirty-region, #5: reused ImageData) ---
function render() {
  const renderStart = performance.now();
  const d = imageDataBuf;
  const lightX = -0.7;
  const lightY = -0.7;

  // Cache slider values for this frame
  const lightMul = cached.light;
  const noiseMul = cached.noise;
  const normD = cached.normD;
  const normDW = normD * W;
  const invNormD2 = 1 / (normD * 2);

  // Expand dirty rect by normD+1 for normal sampling neighbors
  const normPad = normD + 1;
  const rMinX = Math.max(0, dirtyMinX - normPad);
  const rMinY = Math.max(0, dirtyMinY - normPad);
  const rMaxX = Math.min(W - 1, dirtyMaxX + normPad);
  const rMaxY = Math.min(H - 1, dirtyMaxY + normPad);

  if (!dirtyEmpty) {
    for (let y = rMinY; y <= rMaxY; y++) {
      const yW = y * W;
      for (let x = rMinX; x <= rMaxX; x++) {
        const idx = yW + x;
        const pi = idx << 2;

        const h = sandHeight[idx];
        const baseR = sandR[idx];
        const baseG = sandG[idx];
        const baseB = sandB[idx];

        let lighting = 1.0;
        if (x >= normD && x < W - normD && y >= normD && y < H - normD) {
          const dhdx = (sandHeight[idx + normD] - sandHeight[idx - normD]) * invNormD2;
          const dhdy = (sandHeight[idx + normDW] - sandHeight[idx - normDW]) * invNormD2;
          const dot = -(dhdx * lightX + dhdy * lightY);
          lighting = 1.0 + dot * lightMul;
        }

        const heightBrightness = 0.82 + 0.18 * (h < 0 ? 0 : h > 2 ? 2 : h);
        const shade = lighting * heightBrightness;
        const noise = noiseMap[idx] * shade * noiseMul;

        // Uint8ClampedArray auto-clamps to [0, 255] — no Math.max/min needed
        d[pi]     = baseR * shade + noise;
        d[pi + 1] = baseG * shade + noise;
        d[pi + 2] = baseB * shade + noise;
        d[pi + 3] = 255;
      }
    }

    // Blit only the dirty region
    const dw = rMaxX - rMinX + 1;
    const dh = rMaxY - rMinY + 1;
    ctx.putImageData(imageData, 0, 0, rMinX, rMinY, dw, dh);
  }

  // Draw sand particles
  if (partCount > 0) {
    ctx.save();
    for (let i = 0; i < partCount; i++) {
      const alpha = partLife[i] / partMaxLife[i];
      const size = 1.5 * (0.4 + 0.6 * alpha); // 0.6–1.5px
      ctx.globalAlpha = alpha * 0.5;
      // Slight brightness lift so particles read against sand
      const bright = 1.12;
      const r = Math.min(255, (partR[i] * bright) | 0);
      const g = Math.min(255, (partG[i] * bright) | 0);
      const b = Math.min(255, (partB[i] * bright) | 0);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.beginPath();
      ctx.arc(partX[i], partY[i], size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  resetDirty();

  // Mark cursor area dirty for NEXT frame so putImageData erases this overlay
  markCursorDirty();

  // Draw cursor(s)
  if (onCanvas) {
    ctx.save();
    const tineRadius = cached.tineRadius;
    const offsets = getRakeTineOffsets(tineRadius);
    const [perpX, perpY] = getPerpAt(mouseX, mouseY);

    function drawCursorAt(cx, cy, px, py, strokeAlpha, fillAlpha) {
      ctx.strokeStyle = `rgba(80, 60, 40, ${strokeAlpha})`;
      ctx.fillStyle = `rgba(80, 60, 40, ${fillAlpha})`;
      ctx.lineWidth = 1;
      for (const offset of offsets) {
        const tx = cx + px * offset;
        const ty = cy + py * offset;
        ctx.beginPath();
        ctx.arc(tx, ty, tineRadius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fill();
      }
      if (offsets.length > 1) {
        ctx.strokeStyle = `rgba(80, 60, 40, ${strokeAlpha * 0.7})`;
        ctx.lineWidth = 2;
        const first = offsets[0];
        const last = offsets[offsets.length - 1];
        ctx.beginPath();
        ctx.moveTo(cx + px * first, cy + py * first);
        ctx.lineTo(cx + px * last, cy + py * last);
        ctx.stroke();
      }
    }

    // Primary cursor
    drawCursorAt(mouseX, mouseY, perpX, perpY, 0.35, 0.2);

    // Mirror ghost cursors
    if (mirrorV || mirrorH || mirrorD) {
      const pts = getSymmetryPoints(mouseX, mouseY, 0, 0, perpX, perpY);
      for (let i = 1; i < pts.length; i++) {
        drawCursorAt(pts[i].x, pts[i].y, pts[i].perpX, pts[i].perpY, 0.15, 0.08);
      }
    }
    ctx.restore();
  }

  // Draw watermark for timelapse recording
  tlDrawWatermark();

  // Update performance readout
  const renderEnd = performance.now();
  carveTimeAccum = 0;
}

// --- Stroke handling ---
function strokeTo(x, y) {
  const tineRadius = cached.tineRadius;
  const stepFrac = cached.step;
  const dx = x - lastX;
  const dy = y - lastY;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < 1) return;

  strokeDX = dx;
  strokeDY = dy;

  const steps = Math.max(1, Math.floor(dist / Math.max(1, tineRadius * stepFrac)));

  const carveStart = performance.now();
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const cx = lastX + dx * t;
    const cy = lastY + dy * t;
    carveRakeSymmetric(cx, cy, tineRadius, strokeDX, strokeDY);
  }
  carveTimeAccum += performance.now() - carveStart;

  lastX = x;
  lastY = y;
}

// --- Cursor dirty helper ---
function markCursorDirty() {
  if (!onCanvas) return;
  const tineRadius = cached.tineRadius;
  const offsets = getRakeTineOffsets(tineRadius);
  const [px, py] = getPerpAt(mouseX, mouseY);

  function markCursorAt(cx, cy, cpx, cpy) {
    for (const offset of offsets) {
      markDirty(cx + cpx * offset, cy + cpy * offset, tineRadius + 2);
    }
  }

  markCursorAt(mouseX, mouseY, px, py);

  if (mirrorV || mirrorH || mirrorD) {
    const pts = getSymmetryPoints(mouseX, mouseY, 0, 0, px, py);
    for (let i = 1; i < pts.length; i++) {
      markCursorAt(pts[i].x, pts[i].y, pts[i].perpX, pts[i].perpY);
    }
  }
}

// Constrain point to horizontal or vertical axis from anchor
function axisLock(x, y) {
  if (!lockedAxis) {
    const adx = Math.abs(x - anchorX), ady = Math.abs(y - anchorY);
    if (adx < 3 && ady < 3) return [anchorX, anchorY]; // not enough movement yet
    lockedAxis = adx >= ady ? 'x' : 'y';
  }
  return lockedAxis === 'x' ? [x, anchorY] : [anchorX, y];
}

// Mouse events
canvas.addEventListener('mousedown', (e) => {
  if (e.target !== canvas) return;
  if (introPlaying) { abortIntro(); return; }
  saveState(); // Save state before stroke
  drawing = true;
  tlResumeForInteraction();
  const [x, y] = getPos(e);
  lastX = x; lastY = y;
  anchorX = x; anchorY = y;
  lockedAxis = null;
  strokeDX = 0; strokeDY = 0;
  const carveStart = performance.now();
  carveRakeSymmetric(x, y, cached.tineRadius, 0, 0);
  carveTimeAccum += performance.now() - carveStart;
  requestRender();
});

canvas.addEventListener('mousemove', (e) => {
  if (introPlaying) return;
  let [x, y] = getPos(e);
  if (e.ctrlKey && drawing) [x, y] = axisLock(x, y);
  // Mark old cursor position dirty so it gets repainted clean
  markCursorDirty();
  mouseX = x; mouseY = y;
  onCanvas = true;
  if (drawing) {
    strokeTo(x, y);
  }
  // Mark new cursor position dirty
  markCursorDirty();
  requestRender();
});

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (introPlaying) return;
  const dir = e.deltaY > 0 ? -1 : 1;
  const wheelSliderKey = heldKeys.has('t') ? 'tineCount' : heldKeys.has('g') ? 'gapMul' : heldKeys.has('s') ? 'tineRadius' : null;
  if (wheelSliderKey) {
    markCursorDirty(); // mark old cursor area before cached values change
    const { el, labelEl } = sliderEls[wheelSliderKey];
    const step = parseFloat(el.step) || 1;
    const newVal = Math.min(parseFloat(el.max), Math.max(parseFloat(el.min), parseFloat(el.value) + dir * step));
    el.value = newVal;
    el.dispatchEvent(new Event('input'));
    saveSettings();
  } else {
    markCursorDirty();
    const step = Math.PI / 8; // 22.5 degrees
    rakeAngle += dir * step;
    rakeAngle = Math.round(rakeAngle / step) * step;
  }
  markCursorDirty();
  requestRender();
}, { passive: false });

canvas.addEventListener('mouseup', () => { drawing = false; tlScheduleIdlePause(); });
canvas.addEventListener('mouseleave', () => {
  markCursorDirty();
  drawing = false;
  onCanvas = false;
  requestRender();
});
canvas.addEventListener('mouseenter', () => {
  if (!introPlaying) onCanvas = true;
});

// Touch events
canvas.addEventListener('touchstart', (e) => {
  if (e.target !== canvas) return;
  e.preventDefault();
  if (introPlaying) { abortIntro(); return; }
  saveState(); // Save state before stroke
  drawing = true;
  tlResumeForInteraction();
  const [x, y] = getPos(e);
  lastX = x; lastY = y;
  anchorX = x; anchorY = y;
  lockedAxis = null;
  mouseX = x; mouseY = y;
  onCanvas = true;
  strokeDX = 0; strokeDY = 0;
  const carveStart = performance.now();
  carveRakeSymmetric(x, y, cached.tineRadius, 0, 0);
  carveTimeAccum += performance.now() - carveStart;
  requestRender();
});

canvas.addEventListener('touchmove', (e) => {
  e.preventDefault();
  const [x, y] = getPos(e);
  markCursorDirty();
  mouseX = x; mouseY = y;
  if (drawing) {
    strokeTo(x, y);
  }
  markCursorDirty();
  requestRender();
});

canvas.addEventListener('touchend', (e) => {
  e.preventDefault();
  markCursorDirty();
  drawing = false;
  tlScheduleIdlePause();
  onCanvas = false;
  requestRender();
});

clearBtn.addEventListener('click', clearSand);

const settingsBtn = document.getElementById('settingsBtn');
const settingsPanel = document.getElementById('settingsPanel');
settingsBtn.addEventListener('click', () => {
  const open = !settingsPanel.classList.contains('collapsed');
  settingsPanel.classList.toggle('collapsed', open);
  settingsBtn.classList.toggle('active', !open);
  settingsBtn.textContent = open ? '\u25B2' : '\u25BC';
});

// --- Guide Image Overlay ---
const guideOverlay = document.getElementById('guideOverlay');
const guideUpload = document.getElementById('guideUpload');
const guideBtn = document.getElementById('guideBtn');
const guideOpacity = document.getElementById('guideOpacity');
const guideToggle = document.getElementById('guideToggle');
const guideZoom = document.getElementById('guideZoom');
const guideX = document.getElementById('guideX');
const guideY = document.getElementById('guideY');

const guideBW = document.getElementById('guideBW');
const guideThreshold = document.getElementById('guideThreshold');
const guideThresholdGroup = document.getElementById('guideThresholdGroup');
let guideOriginalSrc = ''; // stores the original (unprocessed) data URL

guideBtn.addEventListener('click', () => guideUpload.click());

guideUpload.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (evt) => {
    guideOriginalSrc = evt.target.result;
    if (guideBW.checked) {
      applyGuideBW();
    } else {
      guideOverlay.src = guideOriginalSrc;
    }
    // If opacity is 0 (default), set it to 50% so the user sees the image immediately
    if (guideOpacity.value === '0') {
      guideOpacity.value = 50;
      guideOverlay.style.opacity = '0.5';
    }
  };
  reader.readAsDataURL(file);
});

function applyGuideBW() {
  if (!guideOriginalSrc) return;
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const cx = c.getContext('2d');
    cx.drawImage(img, 0, 0);
    const id = cx.getImageData(0, 0, c.width, c.height);
    const d = id.data;
    const thresh = parseInt(guideThreshold.value);
    for (let i = 0; i < d.length; i += 4) {
      const gray = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
      const v = gray >= thresh ? 255 : 0;
      d[i] = v;
      d[i + 1] = v;
      d[i + 2] = v;
    }
    cx.putImageData(id, 0, 0);
    guideOverlay.src = c.toDataURL();
  };
  img.src = guideOriginalSrc;
}

guideBW.addEventListener('change', () => {
  guideThresholdGroup.style.display = guideBW.checked ? 'flex' : 'none';
  if (guideBW.checked) {
    applyGuideBW();
  } else if (guideOriginalSrc) {
    guideOverlay.src = guideOriginalSrc;
  }
  saveSettings();
});

guideThreshold.addEventListener('input', () => {
  if (guideBW.checked) applyGuideBW();
  saveSettings();
});

guideOpacity.addEventListener('input', () => {
  guideOverlay.style.opacity = guideOpacity.value / 100;
});

guideToggle.addEventListener('change', () => {
  guideOverlay.style.display = guideToggle.checked ? 'block' : 'none';
});

function updateGuideTransform() {
  const scale = guideZoom.value / 100;
  const x = guideX.value;
  const y = guideY.value;
  guideOverlay.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
}

guideZoom.addEventListener('input', updateGuideTransform);
guideX.addEventListener('input', updateGuideTransform);
guideY.addEventListener('input', updateGuideTransform);

// --- Tabs ---
const tabBtns = document.querySelectorAll('.tab-btn');
const tabContents = document.querySelectorAll('.tab-content');

tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    tabBtns.forEach(b => b.classList.remove('active'));
    tabContents.forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.tab).classList.add('active');
  });
});

// --- Mirror toggles ---
const mirrorVBtn = document.getElementById('mirrorVBtn');
const mirrorHBtn = document.getElementById('mirrorHBtn');
const mirrorDBtn = document.getElementById('mirrorDBtn');
const symmetryLines = document.getElementById('symmetryLines');
const symV = document.getElementById('symV');
const symH = document.getElementById('symH');
const symD1 = document.getElementById('symD1');
const symD2 = document.getElementById('symD2');
const symCenter = document.getElementById('symCenter');

function updateSymmetryLines() {
  const any = mirrorV || mirrorH || mirrorD || alignCenter;
  symmetryLines.style.display = any ? '' : 'none';
  symV.style.display = mirrorV ? '' : 'none';
  symH.style.display = mirrorH ? '' : 'none';
  symD1.style.display = mirrorD ? '' : 'none';
  symD2.style.display = mirrorD ? '' : 'none';
  symCenter.style.display = (any) ? '' : 'none';
}

mirrorVBtn.addEventListener('click', () => {
  mirrorV = !mirrorV;
  mirrorVBtn.classList.toggle('active', mirrorV);
  updateSymmetryLines();
  markCursorDirty();
  requestRender();
  saveSettings();
});

mirrorHBtn.addEventListener('click', () => {
  mirrorH = !mirrorH;
  mirrorHBtn.classList.toggle('active', mirrorH);
  updateSymmetryLines();
  markCursorDirty();
  requestRender();
  saveSettings();
});

mirrorDBtn.addEventListener('click', () => {
  mirrorD = !mirrorD;
  mirrorDBtn.classList.toggle('active', mirrorD);
  updateSymmetryLines();
  markCursorDirty();
  requestRender();
  saveSettings();
});

const alignCenterToggle = document.getElementById('alignCenterToggle');
alignCenterToggle.addEventListener('change', () => {
  alignCenter = alignCenterToggle.checked;
  updateSymmetryLines();
  markCursorDirty();
  requestRender();
  saveSettings();
});

// --- Settings Persistence ---
function saveSettings() {
  const settings = {};
  for (const def of SLIDER_CONFIG) {
    settings[def.key] = sliderEls[def.key].el.value;
  }
  settings.guideShow = guideToggle.checked;
  settings.guideOpacity = guideOpacity.value;
  settings.guideZoom = guideZoom.value;
  settings.guideX = guideX.value;
  settings.guideY = guideY.value;
  settings.guideBW = guideBW.checked;
  settings.guideThreshold = guideThreshold.value;
  settings.mirrorV = mirrorV;
  settings.mirrorH = mirrorH;
  settings.mirrorD = mirrorD;
  settings.alignCenter = alignCenter;
  const tlModeEl = document.getElementById('tlMode');
  if (tlModeEl) settings.tlMode = tlModeEl.value;
  localStorage.setItem('zenGardenSettings', JSON.stringify(settings));
}

function loadSettings() {
  const saved = localStorage.getItem('zenGardenSettings');
  if (!saved) return;
  try {
    const s = JSON.parse(saved);
    for (const def of SLIDER_CONFIG) {
      if (s[def.key] !== undefined) {
        const { el, labelEl } = sliderEls[def.key];
        el.value = s[def.key];
        cached[def.key] = def.parse(el.value);
        if (labelEl) labelEl.textContent = el.value;
      }
    }
    if (s.guideShow !== undefined) guideToggle.checked = s.guideShow;
    if (s.guideOpacity !== undefined) guideOpacity.value = s.guideOpacity;
    if (s.guideZoom !== undefined) guideZoom.value = s.guideZoom;
    if (s.guideX !== undefined) guideX.value = s.guideX;
    if (s.guideY !== undefined) guideY.value = s.guideY;
    if (s.guideBW !== undefined) { guideBW.checked = s.guideBW; guideThresholdGroup.style.display = s.guideBW ? 'flex' : 'none'; }
    if (s.guideThreshold !== undefined) guideThreshold.value = s.guideThreshold;
    guideOverlay.style.display = guideToggle.checked ? 'block' : 'none';
    guideOverlay.style.opacity = guideOpacity.value / 100;
    updateGuideTransform();
    if (s.mirrorV !== undefined) { mirrorV = s.mirrorV; mirrorVBtn.classList.toggle('active', mirrorV); }
    if (s.mirrorH !== undefined) { mirrorH = s.mirrorH; mirrorHBtn.classList.toggle('active', mirrorH); }
    if (s.mirrorD !== undefined) { mirrorD = s.mirrorD; mirrorDBtn.classList.toggle('active', mirrorD); }
    if (s.alignCenter !== undefined) { alignCenter = s.alignCenter; alignCenterToggle.checked = alignCenter; }
    if (s.tlMode !== undefined) { const tlModeEl = document.getElementById('tlMode'); if (tlModeEl) tlModeEl.value = s.tlMode; }
    updateSymmetryLines();
  } catch (e) {
    console.warn('Failed to load settings', e);
  }
}

// Add global listener to save on any input change in settings panel
document.getElementById('settingsPanel').addEventListener('input', saveSettings);
document.getElementById('settingsPanel').addEventListener('change', saveSettings); // for checkbox

// --- IndexedDB Browser Storage ---
const DB_NAME = 'ZenGardenDB';
const DB_VERSION = 1;
const STORE_NAME = 'gardens';

let db;
const openRequest = indexedDB.open(DB_NAME, DB_VERSION);
openRequest.onupgradeneeded = (e) => {
  const db = e.target.result;
  if (!db.objectStoreNames.contains(STORE_NAME)) {
    db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
  }
};
openRequest.onsuccess = (e) => {
  db = e.target.result;
  refreshSaveList();
};

async function saveToBrowser(name) {
  if (!db) return;
  const gardenData = {
    name: name || `Garden ${new Date().toLocaleTimeString()}`,
    date: Date.now(),
    w: W,
    h: H,
    sandHeight: new Float32Array(sandHeight),
    sandR: new Float32Array(sandR),
    sandG: new Float32Array(sandG),
    sandB: new Float32Array(sandB)
  };

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.add(gardenData);
    tx.oncomplete = () => {
      refreshSaveList();
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}

async function loadFromBrowser(id) {
  if (!db) return;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(id);
    request.onsuccess = () => {
      const data = request.result;
      if (!data) return reject("Save not found");

      // Use existing initGarden logic
      initGarden(data.w, data.h);
      sandHeight.set(data.sandHeight);
      sandR.set(data.sandR);
      sandG.set(data.sandG);
      sandB.set(data.sandB);
      
      generateNoiseMap();
      undoStack.length = 0;
      redoStack.length = 0;
      updateHistoryBtns();
      markFullDirty();
      requestRender();
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
}

async function deleteFromBrowser(id) {
  if (!db) return;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.delete(id);
    tx.oncomplete = () => {
      refreshSaveList();
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}

async function refreshSaveList() {
  const listEl = document.getElementById('saveList');
  if (!listEl || !db) return;

  const tx = db.transaction(STORE_NAME, 'readonly');
  const store = tx.objectStore(STORE_NAME);
  const request = store.getAll();

  request.onsuccess = () => {
    const saves = request.result.sort((a, b) => b.date - a.date);
    if (saves.length === 0) {
      listEl.innerHTML = '<div style="text-align: center; color: #5a4a35; font-size: 12px; padding: 20px;">No saved gardens yet</div>';
      return;
    }

    listEl.innerHTML = '';
    saves.forEach(save => {
      const item = document.createElement('div');
      item.className = 'save-item';
      const dateStr = new Date(save.date).toLocaleString();
      item.innerHTML = `
        <div class="save-info">
          <div class="save-name">${save.name}</div>
          <div class="save-date">${dateStr} • ${save.w}x${save.h}</div>
        </div>
        <div class="save-actions">
          <button class="load-browser-btn" data-id="${save.id}">Load</button>
          <button class="delete-btn" data-id="${save.id}">Delete</button>
        </div>
      `;
      listEl.appendChild(item);
    });

    // Wire up buttons
    listEl.querySelectorAll('.load-browser-btn').forEach(btn => {
      btn.onclick = () => loadFromBrowser(Number(btn.dataset.id));
    });
    listEl.querySelectorAll('.delete-btn').forEach(btn => {
      btn.onclick = () => {
        if (confirm("Delete this save?")) deleteFromBrowser(Number(btn.dataset.id));
      };
    });
  };
}

const quickSaveBtn = document.getElementById('quickSaveBtn');
const saveNameInput = document.getElementById('saveNameInput');

quickSaveBtn.onclick = async () => {
  const name = saveNameInput.value.trim();
  quickSaveBtn.disabled = true;
  quickSaveBtn.textContent = 'Saving...';
  try {
    await saveToBrowser(name);
    saveNameInput.value = '';
  } catch (e) {
    alert("Save failed: " + e.message);
  } finally {
    quickSaveBtn.disabled = false;
    quickSaveBtn.textContent = 'Quick Save';
  }
};

// --- Timelapse Recording ---
const tlRecordBtn = document.getElementById('tlRecordBtn');
const tlModeSelect = document.getElementById('tlMode');
const tlStatusEl = document.getElementById('tlStatus');
const tlDot = document.getElementById('tlDot');

function tlDrawWatermark() {
  if (!tlRecording || !tlCtx) return;
  const barH = tlBarH;
  tlCtx.save();
  // Dark bar at top
  tlCtx.fillStyle = '#1a1a1a';
  tlCtx.fillRect(0, 0, W, barH);
  // Subtle bottom edge
  tlCtx.fillStyle = 'rgba(90, 74, 53, 0.25)';
  tlCtx.fillRect(0, barH - 1, W, 1);
  // Text
  const fontSize = Math.max(14, Math.round(barH * 0.5));
  tlCtx.font = `300 ${fontSize}px "Segoe UI", system-ui, sans-serif`;
  tlCtx.fillStyle = 'rgba(220, 195, 155, 0.95)';
  tlCtx.textAlign = 'center';
  tlCtx.textBaseline = 'middle';
  tlCtx.shadowColor = 'rgba(0, 0, 0, 0.4)';
  tlCtx.shadowBlur = 3;
  tlCtx.fillText('S I L E N T S A N D . M E', W / 2, barH / 2);
  tlCtx.restore();
  // Copy the main canvas below the watermark bar
  tlCtx.drawImage(canvas, 0, barH);
}

function tlGetMimeType() {
  const types = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm'
  ];
  for (const t of types) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';
}

function tlStart() {
  if (typeof MediaRecorder === 'undefined' || !canvas.captureStream) {
    tlStatusEl.textContent = 'Not supported';
    return;
  }

  tlChunks = [];
  tlBlobSize = 0;

  // Create offscreen canvas: garden + watermark bar below
  tlBarH = Math.max(32, Math.round(H * 0.065));
  tlCanvas = document.createElement('canvas');
  tlCanvas.width = W;
  tlCanvas.height = H + tlBarH;
  tlCtx = tlCanvas.getContext('2d');

  tlStream = tlCanvas.captureStream(TL_FPS);
  const mimeType = tlGetMimeType();
  const options = mimeType ? { mimeType } : {};

  try {
    tlRecorder = new MediaRecorder(tlStream, options);
  } catch (e) {
    tlStatusEl.textContent = 'Not supported';
    return;
  }

  tlRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) {
      tlChunks.push(e.data);
      tlBlobSize += e.data.size;
      if (tlBlobSize >= TL_MAX_BYTES) {
        tlStatusEl.textContent = 'Max size reached';
        tlStop();
      }
    }
  };

  tlRecorder.onstop = tlFinalize;

  tlRecorder.start(1000); // collect data every second
  tlRecording = true;
  tlStartTime = Date.now();

  tlRecordBtn.textContent = 'Stop';
  tlRecordBtn.classList.add('recording');
  tlDot.style.display = 'inline-block';

  // In interaction mode, pause immediately until user draws
  if (tlModeSelect.value === 'interaction') {
    tlRecorder.pause();
  }

  tlStatusInterval = setInterval(tlUpdateStatus, 500);
  tlUpdateStatus();
  markFullDirty();
  requestRender();
}

function tlStop() {
  if (!tlRecorder || !tlRecording) return;
  tlRecording = false;

  clearInterval(tlStatusInterval);
  clearTimeout(tlIdleTimer);
  tlStatusInterval = null;
  tlIdleTimer = null;

  if (tlRecorder.state !== 'inactive') {
    tlRecorder.stop();
  }

  if (tlStream) {
    tlStream.getTracks().forEach(t => t.stop());
    tlStream = null;
  }

  tlCanvas = null;
  tlCtx = null;
  tlBarH = 0;

  tlRecordBtn.textContent = 'Record';
  tlRecordBtn.classList.remove('recording');
  tlDot.style.display = 'none';
  tlStatusEl.textContent = '';
  markFullDirty();
  requestRender();
}

function tlFinalize() {
  if (tlChunks.length === 0) return;
  const blob = new Blob(tlChunks, { type: tlRecorder ? tlRecorder.mimeType : 'video/webm' });
  tlChunks = [];

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const filename = `zen-garden-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.webm`;

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function tlUpdateStatus() {
  if (!tlRecording) return;
  const elapsed = Math.floor((Date.now() - tlStartTime) / 1000);
  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const ss = String(elapsed % 60).padStart(2, '0');
  let text = `${mm}:${ss}`;
  if (tlModeSelect.value === 'interaction' && tlRecorder && tlRecorder.state === 'paused') {
    text += ' (paused)';
  }
  tlStatusEl.textContent = text;
}

function tlResumeForInteraction() {
  if (!tlRecording || tlModeSelect.value !== 'interaction') return;
  clearTimeout(tlIdleTimer);
  tlIdleTimer = null;
  if (tlRecorder && tlRecorder.state === 'paused') {
    tlRecorder.resume();
  }
}

function tlScheduleIdlePause() {
  if (!tlRecording || tlModeSelect.value !== 'interaction') return;
  clearTimeout(tlIdleTimer);
  tlIdleTimer = setTimeout(() => {
    if (tlRecording && tlRecorder && tlRecorder.state === 'recording') {
      tlRecorder.pause();
    }
  }, TL_IDLE_DELAY);
}

tlRecordBtn.addEventListener('click', () => {
  if (tlRecording) {
    tlStop();
  } else {
    tlStart();
  }
});

tlModeSelect.addEventListener('change', () => {
  saveSettings();
  if (!tlRecording) return;
  if (tlModeSelect.value === 'interaction') {
    // Switch to interaction mode: schedule pause if idle
    tlScheduleIdlePause();
  } else {
    // Switch to continuous: resume if paused
    clearTimeout(tlIdleTimer);
    tlIdleTimer = null;
    if (tlRecorder && tlRecorder.state === 'paused') {
      tlRecorder.resume();
    }
  }
});

// Edge case: warn on page close while recording
window.addEventListener('beforeunload', (e) => {
  if (tlRecording) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// Edge case: pause on tab hidden (interaction mode)
document.addEventListener('visibilitychange', () => {
  if (!tlRecording) return;
  if (document.hidden && tlModeSelect.value === 'interaction') {
    clearTimeout(tlIdleTimer);
    tlIdleTimer = null;
    if (tlRecorder && tlRecorder.state === 'recording') {
      tlRecorder.pause();
    }
  }
});

// --- Intro Animation ---
function abortIntro() {
  if (!introPlaying) return;
  cancelAnimationFrame(introAnimId);
  introPlaying = false;
  introAnimId = null;
  drawing = false;
}

function playIntroAnimation() {
  // Cubic Bézier control points (relative to canvas size)
  const p0x = W * 0.15,  p0y = H * 0.20;
  const p1x = W * 0.35,  p1y = H * 0.05;
  const p2x = W * 0.65,  p2y = H * 0.95;
  const p3x = W * 0.85,  p3y = H * 0.80;

  const duration = 1400;
  let startTs = null;

  introPlaying = true;
  drawing = true;

  function bezier(t) {
    const u = 1 - t;
    const uu = u * u;
    const tt = t * t;
    return [
      uu * u * p0x + 3 * uu * t * p1x + 3 * u * tt * p2x + tt * t * p3x,
      uu * u * p0y + 3 * uu * t * p1y + 3 * u * tt * p2y + tt * t * p3y
    ];
  }

  // Ease-in-out (smoothstep)
  function ease(t) {
    return t * t * (3 - 2 * t);
  }

  function tick(ts) {
    if (!introPlaying) return;

    if (startTs === null) {
      startTs = ts;
      saveState();
      const [sx, sy] = bezier(0);
      lastX = sx; lastY = sy;
      strokeDX = 0; strokeDY = 0;
    }

    const elapsed = ts - startTs;
    const raw = Math.min(elapsed / duration, 1);
    const t = ease(raw);
    const [cx, cy] = bezier(t);

    strokeTo(cx, cy);
    requestRender();

    if (raw < 1) {
      introAnimId = requestAnimationFrame(tick);
    } else {
      introPlaying = false;
      introAnimId = null;
      drawing = false;
    }
  }

  introAnimId = requestAnimationFrame(tick);
}

// --- Init ---
setupSliders();
loadSettings();
initGarden(
  Math.min(1120, window.innerWidth - 40),
  Math.min(630, window.innerHeight - 120)
);
rebuildGaussKernel();
clearSand();
playIntroAnimation();
