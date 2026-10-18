/**
 * Offline verification of the Client half (client.js): slot registrations, the
 * locale dictionaries, and the localized copy the dock renders.
 *
 * It executes the SHIPPED file by shimming `window.__ModuleLoader__` and a
 * minimal `react`, so the check is of the real artifact rather than a copy.
 *
 * usage: node verify-client.mjs
 */
import { readFileSync } from 'node:fs'

let captured
globalThis.window = {
  __ModuleLoader__: {
    load: (entry) => {
      captured = entry
    },
  },
}
globalThis.localStorage = {
  store: new Map(),
  getItem(key) {
    return this.store.has(key) ? this.store.get(key) : null
  },
  setItem(key, value) {
    this.store.set(key, String(value))
  },
}

// Execute the shipped file; the loader shim captures the registration.
// eslint-disable-next-line no-eval
new Function('window', readFileSync(new URL('../recover/client.js', import.meta.url), 'utf8'))(globalThis.window)

const reactStub = {
  // Must return a truthy node: the checks below assert "rendered something".
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: 'fragment',
  useCallback: (fn) => fn,
  useEffect: () => {},
  useMemo: (fn) => fn(),
  // `client.js` destructures React once, at factory time, so the component closes
  // over THIS function reference. A seed hook therefore has to be routed through
  // the reference itself rather than by reassigning `reactStub.useState`.
  useState: (init) => {
    const initial = typeof init === 'function' ? init() : init
    return [reactStub.__seed(initial), () => {}]
  },
  /** Identity by default; a test may install a seeder to force one cell's value. */
  __seed: (initial) => initial,
}

const plugin = captured.factory((id) => {
  if (id === 'react') return reactStub
  throw new Error(`unexpected require: ${id}`)
})

const registrations = []
let currentSlot
const zh = () => registrations.find((r) => r.kind === 'locale')?.dicts?.zh ?? {}
const ctx = {
  locale: {
    register: (ns, dicts) => {
      registrations.push({ kind: 'locale', ns, dicts })
      return () => {}
    },
    bind: (ns) => (key, params) => {
      const dict = zh()
      let text = dict[key] ?? key
      if (params) text = text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
      return text
    },
  },
  effect: (fn) => fn(),
  slots: {
    // The registration callback is a zero-argument closure that reads
    // `ctx.slots.register`, so both verbs live on this same object.
    inject: (slot, cb) => {
      currentSlot = slot
      cb()
      currentSlot = undefined
      return () => {}
    },
    register: (options, Component) => {
      registrations.push({ kind: 'slot', slot: currentSlot, options, Component })
      return () => {}
    },
  },
}

plugin.apply(ctx)

const localeReg = registrations.find((r) => r.kind === 'locale')
const slots = registrations.filter((r) => r.kind === 'slot')
const dock = slots.find((s) => s.slot === 'conversation.input.dock')
const settings = slots.find((s) => s.slot === 'settings.section')

console.log('plugin exports:', Object.keys(plugin))
console.log('locale ns:', localeReg?.ns, '| keys:', Object.keys(localeReg?.dicts?.zh ?? {}).length)
console.log('slots:', slots.map((s) => `${s.slot}#${s.options.id}@${s.options.order}`))

