/**
 * Browser half of 异常中断恢复 (dsh-notpdpton-recover).
 *
 * Contributes two surfaces:
 *
 *  - `conversation.input.dock` — the full-width seat directly above the
 *    composer card. When the Host's `interruption` projection reports that this
 *    Session ended abnormally, it renders a notice with a Continue button.
 *  - `settings.section` — the pack's settings page (「不二布丁光子」), where every
 *    subfeature switch lives.
 *  - `notpdpton.settings.group` — that page's child slot: one block per
 *    subfeature, contributed by the component that ships it. This component
 *    contributes its own block there like any other, so the page never needs to
 *    know what the pack's other features are called.
 *
 * Subfeature switches are stored in `localStorage` so they survive reloads and
 * apply immediately in the page.
 *
 * @module dsh-notpdpton-recover/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-notpdpton-recover',
  factory(require) {
    const React = require('react')
    const { createElement: h, useCallback, useEffect, useMemo, useState } = React

    /** Locale namespace owned by this plugin. */
    const NS = 'notpdpton'
    /**
     * The pack this page belongs to, and the version shown beside the page title.
     *
     * The browser half cannot read a package.json, so the version is a constant
     * here. `test/verify-manifest.mjs` pins both to the pack manifest, which turns
     * a forgotten version bump into a red check instead of a stale number on the
     * settings page.
     */
    const PACKAGE_ID = 'dsh-notpdpton'
    const PACKAGE_VERSION = '1.1.6'
    /** Projection key registered by this plugin's Host half. */
    const PROJECTION_KEY = 'interruption'
    /** Dock cell id; a fresh id adds an entry beside the shipped todo/goal/queue docks. */
    const DOCK_ID = 'notpdpton-interrupted'
    /** Settings section id. */
    const SECTION_ID = 'notpdpton'
    /**
     * Child list slot of {@link SECTION_ID}: one block per subfeature.
     *
     * The page declares it; every component of this pack that ships a subfeature
     * registers its own block into it. That is what keeps the pack's settings in
     * ONE page while each component keeps describing only itself.
     */
    const GROUP_SLOT = 'notpdpton.settings.group'
    /** localStorage keys. */
    const SWITCH_KEY = 'dsh-notpdpton:switches'
    /** localStorage key holding the last known main-window geometry. */

    /**
     * Settings the subfeatures expose, grouped by the subfeature that owns them.
     *
     * The subfeature's own on/off switch is NOT here: that lives on the plugin's
     * row in the plugin manager, which already owns enabling and disabling. This
     * page carries only the preferences a subfeature adds on top of being on.
     *
     * A group whose subfeature has no preferences yet still appears, stating that
     * it has none — an empty section is a clearer answer than a missing one.
     */
    const SETTING_GROUPS = [
      {
        id: 'interruptedRecovery',
        title: 'group.interruptedRecovery',
        desc: 'group.interruptedRecovery.desc',
        items: [
          { key: 'progressRestore', label: 'switch.progressRestore', desc: 'switch.progressRestore.desc' },
          { key: 'notifyUserAbort', label: 'switch.notifyUserAbort', desc: 'switch.notifyUserAbort.desc' },
        ],
      },
    ]

    /** Every preference switch, flattened for the store's defaults and lookups. */
    const SWITCHES = SETTING_GROUPS.flatMap((group) => group.items)

    /** Default value per preference switch. */
    const SWITCH_DEFAULTS = {
      progressRestore: true,
      // On: a Stop you pressed is reported too, because it can still leave work
      // unfinished. Off: only endings you did not choose are reported.
      notifyUserAbort: true,
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
        // A corrupted or unavailable store is not worth failing the UI over.
      }
      return next
    }

    /**
     * The one switch store both surfaces read.
     *
     * A tiny observable keeps the dock and the settings page in sync: toggling in
     * settings updates the notice immediately, with no reload.
     */
    const store = {
      value: readSwitches(),
      listeners: new Set(),
      getSnapshot: () => store.value,
      subscribe(listener) {
        store.listeners.add(listener)
        return () => {
          store.listeners.delete(listener)
        }
      },
      set(key, enabled) {
        if (store.value[key] === enabled) return
        store.value = { ...store.value, [key]: enabled }
        try {
          if (typeof localStorage !== 'undefined') localStorage.setItem(SWITCH_KEY, JSON.stringify(store.value))
        } catch {
          // Persisting is best-effort; the live value still applies.
        }
        for (const listener of [...store.listeners]) listener()
      },
    }

    /** Subscribe one component to the switch store. */
    function useSwitches() {
      const [value, setValue] = useState(store.getSnapshot)
      useEffect(() => store.subscribe(() => setValue(store.getSnapshot())), [])
      return value
    }

    /** Styles inherit the host theme: only `--dsw-alias-*` tokens are referenced. */
    const CSS = `
.npd-root {
  box-sizing: border-box;
  width: calc(100% - 2 * var(--dsh-composer-side-clearance) - 4 * var(--dsh-composer-dock-inset));
  max-width: calc(var(--dsh-composer-card-max-width) - 4 * var(--dsh-composer-dock-inset));
  margin: 0 auto;
}
.npd-card {
  isolation: isolate;
  position: relative;
  display: flex;
  /* Collapsed: the one-line notice centers as a whole, so the text and the
     buttons share a baseline instead of the text riding high. */
  align-items: center;
  gap: 10px;
  box-sizing: border-box;
  width: 100%;
  padding: 10px 12px;
  border: 0;
  border-radius: var(--dsw-radius-lg, 10px);
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
  box-shadow: var(--dsw-elevation-panel);
}
/* Expanded: the body grows downward from the title, so both columns anchor to
   the top and the buttons stay level with the title line rather than drifting
   into the middle of the details. */
.npd-card[data-expanded="true"] { align-items: flex-start; }
.npd-card::before {
  content: "";
  position: absolute;
  inset: 0;
  z-index: -1;
  pointer-events: none;
  border-radius: inherit;
  background: var(--dsw-specific-menu, var(--dsw-alias-bg-layer-1));
  -webkit-backdrop-filter: var(--dsw-menu-backdrop-filter);
  backdrop-filter: var(--dsw-menu-backdrop-filter);
}
.npd-main { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1; }
/* Collapsed: npd-main holds a single row; matching the button height keeps the
   whole notice on one optical line instead of the text sitting above center. */
.npd-card:not([data-expanded="true"]) .npd-main { justify-content: center; }
.npd-titleRow { display: flex; align-items: center; gap: 8px; min-width: 0; }
.npd-dot {
  flex: none; width: 8px; height: 8px; border-radius: 999px;
  background: var(--dsw-alias-state-warn-primary);
}
.npd-dot[data-severity="error"] { background: var(--dsw-alias-state-error-primary); }
.npd-title {
  flex: none; font-size: 13px; font-weight: 500; line-height: 22px;
  color: var(--dsw-alias-label-primary);
}
.npd-reason {
  min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 12px; line-height: 22px; color: var(--dsw-alias-label-secondary);
}
.npd-detail {
  font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary);
  overflow-wrap: anywhere;
}
/* Buttons follow the card's cross-axis rule instead of centering themselves, so
   the collapsed notice stays level and the expanded one anchors to the title. */
.npd-actions { display: flex; align-items: center; gap: 8px; flex: none; }
.npd-button {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: 30px; padding: 0 12px; border: 0;
  border-radius: var(--dsw-radius-md, 8px);
  font: inherit; font-size: 13px; line-height: 20px; cursor: pointer; white-space: nowrap;
}
.npd-button[data-variant="primary"] { background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); }
.npd-button[data-variant="primary"]:hover:not(:disabled) { filter: brightness(1.06); }
.npd-button[data-variant="ghost"] { background: transparent; color: var(--dsw-alias-label-secondary); }
.npd-button[data-variant="ghost"]:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2));
  color: var(--dsw-alias-label-primary);
}
.npd-button:disabled { opacity: .5; cursor: default; }
.npd-button:focus-visible { outline: 1.5px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.npd-note { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.npd-note[data-tone="error"] { color: var(--dsw-alias-state-error-primary); }
.npd-note[data-tone="success"] { color: var(--dsw-alias-state-success-primary); }

/* Collapsed notice keeps exactly one explanatory line; everything else lives
   behind the Details toggle so a crashed Session does not shout at the user. */
.npd-details {
  margin-top: 8px;
  padding-top: 8px;
  border-top: .5px solid var(--dsw-alias-border-l2);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.npd-detailRow { display: flex; gap: 8px; align-items: baseline; font-size: 12px; line-height: 18px; }
.npd-detailLabel { flex: none; width: 66px; color: var(--dsw-alias-label-secondary); }
.npd-detailValue { min-width: 0; flex: 1; color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }
.npd-detailValue[data-mono="true"] {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11.5px;
}
.npd-detailHead {
  margin: 6px 0 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary);
}
.npd-button[aria-expanded="true"] { color: var(--dsw-alias-label-primary); }
.npd-button[data-variant="ghost"][aria-expanded="true"] {
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2));
}

.npd-page { display: flex; flex-direction: column; gap: 4px; }
.npd-pageHead { display: flex; flex-direction: column; gap: 4px; padding-bottom: 8px; }
/* Title, package id and version share one baseline, the way the market's heading
   pairs its name with the package and the installed version. */
.npd-pageTitleRow { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 10px; min-width: 0; }
.npd-pageTitle { margin: 0; font-size: 15px; font-weight: 600; line-height: 24px; color: var(--dsw-alias-label-primary); }
.npd-pageId,
.npd-pageVersion {
  flex: none; font-size: 12px; line-height: 20px;
  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));
}
/* A version is a number to compare down a column, not prose. */
.npd-pageVersion { font-variant-numeric: tabular-nums; }
.npd-pageDesc { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
/* One block per subfeature, so a preference is always read in the context of the
   feature that owns it. */
.npd-group { display: flex; flex-direction: column; padding-top: 14px; }
.npd-group + .npd-group { border-top: .5px solid var(--dsw-alias-border-l2); }
.npd-groupHead { display: flex; flex-direction: column; gap: 2px; padding-bottom: 2px; }
.npd-groupTitle { margin: 0; font-size: 13px; font-weight: 600; line-height: 22px; color: var(--dsw-alias-label-primary); }
.npd-groupDesc { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.npd-groupEmpty { margin: 8px 0 4px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); opacity: .8; }
.npd-row {
  display: flex; align-items: center; gap: 16px;
  padding: 12px 0; border-bottom: .5px solid var(--dsw-alias-border-l2);
}
.npd-row:last-child { border-bottom: 0; }
.npd-rowText { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
.npd-rowLabel { font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-primary); }
.npd-rowDesc { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.npd-switch {
  flex: none; position: relative; width: 40px; height: 24px; padding: 0;
  border: 0; border-radius: 999px; cursor: pointer;
  background: var(--dsw-alias-bg-layer-2);
  transition: background .15s ease;
}
.npd-switch[aria-checked="true"] { background: var(--dsw-alias-brand-primary); }
.npd-switch::after {
  content: ""; position: absolute; top: 3px; left: 3px;
  width: 18px; height: 18px; border-radius: 999px;
  background: var(--dsw-alias-bg-base);
  transition: transform .15s ease;
}
.npd-switch[aria-checked="true"]::after { transform: translateX(16px); }
.npd-switch:focus-visible { outline: 1.5px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.npd-switch:disabled { opacity: .45; cursor: default; }
/* A row whose preference is a VALUE rather than an on/off state. The label column
   keeps the same metrics as a switch row, so a block that mixes both reads as one
   list; the control column is sized for a field, not for a switch. */
.npd-field {
  display: flex; align-items: flex-start; gap: 16px;
  padding: 12px 0; border-bottom: .5px solid var(--dsw-alias-border-l2);
}
.npd-field:last-child { border-bottom: 0; }
.npd-fieldText { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
.npd-fieldControl { flex: none; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
/* Host-shaped controls: one-line inputs and selects on the layer-2 surface, a
   1px border, and the brand color for focus. Nothing here may invent a color. */
.npd-input,
.npd-select {
  box-sizing: border-box;
  height: 30px; padding: 0 10px; min-width: 200px; max-width: 320px;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 13px; line-height: 20px;
}
.npd-input::placeholder { color: var(--dsw-alias-label-secondary); opacity: .7; }
.npd-input[data-invalid="true"] { border-color: var(--dsw-alias-state-error-primary); }
.npd-input:focus-visible,
.npd-select:focus-visible { outline: 1.5px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.npd-input[type="password"] { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.npd-textarea {
  box-sizing: border-box;
  width: 100%; min-height: 60px; padding: 7px 10px; resize: vertical;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 12px; line-height: 18px; overflow-wrap: anywhere;
}
.npd-textarea:focus-visible { outline: 1.5px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
/* A value that fills the whole row width, for a list rather than a scalar. */
.npd-field[data-wide="true"] { flex-direction: column; align-items: stretch; gap: 8px; }
.npd-field[data-wide="true"] .npd-fieldControl { justify-content: flex-start; }
.npd-field[data-wide="true"] .npd-textarea { max-width: none; }
/* Segmented choice, used where the options are few and mutually exclusive. */
.npd-segments {
  display: inline-flex; padding: 2px; gap: 2px;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-layer-2);
}
.npd-segment {
  display: inline-flex; align-items: center; height: 24px; padding: 0 10px;
  border: 0; border-radius: calc(var(--dsw-radius-md, 8px) - 2px);
  background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 12px; line-height: 18px; cursor: pointer; white-space: nowrap;
}
.npd-segment[aria-pressed="true"] {
  background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base);
}
.npd-segment:disabled { opacity: .5; cursor: default; }
.npd-segment:focus-visible { outline: 1.5px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
/* The footer under a block's rows: live state, warnings, and the result of the
   last action. Never collects input, so it sits outside the row list. */
.npd-status {
  display: flex; flex-direction: column; gap: 4px;
  margin-top: 10px; padding-top: 10px;
  border-top: .5px solid var(--dsw-alias-border-l2);
}
.npd-statusLine { display: flex; gap: 8px; align-items: baseline; font-size: 12px; line-height: 18px; }
.npd-statusLabel { flex: none; width: 84px; color: var(--dsw-alias-label-secondary); }
.npd-statusValue { min-width: 0; flex: 1; color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }
.npd-statusValue[data-mono="true"] {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11.5px;
}
.npd-statusNote { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.npd-statusNote[data-tone="error"] { color: var(--dsw-alias-state-error-primary); }
.npd-statusNote[data-tone="warn"] { color: var(--dsw-alias-state-warn-primary); }
.npd-statusNote[data-tone="success"] { color: var(--dsw-alias-state-success-primary); }
`

    /** Render the plugin stylesheet as a React element so unmounting removes it. */
    function Styles() {
      return h('style', { 'data-notpdpton': 'styles' }, CSS)
    }

    /**
     * Build the continue instruction from the interruption view.
     *
     * Progress and the todo list travel inside the message because the Host's
     * `todos` projection clears on the next `turn/start`: once this message opens
     * a new turn, the model would no longer see the plan it was following.
     *
     * Progress is only attached when the plan is actually unfinished. A list whose
     * every item is completed carries nothing to resume, so pasting it would just
     * spend context restating finished work.
     *
     * @param view - the `interruption` projection value.
     * @param t - translator for this plugin's namespace.
     * @param withProgress - whether to attach the detected progress.
     * @returns the message text.
     */
    function buildContinueText(view, t, withProgress) {
      const lines = [t('continue.instruction')]
      const todos = Array.isArray(view.todos) ? view.todos : []
      const unfinished = todos.filter((todo) => todo.status !== 'completed')

      // Nothing left to resume: the instruction alone is the whole message.
      if (!withProgress || (todos.length > 0 && unfinished.length === 0)) return lines.join('\n')

      if (view.turn > 0) lines.push(t('continue.progress', { turn: view.turn }))
      if (unfinished.length > 0) {
        lines.push(t('continue.todosHead'))
        for (const todo of todos) {
          const label =
            todo.status === 'completed'
              ? t('todo.completed')
              : todo.status === 'in_progress'
                ? t('todo.inProgress')
                : t('todo.pending')
          lines.push(`- [${label}] ${todo.content}`)
        }
      }
      return lines.join('\n')
    }

    /**
     * Decide what the dock renders for one projection value.
     *
     * Every ending that is not a clean completion gets a notice, because any of
     * them can leave work unfinished. The brief line carries the *reason*; the
     * detail rows behind the Details toggle carry everything else, so the
     * collapsed notice stays one line no matter which ending it describes.
     *
     * `crash` and `interrupted` are two spellings of the same event: `crash` is
     * the live fold of an unbalanced turn, and `interrupted` also covers a turn
     * closed by the harness's repair marker or killed between steps by a shutdown.
     * Stored and live Sessions therefore report different statuses for the same
     * event, and both must show the notice.
     *
     * `status: 'none'` (a clean `completed` turn) and `forked` (a deliberate
     * branch point) are the only endings that render nothing.
     *
     * A Stop the user pressed themselves is reported only while `notifyUserAbort`
     * is on: it is the one ending the user already knows about, so it is the one
     * worth letting them silence.
     *
     * @param view - the `interruption` projection value (may be undefined).
     * @param t - translator for this plugin's namespace.
     * @param switches - the subfeature switch map.
     * @returns `{ severity, reason }`, or null when there is nothing to report.
     */
    function describeInterruption(view, t, switches) {
      if (view === undefined || view === null || typeof view.status !== 'string') return null
      switch (view.status) {
        case 'none':
          return null
        case 'crash':
          return { severity: 'warn', reason: t('reason.crash') }
        case 'interrupted':
          return { severity: 'warn', reason: t('reason.interrupted') }
        case 'error':
          return { severity: 'error', reason: t('reason.error') }
        case 'max-tokens':
          return { severity: 'warn', reason: t('reason.maxTokens') }
        case 'blocked':
          return { severity: 'warn', reason: t('reason.blocked') }
        case 'aborted':
          // The Host only reports `aborted` for a turn the user actually stopped.
          if (switches?.notifyUserAbort === false) return null
          return { severity: 'warn', reason: t('reason.aborted') }
        default:
          return null
      }
    }

    /**
     * Build the label/value rows shown behind the Details toggle.
     *
     * The reason is stated exactly once, by `describeInterruption` in the
     * collapsed line. Everything here is a fact that line does NOT carry, so the
     * panel elaborates instead of restating — and because there is a single
     * source for the reason, the two views cannot contradict each other.
     *
     * Every row is always present. An absent value renders as an explicit "none"
     * rather than vanishing, so the panel has a stable shape: the reader can tell
     * "this ending had no error code" from "this panel does not show error codes".
     *
     * @param view - the `interruption` projection value.
     * @param t - translator for this plugin's namespace.
     * @returns the labeled detail rows, in display order.
     */
    function buildDetailRows(view, t) {
      const isEmpty = (value) => value === null || value === undefined || value === ''
      const orNone = (value) => (isEmpty(value) ? t('detail.none') : String(value))

      const rows = [{ label: t('detail.turn'), value: view.turn > 0 ? String(view.turn) : t('detail.none') }]
      // Monospace is for reading an identifier. The "none" placeholder is prose,
      // so it takes the normal face like every other empty row.
      rows.push({ label: t('detail.errorCode'), value: orNone(view.errorCode), mono: !isEmpty(view.errorCode) })
      // The failure text is often a long provider payload; it stays out of the
      // one-line reason and appears here in full.
      rows.push({ label: t('detail.errorMessage'), value: orNone(view.errorMessage) })
      return rows
    }

    /**
     * The composer-dock entry.
     *
     * @param props - standard slot props (`useProjection`, `useSession`,
     *   `inputActions`, `sessionId`) plus `t` from the registration's locale.
     * @returns the notice, or null when there is nothing to resume.
     */
    function InterruptedDock(props) {
      const { useProjection, useSession, inputActions, t } = props
      const view = useProjection(PROJECTION_KEY)
      const running = useSession((state) => state.running)
      const switches = useSwitches()

      const [busy, setBusy] = useState(false)
      const [outcome, setOutcome] = useState(null)
      const [dismissed, setDismissed] = useState(null)
      const [expanded, setExpanded] = useState(false)

      // `switches` is a dependency: flipping `notifyUserAbort` must show or hide a
      // Stop notice immediately, without waiting for a new event.
      const notice = useMemo(() => describeInterruption(view, t, switches), [view, t, switches])

      // A dismissal applies to one exact interruption, not to the feature.
      const noticeKey = notice === null ? null : `${view.status}:${view.turn}`

      // A fresh interruption (or a cleared one) re-arms the notice collapsed.
      useEffect(() => {
        setDismissed(null)
        setOutcome(null)
        setBusy(false)
        setExpanded(false)
      }, [noticeKey])

      // Release the busy state once the resumed turn settles.
      useEffect(() => {
        if (busy && running !== true) setBusy(false)
      }, [busy, running])

      // Whether this whole subfeature runs is the plugin manager's call, not a
      // preference: loaded means on. Only the per-preference switches apply here.
      // While the agent is running the turn is open by definition, so the notice
      // would be wrong: it is meant for a Session left interrupted.
      const visible = notice !== null && noticeKey !== null && noticeKey !== dismissed && running !== true

      const onContinue = useCallback(() => {
        if (busy) return
        setBusy(true)
        setOutcome(null)
        try {
          const text = buildContinueText(view, t, switches.progressRestore)
          inputActions.setDraft(text)
          inputActions.submit()
          setOutcome({ tone: 'success', text: t('continue.sent') })
        } catch (failure) {
          const message = failure instanceof Error ? failure.message : String(failure)
          setOutcome({ tone: 'error', text: t('continue.failed', { message }) })
        } finally {
          setBusy(false)
        }
      }, [busy, inputActions, switches.progressRestore, t, view])

      const onDismiss = useCallback(() => {
        setDismissed(noticeKey)
      }, [noticeKey])

      const onToggleDetails = useCallback(() => {
        setExpanded((current) => !current)
      }, [])

      if (!visible) return null

      const todos = Array.isArray(view.todos) ? view.todos : []
      const detailRows = buildDetailRows(view, t)

      // Everything optional lives here, so the collapsed notice stays one line.
      //
      // The todo list is deliberately absent: the shipped conversation dock
      // already renders it directly above this notice, so repeating it here would
      // show the same plan twice on one screen.
      const detailBody = [
        detailRows.length > 0
          ? h(
              'div',
              { className: 'npd-details', key: 'rows' },
              detailRows.map((row) =>
                h('div', { className: 'npd-detailRow', key: row.label }, [
                  h('span', { className: 'npd-detailLabel', key: 'label' }, row.label),
                  h(
                    'span',
                    { className: 'npd-detailValue', 'data-mono': row.mono ? 'true' : undefined, key: 'value' },
                    row.value,
                  ),
                ]),
              ),
            )
          : null,
      ]

      return h(React.Fragment, null, [
        h(Styles, { key: 'styles' }),
        h(
          'div',
          { className: 'npd-root', 'data-notpdpton': 'interrupted', key: 'root' },
          h('div', { className: 'npd-card', role: 'status', 'data-expanded': expanded ? 'true' : undefined }, [
            h('div', { className: 'npd-main', key: 'main' }, [
              h('div', { className: 'npd-titleRow', key: 'title' }, [
                h('span', { className: 'npd-dot', 'data-severity': notice.severity, 'aria-hidden': true, key: 'dot' }),
                h('span', { className: 'npd-title', key: 'label' }, t('title')),
                h('span', { className: 'npd-reason', title: notice.reason, key: 'reason' }, notice.reason),
              ]),
              expanded
                ? h('div', { key: 'body' }, detailBody)
                : null,
              outcome === null
                ? null
                : h('div', { className: 'npd-note', 'data-tone': outcome.tone, role: 'status', key: 'outcome' }, outcome.text),
            ]),
            h('div', { className: 'npd-actions', key: 'actions' }, [
              h(
                'button',
                {
                  key: 'details',
                  type: 'button',
                  className: 'npd-button',
                  'data-variant': 'ghost',
                  'aria-expanded': expanded,
                  'aria-controls': 'npd-details',
                  disabled: busy,
                  onClick: onToggleDetails,
                },
                expanded ? t('details.hide') : t('details.show'),
              ),
              h(
                'button',
                {
                  key: 'continue',
                  type: 'button',
                  className: 'npd-button',
                  'data-variant': 'primary',
                  disabled: busy,
                  'aria-busy': busy || undefined,
                  onClick: onContinue,
                },
                busy ? t('continue.busy') : t('continue.label'),
              ),
              h(
                'button',
                {
                  key: 'dismiss',
                  type: 'button',
                  className: 'npd-button',
                  'data-variant': 'ghost',
                  disabled: busy,
                  onClick: onDismiss,
                },
                t('dismiss'),
              ),
            ]),
          ]),
        ),
      ])
    }

    /**
     * Draw ONE subfeature block: its heading, then the rows it supplies.
     *
     * The page owns this markup, and hands it to every block through the group
     * slot's owner props (`Group`). That is what keeps two blocks from two
     * different packages looking the same by coincidence instead of by contract:
     * a block supplies its copy and its controls, never its own chrome.
     *
     * Two row kinds exist because the pack has two kinds of preference:
     *
     *   - `items` — a preference that is ON or OFF, drawn as a labelled switch;
     *   - `fields` — a value the user types or picks, drawn as a labelled control
     *     the block supplies (a `select`, an `input`, a button row). The page
     *     still owns the row, the label column and the spacing; only the control
     *     itself comes from the block, styled with the page's own field classes.
     *
     * `body` is optional component-owned content for richer forms; the page still
     * owns the section heading and sibling placement. Switch-only contributors
     * need not change. `footer` remains available below either form of content.
     * A body or footer counts as content, so loading/error states never receive
     * the misleading "no additional settings" placeholder.
     *
     * @param block - `t` bound to the contributing component's namespace, the
     *   heading and description, the switch rows, the field rows, and the footer.
     * @returns the block element.
     */
    function renderGroupBlock({ t, title, desc, items = [], fields = [], body = null, footer = null }) {
      const rows = [
        ...items.map((item) =>
          h('div', { className: 'npd-row', key: item.key }, [
            h(
              'div',
              { className: 'npd-rowText', key: 'text' },
              h('label', { className: 'npd-rowLabel', htmlFor: item.id, key: 'label' }, item.label),
              item.desc === undefined ? null : h('span', { className: 'npd-rowDesc', key: 'desc' }, item.desc),
            ),
            h('button', {
              key: 'switch',
              id: item.id,
              type: 'button',
              className: 'npd-switch',
              role: 'switch',
              'aria-checked': item.checked,
              'aria-label': item.label,
              disabled: item.disabled === true,
              onClick: () => item.onChange(!item.checked),
            }),
          ]),
        ),
        ...fields.map((field) =>
          h('div', { className: 'npd-field', key: field.key, 'data-wide': field.wide === true ? 'true' : undefined }, [
            h(
              'div',
              { className: 'npd-fieldText', key: 'text' },
              h('label', { className: 'npd-rowLabel', htmlFor: field.id, key: 'label' }, field.label),
              field.desc === undefined ? null : h('span', { className: 'npd-rowDesc', key: 'desc' }, field.desc),
            ),
            h('div', { className: 'npd-fieldControl', key: 'control' }, field.control),
          ]),
        ),
      ]
      return h('section', { className: 'npd-group' }, [
        h('div', { className: 'npd-groupHead', key: 'head' }, [
          h('h3', { className: 'npd-groupTitle', key: 'title' }, title),
          desc === undefined
            ? null
            : h('p', { className: 'npd-groupDesc', key: 'desc' }, desc),
        ]),
        rows.length > 0
          ? rows
          : body === null && footer === null
            ? h('p', { className: 'npd-groupEmpty', key: 'empty' }, t('group.empty') === 'group.empty' ? '—' : t('group.empty'))
            : null,
        body,
        footer,
      ])
    }

    /**
     * This component's own subfeature block.
     *
     * It carries its copy and its switch wiring only; the page draws the block
     * (see {@link renderGroupBlock}).
     *
     * @param props - `t`, plus the page-supplied `Group` renderer.
     * @returns the block for 异常中断恢复.
     */
    function GroupBlock({ t, Group }) {
      const switches = useSwitches()
      const group = SETTING_GROUPS[0]
      return Group({
        t,
        title: t(group.title),
        desc: group.desc === undefined ? undefined : t(group.desc),
        items: group.items.map((entry) => ({
          key: entry.key,
          id: `npd-switch-${entry.key}`,
          label: t(entry.label),
          desc: t(entry.desc),
          checked: switches[entry.key] === true,
          onChange: (next) => store.set(entry.key, next),
        })),
      })
    }

    /**
     * The settings page: the pack's own heading, then one block per subfeature.
     *
     * A subfeature's on/off switch is the plugin manager's job, so it is not
     * repeated here — that would give the same feature two switches in two places.
     *
     * The blocks come from the components themselves through `GROUP_SLOT`, so a
     * component added to this pack later appears here without this file naming it.
     *
     * @param props - `t` from the registration's locale namespace, and the
     *   `renderSlot` bound to this entry's declared children.
     * @returns the settings page.
     */
    function SettingsPage({ t, renderSlot }) {
      return h('div', { className: 'npd-page' }, [
        h(Styles, { key: 'styles' }),
        h('div', { className: 'npd-pageHead', key: 'head' }, [
          // Title, then the package id and version on the same line: a screenshot
          // of this page then carries the two facts a bug report needs, exactly
          // as the plugin market's own heading does.
          h('div', { className: 'npd-pageTitleRow', key: 'titleRow' }, [
            h('h2', { className: 'npd-pageTitle', key: 'title' }, t('settings.title')),
            h('span', { className: 'npd-pageId', key: 'id' }, PACKAGE_ID),
            h(
              'span',
              { className: 'npd-pageVersion', title: t('settings.versionHint'), key: 'version' },
              `v${PACKAGE_VERSION}`,
            ),
          ]),
          h('p', { className: 'npd-pageDesc', key: 'desc' }, t('settings.description')),
        ]),
        // Keyed by nothing: the outlet is a single persistent child of the page,
        // so a component appearing or leaving re-renders in place. `Group` is the
        // page's block renderer, handed to every block so two packages' blocks
        // share this page's chrome instead of each bringing its own.
        renderSlot(GROUP_SLOT, { Group: renderGroupBlock }),
      ])
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // `bind` reads the active locale at call time, so the nav label follows a
        // locale switch without re-registering the section.
        const translate = ctx.locale.bind(NS)

        ctx.effect(
          () =>
            ctx.locale.register(NS, {
              zh: {
                title: '会话未正常结束',
                // Reason only — the title already says the session did not finish
                // cleanly, so repeating "the last run was…" here would restate it.
                'reason.crash': '进程异常退出',
                'reason.interrupted': '重启或连接中断',
                'reason.error': '任务执行出错',
                'reason.maxTokens': '输出达到长度上限',
                'reason.blocked': '任务被阻止',
                'reason.aborted': '被手动停止',
                'continue.label': '继续',
                'continue.busy': '继续中…',
                'continue.sent': '已填写继续指令',
                'continue.failed': '继续失败：{message}',
                'continue.instruction': '上次会话未正常结束，检查进度，然后继续。',
                'continue.progress': '上次中断于第 {turn} 轮。',
                'continue.todosHead': '上次的任务清单：',
                'todo.completed': '已完成',
                'todo.inProgress': '进行中',
                'todo.pending': '待处理',
                dismiss: '忽略',
                'details.show': '详情',
                'details.hide': '收起',
                'detail.turn': '中断轮次',
                'detail.errorCode': '错误代码',
                'detail.errorMessage': '错误信息',
                'detail.none': '无',
                'settings.title': '不二布丁光子',
                'settings.versionHint': '插件版本 — 反馈问题时请附上',
                'settings.description': '插件的启用状态在「插件」页控制，这里只放各子功能的设置。',
                'group.interruptedRecovery': '异常中断恢复',
                'group.interruptedRecovery.desc': '会话非正常结束时，在输入框上方显示「继续」按钮。',
                'group.empty': '此子功能暂无额外设置。',
                'switch.progressRestore': '恢复进度与任务清单',
                'switch.progressRestore.desc': '继续时附带未完成的任务清单，帮助模型准确接续。',
                'switch.notifyUserAbort': '提示手动停止的会话',
                'switch.notifyUserAbort.desc': '关闭后只提示非你主动结束的会话。',
              },
              en: {
                title: 'Session did not finish cleanly',
                // Reason only — the title already states the outcome.
                'reason.crash': 'the process exited unexpectedly',
                'reason.interrupted': 'a restart or lost connection',
                'reason.error': 'the task failed',
                'reason.maxTokens': 'the output limit was reached',
                'reason.blocked': 'the task was blocked',
                'reason.aborted': 'you stopped it manually',
                'continue.label': 'Continue',
                'continue.busy': 'Continuing…',
                'continue.sent': 'Continue instruction drafted',
                'continue.failed': 'Continue failed: {message}',
                'continue.instruction':
                  'The previous session did not finish cleanly. Check the progress, then continue.',
                'continue.progress': 'The interruption happened during turn {turn}.',
                'continue.todosHead': 'The task list at that point:',
                'todo.completed': 'done',
                'todo.inProgress': 'in progress',
                'todo.pending': 'pending',
                dismiss: 'Dismiss',
                'details.show': 'Details',
                'details.hide': 'Hide details',
                'detail.turn': 'Turn',
                'detail.errorCode': 'Error code',
                'detail.errorMessage': 'Error message',
                'detail.none': 'none',
                'settings.title': 'Notpdpton Photon',
                'settings.versionHint': 'Plugin version — include it when reporting an issue',
                'settings.description':
                  'Enabling the plugin is handled on the Plugins page; this page holds each subfeature’s settings.',
                'group.interruptedRecovery': 'Interrupted-session recovery',
                'group.interruptedRecovery.desc':
                  'Shows a Continue button above the composer when a session did not finish cleanly.',
                'group.empty': 'This subfeature has no additional settings.',
                'switch.progressRestore': 'Restore progress and todo list',
                'switch.progressRestore.desc':
                  'Attach the unfinished todo list when continuing so the model resumes accurately.',
                'switch.notifyUserAbort': 'Report manually stopped sessions',
                'switch.notifyUserAbort.desc':
                  'When off, only sessions you did not stop yourself are reported.',
              },
            }),
          'notpdpton: dictionaries',
        )

        ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.dock',
              id: DOCK_ID,
              // Above the shipped todo dock (order 0) and the goal/queue docks.
              order: -10,
              locale: NS,
            },
            InterruptedDock,
          ),
        )

        // The section declares the group list, so every component of this pack can
        // add its block to THIS page instead of opening a page of its own.
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: SECTION_ID,
              order: 30,
              label: () => translate('settings.title'),
              locale: NS,
              children: { [GROUP_SLOT]: { kind: 'list', scope: 'root' } },
            },
            SettingsPage,
          ),
        )

        ctx.slots.inject(GROUP_SLOT, () =>
          ctx.slots.register(
            {
              name: GROUP_SLOT,
              id: 'interruptedRecovery',
              // First block: recovery is this pack's original subfeature.
              order: 0,
              locale: NS,
            },
            GroupBlock,
          ),
        )
      },
    }
  },
})
