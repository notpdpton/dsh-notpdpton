/**
 * Simulate every resource the Host resolves for one mounted plugin specifier.
 *
 * The Host resolves three separate things per Loader row and they can fail
 * independently:
 *   - the entry module itself       (`<name>` and `<name>/index.js`)
 *   - the browser half              (`<name>/client`, gated by `dsh.client`)
 *   - display metadata              (`<name>/locale/*.json`, `<name>/icon`, `<name>/package.json`)
 *
 * An `exports` map that covers one and misses another breaks the plugin in a way
 * no single check notices, so this audits all three together.
 *
 * usage: node verify-host-resolution.mjs [specifier]
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

// Every package the profile mounts or links: the pack itself (a bundle, no
// component) and each component package its patch inserts a row for.
const specifiers = process.argv.slice(2)
if (specifiers.length === 0) specifiers.push('dsh-notpdpton', 'dsh-notpdpton-recover', 'dsh-notpdpton-window')
const require = createRequire('file:///C:/Users/notpdpton/.dsh/profiles/desktop/')

let failures = 0
function check(label, condition, detail) {
  if (condition) console.log(`  ok   ${label}`)
  else {
    failures++
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

function resolve(spec) {
  try {
    return require.resolve(spec)
  } catch (error) {
    return { error: error.code }
  }
}

function show(spec) {
  const result = resolve(spec)
  return typeof result === 'string' ? result.replace(/.*dsh-notpdpton[\\/]/, '') : `ERR ${result.error}`
}

for (const specifier of specifiers) {
  console.log(`\n== ${specifier}`)
  const entry = resolve(specifier)
  const entryFile = resolve(`${specifier}/index.js`)
  const client = resolve(`${specifier}/client`)
  const manifest = resolve(`${specifier}/package.json`)
  const icon = resolve(`${specifier}/icon`)
  const enLocale = resolve(`${specifier}/locale/en.json`)
  const zhLocale = resolve(`${specifier}/locale/zh.json`)

  console.log('   entry         ', show(specifier))
  console.log('   entry/index.js', show(`${specifier}/index.js`))
  console.log('   client        ', show(`${specifier}/client`))
  console.log('   manifest      ', show(`${specifier}/package.json`))
  console.log('   icon          ', show(`${specifier}/icon`))
  console.log('   locale en/zh  ', `${show(`${specifier}/locale/en.json`)} / ${show(`${specifier}/locale/zh.json`)}`)

  console.log('\n-- the Loader can import the entry')
  check('entry module resolves', typeof entry === 'string', entry.error)
  // The Host may resolve the row's module through an explicit `/index.js`; an
  // exports map has to allow that alias too.
  check('entry resolves via /index.js as well', typeof entryFile === 'string', entryFile.error)

  // Only a component package declares a browser half. The pack deliberately does
  // not: it is the card, and a dsh.client here would make it a component too.
  const declared =
    typeof manifest === 'string' ? JSON.parse(readFileSync(manifest, 'utf8')).dsh?.client : undefined
  console.log('\n-- the browser half')
  check(
    'dsh.client declaration is readable',
    typeof manifest === 'string',
    manifest.error ?? 'manifest must be resolvable for the declaration to be read',
  )
  if (declared === undefined) {
    check('a component-less package declares no dsh.client', specifier === 'dsh-notpdpton')
    check('and exports no client bundle', typeof client !== 'string', show(`${specifier}/client`))
  } else {
    check('dsh.client.platform is web', declared.platform === 'web', JSON.stringify(declared))
    check('client bundle resolves', typeof client === 'string', client.error)
  }

  console.log('\n-- display metadata can be read')
  check('english locale resolves', typeof enLocale === 'string', enLocale.error)
  check('chinese locale resolves', typeof zhLocale === 'string', zhLocale.error)
  check('icon resolves', typeof icon === 'string', icon.error)
}

console.log(failures === 0 ? '\nOK: every Host-resolved resource is reachable' : `\nFAIL: ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
