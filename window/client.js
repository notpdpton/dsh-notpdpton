/**
 * Browser half of 窗口位置与尺寸记忆 (dsh-notpdpton-window).
 *
 * Makes the DSH Desktop main window reopen at the size and position it was closed
 * at. A window closed while MAXIMIZED reopens at the size it had BEFORE it was
 * maximized: maximizing is a temporary state, not a placement the user chose.
 *
 * This is a renderer feature. The Desktop shell creates its BrowserWindow in the
 * Electron main process with hardcoded bounds and exposes no geometry IPC, and the
 * Host half of a plugin runs in a plain Node child, so neither can reach the window.
 * The workspace document IS that window's top-level document, so
 * window.moveTo() / window.resizeTo() reach the real BrowserWindow.
 *
 * It is its own package so the Plugins page lists it as its own component,
 * independent of interrupted-session recovery.
 *
 * @module dsh-notpdpton-window/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-notpdpton-window',
  factory(require) {
    const React = require('react')
    const { createElement: h, useEffect, useState } = React

    /** Locale namespace owned by this plugin. */
    const NS = 'notpdptonWindow'
    /**
     * The pack's settings page child slot.
     *
     * This component does NOT open a settings page of its own: its preferences
     * belong on the pack's page (「不二布丁光子」) beside every other subfeature's,
     * as one more block. The page declares the slot; this registration only fills
     * its own block in.
     */
    const GROUP_SLOT = 'notpdpton.settings.group'
    /** localStorage key holding this component's preference switches. */
    const SWITCH_KEY = 'dsh-notpdpton-window:switches'

    const WINDOW_STATE_KEY = 'dsh-notpdpton:window-state'
    /**
     * sessionStorage key recording that THIS launch already considered a
     * geometry restore. sessionStorage survives a page reload but is cleared by
     * a new app launch, which is exactly the "once per launch" boundary wanted:
     * an in-window reload must not fight a resize the user just made, while the
     * next launch must restore again.
     */
    const WINDOW_RESTORED_KEY = 'dsh-notpdpton:window-restored'
    /** Version of the stored geometry document; a mismatch is discarded, not guessed at. */
    const WINDOW_STATE_VERSION = 1
    /** DSH's native window minimums, mirrored so a restore can never ask for less. */
    const WINDOW_MIN_WIDTH = 520
    const WINDOW_MIN_HEIGHT = 600
    /**
     * Correction passes allowed for one placement.
     *
     * The measured frame offset maps an asked rect to a reported rect by a
     * translation, so one correction pass is mathematically enough; the second
     * absorbs a stale read taken before the compositor applied the request. A
     * third exists only for the pathological case, and the loop refuses to run
     * past it, because an unbounded correction loop on a metric that never
     * converges would visibly shake the window.
     */
    const WINDOW_MAX_PASSES = 3
    /**
     * Distance from a screen's work area, in CSS px, within which a rect counts
     * as maximized.
     *
     * A native maximize and a window filling the work area report the same
     * renderer rect, but Windows lets a normal window's invisible resize border
     * overhang the work area by up to 7 px per side. Measured here: 7 px of
     * horizontal and 8 px of vertical overhang, so 24 px covers it with margin
     * while staying far below half a screen.
     */
    const WINDOW_MAXIMIZED_TOLERANCE = 24
    /** Geometry poll interval: a window MOVE fires no renderer event. */
    const WINDOW_POLL_MS = 1000
    /** Cap on one placement frame's wait for the compositor. */
    const WINDOW_SETTLE_MS = 60
    /**
     * Reads a placement must see AGREE before the value is trusted.
     *
     * A single read after moveTo/resizeTo can echo the ask itself, and Windows
     * animates window moves, so one reading of a moving window is not evidence.
     * Two agreeing reads, separated by a settle, are.
     */
    const WINDOW_STABLE_READS = 5

    /** This component's display text, in every language it ships. */
    const LOCALE_DICTS = {
      zh: {
        'group.windowPlacement': '窗口位置与尺寸记忆',
        'group.windowPlacement.desc': '重开应用时，窗口回到关闭时的位置和大小。',
        'switch.rememberWindowGeometry': '记住窗口位置和尺寸',
        'switch.rememberWindowGeometry.desc':
          '下次启动在原位置、按原大小打开窗口；最大化时按最大化之前的尺寸打开。',
      },
      en: {
        'group.windowPlacement': 'Window position and size',
        'group.windowPlacement.desc': 'Reopen the window where and how you left it.',
        'switch.rememberWindowGeometry': 'Remember window position and size',
        'switch.rememberWindowGeometry.desc':
          'Next launch opens at the same place and size — or at the size from before the window was maximized.',
      },
    }

    /** Settings the component exposes, grouped by the subfeature that owns them. */
    const SETTING_GROUPS = [
      {
        id: 'windowPlacement',
        title: 'group.windowPlacement',
        desc: 'group.windowPlacement.desc',
        items: [
          {
            key: 'rememberWindowGeometry',
            label: 'switch.rememberWindowGeometry',
            desc: 'switch.rememberWindowGeometry.desc',
          },
        ],
      },
    ]

    /** Every preference switch, flattened for the store's defaults and lookups. */
    const SWITCHES = SETTING_GROUPS.flatMap((group) => group.items)

    /** Default value per preference switch. */
    const SWITCH_DEFAULTS = {
      // On: the main window reopens at the size and position it was closed at.
      rememberWindowGeometry: true,
    }

    /** Read the persisted switch map, falling back to defaults field by field. */
    function readSwitches() {
      const next = { ...SWITCH_DEFAULTS }
      try {
        const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(SWITCH_KEY)
        if (raw === null) return next
        const parsed = JSON.parse(raw)
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return next
        for (const key of Object.keys(SWITCH_DEFAULTS)) {
          if (typeof parsed[key] === 'boolean') next[key] = parsed[key]
        }
      } catch {
        // A blocked or corrupt store falls back to the defaults.
      }
      return next
    }

    /** Persist the switch map; a blocked store keeps the in-memory value. */
    function writeSwitches(value) {
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(SWITCH_KEY, JSON.stringify(value))
      } catch {
        // Ignore: the session keeps its in-memory value.
      }
    }

    /** A tiny observable over the switch map so every subscriber re-renders together. */
    const store = {
      listeners: new Set(),
      snapshot: readSwitches(),
      getSnapshot() {
        return store.snapshot
      },
      set(key, value) {
        store.snapshot = { ...store.snapshot, [key]: value }
        writeSwitches(store.snapshot)
        for (const listener of store.listeners) listener(store.snapshot)
      },
      subscribe(listener) {
        store.listeners.add(listener)
        return () => store.listeners.delete(listener)
      },
    }

    /** Subscribe one component to the switch store. */
    function useSwitches() {
      const [value, setValue] = useState(store.getSnapshot)
      useEffect(() => store.subscribe(setValue), [])
      return value
    }

    const windowPlacement = (() => {
      /** Whether a value is a usable finite number. */
      function finite(value) {
        return typeof value === 'number' && Number.isFinite(value)
      }

      /** Clamp `value` into `[low, high]`, tolerating an inverted range. */
      function clamp(value, low, high) {
        const ceiling = Math.max(low, high)
        return Math.min(Math.max(value, low), ceiling)
      }

      /**
       * Normalize one caller-supplied rect (or null when it is not usable).
       *
       * The wire shape uses `left/top/width/height` in CSS px, which is what
       * both the renderer metric and the placement target speak.
       */
      function normalizeRect(value) {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
        const { left, top, width, height } = value
        if (!finite(left) || !finite(top) || !finite(width) || !finite(height)) return null
        if (width <= 0 || height <= 0) return null
        return { left: Math.round(left), top: Math.round(top), width: Math.round(width), height: Math.round(height) }
      }

      /**
       * Normalize one display entry into a `{ left, top, width, height }` WORK area.
       *
       * The `avail*` fields are checked FIRST and deliberately so: a Window
       * Management API `ScreenDetailed` carries BOTH the full screen rectangle
       * (`left/top/width/height`) and the usable rectangle (`availLeft/...`), and
       * the usable one is what a window can occupy. Preferring `left/width`
       * would compare windows against the taskbar-inclusive screen and report a
       * maximized window as NOT maximized — the height difference is exactly the
       * taskbar. Values with only `left/top/width/height` are this plugin's own
       * already-normalized shape, and a bare `Screen` has `avail*` too.
       */
      function normalizeWorkArea(value) {
        if (typeof value !== 'object' || value === null) return null
        if (finite(value.availLeft) && finite(value.availTop) && finite(value.availWidth) && finite(value.availHeight)) {
          return normalizeRect({ left: value.availLeft, top: value.availTop, width: value.availWidth, height: value.availHeight })
        }
        if (finite(value.left) && finite(value.top) && finite(value.width) && finite(value.height)) {
          return normalizeRect({ left: value.left, top: value.top, width: value.width, height: value.height })
        }
        return null
      }

      /**
       * Size a rect against the DSH minimums and one work area.
       *
       * The minimums are the shell's own (`minWidth: 520`, `minHeight: 600`): a
       * smaller request cannot be honoured, and asking for it every launch would
       * make the window drift instead of settling.
       */
      function clampRect(rect, workArea) {
        const area = normalizeWorkArea(workArea)
        const maxWidth = area === null ? Number.POSITIVE_INFINITY : area.width
        const maxHeight = area === null ? Number.POSITIVE_INFINITY : area.height
        // The shell's own minimum wins over a smaller work area: a screen that
        // cannot fit 520x600 must still get a legal window, anchored later by
        // bringOnScreen rather than shrunk below the supported floor.
        const minWidth = Math.min(WINDOW_MIN_WIDTH, maxWidth)
        const minHeight = Math.min(WINDOW_MIN_HEIGHT, maxHeight)
        return {
          left: rect.left,
          top: rect.top,
          width: Math.round(clamp(rect.width, minWidth, maxWidth)),
          height: Math.round(clamp(rect.height, minHeight, maxHeight)),
        }
      }

      /**
       * How much of `rect` is visible inside `area` (a rectangle intersection).
       *
       * @returns the overlap size; zero-sized when they do not meet.
       */
      function visibleOverlap(rect, area) {
        const width = Math.min(rect.left + rect.width, area.left + area.width) - Math.max(rect.left, area.left)
        const height = Math.min(rect.top + rect.height, area.top + area.height) - Math.max(rect.top, area.top)
        return { width: Math.max(0, width), height: Math.max(0, height) }
      }

      /**
       * Whether `rect` belongs to any current display at all.
       *
       * The bar is deliberately low — any positive overlap — because the two
       * failure modes are asymmetric. A rect that touches a live display is the
       * user's window and must be rescued (see {@link bringOnScreen}); only a
       * rect that meets NO display came from a monitor that is gone, and that is
       * the case worth discarding. A higher bar here would silently ignore a
       * window hanging off an edge instead of pulling it back into view.
       */
      function isOnScreen(rect, areas) {
        const list = Array.isArray(areas) ? areas : []
        for (const entry of list) {
          const area = normalizeWorkArea(entry)
          if (area === null) continue
          const seen = visibleOverlap(rect, area)
          if (seen.width > 0 && seen.height > 0) return true
        }
        return false
      }

      /**
       * Whether `rect` fits entirely inside one of `areas`.
       *
       * This is the predicate {@link bringOnScreen} needs: a window overlapping
       * a display is "on screen" but may still hang off an edge, and only a
       * fully contained rect is left alone.
       */
      function isFullyOnScreen(rect, areas) {
        const list = Array.isArray(areas) ? areas : []
        for (const entry of list) {
          const area = normalizeWorkArea(entry)
          if (area === null) continue
          if (
            rect.left >= area.left &&
            rect.top >= area.top &&
            rect.left + rect.width <= area.left + area.width &&
            rect.top + rect.height <= area.top + area.height
          ) {
            return true
          }
        }
        return false
      }

      /**
       * Move a rect that is only partly reachable fully onto its nearest display.
       *
       * The display chosen is the one the rect already overlaps most; when it
       * overlaps none, the first available display takes it. This is what turns
       * "the user unplugged the second monitor" into a window on screen instead
       * of a lost one.
       */
      function bringOnScreen(rect, areas) {
        const list = (Array.isArray(areas) ? areas : []).map(normalizeWorkArea).filter((entry) => entry !== null)
        if (list.length === 0) return rect
        if (isFullyOnScreen(rect, list)) return rect

        let best = list[0]
        let bestSeen = -1
        for (const area of list) {
          const seen = visibleOverlap(rect, area)
          const score = seen.width * seen.height
          if (score > bestSeen) {
            best = area
            bestSeen = score
          }
        }
        const sized = clampRect(rect, best)
        return {
          left: Math.round(clamp(sized.left, best.left, best.left + best.width - sized.width)),
          top: Math.round(clamp(sized.top, best.top, best.top + best.height - sized.height)),
          width: sized.width,
          height: sized.height,
        }
      }

      /**
       * Whether `rect` fills `area` (within the maximized tolerance).
       *
       * A renderer cannot read or set the native maximize state, so "maximized"
       * is defined as "occupies the work area", which is what the user sees.
       */
      function isMaximizedRect(rect, area) {
        const target = normalizeWorkArea(area)
        if (target === null) return false
        // Compare EDGES, not sizes. A filling window overhangs on both opposite
        // sides by the invisible resize border, so its width differs from the
        // work area by the SUM of the two overhangs. Comparing width directly
        // would either reject a genuinely maximized window or accept one that is
        // 2x the tolerance too wide.
        return (
          Math.abs(rect.left - target.left) <= WINDOW_MAXIMIZED_TOLERANCE &&
          Math.abs(rect.top - target.top) <= WINDOW_MAXIMIZED_TOLERANCE &&
          Math.abs(rect.left + rect.width - (target.left + target.width)) <= WINDOW_MAXIMIZED_TOLERANCE &&
          Math.abs(rect.top + rect.height - (target.top + target.height)) <= WINDOW_MAXIMIZED_TOLERANCE
        )
      }

      /**
       * Whether a rect is a real sample worth remembering.
       *
       * A hidden, minimized, or not-yet-laid-out window reports a degenerate
       * rect; storing it would poison the next launch, so those samples are
       * dropped rather than clamped into something plausible.
       */
      function isStorableRect(rect) {
        if (rect === null) return false
        if (rect.width < WINDOW_MIN_WIDTH || rect.height < WINDOW_MIN_HEIGHT) return false
        // A rect that no display overlaps is a transient during minimize or a
        // monitor hot-unplug; it says nothing about where the user wants to be.
        return true
      }

      /**
       * Read one renderer geometry sample, or null when the document cannot see
       * its window (no `window.moveTo`, e.g. an embedded frame or a test shim).
       */
      function readGeometry(target) {
        const host = target ?? (typeof window === 'undefined' ? undefined : window)
        if (host === undefined || host === null) return null
        const rect = normalizeRect({
          left: host.screenX,
          top: host.screenY,
          width: host.outerWidth,
          height: host.outerHeight,
        })
        if (rect === null) return null
        const dpr = finite(host.devicePixelRatio) && host.devicePixelRatio > 0 ? host.devicePixelRatio : 1
        return { rect, dpr }
      }

      /**
       * Normalize a measured frame offset, or null when it is not usable.
       *
       * The offset is `measured - asked`: with a hidden title bar plus a title-bar
       * overlay the window frame makes those differ by a constant. It is learned
       * from a real placement and reused, never assumed.
       */
      function normalizeFrame(value) {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
        const { left, top, width, height } = value
        if (!finite(left) || !finite(top) || !finite(width) || !finite(height)) return null
        // A frame larger than any real window frame means the stored value is
        // corrupt; refusing it falls back to the correcting loop.
        if (Math.abs(left) > 256 || Math.abs(top) > 256 || Math.abs(width) > 256 || Math.abs(height) > 256) return null
        return { left, top, width, height }
      }

      /**
       * The frame offset implied by one settled placement, or null.
       *
       * `lastAsk` must be the ask that PRODUCED `measured`; that pairing is what
       * makes the difference a frame offset rather than loop bookkeeping.
       */
      function learnedFrame(lastAsk, measured) {
        if (lastAsk === null || lastAsk === undefined || measured === null) return null
        return normalizeFrame({
          left: measured.left - lastAsk.left,
          top: measured.top - lastAsk.top,
          width: measured.width - lastAsk.width,
          height: measured.height - lastAsk.height,
        })
      }

      /** Whether two rects describe the same placement, field by field. */
      function sameRect(a, b) {
        return (
          a !== null &&
          b !== null &&
          a !== undefined &&
          b !== undefined &&
          a.left === b.left &&
          a.top === b.top &&
          a.width === b.width &&
          a.height === b.height
        )
      }

      /**
       * Encode the stored document.
       *
       * `rect` is always the NORMAL (restored) placement, never a maximized fill:
       * a window closed while maximized must still reopen at its previous normal
       * size once the user un-maximizes, so the two facts are stored separately.
       */
      function encodeState(state) {
        return JSON.stringify({
          v: WINDOW_STATE_VERSION,
          rect: state.rect,
          dpr: state.dpr,
          maximized: state.maximized === true,
          // The measured frame offset, so the next launch can place the window in
          // ONE synchronous ask instead of a visible correction a frame later.
          frame: normalizeFrame(state.frame) ?? undefined,
          updatedAt: state.updatedAt,
        })
      }

      /**
       * Decode a stored document, or null when it is absent or unusable.
       *
       * A corrupt, foreign, or older document is discarded instead of repaired:
       * a wrong guess here moves the user's window, which is worse than the
       * default geometry.
       */
      function decodeState(raw) {
        if (typeof raw !== 'string' || raw === '') return null
        let parsed
        try {
          parsed = JSON.parse(raw)
        } catch {
          return null
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
        if (parsed.v !== WINDOW_STATE_VERSION) return null
        const rect = normalizeRect(parsed.rect)
        if (rect === null) return null
        if (rect.width < WINDOW_MIN_WIDTH || rect.height < WINDOW_MIN_HEIGHT) return null
        const dpr = finite(parsed.dpr) && parsed.dpr > 0 ? parsed.dpr : 1
        const updatedAt = finite(parsed.updatedAt) ? parsed.updatedAt : 0
        return { rect, dpr, maximized: parsed.maximized === true, frame: normalizeFrame(parsed.frame), updatedAt }
      }

      /**
       * Persist geometry (best effort; a full or unavailable store must not
       * break the app).
       */
      function saveState(state, storage) {
        try {
          const target = storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage)
          if (target === undefined || target === null) return false
          target.setItem(WINDOW_STATE_KEY, encodeState(state))
          return true
        } catch {
          return false
        }
      }

      /** Read the last saved geometry, or null. */
      function loadState(storage) {
        try {
          const target = storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage)
          if (target === undefined || target === null) return null
          return decodeState(target.getItem(WINDOW_STATE_KEY))
        } catch {
          return null
        }
      }

      /**
       * Whether THIS launch already handled a restore.
       *
       * Kept in sessionStorage, which a reload preserves and a new launch
       * clears: that is precisely the boundary between "the user reloaded" and
       * "the user opened the app again".
       */
      function hasRestoredThisLaunch(storage) {
        try {
          const target = storage ?? (typeof sessionStorage === 'undefined' ? undefined : sessionStorage)
          if (target === undefined || target === null) return false
          return target.getItem(WINDOW_RESTORED_KEY) === '1'
        } catch {
          // An unavailable sessionStorage means "cannot remember", and showing
          // the restored geometry twice is harmless compared to not restoring.
          return false
        }
      }

      /** Record that this launch handled its restore. */
      function markRestored(storage) {
        try {
          const target = storage ?? (typeof sessionStorage === 'undefined' ? undefined : sessionStorage)
          if (target === undefined || target === null) return false
          target.setItem(WINDOW_RESTORED_KEY, '1')
          return true
        } catch {
          return false
        }
      }

      /**
       * Ask for one rect and correct until the window reports it.
       *
       * @param target - desired rect in renderer-reported coordinates.
       * @param read - returns the window's current renderer-reported rect.
       * @param apply - asks the window for one rect.
       * @param settle - awaits one compositor opportunity.
       * @returns the last measured rect and the error left after the final pass.
       */


      async function placeWindow(target, read, apply, settle, _options) {
        // Placement is a fixed-point search on the ASKED value, because the
        // renderer reports a rect that differs from what was asked by a constant
        // frame offset (hidden title bar + overlay). The relation has slope 1, so
        // one correction is enough.
        //
        // The hard part is not the arithmetic, it is trusting a measurement. On a
        // real window:
        //
        // 1. A read taken in the same task as moveTo/resizeTo ECHOES the ask
        //    instead of reporting the window's geometry. A loop that believes an
        //    echo sees a zero residual, applies nothing, and leaves the window
        //    misplaced.
        // 2. Windows animates a window move, so reads taken tens of ms apart can
        //    disagree while the animation runs. Readings off a moving window made a
        //    correction loop compound errors (observed: identical seed and
        //    identical code produced three different final rects in three runs).
        // 3. 'ask' must be the value that PRODUCED 'measured'. With no stored frame
        //    the first read describes the window's PREVIOUS placement, so seeding
        //    ask = target adds the whole old-to-target gap to an ask that was never
        //    applied (observed: a seed at x=106 landed at x=-7).
        //
        // All three are handled by measuring only SETTLED geometry: read, wait,
        // read again, and accept a value only when two reads agree. An echo cannot
        // survive that, and neither can a value sampled mid-animation.

        /**
         * Read the window's geometry once it has stopped changing.
         *
         * Returns null only when the window cannot be measured at all. A window
         * that never stabilizes within the budget yields its last read, which is
         * the best available evidence.
         */
        async function stableRead() {
          let value = read()
          if (value === null) return null
          for (let attempt = 0; attempt < WINDOW_STABLE_READS; attempt++) {
            await settle()
            const next = read()
            if (next === null) return null
            if (sameRect(value, next)) return next
            value = next
          }
          return value
        }

        let measured = await stableRead()
        if (measured === null) {
          return { rect: null, error: null, passes: 0, clamped: false, frame: null, applied: 0 }
        }
        /** The ask that produced the current 'measured' (see hazard 3). */
        let ask = { ...measured }
        let applied = 0
        let error = null
        let previous = null
        for (let pass = 0; pass < WINDOW_MAX_PASSES; pass++) {
          error = {
            left: target.left - measured.left,
            top: target.top - measured.top,
            width: target.width - measured.width,
            height: target.height - measured.height,
          }
          if (error.left === 0 && error.top === 0 && error.width === 0 && error.height === 0) {
            return { rect: measured, error, passes: pass, clamped: false, frame: learnedFrame(ask, measured), applied }
          }
          // The window stopped following the request. Windows clamps a window to
          // the work area, so a work-area-sized rect on a decorated window (a
          // maximized restore) can never be reached in renderer space: the OS keeps
          // returning the same clamped rect. Asking again would only repeat
          // identical move/resize messages, so the loop reports it.
          if (previous !== null && sameRect(previous, measured)) {
            return { rect: measured, error, passes: pass, clamped: true, frame: learnedFrame(ask, measured), applied }
          }
          previous = measured
          // Correct the ASKED value by the measured miss.
          ask = {
            left: ask.left + error.left,
            top: ask.top + error.top,
            width: ask.width + error.width,
            height: ask.height + error.height,
          }
          apply(ask)
          applied++
          measured = await stableRead()
          if (measured === null) {
            return { rect: null, error: null, passes: pass, clamped: false, frame: null, applied }
          }
        }
        return { rect: measured, error, passes: WINDOW_MAX_PASSES, clamped: false, frame: learnedFrame(ask, measured), applied }
      }

      /**
       * The work area a rect belongs to: the one it overlaps most, or the first
       * area when it overlaps none.
       *
       * This is what keeps a maximized restore on the right monitor instead of
       * always filling the numerically first display.
       */
      function pickHomeArea(rect, areas) {
        const list = (Array.isArray(areas) ? areas : []).map(normalizeWorkArea).filter((entry) => entry !== null)
        if (list.length === 0) return null
        if (rect === null || rect === undefined) return list[0]
        let best = list[0]
        let bestScore = -1
        for (const area of list) {
          const seen = visibleOverlap(rect, area)
          const score = seen.width * seen.height
          if (score > bestScore) {
            best = area
            bestScore = score
          }
        }
        return best
      }

      /**
       * Decide what to do at launch.
       *
       * Returns the rect to ask for (already clamped and on-screen) plus the
       * intent, or null when there is nothing to restore.
       */
      function planRestore(state, options) {
        const switches = options?.switches ?? {}
        if (switches.rememberWindowGeometry === false) return null
        if (state === null || state === undefined) return null
        const areas = Array.isArray(options?.workAreas) ? options.workAreas.map(normalizeWorkArea).filter((entry) => entry !== null) : []
        // Without a display list the rect cannot be validated against the
        // current monitors; restoring blindly risks an unreachable window.
        if (areas.length === 0) return null
        // A rect that is not reachable on ANY display came from a monitor that is
        // gone; restoring it would put the window where it cannot be used, so the
        // launch keeps the shell's default geometry. A rect that IS reachable but
        // hangs off an edge is rescued by bringOnScreen below instead.
        if (!isOnScreen(state.rect, areas)) return null
        // A window closed while maximized restores to the size it had BEFORE it was
        // maximized, never to the maximized fill. That is deliberate: reopening
        // maximized takes the whole screen away from the user on every launch, and
        // the pre-maximize size is the placement they actually chose. The stored
        // 'maximized' flag is therefore diagnostic only and never drives a restore.
        const home = pickHomeArea(state.rect, areas)
        // A stored rect that IS the work-area fill is not a placement anyone chose:
        // it is what an older build wrote when it captured a maximized window, and
        // restoring it would reopen the window filling the screen — the exact thing
        // this rule exists to prevent. There is no pre-maximize size to recover from
        // such a document, so the launch keeps the shell's default geometry and the
        // next capture records a real placement.
        if (isMaximizedRect(state.rect, home)) return null
        return { intent: 'normal', rect: bringOnScreen(clampRect(state.rect, home), areas) }
      }

      return {
        // policy
        decodeState,
        encodeState,
        loadState,
        saveState,
        hasRestoredThisLaunch,
        markRestored,
        normalizeRect,
        normalizeWorkArea,
        clampRect,
        visibleOverlap,
        isOnScreen,
        isFullyOnScreen,
        bringOnScreen,
        isMaximizedRect,
        isStorableRect,
        pickHomeArea,
        sameRect,
        normalizeFrame,
        readGeometry,
        placeWindow,
        planRestore,
        // documented limits
        WINDOW_STATE_KEY,
        WINDOW_RESTORED_KEY,
        WINDOW_STATE_VERSION,
        WINDOW_MIN_WIDTH,
        WINDOW_MIN_HEIGHT,
        WINDOW_MAX_PASSES,
        WINDOW_MAXIMIZED_TOLERANCE,
        WINDOW_POLL_MS,
        WINDOW_STABLE_READS,
        WINDOW_SETTLE_MS,
      }
    })()
    function installWindowPlacement(getSwitches) {
      const host = typeof window === 'undefined' ? undefined : window
      if (host === undefined || host === null) return () => {}
      // Only the top-level document may move its own window. Inside an iframe
      // (the sidebar browser, a document preview) moveTo/resizeTo would move the
      // guest or do nothing, so the feature stays off there.
      if (host.top !== host) return () => {}
      if (typeof host.moveTo !== 'function' || typeof host.resizeTo !== 'function') return () => {}

      let disposed = false
      let timer
      /** Last PERSISTED state, for change detection only (never authoritative). */
      let saved
      /**
       * While a restore is placing the window, its own moves must not be
       * captured: the intermediate rects are the correction loop's business, and
       * a maximized restore would otherwise store the maximized fill as the
       * window's normal size.
       */
      let restoring = true

      /** Wait one frame plus a macrotask: the compositor applies the ask first. */
      function settle() {
        return new Promise((resolve) => {
          let done = false
          const finish = () => {
            if (done) return
            done = true
            resolve()
          }
          // requestAnimationFrame may not fire in a hidden window, so the timer
          // is the floor and rAF only makes the common case faster.
          const deadline = setTimeout(finish, WINDOW_SETTLE_MS)
          try {
            requestAnimationFrame(() => {
              clearTimeout(deadline)
              setTimeout(finish, 0)
            })
          } catch {
            clearTimeout(deadline)
            finish()
          }
        })
      }

      /** Ask the window for one rect. */
      function apply(rect) {
        try {
          host.moveTo(rect.left, rect.top)
          host.resizeTo(rect.width, rect.height)
        } catch {
          // A refused request leaves the current geometry in place; the
          // correction loop then gives up quietly at its pass bound.
        }
      }

      /** Current renderer-reported rect (the metric the correction loop uses). */
      function measure() {
        const sample = windowPlacement.readGeometry(host)
        return sample === null ? null : sample.rect
      }

      /**
       * The work area of every display, in the same coordinate space as measure.
       *
       * The Window Management API is the only browser source that describes
       * OTHER displays; without it only the current screen is known, which is
       * enough to clamp and to reject an unreachable rect but not to restore
       * onto a second monitor.
       */
      async function workAreas() {
        if (typeof host.getScreenDetails === 'function') {
          try {
            const listing = await host.getScreenDetails()
            const areas = []
            for (const screen of (listing && listing.screens) || []) {
              const area = windowPlacement.normalizeWorkArea(screen)
              if (area !== null) areas.push(area)
            }
            if (areas.length > 0) return areas
          } catch {
            // Denied or unsupported: fall through to the single-screen view.
          }
        }
        const screen = host.screen
        if (screen === undefined || screen === null) return []
        const area = windowPlacement.normalizeWorkArea({
          availLeft: screen.availLeft,
          availTop: screen.availTop,
          availWidth: screen.availWidth,
          availHeight: screen.availHeight,
        })
        return area === null ? [] : [area]
      }

      /**
       * Persist the current geometry.
       *
       * The stored rect is always the window's NORMAL placement — the size and
       * position the user actually chose. A maximized window reports the work-area
       * fill instead, which is not a placement the user picked, so while the
       * window is maximized the stored rect is left alone entirely and only the
       * diagnostic 'maximized' flag is updated. That is what makes a window closed
       * while maximized reopen at the size it had BEFORE it was maximized.
       */
      async function capture() {
        if (restoring) return
        if (getSwitches().rememberWindowGeometry === false) return
        const sample = windowPlacement.readGeometry(host)
        if (sample === null) return
        if (!windowPlacement.isStorableRect(sample.rect)) return
        // The cheap "nothing happened" test runs BEFORE the display query, which is
        // the only asynchronous, cross-process work in this function. The 1 s poll
        // exists for a window MOVE (a move fires no renderer event), and moves are
        // exactly what this comparison catches: while the window sits still, every
        // poll would otherwise await getScreenDetails() only to discard the result.
        //
        // Skipping is safe because the full path's only possible effect on an
        // unchanged rect is the diagnostic `maximized` flag, which no restore path
        // reads (planRestore re-derives maximize from the rect itself). The flag can
        // be set here only when the STORED rect is itself a work-area fill, which
        // this version never stores — capture takes the maximized branch for a fill.
        if (
          saved !== undefined &&
          saved.maximized === false &&
          windowPlacement.sameRect(saved.rect, sample.rect)
        ) {
          return
        }
        const areas = await workAreas()
        // The switch is re-read after every await: the user can turn the feature
        // off while getScreenDetails() is pending, and a write after that would
        // be geometry the feature was told to stop tracking.
        if (getSwitches().rememberWindowGeometry === false) return
        // Capture never learns the frame offset. A capture sample can be taken
        // while the user is still dragging, so `saved rect - last ask` describes
        // two different moments and yields garbage (observed: a bogus
        // {2,20,-11,-14} that then made the next launch land 20px off). The frame
        // is learned ONLY by the placement loop, where the ask/measure pair is
        // controlled and settled.
        const learned = undefined
        const home = windowPlacement.pickHomeArea(sample.rect, areas)
        const maximized = home !== null && windowPlacement.isMaximizedRect(sample.rect, home)
        if (maximized) {
          // Maximizing is NOT a placement, so it must never become the stored one.
          // The fill is discarded and only the flag is recorded.
          //
          // With nothing stored yet there is no pre-maximize size to keep, and the
          // fill is the only geometry known. Storing it would defeat the whole
          // point — the window would reopen at full-screen size with no way to
          // tell that it was really maximized — so nothing is written at all and
          // the launch falls back to the shell's default size.
          const current = saved ?? windowPlacement.loadState()
          if (current === null) return
          // Already recorded: the rect is unchanged by definition, so an idle
          // maximized window produces no localStorage churn.
          if (current.maximized === true) return
          saved = {
            rect: current.rect,
            dpr: current.dpr,
            maximized: true,
            frame: learned ?? current.frame,
            updatedAt: Date.now(),
          }
          windowPlacement.saveState(saved)
          return
        }
        // A window that is not maximized must never shrink below the supported
        // minimums; a smaller sample is a transient (minimize, monitor hot-plug).
        if (sample.rect.width < WINDOW_MIN_WIDTH || sample.rect.height < WINDOW_MIN_HEIGHT) return
        if (saved !== undefined && saved.maximized === false && windowPlacement.sameRect(saved.rect, sample.rect)) return
        saved = {
          rect: sample.rect,
          dpr: sample.dpr,
          maximized: false,
          frame: learned ?? saved?.frame,
          updatedAt: Date.now(),
        }
        windowPlacement.saveState(saved)
      }

      /**
       * Restore the saved geometry exactly once per app launch.
       *
       * `restoring` is cleared on EVERY exit path, including the early returns
       * (no saved state, no display list, a rejected plan): leaving it set would
       * silently disable capture for the rest of the session.
       */
      async function restoreOnce() {
        try {
          if (getSwitches().rememberWindowGeometry === false) return
          if (windowPlacement.hasRestoredThisLaunch()) return
          const stored = windowPlacement.loadState()
          // Mark BEFORE placing: a restore interrupted half-way must not be
          // retried by a reload later in the same launch.
          windowPlacement.markRestored()
          if (stored === null) {
            // Nothing to restore, but the launch still counts as handled so a
            // later reload does not apply a geometry saved mid-session.
            saved = undefined
            return
          }
          saved = stored
          const areas = await workAreas()
          if (areas.length === 0) return
          const plan = windowPlacement.planRestore(stored, { switches: getSwitches(), workAreas: areas })
          if (plan === null) return
          // While placing, the loop's intermediate rects are not the user's
          // choice, so capture stays off; the flag is cleared in the finally.
          const result = await windowPlacement.placeWindow(plan.rect, measure, apply, settle)
          if (disposed) return
          // Record what the placement actually achieved, so the first capture
          // after the restore does not treat it as a user change and rewrite it.
          if (result.rect !== null) {
            // Record what the placement actually achieved, so the first capture
            // after the restore does not treat it as a user change and rewrite it.
            // A restore is always a NORMAL placement now: a window saved while
            // maximized reopens at its pre-maximize size, so there is no fill to
            // preserve and no 'maximized' intent to carry.
            saved = {
              rect: result.rect,
              dpr: windowPlacement.readGeometry(host)?.dpr ?? 1,
              maximized: false,
              // The frame the restore itself revealed (the loop measures it from
              // the ask that produced the final rect), falling back to the one
              // already stored when the loop could not learn a new one.
              frame: windowPlacement.normalizeFrame(result.frame) ?? stored.frame,
              updatedAt: stored.updatedAt,
            }
            windowPlacement.saveState(saved)
          }
        } finally {
          restoring = false
        }
      }

      // A resize (including un-maximize) is the common case; a MOVE fires no
      // renderer event at all, so a light poll covers dragging the title bar.
      const onResize = () => {
        capture().catch(() => {})
      }
      const onHide = () => {
        capture().catch(() => {})
      }
      host.addEventListener('resize', onResize)
      host.addEventListener('pagehide', onHide)
      try {
        host.addEventListener('beforeunload', onHide)
      } catch {
        // Older engines: pagehide alone is enough.
      }

      restoreOnce()
        .catch(() => {
          restoring = false
        })
        .finally(() => {
          if (disposed) return
          if (getSwitches().rememberWindowGeometry === false) return
          timer = setInterval(() => {
            capture().catch(() => {})
          }, WINDOW_POLL_MS)
        })

      return () => {
        disposed = true
        if (timer !== undefined) clearInterval(timer)
        host.removeEventListener('resize', onResize)
        host.removeEventListener('pagehide', onHide)
        try {
          host.removeEventListener('beforeunload', onHide)
        } catch {
          // Ignore: symmetric with the guarded add above.
        }
      }
    }

    /**
     * This component's own subfeature block on the pack's settings page.
     *
     * The page owns the block's markup and hands it in as `Group`, so this block
     * supplies only its copy and its switch wiring — never its own page chrome.
     * That is what makes the two components' preferences look like one page
     * rather than two designs.
     *
     * The slot host provides `t`, already bound to this component's locale
     * namespace by the registration's `locale` field. A direct render (tests, a
     * preview) may pass nothing, so fall back to the shipped Chinese copy rather
     * than throwing: a page that cannot translate still renders.
     */
    function GroupBlock(props) {
      const t =
        typeof props?.t === 'function'
          ? props.t
          : (key) => {
              const dict = LOCALE_DICTS.zh
              return dict[key] ?? key
            }
      const Group = props?.Group
      const switches = useSwitches()
      const group = SETTING_GROUPS[0]
      const block = {
        t,
        title: t(group.title),
        desc: t(group.desc),
        items: group.items.map((item) => ({
          key: item.key,
          id: `npd-switch-${item.key}`,
          label: t(item.label),
          desc: t(item.desc),
          checked: switches[item.key] === true,
          onChange: (next) => store.set(item.key, next),
        })),
      }
      // A preview that renders the block on its own still gets a page-less block.
      return typeof Group === 'function' ? Group(block) : null
    }

    return {
      inject: ['slots', 'locale'],
      /**
       * Test seam: the window placement policy, its documented limits, and the
       * runtime binder. The offline verifier drives the pure functions directly
       * (encode/decode, clamping, on-screen checks, the correction loop) without a
       * browser. The Loader only reads apply/inject, so extra exports do not
       * affect activation.
       */
      windowPlacement: {
        ...windowPlacement,
        install: installWindowPlacement,
      },
      /**
       * Test seam: this component's settings block. The offline verifier renders
       * it with a recording `Group` and asserts the copy and the switch wiring it
       * hands to the pack's page — the page itself belongs to the other package.
       */
      groupBlock: GroupBlock,
      apply(ctx) {
        ctx.effect(
          () =>
            ctx.locale.register(NS, LOCALE_DICTS),
          'notpdpton-window: dictionaries',
        )

        // Window geometry sits outside the slot tree: it must run even when no
        // conversation is open, because the window is restored before any Session
        // exists. Installing it once, here, is what makes that possible.
        ctx.effect(() => installWindowPlacement(store.getSnapshot))

        // This component has ONE settings surface, and it is not a page: its
        // preferences are a block on the pack's page (「不二布丁光子」), beside the
        // other subfeatures'. Registering a `settings.section` here would put the
        // same preferences on a second page in the sidebar.
        ctx.slots.inject(GROUP_SLOT, () =>
          ctx.slots.register(
            {
              name: GROUP_SLOT,
              id: 'windowPlacement',
              // After the recovery block: pack order follows the features' own.
              order: 10,
              locale: NS,
            },
            GroupBlock,
          ),
        )
      },
    }
  },
})