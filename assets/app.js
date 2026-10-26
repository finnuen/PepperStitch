'use strict';

/* ==========================================================================
   PepperStitch - front end

   The page receives pictures as File objects (a drop, the file picker, the
   clipboard) or as https://file.local/<n> URLs from the host (a file given on
   the command line, or a drop the host received).  Everything else - layout,
   preview, export - happens here on canvases in this process.

   Two collections, not one:

     state.sources  the library on the left.  A file becomes a source when it is
                    opened, dropped on the rail or dropped on the canvas; it is
                    only drawn once it is placed.
     state.items    what is on the canvas.  An item is one placement of a source:
                    its own position, size, rotation and crop.  Placing a source
                    twice puts two items on the canvas.

   The canvas is free: items sit at pixel positions and a drag snaps them to a
   neighbour's edges or centres, keeping the spacing and border in force between
   them.  Choosing a preset arranges the items once; after that nothing re-flows
   on its own.
   ========================================================================== */

// ---------------------------------------------------------------------------
//  Constants
// ---------------------------------------------------------------------------

const MAX_CANVAS_SIDE = 65535;        // Chromium's canvas limit
const MAX_CANVAS_AREA = 268435456;    // and its total-pixel limit
const PREVIEW_MAX_SIDE = 1800;        // preview decode, keeps memory sane
const MAX_SOURCE_PIXELS = 180000000;  // refuse absurd sources outright

const SUPPORTED_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'jfif', 'webp', 'avif', 'bmp', 'gif']);
const HEIC_EXTENSIONS = new Set(['heic', 'heif']);

const MIME = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

const DEFAULTS = {
  preset: 'horizontal',
  evenSize: true,
  spacing: 0,
  spacingOn: false,
  outer: 0,
  border: 0,
  borderOn: false,
  radius: 0,
  frameColor: '#ffffff',
  borderColor: '#ffffff',
  backdrop: '#ffffff',
  format: 'png',
  quality: 0.92,
  theme: 'dark',
};

// What a switch seeds when it is turned on and its value is still zero, so
// that flipping it visibly does something.
const TOGGLE_SEEDS = {
  spacingOn: ['spacing', 16],
  borderOn: ['border', 8],
};

const STORAGE_KEY = 'pepperstitch.settings.v1';

// ---------------------------------------------------------------------------
//  State
// ---------------------------------------------------------------------------

const state = {
  ...DEFAULTS,
  sources: [],       // the library on the left: pictures that can be placed
  items: [],         // what is on the canvas, in drawing order
  selectedItemId: null,
  zoom: 'fit',       // 'fit' or a css-pixels-per-output-pixel scale
};

let nextSourceId = 1;
let nextItemId = 1;
let lastCssScale = 1;
let renderQueued = false;
let settingsTimer = 0;

// ---------------------------------------------------------------------------
//  DOM
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

const els = {
  brandName: $('brandName'),
  fileInput: $('fileInput'),
  addButton: $('addButton'),
  addTile: $('addTile'),
  emptyChoose: $('emptyChoose'),
  clearButton: $('clearButton'),
  exportButton: $('exportButton'),
  undoButton: $('undoButton'),
  redoButton: $('redoButton'),
  format: $('format'),
  quality: $('quality'),
  qualityField: $('qualityField'),
  qualityValue: $('qualityValue'),
  themeButton: $('themeButton'),

  strip: $('strip'),
  imageCount: $('imageCount'),

  stage: $('stage'),
  stageScroll: $('stageScroll'),
  sheet: $('sheet'),
  canvas: $('canvas'),
  empty: $('empty'),
  zoom: $('zoom'),
  zoomIn: $('zoomIn'),
  zoomOut: $('zoomOut'),
  zoomValue: $('zoomValue'),
  limit: $('limit'),

  panel: $('panel'),
  resetButton: $('resetButton'),
  evenHint: $('evenHint'),

  selectionGroup: $('selectionGroup'),
  selectedThumb: $('selectedThumb'),
  selectedName: $('selectedName'),
  selectedSize: $('selectedSize'),
  rotateButton: $('rotateButton'),
  cropButton: $('cropButton'),
  duplicateButton: $('duplicateButton'),
  removeButton: $('removeButton'),
  alignLeft: $('alignLeft'),
  alignCentre: $('alignCentre'),
  alignRight: $('alignRight'),
  alignTop: $('alignTop'),
  alignMiddle: $('alignMiddle'),
  alignBottom: $('alignBottom'),
  cropBar: $('cropBar'),
  cropRatio: $('cropRatio'),
  cropRatioClear: $('cropRatioClear'),
  cropApply: $('cropApply'),
  cropCancel: $('cropCancel'),

  statusCount: $('statusCount'),
  statusSize: $('statusSize'),
  statusHint: $('statusHint'),
  statusVersion: $('statusVersion'),

  dropzone: $('dropzone'),
  dropVerb: $('dropVerb'),
  emptyTitle: $('emptyTitle'),
  emptyText: $('emptyText'),
  busy: $('busy'),
  busyText: $('busyText'),
  toasts: $('toasts'),
};

const context = els.canvas.getContext('2d');

// ---------------------------------------------------------------------------
//  Host bridge
//
//  In the executable window.chrome.webview exists and the three virtual hosts
//  below are answered by main.cpp.  Opened as a plain file in a browser the
//  page still works; saving falls back to a download.
// ---------------------------------------------------------------------------

const host = {
  available: !!(window.chrome && window.chrome.webview),

  command(path) {
    if (!this.available) return Promise.resolve();
    return fetch('https://host.local' + path, { cache: 'no-store' }).catch(() => {});
  },

  listen(handler) {
    if (!this.available) return;
    window.chrome.webview.addEventListener('message', (event) => {
      if (event.data && typeof event.data === 'object') handler(event.data);
    });
  },
};

// ---------------------------------------------------------------------------
//  Small utilities
// ---------------------------------------------------------------------------

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

function extensionOf(name) {
  const dot = String(name || '').lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

function baseNameOf(name) {
  const dot = String(name || '').lastIndexOf('.');
  return dot <= 0 ? String(name || 'stitch') : name.slice(0, dot);
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function formatNumber(value) {
  return value.toLocaleString('en-US');
}

// Lets the interface breathe between two exported pictures.  A hidden or
// minimised window stops delivering animation frames, so the timer is the
// guarantee that an export always finishes rather than waiting for one.
function nextFrame() {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    requestAnimationFrame(finish);
    setTimeout(finish, 50);
  });
}

// ---------------------------------------------------------------------------
//  Themes and settings
// ---------------------------------------------------------------------------

function applyTheme(theme) {
  state.theme = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = state.theme;
  host.command('/theme?dark=' + (state.theme === 'dark' ? '1' : '0'));
}

function loadSettings() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
  } catch {
    saved = null;
  }
  if (!saved || typeof saved !== 'object') return;

  for (const key of Object.keys(DEFAULTS)) {
    if (key === 'theme') continue;
    if (!(key in saved)) continue;
    const fallback = DEFAULTS[key];
    const value = saved[key];
    if (typeof fallback === 'number') {
      const number = Number(value);
      if (Number.isFinite(number)) state[key] = number;
    } else if (typeof fallback === 'string') {
      if (typeof value === 'string') state[key] = value;
    } else if (typeof fallback === 'boolean') {
      if (typeof value === 'boolean') state[key] = value;
    }
  }

  // Settings saved by the first release: a direction became a preset, and any
  // spacing or border that was visible is switched on rather than left at zero.
  if (!('preset' in saved) && (saved.direction === 'h' || saved.direction === 'v')) {
    state.preset = saved.direction === 'v' ? 'vertical' : 'horizontal';
  }
  if (!('spacingOn' in saved) && Number(saved.spacing) > 0) state.spacingOn = true;
  if (!('borderOn' in saved) && Number(saved.border) > 0) state.borderOn = true;

  if (!['horizontal', 'vertical'].includes(state.preset)) state.preset = 'horizontal';
  if (!MIME[state.format]) state.format = 'png';
  if (saved.theme === 'light' || saved.theme === 'dark') state.theme = saved.theme;
}

function saveSettingsSoon() {
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => {
    const { sources, items, selectedItemId, zoom, ...rest } = state;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(rest));
    } catch {
      /* storage is a convenience, not a requirement */
    }
  }, 250);
}

// ---------------------------------------------------------------------------
//  Toasts and busy overlay
// ---------------------------------------------------------------------------

function toast(message, kind = 'info', action = null, timeout = 0) {
  const element = document.createElement('div');
  element.className = 'toast' + (kind === 'error' ? ' error' : '');
  const text = document.createElement('span');
  text.className = 'toast-text';
  text.textContent = message;
  element.append(text);

  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = action.label;
    button.addEventListener('click', () => {
      action.run();
      dismiss();
    });
    element.append(button);
  }

  els.toasts.append(element);
  while (els.toasts.children.length > 4) els.toasts.firstElementChild.remove();

  const life = timeout || (kind === 'error' ? 8000 : action ? 12000 : 4000);
  let timer = setTimeout(dismiss, life);

  function dismiss() {
    clearTimeout(timer);
    element.classList.add('fading');
    setTimeout(() => element.remove(), 200);
  }

  element.addEventListener('mouseenter', () => clearTimeout(timer));
  element.addEventListener('mouseleave', () => { timer = setTimeout(dismiss, 1800); });
  return element;
}

function setBusy(active, message) {
  els.busy.hidden = !active;
  if (message) els.busyText.textContent = message;
}

function setBusyText(message) {
  els.busyText.textContent = message;
}

// ---------------------------------------------------------------------------
//  Reading pictures
// ---------------------------------------------------------------------------

async function decodePreview(blob) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    bitmap = await createImageBitmap(blob);
  }

  const width = bitmap.width;
  const height = bitmap.height;

  if (Math.max(width, height) > PREVIEW_MAX_SIDE) {
    const scale = PREVIEW_MAX_SIDE / Math.max(width, height);
    try {
      const small = await createImageBitmap(bitmap, {
        resizeWidth: Math.max(1, Math.round(width * scale)),
        resizeHeight: Math.max(1, Math.round(height * scale)),
        resizeQuality: 'high',
      });
      bitmap.close();
      bitmap = small;
    } catch {
      /* keep the full-size bitmap if resizing is unavailable */
    }
  }

  return { bitmap, width, height };
}

/* Full resolution, used only while exporting. */
async function decodeFull(blob) {
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    return createImageBitmap(blob);
  }
}

// ---------------------------------------------------------------------------
//  The library and the canvas
//
//  Reading a file creates a source: it appears in the list on the left and
//  stays there until everything is cleared.  Placing a source creates an item
//  on the canvas; placing it a second time creates a second item, which is how
//  a picture is duplicated without decoding it again.
// ---------------------------------------------------------------------------

function acceptedName(entry) {
  return entry.name || 'pasted image';
}

function sourceById(id) {
  return state.sources.find((source) => source.id === id) || null;
}

// Turns one file into a library source, or reports why it cannot.
async function makeSource(entry) {
  const name = acceptedName(entry);
  const extension = extensionOf(name);

  if (HEIC_EXTENSIONS.has(extension) || entry.type === 'image/heic' || entry.type === 'image/heif') {
    toast(`${name}: HEIC is not supported yet. Save it as JPEG or PNG first.`, 'error');
    return null;
  }
  if (!SUPPORTED_EXTENSIONS.has(extension) && !String(entry.type || '').startsWith('image/')) {
    toast(`${name}: not an image PepperStitch can read.`, 'error');
    return null;
  }

  try {
    const blob = entry.blob;
    const { bitmap, width, height } = await decodePreview(blob);

    if (width * height > MAX_SOURCE_PIXELS) {
      bitmap.close();
      toast(`${name}: ${formatNumber(width)} × ${formatNumber(height)} is too large to stitch.`, 'error');
      return null;
    }

    return {
      id: nextSourceId++,
      name,
      path: entry.path || '',
      blob,
      url: URL.createObjectURL(blob),
      bitmap,
      width,
      height,
    };
  } catch {
    toast(`${name}: this picture could not be decoded.`, 'error');
    return null;
  }
}

// `place` says where the picture should end up: 'list' only puts it in the
// library, 'canvas' also places it (at `point`, or after the last one).
async function addEntries(entries, { place = 'list', point = null } = {}) {
  const accepted = [];

  for (const entry of entries) {
    const source = await makeSource(entry);
    if (source) accepted.push(source);
  }

  if (!accepted.length) return;
  state.sources.push(...accepted);

  if (place === 'canvas') placeSources(accepted, point);

  renderStrip();
  updateSelectionPanel();
  scheduleRender();
}

async function addFiles(fileList, options = {}) {
  const files = [...fileList];
  if (!files.length) return;

  if (files.length > 2) setBusy(true, `Reading ${files.length} images…`);
  try {
    await addEntries(files.map((file) => ({
      blob: file,
      name: file.name,
      type: file.type,
    })), options);
  } finally {
    setBusy(false);
  }
}

async function addFromHost(items, options = {}) {
  const entries = [];
  for (const item of items) {
    try {
      const response = await fetch(item.url, { cache: 'no-store' });
      if (!response.ok) throw new Error('missing');
      const blob = await response.blob();
      entries.push({ blob, name: item.name, path: item.path || '' });
    } catch {
      toast(`${item.name || 'file'}: the host could not read it.`, 'error');
    }
  }
  await addEntries(entries, options);
}

