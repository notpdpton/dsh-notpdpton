/**
 * Host half of 网络代理 (dsh-notpdpton-proxy).
 *
 * Routes THIS Host process's outbound HTTP(S) through a proxy and tells the model
 * that the proxy exists. Three things make the implementation what it is:
 *
 *   1. TRANSPORT. `node:http.setGlobalProxyFromEnv()` is the one switch that
 *      reaches both stacks a Host request can travel on: undici's global
 *      dispatcher (what `fetch` resolves, so the model API, web_fetch and HTTP
 *      MCP servers) and `http(s).globalAgent` (what an SDK building its own
 *      request uses). Installing an undici dispatcher by hand would cover only
 *      the first. The function returns a `restore()` closure, which is exactly
 *      the disposer a Cordis effect wants.
 *
 *   2. SECRETS. That switch takes an ENVIRONMENT OBJECT. Handing it a synthetic
 *      one instead of writing `process.env` is what keeps a proxy password out of
 *      the process environment: children spawned by the shell tools inherit
 *      `process.env`, and a credential in it would be visible to every command
 *      the model runs. The password travels as URL userinfo into the agent and
 *      stops there; `process.env` is never touched, so nothing has to be stripped
 *      afterwards and no restore can leak it back.
 *
 *   3. LAYERING. The launcher may already have installed a policy from the user's
 *      own `http_proxy`/`ALL_PROXY` (`@deepseek-ai/dsh-http-proxy`). Installing on
 *      top leaves that policy in place underneath, and `restore()` returns to it
 *      rather than to a bare process — so switching this component off undoes
 *      exactly this component's change.
 *
 * This module imports NO npm package. The Host resolves plugin modules from the
 * profile, but a plugin linked from outside it cannot resolve `undici` or
 * `@deepseek-ai/schemastery` (verified), so the module deliberately depends only
 * on Node builtins and on services read from `ctx`. That is also why it declares
 * no `Config`: a schema would need schemastery. Settings live in the profile's
 * `notpdpton-proxy.json`, written through this component's own RPC channel.
 *
 * @module dsh-notpdpton-proxy
 */

import { execFile } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Host plugin name, used in diagnostics. */
export const name = 'notpdptonProxy'

/**
 * Soft dependencies only: every service below is reached through `ctx.inject`,
 * so a profile that composes this component without one of them still loads and
 * simply contributes less.
 */
export const inject = []

/** RPC channel the browser half and this half share. */
export const RPC_CHANNEL = '/notpdpton-proxy'

/**
 * The HTTP path the browser half POSTs to.
 *
 * A statically loaded client half has no module loader and no service directory —
 * its sandbox offers `fetch` and `ctx` only — so the shipped web server's exact
 * route is the channel it can actually reach. The path is namespaced under the
 * package name so it cannot collide with another plugin's route.
 */
export const ROUTE_PATH = '/notpdpton-proxy/state'

/** File name (beside the profile's patch) that holds the persisted settings. */
export const SETTINGS_FILE = 'notpdpton-proxy.json'

/** Credential reference naming the proxy password. */
export const PASSWORD_REF = 'DSH_NOTPDPTON_PROXY_PASSWORD'

/**
 * Loopback entries merged into every effective bypass list.
 *
 * A proxy that also serves the harness's own loopback traffic turns the Web UI,
 * the Connection transport and every local test server into a routing loop. The
 * native matcher does NOT bypass loopback on its own (verified: a bare
 * `127.0.0.1` target is proxied unless listed), so this is not optional.
 *
 * `::1` and `[::1]` are both listed because undici reads a bare `::1` as host
 * `:` port `1` and would therefore never bypass it.
 */
export const LOOPBACK_NO_PROXY = ['localhost', '127.0.0.1', '::1', '[::1]']

/** Proxy URL schemes this component routes through. */
export const SUPPORTED_SCHEMES = ['http:', 'https:', 'socks:', 'socks5:']

/** Settings sources, in the order `auto` tries them. */
export const MODES = ['auto', 'system', 'custom', 'env', 'direct']

/** How much of the proxy URL the shell environment may receive. */
export const SHELL_EXPOSURES = ['off', 'url', 'full']

/** Proxy names this component reads from the launch environment. */
export const ENV_NAMES = ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY', 'no_proxy', 'NO_PROXY']

/** Defaults for every persisted field. */
export const DEFAULT_SETTINGS = {
  /** Off by default: a component that silently rewrites routing on install would surprise the user. */
  enabled: false,
  /** Where a proxy comes from when enabled. */
  mode: 'auto',
  /** One URL for both schemes. */
  proxy: '',
  /** Per-scheme overrides; a blank slot falls back to `proxy`. */
  httpProxy: '',
  httpsProxy: '',
  /** Extra bypass entries, comma or semicolon separated. */
  noProxy: '',
  /** Basic-auth user name; the password lives in the credential store. */
  authUser: '',
  /** What the shell tools receive through `DSH_PROXY_*`. */
  exposeToShell: 'url',
  /**
   * Whether the model is told about this component's network state. Independent of
   * `enabled`: switching routing off must not switch the notice off, and vice versa.
   */
  promptInjection: true,
  /**
   * User template for the injected notice. An empty string means "use the built-in
   * rendering", which is the shipped default: the built-in text always reflects the
   * live policy, so a typo in a custom template cannot silently disable routing facts.
   */
  promptTemplate: '',
  /** URL the UI's test button requests. */
  probeUrl: 'https://www.gstatic.com/generate_204',
}

/**
 * Starter template shown in the editor when the saved template is empty.
 *
 * This is NOT the built-in rendering: an empty `promptTemplate` still means "use the
 * built-in wording", because only that can reflect the live policy. The starter
 * exists so the editor opens with the placeholders visible and editable instead of
 * an empty box with an example placeholder. It references only facts from
 * {@link promptFacts}, so rendering it can never invent proxy state.
 */
export const DEFAULT_TEMPLATE = [
  'Network proxy',
  '- This Harness process sends its outbound HTTP(S) traffic through {{proxy}} (source: {{source}}).',
  '- These hosts are contacted directly instead: {{bypass}}.',
  '{{shell}}',
  '{{state}}',
  '{{auth}}',
  '{{settings}}',
].join('\n')

/**
 * Schemes recognised well enough to explain why they are refused, rather than
 * reported as a malformed URL.
 */
const REJECTED_SCHEMES = new Map([
  ['socks5h:', 'socks5h:// is not supported by the Node transport; use socks5:// so the proxy resolves the name'],
  ['socks4:', 'socks4:// is not supported; use http://, https:// or socks5://'],
  ['socks4a:', 'socks4a:// is not supported; use http://, https:// or socks5://'],
  ['ftp:', 'only http, https and socks5 proxies are supported'],
  ['file:', 'only http, https and socks5 proxies are supported'],
])

// ---------------------------------------------------------------- pure logic

/**
 * Normalize one raw settings object into exactly {@link DEFAULT_SETTINGS}'s shape.
 *
 * The file is user-editable and may predate a field, so every unknown key is
 * dropped and every missing one takes its default. A value of the wrong type is
 * replaced by its default rather than coerced: a number in `mode` would otherwise
 * silently select nothing.
 *
 * @param raw - whatever was on disk (or `undefined` when absent).
 * @returns complete settings.
 */
