/**
 * Performance audit probe — read-only, reproducible.
 *
 * Measures the three hot paths this repository actually owns, using this
 * machine's real material rather than synthetic guesses:
 *
 *   1. PROXY HOST BOOT      how long readSystemProxy() blocks on reg.exe, and
 *                           whether that work is needed for the stored settings.
 *   2. INTERRUPTION PROJECTION
 *                           how many publishes the shipped fold produces over the
 *                           stored session corpus, how much of it is step
 *                           bookkeeping, and what a reference-stable wire view
 *                           would suppress.
 *   3. WINDOW PLACEMENT     how many renderer reads / compositor settles one
 *                           restore costs, and what capture() does on the 1 s poll.
 *
 * It also times renderPrompt(), which runs once per model step.
 *
 * Nothing is written; the corpus is only read. usage:
 *
 *   node test/audit-perf.mjs [sessionRoot]
 *
 * @module test/audit-perf
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { performance } from 'node:perf_hooks'
import { initialState, foldInterruption, wireInterruption } from '../recover/index.js'
import {
  needsSystemProxy,
  normalizeSettings,
  readSystemProxy,
  readSystemProxyIfNeeded,
  renderPrompt,
  resolvePolicy,
  showsSystemProxy,
} from '../proxy/index.js'

// ---------------------------------------------------------------------------
// 0. Load the WINDOW package's pure policy the same way its own verifier does:
//    run the shipped client.js behind a loader shim and a fake top-level window.
// ---------------------------------------------------------------------------
let windowPlugin
const fakeHost = {
  top: null,
  asked: { left: 20, top: 20, width: 1280, height: 820 },
  moveTo() {},
  resizeTo() {},
  addEventListener() {},
  removeEventListener() {},
  screen: { availLeft: 0, availTop: 0, availWidth: 1920, availHeight: 1040 },
  get screenX() { return this.asked.left },
  get screenY() { return this.asked.top },
  get outerWidth() { return this.asked.width },
  get outerHeight() { return this.asked.height },
}
fakeHost.top = fakeHost
fakeHost.__ModuleLoader__ = { load: (entry) => { windowPlugin = entry } }
globalThis.window = fakeHost
globalThis.localStorage = { getItem: () => null, setItem() {} }
new Function('window', readFileSync(new URL('../window/client.js', import.meta.url), 'utf8'))(fakeHost)
const placement = windowPlugin.factory(() => ({ createElement: () => null, Fragment: 'fragment', useEffect() {}, useState() {} })).windowPlacement

// ---------------------------------------------------------------------------
// 1. Read the stored session corpus.
// ---------------------------------------------------------------------------
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** JSONL logs are many concatenated zstd frames; Node decodes only the first. */
function splitFrames(buffer) {
  const starts = []
  for (let index = 0; index + 4 <= buffer.length; index++) {
    if (buffer[index] === MAGIC[0] && buffer[index + 1] === MAGIC[1] && buffer[index + 2] === MAGIC[2] && buffer[index + 3] === MAGIC[3]) {
      starts.push(index)
    }
  }
  const frames = []
  for (let index = 0; index < starts.length; index++) {
    frames.push(buffer.subarray(starts[index], index + 1 < starts.length ? starts[index + 1] : buffer.length))
  }
  return frames
}

function readLog(file) {
  const text = splitFrames(readFileSync(file))
    .map((frame) => { try { return zstdDecompressSync(frame).toString('utf8') } catch { return '' } })
    .join('')
  const events = []
  for (const line of text.split('\n')) if (line.trim() !== '') events.push(JSON.parse(line))
  return events
}

function loadCorpus(sessionRoot) {
  const sessions = []
  let workspaces
  try { workspaces = readdirSync(sessionRoot) } catch { return sessions }
  for (const workspace of workspaces) {
    const workspaceDir = join(sessionRoot, workspace)
    try { if (!statSync(workspaceDir).isDirectory()) continue } catch { continue }
    let ids
    try { ids = readdirSync(workspaceDir) } catch { continue }
    for (const id of ids) {
      const file = join(workspaceDir, id, 'session.v4.jsonl.zstd')
      try { statSync(file) } catch { continue }
      try {
        const events = readLog(file)
        if (events.length > 0) sessions.push({ id, events })
      } catch { /* a truncated or foreign log is not this audit's business */ }
    }
  }
  return sessions
}