// A canvas item is one placement.  Its size is derived from the source rather
// than copied, so a rotation or a change of Even size re-derives it.  `scale`
// is the wheel's own size, kept as a factor of the source so a crop or a
// rotation can re-derive the pixels without losing it.
function createItem(source) {
  return {
    id: nextItemId++,
    sourceId: source.id,
    x: 0,
    y: 0,
    w: Math.max(1, source.width),
    h: Math.max(1, source.height),
    rot: 0,
    flipH: false,
    flipV: false,
    scale: 1,
    crop: null,
  };
}

function placeSources(sources, point = null) {
  const placed = sources.map((source) => {
    const item = createItem(source);
    state.items.push(item);
    return item;
  });

  // A new picture joins at the edge the canvas shares, so adding one never
  // resizes what is already placed.  A batch dropped together therefore comes
  // out even; arranging re-reads the tallest for everything.
  const edge = sharedEdgeFor(state.items);
  for (const item of placed) {
    const size = sizeFor(item, edge);
    item.w = Math.max(1, Math.round(size.w));
    item.h = Math.max(1, Math.round(size.h));
  }

  const border = borderPx();
  const gap = spacingPx();
  let dropCursor = point;

  for (const item of placed) {
    if (dropCursor) {
      // Dropped at a pointer: its centre goes where the pointer let go.
      item.x = Math.round(dropCursor.x - item.w / 2);
      item.y = Math.round(dropCursor.y - item.h / 2);
      snapItem(item);
    } else {
      const previous = state.items[state.items.indexOf(item) - 1];
      if (previous) {
        item.x = previous.x + previous.w + border + gap;
        item.y = previous.y;
      } else {
        item.x = border;
        item.y = border;
      }
    }
    clampItem(item);
    if (dropCursor) {
      dropCursor = { x: item.x + item.w + border + gap, y: item.y };
    }
  }

  state.selectedItemId = placed[placed.length - 1].id;
}

function removeItem(id) {
  const index = state.items.findIndex((item) => item.id === id);
  if (index < 0) return;

  state.items.splice(index, 1);

  if (state.selectedItemId === id) {
    const next = state.items[index] || state.items[index - 1];
    state.selectedItemId = next ? next.id : null;
  }

  dropStaleCrop();
  renderStrip();
  updateSelectionPanel();
  scheduleRender();
}

function removeSource(source) {
  const index = state.sources.indexOf(source);
  if (index < 0) return;

  // The list owns the bitmap and the blob URL, but an undo step may still hold
  // this picture, so it is set aside rather than freed here: the release waits
  // until nothing can bring it back (releaseForgottenSources).
  retiredSources.set(source.id, source);
  state.sources.splice(index, 1);

  // An item is only a reference to its source, so a picture that leaves the
  // list takes every copy of itself off the canvas as well.
  const first = state.items.findIndex((item) => item.sourceId === source.id);
  let selectionLost = false;
  for (let i = state.items.length - 1; i >= 0; i -= 1) {
    if (state.items[i].sourceId !== source.id) continue;
    if (state.items[i].id === state.selectedItemId) selectionLost = true;
    state.items.splice(i, 1);
  }

  if (selectionLost) {
    const next = state.items[first] || state.items[first - 1];
    state.selectedItemId = next ? next.id : null;
  }

  dropStaleCrop();
  renderStrip();
  updateSelectionPanel();
  scheduleRender();
}

function clearImages() {
  // Cleared pictures are put aside for the same reason a removed one is: an
  // undo step can still ask for them.
  for (const source of state.sources) retiredSources.set(source.id, source);
  state.sources = [];
  state.items = [];
  state.selectedItemId = null;
  cancelCrop();
  renderStrip();
  updateSelectionPanel();
  scheduleRender();
}

function duplicateItem(id) {
  const original = state.items.find((item) => item.id === id);
  if (!original) return;

  const copy = { ...original, id: nextItemId++ };
  state.items.push(copy);

  // The copy lands immediately to the right of the original.
  const border = borderPx();
  copy.x = original.x + original.w + border * 2 + spacingPx();
  copy.y = original.y;
  clampItem(copy);

  state.selectedItemId = copy.id;
  renderStrip();
  updateSelectionPanel();
  scheduleRender();
}

function selectItem(id) {
  state.selectedItemId = id;
  updateSelectionPanel();
  scheduleRender();
}

// ---------------------------------------------------------------------------
//  Layout
//
//  Every length is in output pixels.  A "cell" is one picture plus its border;
//  the content rect inside the cell is what the picture is drawn into.
// ---------------------------------------------------------------------------

// The part of the source an item shows, in the source's own pixels and before
// any rotation.  A crop keeps a rectangle of the source, so the aspect, the
// fitted drawing and the export all read the size from here.
function sourceRectOf(item) {
  const source = sourceById(item.sourceId);
  if (!source) return { x: 0, y: 0, w: 1, h: 1 };

  const crop = item.crop;
  if (!crop) return { x: 0, y: 0, w: source.width, h: source.height };

  return {
    x: crop.x * source.width,
    y: crop.y * source.height,
    w: Math.max(1, crop.w * source.width),
    h: Math.max(1, crop.h * source.height),
  };
}

// The picture's own size once rotation is taken into account.
function naturalSizeOf(item) {
  const rect = sourceRectOf(item);
  const rotated = item.rot % 180 !== 0;
  return rotated
    ? { width: rect.h, height: rect.w }
    : { width: rect.w, height: rect.h };
}

function aspectOf(item) {
  const size = naturalSizeOf(item);
  return size.height > 0 ? size.width / size.height : 1;
}

function borderPx() {
  return state.borderOn ? Math.max(0, Math.round(state.border)) : 0;
}

function spacingPx() {
  return state.spacingOn ? Math.max(0, Math.round(state.spacing)) : 0;
}

function outerPx() {
  return Math.max(0, Math.round(state.outer));
}

// Even size shares one edge across the canvas: the height in a row, the width
// in a column.  It is re-read from the pictures present, so arranging makes
// every picture take the tallest (or widest) one's edge.
function sharedEdgeFor(items) {
  if (!state.evenSize || !items.length) return null;
  const vertical = state.preset === 'vertical';
  let value = 0;
  for (const item of items) {
    const size = naturalSizeOf(item);
    value = Math.max(value, vertical ? size.width : size.height);
  }
  return value > 0 ? { kind: vertical ? 'width' : 'height', value } : null;
}

function sharedEdge() {
  return sharedEdgeFor(state.items);
}

function sizeFor(item, edge) {
  const scale = Math.max(0.01, Number(item.scale) || 1);
  if (!edge) {
    const size = naturalSizeOf(item);
    return { w: Math.max(1, size.width * scale), h: Math.max(1, size.height * scale) };
  }
  // Even size gives every picture one shared edge, so a wheel size steps aside
  // here: turning that switch back on is what makes the pictures even again.
  const ratio = Math.max(0.0001, aspectOf(item));
  if (edge.kind === 'width') {
    return { w: edge.value, h: Math.max(1, Math.round(edge.value / ratio)) };
  }
  return { w: Math.max(1, Math.round(edge.value * ratio)), h: edge.value };
}

// Re-derives every item's content size.  Called when the shared edge may have
// moved (a picture placed or removed, Even size switched, a crop or rotation
// changed).  Positions are left alone: arranging is what moves things.
function resizeItems() {
  const edge = sharedEdge();
  for (const item of state.items) {
    const size = sizeFor(item, edge);
    item.w = Math.max(1, Math.round(size.w));
    item.h = Math.max(1, Math.round(size.h));
    clampItem(item);
  }
}

// The border sits outside the picture, so the picture never moves when the
// ring gets thicker; it only has to stay far enough in for the ring to fit.
function clampItem(item) {
  const border = borderPx();
  item.x = Math.max(border, Math.round(item.x));
  item.y = Math.max(border, Math.round(item.y));
}

// A border lives outside the picture, and the canvas edge outside the ring, so
// a change in thickness slides the whole composition by the same difference
// rather than re-packing it: relative placement survives, the ring's outer edge
// stays where it was, and no border is ever cut off by the canvas edge.
function slideForBorder(delta) {
  if (!delta || !state.items.length) return;
  for (const item of state.items) {
    item.x += delta;
    item.y += delta;
  }
}

function computeLayout() {
  if (!state.items.length) return null;

  const border = borderPx();
  const outer = outerPx();
  const cells = [];
  let maxX = 0;
  let maxY = 0;

  for (const item of state.items) {
    const cell = {
      item,
      source: sourceById(item.sourceId),
      x: item.x - border + outer,
      y: item.y - border + outer,
      w: item.w + border * 2,
      h: item.h + border * 2,
      cx: item.x + outer,
      cy: item.y + outer,
      cw: item.w,
      ch: item.h,
      rot: item.rot,
      flipH: item.flipH,
      flipV: item.flipV,
      crop: item.crop,
    };
    maxX = Math.max(maxX, cell.x + cell.w);
    maxY = Math.max(maxY, cell.y + cell.h);
    cells.push(cell);
  }

  return {
    width: Math.max(1, Math.round(maxX + outer)),
    height: Math.max(1, Math.round(maxY + outer)),
    cells,
    preset: state.preset,
    border,
    spacing: spacingPx(),
    outer,
  };
}

// The preset is an action, not a mode: it lays the pictures out once, and a
// drag afterwards is free again.  Everything is packed from the canvas origin,
// so arranging also tidies a composition that has drifted apart.
//
// The row follows the library rather than the order the pictures happened to be
// placed in, so reordering the image list and pressing a preset re-packs it in
// that order.  Copies of one picture keep the order they were placed in, and
// only the positions move: the drawing order of `state.items` is left alone, so
// what overlaps what stays exactly as it was.
function itemsInLibraryOrder() {
  const place = new Map(state.sources.map((source, index) => [source.id, index]));
  return [...state.items].sort((a, b) =>
    (place.get(a.sourceId) ?? Infinity) - (place.get(b.sourceId) ?? Infinity));
}

// Two pictures meet through one shared border band, not two: the gap between
// their pictures is border + spacing, so the ring of each lies over the same
// pixels.  That is what the snap targets as well, so a preset and a drag agree.
function arrange(preset) {
  state.preset = ['horizontal', 'vertical'].includes(preset) ? preset : 'horizontal';
  resizeItems();

  if (!state.items.length) {
    state.zoom = 'fit';
    return;
  }

  const border = borderPx();
  const gap = spacingPx();
  const horizontal = state.preset === 'horizontal';
  let offset = border;

  for (const item of itemsInLibraryOrder()) {
    if (horizontal) {
      item.x = offset;
      item.y = border;
      offset += item.w + border + gap;
    } else {
      item.x = border;
      item.y = offset;
      offset += item.h + border + gap;
    }
  }

  state.zoom = 'fit';
}

// The six alignments, in the order the buttons sit: the row's three (top,
// middle, bottom) first, then the column's three (left, centre, right).
const ALIGNMENTS = [
  ['alignTop', 'y', 'start'],
  ['alignMiddle', 'y', 'middle'],
  ['alignBottom', 'y', 'end'],
  ['alignLeft', 'x', 'start'],
  ['alignCentre', 'x', 'middle'],
  ['alignRight', 'x', 'end'],
];

// A row of pictures is lined up along its tops; a column along its lefts.  The
// preset therefore decides which three buttons are live.
function alignAxis() {
  return state.preset === 'horizontal' ? 'y' : 'x';
}

// Lining the composition up: every picture moves to the outermost edge of the
// whole canvas, or to the middle of that span, along one axis.  Like a preset
// this is an action on what is placed rather than a mode, and it re-packs
// nothing else - sizes are left exactly as they are, and the other axis keeps
// whatever arrangement it had.
function alignAll(axis, where) {
  if (state.items.length < 2 || axis !== alignAxis()) return;

  let low = Infinity;
  let high = -Infinity;
  for (const item of state.items) {
    const start = axis === 'x' ? item.x : item.y;
    const size = axis === 'x' ? item.w : item.h;
    low = Math.min(low, start);
    high = Math.max(high, start + size);
  }
  const middle = (low + high) / 2;

  for (const item of state.items) {
    const size = axis === 'x' ? item.w : item.h;
    item[axis] = Math.round(
      where === 'start' ? low
        : where === 'end' ? high - size
          : middle - size / 2,
    );
    clampItem(item);
  }

  updateSelectionPanel();
  scheduleRender();
}

// One picture has nothing to line up against, and the wrong axis for the preset
// has nothing to tidy, so the buttons wait for both.
function updateAlignButtons() {
  const alone = state.items.length < 2;
  for (const [id, axis] of ALIGNMENTS) {
    els[id].disabled = alone || axis !== alignAxis();
  }
}

