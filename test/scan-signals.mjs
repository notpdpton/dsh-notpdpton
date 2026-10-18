/**
 * Scan every stored Session for the signals used to distinguish a deliberate Stop
 * from a shutdown abort, so the discriminator is validated against real data
 * rather than assumed.
 *
 * usage: node scan-signals.mjs
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const root = join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.dsh/sessions')

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

let partialTotal = 0
const abortedSamples = []

for (const workspace of readdirSync(root)) {
  const workspaceDir = join(root, workspace)
  let entries
  try {
    entries = readdirSync(workspaceDir)
  } catch {
    continue
  }
  for (const entry of entries) {
    const dir = join(workspaceDir, entry)
    let events
    try {
      events = readLog(dir)
    } catch {
      continue
    }
    const partials = events.filter((e) => e.type === 'assistant/message' && e.data?.interrupted === true)
    partialTotal += partials.length

    let partial = false
    for (const event of events) {
      if (event.type === 'turn/start') partial = false
      else if (event.type === 'assistant/message' && event.data?.interrupted === true) partial = true
      else if (event.type === 'turn/end') {
        const reason = event.data.reason ?? {}
        if (reason.kind === 'aborted') {
          abortedSamples.push({
            session: `${workspace}/${entry}`,
            turn: event.data.turn,
            cause: reason.reason?.kind ?? '',
            partial,
            at: event.time,
          })
        }
      }
    }
  }
}

console.log(`assistant messages flagged interrupted:true across ALL sessions = ${partialTotal}`)
console.log(`aborted turns = ${abortedSamples.length}`)
const withPartial = abortedSamples.filter((s) => s.partial)
console.log(`  of those, carrying a partial interrupted message = ${withPartial.length}`)
for (const sample of abortedSamples) {
  const stamp = new Date(sample.at + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19)
  console.log(`  ${stamp}  ${sample.session} turn ${sample.turn}  cause=${sample.cause}  partial=${sample.partial}`)
}
if (withPartial.length === 0) {
  console.log('\nNOTE: no deliberate-Stop sample exists in this corpus, so the partialMessage')
  console.log('discriminator has no positive case to confirm against — only the absence')
  console.log('pattern (shutdown aborts) is observed.')
}
