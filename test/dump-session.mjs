/**
 * Dump the turn/step/message skeleton of one stored Session log, so a
 * classification can be explained event by event.
 *
 * usage: node dump-session.mjs <sessionDirOrId> [maxEvents]
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

function summarize(data) {
  if (data === undefined || data === null) return ''
  if (typeof data.reason === 'object' && data.reason !== null && 'kind' in data.reason) {
    return `reason=${JSON.stringify(data.reason)}`
  }
  if ('turn' in data && 'step' in data) return `turn=${data.turn} step=${data.step}`
  if ('turn' in data) return `turn=${data.turn}`
  if (data.interrupted === true) return 'interrupted=true'
  if (Array.isArray(data.todos)) return `todos=${data.todos.length}`
  const text = JSON.stringify(data)
  return text.length > 140 ? `${text.slice(0, 140)}…` : text
}

for (const arg of process.argv.slice(2)) {
  const dir = resolveDir(arg)
  const events = readLog(dir)
  const name = dir.split(/[\\/]/).filter(Boolean).at(-1)
  console.log(`\n===== ${name} (${events.length} events)`)
  events.forEach((event, index) => {
    const interesting =
      event.type.startsWith('turn/') ||
      event.type.startsWith('step/') ||
      event.type.startsWith('session/') ||
      event.type === 'user/message' ||
      event.type === 'assistant/message' ||
      event.type === 'todo/write' ||
      event.type === 'tool/call' ||
      event.type === 'tool/result'
    if (!interesting) return
    let line = `  #${String(index).padStart(4)} ${event.type}`
    if (event.type === 'user/message') {
      const text = event.data?.content?.map?.((part) => part.text ?? '').join('') ?? ''
      line += ` "${text.slice(0, 90).replace(/\n/g, ' ')}"`
    } else if (event.type === 'assistant/message') {
      line += ` interrupted=${event.data?.interrupted === true}`
    } else {
      line += ` ${summarize(event.data)}`
    }
    console.log(line)
  })
}