export function normalizeSettings(raw) {
  const source = typeof raw === 'object' && raw !== null ? raw : {}
  const pickBool = (key) => (typeof source[key] === 'boolean' ? source[key] : DEFAULT_SETTINGS[key])
  const pickEnum = (key, allowed) =>
    typeof source[key] === 'string' && allowed.includes(source[key]) ? source[key] : DEFAULT_SETTINGS[key]
  const pickText = (key) => (typeof source[key] === 'string' ? source[key].trim() : DEFAULT_SETTINGS[key])
  return {
    enabled: pickBool('enabled'),
    mode: pickEnum('mode', MODES),
    proxy: pickText('proxy'),
    httpProxy: pickText('httpProxy'),
    httpsProxy: pickText('httpsProxy'),
    noProxy: pickText('noProxy'),
    authUser: pickText('authUser'),
    exposeToShell: pickEnum('exposeToShell', SHELL_EXPOSURES),
    promptInjection: pickBool('promptInjection'),
    // Kept verbatim rather than trimmed: users format the template deliberately, and
    // an all-whitespace value must still read as "use the built-in rendering".
    promptTemplate: typeof source.promptTemplate === 'string' ? source.promptTemplate : DEFAULT_SETTINGS.promptTemplate,
    probeUrl: pickText('probeUrl') || DEFAULT_SETTINGS.probeUrl,
  }
}

/**
 * Split a bypass list into trimmed, non-empty entries.
 *
 * Windows writes `;`, everything else writes `,` or spaces, and a user pastes
 * whichever they saw last, so all three are separators. A pasted `<local>` is
 * kept as an entry here; {@link translateBypass} decides what it can mean.
 *
 * @param list - the raw bypass list.
 * @returns the entries.
 */
