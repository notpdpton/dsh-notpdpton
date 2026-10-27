/**
 * Boot the Host half against a stub context and drive its route, including the
 * credential endpoint. A local proxy stands in for the network, so nothing leaves
 * the machine and no profile file is written outside the temp directory.
 */
import http from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

const half = await import(new URL('../proxy/index.js', import.meta.url).href)
const directory = await mkdtemp(join(tmpdir(), 'npd-route-'))
process.env.DSH_PROFILE_DIR = directory

const seen = []
const proxy = http.createServer((request, response) => {
  seen.push(`absolute ${request.url}`)
  response.writeHead(200)
  response.end('ok')
})
proxy.on('connect', (request, socket) => {
  seen.push(`connect ${request.url}`)
  socket.end('HTTP/1.1 200 Connection Established\r\n\r\n')
})
await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve))

// A tiny credential store with the same one-way rule as the real one.
const stored = new Map()
const credentials = {
  async resolve(ref) {
    return stored.has(ref) ? { value: stored.get(ref), source: 'store' } : undefined
  },
  async describe(ref) {
    return { configured: stored.has(ref), writable: true }
  },
  async set(ref, value) {
    if (value === '') throw new Error('empty values are rejected')
    stored.set(ref, value)
  },
  async unset(ref) {
    stored.delete(ref)
  },
}

let route
let promptEntry
const effects = []
const services = {
  webServer: { register: (definition) => ((route = definition), () => {}) },
  credentials,
  systemPrompt: { context: (definition) => ((promptEntry = definition), () => {}) },
}
const context = {
  get: (key) => services[key],
  effect: (factory) => {
    const disposer = factory()
    effects.push(disposer)
    return () => (typeof disposer === 'function' ? disposer() : undefined)
  },
  inject: (keys, callback) => {
    if (keys.filter((key) => services[key] !== undefined).length === 0) return
    callback({ ...context, get: (key) => services[key] })
  },
}
half.apply(context, {})
await new Promise((resolve) => setTimeout(resolve, 400))

