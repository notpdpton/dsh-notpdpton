/**
 * Offline verification of the network-proxy component: the Host half's pure
 * logic, its persistence, the transport contract, and the browser half's block.
 *
 * Every check exercises a SHIPPED file. The Host half is imported as it ships;
 * the browser half is executed through a `window.__ModuleLoader__` shim, exactly
 * as the other client verifiers in this directory do, so a broken registration
 * fails here instead of on the page.
 *
 * The transport checks install a real proxy agent against a real local proxy and
 * then restore it. Nothing here reaches the network: every URL used is either
 * loopback or a name that cannot resolve, and a failure to connect is the
 * expected outcome — what is asserted is WHERE the request went, which the local
 * proxy records.
 *
 * usage: node verify-proxy.mjs
 */
import http from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

let failures = 0
let skipped = 0
function check(label, condition, detail) {
  if (condition) console.log(`  ok   ${label}`)
  else {
    failures++
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}
function skip(label, detail) {
  skipped++
  console.log(`  skip ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

const host = await import(new URL('../proxy/index.js', import.meta.url).href)

// ---------------------------------------------------------------- settings

console.log('-- settings normalization')
const defaults = host.normalizeSettings(undefined)
check('an absent file yields every default', Object.keys(defaults).length === Object.keys(host.DEFAULT_SETTINGS).length)
check('the proxy starts disabled', defaults.enabled === false)
check('auto is the default source', defaults.mode === 'auto')
check('the shell exposure defaults to address only', defaults.exposeToShell === 'url')
check('prompt injection defaults on', defaults.promptInjection === true)
check(
  'a wrong-typed field falls back to its default',
  host.normalizeSettings({ mode: 42, enabled: 'yes' }).mode === 'auto' &&
    host.normalizeSettings({ mode: 42, enabled: 'yes' }).enabled === false,
)
check('an unknown enum value falls back to its default', host.normalizeSettings({ exposeToShell: 'everything' }).exposeToShell === 'url')
check('text fields are trimmed', host.normalizeSettings({ proxy: '  127.0.0.1:7890  ' }).proxy === '127.0.0.1:7890')
check('unknown keys are dropped', !('password' in host.normalizeSettings({ password: 'hunter2' })))
check('a blank probe URL falls back to the default', host.normalizeSettings({ probeUrl: '  ' }).probeUrl === host.DEFAULT_SETTINGS.probeUrl)
check('the default probe URL is https', host.DEFAULT_SETTINGS.probeUrl.startsWith('https://'))

// ---------------------------------------------------------------- URL parsing

console.log('\n-- proxy URL validation')
const valid = host.parseProxyUrl('127.0.0.1:7890')
check('a bare host:port is read as http', valid.kind === 'valid' && valid.value === 'http://127.0.0.1:7890', valid.value ?? valid.message)
check('http is supported', host.parseProxyUrl('http://h:1').kind === 'valid')
check('https is supported', host.parseProxyUrl('https://h:1').kind === 'valid')
const socks = host.parseProxyUrl('socks5://h:1080')
check('socks5 is supported and flagged experimental', socks.kind === 'valid' && socks.experimental === true)
check('socks5h is refused with a reason', host.parseProxyUrl('socks5h://h:1080').kind === 'invalid', host.parseProxyUrl('socks5h://h:1080').message)
check('socks4 is refused with a reason', host.parseProxyUrl('socks4://h:1').kind === 'invalid')
check('a non-proxy scheme is refused', host.parseProxyUrl('ftp://h:1').kind === 'invalid')
check('an empty value is absent, not invalid', host.parseProxyUrl('   ').kind === 'absent')
check('a URL with no host is refused', host.parseProxyUrl('http://').kind === 'invalid')
check('a path and query are dropped', host.parseProxyUrl('http://h:8080/path?x=1#y').value === 'http://h:8080')
check('userinfo is dropped by the parser', host.parseProxyUrl('http://u:p@h:8080').value === 'http://h:8080')

// ---------------------------------------------------------------- credentials

console.log('\n-- credential handling')
check(
  'credentials are encoded into the URL',
  host.withCredentials('http://h:8080', 'alice', 'p@ss:1') === 'http://alice:p%40ss%3A1@h:8080',
  host.withCredentials('http://h:8080', 'alice', 'p@ss:1'),
)
check('no user name means no userinfo', host.withCredentials('http://h:8080', '', 'secret') === 'http://h:8080')
check('no password means no userinfo', host.withCredentials('http://h:8080', 'alice', '') === 'http://h:8080')
check('redactUrl masks userinfo', host.redactUrl('http://a:b@h:1') === 'http://***@h:1', host.redactUrl('http://a:b@h:1'))
check('redactUrl leaves a clean URL alone', host.redactUrl('http://h:1') === 'http://h:1')
check('stripCredentials removes userinfo', host.stripCredentials('http://a:b@h:1') === 'http://h:1', host.stripCredentials('http://a:b@h:1'))
// The @ may only be interior: a password containing one must not confuse the split.
check(
  'a password containing @ is stripped from the last separator',
  host.stripCredentials('http://a:p%40ss@h:1') === 'http://h:1',
  host.stripCredentials('http://a:p%40ss@h:1'),
)

// ---------------------------------------------------------------- bypass

console.log('\n-- bypass list translation')
const local = host.translateBypass('<local>;localhost;127.*;10.*;172.16.*;192.168.*')
check('an exact host is kept', local.entries.includes('localhost'), local.entries.join(','))
check('<local> is reported as unsupported', local.unsupported.includes('<local>'), local.unsupported.join(','))
check('a partial-label wildcard is reported as unsupported', local.unsupported.includes('10.*'), local.unsupported.join(','))
check('127.* is reported rather than silently dropped', local.unsupported.includes('127.*'), local.unsupported.join(','))
check('semicolons, commas and spaces all split', host.splitBypass('a;b, c  d').join('|') === 'a|b|c|d', host.splitBypass('a;b, c  d').join('|'))
check('blank entries are dropped', host.splitBypass('a,,  ,b').length === 2)
const star = host.translateBypass('*')
check('a lone * bypasses everything and keeps no entries', star.entries.length === 1 && star.entries[0] === '*' && star.unsupported.length === 0)
const suffix = host.translateBypass('.example.com, *.example.com, example.com')
check('suffix forms are all kept as written', suffix.entries.length === 3 && suffix.unsupported.length === 0, suffix.entries.join(','))
const merged = host.withLoopback(['example.com'])
check(
  'loopback is merged into every bypass list',
  ['localhost', '127.0.0.1', '::1', '[::1]'].every((entry) => merged.includes(entry)),
  merged,
)
check('a * list stays a * list', host.withLoopback(['*']) === '*')
check(
  'the loopback entries are not duplicated',
  host.withLoopback(['localhost']).split(',').filter((entry) => entry === 'localhost').length === 1,
  host.withLoopback(['localhost']),
)

// ---------------------------------------------------------------- windows value

console.log('\n-- Windows ProxyServer reading')
const single = host.parseWindowsProxyServer('127.0.0.1:10808')
check('a single host:port applies to both schemes', single.http === 'http://127.0.0.1:10808' && single.https === 'http://127.0.0.1:10808')
const perScheme = host.parseWindowsProxyServer('http=1.2.3.4:80;https=5.6.7.8:443')
check(
  'a per-scheme list is read per scheme',
  perScheme.http === 'http://1.2.3.4' && perScheme.https === 'http://5.6.7.8:443',
  JSON.stringify(perScheme),
)
check('socks= in the registry becomes a candidate', host.parseWindowsProxyServer('socks=1.1.1.1:1080').socks === 'socks5://1.1.1.1:1080' || host.parseWindowsProxyServer('socks=1.1.1.1:1080').socks === 'http://1.1.1.1:1080')
check('an empty value reads as nothing', Object.keys(host.parseWindowsProxyServer('')).length === 0)
check('a malformed value is reported', typeof host.parseWindowsProxyServer('::::').invalid === 'string')

// ---------------------------------------------------------------- policy

console.log('\n-- policy resolution')
const baseSettings = (overrides) => host.normalizeSettings({ enabled: true, ...overrides })
const sources = {
  system: { enabled: true, server: '10.0.0.1:3128', override: 'localhost;corp.example', autoConfigUrl: '' },
  env: { http_proxy: 'http://env:1', https_proxy: 'http://env:1', no_proxy: 'env.example' },
}

const custom = host.resolvePolicy(baseSettings({ mode: 'custom', proxy: '127.0.0.1:7890' }), sources)
check('custom wins over a system proxy', custom.source === 'custom' && custom.httpProxy === 'http://127.0.0.1:7890', custom.source)
check('custom is active', custom.active === true)
check('custom merges the loopback bypass', custom.noProxy.includes('127.0.0.1') && custom.noProxy.includes('::1'))

const system = host.resolvePolicy(baseSettings({ mode: 'auto' }), sources)
check('auto falls through to the system proxy', system.source === 'system' && system.httpProxy === 'http://10.0.0.1:3128', system.source)
check('the system bypass list is translated', system.entries.includes('corp.example'), system.entries.join(','))

const autoCustom = host.resolvePolicy(baseSettings({ mode: 'auto', proxy: '127.0.0.1:1' }), sources)
check('auto prefers custom when it is filled', autoCustom.source === 'custom')

const env = host.resolvePolicy(baseSettings({ mode: 'env' }), sources)
check('the env source reads http_proxy', env.source === 'env' && env.httpProxy === 'http://env:1', env.source)

const envOnly = host.resolvePolicy(baseSettings({ mode: 'auto' }), { system: { enabled: false }, env: sources.env })
check('auto falls through to env when no system proxy is on', envOnly.source === 'env', envOnly.source)

// The system READ is the expensive part of resolution (one reg.exe child, ~55 ms),
// so the gate that skips it must agree exactly with what resolvePolicy would use.
console.log('\n-- system-proxy read gate')
const gate = (patch) => host.needsSystemProxy(host.normalizeSettings(patch))
check('a disabled component never reads the system proxy', gate({ enabled: false }) === false)
check('a disabled component skips it regardless of mode', gate({ enabled: false, mode: 'system' }) === false)
check('system mode with the component on reads it', gate({ enabled: true, mode: 'system' }) === true)
check('auto mode with the component on reads it (custom may yield nothing)', gate({ enabled: true, mode: 'auto' }) === true)
check('a pinned custom source does not read it', gate({ enabled: true, mode: 'custom' }) === false)
check('a pinned env source does not read it', gate({ enabled: true, mode: 'env' }) === false)
check('a pinned direct source does not read it', gate({ enabled: true, mode: 'direct' }) === false)
check(
  'a skipped read is reported as absent, which is what resolution treats as no system source',
  (await host.readSystemProxyIfNeeded(host.normalizeSettings({ enabled: false }))) === undefined,
)
// The gate must never change the OUTCOME: a mode it skips must not have been able
// to reach the system source anyway. This is the property, checked exhaustively.
const everyMode = ['auto', 'system', 'custom', 'env', 'direct']
const systemSources = { system: { enabled: true, server: '10.0.0.1:3128', override: '', autoConfigUrl: '' }, env: {} }
for (const mode of everyMode) {
  for (const enabled of [true, false]) {
    const settings = host.normalizeSettings({ mode, enabled, proxy: '127.0.0.1:7890' })
    const withReading = host.resolvePolicy(settings, systemSources)
    const withoutReading = host.resolvePolicy(settings, { ...systemSources, system: undefined })
    check(
      `the gate is lossless for enabled=${enabled} mode=${mode}`,
      host.needsSystemProxy(settings) ? withReading.source === withoutReading.source || withReading.source === 'system' : withReading.source === withoutReading.source,
      `${withReading.source} vs ${withoutReading.source}`,
    )
  }
}

const nothing = host.resolvePolicy(baseSettings({ mode: 'auto' }), { system: { enabled: false }, env: {} })
// An enabled component whose source yielded nothing is NOT the same as the user
// choosing direct: it is an incomplete configuration. Both are inactive, but only
// an explicit `direct` overrides the layer beneath (see the transport-environment
// checks below), so the two must not share a source name.
check(
  'an enabled component with no source resolves to an inactive policy',
  nothing.active === false && nothing.source === 'none',
  nothing.source,
)
check('and says why', nothing.notes.some((note) => note.includes('direct')), nothing.notes.join(' | '))

const direct = host.resolvePolicy(baseSettings({ mode: 'direct' }), sources)
check('a forced-direct mode ignores every source', direct.active === false && direct.source === 'direct')
check(
  'an explicit direct choice is a different source than an incomplete one',
  direct.source !== nothing.source,
  `${direct.source} vs ${nothing.source}`,
)

const disabled = host.resolvePolicy(host.normalizeSettings({ enabled: false, mode: 'custom', proxy: '127.0.0.1:1' }), sources)
check('a disabled component resolves to off, never to a proxy', disabled.active === false && disabled.source === 'off', disabled.source)

const pac = host.resolvePolicy(baseSettings({ mode: 'system' }), {
  system: { enabled: true, server: '1.1.1.1:1', override: '', autoConfigUrl: 'http://pac/x' },
  env: {},
})
check('a PAC script is reported as unsupported', pac.notes.some((note) => note.includes('PAC')), pac.notes.join(' | '))

const invalid = host.resolvePolicy(baseSettings({ mode: 'custom', proxy: 'socks5h://h:1' }), sources)
check('an unusable custom URL is reported', invalid.notes.some((note) => note.includes('socks5h')), invalid.notes.join(' | '))
check('an unusable custom URL does not fall through to another source', invalid.active === false || invalid.source === 'custom')

const perSchemeCustom = host.resolvePolicy(
  baseSettings({ mode: 'custom', proxy: '127.0.0.1:1', httpProxy: '127.0.0.1:2', httpsProxy: '127.0.0.1:3' }),
  sources,
)
check(
  'per-scheme overrides beat the shared address',
  perSchemeCustom.httpProxy === 'http://127.0.0.1:2' && perSchemeCustom.httpsProxy === 'http://127.0.0.1:3',
  `${perSchemeCustom.httpProxy} / ${perSchemeCustom.httpsProxy}`,
)

const credentialed = host.withCredentialedPolicy(custom, 'alice', 'p@ss')
check('credentials land in the URL', credentialed.httpProxy === 'http://alice:p%40ss@127.0.0.1:7890', credentialed.httpProxy)
check('the redacted view hides them', host.redactUrl(credentialed.httpProxy) === 'http://***@127.0.0.1:7890')

// ---------------------------------------------------------------- prompt

console.log('\n-- prompt text')
const promptUrl = host.renderPrompt(credentialed, { exposeToShell: 'url', authenticated: true })
check('the prompt names the proxy', promptUrl.includes('http://127.0.0.1:7890'))
check('the prompt never carries the password', !/p%40ss|alice:|secret/.test(promptUrl), 'a credential appeared in the prompt')
check('the address-only level explains the 407 case', promptUrl.includes('407'), 'no 407 guidance')
check('the address-only level describes the shell variable', promptUrl.includes('DSH_PROXY_URL'))
const promptFull = host.renderPrompt(credentialed, { exposeToShell: 'full', authenticated: true })
check('the full level still redacts the password', !/p%40ss|alice:/.test(promptFull), 'a credential appeared in the prompt')
check('the full level does not mention 407', !promptFull.includes('407'))
const promptOff = host.renderPrompt(credentialed, { exposeToShell: 'off', authenticated: true })
check('the off level says the shell gets nothing', promptOff.includes('no proxy settings'))
const directPrompt = host.renderPrompt(direct, { exposeToShell: 'url', authenticated: false })
const offPrompt = host.renderPrompt(disabled, { exposeToShell: 'url', authenticated: false })
check('a direct policy still has a notice when injection is on', directPrompt.includes('connect directly'), directPrompt)
check('a disabled component says it is not controlling routing', offPrompt.includes('not controlling'), offPrompt)
check('an inactive notice names no proxy URL', !/https?:\/\//.test(directPrompt + offPrompt))
check('routing and injection are independent settings', (() => {
  const value = host.normalizeSettings({ enabled: false, promptInjection: true })
  return value.enabled === false && value.promptInjection === true
})())
check('the prompt is English', promptUrl.startsWith('Network proxy'))

// A user template replaces the wording but must not be able to invent a proxy state:
// placeholders are the ONLY facts it can reach, and they come from the live policy.
const templated = host.renderPrompt(credentialed, { exposeToShell: 'url', authenticated: true, template: 'Proxy: {{proxy}} ({{source}})\nBypass: {{bypass}}' })
check('a template replaces the built-in wording', !templated.includes('Network proxy'), templated.slice(0, 60))
check('a template expands {{proxy}} from the live policy', templated.includes('127.0.0.1:7890'))
check('a template expands {{source}}', templated.includes('custom'))
check('a template expands {{bypass}}', templated.includes('127.0.0.1'))
check('a template never carries the password', !/p%40ss|alice:|secret/.test(templated), templated)
const unknownPlaceholder = host.renderPrompt(credentialed, { template: 'x {{nope}} y' })
check('an unknown placeholder stays literal so a typo is visible', unknownPlaceholder.includes('{{nope}}'), unknownPlaceholder)
const blankTemplate = host.renderPrompt(credentialed, { template: '   ' })
check('a whitespace-only template falls back to the built-in text', blankTemplate.startsWith('Network proxy'), blankTemplate.slice(0, 40))
check('a template renders with an inactive policy too', host.renderPrompt(direct, { template: 'x {{proxy}}{{source}}' }) === 'x direct')
const inactiveFacts = host.promptFacts(disabled, { exposeToShell: 'url' })
check('inactive facts do not promise shell proxy settings', inactiveFacts.shell.includes('no proxy settings') && inactiveFacts.state === '' && inactiveFacts.auth === '')
const facts = host.promptFacts(credentialed, { exposeToShell: 'url', authenticated: true })
check('the facts table never exposes a password', !/p%40ss|alice:/.test(JSON.stringify(facts)), JSON.stringify(facts))
check(
  'every advertised placeholder is actually substitutable',
  Object.keys(facts).every((name) => !host.renderPrompt(credentialed, { template: `{{${name}}}` }).includes('{{')),
  Object.keys(facts).join(','),
)

// ---------------------------------------------------------------- install env

console.log('\n-- save validation')
// A save must refuse a value the transport cannot honour. Falling through to a
// direct connection while reporting success is the one failure a proxy setting must
// never have: the user believes their traffic is routed when it is not.
check('a usable custom address passes', host.checkProxyFields(host.normalizeSettings({ enabled: true, mode: 'custom', proxy: '127.0.0.1:7890' })).length === 0)
check(
  'a socks5h address is refused with a reason',
  host.checkProxyFields(host.normalizeSettings({ enabled: true, mode: 'custom', proxy: 'socks5h://h:1' })).some((message) => message.includes('socks5h')),
  host.checkProxyFields(host.normalizeSettings({ enabled: true, mode: 'custom', proxy: 'socks5h://h:1' })).join(' | '),
)
check(
  'a malformed per-scheme address is refused',
  host.checkProxyFields(host.normalizeSettings({ enabled: true, mode: 'custom', httpsProxy: 'not a url' })).length > 0,
)
check(
  'the same bad address is tolerated while the source is not custom',
  host.checkProxyFields(host.normalizeSettings({ enabled: true, mode: 'direct', proxy: 'socks5h://h:1' })).length === 0,
)
check(
  'a non-http probe URL is refused',
  host.checkProxyFields(host.normalizeSettings({ probeUrl: 'ftp://h/x' })).length > 0,
  host.checkProxyFields(host.normalizeSettings({ probeUrl: 'ftp://h/x' })).join(' | '),
)
check(
  'a user name containing a colon is refused',
  host.checkProxyFields(host.normalizeSettings({ authUser: 'a:b' })).length > 0,
)

// Authentication is a PAIR: a password with no user name sends no header, so it must
// not be reported as configured.
const passwordOnly = host.withCredentialedPolicy(custom, '', 'secret')
check('a password with no user name adds no userinfo', passwordOnly.httpProxy === 'http://127.0.0.1:7890', passwordOnly.httpProxy)

console.log('\n-- transport environment')
const activeEnv = host.installEnvironment(credentialed)
check('an active policy installs both schemes', typeof activeEnv.http_proxy === 'string' && typeof activeEnv.https_proxy === 'string')
check('it carries the loopback bypass', activeEnv.no_proxy.includes('127.0.0.1'))
check(
  'it writes both casings, because the transport reads either',
  activeEnv.HTTP_PROXY === activeEnv.http_proxy && activeEnv.HTTPS_PROXY === activeEnv.https_proxy,
)
const directEnv = host.installEnvironment(direct)
check('a direct policy installs a bypass-everything agent', directEnv.no_proxy === '*', directEnv.no_proxy)
check('and the placeholder is never a real proxy', directEnv.http_proxy === 'http://127.0.0.1:1', directEnv.http_proxy)

// THE TWO "NOT PROXIED" STATES ARE DIFFERENT, and confusing them changes a user's
// routing behind their back:
//   off    -> install nothing, so the launcher's own policy keeps working;
//   direct -> install a bypass, because the user asked to override that policy.
const offEnv = host.installEnvironment(disabled)
check(
  'a switched-off component installs NOTHING (the launcher policy keeps working)',
  offEnv === undefined,
  JSON.stringify(offEnv),
)
const enabledButEmpty = host.installEnvironment(
  host.resolvePolicy(host.normalizeSettings({ enabled: true, mode: 'custom', proxy: '' }), {
    system: { enabled: false },
    env: {},
  }),
)
check('switched on with nothing configured also installs nothing', enabledButEmpty === undefined, JSON.stringify(enabledButEmpty))

const transport = host.createTransport()
check('a transport is available', typeof transport.install === 'function', String(transport.kind))
check('it reports what it covers', typeof transport.covers === 'string' && transport.covers.length > 0, transport.covers)
check(
  'the native switch is used when the runtime has it',
  typeof http.setGlobalProxyFromEnv !== 'function' || transport.kind === 'native',
  transport.kind,
)

// ---------------------------------------------------------------- live routing

console.log('\n-- live routing (local proxy, no network)')
const observed = []
const proxyServer = http.createServer((request, response) => {
  observed.push(`absolute ${request.url} auth=${request.headers['proxy-authorization'] ?? '-'}`)
  response.writeHead(200)
  response.end('proxied')
})
proxyServer.on('connect', (request, socket) => {
  observed.push(`connect ${request.url} auth=${request.headers['proxy-authorization'] ?? '-'}`)
  socket.end('HTTP/1.1 200 Connection Established\r\n\r\n')
})
const originServer = http.createServer((request, response) => {
  observed.push(`direct ${request.url}`)
  response.writeHead(200)
  response.end('direct')
})
await new Promise((resolve) => proxyServer.listen(0, '127.0.0.1', resolve))
await new Promise((resolve) => originServer.listen(0, '127.0.0.1', resolve))
const proxyPort = proxyServer.address().port
const originPort = originServer.address().port

/** Issue one request and report where it landed. */
async function route(url) {
  observed.length = 0
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1200) })
    await response.text()
  } catch {
    // A name that cannot resolve is an expected outcome; what matters is where it went.
  }
  return [...observed]
}

const proxyPolicy = host.resolvePolicy(baseSettings({ mode: 'custom', proxy: `127.0.0.1:${proxyPort}` }), {})
const undo = await transport.install(host.installEnvironment(host.withCredentialedPolicy(proxyPolicy, 'alice', 'p@ss')))

const throughProxy = await route('https://proxy-verify.invalid/x')
check(
  'an https request is tunnelled through the proxy',
  throughProxy.some((entry) => entry.startsWith('connect proxy-verify.invalid:443')),
  JSON.stringify(throughProxy),
)
check(
  'the proxy receives Basic credentials',
  throughProxy.some((entry) => entry.includes('auth=Basic')),
  JSON.stringify(throughProxy),
)

const loopback = await route(`http://127.0.0.1:${originPort}/local`)
check(
  'loopback bypasses the proxy',
  loopback.some((entry) => entry.startsWith('direct /local')),
  JSON.stringify(loopback),
)

const nested = host.installEnvironment(host.resolvePolicy(baseSettings({ mode: 'direct' }), {}))
const undoNested = await transport.install(nested)
const forcedDirect = await route('https://forced-direct.invalid/x')
check(
  'a direct policy overrides the installed proxy',
  forcedDirect.every((entry) => !entry.startsWith('connect forced-direct')),
  JSON.stringify(forcedDirect),
)
await undoNested()

const restored = await route('https://restored.invalid/x')
check(
  'restoring the outer install puts the proxy back',
  restored.some((entry) => entry.startsWith('connect restored.invalid:443')),
  JSON.stringify(restored),
)
await undo()

const afterUndo = await route('https://after-undo.invalid/x')
check(
  'restoring to the bottom leaves no proxy installed',
  afterUndo.every((entry) => !entry.startsWith('connect after-undo')),
  JSON.stringify(afterUndo),
)

// The component must never write its policy into the process environment: a child
// spawned by a shell tool inherits that environment, and a credential in it would
// be readable by every command the model runs.
check(
  'the process environment is never given a proxy name',
  !Object.keys(process.env).some((key) => /^(http|https|all|no)_proxy$/i.test(key)),
  Object.keys(process.env).filter((key) => /proxy/i.test(key)).join(','),
)

proxyServer.closeAllConnections?.()
originServer.closeAllConnections?.()
proxyServer.close()
originServer.close()

// ---------------------------------------------------------------- probe reporting

console.log('\n-- connectivity probe reporting')
// The probe answers two questions at once and must not conflate them: whether the
// request succeeded, and whether it went through the proxy. A direct connection can
// succeed while the proxy is broken, so the route travels with the result.
const probeOrigin = http.createServer((request, response) => {
  response.writeHead(204)
  response.end()
})
await new Promise((resolve) => probeOrigin.listen(0, '127.0.0.1', resolve))
const probePort = probeOrigin.address().port

const directProbe = await host.probeRoute({
  settings: host.normalizeSettings({ probeUrl: `http://127.0.0.1:${probePort}/x` }),
  policy: host.resolvePolicy(baseSettings({ mode: 'direct' }), {}),
  transport: { kind: 'native' },
})
check('the probe reports its own route', directProbe.route !== undefined, JSON.stringify(directProbe))
check('a direct probe says it was not proxied', directProbe.route.proxied === false, JSON.stringify(directProbe.route))
check('a direct probe still reports success', directProbe.ok === true, directProbe.error)

const proxiedProbe = await host.probeRoute({
  settings: host.normalizeSettings({ probeUrl: 'http://127.0.0.1:9/x' }),
  policy: host.withCredentialedPolicy(host.resolvePolicy(baseSettings({ mode: 'custom', proxy: '127.0.0.1:1' }), {}), 'u', 'p'),
  transport: { kind: 'native' },
})
check('a proxied probe names the proxy', proxiedProbe.route.proxied === true, JSON.stringify(proxiedProbe.route))
check(
  'the probe never carries a credential',
  !/u:p@|@127/.test(JSON.stringify(proxiedProbe)),
  JSON.stringify(proxiedProbe.route),
)

probeOrigin.closeAllConnections?.()
probeOrigin.close()

// ---------------------------------------------------------------- persistence

console.log('\n-- persistence')
const directory = await mkdtemp(join(tmpdir(), 'npd-proxy-verify-'))
const file = join(directory, host.SETTINGS_FILE)
const absent = await host.readSettings(file)
check('an absent file is not an error', absent.diagnostics.length === 0 && absent.settings.enabled === false)
await host.writeSettings(file, { ...host.DEFAULT_SETTINGS, enabled: true, proxy: '127.0.0.1:7890', authUser: 'alice' })
const roundTrip = await host.readSettings(file)
check('a written file reads back', roundTrip.settings.enabled === true && roundTrip.settings.proxy === '127.0.0.1:7890')
check('the user name survives', roundTrip.settings.authUser === 'alice')
const text = await readFile(file, 'utf8')
check('the file is indented JSON', text.includes('\n  "enabled"'), text.slice(0, 40))
check('the file never stores a password', !text.toLowerCase().includes('password') && !text.includes('p@ss'), 'a password-like key appeared')
await writeFile(file, '{ not json', 'utf8')
const corrupt = await host.readSettings(file)
check('a corrupt file degrades to defaults', corrupt.settings.enabled === false && corrupt.diagnostics.length === 1, corrupt.diagnostics.join(' | '))
await writeFile(file, JSON.stringify({ enabled: true, mode: 'nonsense', extra: 1 }), 'utf8')
const partial = await host.readSettings(file)
check('a partial file fills its gaps', partial.settings.mode === 'auto' && partial.settings.enabled === true)
await rm(directory, { recursive: true, force: true })

// ---------------------------------------------------------------- client half

console.log('\n-- browser half')
let captured
globalThis.window = { __ModuleLoader__: { load: (entry) => (captured = entry) } }
// eslint-disable-next-line no-eval
new Function('window', readFileSync(new URL('../proxy/client.js', import.meta.url), 'utf8'))(globalThis.window)

check('the browser half registers under its own package id', captured?.id === 'dsh-notpdpton-proxy', captured?.id)

const reactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: 'fragment',
  useCallback: (fn) => fn,
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
}

const client = captured.factory((id) => {
  if (id === 'react') return reactStub
  throw new Error(`unexpected require: ${id}`)
})

check('the browser half exports apply()', typeof client.apply === 'function')
check('the browser half declares its dependencies', Array.isArray(client.inject) && client.inject.includes('slots'))
check(
  'the browser half reads only the shipped client services',
  client.inject.includes('locale') && !client.inject.includes('connection') && !client.inject.includes('remote.credentials'),
  client.inject.join(','),
)
check(
  'the browser half never imports a client primitive package',
  !readFileSync(new URL('../proxy/client.js', import.meta.url), 'utf8').includes('@deepseek-ai/dsh-client-ui-primitives'),
)
// The two halves agree on the wire contract. A statically loaded client half cannot
// reach `connection.rpc` at all, so the shared value is the HTTP route path — and a
// mismatch here is a silently empty settings block, not an error message.
check('the route path matches the Host half', client.proxySettings.ROUTE_PATH === host.ROUTE_PATH, `${client.proxySettings.ROUTE_PATH} vs ${host.ROUTE_PATH}`)
check('the credential reference matches the Host half', client.proxySettings.PASSWORD_REF === host.PASSWORD_REF)
const clientSource = readFileSync(new URL('../proxy/client.js', import.meta.url), 'utf8')
check(
  'the browser half never calls a service the client sandbox does not have',
  !clientSource.includes('connection.rpc') || !/const rpc = .*connection/.test(clientSource),
  'the block still reads connection.rpc',
)
check('the browser half reaches the Host over fetch', clientSource.includes("await fetch(ROUTE_PATH"), 'no fetch call to the route')
check(
  'the browser half reports a load failure instead of rendering an empty block',
  clientSource.includes('status.loading') && clientSource.includes('error.status'),
)

const registrations = []
const ctx = {
  locale: {
    register: (namespace, dicts) => {
      registrations.push({ kind: 'locale', namespace, dicts })
      return () => {}
    },
    bind: () => (key) => key,
  },
  effect: (fn) => fn(),
  get: () => undefined,
  remote: { credentials: { describe: async () => ({}), set: async () => {}, unset: async () => {} } },
  slots: {
    inject: (slot, callback) => {
      callback()
      return () => {}
    },
    register: (options, component) => {
      registrations.push({ kind: 'slot', options, component })
      return () => {}
    },
  },
}
client.apply(ctx)

const locale = registrations.find((entry) => entry.kind === 'locale')
check('the browser half registers its locale namespace', locale?.namespace === 'notpdptonProxy', locale?.namespace)
check('both dictionaries ship', typeof locale?.dicts?.zh === 'object' && typeof locale?.dicts?.en === 'object')
check(
  'both dictionaries carry the same keys',
  JSON.stringify(Object.keys(locale.dicts.zh).sort()) === JSON.stringify(Object.keys(locale.dicts.en).sort()),
  'the dictionaries disagree',
)
const emptyValues = Object.entries(locale.dicts.zh).filter(([, value]) => typeof value !== 'string' || value === '')
check('every Chinese string is present', emptyValues.length === 0, emptyValues.map(([key]) => key).join(','))
const missingEn = Object.entries(locale.dicts.en).filter(([, value]) => typeof value !== 'string' || value === '')
check('every English string is present', missingEn.length === 0, missingEn.map(([key]) => key).join(','))

// The status line translates the EFFECTIVE source through the mode keys, but two of
// the values it can report are not modes a user can pick. A missing key would print
// a raw dictionary name in the one place that states what is actually in force.
for (const source of ['custom', 'system', 'env', 'direct', 'off', 'none']) {
  check(`the status line can name the "${source}" source`, typeof locale.dicts.zh[`mode.${source}`] === 'string', `mode.${source}`)
}

const slots = registrations.filter((entry) => entry.kind === 'slot')
check('the browser half registers exactly one surface', slots.length === 1, String(slots.length))
const registration = slots[0]
check('the surface is the pack page block slot', registration?.options.name === 'notpdpton.settings.group', registration?.options.name)
check('the block has its own id', registration?.options.id === 'networkProxy', registration?.options.id)
check('the block sorts after the other two', registration?.options.order === 20, String(registration?.options.order))
check('the block never opens a settings page of its own', !slots.some((entry) => entry.options.name === 'settings.section'))
check('the block binds its locale namespace', registration?.options.locale === 'notpdptonProxy')
check('a block component is registered', typeof registration?.component === 'function')

// Render the block against a stub React tree and assert what it hands the page.
// The component starts empty until the Host answers, which is the behaviour an
// offline run can observe: it must still return a block, never throw.
const rendered = registration.component({ t: (key) => locale.dicts.zh[key] ?? key, Group: (block) => block, rpc: undefined, credentials: undefined })
check('the block renders before any Host reply', rendered !== null && rendered !== undefined)
check('it is a block, not markup of its own', typeof rendered?.title === 'string' && Array.isArray(rendered?.items))
check('the block heading is the feature name', rendered.title === '网络代理', rendered.title)
check('the block starts with no fields until the state arrives', Array.isArray(rendered.fields))

console.log(failures === 0 ? `\nOK: proxy component verifies${skipped === 0 ? '' : ` (${skipped} skipped)`}` : `\nFAIL: ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