export function splitBypass(list) {
  return String(list ?? '')
    .split(/[,;\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}

/**
 * Turn a bypass list into the form Node's proxy matcher understands, and report
 * what could not be expressed.
 *
 * The matcher's rules — verified against the runtime, not assumed — are: `*`
 * bypasses everything; an entry matches its exact host and every subdomain; a
 * leading `.` or `*.` is the same thing; `host:port` pins the port. It has NO
 * concept of a partial-label wildcard and no concept of "a name without a dot",
 * which is what Windows means by `10.*` and `<local>`.
 *
 * Those two forms are therefore dropped rather than passed through: an entry the
 * matcher cannot honour would otherwise look honoured while routing the traffic
 * to the proxy anyway. They are returned as `unsupported` so the UI can say so
 * out loud. A `127.*` entry is dropped for the same reason and reported the same
 * way — `LOOPBACK_NO_PROXY` covers exactly `127.0.0.1`, not the whole `127/8`
 * block, which the matcher cannot express either.
 *
 * @param list - the raw bypass list.
 * @returns the expressible entries and the dropped ones.
 */
export function translateBypass(list) {
  const kept = []
  const unsupported = []
  for (const entry of splitBypass(list)) {
    if (entry === '*') return { entries: ['*'], unsupported: [] }
    if (entry.toLowerCase() === '<local>' || entry.toLowerCase() === '<-loopback>') {
      unsupported.push(entry)
      continue
    }
    // A `*` anywhere but the leading `*.` label cannot be expressed.
    if (/\*/.test(entry.replace(/^\*\./, ''))) {
      unsupported.push(entry)
      continue
    }
    kept.push(entry)
  }
  return { entries: kept, unsupported }
}

/**
 * Merge the loopback bypass into an entry list.
 *
 * @param entries - already-translated entries.
 * @returns the effective list as the comma-separated string the matcher reads.
 */
export function withLoopback(entries) {
  if (entries.includes('*')) return '*'
  const present = new Set(entries.map((entry) => entry.toLowerCase()))
  return [...entries, ...LOOPBACK_NO_PROXY.filter((entry) => !present.has(entry))].join(',')
}

/**
 * Validate and canonicalize one proxy URL.
 *
 * A bare `host:port` is accepted and read as `http://host:port`, because that is
 * how Windows stores it and how people paste it. Everything else must parse and
 * carry a scheme this transport can use. Path, query and fragment are dropped:
 * a proxy endpoint has none, and a stray one is almost always a pasted address
 * bar URL.
 *
 * @param value - the raw URL.
 * @returns the canonical URL with its parsed form, or the reason it is unusable.
 */
export function parseProxyUrl(value) {
  const text = String(value ?? '').trim()
  if (text === '') return { kind: 'absent' }
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`
  let url
  try {
    url = new URL(candidate)
  } catch {
    return { kind: 'invalid', message: `"${text}" is not a valid proxy URL` }
  }
  const rejected = REJECTED_SCHEMES.get(url.protocol)
  if (rejected !== undefined) return { kind: 'invalid', message: rejected }
  if (!SUPPORTED_SCHEMES.includes(url.protocol)) {
    return { kind: 'invalid', message: `the ${url.protocol}// scheme is not supported; use http://, https:// or socks5://` }
  }
  if (url.hostname === '') return { kind: 'invalid', message: `"${text}" names no proxy host` }
  return {
    kind: 'valid',
    url,
    value: `${url.protocol}//${url.host}`,
    experimental: url.protocol === 'socks:' || url.protocol === 'socks5:',
  }
}

/**
 * Put credentials into a canonical proxy URL.
 *
 * The result is handed to the transport and nowhere else, so this is the only
 * place a password exists in memory next to the routing decision.
 *
 * @param canonical - `scheme://host:port`, as {@link parseProxyUrl} returns it.
 * @param user - user name, or empty for no authentication.
 * @param password - password, or empty.
 * @returns the URL to install.
 */
export function withCredentials(canonical, user, password) {
  if (user === '' || password === '') return canonical
  const separator = canonical.indexOf('://') + 3
  return `${canonical.slice(0, separator)}${encodeURIComponent(user)}:${encodeURIComponent(password)}@${canonical.slice(separator)}`
}

/**
 * Replace any URL userinfo with a fixed marker.
 *
 * Everything that leaves this module — RPC replies, the prompt, diagnostics —
 * goes through here, so a password cannot reach the model or a screenshot.
 *
 * @param value - a URL that may carry credentials.
 * @returns the same URL with `user:password@` replaced by `***@`.
 */
export function redactUrl(value) {
  const text = String(value ?? '')
  const separator = text.indexOf('://')
  if (separator < 0) return text
  const rest = text.slice(separator + 3)
  const at = rest.lastIndexOf('@')
  if (at < 0) return text
  return `${text.slice(0, separator + 3)}***@${rest.slice(at + 1)}`
}

/**
 * Drop userinfo entirely.
 *
 * Used for the shell level that withholds credentials and for the prompt, where a
 * masked marker would suggest a usable URL.
 *
 * @param url - a URL that may carry userinfo.
 * @returns the URL without it.
 */
export function stripCredentials(url) {
  const text = String(url ?? '')
  const separator = text.indexOf('://')
  if (separator < 0) return text
  const rest = text.slice(separator + 3)
  const at = rest.lastIndexOf('@')
  if (at < 0) return text
  return `${text.slice(0, separator + 3)}${rest.slice(at + 1)}`
}

/**
 * Read the proxy policy out of a Windows `ProxyServer` value.
 *
 * The registry stores either `host:port` for every protocol or a
 * `http=host:port;https=host:port` list. Both spellings are common and neither is
 * self-announcing beyond the `=`.
 *
 * @param server - the raw registry value.
 * @returns one canonical URL per scheme, or the reason the value is unusable.
 */
export function parseWindowsProxyServer(server) {
  const text = String(server ?? '').trim()
  if (text === '') return {}
  if (!text.includes('=')) {
    const single = parseProxyUrl(text)
    if (single.kind === 'invalid') return { invalid: single.message }
    if (single.kind === 'absent') return {}
    return { http: single.value, https: single.value }
  }
  const result = {}
  for (const part of text.split(';')) {
    const equals = part.indexOf('=')
    if (equals < 0) continue
    const scheme = part.slice(0, equals).trim().toLowerCase()
    const parsed = parseProxyUrl(part.slice(equals + 1))
    if (parsed.kind !== 'valid') continue
    if (scheme === 'socks') result.socks = parsed.value
    else if (scheme === 'http' || scheme === 'https') result[scheme] = parsed.value
  }
  return result
}

/**
 * Decide the effective policy for one settings snapshot.
 *
 * Resolution is a chain, not a priority list applied after the fact: `custom`
 * consults only the component's own fields, `system` only the platform registry,
 * `env` only the launch environment, and `auto` walks custom → system → env. The
 * first source that yields at least one usable URL wins as a whole; a half-filled
 * source does not merge with the next one, so the UI can always name the single
 * place the routing came from.
 *
 * @param settings - normalized settings.
 * @param sources - the readings the chain may consult.
 * @returns the policy: per-scheme URLs, the bypass list, and provenance.
 */
export function resolvePolicy(settings, sources) {
  const { system, env } = sources
  const notes = []

  /** Read the component's own fields, falling back per scheme to `proxy`. */
  const fromCustom = () => {
    const shared = parseProxyUrl(settings.proxy)
    const secure = parseProxyUrl(settings.httpProxy)
    const encrypted = parseProxyUrl(settings.httpsProxy)
    for (const parsed of [shared, secure, encrypted]) {
      if (parsed.kind === 'invalid') notes.push(parsed.message)
    }
    const sharedValue = shared.kind === 'valid' ? shared.value : undefined
    return {
      httpProxy: secure.kind === 'valid' ? secure.value : sharedValue,
      httpsProxy: encrypted.kind === 'valid' ? encrypted.value : sharedValue,
      noProxy: settings.noProxy,
      experimental: [shared, secure, encrypted].some((parsed) => parsed.kind === 'valid' && parsed.experimental === true),
    }
  }

  const fromSystem = () => {
    if (system === undefined || system === null) return undefined
    if (typeof system.autoConfigUrl === 'string' && system.autoConfigUrl !== '') {
      notes.push('a PAC script (AutoConfigURL) is configured; PAC is not supported and was ignored')
    }
    if (system.enabled !== true) return undefined
    const parsed = parseWindowsProxyServer(system.server)
    if (parsed.invalid !== undefined) notes.push(parsed.invalid)
    const httpProxy = parsed.http ?? parsed.socks
    if (httpProxy === undefined && parsed.https === undefined) return undefined
    return {
      httpProxy,
      httpsProxy: parsed.https ?? httpProxy,
      noProxy: system.override ?? '',
      experimental: parsed.socks !== undefined && parsed.http === undefined,
    }
  }

  const fromEnv = () => {
    if (env === undefined || env === null) return undefined
    const read = (lower) => {
      for (const name of [lower, lower.toUpperCase()]) {
        const value = env[name]
        if (typeof value === 'string' && value.trim() !== '') return value.trim()
      }
      return undefined
    }
    const take = (value) => {
      if (value === undefined) return undefined
      const parsed = parseProxyUrl(value)
      if (parsed.kind === 'invalid') {
        notes.push(parsed.message)
        return undefined
      }
      return parsed.kind === 'valid' ? parsed.value : undefined
    }
    const all = take(read('all_proxy'))
    const httpProxy = take(read('http_proxy')) ?? all
    const httpsProxy = take(read('https_proxy')) ?? all ?? httpProxy
    if (httpProxy === undefined && httpsProxy === undefined) return undefined
    return { httpProxy, httpsProxy, noProxy: env.no_proxy ?? env.NO_PROXY ?? '', experimental: false }
  }

  const direct = {
    active: false,
    source: 'direct',
    httpProxy: undefined,
    httpsProxy: undefined,
    noProxy: withLoopback([]),
    entries: [],
    unsupported: [],
    experimental: false,
    notes,
  }

  if (settings.enabled !== true) return { ...direct, source: 'off' }

  const order = settings.mode === 'auto' ? ['custom', 'system', 'env'] : [settings.mode]
  for (const origin of order) {
    const candidate =
      origin === 'custom' ? fromCustom() : origin === 'system' ? fromSystem() : origin === 'env' ? fromEnv() : undefined
    if (candidate === undefined || candidate === null) continue
    if (candidate.httpProxy === undefined && candidate.httpsProxy === undefined) continue
    const translated = translateBypass(candidate.noProxy)
    for (const entry of translated.unsupported) {
      notes.push(`bypass entry "${entry}" cannot be expressed by the Node proxy matcher and was dropped`)
    }
    return {
      active: true,
      source: origin,
      httpProxy: candidate.httpProxy,
      httpsProxy: candidate.httpsProxy,
      noProxy: withLoopback(translated.entries),
      entries: translated.entries,
      unsupported: translated.unsupported,
      experimental: candidate.experimental === true,
      notes,
    }
  }

  // Enabled, but no source yielded an address. This is NOT the user asking for a
  // direct connection — it is an incomplete configuration, and the two must install
  // differently: `direct` overrides the layer beneath, while this must leave the
  // process exactly as the launcher set it up. The source name carries the
  // distinction so `installEnvironment` can tell them apart.
  if (settings.mode !== 'direct') {
    notes.push('no proxy is configured for the selected source; connecting directly')
    return { ...direct, source: 'none' }
  }
  return direct
}

/**
 * Build the synthetic environment handed to the transport, or `undefined` when this
 * component has nothing to install.
 *
 * Two distinct "not proxied" states exist and they must not be confused:
 *
 *   - `off` — the user switched the component off, or it is switched on but no
 *     source yielded an address. Nothing is installed at all, so whatever the
 *     launcher already put in place (the user's own `http_proxy`/`ALL_PROXY`)
 *     keeps working exactly as it did before this component was installed. A
 *     component that is switched off must not change anything.
 *
 *   - `direct` — the user explicitly chose "connect directly". That is a request
 *     to OVERRIDE the layer beneath, so an agent that bypasses everything is
 *     installed. Doing nothing here would leave the launcher's proxy in force and
 *     the user's choice would silently not take effect.
 *
 * @param policy - the resolved policy.
 * @returns the environment object, or undefined for no installation.
 */
export function installEnvironment(policy) {
  if (policy.active === true) {
    const env = { __proto__: null, no_proxy: policy.noProxy }
    if (policy.httpProxy !== undefined) {
      env.http_proxy = policy.httpProxy
      env.HTTP_PROXY = policy.httpProxy
    }
    if (policy.httpsProxy !== undefined) {
      env.https_proxy = policy.httpsProxy
      env.HTTPS_PROXY = policy.httpsProxy
    }
    return env
  }
  // Switched off, or on with nothing configured: leave the process alone. Both
  // report a non-active policy that the launcher layer already covers.
  if (policy.source === 'off' || policy.source === 'none') return undefined
  // 127.0.0.1:1 is a reserved port no proxy can be listening on; it is only there
  // to make the transport build an agent at all, and `*` means it is never dialled.
  const placeholder = 'http://127.0.0.1:1'
  return { __proto__: null, no_proxy: '*', http_proxy: placeholder, https_proxy: placeholder }
}

/**
 * Report the settings fields a save must refuse.
 *
 * A source that owns a value the transport cannot use must not silently resolve to
 * "direct": the user typed an address, expects traffic to go through it, and a save
 * that reports success while routing nothing is the one failure mode this component
 * must never ship. The check is separate from {@link resolvePolicy} because a bad
 * value there is only a diagnostic — a corrupted file at boot must still let the
 * Harness start — while a bad value in a SAVE is the user's active mistake.
 *
 * @param settings - normalized settings.
 * @returns one message per unusable field, empty when the draft is storable.
 */
export function checkProxyFields(settings) {
  const errors = []
  const custom = settings.mode === 'custom' || settings.mode === 'auto'
  if (custom) {
    for (const [field, value] of [
      ['proxy', settings.proxy],
      ['httpProxy', settings.httpProxy],
      ['httpsProxy', settings.httpsProxy],
    ]) {
      const parsed = parseProxyUrl(value)
      if (parsed.kind === 'invalid') errors.push(`${field}: ${parsed.message}`)
    }
  }
  const probe = (() => {
    const text = String(settings.probeUrl ?? '').trim()
    if (text === '') return { ok: false }
    try {
      const url = new URL(text)
      return { ok: url.protocol === 'http:' || url.protocol === 'https:' }
    } catch {
      return { ok: false }
    }
  })()
  if (!probe.ok) errors.push('probeUrl must be an absolute http:// or https:// URL')
  if (settings.authUser !== '' && settings.authUser.includes(':')) {
    errors.push('authUser cannot contain ":" because it is sent as the Basic-auth user name')
  }
  return errors
}

/**
 * Values a user template can reference, and the built-in text for each.
 *
 * The same table drives BOTH the built-in rendering and template substitution, so a
 * template cannot describe a proxy state the policy does not have: it can only
 * arrange the facts this component actually knows.
 */
export function promptFacts(policy, options) {
  const active = policy.active === true
  const proxy = stripCredentials(policy.httpsProxy ?? policy.httpProxy ?? '')
  const bypass = splitBypass(policy.noProxy)
  const shellLine = active
    ? options.exposeToShell === 'off'
      ? 'Shell commands receive no proxy settings; a command that needs the proxy has to be given one by the user.'
      : options.exposeToShell === 'full'
        ? 'The shell environment carries a working proxy URL, so tools such as curl, git or npm can use `$DSH_PROXY_URL` directly as their proxy.'
        : 'The shell environment carries the proxy address but not its credentials, so pass it explicitly, for example `curl --proxy "$DSH_PROXY_URL" https://example.com`.'
    : 'Shell commands receive no proxy settings from this component.'
  return {
    proxy,
    source: String(policy.source ?? ''),
    bypass: bypass.length === 0 ? '' : bypass.slice(0, 12).join(', ') + (bypass.length > 12 ? `, … (${bypass.length} in total)` : ''),
    shell: shellLine,
    state: active && options.exposeToShell !== 'off'
      ? '`$DSH_PROXY_STATE` reports "proxied" or "direct" for this process.'
      : '',
    auth:
      active && options.authenticated === true && options.exposeToShell !== 'full'
        ? 'That proxy requires a user name and password. When a shell command fails with 407 Proxy Authentication Required, say so and ask the user to enable "Include credentials" in the proxy settings; never ask them to paste the password into the conversation.'
        : '',
    settings: 'To change any of this, point the user at Settings → Plugins → 不二布丁光子 → 网络代理.',
  }
}

/**
 * Render the prompt block that tells the model which network state is in force.
 *
 * Written for the model, in English, and kept to what it can act on: which
 * traffic is already routed, which traffic is bypassed, and how to reach the
 * network from a shell. When routing is off it says so instead of disappearing,
 * because the injection switch is independent of the routing switch. The URL shown is always credential-free: a masked marker
 * would look like a usable address, and the password is never described beyond
 * "required".
 *
 * A user template, when present, replaces the wording but not the facts: `{{name}}`
 * placeholders are filled from {@link promptFacts}, and an unknown placeholder is
 * left literal rather than silently emptied, so a typo is visible in the settings
 * preview instead of producing a blank line in the prompt.
 *
 * @param policy - the resolved policy.
 * @param options - shell exposure, whether auth is configured, and the user template.
 * @returns the prompt text. The caller decides whether to inject it; an inactive
 *   policy still has a notice to show, because routing and injection are independent.
 */
export function renderPrompt(policy, options) {
  const facts = promptFacts(policy, options)
  const template = typeof options.template === 'string' ? options.template.trim() : ''
  if (template !== '') {
    return template.replace(/\{\{(\w+)\}\}/g, (match, name) => (name in facts ? facts[name] : match))
  }
  const settingsLine = '- To change any of this, point the user at Settings → Plugins → 不二布丁光子 → 网络代理.'
  if (policy.active !== true) {
    const source = String(policy.source ?? 'off')
    const stateLine =
      source === 'direct'
        ? 'This Harness process is configured to connect directly; any proxy supplied by the launcher is overridden for this process.'
        : source === 'none'
          ? 'No proxy address was found for the selected source; DSH’s original network settings are in force.'
          : 'This plugin is not controlling DSH’s network routing; DSH’s original network settings are in force.'
    return ['Network proxy', `- ${stateLine}`, settingsLine].join('\n')
  }
  const proxy = facts.proxy
  const lines = [
    'Network proxy',
    `- This Harness process sends its outbound HTTP(S) traffic through ${proxy} (source: ${policy.source}).`,
    '- Traffic that already uses it needs no action from you: model API calls, web_fetch, and HTTP MCP servers are covered.',
  ]
  const bypass = splitBypass(policy.noProxy)
  if (bypass.length > 0) {
    const shown = bypass.slice(0, 12).join(', ')
    lines.push(
      `- These hosts are contacted directly instead: ${shown}${bypass.length > 12 ? `, … (${bypass.length} in total)` : ''}.`,
    )
  }
  if (options.exposeToShell === 'off') {
    lines.push('- Shell commands receive no proxy settings; a command that needs the proxy has to be given one by the user.')
  } else {
    lines.push(
      options.exposeToShell === 'full'
        ? '- The shell environment carries a working proxy URL, so tools such as curl, git or npm can use `$DSH_PROXY_URL` directly as their proxy.'
        : '- The shell environment carries the proxy address but not its credentials, so pass it explicitly, for example `curl --proxy "$DSH_PROXY_URL" https://example.com`.',
    )
    if (options.exposeToShell !== 'full' && options.authenticated === true) {
      lines.push(
        '- That proxy requires a user name and password. When a shell command fails with 407 Proxy Authentication Required, say so and ask the user to enable "Include credentials" in the proxy settings; never ask them to paste the password into the conversation.',
      )
    }
    lines.push('- `$DSH_PROXY_STATE` reports "proxied" or "direct" for this process.')
  }
  lines.push(settingsLine)
  return lines.join('\n')
}

// ---------------------------------------------------------------- persistence

/**
 * Decide where this component's settings file lives.
 *
 * The profile directory is the one place whose lifetime matches the setting's
 * meaning. It is found, in order, from `DSH_PROFILE_DIR` (present when the
 * Harness was launched with a profile), from the profile patch the settings
 * service can locate, and finally from `DSH_HOME`.
 *
 * @param ctx - the plugin context, used to ask the settings service.
 * @returns the settings file's absolute path.
 */
export async function settingsPath(ctx) {
  const fromEnv = process.env.DSH_PROFILE_DIR
  if (typeof fromEnv === 'string' && fromEnv !== '') return join(fromEnv, SETTINGS_FILE)
  const settings = ctx.get('settings')
  if (settings !== undefined && typeof settings.prepareDocument === 'function') {
    try {
      const document = await settings.prepareDocument()
      if (typeof document === 'string' && document !== '') return join(dirname(document), SETTINGS_FILE)
    } catch {
      // Fall through: an unlocatable profile is not fatal, the file still lands somewhere sensible.
    }
  }
  const home = process.env.DSH_HOME
  const base = typeof home === 'string' && home !== '' ? home : join(homedir(), '.dsh')
  return join(base, SETTINGS_FILE)
}

/**
 * Read the persisted settings, tolerating an absent or damaged file.
 *
 * A corrupt file must not stop the Harness from starting, so a parse failure
 * degrades to defaults and is reported instead of thrown.
 *
 * @param file - the settings file's absolute path.
 * @returns the normalized settings and any read diagnostic.
 */
export async function readSettings(file) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return { settings: normalizeSettings(undefined), diagnostics: [] }
    return { settings: normalizeSettings(undefined), diagnostics: [`could not read ${file}: ${error.message}`] }
  }
  try {
    return { settings: normalizeSettings(JSON.parse(text)), diagnostics: [] }
  } catch (error) {
    return {
      settings: normalizeSettings(undefined),
      diagnostics: [`${file} is not valid JSON (${error.message}); using defaults`],
    }
  }
}

