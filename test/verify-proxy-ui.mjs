/**
 * Proxy form interaction regressions. Tests the shipped observable model with
 * deterministic Host/credential adapters; it neither renders a fake page nor
 * claims to verify the live page's appearance. No network or profile writes.
 *
 * Run: node test/verify-proxy-ui.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../proxy/client.js', import.meta.url), 'utf8')
let captured
let fakeFetch = async () => { throw new Error('Unexpected network request') }
new Function('window', 'fetch', source)(
  { __ModuleLoader__: { load(entry) { captured = entry } } },
  (...args) => fakeFetch(...args),
)
const client = captured.factory((name) => {
  assert.equal(name, 'react')
  // Pure-model tests do not invoke React. This is a module dependency stand-in,
  // not a renderer, browser emulator or screenshot substitute.
  return {}
})
const { createSettingsModel, settingsOf, hasChanges, sameSettings, validateDraft, appliedState, safeText } = client.proxyUi
const REF = client.proxySettings.PASSWORD_REF
let total = 0
async function test(name, run) {
  await run()
  total++
  console.log(`  ok   ${name}`)
}
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function status(settings = {}, patch = {}) {
  return {
    settings: settingsOf(settings),
    policy: { source: 'off', active: false, noProxy: 'localhost,127.0.0.1,::1,[::1]', entries: [], unsupported: [], notes: [] },
    transport: { kind: 'native', covers: 'fetch and node:http(s)' },
    ...patch,
  }
}
function server(settings = {}) {
  const calls = []
  let stored = status(settings)
  return {
    calls,
    get stored() { return stored },
    set stored(value) { stored = value },
    async request(endpoint, payload, signal) {
      calls.push({ endpoint, payload, signal })
      if (endpoint === 'status') return { ok: true, value: stored }
      if (endpoint === 'save') {
        stored = status(payload.settings)
        return { ok: true, value: stored }
      }
      if (endpoint === 'probe') return { ok: true, value: { ok: true, status: 204, elapsedMs: 12, route: { source: 'off', proxied: false } } }
      throw new Error(`Unexpected endpoint ${endpoint}`)
    },
  }
}
function store(configured = false) {
  const calls = []
  return {
    calls, configured, writable: true,
    async describe(refs) {
      calls.push(['describe', ...refs])
      return { ok: true, value: { [REF]: { configured: this.configured, writable: this.writable } } }
    },
    async set(ref, value) { calls.push(['set', ref, value]); this.configured = true; return { ok: true } },
    async unset(ref) { calls.push(['unset', ref]); this.configured = false; return { ok: true } },
  }
}
async function mounted(settings, credentials) {
  const host = server(settings)
  const model = createSettingsModel({ request: host.request, credentials })
  await model.start()
  return { host, model }
}

console.log('-- loading and draft ownership')
await test('no settings are fabricated or saved before the first status reply', async () => {
  const wait = deferred()
  const calls = []
  const model = createSettingsModel({ request: (...args) => { calls.push(args); return wait.promise } })
  const running = model.start()
  assert.equal(model.getSnapshot().phase, 'loading')
  assert.equal(model.getSnapshot().draft, undefined)
  assert.equal(calls[0][0], 'status')
  wait.resolve({ ok: true, value: status() })
  await running
  assert.equal(model.getSnapshot().phase, 'ready')
  assert.equal(hasChanges(model.getSnapshot()), false)
  assert.equal(calls.length, 1)
  model.stop()
})
await test('load failure is visible and retry can recover', async () => {
  let tries = 0
  const model = createSettingsModel({ request: async () => {
    if (++tries === 1) throw new Error('HTTP 503')
    return { ok: true, value: status() }
  } })
  await model.start()
  assert.equal(model.getSnapshot().phase, 'error')
  assert.equal(model.getSnapshot().notice.key, 'error.status')
  assert.match(model.getSnapshot().notice.detail, /503/)
  assert.equal(await model.refresh(), true)
  assert.equal(model.getSnapshot().phase, 'ready')
  model.stop()
})
await test('malformed status cannot become an editable defaults form', async () => {
  const model = createSettingsModel({ request: async () => ({ ok: true, value: {} }) })
  await model.start()
  assert.equal(model.getSnapshot().phase, 'error')
  assert.equal(model.getSnapshot().draft, undefined)
  model.stop()
})
await test('refreshing applied state preserves unsaved addresses and user names', async () => {
  const { model, host } = await mounted({ mode: 'custom', proxy: 'http://old:7890' })
  model.patch('proxy', 'http://new:7890')
  model.patch('authUser', 'alice')
  await model.refresh()
  assert.equal(model.getSnapshot().draft.proxy, 'http://new:7890')
  assert.equal(model.getSnapshot().draft.authUser, 'alice')
  assert.equal(model.getSnapshot().status.settings.proxy, host.stored.settings.proxy)
  assert.equal(hasChanges(model.getSnapshot()), true)
  model.stop()
})
await test('an earlier status response cannot overwrite a newer one', async () => {
  const first = deferred(), second = deferred()
  let count = 0
  const model = createSettingsModel({ request: () => (++count === 1 ? first.promise : second.promise) })
  const initial = model.start()
  const refresh = model.refresh()
  second.resolve({ ok: true, value: status({ proxy: 'http://new:1' }) })
  await refresh
  first.resolve({ ok: true, value: status({ proxy: 'http://old:1' }) })
  await initial
  assert.equal(model.getSnapshot().draft.proxy, 'http://new:1')
  model.stop()
})
await test('unmount cancels a status request and ignores its late response', async () => {
  const wait = deferred()
  let signal
  const model = createSettingsModel({ request: (_endpoint, _payload, supplied) => { signal = supplied; return wait.promise } })
  const initial = model.start()
  model.stop()
  assert.equal(signal.aborted, true)
  wait.resolve({ ok: true, value: status({ enabled: true }) })
  await initial
  assert.equal(model.getSnapshot().draft, undefined)
})
await test('source changes preserve advanced and hidden values', async () => {
  const initial = { mode: 'custom', httpProxy: 'http://one:1', httpsProxy: 'http://two:2', noProxy: 'example.test' }
  const { model, host } = await mounted(initial)
  model.patch('mode', 'system')
  model.patch('mode', 'custom')
  assert.equal(model.getSnapshot().draft.httpsProxy, initial.httpsProxy)
  assert.equal(model.getSnapshot().draft.noProxy, initial.noProxy)
  assert.equal(host.calls.filter((entry) => entry.endpoint === 'save').length, 0)
  model.stop()
})

console.log('\n-- credentials and save transactions')
await test('a missing credential adapter never blocks the ordinary form', async () => {
  const { model } = await mounted({}, null)
  assert.equal(model.getSnapshot().phase, 'ready')
  assert.equal(model.getSnapshot().credential.phase, 'unavailable')
  model.patch('proxy', 'http://localhost:7890')
  assert.equal(await model.save(), true)
  model.stop()
})
await test('a Host without a credential store reports unavailable, not absent', async () => {
  const api = {
    async describe() { return { ok: false, error: { message: 'the credential store is not available' } } },
    async set() { throw new Error('unreachable') },
    async unset() { throw new Error('unreachable') },
  }
  const { model } = await mounted({}, api)
  assert.equal(model.getSnapshot().phase, 'ready')
  assert.equal(model.getSnapshot().credential.phase, 'error')
  assert.equal(model.getSnapshot().credential.writable, false)
  assert.equal(model.getSnapshot().credential.configured, false)
  model.stop()
})
await test('a failed credential lookup is unknown, never falsely reported absent', async () => {
  const api = { describe: async () => { throw new Error('unavailable') } }
  const { model } = await mounted({}, api)
  assert.equal(model.getSnapshot().credential.phase, 'error')
  assert.equal(model.getSnapshot().credential.writable, false)
  assert.equal(model.getSnapshot().phase, 'ready')
  model.stop()
})
await test('one Save carries the password and the whole draft in a single request', async () => {
  const api = store()
  const { model, host } = await mounted({ mode: 'custom' }, api)
  model.patch('proxy', 'http://localhost:7890')
  model.patch('authUser', 'alice')
  model.setSecret('example-p@ssword')
  assert.equal(hasChanges(model.getSnapshot()), true)
  assert.equal(await model.save(), true)
  // One transaction: the Host stores the password and applies the settings. Two
  // requests would make first-time setup fail, because the Host would validate the
  // password against the user name that is not saved yet.
  const saves = host.calls.filter((entry) => entry.endpoint === 'save')
  assert.equal(saves.length, 1)
  assert.equal(saves[0].payload.settings.authUser, 'alice')
  assert.equal(saves[0].payload.settings.proxy, 'http://localhost:7890')
  assert.equal(saves[0].payload.secret, 'example-p@ssword')
  assert.equal(Object.hasOwn(saves[0].payload.settings, 'password'), false)
  assert.equal(Object.hasOwn(saves[0].payload.settings, 'secret'), false)
  assert.equal(model.getSnapshot().secret, '')
  assert.equal(hasChanges(model.getSnapshot()), false)
  model.stop()
})
await test('a save re-reads the Host so the read-only surfaces are not stale', async () => {
  // The "Refresh status" button is gone, so the save itself has to resync. The Host
  // reports a DIFFERENT state on the follow-up read than on the save reply, which is
  // exactly what happens when the transport re-installs asynchronously.
  const host = server({ proxy: 'http://old:1' })
  let reads = 0
  const model = createSettingsModel({ request: (endpoint, payload, signal) => {
    if (endpoint === 'status') {
      reads += 1
      if (reads > 1) {
        return { ok: true, value: status({ proxy: 'http://old:1' }, { policy: {
          source: 'custom', active: true, httpProxy: 'http://resynced:2', httpsProxy: 'http://resynced:2',
          noProxy: 'localhost', entries: [], unsupported: [], notes: [],
        } }) }
      }
    }
    return host.request(endpoint, payload, signal)
  } })
  await model.start()
  model.patch('proxy', 'http://new:1')
  assert.equal(await model.save(), true)
  assert.equal(host.calls.filter((entry) => entry.endpoint === 'save').length, 1)
  // One extra status read, after the save, and its policy is what the UI shows.
  assert.equal(reads, 2)
  assert.equal(model.getSnapshot().status.policy.httpProxy, 'http://resynced:2')
  assert.equal(hasChanges(model.getSnapshot()), false)
  model.stop()
})
await test('a failed resync leaves the saved state on screen instead of an error', async () => {
  // A save that succeeded must not be reported as failed because a follow-up read
  // broke: the commit happened, and an error banner would say otherwise.
  const host = server({ proxy: 'http://old:1' })
  let reads = 0
  const model = createSettingsModel({ request: (endpoint, payload, signal) => {
    if (endpoint === 'status' && ++reads > 1) throw new Error('HTTP 500')
    return host.request(endpoint, payload, signal)
  } })
  await model.start()
  model.patch('proxy', 'http://new:1')
  assert.equal(await model.save(), true)
  assert.equal(model.getSnapshot().notice, null)
  assert.equal(model.getSnapshot().operation, null)
  assert.equal(model.getSnapshot().status.settings.proxy, 'http://new:1')
  assert.equal(hasChanges(model.getSnapshot()), false)
  model.stop()
})
await test('an edit made during the resync is not discarded by it', async () => {
  // The user can type while the follow-up read is in flight; the resync must adopt
  // the fresh status but keep the newer draft, or their typing would silently vanish.
  const host = server({ proxy: 'http://old:1' })
  let resolveStatus
  let reads = 0
  const model = createSettingsModel({ request: (endpoint, payload, signal) => {
    if (endpoint === 'status' && ++reads > 1) {
      return new Promise((resolve) => { resolveStatus = () => resolve({ ok: true, value: status({ proxy: 'http://old:1' }) }) })
    }
    return host.request(endpoint, payload, signal)
  } })
  await model.start()
  model.patch('proxy', 'http://new:1')
  const saving = model.save()
  await new Promise((resolve) => setTimeout(resolve, 0))
  model.patch('proxy', 'http://typed-during-resync:9')
  resolveStatus()
  await saving
  assert.equal(model.getSnapshot().draft.proxy, 'http://typed-during-resync:9')
  assert.equal(hasChanges(model.getSnapshot()), true)
  model.stop()
})
await test('password-only changes count as unsaved and still reapply the Host settings', async () => {
  const api = store(true)
  const { model, host } = await mounted({ authUser: 'alice' }, api)
  model.setSecret('replacement')
  assert.equal(hasChanges(model.getSnapshot()), true)
  await model.save()
  assert.equal(host.calls.filter((entry) => entry.endpoint === 'save').length, 1)
  model.stop()
})
await test('a refused save keeps the typed password and has not applied anything', async () => {
  const api = store()
  const host = server({ authUser: 'alice' })
  const model = createSettingsModel({ credentials: api, request: (endpoint, payload, signal) => {
    if (endpoint === 'save') return { ok: false, error: { message: 'the password could not be stored' } }
    return host.request(endpoint, payload, signal)
  } })
  await model.start()
  model.setSecret('typed-secret')
  assert.equal(await model.save(), false)
  // Nothing was applied: a single request means a refusal changes no state at all.
  assert.equal(host.calls.some((entry) => entry.endpoint === 'save'), false)
  assert.equal(model.getSnapshot().notice.key, 'error.save')
  assert.equal(model.getSnapshot().notice.detail, 'the password could not be stored')
  assert.equal(model.getSnapshot().secret, 'typed-secret')
  assert.equal(model.getSnapshot().status.settings.authUser, 'alice')
  model.stop()
})
await test('a stored password with failed application is reported as pending, then completes', async () => {
  const api = store()
  const host = server({ authUser: 'alice', proxy: 'http://old:1' })
  let fail = true
  const model = createSettingsModel({ credentials: api, request: (endpoint, payload, signal) => {
    if (endpoint === 'save' && fail) {
      // The Host reports that the credential half landed before the apply failed.
      return { ok: false, error: { message: 'the proxy could not be installed', secretStored: true } }
    }
    return host.request(endpoint, payload, signal)
  } })
  await model.start()
  model.patch('proxy', 'http://new:2')
  model.setSecret('changed-password')
  assert.equal(await model.save(), false)
  assert.equal(model.getSnapshot().notice.key, 'auth.partial')
  assert.equal(model.getSnapshot().credentialPending, true)
  assert.equal(model.getSnapshot().draft.proxy, 'http://new:2')
  assert.equal(model.getSnapshot().status.settings.proxy, 'http://old:1')
  // The field keeps the typed value: retrying re-sends the same password, which is
  // idempotent, and clearing it would look like the password had been lost.
  assert.equal(model.getSnapshot().secret, 'changed-password')
  fail = false
  assert.equal(await model.save(), true)
  assert.equal(model.getSnapshot().credentialPending, false)
  assert.equal(model.getSnapshot().status.settings.proxy, 'http://new:2')
  model.stop()
})
await test('a Host error that echoes the password is redacted before display', async () => {
  const host = server({ authUser: 'alice' })
  const model = createSettingsModel({ request: (endpoint, payload, signal) => {
    // A pessimistic backend: the failure message quotes what it tried to store.
    if (endpoint === 'save') return { ok: false, error: { message: `store refused for ${payload.secret ?? ''}` } }
    return host.request(endpoint, payload, signal)
  } })
  await model.start()
  model.setSecret('unique-sensitive-value')
  await model.save()
  assert.equal(model.getSnapshot().notice.detail.includes('unique-sensitive-value'), false)
  model.stop()
})
await test('clearing a password preserves the draft and re-describes ambient fallbacks', async () => {
  const api = store(true)
  api.unset = async () => { api.calls.push(['unset', REF]); return { ok: true } }
  const { model, host } = await mounted({ authUser: 'alice' }, api)
  model.patch('proxy', 'http://edited:7890')
  await model.clearPassword()
  assert.equal(model.getSnapshot().draft.proxy, 'http://edited:7890')
  assert.equal(model.getSnapshot().credential.configured, true)
  assert.equal(model.getSnapshot().credentialPending, true)
  assert.equal(await model.probe(), false)
  assert.equal(host.calls.some((entry) => entry.endpoint === 'probe'), false)
  model.revert()
  assert.equal(model.getSnapshot().credentialPending, true)
  assert.equal(hasChanges(model.getSnapshot()), true)
  model.stop()
})
await test('Revert clears an unsaved password without touching the credential store', async () => {
  const api = store()
  const { model } = await mounted({ authUser: 'alice' }, api)
  model.patch('proxy', 'http://edited:1')
  model.setSecret('not-yet-saved')
  model.revert()
  assert.equal(model.getSnapshot().secret, '')
  assert.equal(model.getSnapshot().draft.proxy, '')
  assert.equal(api.calls.some(([op]) => op !== 'describe'), false)
  model.stop()
})
await test('a pending save cannot be doubled or race a probe or edit', async () => {
  const wait = deferred()
  const host = server()
  let saves = 0
  const model = createSettingsModel({ request: (endpoint, payload, signal) => {
    if (endpoint === 'save') { saves++; return wait.promise }
    return host.request(endpoint, payload, signal)
  } })
  await model.start()
  model.patch('proxy', 'http://one:1')
  const pending = model.save()
  assert.equal(model.getSnapshot().operation, 'saving')
  assert.equal(await model.save(), false)
  assert.equal(await model.probe(), false)
  model.patch('proxy', 'http://two:2')
  assert.equal(model.getSnapshot().draft.proxy, 'http://one:1')
  wait.resolve({ ok: true, value: status({ proxy: 'http://one:1' }) })
  assert.equal(await pending, true)
  assert.equal(saves, 1)
  model.stop()
})

console.log('\n-- testing, validation and status')
await test('probe targets saved settings only and stale success disappears after editing', async () => {
  const { model, host } = await mounted()
  assert.equal(await model.probe(), true)
  assert.equal(model.getSnapshot().probe.status, 204)
  model.patch('proxy', 'http://next:1')
  assert.equal(model.getSnapshot().probe, null)
  assert.equal(await model.probe(), false)
  assert.equal(host.calls.filter((entry) => entry.endpoint === 'probe').length, 1)
  assert.equal(model.getSnapshot().notice.key, 'probe.saveFirst')
  model.stop()
})
await test('bad URLs and pasted credentials are field errors, not requests', async () => {
  const { model, host } = await mounted({ mode: 'custom' })
  model.patch('proxy', 'socks4://host:1080')
  assert.equal(await model.save(), false)
  assert.equal(model.getSnapshot().errors.proxy, 'validation.proxy')
  model.patch('proxy', 'http://alice:password@host:8080')
  assert.equal(await model.save(), false)
  assert.equal(model.getSnapshot().errors.proxy, 'validation.userinfo')
  assert.equal(host.calls.some((entry) => entry.endpoint === 'save'), false)
  model.stop()
})
await test('required address, user name and probe URL have distinct validation messages', () => {
  assert.equal(validateDraft(settingsOf({ enabled: true, mode: 'custom' })).proxy, 'validation.required')
  assert.equal(validateDraft(settingsOf({ authUser: '' }), 'typed').authUser, 'validation.authUser')
  assert.equal(validateDraft(settingsOf({ probeUrl: 'ftp://host/file' })).probeUrl, 'validation.probe')
  assert.equal(validateDraft(settingsOf({ proxy: 'http://h/path' })).proxy, 'validation.endpoint')
  assert.deepEqual(validateDraft(settingsOf({ mode: 'direct', proxy: 'socks4://host:1' })), {})
})
await test('off, forced direct, unconfigured, active and apply error are not conflated', () => {
  assert.equal(appliedState(status()).key, 'state.off')
  assert.equal(appliedState(status({ enabled: true }, { policy: { source: 'direct', active: false } })).key, 'state.direct')
  assert.equal(appliedState(status({ enabled: true }, { policy: { source: 'none', active: false } })).key, 'state.none')
  assert.equal(appliedState(status({ enabled: true }, { policy: { source: 'custom', active: true } })).key, 'state.proxied')
  assert.equal(appliedState(status({ enabled: true }, { lastError: 'failed' })).key, 'state.error')
})
await test('status refresh never grants an edit the applied badge prematurely', async () => {
  const { model } = await mounted()
  model.patch('enabled', true)
  assert.equal(appliedState(model.getSnapshot().status).key, 'state.off')
  assert.equal(model.getSnapshot().draft.enabled, true)
  model.stop()
})
await test('routing and prompt injection edit independent fields', async () => {
  const { model } = await mounted({ enabled: true, promptInjection: true })
  model.patch('enabled', false)
  assert.equal(model.getSnapshot().draft.promptInjection, true)
  model.patch('promptInjection', false)
  assert.equal(model.getSnapshot().draft.enabled, false)
  model.stop()
})
await test('settings serialization never includes a password or transient fields', () => {
  const settings = settingsOf({ password: 'sensitive', secret: 'typed', operation: 'saving', proxy: 'http://h:1' })
  assert.equal(Object.hasOwn(settings, 'password'), false)
  assert.equal(Object.hasOwn(settings, 'secret'), false)
  assert.equal(Object.hasOwn(settings, 'operation'), false)
  assert.equal(sameSettings(settings, settingsOf(settings)), true)
  assert.equal(safeText('http://alice:p%40ss@host:123'), 'http://***@host:123')
})
await test('editing the draft drops an in-flight preview instead of caching stale text', async () => {
  const wait = deferred()
  const model = createSettingsModel({
    request: async (endpoint) => {
      if (endpoint === 'status') return { ok: true, value: status() }
      if (endpoint === 'prompt') return wait.promise
      throw new Error(`Unexpected endpoint ${endpoint}`)
    },
    credentials: store(),
  })
  await model.start()
  const pending = model.previewPrompt()
  model.patch('promptTemplate', 'changed')
  wait.resolve({ ok: true, value: { text: 'old draft', reason: 'rendered', required: true, facts: {}, placeholders: [] } })
  await pending
  assert.equal(model.getSnapshot().promptPreview, null)
  model.stop()
})
await test('the actual HTTP client keeps the same origin, route and envelope', async () => {
  const requests = []
  fakeFetch = async (path, init) => {
    requests.push({ path, init, body: JSON.parse(init.body) })
    return { ok: true, json: async () => ({ ok: true, value: status() }) }
  }
  const model = createSettingsModel()
  await model.start()
  assert.equal(requests[0].path, client.proxySettings.ROUTE_PATH)
  assert.equal(requests[0].init.credentials, 'same-origin')
  assert.equal(requests[0].body.endpoint, 'status')
  assert.deepEqual(requests[0].body.payload, {})
  assert.ok(requests[0].init.signal instanceof AbortSignal)
  model.stop()
})

console.log('\n-- component integration and static accessibility contracts')
let dictionaries, registration
client.apply({
  effect: (fn) => fn(), get: () => undefined,
  locale: { register: (_namespace, dicts) => { dictionaries = dicts; return () => {} } },
  slots: { inject: (_slot, fn) => fn(), register: (options) => { registration = options; return () => {} } },
})
await test('the form remains one contribution to the existing pack page', () => {
  assert.equal(registration.name, 'notpdpton.settings.group')
  assert.equal(registration.id, 'networkProxy')
  assert.equal(registration.order, 20)
  assert.deepEqual(client.inject, ['slots', 'locale'])
})
await test('Chinese and English dictionaries have complete, matching keys', () => {
  assert.deepEqual(Object.keys(dictionaries.zh).sort(), Object.keys(dictionaries.en).sort())
  for (const dict of Object.values(dictionaries)) {
    for (const value of Object.values(dict)) assert.ok(typeof value === 'string' && value.length > 0)
  }
})
await test('layout is component-scoped and responsive without literal theme colors', () => {
  // One container, one breakpoint: the block adapts to the Settings dialog being
  // dragged narrow instead of to a viewport breakpoint it cannot observe.
  assert.match(source, /@container npd-proxy/)
  assert.match(source, /minmax\(0, 1fr\)/)
  assert.match(source, /\.npdpx-input/)
  const css = source.match(/const CSS = `([\s\S]*?)`/)?.[1]
  assert.ok(css)
  assert.equal(/#[0-9a-f]{3,8}\b|rgba?\(/i.test(css), false)
  assert.match(css, /var\(--dsw-alias-/)
  // The recipes the block copies: 36x20 switch, hairlines rather than grey boxes,
  // the business-blue focus color, and a pill that re-declares its corner shape
  // under the global superellipse.
  assert.match(css, /width: 36px; height: 20px/)
  assert.match(css, /--dsw-radius-md/)
  assert.match(css, /--dsw-alias-border-l2/)
  assert.match(css, /--dsw-alias-state-business-primary/)
  assert.match(css, /corner-shape: round/)
})
await test('template and preview share one fixed-size box', () => {
  assert.ok(source.includes("className: 'npdpx-textarea npdpx-mono npdpx-promptBox'"))
  assert.ok(source.includes("className: 'npdpx-promptBox npdpx-previewText'"))
  assert.ok(source.includes('.npdpx-promptBox { height: 160px;'))
  assert.ok(source.includes("t(promptView === 'edit' ? 'prompt.viewPreview' : 'prompt.viewEdit')"))
})
await test('the bypass field shows the effective list and locks inherited sources', () => {
  assert.ok(source.includes('readOnly: !custom'))
  assert.ok(source.includes('value: custom ? draft.noProxy : policy.noProxy'))
  assert.ok(source.includes("t('bypass.readOnlyHint')"))
  assert.ok(source.includes("t('bypass.effective'"))
})
await test('every control carries an explicit accessible name and state', () => {
  assert.match(source, /role: 'switch'/)
  assert.equal(/disabled:\s*!draft\.(enabled|promptInjection)/.test(source), false)
  assert.match(source, /'aria-checked': checked/)
  assert.match(source, /role: 'tablist'/)
  assert.match(source, /role: 'tab'/)
  assert.match(source, /'aria-selected': option\.value === value/)
  assert.match(source, /tabIndex: option\.value === value \? 0 : -1/)
  assert.match(source, /htmlFor: id/)
  assert.match(source, /'aria-expanded': open/)
  assert.match(source, /'aria-controls':/)
  assert.match(source, /'aria-invalid': error \? true : undefined/)
  assert.match(source, /'aria-live': 'polite'/)
  // Failures are announced as alerts; everything else is a polite status.
  assert.match(source, /role: notice\.tone === 'error' \? 'alert' : 'status'/)
})

console.log(`\nOK: proxy UI interaction checks pass (${total} scenarios, no network/profile changes)`)