const server = http.createServer((request, response) => route.handler(request, response))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const origin = `http://127.0.0.1:${port}`
let failures = 0
const check = (label, condition, detail) => {
  if (condition) console.log(`  ok   ${label}`)
  else {
    failures++
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}
async function call(body) {
  const response = await fetch(origin + half.ROUTE_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return response.json()
}

console.log('-- route contract')
check('registers one exact route at the shared path', route?.kind === 'exact' && route.path === half.ROUTE_PATH)

// The boot path must not pay for the system-proxy read when the stored settings
// cannot use it: one reg.exe child measured at 53-69 ms per Host start.
// readSystemProxyIfNeeded is the seam the boot path uses, so assert both halves —
// the gate decision and that a skipped read really spawns nothing.
check(
  'a disabled component does not read the system proxy at boot',
  (await half.readSystemProxyIfNeeded(half.normalizeSettings({ enabled: false }))) === undefined,
)
check(
  'a custom-source component does not read the system proxy at boot',
  (await half.readSystemProxyIfNeeded(half.normalizeSettings({ enabled: true, mode: 'custom', proxy: '127.0.0.1:1' }))) ===
    undefined,
)
check(
  'the gate is derived from the settings, not a fixed answer',
  half.needsSystemProxy(half.normalizeSettings({ enabled: true, mode: 'system' })) === true &&
    half.needsSystemProxy(half.normalizeSettings({ enabled: false, mode: 'system' })) === false,
)
// The helper is only worth anything if install() actually calls it. Assert the call
// site, because that is the line whose regression costs every Host start 50+ ms.
{
  const source = readFileSync(new URL('../proxy/index.js', import.meta.url), 'utf8')
  // install()'s own body only. The lazy display read lives in refreshSystem(), which
  // is defined after install() and is allowed to call readSystemProxy directly.
  const installBody = source.slice(
    source.indexOf('const install = async () =>'),
    source.indexOf('const refreshSystem = async () =>'),
  )
  check(
    'the install path reads the system proxy through the gate',
    installBody.includes('readSystemProxyIfNeeded(') && !/await readSystemProxy\(\)/.test(installBody),
    installBody.includes('readSystemProxyIfNeeded(') ? 'unconditional read still present' : 'gate call missing',
  )
}

console.log('\n-- system panel stays readable without a boot read')
// The boot path now skips the system read for settings that cannot use it. The
// settings panel still renders that reading under `system`, so the status endpoint
// must fill it lazily — otherwise "上次读取：系统代理已开启" would become a permanent
// "unavailable" for anyone who opens the panel before enabling the feature.
{
  const panelDir = await mkdtemp(join(tmpdir(), 'npd-panel-'))
  const previousProfile = process.env.DSH_PROFILE_DIR
  process.env.DSH_PROFILE_DIR = panelDir
  await writeFile(join(panelDir, half.SETTINGS_FILE), JSON.stringify({ enabled: false, mode: 'system' }))
  const panelRoute = { handler: null }
  const panelCtx = {
    get: (key) => (key === 'webServer' ? { register: (d) => ((panelRoute.handler = d.handler), () => {}) } : undefined),
    effect: (fn) => fn(),
    inject: (keys, callback) => {
      if (keys.some((key) => key === 'webServer')) callback({ ...panelCtx, get: panelCtx.get })
    },
  }
  half.apply(panelCtx, {})
  const panelServer = http.createServer((request, response) => panelRoute.handler(request, response))
  await new Promise((resolve) => panelServer.listen(0, '127.0.0.1', resolve))
  const panelPort = panelServer.address().port
  const askStatus = () =>
    fetch('http://127.0.0.1:' + panelPort + half.ROUTE_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: 'status' }),
    }).then((response) => response.json())
  const first = await askStatus()
  const second = await askStatus()
  if (process.platform === 'win32') {
    check('the system panel has a reading even though boot skipped it', first.value.system !== undefined)
    check('a repeated status request reuses the reading', second.value.system !== undefined)
  } else {
    // No registry reader on this platform; both answers are honestly absent.
    check('a platform without a system reader reports no reading', first.value.system === undefined)
  }
  check('the panel reading never claims routing from a disabled component', first.value.policy.source === 'off', first.value.policy.source)
  panelServer.close()
  process.env.DSH_PROFILE_DIR = previousProfile
}

console.log('\n-- credential endpoint')
let reply = await call({ endpoint: 'secret', payload: { action: 'describe' } })
check('describes an empty store', reply.ok === true && reply.value.configured === false && reply.value.writable === true)

reply = await call({ endpoint: 'secret', payload: { action: 'set', password: 'pw' } })
check('refuses a password with no user name', reply.ok === false && /user name/i.test(reply.error.message), reply.error?.message)

await call({ endpoint: 'save', payload: { settings: { authUser: 'alice', mode: 'custom', proxy: `127.0.0.1:${proxy.address().port}`, enabled: true } } })
reply = await call({ endpoint: 'secret', payload: { action: 'set', password: 'pw-with-@-sign' } })
check('stores a password', reply.ok === true && reply.value.configured === true)
check('the stored value is exactly what was sent', stored.get(half.PASSWORD_REF) === 'pw-with-@-sign')

reply = await call({ endpoint: 'secret', payload: { action: 'describe' } })
check('a describe never returns the value', !JSON.stringify(reply).includes('pw-with-@-sign'))

const beforeApply = await call({ endpoint: 'status' })
check('a stored password alone does not claim routing is authenticated', beforeApply.value.authenticated === false)

// The two-phase contract: the store and the routing are separate writes, and the
// second one is what makes the credential effective. This is what the UI's
// "pending application" state exists to describe.
await call({ endpoint: 'save', payload: { settings: { authUser: 'alice', mode: 'custom', proxy: `127.0.0.1:${proxy.address().port}`, enabled: true } } })
const status = await call({ endpoint: 'status' })
check('the status never carries the password', !JSON.stringify(status).includes('pw-with-@-sign'))
check('the status redacts userinfo in reported endpoints', !/alice:pw/.test(JSON.stringify(status)))
check('applying settings makes the stored credential effective', status.value.authenticated === true)
check('the reported endpoint shows the credential as redacted', status.value.policy.httpsProxy.includes('***@'), status.value.policy.httpsProxy)
check('the status carries the placeholder list', Array.isArray(status.value.promptPlaceholders) && status.value.promptPlaceholders.includes('proxy'), JSON.stringify(status.value.promptPlaceholders))
check('the status carries the applied placeholder values', status.value.promptFacts?.proxy?.includes('127.0.0.1') && typeof status.value.promptFacts?.shell === 'string', status.value.promptFacts?.proxy)