/**
 * Write the settings file atomically.
 *
 * A half-written settings file would be read as corrupt by the next launch, so the
 * new content lands beside the old file and is renamed over it in one step.
 *
 * @param file - the settings file's absolute path.
 * @param settings - the settings to persist.
 */
export async function writeSettings(file, settings) {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  await rename(temporary, file)
}

// ---------------------------------------------------------------- platform readers

/**
 * Read the Windows system proxy from the per-user Internet Settings key.
 *
 * Implemented with `reg.exe query` rather than a registry binding because this
 * module may not import one, and `reg.exe` ships with Windows. Output is decoded
 * as latin1: the values this reads are ASCII, and a wrong console code page would
 * otherwise turn a readable value into question marks.
 *
 * @returns the reading, or `undefined` when this is not Windows.
 */
export async function readSystemProxy() {
  if (process.platform !== 'win32') return undefined
  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
  const stdout = await new Promise((resolve) => {
    execFile('reg.exe', ['query', key], { timeout: 5000, windowsHide: true, encoding: 'latin1' }, (error, output) => {
      resolve(error === null ? output : '')
    })
  })
  const values = new Map()
  for (const line of stdout.split(/\r?\n/)) {
    // Four columns: name, type, value — and the value may itself contain spaces.
    const match = /^\s{4}(\S+)\s+REG_[A-Z_]+\s+(.*)$/.exec(line)
    if (match !== null) values.set(match[1], match[2].trim())
  }
  const enable = values.get('ProxyEnable')
  return {
    enabled: enable === '0x1' || enable === '1',
    server: values.get('ProxyServer'),
    override: values.get('ProxyOverride'),
    autoConfigUrl: values.get('AutoConfigURL'),
  }
}

