/**
 * Simulate the plugin manager's display-metadata reader against this package.
 *
 * Reproduces `readPluginMeta` closely enough to catch the failures that are
 * invisible to a plain JSON check: everything is resolved through Node's package
 * exports, exactly as the manager does, so an `exports` gap that hides
 * `package.json` or a locale file shows up here instead of on the Plugins page.
 *
 * usage: node verify-metadata.mjs <specifier> [...more]
 */
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'

const profileUrl = 'file:///C:/Users/notpdpton/.dsh/profiles/desktop/'
const require = createRequire(profileUrl)

let failures = 0
function check(label, condition, detail) {
  if (condition) console.log(`  ok   ${label}`)
  else {
    failures++
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/** Resolve a plugin resource through the package exports, or undefined. */
function resolveResource(specifier) {
  try {
    return require.resolve(specifier)
  } catch {
    return undefined
  }
}

/** Mirror of the reader: locale dictionaries plus the manifest fallbacks. */
function readMeta(specifier) {
  const bare = specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0]

  const englishPath = resolveResource(`${specifier}/locale/en.json`)
  const dictionaries = new Map()
  if (englishPath !== undefined) {
    for (const entry of readdirSync(dirname(englishPath), { withFileTypes: true })) {
      if (!entry.name.endsWith('.json')) continue
      const file = resolveResource(`${specifier}/locale/${entry.name}`)
      if (file === undefined) continue
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      dictionaries.set(entry.name.slice(0, -5), parsed.meta ?? {})
    }
  }

  // A subpath specifier never reads a package.json; only a package root does.
  const manifestPath = bare === specifier ? resolveResource(`${specifier}/package.json`) : undefined
  const manifest =
    manifestPath === undefined ? undefined : JSON.parse(readFileSync(manifestPath, 'utf8'))

  const en = dictionaries.get('en') ?? {}
  return {
    title: en.title ?? manifest?.name ?? specifier,
    description: en.description ?? manifest?.description ?? '',
    languages: [...dictionaries.keys()],
    manifestRead: manifestPath !== undefined,
    iconResolved: resolveResource(`${specifier}/icon`) !== undefined,
  }
}

for (const specifier of process.argv.slice(2)) {
  console.log(`\n== ${specifier}`)
  const meta = readMeta(specifier)
  console.log(`   title:       ${meta.title}`)
  console.log(`   description: ${meta.description || '(EMPTY)'}`)
  console.log(`   languages:   ${meta.languages.join(', ') || '(none)'}`)
  console.log(`   manifest readable: ${meta.manifestRead}`)
  console.log(`   icon resolvable:   ${meta.iconResolved}`)

  check('title is not the raw specifier', meta.title !== specifier, meta.title)
  check('description is present', meta.description !== '', '(empty)')
  check('both locales are readable', meta.languages.includes('en') && meta.languages.includes('zh'), meta.languages.join(','))
  check('icon resolves through exports', meta.iconResolved)
}

console.log(failures === 0 ? '\nOK: display metadata resolves for every specifier' : `\nFAIL: ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