function canvasLimitMessage(layout) {
  if (!layout) return null;
  const { width, height } = layout;
  if (width > MAX_CANVAS_SIDE || height > MAX_CANVAS_SIDE) {
    return `The output is ${formatNumber(width)} × ${formatNumber(height)} px. A canvas tops out at ` +
      `${formatNumber(MAX_CANVAS_SIDE)} px on a side — remove some pictures to make it smaller.`;
  }
  if (width * height > MAX_CANVAS_AREA) {
    return `The output is ${formatNumber(width * height)} pixels in total. The limit is ` +
      `${formatNumber(MAX_CANVAS_AREA)} — remove some pictures to make it smaller.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
//  Painting
// ---------------------------------------------------------------------------

function roundedRect(ctx, x, y, width, height, radius) {
  const r = Math.max(0, Math.min(radius, Math.min(width, height) / 2));
  ctx.beginPath();
  if (r <= 0.01) {
    ctx.rect(x, y, width, height);
    return;
  }
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, width, height, r);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

// The ring around one picture.  Rings are painted for the whole canvas before
// any picture, so a border a neighbour sits too close for ends up underneath
// that neighbour instead of over it: the picture always wins.
function paintRing(ctx, cell, border) {
  if (border <= 0) return;
  const radius = Math.max(0, Number(state.radius) || 0);

  // The ring follows the picture's corners: rounded by the radius plus its own
  // thickness, but square when the radius is zero, so a picture with no
  // rounding does not end up with rounded border corners.
  roundedRect(ctx, cell.x, cell.y, cell.w, cell.h, radius > 0 ? radius + border : 0);
  ctx.fillStyle = state.borderColor;
  ctx.fill();
}

function paintPicture(ctx, cell, bitmap, veil = 0) {
  const radius = Math.max(0, Number(state.radius) || 0);

  ctx.save();
  roundedRect(ctx, cell.cx, cell.cy, cell.cw, cell.ch, radius);
  ctx.clip();

  drawFitted(ctx, bitmap, cell);

  // The selection and the pointer are shown by lighting the picture itself
  // rather than by drawing furniture around it: a wash of white over the
  // picture's own pixels, inside the same clip, so a rounded picture is lit to
  // its corners and a border ring is left alone.
  if (veil > 0) {
    ctx.fillStyle = `rgba(255, 255, 255, ${veil})`;
    ctx.fillRect(cell.cx, cell.cy, cell.cw, cell.ch);
  }
  ctx.restore();
}

// How much white the selected picture, and the one under the pointer, are
// washed with.  A button lightens under the pointer for the same reason: it
// says what is live without putting anything in front of the picture.
const SELECTED_VEIL = 0.18;
const HOVER_VEIL = 0.07;

let hoverItemId = null;   // the picture under the pointer, if any

// The pointer lights the picture it is over, so a click has something to aim
// at.  Only a change redraws: a pointermove that stays over the same picture
// costs nothing.
function setHovered(id) {
  if (hoverItemId === id) return;
  hoverItemId = id;
  scheduleRender();
}

function veilFor(item) {
  // While a crop frame is up it is the selection, so the light goes with the
  // outline it replaced.
  if (cropEdit) return 0;
  if (item.id === state.selectedItemId) return SELECTED_VEIL;
  if (item.id === hoverItemId) return HOVER_VEIL;
  return 0;
}

// The picture fills its own cell: a cell is given the picture's shape when it
// is placed, resized or cropped, so there are no letterbox bars to paint and
// nothing to crop beyond the picture's own edges.
function drawFitted(ctx, bitmap, cell) {
  const rotation = cell.rot;
  const flipH = cell.flipH;
  const flipV = cell.flipV;

  // A crop is kept as fractions of the source, so it lands on the preview
  // bitmap and on the full-resolution one alike.
  const crop = cell.crop;
  const cropX = crop ? crop.x * bitmap.width : 0;
  const cropY = crop ? crop.y * bitmap.height : 0;
  const cropWidth = crop ? Math.max(1, crop.w * bitmap.width) : bitmap.width;
  const cropHeight = crop ? Math.max(1, crop.h * bitmap.height) : bitmap.height;

  const rotated = rotation % 180 !== 0;
  const sourceWidth = rotated ? cropHeight : cropWidth;
  const sourceHeight = rotated ? cropWidth : cropHeight;
  if (!sourceWidth || !sourceHeight) return;

  const scale = Math.max(cell.cw / sourceWidth, cell.ch / sourceHeight);

  const drawnWidth = sourceWidth * scale;
  const drawnHeight = sourceHeight * scale;
  const rotatedWidth = rotated ? drawnHeight : drawnWidth;
  const rotatedHeight = rotated ? drawnWidth : drawnHeight;

  ctx.save();
  ctx.translate(cell.cx + cell.cw / 2, cell.cy + cell.ch / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  if (flipH || flipV) ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, cropX, cropY, cropWidth, cropHeight,
                -rotatedWidth / 2, -rotatedHeight / 2, rotatedWidth, rotatedHeight);
  ctx.restore();
}

function paintBackground(ctx, layout, scale, opaque = false) {
  // The canvas has no background of its own.  Only an outer frame is painted,
  // and it is a band: the inside is cleared again so the gaps between pictures
  // stay transparent and the preview shows the stage through them.  A JPEG has
  // no alpha, so there the inside keeps whatever was underneath (the backdrop).
  if (layout.outer <= 0) return;

  ctx.save();
  ctx.scale(scale, scale);
  ctx.fillStyle = state.frameColor;
  ctx.fillRect(0, 0, layout.width, layout.height);
  if (!opaque) {
    ctx.clearRect(layout.outer, layout.outer,
                  layout.width - layout.outer * 2, layout.height - layout.outer * 2);
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
//  Cropping
//
//  Cropping is a short-lived mode of the preview: a frame over the selected
//  picture, which becomes the part of the source that picture shows.  The frame
//  is kept as fractions of the picture's visible area rather than pixels, so
//  moving the picture, zooming or resizing the window while it is up cannot
//  lose it, and applying it maps back through rotation, flips and any crop the
//  picture already carries.
// ---------------------------------------------------------------------------

const MIN_CROP_SCREEN_PX = 16;     // a frame any smaller cannot be grabbed
const CROP_HANDLE_SCREEN_PX = 10;  // how close to a handle counts as on it
// The eight points of a rectangle: the crop frame and the selected picture's
// resize handles are the same furniture.
const HANDLES = ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'];

let cropEdit = null;   // { itemId, rect, ratio } — rect in 0..1 of the picture
let cropDrag = null;   // the gesture in progress, in canvas coordinates

// Where the picture sits in canvas coordinates: it fills its cell, because the
// cell was given the picture's own shape.  The crop frame works from here, and
// so does the way back to the source.
function pictureRect(cell) {
  return { x: cell.cx, y: cell.cy, w: cell.cw, h: cell.ch };
}

// A point on the canvas mapped back onto the source, undoing the rotation, the
// flips and the crop the picture already has.  The answer is in source
// fractions, which is how a crop is stored.
function canvasToSource(cell, x, y) {
  const item = cell.item;
  const image = pictureRect(cell);
  const rotated = item.rot % 180 !== 0;
  const localWidth = rotated ? image.h : image.w;
  const localHeight = rotated ? image.w : image.h;
  const centreX = image.x + image.w / 2;
  const centreY = image.y + image.h / 2;

  const angle = (-item.rot * Math.PI) / 180;
  const dx = x - centreX;
  const dy = y - centreY;
  let localX = dx * Math.cos(angle) - dy * Math.sin(angle);
  let localY = dx * Math.sin(angle) + dy * Math.cos(angle);
  if (item.flipH) localX = -localX;
  if (item.flipV) localY = -localY;

  const fx = clamp(localX / (localWidth || 1) + 0.5, 0, 1);
  const fy = clamp(localY / (localHeight || 1) + 0.5, 0, 1);
  const crop = item.crop || { x: 0, y: 0, w: 1, h: 1 };
  return { x: crop.x + fx * crop.w, y: crop.y + fy * crop.h };
}

function cropCell() {
  if (!cropEdit) return null;
  const layout = computeLayout();
  if (!layout) return null;
  return layout.cells.find((cell) => cell.item.id === cropEdit.itemId) || null;
}

function cropDisplayRect(visible, fraction) {
  return {
    x: visible.x + fraction.x * visible.w,
    y: visible.y + fraction.y * visible.h,
    w: fraction.w * visible.w,
    h: fraction.h * visible.h,
  };
}

function insideRect(rect, x, y) {
  return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
}

// The frame the mode opened with, before anything was dragged.
function cropCoversWholePicture() {
  const rect = cropEdit ? cropEdit.rect : null;
  return !!rect && rect.x <= 0.001 && rect.y <= 0.001 && rect.w >= 0.999 && rect.h >= 0.999;
}

// The handle nearest a point, if the point is within `tolerance` of it.  The
// crop frame and the selected picture's resize handles share it: both are eight
// squares on the corners and edge midpoints of a rectangle.
function handleAt(rect, x, y, tolerance) {
  for (const handle of HANDLES) {
    const hx = handle.includes('w') ? rect.x
      : handle.includes('e') ? rect.x + rect.w
        : rect.x + rect.w / 2;
    const hy = handle.includes('n') ? rect.y
      : handle.includes('s') ? rect.y + rect.h
        : rect.y + rect.h / 2;
    if (Math.abs(x - hx) <= tolerance && Math.abs(y - hy) <= tolerance) return handle;
  }
  return null;
}

// The selected picture has no handles to aim at, so the whole side sizes it,
// not just the midpoint the squares used to sit on.  Corners keep their own
// zones, the interior is still the move zone, and the two axes are measured
// separately so a point diagonally off a corner is still that corner.
function resizeHandleAt(rect, x, y, tolerance) {
  if (x < rect.x - tolerance || x > rect.x + rect.w + tolerance) return null;
  if (y < rect.y - tolerance || y > rect.y + rect.h + tolerance) return null;

  const horizontal = Math.abs(x - rect.x) <= tolerance ? 'w'
    : Math.abs(x - (rect.x + rect.w)) <= tolerance ? 'e'
      : null;
  const vertical = Math.abs(y - rect.y) <= tolerance ? 'n'
    : Math.abs(y - (rect.y + rect.h)) <= tolerance ? 's'
      : null;

  if (horizontal && vertical) return vertical + horizontal;
  return horizontal || vertical;
}

// A ratio is width over height, and the two sides can be separated by whichever
// symbol is nearest the fingers: "16:9", "4/5", "3x2", "16*9", "16-9", "16+9",
// "16'9".  One number on its own is a ratio too, as in "1.5".
//
// A dot is the one ambiguous separator, because it is also the decimal point,
// and the decimals that matter here are written with it: 1.85 and 2.39:1 are
// far more common than 1:85 or 2:39.  So a dot between two whole numbers reads
// as a separator ("16.9" is 16 by 9, "4.5" is 4 by 5), while a longer decimal
// stays a number ("1.5", "1.85", "2.39"), and "1.5" keeps meaning 3:2.
const RATIO_SEPARATORS = /[:/x×*+'\-]/;

function parseCropRatio(text) {
  const value = String(text).trim().toLowerCase();
  if (!value || value === 'free' || value === 'none' || value === 'off') return null;

  const pair = value.split(RATIO_SEPARATORS);
  if (pair.length === 2) {
    const across = Number(pair[0]);
    const down = Number(pair[1]);
    return across > 0 && down > 0 ? across / down : null;
  }

  const dotted = value.split('.');
  if (dotted.length === 2 && /^\d{1,2}$/.test(dotted[0]) && /^\d$/.test(dotted[1])) {
    const across = Number(dotted[0]);
    const down = Number(dotted[1]);
    if (across > 1 && down > 0) return across / down;
  }

  const single = Number(value);
  return single > 0 ? single : null;
}

// A frame drawn from a fixed corner towards a pointer.  With a ratio the
// pointer's longer reach picks the size and the ratio picks the other side;
// either way the frame stops at the room the anchor has inside the picture.
function cropFrameFrom(ax, ay, sx, sy, px, py, ratio, bounds, min) {
  const roomX = Math.max(min, sx > 0 ? bounds.x + bounds.w - ax : ax - bounds.x);
  const roomY = Math.max(min, sy > 0 ? bounds.y + bounds.h - ay : ay - bounds.y);
  let w = clamp(sx > 0 ? px - ax : ax - px, min, roomX);
  let h = clamp(sy > 0 ? py - ay : ay - py, min, roomY);

  if (ratio) {
    // The ratio is the whole shape, so the side that does not fit the room
    // gives way rather than the ratio being bent.
    const fit = Math.min(roomX / ratio, roomY);
    w = Math.min(Math.max(w, h * ratio), ratio * fit);
    h = w / ratio;
  }

  return {
    x: sx > 0 ? ax : ax - w,
    y: sy > 0 ? ay : ay - h,
    w,
    h,
  };
}

// A side handle moves one edge only; with a ratio the other dimension follows
// and stays centred on where it already was, so the frame grows evenly about
// the middle of the edge that is not moving.
function cropFrameFromSide(base, mode, px, py, ratio, bounds, min) {
  const horizontal = mode === 'w' || mode === 'e';
  const back = mode === 'w' || mode === 'n';   // the moving edge travels backwards
  const fixed = horizontal
    ? (mode === 'w' ? base.x + base.w : base.x)
    : (mode === 'n' ? base.y + base.h : base.y);
  const pointer = horizontal ? px : py;
  const room = back
    ? (horizontal ? fixed - bounds.x : fixed - bounds.y)
    : (horizontal ? bounds.x + bounds.w - fixed : bounds.y + bounds.h - fixed);
  const centre = horizontal ? base.y + base.h / 2 : base.x + base.w / 2;
  const crossLimit = 2 * (horizontal
    ? Math.min(centre - bounds.y, bounds.y + bounds.h - centre)
    : Math.min(centre - bounds.x, bounds.x + bounds.w - centre));

  let along = clamp(back ? fixed - pointer : pointer - fixed, min, Math.max(min, room));
  if (ratio) {
    const cross = horizontal ? along / ratio : along * ratio;
    if (cross > crossLimit) along = horizontal ? crossLimit * ratio : crossLimit / ratio;
    along = Math.max(along, min);
  }

  const w = ratio ? (horizontal ? along : along * ratio) : (horizontal ? along : base.w);
  const h = ratio ? (horizontal ? along / ratio : along) : (horizontal ? base.h : along);

  return {
    x: horizontal
      ? (back ? fixed - w : fixed)
      : clamp(centre - w / 2, bounds.x, bounds.x + bounds.w - w),
    y: horizontal
      ? clamp(centre - h / 2, bounds.y, bounds.y + bounds.h - h)
      : (back ? fixed - h : fixed),
    w,
    h,
  };
}

// Typing a ratio reshapes the frame at once: the widest frame of that shape
// that fits the picture, centred on where the current frame sits, so the
// answer is visible before anything is dragged.
function shapeCropToRatio(ratio) {
  const cell = cropCell();
  if (!cropEdit || !cell || !ratio) return;

  const visible = pictureRect(cell);
  const rect = cropDisplayRect(visible, cropEdit.rect);
  const centreX = rect.x + rect.w / 2;
  const centreY = rect.y + rect.h / 2;

  let w = rect.w;
  let h = w / ratio;
  const fit = Math.min(visible.w / w, visible.h / h, 1);
  w *= fit;
  h *= fit;

  const x = clamp(centreX - w / 2, visible.x, visible.x + visible.w - w);
  const y = clamp(centreY - h / 2, visible.y, visible.y + visible.h - h);
  cropEdit.rect = {
    x: (x - visible.x) / visible.w,
    y: (y - visible.y) / visible.h,
    w: w / visible.w,
    h: h / visible.h,
  };
  scheduleRender();
}

// The field, the frame and the little clear button are kept in step from here:
// an empty field means free-form, and there is only something to clear when it
// holds a ratio.
function syncCropRatioField() {
  if (els.cropRatioClear) els.cropRatioClear.hidden = !els.cropRatio.value.trim();
}

function setCropRatio(text) {
  els.cropRatio.value = text;
  syncCropRatioField();
  if (!cropEdit) return;
  cropEdit.ratio = parseCropRatio(text);
  if (cropEdit.ratio) shapeCropToRatio(cropEdit.ratio);
  else scheduleRender();
}

function startCrop(item = selectedItem()) {
  if (!item || !sourceById(item.sourceId)) return;
  state.selectedItemId = item.id;
  // The frame starts around the whole picture, so a second crop narrows what
  // is already kept rather than starting from the untouched source.  The ratio
  // starts free: a crop should not inherit a shape nobody asked for this time.
  cropEdit = { itemId: item.id, rect: { x: 0, y: 0, w: 1, h: 1 }, ratio: null };
  if (els.cropRatio) {
    els.cropRatio.value = '';
    syncCropRatioField();
  }
  cropDrag = null;
  updateSelectionPanel();
  scheduleRender();
}

function cancelCrop() {
  if (!cropEdit) return;
  cropEdit = null;
  cropDrag = null;
  updateSelectionPanel();
  scheduleRender();
}

// Keeps the frame: the picture takes the frame's shape and its size on the
// canvas, because the crop is now the picture's own shape.
function applyCrop() {
  const layout = computeLayout();
  const cell = cropCell();
  if (!cropEdit || !layout || !cell) {
    cancelCrop();
    return;
  }

  const visible = pictureRect(cell);
  const rect = cropDisplayRect(visible, cropEdit.rect);
  const a = canvasToSource(cell, rect.x, rect.y);
  const b = canvasToSource(cell, rect.x + rect.w, rect.y + rect.h);
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const w = Math.abs(b.x - a.x);
  const h = Math.abs(b.y - a.y);

  const item = cell.item;
  if (w > 0.001 && h > 0.001) {
    item.crop = { x, y, w, h };
    item.w = Math.max(1, Math.round(rect.w));
    item.h = Math.max(1, Math.round(rect.h));
    item.x = Math.round(rect.x - layout.outer);
    item.y = Math.round(rect.y - layout.outer);
    const natural = naturalSizeOf(item);
    item.scale = natural.width > 0 ? item.w / natural.width : 1;
    clampItem(item);
  }

  cropEdit = null;
  cropDrag = null;
  updateSelectionPanel();
  scheduleRender();
}

// The picture left the canvas (or the library) under the frame.
function dropStaleCrop() {
  if (cropEdit && !state.items.some((item) => item.id === cropEdit.itemId)) cancelCrop();
}

function cropPointer(clientX, clientY) {
  const layout = computeLayout();
  const rect = els.canvas.getBoundingClientRect();
  if (!layout || !rect.width) return null;
  const scale = rect.width / layout.width;
  if (!scale) return null;
  return {
    layout,
    scale,
    x: (clientX - rect.left) / scale,
    y: (clientY - rect.top) / scale,
  };
}

function cropPointerDown(event) {
  const point = cropPointer(event.clientX, event.clientY);
  const cell = cropCell();
  if (!point || !cell || !cropEdit) return;

  const visible = pictureRect(cell);
  const rect = cropDisplayRect(visible, cropEdit.rect);
  const tolerance = CROP_HANDLE_SCREEN_PX / (point.scale || 1);
  // A frame that still covers the whole picture has nothing to move, so a drag
  // inside it draws a new one.  That is the first gesture: select an area.
  const wholePicture = cropCoversWholePicture();

  event.preventDefault();
  const handle = handleAt(rect, point.x, point.y, tolerance);
  if (handle) {
    cropDrag = { mode: handle, startX: point.x, startY: point.y, base: rect, visible };
  } else if (!wholePicture && insideRect(rect, point.x, point.y)) {
    cropDrag = { mode: 'move', startX: point.x, startY: point.y, base: rect, visible };
  } else {
    cropDrag = { mode: 'new', startX: point.x, startY: point.y, base: null, visible };
  }
  els.canvas.style.cursor = 'crosshair';
}

function cropPointerMove(event) {
  if (!cropEdit || !cropDrag) return;
  const point = cropPointer(event.clientX, event.clientY);
  if (!point) return;

  const bounds = cropDrag.visible;
  const min = MIN_CROP_SCREEN_PX / (lastCssScale || 1);
  const dx = point.x - cropDrag.startX;
  const dy = point.y - cropDrag.startY;
  // Shift is the quick 1:1 without letting go of the frame, and it outranks
  // whatever the ratio field holds for the length of the gesture.
  const ratio = event.shiftKey ? 1 : cropEdit.ratio;
  let rect;

  if (cropDrag.mode === 'new') {
    const sx = point.x >= cropDrag.startX ? 1 : -1;
    const sy = point.y >= cropDrag.startY ? 1 : -1;
    rect = cropFrameFrom(cropDrag.startX, cropDrag.startY, sx, sy,
      point.x, point.y, ratio, bounds, min);
  } else if (cropDrag.mode === 'move') {
    const base = cropDrag.base;
    rect = {
      x: clamp(base.x + dx, bounds.x, bounds.x + bounds.w - base.w),
      y: clamp(base.y + dy, bounds.y, bounds.y + bounds.h - base.h),
      w: base.w,
      h: base.h,
    };
  } else {
    const base = cropDrag.base;
    const mode = cropDrag.mode;
    const corner = (mode.includes('w') || mode.includes('e'))
      && (mode.includes('n') || mode.includes('s'));

    if (!corner) {
      rect = cropFrameFromSide(base, mode, point.x, point.y, ratio, bounds, min);
    } else {
      // A corner keeps the corner opposite it still, so the frame grows in one
      // direction only.
      const ax = mode.includes('w') ? base.x + base.w : base.x;
      const ay = mode.includes('n') ? base.y + base.h : base.y;
      const sx = mode.includes('w') ? -1 : 1;
      const sy = mode.includes('n') ? -1 : 1;
      rect = cropFrameFrom(ax, ay, sx, sy, point.x, point.y, ratio, bounds, min);
    }
  }

  cropEdit.rect = {
    x: (rect.x - bounds.x) / bounds.w,
    y: (rect.y - bounds.y) / bounds.h,
    w: rect.w / bounds.w,
    h: rect.h / bounds.h,
  };
  scheduleRender();
}

// The cursor names the handle under the pointer, so the frame says how it can
// be grabbed without any other explanation.
function cropCursor(clientX, clientY) {
  const cell = cropCell();
  const point = cropPointer(clientX, clientY);
  if (!cell || !point || !cropEdit) return 'crosshair';

  const visible = pictureRect(cell);
  const rect = cropDisplayRect(visible, cropEdit.rect);
  const handle = handleAt(rect, point.x, point.y,
    CROP_HANDLE_SCREEN_PX / (point.scale || 1));
  if (handle === 'nw' || handle === 'se') return 'nwse-resize';
  if (handle === 'ne' || handle === 'sw') return 'nesw-resize';
  if (handle === 'n' || handle === 's') return 'ns-resize';
  if (handle === 'w' || handle === 'e') return 'ew-resize';
  return insideRect(rect, point.x, point.y) && !cropCoversWholePicture() ? 'move' : 'crosshair';
}

// Dimmed outside, thirds inside, eight handles on the frame: enough to line a
// crop up with the picture, drawn over the preview only.
function paintCrop(ctx, layout, scale) {
  if (!cropEdit) return;
  const cell = layout.cells.find((candidate) => candidate.item.id === cropEdit.itemId);
  if (!cell) return;

  const visible = pictureRect(cell);
  const rect = cropDisplayRect(visible, cropEdit.rect);
  const handle = 9 / scale;

  ctx.save();
  ctx.scale(scale, scale);

  ctx.beginPath();
  ctx.rect(0, 0, layout.width, layout.height);
  ctx.rect(rect.x, rect.y, rect.w, rect.h);
  ctx.fillStyle = 'rgba(8, 8, 12, 0.55)';
  ctx.fill('evenodd');

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.32)';
  ctx.lineWidth = 1 / scale;
  ctx.beginPath();
  for (let part = 1; part <= 2; part += 1) {
    ctx.moveTo(rect.x + (rect.w * part) / 3, rect.y);
    ctx.lineTo(rect.x + (rect.w * part) / 3, rect.y + rect.h);
    ctx.moveTo(rect.x, rect.y + (rect.h * part) / 3);
    ctx.lineTo(rect.x + rect.w, rect.y + (rect.h * part) / 3);
  }
  ctx.stroke();

  // A dark hairline under the white frame keeps it readable on pale pictures.
  ctx.lineWidth = 2.6 / scale;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
  ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
  ctx.lineWidth = 1.4 / scale;
  ctx.strokeStyle = '#ffffff';
  ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);

  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
  ctx.lineWidth = 1 / scale;
  for (const name of HANDLES) {
    const hx = name.includes('w') ? rect.x
      : name.includes('e') ? rect.x + rect.w
        : rect.x + rect.w / 2;
    const hy = name.includes('n') ? rect.y
      : name.includes('s') ? rect.y + rect.h
        : rect.y + rect.h / 2;
    ctx.beginPath();
    ctx.rect(hx - handle / 2, hy - handle / 2, handle, handle);
    ctx.fill();
    ctx.stroke();
  }

  ctx.restore();
}

// ---------------------------------------------------------------------------
//  Undo and redo
//
//  A step is a snapshot of the composition: the items on the canvas, the library
//  they are drawn from, and the settings that frame them.  Snapshots are read
//  back from what is on screen rather than recorded by each call that changes
//  it, so a new action becomes undoable without registering itself anywhere, and
//  a gesture - a drag, a slider pull, a burst of wheel notches - is one step
//  rather than a hundred.
//
//  A picture taken out of the library is not released on the spot: steps still
//  hold it, and its preview bitmap and blob URL are freed only once nothing can
//  bring it back.
// ---------------------------------------------------------------------------

const HISTORY_LIMIT = 60;      // steps kept before the oldest falls off
const HISTORY_DELAY = 350;     // ms of quiet before a change counts as done

const undoSteps = { past: [], future: [] };
let historyTimer = 0;
let historyNow = null;         // what is on screen, as a snapshot

// Everything a picture is placed, sized, cropped or framed by.  The export
// format, the quality, the theme and the view are preferences rather than the
// composition, so a step leaves them alone.
const DOCUMENT_KEYS = [
  'preset', 'evenSize', 'spacing', 'spacingOn', 'outer',
  'border', 'borderOn', 'radius', 'frameColor', 'borderColor', 'backdrop',
];

// Pictures that left the library, kept until no step refers to them.
const retiredSources = new Map();

function cloneItem(item) {
  return { ...item, crop: item.crop ? { ...item.crop } : null };
}

function snapshotState() {
  const settings = {};
  for (const key of DOCUMENT_KEYS) settings[key] = state[key];
  return {
    settings,
    sources: state.sources.slice(),
    items: state.items.map(cloneItem),
  };
}

// Items and settings are plain data, so the cheap comparison is the honest one;
// a library is the same library when it holds the same pictures, in order.
function sameSnapshot(a, b) {
  return !!a && !!b
    && JSON.stringify(a.items) === JSON.stringify(b.items)
    && JSON.stringify(a.settings) === JSON.stringify(b.settings)
    && a.sources.length === b.sources.length
    && a.sources.every((source, index) => source === b.sources[index]);
}

function releaseSource(source) {
  if (source.bitmap) source.bitmap.close();
  if (source.url) URL.revokeObjectURL(source.url);
}

// Frees the pictures that left the library and that no step can restore.
function releaseForgottenSources() {
  const alive = new Set(state.sources.map((source) => source.id));
  for (const snapshot of [...undoSteps.past, historyNow, ...undoSteps.future]) {
    if (!snapshot) continue;
    for (const source of snapshot.sources) alive.add(source.id);
  }
  for (const [id, source] of [...retiredSources]) {
    if (alive.has(id)) continue;
    releaseSource(source);
    retiredSources.delete(id);
  }
}

function updateHistoryButtons() {
  els.undoButton.disabled = undoSteps.past.length === 0;
  els.redoButton.disabled = undoSteps.future.length === 0;
}

// Records what is on screen, if it differs from the last step.  Called when a
// change settles, never for every pixel of a gesture: a change that arrives
// mid-gesture is recorded by the pointer-up that ends it.
function commitHistory() {
  if (canvasDrag || resizeDrag || cropDrag) return;

  clearTimeout(historyTimer);
  historyTimer = 0;

  const now = snapshotState();
  if (sameSnapshot(now, historyNow)) return;

  if (historyNow) {
    undoSteps.past.push(historyNow);
    if (undoSteps.past.length > HISTORY_LIMIT) undoSteps.past.shift();
    undoSteps.future.length = 0;
  }
  historyNow = now;
  releaseForgottenSources();
  updateHistoryButtons();
}

// A change is on its way: record it once the interface goes quiet.  Mid-gesture
// there is nothing to record yet, because the step is the gesture itself.
function noteDocumentChange() {
  if (canvasDrag || resizeDrag || cropDrag || wheelZoomHold) return;
  clearTimeout(historyTimer);
  historyTimer = setTimeout(commitHistory, HISTORY_DELAY);
}

function restoreSnapshot(snapshot) {
  cancelCrop();

  state.sources = snapshot.sources.slice();
  state.items = snapshot.items.map(cloneItem);
  for (const key of DOCUMENT_KEYS) state[key] = snapshot.settings[key];

  // The picture that was selected may be part of the step being undone.
  if (!state.items.some((item) => item.id === state.selectedItemId)) {
    const last = state.items[state.items.length - 1];
    state.selectedItemId = last ? last.id : null;
  }

  for (const key of Object.keys(DEFAULTS)) syncControls(key);
  updateDependentLabels();
  updateFieldAvailability();
  renderStrip();
  updateSelectionPanel();

  historyNow = snapshotState();
  updateHistoryButtons();
  releaseForgottenSources();
  scheduleRender();
}

function undo() {
  if (canvasDrag || resizeDrag || cropDrag) return;
  // A change that has not settled yet is a step of its own, so it is recorded
  // first and then undone.
  commitHistory();
  const previous = undoSteps.past.pop();
  if (!previous) return;
  undoSteps.future.push(historyNow);
  restoreSnapshot(previous);
}

function redo() {
  if (canvasDrag || resizeDrag || cropDrag) return;
  commitHistory();
  const next = undoSteps.future.pop();
  if (!next) return;
  undoSteps.past.push(historyNow);
  restoreSnapshot(next);
}

// ---------------------------------------------------------------------------
//  Preview
// ---------------------------------------------------------------------------

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  noteDocumentChange();
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function render() {
  const layout = computeLayout();
  const hasItems = state.items.length > 0;

  els.empty.hidden = hasItems;
  els.sheet.hidden = !hasItems;
  els.zoom.hidden = !hasItems;
  updateEmptyState();
  updateAlignButtons();

  if (!layout) {
    updateStatus(null);
    updateExportState(null);
    return;
  }

  const stageRect = els.stage.getBoundingClientRect();
  const availableWidth = Math.max(80, stageRect.width - 76);
  const availableHeight = Math.max(80, stageRect.height - 76);
  const fitScale = Math.min(availableWidth / layout.width, availableHeight / layout.height, 1);

  const cssScale = state.zoom === 'fit'
    ? fitScale
    : clamp(state.zoom, 0.02, 8);
  lastCssScale = cssScale;

  const dpr = window.devicePixelRatio || 1;
  const renderScale = Math.min(cssScale * dpr, 1);
  const pixelWidth = Math.max(1, Math.round(layout.width * renderScale));
  const pixelHeight = Math.max(1, Math.round(layout.height * renderScale));

  if (els.canvas.width !== pixelWidth || els.canvas.height !== pixelHeight) {
    els.canvas.width = pixelWidth;
    els.canvas.height = pixelHeight;
  }

  els.canvas.style.width = `${layout.width * cssScale}px`;
  els.canvas.style.height = `${layout.height * cssScale}px`;

  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, pixelWidth, pixelHeight);
  paintBackground(context, layout, renderScale);

  // Every ring first, then every picture: the shared band between two arranged
  // pictures is the same pixels twice, and where they are still too close the
  // picture sits on top of the border rather than being cropped by it.
  context.save();
  context.scale(renderScale, renderScale);
  for (const cell of layout.cells) paintRing(context, cell, layout.border);
  context.restore();

  for (const cell of layout.cells) {
    if (!cell.source || !cell.source.bitmap) continue;
    context.save();
    context.scale(renderScale, renderScale);
    paintPicture(context, cell, cell.source.bitmap, veilFor(cell.item));
    context.restore();
  }

  paintCrop(context, layout, renderScale);

  updateStatus(layout);
  updateExportState(layout);
  updateZoomLabel(cssScale);
}

function updateStatus(layout) {
  const placed = state.items.length;
  const library = state.sources.length;

  els.imageCount.textContent = String(library);
  els.statusCount.textContent = library === 0
    ? 'No images'
    : `${placed} of ${library} placed`;

  if (!layout) {
    els.statusSize.textContent = '—';
    els.statusHint.textContent = library
      ? 'Drag a picture onto the canvas'
      : 'Drop photos, or press Ctrl+O';
    return;
  }

  els.statusSize.textContent = `${formatNumber(layout.width)} × ${formatNumber(layout.height)} px`;

  const limit = canvasLimitMessage(layout);
  els.limit.hidden = !limit;
  if (limit) els.limit.textContent = limit;

  els.statusHint.textContent = limit ? 'Too large to export' : 'Ctrl+E to export';
}

function updateEmptyState() {
  const library = state.sources.length;
  els.emptyTitle.textContent = library
    ? 'Drag a picture onto the canvas'
    : 'Drop photos to place them';
  els.emptyText.textContent = library
    ? 'The list on the left holds your pictures. Drag one across, or click it to add it next to the last one.'
    : 'Drop them anywhere, or choose images and drag them onto the canvas.';
}

function updateZoomLabel(scale) {
  const percent = Math.round(scale * 100);
  els.zoomValue.textContent = state.zoom === 'fit' ? `Fit ${percent}%` : `${percent}%`;
}

function updateExportState(layout) {
  const limit = canvasLimitMessage(layout);
  els.exportButton.disabled = !layout || !!limit;
  els.exportButton.title = limit ? 'The output is larger than a canvas allows' : 'Export (Ctrl+E)';
}

// ---------------------------------------------------------------------------
//  Filmstrip
// ---------------------------------------------------------------------------

function renderStrip() {
  els.strip.replaceChildren();

  const used = new Map();
  for (const item of state.items) {
    used.set(item.sourceId, (used.get(item.sourceId) || 0) + 1);
  }

  state.sources.forEach((source, index) => {
    const item = document.createElement('li');
    item.className = 'thumb';
    item.tabIndex = 0;
    item.dataset.id = String(source.id);
    item.title = `${source.name}\n${formatNumber(source.width)} × ${formatNumber(source.height)} px\n` +
      'Click to add · drag onto the canvas · drag up or down to reorder';

    const count = used.get(source.id) || 0;
    item.innerHTML =
      `<span class="thumb-index">${index + 1}</span>` +
      `<img class="thumb-image" src="${source.url}" alt="" draggable="false">` +
      (count > 1 ? `<span class="thumb-count" title="${count} on the canvas">×${count}</span>` : '') +
      `<span class="thumb-meta">` +
        `<span class="thumb-name">${escapeHtml(source.name)}</span>` +
        `<span class="thumb-size">${source.width} × ${source.height}</span>` +
      `</span>` +
      `<button class="thumb-remove" type="button" title="Remove from the list"` +
        ` aria-label="Remove ${escapeHtml(source.name)} from the list">×</button>`;

    // The X must not turn into a carry: pressing it would otherwise start the
    // drag of the thumbnail underneath it.
    const remove = item.querySelector('.thumb-remove');
    remove.addEventListener('pointerdown', (event) => event.stopPropagation());
    remove.addEventListener('keydown', (event) => event.stopPropagation());
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      removeSource(source);
    });

    item.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        addSourceHere(source);
      }
    });

    // Right-clicking the list does nothing, on purpose.
    item.addEventListener('contextmenu', (event) => event.preventDefault());

    item.addEventListener('pointerdown', (event) => startCarry(event, source, item));

    els.strip.append(item);
  });
}

function addSourceHere(source, point = null) {
  placeSources([source], point);
  renderStrip();
  updateSelectionPanel();
  scheduleRender();
}

// Carrying a picture out of the list: a click adds it after the last one, a
// drag drops it where it is let go.  Either way the source stays in the list,
// so carrying the same picture twice produces two items.
//
// The library has an order of its own, and a drag that stays in the rail
// changes it: the thumbnail is lifted and the others shuffle around it, and the
// order is read back off the list when the pointer is let go.  Which of the two
// a drag is comes down to where the pointer goes - up and down within the rail
// reorders, out to the stage carries - so leaving the rail during a reorder
// turns it into a carry with the list put back as it was found.
let carry = null;

function pointInRect(x, y, rect) {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function outOfStrip(clientX) {
  return clientX > els.strip.getBoundingClientRect().right + 12;
}

function startCarry(event, source, element) {
  if (event.button !== 0) return;
  event.preventDefault();

  carry = {
    source,
    element,
    startX: event.clientX,
    startY: event.clientY,
    moved: false,
    mode: null,
    ghost: null,
  };

  window.addEventListener('pointermove', onCarryMove);
  window.addEventListener('pointerup', onCarryUp, { once: true });
}

function beginReorder() {
  carry.mode = 'reorder';
  els.strip.classList.add('reordering');
  carry.element.classList.add('reordering');
}

function beginCarry() {
  carry.mode = 'carry';
  els.strip.classList.remove('reordering');

  const ghost = document.createElement('img');
  ghost.className = 'drag-ghost';
  ghost.src = carry.source.url;
  ghost.alt = '';
  document.body.append(ghost);
  carry.ghost = ghost;
  carry.element.classList.add('carrying');
}

// The lifted thumbnail travels through the list: every move drops it in front of
// the first thumbnail whose middle the pointer has passed.
function moveInStrip(clientY) {
  const others = [...els.strip.querySelectorAll('li.thumb')]
    .filter((element) => element !== carry.element);
  const next = others.find((element) => {
    const rect = element.getBoundingClientRect();
    return clientY < rect.top + rect.height / 2;
  });
  els.strip.insertBefore(carry.element, next || null);

  // A list longer than the rail has to scroll while a picture is carried past
  // its edge.
  const bounds = els.strip.getBoundingClientRect();
  if (clientY < bounds.top + 28) els.strip.scrollTop -= 12;
  else if (clientY > bounds.bottom - 28) els.strip.scrollTop += 12;
}

function onCarryMove(event) {
  if (!carry) return;
  const dx = event.clientX - carry.startX;
  const dy = event.clientY - carry.startY;

  if (!carry.moved) {
    if (Math.hypot(dx, dy) < 5) return;
    carry.moved = true;
    if (outOfStrip(event.clientX)) beginCarry();
    else beginReorder();
  }

  if (carry.mode === 'reorder' && outOfStrip(event.clientX)) {
    // Out of the rail, on the way to the stage: the list goes back the way it
    // started and the picture is carried like any other.
    els.strip.classList.remove('reordering');
    renderStrip();
    beginCarry();
  }

  if (carry.mode === 'reorder') {
    moveInStrip(event.clientY);
    return;
  }

  carry.ghost.style.transform = `translate(${event.clientX - 44}px, ${event.clientY - 44}px)`;
  const over = pointInRect(event.clientX, event.clientY, els.stage.getBoundingClientRect());
  document.body.classList.toggle('carrying-to-canvas', over);
}

// The list is the source of truth at this point: the drag put the thumbnails
// where they belong, so the library is rewritten to match.
function finishReorder() {
  const byId = new Map(state.sources.map((source) => [source.id, source]));
  const order = [...els.strip.querySelectorAll('li.thumb')]
    .map((element) => byId.get(Number(element.dataset.id)))
    .filter(Boolean);

  const changed = order.length === state.sources.length
    && order.some((source, index) => source !== state.sources[index]);

  if (changed) {
    state.sources = order;
    scheduleRender();
  }

  // Redrawing puts the thumbnails back in the library's order, badges and all,
  // whichever way the drag ended.
  renderStrip();
}

function onCarryUp(event) {
  window.removeEventListener('pointermove', onCarryMove);

  const gesture = carry;
  carry = null;
  document.body.classList.remove('carrying-to-canvas');
  if (!gesture) return;

  if (gesture.ghost) gesture.ghost.remove();
  els.strip.classList.remove('reordering');
  gesture.element.classList.remove('reordering', 'carrying');

  if (gesture.mode === 'reorder') {
    finishReorder();
    return;
  }

  if (!gesture.moved) {
    addSourceHere(gesture.source);
    return;
  }
  if (!pointInRect(event.clientX, event.clientY, els.stage.getBoundingClientRect())) return;
  addSourceHere(gesture.source, layoutPoint(event.clientX, event.clientY));
}

// ---------------------------------------------------------------------------
//  Thumbnail context menu
// ---------------------------------------------------------------------------

let openMenu = null;

function onMenuPointerDown(event) {
  if (openMenu && !openMenu.contains(event.target)) closeImageMenu();
}

function onMenuKeyDown(event) {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  // The menu takes the key: Escape closes it and nothing else, rather than
  // closing it and dropping the selection in the same press.
  event.stopPropagation();
  closeImageMenu();
}

function closeImageMenu() {
  if (!openMenu) return;
  openMenu.remove();
  openMenu = null;
  document.removeEventListener('pointerdown', onMenuPointerDown, true);
  document.removeEventListener('keydown', onMenuKeyDown, true);
  window.removeEventListener('resize', closeImageMenu);
  window.removeEventListener('blur', closeImageMenu);
}

function showImageMenu(id, x, y) {
  closeImageMenu();
  if (!state.items.some((item) => item.id === id)) return;

  const menu = document.createElement('div');
  menu.className = 'image-menu';
  menu.setAttribute('role', 'menu');

  const add = (label, run, className) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.setAttribute('role', 'menuitem');
    if (className) button.className = className;
    button.addEventListener('click', () => {
      closeImageMenu();
      run();
    });
    menu.append(button);
  };

  const edit = (change) => {
    const item = state.items.find((candidate) => candidate.id === id);
    if (!item) return;
    change(item);
    resizeItems();
    updateSelectionPanel();
    scheduleRender();
  };

  add('Rotate 90°', () => edit((item) => { item.rot = (item.rot + 90) % 360; }));
  add('Flip horizontal', () => edit((item) => { item.flipH = !item.flipH; }));
  add('Flip vertical', () => edit((item) => { item.flipV = !item.flipV; }));

  const separator = document.createElement('div');
  separator.className = 'menu-sep';
  menu.append(separator);

  add('Remove', () => removeItem(id), 'danger');

  menu.style.left = '0px';
  menu.style.top = '0px';
  document.body.append(menu);

  const box = menu.getBoundingClientRect();
  menu.style.left = `${clamp(x, 6, Math.max(6, window.innerWidth - box.width - 6))}px`;
  menu.style.top = `${clamp(y, 6, Math.max(6, window.innerHeight - box.height - 6))}px`;

  openMenu = menu;
  // The click that opened the menu is still being dispatched; listen on the
  // next turn, so it cannot immediately dismiss what it just opened.
  setTimeout(() => {
    if (!openMenu) return;
    document.addEventListener('pointerdown', onMenuPointerDown, true);
    document.addEventListener('keydown', onMenuKeyDown, true);
    window.addEventListener('resize', closeImageMenu);
    window.addEventListener('blur', closeImageMenu);
  }, 0);
}

// ---------------------------------------------------------------------------
//  Selected image panel
// ---------------------------------------------------------------------------

function selectedItem() {
  return state.items.find((item) => item.id === state.selectedItemId) || null;
}

function updateSelectionPanel() {
  const item = selectedItem();
  const source = item ? sourceById(item.sourceId) : null;
  const cropping = !!cropEdit;

  // The crop bar answers to the frame, not to the selection, so it is settled
  // before the early return below.
  els.cropBar.hidden = !cropping;
  els.cropButton.disabled = cropping;

  els.selectionGroup.hidden = !item || !source;
  if (!item || !source) return;

  els.selectedThumb.src = source.url;
  els.selectedName.textContent = source.name;
  els.selectedName.title = `${source.name}\n${formatNumber(source.width)} × ${formatNumber(source.height)} px`;
  els.selectedSize.textContent = `${formatNumber(item.w)} × ${formatNumber(item.h)} px`;
}

// ---------------------------------------------------------------------------
//  Moving pictures on the canvas
// ---------------------------------------------------------------------------

const SNAP_SCREEN_PX = 9;
const RESIZE_HANDLE_SCREEN_PX = 11;   // how close to an edge or corner sizes it

// Pointer position in canvas coordinates (output pixels, before the outer mat).
function layoutPoint(clientX, clientY) {
  const layout = computeLayout();
  const rect = els.canvas.getBoundingClientRect();
  if (!layout || !rect.width) return null;
  const scale = rect.width / layout.width;
  if (!scale) return null;
  return {
    x: (clientX - rect.left) / scale - layout.outer,
    y: (clientY - rect.top) / scale - layout.outer,
  };
}

function itemAt(layout, x, y) {
  for (let index = layout.cells.length - 1; index >= 0; index -= 1) {
    const cell = layout.cells[index];
    if (x >= cell.x && x <= cell.x + cell.w && y >= cell.y && y <= cell.y + cell.h) {
      return cell.item;
    }
  }
  return null;
}

// Pulls a dragged picture onto a neighbour's edge or centre when it is close
// enough.  Neighbours meet edge to edge and then keep `border + spacing`
// between their pictures, so the two rings share one band instead of stacking
// into a double thickness: the snap lands on the middle of the two borders.
// Both edges and centres of every other picture, and the canvas edge, are
// candidates.
function snapItem(item) {
  const threshold = SNAP_SCREEN_PX / (lastCssScale || 1);
  const border = borderPx();
  const apart = border + spacingPx();
  const xs = [border];
  const ys = [border];

  for (const other of state.items) {
    if (other.id === item.id) continue;
    xs.push(
      other.x,
      other.x + other.w + apart,
      other.x - item.w - apart,
      other.x + other.w - item.w,
      other.x + (other.w - item.w) / 2,
    );
    ys.push(
      other.y,
      other.y + other.h + apart,
      other.y - item.h - apart,
      other.y + other.h - item.h,
      other.y + (other.h - item.h) / 2,
    );
  }

  const nearest = (value, candidates) => {
    let best = value;
    let bestDistance = threshold;
    for (const candidate of candidates) {
      const distance = Math.abs(candidate - value);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = candidate;
      }
    }
    return best;
  };

  item.x = Math.round(nearest(item.x, xs));
  item.y = Math.round(nearest(item.y, ys));
}

// The nearest place a single edge can land.  Edges are in picture coordinates
// for the same reason a move snaps there: two neighbours are `border + spacing`
// apart, so their rings share one band rather than stacking.  Both of a
// neighbour's edges, the two positions that leave that gap, and the canvas edge
// are candidates.
function snapEdge(value, axis, item, threshold) {
  const border = borderPx();
  const apart = border + spacingPx();
  let best = value;
  let bestDistance = threshold;

  const consider = (candidate) => {
    const distance = Math.abs(candidate - value);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  };

  consider(border);
  for (const other of state.items) {
    if (other.id === item.id) continue;
    const low = axis === 'x' ? other.x : other.y;
    const size = axis === 'x' ? other.w : other.h;
    consider(low);
    consider(low + size);
    consider(low - apart);
    consider(low + size + apart);
  }
  return best;
}

// The selected picture's own rectangle, which is what its handles sit on.
function selectedPictureRect(layout) {
  const item = selectedItem();
  if (!item) return null;
  const cell = layout.cells.find((candidate) => candidate.item.id === item.id);
  return cell ? pictureRect(cell) : null;
}

function resizeCursor(handle) {
  if (handle === 'nw' || handle === 'se') return 'nwse-resize';
  if (handle === 'ne' || handle === 'sw') return 'nesw-resize';
  if (handle === 'n' || handle === 's') return 'ns-resize';
  return 'ew-resize';
}

let resizeDrag = null;   // { item, handle, scale, wasFit, clientX, clientY, start, aspect }

// A handle sizes the selected picture at its own ratio, about the corner or
// edge opposite the one held.  Even size steps aside, because a picture sized
// by hand is no longer the shared edge, and the view holds still for the
// gesture the way a move does.
function startResize(item, handle, event, scale) {
  releaseEvenSize();
  const wasFit = state.zoom === 'fit';
  if (wasFit) state.zoom = scale;
  resizeDrag = {
    item,
    handle,
    scale,
    wasFit,
    clientX: event.clientX,
    clientY: event.clientY,
    start: { x: item.x, y: item.y, w: item.w, h: item.h },
    aspect: item.h > 0 ? item.w / item.h : 1,
  };
  els.canvas.style.cursor = resizeCursor(handle);
}

function resizePointerMove(event) {
  const drag = resizeDrag;
  const { item, handle, start, aspect } = drag;
  const horizontal = handle.includes('e') || handle.includes('w');
  const vertical = handle.includes('n') || handle.includes('s');

  const dx = (event.clientX - drag.clientX) / drag.scale;
  const dy = (event.clientY - drag.clientY) / drag.scale;
  let w = start.w;
  let h = start.h;
  if (handle.includes('e')) w = start.w + dx;
  if (handle.includes('w')) w = start.w - dx;
  if (handle.includes('s')) h = start.h + dy;
  if (handle.includes('n')) h = start.h - dy;

  // The picture's own shape is kept whatever the handle: a corner follows the
  // pointer along the diagonal (the two answers are averaged, so neither axis
  // wins the tug of war the ratio sets up), an edge takes the other side with
  // it.
  if (horizontal && vertical) {
    w = (w + h * aspect) / 2;
    h = w / aspect;
  } else if (horizontal) {
    h = w / aspect;
  } else {
    w = h * aspect;
  }

  if (w < MIN_ITEM_SIDE) { w = MIN_ITEM_SIDE; h = w / aspect; }
  if (h < MIN_ITEM_SIDE) { h = MIN_ITEM_SIDE; w = h * aspect; }
  if (w > MAX_ITEM_SIDE) { w = MAX_ITEM_SIDE; h = w / aspect; }
  if (h > MAX_ITEM_SIDE) { h = MAX_ITEM_SIDE; w = h * aspect; }

  // Snapping works on the edge under the hand: the corner or side opposite it
  // stays where it was, so a snap changes the size rather than the position.
  // Shift steps aside, the way it does for a move.
  const threshold = SNAP_SCREEN_PX / drag.scale;
  if (!event.shiftKey) {
    if (horizontal) {
      const anchor = handle.includes('e') ? start.x : start.x + start.w;
      const edge = handle.includes('e') ? anchor + w : anchor - w;
      const snapped = snapEdge(edge, 'x', item, threshold);
      const snappedW = handle.includes('e') ? snapped - anchor : anchor - snapped;
      if (snapped !== edge && snappedW >= MIN_ITEM_SIDE) {
        w = snappedW;
        h = w / aspect;
      }
    }
    if (vertical) {
      const anchor = handle.includes('s') ? start.y : start.y + start.h;
      const edge = handle.includes('s') ? anchor + h : anchor - h;
      const snapped = snapEdge(edge, 'y', item, threshold);
      const snappedH = handle.includes('s') ? snapped - anchor : anchor - snapped;
      if (snapped !== edge && snappedH >= MIN_ITEM_SIDE) {
        h = snappedH;
        w = h * aspect;
      }
    }
  }

  // A size kept as a scale rather than as pixels survives a later crop,
  // rotation or arrangement; the rounding happens once, on the way out.
  const natural = naturalSizeOf(item);
  item.scale = natural.width > 0 ? w / natural.width : 1;
  const size = sizeFor(item, null);
  item.w = Math.max(1, Math.round(size.w));
  item.h = Math.max(1, Math.round(size.h));
  item.x = Math.round(
    handle.includes('e') ? start.x
      : handle.includes('w') ? start.x + start.w - item.w
        : start.x + (start.w - item.w) / 2,
  );
  item.y = Math.round(
    handle.includes('s') ? start.y
      : handle.includes('n') ? start.y + start.h - item.h
        : start.y + (start.h - item.h) / 2,
  );
  clampItem(item);

  updateSelectionPanel();
  scheduleRender();
}

let canvasDrag = null;

function bindCanvas() {
  els.canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    if (cropEdit) {
      cropPointerDown(event);
      return;
    }
    const layout = computeLayout();
    if (!layout) return;

    const rect = els.canvas.getBoundingClientRect();
    const scale = rect.width / layout.width;
    const x = (event.clientX - rect.left) / scale;
    const y = (event.clientY - rect.top) / scale;
    const item = itemAt(layout, x, y);

    event.preventDefault();

    // A handle on the selected picture is grabbed before the picture itself:
    // the pointer is over it, and a drag would otherwise move the picture.
    const picture = selectedPictureRect(layout);
    const handle = picture
      ? resizeHandleAt(picture, x, y, RESIZE_HANDLE_SCREEN_PX / scale)
      : null;
    if (handle) {
      startResize(selectedItem(), handle, event, scale);
      return;
    }

    if (!item) {
      selectItem(null);
      return;
    }

    selectItem(item.id);

    // The sheet is re-fitted after a drop, but during the drag it has to hold
    // still: a changing scale would move the picture under the pointer.
    const wasFit = state.zoom === 'fit';
    if (wasFit) state.zoom = scale;

    canvasDrag = {
      item,
      scale,
      wasFit,
      startX: item.x,
      startY: item.y,
      clientX: event.clientX,
      clientY: event.clientY,
      moved: false,
    };
    els.canvas.style.cursor = 'grabbing';
  });

  // A press on the stage around the canvas lets go of the selection.  The canvas
  // itself does the same when the point misses every picture, so between them
  // there is always a way to have nothing selected at all.
  els.stage.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || cropEdit) return;
    if (els.canvas.contains(event.target)) return;
    selectItem(null);
  });

  window.addEventListener('pointermove', (event) => {
    if (cropDrag) {
      cropPointerMove(event);
      return;
    }
    if (resizeDrag) {
      resizePointerMove(event);
      return;
    }
    if (!canvasDrag) return;
    const dx = (event.clientX - canvasDrag.clientX) / canvasDrag.scale;
    const dy = (event.clientY - canvasDrag.clientY) / canvasDrag.scale;
    if (!canvasDrag.moved && Math.hypot(dx, dy) * canvasDrag.scale < 3) return;

    canvasDrag.moved = true;
    const { item } = canvasDrag;
    item.x = Math.round(canvasDrag.startX + dx);
    item.y = Math.round(canvasDrag.startY + dy);
    // Shift places the picture exactly where the pointer is: no edge, centre
    // or gap is allowed to pull it off the line the hand drew.
    if (!event.shiftKey) snapItem(item);
    clampItem(item);
    scheduleRender();
  });

  window.addEventListener('pointerup', (event) => {
    if (cropDrag) {
      cropDrag = null;
      els.canvas.style.cursor = cropCursor(event.clientX, event.clientY);
      return;
    }
    if (resizeDrag) {
      const { wasFit } = resizeDrag;
      resizeDrag = null;
      els.canvas.style.cursor = '';
      if (wasFit) state.zoom = 'fit';
      scheduleRender();
      commitHistory();
      return;
    }
    if (!canvasDrag) return;
    const { wasFit } = canvasDrag;
    canvasDrag = null;
    els.canvas.style.cursor = '';
    // Once the gesture is over the view fits the composition again.
    if (wasFit) state.zoom = 'fit';
    scheduleRender();
    commitHistory();
  });

  // A grab cursor over a picture, which is also the hint that it can be moved,
  // and a resize cursor on a selected picture's handles.
  els.canvas.addEventListener('pointermove', (event) => {
    if (canvasDrag || resizeDrag) return;
    if (cropEdit) {
      els.canvas.style.cursor = cropCursor(event.clientX, event.clientY);
      return;
    }
    const layout = computeLayout();
    if (!layout) return;
    const rect = els.canvas.getBoundingClientRect();
    const scale = rect.width / layout.width;
    const x = (event.clientX - rect.left) / scale;
    const y = (event.clientY - rect.top) / scale;
    const picture = selectedPictureRect(layout);
    const handle = picture
      ? resizeHandleAt(picture, x, y, RESIZE_HANDLE_SCREEN_PX / scale)
      : null;
    if (handle) {
      els.canvas.style.cursor = resizeCursor(handle);
      setHovered(state.selectedItemId);
      return;
    }
    const item = itemAt(layout, x, y);
    els.canvas.style.cursor = item ? 'grab' : 'default';
    setHovered(item ? item.id : null);
  });

  els.canvas.addEventListener('pointerleave', () => setHovered(null));

  els.canvas.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    if (cropEdit) return;
    const layout = computeLayout();
    if (!layout) return;
    const rect = els.canvas.getBoundingClientRect();
    const scale = rect.width / layout.width;
    const item = itemAt(
      layout,
      (event.clientX - rect.left) / scale,
      (event.clientY - rect.top) / scale,
    );
    if (!item) return;
    selectItem(item.id);
    showImageMenu(item.id, event.clientX, event.clientY);
  });
}

// ---------------------------------------------------------------------------
//  The wheel
//
//  A wheel notch over a picture resizes that picture, about its own centre: the
//  composition is placed by hand, so growing one picture must not move the
//  others.  Ctrl still zooms the view, wherever the pointer is, and over empty
//  canvas the wheel is left to scroll.
// ---------------------------------------------------------------------------

const WHEEL_SCALE_STEP = 1.05;     // one notch, roughly five per cent
const MIN_ITEM_SIDE = 8;           // output pixels, so a picture cannot vanish
const MAX_ITEM_SIDE = 20000;       // well past any sane stitch

let wheelZoomHold = null;          // { wasFit, timer } — see holdZoomForWheel

// Resizing one picture by hand means the pictures no longer share an edge, so
// Even size steps aside.  The sizes already on the canvas are kept, as a scale
// per picture, rather than snapping everything back to its source size.
function releaseEvenSize() {
  if (!state.evenSize) return;
  for (const item of state.items) {
    const natural = naturalSizeOf(item);
    item.scale = natural.width > 0 ? item.w / natural.width : 1;
  }
  state.evenSize = false;
  syncControls('evenSize');
  updateDependentLabels();
  saveSettingsSoon();
}

function scaleItemAboutCentre(item, factor) {
  const natural = naturalSizeOf(item);
  if (!natural.width || !natural.height) return;

  releaseEvenSize();

  const current = Math.max(0.01, Number(item.scale) || 1);
  const low = Math.min(current, MIN_ITEM_SIDE / Math.max(1, Math.min(natural.width, natural.height)));
  const high = Math.max(current, MAX_ITEM_SIDE / Math.max(1, Math.max(natural.width, natural.height)));
  const next = clamp(current * factor, low, high);
  if (Math.abs(next - current) < 1e-6) return;

  const centreX = item.x + item.w / 2;
  const centreY = item.y + item.h / 2;
  item.scale = next;

  const size = sizeFor(item, null);
  item.w = Math.max(1, Math.round(size.w));
  item.h = Math.max(1, Math.round(size.h));
  item.x = Math.round(centreX - item.w / 2);
  item.y = Math.round(centreY - item.h / 2);
  clampItem(item);

  updateSelectionPanel();
  scheduleRender();
}

// Fit would re-fit the whole composition after every notch, so the picture
// under the pointer would barely change while the rest of the canvas shrank.
// The view is held at the scale it had, and returns to Fit shortly after the
// wheel stops.
function holdZoomForWheel() {
  if (!wheelZoomHold) wheelZoomHold = { wasFit: state.zoom === 'fit' };
  if (wheelZoomHold.wasFit) state.zoom = lastCssScale;
  clearTimeout(wheelZoomHold.timer);
  wheelZoomHold.timer = setTimeout(() => {
    if (!wheelZoomHold) return;
    const { wasFit } = wheelZoomHold;
    wheelZoomHold = null;
    if (wasFit) {
      state.zoom = 'fit';
      scheduleRender();
    }
    // The burst of notches was one size, so it is one step to undo.
    commitHistory();
  }, 600);
}

function wheelResize(event) {
  const layout = computeLayout();
  if (!layout) return false;
  const rect = els.canvas.getBoundingClientRect();
  if (!rect.width) return false;

  const scale = rect.width / layout.width;
  const item = itemAt(
    layout,
    (event.clientX - rect.left) / scale,
    (event.clientY - rect.top) / scale,
  );
  if (!item) return false;

  // Chromium reports a mouse notch as 100 pixels; a touchpad reports less, and
  // then the same number of pixels gives a proportionally smaller step.
  const notches = event.deltaMode === 1 ? event.deltaY : event.deltaY / 100;
  holdZoomForWheel();
  scaleItemAboutCentre(item, Math.pow(WHEEL_SCALE_STEP, -notches));
  return true;
}

// ---------------------------------------------------------------------------
//  Controls
// ---------------------------------------------------------------------------

function controlsForKey(key) {
  return [...document.querySelectorAll(`[data-key="${key}"]`)];
}

function setValue(key, value, { silent = false } = {}) {
  if (key === 'preset' && !['horizontal', 'vertical'].includes(value)) return;

  // The ring decides where the composition sits on the canvas, so a change in
  // thickness is applied as a slide of the difference; remember the old size.
  const previousBorder = borderPx();

  state[key] = value;

  // Turning a switch on while its value is still zero seeds a modest one, so
  // the effect is visible straight away rather than after a slider drag.
  const seed = TOGGLE_SEEDS[key];
  if (seed && value === true && !(Number(state[seed[0]]) > 0)) {
    state[seed[0]] = seed[1];
    syncControls(seed[0]);
  }

  syncControls(key);
  updateDependentLabels();
  updateFieldAvailability();
  scheduleRender();
  saveSettingsSoon();

  // A preset is an action: it lays the pictures out once.  Nothing else moves
  // them, because a composition placed by hand must survive a slider.  Even
  // size re-derives every picture's size, and a border change slides the
  // composition by its own difference so the rings stay inside the canvas.
  if (!silent && key === 'preset') {
    arrange(state.preset);
  } else if (!silent && key === 'evenSize') {
    // The switch means "one shared edge", so it takes every picture back to
    // that: a wheel size is dropped rather than kept behind the switch.
    if (state.evenSize) {
      for (const item of state.items) item.scale = 1;
    }
    resizeItems();
  } else if (!silent && (key === 'border' || key === 'borderOn')) {
    slideForBorder(borderPx() - previousBorder);
  }
}

function syncControls(key) {
  for (const element of controlsForKey(key)) {
    if (element.tagName === 'SELECT') {
      element.value = String(state[key]);
    } else if (element.type === 'checkbox') {
      element.checked = !!state[key];
    } else if (element.type === 'range' || element.type === 'number') {
      if (document.activeElement === element) continue;
      element.value = String(state[key]);
    } else if (element.type === 'color') {
      element.value = String(state[key]);
    }
  }

  const group = document.querySelector(`.segmented[data-key="${key}"]`);
  if (group) {
    for (const button of group.querySelectorAll('button[data-value]')) {
      button.classList.toggle('on', button.dataset.value === String(state[key]));
    }
  }
}

function setFieldEnabled(ids, enabled) {
  const field = $(ids[0])?.closest('.field');
  if (field) field.classList.toggle('off', !enabled);
  for (const id of ids) {
    const element = $(id);
    if (element) element.disabled = !enabled;
  }
}

function updateFieldAvailability() {
  setFieldEnabled(['spacingRange', 'spacing'], state.spacingOn);
  setFieldEnabled(['borderRange', 'border'], state.borderOn);

  const borderColor = document.querySelector('input[data-key="borderColor"]');
  if (borderColor) {
    borderColor.disabled = !state.borderOn;
    const colours = borderColor.closest('.colors');
    if (colours) colours.classList.toggle('off', !state.borderOn);
  }
}

function updateDependentLabels() {
  els.qualityField.hidden = state.format === 'png';
  els.qualityValue.textContent = String(Math.round(state.quality * 100));
  els.format.value = state.format;
  els.quality.value = String(state.quality);
  els.evenHint.textContent = state.evenSize
    ? 'Scaled to the tallest or widest one.'
    : 'Every picture keeps its own pixel size.';
}

function bindControls() {
  for (const element of document.querySelectorAll('[data-key]')) {
    const key = element.dataset.key;
    if (element.type === 'checkbox') {
      element.addEventListener('change', () => setValue(key, element.checked));
      continue;
    }
    if (element.tagName === 'SELECT') {
      element.addEventListener('change', () => setValue(key, element.value));
      continue;
    }
    if (element.type === 'range') {
      element.addEventListener('input', () => setValue(key, Number(element.value)));
      continue;
    }
    if (element.type === 'number') {
      const commit = () => {
        const low = Number(element.min || 0);
        const high = Number(element.max || Number.MAX_SAFE_INTEGER);
        const parsed = Number(element.value);
        if (!Number.isFinite(parsed)) {
          element.value = String(state[key]);
          return;
        }
        const value = clamp(Math.round(parsed), low, high);
        element.value = String(value);
        setValue(key, value);
      };
      element.addEventListener('change', commit);
      element.addEventListener('blur', commit);
      continue;
    }
    if (element.type === 'color') {
      element.addEventListener('input', () => setValue(key, element.value));
      continue;
    }
  }

  for (const group of document.querySelectorAll('.segmented[data-key]')) {
    group.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-value]');
      if (!button) return;
      setValue(group.dataset.key, button.dataset.value);
    });
  }

  els.fileInput.addEventListener('change', () => {
    if (els.fileInput.files && els.fileInput.files.length) {
      addFiles(els.fileInput.files);
    }
    els.fileInput.value = '';
  });

  const choose = () => els.fileInput.click();
  els.addButton.addEventListener('click', choose);
  els.addTile.addEventListener('click', choose);
  els.emptyChoose.addEventListener('click', choose);

  els.clearButton.addEventListener('click', () => {
    if (state.sources.length) clearImages();
  });

  els.themeButton.addEventListener('click', () => {
    applyTheme(state.theme === 'dark' ? 'light' : 'dark');
    saveSettingsSoon();
  });

  els.format.addEventListener('change', () => {
    setValue('format', els.format.value);
    updateDependentLabels();
  });

  els.quality.addEventListener('input', () => {
    state.quality = Number(els.quality.value);
    els.qualityValue.textContent = String(Math.round(state.quality * 100));
    scheduleRender();
    saveSettingsSoon();
  });

  els.exportButton.addEventListener('click', exportImage);

  els.resetButton.addEventListener('click', () => {
    cancelCrop();
    for (const key of Object.keys(DEFAULTS)) {
      if (key === 'theme') continue;
      state[key] = DEFAULTS[key];
      syncControls(key);
    }
    state.zoom = 'fit';
    updateDependentLabels();
    updateFieldAvailability();
    scheduleRender();
    saveSettingsSoon();
  });

  // Selected picture
  els.rotateButton.addEventListener('click', () => {
    const item = selectedItem();
    if (!item) return;
    item.rot = (item.rot + 90) % 360;
    resizeItems();
    updateSelectionPanel();
    scheduleRender();
  });

  els.cropButton.addEventListener('click', () => startCrop());
  els.cropApply.addEventListener('click', applyCrop);
  els.cropCancel.addEventListener('click', cancelCrop);

  // The ratio shapes the frame as it is typed, and the × beside it empties the
  // field, which frees the frame again.  Enter in the field only leaves the
  // field: the frame is kept by the Apply button, or by Enter outside it.
  els.cropRatio.addEventListener('input', () => setCropRatio(els.cropRatio.value));
  els.cropRatioClear.addEventListener('click', () => {
    setCropRatio('');
    els.cropRatio.focus();
  });
  els.cropRatio.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    els.cropRatio.blur();
  });

  els.duplicateButton.addEventListener('click', () => {
    const item = selectedItem();
    if (item) duplicateItem(item.id);
  });

  els.removeButton.addEventListener('click', () => {
    const item = selectedItem();
    if (item) removeItem(item.id);
  });

  // Each alignment moves the whole composition within its own bounds: top,
  // middle and bottom for a row, left, centre and right for a column.
  for (const [id, axis, where] of ALIGNMENTS) {
    els[id].addEventListener('click', () => alignAll(axis, where));
  }

  els.undoButton.addEventListener('click', undo);
  els.redoButton.addEventListener('click', redo);

  // Zoom
  els.zoomIn.addEventListener('click', () => zoomBy(1.25));
  els.zoomOut.addEventListener('click', () => zoomBy(1 / 1.25));
  els.zoomValue.addEventListener('click', () => {
    state.zoom = 'fit';
    scheduleRender();
  });

  els.stage.addEventListener('wheel', (event) => {
    if (!state.items.length) return;

    // Ctrl (and a pinch, which Chromium also reports this way) zooms the view,
    // wherever the pointer is; the wheel alone resizes the picture under it.
    if (event.ctrlKey) {
      event.preventDefault();
      zoomBy(event.deltaY < 0 ? 1.12 : 1 / 1.12);
      return;
    }
    if (cropEdit) return;
    if (wheelResize(event)) event.preventDefault();
  }, { passive: false });

  // Keyboard
  window.addEventListener('keydown', (event) => {
    const ctrl = event.ctrlKey || event.metaKey;

    // A crop frame keeps or drops the crop, wherever the focus happens to be -
    // except in the ratio field, where Enter is just "done typing".
    if (cropEdit && !ctrl) {
      if (event.key === 'Enter' && event.target !== els.cropRatio) {
        event.preventDefault();
        applyCrop();
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        cancelCrop();
        return;
      }
    }

    if (ctrl && event.key.toLowerCase() === 'o') {
      event.preventDefault();
      els.fileInput.click();
      return;
    }
    if (ctrl && event.key.toLowerCase() === 'e') {
      event.preventDefault();
      if (!els.exportButton.disabled) exportImage();
      return;
    }
    if (ctrl && event.key === '0') {
      event.preventDefault();
      state.zoom = 'fit';
      scheduleRender();
      return;
    }
    const target = document.activeElement;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')) return;

    // With no crop frame up, Escape lets go of the selection: no picture is
    // selected, so the panel closes and the arrow keys stop moving anything.
    if (!ctrl && event.key === 'Escape') {
      if (state.selectedItemId !== null) {
        event.preventDefault();
        selectItem(null);
      }
      return;
    }

    // Undo and redo step through the composition, one action at a time.
    if (ctrl && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
      return;
    }
    if (ctrl && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      redo();
      return;
    }

    if (!cropEdit && !ctrl && event.key.toLowerCase() === 'c' && selectedItem()) {
      event.preventDefault();
      startCrop();
      return;
    }
    // The crop frame is modal: the keys below would move the picture under it.
    if (cropEdit) return;

    const item = selectedItem();

    if ((event.key === 'Delete' || event.key === 'Backspace') && item) {
      event.preventDefault();
      removeItem(item.id);
      return;
    }
    // Arrows nudge the selected picture a pixel at a time, and Shift makes that
    // ten.  They no longer step the selection, so a nudge never has to share a
    // key with it; Alt is not looked at, which also keeps it from reaching the
    // engine's back and forward.
    if (!ctrl && event.key.startsWith('Arrow') && item) {
      event.preventDefault();
      const step = event.shiftKey ? 10 : 1;
      if (event.key === 'ArrowLeft') item.x -= step;
      if (event.key === 'ArrowRight') item.x += step;
      if (event.key === 'ArrowUp') item.y -= step;
      if (event.key === 'ArrowDown') item.y += step;
      clampItem(item);
      scheduleRender();
    }
  });

  window.addEventListener('paste', (event) => {
    const items = [...(event.clipboardData?.items || [])];
    const files = items
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter(Boolean);
    if (files.length) {
      event.preventDefault();
      addFiles(files);
    }
  });

  window.addEventListener('resize', scheduleRender);

  // Dragging files in from Explorer -----------------------------------------
  // Two areas, two outcomes: the rail only fills the library, the stage also
  // places the picture on the canvas.
  let dragDepth = 0;

  const hasFiles = (event) => {
    const types = event.dataTransfer?.types;
    return types ? [...types].includes('Files') : false;
  };

  const zoneAt = (x, y) => {
    const rail = els.strip.closest('.rail');
    if (rail && pointInRect(x, y, rail.getBoundingClientRect())) return 'list';
    if (pointInRect(x, y, els.stage.getBoundingClientRect())) return 'canvas';
    return 'none';
  };

  const showZone = (zone) => {
    document.body.dataset.dropZone = zone;
    els.dropzone.hidden = zone === 'none';
    els.dropzone.dataset.zone = zone;
    els.dropVerb.textContent = zone === 'canvas' ? 'place on the canvas' : 'add to the list';
  };

  window.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return;
    dragDepth += 1;
    showZone(zoneAt(event.clientX, event.clientY));
  });

  window.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    showZone(zoneAt(event.clientX, event.clientY));
  });

  window.addEventListener('dragleave', (event) => {
    if (!hasFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) showZone('none');
  });

  window.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    const zone = zoneAt(event.clientX, event.clientY);
    const point = zone === 'canvas' ? layoutPoint(event.clientX, event.clientY) : null;
    showZone('none');
    addFiles(
      event.dataTransfer.files,
      zone === 'canvas' ? { place: 'canvas', point } : { place: 'list' },
    );
    els.stage.focus();
  });
}

function zoomBy(factor) {
  if (!state.items.length) return;
  const current = state.zoom === 'fit' ? lastCssScale : state.zoom;
  state.zoom = clamp(current * factor, 0.02, 8);
  scheduleRender();
}

// ---------------------------------------------------------------------------
//  Export
// ---------------------------------------------------------------------------

function exportFileName(extension) {
  const firstItem = state.items[0];
  const source = firstItem ? sourceById(firstItem.sourceId) : state.sources[0];
  const base = source ? baseNameOf(source.name) : 'pepperstitch';
  return `${base}-stitch.${extension}`;
}

async function exportImage() {
  const layout = computeLayout();
  if (!layout) return;

  const limit = canvasLimitMessage(layout);
  if (limit) {
    toast(limit, 'error');
    return;
  }

  const format = MIME[state.format] ? state.format : 'png';
  const extension = format === 'jpeg' ? 'jpg' : format;

  setBusy(true, 'Preparing the canvas…');
  els.exportButton.disabled = true;

  try {
    const canvas = document.createElement('canvas');
    canvas.width = layout.width;
    canvas.height = layout.height;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // JPEG has no alpha channel: the canvas is given the backdrop colour first,
    // and the gaps the preview leaves transparent are kept instead of cleared.
    const opaque = format === 'jpeg';
    if (opaque) {
      ctx.fillStyle = state.backdrop;
      ctx.fillRect(0, 0, layout.width, layout.height);
    }

    paintBackground(ctx, layout, 1, opaque);

    // The rings are flat colour and need nothing decoded, so they all go down
    // before the slow part; each picture then lands on top of its own border.
    for (const cell of layout.cells) paintRing(ctx, cell, layout.border);

    for (let index = 0; index < layout.cells.length; index += 1) {
      const cell = layout.cells[index];
      setBusyText(`Rendering image ${index + 1} of ${layout.cells.length}…`);

      // Full resolution, decoded one picture at a time so the peak memory
      // stays near a single picture rather than the whole stitch.
      if (!cell.source) continue;
      const bitmap = await decodeFull(cell.source.blob);
      try {
        paintPicture(ctx, cell, bitmap);
      } finally {
        bitmap.close();
      }
      await nextFrame();
    }

    setBusyText('Encoding…');
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob(
        (result) => (result ? resolve(result) : reject(new Error('the image could not be encoded'))),
        MIME[format],
        format === 'png' ? undefined : state.quality,
      );
    });

    const name = exportFileName(extension);

    if (!host.available) {
      downloadBlob(blob, name);
      toast(`Exported ${name} (${formatBytes(blob.size)}) to your downloads.`);
      return;
    }

    setBusyText('Saving…');
    const response = await fetch(
      `https://save.local/save?ext=${encodeURIComponent(extension)}&name=${encodeURIComponent(name)}`,
      { method: 'POST', body: blob },
    );
    const result = await response.json();

    if (result.cancelled) return;
    if (!result.ok) throw new Error(result.error || 'the file could not be saved');

    const savedName = String(result.path).split(/[\\/]/).pop();
    toast(
      `Saved ${savedName} · ${layout.width} × ${layout.height} · ${formatBytes(blob.size)}`,
      'info',
      {
        label: 'Show in folder',
        run: () => host.command('/reveal?path=' + encodeURIComponent(result.path)),
      },
    );
  } catch (error) {
    toast(String(error && error.message ? error.message : error), 'error');
  } finally {
    setBusy(false);
    updateExportState(layout);
  }
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
//  Start-up
// ---------------------------------------------------------------------------

