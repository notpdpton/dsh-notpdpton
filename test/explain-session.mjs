/**
 * Explain one stored Session's interruption classification, and WHY the Continue
 * button does or does not appear for it.
 *
 * This is the diagnostic for "I expected the button but did not see it": it reads
 * the real log and prints the fold result plus the exact rule that decides the
 * Client's answer.
 *
 * usage: node explain-session.mjs <sessionDirOrId> [...more]
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const { initialState, foldInterruption } = await import(new URL('./fold-probe.mjs', import.meta.url))
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function resolveDir(arg) {
  if (arg.includes('/') || arg.includes('\\')) return arg
  return join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.dsh/sessions', arg)
}

function readLog(dir) {
  const raw = readFileSync(join(dir, 'session.v4.jsonl.zstd'))
  const starts = []
  for (let i = 0; i + 4 <= raw.length; i++) {
    if (raw[i] === MAGIC[0] && raw[i + 1] === MAGIC[1] && raw[i + 2] === MAGIC[2] && raw[i + 3] === MAGIC[3]) starts.push(i)
  }
  const parts = []
  for (let i = 0; i < starts.length; i++) {
    const frame = raw.subarray(starts[i], i + 1 < starts.length ? starts[i + 1] : raw.length)
    try {
      parts.push(zstdDecompressSync(frame).toString('utf8'))
    } catch {}
  }
  return parts.join('').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line))
}

/** The Client's decision, mirrored from client.js's describeInterruption. */
function clientDecision(state) {
  switch (state.status) {
    case 'crash':
    case 'interrupted':
      return { show: true, rule: 'crash / harness repair marker' }
    case 'error':
      return { show: true, rule: 'turn failed' }
    case 'max-tokens':
      return { show: true, rule: 'turn hit its output limit' }
    case 'blocked':
      return { show: true, rule: 'turn blocked' }
    case 'aborted':
      return state.abortCause === 'user'
        ? { show: false, rule: 'aborted by the user — treated as a deliberate stop' }
        : { show: true, rule: `aborted (${state.abortCause})` }
    default:
      return { show: false, rule: 'no interruption recorded' }
  }
}

for (const arg of process.argv.slice(2)) {
  const dir = resolveDir(arg)
  let events
  try {
    events = readLog(dir)
  } catch (error) {
    console.log(`\n== ${arg}\n  cannot read: ${error.message}`)
    continue
  }

  let state = initialState()
  for (const event of events) state = foldInterruption(state, event)

  const starts = events.filter((e) => e.type === 'turn/start').length
  const ends = events.filter((e) => e.type === 'turn/end').length
  const lastEnd = [...events].reverse().find((e) => e.type === 'turn/end')
  const partial = events.filter((e) => e.type === 'assistant/message' && e.data?.interrupted === true)
  const lastEvent = events.at(-1)
  const name = dir.split(/[\\/]/).filter(Boolean).at(-1)
  const decision = clientDecision(state)

  console.log(
    [
      `\n== ${name}`,
      `  events=${events.length}  turn/start=${starts} turn/end=${ends}  openTail=${starts > ends}`,
      `  last turn/end: ${lastEnd === undefined ? 'none' : JSON.stringify(lastEnd.data.reason)}`,
      `  partial assistant messages (interrupted:true): ${partial.length}`,
      `  last event: ${lastEvent?.type} @ ${new Date(lastEvent?.time ?? 0).toISOString()}`,
      `  fold => status=${state.status} turn=${state.turn} reason=${state.reason} abortCause=${state.abortCause} todos=${state.todos.length}`,
      `  CLIENT: ${decision.show ? 'SHOWS the Continue button' : 'HIDES the button'} — ${decision.rule}`,
    ].join('\n'),
  )
}