let failures = 0
function check(label, condition, detail) {
  if (condition) console.log(`  ok   ${label}`)
  else {
    failures++
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

console.log('\n-- registrations')
check('dock uses a fresh id (does not replace a shipped dock)', dock?.options.id === 'notpdpton-interrupted', dock?.options.id)
check('dock sits above the shipped todo dock (order < 0)', dock?.options.order < 0, String(dock?.options.order))
check('dock declares the plugin locale namespace', dock?.options.locale === 'notpdpton', dock?.options.locale)
check('dock component is a function', typeof dock?.Component === 'function')
check('settings section id', settings?.options.id === 'notpdpton', settings?.options.id)
check('settings label is a thunk (follows locale switches)', typeof settings?.options.label === 'function')
check('settings label resolves to the Chinese name in zh', settings?.options.label() === '不二布丁光子', settings?.options.label())

console.log('\n-- locale parity')
const zhKeys = new Set(Object.keys(localeReg.dicts.zh))
const enKeys = new Set(Object.keys(localeReg.dicts.en))
check('zh and en cover the same key set', zhKeys.size === enKeys.size && [...zhKeys].every((k) => enKeys.has(k)), `${zhKeys.size} vs ${enKeys.size}`)

const t = ctx.locale.bind('notpdpton')

/**
 * The page's `renderSlot`, as the slot host would hand it in.
 *
 * The page declares `notpdpton.settings.group` and renders it; every component
 * of the pack fills its own block in. This stub resolves the slot the same way
 * the live host does — newest registration list, in `order` — and renders each
 * entry's component with the owner props the page passes.
 */
function renderGroupSlot(owner) {
  const blocks = registrations
    .filter((r) => r.kind === 'slot' && r.slot === 'notpdpton.settings.group')
    .sort((a, b) => (a.options.order ?? 0) - (b.options.order ?? 0))
  return blocks.map((block) => block.Component({ ...owner, t: ctx.locale.bind(block.options.locale) }))
}
const renderSlot = (key, owner) => (key === 'notpdpton.settings.group' ? renderGroupSlot(owner) : null)
console.log('\n-- localized copy (zh)')
const expected = {
  title: '会话未正常结束',
  // Reasons are fragments, not sentences: the title already carries the outcome,
  // so a reason that restates "the last run was…" would double the message.
  'reason.crash': '进程异常退出',
  'reason.interrupted': '重启或连接中断',
  'reason.aborted': '被手动停止',
  'continue.label': '继续',
  'details.show': '详情',
  'details.hide': '收起',
  'detail.turn': '中断轮次',
  'detail.none': '无',
  dismiss: '忽略',
  'settings.title': '不二布丁光子',
  'group.interruptedRecovery': '异常中断恢复',
  'switch.progressRestore': '恢复进度与任务清单',
  'switch.notifyUserAbort': '提示手动停止的会话',
}
for (const [key, value] of Object.entries(expected)) check(`${key}`, t(key) === value, t(key))

// A reason must not repeat the title's own claim.
for (const status of ['crash', 'interrupted', 'error', 'maxTokens', 'blocked', 'aborted']) {
  const reason = t(`reason.${status}`)
  check(
    `reason.${status} does not restate the title`,
    !reason.includes('未正常结束') && !reason.includes('上次运行') && !reason.includes('上一轮'),
    reason,
  )
}
// The shipped conversation dock already renders the todo list, so this plugin
// must not carry its own copy of that vocabulary.
check('no todo progress copy in this plugin', !zhKeys.has('summary.progress') && !zhKeys.has('detail.progress'))
check('no progress-summary switch', !zhKeys.has('switch.progressSummary'))

// The reason is stated ONCE, in the collapsed line. The detail vocabulary that
// used to restate the same ending in three wordings must be gone, otherwise the
// two views can drift apart and the panel repeats itself.
for (const removed of ['detail.status', 'detail.ending', 'detail.cause']) {
  check(`no detail row restating the reason (${removed})`, zhKeys.has(removed) === false)
}
check('no status.* wording table', [...zhKeys].every((k) => !k.startsWith('status.')))
check('no ending.* wording table', [...zhKeys].every((k) => !k.startsWith('ending.')))
check('no cause.* wording table', [...zhKeys].every((k) => !k.startsWith('cause.')))

// Setting descriptions state what the option does, not a taxonomy of the cases it
// covers. A short ceiling keeps them from drifting back into prose.
console.log('\n-- setting descriptions stay concise')
for (const key of ['settings.description', 'group.interruptedRecovery.desc', 'switch.progressRestore.desc', 'switch.notifyUserAbort.desc']) {
  const text = t(key)
  check(`${key} is a single sentence`, (text.match(/[。.]/g) ?? []).length <= 1, text)
  check(`${key} stays under 40 chars`, text.length <= 40, `${text.length} chars: ${text}`)
}
// The enumerations removed by hand must not creep back in.
for (const noise of ['进程意外退出', '中途被打断', '达到长度上限']) {
  check(`no case enumeration "${noise}" in any description`, !t('group.interruptedRecovery.desc').includes(noise))
}

console.log('\n-- dock render decisions')
// The Component is rendered through a stub hook set for each interruption status;
// output presence is the contract: every unclean ending shows; only a clean
// completion stays silent.
function renderDock(view, { running = false } = {}) {
  const props = {
    t,
    inputActions: { setDraft: () => {}, submit: () => {} },
    useProjection: () => view,
    useSession: (selector) => selector({ running, pendingSubmissions: [], removed: false }),
  }
  const output = dock.Component(props)
  return output
}

const crashView = {
  status: 'crash',
  turn: 2,
  reason: null,
  abortCause: null,
  errorCode: null,
  errorMessage: null,
  openStep: true,
  hasTurns: true,
  todos: [
    { content: '研究 API', status: 'completed' },
    { content: '实现检测逻辑', status: 'in_progress' },
    { content: '验证', status: 'pending' },
  ],
}
check('crash shows the notice', renderDock(crashView) !== null)
check('harness repair marker (interrupted) shows the notice', renderDock({ ...crashView, status: 'interrupted', openStep: false }) !== null)
check('crash while the agent is running renders nothing', renderDock(crashView, { running: true }) === null)
check('clean turn renders nothing', renderDock({ ...crashView, status: 'none', turn: 1 }) === null)
// Every unclean ending gets a notice, the user's own Stop included.
check('user stop shows the notice (reason explained)', renderDock({ ...crashView, status: 'aborted', abortCause: 'user' }) !== null)
check('app-close abort shows the notice', renderDock({ ...crashView, status: 'aborted', abortCause: 'disposed' }) !== null)
check('failed turn shows the notice', renderDock({ ...crashView, status: 'error', errorMessage: 'boom' }) !== null)
check('max-tokens shows the notice', renderDock({ ...crashView, status: 'max-tokens' }) !== null)
check('blocked turn shows the notice', renderDock({ ...crashView, status: 'blocked' }) !== null)
check('absent projection renders nothing', renderDock(undefined) === null)

console.log('\n-- collapsed notice and Details')
/** Depth-first walk of the stub element tree (stub-rendering nested components). */
function walk(node, visit) {
  if (node === null || node === undefined) return
  // An array child is a child LIST, not a node: flatten it.
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit)
    return
  }
  if (typeof node.type === 'function') {
    walk(node.type(node.props ?? {}), visit)
    return
  }
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}

