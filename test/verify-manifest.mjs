/**
 * Final consistency audit of the shipped bundle: manifest, patch, locales, icon,
 * exports, dependency declarations, and the invariants the harness depends on.
 *
 * usage: node verify-manifest.mjs
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url)
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))

/** Every component package the pack ships, in the order its patch inserts them. */
const COMPONENTS = ['recover', 'window', 'proxy']

let failures = 0
function check(label, condition, detail) {
  if (condition) console.log(`  ok   ${label}`)
  else {
    failures++
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

console.log('-- manifest')
check('package name is dsh-notpdpton', pkg.name === 'dsh-notpdpton', pkg.name)
check('version declared', typeof pkg.version === 'string', pkg.version)
check('type is module', pkg.type === 'module', pkg.type)
check('bundle patch declared', pkg.dsh?.bundle?.patch === './cordis.patch.yml', pkg.dsh?.bundle?.patch)
// The pack is NOT a component: it carries the card's name/description and the patch
// only. Declaring dsh.client here would make the pack itself a component and put its
// display text in the rows list, which is the duplication this layout avoids.
check('pack declares no client half', pkg.dsh?.client === undefined, JSON.stringify(pkg.dsh?.client))
check('root export points at index.js', pkg.exports?.['.'] === './index.js', pkg.exports?.['.'])
check('no client export on the pack', pkg.exports?.['./client'] === undefined, pkg.exports?.['./client'])
check('icon export declared', pkg.exports?.['./icon'] === './icon.svg', pkg.exports?.['./icon'])
// The reader resolves `<package>/package.json` for a package-root specifier to fill
// in the name/description fallbacks. An `exports` map hides it
// (ERR_PACKAGE_PATH_NOT_EXPORTED), which silently costs the package its title and
// description on the Plugins page.
check('package.json is exported', pkg.exports?.['./package.json'] === './package.json', pkg.exports?.['./package.json'])
check('package locale export is a wildcard', typeof pkg.exports?.['./locale/*.json'] === 'string', pkg.exports?.['./locale/*.json'])
// An `exports` map is a whitelist: a path the Host resolves but the map omits is
// refused outright. Both the bare specifier and the explicit `/index.js` alias have
// to be present, or the Loader cannot import the entry at all.
check('entry export declared', pkg.exports?.['.'] === './index.js', pkg.exports?.['.'])
check('explicit index.js export declared', pkg.exports?.['./index.js'] === './index.js', pkg.exports?.['./index.js'])
check('no leftover feature subpath export', pkg.exports?.['./feature'] === undefined, pkg.exports?.['./feature'])
check('no leftover feature subpath files', !(pkg.files ?? []).some((f) => f.startsWith('feature/')))
// Every component is its own package, so the pack must ship and export each one for
// the profile's link and for the rows that name them to resolve.
for (const feature of COMPONENTS) {
  check(
    `ships the ${feature} package inside the pack`,
    (pkg.files ?? []).some((f) => f.startsWith(`${feature}/`)),
    JSON.stringify(pkg.files),
  )
  check(
    `exports the ${feature} package subpath`,
    pkg.exports?.[`./${feature}`] === `./${feature}/index.js`,
    String(pkg.exports?.[`./${feature}`]),
  )
}
check(
  'files list covers every source artifact',
  ['index.js', 'cordis.patch.yml', 'icon.svg'].every((f) => pkg.files?.includes(f)) &&
    (pkg.files ?? []).some((f) => f.startsWith('locale/')),
  JSON.stringify(pkg.files),
)
// The pack depends on exactly the component packages its patch inserts rows for.
check(
  'declares every component package as a dependency',
  Object.keys(pkg.dependencies ?? {}).sort().join(',') ===
    COMPONENTS.map((name) => `dsh-notpdpton-${name}`)
      .sort()
      .join(','),
  JSON.stringify(pkg.dependencies),
)
check(
  'every component dependency matches the pack version',
  Object.values(pkg.dependencies ?? {}).every((version) => version === pkg.version),
  JSON.stringify(pkg.dependencies),
)
for (const feature of COMPONENTS) {
  for (const entry of [
    [`./${feature}/package.json`, `./${feature}/package.json`],
    [`./${feature}/client`, `./${feature}/client.js`],
    [`./${feature}/icon`, `./${feature}/icon.svg`],
    [`./${feature}/locale/*.json`, `./${feature}/locale/*.json`],
  ]) {
    check('pack exports ' + entry[0], pkg.exports?.[entry[0]] === entry[1], String(pkg.exports?.[entry[0]]))
  }
}
// The design notes ship with the package, because a defect report quotes them.
for (const doc of ['window-state', 'proxy']) {
  check(`ships docs/${doc}.md`, (pkg.files ?? []).includes('docs/*.md') || (pkg.files ?? []).includes(`docs/${doc}.md`), JSON.stringify(pkg.files))
}

console.log('\n-- dependency declarations')
// A package here is mounted from a profile link, so an npm dependency would be
// resolved against the PROFILE's node_modules rather than this repository, and the
// Host halves are deliberately importable from outside the profile (Node builtins
// only). The browser halves ask the module table for `react` alone, which the shell
// already seeds. Nothing imports @deepseek-ai/cordis or any other runtime package,
// so a peer dependency on it is a version gate with no consumer: it only turns a
// future runtime bump into a pnpm peer warning.
//
// The client halves likewise declare no package-level arrival order. Every surface
// waits for the slot it contributes to through `ctx.slots.inject(slotName, ...)`,
// which is the contract for a provider that arrives later (or never, when its
// component is switched off). A `dsh.client.inject` row would instead make an
// unrelated package's load failure cascade into this one.
for (const [label, manifest] of [
  ['pack', pkg],
  ...COMPONENTS.map((feature) => [
    feature,
    JSON.parse(readFileSync(new URL(`${feature}/package.json`, root), 'utf8')),
  ]),
]) {
  check(
    `${label} declares no peer dependency`,
    Object.keys(manifest.peerDependencies ?? {}).length === 0,
    JSON.stringify(manifest.peerDependencies),
  )
  if (label === 'pack') continue
  check(
    `${label} client half declares no package-level load order`,
    (manifest.dsh?.client?.inject ?? []).length === 0,
    JSON.stringify(manifest.dsh?.client?.inject),
  )
  check(
    `${label} client half requests no external module`,
    (manifest.dsh?.client?.external ?? []).length === 0,
    JSON.stringify(manifest.dsh?.client?.external),
  )
}

console.log('\n-- patch')
const patch = readFileSync(new URL('cordis.patch.yml', root), 'utf8')
// The pack is ONE card on the Plugins page listing its components. Each row in its
// bundle patch is one component, so the pack inserts one row per feature. That is
// required rather than stylistic: the browser module table is keyed by package name
// and two client halves cannot share one package.
const packIds = [...patch.matchAll(/^\s*-\s*id:\s*(\S+)/gm)].map((m) => m[1].replace(/['"]/g, ''))
const packNames = [...patch.matchAll(/^\s*name:\s*(\S+)\s*$/gm)].map((m) => m[1].replace(/['"]/g, ''))
check(`pack patch inserts ${COMPONENTS.length} component rows`, packIds.length === COMPONENTS.length, packIds.join(','))
for (const [index, feature] of COMPONENTS.entries()) {
  check(`row ${index + 1} is dsh-notpdpton-${feature}`, packIds[index] === `dsh-notpdpton-${feature}`, packIds[index])
}
check(
  'each row mounts a distinct package',
  new Set(packNames).size === COMPONENTS.length && packNames.length === COMPONENTS.length,
  packNames.join(','),
)
check(
  'every row mounts a package root, never a subpath',
  packNames.every((name) => !name.includes('/')),
  packNames.join(','),
)
// The pack must not insert itself as a row: it is the card, not a component. A
// self-row would list the pack's own display text among 包含的组件 and repeat the
// card title, and its metadata could then only serve one of the two jobs.
check('the pack does not insert itself as a component row', !packNames.includes('dsh-notpdpton'), packNames.join(','))
check('patch does not mount a subpath', !/name:\s*['"]dsh-notpdpton\//.test(patch), packNames.join(','))

console.log('\n-- host halves')
const packHost = await import(new URL('index.js', root).href)
check('the pack exports apply()', typeof packHost.apply === 'function')
// The pack's own Host half must stay inert: a registration here would belong to a
// component, and the pack is meant to be nothing but a container.
check('the pack host half injects nothing', Array.isArray(packHost.inject) && packHost.inject.length === 0, JSON.stringify(packHost.inject))

const recoverHost = await import(new URL('recover/index.js', root).href)
const host = recoverHost
check('the recovery component exports apply()', typeof recoverHost.apply === 'function')
check('declares the sessionProjections dependency', Array.isArray(recoverHost.inject) && recoverHost.inject.includes('sessionProjections'), JSON.stringify(recoverHost.inject))
check('exports the projection key', typeof recoverHost.INTERRUPTION_KEY === 'string', recoverHost.INTERRUPTION_KEY)

// Fold contract spot-checks over a synthetic log.
const { initialState, foldInterruption, interruptionStateSchema } = host
function fold(events) {
  let state = initialState()
  for (const event of events) {
    state = foldInterruption(state, event)
    interruptionStateSchema.parse(state)
  }
  return state
}

const base = [
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'step/start', data: { turn: 1, step: 0 } },
  { type: 'todo/write', data: { todos: [
    { content: 'one', status: 'completed' },
    { content: 'two', status: 'in_progress' },
    { content: 'three', status: 'pending' },
  ] } },
  { type: 'step/end', data: { turn: 1, step: 0 } },
]

// A genuinely crashed tail sits INSIDE an open step: the step never ended either.
const crashedTail = [...base, { type: 'step/start', data: { turn: 1, step: 1 } }]

const open = fold(crashedTail)
check('open tail folds as crash', open.status === 'crash', open.status)
check('open tail keeps the todo list across turn/start', open.todos.length === 3, String(open.todos.length))
check('open tail reports the turn number', open.turn === 1, String(open.turn))
check('open tail reports openStep', open.openStep === true, String(open.openStep))

// A closed step inside an open turn is also interrupted, just not mid-step.
const openTurnClosedStep = fold(base)
check('open turn with closed step still folds as crash', openTurnClosedStep.status === 'crash', openTurnClosedStep.status)
check('open turn with closed step reports openStep=false', openTurnClosedStep.openStep === false, String(openTurnClosedStep.openStep))

// Publish-cost contract, driven through the REGISTERED unit (not a helper), so a
// regression in what apply() wires up is caught too. The registry publishes when
// consecutive wire views differ by Object.is; the fold's step bookkeeping is
// host-only, so a step/start or step/end inside an open turn must NOT publish.
let registered
recoverHost.apply({
  sessionProjections: { register: (definition) => ((registered = definition), () => {}) },
})
check('apply registers the interruption unit', registered?.key === recoverHost.INTERRUPTION_KEY, String(registered?.key))
{
  // Mirror the registry's exact order: fold the event, THEN compute the view.
  let state = registered.init()
  let previousView
  let publications = 0
  const step = (event) => {
    state = registered.apply(state, event)
    const view = registered.wire.view(state)
    if (!Object.is(previousView, view)) publications++
    previousView = view
    return state
  }
  const states = [step({ type: 'turn/start', data: { turn: 1 } })]
  for (let index = 0; index < 20; index++) {
    states.push(step({ type: 'step/start', data: { turn: 1, step: index } }))
    states.push(step({ type: 'step/end', data: { turn: 1, step: index } }))
  }
  check(
    'step bookkeeping inside an open turn never publishes',
    publications === 1,
    String(publications) + ' publications for the turn plus 40 step events',
  )
  check(
    'the fold still tracks openStep for the harness',
    states.at(-1).openStep === false && states.at(-2).openStep === true,
    String(states.at(-2).openStep) + '/' + String(states.at(-1).openStep),
  )
  // The host-only fields must be absent from the wire value.
  const view = host.wireInterruption(states.at(-1))
  check(
    'the wire view omits openStep and hasTurns',
    !('openStep' in view) && !('hasTurns' in view),
    Object.keys(view).join(','),
  )
  check(
    'the wire view carries every field the Client reads',
    ['status', 'turn', 'reason', 'abortCause', 'errorCode', 'errorMessage', 'partialMessage', 'todos'].every(
      (field) => field in view,
    ),
    Object.keys(view).join(','),
  )
  // A state from a checkpoint row has no remembered view; it must still view once.
  const restored = { ...initialState(), status: 'interrupted', turn: 3, todos: [] }
  check('a restored state can still be viewed', host.wireInterruption(restored).status === 'interrupted')
}

const closedCompleted = fold([...base, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }])
check('completed turn folds as none', closedCompleted.status === 'none', closedCompleted.status)
check('completed turn keeps todos', closedCompleted.todos.length === 3, String(closedCompleted.todos.length))

const repaired = fold([
  ...base,
  { type: 'step/end', data: { turn: 1, step: 0 } },
  { type: 'turn/end', data: { turn: 1, reason: { kind: 'interrupted' } } },
])
check('harness repair marker folds as interrupted (button shows)', repaired.status === 'interrupted', repaired.status)
check('repaired turn keeps todos', repaired.todos.length === 3, String(repaired.todos.length))

const userStopped = fold([
  ...base,
  // A real Stop truncates a live stream, leaving an `interrupted: true` message.
  { type: 'assistant/message', data: { interrupted: true } },
  { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } },
])
check(
  'a deliberate Stop folds as aborted/user (button hidden)',
  userStopped.status === 'aborted' && userStopped.abortCause === 'user',
  `${userStopped.status}/${userStopped.abortCause}`,
)

const shutdownAbort = fold([
  ...base,
  // App restart / workspace stop: no stream in flight, so no interrupted message.
  { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } },
])
check('a shutdown abort folds as interrupted (button shown)', shutdownAbort.status === 'interrupted', shutdownAbort.status)
check('a shutdown abort keeps the todo list', shutdownAbort.todos.length === 3, String(shutdownAbort.todos.length))

const appClosed = fold([
  ...base,
  { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'disposed' } } } },
])
check('an app-close abort folds as interrupted', appClosed.status === 'interrupted', appClosed.status)

const errored = fold([...base, { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { code: 'X', message: 'boom' } } } }])
check('failed turn carries code and message', errored.status === 'error' && errored.errorCode === 'X' && errored.errorMessage === 'boom', JSON.stringify(errored.errorMessage))

check('blank log folds as none', fold([]).status === 'none')

// Wire-shape discipline: every value must be plain JSON.
const json = JSON.stringify(closedCompleted)
check('state is plain JSON round-trippable', JSON.stringify(JSON.parse(json)) === json)

console.log('\n-- recovery client half')
const source = readFileSync(new URL('recover/client.js', root), 'utf8')
check('registers into the browser module table', source.includes('window.__ModuleLoader__.load({') && source.includes("id: 'dsh-notpdpton-recover'"))
check('uses the require() module table, not host.call', !source.includes('host.call'))
check('registers the interruption locale namespace', source.includes("const NS = 'notpdpton'"))
check(
  'declares every recovery preference switch',
  ['progressRestore', 'notifyUserAbort'].every((k) => source.includes(k)),
)
// A window closed while maximized must reopen at its PRE-maximize size, so the
// "restore maximized" preference was removed entirely: no key, no locale string,
// no default. It must not creep back in.
check('the removed restore-maximized preference is gone from the client half', !source.includes('restoreMaximized'))
check('no restore-maximized locale string remains', !source.includes('switch.restoreMaximized'))

// ---- THE SPLIT: window placement is its own package/component ---------------
// The recover package carries recovery ONLY. Window placement lives in ./window so
// it can be its own row on the Plugins page. Every trace of it must be gone from
// the recovery client half, otherwise the two components overlap.
console.log('\n-- the split: recover carries recovery only')
check('recover client has no window-placement code (moveTo/resizeTo)', !source.includes('moveTo(') && !source.includes('resizeTo('))
check('recover client exports no windowPlacement seam', !source.includes('windowPlacement'))
check('recover client declares no WINDOW_* constants', !/WINDOW_[A-Z_]+\s*=/.test(source))
check('recover client has no rememberWindowGeometry switch', !source.includes('rememberWindowGeometry'))
check('recover client registers no window-placement settings group', !source.includes('group.windowPlacement'))
check('recover client does not touch sessionStorage', !source.includes('sessionStorage'))
check('root client keeps the recovery dock slot', source.includes("name: 'conversation.input.dock'"))
check('root client keeps the settings section slot', source.includes("name: 'settings.section'"))
// Two surfaces (the dock and the page) plus the pack page's block slot: the page
// declares that child list, then this component fills its own block into it.
check(
  'root client declares its own surfaces plus the pack page block slot',
  (source.match(/ctx\.slots\.inject\(/g) ?? []).length === 3,
  String((source.match(/ctx\.slots\.inject\(/g) ?? []).length),
)
// The recovery component must not carry a third component's behaviour either.
check('recover client has no proxy code', !source.includes('notpdpton-proxy') && !source.includes('setGlobalProxyFromEnv'))
check('recover client registers no proxy settings group', !source.includes("id: 'networkProxy'"))

// The window package's client half must carry that behaviour instead.
const windowSource = readFileSync(new URL('window/client.js', root), 'utf8')
console.log('\n-- the split: window package client half')
check('window client loads into the browser module table under its own id', windowSource.includes('window.__ModuleLoader__.load({') && windowSource.includes("id: 'dsh-notpdpton-window'"))
check('window client uses the require() module table, not host.call', !windowSource.includes('host.call'))
check('window client registers the window locale namespace', windowSource.includes("const NS = 'notpdptonWindow'"))
check(
  'window client declares its one preference switch',
  windowSource.includes('rememberWindowGeometry'),
)
check('window client has no restore-maximized preference', !windowSource.includes('restoreMaximized'))
// The window placement subfeature is a renderer feature: it must reach the real
// window through the browser APIs Electron forwards, and it must never assume the
// renderer rect equals what moveTo/resizeTo accept (that is the frame-offset bug
// the correction loop exists to fix).
check('window placement drives the real window', windowSource.includes('moveTo(') && windowSource.includes('resizeTo('))
check(
  'window placement corrects the measured frame offset',
  windowSource.includes('placeWindow') && windowSource.includes('WINDOW_MAX_PASSES'),
)
check(
  'window placement restores once per launch (sessionStorage, not localStorage)',
  windowSource.includes('WINDOW_RESTORED_KEY') && windowSource.includes('sessionStorage') && windowSource.includes('hasRestoredThisLaunch'),
)
check(
  'window placement rejects a rect no display can show',
  windowSource.includes('isOnScreen') && windowSource.includes('bringOnScreen'),
)
check(
  'window placement clamps to the shell window minimums',
  windowSource.includes('WINDOW_MIN_WIDTH = 520') && windowSource.includes('WINDOW_MIN_HEIGHT = 600'),
)
check(
  'window placement is installed outside the slot tree (runs with no session)',
  /ctx\.effect\(\(\) => installWindowPlacement/.test(windowSource),
)
check(
  'window placement exposes a documented test seam',
  windowSource.includes('windowPlacement: {') && windowSource.includes('install: installWindowPlacement'),
)
// The persisted geometry keys are deliberately UNCHANGED across the split, so a
// user's saved window survives the upgrade that moved the code to another package.
check(
  'window client keeps the original geometry store key',
  windowSource.includes("'dsh-notpdpton:window-state'"),
)
check(
  'window client keeps the original restore-once key',
  windowSource.includes("'dsh-notpdpton:window-restored'"),
)
check(
  'window client uses its own switch store key',
  windowSource.includes("'dsh-notpdpton-window:switches'"),
)
// A component's preferences are a BLOCK inside the pack's one settings page, not a
// page of their own: two sibling pages in the Settings sidebar for one plugin is
// exactly the placement bug this guards.
check(
  'window client contributes a block to the pack page, not a settings page',
  (windowSource.match(/ctx\.slots\.inject\(/g) ?? []).length === 1 &&
    windowSource.includes("const GROUP_SLOT = 'notpdpton.settings.group'") &&
    !windowSource.includes("name: 'settings.section'"),
  String((windowSource.match(/ctx\.slots\.inject\(/g) ?? []).length),
)
check(
  'the pack page declares the block slot its components fill',
  source.includes('children: { [GROUP_SLOT]: { kind: \'list\', scope: \'root\' } }'),
)
check(
  'the page never names its components\' blocks',
  !source.includes('windowPlacement') && !source.includes('记住窗口') && !source.includes('networkProxy'),
)
// The page draws every block's chrome, so it must accept a block whose preferences
// are values rather than switches (the proxy block) as well as switch-only blocks.
check(
  'the page block renderer accepts field rows, not only switches',
  source.includes('fields = []') && source.includes('npd-fieldControl') && source.includes('npd-status'),
)
check(
  'no master on/off switch in the settings page',
  !source.includes('switch.interruptedRecovery') && !source.includes('interruptedRecovery: true'),
)
check(
  'settings are grouped by subfeature',
  source.includes('SETTING_GROUPS') && source.includes('npd-groupTitle'),
)
check(
  'no longer declares the removed progress-summary switch',
  !source.includes('progressSummary'),
)
check(
  'the dock does not duplicate the shipped todo panel',
  !source.includes('npd-todo') && !source.includes('detail.progress'),
)
check('uses only theme tokens for color (no hardcoded palette)', !/#[0-9a-fA-F]{3,8}\b/.test(source.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')), 'found a hex color literal')
check('no cross-plugin value imports', !source.includes('@deepseek-ai/dsh-client-ui-primitives'))

// The settings page heading names the PACK and its version. The browser half cannot
// read a package.json, so those two values are constants in the client bundle; this
// is what keeps them honest — a forgotten bump fails here instead of shipping a
// stale number beside the title.
console.log('\n-- settings heading identity matches the manifest')
const clientId = source.match(/const PACKAGE_ID = '([^']+)'/)?.[1]
const clientVersion = source.match(/const PACKAGE_VERSION = '([^']+)'/)?.[1]
check('client heading uses the pack package name', clientId === pkg.name, `${clientId} vs ${pkg.name}`)
check(
  'client heading version matches the pack manifest version',
  clientVersion === pkg.version,
  `${clientVersion} vs ${pkg.version}`,
)
check(
  'the heading renders both, after the title',
  source.includes("className: 'npd-pageTitleRow'") &&
    source.includes("className: 'npd-pageId'") &&
    source.includes("className: 'npd-pageVersion'"),
)

console.log('\n-- locales and display metadata')
/** Read and structurally audit one metadata dictionary. */
function metaOf(relative) {
  const dict = JSON.parse(readFileSync(new URL(relative, root), 'utf8'))
  check(`${relative} has meta.title`, typeof dict.meta?.title === 'string' && dict.meta.title.length > 0, dict.meta?.title)
  check(`${relative} has meta.description`, typeof dict.meta?.description === 'string' && dict.meta.description.length > 0, dict.meta?.description?.slice(0, 40))
  // The plugin manager reads only the metadata; every other key would be dead weight.
  check(`${relative} carries no dead keys`, Object.keys(dict).every((k) => k === 'meta'), Object.keys(dict).join(','))
  check(`${relative} keeps the description to one sentence`, (dict.meta.description.match(/[。.]/g) ?? []).length <= 1, dict.meta.description)
  check(`${relative} description stays concise`, dict.meta.description.length <= 120, `${dict.meta.description.length} chars`)
  return dict.meta
}

// Two layers with two jobs, one file each:
//   locale/         -> the PACK card: its name and "个人专属插件"
//   <component>/locale/ -> that COMPONENT row: what the feature does
// Mixing them is exactly the bug this guards: with the pack's metadata describing a
// feature, the card and its only relevant row read as duplicates.
const zhPack = metaOf('locale/zh.json')
const enPack = metaOf('locale/en.json')
const zhRecovery = metaOf('recover/locale/zh.json')
const enRecovery = metaOf('recover/locale/en.json')

console.log('\n-- pack metadata')
check('pack title is the Chinese name', zhPack.title === '不二布丁光子', zhPack.title)
check('pack title (en)', enPack.title === 'Notpdpton Photon', enPack.title)
// The pack speaks only for itself: it must not name a feature, because more will be
// added and because the components already describe themselves.
check(
  'pack description does not name a feature',
  !zhPack.description.includes('异常中断恢复') && !zhPack.description.includes('继续') && !zhPack.description.includes('代理'),
  zhPack.description,
)
check(
  'pack description says it is a personal plugin',
  zhPack.description.includes('个人') && zhPack.description.includes('插件'),
  zhPack.description,
)

console.log('\n-- recovery component metadata')
check('component title names the feature', zhRecovery.title === '异常中断恢复', zhRecovery.title)
check('component title (en)', enRecovery.title === 'Interrupted-session recovery', enRecovery.title)
check('component description explains the feature', zhRecovery.description.includes('继续'), zhRecovery.description)
// A component row must not restate the pack umbrella ("插件包" / "子功能"), because
// that is the pack card's job and would make the two read alike.
check(
  'component description does not describe a pack',
  !zhRecovery.description.includes('插件包') && !zhRecovery.description.includes('子功能'),
  zhRecovery.description,
)
check('pack and component titles differ', zhPack.title !== zhRecovery.title, `${zhPack.title} / ${zhRecovery.title}`)
check(
  'pack and component descriptions differ',
  zhPack.description !== zhRecovery.description,
  `${zhPack.description} / ${zhRecovery.description}`,
)
// The component block states what the feature does, not the ways a session can end.
for (const noise of ['进程意外退出', '中途被打断', '达到长度上限']) {
  check(`component description drops the enumeration "${noise}"`, !zhRecovery.description.includes(noise))
}

console.log('\n-- the split: window package manifest')
// The window feature is a SECOND component, but it is NOT a bundle. Evidence from
// the shipped runtime: official multi-component bundles insert one row per FEATURE
// package, and those feature packages carry NO dsh.bundle and NO cordis.patch.yml
// of their own (e.g. @deepseek-ai/dsh-experimental-client-ui-voice-input declares
// dsh.client but dsh.bundle is undefined and it ships no patch). Only the PACK is a
// bundle; the feature packages are merely dependencies that the pack's rows name.
//
// A patch on the feature package would be actively harmful: if it were ever
// selected as a bundle it would insert a DUPLICATE row id (the pack already
// inserts dsh-notpdpton-window), and duplicate ids are a composition error.
const windowRoot = new URL('window/', root)
const windowPkg = JSON.parse(readFileSync(new URL('package.json', windowRoot), 'utf8'))
check('window package is named dsh-notpdpton-window', windowPkg.name === 'dsh-notpdpton-window', windowPkg.name)
check('window package is a private ESM module', windowPkg.private === true && windowPkg.type === 'module')
check('window package points main at index.js', windowPkg.main === 'index.js', windowPkg.main)
// THE REVERTED SHAPE: a feature package is not a bundle.
check('window package declares NO bundle (only the pack is a bundle)', windowPkg.dsh?.bundle === undefined, JSON.stringify(windowPkg.dsh?.bundle))
check('window package ships NO cordis.patch.yml', !existsSync(new URL('cordis.patch.yml', windowRoot)), 'cordis.patch.yml is present')
check(
  'window package lists no patch in files[]',
  Array.isArray(windowPkg.files) && !windowPkg.files.some((f) => f.includes('patch') || f.endsWith('.yml')),
  JSON.stringify(windowPkg.files),
)
check('window package declares a web client half', windowPkg.dsh?.client?.platform === 'web', windowPkg.dsh?.client?.platform)
check('window package client half loads immediately', windowPkg.dsh?.client?.immediately === true)
for (const entry of [
  ['.', './index.js'],
  ['./index.js', './index.js'],
  ['./package.json', './package.json'],
  ['./client', './client.js'],
  ['./client.js', './client.js'],
  ['./icon', './icon.svg'],
  ['./locale/*.json', './locale/*.json'],
]) {
  check('window package exports ' + entry[0], windowPkg.exports?.[entry[0]] === entry[1], String(windowPkg.exports?.[entry[0]]))
}
check(
  'window package ships its runtime artifacts in files[]',
  Array.isArray(windowPkg.files) && ['index.js', 'client.js', 'icon.svg', 'locale/*.json'].every((f) => windowPkg.files.includes(f)),
  JSON.stringify(windowPkg.files),
)
check(
  'window package ships no bundle patch artifact at all',
  Array.isArray(windowPkg.files) && !windowPkg.files.includes('cordis.patch.yml'),
  JSON.stringify(windowPkg.files),
)

console.log('\n-- network proxy package manifest')
// Same shape as the window feature package: a component is a package root with its
// own halves, never a bundle and never a subpath of the pack.
const proxyRoot = new URL('proxy/', root)
const proxyPkg = JSON.parse(readFileSync(new URL('package.json', proxyRoot), 'utf8'))
check('proxy package is named dsh-notpdpton-proxy', proxyPkg.name === 'dsh-notpdpton-proxy', proxyPkg.name)
check('proxy package shares the pack version', proxyPkg.version === pkg.version, `${proxyPkg.version} vs ${pkg.version}`)
check('proxy package is a private ESM module', proxyPkg.private === true && proxyPkg.type === 'module')
check('proxy package points main at index.js', proxyPkg.main === 'index.js', proxyPkg.main)
check('proxy package declares NO bundle (only the pack is a bundle)', proxyPkg.dsh?.bundle === undefined, JSON.stringify(proxyPkg.dsh?.bundle))
check('proxy package ships NO cordis.patch.yml', !existsSync(new URL('cordis.patch.yml', proxyRoot)), 'cordis.patch.yml is present')
check(
  'proxy package declares a web client half',
  proxyPkg.dsh?.client?.platform === 'web',
  proxyPkg.dsh?.client?.platform,
)
check('proxy package client half loads immediately', proxyPkg.dsh?.client?.immediately === true)
for (const entry of [
  ['.', './index.js'],
  ['./index.js', './index.js'],
  ['./package.json', './package.json'],
  ['./client', './client.js'],
  ['./client.js', './client.js'],
  ['./icon', './icon.svg'],
  ['./locale/*.json', './locale/*.json'],
]) {
  check('proxy package exports ' + entry[0], proxyPkg.exports?.[entry[0]] === entry[1], String(proxyPkg.exports?.[entry[0]]))
}
check(
  'proxy package ships its runtime artifacts in files[]',
  Array.isArray(proxyPkg.files) && ['index.js', 'client.js', 'icon.svg', 'locale/*.json'].every((f) => proxyPkg.files.includes(f)),
  JSON.stringify(proxyPkg.files),
)
// The Host half must stay importable from a location outside the profile (which is
// where this pack is linked from): a bare npm import would fail there, so the module
// declares no dependencies at all.
check(
  'the proxy host half declares no runtime dependency',
  Object.keys(proxyPkg.dependencies ?? {}).length === 0,
  JSON.stringify(proxyPkg.dependencies),
)
const proxyHostSource = readFileSync(new URL('index.js', proxyRoot), 'utf8')
const bareImports = [...proxyHostSource.matchAll(/^\s*import\s[^'"]*['"]([^'".][^'"]*)['"]/gm)].map((match) => match[1])
check(
  'the proxy host half imports only node builtins',
  bareImports.every((specifier) => specifier.startsWith('node:')),
  bareImports.join(','),
)
check(
  'the proxy host half declares no Config schema (schemastery is unavailable here)',
  !/export\s+const\s+Config\b/.test(proxyHostSource),
)

console.log('\n-- network proxy display metadata')
const zhProxy = JSON.parse(readFileSync(new URL('locale/zh.json', proxyRoot), 'utf8'))
const enProxy = JSON.parse(readFileSync(new URL('locale/en.json', proxyRoot), 'utf8'))
check('proxy zh metadata title names the feature', zhProxy.meta?.title === '网络代理', zhProxy.meta?.title)
check('proxy en metadata title names the feature', enProxy.meta?.title === 'Network proxy', enProxy.meta?.title)
check(
  'proxy description says it routes DSH traffic and tells the model',
  typeof zhProxy.meta?.description === 'string' && zhProxy.meta.description.includes('DSH') && zhProxy.meta.description.includes('模型'),
  zhProxy.meta?.description,
)
check(
  'proxy metadata carries no dead keys',
  Object.keys(zhProxy).every((k) => k === 'meta') && Object.keys(enProxy).every((k) => k === 'meta'),
)
const titles = [zhRecovery.title, JSON.parse(readFileSync(new URL('locale/zh.json', windowRoot), 'utf8')).meta.title, zhProxy.meta.title]
check('every component title is distinct', new Set(titles).size === titles.length, titles.join(' / '))

console.log('\n-- icons')
// The official plugin icons are all drawn on the same 36-unit canvas; anything else
// renders at a different optical size beside them in the Plugins list. The per-file
// style rules (palette, gradients, safe area, self-containment) live in
// verify-icons.mjs — this is only the manifest-level invariant.
//
// No icon is exempt from the canvas rule. A previous run carried a written-down
// defect for window/icon.svg (64x64, different palette) instead of failing it; the
// artwork has since been corrected, so the exemption is gone rather than left to
// rot as a warning nobody reads.
for (const [label, relative] of [
  ['package icon', 'icon.svg'],
  ['recovery component icon', 'recover/icon.svg'],
  ['window component icon', 'window/icon.svg'],
  ['proxy component icon', 'proxy/icon.svg'],
]) {
  const path = new URL(relative, root)
  const stat = statSync(path)
  check(`${label} exists`, stat.isFile())
  check(`${label} under the 256 KiB limit`, stat.size < 256 * 1024, `${stat.size} bytes`)
  const svg = readFileSync(path, 'utf8')
  check(`${label} is valid SVG`, svg.startsWith('<svg') || svg.includes('<svg'), svg.slice(0, 20))
  check(`${label} uses the official 36x36 canvas`, svg.includes('viewBox="0 0 36 36"'), svg.match(/viewBox="[^"]*"/)?.[0])
}

console.log(failures === 0 ? '\nOK: bundle audit passes' : `\nFAIL: ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
