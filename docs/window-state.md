# Window placement memory (窗口位置与尺寸记忆)

## Goal

Reopen the DSH Desktop main window at the size and position it was closed at.

## Where this code lives

This feature is its own DSH **component**, in its own package:

    D:\Develop\dsh-notpdpton          the pack  (不二布丁光子)
    D:\Develop\dsh-notpdpton\window   the feature (dsh-notpdpton-window)

The pack's `cordis.patch.yml` inserts **two** rows — one for interrupted-session
recovery, one for this feature — so the Plugins page shows one card listing two
components, each with its own on/off switch. That is the same shape the official
bundles use (`@deepseek-ai/dsh-experimental-voice-input-bundle` inserts four rows,
each naming a separate feature package).

Only the pack is a **bundle** (`dsh.bundle.patch` + a `cordis.patch.yml`), and only
the pack appears in the profile's bundle list. The feature package carries no patch
of its own and no `dsh.bundle` — exactly like the official feature packages. It is
just a dependency whose package root a row names; giving it a patch would risk a
duplicate row id the moment it was also selected as a bundle.

Why a separate package rather than a second row pointing at a subpath of the pack:
a row's browser half is found by taking the row's **package root**, reading that
manifest's `dsh.client` declaration, and loading the file it exports as
`"./client"`. The scan requires an *exact* package specifier
(`dsh-client-modules` `exactPackageSpecifier`), so a row named
`dsh-notpdpton/window` never reaches it at all — it would mount silently with no
component UI. And one package can contribute at most one browser module, because
the module table is keyed by package name and a second active source is a hard
composition error. Two independent components therefore need two packages, each a
full dual-face package exporting `"./client"`, `"./icon"` and `"./locale/*.json"`.

## Why this is a renderer feature

The Desktop shell creates its BrowserWindow in the Electron main process with
hardcoded bounds (1280x820, no x/y) and exposes no geometry IPC. The Host half of a
plugin runs in a plain Node child process, so it cannot reach the window either. The
workspace document, however, is the **top-level document of that window**, and a
top-level document may call `window.moveTo()` / `window.resizeTo()`: Electron
forwards them to the BrowserWindow.

Verified against the app's own Electron binary with the shell's exact window options
(`titleBarStyle: 'hidden'`, `titleBarOverlay`, `sandbox: true`,
`contextIsolation: true`, privileged `dsh-app://` scheme):

* the calls work while the window is still hidden (`show: false`);
* the geometry survives `show()`, a reload, and an app relaunch;
* `localStorage` on the app origin survives relaunch;
* `sessionStorage` survives a reload but is cleared by a relaunch — the natural
  "once per launch" boundary.

### The window does move *after* `show()`, not before

Measured against the shell's real ordering (create hidden → `loadURL` → `show()`),
in three consecutive runs: `did-finish-load` → `show()` → first `moveTo`/`resizeTo`
landed **+0 to +2 ms after** `show()`. The restore is correct and lands within a few
tens of milliseconds, but it is *not* applied before the window becomes visible, so a
brief re-placement can be seen on a large jump. It cannot be removed from a client
half at all: the plugin only runs once the page has loaded, which is already after the
shell has made the window visible. (A cached frame offset was tried for this and
removed — see "The one-ask fast path was tried and removed".)

Do not claim "no visible jump": that is true only if `show()` is deferred until the
hidden window has settled, which the shell does not do.

## The coordinate trap

The renderer's `screenX/screenY/outerWidth/outerHeight` are **not** the values to pass
to `moveTo/resizeTo`. With a hidden title bar plus overlay the reported rect is inset
from the requested one by the window frame. The relation is a translation (slope 1):

| asked | renderer reports | true window rect |
| --- | --- | --- |
| moveTo x=377 | screenX=363 | x=370 |
| resizeTo w=1183 | outerWidth=1198 | width=1184 |