function collect(view) {
  const found = { buttons: [], detailsRows: [], text: [] }
  walk(renderDock(view), (node) => {
    if (node.type === 'button') found.buttons.push(node)
    if (node.props?.className === 'npd-detailRow') found.detailsRows.push(node)
  })
  return found
}

const collapsed = collect({ ...crashView, status: 'error', errorMessage: 'provider said no' })
check('collapsed notice has no detail rows', collapsed.detailsRows.length === 0, String(collapsed.detailsRows.length))
const detailsButton = collapsed.buttons.find((b) => b.props['aria-expanded'] !== undefined)
check('a Details toggle is rendered', detailsButton !== undefined)
check('Details starts collapsed', detailsButton?.props['aria-expanded'] === false, String(detailsButton?.props['aria-expanded']))
check('Details label is the show label', detailsButton.children?.[0] === '详情', detailsButton.children?.[0])
check('collapsed notice keeps Continue and Dismiss', collapsed.buttons.length === 3, String(collapsed.buttons.length))

// Expand the notice. The component closes over the React stub's `useState` at
// factory time, so the seeder rides `__seed`.
//
// Declaration order is: switch snapshot (object), busy (false), outcome (null),
// dismissed (null), expanded (false). `expanded` is therefore the SECOND
// `false`-initialised cell, not the first.
function renderWithExpanded(view, expanded) {
  let seenSwitches = false
  let falseCells = 0
  let seeded = false
  reactStub.__seed = (initial) => {
    if (typeof initial === 'object' && initial !== null) seenSwitches = true
    if (seenSwitches && initial === false) falseCells += 1
    if (seenSwitches && !seeded && initial === false && falseCells === 2) {
      seeded = true
      return expanded
    }
    return initial
  }
  try {
    return dock.Component({
      t,
      inputActions: { setDraft: () => {}, submit: () => {} },
      useProjection: () => view,
      useSession: (selector) => selector({ running: false, pendingSubmissions: [], removed: false }),
    })
  } finally {
    reactStub.__seed = (initial) => initial
  }
}