/**
 * Whether one settings snapshot can consult the system proxy at all.
 *
 * {@link resolvePolicy} decides this itself: a disabled component returns before
 * looking at any source, and a pinned `custom`/`env`/`direct` mode never reaches
 * the system reader. The check is duplicated here because the READ is the
 * expensive part — a `reg.exe` child per call, measured at 53-69 ms on this
 * machine — and it must be skipped rather than paid and discarded.
 *
 * `system` and `auto` are the only sources that can yield a system reading, and
 * an enabled `auto` only falls through to it when `custom` produced no address —
 * but that depends on values this function cannot see cheaply, so `auto` reads
 * whenever enabled. That is the conservative direction: an extra read costs
 * latency, a missing one would silently skip the user's own proxy.
 *
 * @param settings - normalized settings.
 * @returns whether the system proxy may affect the resolved policy.
 */
export function needsSystemProxy(settings) {
  if (settings.enabled !== true) return false
  return settings.mode === 'system' || settings.mode === 'auto'
}

/**
 * Whether the settings page can SHOW a system-proxy reading for these settings.
 *
 * Separate from {@link needsSystemProxy} because display and routing answer
 * different questions. The block renders its system panel whenever the selected
 * source is `system`, whether or not the component is switched on — "上次读取：
 * 系统代理已开启" is useful while the user is still deciding. Routing only
 * consults it when it is on. Reading for display costs one `reg.exe` child, but
 * it happens on a status request (when the page is open), never on Host boot.
 *
 * @param settings - normalized settings.
 * @returns whether the panel has a system reading to show.
 */
export function showsSystemProxy(settings) {
  return settings.mode === 'system'
}

/**
 * Read the system proxy, but only when the settings could use it.
 *
 * The returned reading keeps whatever the caller should report to the UI: when
 * the read is skipped, `undefined` is the honest answer ("this launch did not
 * look"), and it is exactly what `resolvePolicy` treats as "no system source".
 *
 * @param settings - normalized settings.
 * @returns the reading, or undefined when it was not needed.
 */
export async function readSystemProxyIfNeeded(settings) {
  if (!needsSystemProxy(settings)) return undefined
  return readSystemProxy()
}

/**
 * Read the proxy names this component understands out of an environment.
 *
 * @param env - the environment to read; defaults to `process.env`.
 * @returns the names and their values.
 */
export function readProxyEnvironment(env = process.env) {
  const result = {}
  for (const name of ENV_NAMES) result[name] = env[name]
  return result
}