// The name carries the version, in the title bar, the header and the status
// bar alike, so two builds can be told apart at a glance.
function setVersion() {
  const version = new URLSearchParams(location.search).get('v');
  const name = version ? `PepperStitch_v${version}` : 'PepperStitch';
  els.statusVersion.textContent = name;
  if (els.brandName) els.brandName.textContent = name;
  document.title = name;
}

function init() {
  loadSettings();
  setVersion();
  applyTheme(state.theme);
  bindControls();
  bindCanvas();
  for (const key of Object.keys(DEFAULTS)) syncControls(key);
  updateDependentLabels();
  updateFieldAvailability();
  historyNow = snapshotState();
  updateHistoryButtons();
  renderStrip();
  updateSelectionPanel();
  render();
  updateExportState(null);

  host.listen((message) => {
    if (message.type === 'files' && Array.isArray(message.items)) {
      // Pictures opened with the app or given on the command line belong on the
      // canvas straight away; the list keeps a copy of each.
      addFromHost(message.items, { place: 'canvas' });
    }
  });

  // Tells the host the DOM is listening, and releases any pictures it was
  // started with on the command line.
  host.command('/ready');

  // Keep the stage centred without a resize event when the panel changes size.
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => scheduleRender()).observe(els.stage);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// For the DevTools console and the automated interface checks: the state and
// the few functions worth poking at by hand.  Nothing in the interface uses
// this object.
window.PepperStitch = {
  state,
  computeLayout,
  arrange,
  resizeItems,
  render,
  scheduleRender,
  addEntries,
  addFiles,
  placeSources,
  removeItem,
  removeSource,
  selectItem,
  exportImage,
  scaleItemAboutCentre,
  startCrop,
  applyCrop,
  cancelCrop,
  pictureRect,
  canvasToSource,
  cropRect: () => (cropEdit ? { ...cropEdit, rect: { ...cropEdit.rect } } : null),
  undo,
  redo,
  commitHistory,
  undoSteps,
};