console.log('\n-- routing actually uses the credential')
seen.length = 0
try {
  await fetch('https://credential-verify.invalid/x', { signal: AbortSignal.timeout(1500) })
} catch {}
check('the request reached the local proxy', seen.some((line) => line.includes('credential-verify.invalid')))

console.log('\n-- unset')
reply = await call({ endpoint: 'secret', payload: { action: 'unset' } })
check('unset clears the store', reply.ok === true && reply.value.configured === false)
check('the value is gone', !stored.has(half.PASSWORD_REF))
// Removing a credential is also only half the job: the installed routing still
// holds the old value until settings are applied again.
reply = await call({ endpoint: 'status' })
check('the installed route keeps the credential until reapplied', reply.value.authenticated === true)
await call({ endpoint: 'save', payload: { settings: { authUser: 'alice', mode: 'custom', proxy: `127.0.0.1:${proxy.address().port}`, enabled: true } } })
reply = await call({ endpoint: 'status' })
check('reapplying after unset drops authentication', reply.value.authenticated === false)

console.log('\n-- refusals')
reply = await call({ endpoint: 'secret', payload: { action: 'nonsense' } })
check('an unknown secret action is refused', reply.ok === false && /unknown secret action/.test(reply.error.message))
reply = await call({ endpoint: 'secret', payload: { action: 'set', password: '' } })
check('an empty password is refused', reply.ok === false && /empty/.test(reply.error.message))

console.log('\n-- first-time setup in one request')
stored.clear()
await call({ endpoint: 'save', payload: { settings: { enabled: false, authUser: '' } } })
reply = await call({
  endpoint: 'save',
  payload: { settings: { enabled: true, mode: 'custom', proxy: `127.0.0.1:${proxy.address().port}`, authUser: 'bob' }, secret: 'first-password' },
})
check('a new user name and new password succeed together', reply.ok === true, reply.error?.message)
check('the password landed in the store', stored.get(half.PASSWORD_REF) === 'first-password')
check('the same request authenticated the routing', reply.value.authenticated === true)
check('the settings file still has no password', !(await readFile(join(directory, half.SETTINGS_FILE), 'utf8')).includes('first-password'))

reply = await call({ endpoint: 'save', payload: { settings: { authUser: 'bob', enabled: true, mode: 'custom', proxy: `127.0.0.1:${proxy.address().port}` }, secret: '' } })
check('an empty secret on a later save leaves the stored one alone', reply.ok === true && stored.get(half.PASSWORD_REF) === 'first-password')

console.log('\n-- no credential service at all')
services.credentials = undefined
reply = await call({ endpoint: 'secret', payload: { action: 'describe' } })
check('reports the store as unavailable rather than throwing', reply.ok === false && /not available/.test(reply.error.message))
reply = await call({ endpoint: 'save', payload: { settings: { authUser: 'bob', enabled: true }, secret: 'late-password' } })
check('a save carrying a password is refused when the store is gone', reply.ok === false && /not available/.test(reply.error.message))
const stillWorks = await call({ endpoint: 'status' })
check('the rest of the route still answers', stillWorks.ok === true)

