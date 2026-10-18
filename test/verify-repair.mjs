/**
 * Verify the reopen sequence the Client actually experiences for a crash Session.
 *
 * A stored Session is read through the session-history `snapshot` frame, whose
 * `projections` block is produced by `ctx.sessionProjections.snapshot(session)`.
 * Before that read the harness appends synthetic closers for an open tail, so the
 * value a browser receives for a crashed Session is `status: 'interrupted'`.
 *
 * This script reproduces both readings over the same real log and asserts the
 * Client would show the notice in each:
 *   1. the stored prefix, folded as-is      -> 'crash'        (live/attached read)
 *   2. the prefix + interrupted closers     -> 'interrupted'  (cold read)
 *
 * usage: node verify-repair.mjs <sessionDir>
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const { initialState, foldInterruption, interruptionStateSchema } = await import(
  new URL('./fold-probe.mjs', import.meta.url)
)
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

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

/** The harness's own crash-repair closers (`interruptedTurnClosers`). */
function interruptedClosers(events) {
  let openTurn = null
  let openStep = null
  for (const event of events) {
    if (event.type === 'turn/start') {
      openTurn = event.data.turn
      openStep = null
    } else if (event.type === 'turn/end') {
      openTurn = null
      openStep = null
    } else if (event.type === 'step/start') {
      openStep = event.data.step
    } else if (event.type === 'step/end') {
      openStep = null
    }
  }
  const last = events.at(-1)
  if (openTurn === null || last === undefined) return []
  const closers = []
  let seq = last.seq + 1
  if (openStep !== null) closers.push({ type: 'step/end', seq: seq++, time: last.time, data: { turn: openTurn, step: openStep } })
  closers.push({ type: 'turn/end', seq: seq++, time: last.time, data: { turn: openTurn, reason: { kind: 'interrupted' } } })
  return closers
}

function fold(events) {
  let state = initialState()
  for (const event of events) state = foldInterruption(state, event)
  interruptionStateSchema.parse(state)
  return state
}

let failures = 0
for (const dir of process.argv.slice(2)) {
  const name = dir.split(/[\\/]/).filter(Boolean).at(-1)
  const events = readLog(dir)
  const live = fold(events)
  const closers = interruptedClosers(events)
  const cold = fold([...events, ...closers])

  console.log(
    [
      `\n== ${name}`,
      `  stored events=${events.length}, repair closers=${closers.length}`,
      `  attached/live read : status=${live.status} turn=${live.turn} todos=${live.todos.length}`,
      `  cold stored read   : status=${cold.status} turn=${cold.turn} todos=${cold.todos.length}`,
      `  client shows notice: live=${live.status === 'crash' || live.status === 'interrupted'} cold=${cold.status === 'crash' || cold.status === 'interrupted'}`,
    ].join('\n'),
  )

  if (closers.length > 0) {
    // An open tail must surface the notice from BOTH readings.
    const showsLive = live.status === 'crash' || live.status === 'interrupted'
    const showsCold = cold.status === 'crash' || cold.status === 'interrupted'
    if (!showsLive || !showsCold) {
      failures++
      console.log('  !! a crashed log must show the notice from both readings')
    }
    if (cold.todos.length !== live.todos.length) {
      failures++
      console.log('  !! todo carry-over differs between readings')
    }
  } else if (live.status === 'crash' || live.status === 'interrupted') {
    // A balanced log CAN still be an interruption: an `aborted` turn with no
    // truncated stream is a shutdown/workspace-stop kill, which is exactly what
    // the feature resumes. Only a clean `completed` turn must stay silent.
    const lastEnd = [...events].reverse().find((e) => e.type === 'turn/end')
    const kind = lastEnd?.data?.reason?.kind
    const benign = kind === 'completed' || kind === 'forked'
    if (benign) {
      failures++
      console.log(`  !! a cleanly completed log must not report an interruption (got ${live.status} after ${kind})`)
    } else {
      console.log(`  ok   balanced log closed by "${kind}" is still an interruption (${live.status})`)
    }
  }
}

console.log(failures === 0 ? '\nOK: crash and cold-read readings both surface the notice' : `\nFAIL: ${failures}`)
process.exit(failures === 0 ? 0 : 1)