So placement is a correction loop on the **asked** value:

    ask_0     = measured_0                  (the window's current placement)
    ask_{n+1} = ask_n + (target - measured_n)

`ask_0` is the *measured* rect, not the target: the first measurement describes where
the window already is, and the correction is only exact when the ask it is applied to is
the ask that produced that measurement. Two passes reach a 0 px residual; the loop is
bounded by `WINDOW_MAX_PASSES = 3`, so a window that never follows the request stops
there instead of shaking (see "Why an OS-clamped request is not a failure").

### Measuring a window is the hard part

The arithmetic converges in one pass; trusting a *measurement* is what took three
independent Electron harnesses to get right. Three hazards, all observed:

1. **A read can echo the ask.** Reading `screenX/outerWidth` in the same task as
   `moveTo`/`resizeTo` returns the value just *asked for*. A probe that placed, then
   read immediately, reported the exact target `{377,211,1183,767}` while a later read
   showed the truth `{363,211,1198,775}`. A loop that believes the echo sees zero
   residual and does nothing.
2. **Windows animates a window move**, so reads tens of milliseconds apart disagree.
   Reading a moving window made an identical seed and identical code produce three
   different final rects in three runs.
3. **`ask` must be the value that produced `measured`.** With no stored frame the first
   read describes the window's *previous* placement, not the target.

The loop therefore measures only settled geometry: read, settle, read again, and
accept a value only when two reads agree (`WINDOW_STABLE_READS = 5`). An echo cannot
survive that, and neither can a sample taken mid-animation. Each settle waits one
animation frame plus a macrotask (`WINDOW_SETTLE_MS = 60`); `requestAnimationFrame` is
only an accelerator because a hidden window may not fire it.

### The one-ask fast path was tried and removed

Caching the measured frame offset in the store so the next launch could place the
window in a single ask *sounded* right, and it is the reason `frame` still appears in
the stored document. It was removed after measurement: the restore lands **after** the
shell's `show()` whether or not the offset is applied (the client half only runs once
the page has loaded), so it bought no visible improvement — while subtracting the
offset made the correction loop oscillate against Windows' clamping and produced a
−14 px / +14 px / +8 px drift on every launch. The plain loop starting from the measured
rect is the version verified drift-free over six consecutive launches. `frame` is kept
in the document as diagnostic evidence only, and `placeWindow` ignores any frame passed
to it.

### Why an OS-clamped request is not a failure

Windows clamps a window to the work area, so a maximized *fill* cannot always be
reached in renderer space. When two consecutive reads return the same rect, the
window has stopped following the request, and the loop stops (reporting
`clamped: true`) instead of repeating identical `moveTo`/`resizeTo` calls.

## Stored document

`localStorage["dsh-notpdpton:window-state"]`:

    { "v": 1,
      "rect": { "left": 100, "top": 80, "width": 1200, "height": 800 },
      "dpr": 1.5,
      "maximized": false,
      "frame": { "left": -14, "top": 0, "width": 15, "height": 8 },
      "updatedAt": 1792263889830 }

* `rect` is always the **normal** placement, never a maximized fill.
* `maximized` records that the window was maximized when last seen.
* `frame` is **diagnostic only** and ignored on restore: the offset
  `measured - asked` that the last placement revealed. It once drove a one-ask fast
  path; that path was removed (see above) because it bought nothing visible and caused
  cross-launch drift. The field is kept so a store can be inspected after the fact.
  It is only ever written by the placement loop; a capture sample can be taken
  mid-drag, and deriving a frame from one produced garbage (measured
  `{2,20,-11,-14}`), so capture deliberately does not write it.
* A wrong `v`, invalid JSON, or an unusable rect is discarded rather than repaired:
  a wrong guess moves the user's window, which is worse than the default geometry.
* `sessionStorage["dsh-notpdpton:window-restored"] = "1"` marks the launch handled.

## Restore rules

* once per app launch (the sessionStorage guard);
* off when the `记住窗口位置和尺寸` switch is off;
* the rect is clamped to DSH's native minimums (520x600) and to the work area of the
  display it belongs to (`pickHomeArea`: the display it overlaps most);
* a rect that touches **no** current display is rejected, not restored — an undocked
  laptop must not open the window off-screen (`isOnScreen` asks only for positive
  overlap, because the asymmetry matters: rescuing a real window is cheap, losing it is
  not);
* a rect that overlaps a display but is not *contained* in it is pulled fully on
  screen (`isFullyOnScreen` + `bringOnScreen`), keeping its size;
* a window saved while maximized restores its **pre-maximize** rect, never the fill
  (see "Maximize is never restored"); a stored rect that is itself a work-area fill is
  rejected as a legacy artifact.

## Maximize is never restored

A window closed while maximized reopens at the size it had **before** it was maximized.
Maximizing is not a placement the user chose — it is a temporary state that takes the
whole screen — so it is never treated as one.

A renderer cannot read or set the **native** maximize state, so "maximized" has to be
inferred: a rect counts as maximized when it fills the work area
(`WINDOW_MAXIMIZED_TOLERANCE = 24` px, covering the 7 px of invisible resize-border
overhang measured here). Detection compares **edges**, not sizes: a filling window
overhangs on *both* opposite sides, so its width differs from the work area by the sum
of the two overhangs, and comparing sizes would reject a genuinely maximized window.

What that means in practice:

* capture discards a maximized sample and keeps the stored rect, so the pre-maximize
  size survives a close-while-maximized;
* if the first launch is already maximized there is no pre-maximize size to keep, so
  nothing is written at all rather than storing the full-screen fill;