const expandedTree = renderWithExpanded({ ...crashView, status: 'error', errorMessage: 'provider said no', errorCode: 'E42' }, true)
const expanded = { buttons: [], detailsRows: [], rowTexts: [] }
/** Read the visible text out of a stub element tree. */
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node.type === 'function') return textOf(node.type(node.props ?? {}))
  return (node.children ?? []).map(textOf).join('')
}
walk(expandedTree, (node) => {
  if (node.type === 'button') expanded.buttons.push(node)
  if (node.props?.className === 'npd-detailRow') expanded.detailsRows.push(node)
})
// One row's text is its label immediately followed by its value.
const rowTexts = expanded.detailsRows.map(textOf)
check('expanded shows detail rows', expanded.detailsRows.length > 0, String(expanded.detailsRows.length))
// The detail panel elaborates, it does not restate: turn + error code + message
// are the facts the collapsed line does not carry. The todo lines follow.
check('details carry the turn', rowTexts.some((text) => text.startsWith('中断轮次')), rowTexts.join(' | '))
check('details carry the error code', rowTexts.some((text) => text.includes('E42')), rowTexts.join(' | '))
check('details carry the full error message', rowTexts.some((text) => text.includes('provider said no')), rowTexts.join(' | '))
check(
  'no detail row repeats the ending reason',
  !rowTexts.some((text) => text.startsWith('结束状态') || text.startsWith('结束方式') || text.startsWith('中止来源')),
  rowTexts.join(' | '),
)
const detailsToggle = expanded.buttons.find((b) => b.props['aria-expanded'] !== undefined)
check('the toggle reports expanded', detailsToggle?.props['aria-expanded'] === true, String(detailsToggle?.props['aria-expanded']))
check('toggle label switched to hide', detailsToggle.children?.[0] === '收起', detailsToggle.children?.[0])
check('details still expose Continue and Dismiss', expanded.buttons.length === 3, String(expanded.buttons.length))

console.log('\n-- details always present, empty values labelled')
// A bare notice (no error) must STILL show every row, each marked as empty rather
// than silently dropped, so the panel has a stable shape.
const bareTree = renderWithExpanded({ ...crashView, status: 'interrupted', todos: [], turn: 1, errorCode: null, errorMessage: null }, true)
const bareRows = []
walk(bareTree, (node) => {
  if (node.props?.className === 'npd-detailRow') bareRows.push(textOf(node))
})
const expectedLabels = ['中断轮次', '错误代码', '错误信息']
for (const label of expectedLabels) {
  check(`row "${label}" is always shown`, bareRows.some((text) => text.startsWith(label)), bareRows.join(' | '))
}
const emptyRows = bareRows.filter((text) => expectedLabels.some((label) => text === `${label}无`))
check('empty values are labelled 无', emptyRows.length >= 2, bareRows.join(' | '))
check(
  'the details do not repeat the todo panel',
  !bareRows.some((text) => text.startsWith('任务进度')),
  bareRows.join(' | '),
)

// Monospace marks a real code. The "无" placeholder is prose, so it must render in
// the normal face — otherwise an empty row looks like a machine value.
/** Collect the rendered value cells, keyed by their row label. */
function valueCells(view, expanded) {
  const cells = {}
  const tree = renderWithExpanded(view, expanded)
  walk(tree, (node) => {
    if (node.props?.className !== 'npd-detailRow') return
    const parts = []
    walk(node, (inner) => {
      if (inner.props?.className === 'npd-detailLabel') parts[0] = textOf(inner)
      if (inner.props?.className === 'npd-detailValue') parts[1] = inner
    })
    if (parts[0] !== undefined && parts[1] !== undefined) cells[parts[0]] = parts[1]
  })
  return cells
}

const withCode = valueCells({ ...crashView, status: 'error', errorCode: 'E42' }, true)
check('a real error code renders monospaced', withCode['错误代码']?.props['data-mono'] === 'true', String(withCode['错误代码']?.props['data-mono']))

const withoutCode = valueCells({ ...crashView, status: 'interrupted', errorCode: null, errorMessage: null }, true)
check('an empty error code renders "无"', textOf(withoutCode['错误代码']) === '无', textOf(withoutCode['错误代码']))
check(
  'the "无" placeholder is NOT monospaced',
  withoutCode['错误代码']?.props['data-mono'] === undefined,
  String(withoutCode['错误代码']?.props['data-mono']),
)