const corpusRoot = process.argv[2] ?? join(homedir(), '.dsh', 'sessions')
const sessions = loadCorpus(corpusRoot)
const totalEvents = sessions.reduce((sum, session) => sum + session.events.length, 0)
sessions.sort((a, b) => b.events.length - a.events.length)

console.log('PERFORMANCE AUDIT — read-only\n')
console.log('== Corpus')
console.log('   sessions: ' + sessions.length + ', events: ' + totalEvents + '  (' + corpusRoot + ')')

// ---------------------------------------------------------------------------
// 2. Interruption projection: publishes, and what a stable wire view saves.
// ---------------------------------------------------------------------------
// The shipped unit: fold the event, then view the result, and publish exactly when
// the registry would — i.e. when consecutive views differ by Object.is.
const fold = { allocations: 0, bytes: 0, step: 0, publishes: 0, publishBytes: 0, max: 0 }
for (const session of sessions) {
  let state = initialState()
  let previousView = wireInterruption(state)
  for (const event of session.events) {
    const previous = state
    state = foldInterruption(state, event)
    const view = wireInterruption(state)
    const published = !Object.is(previousView, view)
    previousView = view
    if (Object.is(previous, state)) continue
    const bytes = JSON.stringify(view).length
    fold.allocations++
    fold.bytes += bytes
    if (event.type === 'step/start' || event.type === 'step/end') fold.step++
    if (!published) continue
    fold.publishes++
    fold.publishBytes += bytes
    if (bytes > fold.max) fold.max = bytes
  }
}

const per1000 = (n) => (1000 * n / totalEvents).toFixed(0)
console.log('\n== Interruption projection (recover/index.js)')
if (totalEvents === 0) {
  console.log('   no stored sessions found; skipped')
} else {
  console.log('   the fold allocates a new state on ' + fold.allocations + ' events (' + (100 * fold.allocations / totalEvents).toFixed(1) + '%)')
  console.log('   of those, step/start+step/end: ' + fold.step + ' (' + (100 * fold.step / fold.allocations).toFixed(1) + '% — host-only, no Client renders them)')
  console.log('   wire.view is reference-stable, so only a CLIENT-VISIBLE change publishes:')
  console.log('     publishes ' + fold.publishes + ' (' + (100 * fold.publishes / totalEvents).toFixed(1) + '% of events), ' + (fold.publishBytes / 1024).toFixed(0) + ' KiB')
  console.log('     per 1000 events: ' + per1000(fold.publishes) + ' pushes, ' + (1000 * fold.publishBytes / totalEvents / 1024).toFixed(1) + ' KiB, max value ' + fold.max + ' B')
  console.log('     suppressed ' + (fold.allocations - fold.publishes) + ' host-only state changes (' + (100 * (1 - fold.publishes / fold.allocations)).toFixed(1) + '% of allocations)')
  const largest = sessions[0]
  let state = initialState()
  const byType = new Map()
  for (const event of largest.events) {
    const previous = state
    state = foldInterruption(state, event)
    if (!Object.is(previous, state)) byType.set(event.type, (byType.get(event.type) ?? 0) + 1)
  }
  console.log('   largest session (' + largest.events.length + ' events): ' + [...byType.values()].reduce((a, b) => a + b, 0) + ' allocations')
  console.log('     by type: ' + [...byType.entries()].sort((a, b) => b[1] - a[1]).map(([type, n]) => type + '=' + n).join('  '))
}

