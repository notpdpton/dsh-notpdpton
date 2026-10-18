/**
 * Test the discriminator that separates a deliberate in-process Stop from an
 * interruption caused by a page refresh / app restart.
 *
 * Both write `turn/end { kind: 'aborted', reason: { kind: 'user' } }`, so the
 * cause alone cannot tell them apart. A deliberate Stop pressed while the model
 * is streaming also marks the partial assistant message `interrupted: true`; a
 * turn killed between steps (shutdown, reconnect) leaves no such message.
 *
 * usage: node explain-aborts.mjs <sessionDir> [...more]
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

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

for (const arg of process.argv.slice(2)) {
  const dir = resolveDir(arg)
  let events
  try {
    events = readLog(dir)
  } catch (error) {
    console.log(`\n== ${arg}: ${error.message}`)
    continue
  }
  const name = dir.split(/[\\/]/).filter(Boolean).at(-1)
  console.log(`\n== ${name} (${events.length} events)`)

  // Walk the log turn by turn, tracking whether a partial assistant message was
  // marked interrupted before the turn closed.
  let turn = null
  let partialInTurn = false
  let endSeedAfterEnd = 0
  const rows = []
  for (let index = 0; index < events.length; index++) {
    const event = events[index]
    if (event.type === 'turn/start') {
      turn = event.data.turn
      partialInTurn = false
    } else if (event.type === 'assistant/message') {
      if (event.data?.interrupted === true) partialInTurn = true
    } else if (event.type === 'turn/end') {
      const reason = event.data.reason ?? {}
      // A `session/end-seed` shortly AFTER the close is the shutdown signature.
      const later = events.slice(index + 1, index + 12).filter((e) => e.type === 'session/end-seed')
      rows.push({
        turn: event.data.turn,
        kind: reason.kind,
        cause: reason.reason?.kind ?? '',
        partial: partialInTurn,
        endSeedSoon: later.length > 0,
        at: event.time,
      })
      turn = null
    }
  }

  for (const row of rows) {
    const verdict =
      row.kind === 'aborted'
        ? row.partial
          ? 'deliberate Stop (partial assistant message was discarded)'
          : 'NO partial message -> shutdown / reconnect interruption'
        : row.kind
    const stamp = new Date(row.at + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19)
    console.log(
      `  turn ${row.turn} @ ${stamp}: kind=${row.kind}${row.cause ? `/${row.cause}` : ''} partial=${row.partial} endSeedSoon=${row.endSeedSoon}  => ${verdict}`,
    )
  }

  const starts = events.filter((e) => e.type === 'turn/start').length
  const ends = events.filter((e) => e.type === 'turn/end').length
  if (starts > ends) console.log(`  open tail: turn ${starts} never closed (true crash)`)
}