console.log('\n-- continue message only carries unfinished work')
function continueTextFor(view) {
  let draft = ''
  const tree = dock.Component({
    t,
    inputActions: { setDraft: (text) => (draft = text), submit: () => {} },
    useProjection: () => view,
    useSession: (selector) => selector({ running: false, pendingSubmissions: [], removed: false }),
  })
  let button
  walk(tree, (node) => {
    if (node.type === 'button' && node.props?.['data-variant'] === 'primary') button = node
  })
  button.props.onClick()
  return draft
}

const unfinishedText = continueTextFor({
  ...crashView,
  todos: [
    { content: '完成了的', status: 'completed' },
    { content: '还在做的', status: 'in_progress' },
    { content: '没开始的', status: 'pending' },
  ],
})
check('unfinished work is attached to the continue message', unfinishedText.includes('还在做的'), unfinishedText)
check('the todo head appears when work is unfinished', unfinishedText.includes('上次的任务清单'), unfinishedText)

const allDoneText = continueTextFor({
  ...crashView,
  todos: [
    { content: '完成了的', status: 'completed' },
    { content: '也完成了的', status: 'completed' },
  ],
})
check('a fully completed plan is NOT attached', !allDoneText.includes('也完成了的'), allDoneText)
check('a fully completed plan omits the todo head', !allDoneText.includes('上次的任务清单'), allDoneText)
check('a fully completed plan omits the turn progress line', !allDoneText.includes('上次中断于第'), allDoneText)
check('the instruction itself is always present', allDoneText.includes('上次会话未正常结束'), allDoneText)

console.log('\n-- the manual-stop switch')
// Drive the switch through the settings page itself, the way a user would.
function switchControls() {
  const found = []
  walk(settings.Component({ t, renderSlot }), (node) => {
    if (node.type === 'button' && node.props?.role === 'switch') found.push(node)
  })
  return found
}
function toggleSwitch(index) {
  switchControls()[index].props.onClick()
}
const stopView = { ...crashView, status: 'aborted', abortCause: 'user' }
const switchLabels = switchControls().map((node) => node.props['aria-label'])
const stopIndex = switchLabels.indexOf('提示手动停止的会话')
check('the manual-stop switch exists in settings', stopIndex >= 0, switchLabels.join(' | '))
// The feature's on/off switch belongs to the plugin manager, so the settings page
// must not carry a second one — two switches for one feature is the bug guarded here.
// Window placement is now its OWN package/component, so this file's plugin (the
// pack root) contributes recovery preferences only. Its settings page must carry
// exactly the two recovery switches and nothing from the window feature — if a
// window switch appeared here, the two components would overlap.
check(
  'settings carries exactly the two recovery preference switches',
  switchLabels.length === 2,
  switchLabels.join(' | '),
)
check('no master on/off switch in settings', !switchLabels.includes('异常中断恢复'), switchLabels.join(' | '))
check(
  'window placement contributes no preference here (it is its own component)',
  !switchLabels.some((label) => label.includes('窗口位置') || label.includes('记住窗口')),
  switchLabels.join(' | '),
)
check(
  'the removed restore-maximized preference is gone from the page',
  !switchLabels.some((label) => label.includes('最大化')),
  switchLabels.join(' | '),
)
check('no window-placement master switch', !switchLabels.includes('窗口位置与尺寸记忆'), switchLabels.join(' | '))
check('a manual stop shows while the switch is on', renderDock(stopView) !== null)
toggleSwitch(stopIndex)
check('a manual stop is hidden once the switch is off', renderDock(stopView) === null)
check('other endings still show with the switch off', renderDock({ ...crashView, status: 'crash' }) !== null)
toggleSwitch(stopIndex)
check('turning the switch back on restores the notice', renderDock(stopView) !== null)

console.log('\n-- the page declares the block slot its components fill')
// One page for the whole pack: the page's own heading, then a block per
// subfeature. The blocks arrive through the child slot, so the page never names
// a component — which is what stops a second page appearing in the sidebar.
check(
  'the section declares its block slot as a children list',
  settings?.options.children?.['notpdpton.settings.group']?.kind === 'list',
  JSON.stringify(settings?.options.children),
)
check(
  'the section declares no other child slot',
  Object.keys(settings?.options.children ?? {}).length === 1,
  Object.keys(settings?.options.children ?? {}).join(','),
)

