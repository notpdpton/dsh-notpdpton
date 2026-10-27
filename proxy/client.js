/**
 * Browser half of 网络代理 (dsh-notpdpton-proxy).
 *
 * The pack owns the section heading; this component supplies one responsive form
 * through Group's optional `body`. Its styles are scoped to that body and use the
 * Host's theme tokens, so the recovery and window settings remain unchanged.
 *
 * Editing and routing are deliberately separate: the form is a draft, the status
 * strip describes the last Host reply, and only Save applies a change. A small
 * observable model owns asynchronous actions independently of React. Translation
 * changes therefore cannot reload the form, and credential operations cannot
 * replace an unsaved draft. The model is also the offline regression-test seam;
 * those tests check state transitions, not the visual appearance of the live UI.
 *
 * The existing same-origin HTTP endpoint and credential-store namespace remain
 * unchanged. Passwords are sent only to the credential store, never as settings,
 * never persisted in the browser, and never included in a status or probe label.
 *
 * @module dsh-notpdpton-proxy/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-notpdpton-proxy',
  factory(require) {
    const React = require('react')
    const { createElement: h, useEffect, useRef, useState } = React
    const NS = 'notpdptonProxy'
    const GROUP_SLOT = 'notpdpton.settings.group'
    const ROUTE_PATH = '/notpdpton-proxy/state'
    const PASSWORD_REF = 'DSH_NOTPDPTON_PROXY_PASSWORD'
    const DEFAULTS = {
      enabled: false, mode: 'auto', proxy: '', httpProxy: '', httpsProxy: '',
      noProxy: '', authUser: '', exposeToShell: 'url', promptInjection: true,
      promptTemplate: '', probeUrl: 'https://www.gstatic.com/generate_204',
    }
    const KEYS = Object.keys(DEFAULTS)
    const MODES = ['auto', 'system', 'custom', 'env', 'direct'].map((value) => ({
      value, label: `mode.${value}`, desc: `mode.${value}.desc`,
    }))
    const SHELL_EXPOSURES = ['off', 'url', 'full'].map((value) => ({ value, label: `shell.${value}` }))

    /** The password is not a settings key, even when a newer Host adds metadata. */
    function settingsOf(value) {
      return Object.fromEntries(KEYS.map((key) => [key, value?.[key] ?? DEFAULTS[key]]))
    }
    function sameSettings(a, b) {
      return a !== undefined && b !== undefined && KEYS.every((key) => a[key] === b[key])
    }
    function hasChanges(state) {
      return state.draft !== undefined && (
        !sameSettings(state.draft, state.status?.settings) || state.secret !== '' || state.credentialPending
      )
    }
    function usesCustom(mode) {
      return mode === 'custom' || mode === 'auto'
    }
    /** Display-only defense: a manually edited URL must not reveal userinfo. */
    function safeText(value, secrets = []) {
      let text = String(value ?? '').replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*@/gi, '$1***@')
      for (const secret of secrets.filter(Boolean)) {
        for (const token of [secret, encodeURIComponent(secret)]) text = text.split(token).join('***')
      }
      return text.slice(0, 1200)
    }
    function appliedState(status) {
      if (status?.lastError) return { key: 'state.error', tone: 'error' }
      if (status?.settings?.enabled === false || status?.policy?.source === 'off') return { key: 'state.off', tone: 'idle' }
      if (status?.policy?.active === true) return { key: 'state.proxied', tone: 'success' }
      if (status?.policy?.source === 'direct') return { key: 'state.direct', tone: 'idle' }
      return { key: 'state.none', tone: 'warn' }
    }
    /** Local validation complements, but never replaces, the Host's validation. */
    function validateDraft(draft, secret = '') {
      const errors = {}
      if (usesCustom(draft.mode)) {
        for (const key of ['proxy', 'httpProxy', 'httpsProxy']) {
          const value = draft[key].trim()
          if (!value) continue
          try {
            const url = new URL(value.includes('://') ? value : `http://${value}`)
            if (!['http:', 'https:', 'socks:', 'socks5:'].includes(url.protocol) || !url.hostname) {
              errors[key] = 'validation.proxy'
            } else if (url.username || url.password) {
              errors[key] = 'validation.userinfo'
            } else if ((url.pathname && url.pathname !== '/') || url.search || url.hash) {
              errors[key] = 'validation.endpoint'
            }
          } catch { errors[key] = 'validation.proxy' }
        }
        if (draft.enabled && draft.mode === 'custom' && ![draft.proxy, draft.httpProxy, draft.httpsProxy].some((value) => value.trim())) {
          errors.proxy = 'validation.required'
        }
      }
      if (draft.authUser.includes(':')) errors.authUser = 'validation.username'
      if (secret && !draft.authUser.trim()) errors.authUser = 'validation.authUser'
      try {
        const url = new URL(draft.probeUrl)
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) errors.probeUrl = 'validation.probe'
      } catch { errors.probeUrl = 'validation.probe' }
      return errors
    }
    /** Generated Remote namespaces may return either a value or a result envelope. */
    function remoteValue(value) {
      if (value?.ok === false) {
        const error = new Error(value.error?.message ?? 'Operation refused')
        // Host refusals may carry machine-readable facts the view must act on; the
        // message alone would force the UI to match on prose.
        if (value.error?.secretStored === true) error.secretStored = true
        throw error
      }
      return value?.ok === true ? value.value : value
    }
    function statusValue(reply) {
      const value = remoteValue(reply)
      if (!value?.settings || !value?.policy) throw new Error('Invalid Host status')
      return { ...value, settings: settingsOf(value.settings) }
    }

    /** Same endpoint as before, with bounded waiting and unmount cancellation. */
    async function callHost(endpoint, payload, signal) {
      const controller = new AbortController()
      let timedOut = false
      const abort = () => controller.abort()
      if (signal?.aborted) abort()
      signal?.addEventListener('abort', abort, { once: true })
      const timer = setTimeout(() => { timedOut = true; controller.abort() }, endpoint === 'probe' ? 12000 : 18000)
      try {
        const response = await fetch(ROUTE_PATH, {
          method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ endpoint, payload: payload ?? {} }),
          signal: controller.signal,
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return await response.json()
      } catch (error) {
        if (timedOut) throw new Error('Request timed out')
        throw error
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
      }
    }

    /**
     * Credential operations over the same-origin Host route.
     *
     * Mirrors the small slice of `ctx.remote.credentials` this form needs
     * (`describe`/`set`/`unset`), so no code in the view knows which transport won.
     * The Host half enforces the same one-way rule: a value can be stored or
     * removed, and only its presence is ever reported back.
     */
    const routeCredentials = {
      async describe() {
        const reply = await callHost('secret', { action: 'describe' })
        const info = remoteValue(reply)
        return { [PASSWORD_REF]: { configured: info?.configured === true, writable: info?.writable === true } }
      },
      async set(_ref, value) {
        return remoteValue(await callHost('secret', { action: 'set', password: value }))
      },
      async unset() {
        return remoteValue(await callHost('secret', { action: 'unset' }))
      },
    }

    /**
     * Observable form model. No DOM, timers, storage or routing changes of its own.
     * Request and credential functions are injectable for deterministic tests.
     *
     * Credential writes and settings writes are two different transactions. If the
     * first succeeds but the second fails, retain a visible pending-application
     * state instead of claiming success, discarding the draft, or retrying a secret
     * silently. Clearing a stored password likewise requires Save to reapply it.
     *
     * The credential adapter defaults to the Host route rather than
     * `ctx.remote.credentials` on purpose: this block must keep its authentication
     * section even in a runtime whose client half cannot reach the generated Remote
     * namespace, and one channel means one place where authentication is enforced.
     */
    function createSettingsModel({ request = callHost, credentials = routeCredentials } = {}) {
      let state = {
        phase: 'loading', status: undefined, draft: undefined, secret: '',
        credential: { phase: 'loading', configured: false, writable: false },
        credentialPending: false, operation: null, errors: {}, notice: null, probe: null,
        promptPreview: null,
      }
      let active = false
      let generation = 0
      let readSequence = 0
      let credentialSequence = 0
      let promptSequence = 0
      const listeners = new Set()
      const controllers = new Set()
      const publish = (patch) => {
        state = { ...state, ...patch }
        for (const listener of listeners) listener(state)
      }
      const current = (token) => active && generation === token
      const canAct = () => active && state.phase === 'ready' && state.operation === null
      const detail = (error, secret = state.secret) => safeText(error?.message ?? error, [secret])
      async function send(endpoint, payload) {
        const controller = new AbortController()
        controllers.add(controller)
        try { return await request(endpoint, payload, controller.signal) }
        finally { controllers.delete(controller) }
      }
      async function readCredential() {
        const token = generation
        const sequence = ++credentialSequence
        if (!credentials?.describe) {
          if (current(token)) publish({ credential: { phase: 'unavailable', configured: false, writable: false } })
          return
        }
        try {
          const result = remoteValue(await credentials.describe([PASSWORD_REF]))
          if (!current(token) || sequence !== credentialSequence) return
          const info = result?.[PASSWORD_REF]
          if (!info || typeof info.configured !== 'boolean') throw new Error('Invalid credential status')
          publish({ credential: { phase: 'ready', configured: info.configured, writable: info.writable === true } })
        } catch {
          if (current(token) && sequence === credentialSequence) {
            publish({ credential: { ...state.credential, phase: 'error', writable: false } })
          }
        }
      }
      async function refresh() {
        if (!active || state.operation !== null) return false
        const token = generation
        const sequence = ++readSequence
        const initial = state.status === undefined
        publish(initial ? { phase: 'loading', notice: null } : { operation: 'refreshing' })
        try {
          const status = statusValue(await send('status', {}))
          if (!current(token) || sequence !== readSequence) return false
          const keepDraft = hasChanges(state)
          publish({
            phase: 'ready', status, draft: keepDraft ? state.draft : { ...status.settings },
            operation: null, notice: null,
          })
          return true
        } catch (error) {
          if (current(token) && sequence === readSequence) {
            publish({ phase: initial ? 'error' : 'ready', operation: null,
              notice: { tone: 'error', key: 'error.status', detail: detail(error) } })
          }
          return false
        }
      }
      /**
       * Re-read the Host state right after a successful commit.
       *
       * The save reply already carries a full status, but it is the state the Host had
       * AT the moment it replied; anything the Host does asynchronously afterwards (a
       * system proxy it re-reads, a transport it re-installs) only shows up in a fresh
       * read. The old design exposed "Refresh status" for this, which put the burden on
       * the user and left stale read-only surfaces whenever they forgot.
       *
       * Failure is deliberately silent: the save already succeeded, and an error banner
       * about a FOLLOW-UP read would suggest the save itself failed. The previous status
       * stays on screen, which is the honest thing to show when the re-read did not land.
       *
       * @param token - the generation that owned the save, so a stale reply is dropped.
       */
      async function resyncAfterSave(token) {
        if (!current(token)) return
        try {
          const status = statusValue(await send('status', {}))
          if (!current(token)) return
          // A draft edited during the round trip is the user's, not ours: only adopt
          // the fresh status when there is nothing unsaved to protect.
          const keepDraft = hasChanges(state)
          publish({ status, draft: keepDraft ? state.draft : { ...status.settings } })
        } catch {
          // Keep what is on screen; see the note above.
        }
      }
      const model = {
        getSnapshot: () => state,
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
        async start() {
          active = true
          generation++
          await Promise.all([refresh(), readCredential()])
        },
        stop() {
          active = false
          generation++
          for (const controller of controllers) controller.abort()
          controllers.clear()
          state = { ...state, secret: '', operation: null }
        },
        setCredentials(next) {
          if (credentials === next) return
          credentials = next
          if (active) void readCredential()
        },
        refresh, readCredential,
        patch(key, value) {
          if (!canAct() || !KEYS.includes(key)) return
          // The preview described the previous draft, so keeping it would show stale
          // text beside edited settings — the exact confusion this feature prevents.
          publish({ draft: { ...state.draft, [key]: value }, errors: {}, notice: null, probe: null, promptPreview: null })
        },
        setSecret(value) {
          if (!canAct()) return
          publish({ secret: value, errors: {}, notice: null, probe: null })
        },
        revert() {
          if (!canAct()) return
          publish({ draft: { ...state.status.settings }, secret: '', errors: {}, probe: null, promptPreview: null,
            notice: state.credentialPending ? { tone: 'warn', key: 'auth.pending' } : null })
        },
        async save() {
          if (!canAct()) return false
          const errors = validateDraft(state.draft, state.secret)
          if (Object.keys(errors).length) {
            publish({ errors, notice: { tone: 'error', key: 'validation.summary' } })
            return false
          }
          const token = generation
          const proposed = settingsOf(state.draft)
          const secret = state.secret
          publish({ operation: 'saving', notice: null, errors: {}, probe: null })
          try {
            // Password and settings travel in ONE request on purpose. Sending the
            // password first would make the Host validate it against the stored user
            // name, which fails exactly on first-time setup (new user name and new
            // password entered together). One request is also one transaction: it
            // either stores both halves or changes nothing.
            const reply = await send('save', secret === '' ? { settings: proposed } : { settings: proposed, secret })
            if (!current(token)) return false
            const status = statusValue(reply)
            if (secret !== '') credentialSequence++
            // No success notice on purpose: the commit button going dead IS the receipt.
            // A saved notice only repeats what the footer already says ("matches the
            // saved configuration"), and it pushed the layout around on every save.
            publish({ status, draft: { ...status.settings }, secret: '', operation: null, credentialPending: false, promptPreview: null,
              credential: secret === '' ? state.credential : { phase: 'ready', configured: true, writable: true },
              notice: null })
            // Re-read the Host state after committing, so the read-only surfaces (the
            // applied strip, the runtime details, the system proxy report) describe what
            // is actually in force rather than what this reply happened to carry. There
            // is no Refresh button any more, so this is the only path that resyncs them.
            await resyncAfterSave(token)
            return true
          } catch (error) {
            const stored = error?.secretStored === true
            if (current(token)) {
              publish({ operation: null,
                notice: { tone: 'error', key: stored ? 'auth.partial' : 'error.save', detail: detail(error, secret) },
                // The Host never applies a half-pair, so a settings failure after a
                // stored password leaves the pair pending a reapply.
                credentialPending: stored })
            }
            return false
          }
        },
        async clearPassword() {
          if (!canAct() || !credentials?.unset || !state.credential.writable) return false
          const token = generation
          publish({ operation: 'clearing', notice: null, probe: null })
          try {
            remoteValue(await credentials.unset(PASSWORD_REF))
            if (!current(token)) return false
            credentialSequence++
            publish({ secret: '', credentialPending: true })
            // Removing a stored value can expose an ambient fallback; describe it
            // again rather than blindly claiming that authentication is absent.
            await readCredential()
            if (!current(token)) return false
            publish({ operation: null, notice: { tone: 'warn', key: 'auth.pending' } })
            return true
          } catch (error) {
            if (current(token)) publish({ operation: null, notice: { tone: 'error', key: 'error.secret', detail: detail(error) } })
            return false
          }
        },
        async probe() {
          if (!canAct()) return false
          if (hasChanges(state)) {
            publish({ notice: { tone: 'warn', key: 'probe.saveFirst' } })
            return false
          }
          const token = generation
          publish({ operation: 'probing', notice: null, probe: null })
          try {
            const result = remoteValue(await send('probe', {}))
            if (!current(token)) return false
            if (!result || typeof result.ok !== 'boolean') throw new Error('Invalid probe result')
            publish({ operation: null, probe: result })
            return true
          } catch (error) {
            if (current(token)) publish({ operation: null, probe: { ok: false, error: detail(error) } })
            return false
          }
        },
        /**
         * Ask the Host for the exact text it would inject, for the CURRENT draft.
         *
         * Deliberately not computed here: the rendering rules (which facts exist, how
         * a template placeholder expands) live on the Host, and a second copy in the
         * browser would drift. The page shows what the model will actually receive.
         */
        async previewPrompt() {
          if (!active || state.draft === undefined) return false
          const token = generation
          const sequence = ++promptSequence
          try {
            const result = remoteValue(await send('prompt', { settings: state.draft }))
            if (!current(token) || sequence !== promptSequence) return false
            if (typeof result?.text !== 'string') throw new Error('Invalid prompt preview')
            publish({ promptPreview: result })
            return true
          } catch (error) {
            if (current(token) && sequence === promptSequence) {
              publish({ promptPreview: { error: detail(error) } })
            }
            return false
          }
        },
      }
      return model
    }

    // Scoped styling. Every color is a --dsw-alias-* token, so the block follows
    // the theme without a second stylesheet; the container query handles a
    // Settings dialog dragged narrow, or a 200% zoom, without a page breakpoint.
    const CSS = `/* One settings block, drawn with the Settings page's own materials: rows and
   hairlines for preferences, the nested surface for state, the inverted-label
   commit button for the form footer. Every color is a --dsw-alias-* token, so a
   theme switch needs no rule here. */
.npdpx { container: npd-proxy / inline-size; display: flex; flex-direction: column; gap: 12px; width: 100%; min-width: 0; color: var(--dsw-alias-label-primary); font-family: var(--dsw-font-family); font-size: 14px; line-height: 22px; }
.npdpx *, .npdpx *::before, .npdpx *::after { box-sizing: border-box; }
.npdpx h4, .npdpx p, .npdpx dl, .npdpx dd { margin: 0; }

/* ---- applied state ---------------------------------------------------- */
/* The status strip is the block's first element, directly under the page's own
   group description. The page gives that description only 2px of breathing room
   (measured), while everything below the strip is separated by the first row's
   16px top padding. The margin is 14px because the page's group head already
   contributes 2px of its own: 2 + 14 above, 16 below — the same gap on both sides. */
.npdpx form { display: flex; flex-direction: column; }
.npdpx-status { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 10px; min-width: 0; margin-top: 14px; padding: 12px 14px; border-radius: var(--dsw-radius-lg); background: var(--dsw-alias-bg-module-platform); font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.npdpx-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; corner-shape: round; background: var(--dsw-alias-state-idle-primary); }
.npdpx-dot[data-tone="success"] { background: var(--dsw-alias-state-success-primary); }
.npdpx-dot[data-tone="warn"] { background: var(--dsw-alias-state-warn-primary); }
.npdpx-dot[data-tone="error"] { background: var(--dsw-alias-state-error-primary); }
.npdpx-stateWord { flex: none; font-size: 14px; line-height: 22px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.npdpx-statusEnd { flex: 1 1 180px; min-width: 0; overflow-wrap: anywhere; font-family: var(--ds-font-family-code); font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.npdpx-tag { flex: none; padding: 1px 8px; border: .5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-xs); font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.npdpx-tag[data-tone="warn"] { color: var(--dsw-alias-state-warn-label); }

/* ---- rows ------------------------------------------------------------- */
.npdpx-section { display: flex; flex-direction: column; min-width: 0; }
.npdpx-row { display: flex; align-items: center; gap: 8px; padding: 16px 0; border-bottom: 1px solid var(--dsw-alias-border-l2); }
.npdpx-row:last-child { border-bottom: none; }
.npdpx-row[data-align="start"] { align-items: flex-start; }
/* A row that owns a continuation panel drops its own hairline: the panel is the rest
   of that row's answer, so a separator between them would cut the two apart. The
   panel carries the closing 16px instead, which is where the next section's own
   border-top lands anyway. */
.npdpx-row[data-continued="true"] { border-bottom: none; padding-bottom: 8px; }
/* A control that needs the full column (a segmented mode switch) sits under the
   text instead of beside it, so five options never squeeze into half a row. */
.npdpx-row[data-align="stack"] { flex-direction: column; align-items: stretch; gap: 10px; }
.npdpx-row[data-align="stack"] .npdpx-rowText { padding-right: 0; }
.npdpx-row[data-align="stack"] .npdpx-rowControl { align-self: stretch; }
.npdpx-rowText { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 0; padding-right: 48px; }
.npdpx-rowTitle { font-size: 14px; line-height: 22px; font-weight: 400; color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }
.npdpx-rowDesc { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.npdpx-rowControl { flex: none; display: flex; align-items: center; gap: 8px; }

/* ---- switch (36x20, monochrome track, round thumb) ---------------------- */
.npdpx-switch { position: relative; flex: 0 0 auto; width: 36px; height: 20px; padding: 2px; border: 0; border-radius: 999px; corner-shape: round; background: var(--dsw-alias-border-l3); cursor: pointer; transition: background .12s ease; }
.npdpx-switch[aria-checked="true"] { background: var(--dsw-alias-brand-primary); }
.npdpx-switch:disabled { cursor: default; opacity: .5; }
.npdpx-switchThumb { display: block; width: 16px; height: 16px; border-radius: 50%; corner-shape: round; background: var(--dsw-alias-label-primary-foreground); transition: transform .12s ease; }
.npdpx-switch[aria-checked="false"] .npdpx-switchThumb { background: var(--dsw-alias-switch-thumb); }
.npdpx-switch[aria-checked="true"] .npdpx-switchThumb { transform: translate(16px); }
.npdpx-switch:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }

/* ---- segmented control (shipped recipe: 28px tabs, sliding pill) -------- */
.npdpx-segmented { position: relative; display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 2px; width: 100%; padding: 4px; border-radius: var(--dsw-radius-md); background: var(--dsw-alias-interactive-bg-hover); }
.npdpx-segmentIndicator { position: absolute; top: 4px; left: 4px; width: calc((100% - 8px - 2px * (var(--npdpx-count) - 1)) / var(--npdpx-count)); height: calc(100% - 8px); border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-1); box-shadow: var(--dsw-elevation-soft); transform: translate(calc(var(--npdpx-index) * (100% + 2px))); transition: transform .16s ease; pointer-events: none; }
.npdpx-segment { position: relative; z-index: 1; height: 28px; padding: 0 12px; border: 0; border-radius: var(--dsw-radius-sm); background: transparent; font: inherit; font-size: 13px; line-height: 20px; font-weight: 500; color: var(--dsw-alias-label-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; transition: color .12s ease; }
.npdpx-segment:hover:not(:disabled), .npdpx-segment[aria-selected="true"] { color: var(--dsw-alias-label-primary); }
.npdpx-segment:disabled { cursor: default; opacity: .4; }
.npdpx-segment:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: -2px; }

/* ---- fields ----------------------------------------------------------- */
.npdpx-fields { display: flex; flex-direction: column; min-width: 0; }
.npdpx-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; padding: 12px 0; border-top: 1px solid var(--dsw-alias-border-l2); }
.npdpx-field:first-child { border-top: none; }
/* A field group that belongs to the row above it (the source's address) hangs off
   that row with no separator, and uses the same spacing as the status panel: 4px from
   the control it configures, 16px to the next section's rule. Matching the two
   detail kinds matters because the user switches between them in one control. */
.npdpx-fields[data-continued="true"] { margin: 4px 0 4px; }
.npdpx-fields[data-continued="true"] > .npdpx-field:first-child { padding-top: 0; }
.npdpx-fieldHead { display: flex; align-items: center; gap: 8px; min-width: 0; }
.npdpx-fieldLabel { flex: 1; min-width: 0; font-size: 13px; font-weight: 500; line-height: 1.5; color: var(--dsw-alias-label-primary); }
/* align-items:start keeps a pair of fields top-aligned when only ONE of them carries
   a hint or an error under its input. Without it the grid stretches both cells to the
   taller one, and the field with no hint has its input pushed to the bottom of its
   cell — the two inputs then sit on different lines (measured: 42px apart at 564px). */
.npdpx-fieldCols { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr)); align-items: start; gap: 12px; min-width: 0; }
.npdpx-input, .npdpx-textarea { width: 100%; min-width: 0; padding: 0 12px; border: 1px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-3); font: inherit; font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-primary); }
.npdpx-input { height: 34px; }
.npdpx-textarea { padding: 8px 12px; min-height: 76px; resize: vertical; overflow-wrap: anywhere; }
.npdpx-input::placeholder, .npdpx-textarea::placeholder { color: var(--dsw-alias-label-dimmed); }
.npdpx-input:focus-visible, .npdpx-textarea:focus-visible { outline: none; border-color: var(--dsw-alias-state-business-primary); }
.npdpx-input[aria-invalid="true"], .npdpx-textarea[aria-invalid="true"] { border-color: var(--dsw-alias-state-error-primary); }
.npdpx-input:disabled, .npdpx-textarea:disabled { opacity: .5; cursor: default; }
.npdpx-mono { font-family: var(--ds-font-family-code); font-size: 12px; }
/* ---- prompt preview and template -------------------------------------- */
/* The preview quotes what the model receives, so it reads as quoted material:
   monospace, own surface, own scroll instead of growing the page. */
.npdpx-promptSection { display: flex; flex-direction: column; gap: 10px; padding-top: 10px; border-top: 1px solid var(--dsw-alias-border-l2); }
.npdpx-promptHead { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.npdpx-preview { display: flex; flex-direction: column; gap: 6px; }
.npdpx-previewText { margin: 0; padding: 10px 12px; max-height: 220px; overflow: auto; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-2); font-family: var(--ds-font-family-code); font-size: 12px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--dsw-alias-label-primary); }
.npdpx-textAreaRow { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.npdpx-placeholders { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.npdpx-chip { padding: 2px 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 999px; background: transparent; font-family: var(--ds-font-family-code); font-size: 11px; line-height: 18px; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.npdpx-chip:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.npdpx-chip:disabled { opacity: .5; cursor: default; }
.npdpx-hint { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
.npdpx-error { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-state-error-primary); overflow-wrap: anywhere; }
.npdpx-warning { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-state-warn-label); overflow-wrap: anywhere; }

/* ---- nested surface: state that is read, not edited --------------------- */
/* This panel is the CONTINUATION of the row above it (the selected source's status),
   not a separate card, so it hangs off that row rather than being boxed by it: the
   row's bottom hairline is dropped and the panel is inset from the row's edges, which
   is what makes it read as belonging to the segmented control instead of colliding
   with the next section's separator. */
.npdpx-nested { display: flex; flex-direction: column; gap: 4px; min-width: 0; margin: 4px 0 16px; padding: 12px 14px; border-radius: var(--dsw-radius-lg); background: var(--dsw-alias-bg-module-platform); font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }

/* ---- disclosure -------------------------------------------------------- */
.npdpx-disclosure { border-top: 1px solid var(--dsw-alias-border-l2); }
.npdpx-disclosureToggle { display: flex; align-items: center; gap: 8px; width: 100%; padding: 16px 0; border: 0; background: none; font: inherit; text-align: left; color: var(--dsw-alias-label-primary); cursor: pointer; }
.npdpx-disclosureTitle { flex: none; font-size: 14px; line-height: 22px; font-weight: 500; }
.npdpx-disclosureSummary { flex: 1; min-width: 0; text-align: right; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.npdpx-chevron { flex: none; width: 16px; height: 16px; color: var(--dsw-alias-label-caption); transition: transform .14s ease; }
.npdpx-disclosureToggle[aria-expanded="true"] .npdpx-chevron { transform: rotate(180deg); }
.npdpx-disclosureToggle:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; border-radius: var(--dsw-radius-sm); }
.npdpx-disclosureBody { display: flex; flex-direction: column; min-width: 0; padding-bottom: 8px; }
.npdpx-disclosureBody > .npdpx-row:first-child { padding-top: 0; }

/* ---- probe result ------------------------------------------------------ */
.npdpx-result { display: flex; flex-direction: column; gap: 2px; min-width: 0; padding: 10px 12px; border: .5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-sm); font-size: 12px; line-height: 18px; }
.npdpx-result[data-tone="success"] { border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 45%, transparent); }
.npdpx-result[data-tone="error"] { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent); }
.npdpx-result strong { font-weight: 500; color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }

/* ---- diagnostics -------------------------------------------------------- */
/* The read-only facts table is gone; only its actionable warnings remain. They sit
   directly under the status strip, so a refused bypass entry or a damaged settings
   file stays visible without opening a panel. */
.npdpx-notes { margin: 10px 0 0; padding-left: 18px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }

/* ---- notices (8% fill, 20% border of the semantic hue) ------------------ */
/* The notice sits between the last section and the commit row, so it is bounded by
   two hairlines: the section above ends flush on it and the footer's border-top
   starts flush under it (measured: 0px on both sides). It needs its own breathing
   room, and 16px on each side reproduces the page's 32px text-to-text rhythm
   (a section's 16px bottom padding + the 16px here). */
/* '.npdpx p' (0,1,1) zeroes every paragraph margin, so this rule needs at least the
   same weight or its own margins are silently dropped. */
.npdpx p.npdpx-notice { margin: 16px 0; padding: 8px 12px; border: .5px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 20%, transparent); border-radius: var(--dsw-radius-sm); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 8%, transparent); font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }
.npdpx p.npdpx-notice[data-tone="error"] { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 20%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent); }
.npdpx p.npdpx-notice[data-tone="success"] { border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 20%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 8%, transparent); }

/* ---- buttons ----------------------------------------------------------- */
.npdpx-btn { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; gap: 4px; height: 36px; padding: 0 14px; border: 0; border-radius: var(--dsw-radius-md); background: transparent; font: inherit; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-primary); cursor: pointer; }
.npdpx-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.npdpx-btn:disabled { opacity: .4; cursor: default; }
.npdpx-btn[data-outline="true"] { border: .5px solid var(--dsw-alias-border-l3); }
.npdpx-btn[data-sm="true"] { height: 28px; padding: 0 10px; border-radius: var(--dsw-radius-sm); font-size: 12px; line-height: 18px; }
.npdpx-btn[data-danger="true"] { color: var(--dsw-alias-state-error-primary); }
.npdpx-btn[data-danger="true"]:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger); }
.npdpx-btn:focus-visible, .npdpx-save:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }
.npdpx-save { padding: 5px 14px; border: 1px solid transparent; border-radius: var(--dsw-radius-md); background: var(--dsw-alias-label-primary); color: var(--dsw-alias-bg-layer-3); font: inherit; font-size: 13px; line-height: 1.5; cursor: pointer; }
.npdpx-save:hover:not(:disabled) { opacity: .9; }
.npdpx-save:disabled { opacity: .4; cursor: default; }

/* ---- footer ------------------------------------------------------------ */
.npdpx-footer { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; padding-top: 12px; border-top: 1px solid var(--dsw-alias-border-l2); }
.npdpx-footerText { flex: 1; min-width: 0; margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.npdpx-footerActions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

/* ---- loading ----------------------------------------------------------- */
.npdpx-loading { display: flex; flex-direction: column; gap: 10px; padding: 4px 0; }
.npdpx-skeleton { display: flex; flex-direction: column; gap: 8px; padding: 15px 14px; border: 1px solid var(--dsw-alias-settings-card-stroke); border-radius: var(--dsw-radius-xl); background: var(--dsw-alias-settings-card-fill); }
.npdpx-skeletonBar { width: 40%; height: 14px; border-radius: var(--dsw-radius-xs); background: var(--dsw-alias-bg-skeleton); }
.npdpx-skeletonBar + .npdpx-skeletonBar { width: 80%; height: 12px; }
@media (prefers-reduced-motion: no-preference) {
  .npdpx-skeletonBar { animation: npdpx-pulse 2s cubic-bezier(.36, 0, .64, 1) infinite; }
  @keyframes npdpx-pulse { 0% { opacity: 1 } 40% { opacity: .6 } 80%, 100% { opacity: 1 } }
}
@media (prefers-reduced-motion: reduce) {
  .npdpx-switch, .npdpx-switchThumb, .npdpx-segment, .npdpx-segmentIndicator, .npdpx-chevron { transition: none; }
}

/* ---- narrow containers (a dragged-narrow dialog, or 200% zoom) ---------- */
@container npd-proxy (max-width: 520px) {
  .npdpx-row { align-items: flex-start; }
  .npdpx-rowText { padding-right: 24px; }
  .npdpx-rowControl { align-self: center; }
  /* Five tabs cannot share a 300px row. Two columns keep every label whole and
     keep the group to three lines; the pill stops sliding and the selected cell
     carries the same soft surface instead. */
  .npdpx-segmented { grid-auto-flow: row; grid-auto-columns: auto; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .npdpx-segmentIndicator { display: none; }
  .npdpx-segment { height: 32px; padding: 0 10px; text-align: left; }
  .npdpx-segment[aria-selected="true"] { background: var(--dsw-alias-bg-layer-1); box-shadow: var(--dsw-elevation-soft); }
  .npdpx-fieldCols { grid-template-columns: minmax(0, 1fr); }
  .npdpx-footerActions { width: 100%; }
  .npdpx-footerActions > button { flex: 1 1 0; }
}
`

    const LOCALE_DICTS = {
      zh: {
        'group.title': '网络代理', 'group.desc': '管理 DSH 的网络连接，不修改系统代理。',
        'enable.label': '启用代理', 'enable.hint': '只控制 DSH 自身请求是否走代理。下方的会话提示词注入是独立开关，互不影响。',
        'applied.label': '当前生效', 'state.off': '未启用', 'state.proxied': '代理已启用',
        'state.direct': '强制直连', 'state.none': '未找到可用代理', 'state.error': '应用异常',
        'state.inherited': '未接管原有网络设置', 'state.pending': '未保存',
        'source.label': '代理来源',
        'mode.auto': '自动', 'mode.auto.desc': '依次使用自定义地址、系统代理、环境变量；取第一个可用来源。',
        'mode.system': '系统代理', 'mode.system.desc': '跟随 Windows Internet 设置；不支持 PAC 自动配置脚本。',
        'mode.custom': '自定义', 'mode.custom.desc': '使用填写的代理地址，支持 HTTP、HTTPS 和 SOCKS5。',
        'mode.env': '环境变量', 'mode.env.desc': '使用 DSH 进程中的 HTTP_PROXY、HTTPS_PROXY 或 ALL_PROXY。',
        'mode.direct': '直连', 'mode.direct.desc': '主动覆盖既有代理并直连；与关闭组件、保留原有设置不同。',
        'mode.off': '未启用', 'mode.none': '未配置',
        'address.label': '代理地址', 'address.auto': '优先使用的自定义地址（可选）',
        'address.placeholder': 'http://127.0.0.1:7890',
        'address.hint': '也可填写 socks5://127.0.0.1:1080；用户名和密码请在“代理认证”中配置。',
        'address.overrides': '已设置分协议地址，可在“高级设置”中查看。',
        'system.enabled': '上次读取：系统代理已开启', 'system.disabled': '上次读取：系统代理未开启',
        'system.unavailable': '当前运行时未提供系统代理信息。',
        'system.note': '保存并应用后会重新读取系统配置。',
        'env.note': '这里只读取环境变量，不写入或改变它们。',
        'auth.title': '代理认证', 'auth.optional': '按需配置', 'auth.stored': '密码已保存',
        'auth.unknown': '凭据状态未知', 'auth.checking': '正在读取凭据状态…',
        'auth.unavailable': '凭据库不可写。其他代理设置仍可正常编辑。',
        'auth.retry': '重新读取凭据状态', 'auth.username': '用户名', 'auth.password': '密码',
        'auth.userPlaceholder': '代理用户名', 'auth.passwordPlaceholder': '输入代理密码',
        'auth.keepPlaceholder': '已保存；留空保持不变',
        'auth.hint': '密码只写入 DSH 凭据库，不回显，不进入设置文件。点击底部按钮可一并保存和应用。',
        'auth.clear': '清除已存密码', 'auth.confirm': '清除后需保存并应用，现有连接才会使用更新后的凭据。',
        'auth.confirmButton': '确认清除', 'auth.cancel': '取消',
        'auth.pending': '凭据库已更新，代理配置尚未应用；请点击“保存并应用”。',
        'auth.partial': '密码已写入凭据库，但代理配置未应用成功。请重试保存。',
        'ai.title': '会话提示词与 Shell',
        'ai.summaryState': '注入：{injection} · Shell：{shell}', 'ai.on': '已开启', 'ai.off': '已关闭',
        'ai.prompt': '会话提示词注入', 'ai.promptHint': '独立于代理控制：只控制是否把当前网络状态写进会话提示词。代理未生效时，注入「未接管网络」的说明。',
        'prompt.preview': '实际注入的内容', 'prompt.refresh': '重新生成预览',
        'prompt.previewIdle': '展开此区域后会显示当前实际注入的完整提示词。',
        'prompt.previewDisabled': '「会话提示词注入」已关闭，因此不会注入任何内容。',
        'prompt.previewError': '无法获取预览：',
        'prompt.previewMeta': '共 {chars} 个字符；此条目为{required}。',
        'prompt.requiredYes': '必需项（精简预设也不会忽略）',
        'prompt.requiredNo': '可选项（可能被精简预设忽略）',
        'prompt.template': '自定义模板', 'prompt.templateHint': '留空则使用内置文案。支持下方占位符；未知占位符会原样保留，便于发现拼写错误。',
        'prompt.templatePlaceholder': '例如：\n{{proxy}}\n这条代理只覆盖本进程…',
        'prompt.templatePlaceholderGeneric': '例如：{{proxy}}（占位符需展开预览后才列出）',
        'prompt.placeholders': '可用占位符：', 'prompt.insertHint': '点击插入到模板末尾',
        'prompt.reset': '恢复内置文案',
        'shell.label': '提供给 Shell 的代理信息', 'shell.off': '不提供', 'shell.url': '仅地址（推荐）', 'shell.full': '地址与凭据',
        'shell.offHint': '命令环境不提供代理信息；上面的提示词开关独立生效。',
        'shell.urlHint': '命令按需显式使用代理地址。代理要求认证时，命令可能收到 407（代理需要认证）。',
        'shell.fullHint': '凭据可被命令读取，可能随输出进入日志或会话记录。仅在明确需要时选择。',
        'advanced.title': '高级设置', 'advanced.summary': '绕过地址 · 分协议代理 · 测试目标',
        'advanced.overrides': '已配置分协议代理',
        'bypass.label': '绕过代理的地址', 'bypass.placeholder': 'example.com, .internal, 10.0.0.1',
        'bypass.hint': '逗号分隔。localhost、127.0.0.1、::1 自动直连。10.*、<local> 等写法不支持。',
        'bypass.inherited': '当前来源使用自身的绕过列表；自定义绕过地址只用于自定义来源。',
        'split.title': '按目标协议指定代理（可选）',
        'split.hint': '覆盖上面的统一地址。留空沿用统一地址；这里的 HTTP / HTTPS 指目标请求类型。',
        'split.http': 'HTTP 请求使用', 'split.https': 'HTTPS 请求使用', 'split.placeholder': '留空沿用统一地址',
        'probe.url': '测试目标 URL', 'probe.urlHint': '只测试已保存配置，不会自动将未保存的修改用于测试。',
        'action.save': '保存并应用', 'action.saving': '正在应用…',
        'action.revert': '还原修改', 'action.probe': '测试已保存配置', 'action.probing': '正在测试…',
        'action.retry': '重试加载',
        'action.clean': '与已保存配置一致', 'action.dirty': '有未保存的修改',
        'status.loading': '正在读取代理设置…', 'error.status': '暂时无法读取设置。',
        'error.save': '未能保存并应用，修改已保留。', 'error.secret': '凭据库操作失败，配置未被重置。',
        'notice.saved': '已保存并应用。', 'validation.summary': '请检查标出的输入项后再保存。',
        'validation.proxy': '请输入有效的 HTTP、HTTPS 或 SOCKS5 代理地址。',
        'validation.required': '启用自定义代理前，请至少填写一个代理地址。',
        'validation.userinfo': '请勿在地址中填写用户名或密码，请使用“代理认证”。',
        'validation.endpoint': '代理地址只需协议、主机和端口，不应带路径、查询参数或片段。',
        'validation.username': '用户名不能包含冒号。', 'validation.authUser': '保存密码前请先填写用户名。',
        'validation.probe': '请输入不含用户名密码的完整 http:// 或 https:// 测试地址。',
        'probe.saveFirst': '请先保存并应用修改，再测试新配置。', 'probe.target': '测试目标：{url}',
        'probe.result': '测试结果', 'probe.ok': '收到 HTTP {status} · {ms} ms',
        'probe.failed': '请求失败：{error}', 'probe.httpError': '网络请求已返回，但目标响应 HTTP {status}。',
        'probe.route': 'Host 报告的路由：{route}', 'probe.direct': '直连 / 绕过代理',
        'state.inherited': '未接管 / 使用原有设置',
        // Host diagnostics are written in one fixed language so the file, the log
        // and this panel agree; the panel is bilingual, so the DISPLAY language is
        // chosen here. Unrecognised sentences fall through verbatim.
        'note.badUrl': '“{text}” 不是有效的代理地址。',
        'note.socks5h': 'Node 传输层不支持 socks5h://；请改用 socks5://，让代理端解析域名。',
        'note.socks4': '不支持 socks4://；请使用 http://、https:// 或 socks5://。',
        'note.socks4a': '不支持 socks4a://；请使用 http://、https:// 或 socks5://。',
        'note.onlySchemes': '只支持 http、https 和 socks5 代理。',
        'note.badScheme': '不支持 {scheme}:// 协议；请使用 http://、https:// 或 socks5://。',
        'note.noHost': '“{text}” 没有写明代理主机。',
        'note.pac': '检测到 PAC 自动配置脚本（AutoConfigURL）；不支持 PAC，已忽略。',
        'note.bypassDropped': '绕过地址“{entry}”无法用 Node 的代理匹配器表达，已丢弃。',
        'note.noSource': '所选来源没有配置代理地址，当前为直连。',
        'note.unreadable': '无法读取 {file}：{error}',
        'note.badJson': '{file} 不是合法的 JSON（{error}）；已改用默认设置。',
        'note.releaseFailed': '无法释放先前的代理设置：{error}',
        'warning.socks': 'SOCKS5 是当前运行时的实验特性。',
      },
      en: {
        'group.title': 'Network proxy', 'group.desc': 'Manage DSH connections without changing the system proxy.',
        'enable.label': 'Enable proxy', 'enable.hint': 'Controls only whether DSH’s own requests use the proxy. Session prompt injection below is an independent switch.',
        'applied.label': 'Applied now', 'state.off': 'Off', 'state.proxied': 'Proxy active',
        'state.direct': 'Forced direct', 'state.none': 'No proxy found', 'state.error': 'Application error',
        'state.inherited': 'Original network settings retained', 'state.pending': 'Unsaved',
        'source.label': 'Proxy source',
        'mode.auto': 'Auto', 'mode.auto.desc': 'Try the custom address, system proxy, then environment variables; the first usable source wins.',
        'mode.system': 'System', 'mode.system.desc': 'Follow Windows Internet settings. PAC scripts are not supported.',
        'mode.custom': 'Custom', 'mode.custom.desc': 'Use your own HTTP, HTTPS or SOCKS5 proxy endpoint.',
        'mode.env': 'Environment', 'mode.env.desc': 'Read HTTP_PROXY, HTTPS_PROXY or ALL_PROXY from the DSH process.',
        'mode.direct': 'Direct', 'mode.direct.desc': 'Override existing proxies with direct connections. Unlike turning the component off, this changes the original routing.',
        'mode.off': 'Off', 'mode.none': 'Not configured',
        'address.label': 'Proxy address', 'address.auto': 'Preferred custom address (optional)',
        'address.placeholder': 'http://127.0.0.1:7890',
        'address.hint': 'Also accepts socks5://127.0.0.1:1080. Enter user names and passwords under Authentication, not in the URL.',
        'address.overrides': 'Per-protocol addresses are set. See Advanced settings.',
        'system.enabled': 'Last read: system proxy enabled', 'system.disabled': 'Last read: system proxy disabled',
        'system.unavailable': 'This runtime did not provide system proxy information.',
        'system.note': 'Save & apply reads the system configuration again.',
        'env.note': 'Environment variables are read, never written or changed here.',
        'auth.title': 'Authentication', 'auth.optional': 'Optional', 'auth.stored': 'Password stored',
        'auth.unknown': 'Credential status unknown', 'auth.checking': 'Reading credential status…',
        'auth.unavailable': 'The credential store is not writable. Other proxy settings can still be edited.',
        'auth.retry': 'Retry credential status', 'auth.username': 'User name', 'auth.password': 'Password',
        'auth.userPlaceholder': 'Proxy user name', 'auth.passwordPlaceholder': 'Enter proxy password',
        'auth.keepPlaceholder': 'Stored; leave blank to keep',
        'auth.hint': 'Passwords go only to the DSH credential store, never back to the form or into settings files. Save & apply commits both.',
        'auth.clear': 'Clear stored password', 'auth.confirm': 'After clearing, use Save & apply to update the credentials used by connections.',
        'auth.confirmButton': 'Confirm clear', 'auth.cancel': 'Cancel',
        'auth.pending': 'The credential store changed, but routing has not been reapplied. Use Save & apply.',
        'auth.partial': 'The password was stored, but the proxy settings could not be applied. Retry saving.',
        'ai.title': 'Session prompt & shell',
        'ai.summaryState': 'Injection: {injection} · Shell: {shell}', 'ai.on': 'on', 'ai.off': 'off',
        'ai.prompt': 'Session prompt injection', 'ai.promptHint': 'Independent of proxy control: controls only whether the current network state is written into the session prompt. When no proxy is active, it injects a note that DSH’s original routing is in force.',
        'prompt.preview': 'What is actually injected', 'prompt.refresh': 'Regenerate preview',
        'prompt.previewIdle': 'Expand this section to see the exact prompt text currently injected.',
        'prompt.previewDisabled': '“Session prompt injection” is off, so nothing is injected.',
        'prompt.previewError': 'Could not fetch the preview: ',
        'prompt.previewMeta': '{chars} characters; this entry is {required}.',
        'prompt.requiredYes': 'required (lean presets cannot drop it)',
        'prompt.requiredNo': 'optional (lean presets may drop it)',
        'prompt.template': 'Custom template', 'prompt.templateHint': 'Leave empty to use the built-in wording. Placeholders below are supported; unknown ones stay literal so a typo is visible.',
        'prompt.templatePlaceholder': 'For example:\n{{proxy}}\nThis proxy covers this process only…',
        'prompt.templatePlaceholderGeneric': 'For example: {{proxy}} (placeholders appear after the preview loads)',
        'prompt.placeholders': 'Available placeholders:', 'prompt.insertHint': 'Insert at the end of the template',
        'prompt.reset': 'Restore built-in wording',
        'shell.label': 'Proxy information supplied to shells', 'shell.off': 'None', 'shell.url': 'Address only (recommended)', 'shell.full': 'Address and credentials',
        'shell.offHint': 'Do not supply proxy information to command environments. The prompt switch above is independent.',
        'shell.urlHint': 'Commands opt in using the address. An authenticated proxy may return 407 (proxy authentication required).',
        'shell.fullHint': 'Commands can read the credentials. Their output could expose them in logs or conversation history. Choose only when needed.',
        'advanced.title': 'Advanced settings', 'advanced.summary': 'Bypass · Per-protocol routing · Test target',
        'advanced.overrides': 'Per-protocol proxies configured',
        'bypass.label': 'Bypass proxy for', 'bypass.placeholder': 'example.com, .internal, 10.0.0.1',
        'bypass.hint': 'Comma separated. localhost, 127.0.0.1 and ::1 bypass automatically. Patterns such as 10.* and <local> are not supported.',
        'bypass.inherited': 'This source uses its own bypass list. Custom entries apply only to the custom source.',
        'split.title': 'Per-target-protocol proxy (optional)',
        'split.hint': 'Override the shared address above. Blank fields use the shared address; HTTP / HTTPS refer to the target request.',
        'split.http': 'For HTTP requests', 'split.https': 'For HTTPS requests', 'split.placeholder': 'Blank uses the shared address',
        'probe.url': 'Test target URL', 'probe.urlHint': 'Tests use saved settings only, never unsaved edits.',
        'action.save': 'Save & apply', 'action.saving': 'Applying…',
        'action.revert': 'Revert edits', 'action.probe': 'Test saved settings', 'action.probing': 'Testing…',
        'action.retry': 'Retry loading',
        'action.clean': 'Matches saved settings', 'action.dirty': 'Unsaved changes',
        'status.loading': 'Reading proxy settings…', 'error.status': 'Could not load the settings.',
        'error.save': 'Could not save and apply. Your edits are retained.', 'error.secret': 'Credential operation failed. Settings were not reset.',
        'notice.saved': 'Saved and applied.', 'validation.summary': 'Check the highlighted fields before saving.',
        'validation.proxy': 'Enter a valid HTTP, HTTPS or SOCKS5 proxy address.',
        'validation.required': 'Enter at least one proxy address before enabling Custom.',
        'validation.userinfo': 'Use Authentication for user names and passwords, not the address field.',
        'validation.endpoint': 'A proxy endpoint needs only a scheme, host and port, without a path, query or fragment.',
        'validation.username': 'A user name cannot contain a colon.', 'validation.authUser': 'Enter a user name before storing a password.',
        'validation.probe': 'Enter a complete http:// or https:// test URL without userinfo.',
        'probe.saveFirst': 'Save and apply your edits before testing the new settings.', 'probe.target': 'Test target: {url}',
        'probe.result': 'Test result', 'probe.ok': 'HTTP {status} received · {ms} ms',
        'probe.failed': 'Request failed: {error}', 'probe.httpError': 'The request returned, but the target answered HTTP {status}.',
        'probe.route': 'Route reported by Host: {route}', 'probe.direct': 'Direct / bypassed',
        'state.inherited': 'Not managed / original settings',
        // Host diagnostics are written in one fixed language so the file, the log
        // and this panel agree; the panel is bilingual, so the DISPLAY language is
        // chosen here. Unrecognised sentences fall through verbatim.
        'note.badUrl': '"{text}" is not a valid proxy URL.',
        'note.socks5h': 'The Node transport does not support socks5h://; use socks5:// so the proxy resolves the name.',
        'note.socks4': 'socks4:// is not supported; use http://, https:// or socks5://.',
        'note.socks4a': 'socks4a:// is not supported; use http://, https:// or socks5://.',
        'note.onlySchemes': 'Only http, https and socks5 proxies are supported.',
        'note.badScheme': 'The {scheme}:// scheme is not supported; use http://, https:// or socks5://.',
        'note.noHost': '"{text}" names no proxy host.',
        'note.pac': 'A PAC script (AutoConfigURL) is configured; PAC is not supported and was ignored.',
        'note.bypassDropped': 'The bypass entry "{entry}" cannot be expressed by the Node proxy matcher and was dropped.',
        'note.noSource': 'No proxy is configured for the selected source; connecting directly.',
        'note.unreadable': 'Could not read {file}: {error}',
        'note.badJson': '{file} is not valid JSON ({error}); using defaults.',
        'note.releaseFailed': 'The previous proxy could not be released: {error}',
        'warning.socks': 'SOCKS5 is experimental in the current runtime.',
      },
    }

    function fallbackT(key, params = {}) {
      return String(LOCALE_DICTS.zh[key] ?? key).replace(/\{(\w+)\}/g, (match, name) => params[name] ?? match)
    }

    /* ---------------------------------------------------------------- *
     * Host diagnostics.
     *
     * The Host writes its notes in one fixed language so that the settings
     * file, the log and this panel all say the same thing. The panel is
     * bilingual, so the DISPLAY language is decided here: every known
     * sentence maps to a locale key, and anything unrecognised (a newer
     * Host, or an OS error passed through) is shown verbatim rather than
     * being dropped — an untranslated line still beats a missing one.
     * ---------------------------------------------------------------- */
    const NOTE_PATTERNS = [
      [/^"([\s\S]+)" is not a valid proxy URL$/, 'note.badUrl', (m) => ({ text: m[1] })],
      [/^socks5h:\/\/ is not supported/, 'note.socks5h', null],
      [/^socks4:\/\/ is not supported/, 'note.socks4', null],
      [/^socks4a:\/\/ is not supported/, 'note.socks4a', null],
      [/^only http, https and socks5 proxies are supported$/, 'note.onlySchemes', null],
      [/^the ([\s\S]+?)\/\/ scheme is not supported/, 'note.badScheme', (m) => ({ scheme: m[1] })],
      [/^"([\s\S]+)" names no proxy host$/, 'note.noHost', (m) => ({ text: m[1] })],
      [/^a PAC script \(AutoConfigURL\) is configured/, 'note.pac', null],
      [/^bypass entry "([\s\S]+)" cannot be expressed/, 'note.bypassDropped', (m) => ({ entry: m[1] })],
      [/^no proxy is configured for the selected source/, 'note.noSource', null],
      [/^could not read ([\s\S]+): ([\s\S]+)$/, 'note.unreadable', (m) => ({ file: m[1], error: m[2] })],
      [/^([\s\S]+) is not valid JSON \(([\s\S]+)\); using defaults$/, 'note.badJson', (m) => ({ file: m[1], error: m[2] })],
      [/^the previous proxy could not be released: ([\s\S]+)$/, 'note.releaseFailed', (m) => ({ error: m[1] })],
    ]

    /**
     * Render one Host diagnostic in the panel's current language.
     *
     * @param text - the Host's own sentence.
     * @param t - the translator in force for this render.
     * @returns the localized sentence, or `text` unchanged when unrecognised.
     */
    function localizeNote(text, t) {
      const value = String(text ?? '')
      for (const [pattern, key, params] of NOTE_PATTERNS) {
        const match = pattern.exec(value)
        if (match) return t(key, params === null ? {} : params(match))
      }
      return value
    }

    /* ---------------------------------------------------------------- *
     * Controls. Each one copies the measured recipe rather than a variant
     * of it: the same heights, radii and tokens as the shipped pages.
     * ---------------------------------------------------------------- */

    /** A button in the page's own three weights. */
    function Button({ children, outline, small, danger, ...props }) {
      return h('button', {
        type: 'button', className: 'npdpx-btn',
        'data-outline': outline ? 'true' : undefined,
        'data-sm': small ? 'true' : undefined,
        'data-danger': danger ? 'true' : undefined,
        ...props,
      }, children)
    }

    /** 36x20 switch: the track turns brand-primary, the thumb translates 16px. */
    function Switch({ id, checked, disabled, labelledBy, describedBy, onChange }) {
      return h('button', {
        id, type: 'button', className: 'npdpx-switch', role: 'switch',
        'aria-checked': checked, 'aria-labelledby': labelledBy,
        'aria-describedby': describedBy, disabled,
        onClick: () => onChange(!checked),
      }, h('span', { className: 'npdpx-switchThumb', 'aria-hidden': true }))
    }

    /**
     * A row: title and description on the left, one control cluster on the right.
     *
     * The text column keeps a 48px right inset instead of using space-between: a
     * long description then wraps inside its own column instead of running under
     * the control, while the control stays optically close. `wide` moves the
     * control under the text for content that needs the full column.
     */
    function Row({ id, title, desc, control, wide, align, continued }) {
      const titleId = id + '-title'
      const descId = desc ? id + '-desc' : undefined
      const attrs = {
        className: 'npdpx-row',
        'data-align': wide ? 'stack' : align === 'start' ? 'start' : undefined,
        'data-continued': continued ? 'true' : undefined,
      }
      return h('div', attrs,
        h('div', { className: 'npdpx-rowText' },
          h('span', { id: titleId, className: 'npdpx-rowTitle' }, title),
          desc ? h('span', { id: descId, className: 'npdpx-rowDesc' }, desc) : null),
        h('div', { className: 'npdpx-rowControl' }, control({ titleId, descId })),
      )
    }

    /**
     * A full-width multi-line field with a title and description, for content that
     * needs the whole column. Separate from {@link Field} because the label belongs
     * above an editor, not beside it.
     */
    function TextAreaRow({ id, title, desc, value, placeholder, rows = 4, mono, disabled, onChange }) {
      const descId = desc ? id + '-desc' : undefined
      return h('div', { className: 'npdpx-textAreaRow' },
        h('label', { className: 'npdpx-label', htmlFor: id }, title),
        desc ? h('p', { id: descId, className: 'npdpx-hint' }, desc) : null,
        h('textarea', {
          id,
          rows,
          className: 'npdpx-textarea' + (mono ? ' npdpx-mono' : ''),
          value, placeholder, disabled, spellCheck: false,
          'aria-describedby': descId,
          onChange: (event) => onChange(event.target.value),
        }),
      )
    }

    /** A boolean preference: the row title is the switch's accessible name. */
    function SwitchRow({ id, title, desc, checked, disabled, onChange }) {
      return h(Row, {
        id, title, desc,
        control: ({ titleId, descId }) => h(Switch, {
          id, checked, disabled, labelledBy: titleId, describedBy: descId, onChange,
        }),
      })
    }

    /** A form field: 13/1.5 label, 34px input on layer-3, hint beneath. */
    function Field({ id, label, hint, error, value, onChange, disabled, type = 'text', placeholder, textarea, mono }) {
      const hintId = hint ? id + '-hint' : undefined
      const errorId = error ? id + '-error' : undefined
      const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined
      return h('div', { className: 'npdpx-field' },
        h('label', { className: 'npdpx-fieldLabel', htmlFor: id }, label),
        h(textarea ? 'textarea' : 'input', {
          id, type: textarea ? undefined : type, rows: textarea ? 3 : undefined,
          className: (textarea ? 'npdpx-textarea' : 'npdpx-input') + (mono ? ' npdpx-mono' : ''),
          value, disabled, placeholder, spellCheck: false,
          autoComplete: type === 'password' ? 'new-password' : 'off',
          'aria-invalid': error ? true : undefined, 'aria-describedby': describedBy,
          onChange: (event) => onChange(event.target.value),
        }),
        error ? h('p', { id: errorId, className: 'npdpx-error', role: 'alert' }, error) : null,
        hint ? h('p', { id: hintId, className: 'npdpx-hint' }, hint) : null,
      )
    }

    /**
     * Segmented control: the shipped 28px-tab recipe with its sliding pill.
     *
     * Native radios would be simpler, but the page's own mode control is this
     * widget, so the block uses it and keeps the tablist keyboard contract:
     * Arrow/Home/End move the selection and only the selected tab is tabbable.
     */
    function Segmented({ id, label, value, options, disabled, onChange }) {
      const index = Math.max(0, options.findIndex((option) => option.value === value))
      const ref = useRef(null)
      const move = (event, from) => {
        let next = null
        if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (from + options.length - 1) % options.length
        else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (from + 1) % options.length
        else if (event.key === 'Home') next = 0
        else if (event.key === 'End') next = options.length - 1
        if (next === null) return
        event.preventDefault()
        const option = options[next]
        if (option === undefined) return
        const tabs = ref.current?.querySelectorAll('[role="tab"]')
        const node = tabs?.[next]
        if (node && typeof node.focus === 'function') node.focus()
        onChange(option.value)
      }
      return h('div', {
        ref, className: 'npdpx-segmented', role: 'tablist', 'aria-label': label,
        style: { '--npdpx-count': String(options.length), '--npdpx-index': String(index) },
      },
        h('span', { className: 'npdpx-segmentIndicator', 'aria-hidden': true }),
        options.map((option, position) => h('button', {
          key: option.value, id: id + '-' + option.value, type: 'button', role: 'tab',
          className: 'npdpx-segment',
          'aria-selected': option.value === value,
          tabIndex: option.value === value ? 0 : -1,
          disabled,
          onClick: () => onChange(option.value),
          onKeyDown: (event) => move(event, position),
        }, option.label)),
      )
    }

    /** A disclosure whose summary states what is inside, so collapsing loses nothing. */
    function Disclosure({ id, title, summary, open, onToggle, children }) {
      return h('section', { className: 'npdpx-disclosure' },
        h('h4', null, h('button', {
          type: 'button', id: id + '-toggle', className: 'npdpx-disclosureToggle',
          'aria-expanded': open, 'aria-controls': id + '-panel', onClick: onToggle,
        },
        h('span', { className: 'npdpx-disclosureTitle' }, title),
        h('span', { className: 'npdpx-disclosureSummary' }, summary),
        h('svg', {
          className: 'npdpx-chevron', viewBox: '0 0 16 16', 'aria-hidden': true, focusable: false,
        }, h('path', {
          d: 'M4 6l4 4 4-4', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5,
          strokeLinecap: 'round', strokeLinejoin: 'round',
        })))),
        h('div', { id: id + '-panel', hidden: !open, role: 'region', 'aria-labelledby': id + '-toggle' },
          open ? h('div', { className: 'npdpx-disclosureBody' }, children) : null),
      )
    }

    /** Skeletons, only while the first status reply is in flight. */
    function Loading() {
      return h('div', { className: 'npdpx-loading', 'aria-busy': true },
        h('div', { className: 'npdpx-skeleton' },
          h('span', { className: 'npdpx-skeletonBar' }), h('span', { className: 'npdpx-skeletonBar' })),
        h('div', { className: 'npdpx-skeleton' },
          h('span', { className: 'npdpx-skeletonBar' }), h('span', { className: 'npdpx-skeletonBar' })),
      )
    }

    /** The applied-state strip: a status region, never a control. */
    function StatusStrip({ applied, source, endpoint, active, direct, pending }) {
      return h('div', { className: 'npdpx-status', role: 'status' },
        h('span', { className: 'npdpx-dot', 'data-tone': applied.tone, 'aria-hidden': true }),
        h('span', { className: 'npdpx-stateWord' }, applied.label),
        active ? h('span', { className: 'npdpx-tag' }, source) : null,
        h('span', { className: 'npdpx-statusEnd', title: endpoint }, direct ? direct : endpoint),
        pending ? h('span', { className: 'npdpx-tag', 'data-tone': 'warn' }, pending) : null,
      )
    }

    /** One Settings-page block, never a second page or an independent app shell. */
    function GroupBlock(props) {
      const t = typeof props?.t === 'function' ? props.t : fallbackT
      const modelRef = useRef(undefined)
      if (modelRef.current === undefined) modelRef.current = createSettingsModel()
      const model = modelRef.current
      const [state, setState] = useState(model.getSnapshot)
      const [expanded, setExpanded] = useState({ auth: false, ai: false, advanced: false })
      const [confirmClear, setConfirmClear] = useState(false)
      const formRef = useRef(null)
      useEffect(() => {
        const unsubscribe = model.subscribe(setState)
        void model.start()
        return () => { unsubscribe(); model.stop() }
      }, [model])
      const toggle = (key) => {
        setExpanded((old) => {
          const next = { ...old, [key]: !old[key] }
          // Opening the AI section is the moment the preview becomes useful, and the
          // model snapshot is not live-updated, so fetch it once on first open.
          if (key === 'ai' && next.ai === true && model.getSnapshot().promptPreview === null) {
            void model.previewPrompt()
          }
          return next
        })
      }
      const save = async () => {
        await model.save()
        const errors = model.getSnapshot().errors
        if (errors.authUser) setExpanded((old) => ({ ...old, auth: true }))
        if (errors.httpProxy || errors.httpsProxy || errors.probeUrl) setExpanded((old) => ({ ...old, advanced: true }))
      }
      useEffect(() => {
        if (Object.keys(state.errors).length) {
          const invalid = formRef.current?.querySelector('[aria-invalid="true"]')
          if (invalid && typeof invalid.focus === 'function') invalid.focus()
        }
      }, [state.errors, expanded.auth, expanded.advanced])

      const dirty = hasChanges(state)
      const busy = state.operation !== null
      const notice = state.notice
      const noticeNode = notice
        ? h('p', {
          className: 'npdpx-notice',
          role: notice.tone === 'error' ? 'alert' : 'status',
          'data-tone': notice.tone,
        }, t(notice.key), notice.detail ? ' ' + safeText(notice.detail) : '')
        : null

      let content
      if (state.phase === 'loading') {
        content = h(Loading)
      } else if (state.phase === 'error') {
        content = h('div', { className: 'npdpx-loading' },
          h('p', { className: 'npdpx-error', role: 'alert' },
            t('error.status'), notice?.detail ? ' ' + safeText(notice.detail) : ''),
          h(Button, { outline: true, small: true, onClick: () => model.refresh() }, t('action.retry')))
      } else {
        const { draft, status, credential } = state
        const policy = status.policy ?? {}
        const applied = { ...appliedState(status), label: t(appliedState(status).key) }
        const custom = usesCustom(draft.mode)
        const overrides = !!(draft.httpProxy || draft.httpsProxy)
        const endpoint = policy.active
          ? safeText(policy.httpsProxy ?? policy.httpProxy)
          : t('state.inherited')
        const knownSource = MODES.some(({ value }) => value === policy.source)
          ? t('mode.' + policy.source)
          : t('state.inherited')
        const credentialSummary = state.credentialPending
          ? t('state.pending')
          : credential.phase === 'ready'
            ? (credential.configured ? t('auth.stored') : t('auth.optional'))
            : (credential.phase === 'loading' ? t('auth.checking') : t('auth.unknown'))
        // The old read-only "Runtime details" panel held these warnings under a
        // table of facts. The table is gone, but silently dropping a refused bypass
        // entry or a damaged settings file would hide the reason routing or the form
        // does not look the way the user expects. Keep only the warnings, as a
        // compact list that appears when there is something to say.
        const warnings = [...new Set([
          ...(policy.notes ?? []),
          ...(status.diagnostics ?? []),
          status.lastError,
          policy.experimental ? t('warning.socks') : undefined,
        ].filter(Boolean))]
        const field = (key, label, options = {}) => h(Field, {
          key, id: 'npdpx-' + key, label, value: draft[key], disabled: busy,
          onChange: (value) => model.patch(key, value),
          error: state.errors[key] ? t(state.errors[key]) : undefined,
          ...options,
        })
        const result = state.probe
        const resultGood = result?.ok === true && result.status >= 200 && result.status < 400
        const sourceOptions = MODES.map((mode) => ({ value: mode.value, label: t(mode.label) }))
        const shellOptions = SHELL_EXPOSURES.map((option) => ({ value: option.value, label: t(option.label) }))
        const aiSummary = t('ai.summaryState', {
          injection: draft.promptInjection ? t('ai.on') : t('ai.off'),
          shell: t('shell.' + draft.exposeToShell),
        })
        const promptPreview = state.promptPreview
        const promptPreviewNode = promptPreview?.error
          ? h('p', { className: 'npdpx-error', role: 'alert' }, t('prompt.previewError'), ' ', safeText(promptPreview.error))
          : promptPreview === null || promptPreview === undefined
            ? h('p', { className: 'npdpx-hint' }, t('prompt.previewIdle'))
            : promptPreview.reason !== 'rendered'
              // Injection off is the only empty case now; an inactive proxy still has
              // a notice, so an empty preview no longer needs a second explanation.
              ? h('p', { className: 'npdpx-hint' }, t('prompt.previewDisabled'))
              : h('div', { className: 'npdpx-preview' },
                h('pre', { className: 'npdpx-previewText' }, safeText(promptPreview.text)),
                h('p', { className: 'npdpx-hint' }, t('prompt.previewMeta', {
                  chars: String(promptPreview.text.length),
                  required: promptPreview.required === true ? t('prompt.requiredYes') : t('prompt.requiredNo'),
                })))

        content = h('form', {
          ref: formRef,
          noValidate: true,
          onSubmit: (event) => { event.preventDefault(); void save() },
        },
          h(StatusStrip, {
            applied,
            source: knownSource,
            endpoint,
            active: policy.active === true,
            direct: policy.source === 'direct' ? t('mode.direct.desc') : null,
            pending: dirty ? t('state.pending') : null,
          }),

          warnings.length
            ? h('ul', { className: 'npdpx-notes', 'aria-live': 'polite' },
              warnings.map((warning, index) => h('li', { key: index }, safeText(localizeNote(warning, t)))))
            : null,

          h('div', { className: 'npdpx-section' },
            h(SwitchRow, {
              id: 'npdpx-enabled',
              title: t('enable.label'),
              desc: t('enable.hint'),
              checked: draft.enabled,
              disabled: busy,
              onChange: (value) => model.patch('enabled', value),
            }),
            // The source row OWNS whatever details follow it — the address field for
            // auto/custom, the status panel for system/env — so it declares itself
            // continued in every mode that renders one: no hairline under it, and the
            // detail hangs off the segmented control as one unit. direct has no
            // details, so it keeps the ordinary row separator.
            h(Row, {
              id: 'npdpx-source',
              title: t('source.label'),
              desc: t('mode.' + draft.mode + '.desc'),
              wide: true,
              continued: draft.mode !== 'direct',
              control: () => h(Segmented, {
                id: 'npdpx-mode',
                label: t('source.label'),
                value: draft.mode,
                options: sourceOptions,
                disabled: busy,
                onChange: (value) => model.patch('mode', value),
              }),
            }),
            // The address is the source row's own detail, so it is marked continued too:
            // no hairline between the segmented control and the field it configures.
            custom
              ? h('div', { className: 'npdpx-fields', 'data-continued': 'true' },
                field('proxy', t(draft.mode === 'auto' ? 'address.auto' : 'address.label'), {
                  placeholder: t('address.placeholder'),
                  mono: true,
                  hint: t('address.hint'),
                }),
                overrides ? h('p', { className: 'npdpx-warning' }, t('address.overrides')) : null)
              : null,
            draft.mode === 'system'
              ? h('div', { className: 'npdpx-nested' },
                h('p', null, t(status.system
                  ? (status.system.enabled ? 'system.enabled' : 'system.disabled')
                  : 'system.unavailable')),
                status.system?.server ? h('p', { className: 'npdpx-mono' }, safeText(status.system.server)) : null,
                h('p', { className: 'npdpx-hint' }, t('system.note')))
              : null,
            draft.mode === 'env'
              ? h('div', { className: 'npdpx-nested' }, h('p', null, t('env.note')))
              : null,
          ),

          draft.mode !== 'direct'
            ? h(Disclosure, {
              id: 'npdpx-auth',
              title: t('auth.title'),
              summary: credentialSummary,
              open: expanded.auth,
              onToggle: () => toggle('auth'),
            },
              credential.phase === 'error' || credential.phase === 'unavailable'
                ? h('div', { className: 'npdpx-fields' },
                  h('p', { className: 'npdpx-warning' }, t('auth.unavailable')),
                  h(Button, {
                    outline: true, small: true, disabled: busy,
                    onClick: () => model.readCredential(),
                  }, t('auth.retry')))
                : null,
              h('div', { className: 'npdpx-fieldCols' },
                field('authUser', t('auth.username'), { placeholder: t('auth.userPlaceholder') }),
                h(Field, {
                  id: 'npdpx-password',
                  type: 'password',
                  label: t('auth.password'),
                  value: state.secret,
                  disabled: busy || !credential.writable,
                  placeholder: t(credential.configured ? 'auth.keepPlaceholder' : 'auth.passwordPlaceholder'),
                  hint: t('auth.hint'),
                  onChange: (value) => model.setSecret(value),
                })),
              credential.configured && !confirmClear
                ? h('div', { className: 'npdpx-fields' },
                  h(Button, {
                    small: true, danger: true, disabled: busy || !credential.writable,
                    onClick: () => setConfirmClear(true),
                  }, t('auth.clear')))
                : null,
              confirmClear
                ? h('div', { className: 'npdpx-fields' },
                  h('p', { className: 'npdpx-warning' }, t('auth.confirm')),
                  h('div', { className: 'npdpx-footerActions' },
                    h(Button, {
                      small: true, danger: true, disabled: busy,
                      onClick: async () => { if (await model.clearPassword()) setConfirmClear(false) },
                    }, t('auth.confirmButton')),
                    h(Button, { small: true, disabled: busy, onClick: () => setConfirmClear(false) }, t('auth.cancel'))))
                : null,
            )
            : null,

          h(Disclosure, {
            id: 'npdpx-ai',
            title: t('ai.title'),
            summary: aiSummary,
            open: expanded.ai,
            onToggle: () => toggle('ai'),
          },
            h(SwitchRow, {
              id: 'npdpx-prompt',
              title: t('ai.prompt'),
              desc: t('ai.promptHint'),
              checked: draft.promptInjection,
              disabled: busy,
              onChange: (value) => model.patch('promptInjection', value),
            }),
            h(Row, {
              id: 'npdpx-shell',
              title: t('shell.label'),
              desc: t('shell.' + draft.exposeToShell + 'Hint'),
              wide: true,
              control: () => h(Segmented, {
                id: 'npdpx-shell-seg',
                label: t('shell.label'),
                value: draft.exposeToShell,
                options: shellOptions,
                disabled: busy,
                onChange: (value) => model.patch('exposeToShell', value),
              }),
            }),
            // The preview is the point of the whole section: the user must be able to
            // read the EXACT text the model receives, and to change it. Shown from the
            // Host's own renderer, so what is displayed cannot drift from what is sent.
            h('div', { className: 'npdpx-promptSection' },
              h('div', { className: 'npdpx-promptHead' },
                h('p', { className: 'npdpx-label' }, t('prompt.preview')),
                h(Button, {
                  small: true,
                  disabled: busy || state.promptPreview?.pending === true,
                  onClick: () => model.previewPrompt(),
                }, t('prompt.refresh'))),
              promptPreviewNode,
              h(TextAreaRow, {
                id: 'npdpx-prompt-template',
                title: t('prompt.template'),
                desc: t('prompt.templateHint'),
                value: draft.promptTemplate,
                placeholder: promptPreview?.facts
                  ? t('prompt.templatePlaceholder')
                  : t('prompt.templatePlaceholderGeneric'),
                rows: 6,
                mono: true,
                disabled: busy,
                onChange: (value) => model.patch('promptTemplate', value),
              }),
              promptPreview?.placeholders?.length > 0
                ? h('div', { className: 'npdpx-placeholders' },
                  h('span', { className: 'npdpx-hint' }, t('prompt.placeholders')),
                  promptPreview.placeholders.map((name) =>
                    h('button', {
                      key: name,
                      type: 'button',
                      className: 'npdpx-chip',
                      disabled: busy,
                      title: t('prompt.insertHint'),
                      // Inserting a known placeholder is the whole affordance: a user
                      // should not have to memorise the names or their spelling.
                      onClick: () => model.patch('promptTemplate',
                        `${draft.promptTemplate}${draft.promptTemplate === '' || draft.promptTemplate.endsWith('\n') ? '' : '\n'}{{${name}}}`),
                    }, `{{${name}}}`)))
                : null,
              h('div', { className: 'npdpx-footerActions' },
                h(Button, {
                  small: true,
                  disabled: busy || draft.promptTemplate === '',
                  onClick: () => model.patch('promptTemplate', ''),
                }, t('prompt.reset'))),
            ),
          ),

          h(Disclosure, {
            id: 'npdpx-advanced',
            title: t('advanced.title'),
            summary: overrides ? t('advanced.overrides') : t('advanced.summary'),
            open: expanded.advanced,
            onToggle: () => toggle('advanced'),
          },
            custom
              ? h('div', { className: 'npdpx-fields' },
                field('noProxy', t('bypass.label'), {
                  textarea: true, mono: true,
                  placeholder: t('bypass.placeholder'),
                  hint: t('bypass.hint'),
                }),
                h('p', { className: 'npdpx-fieldLabel' }, t('split.title')),
                h('div', { className: 'npdpx-fieldCols' },
                  field('httpProxy', t('split.http'), { mono: true, placeholder: t('split.placeholder') }),
                  field('httpsProxy', t('split.https'), { mono: true, placeholder: t('split.placeholder') })),
                h('p', { className: 'npdpx-hint' }, t('split.hint')))
              : h('div', { className: 'npdpx-fields' },
                h('p', { className: 'npdpx-hint' }, t('bypass.inherited'))),
            h('div', { className: 'npdpx-fields' },
              field('probeUrl', t('probe.url'), { mono: true, hint: t('probe.urlHint') })),
            h('div', { className: 'npdpx-fields' },
              h('div', { className: 'npdpx-footer' },
                h('p', { className: 'npdpx-footerText' },
                  t(dirty ? 'probe.saveFirst' : 'probe.target', { url: safeText(status.settings.probeUrl) })),
                h(Button, {
                  outline: true, small: true, disabled: busy || dirty,
                  'aria-describedby': 'npdpx-probe-result',
                  onClick: () => model.probe(),
                }, t(state.operation === 'probing' ? 'action.probing' : 'action.probe'))),
              h('div', { id: 'npdpx-probe-result', role: 'status', 'aria-live': 'polite' },
                result
                  ? h('div', {
                    className: 'npdpx-result',
                    'data-tone': resultGood ? 'success' : 'error',
                  },
                    h('strong', null, result.ok
                      ? t('probe.ok', { status: result.status, ms: result.elapsedMs })
                      : t('probe.failed', { error: safeText(result.error) })),
                    result.ok && !resultGood
                      ? h('p', { className: 'npdpx-warning' }, t('probe.httpError', { status: result.status }))
                      : null,
                    result.route
                      ? h('p', { className: 'npdpx-hint' }, t('probe.route', {
                        route: result.route.proxied
                          ? safeText(result.route.proxy)
                          : (result.route.source === 'off' || result.route.source === 'none'
                            ? t('state.inherited')
                            : t('probe.direct')),
                      }))
                      : null)
                  : null),
            ),
          ),

          noticeNode,

          h('div', { className: 'npdpx-footer' },
            h('p', { className: 'npdpx-footerText', role: 'status' },
              t(dirty ? 'action.dirty' : 'action.clean')),
            h('div', { className: 'npdpx-footerActions' },
              h(Button, {
                disabled: busy || !dirty,
                onClick: () => { model.revert(); setConfirmClear(false) },
              }, t('action.revert')),
              // The form's commit button: inverted label, and dead until there is
              // something to commit.
              h('button', {
                type: 'button',
                className: 'npdpx-save',
                disabled: busy || !dirty,
                onClick: () => void save(),
              }, t(state.operation === 'saving' ? 'action.saving' : 'action.save')))),
        )
      }

      // The form ends with its commit row; the compact warning list, when present,
      // sits above the form so a refusal is visible without opening a panel.
      const body = h('div', { className: 'npdpx' },
        h('style', { 'data-notpdpton-proxy': 'styles' }, CSS),
        content,
      )
      return typeof props?.Group === 'function'
        ? props.Group({
          t,
          title: t('group.title'),
          desc: t('group.desc'),
          items: [],
          fields: [],
          body,
        })
        : null
    }

    return {
      // Credentials enhance the form; their absence must never hide basic settings.
      inject: ['slots', 'locale'],
      proxySettings: { MODES, SHELL_EXPOSURES, PASSWORD_REF, ROUTE_PATH },
      proxyUi: { createSettingsModel, settingsOf, sameSettings, hasChanges, appliedState, validateDraft, safeText, routeCredentials },
      groupBlock: GroupBlock,
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, LOCALE_DICTS), 'notpdpton-proxy: dictionaries')
        // No `remote`/`remote.credentials` here on purpose: the credential seam for
        // this block is the Host route, so the block still works in a runtime whose
        // client half cannot reach the generated Remote namespace.
        ctx.slots.inject(GROUP_SLOT, () => ctx.slots.register({
          name: GROUP_SLOT, id: 'networkProxy', order: 20, locale: NS,
        }, GroupBlock))
      },
    }
  },
})