// ---------------------------------------------------------------------------
// 3. Proxy host boot: the system-proxy reader.
// ---------------------------------------------------------------------------
console.log('\n== System proxy read (proxy/index.js)')
if (process.platform !== 'win32') {
  console.log('   not Windows; this reader returns undefined without spawning anything')
} else {
  await readSystemProxy()
  const times = []
  for (let index = 0; index < 5; index++) {
    const started = performance.now()
    await readSystemProxy()
    times.push(performance.now() - started)
  }
  times.sort((a, b) => a - b)
  const median = times[2]
  console.log('   one read = one reg.exe child: median ' + median.toFixed(1) + ' ms (min ' + times[0].toFixed(1) + ', max ' + times.at(-1).toFixed(1) + ')')

  // What a Host start now pays, per stored settings shape.
  const shapes = [
    ['disabled', { enabled: false }],
    ['enabled, custom source', { enabled: true, mode: 'custom', proxy: '127.0.0.1:10808' }],
    ['enabled, env source', { enabled: true, mode: 'env' }],
    ['enabled, direct', { enabled: true, mode: 'direct' }],
    ['enabled, auto', { enabled: true, mode: 'auto' }],
    ['enabled, system', { enabled: true, mode: 'system' }],
  ]
  let skipped = 0
  for (const [label, patch] of shapes) {
    const settings = normalizeSettings(patch)
    const reads = needsSystemProxy(settings)
    if (!reads && !showsSystemProxy(settings)) skipped++
    console.log(
      '   ' + label.padEnd(24) + (reads ? 'READ on boot' : 'skip on boot') +
        (reads ? '' : '  (-' + median.toFixed(0) + ' ms)') +
        (showsSystemProxy(settings) ? '  (display read on status)' : ''),
    )
  }
  const gateStart = performance.now()
  for (let index = 0; index < 10000; index++) needsSystemProxy(normalizeSettings({ enabled: false }))
  console.log(
    '   the gate itself: ' + (((performance.now() - gateStart) / 10000) * 1000).toFixed(2) + ' µs/call, ' +
      skipped + '/' + shapes.length + ' shapes skip the child entirely',
  )
}

// ---------------------------------------------------------------------------
// 4. Per-step prompt render the proxy contributes.
// ---------------------------------------------------------------------------
console.log('\n== Prompt context (proxy/index.js renderPrompt, once per model step)')
const promptPolicy = resolvePolicy(normalizeSettings({
  enabled: true, mode: 'custom', proxy: 'http://127.0.0.1:10808', noProxy: 'example.com, .internal, 10.0.0.1',
}), {})
const promptOptions = { exposeToShell: 'url', authenticated: true }
for (let index = 0; index < 1000; index++) renderPrompt(promptPolicy, promptOptions)
let sink = 0
const promptStarted = performance.now()
for (let index = 0; index < 100000; index++) sink += renderPrompt(promptPolicy, promptOptions).length
const promptMicros = (performance.now() - promptStarted) * 1000 / 100000
console.log('   ' + promptMicros.toFixed(2) + ' µs per call, ' + (sink / 100000) + ' B rendered — below measurement noise for a model step')

// ---------------------------------------------------------------------------
// 5. Window placement: renderer reads and settles.
// ---------------------------------------------------------------------------
console.log('\n== Window placement (window/client.js)')
const frame = { left: -14, top: 0, width: 15, height: 8 }
async function costOfRestore(seed, target) {
  let asked = { ...seed }
  let reads = 0
  let settles = 0
  const result = await placement.placeWindow(
    target,
    () => {
      reads++
      return { left: asked.left + frame.left, top: asked.top + frame.top, width: asked.width + frame.width, height: asked.height + frame.height }
    },
    (rect) => { asked = { ...rect } },
    async () => { settles++ },
  )
  return { reads, settles, passes: result.passes, rect: result.rect }
}
const target = { left: 300, top: 200, width: 1200, height: 800 }
const cold = await costOfRestore({ left: 20, top: 20, width: 1280, height: 820 }, target)
const warm = await costOfRestore(target, target)
console.log('   cold restore: ' + cold.reads + ' renderer reads, ' + cold.settles + ' settles, ' + cold.passes + ' passes')
console.log('   already-placed restore: ' + warm.reads + ' reads, ' + warm.settles + ' settles, ' + warm.passes + ' passes')
console.log('   limits: WINDOW_STABLE_READS=' + placement.WINDOW_STABLE_READS + ', WINDOW_SETTLE_MS=' + placement.WINDOW_SETTLE_MS + ', WINDOW_POLL_MS=' + placement.WINDOW_POLL_MS)

// Capture's call order decides whether the 1 s poll does async work for nothing.
const windowSource = readFileSync(new URL('../window/client.js', import.meta.url), 'utf8')
const capture = windowSource.slice(windowSource.indexOf('async function capture()'), windowSource.indexOf('async function restoreOnce()'))
const order = ['readGeometry', 'isStorableRect', 'sameRect', 'workAreas', 'isMaximizedRect', 'saveState']
  .map((name) => [name, capture.indexOf(name)])
  .sort((a, b) => a[1] - b[1])
  .map(([name]) => name)
console.log('   capture() order: ' + order.join(' -> '))
console.log(
  '   an unchanged window costs ' +
    (capture.indexOf('sameRect') < capture.indexOf('await workAreas()')
      ? 'one synchronous rect read and no display query'
      : 'a display query on every poll tick'),
)