/**
 * Attach credentials to a resolved policy without persisting them.
 *
 * @param policy - the policy as resolved.
 * @param user - user name from settings.
 * @param password - password from the credential store.
 * @returns a policy whose URLs carry userinfo, for the transport only.
 */
export function withCredentialedPolicy(policy, user, password) {
  return {
    ...policy,
    httpProxy: policy.httpProxy === undefined ? undefined : withCredentials(policy.httpProxy, user, password),
    httpsProxy: policy.httpsProxy === undefined ? undefined : withCredentials(policy.httpsProxy, user, password),
  }
}

// ---------------------------------------------------------------- transport

/**
 * Build the install function this runtime supports.
 *
 * The native switch is preferred because it reaches both `fetch` and the
 * `http(s)` agents. The undici fallback exists for an older runtime and covers
 * `fetch` only, which the status line reports as a degraded mode rather than
 * hiding.
 *
 * @returns a binder that installs from an environment object and returns a disposer.
 */
export function createTransport() {
  if (typeof http.setGlobalProxyFromEnv === 'function') {
    return {
      kind: 'native',
      covers: 'fetch and node:http(s)',
      install: async (env) => http.setGlobalProxyFromEnv(env),
    }
  }
  /** Load undici from wherever this process can reach it. */
  const load = async () => {
    const candidates = [import.meta.url]
    const profile = process.env.DSH_PROFILE_DIR
    if (typeof profile === 'string' && profile !== '') {
      candidates.push(pathToFileURL(join(profile, 'package.json')).href)
    }
    for (const base of candidates) {
      try {
        const resolved = createRequire(base).resolve('undici')
        return await import(pathToFileURL(resolved).href)
      } catch {
        // Try the next base.
      }
    }
    return undefined
  }
  return {
    kind: 'undici',
    covers: 'fetch only',
    async install(env) {
      const undici = await load()
      if (undici === undefined) throw new Error('no proxy transport is available in this runtime')
      const { EnvHttpProxyAgent, setGlobalDispatcher, getGlobalDispatcher } = undici
      const previous = getGlobalDispatcher()
      setGlobalDispatcher(new EnvHttpProxyAgent({ ...env }))
      return () => setGlobalDispatcher(previous)
    },
  }
}

/**
 * Read the proxy password from the credential store.
 *
 * @param ctx - the plugin context.
 * @returns the password, or an empty string.
 */
export async function readPassword(ctx) {
  const credentials = ctx.get('credentials')
  if (credentials === undefined || typeof credentials.resolve !== 'function') return ''
  try {
    const resolved = await credentials.resolve(PASSWORD_REF)
    return typeof resolved?.value === 'string' ? resolved.value : ''
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------- plugin

/**
 * Describe the live state for the browser half, with every secret redacted.
 *
 * @param state - the live state.
 * @returns the wire value the settings block renders.
 */
export function describeState(state) {
  const policy = state.policy
  // The placeholder list and its current values ride with the STATUS snapshot, not
  // with the preview: editing the template clears the preview, and a shortcut chip
  // must not disappear just because its text is being edited. The preview response
  // carries the draft-specific values and wins while it exists; these are the
  // applied values and keep the chips usable at all times.
  const facts = promptFacts(policy, {
    exposeToShell: state.settings.exposeToShell,
    authenticated: state.authenticated,
  })
  return {
    settings: state.settings,
    policy: {
      active: policy.active === true,
      source: policy.source,
      httpProxy: policy.httpProxy === undefined ? undefined : redactUrl(policy.httpProxy),
      httpsProxy: policy.httpsProxy === undefined ? undefined : redactUrl(policy.httpsProxy),
      noProxy: policy.noProxy,
      entries: policy.entries ?? [],
      unsupported: policy.unsupported ?? [],
      experimental: policy.experimental === true,
      notes: policy.notes ?? [],
    },
    transport: state.transport === undefined ? undefined : { kind: state.transport.kind, covers: state.transport.covers },
    promptFacts: facts,
    promptPlaceholders: Object.keys(facts),
    authenticated: state.authenticated,
    appliedAt: state.appliedAt,
    diagnostics: state.diagnostics,
    lastError: state.lastError,
    file: state.file,
    system: state.system,
  }
}

/**
 * Try one request against the URL currently in force.
 *
 * The probe answers two different questions and must not conflate them:
 *
 *   - did the request succeed (reached the destination and came back)?
 *   - did it go through the proxy this component configured?
 *
 * A direct connection can succeed while the proxy is broken, and a proxied one can
 * fail against a proxy that does not relay. Reporting only `ok` would let a user
 * conclude the proxy works when the request never touched it, so the route in force
 * travels with the result and the caller decides how to word it.
 *
 * @param state - the live state.
 * @returns status and elapsed milliseconds, plus the route the attempt used.
 */
export async function probeRoute(state) {
  const url = state.settings.probeUrl
  const route = {
    source: state.policy.source,
    proxied: state.policy.active === true,
    proxy: state.policy.httpsProxy === undefined ? undefined : stripCredentials(state.policy.httpsProxy),
    transport: state.transport?.kind,
  }
  const started = Date.now()
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) })
    // Drain the body so the connection is reusable and the timing is honest.
    await response.arrayBuffer().catch(() => undefined)
    return { ok: true, status: response.status, elapsedMs: Date.now() - started, url, route }
  } catch (error) {
    return { ok: false, error: `${error.name}: ${error.message}`, elapsedMs: Date.now() - started, url, route }
  }
}

