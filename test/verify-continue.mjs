/**
 * Offline verification of the Continue action and the subfeature switches.
 *
 * Drives the shipped Component through its real handlers (setDraft/submit) and
 * inspects the message text it produces, plus the switch gating.
 *
 * usage: node verify-continue.mjs
 */
import { readFileSync } from 'node:fs'

let captured
globalThis.window = { __ModuleLoader__: { load: (e) => (captured = e) } }
globalThis.localStorage = { store: new Map(), getItem: () => null, setItem: () => {} }
new Function('window', readFileSync(new URL('../recover/client.js', import.meta.url), 'utf8'))(globalThis.window)

const reactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: 'fragment',
  useCallback: (fn) => fn,
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
}

const plugin = captured.factory((id) => {
  if (id === 'react') return reactStub
  throw new Error(`unexpected require: ${id}`)
})

const reg = []
let slot
const ctx = {
  locale: {
    register: (ns, dicts) => {
      reg.push({ kind: 'locale', ns, dicts })
      return () => {}
    },
    bind: () => (key, params) => {
      const dict = reg.find((r) => r.kind === 'locale')?.dicts.zh ?? {}
      let text = dict[key] ?? key
      if (params) text = text.replace(/\{(\w+)\}/g, (m, n) => (n in params ? String(params[n]) : m))
      return text
    },
  },
  effect: (fn) => fn(),
  slots: {
    inject: (name, cb) => {
      slot = name
      cb()
      return () => {}
    },
    register: (options, Component) => {
      reg.push({ kind: 'slot', slot, options, Component })
      return () => {}
    },
  },
}
plugin.apply(ctx)

const t = ctx.locale.bind('notpdpton')
const dock = reg.find((r) => r.kind === 'slot' && r.slot === 'conversation.input.dock')

/** Depth-first walk of the stub element tree, collecting nodes by predicate. */
function walk(node, visit) {
  if (node === null || node === undefined) return
  // An array is a child LIST, not a node: flatten it (grouped settings produce
  // nested arrays through `items.map(...)`).
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit)
    return
  }
  // A function-typed node is a React component element; stub-render it so nested
  // components (SwitchRow) are inspectable too.
  if (typeof node.type === 'function') {
    walk(node.type(node.props ?? {}), visit)
    return
  }
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}

function render(view) {
  const calls = { drafts: [], submits: 0 }
  const props = {
    t,
    inputActions: {
      setDraft: (text) => calls.drafts.push(text),
      submit: () => (calls.submits += 1),
    },
    useProjection: () => view,
    useSession: (selector) => selector({ running: false, pendingSubmissions: [], removed: false }),
  }
  return { tree: dock.Component(props), calls }
}

const todos = [
  { content: '研究 DSH API', status: 'completed' },
  { content: '实现中断检测', status: 'in_progress' },
  { content: '验证插件', status: 'pending' },
  { content: '撰写说明', status: 'pending' },
]
const crashView = {
  status: 'crash',
  turn: 2,
  reason: null,
  abortCause: null,
  errorCode: null,
  errorMessage: null,
  openStep: true,
  hasTurns: true,
  todos,
}