console.log('\n-- prompt preview endpoint')
reply = await call({ endpoint: 'prompt', payload: { settings: { promptInjection: true, promptTemplate: '' } } })
check('the preview reports the rendered built-in text', reply.ok === true && reply.value.reason === 'rendered', reply.value?.reason)
check('the preview carries the live proxy', reply.value.text.includes('127.0.0.1'))
check('the preview carries a starter template with placeholders', typeof reply.value.templateSeed === 'string' && reply.value.templateSeed.includes('{{proxy}}') && reply.value.templateSeed.includes('{{source}}'), reply.value.templateSeed?.slice(0, 60))
check('the preview advertises its placeholders', Array.isArray(reply.value.placeholders) && reply.value.placeholders.includes('proxy'))
check('the preview declares the entry required', reply.value.required === true)
check('the preview never leaks the password', !/first-password|pw-with-@-sign/.test(JSON.stringify(reply.value)))

reply = await call({ endpoint: 'prompt', payload: { settings: { promptTemplate: 'Only {{proxy}}' } } })
check('a draft template is previewed without being saved', reply.value.text.startsWith('Only http://127.0.0.1:'), reply.value.text)
{
  const names = [...reply.value.templateSeed.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1])
  check('the starter template uses only advertised placeholders', names.length > 0 && names.every((name) => reply.value.placeholders.includes(name)), names.join(','))
}
check('previewing does not persist the draft', (await call({ endpoint: 'status' })).value.settings.promptTemplate === '')

reply = await call({ endpoint: 'prompt', payload: { settings: { promptInjection: false } } })
check('a switched-off notice previews as empty with a reason', reply.value.text === '' && reply.value.reason === 'disabled', reply.value.reason)
check('the disabled preview still carries the starter template', typeof reply.value.templateSeed === 'string' && reply.value.templateSeed.includes('{{proxy}}'), reply.value.templateSeed?.slice(0, 40))

console.log('\n-- injection requires an active proxy')
reply = await call({ endpoint: 'save', payload: { settings: { enabled: false, authUser: 'bob', mode: 'custom', proxy: `127.0.0.1:${proxy.address().port}` }, secret: '' } })
check('the proxy can be switched off on its own', reply.ok === true, reply.error?.message)
reply = await call({ endpoint: 'prompt', payload: { settings: { promptInjection: true } } })
check('an inactive proxy previews nothing', reply.value.reason === 'inactive' && reply.value.text === '', JSON.stringify(reply.value))
check('the inactive preview still carries the starter template', typeof reply.value.templateSeed === 'string' && reply.value.templateSeed.includes('{{proxy}}'))
reply = await call({ endpoint: 'prompt', payload: { settings: { promptInjection: false } } })
check('with no proxy, the preview stays empty even when injection is off', reply.value.reason === 'inactive' && reply.value.text === '')
const disabledStatus = await call({ endpoint: 'status' })
check('the routing switch stayed off independently', disabledStatus.value.settings.enabled === false && disabledStatus.value.settings.promptInjection === true)
check('the live prompt entry is empty while routing is off', typeof promptEntry?.text === 'function' && promptEntry.text() === '', promptEntry?.text?.())
reply = await call({ endpoint: 'save', payload: { settings: { enabled: false, promptInjection: false }, secret: '' } })
check('injection can be switched off while routing stays off', reply.ok === true && promptEntry.text() === '')
reply = await call({ endpoint: 'save', payload: { settings: { enabled: false, promptInjection: true }, secret: '' } })
check('and switched back on without enabling routing', reply.ok === true && promptEntry.text() === '')
reply = await call({ endpoint: 'save', payload: { settings: { enabled: true, authUser: 'bob', mode: 'custom', proxy: `127.0.0.1:${proxy.address().port}` }, secret: '' } })
check('re-enabling routing brings the prompt back', reply.ok === true && promptEntry.text().includes(String(proxy.address().port)), promptEntry?.text?.()?.slice(0, 80))

console.log('\n-- persistence never stores the password')
const file = join(directory, half.SETTINGS_FILE)
const written = await readFile(file, 'utf8')
check('the settings file has the user name', written.includes('bob'))
check('the settings file has no password', !/first-password|pw-with-@-sign|late-password/.test(written))

for (const dispose of effects) if (typeof dispose === 'function') await dispose()
server.closeAllConnections?.()
server.close()
proxy.closeAllConnections?.()
proxy.close()
await rm(directory, { recursive: true, force: true })
console.log(failures === 0 ? '\nOK: host route and credential channel verify' : `\nFAIL: ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
