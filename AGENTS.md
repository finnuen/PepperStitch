# AGENTS.md — notes for working on PepperStitch

PepperStitch is a Windows image stitcher: drop photos, get one wide or tall
image out. It is a **single executable**: a Win32 host with Microsoft Edge
WebView2, and the whole interface compiled into the exe as resources. There is
no Node, no npm and no dev server in the shipped product.

The user-facing description is `README.md`; this file is about changing the
code.

## Build

```bat
build.bat
build.bat --same
build.bat --version 1.2.3
build.bat --debug
build.bat --clean
build.bat --webview2 "<...>\Microsoft.Web.WebView2.1.0.4258.31\build\native"
```

`build.bat` prefers MSVC when it finds it and falls back to MinGW-w64
(`g++`, `mingw32-make`, `windres` on `PATH`). It writes
`dist\PepperStitch_v<version>.exe`. The build directory is `build\`.

Without `--webview2`, CMake downloads the WebView2 SDK from NuGet at configure
time. An already unpacked SDK avoids the download; on this machine there is one
at `..\JustViewMD\build\_deps\webview2\extracted\build\native`.

The version lives in one place: `project(PepperStitch VERSION x.y.z ...)` in
`CMakeLists.txt`. CMake generates `version_generated.h` and the app.rc version
block from it, and names the executable after it.

`build.bat` bumps PATCH by itself when a file under `src/` or `assets/` is newer
than the last successful build, through `tools/bump-version.ps1`, which stamps
`build\.ps-version-stamp` once the exe has been copied. A change therefore
cannot ship under a number that is already published. `--same` rebuilds without
bumping, `--version` sets the number outright, and a debug build never bumps.
The stamp sits inside `build\`, so `--clean` makes the next build bump.

## Layout

```
src/main.cpp          Win32 window, WebView2, resource unpacking, virtual hosts
src/app.rc            icon, version info, WEBVIEW2LOADER resource
src/resource.h        resource ids
assets/index.html     markup and the CSP meta tag
assets/style.css      dark and light themes, rail/stage/panel layout
assets/app.js         all layout, painting, export, drag and settings logic
tools/make-icon.ps1   regenerates src/app.ico and docs/icon.png
tools/dev-server.ps1  static server for testing assets/ in a browser
```

CMake globs `assets/**` and turns every file into an RCDATA resource with an id
from 1000 up, writing `assets_manifest.h` so the unpacker and the .rc cannot
disagree. `CONFIGURE_DEPENDS` means adding a file to `assets/` is enough; the
next `build.bat` picks it up.

At start-up the host unpacks those resources into
`%LOCALAPPDATA%\PepperStitch\assets` **on every launch**, overwriting whatever
is there. Editing the unpacked copies by hand is pointless; edit `assets/` and
rebuild. `%LOCALAPPDATA%\PepperStitch\window.ini` remembers window placement and
`WebView2\` is the WebView2 profile (localStorage lives there).

## How the two halves talk

The page is served from `https://app.local`, mapped to the unpacked folder with
`SetVirtualHostNameToFolderMapping`. Three more hosts never touch the network;
`HandleResourceRequest` answers them from `main.cpp`:

| URL | Handler | Notes |
| --- | --- | --- |
| `https://file.local/<n>` | `ServeFile` | index into `g_app.fileTokens` |
| `https://save.local/save?ext=&name=` | `HandleSave` | reads the POST body, defers the request, and a worker thread runs `GetSaveFileNameW` and writes the file |
| `https://host.local/ready` | `HandleCommand` | the page is listening; releases `pendingFiles` |
| `https://host.local/reveal?path=` | | Explorer, with the file selected |
| `https://host.local/theme?dark=1` | | DWM dark title bar + WebView background |
| `https://host.local/devtools` | | opens DevTools |

The host pushes pictures to the page with `PostWebMessageAsJson`
(`{"type":"files","items":[…]}`), which the page receives through
`chrome.webview.addEventListener('message')`.

**Every response carries CORS headers.** The page's origin is `app.local`;
fetches to the other three hosts are cross-origin, and without
`Access-Control-Allow-Origin` the page cannot read the response — pictures fail
to load and the fetch for saving fails, both silently. `HandleResourceRequest`
also answers `OPTIONS` with 204 *before* dispatching, because otherwise the
preflight for the export POST would reach `HandleSave` and open a file dialog.

CSP is set in `index.html`; `connect-src` lists the three hosts. Adding a new
host means changing both the CSP and the `AddWebResourceRequestedFilter` list in
`InitializePage`.

**The Save dialog runs on its own thread.** Opening `GetSaveFileNameW` straight
from the resource callback hangs before it draws anything: the callback is on the
window thread, the page is waiting for the response, and the shell dialog never
gets to its message loop. So `HandleSave` takes a deferral (`GetDeferral`), hands
a `SaveJob` to `CreateThread`, and the worker posts `kSaveFinishedMessage` back
to the window, which answers the request and calls `Complete()`. Do not "simplify"
this back into a synchronous dialog call.

## The layout model

Everything is in output pixels, and the canvas is derived from what is placed on
it. Two collections hold the state:

- `state.sources` is the library: a decoded preview bitmap, the original blob,
  a name and a `blob:` URL. Its order is the library's order — the numbers on
  the thumbnails, and nothing on the canvas — which a drag up or down in the
  rail changes. A source leaves the library through its × button
  (`removeSource`) or **Clear**, and is set aside rather than released, because
  a step in the history may still hold it (see below).
- `state.items` is the canvas, in drawing order. An item is
  `{ id, sourceId, x, y, w, h, rot, flipH, flipV, scale, crop }`,
  and `x, y` is the picture's own top-left — the border ring is drawn outward at
  `x - border`, so the ring never changes the picture's own size or position.
  `scale` is the wheel's size as a factor of the source; `crop` is `null` or a
  rectangle of the source in fractions (`{x, y, w, h}`), which is what
  `sourceRectOf()` turns into pixels and what `naturalSizeOf()` measures. There
  is no frame and no fill: a cell always has the picture's own shape, so the
  picture fills it exactly.

`computeLayout()` turns the items into cells: `x = item.x - border + outer`,
`w = item.w + border * 2`, and the canvas is the bounding box of the cells plus
`outer` on the right and bottom. Cells overlap when pictures stand closer than
`border`, and that is the normal case: two neighbours are `border + spacing`
apart, not `2 * border + spacing`, so their rings land on the same band. One
border between them instead of a double one, and no ring reaching over either
picture. Nothing repacks on its own: `arrange(preset)` is the only thing that
moves items, and a preset is an action. Horizontal and Vertical stack the
pictures from the border with that distance between them, in the library's order
rather than the order they were placed in: `itemsInLibraryOrder()` sorts a copy
of the items by each source's index, so reordering the image list and pressing a
preset re-packs the row to match. Copies of one picture keep the order they were
placed in (the sort is stable), and `state.items` itself is left alone, so what
overlaps what does not change with the list. Spacing and the border
never re-arrange a composition someone placed by hand — a new gap applies to the
next placement and to snapping, and a thicker border grows the canvas around the
pictures. The one exception is a slide of the whole composition by the border's
own difference, from `slideForBorder()`: the ring's outer edge stays where it
was while the pictures move in or out with their thickness, so relative
placement survives and no border is cut off by the canvas edge. `resizeItems()`
re-derives `w` and `h`:

- **Even size on** shares one edge across the canvas: the height for a row, the
  width for a column, taken from the tallest/widest natural size. A newly placed
  picture joins at the current shared edge; arranging re-reads it for everything,
  so a later, taller picture only evens the canvas when you press a preset
  (adding one never resizes what is already placed). Turning the switch on resets
  every `scale` to 1, because the shared edge is the whole of that mode.
- **Even size off** keeps each picture's natural size after rotation, times its
  own `scale`.
- `border` and `spacing` are read through their switches: `borderOn` and
  `spacingOn` make them zero without losing the value the sliders hold.

The wheel resizes one picture about its centre (`scaleItemAboutCentre`), which
Even size cannot express, so `releaseEvenSize()` switches it off first: it
freezes the sizes already on the canvas as a `scale` per picture, so nothing
jumps when the switch flips. Only a preset ever re-reads the shared edge.
Wheel resizing freezes `state.zoom` the way a drag does (`holdZoomForWheel`),
because a re-fit after every notch would shrink the whole canvas under the
pointer; the view returns to `'fit'` 600 ms after the last notch. Ctrl+wheel is
still a zoom, wherever the pointer is, and a wheel over empty stage scrolls as
it always did.

The selected picture answers to eight handles, and pulling one sizes it
(`startResize`, `resizePointerMove`). They are not drawn — the picture is lit
instead — so the hit areas are the picture's own edges and corners, and the
cursor is what says which one the pointer is on. Every gesture keeps the
picture's own
ratio: a corner follows the pointer along the diagonal — the two answers are
averaged, so neither axis wins the tug of war the ratio sets up — and an edge
drag takes the other side with it, centred on the edge that is not moving. The
corner or edge opposite the one held stays where it was. `releaseEvenSize()`
steps aside the way the wheel does, and the view is frozen for the gesture the
same way a move freezes it. The moving edge snaps through `snapEdge()`, unless
<kbd>Shift</kbd> is held. `snapEdge()` is `snapItem()`'s candidate set applied
one edge at a time: a neighbour's two
edges, the two positions that leave `border + spacing`, and the canvas edge at
`border`. Because the anchor does not move, a snap changes the size rather than
the placement. `handleAt()` is shared with the crop frame; only the selected
picture answers to it, so a drag anywhere else still moves.

The six align buttons under the preset (`alignAll`) are an action on the
composition, like a preset: top, middle and bottom move every picture to the
outermost edge of the whole canvas or to the middle of that span, and left,
centre and right do the same down the other axis. Unlike a preset they leave
every size alone and never touch the other axis, so only the one direction is
tidied. The preset decides which three are live — a row is lined up along its
tops, a column along its lefts — so the three for the row sit first, above the
Horizontal button they belong to, and the three for the column after the
divider; `alignAxis()` is the single place that decides, and `alignAll()` refuses
the other axis rather than doing something surprising. All six are also disabled
while fewer than two pictures are placed, since one picture has nothing to line
up against and the answer would be itself.

Dragging is pointer-based, not HTML5 drag. The pointer delta is divided by the
scale the canvas had when the gesture started, so a re-fitted sheet cannot move
the picture under the cursor; `state.zoom` is frozen from `'fit'` to a number
during the drag and restored after. `snapItem()` works in picture coordinates
rather than cell coordinates, because the rings of two neighbours share their
pixels: it looks at the other pictures' two edges, the position that leaves
`border + spacing` between the pictures, the aligned opposite edge and the centre
line, plus the canvas edge at `border`, with a threshold of 9 screen pixels
divided by the preview scale. <kbd>Shift</kbd> during the drag skips
`snapItem()` entirely, and the same flag skips `snapEdge()` in
`resizePointerMove()`, so a picture can be put exactly where the pointer says.

The arrow keys nudge the selected picture — 1 px, or 10 px with <kbd>Shift</kbd>
— through `clampItem()` and `scheduleRender()`, so a run of nudges lands in the
history as one step. They no longer step the selection: arrows are the move key
and nothing else.

`paintBackground` paints no background at all: only an outer frame is drawn,
as a band, and the inside is cleared again so the gaps between pictures stay
transparent and the preview shows the stage through them. A JPEG export fills
the whole canvas with `backdrop` first and skips the clear, since JPEG has no
alpha.

`paintRing` and `paintPicture` are separate calls: every ring on the canvas is
painted before any picture, so a border that a neighbour stands too close for
ends up underneath that neighbour rather than cropping it. `paintPicture` clips
to the content rect and draws the picture over it, applying rotation and the
flips inside the same `save`/`restore`. The rect is the picture's own: there is
no letterbox to fill and no overflow to crop away. `drawFitted()` takes the
source rectangle from `cell.crop` as fractions, so the same call crops the
1800 px preview bitmap and the full-resolution one alike.
The ring's outer radius is the corner radius plus its own thickness, except at
radius 0 where it stays square: a picture with no rounding does not get rounded
border corners. Nothing is drawn over the selected picture: `paintPicture` takes
a veil, and `veilFor()` gives the selected picture `SELECTED_VEIL` and the one
under the pointer `HOVER_VEIL`, painted inside the picture's own clip. The veil
is a preview argument only — export passes none — and `veilFor()` returns zero
while a crop frame is up.

## Cropping

Crop is a short-lived mode, not a stored flag: `cropEdit` holds
`{ itemId, rect, ratio }`, where `rect` is fractions of the part of the picture
that is on show and `ratio` is `null` or a width-over-height number. Fractions
rather than pixels, so moving the picture, zooming, resizing the window or
changing a layout control while the frame is up cannot lose it — `paintCrop`
walks from the fractions to the current `pictureRect()` on every render.
`pictureRect(cell)` is simply the cell content (`cell.cx/cy/cw/ch`), because the
picture fills its cell; `canvasToSource()` inverts the whole transform
(rotation, flips, an existing crop) and answers in source fractions.

Ratios come from the field on the crop bar: `parseCropRatio()` reads `16:9`,
`4:5`, `3x2`, `16/9`, `16*9`, `16-9`, `16+9`, `16'9`, or a single `1.5`, and
treats an empty field, `free`, or a zero side as free-form. A dot is the one
ambiguous separator, because it is also the decimal point, and the decimals that
matter are written with it (1.85 and 2.39:1 are far more common than 1:85 or
2:39): a dot between two whole numbers is a separator (`16.9` is 16 by 9, `4.5`
is 4 by 5), while a longer decimal stays a number (`1.5`, `1.85`, `2.39`).
Typing one calls `shapeCropToRatio()`, which reshapes the frame at
once — widest frame of that shape, centred where the current one sits. Moving
frames the pointer is `cropFrameFrom()` for a new drag or a corner (the opposite
corner stays still) and `cropFrameFromSide()` for an edge (the opposite edge
stays; the other dimension follows the ratio, centred). Holding <kbd>Shift</kbd>
during a drag is 1:1 for that gesture and outranks the field. The × beside the
field empties it, which frees the frame; `startCrop()` starts every crop free
rather than inheriting a shape.

A first drag inside a frame that still covers the whole picture draws a new
rectangle (`cropCoversWholePicture()`); once the frame is smaller, a drag inside
moves it, and the eight handles resize it. Applying (`applyCrop`) writes
`item.crop` — the picture now has the crop's own shape — and gives the item the
frame's size and position so nothing on the canvas moves. `scale` is recomputed
from the new natural size, so a later rotation or arrangement keeps the displayed
size. Enter keeps the crop, Escape drops it, and the floating `.crop-bar` carries
the same two answers where the frame is; Enter inside the ratio field only leaves
the field.

The preview canvas is capped at 1800 px decode and paints at
`min(cssScale * devicePixelRatio, 1)` backing pixels. Export uses the same
painting functions on an offscreen canvas at 1:1, decoding full-resolution
bitmaps one at a time and closing each before the next.

## Undo and redo

A step is a snapshot, not a command: `snapshotState()` copies the items, the
library and the settings in `DOCUMENT_KEYS`, and undoing restores the snapshot
wholesale. Because the state is read rather than recorded, a new action becomes
undoable without registering itself anywhere — there is no list of operations to
keep in step with the code — and the comparison in `sameSnapshot()` (JSON for
the items and the settings, identity for the pictures in the library) is what
decides whether anything happened at all.

`commitHistory()` is called from `scheduleRender()`, which every change already
goes through, but on a `HISTORY_DELAY` timer so that a burst becomes one step:
a slider pull, a wheel run, a picture being dragged across the canvas. A gesture
in progress is skipped entirely (`canvasDrag`, `resizeDrag`, `cropDrag`) and the
pointer-up or the end of the wheel hold records the gesture as a whole; undo
commits anything still waiting before stepping back, so a change made a moment
ago is never skipped. `HISTORY_LIMIT` steps are kept and older ones drop off the
back.

The export format, the quality, the theme and the view are deliberately not in
`DOCUMENT_KEYS`: undoing should move pictures, not change how they will be
saved. The selection is not part of the comparison either, but a restored step
whose selected picture has gone falls back to the last picture on the canvas.

A picture leaving the library is the one thing that cannot simply be copied — it
owns a decoded bitmap and a blob URL, and closing them would make the step that
undoes the removal worthless. `removeSource()` and `clearImages()` therefore put
the object into `retiredSources` instead of releasing it, and
`releaseForgottenSources()` closes the bitmap and revokes the URL only when the
picture is in neither the library nor any remaining step. `sourceById()` needs no
knowledge of that map: a step always carries the pictures its items are drawn
from.

## The interactions

| Where | Gesture | Result |
| --- | --- | --- |
| library | click | place the source beside the last item |
| library | drag up or down | reorder the list; the canvas is untouched |
| library | drag out to the stage | carry a ghost; drop on the stage to place at the pointer |
| library | × | remove the source and every item drawn from it |
| library | right-click | nothing |
| canvas | click / drag | select and move; snaps to neighbours |
| canvas | drag with <kbd>Shift</kbd> | move without snapping |
| canvas | drag a handle | size the selected picture at its own ratio; snaps to the others |
| canvas | drag a handle with <kbd>Shift</kbd> | size without snapping |
| canvas | wheel | resize the picture under the pointer, about its centre |
| canvas | right-click | Rotate 90°, Flip horizontal, Flip vertical, Remove |
| preset | align buttons | line the pictures up, one axis at a time: the row's tops for Horizontal, the column's lefts for Vertical |
| header | Undo / Redo | step back or forward through the composition |
| keyboard | arrow | nudge the selected picture 1 px; <kbd>Shift</kbd> makes it 10 px |
| keyboard | <kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> | the same, or <kbd>Ctrl</kbd>+<kbd>Y</kbd> for redo |
| crop frame | drag inside | draw a new frame, or move it once it is smaller |
| crop frame | drag a handle | resize that edge or corner, holding the ratio |
| crop frame | <kbd>Shift</kbd> + drag | the same, locked to 1:1 |
| crop bar | ratio field | type `16:9` to reshape the frame; × frees it |
| page | drop files | rail → library only, stage → library and canvas |

The library uses a pointer carry (`startCarry`, `onCarryMove`, `onCarryUp`) with
a `.drag-ghost`; movement under 5 px counts as a click. Where the pointer goes
decides what the drag is: up and down inside the rail reorders the list, out to
the stage carries the picture there. A reorder lifts the thumbnail
(`.reordering`) and shuffles the others around it as the pointer passes their
middles (`moveInStrip`), and the order is read back off the list on release
(`finishReorder`), so the DOM is the draft and `state.sources` is written once.
Leaving the rail mid-reorder therefore just redraws the list as it was and
becomes a carry — the sideways drag is what a carry looks like from the start,
and it is the one gesture that must not be mistaken for a reorder. The canvas
uses `pointerdown` on the canvas plus `pointermove`/`pointerup` on the window.
Both live in `app.js`; neither uses the HTML5 drag-and-drop API. While a crop
frame is up the canvas pointerdown goes to `cropPointerDown` instead, the context
menu is swallowed, and the canvas keys stand down — the frame is modal until
Enter or Escape.

## The name and the icon

`AppDisplayName()` in `main.cpp` is the versioned name (`PepperStitch_v<version>`):
it titles the window, and the page sets its own title from the `?v=` the host
appends, so the two agree and the title handler does not print the name twice.
The header brand and the status bar read the same string from `setVersion()`.
The executable carries it too — `OUTPUT_NAME` in `CMakeLists.txt` is
`PepperStitch_v${PROJECT_VERSION}`, which is why `build.bat` takes the version
from `CMakeLists.txt` (bumping it first) rather than repeating it, and why the
version block in `app.rc` uses the generated `PS_FILE_NAME`. The exported
picture keeps the plain name; only the program and the interface carry the
version.

That version block also states the licence: `LegalCopyright` reads "Copyright
2026 the PepperStitch authors. Apache-2.0", which is what Explorer's Details tab
shows. It has to agree with `LICENSE` at the root — the project is Apache 2.0,
and a stale string there is the one place the licence could be misreported.

The icon is white photos on a red tile, the same red as PepperSnap's
(`#EE4343 → #E63B3B`), and the header `.mark-*` rules in `style.css` mirror it.
`tools/make-icon.ps1` writes both `src/app.ico` and `docs/icon.png`; run it and
rebuild after touching it.

## Testing

**In a browser.** The page works outside WebView2 (export falls back to a
download). Start the static server and open `http://127.0.0.1:8123/`:

```powershell
powershell -ExecutionPolicy Bypass -File tools\dev-server.ps1 -Root .\assets -Port 8123
```

`window.PepperStitch` exposes `state`, `computeLayout`, `arrange`,
`resizeItems`, `render`, `scheduleRender`, `addEntries`, `addFiles`,
`placeSources`, `removeItem`, `removeSource`, `selectItem`, `exportImage`,
`scaleItemAboutCentre`, `startCrop`, `applyCrop`, `cancelCrop`, `pictureRect`,
`canvasToSource`, `undo`, `redo`, `commitHistory`, `undoSteps` and `cropRect()`
for poking at the app from the console. `cropRect()` also reports `ratio`, which
is what the ratio field parsed.
Synthetic pictures can be made with a canvas and `toBlob`, then
passed to `addEntries`. Remember that `addEntries`'s second argument says where
the pictures go: `{ place: 'canvas' }` also places them, `{ place: 'list' }` only
fills the library.

A crop is easiest to drive with synthetic pointer events: compute the item's
`pictureRect()`, turn two fractions of it into client coordinates through
the canvas rect and its scale, then dispatch `pointerdown` on the canvas and
`pointermove`/`pointerup` on the window. Keep the points away from the corners
unless you mean to grab a handle — the handle tolerance is 10 screen pixels, and
at Fit that is a fair part of a small picture. Pass `shiftKey: true` on the move
to exercise the 1:1 lock, or set `#cropRatio` and fire an `input` event for a
typed ratio.

Two traps that cost time before:

- **A hidden tab never fires `requestAnimationFrame`.** `scheduleRender` queues
  a render through rAF, so in an automated background tab the state changes and
  the DOM labels update (they are synchronous) while the canvas, status size and
  filmstrip do not. That looks like a bug and is not one; call
  `window.PepperStitch.render()` directly. Export used to await a bare rAF for
  the same reason; `nextFrame()` now also resolves from a 50 ms timer so an
  export cannot hang while the window is minimised.
- **CSP blocks cross-origin fetches**, so a browser test cannot load sample
  files over `file://`; generate images in the page instead.

**In the real app.** Launch it with pictures on the command line and capture the
window with `PrintWindow(hwnd, hdc, 2)` into a bitmap — that does capture
WebView2 content, unlike a plain `BitBlt` of the screen area. Mouse clicks on
window coordinates are unreliable and `SendKeys` is worse (keys can land in the
page, where <kbd>Backspace</kbd> deletes the selected picture); drive the
interface with UI Automation instead. The WebView2 page exposes its DOM to it, so
`InvokePattern` on a button, `TogglePattern` on a switch, `RangeValuePattern` on a
slider and `ValuePattern` on a number field all work, and the preset, spacing and
outer-frame settings can be applied without a mouse. A *drag*, on the other hand,
does work through `SetCursorPos` plus `mouse_event`: that is the only way to
exercise the crop frame, and it needs a few milliseconds between the down, the
moves and the up. Expect the first click after `SetForegroundWindow` to be
swallowed while the window takes focus; send one and ignore it. The save dialog
it opens is a task dialog: its Yes/No buttons are not exposed as automation
elements, so a script cannot finish an overwrite confirmation (cancel and save
under a new name instead).

## Conventions

- C++17, no external libraries, no WRL. `ComPtr` and `ComHandler` at the top of
  `main.cpp` are hand-written; keep the source buildable with MinGW as well as
  MSVC.
- The host does no image work and the page has no filesystem access. Keep that
  split: pictures travel as bytes, saving goes through `save.local`.
- Comments explain *why* something is done, in the same voice as the existing
  files. British spelling appears throughout ("colour", "minimised").
- Keep the interface responsive: work per picture, yield between pictures, and
  never hold two full-resolution bitmaps at once.
- A layout that the browser cannot draw must be refused in the interface
  (`canvasLimitMessage`) rather than failing during export.

## Before committing

- `build.bat --clean` once in a while to prove a clean tree still builds.
- Check the app still starts with no arguments (empty state), with pictures on
  the command line, and after deleting `%LOCALAPPDATA%\PepperStitch`.
- `docs/screenshot.png` is referenced by the README; keep it current if the
  interface changes visibly.