let failures = 0
function check(label, condition, detail) {
  if (condition) console.log(`  ok   ${label}`)
  else {
    failures++
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

// ── Continue action ──────────────────────────────────────────────────────────
console.log('-- continue action')
const rendered = render(crashView)
let continueButton
walk(rendered.tree, (node) => {
  if (node.type === 'button' && node.props?.['data-variant'] === 'primary') continueButton = node
})
check('primary (Continue) button exists', continueButton !== undefined)
check('Continue button is enabled while idle', continueButton?.props?.disabled === false, String(continueButton?.props?.disabled))

continueButton.props.onClick()
check('clicking Continue writes one draft', rendered.calls.drafts.length === 1, String(rendered.calls.drafts.length))
const draft = rendered.calls.drafts[0] ?? ''
console.log('\n--- generated continue message ---')
console.log(draft)
console.log('--- end ---\n')
check('submit was called once (normal composer submission)', rendered.calls.submits === 1, String(rendered.calls.submits))
check('draft states the interruption', draft.includes('上次会话未正常结束'))
check('draft includes the progress line with the turn', draft.includes('第 2 轮'))
check('draft includes the todo list head', draft.includes('上次的任务清单'))
check('draft carries the in-progress item', draft.includes('实现中断检测'))
check('draft marks completed items as 已完成', draft.includes('[已完成] 研究 DSH API'))
check('draft marks pending items as 待处理', draft.includes('[待处理] 验证插件'))
check('draft is not trivially short', draft.length > 80, String(draft.length))

// ── Switch gating ────────────────────────────────────────────────────────────
console.log('-- subfeature switches')
const switchesRendered = render(crashView)
let switchRows = []
walk(switchesRendered.tree, (node) => {
  if (node.type === 'button' && node.props?.role === 'switch') switchRows.push(node)
})
console.log(`  (dock tree has ${switchRows.length} switch controls; switches live on the settings page)`)

// Render the settings page through the same plugin to inspect its switches.
// NOTE: stub-rendered elements capture their `checked` at render time, exactly
// like real React elements, so each toggle needs a fresh render before the next
// click — otherwise the second click would resend the first click's value.
const settingsSlot = reg.find((r) => r.kind === 'slot' && r.slot === 'settings.section')
/**
 * The page's `renderSlot`, as the slot host would hand it in.
 *
 * The blocks live in the page's child slot; a component of this pack fills its own
 * in, and the page only positions them. This resolves them the way the host does
 * (registration order by `order`) so the block's switches are reachable here.
 */
function renderGroupSlot(owner) {
  return reg
    .filter((r) => r.kind === 'slot' && r.slot === 'notpdpton.settings.group')
    .sort((a, b) => (a.options.order ?? 0) - (b.options.order ?? 0))
    .map((block) => block.Component({ ...owner, t: ctx.locale.bind(block.options.locale) }))
}
const renderSlot = (key, owner) => (key === 'notpdpton.settings.group' ? renderGroupSlot(owner) : null)
function renderSettings() {
  const tree = settingsSlot.Component({ t, renderSlot })
  const found = []
  walk(tree, (node) => {
    if (node.type === 'button' && node.props?.role === 'switch') found.push(node)
  })
  return found
}
const switches = renderSettings()
// Window placement is now its OWN component with its own package, so the pack
// root's settings page renders the two RECOVERY preferences only. The window
// switch lives on that other component's page.
check('settings page renders one switch per preference', switches.length === 2, String(switches.length))
const labels = switches.map((s) => s.props['aria-label'])
console.log(`  labels: ${JSON.stringify(labels)}`)
check(
  'switches cover the subfeature preferences',
  labels.join('|') === '恢复进度与任务清单|提示手动停止的会话',
  labels.join('|'),
)
check(
  'no window-placement switch leaks into the recovery component',
  !labels.some((label) => label.includes('窗口') || label.includes('记住窗口')),
  labels.join('|'),
)
check(
  'the removed restore-maximized preference is gone',
  !labels.some((label) => label.includes('最大化')),
  labels.join('|'),
)
check('all switches default to on', switches.every((s) => s.props['aria-checked'] === true))
check('switches are proper aria switches', switches.every((s) => s.props.role === 'switch'))
// The recovery switches come FIRST: this file drives switches[0] as
// progress-restore, so their order is part of the contract it relies on.
check(
  'the recovery group precedes the placement group',
  labels[0] === '恢复进度与任务清单' && labels[1] === '提示手动停止的会话',
  labels.join('|'),
)

// Turning progress-restore off must drop the todo block from the message.
switches[0].props.onClick()
const noRestore = render(crashView)
let btn2
walk(noRestore.tree, (node) => {
  if (node.type === 'button' && node.props?.['data-variant'] === 'primary') btn2 = node
})
btn2.props.onClick()
const draft2 = noRestore.calls.drafts[0] ?? ''
console.log(`\n--- continue message with progress restore OFF ---\n${draft2}\n--- end ---\n`)
check('without progress restore the todo list is absent', !draft2.includes('[已完成]'))
check('without progress restore the instruction still resumes', draft2.includes('上次会话未正常结束'))
// Restore the default so a later run starts clean.
renderSettings()[0].props.onClick()

console.log(failures === 0 ? '\nOK: continue action and switches pass' : `\nFAIL: ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