const settingsTree = settings.Component({ t, renderSlot })
const groupTitles = []
walk(settingsTree, (node) => {
  if (node.props?.className === 'npd-groupTitle') groupTitles.push(textOf(node))
})
check('the page renders one block per contributing subfeature', groupTitles.length === 1, groupTitles.join(' | '))
check('the recovery block is titled after its subfeature', groupTitles[0] === '异常中断恢复', groupTitles[0])
check(
  'the recovery page carries no window block of its own',
  !groupTitles.includes('窗口位置与尺寸记忆'),
  groupTitles.join(' | '),
)
// The blocks are drawn by the PAGE, so both components' preferences share one
// visual contract instead of each bringing its own markup.
const pageText = textOf(settingsTree)
check('the page renders the pack heading', pageText.includes('不二布丁光子'), pageText.slice(0, 40))
check('the page does not repeat a component title as its heading', !pageText.startsWith('异常中断恢复'), pageText.slice(0, 40))

console.log('\n-- the heading carries the package id and version')
// The heading states WHICH build the page belongs to, the way the plugin market's
// own heading pairs its name with the package and the installed version: a
// screenshot of this page then answers the first question of every bug report.
const pageId = []
const pageVersion = []
const titleRowClasses = []
walk(settingsTree, (node) => {
  if (node.props?.className === 'npd-pageId') pageId.push(textOf(node))
  if (node.props?.className === 'npd-pageVersion') pageVersion.push(textOf(node))
  if (node.props?.className === 'npd-pageTitleRow') {
    // The stub keeps a child ARRAY as one child, so flatten one level.
    const children = (node.children ?? []).flat()
    titleRowClasses.push(children.map((child) => child?.props?.className))
  }
})
check('the heading shows the package id', pageId.length === 1 && pageId[0] === 'dsh-notpdpton', pageId.join(' | '))
check('the heading shows a v-prefixed version', pageVersion.length === 1 && /^v\d+\.\d+\.\d+$/.test(pageVersion[0]), pageVersion.join(' | '))
// Same LINE as the title, and after it: the version belongs to the name, not to a
// second row of its own.
check(
  'id and version share the title row, after the title',
  titleRowClasses.length === 1 &&
    JSON.stringify(titleRowClasses[0]) === JSON.stringify(['npd-pageTitle', 'npd-pageId', 'npd-pageVersion']),
  JSON.stringify(titleRowClasses),
)
check('the version carries an explanatory tooltip', t('settings.versionHint').includes('版本'), t('settings.versionHint'))

// Every preference switch must sit inside a block, never loose on the page.
const looseSwitches = []
walk(settingsTree, (node) => {
  if (node.type === 'button' && node.props?.role === 'switch' && node.props?.className === 'npd-switch') looseSwitches.push(node)
})
check('every switch is inside a subfeature block', looseSwitches.length === 2, String(looseSwitches.length))

console.log('\n-- richer blocks preserve the shared section shell')
let sharedGroup
settings.Component({ t, renderSlot: (_name, props) => { sharedGroup = props.Group; return null } })
check('the page provides the same Group contract', typeof sharedGroup === 'function')
const customBody = { type: 'div', props: { id: 'regression-custom-body' }, children: ['loading or form content'] }
const customBlock = sharedGroup({ t: (key) => key, title: 'A richer block', body: customBody })
const customNodes = []
walk(customBlock, (node) => customNodes.push(node))
check('a supplied body remains inside the pack section', customNodes.some((node) => node.props?.id === 'regression-custom-body'))
check('a supplied body is not mislabelled as an empty group', !customNodes.some((node) => node.props?.className === 'npd-groupEmpty'))
const footerBlock = sharedGroup({ t: (key) => key, title: 'Loading', footer: customBody })
const footerNodes = []
walk(footerBlock, (node) => footerNodes.push(node))
check('a loading/error footer also suppresses the empty placeholder', !footerNodes.some((node) => node.props?.className === 'npd-groupEmpty'))
const wideBlock = sharedGroup({ t, title: 'Field', fields: [{ key: 'wide', id: 'wide-control', label: 'Wide', wide: true, control: null }] })
const wideNodes = []
walk(wideBlock, (node) => wideNodes.push(node))
check('wide field hints reach the actual row markup', wideNodes.some((node) => node.props?.className === 'npd-field' && node.props['data-wide'] === 'true'))

console.log(failures === 0 ? '\nOK: client half checks pass' : `\nFAIL: ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