* `planRestore` never returns a maximized intent. It also refuses a stored rect that
  *is* a work-area fill, because older builds wrote exactly that: with no pre-maximize
  size recoverable from such a document, the launch keeps the shell's default geometry
  and the next capture records a real placement;
* the stored `maximized` field is diagnostic only.

The upshot is that a maximized window does re-open as a **normal** window (Windows shows
the maximize glyph, not restore), which is the intended trade: the geometry you picked
is what comes back.

## Capture

* geometry is sampled on `resize`, on `pagehide`/`beforeunload`, and by a 1 s poll — a
  window **move** fires no renderer event at all, which is what the poll is for;
* the poll's "nothing changed" test runs **before** `getScreenDetails()`, so a
  stationary window costs one synchronous rect read per tick and no display query.
  The comparison catches precisely the moves the poll exists for; skipping the rest
  is safe because the display list can only affect the diagnostic `maximized` flag,
  which no restore path reads (`planRestore` re-derives maximize from the rect);
* capture is suppressed while a restore is placing the window, so the correction
  loop's intermediate rects never reach the store;
* degenerate samples (smaller than 520x600, or unreadable) are ignored;
* a maximized sample never becomes the stored rect: the fill is discarded, the
  previously stored rect is kept, and only the diagnostic flag updates (nothing is
  written at all when no rect was ever stored);
* a sample identical to what is already stored does not rewrite it, so an idle window
  produces no localStorage churn.

The switch is re-read after *every* await inside capture, not just at the top: the
user can turn the feature off while `getScreenDetails()` is pending, and a write after
that would be geometry the feature was told to stop tracking.

The worst bug found was a **cross-launch drift** that only an independent Electron
run could have caught: the store moved −14 px on the left edge and +14/+8 px on
width/height on *every* launch, linearly and without bound, so a window crept across
the screen the more the app was restarted. Two defects combined. First, `placeWindow`
seeded its working `ask` with the *target* before the first measurement, although that
measurement describes the window's **previous** placement, so the first correction
added the entire old-to-target gap to an ask that had never been applied. Second — and
this is what kept it alive after the first fix — a measurement taken right after an ask
can echo that ask, so the loop saw a zero residual, applied nothing, and let the capture
store the uncorrected rect. Both are fixed by the settled-measurement rule and by
seeding `ask` from the measured rect; six consecutive launches now leave the store
byte-identical (verified in real Electron, not just offline).
`test/verify-window-state.mjs` section 5b pins the cold-start landing and the fixed
point.

One bug is worth naming because the symptom was so quiet: `capture()` once called a
`sameRect` helper that had drifted out of scope, so the first capture after launch
wrote the store and every later one threw a `ReferenceError` that `install()`'s
`.catch` swallowed. The visible behaviour was "remembers the previous session, never
this one" — no error, no log, just a store frozen at the startup sample.
`test/verify-window-state.mjs` section 7b is the permanent guard.

## Test seams

The WINDOW package's `plugin.windowPlacement` (i.e. `dsh-notpdpton-window/client`,
not the pack's recovery client) exposes the pure policy (`decodeState`/`encodeState`,
`clampRect`, `isOnScreen`/`isFullyOnScreen`/`bringOnScreen`, `sameRect`,
`normalizeFrame`/`pickHomeArea`, `isMaximizedRect`, `planRestore`, `placeWindow`), the
documented limits, and `install(getSwitches)` — the runtime binder. `test/verify-window-state.mjs` loads `window/client.js` and drives the pure policy
offline; the Electron harness drives `install` against a real window.

## DPI

The stored `rect` is in renderer CSS pixels, which are **device-independent pixels**
— the same unit Electron's `BrowserWindow` bounds use. Two facts pin this down:

* the shell asks for a 1280-DIP-wide window and the renderer reports `outerWidth`
  1295 at DPR 1.5 and 1296 when the scale factor is forced to 1.25. If CSS px were
  device pixels the value would scale with the factor; it does not.
* launching with `--force-device-scale-factor=1.25` (so `screenX` changed from 633 to
  888 for the same default window) still restored the saved rect **exactly**,
  `{500,300,1100,700}`.

So no scale factor is applied on restore, and the recorded `dpr` is diagnostic
evidence rather than an input. A window saved at 150% and reopened at 100% keeps the
same DIP geometry.

## Known limits

* Placement is limited by what `getScreenDetails()` reports. When that API is
  unavailable only the current screen is known: the window still restores and clamps,
  but a rect from a detached second monitor cannot be distinguished from an on-screen
  one beyond the single known work area.
* The very first launch (nothing stored yet) opens at the shell's default geometry.
* If the shell ever moves window creation into the main process, this feature becomes
  redundant and should be removed rather than kept as a second source of truth.
