/**
 * Offline verification of the `interruption` fold against real stored session
 * logs. Read-only: it never writes to the sessions directory.
 *
 * The JSONL backend appends one zstd FRAME per flush, so a whole log is many
 * concatenated frames; Node's zstdDecompressSync decodes only the first. We walk
 * the frame magic to decode them all.
 *
 * usage: node verify-fold.mjs <sessionDir> [...more]
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const { initialState, foldInterruption, interruptionStateSchema } = await import(
  new URL('./fold-probe.mjs', import.meta.url)
)

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Split a buffer into concatenated zstd frames. */
function splitFrames(buf) {
  const starts = []
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) {
      starts.push(i)
    }
  }
  const frames = []
  for (let index = 0; index < starts.length; index++) {
    const from = starts[index]
    const to = index + 1 < starts.length ? starts[index + 1] : buf.length
    frames.push(buf.subarray(from, to))
  }
  return frames
}

/** Decode every frame of one stored log into its JSONL events. */
function readLog(dir) {
  const raw = readFileSync(join(dir, 'session.v4.jsonl.zstd'))
  const text = splitFrames(raw)
    .map((frame) => {
      try {
        return zstdDecompressSync(frame).toString('utf8')
      } catch {
        return ''
      }
    })
    .join('')
  const events = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    events.push(JSON.parse(line))
  }
  return events
}

let failures = 0
let checked = 0
for (const dir of process.argv.slice(2)) {
  let events
  try {
    events = readLog(dir)
  } catch (error) {
    console.log(`SKIP ${dir}: ${error.message}`)
    continue
  }
  if (events.length === 0) continue
  checked++

  let state = initialState()
  for (const event of events) state = foldInterruption(state, event)
  interruptionStateSchema.parse(state)

  const types = events.map((e) => e.type)
  const turnStarts = types.filter((t) => t === 'turn/start').length
  const turnEnds = types.filter((t) => t === 'turn/end').length
  const todoWrites = events.filter((e) => e.type === 'todo/write').length
  const lastEnd = [...events].reverse().find((e) => e.type === 'turn/end')

  const name = dir.split(/[\\/]/).filter(Boolean).at(-1)
  console.log(
    [
      `\n== ${name}`,
      `  events=${events.length} turn/start=${turnStarts} turn/end=${turnEnds} todo/write=${todoWrites}`,
      `  openTurn=${turnStarts > turnEnds}  lastTurnEnd=${lastEnd === undefined ? 'none' : JSON.stringify(lastEnd.data.reason)}`,
      `  => status=${state.status} turn=${state.turn} reason=${state.reason} abortCause=${state.abortCause} openStep=${state.openStep} todos=${state.todos.length}`,
    ].join('\n'),
  )

  // Cross-check: the fold's open-turn verdict must equal the log imbalance.
  const expectedOpen = turnStarts > turnEnds
  const actualOpen = state.status === 'crash'
  if (expectedOpen !== actualOpen) {
    failures++
    console.log(`  !! MISMATCH: expected openTurn=${expectedOpen}, fold says ${actualOpen}`)
  }
}

console.log(
  failures === 0
    ? `\nOK: fold matches log imbalance in all ${checked} non-empty samples`
    : `\nFAIL: ${failures} mismatches`,
)
process.exit(failures === 0 ? 0 : 1)