export function apply(ctx) {
  const state = {
    settings: normalizeSettings(undefined),
    policy: resolvePolicy(normalizeSettings(undefined), {}),
    system: undefined,
    file: undefined,
    transport: createTransport(),
    dispose: undefined,
    diagnostics: [],
    appliedAt: undefined,
    authenticated: false,
    lastError: undefined,
  }

  /**
   * Rebuild the policy from the current sources and install it.
   *
   * The previous installation is released FIRST. Two installs would stack, and
   * the later agent would then be restored into the earlier one instead of into
   * the layer beneath both.
   *
   * @returns whether the installation succeeded.
   */
  const install = async () => {
    state.system = await readSystemProxyIfNeeded(state.settings)
    const base = resolvePolicy(state.settings, { system: state.system, env: readProxyEnvironment() })
    const password = await readPassword(ctx)
    // Authentication is only usable as a PAIR. A stored password with no user name
    // sends no header at all, so reporting `authenticated` on the password alone
    // would make the prompt promise a login this routing does not perform.
    state.authenticated = password !== '' && state.settings.authUser !== ''
    state.policy = withCredentialedPolicy(base, state.settings.authUser, password)

    const previous = state.dispose
    state.dispose = undefined
    if (typeof previous === 'function') {
      try {
        await previous()
      } catch (error) {
        state.diagnostics = [...state.diagnostics, `the previous proxy could not be released: ${error.message}`]
      }
    }

    const environment = installEnvironment(state.policy)
    // Nothing to install: the previous layer is already released above, so the
    // process is back to whatever the launcher established.
    if (environment === undefined) {
      state.lastError = undefined
      state.appliedAt = new Date().toISOString()
      return true
    }

    try {
      const dispose = await state.transport.install(environment)
      state.dispose = typeof dispose === 'function' ? dispose : undefined
      state.lastError = undefined
      state.appliedAt = new Date().toISOString()
      return true
    } catch (error) {
      state.lastError = error.message
      return false
    }
  }

  /** One in-flight system read, so concurrent status requests share one child. */
  let systemRead

  /**
   * Fill `state.system` for display, without installing anything.
   *
   * {@link readSystemProxyIfNeeded} skips the read when routing cannot use it —
   * but the settings page still shows the reading under `system` mode, so a user
   * who has not enabled anything yet must not be told "unavailable". This runs
   * only for a snapshot that could consult the system source (so the common
   * disabled/custom case still pays nothing), and only when nothing was read
   * since the last install.
   */
  const refreshSystem = async () => {
    // Routing needs it, or the block has a panel to fill. Either way the read is
    // off the boot path and shared by every concurrent request.
    if (!needsSystemProxy(state.settings) && !showsSystemProxy(state.settings)) return
    if (state.system !== undefined) return
    if (systemRead === undefined) {
      systemRead = readSystemProxy().then(
        (reading) => {
          state.system = reading
          systemRead = undefined
          return reading
        },
        () => {
          systemRead = undefined
          return undefined
        },
      )
    }
    await systemRead
  }

  /** Read the settings file and install for the first time. */
  const boot = async () => {
    state.file = await settingsPath(ctx)
    const { settings, diagnostics } = await readSettings(state.file)
    state.settings = settings
    state.diagnostics = diagnostics
    await install()
  }

  const ready = boot()

  // The model is told about this component's network state whenever the user asked
  // for it. Injection is independent of routing: switching the proxy off must not
  // switch the notice off, and switching the notice off must not touch routing. A
  // provider function keeps the text in step with a settings change without
  // re-registering the section.
  //
  // `required: true` is load-bearing. Without it the entry counts as OPTIONAL
  // runtime context, which a composition may remove through
  // `suppressRuntimeContext()`. Verified against stored session logs: the shipped
  // `minimal` preset delivered the surrounding runtime context (working directory,
  // team identity) but dropped this entry, so the model silently never learned the
  // network state. Declaration order in the registry is not something this
  // component can influence, so marking it required is the only reliable fix.
  ctx.inject(['systemPrompt'], (scoped) => {
    const systemPrompt = scoped.get('systemPrompt')
    if (systemPrompt === undefined || typeof systemPrompt.context !== 'function') return
    scoped.effect(
      () =>
        systemPrompt.context({
          name: 'network:proxy',
          order: 105,
          required: true,
          text: () => {
            if (state.settings.promptInjection !== true) return ''
            return renderPrompt(state.policy, {
              exposeToShell: state.settings.exposeToShell,
              authenticated: state.authenticated,
              template: state.settings.promptTemplate,
            })
          },
        }),
      'notpdpton-proxy: prompt context',
    )
  })

  // Shell facts are contributed only at the level the user chose. The password is
  // included at `full` because a working one-liner is that level's whole point.
  ctx.inject(['shellEnv'], (scoped) => {
    const shellEnv = scoped.get('shellEnv')
    if (shellEnv === undefined || typeof shellEnv.register !== 'function') return
    scoped.effect(
      () =>
        shellEnv.register({
          name: 'notpdpton-proxy',
          variables: {
            DSH_PROXY_URL: {
              description: 'Proxy URL in force for this Harness process, or empty when it connects directly.',
            },
            DSH_NO_PROXY: { description: 'Hosts this Harness contacts directly instead of through the proxy.' },
            DSH_PROXY_STATE: { description: 'Whether this Harness process is proxied ("proxied") or direct ("direct").' },
          },
          resolve: () => {
            const level = state.settings.exposeToShell
            if (level === 'off' || state.policy.active !== true) {
              return { DSH_PROXY_URL: '', DSH_NO_PROXY: state.policy.noProxy ?? '', DSH_PROXY_STATE: 'direct' }
            }
            const url = state.policy.httpsProxy ?? state.policy.httpProxy ?? ''
            return {
              DSH_PROXY_URL: level === 'full' ? url : stripCredentials(url),
              DSH_NO_PROXY: state.policy.noProxy ?? '',
              DSH_PROXY_STATE: 'proxied',
            }
          },
        }),
      'notpdpton-proxy: shell environment',
    )
  })

  // The browser half reads and writes through a plain HTTP route on the shipped
  // web server. That is the ONLY channel a statically loaded client half has: its
  // sandbox provides `fetch` and no module loader, so `connection.rpc.handle` — a
  // service the browser side cannot even see — would leave the block with no data.
  // The market plugin this pack lives beside does exactly this for the same reason.
  //
  // Two fences apply, because an exact route is matched BEFORE the server's own
  // `/api` fence and therefore never passes through it:
  //
  //   1. `connection.requestRejection` — the host's own Host/Origin check and
  //      browser-login gate, the same one its API applies. Read per request: the
  //      connection service is constructed behind an async init and is absent when
  //      this plugin mounts.
  //   2. A loopback-only rule of our own, for a deployment old enough to have no
  //      `connection` at all. Without it that case would fail open.
  ctx.inject(['webServer'], (scoped) => {
    const webServer = scoped.get('webServer')
    if (webServer === undefined || typeof webServer.register !== 'function') return

    /**
     * Whether this request may be answered.
     *
     * @param request - the incoming request.
     * @returns the status to refuse with, or undefined to proceed.
     */
    const refusalOf = (request) => {
      const connection = ctx.get('connection')
      const gate = connection?.requestRejection
      if (typeof gate === 'function') {
        try {
          return gate.call(connection, request)
        } catch {
          // A gate that throws has admitted nothing; failing open here would turn a
          // host bug into the exposure this exists to close.
          return 403
        }
      }
      // No gate available: accept loopback only. `Host` is the one header a
      // hostile page cannot forge, which is what makes this a real fence.
      const host = String(request.headers.host ?? '')
      const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
      return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]'
        ? undefined
        : 403
    }

    /** Read a size-capped JSON body: this route must not be a memory sink. */
    const readJson = async (request) => {
      const chunks = []
      let size = 0
      for await (const chunk of request) {
        size += chunk.length
        if (size > 64 * 1024) throw new Error('request body is too large')
        chunks.push(chunk)
      }
      if (size === 0) return {}
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    }

    /** Answer with one JSON payload. */
    const reply = (response, status, payload) => {
      response.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify(payload))
    }

    scoped.effect(
      () =>
        webServer.register({
          kind: 'exact',
          path: ROUTE_PATH,
          handler: async (request, response) => {
            const refusal = refusalOf(request)
            if (refusal !== undefined) {
              reply(response, refusal, {
                ok: false,
                error: { message: 'this request was not admitted by the host' },
              })
              return
            }
            if (request.method !== 'POST') {
              reply(response, 405, { ok: false, error: { message: 'use POST' } })
              return
            }
            let payload
            try {
              payload = await readJson(request)
            } catch (error) {
              reply(response, 400, { ok: false, error: { message: error.message } })
              return
            }
            const endpoint = typeof payload?.endpoint === 'string' ? payload.endpoint : ''
            const body = payload?.payload ?? {}
            try {
              await ready
              if (endpoint === 'status') {
                // The block renders the system proxy reading, which boot may have
                // skipped for settings that cannot use it. Fill it here, off the
                // boot path, so opening Settings never costs a child process
                // unless the panel actually has a system section to show.
                await refreshSystem()
                reply(response, 200, { ok: true, value: describeState(state) })
                return
              }
              if (endpoint === 'save') {
                const previous = state.settings
                const proposed = normalizeSettings({ ...state.settings, ...(body?.settings ?? {}) })
                // A value the user typed that the transport cannot honour is a
                // refusal, not a silent fall-through to a direct connection.
                const errors = checkProxyFields(proposed)
                if (errors.length > 0) {
                  reply(response, 200, { ok: false, error: { message: errors.join('; '), fields: errors } })
                  return
                }
                // A password typed in the same Save must be validated against the
                // PROPOSED user name, not the stored one: otherwise the first-ever
                // setup (new user name + new password together) would be refused by
                // a rule that is about to be satisfied by this very request.
                const typedSecret = typeof body?.secret === 'string' ? body.secret : ''
                if (typedSecret !== '') {
                  const credentials = ctx.get('credentials')
                  if (credentials === undefined) {
                    reply(response, 200, {
                      ok: false,
                      error: { message: 'the credential store is not available in this profile' },
                    })
                    return
                  }
                  if (proposed.authUser === '') {
                    reply(response, 200, {
                      ok: false,
                      error: { message: 'set a user name before storing a password', fields: ['authUser'] },
                    })
                    return
                  }
                  try {
                    await credentials.set(PASSWORD_REF, typedSecret)
                  } catch (error) {
                    // The settings are untouched: this request changed nothing, so
                    // reporting success or applying a half-pair would both lie.
                    reply(response, 200, {
                      ok: false,
                      error: { message: `the password could not be stored: ${error.message}` },
                    })
                    return
                  }
                }
                state.settings = proposed
                // A saved snapshot may now consult a source the old one did not
                // (or stop consulting one), so a reading kept from the previous
                // install must not be reported as describing this one.
                state.system = undefined
                const installed = await install()
                if (!installed) {
                  // Put the routing back where it was: a setting the transport
                  // rejects must not leave the process on a half-applied policy.
                  state.settings = previous
                  await install()
                  reply(response, 200, {
                    ok: false,
                    error: {
                      message: typedSecret === ''
                        ? `the proxy could not be installed: ${state.lastError ?? 'unknown error'}`
                        : `the password was stored, but the proxy could not be installed: ${state.lastError ?? 'unknown error'}`,
                      secretStored: typedSecret !== '',
                    },
                  })
                  return
                }
                state.diagnostics = []
                await writeSettings(state.file ?? (await settingsPath(ctx)), state.settings)
                reply(response, 200, { ok: true, value: describeState(state) })
                return
              }
              if (endpoint === 'probe') {
                // Measure the route that is actually in force, not a rebuilt one: a
                // probe that constructs its own agent would pass while the real
                // requests keep failing.
                reply(response, 200, { ok: true, value: await probeRoute(state) })
                return
              }
              if (endpoint === 'prompt') {
                // Preview what WOULD be injected for a given draft, using the live
                // policy. The settings page needs this for two reasons: the user must
                // see the exact text the model receives, and an edit must be judged
                // before it is applied. It never mutates state.
                const draft = normalizeSettings({ ...state.settings, ...(body?.settings ?? {}) })
                const facts = promptFacts(state.policy, {
                  exposeToShell: draft.exposeToShell,
                  authenticated: state.authenticated,
                })
                const text =
                  draft.promptInjection !== true
                    ? ''
                    : renderPrompt(state.policy, {
                        exposeToShell: draft.exposeToShell,
                        authenticated: state.authenticated,
                        template: draft.promptTemplate,
                      })
                reply(response, 200, {
                  ok: true,
                  value: {
                    // An inactive proxy still has a notice; the only empty preview is
                    // the user turning injection off. Naming that state keeps an empty
                    // preview from looking like a bug.
                    reason: draft.promptInjection !== true ? 'disabled' : 'rendered',
                    text,
                    // The editor opens on a real starter template instead of an empty
                    // box, and the starter is the same regardless of the injection
                    // switch. `text` remains the expanded preview and still follows it.
                    templateSeed: DEFAULT_TEMPLATE,
                    facts,
                    placeholders: Object.keys(facts),
                    required: true,
                  },
                })
                return
              }
              if (endpoint === 'secret') {
                // The password is written HERE, never through the settings object,
                // and never read back: this branch can only store or remove it.
                //
                // Why the Host does it instead of the browser calling
                // `ctx.remote.credentials`: that generated namespace is reachable
                // only when the client half declares the `remote` service, and a
                // component whose whole job is one settings block must not lose its
                // authentication section because a future client drops that seam.
                // This route is already authenticated by the host's own gate, is
                // same-origin only, and is the single channel the block already uses.
                const credentials = ctx.get('credentials')
                if (credentials === undefined) {
                  reply(response, 200, {
                    ok: false,
                    error: { message: 'the credential store is not available in this profile' },
                  })
                  return
                }
                const action = body?.action
                if (action === 'set') {
                  const value = typeof body?.password === 'string' ? body.password : ''
                  if (value === '') {
                    reply(response, 200, { ok: false, error: { message: 'the password is empty' } })
                    return
                  }
                  if (state.settings.authUser === '') {
                    // Basic auth needs both halves; storing a password with no user
                    // name would promise a login this routing cannot perform.
                    reply(response, 200, {
                      ok: false,
                      error: { message: 'set a user name before storing a password' },
                    })
                    return
                  }
                  await credentials.set(PASSWORD_REF, value)
                } else if (action === 'unset') {
                  await credentials.unset(PASSWORD_REF)
                } else if (action !== 'describe') {
                  reply(response, 200, { ok: false, error: { message: `unknown secret action "${String(action)}"` } })
                  return
                }
                // Re-resolve immediately: the reported state must describe what is
                // stored NOW, including an ambient fallback that unset re-exposed.
                const described = await credentials.describe(PASSWORD_REF)
                reply(response, 200, {
                  ok: true,
                  value: {
                    configured: described?.configured === true,
                    writable: described?.writable === true,
                    source: typeof described?.source === 'string' ? described.source : undefined,
                  },
                })
                return
              }
              reply(response, 200, { ok: false, error: { message: `unknown endpoint "${endpoint}"` } })
            } catch (error) {
              reply(response, 200, {
                ok: false,
                error: { message: error instanceof Error ? error.message : String(error) },
              })
            }
          },
        }),
      'notpdpton-proxy: settings route',
    )
  })

  // Unloading the component must hand routing back to whatever was there before:
  // the launcher's own policy, or a bare direct connection.
  ctx.effect(() => () => {
    const dispose = state.dispose
    state.dispose = undefined
    return typeof dispose === 'function' ? dispose() : undefined
  }, 'notpdpton-proxy: release routing')
}
